# Tasks — v2.0.0-beta.3 PR #32b：4 dialog + 接入 + preview + E2E + 文档 + bump

> ~6 天工作量；按 spec.md §9 顺序。

## 第 1 天：C3 + C1 dialog（先简后繁）

- [ ] T1.1 落 spec 三件套
- [ ] T1.2 `createScenarioConfigDialogC3`（4 行：场景名/优先级/对账字段多行/赋值，约 300 行）
- [ ] T1.3 `createScenarioConfigDialogC1`（5 行：+ 行 4/5 互斥 + 7 操作下拉，约 400 行）

## 第 2 天：C2 + 确认详情 dialog

- [ ] T2.1 `createScenarioConfigDialogC2`（5 行 + 行 3 序号自动 + 行 4/5 类型联动，约 600 行）
- [ ] T2.2 `createScenarioConfirmDetailDialog`（C1/C2/C3 三种文本预览，约 200 行）

## 第 3 天：CSS + state + 接入 + 4 按钮 binding

- [ ] T3.1 CSS `styles.css` 加配置弹窗布局（~200 行）
- [ ] T3.2 CSS `styles-gemini-extra.css` 加同样样式（~200 行）
- [ ] T3.3 `state.bankStatementSession` / `gatewayReconSession` / `processingResult` / `scenarioDraft` 字段
- [ ] T3.4 `refreshBankStatementStatus()` — 调 `desktopApi.bankStatement.sessionStatus()` 同步 state + 刷新 statusBox + 按钮 disabled
- [ ] T3.5 接入 PR #30 占位：
  - `view-or-modify` action（is-editing → mode='edit' / 默认 → mode='view'）
  - 类别选择"继续"（mode='create'）
- [ ] T3.6 bankStatementModulePanel 4 按钮 binding：
  - 导入文件 → bankStatement.import + statusBox 更新
  - 开始运行 → C3 启用 + 未导入 gw 时弹 confirmDialog 三选一 → bankStatement.run + statusBox 更新
  - 导出文件 → bankStatement.export + 处理 ok/empty/failed 分支
- [ ] T3.7 模块切换 / 启动时调 refreshBankStatementStatus 同步

## 第 4 天：preview + E2E smoke

- [ ] T4.1 `renderer-previews.js` 4 张 preview state（c1/c2/c3 配置 + 确认详情）
- [ ] T4.2 `scripts/render-account-mapping-preview.js` 主入口分发追加 4 项
- [ ] T4.3 `npm run preview` 生成 4 张新 png 到 `docs/previews/`
- [ ] T4.4 `scripts/smoke/scenario-end-to-end.js`（dispatcher → exceljs writer 全链路 in-memory）
- [ ] T4.5 `scripts/smoke-test.js` 接入 runScenarioEndToEndSmokeTests

## 第 5 天：用户样例 dry-run + 文档

- [ ] T5.1 用户样例文件 dry-run（PRD §13.1 P0-1 ~ P0-11，11 个用例）
  - P0-1 C1 调拨自提取
  - P0-2 C1 多字段值不一致 → error-report
  - P0-3 C2 outbound Fail 打标
  - P0-4 C2 一对多报错
  - P0-5 内置 C3 默认关闭
  - P0-6 启用 C3 触发"导入资金对账"提示
  - P0-7 C3 跳过
  - P0-8 C3 join 命中
  - P0-9 first-match-wins
  - P0-10 标黄 + 仅导修改行
  - P0-11 空运行结果"无修改记录"
- [ ] T5.2 `银行对账单.xlsx` + `资金对账导出不平.xlsx` 加 .gitignore
- [ ] T5.3 `CHANGELOG.md` 加 `## 2.0.0-beta.3 — 2026-04-29` 条目（4 PR 全部产物 + 资金红线高亮）
- [ ] T5.4 `docs/VERSION_FEATURE_HISTORY.md` 表格追加 v2.0.0-beta.3 行
- [ ] T5.5 `docs/USER_GUIDE.md` 加"银行对账单处理模块"章节（截图 + 工作流）

## 第 6 天：bump + check-vars + PR

- [ ] T6.1 `package.json.version` 2.0.0-beta.2 → 2.0.0-beta.3
- [ ] T6.2 `npm run scan:vars` 重新生成自动报告
- [ ] T6.3 `npm run check:vars`（硬节点：版本 bump + 合并到 main）
- [ ] T6.4 评估升格候选（runAllScenarios / readBankStatement / 4 dialog factory 等是否入表）
- [ ] T6.5 `npm run smoke` 全量 PASS
- [ ] T6.6 `npm run preview` + `npm run preview:account` 全量重生成（避免回归）
- [ ] T6.7 PR body 编写（含资金红线 P0-1 ~ P0-11 dry-run 结果）
- [ ] T6.8 提 PR（v2.0.0 → main）

## 验收标准

- ✅ 4 dialog factory 完整实现（C1/C2/C3 配置 + 确认详情）
- ✅ PR #30 3 处占位全部接入实际 dialog
- ✅ bankStatementModulePanel 4 按钮接入 PR #32a 5 IPC
- ✅ statusBox 4 状态文案动态更新
- ✅ 4 张新 preview 渲染正常
- ✅ E2E smoke + 既有 49 PASS（共 50+ PASS）
- ✅ 用户样例文件 P0-1 ~ P0-11 全部通过
- ✅ 文档三件套同步
- ✅ 版本号 = 2.0.0-beta.3
- ✅ check-vars 命中已自查
