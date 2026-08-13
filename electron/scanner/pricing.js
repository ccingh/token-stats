/**
 * 模型价目表（USD / 1M tokens + 可选官方 CNY）。
 *
 * - 匹配规则：模型名（小写）包含 key 即命中，key 越长越优先
 * - 未配置 cacheRead / cacheWrite 时按惯例：cacheRead = input * 0.1，cacheWrite = input * 1.25
 * - reasoning token 按 output 单价计
 * - cny：仅填「厂商官方人民币刊例」。有 cny 时前端显示 ¥ 直接用人民币价，不走「美元×汇率」
 * - 无官方 CNY 的厂商（Anthropic / OpenAI / xAI 等）不硬造人民币价
 * - 分段计费（tiers/cnyTiers）：价目表里保留官方多档刊例，但会话级估算
 *   **固定用基础档（第一档 / flat 字段）**。原因：只有「每次请求的输入长度」
 *   才能正确选档；用会话均长去套整段 token 会把早期短请求也按高档计，系统性高估。
 *   真正的逐请求分段需 turn 级明细后再做。
 * - 缓存：若 cacheRead ≤ input，默认 input 含缓存子集，计费用 (input-cache)*input价 + cache*缓存价
 *
 * 价格核对日期：2026-08-13（公开文档，会随厂商调价过期）
 *
 * @typedef {{ input: number, output: number, cacheRead?: number, cacheWrite?: number }} Price
 * @typedef {Price & { upTo: number }} PriceTier  // upTo: 该档最大输入 token（不含上界用 Infinity）
 * @typedef {{
 *   input: number,
 *   output: number,
 *   cacheRead?: number,
 *   cacheWrite?: number,
 *   cny?: Price,
 *   tiers?: PriceTier[],
 *   cnyTiers?: PriceTier[],
 * }} ModelPrice
 */

