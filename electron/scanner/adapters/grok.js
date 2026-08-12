import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { agentPaths } from "../paths.js";
import { makeSession, toIso } from "../types.js";
import { normalizeAgentName } from "../agentLabel.js";

export const id = "grok";
export const displayName = "Grok Build";

export function detect() {
  const p = agentPaths();
  return fs.existsSync(p.grokSessions) || fs.existsSync(p.grokUnifiedLog);
}

/**
 * Walk session dirs that contain summary.json
 * @param {string} root
 * @returns {string[]}
 */
function findSessionDirs(root) {
  /** @type {string[]} */
  const dirs = [];
  if (!fs.existsSync(root)) return dirs;

  const walk = (d, depth) => {
    if (depth > 6) return;
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    if (entries.some((e) => e.isFile() && e.name === "summary.json")) {
      dirs.push(d);
      // 仍进入 subagents/，否则子会话永远扫不到
      for (const ent of entries) {
        if (ent.isDirectory() && ent.name === "subagents") {
          walk(path.join(d, ent.name), depth + 1);
        }
      }
      return;
    }
    for (const ent of entries) {
      if (ent.isDirectory() && ent.name !== "terminal") {
        walk(path.join(d, ent.name), depth + 1);
      }
    }
  };
  walk(root, 0);
  return dirs;
}

/**
 * @typedef {{ input: number, output: number, cacheRead: number, reasoning: number, lastTs?: string, turns: number, requests: number }} UsageAgg
 */

/**
 * Grok 原始字段互相包含，拆成互不重叠的计费/展示口径：
 * - prompt_tokens 含 cached_prompt_tokens → input 只记未命中
 * - completion_tokens 常含 reasoning_tokens → output 只记非 reasoning
 *
 * @param {{ prompt?: number, cached?: number, completion?: number, reasoning?: number }} raw
 * @returns {{ input: number, output: number, cacheRead: number, reasoning: number }}
 */
function splitGrokUsage(raw) {
  const prompt = Math.max(0, Number(raw.prompt) || 0);
  const cached = Math.max(0, Number(raw.cached) || 0);
  const completion = Math.max(0, Number(raw.completion) || 0);
  const reasoning = Math.max(0, Number(raw.reasoning) || 0);

  // cache 是 prompt 子集
  const cacheRead = cached > 0 && cached <= prompt ? cached : cached;
  const input = cached > 0 && cached <= prompt ? prompt - cached : prompt;

  // reasoning 是 completion 子集（Grok 常见：completion≈reasoning+可见输出）
  const reason = reasoning > 0 && reasoning <= completion ? reasoning : reasoning;
  const output =
    reasoning > 0 && reasoning <= completion ? completion - reasoning : completion;

  return { input, output, cacheRead, reasoning: reason };
}

/**
 * @param {UsageAgg | null | undefined} u
 */
function usageScore(u) {
  if (!u) return 0;
  return (
    (u.input || 0) +
    (u.output || 0) +
    (u.cacheRead || 0) +
    (u.reasoning || 0)
  );
}

/**
 * Aggregate turn usage from unified.jsonl by sid (per-loop inference_done).
 * 注意：该日志会被轮转/截断，长会话往往只剩近期片段，不能无脑优先于 updates.jsonl。
 * @param {{ add?: Function, onlySids?: Set<string> }} [opts]
 * @returns {Promise<Map<string, UsageAgg>>}
 */
