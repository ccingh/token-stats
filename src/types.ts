export type Quality = "full" | "partial" | "metadata_only" | "no_model";

export interface SessionRecord {
  id: string;
  client: string;
  sessionId: string;
  title?: string;
  cwd?: string;
  /** 模型主名（不含思考档位） */
  model?: string;
  /** 思考档位 max/high/…，仅展示用 */
  modelVariant?: string;
  startedAt?: string;
  lastUsedAt?: string;
  messageCount?: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  costUsd?: number;
  /** 官方人民币刊例价直接算出的成本（无则为 undefined，前端按汇率折算 costUsd） */
  costCny?: number;
  quality: Quality;
  scannedAt: string;
  parentSessionId?: string;
  isSubagent?: boolean;
  agentName?: string;
  sessionKind?: string;
  turnCount?: number;
  /** 模型/API 请求次数（区间视图下可能来自 hourly.events） */
  requestCount?: number;
  /** 命中长上下文档的请求数（Grok prompt ≥200k 等） */
  longContextRequests?: number;
  mergedChildren?: string[];
  childCount?: number;
  /** 源日志已不存在，来自本地持久化快照 */
  deleted?: boolean;
  deletedAt?: string;
  /** 从未扫到父、仅为并账生成的壳 */
  synthetic?: boolean;
  firstSeenAt?: string;
  lastSeenAt?: string;
  /** 跨工具去重：本条被排除，不计入总额（标记而非删除） */
  dedupExcluded?: boolean;
  /** 去重原因，如 "duplicate_session_id:<胜出client>" */
  dedupReason?: string;
  /** "client:sessionId"，指向保留的那条（便于跳转） */
  dedupKeptBy?: string;
  /** 本地无 cache 官方记录（如 freebuff）：命中率统计应排除 */
  noCacheData?: boolean;
  /** 仅展示用的估算 cache，不计入 cacheRead / 官方命中率（计入 total） */
  estCacheReadTokens?: number;
  /** 有耗时记录的模型请求墙钟合计（ms，含 TTFT） */
  genMs?: number;
  /** 与 genMs 配对的 output+reasoning */
  genTokens?: number;
  /** 非官方估算耗时，不进汇总 tok/s */
  estGenMs?: number;
  estGenTokens?: number;
}

/** 跨工具去重报告（扫描详情展示用） */
export interface DedupReport {
  sessionId: string;
  keptClient: string;
  excludedClients: string[];
  reason: string;
  savedTotalTokens: number;
  savedCostUsd: number;
}

export interface TurnDetail {
  index: number;
  ts?: string;
  /** 模型主名 */
  model?: string;
  /** 思考档位（附属展示） */
  modelVariant?: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  loopIndex?: number;
  /** 这一次模型调用墙钟（ms，含 TTFT） */
  durationMs?: number;
  /** 非官方估算耗时（不进汇总 tok/s） */
  estDurationMs?: number;
  /** 仅展示用估算 cache（freebuff），不计入 cacheRead */
  estCacheReadTokens?: number;
  /** 来自子 agent / 子会话 */
  isSubagent?: boolean;
  /** 子 agent 名（explore / general 等） */
  agentName?: string;
  /** 子会话 id */
  sourceSessionId?: string;
}

export interface ModelTrace {
  model: string;
  turns: number;
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
  reasoning?: number;
  /** 仅展示用估算 cache */
  estCache?: number;
}

/** 按 agent 角色汇总（plan / build / explore 等） */
export interface AgentTrace {
  agent: string;
  turns: number;
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
  reasoning?: number;
  estCache?: number;
  isSubagent?: boolean;
}

export interface SessionDetail {
  client: string;
  sessionId: string;
  title?: string;
  agentName?: string;
  sessionKind?: string;
  turns: TurnDetail[];
  models: ModelTrace[];
  /** 各 agent 用量汇总 */
  agents?: AgentTrace[];
  note?: string;
  meta?: Record<string, unknown>;
  /** 子 agent turn 数（若有） */
  childTurnCount?: number;
  parentTurnCount?: number;
}

/** 对话正文中的一块（文本 / 思考 / 工具） */
export type TranscriptPartType =
  | "text"
  | "thinking"
  | "tool_call"
  | "tool_result"
  | "system"
  | "other";

