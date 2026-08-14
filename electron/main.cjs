const { app, BrowserWindow, ipcMain, net } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const { spawn } = require("node:child_process");
const {
  getPublicConfig,
  saveConfig,
  loadConfig,
} = require("./sync/config.cjs");
const { enableSync } = require("./features.cjs");

/** @type {BrowserWindow | null} */
let mainWindow = null;

const isDev = !app.isPackaged;

/**
 * 项目根目录（开发：repo 根；打包：resources/app 或 asar.unpacked）。
 * 扫描脚本在 asar 外执行，需把 app.asar → app.asar.unpacked。
 */
function appRoot() {
  let root = path.join(__dirname, "..");
  if (root.includes("app.asar")) {
    root = root.replace("app.asar", "app.asar.unpacked");
  }
  return root;
}

function userDataDir() {
  try {
    return app.getPath("userData");
  } catch {
    return undefined;
  }
}

/**
 * Run scanner with system Node (has stable node:sqlite on Node 22+/24).
 * Avoids Electron-bundled Node sqlite quirks.
 */
function runScan(opts) {
  return new Promise((resolve) => {
    const root = appRoot();
    const script = path.join(root, "electron", "scan-full.mjs");
    const args = [script];
    if (opts?.clients?.length) {
      args.push(`--clients=${opts.clients.join(",")}`);
    }

    const ud = userDataDir();
    const child = spawn("node", args, {
      cwd: root,
      windowsHide: true,
      env: {
        ...process.env,
        // 会话持久化与 sync 配置同一目录（Electron userData）
        ...(ud ? { TOKEN_STATS_CONFIG_DIR: ud } : {}),
      },
    });

    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (err) => {
      resolve(emptyError(err.message));
    });
    child.on("close", (code) => {
      if (code !== 0 && !stdout) {
        resolve(emptyError(stderr || `scan exited ${code}`));
        return;
      }
      try {
        const data = JSON.parse(stdout);
        if (stderr) data.scanLog = stderr.slice(0, 2000);
        resolve(data);
      } catch (err) {
        resolve(
          emptyError(
            `parse scan output failed: ${err instanceof Error ? err.message : String(err)}\n${stderr || stdout.slice(0, 500)}`
          )
        );
      }
    });
  });
}

function emptyError(message) {
  return {
    error: message,
    scannedAt: new Date().toISOString(),
    durationMs: 0,
    reports: [],
    totals: {
      sessions: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      totalTokens: 0,
      costUsd: 0,
    },
    sessions: [],
    unpricedModels: [],
  };
}

async function loadSyncClient() {
  return import("./sync/client.mjs");
}

function okResult(data) {
  return { ok: true, ...data };
}

function errResult(err) {
  return {
    ok: false,
    error: err instanceof Error ? err.message : String(err),
  };
}

/**
 * 窗口/任务栏图标。
 * 注意：main 在 asarUnpack 的 electron/ 下，assets 默认在 asar 内；
 * appRoot() 会指到 unpacked，不能只拼 appRoot()+assets。
 */
function resolveAppIcon() {
  const files = ["icon.ico", "icon.png", "icon-256.png"];
  /** @type {string[]} */
  const dirs = [];
  // 开发：repo/assets/icons
  dirs.push(path.join(__dirname, "..", "assets", "icons"));
  // 打包：图标 asarUnpack 后的真实路径
  dirs.push(path.join(appRoot(), "assets", "icons"));
  // 打包：仍在 asar 内时（Electron 可读 asar 路径）
  if (app.isPackaged) {
    dirs.push(path.join(process.resourcesPath, "app.asar", "assets", "icons"));
    const asarSibling = path
      .join(__dirname, "..", "assets", "icons")
      .replace(/app\.asar\.unpacked/g, "app.asar");
    dirs.push(asarSibling);
  }
  for (const dir of dirs) {
    for (const name of files) {
      const p = path.join(dir, name);
      try {
        if (fs.existsSync(p)) return p;
      } catch {
        /* ignore */
      }
    }
  }
  return undefined;
}

