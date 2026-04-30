# log — v2.1.0-beta.1 单据对账 ReconID 修复模块

| 字段 | 值 |
|---|---|
| 文档版本 | v0.1（draft） |
| 目标版本 | `v2.1.0-beta.1` |
| 关联 PRD | `PRD-v2.1.0-beta.1.md` |
| 关联 spec | `spec.md` |
| 关联 tasks | `tasks.md` |
| 起草日期 | 2026-04-30 |

> 实施过程中的关键决策、风险发现、可沉淀知识。每个里程碑追加一节。

---

## 2026-04-30 PM 回写 4 个 Open Question 决策完成

- **动作**：用户对 4 个 Open Question 给出决策（Q1=A / Q2=A / Q3=C / Q4=部分采纳），PM 角色按决策回写到 PRD-v2.1.0-beta.1.md / spec.md / tasks.md
- **决策摘要**：
  1. **Q1=A** — `lookupReconId` 直读 `row.reconId`（业务/对手账单 sheet 已带正确 reconId 列），删 dry-run fallback 与回查 reconResult 分支
  2. **Q2=A** — R5/R6 SubBizType 自动查 reconResult sheet 未命中 → SubBizType 留空 + warnings 报告，不中断
  3. **Q3=C** — 识读规律颜色冲突 → 取该行"有数据 cell"（cell.value 非 null/非 ''）出现频率最高的色；平票取首次出现色
  4. **Q4=部分采纳** — 单场景模式确认；主页面新增"场景"单选下拉（位置：行 1 「导入文件」与「开始运行」之间；空场景态 disabled；改场景列表后实时刷新；与 run 按钮联动）
- **可追溯标记**：所有修订段落已加 `<!-- 2026-04-30 决策回写：Q? -->` HTML 注释
- **PRD 修订段落**：D6 / D10 / D11 / 6.1 / 6.4 / 7.4 / 8.4 / 12.1 表头 / 14
- **spec 修订段落**：1.1（PR-A 文件 12 → 13）/ 三 `recon-id-fix:run` payload / 5.2.1 / 5.2.3 / 5.3 / 7 / 9.3 / 12
- **tasks 修订段落**：PR-A 总数 8 → 9（新增 A9）/ A3 / A4 / B12 / C1 / 9.3 smoke 5 → 6 用例
- **从 Open Question 移除**：原 spec §12 的 Q1（lookupReconId）和 Q2（颜色冲突）；原 PRD §14 的 SubBizType 未命中边界；保留远期 Q3（多场景批量跑）作未来扩展项
- **下一步**：通知 Dev 启动 PR-A（task A1-A9）；A9 与 A3/A4 强耦合，建议 A3 → A4 → A9 顺序实施

---

## 2026-04-30 PM 落 spec 完成

- **动作**：PM 角色落 v2.1.0-beta.1 三件套（PRD + spec + tasks + log），目录 `docs/iterations/v2.1.0-beta.1/`
- **依据**：用户 5 轮澄清 + 样例 xlsx（`samples/单据对账导出不平.xlsx` / `samples/单据对账导出不平-对平例子.xlsx`）+ v2.0.0-beta.3 三件套样板（PR #29-#33 完整实施路径）
- **关键决策记录**：
  1. 复用 v2.0.0-beta.3 `scenarios` 表，CHECK 约束扩 4 值（migration 走 RENAME-CREATE-INSERT-DROP-COMMIT 重建表）
  2. 新模块**不预置 builtin scenarios**（区别于 v2.0.0-beta.3）
  3. 单场景跑模式（**不复用** `scenario-dispatcher.js`，本模块独立 IO + 引擎）
  4. 输出格式无标黄需求 → **不复用** `exceljs-writer.js`，用 `xlsx-js-style`（已在依赖里）
  5. 资金红线双层防御：完全沿用 v2.0.0-beta.3 PR #33 round 2/3 的 4 IPC 入口主动清 + export 端 snapshot 校验
  6. 识读规律：纯规则（fields-equal mining + 颜色分组），不接大模型
  7. 规则修订（5 轮澄清最后一轮）：1v 多与多 v1 互斥，但 1v1 可与任一另一项共勾
