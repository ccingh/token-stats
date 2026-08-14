/**
 * OpenAI Codex（Desktop / CLI / VS Code）适配器
 *
 * 数据（CODEX_HOME，默认 ~/.codex）：
 * - sessions/YYYY/MM/DD/rollout-*.jsonl  会话事件 + token_count
 * - archived_sessions/                   归档副本（同相对路径时 sessions 优先）
 * - session_index.jsonl             标题索引
 * - state_5.sqlite threads          元数据 / 子会话边
 *
 * 用量：event_msg.token_count 的 last_token_usage（增量）。
 * cache / reasoning 按官方字段视为 input / output 子集，走 splitInclusiveUsage。
 * 子会话：首条 token_count 视为继承父快照，只计之后推进的用量。
 */
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { codexHomes } from "../paths.js";
import { normalizeAgentName } from "../agentLabel.js";
import {
  makeSession,
  normalizeModelName,
  normalizeModelVariant,
  splitInclusiveUsage,
  toIso,
} from "../types.js";

export const id = "codex";
export const displayName = "Codex";

const UUID_RE =
  /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;

/**
 * @returns {boolean}
 */
export function detect() {
  for (const home of codexHomes()) {
    if (!home || !fs.existsSync(home)) continue;
    if (fs.existsSync(path.join(home, "sessions"))) return true;
    if (fs.existsSync(path.join(home, "archived_sessions"))) return true;
    if (fs.existsSync(path.join(home, "session_index.jsonl"))) return true;
    if (fs.existsSync(path.join(home, "state_5.sqlite"))) return true;
  }
  return false;
}

/**
 * @param {string} raw
 * @returns {string | undefined}
 */
function cleanCwd(raw) {
  if (raw == null) return undefined;
  let s = String(raw).trim();
  if (!s) return undefined;
  if (s.startsWith("\\\\?\\")) s = s.slice(4);
  else if (s.startsWith("//?/")) s = s.slice(4);
  return s || undefined;
}

/**
 * @param {string} file
 * @returns {string | undefined}
 */
export function sessionIdFromFilename(file) {
  const base = path.basename(file, ".jsonl");
  const m = base.match(UUID_RE);
  if (m) return m[1].toLowerCase();
  const stripped = base.replace(/^rollout-/, "");
  return stripped || undefined;
}

/**
 * @param {unknown} raw
 * @returns {boolean}
 */
function hasUsage(raw) {
  if (!raw || typeof raw !== "object") return false;
  const o = /** @type {Record<string, unknown>} */ (raw);
  return (
    (Number(o.input_tokens) || 0) +
      (Number(o.output_tokens) || 0) +
      (Number(o.cached_input_tokens) || 0) +
      (Number(o.cache_write_input_tokens) || 0) +
      (Number(o.cache_creation_input_tokens) || 0) +
      (Number(o.reasoning_output_tokens) || 0) +
      (Number(o.total_tokens) || 0) >
    0
  );
}

/**
 * @param {any} raw
 */
function usageFingerprint(raw) {
  if (!raw || typeof raw !== "object") return "";
  return [
    Number(raw.input_tokens) || 0,
    Number(raw.cached_input_tokens) || 0,
    Number(raw.cache_write_input_tokens) ||
      Number(raw.cache_creation_input_tokens) ||
      0,
    Number(raw.output_tokens) || 0,
    Number(raw.reasoning_output_tokens) || 0,
    Number(raw.total_tokens) || 0,
  ].join("|");
}

/**
 * @param {any} raw
 */
function splitCodexUsage(raw) {
  if (!hasUsage(raw)) return null;
  return splitInclusiveUsage({
    input: Number(raw.input_tokens) || 0,
    output: Number(raw.output_tokens) || 0,
    reasoning: Number(raw.reasoning_output_tokens) || 0,
    cacheRead: Number(raw.cached_input_tokens) || 0,
    cacheWrite:
      Number(raw.cache_write_input_tokens) ||
      Number(raw.cache_creation_input_tokens) ||
      0,
  });
}

/**
 * @param {any} a
 * @param {any} b
 */
function usageDelta(curr, prev) {
  if (!curr || typeof curr !== "object") return null;
  if (!prev || typeof prev !== "object") return hasUsage(curr) ? curr : null;
  const keys = [
    "input_tokens",
    "cached_input_tokens",
    "cache_write_input_tokens",
    "cache_creation_input_tokens",
    "output_tokens",
    "reasoning_output_tokens",
    "total_tokens",
  ];
  /** @type {Record<string, number>} */
  const out = {};
  let any = false;
  for (const k of keys) {
    const n = Math.max(0, (Number(curr[k]) || 0) - (Number(prev[k]) || 0));
    out[k] = n;
    if (n > 0) any = true;
  }
  return any ? out : null;
}

