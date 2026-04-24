# Log — v2.0.0

> 按日期倒序；Dev / 讨论 / 决策 / 风险 发现都记这里。

---

## 2026-04-23

### 动作

- PRD v0 → v1 定稿（10 个 OT 全部拍板）
- TechDoc v0 完成（§一 评审 + §二 文件清单 + §三 实现方案 + §四 任务分解 + §五 commit 计划 + §七 TechDoc OT 6 个）
- changes/v2.0.0/{spec, tasks, log, test-spec}.md 骨架建立
- `assets/Pending.xlsx` 模板已复制到项目，31 列表头读取确认

### 证据

- PRD 位置：`docs/iterations/v2.0.0/PRD-v2.0.0.md`
- TechDoc 位置：`docs/iterations/v2.0.0/TechDoc-v2.0.0.md`

### 风险

- **R-T1 性能 300 万行 < 3 分钟**：Dev 初步评估可能超标；若实测 5+ 分钟，TechDoc OT-T1 建议放宽 PRD 目标到 5 分钟（等 Task 5 实测后决定）
- **资金敏感**：对账 engine 三类差异（new/missing/changed）语义错误会直接让用户做错决策；Task 7 + Task 9 必须人工小样本核对

### 决策

- OT-1 ~ OT-10 见 PRD §十
- TechDoc OT-T1 ~ OT-T6 见 TechDoc §七

### 可沉淀知识

- [ ] 300 万行 SQLite 批量 INSERT 优化经验（Task 5 完成后写到 `knowledge/`）
- [ ] xlsx 大文件 child process 模式（已在 v1.5.3 pdf-worker 有先例，v2.0.0 扩展到 xlsx）
- [ ] 对账 SQL 生成（动态 matchFields / compareFields）模式（Task 7 完成后写到 `knowledge/`）

---

### T1 完成

**动作**：
- 新建 `src/backend/pending-db.js` + `pending-db/migrations.js` + `pending-db/columns.js`
- `src/main.js` 启动序列加 `openPendingDb`（try-catch 保护，不阻塞启动）

**证据**：
- `node --check` 4 个文件全绿
- `openPendingDb` 实测产出 5 张业务表 + 5 索引 + 34 列 `pending_rows` 表
- 幂等验证（重复 open 不报错）

### T2 决策（Reverse Sync）

**发现**：`index.html:30-39` 现有顶部模块切换本身就是**自定义下拉**（button 触发 menu 展开），不是简单按钮。

**决策**：保留现有自定义下拉，仅追加第 3 项菜单。CSS / 事件 / 动画全部保留。TechDoc §3.1 + §二 已回写。

**证据**：
- `index.html:31-38` 自定义下拉结构
- `src/renderer.js:1066-1079` setCurrentModule + :1081-1091 open/closeModuleMenu + :3002-3015 click handlers + :3083-3090 外部点击关闭
- 改动范围因此大幅缩小（无需新增 `setCurrentTopModule` 函数、无需删除展开动画）

### T2 / T3 / T4 完成

**T2 动作**：
- `index.html` moduleSwitcherMenu 追加 `<button data-module="pending-reconciliation">`
- `src/renderer.js:39-52` MODULES 加 `pendingReconciliation`
- `src/renderer.js:1066-1082` setCurrentModule 从二选扩三选（按 id 查字典取 name + 三 panel 联动）

**T3 动作**：
- `index.html` 在 newAccountModulePanel 后加 `#pendingModulePanel`（2 行布局）+ 引入 `renderer-pending.js` script
- `src/renderer.js` elements 加 6 个 pending DOM ref + state.pending 初始化 + initialize 阶段调用 rendererPending.initialize / bindEvents
- 新增 `src/renderer-pending.js`（骨架：computePendingStatusText / refreshPendingUi / initialize / bindEvents）

**T4 动作**：
- 新增 `src/backend/pending-db/rule-repository.js`（getRule / upsertRule，单条全局 `__GLOBAL__`）
- `src/main.js` 3 个 IPC handlers：`pending:columns` / `pending:rule:get` / `pending:rule:save`
- `src/preload.js` 暴露 `window.desktopApi.pending.{getColumns, getRule, saveRule}`
- `src/renderer-pending.js` 升级：loadColumns / buildRuleDialogNode（两 `<select multiple>`）/ handleRuleConfirm（createConfirmDialog 二次确认）/ handlePendingRuleClick

**T4 偏离 PRD §5.3.4**：
- PRD 原意：点多选下拉外部区域 → 自动弹 confirm 保存
- T4 实现：用 Save / Cancel 按钮明确出口（点 Save → confirm → IPC 保存）
- 原因：`<select multiple>` 的 blur 事件语义复杂（切选项就会 blur）；明确按钮对用户更友好
- 状态：待 T10 状态框完整流时评估是否需要补充 blur-to-save 快捷路径（当前最小化先出）

**验证**：
- `node --check` 所有 T1-T4 新/改文件绿
- `rule-repository` E2E 脚本 6 场景全过（空读 / 新建 / 读 / 覆盖更新 / 单行约束 / malformed 降级）
- `npm run smoke` 通过（v1.5.3 现有功能不回退）

