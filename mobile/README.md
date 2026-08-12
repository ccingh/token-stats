# Token Stats Mobile（只读）

查看桌面端同步到 Supabase 的用量快照。不扫描手机本地日志。

## 功能（对齐桌面分析）

- **概览**
  - 时间范围：今天 / 7 天 / 30 天 / 全部
  - Total tokens、分项（in/out/cache/reason）、今日/本周环比
  - 用量趋势（可按工具 / 模型堆叠；有小时桶时按 turn 时间）
  - 活跃热力图（近 1 年 · 53 周）
  - 按工具 / 按模型分布
- **分析**：按工具 · 按项目 · 按模型 · 按天 聚合
- **会话**：搜索、工具筛选、藏空/未归并/已删除、排序（时间/用量/请求/Turn/Msgs/命中/成本）、会话详情 sheet
- **请求次数**：概览 / 聚合 / 会话列表；区间优先用小时桶 `events`（与桌面一致）
- **设置**：主题、币种（USD/CNY + 实时汇率）、隐藏成本、账号 / Supabase
- 邮箱登录（与桌面同一 Supabase 账号）

> **注意**：turn 级明细 / 对话正文仍仅桌面可读本地日志。会话级 `requestCount` 与去重字段需桌面 **重新上传** 后才有（payload `appVersion ≥ 1.1.1`）；有小时桶时区间请求可不依赖会话字段。

## 开发（浏览器预览）

```bash
cd token-stats/mobile
npm install
npm run dev
```

终端会打印类似 `http://192.168.x.x:5174/`，手机浏览器打开即可。

## Android App（Capacitor）

```bash
cd token-stats/mobile
npm install
npm run build
npm run cap:sync
npx cap open android
```

## 使用步骤

1. 桌面 Token Stats 配置同一 Supabase，登录后 **上传到云端**
2. 手机填 Project URL + anon key，同一邮箱登录
3. 点刷新拉取最新快照

## 注意

- 只读云端 `usage_snapshots`，不上传  
- 改 Supabase 配置后需重新登录  
- 无快照时提示去桌面端先同步  
- 旧快照没有 `hourly` 时，趋势/热力图回退为会话 `lastUsedAt`  
