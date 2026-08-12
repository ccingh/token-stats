import { useCallback, useEffect, useState } from "react";
import type { ScanResult } from "./types";
import type { SyncConfigPublic, SyncIpcResult } from "./vite-env";

type Props = {
  open: boolean;
  onClose: () => void;
  scanResult: ScanResult | null;
  onNeedScan: () => Promise<ScanResult | null>;
};

function formatRelative(iso?: string | null): string {
  if (!iso) return "从未";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const diff = Date.now() - d.getTime();
  const min = Math.floor(diff / 60_000);
  if (min < 1) return "刚刚";
  if (min < 60) return `${min} 分钟前`;
  const hours = Math.floor(min / 60);
  if (hours < 24) return `${hours} 小时前`;
  return d.toLocaleString();
}

export default function SyncPanel({ open, onClose, scanResult, onNeedScan }: Props) {
  const [config, setConfig] = useState<SyncConfigPublic | null>(null);
  const [url, setUrl] = useState("");
  const [anonKey, setAnonKey] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const applyConfig = useCallback((c: SyncConfigPublic) => {
    setConfig(c);
    setUrl(c.supabaseUrl || "");
    setAnonKey(c.supabaseAnonKey || "");
    if (c.email) setEmail(c.email);
  }, []);

  const refresh = useCallback(async () => {
    if (!window.tokenStats?.sync) {
      setError("同步仅在 Electron 桌面端可用");
      return;
    }
    const res = (await window.tokenStats.sync.getConfig()) as SyncIpcResult<{
      config: SyncConfigPublic;
    }>;
    if (!res.ok) {
      setError(res.error || "读取配置失败");
      return;
    }
    if (res.config) applyConfig(res.config);
  }, [applyConfig]);

  useEffect(() => {
    if (!open) return;
    setMessage(null);
    setError(null);
    void refresh();
  }, [open, refresh]);

  async function saveSettings() {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const res = (await window.tokenStats!.sync!.saveConfig({
        supabaseUrl: url.trim(),
        supabaseAnonKey: anonKey.trim(),
      })) as SyncIpcResult<{ config: SyncConfigPublic }>;
      if (!res.ok) throw new Error(res.error);
      if (res.config) applyConfig(res.config);
      setMessage("配置已保存");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function doAuth(mode: "login" | "signup") {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      await window.tokenStats!.sync!.saveConfig({
        supabaseUrl: url.trim(),
        supabaseAnonKey: anonKey.trim(),
      });
      const res = (await window.tokenStats!.sync!.signIn({
        email: email.trim(),
        password,
        mode,
      })) as SyncIpcResult<{ config: SyncConfigPublic; email?: string }>;
      if (!res.ok) throw new Error(res.error);
      if (res.config) applyConfig(res.config);
      setMessage(mode === "signup" ? "注册并登录成功" : `已登录 ${res.email || email}`);
      setPassword("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function doSignOut() {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const res = (await window.tokenStats!.sync!.signOut()) as SyncIpcResult<{
        config: SyncConfigPublic;
      }>;
      if (!res.ok) throw new Error(res.error);
      if (res.config) applyConfig(res.config);
      setMessage("已退出登录");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function doUpload() {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      let data = scanResult;
      if (!data || !Array.isArray(data.sessions) || data.sessions.length === 0) {
        setMessage("正在扫描…");
        data = await onNeedScan();
      }
      if (!data) throw new Error("扫描失败，无法上传");
      const res = (await window.tokenStats!.sync!.upload(data)) as SyncIpcResult<{
        config: SyncConfigPublic;
        sessionCount?: number;
        totalTokens?: number;
        lastSyncAt?: string;
      }>;
      if (!res.ok) throw new Error(res.error);
      if (res.config) applyConfig(res.config);
      setMessage(
        `上传成功：${res.sessionCount ?? "?"} 会话 · ${formatTokens(res.totalTokens ?? 0)} · ${formatRelative(res.lastSyncAt)}`
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  if (!open) return null;

  const loggedIn = !!config?.hasSession;

  return (
    <div className="sync-overlay" role="dialog" aria-modal="true" aria-label="云同步">
      <div className="sync-panel">
        <div className="sync-head">
          <div>
            <div className="sync-title">云同步 · Supabase</div>
            <div className="sync-sub">
              邮箱登录后上传统计快照（仅 token / 成本，不含对话正文）
            </div>
          </div>
          <button type="button" className="btn ghost" onClick={onClose} disabled={busy}>
            关闭
          </button>
        </div>

        <section className="sync-section">
          <div className="sync-section-title">1. 项目配置</div>
          <p className="sync-hint">
            ① SQL Editor 执行 <code>supabase/schema.sql</code>
            <br />
            ② Authentication → Providers → Email 开启；自用建议关闭 Confirm email
            <br />
            ③ 粘贴 Project URL 与 anon public key
          </p>
          <label className="sync-label">
            Project URL
            <input
              className="sync-input"
              placeholder="https://xxxx.supabase.co"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              disabled={busy}
              autoComplete="off"
            />
          </label>
          <label className="sync-label">
            anon key
            <input
              className="sync-input"
              placeholder="eyJhbGciOi…"
              value={anonKey}
              onChange={(e) => setAnonKey(e.target.value)}
              disabled={busy}
              autoComplete="off"
              spellCheck={false}
            />
          </label>
          <button type="button" className="btn ghost" onClick={() => void saveSettings()} disabled={busy}>
            保存配置
          </button>
        </section>

        <section className="sync-section">
          <div className="sync-section-title">2. 账号</div>
          {loggedIn ? (
            <div className="sync-logged">
              <span>
                已登录 <strong>{config?.email || "—"}</strong>
              </span>
              <button type="button" className="btn ghost" onClick={() => void doSignOut()} disabled={busy}>
                退出
              </button>
            </div>
          ) : (
            <>
              <label className="sync-label">
                邮箱
                <input
                  className="sync-input"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  disabled={busy}
                  autoComplete="username"
                  placeholder="可用真实邮箱，或 me@local.dev"
                />
              </label>
              <label className="sync-label">
                密码（至少 6 位）
                <input
                  className="sync-input"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  disabled={busy}
                  autoComplete="current-password"
                />
              </label>
              <div className="sync-actions">
                <button
                  type="button"
                  className="btn primary"
                  onClick={() => void doAuth("login")}
                  disabled={busy}
                >
                  登录
                </button>
                <button
                  type="button"
                  className="btn ghost"
                  onClick={() => void doAuth("signup")}
                  disabled={busy}
                >
                  注册
                </button>
              </div>
              <p className="sync-hint">
                第一次用点「注册」。Confirm email 关掉后，邮箱可以随便写（如{" "}
                <code>me@local.dev</code>），不必真能收信。
              </p>
            </>
          )}
        </section>

        <section className="sync-section">
          <div className="sync-section-title">3. 上传快照</div>
          <p className="sync-hint">
            上次同步：{formatRelative(config?.lastSyncAt)}
            {scanResult
              ? ` · 当前本地 ${scanResult.sessions.length} 会话 · ${formatTokens(scanResult.totals.totalTokens)}`
              : " · 尚无扫描结果（上传时会自动扫描）"}
          </p>
          <button
            type="button"
            className="btn primary"
            onClick={() => void doUpload()}
            disabled={busy || !loggedIn}
          >
            {busy ? "处理中…" : "上传到云端"}
          </button>
        </section>

        {message && <div className="sync-msg ok">{message}</div>}
        {error && <div className="sync-msg err">{error}</div>}
      </div>
    </div>
  );
}

function formatTokens(n: number): string {
  if (!Number.isFinite(n)) return "–";
  if (Math.abs(n) >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)}B`;
  if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (Math.abs(n) >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(Math.round(n));
}
