# Tasks — v2.0.0-beta.3 PR #32a：调度 + IO + IPC

> ~3 天工作量；按 spec.md §9 顺序。

## 第 1 天：依赖 + writer + dispatcher

- [x] T1.1 `npm install exceljs` + verify package.json 写入（exceljs ^4.4.0）
- [x] T1.2 `src/main-process/exceljs-writer.js`：writeBankStatementOutput / writeErrorReport
- [x] T1.3 验证：spike 写一行带黄底单元格的最小 .xlsx，round-trip `fgColor.argb='FFFFFF00'` 完整保留
- [x] T1.4 `src/main-process/scenario-dispatcher.js`：runAllScenarios 实现（first-match-wins）
- [x] T1.5 `scripts/smoke/scenario-dispatcher.js` 用例（D1-D5 基础 + D6/D7 in-place clone 回归 + D8 warnings-only + D9 gwRows=[] warning + helper unit）
- [x] T1.6 `scripts/smoke-test.js` 接入 runScenarioDispatcherSmokeTests + runExceljsWriterSmokeTests

## 第 2 天：IO 层 + IPC

- [x] T2.1 `src/main-process/bank-statement-io.js`：readBankStatement（44 列校验）
- [x] T2.2 同文件：readGatewayRecon（31 列「网关账单」sheet 校验）
- [x] T2.3 同文件：writeBankStatementMainOutput（调 exceljs-writer，仅修改行 + 标黄 + 文件名规则）
- [x] T2.4 同文件：writeErrorReportOutput（调 exceljs-writer，4 列）
- [x] T2.5 `scripts/smoke/bank-statement-io.js` 11 用例（R1-R6 reader + W1-W4 + F1 writer/文件名）
- [x] T2.6 `scripts/smoke-test.js` 接入 runBankStatementIoSmokeTests

## 第 3 天：IPC + main.js + preload

- [x] T3.1 `src/main.js` 加 session state：`bankStatementSession` / `gatewayReconSession` / `processingResult`
- [x] T3.2 `src/main.js` IPC handler：bank-statement:import（调 readBankStatement + 写 session + 同步清空 gatewayReconSession + processingResult）
- [x] T3.3 同：gateway-recon:import
- [x] T3.4 同：bank-statement:run（调 dispatcher + 写 processingResult；每次 run 前 structuredClone 工作副本）
- [x] T3.5 同：bank-statement:export（先写 error-report 再判 modifiedRows.length 空；error-report 与主输出独立落盘）
- [x] T3.6 `src/preload.js` 暴露 `desktopApi.bankStatement.{import, importGatewayRecon, run, export, sessionStatus}`
- [x] T3.7 `npm run smoke` 全量 PASS（48/48：dispatcher 11 + io 11 + writer 3 + scenario-engines 23）
- [x] T3.8 `npm run scan:vars` + 评估升格（runAllScenarios / readBankStatement / writeBankStatementMainOutput 暂不入表，等 PR #32b 接入更多消费点后再评估）
- [x] T3.9 PR body 编写（含资金红线高亮 + 48/48 smoke 结果 + 接口契约）
- [x] T3.10 提 PR（PR #32, https://github.com/MatthewPZhong/bank-bill-excel-tool/pull/32）

## Codex 3 轮修复

- [x] Round 1（commit `1cd9503`）— 2 个 P1 资金红线
  - F1 dispatcher in-place 修改 → bank-statement:run structuredClone（D6/D7）
  - F2 重新导入银行对账单时同步清空 gatewayReconSession
- [x] Round 2（commit `e058527`）— 1 个 P1 资金红线
  - F1 export 提前 return 把 error-report 丢掉 → 先写 error-report 再判 empty（D8）
- [x] Round 3（commit `5e3ee56`）— 1 个 P2
  - F1 dispatcher 把 gwRows=[] 当未导入 → 仅 null/undefined 过滤（D9）

## 验收标准

- ✅ smoke 全 PASS（dispatcher 11 + io 11 + writer 3）
- ✅ exceljs 写出的 .xlsx round-trip 验证黄底标记
- ✅ 校验异常路径（44 列缺列 / 31 列缺 sheet）正确抛 FileValidationError
- ✅ main.js + preload 5 IPC channel 可用（PR #32b 直接消费）
- ✅ check-vars 命中 3 处已自查（FileValidationError / ipcRenderer / dialog）
- ✅ 资金红线 4 个 P1 全清（in-place clone / 导入清 gw / error-report 独立 / gwRows=[] warning）
