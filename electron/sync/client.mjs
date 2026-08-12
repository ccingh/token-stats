/**
 * Supabase auth + snapshot upload for Token Stats.
 * 邮箱 + 密码登录；session 保存在本机 config。
 * Loaded via dynamic import from Electron main (CJS).
 */
import { createClient } from "@supabase/supabase-js";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { loadConfig, saveConfig } = require("./config.cjs");

/**
 * @param {string} [userDataPath]
 */
function getClient(userDataPath) {
  const cfg = loadConfig(userDataPath);
  if (!cfg.supabaseUrl || !cfg.supabaseAnonKey) {
    throw new Error("请先配置 Supabase URL 与 anon key");
  }
  const client = createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });
  if (cfg.authSession?.access_token) {
    void client.auth.setSession({
      access_token: cfg.authSession.access_token,
      refresh_token: cfg.authSession.refresh_token,
    });
  }
  return { client, cfg };
}

/**
 * @param {import('@supabase/supabase-js').Session | null} session
 * @param {string} [userDataPath]
 */
function persistSession(session, userDataPath) {
  if (!session) {
    saveConfig({ authSession: null }, userDataPath);
    return;
  }
  saveConfig(
    {
      authSession: {
        access_token: session.access_token,
        refresh_token: session.refresh_token,
        expires_at: session.expires_at,
        expires_in: session.expires_in,
        token_type: session.token_type,
        user: {
          id: session.user?.id,
          email: session.user?.email || null,
        },
      },
    },
    userDataPath
  );
}

/**
 * @param {string} [userDataPath]
 */
async function ensureSession(userDataPath) {
  const { client, cfg } = getClient(userDataPath);
  if (!cfg.authSession?.access_token) {
    throw new Error("未登录：请先使用邮箱登录");
  }

  const { data: userData, error: userErr } = await client.auth.getUser();
  if (!userErr && userData?.user) {
    return { client, user: userData.user, cfg };
  }

  if (cfg.authSession.refresh_token) {
    const { data, error } = await client.auth.refreshSession({
      refresh_token: cfg.authSession.refresh_token,
    });
    if (error || !data.session) {
      persistSession(null, userDataPath);
      throw new Error(`登录已过期，请重新登录：${error?.message || "no session"}`);
    }
    persistSession(data.session, userDataPath);
    return { client, user: data.session.user, cfg: loadConfig(userDataPath) };
  }

  persistSession(null, userDataPath);
  throw new Error("登录已过期，请重新登录");
}

/**
 * 邮箱登录或注册。
 * @param {{ email: string, password: string, mode?: 'login' | 'signup' }} opts
 * @param {string} [userDataPath]
 */
export async function signIn(opts, userDataPath) {
  const email = String(opts?.email || "").trim();
  const password = String(opts?.password || "");
  if (!email || !password) throw new Error("请填写邮箱和密码");

  const { client } = getClient(userDataPath);
  const mode = opts?.mode === "signup" ? "signup" : "login";

  let result;
  if (mode === "signup") {
    result = await client.auth.signUp({ email, password });
  } else {
    result = await client.auth.signInWithPassword({ email, password });
  }

  if (result.error) {
    const msg = result.error.message || String(result.error);
    if (/invalid login credentials/i.test(msg)) {
      throw new Error(
        "邮箱或密码错误。若是第一次用请点「注册」；若已注册请核对密码，并确认 Auth 里已关闭邮箱确认或已点邮件确认"
      );
    }
    throw new Error(msg);
  }
  if (!result.data.session) {
    throw new Error(
      mode === "signup"
        ? "注册成功，但需要邮箱确认后才能登录：请到 Supabase → Authentication → Providers → Email 关闭 Confirm email，或去邮箱点确认链接后再登录"
        : "登录失败：未返回 session"
    );
  }
  persistSession(result.data.session, userDataPath);
  return {
    ok: true,
    email: result.data.session.user.email,
    userId: result.data.session.user.id,
  };
}

/**
 * @param {string} [userDataPath]
 */
export async function signOut(userDataPath) {
  try {
    const { client } = getClient(userDataPath);
    await client.auth.signOut();
  } catch {
    /* ignore */
  }
  persistSession(null, userDataPath);
  return { ok: true };
}

