import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { agentPaths } from "../paths.js";
import { isPlaceholderModel, makeSession, toIso } from "../types.js";
import { durationFromRange } from "../speed.js";

export const id = "claude";
export const displayName = "Claude Code";

export function detect() {
  return fs.existsSync(agentPaths().claudeProjects);
}

/**
 * Decode Claude project folder name like "D--ly" → "D:/ly"
 * @param {string} name
 */
function decodeProjectFolder(name) {
  if (/^[A-Za-z]--/.test(name)) {
    const rest = name.slice(3).replace(/-/g, path.sep);
    return `${name[0]}:${path.sep}${rest}`;
  }
  return name.replace(/-/g, path.sep);
}

/**
 * @param {string} dir
 * @returns {string[]}
 */
function listJsonl(dir) {
  /** @type {string[]} */
  const files = [];
  if (!fs.existsSync(dir)) return files;

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
        walk(full);
      } else if (ent.isFile() && ent.name.endsWith(".jsonl")) {
        files.push(full);
      }
    }
  };
  walk(dir);
  return files;
}

/**
 * 读 Claude 子 agent 旁路 meta：agent-xxx.meta.json
 * Tokscale 的 Explore / Plan 就来自这里的 agentType。
 * @param {string} jsonlFile agent-xxx.jsonl 路径
 * @returns {{ agentType?: string, description?: string } | null}
 */
function readAgentMeta(jsonlFile) {
  const metaPath = jsonlFile.replace(/\.jsonl$/i, ".meta.json");
  if (!fs.existsSync(metaPath)) return null;
  try {
    const j = JSON.parse(fs.readFileSync(metaPath, "utf8"));
    if (!j || typeof j !== "object") return null;
    return {
      agentType: j.agentType || j.agent_type || j.type || undefined,
      description: j.description || undefined,
    };
  } catch {
    return null;
  }
}

/**
 * 规范化 Claude agent 显示名（Explore / Plan / general-purpose）
 * @param {unknown} raw
 */
function prettyClaudeAgent(raw) {
  if (raw == null) return undefined;
  const s = String(raw).trim();
  if (!s) return undefined;
  if (/^explore$/i.test(s)) return "Explore";
  if (/^plan$/i.test(s)) return "Plan";
  if (/^general[-_ ]?purpose$/i.test(s)) return "general-purpose";
  if (/^bash$/i.test(s)) return "Bash";
  // 纯 hash id 不当作名字
  if (/^[0-9a-f]{8,}$/i.test(s) || /^agent-[0-9a-f]/i.test(s)) return undefined;
  return s;
}

/**
 * 从路径推断 Claude 父子关系：
 *   .../<parentUuid>.jsonl
 *   .../<parentUuid>/subagents/agent-xxx.jsonl
 *   同目录 agent-xxx.meta.json → agentType（Explore/Plan…）
 * @param {string} file
 * @param {string} projectDir
 */
function resolveHierarchy(file, projectDir) {
  const base = path.basename(file, ".jsonl");
  const rel = path.relative(projectDir, file);
  const parts = rel.split(path.sep);

  // .../subagents/agent-xxx.jsonl under a session folder
  const subIdx = parts.findIndex((p) => p === "subagents");
  if (subIdx > 0 && base.startsWith("agent-")) {
    const meta = readAgentMeta(file);
    const agentName =
      prettyClaudeAgent(meta?.agentType) ||
      prettyClaudeAgent(base.replace(/^agent-/, "")) ||
      undefined;
    return {
      sessionId: base,
      parentSessionId: parts[subIdx - 1],
      isSubagent: true,
      agentName,
      agentDescription: meta?.description,
    };
  }

  // top-level session file
  return {
    sessionId: base,
    parentSessionId: undefined,
    isSubagent: false,
    agentName: undefined,
  };
}

/**
 * @param {string} file
 * @param {string} projectFolder
 * @param {string} projectDir
 * @param {string} scannedAt
 */
/**
 * @param {string} file
 * @param {string} projectFolder
 * @param {string} projectDir
 * @param {string} scannedAt
 * @param {{ add?: Function }} [hourly]
 */
