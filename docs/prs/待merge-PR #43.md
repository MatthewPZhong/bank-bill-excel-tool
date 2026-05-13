---
status: 待merge
title: "[v2.1.2] patch — C4 dialog 文案变更 + 新增模块「月度银行对账单BU回填校验」"
target: main
source: v2.1.2
draft_created: 2026-05-13
integrated: false
---

# [v2.1.2] patch — C4 dialog 文案变更 + 新增模块「月度银行对账单BU回填校验」

## Summary

本 PR 包含 2 块独立改动：

1. **T1 — C4 dialog 文案变更**（仅 UI 可见文案，不动内部变量名）：
   - 「账单类型」→「对账字段」
   - 「对账字段」→「对账内容」
   - dialog UI label / 按钮 / 错误消息 / 确认弹窗 共 19 处
   - 仅作用于 `isReconIdFixCategory` 分支（`recon-id-fix` + `gateway-recon-id-fix`）
   - **不动**：C1/C2/C3 dialog 同名文案、内部变量名 `billTypes` / `reconFields` / `reconGroups`、HTML data 属性

2. **T2 — 新增模块「月度银行对账单BU回填校验」**：
   - 主菜单新入口 + 模块面板（月份 select + 导入文件 + 开始运行 + 导出差异 3 按钮）
   - 资金红线对账：Pending.主对账单号 ↔ 银行对账单.ReconciliationId **严格 1:1**，任何 1:N / N:1 / N:M 异常 → 运行立即中断
   - SQLite 主 DB 新增 3 张表（pending_imports / bank_imports / runs）
   - 8 个 IPC handler（`bankBuRecon:*`）
   - 异常报告（.txt 文件 + 弹窗显示前 20 条 + 「打开错误报告」按钮）
   - 差异表 2-sheet xlsx：Pending（20 列）+ 银行对账单（44 列），BU 差异行整行黄底（`FFFFFF00`）

OPEN ISSUE 拍板（10/10）见 `docs/iterations/v2.1.2/PRD-v2.1.2.md` §六。

## ⚠️ 资金红线 — 必须人工 review（v0.8 重新拍板）

T2.6 对账算法 (`src/main-process/bank-bu-recon-session.js#runReconciliation`) 是本 PR 最核心的资金安全边界：

- **匹配规则**（v0.8 修订）：1:1 / 1:N / N:1 视为对账成功；N:M（双侧 ≥2）视为异常 → 跳过 BU 比较 + 写入差异表第 3 sheet「异常」（**不中断运行**）
- **BU 比较语义**：`normalize(v) = String(v).trim()`（空值归一为 `""`）；不大小写归一化
- **BU 标黄精准到子对**（v0.8 OPEN ISSUE Q1=A 拍板）：
  - 1:1：双侧不等都标黄
  - 1:N：Pending 不标；银行行逐一比，仅标不等的银行行
  - N:1：银行不标；Pending 行逐一比，仅标不等的 Pending 行
- **异常处理**（v0.8 修订）：N:M 异常组不中断、不弹窗、不生成 .txt；写入差异表 Sheet 3「异常」（对账单号 / 双侧匹配数量 / 双侧行号）

**Reviewer 必须**：
1. 阅读 `docs/iterations/v2.1.2/spec.md` §3.6 / §6.2 算法伪码
2. 用真实数据样本跑一次（**不能只看 npm run smoke 通过**）
3. 验证 1:N / N:1 BU 标黄精准到不等的那一侧（不要标多）
4. 验证 N:M 不中断 + 落到「异常」sheet（行号准确）
5. 验证 BU 比较 trim 边界（空值 / 全角空格 / 末尾换行）

## 测试

### 自动化（npm run smoke）

新增 4 用例（资金红线核心路径）— **本地全 PASS**：

