import * as opencode from "./adapters/opencode.js";
import * as claude from "./adapters/claude.js";
import * as grok from "./adapters/grok.js";
import * as kimi from "./adapters/kimi.js";
import * as zcode from "./adapters/zcode.js";
import * as pi from "./adapters/pi.js";
import * as reasonix from "./adapters/reasonix.js";
import * as mimocode from "./adapters/mimocode.js";
import { estimateCost } from "./pricing.js";
import { mergeChildSessions } from "./types.js";
import { dedupCrossClient } from "./dedup.js";
import {
  ensureDeletedParents,
  persistSyntheticParents,
  reconcileWithStore,
  storePath,
} from "./store.js";
import { createHourlyMap } from "./hourly.js";

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

  // 并账/恢复后按当前 token 重算刊例价（有模型价时覆盖旧估值）
  for (const s of merged) {
    const est = estimateCost(s);
    if (est.usd != null) s.costUsd = est.usd;
    else if (s.costUsd == null) {
      /* keep */
    }
    if (est.cny != null) s.costCny = est.cny;
  }

  merged.sort((a, b) => {
    const ta = a.lastUsedAt || a.startedAt || "";
    const tb = b.lastUsedAt || b.startedAt || "";
    return tb.localeCompare(ta);
  });

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

  const hourly = hourlyMap.toArray();
  // 小时桶按模型估成本（与会话同一价目表）——成本走势必须按 turn 发生时间分摊，
  // 不能把整段会话费用压到 lastUsedAt 那一小时。
  for (const h of hourly) {
    const est = estimateCost({
      model: h.model,
      inputTokens: h.inputTokens || 0,
      outputTokens: h.outputTokens || 0,
      cacheReadTokens: h.cacheReadTokens || 0,
      cacheWriteTokens: h.cacheWriteTokens || 0,
      reasoningTokens: h.reasoningTokens || 0,
    });
    if (est.usd != null) h.costUsd = est.usd;
    if (est.cny != null) h.costCny = est.cny;
  }

  return {
    scannedAt: new Date().toISOString(),
    durationMs: Date.now() - started,
    reports,
    totals,
    dedupReports,
    sessions: merged,
    /** 按 turn 真实时间的小时桶（本地时区），用于趋势图，非整会话 lastUsedAt */
    hourly,
    storePath: persist ? storePath(storeDir) : undefined,
    liveCount: liveSessions.length,
    persistedCount: raw.length,
  };
}