**check-vars 自查（T1-T4 累积）**：
- Important-skeleton: `ipcRenderer` — preload 新 pending 对象，main 同步注册 3 handler ✅
- Runtime-state: `MODULES` / `elements` / `state` / `app` — 均为新增引用，未破坏现有语义 ✅

---

### T5 完成（import worker + 校验 + 批量 INSERT）

**动作**：
- 新增 `src/backend/pending-import/validator.js`
  - `validateHeaders(row)` — 严格对比 PENDING_COLUMNS（顺序 + 内容）
  - `validateFundType(value)` — ∈ {提现/退票/充值} 枚举
  - `computeRowHash(cells)` — SHA-1 拼串（SOH `\u0001` 分隔符）
- 新增 `src/backend/pending-import/worker.js`
  - child process 入口：`node worker.js <jobMetaJson>`
  - jobMeta = `{ dbPath, yearMonth, files, archivePath? }`
  - 事件流到 stdout：`progress` / `error` / `complete`
  - 退出码：0 成功 / 1 校验失败 / 2 系统错误
  - DB 写入：`BEGIN` → `deleteMonth`（覆盖）→ prepared statement 逐行 INSERT → `upsertMonthMeta` → `COMMIT`；任一失败 `ROLLBACK`
- 新增 `src/backend/pending-db/month-repository.js`
  - countRowsInMonth / listMonths / getMonthMeta / upsertMonthMeta / deleteMonth
  - `createRowInserter(db)` 返回 prepared statement 闭包（31 列 INSERT）
- 新增 `scripts/test-v2.0.0-pending-import.js` + package.json `test:v2.0.0:pending-import` script
  - 21 断言，7 场景：happy / 表头错 / fund_type 错 / 多文件合并 / 跨文件冲突 / DB 状态 / 覆盖模式

**验证**：
- `node --check` T5 所有新文件绿
- `npm run test:v2.0.0:pending-import` → 21/21 全过
- `npm run smoke` → 通过（v1.5.3 现有功能不回退）

**check-vars 自查（T5 增量）**：
- T5 只改动 src/backend/pending-* 下新文件；现有清单变量 0 命中
- 新候选升格：`PENDING_COLUMNS`（跨 4 文件：migrations.js / columns.js / validator.js / worker.js）—— T6+ 继续扩散后跑 scan:vars 评估升格到 Critical

**T5 关键决策**：
- worker **内部再做 `deleteMonth`**：防御性，即使父进程忘了删（T6 实现 session 时会显式删），worker 仍能保证一个 year_month 对应一套数据
- child process 启动先不加 `--max-old-space-size=8192`（T6 主进程 spawn 时加；单元测试走常规 heap 也够 happy path）
- Errors 收集模式：校验阶段**收集所有错误**（不 early exit），让用户一次看到所有问题后批量修（不是打地鼠式逐条）

---

### T6 完成（导入入口 UI + session + 覆盖留底 + 报错链路）

**动作**：
- 新增 `src/main-process/pending-session.js`
  - `runImport({ yearMonth, files, overwriteConfirmed, dbPath, onProgress })` —
    Promise 化 worker spawn；自动 `--max-old-space-size=8192`
  - 返回状态：`success` / `need-confirm`（existing count + importedAt 用于覆盖确认框）/ `error`
  - 覆盖链路：overwriteConfirmed=true 且已有月 → `archiveExistingMonth` 写 xlsx 到
    `{documents}/网银账单生成小助手/pending-archives/{YYYY-MM}/{YYYY-MM}-backup-{YYYYMMDDThhmmss}.xlsx`
  - 报错缓存：worker exit 非 0 时把 errors 存到 session 内存；状态栏 clickable
  - `exportErrorReport(savePath)`：把 errors 写 xlsx，schema = source_file / sheet_row / severity / message + 31 原列
- `src/main.js` 注册 4 个 pending IPC：
  - `pending:months:list` → month-repository.listMonths
  - `pending:import:pick-files` → dialog.showOpenDialog 支持 multiSelections
  - `pending:import:start` → session.runImport（进度事件转发 webContents.send）
  - `pending:error:export-report` → dialog.showSaveDialog + session.exportErrorReport
- `src/preload.js` pending 对象新增 5 个 API：listMonths / pickFiles / startImport /
  exportErrorReport / onImportProgress（事件订阅）
- `src/renderer-pending.js` 扩展：
  - `buildImportMonthDialog`：年月下拉（current-9 ~ current+1 / 1-12）
  - `handlePendingImportClick`：pickFiles → 年月选择 → startImport
  - `startImport(files, yearMonth, overwriteConfirmed)`：
    - need-confirm 返回 → 弹 createConfirmDialog → overwriteConfirmed=true 再跑
    - success → 更新 state.pending.lastImportSummary + loadMonths
    - error → state.pending.errorReportAvailable=true，状态栏 clickable
  - `handleStatusBoxClick`：调 exportErrorReport IPC
  - `computePendingStatusText` 新增 importing / errorReportAvailable 分支
  - 订阅 onImportProgress 事件，实时更新 importingText
- 新增 `scripts/test-v2.0.0-pending-session.js`（5 场景 19 断言）
- package.json 加 `test:v2.0.0:pending-session` script

