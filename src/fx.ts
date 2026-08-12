/**
 * USD→CNY 实时汇率获取。
 *
 * - 主源 frankfurter.dev（欧洲央行汇率，每日更新），备源 open.er-api.com
 * - localStorage 缓存 6 小时，避免每次启动都请求
 * - 全部失败时回退到缓存的旧值，再不行用兜底常量并在 UI 标注非实时
 */

export interface FxRate {
  rate: number;
  /** 汇率日期（源数据的生效日期，如 2026-08-07），无则为空串 */
  date: string;
  /** true = 实时/缓存的在线汇率；false = 兜底常量 */
  live: boolean;
}

const CACHE_KEY = "token-stats:usd-cny";
const CACHE_TTL = 6 * 3600_000;
const FALLBACK_RATE = 7.2;

interface CacheEntry {
  rate: number;
  date: string;
  fetchedAt: number;
}

function readCache(): CacheEntry | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const c = JSON.parse(raw) as CacheEntry;
    return typeof c.rate === "number" && c.rate > 0 ? c : null;
  } catch {
    return null;
  }
}

function writeCache(rate: number, date: string) {
  try {
    localStorage.setItem(
      CACHE_KEY,
      JSON.stringify({ rate, date, fetchedAt: Date.now() } satisfies CacheEntry)
    );
  } catch {
    /* 隐私模式等场景忽略 */
  }
}

async function fetchFrankfurter(): Promise<{ rate: number; date: string } | null> {
  const res = await fetch("https://api.frankfurter.dev/v1/latest?base=USD&symbols=CNY");
  if (!res.ok) return null;
  const j = await res.json();
  const rate = j?.rates?.CNY;
  return typeof rate === "number" && rate > 0 ? { rate, date: j.date ?? "" } : null;
}

async function fetchErApi(): Promise<{ rate: number; date: string } | null> {
  const res = await fetch("https://open.er-api.com/v6/latest/USD");
  if (!res.ok) return null;
  const j = await res.json();
  const rate = j?.rates?.CNY;
  if (typeof rate !== "number" || rate <= 0) return null;
  const ts = j.time_last_update_unix;
  const date = ts ? new Date(ts * 1000).toISOString().slice(0, 10) : "";
  return { rate, date };
}

export async function getUsdCny(): Promise<FxRate> {
  const cached = readCache();
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL) {
    return { rate: cached.rate, date: cached.date, live: true };
  }

  for (const fetcher of [fetchFrankfurter, fetchErApi]) {
    try {
      const r = await fetcher();
      if (r) {
        writeCache(r.rate, r.date);
        return { rate: r.rate, date: r.date, live: true };
      }
    } catch {
      /* 尝试下一个源 */
    }
  }

  // 网络失败：有过期缓存就用过期缓存（仍是真实汇率，只是旧）
  if (cached) return { rate: cached.rate, date: cached.date, live: true };
  return { rate: FALLBACK_RATE, date: "", live: false };
}
