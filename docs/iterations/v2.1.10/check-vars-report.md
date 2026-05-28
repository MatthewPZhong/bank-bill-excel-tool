# v2.1.10 Phase 6 T33 — check-vars 报告 + Critical 升格汇总

| 字段 | 值 |
|---|---|
| 报告版本 | v1.0（2026-05-28 — Phase 6 T33 完成） |
| 关联 task | `docs/iterations/v2.1.10/tasks.md` §九 T33 |
| 关联 spec | `docs/iterations/v2.1.10/spec.md` §九 重要变量影响清单 |
| 命令 | `npm run scan:vars` + `npm run check:vars --since main` |
| 重要变量清单 | `rules/important-variables.md` v12（本次升格 5 条 + 更新 1 条） |
| 自动统计 | `docs/analysis/var-reference-stats.md`（94 文件 / 1000 顶层声明 — v11→v12 之间增长 +9 文件 +147 顶层声明） |

---

## 一、check-vars 输出（PR body 直接复用）

### ⚠️ 关联功能 review — v2.1.10 β PR（4 主线 A3 / A4 / N4-cont-1 / N4-cont-2）

**改动文件 11 个**（v2.1.10 vs main）：

```
src/backend/acquiring-bill-currency-db/raw-json-retention.js   ← N4-cont-1 新建
src/backend/acquiring-bill-currency-db/run-repository.js       ← A4 chunked + N4-cont-2 CASCADE 适配
src/backend/database.js                                         ← N4-cont-2 migration 集成 + N4-cont-1 settings getter facade
src/backend/database/migrations.js                              ← N4-cont-2 ensureDiffRowsCascadeMigration_v2_1_10 + N4-cont-1 settings
src/backend/database/settings-repository.js                     ← N4-cont-1 acquiring_bill_raw_json_retention_days
src/main-process/acquiring-bill-currency-session.js             ← A3 runCheckCore 提取 + A4 chunked 透传
src/main-process/run-check-worker-pool.js                       ← A3 worker pool 新建
src/main-process/run-check-worker.js                            ← A3 worker 入口新建
src/main-process/serialize-error.js                             ← A3 错误序列化新建
src/main.js                                                     ← A3 worker IPC + N4-cont-1 idle cleanup 回调集成
src/preload.js                                                  ← A3 worker IPC 接口暴露
```

### Critical 命中（6 个 — 含本版升格 4 条）

| 命中变量 | 来源 | 自查结论 |
|---|---|---|
| `FileValidationError` | v2.1.8 既有 | ✅ A3 serializeError 实现已显式处理 — name / code / message / detailLines / context 全字段保留；反序列化后 `err.name === 'FileValidationError'` 判断（跨进程 prototype 链丢失 by design — spec §2.4.2）；unit test `serialize-error.test.js` 8 case 覆盖 |
| `unmatchedRows` | v2.1.7 既有 | ✅ 与 v2.1.10 4 主线无直接交集（属 v2.1.7 F8 dispatcher / v2.1.7 reconIdFix / v2.1.9 收单单据 3 条流水线）；v2.1.10 改动文件未触及 dispatcher / scenario-bundle-import / acquiring-bill-currency-session 中 unmatchedRows 的语义；smoke 19 suite 全过 ✅ 无回归 |
| `runCheckCore` | **v2.1.10 新升格** | ✅ Phase 1 T09 提取自原 runCheck；contract test（unit `run-check-worker.test.js`）锁定 byte-for-byte；cancel 5 阶段间检查（T13）+ A4 chunked 透传（T18）已实施；集成 `v2.1.10-a3-phase1` 40 case / `v2.1.10-a3-phase2` 33 case / `v2.1.10-a4-phase3` 25 case 全过 |
| `clearStaleSuccessfulRawJson` | **v2.1.10 新升格** | ✅ NOT IN 子查询排除差异行 + sentinel `''` (v0.3) + idempotent 守卫；unit 8 case + 集成 `v2.1.10-n4-cont-1-phase4` 23 case 覆盖差异行保留 / 对账成功老行清 / retention 边界 / 失败 graceful |
| `ensureDiffRowsCascadeMigration_v2_1_10` | **v2.1.10 新升格** | ✅ 8-status state machine + SR-backup-1 createBackupFn 注入 + 跨版本（v2.1.7/v2.1.8/v2.1.9 → v2.1.10）+ 幂等 + ROLLBACK；集成 `v2.1.10-n4-cont-2-phase5` 43 case 全过 |
| `acquiring_bill_currency_diff_rows` | **v2.1.10 新升格 FK CASCADE schema** | ✅ FK 范式 `ON DELETE CASCADE` × 2（bill_import_id + run_id）；与 v2.1.9 N5 channels FK `ON UPDATE CASCADE` 差异是设计；与 N4-cont-1 协作契约（删 run → diff_rows 跟着删 → 这些行的 raw_json 可被 N4-cont-1 自动清空 — 预期行为）|