/**
 * @param {unknown} raw
 */
function isChildThreadSource(raw) {
  if (raw == null) return false;
  return /subagent|spawn|child|multi[_-]?agent/i.test(String(raw));
}

/**
 * @param {any} meta
 */
function parentIdFromMeta(meta) {
  if (!meta || typeof meta !== "object") return undefined;
  const raw =
    meta.parent_thread_id ||
    meta.parent_id ||
    meta.parent_session_id ||
    meta.parentSessionId;
  if (raw == null) return undefined;
  const s = String(raw).trim();
  return s || undefined;
}

/**
 * @param {string} file
 * @returns {any[]}
 */
function readJsonl(file) {
  /** @type {any[]} */
  const out = [];
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return out;
  }
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      /* skip */
    }
  }
  return out;
}

/**
 * @param {string} root
 * @param {number} [maxDepth]
 * @returns {string[]}
 */
function walkJsonl(root, maxDepth = 8) {
  /** @type {string[]} */
  const files = [];
  if (!root || !fs.existsSync(root)) return files;
  const walk = (d, depth) => {
    if (depth > maxDepth) return;
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      const full = path.join(d, ent.name);
      if (ent.isDirectory()) walk(full, depth + 1);
      else if (ent.isFile() && ent.name.toLowerCase().endsWith(".jsonl")) {
        files.push(full);
      }
    }
  };
  walk(root, 0);
  return files;
}

/**
 * sessions 与 archived 同相对路径时，现场 sessions 优先。
 * @param {string} home
 * @returns {string[]}
 */
function listHomeRollouts(home) {
  const liveRoot = path.join(home, "sessions");
  const archivedRoot = path.join(home, "archived_sessions");
  const live = walkJsonl(liveRoot);
  const archived = walkJsonl(archivedRoot);
  if (!archived.length) return live;
  const liveRel = new Set(
    live.map((f) => path.relative(liveRoot, f).toLowerCase())
  );
  const extra = archived.filter((f) => {
    const rel = path.relative(archivedRoot, f).toLowerCase();
    return !liveRel.has(rel);
  });
  return live.concat(extra);
}

/**
 * @param {string} home
 * @returns {Map<string, string>}
 */
function loadSessionIndex(home) {
  /** @type {Map<string, string>} */
  const map = new Map();
  const p = path.join(home, "session_index.jsonl");
  if (!fs.existsSync(p)) return map;
  let raw;
  try {
    raw = fs.readFileSync(p, "utf8");
  } catch {
    return map;
  }
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const o = JSON.parse(line);
      const sid = String(o.id || o.session_id || "").trim();
      const title = String(o.thread_name || o.title || "").trim();
      if (sid && title) map.set(sid.toLowerCase(), title);
    } catch {
      /* skip */
    }
  }
  return map;
}

/**
 * @param {string} dbPath
 */
function openDb(dbPath) {
  if (!dbPath || !fs.existsSync(dbPath)) return null;
  try {
    return new DatabaseSync(dbPath, { readOnly: true });
  } catch {
    try {
      const uri = `file:${dbPath.replace(/\\/g, "/")}?mode=ro`;
      return new DatabaseSync(uri, { readOnly: true });
    } catch {
      return null;
    }
  }
}

/**
 * @param {string} home
 */
