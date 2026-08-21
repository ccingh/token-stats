import { useEffect, useMemo, useState } from "react";
import type {
  AgentTrace,
  SessionDetail,
  SessionRecord,
  SessionTranscript,
  TranscriptMessage,
  TranscriptPart,
  TurnDetail,
} from "./types";
import { formatTokPerSec, prettyModel, prettyModelVariant, tokensPerSec } from "./types";

/** 是否无有效 agent 名（占位符） */
function isPlaceholderAgent(name?: string): boolean {
  if (!name) return true;
  const n = name.trim().replace(/^zcode-?/i, "");
  if (!n) return true;
  return /^(main|subagent|子|主|agent|unknown|\(unknown\))$/i.test(n);
}

function variantTone(
  v?: string | null
): "max" | "high" | "medium" | "low" | "other" | null {
  if (!v) return null;
  const t = v.toLowerCase();
  if (t === "max" || t === "xhigh" || t === "extra-high") return "max";
  if (t === "high") return "high";
  if (t === "medium" || t === "mid") return "medium";
  if (t === "low" || t === "fast" || t === "minimal") return "low";
  return "other";
}

function ModelCell({
  model,
  variant,
}: {
  model?: string;
  variant?: string;
}) {
  if (!model) return <>–</>;
  const base = prettyModel(model) || model;
  const v = prettyModelVariant(model, variant);
  const tone = variantTone(v);
  return (
    <span className="model-with-variant">
      <span className="model-base-name">{base}</span>
      {v && tone ? (
        <span className={`variant-chip variant-${tone}`} title={`思考档位 · ${v}`}>
          {v}
        </span>
      ) : null}
    </span>
  );
}

/**
 * Agent 列展示：有真名用真名；没名时主→–、子→–（来源列已有「子」，避免「子 子」）
 * Agent 汇总表用 withSource 时：没名的子只显示「子」一次
 */
function agentLabel(
  name?: string,
  opts?: { isSub?: boolean; forSummary?: boolean }
): string {
  const isSub = !!opts?.isSub;
  const forSummary = !!opts?.forSummary;
  if (isPlaceholderAgent(name)) {
    if (forSummary) return isSub ? "子" : "主";
    return "–";
  }
  let n = String(name).trim().replace(/^zcode-?/i, "");
  if (/^general[_-]?purpose$/i.test(n)) n = "general-purpose";
  return n;
}

function totalOfTrace(m: {
  input: number;
  output: number;
  cacheRead?: number;
  reasoning?: number;
  estCache?: number;
}): number {
  return (
    (m.input || 0) +
    (m.output || 0) +
    (m.cacheRead || 0) +
    (m.estCache || 0) +
    (m.reasoning || 0)
  );
}

type Props = {
  session: SessionRecord | null;
  onClose: () => void;
};

type TabId = "usage" | "chat";

