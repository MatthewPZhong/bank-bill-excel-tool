# PRD — v2.1.0-beta.1 单据对账 ReconID 修复模块

| 字段 | 值 |
|---|---|
| 文档版本 | v0.1（draft） |
| 目标版本 | `v2.1.0-beta.1` |
| 起始版本 | `v2.0.0`（GA，含 4 大模块：网银账单生成 / 新开账户余额 / 月度 Pending / 银行对账单处理） |
| 起草日期 | 2026-04-30 |
| 起草人 | team-lead（PM 角色） |
| 状态 | draft（待用户 review） |
| 关联文档 | `spec.md` / `tasks.md` / `log.md`（同目录） |
| 关联样例 | `samples/单据对账导出不平.xlsx`（4 sheet：对账结果/业务部门账单/对手部门账单/订单修复） / `samples/单据对账导出不平-对平例子.xlsx`（识读规律 fixture） |
| 涉及模块 | 主页面模块切换 + 新增第 5 模块「单据对账 ReconID 修复」 |
| 依赖 | `scenarios` 表 schema（v2.0.0-beta.3 PR #29 引入）— 需扩 category 枚举 |

---

## 一、需求概述

新增第 5 个业务模块「**单据对账 ReconID 修复**」（与现有 4 模块并列）。

模块职责：导入 4 sheet 的"单据对账导出不平"Excel（结构与样例 `单据对账导出不平.xlsx` 一致），按用户配置的 **C4 类场景**做"主从边单据对账"，对账成功的单据按 7+5 条赋值规则给 `Type` / `Reference` / `SubBizType` 字段赋值，最终写入「订单修复」格式的 15 列 Excel 输出文件。

场景由用户在"场景管理"弹窗 CRUD（与 v2.0.0-beta.3 银行对账单处理模块同构，但 **独立场景库**：`scenarios` 表新增 `category='recon-id-fix'`）。

---

## 二、背景与目标

### 2.1 业务背景

- 用户每月需要"修复"业务部门账单与对手部门账单之间因 OrderID 不一致而产生的对账失败单据
- 当前**手工**操作：先按对账规律找出主从边对应关系（如"主边单据 1 v 1 对应从边单据"、"主边单据 1 v 多对应从边单据"），再按 7+5 条规则手工填 `Type` / `Reference` / `SubBizType` 字段，每月数千行规模，耗时 6-10 小时
- 用户期望：在桌面工具里配置一次"场景规律"后批量自动跑，输出可直接上传到对账系统的「订单修复」表

### 2.2 用户价值

| 维度 | 改善 |
|---|---|
| 时间 | 6-10 小时/月 → 10-20 分钟/月 |
| 准确性 | 手工误填 Reference 风险 → 配置驱动 + 算法保障 |
| 可追溯 | 输出文件按「订单修复」15 列固定格式，可直接走对账下游 |

### 2.3 目标

| 必做 | 不做 |
|---|---|
| ✅ 新模块「单据对账 ReconID 修复」UI（主页面左上角下拉新增第 5 项） | ❌ 改造 v2.0.0 银行对账单处理模块（仅借鉴结构） |
| ✅ 场景管理 CRUD（独立 C4 配置弹窗） | ❌ 跨模块共用场景（C4 不与 C1/C2/C3 互通） |
| ✅ 对账匹配引擎（1v1 / 1v多 / 多v1） + 7+5 赋值规则 | ❌ 实时增量处理（一次性批处理即可） |
| ✅ 单文件导入（4 sheet 标准结构） | ❌ 在原 xlsx 上修改（必须另存为，输出新文件） |
| ✅ 输出文件 = 「订单修复」sheet 15 列 + 命中行 | ❌ 标黄修改格（输出新 sheet，无标黄需求） |
| ✅ 「识读场景规律」按钮：纯规则推断主从边对应关系 | ❌ 大模型接入（明确仅纯规则） |
| ✅ 资金红线测试覆盖（Reference 错误关联会导致单据修复失败） | ❌ 多语言 / 国际化 |

### 2.4 明确不做

- 不再产出 error-report.xlsx（PR-A 范围内不强求；PR-B 引擎再视情况落，纯算法配对失败属正常路径，仅需在状态栏提示）
- 不实现"恢复出厂"内置场景（与 v2.0.0-beta.3 一致：场景由用户从 0 配置；不预置 builtin）
- 不持久化导入的 4 sheet 数据（与 banker statement 模块一致：进程级 session）
- 不复用 v2.0.0-beta.3 的 `bank-statement-io.js` / `exceljs-writer.js`（输出格式不同，本模块输出无标黄）

---

## 三、决策记录

> 用户已确认的决策（来源：本迭代起草前的 5 轮澄清）。

### D1 — 模块入口与命名映射

- 主模块切换下拉新增第 5 项「单据对账 ReconID 修复」`data-module="recon-id-fix"`
- 模块面板复用月度 Pending 风格（4 按钮 + statusBox），按钮命名做"项目内映射"：
  - 月度 Pending 的「规则管理」→ 本模块「**场景管理**」
  - 月度 Pending 的「导入文件」→ 本模块「**导入文件**」（同名）
  - 月度 Pending 的「导出差异」→ 本模块「**导出文件**」
  - 「**开始运行**」按钮（与银行对账单处理模块一致）
- 主页面左上角下拉切换；不在 sidebar 加入口

### D2 — 单据匹配规则（场景配置）

- 三个勾选框：
  - 「主边单据 1 v 1 从边单据」（默认勾）
  - 「主边单据 1 v 多 从边单据」
  - 「主边单据 多 v 1 从边单据」
- **互斥关系**（用户 5 轮澄清最后修订）：仅"1 v 多"与"多 v 1"互斥；"1 v 1"可与任一另一项**共勾**
- **算法语义**：每行先尝试 1v1 匹配；找不到时按勾选回退到 1v多 / 多v1（详见 §七算法）

### D3 — 账单类型动态行（C4 配置弹窗第 3 行）

- 行结构：`[序号] [主/从下拉] [字段下拉] [操作下拉] [值输入框]` + 行级 ❌ 删除
- 下拉 1：单选枚举「主边」「从边」
- 下拉 2（**联动**下拉 1）：
  - 选「主边」→ 枚举 = `samples/单据对账导出不平.xlsx`「业务部门账单」sheet 表头（23 列）
  - 选「从边」→ 枚举 = 「对手部门账单」sheet 表头（22 列）
- 下拉 3：「等于」「不等于」「包含」「不包含」「空值」「非空值」「开头为」（选"空值/非空值"时值输入框消失）
- 同序号下方按钮「新增」：在该序号下加一行（同序号多条 = AND 关系）
- 行底下按钮「新增账单类型」：序号 +1，开始新一组类型

### D4 — 对账字段动态行（C4 配置弹窗第 4 行）

