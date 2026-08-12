import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { agentPaths } from "../paths.js";
import { makeSession, toIso } from "../types.js";

export const id = "pi";
export const displayName = "Pi (OMP)";

export function detect() {
  return fs.existsSync(agentPaths().piSessions);
}

/**
 * 列出主会话 + 嵌套子 agent 日志。
 * 主: <workspace>/<timestamp>_<sessionId>.jsonl
 * 子: <workspace>/<timestamp>_<sessionId>/<SubAgentName>.jsonl
 * @param {string} root
 * @returns {{ file: string, sessionId: string, parentSessionId?: string, isSubagent: boolean, agentName?: string }[]}
 */
function listSessionFiles(root) {
  /** @type {{ file: string, sessionId: string, parentSessionId?: string, isSubagent: boolean, agentName?: string }[]} */
  const items = [];
  if (!fs.existsSync(root)) return items;

  let workspaces;
  try {
    workspaces = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return items;
  }

  for (const ws of workspaces) {
    if (!ws.isDirectory()) continue;
    const wsDir = path.join(root, ws.name);
    let entries;
    try {
      entries = fs.readdirSync(wsDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      if (ent.isFile() && ent.name.endsWith(".jsonl")) {
        const base = ent.name.slice(0, -".jsonl".length);
        const us = base.lastIndexOf("_");
        const sessionId = us > 0 ? base.slice(us + 1) : base;
        items.push({
          file: path.join(wsDir, ent.name),
          sessionId,
          isSubagent: false,
        });
      } else if (ent.isDirectory()) {
        // nested subagent folder named like timestamp_sessionId
        const folder = ent.name;
        const us = folder.lastIndexOf("_");
        const parentSessionId = us > 0 ? folder.slice(us + 1) : undefined;
        const nestedDir = path.join(wsDir, folder);
        let nested;
        try {
          nested = fs.readdirSync(nestedDir, { withFileTypes: true });
        } catch {
          continue;
        }
        for (const n of nested) {
          if (!n.isFile() || !n.name.endsWith(".jsonl")) continue;
          // skip local/* etc. only top-level jsonl in session folder
          const rawName = n.name.slice(0, -".jsonl".length);
          if (/^local$/i.test(rawName)) continue;
          items.push({
            file: path.join(nestedDir, n.name),
            sessionId: `${parentSessionId || folder}__${rawName}`,
            parentSessionId,
            isSubagent: true,
            // ExploreAtsInfra → Explore；保留可辨识的自定义名
            agentName: prettyPiAgentName(rawName),
          });
        }
      }
    }
  }
  return items;
}

/**
 * Pi 子 agent 文件名 / mode → 展示名
 * @param {string} raw
 */
function prettyPiAgentName(raw) {
  if (!raw) return undefined;
  const s = String(raw).trim();
  if (!s || /^local$/i.test(s)) return undefined;
  if (/^explore/i.test(s)) return "Explore";
  if (/^plan/i.test(s)) return "Plan";
  if (/^build/i.test(s)) return "Build";
  if (/^general/i.test(s)) return "general-purpose";
  return s;
}

/**
 * 从 jsonl 提取最后一次 mode_change（plan / none…）
 * @param {string} file
 * @returns {Promise<string | undefined>}
 */
async function peekModeFromFile(file) {
  if (!fs.existsSync(file)) return undefined;
  let last;
  try {
    const stream = fs.createReadStream(file, { encoding: "utf8" });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line.includes("mode_change")) continue;
      try {
        const o = JSON.parse(line);
        if (o.type === "mode_change" && o.mode != null) {
          last = String(o.mode);
        }
      } catch {
        /* ignore */
      }
    }
  } catch {
    return undefined;
  }
  if (!last || last === "none") return undefined;
  if (/plan/i.test(last)) return "Plan";
  if (/build/i.test(last)) return "Build";
  return prettyPiAgentName(last);
}

/**
 * Decode folder like --D--ly-- → D:/ly (best effort)
 * @param {string} name
 */