| Case | 输入 | 期望 | 实际 |
|---|---|---|---|
| A 全相等无差异 | 5 行 1:1，BU 全等 | matched=5 / buDiff=0 / 无黄底 | ✓ PASS |
| B 部分 BU 差异 | 5 行 1:1，2 行 BU 不等 | matched=5 / buDiff=2 / Pending 2 行黄底 + 银行 2 行黄底 | ✓ PASS |
| C 1:N 异常 | Pending 1 行 ↔ 银行 3 行 | status=failed_anomaly / 1 个 anomaly / .txt 报告生成 | ✓ PASS |
| D N:1 异常 | Pending 2 行 ↔ 银行 1 行 | status=failed_anomaly / 1 个 anomaly / .txt 报告生成 | ✓ PASS |

### 手动测试 checklist（用户本机 GUI）

- [ ] 启动 app，主菜单看到「月度银行对账单BU回填校验」入口
- [ ] 切到该模块，月份 select 显示最近 13 个月 + 已导入月份的行数提示
- [ ] 点「导入文件」→ 顺序弹两次文件选择对话框（标题分别提示 Pending / 银行对账单）
- [ ] 用 `assets/Pending数据管理.xlsx` + `assets/银行对账单.xlsx` 模板（空数据）测试导入流程通畅
- [ ] 用真实业务数据测试：导入 → 运行 → 导出 → 打开导出文件验证 2 sheet + 黄底
- [ ] 故意构造一笔 1:N 数据：运行后弹窗显示异常对账单号 + 行号 + 「打开错误报告」可打开 file explorer
- [ ] C4 dialog 打开新增/编辑场景：看到「对账字段」+「对账内容」新文案
- [ ] C1/C2/C3 dialog 打开：看到原文案保持不变（防 T1 误伤）

### preview 重跑（GUI 环境）

```bash
# T1 — C4 4 张
npm run preview:scenario-config-c4
npm run preview:scenario-config-c4-both
npm run preview:scenario-config-c4-gateway
npm run preview:scenario-config-c4-gateway-1vN

# T2 — 4 张新模块截图
npm run preview:bank-bu-recon-panel-initial
npm run preview:bank-bu-recon-panel-importing
npm run preview:bank-bu-recon-panel-result
npm run preview:bank-bu-recon-panel-anomaly
```

## ⚠️ 关联功能 review（npm run check:vars 输出 — 2026-05-13 最终刷新）

`npm run scan:vars` 统计：v2.1.2 @ src/ — **67 files / 669 top-level names**（含 BU 回填新增 4 个）；A-share 115 / A-pair 184 / A-local 275 / B 299

`npm run check:vars` 改动文件 6 个：
- `src/backend/database.js`
- `src/backend/database/migrations.js`
- `src/main.js`
- `src/preload.js`
- `src/renderer-dialogs.js`
- `src/renderer.js`

| 层级 | 命中 |
|---|---|
| Critical | `FileValidationError` |
| Important-skeleton | `ipcRenderer` |
| Runtime-state | `MODULES` / `dialog` / `elements` / `state` |

### 自查结论

- ✅ `FileValidationError`（Critical）：T2.3 reader.js 沿用现有错误类，code 用新前缀 `BANK_BU_RECON_*`，detailLines / context 完整结构化；与现有用法兼容，未修改 common.js 的类定义
- ✅ `ipcRenderer`（Important-skeleton）：T2.12 preload.js 在 `window.desktopApi` 命名空间下新增 `bankBuRecon.*` 7 个方法（与现有 pending.* / accountMappings.* 等同级），不破坏现有 API surface
- ✅ `MODULES`（Runtime-state）：renderer.js 第 39 行 freeze 对象新增 `bankBuRecon: { id: 'bank-bu-recon', name: '...' }` 一项，未改动其他模块
- ✅ `dialog`（Runtime-state）：main.js 沿用 Electron `dialog.showOpenDialog` 模式，参数与现有 pending:import:pick-files 一致
- ✅ `elements`（Runtime-state）：renderer.js 第 254-260 新增 6 项 DOM 缓存（`bankBuRecon*`），不破坏现有缓存
- ✅ `state`（Runtime-state）：renderer.js 全局 state 不动；T2 用独立的 `bankBuReconState` 模块级变量管理状态（避免污染 state 全局）