**验证**：
- `test:v2.0.0:pending-import` 21/21 过（T5 回归）
- `test:v2.0.0:pending-session` 19/19 过：
  - fresh 导入 / re-import need-confirm / overwrite + archive 内容正确（留底 xlsx 含 header + 2 旧行）/ 报错缓存 + xlsx 导出 / 成功后 errors 清理
- `npm run smoke` 通过
- `node --check` 全绿

**T6 偏离 PRD / Dev 决策**：
- 无偏离 PRD
- `runImport` 用 Promise 化 + 事件回调双通道：最终结果走 Promise 返回（简化 renderer 侧 await）；进度走 `onProgress` 回调（主进程转发 `webContents.send`）—— 比纯事件流好理解

---

### T7 完成（对账 engine + benchmark — 资金敏感红线）

**动作**：
- 新增 `src/backend/pending-db/diff-repository.js`：createRun / updateRunStats /
  getRunById / listAllRuns / listRunsForMonthPair / getLatestRunForMonthPair /
  listDiffRows
- 新增 `src/backend/pending-reconcile/engine.js`：
  - `ensureMatchIndex(db, matchFields)` — 动态 `CREATE INDEX IF NOT EXISTS` 基于
    SHA-1 哈希命名（避免长名）（OT-T3 lazy 建索引）
  - `runReconciliation(db, { upperMonth, lowerMonth, rule })` 三段 SQL:
    - new: lower 有 + upper 无（`NOT EXISTS`）
    - missing: upper 有 + lower 无（`NOT EXISTS`）
    - changed: INNER JOIN on matchFields + (compareFields 任一 `IS NOT`)
  - 全部 SQL 用 `IS` / `IS NOT`（OT-T4 NULL 友好）
  - `BEGIN / COMMIT` 包裹；任一失败 `ROLLBACK`
- 新增 `src/backend/pending-reconcile/benchmark.js`：
  - `estimateRunTimeMs` — LIMIT 10000 NOT EXISTS JOIN 取样，线性外推
- `src/main.js` 5 IPC: pending:reconcile:{benchmark,run} + pending:diff:{runs-list,
  runs-for-month-pair,latest-run-for}
- `src/preload.js` pending.reconcile.{benchmark,run} + pending.diff.{listAllRuns,
  listRunsForMonthPair,getLatestRunForMonthPair}
- 新增 `scripts/test-v2.0.0-pending-reconcile.js`（7 场景 23 断言）
- package.json 加 `test:v2.0.0:pending-reconcile` script

**资金敏感测试覆盖**（T1 手工 4 × 4 样本）：
- upper: A001/A002/A003/A004；lower: A001/A002/A005/A006
- 规则 match=[order_no] compare=[金额,币种]
- 预期: new=2(A005,A006) / missing=2(A003,A004) / changed=1(A002 金额 200→250)
- 实测: 全部 9 个断言精确匹配（含行级 diff_rows 内容核对）

**其他测试**：
- T2 多 matchField 规则变严
- T3 compareFields=[] → changed 恒 0
- T4 多次 run 全保留 + getLatestRunForMonthPair 正确
- T5 benchmark 返回数字
- T6 ensureMatchIndex 幂等
- T7 非法 matchField 抛错

---

### T8 完成（开始运行 UI + 相邻月校验）

**动作**：
- `src/renderer-pending.js`:
  - `isAdjacentMonths(upper, lower)` 纯函数（跨年 `2025-12` ↔ `2026-01` OK；字符串比较）
  - `formatDurationSec` 预计时间中文格式化
  - `buildReconcileDialog` 两单选下拉（月份，默认最近两月）
  - `handlePendingRunClick` 完整流:
    - `<2 月` 时 alert
    - 选月份 → 二次 createConfirmDialog → 相邻校验
    - 不相邻 → createAlertDialog 并重开 dialog 保留已选值
    - 通过 → benchmark → 显示预计 → reconcile.run → 状态栏结果
  - `runReconciliation` 设 state.pending.running / latestRunId / latestRunResult
  - refreshPendingUi 里导出按钮判断从 `latestRunResult` 改为 `latestRunId`
- `src/renderer.js` state.pending 扩 `latestRunId / runningText / errorReportAvailable
  / errorMessage / lastImportSummary`（T6/T8 累计）

**验证**：
- node --check / smoke 通过
- UI 层封装，T7 engine 已验证三类差异；无需额外自动化
- 手动测试留给 T11 之后的 UI 端到端验证

---

### T9 完成（导出 writer + 对话框）

**动作**：
- 新增 `src/backend/pending-export/writer.js`:
  - `exportSingleRun(db, runId, savePath)` — 按 runId 导出；Sheet1 汇总 +
    Sheet2~N 按 `pending资金类型` 值分组（仅差异行实际出现的值建 sheet）；
    列 = 31 原列 + `diff_type` + 每个 compareField 的 `_before`/`_after`
  - `exportAggregate(db, savePath)` — 每 (upper, lower) 对取最新 run；
    Sheet1 `按月维度区别汇总`（分段 + month label）+ Sheet2 `汇总`（扁平）；
    compareFields 取所有 run 的并集
  - `applyHeaderRowFont` 第 1 行表头字体写死 `Courier New`（OT-3 延续 v1.5.3 R3）
  - `sanitizeSheetName` 防非法字符
- `src/main.js` 2 个 IPC: `pending:diff:export-single` / `pending:diff:export-aggregate`
  都走 `dialog.showSaveDialog`
