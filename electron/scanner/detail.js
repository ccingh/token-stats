/**
 * 会话明细：turn/loop 级用量 + 模型轨迹（全客户端）
 */
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import * as claude from "./adapters/claude.js";
import * as kimi from "./adapters/kimi.js";
import * as zcode from "./adapters/zcode.js";
import * as opencode from "./adapters/opencode.js";
import * as pi from "./adapters/pi.js";
import * as reasonix from "./adapters/reasonix.js";
import * as grok from "./adapters/grok.js";
import * as mimocode from "./adapters/mimocode.js";
import * as codex from "./adapters/codex.js";
import * as dsh from "./adapters/dsh.js";
import { agentPaths } from "./paths.js";
import { toIso } from "./types.js";
import { normalizeAgentName } from "./agentLabel.js";

/**
 * @param {string} sessionId
 */
async function grokDetail(sessionId) {
  const logPath = agentPaths().grokUnifiedLog;
  /** @type {any[]} */
  const turns = [];
  /** @type {Map<string, any>} */
  const byModel = new Map();

  const dir = grok.findSessionDir(sessionId);
  let summary = null;
  if (dir) {
    try {
      summary = JSON.parse(
        fs.readFileSync(path.join(dir, "summary.json"), "utf8")
      );
    } catch {
      summary = null;
    }
  }
  // current_model_id 只是「当前」模型，不能拿来盖历史 turn
  const sessionFallbackModel = grok.normalizeGrokModel(
    summary?.current_model_id
  );
  const sessionAgent = normalizeAgentName(summary?.agent_name);

  /**
   * @param {{
   *   ts?: string,
   *   model?: string,
   *   inputTokens: number,
   *   outputTokens: number,
   *   cacheReadTokens: number,
   *   reasoningTokens: number,
   *   loopIndex?: number,
   * }} row
   */
  const pushTurn = (row) => {
    const model = row.model || undefined;
    const key = model || "未知模型";
    turns.push({
      index: turns.length + 1,
      ts: row.ts,
      model,
      agentName: sessionAgent,
      inputTokens: row.inputTokens,
      outputTokens: row.outputTokens,
      cacheReadTokens: row.cacheReadTokens,
      cacheWriteTokens: 0,
      reasoningTokens: row.reasoningTokens,
      loopIndex: row.loopIndex,
    });
    const cur = byModel.get(key) || {
      model: key,
      turns: 0,
      input: 0,
      output: 0,
      cacheRead: 0,
      reasoning: 0,
    };
    cur.turns += 1;
    cur.input += row.inputTokens;
    cur.output += row.outputTokens;
    cur.cacheRead += row.cacheReadTokens;
    cur.reasoning += row.reasoningTokens;
    byModel.set(key, cur);
  };

  // 优先 updates.jsonl：每 turn 自带 modelUsage，切模型后历史仍正确
  if (dir) {
    try {
      const { events } = await grok.loadGrokTurnEvents(dir);
      for (const ev of events) {
        pushTurn({
          ts: toIso(ev.ts) || undefined,
          model: ev.model,
          inputTokens: ev.input,
          outputTokens: ev.output,
          cacheReadTokens: ev.cacheRead,
          reasoningTokens: ev.reasoning,
        });
      }
    } catch (err) {
      console.error("[grok] detail updates failed", sessionId, err);
    }
  }

  // 没有 turn_completed 时才退回 unified；有模型字段用字段，否则才用当前模型
  if (turns.length === 0 && fs.existsSync(logPath)) {
    const rl = readline.createInterface({
      input: fs.createReadStream(logPath, { encoding: "utf8" }),
      crlfDelay: Infinity,
    });
    for await (const line of rl) {
      if (!line.includes(sessionId) || !line.includes("inference_done")) continue;
      let obj;
      try {
        obj = JSON.parse(line);
      } catch {
        continue;
      }
      if (obj.sid !== sessionId) continue;
      const ctx = obj.ctx || {};
      const prompt = Number(ctx.prompt_tokens) || 0;
      const cached = Number(ctx.cached_prompt_tokens) || 0;
      const completion = Number(ctx.completion_tokens) || 0;
      const reasoning = Number(ctx.reasoning_tokens) || 0;
      const uncached = cached > 0 && cached <= prompt ? prompt - cached : prompt;
      const out =
        reasoning > 0 && reasoning <= completion ? completion - reasoning : completion;
      pushTurn({
        ts: toIso(obj.ts) || undefined,
        model:
          grok.normalizeGrokModel(
            ctx.model || ctx.model_id || obj.model || obj.model_id
          ) || sessionFallbackModel,
        inputTokens: uncached,
        outputTokens: out,
        cacheReadTokens: cached,
        reasoningTokens: reasoning,
        loopIndex: ctx.loop_index != null ? Number(ctx.loop_index) : undefined,
      });
    }
  }

  return {
    client: "grok",
    sessionId,
    title: summary?.generated_title || summary?.session_summary,
    agentName: sessionAgent || normalizeAgentName(summary?.agent_name),
    sessionKind: summary?.session_kind,
    turns,
    models: [...byModel.values()],
    meta: {
      numMessages: summary?.num_messages,
      nextTraceTurn: summary?.next_trace_turn,
      createdAt: summary?.created_at,
      lastActiveAt: summary?.last_active_at || summary?.updated_at,
    },
  };
}

