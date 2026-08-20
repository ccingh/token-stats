/**
 * @typedef {'full' | 'partial' | 'metadata_only' | 'no_model'} Quality
 *
 * @typedef {Object} SessionRecord
 * @property {string} id
 * @property {string} client
 * @property {string} sessionId
 * @property {string} [title]
 * @property {string} [cwd]
 * @property {string} [model] 模型主名（不含思考档位）
 * @property {string} [modelVariant] 思考档位：max / high / …（附属展示）
 * @property {string} [startedAt]
 * @property {string} [lastUsedAt]
 * @property {number} [messageCount]
 * @property {number} inputTokens
 * @property {number} outputTokens
 * @property {number} cacheReadTokens
 * @property {number} cacheWriteTokens
 * @property {number} reasoningTokens
 * @property {number} totalTokens
 * @property {number} [costUsd]
 * @property {number} [costCny]
 * @property {Quality} quality
 * @property {string} scannedAt
 * @property {string} [parentSessionId]
 * @property {boolean} [isSubagent]
 * @property {string} [agentName]
 * @property {string} [sessionKind]
 * @property {number} [turnCount]
 * @property {number} [requestCount] 模型/API 请求次数（有则写；区间视图可来自 hourly.events）
 * @property {number} [longContextRequests] 命中长上下文档的请求数（如 Grok prompt ≥200k）
 * @property {string[]} [mergedChildren]
 * @property {number} [childCount]
 * @property {boolean} [deleted] 源日志已不存在，来自本地持久化
 * @property {string} [deletedAt]
 * @property {boolean} [synthetic] 从未扫到父、仅为并账生成的壳
 * @property {string} [firstSeenAt]
 * @property {string} [lastSeenAt]
 * @property {boolean} [dedupExcluded] 跨工具去重：本条被排除，不计入总额（标记而非删除）
 * @property {string} [dedupReason] 去重原因，如 "duplicate_session_id:<胜出client>"
 * @property {string} [dedupKeptBy] "client:sessionId"，指向保留的那条（便于跳转）
 * @property {boolean} [noCacheData] 本地无 cache 官方记录（如 freebuff）：命中率统计应排除
 * @property {number} [estCacheReadTokens] 仅展示用的估算 cache（不得计入 cacheRead / 官方命中率；计入 total）
 * @property {number} [genMs] 有耗时记录的模型请求墙钟合计（ms，含 TTFT）
 * @property {number} [genTokens] 与 genMs 配对的 output+reasoning
 * @property {number} [estGenMs] 非官方估算耗时（不进汇总 tok/s）
 * @property {number} [estGenTokens] 与 estGenMs 配对的生成量
 */

/**
 * 把「input 含 cache 子集」拆成互不重叠字段（对齐 Grok adapter / 计费口径）。
 * ZCode、部分 message.tokens 风格：total ≈ input+output，cache.read 是 prompt 子集。
 * 已是分列口径（cache ≫ uncached input，如 Claude/OpenCode session）时不改。
 *
 * @param {{
 *   input?: number,
 *   output?: number,
 *   reasoning?: number,
 *   cacheRead?: number,
 *   cacheWrite?: number,
 *   totalHint?: number,
 * }} raw
 * @returns {{
 *   input: number,
 *   output: number,
 *   reasoning: number,
 *   cacheRead: number,
 *   cacheWrite: number,
 * }}
 */
export function splitInclusiveUsage(raw) {
  let input = Math.max(0, num(raw.input));
  let output = Math.max(0, num(raw.output));
  let reasoning = Math.max(0, num(raw.reasoning));
  let cacheRead = Math.max(0, num(raw.cacheRead));
  let cacheWrite = Math.max(0, num(raw.cacheWrite));

  // cache 是 input 子集 → Input 只保留未命中
  if (cacheRead > 0 && cacheRead <= input) {
    input = input - cacheRead;
  }

  // reasoning 是 output 子集 → Output 只保留可见输出
  if (reasoning > 0 && reasoning <= output) {
    output = output - reasoning;
  }

  return { input, output, reasoning, cacheRead, cacheWrite };
}

/**
 * 会话处理过的 token 总量（各分量互不重叠时直接相加）。
 * 兼容尚未 split 的旧数据：若 cache ≤ input 视为子集，不再计入 total。
 * estCacheReadTokens 与 cacheRead 互斥（官方 cache 为 0 时的展示估算），要加进总量。
 * @param {{
 *   inputTokens?: number,
 *   outputTokens?: number,
 *   cacheReadTokens?: number,
 *   cacheWriteTokens?: number,
 *   reasoningTokens?: number,
 *   estCacheReadTokens?: number,
 * }} s
 * @returns {number}
 */
