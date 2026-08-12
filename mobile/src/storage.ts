import type { AppSettings } from "./types";

const SETTINGS_KEY = "token-stats-mobile:settings";

export function loadSettings(): AppSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return { supabaseUrl: "", supabaseAnonKey: "" };
    const o = JSON.parse(raw) as AppSettings;
    return {
      supabaseUrl: String(o.supabaseUrl || "").trim(),
      supabaseAnonKey: String(o.supabaseAnonKey || "").trim(),
    };
  } catch {
    return { supabaseUrl: "", supabaseAnonKey: "" };
  }
}

export function saveSettings(s: AppSettings) {
  localStorage.setItem(
    SETTINGS_KEY,
    JSON.stringify({
      supabaseUrl: s.supabaseUrl.trim(),
      supabaseAnonKey: s.supabaseAnonKey.trim(),
    })
  );
}
