/** 顶栏模糊搜索：打分 + 按模型 / 工具 / 会话 / 路径分组。 */

import { modelAggKey } from "./types";

export type SearchGroupId = "model" | "client" | "session" | "path";

export type SearchableSession = {
  client: string;
  sessionId: string;
  title?: string;
  cwd?: string;
  model?: string;
  agentName?: string;
  lastUsedAt?: string;
};

export type SearchDrill =
  | { kind: "client"; id: string }
  | { kind: "model"; model: string }
  | { kind: "project"; cwd: string; label?: string };

export type SearchHitAction =
  | { type: "session"; client: string; sessionId: string }
  | { type: "drill"; drill: SearchDrill };

export type SearchHit = {
  group: SearchGroupId;
  id: string;
  label: string;
  hint?: string;
  score: number;
  action: SearchHitAction;
};

export type SearchSuggestionGroup = {
  group: SearchGroupId;
  title: string;
  hits: SearchHit[];
};

const MAX_PER_GROUP = 8;

const GROUP_ORDER: { group: SearchGroupId; title: string }[] = [
  { group: "model", title: "模型" },
  { group: "client", title: "工具" },
  { group: "session", title: "会话" },
  { group: "path", title: "路径" },
];

export function stripVariantSuffix(s: string): string {
  return String(s).replace(/\s*·\s*.+$/, "").trim();
}

export function compactKey(s: string): string {
  return stripVariantSuffix(s)
    .toLowerCase()
    .replace(/[/_\-.\[\]\s]+/g, "");
}

function pathBasename(cwd?: string): string {
  if (!cwd) return "";
  const parts = cwd.replace(/\\/g, "/").split("/").filter(Boolean);
  return parts[parts.length - 1] || cwd;
}

/**
 * 单字段模糊分。0 = 不命中。
 * 相等 100 / 前缀 90 / 包含 80−位置 / 子序列 50−空隙。
 */
export function fuzzyScore(
  query: string,
  text: string | undefined | null
): number {
  if (text == null) return 0;
  const q = String(query).trim().toLowerCase();
  if (!q) return 0;
  const raw = stripVariantSuffix(String(text)).toLowerCase();
  if (!raw) return 0;
  const qc = q.replace(/[/_\-.\[\]\s]+/g, "");
  const tc = compactKey(text);
  if (!qc) return 0;

  if (raw === q || tc === qc) return 100;
  if (raw.startsWith(q) || (tc && tc.startsWith(qc))) return 90;

  const idx = raw.indexOf(q);
  if (idx >= 0) return Math.max(1, 80 - Math.min(idx, 40));
  const cidx = tc.indexOf(qc);
  if (cidx >= 0) return Math.max(1, 78 - Math.min(cidx, 40));

  let ti = 0;
  let gaps = 0;
  let last = -1;
  for (const ch of qc) {
    const found = tc.indexOf(ch, ti);
    if (found < 0) return 0;
    if (last >= 0) gaps += found - last - 1;
    last = found;
    ti = found + 1;
  }
  return Math.max(1, 50 - Math.min(gaps, 40));
}

function clientDisplay(
  id: string,
  labels: Record<string, string>
): string {
  return labels[id] || id;
}

export function sessionSearchFields(
  s: SearchableSession,
  labels: Record<string, string>
): string[] {
  return [
    s.client,
    clientDisplay(s.client, labels),
    s.title,
    s.cwd,
    pathBasename(s.cwd),
    s.model,
    s.sessionId,
    s.agentName,
  ].filter((x): x is string => !!x);
}

/** 会话是否被当前搜索词命中（列表 / 热力图 / 下拉同源）。 */
export function matchesSession(
  s: SearchableSession,
  query: string,
  labels: Record<string, string>
): boolean {
  const q = query.trim();
  if (!q) return true;
  return sessionSearchFields(s, labels).some((f) => fuzzyScore(q, f) > 0);
}

