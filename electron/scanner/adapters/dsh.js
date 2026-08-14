/**
 * DeepSeek Harness（dsh）适配器
 *
 * 数据（DSH_HOME，默认 ~/.dsh）：
 * - sessions/<project>/session-<id>/session.jsonl.zstd  默认压缩日志
 * - sessions/<project>/session-<id>/session.jsonl       compression: none
 * - storages/session_projcache.json                     投影缓存（日志读失败时兜底）
 * - settings.yaml                                       默认模型
 *
 * 日志：首帧是 { type: 'session', id, cwd, createdAt, parentSession?, origin?,
 * agentPreset?, delegationDepth }，之后每行一条事件或 packed chunk 行。
 *
 * 用量：assistant/chunk(type=usage) 先采样；同 turn/step 的 assistant/message.usage
 * 覆盖。字段已分列（input=未命中，cache 另计）；reasoning 是 output 子集。
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { dshHomes } from "../paths.js";
import { normalizeAgentName } from "../agentLabel.js";
import {
  makeSession,
  normalizeModelName,
  normalizeModelVariant,
  splitInclusiveUsage,
  toIso,
} from "../types.js";

export const id = "dsh";
export const displayName = "DeepSeek Harness";

const ZSTD_MAGIC = 4247762216;

/** @type {Map<string, string>} sessionId → log path（最近一次 scan 填） */
const fileBySession = new Map();

/**
 * @returns {boolean}
 */
export function detect() {
  for (const home of dshHomes()) {
    if (!home || !fs.existsSync(home)) continue;
    if (fs.existsSync(path.join(home, "sessions"))) return true;
    if (fs.existsSync(path.join(home, "storages", "session_projcache.json"))) {
      return true;
    }
    if (fs.existsSync(path.join(home, "settings.yaml"))) return true;
  }
  return false;
}

/**
 * Locate complete Zstandard frames (dsh session artifact = concatenated frames).
 * @param {Buffer} buffer
 * @param {number} [maxFrames]
 * @returns {{ frames: { start: number, end: number }[], tornStart?: number }}
 */
export function scanZstdFrames(buffer, maxFrames = Number.POSITIVE_INFINITY) {
  const frames = [];
  let offset = 0;
  while (offset < buffer.length) {
    const start = offset;
    if (buffer.length - offset < 4) return { frames, tornStart: start };
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) {
      throw new Error(
        `corrupt Zstandard session log: invalid frame magic at byte ${offset}`
      );
    }
    offset += 4;
    if (offset === buffer.length) return { frames, tornStart: start };
    const descriptor = buffer.readUInt8(offset);
    offset += 1;
    if ((descriptor & 24) !== 0) {
      throw new Error(
        `corrupt Zstandard session log: reserved frame-header bit at byte ${offset - 1}`
      );
    }
    const contentSizeFlag = descriptor >>> 6;
    const singleSegment = (descriptor & 32) !== 0;
    const checksum = (descriptor & 4) !== 0;
    const dictionaryFlag = descriptor & 3;
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
    const contentSizeBytes =
      contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag;
    const remainingHeaderBytes =
      (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
    if (buffer.length - offset < remainingHeaderBytes) {
      return { frames, tornStart: start };
    }
    offset += remainingHeaderBytes;
    for (;;) {
      if (buffer.length - offset < 3) return { frames, tornStart: start };
      const blockHeader = buffer.readUIntLE(offset, 3);
      offset += 3;
      const lastBlock = (blockHeader & 1) !== 0;
      const blockType = (blockHeader >>> 1) & 3;
      const blockSize = blockHeader >>> 3;
      if (blockType === 3) {
        throw new Error(
          `corrupt Zstandard session log: reserved block type at byte ${offset - 3}`
        );
      }
      const payloadBytes = blockType === 1 ? 1 : blockSize;
      if (buffer.length - offset < payloadBytes) {
        return { frames, tornStart: start };
      }
      offset += payloadBytes;
      if (lastBlock) break;
    }
    if (checksum) {
      if (buffer.length - offset < 4) return { frames, tornStart: start };
      offset += 4;
    }
    frames.push({ start, end: offset });
    if (frames.length === maxFrames) return { frames };
  }
  return { frames };
}

/**
 * @returns {boolean}
 */
function hasZstd() {
  return typeof zlib.zstdDecompressSync === "function";
}

