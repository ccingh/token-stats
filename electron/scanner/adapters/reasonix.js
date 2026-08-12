/**
 * Reasonix 适配器
 *
 * 数据位置（~/.reasonix/）：
 * - sessions/<name>.meta.json  会话汇总（workspace / summary / token 累计 / cost）
 * - sessions/<name>.jsonl      对话消息（无 usage 字段，仅标题/消息数）
 * - usage.jsonl                每 turn 一行（有则优先用于 token + 小时桶）
 * - config.json                默认 model 等
 *
 * usage.jsonl 记录字段（Reasonix appendUsage）：
 *   ts, session?, model, promptTokens, completionTokens,
 *   cacheHitTokens, cacheMissTokens, costUsd, claudeEquivUsd,
 *   kind?: "subagent", subagent?: string
 *
 * meta 汇总字段：
 *   workspace, summary, totalCostUsd, cacheHitTokens, cacheMissTokens,
 *   totalCompletionTokens, lastPromptTokens
 */
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { agentPaths, homeDir } from "../paths.js";
import { makeSession, toIso } from "../types.js";

export const id = "reasonix";
export const displayName = "Reasonix";

function reasonixHome() {
  return path.join(homeDir(), ".reasonix");
}

function sessionsDir() {
  return agentPaths().reasonixSessions;
}

function usageLogPath() {
  return path.join(reasonixHome(), "usage.jsonl");
}

export function detect() {
  const home = reasonixHome();
  if (!fs.existsSync(home)) return false;
  // 有 sessions 目录或 usage 日志即视为已安装
  return (
    fs.existsSync(sessionsDir()) ||
    fs.existsSync(usageLogPath()) ||
    fs.existsSync(path.join(home, "config.json"))
  );
}

/**
 * @returns {string | undefined}
 */
function readDefaultModel() {
  try {
    const p = path.join(reasonixHome(), "config.json");
    if (!fs.existsSync(p)) return undefined;
    const cfg = JSON.parse(fs.readFileSync(p, "utf8"));
    return cfg?.model ? String(cfg.model) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * desktop-202605290725-2 → ISO（本地时区）
 * @param {string} sessionId
 * @returns {string | undefined}
 */
function startedFromSessionId(sessionId) {
  const m = String(sessionId).match(/(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})/);
  if (!m) return undefined;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const h = Number(m[4]);
  const mi = Number(m[5]);
  const dt = new Date(y, mo - 1, d, h, mi, 0, 0);
  if (Number.isNaN(dt.getTime())) return undefined;
  return dt.toISOString();
}

/**
 * @param {string} file
 * @returns {object | null}
 */
function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/**
 * @param {string} file
 * @returns {{ title?: string, messageCount: number, lastUser?: string }}
 */
function peekChatJsonl(file) {
  let title;
  let messageCount = 0;
  let lastUser;
  if (!fs.existsSync(file)) return { messageCount: 0 };
  try {
    const raw = fs.readFileSync(file, "utf8");
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim()) continue;
      let o;
      try {
        o = JSON.parse(line);
      } catch {
        continue;
      }
      if (!o || typeof o !== "object") continue;
      if (o.role === "user" || o.role === "assistant" || o.role === "tool") {
        messageCount += 1;
      }
      if (o.role === "user" && typeof o.content === "string" && o.content.trim()) {
        lastUser = o.content.trim();
        if (!title) {
          // 首条用户消息作标题
          title = lastUser.length > 80 ? `${lastUser.slice(0, 80)}…` : lastUser;
        }
      }
    }
  } catch {
    /* ignore */
  }
  return { title, messageCount, lastUser };
}

/**
 * 加载 usage.jsonl，按 session 聚合，并向 hourly 写入 turn 桶。
 * @param {{ add?: Function }} [hourly]
 * @returns {Promise<Map<string, {
 *   input: number, output: number, cacheRead: number, costUsd: number,
 *   turns: number, model?: string, lastTs?: string, firstTs?: string,
 *   isSubagent: boolean, agentName?: string
 * }>>}
 */
