import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { agentPaths } from "../paths.js";
import { makeSession, toIso } from "../types.js";

export const id = "kimi";
export const displayName = "Kimi Code";

export function detect() {
  return fs.existsSync(agentPaths().kimiRoot);
}

/**
 * @param {string} root
 * @returns {{ sessionId: string, sessionDir: string, workDir?: string }[]}
 */
function loadIndex(root) {
  const indexPath = path.join(root, "session_index.jsonl");
  /** @type {{ sessionId: string, sessionDir: string, workDir?: string }[]} */
  const items = [];
  if (fs.existsSync(indexPath)) {
    const lines = fs.readFileSync(indexPath, "utf8").split(/\r?\n/);
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const o = JSON.parse(line);
        if (o.sessionId && o.sessionDir) {
          items.push({
            sessionId: o.sessionId,
            sessionDir: o.sessionDir,
            workDir: o.workDir,
          });
        }
      } catch {
        /* ignore */
      }
    }
  }

  // fallback: walk sessions/
  if (items.length === 0) {
    const sessionsRoot = path.join(root, "sessions");
    if (fs.existsSync(sessionsRoot)) {
      const walk = (d) => {
        let entries;
        try {
          entries = fs.readdirSync(d, { withFileTypes: true });
        } catch {
          return;
        }
        for (const ent of entries) {
          const full = path.join(d, ent.name);
          if (!ent.isDirectory()) continue;
          if (ent.name.startsWith("session_")) {
            items.push({ sessionId: ent.name, sessionDir: full });
          } else {
            walk(full);
          }
        }
      };
      walk(sessionsRoot);
    }
  }
  return items;
}

/** @type {{ add?: Function } | null} */
let hourlySink = null;

/**
 * @param {string} sessionDir
 */
function findWire(sessionDir) {
  const candidate = path.join(sessionDir, "agents", "main", "wire.jsonl");
  if (fs.existsSync(candidate)) return candidate;
  // search
  const stack = [sessionDir];
  while (stack.length) {
    const d = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      const full = path.join(d, ent.name);
      if (ent.isFile() && ent.name === "wire.jsonl") return full;
      if (ent.isDirectory()) stack.push(full);
    }
  }
  return null;
}

/**
 * 汇总单个 wire.jsonl
 * @param {string} wirePath
 * @param {string} [sessionId]
 */
/**
 * Kimi wire 里 profileName → 展示用 agent（对齐 Tokscale：Build / Explore / …）
 * @param {unknown} profile
 */
function profileToAgentName(profile) {
  if (profile == null) return undefined;
  const p = String(profile).trim().toLowerCase();
  if (!p) return undefined;
  if (p === "explore") return "Explore";
  if (p === "plan") return "Plan";
  if (p === "agent" || p === "coder" || p === "build" || p === "default") {
    return "Build";
  }
  // 其它 profile 原样首字母大写
  return p.charAt(0).toUpperCase() + p.slice(1);
}

/**
 * 从 wire 扫 profileName（config.update）与 usage
 * @param {string} wirePath
 * @param {string} [sessionId]
 */
async function sumWire(wirePath, sessionId) {
  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let model;
  let lastTs;
  let messageCount = 0;
  /** @type {string | undefined} */
  let profileName;

  const stream = fs.createReadStream(wirePath, { encoding: "utf8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  for await (const line of rl) {
    // profile / mode 可能出现在非 usage 行
    if (line.includes("profileName") || line.includes("usage")) {
      let obj;
      try {
        obj = JSON.parse(line);
      } catch {
        continue;
      }
      if (obj.profileName) profileName = String(obj.profileName);
      if (obj.type !== "usage.record") continue;
      const u = obj.usage || {};
      const inTok = Number(u.inputOther) || 0;
      const outTok = Number(u.output) || 0;
      const cr = Number(u.inputCacheRead) || 0;
      const cw = Number(u.inputCacheCreation) || 0;
      input += inTok;
      output += outTok;
      cacheRead += cr;
      cacheWrite += cw;
      if (obj.model) model = obj.model;
      if (obj.time) lastTs = toIso(obj.time) || lastTs;
      messageCount += 1;
      if (hourlySink?.add && obj.time) {
        hourlySink.add(id, obj.time, {
          inputTokens: inTok,
          outputTokens: outTok,
          cacheReadTokens: cr,
          cacheWriteTokens: cw,
          model: obj.model ? String(obj.model) : undefined,
          sessionId: sessionId || undefined,
        });
      }
    }
  }

  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    model,
    lastTs,
    messageCount,
    profileName,
    agentName: profileToAgentName(profileName),
  };
}

