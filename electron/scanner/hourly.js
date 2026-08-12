/**
 * 按本地时区小时桶累计用量（对齐 Tokscale Hourly：按 turn/推理时间，非整会话 lastUsedAt）。
 * 维度：client + hour + model（便于趋势图按工具 / 按模型堆叠）。
 *
 * 无 turn 级 model 时：可带 sessionId 暂存，扫描结束后用会话级 model 保底回填。
 */
import {
  computeTotalTokens,
  modelAggKey,
  normalizeModelName,
} from "./types.js";

const UNKNOWN = "未知模型";

/**
 * 把各类时间戳规范成 Date。
 * 常见坑：适配器传入 **秒** 级 Unix（~1e9），`new Date(n)` 会当成毫秒 → 落在 1970。
 * 规则：数字 / 纯数字串 < 1e11 视为秒；否则视为毫秒；ISO 字符串原样解析。
 * @param {string | number | Date | null | undefined} v
 * @returns {Date | null}
 */
export function parseTs(v) {
  if (v == null || v === "") return null;
  if (v instanceof Date) {
    return Number.isNaN(v.getTime()) ? null : v;
  }
  if (typeof v === "number") {
    if (!Number.isFinite(v) || v <= 0) return null;
    const ms = Math.abs(v) < 1e11 ? v * 1000 : v;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  if (typeof v === "string") {
    const s = v.trim();
    if (!s) return null;
    // 纯数字串：同样按秒/毫秒阈值
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
  return null;
}

/**
 * @param {string | number | Date | null | undefined} iso
 * @returns {string | null} `YYYY-MM-DDTHH` 本地时
 */
export function hourKeyFromTs(iso) {
  const d = parseTs(iso);
  if (!d) return null;
  const y = d.getFullYear();
  // 过滤明显错误（秒当毫秒、脏数据）
  if (y < 2015 || y > 2100) return null;
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  const h = String(d.getHours()).padStart(2, "0");
  return `${y}-${m}-${day}T${h}`;
}

/**
 * @param {string} hourKey `YYYY-MM-DDTHH`
 */
export function dayKeyFromHour(hourKey) {
  return hourKey.slice(0, 10);
}

/**
 * @param {string} hourKey
 */
export function hourLabel(hourKey) {
  return `${hourKey.slice(11)}:00`;
}

/**
 * 小时桶只按模型主名（思考档位不进 key）。
 * @param {unknown} m
 */
function normModel(m) {
  return modelAggKey(m) || normalizeModelName(m) || UNKNOWN;
}

/**
 * 仅当 turn 无模型时用会话级主名兜底。
 * @param {string} turnModel
 * @param {string | undefined} sessionModel
 */
export function preferSessionModel(turnModel, sessionModel) {
  if (!turnModel || turnModel === UNKNOWN) {
    return sessionModel ? normModel(sessionModel) : UNKNOWN;
  }
  return normModel(turnModel);
}

/**
 * @returns {{
 *   add: (client: string, ts: any, parts: object) => void,
 *   resolveSessionModels: (sessionModels: Map<string, string> | Record<string, string>) => void,
 *   toArray: () => import('./types.js').HourlyBucket[],
 * }}
 */
export function createHourlyMap() {
  /** @type {Map<string, {
   *   hour: string,
   *   client: string,
   *   model: string,
   *   sessionId?: string,
   *   inputTokens: number,
   *   outputTokens: number,
   *   cacheReadTokens: number,
   *   cacheWriteTokens: number,
   *   reasoningTokens: number,
   *   totalTokens: number,
   *   events: number,
   * }>} */
  const map = new Map();

  /**
   * turn 无 model、但有 sessionId：等会话扫完再落桶
   * @type {{ client: string, sessionId: string, ts: any, parts: object }[]}
   */
  const pending = [];

  /**
   * @param {string} client
   * @param {any} ts
   * @param {{
   *   inputTokens?: number,
   *   outputTokens?: number,
   *   cacheReadTokens?: number,
   *   cacheWriteTokens?: number,
   *   reasoningTokens?: number,
   *   totalTokens?: number,
   *   model?: string,
   *   sessionId?: string,
   *   requestCount?: number  本批模型请求次数，默认 1（Grok turn 可传 modelCalls）
   * }} parts
   */
  function commit(client, ts, parts) {
    const hour = hourKeyFromTs(ts);
    if (!hour || !client) return;
    const model = normModel(parts.model);
    // 保留 sessionId 维度，便于「7 天」只算区间内用量（跨周同一会话可拆）
    const sid =
      parts.sessionId != null && String(parts.sessionId).trim()
        ? String(parts.sessionId).trim()
        : "";
    const key = `${client}|${hour}|${model}|${sid}`;
    let cur = map.get(key);
    if (!cur) {
      cur = {
        hour,
        client,
        model,
        sessionId: sid || undefined,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
        totalTokens: 0,
        events: 0,
      };
      map.set(key, cur);
    }
    const input = Number(parts.inputTokens) || 0;
    const output = Number(parts.outputTokens) || 0;
    const cacheRead = Number(parts.cacheReadTokens) || 0;
    const cacheWrite = Number(parts.cacheWriteTokens) || 0;
    const reasoning = Number(parts.reasoningTokens) || 0;
    cur.inputTokens += input;
    cur.outputTokens += output;
    cur.cacheReadTokens += cacheRead;
    cur.cacheWriteTokens += cacheWrite;
    cur.reasoningTokens += reasoning;
    if (parts.totalTokens != null && Number.isFinite(Number(parts.totalTokens))) {
      cur.totalTokens += Number(parts.totalTokens);
    } else {
      cur.totalTokens += computeTotalTokens({
        inputTokens: input,
        outputTokens: output,
        cacheReadTokens: cacheRead,
        cacheWriteTokens: cacheWrite,
        reasoningTokens: reasoning,
      });
    }
    const reqs = Number(parts.requestCount);
    cur.events += Number.isFinite(reqs) && reqs > 0 ? reqs : 1;
  }

  /**
   * 仅重键「未知模型」桶：用会话级 model 补全。
   * 已有裸 id / · high / · max 的桶不动。
   * @param {(k: string) => string | undefined} get
   */
  function remapCommittedBySessionModel(get) {
    if (map.size === 0) return;
    const prev = [...map.values()];
    let need = false;
    for (const e of prev) {
      if (e.model === UNKNOWN && e.sessionId) {
        need = true;
        break;
      }
    }
    if (!need) return;

    map.clear();
    for (const e of prev) {
      const sid = e.sessionId ? String(e.sessionId) : "";
      let model = e.model;
      if (sid && model === UNKNOWN) {
        const sm = get(`${e.client}:${sid}`);
        if (sm) model = preferSessionModel(UNKNOWN, sm);
      }
      const key = `${e.client}|${e.hour}|${model}|${sid}`;
      let cur = map.get(key);
      if (!cur) {
        cur = {
          hour: e.hour,
          client: e.client,
          model,
          sessionId: sid || undefined,
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          reasoningTokens: 0,
          totalTokens: 0,
          events: 0,
        };
        map.set(key, cur);
      }
      cur.inputTokens += e.inputTokens || 0;
      cur.outputTokens += e.outputTokens || 0;
      cur.cacheReadTokens += e.cacheReadTokens || 0;
      cur.cacheWriteTokens += e.cacheWriteTokens || 0;
      cur.reasoningTokens += e.reasoningTokens || 0;
      cur.totalTokens += e.totalTokens || 0;
      cur.events += e.events || 0;
    }
  }

  return {
    /**
     * @param {string} client
     * @param {any} ts
     * @param {{
     *   inputTokens?: number,
     *   outputTokens?: number,
     *   cacheReadTokens?: number,
     *   cacheWriteTokens?: number,
     *   reasoningTokens?: number,
     *   totalTokens?: number,
     *   model?: string,
     *   sessionId?: string,
     * }} parts
     */
    add(client, ts, parts = {}) {
      const model = normModel(parts.model);
      const sid = parts.sessionId != null ? String(parts.sessionId).trim() : "";
      // 无 turn 级模型、但有会话 id → 暂存，会话级保底
      if (model === UNKNOWN && sid) {
        pending.push({
          client,
          sessionId: sid,
          ts,
          parts: { ...parts, sessionId: undefined },
        });
        return;
      }
      commit(client, ts, parts);
    },

    /**
     * 用会话级 model 回填「完全没有 model」的 pending turns。
     * 不改写已有 turn 模型（含裸 modelID）——档位以 turn 为准。
     * @param {Map<string, string> | Record<string, string>} sessionModels
     */
    resolveSessionModels(sessionModels) {
      const get =
        sessionModels instanceof Map
          ? (k) => sessionModels.get(k)
          : (k) => sessionModels[k];

      for (const item of pending) {
        const key = `${item.client}:${item.sessionId}`;
        const sessionModel = get(key);
        commit(item.client, item.ts, {
          ...item.parts,
          model: preferSessionModel(
            normModel(item.parts.model),
            sessionModel
          ),
          sessionId: item.sessionId,
        });
      }
      pending.length = 0;

      // 仅把 model=未知 的已落桶条目用会话级补全（不覆盖裸 id / · high / · max）
      remapCommittedBySessionModel(get);
    },

    toArray() {
      // 未 resolve 的 pending 也尽量输出未知模型，避免丢数
      if (pending.length) {
        for (const item of pending) {
          commit(item.client, item.ts, {
            ...item.parts,
            sessionId: item.sessionId,
          });
        }
        pending.length = 0;
      }
      return [...map.values()].sort((a, b) => {
        if (a.hour !== b.hour) return a.hour.localeCompare(b.hour);
        if (a.client !== b.client) return a.client.localeCompare(b.client);
        if (a.model !== b.model) return a.model.localeCompare(b.model);
        return (a.sessionId || "").localeCompare(b.sessionId || "");
      });
    },
  };
}
