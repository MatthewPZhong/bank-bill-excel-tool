# Tasks — v2.0.0-beta.3 PR #32a：调度 + IO + IPC

> ~3 天工作量；按 spec.md §9 顺序。

## 第 1 天：依赖 + writer + dispatcher

- [ ] T1.1 `npm install exceljs` + verify package.json 写入
- [ ] T1.2 `src/main-process/exceljs-writer.js`：writeBankStatementOutput / writeErrorReport
- [ ] T1.3 验证：spike 写一行带黄底单元格的最小 .xlsx，用 macOS Numbers 打开看效果
- [ ] T1.4 `src/main-process/scenario-dispatcher.js`：runAllScenarios 实现（first-match-wins）
- [ ] T1.5 `scripts/smoke/scenario-dispatcher.js` 5 用例（D1-D5）
- [ ] T1.6 `scripts/smoke-test.js` 接入 runScenarioDispatcherSmokeTests

## 第 2 天：IO 层 + IPC

- [ ] T2.1 `src/main-process/bank-statement-io.js`：readBankStatement（44 列校验）
- [ ] T2.2 同文件：readGatewayRecon（31 列「网关账单」sheet 校验）
- [ ] T2.3 同文件：writeBankStatementMainOutput（调 exceljs-writer，仅修改行 + 标黄 + 文件名规则）
- [ ] T2.4 同文件：writeErrorReport（调 exceljs-writer，4 列）
- [ ] T2.5 `scripts/smoke/bank-statement-io.js` 3 用例（I1-I3）
- [ ] T2.6 `scripts/smoke-test.js` 接入 runBankStatementIoSmokeTests

## 第 3 天：IPC + main.js + preload

- [ ] T3.1 `src/main.js` 加 session state：`state.bankStatementSession` / `gatewayReconSession` / `processingResult`
- [ ] T3.2 `src/main.js` IPC handler：bank-statement:import（调 readBankStatement + 写 session）
- [ ] T3.3 同：gateway-recon:import
- [ ] T3.4 同：bank-statement:run（调 dispatcher + 写 processingResult）
- [ ] T3.5 同：bank-statement:export（调 writeBankStatementMainOutput + writeErrorReport）
- [ ] T3.6 `src/preload.js` 暴露 `desktopApi.bankStatement.{import, importGatewayRecon, run, export}`
- [ ] T3.7 `npm run smoke` 全量 PASS（dispatcher 5 + io 3 + scenario-engines 23 + 既有）
- [ ] T3.8 `npm run scan:vars` + 评估 runAllScenarios / readBankStatement / writeBankStatementMainOutput 是否需要升格 important-variables
- [ ] T3.9 PR body 编写（含资金红线高亮 + smoke 结果 + 接口契约）
- [ ] T3.10 提 PR（v2.0.0 → main）

## 验收标准

- ✅ smoke 全 PASS（dispatcher 5 + io 3）
- ✅ exceljs 写出的 .xlsx 在 macOS Numbers 中能看到黄底
- ✅ 校验异常路径（44 列缺列 / 31 列缺 sheet）正确抛 FileValidationError
- ✅ main.js + preload 4 IPC channel 可用（PR #32b 直接消费）
- ✅ check-vars 命中已自查