async function createWindow() {
  const iconPath = resolveAppIcon();
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 900,
    minHeight: 560,
    title: "Token Stats",
    backgroundColor: "#0a0a0b",
    icon: iconPath,
    autoHideMenuBar: true,
    // 标题栏内嵌：窗口控制按钮叠加在应用顶栏上，去掉原生菜单栏和标题栏
    titleBarStyle: "hidden",
    titleBarOverlay: {
      color: "#0a0a0b",
      symbolColor: "#a1a1aa",
      height: 40,
    },
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  const devUrl = "http://127.0.0.1:5173";
  // UI 在 asar 内即可 loadFile
  const distFile = path.join(__dirname, "..", "dist", "index.html");

  const loadDist = () => {
    if (fs.existsSync(distFile)) {
      void mainWindow.loadFile(distFile);
    } else {
      void mainWindow.loadURL(
        "data:text/html;charset=utf-8," +
          encodeURIComponent(
            '<body style="background:#0a0a0b;color:#a1a1aa;font:14px system-ui;display:flex;height:100vh;margin:0;align-items:center;justify-content:center">' +
              "未找到 dist 构建产物。请先运行 npm run build，或用 npm run dev 启动桌面端。" +
              "</body>"
          )
      );
    }
  };

  let fellBack = false;
  mainWindow.webContents.on("did-fail-load", () => {
    if (!fellBack) {
      fellBack = true;
      loadDist();
    }
  });

  let devUp = false;
  try {
    await net.fetch(devUrl);
    devUp = true;
  } catch {
    devUp = false;
  }

  if (isDev && devUp) {
    void mainWindow.loadURL(devUrl);
  } else {
    loadDist();
  }

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

function registerIpc() {
  ipcMain.handle("scan:run", async (_evt, opts) => runScan(opts || {}));

  ipcMain.handle("pricing:get", async () => {
    try {
      const pricing = await import("./scanner/pricing.js");
      const ov = await import("./scanner/pricing-overrides.js");
      const builtinKeys = pricing.getBuiltinKeys();
      const loaded = ov.loadPriceOverrides(userDataDir(), { builtinKeys });
      pricing.applyPriceOverrides(loaded.overrides);
      return okResult({
        overrides: loaded.overrides,
        catalog: pricing.getPricingCatalog(),
        loadError: loaded.error,
        path: loaded.path,
      });
    } catch (err) {
      return errResult(err);
    }
  });

  ipcMain.handle("pricing:save", async (_evt, payload) => {
    try {
      const pricing = await import("./scanner/pricing.js");
      const ov = await import("./scanner/pricing-overrides.js");
      const builtinKeys = pricing.getBuiltinKeys();
      const saved = ov.savePriceOverrides(payload, userDataDir(), { builtinKeys });
      pricing.applyPriceOverrides(saved);
      return okResult({
        overrides: saved,
        catalog: pricing.getPricingCatalog(),
        loadError: null,
        path: ov.overridesPath(userDataDir()),
      });
    } catch (err) {
      return errResult(err);
    }
  });

  if (enableSync) {
    ipcMain.handle("sync:getConfig", async () => {
      try {
        return okResult({ config: getPublicConfig(userDataDir()) });
      } catch (err) {
        return errResult(err);
      }
    });

    ipcMain.handle("sync:saveConfig", async (_evt, patch) => {
      try {
        const dir = userDataDir();
        saveConfig(
          {
            supabaseUrl: patch?.supabaseUrl,
            supabaseAnonKey: patch?.supabaseAnonKey,
            deviceLabel: patch?.deviceLabel,
          },
          dir
        );
        return okResult({ config: getPublicConfig(dir) });
      } catch (err) {
        return errResult(err);
      }
    });

    ipcMain.handle("sync:signIn", async (_evt, opts) => {
      try {
        const sync = await loadSyncClient();
        const data = await sync.signIn(opts || {}, userDataDir());
        return okResult({
          ...data,
          config: getPublicConfig(userDataDir()),
        });
      } catch (err) {
        return errResult(err);
      }
    });

    ipcMain.handle("sync:signOut", async () => {
      try {
        const sync = await loadSyncClient();
        await sync.signOut(userDataDir());
        return okResult({ config: getPublicConfig(userDataDir()) });
      } catch (err) {
        return errResult(err);
      }
    });

    ipcMain.handle("sync:upload", async (_evt, scanResult) => {
      try {
        let payload = scanResult;
        // If renderer didn't pass a result, scan now
        if (!payload || !Array.isArray(payload.sessions)) {
          payload = await runScan({});
        }
        if (payload.error && (!payload.sessions || payload.sessions.length === 0)) {
          return errResult(new Error(payload.error));
        }
        const sync = await loadSyncClient();
        const data = await sync.uploadSnapshot(payload, userDataDir());
        return okResult({
          ...data,
          config: getPublicConfig(userDataDir()),
        });
      } catch (err) {
        return errResult(err);
      }
    });

    ipcMain.handle("sync:status", async () => {
      try {
        const cfg = loadConfig(userDataDir());
        return okResult({
          config: getPublicConfig(userDataDir()),
          configured: !!(cfg.supabaseUrl && cfg.supabaseAnonKey),
        });
      } catch (err) {
        return errResult(err);
      }
    });
  }

  ipcMain.handle("session:detail", async (_evt, opts) => {
    try {
      const { getSessionDetail } = await import("./scanner/detail.js");
      const data = await getSessionDetail(opts || {});
      return okResult({ detail: data });
    } catch (err) {
      return errResult(err);
    }
  });

  ipcMain.handle("session:transcript", async (_evt, opts) => {
    try {
      const { getSessionTranscript } = await import("./scanner/transcript.js");
      const data = await getSessionTranscript(opts || {});
      return okResult({ transcript: data });
    } catch (err) {
      return errResult(err);
    }
  });
}

// Windows 任务栏分组 / 固定图标
if (process.platform === "win32") {
  app.setAppUserModelId("com.tokenstats.desktop");
}

app.whenReady().then(() => {
  registerIpc();
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