- 行结构：`[序号] [账单类型号下拉1] [字段下拉2（主边）] [vs] [账单类型号下拉3] [字段下拉4（从边）]` + 行级 ❌
- 下拉 1 / 下拉 3：枚举值 = §D3 行 3 已配的"账单类型"序号（1 / 2 / ...）
- 下拉 2（主边字段）：枚举 = 「业务部门账单」sheet 表头（23 列）
- 下拉 4（从边字段）：枚举 = 「对手部门账单」sheet 表头（22 列）
- 行底下按钮「新增」：加一行，序号 +1
- 同序号内多行 = AND；不同序号 = OR（与 v2.0.0-beta.3 C2 一致）

### D5 — 修复结果输出（C4 配置弹窗第 5 行）

#### D5.1 主从边修复模式

- 上侧两个勾选框（互斥）：「主边单据」「从边单据」
- 下侧勾选框「主从边都修复」（勾上后禁用上面两个）

#### D5.2 主从边都修复 — 共同 ID 拼接

- 勾「主从边都修复」后右侧显示：
  - 文本「取」 + 单选下拉（「主边单据 ID」/「从边单据 ID」）+ 文本「加上」 + 输入框 + 文本「作为主从边共同的修复 ID」
- 共同修复 ID = `源端单据.OrderId + 输入框文本`（字符串拼接）
- 共同 ID 写入主、从两边的 Reference 列

#### D5.3 SubBizType 取值规则（三选一互斥）

「主从边都修复」下侧再有一组三选一：

1. 勾选「订单修复表的 SubBizType 值取对应单据在对账结果表里单据子类型」（一段式，自动从对账结果 sheet 查）
2. 文本「主边单据 SubBizType 值」 + 输入框（手填，覆盖主边）
3. 文本「从边单据 SubBizType 值」 + 输入框（手填，覆盖从边）

> 「2」「3」可以同时填写（各管一边）；与「1」三选一（"自动查"互斥于"手填"）。

<!-- 2026-04-30 决策回写：Q2=A（R5/R6 未命中→ SubBizType 留空 + warning，不中断；Q1=A 体现于 R1-R4 Reference 取值描述）-->
### D6 — 7 + 5 条赋值规则（核心业务）

> ⚠️ Q1=A 决策回写（2026-04-30）：R1-R6 / RB1-RB4 中"对账成立的 X 边单据 reconId"统一**直读对方 row 的 reconId 字段**（即"业务部门账单"/"对手部门账单" sheet 已由对账系统填好的 reconId 列）。**不再回查"对账结果" sheet**。  
> ⚠️ Q2=A 决策回写（2026-04-30）：R5/R6 自动查"对账结果" sheet 时若**未命中**（即用 BizType + 主/对手部门单号未匹配到任何行）→ **SubBizType 留空 + 写入 warnings 报告**（warning 含 scenarioName/scenarioId/sourceSide/sourceRowOrderId/code='subBizType-not-found'/message），**不中断本次运行**，该行仍进 fixedRows（仅 SubBizType 列为空字符串）。

#### 主从单边修复（"主边单据"或"从边单据"）— 7 条规则

> 对账成功后给"被修复方"的单据 `Type` / `Reference` 赋值，再补 SubBizType；最终该行 A~O 列复制到「订单修复」sheet 模板。  
> ⚠️ 「订单修复」sheet **没有 BizType 列**，只有 SubBizType 列；用户需求原文里的"BizType 列"在写入「订单修复」时统一指 SubBizType 列。

| 规则号 | 修复方 | 匹配模式 | Type | Reference | 备注 |
|---|---|---|---|---|---|
| R1 | 主边 | 1v1 | `0` | 对账成立的从边单据 `reconId`（来自`对账结果` sheet 同行） | 单笔修复 |
| R2 | 主边 | 多v1 | `2` | 对账成立的从边单据 `reconId` | 多对一聚合 |
| R3 | 从边 | 1v1 | `0` | 对账成立的主边单据 `reconId` | 单笔修复 |
| R4 | 从边 | 1v多 | `0` | 对账成立的主边单据 `reconId` | 反向聚合 |
| R5 | 主边 | + 勾选「订单修复表的 SubBizType 值取对应单据在对账结果表里单据子类型」 | — | — | SubBizType 取自`对账结果` sheet：用主边的 BizType 在「业务类型」列搜索 + 主边 OrderId 在「业务部门单号」列搜索 → 命中行的「业务部门单据子类型」 → 写入主边 SubBizType |
| R6 | 从边 | 同 R5 | — | — | SubBizType 取自`对账结果` sheet：用从边的 BizType 在「业务类型」列搜索 + 从边 OrderId 在「对手部门单号」列搜索 → 命中行的「对手部门单据子类型」 → 写入从边 SubBizType |
| R7 | 主/从 | + 勾选「主边单据 SubBizType 值」/「从边单据 SubBizType 值」输入框 | — | — | 直接覆盖对应主/从边的 SubBizType |

> ⚠️ R5/R6 与 R7 的 SubBizType 互斥（D5.3）：R5/R6 是"自动查"路径；R7 是"手填覆盖"路径；用户在 dialog 上三选一保证不冲突。

#### 主从边都修复 — 5 条规则

> 共同修复 ID = D5.2 拼接结果（`源端单据.OrderId + 输入框文本`）；写入主、从两端的 Reference 列。

| 规则号 | 匹配模式 | 主边 | 从边 | 备注 |
|---|---|---|---|---|
| RB1 | 1v1 | Type=`0` / Reference=共同 ID | Type=`0` / Reference=共同 ID | 双向写 |
| RB2 | 多v1 | Type=`2` / Reference=共同 ID | Type=`0` / Reference=共同 ID | 多边写 2，单边写 0 |
| RB3 | 1v1 | Type=`0` / Reference=共同 ID | Type=`0` / Reference=共同 ID | 同 RB1（用户原文区分主、从触发；执行结果对称，保留语义） |
| RB4 | 1v多 | Type=`0` / Reference=共同 ID | Type=`2` / Reference=共同 ID | 反向多边 |
| RB5 | + SubBizType 取值 | 同 R5/R6/R7 | 同 R5/R6/R7 | 复用主从单边的 SubBizType 路径 |

> 实施时 RB1/RB3 合并实现，差异仅在"哪边触发对账成立的扫描方向"。

### D7 — 「识读场景规律」按钮

- 入口：C4 配置弹窗左下角按钮，**含 tooltip**：
  > 「导入单据不平结果表，表里的"业务部门账单"sheet 和"对手部门账单"sheet 需放入对平结果。多个例子时，需将同一例子的所有单元格颜色置为同色。通过识读对平结果，分析对平规则，分析结果填入账单类型和对账字段里。」
