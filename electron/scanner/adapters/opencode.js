import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { agentPaths } from "../paths.js";
import {
  makeSession,
  normalizeModelName,
  splitInclusiveUsage,
  splitModelParts,
  toIso,
} from "../types.js";

export const id = "opencode";
export const displayName = "OpenCode";

/** @typedef {'v1' | 'v2' | 'migrated'} OpencodeEdition */

export function detect() {
  return fs.existsSync(agentPaths().opencodeDb);
}

/**
 * @param {unknown} raw
 * @returns {any | null}
 */
function parseJson(raw) {
  if (raw == null) return null;
  if (typeof raw === "object") return raw;
  if (typeof raw !== "string") return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} name
 */
function tableExists(db, name) {
  try {
    const row = db
      .prepare(
        `SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1`
      )
      .get(name);
    return !!row;
  } catch {
    return false;
  }
}

/**
 * @param {any} row
 */
function tokenSum(row) {
  return (
    (Number(row?.tokens_input) || 0) +
    (Number(row?.tokens_output) || 0) +
    (Number(row?.tokens_reasoning) || 0) +
    (Number(row?.tokens_cache_read) || 0) +
    (Number(row?.tokens_cache_write) || 0)
  );
}

/**
 * 两边都有同一 sessionId 时：只保留一份用量，取「更新」或「更大」的那侧，绝不相加。
 * @param {any} a
 * @param {any} b
 */
function pickBetterRow(a, b) {
  if (!a) return b;
  if (!b) return a;
  const ta = tokenSum(a);
  const tb = tokenSum(b);
  if (tb !== ta) return tb > ta ? b : a;
  const ua = Number(a.time_updated) || 0;
  const ub = Number(b.time_updated) || 0;
  if (ub !== ua) return ub > ua ? b : a;
  // 时间与用量相同 → 倾向 v2 行（迁移目标表）
  return b;
}

/**
 * @param {any} data
 * @returns {string | undefined}
 */
/**
 * @param {any} data
 * @returns {{ model?: string, variant?: string }}
 */
function modelPartsFromData(data) {
  if (!data) return {};
  if (typeof data.model === "string") {
    return splitModelParts(data.model);
  }
  if (data.model && typeof data.model === "object") {
    return splitModelParts({
      id:
        data.model.id ||
        data.model.modelID ||
        data.model.modelId ||
        data.model.model,
      variant: data.model.variant ?? data.variant,
    });
  }
  const id = data.modelID || data.modelId || data.model;
  if (id == null || id === "") return {};
  return splitModelParts({ id: String(id), variant: data.variant });
}

/** @param {any} data */
function modelFromData(data) {
  const p = modelPartsFromData(data);
  return p.base || undefined;
}

/**
 * @param {any} data
 * @returns {any | null}
 */
function extractTokens(data) {
  if (!data || typeof data !== "object") return null;
  if (data.tokens && typeof data.tokens === "object") return data.tokens;
  // v2 偶发把 step-finish 嵌在 content 里
  if (Array.isArray(data.content)) {
    let last = null;
    for (const c of data.content) {
      if (c && typeof c === "object" && c.tokens && typeof c.tokens === "object") {
        last = c.tokens;
      }
    }
    if (last) return last;
  }
  return null;
}

/**
 * @param {{ type?: string } | null} row
 * @param {any} data
 */
function isAssistantRow(row, data) {
  if (row?.type && String(row.type).toLowerCase() === "assistant") return true;
  if (data?.role === "assistant") return true;
  // v2：assistant 消息常带 agent + tokens，type 可能是 step 名
  if (data?.agent && extractTokens(data)) return true;
  return false;
}

/**
 * @param {any} data
 * @returns {string | undefined}
 */
function agentFromData(data) {
  if (!data || typeof data !== "object") return undefined;
  let raw;
  if (data.agent != null && String(data.agent).trim()) {
    raw = String(data.agent).trim();
  } else if (data.agentName != null && String(data.agentName).trim()) {
    raw = String(data.agentName).trim();
  }
  if (!raw) return undefined;
  // 去掉无信息占位
  if (/^(main|subagent|build-agent|default)$/i.test(raw)) return undefined;
  return raw;
}