/**
 * 同一 session 下 agents/main + agents/agent-* 的全部 wire 一并汇总
 * @param {string} sessionDir
 */
function listAllWires(sessionDir) {
  /** @type {string[]} */
  const wires = [];
  const agentsDir = path.join(sessionDir, "agents");
  if (fs.existsSync(agentsDir)) {
    let entries;
    try {
      entries = fs.readdirSync(agentsDir, { withFileTypes: true });
    } catch {
      entries = [];
    }
    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      const w = path.join(agentsDir, ent.name, "wire.jsonl");
      if (fs.existsSync(w)) wires.push(w);
    }
  }
  // fallback single wire
  if (wires.length === 0) {
    const one = findWire(sessionDir);
    if (one) wires.push(one);
  }
  return wires;
}

/**
 * @param {string} sessionDir
 * @param {string} [sessionId]
 */
async function sumAllWires(sessionDir, sessionId) {
  const wires = listAllWires(sessionDir);
  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let model;
  let lastTs;
  let messageCount = 0;
  /** @type {string[]} */
  const agentParts = [];
  /** @type {string | undefined} */
  let mainAgentName;

  for (const w of wires) {
    try {
      const u = await sumWire(w, sessionId);
      input += u.input;
      output += u.output;
      cacheRead += u.cacheRead;
      cacheWrite += u.cacheWrite;
      messageCount += u.messageCount;
      if (u.model) model = u.model;
      if (u.lastTs && (!lastTs || u.lastTs > lastTs)) lastTs = u.lastTs;
      // agents/<folder>/wire.jsonl — 展示名优先 profileName
      const folder = path.basename(path.dirname(w));
      const label = u.agentName || (folder !== "main" ? folder : undefined);
      if (folder === "main") {
        if (u.agentName) mainAgentName = u.agentName;
      } else if (label) {
        agentParts.push(label);
      }
    } catch (err) {
      console.error("[kimi] wire failed", w, err);
    }
  }

  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    model,
    lastTs,
    messageCount,
    childAgents: agentParts,
    agentName: mainAgentName,
  };
}

/**
 * @param {{ hourly?: { add: Function } }} [ctx]
 */
export async function scan(ctx = {}) {
  const root = agentPaths().kimiRoot;
  if (!fs.existsSync(root)) return [];

  hourlySink = ctx.hourly || null;
  const scannedAt = new Date().toISOString();
  const index = loadIndex(root);
  /** @type {import('../types.js').SessionRecord[]} */
  const out = [];

  try {
  for (const item of index) {
    const sessionDir = item.sessionDir;
    if (!fs.existsSync(sessionDir)) continue;

    let title;
    let startedAt;
    let lastUsedAt;
    let cwd = item.workDir;
    const statePath = path.join(sessionDir, "state.json");
    if (fs.existsSync(statePath)) {
      try {
        const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
        title = state.title;
        startedAt = toIso(state.createdAt);
        lastUsedAt = toIso(state.updatedAt);
        cwd = state.workDir || cwd;
      } catch {
        /* ignore */
      }
    }

    let usage = {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      model: undefined,
      lastTs: undefined,
      messageCount: 0,
      childAgents: /** @type {string[]} */ ([]),
    };
    try {
      usage = await sumAllWires(sessionDir, item.sessionId);
    } catch (err) {
      console.error("[kimi] sum wires failed", sessionDir, err);
    }

    const hasTokens =
      usage.input + usage.output + usage.cacheRead + usage.cacheWrite > 0;
    const childN = usage.childAgents?.length || 0;

    out.push(
      makeSession({
        client: id,
        sessionId: item.sessionId,
        title,
        cwd,
        model: usage.model,
        startedAt,
        lastUsedAt: lastUsedAt || usage.lastTs,
        messageCount: usage.messageCount || undefined,
        turnCount: usage.messageCount || undefined,
        requestCount: usage.messageCount || undefined,
        inputTokens: usage.input,
        outputTokens: usage.output,
        cacheReadTokens: usage.cacheRead,
        cacheWriteTokens: usage.cacheWrite,
        quality: hasTokens ? "full" : "partial",
        // 主 wire profileName → Build / Explore…
        agentName: usage.agentName,
        // Kimi 子 agent 已合在同一 session 的 wire 里，用 childCount 提示
        childCount: childN > 0 ? childN : undefined,
        mergedChildren: childN > 0 ? usage.childAgents : undefined,
        scannedAt,
      })
    );
  }
  } finally {
    hourlySink = null;
  }

  return out;
}