/**
 * @param {Buffer} buf
 * @param {{ headerOnly?: boolean }} [opts]
 * @returns {string}
 */
function decodeZstdLog(buf, opts = {}) {
  if (!hasZstd()) {
    throw new Error("Node zlib.zstdDecompressSync is not available");
  }
  const { frames, tornStart } = scanZstdFrames(
    buf,
    opts.headerOnly ? 1 : Number.POSITIVE_INFINITY
  );
  if (!frames.length) {
    if (tornStart != null) return "";
    throw new Error("no complete Zstandard frames");
  }
  const parts = [];
  for (const f of frames) {
    try {
      parts.push(zlib.zstdDecompressSync(buf.subarray(f.start, f.end)).toString("utf8"));
    } catch (err) {
      if (opts.headerOnly) throw err;
      console.error("[dsh] skip zstd frame", f.start, err);
    }
  }
  return parts.join("");
}

/**
 * @param {string} root
 * @returns {string[]}
 */
function walkSessionLogs(root) {
  /** @type {string[]} */
  const files = [];
  if (!root || !fs.existsSync(root)) return files;
  const walk = (d, depth) => {
    if (depth > 8) return;
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (ent.name === "node_modules" || ent.name === ".git") continue;
      const full = path.join(d, ent.name);
      if (ent.isDirectory()) {
        walk(full, depth + 1);
        continue;
      }
      if (!ent.isFile()) continue;
      const low = ent.name.toLowerCase();
      if (low === "session.jsonl.zstd" || low === "session.jsonl") files.push(full);
    }
  };
  walk(root, 0);
  return files;
}

/**
 * @param {string} file
 * @returns {string}
 */
function readLogText(file) {
  if (file.toLowerCase().endsWith(".zstd")) {
    return decodeZstdLog(fs.readFileSync(file));
  }
  return fs.readFileSync(file, "utf8");
}

/**
 * @param {unknown} content
 * @param {{ includeReasoning?: boolean }} [opts]
 * @returns {string}
 */