### T2 新增的潜在升格候选（待下一轮人工评估）

- `runReconciliation()` (bank-bu-recon-session.js) — Risk-sensitive 候选（资金红线对账算法 — v0.8 算法重写包含 4 路分类 + N:M 异常 sheet）
- `bank_bu_recon_runs.status` 字段 — Risk-sensitive 候选（v0.8 简化：永远 'success'，仅保留 schema 兼容）
- `bank_bu_recon_runs.anomaly_count` 字段 — Risk-sensitive 候选（v0.8 重新定义：N:M 异常组数）
- `PENDING_MATCH_KEY_DB_COLUMN='recon_id'` / `BANK_MATCH_KEY_DB_COLUMN='reconciliation_id'` 常量 — Risk-sensitive 候选（匹配 key 锚点）
- `PENDING_DIFF_FIELD_DB_COLUMN='finance_bu'` / `BANK_DIFF_FIELD_DB_COLUMN='remark_bu'` 常量 — Risk-sensitive 候选（差异字段锚点）
- `normalizeKey(v)` (bank-bu-recon-session.js) — Important-skeleton 候选（v0.9：对账单号匹配，仅 trim）
- `normalizeBu(v)` (bank-bu-recon-session.js) — **Risk-sensitive 候选**（v0.9：BU 比较 trim + toLowerCase；OPEN ISSUE #5 拍板影响所有 BU 标黄判定）
- `nmAnomalies` 字段 (session.js + writer.js) — Important-skeleton 候选（v0.8：N:M 异常组结构 + Sheet 3 写入逻辑）

### .gitignore 修改（v2.1.2 必须）

`.gitignore` v2.0.0-beta.3 时加的 `银行对账单.xlsx` 排除规则**模式过宽**，会误伤 `assets/银行对账单.xlsx`。本 PR 加 2 条例外让模板文件入库 + 1 条 Excel 临时锁文件全局忽略：

```
# v2.1.2 T2：assets/ 下的银行对账单 + Pending 数据管理是模块**模板文件**，必须入库
!assets/银行对账单.xlsx
!assets/Pending数据管理.xlsx
# Excel 临时锁文件（打开 xlsx 时 Office 自动产生 .~filename.xlsx，永远不入 git）
.~*.xlsx
```

## Reverse Sync 修正

### 修正 1：T1 文案行号误标（PRD 草稿期）

PRD §三 草稿表格误标 `line 7420 / 7421 / 7425` 为 C4 dialog 范围，spec 阶段 grep 确认实际是 C2 (`offset-bill-mark`) / C3 (`gateway-recon-join`) 分支文案。**未改这 3 行**，PRD 已同步标 ⚠️ Reverse Sync 修正。

实际 C4 文案修改点共 19 处（PRD 原写 22 处，扣除 3 处误标）。

### 修正 2：月份选择 UX 偏离 PRD §3.2.5 → 已纠正

实施初期我（claude）在 spec §九 "未决议题"第 2 条**自行拍板**「建议简单 `<select>` 下拉」，把月份选择做成了**面板上的下拉框** + 3 个按钮。此举偏离 PRD §3.2.5 数据流原意（「[弹月份选择对话框] → 选 YYYY-MM」），属于越权设计决策（违反 No Spec, No Code + Spec is Truth）。

用户 review 发现后拍板**改回 PRD 原意**：
- 面板**去掉月份 select**，仅保留 3 个按钮
- 点「导入文件」→ 弹 `createBankBuReconMonthPickerDialog` 月份对话框 → 选月份 + 「下一步」 → 顺序弹 2 次文件选择对话框
- 「导入文件」按钮**默认 enabled**（与 PRD §3.2.5 数据流第一步对齐）