export interface TranscriptPart {
  type: TranscriptPartType;
  text?: string;
  toolName?: string;
  toolId?: string;
  input?: string;
  output?: string;
  collapsedByDefault?: boolean;
}

export type TranscriptRole =
  | "user"
  | "assistant"
  | "system"
  | "tool"
  | "reasoning";

export interface TranscriptMessage {
  id?: string;
  index: number;
  role: TranscriptRole;
  ts?: string;
  model?: string;
  parts: TranscriptPart[];
  isSubagent?: boolean;
  agentName?: string;
  sourceSessionId?: string;
}

/** 会话对话正文（仅桌面本地读取，不同步） */
export interface SessionTranscript {
  client: string;
  sessionId: string;
  title?: string;
  messages: TranscriptMessage[];
  truncated?: boolean;
  note?: string;
  unsupported?: boolean;
  messageCount?: number;
}

export interface AdapterReport {
  id: string;
  displayName: string;
  detected: boolean;
  count: number;
  error?: string;
  ms: number;
}

export interface Totals {
  sessions: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  costUsd: number;
  /** 模型请求次数（扫描全量合计；前端区间优先用 hourly.events） */
  requestCount?: number;
  deletedSessions?: number;
}

/** 按 turn 时间聚合的小时用量（本地时区 hour = YYYY-MM-DDTHH） */
export interface HourlyBucket {
  hour: string;
  client: string;
  /** 该桶对应模型；未知时为「未知模型」 */
  model?: string;
  /** 来源会话 id（有则区间统计可按会话/项目拆分） */
  sessionId?: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  events?: number;
  /** 按该桶模型 + token 构成估算的美元成本（扫描时写入） */
  costUsd?: number;
  /** 有官方人民币刊例时的 CNY 成本 */
  costCny?: number;
  /** 本桶内命中长上下文档的请求数 */
  longContextEvents?: number;
  /** 有耗时记录的模型请求墙钟合计（ms） */
  genMs?: number;
  /** 与 genMs 配对的 output+reasoning */
  genTokens?: number;
  estGenMs?: number;
  estGenTokens?: number;
  /** 仅展示用估算 cache（freebuff），不计入 cacheRead */
  estCacheReadTokens?: number;
}

/** 展示用量来源：时间窗可拆 / 会话全量（兼容）/ 无法拆分时的全量兜底 */
export type UsageSource = "range" | "lifetime" | "lifetime-fallback";

export interface UnpricedModel {
  model: string;
  sessions: number;
  totalTokens: number;
}

export interface PriceFields {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
}

export interface ModelPriceFields extends PriceFields {
  cny?: PriceFields;
}

export interface PriceOverrides {
  version: 1;
  updatedAt?: string | null;
  models: Record<string, ModelPriceFields>;
  aliases: Record<string, string>;
}

export type PricingSource = "builtin" | "user" | "override";

export interface PricingCatalogRow {
  key: string;
  source: PricingSource;
  price: ModelPriceFields;
  builtinPrice?: ModelPriceFields | null;
  aliases: string[];
}

export interface ScanResult {
  scannedAt: string;
  durationMs: number;
  reports: AdapterReport[];
  totals: Totals;
  /** 跨工具去重报告（命中时非空） */
  dedupReports?: DedupReport[];
  sessions: SessionRecord[];
  /** 按推理/turn 时间的小时桶；趋势图优先用它 */
  hourly?: HourlyBucket[];
  /** 当前价目表（含用户覆盖）仍查不到单价的模型 */
  unpricedModels?: UnpricedModel[];
  /** 用户覆盖文件损坏时的提示（扫描仍用内置价） */
  pricingLoadError?: string;
  error?: string;
  storePath?: string;
  liveCount?: number;
  persistedCount?: number;
}