### Important-skeleton 命中（5 个 — 含本版升格 1 条）

| 命中变量 | 来源 | 自查结论 |
|---|---|---|
| `cleanupAfterRunBackground` | v2.1.8 既有 | ✅ v2.1.8 N1 入参契约（`includeDiff=false`）未改；v2.1.10 N4-cont-1 是**复用** N1' idle 30min cleanup 计时器追加回调 — `clearStaleSuccessfulRawJson` 在主 cleanup 完成后独立 try/catch 触发；失败不阻塞主 cleanup |
| `ipcRenderer` | v2.1.0 既有 | ✅ A3 worker IPC 新增 3 个 channel（`acquiringBillCurrency:run` worker dispatch / `acquiringBillCurrency:run:cancel` cancel / 内部 worker `init/done/error`）；main.js ipcMain.handle 和 preload.js exposeInMainWorld 已同步；BANK_STATEMENT_FIELDS_FOR_C3 双写位置（preload.js:19）未改 |
| `serializeError` | **v2.1.10 新升格** | ✅ worker / main 跨进程错误回传契约；FileValidationError 专属字段 + cause 链递归 + SR-log-1 集成；unit `serialize-error.test.js` 8 case + 集成 phase1 错误回传 case 覆盖 |
| `settingsRepository` | v2.1.0 既有 | ✅ N4-cont-1 加 `getAcquiringBillRawJsonRetentionDays(db)` getter + `acquiring_bill_raw_json_retention_days` migration（单键，默认 7，范围 1-30，范围外回退 7）；与 v2.1.9 N1-settings `acquiring_bill_idle_cleanup_minutes` 范式一致 |
| `setupIdleCleanupTimer` | v2.1.8 既有 | ✅ v2.1.10 改造 2 处：(1) Phase 2 T12 加 `if (runCheckWorkerPool.isBusy()) return;` 守卫（spec §2.3.2）；(2) Phase 4 T24 在 `triggerAcquiringBillCurrencyBackgroundCleanupIfNeeded` 后追加 `clearStaleSuccessfulRawJson` 调用（独立 try/catch + activity log）；既有 30s grace + idle 阈值 settings 化路径未动 |

### Runtime-state 命中（3 个）

| 命中变量 | 自查结论 |
|---|---|
| `app` | ✅ v2.1.10 未动 `app.whenReady` / `before-quit` 钩子；A3 worker 由 main process startup 阶段 pre-warm 启动 + worker pool 自管理生命周期；app quit 时 worker pool 自动 terminate（避免孤儿进程） |
| `dialog` | ✅ v2.1.10 未引入新 dialog 调用（N4-cont-1 D27 = 0 UI 拍板）；A3 worker crash 用 Notification 通知（非 dialog） |
| `state` | ✅ v2.1.10 未动 renderer state schema；A4 chunked progress 回调透传 `chunkIndex / totalChunks` 字段（如 renderer 接显示），符合既有 progress 回调结构；A3 worker → renderer IPC 链路保持不变 |

### Risk-sensitive 命中（3 个）

