// 离屏加载 dist，等扫描完成后截图，用于验证图表渲染
const { app, BrowserWindow } = require("electron");
const path = require("node:path");

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1280,
    height: 900,
    show: false,
    backgroundColor: "#0a0a0b",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  // 注册和 main.cjs 一样的 scan IPC
  const { ipcMain } = require("electron");
  const { spawn } = require("node:child_process");
  ipcMain.handle("scan:run", async () => {
    return new Promise((resolve) => {
      const child = spawn("node", [path.join(__dirname, "scan-full.mjs")], {
        cwd: path.join(__dirname, ".."),
        windowsHide: true,
      });
      let out = "";
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (c) => (out += c));
      child.on("close", () => {
        try {
          resolve(JSON.parse(out));
        } catch {
          resolve({ error: "parse failed", sessions: [], reports: [] });
        }
      });
    });
  });

  await win.loadFile(path.join(__dirname, "..", "dist", "index.html"));
  // 等扫描 + 渲染
  await new Promise((r) => setTimeout(r, 8000));
  const img = await win.webContents.capturePage();
  require("node:fs").writeFileSync(path.join(__dirname, "..", "shot-full.png"), img.toPNG());
  app.quit();
});