- 工作流程：
  1. 弹文件选择 → 用户选 `单据对账导出不平-对平例子.xlsx`（fixture 已就位）
  2. 读取「业务部门账单」+「对手部门账单」两 sheet
  3. **按底色分组**：同色单元格 = 同一个例子；无色单元格也作为同一例子（默认组）；色组识别由 ExcelJS 解析 cell.fill
  4. 对每个色组主从边各取一行（多行时按"全等"列出现频率排序取代表）
  5. 纯规则推断对应关系：
     - 找主从边间值相等的字段对（候选对账字段）
     - 推断"账单类型"过滤条件（基于该例子主从边各自具有的固定列值）
  6. 自动填入 C4 配置弹窗的"账单类型"和"对账字段"两行；用户可继续编辑
- **明确不接入大模型**：纯规则算法（fields-equal mining + 出现频率排序）

### D8 — 数据持久化

- 复用 v2.0.0-beta.3 已建 `scenarios` 表（PR #29，PRD §8.1）
- 扩展 `scenarios.category` CHECK 约束：从 3 值（`extract-recon-id` / `offset-bill-mark` / `gateway-recon-join`）扩到 4 值，新增 `recon-id-fix`
- ⚠️ **数据库迁移**：CHECK 约束变更必须重建表（SQLite ALTER TABLE 不支持改 CHECK）→ migration `ensureScenariosCategoryReconIdFix(db)` 必须幂等：
  1. 检查 `scenarios` 表 CHECK 约束是否已含 `'recon-id-fix'`（PRAGMA index/sql 解析）
  2. 已含 → no-op
  3. 未含 → 走"重建表 + 复制数据 + drop old"流程（参考 `ensureAccountMappingTemplateSupport` 的 RENAME + INSERT SELECT 模式）
- 配置 JSON 结构（写入 `scenarios.config_json`，详见 §八）
- 不写 marker（与 v2.0.0-beta.3 不同：本模块**不预置 builtin**，无 seed-once 语义）

### D9 — 输出文件

- 文件名：`单据对账修复-YYYYMMDDHHmm-{场景名}.xlsx`（参考 v2.0.0-beta.3 `银行对账单-YYYYMMDDHHmm-处理结果.xlsx` 命名规则；含场景名因为本模块每次只跑 1 个场景，无 first-match-wins）
- 输出 sheet 名：「订单修复」（与样例 sheet 名一致）
- 输出列：A~O 共 15 列 = 「订单修复」sheet 表头（v2.0.0-beta.3 已确认列表，复用即可）
- 路径：`~/Documents/网银账单生成小助手/recon-id-fix/{date}/`（用户另存为可改）
- saveDialog 模式（用户另存为）；空命中场景 → 弹"无修改记录"提示，不生成文件

<!-- 2026-04-30 决策回写：Q4=部分采纳（单场景模式确认 + 主页面新增场景下拉）-->
### D10 — 跑场景的并发模型 + 主页面场景选择下拉（Q4=部分采纳，2026-04-30）

- v2.1.0-beta.1 设计为**每次只跑一个场景**（与 v2.0.0-beta.3 不同：bank-statement 是多场景 first-match-wins，本模块单场景独占）
- 场景管理表勾选"启用"是元数据；运行时由 UI 控制"运行哪个场景"——保留 toggle 仅做识别用
- **运行入口**（Q4 决策）：在**主模块面板**上新增一个"场景"单选下拉（紧邻"开始运行"按钮）：
  - **位置**：主面板（`reconIdFixModulePanel`）控制行 1 右侧——「导入文件」按钮和「开始运行」按钮之间
  - **枚举值**：`scenarios` 表中 `category='recon-id-fix'` 的全部场景（不论 enabled）
  - **显示**：每项 `{name}`（不显示 priority，本模块运行时不参与排序）
  - **默认值**：`null`（下拉显示"请选择场景"占位）
  - **场景列表为空时**：下拉禁用 + placeholder 文案"请先在场景管理中创建场景"
  - **改动响应**：场景管理 dialog 完成（create/update/delete/toggle）后必须**实时刷新**下拉列表
  - **联动「开始运行」按钮**：下拉未选 → 「开始运行」disabled；选了 → 启用（与 spec §七 按钮可用性表合并）
  - **`recon-id-fix:run` IPC payload**：「开始运行」点击时取下拉当前选中值作为 `scenarioId` 传给 main 进程
- 不再使用"场景管理表内的'运行'按钮"作为入口（早期方案废止；以主面板下拉为唯一入口）

<!-- 2026-04-30 决策回写：Q4=部分采纳（行 1 右侧加"场景"下拉）-->
### D11 — UI 布局细节（参考月度 Pending）

- 主面板（`reconIdFixModulePanel`）控制行：
  - 行 1：左 ▶「场景管理」/ 右 ▶「导入文件」 **「场景：[下拉选择▼]」（Q4 新增，2026-04-30）** 「开始运行」
  - 行 2：左 ▶「导出文件」/ 右 ▶ statusBox
- **「场景」下拉**（Q4 决策细节）：
  - 控件 id：`reconIdFixScenarioSelect`
  - 枚举值：`scenarios` 表中 `category='recon-id-fix'` 全部场景的 `{id, name}`
  - 默认值：未选（占位"请选择场景"）
  - 空场景：下拉 disabled，placeholder = "请先在场景管理中创建场景"
  - 与「开始运行」按钮联动：下拉未选 → 按钮 disabled
  - 改场景列表（场景管理 dialog 关闭后）→ 渲染层主动 reload 下拉
- 状态栏文案：
  - 初始：「请先点击"场景管理"配置场景，再选择场景并导入文件」
  - 已配场景未导入：「已选场景"{scenarioName}"，请点击"导入文件"」
  - 已导入未运行：「已导入 {fileName}（{rowCount} 行业务账单 / {rowCount} 行对手账单）；请点击"开始运行"」
  - 已运行：「场景"{scenarioName}"运行完成；命中 {N} 行修复，{warningCount} 行警告」
  - 已导出：「已导出 {fileName}」

---

## 四、代码现状（必须有出处）

