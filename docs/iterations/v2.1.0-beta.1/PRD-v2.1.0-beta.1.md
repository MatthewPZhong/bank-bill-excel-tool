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
- **算法语义**（**PR-B Round 4 subset-sum 重构，2026-05-09**）：5 阶段算法
  - **Step 1**：同 BillDate + 全部对账字段（含 Amount 等）AND 全等的 1v1 严格匹配；命中即锁定
  - **Step 2**：BillDate ± 1 day 容错（主单 D vs 从单 D-1/D/D+1 任一相等即可）+ 其他对账字段 AND 全等不变；命中即锁定
  - **Step 3.1**：进 1v多 池子（剩余主+从）— 同 BillDate + 除 Amount 外其他对账字段 AND 全等过滤候选；候选 Amount 走 **subset-sum**(候选.Amount) === 主.Amount，找子集 size ≥ 2
  - **Step 3.2**：进 1v多 池子 — BillDate ± 1 day + 除 Amount 外其他对账字段 AND 全等 + subset-sum
  - **Step 3'.1 / Step 3'.2**：勾了 多v1 时，对剩余池子做 同 BillDate / ±1day + 除 Amount 外其他对账字段 AND 全等 + subset-sum(候选主.Amount) === 从.Amount 多主 vs 1 从匹配
  - **多解 tie-break**：subset-sum 多解时按 `spread 最小 → distToMain 最近 → size 最小 → firstIdx 字典序` 决出唯一最优解（详 §七.3.6）
  - 详见 §七.3.1 算法主流程
- **未匹配单据**：算法跑完仍未配对的主从单据写入 `单据对账修复-未匹配-YYYYMMDDHHmm-{scenarioName}.xlsx` 告警 report（详见 §七.3.5 unmatched writer）
- **不再存在**早期 PR-B Round 1+2 的"先 1v1 → 1v多 → 多v1"轮询（已被 Round 3 重构替换）
- **Round 3 → Round 4 修订（用户测试反馈）**：Round 3 池子算法是"逐行 Amount 全等"过滤，**严重漏配**——主 270k 即使从有 [200k, 70k] 也不会命中。Round 4 改为 subset-sum 后，多笔小金额拼出大金额的会计对账常见做法被正确支持。

### D3 — 账单类型动态行（C4 配置弹窗第 3 行）

- 行结构：`[序号] [主/从下拉] [字段下拉] [操作下拉] [值输入框]` + 行级 ❌ 删除
- 下拉 1：单选枚举「主边」「从边」
- 下拉 2（**联动**下拉 1）：
  - 选「主边」→ 枚举 = `samples/单据对账导出不平.xlsx`「业务部门账单」sheet 表头（23 列）
  - 选「从边」→ 枚举 = 「对手部门账单」sheet 表头（22 列）
- 下拉 3：「等于」「不等于」「包含」「不包含」「空值」「非空值」「开头为」（选"空值/非空值"时值输入框消失）
- 同序号下方按钮「新增」：在该序号下加一行（同序号多条 = AND 关系）
- 行底下按钮「新增账单类型」：序号 +1，开始新一组类型

### D4 — 对账字段（C4 配置弹窗第 4 行；**PR-B Q1=B 决策修订，2026-04-30；Round 3 Amount 锁定，2026-05-09**）

> **2026-04-30 修订**：去 seq 概念，改为"分组（reconGroups）"模型。
>   - 一个 group = 一对 (leftTypeSeq, rightTypeSeq) 头 + 多行 fieldPairs（默认 AND）
>   - 多个 group 之间 = OR
>   - 默认呈现 1 个 group（主→从）+ 1 行 fieldPair；用户继续点"+ 新增字段对" 加 AND 行
>   - 如果用户要 OR 关系，单独点"+ 新增 OR 分组"按钮另开一个 group block

> **2026-05-09 PR-B Round 3 修订（Decision 4 — Amount 字段对锁定）**：
>   - **新增分组（reconGroup）默认带 Amount 字段对作为第一行**（leftField='Amount', rightField='Amount'）
>   - Amount 字段对**完全不可编辑 + 不可删除**：
>     - 行级 ❌ 删除按钮 disabled / 隐藏
>     - leftField / rightField select 都 disabled，固定显示 'Amount'
>   - 用户可继续在该 group 加其他字段对（如 Currency / BizType）
>   - 多个 reconGroup 各自带自己的"锁定 Amount"行
>   - **业务依据**：算法 Step 3.x 池子内 1v多 / 多v1 是基于 Amount 单一字段对匹配，必须保证用户场景里有 Amount 字段对作为算法基础

- 分组 block 头：`分组 # | 左：[账单类型号下拉] vs 右：[账单类型号下拉] [✗ 删除分组]`
- 字段对行：
  - **第 1 行（锁定）**：`[Amount(disabled)] = [Amount(disabled)] [+ 新增字段对]`（无删除按钮）
  - 其余行：`[左字段下拉] = [右字段下拉] [✗ 删除字段对] [+ 新增字段对]`
- 行底下按钮「+ 新增 OR 分组」：在 group 列表底部加新 group block（新分组也自动带 Amount 锁定行）
- 下拉 1 / 下拉 2：枚举值 = §D3 行 3 已配的"账单类型"序号（1 / 2 / ...），**左侧必须指向 main、右侧必须指向 opp**
- 字段下拉枚举：左侧 = 「业务部门账单」sheet 表头（23 列）；右侧 = 「对手部门账单」sheet 表头（22 列）

