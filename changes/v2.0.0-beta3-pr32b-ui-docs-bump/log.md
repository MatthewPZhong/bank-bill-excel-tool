# Log — v2.0.0-beta.3 PR #32b：UI + 接入 + preview + E2E + 文档 + bump

## 2026-04-29 初始

- 动作：落 spec/tasks/log，状态=apply
- 证据：
  - PRD §十二 方案 B：PR #32 = 4+5+6 UI + 7 + 8（调度 + IO + 文档 + bump）
  - 用户 2026-04-29 决策切分：PR #32 → PR #32a（后端，已 merge `e21be0d`）+ PR #32b（前端 + 发版）
  - PR #29 / #30 / #31 / #32a 已 merge（main HEAD `e21be0d`）
  - 后端稳定接口：5 IPC channel + 49 单测保障
  - 用户样例文件已在 working tree：`银行对账单.xlsx` / `资金对账导出不平.xlsx`
- 用户决策（已落位）：
  - **Q1=C** xlsx 标黄 = exceljs（PR #32a 实施）
  - **Q2=B** 切两 PR（本 PR = 第二段前端）
  - **Q3=A** dialog 全做完后一次 Codex review（PR #32b 节奏）
- 风险：
  - **资金红线（最高级）**：本 PR 接入 UI 让用户**真改 FundType / ReconciliationId**；first-match-wins 调度是 PR #32a 后端能力，UI 触发错误（导入错文件 / 错调 IPC）也可能误改
  - 4 dialog factory 体量大（~1500 行单文件）：单次会话出错风险高，按 D4 顺序"先简后繁"
  - `state.scenarioDraft` 跨 4 弹窗共享：清空/保留时机错可能 dialog 串味
  - 用户样例文件 P0-1 ~ P0-11 必须人工 dry-run（smoke 无法覆盖 UI/Excel 完整路径）
- 决策：
  - **dialog factory 实施顺序**：C3（最简）→ C1（互斥）→ C2（最复杂）→ 确认详情（共享）
  - **状态保留**：state.scenarioDraft 仅"返回"按钮保留；"完成"成功落库 / "取消" / dialog 关闭 / 模块切换都清空
  - **资金对账文件检查时机**：用户点"开始运行"时弹 confirmDialog（不在导入银行对账单时检查）
  - **error-report 路径独立目录**：`bank-statement-process/{date}/`（PR #32a D3 决策）
  - **用户样例文件不入 git**：加 .gitignore（D6）
  - **文档三件套**：本 PR（最后一个 PR）才统一更新（按 workflow_docs_update）

## 可沉淀知识（实施后回填）

- [ ] 4 dialog factory 共享 state.scenarioDraft 的边界（清空/保留时机踩的坑）
- [ ] view 模式 disabled 视觉 vs 交互差异（用户能否分辨"查看" vs "新建")
- [ ] 用户样例文件 P0-1 ~ P0-11 dry-run 实测结果（命中正确性 / 标黄正确性 / 文件名规则）
- [ ] dialog 大体量单 PR 的 Codex review 经验（逐 dialog vs 全 4 个一起）

## 2026-04-29 GUI 实测反馈 → 6 项 UX 调整（reverse-sync）

用户实测后提出 6 项调整，决策如下，对 spec/PRD 的偏移在此记录：

1. **状态框文案：`资金对账：` → `不平账结果表：`**
   - 影响 `src/renderer.js#updateBankStatementUi`
   - 与 PRD §F8 一致（PRD §7.5 文件描述同样用「不平账结果表」），spec.md §F8 的"资金对账"为旧词，**记忆替换**

2. **去掉"运行成功"alert，内容显示在状态框**
   - 影响 `src/renderer.js#runBankStatementInternal`（删除 `openModal(createAlertDialog(msg))`）
   - 影响 `updateBankStatementUi`（合并 skippedC3 提醒到状态框）
   - **决策**：状态框文案 `已处理：N 行命中（场景 a、b），M 警告` + 可选 `· 跳过 K 个对账不平场景`

3. **命中场景用序号显示在 ()**
   - 影响 `src/main-process/scenario-dispatcher.js`（stats 增加 `hitScenarioIds: number[]`）
   - 影响 `src/renderer.js#refreshBankStatementStatus`（state.processingResult 增加 hitScenarioIds 字段）
   - 与 spec §F8 偏移：原文案 `（X 场景）` → 新 `（场景 1、3）`

4. **删除"覆盖原ID"warning**
   - 影响 `c1-extract-recon-id.js`（删除 `overwrite-existing-recon-id` push）
   - 影响 `c3-gateway-recon-join.js`（删除 `overwrite-existing-value` push）
   - **风险**：原值非空 → 直接覆盖，不再产生警告（用户已确认）
   - PR #31 单测可能验证这两条 warning 存在，需调整 expectations

