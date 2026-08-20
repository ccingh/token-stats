import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { agentPaths } from "../paths.js";
import { makeSession, toIso } from "../types.js";
import { durationFromRange, sanitizeGenMs } from "../speed.js";

export const id = "freebuff";
export const displayName = "Freebuff";

/**
 * freebuff（Codebuff 系）：~/.config/manicode/projects/<项目>/chats/<时间戳>/
 *
 * 用量口径（对照本机 log.jsonl + freebuff.exe）：
 * - 每条带 contextTokenCount 的「Start agent … step N」是一次模型请求。
 *   该字段是服务端 /api/v1/token-count 回写的当次 prompt 快照，不是累计值；
 *   区间用量要按步累加（用最后一步或相邻差分会少计已发出去的 prompt）。
 * - 运行时其实能收到官方 usage（prompt_tokens / completion_tokens /
 *   prompt_tokens_details.cached_tokens），但 **不落盘**。本地只有：
 *     Start: contextTokenCount、systemTokens
 *     End:   fullResponse、toolCalls、stepCreditsUsed（免费档恒 0）
 *     压缩: cache_expiry_ms / cache_gap_ms（30min TTL 启发式，不是计费 cache）
 * - output：优先用配对 End 的 fullResponse + toolCalls 文本估算（按步对齐）。
 *   没有 End 时回退 chat-messages.json 的 AI 可见文本。reasoning 仍从
 *   blocks 估（压缩后的 messageHistory 会丢早期回复）。
 * - cache：本地没有 cached_tokens。相邻请求 context 前缀重叠可估一个
 *   estCacheReadTokens。input 按未命中拆开（ctx − estCache），**不得**写入
 *   cacheReadTokens / 命中率分母。UI 缓存列写成「–（2.7M）」，命中「–（96%）」。
 *   → noCacheData。总量仍含估算 cache（和其它工具 Input+Cache 口径一致）。
 * - 成本：Freebuff 全系免费。会话和小时桶都写 $0，禁止按模型刊例估
 *   （剥完 provider 的 deepseek-v4-flash 会误套官方价）。
 * - 不用 gpt-tokenizer：打包后 system node 扫 asar.unpacked，解析不到
 *   asar 里的 node_modules，顶层 import 会让整次扫描挂掉。
 */

export function detect() {
  return fs.existsSync(agentPaths().freebuffProjects);
}

const CJK_RE =
  /[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af\u3000-\u303f\uff00-\uffef]/;

/** 无依赖估算：CJK≈1 token，其它约 4 字符 1 token。 */
export function estimateTokens(text) {
  const s = String(text || "");
  if (!s) return 0;
  let cjk = 0;
  let other = 0;
  for (const ch of s) {
    if (CJK_RE.test(ch)) cjk += 1;
    else other += 1;
  }
  return Math.max(0, cjk + Math.ceil(other / 4));
}

function countTokens(text) {
  return estimateTokens(text);
}

/**
 * End agent 没有官方 completion_tokens。可见回复 + 模型写出的 tool call
 * 都是该步 output；tool result 会进下一步 context，这里不算。
 * @param {unknown} fullResponse
 * @param {unknown} toolCalls
 */
/** 与 Codebuff 默认 cache TTL 一致：30 分钟内前缀才可能还在。 */
export const PREFIX_CACHE_TTL_MS = 30 * 60 * 1000;

/**
 * 相邻步 context 前缀重叠 ≈ 可能被 prompt cache 命中的量。
 * 会在每步写入 estCache；未命中 input = ctx − estCache。
 * 不是账单数字，不得写入 cacheReadTokens。
 * @param {{ ts?: string, ctx: number, estCache?: number }[]} steps
 * @param {number} [ttlMs]
 */
export function estimatePrefixCache(steps, ttlMs = PREFIX_CACHE_TTL_MS) {
  let prev = 0;
  let prevTs = 0;
  let cache = 0;
  for (const s of steps || []) {
    const ctx = Math.max(0, Number(s.ctx) || 0);
    const t = s.ts ? Date.parse(s.ts) : NaN;
    const gap = prevTs && Number.isFinite(t) ? t - prevTs : Infinity;
    let stepCache = 0;
    if (prev > 0 && gap < ttlMs) stepCache = Math.min(prev, ctx);
    s.estCache = stepCache;
    cache += stepCache;
    prev = ctx;
    if (Number.isFinite(t)) prevTs = t;
  }
  return cache;
}