/**
 * @param {any} tokens
 */
function normalizeTokenParts(tokens) {
  const rawIn = Number(tokens.input) || 0;
  const rawOut = Number(tokens.output) || 0;
  const rawReason = Number(tokens.reasoning) || 0;
  const cache =
    tokens.cache && typeof tokens.cache === "object" ? tokens.cache : {};
  const rawCr = Number(cache.read) || 0;
  const rawCw = Number(cache.write) || 0;
  if (rawIn + rawOut + rawReason + rawCr + rawCw <= 0) return null;
  const totalHint = Number(tokens.total) || 0;
  const inclusive =
    totalHint > 0 &&
    Math.abs(totalHint - rawIn - rawOut) <= 2 &&
    rawCr > 0 &&
    rawCr <= rawIn;
  return inclusive
    ? splitInclusiveUsage({
        input: rawIn,
        output: rawOut,
        reasoning: rawReason,
        cacheRead: rawCr,
        cacheWrite: rawCw,
      })
    : {
        input: rawIn,
        output: rawOut,
        reasoning: rawReason,
        cacheRead: rawCr,
        cacheWrite: rawCw,
      };
}

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{
 *   table: 'message' | 'session_message',
 *   hourly?: { add: Function },
 *   modelFromMsgs: Map<string, string>,
 *   reqFromMsgs: Map<string, number>,
 *   hourlyFromMsgs: Set<string>,
 *   onlySessionIds?: Set<string> | null,
 *   skipSessionIds?: Set<string> | null,
 * }} opts
 */
function scanMessageTable(db, opts) {
  const {
    table,
    hourly,
    modelFromMsgs,
    reqFromMsgs,
    hourlyFromMsgs,
    onlySessionIds,
    skipSessionIds,
  } = opts;

  const sql =
    table === "session_message"
      ? `SELECT session_id, type, data, time_created, time_updated FROM session_message`
      : `SELECT session_id, data, time_created, time_updated FROM message`;

  let rows;
  try {
    rows = db.prepare(sql).all();
  } catch (err) {
    console.error(`[opencode] ${table} scan failed`, err);
    return;
  }

  for (const row of rows) {
    const sid = row.session_id != null ? String(row.session_id) : "";
    if (!sid) continue;
    if (onlySessionIds && !onlySessionIds.has(sid)) continue;
    if (skipSessionIds && skipSessionIds.has(sid)) continue;

    const data = parseJson(row.data);
    if (!data) continue;
    if (!isAssistantRow(row, data)) continue;

    const model = modelFromData(data);
    if (model) modelFromMsgs.set(sid, model);

    const tokens = extractTokens(data);
    if (!tokens) continue;
    const parts = normalizeTokenParts(tokens);
    if (!parts) continue;

    reqFromMsgs.set(sid, (reqFromMsgs.get(sid) || 0) + 1);

    const ts =
      data.time?.completed ||
      data.time?.created ||
      row.time_updated ||
      row.time_created;
    if (!ts || !hourly?.add) continue;

    hourly.add(id, ts, {
      inputTokens: parts.input,
      outputTokens: parts.output,
      reasoningTokens: parts.reasoning,
      cacheReadTokens: parts.cacheRead,
      cacheWriteTokens: parts.cacheWrite,
      model,
      sessionId: sid,
      requestCount: 1,
    });
    hourlyFromMsgs.add(sid);
  }
}

/**
 * @param {{ hourly?: { add: Function } }} [ctx]
 */