/**
 * Turn 明细：wire.jsonl 中 type=usage.record
 * @param {string} sessionId
 */
export async function getDetail(sessionId) {
  const root = agentPaths().kimiRoot;
  if (!fs.existsSync(root)) return null;

  const index = loadIndex(root);
  const item =
    index.find((x) => x.sessionId === sessionId) ||
    index.find((x) => x.sessionId.replace(/^session_/, "") === sessionId.replace(/^session_/, ""));
  if (!item || !fs.existsSync(item.sessionDir)) return null;

  const wire = findWire(item.sessionDir);
  /** @type {any[]} */
  const turns = [];
  /** @type {Map<string, { model: string, turns: number, input: number, output: number, cacheRead: number, cacheWrite: number }>} */
  const byModel = new Map();

  let title;
  const statePath = path.join(item.sessionDir, "state.json");
  if (fs.existsSync(statePath)) {
    try {
      title = JSON.parse(fs.readFileSync(statePath, "utf8")).title;
    } catch {
      /* ignore */
    }
  }

  const wires = listAllWires(item.sessionDir);
  let i = 0;
  /** @type {string | undefined} */
  let sessionAgent;
  for (const wire of wires) {
    const folder = path.basename(path.dirname(wire));
    const isSub = folder !== "main";
    // 先读整份 wire 拿 profileName（config 行可能在 usage 之前）
    let profileAgent;
    try {
      const head = fs.readFileSync(wire, "utf8").split(/\n/).slice(0, 80);
      for (const line of head) {
        if (!line.includes("profileName")) continue;
        try {
          const o = JSON.parse(line);
          if (o.profileName) {
            profileAgent = profileToAgentName(o.profileName);
            break;
          }
        } catch {
          /* ignore */
        }
      }
    } catch {
      /* ignore */
    }
    if (!isSub && profileAgent) sessionAgent = profileAgent;

    const stream = fs.createReadStream(wire, { encoding: "utf8" });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line.includes("usage.record")) continue;
      let obj;
      try {
        obj = JSON.parse(line);
      } catch {
        continue;
      }
      if (obj.type !== "usage.record") continue;
      const u = obj.usage || {};
      const input = Number(u.inputOther) || 0;
      const output = Number(u.output) || 0;
      const cacheRead = Number(u.inputCacheRead) || 0;
      const cacheWrite = Number(u.inputCacheCreation) || 0;
      if (input + output + cacheRead + cacheWrite <= 0) continue;
      const model = obj.model ? String(obj.model) : "(unknown)";
      // 优先 profileName；子目录 agent-0 不作为展示名
      let agentName = profileAgent;
      if (!agentName && isSub && !/^agent[-_]?\d*$/i.test(folder)) {
        agentName = folder;
      }
      i += 1;
      turns.push({
        index: i,
        ts: toIso(obj.time),
        model,
        inputTokens: input,
        outputTokens: output,
        cacheReadTokens: cacheRead,
        cacheWriteTokens: cacheWrite,
        reasoningTokens: 0,
        isSubagent: isSub,
        agentName,
        sourceSessionId: isSub
          ? `${item.sessionId}/${folder}`
          : item.sessionId,
      });
      const cur = byModel.get(model) || {
        model,
        turns: 0,
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
      };
      cur.turns += 1;
      cur.input += input;
      cur.output += output;
      cur.cacheRead += cacheRead;
      cur.cacheWrite += cacheWrite;
      byModel.set(model, cur);
    }
  }

  return {
    client: id,
    sessionId: item.sessionId,
    title,
    agentName: sessionAgent,
    turns,
    models: [...byModel.values()],
    // 子 agent wire 已合进 turns，并标 isSubagent
    childrenIncluded: true,
  };
}