> 数据模型：`reconGroups[] = [{ leftTypeSeq, rightTypeSeq, fieldPairs: [{leftField, rightField, locked?}, ...] }, ...]`（详见 §八 8.2）
> **不再保留 seq 字段**：早期 PR-A 设计的 seq 概念（同 seq AND，不同 seq OR）会让用户在配 (Currency, Amount, BizType) 三条时误打多 seq 形成 OR；新模型默认 AND，更符合直觉。
> DB 迁移：老 reconFields[] 数据由 `migrateC4ReconGroupsStructure` 启动时按 seq 聚合到 reconGroups[]，幂等。
> Amount 锁定标记：fieldPair 上加 `locked: true` 表示锁；migration 兼容老数据时自动给"恰好是 Amount/Amount 的 fieldPair"补 locked 标记，否则给每个 group 头部插一条新的 Amount 锁定 fieldPair。

### D5 — 修复结果输出（C4 配置弹窗第 5 行）

#### D5.1 主从边修复模式

- 上侧两个勾选框（互斥）：「主边单据」「从边单据」
- 下侧勾选框「主从边都修复」（勾上后禁用上面两个）

#### D5.2 主从边都修复 — 共同 ID 拼接（**PR-B Q2=a 决策修订，2026-04-30**）

> **2026-04-30 修订**：共同修复 ID 的"基础部分"从 `源端单据.OrderId` 改为 `源端单据.reconId`。
>   - 业务上 reconId 才是"同对账组"的稳定标识；OrderId 跨主从边没法表达"同对账组"
>   - 用户回报：跑 fixture 文件时按原 spec OrderId 拼出来的 commonId 与对账系统期望不符

- 勾「主从边都修复」后右侧显示：
  - 文本「取」 + 单选下拉（「主边单据 reconId」/「从边单据 reconId」）+ 文本「加上」 + 输入框 + 文本「作为主从边共同的修复 ID」
- 共同修复 ID = `源端单据.reconId + 输入框文本`（字符串拼接）
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

> 共同修复 ID = D5.2 拼接结果（**PR-B Q2=a 决策修订**：`源端单据.reconId + 输入框文本`）；写入主、从两端的 Reference 列。

> **PR-B Round 3 决策修订（2026-05-09，Decision 1）**：mode='both' 时 1v多 / 多v1 的 Type 规则修订：
> - **1v多（RB4）修订**：主从都 Type=`0`（原 RB4：主 `0` / 从 `2` → 改为：**主 `0` / 从 `0`**）
> - 多v1（RB2）保持原规则（主 `2` / 从 `0`）
> - 1v1（RB1）保持原规则（双 Type=`0`）
> 业务依据：用户重新审视后，1v多 场景下从边多张单据每张都是"独立小单据"，应独立标记 Type=0；只有 多v1 场景下主边多张单据是"被聚合到一张从单"才写 Type=2。
> 注意：**mode='main' / mode='opp' 单边修复的 R1-R7 规则不变**（仅 mode='both' 受影响）。

| 规则号 | 匹配模式 | 主边 | 从边 | 备注 |
|---|---|---|---|---|
| RB1 | 1v1 | Type=`0` / Reference=共同 ID（主.reconId + suffix） | Type=`0` / Reference=共同 ID | 双向写 |
| RB2 | 多v1（Round 4：subset-sum 主子集） | Type=`2` / Reference=共同 ID（主代表行.reconId + suffix） | Type=`0` / Reference=共同 ID | 多主聚合到 1 从，主写 2 / 从写 0；多解 tieBreak 后命中的主子集都写 Type=2 |
| RB3 | 1v1 | Type=`0` / Reference=共同 ID（commonId.source 决定取主或从 reconId） | Type=`0` / Reference=共同 ID | 同 RB1（用户原文区分主、从触发；执行结果对称，保留语义） |
| RB4 | 1v多（Round 4：subset-sum 从子集） | Type=`0` / Reference=共同 ID（主.reconId + suffix） | **Type=`0`（Round 3 修订）** / Reference=共同 ID | 1 主对 N 从：主从都 Type=0；subset-sum 多解 tieBreak 后命中的从子集都写 Type=0（修订前为主 0/从 2） |
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

#### 7.3.1 算法主流程（**PR-B Round 4 subset-sum 重构，2026-05-09**）

> Round 4 修订（用户测试反馈）：Round 3 池子算法是"逐行 Amount 全等"过滤，严重漏配。
> Round 4 把 Step 3.x / 3'.x 改为 **subset-sum**——多笔小金额拼出大金额的会计对账常见做法。
> 5 阶段步骤不变（Step 1 / 2 / 3.1 / 3.2 / 3'.1 / 3'.2），仅 Step 3.x / 3'.x 内部改 subset-sum 语义。

