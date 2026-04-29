# Spec — v2.0.0-beta.3 PR #32a：first-match-wins 调度 + IO 层（exceljs 标黄）

> status: apply（PR #32 切分后第一段：后端）
> owner: team-lead
> created: 2026-04-29
> 上游 PRD：`docs/iterations/v2.0.0-beta.3/PRD-v2.0.0-beta.3.md` §7.4 / §7.5 / §8.2 / §9
> 关联：PR #32b（前端 dialog + 接入 + 文档 + bump，等本 PR merge 后启动）

## 1. 背景

- v2.0.0-beta.3 主体迭代第 4 个 PR 切分后第一段（按用户决策 Q2=B）
- 上游决策（用户 2026-04-29）：
  - **Q1=C**：xlsx 标黄改用 `exceljs`（全功能，避免 SheetJS Free 版 cell.s 不支持的兼容性风险）
  - **Q2=B**：PR #32 切两 PR
    - **PR #32a（本 PR）**：调度引擎 + IO 层 + 4 IPC handler + smoke
    - **PR #32b（下一个）**：4 dialog factory + 接入 PR #30 占位 + statusBox + preview + E2E + 文档 + bump
  - **Q3=A**：dialog 全做完后一次 Codex review（与 Q2 切分配套）
- 切分理由：单 PR 5-7 天 / ~2500 行风险高；后端可独立 ship 给前端稳定接口

## 2. 代码现状（必须有出处）

- **算法层（PR #31，已 merge `b977815a`）**：`src/main-process/scenario-engines/index.js#runScenario(scenario, bankRows, gwRows?)` → `{ lockedRowIds, modifications, warnings }`
  - C2 配对成功时双方都进 `lockedRowIds`（即使 leftRow 未改字段）
  - 算法纯函数无副作用，输入 `_rowId` 已由 `engine-utils.js#ensureRowId` 写回
- **数据层（PR #29）**：`src/backend/database/scenarios-repository.js` + `desktopApi.scenarios.{list, get, create, update, delete, toggleEnabled}`
- **现有 IO 基础设施**（不复用，独立新写）：
  - `src/backend/file-service/readers.js#readRowsWithMetadata`（statementGenerator 模块用，依赖 SheetJS）
  - `src/backend/file-service/writers.js`（依赖 SheetJS，无 cell.s 标黄能力）
  - 新模块独立用 exceljs 实现，不影响现有 3 模块
- **现有依赖**：`xlsx` (SheetJS) 已装，`exceljs` 未装
- **bankStatementModulePanel 4 按钮 binding（PR #30）**：当前 3 个（"导入文件" / "开始运行" / "导出文件"）是占位 alert，本 PR **不动**（PR #32b 接入）

## 3. 目标

### 必做（本 PR）

1. **依赖**：`npm install exceljs` 装新依赖，作为标黄输出库；其他模块继续用 SheetJS 不动
2. **first-match-wins 调度引擎**（main 进程）— PRD §7.4
3. **银行对账单 IO**：导入（44 列校验）+ 标黄输出（exceljs，仅修改行）
4. **资金对账文件 IO**：导入「网关账单」sheet（31 列校验）
5. **error-report xlsx 输出**：4 列（时间戳 / 场景名 / 行号 / 原因）
6. **4 个新 IPC handler**：bank-statement:import / gateway-recon:import / bank-statement:run / bank-statement:export
7. **session state**（main 进程）：bankStatementSession / gatewayReconSession / processingResult
8. **preload 暴露**：`desktopApi.bankStatement.{import, importGatewayRecon, run, export}`
9. **smoke 测试**：dispatcher 5 用例 + IO 读写 round-trip 用例

### 不做（移到 PR #32b）

- 4 个 dialog factory（C1/C2/C3 配置 + 确认详情）
- 接入 PR #30 占位（修改场景 / 类别选择"继续" / 查看场景）
- bankStatementModulePanel 4 按钮 binding 改写
- statusBox 文案动态更新
- state.bankStatementSession / scenarioDraft（renderer 侧）
- preview state（4 张新 png）
- E2E 用户样例文件 dry-run
- 文档三件套（CHANGELOG / VERSION_FEATURE_HISTORY / USER_GUIDE）
- 版本号 bump

## 4. 功能点

### F1 — exceljs 依赖与 writer 抽象

