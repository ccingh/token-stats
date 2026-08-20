import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useState,
  type MouseEvent,
  type ReactNode,
} from "react";
import { getUsdCny, type FxRate } from "./fx";
import {
  computeLifetimeInsights,
  formatHourRange,
  weekdayNameMonFirst,
} from "./insights";
import PricingPanel from "./PricingPanel";
import SearchBox from "./SearchBox";
import SessionDetailPanel from "./SessionDetail";
import SyncPanel from "./SyncPanel";
import { matchesSession } from "./searchMatch";
import type { ScanResult, SessionRecord, UsageSource } from "./types";
import {
  formatTokPerSec,
  modelAggKey,
  prettyModel,
  prettyModelVariant,
  sanitizeScanResult,
  tokensPerSec,
} from "./types";
import {
  applyUsageScope,
  buildHourlyDimTotals,
  buildProjectTokensFromHourly,
  buildRangeSessionUsage,
  buildSessionUsageOnDay,
  hasSessionHourly,
  sessionsForRangeAgg,
  usageSourceLabel,
  type ScopedSession,
} from "./usageScope";

/** 无同步安装包构建时 VITE_ENABLE_SYNC=false，隐藏云同步入口 */
const ENABLE_SYNC = import.meta.env.VITE_ENABLE_SYNC !== "false";

const CLIENT_ORDER = [
  "opencode",
  "claude",
  "codex",
  "grok",
  "kimi",
  "zcode",
  "pi",
  "reasonix",
  "mimocode",
  "dsh",
  "freebuff",
] as const;

/** 界面展示名（筛选仍用 client id） */
const CLIENT_LABELS: Record<(typeof CLIENT_ORDER)[number], string> = {
  opencode: "OpenCode",
  claude: "Claude",
  codex: "Codex",
  grok: "Grok Build",
  kimi: "Kimi",
  zcode: "ZCode",
  pi: "Pi",
  reasonix: "Reasonix",
  mimocode: "MiMo Code",
  dsh: "DeepSeek Harness",
  freebuff: "Freebuff",
};

const RANGES = [
  { id: "today", label: "今天", days: 1 },
  { id: "week", label: "7 天", days: 7 },
  { id: "month", label: "30 天", days: 30 },
  { id: "all", label: "全部", days: 0 },
  { id: "custom", label: "自定义", days: -1 },
] as const;

type RangeId = (typeof RANGES)[number]["id"];

/** 区间与生涯差得很小时不展示副数字（扫描路径差异，非真漏账） */
function isMeaningfulLifetimeGap(
  rangeTok: number,
  lifeTok: number | undefined | null
): boolean {
  if (lifeTok == null || !(lifeTok > 0)) return false;
  const gap = lifeTok - rangeTok;
  if (gap <= 0) return false;
  // 绝对差 < 5 万 且 相对差 < 1% → 视为正常误差
  if (gap < 50_000 && gap / lifeTok < 0.01) return false;
  return true;
}

function defaultCustomRange(): { from: string; to: string } {
  const to = new Date();
  to.setHours(0, 0, 0, 0);
  const from = new Date(to);
  from.setDate(from.getDate() - 6);
  const fmt = (d: Date) => {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  };
  return { from: fmt(from), to: fmt(to) };
}

const VIEWS = [
  { id: "overview", label: "概览" },
  { id: "tools", label: "按工具" },
  { id: "projects", label: "按项目" },
  { id: "models", label: "按模型" },
  { id: "daily", label: "按天" },
  { id: "sessions", label: "会话" },
] as const;

/** home = 隐藏首页（生涯）；不在顶栏 tabs 里，仅启动 / 点 logo 进入 */
type ViewId = "home" | (typeof VIEWS)[number]["id"];

type SortKey =
  | "time"
  | "total"
  | "cost"
  | "input"
  | "output"
  | "hit"
  | "requests"
  | "turns"
  | "msgs"
  | "speed";

/** 从分类表下钻到会话列表的筛选 */
type DrillFilter =
  | { kind: "client"; id: string }
  | { kind: "model"; model: string }
  | { kind: "project"; cwd: string; label?: string }
  | { kind: "day"; day: string };

function drillCaption(d: DrillFilter): string {
  switch (d.kind) {
    case "client":
      return `工具 · ${CLIENT_LABELS[d.id as (typeof CLIENT_ORDER)[number]] || d.id}`;
    case "model":
      return `模型 · ${d.model}`;
    case "project":
      return `项目 · ${d.label || d.cwd.split(/[\\/]/).filter(Boolean).pop() || d.cwd}`;
    case "day":
      return `日期 · ${d.day}`;
  }
}

function matchesDrill(s: SessionRecord, drill: DrillFilter | null): boolean {
  if (!drill) return true;
  switch (drill.kind) {
    case "client":
      return s.client === drill.id;
    case "model":
      return (
        (modelAggKey(s.model) || s.model || UNKNOWN_MODEL) === drill.model
      );
    case "project": {
      const cwd = s.cwd || "未知目录";
      return cwd === drill.cwd;
    }
    case "day": {
      const iso = sessionDate(s);
      if (!iso) return false;
      return dayKey(iso) === drill.day;
    }
  }
}

/** 模型分布条的取色盘（降饱和，与整体色调一致） */
const UNKNOWN_MODEL = "未知模型";
/** 未知模型展示用灰（深色底上仍清晰） */
const UNKNOWN_MODEL_COLOR = "#a8a8b3";

function UnpricedBanner({
  items,
  loadError,
  onOpen,
}: {
  items?: { model: string; sessions: number; totalTokens: number }[];
  loadError?: string;
  onOpen: (models: string[]) => void;
}) {
  if (loadError) {
    return (
      <button type="button" className="unpriced-banner warn" onClick={() => onOpen([])}>
        价格覆盖文件无法读取，已改用内置刊例 · 打开价格设置
      </button>
    );
  }
  if (!items?.length) return null;
  const names = items.slice(0, 3).map((i) => i.model).join("、");
  const extra = items.length > 3 ? ` 等 ${items.length} 个` : "";
  return (
    <button
      type="button"
      className="unpriced-banner"
      onClick={() => onOpen(items.map((i) => i.model))}
    >
      {items.length} 个模型没有价格（{names}
      {extra}）· 花费未计入 · 去定价
    </button>
  );
}

function isUnknownModel(name?: string | null): boolean {
  if (name == null || !String(name).trim()) return true;
  const s = String(name).trim();
  return (
    s === UNKNOWN_MODEL ||
    s === "（未知模型）" ||
    s === "(未知模型)" ||
    s === "（未知）" ||
    s === "未知" ||
    s === "<synthetic>" ||
    /^<?synthetic>?$/i.test(s)
  );
}

/** 思考档位色：附属标记，不参与模型身份 */
function variantTone(
  v?: string | null
): "max" | "high" | "low" | "other" | null {
  if (!v) return null;
  const t = v.toLowerCase();
  if (t === "max" || t === "xhigh" || t === "extra-high") return "max";
  if (t === "high") return "high";
  if (t === "low" || t === "fast" || t === "minimal") return "low";
  return "other";
}

function ModelNameWithVariant({
  model,
  variant,
}: {
  model?: string | null;
  variant?: string | null;
}) {
  const base = prettyModel(model) || model || UNKNOWN_MODEL;
  const v = prettyModelVariant(model, variant);
  const tone = variantTone(v);
  return (
    <span className="model-with-variant">
      <span className="model-base-name">{base}</span>
      {v && tone ? (
        <span className={`variant-chip variant-${tone}`} title={`思考档位 · ${v}`}>
          {v}
        </span>
      ) : null}
    </span>
  );
}

const MODEL_PALETTE = [
  "#35b586",
  "#d98e5f",
  "#9385d9",
  "#5ea3c7",
  "#c97698",
  "#4aa79b",
  "#a3a86a",
  "#8a8f98",
];

/** 星期偏好柱色（周一→周日） */
const WEEKDAY_COLORS = [
  "#5b8def",
  "#35b586",
  "#e8a54b",
  "#9385d9",
  "#c97698",
  "#5ea3c7",
  "#d98e5f",
];

function formatTokens(n: number): string {
  if (!Number.isFinite(n)) return "–";
  if (Math.abs(n) >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)}B`;
  if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (Math.abs(n) >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(Math.round(n));
}

/**
 * 缓存命中率 = Cache Read / (Input + Cache Read)
 * Input 为未命中部分时与各 adapter 口径一致；分母为 0 返回 null。
 * noCacheData 为 true 时（freebuff 等本地无 cache 记录）直接返回 null，
 * 不参与命中率统计，避免 input 拉低整体命中率。
 */
function cacheHitRate(
  inputTokens?: number,
  cacheReadTokens?: number,
  noCacheData?: boolean
): number | null {
  if (noCacheData) return null;
  const input = Math.max(0, Number(inputTokens) || 0);
  const cache = Math.max(0, Number(cacheReadTokens) || 0);
  const denom = input + cache;
  if (denom <= 0) return null;
  return cache / denom;
}

function pctLabel(rate: number): string {
  return `${Math.round(rate * 100)}%`;
}

function hitRateSplit(
  rate: number | null | undefined,
  overall?: number | null
): { primary: string; extra: string | null } {
  const official =
    rate != null && Number.isFinite(rate) ? pctLabel(rate) : null;
  const withEst =
    overall != null && Number.isFinite(overall) ? pctLabel(overall) : null;
  if (official && withEst) {
    if (Math.round(rate! * 100) === Math.round(overall! * 100)) {
      return { primary: official, extra: null };
    }
    return { primary: official, extra: withEst };
  }
  if (official) return { primary: official, extra: null };
  if (withEst) return { primary: "–", extra: withEst };
  return { primary: "–", extra: null };
}

function formatHitRate(
  rate: number | null | undefined,
  overall?: number | null
): string {
  const { primary, extra } = hitRateSplit(rate, overall);
  return extra ? `${primary}（${extra}）` : primary;
}

function cacheReadSplit(
  official?: number | null,
  est?: number | null
): { primary: string; extra: string | null } {
  const read = Math.max(0, Number(official) || 0);
  const estimated = Math.max(0, Number(est) || 0);
  if (read > 0 && estimated > 0) {
    return { primary: formatTokens(read), extra: formatTokens(estimated) };
  }
  if (read > 0) return { primary: formatTokens(read), extra: null };
  if (estimated > 0) return { primary: "–", extra: formatTokens(estimated) };
  return { primary: formatTokens(0), extra: null };
}

function SplitMetricValue({
  primary,
  extra,
}: {
  primary: string;
  extra?: string | null;
}) {
  if (!extra) return primary;
  return (
    <>
      {primary}
      <span className="metric-est">（{extra}）</span>
    </>
  );
}

/**
 * freebuff：input 可能是旧扫描的整段 snapshot，或新扫描的未命中。
 * 用 total ≈ input+output+reason(+est) 判断，返回未命中 input。
 */
function uncachedInputOf(s: {
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  totalTokens?: number;
  estCacheReadTokens?: number;
  noCacheData?: boolean;
}): number {
  const input = Math.max(0, Number(s.inputTokens) || 0);
  const est = Math.max(0, Number(s.estCacheReadTokens) || 0);
  if (s.noCacheData === false || est <= 0) return input;
  const rest =
    Math.max(0, Number(s.outputTokens) || 0) +
    Math.max(0, Number(s.reasoningTokens) || 0);
  const total = Math.max(0, Number(s.totalTokens) || 0);
  if (total > 0) {
    const asSnapshot = Math.abs(input + rest - total);
    const asSplit = Math.abs(input + est + rest - total);
    if (asSnapshot + 1 < asSplit) return Math.max(0, input - est);
  }
  return input;
}

/** 把估算 cache 计入后的总体命中，不是某一工具自己的估算命中 */
function overallHitRate(
  uncachedInput?: number,
  officialCache?: number,
  estCache?: number
): number | null {
  const est = Math.max(0, Number(estCache) || 0);
  if (est <= 0) return null;
  return cacheHitRate(
    Math.max(0, Number(uncachedInput) || 0),
    Math.max(0, Number(officialCache) || 0) + est
  );
}

function formatEstTokens(n?: number | null): string | null {
  const v = Math.max(0, Number(n) || 0);
  if (v <= 0) return null;
  return `–（${formatTokens(v)}）`;
}

/** 官方 cache 优先；有估算则括号并列（不写入 cacheRead） */
function formatCacheRead(official?: number | null, est?: number | null): string {
  const read = Math.max(0, Number(official) || 0);
  const estimated = Math.max(0, Number(est) || 0);
  if (read > 0 && estimated > 0) {
    return `${formatTokens(read)}（${formatTokens(estimated)}）`;
  }
  if (read > 0) return formatTokens(read);
  return formatEstTokens(estimated) || formatTokens(0);
}

const EST_HIT_TITLE =
  "本地无官方 cache，不计入汇总命中率。括号内为相邻请求 context 前缀重叠估算";

const EST_HIT_MIXED_TITLE =
  "主数字为官方总体命中（不含估算 cache）。括号内为把估算 cache 计入后的总体命中，不是某一工具自己的估算命中";

const EST_CACHE_TITLE =
  "本地无官方 cache。括号内为相邻请求 context 前缀重叠估算，不计入汇总 Cache Read / 命中率";

const EST_CACHE_MIXED_TITLE =
  "主数字为官方 Cache Read。括号内为无官方 cache 客户端（如 Freebuff）的前缀重叠估算，不计入官方 Cache Read / 命中率";

const SPEED_TITLE =
  "生成速度 = (Output + Reasoning) ÷ 模型请求耗时（含首 token，不含工具执行）。只统计本地有耗时记录的请求。";

const EST_SPEED_TITLE =
  "无官方耗时。括号内为本地估算（Grok：loop→工具/回合结束），不计入汇总速度。";

/**
 * 命中率色阶（对齐 opencode-visual-cache）：
 * ≥85% 绿 · ≥70% 橙 · <70% 红
 * 颜色取自其 Morandi 降饱和 success / warning / error
 */
function hitRateTone(rate: number | null | undefined): "none" | "low" | "mid" | "high" {
  if (rate == null || !Number.isFinite(rate)) return "none";
  if (rate >= 0.85) return "high";
  if (rate >= 0.7) return "mid";
  return "low";
}

type Currency = "USD" | "CNY";

/**
 * 显示币种下的会话成本。
 * CNY：有官方人民币价（costCny）直接使用，否则按实时汇率折算美元成本。
 */
function displayCost(
  s: { costUsd?: number; costCny?: number },
  currency: Currency,
  rate: number
): number | undefined {
  if (currency === "CNY") {
    return s.costCny ?? (s.costUsd != null ? s.costUsd * rate : undefined);
  }
  return s.costUsd;
}

/**
 * 从会话汇总各模型「美元(或显示币)/token」均价，用于小时桶尚无 cost 时的回退
 *（旧缓存未重扫时，比把整段会话费用砸进 lastUsedAt 那一小时靠谱得多）。
 */
function modelCostPerToken(
  sessions: SessionRecord[],
  currency: Currency,
  rate: number
): { byModel: Map<string, number>; overall: number } {
  const by = new Map<string, { cost: number; tokens: number }>();
  let totalCost = 0;
  let totalTok = 0;
  for (const s of sessions) {
    const c = displayCost(s, currency, rate);
    const tok = s.totalTokens || 0;
    if (c == null || !(c > 0) || tok <= 0) continue;
    const m = modelAggKey(s.model) || s.model || UNKNOWN_MODEL;
    const e = by.get(m) || { cost: 0, tokens: 0 };
    e.cost += c;
    e.tokens += tok;
    by.set(m, e);
    totalCost += c;
    totalTok += tok;
  }
  const byModel = new Map<string, number>();
  for (const [m, e] of by) {
    if (e.tokens > 0) byModel.set(m, e.cost / e.tokens);
  }
  return {
    byModel,
    overall: totalTok > 0 ? totalCost / totalTok : 0,
  };
}

/** 小时桶成本：优先桶内估价，否则按该模型会话均价 × token */
function hourlyBucketCost(
  row: {
    model?: string;
    totalTokens?: number;
    costUsd?: number;
    costCny?: number;
  },
  currency: Currency,
  rate: number,
  rates: { byModel: Map<string, number>; overall: number }
): number {
  const direct = displayCost(row, currency, rate);
  // 显式 $0（Freebuff 等免费档）必须保留，不能再按其它工具同模型均价回填
  if (direct != null && Number.isFinite(direct)) return direct;
  const tok = row.totalTokens || 0;
  if (tok <= 0) return 0;
  const m = row.model || UNKNOWN_MODEL;
  const unit = rates.byModel.get(m) ?? rates.overall;
  return unit > 0 ? tok * unit : 0;
}

function formatCost(amount: number | undefined, currency: Currency): string {
  if (amount === undefined || !Number.isFinite(amount)) return "–";
  const sym = currency === "CNY" ? "¥" : "$";
  if (amount >= 1000) return `${sym}${Math.round(amount).toLocaleString()}`;
  if (amount >= 1) return `${sym}${amount.toFixed(2)}`;
  return `${sym}${amount.toFixed(3)}`;
}

function formatFull(iso?: string): string {
  if (!iso) return "–";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}

function formatRelative(iso?: string): string {
  if (!iso) return "–";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const diff = Date.now() - d.getTime();
  const min = Math.floor(diff / 60_000);
  if (min < 1) return "刚刚";
  if (min < 60) return `${min} 分钟前`;
  const hours = Math.floor(min / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} 天前`;
  return d.toLocaleDateString();
}

function shortId(id: string): string {
  if (id.length <= 18) return id;
  return `${id.slice(0, 8)}…${id.slice(-6)}`;
}

/** 环比变化文案；prev 为 0 且无对比意义时返回 null */
function pctChange(cur: number, prev: number): string | null {
  if (prev === 0) return null;
  const d = ((cur - prev) / prev) * 100;
  if (!Number.isFinite(d)) return null;
  return `${d >= 0 ? "+" : ""}${Math.round(d)}%`;
}

function dayKey(iso: string): string {
  const d = new Date(iso);
  return localDayKey(d);
}

/** 本地日历日 YYYY-MM-DD（避免 toISOString 跨日） */
function localDayKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** 丢弃秒当毫秒产生的 1970 脏桶等 */
function isPlausibleDayKey(day: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return false;
  const y = Number(day.slice(0, 4));
  return y >= 2015 && y <= new Date().getFullYear() + 1;
}

/** 去掉首尾 total===0 的桶（趋势图贴齐「第一次 / 最后一次有用量」） */
function trimEmptyEnds<T extends { total: number }>(arr: T[]): T[] {
  if (!arr.length) return arr;
  let lo = 0;
  let hi = arr.length - 1;
  while (lo <= hi && (arr[lo].total || 0) <= 0) lo += 1;
  while (hi >= lo && (arr[hi].total || 0) <= 0) hi -= 1;
  if (lo > hi) return arr.slice(0, 1); // 全空时留一格，避免崩
  return arr.slice(lo, hi + 1);
}

/**
 * 趋势图 X 轴刻度：天数多时不再塞 MM-DD（窄柱会裁成「0」），
 * 改为月界 + 首尾，标签用绝对定位可超出柱宽。
 */
function buildTrendAxisLabels(
  days: { key: string }[],
  hourly: boolean
): Map<number, { text: string; edge?: "start" | "end" }> {
  const n = days.length;
  /** @type {Map<number, { text: string, edge?: "start" | "end" }>} */
  const labels = new Map();
  if (n === 0) return labels;

  if (hourly) {
    // 24 小时：约 6～8 个点，显示 0 / 4 / 8 …
    const step = n <= 12 ? 1 : Math.ceil(n / 8);
    for (let i = 0; i < n; i++) {
      if (i === 0 || i === n - 1 || i % step === 0) {
        const k = days[i].key; // "14:00" 或 "14"
        labels.set(i, {
          text: k.replace(/:00$/, ""),
          edge: i === 0 ? "start" : i === n - 1 ? "end" : undefined,
        });
      }
    }
    return labels;
  }

  // 日桶 key = YYYY-MM-DD
  if (n <= 14) {
    for (let i = 0; i < n; i++) {
      labels.set(i, {
        text: days[i].key.slice(5), // MM-DD
        edge: i === 0 ? "start" : i === n - 1 ? "end" : undefined,
      });
    }
    return labels;
  }

  if (n <= 50) {
    // 约 8 个 MM-DD
    const step = Math.ceil(n / 8);
    for (let i = 0; i < n; i++) {
      if (i === 0 || i === n - 1 || i % step === 0) {
        labels.set(i, {
          text: days[i].key.slice(5),
          edge: i === 0 ? "start" : i === n - 1 ? "end" : undefined,
        });
      }
    }
    return labels;
  }

  // 长跨度（全部 / 100+ 天）：首尾用 MM-DD，中间只在换月处标「M月」
  labels.set(0, { text: days[0].key.slice(5), edge: "start" });
  for (let i = 1; i < n; i++) {
    const prevM = days[i - 1].key.slice(0, 7);
    const curM = days[i].key.slice(0, 7);
    if (prevM !== curM) {
      labels.set(i, { text: `${Number(days[i].key.slice(5, 7))}月` });
    }
  }
  labels.set(n - 1, { text: days[n - 1].key.slice(5), edge: "end" });
  return labels;
}