async function loadUsageBySession(hourly) {
  /** @type {Map<string, any>} */
  const map = new Map();
  const logPath = usageLogPath();
  if (!fs.existsSync(logPath)) return map;

  const stream = fs.createReadStream(logPath, { encoding: "utf8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  for await (const line of rl) {
    if (!line.trim()) continue;
    let r;
    try {
      r = JSON.parse(line);
    } catch {
      continue;
    }
    if (!r || typeof r !== "object") continue;
    // 与 Reasonix isValidRecord 对齐
    if (
      typeof r.ts !== "number" ||
      typeof r.model !== "string" ||
      typeof r.promptTokens !== "number" ||
      typeof r.completionTokens !== "number" ||
      typeof r.cacheHitTokens !== "number" ||
      typeof r.cacheMissTokens !== "number"
    ) {
      continue;
    }

    const sessionKey =
      r.session && String(r.session).trim()
        ? String(r.session)
        : r.kind === "subagent" && r.subagent
          ? `__sub__${r.subagent}`
          : "__anonymous__";

    const isSubagent = r.kind === "subagent" || Boolean(r.subagent);
    // miss = 未命中缓存的 prompt；hit = 缓存读
    const input = Math.max(0, Number(r.cacheMissTokens) || 0);
    const cacheRead = Math.max(0, Number(r.cacheHitTokens) || 0);
    const output = Math.max(0, Number(r.completionTokens) || 0);
    const costUsd = typeof r.costUsd === "number" ? r.costUsd : 0;
    const iso = toIso(r.ts) || new Date(r.ts).toISOString();

    const cur = map.get(sessionKey) || {
      input: 0,
      output: 0,
      cacheRead: 0,
      costUsd: 0,
      turns: 0,
      model: undefined,
      lastTs: undefined,
      firstTs: undefined,
      isSubagent: false,
      agentName: undefined,
    };
    cur.input += input;
    cur.output += output;
    cur.cacheRead += cacheRead;
    cur.costUsd += costUsd;
    cur.turns += 1;
    if (r.model) cur.model = String(r.model);
    if (isSubagent) {
      cur.isSubagent = true;
      if (r.subagent) cur.agentName = String(r.subagent);
    }
    if (!cur.firstTs || iso < cur.firstTs) cur.firstTs = iso;
    if (!cur.lastTs || iso > cur.lastTs) cur.lastTs = iso;
    map.set(sessionKey, cur);

    if (hourly?.add && iso) {
      hourly.add(id, iso, {
        inputTokens: input,
        outputTokens: output,
        cacheReadTokens: cacheRead,
        reasoningTokens: 0,
        model: r.model ? String(r.model) : undefined,
        sessionId: sessionKey,
      });
    }
  }

  return map;
}

/**
 * 列出 sessions 目录下的会话（以 .meta.json 为主，补纯 jsonl）。
 * @returns {{ sessionId: string, metaPath?: string, jsonlPath?: string, mtimeMs: number }[]}
 */
function listSessionFiles() {
  const root = sessionsDir();
  /** @type {Map<string, { sessionId: string, metaPath?: string, jsonlPath?: string, mtimeMs: number }>} */
  const map = new Map();
  if (!fs.existsSync(root)) return [];

  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }

  for (const ent of entries) {
    if (!ent.isFile()) continue;
    const name = ent.name;
    if (name.endsWith(".bak")) continue;

    let sessionId;
    /** @type {"meta" | "jsonl" | null} */
    let kind = null;
    if (name.endsWith(".meta.json")) {
      sessionId = name.slice(0, -".meta.json".length);
      kind = "meta";
    } else if (name.endsWith(".jsonl")) {
      sessionId = name.slice(0, -".jsonl".length);
      kind = "jsonl";
    } else {
      continue;
    }

    const full = path.join(root, name);
    let mtimeMs = 0;
    try {
      mtimeMs = fs.statSync(full).mtimeMs;
    } catch {
      /* ignore */
    }

    const cur = map.get(sessionId) || {
      sessionId,
      mtimeMs: 0,
    };
    if (kind === "meta") cur.metaPath = full;
    if (kind === "jsonl") cur.jsonlPath = full;
    if (mtimeMs > cur.mtimeMs) cur.mtimeMs = mtimeMs;
    map.set(sessionId, cur);
  }

  return [...map.values()];
}

/**
 * @param {{ hourly?: { add?: Function } }} [ctx]
 */
