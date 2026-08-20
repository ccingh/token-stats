/**
 * 方案 A：时间范围是唯一全局口径。
 * - range：只汇总时间窗内 turn/小时桶
 * - lifetime-fallback：无小时明细时显示全量并黄标（不计入本区汇总）
 * - lifetime：保留类型兼容；UI 不再提供「生涯累计」全局模式
 * 会话生涯合计通过 lifetimeTotalTokens 作副信息展示。
 */
import type {
  HourlyBucket,
  SessionRecord,
  UsageSource,
} from "./types";
import { modelAggKey } from "./types";

export type UsageMode = "range" | "lifetime";

export type TokenParts = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  cost: number;
  events: number;
  genMs: number;
  genTokens: number;
  estGenMs: number;
  estGenTokens: number;
  estCacheReadTokens: number;
};

export type ScopedSession = SessionRecord & {
  usageSource: UsageSource;
  /** 生涯 total（改写展示字段前备份，便于副文案） */
  lifetimeTotalTokens?: number;
};

export function emptyParts(): TokenParts {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
    cost: 0,
    events: 0,
    genMs: 0,
    genTokens: 0,
    estGenMs: 0,
    estGenTokens: 0,
    estCacheReadTokens: 0,
  };
}

export function addParts(a: TokenParts, b: Partial<TokenParts>): void {
  a.inputTokens += b.inputTokens || 0;
  a.outputTokens += b.outputTokens || 0;
  a.cacheReadTokens += b.cacheReadTokens || 0;
  a.cacheWriteTokens += b.cacheWriteTokens || 0;
  a.reasoningTokens += b.reasoningTokens || 0;
  a.totalTokens += b.totalTokens || 0;
  a.cost += b.cost || 0;
  a.events += b.events || 0;
  a.genMs += b.genMs || 0;
  a.genTokens += b.genTokens || 0;
  a.estGenMs += b.estGenMs || 0;
  a.estGenTokens += b.estGenTokens || 0;
  a.estCacheReadTokens += b.estCacheReadTokens || 0;
}

export function sessionKey(s: { client: string; sessionId: string }): string {
  return `${s.client}:${s.sessionId}`;
}

function dayFromHour(hour: string): string {
  return hour.slice(0, 10);
}

/**
 * 小时桶是否落在时间范围内。
 * - rangeStart / rangeEnd：该日本地正午时间戳；null 表示该侧无界
 * - rangeEnd 含当日全天（正午比较：dayNoon <= rangeEnd）
 * - todayKey 保留参数以兼容调用方（过滤逻辑用起止日即可）
 */
export function hourInRange(
  hour: string,
  rangeStart: number | null,
  _todayKey: string,
  rangeEnd: number | null = null
): boolean {
  if (!hour || hour.length < 13) return false;
  const day = dayFromHour(hour);
  if (day < "2015-01-01" || day > "2100-01-01") return false;
  if (rangeStart == null && rangeEnd == null) return true;
  const t = new Date(`${day}T12:00:00`).getTime();
  if (Number.isNaN(t)) return false;
  if (rangeStart != null && t < rangeStart) return false;
  if (rangeEnd != null && t > rangeEnd) return false;
  return true;
}

export type RangeSessionMap = Map<
  string,
  TokenParts & { client: string; sessionId: string; model?: string }
>;

/**
 * 从 hourly 汇总「每个会话在区间内」的用量。
 * costFn：把小时桶换成显示币成本。
 */