async function loadUnifiedUsage(opts = {}) {
  const hourly = opts.hourly;
  const onlySids = opts.onlySids;
  const logPath = agentPaths().grokUnifiedLog;
  /** @type {Map<string, UsageAgg>} */
  const map = new Map();
  if (!fs.existsSync(logPath)) return map;

  const stream = fs.createReadStream(logPath, { encoding: "utf8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  for await (const line of rl) {
    if (!line.includes("inference_done")) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (obj.msg !== "shell.turn.inference_done" && !String(obj.msg || "").includes("inference_done")) {
      if (!obj.ctx?.prompt_tokens && !obj.ctx?.completion_tokens) continue;
    }
    const sid = obj.sid;
    if (!sid) continue;
    if (onlySids && !onlySids.has(sid)) continue;
    const ctx = obj.ctx || {};
    const cur = map.get(sid) || {
      input: 0,
      output: 0,
      cacheRead: 0,
      reasoning: 0,
      turns: 0,
      requests: 0,
    };
    const part = splitGrokUsage({
      prompt: ctx.prompt_tokens,
      cached: ctx.cached_prompt_tokens,
      completion: ctx.completion_tokens,
      reasoning: ctx.reasoning_tokens,
    });
    cur.input += part.input;
    cur.output += part.output;
    cur.cacheRead += part.cacheRead;
    cur.reasoning += part.reasoning;
    cur.turns += 1;
    cur.requests += 1; // 每条 inference_done = 1 次模型请求
    if (obj.ts) cur.lastTs = toIso(obj.ts) || cur.lastTs;
    map.set(sid, cur);
    if (hourly?.add && obj.ts) {
      const modelHint =
        ctx.model ||
        ctx.model_id ||
        obj.model ||
        obj.model_id ||
        undefined;
      hourly.add(id, obj.ts, {
        inputTokens: part.input,
        outputTokens: part.output,
        cacheReadTokens: part.cacheRead,
        reasoningTokens: part.reasoning,
        model: modelHint != null ? String(modelHint) : undefined,
        // 多数 inference_done 无 model；会话扫完后用 summary 保底
        sessionId: sid,
        requestCount: 1,
      });
    }
  }
  return map;
}

/**
 * 会话级 turn_completed.usage（通常比 unified 日志更完整，因不受全局 log 轮转影响）。
 * @param {string} sessionDir
 * @param {{ add?: Function }} [hourly]
 * @param {string} [sessionId]
 * @returns {Promise<UsageAgg | null>}
 */
async function loadUpdatesUsage(sessionDir, hourly, sessionId) {
  const updatesPath = path.join(sessionDir, "updates.jsonl");
  if (!fs.existsSync(updatesPath)) return null;

  const stream = fs.createReadStream(updatesPath, { encoding: "utf8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  /** @type {UsageAgg} */
  const cur = {
    input: 0,
    output: 0,
    cacheRead: 0,
    reasoning: 0,
    turns: 0,
    requests: 0,
  };
  let found = false;

  for await (const line of rl) {
    // Fast path: only touch lines that can carry usage
    if (!line.includes("turn_completed") || !line.includes("usage")) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    const update = obj.params?.update;
    if (!update || update.sessionUpdate !== "turn_completed") continue;
    const us = update.usage;
    if (!us || typeof us !== "object") continue;

    found = true;
    // updates.jsonl 与 unified 相同：input 含 cache，output 常含 reasoning
    const part = splitGrokUsage({
      prompt: us.inputTokens,
      cached: us.cachedReadTokens,
      completion: us.outputTokens,
      reasoning: us.reasoningTokens,
    });
    const modelCalls = Math.max(1, Number(us.modelCalls) || 1);
    cur.input += part.input;
    cur.output += part.output;
    cur.cacheRead += part.cacheRead;
    cur.reasoning += part.reasoning;
    cur.turns += 1;
    cur.requests += modelCalls;
    // turn 时间：优先 update 内字段，否则整行时间
    if (hourly?.add) {
      const ts =
        update.timestamp ||
        obj.timestamp ||
        obj.ts ||
        us.timestamp ||
        null;
      if (ts) {
        let modelHint;
        if (us.modelUsage && typeof us.modelUsage === "object") {
          const keys = Object.keys(us.modelUsage);
          if (keys.length) modelHint = keys[keys.length - 1];
        }
        hourly.add(id, ts, {
          inputTokens: part.input,
          outputTokens: part.output,
          cacheReadTokens: part.cacheRead,
          reasoningTokens: part.reasoning,
          model: modelHint,
          sessionId: sessionId || undefined,
          requestCount: modelCalls,
        });
      }
    }
    // 不使用 costUsdTicks（量级偏高且不等于可核对 API 账单）
  }

  if (!found) return null;
  return cur;
}

/**
 * Prefer last model id from updates turn_completed.modelUsage when summary lacks one.
 * @param {string} sessionDir
 * @returns {Promise<string | undefined>}
 */
async function peekModelFromUpdates(sessionDir) {
  const updatesPath = path.join(sessionDir, "updates.jsonl");
  if (!fs.existsSync(updatesPath)) return undefined;

  // Read tail only for speed on huge files
  let text;
  try {
    const st = fs.statSync(updatesPath);
    const fd = fs.openSync(updatesPath, "r");
    const size = Math.min(st.size, 256 * 1024);
    const buf = Buffer.alloc(size);
    fs.readSync(fd, buf, 0, size, Math.max(0, st.size - size));
    fs.closeSync(fd);
    text = buf.toString("utf8");
  } catch {
    return undefined;
  }

  const lines = text.split(/\r?\n/).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line.includes("modelUsage")) continue;
    try {
      const o = JSON.parse(line);
      const mu = o.params?.update?.usage?.modelUsage;
      if (mu && typeof mu === "object") {
        const keys = Object.keys(mu);
        if (keys.length) return keys[keys.length - 1];
      }
    } catch {
      /* continue */
    }
  }
  return undefined;
}

/**
 * Grok 路径约定：
 *   sessions/<workspace>/<parentId>/summary.json
 *   sessions/<workspace>/<parentId>/subagents/<childId>/...
 * 也可能子会话在 workspace 根下独立目录，但 parent 仍通过 subagents 反查。
 * @param {string} sessionDir
 * @param {string} sessionId
 * @param {string} sessionsRoot
 * @returns {{ parentSessionId?: string, isSubagent: boolean }}
 */
function resolveGrokHierarchy(sessionDir, sessionId, sessionsRoot) {
  const parts = sessionDir.split(path.sep);
  const subIdx = parts.lastIndexOf("subagents");
  if (subIdx > 0) {
    const parentSessionId = parts[subIdx - 1];
    if (parentSessionId && parentSessionId.length >= 8) {
      return { parentSessionId, isSubagent: true };
    }
  }

  // 反查：是否存在 parent/subagents/<thisId>
  const found = findParentViaSubagentsDir(sessionsRoot, sessionId);
  if (found) return { parentSessionId: found, isSubagent: true };

  return { parentSessionId: undefined, isSubagent: false };
}

/**
 * @param {string} root
 * @param {string} childId
 * @returns {string | undefined}
 */
function findParentViaSubagentsDir(root, childId) {
  /** @type {string | undefined} */
  let hit;
  const walk = (d, depth) => {
    if (hit || depth > 8) return;
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      const full = path.join(d, ent.name);
      if (ent.name === "subagents") {
        const childPath = path.join(full, childId);
        if (fs.existsSync(childPath)) {
          hit = path.basename(d);
          return;
        }
      } else if (ent.name !== "terminal") {
        walk(full, depth + 1);
      }
    }
  };
  walk(root, 0);
  return hit;
}