- **证据**：
  - 样例 xlsx 4 sheet 表头确认（业务部门账单 23 列 / 对手部门账单 22 列 / 对账结果 18 列 / 订单修复 15 列）
  - v2.0.0-beta.3 实施路径完整复盘（migrations.js / scenarios-repository.js / scenario-dispatcher.js / bank-statement-io.js / exceljs-writer.js）
  - 当前 v2.0.0 GA package.json version=2.0.0；本迭代版本号 bump 由 PR-D 完成
- **风险**（PRD §十）：
  - 资金红线 ⚠️：错误 Reference 关联 / 错误 SubBizType 取值 / 共同 ID 拼接错位 / 场景配置变更后 stale result 导出
  - 算法稳定性 ⚠️：识读规律误判会污染场景库（缓解：识读仅"自动填表"不"自动落库"）
  - 数据库迁移：CHECK 约束变更需重建表 → 老库无损迁移用例必须覆盖
- **决策**：本三件套作为 v0.1 draft，待用户 review 后定稿；任何用户反馈先回写 PRD/spec/tasks，再开 PR-A
- **下一步**：通知 Dev 开始 PR-A（task A1-A8）；用户确认 spec 可进入实施

---

## 待补：PR-A 启动

- 动作：—
- 证据：—
- 风险：—
- 决策：—

---

## 待补：PR-B 启动

- 动作：—
- 证据：—
- 风险：—
- 决策：—

---

## 待补：PR-C 启动

- 动作：—
- 证据：—
- 风险：—
- 决策：—

---

## 待补：PR-D 启动 + 发版

- 动作：—
- 证据：—
- 风险：—
- 决策：—

---

## 可沉淀知识（持续追加）

### v2.0.0-beta.3 → v2.1.0-beta.1 的"模块同构 + 场景独立"模式

- v2.0.0-beta.3 已在 `scenarios` 表上跑通 3 类（C1/C2/C3）；本迭代加第 4 类（C4）走的是同一张表
- 这种"category 枚举扩 + 单独 dialog factory + 单独引擎 + 单独 IO/writer"的模式可复用到未来更多对账类需求
- 关键约束：CHECK 约束变更必须 RENAME-CREATE-INSERT-DROP-COMMIT 重建表；v2.0.0-beta.3 marker 机制对老库迁移友好（不重 seed）但本迭代 marker 不动
- 如果未来还要扩 C5/C6...，建议：
  - migration 函数命名清晰反映扩到第几类（如 `ensureScenariosCategoryReconIdFix` → `ensureScenariosCategoryV5Foo`）
  - 每加一类 CHECK 都要重建一次表（SQLite 限制）
  - 老库测试：建议 keep 一份"v2.0.0 老库 fixture"在 `samples/` 里，每次扩展都要走一遍

### Defense in depth 双层防御沿用

- v2.0.0-beta.3 PR #33 round 2 + round 3 引入的"IPC 入口主动清 + export 端被动校验 snapshot"模式被本迭代直接复用
- 关键不变：**任何场景配置变更都必须让 stale result 失效**，否则会导致用户改场景后导出还是旧规则的输出（资金红线）
- 实践要求：每个新模块加 IPC 时，**4 个 scenarios:* handler 都要追加新模块的 result 清缓存** + **新 export handler 都要重读 scenario 比对 snapshot**

### 输出 writer 选型

- v2.0.0-beta.3 引入 exceljs 仅为标黄需求；其他 3 模块继续 SheetJS / xlsx-js-style
- 本模块输出无标黄需求 → 用 xlsx-js-style（与 pending-session 一致）
- 教训：**不要为了"统一"强行复用** exceljs-writer.js；它的 API 是为标黄场景设计的，复用反而绕弯
- 选型原则：是否需要 cell 样式（标黄/字体/背景）→ exceljs；普通表格 → xlsx-js-style

### 识读规律的工程化

- "纯规则推断" + "不落库 + 用户必须确认"= 双保险
- 颜色分组（同色同例）依赖用户文件本身已有的视觉标记，工程上易实现（ExcelJS cell.fill）
- fields-equal mining 的全等率阈值默认 0.8，可调（PR-C 实施时如果 fixture 命中率不到 0.8 再下调）