export function buildRangeSessionUsage(
  hourly: HourlyBucket[],
  rangeStart: number | null,
  todayKey: string,
  activeClients: Set<string>,
  costFn: (row: HourlyBucket) => number,
  rangeEnd: number | null = null
): RangeSessionMap {
  const map: RangeSessionMap = new Map();
  for (const row of hourly) {
    if (!activeClients.has(row.client)) continue;
    if (!hourInRange(row.hour, rangeStart, todayKey, rangeEnd)) continue;
    const sid = row.sessionId != null ? String(row.sessionId).trim() : "";
    if (!sid) continue;
    const key = `${row.client}:${sid}`;
    let e = map.get(key);
    if (!e) {
      e = {
        ...emptyParts(),
        client: row.client,
        sessionId: sid,
        model: row.model,
      };
      map.set(key, e);
    }
    addParts(e, {
      inputTokens: row.inputTokens || 0,
      outputTokens: row.outputTokens || 0,
      cacheReadTokens: row.cacheReadTokens || 0,
      cacheWriteTokens: row.cacheWriteTokens || 0,
      reasoningTokens: row.reasoningTokens || 0,
      totalTokens: row.totalTokens || 0,
      cost: costFn(row),
      events: row.events || 0,
      genMs: row.genMs || 0,
      genTokens: row.genTokens || 0,
      estGenMs: row.estGenMs || 0,
      estGenTokens: row.estGenTokens || 0,
      estCacheReadTokens: row.estCacheReadTokens || 0,
    });
    if (row.model) e.model = row.model;
  }
  return map;
}

/**
 * 是否有任意小时桶带 sessionId（能做区间拆分）。
 */
export function hasSessionHourly(hourly: HourlyBucket[] | undefined): boolean {
  return !!hourly?.some((h) => h.sessionId && (h.totalTokens || 0) > 0);
}

/** 是否有任意区间内小时桶（不要求 sessionId） */
export function hasAnyHourlyInRange(
  hourly: HourlyBucket[] | undefined,
  rangeStart: number | null,
  todayKey: string,
  activeClients: Set<string>,
  rangeEnd: number | null = null
): boolean {
  if (!hourly?.length) return false;
  return hourly.some(
    (h) =>
      activeClients.has(h.client) &&
      (h.totalTokens || 0) > 0 &&
      hourInRange(h.hour, rangeStart, todayKey, rangeEnd)
  );
}

export type DimTotals = Map<string, TokenParts>;

/**
 * 按小时桶汇总区间内的 工具 / 模型 / 日 维度（不依赖会话 lastUsedAt）。
 * sessionsByModel：按小时桶 model+sessionId 去重，不用会话表最后一次 model。
 */
export function buildHourlyDimTotals(
  hourly: HourlyBucket[],
  rangeStart: number | null,
  todayKey: string,
  activeClients: Set<string>,
  costFn: (row: HourlyBucket) => number,
  rangeEnd: number | null = null
): {
  byClient: DimTotals;
  byModel: DimTotals;
  byDay: DimTotals;
  sessionsByModel: Map<string, number>;
  total: TokenParts;
  withSessionId: number;
  withoutSessionId: number;
} {
  const byClient: DimTotals = new Map();
  const byModel: DimTotals = new Map();
  const byDay: DimTotals = new Map();
  const modelSessionSets = new Map<string, Set<string>>();
  const total = emptyParts();
  let withSessionId = 0;
  let withoutSessionId = 0;

  const bump = (map: DimTotals, key: string, parts: Partial<TokenParts>) => {
    let e = map.get(key);
    if (!e) {
      e = emptyParts();
      map.set(key, e);
    }
    addParts(e, parts);
  };

  for (const row of hourly) {
    if (!activeClients.has(row.client)) continue;
    if (!hourInRange(row.hour, rangeStart, todayKey, rangeEnd)) continue;
    const tok = row.totalTokens || 0;
    const genMs = row.genMs || 0;
    const estGenMs = row.estGenMs || 0;
    if (tok <= 0 && genMs <= 0 && estGenMs <= 0) continue;
    const parts = {
      inputTokens: row.inputTokens || 0,
      outputTokens: row.outputTokens || 0,
      cacheReadTokens: row.cacheReadTokens || 0,
      cacheWriteTokens: row.cacheWriteTokens || 0,
      reasoningTokens: row.reasoningTokens || 0,
      totalTokens: tok,
      cost: costFn(row),
      events: row.events || 0,
      genMs: row.genMs || 0,
      genTokens: row.genTokens || 0,
      estGenMs: row.estGenMs || 0,
      estGenTokens: row.estGenTokens || 0,
      estCacheReadTokens: row.estCacheReadTokens || 0,
    };
    addParts(total, parts);
    bump(byClient, row.client || "未知工具", parts);
    const modelKey =
      modelAggKey(row.model) ||
      (row.model && String(row.model).trim()) ||
      "未知模型";
    bump(byModel, modelKey, parts);
    bump(byDay, dayFromHour(row.hour), parts);
    const sid = row.sessionId != null ? String(row.sessionId).trim() : "";
    if (sid) {
      withSessionId += tok;
      let set = modelSessionSets.get(modelKey);
      if (!set) {
        set = new Set();
        modelSessionSets.set(modelKey, set);
      }
      set.add(`${row.client}:${sid}`);
    } else {
      withoutSessionId += tok;
    }
  }

  const sessionsByModel = new Map<string, number>();
  for (const [k, set] of modelSessionSets) {
    sessionsByModel.set(k, set.size);
  }

  return {
    byClient,
    byModel,
    byDay,
    sessionsByModel,
    total,
    withSessionId,
    withoutSessionId,
  };
}