function loadSqliteMeta(home) {
  /** @type {Map<string, any>} */
  const threads = new Map();
  /** @type {Map<string, string>} */
  const parentOf = new Map();
  /** @type {Map<string, { id: string, agentName?: string }[]>} */
  const childrenOf = new Map();

  const dbPath = path.join(home, "state_5.sqlite");
  const db = openDb(dbPath);
  if (!db) return { threads, parentOf, childrenOf };

  try {
    let rows = [];
    try {
      rows = db.prepare(`SELECT * FROM threads`).all();
    } catch {
      rows = [];
    }
    for (const row of rows || []) {
      if (!row?.id) continue;
      const sid = String(row.id);
      threads.set(sid.toLowerCase(), row);
    }
    let edges = [];
    try {
      edges = db
        .prepare(
          `SELECT parent_thread_id, child_thread_id, status FROM thread_spawn_edges`
        )
        .all();
    } catch {
      edges = [];
    }
    for (const e of edges || []) {
      const parent = e.parent_thread_id != null ? String(e.parent_thread_id) : "";
      const child = e.child_thread_id != null ? String(e.child_thread_id) : "";
      if (!parent || !child) continue;
      parentOf.set(child.toLowerCase(), parent);
      const arr = childrenOf.get(parent.toLowerCase()) || [];
      const childRow = threads.get(child.toLowerCase());
      const agentName =
        normalizeAgentName(childRow?.agent_nickname || childRow?.agent_role) ||
        undefined;
      arr.push({ id: child, agentName });
      childrenOf.set(parent.toLowerCase(), arr);
    }
  } catch (err) {
    console.error("[codex] sqlite meta failed", err);
  } finally {
    try {
      db.close();
    } catch {
      /* ignore */
    }
  }
  return { threads, parentOf, childrenOf };
}

/**
 * @param {any} obj
 */
function eventTs(obj) {
  return toIso(obj?.timestamp || obj?.payload?.timestamp);
}

/**
 * @param {string} file
 * @param {{
 *   indexTitle?: string,
 *   sqliteParent?: string,
 *   sqliteRow?: any,
 * }} [hints]
 */
export function parseRolloutFile(file, hints = {}) {
  const events = readJsonl(file);
  if (!events.length) return null;

  let sessionId = sessionIdFromFilename(file);
  let parentSessionId = hints.sqliteParent;
  let cwd;
  let startedAt;
  let lastUsedAt;
  let model;
  let modelVariant;
  let threadSource;
  let agentName;
  let firstUser;
  let messageCount = 0;
  let turnCount = 0;

  let prevTotal = null;
  let prevFp = "";
  let skipInherited = false;
  let inheritedConsumed = false;

  /** @type {any[]} */
  const turns = [];
  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let reasoning = 0;

  for (const obj of events) {
    if (!obj || typeof obj !== "object") continue;
    const ts = eventTs(obj);
    if (ts) {
      if (!startedAt || ts < startedAt) startedAt = ts;
      if (!lastUsedAt || ts > lastUsedAt) lastUsedAt = ts;
    }

    const type = obj.type;
    const payload = obj.payload && typeof obj.payload === "object" ? obj.payload : {};

    if (type === "session_meta") {
      const sid = payload.session_id || payload.id;
      if (sid) sessionId = String(sid);
      cwd = cleanCwd(payload.cwd) || cwd;
      startedAt = toIso(payload.timestamp) || startedAt;
      threadSource = payload.thread_source || threadSource;
      const p = parentIdFromMeta(payload);
      if (p) parentSessionId = p;
      const nick =
        normalizeAgentName(payload.agent_nickname || payload.agent_role) ||
        undefined;
      if (nick) agentName = nick;
      continue;
    }

    if (type === "turn_context") {
      if (payload.model) {
        model = normalizeModelName(payload.model) || model;
      }
      const effort = payload.effort || payload.reasoning_effort;
      if (effort) modelVariant = normalizeModelVariant(effort) || modelVariant;
      continue;
    }

    const pType = payload.type;

    if (type === "event_msg" && pType === "user_message") {
      messageCount += 1;
      turnCount += 1;
      const text = String(payload.message || "").trim();
      if (text && !firstUser) firstUser = text;
      continue;
    }

    if (type === "event_msg" && pType === "agent_message") {
      messageCount += 1;
      continue;
    }

    if (type === "event_msg" && pType === "token_count") {
      const info = payload.info && typeof payload.info === "object" ? payload.info : {};
      const total = info.total_token_usage;
      const last = info.last_token_usage;
      const fp = usageFingerprint(total);
      if (fp && fp === prevFp) continue;

      const isChild =
        !!parentSessionId || isChildThreadSource(threadSource);
      if (isChild && !inheritedConsumed) {
        skipInherited = true;
      }
      if (skipInherited && !inheritedConsumed) {
        inheritedConsumed = true;
        prevTotal = total || prevTotal;
        prevFp = fp || prevFp;
        continue;
      }

      let rawInc = hasUsage(last) ? last : usageDelta(total, prevTotal);
      prevTotal = total || prevTotal;
      prevFp = fp || prevFp;
      const parts = splitCodexUsage(rawInc);
      if (!parts) continue;
      if (
        parts.input +
          parts.output +
          parts.reasoning +
          parts.cacheRead +
          parts.cacheWrite <=
        0
      ) {
        continue;
      }

      input += parts.input;
      output += parts.output;
      reasoning += parts.reasoning;
      cacheRead += parts.cacheRead;
      cacheWrite += parts.cacheWrite;
      turns.push({
        ts,
        model: model || undefined,
        inputTokens: parts.input,
        outputTokens: parts.output,
        cacheReadTokens: parts.cacheRead,
        cacheWriteTokens: parts.cacheWrite,
        reasoningTokens: parts.reasoning,
      });
    }
  }

  if (!sessionId) return null;

  if (!parentSessionId && hints.sqliteParent) {
    parentSessionId = hints.sqliteParent;
  }
  if (!model && hints.sqliteRow?.model) {
    model = normalizeModelName(hints.sqliteRow.model);
  }
  if (!modelVariant && hints.sqliteRow?.reasoning_effort) {
    modelVariant = normalizeModelVariant(hints.sqliteRow.reasoning_effort);
  }
  if (!cwd && hints.sqliteRow?.cwd) cwd = cleanCwd(hints.sqliteRow.cwd);
  if (!agentName && hints.sqliteRow) {
    agentName =
      normalizeAgentName(
        hints.sqliteRow.agent_nickname || hints.sqliteRow.agent_role
      ) || undefined;
  }
  if (!startedAt && hints.sqliteRow) {
    startedAt = toIso(hints.sqliteRow.created_at_ms || hints.sqliteRow.created_at);
  }
  if (!lastUsedAt && hints.sqliteRow) {
    lastUsedAt = toIso(
      hints.sqliteRow.updated_at_ms || hints.sqliteRow.updated_at
    );
  }

  const title =
    (hints.indexTitle && String(hints.indexTitle).trim()) ||
    (hints.sqliteRow?.title && String(hints.sqliteRow.title).trim()) ||
    (firstUser
      ? firstUser.length > 80
        ? `${firstUser.slice(0, 80)}…`
        : firstUser
      : undefined);

  const hasTokens = input + output + reasoning + cacheRead + cacheWrite > 0;
  const isSub = !!parentSessionId || isChildThreadSource(threadSource);

  return {
    sessionId,
    parentSessionId,
    cwd,
    startedAt,
    lastUsedAt,
    model,
    modelVariant,
    title,
    agentName,
    messageCount,
    turnCount,
    requestCount: turns.length,
    input,
    output,
    cacheRead,
    cacheWrite,
    reasoning,
    turns,
    hasTokens,
    isSubagent: isSub,
  };
}

