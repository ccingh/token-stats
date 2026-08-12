// 预览页截图工具：SHOT_URL=... SHOT_OUT=... electron mobile/screenshot-preview.cjs
const { app, BrowserWindow } = require("electron");
const path = require("node:path");
const fs = require("node:fs");

const url = process.env.SHOT_URL || "http://localhost:5199/preview.html";
const out = process.env.SHOT_OUT || "preview.png";

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 390,
    height: 2200,
    show: false,
    backgroundColor: "#f2f2f7",
  });
  await win.loadURL(url);
  await new Promise((r) => setTimeout(r, 1200));
  const scroll = Number(process.env.SHOT_SCROLL || 0);
  if (scroll > 0) {
    await win.webContents.executeJavaScript(`window.scrollTo(0, ${scroll})`);
    await new Promise((r) => setTimeout(r, 300));
  }
  const img = await win.webContents.capturePage();
  fs.writeFileSync(path.resolve(out), img.toPNG());
  console.log("saved", path.resolve(out));
  app.quit();
});