```
function runC4Scenario(scenario, sheets):
    cfg = scenario.config
    matchRules = cfg.matchRules     // {oneToOne, oneToMany, manyToOne}
    billTypes = cfg.billTypes
    reconGroups = cfg.reconGroups   // 含锁定 Amount 字段对的分组列表
    output = cfg.output

    // 1. billTypes 分类（不变）
    classifyBySide('main', sheets.businessBills, billTypes)
    classifyBySide('opp',  sheets.opponentBills, billTypes)

    fixedRows = []
    warnings = []
    pairedLeft = Set()       // 已配主行 _rowIdx 集合（跨 group 共享）
    pairedRight = Set()
    unmatchedReasons = Map() // _rowIdx → { side, reason }（见 §七.3.5）

    for grp in reconGroups:
        leftRows  = mainTyped.filter(r => r._types.has(grp.leftTypeSeq))
        rightRows = oppTyped.filter (r => r._types.has(grp.rightTypeSeq))

        // ------- Step 1：同 BillDate + 全部对账字段 AND 全等的 1v1 严格匹配 -------
        if matchRules.oneToOne:
            tryOneToOneStrict(leftRows, rightRows, grp.fieldPairs, billDateMode='strict', ...)

        // ------- Step 2：BillDate ± 1 day 容错 + 全部对账字段 AND 全等的 1v1 -------
        if matchRules.oneToOne:
            tryOneToOneStrict(leftRows, rightRows, grp.fieldPairs, billDateMode='±1day', ...)

        // ------- Step 3 池子分流（按勾选；Round 4 subset-sum）-------
        if matchRules.oneToMany:
            // Step 3.1：剩余主+从池子，同 BillDate + 除 Amount 外其他对账字段 AND 全等过滤
            //          + subset-sum(候选从.Amount) === 主.Amount 找子集（size ≥ 2）；多解走 tieBreak
            tryOneToManyPool(leftRows, rightRows, grp.fieldPairs, billDateMode='strict', ...)
            // Step 3.2：剩余主+从池子，BillDate ±1day + 其他对账字段 AND 全等 + subset-sum
            tryOneToManyPool(leftRows, rightRows, grp.fieldPairs, billDateMode='±1day', ...)

        if matchRules.manyToOne:
            // Step 3'.1：池子同 BillDate + 其他对账字段 AND 全等 + subset-sum(候选主.Amount) === 从.Amount
            tryManyToOnePool(leftRows, rightRows, grp.fieldPairs, billDateMode='strict', ...)
            // Step 3'.2：池子 BillDate ±1day + 其他对账字段 AND 全等 + subset-sum
            tryManyToOnePool(leftRows, rightRows, grp.fieldPairs, billDateMode='±1day', ...)

    // ------- 跑完所有 group 后，未配的主从行写 unmatchedReasons -------
    for r in mainTyped:
        if r._rowIdx not in pairedLeft:
            unmatchedReasons.set(r._rowIdx, { side: 'main', orderId: r.OrderId, billDate: r.BillDate, amount: r.Amount, reason: deriveReasonFor(r, matchRules) })
    for r in oppTyped:
        if r._rowIdx not in pairedRight:
            unmatchedReasons.set(...)

    return { fixedRows, warnings, unmatchedRows: serialize(unmatchedReasons), stats: ... }
```

**关键不变量**（Round 4）：
1. `pairedLeft` / `pairedRight` 跨 group 共享 — 同行最多被 1 次配对，避免双重命中
2. 配对内每行 BillDate 仍按 ±1day 范围决定
3. 池子内（Step 3.x / Step 3'.x）：**除 Amount 外其他对账字段（Currency / BizType / OrderId 等）AND 全等过滤候选**；**Amount 走 subset-sum**
4. subset 必须 size ≥ 2（1v1 已在 Step 1/2 处理过）
5. 多解 tieBreak 保证唯一性 — 资金红线必须可重复
6. 浮点 Amount 必须 ×100 整数化避精度坑
7. unmatched.xlsx 在算法跑完后导出，由 export IPC 一并返回 mainFilePath + unmatchedFilePath（详见 §九 IPC + §七.3.5）

详细 Step 实现见 §七.3.6（Round 4 重构）。

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

RB4 (1v多)：1 个 leftRow → Type=0；多个 rightRow → **Type=0（PR-B Round 3 修订，2026-05-09，Decision 1）**；commonId 同上。

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

#### 7.3.5 未匹配 Report 文件（**PR-B Round 3 新增，2026-05-09，Decision 3**）

跑完 Step 1 / Step 2 / Step 3.x（含勾选项 manyToOne 的 Step 3'.x）后，仍未配对的主从行须写入告警 report：

- **文件名**：`单据对账修复-未匹配-YYYYMMDDHHmm-{scenarioName}.xlsx`（与主修复文件同 timestamp 同 scenarioName）
- **路径**：`Documents/网银账单生成小助手/recon-id-fix/{date}/`（与主文件同目录）
- **sheet 名**：`未匹配单据`
- **6 列表头**：
  | 列序 | 列名 | 含义 |
  |---|---|---|
  | 1 | 场景名 | scenario.name |
  | 2 | 单据来源 | `主` 或 `从`（不写英文） |
  | 3 | OrderId | 主从单据的 OrderId |
  | 4 | BillDate | 主从单据的 BillDate |
  | 5 | Amount | 主从单据的 Amount |
  | 6 | 未配原因 | 枚举字符串（见下） |
- **未配原因枚举**：
  - `'1v1 严格 BillDate 未匹配'` — 进入 Step 1 但未配；用户未勾 oneToMany / manyToOne 时本行为未配（同 Step 1 失败）
  - `'1v1 BillDate ±1day 未匹配'` — 进入 Step 2 但未配；未勾 oneToMany / manyToOne 时本行为未配（同 Step 2 失败）
  - `'池子内 BillDate 未匹配'` — 进入 Step 3.1 / Step 3'.1 但池子内同日 + Amount 没找到候选
  - `'池子内 BillDate ±1day 未匹配'` — 进入 Step 3.2 / Step 3'.2 但池子内 ±1day + Amount 没找到候选
  - `'未勾 1v多/多v1，跳过'` — 用户场景仅勾 oneToOne 时，Step 1+2 失败的行直接走此原因（不进 Step 3.x）
- **导出语义**：
  - 与主修复文件**一并导出**，由 `recon-id-fix:export` IPC 一次返回 `mainFilePath + unmatchedFilePath`
  - 主文件空命中（fixedRows.length=0）但 unmatchedRows 非空 → 仍弹 saveDialog 写**只写 unmatched**（不弹"无修复记录"提示）
  - 主文件 + unmatched 都空 → 弹"无修复记录"提示，不生成任何文件
  - 主文件非空 + unmatched 空 → 仅写主文件（与原行为一致）
  - 表头字号 10pt（applyHeaderRowFont 与其他 writer 一致）

#### 7.3.6 Step 1 / Step 2 / Step 3 实现细节（**PR-B Round 4 subset-sum 重构 + Round 5 Step 2 多候选 tie-break**）