/** @type {Record<string, ModelPrice>} */
const PRICES = {
  // ─── Anthropic（官方仅 USD，platform.claude.com/docs pricing）────
  // 2026-08：Opus 5 $5/$25；Sonnet 5 促销 $2/$10（至 8/31）；Haiku 4.5 $1/$5
  // 旧 Opus 4 / 4.1 仍是 $15/$75
  "claude-opus-5": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "claude-opus-4.8": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "claude-opus-4.7": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "claude-opus-4.6": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "claude-opus-4": { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
  "claude-sonnet-5": { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  "claude-sonnet-4.6": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  "claude-sonnet-4": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  "claude-haiku-4.5": { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
  "claude-3-7-sonnet": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  "claude-3-5-sonnet": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  "claude-3-5-haiku": { input: 0.8, output: 4, cacheRead: 0.08, cacheWrite: 1 },
  "claude-3-haiku": { input: 0.25, output: 1.25, cacheRead: 0.03, cacheWrite: 0.3 },

  // ─── OpenAI（官方仅 USD）───────────────────────────────────────────
  "gpt-5-mini": { input: 0.25, output: 2, cacheRead: 0.025 },
  "gpt-5": { input: 1.25, output: 10, cacheRead: 0.125 },
  "gpt-4.1-mini": { input: 0.4, output: 1.6, cacheRead: 0.1 },
  "gpt-4.1": { input: 2, output: 8, cacheRead: 0.5 },
  "gpt-4o": { input: 2.5, output: 10, cacheRead: 1.25 },
  o3: { input: 2, output: 8, cacheRead: 0.5 },
  "o4-mini": { input: 1.1, output: 4.4, cacheRead: 0.275 },

  // ─── Moonshot Kimi 官方人民币（platform.kimi.com / platform.moonshot.cn）──
  "kimi-k2.7-code-highspeed": {
    input: 1.9,
    output: 8,
    cacheRead: 0.38,
    cny: { input: 13, output: 54, cacheRead: 2.6 },
  },
  "kimi-k2.7-code": {
    input: 0.95,
    output: 4,
    cacheRead: 0.19,
    cny: { input: 6.5, output: 27, cacheRead: 1.3 },
  },
  "kimi-k2.6": {
    input: 0.95,
    output: 4,
    cacheRead: 0.16,
    cny: { input: 6.5, output: 27, cacheRead: 1.1 },
  },
  "kimi-k2.5": {
    input: 0.6,
    output: 3,
    cacheRead: 0.1,
  },
  "kimi-k2-thinking": {
    input: 0.6,
    output: 2.5,
    cacheRead: 0.15,
  },
  "kimi-k2": {
    input: 0.6,
    output: 2.5,
    cacheRead: 0.15,
  },
  "kimi-k1.5": { input: 0.6, output: 2.5 },
  "kimi-for-coding": {
    input: 3,
    output: 15,
    cacheRead: 0.3,
    cny: { input: 20, output: 100, cacheRead: 2 },
  },
  "kimi-k3": {
    input: 3,
    output: 15,
    cacheRead: 0.3,
    cny: { input: 20, output: 100, cacheRead: 2 },
  },

  // ─── xAI Grok（官方仅 USD，docs.x.ai/developers/pricing）───────────
  // grok-4.6：短上下文（<200k）$2 / $6 / 缓存 $0.50；≥200k 翻倍
  // 会话级估算固定用基础档（与文件头约定一致）
  "grok-4.6": {
    input: 2,
    output: 6,
    cacheRead: 0.5,
    tiers: [
      { upTo: 200000, input: 2, output: 6, cacheRead: 0.5 },
      { upTo: Infinity, input: 4, output: 12, cacheRead: 1 },
    ],
  },
  "grok-4-fast": { input: 0.2, output: 0.5, cacheRead: 0.05 },
  // grok-4.5：短上下文 $2 / $6 / 缓存 $0.30（docs.x.ai，2026-08）
  "grok-4.5": {
    input: 2,
    output: 6,
    cacheRead: 0.3,
    tiers: [
      { upTo: 200000, input: 2, output: 6, cacheRead: 0.3 },
      { upTo: Infinity, input: 4, output: 12, cacheRead: 0.6 },
    ],
  },
  // 已下线的 grok-4 历史刊例（旧会话）
  "grok-4": { input: 3, output: 15, cacheRead: 0.75 },
  "grok-3-mini": { input: 0.3, output: 0.5 },
  "grok-3": { input: 3, output: 15 },

  // ─── 智谱 BigModel 官方人民币 bigmodel.cn/pricing ─────────────────
  // GLM-5.2：输入 ¥8 / 输出 ¥28 / 缓存命中 ¥2；[32k+) 更高档
  // GLM-5：0–32k ¥4/¥18/缓存¥1；32k+ ¥6/¥22/¥1.5
  // GLM-4.7：0–32k 短输出 ¥2/¥8/¥0.4；更长档更高
  "glm-5.1": {
    input: 1.05,
    output: 4.2,
    cacheRead: 0.23,
    cny: { input: 6, output: 24, cacheRead: 1.3 },
    tiers: [
      { upTo: 32000, input: 1.05, output: 4.2, cacheRead: 0.23 },
      { upTo: Infinity, input: 1.4, output: 4.9, cacheRead: 0.35 },
    ],
    cnyTiers: [
      { upTo: 32000, input: 6, output: 24, cacheRead: 1.3 },
      { upTo: Infinity, input: 8, output: 28, cacheRead: 2 },
    ],
  },
  "glm-5.2": {
    input: 1.4,
    output: 4.4,
    cacheRead: 0.26,
    cny: { input: 8, output: 28, cacheRead: 2 },
    tiers: [
      { upTo: 32000, input: 1.4, output: 4.4, cacheRead: 0.26 },
      { upTo: Infinity, input: 1.8, output: 5.2, cacheRead: 0.32 },
    ],
    cnyTiers: [
      { upTo: 32000, input: 8, output: 28, cacheRead: 2 },
      { upTo: Infinity, input: 10, output: 36, cacheRead: 2.5 },
    ],
  },
  "glm-5": {
    input: 1.0,
    output: 3.5,
    cacheRead: 0.2,
    cny: { input: 4, output: 18, cacheRead: 1 },
    tiers: [
      { upTo: 32000, input: 1.0, output: 3.5, cacheRead: 0.2 },
      { upTo: Infinity, input: 1.4, output: 4.5, cacheRead: 0.3 },
    ],
    cnyTiers: [
      { upTo: 32000, input: 4, output: 18, cacheRead: 1 },
      { upTo: Infinity, input: 6, output: 22, cacheRead: 1.5 },
    ],
  },
  "glm-4.7": {
    input: 0.5,
    output: 1.5,
    cacheRead: 0.1,
    cny: { input: 2, output: 8, cacheRead: 0.4 },
    // 简化：按输入长度两档（官方还有输出长度子档，会话级无法精确）
    tiers: [
      { upTo: 32000, input: 0.5, output: 1.5, cacheRead: 0.1 },
      { upTo: 128000, input: 0.7, output: 2.0, cacheRead: 0.14 },
      { upTo: Infinity, input: 0.9, output: 2.5, cacheRead: 0.18 },
    ],
    cnyTiers: [
      { upTo: 32000, input: 2, output: 8, cacheRead: 0.4 },
      { upTo: 128000, input: 1.2, output: 8, cacheRead: 0.24 }, // 官方 32–128k 刊例
      { upTo: Infinity, input: 1.5, output: 10, cacheRead: 0.3 },
    ],
  },
  "glm-4.6": {
    input: 0.6,
    output: 2.2,
    cacheRead: 0.11,
  },
  "glm-4.5-air": { input: 0.2, output: 1.1 },
  "glm-4.5": { input: 0.6, output: 2.2, cacheRead: 0.11 },

  // ─── DeepSeek 官方人民币 api-docs.deepseek.com ─────────────────────
  "deepseek-v4-flash": {
    input: 0.14,
    output: 0.28,
    cacheRead: 0.0028,
    cny: { input: 1, output: 2, cacheRead: 0.02 },
  },
  "deepseek-v4-pro": {
    input: 0.435,
    output: 0.87,
    cacheRead: 0.003625,
    cny: { input: 3, output: 6, cacheRead: 0.025 },
  },
  "deepseek-chat": {
    input: 0.14,
    output: 0.28,
    cacheRead: 0.0028,
    cny: { input: 1, output: 2, cacheRead: 0.02 },
  },
  "deepseek-reasoner": {
    input: 0.435,
    output: 0.87,
    cacheRead: 0.003625,
    cny: { input: 3, output: 6, cacheRead: 0.025 },
  },
  deepseek: {
    input: 0.14,
    output: 0.28,
    cacheRead: 0.0028,
    cny: { input: 1, output: 2, cacheRead: 0.02 },
  },

  // ─── 阿里云百炼 Qwen 官方人民币 ───────────────────────────────────
  // 多数模型按输入长度阶梯；会话级用 avg prompt 选档
  "qwen3.8-max": {
    input: 1.7,
    output: 5.1,
    cny: { input: 12, output: 36 },
  },
  "qwen3.7-max": {
    input: 1.7,
    output: 5.1,
    cny: { input: 12, output: 36 },
  },
  "qwen3-max": {
    input: 0.36,
    output: 1.4,
    cny: { input: 2.5, output: 10 },
    tiers: [
      { upTo: 32000, input: 0.36, output: 1.4 },
      { upTo: 128000, input: 0.72, output: 2.8 },
      { upTo: Infinity, input: 1.2, output: 4.8 },
    ],
    cnyTiers: [
      { upTo: 32000, input: 2.5, output: 10 },
      { upTo: 128000, input: 5, output: 20 },
      { upTo: Infinity, input: 8, output: 32 },
    ],
  },
  "qwen-max": {
    input: 0.34,
    output: 1.4,
    cny: { input: 2.4, output: 9.6 },
  },
  "qwen3.5-plus": {
    input: 0.12,
    output: 0.7,
    cny: { input: 0.8, output: 4.8 },
  },
  "qwen-plus": {
    input: 0.12,
    output: 0.3,
    cny: { input: 0.8, output: 2 },
    tiers: [
      { upTo: 128000, input: 0.12, output: 0.3 },
      { upTo: Infinity, input: 0.24, output: 0.6 },
    ],
    cnyTiers: [
      { upTo: 128000, input: 0.8, output: 2 },
      { upTo: Infinity, input: 1.6, output: 4 },
    ],
  },
  "qwen-turbo": {
    input: 0.05,
    output: 0.1,
    cny: { input: 0.3, output: 0.6 },
  },
  "qwen3-coder-plus": {
    input: 0.6,
    output: 2.3,
    cny: { input: 4, output: 16 },
    tiers: [
      { upTo: 32000, input: 0.6, output: 2.3 },
      { upTo: 128000, input: 1.0, output: 4.0 },
      { upTo: Infinity, input: 1.5, output: 6.0 },
    ],
    cnyTiers: [
      { upTo: 32000, input: 4, output: 16 },
      { upTo: 128000, input: 7, output: 28 },
      { upTo: Infinity, input: 10, output: 40 },
    ],
  },
  "qwen3-coder-flash": {
    input: 0.15,
    output: 0.6,
    cny: { input: 1, output: 4 },
    tiers: [
      { upTo: 32000, input: 0.15, output: 0.6 },
      { upTo: Infinity, input: 0.3, output: 1.2 },
    ],
    cnyTiers: [
      { upTo: 32000, input: 1, output: 4 },
      { upTo: Infinity, input: 2, output: 8 },
    ],
  },
  "qwen3-coder-next": {
    input: 0.15,
    output: 0.6,
    cny: { input: 1, output: 4 },
    tiers: [
      { upTo: 32000, input: 0.15, output: 0.6 },
      { upTo: Infinity, input: 0.3, output: 1.2 },
    ],
    cnyTiers: [
      { upTo: 32000, input: 1, output: 4 },
      { upTo: Infinity, input: 2, output: 8 },
    ],
  },
  "qwen3-coder": {
    input: 0.6,
    output: 2.3,
    cny: { input: 4, output: 16 },
  },
  "qwen-coder-plus": {
    input: 0.5,
    output: 1,
    cny: { input: 3.5, output: 7 },
  },
  "qwen-coder-turbo": {
    input: 0.3,
    output: 0.9,
    cny: { input: 2, output: 6 },
  },
  "qwen-coder": {
    input: 0.5,
    output: 1,
    cny: { input: 3.5, output: 7 },
  },

  // ─── 小米 MiMo 官方 mimo.mi.com ───────────────────────────────────
  "mimo-v2.5-pro": {
    input: 0.435,
    output: 0.87,
    cacheRead: 0.0036,
    cny: { input: 3, output: 6, cacheRead: 0.025 },
  },
  "mimo-v2.5": {
    input: 0.14,
    output: 0.28,
    cacheRead: 0.0028,
    cny: { input: 1, output: 2, cacheRead: 0.02 },
  },

  // ─── 火山方舟 豆包 官方 volcengine.com ────────────────────────────
  "doubao-seed-evolving": {
    input: 0.85,
    output: 4.3,
    cacheRead: 0.17,
    cny: { input: 6, output: 30, cacheRead: 1.2 },
  },
  "doubao-seed-2.1-pro": {
    input: 0.85,
    output: 4.3,
    cacheRead: 0.17,
    cny: { input: 6, output: 30, cacheRead: 1.2 },
  },
  "doubao-seed-2.1-turbo": {
    input: 0.43,
    output: 2.1,
    cacheRead: 0.09,
    cny: { input: 3, output: 15, cacheRead: 0.6 },
  },
  "doubao-seed-2.0-pro": {
    input: 0.45,
    output: 2.3,
    cacheRead: 0.09,
    cny: { input: 3.2, output: 16, cacheRead: 0.64 },
  },
  doubao: {
    input: 0.85,
    output: 4.3,
    cacheRead: 0.17,
    cny: { input: 6, output: 30, cacheRead: 1.2 },
  },
};

// key 越长越优先（避免 "gpt-5" 抢先命中 "gpt-5-mini"，"glm-5" 抢 "glm-5.2"）
const KEYS = Object.keys(PRICES).sort((a, b) => b.length - a.length);

/**
 * OpenCode / 供应商短 id → 价目表 key（contains 匹配用）
 * 例：session.model = {"id":"k3","providerID":"kimi-for-coding"} → 展示名 k3
 */
const MODEL_ALIASES = {
  "grok 4.6": "grok-4.6",
  k3: "kimi-k3",
  "kimi-for-coding/k3": "kimi-k3",
  k2p7: "kimi-k2.7-code",
  k2p6: "kimi-k2.6",
  k2p5: "kimi-k2.5",
  "k2.7": "kimi-k2.7-code",
  "k2.6": "kimi-k2.6",
  "k2.5": "kimi-k2.5",
};

/**
 * @param {string} [model]
 * @returns {ModelPrice | null}
 */
export function findPrice(model) {
  if (!model) return null;
  let m = String(model).toLowerCase().trim();
  // 展示名带档位：deepseek-v4-pro · max → 先按主名匹配
  m = m.replace(/\s*·\s*.+$/, "").trim();
  if (MODEL_ALIASES[m]) m = MODEL_ALIASES[m];
  // provider/id 或 id 末段
  if (m.includes("/")) {
    const tail = m.split("/").pop() || m;
    if (MODEL_ALIASES[tail]) m = MODEL_ALIASES[tail];
  }
  for (const key of KEYS) {
    if (m.includes(key)) return PRICES[key];
  }
  // 原始串再试一次（兼容未剥离的形态）
  const raw = String(model).toLowerCase();
  for (const key of KEYS) {
    if (raw.includes(key)) return PRICES[key];
  }
  return null;
}

/**
 * 按输入长度选阶梯档（仅在有「单次请求 prompt 长度」时使用）。
 * @param {PriceTier[] | undefined} tiers
 * @param {number} promptTokens
 * @returns {Price | null}
 */
export function pickTier(tiers, promptTokens) {
  if (!tiers?.length) return null;
  const n = Number(promptTokens) || 0;
  for (const t of tiers) {
    if (n < t.upTo) {
      return {
        input: t.input,
        output: t.output,
        cacheRead: t.cacheRead,
        cacheWrite: t.cacheWrite,
      };
    }
  }
  const last = tiers[tiers.length - 1];
  return {
    input: last.input,
    output: last.output,
    cacheRead: last.cacheRead,
    cacheWrite: last.cacheWrite,
  };
}

/**
 * 按价目表估算一个会话的成本。模型未知时两个币种都为 null。
 * 会话级固定用基础档（p / p.cny），不用均长套高档，避免系统性高估。
 * usd 按美元价目；cny 仅当配置了官方人民币价时直接算，否则 null（上层按汇率折算）。
 * @param {{
 *   model?: string,
 *   inputTokens: number,
 *   outputTokens: number,
 *   cacheReadTokens: number,
 *   cacheWriteTokens: number,
 *   reasoningTokens: number,
 *   messageCount?: number,
 * }} s
 * @returns {{ usd: number | null, cny: number | null }}
 */
export function estimateCost(s) {
  const p = findPrice(s.model);
  if (!p) return { usd: null, cny: null };

  // 基础档 = flat 字段（与 tiers[0] 对齐）；会话汇总无法做正确分段
  const usdPrice = { input: p.input, output: p.output, cacheRead: p.cacheRead, cacheWrite: p.cacheWrite };
  const cnyPrice = p.cny || null;

  return {
    usd: calc(s, usdPrice),
    cny: cnyPrice ? calc(s, cnyPrice) : null,
  };
}

/**
 * @param {{ inputTokens: number, outputTokens: number, cacheReadTokens: number, cacheWriteTokens: number, reasoningTokens: number }} s
 * @param {Price} p
 */
function calc(s, p) {
  const cacheReadPrice = p.cacheRead ?? p.input * 0.1;
  const cacheWritePrice = p.cacheWrite ?? p.input * 1.25;

  const input = Number(s.inputTokens) || 0;
  const cacheRead = Number(s.cacheReadTokens) || 0;
  const cacheWrite = Number(s.cacheWriteTokens) || 0;
  const output = Number(s.outputTokens) || 0;
  const reasoning = Number(s.reasoningTokens) || 0;

  // Grok/OpenAI 风格：若 adapter 仍把 cache 算进 input（cache ≤ input）→ 只对未命中部分按 input 价
  // Claude 风格：input 与 cache 分列（常 cache ≫ input）→ 不扣减
  // Grok adapter 现已拆成未重叠字段，此时 cache > input，走「不扣减」分支即可
  let billableInput = input;
  if (cacheRead > 0 && cacheRead <= input) {
    billableInput = input - cacheRead;
  }

  // reasoning 若已含在 output 内（reasoning ≤ output），只按 output 计一次，避免双重计价
  let billableOutput = output;
  let billableReasoning = reasoning;
  if (reasoning > 0 && reasoning <= output) {
    billableOutput = output; // 已含 reasoning 的 completion
    billableReasoning = 0;
  }

  const v =
    (billableInput * p.input +
      billableOutput * p.output +
      billableReasoning * p.output +
      cacheRead * cacheReadPrice +
      cacheWrite * cacheWritePrice) /
    1_000_000;
  return Math.round(v * 1e6) / 1e6;
}