function sessionDate(s: SessionRecord): string | undefined {
  return s.lastUsedAt || s.startedAt;
}

/** 无用量 / 未调用模型（Grok 常见：只开了窗口、注入 system，无 inference） */
function isEmptySession(s: SessionRecord): boolean {
  if (s.quality === "no_model") return true;
  return (s.totalTokens || 0) <= 0 && (s.inputTokens || 0) <= 0 && (s.outputTokens || 0) <= 0;
}

/**
 * 未能并入父会话的子 agent（父缺失且未持久化恢复时）。
 * 并账后有父的子会从列表移除；仍带 isSubagent 的即「未归并」。
 */
function isOrphanChild(s: SessionRecord): boolean {
  return !!s.isSubagent && !s.deleted;
}

/** 源日志已不存在（本地持久化保留） */
function isDeletedSession(s: SessionRecord): boolean {
  return !!s.deleted;
}

/** 跨工具去重被排除（标记而非删除，明细仍可查，但未计入总额） */
function isDedupExcluded(s: SessionRecord): boolean {
  return !!s.dedupExcluded;
}

function qualityLabel(q: string): string {
  switch (q) {
    case "full":
      return "完整";
    case "partial":
      return "部分";
    case "no_model":
      return "未调用模型";
    case "metadata_only":
      return "仅元数据";
    default:
      return q;
  }
}

