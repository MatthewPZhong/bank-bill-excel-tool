# Log — v2.0.0-beta.3 PR #32a：调度 + IO 后端

## 2026-04-29 初始

- 动作：落 spec/tasks/log，状态=apply
- 证据：
  - PRD §十二 方案 B：PR #32 = 4+5+6 UI + 7 + 8（调度 + IO + 文档 + bump）
  - 用户 2026-04-29 决策切分：PR #32 → PR #32a（后端）+ PR #32b（前端）
  - PR #29 / #30 / #31 已 merge（main HEAD `b977815a`）
  - PR #31 提供算法稳定接口：`runScenario(scenario, bankRows, gwRows?) → { lockedRowIds, modifications, warnings }`
- 用户决策（2026-04-29 拍板）：
  - **Q1=C**：xlsx 标黄改用 `exceljs`（不 spike SheetJS Free 版）
  - **Q2=B**：切两 PR（后端 + 前端）
  - **Q3=A**：dialog 全做完后一次 Codex review（PR #32b 节奏）
- 风险：
  - **资金红线**：本 PR 是后端"接入 IO 真改字段"的最后一段；first-match-wins 锁机制错位 → 全行错过 / 重复改
  - exceljs 引入新依赖：需评估包大小、跨平台（Windows + macOS）、与 SheetJS 共存风险
  - scope 控制：PR #32a 必须严格"不动前端"，避免切分意义丢失
- 决策：
  - exceljs 仅本模块用，其他 3 模块（statementGenerator / newAccountGenerator / pendingReconciliation）不变（D1）
  - 读入仍用 SheetJS（复用现有 readers.js 成熟解析），exceljs 只负责标黄写出
  - 文件路径独立目录：`bank-statement-process/{date}/`，与现有 `exports/` / `error-reports/` 解耦（D3）
  - `_rowId` 在 import 阶段（F3.1）就生成，算法层 ensureRowId 作为 fallback（D4）
  - C3 启用 + 未导入 gwRows 提示策略：dispatcher 跳过 C3 类，main.js IPC 返回 stats 让 renderer 提示（避免后端塞 dialog 逻辑，Q-A1）
  - modifiedRows 写出时剥离 `_rowId / _modifiedColumns / _hitScenarioName` 内部字段（仅写 originalHeaders 44 列，Q-A2）

## 可沉淀知识（实施后回填）

- [ ] exceljs 与 SheetJS 共存的风险（包冲突 / 共用底层等）
- [ ] exceljs 标黄在 Excel + macOS Numbers + WPS 兼容性
- [ ] first-match-wins 锁机制 + C2 双锁 dispatcher 边界