> Round 5 微调（2026-05-09）：Step 2 ±1day 容错的 1v1 配对，多候选时不再"恰好 1 个候选"才命中，而是按 tie-break 挑 1 个最优做 1v1（含双向一致性校验）。
> Step 1 严格相等行为不变。详见 spec §五.2.3。

```
function tryOneToOne(leftRows, rightRows, fieldPairs, billDateMode, ...):
    for leftRow in leftRows:
        if pairedLeft.has(leftRow._rowIdx): continue
        // 候选从行：BillDate 按 mode 比较 + 全部 fieldPairs（含 Amount 锁定）AND 全等
        candidates = rightRows.filter(r => !pairedRight.has(r._rowIdx)
          && billDateMatches(leftRow.BillDate, r.BillDate, billDateMode)
          && allFieldPairsEqual(leftRow, r, fieldPairs))

        if billDateMode === 'strict':
            // Step 1：保持原行为，必须恰好 1 个候选
            if candidates.length !== 1: continue
            rightRow = candidates[0]
            // 反向校验：右行回看左侧空闲行的匹配数 = 1，确认 1v1
            reverse = leftRows.filter(l => !pairedLeft.has(l._rowIdx)
              && billDateMatches(l.BillDate, rightRow.BillDate, billDateMode)
              && allFieldPairsEqual(l, rightRow, fieldPairs))
            if reverse.length !== 1: continue
            pairedLeft.add(leftRow._rowIdx); pairedRight.add(rightRow._rowIdx)
            apply1v1Assignment(leftRow, rightRow, ...)
        else:  // billDateMode === '±1day'，Round 5 微调
            if candidates.length === 0: continue
            // tie-break 挑 1 个最优：dist → idx 字典序
            bestRight = pickBestByTieBreak(leftRow, candidates)
            // 双向一致性校验：bestRight 反查 leftRows，按同 tie-break 选回的主单必须 == 当前 leftRow
            reverseCandidates = leftRows.filter(l => !pairedLeft.has(l._rowIdx)
              && billDateMatches(l.BillDate, bestRight.BillDate, billDateMode)
              && allFieldPairsEqual(l, bestRight, fieldPairs))
            if reverseCandidates.length === 0: continue
            bestLeftFromReverse = pickBestByTieBreak(bestRight, reverseCandidates)
            if bestLeftFromReverse._rowIdx !== leftRow._rowIdx: continue  // 让位避免抢配冲突
            pairedLeft.add(leftRow._rowIdx); pairedRight.add(bestRight._rowIdx)
            apply1v1Assignment(leftRow, bestRight, ...)

// Round 5：tie-break 多候选挑 1 个最优
//   排序顺序：|参考.BillDate - 候选.BillDate| 最小 → 候选 _rowIdx 字典序最小
function pickBestByTieBreak(referenceRow, candidates):
    if candidates.length === 0: return null
    if candidates.length === 1: return candidates[0]
    score each candidate:
        - dist = |refMs - candMs|（refMs/candMs 解析失败 → Infinity）
        - idx = candidate._rowIdx 字符串
    sort ascending by (dist, idx)
    return candidates[0]

function tryOneToManyPool(leftRows, rightRows, fieldPairs, billDateMode, ...):
    // Round 4 subset-sum 语义（替换 Round 3 单字段 Amount 全等）：
    //   候选过滤：BillDate（按 mode）+ 除 Amount 外其他对账字段 AND 全等
    //   subset-sum：候选 Amount 整数化（×100），DFS + 升序剪枝；subset 必须 size ≥ 2
    //   多解 tieBreak：spread → distToMain → size → firstIdx 字典序
    amountFieldPair = findAmountLockedPair(grp.fieldPairs)
    if !amountFieldPair: return  // 防御：dialog 强制 Amount 锁定
    otherFieldPairs = grp.fieldPairs.filter(fp => not (fp.leftField === 'Amount' && fp.rightField === 'Amount'))
    for leftRow in leftRows:
        if pairedLeft.has(leftRow._rowIdx): continue
        // 候选过滤：除 Amount 外其他对账字段全等
        candidates = rightRows.filter(r => !pairedRight.has(r._rowIdx)
          && billDateMatches(leftRow.BillDate, r.BillDate, billDateMode)
          && rowsMatchOtherFieldPairs(leftRow, r, otherFieldPairs))
        if candidates.length < 2: continue                            // 候选不足 2 → 不可能 1v多
        targetCents = toCents(leftRow.Amount)
        if targetCents === null: continue                             // Amount 解析失败
        candidatesWithCents = candidates.map(r => { row: r, cents: toCents(r.Amount) }).filter(c => c.cents !== null)
        subsets = enumerateAmountSubsets(candidatesWithCents, targetCents, maxSize=8)
        if subsets.length === 0: continue                             // 无解 → 进 unmatched
        chosen = subsets.length === 1 ? subsets[0] : tieBreakSubsets(subsets, leftRow.BillDate)
        if chosen.length < 2: continue                                // 兜底：subset 必须 size ≥ 2
        pairedLeft.add(leftRow._rowIdx); chosen.forEach(r => pairedRight.add(r._rowIdx))
        apply1vNAssignment(leftRow, chosen, ...)

function tryManyToOnePool(leftRows, rightRows, fieldPairs, billDateMode, ...):  // 对称
    // 同 tryOneToManyPool，但 subset-sum 是从主单候选拼出从.Amount

function billDateMatches(leftDate, rightDate, mode):
    if mode === 'strict': return normalize(leftDate) === normalize(rightDate)
    // ±1day 容错：主单 D vs 从单 D-1 / D / D+1 任一相等即匹配
    leftStr = normalize(leftDate)
    rightStr = normalize(rightDate)
    if leftStr === rightStr: return true
    leftDateObj = parseDate(leftStr); if (!leftDateObj) return false
    rightDateObj = parseDate(rightStr); if (!rightDateObj) return false
    diffMs = Math.abs(leftDateObj - rightDateObj)
    return diffMs === 86400 * 1000   // 1 day

// Round 4：金额转整数分（避浮点 0.1+0.2!=0.3 精度坑）
function toCents(amount):
    if amount === null/undefined/'': return null
    n = Number(String(amount).trim()); if not Number.isFinite(n): return null
    return Math.round(n * 100)

// Round 4：subset-sum 枚举（DFS + 升序剪枝）
function enumerateAmountSubsets(candidates, targetCents, maxSize=8, maxSolutions=64):
    if len(candidates) < 2 or targetCents <= 0: return []
    sort candidates ascending by cents
    solutions = []; path = []
    function dfs(startIdx, remaining, depth):
        if len(solutions) >= maxSolutions: return
        if remaining === 0 && depth >= 2: solutions.push(path.slice()); return  // size >= 2
        if depth >= maxSize: return
        for i from startIdx to len(candidates)-1:
            if candidates[i].cents > remaining: break       // 升序剪枝
            path.push(candidates[i])
            dfs(i+1, remaining - candidates[i].cents, depth+1)
            path.pop()
    dfs(0, targetCents, 0)
    return solutions

// Round 4：tieBreak 多解唯一性
function tieBreakSubsets(subsets, mainBillDate):
    if subsets.length === 1: return subsets[0]
    score each subset:
      - spread = max(subset.BillDate ms) - min(subset.BillDate ms)
      - distToMain = min(|mainBillDate ms - r.BillDate ms| for r in subset)
      - size = subset.length
      - firstIdx = subset.map(r => r._rowIdx).sort()[0]
    sort subsets ascending by (spread, distToMain, size, firstIdx)
    return subsets[0]
```