/** Kimi Code：登录 `kimi-code/`，旧 API `kimi-for-coding/`。无斜杠的 kimi-for-coding 是 K2.7，不剥。 */
function cleanModelBase(id: string): string {
  let s = String(id || "")
    .replace(/-build$/, "")
    .trim();
  const m = s.match(/^(kimi-code|kimi-for-coding)\//i);
  if (m) {
    const tail = s.slice(m[0].length).trim();
    if (tail) s = tail;
  }
  return s;
}

/** 思考档位规范化 */
export function normalizeModelVariant(v?: string | null): string | undefined {
  if (v == null) return undefined;
  const t = String(v).trim();
  if (!t) return undefined;
  const low = t.toLowerCase();
  if (low === "default" || low === "none" || low === "null") return undefined;
  return low;
}

/**
 * 拆模型主名 + 思考档位。
 * 档位是附属条件，不参与「按模型」统计键。
 */
export function splitModelParts(raw?: string | null): {
  base?: string;
  variant?: string;
} {
  if (raw == null) return {};
  const s = String(raw).trim();
  if (!s) return {};
  if (s === "未知模型" || s === "（未知模型）" || s === "(未知模型)") {
    return { base: "未知模型" };
  }

  if (s.startsWith("{")) {
    try {
      const o = JSON.parse(s) as Record<string, unknown>;
      if (o && typeof o === "object") {
        const id =
          o.id ??
          o.modelID ??
          o.modelId ??
          o.model_id ??
          (typeof o.model === "string" ? o.model : undefined);
        if (id != null && String(id).trim()) {
          return {
            base: cleanModelBase(String(id)),
            variant: normalizeModelVariant(
              o.variant != null ? String(o.variant) : undefined
            ),
          };
        }
      }
    } catch {
      const idM =
        s.match(/"id"\s*:\s*"([^"]+)"/i) ||
        s.match(/"modelID"\s*:\s*"([^"]+)"/i) ||
        s.match(/"modelId"\s*:\s*"([^"]+)"/i);
      if (idM) {
        const vM = s.match(/"variant"\s*:\s*"([^"]+)"/i);
        return {
          base: cleanModelBase(idM[1]),
          variant: normalizeModelVariant(vM?.[1]),
        };
      }
    }
  }

  const dot = s.indexOf("·");
  if (dot >= 0) {
    return {
      base: cleanModelBase(s.slice(0, dot)),
      variant: normalizeModelVariant(s.slice(dot + 1)),
    };
  }
  return { base: cleanModelBase(s) };
}

/** 统计用模型键：仅主名 */
export function modelAggKey(raw?: string | null): string {
  return splitModelParts(raw).base || "";
}

/** 展示用主名（不含档位） */
export function prettyModel(raw?: string | null): string {
  return modelAggKey(raw) || "";
}

/** 展示用思考档位 */
export function prettyModelVariant(
  model?: string | null,
  explicit?: string | null
): string | undefined {
  return (
    normalizeModelVariant(explicit) || splitModelParts(model).variant
  );
}

/** 扫描结果：model 统一主名，档位进 modelVariant（兼容旧 ` · max` 串） */
export function sanitizeScanResult(data: ScanResult): ScanResult {
  return {
    ...data,
    sessions: (data.sessions || []).map((s) => {
      const parts = splitModelParts(s.model);
      const base = parts.base || s.model;
      const variant =
        parts.variant || normalizeModelVariant(s.modelVariant) || undefined;
      if (base === s.model && variant === s.modelVariant) return s;
      return { ...s, model: base || s.model, modelVariant: variant };
    }),
    hourly: data.hourly?.map((h) => {
      const base = modelAggKey(h.model) || h.model;
      return base && base !== h.model ? { ...h, model: base } : h;
    }),
  };
}

/** 加权 tok/s：只除有耗时记录的生成量。 */
export function tokensPerSec(
  genTokens?: number | null,
  genMs?: number | null
): number | null {
  const t = Number(genTokens) || 0;
  const ms = Number(genMs) || 0;
  if (t <= 0 || ms < 50) return null;
  return t / (ms / 1000);
}

function formatSpeedNumber(n: number): string {
  if (n >= 100) return `${Math.round(n)}/s`;
  if (n >= 10) return `${n.toFixed(1)}/s`;
  return `${n.toFixed(2)}/s`;
}

export function formatTokPerSec(
  n: number | null | undefined,
  est?: number | null
): string {
  if (n != null && Number.isFinite(n) && n > 0) return formatSpeedNumber(n);
  if (est != null && Number.isFinite(est) && est > 0) {
    return `–（${formatSpeedNumber(est)}）`;
  }
  return "–";
}