/**
 * 发现某会话的子 session id（适配器侧）。
 * @param {string} client
 * @param {string} sessionId
 * @returns {Promise<{ id: string, agentName?: string }[]>}
 */
async function discoverChildren(client, sessionId) {
  /** @type {{ id: string, agentName?: string }[]} */
  const out = [];

  if (client === "codex") {
    try {
      return codex.listChildren(sessionId);
    } catch {
      return out;
    }
  }

  if (client === "dsh") {
    try {
      return dsh.listChildren(sessionId);
    } catch {
      return out;
    }
  }

  if (client === "opencode" || client === "zcode" || client === "mimocode") {
    try {
      const { DatabaseSync } = await import("node:sqlite");
      const dbPath =
        client === "opencode"
          ? agentPaths().opencodeDb
          : client === "mimocode"
            ? agentPaths().mimocodeDb
            : agentPaths().zcodeDb;
      if (!fs.existsSync(dbPath)) return out;
      let db;
      try {
        db = new DatabaseSync(dbPath, { readOnly: true });
      } catch {
        try {
          db = new DatabaseSync(`file:${dbPath}?mode=ro`, { readOnly: true });
        } catch {
          return out;
        }
      }
      try {
        /** @type {Map<string, { id: string, agentName?: string }>} */
        const childMap = new Map();
        const collect = (rows) => {
          for (const r of rows || []) {
            if (!r?.id) continue;
            const id = String(r.id);
            if (childMap.has(id)) continue;
            let agentName = r.agent ? String(r.agent) : undefined;
            // ZCode session 表无 agent 列：从 model_usage 取
            if (!agentName && client === "zcode") {
              try {
                agentName = zcode.resolveZcodeAgentName(db, id, r) || undefined;
              } catch {
                agentName = undefined;
              }
            }
            // 不要用长 title 当 agentName（会很丑）
            childMap.set(id, { id, agentName });
          }
        };
        try {
          // session 可能无 agent 列
          collect(
            db
              .prepare(
                `SELECT id, title, parent_id FROM session WHERE parent_id = ? OR parent_id = ?`
              )
              .all(sessionId, String(sessionId))
          );
        } catch {
          try {
            collect(
              db
                .prepare(
                  `SELECT id, title, agent, parent_id FROM session WHERE parent_id = ? OR parent_id = ?`
                )
                .all(sessionId, String(sessionId))
            );
          } catch {
            /* schema */
          }
        }
        try {
          const hasV2 = db
            .prepare(
              `SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name='session_v2' LIMIT 1`
            )
            .get();
          if (hasV2) {
            collect(
              db
                .prepare(
                  `SELECT id, title, agent FROM session_v2 WHERE parent_id = ? OR parent_id = ?`
                )
                .all(sessionId, String(sessionId))
            );
          }
        } catch {
          /* ignore */
        }
        for (const c of childMap.values()) out.push(c);
      } catch {
        /* schema 差异 */
      } finally {
        try {
          db.close();
        } catch {
          /* ignore */
        }
      }
    } catch {
      /* no sqlite */
    }
    return out;
  }

  if (client === "claude") {
    const root = agentPaths().claudeProjects;
    if (!fs.existsSync(root)) return out;
    const walk = (d) => {
      let entries;
      try {
        entries = fs.readdirSync(d, { withFileTypes: true });
      } catch {
        return;
      }
      for (const ent of entries) {
        const full = path.join(d, ent.name);
        if (ent.isDirectory()) {
          if (ent.name === "subagents") {
            // parent folder name is sessionId
            const parentDir = path.basename(d);
            if (parentDir === sessionId) {
              let agents;
              try {
                agents = fs.readdirSync(full, { withFileTypes: true });
              } catch {
                continue;
              }
              for (const a of agents) {
                if (a.isFile() && a.name.endsWith(".jsonl")) {
                  const id = a.name.replace(/\.jsonl$/, "");
                  // 优先旁路 meta.json 的 agentType（Explore/Plan），与 Tokscale 一致
                  let agentName;
                  const metaPath = path.join(full, `${id}.meta.json`);
                  if (fs.existsSync(metaPath)) {
                    try {
                      const meta = JSON.parse(
                        fs.readFileSync(metaPath, "utf8")
                      );
                      const t = meta?.agentType || meta?.agent_type;
                      if (t) {
                        agentName =
                          normalizeAgentName(t) ||
                          (/^explore$/i.test(String(t))
                            ? "Explore"
                            : /^plan$/i.test(String(t))
                              ? "Plan"
                              : String(t));
                      }
                    } catch {
                      /* ignore */
                    }
                  }
                  out.push({ id, agentName });
                } else if (a.isDirectory()) {
                  const sid = a.name;
                  out.push({
                    id: sid,
                    agentName: normalizeAgentName(sid) || undefined,
                  });
                }
              }
            }
          }
          walk(full);
        }
      }
    };
    walk(root);
    return out;
  }

  if (client === "grok") {
    const sessionsRoot = agentPaths().grokSessions;
    if (!fs.existsSync(sessionsRoot)) return out;
    const findParentDir = (d, depth = 0) => {
      if (depth > 8) return null;
      let entries;
      try {
        entries = fs.readdirSync(d, { withFileTypes: true });
      } catch {
        return null;
      }
      for (const e of entries) {
        if (!e.isDirectory()) continue;
        if (e.name === sessionId) return path.join(d, e.name);
        const hit = findParentDir(path.join(d, e.name), depth + 1);
        if (hit) return hit;
      }
      return null;
    };
    const parentDir = findParentDir(sessionsRoot);
    if (parentDir) {
      const sub = path.join(parentDir, "subagents");
      if (fs.existsSync(sub)) {
        let entries;
        try {
          entries = fs.readdirSync(sub, { withFileTypes: true });
        } catch {
          entries = [];
        }
        for (const e of entries) {
          if (!e.isDirectory()) continue;
          /** @type {string | undefined} */
          let childAgent;
          const sp = path.join(sub, e.name, "summary.json");
          if (fs.existsSync(sp)) {
            try {
              const s = JSON.parse(fs.readFileSync(sp, "utf8"));
              childAgent = normalizeAgentName(s.agent_name) || undefined;
            } catch {
              /* ignore */
            }
          }
          out.push({ id: e.name, agentName: childAgent });
        }
      }
    }
    return out;
  }

  return out;
}