async function parseJsonl(file, projectFolder, projectDir, scannedAt, hourly) {
  const hier = resolveHierarchy(file, projectDir);
  const { sessionId, parentSessionId, isSubagent, agentName } = hier;

  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let model;
  let startedAt;
  let lastUsedAt;
  let messageCount = 0;
  let turnCount = 0;
  let cwd = decodeProjectFolder(projectFolder);
  /** 上一条事件时间，用来估模型调用墙钟（无官方 duration） */
  let prevEventTs;

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

    if (obj.cwd && typeof obj.cwd === "string") cwd = obj.cwd;
    if (obj.timestamp) {
      const iso = toIso(obj.timestamp);
      if (iso) {
        if (!startedAt || iso < startedAt) startedAt = iso;
        if (!lastUsedAt || iso > lastUsedAt) lastUsedAt = iso;
      }
    }

    const usage = obj?.message?.usage || obj?.usage;
    if (usage && typeof usage === "object") {
      const inTok = Number(usage.input_tokens) || 0;
      const outTok = Number(usage.output_tokens) || 0;
      const cr = Number(usage.cache_read_input_tokens) || 0;
      const cw = Number(usage.cache_creation_input_tokens) || 0;
      const nextModel = obj?.message?.model || obj?.model;
      // <synthetic>：Claude 内部 stub（No response requested / API Error），token 为 0
      // 若用它覆盖 session.model，整段会变成未定价「模型」
      if (isPlaceholderModel(nextModel) && inTok + outTok + cr + cw <= 0) {
        continue;
      }
      input += inTok;
      output += outTok;
      cacheRead += cr;
      cacheWrite += cw;
      messageCount += 1;
      turnCount += 1;
      if (nextModel && !isPlaceholderModel(nextModel)) model = nextModel;
      if (hourly?.add && obj.timestamp) {
        hourly.add(id, obj.timestamp, {
          inputTokens: inTok,
          outputTokens: outTok,
          cacheReadTokens: cr,
          cacheWriteTokens: cw,
          model: model || undefined,
          sessionId,
          durationMs: durationFromRange(prevEventTs, obj.timestamp) || undefined,
        });
      }
    }
    if (obj.timestamp) prevEventTs = obj.timestamp;
  }

  const hasTokens = input + output + cacheRead + cacheWrite > 0;
  if (!hasTokens && messageCount === 0) {
    try {
      if (fs.statSync(file).size < 200) return null;
    } catch {
      return null;
    }
  }

  /** @type {import('../types.js').Quality} */
  let quality = hasTokens ? "full" : "partial";
  if (!hasTokens && messageCount === 0) quality = "no_model";

  return makeSession({
    client: id,
    sessionId,
    title: isSubagent
      ? agentName
        ? `${agentName}${hier.agentDescription ? ` · ${String(hier.agentDescription).slice(0, 40)}` : ""}`
        : `子 agent ${sessionId}`
      : undefined,
    cwd,
    model,
    startedAt,
    lastUsedAt,
    messageCount: messageCount || undefined,
    turnCount: turnCount || undefined,
    // 每条带 usage 的 assistant 记 1 次模型请求
    requestCount: turnCount || undefined,
    inputTokens: input,
    outputTokens: output,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
    quality,
    parentSessionId,
    isSubagent: isSubagent || undefined,
    agentName,
    scannedAt,
  });
}

/**
 * @param {{ hourly?: { add: Function } }} [ctx]
 */
export async function scan(ctx = {}) {
  const root = agentPaths().claudeProjects;
  if (!fs.existsSync(root)) return [];

  const hourly = ctx.hourly;
  const scannedAt = new Date().toISOString();
  /** @type {import('../types.js').SessionRecord[]} */
  const out = [];

  let projects;
  try {
    projects = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory());
  } catch {
    return [];
  }

  for (const proj of projects) {
    const projDir = path.join(root, proj.name);
    const files = listJsonl(projDir);
    for (const file of files) {
      try {
        const rec = await parseJsonl(file, proj.name, projDir, scannedAt, hourly);
        if (rec) out.push(rec);
      } catch (err) {
        console.error("[claude] parse failed", file, err);
      }
    }
  }

  // 父子并账统一在 scanAll（配合本地持久化）里做
  return out;
}

