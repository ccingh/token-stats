/**
 * 跨客户端统一 agent 标签规范化。
 * - 去掉 zcode-/grok-build- 等前缀
 * - 占位符（subagent/main/子）→ undefined，由 UI 只显示「子/主」一次
 */

/**
 * @param {unknown} name
 * @returns {string | undefined}
 */
export function normalizeAgentName(name) {
  if (name == null) return undefined;
  let s = String(name).trim();
  if (!s) return undefined;

  // 常见产品前缀
  s = s.replace(/^zcode-?/i, "");
  s = s.replace(/^grok-build-?/i, "");
  s = s.replace(/^grok-?/i, "");

  if (/^general[_-]?purpose$/i.test(s)) return "general-purpose";
  if (/^explore$/i.test(s)) return "Explore";
  if (/^plan$/i.test(s) || /^build-?plan$/i.test(s)) return "Plan";
  if (/^build$/i.test(s)) return "Build";
  if (/^bash$/i.test(s)) return "Bash";
  if (/^compaction$/i.test(s)) return "Compaction";

  // 无信息占位
  if (
    /^(main|subagent|子|主|agent|unknown|\(unknown\)|default)$/i.test(s)
  ) {
    return undefined;
  }

  // Claude agent-<uuid> 过长时缩短
  if (/^[0-9a-f]{8,}-/i.test(s) || /^[0-9a-f]{16,}$/i.test(s)) {
    return s.length > 12 ? `${s.slice(0, 8)}…` : s;
  }

  return s || undefined;
}

/**
 * @param {unknown} name
 * @returns {boolean}
 */
export function isPlaceholderAgent(name) {
  return normalizeAgentName(name) == null;
}
