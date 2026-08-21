/**
 * 小米 MiMo Code（mimocode）适配器
 *
 * 数据：~/.local/share/mimocode/mimocode.db
 * Schema 接近 OpenCode（session / message / part），但：
 * - session 表无 tokens_* 列，用量从 assistant message.data.tokens 汇总
 * - message 有 agent_id；data 含 agent / mode / modelID / tokens / cost
 * - cache 与 input 互不重叠（cache 可远大于 input），按 exclusive 口径入账
 */
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { agentPaths } from "../paths.js";
import { normalizeAgentName } from "../agentLabel.js";
import { durationFromRange } from "../speed.js";
import { makeSession, splitModelParts, toIso } from "../types.js";

export const id = "mimocode";
export const displayName = "MiMo Code";

export function detect() {
  return fs.existsSync(agentPaths().mimocodeDb);
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
 * @param {any} data
 * @returns {{ base?: string, variant?: string }}
 */
function modelPartsFromData(data) {
  if (!data || typeof data !== "object") return {};
  if (data.model && typeof data.model === "object") {
    return splitModelParts({
      id:
        data.model.modelID ||
        data.model.modelId ||
        data.model.id ||
        data.model.model,
      variant: data.model.variant ?? data.variant,
    });
  }
  const id = data.modelID || data.modelId || data.model;
  if (id == null || id === "") return {};
  return splitModelParts({ id: String(id), variant: data.variant });
}

/**
 * 角色标签：优先有信息的 mode（build/explore/plan），再 agent / agent_id。
 * main 等占位由 normalizeAgentName 洗掉。
 * @param {any} data
 * @param {string} [agentIdCol]
 * @returns {string | undefined}
 */
function agentFromData(data, agentIdCol) {
  const candidates = [
    data?.mode,
    data?.agent,
    data?.agentName,
    agentIdCol,
  ];
  for (const c of candidates) {
    const n = normalizeAgentName(c);
    if (n) return n;
  }
  // 保留原始非 main 名字（未进 normalize 白名单时）
  for (const c of candidates) {
    if (c == null) continue;
    const s = String(c).trim();
    if (s && !/^(main|default|unknown)$/i.test(s)) return s;
  }
  return undefined;
}

/**
 * @param {any} tokens
 * @returns {{ input: number, output: number, reasoning: number, cacheRead: number, cacheWrite: number } | null}
 */
function normalizeTokenParts(tokens) {
  if (!tokens || typeof tokens !== "object") return null;
  const rawIn = Number(tokens.input) || 0;
  const rawOut = Number(tokens.output) || 0;
  const rawReason = Number(tokens.reasoning) || 0;
  const cache =
    tokens.cache && typeof tokens.cache === "object" ? tokens.cache : {};
  const rawCr = Number(cache.read) || 0;
  const rawCw = Number(cache.write) || 0;
  if (rawIn + rawOut + rawReason + rawCr + rawCw <= 0) return null;
  // MiMo 实测 cache 可 ≫ input，按 exclusive 分列（与 Claude/OpenCode 无 total 提示时一致）
  return {
    input: rawIn,
    output: rawOut,
    reasoning: rawReason,
    cacheRead: rawCr,
    cacheWrite: rawCw,
  };
}

/**
 * @param {string} [dbPath]
 */
function openDb(dbPath = agentPaths().mimocodeDb) {
  if (!fs.existsSync(dbPath)) return null;
  try {
    return new DatabaseSync(dbPath, { readOnly: true });
  } catch {
    try {
      return new DatabaseSync(`file:${dbPath}?mode=ro`, { readOnly: true });
    } catch {
      return null;
    }
  }
}

/**
 * @param {{ hourly?: { add: Function } }} [ctx]
 */
export function scan(ctx = {}) {
  const dbPath = agentPaths().mimocodeDb;
  if (!fs.existsSync(dbPath)) return [];

  const hourly = ctx.hourly;
  const scannedAt = new Date().toISOString();
  /** @type {import('../types.js').SessionRecord[]} */
  const out = [];

  const db = openDb(dbPath);
  if (!db) {
    console.error("[mimocode] open db failed");
    return [];
  }

  try {
    /** @type {any[]} */
    let sessions = [];
    try {
      sessions = db
        .prepare(
          `SELECT id, project_id, parent_id, directory, title,
                  time_created, time_updated
           FROM session`
        )
        .all();
    } catch (err) {
      console.error("[mimocode] session table failed", err);
      return [];
    }

    /** @type {Map<string, {
     *   input: number, output: number, reasoning: number,
     *   cacheRead: number, cacheWrite: number,
     *   cost: number, req: number, msg: number,
     *   model?: string, modelVariant?: string, agent?: string
     * }>} */
    const usage = new Map();
    /** @type {Map<string, number>} */
    const msgCount = new Map();

    let msgRows = [];
    try {
      msgRows = db
        .prepare(
          `SELECT id, session_id, agent_id, time_created, time_updated, data
           FROM message`
        )
        .all();
    } catch (err) {
      console.error("[mimocode] message scan failed", err);
    }

    for (const row of msgRows) {
      const sid = row.session_id != null ? String(row.session_id) : "";
      if (!sid) continue;
      msgCount.set(sid, (msgCount.get(sid) || 0) + 1);

      const data = parseJson(row.data);
      if (!data || typeof data !== "object") continue;

      const role = String(data.role || "").toLowerCase();
      if (role && role !== "assistant") continue;

      const tokens = data.tokens;
      const parts = normalizeTokenParts(tokens);
      if (!parts) continue;

      const mp = modelPartsFromData(data);
      const model = mp.base;
      const agent = agentFromData(data, row.agent_id);

      const cur = usage.get(sid) || {
        input: 0,
        output: 0,
        reasoning: 0,
        cacheRead: 0,
        cacheWrite: 0,
        cost: 0,
        req: 0,
        msg: 0,
      };
      cur.input += parts.input;
      cur.output += parts.output;
      cur.reasoning += parts.reasoning;
      cur.cacheRead += parts.cacheRead;
      cur.cacheWrite += parts.cacheWrite;
      cur.req += 1;
      if (data.cost != null) cur.cost += Number(data.cost) || 0;
      if (model) cur.model = model;
      if (mp.variant) cur.modelVariant = mp.variant;
      if (agent) cur.agent = agent;
      usage.set(sid, cur);

      const ts =
        data.time?.completed ||
        data.time?.created ||
        row.time_updated ||
        row.time_created;
      if (ts && hourly?.add) {
        const durationMs = durationFromRange(
          data.time?.created,
          data.time?.completed
        );
        hourly.add(id, ts, {
          inputTokens: parts.input,
          outputTokens: parts.output,
          reasoningTokens: parts.reasoning,
          cacheReadTokens: parts.cacheRead,
          cacheWriteTokens: parts.cacheWrite,
          model,
          sessionId: sid,
          requestCount: 1,
          durationMs: durationMs || undefined,
        });
      }
    }

    for (const row of sessions) {
      const sid = String(row.id);
      const u = usage.get(sid);
      const input = u?.input || 0;
      const output = u?.output || 0;
      const reasoning = u?.reasoning || 0;
      const cacheRead = u?.cacheRead || 0;
      const cacheWrite = u?.cacheWrite || 0;
      const hasTokens = input + output + reasoning + cacheRead + cacheWrite > 0;
      const parentId =
        row.parent_id != null && String(row.parent_id).trim() !== ""
          ? String(row.parent_id)
          : undefined;
      const isSub = !!parentId;
      const reqN = u?.req || 0;
      const costUsd = u && u.cost > 0 ? u.cost : undefined;

      // 无 message 明细但会话存在：不强制小时桶（无 token）
      if (hourly?.add && hasTokens && !u) {
        /* unreachable */
      }

      out.push(
        makeSession({
          client: id,
          sessionId: sid,
          title: row.title || undefined,
          cwd: row.directory || undefined,
          model: u?.model,
          modelVariant: u?.modelVariant,
          startedAt: toIso(row.time_created),
          lastUsedAt: toIso(row.time_updated),
          messageCount: msgCount.get(sid) || 0,
          inputTokens: input,
          outputTokens: output,
          reasoningTokens: reasoning,
          cacheReadTokens: cacheRead,
          cacheWriteTokens: cacheWrite,
          costUsd,
          quality: hasTokens ? "full" : "partial",
          parentSessionId: parentId,
          isSubagent: isSub || undefined,
          agentName: u?.agent,
          requestCount: reqN || undefined,
          turnCount: reqN || undefined,
          scannedAt,
        })
      );
    }
  } catch (err) {
    console.error("[mimocode] scan failed", err);
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
 * Turn 明细
 * @param {string} sessionId
 */
export function getDetail(sessionId) {
  const db = openDb();
  if (!db) return null;

  try {
    let title;
    try {
      const meta = db
        .prepare(`SELECT title FROM session WHERE id = ?`)
        .get(sessionId);
      title = meta?.title || undefined;
    } catch {
      /* ignore */
    }

    /** @type {any[]} */
    let rows = [];
    try {
      rows = db
        .prepare(
          `SELECT agent_id, data, time_created, time_updated
           FROM message
           WHERE session_id = ?
           ORDER BY time_created ASC`
        )
        .all(sessionId);
    } catch {
      return null;
    }

    /** @type {any[]} */
    const turns = [];
    /** @type {Map<string, any>} */
    const byModel = new Map();
    /** @type {Map<string, any>} */
    const byAgent = new Map();
    let i = 0;

    for (const row of rows) {
      const data = parseJson(row.data);
      if (!data || typeof data !== "object") continue;
      const role = String(data.role || "").toLowerCase();
      if (role && role !== "assistant") continue;

      const parts = normalizeTokenParts(data.tokens);
      if (!parts) continue;

      const mp = modelPartsFromData(data);
      const model = mp.base || "(unknown)";
      const agentName = agentFromData(data, row.agent_id);
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
        modelVariant: mp.variant,
        agentName,
        inputTokens: parts.input,
        outputTokens: parts.output,
        cacheReadTokens: parts.cacheRead,
        cacheWriteTokens: parts.cacheWrite,
        reasoningTokens: parts.reasoning,
        durationMs:
          durationFromRange(data.time?.created, data.time?.completed) ||
          undefined,
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
      client: id,
      sessionId,
      title,
      turns,
      models: [...byModel.values()],
      agents: [...byAgent.values()],
    };
  } catch (err) {
    console.error("[mimocode] getDetail failed", err);
    return null;
  } finally {
    try {
      db.close();
    } catch {
      /* ignore */
    }
  }
}

/**
 * 子会话 id（parent_id 指向父）
 * @param {string} sessionId
 * @returns {{ id: string, agentName?: string }[]}
 */
export function listChildren(sessionId) {
  const db = openDb();
  if (!db) return [];
  /** @type {{ id: string, agentName?: string }[]} */
  const out = [];
  try {
    const rows = db
      .prepare(
        `SELECT id, title FROM session WHERE parent_id = ? OR parent_id = ?`
      )
      .all(sessionId, String(sessionId));
    for (const r of rows || []) {
      if (!r?.id) continue;
      out.push({ id: String(r.id) });
    }
  } catch {
    /* schema */
  } finally {
    try {
      db.close();
    } catch {
      /* ignore */
    }
  }
  return out;
}