⚠️ 教训：spec 阶段的「未决议题」必须由用户拍板，不应自行选择默认值实施。

### 修正 3：实际使用发现 macOS `dialog.showOpenDialog.title` 不显示 → 加 showMessageBox 提示

用户实际导入测试时把两个文件**选反了顺序**（先选了「渠道账单」当 Pending、后选 Pending 当银行对账单），状态栏报「Pending 数据管理 表头列数不匹配：模板 20 列，文件 44 列」。

**根因**：Electron `dialog.showOpenDialog` 的 `title` 字段在 macOS 系统级 NSOpenPanel 不显示，PRD §六 #4 拍板的「每次提示用途」在 macOS 上没生效。

**修复**（spec v0.3）：`bankBuRecon:import:pick-files` handler 在每次 file picker 之前**先弹 `dialog.showMessageBox`** 显式提示「步骤 N/2：请选择 XXX 文件」，用户点「继续选择」再弹 file picker。多 2 次点击但 OS 间一致。

### 修正 4：月份对话框拆"年+月"两下拉（用户 follow-up 诉求）

用户在 UX 复核时提出月份对话框应改为两个独立下拉框（年份 + 月份），便于跨年场景。拍板细节：

- 年份下拉：**当前年 ± 1**（动态计算，2026 年显示 2025/2026/2027）
- 月份下拉：**01 - 12** 固定 12 项
- **不显示元信息**（已导入计数 / 已运行次数）
- **不显示「建议 T-1 月」推荐文字**（dialog body 仅留两个下拉）
- **默认预选**：当前年 + 上个月（静默默认，跨年初自动回退到上年 12 月）
- 「下一步」按钮：点击后拼成 `${year}-${zfill2(month)}` 传给 IPC

涉及文件：`index.html` / `src/renderer.js` / `src/renderer-dialogs.js` / `src/main.js` / `docs/iterations/v2.1.2/spec.md` v0.2 → v0.3

### 修正 5：3 个对话框全前端化（Clear 风 + 对齐 Pending 模块）

用户复核发现：之前的实现把月份选择 + 2 个文件提示都用 Electron 系统对话框（`showMessageBox` / 简陋的 inline-style modal），与项目其他模块的前端 modal 风格不一致。拍板：

1. **月份选择对话框** — 改用月度 Pending 数据核对模块的 `buildImportMonthDialog` 同款结构 + 样式（`.pending-import-month-dialog` / `.monthly-balance-time-picker` / `.mapping-text-input` 等 class），保留 v0.3 拍板的年份/默认值规则
2. **文件提示对话框** — 改用 Clear 风前端 modal `.modal-card.alert-card`（与 `createAlertDialog` / `createConfirmDialog` 同体系）；**删除** `dialog.showMessageBox`
3. **IPC 拆分** — 旧 `bankBuRecon:import:pick-files`（一次返回两路径）→ 拆为 `bankBuRecon:import:pick-pending-file` + `bankBuRecon:import:pick-bank-file` 两个独立单选 IPC；preload 同步加 `pickPendingFile` / `pickBankFile`，删除 `pickFiles`
4. **renderer 串联** — `pickFilesAndImport` 重写为「prompt 1 → pick pending → prompt 2 → pick bank → import:run」嵌套 onConfirm 流程

文案修订（用户拍板）：
- 「请选择 Pending 数据管理文件」→ 「**请导入** Pending 数据管理文件」
- 「请选择银行对账单文件」→ 「**请导入**银行对账单文件」
- 详情统一为：「接下来弹出的文件选择对话框中，请选择**对应的 xlsx 文件**（对账月份 XXXX-XX）。」（去掉具体的「20 列」/「44 列」规格说明）

涉及文件：`src/renderer-dialogs.js`（+ `createBankBuReconFileImportPromptDialog` 新 factory + 重写 month picker） / `src/renderer.js`（新串联流程） / `src/main.js`（拆 IPC，删 showMessageBox） / `src/preload.js`（拆 API） / `docs/iterations/v2.1.2/spec.md` v0.3 → v0.4

