# 需求3（批1+批2）：资金对账 导入/运行不阻塞 + 防重入 + 按钮禁用（v3.0.11 · 🔴资金红线）

> 范围：本 spec 只含 v3.0.11 批1+批2（导入、运行不阻塞）。**导出流式化（批3+批4）拆独立批次 `bank-statement-async-export-streaming`，不在本 spec。**
> 对标样板：收单单据模块（acquiring-bill-currency）。

## 跨文件契约（务必逐字一致，防接缝 bug）
- **新 IPC 进度通道**：`bank-statement:import:progress`（命名对齐收单 `acquiringBillCurrency:import:progress`）。
- **preload 暴露**：`window.desktopApi.bankStatement.onImportProgress(cb)`（仿 `onRunProgress` `preload.js:192-196`，返回 unsubscribe）。
- **renderer state 新字段**：`state.bankStatementInflight`（布尔，操作进行中闸）。
- **进度事件结构**：复用 run 既有形态 `{ stage, fileIndex, fileCount, filePath, ... }`，文案函数 `formatBankStatementImportProgress(ev)`（仿 `formatBankStatementRunProgress` `renderer.js:4114`）。
- **op-lock 返回**：争用时 handler 返回 `{ status: 'failed', message: '正在处理中…' }`。

## 批1（🟢 低风险，产物零变化）

### 1. 防重入 op-lock（main.js）
- 现状：`bankStatementOperationLock` 零命中（无锁）。
- 新建模块级锁（仿收单 `main.js:390` 区 `acquiringBillCurrencyOperationLock`），**统一一把互斥锁**包裹：`bank-statement:batch-import`、`bank-statement:run`、`bank-statement:export`，**以及（codex-P2 补强）`linked-table:import`、`linked-table:delete-by-date-range` —— 共 5 个 handler**。
- 入口 `tryAcquire` 失败即返回 `{status:'failed', message:'正在处理中…'}`；`finally` 释放。
- 理由：这些动作共享 bank-statement 对账数据与会话态（`bankStatementSession`/`processingResult`/`refundOrderSession`），**以及作为 R1-R5 输入的链接表**（gateway-bill/bank-deposit/mid-allocation 等）；并发会撕裂状态。
- 🔴 **链接表写入必须在锁内**（codex-P2）：否则 run 数据准备阶段在 linked-table 多步读取间让出（批2 的 `prepare-gw`/`prepare-linked`）时，并发改表会把「改动前 gw」与「改动后 deposit/mid/recon」拼成从未真实存在的快照、存错 `processingResult`。锁住链接表写入后，三处 prepare 让出（clone-bank/gw/linked）均可安全保留。

### 2. 导入让出 + 进度（main.js / preload.js / renderer.js）
- `main.js:12051` 多文件循环 `for (const filePath of choice.filePaths)` 体内，每文件处理完插 `await new Promise(r => setImmediate(r))`（仿 orchestrator `yieldTick` 范式）。
- handler 签名 `async ()` → `async (event)`；新增内联进度 forwarder（100ms 节流，仿收单 `:12365-12368` + run 内联 `:3685`）→ emit `bank-statement:import:progress`。
- `preload.js`：`bankStatement` 加 `onImportProgress`（照抄 `:192-196` 换通道名）。
- `renderer.js`：新增 `formatBankStatementImportProgress`；在 `handleBankStatementBatchImport`(`:3747`) 内订阅 + 刷 `bankStatementStatusBox` + `finally` 退订。
- 单文件内 `readBankStatement`（同步 `XLSX.readFile`）**本批不改**（留观察，单个预处理对账单行数有限）。

### 3. 按钮禁用统一闸（renderer.js）
- 新增 `state.bankStatementInflight`，叠加进既有 disabled 计算（`:3541` run 按钮 / `:3552` export 按钮赋值处加 `|| state.bankStatementInflight`）。
- import/run/export 三入口（`:3747`/`:4134`/`:4172`）**最外层**设 `inflight=true`、**最内层** `finally` 清。
- ⚠️ run 链路含 confirm dialog（`handleBankStatementRun→proceedToGwCheck→runBankStatementInternal`，`:4011` confirm）：禁用须最外层设、最内层清，防 dialog 等待期重入。

## 批2（🟢 低风险，纯控制流、数据值零变化）

### run 数据准备分块让出（main.js）
- 现状：`yieldRun('prepare')`(`:3718`) 与 `yieldRun('reconcile')`(`:3830`) 之间是连续同步大表准备。
- 在**步骤边界**插 2–3 个 `await yieldRun('prepare-xxx')`（如 `prepare-clone-bank` / `prepare-gw` / `prepare-linked`），位置：
  - `structuredClone(bankStatementSession.rows)`(`:3722`) 后
  - `readGatewayBillRowsByChannels`(`:3734`) 后
  - 链接表 `structuredClone(readLinkedTableRows)` 群(`:3752/3768/3818/3827`) 后
- `renderer.js:4116` `STAGE_LABELS` 补对应 key 文案。

## 🔴 不变量（不可破坏）
1. **structuredClone 不删、不中途让出**：clone 原子且防引擎原地改污染（`:3719-3721` 注释）；只在步骤间 `await`，不在单个 clone 内部。
2. **processingResult 末尾一次性赋值**：保持 `:3851` 的「所有 await 完成后同步一次性赋」，不要拆增量写。
3. **export snapshot 拒绝**：`main.js:3897-3901`（run 后改场景 → export 拒绝）保留不动。
4. **产物零变化**：批1+批2 不碰任何 writer，现有导出 golden 自动保证未回归。

## 验收
- `npm run release-check` 全绿。
- 新增 op-lock 互斥单测（三动作并发被挡）。
- 手测：大数据量「导入/运行」期间窗口保持响应、按钮禁用、二次点击被挡。