export function scan(ctx = {}) {
  const dbPath = agentPaths().opencodeDb;
  if (!fs.existsSync(dbPath)) return [];

  const hourly = ctx.hourly;
  const scannedAt = new Date().toISOString();
  /** @type {import('../types.js').SessionRecord[]} */
  const out = [];

  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
  } catch (err) {
    try {
      db = new DatabaseSync(`file:${dbPath}?mode=ro`, { readOnly: true });
    } catch {
      console.error("[opencode] open db failed", err);
      return [];
    }
  }

  try {
    const hasV2 = tableExists(db, "session_v2");
    const hasSessionMessage = tableExists(db, "session_message");

    /** @type {Map<string, any>} */
    const v1ById = new Map();
    /** @type {Map<string, any>} */
    const v2ById = new Map();

    try {
      const v1Rows = db
        .prepare(
          `SELECT id, parent_id, directory, title, model, agent, version,
                  time_created, time_updated,
                  tokens_input, tokens_output, tokens_reasoning,
                  tokens_cache_read, tokens_cache_write, cost
           FROM session`
        )
        .all();
      for (const r of v1Rows) v1ById.set(String(r.id), r);
    } catch (err) {
      console.error("[opencode] session table failed", err);
    }

    if (hasV2) {
      try {
        const v2Rows = db
          .prepare(
            `SELECT id, parent_id, directory, title, model, agent, version,
                    time_created, time_updated,
                    tokens_input, tokens_output, tokens_reasoning,
                    tokens_cache_read, tokens_cache_write, cost
             FROM session_v2`
          )
          .all();
        for (const r of v2Rows) v2ById.set(String(r.id), r);
      } catch (err) {
        console.error("[opencode] session_v2 table failed", err);
      }
    }

    /** @type {Map<string, string>} */
    const modelFromMsgs = new Map();
    /** @type {Map<string, number>} */
    const reqFromMsgs = new Map();
    /** @type {Set<string>} */
    const hourlyFromMsgs = new Set();

    // 小时桶 / 请求数：优先 session_message（v2），再补 message（v1 独有），避免迁移会话双计
    if (hasSessionMessage) {
      scanMessageTable(db, {
        table: "session_message",
        hourly,
        modelFromMsgs,
        reqFromMsgs,
        hourlyFromMsgs,
      });
    }
    scanMessageTable(db, {
      table: "message",
      hourly,
      modelFromMsgs,
      reqFromMsgs,
      hourlyFromMsgs,
      // 已从 session_message 入桶的会话不再扫旧 message
      skipSessionIds: hourlyFromMsgs,
    });

    /** @type {Set<string>} */
    const allIds = new Set([...v1ById.keys(), ...v2ById.keys()]);

    for (const sid of allIds) {
      const v1 = v1ById.get(sid);
      const v2 = v2ById.get(sid);

      /** @type {OpencodeEdition} */
      let edition;
      /** @type {any} */
      let row;
      if (v1 && v2) {
        edition = "migrated";
        // 迁移会话：只取一份（token 更大或更新的一侧），绝不 v1+v2 相加
        row = pickBetterRow(v1, v2);
      } else if (v2) {
        edition = "v2";
        row = v2;
      } else {
        edition = "v1";
        row = v1;
      }
      if (!row) continue;

      const input = Number(row.tokens_input) || 0;
      const output = Number(row.tokens_output) || 0;
      const reasoning = Number(row.tokens_reasoning) || 0;
      const cacheRead = Number(row.tokens_cache_read) || 0;
      const cacheWrite = Number(row.tokens_cache_write) || 0;
      const hasTokens = input + output + reasoning + cacheRead + cacheWrite > 0;
      const parentId =
        row.parent_id != null && String(row.parent_id).trim() !== ""
          ? String(row.parent_id)
          : undefined;
      const isSub =
        !!parentId ||
        (row.title && /@\w+\s+subagent/i.test(String(row.title))) ||
        (row.agent && /subagent|explore|general/i.test(String(row.agent)));
      // 原始 model（JSON 含 variant）交给 makeSession 拆主名+档位
      const rawModel = row.model || modelFromMsgs.get(sid) || undefined;
      const sessionModel =
        normalizeModelName(rawModel) ||
        (typeof rawModel === "string" ? rawModel : undefined);
      const reqN = reqFromMsgs.get(sid) || 0;

      // 无 message 明细时：整会话落在 lastUsedAt 小时（兜底）
      if (hourly?.add && hasTokens && !hourlyFromMsgs.has(sid)) {
        const ts = row.time_updated || row.time_created;
        if (ts) {
          hourly.add(id, ts, {
            inputTokens: input,
            outputTokens: output,
            reasoningTokens: reasoning,
            cacheReadTokens: cacheRead,
            cacheWriteTokens: cacheWrite,
            model: sessionModel,
            sessionId: sid,
            requestCount: reqN || 1,
            // 整会话兜底：reqN=0 时不能当成 1 次请求去套长档
            singleRequest: reqN === 1,
          });
        }
      }

      out.push(
        makeSession({
          client: id,
          sessionId: sid,
          title: row.title || undefined,
          cwd: row.directory || undefined,
          model: rawModel,
          startedAt: toIso(row.time_created),
          lastUsedAt: toIso(row.time_updated),
          inputTokens: input,
          outputTokens: output,
          reasoningTokens: reasoning,
          cacheReadTokens: cacheRead,
          cacheWriteTokens: cacheWrite,
          costUsd: row.cost != null ? Number(row.cost) : undefined,
          quality: hasTokens ? "full" : "partial",
          parentSessionId: parentId,
          isSubagent: isSub || undefined,
          agentName: row.agent ? String(row.agent) : undefined,
          // v1 / v2 / migrated — UI 角标用
          sessionKind: edition,
          requestCount: reqN || undefined,
          turnCount: reqN || undefined,
          scannedAt,
        })
      );
    }
  } catch (err) {
    console.error("[opencode] scan failed", err);
  } finally {
    try {
      db.close();
    } catch {
      /* ignore */
    }
  }

  return out;
}

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} sessionId
 * @param {string} table
 */