/**
 * 会话明细（turn 级），供详情面板。
 * @param {string} sessionId
 */
export async function getDetail(sessionId) {
  const root = agentPaths().claudeProjects;
  if (!fs.existsSync(root)) return null;

  /** @type {string | null} */
  let targetFile = null;
  /** @type {string | null} */
  let projectFolder = null;

  const walk = (d, projName) => {
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      const full = path.join(d, ent.name);
      if (ent.isDirectory()) walk(full, projName);
      else if (ent.isFile() && ent.name === `${sessionId}.jsonl`) {
        targetFile = full;
        projectFolder = projName;
      } else if (
        ent.isFile() &&
        ent.name.startsWith("agent-") &&
        ent.name === `${sessionId}.jsonl`
      ) {
        targetFile = full;
        projectFolder = projName;
      }
    }
  };

  let projects;
  try {
    projects = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory());
  } catch {
    return null;
  }
  for (const proj of projects) {
    walk(path.join(root, proj.name), proj.name);
    if (targetFile) break;
  }
  // also match agent- id without .jsonl prefix issues
  if (!targetFile) {
    for (const proj of projects) {
      const files = listJsonl(path.join(root, proj.name));
      for (const f of files) {
        if (path.basename(f, ".jsonl") === sessionId) {
          targetFile = f;
          projectFolder = proj.name;
          break;
        }
      }
      if (targetFile) break;
    }
  }

  if (!targetFile) return null;

  // 从路径 + meta.json 推断子 agent 类型（Explore/Plan…）
  let hier = {
    isSubagent: false,
    agentName: /** @type {string | undefined} */ (undefined),
  };
  try {
    const projDir = projectFolder
      ? path.join(root, projectFolder)
      : path.dirname(targetFile);
    hier = resolveHierarchy(targetFile, projDir);
  } catch {
    /* ignore */
  }
  if (!hier.isSubagent && /[/\\]subagents[/\\]/i.test(targetFile)) {
    const base = path.basename(targetFile, ".jsonl");
    const meta = readAgentMeta(targetFile);
    hier = {
      isSubagent: true,
      agentName:
        prettyClaudeAgent(meta?.agentType) ||
        prettyClaudeAgent(base.replace(/^agent-/, "")) ||
        undefined,
    };
  }

  /** @type {any[]} */
  const turns = [];
  /** @type {Map<string, { model: string, turns: number, input: number, output: number, cacheRead: number, cacheWrite: number }>} */
  const byModel = new Map();

  const stream = fs.createReadStream(targetFile, { encoding: "utf8" });
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
    const usage = obj?.message?.usage || obj?.usage;
    if (!usage || typeof usage !== "object") continue;
    const rawModel = obj?.message?.model || obj?.model;
    const input = Number(usage.input_tokens) || 0;
    const output = Number(usage.output_tokens) || 0;
    const cacheRead = Number(usage.cache_read_input_tokens) || 0;
    const cacheWrite = Number(usage.cache_creation_input_tokens) || 0;
    if (isPlaceholderModel(rawModel) && input + output + cacheRead + cacheWrite <= 0) {
      continue;
    }
    const model = rawModel && !isPlaceholderModel(rawModel) ? rawModel : "(unknown)";
    // 消息级 agent 字段（若有）
    const msgAgent =
      obj?.agent ||
      obj?.agentName ||
      obj?.message?.agent ||
      obj?.message?.agentName ||
      undefined;
    i += 1;
    turns.push({
      index: i,
      ts: toIso(obj.timestamp),
      model: String(model),
      inputTokens: input,
      outputTokens: output,
      cacheReadTokens: cacheRead,
      cacheWriteTokens: cacheWrite,
      reasoningTokens: 0,
      isSubagent: hier.isSubagent || undefined,
      agentName: msgAgent
        ? String(msgAgent)
        : hier.isSubagent
          ? hier.agentName
          : undefined,
    });
    const cur = byModel.get(String(model)) || {
      model: String(model),
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
    byModel.set(String(model), cur);
  }

  return {
    client: id,
    sessionId,
    agentName: hier.isSubagent ? hier.agentName : undefined,
    turns,
    models: [...byModel.values()],
    sourceFile: targetFile,
    projectFolder,
  };
}