| 主题 | 文件:行 | 现状 |
|---|---|---|
| 模块切换状态机 | `src/renderer.js`（搜 `MODULES` / `setCurrentModule`） | 现有 4 模块（statementGenerator / newAccountGenerator / pendingReconciliation / bankStatementProcess）；本次扩第 5 个 |
| 模块下拉菜单 | `index.html:41-44` | 4 个 `<button class="module-option">`；本次新增 1 项 `data-module="recon-id-fix"` |
| 模块面板 | `index.html:185+` | `bankStatementModulePanel` 现成，4 按钮 + statusBox 模板可 fork |
| 模块持久化 | `src/backend/database/settings-repository.js:95` | `CURRENT_MODULE_VALID` 含 4 项（含 `'bank-statement-process'`）；需追加 `'recon-id-fix'` |
| 场景表 schema | `src/backend/database/migrations.js:391-459 ensureScenariosSupport` | CHECK `category IN (3 值)`；需扩到 4 值，走重建表迁移 |
| 场景 repository | `src/backend/database/scenarios-repository.js:11-15 VALID_CATEGORIES` | 数组 3 个值；需追加 `'recon-id-fix'` |
| 场景 IPC | `src/main.js:2710-2765` | 6 个 channel（list/get/create/update/delete/toggle）；可直接复用，无需新增 |
| 场景管理 dialog | `src/renderer-dialogs.js:5381 createScenariosManagerDialog` | 已支持渲染任意 category；新增 C4 时只需在"分类显示名"映射加一项 |
| 类别选择 dialog | `src/renderer-dialogs.js:5525 createScenarioCategorySelectDialog` | 三选一下拉；需扩四选一 + 新分类显示名 |
| 4 类配置 dialog 路由 | `src/renderer-dialogs.js:65-67` | `if (category === 'extract-recon-id') ... C1/C2/C3`；需加 `'recon-id-fix' → createScenarioConfigDialogC4` |
| 字段常量 | `src/constants/bank-statement-fields.js`（v2.0.0-beta.3 PR #31） | 已 ship 银行/网关字段；本次需新增 `src/constants/recon-id-fix-fields.js`（4 sheet 表头） |
| 引擎调度 | `src/main-process/scenario-dispatcher.js` | first-match-wins 调度；本模块单场景跑 → **不复用**，独立 dispatcher（详见 §spec） |
| 算法引擎 | `src/main-process/scenario-engines/c1.../c2.../c3...` | C1/C2/C3 已 ship；本次新增 `c4-recon-id-fix.js` |
| writer | `src/main-process/exceljs-writer.js` | 标黄 + 4 列 error-report；输出格式不同 → **不复用**，新增 `recon-id-fix-writer.js`（无标黄；写「订单修复」sheet 15 列） |
| IO 层 | `src/main-process/bank-statement-io.js` | 44 列校验 + 单 sheet；本模块需 4 sheet 校验 → 新增 `recon-id-fix-io.js` |
| Preload | `src/preload.js`（搜 `scenarios` / `bankStatement`） | 已暴露 6 + 5 个 channel；本次需暴露新 4 个 IPC（recon-id-fix:*） |

---

## 五、术语

| 术语 | 含义 |
|---|---|
| **场景（Scenario）** | 用户配置的一条 C4 规则；含名称 / 优先级（保留兼容字段，本模块运行时不参与排序） / 单据匹配规则 / 账单类型 / 对账字段 / 修复结果输出 |
| **C4 类** | 第 4 大类场景；`category='recon-id-fix'`；与 v2.0.0 C1/C2/C3 互不重叠 |
| **主边 / 从边** | 业务部门账单 = 主边；对手部门账单 = 从边（基于业务语义命名） |
| **账单类型（Bill Type）** | C4 配置中"主/从 + 字段+操作+值"组合标记的虚拟分组；同序号多行 = AND |
| **对账字段（Recon Field）** | C4 配置中"主边某账单类型 vs 从边某账单类型 + 字段对"；同序号多行 = AND，不同序号 = OR |
| **共同修复 ID** | 主从边都修复时 = "源端单据 OrderId + 输入框文本"的拼接 |
| **reconId** | 「对账结果」sheet 的 `reconId` 列；R1-R6 时 Reference 取此值 |
| **识读规律** | 纯规则算法从对平例子 xlsx 推断出"账单类型"和"对账字段"配置 |
| **A~O 列** | 「订单修复」sheet 的 15 列固定列名（详见 §八） |

---

## 六、功能清单

<!-- 2026-04-30 决策回写：Q4=部分采纳（行 1 加场景下拉）-->
### 6.1 主页面 (F1)

- **F1.1 模块切换**：模块下拉新增"单据对账 ReconID 修复"项
- **F1.2 模块面板**：fork `bankStatementModulePanel` 结构
  - 控制行 1：左 ▶「场景管理」/ 右 ▶「导入文件」 **「场景：[下拉▼]」（Q4 新增）** 「开始运行」
  - 控制行 2：左 ▶「导出文件」/ 右 ▶ statusBox
- **F1.3 场景下拉**（Q4 新增，2026-04-30）：
  - 枚举：`scenarios` 表 `category='recon-id-fix'` 全部
  - 默认未选；改后实时联动「开始运行」按钮
  - 场景管理 dialog 关闭后必须 reload 下拉
  - 详见 D10 / D11
- **F1.4 文案**：见 D11

### 6.2 场景管理弹窗 (F2)

- 复用 v2.0.0-beta.3 `createScenariosManagerDialog`，"功能类别"列文案映射加 `'recon-id-fix' → '单据对账修复'`
- 新增"运行"文字按钮（D10）：未启用时灰；启用时跳到主面板"开始运行"前置条件检查

### 6.3 新增场景流程 (F3)

#### F3.1 类别选择弹窗
- 现有三选一扩四选一；新增项「单据对账 ReconID 修复」
- 选中后跳到 F3.4 C4 配置弹窗

#### F3.2-F3.3 沿用 v2.0.0-beta.3 C1/C2/C3 配置弹窗

不变。

#### F3.4 C4 配置弹窗（**新**，详见 §七.1）

5 行 + 1 个识读按钮 + 完成按钮。

#### F3.5 确认场景详情弹窗

复用 `createScenarioConfirmDetailDialog` ，新增 C4 类的文本预览模板（详见 §七.2）。

<!-- 2026-04-30 决策回写：Q4=部分采纳（F4.2 取主面板下拉作为 scenarioId）-->
### 6.4 导入与运行 (F4)

- **F4.1 导入文件**：弹文件选择 → 校验 4 sheet 必须包含「对账结果」「业务部门账单」「对手部门账单」（「订单修复」sheet 仅取表头模板，不强校验有数据）→ 缓存到 main 进程 session
- **F4.2 开始运行**：取**主面板"场景"下拉**当前选中值作为 scenarioId（Q4 决策，2026-04-30）→ 触发 C4 引擎（详见 §七.3）→ 输出预备好 → 启用"导出文件"
- **F4.3 导出文件**：弹"另存为"→ 写「订单修复」sheet 15 列 + 命中行
  - 空运行结果（0 行命中）→ 弹提示，不生成文件

### 6.5 内置场景 (F5)

**本模块不预置 builtin**（区别于 v2.0.0-beta.3）。用户从 0 配置；migration 层不写 marker。

---

## 七、详细设计

### 7.1 C4 配置弹窗 — 5 行 + 识读按钮

#### 行 1：场景名称

| 控件 | 验证 |
|---|---|
| 输入框 | 非空 + 全局唯一（`scenarios.name` UNIQUE） |

> 优先级字段保留为 0（隐藏，本模块运行时不参与排序），与现有 schema 兼容；后续若用户提"批量跑多场景"再启用。

#### 行 2：单据匹配规则（3 个勾选框）

| 勾选项 | 互斥关系 |
|---|---|
| 主边单据 1 v 1 从边单据 | 与"1 v 多"或"多 v 1"可共勾 |
| 主边单据 1 v 多 从边单据 | 与"多 v 1"互斥 |
| 主边单据 多 v 1 从边单据 | 与"1 v 多"互斥 |