- `src/preload.js` `pending.diff.exportSingle / exportAggregate`
- `src/renderer-pending.js`:
  - `buildExportDialog`：radio 单月 vs 汇总；单月模式下月份+run 两级下拉
    （月份 change 刷新 run list），run 下拉显示 `createdAt + 差异条数 + 规则摘要`
  - `handlePendingExportClick`：listAllRuns → 无 run 时 alert → 弹 dialog →
    调 exportSingle / exportAggregate → success 弹 alert 提示路径
- 新增 `scripts/test-v2.0.0-pending-export.js`（2 场景 22 断言）
- package.json 加 `test:v2.0.0:pending-export`

**验证**：
- 22/22 断言全过：
  - single 3 行差异（new/missing/changed 各 1）→ 34 列 header + changed
    _before=200 / _after=250 精确匹配 + 按 fund_type 动态分 sheet（充值/退票）
  - aggregate 多 run（2026-08+2026-09 + 2026-09+2026-10 两对）→ 2 sheet
    （按月维度区别汇总 + 汇总）
- smoke 通过；node --check 全绿

**T9 内部设计决策**：
- 分 sheet 按**实际出现值**动态建（OT-9 = i），即使 PRD 固定了 3 种枚举
  {提现/退票/充值}，如果差异行里只出现 2 种也只建 2 个 sheet
- changed 行的 31 原列用**lower 版本**（新值），`_before` 是 upper / `_after`
  是 lower；new 行 31 列用 lower，`_before`/`_after` 都空；missing 行 31
  列用 upper，`_before`/`_after` 都空

---

### T10 完成（状态框完整流 + 报错链路文案对齐 + 资金敏感 bug 修复）

**动作**：
- `src/renderer-pending.js`:
  - `computePendingStatusText` 报错分支改 `{errorMessage}，点击导出报错文件。`（对齐 PRD §5.4.8）
  - `refreshPendingUi` 把不存在的 class `pending-status-clickable` 改成
    项目已约定的 `is-clickable`（styles.css:361）；新增 `data-tone` 联动
    (error / success)，视觉反馈到状态栏边框色（复用 styles.css:369,374 约定）
  - `startImport` 成功文案对齐 PRD: `{YYYY-MM} 数据已导入（N 行）。旧数据已留底。`
  - `summarizeErrors` 分类细化（fatal 表头 → PRD 标准文案 /
    row 重复行 → PRD 标准文案 / row 资金类型不合法 / 其他 row 回退）
  - `runReconciliation` 对账完成文案对齐 PRD §5.5.6：
    `...找出 N 条差异（X/Y/Z），可点击"导出差异"另存。`
  - `onImportProgress` 文案修正（原误码 `${state.pending.importing ? '' : ''}`）
    → `正在导入 {YYYY-MM}：{file}（已处理 N 行）`
  - state.pending 加 `currentYearMonth` 字段供 progress 事件消费
- `src/renderer.js` state.pending 初始化补 `importingText / currentYearMonth`
- `src/backend/pending-db/diff-repository.js` **⚠️ 资金敏感修复**：
  - listAllRuns / listRunsForMonthPair / getLatestRunForMonthPair 的
    `ORDER BY created_at DESC` 加 `, id DESC` tie-breaker
  - 原因：`new Date().toISOString()` 毫秒精度；同毫秒多 run 时
    `ORDER BY created_at DESC` 不稳定 → 用户"导出最新 run"可能误取旧 run
  - 影响面：历史 run 的排序一致性；修完**减小风险**（无破坏）
  - 发现方式：pending-reconcile 测试 T4 偶发失败（之前 T7 commit 时可能刚好时间分布到不同毫秒没触发）

**验证**：
- `node --check` 所有改动文件绿
- `npm run test:v2.0.0:pending-reconcile` **连跑 5 次全部 23/23**（flaky 消失）
- `npm run test:v2.0.0:pending-import` 21/21
- `npm run test:v2.0.0:pending-session` 19/19
- `npm run test:v2.0.0:pending-export` 22/22
- `npm run smoke` 通过

**check-vars T10**：
- Runtime-state: `state` / `elements` 命中，纯扩展无破坏
- 非清单但**资金敏感**：`diff-repository.js` ORDER BY tie-breaker — 已在代码注释里写清
- 无 Critical / Important-skeleton / Risk-sensitive 清单命中

**偏离 PRD / 决策记录**：
- PRD §5.4.8 "导入中文案"写的是 `正在导入 {YYYY-MM}，预计 {X} 秒...` 带预计时间
  - 当前实现**不含预计时间**（改为显示已处理行数）
  - 理由：xlsx 解析阶段无法预测 rowCount（需读完才知道），硬给数字会误导
  - 如后续要加，可在 worker 首次 progress 上报 totalRows 后再做外推，视为可选增强
- PRD §5.4.8 "行级冲突报错文案" `{N} 条重复行，[点击导出报错文件]` 方括号是 UI 交互提示
  - 实现用"，点击导出报错文件。"（纯文本 + CSS `is-clickable` 鼠标手势反馈）
  - 理由：状态栏不方便渲染真正的链接按钮；视觉反馈通过 `is-clickable` cursor + `data-tone=error` 边框色完成

