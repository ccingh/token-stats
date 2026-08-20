export type Quality = "full" | "partial" | "metadata_only" | "no_model" | string;

export interface SessionRecord {
  id: string;
  client: string;
  sessionId: string;
  title?: string;
  cwd?: string;
  /** 模型主名（不含思考档位） */
  model?: string;
  /** 思考档位 max/high/…，仅展示 */
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
  costCny?: number;
  quality?: Quality;
  scannedAt?: string;
  parentSessionId?: string;
  isSubagent?: boolean;
  agentName?: string;
  sessionKind?: string;
  turnCount?: number;
  /** 模型/API 请求次数（区间视图下可能来自 hourly.events） */
  requestCount?: number;
  /** 命中长上下文档的请求数 */
  longContextRequests?: number;
  mergedChildren?: string[];
  childCount?: number;
  deleted?: boolean;
  deletedAt?: string;
  synthetic?: boolean;
  firstSeenAt?: string;
  lastSeenAt?: string;
  /** 跨工具去重：本条被排除（手机端暂不展示） */
  dedupExcluded?: boolean;
  dedupReason?: string;
  dedupKeptBy?: string;
  /** 本地无 cache 官方记录（如 freebuff）：命中率统计应排除 */
  noCacheData?: boolean;
  /** 仅展示用的估算 cache，不计入 cacheRead / 官方命中率（计入 total） */
  estCacheReadTokens?: number;
  genMs?: number;
  genTokens?: number;
  estGenMs?: number;
  estGenTokens?: number;
}

export interface HourlyBucket {
  hour: string;
  client: string;
  model?: string;
  sessionId?: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  events?: number;
  costUsd?: number;
  costCny?: number;
  genMs?: number;
  genTokens?: number;
  estGenMs?: number;
  estGenTokens?: number;
  /** 仅展示用估算 cache（freebuff），不计入 cacheRead */
  estCacheReadTokens?: number;
}

/** 会话用量口径：区间 / 生涯 / 无法拆分时的全量兜底 */
export type UsageSource = "range" | "lifetime" | "lifetime-fallback";

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

export interface SnapshotPayload {
  scannedAt?: string;
  durationMs?: number;
  reports?: AdapterReport[];
  totals?: Partial<Totals>;
  sessions?: SessionRecord[];
  hourly?: HourlyBucket[];
  appVersion?: string;
}

export interface SnapshotRow {
  user_id: string;
  payload: SnapshotPayload;
  session_count: number;
  total_tokens: number;
  cost_usd: number | null;
  device_label: string | null;
  updated_at: string;
}

export interface AppSettings {
  supabaseUrl: string;
  supabaseAnonKey: string;
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

export function normalizeModelVariant(v?: string | null): string | undefined {
  if (v == null) return undefined;
  const t = String(v).trim();
  if (!t) return undefined;
  const low = t.toLowerCase();
  if (low === "default" || low === "none" || low === "null") return undefined;
  return low;
}

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

export function modelAggKey(raw?: string | null): string {
  return splitModelParts(raw).base || "";
}

/** 展示主名（不含思考档位） */
export function prettyModel(raw?: string | null): string {
  return modelAggKey(raw) || "";
}

export function prettyModelVariant(
  model?: string | null,
  explicit?: string | null
): string | undefined {
  return normalizeModelVariant(explicit) || splitModelParts(model).variant;
}

export function sanitizeSnapshotPayload(
  payload: SnapshotPayload | undefined | null
): SnapshotPayload | undefined {
  if (!payload) return payload ?? undefined;
  return {
    ...payload,
    sessions: (payload.sessions || []).map((s) => {
      const parts = splitModelParts(s.model);
      const base = parts.base || s.model;
      const variant =
        parts.variant || normalizeModelVariant(s.modelVariant) || undefined;
      if (base === s.model && variant === s.modelVariant) return s;
      return { ...s, model: base || s.model, modelVariant: variant };
    }),
    hourly: payload.hourly?.map((h) => {
      const base = modelAggKey(h.model) || h.model;
      return base && base !== h.model ? { ...h, model: base } : h;
    }),
  };
}

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
