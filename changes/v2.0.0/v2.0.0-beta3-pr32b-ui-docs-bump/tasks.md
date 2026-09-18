# Tasks — v2.0.0-beta.3 PR #32b：4 dialog + 接入 + preview + E2E + 文档 + bump

> 实施完成 2026-04-29，落到 PR #33（GitHub PR 编号，原内部代号 PR #32b）。

## 第 1 天：C3 + C1 dialog（先简后繁）

- [x] T1.1 落 spec 三件套
- [x] T1.2 `createScenarioConfigDialogC3`（4 行：场景名/优先级/对账字段多行/赋值，约 300 行）
- [x] T1.3 `createScenarioConfigDialogC1`（5 行：+ 行 4/5 互斥 + 7 操作下拉，约 400 行）

## 第 2 天：C2 + 确认详情 dialog

- [x] T2.1 `createScenarioConfigDialogC2`（5 行 + 行 3 序号自动 + 行 4/5 类型联动，约 600 行）
- [x] T2.2 `createScenarioConfirmDetailDialog`（C1/C2/C3 三种文本预览，约 200 行）

## 第 3 天：CSS + state + 接入 + 4 按钮 binding

- [x] T3.1 CSS `styles.css` 加配置弹窗布局（~250 行）
- [x] T3.2 CSS `styles-gemini-extra.css` 加同样样式（~250 行）
- [x] T3.3 `state.bankStatementSession` / `gatewayReconSession` / `processingResult` / `scenarioDraft` / `bankStatementExport` 字段
- [x] T3.4 `refreshBankStatementStatus()` — 调 `desktopApi.bankStatement.sessionStatus()` 同步 state + 刷新 statusBox + 按钮 disabled
- [x] T3.5 接入 PR #30 占位：
  - `view-or-modify` action（is-editing → mode='edit' / 默认 → mode='view'）
  - 类别选择"继续"（mode='create'）
  - "管理"按钮（替代 PR #30"编辑/查看场景/修改场景"三按钮）
- [x] T3.6 bankStatementModulePanel 4 按钮 binding：
  - 导入文件 → bankStatement.import + statusBox 更新 + 导入后弹 dialog#1（C3 启用未导 gw）
  - 开始运行 → bankStatement.run + statusBox 更新 + 运行点弹 dialog#2 三选一（PR #33 round 1）
  - 导出文件 → bankStatement.export 走 saveDialog 另存为 + 处理 ok/empty/failed/cancelled 分支
- [x] T3.7 模块切换 / 启动时调 refreshBankStatementStatus 同步

## 第 4 天：preview + E2E smoke

- [x] T4.1 `renderer-previews.js` 4 张 preview state（c1/c2/c3 配置 + 确认详情）
- [x] T4.2 主入口分发追加 4 项 + 加 6 个 `npm run preview:*` script + 串入 preview:all（PR #33 round 1）
- [x] T4.3 `npm run preview` 生成 4 张新 png 到 `docs/previews/`
- [x] T4.4 `scripts/smoke/scenario-end-to-end.js`（dispatcher → exceljs writer 全链路 in-memory，23 用例）
- [x] T4.5 `scripts/smoke-test.js` 接入 runScenarioEndToEndSmokeTests

## 第 5 天：用户样例 dry-run + 文档

- [x] T5.1 用户样例文件 dry-run（PRD §13.1 P0-1 ~ P0-11，11 个用例）
  - `scripts/dryrun-user-sample.js` 用 in-process 走 dispatcher → exceljs writer 全链路
  - 真实样例 `Copy of 汇总测试.xlsx` 3625 行 → 58 行命中（23 C2 + 12 C3 modifications）
  - P0 矩阵：7 ✅ + 2 ❓（样例无 C1 场景但 smoke 单测覆盖）+ 2 ⚠️（GUI 用户实测过）
- [x] T5.2 `银行对账单.xlsx` + `资金对账导出不平.xlsx` 加 .gitignore
- [x] T5.3 `CHANGELOG.md` 加 `## 2.0.0-beta.3 — 2026-04-29` 条目
- [x] T5.4 `docs/VERSION_FEATURE_HISTORY.md` 表格追加 v2.0.0-beta.3 段
- [x] T5.5 `docs/USER_GUIDE.md` 加 1.4「银行对账单处理」章节 + 顶部版本号 + 模块总览同步（PR #33 round 1）

## 第 6 天：bump + check-vars + PR

- [x] T6.1 `package.json.version` 2.0.0-beta.2 → 2.0.0-beta.3 + `package-lock.json` 同步（PR #33 round 1）
- [x] T6.2 `npm run scan:vars` 重新生成自动报告
- [x] T6.3 check-vars 软流程（命中 1 Risk-sensitive 数据库迁移 + 1 Runtime-state state 知会，已自查）
- [x] T6.4 升格评估：本 PR 新增模块均为 v2.0.0-beta.3 新文件，待后续版本人工评估升格
- [x] T6.5 `npm run smoke` 全量 PASS（78/78：scenario-engines 23 + repository 5 + dispatcher 11 + exceljs-writer 3 + bank-statement-io 13 + scenario-end-to-end 23）
- [x] T6.6 `npm run preview` + `npm run preview:account` 全量重生成
- [x] T6.7 PR body 编写 → `docs/prs/PR33-v2.0.0.md`（含资金红线 + check-vars + P0 dry-run 矩阵）
- [x] T6.8 提 PR（v2.0.0 → main）→ https://github.com/MatthewPZhong/bank-bill-excel-tool/pull/33

## Codex review 修复

- [x] Round 1（commit `fedea04`）：5 finding（4 P2 + 1 P3）
  - F1 P2 C3 资金对账"稍后再说"无补救入口 → A 方案：保留 dialog#1 + 运行点新增 dialog#2 三选一
  - F2 P2 package-lock.json 同步 beta.3
  - F3 P2 USER_GUIDE 顶部版本 + 模块总览
  - F4 P2 内置场景删除语义文档统一（A 方案：可编辑、可禁用、可删除）
  - F5 P3 preview:all 串入 6 新 script
- [x] Round 2：3 finding（1 P1 + 2 P3）
  - F1 P1 资金红线：场景变更后失效 processingResult（main + renderer 双端联动）
  - F2 P3 CHANGELOG.md:15 残留"删除内置场景被拦截"已删
  - F3 P3 tasks.md 同步勾选已完成项

## 验收标准

- ✅ 4 dialog factory 完整实现（C1/C2/C3 配置 + 确认详情）
- ✅ PR #30 3 处占位全部接入实际 dialog
- ✅ bankStatementModulePanel 4 按钮接入 PR #32a 5 IPC
- ✅ statusBox 5 状态文案动态更新
- ✅ 4 张新 preview 渲染正常
- ✅ E2E smoke + 既有 55 PASS（共 78 PASS）
- ✅ 用户样例 dry-run 自动 7/11 + smoke 单测补 2/11 + GUI 实测 2/11
- ✅ 文档三件套同步
- ✅ 版本号 = 2.0.0-beta.3
- ✅ check-vars 命中已自查（Risk-sensitive 数据库迁移幂等）