/**
 * 「本区间」汇总用的会话集：
 * - lifetime / 无法拆分：用全部 scoped
 * - range 且可拆：只取 usageSource=range，避免「全量兜底」把 110M 灌进本区间 Top
 *   （兜底会话仍出现在会话列表，带黄标）
 */
export function sessionsForRangeAgg(
  scoped: ScopedSession[],
  mode: UsageMode,
  canSplit: boolean
): ScopedSession[] {
  if (mode === "lifetime" || !canSplit) return scoped;
  const onlyRange = scoped.filter((s) => s.usageSource === "range");
  // 完全没有任何可拆会话时，退回全部（全是黄标兜底）
  return onlyRange.length > 0 ? onlyRange : scoped;
}

/**
 * 某一天内各会话的用量（key = client:sessionId）。
 * 用于「按天」展开列表：只显示该日真实发生，不是会话生涯。
 */
export function buildSessionUsageOnDay(
  hourly: HourlyBucket[],
  day: string,
  activeClients: Set<string>,
  costFn?: (row: HourlyBucket) => number
): Map<string, TokenParts & { client: string; sessionId: string; model?: string }> {
  const map = new Map<
    string,
    TokenParts & { client: string; sessionId: string; model?: string }
  >();
  if (!day || day.length < 10) return map;
  for (const row of hourly) {
    if (!activeClients.has(row.client)) continue;
    if (!row.hour.startsWith(day)) continue;
    const sid = row.sessionId != null ? String(row.sessionId).trim() : "";
    if (!sid) continue;
    const tok = row.totalTokens || 0;
    if (tok <= 0) continue;
    const key = `${row.client}:${sid}`;
    let e = map.get(key);
    if (!e) {
      e = {
        ...emptyParts(),
        client: row.client,
        sessionId: sid,
        model: row.model,
      };
      map.set(key, e);
    }
    addParts(e, {
      inputTokens: row.inputTokens || 0,
      outputTokens: row.outputTokens || 0,
      cacheReadTokens: row.cacheReadTokens || 0,
      cacheWriteTokens: row.cacheWriteTokens || 0,
      reasoningTokens: row.reasoningTokens || 0,
      totalTokens: tok,
      cost: costFn ? costFn(row) : 0,
      events: row.events || 0,
      genMs: row.genMs || 0,
      genTokens: row.genTokens || 0,
      estGenMs: row.estGenMs || 0,
      estGenTokens: row.estGenTokens || 0,
      estCacheReadTokens: row.estCacheReadTokens || 0,
    });
    if (row.model) e.model = row.model;
  }
  return map;
}

/**
 * 项目维度区间用量：hourly(sessionId) → 会话 cwd。
 * 不经过「会话全量」字段，避免 Top 项目被生涯 110M 污染。
 * 无 sessionId / 找不到会话 的桶归入「未归属项目」。
 */