export function contentText(content, opts = {}) {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => {
        if (b == null) return "";
        if (typeof b === "string") return b;
        if (typeof b !== "object") return "";
        if (!opts.includeReasoning && b.type === "reasoning") return "";
        if (typeof b.text === "string") return b.text;
        if (typeof b.content === "string") return b.content;
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  if (typeof content === "object") {
    const o = /** @type {Record<string, unknown>} */ (content);
    if (typeof o.text === "string") return o.text;
    if (typeof o.content === "string") return String(o.content);
  }
  return "";
}

/**
 * @param {unknown} raw
 */
function usageParts(raw) {
  if (!raw || typeof raw !== "object") return null;
  const o = /** @type {Record<string, unknown>} */ (raw);
  const split = splitInclusiveUsage({
    input: Number(o.inputTokens) || 0,
    output: Number(o.outputTokens) || 0,
    reasoning: Number(o.reasoningTokens) || 0,
    cacheRead: Number(o.cacheReadTokens) || 0,
    cacheWrite: Number(o.cacheWriteTokens) || 0,
  });
  if (
    split.input +
      split.output +
      split.reasoning +
      split.cacheRead +
      split.cacheWrite <=
    0
  ) {
    return null;
  }
  return split;
}

/**
 * @param {string} file
 * @returns {{
 *   sessionId: string,
 *   cwd?: string,
 *   startedAt?: string,
 *   lastUsedAt?: string,
 *   title?: string,
 *   model?: string,
 *   modelVariant?: string,
 *   parentSessionId?: string,
 *   isSubagent: boolean,
 *   agentName?: string,
 *   sessionKind?: string,
 *   userCount: number,
 *   firstUser?: string,
 *   requests: Array<{
 *     turn: number,
 *     step: number,
 *     ts?: string,
 *     model?: string,
 *     modelVariant?: string,
 *     inputTokens: number,
 *     outputTokens: number,
 *     cacheReadTokens: number,
 *     cacheWriteTokens: number,
 *     reasoningTokens: number,
 *   }>,
 *   messages: Array<{
 *     role: string,
 *     ts?: string,
 *     model?: string,
 *     text?: string,
 *     toolName?: string,
 *     toolId?: string,
 *     toolInput?: string,
 *     toolOutput?: string,
 *   }>,
 * } | null}
 */
export function parseSessionLog(file) {
  let text;
  try {
    text = readLogText(file);
  } catch (err) {
    console.error("[dsh] read log failed", file, err);
    return null;
  }
  if (!text) return null;

  /** @type {any} */
  let header = null;
  /** @type {Map<string, any>} */
  const byStep = new Map();
  let title;
  let model;
  let modelVariant;
  let userCount = 0;
  let firstUser;
  let lastTs;
  /** @type {Array<any>} */
  const messages = [];
  /** @type {Map<string, { name?: string, args?: string, ts?: string }>} */
  const pendingTools = new Map();

  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (!o || typeof o !== "object") continue;
    const type = o.type;
    if (type === "session") {
      header = o;
      continue;
    }

    const iso = toIso(o.time);
    if (iso && (!lastTs || iso > lastTs)) lastTs = iso;

    if (type === "request/header") {
      const cfg = o.data?.header?.config || o.data?.config;
      if (cfg?.model) {
        model = normalizeModelName(cfg.model) || model;
        modelVariant = normalizeModelVariant(cfg.reasoningEffort) || modelVariant;
      }
      continue;
    }

    if (type === "session/title") {
      const t = o.data?.title;
      if (typeof t === "string" && t.trim()) title = t.trim();
      continue;
    }

    if (type === "user/message") {
      userCount += 1;
      const textBody = contentText(o.data?.content ?? o.data?.message?.content);
      if (textBody && !firstUser) firstUser = textBody;
      messages.push({
        role: "user",
        ts: iso,
        text: textBody,
      });
      continue;
    }

    if (type === "assistant/message") {
      const textBody = contentText(o.data?.message?.content);
      if (textBody) {
        messages.push({
          role: "assistant",
          ts: iso,
          model: model || undefined,
          text: textBody,
        });
      }
    }

    if (type === "tool/call") {
      const callId = o.data?.callId != null ? String(o.data.callId) : "";
      const rec = {
        name: o.data?.name ? String(o.data.name) : undefined,
        args: typeof o.data?.arguments === "string" ? o.data.arguments : undefined,
        ts: iso,
      };
      if (callId) pendingTools.set(callId, rec);
      messages.push({
        role: "tool",
        ts: iso,
        toolName: rec.name,
        toolId: callId || undefined,
        toolInput: rec.args,
      });
      continue;
    }

    if (type === "tool/result") {
      const callId = o.data?.message?.callId ?? o.data?.callId;
      const key = callId != null ? String(callId) : "";
      const pending = key ? pendingTools.get(key) : undefined;
      const outText = contentText(
        o.data?.message?.content ?? o.data?.message?.output ?? o.data?.content
      );
      if (pending) pendingTools.delete(key);
      // 结果并到最近同 callId 的 tool 行；没有就单独加
      let attached = false;
      if (key) {
        for (let i = messages.length - 1; i >= 0; i--) {
          const m = messages[i];
          if (m.role === "tool" && m.toolId === key && m.toolOutput == null) {
            m.toolOutput = outText;
            attached = true;
            break;
          }
        }
      }
      if (!attached && (outText || pending)) {
        messages.push({
          role: "tool",
          ts: iso,
          toolName: pending?.name,
          toolId: key || undefined,
          toolInput: pending?.args,
          toolOutput: outText,
        });
      }
      continue;
    }

    /** @type {any} */
    let usage;
    let turn;
    let step;
    let usageTs = iso;
    if (type === "assistant/chunk" && o.data?.chunk?.type === "usage") {
      usage = o.data.chunk.usage;
      turn = o.data.turn;
      step = o.data.step;
    } else if (type === "assistant/message" && o.data?.usage) {
      usage = o.data.usage;
      turn = o.data.turn;
      step = o.data.step;
    }
    if (!usage) continue;
    const parts = usageParts(usage);
    if (!parts) continue;
    const key = `${turn}|${step}`;
    byStep.set(key, {
      turn: Number(turn) || 0,
      step: Number(step) || 0,
      ts: usageTs,
      model: model || undefined,
      modelVariant: modelVariant || undefined,
      inputTokens: parts.input,
      outputTokens: parts.output,
      cacheReadTokens: parts.cacheRead,
      cacheWriteTokens: parts.cacheWrite,
      reasoningTokens: parts.reasoning,
    });
  }

  const sessionId =
    (header?.id && String(header.id)) ||
    path.basename(path.dirname(file)) ||
    "";
  if (!sessionId) return null;

  const parentSessionId = header?.parentSession
    ? String(header.parentSession)
    : undefined;
  const origin = header?.origin === "subagent" ? "subagent" : undefined;
  const depth = Number(header?.delegationDepth) || 0;
  const isSubagent = origin === "subagent" || depth > 0 || Boolean(parentSessionId);
  const preset = header?.agentPreset ? String(header.agentPreset) : undefined;
  const agentName =
    normalizeAgentName(preset) &&
    !/^(standard|default)$/i.test(String(preset || ""))
      ? normalizeAgentName(preset)
      : undefined;

  const requests = [...byStep.values()].sort((a, b) => {
    if (a.turn !== b.turn) return a.turn - b.turn;
    return a.step - b.step;
  });

  if (!title && firstUser) {
    const one = firstUser.replace(/\s+/g, " ").trim();
    title = one.length > 80 ? `${one.slice(0, 80)}…` : one;
  }

  return {
    sessionId,
    cwd: header?.cwd ? String(header.cwd) : undefined,
    startedAt: toIso(header?.createdAt),
    lastUsedAt: lastTs || toIso(header?.createdAt),
    title,
    model,
    modelVariant,
    parentSessionId,
    isSubagent,
    agentName,
    sessionKind: origin || undefined,
    userCount,
    firstUser,
    requests,
    messages,
  };
}