/**
 * @param {any} scanResult
 */
export function buildPayload(scanResult) {
  const sessions = Array.isArray(scanResult?.sessions)
    ? scanResult.sessions.map((s) => ({
        id: s.id,
        client: s.client,
        sessionId: s.sessionId,
        title: s.title,
        cwd: s.cwd,
        model: s.model,
        startedAt: s.startedAt,
        lastUsedAt: s.lastUsedAt,
        messageCount: s.messageCount,
        inputTokens: s.inputTokens ?? 0,
        outputTokens: s.outputTokens ?? 0,
        cacheReadTokens: s.cacheReadTokens ?? 0,
        cacheWriteTokens: s.cacheWriteTokens ?? 0,
        reasoningTokens: s.reasoningTokens ?? 0,
        totalTokens: s.totalTokens ?? 0,
        costUsd: s.costUsd,
        costCny: s.costCny,
        quality: s.quality,
        scannedAt: s.scannedAt,
        // 并账 / 持久化元数据（手机端筛选与角标用）
        parentSessionId: s.parentSessionId,
        isSubagent: s.isSubagent,
        agentName: s.agentName,
        sessionKind: s.sessionKind,
        turnCount: s.turnCount,
        requestCount: s.requestCount,
        mergedChildren: s.mergedChildren,
        childCount: s.childCount,
        deleted: s.deleted,
        deletedAt: s.deletedAt,
        synthetic: s.synthetic,
        firstSeenAt: s.firstSeenAt,
        lastSeenAt: s.lastSeenAt,
        // 去重标记（手机端暂不展示，先随快照下发）
        dedupExcluded: s.dedupExcluded,
        dedupReason: s.dedupReason,
        dedupKeptBy: s.dedupKeptBy,
      }))
    : [];

  // 小时桶：趋势图 / 热力图 / 环比（体积可控，全量上传）
  const hourly = Array.isArray(scanResult?.hourly)
    ? scanResult.hourly.map((h) => ({
        hour: h.hour,
        client: h.client,
        model: h.model,
        sessionId: h.sessionId,
        inputTokens: h.inputTokens ?? 0,
        outputTokens: h.outputTokens ?? 0,
        cacheReadTokens: h.cacheReadTokens ?? 0,
        cacheWriteTokens: h.cacheWriteTokens ?? 0,
        reasoningTokens: h.reasoningTokens ?? 0,
        totalTokens: h.totalTokens ?? 0,
        events: h.events,
        costUsd: h.costUsd,
        costCny: h.costCny,
      }))
    : [];

  return {
    scannedAt: scanResult?.scannedAt || new Date().toISOString(),
    durationMs: scanResult?.durationMs ?? 0,
    reports: scanResult?.reports || [],
    totals: scanResult?.totals || {},
    sessions,
    hourly,
    appVersion: "1.1.1",
  };
}

/**
 * @param {any} scanResult
 * @param {string} [userDataPath]
 */
export async function uploadSnapshot(scanResult, userDataPath) {
  if (!scanResult || scanResult.error) {
    throw new Error(scanResult?.error || "没有可上传的扫描结果，请先扫描");
  }
  if (!Array.isArray(scanResult.sessions)) {
    throw new Error("扫描结果格式无效");
  }

  const { client, user, cfg } = await ensureSession(userDataPath);
  const payload = buildPayload(scanResult);
  const sessionCount = payload.sessions.length;
  const totalTokens = Number(payload.totals?.totalTokens) || 0;
  const costUsd =
    payload.totals?.costUsd != null ? Number(payload.totals.costUsd) : null;

  const row = {
    user_id: user.id,
    payload,
    session_count: sessionCount,
    total_tokens: totalTokens,
    cost_usd: costUsd,
    device_label: cfg.deviceLabel || null,
    updated_at: new Date().toISOString(),
  };

  const { error } = await client.from("usage_snapshots").upsert(row, {
    onConflict: "user_id",
  });
  if (error) throw new Error(`上传失败：${error.message}`);

  const lastSyncAt = row.updated_at;
  saveConfig({ lastSyncAt }, userDataPath);

  return {
    ok: true,
    lastSyncAt,
    sessionCount,
    totalTokens,
    costUsd,
    userId: user.id,
    email: user.email,
  };
}