/** @param {{ ctx?: number, estCache?: number }} step */
export function uncachedInputOf(step) {
  const ctx = Math.max(0, Number(step?.ctx) || 0);
  const cache = Math.max(0, Number(step?.estCache) || 0);
  return Math.max(0, ctx - cache);
}

export function estimateEndOutput(fullResponse, toolCalls) {
  let n = countTokens(fullResponse);
  if (!Array.isArray(toolCalls)) return n;
  for (const t of toolCalls) {
    if (!t || typeof t !== "object") continue;
    if (t.toolName) n += countTokens(String(t.toolName));
    if (t.input == null) continue;
    try {
      n += countTokens(JSON.stringify(t.input));
    } catch {
      /* ignore */
    }
  }
  return n;
}

/** 会话目录名 `2026-08-17T01-26-43.470Z` → 可解析 ISO */
export function chatDirToIso(name) {
  const m = String(name || "").match(
    /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2}(?:\.\d+)?)Z$/i
  );
  if (m) return `${m[1]}T${m[2]}:${m[3]}:${m[4]}Z`;
  return toIso(name) || undefined;
}

/**
 * 消息时间只有本地 `HH:mm`。用会话开始时间钉到具体一天。
 * @param {string | undefined} startIso
 * @param {unknown} clock
 */
export function combineClock(startIso, clock) {
  const start = startIso ? new Date(startIso) : null;
  const startOk = start && !Number.isNaN(start.getTime());
  const hhmm = String(clock || "").trim();
  const m = hhmm.match(/^(\d{1,2}):(\d{2})$/);
  if (!m || !startOk) return startIso;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return startIso;
  const d = new Date(start.getTime());
  d.setHours(h, min, 0, 0);
  // 时钟比会话开始早太多 → 跨日
  if (d.getTime() < start.getTime() - 2 * 3600_000) {
    d.setDate(d.getDate() + 1);
  }
  return d.toISOString();
}

function stripProvider(model) {
  if (!model) return model;
  const s = String(model);
  return s.includes("/") ? s.split("/").pop() || s : s;
}

function isFreeId(s) {
  return /(?:^|[-_])free(?:$|[-_])/i.test(String(s || ""));
}

function isReasoningBlock(b) {
  const t = String(b?.textType || "").toLowerCase();
  return (
    t === "reasoning" ||
    t === "thinking" ||
    !!(b?.thinkingId || b?.thinkingCollapseState)
  );
}

/**
 * @param {string} projectsRoot
 * @returns {{ project: string, chatDir: string, sessionId: string }[]}
 */