至少勾 1 项；UI 校验。

#### 行 3：账单类型（动态行，详见 §三 D3）

#### 行 4：对账字段（动态行，详见 §三 D4）

#### 行 5：修复结果输出（详见 §三 D5）

#### 识读按钮

- 左下角按钮「识读场景规律」+ tooltip（详见 §三 D7）
- 点击 → 文件选择器（默认 fixture 路径） → 弹"识读中"→ 识读完成后回填行 3 + 行 4

### 7.2 确认场景详情弹窗（C4 文本预览）

```
场景名称：{name}
匹配规则：{1v1 / 1v多 / 多v1 三选一/共选}
账单类型：
  类型 1：{主/从 字段=值 AND 字段≠值 ...}
  类型 2：{...}
对账字段：
  类型 1.字段A vs 类型 2.字段B AND ...
修复输出：
  方向：{主边 / 从边 / 主从}
  共同 ID：{取主/从 OrderId + "{文本}"}（仅"主从"时显示）
  SubBizType 取值：{自动查 / 主边手填="x" / 从边手填="y"}
```

### 7.3 C4 算法引擎

`runC4Scenario(scenario, sheets) → { fixedRows: Array, warnings: Array }`

- `sheets`：`{ reconResult, businessBills, opponentBills, fixTemplate }`（PR-B 实现 4 sheet 解析后传入）
- `fixedRows`：每条 = 完成 7+5 规则赋值后的"准备写入「订单修复」"的对象（A~O 列已填）
- `warnings`：配对失败、对账结果 sheet 查 SubBizType 失败、SubBizType 已有值被覆盖等

#### 7.3.1 算法主流程（伪代码）

```
function runC4Scenario(scenario, sheets):
    cfg = scenario.config
    matchRules = cfg.matchRules   // {oneToOne, oneToMany, manyToOne}
    billTypes = cfg.billTypes     // [ {seq, side, conditions: [{field, op, value}]} ]
    reconFields = cfg.reconFields // [ {seq, leftTypeSeq, leftField, rightTypeSeq, rightField} ]
    output = cfg.output           // {mode: 'main'|'opp'|'both', commonId?, subBizType: {...}}

    // 1. 按 billTypes 给主从边分类
    classifyBySide('main', sheets.businessBills, billTypes)
    classifyBySide('opp',  sheets.opponentBills,  billTypes)

    fixedRows = []
    warnings = []

    // 2. 遍历每个主边账单类型与每个从边账单类型对（按 reconFields 序号关联）
    for typePair in distinctPairs(reconFields):
        leftRows  = sheets.businessBills.filter(r => r._types.has(typePair.leftTypeSeq))
        rightRows = sheets.opponentBills.filter(r => r._types.has(typePair.rightTypeSeq))
        leftReconFields  = reconFields.filter(rf => rf.leftTypeSeq === typePair.leftTypeSeq)
        rightReconFields = leftReconFields  // 同序号一组 AND；不同序号已分到不同 typePair

        // 3. 三阶尝试：先 1v1 → 失败按勾选回退到 1v多 / 多v1
        for leftRow in leftRows:
            matched = rightRows.filter(r => andEquals(leftRow, r, leftReconFields))
            if matchRules.oneToOne and matched.length === 1:
                applyAssignment_1v1(leftRow, matched[0], scenario, output, sheets.reconResult, fixedRows, warnings)
                continue
            if matchRules.oneToMany and matched.length > 1:
                applyAssignment_1vN(leftRow, matched, scenario, output, sheets.reconResult, fixedRows, warnings)
                continue
            // 多v1：反向找
            if matchRules.manyToOne:
                for r in rightRows:
                    leftCandidates = leftRows.filter(l => andEquals(l, r, leftReconFields))
                    if leftCandidates.length > 1:
                        applyAssignment_Nv1(leftCandidates, r, scenario, output, sheets.reconResult, fixedRows, warnings)
            // 都不命中：warnings.push(...)，row 不进 fixedRows

    return { fixedRows, warnings }
```

#### 7.3.2 7 条规则映射函数（主从单边修复）

```
function applyAssignment_1v1(leftRow, rightRow, scenario, output, reconResult, fixedRows, warnings):
    if output.mode === 'main':
        // R1: 主边 + 1v1
        const reconId = lookupReconId(reconResult, rightRow.OrderId, side='right')
        const subBizType = resolveSubBizType('main', leftRow, output.subBizType, reconResult)
        fixedRows.push(buildOutputRow(leftRow, { Type: 0, Reference: reconId, SubBizType: subBizType }))
    else if output.mode === 'opp':
        // R3: 从边 + 1v1
        const reconId = lookupReconId(reconResult, leftRow.OrderId, side='left')
        const subBizType = resolveSubBizType('opp', rightRow, output.subBizType, reconResult)
        fixedRows.push(buildOutputRow(rightRow, { Type: 0, Reference: reconId, SubBizType: subBizType }))
    // 'both' 走 RB1（详见下面）
```

R2/R4 (1v多 / 多v1) 类似，Type=2 切换：

- R2: 主边 + 多v1 → 多个主边的 Reference = 同一个从边的 reconId; Type=2
- R4: 从边 + 1v多 → 多个从边的 Reference = 同一个主边的 reconId; Type=0

R5/R6 (SubBizType 自动查)：
```
function resolveSubBizType(side, row, subCfg, reconResult):
    if subCfg.mode === 'auto':
        // R5/R6
        const matched = reconResult.filter(rr =>
            rr.业务类型 === row.BizType
            && (side === 'main' ? rr.业务部门单号 === row.OrderId : rr.对手部门单号 === row.OrderId)
        )
        if matched.length === 0: warnings.push({...}); return ''
        return side === 'main' ? matched[0].业务部门单据子类型 : matched[0].对手部门单据子类型
    if subCfg.mode === 'manualMain' and side === 'main': return subCfg.mainValue
    if subCfg.mode === 'manualOpp' and side === 'opp':   return subCfg.oppValue
    return ''
```

#### 7.3.3 5 条规则映射函数（主从都修复）

```
function applyAssignment_both_1v1(leftRow, rightRow, scenario, output, reconResult, fixedRows, warnings):
    // RB1
    const commonId = computeCommonId(leftRow, rightRow, output.commonId)
    const leftSub  = resolveSubBizType('main', leftRow,  output.subBizType, reconResult)
    const rightSub = resolveSubBizType('opp',  rightRow, output.subBizType, reconResult)
    fixedRows.push(buildOutputRow(leftRow,  { Type: 0, Reference: commonId, SubBizType: leftSub }))
    fixedRows.push(buildOutputRow(rightRow, { Type: 0, Reference: commonId, SubBizType: rightSub }))

function computeCommonId(leftRow, rightRow, commonIdCfg):
    const src = commonIdCfg.source === 'main' ? leftRow.OrderId : rightRow.OrderId
    return src + (commonIdCfg.suffix || '')
```