/**
 * @param {string} sessionId
 */
function guessAgentLabel(sessionId) {
  const s = String(sessionId || "");
  if (/explore/i.test(s)) return "Explore";
  if (/general/i.test(s)) return "general-purpose";
  // 纯 subagent id 不硬编码名字 → undefined，UI 只显示「子」
  if (/subagent/i.test(s) && !/explore|general|plan|build/i.test(s)) {
    return undefined;
  }
  if (s.includes("__")) {
    const tail = s.split("__").pop();
    if (tail && tail.length < 40) return normalizeAgentName(tail) || tail;
  }
  return normalizeAgentName(s) || undefined;
}

/**
 * 把子会话 turns 并入父明细，并打 isSubagent 标记。
 * @param {any} detail
 * @param {string} client
 * @param {{ id: string, agentName?: string }[]} children
 */
async function mergeChildTurnDetails(detail, client, children) {
  if (!children?.length) return;
  if (!detail.turns) detail.turns = [];

  const seenSources = new Set(
    detail.turns
      .map((t) => t.sourceSessionId)
      .filter(Boolean)
  );

  for (const child of children) {
    const childId = child.id;
    if (!childId || childId === detail.sessionId) continue;
    if (seenSources.has(childId)) continue;

    /** @type {any} */
    let childDetail = null;
    try {
      switch (client) {
        case "grok":
          childDetail = await grokDetail(childId);
          break;
        case "claude":
          childDetail = await claude.getDetail(childId);
          break;
        case "zcode":
          childDetail = zcode.getDetail(childId);
          break;
        case "opencode":
          childDetail = opencode.getDetail(childId);
          break;
        case "pi":
          childDetail = await pi.getDetail(childId);
          break;
        case "reasonix":
          childDetail = await reasonix.sessionDetail(childId);
          break;
        case "mimocode":
          childDetail = mimocode.getDetail(childId);
          break;
        case "codex":
          childDetail = codex.getDetail(childId);
          break;
        case "dsh":
          childDetail = dsh.getDetail(childId);
          break;
        case "kimi":
          // kimi 子 agent 在同一 session 目录的 wire 里，不单独 merge
          childDetail = null;
          break;
        default:
          childDetail = null;
      }
    } catch {
      childDetail = null;
    }
    if (!childDetail?.turns?.length) continue;

    const childLabel = normalizeAgentName(
      child.agentName || childDetail.agentName
    );

    for (const t of childDetail.turns) {
      // 子详情若已是「再嵌套」的合并结果，保留其 isSubagent；否则标为子
      // 无名字时 agentName 留空，UI 只显示「子」一次
      const turnAgent = normalizeAgentName(t.agentName) || childLabel;
      detail.turns.push({
        ...t,
        isSubagent: true,
        agentName: turnAgent || undefined,
        sourceSessionId: t.sourceSessionId || childId,
      });
    }
    seenSources.add(childId);
  }
}