export async function scan(ctx = {}) {
  const scannedAt = new Date().toISOString();
  const defaultModel = readDefaultModel();
  const usageMap = await loadUsageBySession(ctx.hourly);
  const files = listSessionFiles();

  /** @type {Set<string>} 已从 meta/jsonl 生成的 sessionId */
  const seen = new Set();
  /** @type {import('../types.js').SessionRecord[]} */
  const out = [];

  for (const f of files) {
    seen.add(f.sessionId);
    const meta = f.metaPath ? readJson(f.metaPath) || {} : {};
    const chat = f.jsonlPath
      ? peekChatJsonl(f.jsonlPath)
      : { messageCount: 0, title: undefined };

    const usage = usageMap.get(f.sessionId);

    // token：优先 usage.jsonl 累计，否则 meta 汇总
    let input = 0;
    let output = 0;
    let cacheRead = 0;
    let costUsd;
    let turnCount;
    let model = usage?.model || defaultModel;
    let quality = /** @type {import('../types.js').Quality} */ ("metadata_only");

    if (usage && usage.turns > 0) {
      input = usage.input;
      output = usage.output;
      cacheRead = usage.cacheRead;
      costUsd = usage.costUsd > 0 ? usage.costUsd : undefined;
      turnCount = usage.turns;
      quality = input + output + cacheRead > 0 ? "full" : "partial";
    } else {
      const hit = Math.max(0, Number(meta.cacheHitTokens) || 0);
      const miss = Math.max(0, Number(meta.cacheMissTokens) || 0);
      const completion = Math.max(0, Number(meta.totalCompletionTokens) || 0);
      input = miss;
      cacheRead = hit;
      output = completion;
      if (typeof meta.totalCostUsd === "number" && meta.totalCostUsd > 0) {
        costUsd = meta.totalCostUsd;
      }
      if (input + output + cacheRead > 0) {
        quality = "full";
      } else if (meta.summary || chat.messageCount > 0) {
        quality = "no_model";
      } else {
        quality = "metadata_only";
      }
    }

    const startedAt =
      usage?.firstTs ||
      startedFromSessionId(f.sessionId) ||
      (f.mtimeMs ? new Date(f.mtimeMs).toISOString() : undefined);
    const lastUsedAt =
      usage?.lastTs ||
      (f.mtimeMs ? new Date(f.mtimeMs).toISOString() : startedAt);

    const title =
      (typeof meta.summary === "string" && meta.summary.trim()
        ? meta.summary.trim().length > 80
          ? `${meta.summary.trim().slice(0, 80)}…`
          : meta.summary.trim()
        : undefined) ||
      chat.title ||
      f.sessionId;

    const cwd =
      typeof meta.workspace === "string" && meta.workspace.trim()
        ? meta.workspace.trim()
        : undefined;

    // 无 usage.jsonl 时：把会话总量落到 lastUsedAt 所在小时，便于趋势图不空
    if (
      ctx.hourly?.add &&
      !(usage && usage.turns > 0) &&
      lastUsedAt &&
      input + output + cacheRead > 0
    ) {
      ctx.hourly.add(id, lastUsedAt, {
        inputTokens: input,
        outputTokens: output,
        cacheReadTokens: cacheRead,
        reasoningTokens: 0,
        model: model || undefined,
        sessionId: f.sessionId,
      });
    }

    out.push(
      makeSession({
        client: id,
        sessionId: f.sessionId,
        title,
        cwd,
        model,
        startedAt,
        lastUsedAt,
        messageCount: chat.messageCount || undefined,
        inputTokens: input,
        outputTokens: output,
        cacheReadTokens: cacheRead,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
        costUsd,
        quality,
        scannedAt,
        turnCount,
        requestCount: turnCount || undefined,
        isSubagent: usage?.isSubagent || false,
        agentName: usage?.agentName,
      })
    );
  }

  // usage.jsonl 里有、但没有对应 meta/jsonl 的会话（或匿名/子 agent）
  for (const [sessionId, usage] of usageMap) {
    if (seen.has(sessionId)) continue;
    if (sessionId === "__anonymous__") {
      // 合并成一条「未关联会话」汇总
      out.push(
        makeSession({
          client: id,
          sessionId: "usage-anonymous",
          title: "（未标记会话的用量）",
          model: usage.model || defaultModel,
          startedAt: usage.firstTs,
          lastUsedAt: usage.lastTs,
          inputTokens: usage.input,
          outputTokens: usage.output,
          cacheReadTokens: usage.cacheRead,
          costUsd: usage.costUsd > 0 ? usage.costUsd : undefined,
          quality: usage.input + usage.output + usage.cacheRead > 0 ? "full" : "partial",
          scannedAt,
          turnCount: usage.turns,
        })
      );
      continue;
    }

    out.push(
      makeSession({
        client: id,
        sessionId,
        title: usage.agentName || sessionId,
        model: usage.model || defaultModel,
        startedAt: usage.firstTs,
        lastUsedAt: usage.lastTs,
        inputTokens: usage.input,
        outputTokens: usage.output,
        cacheReadTokens: usage.cacheRead,
        costUsd: usage.costUsd > 0 ? usage.costUsd : undefined,
        quality: usage.input + usage.output + usage.cacheRead > 0 ? "full" : "partial",
        scannedAt,
        turnCount: usage.turns,
        isSubagent: usage.isSubagent,
        agentName: usage.agentName,
      })
    );
  }

  return out;
}

