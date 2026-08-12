/**
 * 是否启用云同步。由同目录 build-flags.json 控制（打包时随 electron 解包）。
 * 默认 true；无同步安装包构建脚本会写成 false。
 */
function readEnableSync() {
  try {
    const flags = require("./build-flags.json");
    if (flags && Object.prototype.hasOwnProperty.call(flags, "enableSync")) {
      return flags.enableSync !== false;
    }
  } catch {
    /* ignore */
  }
  if (process.env.TOKEN_STATS_NO_SYNC === "1") return false;
  return true;
}

module.exports = {
  enableSync: readEnableSync(),
};