RB2 (多v1)：多个 leftRow → Type=2；rightRow → Type=0；都用同一 commonId（基于 cfg.commonId.source 取的那一边的代表行）。

RB4 (1v多)：1 个 leftRow → Type=0；多个 rightRow → Type=2；commonId 同上。

#### 7.3.4 buildOutputRow

```
function buildOutputRow(srcRow, overrides):
    const orderRepairCols = [
      'BillDate','Bank','MerchantId','OrderId','DataSource','OppBu','OriginBillSource',
      'BillType','Type','Reference','Currency','Amount','OriginBillBizId','ReconBillBizId','SubBizType'
    ]
    const out = {}
    for (col of orderRepairCols):
        if col in overrides: out[col] = overrides[col]
        else: out[col] = srcRow[col] ?? ''
    return out
```

> ⚠️ 「业务部门账单」/「对手部门账单」sheet 都有 `BizType` 列（第 15 列）；「订单修复」sheet 没有 BizType 列，只有 SubBizType（第 15 列）。复制时要注意别把 BizType 误写到 SubBizType；srcRow 的 BizType 不进入 output。R5/R6 用 BizType 是用作"反查 reconResult"的输入，不出现在 output。

<!-- 2026-04-30 决策回写：Q3=C（颜色冲突取"有数据 cell"的最高频色）-->
### 7.4 识读规律算法（PR-C）

```
function inferRules(sampleFile):
    1. 读取「业务部门账单」+「对手部门账单」sheet（含 cell.fill 颜色）
    2. groupByColor:
       - 同色 cell 出现的整行算一个例子
       - 同一行多色（罕见）→ Q3=C 决策（2026-04-30）：
           a) 仅统计该行"有数据的 cell"（cell.value 非 null 且非空字符串）
           b) 在这些 cell 中按 ARGB 出现次数 desc 排序，取最高频色作为行色
           c) 平票（多色 count 并列最高）→ 取第一个出现的色
       - 无色 → 全部归到 'no-color' 组
    3. 对每组内主从边各取代表行：
       - 主边 = businessBills 中属于该组的所有行
       - 从边 = opponentBills 中属于该组的所有行
    4. 候选对账字段挖掘（fields-equal mining）：
       - 对每个 (mainField, oppField) 二元组（mainField ∈ businessBills 表头，oppField ∈ opponentBills 表头）
       - 计算"该组内有多少行 mainRow.mainField === oppRow.oppField"
       - 跨组聚合：求该字段对在所有色组的"全等率"
       - 取全等率 ≥ 0.8 的字段对作为候选对账字段
    5. 候选账单类型挖掘：
       - 对每个色组，找"主边/从边内固定取值"的字段（该字段在该组内所有行都同值，且全局所有组中只在本组取该值）
       - 这些字段-值对作为该组的"账单类型 conditions"
    6. 输出 inferred config（账单类型 + 对账字段）→ 回填到 C4 配置 dialog
    
    边界处理：
    - 候选 < 1 → 抛"识读失败：未找到稳定的对账字段"
    - 候选 ≥ 5 → 取 top 4，提示用户"识读出 5+ 候选，已取 top 4，请人工裁剪"
```

> 算法纯规则，不接大模型。

### 7.5 主输出文件名规则

`{prefix}-{timestampMinute}-{scenarioName}.xlsx`，其中：
- `prefix` = `'单据对账修复'`
- `timestampMinute` = `YYYYMMDDHHmm`（12 位）
- `scenarioName` = sanitized `scenario.name`（参考 v2.0.0-beta.3 `sanitizeFileName`，跨平台）

---

## 八、数据模型

### 8.1 SQLite schema

`scenarios` 表已在 v2.0.0-beta.3 PR #29 创建。本迭代仅扩展 CHECK 约束。

```sql
-- 现有：CHECK (category IN ('extract-recon-id', 'offset-bill-mark', 'gateway-recon-join'))
-- 新增：CHECK (category IN ('extract-recon-id', 'offset-bill-mark', 'gateway-recon-join', 'recon-id-fix'))
```

⚠️ **数据库迁移红线**：
- SQLite 不支持 ALTER TABLE 改 CHECK 约束 → 必须重建表
- migration 函数 `ensureScenariosCategoryReconIdFix(db)` 须满足：
  1. 检查现有 `scenarios` 表 CHECK 是否已含 `'recon-id-fix'`（解析 `sqlite_master.sql` 字符串）
  2. 已含 → no-op
  3. 未含 → BEGIN → RENAME old → CREATE new with new CHECK → INSERT INTO new SELECT ... FROM old → DROP old → COMMIT
- 已有数据保留：v2.0.0-beta.3 用户的 3 内置场景（如未删）必须无损迁移到新表
- 迁移期间不破坏 UNIQUE(name) 约束
- `scenarios-repository.js: VALID_CATEGORIES` 同步追加 `'recon-id-fix'`

### 8.2 C4 场景 config_json 结构

```json
{
  "matchRules": {
    "oneToOne": true,
    "oneToMany": false,
    "manyToOne": false
  },
  "billTypes": [
    {
      "seq": 1,
      "side": "main",
      "conditions": [
        { "field": "BillType", "op": "等于", "value": "业务订单" }
      ]
    },
    {
      "seq": 2,
      "side": "opp",
      "conditions": [
        { "field": "OriginBillSource", "op": "等于", "value": "rcpt_inbound" }
      ]
    }
  ],
  "reconFields": [
    {
      "seq": 1,
      "leftTypeSeq": 1,
      "leftField": "Currency",
      "rightTypeSeq": 2,
      "rightField": "Currency"
    },
    {
      "seq": 2,
      "leftTypeSeq": 1,
      "leftField": "Amount",
      "rightTypeSeq": 2,
      "rightField": "Amount"
    }
  ],
  "output": {
    "mode": "both",
    "commonId": {
      "source": "main",
      "suffix": "-FIX"
    },
    "subBizType": {
      "mode": "auto",
      "mainValue": null,
      "oppValue": null
    }
  }
}
```

字段语义：
- `matchRules`：3 个 boolean，至少 1 个 true
- `billTypes[i].side`：`'main'` / `'opp'`
- `billTypes[i].conditions[j].op`：复用 v2.0.0-beta.3 7 个 op 枚举
- `output.mode`：`'main'` / `'opp'` / `'both'`
- `output.commonId`（仅 mode='both' 用）：`source ∈ {'main', 'opp'}`，`suffix` 字符串
- `output.subBizType.mode`：`'auto'`（R5/R6 自动查）/ `'manualMain'` / `'manualOpp'` / `'manualBoth'`（兼容用户同时填两个手填框）

### 8.3 in-memory session（main 进程）