- `npm install exceljs`（最新稳定版）
- 新文件 `src/main-process/exceljs-writer.js`：
  - `writeBankStatementOutput(modifiedRows, headers, modificationMap, savePath)` — 标黄主输出
  - `writeErrorReport(warnings, savePath)` — error-report 4 列
  - 单元格背景色：`cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFFF00' } }`
  - 不影响 SheetJS 现有 writer（statementGenerator 等继续用 SheetJS）

### F2 — first-match-wins 调度引擎

新文件 `src/main-process/scenario-dispatcher.js`：

```js
// runAllScenarios(bankRows, gwRows | null, scenarios) → {
//   modifiedRows: Array,                    // 仅命中场景的行（lockedRowIds 内）
//                                            // 每行加 _hitScenarioId / _hitScenarioName / _modifiedColumns
//   modifications: Array<{ rowId, column, oldValue, newValue, scenarioId, scenarioName }>,
//   errorReport: Array<{ scenarioId, scenarioName, rowId, code, message }>,
//   stats: { totalRows, hitRowCount, scenarioHitCount, warningCount }
// }
```

按 PRD §7.4：
1. enabledScenarios 排序：`priority desc, id asc`
2. gwRows === null → 过滤掉 `category === 'gateway-recon-join'` 的场景
3. 全局 `rowLockSet = new Set()`
4. 每个 scenario 跑前过滤未锁行 `unlocked = bankRows.filter(r => !rowLockSet.has(r._rowId))`
5. 调用 `runScenario(scenario, unlocked, gwRows)` 拿 `{ lockedRowIds, modifications, warnings }`
6. merge：`rowLockSet ∪= lockedRowIds`；给每个 modification 注入 `scenarioId / scenarioName`；warnings 同样注入
7. 收集 `_modifiedColumns` per row（多场景命中同行不可能 — first-match-wins 锁定保证）
8. 返回 modifiedRows = bankRows.filter(r => rowLockSet.has(r._rowId))

### F3 — 银行对账单 IO

新文件 `src/main-process/bank-statement-io.js`：

#### F3.1 readBankStatement(filePath)

- 用 SheetJS（不用 exceljs，复用现有 `file-service/readers.js` 的 sheet 读取能力）
- 校验：表头必须等于 `BANK_STATEMENT_FIELDS`（44 列，PR #31 常量）
  - 缺列 / 多列 / 顺序错位 → 抛 `FileValidationError`
- 给每行加 `_rowId = row_${index}`（与 PR #31 ensureRowId 兼容）
- 返回 `{ rows, headers, fileName, rowCount }`

#### F3.2 readGatewayRecon(filePath)

- 用 SheetJS 加载 workbook，定位「网关账单」sheet
  - 缺 sheet → 抛 `FileValidationError`
- 校验 31 列 = `GATEWAY_RECON_FIELDS`
- 返回 `{ gwRows, fileName, rowCount }`

#### F3.3 writeBankStatementMainOutput(processingResult, originalHeaders, scenarios, exportDir)

- 用 exceljs（F1）
- 文件名：
  - 命中场景集 `hitScenarios = unique(modifiedRows.map(r => r._hitScenarioName))`
  - 单一场景：`YYYYMMDDhhmmss-${场景名}.xlsx`
  - 多场景：`YYYYMMDDhhmmss-多场景.xlsx`
- 路径：`{exportDir}/{date}/{fileName}`（exportDir = `~/Documents/网银账单生成小助手/bank-statement-process`）
- 内容：
  - 表头 = originalHeaders（44 列）
  - 数据 = modifiedRows
  - 标黄：每行 `_modifiedColumns` 中的单元格 `cell.fill` 黄底
- 返回 `{ filePath, fileName }`

#### F3.4 writeErrorReport(warnings, exportDir)

- 4 列：时间戳 / 场景名 / 行号（_rowId）/ 原因（message）
- 路径：`{exportDir}/{date}/{timestamp}-error-report.xlsx`
- 仅当 `warnings.length > 0` 才写
- 返回 `{ filePath } | null`

### F4 — IPC handlers（main.js）

新增 4 handler，沿用现有 `ipcMain.handle` 模式：

#### F4.1 `bank-statement:import`

