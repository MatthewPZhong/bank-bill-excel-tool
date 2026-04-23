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