| 命中变量 | 自查结论 |
|---|---|
| `ensureBillRawJsonV2Slim` | ✅ v2.1.8 N4 函数未改；v2.1.10 N4-cont-1 是**新建独立函数** `clearStaleSuccessfulRawJson`（仅清"对账成功老行" raw_json = ''），与 N4 一次性 schema rewrite 互补；marker 标志位 `acquiring_bill_raw_json_v2_migrated` 未改 |
| `hasColumn` | ✅ v2.1.10 N4-cont-2 ensureDiffRowsCascadeMigration_v2_1_10 内部用 `hasColumn` 判断老 schema；与 v2.1.9 N5 范式一致；幂等保护已加 |
| `lastUserActivityTs` | ✅ v2.1.10 未改 idle 阈值范式（仍 settings 化 + 30min 默认）；新增的 `runCheckWorkerPool.isBusy()` 是**额外**协调条件，与 lastUserActivityTs 互补不互斥 |

### Minor 知会（2 个）

加 `--include-minor` 查看；命中均为通用工具，本版改动未触及语义。

---

## 二、Phase 6 T33 升格汇总（rules/important-variables.md v11 → v12）

### 新增条目（5 条）

| 层级 | 变量 | 主线 | 升格理由 |
|---|---|---|---|
| 🔴 **Critical** | `runCheckCore` | A3 | runCheck 核心算法 worker/main 共用入口；byte-for-byte 契约 + cancel 5 阶段边界 + A4 chunked 透传 |
| 🔴 **Critical** | `clearStaleSuccessfulRawJson` | N4-cont-1 | NOT IN 子查询排除差异行是资金红线；sentinel `''` 修订（v0.3）兼容 v2.1.8 N4 NOT NULL；idempotent 守卫契约 |
| 🔴 **Critical** | `ensureDiffRowsCascadeMigration_v2_1_10` | N4-cont-2 | DB 不可逆 schema 改造；8-status state machine + SR-backup-1 前置 + 跨版本 v2.1.7/v2.1.8/v2.1.9 → v2.1.10 一步迁 |
| 🔴 **Critical** | `acquiring_bill_currency_diff_rows` FK CASCADE schema | N4-cont-2 | spec §九 拍板必升格；FK 范式 vs v2.1.9 N5 channels 差异（ON DELETE vs ON UPDATE）+ 与 N4-cont-1 配合契约 |
| 🟡 **Important-skeleton** | `serializeError` / `deserializeError` | A3 | worker / main 跨进程错误回传契约；FileValidationError 专属字段 + cause 链递归 + SR-log-1 集成 |

### 更新条目（1 条）

| 变量 | 更新内容 |
|---|---|
| `bill_imports.raw_json`（Critical 原 v2.1.8 N4）| 加 v2.1.10 N4-cont-1 sentinel 语义（v0.3 `''` 而非 `NULL` — 兼容 v2.1.8 NOT NULL schema）+ 差异行 raw_json 永远保留契约 |

### 未升格候选（spec §九 列出但本版未达硬升格门槛）

| 候选 | 跨度 / 次数 | 决策 |
|---|---|---|
| `insertDiffRowsByJoinChunked` | A-pair / 3 次 | A4 chunked 实施函数；语义与 `runCheckCore` 联动；不单独升格（已被 `runCheckCore` 条目"A4 chunked 分批集成"段覆盖）|
| `setRunChunkProgress` / `getRunChunkProgress` | A-pair / 6 次 + 3 次 | A4 chunked progress 持久化；resume 入口（v2.1.11+ 评估 UI）；属 internal helper，不单独升格 |

### v12 总条目数变化

| 层级 | v11 | v12 | 变化 |
|---|---:|---:|---|
| Critical | 31 | 35 | +4（runCheckCore / clearStaleSuccessfulRawJson / ensureDiffRowsCascadeMigration_v2_1_10 / diff_rows FK schema）|
| Important-skeleton | 14 | 15 | +1（serializeError/deserializeError 联条）|
| Runtime-state | 11 | 11 | 0 |
| Risk-sensitive | 23 | 23 | 0 |
| Minor | 6 | 6 | 0 |
| **总计** | **85** | **90** | **+5（不含 1 条更新）**|

