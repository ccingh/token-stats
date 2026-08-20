import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { agentPaths } from "../paths.js";
import { makeSession, splitInclusiveUsage, toIso } from "../types.js";
import { durationFromRange } from "../speed.js";

export const id = "zcode";
export const displayName = "ZCode";

export function detect() {
  return fs.existsSync(agentPaths().zcodeDb);
}

/**
 * ZCode 原始口径：input 含 cache.read（total ≈ input+output）。
 * 统一拆成 未命中 input + cacheRead，与 Grok/计费一致。
 * 优先 raw_usage_json（与列不一致时更准）。
 *
 * @param {{
 *   input_tokens?: number,
 *   output_tokens?: number,
 *   reasoning_tokens?: number,
 *   cache_read_input_tokens?: number,
 *   cache_creation_input_tokens?: number,
 *   raw_usage_json?: string | null,
 * }} row
 */
function partsFromUsageRow(row) {
  let input = Number(row.input_tokens) || 0;
  let output = Number(row.output_tokens) || 0;
  let reasoning = Number(row.reasoning_tokens) || 0;
  let cacheRead = Number(row.cache_read_input_tokens) || 0;
  let cacheWrite = Number(row.cache_creation_input_tokens) || 0;

  if (row.raw_usage_json) {
    try {
      const raw =
        typeof row.raw_usage_json === "string"
          ? JSON.parse(row.raw_usage_json)
          : row.raw_usage_json;
      if (raw && typeof raw === "object") {
        // 列全 0 但 raw 有值 → 用 raw；否则以列为主、raw 补缺
        const rIn = Number(raw.inputTokens ?? raw.input) || 0;
        const rOut = Number(raw.outputTokens ?? raw.output) || 0;
        const rCr = Number(raw.cacheReadTokens ?? raw.cacheRead) || 0;
        const rCw = Number(raw.cacheWriteTokens ?? raw.cacheWrite) || 0;
        const rReason = Number(raw.reasoningTokens ?? raw.reasoning) || 0;
        if (input + output + cacheRead + cacheWrite + reasoning <= 0) {
          input = rIn;
          output = rOut;
          cacheRead = rCr;
          cacheWrite = rCw;
          reasoning = rReason;
        } else {
          if (input <= 0 && rIn > 0) input = rIn;
          if (output <= 0 && rOut > 0) output = rOut;
          if (cacheRead <= 0 && rCr > 0) cacheRead = rCr;
          if (cacheWrite <= 0 && rCw > 0) cacheWrite = rCw;
          if (reasoning <= 0 && rReason > 0) reasoning = rReason;
        }
      }
    } catch {
      /* ignore bad json */
    }
  }

  return splitInclusiveUsage({
    input,
    output,
    reasoning,
    cacheRead,
    cacheWrite,
  });
}

/**
 * message.data.tokens → 已 split 的互不重叠分量
 * @param {any} tokens
 */
function partsFromMessageTokens(tokens) {
  if (!tokens || typeof tokens !== "object") {
    return { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 };
  }
  const cache =
    tokens.cache && typeof tokens.cache === "object" ? tokens.cache : {};
  return splitInclusiveUsage({
    input: Number(tokens.input) || 0,
    output: Number(tokens.output) || 0,
    reasoning: Number(tokens.reasoning) || 0,
    cacheRead: Number(cache.read) || 0,
    cacheWrite: Number(cache.write) || 0,
  });
}

/**
 * Newer ZCode builds write token rows into model_usage.
 * Older sessions (and many subagents) only embed tokens on message.data JSON:
 *   { role, modelID, tokens: { input, output, reasoning, cache: { read, write } }, cost }
 * Without the message fallback those sessions show up as zero-token "partial".
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {Set<string>} needIds session ids still missing token totals
 * @param {{ add?: Function }} [hourly]
 * @param {Set<string>} [hourlyFromUsage]
 * @returns {Map<string, {input:number,output:number,reasoning:number,cacheRead:number,cacheWrite:number,model?:string,count:number,cost?:number}>}
 */