- `dialog.showOpenDialog`（filters: 仅 .xlsx）
- 用户取消 → `{ status: 'cancelled' }`
- 调 F3.1 readBankStatement
- 写 `state.bankStatementSession = { filePath, rows, headers, importedAt: Date.now() }`
- 返回 `{ status: 'ok', fileName, rowCount }`
- 校验失败：catch FileValidationError → `{ status: 'error', message, detail }`

#### F4.2 `gateway-recon:import`

- 同上，但调 F3.2 readGatewayRecon
- 写 `state.gatewayReconSession`

#### F4.3 `bank-statement:run`

- 检查 `state.bankStatementSession`（未导入 → `{ status: 'error', message: '请先导入银行对账单' }`）
- 取所有 `enabled === 1` 的 scenarios
- 调 F2 runAllScenarios（gwRows = state.gatewayReconSession?.gwRows ?? null）
- 写 `state.processingResult = { modifiedRows, modifications, errorReport, stats }`
- 返回 `{ status: 'ok', stats }`

#### F4.4 `bank-statement:export`

- 检查 `state.processingResult`（未运行 → error）
- 若 modifiedRows.length === 0 → `{ status: 'empty' }`（renderer 显示"无修改记录"）
- 调 F3.3 writeBankStatementMainOutput → 拿 mainFilePath
- 若 errorReport.length > 0：调 F3.4 writeErrorReport → 拿 errorReportPath
- 返回 `{ status: 'ok', mainFilePath, errorReportPath }`

### F5 — preload 暴露

`src/preload.js` 加：

```js
desktopApi.bankStatement = {
  import: () => ipcRenderer.invoke('bank-statement:import'),
  importGatewayRecon: () => ipcRenderer.invoke('gateway-recon:import'),
  run: () => ipcRenderer.invoke('bank-statement:run'),
  export: () => ipcRenderer.invoke('bank-statement:export')
}
```

### F6 — smoke 测试

#### F6.1 `scripts/smoke/scenario-dispatcher.js`（新）

5 用例：
- D1: 单 C1 命中 → modifiedRows.length 正确
- D2: 单 C2 命中 → 双锁（leftRow + rightRow 都进 modifiedRows）
- D3: first-match-wins：C1 优先级 3 + C3 优先级 1 同行 → C1 命中后 C3 不再处理该行
- D4: gwRows = null → C3 类场景被过滤掉（不参与调度）
- D5: 全部场景 disabled → modifiedRows.length === 0

#### F6.2 `scripts/smoke/bank-statement-io.js`（新）

3 用例：
- I1: 写主输出 + 读回验证标黄（exceljs.read 校验 cell.fill）
- I2: 写 error-report + 读回验证 4 列
- I3: 校验异常（44 列缺列 / 31 列缺 sheet → 抛 FileValidationError）

#### F6.3 接入

`scripts/smoke-test.js` 加 `runScenarioDispatcherSmokeTests()` + `runBankStatementIoSmokeTests()`。

## 5. 影响范围

- **后端新增**：
  - `src/main-process/scenario-dispatcher.js`（新，~200 行）
  - `src/main-process/bank-statement-io.js`（新，~400 行）
  - `src/main-process/exceljs-writer.js`（新，~150 行）
- **后端修改**：
  - `src/main.js` — 4 个 IPC handler + 3 个 session state（约 +250 行）
  - `src/preload.js` — `desktopApi.bankStatement` 暴露（约 +10 行）
- **依赖**：`package.json` 新增 `exceljs`
- **测试**：
  - `scripts/smoke/scenario-dispatcher.js`（新）
  - `scripts/smoke/bank-statement-io.js`（新）
  - `scripts/smoke-test.js` 接入
- **不动**：
  - 任何前端文件（renderer.js / renderer-dialogs.js / renderer-previews.js / styles*.css / index.html）
  - PR #29 / #30 / #31 已 merge 内容
  - 任何现有 IO 模块（file-service/readers.js / writers.js 继续 SheetJS）
  - scenarios 表 schema / 6 IPC channel
- **兼容性**：与 PR #29/#30/#31 完全兼容；exceljs 仅本模块用，不影响其他 3 模块

## 6. 技术决策

### D1 exceljs vs SheetJS 共存

