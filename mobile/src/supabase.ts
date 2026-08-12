import { createClient, type Session, type SupabaseClient } from "@supabase/supabase-js";
import { loadSettings, saveSettings } from "./storage";
import type { AppSettings, SnapshotRow } from "./types";

let client: SupabaseClient | null = null;
let clientKey = "";

function clientCacheKey(s: AppSettings) {
  return `${s.supabaseUrl}::${s.supabaseAnonKey.slice(0, 24)}`;
}

export function isConfigured(s?: AppSettings): boolean {
  const cfg = s || loadSettings();
  return !!(cfg.supabaseUrl && cfg.supabaseAnonKey);
}

export function getClient(): SupabaseClient {
  const cfg = loadSettings();
  if (!cfg.supabaseUrl || !cfg.supabaseAnonKey) {
    throw new Error("请先填写 Supabase URL 与 anon key");
  }
  const key = clientCacheKey(cfg);
  if (!client || clientKey !== key) {
    client = createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        storage: window.localStorage,
        storageKey: "token-stats-mobile-auth",
      },
    });
    clientKey = key;
  }
  return client;
}

/** 改配置后重建 client */
export function resetClient(settings: AppSettings) {
  saveSettings(settings);
  try {
    localStorage.removeItem("token-stats-mobile-auth");
  } catch {
    /* ignore */
  }
  client = null;
  clientKey = "";
}

export async function signIn(email: string, password: string) {
  const sb = getClient();
  const { data, error } = await sb.auth.signInWithPassword({
    email: email.trim(),
    password,
  });
  if (error) throw new Error(friendlyAuthError(error.message));
  if (!data.session) throw new Error("登录失败：未返回 session");
  return data.session;
}

export async function signUp(email: string, password: string) {
  const sb = getClient();
  const { data, error } = await sb.auth.signUp({
    email: email.trim(),
    password,
  });
  if (error) throw new Error(friendlyAuthError(error.message));
  if (!data.session) {
    throw new Error(
      "注册成功，但需要邮箱确认。请到 Supabase 关闭 Confirm email，或点邮件确认后再登录"
    );
  }
  return data.session;
}

export async function signOut() {
  try {
    const sb = getClient();
    await sb.auth.signOut();
  } catch {
    /* ignore */
  }
  try {
    localStorage.removeItem("token-stats-mobile-auth");
  } catch {
    /* ignore */
  }
}

export async function getSession(): Promise<Session | null> {
  if (!isConfigured()) return null;
  const sb = getClient();
  const { data, error } = await sb.auth.getSession();
  if (error) return null;
  return data.session;
}

export async function fetchSnapshot(): Promise<SnapshotRow | null> {
  const sb = getClient();
  const { data: userData, error: userErr } = await sb.auth.getUser();
  if (userErr || !userData.user) throw new Error("未登录或登录已过期");

  const { data, error } = await sb
    .from("usage_snapshots")
    .select("user_id,payload,session_count,total_tokens,cost_usd,device_label,updated_at")
    .eq("user_id", userData.user.id)
    .maybeSingle();

  if (error) throw new Error(`读取失败：${error.message}`);
  return (data as SnapshotRow) || null;
}

function friendlyAuthError(msg: string): string {
  if (/invalid login credentials/i.test(msg)) {
    return "邮箱或密码错误。请用桌面端已注册的同一账号登录";
  }
  return msg;
}
