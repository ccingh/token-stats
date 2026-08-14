import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  ModelPriceFields,
  PriceOverrides,
  PricingCatalogRow,
  ScanResult,
  UnpricedModel,
} from "./types";

type Props = {
  open: boolean;
  onClose: () => void;
  unpricedModels?: UnpricedModel[];
  focusModels?: string[];
  onNeedScan: () => Promise<ScanResult | null>;
};

type FormState = {
  originalKey?: string;
  match: string;
  aliases: string;
  input: string;
  output: string;
  cacheRead: string;
  cacheWrite: string;
  useCny: boolean;
  cnyInput: string;
  cnyOutput: string;
  cnyCacheRead: string;
};

function emptyOverrides(): PriceOverrides {
  return { version: 1, updatedAt: null, models: {}, aliases: {} };
}

function priceToForm(match: string, price?: ModelPriceFields | null, aliases: string[] = [], originalKey?: string): FormState {
  return {
    originalKey,
    match,
    aliases: aliases.join(", "),
    input: price?.input != null ? String(price.input) : "",
    output: price?.output != null ? String(price.output) : "",
    cacheRead: price?.cacheRead != null ? String(price.cacheRead) : "",
    cacheWrite: price?.cacheWrite != null ? String(price.cacheWrite) : "",
    useCny: !!price?.cny,
    cnyInput: price?.cny?.input != null ? String(price.cny.input) : "",
    cnyOutput: price?.cny?.output != null ? String(price.cny.output) : "",
    cnyCacheRead: price?.cny?.cacheRead != null ? String(price.cny.cacheRead) : "",
  };
}

function userAliasesFor(key: string, aliases: Record<string, string>): string[] {
  return Object.entries(aliases)
    .filter(([, to]) => to === key)
    .map(([from]) => from);
}

function formatUsd(p?: ModelPriceFields | null): string {
  if (!p) return "—";
  const cache =
    p.cacheRead != null ? ` · 缓存 $${trimNum(p.cacheRead)}` : "";
  return `$${trimNum(p.input)} / $${trimNum(p.output)}${cache}`;
}

function formatCny(p?: ModelPriceFields | null): string {
  if (!p?.cny) return "";
  const cache =
    p.cny.cacheRead != null ? ` · 缓存 ¥${trimNum(p.cny.cacheRead)}` : "";
  return `¥${trimNum(p.cny.input)} / ¥${trimNum(p.cny.output)}${cache}`;
}

function trimNum(n: number): string {
  const s = String(n);
  return s.includes(".") ? s.replace(/\.?0+$/, "") : s;
}

function parseOptionalNum(raw: string, label: string): { value?: number; error?: string } {
  const t = raw.trim();
  if (!t) return {};
  const n = Number(t);
  if (!Number.isFinite(n) || n < 0) return { error: `${label} 须为 ≥ 0 的数字` };
  return { value: n };
}

