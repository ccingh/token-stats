# Token Stats 功能补充路线图

> 本文档基于对 token-stats 现状的分析，以及与主流开源同类工具的对比，梳理出可分阶段补充的能力清单。
> 仅作规划参考，不代表必须实现；标注的「实现切入点」指向现有文件/模块，不包含具体代码。

## 一、领域说明

token-stats 里的「token」指 **LLM 计费 token**（input / output / cache / reasoning），用于统计本机多个 AI coding agent 的用量与成本估算，**不是**安全意义上的密钥/凭证扫描。

对标的开源同类工具：

- **ccusage** — https://github.com/ccusage/ccusage （CLI，最流行，5 小时计费窗口是招牌）
- **tokscale** — https://github.com/junhoyeo/tokscale （Rust TUI + Web 仪表盘，社交/排行榜）
- **TokenTracker** — https://github.com/mm7894215/TokenTracker （桌面原生，桌面宠物 + 小组件 + 成就）

## 二、现状盘点（路线图基线）

token-stats 当前已具备的能力：

| 维度 | 已有 |
|------|------|
| Agent 覆盖 | opencode / claude / grok / kimi / zcode / pi（6 个） |
| Token 计数 | input / output / cacheRead / cacheWrite / reasoning / total（含缓存/推理去重） |
| 视图 | 概览 / 按项目 / 按模型 / 按天 / 会话明细（5 个） |
| 图表 | 堆叠趋势图 + GitHub 53 周热力图 + 工具/模型分布 |
| 会话处理 | turn 级明细、父子会话合并、删除会话保留标记 |
| 成本估算 | 硬编码 `pricing.js`（~40 模型，USD + 部分 CNY 刊例）+ 实时汇率换算 |
| 运维 | 自动刷新、CSV/JSON 导出、筛选状态持久化 |
| 同步 | Supabase 云同步（统计快照，不含对话正文）+ 手机端只读 |

**结论：基础盘扎实，主要短板在「桌面常驻存在感 / 告警 / 价目引擎 / agent 覆盖 / 分享性」。**

## 三、竞品对照表

✅ = 已有　🟡 = 部分　❌ = 无

| 维度 | token-stats | ccusage | tokscale | TokenTracker |
|------|:---:|:---:|:---:|:---:|
| Agent 覆盖（6 vs 15~40+） | 6 | 15 | 40+ | 29 |
| 价目引擎（LiteLLM / 2200+ 模型） | ❌ 硬编码 ~40 | 🟡 | ✅ | ✅ |
| 成本/预算告警通知 | ❌ | ❌（赞助方有） | ❌ | ✅ |
| 厂商配额/限速追踪 | ❌ | ✅ 5h 窗 | ✅ | ✅（13 家） |
| 系统托盘 / 菜单栏常驻 | ❌ | ❌ | ❌ | ✅ |
| 桌面小组件 | ❌ | ❌ | ❌ | ✅ 4 个 |
| 5 小时计费窗口视图 | ❌ | ✅ | ❌ | ❌ |
| GitHub README badge / SVG | ❌ | ❌ | ✅ | ✅ |
| 年度 Wrapped 报告 | ❌ | ❌ | ✅ | ❌ |
| 成就 / 游戏化 | ❌ | ❌ | ❌ | ✅ |
| 桌面宠物 | ❌ | ❌ | ❌ | ✅ |
| LLM 任务归因（会话聚类命名） | ❌ | ❌ | ✅ | ❌ |
| 自定义价目覆盖（不改源码） | ❌ | ✅ `ccusage.json` | ✅ | ✅ |
| 多 agent 去重 | ❌ | ❌ | ❌ | ✅ |
| WSL 自动发现 | ❌ | ❌ | ❌ | ✅ |
| 云同步 / 多设备 | 🟡 Supabase 单行覆盖 | ❌ | 🟡 排行榜 | ✅ 跨设备合并 |
| 人民币 / 多币种 | ✅ 实时汇率 + 官方 CNY 刊例 | ❌ 仅 USD | 🟡 | ❌ |

> 看点：token-stats 在「**人民币/多币种**」「**云同步**」上是**独有优势**；但「告警」「托盘常驻」「配额追踪」「价目引擎」是普遍短板，是 P0 重点。

## 四、分阶段路线图