5. **导出文件支持另存为**
   - 影响 `src/main.js#bank-statement:export`（增加 `dialog.showSaveDialog`）
   - error-report 仍走原默认目录 `bank-statement-process/{date}/`，仅主输出走 saveDialog
   - 与 PRD §7.5 偏移：原默认到 `bank-statement-process/{date}/` 直接写出 → 现交互式选保存路径
   - defaultPath 用新命名规则（点 6）

6. **导出命名规则：`银行对账单-YYYYMMDDHHmm-处理结果.xlsx`**
   - 影响 `src/main-process/bank-statement-io.js#buildMainOutputFileName`
   - 时间戳精度由秒（YYYYMMDDhhmmss）变分钟（YYYYMMDDHHmm）
   - 不再含场景名、不再有"多场景"分支；统一格式
   - 与 PR #32a smoke `B2.x buildMainOutputFileName` 偏移，需更新 smoke 用例
   - error-report 命名规则 `${ts}-error-report.xlsx` 不变（用户未要求改）

### 实施结果（2026-04-29 同日完成）

改动文件清单：
- `src/main-process/scenario-engines/c1-extract-recon-id.js`（删 overwrite warning）
- `src/main-process/scenario-engines/c3-gateway-recon-join.js`（删 overwrite warning）
- `src/main-process/scenario-dispatcher.js`（stats 加 `hitScenarioIds`）
- `src/main-process/bank-statement-io.js`（新增 `buildTimestampMinute`；`buildMainOutputFileName` 改新规则；`writeBankStatementMainOutput` 签名 `exportRootDir` → `mainFilePath`）
- `src/main.js`（`bank-statement:export` handler 加 `dialog.showSaveDialog`）
- `src/renderer.js`（`refreshBankStatementStatus` 新映射 `hitScenarioIds`/`skippedC3Count`；`updateBankStatementUi` 新文案 + 「场景 1、3」+ 跳过 C3 提示；`runBankStatementInternal` 删 alert；`handleBankStatementExport` 新增 `cancelled` 分支）

smoke 测试同步：
- `scripts/smoke/scenario-engines.js`（C1-8 / C3-4 反向断言：不应再有 overwrite warn）
- `scripts/smoke/scenario-dispatcher.js`（D1 / D3 / D5 加 `hitScenarioIds` 断言）
- `scripts/smoke/bank-statement-io.js`（W1 / W2 / F1 改新文件名规则，writeBankStatement 签名改 mainFilePath）

smoke 结果：55/55 PASS（scenario-engines 23 + scenarios-repository 5 + scenario-dispatcher 11 + exceljs-writer 3 + bank-statement-io 13）。

check-vars 软约束自查：本次 6 项改动均未命中 `rules/important-variables.md` 中 Critical / Important-skeleton / Runtime-state / Risk-sensitive 任一登记符号（清单基线 v1.5.3，所有改动集中在 v2.0.0-beta.3 新增模块）。最终 PR 提交前会跑硬节点 `/check-vars`。

⚠️ **风险提醒（资金红线）**：删除 overwrite warning 后，原值非空被覆盖**不再产生 error-report 记录**。用户已确认此 UX 行为，但需注意：调试期若 dispatcher first-match-wins 导致非预期覆盖，将无 warning 痕迹可追。建议人工 dry-run 时关注 modifications 列表（PRD §13）。

## 2026-04-29 GUI 实测反馈第二轮 → 2 项 UX 调整

7. **去掉「导出成功」alert，提醒进状态框**
   - 影响 `src/renderer.js#handleBankStatementExport`（删除 ok / empty 分支的 `openModal(createAlertDialog(...))`，改写 `state.bankStatementExport` 后调 `updateBankStatementUi`）
   - 新增 `state.bankStatementExport: { mainFileName, errorReportName } | null`（renderer-side 缓存，main 进程不持久化）
   - 清缓存时机：再次导入银行单 / 再次导入 gw / 再次运行 → 清空（避免显示陈旧的"已导出"）
   - failed 分支保留 alert（错误信息仍弹 alert）

8. **状态框两文件信息分行**
   - 影响 `src/renderer.js#updateBankStatementUi`（文案分隔符 `，` → `\n`）
   - 影响 `src/styles.css` + `src/styles-gemini-extra.css`：新增 `#bankStatementStatusBox .status-box-text { white-space: pre-line; }`
   - 应用范围：导入双文件分行 + 已导出含 error-report 分行

smoke 结果：55/55 PASS（仅 renderer + CSS 改动，不影响后端 smoke 用例）。