```js
state.reconIdFixSession = {
  filePath: '/path/to/单据对账导出不平.xlsx',
  fileName: '...',
  sheets: {
    reconResult: [...],   // 「对账结果」sheet 的对象数组
    businessBills: [...], // 「业务部门账单」sheet 的对象数组
    opponentBills: [...], // 「对手部门账单」sheet 的对象数组
    fixTemplate: { headers: [15 列], rows: [] }  // 「订单修复」sheet 表头模板
  },
  importedAt: ...
}

state.reconIdFixResult = {  // 运行后产生
  scenarioId: ...,
  scenarioName: ...,
  fixedRows: [...],
  warnings: [...],
  scenariosSnapshot: '...',  // defense in depth（参考 v2.0.0-beta.3 PR #33 round 3）
  ranAt: ...
}
```

<!-- 2026-04-30 决策回写：Q2=A（SubBizType 列在 R5/R6 自动查未命中时为 '' 字符串，行仍写入）-->
### 8.4 「订单修复」sheet 列结构（A~O 共 15 列，按样例确认）

| 序 | 列名 | 说明 |
|---|---|---|
| 1 | BillDate | 账单日期，复制自源 row |
| 2 | Bank | 银行，复制 |
| 3 | MerchantId | 商户号，复制 |
| 4 | OrderId | 订单号，复制 |
| 5 | DataSource | 数据源，复制 |
| 6 | OppBu | 对手部门，复制 |
| 7 | OriginBillSource | 原始账单来源，复制 |
| 8 | BillType | 账单类型，复制 |
| 9 | **Type** | **修复字段**（R1-R4 / RB1-RB4 写 0 或 2） |
| 10 | **Reference** | **修复字段**（R1-R4 写 reconId；RB1-RB4 写共同 ID） |
| 11 | Currency | 币种，复制 |
| 12 | Amount | 金额，复制 |
| 13 | OriginBillBizId | 原始账单业务 ID，复制 |
| 14 | ReconBillBizId | 对账账单业务 ID，复制 |
| 15 | **SubBizType** | **修复字段**（R5/R6 自动查 / R7 手填覆盖） |

> ⚠️ 9/10/15 = 修复方有写入；其余复制源行的同名列。  
> ⚠️ 源行有 BizType（业务类型）但 output 不含 BizType 列；只有用作 R5/R6 查 reconResult 的入参。  
> ⚠️ R5/R6 自动查未命中 → SubBizType 列写空字符串 `''`，该行仍写入 fixedRows（不中断）；warnings 增一条 `code='subBizType-not-found'`。R7 手填路径不受影响（直接覆盖）。

---

## 九、IPC 接口

复用 v2.0.0-beta.3 的 6 个 `scenarios:*` channel（无需扩，仅 category 枚举多一个）。新增 4 个 `recon-id-fix:*` channel：

| Channel | 方向 | Payload | 返回 |
|---|---|---|---|
| `scenarios:list` | renderer→main | — | `[{id, category, name, priority, enabled}]` （已支持 C4） |
| `scenarios:get` | renderer→main | `{id}` | 含 config（C4 时为 §8.2 结构） |
| `scenarios:create` | renderer→main | `{category: 'recon-id-fix', name, priority, enabled, config}` | `{status, id}` |
| `scenarios:update` | renderer→main | `{id, ...}` | `{status}` |
| `scenarios:delete` | renderer→main | `{id}` | `{status}` |
| `scenarios:toggle-enabled` | renderer→main | `{id, enabled}` | `{status}` |
| **`recon-id-fix:import`** | renderer→main | — | `{status, fileName, sheetCounts: {recon, business, opp}}` |
| **`recon-id-fix:run`** | renderer→main | `{scenarioId}` | `{status, stats: {fixedRowCount, warningCount}}` |
| **`recon-id-fix:export`** | renderer→main | `{savePath?}` | `{status, mainFilePath, errorReportPath?}` |
| **`recon-id-fix:session-status`** | renderer→main | — | `{hasFile, hasResult, ...}` |
| **`recon-id-fix:infer-rules`** | renderer→main | `{sampleFilePath}` | `{status, billTypes: [...], reconFields: [...]}` |

---

## 十、风险

### 10.1 ⚠️ 资金红线（最高优先级）

| 风险 | 等级 | 缓解 |
|---|---|---|
| **错误 Reference 关联导致单据修复失败** | 资金红线（最高） | 单测 + 集成测试覆盖 7+5 全规则；用户用样例文件回归；R5/R6 SubBizType 查不到时**必须**走 warning + 不进 fixedRows，绝不自动 fallback |
| **多v1 / 1v多 时 Reference 写错单据** | 资金红线 | applyAssignment_NvN 必须严格区分"被聚合方" vs "聚合源"；单测覆盖正反向 |
| **共同修复 ID 拼接错位**（取主边但应取从边的 OrderId） | 资金红线 | computeCommonId 单测；C4 配置弹窗 commonId.source 默认值要明示 |
| **场景配置变更后旧 result 被导出** | 资金红线 | 复用 v2.0.0-beta.3 PR #33 round 2/3 的 snapshot 双层防御：scenarios:* IPC 入口主动清 + export 端被动校验 snapshot |

### 10.2 ⚠️ 算法稳定性（识读规律）

| 风险 | 等级 | 缓解 |
|---|---|---|
| **识读规律误判会污染场景库** | 高 | 识读 = 仅"自动填表"不"自动落库"；用户必须点"完成"才落 DB；UI 明示"以下规则由识读推断，请检查后保存" |
| 候选字段全等率阈值（0.8）误命中 | 中 | tasks 中要求验证 fixture 文件，必要时提高阈值或要求用户人工确认 |
| 同色单元格识别（cell.fill）跨平台一致性 | 中 | ExcelJS 解析 fill；单测覆盖空 fill / pattern fill / theme color 三种格式 |

### 10.3 数据库迁移

| 风险 | 等级 | 缓解 |
|---|---|---|
| CHECK 约束变更需重建表 → 数据丢失 | 高 | migration 函数严格 BEGIN-INSERT-DROP-COMMIT；空表测 + 含数据测 |
| migration 重复执行（用户多次启动）→ 重建表多次 | 中 | 解析 sqlite_master.sql 判断"已含 'recon-id-fix'"即 no-op；幂等 |
| v2.0.0-beta.3 builtin scenarios 在迁移中丢 | 高 | INSERT INTO new SELECT * FROM old；测试用例覆盖 |

### 10.4 兼容性

- 不影响现有 4 模块（statementGenerator / newAccountGenerator / pendingReconciliation / bankStatementProcess）
- 不修改现有 IPC channels（仅新增）
- v2.0.0-beta.3 已有的 builtin scenarios（如未删）继续可见可编辑

---

## 十一、PR 拆分

按用户已对齐的 4 个 PR 切分。每个 PR 都跑 `check-vars` + `smoke` + `preview`。

