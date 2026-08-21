<p align="center">
  <img src="docs/readme/icon.png" width="88" height="88" alt="Token Stats">
</p>

<h1 align="center">Token Stats</h1>

<p align="center">
  <a href="./README.md">中文</a> · <a href="./README.en.md">English</a>
</p>

<p align="center">
  <img alt="version" src="https://img.shields.io/badge/version-1.1.2-34d399?style=flat-square">
  <img alt="license" src="https://img.shields.io/badge/license-MIT-2e8cff?style=flat-square">
  <img alt="platform" src="https://img.shields.io/badge/Windows-NSIS%20%2F%20portable-9385d9?style=flat-square">
  <img alt="privacy" src="https://img.shields.io/badge/local--first-no%20chat%20upload-6b6b76?style=flat-square">
</p>

<p align="center">
  <b>Local multi-agent session token stats</b><br>
  Desktop scans logs on this machine · optional sync to your own cloud · phone is read-only
</p>

<p align="center">
  <img src="docs/readme/banner.jpg" alt="Token Stats" width="920">
</p>

| | |
|---|---|
| Author | **CCingh** |
| Email | **ccingh@proton.me** |
| Repo | https://github.com/ccingh/token-stats |

---

## How data moves

Local logs feed the desktop app. Cloud sync is optional and only sends a stats snapshot. Conversation text never leaves this computer.

<p align="center">
  <img src="docs/readme/flow.svg" alt="Local logs → scan → desktop stats → optional sync → phone read-only" width="920">
</p>

---

## Features

| | |
|---|---|
| **Local scan** | Reads each agent’s on-disk data; no third-party stats service |
| **11 tools** | OpenCode / Claude / Codex / Grok Build / Kimi / ZCode / Pi / Reasonix / MiMo Code / DeepSeek Harness / Freebuff |
| **Breakdowns** | By tool, model, project, and day; trend chart and 53-week heatmap |
| **Request grain** | Requests / turns / messages, cache hits, child-session rollup |
| **Base model** | Thinking tiers are badges only; they do not split model totals. Shown when the tool persisted a tier: OpenCode / Codex / dsh / Grok / Kimi / ZCode / Pi (MiMo too if `variant` is present). Claude / Reasonix / Freebuff logs have no tier field |
| **Cost** | List prices in USD + official CNY; `-free` is $0; long context is per request |
| **Session detail** | Per-turn usage, agent rollup, chat preview (desktop, local files only) |
| **Cloud sync** | Optional upload to **your** Supabase; phone is read-only |

It does **not** read Tokscale / Token Monitor / cc-switch or other non-agent sources.

---

## Data sources

| Client | Default path |
|--------|----------------|
| OpenCode | `~/.local/share/opencode/opencode.db` |
| Claude Code | `~/.claude/projects/**/*.jsonl` |
| Codex | `~/.codex/sessions/**/rollout-*.jsonl` (or `$CODEX_HOME`) |
| Grok Build | `~/.grok/sessions/**` + `~/.grok/logs/unified.jsonl` |
| Kimi Code | `~/.kimi-code/**/wire.jsonl` |
| ZCode | `~/.zcode/cli/db/db.sqlite` |
| Pi | `~/.omp/agent/sessions/**/*.jsonl` |
| Reasonix | `~/.reasonix/sessions` |
| MiMo Code | `~/.local/share/mimocode/mimocode.db` (or `$MIMOCODE_HOME/data/mimocode.db`) |
| DeepSeek Harness (dsh) | `~/.dsh/sessions/**/session.jsonl.zstd` (or `$DSH_HOME`) |
| Freebuff | `~/.config/manicode/projects/**/chats/*/log.jsonl` (per-step `contextTokenCount` split into uncached input + prefix-overlap estimated cache; output estimated from the paired End reply/tool calls; no official local cache — excluded from official hit rate. Estimate-only UI is `–（x）`; overview mixed display is official overall hit, with parentheses for overall hit after including estimated cache, e.g. `92%（95%）`) |

On Windows, `~` is usually the user profile (e.g. `C:\Users\<you>`).

---

## Quick start (desktop)

### Requirements

- Node.js 20+ (22+ recommended; the scanner uses `node:sqlite`)
- Windows / macOS / Linux (packaging scripts currently target Windows)

### Develop

```bash
git clone https://github.com/ccingh/token-stats.git
cd token-stats
npm install
npm run scan    # CLI scan, to verify adapters
npm run dev     # Vite + Electron
```

### Package (Windows)

```bash
npm run dist            # NSIS installer + portable → release/
npm run dist:portable   # portable only
npm run dist:nosync     # installer without cloud-sync UI
```

Artifacts:

- `release/Token Stats-<version>-win-x64.exe`
- `release/Token Stats-<version>-portable.exe`

---

## Cost estimates

- If a tool already stores `cost` on the session, that value wins; otherwise costs come from `electron/scanner/pricing.js`
- Match on the **base** model name (thinking tier is not part of the price key); a `-free` suffix is treated as free ($0) and is not listed as unpriced
- **Long context**: when a **single request** has a prompt length, tiered rates apply (Grok 4.5/4.6: the whole request uses the long tier at ≥200k). Session-level sums still fall back to the base tier
- **CNY**: models with an official `cny` list price are billed in CNY; otherwise USD cost is converted with live FX
- To change prices, edit `electron/scanner/pricing.js`

---

## Cloud sync (optional · Supabase)

The desktop app can upload a **stats snapshot** (session summaries + hourly buckets, no chat text) to your own Supabase project.

### 1. Schema

In the [Supabase SQL Editor](https://supabase.com/dashboard) run the repo file:

```text
supabase/schema.sql
```

### 2. Auth

- Authentication → Providers → enable **Email**
- For personal use you can turn off **Confirm email**

### 3. On the desktop

1. Open the app → **Sync**
2. Paste the Project URL and anon key → save
3. Sign up / log in → **Upload to cloud**

Config lives in Electron `userData` (on Windows, roughly `%APPDATA%/token-stats/`).

Each upload **overwrites** the latest snapshot row for that `user_id`.

---

## Mobile (read-only)

The phone **does not** scan local agent logs. It only pulls the snapshot the desktop already uploaded.

See [`mobile/README.md`](./mobile/README.md).

```bash
cd mobile
npm install
npm run dev          # browser / LAN preview
npm run cap:android  # Capacitor → Android Studio
```

Use the **same** Supabase project and account as the desktop app.

---

## Layout

```text
token-stats/
├── electron/           # Electron main process + scanner
│   ├── scanner/
│   │   ├── adapters/   # per-agent adapters
│   │   ├── pricing.js  # model prices
│   │   └── ...
│   └── sync/           # Supabase upload client
├── src/                # desktop React UI
├── mobile/             # Capacitor read-only app
├── docs/readme/        # images for the README
├── supabase/           # SQL schema
└── package.json
```

---

## Scripts

| Command | What it does |
|---------|----------------|
| `npm run dev` | development |
| `npm run build` | build the renderer |
| `npm run scan` | CLI scan |
| `npm run dist` | Windows installer + portable |
| `npm run dist:nosync` | installer without sync |

---

## Privacy

- By default everything stays on this machine
- Cloud sync only uploads stats fields after you configure and sign in to **your** Supabase
- Full conversation text is not included (chat preview only reads local files on the desktop)

---

## License

[MIT](./LICENSE) © CCingh
