/**
 * 本地会话持久化：源日志被删后仍保留用量，并标记 deleted。
 * 存的是「并账前」的 raw 会话，下次扫描再与现场结果合并后并账。
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  computeTotalTokens,
  normalizeModelVariant,
  splitModelParts,
} from "./types.js";

const STORE_VERSION = 1;
const STORE_FILE = "sessions-store.json";

/**
 * @param {string} [dir]
 */
export function storePath(dir) {
  const base =
    dir ||
    process.env.TOKEN_STATS_CONFIG_DIR ||
    path.join(os.homedir(), ".token-stats");
  return path.join(base, STORE_FILE);
}

/**
 * @param {string} [dir]
 */
export function loadStore(dir) {
  const file = storePath(dir);
  try {
    if (!fs.existsSync(file)) {
      return { version: STORE_VERSION, updatedAt: null, sessions: {} };
    }
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    return {
      version: STORE_VERSION,
      updatedAt: raw.updatedAt || null,
      sessions:
        raw.sessions && typeof raw.sessions === "object" ? raw.sessions : {},
    };
  } catch {
    return { version: STORE_VERSION, updatedAt: null, sessions: {} };
  }
}

/**
 * @param {{ version: number, updatedAt: string|null, sessions: Record<string, any> }} store
 * @param {string} [dir]
 */
export function saveStore(store, dir) {
  const file = storePath(dir);
  const parent = path.dirname(file);
  if (!fs.existsSync(parent)) fs.mkdirSync(parent, { recursive: true });
  const payload = {
    version: STORE_VERSION,
    updatedAt: store.updatedAt,
    sessions: store.sessions,
  };
  // 原子一点：写临时文件再 rename
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(payload), "utf8");
  fs.renameSync(tmp, file);
}

/**
 * @param {{ client: string, sessionId: string }} s
 */
function sessionKey(s) {
  return `${s.client}:${s.sessionId}`;
}

/**
 * 将本次扫描的 raw 会话与本地库合并：
 * - 现场有的 → 更新并标记未删除
 * - 库里有、本轮已扫客户端下现场没有的 → 保留并标记 deleted
 * - 本轮未扫到的客户端：原样保留（避免部分扫描误删）
 * @param {import('./types.js').SessionRecord[]} liveSessions
 * @param {string} [dir]
 * @param {{ scannedClients?: Set<string> | string[] }} [opts]
 * @returns {import('./types.js').SessionRecord[]}
 */
export function reconcileWithStore(liveSessions, dir, opts = {}) {
  const store = loadStore(dir);
  const now = new Date().toISOString();
  /** @type {Map<string, import('./types.js').SessionRecord>} */
  const liveMap = new Map();
  for (const s of liveSessions) {
    liveMap.set(sessionKey(s), s);
  }

  /** @type {Set<string> | null} */
  let scannedClients = null;
  if (opts.scannedClients) {
    scannedClients = opts.scannedClients instanceof Set
      ? opts.scannedClients
      : new Set(opts.scannedClients);
  }

  // 1) 现场覆盖
  for (const [key, live] of liveMap) {
    const prev = store.sessions[key];
    store.sessions[key] = serializeStored(live, {
      firstSeenAt: prev?.firstSeenAt || now,
      lastSeenAt: now,
      deleted: false,
      deletedAt: undefined,
      synthetic: false,
    });
  }

  // 2) 本轮扫过的客户端里，现场没有的 → 标删除，保留历史
  for (const key of Object.keys(store.sessions)) {
    if (liveMap.has(key)) continue;
    const prev = store.sessions[key];
    if (scannedClients && !scannedClients.has(prev.client)) continue;
    store.sessions[key] = {
      ...prev,
      deleted: true,
      deletedAt: prev.deletedAt || now,
      lastSeenAt: prev.lastSeenAt || prev.firstSeenAt || now,
    };
  }

  store.updatedAt = now;
  saveStore(store, dir);

  return Object.values(store.sessions).map(deserializeStored);
}

