# Token Stats

**本机多 Agent 会话 Token 用量统计** — 桌面端扫描本地日志，可选同步到云端；手机端只读查看。

| | |
|---|---|
| 作者 | **CCingh** |
| 邮箱 | **ccingh@proton.me** |
| 版本 | 1.1.0 |
| 仓库 | https://github.com/ccingh/token-stats |

---

## 特性

- **本地扫描**：不经过第三方统计服务，直接读各 Agent 本机数据
- **多工具**：OpenCode / Claude Code / Grok Build / Kimi Code / ZCode / Pi / Reasonix / 小米 MiMo Code
- **多维汇总**：按工具、模型、项目、日期；趋势图与活跃热力图
- **请求 / Turn / 消息数**、缓存命中率、子会话并账
- **模型主名统计** + 思考档位（max / high）彩色标记（档位不拆散模型统计）
- **成本估算**：价目表（USD / 可选官方 CNY）+ 实时汇率
- **会话明细**：Turn 级用量、Agent 汇总、对话预览（桌面本地）
- **云同步**（可选）：Supabase 上传统计快照，手机端只读
- **打包**：Windows NSIS 安装包 / 便携版 / 无同步版

---

## 截图与数据说明

应用**只读**本机已有会话数据，不上传对话正文到第三方（云同步仅上传你自建的 Supabase 统计快照）。

**不会**读取 Tokscale / Token Monitor / cc-switch 等非 Agent 会话源。

---

## 支持的数据源

| 客户端 | 默认路径 |
|--------|----------|
| OpenCode | `~/.local/share/opencode/opencode.db` |
| Claude Code | `~/.claude/projects/**/*.jsonl` |
| Grok Build | `~/.grok/sessions/**` + `~/.grok/logs/unified.jsonl` |
| Kimi Code | `~/.kimi-code/**/wire.jsonl` |
| ZCode | `~/.zcode/cli/db/db.sqlite` |
| Pi | `~/.omp/agent/sessions/**/*.jsonl` |
| Reasonix | `~/.reasonix/sessions` |
| MiMo Code | `~/.local/share/mimocode/mimocode.db`（或 `$MIMOCODE_HOME/data/mimocode.db`） |

Windows 下 `~` 一般为用户主目录（如 `C:\Users\<你>`）。

---

## 快速开始（桌面）

### 环境

- Node.js 20+（建议 22+，扫描使用 `node:sqlite`）
- Windows / macOS / Linux（打包脚本当前以 Windows 为主）

### 开发

```bash
git clone https://github.com/ccingh/token-stats.git
cd token-stats
npm install
npm run scan    # 命令行扫描，验证适配器
npm run dev     # Vite + Electron
```

### 打包（Windows）

```bash
npm run dist            # NSIS 安装包 + 便携版 → release/
npm run dist:portable   # 仅便携版
npm run dist:nosync     # 无云同步 UI 的安装包
```

产物示例：

- `release/Token Stats-<version>-win-x64.exe`
- `release/Token Stats-<version>-portable.exe`

---

## 成本估算

- 部分工具会话自带 `cost` 时优先使用，否则按 `electron/scanner/pricing.js` 刊例估算
- 匹配规则：模型主名包含价目表 key（思考档位不参与定价键）
- **人民币**：有官方 `cny` 刊例的模型直接按人民币计；否则用实时汇率折算美元成本
- 调价：编辑 `electron/scanner/pricing.js` 即可

---

## 云同步（可选 · Supabase）

桌面端可把**统计快照**（会话汇总 + 小时桶，不含对话正文）上传到你自己的 Supabase。

### 1. 建表

在 [Supabase SQL Editor](https://supabase.com/dashboard) 执行仓库内：

```text
supabase/schema.sql
```

### 2. Auth

- Authentication → Providers → **Email** 开启  
- 自用可关闭 **Confirm email**

### 3. 桌面操作

1. 打开应用 → **同步**
2. 填入 Project URL 与 anon key → 保存
3. 注册 / 登录 → **上传到云端**

配置保存在 Electron `userData`（Windows 约 `%APPDATA%/token-stats/`）。

每次上传按 `user_id` **覆盖**最新一行快照。

---

## 手机端（只读）

手机**不扫描**本机 Agent 日志，只拉取桌面已上传的快照。

详见 [`mobile/README.md`](./mobile/README.md)。

```bash
cd mobile
npm install
npm run dev          # 浏览器 / 局域网预览
npm run cap:android  # Capacitor → Android Studio
```

使用与桌面**同一** Supabase 项目与账号。

---

## 项目结构

```text
token-stats/
├── electron/           # Electron 主进程 + 扫描器
│   ├── scanner/
│   │   ├── adapters/   # 各 Agent 适配器
│   │   ├── pricing.js  # 模型价目
│   │   └── ...
│   └── sync/           # Supabase 上传客户端
├── src/                # 桌面 React UI
├── mobile/             # Capacitor 只读端
├── supabase/           # SQL schema
└── package.json
```

---

## 脚本一览

| 命令 | 说明 |
|------|------|
| `npm run dev` | 开发模式 |
| `npm run build` | 构建前端 |
| `npm run scan` | CLI 扫描 |
| `npm run dist` | Windows 安装包 + 便携版 |
| `npm run dist:nosync` | 无同步安装包 |

---

## 隐私

- 默认所有数据留在本机
- 云同步仅当你配置并登录**自己的** Supabase 后才会上传统计字段
- 不包含会话对话全文（对话预览仅桌面读本地文件）

---

## 许可证与作者

Copyright © **CCingh** \<ccingh@proton.me\>

本仓库由 **CCingh** 维护。提交与包元数据作者固定为：

```text
CCingh <ccingh@proton.me>
```