### 修正 6：开始运行 / 导出差异改为弹窗形态对齐 Pending 模块（spec v0.5）

用户复核发现：之前的实现「开始运行」+「导出差异」都是直接基于上次导入/运行的 session 状态触发，没有弹窗交互；与"月度 Pending 数据核对"模块的弹窗式 UX 不一致。拍板：

**「开始运行」**（参照 Pending `buildReconcileDialog`）：
- 点按钮 → 弹「选取需要对账的月份」对话框（`createBankBuReconReconcileDialog`）
- 复用 class `.pending-reconcile-dialog` / `.pending-rule-columns` / `.pending-rule-column-header` / `.mapping-text-input.pending-reconcile-month-select`
- **单列单选**（OPEN ISSUE Q1=A：BU 回填是单月对账，不需要双列）
- 月份下拉只列**两侧都已导入**的月份（OPEN ISSUE Q2=A，新 IPC `bankBuRecon:run:list-ready-months`）
- 选月份 + 「完成」 → 直接跑（OPEN ISSUE Q6=A，无二次确认）

**「导出差异」**（参照 Pending `buildExportDialog`）：
- 点按钮 → 弹「导出差异」对话框（`createBankBuReconExportDialog`）
- 复用 class `.pending-export-dialog` / `.pending-rule-row` / `.pending-rule-columns`
- 两个 radio：
  - **导出指定月份** + 月份下拉（仅显示有 status=success run 的月份；OPEN ISSUE Q5=A：自动用最新 success run，不显示 Run 下拉）
  - **导出所有月份汇总（每月取最新 success run）**
- 选完点「导出」→ 弹另存为对话框（OPEN ISSUE Q4=A，新 IPC `bankBuRecon:export:pick-save-path`）→ 用户指定路径
- 后端拆 IPC：`bankBuRecon:export` → `:export:single` + `:export:aggregate`
- **汇总输出**（OPEN ISSUE Q3=A）：单 xlsx + 2 sheet（Pending / 银行对账单），每行表头额外插「对账月份」列；按月升序、月内按原行号；BU 差异行仍整行黄底
- **汇总跳过 failed_anomaly 月份**（OPEN ISSUE Q7=A）：导出完成后弹 alert 列出跳过月份

**按钮 enable 条件重设**：
- 「导入文件」永远 enabled
- 「开始运行」：`readyMonths.length > 0`
- 「导出差异」：`successMonths.length > 0`
- 切模块时拉两个 list IPC 同步按钮可用性

**新增 IPC（5 个）**：
- `bankBuRecon:export:pick-save-path`（弹 saveDialog）
- `bankBuRecon:export:single`（替代旧 export，含 savePath 参数）
- `bankBuRecon:export:aggregate`（跨月汇总）
- `bankBuRecon:run:list-ready-months`
- `bankBuRecon:run:list-success-months`

**新增 / 改动函数**：
- `bank-bu-recon-session.js`：新增 `listReadyMonths` / `listSuccessMonths` / `aggregateLatestSuccessRuns` / `loadRunResultByRunId`
- `bank-bu-recon-writer.js`：新增 `writeAggregateDiffWorkbook`（汇总 + 加月份列）；`writeDiffWorkbook` 加 `overrideSavePath` 参数

**端到端验证**（node 脚本）：
- 准备 3 个月数据（01 全等 / 02 部分差异 / 03 1:N 异常）
- listReadyMonths 返回 3 月（01/02/03 倒序）✓
- listSuccessMonths 返回 2 月（01/02，03 跳过）✓
- aggregateLatestSuccessRuns 返回 [01, 02] + skippedMonths=[03] ✓
- 汇总 xlsx 生成：Pending sheet 5 行（含表头）/ 第 1 列「对账月份」/ 月份正确 / 黄底 21 cell（02 月 1 行 buDiff × 21 列含月份列）✓