/**
 * 按时间排序并重编号；重建 models / agents 汇总。
 * @param {any} detail
 */
function finalizeDetailTurns(detail) {
  const turns = detail.turns || [];
  turns.sort((a, b) => {
    const ta = a.ts || "";
    const tb = b.ts || "";
    if (ta && tb && ta !== tb) return ta.localeCompare(tb);
    if (ta && !tb) return -1;
    if (!ta && tb) return 1;
    return (a.index || 0) - (b.index || 0);
  });
  turns.forEach((t, i) => {
    t.index = i + 1;
  });
  detail.turns = turns;

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
    cur.input += Number(t.inputTokens) || 0;
    cur.output += Number(t.outputTokens) || 0;
    cur.cacheRead += Number(t.cacheReadTokens) || 0;
    cur.cacheWrite += Number(t.cacheWriteTokens) || 0;
    cur.reasoning += Number(t.reasoningTokens) || 0;
    byModel.set(model, cur);

    // 规范化 agent 名；无名字时主→main、子→子（UI 只显示一次）
    const cleaned = normalizeAgentName(t.agentName);
    if (cleaned && cleaned !== t.agentName) t.agentName = cleaned;
    else if (!cleaned && t.agentName) t.agentName = undefined;
    const agent = cleaned || (t.isSubagent ? "子" : "main");
    const ag = byAgent.get(agent) || {
      agent,
      turns: 0,
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      reasoning: 0,
      isSubagent: !!t.isSubagent,
    };
    ag.turns += 1;
    ag.input += Number(t.inputTokens) || 0;
    ag.output += Number(t.outputTokens) || 0;
    ag.cacheRead += Number(t.cacheReadTokens) || 0;
    ag.cacheWrite += Number(t.cacheWriteTokens) || 0;
    ag.reasoning += Number(t.reasoningTokens) || 0;
    if (t.isSubagent) ag.isSubagent = true;
    byAgent.set(agent, ag);
  }
  detail.models = [...byModel.values()];
  // 有明确 agent 名时优先展示；全是 main 且只有 1 行时也展示
  const agentList = [...byAgent.values()].sort(
    (a, b) => b.input + b.output + b.cacheRead - (a.input + a.output + a.cacheRead)
  );
  detail.agents = agentList;
}