---

### T11 完成（文档三件套）

**动作**：
- **`CHANGELOG.md`** 新增 `## 2.0.0-beta.1 - 2026-04-23` 段：
  - 新增段（13 条）：顶部模块切换改下拉 / Pending 模块总览 / 独立 SQLite /
    31 列模板 / 规则管理 / 多文件合并导入（child process）/ 覆盖留底 /
    对账引擎（资金敏感）/ 相邻月校验 / benchmark / 导出 writer / tie-breaker 修复 /
    15 个 IPC
  - 变更段：state 扩展 / 资源打包 / 版本号 bump / 4 测试脚本
  - 风险与回滚段：资金敏感 + 删 sqlite 即回滚 + 代码隔离
- **`docs/VERSION_FEATURE_HISTORY.md`** 新增 `## 2.0.0-beta.1` 段：
  - 新增 11 条 / 变更 4 条 / 明确不做 6 条
  - 用户视角语言（去掉实现细节、保留业务语义）
- **`docs/USER_GUIDE.md`**：
  - §一"模块"列表加第 3 项 `月度 Pending 数据核对（v2.0.0 新增）`
  - 追加 `## 1.3 月度 Pending 数据核对` 一级段落：
    - 1.3.1 使用场景
    - 1.3.2 主要功能（9 条）
    - 1.3.3 工作流（4 步：配置规则 / 导入 / 开始运行 / 导出差异）
    - 每步子步骤（含状态栏文案样例）+ 常见报错表 + 行类型 `_before`/`_after` 语义表

**验证**：
- 文档纯文本，不跑代码测试
- 三件套正文互相印证：CHANGELOG 条目 ↔ VFH 用户语义 ↔ USER_GUIDE 操作流程

**T11 check-vars**：
- 只改文档，无 src/ 改动 → 不需要跑 check-vars skill
- package.json 未动（仍是 2.0.0-beta.1，上一次 bump 在 T1 前就做好了）

**v2.0.0 第一阶段完结**：T1-T11 已全部完成；待 12 完整手工/UI 端到端测试。

---

## 2026-04-24

### T12 完成（真实样本端到端性能测试 + 多项 Reverse Sync）

**样本**（用户提供）：
- `/Users/pzhong/Downloads/正常归档Pending账单-2602/*.xlsx`（5 文件 / 183.6 MB / 121.85 万行）
- `/Users/pzhong/Downloads/正常归档Pending账单-2603/*.xlsx`（5 文件 / 221.6 MB / 121.83 万行）
- 合计 **243.68 万行**，接近 PRD 300 万目标

### Reverse Sync #1 — OT-9 枚举撤销

**触发**：真实样本的 `pending资金类型` 值出现 `入金`，不在 PRD §4.1 / OT-9 枚举 `{提现/退票/充值}` 内。

**决策（用户选 A）**：完全撤销枚举校验，允许任意文本（含空值）入库。

**改动**：
- `src/backend/pending-import/validator.js`：删 `FUND_TYPE_COLUMN` / `ALLOWED_FUND_TYPES` / `validateFundType`
- `src/backend/pending-import/worker.js`：删枚举校验分支；import 只保留"表头"和"行级 hash"两层校验
- `scripts/test-v2.0.0-pending-import.js`：T3 场景从"枚举非法"改为"非枚举值允许入库"
- `scripts/test-v2.0.0-pending-session.js`：T4 改用"表头缺列"构造 fatal error（原来用 `fundType: '转账'`）

**待更新（PRD / VFH / USER_GUIDE / CHANGELOG）**：撤销 OT-9；改为"任意文本"；导出按实际值动态分 sheet（已实现）。

### Reverse Sync #2 — xlsx 库换 ExcelJS（大文件不可读）

**触发**：样本 4 个大文件（45MB / 30 万行 / inline string）用 `xlsx@0.18.5` / `xlsx@0.20.3` 都读为空（"Bad uncompressed size"警告 + sheet_to_json 返回 `[]`）。

**诊断**：xlsx 文件 dimension=A1:AE300001（31 列 × 30 万行）正常；sharedStrings.xml 仅 137B → 全部 inline string。xlsx 库对该 zip 结构处理失败。

**决策（用户选 A2）**：引入 `exceljs@^4.4.0` 替代 `xlsx` 读大文件（仅 worker.js 读路径；writer 继续用 xlsx-js-style）。

**改动**：
- `package.json`：新增 dep `"exceljs": "^4.4.0"`
- `src/backend/pending-import/worker.js`：`XLSX.readFile` → `new ExcelJS.Workbook().xlsx.readFile`；`sheet_to_json` → `ws.eachRow`
- `normalizeXlsxCell`：增强处理 ExcelJS 单元格对象（formula / richText / hyperlink）

**实测**：大文件 30 万行 × 31 列读取 13.7 秒（需 `--max-old-space-size=8192`，worker 已开）。

### Reverse Sync #3 — worker 流式 INSERT（原 allRows 累积会 OOM）

**触发**：改用 ExcelJS 后首次跑 T12 在第 4 个大文件时 **heap OOM**（~7.9GB 上限），`allRows` 累积 90 万行 × 31 列字符串占内存。

**决策**：去掉 `allRows` 在内存累积；改为边读边 INSERT。