function takeTop(hits: SearchHit[]): SearchHit[] {
  return hits
    .sort((a, b) => b.score - a.score || a.label.localeCompare(b.label))
    .slice(0, MAX_PER_GROUP);
}

export function buildSearchSuggestions(
  sessions: SearchableSession[],
  query: string,
  labels: Record<string, string>
): SearchSuggestionGroup[] {
  const q = query.trim();
  if (!q) return [];

  const models = new Map<string, { score: number; count: number }>();
  const clients = new Map<
    string,
    { score: number; label: string }
  >();
  const paths = new Map<
    string,
    { score: number; base: string; cwd: string }
  >();
  const sessionHits: (SearchHit & { lastUsedAt: string })[] = [];

  for (const s of sessions) {
    const model = modelAggKey(s.model) || stripVariantSuffix(s.model || "");
    if (model) {
      const sc = Math.max(fuzzyScore(q, model), fuzzyScore(q, s.model));
      if (sc > 0) {
        const prev = models.get(model);
        if (!prev) models.set(model, { score: sc, count: 1 });
        else {
          prev.count += 1;
          if (sc > prev.score) prev.score = sc;
        }
      }
    }

    const cLabel = clientDisplay(s.client, labels);
    const cScore = Math.max(fuzzyScore(q, s.client), fuzzyScore(q, cLabel));
    if (cScore > 0) {
      const prev = clients.get(s.client);
      if (!prev || cScore > prev.score) {
        clients.set(s.client, { score: cScore, label: cLabel });
      }
    }

    if (s.cwd) {
      const base = pathBasename(s.cwd);
      const pScore = Math.max(fuzzyScore(q, s.cwd), fuzzyScore(q, base));
      if (pScore > 0) {
        const key = s.cwd.replace(/\\/g, "/").toLowerCase();
        const prev = paths.get(key);
        if (!prev || pScore > prev.score) {
          paths.set(key, { score: pScore, base: base || s.cwd, cwd: s.cwd });
        }
      }
    }

    const title = (s.title || "").trim() || s.sessionId.slice(0, 12);
    const sScore = Math.max(
      fuzzyScore(q, s.title),
      fuzzyScore(q, s.sessionId),
      fuzzyScore(q, s.agentName)
    );
    if (sScore > 0) {
      sessionHits.push({
        group: "session",
        id: `${s.client}:${s.sessionId}`,
        label: title,
        hint: [cLabel, model].filter(Boolean).join(" · "),
        score: sScore,
        lastUsedAt: s.lastUsedAt || "",
        action: { type: "session", client: s.client, sessionId: s.sessionId },
      });
    }
  }

  const byGroup: Record<SearchGroupId, SearchHit[]> = {
    model: [...models.entries()].map(([name, v]) => ({
      group: "model",
      id: `model:${name}`,
      label: name,
      hint: `${v.count} 个会话`,
      score: v.score,
      action: { type: "drill", drill: { kind: "model", model: name } },
    })),
    client: [...clients.entries()].map(([id, v]) => ({
      group: "client",
      id: `client:${id}`,
      label: v.label,
      hint: id,
      score: v.score,
      action: { type: "drill", drill: { kind: "client", id } },
    })),
    session: sessionHits
      .sort(
        (a, b) =>
          b.score - a.score || b.lastUsedAt.localeCompare(a.lastUsedAt)
      )
      .slice(0, MAX_PER_GROUP),
    path: [...paths.values()].map((v) => ({
      group: "path",
      id: `path:${v.cwd}`,
      label: v.base,
      hint: v.cwd,
      score: v.score,
      action: {
        type: "drill",
        drill: { kind: "project", cwd: v.cwd, label: v.base },
      },
    })),
  };

  return GROUP_ORDER.map(({ group, title }) => ({
    group,
    title,
    hits: group === "session" ? byGroup[group] : takeTop(byGroup[group]),
  })).filter((g) => g.hits.length > 0);
}
