/**
 * USD→CNY 实时汇率（与桌面端同源）。
 */
export interface FxRate {
  rate: number;
  date: string;
  live: boolean;
}

const CACHE_KEY = "token-stats-mobile:usd-cny";
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
    /* ignore */
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
      /* next */
    }
  }

  if (cached) return { rate: cached.rate, date: cached.date, live: true };
  return { rate: FALLBACK_RATE, date: "", live: false };
}
