# Log — v2.0.0-beta.3 阶段 4+5+6：3 类配置弹窗 + 算法引擎

## 2026-04-28 初始

- 动作：落 spec/tasks/log，状态=apply
- 证据：PRD §十二 方案 B 切分确认 PR #31 = 阶段 4+5+6 = 3 类配置弹窗 + 算法引擎
- 风险：
  - **资金红线**：C2 改 FundType / C3 改 ReconciliationId 是资金语义关键字段；本 PR 仅写算法不接 IO，但 PR #32 调度引擎将依赖这些算法的正确性
  - 大体量 PR（约 2000-3000 行新代码 + 大量单测），review 难度高
  - 3 类弹窗的多行编辑（条件 / 账单类型 / 对账字段）UI 一致性必须把控
- 决策：
  - 算法引擎独立目录 `scenario-engines/`，纯函数 → 可独立测试 + PR #32 调度复用
  - 字段枚举常量化（不从导入文件提取），列结构 PRD D7 已固定
  - "修改场景" 与 "查看场景" 复用同一 dialog（mode 控制 readonly）
  - 多行编辑用 `state.scenarioDraft` 保留临时输入

## 2026-04-28 实施途中切分（PR #31 收口）

- 动作：原 PR #31 = "4+5+6 配置弹窗 + 算法" 切分为 PR #31（算法引擎）+ PR #32（UI/调度/IO/文档/bump）
- 证据：算法引擎实施完毕（5 个 .js 文件 +600 行）+ 单测 18/18 PASS；估算 4 个 dialog factory 还要 1500-2000 行，单 PR 体量到 3000+ 行
- 风险评估：
  - 单条 agent 会话内写 4 个相互关联 dialog factory 容易出错且难修
  - PR 太大 Codex review 难深入
- 决策：
  - PR #31 范围收窄到"算法引擎纯函数 + 字段常量 + 18 单测"——可以稳定 ship
  - UI 部分（4 个 dialog factory + 接入 PR #30 占位）+ 调度（first-match-wins）+ 文件 IO + 标黄输出 + E2E + 文档三件套 + 版本 bump 全部归 PR #32
  - PRD §十二 已同步修订（不再用"原 6 阶段"映射，改为按 PR 边界）
- 关键产物（已 commit）：
  - `src/constants/bank-statement-fields.js`（44 列 + `发生额绝对值` 虚拟字段）
  - `src/constants/gateway-recon-fields.js`（31 列）
  - `src/main-process/scenario-engines/{engine-utils,c1-extract-recon-id,c2-offset-bill-mark,c3-gateway-recon-join,index}.js`
  - 18 个单测覆盖：C1 多字段值一致 / 不一致 / 单字段多值 / 原值覆盖 / extractByOtherField / regex 构建 / 条件判定；C2 一对一 / 一对多 / 多对一 / 类型不匹配；C3 4 字段 AND / 多行取首 / 没匹配保留 / 原值覆盖 / 入口分发

## 可沉淀知识
- [x] 算法引擎纯函数模式：输入 `{scenario, bankRows, gwRows?}` → 输出 `{modifiedRowIds, modifications, warnings}` 是 PR #32 调度的稳定接口；first-match-wins 锁定靠 `modifiedRowIds`，标黄靠 `modifications`，error-report 靠 `warnings`
- [x] PR 切分阈值：单 PR 超过 ~2500 行新代码 + 多个相互关联 UI 组件时，应中途评估是否再切分；纯函数 + 单测的算法层最适合独立 ship