export default function App() {
  const [result, setResult] = useState<ScanResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [range, setRange] = useState<RangeId>(() => {
    const raw = localStorage.getItem("token-stats:range") as RangeId | null;
    if (raw && RANGES.some((r) => r.id === raw)) return raw;
    return "week";
  });
  const [customFrom, setCustomFrom] = useState(() => {
    return (
      localStorage.getItem("token-stats:customFrom") ||
      defaultCustomRange().from
    );
  });
  const [customTo, setCustomTo] = useState(() => {
    return (
      localStorage.getItem("token-stats:customTo") || defaultCustomRange().to
    );
  });
  const [showReports, setShowReports] = useState(false);
  const [activeClients, setActiveClients] = useState<Set<string>>(() => {
    try {
      const raw = localStorage.getItem("token-stats:clients");
      if (!raw) return new Set(CLIENT_ORDER);
      const arr = JSON.parse(raw) as string[];
      const valid = arr.filter((c) => (CLIENT_ORDER as readonly string[]).includes(c));
      if (valid.length >= CLIENT_ORDER.length - 1) return new Set(CLIENT_ORDER);
      return valid.length ? new Set(valid) : new Set(CLIENT_ORDER);
    } catch {
      return new Set(CLIENT_ORDER);
    }
  });
  const [currency, setCurrency] = useState<Currency>(
    () => (localStorage.getItem("token-stats:currency") as Currency) || "CNY"
  );
  const [fx, setFx] = useState<FxRate>({ rate: 7.2, date: "", live: false });
  /** 启动始终回隐藏首页（生涯）；不持久化，避免打开却停在上次子页 */
  const [view, setView] = useState<ViewId>("home");
  const [hideCost, setHideCost] = useState(
    () => localStorage.getItem("token-stats:hideCost") === "1"
  );
  // 自动刷新间隔（分钟），0 = 关闭
  const [autoRefresh, setAutoRefresh] = useState(() =>
    Number(localStorage.getItem("token-stats:autoRefresh") || 0)
  );
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({
    key: "time",
    dir: -1,
  });
  const [showSync, setShowSync] = useState(false);
  const [showPricing, setShowPricing] = useState(false);
  const [pricingFocus, setPricingFocus] = useState<string[]>([]);
  /** 默认隐藏 0 token / 未调用模型 会话 */
  const [hideEmpty, setHideEmpty] = useState(
    () => localStorage.getItem("token-stats:hideEmpty") !== "0"
  );
  /** 默认隐藏未能并入父会话的子 agent；有持久化后应很少 */
  const [hideOrphans, setHideOrphans] = useState(
    () => localStorage.getItem("token-stats:hideOrphans") !== "0"
  );
  /** 用量趋势堆叠维度：工具(client) / 模型 */
  const [trendStack, setTrendStack] = useState<"client" | "model">(() =>
    localStorage.getItem("token-stats:trendStack") === "model" ? "model" : "client"
  );
  /**
   * 源已删除、本地库保留的会话：默认显示并标「已删除」。
   * 打开此开关则从列表/汇总里藏起来（查漏账时再关）。
   */
  const [hideDeleted, setHideDeleted] = useState(
    () => localStorage.getItem("token-stats:hideDeleted") === "1"
  );
  const [hideDedupExcluded, setHideDedupExcluded] = useState(
    () => localStorage.getItem("token-stats:hideDedupExcluded") === "1"
  );
  const [detailSession, setDetailSession] = useState<SessionRecord | null>(null);
  /** 分类表下钻：叠在时间范围 / 隐藏开关之上，进会话列表时带这个条件 */
  const [drill, setDrill] = useState<DrillFilter | null>(null);
  function switchView(v: ViewId) {
    setView(v);
  }

  function goHome() {
    setDrill(null);
    setView("home");
  }

  function clearDrill() {
    setDrill(null);
  }

  /** 搜索点模型/工具/路径：就地筛选，不跳页。 */
  function applySearchDrill(next: DrillFilter) {
    setDrill(next);
    if (next.kind === "client") {
      const one = new Set([next.id]);
      setActiveClients(one);
      localStorage.setItem("token-stats:clients", JSON.stringify([...one]));
    }
    setQuery("");
  }

  /** 分类表下钻到会话列表；可选先把工具筛选收成该工具 */
  function drillToSessions(next: DrillFilter) {
    applySearchDrill(next);
    switchView("sessions");
  }

  function switchRange(r: RangeId) {
    setRange(r);
    localStorage.setItem("token-stats:range", r);
    if (r === "custom") {
      // 首次点自定义且日期异常时回落最近 7 天
      if (!customFrom || !customTo || customFrom > customTo) {
        const d = defaultCustomRange();
        setCustomFrom(d.from);
        setCustomTo(d.to);
        localStorage.setItem("token-stats:customFrom", d.from);
        localStorage.setItem("token-stats:customTo", d.to);
      }
    }
  }

  function setCustomDay(which: "from" | "to", value: string) {
    if (!value) return;
    if (which === "from") {
      let from = value;
      let to = customTo;
      if (to && from > to) to = from;
      setCustomFrom(from);
      setCustomTo(to);
      localStorage.setItem("token-stats:customFrom", from);
      localStorage.setItem("token-stats:customTo", to);
    } else {
      let to = value;
      let from = customFrom;
      if (from && to < from) from = to;
      setCustomFrom(from);
      setCustomTo(to);
      localStorage.setItem("token-stats:customFrom", from);
      localStorage.setItem("token-stats:customTo", to);
    }
    if (range !== "custom") {
      setRange("custom");
      localStorage.setItem("token-stats:range", "custom");
    }
  }

  function toggleHideCost() {
    setHideCost((prev) => {
      localStorage.setItem("token-stats:hideCost", prev ? "0" : "1");
      return !prev;
    });
  }

  function changeAutoRefresh(minutes: number) {
    setAutoRefresh(minutes);
    localStorage.setItem("token-stats:autoRefresh", String(minutes));
  }

  function clickSort(key: SortKey) {
    setSort((prev) =>
      prev.key === key ? { key, dir: prev.dir === -1 ? 1 : -1 } : { key, dir: -1 }
    );
  }

  useEffect(() => {
    let cancelled = false;
    void getUsdCny().then((r) => {
      if (!cancelled) setFx(r);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  function toggleCurrency() {
    setCurrency((prev) => {
      const next = prev === "USD" ? "CNY" : "USD";
      localStorage.setItem("token-stats:currency", next);
      return next;
    });
  }

  const runScan = useCallback(async (): Promise<ScanResult | null> => {
    setLoading(true);
    setError(null);
    try {
      if (!window.tokenStats?.scan) {
        throw new Error("未在 Electron 中运行：请使用 npm run dev 启动桌面端");
      }
      const data = sanitizeScanResult(await window.tokenStats.scan());
      if (data.error) setError(data.error);
      setResult(data);
      return data;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void runScan();
  }, [runScan]);

  // 自动刷新
  useEffect(() => {
    if (!autoRefresh) return;
    const id = setInterval(() => void runScan(), autoRefresh * 60_000);
    return () => clearInterval(id);
  }, [autoRefresh, runScan]);

  /**
   * 时间窗边界（日正午毫秒，便于 day 比较）：
   * - start/end 皆 null → 全部
   * - end 有值 → 含该日全天
   */
  const { rangeStart, rangeEnd } = useMemo(() => {
    if (range === "all") return { rangeStart: null as number | null, rangeEnd: null as number | null };
    if (range === "custom") {
      let from = customFrom;
      let to = customTo;
      if (!from || !to) {
        const d = defaultCustomRange();
        from = from || d.from;
        to = to || d.to;
      }
      if (from > to) [from, to] = [to, from];
      const start = new Date(`${from}T12:00:00`).getTime();
      const end = new Date(`${to}T12:00:00`).getTime();
      return {
        rangeStart: Number.isNaN(start) ? null : start,
        rangeEnd: Number.isNaN(end) ? null : end,
      };
    }
    const def = RANGES.find((r) => r.id === range)!;
    if (def.days <= 0) return { rangeStart: null, rangeEnd: null };
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - (def.days - 1));
    // 预设：结束日 = 今天（含）
    const end = new Date();
    end.setHours(12, 0, 0, 0);
    return { rangeStart: d.getTime(), rangeEnd: end.getTime() };
  }, [range, customFrom, customTo]);

  // 时间范围过滤（无日期的会话始终保留，避免凭空消失）
  const ranged = useMemo(() => {
    const sessions = result?.sessions || [];
    if (rangeStart === null && rangeEnd === null) return sessions;
    return sessions.filter((s) => {
      const iso = sessionDate(s);
      if (!iso) return true;
      const t = new Date(iso).getTime();
      if (Number.isNaN(t)) return true;
      // 与小时桶一致：按日正午对齐
      const day = dayKey(iso);
      const noon = new Date(`${day}T12:00:00`).getTime();
      if (Number.isNaN(noon)) return true;
      if (rangeStart != null && noon < rangeStart) return false;
      if (rangeEnd != null && noon > rangeEnd) return false;
      return true;
    });
  }, [result, rangeStart, rangeEnd]);

  /** 工具/隐藏（不含搜索词）— 下拉候选池 */
  const searchPool = useMemo(() => {
    const sessions = result?.sessions || [];
    return sessions.filter((s) => {
      if (!activeClients.has(s.client)) return false;
      if (hideEmpty && isEmptySession(s)) return false;
      if (hideOrphans && isOrphanChild(s)) return false;
      if (hideDeleted && isDeletedSession(s)) return false;
      if (hideDedupExcluded && isDedupExcluded(s)) return false;
      return true;
    });
  }, [
    result,
    activeClients,
    hideEmpty,
    hideOrphans,
    hideDeleted,
    hideDedupExcluded,
  ]);

  /** 工具/隐藏/搜索（不限日期）— 区间归因命中时用 */
  const allowedFiltered = useMemo(() => {
    const q = query.trim();
    if (!q) return searchPool;
    return searchPool.filter((s) => matchesSession(s, q, CLIENT_LABELS));
  }, [searchPool, query]);

  /** 搜索词 + 下钻共同圈定的会话；小时桶按这个集合收口 */
  const scopedSessionKeys = useMemo(() => {
    const q = query.trim();
    const keys = new Set<string>();
    for (const s of searchPool) {
      if (q && !matchesSession(s, q, CLIENT_LABELS)) continue;
      if (!matchesDrill(s, drill)) continue;
      keys.add(`${s.client}:${s.sessionId}`);
    }
    return keys;
  }, [searchPool, query, drill]);

  const scopedHourly = useMemo(() => {
    const hourly = result?.hourly || [];
    if (!hourly.length) return hourly;
    if (!query.trim() && !drill) return hourly;
    return hourly.filter((row) => {
      const sid = row.sessionId != null ? String(row.sessionId).trim() : "";
      if (sid) return scopedSessionKeys.has(`${row.client}:${sid}`);
      if (drill) {
        if (drill.kind === "model") {
          const k = modelAggKey(row.model) || row.model || UNKNOWN_MODEL;
          return k === drill.model;
        }
        if (drill.kind === "client") return row.client === drill.id;
        if (drill.kind === "day") return String(row.hour).slice(0, 10) === drill.day;
        return false;
      }
      return matchesSession(
        { client: row.client, sessionId: "", model: row.model },
        query,
        CLIENT_LABELS
      );
    });
  }, [result?.hourly, scopedSessionKeys, query, drill]);

  /** 再叠时间窗（lastUsedAt）— 生涯模式 / 区间 fallback */
  const rangedFiltered = useMemo(() => {
    const set = new Set(ranged);
    return allowedFiltered.filter((s) => set.has(s));
  }, [allowedFiltered, ranged]);

  const canSplitByRange = useMemo(
    () => hasSessionHourly(result?.hourly),
    [result?.hourly]
  );

  const rangeSessionUsage = useMemo(() => {
    const hourly = result?.hourly || [];
    if (!hourly.length) return new Map();
    const todayKey = localDayKey(new Date());
    const rates = modelCostPerToken(
      result?.sessions || [],
      currency,
      fx.rate
    );
    return buildRangeSessionUsage(
      hourly,
      rangeStart,
      todayKey,
      activeClients,
      (row) => hourlyBucketCost(row, currency, fx.rate, rates),
      rangeEnd
    );
  }, [
    result?.hourly,
    result?.sessions,
    rangeStart,
    rangeEnd,
    activeClients,
    currency,
    fx.rate,
  ]);

  /**
   * 分类表 / 会话列表：一律按时间窗内真实发生（方案 A）。
   * 生涯合计仅作副信息（hover / 行下小字），不含下钻。
   */
  const baseFiltered = useMemo(() => {
    return applyUsageScope(
      allowedFiltered,
      rangedFiltered,
      "range",
      rangeSessionUsage,
      {
        canSplit: canSplitByRange,
        includeFallback: true,
        currency,
      }
    );
  }, [
    allowedFiltered,
    rangedFiltered,
    rangeSessionUsage,
    canSplitByRange,
    currency,
  ]);

  const fallbackCount = useMemo(
    () =>
      baseFiltered.filter((s) => s.usageSource === "lifetime-fallback").length,
    [baseFiltered]
  );

  /**
   * 「本区间」KPI / 分类表：可拆时排除「全量兜底」，避免生涯灌进今天。
   */
  const aggSessions = useMemo(
    () => sessionsForRangeAgg(baseFiltered, "range", canSplitByRange),
    [baseFiltered, canSplitByRange]
  );

  /** 区间内小时桶维度汇总（工具/模型/日）— 与趋势同一时间轴 */
  const hourlyDims = useMemo(() => {
    const hourly = scopedHourly;
    if (!hourly.length) return null;
    const todayKey = localDayKey(new Date());
    const rates = modelCostPerToken(
      result?.sessions || [],
      currency,
      fx.rate
    );
    return buildHourlyDimTotals(
      hourly,
      rangeStart,
      todayKey,
      activeClients,
      (row) => hourlyBucketCost(row, currency, fx.rate, rates),
      rangeEnd
    );
  }, [
    scopedHourly,
    result?.sessions,
    rangeStart,
    rangeEnd,
    activeClients,
    currency,
    fx.rate,
  ]);

  /** 会话列表 / 导出：叠上下钻（含黄标全量兜底，方便核对） */
  const filtered = useMemo(
    () => baseFiltered.filter((s) => matchesDrill(s, drill)),
    [baseFiltered, drill]
  );

  /** 本区间汇总数字用的会话（下钻后） */
  const filteredAgg = useMemo(
    () => aggSessions.filter((s) => matchesDrill(s, drill)),
    [aggSessions, drill]
  );

  function matchesQuery(s: SessionRecord, q: string): boolean {
    return matchesSession(s, q, CLIENT_LABELS);
  }

  /** 当前筛选条件下会被 hideEmpty 藏掉的数量 */
  const emptyHiddenCount = useMemo(() => {
    if (!hideEmpty) return 0;
    const q = query.trim().toLowerCase();
    return ranged.filter((s) => {
      if (!activeClients.has(s.client)) return false;
      if (hideOrphans && isOrphanChild(s)) return false;
      if (hideDeleted && isDeletedSession(s)) return false;
      if (hideDedupExcluded && isDedupExcluded(s)) return false;
      if (!isEmptySession(s)) return false;
      return matchesQuery(s, q);
    }).length;
  }, [ranged, activeClients, query, hideEmpty, hideOrphans, hideDeleted, hideDedupExcluded]);

  /** 当前筛选条件下会被 hideOrphans 藏掉的「未归并」子会话数量 */
  const orphanHiddenCount = useMemo(() => {
    if (!hideOrphans) return 0;
    const q = query.trim().toLowerCase();
    return ranged.filter((s) => {
      if (!activeClients.has(s.client)) return false;
      if (!isOrphanChild(s)) return false;
      if (hideEmpty && isEmptySession(s)) return false;
      if (hideDeleted && isDeletedSession(s)) return false;
      if (hideDedupExcluded && isDedupExcluded(s)) return false;
      return matchesQuery(s, q);
    });
  }, [ranged, activeClients, query, hideEmpty, hideOrphans, hideDeleted, hideDedupExcluded]);

  /** 当前筛选条件下会被 hideDeleted 藏掉的「源已删」数量 */
  const deletedHiddenCount = useMemo(() => {
    if (!hideDeleted) return 0;
    const q = query.trim().toLowerCase();
    return ranged.filter((s) => {
      if (!activeClients.has(s.client)) return false;
      if (!isDeletedSession(s)) return false;
      if (hideEmpty && isEmptySession(s)) return false;
      if (hideOrphans && isOrphanChild(s)) return false;
      if (hideDedupExcluded && isDedupExcluded(s)) return false;
      return matchesQuery(s, q);
    }).length;
  }, [ranged, activeClients, query, hideEmpty, hideOrphans, hideDeleted, hideDedupExcluded]);

  /** 当前筛选条件下会被 hideDedupExcluded 藏掉的「去重排除」数量 */
  const dedupExcludedHiddenCount = useMemo(() => {
    if (!hideDedupExcluded) return 0;
    const q = query.trim().toLowerCase();
    return ranged.filter((s) => {
      if (!activeClients.has(s.client)) return false;
      if (!isDedupExcluded(s)) return false;
      if (hideEmpty && isEmptySession(s)) return false;
      if (hideOrphans && isOrphanChild(s)) return false;
      if (hideDeleted && isDeletedSession(s)) return false;
      return matchesQuery(s, q);
    }).length;
  }, [ranged, activeClients, query, hideEmpty, hideOrphans, hideDeleted, hideDedupExcluded]);

  /** 本轮扫描里被跨工具去重排除的会话总数（不受筛选影响，用于切换按钮标签） */
  const dedupExcludedTotal = useMemo(
    () => (result?.sessions || []).filter(isDedupExcluded).length,
    [result]
  );

  const totals = useMemo(() => {
    // 优先小时桶 → 与趋势一致的时间窗真实发生量
    if (hourlyDims && hourlyDims.total.totalTokens > 0) {
      const t = hourlyDims.total;
      let cost = 0;
      let sessions = 0;
      for (const s of filteredAgg) {
        cost += displayCost(s, currency, fx.rate) || 0;
        if ((s.totalTokens || 0) > 0 || (s.inputTokens || 0) > 0) sessions += 1;
      }
      if (cost <= 0) cost = t.cost;
      return {
        sessions: sessions || filteredAgg.length,
        inputTokens: t.inputTokens,
        outputTokens: t.outputTokens,
        cacheReadTokens: t.cacheReadTokens,
        cacheWriteTokens: t.cacheWriteTokens,
        reasoningTokens: t.reasoningTokens,
        totalTokens: t.totalTokens,
        requestCount: t.events || 0,
        genMs: t.genMs || 0,
        genTokens: t.genTokens || 0,
        estGenMs: t.estGenMs || 0,
        estGenTokens: t.estGenTokens || 0,
        estCacheReadTokens: t.estCacheReadTokens || 0,
        cost,
      };
    }
    const base = {
      sessions: filteredAgg.length,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      totalTokens: 0,
      requestCount: 0,
      genMs: 0,
      genTokens: 0,
      estGenMs: 0,
      estGenTokens: 0,
      estCacheReadTokens: 0,
      cost: 0,
    };
    for (const s of filteredAgg) {
      base.inputTokens += uncachedInputOf(s);
      base.outputTokens += s.outputTokens || 0;
      base.cacheReadTokens += s.cacheReadTokens || 0;
      base.cacheWriteTokens += s.cacheWriteTokens || 0;
      base.reasoningTokens += s.reasoningTokens || 0;
      base.totalTokens += s.totalTokens || 0;
      base.estCacheReadTokens += s.estCacheReadTokens || 0;
      base.requestCount += s.requestCount || 0;
      base.genMs += s.genMs || 0;
      base.genTokens += s.genTokens || 0;
      base.estGenMs += s.estGenMs || 0;
      base.estGenTokens += s.estGenTokens || 0;
      base.cost += displayCost(s, currency, fx.rate) || 0;
    }
    return base;
  }, [hourlyDims, filteredAgg, currency, fx.rate]);

  // 会话视图的列排序
  const sortedSessions = useMemo(() => {
    const arr = [...filtered];
    const val = (s: SessionRecord): number => {
      switch (sort.key) {
        case "time": {
          const t = new Date(sessionDate(s) || "").getTime();
          return Number.isNaN(t) ? 0 : t;
        }
        case "input":
          return s.inputTokens;
        case "output":
          return s.outputTokens;
        case "hit": {
          const r = cacheHitRate(s.inputTokens, s.cacheReadTokens, s.noCacheData);
          return r == null ? -1 : r;
        }
        case "cost":
          return displayCost(s, currency, fx.rate) ?? -1;
        case "requests":
          return s.requestCount ?? -1;
        case "turns":
          return s.turnCount ?? -1;
        case "msgs":
          return s.messageCount ?? -1;
        case "speed":
          return (
            tokensPerSec(s.genTokens, s.genMs) ??
            tokensPerSec(s.estGenTokens, s.estGenMs) ??
            -1
          );
        default:
          return s.totalTokens;
      }
    };
    arr.sort((a, b) => {
      const va = val(a);
      const vb = val(b);
      return (va < vb ? -1 : va > vb ? 1 : 0) * sort.dir;
    });
    return arr;
  }, [filtered, sort, currency, fx.rate]);

  function exportFile(name: string, content: string, mime: string) {
    const blob = new Blob([content], { type: `${mime};charset=utf-8` });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  function exportCsv() {
    const esc = (v: unknown) => {
      const s = String(v ?? "");
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const head = [
      "client", "title", "cwd", "model", "lastUsedAt",
      "requestCount", "turnCount", "messageCount",
      "input", "output", "cacheRead", "cacheWrite", "reasoning", "cacheHitRate", "tokPerSec", "total",
      "costUsd", "costCny",
    ];
    const lines = [head.join(",")];
    for (const s of sortedSessions) {
      const hit = cacheHitRate(s.inputTokens, s.cacheReadTokens, s.noCacheData);
      lines.push(
        [
          s.client, s.title, s.cwd, s.model, sessionDate(s) || "",
          s.requestCount ?? "",
          s.turnCount ?? "",
          s.messageCount ?? "",
          s.inputTokens, s.outputTokens, s.cacheReadTokens, s.cacheWriteTokens,
          s.reasoningTokens,
          hit != null ? (hit * 100).toFixed(1) : "",
          (() => {
            const sp = tokensPerSec(s.genTokens, s.genMs);
            return sp != null ? sp.toFixed(2) : "";
          })(),
          s.totalTokens, s.costUsd ?? "", s.costCny ?? "",
        ]
          .map(esc)
          .join(",")
      );
    }
    exportFile(
      `token-stats-${dayKey(new Date().toISOString())}.csv`,
      lines.join("\n"),
      "text/csv"
    );
  }

  function exportJson() {
    exportFile(
      `token-stats-${dayKey(new Date().toISOString())}.json`,
      JSON.stringify(
        {
          exportedAt: new Date().toISOString(),
          range,
          clients: [...activeClients],
          sessions: sortedSessions,
        },
        null,
        2
      ),
      "application/json"
    );
  }

  // 环比：优先 turn 小时桶（真实发生时间）；否则回退会话 lastUsedAt
  const deltas = useMemo(() => {
    const dayStart = new Date();
    dayStart.setHours(0, 0, 0, 0);
    const t0 = dayStart.getTime();
    const DAY = 86_400_000;
    const todayKey = dayKey(dayStart.toISOString());
    const y = new Date(t0 - DAY);
    const yesterdayKey = dayKey(y.toISOString());

    const hourly = result?.hourly;
    if (hourly?.length) {
      const sumHours = (pred: (hour: string) => boolean) =>
        hourly.reduce(
          (acc, h) => (pred(h.hour) ? acc + (h.totalTokens || 0) : acc),
          0
        );
      const weekStart = new Date(t0 - 6 * DAY);
      const prevWeekStart = new Date(t0 - 13 * DAY);
      const weekStartKey = dayKey(weekStart.toISOString());
      const prevWeekStartKey = dayKey(prevWeekStart.toISOString());
      const prevWeekEndKey = dayKey(new Date(t0 - 6 * DAY).toISOString());
      return {
        today: sumHours((h) => h.startsWith(todayKey)),
        yesterday: sumHours((h) => h.startsWith(yesterdayKey)),
        week: sumHours((h) => h.slice(0, 10) >= weekStartKey),
        prevWeek: sumHours(
          (h) =>
            h.slice(0, 10) >= prevWeekStartKey && h.slice(0, 10) < prevWeekEndKey
        ),
      };
    }

    const sessions = result?.sessions || [];
    const sum = (from: number, to: number) =>
      sessions.reduce((acc, s) => {
        const iso = sessionDate(s);
        if (!iso) return acc;
        const t = new Date(iso).getTime();
        return t >= from && t < to ? acc + s.totalTokens : acc;
      }, 0);
    return {
      today: sum(t0, Infinity),
      yesterday: sum(t0 - DAY, t0),
      week: sum(t0 - 6 * DAY, Infinity),
      prevWeek: sum(t0 - 13 * DAY, t0 - 6 * DAY),
    };
  }, [result]);

  // 按工具：优先小时桶；会话数/黄标来自 aggSessions
  const toolRows = useMemo(() => {
    const map = new Map<string, AggRow>();
    if (hourlyDims) {
      for (const [key, p] of hourlyDims.byClient) {
        const r = blankAgg(key);
        r.label = CLIENT_LABELS[key as (typeof CLIENT_ORDER)[number]] || key;
        r.inputTokens = p.inputTokens;
        r.outputTokens = p.outputTokens;
        r.cacheReadTokens = p.cacheReadTokens;
        r.cacheWriteTokens = p.cacheWriteTokens;
        r.reasoningTokens = p.reasoningTokens;
        r.totalTokens = p.totalTokens;
        r.requestCount = p.events || 0;
        r.genMs = p.genMs || 0;
        r.genTokens = p.genTokens || 0;
        r.estGenMs = p.estGenMs || 0;
        r.estGenTokens = p.estGenTokens || 0;
        r.cost = p.cost;
        r.hasCost = p.cost > 0;
        map.set(key, r);
      }
      for (const s of aggSessions) {
        const key = s.client || "未知工具";
        let r = map.get(key);
        if (!r) {
          r = blankAgg(key);
          r.label = CLIENT_LABELS[key as (typeof CLIENT_ORDER)[number]] || key;
          map.set(key, r);
        }
        r.sessions += 1;
        if (s.usageSource === "lifetime-fallback") r.fallbackSessions += 1;
        addHitFields(r, s);
      }
    } else {
      for (const s of aggSessions) {
        const key = s.client || "未知工具";
        let r = map.get(key);
        if (!r) {
          r = blankAgg(key);
          r.label = CLIENT_LABELS[key as (typeof CLIENT_ORDER)[number]] || key;
          map.set(key, r);
        }
        addToAgg(r, s, currency, fx.rate);
      }
    }
    return [...map.values()].sort((a, b) => b.totalTokens - a.totalTokens);
  }, [aggSessions, hourlyDims, currency, fx.rate]);

  // 按项目：hourly→session→cwd（绝不走会话全量字段）
  const projectRows = useMemo(() => {
    const map = new Map<string, AggRow>();
    if ((result?.hourly?.length || 0) > 0) {
      const todayKey = localDayKey(new Date());
      const byCwd = buildProjectTokensFromHourly(
        scopedHourly,
        result?.sessions || [],
        rangeStart,
        todayKey,
        activeClients,
        rangeEnd
      );
      const sessCount = new Map<string, number>();
      for (const s of aggSessions) {
        const cwd = s.cwd || "未知目录";
        sessCount.set(cwd, (sessCount.get(cwd) || 0) + 1);
      }
      for (const [cwd, tok] of byCwd) {
        if (tok <= 0) continue;
        const r = blankAgg(cwd);
        if (cwd !== "未知目录" && cwd !== "未归属项目") {
          r.label = cwd.split(/[\\/]/).filter(Boolean).pop() || cwd;
        } else {
          r.label = cwd;
        }
        r.totalTokens = tok;
        r.sessions = sessCount.get(cwd) || 0;
        let cost = 0;
        let hasCost = false;
        let reqs = 0;
        for (const s of aggSessions) {
          if ((s.cwd || "未知目录") !== cwd) continue;
          const c = displayCost(s, currency, fx.rate);
          if (c != null) {
            cost += c;
            hasCost = true;
          }
          reqs += s.requestCount || 0;
          r.genMs += s.genMs || 0;
          r.genTokens += s.genTokens || 0;
          r.estGenMs += s.estGenMs || 0;
          r.estGenTokens += s.estGenTokens || 0;
          addHitFields(r, s);
        }
        r.cost = cost;
        r.hasCost = hasCost;
        r.requestCount = reqs;
        map.set(cwd, r);
      }
    } else {
      for (const s of aggSessions) {
        const cwd = s.cwd || "未知目录";
        let r = map.get(cwd);
        if (!r) {
          r = blankAgg(cwd);
          if (cwd !== "未知目录") {
            r.label = cwd.split(/[\\/]/).filter(Boolean).pop() || cwd;
          }
          map.set(cwd, r);
        }
        addToAgg(r, s, currency, fx.rate);
      }
    }
    return [...map.values()].sort((a, b) => b.totalTokens - a.totalTokens);
  }, [
    aggSessions,
    scopedHourly,
    result?.hourly,
    result?.sessions,
    rangeStart,
    rangeEnd,
    activeClients,
    currency,
    fx.rate,
  ]);

  const modelRows = useMemo(() => {
    const map = new Map<string, AggRow>();
    if (hourlyDims) {
      // token / 请求 / 会话数 都跟小时桶 model 键走（turn 写什么就是什么）
      // 不用 session 表「最后一次 · max」去凑会话数，否则会出 0 token 幽灵行
      for (const [key, p] of hourlyDims.byModel) {
        const r = blankAgg(key);
        r.inputTokens = p.inputTokens;
        r.outputTokens = p.outputTokens;
        r.cacheReadTokens = p.cacheReadTokens;
        r.cacheWriteTokens = p.cacheWriteTokens;
        r.reasoningTokens = p.reasoningTokens;
        r.totalTokens = p.totalTokens;
        r.requestCount = p.events || 0;
        r.genMs = p.genMs || 0;
        r.genTokens = p.genTokens || 0;
        r.estGenMs = p.estGenMs || 0;
        r.estGenTokens = p.estGenTokens || 0;
        r.cost = p.cost;
        r.hasCost = p.cost > 0;
        r.sessions = hourlyDims.sessionsByModel?.get(key) || 0;
        map.set(key, r);
      }
      // 命中率：小时桶没有 noCacheData 维度，用会话补（官方排除 freebuff；估算另记）
      for (const s of aggSessions) {
        const key = modelAggKey(s.model) || s.model || UNKNOWN_MODEL;
        const r = map.get(key);
        if (!r) continue;
        addHitFields(r, s);
      }
      // 无小时明细的黄标兜底：仍按会话主名挂一行，避免完全消失
      for (const s of aggSessions) {
        if (s.usageSource !== "lifetime-fallback") continue;
        const key = modelAggKey(s.model) || s.model || UNKNOWN_MODEL;
        let r = map.get(key);
        if (!r) {
          r = blankAgg(key);
          map.set(key, r);
          addToAgg(r, s, currency, fx.rate);
          r.sessions = 0;
        }
        r.sessions += 1;
        r.fallbackSessions += 1;
      }
    } else {
      for (const s of aggSessions) {
        const key = modelAggKey(s.model) || s.model || UNKNOWN_MODEL;
        let r = map.get(key);
        if (!r) {
          r = blankAgg(key);
          map.set(key, r);
        }
        addToAgg(r, s, currency, fx.rate);
      }
    }
    return [...map.values()].sort((a, b) => b.totalTokens - a.totalTokens);
  }, [aggSessions, hourlyDims, currency, fx.rate]);

  // 按天：有小时桶时按「当天真实发生」汇总
  const dailyRows = useMemo(() => {
    const map = new Map<string, AggRow>();
    const hourly = scopedHourly;
    if (hourly.length > 0) {
      const dims =
        hourlyDims ||
        buildHourlyDimTotals(
          hourly,
          rangeStart,
          localDayKey(new Date()),
          activeClients,
          (row) => {
            const rates = modelCostPerToken(
              result?.sessions || [],
              currency,
              fx.rate
            );
            return hourlyBucketCost(row, currency, fx.rate, rates);
          },
          rangeEnd
        );
      for (const [key, p] of dims.byDay) {
        const r = blankAgg(key);
        r.inputTokens = p.inputTokens;
        r.outputTokens = p.outputTokens;
        r.cacheReadTokens = p.cacheReadTokens;
        r.cacheWriteTokens = p.cacheWriteTokens;
        r.reasoningTokens = p.reasoningTokens;
        r.totalTokens = p.totalTokens;
        r.requestCount = p.events || 0;
        r.genMs = p.genMs || 0;
        r.genTokens = p.genTokens || 0;
        r.estGenMs = p.estGenMs || 0;
        r.estGenTokens = p.estGenTokens || 0;
        r.cost = p.cost;
        r.hasCost = p.cost > 0;
        map.set(key, r);
      }
      // 命中率：小时桶没有 noCacheData 维度，用会话补（官方排除 freebuff；估算另记）
      for (const s of aggSessions) {
        const iso = sessionDate(s);
        const key = iso ? dayKey(iso) : "无日期";
        const r = map.get(key);
        if (!r) continue;
        addHitFields(r, s);
      }
      for (const day of map.keys()) {
        const onDay = buildSessionUsageOnDay(hourly, day, activeClients);
        const r = map.get(day)!;
        r.sessions = onDay.size;
      }
    } else {
      for (const s of aggSessions) {
        const iso = sessionDate(s);
        const key = iso ? dayKey(iso) : "无日期";
        let r = map.get(key);
        if (!r) {
          r = blankAgg(key);
          map.set(key, r);
        }
        addToAgg(r, s, currency, fx.rate);
      }
    }
    return [...map.values()].sort((a, b) => {
      if (a.key === "无日期") return 1;
      if (b.key === "无日期") return -1;
      return b.key.localeCompare(a.key);
    });
  }, [
    aggSessions,
    hourlyDims,
    scopedHourly,
    result?.hourly,
    result?.sessions,
    rangeStart,
    rangeEnd,
    activeClients,
    currency,
    fx.rate,
  ]);

  const clientStats = useMemo(() => {
    const map = new Map<string, { count: number; tokens: number }>();
    if (hourlyDims) {
      for (const [c, p] of hourlyDims.byClient) {
        map.set(c, { count: 0, tokens: p.totalTokens });
      }
      for (const s of aggSessions) {
        const cur = map.get(s.client) || { count: 0, tokens: 0 };
        cur.count += 1;
        map.set(s.client, cur);
      }
      return map;
    }
    for (const s of aggSessions) {
      const cur = map.get(s.client) || { count: 0, tokens: 0 };
      cur.count += 1;
      cur.tokens += s.totalTokens || 0;
      map.set(s.client, cur);
    }
    return map;
  }, [aggSessions, hourlyDims]);

  /** 行内展开：取某分类 key 下 Top 会话（按天 = 该日真实用量，不是生涯） */
  const sessionsForAggKey = useCallback(
    (kind: DrillFilter["kind"], key: string): SessionRecord[] => {
      // 按天：用小时桶拆「这一天每个会话用了多少」
      if (kind === "day" && key !== "无日期" && (result?.hourly?.length || 0) > 0) {
        const rates = modelCostPerToken(
          result?.sessions || [],
          currency,
          fx.rate
        );
        const onDay = buildSessionUsageOnDay(
          result!.hourly || [],
          key,
          activeClients,
          (row) => hourlyBucketCost(row, currency, fx.rate, rates)
        );
        const byKey = new Map(
          (result?.sessions || []).map((s) => [`${s.client}:${s.sessionId}`, s])
        );
        const out: SessionRecord[] = [];
        for (const [sk, u] of onDay) {
          const s = byKey.get(sk);
          if (!s) continue;
          if (!activeClients.has(s.client)) continue;
          const cost = u.cost > 0 ? u.cost : undefined;
          out.push({
            ...s,
            inputTokens: u.inputTokens,
            outputTokens: u.outputTokens,
            cacheReadTokens: u.cacheReadTokens,
            cacheWriteTokens: u.cacheWriteTokens,
            reasoningTokens: u.reasoningTokens,
            totalTokens: u.totalTokens,
            costUsd: currency === "USD" ? cost : undefined,
            costCny: currency === "CNY" ? cost : undefined,
            // 借用字段在展开行标「该日」
            usageSource: "range" as const,
            lifetimeTotalTokens: s.totalTokens,
          } as SessionRecord & { usageSource?: string; lifetimeTotalTokens?: number });
        }
        return out.sort((a, b) => (b.totalTokens || 0) - (a.totalTokens || 0));
      }

      const drillOf = (s: SessionRecord): boolean => {
        switch (kind) {
          case "client":
            return s.client === key;
          case "model":
            return (modelAggKey(s.model) || s.model || UNKNOWN_MODEL) === key;
          case "project":
            return (s.cwd || "未知目录") === key;
          case "day": {
            const iso = sessionDate(s);
            if (!iso) return key === "无日期";
            return dayKey(iso) === key;
          }
        }
      };
      return baseFiltered
        .filter(drillOf)
        .sort((a, b) => (b.totalTokens || 0) - (a.totalTokens || 0));
    },
    [
      baseFiltered,
      result?.hourly,
      result?.sessions,
      activeClients,
      currency,
      fx.rate,
    ]
  );

  // 用量趋势：优先 turn 小时桶；可按工具(client) 或 模型(model) 堆叠
  const trend = useMemo(() => {
    type Bucket = { key: string; byStack: Map<string, number>; total: number };
    const hourlyRows = scopedHourly;
    const hasHourly = hourlyRows.length > 0;
    const byModel = trendStack === "model";

    const stackKeyOfHourly = (row: {
      client: string;
      model?: string;
    }) =>
      byModel
        ? row.model && !isUnknownModel(row.model)
          ? modelAggKey(row.model) || row.model
          : UNKNOWN_MODEL
        : row.client;

    const stackKeyOfSession = (s: SessionRecord) =>
      byModel
        ? modelAggKey(s.model) || s.model || UNKNOWN_MODEL
        : s.client;

    const addTo = (entry: Bucket, stackKey: string, tok: number) => {
      if (tok <= 0) return;
      entry.byStack.set(stackKey, (entry.byStack.get(stackKey) || 0) + tok);
      entry.total += tok;
    };

    let days: Bucket[];
    let hourlyMode = false;

    if (range === "today") {
      // 今天：固定 0–23 点（不裁成「首次有用量」起）
      hourlyMode = true;
      days = Array.from({ length: 24 }, (_, h) => ({
        key: `${String(h).padStart(2, "0")}:00`,
        byStack: new Map<string, number>(),
        total: 0,
      }));
      const todayKey = localDayKey(new Date());

      if (hasHourly) {
        for (const row of hourlyRows) {
          if (!activeClients.has(row.client)) continue;
          if (!row.hour.startsWith(todayKey)) continue;
          const h = Number(row.hour.slice(11, 13));
          if (!Number.isFinite(h) || h < 0 || h > 23) continue;
          addTo(days[h], stackKeyOfHourly(row), row.totalTokens || 0);
        }
      } else {
        for (const s of baseFiltered) {
          const iso = sessionDate(s);
          if (!iso || dayKey(iso) !== todayKey) continue;
          const h = new Date(iso).getHours();
          addTo(days[h], stackKeyOfSession(s), s.totalTokens);
        }
      }
    } else {
      days = [];
      const today = new Date();
      today.setHours(0, 0, 0, 0);

      /** @param {string} key YYYY-MM-DD */
      const parseDay = (key: string) => {
        const [y, m, d] = key.split("-").map(Number);
        const dt = new Date(y, m - 1, d);
        dt.setHours(0, 0, 0, 0);
        return dt;
      };

      /** @type {Map<string, Bucket>} */
      const rawByDay = new Map();
      const ensureDay = (key: string) => {
        let e = rawByDay.get(key);
        if (!e) {
          e = { key, byStack: new Map(), total: 0 };
          rawByDay.set(key, e);
        }
        return e;
      };

      if (hasHourly) {
        for (const row of hourlyRows) {
          if (!activeClients.has(row.client)) continue;
          const tok = row.totalTokens || 0;
          if (tok <= 0) continue;
          const day = row.hour.slice(0, 10);
          if (!isPlausibleDayKey(day)) continue;
          const t = parseDay(day).getTime();
          if (Number.isNaN(t)) continue;
          if (t > today.getTime() + 86_400_000) continue;
          if (rangeStart != null && t < rangeStart) continue;
          if (rangeEnd != null && t > rangeEnd) continue;
          addTo(ensureDay(day), stackKeyOfHourly(row), tok);
        }
      } else {
        for (const s of baseFiltered) {
          const iso = sessionDate(s);
          if (!iso || s.totalTokens <= 0) continue;
          const day = dayKey(iso);
          const t = parseDay(day).getTime();
          if (Number.isNaN(t)) continue;
          if (rangeStart != null && t < rangeStart) continue;
          if (rangeEnd != null && t > rangeEnd) continue;
          addTo(ensureDay(day), stackKeyOfSession(s), s.totalTokens);
        }
      }

      let start: Date;
      let end: Date = new Date(today);

      if (rangeStart != null) {
        // 固定窗口 [rangeStart, rangeEnd 或今天]，空日也保留
        start = new Date(rangeStart);
        start.setHours(0, 0, 0, 0);
        if (rangeEnd != null) {
          end = new Date(rangeEnd);
          end.setHours(0, 0, 0, 0);
        } else {
          end = new Date(today);
        }
      } else {
        // 全部：仅从「第一次有用量」画到「最后一次有用量」
        const activeKeys = [...rawByDay.keys()]
          .filter((k) => (rawByDay.get(k)?.total || 0) > 0)
          .sort();
        if (activeKeys.length === 0) {
          start = new Date(today);
          end = new Date(today);
        } else {
          start = parseDay(activeKeys[0]);
          end = parseDay(activeKeys[activeKeys.length - 1]);
          if (end.getTime() > today.getTime()) end = new Date(today);
        }
      }

      const MAX_SPAN = 366 * 3;
      let rawSpan =
        Math.round((end.getTime() - start.getTime()) / 86_400_000) + 1;
      if (rawSpan < 1) {
        start = new Date(end);
        rawSpan = 1;
      }
      // 仅「全部」可能超长：截成最近 MAX_SPAN 天
      if (rangeStart == null && rawSpan > MAX_SPAN) {
        start = new Date(end);
        start.setDate(start.getDate() - (MAX_SPAN - 1));
        rawSpan = MAX_SPAN;
      }

      for (let i = 0; i < rawSpan; i++) {
        const d = new Date(start);
        d.setDate(d.getDate() + i);
        const key = localDayKey(d);
        const existing = rawByDay.get(key);
        days.push(
          existing || { key, byStack: new Map<string, number>(), total: 0 }
        );
      }

      // 全部：再去掉首尾空柱（贴齐首末有数据日）
      if (rangeStart == null) {
        days = trimEmptyEnds(days);
      }
    }

    // 堆叠顺序：工具用固定 CLIENT_ORDER；模型按用量门槛单独展示
    const totalsByKey = new Map<string, number>();
    for (const d of days) {
      for (const [k, v] of d.byStack) {
        totalsByKey.set(k, (totalsByKey.get(k) || 0) + v);
      }
    }

    let stackKeys: string[];
    let colorOf: (k: string) => string;
    let labelOf: (k: string) => string;

    if (byModel) {
      const sorted = [...totalsByKey.entries()].sort((a, b) => b[1] - a[1]);
      const totalAll = sorted.reduce((acc, [, v]) => acc + v, 0) || 1;
      // 单独展示：用量 ≥ 全图 0.5%（至少 1 token），最多 20 段；再小的才并进「其他」
      const MIN_SHARE = 0.005;
      const MAX_NAMED = 20;
      const minAbs = Math.max(1, totalAll * MIN_SHARE);
      /** @type {string[]} */
      let top: string[] = [];
      /** @type {[string, number][]} */
      const rest: [string, number][] = [];
      for (const [k, v] of sorted) {
        if (k === "其他") continue;
        if (v >= minAbs && top.length < MAX_NAMED) top.push(k);
        else rest.push([k, v]);
      }
      // 若门槛过严导致只剩 1～2 个，至少保留用量 Top 8
      if (top.length < 8 && sorted.length > top.length) {
        top = sorted.slice(0, Math.min(8, sorted.length)).map(([k]) => k);
        rest.length = 0;
        for (const [k, v] of sorted) {
          if (!top.includes(k)) rest.push([k, v]);
        }
      }

      const otherKey = "其他";
      const otherNames = rest.map(([k]) => k);
      const otherTotal = rest.reduce((a, [, v]) => a + v, 0);
      if (rest.length && otherTotal > 0) {
        for (const d of days) {
          let other = 0;
          for (const [k, v] of [...d.byStack]) {
            if (!top.includes(k)) {
              other += v;
              d.byStack.delete(k);
            }
          }
          if (other > 0) d.byStack.set(otherKey, (d.byStack.get(otherKey) || 0) + other);
        }
        stackKeys = [...top, otherKey];
      } else {
        stackKeys = top;
      }
      colorOf = (k) => {
        if (k === otherKey) return "#5a5f6a";
        if (isUnknownModel(k)) return UNKNOWN_MODEL_COLOR;
        const i = stackKeys.indexOf(k);
        return MODEL_PALETTE[i >= 0 ? i % MODEL_PALETTE.length : 0];
      };
      labelOf = (k) => {
        if (k !== otherKey) return k;
        if (!otherNames.length) return "其他";
        // 悬停/图例：标明是小用量合并，不是某款模型
        const preview = otherNames.slice(0, 3).join("、");
        const more = otherNames.length > 3 ? ` 等${otherNames.length}种` : ` · ${otherNames.length}种`;
        return `其他（小用量${more}${otherNames.length <= 3 ? `：${preview}` : ""}）`;
      };
    } else {
      stackKeys = CLIENT_ORDER.filter((c) => (totalsByKey.get(c) || 0) > 0);
      // 也带上不在 CLIENT_ORDER 里的 client
      for (const k of totalsByKey.keys()) {
        if (!stackKeys.includes(k as (typeof CLIENT_ORDER)[number])) stackKeys.push(k);
      }
      colorOf = () => ""; // 用 class client-*
      labelOf = (k) =>
        CLIENT_LABELS[k as (typeof CLIENT_ORDER)[number]] || k;
    }

    const max = Math.max(1, ...days.map((d) => d.total));
    const firstDay = days[0]?.key;
    const lastDay = days[days.length - 1]?.key;
    return {
      days,
      max,
      hourly: hourlyMode,
      fromTurns: hasHourly,
      stackMode: trendStack,
      stackKeys,
      colorOf,
      labelOf,
      firstDay,
      lastDay,
    };
  }, [
    baseFiltered,
    rangeStart,
    rangeEnd,
    range,
    scopedHourly,
    activeClients,
    trendStack,
  ]);

  // 活跃热力图：与 GitHub 贡献图一致——近约 1 年（53 周）滑动窗口，右端对齐今天
  const heatmap = useMemo(() => {
    const q = query.trim().toLowerCase();
    const byDay = new Map<string, number>();
    // 优先 turn 小时桶（真实发生日）；无则回退会话 lastUsedAt
    const hourlyRows = scopedHourly;
    if (hourlyRows.length) {
      for (const row of hourlyRows) {
        if (!activeClients.has(row.client)) continue;
        const tok = row.totalTokens || 0;
        if (tok <= 0) continue;
        const k = row.hour.slice(0, 10);
        if (!isPlausibleDayKey(k)) continue;
        byDay.set(k, (byDay.get(k) || 0) + tok);
      }
    } else {
      for (const s of result?.sessions || []) {
        if (!activeClients.has(s.client)) continue;
        if (q && !matchesSession(s, q, CLIENT_LABELS)) continue;
        const iso = sessionDate(s);
        if (!iso) continue;
        const k = dayKey(iso);
        byDay.set(k, (byDay.get(k) || 0) + s.totalTokens);
      }
    }

    // GitHub contribution graph：约 53 列周 × 7 天，覆盖近一年
    const WEEKS = 53;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const start = new Date(today);
    // 周一起算（国内习惯）；窗口右端落在本周、含今天
    const dow = (start.getDay() + 6) % 7; // 周一 = 0
    start.setDate(start.getDate() - dow - (WEEKS - 1) * 7);

    const weeks: { key: string; total: number; future: boolean }[][] = [];
    const cursor = new Date(start);
    for (let w = 0; w < WEEKS; w++) {
      const week: { key: string; total: number; future: boolean }[] = [];
      for (let d = 0; d < 7; d++) {
        const key = localDayKey(cursor);
        week.push({
          key,
          total: byDay.get(key) || 0,
          future: cursor.getTime() > today.getTime(),
        });
        cursor.setDate(cursor.getDate() + 1);
      }
      weeks.push(week);
    }

    const max = Math.max(1, ...byDay.values());
    const monthLabels = weeks.map((week, i) => {
      const m = week[0].key.slice(5, 7);
      if (i === 0) return `${Number(m)}月`;
      return weeks[i - 1][0].key.slice(5, 7) !== m ? `${Number(m)}月` : "";
    });
    return { weeks, max, monthLabels };
  }, [result, activeClients, query, scopedHourly, drill]);

  // 按模型分布（概览）：与时间窗一致
  const modelDist = useMemo(() => {
    const map = new Map<string, number>();
    if (hourlyDims) {
      for (const [key, p] of hourlyDims.byModel) {
        map.set(key, p.totalTokens);
      }
    } else {
      for (const s of aggSessions) {
        const key = modelAggKey(s.model) || s.model || UNKNOWN_MODEL;
        map.set(key, (map.get(key) || 0) + (s.totalTokens || 0));
      }
    }
    const rows = [...map.entries()].sort((a, b) => b[1] - a[1]);
    const items = rows.slice(0, 8).map(([key, tokens], i) => ({
      key,
      tokens,
      color: isUnknownModel(key)
        ? UNKNOWN_MODEL_COLOR
        : MODEL_PALETTE[i % MODEL_PALETTE.length],
    }));
    const rest = rows.slice(8).reduce((acc, [, v]) => acc + v, 0);
    if (rest > 0) items.push({ key: "其他", tokens: rest, color: "#3f3f46" });
    return items;
  }, [aggSessions, hourlyDims]);

  const rangeTotal = useMemo(() => {
    if (hourlyDims) return hourlyDims.total.totalTokens;
    return aggSessions.reduce((acc, s) => acc + (s.totalTokens || 0), 0);
  }, [aggSessions, hourlyDims]);

  /** 生涯洞察：全部数据，不受时间范围 / 工具 chip 影响 */
  const lifetime = useMemo(
    () => computeLifetimeInsights(result?.sessions || [], result?.hourly),
    [result]
  );

  const weekdayMax = useMemo(
    () => Math.max(1, ...lifetime.weekdayTotals),
    [lifetime.weekdayTotals]
  );
  const topDayMax = useMemo(
    () => Math.max(1, ...lifetime.topDays.map((d) => d.tokens), 1),
    [lifetime.topDays]
  );

  /** 生涯页：24h 分布 + 累计曲线 */
  const lifeCharts = useMemo(() => {
    const byHour = new Map<number, number>();
    const byDay = new Map<string, number>();
    const hourly = result?.hourly || [];
    if (hourly.length) {
      for (const row of hourly) {
        const day = row.hour.slice(0, 10);
        if (!isPlausibleDayKey(day)) continue;
        const tok = row.totalTokens || 0;
        if (tok <= 0) continue;
        byDay.set(day, (byDay.get(day) || 0) + tok);
        const hh = Number(row.hour.slice(11, 13));
        if (Number.isFinite(hh) && hh >= 0 && hh <= 23) {
          byHour.set(hh, (byHour.get(hh) || 0) + tok);
        }
      }
    } else {
      for (const s of result?.sessions || []) {
        if (s.dedupExcluded || (s.isSubagent && !s.deleted)) continue;
        const iso = sessionDate(s);
        if (!iso) continue;
        const tok = s.totalTokens || 0;
        if (tok <= 0) continue;
        const day = dayKey(iso);
        if (!isPlausibleDayKey(day)) continue;
        byDay.set(day, (byDay.get(day) || 0) + tok);
        byHour.set(
          new Date(iso).getHours(),
          (byHour.get(new Date(iso).getHours()) || 0) + tok
        );
      }
    }
    const hourProfile = Array.from({ length: 24 }, (_, h) => ({
      hour: h,
      tokens: byHour.get(h) || 0,
    }));
    const hourMax = Math.max(1, ...hourProfile.map((h) => h.tokens));
    const days = [...byDay.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    let cum = 0;
    const cumSeries = days.map(([day, tokens]) => {
      cum += tokens;
      return { label: day.slice(5), value: cum, day, tokens };
    });
    // 稀疏采样：超过 90 天时按周抽点展示仍保留 cum 正确
    let plot = cumSeries;
    if (cumSeries.length > 90) {
      plot = cumSeries.filter(
        (_, i) => i === 0 || i === cumSeries.length - 1 || i % 3 === 0
      );
    }
    return {
      hourProfile,
      hourMax,
      cumSeries: plot,
      cumMax: Math.max(1, cum),
      spark: days.map(([, t]) => t),
    };
  }, [result]);

  /** 概览：随时间范围变化的区间洞察 + 图表序列 */
  const rangeInsights = useMemo(() => {
    const byDay = new Map<
      string,
      { tokens: number; sessions: number; input: number; output: number; cost: number }
    >();
    const byHour = new Map<number, number>();
    const byProject = new Map<string, number>();
    const todayKey = localDayKey(new Date());
    const hourlyRows = result?.hourly || [];

    const bumpDay = (
      day: string,
      parts: {
        tokens?: number;
        sessions?: number;
        input?: number;
        output?: number;
        cost?: number;
      }
    ) => {
      let e = byDay.get(day);
      if (!e) {
        e = { tokens: 0, sessions: 0, input: 0, output: 0, cost: 0 };
        byDay.set(day, e);
      }
      e.tokens += parts.tokens || 0;
      e.sessions += parts.sessions || 0;
      e.input += parts.input || 0;
      e.output += parts.output || 0;
      e.cost += parts.cost || 0;
    };

    if (hourlyRows.length) {
      for (const row of hourlyRows) {
        if (!activeClients.has(row.client)) continue;
        const day = row.hour.slice(0, 10);
        if (!isPlausibleDayKey(day)) continue;
        {
          const t = new Date(`${day}T12:00:00`).getTime();
          if (Number.isNaN(t)) continue;
          if (rangeStart != null && t < rangeStart) continue;
          if (rangeEnd != null && t > rangeEnd) continue;
        }
        const tok = row.totalTokens || 0;
        if (tok <= 0) continue;
        bumpDay(day, {
          tokens: tok,
          input: row.inputTokens || 0,
          output: row.outputTokens || 0,
        });
        const hh = Number(row.hour.slice(11, 13));
        if (Number.isFinite(hh) && hh >= 0 && hh <= 23) {
          byHour.set(hh, (byHour.get(hh) || 0) + tok);
        }
      }
      // 会话数 / 成本：本区间汇总会话（可拆时不含全量兜底）
      for (const s of aggSessions) {
        const iso = sessionDate(s);
        if (!iso) continue;
        const day = dayKey(iso);
        if (!isPlausibleDayKey(day)) continue;
        {
          const t = new Date(`${day}T12:00:00`).getTime();
          if (Number.isNaN(t)) continue;
          if (rangeStart != null && t < rangeStart) continue;
          if (rangeEnd != null && t > rangeEnd) continue;
        }
        bumpDay(day, {
          sessions: 1,
          cost: displayCost(s, currency, fx.rate) || 0,
        });
      }
    } else {
      for (const s of aggSessions) {
        const iso = sessionDate(s);
        if (!iso) continue;
        const tok = s.totalTokens || 0;
        const day = dayKey(iso);
        if (!isPlausibleDayKey(day)) continue;
        bumpDay(day, {
          tokens: tok,
          sessions: tok > 0 || (s.inputTokens || 0) > 0 ? 1 : 0,
          input: s.inputTokens || 0,
          output: s.outputTokens || 0,
          cost: displayCost(s, currency, fx.rate) || 0,
        });
        if (tok > 0) {
          const h = new Date(iso).getHours();
          byHour.set(h, (byHour.get(h) || 0) + tok);
        }
      }
    }

    // 项目 Top：与「按项目」一致，hourly→cwd（禁止会话全量）
    if (hourlyRows.length) {
      const projMap = buildProjectTokensFromHourly(
        hourlyRows,
        result?.sessions || [],
        rangeStart,
        todayKey,
        activeClients,
        rangeEnd
      );
      for (const [cwd, tok] of projMap) {
        if (tok > 0) byProject.set(cwd, tok);
      }
    } else {
      for (const s of aggSessions) {
        const cwd = s.cwd || "未知目录";
        byProject.set(cwd, (byProject.get(cwd) || 0) + (s.totalTokens || 0));
      }
    }

    let peakDay: { day: string; tokens: number } | null = null;
    for (const [day, e] of byDay) {
      if (!peakDay || e.tokens > peakDay.tokens) {
        peakDay = { day, tokens: e.tokens };
      }
    }
    let busiestHour: { hour: number; tokens: number } | null = null;
    for (const [hour, tokens] of byHour) {
      if (!busiestHour || tokens > busiestHour.tokens) {
        busiestHour = { hour, tokens };
      }
    }

    const activeDays = [...byDay.values()].filter((e) => e.tokens > 0).length;
    const tokens =
      [...byDay.values()].reduce((a, e) => a + e.tokens, 0) || totals.totalTokens;
    const sessions = aggSessions.filter(
      (s) => (s.totalTokens || 0) > 0 || (s.inputTokens || 0) > 0
    ).length;
    const avgDay = activeDays > 0 ? tokens / activeDays : 0;
    const avgSession = sessions > 0 ? tokens / sessions : 0;

    const topProjects = [...byProject.entries()]
      .filter(([, t]) => t > 0)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([cwd, t]) => ({
        cwd,
        label: cwd.split(/[\\/]/).filter(Boolean).pop() || cwd,
        tokens: t,
      }));
    const topProjMax = Math.max(1, ...topProjects.map((p) => p.tokens), 1);

    let prevTokens = 0;
    let vsPrev: string | null = null;
    if (rangeStart != null && range !== "today" && range !== "custom") {
      const win = Date.now() - rangeStart;
      const prevFrom = rangeStart - win;
      const prevTo = rangeStart;
      if (hourlyRows.length) {
        for (const row of hourlyRows) {
          if (!activeClients.has(row.client)) continue;
          const day = row.hour.slice(0, 10);
          if (!isPlausibleDayKey(day)) continue;
          const t = new Date(`${day}T12:00:00`).getTime();
          if (t >= prevFrom && t < prevTo) prevTokens += row.totalTokens || 0;
        }
      } else {
        for (const s of result?.sessions || []) {
          if (!activeClients.has(s.client)) continue;
          const iso = sessionDate(s);
          if (!iso) continue;
          const t = new Date(iso).getTime();
          if (t >= prevFrom && t < prevTo) prevTokens += s.totalTokens || 0;
        }
      }
      vsPrev = pctChange(tokens, prevTokens);
    } else if (range === "today") {
      prevTokens = deltas.yesterday;
      vsPrev = pctChange(tokens, prevTokens);
    }

    const estCacheBar = totals.estCacheReadTokens || 0;
    const heroInput = uncachedInputOf({
      inputTokens: totals.inputTokens,
      outputTokens: totals.outputTokens,
      reasoningTokens: totals.reasoningTokens,
      totalTokens: totals.totalTokens,
      estCacheReadTokens: estCacheBar || undefined,
    });
    const compTotal =
      heroInput +
      totals.outputTokens +
      totals.cacheReadTokens +
      estCacheBar +
      totals.cacheWriteTokens +
      totals.reasoningTokens;
    // 构成条用独立色，避开工具色 / 主强调绿
    const composition = [
      { key: "Input", tokens: heroInput, color: "#22d3ee" },
      { key: "Output", tokens: totals.outputTokens, color: "#fb7185" },
      { key: "Cache R", tokens: totals.cacheReadTokens + estCacheBar, color: "#a3e635" },
      { key: "Cache W", tokens: totals.cacheWriteTokens, color: "#818cf8" },
      { key: "Reason", tokens: totals.reasoningTokens, color: "#e879f9" },
    ].filter((c) => c.tokens > 0);

    // —— 图表序列 ——
    // 「今天」用 0–23 小时序列，避免日粒度只有 1 个点变成三角山
    const grain: "hour" | "day" = range === "today" ? "hour" : "day";

    const hourProfile = Array.from({ length: 24 }, (_, h) => ({
      hour: h,
      tokens: byHour.get(h) || 0,
    }));
    const hourMax = Math.max(1, ...hourProfile.map((h) => h.tokens));

    type SeriesPt = {
      day: string;
      label: string;
      tokens: number;
      sessions: number;
      input: number;
      output: number;
      cost: number;
      cum: number;
    };

    let seriesFinal: SeriesPt[] = [];

    if (grain === "hour") {
      const buckets = Array.from({ length: 24 }, () => ({
        tokens: 0,
        sessions: 0,
        input: 0,
        output: 0,
        cost: 0,
      }));
      // 成本必须跟 token 一样按「发生小时」分摊，不能整段砸进 lastUsedAt
      const costRates = modelCostPerToken(aggSessions, currency, fx.rate);
      if (hourlyRows.length) {
        for (const row of hourlyRows) {
          if (!activeClients.has(row.client)) continue;
          if (!row.hour.startsWith(todayKey)) continue;
          const hh = Number(row.hour.slice(11, 13));
          if (!Number.isFinite(hh) || hh < 0 || hh > 23) continue;
          const tok = row.totalTokens || 0;
          if (tok <= 0) continue;
          buckets[hh].tokens += tok;
          buckets[hh].input += row.inputTokens || 0;
          buckets[hh].output += row.outputTokens || 0;
          buckets[hh].cost += hourlyBucketCost(
            row,
            currency,
            fx.rate,
            costRates
          );
        }
        // 会话数：本区间汇总会话
        for (const s of aggSessions) {
          const iso = sessionDate(s);
          if (!iso) continue;
          if (dayKey(iso) !== todayKey) continue;
          const hh = new Date(iso).getHours();
          if (hh < 0 || hh > 23) continue;
          buckets[hh].sessions += 1;
        }
      } else {
        for (const s of aggSessions) {
          const iso = sessionDate(s);
          if (!iso) continue;
          if (dayKey(iso) !== todayKey) continue;
          const hh = new Date(iso).getHours();
          if (hh < 0 || hh > 23) continue;
          const tok = s.totalTokens || 0;
          buckets[hh].tokens += tok;
          buckets[hh].input += s.inputTokens || 0;
          buckets[hh].output += s.outputTokens || 0;
          buckets[hh].sessions +=
            tok > 0 || (s.inputTokens || 0) > 0 ? 1 : 0;
          buckets[hh].cost += displayCost(s, currency, fx.rate) || 0;
        }
      }
      let cumH = 0;
      seriesFinal = buckets.map((e, h) => {
        cumH += e.tokens;
        const label = `${String(h).padStart(2, "0")}:00`;
        return {
          day: label,
          label,
          tokens: e.tokens,
          sessions: e.sessions,
          input: e.input,
          output: e.output,
          cost: e.cost,
          cum: cumH,
        };
      });
    } else {
      let dayKeys: string[] = [];
      if (rangeStart != null) {
        const start = new Date(rangeStart);
        start.setHours(0, 0, 0, 0);
        const end = new Date(rangeEnd != null ? rangeEnd : Date.now());
        end.setHours(0, 0, 0, 0);
        for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
          dayKeys.push(localDayKey(d));
        }
      } else {
        dayKeys = [...byDay.keys()].sort();
      }

      let cum = 0;
      let dailySeries = dayKeys.map((day) => {
        const e = byDay.get(day) || {
          tokens: 0,
          sessions: 0,
          input: 0,
          output: 0,
          cost: 0,
        };
        cum += e.tokens;
        return {
          day,
          label: day.slice(5),
          tokens: e.tokens,
          sessions: e.sessions,
          input: e.input,
          output: e.output,
          cost: e.cost,
          cum,
        };
      });
      // 全部：裁掉两端空日
      if (range === "all" && dailySeries.length) {
        let lo = 0;
        let hi = dailySeries.length - 1;
        while (lo <= hi && dailySeries[lo].tokens <= 0) lo += 1;
        while (hi >= lo && dailySeries[hi].tokens <= 0) hi -= 1;
        dailySeries =
          lo <= hi ? dailySeries.slice(lo, hi + 1) : dailySeries.slice(0, 1);
        let c = 0;
        dailySeries = dailySeries.map((d) => {
          c += d.tokens;
          return { ...d, cum: c };
        });
      }
      seriesFinal = dailySeries;
    }

    const dayTokMax = Math.max(1, ...seriesFinal.map((d) => d.tokens));
    const daySessMax = Math.max(1, ...seriesFinal.map((d) => d.sessions));
    const dayIoMax = Math.max(
      1,
      ...seriesFinal.map((d) => d.input),
      ...seriesFinal.map((d) => d.output)
    );
    const cumMax = Math.max(1, ...seriesFinal.map((d) => d.cum));
    const costMax = Math.max(1, ...seriesFinal.map((d) => d.cost));

    const sparkValues = seriesFinal.map((d) => d.tokens);
    const sparkSessions = seriesFinal.map((d) => d.sessions);

    // 工作日 vs 周末（今天：整日归一类）
    let weekdayTok = 0;
    let weekendTok = 0;
    if (grain === "hour") {
      const js = new Date().getDay();
      const t = seriesFinal.reduce((a, d) => a + d.tokens, 0);
      if (js === 0 || js === 6) weekendTok = t;
      else weekdayTok = t;
    } else {
      for (const d of seriesFinal) {
        const js = new Date(d.day + "T12:00:00").getDay();
        if (js === 0 || js === 6) weekendTok += d.tokens;
        else weekdayTok += d.tokens;
      }
    }

    return {
      peakDay,
      busiestHour,
      activeDays,
      tokens,
      sessions,
      avgDay,
      avgSession,
      topProjects,
      topProjMax,
      prevTokens,
      vsPrev,
      composition,
      compTotal: Math.max(1, compTotal),
      hourProfile,
      hourMax,
      grain,
      dailySeries: seriesFinal,
      dayTokMax,
      daySessMax,
      dayIoMax,
      cumMax,
      costMax,
      sparkValues,
      sparkSessions,
      weekdayTok,
      weekendTok,
    };
  }, [
    result,
    activeClients,
    range,
    rangeStart,
    rangeEnd,
    aggSessions,
    totals,
    deltas.yesterday,
    currency,
    fx.rate,
  ]);

  /**
   * 工具筛选：
   * - 普通点击：只看该工具（再点同一工具 = 恢复全部）
   * - Ctrl/Cmd/Shift + 点击：多选开关（旧行为）
   * 避免「想看 Grok 却点掉了 Grok」导致列表像坏了一样。
   */
  function toggleClient(id: string, e?: MouseEvent) {
    const multi = !!(e && (e.metaKey || e.ctrlKey || e.shiftKey));
    setActiveClients((prev) => {
      let next: Set<string>;
      if (multi) {
        next = new Set(prev);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        if (next.size === 0) next = new Set(CLIENT_ORDER);
      } else if (prev.size === 1 && prev.has(id)) {
        next = new Set(CLIENT_ORDER);
      } else {
        next = new Set([id]);
      }
      localStorage.setItem("token-stats:clients", JSON.stringify([...next]));
      return next;
    });
  }

  function toggleHideEmpty() {
    setHideEmpty((prev) => {
      localStorage.setItem("token-stats:hideEmpty", prev ? "0" : "1");
      return !prev;
    });
  }

  function toggleHideOrphans() {
    setHideOrphans((prev) => {
      localStorage.setItem("token-stats:hideOrphans", prev ? "0" : "1");
      return !prev;
    });
  }

  function toggleHideDeleted() {
    setHideDeleted((prev) => {
      localStorage.setItem("token-stats:hideDeleted", prev ? "0" : "1");
      return !prev;
    });
  }

  function toggleHideDedupExcluded() {
    setHideDedupExcluded((prev) => {
      localStorage.setItem("token-stats:hideDedupExcluded", prev ? "0" : "1");
      return !prev;
    });
  }

  function toggleTrendStack() {
    setTrendStack((prev) => {
      const next = prev === "client" ? "model" : "client";
      localStorage.setItem("token-stats:trendStack", next);
      return next;
    });
  }

  const rangeLabel = (() => {
    if (range === "custom") {
      const a = (customFrom || "").slice(5) || customFrom;
      const b = (customTo || "").slice(5) || customTo;
      return a && b ? `${a} → ${b}` : "自定义";
    }
    const base = RANGES.find((r) => r.id === range)!.label;
    // 全部：标明真实数据起止日（首次有用量 → 最后有用量）
    if (
      range === "all" &&
      trend.firstDay &&
      trend.lastDay &&
      !trend.hourly
    ) {
      return `${base} · ${trend.firstDay.slice(5)} → ${trend.lastDay.slice(5)}`;
    }
    return base;
  })();

  return (
    <div className="app">
      <header className="topbar">
        <button
          type="button"
          className={`brand brand-home${view === "home" ? " on-home" : ""}`}
          onClick={goHome}
          title="生涯首页"
        >
          <span className="brand-mark" />
          Token Stats
        </button>
        <nav className="range-switch view-tabs">
          {VIEWS.map((v) => (
            <button
              key={v.id}
              className={`range-btn ${view === v.id ? "active" : ""}`}
              onClick={() => switchView(v.id)}
            >
              {v.label}
            </button>
          ))}
        </nav>
        <div className="status">
          {loading
            ? "扫描中…"
            : result
              ? `${result.sessions.length} 个会话${
                  result.totals?.deletedSessions
                    ? ` · ${result.totals.deletedSessions} 已删除`
                    : ""
                } · ${formatRelative(result.scannedAt)}扫描 · ${result.durationMs}ms`
              : "尚未扫描"}
        </div>
        <div className="spacer" />
        {ENABLE_SYNC && (
          <button
            className={`btn ghost ${showSync ? "on" : ""}`}
            onClick={() => setShowSync(true)}
            title="Supabase 云同步"
          >
            同步
          </button>
        )}
        {typeof window !== "undefined" && window.tokenStats?.pricing && (
          <button
            className={`btn ghost ${showPricing ? "on" : ""}`}
            onClick={() => {
              setPricingFocus([]);
              setShowPricing(true);
            }}
            title="自定义模型价格与别名"
          >
            价格
            {(result?.unpricedModels?.length || 0) > 0
              ? ` ${result!.unpricedModels!.length}`
              : ""}
          </button>
        )}
        <button
          className={`btn ghost ${showReports ? "on" : ""}`}
          onClick={() => setShowReports((v) => !v)}
        >
          扫描详情
        </button>
        <select
          className="refresh-select"
          value={autoRefresh}
          onChange={(e) => changeAutoRefresh(Number(e.target.value))}
          title="自动重新扫描间隔"
        >
          <option value={0}>手动刷新</option>
          <option value={1}>每 1 分钟</option>
          <option value={5}>每 5 分钟</option>
          <option value={15}>每 15 分钟</option>
        </select>
        <button className="btn primary" onClick={() => void runScan()} disabled={loading}>
          {loading ? "扫描中…" : "重新扫描"}
        </button>
      </header>

      {showReports && (
        <div className="reports">
          {(result?.reports || []).map((r) => (
            <div
              key={r.id}
              className={`report-pill ${r.error ? "error" : ""} ${!r.detected ? "off" : ""}`}
            >
              <span className="dot" />
              {r.displayName} ·{" "}
              {!r.detected
                ? "未检测到"
                : r.error
                  ? `错误：${r.error}`
                  : `${r.count} 会话 · ${r.ms}ms`}
            </div>
          ))}
          {(result?.dedupReports || []).length > 0 && (
            <div
              className="report-pill"
              title="跨工具发现相同 sessionId 的会话，已按工具优先级保留一条计入总额，其余在表格中标「未计入」"
            >
              <span className="dot" style={{ background: "#d98e5f" }} />
              去重 {(result?.dedupReports || []).length} 组 · 省{" "}
              {(result?.dedupReports || []).reduce(
                (a, r) => a + (r.savedTotalTokens || 0),
                0
              )}{" "}
              tokens
              <details className="dedup-details">
                <summary>查看</summary>
                <ul>
                  {(result?.dedupReports || []).map((d) => (
                    <li key={d.sessionId}>
                      {CLIENT_LABELS[d.keptClient as (typeof CLIENT_ORDER)[number]] ||
                        d.keptClient}
                      {" ← "}
                      {d.excludedClients
                        .map(
                          (c) =>
                            CLIENT_LABELS[c as (typeof CLIENT_ORDER)[number]] || c
                        )
                        .join("、")}
                      {" · "}
                      {d.sessionId.slice(0, 8)}…
                    </li>
                  ))}
                </ul>
              </details>
            </div>
          )}
        </div>
      )}

      {error && <div className="error-banner">{error}</div>}

      {ENABLE_SYNC && (
        <SyncPanel
          open={showSync}
          onClose={() => setShowSync(false)}
          scanResult={result}
          onNeedScan={runScan}
        />
      )}
      {typeof window !== "undefined" && window.tokenStats?.pricing && (
        <PricingPanel
          open={showPricing}
          onClose={() => {
            setShowPricing(false);
            setPricingFocus([]);
          }}
          unpricedModels={result?.unpricedModels}
          focusModels={pricingFocus}
          onNeedScan={runScan}
        />
      )}

      <SessionDetailPanel
        session={detailSession}
        onClose={() => setDetailSession(null)}
      />

      <main className="content">
        {view !== "home" && (
        <div className="toolbar">
          <div className="range-switch">
            {RANGES.map((r) => (
              <button
                key={r.id}
                className={`range-btn ${range === r.id ? "active" : ""}`}
                onClick={() => switchRange(r.id)}
              >
                {r.label}
              </button>
            ))}
          </div>
          {range === "custom" && (
            <div className="custom-range" title="自定义起止日期（含首尾两天）">
              <input
                type="date"
                className="custom-range-input"
                value={customFrom}
                max={customTo || undefined}
                onChange={(e) => setCustomDay("from", e.target.value)}
              />
              <span className="custom-range-sep">→</span>
              <input
                type="date"
                className="custom-range-input"
                value={customTo}
                min={customFrom || undefined}
                onChange={(e) => setCustomDay("to", e.target.value)}
              />
            </div>
          )}
          {!canSplitByRange && (
            <span className="usage-banner warn" title="缺少带 session 的小时桶，请重新扫描">
              无法按区间拆分 · 显示全量
            </span>
          )}
          {canSplitByRange && fallbackCount > 0 && (
            <span
              className="usage-banner"
              title="这些会话没有 turn 级时间，数字为会话全量（未计入本区汇总）"
            >
              {fallbackCount} 条未拆分 · 已标「全量」
            </span>
          )}
          {query.trim() && (
            <button
              type="button"
              className="btn ghost drill-chip on"
              onClick={() => setQuery("")}
              title="清除搜索词（概览数字已按搜索收口）"
            >
              搜索：{query.trim()} · 清除
            </button>
          )}
          {drill && (
            <button
              type="button"
              className="btn ghost drill-chip on"
              onClick={clearDrill}
              title="清除分类下钻筛选"
            >
              下钻：{drillCaption(drill)} · 清除
            </button>
          )}
          <button className="btn ghost" onClick={exportCsv} disabled={filtered.length === 0}>
            导出 CSV
          </button>
          <button className="btn ghost" onClick={exportJson} disabled={filtered.length === 0}>
            导出 JSON
          </button>
          <button
            className={`btn ghost ${hideEmpty ? "on" : ""}`}
            onClick={toggleHideEmpty}
            title="隐藏未调用模型 / 0 token 空壳会话（Grok 里很常见）"
          >
            {hideEmpty
              ? `已藏空/未调用${emptyHiddenCount ? ` ${emptyHiddenCount}` : ""}`
              : "显示空/未调用"}
          </button>
          <button
            className={`btn ghost ${hideOrphans ? "on" : ""}`}
            onClick={toggleHideOrphans}
            title="未能并入父会话的子 agent（父不可用）。有本地持久化后应很少见；默认隐藏"
          >
            {hideOrphans
              ? `已藏未归并${orphanHiddenCount ? ` ${orphanHiddenCount}` : ""}`
              : "显示未归并"}
          </button>
          <button
            className={`btn ghost ${hideDeleted ? "on" : ""}`}
            onClick={toggleHideDeleted}
            title="源端日志已删、本地库仍保留的会话。默认显示并标「已删除」；打开则从列表隐藏"
          >
            {hideDeleted
              ? `已藏已删除${deletedHiddenCount ? ` ${deletedHiddenCount}` : ""}`
              : `已删除${(result?.totals?.deletedSessions ?? 0) ? ` ${result?.totals?.deletedSessions}` : ""}`}
          </button>
          {dedupExcludedTotal > 0 && (
            <button
              className={`btn ghost ${hideDedupExcluded ? "on" : ""}`}
              onClick={toggleHideDedupExcluded}
              title="跨工具去重被排除的会话（sessionId 相同）。默认显示并标「未计入」；打开则从列表隐藏"
            >
              {hideDedupExcluded
                ? `已藏未计入${dedupExcludedHiddenCount ? ` ${dedupExcludedHiddenCount}` : ""}`
                : `未计入${dedupExcludedTotal ? ` ${dedupExcludedTotal}` : ""}`}
            </button>
          )}
          <SearchBox
            value={query}
            onChange={setQuery}
            placeholder="搜索标题 / 路径 / 模型 / 工具…"
            sessions={searchPool}
            clientLabels={CLIENT_LABELS}
            onPickSession={(client, sessionId) => {
              const s = (result?.sessions || []).find(
                (x) => x.client === client && x.sessionId === sessionId
              );
              if (s) setDetailSession(s);
            }}
            onPickDrill={applySearchDrill}
          />
        </div>
        )}

        {view === "home" && (
        <>
        <section className="panel lifetime-panel">
          {window.tokenStats?.pricing && (
            <UnpricedBanner
              items={result?.unpricedModels}
              loadError={result?.pricingLoadError}
              onOpen={(models) => {
                setPricingFocus(models);
                setShowPricing(true);
              }}
            />
          )}
          <div className="panel-head">
            <h2>生涯</h2>
            <span className="panel-hint">
              全部数据
              {lifetime.firstDay && lifetime.lastDay
                ? ` · ${lifetime.firstDay} → ${lifetime.lastDay}`
                : ""}
            </span>
          </div>

          {lifetime.lifetimeTokens <= 0 ? (
            <div className="lifetime-empty">
              还没有可用量数据。先点右上角「重新扫描」，扫完就能看到峰值日、连击和黄金时段。
            </div>
          ) : (
            <>
              <div className="lifetime-journey">
                <div className="journey-stat">
                  <span className="journey-label">历程</span>
                  <span className="journey-value">
                    {lifetime.calendarSpanDays} 天跨度 · 活跃{" "}
                    {lifetime.activeDays} 天
                  </span>
                </div>
                <div className="journey-stat">
                  <span className="journey-label">生涯 Token</span>
                  <span className="journey-value">
                    {formatTokens(lifetime.lifetimeTokens)}
                  </span>
                </div>
                <div className="journey-stat">
                  <span className="journey-label">有用量会话</span>
                  <span className="journey-value">
                    {lifetime.lifetimeSessions.toLocaleString()}
                  </span>
                </div>
                <div className="journey-stat">
                  <span className="journey-label">活跃日均</span>
                  <span className="journey-value">
                    {formatTokens(lifetime.avgActiveDay)}
                  </span>
                </div>
              </div>

              <div className="insight-grid">
                <button
                  type="button"
                  className="insight-card"
                  disabled={!lifetime.peakDay}
                  onClick={() => {
                    if (!lifetime.peakDay) return;
                    setRange("all");
                    localStorage.setItem("token-stats:range", "all");
                    drillToSessions({ kind: "day", day: lifetime.peakDay.day });
                  }}
                  title={
                    lifetime.peakDay
                      ? `查看 ${lifetime.peakDay.day} 的会话`
                      : undefined
                  }
                >
                  <div className="insight-kicker">峰值日</div>
                  <div className="insight-main">
                    {lifetime.peakDay?.day ?? "–"}
                  </div>
                  <div className="insight-sub">
                    {lifetime.peakDay
                      ? `${formatTokens(lifetime.peakDay.tokens)} tokens`
                      : "暂无"}
                    {lifetime.peakDay && lifetime.lifetimeTokens > 0 && (
                      <span className="insight-pct">
                        {" "}
                        · 占生涯{" "}
                        {Math.round(
                          (lifetime.peakDay.tokens / lifetime.lifetimeTokens) *
                            100
                        )}
                        %
                      </span>
                    )}
                  </div>
                </button>

                <button
                  type="button"
                  className="insight-card"
                  disabled={!lifetime.peakSession}
                  onClick={() => {
                    if (lifetime.peakSession) setDetailSession(lifetime.peakSession);
                  }}
                  title={
                    lifetime.peakSession
                      ? "打开该会话详情"
                      : undefined
                  }
                >
                  <div className="insight-kicker">最重会话</div>
                  <div className="insight-main insight-ellipsis">
                    {lifetime.peakSession
                      ? lifetime.peakSession.title ||
                        shortId(lifetime.peakSession.sessionId)
                      : "–"}
                  </div>
                  <div className="insight-sub">
                    {lifetime.peakSession
                      ? `${formatTokens(lifetime.peakSession.totalTokens)} · ${
                          CLIENT_LABELS[
                            lifetime.peakSession
                              .client as (typeof CLIENT_ORDER)[number]
                          ] || lifetime.peakSession.client
                        }`
                      : "暂无"}
                  </div>
                </button>

                <div className="insight-card static">
                  <div className="insight-kicker">连击</div>
                  <div className="insight-main">
                    {lifetime.currentStreak > 0
                      ? `${lifetime.currentStreak} 天`
                      : "未连击"}
                  </div>
                  <div className="insight-sub">
                    最长 {lifetime.longestStreak} 天
                    {lifetime.todayTokens > 0
                      ? ` · 今日 ${formatTokens(lifetime.todayTokens)}`
                      : " · 今日尚无用量"}
                  </div>
                </div>

                <div className="insight-card static">
                  <div className="insight-kicker">黄金时段</div>
                  <div className="insight-main">
                    {lifetime.busiestHour
                      ? formatHourRange(lifetime.busiestHour.hour)
                      : "–"}
                  </div>
                  <div className="insight-sub">
                    {lifetime.busiestHour
                      ? `累计 ${formatTokens(lifetime.busiestHour.tokens)} tokens`
                      : "暂无小时数据"}
                  </div>
                </div>
              </div>

              <div className="lifetime-meta-row">
                {lifetime.topClient && (
                  <div className="lifetime-meta-chip">
                    <span className="meta-k">主力工具</span>
                    <span className="meta-v">
                      {CLIENT_LABELS[
                        lifetime.topClient.id as (typeof CLIENT_ORDER)[number]
                      ] || lifetime.topClient.id}{" "}
                      · {lifetime.topClient.pct}%
                    </span>
                  </div>
                )}
                {lifetime.topModel && (
                  <div className="lifetime-meta-chip" title={lifetime.topModel.model}>
                    <span className="meta-k">主力模型</span>
                    <span className="meta-v">
                      {lifetime.topModel.model} · {lifetime.topModel.pct}%
                    </span>
                  </div>
                )}
                {lifetime.topProject && (
                  <div
                    className="lifetime-meta-chip"
                    title={lifetime.topProject.cwd}
                  >
                    <span className="meta-k">主力项目</span>
                    <span className="meta-v">
                      {lifetime.topProject.label} ·{" "}
                      {formatTokens(lifetime.topProject.tokens)}
                    </span>
                  </div>
                )}
              </div>

              <div className="lifetime-split">
                <div className="lifetime-top-days">
                  <div className="mini-head">Token 最高的 5 天</div>
                  <ul className="top-day-list">
                    {lifetime.topDays.map((d, i) => (
                      <li key={d.day}>
                        <button
                          type="button"
                          className="top-day-row"
                          onClick={() => {
                            setRange("all");
                            localStorage.setItem("token-stats:range", "all");
                            drillToSessions({ kind: "day", day: d.day });
                          }}
                        >
                          <span className="top-day-rank">{i + 1}</span>
                          <span className="top-day-date">{d.day}</span>
                          <span className="top-day-bar-track">
                            <span
                              className="top-day-bar"
                              style={{
                                width: `${(d.tokens / topDayMax) * 100}%`,
                              }}
                            />
                          </span>
                          <span className="top-day-tok">
                            {formatTokens(d.tokens)}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
                <div className="lifetime-weekday">
                  <div className="mini-head">星期偏好</div>
                  <div className="weekday-bars">
                    {lifetime.weekdayTotals.map((tok, i) => {
                      const h = weekdayMax > 0 ? (tok / weekdayMax) * 100 : 0;
                      return (
                        <div
                          key={i}
                          className="weekday-col"
                          title={`${formatTokens(tok)} tokens`}
                        >
                          <span className="weekday-val">
                            {tok > 0 ? formatTokens(tok) : ""}
                          </span>
                          <div className="weekday-track">
                            <div
                              className="weekday-fill"
                              style={{
                                height: `${Math.max(tok > 0 ? 4 : 0, h)}%`,
                                background: WEEKDAY_COLORS[i],
                              }}
                            />
                          </div>
                          <span className="weekday-label">
                            {weekdayNameMonFirst(i)}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
            </>
          )}
        </section>

        <section className="panel">
          <div className="panel-head">
            <h2>活跃热力图</h2>
            <span className="panel-hint">近 1 年 · 53 周 · 生涯全量</span>
            <span className="heat-legend">
              少
              <i className="heat-cell lv0" />
              <i className="heat-cell lv1" />
              <i className="heat-cell lv2" />
              <i className="heat-cell lv3" />
              <i className="heat-cell lv4" />
              多
            </span>
          </div>
          <div className="heat-scroll">
            <div className="heat-months">
              {heatmap.monthLabels.map((m, i) => (
                <span key={i}>{m}</span>
              ))}
            </div>
            <div className="heat-body">
              <div className="heat-dows">
                {["一", "", "三", "", "五", "", ""].map((d, i) => (
                  <span key={i}>{d}</span>
                ))}
              </div>
              {heatmap.weeks.map((week, wi) => (
                <div key={wi} className="heat-week">
                  {week.map((cell) => {
                    const ratio = cell.total / heatmap.max;
                    const lv =
                      cell.total === 0
                        ? 0
                        : ratio < 0.2
                          ? 1
                          : ratio < 0.4
                            ? 2
                            : ratio < 0.7
                              ? 3
                              : 4;
                    return (
                      <div
                        key={cell.key}
                        className={`heat-cell lv${lv} ${cell.future ? "future" : ""}`}
                        title={
                          cell.future
                            ? cell.key
                            : `${cell.key} · ${cell.total.toLocaleString()} tokens`
                        }
                      />
                    );
                  })}
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className="panel">
          <div className="panel-head">
            <h2>生涯时段</h2>
            <span className="panel-hint">全部历史 · 0–23 点分布</span>
          </div>
          <div className="hour-bars">
            {lifeCharts.hourProfile.map((h) => {
              const ratio =
                lifeCharts.hourMax > 0 ? h.tokens / lifeCharts.hourMax : 0;
              return (
                <div
                  key={h.hour}
                  className={`hour-col${
                    lifetime.busiestHour?.hour === h.hour ? " peak" : ""
                  }`}
                  title={`${String(h.hour).padStart(2, "0")}:00 · ${formatTokens(
                    h.tokens
                  )}`}
                >
                  <div
                    className="hour-fill life"
                    style={{
                      height: h.tokens > 0 ? `${Math.max(3, ratio * 100)}%` : 0,
                    }}
                  />
                </div>
              );
            })}
          </div>
          <div className="hour-axis" aria-hidden>
            <span>0</span>
            <span>6</span>
            <span>12</span>
            <span>18</span>
            <span>23</span>
          </div>
          {lifeCharts.spark.length > 2 && (
            <div className="life-spark-wrap">
              <div className="mini-head">每日用量 sparkline</div>
              <Sparkline values={lifeCharts.spark} color="#a78bfa" height={52} />
            </div>
          )}
        </section>

        {lifeCharts.cumSeries.length > 1 && (
          <section className="panel">
            <div className="panel-head">
              <h2>生涯累计</h2>
              <span className="panel-hint">
                从首次有用量到现在 · 合计{" "}
                {formatTokens(lifeCharts.cumMax)}
              </span>
            </div>
            <AreaChart
              points={lifeCharts.cumSeries.map((d) => ({
                label: d.label,
                value: d.value,
              }))}
              max={lifeCharts.cumMax}
              color="#9385d9"
              fill="rgba(147, 133, 217, 0.16)"
            />
          </section>
        )}
        </>
        )}

        {view === "overview" && (
          <>
        {window.tokenStats?.pricing && (
          <UnpricedBanner
            items={result?.unpricedModels}
            loadError={result?.pricingLoadError}
            onOpen={(models) => {
              setPricingFocus(models);
              setShowPricing(true);
            }}
          />
        )}
        <section className="hero">
          <div className="hero-main">
            <div className="hero-label">
              Total Tokens · {rangeLabel}
            </div>
            <div className="hero-value" title={totals.totalTokens.toLocaleString()}>
              {formatTokens(totals.totalTokens)}
            </div>
            <div className="hero-sub">
              {totals.sessions} 个会话
              {(totals.requestCount || 0) > 0
                ? ` · ${totals.requestCount!.toLocaleString()} 次请求`
                : ""}
              {" · 估算成本 "}
              {hideCost ? "•••" : formatCost(totals.cost, currency)}
              <button
                className="currency-toggle"
                onClick={toggleCurrency}
                title={
                  currency === "CNY"
                    ? `1 USD = ${fx.rate.toFixed(4)} CNY${
                        fx.live ? (fx.date ? `（${fx.date}）` : "（缓存）") : "（离线兜底）"
                      } · 点击切换 USD`
                    : "点击切换 CNY"
                }
              >
                {currency === "CNY" ? "¥ CNY" : "$ USD"}
              </button>
              <button
                className="currency-toggle"
                onClick={toggleHideCost}
                title="截图分享时隐藏金额"
              >
                {hideCost ? "显示成本" : "隐藏成本"}
              </button>
              <span className="hero-note">
                （按本地价目估算
                {currency === "CNY" &&
                  ` · 官方人民币价直算优先 · 汇率 ${fx.rate.toFixed(4)}${fx.live ? "" : " · 离线兜底"}`}
                ）
              </span>
            </div>
            <div className="hero-deltas">
              今日 {formatTokens(deltas.today)}
              {pctChange(deltas.today, deltas.yesterday) && (
                <span className="delta">
                  较昨日 {pctChange(deltas.today, deltas.yesterday)}
                </span>
              )}
              <span className="delta-sep" />
              本周 {formatTokens(deltas.week)}
              {pctChange(deltas.week, deltas.prevWeek) && (
                <span className="delta">
                  较上周 {pctChange(deltas.week, deltas.prevWeek)}
                </span>
              )}
            </div>
          </div>
          <div className="hero-metrics">
            <Metric
              label="Input"
              value={formatTokens(
                uncachedInputOf({
                  inputTokens: totals.inputTokens,
                  outputTokens: totals.outputTokens,
                  reasoningTokens: totals.reasoningTokens,
                  totalTokens: totals.totalTokens,
                  estCacheReadTokens: totals.estCacheReadTokens,
                })
              )}
              raw={totals.inputTokens}
            />
            <Metric label="Output" value={formatTokens(totals.outputTokens)} raw={totals.outputTokens} />
            {(() => {
              const displayedInput = uncachedInputOf({
                inputTokens: totals.inputTokens,
                outputTokens: totals.outputTokens,
                reasoningTokens: totals.reasoningTokens,
                totalTokens: totals.totalTokens,
                estCacheReadTokens: totals.estCacheReadTokens,
              });
              const estCacheAmt =
                (totals.estCacheReadTokens || 0) > 0
                  ? totals.estCacheReadTokens || 0
                  : filteredAgg.reduce(
                      (a, s) => a + (s.noCacheData ? s.estCacheReadTokens || 0 : 0),
                      0
                    );
              const officialCache = totals.cacheReadTokens || 0;
              let hitInput = 0;
              let hitCache = 0;
              for (const s of filteredAgg) {
                if (!s.noCacheData) {
                  hitInput += s.inputTokens || 0;
                  hitCache += s.cacheReadTokens || 0;
                }
              }
              const hit = cacheHitRate(hitInput, hitCache);
              const overall = overallHitRate(
                displayedInput,
                officialCache,
                estCacheAmt
              );
              const cacheParts = cacheReadSplit(officialCache, estCacheAmt);
              const hitParts = hitRateSplit(hit, overall);
              return (
                <>
                  <Metric
                    label="Cache Read"
                    value={
                      <SplitMetricValue
                        primary={cacheParts.primary}
                        extra={cacheParts.extra}
                      />
                    }
                    raw={officialCache}
                    title={
                      officialCache > 0 && estCacheAmt > 0
                        ? `${EST_CACHE_MIXED_TITLE}\n官方 ${formatTokens(
                            officialCache
                          )} · 估算 ${formatTokens(estCacheAmt)}`
                        : officialCache > 0
                          ? undefined
                          : EST_CACHE_TITLE
                    }
                  />
                  <Metric
                    label="Cache Write"
                    value={formatTokens(totals.cacheWriteTokens)}
                    raw={totals.cacheWriteTokens}
                  />
                  <Metric
                    label="Reasoning"
                    value={formatTokens(totals.reasoningTokens)}
                    raw={totals.reasoningTokens}
                  />
                  <Metric
                    label="缓存命中"
                    value={
                      <SplitMetricValue
                        primary={hitParts.primary}
                        extra={hitParts.extra}
                      />
                    }
                    raw={
                      hit != null
                        ? Math.round(hit * 1000) / 10
                        : overall != null
                          ? Math.round(overall * 1000) / 10
                          : 0
                    }
                    tone={hitRateTone(hit)}
                    title={
                      hit != null && overall != null
                        ? `${EST_HIT_MIXED_TITLE}\n官方 ${formatTokens(
                            hitCache
                          )} / ${formatTokens(hitInput + hitCache)}\n计入估算 ${formatTokens(
                            officialCache + estCacheAmt
                          )} / ${formatTokens(displayedInput + officialCache + estCacheAmt)}`
                        : hit != null
                          ? `Cache Read ÷ (Input + Cache Read)\n${formatTokens(
                              hitCache
                            )} / ${formatTokens(hitInput + hitCache)}`
                          : overall != null
                            ? EST_HIT_TITLE
                            : "当前区间无 Prompt / Cache 数据（freebuff 等无缓存记录的客户端不计入）"
                    }
                  />
                </>
              );
            })()}
            <Metric
              label="请求"
              value={
                (totals.requestCount || 0) > 0
                  ? totals.requestCount!.toLocaleString()
                  : "–"
              }
              raw={totals.requestCount || 0}
              title="模型 API 请求次数（按 turn/推理事件累计；有小时桶时为本区间）"
            />
            <Metric
              label="速度"
              value={formatTokPerSec(
                tokensPerSec(totals.genTokens, totals.genMs),
                tokensPerSec(totals.estGenTokens, totals.estGenMs)
              )}
              raw={tokensPerSec(totals.genTokens, totals.genMs) || 0}
              title={
                tokensPerSec(totals.genTokens, totals.genMs) != null
                  ? SPEED_TITLE
                  : EST_SPEED_TITLE
              }
            />
          </div>
        </section>

        <section className="panel">
          <div className="panel-head">
            <h2>本区间亮点</h2>
            <span className="panel-hint">
              {rangeLabel}
              {fallbackCount > 0
                ? ` · ${fallbackCount} 条全量未计入本区汇总`
                : ""}
            </span>
          </div>
          <div className="range-insight-grid">
            <div className="range-insight-card">
              <div className="insight-kicker">峰值日</div>
              <div className="insight-main">
                {rangeInsights.peakDay?.day ?? "–"}
              </div>
              <div className="insight-sub">
                {rangeInsights.peakDay
                  ? formatTokens(rangeInsights.peakDay.tokens)
                  : "暂无"}
              </div>
            </div>
            <div className="range-insight-card">
              <div className="insight-kicker">活跃日</div>
              <div className="insight-main">{rangeInsights.activeDays}</div>
              <div className="insight-sub">
                日均 {formatTokens(rangeInsights.avgDay)}
              </div>
            </div>
            <div className="range-insight-card">
              <div className="insight-kicker">黄金时段</div>
              <div className="insight-main">
                {rangeInsights.busiestHour
                  ? formatHourRange(rangeInsights.busiestHour.hour)
                  : "–"}
              </div>
              <div className="insight-sub">
                {rangeInsights.busiestHour
                  ? formatTokens(rangeInsights.busiestHour.tokens)
                  : "暂无"}
              </div>
            </div>
            <div className="range-insight-card">
              <div className="insight-kicker">会话均量</div>
              <div className="insight-main">
                {formatTokens(rangeInsights.avgSession)}
              </div>
              <div className="insight-sub">
                {rangeInsights.sessions} 个有用量会话
                {rangeInsights.vsPrev ? (
                  <span className="insight-pct"> · 环比 {rangeInsights.vsPrev}</span>
                ) : null}
              </div>
            </div>
          </div>
          {rangeInsights.composition.length > 0 && (
            <div className="range-comp">
              <div className="mini-head">Token 构成</div>
              <div className="dist-bar">
                {rangeInsights.composition.map((c) => (
                  <div
                    key={c.key}
                    className="seg"
                    style={{
                      width: `${(c.tokens / rangeInsights.compTotal) * 100}%`,
                      background: c.color,
                    }}
                    title={`${c.key} · ${c.tokens.toLocaleString()}`}
                  />
                ))}
              </div>
              <div className="chip-row">
                {rangeInsights.composition.map((c) => (
                  <span key={c.key} className="chip model-chip static-chip">
                    <span className="dot" style={{ background: c.color }} />
                    {c.key}
                    <span className="count">
                      {formatTokens(c.tokens)} ·{" "}
                      {Math.round((c.tokens / rangeInsights.compTotal) * 100)}%
                    </span>
                  </span>
                ))}
              </div>
            </div>
          )}
          {rangeInsights.topProjects.length > 0 && (
            <div className="range-projects">
              <div className="mini-head">
                本区间项目 Top 5
                <span className="panel-hint" style={{ marginLeft: 8 }}>
                  按 turn 发生时间 · {rangeLabel}
                </span>
              </div>
              <ul className="top-day-list">
                {rangeInsights.topProjects.map((p, i) => (
                  <li key={p.cwd}>
                    <button
                      type="button"
                      className="top-day-row"
                      onClick={() =>
                        drillToSessions({
                          kind: "project",
                          cwd: p.cwd,
                          label: p.label,
                        })
                      }
                      title={p.cwd}
                    >
                      <span className="top-day-rank">{i + 1}</span>
                      <span className="top-day-date top-proj-name" style={{ maxWidth: 120 }}>
                        {p.label}
                      </span>
                      <span className="top-day-bar-track">
                        <span
                          className="top-day-bar"
                          style={{
                            width: `${(p.tokens / rangeInsights.topProjMax) * 100}%`,
                          }}
                        />
                      </span>
                      <span className="top-day-tok">{formatTokens(p.tokens)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {(rangeInsights.sparkValues.length > 1 ||
            rangeInsights.weekdayTok + rangeInsights.weekendTok > 0) && (
            <div className="range-kpi-sparks">
              <div className="spark-card">
                <div className="spark-head">
                  <span>Token 走势</span>
                  <span className="spark-meta">
                    {rangeInsights.grain === "hour" ? "按小时 · " : "按日 · "}
                    {rangeInsights.sparkValues.length} 点
                  </span>
                </div>
                <Sparkline values={rangeInsights.sparkValues} color="#34d399" />
              </div>
              <div className="spark-card">
                <div className="spark-head">
                  <span>会话数走势</span>
                  <span className="spark-meta">
                    {rangeInsights.grain === "hour" ? "按小时 · " : ""}
                    峰值 {Math.max(0, ...rangeInsights.sparkSessions)}
                  </span>
                </div>
                <Sparkline values={rangeInsights.sparkSessions} color="#5ea3c7" />
              </div>
              {rangeInsights.grain === "day" && (
                <div className="spark-card">
                  <div className="spark-head">
                    <span>工作日 vs 周末</span>
                    <span className="spark-meta">
                      {(() => {
                        const t =
                          rangeInsights.weekdayTok + rangeInsights.weekendTok;
                        if (t <= 0) return "–";
                        return `工作日 ${Math.round(
                          (rangeInsights.weekdayTok / t) * 100
                        )}%`;
                      })()}
                    </span>
                  </div>
                  <div className="ww-bar">
                    {(() => {
                      const t =
                        rangeInsights.weekdayTok + rangeInsights.weekendTok || 1;
                      const w = (rangeInsights.weekdayTok / t) * 100;
                      return (
                        <>
                          <div
                            className="ww-seg week"
                            style={{ width: `${w}%` }}
                            title={`工作日 ${formatTokens(rangeInsights.weekdayTok)}`}
                          />
                          <div
                            className="ww-seg end"
                            style={{ width: `${100 - w}%` }}
                            title={`周末 ${formatTokens(rangeInsights.weekendTok)}`}
                          />
                        </>
                      );
                    })()}
                  </div>
                  <div className="ww-legend">
                    <span>
                      <i className="swatch" style={{ background: "#5b8def" }} />
                      工作日 {formatTokens(rangeInsights.weekdayTok)}
                    </span>
                    <span>
                      <i className="swatch" style={{ background: "#e8a54b" }} />
                      周末 {formatTokens(rangeInsights.weekendTok)}
                    </span>
                  </div>
                </div>
              )}
            </div>
          )}
        </section>

        <section className="panel">
          <div className="panel-head">
            <h2>时段分布</h2>
            <span className="panel-hint">
              0–23 点 · 像 WakaTime / RescueTime 的活跃钟点
              {rangeInsights.busiestHour
                ? ` · 最忙 ${formatHourRange(rangeInsights.busiestHour.hour)}`
                : ""}
            </span>
          </div>
          <div className="hour-bars">
            {rangeInsights.hourProfile.map((h) => {
              const ratio =
                rangeInsights.hourMax > 0
                  ? h.tokens / rangeInsights.hourMax
                  : 0;
              return (
                <div
                  key={h.hour}
                  className={`hour-col${
                    rangeInsights.busiestHour?.hour === h.hour ? " peak" : ""
                  }`}
                  title={`${String(h.hour).padStart(2, "0")}:00 · ${formatTokens(
                    h.tokens
                  )}`}
                >
                  <div
                    className="hour-fill"
                    style={{
                      height: h.tokens > 0 ? `${Math.max(3, ratio * 100)}%` : 0,
                    }}
                  />
                </div>
              );
            })}
          </div>
          <div className="hour-axis" aria-hidden>
            <span>0</span>
            <span>6</span>
            <span>12</span>
            <span>18</span>
            <span>23</span>
          </div>
        </section>

        {rangeInsights.dailySeries.length > 1 && (
          <section className="panel">
            <div className="panel-head">
              <h2>累计用量</h2>
              <span className="panel-hint">
                {rangeInsights.grain === "hour" ? "今日按小时累计" : "区间内累计"}{" "}
                · 终点{" "}
                {formatTokens(
                  rangeInsights.dailySeries[rangeInsights.dailySeries.length - 1]
                    ?.cum || 0
                )}
              </span>
            </div>
            <AreaChart
              points={rangeInsights.dailySeries.map((d) => ({
                label: d.label,
                value: d.cum,
              }))}
              max={rangeInsights.cumMax}
              color="#34d399"
              fill="rgba(52, 211, 153, 0.18)"
            />
          </section>
        )}

        {rangeInsights.dailySeries.some((d) => d.input > 0 || d.output > 0) && (
          <section className="panel">
            <div className="panel-head">
              <h2>Input / Output 对比</h2>
              <span className="panel-hint">
                {rangeInsights.grain === "hour" ? "按小时" : "按日"} · 输入绿 /
                输出蓝
              </span>
            </div>
            <div className="io-chart">
              <div className="io-legend">
                <span>
                  <i className="swatch" style={{ background: "#35b586" }} />
                  Input
                </span>
                <span>
                  <i className="swatch" style={{ background: "#5ea3c7" }} />
                  Output
                </span>
              </div>
              <div
                className={`io-cols ${
                  rangeInsights.dailySeries.length > 40 ? "scroll" : "fill"
                }`}
              >
                {rangeInsights.dailySeries.map((d) => (
                  <div
                    key={d.day}
                    className="io-col"
                    title={`${d.label}\nIn ${formatTokens(d.input)}\nOut ${formatTokens(
                      d.output
                    )}`}
                  >
                    <div className="io-pair">
                      <div
                        className="io-bar in"
                        style={{
                          height: `${(d.input / rangeInsights.dayIoMax) * 100}%`,
                        }}
                      />
                      <div
                        className="io-bar out"
                        style={{
                          height: `${(d.output / rangeInsights.dayIoMax) * 100}%`,
                        }}
                      />
                    </div>
                  </div>
                ))}
              </div>
              {/* 柱上不标数字：小时用底轴，日级靠 hover 看明细 */}
              {rangeInsights.grain === "hour" ? (
                <div className="hour-axis" aria-hidden>
                  <span>0</span>
                  <span>6</span>
                  <span>12</span>
                  <span>18</span>
                  <span>23</span>
                </div>
              ) : rangeInsights.dailySeries.length > 1 ? (
                <div className="io-axis" aria-hidden>
                  <span>{rangeInsights.dailySeries[0]?.label}</span>
                  <span>
                    {
                      rangeInsights.dailySeries[
                        rangeInsights.dailySeries.length - 1
                      ]?.label
                    }
                  </span>
                </div>
              ) : null}
            </div>
          </section>
        )}

        {rangeInsights.dailySeries.length > 1 &&
          !hideCost &&
          rangeInsights.dailySeries.some((d) => d.cost > 0) && (
          <section className="panel">
            <div className="panel-head">
              <h2>成本走势</h2>
              <span className="panel-hint">
                {rangeInsights.grain === "hour" ? "按小时" : "按日"}估算 ·{" "}
                {currency === "CNY" ? "¥" : "$"}
              </span>
            </div>
            <AreaChart
              points={rangeInsights.dailySeries.map((d) => ({
                label: d.label,
                value: d.cost,
              }))}
              max={rangeInsights.costMax}
              color="#e8a54b"
              fill="rgba(232, 165, 75, 0.16)"
              formatY={(v) => formatCost(v, currency)}
            />
          </section>
        )}

        {rangeInsights.dailySeries.length > 1 &&
          rangeInsights.dailySeries.some((d) => d.sessions > 0) && (
          <section className="panel">
            <div className="panel-head">
              <h2>会话密度</h2>
              <span className="panel-hint">
                {rangeInsights.grain === "hour"
                  ? "每小时有用量会话数"
                  : "每日有用量会话数"}
              </span>
            </div>
            <div
              className={`sess-bars ${
                rangeInsights.dailySeries.length > 40 ? "scroll" : "fill"
              }`}
            >
              {rangeInsights.dailySeries.map((d) => (
                <div
                  key={d.day}
                  className="sess-col"
                  title={`${d.label} · ${d.sessions} 会话 · ${formatTokens(d.tokens)}`}
                >
                  <div className="sess-track">
                    <div
                      className="sess-fill"
                      style={{
                        height: `${(d.sessions / rangeInsights.daySessMax) * 100}%`,
                      }}
                    />
                  </div>
                </div>
              ))}
            </div>
          </section>
        )}

        <section className="panel">
          <div className="panel-head">
            <h2>用量趋势</h2>
            <span className="panel-hint">
              {trend.hourly
                ? "按小时"
                : range === "all" && trend.firstDay && trend.lastDay
                  ? `${trend.firstDay.slice(5)} → ${trend.lastDay.slice(5)} · ${trend.days.length} 天`
                  : `按天 · ${trend.days.length} 天`}
              {trend.fromTurns ? " · 按 turn 时间" : " · 按会话时间"}
            </span>
            <button
              type="button"
              className={`btn ghost trend-stack-btn ${trendStack === "model" ? "on" : ""}`}
              onClick={toggleTrendStack}
              title="点击切换堆叠维度：按工具 / 按模型"
            >
              {trendStack === "client" ? "按工具堆叠" : "按模型堆叠"}
            </button>
          </div>
          {trend.stackKeys.length > 0 && (
            <div className="trend-legend">
              {trend.stackKeys.map((k) => (
                <span key={k} className="trend-legend-item" title={trend.labelOf(k)}>
                  <i
                    className={
                      trend.stackMode === "client" ? `swatch client-${k}` : "swatch"
                    }
                    style={
                      trend.stackMode === "model"
                        ? { background: trend.colorOf(k) }
                        : undefined
                    }
                  />
                  {trend.labelOf(k)}
                </span>
              ))}
            </div>
          )}
          <div className="trend">
            <div
              className={`trend-cols ${
                trend.days.length <= 31
                  ? "fill"
                  : trend.days.length > 90
                    ? "scroll dense dense-xl"
                    : trend.days.length > 40
                      ? "scroll dense"
                      : "scroll"
              }`}
            >
              <div className="trend-y">
                <span>{formatTokens(trend.max)}</span>
                <span>{formatTokens(trend.max / 2)}</span>
                <span>0</span>
              </div>
              <div className="trend-grid" />
              {(() => {
                const axisLabels = buildTrendAxisLabels(trend.days, trend.hourly);
                return trend.days.map((d, i) => {
                  const axis = axisLabels.get(i);
                  const active = trend.stackKeys.filter((k) => (d.byStack.get(k) || 0) > 0);
                  const topKey = active[active.length - 1];
                  return (
                    <div
                      key={d.key}
                      className={`trend-col${axis ? " has-label" : ""}`}
                      title={`${d.key} · ${d.total.toLocaleString()} tokens${
                        d.byStack.size
                          ? " · " +
                            [...d.byStack.entries()]
                              .sort((a, b) => b[1] - a[1])
                              .map(([c, v]) => `${trend.labelOf(c)} ${formatTokens(v)}`)
                              .join(", ")
                          : ""
                      }`}
                    >
                      <div className="trend-bar">
                        {trend.stackKeys.map((k) => {
                          const v = d.byStack.get(k) || 0;
                          if (v === 0) return null;
                          const isTop = k === topKey;
                          if (trend.stackMode === "client") {
                            return (
                              <div
                                key={k}
                                className={`seg client-${k} ${isTop ? "seg-top" : ""}`}
                                style={{ height: `${(v / trend.max) * 100}%` }}
                              />
                            );
                          }
                          return (
                            <div
                              key={k}
                              className={`seg ${isTop ? "seg-top" : ""}`}
                              style={{
                                height: `${(v / trend.max) * 100}%`,
                                background: trend.colorOf(k),
                              }}
                            />
                          );
                        })}
                      </div>
                      <div className="trend-day">
                        {axis && (
                          <span className={axis.edge ? `edge-${axis.edge}` : undefined}>
                            {axis.text}
                          </span>
                        )}
                      </div>
                    </div>
                  );
                });
              })()}
            </div>
          </div>
        </section>

        <section className="panel">
          <div className="panel-head">
            <h2>按工具分布</h2>
            <span className="panel-hint">点击可筛选</span>
          </div>
          <div className="dist-bar">
            {CLIENT_ORDER.map((c) => {
              const tokens = clientStats.get(c)?.tokens || 0;
              if (tokens === 0 || rangeTotal === 0) return null;
              return (
                <div
                  key={c}
                  className={`seg client-${c}`}
                  style={{ width: `${(tokens / rangeTotal) * 100}%` }}
                  title={`${c} · ${tokens.toLocaleString()} tokens`}
                />
              );
            })}
            {rangeTotal === 0 && <div className="dist-empty">暂无数据</div>}
          </div>
          <div className="chip-row">
            {CLIENT_ORDER.map((id) => {
              const stat = clientStats.get(id);
              const detected = result?.reports.find((r) => r.id === id)?.detected;
              const pct =
                stat && rangeTotal > 0 ? Math.round((stat.tokens / rangeTotal) * 100) : 0;
              return (
                <button
                  key={id}
                  className={`chip ${activeClients.has(id) ? "active" : ""}`}
                  onClick={(e) => toggleClient(id, e)}
                  title={
                    detected === false
                      ? "本机未检测到"
                      : "点击：只看此工具 · Ctrl+点击：多选开关"
                  }
                >
                  <span className={`dot client-${id}`} />
                  {CLIENT_LABELS[id]}
                  <span className="count">
                    {stat ? `${formatTokens(stat.tokens)} · ${pct}%` : "–"}
                  </span>
                </button>
              );
            })}
          </div>
        </section>

        <section className="panel">
          <div className="panel-head">
            <h2>按模型分布</h2>
            <span className="panel-hint">Top 8 · 点击图例筛选</span>
          </div>
          <div className="dist-bar">
            {modelDist.map(
              (m) =>
                m.tokens > 0 &&
                rangeTotal > 0 && (
                  <div
                    key={m.key}
                    className="seg"
                    style={{
                      width: `${(m.tokens / rangeTotal) * 100}%`,
                      background: m.color,
                    }}
                    title={`${m.key} · ${m.tokens.toLocaleString()} tokens`}
                  />
                )
            )}
            {rangeTotal === 0 && <div className="dist-empty">暂无数据</div>}
          </div>
          <div className="chip-row">
            {modelDist.map((m) => {
              const pct = rangeTotal > 0 ? Math.round((m.tokens / rangeTotal) * 100) : 0;
              const unk = isUnknownModel(m.key);
              const clickable = m.key !== "其他" && !unk;
              return (
                <button
                  key={m.key}
                  className={`chip model-chip${unk ? " model-unknown" : ""}`}
                  onClick={() => clickable && setQuery(m.key)}
                  title={clickable ? `搜索「${m.key}」` : undefined}
                >
                  <span className="dot" style={{ background: m.color }} />
                  <span className="model-chip-name">{m.key}</span>
                  <span className="count">
                    {formatTokens(m.tokens)} · {pct}%
                  </span>
                </button>
              );
            })}
          </div>
        </section>
          </>
        )}

        {view === "tools" && (
          <AggTable
            title="按工具"
            firstCol="工具"
            kind="client"
            rows={toolRows}
            currency={currency}
            rate={fx.rate}
            hideCost={hideCost}
            loading={loading}
            listSessions={sessionsForAggKey}
            onOpenSession={setDetailSession}
            onDrill={(key, label) =>
              drillToSessions({ kind: "client", id: key })
            }
          />
        )}

        {view === "projects" && (
          <AggTable
            title="按项目"
            firstCol="项目（工作目录）"
            kind="project"
            rows={projectRows}
            currency={currency}
            rate={fx.rate}
            hideCost={hideCost}
            loading={loading}
            listSessions={sessionsForAggKey}
            onOpenSession={setDetailSession}
            onDrill={(key, label) =>
              drillToSessions({ kind: "project", cwd: key, label })
            }
          />
        )}

        {view === "models" && (
          <AggTable
            title="按模型"
            firstCol="模型"
            kind="model"
            rows={modelRows}
            currency={currency}
            rate={fx.rate}
            hideCost={hideCost}
            loading={loading}
            listSessions={sessionsForAggKey}
            onOpenSession={setDetailSession}
            onDrill={(key) => drillToSessions({ kind: "model", model: key })}
          />
        )}

        {view === "daily" && (
          <AggTable
            title="按天（当日真实发生，非会话生涯）"
            firstCol="日期"
            kind="day"
            rows={dailyRows}
            currency={currency}
            rate={fx.rate}
            hideCost={hideCost}
            loading={loading}
            listSessions={sessionsForAggKey}
            onOpenSession={setDetailSession}
            onDrill={(key) => {
              if (key === "无日期") return;
              drillToSessions({ kind: "day", day: key });
            }}
          />
        )}

        {view === "sessions" && (
        <section className="panel table-panel">
          <div className="panel-head">
            <h2>会话明细</h2>
            <span className="panel-hint">
              {filtered.length} 条
              {emptyHiddenCount > 0 ? ` · 已隐藏 ${emptyHiddenCount} 条空会话` : ""}
              {activeClients.size === 1
                ? ` · 仅 ${CLIENT_LABELS[[...activeClients][0] as (typeof CLIENT_ORDER)[number]] || [...activeClients][0]}`
                : ""}
            </span>
          </div>
          <div className="table-wrap">
            {sortedSessions.length === 0 ? (
              <div className="empty">
                {loading
                  ? "正在读取本机会话日志…"
                  : "没有匹配的会话。试试切换时间范围、工具筛选或刷新扫描。"}
              </div>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th>工具</th>
                    <th>会话</th>
                    <th>模型</th>
                    <SortTh label="最近活动" k="time" sort={sort} onSort={clickSort} align="left" />
                    <SortTh
                      label="请求"
                      k="requests"
                      sort={sort}
                      onSort={clickSort}
                    />
                    <SortTh
                      label="Turn"
                      k="turns"
                      sort={sort}
                      onSort={clickSort}
                    />
                    <SortTh
                      label="Msgs"
                      k="msgs"
                      sort={sort}
                      onSort={clickSort}
                    />
                    <SortTh label="Input" k="input" sort={sort} onSort={clickSort} />
                    <SortTh label="Output" k="output" sort={sort} onSort={clickSort} />
                    <SortTh
                      label="速度"
                      k="speed"
                      sort={sort}
                      onSort={clickSort}
                    />
                    <th className="num" title="缓存命中 / 写入（与 Input 不重叠）">
                      Cache R/W
                    </th>
                    <SortTh
                      label="命中"
                      k="hit"
                      sort={sort}
                      onSort={clickSort}
                    />
                    <th className="num" title="推理 token（与 Output 不重叠）">
                      Reason
                    </th>
                    <SortTh label="Total" k="total" sort={sort} onSort={clickSort} />
                    <SortTh
                      label={`成本 ${currency === "CNY" ? "¥" : "$"}`}
                      k="cost"
                      sort={sort}
                      onSort={clickSort}
                    />
                    <th>质量</th>
                  </tr>
                </thead>
                <tbody>
                  {sortedSessions.map((s) => (
                    <SessionRow
                      key={s.id}
                      session={s}
                      currency={currency}
                      rate={fx.rate}
                      hideCost={hideCost}
                      onOpen={() => setDetailSession(s)}
                    />
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </section>
        )}
      </main>
    </div>
  );
}

/** 迷你折线（KPI 旁 / 走势卡）——线要细，拉伸后仍保持屏幕像素粗细 */
function Sparkline({
  values,
  color = "#34d399",
  height = 40,
}: {
  values: number[];
  color?: string;
  height?: number;
}) {
  const w = 240;
  const h = height;
  if (!values.length) {
    return <div className="sparkline empty" style={{ height: h }} />;
  }
  const max = Math.max(1, ...values);
  const min = Math.min(0, ...values);
  const span = Math.max(1e-9, max - min);
  const pts = values.map((v, i) => {
    const x = values.length === 1 ? w / 2 : (i / (values.length - 1)) * w;
    const y = h - 3 - ((v - min) / span) * (h - 6);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const area = `0,${h} ${pts.join(" ")} ${w},${h}`;
  return (
    <svg
      className="sparkline"
      viewBox={`0 0 ${w} ${h}`}
      preserveAspectRatio="none"
      width="100%"
      height={h}
    >
      <polygon points={area} fill={color} opacity={0.1} />
      <polyline
        points={pts.join(" ")}
        fill="none"
        stroke={color}
        strokeWidth="1.15"
        strokeLinejoin="round"
        strokeLinecap="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

/** 累计 / 成本面积图 */
function AreaChart({
  points,
  max,
  color,
  fill,
  formatY,
}: {
  points: { label: string; value: number }[];
  max: number;
  color: string;
  fill: string;
  formatY?: (v: number) => string;
}) {
  const w = 640;
  const h = 140;
  const padL = 8;
  const padR = 8;
  const padT = 10;
  const padB = 22;
  const innerW = w - padL - padR;
  const innerH = h - padT - padB;
  if (!points.length) {
    return <div className="area-empty">暂无数据</div>;
  }
  const m = Math.max(1, max);
  const coords = points.map((p, i) => {
    const x =
      padL +
      (points.length === 1 ? innerW / 2 : (i / (points.length - 1)) * innerW);
    const y = padT + innerH - (p.value / m) * innerH;
    return { x, y, ...p };
  });
  const line = coords.map((c) => `${c.x.toFixed(1)},${c.y.toFixed(1)}`).join(" ");
  const area = `${padL},${padT + innerH} ${line} ${padL + innerW},${padT + innerH}`;
  const labelIdx = new Set<number>();
  if (points.length <= 8) {
    points.forEach((_, i) => labelIdx.add(i));
  } else {
    labelIdx.add(0);
    labelIdx.add(points.length - 1);
    const step = Math.ceil(points.length / 6);
    for (let i = step; i < points.length - 1; i += step) labelIdx.add(i);
  }
  const yTop = formatY ? formatY(m) : formatTokens(m);
  const yMid = formatY ? formatY(m / 2) : formatTokens(m / 2);

  return (
    <div className="area-chart">
      <div className="area-y">
        <span>{yTop}</span>
        <span>{yMid}</span>
        <span>0</span>
      </div>
      <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" className="area-svg">
        <line
          x1={padL}
          y1={padT + innerH / 2}
          x2={padL + innerW}
          y2={padT + innerH / 2}
          stroke="currentColor"
          strokeOpacity={0.08}
        />
        <polygon points={area} fill={fill} />
        <polyline
          points={line}
          fill="none"
          stroke={color}
          strokeWidth="2.2"
          strokeLinejoin="round"
          strokeLinecap="round"
        />
        {coords.length <= 60 &&
          coords.map((c, i) =>
            c.value > 0 ? (
              <circle
                key={i}
                cx={c.x}
                cy={c.y}
                r={points.length > 40 ? 1.2 : 2}
                fill={color}
              />
            ) : null
          )}
      </svg>
      <div className="area-x">
        {points.map((p, i) =>
          labelIdx.has(i) ? (
            <span
              key={i}
              style={{
                left: `${(i / Math.max(1, points.length - 1)) * 100}%`,
              }}
            >
              {p.label}
            </span>
          ) : null
        )}
      </div>
    </div>
  );
}

function Metric({
  label,
  value,
  raw,
  tone,
  title,
}: {
  label: string;
  value: ReactNode;
  raw: number;
  tone?: "none" | "low" | "mid" | "high";
  title?: string;
}) {
  return (
    <div className={`metric${tone && tone !== "none" ? ` hit-tone-${tone}` : ""}`}>
      <div className="label">{label}</div>
      <div
        className={`value${tone && tone !== "none" ? ` hit-rate hit-${tone}` : ""}`}
        title={title ?? raw.toLocaleString()}
      >
        {value}
      </div>
    </div>
  );
}

interface AggRow {
  key: string;
  label?: string;
  sessions: number;
  requestCount: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  cost: number;
  hasCost: boolean;
  /** 其中有多少条是「无法按区间拆分、用了全量」 */
  fallbackSessions: number;
  /** 命中率专用输入（排除 freebuff 等无 cache 记录的客户端） */
  hitInputTokens: number;
  /** 命中率专用 cacheRead（排除 freebuff 等无 cache 记录的客户端） */
  hitCacheReadTokens: number;
  /** 仅展示：无官方 cache 会话的 input */
  estHitInputTokens: number;
  /** 仅展示：前缀重叠估算 cache */
  estCacheReadTokens: number;
  genMs: number;
  genTokens: number;
  estGenMs: number;
  estGenTokens: number;
}

function blankAgg(key: string): AggRow {
  return {
    key,
    sessions: 0,
    requestCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
    cost: 0,
    hasCost: false,
    fallbackSessions: 0,
    hitInputTokens: 0,
    hitCacheReadTokens: 0,
    estHitInputTokens: 0,
    estCacheReadTokens: 0,
    genMs: 0,
    genTokens: 0,
    estGenMs: 0,
    estGenTokens: 0,
  };
}

function addHitFields(
  r: AggRow,
  s: {
    noCacheData?: boolean;
    inputTokens?: number;
    outputTokens?: number;
    reasoningTokens?: number;
    totalTokens?: number;
    cacheReadTokens?: number;
    estCacheReadTokens?: number;
  }
) {
  if (!s.noCacheData) {
    r.hitInputTokens += s.inputTokens || 0;
    r.hitCacheReadTokens += s.cacheReadTokens || 0;
    return;
  }
  const est = s.estCacheReadTokens || 0;
  if (est > 0) {
    r.estHitInputTokens += uncachedInputOf(s);
    r.estCacheReadTokens += est;
  }
}

function addToAgg(
  r: AggRow,
  s: SessionRecord & { usageSource?: UsageSource },
  currency: Currency,
  rate: number
) {
  r.sessions += 1;
  r.requestCount += s.requestCount || 0;
  r.inputTokens += uncachedInputOf(s);
  r.outputTokens += s.outputTokens;
  r.cacheReadTokens += s.cacheReadTokens;
  r.cacheWriteTokens += s.cacheWriteTokens;
  r.reasoningTokens += s.reasoningTokens;
  r.totalTokens += s.totalTokens;
  r.genMs += s.genMs || 0;
  r.genTokens += s.genTokens || 0;
  r.estGenMs += s.estGenMs || 0;
  r.estGenTokens += s.estGenTokens || 0;
  addHitFields(r, s);
  const c = displayCost(s, currency, rate);
  if (c != null) {
    r.cost += c;
    r.hasCost = true;
  }
  if (s.usageSource === "lifetime-fallback") r.fallbackSessions += 1;
}

function AggTable({
  title,
  firstCol,
  kind,
  rows,
  currency,
  rate,
  hideCost,
  loading,
  listSessions,
  onOpenSession,
  onDrill,
}: {
  title: string;
  firstCol: string;
  kind: DrillFilter["kind"];
  rows: AggRow[];
  currency: Currency;
  rate: number;
  hideCost: boolean;
  loading: boolean;
  listSessions: (kind: DrillFilter["kind"], key: string) => SessionRecord[];
  onOpenSession: (s: SessionRecord) => void;
  onDrill: (key: string, label?: string) => void;
}) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const max = Math.max(1, ...rows.map((r) => r.totalTokens));
  const TOP_N = 8;

  function toggleExpand(key: string) {
    setExpanded((prev) => (prev === key ? null : key));
  }

  return (
    <section className="panel table-panel">
      <div className="panel-head">
        <h2>{title}</h2>
        <span className="panel-hint">
          {rows.length} 条 · 点击行展开 Top 会话 · 「全部」进会话列表
          {rows.some((r) => r.fallbackSessions > 0)
            ? " · 含「全量·未拆分」兜底"
            : ""}
        </span>
      </div>
      <div className="table-wrap">
        {rows.length === 0 ? (
          <div className="empty">{loading ? "正在读取本机会话日志…" : "没有数据。"}</div>
        ) : (
          <table className="agg-table">
            <thead>
              <tr>
                <th style={{ width: 28 }} />
                <th>{firstCol}</th>
                <th className="num">会话</th>
                <th className="num" title="模型 API 请求次数">
                  请求
                </th>
                <th className="num">Input</th>
                <th className="num">Output</th>
                <th className="num" title={SPEED_TITLE}>
                  速度
                </th>
                <th className="num">Cache R/W</th>
                <th
                  className="num"
                  title="缓存命中率 = Cache Read ÷ (Input + Cache Read)"
                >
                  命中
                </th>
                <th className="num">Reason</th>
                <th className="num">Total</th>
                <th className="num">成本 {currency === "CNY" ? "¥" : "$"}</th>
                <th>占比</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const open = expanded === r.key;
                const group = open ? listSessions(kind, r.key) : [];
                const top = group.slice(0, TOP_N);
                const totalInGroup = open ? group.length : r.sessions;
                const hit = cacheHitRate(
                  r.hitInputTokens,
                  r.hitCacheReadTokens
                );
                const overall = overallHitRate(
                  r.inputTokens,
                  r.cacheReadTokens,
                  r.estCacheReadTokens
                );
                const hitTone = hitRateTone(hit);
                return (
                  <Fragment key={r.key}>
                    <tr
                      className={`agg-row ${open ? "open" : ""}`}
                      onClick={() => toggleExpand(r.key)}
                      title="点击展开 / 收起该分类下的会话"
                    >
                      <td className="agg-chevron">{open ? "▾" : "▸"}</td>
                      <td className="title-cell">
                        <div
                          className={`title-main${
                            kind === "model" && isUnknownModel(r.key)
                              ? " model-unknown"
                              : ""
                          }`}
                          title={r.key}
                        >
                          {r.label ?? r.key}
                          {r.fallbackSessions > 0 ? (
                            <span
                              className="usage-badge fallback"
                              title="该分类下部分/全部会话无法按时间窗拆分，数字含会话全量"
                            >
                              {r.fallbackSessions >= r.sessions
                                ? "全量·未拆分"
                                : `${r.fallbackSessions} 条全量`}
                            </span>
                          ) : null}
                        </div>
                        {r.label && r.label !== r.key && kind === "project" && (
                          <div className="title-sub" title={r.key}>
                            {r.key}
                          </div>
                        )}
                      </td>
                      <td className="num">{r.sessions}</td>
                      <td
                        className="num"
                        title={
                          r.requestCount > 0
                            ? r.requestCount.toLocaleString()
                            : undefined
                        }
                      >
                        {r.requestCount > 0 ? r.requestCount.toLocaleString() : "–"}
                      </td>
                      <td
                        className="num"
                        title={
                          r.estCacheReadTokens > 0 &&
                          uncachedInputOf(r) !== r.inputTokens
                            ? "未命中的新 tokens（官方 context 快照减去前缀重叠估算）"
                            : undefined
                        }
                      >
                        {formatTokens(uncachedInputOf(r))}
                      </td>
                      <td className="num">{formatTokens(r.outputTokens)}</td>
                      <td
                        className="num"
                        title={
                          r.genMs > 0
                            ? `${formatTokens(r.genTokens)} / ${(r.genMs / 1000).toFixed(1)}s`
                            : r.estGenMs > 0
                              ? EST_SPEED_TITLE
                              : SPEED_TITLE
                        }
                      >
                        {formatTokPerSec(
                          tokensPerSec(r.genTokens, r.genMs),
                          tokensPerSec(r.estGenTokens, r.estGenMs)
                        )}
                      </td>
                      <td
                        className="num"
                        title={
                          r.cacheReadTokens > 0 && r.estCacheReadTokens > 0
                            ? EST_CACHE_MIXED_TITLE
                            : r.cacheReadTokens <= 0 && r.estCacheReadTokens > 0
                              ? EST_CACHE_TITLE
                              : undefined
                        }
                      >
                        {formatCacheRead(r.cacheReadTokens, r.estCacheReadTokens)}
                        <span className="dim"> / {formatTokens(r.cacheWriteTokens)}</span>
                      </td>
                      <td
                        className={`num hit-rate hit-${hitTone}`}
                        title={
                          hit != null && overall != null
                            ? EST_HIT_MIXED_TITLE
                            : hit != null
                              ? `${formatTokens(r.hitCacheReadTokens)} / ${formatTokens(
                                  r.hitInputTokens + r.hitCacheReadTokens
                                )}`
                              : overall != null
                                ? EST_HIT_TITLE
                                : undefined
                        }
                      >
                        {formatHitRate(hit, overall)}
                      </td>
                      <td className="num">{formatTokens(r.reasoningTokens)}</td>
                      <td className="num strong" title={r.totalTokens.toLocaleString()}>
                        {formatTokens(r.totalTokens)}
                      </td>
                      <td className="num">
                        {hideCost ? "•••" : r.hasCost ? formatCost(r.cost, currency) : "–"}
                      </td>
                      <td className="share-cell">
                        <div className="share-bar">
                          <div style={{ width: `${(r.totalTokens / max) * 100}%` }} />
                        </div>
                      </td>
                    </tr>
                    {open && (
                      <tr className="agg-expand-row">
                        <td colSpan={11}>
                          <div className="agg-expand">
                            {top.length === 0 ? (
                              <div className="muted pad-sm">该分类下没有会话</div>
                            ) : (
                              <ul className="agg-session-list">
                                {top.map((s) => {
                                  const cost = displayCost(s, currency, rate);
                                  const sc = s as SessionRecord & {
                                    lifetimeTotalTokens?: number;
                                  };
                                  const life = sc.lifetimeTotalTokens;
                                  const showLife = isMeaningfulLifetimeGap(
                                    s.totalTokens || 0,
                                    life
                                  );
                                  const lifeHint = showLife
                                    ? ` · 生涯 ${formatTokens(life!)}`
                                    : "";
                                  return (
                                    <li key={s.id}>
                                      <button
                                        type="button"
                                        className="agg-session-item"
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          onOpenSession(s);
                                        }}
                                        title={
                                          showLife
                                            ? `本区 ${s.totalTokens?.toLocaleString()} · 生涯 ${life!.toLocaleString()}`
                                            : undefined
                                        }
                                      >
                                        <span
                                          className={`client-tag client-${s.client}`}
                                        >
                                          {CLIENT_LABELS[
                                            s.client as (typeof CLIENT_ORDER)[number]
                                          ] || s.client}
                                        </span>
                                        <span className="agg-s-title">
                                          {s.title || s.sessionId}
                                        </span>
                                        <span className="agg-s-meta">
                                          {formatTokens(s.totalTokens || 0)}
                                          {lifeHint}
                                          {!hideCost && cost != null
                                            ? ` · ${formatCost(cost, currency)}`
                                            : ""}
                                          {" · "}
                                          {formatRelative(sessionDate(s))}
                                        </span>
                                      </button>
                                    </li>
                                  );
                                })}
                              </ul>
                            )}
                            <div className="agg-expand-actions">
                              <span className="muted">
                                {totalInGroup > TOP_N
                                  ? `显示 Top ${TOP_N} / 共 ${totalInGroup} 条`
                                  : `共 ${totalInGroup} 条`}
                              </span>
                              <button
                                type="button"
                                className="btn ghost"
                                disabled={r.key === "无日期"}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  onDrill(r.key, r.label);
                                }}
                              >
                                在会话列表查看全部 →
                              </button>
                            </div>
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </section>
  );
}

function SortTh({
  label,
  k,
  sort,
  onSort,
  align = "num",
}: {
  label: string;
  k: SortKey;
  sort: { key: SortKey; dir: 1 | -1 };
  onSort: (k: SortKey) => void;
  align?: "num" | "left";
}) {
  const active = sort.key === k;
  return (
    <th className={`sortable ${align === "num" ? "num" : ""}`} onClick={() => onSort(k)}>
      {label}
      <span className={`sort-arrow ${active ? "on" : ""}`}>
        {active ? (sort.dir === -1 ? "↓" : "↑") : "↕"}
      </span>
    </th>
  );
}

function SessionRow({
  session: s,
  currency,
  rate,
  hideCost,
  onOpen,
}: {
  session: SessionRecord & {
    usageSource?: UsageSource;
    lifetimeTotalTokens?: number;
  };
  currency: Currency;
  rate: number;
  hideCost: boolean;
  onOpen: () => void;
}) {
  return (
    <tr className="session-row-click" onClick={onOpen} title="点击查看 turn 明细">
      <td>
        <span className={`client-tag client-${s.client}`}>
          {CLIENT_LABELS[s.client as (typeof CLIENT_ORDER)[number]] || s.client}
        </span>
      </td>
      <td className="title-cell">
        <div className="title-main" title={s.title || s.sessionId}>
          {s.title || shortId(s.sessionId)}
          {s.usageSource === "lifetime-fallback" ? (
            <span
              className="usage-badge fallback"
              title="无 turn 级时间明细，数字为会话生涯全量（非时间窗切片）"
            >
              {usageSourceLabel("lifetime-fallback")}
            </span>
          ) : s.usageSource === "range" &&
            isMeaningfulLifetimeGap(s.totalTokens || 0, s.lifetimeTotalTokens) ? (
            <span
              className="usage-badge range"
              title={`本区间用量；会话生涯合计 ${s.lifetimeTotalTokens!.toLocaleString()} tokens`}
            >
              区间
            </span>
          ) : null}
          {s.childCount ? (
            <span className="child-badge" title={`已归并 ${s.childCount} 个子会话`}>
              +{s.childCount}
            </span>
          ) : null}
          {s.deleted ? (
            <span
              className="child-badge deleted"
              title={
                s.synthetic
                  ? "源端从未扫到父日志，本地补的已删除父壳（子用量已并入）"
                  : s.deletedAt
                    ? `源日志已不存在 · 本地保留自 ${s.deletedAt}`
                    : "源日志已不存在 · 用量来自本地持久化"
              }
            >
              已删除
            </span>
          ) : null}
          {s.dedupExcluded ? (
            <span
              className="child-badge dedup"
              title={
                s.dedupKeptBy
                  ? `跨工具去重：与 ${s.dedupKeptBy.split(":")[0]} 的相同 sessionId 会话重复，未计入总额`
                  : "跨工具去重：sessionId 与其他工具重复，未计入总额"
              }
            >
              未计入
            </span>
          ) : null}
          {s.isSubagent ? (
            <span
              className="child-badge sub"
              title={
                s.parentSessionId
                  ? `未归并子 agent · 父会话 ${s.parentSessionId} 不可用`
                  : "未归并子 agent（父会话不可用）"
              }
            >
              未归并
            </span>
          ) : null}
          {s.client === "opencode" && s.sessionKind === "v1" ? (
            <span
              className="child-badge oc-v1"
              title="仅存在于 OpenCode V1 的 session 表"
            >
              V1
            </span>
          ) : null}
          {s.client === "opencode" && s.sessionKind === "v2" ? (
            <span
              className="child-badge oc-v2"
              title="仅存在于 OpenCode V2 的 session_v2 表（opencode2）"
            >
              V2
            </span>
          ) : null}
          {s.client === "opencode" && s.sessionKind === "migrated" ? (
            <span
              className="child-badge oc-migrated"
              title="V1/V2 同 sessionId 均有记录（迁移拷贝）· 用量只计一次，取更大/更新的一侧"
            >
              迁移
            </span>
          ) : null}
        </div>
        <div className="title-sub" title={s.cwd || s.sessionId}>
          {s.agentName ? `${s.agentName} · ` : ""}
          {s.cwd || shortId(s.sessionId)}
        </div>
      </td>
      <td
        className={`model-cell${
          isUnknownModel(s.model) || !s.model ? " model-unknown" : ""
        }`}
        title={
          s.model
            ? s.modelVariant
              ? `${prettyModel(s.model) || s.model} · ${s.modelVariant}`
              : prettyModel(s.model) || s.model
            : undefined
        }
      >
        {s.model ? (
          <ModelNameWithVariant
            model={s.model}
            variant={s.modelVariant}
          />
        ) : (
          "–"
        )}
      </td>
      <td title={formatFull(sessionDate(s))}>{formatRelative(sessionDate(s))}</td>
      <td
        className="num"
        title={
          s.requestCount != null && s.requestCount > 0
            ? `${s.requestCount.toLocaleString()} 次模型请求`
            : "无请求次数明细"
        }
      >
        {s.requestCount != null && s.requestCount > 0
          ? s.requestCount.toLocaleString()
          : "–"}
      </td>
      <td
        className="num"
        title={
          s.turnCount != null && s.turnCount > 0
            ? `${s.turnCount.toLocaleString()} 轮 turn`
            : "无 turn 明细"
        }
      >
        {s.turnCount != null && s.turnCount > 0
          ? s.turnCount.toLocaleString()
          : "–"}
      </td>
      <td
        className="num"
        title={
          s.messageCount != null && s.messageCount > 0
            ? `${s.messageCount.toLocaleString()} 条消息`
            : "无消息数明细"
        }
      >
        {s.messageCount != null && s.messageCount > 0
          ? s.messageCount.toLocaleString()
          : "–"}
      </td>
      <td
        className="num"
        title={
          s.noCacheData && (s.estCacheReadTokens || 0) > 0
            ? "未命中的新 tokens（官方 context 快照减去前缀重叠估算）"
            : undefined
        }
      >
        {formatTokens(uncachedInputOf(s))}
      </td>
      <td className="num">{formatTokens(s.outputTokens)}</td>
      <td
        className="num"
        title={
          s.genMs
            ? `${formatTokens(s.genTokens || 0)} / ${(s.genMs / 1000).toFixed(1)}s · ${SPEED_TITLE}`
            : s.estGenMs
              ? EST_SPEED_TITLE
              : SPEED_TITLE
        }
      >
        {formatTokPerSec(
          tokensPerSec(s.genTokens, s.genMs),
          tokensPerSec(s.estGenTokens, s.estGenMs)
        )}
      </td>
      <td
        className="num"
        title={
          (s.cacheReadTokens || 0) > 0 && (s.estCacheReadTokens || 0) > 0
            ? EST_CACHE_MIXED_TITLE
            : s.noCacheData && (s.estCacheReadTokens || 0) > 0
              ? EST_CACHE_TITLE
              : undefined
        }
      >
        {formatCacheRead(s.cacheReadTokens, s.estCacheReadTokens)}
        <span className="dim"> / {formatTokens(s.cacheWriteTokens)}</span>
      </td>
      {(() => {
        const hit = cacheHitRate(s.inputTokens, s.cacheReadTokens, s.noCacheData);
        const overall = overallHitRate(
          uncachedInputOf(s),
          s.cacheReadTokens,
          s.estCacheReadTokens
        );
        const tone = hitRateTone(hit);
        return (
          <td
            className={`num hit-rate hit-${tone}`}
            title={
              hit != null && overall != null
                ? EST_HIT_MIXED_TITLE
                : hit != null
                  ? `Cache Read ÷ (Input + Cache Read)\n${formatTokens(
                      s.cacheReadTokens
                    )} / ${formatTokens(s.inputTokens + s.cacheReadTokens)}`
                  : overall != null
                    ? EST_HIT_TITLE
                    : "无 Prompt/Cache 数据"
            }
          >
            {formatHitRate(hit, overall)}
          </td>
        );
      })()}
      <td className="num">{formatTokens(s.reasoningTokens)}</td>
      <td
        className="num strong"
        title={
          s.usageSource === "range" &&
          isMeaningfulLifetimeGap(s.totalTokens || 0, s.lifetimeTotalTokens)
            ? `本区间 ${s.totalTokens.toLocaleString()} · 会话生涯 ${s.lifetimeTotalTokens!.toLocaleString()}`
            : undefined
        }
      >
        {formatTokens(s.totalTokens)}
        {s.usageSource === "range" &&
        isMeaningfulLifetimeGap(s.totalTokens || 0, s.lifetimeTotalTokens) ? (
          <div className="title-sub lifetime-sub">
            生涯 {formatTokens(s.lifetimeTotalTokens!)}
          </div>
        ) : null}
      </td>
      <td
        className="num"
        title={
          s.longContextRequests
            ? `${s.longContextRequests} 次请求按长上下文档计费（prompt ≥ 档界，如 Grok 200k）`
            : undefined
        }
      >
        {hideCost ? "•••" : formatCost(displayCost(s, currency, rate), currency)}
        {!hideCost && s.longContextRequests ? (
          <div className="title-sub lifetime-sub">
            长上下文 {s.longContextRequests}
          </div>
        ) : null}
      </td>
      <td>
        <span className={`quality ${s.quality}`}>{qualityLabel(s.quality)}</span>
      </td>
    </tr>
  );
}
