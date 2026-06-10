# Spec — db-bloat-governance-startup-first 主库膨胀治理 + 启动窗口先行（change B / backlog B7）

> status: propose
> owner: pzhong
> created: 2026-06-10
> updated: 2026-06-10
> 目标版本：**待拍板**（建议 v3.1.0 独立 minor，分 4 个阶段 PR；Phase 0 可前置）
> 性质：🔴 **资金红线 + DB 迁移 + 启动时序**——本项目最高风险等级。每阶段 PR 前必跑 `/check-vars`（预命中清单见 §5.3），实施走 PM PRD → spec 细化 → dev → 用户手测循环。
> 来源：2026-06-10 性能/体积调研（`knowledge/backlog.md` B7）。

---

## 1. 背景（2026-06-10 实测证据，均有出处）

- 用户报告：点击应用后前端页面显示越来越慢。
- **启动指标**（`~/Documents/网银账单生成小助手/app_activity_log.txt`「启动耗时/渲染层启动耗时」条目）：
  - 渲染层初始化 ~50ms、建窗到可见 ~110ms → **前端不是瓶颈**；
  - 进程启动到可见：基线 **1.2~1.5s**，版本升级首启 **28530ms**（v2.1.8 N5 迁移）/ **38126ms**（N4-cont-2 迁移 2,596,169 行 + 备份），全部消耗在 `createWindow()` 之前。
- **主库膨胀**（本机 `{userData}/tool-data.sqlite`）：
  - 文件 **15GB**；`PRAGMA page_count` = 3,935,932（×4096）、`freelist_count` = 2,407,169 页 ≈ **9.86GB（61%）为删除后未回收空洞**；
  - 表历史写入（MAX(rowid)）：`acquiring_bill_currency_bill_imports` **18,462,096**、`acquiring_bill_currency_diff_rows` **20,769,352**、`biz_op_recon_imports` 1,667,366、`linked_bank_deposit` 1,315,783；
  - 启动期孤儿清理曾单次删除 **4,615,524 行**（activity log 16:42 段）。
- **备份失控**：`backups/` **31GB** + 根目录 `tool-data.sqlite.bak-20260608` **15GB**，无保留策略；本机该应用合计占用 **~62GB**。
- **根因**：三个对账模块把 run 级批量数据写入主库 → run 后 DELETE → SQLite 文件永不收缩。全代码无任何空间回收机制（grep：VACUUM 仅出现在备份 `VACUUM INTO`，无 auto_vacuum / incremental_vacuum）。

## 2. 代码现状（出处）

### 2.1 启动链（窗口被压在队尾）

`src/main.js:12260` `app.whenReady()` 同步顺序执行：`initializeActivityLog` → usage-stats 读写 → `database.init()`（15GB 主库 + 106 条幂等 DDL，`src/backend/database/migrations.js` 2907 行）→ `ensureUiStyleDefault` → `openPendingDb`（第二个 SQLite，1.5GB）→ `runOwnAccountsMigration` → `syncTemplateLibraryFile` → 11 组 `register*Handlers` → **`createWindow()`**（`main.js:12353`）。窗口本身是健康的 `show:false` + `ready-to-show`（`main.js:2843-2871`）。

### 2.2 run 级数据写入/清理路径

- 写入：`src/backend/acquiring-bill-currency-db/import-repository.js`（`insertFlowRow` / `insertBillRow`）、`run-repository.js`（`insertDiffRowsByJoin`，chunked）；编排 `src/main-process/acquiring-bill-currency-session.js`（`runCheckCore` 5 阶段）+ `run-check-worker.js`（worker 独立 DB 连接，PRAGMA 6 条清单）。biz-op-recon / bank-bu-recon 同模式（`src/backend/biz-op-recon-db/*`、`bank_bu_recon_*` 表）。
- 清理：`cleanupAfterRunBackground`（50000 行/批 + setImmediate）、`setupIdleCleanupTimer`（idle 30min，`main.js:10620` 附近）、`cleanupOrphanData`（启动期 setImmediate，`main.js:12365` 附近）、`clearStaleSuccessfulRawJson`（raw_json retention）。**`node:sqlite` DatabaseSync 是同步 API——这些批量 DELETE 都在主进程执行，批内阻塞所有 IPC**。
- 约束机制：FK `ON DELETE CASCADE`（v2.1.10 N4-cont-2，`migrations.js:1506-1515`）、raw_json 瘦身契约（v2.1.8 N4）、差异行 raw_json 永留契约（N4-cont-1）。
- 备份：`createBackupFn`（SR-backup-1，`src/backend/database/backup.js`，VACUUM INTO）→ `{userData}/backups/`；一次性迁移触发，无数量上限。

## 3. 目标

- **必做**（量化验收见 §8）：
  1. 主库稳态体积 ≤ 50MB（run 级数据不再落主库）
  2. 版本升级首启 ≤ 3s、日常启动基线 ≤ 1.5s 不退化
  3. 窗口显示与 DB init **解耦**：点击到窗口可见 ≤ 300ms（loading 态）
  4. backups 有界：保留最近 2 份，旧备份自动清
  5. 防复发约定固化进 `rules/`