### P0 — 核心短板补齐（让它从「打开才看」变成「常驻可用」）

> 目标：解决「桌面应用没有存在感、想不起来看、看了也只能事后看」的根本问题。

#### P0-1　系统托盘 + 置顶迷你窗 + 成本角标
- **价值**：让应用常驻后台，托盘角标显示今日花费，鼠标悬停看迷你趋势，无需切回主窗口。
- **为什么做**：当前应用关窗就退出了，存在感低，与竞品的「菜单栏/托盘常驻」差距最大。
- **参考竞品**：TokenTracker（托盘/菜单栏）
- **实现切入点**：`electron/main.cjs`（`Tray` + `BrowserWindow` 迷你置顶层、`setToolTip`/角标绘制）；`preload.cjs`（暴露迷你窗数据接口）；新增托盘菜单项（显示主窗 / 立即扫描 / 退出）。
- **优先级理由**：告警（P0-2）依赖托盘存在，应先落地。

#### P0-2　成本/预算告警与桌面通知
- **价值**：设置日/周预算阈值、配额临期提醒，到达阈值推送系统通知 + 托盘角标变红。
- **为什么做**：是三类竞品里 token-stats 最缺的「主动提醒」能力，也是用户花钱最在意的。
- **参考竞品**：TokenTracker（预算告警）
- **实现切入点**：新增告警规则配置（持久化进 Electron `userData/config.json`，与现有 Supabase 配置同处）；`electron/main.cjs` 在每次 `scanAll` 完成后检查阈值 → `Notification`；UI 入口加到顶栏「设置」或 `SyncPanel.tsx` 同级的新 `AlertsPanel.tsx`。
- **优先级理由**：核心痛点，且复用 P0-1 托盘。

#### P0-3　Claude 5 小时计费窗口视图
- **价值**：展示当前所处 Claude 5 小时计费窗口的已用 token / 剩余，是 Claude 用户最关心的功能。
- **为什么做**：ccusage 的招牌功能，Claude 重度用户刚需，token-stats 完全缺失。
- **参考竞品**：ccusage（`blocks` 报表）
- **实现切入点**：`electron/scanner/hourly.js`（已有小时桶，扩展为 5 小时滚动窗口聚合）；`electron/scanner/adapters/claude.js`（提供窗口边界判断）；新增 `src/BlocksView.tsx` 视图，加进 `App.tsx` 的 `VIEWS`。
- **优先级理由**：差异化 + Claude 用户刚需。

#### P0-4　LiteLLM 实时价目引擎
- **价值**：用 LiteLLM 的公开价目数据（2200+ 模型）替代/补充硬编码 `pricing.js`，含本地缓存 + 离线快照兜底。
- **为什么做**：当前 ~40 模型、调价就要改源码、新模型命中率低；这是准确性的根本瓶颈。
- **参考竞品**：tokscale、TokenTracker（均用 LiteLLM）
- **实现切入点**：`electron/scanner/pricing.js`（保留为本地兜底/人民币刊例覆盖层，新增 LiteLLM 拉取 + 磁盘缓存，匹配优先级：用户自定义 > 官方 CNY 刊例 > LiteLLM）；新增 `electron/scanner/pricing-remote.js` 拉取模块；离线时回退到现有硬编码表。
- **优先级理由**：准确性根基，P1 扩 agent 前先打好。

---

### P1 — 覆盖与准确性（把数据做全做准）

#### P1-1　扩展更多 Agent
- **价值**：Cursor / Codex CLI / Gemini CLI / GitHub Copilot CLI 等主流工具接入。
- **为什么做**：README 已列在「后续」；agent 覆盖是此类工具的核心竞争力（竞品 15~40+，当前 6）。
- **参考竞品**：三家都有
- **实现切入点**：`electron/scanner/adapters/`（每个 agent 一个新 adapter，遵循 `detect/scan/getDetail` 契约）；`electron/scanner/paths.js`（补路径）；`electron/scanner/index.js`（注册）；`src/App.tsx` 的 `CLIENT_ORDER` / `CLIENT_LABELS`。
- **优先级理由**：扩面，但依赖 P0-4 的价目引擎支撑新模型定价。

