# Tasks — v2.0.0

> 每个 task 尽量小、可验证、可独立完成。对应 TechDoc §四 的 T1~T12。

## Task 1 — 独立 DB 基建 + migrations

**涉及文件**：`src/backend/pending-db.js`（新）+ `pending-db/migrations.js`（新）+ `src/main.js`（open pendingDb）

**子步骤**：
1. 写 `pending-db.js`：facade 暴露 `openPendingDb(userDataDir)`，返回 DatabaseSync 实例
2. 写 `pending-db/migrations.js`：`runMigrations(db)` 幂等建 5 张表 + 索引（schema 见 TechDoc §3.3）
3. `src/main.js` 启动序列加 open pendingDb + runMigrations
4. 错误处理：migration 失败不阻塞启动，记 activity log（参考 v1.5.3 own-accounts-migration 决策 D15）

**验收**：
- 启动应用后 `{userData}/tool-data-pending.sqlite` 文件生成
- 用 `sqlite3` CLI 查 `.schema` 看到 5 张表全建
- 重启应用 migration 不报错（幂等）

**状态**：todo

---

## Task 2 — 顶部模块切换改为下拉

**涉及文件**：`index.html`（button→select）、`src/renderer.js`（删除旧切换动画 L1068-1090；加 setCurrentTopModule）、`src/styles.css`

**子步骤**：
1. `index.html:31` 替换 `moduleSwitcherBtn` 按钮为 `<select id="topModuleSelect">` 三选项
2. `src/renderer.js` `MODULES` 加 `pendingReconciliation`
3. 新增 `setCurrentTopModule(id)` 函数：show/hide 三个容器
4. 删除 `moduleSwitcherBtn` 的展开动画逻辑（确认没其他引用）
5. `styles.css` 加 `.top-module-select` 样式

**验收**：
- preview:main-page 截图显示下拉
- 切换三个值能 show 对应 container（Pending 容器现在空壳也行）
- 现有两个模块的切换行为保持不变

**状态**：todo

---

## Task 3 — Pending 模块骨架

**涉及文件**：`index.html`（#pendingContainer）、`src/renderer-pending.js`（新）、`src/renderer.js`（state.pending 初始化）

**子步骤**：
1. `index.html` 加 `#pendingContainer` + 两行布局（4 按钮 + 状态框）
2. `src/renderer-pending.js` 新文件：导出 `createRendererPending({ state, elements, desktopApi, openModal, ... })`
3. `renderer.js` 初始化 `state.pending = { rule: null, months: [], latestRunResult: null, importing: false, running: false, errorReportPath: null }`
4. 按钮初始禁用（规则未读、数据未导入），只有"规则管理"可点
5. 状态框默认文案 `初次使用请确认用来筛选的字段~`

**验收**：
- 切到 Pending 模块看到完整布局
- 按钮禁用状态正确
- 状态框显示初始文案

**状态**：todo

---

## Task 4 — 规则管理（UI + IPC + repository）

**涉及文件**：`src/renderer-dialogs.js`（createPendingRuleDialog）+ `pending-db/rule-repository.js` + `src/preload.js` + `src/main.js`（IPC handlers）

**子步骤**：
1. `rule-repository.js`：`getRule(db)` / `upsertRule(db, { matchFields, compareFields })`
2. IPC `pending:rule:get` / `pending:rule:save`
3. `preload.js` 暴露 `window.desktopApi.pending.getRule` / `.saveRule`
4. `createPendingRuleDialog`：两个多选下拉 + blur 出弹时调 createConfirmDialog
5. 启动时 `renderer-pending.js` 加载规则到 state.pending.rule

**验收**：
- 打开对话框，下拉选项 31 项
- 选 {pending类型, order_no} + {金额, 币种} → 确认 → DB 查 `rule` 表有行
- 再次打开对话框，上次选的值回显

**状态**：todo

---

## Task 5 — 导入 worker（child process）

**涉及文件**：`src/backend/pending-import/worker.js` + `validator.js` + `pending-db/month-repository.js`

**子步骤**：
1. `validator.js`：
   - `validateHeaders(sheet)` 严格比对 PENDING_COLUMNS
   - `validateFundType(value)` ∈ {提现/退票/充值}
   - `computeRowHash(cells31)` SHA-1
2. `worker.js`：接 argv [jobId, dbPath, yyyymm, filesJson]，open DB，循环每个文件读→验→批量 INSERT（5000/批 + transaction）
3. `month-repository.js`：`upsertMonth(db, meta)` + `insertRowsBatch(db, rows)` + `deleteMonth(db, yyyymm)` + `countByMonth(db, yyyymm)`

**验收**：
- worker 命令行直接跑小文件（100 行）能入库
- 表头错的文件 exit code 非 0，stderr 有 error 信息
- 跨文件重复行冲突 → 整批 rollback

**状态**：todo

---

## Task 6 — 导入入口（UI + session + 覆盖留底）

**涉及文件**：`src/main-process/pending-session.js`（新）、IPC handlers、`src/renderer-dialogs.js`（createPendingImportMonthDialog + 覆盖确认）、`renderer-pending.js`、`preload.js`

**子步骤**：
1. 文件选择对话框（`dialog.showOpenDialog` 支持 multiSelections）
2. 月份选择对话框（年份 current-9 ~ current+1 / 月份 1-12）
3. 覆盖检查：调 `month-repository.countByMonth` 判断是否已有
4. 覆盖确认：如有 → 弹 createConfirmDialog；确认后 → 调 `pending-export/writer` 留底（新写一个简化版，仅导出原 31 列）→ 写到 `pending-archives/{yyyy-mm}/`
5. spawn worker
6. 进度回传（status 框轮询 / 事件驱动）
7. 完成处理：更新 state.months，状态栏结果文案

