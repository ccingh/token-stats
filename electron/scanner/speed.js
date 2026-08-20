/**
 * Token 速度：生成 token / 模型请求耗时。
 *
 * 只认「这一次模型调用」的墙钟（含 TTFT），不含工具执行、用户发呆。
 * 没有耗时的请求不进分母，也不拿会话 startedAt→lastUsedAt 硬除。
 */

export const GEN_MS_MIN = 50;
/** 官方墙钟上限：长思考 / 慢通道可到一两小时。再长当挂起丢掉。 */
export const GEN_MS_MAX = 3 * 60 * 60 * 1000;
/** 估算（Grok events 间隙等）单段再收紧一点，避免把等人算进去 */
export const EST_GEN_MS_MAX = 60 * 60 * 1000;

/**
 * @param {unknown} ms
 * @param {{ max?: number }} [opts]
 * @returns {number} 合法毫秒，否则 0
 */
export function sanitizeGenMs(ms, opts = {}) {
  const n = Number(ms);
  const max = opts.max != null ? opts.max : GEN_MS_MAX;
  if (!Number.isFinite(n) || n < GEN_MS_MIN || n > max) return 0;
  return Math.round(n);
}

/**
 * 参与速度的生成量：可见输出 + 思考。
 * @param {{ outputTokens?: number, reasoningTokens?: number }} parts
 */
export function genTokensOf(parts) {
  return (
    Math.max(0, Number(parts?.outputTokens) || 0) +
    Math.max(0, Number(parts?.reasoningTokens) || 0)
  );
}

/**
 * @param {unknown} v
 * @returns {number} unix ms，失败 0
 */
export function toUnixMs(v) {
  if (v == null || v === "") return 0;
  if (v instanceof Date) {
    const t = v.getTime();
    return Number.isNaN(t) ? 0 : t;
  }
  if (typeof v === "number") {
    if (!Number.isFinite(v) || v <= 0) return 0;
    return Math.abs(v) < 1e11 ? v * 1000 : v;
  }
  const s = String(v).trim();
  if (!s) return 0;
  if (/^\d+(\.\d+)?$/.test(s)) {
    const n = Number(s);
    if (!Number.isFinite(n) || n <= 0) return 0;
    return Math.abs(n) < 1e11 ? n * 1000 : n;
  }
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : 0;
}

/**
 * 起点→终点（created / completed、Start / End）。
 * @param {unknown} start
 * @param {unknown} end
 */
export function durationFromRange(start, end, opts) {
  const a = toUnixMs(start);
  const b = toUnixMs(end);
  if (!a || !b || b <= a) return 0;
  return sanitizeGenMs(b - a, opts);
}

export function sanitizeEstGenMs(ms) {
  return sanitizeGenMs(ms, { max: EST_GEN_MS_MAX });
}

/**
 * @param {number} genTokens
 * @param {number} genMs
 * @returns {number | null}
 */
export function tokensPerSec(genTokens, genMs) {
  const t = Number(genTokens) || 0;
  const ms = Number(genMs) || 0;
  if (t <= 0 || ms < GEN_MS_MIN) return null;
  return t / (ms / 1000);
}
