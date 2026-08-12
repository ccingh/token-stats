import type { HourlyBucket, SessionRecord } from "./types";

export type LifetimeInsights = {
  firstDay: string | null;
  lastDay: string | null;
  calendarSpanDays: number;
  activeDays: number;
  lifetimeTokens: number;
  lifetimeSessions: number;
  peakDay: { day: string; tokens: number } | null;
  peakSession: SessionRecord | null;
  currentStreak: number;
  longestStreak: number;
  busiestHour: { hour: number; tokens: number } | null;
  topClient: { id: string; tokens: number; pct: number } | null;
  topModel: { model: string; tokens: number; pct: number } | null;
  topProject: { cwd: string; label: string; tokens: number } | null;
  avgActiveDay: number;
  todayTokens: number;
  topDays: { day: string; tokens: number }[];
  /** Mon=0 … Sun=6 */
  weekdayTotals: number[];
  composition: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    reasoning: number;
  };
};

function localDayKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function sessionDate(s: SessionRecord): string | undefined {
  return s.lastUsedAt || s.startedAt;
}

function dayKeyFromIso(iso: string): string | null {
  const d = parseFlexibleDate(iso);
  if (!d) return null;
  return localDayKey(d);
}

/** 与 scanner 一致：秒级 Unix / 纯数字串 不能直接 new Date */
function parseFlexibleDate(v: string | number | Date | null | undefined): Date | null {
  if (v == null || v === "") return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;
  if (typeof v === "number") {
    if (!Number.isFinite(v) || v <= 0) return null;
    const ms = Math.abs(v) < 1e11 ? v * 1000 : v;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const s = String(v).trim();
  if (!s) return null;
  if (/^\d+(\.\d+)?$/.test(s)) {
    const n = Number(s);
    if (!Number.isFinite(n) || n <= 0) return null;
    const ms = Math.abs(n) < 1e11 ? n * 1000 : n;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** 过滤 1970 等脏桶（秒被当毫秒写入后的残留） */
function isPlausibleDay(day: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return false;
  const y = Number(day.slice(0, 4));
  const maxY = new Date().getFullYear() + 1;
  return y >= 2015 && y <= maxY;
}

function projectLabel(cwd: string): string {
  if (!cwd || cwd === "未知目录" || cwd === "（未知目录）" || cwd === "未归属项目" || cwd === "（未归属项目）")
    return "未知项目";
  return cwd.split(/[\\/]/).filter(Boolean).pop() || cwd;
}

function parseDay(key: string): Date {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y, m - 1, d);
}

function addDays(key: string, n: number): string {
  const d = parseDay(key);
  d.setDate(d.getDate() + n);
  return localDayKey(d);
}

function dayDiff(a: string, b: string): number {
  const ms = parseDay(b).getTime() - parseDay(a).getTime();
  return Math.round(ms / 86_400_000);
}

function isCountable(s: SessionRecord): boolean {
  if ((s as { dedupExcluded?: boolean }).dedupExcluded) return false;
  if (s.isSubagent && !s.deleted) return false;
  return true;
}

/**
 * 全量生涯洞察（不受时间范围筛选）。
 * 优先用 hourly 聚合「按日 / 按小时」；会话负责峰值会话、工具/模型/项目。
 */
export function computeLifetimeInsights(
  sessions: SessionRecord[],
  hourly: HourlyBucket[] | undefined
): LifetimeInsights {
  const usable = sessions.filter(isCountable);
  const byDay = new Map<string, number>();
  const byHour = new Map<number, number>();

  if (hourly?.length) {
    for (const row of hourly) {
      const tok = row.totalTokens || 0;
      if (tok <= 0) continue;
      const day = row.hour.slice(0, 10);
      if (!isPlausibleDay(day)) continue;
      byDay.set(day, (byDay.get(day) || 0) + tok);
      const hh = Number(row.hour.slice(11, 13));
      if (Number.isFinite(hh) && hh >= 0 && hh <= 23) {
        byHour.set(hh, (byHour.get(hh) || 0) + tok);
      }
    }
  } else {
    for (const s of usable) {
      const iso = sessionDate(s);
      if (!iso) continue;
      const tok = s.totalTokens || 0;
      if (tok <= 0) continue;
      const day = dayKeyFromIso(iso);
      if (!day || !isPlausibleDay(day)) continue;
      byDay.set(day, (byDay.get(day) || 0) + tok);
      const d = parseFlexibleDate(iso);
      if (d) byHour.set(d.getHours(), (byHour.get(d.getHours()) || 0) + tok);
    }
  }

  const activeDayKeys = [...byDay.entries()]
    .filter(([, t]) => t > 0)
    .map(([k]) => k)
    .sort();

  let peakDay: LifetimeInsights["peakDay"] = null;
  for (const [day, tokens] of byDay) {
    if (!peakDay || tokens > peakDay.tokens) peakDay = { day, tokens };
  }

  let peakSession: SessionRecord | null = null;
  for (const s of usable) {
    const t = s.totalTokens || 0;
    if (t <= 0) continue;
    if (!peakSession || t > (peakSession.totalTokens || 0)) peakSession = s;
  }

  let longestStreak = 0;
  let run = 0;
  let prev: string | null = null;
  for (const day of activeDayKeys) {
    if (prev && dayDiff(prev, day) === 1) run += 1;
    else run = 1;
    longestStreak = Math.max(longestStreak, run);
    prev = day;
  }

  const today = localDayKey(new Date());
  let currentStreak = 0;
  if (activeDayKeys.length) {
    const activeSet = new Set(activeDayKeys);
    let cursor = activeSet.has(today) ? today : addDays(today, -1);
    while (activeSet.has(cursor)) {
      currentStreak += 1;
      cursor = addDays(cursor, -1);
    }
  }

  let busiestHour: LifetimeInsights["busiestHour"] = null;
  for (const [hour, tokens] of byHour) {
    if (!busiestHour || tokens > busiestHour.tokens) {
      busiestHour = { hour, tokens };
    }
  }

  let lifetimeTokens = 0;
  let lifetimeSessions = 0;
  const clientMap = new Map<string, number>();
  const modelMap = new Map<string, number>();
  const projectMap = new Map<string, number>();
  const composition = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    reasoning: 0,
  };

  for (const s of usable) {
    const t = s.totalTokens || 0;
    if (t <= 0 && (s.inputTokens || 0) <= 0 && (s.outputTokens || 0) <= 0) continue;
    lifetimeSessions += 1;
    lifetimeTokens += t;
    composition.input += s.inputTokens || 0;
    composition.output += s.outputTokens || 0;
    composition.cacheRead += s.cacheReadTokens || 0;
    composition.cacheWrite += s.cacheWriteTokens || 0;
    composition.reasoning += s.reasoningTokens || 0;
    clientMap.set(s.client, (clientMap.get(s.client) || 0) + t);
    const model = s.model || "未知模型";
    modelMap.set(model, (modelMap.get(model) || 0) + t);
    const cwd = s.cwd || "未知目录";
    projectMap.set(cwd, (projectMap.get(cwd) || 0) + t);
  }

  if (hourly?.length) {
    const sumDays = [...byDay.values()].reduce((a, b) => a + b, 0);
    if (sumDays > 0) lifetimeTokens = sumDays;
  }

  function topOf(map: Map<string, number>): { key: string; tokens: number; pct: number } | null {
    let best: { key: string; tokens: number } | null = null;
    for (const [key, tokens] of map) {
      if (!best || tokens > best.tokens) best = { key, tokens };
    }
    if (!best || lifetimeTokens <= 0) return null;
    return {
      key: best.key,
      tokens: best.tokens,
      pct: Math.round((best.tokens / lifetimeTokens) * 100),
    };
  }

  const tc = topOf(clientMap);
  const tm = topOf(modelMap);
  const tp = topOf(projectMap);

  const topDays = [...byDay.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([day, tokens]) => ({ day, tokens }));

  const weekdayTotals = [0, 0, 0, 0, 0, 0, 0];
  for (const [day, tokens] of byDay) {
    const js = parseDay(day).getDay();
    const mon = (js + 6) % 7;
    weekdayTotals[mon] += tokens;
  }

  const firstDay = activeDayKeys[0] || null;
  const lastDay = activeDayKeys[activeDayKeys.length - 1] || null;
  const calendarSpanDays =
    firstDay && lastDay ? dayDiff(firstDay, lastDay) + 1 : 0;
  const activeDays = activeDayKeys.length;
  const avgActiveDay = activeDays > 0 ? lifetimeTokens / activeDays : 0;
  const todayTokens = byDay.get(today) || 0;

  return {
    firstDay,
    lastDay,
    calendarSpanDays,
    activeDays,
    lifetimeTokens,
    lifetimeSessions,
    peakDay,
    peakSession,
    currentStreak,
    longestStreak,
    busiestHour,
    topClient: tc
      ? { id: tc.key, tokens: tc.tokens, pct: tc.pct }
      : null,
    topModel: tm
      ? { model: tm.key, tokens: tm.tokens, pct: tm.pct }
      : null,
    topProject: tp
      ? {
          cwd: tp.key,
          label: projectLabel(tp.key),
          tokens: tp.tokens,
        }
      : null,
    avgActiveDay,
    todayTokens,
    topDays,
    weekdayTotals,
    composition,
  };
}

export function formatHourRange(hour: number): string {
  const h = ((hour % 24) + 24) % 24;
  const next = (h + 1) % 24;
  return `${String(h).padStart(2, "0")}:00–${String(next).padStart(2, "0")}:00`;
}

export function weekdayNameMonFirst(i: number): string {
  return ["一", "二", "三", "四", "五", "六", "日"][i] || "";
}