function loadAssistantTurns(db, sessionId, table) {
  /** @type {any[]} */
  const turns = [];
  /** @type {Map<string, { model: string, turns: number, input: number, output: number, cacheRead: number, cacheWrite: number, reasoning: number }>} */
  const byModel = new Map();
  /** @type {Map<string, { agent: string, turns: number, input: number, output: number, cacheRead: number, cacheWrite: number, reasoning: number }>} */
  const byAgent = new Map();

  const sql =
    table === "session_message"
      ? `SELECT type, data, time_created, time_updated FROM session_message
         WHERE session_id = ? ORDER BY COALESCE(seq, time_created) ASC`
      : `SELECT data, time_created, time_updated FROM message
         WHERE session_id = ? ORDER BY time_created ASC`;

  let rows;
  try {
    rows = db.prepare(sql).all(sessionId);
  } catch {
    return { turns, models: [], agents: [] };
  }

  let i = 0;
  for (const row of rows) {
    const data = parseJson(row.data);
    if (!data || !isAssistantRow(row, data)) continue;
    const tokens = extractTokens(data);
    if (!tokens) continue;
    const parts = normalizeTokenParts(tokens);
    if (!parts) continue;

    const mp = modelPartsFromData(data);
    const model = mp.base || modelFromData(data) || "(unknown)";
    const modelVariant = mp.variant;
    const agentName = agentFromData(data);
    i += 1;
    turns.push({
      index: i,
      ts: toIso(
        data.time?.completed ||
          data.time?.created ||
          row.time_updated ||
          row.time_created
      ),
      model,
      modelVariant,
      agentName,
      inputTokens: parts.input,
      outputTokens: parts.output,
      cacheReadTokens: parts.cacheRead,
      cacheWriteTokens: parts.cacheWrite,
      reasoningTokens: parts.reasoning,
    });
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
    cur.input += parts.input;
    cur.output += parts.output;
    cur.cacheRead += parts.cacheRead;
    cur.cacheWrite += parts.cacheWrite;
    cur.reasoning += parts.reasoning;
    byModel.set(model, cur);

    const agentKey = agentName || "(unknown)";
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
    ag.input += parts.input;
    ag.output += parts.output;
    ag.cacheRead += parts.cacheRead;
    ag.cacheWrite += parts.cacheWrite;
    ag.reasoning += parts.reasoning;
    byAgent.set(agentKey, ag);
  }

  return {
    turns,
    models: [...byModel.values()],
    agents: [...byAgent.values()],
  };
}