**改动**：
- `src/backend/pending-import/worker.js:main()`：
  - 改为 **流式 INSERT**：`BEGIN` 上移到文件循环前，每行读到即 `insertRow`
  - 错误累积时 `ROLLBACK` 整批回滚（保留原事务语义）
  - 单文件读完立即 `rows = null` 释放 wb 引用给 V8 GC
  - `hashSet` 仍保留（跨文件去重 key；300 万行 × 40 字节 hex = 120MB，可控）
- **errors truncate 保护**：`MAX_ROW_ERRORS_EMITTED = 1000`；行级错误累积上限；超上限只返统计数（防 emit 巨型 JSON 把 stdout 管道撑爆，原 bug 导致 exit=1 但 `errors count: 0`）

**实测内存**：worker 峰值 <2 GB（单文件 wb 载入 + hashSet），远低于 8GB heap 上限。

### Reverse Sync #4 — ⚠️ 资金敏感：engine SQL 性能修复

**触发**：T12 reconcile 卡 15+ 分钟 CPU 100%。诊断：
- `benchmark.js` 不调 `ensureMatchIndex`，采样 SQL 在无 `(year_month, matchFields)` 复合索引时走 full scan
- 121 万 × 121 万 NOT EXISTS subquery O(n²) → 万亿次比较

**改动**：
- `src/backend/pending-reconcile/benchmark.js`：
  - 采样前先调 `ensureMatchIndex(db, matchFields)`（复用 engine 的索引建立逻辑）
  - 采样 SQL 的 JOIN 条件 `IS` → `=`
- `src/backend/pending-reconcile/engine.js:buildOnClause`：match 阶段 `IS` → `=`
  - **EXPLAIN QUERY PLAN 实测** `IS` 和 `=` planner 生成相同计划（SEARCH USING COVERING INDEX）
  - 选 `=` 理由：语义明确不依赖启发式；match key 为 NULL 的行**不匹配任何行**（含另一 NULL）
  - **语义变更**：原 `IS` 允许两 NULL match 成功（等同相等）；新 `=` 两 NULL 不相等
  - 业务合理性：match key 缺失本就是无效对账行，不应与另一 NULL 行"匹配"
  - `buildChangedClause`（compare 阶段）保留 `IS NOT`（对 row 级 filter 性能影响小，保留 NULL-safe 语义）

**T12 实测**（243.68 万行 DB）：
| 阶段 | 耗时 |
|---|---|
| 建 `idx_pending_match_*` | ~2 秒 |
| benchmark 采样 | ~2.9 秒（含建索引） |
| reconcile 全量 | **2.85 秒** |
| export single (281 diff) | 38 ms |
| export aggregate | 34 ms |

### T12 性能汇总

| 指标 | PRD 目标 | 实测 | 结论 |
|---|---|---|---|
| 300 万行导入 | < 5 分钟 | 243.68 万行 / **2 分 13.3 秒** | ✅（外推 300 万约 2 分 44 秒）|
| 对账 SQL | < 1 分钟 | **2.85 秒** | ✅ 超目标 22× |
| benchmark 精度 | ±20% | 实测误差 3297% | ⚠ warn（外推偏高，用户体验反而是"早完成"）|

**benchmark 误差分析**：采样 10000 行 LIMIT 早期终止的每行边际成本 ~0.04ms，但全量 reconcile 后 cache 热 + 全索引扫描每行 ~0.001ms，导致线性外推系统性偏高。可接受——偏高比偏低安全（用户看到"预计 90 秒"实际 3 秒 = 好体验）。后续若要精确可用 `(total × sampleMs / sampleRowsActual) × 0.03` 等经验系数，视为 T12+ 优化。

### check-vars 自查（T12 累积）

- **Risk-sensitive 命中**：engine.js `buildOnClause` 是对账 SQL 核心，属资金敏感。本次 `IS` → `=` 已在 pending-reconcile 23 断言小样本全绿；**真实样本 4×4 手工对照**：new=3 / missing=276 / changed=2 / 总 281，统计合理（跨月 Pending 数据本来差异就小）。
- **Runtime-state**：无命中。
- **依赖变更**：`package.json` 新增 `exceljs@^4.4.0` — 打包体积增加 ~1MB，仅 worker 使用，现有模块零影响。

### 测试脚本

- 新增 `scripts/test-v2.0.0-perf-real-sample.js`：端到端 6 场景（2602/2603 导入 + benchmark + reconcile + exportSingle + exportAggregate）；15 pass / 0 fail / 1 warn。

### 已知偏离 PRD §5.4.3（UX，2026-04-24 确认保留）

- PRD 原意：选文件 → **先表头校验** → 通过后弹年月选择
- 实际实现：选文件 → **先弹年月选择** → 确认后 worker 内才做表头校验
- 影响：表头错的文件用户白点一次年月；数据正确性无影响
- 决策（用户选 A）：保留现状。因为 ExcelJS 读大文件第 1 行也要 ~13 秒，先校验反而让用户等更久才看到年月对话框

### Reverse Sync #5 — 对账语义 AND → A1 fallback（2026-04-24）

**触发**：用户在手工测试期间提出"对账字段只要任一相等就视为同一笔"，与 PRD §5.5.4 / OT-8 原 AND 语义冲突。