/**
 * 为仍指向缺失父会话的子，补一个「已删除」父壳，便于并账。
 * @param {import('./types.js').SessionRecord[]} sessions
 * @returns {import('./types.js').SessionRecord[]}
 */
export function ensureDeletedParents(sessions) {
  /** @type {Map<string, import('./types.js').SessionRecord>} */
  const byKey = new Map();
  for (const s of sessions) {
    byKey.set(sessionKey(s), { ...s });
  }

  const now = new Date().toISOString();
  for (const s of [...byKey.values()]) {
    if (!s.parentSessionId) continue;
    const parentKey = `${s.client}:${s.parentSessionId}`;
    if (byKey.has(parentKey)) continue;

    byKey.set(parentKey, {
      id: parentKey,
      client: s.client,
      sessionId: s.parentSessionId,
      title: "已删除父会话",
      cwd: s.cwd,
      model: s.model,
      startedAt: s.startedAt,
      lastUsedAt: s.lastUsedAt,
      messageCount: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      totalTokens: 0,
      quality: "metadata_only",
      scannedAt: now,
      deleted: true,
      deletedAt: now,
      synthetic: true,
      sessionKind: "deleted_parent",
      firstSeenAt: now,
      lastSeenAt: now,
    });
  }

  return [...byKey.values()];
}

/**
 * 并账后写回：若产生了 synthetic 父，也记入 store（下次直接能挂上）。
 * @param {import('./types.js').SessionRecord[]} rawBeforeMerge 含 stub 的 raw 列表
 * @param {string} [dir]
 */
export function persistSyntheticParents(rawBeforeMerge, dir) {
  const synthetics = rawBeforeMerge.filter((s) => s.synthetic && !s.parentSessionId);
  if (!synthetics.length) return;

  const store = loadStore(dir);
  const now = new Date().toISOString();
  let changed = false;
  for (const s of synthetics) {
    const key = sessionKey(s);
    if (store.sessions[key] && !store.sessions[key].synthetic) continue;
    if (store.sessions[key]?.deleted && !store.sessions[key].synthetic) continue;
    // 只在尚无真实父快照时写入壳
    if (!store.sessions[key]) {
      store.sessions[key] = serializeStored(s, {
        firstSeenAt: now,
        lastSeenAt: now,
        deleted: true,
        deletedAt: now,
        synthetic: true,
      });
      changed = true;
    }
  }
  if (changed) {
    store.updatedAt = now;
    saveStore(store, dir);
  }
}

/**
 * @param {import('./types.js').SessionRecord} s
 * @param {{ firstSeenAt: string, lastSeenAt: string, deleted: boolean, deletedAt?: string, synthetic?: boolean }} meta
 */
function serializeStored(s, meta) {
  return {
    client: s.client,
    sessionId: s.sessionId,
    title: s.title,
    cwd: s.cwd,
    model: s.model,
    modelVariant: s.modelVariant,
    startedAt: s.startedAt,
    lastUsedAt: s.lastUsedAt,
    messageCount: s.messageCount,
    inputTokens: s.inputTokens || 0,
    outputTokens: s.outputTokens || 0,
    cacheReadTokens: s.cacheReadTokens || 0,
    cacheWriteTokens: s.cacheWriteTokens || 0,
    reasoningTokens: s.reasoningTokens || 0,
    totalTokens:
      s.totalTokens ??
      computeTotalTokens({
        inputTokens: s.inputTokens,
        outputTokens: s.outputTokens,
        cacheReadTokens: s.cacheReadTokens,
        cacheWriteTokens: s.cacheWriteTokens,
        reasoningTokens: s.reasoningTokens,
        estCacheReadTokens: s.estCacheReadTokens,
      }),
    costUsd: s.costUsd,
    costCny: s.costCny,
    quality: s.quality || "partial",
    scannedAt: s.scannedAt,
    parentSessionId: s.parentSessionId,
    isSubagent: s.isSubagent,
    agentName: s.agentName,
    sessionKind: s.sessionKind,
    turnCount: s.turnCount,
    requestCount: s.requestCount,
    noCacheData: s.noCacheData ? true : undefined,
    estCacheReadTokens: s.estCacheReadTokens || undefined,
    genMs: s.genMs || undefined,
    genTokens: s.genTokens || undefined,
    estGenMs: s.estGenMs || undefined,
    estGenTokens: s.estGenTokens || undefined,
    // 不持久化 mergedChildren / childCount（并账结果，下次重算）
    firstSeenAt: meta.firstSeenAt,
    lastSeenAt: meta.lastSeenAt,
    deleted: !!meta.deleted,
    deletedAt: meta.deleted ? meta.deletedAt || meta.lastSeenAt : undefined,
    synthetic: meta.synthetic ? true : undefined,
  };
}