/**
 * Turn 明细：优先 v2 session_message，否则旧 message
 * @param {string} sessionId
 */
export function getDetail(sessionId) {
  const dbPath = agentPaths().opencodeDb;
  if (!fs.existsSync(dbPath)) return null;

  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
  } catch {
    try {
      db = new DatabaseSync(`file:${dbPath}?mode=ro`, { readOnly: true });
    } catch {
      return null;
    }
  }

  try {
    let title;
    let sessionKind;
    /** @type {string | undefined} */
    let sessionAgent;
    try {
      if (tableExists(db, "session_v2")) {
        const v2 = db
          .prepare(`SELECT title, agent FROM session_v2 WHERE id = ?`)
          .get(sessionId);
        if (v2?.title) title = v2.title;
        if (v2?.agent) sessionAgent = String(v2.agent);
      }
      if (!title || !sessionAgent) {
        const v1 = db
          .prepare(`SELECT title, agent FROM session WHERE id = ?`)
          .get(sessionId);
        if (!title) title = v1?.title || undefined;
        if (!sessionAgent && v1?.agent) sessionAgent = String(v1.agent);
      }
      const inV1 = !!db
        .prepare(`SELECT 1 AS ok FROM session WHERE id = ? LIMIT 1`)
        .get(sessionId);
      const inV2 =
        tableExists(db, "session_v2") &&
        !!db
          .prepare(`SELECT 1 AS ok FROM session_v2 WHERE id = ? LIMIT 1`)
          .get(sessionId);
      if (inV1 && inV2) sessionKind = "migrated";
      else if (inV2) sessionKind = "v2";
      else if (inV1) sessionKind = "v1";
    } catch {
      /* ignore */
    }

    let packed = {
      turns: /** @type {any[]} */ ([]),
      models: [],
      agents: [],
    };
    if (tableExists(db, "session_message")) {
      packed = loadAssistantTurns(db, sessionId, "session_message");
    }
    if (packed.turns.length === 0) {
      packed = loadAssistantTurns(db, sessionId, "message");
    }

    // 无 per-turn agent 时用会话级 agent 兜底
    if (sessionAgent) {
      for (const t of packed.turns) {
        if (!t.agentName) t.agentName = sessionAgent;
      }
      if (!packed.agents?.length && packed.turns.length) {
        packed.agents = [
          {
            agent: sessionAgent,
            turns: packed.turns.length,
            input: packed.turns.reduce(
              (s, t) => s + (Number(t.inputTokens) || 0),
              0
            ),
            output: packed.turns.reduce(
              (s, t) => s + (Number(t.outputTokens) || 0),
              0
            ),
            cacheRead: packed.turns.reduce(
              (s, t) => s + (Number(t.cacheReadTokens) || 0),
              0
            ),
            cacheWrite: packed.turns.reduce(
              (s, t) => s + (Number(t.cacheWriteTokens) || 0),
              0
            ),
            reasoning: packed.turns.reduce(
              (s, t) => s + (Number(t.reasoningTokens) || 0),
              0
            ),
          },
        ];
      }
    }

    return {
      client: id,
      sessionId,
      title,
      agentName: sessionAgent,
      sessionKind,
      turns: packed.turns,
      models: packed.models,
      agents: packed.agents || [],
      note:
        sessionKind === "migrated"
          ? "OpenCode 迁移会话（V1/V2 同 id 只计一次）"
          : sessionKind === "v2"
            ? "OpenCode V2 会话"
            : sessionKind === "v1"
              ? "OpenCode V1 会话"
              : undefined,
    };
  } finally {
    try {
      db.close();
    } catch {
      /* ignore */
    }
  }
}