function usageFromMessages(db, needIds, hourly, hourlyFromUsage) {
  /** @type {Map<string, {input:number,output:number,reasoning:number,cacheRead:number,cacheWrite:number,model?:string,count:number,cost:number}>} */
  const usage = new Map();
  if (needIds.size === 0) return usage;

  let rows;
  try {
    // Prefer only sessions we still need — but SQLite bind list for large sets is awkward.
    // Full scan of message table is fine (a few thousand rows).
    rows = db.prepare(`SELECT session_id, data FROM message`).all();
  } catch (err) {
    console.error("[zcode] message fallback failed", err);
    return usage;
  }

  for (const row of rows) {
    const sid = String(row.session_id);
    if (!needIds.has(sid)) continue;
    let data;
    try {
      data = typeof row.data === "string" ? JSON.parse(row.data) : row.data;
    } catch {
      continue;
    }
    if (!data || typeof data !== "object") continue;
    const tokens = data.tokens;
    if (!tokens || typeof tokens !== "object") continue;

    const parts = partsFromMessageTokens(tokens);
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

    const cur = usage.get(sid) || {
      input: 0,
      output: 0,
      reasoning: 0,
      cacheRead: 0,
      cacheWrite: 0,
      count: 0,
      cost: 0,
    };
    cur.input += parts.input;
    cur.output += parts.output;
    cur.reasoning += parts.reasoning;
    cur.cacheRead += parts.cacheRead;
    cur.cacheWrite += parts.cacheWrite;
    cur.count += 1;
    if (data.cost != null) cur.cost += Number(data.cost) || 0;
    const model =
      data.modelID || data.modelId || data.model || data.model_id || undefined;
    if (model) cur.model = String(model);
    usage.set(sid, cur);

    const ts =
      data.time?.completed ||
      data.time?.created ||
      undefined;
    const durationMs = durationFromRange(data.time?.created, data.time?.completed);
    if (hourly?.add && ts) {
      hourly.add(id, ts, {
        inputTokens: parts.input,
        outputTokens: parts.output,
        reasoningTokens: parts.reasoning,
        cacheReadTokens: parts.cacheRead,
        cacheWriteTokens: parts.cacheWrite,
        model: model ? String(model) : undefined,
        sessionId: sid,
        requestCount: 1,
        singleRequest: true,
        durationMs: durationMs || undefined,
      });
      hourlyFromUsage?.add(sid);
    }
  }

  // session_entry runtime/model_selection as model fallback
  try {
    for (const row of db
      .prepare(
        `SELECT session_id, data FROM session_entry WHERE type = 'runtime/model_selection'`
      )
      .all()) {
      const sid = String(row.session_id);
      const u = usage.get(sid);
      if (!u || u.model) continue;
      try {
        const data = typeof row.data === "string" ? JSON.parse(row.data) : row.data;
        const model = data?.modelId || data?.modelID || data?.model;
        if (model) u.model = String(model);
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* table may not exist on very old DBs */
  }

  return usage;
}

/**
 * @param {{ hourly?: { add: Function } }} [ctx]
 */
export function scan(ctx = {}) {
  const dbPath = agentPaths().zcodeDb;
  if (!fs.existsSync(dbPath)) return [];

  const hourly = ctx.hourly;
  const scannedAt = new Date().toISOString();
  /** @type {import('../types.js').SessionRecord[]} */
  const out = [];

  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
  } catch (err) {
    console.error("[zcode] open db failed", err);
    return [];
  }

  try {
    /** @type {Map<string, any>} */
    const sessions = new Map();
    for (const row of db
      .prepare(
        `SELECT id, parent_id, directory, title, time_created, time_updated FROM session`
      )
      .all()) {
      sessions.set(String(row.id), row);
    }

    /** @type {Map<string, {input:number,output:number,reasoning:number,cacheRead:number,cacheWrite:number,model?:string,count:number,cost?:number}>} */
    const usage = new Map();
    /** @type {Set<string>} */
    const hourlyFromUsage = new Set();
    try {
      // 按条 split 再汇总（不能对「含 cache 的 input」先 SUM 再 split）
      const detailRows = db
        .prepare(
          `SELECT session_id, model_id, input_tokens, output_tokens, reasoning_tokens,
                  cache_read_input_tokens, cache_creation_input_tokens,
                  started_at, completed_at, raw_usage_json
           FROM model_usage`
        )
        .all();

      for (const row of detailRows) {
        const parts = partsFromUsageRow(row);
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
        const sid = String(row.session_id);
        const cur = usage.get(sid) || {
          input: 0,
          output: 0,
          reasoning: 0,
          cacheRead: 0,
          cacheWrite: 0,
          count: 0,
        };
        cur.input += parts.input;
        cur.output += parts.output;
        cur.reasoning += parts.reasoning;
        cur.cacheRead += parts.cacheRead;
        cur.cacheWrite += parts.cacheWrite;
        cur.count += 1;
        if (!cur.model && row.model_id) cur.model = row.model_id;
        usage.set(sid, cur);

        if (hourly?.add) {
          const ts = row.completed_at || row.started_at;
          if (ts) {
            hourly.add(id, ts, {
              inputTokens: parts.input,
              outputTokens: parts.output,
              reasoningTokens: parts.reasoning,
              cacheReadTokens: parts.cacheRead,
              cacheWriteTokens: parts.cacheWrite,
              model: row.model_id || undefined,
              sessionId: sid,
              requestCount: 1,
              durationMs:
                durationFromRange(row.started_at, row.completed_at) ||
                undefined,
            });
            hourlyFromUsage.add(sid);
          }
        }
      }
    } catch (err) {
      console.error("[zcode] model_usage query failed", err);
    }

    // Fallback: sessions with chat history but no model_usage rows (older ZCode)
    const needFallback = new Set();
    for (const sid of sessions.keys()) {
      const u = usage.get(sid);
      const total = u
        ? u.input + u.output + u.reasoning + u.cacheRead + u.cacheWrite
        : 0;
      if (!u || total === 0) needFallback.add(sid);
    }
    const fromMsg = usageFromMessages(db, needFallback, hourly, hourlyFromUsage);
    for (const [sid, u] of fromMsg) {
      usage.set(sid, u);
    }

    const allIds = new Set([...sessions.keys(), ...usage.keys()]);
    for (const sid of allIds) {
      const meta = sessions.get(sid) || {};
      const u = usage.get(sid) || {
        input: 0,
        output: 0,
        reasoning: 0,
        cacheRead: 0,
        cacheWrite: 0,
        count: 0,
      };
      const hasTokens =
        u.input + u.output + u.reasoning + u.cacheRead + u.cacheWrite > 0;
      const parentId =
        meta.parent_id != null && String(meta.parent_id).trim() !== ""
          ? String(meta.parent_id)
          : undefined;
      const isSub =
        !!parentId ||
        String(sid).includes("subagent") ||
        (meta.title && /subagent/i.test(String(meta.title)));

      // 无 model_usage 明细时：整会话落在 lastUsedAt（兜底）
      if (hourly?.add && hasTokens && !hourlyFromUsage.has(sid)) {
        const ts = meta.time_updated || meta.time_created;
        if (ts) {
          hourly.add(id, ts, {
            inputTokens: u.input,
            outputTokens: u.output,
            reasoningTokens: u.reasoning,
            cacheReadTokens: u.cacheRead,
            cacheWriteTokens: u.cacheWrite,
            model: u.model,
            sessionId: sid,
            singleRequest: false,
          });
        }
      }

      out.push(
        makeSession({
          client: id,
          sessionId: sid,
          title: meta.title || undefined,
          cwd: meta.directory || undefined,
          model: u.model,
          startedAt: toIso(meta.time_created),
          lastUsedAt: toIso(meta.time_updated),
          messageCount: u.count || undefined,
          turnCount: u.count || undefined,
          requestCount: u.count || undefined,
          inputTokens: u.input,
          outputTokens: u.output,
          reasoningTokens: u.reasoning,
          cacheReadTokens: u.cacheRead,
          cacheWriteTokens: u.cacheWrite,
          costUsd: u.cost && u.cost > 0 ? u.cost : undefined,
          quality: hasTokens ? "full" : "partial",
          parentSessionId: parentId,
          isSubagent: isSub || undefined,
          // 子会话名从 model_usage.agent 取（Explore 等）；勿写死 "subagent"
          agentName: (() => {
            if (!isSub) {
              // 主会话：取最常见 mode（plan/build/yolo）
              try {
                const top = db
                  .prepare(
                    `SELECT mode, COUNT(*) AS c FROM model_usage
                     WHERE session_id = ? AND mode IS NOT NULL AND mode != ''
                     GROUP BY mode ORDER BY c DESC LIMIT 1`
                  )
                  .get(sid);
                if (top?.mode) return String(top.mode);
              } catch {
                /* ignore */
              }
              return undefined;
            }
            try {
              return resolveZcodeAgentName(db, sid, meta) || undefined;
            } catch {
              return undefined;
            }
          })(),
          scannedAt,
        })
      );
    }
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
 * ZCode model_usage / message 上的角色标签：
 * - 子 agent：agent 字段（zcode-Explore → Explore）
 * - 主会话：优先 mode（plan / build / yolo），避免全是 zcode-agent
 * @param {{ agent?: any, mode?: any, task_type?: any }} row
 * @returns {string | undefined}
 */
function labelFromUsageRow(row) {
  if (!row) return undefined;
  const task = row.task_type != null ? String(row.task_type) : "";
  const mode = row.mode != null ? String(row.mode).trim() : "";
  let agent = row.agent != null ? String(row.agent).trim() : "";
  if (agent) agent = agent.replace(/^zcode-?/i, "");
  const isSub =
    task === "subagent_child" ||
    /subagent/i.test(task) ||
    /^explore$/i.test(agent) ||
    /general-?purpose/i.test(agent);

  if (isSub) {
    if (agent && !/^agent$/i.test(agent)) return agent;
    return undefined; // 让上层标「子」即可
  }
  // 主：plan/build/yolo 比 zcode-agent 更有用
  if (mode) return mode;
  if (agent && !/^agent$/i.test(agent)) return agent;
  return undefined;
}

/**
 * 从 model_usage 取该会话最常见 agent 标签（子会话命名用）
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} sessionId
 */
function dominantAgentLabel(db, sessionId) {
  try {
    const rows = db
      .prepare(
        `SELECT agent, mode, task_type, COUNT(*) AS c
         FROM model_usage WHERE session_id = ?
         GROUP BY agent, mode, task_type
         ORDER BY c DESC LIMIT 5`
      )
      .all(sessionId);
    for (const r of rows) {
      const lab = labelFromUsageRow(r);
      if (lab) return lab;
    }
  } catch {
    /* no model_usage */
  }
  return undefined;
}

/**
 * Turn 明细：优先 model_usage 表；否则 message.data.tokens
 * @param {string} sessionId
 */
export function getDetail(sessionId) {
  const dbPath = agentPaths().zcodeDb;
  if (!fs.existsSync(dbPath)) return null;

  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
  } catch {
    return null;
  }

  try {
    let title;
    let taskType;
    try {
      const meta = db
        .prepare(`SELECT title, task_type FROM session WHERE id = ?`)
        .get(sessionId);
      title = meta?.title || undefined;
      taskType = meta?.task_type != null ? String(meta.task_type) : undefined;
    } catch {
      try {
        const meta = db
          .prepare(`SELECT title FROM session WHERE id = ?`)
          .get(sessionId);
        title = meta?.title || undefined;
      } catch {
        /* ignore */
      }
    }

    /** @type {any[]} */
    const turns = [];
    /** @type {Map<string, { model: string, turns: number, input: number, output: number, cacheRead: number, cacheWrite: number, reasoning: number }>} */
    const byModel = new Map();
    /** @type {Map<string, { agent: string, turns: number, input: number, output: number, cacheRead: number, cacheWrite: number, reasoning: number }>} */
    const byAgent = new Map();

    const bumpAgent = (agentName, parts) => {
      if (!agentName) return;
      const ag = byAgent.get(agentName) || {
        agent: agentName,
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
      byAgent.set(agentName, ag);
    };

    let rows = [];
    try {
      rows = db
        .prepare(
          `SELECT model_id, provider_id, input_tokens, output_tokens, reasoning_tokens,
                  cache_read_input_tokens, cache_creation_input_tokens,
                  started_at, completed_at, status, raw_usage_json,
                  agent, mode, task_type
           FROM model_usage
           WHERE session_id = ?
           ORDER BY COALESCE(completed_at, started_at, 0) ASC`
        )
        .all(sessionId);
    } catch {
      // 旧库可能无 agent/mode 列
      try {
        rows = db
          .prepare(
            `SELECT model_id, provider_id, input_tokens, output_tokens, reasoning_tokens,
                    cache_read_input_tokens, cache_creation_input_tokens,
                    started_at, completed_at, status, raw_usage_json
             FROM model_usage
             WHERE session_id = ?
             ORDER BY COALESCE(completed_at, started_at, 0) ASC`
          )
          .all(sessionId);
      } catch {
        rows = [];
      }
    }

    if (rows.length > 0) {
      let i = 0;
      for (const row of rows) {
        const parts = partsFromUsageRow(row);
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
        const model = row.model_id
          ? String(row.model_id)
          : row.provider_id
            ? String(row.provider_id)
            : "(unknown)";
        const agentName = labelFromUsageRow(row);
        i += 1;
        turns.push({
          index: i,
          ts: toIso(row.completed_at || row.started_at),
          model,
          agentName,
          inputTokens: parts.input,
          outputTokens: parts.output,
          cacheReadTokens: parts.cacheRead,
          cacheWriteTokens: parts.cacheWrite,
          reasoningTokens: parts.reasoning,
          durationMs:
            durationFromRange(row.started_at, row.completed_at) || undefined,
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
        if (agentName) bumpAgent(agentName, parts);
      }
    } else {
      // message fallback
      let msgs = [];
      try {
        msgs = db
          .prepare(`SELECT data FROM message WHERE session_id = ?`)
          .all(sessionId);
      } catch {
        msgs = [];
      }
      let i = 0;
      for (const row of msgs) {
        let data;
        try {
          data = typeof row.data === "string" ? JSON.parse(row.data) : row.data;
        } catch {
          continue;
        }
        const tokens = data?.tokens;
        if (!tokens || typeof tokens !== "object") continue;
        const parts = partsFromMessageTokens(tokens);
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
        const model = String(
          data.modelID || data.modelId || data.model || "(unknown)"
        );
        const agentName = labelFromUsageRow({
          agent: data.agent || data.agentName,
          mode: data.mode,
          task_type: data.task_type || data.taskType || taskType,
        });
        i += 1;
        turns.push({
          index: i,
          ts: undefined,
          model,
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
        if (agentName) bumpAgent(agentName, parts);
      }
    }

    const sessionAgent =
      dominantAgentLabel(db, sessionId) ||
      (byAgent.size === 1 ? [...byAgent.keys()][0] : undefined);

    return {
      client: id,
      sessionId,
      title,
      agentName: sessionAgent,
      turns,
      models: [...byModel.values()],
      agents: [...byAgent.values()],
    };
  } finally {
    try {
      db.close();
    } catch {
      /* ignore */
    }
  }
}

/**
 * 子会话展示名：优先 model_usage 的 agent，否则不硬编码 "subagent"
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} sessionId
 * @param {{ title?: string, task_type?: string } | null} meta
 */
export function resolveZcodeAgentName(db, sessionId, meta) {
  const fromUsage = dominantAgentLabel(db, sessionId);
  if (fromUsage) return fromUsage;
  const title = meta?.title ? String(meta.title) : "";
  // 标题里偶发 @Explore / Explore subagent
  const m = title.match(
    /@?\b(explore|general-purpose|general_purpose|plan|build)\b/i
  );
  if (m) return m[1].replace(/_/g, "-");
  return undefined;
}
