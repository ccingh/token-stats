import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { getUsdCny, type FxRate } from "./fx";
import {
  computeLifetimeInsights,
  formatHourRange,
  weekdayNameMonFirst,
} from "./insights";
import {
  fetchSnapshot,
  getSession,
  isConfigured,
  resetClient,
  signIn,
  signOut,
  signUp,
} from "./supabase";
import { loadSettings } from "./storage";
import type {
  HourlyBucket,
  SessionRecord,
  SnapshotRow,
  UsageSource,
} from "./types";
import {
  formatTokPerSec,
  modelAggKey,
  sanitizeSnapshotPayload,
  tokensPerSec,
} from "./types";
import SearchBox from "./SearchBox";
import { matchesSession } from "./searchMatch";
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

const UNKNOWN_MODEL = "未知模型";
const UNKNOWN_MODEL_COLOR = "#a8a8b3";

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

/** home = 隐藏生涯首页；不在底栏，仅启动 / 点 logo 进入 */
type Tab = "home" | "overview" | "analyze" | "sessions" | "settings";
type Theme = "system" | "light" | "dark";
type RangeId = "today" | "week" | "month" | "all";
type AnalyzeView = "tools" | "projects" | "models" | "daily";
type SortKey = "time" | "total" | "cost" | "hit" | "requests" | "turns" | "msgs";
type Currency = "USD" | "CNY";

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
      return (modelAggKey(s.model) || s.model || UNKNOWN_MODEL) === drill.model;
    case "project":
      return (s.cwd || "未知目录") === drill.cwd;
    case "day": {
      const iso = sessionDate(s);
      if (!iso) return false;
      return dayKey(iso) === drill.day;
    }
  }
}

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
const CLIENT_COLORS: Record<string, string> = {
  opencode: "#35b586",
  claude: "#d98e5f",
  codex: "#2e8cff",
  grok: "#9385d9",
  kimi: "#5ea3c7",
  zcode: "#c97698",
  pi: "#4aa79b",
  reasonix: "#e8a54b",
  mimocode: "#ff6a3d",
  dsh: "#4d6bfe",
  freebuff: "#34d399",
};
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

const WEEKDAY_COLORS = [
  "#5b8def",
  "#35b586",
  "#e8a54b",
  "#9385d9",
  "#c97698",
  "#5ea3c7",
  "#d98e5f",
];
const RANGES = [
  { id: "today" as const, label: "今天", days: 1 },
  { id: "week" as const, label: "7 天", days: 7 },
  { id: "month" as const, label: "30 天", days: 30 },
  { id: "all" as const, label: "全部", days: 0 },
];
const ANALYZE_VIEWS = [
  { id: "tools" as const, label: "按工具" },
  { id: "projects" as const, label: "按项目" },
  { id: "models" as const, label: "按模型" },
  { id: "daily" as const, label: "按天" },
];