export default function PricingPanel({
  open,
  onClose,
  unpricedModels,
  focusModels,
  onNeedScan,
}: Props) {
  const [overrides, setOverrides] = useState<PriceOverrides>(emptyOverrides);
  const [catalog, setCatalog] = useState<PricingCatalogRow[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState<FormState | null>(null);
  const [showBuiltin, setShowBuiltin] = useState(false);

  const applyPayload = useCallback(
    (data: {
      overrides?: PriceOverrides;
      catalog?: PricingCatalogRow[];
      loadError?: string | null;
    }) => {
      if (data.overrides) setOverrides(data.overrides);
      if (data.catalog) setCatalog(data.catalog);
      setLoadError(data.loadError || null);
    },
    []
  );

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setMessage(null);
    setError(null);
    setForm(null);
    void (async () => {
      if (!window.tokenStats?.pricing) {
        setError("价格设置仅在 Electron 桌面端可用");
        return;
      }
      const res = await window.tokenStats.pricing.get();
      if (cancelled) return;
      if (!res.ok) {
        setError(res.error || "读取价目失败");
        return;
      }
      applyPayload(res);
      const first = focusModels?.[0];
      if (first && res.overrides) {
        const existing = res.overrides.models[first];
        setForm(
          priceToForm(
            first,
            existing,
            userAliasesFor(first, res.overrides.aliases || {}),
            existing ? first : undefined
          )
        );
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, focusModels, applyPayload]);

  const builtinKeys = useMemo(
    () => new Set(catalog.filter((r) => r.builtinPrice).map((r) => r.key)),
    [catalog]
  );

  const myRows = useMemo(() => {
    const keys = new Set([
      ...Object.keys(overrides.models),
      ...Object.values(overrides.aliases),
    ]);
    return [...keys]
      .filter(Boolean)
      .sort((a, b) => a.localeCompare(b))
      .map((key) => {
        const price = overrides.models[key];
        const source = price
          ? builtinKeys.has(key)
            ? "override"
            : "user"
          : "alias";
        return {
          key,
          source,
          price,
          aliases: userAliasesFor(key, overrides.aliases),
        };
      });
  }, [overrides, builtinKeys]);

  const builtinRows = useMemo(
    () => catalog.filter((r) => r.builtinPrice).sort((a, b) => a.key.localeCompare(b.key)),
    [catalog]
  );

  function openNew(match = "") {
    setError(null);
    setMessage(null);
    const existing = match ? overrides.models[match] : undefined;
    setForm(
      priceToForm(
        match,
        existing,
        match ? userAliasesFor(match, overrides.aliases) : [],
        existing ? match : undefined
      )
    );
  }

  function openEdit(key: string) {
    setError(null);
    setMessage(null);
    setForm(
      priceToForm(
        key,
        overrides.models[key] || catalog.find((r) => r.key === key)?.price,
        userAliasesFor(key, overrides.aliases),
        key
      )
    );
  }

  function openOverride(row: PricingCatalogRow) {
    setError(null);
    setMessage(null);
    setForm(
      priceToForm(
        row.key,
        overrides.models[row.key] || row.price,
        userAliasesFor(row.key, overrides.aliases),
        overrides.models[row.key] ? row.key : undefined
      )
    );
  }

  async function persist(next: PriceOverrides, okText: string) {
    if (!window.tokenStats?.pricing) {
      setError("价格设置仅在 Electron 桌面端可用");
      return false;
    }
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const res = await window.tokenStats.pricing.save({
        models: next.models,
        aliases: next.aliases,
      });
      if (!res.ok) throw new Error(res.error || "保存失败");
      applyPayload(res);
      setMessage(okText);
      setForm(null);
      await onNeedScan();
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function saveForm() {
    if (!form) return;
    const match = form.match.trim().toLowerCase();
    if (!match) {
      setError("请填写匹配名");
      return;
    }
    if (match.length < 3 && !builtinKeys.has(match)) {
      setError("匹配名至少 3 个字符（覆盖内置短名除外）");
      return;
    }

    const aliasList = form.aliases
      .split(/[,，;；\n]+/)
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);

    const input = parseOptionalNum(form.input, "USD 输入");
    const output = parseOptionalNum(form.output, "USD 输出");
    const cacheRead = parseOptionalNum(form.cacheRead, "USD 缓存读");
    const cacheWrite = parseOptionalNum(form.cacheWrite, "USD 缓存写");
    const numErr =
      input.error || output.error || cacheRead.error || cacheWrite.error;
    if (numErr) {
      setError(numErr);
      return;
    }

    const isBuiltin = builtinKeys.has(match);
    const hasPrice = input.value != null || output.value != null;
    if (!isBuiltin && (input.value == null || output.value == null)) {
      setError("新模型必须填写 USD 输入 / 输出单价");
      return;
    }
    if (hasPrice && (input.value == null || output.value == null)) {
      setError("填写单价时输入和输出都要有");
      return;
    }

    let cny: ModelPriceFields["cny"];
    if (form.useCny) {
      const ci = parseOptionalNum(form.cnyInput, "CNY 输入");
      const co = parseOptionalNum(form.cnyOutput, "CNY 输出");
      const cr = parseOptionalNum(form.cnyCacheRead, "CNY 缓存读");
      if (ci.error || co.error || cr.error) {
        setError(ci.error || co.error || cr.error || "人民币价无效");
        return;
      }
      if (ci.value == null || co.value == null) {
        setError("填写人民币刊例时输入和输出都要有");
        return;
      }
      cny = { input: ci.value, output: co.value };
      if (cr.value != null) cny.cacheRead = cr.value;
    }

    const models = { ...overrides.models };
    if (form.originalKey && form.originalKey !== match) {
      delete models[form.originalKey];
    }
    if (hasPrice && input.value != null && output.value != null) {
      const rec: ModelPriceFields = { input: input.value, output: output.value };
      if (cacheRead.value != null) rec.cacheRead = cacheRead.value;
      if (cacheWrite.value != null) rec.cacheWrite = cacheWrite.value;
      if (cny) rec.cny = cny;
      models[match] = rec;
    } else if (form.originalKey) {
      delete models[match];
    }

    const aliases = { ...overrides.aliases };
    const dropTargets = new Set<string>([match]);
    if (form.originalKey) dropTargets.add(form.originalKey);
    for (const [from, to] of Object.entries(aliases)) {
      if (dropTargets.has(to)) delete aliases[from];
    }
    for (const a of aliasList) aliases[a] = match;

    await persist({ version: 1, models, aliases }, "已保存，正在按新价目重算…");
  }

  async function removeRule(key: string) {
    const models = { ...overrides.models };
    const hadPrice = !!models[key];
    delete models[key];
    const aliases = { ...overrides.aliases };
    // 覆盖内置价：只去掉单价，别名仍指向该模型。
    // 新增模型或仅别名：一并清掉指向它的别名。
    if (!hadPrice || !builtinKeys.has(key)) {
      for (const [from, to] of Object.entries(aliases)) {
        if (to === key) delete aliases[from];
      }
    }
    await persist({ version: 1, models, aliases }, `已删除「${key}」的规则`);
  }

  if (!open) return null;

  const unpriced = unpricedModels || [];

  return (
    <div className="sync-overlay" role="dialog" aria-modal="true" aria-label="模型价格">
      <div className="sync-panel pricing-panel">
        <div className="sync-head">
          <div>
            <div className="sync-title">模型价格</div>
            <div className="sync-sub">
              单价为每 1M tokens。用户规则优先于内置刊例；删掉规则后恢复官方价。
            </div>
          </div>
          <button type="button" className="btn ghost" onClick={onClose} disabled={busy}>
            关闭
          </button>
        </div>

        {loadError && <div className="sync-msg err">{loadError}</div>}

        {unpriced.length > 0 && (
          <section className="sync-section">
            <div className="sync-section-title">未定价 · {unpriced.length}</div>
            <p className="sync-hint">
              这些模型已扫到用量，但还没有单价，花费未计入总额。带 -free
              后缀的按免费档记 $0，不会出现在这里。
            </p>
            <ul className="pricing-list">
              {unpriced.map((u) => (
                <li key={u.model} className="pricing-row">
                  <div className="pricing-row-main">
                    <strong>{u.model}</strong>
                    <span className="muted">
                      {u.sessions} 会话 · {u.totalTokens.toLocaleString()} tokens
                    </span>
                  </div>
                  <button
                    type="button"
                    className="btn ghost"
                    disabled={busy}
                    onClick={() => openNew(u.model)}
                  >
                    补价
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}

        <section className="sync-section">
          <div className="pricing-section-head">
            <div className="sync-section-title">我的规则 · {myRows.length}</div>
            <button type="button" className="btn ghost" disabled={busy} onClick={() => openNew()}>
              添加
            </button>
          </div>
          {myRows.length === 0 ? (
            <p className="sync-hint">还没有自定义规则。扫描到新模型时可以在上面补价，或点添加。</p>
          ) : (
            <ul className="pricing-list">
              {myRows.map((row) => (
                <li key={row.key} className="pricing-row">
                  <div className="pricing-row-main">
                    <strong>{row.key}</strong>
                    <span className="pricing-tag">
                      {row.source === "override"
                        ? "覆盖内置"
                        : row.source === "alias"
                          ? "仅别名"
                          : "新增"}
                    </span>
                    <span className="muted">
                      {row.price ? formatUsd(row.price) : "用内置单价"}
                      {row.price && formatCny(row.price) ? ` · ${formatCny(row.price)}` : ""}
                    </span>
                    {row.aliases.length > 0 && (
                      <span className="muted">别名 {row.aliases.join(", ")}</span>
                    )}
                  </div>
                  <div className="pricing-row-actions">
                    <button
                      type="button"
                      className="btn ghost"
                      disabled={busy}
                      onClick={() => openEdit(row.key)}
                    >
                      编辑
                    </button>
                    <button
                      type="button"
                      className="btn ghost"
                      disabled={busy}
                      onClick={() => void removeRule(row.key)}
                    >
                      删除
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>

        {form && (
          <section className="sync-section pricing-form">
            <div className="sync-section-title">
              {form.originalKey ? `编辑 ${form.originalKey}` : "添加规则"}
            </div>
            <label className="sync-label">
              匹配名（日志里的模型 id，越长越优先）
              <input
                className="sync-input"
                value={form.match}
                onChange={(e) => setForm({ ...form, match: e.target.value })}
                disabled={busy}
                placeholder="grok-4.6"
                autoComplete="off"
                spellCheck={false}
              />
            </label>
            <label className="sync-label">
              别名（逗号分隔，精确匹配）
              <input
                className="sync-input"
                value={form.aliases}
                onChange={(e) => setForm({ ...form, aliases: e.target.value })}
                disabled={busy}
                placeholder="grok 4.6, grok4.6"
                autoComplete="off"
                spellCheck={false}
              />
            </label>
            <div className="pricing-grid">
              <label className="sync-label">
                USD 输入 / 1M
                <input
                  className="sync-input"
                  type="number"
                  min={0}
                  step="any"
                  value={form.input}
                  onChange={(e) => setForm({ ...form, input: e.target.value })}
                  disabled={busy}
                  placeholder={builtinKeys.has(form.match.trim().toLowerCase()) ? "留空=不改内置" : "2"}
                />
              </label>
              <label className="sync-label">
                USD 输出 / 1M
                <input
                  className="sync-input"
                  type="number"
                  min={0}
                  step="any"
                  value={form.output}
                  onChange={(e) => setForm({ ...form, output: e.target.value })}
                  disabled={busy}
                  placeholder="6"
                />
              </label>
              <label className="sync-label">
                USD 缓存读 / 1M
                <input
                  className="sync-input"
                  type="number"
                  min={0}
                  step="any"
                  value={form.cacheRead}
                  onChange={(e) => setForm({ ...form, cacheRead: e.target.value })}
                  disabled={busy}
                  placeholder="默认 10%"
                />
              </label>
              <label className="sync-label">
                USD 缓存写 / 1M
                <input
                  className="sync-input"
                  type="number"
                  min={0}
                  step="any"
                  value={form.cacheWrite}
                  onChange={(e) => setForm({ ...form, cacheWrite: e.target.value })}
                  disabled={busy}
                  placeholder="默认 125%"
                />
              </label>
            </div>
            <label className="pricing-check">
              <input
                type="checkbox"
                checked={form.useCny}
                onChange={(e) => setForm({ ...form, useCny: e.target.checked })}
                disabled={busy}
              />
              填写人民币刊例（有则界面直接显示 ¥，不用美元×汇率）
            </label>
            {form.useCny && (
              <div className="pricing-grid">
                <label className="sync-label">
                  CNY 输入 / 1M
                  <input
                    className="sync-input"
                    type="number"
                    min={0}
                    step="any"
                    value={form.cnyInput}
                    onChange={(e) => setForm({ ...form, cnyInput: e.target.value })}
                    disabled={busy}
                  />
                </label>
                <label className="sync-label">
                  CNY 输出 / 1M
                  <input
                    className="sync-input"
                    type="number"
                    min={0}
                    step="any"
                    value={form.cnyOutput}
                    onChange={(e) => setForm({ ...form, cnyOutput: e.target.value })}
                    disabled={busy}
                  />
                </label>
                <label className="sync-label">
                  CNY 缓存读 / 1M
                  <input
                    className="sync-input"
                    type="number"
                    min={0}
                    step="any"
                    value={form.cnyCacheRead}
                    onChange={(e) => setForm({ ...form, cnyCacheRead: e.target.value })}
                    disabled={busy}
                  />
                </label>
              </div>
            )}
            <div className="sync-actions">
              <button type="button" className="btn primary" onClick={() => void saveForm()} disabled={busy}>
                {busy ? "重算中…" : "保存并重算"}
              </button>
              <button
                type="button"
                className="btn ghost"
                onClick={() => setForm(null)}
                disabled={busy}
              >
                取消
              </button>
            </div>
          </section>
        )}

        <section className="sync-section">
          <div className="pricing-section-head">
            <div className="sync-section-title">内置价目 · {builtinRows.length}</div>
            <button
              type="button"
              className="btn ghost"
              onClick={() => setShowBuiltin((v) => !v)}
            >
              {showBuiltin ? "收起" : "展开"}
            </button>
          </div>
          {showBuiltin && (
            <ul className="pricing-list pricing-list-compact">
              {builtinRows.map((row) => (
                <li key={row.key} className="pricing-row">
                  <div className="pricing-row-main">
                    <strong>{row.key}</strong>
                    {row.source === "override" && <span className="pricing-tag">已覆盖</span>}
                    <span className="muted">{formatUsd(row.builtinPrice)}</span>
                    {formatCny(row.builtinPrice) && (
                      <span className="muted">{formatCny(row.builtinPrice)}</span>
                    )}
                  </div>
                  <button
                    type="button"
                    className="btn ghost"
                    disabled={busy}
                    onClick={() => openOverride(row)}
                  >
                    {row.source === "override" ? "改覆盖" : "覆盖"}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        {message && <div className="sync-msg ok">{message}</div>}
        {error && <div className="sync-msg err">{error}</div>}
      </div>
    </div>
  );
}