涉及文件：`src/main.js` / `src/preload.js` / `src/renderer.js` / `src/renderer-dialogs.js` / `src/main-process/bank-bu-recon-session.js` / `src/main-process/bank-bu-recon-writer.js` / `docs/iterations/v2.1.2/spec.md` v0.4 → v0.5 / USER_GUIDE §1.6.3 重写 / CHANGELOG + VFH 同步

### 修正 7：UX 微调（spec v0.6）

用户实际使用反馈两处微调：

**7.1 状态框初始文案对齐其他模块**：
- 切到本模块时显示「欢迎使用小助手」（与 statementModulePanel / bankStatementModulePanel 一致），不再显示带操作引导的「点击「导入文件」开始（先选月份，再选两份源文件）」
- 涉及：`index.html`（初始 `<span class="status-box-text">`）/ `src/renderer.js`（`restoreBankBuReconPanelState` + `setBankBuReconStatus.idleTitle`）/ `src/renderer-dialogs.js`（`applyBankBuReconPanelInitialPreviewState`）

### 修正 10：「未匹配」文案口语化为「未匹上 X」

用户反馈"未匹配"不够口语化。拍板（OPEN ISSUE 续：状态栏文案）：
- "Pending 未匹配 N 行" → "Pending 未匹上银行 N 行"
- "银行未匹配 M 行" → "银行未匹上 Pending M 行"

**仅改 v2.1.2 / BU 回填模块**（其他模块如 recon-id-fix / pending-reconcile / readers 的"未匹配"不动，因属于不同业务术语）。

涉及：
- `src/renderer.js` 状态栏文案
- `src/renderer-dialogs.js` preview 状态文案
- `src/main-process/bank-bu-recon-session.js` 注释
- `docs/USER_GUIDE.md` §1.6.2 / §1.6.3.3
- `docs/iterations/v2.1.2/PRD-v2.1.2.md` §一 / §3.2.3 / §6.2 / §6.2.3
- `docs/iterations/v2.1.2/spec.md` §3.6 / §3.9.2

### 修正 9：BU 比较加大小写归一化（v0.9）

用户实际数据测试发现 Pending 写「Flowmore」、银行对账单写「FlowMore」（大小写不同）被算法标为 BU 差异。**问题根因**：v0.4 OPEN ISSUE #5 拍板的 A 选项（trim + 严格相等，不大小写归一）在实际财务数据下导致大量误报。

**重新拍板**（OPEN ISSUE #5 改为 C）：
- BU 字段比较加 `toLowerCase` → `normalizeBu(v) = String(v).trim().toLowerCase()`
- 对账单号匹配**保持不变**（仍仅 trim，不大小写归一）

**实现**：
- `src/main-process/bank-bu-recon-session.js`：拆 `normalize` → `normalizeKey`（对账单号用，仅 trim）+ `normalizeBu`（BU 比较用，trim + toLowerCase）
- 算法中 4 处 BU 比较改用 `normalizeBu`；对账单号索引改用 `normalizeKey`
- `normalize` 别名保留指向 `normalizeKey`（兼容旧 import）

**回归 + 新增 case 验证**：
| Case | 输入 | 期望 | 实际 |
|---|---|---|---|
| F | BU 仅大小写不同（Flowmore vs FlowMore + FLOWMORE vs flowmore）| matched=4 / buDiff=0 | ✓ |
| G | BU 真差异（Flowmore vs OtherBU）| buDiff=2 | ✓ |
| H | 对账单号大小写不同（rec1 vs REC1）| matched=0 / 双侧 unmatched | ✓（对账单号未归一化，符合预期）|

涉及文件：`src/main-process/bank-bu-recon-session.js` / `docs/iterations/v2.1.2/spec.md` v0.8 → v0.9 / `docs/iterations/v2.1.2/PRD-v2.1.2.md` v0.5 → v0.6 / USER_GUIDE §1.6.5 / CHANGELOG / VFH

