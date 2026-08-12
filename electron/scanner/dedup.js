/**
 * 跨工具（client）会话去重 —— 保守方案。
 *
 * 设计原则：**标记而非删除**。命中重复时两条记录都保留，但只有「胜出」的一条
 * 计入总额；其余条打 `dedupExcluded` 标记，明细里给提示。全程可逆，零误杀。
 *
 * 当前为高置信度模式：仅当 **≥2 条不同 client 共享同一 sessionId**（UUID 碰撞）
 * 才判为重复。这是「铁证」，不会误伤用户合法并行开同项目的两个终端。
 *
 * 模糊匹配（cwd + 时间窗 + 模型 + token 量级）的骨架已预留（`fuzzy` 开关），
 * 默认关闭。等 P1-1 接入 wrapper 类 adapter 后，跨工具重复才会真正出现，
 * 届时按需开启，无需重写本模块。
 *
 * @module electron/scanner/dedup
 */

/**
 * client 优先级（索引越小越优先）。tie 时按此序选「胜出」条。
 * 排序依据：数据更完整的源优先。opencode/pi 会话自带成本；claude 是主力工具。
 * 调整顺序只改这里。
 */
const CLIENT_PRIORITY = ["opencode", "claude", "zcode", "grok", "kimi", "pi"];

/**
 * @typedef {{
 *   sessionId: string,
 *   keptClient: string,
 *   excludedClients: string[],
 *   reason: string,
 *   savedTotalTokens: number,
 *   savedCostUsd: number,
 * }} DedupReport
 */

/**
 * 同组内选「胜出」条：优先级序靠前；同优先级时取 totalTokens 大的（信息更全）。
 * @param {import('./types.js').SessionRecord[]} group
 * @returns {import('./types.js').SessionRecord}
 */
function pickWinner(group) {
  return group.reduce((best, s) => {
    const sa = CLIENT_PRIORITY.indexOf(best.client);
    const sb = CLIENT_PRIORITY.indexOf(s.client);
    // indexOf 返回 -1（未登记的 client）按最末处理
    const aRank = sa < 0 ? Number.MAX_SAFE_INTEGER : sa;
    const bRank = sb < 0 ? Number.MAX_SAFE_INTEGER : sb;
    if (bRank !== aRank) return bRank < aRank ? s : best;
    return s.totalTokens > best.totalTokens ? s : best;
  });
}

/**
 * 跨工具去重主入口。
 *
 * @param {import('./types.js').SessionRecord[]} sessions  并账后的会话列表
 * @param {{ fuzzy?: boolean }} [opts]  fuzzy 默认 false（仅 sessionId 碰撞）
 * @returns {{ sessions: import('./types.js').SessionRecord[], reports: DedupReport[] }}
 *   sessions 长度不变（不删除任何条），reports 供扫描详情展示
 */
export function dedupCrossClient(sessions, opts = {}) {
  const fuzzy = opts.fuzzy === true;

  // 跳过已被父子并账移除的情况：这里拿到的都是 merged 结果，sessionId 唯一性已由调用方保证
  // 1) 按裸 sessionId 分组
  /** @type {Map<string, import('./types.js').SessionRecord[]>} */
  const bySid = new Map();
  for (const s of sessions) {
    if (!s.sessionId) continue;
    const arr = bySid.get(s.sessionId) || [];
    arr.push(s);
    bySid.set(s.sessionId, arr);
  }

  /** @type {DedupReport[]} */
  const reports = [];

  // 2) 仅处理跨 client 重复组（≥2 条不同 client）
  for (const [sid, group] of bySid) {
    const clients = new Set(group.map((s) => s.client));
    if (clients.size < 2) continue;

    const winner = pickWinner(group);
    const reason = fuzzy ? "fuzzy_match" : "duplicate_session_id";

    let savedTotalTokens = 0;
    let savedCostUsd = 0;
    /** @type {string[]} */
    const excludedClients = [];

    for (const s of group) {
      if (s === winner) continue;
      s.dedupExcluded = true;
      s.dedupReason = `${reason}:${winner.client}`;
      s.dedupKeptBy = `${winner.client}:${winner.sessionId}`;
      excludedClients.push(s.client);
      savedTotalTokens += s.totalTokens || 0;
      savedCostUsd += s.costUsd || 0;
    }

    if (excludedClients.length) {
      reports.push({
        sessionId: sid,
        keptClient: winner.client,
        excludedClients,
        reason,
        savedTotalTokens,
        savedCostUsd,
      });
    }
  }

  // fuzzy 关闭时不做 cwd/时间窗匹配（预留扩展点）
  // if (fuzzy) { ... }

  return { sessions, reports };
}
