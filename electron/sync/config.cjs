const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

/**
 * Prefer Electron userData when app is ready; fall back for CLI/tests.
 * @param {string} [userDataPath]
 */
function configPath(userDataPath) {
  const base =
    userDataPath ||
    process.env.TOKEN_STATS_CONFIG_DIR ||
    path.join(os.homedir(), ".token-stats");
  return path.join(base, "config.json");
}

/**
 * @typedef {{
 *   supabaseUrl?: string,
 *   supabaseAnonKey?: string,
 *   authSession?: object | null,
 *   lastSyncAt?: string | null,
 *   deviceLabel?: string | null,
 * }} SyncConfig
 */

/** @returns {SyncConfig} */
function defaultConfig() {
  return {
    supabaseUrl: "",
    supabaseAnonKey: "",
    authSession: null,
    lastSyncAt: null,
    deviceLabel: os.hostname() || null,
  };
}

/**
 * @param {string} [userDataPath]
 * @returns {SyncConfig}
 */
function loadConfig(userDataPath) {
  const file = configPath(userDataPath);
  try {
    if (!fs.existsSync(file)) return defaultConfig();
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    return {
      ...defaultConfig(),
      ...raw,
      supabaseUrl: String(raw.supabaseUrl || "").trim(),
      supabaseAnonKey: String(raw.supabaseAnonKey || "").trim(),
    };
  } catch {
    return defaultConfig();
  }
}

/**
 * @param {Partial<SyncConfig>} patch
 * @param {string} [userDataPath]
 * @returns {SyncConfig}
 */
function saveConfig(patch, userDataPath) {
  const file = configPath(userDataPath);
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const next = { ...loadConfig(userDataPath), ...patch };
  // never write empty-string keys over accidental undefined wipe unless intentional
  if (patch.supabaseUrl !== undefined) next.supabaseUrl = String(patch.supabaseUrl || "").trim();
  if (patch.supabaseAnonKey !== undefined)
    next.supabaseAnonKey = String(patch.supabaseAnonKey || "").trim();
  fs.writeFileSync(file, JSON.stringify(next, null, 2), "utf8");
  return next;
}

/**
 * Public view for renderer (mask key slightly for display safety is optional — full key needed for re-save UX).
 * We return full config; file is local-only.
 * @param {string} [userDataPath]
 */
function getPublicConfig(userDataPath) {
  const c = loadConfig(userDataPath);
  return {
    supabaseUrl: c.supabaseUrl || "",
    supabaseAnonKey: c.supabaseAnonKey || "",
    lastSyncAt: c.lastSyncAt || null,
    deviceLabel: c.deviceLabel || null,
    hasSession: !!(c.authSession && c.authSession.access_token),
    email: c.authSession?.user?.email || null,
    userId: c.authSession?.user?.id || null,
  };
}

module.exports = {
  configPath,
  loadConfig,
  saveConfig,
  getPublicConfig,
  defaultConfig,
};