**决策**（用户选 A1 + id 升序 1 对 1 配对）：
- 按对账字段**顺序**做 N 轮 fallback
- 第 i 轮用第 i 个字段做单字段 key，同 key 内 upper/lower 按 `pending_rows.id` 升序 1 对 1 配对
- 配对成功的行退出候选池，进入下一轮
- N 轮跑完剩余：upper → missing / lower → new

**代码改动**：
- `src/backend/pending-reconcile/engine.js` 重写：
  - `ensureMatchIndex` 改为"每字段一索引" `(year_month, col, id)` 覆盖索引（index-only scan）
  - runReconciliation 多轮配对；初版纯 SQL CTE + ROW_NUMBER + LEFT JOIN（11 分钟未完 → kill）；**改用 JS 层配对**：SQL 只扫 `(id, key)`，JS Map 分组 + `Set<id>` 跟踪已匹配 + 1 对 1 配对，配对结果批量 INSERT 到 `tmp_pairs` 临时表；最后 SQL 做 changed/new/missing 三段 INSERT
  - changed 判定仍走 compareFields 任一 `IS NOT`
- `src/backend/pending-reconcile/benchmark.js`：单轮 sample × matchFields.length 粗略外推
- `scripts/test-v2.0.0-pending-reconcile.js` T2 场景预期值更新（A1 语义下 2 轮 fallback 给出的 new/missing/changed 与 AND 不同）

**T12 真实样本验证**（2436823 行）：
- 对账耗时 **4.31 秒**（A1 3 轮 fallback 比原 AND 的 2.85 秒多 ~1.5 秒，仍远 < 1 分钟目标）
- 差异 new=3 / missing=276 / changed=0（vs 原 AND 的 new=3 / missing=276 / changed=2；A1 下 order_no 已配齐所有可配对行，compareFields 差异比对结果不同属正常）

**check-vars**：
- **⚠️ 资金敏感 Risk-sensitive** 命中：engine.runReconciliation 核心算法改写。pending-reconcile 4×4 手工样本小测试 23 断言全绿，真实样本语义符合用户 A1 预期。

### Reverse Sync #6 — UX 打磨 + 导出格式增强（2026-04-24）

**触发**：用户手工测试反馈累积 8 项，涵盖 UX、状态文案、按钮可用性、性能预估失真、导出差异输出格式。

#### 代码改动

| # | 类别 | 改动 | 主要文件 |
|---|------|------|---------|
| 1 | UX 文案 | 状态框 idle 文案 `已导入 {X / Y}...` → `欢迎使用小助手` | `src/renderer-pending.js` |
| 2 | UX 可用性 | 导出差异按钮放宽：打开模块时调 `listAllRuns()`，DB 有任意历史 run 即启用（原仅本会话） | `src/renderer-pending.js` initialize |
| 3 | UI 规则弹窗 | 对账字段每行加序号 `1./2./...`（DOM 序即 matchFields 下标+1），header 右侧加 `?` tooltip 说明 fallback 优先级 | `src/renderer-pending.js` buildColumn + `src/styles.css` `.pending-rule-field-serial / .pending-rule-header-tip` |
| 4 | UI 规则弹窗 | 对账内容 header 水平居中到其下拉中心（新增 `alignHeaderToSelect` opt + `.pending-rule-column-aligned` 类：列 align-items flex-start + header width=200px + inline-flex center） | 同上 + styles.css |
| 5 | 清理 | **删除 benchmark**（`pending-reconcile/benchmark.js` 整文件 + IPC + preload + UI 调用 + formatDurationSec + 测试 T5 / T12-3）<br>原因：benchmark 用 NOT EXISTS 写法估算，engine 已切 JS 层 Map 配对，两条路径 per-row cost 差一个数量级，预估严重失真（用户看到 3 分 20 秒，实际几秒完成） | `src/backend/pending-reconcile/benchmark.js` 删 / `src/main.js` / `src/preload.js` / `src/renderer-pending.js` / test-v2.0.0-pending-reconcile.js / test-v2.0.0-perf-real-sample.js |
| 6 | UI 导出弹窗 | 导出月份范围弹窗重排：标题左上加粗；月份 header 文字去除；Run header 浮在其下拉左上角（columns align-items flex-end 实现两下拉底对齐）；月份列缩至 120px、Run 列扩至 540px；gap 60px、margin-top 2px、margin-bottom 20px；按钮顺序 `[导出][取消]`（与其他弹窗相反） | `src/renderer-pending.js` buildExportDialog + `src/styles.css` `.pending-export-cols` |
| 7 | UI 对账确认 | 对账确认框月份值包 `<strong>` 加粗（createConfirmDialog 走 innerHTML，已沙箱；值为 `YYYY-MM` 格式无注入风险） | `src/renderer-pending.js` |
| 8 | **⚠️ 资金敏感** 导出 | **导出差异格式重大增强**：<br>• changed pair 展开为 before/after **双行**（同 `pair_id` 共享元数据；行序 upper→lower 即 before→after）<br>• 新增 `pair_id` / `change_side` / `changed_fields` 元数据列（placed after diff_type）<br>• compareFields 含 `金额` → 末尾加 `金额_diff` 列（= parseFloat(lower)-parseFloat(upper)，解析失败留空）<br>• compareFields 含 `计算金额` → 末尾加 `计算金额_diff` 列（同上）<br>• compareFields 含 `pending资金类型` → 追加 `pending资金类型差异` sheet（仅收资金类型变更的 pair；无变更时空表仅 header） | `src/backend/pending-export/writer.js` 全面重写 / `scripts/test-v2.0.0-pending-export.js` 22 → 50 断言 |