function listChats(projectsRoot) {
  /** @type {{ project: string, chatDir: string, sessionId: string }[]} */
  const out = [];
  if (!fs.existsSync(projectsRoot)) return out;
  let projects;
  try {
    projects = fs.readdirSync(projectsRoot, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const proj of projects) {
    if (!proj.isDirectory()) continue;
    const chatsDir = path.join(projectsRoot, proj.name, "chats");
    if (!fs.existsSync(chatsDir)) continue;
    let chats;
    try {
      chats = fs.readdirSync(chatsDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const chat of chats) {
      if (!chat.isDirectory()) continue;
      const chatDir = path.join(chatsDir, chat.name);
      if (!fs.existsSync(path.join(chatDir, "log.jsonl"))) continue;
      out.push({ project: proj.name, chatDir, sessionId: chat.name });
    }
  }
  return out;
}

function findChat(sessionId) {
  const chats = listChats(agentPaths().freebuffProjects);
  return chats.find((c) => c.sessionId === sessionId) || null;
}

/**
 * 从 chat-messages.json 的 AI blocks 数 output / reasoning。
 * 不用最后一份 messageHistory：压缩后会丢掉早期回复。
 * @param {string} chatDir
 * @param {string | undefined} startedAt
 */
function collectAssistantUsage(chatDir, startedAt) {
  const p = path.join(chatDir, "chat-messages.json");
  /** @type {{ output: number, reasoning: number, messageCount: number, outputs: { ts?: string, output: number, reasoning: number }[] }} */
  const empty = { output: 0, reasoning: 0, messageCount: 0, outputs: [] };
  if (!fs.existsSync(p)) return empty;
  let arr;
  try {
    arr = JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return empty;
  }
  if (!Array.isArray(arr)) return empty;

  let output = 0;
  let reasoning = 0;
  /** @type {{ ts?: string, output: number, reasoning: number }[]} */
  const outputs = [];

  for (const m of arr) {
    if (!m || typeof m !== "object") continue;
    const isAi =
      m.variant === "ai" || m.role === "assistant" || m.role === "ai";
    if (!isAi) continue;
    const blocks = Array.isArray(m.blocks) ? m.blocks : [];
    let out = 0;
    let reason = 0;
    for (const b of blocks) {
      if (!b || b.type !== "text") continue;
      const n = countTokens(b.content || b.text || "");
      if (isReasoningBlock(b)) reason += n;
      else out += n;
    }
    if (out === 0 && reason === 0) continue;
    output += out;
    reasoning += reason;
    outputs.push({
      ts: combineClock(startedAt, m.timestamp) || startedAt,
      output: out,
      reasoning: reason,
    });
  }

  if (output === 0 && reasoning === 0) {
    let history = null;
    for (const m of arr) {
      const mh =
        m?.metadata?.runState?.sessionState?.mainAgentState?.messageHistory;
      if (Array.isArray(mh)) history = mh;
    }
    if (history) {
      for (const msg of history) {
        if (!msg?.content || !Array.isArray(msg.content)) continue;
        const isAssistant = msg.role === "assistant" || msg.role === "ai";
        if (!isAssistant) continue;
        for (const block of msg.content) {
          if (!block || typeof block !== "object") continue;
          const text =
            block.type === "reasoning" || block.type === "text"
              ? block.text
              : null;
          if (typeof text !== "string" || !text) continue;
          const n = countTokens(text);
          if (block.type === "reasoning") reasoning += n;
          else output += n;
        }
      }
      if (output || reasoning) {
        outputs.push({ ts: startedAt, output, reasoning });
      }
    }
  }

  return {
    output,
    reasoning,
    messageCount: arr.length,
    outputs,
  };
}

/**
 * 把消息级 output/reasoning 折到最近的步上。
 * 已有 End 配对 output 时不要再加消息正文，否则和 fullResponse 双计。
 * @param {{ ts?: string, ctx: number, output?: number, reasoning?: number, model?: string }[]} steps
 * @param {{ ts?: string, output: number, reasoning: number }[]} outputs
 * @param {{ includeOutput?: boolean }} [opts]
 */
export function assignOutputsToSteps(steps, outputs, opts = {}) {
  if (!steps.length || !outputs?.length) return steps;
  const includeOutput = opts.includeOutput !== false;
  const times = steps.map((s) => {
    const t = s.ts ? Date.parse(s.ts) : NaN;
    return Number.isFinite(t) ? t : 0;
  });
  for (const o of outputs) {
    const t = o.ts ? Date.parse(o.ts) : NaN;
    let best = -1;
    if (Number.isFinite(t)) {
      for (let i = 0; i < times.length; i++) {
        if (times[i] <= t) best = i;
        else break;
      }
    }
    if (best < 0) best = Number.isFinite(t) ? 0 : steps.length - 1;
    if (includeOutput) {
      steps[best].output = (steps[best].output || 0) + (o.output || 0);
    }
    steps[best].reasoning = (steps[best].reasoning || 0) + (o.reasoning || 0);
  }
  return steps;
}

/**
 * Start 记 input。End 没有 runId，iteration 又按 run 重号，
 * 按「最近一条未闭合、同 iteration 的 Start」配对。
 * @param {string} logPath
 */
async function readSteps(logPath) {
  /** @type {{ ts?: string, ctx: number, output: number, reasoning: number, model?: string, iteration?: unknown, durationMs?: number }[]} */
  const steps = [];
  /** @type {number[]} */
  const open = [];
  /** @type {string[]} */
  const agentTemplates = [];
  let model;
  let lastTs;
  let freeTier = false;
  const stream = fs.createReadStream(logPath, { encoding: "utf8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of rl) {
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    const d = obj?.data;
    if (!d) continue;
    if (d.runConfig?.costMode != null) {
      if (String(d.runConfig.costMode).toLowerCase() === "free") freeTier = true;
      if (typeof d.runConfig.agent === "string" && isFreeId(d.runConfig.agent)) {
        freeTier = true;
      }
    }
    if (d.agentTemplateId) agentTemplates.push(String(d.agentTemplateId));

    const msg = String(obj.msg || "");
    const isEnd = /^End agent\b/i.test(msg);
    const hasCtx = d.contextTokenCount != null;
    if (!hasCtx && !isEnd) continue;

    if (hasCtx) {
      if (d.model) model = String(d.model);
      if (obj.timestamp) lastTs = obj.timestamp;
      steps.push({
        ts: obj.timestamp,
        ctx: Number(d.contextTokenCount) || 0,
        output: 0,
        reasoning: 0,
        model: d.model ? String(d.model) : undefined,
        iteration: d.iteration,
      });
      open.push(steps.length - 1);
    }

    if (isEnd) {
      if (obj.timestamp) lastTs = obj.timestamp;
      if (d.model) model = String(d.model);
      let oi = -1;
      for (let i = open.length - 1; i >= 0; i--) {
        if (steps[open[i]].iteration === d.iteration) {
          oi = i;
          break;
        }
      }
      if (oi < 0 && open.length) oi = open.length - 1;
      if (oi >= 0) {
        const si = open.splice(oi, 1)[0];
        steps[si].output += estimateEndOutput(d.fullResponse, d.toolCalls);
        if (d.model && !steps[si].model) steps[si].model = String(d.model);
        steps[si].durationMs =
          sanitizeGenMs(d.duration) ||
          durationFromRange(steps[si].ts, obj.timestamp) ||
          0;
      }
    }
  }
  if (!freeTier && agentTemplates.some((t) => isFreeId(t))) {
    freeTier = true;
  }
  return { steps, model, lastTs, freeTier, agentTemplates };
}

function readCwd(chatDir, fallback) {
  try {
    const rsPath = path.join(chatDir, "run-state.json");
    if (fs.existsSync(rsPath)) {
      const rs = JSON.parse(fs.readFileSync(rsPath, "utf8"));
      const root =
        rs?.sessionState?.fileContext?.projectRoot ||
        rs?.sessionState?.fileContext?.cwd ||
        rs?.fileContext?.projectRoot;
      if (typeof root === "string" && root.trim()) return root.trim();
    }
  } catch {
    /* ignore */
  }
  return fallback;
}

function readMeta(chatDir) {
  const metaPath = path.join(chatDir, "chat-meta.json");
  /** @type {{ firstPrompt?: string, messageCount?: number }} */
  const out = {};
  if (!fs.existsSync(metaPath)) return out;
  try {
    const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
    if (meta.firstPrompt) out.firstPrompt = meta.firstPrompt;
    if (meta.messageCount != null) out.messageCount = Number(meta.messageCount);
  } catch {
    /* ignore */
  }
  return out;
}

/**
 * @param {{ hourly?: { add: Function } }} [ctx]
 */
export async function scan(ctx = {}) {
  const hourly = ctx.hourly;
  const projectsRoot = agentPaths().freebuffProjects;
  const chats = listChats(projectsRoot);
  /** @type {import('../types.js').SessionRecord[]} */
  const out = [];

  for (const chat of chats) {
    const startedAt = chatDirToIso(chat.sessionId);
    const meta = readMeta(chat.chatDir);
    const { steps, model: rawModel, lastTs } = await readSteps(
      path.join(chat.chatDir, "log.jsonl")
    );
    if (steps.length === 0) continue;

    const model = stripProvider(rawModel);
    const counted = collectAssistantUsage(chat.chatDir, startedAt);
    const hasEndOutput = steps.some((s) => s.output > 0);
    assignOutputsToSteps(steps, counted.outputs, {
      includeOutput: !hasEndOutput,
    });

    const estCacheReadTokens = estimatePrefixCache(steps);
    const inputTokens = steps.reduce((a, s) => a + uncachedInputOf(s), 0);
    const outputTokens = steps.reduce((a, s) => a + (s.output || 0), 0);
    const reasoningTokens = counted.reasoning;
    const cwd = readCwd(chat.chatDir, chat.project);

    if (hourly?.add) {
      for (const s of steps) {
        const uncached = uncachedInputOf(s);
        const stepCache = s.estCache || 0;
        hourly.add(id, s.ts || startedAt, {
          inputTokens: uncached,
          outputTokens: s.output || 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          reasoningTokens: s.reasoning || 0,
          estCacheReadTokens: stepCache || undefined,
          // 总量含估算 cache，和 Input(未命中)+Cache 口径一致
          totalTokens:
            s.ctx + (s.output || 0) + (s.reasoning || 0),
          model: stripProvider(s.model) || model,
          sessionId: chat.sessionId,
          requestCount: 1,
          singleRequest: true,
          durationMs: s.durationMs || undefined,
          // Freebuff 全系免费：不要按 deepseek/glm 刊例估
          costUsd: 0,
          costCny: 0,
        });
      }
    }

    out.push(
      makeSession({
        client: id,
        sessionId: chat.sessionId,
        title: meta.firstPrompt || undefined,
        cwd,
        model,
        startedAt,
        lastUsedAt: toIso(lastTs) || startedAt,
        messageCount: meta.messageCount ?? counted.messageCount,
        requestCount: steps.length,
        turnCount: steps.length,
        inputTokens,
        outputTokens,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens,
        quality: "partial",
        noCacheData: true,
        estCacheReadTokens: estCacheReadTokens || undefined,
        costUsd: 0,
        costCny: 0,
        scannedAt: new Date().toISOString(),
      })
    );
  }

  return out;
}

/**
 * Turn 明细：每步 contextTokenCount 拆成未命中 input + 估算 cache；
 * output 优先来自配对 End（fullResponse + toolCalls）。
 * @param {string} sessionId
 */
export async function getDetail(sessionId) {
  const chat = findChat(sessionId);
  if (!chat) return null;

  const startedAt = chatDirToIso(chat.sessionId);
  const { steps, model: rawModel } = await readSteps(
    path.join(chat.chatDir, "log.jsonl")
  );
  const counted = collectAssistantUsage(chat.chatDir, startedAt);
  const hasEndOutput = steps.some((s) => s.output > 0);
  assignOutputsToSteps(steps, counted.outputs, {
    includeOutput: !hasEndOutput,
  });
  estimatePrefixCache(steps);
  const sessionModel = stripProvider(rawModel);

  /** @type {any[]} */
  const turns = [];
  /** @type {Map<string, { model: string, turns: number, input: number, output: number, reasoning: number, estCache?: number }>} */
  const byModel = new Map();
  let i = 0;
  for (const s of steps) {
    const model = stripProvider(s.model) || sessionModel || "(unknown)";
    const uncached = uncachedInputOf(s);
    const stepCache = s.estCache || 0;
    i += 1;
    turns.push({
      index: i,
      ts: toIso(s.ts) || startedAt,
      model,
      inputTokens: uncached,
      outputTokens: s.output || 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: s.reasoning || 0,
      estCacheReadTokens: stepCache || undefined,
      durationMs: s.durationMs || undefined,
    });
    const cur = byModel.get(model) || {
      model,
      turns: 0,
      input: 0,
      output: 0,
      reasoning: 0,
      estCache: 0,
    };
    cur.turns += 1;
    cur.input += uncached;
    cur.output += s.output || 0;
    cur.reasoning += s.reasoning || 0;
    cur.estCache = (cur.estCache || 0) + stepCache;
    byModel.set(model, cur);
  }

  return {
    client: id,
    sessionId: chat.sessionId,
    title: readMeta(chat.chatDir).firstPrompt,
    turns,
    models: [...byModel.values()],
    note: "freebuff：官方 contextTokenCount 已拆成未命中 input + 前缀重叠估算 cache；output 由 End fullResponse + toolCalls 估算，reasoning 由消息文本估算；本地无官方 cache，命中率不计入汇总",
  };
}