/**
 * @param {any} raw
 * @returns {import('./types.js').SessionRecord}
 */
function deserializeStored(raw) {
  const client = String(raw.client || "");
  const sessionId = String(raw.sessionId || "");
  // 旧快照可能把 ` · max` 写在 model 里，读回时拆开
  const parts = splitModelParts(raw.model);
  return {
    id: `${client}:${sessionId}`,
    client,
    sessionId,
    title: raw.title || undefined,
    cwd: raw.cwd || undefined,
    model: parts.base || (raw.model ? String(raw.model) : undefined),
    modelVariant:
      parts.variant ||
      normalizeModelVariant(raw.modelVariant) ||
      undefined,
    startedAt: raw.startedAt || undefined,
    lastUsedAt: raw.lastUsedAt || undefined,
    messageCount: raw.messageCount != null ? Number(raw.messageCount) : undefined,
    inputTokens: Number(raw.inputTokens) || 0,
    outputTokens: Number(raw.outputTokens) || 0,
    cacheReadTokens: Number(raw.cacheReadTokens) || 0,
    cacheWriteTokens: Number(raw.cacheWriteTokens) || 0,
    reasoningTokens: Number(raw.reasoningTokens) || 0,
    totalTokens:
      Number(raw.totalTokens) ||
      computeTotalTokens({
        inputTokens: raw.inputTokens,
        outputTokens: raw.outputTokens,
        cacheReadTokens: raw.cacheReadTokens,
        cacheWriteTokens: raw.cacheWriteTokens,
        reasoningTokens: raw.reasoningTokens,
        estCacheReadTokens: raw.estCacheReadTokens,
      }),
    costUsd: raw.costUsd != null ? Number(raw.costUsd) : undefined,
    costCny: raw.costCny != null ? Number(raw.costCny) : undefined,
    quality: raw.quality || "partial",
    scannedAt: raw.scannedAt || raw.lastSeenAt || new Date().toISOString(),
    parentSessionId: raw.parentSessionId || undefined,
    isSubagent: raw.isSubagent ? true : undefined,
    agentName: raw.agentName || undefined,
    sessionKind: raw.sessionKind || undefined,
    turnCount: raw.turnCount != null ? Number(raw.turnCount) : undefined,
    requestCount:
      raw.requestCount != null ? Number(raw.requestCount) : undefined,
    noCacheData: raw.noCacheData ? true : undefined,
    estCacheReadTokens:
      raw.estCacheReadTokens != null && Number(raw.estCacheReadTokens) > 0
        ? Number(raw.estCacheReadTokens)
        : undefined,
    genMs:
      raw.genMs != null && Number(raw.genMs) > 0
        ? Number(raw.genMs)
        : undefined,
    genTokens:
      raw.genTokens != null && Number(raw.genTokens) > 0
        ? Number(raw.genTokens)
        : undefined,
    estGenMs:
      raw.estGenMs != null && Number(raw.estGenMs) > 0
        ? Number(raw.estGenMs)
        : undefined,
    estGenTokens:
      raw.estGenTokens != null && Number(raw.estGenTokens) > 0
        ? Number(raw.estGenTokens)
        : undefined,
    deleted: !!raw.deleted,
    deletedAt: raw.deletedAt || undefined,
    synthetic: raw.synthetic ? true : undefined,
    firstSeenAt: raw.firstSeenAt || undefined,
    lastSeenAt: raw.lastSeenAt || undefined,
  };
}