/**
 * @param {string} sessionId
 * @returns {string | null}
 */
export function findRolloutPath(sessionId) {
  if (!sessionId) return null;
  const want = String(sessionId).toLowerCase();
  for (const home of codexHomes()) {
    const sqlite = loadSqliteMeta(home);
    const row = sqlite.threads.get(want);
    if (row?.rollout_path && fs.existsSync(row.rollout_path)) {
      return row.rollout_path;
    }
    for (const file of listHomeRollouts(home)) {
      const fromName = sessionIdFromFilename(file);
      if (fromName && fromName.toLowerCase() === want) return file;
    }
    // 文件名对不上时再peek session_meta
    for (const file of listHomeRollouts(home)) {
      const events = readJsonl(file);
      for (const obj of events) {
        if (obj?.type !== "session_meta") continue;
        const p = obj.payload || {};
        const sid = String(p.session_id || p.id || "").toLowerCase();
        if (sid === want) return file;
        break;
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
  /** @type {Set<string>} */
  const seen = new Set();

  for (const home of codexHomes()) {
    if (!home || !fs.existsSync(home)) continue;
    const indexTitles = loadSessionIndex(home);
    const sqlite = loadSqliteMeta(home);
    const files = listHomeRollouts(home);

    for (const file of files) {
      const fromName = sessionIdFromFilename(file);
      const keyGuess = fromName ? fromName.toLowerCase() : "";
      const sqliteRow = keyGuess ? sqlite.threads.get(keyGuess) : undefined;
      const parsed = parseRolloutFile(file, {
        indexTitle: keyGuess ? indexTitles.get(keyGuess) : undefined,
        sqliteParent: keyGuess ? sqlite.parentOf.get(keyGuess) : undefined,
        sqliteRow,
      });
      if (!parsed) continue;
      const sid = parsed.sessionId;
      const low = sid.toLowerCase();
      if (seen.has(`${id}:${low}`)) continue;
      seen.add(`${id}:${low}`);

      // 文件名 UUID 与 meta 不一致时，补 sqlite / 索引
      const row = sqlite.threads.get(low) || sqliteRow;
      const indexTitle = indexTitles.get(low) || parsed.title;
      const parentId = parsed.parentSessionId || sqlite.parentOf.get(low);

      if (hourly?.add) {
        for (const t of parsed.turns) {
          hourly.add(id, t.ts, {
            inputTokens: t.inputTokens,
            outputTokens: t.outputTokens,
            cacheReadTokens: t.cacheReadTokens,
            cacheWriteTokens: t.cacheWriteTokens,
            reasoningTokens: t.reasoningTokens,
            model: t.model || parsed.model,
            sessionId: sid,
            requestCount: 1,
          });
        }
      }

      out.push(
        makeSession({
          client: id,
          sessionId: sid,
          title: indexTitle || parsed.title || row?.title || undefined,
          cwd: parsed.cwd || cleanCwd(row?.cwd),
          model: parsed.model || normalizeModelName(row?.model),
          modelVariant:
            parsed.modelVariant ||
            normalizeModelVariant(row?.reasoning_effort),
          startedAt: parsed.startedAt,
          lastUsedAt: parsed.lastUsedAt,
          messageCount: parsed.messageCount || undefined,
          inputTokens: parsed.input,
          outputTokens: parsed.output,
          reasoningTokens: parsed.reasoning,
          cacheReadTokens: parsed.cacheRead,
          cacheWriteTokens: parsed.cacheWrite,
          quality: parsed.hasTokens ? "full" : "partial",
          parentSessionId: parentId,
          isSubagent: parsed.isSubagent || !!parentId || undefined,
          agentName: parsed.agentName,
          requestCount: parsed.requestCount || undefined,
          turnCount: parsed.turnCount || undefined,
          scannedAt,
        })
      );
    }

    // jsonl 已删、sqlite 仍在：保留元数据壳
    for (const [low, row] of sqlite.threads) {
      if (seen.has(`${id}:${low}`)) continue;
      seen.add(`${id}:${low}`);
      const parentId = sqlite.parentOf.get(low);
      out.push(
        makeSession({
          client: id,
          sessionId: String(row.id),
          title: row.title || indexTitles.get(low) || undefined,
          cwd: cleanCwd(row.cwd),
          model: normalizeModelName(row.model),
          modelVariant: normalizeModelVariant(row.reasoning_effort),
          startedAt: toIso(row.created_at_ms || row.created_at),
          lastUsedAt: toIso(row.updated_at_ms || row.updated_at),
          quality: "metadata_only",
          parentSessionId: parentId,
          isSubagent: parentId ? true : undefined,
          agentName:
            normalizeAgentName(row.agent_nickname || row.agent_role) ||
            undefined,
          scannedAt,
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
  const file = findRolloutPath(sessionId);
  if (!file) return null;
  const parsed = parseRolloutFile(file);
  if (!parsed) return null;
  const turns = parsed.turns.map((t, i) => ({
    index: i + 1,
    ts: t.ts,
    model: t.model || parsed.model || undefined,
    agentName: parsed.agentName,
    inputTokens: t.inputTokens,
    outputTokens: t.outputTokens,
    cacheReadTokens: t.cacheReadTokens,
    cacheWriteTokens: t.cacheWriteTokens,
    reasoningTokens: t.reasoningTokens,
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
  const want = String(sessionId).toLowerCase();
  /** @type {Map<string, { id: string, agentName?: string }>} */
  const map = new Map();

  for (const home of codexHomes()) {
    if (!home || !fs.existsSync(home)) continue;
    const sqlite = loadSqliteMeta(home);
    for (const c of sqlite.childrenOf.get(want) || []) {
      map.set(c.id.toLowerCase(), c);
    }
    for (const file of listHomeRollouts(home)) {
      const events = readJsonl(file);
      for (const obj of events) {
        if (obj?.type !== "session_meta") continue;
        const p = obj.payload || {};
        const parent = parentIdFromMeta(p);
        if (parent && String(parent).toLowerCase() === want) {
          const cid = String(p.session_id || p.id || sessionIdFromFilename(file) || "");
          if (cid && cid.toLowerCase() !== want) {
            map.set(cid.toLowerCase(), {
              id: cid,
              agentName:
                normalizeAgentName(p.agent_nickname || p.agent_role) ||
                undefined,
            });
          }
        }
        break;
      }
    }
  }
  return [...map.values()];
}