/**
 * @param {{ client: string, sessionId: string, mergedChildren?: string[] }} opts
 */
export async function getSessionDetail(opts) {
  const client = String(opts.client || "").toLowerCase();
  const sessionId = String(opts.sessionId || "");
  if (!client || !sessionId) throw new Error("缺少 client 或 sessionId");

  /** @type {any} */
  let detail = null;

  switch (client) {
    case "grok":
      detail = await grokDetail(sessionId);
      break;
    case "claude":
      detail = await claude.getDetail(sessionId);
      break;
    case "kimi":
      detail = await kimi.getDetail(sessionId);
      break;
    case "zcode":
      detail = zcode.getDetail(sessionId);
      break;
    case "opencode":
      detail = opencode.getDetail(sessionId);
      break;
    case "pi":
      detail = await pi.getDetail(sessionId);
      break;
    case "reasonix":
      detail = await reasonix.sessionDetail(sessionId, {
        mergedChildren: opts.mergedChildren,
      });
      break;
    case "mimocode":
      detail = mimocode.getDetail(sessionId);
      break;
    case "codex":
      detail = codex.getDetail(sessionId);
      break;
    case "dsh":
      detail = dsh.getDetail(sessionId);
      break;
    default:
      throw new Error(`未知客户端：${client}`);
  }

  if (!detail) {
    // 父已删时仍可能靠子 turns 拼明细
    detail = {
      client,
      sessionId,
      turns: [],
      models: [],
      note: "父会话源日志未找到，尝试仅加载子会话 turn…",
    };
  }

  if (!detail.turns) detail.turns = [];
  if (!detail.models) detail.models = [];

  // 主会话 turns 默认非 sub（除非适配器已标）
  for (const t of detail.turns) {
    if (t.isSubagent == null) t.isSubagent = false;
    if (!t.sourceSessionId && !t.isSubagent) t.sourceSessionId = sessionId;
  }

  // 需要并入子 turns 的客户端（kimi / pi 在 adapter 内已含并标好）
  const childrenIncluded = detail.childrenIncluded === true;

  if (!childrenIncluded) {
    /** @type {Map<string, { id: string, agentName?: string }>} */
    const childMap = new Map();
    const discovered = await discoverChildren(client, sessionId);
    for (const c of discovered) childMap.set(c.id, c);
    if (Array.isArray(opts.mergedChildren)) {
      for (const id of opts.mergedChildren) {
        if (!id || childMap.has(id)) continue;
        childMap.set(id, { id: String(id) });
      }
    }
    await mergeChildTurnDetails(detail, client, [...childMap.values()]);
  }

  finalizeDetailTurns(detail);

  const subTurns = detail.turns.filter((t) => t.isSubagent).length;
  if (subTurns > 0) {
    detail.childTurnCount = subTurns;
    detail.parentTurnCount = detail.turns.length - subTurns;
  }

  if (detail.turns.length === 0 && !detail.note) {
    detail.note = "没有找到 turn 级用量记录（会话可能未调用模型，或日志已清理）";
  } else if (
    detail.note &&
    detail.note.startsWith("父会话源日志未找到") &&
    detail.turns.length > 0
  ) {
    detail.note = `父会话源日志未找到；已加载 ${detail.turns.length} 条子会话 turn`;
  }

  return detail;
}
