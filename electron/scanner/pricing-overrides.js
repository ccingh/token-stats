/**
 * 用户自定义价目覆盖（桌面本地）。
 * 文件与会话库同目录：TOKEN_STATS_CONFIG_DIR 或 ~/.token-stats
 *
 * 合并规则由 pricing.applyPriceOverrides 负责：用户 models/aliases 盖在内置表上。
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const FILE_NAME = "pricing-overrides.json";
const VERSION = 1;
const MIN_MATCH_LEN = 3;

/**
 * @param {string} [dir]
 */
export function overridesPath(dir) {
  const base =
    dir ||
    process.env.TOKEN_STATS_CONFIG_DIR ||
    path.join(os.homedir(), ".token-stats");
  return path.join(base, FILE_NAME);
}

/** @returns {{ version: 1, updatedAt: string | null, models: Record<string, object>, aliases: Record<string, string> }} */
export function emptyOverrides() {
  return { version: VERSION, updatedAt: null, models: {}, aliases: {} };
}

/**
 * @param {unknown} v
 * @param {{ required?: boolean }} [opts]
 * @returns {{ value?: number, error?: string }}
 */
function readNum(v, opts = {}) {
  if (v == null || v === "") {
    return opts.required ? { error: "必填" } : { value: undefined };
  }
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return { error: "须为 ≥ 0 的数字" };
  return { value: n };
}

/**
 * @param {unknown} raw
 * @param {string} label
 * @returns {{ value?: object, error?: string }}
 */
function parsePriceBlock(raw, label) {
  if (!raw || typeof raw !== "object") {
    return { error: `${label} 无效` };
  }
  const o = /** @type {Record<string, unknown>} */ (raw);
  const input = readNum(o.input, { required: true });
  if (input.error) return { error: `${label} input：${input.error}` };
  const output = readNum(o.output, { required: true });
  if (output.error) return { error: `${label} output：${output.error}` };
  const cacheRead = readNum(o.cacheRead);
  if (cacheRead.error) return { error: `${label} cacheRead：${cacheRead.error}` };
  const cacheWrite = readNum(o.cacheWrite);
  if (cacheWrite.error) return { error: `${label} cacheWrite：${cacheWrite.error}` };
  /** @type {Record<string, number>} */
  const price = { input: /** @type {number} */ (input.value), output: /** @type {number} */ (output.value) };
  if (cacheRead.value != null) price.cacheRead = cacheRead.value;
  if (cacheWrite.value != null) price.cacheWrite = cacheWrite.value;
  return { value: price };
}

/**
 * @param {unknown} raw
 * @param {{ builtinKeys?: Set<string> }} [opts]
 * @returns {{ ok: true, data: ReturnType<typeof emptyOverrides> } | { ok: false, errors: string[] }}
 */
export function validatePriceOverrides(raw, opts = {}) {
  const errors = [];
  if (raw == null || typeof raw !== "object") {
    return { ok: false, errors: ["覆盖文件须为 JSON 对象"] };
  }
  const src = /** @type {Record<string, unknown>} */ (raw);
  const modelsIn =
    src.models && typeof src.models === "object" && !Array.isArray(src.models)
      ? /** @type {Record<string, unknown>} */ (src.models)
      : null;
  const aliasesIn =
    src.aliases && typeof src.aliases === "object" && !Array.isArray(src.aliases)
      ? /** @type {Record<string, unknown>} */ (src.aliases)
      : null;
  if (src.models != null && !modelsIn) errors.push("models 须为对象");
  if (src.aliases != null && !aliasesIn) errors.push("aliases 须为对象");
  if (errors.length) return { ok: false, errors };

  /** @type {Record<string, object>} */
  const models = {};
  const builtinKeys = opts.builtinKeys || new Set();

  for (const [rawKey, val] of Object.entries(modelsIn || {})) {
    const key = String(rawKey).toLowerCase().trim();
    if (!key) {
      errors.push("模型匹配名不能为空");
      continue;
    }
    if (key.length < MIN_MATCH_LEN && !builtinKeys.has(key)) {
      errors.push(`「${key}」太短（至少 ${MIN_MATCH_LEN} 个字符，以免误伤其它模型）`);
      continue;
    }
    const parsed = parsePriceBlock(val, key);
    if (parsed.error || !parsed.value) {
      errors.push(parsed.error || `${key} 价格无效`);
      continue;
    }
    const rec = /** @type {Record<string, unknown>} */ (val);
    /** @type {Record<string, unknown>} */
    const price = { ...parsed.value };
    if (rec.cny != null) {
      const cny = parsePriceBlock(rec.cny, `${key} cny`);
      if (cny.error || !cny.value) {
        errors.push(cny.error || `${key} 人民币价无效`);
        continue;
      }
      price.cny = cny.value;
    }
    models[key] = price;
  }

  /** @type {Record<string, string>} */
  const aliases = {};
  for (const [rawFrom, rawTo] of Object.entries(aliasesIn || {})) {
    const from = String(rawFrom).toLowerCase().trim();
    const to = String(rawTo || "")
      .toLowerCase()
      .trim();
    if (!from) {
      errors.push("别名不能为空");
      continue;
    }
    if (!to) {
      errors.push(`别名「${from}」缺少目标模型`);
      continue;
    }
    if (to.length < MIN_MATCH_LEN && !builtinKeys.has(to) && !models[to]) {
      errors.push(`别名「${from}」目标「${to}」太短`);
      continue;
    }
    aliases[from] = to;
  }

  if (errors.length) return { ok: false, errors };

  let updatedAt = null;
  if (typeof src.updatedAt === "string" && src.updatedAt.trim()) {
    updatedAt = src.updatedAt.trim();
  }

  return {
    ok: true,
    data: {
      version: VERSION,
      updatedAt,
      models,
      aliases,
    },
  };
}

/**
 * @param {string} [dir]
 * @param {{ builtinKeys?: Set<string> }} [opts]
 * @returns {{ overrides: ReturnType<typeof emptyOverrides>, error: string | null, path: string }}
 */
export function loadPriceOverrides(dir, opts = {}) {
  const file = overridesPath(dir);
  try {
    if (!fs.existsSync(file)) {
      return { overrides: emptyOverrides(), error: null, path: file };
    }
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    const v = validatePriceOverrides(raw, opts);
    if (!v.ok) {
      return {
        overrides: emptyOverrides(),
        error: `覆盖文件无法读取，已忽略：${v.errors.join("；")}`,
        path: file,
      };
    }
    return { overrides: v.data, error: null, path: file };
  } catch (err) {
    return {
      overrides: emptyOverrides(),
      error: `覆盖文件无法读取，已忽略：${err instanceof Error ? err.message : String(err)}`,
      path: file,
    };
  }
}

/**
 * @param {unknown} raw
 * @param {string} [dir]
 * @param {{ builtinKeys?: Set<string> }} [opts]
 * @returns {ReturnType<typeof emptyOverrides>}
 */
export function savePriceOverrides(raw, dir, opts = {}) {
  const v = validatePriceOverrides(raw, opts);
  if (!v.ok) {
    throw new Error(v.errors.join("；"));
  }
  const data = {
    ...v.data,
    updatedAt: new Date().toISOString(),
  };
  const file = overridesPath(dir);
  const folder = path.dirname(file);
  if (!fs.existsSync(folder)) fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2), "utf8");
  return data;
}