function formatTokens(n: number): string {
  if (!Number.isFinite(n)) return "–";
  if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (Math.abs(n) >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(Math.round(n));
}

function formatEstTokens(n?: number | null): string | null {
  const v = Math.max(0, Number(n) || 0);
  if (v <= 0) return null;
  return `–（${formatTokens(v)}）`;
}

function formatCacheRead(official?: number | null, est?: number | null): string {
  const read = Math.max(0, Number(official) || 0);
  const estimated = Math.max(0, Number(est) || 0);
  if (read > 0 && estimated > 0) {
    return `${formatTokens(read)}（${formatTokens(estimated)}）`;
  }
  if (read > 0) return formatTokens(read);
  return formatEstTokens(estimated) || formatTokens(0);
}

function formatHitRate(
  rate: number | null | undefined,
  est?: number | null
): string {
  const official =
    rate != null && Number.isFinite(rate) ? `${Math.round(rate * 100)}%` : null;
  const estimated =
    est != null && Number.isFinite(est) ? `${Math.round(est * 100)}%` : null;
  if (official && estimated) return `${official}（${estimated}）`;
  if (official) return official;
  if (estimated) return `–（${estimated}）`;
  return "–";
}

function uncachedInputOf(s: {
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  totalTokens?: number;
  estCacheReadTokens?: number;
  noCacheData?: boolean;
}): number {
  const input = Math.max(0, Number(s.inputTokens) || 0);
  const est = Math.max(0, Number(s.estCacheReadTokens) || 0);
  if (s.noCacheData === false || est <= 0) return input;
  const rest =
    Math.max(0, Number(s.outputTokens) || 0) +
    Math.max(0, Number(s.reasoningTokens) || 0);
  const total = Math.max(0, Number(s.totalTokens) || 0);
  if (total > 0) {
    const asSnapshot = Math.abs(input + rest - total);
    const asSplit = Math.abs(input + est + rest - total);
    if (asSnapshot + 1 < asSplit) return Math.max(0, input - est);
  }
  return input;
}

function formatTs(iso?: string): string {
  if (!iso) return "–";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

function roleLabel(role: string): string {
  switch (role) {
    case "user":
      return "你";
    case "assistant":
      return "助手";
    case "system":
      return "系统";
    case "tool":
      return "工具结果";
    case "reasoning":
      return "思考";
    default:
      return role;
  }
}

function PartBlock({ p }: { p: TranscriptPart }) {
  if (p.type === "text" || (p.type === "other" && p.text && !p.collapsedByDefault)) {
    return <div className="chat-text">{p.text || ""}</div>;
  }

  if (p.type === "thinking" || p.type === "other") {
    return (
      <details className="chat-fold thinking" open={false}>
        <summary>思考过程</summary>
        <pre className="chat-pre">{p.text || ""}</pre>
      </details>
    );
  }

  if (p.type === "tool_call") {
    return (
      <details className="chat-fold tool" open={false}>
        <summary>
          <span className="tool-badge">tool</span>
          <span className="tool-name">{p.toolName || "tool"}</span>
          {p.toolId ? (
            <span className="tool-id muted">
              {p.toolId.length > 18
                ? `${p.toolId.slice(0, 10)}…${p.toolId.slice(-4)}`
                : p.toolId}
            </span>
          ) : null}
        </summary>
        {p.input ? (
          <div className="chat-fold-body">
            <div className="chat-fold-label">输入</div>
            <pre className="chat-pre">{p.input}</pre>
          </div>
        ) : null}
        {p.output ? (
          <div className="chat-fold-body">
            <div className="chat-fold-label">输出</div>
            <pre className="chat-pre">{p.output}</pre>
          </div>
        ) : null}
        {!p.input && !p.output ? (
          <div className="muted pad-sm">无参数 / 无输出</div>
        ) : null}
      </details>
    );
  }

  if (p.type === "tool_result") {
    return (
      <details className="chat-fold tool-result" open={false}>
        <summary>
          <span className="tool-badge result">result</span>
          <span className="tool-name">{p.toolName || p.toolId || "tool_result"}</span>
        </summary>
        <pre className="chat-pre">{p.output || p.text || ""}</pre>
      </details>
    );
  }

  return p.text ? <div className="chat-text">{p.text}</div> : null;
}

function ChatBubble({ m }: { m: TranscriptMessage }) {
  const cls = [
    "chat-msg",
    `role-${m.role}`,
    m.isSubagent ? "is-sub" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={cls}>
      <div className="chat-meta">
        <span className="chat-role">{roleLabel(m.role)}</span>
        {m.isSubagent ? (
          <span className="child-badge sub" title={m.sourceSessionId}>
            子
            {m.agentName
              ? ` · ${
                  m.agentName.length > 14
                    ? `${m.agentName.slice(0, 12)}…`
                    : m.agentName
                }`
              : ""}
          </span>
        ) : m.agentName ? (
          <span className="chat-hist-tag" title="来自 compact 归档">
            {m.agentName}
          </span>
        ) : null}
        {m.model ? (
          <span className="chat-model muted">{prettyModel(m.model) || m.model}</span>
        ) : null}
        {m.ts ? <span className="chat-ts muted">{formatTs(m.ts)}</span> : null}
      </div>
      <div className="chat-body">
        {(m.parts || []).map((p, i) => (
          <PartBlock key={i} p={p} />
        ))}
      </div>
    </div>
  );
}

export default function SessionDetailPanel({ session, onClose }: Props) {
  const [tab, setTab] = useState<TabId>("usage");
  const [detail, setDetail] = useState<SessionDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [transcript, setTranscript] = useState<SessionTranscript | null>(null);
  const [chatLoading, setChatLoading] = useState(false);
  const [chatError, setChatError] = useState<string | null>(null);
  const [chatLoaded, setChatLoaded] = useState(false);

  // 打开新会话时重置
  useEffect(() => {
    if (!session) {
      setDetail(null);
      setTranscript(null);
      setChatLoaded(false);
      setTab("usage");
      return;
    }
    setTab("usage");
    setTranscript(null);
    setChatLoaded(false);
    setChatError(null);

    let cancelled = false;
    setLoading(true);
    setError(null);
    setDetail(null);
    (async () => {
      try {
        if (!window.tokenStats?.sessionDetail) {
          throw new Error("当前环境不支持会话明细");
        }
        const res = await window.tokenStats.sessionDetail({
          client: session.client,
          sessionId: session.sessionId,
          mergedChildren: session.mergedChildren,
        });
        if (cancelled) return;
        if (!res.ok) throw new Error(res.error || "加载失败");
        const d = res.detail || null;
        if (d) {
          d.turns = (d.turns || []).map((t) => ({
            ...t,
            model: prettyModel(t.model) || t.model,
          }));
          d.models = (d.models || []).map((m) => ({
            ...m,
            model: prettyModel(m.model) || m.model,
          }));
        }
        setDetail(d);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [session]);

  // 切到对话 Tab 时按需加载
  useEffect(() => {
    if (!session || tab !== "chat" || chatLoaded) return;
    let cancelled = false;
    setChatLoading(true);
    setChatError(null);
    (async () => {
      try {
        if (!window.tokenStats?.sessionTranscript) {
          throw new Error("当前环境不支持对话预览（请用桌面端打开）");
        }
        const res = await window.tokenStats.sessionTranscript({
          client: session.client,
          sessionId: session.sessionId,
          mergedChildren: session.mergedChildren,
        });
        if (cancelled) return;
        if (!res.ok) throw new Error(res.error || "加载对话失败");
        setTranscript(res.transcript || null);
        setChatLoaded(true);
      } catch (err) {
        if (!cancelled) {
          setChatError(err instanceof Error ? err.message : String(err));
          setChatLoaded(true);
        }
      } finally {
        if (!cancelled) setChatLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [session, tab, chatLoaded]);

  const turns = detail?.turns || [];
  const models = detail?.models || [];
  const agents = (detail?.agents || []) as AgentTrace[];
  const messages = useMemo(
    () => transcript?.messages || [],
    [transcript]
  );

  if (!session) return null;

  return (
    <div className="sync-overlay" role="dialog" aria-modal="true" aria-label="会话明细">
      <div className={`detail-panel ${tab === "chat" ? "wide" : ""}`}>
        <div className="sync-head detail-head">
          <div className="detail-head-text">
            <div className="sync-title">{session.title || session.sessionId}</div>
            <div className="sync-sub">
              {session.client}
              {session.client === "opencode" && session.sessionKind === "v1"
                ? " · V1"
                : ""}
              {session.client === "opencode" && session.sessionKind === "v2"
                ? " · V2"
                : ""}
              {session.client === "opencode" &&
              session.sessionKind === "migrated"
                ? " · 迁移（V1/V2 同 id 只计一次）"
                : ""}
              {session.agentName ? ` · ${session.agentName}` : ""}
              {session.deleted
                ? session.synthetic
                  ? " · 已删除（本地补的父壳）"
                  : " · 已删除（源日志不存在，本地持久化）"
                : ""}
              {session.isSubagent
                ? session.parentSessionId
                  ? ` · 未归并子 agent（父 ${session.parentSessionId} 不可用）`
                  : " · 未归并子 agent（父会话不可用）"
                : ""}
              {session.childCount ? ` · 已并入 ${session.childCount} 个子会话` : ""}
              {" · "}
              {session.sessionId}
            </div>
          </div>
          <button
            type="button"
            className="btn ghost detail-close"
            onClick={onClose}
            aria-label="关闭"
          >
            关闭
          </button>
        </div>

        <div className="detail-panel-body">
        <div className="detail-metrics">
          <div className="metric">
            <div className="m-label">Total</div>
            <div className="m-value">{formatTokens(session.totalTokens)}</div>
          </div>
          <div className="metric">
            <div className="m-label">请求</div>
            <div
              className="m-value"
              title="模型 API 请求次数"
              style={{ fontSize: 16 }}
            >
              {session.requestCount != null && session.requestCount > 0
                ? session.requestCount.toLocaleString()
                : "–"}
            </div>
          </div>
          <div className="metric">
            <div className="m-label">Turn</div>
            <div
              className="m-value"
              title="用户轮次 / turn 数"
              style={{ fontSize: 16 }}
            >
              {session.turnCount != null && session.turnCount > 0
                ? session.turnCount.toLocaleString()
                : "–"}
            </div>
          </div>
          <div className="metric">
            <div className="m-label">Msgs</div>
            <div
              className="m-value"
              title="消息条数"
              style={{ fontSize: 16 }}
            >
              {session.messageCount != null && session.messageCount > 0
                ? session.messageCount.toLocaleString()
                : "–"}
            </div>
          </div>
          <div className="metric">
            <div className="m-label">Input</div>
            <div
              className="m-value"
              title={
                session.noCacheData && (session.estCacheReadTokens || 0) > 0
                  ? "未命中的新 tokens（官方 context 快照减去前缀重叠估算）"
                  : undefined
              }
            >
              {formatTokens(uncachedInputOf(session))}
            </div>
          </div>
          <div className="metric">
            <div className="m-label">Output</div>
            <div className="m-value">{formatTokens(session.outputTokens)}</div>
          </div>
          <div className="metric">
            <div className="m-label">速度</div>
            <div
              className="m-value"
              style={{ fontSize: 16 }}
              title="(Output + Reasoning) ÷ 模型请求耗时（含首 token）"
            >
              {formatTokPerSec(
                tokensPerSec(session.genTokens, session.genMs),
                tokensPerSec(session.estGenTokens, session.estGenMs)
              )}
            </div>
          </div>
          <div className="metric">
            <div className="m-label">Cache</div>
            <div
              className="m-value"
              title={
                session.cacheReadTokens > 0 &&
                (session.estCacheReadTokens || 0) > 0
                  ? "主数字为官方 Cache Read。括号内为前缀重叠估算"
                  : session.noCacheData && (session.estCacheReadTokens || 0) > 0
                    ? "本地无官方 cache。括号内为相邻请求 context 前缀重叠估算"
                    : undefined
              }
            >
              {formatCacheRead(session.cacheReadTokens, session.estCacheReadTokens)}
            </div>
          </div>
          <div className="metric">
            <div className="m-label">命中</div>
            <div
              className="m-value"
              title={
                session.noCacheData
                  ? "本地无官方 cache，不计入汇总。括号内为相邻请求 context 前缀重叠估算"
                  : (session.estCacheReadTokens || 0) > 0
                    ? "主数字为官方命中率。括号内为前缀重叠估算"
                    : "Cache Read ÷ (Input + Cache Read)"
              }
              style={{ fontSize: 16 }}
            >
              {(() => {
                const input = uncachedInputOf(session);
                const official = session.noCacheData
                  ? null
                  : (() => {
                      const inTok = Math.max(0, session.inputTokens || 0);
                      const cache = Math.max(0, session.cacheReadTokens || 0);
                      const d = inTok + cache;
                      return d > 0 ? cache / d : null;
                    })();
                const estAmt = Math.max(0, session.estCacheReadTokens || 0);
                const estDenom = input + estAmt;
                const est =
                  estAmt > 0 && estDenom > 0
                    ? Math.min(1, estAmt / estDenom)
                    : null;
                return formatHitRate(official, est);
              })()}
            </div>
          </div>
          <div className="metric">
            <div className="m-label">Reason</div>
            <div className="m-value">{formatTokens(session.reasoningTokens)}</div>
          </div>
          <div className="metric">
            <div className="m-label">质量</div>
            <div className="m-value" style={{ fontSize: 14 }}>
              {qualityLabel(session.quality)}
            </div>
          </div>
        </div>

        {session.dedupExcluded && (
          <div className="detail-banner warn" role="status">
            ⚠️ 此会话与另一工具的会话重复（sessionId 相同），token 未计入总额。
            {session.dedupKeptBy
              ? ` 保留计入的是：${session.dedupKeptBy.split(":")[0]}`
              : ""}
          </div>
        )}

        {session.mergedChildren && session.mergedChildren.length > 0 && (
          <section className="detail-section">
            <div className="card-title">已归并子会话</div>
            <div className="detail-tags">
              {session.mergedChildren.map((id) => (
                <span key={id} className="detail-tag">
                  {id.length > 16 ? `${id.slice(0, 8)}…${id.slice(-4)}` : id}
                </span>
              ))}
            </div>
          </section>
        )}

        <div className="detail-tabs" role="tablist" aria-label="明细视图">
          <button
            type="button"
            role="tab"
            aria-selected={tab === "usage"}
            className={`detail-tab ${tab === "usage" ? "active" : ""}`}
            onClick={() => setTab("usage")}
          >
            用量
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === "chat"}
            className={`detail-tab ${tab === "chat" ? "active" : ""}`}
            onClick={() => setTab("chat")}
          >
            对话
          </button>
        </div>

        {tab === "usage" && (
          <>
            {loading && <div className="muted pad">加载 turn 明细…</div>}
            {error && <div className="sync-msg err">{error}</div>}
            {detail?.note && <div className="sync-msg ok">{detail.note}</div>}

            {!loading && agents.length > 0 && (
              <section className="detail-section">
                <div className="card-title">Agent 用量</div>
                <table className="detail-table">
                  <thead>
                    <tr>
                      <th>Agent</th>
                      <th className="num">Turns</th>
                      <th className="num">Total</th>
                      <th className="num">Input</th>
                      <th className="num">Output</th>
                      <th className="num">Cache</th>
                      <th className="num">Reason</th>
                    </tr>
                  </thead>
                  <tbody>
                    {agents.map((a) => (
                      <tr key={a.agent}>
                        <td>
                          {a.isSubagent ? (
                            <span className="child-badge sub" title="子 agent">
                              {isPlaceholderAgent(a.agent)
                                ? "子"
                                : `子 · ${agentLabel(a.agent, { isSub: true, forSummary: true })}`}
                            </span>
                          ) : (
                            <span className="agent-badge" title="主会话 agent">
                              {agentLabel(a.agent, { forSummary: true })}
                            </span>
                          )}
                        </td>
                        <td className="num">{a.turns}</td>
                        <td className="num">{formatTokens(totalOfTrace(a))}</td>
                        <td className="num">{formatTokens(a.input)}</td>
                        <td className="num">{formatTokens(a.output)}</td>
                        <td className="num">
                          {formatCacheRead(a.cacheRead, a.estCache)}
                        </td>
                        <td className="num">
                          {formatTokens(a.reasoning || 0)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </section>
            )}

            {!loading && models.length > 0 && (
              <section className="detail-section">
                <div className="card-title">模型轨迹</div>
                <table className="detail-table">
                  <thead>
                    <tr>
                      <th>模型</th>
                      <th className="num">Turns</th>
                      <th className="num">Input</th>
                      <th className="num">Output</th>
                      <th className="num">Cache</th>
                    </tr>
                  </thead>
                  <tbody>
                    {models.map((m) => (
                      <tr key={m.model}>
                        <td>{prettyModel(m.model) || m.model}</td>
                        <td className="num">{m.turns}</td>
                        <td className="num">{formatTokens(m.input)}</td>
                        <td className="num">{formatTokens(m.output)}</td>
                        <td className="num">{formatCacheRead(m.cacheRead, m.estCache)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </section>
            )}

            {!loading && turns.length > 0 && (
              <section className="detail-section">
                <div className="card-title">
                  Turn / Loop 明细（{turns.length}
                  {detail?.childTurnCount
                    ? ` · 主 ${detail.parentTurnCount ?? turns.length - detail.childTurnCount} · 子 ${detail.childTurnCount}`
                    : ""}
                  ）
                </div>
                <div className="detail-turns">
                  <table className="detail-table sticky-head">
                    <thead>
                      <tr>
                        <th>#</th>
                        <th>来源</th>
                        <th>Agent</th>
                        <th>时间</th>
                        <th>模型</th>
                        <th className="num">Loop</th>
                        <th className="num">In</th>
                        <th className="num">Out</th>
                        <th className="num">速度</th>
                        <th className="num">Cache</th>
                        <th className="num">Reason</th>
                      </tr>
                    </thead>
                    <tbody>
                      {turns.map((t: TurnDetail) => (
                        <tr
                          key={`${t.index}-${t.sourceSessionId || ""}-${t.ts || ""}`}
                          className={t.isSubagent ? "turn-row-sub" : undefined}
                        >
                          <td>{t.index}</td>
                          <td>
                            {t.isSubagent ? (
                              <span
                                className="child-badge sub"
                                title={
                                  t.sourceSessionId
                                    ? `子会话 ${t.sourceSessionId}`
                                    : "子 agent"
                                }
                              >
                                子
                              </span>
                            ) : (
                              <span className="turn-src-main">主</span>
                            )}
                          </td>
                          <td>
                            {isPlaceholderAgent(t.agentName) ? (
                              <span className="muted" title="无 agent 名">
                                –
                              </span>
                            ) : (
                              <span
                                className={
                                  t.isSubagent
                                    ? "agent-badge sub"
                                    : "agent-badge"
                                }
                                title={
                                  t.sourceSessionId
                                    ? `session ${t.sourceSessionId}`
                                    : undefined
                                }
                              >
                                {agentLabel(t.agentName, {
                                  isSub: t.isSubagent,
                                })}
                              </span>
                            )}
                          </td>
                          <td className="muted">{formatTs(t.ts)}</td>
                          <td>
                            <ModelCell
                              model={t.model}
                              variant={t.modelVariant}
                            />
                          </td>
                          <td className="num">{t.loopIndex ?? "–"}</td>
                          <td
                            className="num"
                            title={
                              (t.estCacheReadTokens || 0) > 0
                                ? "未命中 input（context 快照 − 前缀重叠估算）"
                                : undefined
                            }
                          >
                            {formatTokens(t.inputTokens)}
                          </td>
                          <td className="num">{formatTokens(t.outputTokens)}</td>
                          <td
                            className="num"
                            title={
                              t.durationMs
                                ? `${(t.durationMs / 1000).toFixed(1)}s`
                                : t.estDurationMs
                                  ? `估算 ${(t.estDurationMs / 1000).toFixed(1)}s`
                                  : undefined
                            }
                          >
                            {formatTokPerSec(
                              tokensPerSec(
                                (t.outputTokens || 0) + (t.reasoningTokens || 0),
                                t.durationMs
                              ),
                              tokensPerSec(
                                (t.outputTokens || 0) + (t.reasoningTokens || 0),
                                t.estDurationMs
                              )
                            )}
                          </td>
                          <td
                            className="num"
                            title={
                              (t.estCacheReadTokens || 0) > 0
                                ? "本地无官方 cache。括号内为前缀重叠估算"
                                : undefined
                            }
                          >
                            {formatCacheRead(
                              t.cacheReadTokens,
                              t.estCacheReadTokens
                            )}
                          </td>
                          <td className="num">{formatTokens(t.reasoningTokens)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            )}

            {!loading && !error && turns.length === 0 && (
              <div className="muted pad">
                {session.quality === "no_model"
                  ? "该会话未调用模型（仅创建/注入系统提示），无 turn 明细。"
                  : "没有找到 turn 级用量记录。"}
              </div>
            )}
          </>
        )}

        {tab === "chat" && (
          <section className="detail-section chat-section">
            <div className="chat-toolbar">
              <div className="card-title" style={{ marginBottom: 0 }}>
                对话
                {messages.length > 0 ? ` · ${messages.length} 条` : ""}
                {transcript?.truncated ? " · 已截断超长内容" : ""}
              </div>
              <div className="chat-privacy muted">
                仅本机读取 · 不同步到云端
              </div>
            </div>

            {chatLoading && <div className="muted pad">加载对话…</div>}
            {chatError && <div className="sync-msg err">{chatError}</div>}
            {!chatLoading && transcript?.note && (
              <div className="sync-msg ok">{transcript.note}</div>
            )}
            {!chatLoading && transcript?.unsupported && (
              <div className="muted pad">{transcript.note || "暂不支持"}</div>
            )}

            {!chatLoading && !chatError && messages.length > 0 && (
              <div className="chat-stream">
                {messages.map((m) => (
                  <ChatBubble
                    key={`${m.index}-${m.id || ""}-${m.sourceSessionId || ""}`}
                    m={m}
                  />
                ))}
              </div>
            )}

            {!chatLoading &&
              !chatError &&
              chatLoaded &&
              messages.length === 0 &&
              !transcript?.unsupported && (
                <div className="muted pad">
                  没有可展示的对话正文。可能源日志已删，或该工具只保留了用量未保留消息。
                </div>
              )}
          </section>
        )}
        </div>
      </div>
    </div>
  );
}

function qualityLabel(q: string): string {
  switch (q) {
    case "full":
      return "完整";
    case "partial":
      return "部分";
    case "no_model":
      return "未调用模型";
    case "metadata_only":
      return "仅元数据";
    default:
      return q;
  }
}