- exceljs 仅用于本模块的 **写出**（标黄输出 + error-report）
- 读入仍用 SheetJS（复用现有 readers.js 的成熟解析）
- 其他 3 模块（statementGenerator / newAccountGenerator / pendingReconciliation）不变
- 理由：避免大规模 writer 重写（现有 SheetJS writer 跑了 1.5 年稳定）

### D2 调度引擎数据结构

- `lockedRowIds` 来自算法 `runScenario`，dispatcher 不改其语义
- C2 双锁（leftRow + rightRow 都进 lockedRowIds）已由 PR #31 保证
- modifications 在 dispatcher 层补充 `scenarioId + scenarioName`（算法层不知道这俩字段）
- `_modifiedColumns` 是 per-row 收集（同行不可能跨场景命中，first-match-wins 锁住）

### D3 文件路径与现有 export 解耦

- 现有：`~/Documents/网银账单生成小助手/exports/{date}/`（statementGenerator 用）
- 现有：`~/Documents/网银账单生成小助手/error-reports/{date}/`（statementGenerator 错误用）
- **新增**：`~/Documents/网银账单生成小助手/bank-statement-process/{date}/`（独立目录，避免混淆）

### D4 _rowId 生成时机

- import 阶段（F3.1）就给每行加 `_rowId = row_${index}`
- 算法层 ensureRowId 保留作为 fallback（输入未加时自动写回）
- dispatcher 层不重新生成

### D5 IPC 命名规范

- 沿用现有 `xxx-yyy:zzz` 格式（如 `templates:list` / `mappings:save`）
- bank-statement:import / gateway-recon:import / bank-statement:run / bank-statement:export

## 7. 数据 / 状态 / 安全影响

### ⚠️ 资金红线（高亮提醒）

本 PR 是 v2.0.0-beta.3 资金红线"接入 IO 真改字段"前的最后一段后端：

- C2 笛卡尔配对的 `outbound 行 FundType` 改 `outbound Fail` 真发生在 dispatcher
- C3 join 的 `银行对账单.ReconciliationId` 真发生在 dispatcher
- first-match-wins 锁机制错位 → 全行错过 / 重复改

**强制要求**：
- F6.1 dispatcher smoke 5 用例必须 PASS
- PR body 高亮"⚠️ 资金红线"段落
- 用户样例文件 dry-run 移到 PR #32b（前端接入后才能完整跑用户工作流）

### Schema 变更：无

### 状态生命周期

- `state.bankStatementSession` / `state.gatewayReconSession` / `state.processingResult`：
  - main 进程全局变量（与现有 `lastFileImportContext` 一致）
  - 进程重启不持久化
  - PR #32b 实施时由 renderer 通过 IPC 状态查询同步

### 回滚

- 代码层：revert merge commit
- 数据层：无（无 schema 变更）
- 依赖：`npm uninstall exceljs`（如需）

## 8. 待澄清问题

- [x] xlsx 标黄库选型 → exceljs（用户 Q1=C 决策 2026-04-29）
- [x] PR 切分策略 → 切两 PR（用户 Q2=B 决策 2026-04-29）
- [ ] **Q-A1**：用户运行"开始运行"时，C3 启用 + 未导入 gwRows 的提示策略 → 推荐：dispatcher 直接按 gwRows = null 跳过 C3 类场景，main.js IPC 返回 `stats.skippedC3Count > 0` 让 renderer 提示（避免后端硬塞 dialog 逻辑）
- [ ] **Q-A2**：modifiedRows 在写出时是否保留 `_rowId` / `_modifiedColumns` / `_hitScenarioName` 这些内部字段？→ 推荐：写出时剥离（仅写 originalHeaders 44 列），_modifiedColumns 转换为 cell.fill 信息

## 9. 实施顺序

1. ✅ 落 spec 三件套（本文件）
2. `npm install exceljs` + 验证版本
3. `src/main-process/exceljs-writer.js`（150 行）+ smoke I1（写 + 读回验证标黄）
4. `src/main-process/scenario-dispatcher.js`（200 行）+ smoke F6.1 5 用例
5. `src/main-process/bank-statement-io.js`（400 行）+ smoke F6.2 3 用例
6. `src/main.js` 4 IPC handler + session state（250 行）
7. `src/preload.js` 暴露 4 channel
8. `npm run smoke` 全量 PASS
9. `npm run scan:vars` + check-vars 评估升格
10. PR body + 提 PR