export function buildProjectTokensFromHourly(
  hourly: HourlyBucket[],
  sessions: SessionRecord[],
  rangeStart: number | null,
  todayKey: string,
  activeClients: Set<string>,
  rangeEnd: number | null = null
): Map<string, number> {
  const byKey = new Map<string, SessionRecord>();
  for (const s of sessions) {
    byKey.set(sessionKey(s), s);
  }
  const byCwd = new Map<string, number>();
  for (const row of hourly) {
    if (!activeClients.has(row.client)) continue;
    if (!hourInRange(row.hour, rangeStart, todayKey, rangeEnd)) continue;
    const tok = row.totalTokens || 0;
    if (tok <= 0) continue;
    const sid = row.sessionId != null ? String(row.sessionId).trim() : "";
    let cwd = "未归属项目";
    if (sid) {
      const s = byKey.get(`${row.client}:${sid}`);
      if (s?.cwd) cwd = s.cwd;
    }
    byCwd.set(cwd, (byCwd.get(cwd) || 0) + tok);
  }
  return byCwd;
}

/**
 * 生成当前视图下的会话列表（已应用区间/生涯口径）。
 *
 * @param allowed 已过工具/隐藏/搜索筛选（不限日期）— range 归因命中时从此取 meta
 * @param ranged  另过时间窗（lastUsedAt）— lifetime 模式主列表；range 模式 fallback 来源
 */
export function applyUsageScope(
  allowed: SessionRecord[],
  ranged: SessionRecord[],
  mode: UsageMode,
  rangeSessionUsage: RangeSessionMap,
  opts: {
    canSplit: boolean;
    includeFallback: boolean;
    currency: "USD" | "CNY";
  }
): ScopedSession[] {
  if (mode === "lifetime" || !opts.canSplit) {
    const src: UsageSource = opts.canSplit ? "lifetime" : "lifetime-fallback";
    return ranged.map((s) => ({
      ...s,
      usageSource: src,
      lifetimeTotalTokens: s.totalTokens,
    }));
  }

  const allowedByKey = new Map<string, SessionRecord>();
  for (const s of allowed) allowedByKey.set(sessionKey(s), s);

  const out: ScopedSession[] = [];
  const seen = new Set<string>();

  const costFields = (amount: number | undefined) => {
    if (amount == null || !(amount > 0)) {
      return {
        costUsd: undefined as number | undefined,
        costCny: undefined as number | undefined,
      };
    }
    return opts.currency === "CNY"
      ? { costUsd: undefined, costCny: amount }
      : { costUsd: amount, costCny: undefined };
  };

  // 1) 区间内有 turn 用量的会话
  for (const [key, u] of rangeSessionUsage) {
    if (u.totalTokens <= 0) continue;
    const s = allowedByKey.get(key);
    if (!s) continue;
    seen.add(key);
    const c = costFields(u.cost);
    out.push({
      ...s,
      inputTokens: u.inputTokens,
      outputTokens: u.outputTokens,
      cacheReadTokens: u.cacheReadTokens,
      cacheWriteTokens: u.cacheWriteTokens,
      reasoningTokens: u.reasoningTokens,
      totalTokens: u.totalTokens,
      // 区间请求数 = 小时桶 events（每条模型请求 +1；Grok 可按 modelCalls 加权）
      requestCount: u.events > 0 ? u.events : s.requestCount,
      genMs: u.genMs || undefined,
      genTokens: u.genTokens || undefined,
      estGenMs: u.estGenMs || undefined,
      estGenTokens: u.estGenTokens || undefined,
      estCacheReadTokens:
        (u.estCacheReadTokens || 0) > 0
          ? u.estCacheReadTokens
          : s.estCacheReadTokens,
      costUsd: c.costUsd,
      costCny: c.costCny,
      usageSource: "range",
      lifetimeTotalTokens: s.totalTokens,
    });
  }

  // 2) 兜底：时间窗内有活跃、但无小时拆分
  if (opts.includeFallback) {
    for (const s of ranged) {
      const key = sessionKey(s);
      if (seen.has(key)) continue;
      if (!allowedByKey.has(key)) continue;
      out.push({
        ...s,
        usageSource: "lifetime-fallback",
        lifetimeTotalTokens: s.totalTokens,
      });
    }
  }

  return out;
}

export function usageSourceLabel(src: UsageSource): string {
  switch (src) {
    case "range":
      return "区间";
    case "lifetime":
      return "生涯";
    case "lifetime-fallback":
      return "全量·未拆分";
  }
}