- **可不做**：`tool-data-pending.sqlite`（1.5GB，Pending 模块）治理——独立生命周期（月度归档），列为观察项。
- **明确不做**：**不改任何对账算法语义**——`runCheckCore` 5 阶段、diff JOIN SQL、epsilon、清算字段取值等零改动，parity 断言锁定（§8.1）。

## 4. 方案（4 阶段 = 4 个独立 PR，可分版本落地）

### Phase 0 — 备份治理 + 一次性空间回收（独立可先行，低风险）

- `backups/` 保留最近 2 份（mtime 排序），超出部分启动后台清理（setImmediate + activity log 记录每个被删文件）；根目录 `tool-data.sqlite.bak-*` 旧格式文件纳入同一策略。
- 一次性 VACUUM 主库：迁移式（app_settings 标志位幂等 + 完成前 UI 进度提示「正在优化数据库，首次约 X 分钟」）。预期本机 15GB → ~6GB；Phase 1/2 完成后第二次 VACUUM 收口到 MB 级。
- ⚠️ 删除用户数据（旧备份）——保留策略、删除日志、首次执行提示文案需用户过目（D8）。

### Phase 1 — acquiring run 级数据 → per-run 侧库（最大头，建立样板）

- 文件布局（D3）：`{userData}/run-data/acquiring-bill-currency/run-{runId}.sqlite`；`bill_imports` / `flow_imports` / `diff_rows` 三表迁出；`runs` 元数据留主库（轻量，含侧库文件相对路径 + 状态）。
- 生命周期：删 run（用户删除 / 孤儿清理 / cleanup）= **删侧库文件**——原子、零碎片、零 VACUUM、不再有百万行 DELETE 阻塞主进程。
- 机制简化映射：
  - FK CASCADE（run→diff_rows）：侧库内同库保留 bill↔diff FK；run 级联 = 删文件；
  - `clearStaleSuccessfulRawJson` / idle cleanup / `cleanupAfterRunBackground`：行级清理降级为文件级（成功 run 超 retention → 直接删侧库文件或仅保留 diff 表，D4）；
  - `cleanupOrphanData`：启动扫描 `run-data/` 目录 vs 主库 runs 元数据，孤儿文件直接删（替代 461 万行批量 DELETE）。
- worker：`run-check-worker.js` 直接打开侧库文件（沿用现有独立连接 + PRAGMA 清单；跨库需 ATTACH 主库只读取 runs 元数据或经参数传入，T 阶段定）。
- 历史数据处置（D2，推荐 b）：a) 一次性迁移到侧库；**b) 旧数据原地保留、新 run 走侧库，读路径双源（先侧库后主库），下个版本移除双源并二次 VACUUM**；c) 提示用户后清空（❌ 差异表历史重导出是真实功能，不可默认清）。
- **parity 锁定**：同一输入 fixture 在改造前后差异表 xlsx **byte-for-byte 一致**（复用 v2.1.10 A3 contract-test 思路）。

### Phase 2 — biz-op-recon + bank-bu-recon 推广同模式

- 套用 Phase 1 样板（各自表集合：`biz_op_recon_{imports,flow_imports,diff_rows,runs}`、`bank_bu_recon_{bank_imports,pending_imports,runs}`）。
- **防复发关键**：只做 acquiring，主库会从其余模块缓慢复发（biz_op_recon_imports 已 166 万行）。

### Phase 3 — 启动窗口先行

- 新时序：`whenReady` → **立即 `createWindow()`**（窗口 + loading 态）→ 后台继续 init 链 → 完成后 `webContents.send('app:init-done')` 放开功能。
- renderer：启动期状态框显示「正在初始化…」，`app:get-info` 等待 init-done（renderer 已是异步初始化链，改造点集中在入口排队）。
- ⚠️ IPC 时序风险：handlers 注册晚于窗口加载 → renderer invoke 报 no handler。方案候选（T 阶段定）：① `register*Handlers` 提前到 createWindow 前（11 组注册函数若仅闭包引用 database、不在注册时解引用，则零成本——需逐组核实）；② 统一早期 gate（init 完成前 invoke 排队/拒绝重试）。
- 回退开关（D5，推荐加）：setting/env 控制新旧时序，稳定一个版本后移除。

### Phase 4 — 守卫固化（防复发）

- 新增 `rules/run-scoped-data-policy.md`：「对账类模块的 run 级批量数据**禁止写主库**，必须走 per-run 侧库」+ 侧库管理器使用约定。
- `rules/important-variables.md` 升格本次新符号（侧库管理器、路径常量、孤儿扫描入口等），更新受影响旧条目（§5.3）。
- 发版 checklist 增加启动指标确认项（activity log「启动耗时」基线对比）。

## 5. 影响范围

### 5.1 代码

