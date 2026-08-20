import * as opencode from "./adapters/opencode.js";
import * as claude from "./adapters/claude.js";
import * as grok from "./adapters/grok.js";
import * as kimi from "./adapters/kimi.js";
import * as zcode from "./adapters/zcode.js";
import * as pi from "./adapters/pi.js";
import * as reasonix from "./adapters/reasonix.js";
import * as mimocode from "./adapters/mimocode.js";
import * as codex from "./adapters/codex.js";
import * as dsh from "./adapters/dsh.js";
import * as freebuff from "./adapters/freebuff.js";
import {
  applyPriceOverrides,
  collectUnpricedModels,
  estimateCost,
  getBuiltinKeys,
} from "./pricing.js";
import { loadPriceOverrides } from "./pricing-overrides.js";
import { mergeChildSessions } from "./types.js";
import { dedupCrossClient } from "./dedup.js";
import {
  ensureDeletedParents,
  persistSyntheticParents,
  reconcileWithStore,
  storePath,
} from "./store.js";
import { createHourlyMap } from "./hourly.js";

/**
 * 把父会话 + 已并入子会话的逐请求成本加起来。
 * @param {import('./types.js').SessionRecord} s
 * @param {Map<string, {
 *   usd: number,
 *   cny: number,
 *   requests: number,
 *   longContextRequests: number,
 *   tokens: number,
 *   genMs: number,
 *   genTokens: number,
 *   estGenMs: number,
 *   estGenTokens: number,
 *   hasUsd: boolean,
 *   hasCny: boolean,
 * }>} accMap
 */
function sumSessionAcc(s, accMap) {
  if (!accMap || accMap.size === 0) return null;
  const ids = [s.sessionId, ...(s.mergedChildren || [])];
  let usd = 0;
  let cny = 0;
  let requests = 0;
  let longContextRequests = 0;
  let tokens = 0;
  let genMs = 0;
  let genTokens = 0;
  let estGenMs = 0;
  let estGenTokens = 0;
  let hasUsd = false;
  let hasCny = false;
  let hit = false;
  for (const id of ids) {
    const c = accMap.get(`${s.client}:${id}`);
    if (!c) continue;
    hit = true;
    usd += c.usd || 0;
    cny += c.cny || 0;
    requests += c.requests || 0;
    longContextRequests += c.longContextRequests || 0;
    tokens += c.tokens || 0;
    genMs += c.genMs || 0;
    genTokens += c.genTokens || 0;
    estGenMs += c.estGenMs || 0;
    estGenTokens += c.estGenTokens || 0;
    if (c.hasUsd) hasUsd = true;
    if (c.hasCny) hasCny = true;
  }
  if (!hit) return null;
  return {
    usd,
    cny,
    requests,
    longContextRequests,
    tokens,
    genMs,
    genTokens,
    estGenMs,
    estGenTokens,
    hasUsd,
    hasCny,
  };
}

/** @type {Array<{ id: string, displayName: string, detect: () => boolean, scan: (ctx?: any) => Promise<any[]> | any[] }>} */
export const adapters = [
  opencode,
  claude,
  grok,
  kimi,
  zcode,
  pi,
  reasonix,
  mimocode,
  codex,
  dsh,
  freebuff,
];

/**
 * @param {{ clients?: string[], storeDir?: string, persist?: boolean }} [opts]
 *   persist 默认 true：把扫描结果写入本地库，源删除后仍保留并标 deleted
 */