function formatTokens(n: number): string {
  if (!Number.isFinite(n)) return "–";
  if (Math.abs(n) >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (Math.abs(n) >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (Math.abs(n) >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(Math.round(n));
}

/** 缓存命中率 = Cache Read / (Input + Cache Read) */
function cacheHitRate(
  inputTokens?: number,
  cacheReadTokens?: number,
  noCacheData?: boolean
): number | null {
  // freebuff 等本地无 cache 记录的客户端不参与命中率，避免 input 拉低整体
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

function formatCacheRead(official?: number | null, est?: number | null): string {
  const read = Math.max(0, Number(official) || 0);
  const estimated = Math.max(0, Number(est) || 0);
  if (read > 0 && estimated > 0) {
    return `${formatTokens(read)}（${formatTokens(estimated)}）`;
  }
  if (read > 0) return formatTokens(read);
  return formatEstTokens(estimated) || formatTokens(0);
}

/**
 * 命中率色阶（对齐 opencode-visual-cache）：
 * ≥85% 绿 · ≥70% 橙 · <70% 红
 */
function hitRateTone(
  rate: number | null | undefined
): "none" | "low" | "mid" | "high" {
  if (rate == null || !Number.isFinite(rate)) return "none";
  if (rate >= 0.85) return "high";
  if (rate >= 0.7) return "mid";
  return "low";
}

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

function formatCost(amount: number | undefined, currency: Currency): string {
  if (amount === undefined || !Number.isFinite(amount)) return "–";
  const sym = currency === "CNY" ? "¥" : "$";
  if (amount >= 1000) return `${sym}${Math.round(amount).toLocaleString()}`;
  if (amount >= 1) return `${sym}${amount.toFixed(2)}`;
  return `${sym}${amount.toFixed(3)}`;
}

function formatRelative(iso?: string | null): string {
  if (!iso) return "–";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return iso;
  const min = Math.floor((Date.now() - t) / 60_000);
  if (min < 1) return "刚刚";
  if (min < 60) return `${min} 分钟前`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} 小时前`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d} 天前`;
  return new Date(iso).toLocaleDateString();
}

function formatFull(iso?: string | null): string {
  if (!iso) return "–";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

function localDayKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** 丢弃秒当毫秒产生的 1970 脏桶等 */
function isPlausibleDayKey(day: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return false;
  const y = Number(day.slice(0, 4));
  return y >= 2015 && y <= new Date().getFullYear() + 1;
}

function dayKey(iso: string): string {
  return localDayKey(new Date(iso));
}

function sessionDate(s: SessionRecord): string | undefined {
  return s.lastUsedAt || s.startedAt;
}

/** 区间与生涯差得很小时不展示副数字 */
function isMeaningfulLifetimeGap(
  rangeTok: number,
  lifeTok: number | undefined | null
): boolean {
  if (lifeTok == null || !(lifeTok > 0)) return false;
  const gap = lifeTok - rangeTok;
  if (gap <= 0) return false;
  if (gap < 50_000 && gap / lifeTok < 0.01) return false;
  return true;
}

function hourlyBucketCost(
  row: HourlyBucket,
  currency: Currency,
  rate: number
): number {
  return displayCost(row, currency, rate) || 0;
}

function trimEmptyEnds<T extends { total: number }>(arr: T[]): T[] {
  if (!arr.length) return arr;
  let lo = 0;
  let hi = arr.length - 1;
  while (lo <= hi && (arr[lo].total || 0) <= 0) lo += 1;
  while (hi >= lo && (arr[hi].total || 0) <= 0) hi -= 1;
  if (lo > hi) return arr.slice(0, 1);
  return arr.slice(lo, hi + 1);
}

/** 长跨度趋势 X 轴：月界 + 首尾，避免窄柱裁字 */
function buildTrendAxisLabels(
  days: { key: string }[],
  hourly: boolean
): Map<number, { text: string; edge?: "start" | "end" }> {
  const n = days.length;
  const labels = new Map<number, { text: string; edge?: "start" | "end" }>();
  if (n === 0) return labels;

  if (hourly) {
    const step = n <= 12 ? 1 : Math.ceil(n / 8);
    for (let i = 0; i < n; i++) {
      if (i === 0 || i === n - 1 || i % step === 0) {
        labels.set(i, {
          text: days[i].key.replace(/:00$/, ""),
          edge: i === 0 ? "start" : i === n - 1 ? "end" : undefined,
        });
      }
    }
    return labels;
  }

  if (n <= 14) {
    for (let i = 0; i < n; i++) {
      labels.set(i, {
        text: days[i].key.slice(5),
        edge: i === 0 ? "start" : i === n - 1 ? "end" : undefined,
      });
    }
    return labels;
  }

  if (n <= 50) {
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

  labels.set(0, { text: days[0].key.slice(5), edge: "start" });
  for (let i = 1; i < n; i++) {
    if (days[i - 1].key.slice(0, 7) !== days[i].key.slice(0, 7)) {
      labels.set(i, { text: `${Number(days[i].key.slice(5, 7))}月` });
    }
  }
  labels.set(n - 1, { text: days[n - 1].key.slice(5), edge: "end" });
  return labels;
}

function isEmptySession(s: SessionRecord): boolean {
  if (s.quality === "no_model") return true;
  return (s.totalTokens || 0) <= 0 && (s.inputTokens || 0) <= 0 && (s.outputTokens || 0) <= 0;
}

function isOrphanChild(s: SessionRecord): boolean {
  return !!s.isSubagent && !s.deleted;
}

function isDeletedSession(s: SessionRecord): boolean {
  return !!s.deleted;
}

function qualityLabel(q?: string): string {
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
      return q || "–";
  }
}

function pctChange(cur: number, prev: number): string | null {
  if (prev === 0) return null;
  const d = ((cur - prev) / prev) * 100;
  if (!Number.isFinite(d)) return null;
  return `${d >= 0 ? "+" : ""}${Math.round(d)}%`;
}

function clientLabel(id: string): string {
  return CLIENT_LABELS[id as (typeof CLIENT_ORDER)[number]] || id;
}

type AggRow = {
  key: string;
  label?: string;
  sessions: number;
  requestCount: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  totalTokens: number;
  cost: number;
  hasCost: boolean;
  fallbackSessions: number;
  /** 命中率专用输入（排除 freebuff 等无 cache 记录的客户端） */
  hitInputTokens: number;
  /** 命中率专用 cacheRead（排除 freebuff 等无 cache 记录的客户端） */
  hitCacheReadTokens: number;
  estHitInputTokens: number;
  estCacheReadTokens: number;
  genMs: number;
  genTokens: number;
  estGenMs: number;
  estGenTokens: number;
};

function blankAgg(key: string): AggRow {
  return {
    key,
    sessions: 0,
    requestCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
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
  r.outputTokens += s.outputTokens || 0;
  r.cacheReadTokens += s.cacheReadTokens || 0;
  r.totalTokens += s.totalTokens || 0;
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

export default function App() {
  const [booting, setBooting] = useState(true);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [userEmail, setUserEmail] = useState<string | null>(null);
  const [loggedIn, setLoggedIn] = useState(false);

  const [url, setUrl] = useState(() => loadSettings().supabaseUrl);
  const [anonKey, setAnonKey] = useState(() => loadSettings().supabaseAnonKey);

  const [snapshot, setSnapshot] = useState<SnapshotRow | null>(null);
  const [tab, setTab] = useState<Tab>("home");
  const mainRef = useRef<HTMLElement | null>(null);
  /** 切 tab 回顶部；点当前 tab 平滑回顶部（iOS 习惯） */
  const pressTab = (id: Tab) => {
    if (id === tab) {
      mainRef.current?.scrollTo({ top: 0, behavior: "smooth" });
    } else {
      setTab(id);
      mainRef.current?.scrollTo(0, 0);
    }
  };
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [theme, setTheme] = useState<Theme>(
    () => (localStorage.getItem("ts-mobile:theme") as Theme) || "system"
  );

  const [range, setRange] = useState<RangeId>(
    () => (localStorage.getItem("ts-mobile:range") as RangeId) || "week"
  );
  const [analyzeView, setAnalyzeView] = useState<AnalyzeView>(() => {
    const raw = localStorage.getItem("ts-mobile:analyze") as AnalyzeView | null;
    if (raw && ["tools", "projects", "models", "daily"].includes(raw)) return raw;
    return "tools";
  });
  const [activeClients, setActiveClients] = useState<Set<string>>(() => {
    try {
      const raw = localStorage.getItem("ts-mobile:clients");
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
    () => (localStorage.getItem("ts-mobile:currency") as Currency) || "CNY"
  );
  const [fx, setFx] = useState<FxRate>({ rate: 7.2, date: "", live: false });
  const [hideCost, setHideCost] = useState(
    () => localStorage.getItem("ts-mobile:hideCost") === "1"
  );
  const [hideEmpty, setHideEmpty] = useState(
    () => localStorage.getItem("ts-mobile:hideEmpty") !== "0"
  );
  const [hideOrphans, setHideOrphans] = useState(
    () => localStorage.getItem("ts-mobile:hideOrphans") !== "0"
  );
  const [hideDeleted, setHideDeleted] = useState(
    () => localStorage.getItem("ts-mobile:hideDeleted") === "1"
  );
  const [trendStack, setTrendStack] = useState<"client" | "model">(() =>
    localStorage.getItem("ts-mobile:trendStack") === "model" ? "model" : "client"
  );
  const [sortKey, setSortKey] = useState<SortKey>(
    () => (localStorage.getItem("ts-mobile:sort") as SortKey) || "time"
  );
  const [detail, setDetail] = useState<SessionRecord | null>(null);
  const [showFilters, setShowFilters] = useState(false);
  const [drill, setDrill] = useState<DrillFilter | null>(null);
  const [expandedAgg, setExpandedAgg] = useState<string | null>(null);

  useEffect(() => {
    localStorage.setItem("ts-mobile:theme", theme);
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      const dark = theme === "dark" || (theme === "system" && mq.matches);
      document.documentElement.dataset.theme = dark ? "dark" : "light";
    };
    apply();
    if (theme !== "system") return;
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, [theme]);

  useEffect(() => {
    let cancelled = false;
    void getUsdCny().then((r) => {
      if (!cancelled) setFx(r);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const row = await fetchSnapshot();
      if (row?.payload) {
        row.payload = sanitizeSnapshotPayload(row.payload) || row.payload;
      }
      setSnapshot(row);
      if (!row) setInfo("云端还没有快照，请先在桌面端上传");
      else setInfo(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        if (!isConfigured()) {
          if (!cancelled) setBooting(false);
          return;
        }
        const session = await getSession();
        if (cancelled) return;
        if (session?.user) {
          setLoggedIn(true);
          setUserEmail(session.user.email || null);
          await refresh();
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setBooting(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [refresh]);

  async function saveCfg() {
    setError(null);
    setInfo(null);
    resetClient({ supabaseUrl: url.trim(), supabaseAnonKey: anonKey.trim() });
    setLoggedIn(false);
    setUserEmail(null);
    setSnapshot(null);
    setInfo("配置已保存，请登录");
  }

  async function doLogin(mode: "login" | "signup") {
    setLoading(true);
    setError(null);
    setInfo(null);
    try {
      resetClient({ supabaseUrl: url.trim(), supabaseAnonKey: anonKey.trim() });
      const session =
        mode === "signup"
          ? await signUp(email.trim(), password)
          : await signIn(email.trim(), password);
      setLoggedIn(true);
      setUserEmail(session.user.email || email.trim());
      setPassword("");
      setTab("home");
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  async function doLogout() {
    setLoading(true);
    try {
      await signOut();
      setLoggedIn(false);
      setUserEmail(null);
      setSnapshot(null);
      setInfo("已退出");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  function switchRange(r: RangeId) {
    setRange(r);
    localStorage.setItem("ts-mobile:range", r);
  }

  function switchAnalyze(v: AnalyzeView) {
    setAnalyzeView(v);
    setExpandedAgg(null);
    localStorage.setItem("ts-mobile:analyze", v);
  }

  function toggleCurrency() {
    setCurrency((prev) => {
      const next = prev === "USD" ? "CNY" : "USD";
      localStorage.setItem("ts-mobile:currency", next);
      return next;
    });
  }

  function toggleHideCost() {
    setHideCost((prev) => {
      localStorage.setItem("ts-mobile:hideCost", prev ? "0" : "1");
      return !prev;
    });
  }

  function toggleHideEmpty() {
    setHideEmpty((prev) => {
      localStorage.setItem("ts-mobile:hideEmpty", prev ? "0" : "1");
      return !prev;
    });
  }

  function toggleHideOrphans() {
    setHideOrphans((prev) => {
      localStorage.setItem("ts-mobile:hideOrphans", prev ? "0" : "1");
      return !prev;
    });
  }

  function toggleHideDeleted() {
    setHideDeleted((prev) => {
      localStorage.setItem("ts-mobile:hideDeleted", prev ? "0" : "1");
      return !prev;
    });
  }

  function toggleTrendStack() {
    setTrendStack((prev) => {
      const next = prev === "client" ? "model" : "client";
      localStorage.setItem("ts-mobile:trendStack", next);
      return next;
    });
  }

  function setSort(k: SortKey) {
    setSortKey(k);
    localStorage.setItem("ts-mobile:sort", k);
  }

  function clearDrill() {
    setDrill(null);
  }

  function goHome() {
    setDrill(null);
    setExpandedAgg(null);
    setDetail(null);
    pressTab("home");
  }

  function applySearchDrill(next: DrillFilter) {
    setDrill(next);
    if (next.kind === "client") {
      const one = new Set([next.id]);
      setActiveClients(one);
      localStorage.setItem("ts-mobile:clients", JSON.stringify([...one]));
    }
    setQuery("");
    setExpandedAgg(null);
  }

  function drillToSessions(next: DrillFilter) {
    applySearchDrill(next);
    pressTab("sessions");
  }

  function toggleClient(id: string) {
    setActiveClients((prev) => {
      let next: Set<string>;
      if (prev.size === 1 && prev.has(id)) {
        next = new Set(CLIENT_ORDER);
      } else {
        next = new Set([id]);
      }
      // 若点到未在默认列表里的 client
      if (![...CLIENT_ORDER].includes(id as (typeof CLIENT_ORDER)[number]) && next.size === 1) {
        next = new Set([id]);
      }
      localStorage.setItem("ts-mobile:clients", JSON.stringify([...next]));
      return next;
    });
  }

  const sessionsAll = useMemo(() => snapshot?.payload?.sessions || [], [snapshot]);
  const hourlyAll: HourlyBucket[] = useMemo(
    () => snapshot?.payload?.hourly || [],
    [snapshot]
  );
  const hasHourly = hourlyAll.length > 0;

  const lifetime = useMemo(
    () => computeLifetimeInsights(sessionsAll, hourlyAll),
    [sessionsAll, hourlyAll]
  );
  const weekdayMax = useMemo(
    () => Math.max(1, ...lifetime.weekdayTotals),
    [lifetime.weekdayTotals]
  );
  const topDayMax = useMemo(
    () => Math.max(1, ...lifetime.topDays.map((d) => d.tokens), 1),
    [lifetime.topDays]
  );

  function setClientAll() {
    const next = new Set<string>(CLIENT_ORDER);
    for (const s of sessionsAll) if (s.client) next.add(s.client);
    setActiveClients(next);
    localStorage.setItem("ts-mobile:clients", JSON.stringify([...next]));
  }

  const rangeStart = useMemo(() => {
    const def = RANGES.find((r) => r.id === range)!;
    if (def.days === 0) return null;
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - (def.days - 1));
    return d.getTime();
  }, [range]);

  /** 自定义/全部无结束日；预设范围含今天，rangeEnd=null */
  const rangeEnd = null as number | null;

  const passHideAndClient = useCallback(
    (s: SessionRecord) => {
      if (!activeClients.has(s.client)) return false;
      if (hideEmpty && isEmptySession(s)) return false;
      if (hideOrphans && isOrphanChild(s)) return false;
      if (hideDeleted && isDeletedSession(s)) return false;
      return true;
    },
    [activeClients, hideEmpty, hideOrphans, hideDeleted]
  );

  const matchQuery = useCallback(
    (s: SessionRecord) => matchesSession(s, query, CLIENT_LABELS),
    [query]
  );

  const searchPool = useMemo(
    () => sessionsAll.filter(passHideAndClient),
    [sessionsAll, passHideAndClient]
  );

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
    if (!hourlyAll.length) return hourlyAll;
    if (!query.trim() && !drill) return hourlyAll;
    return hourlyAll.filter((row) => {
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
  }, [hourlyAll, scopedSessionKeys, query, drill]);

  /** 工具/隐藏/搜索，不限日期 — 区间归因用 meta */
  const allowedFiltered = useMemo(() => {
    return searchPool.filter(matchQuery);
  }, [searchPool, matchQuery]);

  /** lastUsedAt 落在时间窗 — 兜底列表 */
  const rangedFiltered = useMemo(() => {
    if (rangeStart === null) return allowedFiltered;
    return allowedFiltered.filter((s) => {
      const iso = sessionDate(s);
      if (!iso) return true;
      const t = new Date(iso).getTime();
      return Number.isNaN(t) || t >= rangeStart;
    });
  }, [allowedFiltered, rangeStart]);

  const canSplitByRange = useMemo(
    () => hasSessionHourly(hourlyAll),
    [hourlyAll]
  );

  const rangeSessionUsage = useMemo(() => {
    const todayKey = localDayKey(new Date());
    return buildRangeSessionUsage(
      hourlyAll,
      rangeStart,
      todayKey,
      activeClients,
      (row) => hourlyBucketCost(row, currency, fx.rate),
      rangeEnd
    );
  }, [hourlyAll, rangeStart, activeClients, currency, fx.rate]);

  /**
   * 会话列表 / 分类：默认区间用量（方案 A）。
   * 生涯合计仅作副信息。
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

  /** 本区间 KPI / 分析表：排除全量兜底，避免生涯灌进今天 */
  const aggSessions = useMemo(
    () => sessionsForRangeAgg(baseFiltered, "range", canSplitByRange),
    [baseFiltered, canSplitByRange]
  );

  const hourlyDims = useMemo(() => {
    if (!scopedHourly.length) return null;
    const todayKey = localDayKey(new Date());
    return buildHourlyDimTotals(
      scopedHourly,
      rangeStart,
      todayKey,
      activeClients,
      (row) => hourlyBucketCost(row, currency, fx.rate),
      rangeEnd
    );
  }, [scopedHourly, rangeStart, activeClients, currency, fx.rate]);

  const filtered = useMemo(
    () => baseFiltered.filter((s) => matchesDrill(s, drill)),
    [baseFiltered, drill]
  );

  /** 分析/列表排序用：带 drill 的区间会话（分析表用 agg 再 drill） */
  const filteredAgg = useMemo(
    () => aggSessions.filter((s) => matchesDrill(s, drill)),
    [aggSessions, drill]
  );

  const emptyHiddenCount = useMemo(() => {
    if (!hideEmpty) return 0;
    return rangedFiltered.filter(
      (s) =>
        activeClients.has(s.client) &&
        isEmptySession(s) &&
        !(hideOrphans && isOrphanChild(s)) &&
        !(hideDeleted && isDeletedSession(s))
    ).length;
  }, [rangedFiltered, activeClients, hideEmpty, hideOrphans, hideDeleted]);

  const orphanHiddenCount = useMemo(() => {
    if (!hideOrphans) return 0;
    return rangedFiltered.filter(
      (s) =>
        activeClients.has(s.client) &&
        isOrphanChild(s) &&
        !(hideEmpty && isEmptySession(s)) &&
        !(hideDeleted && isDeletedSession(s))
    ).length;
  }, [rangedFiltered, activeClients, hideEmpty, hideOrphans, hideDeleted]);

  const deletedHiddenCount = useMemo(() => {
    if (!hideDeleted) return 0;
    return rangedFiltered.filter(
      (s) =>
        activeClients.has(s.client) &&
        isDeletedSession(s) &&
        !(hideEmpty && isEmptySession(s)) &&
        !(hideOrphans && isOrphanChild(s))
    ).length;
  }, [rangedFiltered, activeClients, hideEmpty, hideOrphans, hideDeleted]);

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

  const sortedSessions = useMemo(() => {
    const arr = [...filtered];
    arr.sort((a, b) => {
      let va = 0;
      let vb = 0;
      if (sortKey === "time") {
        va = new Date(sessionDate(a) || "").getTime() || 0;
        vb = new Date(sessionDate(b) || "").getTime() || 0;
      } else if (sortKey === "cost") {
        va = displayCost(a, currency, fx.rate) ?? -1;
        vb = displayCost(b, currency, fx.rate) ?? -1;
      } else if (sortKey === "hit") {
        va =
          cacheHitRate(a.inputTokens, a.cacheReadTokens, a.noCacheData) ?? -1;
        vb =
          cacheHitRate(b.inputTokens, b.cacheReadTokens, b.noCacheData) ?? -1;
      } else if (sortKey === "requests") {
        va = a.requestCount ?? -1;
        vb = b.requestCount ?? -1;
      } else if (sortKey === "turns") {
        va = a.turnCount ?? -1;
        vb = b.turnCount ?? -1;
      } else if (sortKey === "msgs") {
        va = a.messageCount ?? -1;
        vb = b.messageCount ?? -1;
      } else {
        va = a.totalTokens || 0;
        vb = b.totalTokens || 0;
      }
      return vb - va;
    });
    return arr;
  }, [filtered, sortKey, currency, fx.rate]);

  const deltas = useMemo(() => {
    const dayStart = new Date();
    dayStart.setHours(0, 0, 0, 0);
    const t0 = dayStart.getTime();
    const DAY = 86_400_000;
    const todayKey = localDayKey(dayStart);
    const yesterdayKey = localDayKey(new Date(t0 - DAY));

    if (hasHourly) {
      const sumHours = (pred: (hour: string) => boolean) =>
        hourlyAll.reduce((acc, h) => (pred(h.hour) ? acc + (h.totalTokens || 0) : acc), 0);
      const weekStartKey = localDayKey(new Date(t0 - 6 * DAY));
      const prevWeekStartKey = localDayKey(new Date(t0 - 13 * DAY));
      const prevWeekEndKey = localDayKey(new Date(t0 - 6 * DAY));
      return {
        today: sumHours((h) => h.startsWith(todayKey)),
        yesterday: sumHours((h) => h.startsWith(yesterdayKey)),
        week: sumHours((h) => h.slice(0, 10) >= weekStartKey),
        prevWeek: sumHours(
          (h) => h.slice(0, 10) >= prevWeekStartKey && h.slice(0, 10) < prevWeekEndKey
        ),
      };
    }

    const sum = (from: number, to: number) =>
      sessionsAll.reduce((acc, s) => {
        const iso = sessionDate(s);
        if (!iso) return acc;
        const t = new Date(iso).getTime();
        return t >= from && t < to ? acc + (s.totalTokens || 0) : acc;
      }, 0);
    return {
      today: sum(t0, Infinity),
      yesterday: sum(t0 - DAY, t0),
      week: sum(t0 - 6 * DAY, Infinity),
      prevWeek: sum(t0 - 13 * DAY, t0 - 6 * DAY),
    };
  }, [hasHourly, hourlyAll, sessionsAll]);

  /** 概览：随时间范围变化的区间洞察 */
  const rangeInsights = useMemo(() => {
    const byDay = new Map<string, number>();
    const byHour = new Map<number, number>();
    const byProject = new Map<string, number>();
    const todayKey = localDayKey(new Date());

    if (hasHourly) {
      for (const row of scopedHourly) {
        if (!activeClients.has(row.client)) continue;
        const day = row.hour.slice(0, 10);
        if (!isPlausibleDayKey(day)) continue;
        if (range === "today") {
          if (!row.hour.startsWith(todayKey)) continue;
        } else if (rangeStart != null) {
          const t = new Date(`${day}T12:00:00`).getTime();
          if (Number.isNaN(t) || t < rangeStart) continue;
        }
        const tok = row.totalTokens || 0;
        if (tok <= 0) continue;
        byDay.set(day, (byDay.get(day) || 0) + tok);
        const hh = Number(row.hour.slice(11, 13));
        if (Number.isFinite(hh) && hh >= 0 && hh <= 23) {
          byHour.set(hh, (byHour.get(hh) || 0) + tok);
        }
      }
    } else {
      for (const s of baseFiltered) {
        const iso = sessionDate(s);
        if (!iso) continue;
        const tok = s.totalTokens || 0;
        if (tok <= 0) continue;
        const day = dayKey(iso);
        if (!isPlausibleDayKey(day)) continue;
        byDay.set(day, (byDay.get(day) || 0) + tok);
        const h = new Date(iso).getHours();
        byHour.set(h, (byHour.get(h) || 0) + tok);
      }
    }

    // 项目 Top：hourly→session→cwd，不灌生涯全量
    if (hasHourly) {
      const todayKey = localDayKey(new Date());
      const fromHourly = buildProjectTokensFromHourly(
        hourlyAll,
        sessionsAll,
        rangeStart,
        todayKey,
        activeClients,
        rangeEnd
      );
      for (const [cwd, t] of fromHourly) {
        if (t > 0) byProject.set(cwd, t);
      }
    } else {
      for (const s of aggSessions) {
        if (drill && !matchesDrill(s, drill)) continue;
        const cwd = s.cwd || "未知目录";
        byProject.set(cwd, (byProject.get(cwd) || 0) + (s.totalTokens || 0));
      }
    }

    let peakDay: { day: string; tokens: number } | null = null;
    for (const [day, tokens] of byDay) {
      if (!peakDay || tokens > peakDay.tokens) peakDay = { day, tokens };
    }
    let busiestHour: { hour: number; tokens: number } | null = null;
    for (const [hour, tokens] of byHour) {
      if (!busiestHour || tokens > busiestHour.tokens) {
        busiestHour = { hour, tokens };
      }
    }

    const activeDays = [...byDay.values()].filter((t) => t > 0).length;
    const tokens =
      [...byDay.values()].reduce((a, b) => a + b, 0) || totals.totalTokens;
    const sessions = filteredAgg.filter(
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
    if (rangeStart != null && range !== "today") {
      const win = Date.now() - rangeStart;
      const prevFrom = rangeStart - win;
      const prevTo = rangeStart;
      if (hasHourly) {
        for (const row of scopedHourly) {
          if (!activeClients.has(row.client)) continue;
          const day = row.hour.slice(0, 10);
          if (!isPlausibleDayKey(day)) continue;
          const t = new Date(`${day}T12:00:00`).getTime();
          if (t >= prevFrom && t < prevTo) prevTokens += row.totalTokens || 0;
        }
      } else {
        for (const s of sessionsAll) {
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
    // 构成条用 iOS 系统色（深浅主题都可读），避开工具色
    const composition = [
      { key: "Input", tokens: heroInput, color: "#0a84ff" },
      { key: "Output", tokens: totals.outputTokens, color: "#ff9f0a" },
      { key: "Cache R", tokens: totals.cacheReadTokens + estCacheBar, color: "#30d158" },
      { key: "Cache W", tokens: totals.cacheWriteTokens, color: "#64d2ff" },
      { key: "Reason", tokens: totals.reasoningTokens, color: "#bf5af2" },
    ].filter((c) => c.tokens > 0);

    const hourProfile = Array.from({ length: 24 }, (_, h) => ({
      hour: h,
      tokens: byHour.get(h) || 0,
    }));
    const hourMax = Math.max(1, ...hourProfile.map((h) => h.tokens));

    // 「今天」用 0–23 小时序列，避免日粒度只有 1 点
    const grain: "hour" | "day" = range === "today" ? "hour" : "day";
    type SeriesPt = {
      day: string;
      label: string;
      tokens: number;
      input: number;
      output: number;
      cum: number;
    };
    let dailySeries: SeriesPt[] = [];

    if (grain === "hour") {
      const buckets = Array.from({ length: 24 }, () => ({
        tokens: 0,
        input: 0,
        output: 0,
      }));
      if (hasHourly) {
        for (const row of scopedHourly) {
          if (!activeClients.has(row.client)) continue;
          if (!row.hour.startsWith(todayKey)) continue;
          const hh = Number(row.hour.slice(11, 13));
          if (!Number.isFinite(hh) || hh < 0 || hh > 23) continue;
          const tok = row.totalTokens || 0;
          if (tok <= 0) continue;
          buckets[hh].tokens += tok;
          buckets[hh].input += row.inputTokens || 0;
          buckets[hh].output += row.outputTokens || 0;
        }
      } else {
        for (const s of baseFiltered) {
          const iso = sessionDate(s);
          if (!iso) continue;
          if (dayKey(iso) !== todayKey) continue;
          const hh = new Date(iso).getHours();
          if (hh < 0 || hh > 23) continue;
          buckets[hh].tokens += s.totalTokens || 0;
          buckets[hh].input += s.inputTokens || 0;
          buckets[hh].output += s.outputTokens || 0;
        }
      }
      let cumH = 0;
      dailySeries = buckets.map((e, h) => {
        cumH += e.tokens;
        const label = `${String(h).padStart(2, "0")}:00`;
        return {
          day: label,
          label,
          tokens: e.tokens,
          input: e.input,
          output: e.output,
          cum: cumH,
        };
      });
    } else {
      let dayKeys: string[] = [];
      if (rangeStart != null) {
        const start = new Date(rangeStart);
        start.setHours(0, 0, 0, 0);
        const end = new Date();
        end.setHours(0, 0, 0, 0);
        for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
          dayKeys.push(localDayKey(d));
        }
      } else {
        dayKeys = [...byDay.keys()].sort();
      }
      // 日级 input/output：优先小时桶
      const dayIo = new Map<string, { input: number; output: number }>();
      if (hasHourly) {
        for (const row of scopedHourly) {
          if (!activeClients.has(row.client)) continue;
          const day = row.hour.slice(0, 10);
          if (!isPlausibleDayKey(day)) continue;
          if (rangeStart != null) {
            const t = new Date(`${day}T12:00:00`).getTime();
            if (Number.isNaN(t) || t < rangeStart) continue;
          }
          let e = dayIo.get(day);
          if (!e) {
            e = { input: 0, output: 0 };
            dayIo.set(day, e);
          }
          e.input += row.inputTokens || 0;
          e.output += row.outputTokens || 0;
        }
      }
      for (const s of hasHourly ? [] : aggSessions) {
        const iso = sessionDate(s);
        if (!iso) continue;
        const day = dayKey(iso);
        if (!isPlausibleDayKey(day)) continue;
        let e = dayIo.get(day);
        if (!e) {
          e = { input: 0, output: 0 };
          dayIo.set(day, e);
        }
        e.input += s.inputTokens || 0;
        e.output += s.outputTokens || 0;
      }
      let cum = 0;
      dailySeries = dayKeys.map((day) => {
        const t = byDay.get(day) || 0;
        cum += t;
        const io = dayIo.get(day) || { input: 0, output: 0 };
        return {
          day,
          label: day.slice(5),
          tokens: t,
          input: io.input,
          output: io.output,
          cum,
        };
      });
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
    }
    const cumMax = Math.max(1, ...dailySeries.map((d) => d.cum), 1);
    const sparkValues = dailySeries.map((d) => d.tokens);
    const dayIoMax = Math.max(
      1,
      ...dailySeries.map((d) => d.input),
      ...dailySeries.map((d) => d.output)
    );

    let weekdayTok = 0;
    let weekendTok = 0;
    if (grain === "hour") {
      const js = new Date().getDay();
      const t = dailySeries.reduce((a, d) => a + d.tokens, 0);
      if (js === 0 || js === 6) weekendTok = t;
      else weekdayTok = t;
    } else {
      for (const d of dailySeries) {
        const js = new Date(d.day + "T12:00:00").getDay();
        if (js === 0 || js === 6) weekendTok += d.tokens;
        else weekdayTok += d.tokens;
      }
    }

    return {
      peakDay,
      busiestHour,
      activeDays,
      sessions,
      avgDay,
      avgSession,
      topProjects,
      topProjMax,
      vsPrev,
      composition,
      compTotal: Math.max(1, compTotal),
      hourProfile,
      hourMax,
      grain,
      dailySeries,
      cumMax,
      sparkValues,
      dayIoMax,
      weekdayTok,
      weekendTok,
    };
  }, [
    hasHourly,
    scopedHourly,
    activeClients,
    range,
    rangeStart,
    rangeEnd,
    baseFiltered,
    aggSessions,
    filteredAgg,
    drill,
    totals,
    deltas.yesterday,
    sessionsAll,
    currency,
    fx.rate,
  ]);

  const lifeCharts = useMemo(() => {
    const byHour = new Map<number, number>();
    const byDay = new Map<string, number>();
    if (hasHourly) {
      for (const row of hourlyAll) {
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
      for (const s of sessionsAll) {
        if (s.isSubagent && !s.deleted) continue;
        const iso = sessionDate(s);
        if (!iso) continue;
        const tok = s.totalTokens || 0;
        if (tok <= 0) continue;
        const day = dayKey(iso);
        if (!isPlausibleDayKey(day)) continue;
        byDay.set(day, (byDay.get(day) || 0) + tok);
        const h = new Date(iso).getHours();
        byHour.set(h, (byHour.get(h) || 0) + tok);
      }
    }
    const hourProfile = Array.from({ length: 24 }, (_, h) => ({
      hour: h,
      tokens: byHour.get(h) || 0,
    }));
    const hourMax = Math.max(1, ...hourProfile.map((h) => h.tokens));
    const days = [...byDay.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    let cum = 0;
    let cumSeries = days.map(([day, t]) => {
      cum += t;
      return { label: day.slice(5), value: cum };
    });
    if (cumSeries.length > 60) {
      cumSeries = cumSeries.filter(
        (_, i) => i === 0 || i === cumSeries.length - 1 || i % 2 === 0
      );
    }
    return {
      hourProfile,
      hourMax,
      cumSeries,
      cumMax: Math.max(1, cum),
      spark: days.map(([, t]) => t),
    };
  }, [hasHourly, hourlyAll, sessionsAll]);

  const toolRows = useMemo(() => {
    const map = new Map<string, AggRow>();
    if (hourlyDims) {
      for (const [key, p] of hourlyDims.byClient) {
        const r = blankAgg(key);
        r.label = clientLabel(key);
        r.inputTokens = p.inputTokens;
        r.outputTokens = p.outputTokens;
        r.cacheReadTokens = p.cacheReadTokens;
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
          r.label = clientLabel(key);
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
          r.label = clientLabel(key);
          map.set(key, r);
        }
        addToAgg(r, s, currency, fx.rate);
      }
    }
    return [...map.values()].sort((a, b) => b.totalTokens - a.totalTokens);
  }, [aggSessions, hourlyDims, currency, fx.rate]);

  const projectRows = useMemo(() => {
    const map = new Map<string, AggRow>();
    if (scopedHourly.length > 0) {
      const todayKey = localDayKey(new Date());
      const byCwd = buildProjectTokensFromHourly(
        scopedHourly,
        sessionsAll,
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
    sessionsAll,
    rangeStart,
    activeClients,
    currency,
    fx.rate,
  ]);

  const modelRows = useMemo(() => {
    const map = new Map<string, AggRow>();
    if (hourlyDims) {
      for (const [key, p] of hourlyDims.byModel) {
        const r = blankAgg(key);
        r.inputTokens = p.inputTokens;
        r.outputTokens = p.outputTokens;
        r.cacheReadTokens = p.cacheReadTokens;
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
      for (const s of aggSessions) {
        const key = modelAggKey(s.model) || s.model || UNKNOWN_MODEL;
        let r = map.get(key);
        if (!r) {
          r = blankAgg(key);
          map.set(key, r);
        }
        if (s.usageSource !== "lifetime-fallback") {
          addHitFields(r, s);
          continue;
        }
        addToAgg(r, s, currency, fx.rate);
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

  const dailyRows = useMemo(() => {
    const map = new Map<string, AggRow>();
    if (scopedHourly.length > 0) {
      const dims =
        hourlyDims ||
        buildHourlyDimTotals(
          scopedHourly,
          rangeStart,
          localDayKey(new Date()),
          activeClients,
          (row) => hourlyBucketCost(row, currency, fx.rate),
          rangeEnd
        );
      for (const [day, p] of dims.byDay) {
        const r = blankAgg(day);
        r.inputTokens = p.inputTokens;
        r.outputTokens = p.outputTokens;
        r.cacheReadTokens = p.cacheReadTokens;
        r.totalTokens = p.totalTokens;
        r.requestCount = p.events || 0;
        r.genMs = p.genMs || 0;
        r.genTokens = p.genTokens || 0;
        r.estGenMs = p.estGenMs || 0;
        r.estGenTokens = p.estGenTokens || 0;
        r.cost = p.cost;
        r.hasCost = p.cost > 0;
        const onDay = buildSessionUsageOnDay(scopedHourly, day, activeClients);
        r.sessions = onDay.size;
        for (const s of aggSessions) {
          if ((sessionDate(s) ? dayKey(sessionDate(s)!) : "无日期") !== day) continue;
          addHitFields(r, s);
        }
        map.set(day, r);
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
    scopedHourly,
    hourlyDims,
    rangeStart,
    activeClients,
    currency,
    fx.rate,
  ]);

  function sessionsForAggKey(
    kind: DrillFilter["kind"],
    key: string
  ): (SessionRecord & {
    usageSource?: UsageSource;
    lifetimeTotalTokens?: number;
  })[] {
    // 按天：只显示该日真实发生
    if (kind === "day" && key !== "无日期" && scopedHourly.length > 0) {
      const onDay = buildSessionUsageOnDay(
        scopedHourly,
        key,
        activeClients,
        (row) => hourlyBucketCost(row, currency, fx.rate)
      );
      const byKey = new Map(sessionsAll.map((s) => [`${s.client}:${s.sessionId}`, s]));
      const out: ScopedSession[] = [];
      for (const [sk, u] of onDay) {
        const s = byKey.get(sk);
        if (!s) continue;
        if (!passHideAndClient(s) || !matchQuery(s)) continue;
        out.push({
          ...s,
          inputTokens: u.inputTokens,
          outputTokens: u.outputTokens,
          cacheReadTokens: u.cacheReadTokens,
          cacheWriteTokens: u.cacheWriteTokens,
          reasoningTokens: u.reasoningTokens,
          totalTokens: u.totalTokens,
          usageSource: "range",
          lifetimeTotalTokens: s.totalTokens,
        });
      }
      return out.sort((a, b) => (b.totalTokens || 0) - (a.totalTokens || 0));
    }

    return baseFiltered
      .filter((s) => {
        switch (kind) {
          case "client":
            return s.client === key;
          case "model":
            return (modelAggKey(s.model) || s.model || UNKNOWN_MODEL) === key;
          case "project":
            return (s.cwd || "未知目录") === key || (key === "未归属项目" && !s.cwd);
          case "day": {
            const iso = sessionDate(s);
            if (!iso) return key === "无日期";
            return dayKey(iso) === key;
          }
        }
      })
      .sort((a, b) => (b.totalTokens || 0) - (a.totalTokens || 0));
  }

  function drillFromAnalyze(key: string, label?: string) {
    if (analyzeView === "tools") drillToSessions({ kind: "client", id: key });
    else if (analyzeView === "models") drillToSessions({ kind: "model", model: key });
    else if (analyzeView === "projects")
      drillToSessions({ kind: "project", cwd: key, label });
    else if (analyzeView === "daily" && key !== "无日期")
      drillToSessions({ kind: "day", day: key });
  }

  const analyzeKind: DrillFilter["kind"] =
    analyzeView === "tools"
      ? "client"
      : analyzeView === "models"
        ? "model"
        : analyzeView === "projects"
          ? "project"
          : "day";

  const trend = useMemo(() => {
    type Bucket = { key: string; byStack: Map<string, number>; total: number };
    const byModel = trendStack === "model";

    const stackKeyOfHourly = (row: HourlyBucket) =>
      byModel
        ? row.model && !isUnknownModel(row.model)
          ? modelAggKey(row.model) || row.model
          : UNKNOWN_MODEL
        : row.client;

    const stackKeyOfSession = (s: SessionRecord) =>
      byModel ? modelAggKey(s.model) || s.model || UNKNOWN_MODEL : s.client;

    const addTo = (entry: Bucket, stackKey: string, tok: number) => {
      if (tok <= 0) return;
      entry.byStack.set(stackKey, (entry.byStack.get(stackKey) || 0) + tok);
      entry.total += tok;
    };

    let days: Bucket[];
    let hourlyMode = false;

    if (range === "today") {
      hourlyMode = true;
      days = Array.from({ length: 24 }, (_, h) => ({
        key: `${String(h).padStart(2, "0")}:00`,
        byStack: new Map<string, number>(),
        total: 0,
      }));
      const todayKey = localDayKey(new Date());
      if (hasHourly) {
        for (const row of scopedHourly) {
          if (!activeClients.has(row.client)) continue;
          if (!row.hour.startsWith(todayKey)) continue;
          const h = Number(row.hour.slice(11, 13));
          if (!Number.isFinite(h) || h < 0 || h > 23) continue;
          addTo(days[h], stackKeyOfHourly(row), row.totalTokens || 0);
        }
      } else {
        for (const s of filtered) {
          const iso = sessionDate(s);
          if (!iso || dayKey(iso) !== todayKey) continue;
          const h = new Date(iso).getHours();
          addTo(days[h], stackKeyOfSession(s), s.totalTokens || 0);
        }
      }
    } else {
      days = [];
      const today = new Date();
      today.setHours(0, 0, 0, 0);

      const parseDay = (key: string) => {
        const [y, m, d] = key.split("-").map(Number);
        const dt = new Date(y, m - 1, d);
        dt.setHours(0, 0, 0, 0);
        return dt;
      };

      const rawByDay = new Map<string, Bucket>();
      const ensureDay = (key: string) => {
        let e = rawByDay.get(key);
        if (!e) {
          e = { key, byStack: new Map(), total: 0 };
          rawByDay.set(key, e);
        }
        return e;
      };

      if (hasHourly) {
        for (const row of scopedHourly) {
          if (!activeClients.has(row.client)) continue;
          const tok = row.totalTokens || 0;
          if (tok <= 0) continue;
          const day = row.hour.slice(0, 10);
          if (!isPlausibleDayKey(day)) continue;
          const t = parseDay(day).getTime();
          if (Number.isNaN(t)) continue;
          if (t > today.getTime() + 86_400_000) continue;
          if (rangeStart != null && t < rangeStart) continue;
          addTo(ensureDay(day), stackKeyOfHourly(row), tok);
        }
      } else {
        for (const s of filtered) {
          const iso = sessionDate(s);
          if (!iso || (s.totalTokens || 0) <= 0) continue;
          const day = dayKey(iso);
          const t = parseDay(day).getTime();
          if (Number.isNaN(t)) continue;
          if (rangeStart != null && t < rangeStart) continue;
          addTo(ensureDay(day), stackKeyOfSession(s), s.totalTokens || 0);
        }
      }

      let start: Date;
      let end: Date = new Date(today);

      if (rangeStart != null) {
        start = new Date(rangeStart);
        start.setHours(0, 0, 0, 0);
        end = new Date(today);
      } else {
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
      let rawSpan = Math.round((end.getTime() - start.getTime()) / 86_400_000) + 1;
      if (rawSpan < 1) {
        start = new Date(end);
        rawSpan = 1;
      }
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
        days.push(existing || { key, byStack: new Map(), total: 0 });
      }

      if (rangeStart == null) days = trimEmptyEnds(days);
    }

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
      const MIN_SHARE = 0.005;
      const MAX_NAMED = 12;
      const minAbs = Math.max(1, totalAll * MIN_SHARE);
      let top: string[] = [];
      const rest: [string, number][] = [];
      for (const [k, v] of sorted) {
        if (k === "其他") continue;
        if (v >= minAbs && top.length < MAX_NAMED) top.push(k);
        else rest.push([k, v]);
      }
      if (top.length < 6 && sorted.length > top.length) {
        top = sorted.slice(0, Math.min(6, sorted.length)).map(([k]) => k);
        rest.length = 0;
        for (const [k, v] of sorted) {
          if (!top.includes(k)) rest.push([k, v]);
        }
      }
      const otherKey = "其他";
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
      labelOf = (k) => k;
    } else {
      stackKeys = CLIENT_ORDER.filter((c) => (totalsByKey.get(c) || 0) > 0);
      for (const k of totalsByKey.keys()) {
        if (!stackKeys.includes(k as (typeof CLIENT_ORDER)[number])) stackKeys.push(k);
      }
      colorOf = (k) => CLIENT_COLORS[k] || "#6b6b76";
      labelOf = (k) => clientLabel(k);
    }

    const max = Math.max(1, ...days.map((d) => d.total));
    return {
      days,
      max,
      hourly: hourlyMode,
      fromTurns: hasHourly,
      stackMode: trendStack,
      stackKeys,
      colorOf,
      labelOf,
      firstDay: days[0]?.key,
      lastDay: days[days.length - 1]?.key,
    };
  }, [filtered, rangeStart, range, hasHourly, scopedHourly, activeClients, trendStack]);

  const heatmap = useMemo(() => {
    const byDay = new Map<string, number>();

    if (hasHourly) {
      for (const row of scopedHourly) {
        if (!activeClients.has(row.client)) continue;
        const tok = row.totalTokens || 0;
        if (tok <= 0) continue;
        const k = row.hour.slice(0, 10);
        if (!isPlausibleDayKey(k)) continue;
        byDay.set(k, (byDay.get(k) || 0) + tok);
      }
    } else {
      for (const s of sessionsAll) {
        if (!activeClients.has(s.client)) continue;
        if (query.trim() && !matchesSession(s, query, CLIENT_LABELS)) continue;
        const iso = sessionDate(s);
        if (!iso) continue;
        const k = dayKey(iso);
        byDay.set(k, (byDay.get(k) || 0) + (s.totalTokens || 0));
      }
    }

    const WEEKS = 26;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const start = new Date(today);
    const dow = (start.getDay() + 6) % 7;
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

    const max = Math.max(1, ...byDay.values(), 1);
    const monthLabels = weeks.map((week, i) => {
      const m = week[0].key.slice(5, 7);
      if (i === 0) return `${Number(m)}月`;
      return weeks[i - 1][0].key.slice(5, 7) !== m ? `${Number(m)}月` : "";
    });
    return { weeks, max, monthLabels };
  }, [sessionsAll, scopedHourly, hasHourly, activeClients, query, drill]);

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
    } else {
      for (const s of aggSessions) {
        const cur = map.get(s.client) || { count: 0, tokens: 0 };
        cur.count += 1;
        cur.tokens += s.totalTokens || 0;
        map.set(s.client, cur);
      }
    }
    return map;
  }, [hourlyDims, aggSessions]);

  const rangeTotal = useMemo(
    () =>
      hourlyDims
        ? hourlyDims.total.totalTokens
        : [...clientStats.values()].reduce((a, v) => a + v.tokens, 0),
    [hourlyDims, clientStats]
  );

  const modelDist = useMemo(() => {
    const map = new Map<string, number>();
    if (hourlyDims) {
      for (const [key, p] of hourlyDims.byModel) {
        map.set(key, p.totalTokens);
      }
    } else {
      for (const s of aggSessions) {
        const key = s.model || UNKNOWN_MODEL;
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
  }, [hourlyDims, aggSessions]);

  const clientsPresent = useMemo(() => {
    const set = new Set<string>();
    for (const s of sessionsAll) if (s.client) set.add(s.client);
    const ordered = CLIENT_ORDER.filter((c) => set.has(c));
    for (const c of set) {
      if (!ordered.includes(c as (typeof CLIENT_ORDER)[number])) ordered.push(c as (typeof CLIENT_ORDER)[number]);
    }
    return ordered.length ? ordered : [...CLIENT_ORDER];
  }, [sessionsAll]);

  const rangeLabel = (() => {
    const base = RANGES.find((r) => r.id === range)!.label;
    if (range === "all" && trend.firstDay && trend.lastDay && !trend.hourly) {
      return `${base} · ${trend.firstDay.slice(5)} → ${trend.lastDay.slice(5)}`;
    }
    return base;
  })();

  const filterActiveCount =
    (hideEmpty ? 1 : 0) + (hideOrphans ? 1 : 0) + (hideDeleted ? 1 : 0) +
    (activeClients.size < clientsPresent.length ? 1 : 0);

  if (booting) {
    return (
      <div className="screen center">
        <div className="muted">加载中…</div>
      </div>
    );
  }

  if (!loggedIn) {
    return (
      <div className="screen auth">
        <div className="auth-card">
          <div className="brand">
            <span className="brand-mark" />
            Token Stats
          </div>
          <p className="lead">手机只读 · 查看桌面同步的用量快照</p>

          <label className="field">
            Project URL
            <input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://xxxx.supabase.co"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
            />
          </label>
          <label className="field">
            anon key
            <input
              value={anonKey}
              onChange={(e) => setAnonKey(e.target.value)}
              placeholder="eyJ…"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
            />
          </label>
          <button type="button" className="btn ghost" onClick={() => void saveCfg()} disabled={loading}>
            保存配置
          </button>

          <div className="divider" />

          <label className="field">
            邮箱
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoCapitalize="none"
              autoComplete="username"
              placeholder="与桌面端同一账号"
            />
          </label>
          <label className="field">
            密码
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
            />
          </label>

          <div className="row">
            <button
              type="button"
              className="btn primary grow"
              disabled={loading || !url || !anonKey || !email || !password}
              onClick={() => void doLogin("login")}
            >
              {loading ? "…" : "登录"}
            </button>
            <button
              type="button"
              className="btn ghost"
              disabled={loading}
              onClick={() => void doLogin("signup")}
            >
              注册
            </button>
          </div>

          <p className="hint">
            使用与桌面端相同的 Supabase 项目与邮箱。数据只读，不会在手机上扫描本机日志。
          </p>

          {info && <div className="banner ok">{info}</div>}
          {error && <div className="banner err">{error}</div>}
        </div>
      </div>
    );
  }

  const analyzeRows =
    analyzeView === "tools"
      ? toolRows
      : analyzeView === "projects"
        ? projectRows
        : analyzeView === "models"
          ? modelRows
          : dailyRows;

  return (
    <div className="screen app">
      <header className="top">
        <div>
          <button
            type="button"
            className={`top-title brand-home${tab === "home" ? " on-home" : ""}`}
            onClick={goHome}
          >
            <span className="brand-dot" />
            Token Stats
          </button>
          <div className="top-sub">
            {userEmail || "已登录"}
            {snapshot ? ` · 同步 ${formatRelative(snapshot.updated_at)}` : ""}
          </div>
        </div>
        <div className="top-actions">
          <button
            type="button"
            className="btn ghost sm"
            onClick={toggleCurrency}
            title="切换币种"
          >
            {currency === "CNY" ? "¥" : "$"}
          </button>
          <button
            type="button"
            className="btn ghost sm"
            disabled={loading}
            onClick={() => void refresh()}
          >
            {loading ? "…" : "刷新"}
          </button>
        </div>
      </header>

      {(error || info) && (
        <div className={`banner ${error ? "err" : "ok"} banner-inline`}>
          {error || info}
        </div>
      )}

      {/* 全局：时间范围 + 工具筛选（概览/分析/会话共用；生涯首页不用） */}
      {tab !== "settings" && tab !== "home" && (
        <div className="global-filters">
          <div className="chip-scroll">
            {RANGES.map((r) => (
              <button
                key={r.id}
                type="button"
                className={`f-chip ${range === r.id ? "on" : ""}`}
                onClick={() => switchRange(r.id)}
              >
                {r.label}
              </button>
            ))}
            <button
              type="button"
              className={`f-chip ${showFilters ? "on" : ""}`}
              onClick={() => setShowFilters((v) => !v)}
            >
              筛选{filterActiveCount ? ` ${filterActiveCount}` : ""}
            </button>
            {query.trim() ? (
              <button
                type="button"
                className="f-chip on"
                onClick={() => setQuery("")}
              >
                搜索：{query.trim()} · 清除
              </button>
            ) : null}
            {drill ? (
              <button type="button" className="f-chip on" onClick={clearDrill}>
                {drillCaption(drill)} · 清除
              </button>
            ) : null}
          </div>
          {showFilters && (
            <div className="filter-panel">
              <div className="chip-scroll">
                <button
                  type="button"
                  className={`f-chip ${activeClients.size >= clientsPresent.length ? "on" : ""}`}
                  onClick={setClientAll}
                >
                  全部工具
                </button>
                {clientsPresent.map((c) => (
                  <button
                    key={c}
                    type="button"
                    className={`f-chip ${activeClients.has(c) && activeClients.size === 1 ? "on" : activeClients.has(c) ? "soft" : ""}`}
                    onClick={() => toggleClient(c)}
                  >
                    <span
                      className="dot"
                      style={{ background: CLIENT_COLORS[c] || "#6b6b76" }}
                    />
                    {clientLabel(c)}
                  </button>
                ))}
              </div>
              <div className="filter-toggles">
                <button
                  type="button"
                  className={`toggle-chip ${hideEmpty ? "on" : ""}`}
                  onClick={toggleHideEmpty}
                >
                  {hideEmpty
                    ? `已藏空${emptyHiddenCount ? ` ${emptyHiddenCount}` : ""}`
                    : "显示空会话"}
                </button>
                <button
                  type="button"
                  className={`toggle-chip ${hideOrphans ? "on" : ""}`}
                  onClick={toggleHideOrphans}
                >
                  {hideOrphans
                    ? `已藏未归并${orphanHiddenCount ? ` ${orphanHiddenCount}` : ""}`
                    : "显示未归并"}
                </button>
                <button
                  type="button"
                  className={`toggle-chip ${hideDeleted ? "on" : ""}`}
                  onClick={toggleHideDeleted}
                >
                  {hideDeleted
                    ? `已藏已删除${deletedHiddenCount ? ` ${deletedHiddenCount}` : ""}`
                    : "隐藏已删除"}
                </button>
              </div>
              <SearchBox
                value={query}
                onChange={setQuery}
                placeholder="搜索标题 / 路径 / 模型 / 工具…"
                sessions={searchPool}
                clientLabels={CLIENT_LABELS}
                onPickSession={(client, sessionId) => {
                  const s = sessionsAll.find(
                    (x) => x.client === client && x.sessionId === sessionId
                  );
                  if (s) setDetail(s);
                }}
                onPickDrill={applySearchDrill}
              />
            </div>
          )}
        </div>
      )}

      <main className="main" ref={mainRef}>
        {tab === "home" && (
          <div className="stack">
            <h1 className="page-title">生涯</h1>

            <section className="card lifetime-card">
              <div className="card-head">
                <div className="card-title">全部数据</div>
                <span className="panel-hint">
                  {lifetime.firstDay && lifetime.lastDay
                    ? `${lifetime.firstDay.slice(5)} → ${lifetime.lastDay.slice(5)}`
                    : ""}
                </span>
              </div>
              {lifetime.lifetimeTokens <= 0 ? (
                <p className="muted pad-sm">
                  云端还没有用量。请先在桌面端扫描并上传快照。
                </p>
              ) : (
                <>
                  <div className="journey-grid">
                    <div className="journey-cell">
                      <span className="j-label">跨度</span>
                      <span className="j-val">{lifetime.calendarSpanDays} 天</span>
                    </div>
                    <div className="journey-cell">
                      <span className="j-label">活跃日</span>
                      <span className="j-val">{lifetime.activeDays}</span>
                    </div>
                    <div className="journey-cell">
                      <span className="j-label">生涯 Token</span>
                      <span className="j-val">
                        {formatTokens(lifetime.lifetimeTokens)}
                      </span>
                    </div>
                    <div className="journey-cell">
                      <span className="j-label">日均</span>
                      <span className="j-val">
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
                        switchRange("all");
                        drillToSessions({
                          kind: "day",
                          day: lifetime.peakDay.day,
                        });
                      }}
                    >
                      <div className="insight-kicker">峰值日</div>
                      <div className="insight-main">
                        {lifetime.peakDay?.day?.slice(5) ?? "–"}
                      </div>
                      <div className="insight-sub">
                        {lifetime.peakDay
                          ? formatTokens(lifetime.peakDay.tokens)
                          : "暂无"}
                      </div>
                    </button>
                    <button
                      type="button"
                      className="insight-card"
                      disabled={!lifetime.peakSession}
                      onClick={() => {
                        if (lifetime.peakSession) setDetail(lifetime.peakSession);
                      }}
                    >
                      <div className="insight-kicker">最重会话</div>
                      <div className="insight-main ellipsis">
                        {lifetime.peakSession
                          ? lifetime.peakSession.title ||
                            lifetime.peakSession.sessionId.slice(0, 10)
                          : "–"}
                      </div>
                      <div className="insight-sub">
                        {lifetime.peakSession
                          ? formatTokens(lifetime.peakSession.totalTokens)
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
                          ? formatTokens(lifetime.busiestHour.tokens)
                          : "暂无"}
                      </div>
                    </div>
                  </div>

                  {(lifetime.topClient || lifetime.topModel || lifetime.topProject) && (
                    <div className="meta-chips">
                      {lifetime.topClient && (
                        <span className="meta-chip">
                          工具{" "}
                          <b>
                            {CLIENT_LABELS[
                              lifetime.topClient
                                .id as (typeof CLIENT_ORDER)[number]
                            ] || lifetime.topClient.id}
                          </b>{" "}
                          {lifetime.topClient.pct}%
                        </span>
                      )}
                      {lifetime.topModel && (
                        <span className="meta-chip" title={lifetime.topModel.model}>
                          模型 <b>{lifetime.topModel.model}</b>{" "}
                          {lifetime.topModel.pct}%
                        </span>
                      )}
                      {lifetime.topProject && (
                        <span className="meta-chip" title={lifetime.topProject.cwd}>
                          项目 <b>{lifetime.topProject.label}</b>
                        </span>
                      )}
                    </div>
                  )}

                  {lifetime.topDays.length > 0 && (
                    <div>
                      <div className="mini-head">Token 最高的 5 天</div>
                      <ul className="top-day-list">
                        {lifetime.topDays.map((d, i) => (
                          <li key={d.day}>
                            <button
                              type="button"
                              className="top-day-row"
                              onClick={() => {
                                switchRange("all");
                                drillToSessions({ kind: "day", day: d.day });
                              }}
                            >
                              <span className="rank">{i + 1}</span>
                              <span className="date">{d.day.slice(5)}</span>
                              <span className="bar-track">
                                <span
                                  className="bar"
                                  style={{
                                    width: `${(d.tokens / topDayMax) * 100}%`,
                                  }}
                                />
                              </span>
                              <span className="tok">{formatTokens(d.tokens)}</span>
                            </button>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}

                  <div className="lifetime-weekday">
                    <div className="mini-head">星期偏好</div>
                    <div className="weekday-bars">
                      {lifetime.weekdayTotals.map((tok, i) => {
                        const h = weekdayMax > 0 ? (tok / weekdayMax) * 100 : 0;
                        return (
                          <div key={i} className="weekday-col">
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
                </>
              )}
            </section>

            <section className="card">
              <div className="card-title">活跃热力图</div>
              <div className="panel-hint">近 26 周 · 生涯全量</div>
              <div className="heat-scroll">
                <div className="heat-months">
                  {heatmap.monthLabels.map((m, i) => (
                    <span key={i}>{m}</span>
                  ))}
                </div>
                <div className="heat-body">
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
              <div className="heat-legend">
                少
                <i className="heat-cell lv0" />
                <i className="heat-cell lv1" />
                <i className="heat-cell lv2" />
                <i className="heat-cell lv3" />
                <i className="heat-cell lv4" />
                多
              </div>
            </section>

            <section className="card">
              <div className="card-title">生涯时段</div>
              <div className="panel-hint">0–23 点 · 全部历史</div>
              <div className="hour-bars">
                {lifeCharts.hourProfile.map((h) => {
                  const ratio =
                    lifeCharts.hourMax > 0
                      ? h.tokens / lifeCharts.hourMax
                      : 0;
                  return (
                    <div
                      key={h.hour}
                      className={`hour-col${
                        lifetime.busiestHour?.hour === h.hour ? " peak" : ""
                      }`}
                    >
                      <div
                        className="hour-fill life"
                        style={{
                          height:
                            h.tokens > 0 ? `${Math.max(3, ratio * 100)}%` : 0,
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
                <div style={{ marginTop: 10 }}>
                  <div className="mini-head">每日 sparkline</div>
                  <Sparkline
                    values={lifeCharts.spark}
                    color="#a78bfa"
                    height={44}
                  />
                </div>
              )}
            </section>

            {lifeCharts.cumSeries.length > 1 && (
              <section className="card">
                <div className="card-title">生涯累计</div>
                <div className="panel-hint">
                  合计 {formatTokens(lifeCharts.cumMax)}
                </div>
                <AreaChart
                  points={lifeCharts.cumSeries}
                  max={lifeCharts.cumMax}
                  color="#9385d9"
                  fill="rgba(147, 133, 217, 0.18)"
                />
              </section>
            )}
          </div>
        )}

        {tab === "overview" && (
          <div className="stack">
            <h1 className="page-title">概览</h1>

            <section className="hero-card">
              <div className="label">Total Tokens · {rangeLabel}</div>
              <div className="hero-num">{formatTokens(totals.totalTokens)}</div>
              <div className="hero-meta">
                <span>{totals.sessions} 会话</span>
                {(totals.requestCount || 0) > 0 && (
                  <span title="模型 API 请求次数（有小时桶时为本区间）">
                    {totals.requestCount!.toLocaleString()} 次请求
                  </span>
                )}
                <span>
                  {hideCost ? "•••" : formatCost(totals.cost, currency)}
                </span>
                <button type="button" className="link-btn" onClick={toggleHideCost}>
                  {hideCost ? "显示成本" : "藏成本"}
                </button>
              </div>
              <div className="hero-deltas">
                <span>
                  今日 {formatTokens(deltas.today)}
                  {pctChange(deltas.today, deltas.yesterday) && (
                    <em> {pctChange(deltas.today, deltas.yesterday)}</em>
                  )}
                </span>
                <span>
                  本周 {formatTokens(deltas.week)}
                  {pctChange(deltas.week, deltas.prevWeek) && (
                    <em> {pctChange(deltas.week, deltas.prevWeek)}</em>
                  )}
                </span>
              </div>
              <div className="hero-foot">
                桌面上传于 {formatFull(snapshot?.updated_at)}
                {snapshot?.device_label ? ` · ${snapshot.device_label}` : ""}
                {hasHourly ? " · 含小时桶" : " · 会话时间（请桌面重新上传）"}
              </div>
            </section>

            <section className="card">
              <div className="card-head">
                <div className="card-title">本区间亮点</div>
                <span className="panel-hint">{rangeLabel}</span>
              </div>
              <div className="range-insight-grid">
                <div className="range-insight-card">
                  <div className="insight-kicker">峰值日</div>
                  <div className="insight-main">
                    {rangeInsights.peakDay?.day?.slice(5) ?? "–"}
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
                    {rangeInsights.sessions} 会话
                    {rangeInsights.vsPrev ? ` · ${rangeInsights.vsPrev}` : ""}
                  </div>
                </div>
              </div>
              {rangeInsights.composition.length > 0 && (
                <div>
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
                      />
                    ))}
                  </div>
                  <div className="comp-list">
                    {rangeInsights.composition.map((c) => {
                      const pct = (c.tokens / rangeInsights.compTotal) * 100;
                      return (
                        <div key={c.key} className="comp-row">
                          <span className="dot" style={{ background: c.color }} />
                          <span className="comp-label">{c.key}</span>
                          <span className="comp-val">{formatTokens(c.tokens)}</span>
                          <span className="comp-pct">
                            {pct < 1 ? "<1%" : `${Math.round(pct)}%`}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
              {rangeInsights.topProjects.length > 0 && (
                <div>
                  <div className="mini-head">本区间项目 Top 5</div>
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
                        >
                          <span className="rank">{i + 1}</span>
                          <span className="date" style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>
                            {p.label}
                          </span>
                          <span className="bar-track">
                            <span
                              className="bar"
                              style={{
                                width: `${(p.tokens / rangeInsights.topProjMax) * 100}%`,
                              }}
                            />
                          </span>
                          <span className="tok">{formatTokens(p.tokens)}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {rangeInsights.sparkValues.length > 1 && (
                <div>
                  <div className="mini-head">
                    Token 走势
                    {rangeInsights.grain === "hour" ? " · 按小时" : " · 按日"}
                  </div>
                  <Sparkline values={rangeInsights.sparkValues} color="#34d399" height={44} />
                </div>
              )}
              {rangeInsights.grain === "day" &&
                rangeInsights.weekdayTok + rangeInsights.weekendTok > 0 && (
                <div>
                  <div className="mini-head">工作日 vs 周末</div>
                  <div className="ww-bar">
                    {(() => {
                      const t =
                        rangeInsights.weekdayTok + rangeInsights.weekendTok || 1;
                      const w = (rangeInsights.weekdayTok / t) * 100;
                      return (
                        <>
                          <div className="ww-seg week" style={{ width: `${w}%` }} />
                          <div className="ww-seg end" style={{ width: `${100 - w}%` }} />
                        </>
                      );
                    })()}
                  </div>
                  <div className="ww-legend">
                    <span>工作日 {formatTokens(rangeInsights.weekdayTok)}</span>
                    <span>周末 {formatTokens(rangeInsights.weekendTok)}</span>
                  </div>
                </div>
              )}
            </section>

            <section className="card">
              <div className="card-title">时段分布</div>
              <div className="panel-hint">
                0–23 点
                {rangeInsights.busiestHour
                  ? ` · 最忙 ${formatHourRange(rangeInsights.busiestHour.hour)}`
                  : ""}
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
                    >
                      <div
                        className="hour-fill"
                        style={{
                          height:
                            h.tokens > 0 ? `${Math.max(3, ratio * 100)}%` : 0,
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
              <section className="card">
                <div className="card-title">累计用量</div>
                <div className="panel-hint">
                  {rangeInsights.grain === "hour" ? "今日按小时" : "区间"} · 终点{" "}
                  {formatTokens(
                    rangeInsights.dailySeries[rangeInsights.dailySeries.length - 1]
                      ?.cum || 0
                  )}
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
              <section className="card">
                <div className="card-title">Input / Output</div>
                <div className="panel-hint">
                  {rangeInsights.grain === "hour" ? "按小时" : "按日"} · 绿入蓝出
                </div>
                <div className="io-cols">
                  {rangeInsights.dailySeries.map((d) => (
                    <div
                      key={d.day}
                      className="io-col"
                      title={`${d.label} In ${formatTokens(d.input)} Out ${formatTokens(d.output)}`}
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
              </section>
            )}

            <section className="card">
              <div className="card-title">分项</div>
              <div className="metrics">
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
                />
                <Metric label="Output" value={formatTokens(totals.outputTokens)} />
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
                          (a, s) =>
                            a + (s.noCacheData ? s.estCacheReadTokens || 0 : 0),
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
                        label="Cache R"
                        value={
                          <SplitMetricValue
                            primary={cacheParts.primary}
                            extra={cacheParts.extra}
                          />
                        }
                      />
                      <Metric
                        label="Cache W"
                        value={formatTokens(totals.cacheWriteTokens)}
                      />
                      <Metric
                        label="Reason"
                        value={formatTokens(totals.reasoningTokens)}
                      />
                      <Metric
                        label="缓存命中"
                        value={
                          <SplitMetricValue
                            primary={hitParts.primary}
                            extra={hitParts.extra}
                          />
                        }
                        tone={hitRateTone(hit)}
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
                />
                <Metric
                  label="速度"
                  value={formatTokPerSec(
                    tokensPerSec(totals.genTokens, totals.genMs),
                    tokensPerSec(totals.estGenTokens, totals.estGenMs)
                  )}
                />
                <Metric
                  label={fx.live ? `汇率${fx.date ? ` · ${fx.date.slice(5)}` : ""}` : "汇率 · 兜底"}
                  value={fx.rate.toFixed(2)}
                />
              </div>
            </section>

            <section className="card">
              <div className="card-head">
                <div className="card-title">用量趋势</div>
                <button type="button" className="link-btn" onClick={toggleTrendStack}>
                  {trendStack === "client" ? "按工具" : "按模型"}
                </button>
              </div>
              <div className="panel-hint">
                {trend.hourly
                  ? "按小时"
                  : range === "all" && trend.firstDay && trend.lastDay
                    ? `${trend.firstDay.slice(5)} → ${trend.lastDay.slice(5)} · ${trend.days.length} 天`
                    : `按天 · ${trend.days.length} 天`}
                {trend.fromTurns ? " · turn 时间" : " · 会话时间"}
              </div>
              {trend.stackKeys.length > 0 && (
                <div className="trend-legend">
                  {trend.stackKeys.slice(0, 8).map((k) => (
                    <span key={k} className="trend-legend-item">
                      <i className="swatch" style={{ background: trend.colorOf(k) }} />
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
                      const active = trend.stackKeys.filter(
                        (k) => (d.byStack.get(k) || 0) > 0
                      );
                      const topKey = active[active.length - 1];
                      return (
                        <div
                          key={d.key}
                          className={`trend-col${axis ? " has-label" : ""}`}
                          title={`${d.key} · ${formatTokens(d.total)}`}
                        >
                          <div className="trend-bar">
                            {trend.stackKeys.map((k) => {
                              const v = d.byStack.get(k) || 0;
                              if (v === 0) return null;
                              return (
                                <div
                                  key={k}
                                  className={`seg ${k === topKey ? "seg-top" : ""}`}
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

            <section className="card">
              <div className="card-title">按工具分布</div>
              <div className="dist-bar">
                {clientsPresent.map((c) => {
                  const tokens = clientStats.get(c)?.tokens || 0;
                  if (tokens === 0 || rangeTotal === 0) return null;
                  return (
                    <div
                      key={c}
                      className="seg"
                      style={{
                        width: `${(tokens / rangeTotal) * 100}%`,
                        background: CLIENT_COLORS[c] || "#6b6b76",
                      }}
                    />
                  );
                })}
                {rangeTotal === 0 && <div className="dist-empty">暂无数据</div>}
              </div>
              <ul className="client-list">
                {clientsPresent.map((c) => {
                  const stat = clientStats.get(c);
                  if (!stat) return null;
                  const pct =
                    rangeTotal > 0 ? Math.round((stat.tokens / rangeTotal) * 100) : 0;
                  return (
                    <li key={c} onClick={() => toggleClient(c)} className="clickable">
                      <span
                        className="dot"
                        style={{ background: CLIENT_COLORS[c] || "#6b6b76" }}
                      />
                      <span className="name">{clientLabel(c)}</span>
                      <span className="count">{stat.count} · {pct}%</span>
                      <span className="tok">{formatTokens(stat.tokens)}</span>
                    </li>
                  );
                })}
              </ul>
            </section>

            <section className="card">
              <div className="card-title">按模型分布</div>
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
                      />
                    )
                )}
                {rangeTotal === 0 && <div className="dist-empty">暂无数据</div>}
              </div>
              <ul className="client-list">
                {modelDist.map((m) => {
                  const pct =
                    rangeTotal > 0 ? Math.round((m.tokens / rangeTotal) * 100) : 0;
                  const unk = isUnknownModel(m.key);
                  return (
                    <li
                      key={m.key}
                      className={`${m.key !== "其他" && !unk ? "clickable" : ""}${
                        unk ? " model-unknown" : ""
                      }`}
                      onClick={() => {
                        if (m.key !== "其他" && !unk) {
                          setQuery(m.key);
                          setShowFilters(true);
                        }
                      }}
                    >
                      <span className="dot" style={{ background: m.color }} />
                      <span className="name model-name">{m.key}</span>
                      <span className="count">{pct}%</span>
                      <span className="tok">{formatTokens(m.tokens)}</span>
                    </li>
                  );
                })}
              </ul>
            </section>
          </div>
        )}

        {tab === "analyze" && (
          <div className="stack">
            <h1 className="page-title">分析</h1>
            <div className="seg-control">
              {ANALYZE_VIEWS.map((v) => (
                <button
                  key={v.id}
                  type="button"
                  className={analyzeView === v.id ? "on" : ""}
                  onClick={() => switchAnalyze(v.id)}
                >
                  {v.label}
                </button>
              ))}
            </div>
            <div className="muted pad-sm">
              {analyzeRows.length} 条 · {rangeLabel}
              {hideCost ? "" : ` · ${currency}`}
              {" · 点开看 Top 会话"}
              {fallbackCount > 0
                ? ` · ${fallbackCount} 条未拆分`
                : canSplitByRange
                  ? ""
                  : hasHourly
                    ? ""
                    : " · 无小时桶·显示会话全量"}
            </div>
            <ul className="agg-list">
              {analyzeRows.map((r) => {
                const max = Math.max(1, analyzeRows[0]?.totalTokens || 1);
                const pct = Math.round((r.totalTokens / max) * 100);
                const open = expandedAgg === r.key;
                const group = open ? sessionsForAggKey(analyzeKind, r.key) : [];
                const top = group.slice(0, 6);
                return (
                  <li key={r.key} className={`agg-item ${open ? "open" : ""}`}>
                    <button
                      type="button"
                      className="agg-item-head"
                      onClick={() =>
                        setExpandedAgg((prev) => (prev === r.key ? null : r.key))
                      }
                    >
                      <div className="agg-top">
                        <div
                          className={`agg-title${
                            analyzeView === "models" && isUnknownModel(r.key)
                              ? " model-unknown"
                              : ""
                          }`}
                          title={r.key}
                        >
                          <span className="agg-chevron">{open ? "▾" : "▸"}</span>
                          {r.label || r.key}
                          {r.fallbackSessions > 0 ? (
                            <span className="usage-badge fallback">
                              {r.fallbackSessions >= r.sessions
                                ? "全量·未拆分"
                                : `${r.fallbackSessions} 条全量`}
                            </span>
                          ) : null}
                        </div>
                        <div className="agg-tok">{formatTokens(r.totalTokens)}</div>
                      </div>
                      {r.label && r.label !== r.key && (
                        <div className="agg-sub">{r.key}</div>
                      )}
                      <div className="agg-bar">
                        <div style={{ width: `${pct}%` }} />
                      </div>
                      <div className="agg-meta">
                        <span>{r.sessions} 会话</span>
                        {r.requestCount > 0 && (
                          <span title="模型 API 请求次数">
                            请求 {r.requestCount.toLocaleString()}
                          </span>
                        )}
                        <span>in {formatTokens(r.inputTokens)}</span>
                        <span>out {formatTokens(r.outputTokens)}</span>
                        {(tokensPerSec(r.genTokens, r.genMs) != null ||
                          tokensPerSec(r.estGenTokens, r.estGenMs) != null) && (
                          <span>
                            {formatTokPerSec(
                              tokensPerSec(r.genTokens, r.genMs),
                              tokensPerSec(r.estGenTokens, r.estGenMs)
                            )}
                          </span>
                        )}
                        {(() => {
                          const hit = cacheHitRate(
                            r.hitInputTokens,
                            r.hitCacheReadTokens
                          );
                          const overall = overallHitRate(
                            r.inputTokens,
                            r.cacheReadTokens,
                            r.estCacheReadTokens
                          );
                          const tone = hitRateTone(hit);
                          return (
                            <span className={`hit-rate hit-${tone}`}>
                              命中 {formatHitRate(hit, overall)}
                            </span>
                          );
                        })()}
                        {!hideCost && r.hasCost && (
                          <span>{formatCost(r.cost, currency)}</span>
                        )}
                      </div>
                    </button>
                    {open && (
                      <div className="agg-expand">
                        {top.length === 0 ? (
                          <div className="muted pad-sm">无会话</div>
                        ) : (
                          <ul className="agg-session-list">
                            {top.map((s) => {
                              const sc = s as SessionRecord & {
                                lifetimeTotalTokens?: number;
                              };
                              const showLife = isMeaningfulLifetimeGap(
                                s.totalTokens || 0,
                                sc.lifetimeTotalTokens
                              );
                              return (
                                <li key={s.id}>
                                  <button
                                    type="button"
                                    className="agg-session-item"
                                    onClick={() => setDetail(s)}
                                  >
                                    <span className="agg-s-title">
                                      {s.title || s.sessionId}
                                    </span>
                                    <span className="agg-s-meta">
                                      {formatTokens(s.totalTokens || 0)}
                                      {showLife
                                        ? ` · 生涯 ${formatTokens(sc.lifetimeTotalTokens!)}`
                                        : ""}
                                    </span>
                                  </button>
                                </li>
                              );
                            })}
                          </ul>
                        )}
                        <button
                          type="button"
                          className="btn ghost sm agg-all-btn"
                          disabled={r.key === "无日期"}
                          onClick={() => drillFromAnalyze(r.key, r.label)}
                        >
                          在会话列表查看全部 →
                        </button>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
            {analyzeRows.length === 0 && (
              <div className="muted pad center">暂无数据</div>
            )}
          </div>
        )}

        {tab === "sessions" && (
          <div className="stack">
            <h1 className="page-title">会话</h1>
            <div className="seg-control">
              {(
                [
                  ["time", "时间"],
                  ["total", "用量"],
                  ["requests", "请求"],
                  ["turns", "Turn"],
                  ["msgs", "Msgs"],
                  ["hit", "命中"],
                  ["cost", "成本"],
                ] as const
              ).map(([k, label]) => (
                <button
                  key={k}
                  type="button"
                  className={sortKey === k ? "on" : ""}
                  onClick={() => setSort(k)}
                >
                  {label}
                </button>
              ))}
            </div>
            {query.trim() && (
              <button
                type="button"
                className="drill-banner"
                onClick={() => setQuery("")}
              >
                搜索：{query.trim()} · 点此清除
              </button>
            )}
            {drill && (
              <button type="button" className="drill-banner" onClick={clearDrill}>
                下钻：{drillCaption(drill)} · 点此清除
              </button>
            )}
            <div className="muted pad-sm">
              {sortedSessions.length} / {sessionsAll.length} 会话
              {emptyHiddenCount > 0 ? ` · 藏空 ${emptyHiddenCount}` : ""}
              {fallbackCount > 0 ? ` · ${fallbackCount} 条全量未拆分` : ""}
            </div>
            <ul className="session-list">
              {sortedSessions.map((s) => (
                <SessionItem
                  key={s.id}
                  s={s}
                  currency={currency}
                  rate={fx.rate}
                  hideCost={hideCost}
                  onOpen={() => setDetail(s)}
                />
              ))}
            </ul>
            {sortedSessions.length === 0 && (
              <div className="muted pad center">没有匹配的会话</div>
            )}
          </div>
        )}

        {tab === "settings" && (
          <div className="stack">
            <h1 className="page-title">设置</h1>
            <section className="card">
              <div className="card-title">外观</div>
              <div className="seg-control">
                {(
                  [
                    ["system", "跟随系统"],
                    ["light", "浅色"],
                    ["dark", "深色"],
                  ] as const
                ).map(([t, label]) => (
                  <button
                    key={t}
                    type="button"
                    className={theme === t ? "on" : ""}
                    onClick={() => setTheme(t)}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </section>
            <section className="card">
              <div className="card-title">显示</div>
              <div className="settings-row">
                <span>币种</span>
                <button type="button" className="btn ghost sm" onClick={toggleCurrency}>
                  {currency === "CNY" ? "¥ CNY" : "$ USD"}
                </button>
              </div>
              <div className="settings-row">
                <span>隐藏成本</span>
                <button type="button" className="btn ghost sm" onClick={toggleHideCost}>
                  {hideCost ? "已隐藏" : "显示中"}
                </button>
              </div>
              <div className="settings-row">
                <span>汇率</span>
                <span className="muted">
                  1 USD = {fx.rate.toFixed(4)} CNY
                  {fx.live ? (fx.date ? ` · ${fx.date}` : "") : " · 离线兜底"}
                </span>
              </div>
            </section>
            <section className="card">
              <div className="card-title">账号</div>
              <p className="pad-sm">{userEmail}</p>
              <button type="button" className="btn ghost" onClick={() => void doLogout()}>
                退出登录
              </button>
            </section>
            <section className="card">
              <div className="card-title">Supabase</div>
              <label className="field">
                Project URL
                <input value={url} onChange={(e) => setUrl(e.target.value)} />
              </label>
              <label className="field">
                anon key
                <input value={anonKey} onChange={(e) => setAnonKey(e.target.value)} />
              </label>
              <button type="button" className="btn primary" onClick={() => void saveCfg()}>
                保存并需重新登录
              </button>
            </section>
            <section className="card">
              <div className="card-title">快照信息</div>
              <div className="settings-row">
                <span>会话数</span>
                <span>{snapshot?.session_count ?? sessionsAll.length}</span>
              </div>
              <div className="settings-row">
                <span>小时桶</span>
                <span>{hasHourly ? `${hourlyAll.length} 条` : "无（请桌面重新上传）"}</span>
              </div>
              <div className="settings-row">
                <span>版本</span>
                <span>{snapshot?.payload?.appVersion || "–"}</span>
              </div>
              <div className="settings-row">
                <span>设备</span>
                <span>{snapshot?.device_label || "–"}</span>
              </div>
            </section>
            <section className="card">
              <div className="card-title">说明</div>
              <p className="hint pad-sm">
                手机端只读云端快照，功能对齐桌面分析视图（趋势 / 热力图 / 按工具·项目·模型·天 /
                会话筛选）。turn 级明细仍仅桌面可读本地日志。请在电脑端上传最新数据后点刷新。
              </p>
            </section>
          </div>
        )}
      </main>

      {detail && (
        <SessionDetailSheet
          s={detail}
          currency={currency}
          rate={fx.rate}
          hideCost={hideCost}
          onClose={() => setDetail(null)}
        />
      )}

      <nav className="tabbar">
        {(
          [
            ["overview", "概览", "chart"],
            ["analyze", "分析", "grid"],
            ["sessions", "会话", "list"],
            ["settings", "设置", "gear"],
          ] as const
        ).map(([id, label, icon]) => (
          <button
            key={id}
            type="button"
            className={tab === id ? "active" : ""}
            onClick={() => pressTab(id)}
          >
            <TabIcon name={icon} />
            <span>{label}</span>
          </button>
        ))}
      </nav>
    </div>
  );
}

function TabIcon({ name }: { name: "chart" | "grid" | "list" | "gear" }) {
  const paths = {
    chart: "M4 20V11m5.5 9V4M15 20v-6m5.5 6V8",
    grid: "M4 4h6v6H4zm10 0h6v6h-6zM4 14h6v6H4zm10 0h6v6h-6z",
    list: "M4 6.5h16M4 12h16M4 17.5h10",
    gear: "M4 8h6m4 0h6M4 16h2m4 0h10M12 8a2 2 0 1 0 0.01 0M8 16a2 2 0 1 0 0.01 0",
  } as const;
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" aria-hidden>
      <path
        d={paths[name]}
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

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
  if (!values.length) return <div style={{ height: h }} />;
  const max = Math.max(1, ...values);
  const pts = values.map((v, i) => {
    const x = values.length === 1 ? w / 2 : (i / (values.length - 1)) * w;
    const y = h - 3 - (v / max) * (h - 6);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const area = `0,${h} ${pts.join(" ")} ${w},${h}`;
  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      preserveAspectRatio="none"
      width="100%"
      height={h}
      style={{ display: "block" }}
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

function AreaChart({
  points,
  max,
  color,
  fill,
}: {
  points: { label: string; value: number }[];
  max: number;
  color: string;
  fill: string;
}) {
  const w = 320;
  const h = 110;
  const padL = 4;
  const padR = 4;
  const padT = 8;
  const padB = 4;
  const innerW = w - padL - padR;
  const innerH = h - padT - padB;
  if (!points.length) return null;
  const m = Math.max(1, max);
  const coords = points.map((p, i) => {
    const x =
      padL +
      (points.length === 1 ? innerW / 2 : (i / (points.length - 1)) * innerW);
    const y = padT + innerH - (p.value / m) * innerH;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const line = coords.join(" ");
  const area = `${padL},${padT + innerH} ${line} ${padL + innerW},${padT + innerH}`;
  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      preserveAspectRatio="none"
      width="100%"
      height={h}
      style={{ display: "block" }}
    >
      <polygon points={area} fill={fill} />
      <polyline
        points={line}
        fill="none"
        stroke={color}
        strokeWidth="2"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}

function Metric({
  label,
  value,
  tone,
}: {
  label: string;
  value: ReactNode;
  tone?: "none" | "low" | "mid" | "high";
}) {
  return (
    <div className={`metric${tone && tone !== "none" ? ` hit-tone-${tone}` : ""}`}>
      <div className="m-label">{label}</div>
      <div
        className={`m-value${
          tone && tone !== "none" ? ` hit-rate hit-${tone}` : ""
        }`}
      >
        {value}
      </div>
    </div>
  );
}

function SessionItem({
  s,
  currency,
  rate,
  hideCost,
  onOpen,
}: {
  s: SessionRecord & {
    usageSource?: UsageSource;
    lifetimeTotalTokens?: number;
  };
  currency: Currency;
  rate: number;
  hideCost: boolean;
  onOpen: () => void;
}) {
  const cost = displayCost(s, currency, rate);
  const showLife = isMeaningfulLifetimeGap(
    s.totalTokens || 0,
    s.lifetimeTotalTokens
  );
  const src = s.usageSource;
  return (
    <li className="session-item clickable" onClick={onOpen}>
      <div className="s-top">
        <div className="s-badges">
          <span
            className="client-pill"
            style={{ background: CLIENT_COLORS[s.client] || "#3f3f46" }}
          >
            {clientLabel(s.client)}
          </span>
          {s.deleted && <span className="badge del">已删除</span>}
          {s.isSubagent && !s.deleted && <span className="badge orphan">未归并</span>}
          {s.childCount ? <span className="badge child">子 {s.childCount}</span> : null}
          {s.client === "opencode" && s.sessionKind === "v1" && (
            <span className="badge oc-v1" title="仅 OpenCode V1">
              V1
            </span>
          )}
          {s.client === "opencode" && s.sessionKind === "v2" && (
            <span className="badge oc-v2" title="仅 OpenCode V2">
              V2
            </span>
          )}
          {s.client === "opencode" && s.sessionKind === "migrated" && (
            <span
              className="badge oc-migrated"
              title="V1/V2 同 id · 用量只计一次"
            >
              迁移
            </span>
          )}
          {src === "lifetime-fallback" ? (
            <span
              className="usage-badge fallback"
              title="无 turn 级时间明细，数字为会话生涯全量"
            >
              {usageSourceLabel("lifetime-fallback")}
            </span>
          ) : src === "range" && showLife ? (
            <span className="usage-badge range" title="本区间用量">
              区间
            </span>
          ) : null}
        </div>
        <span className="s-time">{formatRelative(s.lastUsedAt || s.startedAt)}</span>
      </div>
      <div className="s-title">{s.title || s.sessionId || s.id}</div>
      {s.model && <div className="s-model">{s.model}</div>}
      <div className="s-stats">
        <span>
          {formatTokens(s.totalTokens || 0)}
          {showLife ? (
            <span className="lifetime-sub">
              {" "}
              · 生涯 {formatTokens(s.lifetimeTotalTokens!)}
            </span>
          ) : null}
        </span>
        <span>in {formatTokens(uncachedInputOf(s))}</span>
        <span>out {formatTokens(s.outputTokens || 0)}</span>
        {(tokensPerSec(s.genTokens, s.genMs) != null ||
          tokensPerSec(s.estGenTokens, s.estGenMs) != null) && (
          <span title="生成速度">
            {formatTokPerSec(
              tokensPerSec(s.genTokens, s.genMs),
              tokensPerSec(s.estGenTokens, s.estGenMs)
            )}
          </span>
        )}
        {s.requestCount != null && s.requestCount > 0 && (
          <span title="模型 API 请求次数">
            req {s.requestCount.toLocaleString()}
          </span>
        )}
        {s.turnCount != null && s.turnCount > 0 && (
          <span title="Turn 数">turn {s.turnCount.toLocaleString()}</span>
        )}
        {s.messageCount != null && s.messageCount > 0 && (
          <span title="消息数">msg {s.messageCount.toLocaleString()}</span>
        )}
        {(() => {
          const hit = cacheHitRate(s.inputTokens, s.cacheReadTokens, s.noCacheData);
          const overall = overallHitRate(
            uncachedInputOf(s),
            s.cacheReadTokens,
            s.estCacheReadTokens
          );
          const tone = hitRateTone(hit);
          return (
            <span className={`hit-rate hit-${tone}`}>
              命中 {formatHitRate(hit, overall)}
            </span>
          );
        })()}
        {!hideCost && cost != null && <span>{formatCost(cost, currency)}</span>}
      </div>
    </li>
  );
}

function SessionDetailSheet({
  s,
  currency,
  rate,
  hideCost,
  onClose,
}: {
  s: SessionRecord;
  currency: Currency;
  rate: number;
  hideCost: boolean;
  onClose: () => void;
}) {
  const cost = displayCost(s, currency, rate);
  return (
    <div className="sheet-overlay" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-handle" />
        <div className="sheet-head">
          <div>
            <div className="sheet-title">{s.title || s.sessionId}</div>
            <div className="sheet-sub">
              {clientLabel(s.client)}
              {s.agentName ? ` · ${s.agentName}` : ""}
              {s.deleted ? " · 已删除" : ""}
              {s.isSubagent ? " · 未归并子会话" : ""}
              {s.client === "opencode" && s.sessionKind === "v1" ? " · V1" : ""}
              {s.client === "opencode" && s.sessionKind === "v2" ? " · V2" : ""}
              {s.client === "opencode" && s.sessionKind === "migrated"
                ? " · 迁移"
                : ""}
            </div>
          </div>
          <button type="button" className="btn ghost sm" onClick={onClose}>
            关闭
          </button>
        </div>
        <div className="sheet-body">
          <div className="detail-grid">
            <DetailRow
              label="模型"
              value={s.model || "–"}
              className={
                s.model && isUnknownModel(s.model) ? "model-unknown" : undefined
              }
            />
            <DetailRow
              label="速度"
              value={formatTokPerSec(
                tokensPerSec(s.genTokens, s.genMs),
                tokensPerSec(s.estGenTokens, s.estGenMs)
              )}
            />
            <DetailRow
              label="缓存命中"
              value={formatHitRate(
                cacheHitRate(s.inputTokens, s.cacheReadTokens, s.noCacheData),
                overallHitRate(
                  uncachedInputOf(s),
                  s.cacheReadTokens,
                  s.estCacheReadTokens
                )
              )}
              className={`hit-rate hit-${hitRateTone(
                cacheHitRate(s.inputTokens, s.cacheReadTokens, s.noCacheData)
              )}`}
            />
            <DetailRow label="路径" value={s.cwd || "–"} mono />
            <DetailRow label="会话 ID" value={s.sessionId || s.id} mono />
            <DetailRow label="质量" value={qualityLabel(s.quality)} />
            <DetailRow label="开始" value={formatFull(s.startedAt)} />
            <DetailRow label="最近" value={formatFull(s.lastUsedAt)} />
            <DetailRow
              label="请求次数"
              value={
                s.requestCount != null && s.requestCount > 0
                  ? s.requestCount.toLocaleString()
                  : "–"
              }
            />
            <DetailRow label="消息数" value={String(s.messageCount ?? "–")} />
            <DetailRow label="Turn 数" value={String(s.turnCount ?? "–")} />
            {s.childCount != null && (
              <DetailRow label="子会话" value={String(s.childCount)} />
            )}
            {s.parentSessionId && (
              <DetailRow label="父会话" value={s.parentSessionId} mono />
            )}
          </div>
          <div className="metrics" style={{ marginTop: 12 }}>
            <Metric label="Total" value={formatTokens(s.totalTokens || 0)} />
            <Metric label="Input" value={formatTokens(uncachedInputOf(s))} />
            <Metric label="Output" value={formatTokens(s.outputTokens || 0)} />
            <Metric
              label="Cache R"
              value={formatCacheRead(s.cacheReadTokens, s.estCacheReadTokens)}
            />
            <Metric label="Cache W" value={formatTokens(s.cacheWriteTokens || 0)} />
            <Metric label="Reason" value={formatTokens(s.reasoningTokens || 0)} />
          </div>
          {!hideCost && (
            <div className="detail-cost">
              估算成本 {formatCost(cost, currency)}
              {s.costUsd != null && currency === "CNY" && (
                <span className="muted"> · ${s.costUsd.toFixed(3)}</span>
              )}
            </div>
          )}
          <p className="hint" style={{ marginTop: 12 }}>
            turn 级明细仅桌面端可读本地日志；手机端展示快照中的会话汇总。
          </p>
        </div>
      </div>
    </div>
  );
}

function DetailRow({
  label,
  value,
  mono,
  className,
}: {
  label: string;
  value: string;
  mono?: boolean;
  className?: string;
}) {
  return (
    <div className="detail-row">
      <span className="d-label">{label}</span>
      <span
        className={`d-value ${mono ? "mono" : ""}${className ? ` ${className}` : ""}`}
      >
        {value}
      </span>
    </div>
  );
}