/**
 * @param {string} home
 */
function readDefaultModel(home) {
  const p = path.join(home, "settings.yaml");
  if (!fs.existsSync(p)) return { model: undefined, variant: undefined };
  let raw;
  try {
    raw = fs.readFileSync(p, "utf8");
  } catch {
    return { model: undefined, variant: undefined };
  }
  const block = raw.match(
    /agent-default-model:\s*\n((?:[ \t]+.+\n?)*)/
  );
  const src = block ? block[1] : raw;
  const m = src.match(/^\s*model:\s*([^\s#]+)/m);
  const v = src.match(/^\s*reasoningEffort:\s*([^\s#]+)/m);
  return {
    model: m ? normalizeModelName(m[1]) : undefined,
    variant: v ? normalizeModelVariant(v[1]) : undefined,
  };
}

/**
 * @param {string} home
 * @returns {Map<string, any>}
 */
function loadProjCache(home) {
  /** @type {Map<string, any>} */
  const map = new Map();
  const p = path.join(home, "storages", "session_projcache.json");
  if (!fs.existsSync(p)) return map;
  try {
    const o = JSON.parse(fs.readFileSync(p, "utf8"));
    const rows = o?.tables?.sessions;
    if (!rows || typeof rows !== "object") return map;
    for (const [sid, rec] of Object.entries(rows)) {
      if (sid) map.set(String(sid), rec);
    }
  } catch (err) {
    console.error("[dsh] projcache failed", err);
  }
  return map;
}

/**
 * @param {any} rec
 */
function cacheUsage(rec) {
  const totals = rec?.rows?.tokenUsage?.val?.totals;
  if (!totals || typeof totals !== "object") return null;
  const split = splitInclusiveUsage({
    input: Number(totals.uncachedInputTokens) || 0,
    output: Number(totals.outputTokens) || 0,
    reasoning: 0,
    cacheRead: Number(totals.cacheReadTokens) || 0,
    cacheWrite: Number(totals.cacheWriteTokens) || 0,
  });
  if (
    split.input + split.output + split.cacheRead + split.cacheWrite <=
    0
  ) {
    return null;
  }
  return split;
}

/**
 * @param {string} [sessionId]
 * @returns {string | null}
 */
export function findSessionFile(sessionId) {
  if (sessionId && fileBySession.has(sessionId)) {
    const hit = fileBySession.get(sessionId);
    if (hit && fs.existsSync(hit)) return hit;
  }
  const want = sessionId ? String(sessionId) : "";
  for (const home of dshHomes()) {
    const root = path.join(home, "sessions");
    for (const file of walkSessionLogs(root)) {
      const dirId = path.basename(path.dirname(file));
      if (!want || dirId === want) {
        if (want) fileBySession.set(want, file);
        if (want) return file;
      }
    }
  }
  return null;
}

/**
 * @param {{ hourly?: { add: Function } }} [ctx]
 */
export function scan(ctx = {}) {
  const hourly = ctx.hourly;
  const scannedAt = new Date().toISOString();
  /** @type {import('../types.js').SessionRecord[]} */
  const out = [];
  fileBySession.clear();

  for (const home of dshHomes()) {
    if (!home || !fs.existsSync(home)) continue;
    const defaults = readDefaultModel(home);
    const cache = loadProjCache(home);
    const seen = new Set();

    for (const file of walkSessionLogs(path.join(home, "sessions"))) {
      const parsed = parseSessionLog(file);
      if (!parsed) continue;
      fileBySession.set(parsed.sessionId, file);
      seen.add(parsed.sessionId);
      const cached = cache.get(parsed.sessionId);

      let requests = parsed.requests;
      let usedCache = false;
      let model = parsed.model;
      let modelVariant = parsed.modelVariant;

      if (!requests.length) {
        const fallback = cacheUsage(cached);
        if (fallback) {
          usedCache = true;
          model = model || defaults.model;
          modelVariant = modelVariant || defaults.variant;
          requests = [
            {
              turn: 0,
              step: 0,
              ts:
                toIso(cached?.rows?.sessionListMetadata?.val?.lastPromptAt) ||
                parsed.lastUsedAt,
              model,
              modelVariant,
              inputTokens: fallback.input,
              outputTokens: fallback.output,
              cacheReadTokens: fallback.cacheRead,
              cacheWriteTokens: fallback.cacheWrite,
              reasoningTokens: 0,
            },
          ];
        }
      }

      let input = 0;
      let output = 0;
      let cacheRead = 0;
      let cacheWrite = 0;
      let reasoning = 0;
      const turns = new Set();
      for (const r of requests) {
        input += r.inputTokens;
        output += r.outputTokens;
        cacheRead += r.cacheReadTokens;
        cacheWrite += r.cacheWriteTokens;
        reasoning += r.reasoningTokens;
        if (r.turn) turns.add(r.turn);
        if (hourly?.add && (r.ts || parsed.lastUsedAt)) {
          hourly.add(id, r.ts || parsed.lastUsedAt, {
            inputTokens: r.inputTokens,
            outputTokens: r.outputTokens,
            cacheReadTokens: r.cacheReadTokens,
            cacheWriteTokens: r.cacheWriteTokens,
            reasoningTokens: r.reasoningTokens,
            model: r.model || model,
            sessionId: parsed.sessionId,
            requestCount: 1,
            singleRequest: !usedCache,
          });
        }
      }

      const statsTurns = Number(cached?.rows?.sessionStats?.val?.turns) || 0;
      const title =
        parsed.title ||
        (typeof cached?.rows?.title?.val === "string"
          ? cached.rows.title.val
          : undefined);

      /** @type {import('../types.js').Quality} */
      let quality = "full";
      if (input + output + cacheRead + cacheWrite + reasoning <= 0) {
        quality = parsed.userCount > 0 ? "partial" : "no_model";
      } else if (!model) {
        quality = "no_model";
      }

      out.push(
        makeSession({
          client: id,
          sessionId: parsed.sessionId,
          title,
          cwd: parsed.cwd || cached?.identity?.cwd,
          model,
          modelVariant,
          startedAt:
            parsed.startedAt || toIso(cached?.identity?.createdAt),
          lastUsedAt:
            parsed.lastUsedAt ||
            toIso(cached?.rows?.sessionListMetadata?.val?.lastPromptAt),
          messageCount: parsed.userCount || undefined,
          inputTokens: input,
          outputTokens: output,
          cacheReadTokens: cacheRead,
          cacheWriteTokens: cacheWrite,
          reasoningTokens: reasoning,
          quality,
          scannedAt,
          parentSessionId: parsed.parentSessionId,
          isSubagent: parsed.isSubagent || undefined,
          agentName: parsed.agentName,
          sessionKind: parsed.sessionKind,
          turnCount: turns.size || statsTurns || undefined,
          requestCount: usedCache ? undefined : requests.length || undefined,
        })
      );
    }

    // 日志读不到、但投影缓存里还有的会话
    for (const [sid, rec] of cache) {
      if (seen.has(sid)) continue;
      const fallback = cacheUsage(rec);
      if (!fallback) continue;
      const lastTs = toIso(rec?.rows?.sessionListMetadata?.val?.lastPromptAt);
      if (hourly?.add && lastTs) {
        hourly.add(id, lastTs, {
          inputTokens: fallback.input,
          outputTokens: fallback.output,
          cacheReadTokens: fallback.cacheRead,
          cacheWriteTokens: fallback.cacheWrite,
          model: defaults.model,
          sessionId: sid,
          singleRequest: false,
        });
      }
      const title =
        typeof rec?.rows?.title?.val === "string"
          ? rec.rows.title.val
          : undefined;
      out.push(
        makeSession({
          client: id,
          sessionId: sid,
          title,
          cwd: rec?.identity?.cwd,
          model: defaults.model,
          modelVariant: defaults.variant,
          startedAt: toIso(rec?.identity?.createdAt),
          lastUsedAt: lastTs,
          inputTokens: fallback.input,
          outputTokens: fallback.output,
          cacheReadTokens: fallback.cacheRead,
          cacheWriteTokens: fallback.cacheWrite,
          quality: defaults.model ? "partial" : "no_model",
          scannedAt,
          turnCount: Number(rec?.rows?.sessionStats?.val?.turns) || undefined,
        })
      );
    }
  }

  return out;
}

/**
 * @param {string} sessionId
 */
export function getDetail(sessionId) {
  const file = findSessionFile(sessionId);
  if (!file) return null;
  const parsed = parseSessionLog(file);
  if (!parsed) return null;
  const turns = parsed.requests.map((t, i) => ({
    index: i + 1,
    ts: t.ts,
    model: t.model || parsed.model || undefined,
    modelVariant: t.modelVariant || parsed.modelVariant,
    agentName: parsed.agentName,
    inputTokens: t.inputTokens,
    outputTokens: t.outputTokens,
    cacheReadTokens: t.cacheReadTokens,
    cacheWriteTokens: t.cacheWriteTokens,
    reasoningTokens: t.reasoningTokens,
    loopIndex: t.turn || undefined,
  }));
  /** @type {Map<string, any>} */
  const byModel = new Map();
  /** @type {Map<string, any>} */
  const byAgent = new Map();
  for (const t of turns) {
    const model = t.model || "(unknown)";
    const cur = byModel.get(model) || {
      model,
      turns: 0,
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      reasoning: 0,
    };
    cur.turns += 1;
    cur.input += t.inputTokens;
    cur.output += t.outputTokens;
    cur.cacheRead += t.cacheReadTokens;
    cur.cacheWrite += t.cacheWriteTokens;
    cur.reasoning += t.reasoningTokens;
    byModel.set(model, cur);

    const agentKey = t.agentName || "(unknown)";
    const ag = byAgent.get(agentKey) || {
      agent: agentKey,
      turns: 0,
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      reasoning: 0,
    };
    ag.turns += 1;
    ag.input += t.inputTokens;
    ag.output += t.outputTokens;
    ag.cacheRead += t.cacheReadTokens;
    ag.cacheWrite += t.cacheWriteTokens;
    ag.reasoning += t.reasoningTokens;
    byAgent.set(agentKey, ag);
  }
  return {
    client: id,
    sessionId: parsed.sessionId,
    title: parsed.title,
    turns,
    models: [...byModel.values()],
    agents: [...byAgent.values()],
  };
}

/**
 * @param {string} sessionId
 * @returns {{ id: string, agentName?: string }[]}
 */
export function listChildren(sessionId) {
  if (!sessionId) return [];
  const want = String(sessionId);
  /** @type {Map<string, { id: string, agentName?: string }>} */
  const map = new Map();
  for (const home of dshHomes()) {
    for (const file of walkSessionLogs(path.join(home, "sessions"))) {
      let parsed;
      try {
        parsed = parseSessionLog(file);
      } catch {
        parsed = null;
      }
      if (!parsed?.parentSessionId) continue;
      if (parsed.parentSessionId === want && parsed.sessionId !== want) {
        map.set(parsed.sessionId, {
          id: parsed.sessionId,
          agentName: parsed.agentName,
        });
      }
    }
  }
  return [...map.values()];
}

/**
 * 对话预览（组装后的 user/assistant/tool，不展开 packed delta）。
 * @param {string} sessionId
 */
export function getTranscript(sessionId) {
  const file = findSessionFile(sessionId);
  if (!file) return null;
  const parsed = parseSessionLog(file);
  if (!parsed) return null;
  return parsed;
}