---

## 三、自动统计基线变化（v2.1.9 vs v2.1.10）

| 指标 | v2.1.9 baseline | v2.1.10-beta.1 | 变化 |
|---|---:|---:|---|
| JS 文件数（src/） | 85 | 94 | +9 |
| 顶层声明数 | 853 | 1000 | +147 |
| A-share（跨 ≥ 3 文件） | 146 | 159 | +13 |
| A-pair（跨 2 文件） | 247 | 290 | +43 |
| A-local（仅单文件，≥ 3 次） | 359 | 444 | +85 |
| B（仅单文件，< 3 次） | 393 | 449 | +56 |

主要新增（A-pair 跨 2 文件 → 候选）：
- `serializeError` / `deserializeError`（A3）— 已升格 Important-skeleton
- `ensureDiffRowsCascadeMigration_v2_1_10`（N4-cont-2）— 已升格 Critical
- `setRunChunkProgress` / `getRunChunkProgress` / `insertDiffRowsByJoinChunked`（A4）— 不升格（internal helper）
- `runCheckCore`（A3）— 已升格 Critical
- `clearStaleSuccessfulRawJson`（N4-cont-1）— 已升格 Critical

---

## 四、PR body 粘贴用块

复制以下段落到 PR body（v2.1.10 β PR 提交时使用）：

````markdown
### ⚠️ 关联功能 review（check-vars / 2026-05-28）

| 层级 | 命中数 | 关键变量 |
|---|---:|---|
| 🔴 Critical | 6 | `FileValidationError`（A3 serializeError 覆盖✅）/ `unmatchedRows`（与本版无交集✅）/ **`runCheckCore`**（A3 核心算法✅）/ **`clearStaleSuccessfulRawJson`**（N4-cont-1 资金红线 NOT IN✅）/ **`ensureDiffRowsCascadeMigration_v2_1_10`**（N4-cont-2 8-status✅）/ **`acquiring_bill_currency_diff_rows` FK schema**（CASCADE × 2✅）|
| 🟡 Important-skeleton | 5 | `cleanupAfterRunBackground` / `ipcRenderer` / **`serializeError`**（A3 跨进程错误回传契约✅）/ `settingsRepository` / `setupIdleCleanupTimer`（全部已对照 review，无回归）|
| 🟢 Runtime-state | 3 | `app` / `dialog` / `state`（均无 schema 改动）|
| 🟢 Risk-sensitive | 3 | `ensureBillRawJsonV2Slim` / `hasColumn` / `lastUserActivityTs`（均无契约改动）|

#### v2.1.10 升格（rules/important-variables.md v11 → v12，+5 条 / 更新 1 条）

- 🔴 Critical：`runCheckCore`（A3）/ `clearStaleSuccessfulRawJson`（N4-cont-1 资金红线 NOT IN 子查询）/ `ensureDiffRowsCascadeMigration_v2_1_10`（N4-cont-2 DB 不可逆 8-status）/ `acquiring_bill_currency_diff_rows` FK CASCADE schema（N4-cont-2 spec §九 拍板）
- 🟡 Important-skeleton：`serializeError` / `deserializeError`（A3 跨进程错误回传契约）
- 更新 Critical：`bill_imports.raw_json` 扩 N4-cont-1 sentinel `''` 语义 + 差异行永不清空契约

详见 `docs/iterations/v2.1.10/check-vars-report.md`。
````

---

## 五、后续节点

- **PR 提交前**：把"§四 PR body 粘贴用块"贴到 PR body
- **合并 main 前**：再跑一次 `npm run check:vars --since main`（如 main 有新 commit 进来时）
- **v2.1.11+ 升格候选追踪**：A-share / A-pair 新增的候选条目持续监控（如 `setRunChunkProgress` / `getRunChunkProgress` 若 UI resume 功能落地，可能升格 Important-skeleton）

---

**报告结束**。