function decodeWorkspaceFolder(name) {
  // e.g. --E--Delphi-- or --E--iot-box-managerV2-box-manager--
  let s = name;
  if (s.startsWith("--") && s.endsWith("--")) {
    s = s.slice(2, -2);
  }
  if (/^[A-Za-z]--/.test(s)) {
    const drive = s[0];
    const rest = s.slice(3).replace(/-/g, path.sep);
    return `${drive}:${path.sep}${rest}`;
  }
  return name.replace(/-/g, path.sep);
}

/**
 * @param {string} file
 * @param {string} scannedAt
 * @param {{ sessionId: string, parentSessionId?: string, isSubagent: boolean, agentName?: string }} meta
 * @param {{ add?: Function }} [hourly]
 */
async function parseSessionFile(file, scannedAt, meta, hourly) {
  let sessionId = meta.sessionId;
  // workspace folder for cwd: parent of file, or grandparent for nested
  const parentFolder = meta.isSubagent
    ? path.basename(path.dirname(path.dirname(file)))
    : path.basename(path.dirname(file));

  let title = meta.isSubagent ? meta.agentName : undefined;
  let cwd = decodeWorkspaceFolder(parentFolder);
  let startedAt;
  let lastUsedAt;
  let model;
  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let reasoning = 0;
  let costUsd = 0;
  let messageCount = 0;
  /** @type {string | undefined} */
  let modeAgent = meta.isSubagent ? meta.agentName : undefined;

  const stream = fs.createReadStream(file, { encoding: "utf8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  for await (const line of rl) {
    if (!line.trim()) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }

    const type = obj.type;
    if (type === "session") {
      // 子 agent 文件里的 id 不要覆盖我们合成的 child id；但可用来校正 parent 路径 cwd
      if (!meta.isSubagent && obj.id) sessionId = String(obj.id);
      if (obj.cwd) cwd = obj.cwd;
      if (obj.timestamp) startedAt = toIso(obj.timestamp) || startedAt;
    } else if (type === "title" || type === "title_change") {
      if (obj.title) title = obj.title;
      if (obj.updatedAt) lastUsedAt = toIso(obj.updatedAt) || lastUsedAt;
      if (obj.timestamp) lastUsedAt = toIso(obj.timestamp) || lastUsedAt;
    } else if (type === "model_change" && obj.model) {
      model = typeof obj.model === "string" ? obj.model : obj.model?.id || model;
    } else if (type === "mode_change" && obj.mode != null && !meta.isSubagent) {
      const m = String(obj.mode);
      if (m && m !== "none") {
        if (/plan/i.test(m)) modeAgent = "Plan";
        else if (/build/i.test(m)) modeAgent = "Build";
        else modeAgent = prettyPiAgentName(m) || modeAgent;
      }
    }

    if (obj.timestamp) {
      const iso = toIso(obj.timestamp);
      if (iso) {
        if (!startedAt || iso < startedAt) startedAt = iso;
        if (!lastUsedAt || iso > lastUsedAt) lastUsedAt = iso;
      }
    }

    const msg = obj.message || {};
    const usage = msg.usage || obj.usage;
    if (usage && typeof usage === "object") {
      const inTok = Number(usage.input) || 0;
      const outTok = Number(usage.output) || 0;
      const cr = Number(usage.cacheRead) || 0;
      const cw = Number(usage.cacheWrite) || 0;
      const rt = Number(usage.reasoningTokens) || 0;
      if (inTok + outTok + cr + cw + rt > 0) {
        input += inTok;
        output += outTok;
        cacheRead += cr;
        cacheWrite += cw;
        reasoning += rt;
        messageCount += 1;
        if (usage.cost?.total != null) costUsd += Number(usage.cost.total) || 0;
        if (msg.model) model = msg.model;
        else if (obj.model) model = obj.model;
        if (hourly?.add && obj.timestamp) {
          hourly.add(id, obj.timestamp, {
            inputTokens: inTok,
            outputTokens: outTok,
            cacheReadTokens: cr,
            cacheWriteTokens: cw,
            reasoningTokens: rt,
            model: msg.model || obj.model || model || undefined,
          });
        }
      }
    }
  }

  const hasTokens = input + output + cacheRead + cacheWrite + reasoning > 0;
  return makeSession({
    client: id,
    sessionId,
    title,
    cwd,
    model,
    startedAt,
    lastUsedAt,
    messageCount: messageCount || undefined,
    turnCount: messageCount || undefined,
    requestCount: messageCount || undefined,
    inputTokens: input,
    outputTokens: output,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
    reasoningTokens: reasoning,
    costUsd: costUsd || undefined,
    quality: hasTokens ? "full" : "partial",
    parentSessionId: meta.parentSessionId,
    isSubagent: meta.isSubagent || undefined,
    agentName: modeAgent || meta.agentName,
    scannedAt,
  });
}