/**
 * 会话明细：从 usage.jsonl 抽出该 session 的 turn。
 * @param {string} sessionId
 * @param {{ mergedChildren?: string[] }} [opts]
 */
export async function sessionDetail(sessionId, opts = {}) {
  const ids = new Set([sessionId, ...(opts.mergedChildren || [])]);
  const logPath = usageLogPath();
  /** @type {import('../types.js').TurnDetail[]} */
  const turns = [];
  /** @type {Map<string, { model: string, turns: number, input: number, output: number, cacheRead: number }>} */
  const byModel = new Map();

  if (fs.existsSync(logPath)) {
    const stream = fs.createReadStream(logPath, { encoding: "utf8" });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    let index = 0;
    for await (const line of rl) {
      if (!line.trim()) continue;
      let r;
      try {
        r = JSON.parse(line);
      } catch {
        continue;
      }
      const sid = r.session ? String(r.session) : "";
      if (!ids.has(sid)) continue;
      if (typeof r.ts !== "number") continue;

      const input = Math.max(0, Number(r.cacheMissTokens) || 0);
      const cacheRead = Math.max(0, Number(r.cacheHitTokens) || 0);
      const output = Math.max(0, Number(r.completionTokens) || 0);
      const model = r.model ? String(r.model) : "未知模型";
      index += 1;
      turns.push({
        index,
        ts: toIso(r.ts) || new Date(r.ts).toISOString(),
        model,
        inputTokens: input,
        outputTokens: output,
        cacheReadTokens: cacheRead,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
        isSubagent: r.kind === "subagent" || Boolean(r.subagent),
        agentName: r.subagent
          ? String(r.subagent).replace(/^agent[-_]+/i, "") || undefined
          : undefined,
      });

      const m = byModel.get(model) || {
        model,
        turns: 0,
        input: 0,
        output: 0,
        cacheRead: 0,
      };
      m.turns += 1;
      m.input += input;
      m.output += output;
      m.cacheRead += cacheRead;
      byModel.set(model, m);
    }
  }

  // 无 usage 时：从 meta 给一条汇总 turn
  if (turns.length === 0) {
    const metaPath = path.join(sessionsDir(), `${sessionId}.meta.json`);
    const meta = readJson(metaPath);
    if (meta) {
      const hit = Math.max(0, Number(meta.cacheHitTokens) || 0);
      const miss = Math.max(0, Number(meta.cacheMissTokens) || 0);
      const completion = Math.max(0, Number(meta.totalCompletionTokens) || 0);
      if (hit + miss + completion > 0) {
        const model = readDefaultModel() || "未知模型";
        turns.push({
          index: 1,
          model,
          inputTokens: miss,
          outputTokens: completion,
          cacheReadTokens: hit,
          cacheWriteTokens: 0,
          reasoningTokens: 0,
        });
        byModel.set(model, {
          model,
          turns: 1,
          input: miss,
          output: completion,
          cacheRead: hit,
        });
      }
    }
  }

  const meta = readJson(path.join(sessionsDir(), `${sessionId}.meta.json`));
  return {
    client: id,
    sessionId,
    title:
      (meta && typeof meta.summary === "string" && meta.summary) ||
      sessionId,
    turns,
    models: [...byModel.values()].map((m) => ({
      model: m.model,
      turns: m.turns,
      input: m.input,
      output: m.output,
      cacheRead: m.cacheRead,
    })),
    note: fs.existsSync(usageLogPath())
      ? undefined
      : "未找到 ~/.reasonix/usage.jsonl，仅展示 meta 汇总（无逐 turn 明细）",
    meta: meta || undefined,
  };
}