export function computeTotalTokens(s) {
  const input = num(s.inputTokens);
  const output = num(s.outputTokens);
  const cacheRead = num(s.cacheReadTokens);
  const cacheWrite = num(s.cacheWriteTokens);
  const reasoning = num(s.reasoningTokens);
  const estCache = num(s.estCacheReadTokens);

  const cachePart = cacheRead > 0 && cacheRead <= input ? 0 : cacheRead;
  const reasonPart = reasoning > 0 && reasoning <= output ? 0 : reasoning;

  return input + output + cachePart + cacheWrite + reasonPart + estCache;
}

/**
 * 思考档位（OpenCode variant 等）规范化。
 * default/none 视为无档位。
 * @param {unknown} v
 * @returns {string | undefined}
 */
export function normalizeModelVariant(v) {
  if (v == null) return undefined;
  const t = String(v).trim();
  if (!t) return undefined;
  const low = t.toLowerCase();
  if (low === "default" || low === "none" || low === "null") return undefined;
  return low;
}

/**
 * 拆成「模型主名 + 思考档位」。
 * 思考档位是附属条件，不参与模型身份统计。
 * @param {unknown} raw
 * @returns {{ base?: string, variant?: string }}
 */
export function splitModelParts(raw) {
  if (raw == null || raw === "") return {};
  if (typeof raw === "object" && !Array.isArray(raw)) {
    return partsFromObject(/** @type {Record<string, unknown>} */ (raw));
  }
  let s = String(raw).trim();
  if (!s) return {};
  if (s === "（未知模型）" || s === "(未知模型)" || s === "未知模型") {
    return { base: "未知模型" };
  }

  if (s.startsWith("{")) {
    try {
      const o = JSON.parse(s);
      if (o && typeof o === "object" && !Array.isArray(o)) {
        return partsFromObject(/** @type {Record<string, unknown>} */ (o));
      }
    } catch {
      const idM =
        s.match(/"id"\s*:\s*"([^"]+)"/i) ||
        s.match(/"modelID"\s*:\s*"([^"]+)"/i) ||
        s.match(/"modelId"\s*:\s*"([^"]+)"/i);
      if (idM) {
        const vM = s.match(/"variant"\s*:\s*"([^"]+)"/i);
        return {
          base: cleanModelId(idM[1]),
          variant: normalizeModelVariant(vM?.[1]),
        };
      }
    }
  }

  // 历史展示串：deepseek-v4-pro · max
  const dot = s.indexOf("·");
  if (dot >= 0) {
    return {
      base: cleanModelId(s.slice(0, dot)),
      variant: normalizeModelVariant(s.slice(dot + 1)),
    };
  }
  return { base: cleanModelId(s) };
}

/**
 * 统计 / 小时桶用的模型键：只要主名，不要思考档位。
 * @param {unknown} raw
 * @returns {string | undefined}
 */
export function modelAggKey(raw) {
  return splitModelParts(raw).base;
}

/**
 * @param {unknown} raw
 * @returns {string | undefined}
 */
export function modelVariantOf(raw) {
  return splitModelParts(raw).variant;
}

/**
 * 规范化模型主名（不含思考档位）。
 * OpenCode JSON / 旧串 `id · max` 都会落到主名。
 * @param {unknown} raw
 * @returns {string | undefined}
 */
export function normalizeModelName(raw) {
  return modelAggKey(raw);
}

/**
 * @param {Record<string, unknown>} o
 */
function partsFromObject(o) {
  const id =
    o.id ??
    o.modelID ??
    o.modelId ??
    o.model_id ??
    (typeof o.model === "string" ? o.model : undefined);
  if (id == null || id === "") return {};
  return {
    base: cleanModelId(String(id)),
    variant: normalizeModelVariant(o.variant),
  };
}

/**
 * Claude Code 内部占位模型：无响应 / API 错误 stub，用量为 0。
 * 不能当会话模型，否则最后一条会把整段真实模型盖掉。
 * @param {unknown} raw
 */
export function isPlaceholderModel(raw) {
  if (raw == null) return false;
  const s = String(raw).trim();
  if (!s) return false;
  const low = s.toLowerCase();
  return (
    low === "<synthetic>" ||
    low === "synthetic" ||
    low === "<unknown>" ||
    low === "(unknown)"
  );
}

/**
 * Kimi Code 供应商前缀：登录是 `kimi-code/`，旧 API key 路径是 `kimi-for-coding/`。
 * 尾巴才是文档里的 Model ID（k3 / k3-256k / kimi-for-coding / …）。
 * 单独的 `kimi-for-coding`（没有斜杠）是 K2.7 Code，不能剥。
 * @param {string} id
 */