**Round 4 算法不变量**：
1. 池子内每行 BillDate 仍按 ±1day 范围（与 Step 1+2 一致）
2. **其他对账字段（Currency / BizType / OrderId）走 AND 全等过滤候选；只有 Amount 走 subset-sum**
3. subset 必须 size ≥ 2（1 vs 1 已在 Step 1/2 处理过；池子里跳过单元素子集）
4. 多解 tieBreak 保证唯一性，避免每次跑出不同结果（资金红线）
5. 浮点精度 ×100 整数化是必须的：`0.1 + 0.2 = 0.30000000000000004 ≠ 0.3` 经典坑会让对账失败

**未配原因 deriveReasonFor(row, matchRules)**：
```
function deriveReasonFor(row, matchRules):
    // row 未在任一 step 配上时调用
    // 取该行最后一次"进入候选池但未配"的 step
    if row 在 Step 3.2 / Step 3'.2 仍未配 (因为 Step 3.x 都试过) → '池子内 BillDate ±1day 未匹配'
    elif row 在 Step 3.1 / Step 3'.1 试过未配 → '池子内 BillDate 未匹配'
    elif !matchRules.oneToMany && !matchRules.manyToOne → '未勾 1v多/多v1，跳过'
    elif row 在 Step 2 试过未配 → '1v1 BillDate ±1day 未匹配'
    else → '1v1 严格 BillDate 未匹配'
```

实现可用 `unmatchedReasonByRow`（`Map<_rowIdx, 'last-step-tried'>`）跟踪每行最后到达的 step，避免重复推断。

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

### 8.2 C4 场景 config_json 结构（**PR-B Q1=B 决策修订，2026-04-30**）