/**
 * @param {{ hourly?: { add: Function } }} [ctx]
 */
export async function scan(ctx = {}) {
  const root = agentPaths().piSessions;
  if (!fs.existsSync(root)) return [];

  const hourly = ctx.hourly;
  const scannedAt = new Date().toISOString();
  const files = listSessionFiles(root);
  /** @type {import('../types.js').SessionRecord[]} */
  const out = [];

  for (const item of files) {
    try {
      out.push(await parseSessionFile(item.file, scannedAt, item, hourly));
    } catch (err) {
      console.error("[pi] parse failed", item.file, err);
    }
  }
  return out;
}

/**
 * Turn 明细：session jsonl 中每条带 usage 的记录
 * @param {string} sessionId
 */
export async function getDetail(sessionId) {
  const root = agentPaths().piSessions;
  if (!fs.existsSync(root)) return null;

  const files = listSessionFiles(root);
  /** @type {string | null} */
  let target = null;
  // 主会话文件；子会话 id 形如 parent__AgentName
  const item =
    files.find((f) => f.sessionId === sessionId) ||
    files.find((f) => !f.isSubagent && (f.sessionId === sessionId || f.file.includes(sessionId)));
  if (item) target = item.file;

  // 父会话详情：合并所有子 agent 文件的 turns
  if (!target || (item && !item.isSubagent)) {
    const parentId = item?.sessionId || sessionId;
    const related = files.filter(
      (f) =>
        (!f.isSubagent && f.sessionId === parentId) ||
        (f.isSubagent && f.parentSessionId === parentId)
    );
    if (related.length > 0) {
      /** @type {any[]} */
      const turns = [];
      /** @type {Map<string, any>} */
      const byModel = new Map();
      let title;
      let i = 0;
      /** @type {string | undefined} */
      let sessionAgent;
      for (const rel of related) {
        const stream = fs.createReadStream(rel.file, { encoding: "utf8" });
        const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
        let currentModel;
        /** @type {string | undefined} */
        let currentModeAgent = rel.isSubagent ? rel.agentName : undefined;
        for await (const line of rl) {
          if (!line.trim()) continue;
          let obj;
          try {
            obj = JSON.parse(line);
          } catch {
            continue;
          }
          if (obj.type === "title" || obj.type === "title_change") {
            if (obj.title && !rel.isSubagent) title = obj.title;
          }
          if (obj.type === "model_change" && obj.model) {
            currentModel =
              typeof obj.model === "string" ? obj.model : obj.model?.id || currentModel;
          }
          // mode_change 无 usage，须在 continue 前处理
          if (!rel.isSubagent && obj.type === "mode_change" && obj.mode) {
            const m = String(obj.mode);
            if (m && m !== "none") {
              if (/plan/i.test(m)) currentModeAgent = "Plan";
              else if (/build/i.test(m)) currentModeAgent = "Build";
              else currentModeAgent = prettyPiAgentName(m) || currentModeAgent;
              sessionAgent = currentModeAgent || sessionAgent;
            }
          }
          const msg = obj.message || {};
          const usage = msg.usage || obj.usage;
          if (!usage || typeof usage !== "object") continue;
          const input = Number(usage.input) || 0;
          const output = Number(usage.output) || 0;
          const cacheRead = Number(usage.cacheRead) || 0;
          const cacheWrite = Number(usage.cacheWrite) || 0;
          const reasoning = Number(usage.reasoningTokens) || 0;
          if (input + output + cacheRead + cacheWrite + reasoning <= 0) continue;
          const model = String(msg.model || obj.model || currentModel || "(unknown)");
          i += 1;
          turns.push({
            index: i,
            ts: toIso(obj.timestamp),
            model,
            inputTokens: input,
            outputTokens: output,
            cacheReadTokens: cacheRead,
            cacheWriteTokens: cacheWrite,
            reasoningTokens: reasoning,
            isSubagent: !!rel.isSubagent,
            // 子：文件名；主：mode（Plan…）
            agentName: rel.isSubagent
              ? rel.agentName || undefined
              : currentModeAgent,
            sourceSessionId: rel.sessionId,
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
          cur.input += input;
          cur.output += output;
          cur.cacheRead += cacheRead;
          cur.cacheWrite += cacheWrite;
          cur.reasoning += reasoning;
          byModel.set(model, cur);
        }
      }
      return {
        client: id,
        sessionId: parentId,
        title,
        agentName: sessionAgent,
        turns,
        models: [...byModel.values()],
        childrenIncluded: true,
      };
    }
  }

  if (!target) return null;

  /** @type {any[]} */
  const turns = [];
  /** @type {Map<string, { model: string, turns: number, input: number, output: number, cacheRead: number, cacheWrite: number, reasoning: number }>} */
  const byModel = new Map();
  let title;
  let currentModel;
  /** @type {string | undefined} */
  let currentModeAgent =
    item && item.isSubagent ? item.agentName || undefined : undefined;

  const stream = fs.createReadStream(target, { encoding: "utf8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let i = 0;
  for await (const line of rl) {
    if (!line.trim()) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (obj.type === "title" || obj.type === "title_change") {
      if (obj.title) title = obj.title;
    }
    if (obj.type === "model_change" && obj.model) {
      currentModel =
        typeof obj.model === "string" ? obj.model : obj.model?.id || currentModel;
    }
    if (!(item && item.isSubagent) && obj.type === "mode_change" && obj.mode) {
      const m = String(obj.mode);
      if (m && m !== "none") {
        if (/plan/i.test(m)) currentModeAgent = "Plan";
        else if (/build/i.test(m)) currentModeAgent = "Build";
        else currentModeAgent = prettyPiAgentName(m) || currentModeAgent;
      }
    }
    const msg = obj.message || {};
    const usage = msg.usage || obj.usage;
    if (!usage || typeof usage !== "object") continue;
    const input = Number(usage.input) || 0;
    const output = Number(usage.output) || 0;
    const cacheRead = Number(usage.cacheRead) || 0;
    const cacheWrite = Number(usage.cacheWrite) || 0;
    const reasoning = Number(usage.reasoningTokens) || 0;
    if (input + output + cacheRead + cacheWrite + reasoning <= 0) continue;
    const model = String(msg.model || obj.model || currentModel || "(unknown)");
    i += 1;
    turns.push({
      index: i,
      ts: toIso(obj.timestamp),
      model,
      inputTokens: input,
      outputTokens: output,
      cacheReadTokens: cacheRead,
      cacheWriteTokens: cacheWrite,
      reasoningTokens: reasoning,
      isSubagent: !!(item && item.isSubagent),
      agentName:
        item && item.isSubagent
          ? item.agentName || undefined
          : currentModeAgent,
      sourceSessionId: item?.sessionId || sessionId,
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
    cur.input += input;
    cur.output += output;
    cur.cacheRead += cacheRead;
    cur.cacheWrite += cacheWrite;
    cur.reasoning += reasoning;
    byModel.set(model, cur);
  }

  return {
    client: id,
    sessionId,
    title,
    turns,
    models: [...byModel.values()],
    childrenIncluded: true,
  };
}