### 修正 8：资金红线规则重新拍板（v0.8）— 1:N/N:1 改为正常 + N:M 异常 sheet

用户复核 OPEN ISSUE #10 决策（v0.4 严格 1:1 中断）后**重新拍板**（v0.5 → v0.8）：

- **1:N（1 Pending ↔ N 银行）/ N:1（N Pending ↔ 1 银行）改为正常匹配** — 走 BU 比较
- **仅 N:M（双侧都 ≥2）视为数据异常** — 跳过该组 BU 比较 + 写入差异表第 3 sheet「异常」（**不中断运行**）

**派生设计决策**（追加 OPEN ISSUE Q1/Q2 拍板）：
- Q1 BU 标黄规则 = **A 精准标差异子对**：1:N 场景 P 不标，仅标 BU 不等的银行行；N:1 场景 B 不标，仅标 BU 不等的 Pending 行
- Q2 N:M 处理 = **C 跳过 + 异常 sheet**：差异表多第 3 个 sheet「异常」列 N:M 对账单号；不中断、不弹窗、不生成 .txt

**算法重写**（`src/main-process/bank-bu-recon-session.js#runReconciliation`）：
- 旧逻辑：扫描所有 1:N/N:1/N:M 异常 → 任一异常即返回 `failed_anomaly` status
- 新逻辑：按 key 分类处理 4 路（1:1 / 1:N / N:1 / N:M），永远返回 `success` status；N:M 进入 `nmAnomalies` 列表

**writer 加 Sheet 3**（`src/main-process/bank-bu-recon-writer.js`）：
- `writeDiffWorkbook` 加 `nmAnomalies` 参数 + 第 3 sheet「异常」（对账单号/Pending匹配数/银行匹配数/Pending行号/银行行号）；空 nmAnomalies 仍生成只含表头的 sheet
- `writeAggregateDiffWorkbook` 同样加 Sheet 3，每行表头额外插「对账月份」列

**废弃**：
- `createBankBuReconAnomalyDialog` factory（renderer-dialogs.js 已删）
- `applyBankBuReconPanelAnomalyPreviewState` preview state（已删）
- `package.json` `preview:bank-bu-recon-panel-anomaly` script（已删）+ `preview:all` 同步
- `writeAnomalyReport` 函数 + `error-reports/...txt` 文件不再产出
- `bank_bu_recon_runs.status='failed_anomaly'` 路径不再触发（schema 字段保留兼容）
- `bank_bu_recon_runs.anomaly_count` 字段重新定义：v0.4 = 异常对账单号数；**v0.8 = N:M 异常组数**

**端到端 5 用例验证**（node 脚本）：
| Case | 输入 | 期望 | 实际 |
|---|---|---|---|
| A 1:1 全等 | 2 行 1:1, BU 全等 | matched=4 / buDiff=0 / nm=0 | ✓ |
| B 1:1 部分差异 | 2 行 1:1, 1 BU 不等 | matched=4 / buDiff=2 / nm=0 | ✓ |
| C 1:N 部分差异 | 1 P vs 3 B, B[1] BU 不等 | matched=4 / buDiff=1 / nm=0 / **P 不标，仅 B[1] 标** | ✓ |
| D N:1 部分差异 | 3 P vs 1 B, P[1] BU 不等 | matched=4 / buDiff=1 / nm=0 / **B 不标，仅 P[1] 标** | ✓ |
| E N:M | 2 P vs 2 B | matched=0 / nm=1 / **不中断** + 异常 sheet 表头+1 行内容 | ✓ |

涉及文件：`src/main-process/bank-bu-recon-session.js` / `src/main-process/bank-bu-recon-writer.js` / `src/main.js` / `src/renderer.js` / `src/renderer-dialogs.js` / `package.json` / `docs/iterations/v2.1.2/spec.md` v0.7b → v0.8 / `docs/iterations/v2.1.2/PRD-v2.1.2.md` v0.4 → v0.5 / USER_GUIDE §1.6.3 + §1.6.4 重写 / CHANGELOG + VFH 同步