function stripKimiProviderPrefix(id) {
  const s = String(id || "").trim();
  if (!s) return s;
  const m = s.match(/^(kimi-code|kimi-for-coding)\//i);
  if (!m) return s;
  const tail = s.slice(m[0].length).trim();
  return tail || s;
}

/**
 * @param {string} id
 */
function cleanModelId(id) {
  if (isPlaceholderModel(id)) return undefined;
  const clean = stripKimiProviderPrefix(String(id || ""))
    .replace(/-build$/, "")
    .trim();
  return clean || undefined;
}

/**
 * @param {Partial<SessionRecord> & { client: string, sessionId: string }} partial
 * @returns {SessionRecord}
 */
export function makeSession(partial) {
  const inputTokens = num(partial.inputTokens);
  const outputTokens = num(partial.outputTokens);
  const cacheReadTokens = num(partial.cacheReadTokens);
  const cacheWriteTokens = num(partial.cacheWriteTokens);
  const reasoningTokens = num(partial.reasoningTokens);
  const estCacheReadTokens =
    partial.estCacheReadTokens != null && Number(partial.estCacheReadTokens) > 0
      ? num(partial.estCacheReadTokens)
      : 0;
  const totalTokens = computeTotalTokens({
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    reasoningTokens,
    estCacheReadTokens,
  });

  /** @type {Quality} */
  let quality = partial.quality || "full";
  if (totalTokens <= 0 && quality === "full") quality = "partial";

  const modelParts = splitModelParts(partial.model);
  const model =
    modelParts.base ||
    normalizeModelName(partial.model) ||
    undefined;
  const modelVariant =
    modelParts.variant ||
    normalizeModelVariant(partial.modelVariant) ||
    undefined;

  return {
    id: `${partial.client}:${partial.sessionId}`,
    client: partial.client,
    sessionId: partial.sessionId,
    title: partial.title || undefined,
    cwd: partial.cwd || undefined,
    model,
    modelVariant,
    startedAt: partial.startedAt || undefined,
    lastUsedAt: partial.lastUsedAt || undefined,
    messageCount: partial.messageCount != null ? num(partial.messageCount) : undefined,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    reasoningTokens,
    totalTokens,
    costUsd: partial.costUsd != null ? Number(partial.costUsd) : undefined,
    costCny: partial.costCny != null ? Number(partial.costCny) : undefined,
    quality,
    scannedAt: partial.scannedAt || new Date().toISOString(),
    parentSessionId: partial.parentSessionId || undefined,
    isSubagent: partial.isSubagent ? true : undefined,
    agentName: partial.agentName || undefined,
    sessionKind: partial.sessionKind || undefined,
    turnCount: partial.turnCount != null ? num(partial.turnCount) : undefined,
    requestCount:
      partial.requestCount != null ? num(partial.requestCount) : undefined,
    longContextRequests:
      partial.longContextRequests != null
        ? num(partial.longContextRequests)
        : undefined,
    mergedChildren: partial.mergedChildren?.length
      ? [...partial.mergedChildren]
      : undefined,
    childCount: partial.childCount != null ? num(partial.childCount) : undefined,
    deleted: partial.deleted ? true : undefined,
    deletedAt: partial.deletedAt || undefined,
    synthetic: partial.synthetic ? true : undefined,
    firstSeenAt: partial.firstSeenAt || undefined,
    lastSeenAt: partial.lastSeenAt || undefined,
    // 跨工具去重标记：透传（reconcile/merge 时保留）
    dedupExcluded: partial.dedupExcluded ? true : undefined,
    dedupReason: partial.dedupReason || undefined,
    dedupKeptBy: partial.dedupKeptBy || undefined,
    // 本地无 cache 官方记录（freebuff）：命中率统计排除
    noCacheData: partial.noCacheData ? true : undefined,
    estCacheReadTokens: estCacheReadTokens > 0 ? estCacheReadTokens : undefined,
    genMs:
      partial.genMs != null && Number(partial.genMs) > 0
        ? num(partial.genMs)
        : undefined,
    genTokens:
      partial.genTokens != null && Number(partial.genTokens) > 0
        ? num(partial.genTokens)
        : undefined,
    estGenMs:
      partial.estGenMs != null && Number(partial.estGenMs) > 0
        ? num(partial.estGenMs)
        : undefined,
    estGenTokens:
      partial.estGenTokens != null && Number(partial.estGenTokens) > 0
        ? num(partial.estGenTokens)
        : undefined,
  };
}

/**
 * 将带 parentSessionId 的子会话 token 并入父会话，并从列表移除子会话。
 * @param {SessionRecord[]} sessions
 * @returns {SessionRecord[]}
 */
export function mergeChildSessions(sessions) {
  /** @type {Map<string, SessionRecord>} */
  const byKey = new Map();
  for (const s of sessions) byKey.set(`${s.client}:${s.sessionId}`, { ...s });

  /** @type {SessionRecord[]} */
  const children = [];
  for (const s of byKey.values()) {
    // 有 parentSessionId 即视为子会话（不强制 isSubagent）
    if (s.parentSessionId) children.push(s);
  }

  for (const child of children) {
    const parentKey = `${child.client}:${child.parentSessionId}`;
    const parent = byKey.get(parentKey);
    if (!parent) {
      // 父仍不在（ensureDeletedParents 之后极少见）：保留子，标孤儿
      child.isSubagent = true;
      continue;
    }
    child.isSubagent = true;

    parent.inputTokens += child.inputTokens;
    parent.outputTokens += child.outputTokens;
    parent.cacheReadTokens += child.cacheReadTokens;
    parent.cacheWriteTokens += child.cacheWriteTokens;
    if (child.estCacheReadTokens || parent.estCacheReadTokens) {
      parent.estCacheReadTokens =
        (parent.estCacheReadTokens || 0) + (child.estCacheReadTokens || 0);
    }
    if (child.genMs || parent.genMs) {
      parent.genMs = (parent.genMs || 0) + (child.genMs || 0);
      parent.genTokens = (parent.genTokens || 0) + (child.genTokens || 0);
    }
    if (child.estGenMs || parent.estGenMs) {
      parent.estGenMs = (parent.estGenMs || 0) + (child.estGenMs || 0);
      parent.estGenTokens = (parent.estGenTokens || 0) + (child.estGenTokens || 0);
    }
    parent.reasoningTokens += child.reasoningTokens;
    parent.totalTokens = computeTotalTokens(parent);
    parent.messageCount = (parent.messageCount || 0) + (child.messageCount || 0);
    parent.turnCount = (parent.turnCount || 0) + (child.turnCount || 0);
    {
      const pr = (parent.requestCount || 0) + (child.requestCount || 0);
      parent.requestCount = pr > 0 ? pr : undefined;
    }
    {
      const lc =
        (parent.longContextRequests || 0) + (child.longContextRequests || 0);
      parent.longContextRequests = lc > 0 ? lc : undefined;
    }
    if (child.costUsd != null) {
      parent.costUsd = (parent.costUsd || 0) + child.costUsd;
    }
    if (child.costCny != null) {
      parent.costCny = (parent.costCny || 0) + child.costCny;
    }
    if (child.lastUsedAt && (!parent.lastUsedAt || child.lastUsedAt > parent.lastUsedAt)) {
      parent.lastUsedAt = child.lastUsedAt;
    }
    if (child.startedAt && (!parent.startedAt || child.startedAt < parent.startedAt)) {
      parent.startedAt = child.startedAt;
    }
    // 父已删则整条保留「已删除」标记；子若仍存活也不把父改回 live
    if (parent.deleted) {
      parent.deleted = true;
    }
    // 父壳若只有合成元数据、标题空，用子路径补一点上下文
    if (parent.synthetic && !parent.cwd && child.cwd) parent.cwd = child.cwd;
    if (
      parent.synthetic &&
      (!parent.title || parent.title === "已删除父会话") &&
      child.title
    ) {
      parent.title = child.title;
    }

    const merged = parent.mergedChildren || [];
    merged.push(child.sessionId);
    parent.mergedChildren = merged;
    parent.childCount = merged.length;

    byKey.delete(`${child.client}:${child.sessionId}`);
  }

  return [...byKey.values()];
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * @param {number | string | Date | null | undefined} v
 * @returns {string | undefined}
 */
export function toIso(v) {
  if (v == null || v === "") return undefined;
  if (v instanceof Date) {
    return Number.isNaN(v.getTime()) ? undefined : v.toISOString();
  }
  if (typeof v === "number") {
    if (!Number.isFinite(v) || v <= 0) return undefined;
    // < 1e11 → 秒级 Unix（~1973–5138 秒轴）；否则毫秒
    const ms = Math.abs(v) < 1e11 ? v * 1000 : v;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
  }
  if (typeof v === "string") {
    const s = v.trim();
    if (!s) return undefined;
    if (/^\d+(\.\d+)?$/.test(s)) {
      const n = Number(s);
      if (!Number.isFinite(n) || n <= 0) return undefined;
      const ms = Math.abs(n) < 1e11 ? n * 1000 : n;
      const d = new Date(ms);
      return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
    }
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? s : d.toISOString();
  }
  return undefined;
}