| PR | 内容 | 工作量估 | 状态 |
|---|---|---|---|
| **PR-A 骨架** | 模块入口 + 模块面板 + 场景管理 CRUD（C4 配置弹窗 + 类别选择四选一）+ SQLite migration（CHECK 扩） + 持久化 + 4 IPC（recon-id-fix:import 占位）| 2-3 天 | 待启动 |
| **PR-B 对账引擎** | 4 sheet IO + C4 引擎（3 阶配对 + 7+5 规则）+ writer（15 列输出）+ "开始运行"/"导出文件"接通 + warnings → status 文案 | 4-5 天 | 待启动 |
| **PR-C 识读规律** | 「识读场景规律」按钮 + ExcelJS cell.fill 解析 + fields-equal mining + 自动填表 | 1.5-2 天 | 待启动 |
| **PR-D 收尾** | USER_GUIDE / VERSION_FEATURE_HISTORY / CHANGELOG 三件套 + 整体 smoke + 版本号 bump（`2.0.0` → `2.1.0-beta.1`） | 1 天 | 待启动 |

总工作量约 8.5-11 天。

---

## 十二、手动测试清单

<!-- 2026-04-30 决策回写：Q2=A（P0-7 行已对齐"留空 + warning + 不中断"语义）-->
### 12.1 P0 必测场景（资金红线）

| ID | 场景 | 操作 | 期望 |
|---|---|---|---|
| P0-1 | 主边 1v1 修复 | 导样例文件 + 配 C4 场景（mode=main, oneToOne）+ 运行 + 导出 | 主边命中行 Type=0 / Reference=对应从边 reconId / SubBizType 按 R5 自动查命中 |
| P0-2 | 主边 多v1 | mode=main, manyToOne | 多个主边 Reference = 同一从边 reconId / 都是 Type=2 |
| P0-3 | 从边 1v多 | mode=opp, oneToMany | 多个从边 Reference = 同一主边 reconId / 都是 Type=0 |
| P0-4 | 主从都修复 1v1 | mode=both, oneToOne, commonId.source=main, suffix='-FIX' | 主从两行 Reference 都 = 主边 OrderId+'-FIX'，Type 都=0 |
| P0-5 | 主从都修复 多v1 | mode=both, manyToOne, commonId.source=main | 多主边 Type=2 / 1 从边 Type=0 / Reference 全 = 主边代表行 OrderId+suffix |
| P0-6 | SubBizType 自动查命中 | output.subBizType.mode=auto | 主边 SubBizType=对账结果."业务部门单据子类型"；从边 SubBizType=对账结果."对手部门单据子类型" |
| P0-7 | SubBizType 自动查未命中 | output.subBizType.mode=auto，但对账结果 sheet 无对应行 | warnings 含一条；该行进 fixedRows 但 SubBizType='' |
| P0-8 | SubBizType 手填覆盖 | output.subBizType.mode=manualBoth, mainValue='X', oppValue='Y' | 主边 SubBizType='X'；从边 SubBizType='Y'；不查对账结果 |
| P0-9 | 场景配置变更后导出 | 运行后改场景再导出 | 拒绝，提示"场景已变更，请重新点击运行" |
| P0-10 | 空命中导出 | 全部行配对失败 | 弹"无修复记录"，不生成主输出文件 |

### 12.2 P1 应测场景

| ID | 场景 |
|---|---|
| P1-1 | 场景管理 CRUD（C4 类别新增/编辑/删除）|
| P1-2 | 类别选择四选一 UI 正确显示 4 项 |
| P1-3 | 数据库迁移：v2.0.0-beta.3 老库（含 3 builtin）启动后 builtin 仍可见 |
| P1-4 | 数据库迁移：空库启动后 CHECK 含 4 值 |
| P1-5 | 进程重启后 C4 场景仍存在；session 数据丢失 |
| P1-6 | 文件不含「对账结果」sheet → FileValidationError |
| P1-7 | 文件含 4 sheet 但「业务部门账单」表头错位 → 列校验失败 |
| P1-8 | 1v多 + 多v1 互斥 UI 校验 |
| P1-9 | 至少勾 1 个匹配规则才能保存 |

### 12.3 P2 识读规律场景（PR-C）

| ID | 场景 |
|---|---|
| P2-1 | 识读 fixture（`单据对账导出不平-对平例子.xlsx`）→ 推断对应账单类型 + 对账字段 |
| P2-2 | 识读结果回填 dialog 行 3 + 行 4 |
| P2-3 | 识读失败（候选 < 1）→ 提示 |

### 12.4 不测项与原因

- 模块切换 UI 已在 v2.0.0 多次回归
- 模块持久化已在 v2.0.0-beta.2 PR #27 测过
- `scenarios:*` 6 IPC 已在 v2.0.0-beta.3 PR #29 测过

---

## 十三、非功能性要求

| 类别 | 要求 |
|---|---|
| 向下兼容 | v2.0.0-beta.3 用户的 3 builtin scenarios 必须无损 |
| 性能 | 5 千行业务 + 5 千行对手 + 单场景 ≤ 30 秒 |
| 内存 | 单次处理峰值 ≤ 500 MB |
| 可观测性 | warnings 含 `scenarioName / sourceSide / sourceRowOrderId / code / message` |
| i18n | 全中文，无 i18n |
| 跨平台 | Windows + macOS（与现有项目一致） |

---

<!-- 2026-04-30 决策回写：Q1/Q2/Q3/Q4 已闭环，原 Q2（SubBizType 未命中语义）从此节移除 -->
## 十四、待澄清问题

> 2026-04-30：用户已对原 4 个 Open Question 给出决策（Q1/Q2/Q3/Q4），分别回写到本 PRD 和 spec 各对应章节。本节仅留作后续新问题追踪用。

- [ ] 本 PRD 起草后若发现新问题，加入此节继续追踪

---

## 十五、变更记录

| 日期 | 版本 | 变更 |
|---|---|---|
| 2026-04-30 | v0.1 draft | 初稿（基于用户 5 轮澄清落 spec） |

---

## 十六、实施记录

> 由 PR merged + 归档后追加，PM 不需要手动填写。

### PR-A 骨架（待启动）

- 草稿：—
- 初版：—
- 最终：—
- merge commit：—
- 改动文件：—
- 关键决策修订：—
- 测试证据：—

### PR-B 对账引擎（待启动）

- 草稿：—
- 初版：—
- 最终：—
- merge commit：—
- 改动文件：—
- 关键决策修订：—
- 测试证据：—

### PR-C 识读规律（待启动）

- 草稿：—
- 初版：—
- 最终：—
- merge commit：—
- 改动文件：—
- 关键决策修订：—
- 测试证据：—

### PR-D 收尾（待启动）

- 草稿：—
- 初版：—
- 最终：—
- merge commit：—
- 改动文件：—
- 三件套更新：CHANGELOG / VERSION_FEATURE_HISTORY / USER_GUIDE
- 版本 bump：`2.0.0` → `2.1.0-beta.1`
- 测试证据：—