- 后端：`database.js` / `migrations.js` / `acquiring-bill-currency-db/*` / `biz-op-recon-db/*` / 各 session / `run-check-worker.js` / `main.js` 启动链与清理编排。
- 前端：loading 态 + init-done 门控（`renderer.js` 初始化入口）。
- 新增：侧库管理器模块（建议 `src/backend/run-data-store.js`）、`rules/run-scoped-data-policy.md`。

### 5.2 数据（🔴 人工复核区）

- 三模块 run 数据存储位置变更；Phase 0 删除旧备份；历史数据双源过渡期读路径变更。
- 不可逆点必须在各 PR spec 中显式标注 + SR-backup-1 前置备份 + 8-status 迁移范式（沿用 v2.1.9/v2.1.10 惯例）。

### 5.3 check-vars 预命中（提 PR 时逐条对照清单 review 要点）

`runCheckCore`、`cleanupAfterRunBackground`、`setupIdleCleanupTimer`、`clearStaleSuccessfulRawJson`、`ensureDiffRowsCascadeMigration_v2_1_10`、`acquiring_bill_currency_diff_rows` FK CASCADE schema、`bill_imports.raw_json`、`AppDatabase` / `AppDatabase.init`、`lastUserActivityTs` + `IDLE_CLEANUP_MS`、`app`（whenReady 链）。
⚠️ 注意：本 change 大量改动是**调用时序与数据位置**而非变量名——现版 check-vars 对此类改动命中弱（见 check-vars 评估），review 不能只依赖工具输出。

## 6. 技术决策

- **D1 侧库方案**：a) **per-run 独立文件（推荐）**——删文件即回收、零碎片、无 VACUUM、崩溃恢复=删孤儿文件；b) 单一侧库 + `auto_vacuum=INCREMENTAL`——仍有写放大与回收调度复杂度；c) 主库开 auto_vacuum——改造最小但回收不彻底（页面重排成本 + 不解决迁移备份 15GB 问题）。
- **为什么不是"VACUUM 一下完事"**：不治本——下一次百万行 run 再次膨胀；且 15GB VACUUM 在用户机不可控（分钟级、双倍磁盘峰值）。Phase 0 的 VACUUM 只是止血，结构性解法是数据出主库。
- **双库一致性**：主库 runs 元数据与侧库文件非同事务。以**侧库文件存在性为准**：启动孤儿扫描双向兜底（有文件无元数据 → 删文件；有元数据无文件 → 标记 run 失效）。用户手删侧库文件 → 对应 run 降级显示"数据已清理"，不崩溃。
- **可能风险**：worker 跨库访问的 PRAGMA/锁行为差异；双源读路径期间的 UI 列表合并；迁移窗口断电（8-status + 备份覆盖）。

## 7. 数据 / 状态 / 安全影响

- 状态流转：迁移沿用 8-status state machine + `createBackupFn` 注入 + app_settings 标志位幂等（v2.1.10 N4-cont-2 范式）。
- 回滚策略：
  - Phase 0/1/2：迁移失败 ROLLBACK + 前置备份保留；标志位不写 → 下次重试；
  - Phase 3：回退开关切回旧时序（D5）；
  - 侧库目录可整体删除回到"无历史 run"状态，不影响主库模板/设置/联动表数据。
- 权限/安全：无新增外部接口；侧库文件继承 `{userData}` 目录权限。

## 8. 验收与测试

1. **parity（资金红线核心）**：固定 fixture（含多币种/差异行/空流水边界）改造前后差异表 xlsx byte-for-byte 一致；diff_rows 行数与 summary 全等。
2. **体积**：跑一次 400 万行级 run → 主库增量 < 10MB；删 run → `run-data/` 文件消失、磁盘即时回收。
3. **启动指标**（activity log 自动记录 + `npm run startup:measure`）：升级首启 ≤ 3s；日常基线 ≤ 1.5s；Phase 3 后建窗 ≤ 300ms。
4. **兜底**：run 中途 kill 进程 → 重启孤儿扫描清理侧库文件 + 元数据一致；回退开关来回切换无残留。
5. **回归**：`npm run release-check` 全绿（smoke 19 suite + unit + integration）；三模块真实数据回放由用户手测循环确认（per memory 流程）。

## 9. 待拍板清单

- [ ] **D1** 侧库方案（推荐 a：per-run 独立文件）
- [ ] **D2** 历史 run 数据处置（推荐 b：双源过渡，下版本收口）
- [ ] **D3** 侧库路径/命名（建议 `{userData}/run-data/{module}/run-{id}.sqlite`）
- [ ] **D4** retention 归属（推荐：行级清空 → 文件级删除/保留 diff 的二态）
- [ ] **D5** Phase 3 回退开关（推荐加，稳定一版后移除）
- [ ] **D6** 一次性 VACUUM 时机与进度提示文案（推荐迁移式 + 状态框提示）
- [ ] **D7** 目标版本与 PR 切分（推荐 v3.1.0 共 4 PR；Phase 0 可前置进 v3.0.3 与 change A 同窗口）
- [ ] **D8** Phase 0 备份保留数量（推荐 2 份）与删除提示方式