#### P1-2　厂商配额/限速追踪
- **价值**：实时展示 Claude 5h 窗、Codex 周配额、Gemini/Copilot 限速等剩余状态。
- **为什么做**：用户想知道「还能不能用」，比事后看成本更刚需。
- **参考竞品**：ccusage、tokscale、TokenTracker（13 家）
- **实现切入点**：读取各 agent 本地状态文件（如 Claude 的 `statsig`、Codex 的 quota 文件）；`SessionRecord` 扩展 `quotaRemaining` 字段；概览页加配额卡片。
- **优先级理由**：与 P0-3 协同，Claude 窗口是其中一环。

#### P1-3　多 Agent 去重 ✅ 已实现（保守方案）
- **状态**：已完成。采用「标记而非删除」的可逆去重。
- **实现**：新增 `electron/scanner/dedup.js`。当前为**高置信度模式**——仅当 ≥2 条不同 client 共享同一 sessionId（UUID 碰撞 = 铁证）才判为重复，零误杀。命中后两条记录都保留在表格/明细里，但只有「胜出」一条（按优先级 `opencode>claude>zcode>grok>kimi>pi`，tie 取 token 大的）计入总额；其余条打 `dedupExcluded` 标记。
- **可见性**：扫描详情新增「去重 N 组 · 省 X tokens」橙色 pill（可展开看保留/排除清单）；会话表排除条标橙色「未计入」徽章；明细顶部橙色横幅「此会话与 [工具] 重复，未计入总额」；新增「未计入」筛选开关（默认显示，持久化 localStorage）。
- **数据字段**：`SessionRecord` 加 `dedupExcluded`/`dedupReason`/`dedupKeptBy`；`ScanResult` 加 `dedupReports`。
- **当前数据验证**：本机 6 个 adapter 下 `dedupReports` 为空（符合「跨工具重复基本是理论场景」的预期），不影响现有总额。
- **预留扩展点**：`dedupCrossClient(sessions, {fuzzy:true})` 已预留 cwd/时间窗模糊匹配开关，默认关闭。等 P1-1 接入 wrapper 类 adapter 后跨工具重复才会真正出现，届时按需开启，无需重写。
- **未做**：turn 级复合 key 去重（收益低、改动大）。

#### P1-4　用户可编辑自定义价目覆盖
- **价值**：用户不用改源码就能覆盖某个模型的单价（如走中转商折扣价、企业协议价）。
- **为什么做**：硬编码 `pricing.js` 对企业/中转用户不友好；ccusage/tokscale 都支持。
- **参考竞品**：ccusage（`ccusage.json`）、tokscale
- **实现切入点**：Electron `userData` 下新增 `pricing-overrides.json`；`findPrice` 匹配链最前置加一层用户覆盖；设置面板加编辑入口。
- **优先级理由**：低成本、高灵活性。

#### P1-5　WSL 自动发现与聚合
- **价值**：Windows 用户在 WSL 里跑 agent 时，自动发现并聚合 WSL 内的会话数据。
- **为什么做**：你是 Windows 应用，很多开发者在 WSL 里用 Claude Code/Codex，现在扫不到。
- **参考竞品**：TokenTracker（WSL auto-discovery）
- **实现切入点**：`electron/main.cjs` 启动时检测 `wsl.exe` 并列举发行版；`electron/scanner/paths.js` 增加 WSL 路径解析（`\\wsl$\<distro>\home\...`）；扫描时并行拉取 WSL 内日志。
- **优先级理由**：Windows 场景刚需。

---

### P2 — 差异化 / 传播性（让人愿意分享）

> 目标：在基础盘和覆盖都到位后，做能让用户「晒」出来的差异化能力。

#### P2-1　GitHub README badge / 可分享 SVG
- **价值**：生成 shields.io 风格徽章 / 嵌入式 SVG，展示用量或成本，放到 GitHub Profile。
- **参考竞品**：tokscale、TokenTracker
- **实现切入点**：新增「分享」入口生成 SVG（可上传到自己的 Supabase 公开链接或导出文件）；`src/` 加 SVG 模板渲染。

#### P2-2　年度「Wrapped」报告
- **价值**：年终生成一张图：总成本、Top 模型、活跃天数、最长连续打卡、最贵的项目。
- **参考竞品**：tokscale
- **实现切入点**：基于已有会话数据 + 热力图聚合，渲染一张可下载的总结图。

