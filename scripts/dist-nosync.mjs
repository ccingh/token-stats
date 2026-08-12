/**
 * 构建「无云同步」安装版：
 * - UI 去掉同步按钮 / 面板（VITE_ENABLE_SYNC=false）
 * - Electron 不暴露 sync IPC（electron/build-flags.json enableSync=false）
 * - 产物：release/Token Stats Local-*-nosync-setup.exe
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const flagsPath = path.join(root, "electron", "build-flags.json");
const isWin = process.platform === "win32";
const npm = isWin ? "npm.cmd" : "npm";
const npx = isWin ? "npx.cmd" : "npx";

function writeFlags(enableSync) {
  fs.writeFileSync(
    flagsPath,
    `${JSON.stringify({ enableSync }, null, 2)}\n`,
    "utf8"
  );
  console.log(`wrote ${flagsPath} enableSync=${enableSync}`);
}

function run(cmd, args, env = {}) {
  console.log(`\n> ${cmd} ${args.join(" ")}\n`);
  const r = spawnSync(cmd, args, {
    cwd: root,
    env: { ...process.env, ...env },
    stdio: "inherit",
    shell: isWin,
  });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

const prev = fs.existsSync(flagsPath)
  ? fs.readFileSync(flagsPath, "utf8")
  : null;

try {
  writeFlags(false);

  // 1) 前端：无同步 UI
  run(npm, ["run", "build"], { VITE_ENABLE_SYNC: "false" });

  // 2) electron-builder 无同步安装包（NSIS only）
  run(
    npx,
    [
      "electron-builder",
      "--win",
      "--x64",
      "--config",
      "electron-builder.nosync.json",
    ],
    {
      CSC_IDENTITY_AUTO_DISCOVERY: "false",
      TOKEN_STATS_NO_SYNC: "1",
    }
  );

  console.log(
    "\n✓ 无同步安装包已输出到 release/（Token Stats Local-*-nosync-setup.exe）\n"
  );
} finally {
  // 恢复开发默认：有同步
  if (prev != null) fs.writeFileSync(flagsPath, prev, "utf8");
  else writeFlags(true);
}