**验收**：
- P0-3 单文件导入
- P0-4 表头错
- P0-5 多文件合并
- P0-6 行级冲突
- P0-7 覆盖留底

**状态**：todo

---

## Task 7 — 对账 engine + benchmark

**涉及文件**：`pending-reconcile/engine.js` + `benchmark.js` + `pending-db/diff-repository.js` + IPC handlers

**子步骤**：
1. `benchmark.js`：`estimateRunTimeMs(db, upper, lower, rule)` LIMIT 10000 JOIN 采样
2. `engine.js`：`runReconciliation(db, upper, lower, rule)` 按 TechDoc §3.6 三段 SQL
3. `diff-repository.js`：`createRun(db, meta)` + `insertDiffRows(db, rows)` + `listRunsForMonth(db, lowerMonth)` + `getRunById(db, runId)`
4. IPC `pending:reconcile:benchmark` / `pending:reconcile:run` / `pending:diff:runs-for-month` / `pending:diff:runs-all`
5. ⚠️ **资金风险红线**：单测覆盖 new/missing/changed 三类，用 5 行小数据集人肉比对

**验收**：
- 构造 2 个月各 5 行小数据集（手工算出应产 new 1 / missing 1 / changed 2 / 其他 1）
- 跑 engine 后 `diff_rows` 表查出精确匹配
- benchmark 对 100 行数据 < 100ms

**状态**：todo

---

## Task 8 — 开始运行 UI + 相邻月校验

**涉及文件**：`createPendingReconcileDialog` + `renderer-pending.js`

**子步骤**：
1. 弹窗下拉 = pending_months 按 `YYYY-MM desc`
2. 点完成 → 二次 createConfirmDialog
3. 相邻校验：`isAdjacentMonths(upper, lower)` 纯函数
4. 不相邻 → createAlertDialog 回到弹窗保留已选值
5. 通过 → 调 benchmark → 状态栏"预计 X 秒..."→ 调 run → 状态栏结果

**验收**：
- P0-8/P0-9/P0-10（含跨年相邻 2025-12 ↔ 2026-01）
- P0-11 无差异场景

**状态**：todo

---

## Task 9 — 导出差异 writer + 单月 run 选择 + 汇总

**涉及文件**：`pending-export/writer.js`（新）+ `createPendingExportDialog` + IPC `pending:diff:export-*`

**子步骤**：
1. `writer.js` 单月：读 run 的 `rule_snapshot` → 组装列 → 读 diff_rows JOIN pending_rows → 按 `pending资金类型` 分 sheet → xlsx-js-style 写 Courier New 表头
2. `writer.js` 汇总：每月取最新 run → 并集列 → 按月 label 分段 / 全表 2 个 sheet
3. `createPendingExportDialog`：单选"指定月 + run"/"汇总"；Run 下拉格式 `{time} 规则 {...}`
4. 保存走 `dialog.showSaveDialog`

**验收**：
- P0-12 单月导出（4 个 sheet：汇总 + 提现/退票/充值）
- P0-13 汇总导出（Sheet1 按月区别 + Sheet2 总汇总）
- 打开文件人眼核对列扩展（`_before`/`_after` 对应 changed 行）

**状态**：todo

---

## Task 10 — 状态框完整流 + 报错链路

**涉及文件**：`renderer-pending.js`（computePendingStatusText）+ `pending:error:export-report` IPC

**子步骤**：
1. 实现 `computePendingStatusText(state.pending)` 纯函数，按 PRD §5.4.8 返回文案
2. 状态框支持 `link` 区域（点击事件）触发报错文件导出
3. 覆盖每种错误文案
4. 报错文件 writer：`source_file / row_index / error_type / error_detail / 31 列原内容`

**验收**：
- 人工切换 state 看文案变化
- 触发表头错 / 资金类型错 / 行级冲突 三类 → 导出报错 xlsx → 内容正确

**状态**：todo

---

## Task 11 — 文档三件套同步

**涉及文件**：`CHANGELOG.md` / `docs/VERSION_FEATURE_HISTORY.md` / `docs/USER_GUIDE.md`

**子步骤**：
1. CHANGELOG 加 v2.0.0 条目
2. VERSION_FEATURE_HISTORY 加 v2.0.0 模块详细介绍
3. USER_GUIDE 加新章节介绍 Pending 模块使用方法（含截图）
4. 预览截图生成（新增 `preview:pending-*` 若干）

**验收**：
- 三个文件 diff 过
- USER_GUIDE 截图链路可跑（`preview:pending-*`）

**状态**：todo

---

## Task 12 — 性能回归（大文件）

**涉及文件**：无代码改动，测试数据准备 + 文档

**子步骤**：
1. 用户提供 300 万行真实样本
2. 跑 P1-1：导入时间 / 对账时间 / 导出时间
3. 对比 PRD §九目标（3 分钟或放宽到 5 分钟）
4. 若超标 → 性能优化 task（另开）

**验收**：P1-1 通过

**状态**：todo

---

## 关键依赖链

```
T1 → T2 → T3 → T4 → T5 → T6 → T7 → T8 → T9 → T10 → T11 → T12
```

### 关键节点（人工复核红线）

- **T1 schema 定型**：后续全依赖；migration 幂等
- **T5 worker + batch INSERT**：⚠️ 性能（R-T1），300 万行 < 5 分钟
- **T7 对账 engine**：⚠️ **资金敏感** — 差异语义错会让用户决策错，必须手工算过小数据集人眼验
- **T9 导出 writer**：⚠️ 列顺序、`_before`/`_after` 对应关系错会让用户看错数据，4-6 行样本人眼过

---

## 变更记录

| 日期 | 变更内容 |
|------|---------|
| 2026-04-23 | 初建，12 个 task，对应 TechDoc §四 |