#### P2-3　成就 / 游戏化徽章
- **价值**：把日活、里程碑、模型使用、连续打卡变成可收集徽章。
- **参考竞品**：TokenTracker（15 条成就线）
- **实现切入点**：新增成就规则引擎 + 展示页；规则基于现有 `totals` / 热力图数据即可。

#### P2-4　桌面小组件
- **价值**：钉在桌面的用量 / 热力图 / Top 模型小窗，无需打开主窗。
- **参考竞品**：TokenTracker（4 个原生 widget）
- **实现切入点**：Electron 透明置顶 `BrowserWindow` + 拖拽；复用现有图表组件的小型化版本。

#### P2-5　LLM 任务归因（会话聚类命名）
- **价值**：用 LLM 把一堆会话聚合成「重构登录模块」「修 CI」等任务簇并自动命名。
- **为什么做**：tokscale 的独门特性，从「看花了多少钱」升级到「钱花在什么任务上」。
- **参考竞品**：tokscale（多后端 LLM 归因）
- **实现切入点**：可选 LLM 后端（用户填 key）；只读会话标题/摘要（不传对话正文）做聚类；`src/` 加「按任务」视图。注意隐私（默认关闭、需用户授权）。

#### P2-6　分钟级实时监控视图
- **价值**：实时看当前会话 token 速率，感知「这一刻在烧钱」。
- **参考竞品**：tokscale（minutely view）
- **实现切入点**：`hourly.js` 扩展为分钟桶；自动刷新调到秒级。

#### P2-7　按 workspace / provider 分组
- **价值**：除「按项目/模型/天」外，再加按 workspace、provider 维度分组。
- **参考竞品**：tokscale
- **实现切入点**：`App.tsx` 视图列表扩展；分组 key 从现有字段派生。

#### P2-8　子 Agent 分布视图
- **价值**：把工具内部的子 agent（如 Claude Code 的 explore / general-purpose / subagent）单独拉出来看 token 占比，回答「主会话 vs 子 agent 各烧了多少」。
- **为什么做**：数据已在 `detail.js` / `types.js` 采集（`agentName` / `isSubagent` / `parentSessionId`），目前只用于父子并账，没有单独的分布视图，浪费了这层信息。
- **与 tokscale 的区别**：tokscale 的「Agents」是 **client 维度**（Claude Code vs Cursor 这种工具），token-stats 已有「按工具」筛选覆盖；此处的子 agent 是**工具内部维度**，是 token-stats 相对 tokscale 的差异化点。
- **参考竞品**：无（tokscale 不做工具内子 agent 维度）
- **实现切入点**：`src/App.tsx` 新增「按 Agent」分布卡片或视图，数据从会话列表的 `agentName`/`isSubagent` 聚合；主会话 vs 子 agent 占比、各子 agent 类型 Top N。成本低，纯前端。
- **优先级理由**：锦上添花，非痛点，故列 P2。

---

## 五、建议的实施顺序

1. **先 P0**：P0-1 托盘 → P0-2 告警 → P0-3 Claude 5h 窗 → P0-4 LiteLLM 价目。
   理由：托盘是告警的载体，5h 窗是 Claude 用户刚需，价目引擎是后续扩 agent 的准确性根基。
2. **再 P1**：P1-1 扩 agent（依赖 P0-4）→ P1-2 配额（协同 P0-3）→ P1-3 去重 → P1-4 自定义价目 → P1-5 WSL。
3. **最后 P2**：按传播价值，建议 P2-1 badge → P2-2 Wrapped → P2-3 成就 → 其余按需。

> 每个阶段完成后，可重新跑一遍「竞品对照表」评估差距是否缩小。token-stats 的**人民币/多币种**和**自有 Supabase 云同步**是当前独有优势，路线图过程中应继续保持。

---

## 附录：竞品参考链接

- ccusage — https://github.com/ccusage/ccusage ｜ 官网 https://ccusage.com/ ｜ 文档 https://ccusage.com/guide/
- tokscale — https://github.com/junhoyeo/tokscale
- TokenTracker — https://github.com/mm7894215/TokenTracker
- 相关讨论 — https://www.toriihq.com/articles/five-claude-code-usage-dashboards-and-monitoring-tools