### 修正 7.2（v0.6 + v0.7 Fix7b 续，已记录在前）

**7.2 导出差异 dialog 月份下拉框样式调整**（v0.6 + v0.7 Fix7b 续）：
- 下拉框与上方「导出指定月份」radio 间距太近 → 加 `marginTop:14px`
- 下拉框**左边缘**对齐「导出指定月份」label「导」字 → select wrapper `paddingLeft = 16px(radio宽) + 8px(gap)`
- 下拉框**宽度** = `labelWidth + 32px`（v0.7b 用户视觉偏好，右边缘超出「份」字 32px）→ 纯 CSS 不可行（`.pending-reconcile-month-select` 自带 `min-width:200px` + select native intrinsic width 会撑大父 inline-block，循环依赖）→ **改用 JS 测量**：dialog attach 后 `setTimeout 0` 测 `radioSingleLabel.getBoundingClientRect().width`，强制 `monthSelect.style.width = (labelWidth + 32) + 'px'`；`document.fonts.ready` 兜底字体异步加载
- 涉及：`src/renderer-dialogs.js#createBankBuReconExportDialog`

## 关联文档

- `docs/iterations/v2.1.2/PRD-v2.1.2.md` v0.4
- `docs/iterations/v2.1.2/spec.md` v0.1
- `docs/iterations/v2.1.2/tasks.md` v0.1
- `CHANGELOG.md` v2.1.2 章节
- `docs/VERSION_FEATURE_HISTORY.md` v2.1.2 章节
- `docs/USER_GUIDE.md` §1.6 章节

## 文件清单

### 新增模板（2 个 — commit 前 `git add`）

- `assets/Pending数据管理.xlsx` (20 列模板，T2 用)
- `assets/银行对账单.xlsx` (44 列模板，T2 用)
- ⚠️ 注意：根目录 `~资金对账导出不平.xlsx` 和 `assets/.~*.xlsx` 是 Excel 临时锁文件，**不要 git add**；建议加 `.gitignore` 规则 `*.~*.xlsx`

### 新增（10 个）

- `src/backend/bank-bu-recon-db/columns.js`
- `src/backend/bank-bu-recon-db/month-repository.js`
- `src/backend/bank-bu-recon-db/run-repository.js`
- `src/backend/bank-bu-recon-import/reader.js`
- `src/backend/bank-bu-recon-import/validator.js`
- `src/main-process/bank-bu-recon-session.js`
- `src/main-process/bank-bu-recon-writer.js`
- `docs/iterations/v2.1.2/PRD-v2.1.2.md`
- `docs/iterations/v2.1.2/spec.md`
- `docs/iterations/v2.1.2/tasks.md`

### 改动（10 个）

- `src/backend/database/migrations.js` (+158 行：T2.1 ensureBankBuReconTablesSupport)
- `src/backend/database.js` (+9 行：require + setup 调用 + wrapper 方法)
- `src/main.js` (+~140 行：4 个 require + session 实例化 + 8 个 IPC handler)
- `src/preload.js` (+10 行：bankBuRecon API 暴露)
- `src/renderer.js` (+~210 行：MODULES + DOM cache + setCurrentModule + 状态机 + preview state apply)
- `src/renderer-dialogs.js` (~30 处文案变更 + ~120 行 anomaly dialog + 4 个 preview state apply)
- `index.html` (+30 行：主菜单按钮 + 模块面板 section)
- `package.json` (version bump 2.1.1 → 2.1.2 + 4 个 preview scripts + preview:all 追加)
- `CHANGELOG.md` (v2.1.2 段落)
- `docs/VERSION_FEATURE_HISTORY.md` (v2.1.2 段落)
- `docs/USER_GUIDE.md` (§1.6 章节 + 模块清单追加)

---

🤖 不加 AI 署名（按 CLAUDE.md 项目惯例）