> **2026-04-30 修订**：`reconFields[]`（含 seq）→ `reconGroups[]`（每组自带 leftTypeSeq/rightTypeSeq + fieldPairs[]，组内 AND，组间 OR）。
>   早期 PR-A seq 概念会让用户配 3 个字段对时误打多 seq 形成 OR；新模型默认 AND。
> DB 迁移：老 reconFields[] 数据由 `migrateC4ReconGroupsStructure(db)` 启动时按 seq 聚合到 reconGroups[]（详见 §spec §二 2.5）。

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
  "reconGroups": [
    {
      "leftTypeSeq": 1,
      "rightTypeSeq": 2,
      "fieldPairs": [
        { "leftField": "Amount", "rightField": "Amount", "locked": true },
        { "leftField": "Currency", "rightField": "Currency" }
      ]
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
- `reconGroups[i].leftTypeSeq` / `rightTypeSeq`：必须分别指向 main / opp 的 billType seq
- `reconGroups[i].fieldPairs`：组内 AND（≥ 1 行），多组之间 OR
- `reconGroups[i].fieldPairs[j].locked`：可选 boolean；`true` 表示该 fieldPair 不可编辑/不可删除（仅 Amount/Amount 锁定行用）；migration 兼容老数据时自动给 Amount/Amount 行补 `locked: true`，否则在 group 头部插一条新的 Amount 锁定行（PR-B Round 3，2026-05-09）
- `output.mode`：`'main'` / `'opp'` / `'both'`
- `output.commonId`（仅 mode='both' 用）：`source ∈ {'main', 'opp'}`，`suffix` 字符串；**基础部分取 src.reconId**（PR-B Q2=a 决策）
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
> ⚠️ **PR-B Q2=a 决策（2026-04-30）**：mode=both 时 Reference 列 = `源端单据.reconId + suffix`（不再是 OrderId）。源端是主或从由 commonId.source 决定。

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
| **`recon-id-fix:run`** | renderer→main | `{scenarioId}` | `{status, stats: {fixedRowCount, warningCount, unmatchedRowCount, mainRowsTouched, oppRowsTouched}}` |
| **`recon-id-fix:export`** | renderer→main | `{savePath?}` | `{status, mainFilePath?, mainFileName?, unmatchedFilePath?, unmatchedFileName?, rowCount, unmatchedCount}` |
| **`recon-id-fix:session-status`** | renderer→main | — | `{hasFile, hasResult, ...}` |
| **`recon-id-fix:infer-rules`** | renderer→main | `{sampleFilePath}` | `{status, billTypes: [...], reconFields: [...]}` |

> **PR-B Round 3 修订（2026-05-09，Decision 3）**：
> - `recon-id-fix:run` 返回 `stats.unmatchedRowCount` —— 用于 statusBox 文案"运行完成；命中 N 行修复 / M 行未匹配"
> - `recon-id-fix:export` 返回 `mainFilePath` + `unmatchedFilePath`（双文件）；前端可选择只看主文件 / 看告警文件
> - 主文件空命中（fixedRows.length=0）但 unmatched 非空 → 仍写 unmatched 文件；mainFilePath 为 null
> - 主+unmatched 都空 → status='empty'，不弹 saveDialog

---

## 十、风险

### 10.1 ⚠️ 资金红线（最高优先级）

| 风险 | 等级 | 缓解 |
|---|---|---|
| **错误 Reference 关联导致单据修复失败** | 资金红线（最高） | 单测 + 集成测试覆盖 7+5 全规则；用户用样例文件回归；R5/R6 SubBizType 查不到时**必须**走 warning + 不进 fixedRows，绝不自动 fallback |
| **多v1 / 1v多 时 Reference 写错单据** | 资金红线 | applyAssignment_NvN 必须严格区分"被聚合方" vs "聚合源"；单测覆盖正反向 |
| **共同修复 ID 拼接错位**（取主边但应取从边的 OrderId） | 资金红线 | computeCommonId 单测；C4 配置弹窗 commonId.source 默认值要明示 |
| **场景配置变更后旧 result 被导出** | 资金红线 | 复用 v2.0.0-beta.3 PR #33 round 2/3 的 snapshot 双层防御：scenarios:* IPC 入口主动清（**PR #35 round 3 P2 修订**：按 category 分流——C1/C2/C3 只清 `processingResult`，C4 只清 `reconIdFixResult`，避免跨模块互抹）+ export 端被动校验 snapshot |

### 10.1.1 ⚠️ BillDate ±1day 容错可能误配（PR-B Round 3 新增，2026-05-09）

| 风险 | 等级 | 缓解 |
|---|---|---|
| **±1day 容错可能误配相邻日的相似单据** | 资金红线（高） | 1）Step 1 严格 BillDate 优先，已配的不进 Step 2；2）Step 2 仍要求其他对账字段 AND 全等（非仅 Amount）；3）unmatched.xlsx 全量 dump 让用户校验；4）反向校验 `reverse.length === 1` 防止 N v 多 误配为 1v1 |
| **池子内 Amount 单一字段对误配重复 Amount 单据** | 资金红线（高） | 1）池子内仍有 BillDate 同日 / ±1day 范围限制；2）pairedLeft/pairedRight 跨 group 共享，避免双重命中；3）unmatched 写明原因 — 用户可手动补 Currency/BizType 字段对升级到 Step 1 范围 |
| **跨组 OR 时 Step 顺序导致优先 group 抢先吃配对** | 中 | reconGroups 顺序就是用户在 dialog 看到的顺序；用户可调整；smoke 验证 |

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
| P0-4 | 主从都修复 1v1 | mode=both, oneToOne, commonId.source=main, suffix='-FIX' | 主从两行 Reference 都 = **主边 reconId+'-FIX'**（Q2=a），Type 都=0 |
| P0-5 | 主从都修复 多v1 | mode=both, manyToOne, commonId.source=main | 多主边 Type=2 / 1 从边 Type=0 / Reference 全 = **主边代表行 reconId+suffix**（Q2=a） |
| P0-5b | 主从都修复 1v多 | mode=both, oneToMany, commonId.source=main | **主从都 Type=0**（Round 3 修订；原从 Type=2）/ Reference 全 = 主边 reconId+suffix |
| P0-5c | 算法 5 阶段 BillDate ±1day | mode=main, oneToOne+oneToMany；M1 04-09 100 + S1 04-08 100（仅 1 个 ±1day 候选）+ M2 04-10 300 + S2 04-10 100 / S3 04-10 200 | 主 M1 与 S1 配对成功（Step 2 1v1 ±1day），剩余主从 M2 + [S2, S3] subset-sum=300 成功（Step 3.1） |
| P0-5d | 真实 fixture「基金」（Round 4 subset-sum 重新校准） | 用 `/Users/pzhong/Desktop/小助手-Debug/2.0.0/订单枚举表/单据对账导出不平.xlsx` 跑"基金"场景 | Round 4 期望：fixedRowCount = 80 / mainRowsTouched = 30 / oppRowsTouched = 50 / unmatchedRowCount = 0（subset-sum 命中所有 PP 主从）—— 与 Round 3 baseline (28/14/14/52) 不同，因 Round 4 subset-sum 修复了 Round 3 漏配 |
| P0-5e | unmatched.xlsx 双文件输出 | 跑场景生成主+unmatched | 主目录下生成 `单据对账修复-未匹配-...xlsx`（6 列 + sheet 名"未匹配单据"）|
| P0-5f | subset-sum 命中（Round 4 用户用例） | mode=opp, oneToMany；主 04-15 USD 270k vs 从 [F1 04-13 70k, F2 04-14 200k, F3 04-14 70k, F4 04-15 70k] | 期望命中 {F2, F3} sum=270k（spread=0d 优于 spread=1d）；F1 04-13 超 ±1day 进 unmatched；F4 因 tieBreak 落选 |
| P0-5g | subset-sum 多解 tieBreak | 1 主 100 vs 从 [50, 50, 30, 20]（{50,50}=100 / {50,30,20}=100 两解） | 期望选 {50,50}（spread 并列时 size 较小者优先；这里 spread=distToMain 都为 0 ⇒ size 决出胜负） |
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

### PR-A 骨架（已合并）

- 草稿：`docs/prs/PR35-v2.1.0-beta.1.md`（integrated=true）
- 初版：commit `63d5450`（PR-A 9 task 主体）+ `1d09e2e`（spec 三件套 + samples fixture）
- review 修订：`affd373`（round 1 — P1 资金红线 + 2 P2 + 1 P3）→ `01adc75`（round 2 — P2 分流 + P3 计数）→ `7327b43`（self-review — P3-A 显式枚举 + P3-B updateScenario 显式 throw）→ `b7608aa`（backlog B4）
- merge commit：`6e5ebaf`（PR #35 → main，2026-04-30）
- 改动文件（共 35 个）：
  - **DB**：`src/backend/database/{migrations,scenarios-repository,settings-repository}.js` + `src/backend/database.js`（CHECK 约束 3→4 值，`ensureScenariosCategoryReconIdFix` 幂等迁移；updateScenario 显式 throw on category/is_builtin）
  - **前端 DOM**：`index.html` + `src/styles-gemini-extra.css`（第 5 模块入口 + 主面板 fork）
  - **渲染层**：`src/renderer.js`（MODULES +1 / state +5 / elements +6 / reloadReconIdFixScenarios + scenariosChanged 参数）+ `src/renderer-dialogs.js`（createScenarioConfigDialogC4 + 类别选择四选一 + validateScenarioDraft 4 条 C4 校验）+ `src/renderer-previews.js`
  - **IPC + 主进程**：`src/main.js`（4 个 recon-id-fix:* handler 占位 + scenarios:* 按 category 分流清缓存 + clearResultCacheForCategory 显式枚举）+ `src/preload.js`（desktopApi.reconIdFix.* + 4 sheet 字段常量）+ `src/main-process/scenario-dispatcher.js`（filterOutReconIdFix + skippedC4Count）
  - **smoke**：`scripts/smoke/{migrations-recon-id-fix,recon-id-fix-scenario-ipc,scenario-dispatcher,scenarios-repository}.js`（新增 18 用例：6 migrations + 11 IPC + 1 P3-B + dispatcher 4 用例 D10/D11/D12/filterOutReconIdFix 单测）
  - **fixture**：`samples/单据对账导出不平.xlsx` / `单据对账导出不平-对平例子.xlsx` 入库
  - **preview**：`docs/previews/{recon-id-fix-panel,scenario-config-c4,scenario-config-c4-both}.png` 新增 + 6 张 M
  - **build**：`package.json`（3 个新 preview script）
  - **docs**：本 PRD + spec + tasks + log + PR35 草稿 + `knowledge/backlog.md` 新增 B4
- 关键决策修订：
  - **资金红线分流**（round 3 P2）：原 round 2 在 dispatcher 入口和 export snapshot 过滤 C4，但 4 个 scenarios:* IPC 仍无条件双清两个全局缓存，导致用户跑完银行对账后改 C4 场景会误清 processingResult。修法：按 category 分流（'recon-id-fix' 清 reconIdFixResult；C1/C2/C3 清 processingResult；未知 category 双清 + warn 兜底）。降级保险（snapshot 校验）保留不动
  - **C4 数据完整性**（round 1 P2）：保存前校验 billTypes 至少有 main + opp 各 1 条，reconFields 左指 main 右指 opp（避免 PR-B 引擎按 businessBills/opponentBills 跑时直接匹配不到从边）
  - **场景管理 UI 同步**（round 1 P2）：reloadReconIdFixScenarios 加 scenariosChanged 参数，CRUD 路径清 state.reconIdFixExport + 调 refreshReconIdFixStatus 同步 main 端 session-status
  - **银行对账 run/export 排除 C4**（round 1 P1）：bank-statement:run/export 在 detailedEnabled 之后过滤 category !== 'recon-id-fix'；dispatcher 入口加 filterOutReconIdFix defense in depth
- 测试证据：smoke 181/181 PASS（10 套）；含 5 模块切换 / C4 dialog 5 行 / 类别四选一 / 资金红线跨模块互抹反向（T8/T9/T10/T11）/ 老库 3 builtin 无损迁移 / CHECK 约束拦截非法
- 已知 follow-up：`knowledge/backlog.md` B4（recon-id-fix-scenario-ipc smoke simulator 与真实 main.js 漂移；PR-D e2e 时一并处理）

### PR-B 对账引擎（用户测试中 — Round 4 subset-sum 重构进行）

- 草稿：—（PR 未提）
- 初版：工作目录改动 13 task 主体（PR-B Round 1）
- Round 2：Q1=B（reconGroups）/ Q2=a（commonId 用 reconId）回写 + smoke 232/232
- **Round 3 决策修订（2026-05-09 — 用户复盘原始需求 5 决策回写）**：
  - **Decision 1**：mode='both' RB4（1v多）从 主 0/从 2 改为 **主 0/从 0**；mode='main'/'opp' R1-R7 不变
  - **Decision 2**：算法重构 — "1v1 严格 → 1v1 ±1day → 池子 1v多 同日 → 池子 1v多 ±1day → 池子 多v1 同日 → 池子 多v1 ±1day"5 阶段
  - **Decision 3**：新增 unmatched.xlsx 告警 report — 6 列 + 文件名 `单据对账修复-未匹配-...xlsx` + recon-id-fix:export 一并返回 mainFilePath + unmatchedFilePath
  - **Decision 4**：C4 dialog Amount 字段对锁定 — 新增分组默认带 `Amount/Amount` 锁定行，行级 ❌ 删除按钮和字段 select 都 disabled
  - **Decision 5**：BillDate 字段名（主从 sheet 都叫 `BillDate`）+ 池子语义两阶段（同 BillDate 先、±1day 后）+ Step 2 仍要求其他对账字段 AND 全等
- **Round 4 决策修订（2026-05-09 — 用户测试发现 Round 3 池子算法语义错位 → 4 决策回写）**：
  - **Decision 1**：1v多 池子改 subset-sum + 其他对账字段 AND 全等过滤候选
    - Round 3 错误："逐行 Amount 全等"（候选必须每个都 == 主 Amount），漏配
    - Round 4 正解：候选 = 池子里满足"BillDate（按 mode）+ 除 Amount 外其他对账字段 AND 全等"的从单；subset-sum(候选.Amount) === 主.Amount 找子集（size ≥ 2）
  - **Decision 2**：subset-sum 多解 tie-break — `spread → distToMain → size → firstIdx 字典序` 4 阶
  - **Decision 3**：多v1 池子对称 — subset-sum(候选主.Amount) === 从.Amount + 同 tieBreak
  - **Decision 4**：Step 3.2（±1day）找不到子集 → 直接进 unmatched，不再退一步
- **Round 5 决策修订（2026-05-09 — 用户测试 Round 4 时发现 Step 2 多候选直接跳过漏配 → 1 决策回写）**：
  - **Q1=a**：Step 2 ±1day 多候选时按 tie-break 挑 1 个 1v1 命中（不退到 Step 3 池子）
    - 用户用例：主 04-28 USD 300000 入账 + 从单池里有 04-27（target）和 04-29 两个候选，Round 4 实现要求"恰好 1 个候选"→ 直接跳过 → 退到 Step 3 池子（subset 必 size ≥ 2，单元素 300k 不命中）→ 全 unmatched
    - Round 5 解：Step 2（billDateMode='±1day'）多候选时按 tie-break 选 1 个最优（dist → _rowIdx 字典序）+ 双向一致性校验（bestRight 反查 leftRows 必须选回当前 leftRow，否则让位避免主从抢配冲突）
    - **Step 1（billDateMode='strict'）保持现状**：候选数必须恰好 1 + reverse 也恰好 1（资金红线最严）
    - 不动 Q2 池子 subset-sum size ≥ 2 / Round 4 全部其他逻辑
- **PR #36 round 1 P2 修复（2026-04-30 — Codex review）**：≥ 10 候选 tie-break `_rowIdx` 字典序 → 数字部分比较
  - 详见 `log.md` 2026-04-30 节
- **PR #36 round 2 P2 修复（2026-04-30 — user 复现）**：subset-sum 全局最优；DFS 全遍历维护 best
  - **背景**：user 复现：10 个 04-01 候选 + 3 个 04-15 候选 + target=300，旧 `enumerateAmountSubsets`+`tieBreakSubsets` 二段式在 maxSolutions=64 截断后排序，全局最优排在第 N>64 位时被漏选
  - **修法**：池子算法迁移到新工具函数 `findBestAmountSubset`（DFS 全遍历维护全局 best；不再截断）
  - **性能**：升序剪枝 + 后缀总和剪枝 + top-k 后缀剪枝 + 启发式提前终止 + hardCeiling=5M 硬上限；n=20 大池子 1.14ms / 次（实测比修前 2.58ms 更快）
  - **兼容**：`enumerateAmountSubsets` / `tieBreakSubsets` 函数保留（向后兼容 + 单测覆盖），但**池子算法不再调用**
  - 详见 `log.md` 2026-04-30 round 2 节
- 最终：—（待用户合并 PR #36 round 2）
- merge commit：—
- 改动文件：（待 commit 后填）
- 关键决策修订：Round 3 5 决策 + Round 4 4 决策 + 工作目录所有 PR-B 改动
- 测试证据：
  - Round 4：smoke 254/254 PASS（Round 3 baseline 247 + Round 4 新增 7 用例：subset-sum helpers + 用户用例 + 多解 tieBreak + 浮点精度 + 大候选集性能 + 多v1 对称 + 找不到子集）；用户用例验证：主 04-15 USD 270k + 从 [F1 04-13 70k, F2 04-14 200k, F3 04-14 70k, F4 04-15 70k] → 命中 {F2, F3}（与用户预期一致，spread=0d 优于其他解）
  - Round 5：smoke 260/260 PASS（Round 4 baseline 254 + Round 5 新增 6 用例：pickBestByTieBreak helpers + Step 2 dist tie-break + Step 2 idx tie-break + 反向不一致让位 + Step 1 严格不变 + Step 2 单候选不变）；用户用例验证（FX 中台入金 fixture）：主 FTA202604280200028（04-28, USD 300k, 入账）+ 从池里 04-27 target + 04-29 decoy → 命中 04-27 target，Reference=`PP_20260428020000_USD_HK0000720752_001`；FX fixture 全量：fixedRowCount=96 / mainTouched=36 / oppTouched=60 / unmatched=18；基金 fixture 回归：fixedRowCount=80 / mainTouched=30 / oppTouched=50 / unmatched=0（与 Round 4 baseline 一致，无退步）
  - PR #36 round 1 P2 修复：smoke 262/262 PASS（260 + 2 新增）；详见 log.md
  - **PR #36 round 2 P2 修复**：smoke **266/266 PASS**（262 + 4 新增）；user 复现用例验证 — 修前选 3 个 04-01 子集（次优），修后选 3 个 04-15 子集（spread=0+distToMain=0 全局最优）；fixture 回归（修前修后数字一致）：FX fixture × FX 入账 fixedRowCount=113 / mainTouched=44 / oppTouched=69 / unmatched=25 / warnings=0；性能：n=20 大池子 1.14ms（旧实现 2.58ms）；用户用例 FTA202604280200028 ↔ 202604271439325696974017228 双双命中并共享 commonId

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