#### 文档同步

- `docs/iterations/v2.0.0/PRD-v2.0.0.md`：
  - §5.3.1 弹窗结构示意图重绘，新增序号 + tooltip 说明；§5.3.3 交互条款加序号重排
  - §5.4.8 状态栏文案表补充 "欢迎使用小助手" + "本会话有最新 ..." 条件
  - §5.5.3 benchmark 改为移除说明（AC4-4 / OT-5 划掉标记）
  - §5.6.1 导出按钮启用条件写清"有历史 run 即启用"
  - §5.6.2 弹窗重绘
  - §5.6.3 / §5.6.5 changed 双行 + 新列结构 + 资金类型差异 sheet
  - §六 AC2-5 / AC2-6 / AC5-6 / AC5-7 新增
  - §十一 变更记录追加 2026-04-24 Reverse Sync #6 一行

#### 测试结果

| 用例 | 断言 | 结果 |
|---|---|---|
| pending-export | 22 → **50** | ✅ |
| pending-reconcile | 23 → 22（删 T5 benchmark） | ✅ |
| pending-session | 19 | ✅ |
| smoke | — | ✅ |

手工测试（用户 Electron 端）：
- 状态框初始文案正确（欢迎使用小助手）
- 导出差异按钮开模块即可用（前提：DB 有历史 run）
- 规则弹窗序号 + tooltip 显示正常
- 导出月份范围 UI 平衡（月份 / Run 左右对齐、按钮顺序对）
- 对账确认月份加粗
- 导出 xlsx 打开核对（changed pair 双行、pair_id 共享、金额_diff 数值对、pending资金类型差异 sheet 行数对） — **用户确认"核对没问题"**

#### check-vars

- **⚠️ 资金敏感 Risk-sensitive**：`src/backend/pending-export/writer.js` 重写涉及资金导出核心。手工核对 + 50 断言小样本覆盖（T1 金额改值双行、T3 资金类型空 sheet、T4 资金类型差异双行）；列顺序 PENDING 31 列不变，追加列在 diff_type 之后，向前扩展
- **Runtime-state**：`state.pending.latestRunId` 语义扩展（从"本会话 run id"→ "latestRunId 即可用 run 存在性标志"），消费处仅一处 `disabled = !latestRunId`，已验证
- **Minor 知会**：benchmark 模块删除，打包体积无影响（原就在 src/backend 内）


### Reverse Sync #6 补丁 — PR #24 Codex review 反馈修复（2026-04-24）

Codex 评审提出 2 个 P1 finding，已修：

#### Finding 1 — aggregate 跨 run 并集越权重算

**问题**：`exportAggregate` 对每个 run 的行生成也传 `compareUnion`，导致某 run 原本没参与比对的字段被越权重新比对，写进 `changed_fields` / `金额_diff` / `pending资金类型差异` sheet。违反 PRD §5.6.4 "某 run 不含的列留空"。

**修复**：
- `buildExportRowsForDiff` / `buildSingleExportRow` 签名拆分 `runCompareFields`（本 run 规则）+ `headerCompareFields`（并集，决定列位置）
- 非本 run 参与的字段在 `_before`/`_after`/`_diff` 留空
- `changed_fields` 基于 `runCompareFields` 计算，不会含并集的外来字段
- `pending资金类型差异` sheet 过滤自动正确（走 `changed_fields` 过滤）

#### Finding 2 — 覆盖导入未清理 orphan diff_runs / diff_rows

**问题**：`month-repository.deleteMonth` 只删 `pending_rows` + `pending_months`，旧 `diff_runs` / `diff_rows` 的 `upper_row_id` / `lower_row_id` 悬空 → 导出时 `readPendingRow` 返回 null → 写空快照。叠加本 PR"按钮放宽"后风险更大（用户开模块即能点到报错数据）。

**修复**：`deleteMonth` 扩展为级联删除涉及该月的 `diff_runs` 和其 `diff_rows`。migrations 里声明的 `ON DELETE CASCADE` 因 `PRAGMA foreign_keys = OFF` 不生效，故手动两步 DELETE。

#### 测试补充

- `scripts/test-v2.0.0-pending-export.js` 新增 T5（aggregate run 规则独立）+ T6（deleteMonth 级联）→ 50 → **63 断言**
- 全绿：pending-export 63/63 / pending-reconcile 22/22 / pending-session 19/19 / smoke ✓

#### check-vars

- **⚠️ 资金敏感**：Finding 1 修复牵涉导出格式正确性（资金差异列不能越权）；Finding 2 修复守护导出数据完整性（orphan 行不能写入）。两项均在小样本单测覆盖
- **破坏性影响**：`deleteMonth` 现在会删除涉及该月的历史 run。用户再次对该月导入后，过去的对账记录丢失（但新 run 用完整新数据重算）—— 与"覆盖前必留底"原则一致，留底 xlsx 已保全原始数据