export async function scanAll(opts = {}) {
  const wanted = opts.clients?.length
    ? new Set(opts.clients.map((c) => c.toLowerCase()))
    : null;
  const persist = opts.persist !== false;
  const storeDir = opts.storeDir;

  const loadedPrices = loadPriceOverrides(storeDir, {
    builtinKeys: getBuiltinKeys(),
  });
  applyPriceOverrides(loadedPrices.overrides);

  const started = Date.now();
  /** @type {import('./types.js').SessionRecord[]} */
  const liveSessions = [];
  /** @type {{ id: string, displayName: string, detected: boolean, count: number, error?: string, ms: number }[]} */
  const reports = [];
  const hourlyMap = createHourlyMap();

  for (const adapter of adapters) {
    if (wanted && !wanted.has(adapter.id)) continue;
    const t0 = Date.now();
    const detected = (() => {
      try {
        return adapter.detect();
      } catch {
        return false;
      }
    })();

    if (!detected) {
      reports.push({
        id: adapter.id,
        displayName: adapter.displayName,
        detected: false,
        count: 0,
        ms: Date.now() - t0,
      });
      continue;
    }

    try {
      const rows = await Promise.resolve(adapter.scan({ hourly: hourlyMap }));
      liveSessions.push(...rows);
      reports.push({
        id: adapter.id,
        displayName: adapter.displayName,
        detected: true,
        count: rows.length,
        ms: Date.now() - t0,
      });
    } catch (err) {
      reports.push({
        id: adapter.id,
        displayName: adapter.displayName,
        detected: true,
        count: 0,
        error: err instanceof Error ? err.message : String(err),
        ms: Date.now() - t0,
      });
    }
  }

  // 本轮实际跑过的适配器（含 detected=false 的也算「扫过」：该客户端本机无数据）
  const scannedClients = new Set(
    reports.filter((r) => wanted == null || wanted.has(r.id)).map((r) => r.id)
  );

  // 1) 与本地库合并：现场更新；源已删的保留并标 deleted
  let raw = persist
    ? reconcileWithStore(liveSessions, storeDir, { scannedClients })
    : liveSessions.map((s) => ({ ...s, deleted: false }));

  // 2) 子还在、父从未入库：补已删除父壳
  raw = ensureDeletedParents(raw);
  if (persist) persistSyntheticParents(raw, storeDir);

  // 3) 父子并账（deleted 父可接收 live 子）
  const merged = mergeChildSessions(raw);

  // 4) 跨工具去重（保守：仅 sessionId 碰撞，零误杀）
  //    标记而非删除——两条都保留，被排除条打 dedupExcluded，总额只算胜出条
  const { reports: dedupReports } = dedupCrossClient(merged);

  merged.sort((a, b) => {
    const ta = a.lastUsedAt || a.startedAt || "";
    const tb = b.lastUsedAt || b.startedAt || "";
    return tb.localeCompare(ta);
  });

  // 全局再保底一次：任意适配器 pending 的 sessionId → 会话 model
  if (typeof hourlyMap.resolveSessionModels === "function") {
    /** @type {Map<string, string>} */
    const sessionModels = new Map();
    for (const s of liveSessions) {
      if (s.model) sessionModels.set(`${s.client}:${s.sessionId}`, s.model);
    }
    // 并账后的父也可能带 model；用 merged 再补一轮
    for (const s of merged) {
      if (s.model) sessionModels.set(`${s.client}:${s.sessionId}`, s.model);
    }
    hourlyMap.resolveSessionModels(sessionModels);
  }

  // 先 resolve 小时桶模型，再按「每次请求」累计成本（Grok 长档等阶梯价）
  const sessionCosts =
    typeof hourlyMap.getSessionCosts === "function"
      ? hourlyMap.getSessionCosts()
      : new Map();
  for (const s of merged) {
    const acc = sumSessionAcc(s, sessionCosts);
    // Freebuff 全系免费，模型名（deepseek-v4-flash 等）不要套刊例
    if (s.client === "freebuff") {
      s.costUsd = 0;
      s.costCny = 0;
    } else {
      const want = Number(s.requestCount) || 0;
      const covered = acc && (want <= 0 || acc.requests + 0.5 >= want * 0.8);
      if (acc && covered && (acc.hasUsd || acc.hasCny)) {
        s.costUsd = acc.hasUsd ? acc.usd : undefined;
        s.costCny = acc.hasCny ? acc.cny : undefined;
        if (acc.longContextRequests > 0) {
          s.longContextRequests = acc.longContextRequests;
        }
      } else {
        const est = estimateCost(s);
        if (est.usd != null) s.costUsd = est.usd;
        else s.costUsd = undefined;
        if (est.cny != null) s.costCny = est.cny;
        else s.costCny = undefined;
      }
    }
    if (acc && acc.genMs > 0 && acc.genTokens > 0) {
      s.genMs = acc.genMs;
      s.genTokens = acc.genTokens;
    }
    if (acc && acc.estGenMs > 0 && acc.estGenTokens > 0) {
      s.estGenMs = acc.estGenMs;
      s.estGenTokens = acc.estGenTokens;
    }
  }

  const hourly = hourlyMap.toArray();
  // 小时桶已在 add() 时按单次请求选档；缺价的桶再用汇总估（多请求走基础档）
  for (const h of hourly) {
    if (h.client === "freebuff") {
      h.costUsd = 0;
      h.costCny = 0;
      continue;
    }
    if (h.costUsd != null || h.costCny != null) continue;
    const est = estimateCost({
      model: h.model,
      inputTokens: h.inputTokens || 0,
      outputTokens: h.outputTokens || 0,
      cacheReadTokens: h.cacheReadTokens || 0,
      cacheWriteTokens: h.cacheWriteTokens || 0,
      reasoningTokens: h.reasoningTokens || 0,
      requestCount: h.events,
      singleRequest: (h.events || 0) === 1,
    });
    if (est.usd != null) h.costUsd = est.usd;
    else h.costUsd = undefined;
    if (est.cny != null) h.costCny = est.cny;
    else h.costCny = undefined;
  }

  const totals = merged.reduce(
    (acc, s) => {
      // 被跨工具去重排除的条不计入总额（仍保留在会话表与明细里）
      if (s.dedupExcluded) return acc;
      acc.sessions += 1;
      acc.inputTokens += s.inputTokens;
      acc.outputTokens += s.outputTokens;
      acc.cacheReadTokens += s.cacheReadTokens;
      acc.cacheWriteTokens += s.cacheWriteTokens;
      acc.reasoningTokens += s.reasoningTokens;
      acc.totalTokens += s.totalTokens;
      acc.costUsd += s.costUsd || 0;
      acc.requestCount += s.requestCount || 0;
      if (s.deleted) acc.deletedSessions += 1;
      return acc;
    },
    {
      sessions: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      totalTokens: 0,
      costUsd: 0,
      requestCount: 0,
      deletedSessions: 0,
    }
  );

  const unpricedModels = collectUnpricedModels(merged);

  return {
    scannedAt: new Date().toISOString(),
    durationMs: Date.now() - started,
    reports,
    totals,
    dedupReports,
    unpricedModels,
    pricingLoadError: loadedPrices.error || undefined,
    sessions: merged,
    /** 按 turn 真实时间的小时桶（本地时区），用于趋势图，非整会话 lastUsedAt */
    hourly,
    storePath: persist ? storePath(storeDir) : undefined,
    liveCount: liveSessions.length,
    persistedCount: raw.length,
  };
}