/**
 * @param {{ hourly?: { add: Function } }} [ctx]
 */
export async function scan(ctx = {}) {
  const hourly = ctx.hourly;
  const { grokSessions } = agentPaths();
  const scannedAt = new Date().toISOString();
  // 先只汇总，不写 hourly；选定数据源后再按 sid 写入，避免双计
  const usageBySid = await loadUnifiedUsage();
  const sessionDirs = findSessionDirs(grokSessions);

  /** @type {Map<string, import('../types.js').SessionRecord>} */
  const byId = new Map();
  /** @type {Set<string>} */
  const preferUnified = new Set();
  /** @type {Set<string>} */
  const preferUpdates = new Set();
  /** @type {Map<string, string>} sessionId → sessionDir（updates 回填 hourly 用） */
  const dirBySid = new Map();

  for (const dir of sessionDirs) {
    const summaryPath = path.join(dir, "summary.json");
    let summary;
    try {
      summary = JSON.parse(fs.readFileSync(summaryPath, "utf8"));
    } catch {
      continue;
    }
    const sessionId = summary?.info?.id || path.basename(dir);
    dirBySid.set(sessionId, dir);
    const hier = resolveGrokHierarchy(dir, sessionId, grokSessions);
    let usage = usageBySid.get(sessionId) || null;

    /**
     * 选源策略（重要）：
     * - unified.jsonl：全局限流日志，长会话常被截断 → 数字会「越扫越小」
     * - updates.jsonl：写在会话目录，完整保留 turn 汇总
     * 取 token 总分更高的一侧；不要两源相加（Tokscale 232M≈93+139 即双计）。
     */
    let fromUpdates = null;
    try {
      fromUpdates = await loadUpdatesUsage(dir, null, sessionId);
    } catch (err) {
      console.error("[grok] updates fallback failed", sessionId, err);
    }

    const uScore = usageScore(usage);
    const vScore = usageScore(fromUpdates);
    if (vScore > uScore) {
      usage = fromUpdates;
      if (vScore > 0) preferUpdates.add(sessionId);
    } else if (uScore > 0) {
      preferUnified.add(sessionId);
    } else if (vScore > 0) {
      usage = fromUpdates;
      preferUpdates.add(sessionId);
    }

    const hasTurnUsage = !!(usage && usageScore(usage) > 0);

    let model = summary.current_model_id || undefined;
    if (!model && hasTurnUsage) {
      model = (await peekModelFromUpdates(dir)) || undefined;
    }
    if (model && model.endsWith("-build")) {
      model = model.replace(/-build$/, "");
    }

    const sessionKind = summary.session_kind || (hier.isSubagent ? "subagent" : undefined);
    const agentName = normalizeAgentName(summary.agent_name);
    const isSubagent =
      hier.isSubagent ||
      sessionKind === "subagent" ||
      agentName === "explore" ||
      agentName === "Explore" ||
      /explore/i.test(String(summary.agent_name || ""));
    const parentSessionId = hier.parentSessionId;

    // 从未发起推理：无 usage 且 next_trace_turn 为 0（或仅有 system 注入）
    const neverRan =
      !hasTurnUsage &&
      (Number(summary.next_trace_turn) === 0 ||
        (Number(summary.num_messages) || 0) === 0);

    /** @type {import('../types.js').Quality} */
    let quality = "full";
    if (neverRan) quality = "no_model";
    else if (!hasTurnUsage) quality = "partial";

    byId.set(
      sessionId,
      makeSession({
        client: id,
        sessionId,
        title:
          summary.generated_title ||
          summary.session_summary ||
          (neverRan ? "（未调用模型）" : undefined),
        cwd: summary?.info?.cwd || undefined,
        model,
        startedAt: toIso(summary.created_at),
        lastUsedAt: toIso(summary.last_active_at || summary.updated_at) || usage?.lastTs,
        messageCount: summary.num_messages || summary.num_chat_messages,
        turnCount: usage?.turns || undefined,
        requestCount:
          usage?.requests || usage?.turns || undefined,
        inputTokens: usage?.input || 0,
        outputTokens: usage?.output || 0,
        cacheReadTokens: usage?.cacheRead || 0,
        reasoningTokens: usage?.reasoning || 0,
        quality,
        parentSessionId,
        isSubagent: isSubagent || undefined,
        agentName,
        sessionKind,
        scannedAt,
      })
    );
  }

  // include sids that only appear in unified log
  for (const [sid, usage] of usageBySid) {
    if (byId.has(sid)) continue;
    preferUnified.add(sid);
    byId.set(
      sid,
      makeSession({
        client: id,
        sessionId: sid,
        inputTokens: usage.input,
        outputTokens: usage.output,
        cacheReadTokens: usage.cacheRead,
        reasoningTokens: usage.reasoning,
        turnCount: usage.turns || undefined,
        requestCount: usage.requests || usage.turns || undefined,
        lastUsedAt: usage.lastTs,
        quality: "partial",
        scannedAt,
      })
    );
  }

  // 小时桶：每个 sid 只写入选定的那一侧，避免 unified+updates 双计
  if (hourly?.add) {
    if (preferUnified.size > 0) {
      await loadUnifiedUsage({ hourly, onlySids: preferUnified });
    }
    for (const sid of preferUpdates) {
      const d = dirBySid.get(sid);
      if (!d) continue;
      try {
        await loadUpdatesUsage(d, hourly, sid);
      } catch (err) {
        console.error("[grok] updates hourly failed", sid, err);
      }
    }
  }

  // 会话级 model 保底：回填 turn 日志里没有模型字段的小时桶
  if (hourly?.resolveSessionModels) {
    /** @type {Map<string, string>} */
    const sessionModels = new Map();
    for (const rec of byId.values()) {
      if (rec.model) sessionModels.set(`${id}:${rec.sessionId}`, rec.model);
    }
    hourly.resolveSessionModels(sessionModels);
  }

  return [...byId.values()];
}
