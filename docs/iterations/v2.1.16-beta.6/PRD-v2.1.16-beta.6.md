# PRD — v2.1.16-beta.6

> 迭代名：**导出按钮互斥 + 预加工导出双 sheet 重构 + 中台退款回填全链路开通**
> 分支：`v2.1.16-beta.6`（从 `main`，含 beta.5）
> 版本：`2.1.16-beta.5` → `2.1.16-beta.6`
> 状态：**待评审**
> 日期：2026-06-08
> 风险等级：🔴 高（含资金红线：退款单状态机 `SUBMITTED→SUCCESS` + 对账 ID 回填；对账产物导出格式破坏性变更）

---

## 一、背景与范围

beta.5 合并后，用户反馈 5 个问题。经三轮澄清，**本批做 3 个需求，2 个不做**：

| 来源 | 处置 | 需求 |
|------|------|------|
| 问题 4 | ✅ 做 | **需求 A**：资金对账面板两个《导出文件》按钮按面板模式互斥禁用 |
| 问题 3 | ✅ 做 | **需求 B**：银行对账单预加工「导出文件」替换为「未命中场景 / 命中场景」双 sheet 新格式 |
| 问题 5 | ✅ 做 | **需求 C**：中台退款订单回填**全链路开通**（引擎/writer 现成，缺通路 + 提醒框） |
| 问题 1 | ❌ 搁置 | 链接表「日期范围/更新日期」清空：代码层无清空路径（migration 幂等、ADM 派生独立 try/catch 不碰 meta），需用户复现才能定位 |
| 问题 2 | ❌ 不改 | 「资金对账不平」提示框：确认为正常逻辑（`renderer.js:3649` C3 `gateway-recon-join` 启用保护），用户已理解 |

**核心基调**：经核查，需求 C 的对账引擎、导出 writer、字段映射、4×4 矩阵、JPM HK/US 双分支**已在 beta.3/4 完整实现**（详见 §四 与 GAP 报告）。本迭代以**最大化复用现成、最小化改动**为原则——需求 C 引擎/writer 零改，仅开通通路 + 补提醒框。

> 文档三件套（CHANGELOG / VERSION_FEATURE_HISTORY / USER_GUIDE）按 beta 惯例**本迭代不更新**，留待 2.1.16 转正统一更新。

---

## 二、需求 A（问题 4）：两个《导出文件》按钮 mode 互斥

### 2.1 现状（代码出处）

资金对账数据处理面板有两条线，各有一个《导出文件》按钮：

| 按钮 | 元素 | 现有 disabled 逻辑 |
|------|------|------|
| 预加工组导出（《导入对账单》右侧） | `bankStatementExportBtn` | `disabled = !state.processingResult`（`renderer.js:3412`） |
| 不平表组导出（《导入不平表》右侧） | `bankStatementGatewayReconExportBtn` | **无任何 disabled 管理**（`renderer.js:5378` 仅绑 click）→ 永远可点 |

面板模式 `state.bankStatementProcessRunMode`（`renderer.js:173`，`'bank'` | `'gateway'`）已存在且正确切换：
- 导入对账单成功 → `'bank'`（`renderer.js:3534`）
- 导入不平表成功 → `'gateway'`（`renderer.js:4108`）

⚠️ 关键约束：导入不平表成功路径**不走** `updateBankStatementUi()`，而是单独调 `updateBankStatementRunBtnDisabled()`（`renderer.js:4109`，注释见 `3416`）。故 export 互斥逻辑必须抽成 helper，让**两条路径都能刷新**。

### 2.2 需求

两个导出按钮按面板模式**互斥**：

- 面板 `mode==='bank'`（最近导入对账单）：预加工组导出按原条件（`processingResult` 存在）可点；**不平表组导出禁用**。
- 面板 `mode==='gateway'`（最近导入不平表）：不平表组导出按 `reconIdFixSession` 就位可点；**预加工组导出禁用**。

### 2.3 验收标准

| AC | 场景 | 期望 |
|----|------|------|
| A-1 | 导入对账单成功后 | 不平表组《导出文件》禁用；预加工组导出在「开始运行」后可点 |
| A-2 | 导入不平表成功后 | 预加工组《导出文件》禁用；不平表组导出可点 |
| A-3 | 初始（都未导入） | 两个导出按钮均禁用 |
| A-4 | bank→gateway→bank 来回切 | 每次切换后互斥关系正确、无"两个都亮"或"该亮的不亮" |

---

## 三、需求 B（问题 3）：预加工导出替换为「未命中 / 命中场景」双 sheet

### 3.1 现状（代码出处）

`bank-statement:export`（`main.js:3646`）→ `writeBankStatementMainOutput`（`bank-statement-io.js:227`）→ `writeBankStatementOutput`，现输出：
- sheet1 `'渠道对账单'`：命中行（`modifiedRows`）标黄
- sheet2 `'未命中场景行'`：未命中行（`unmatchedRows`）原始字段

数据来源 `scenario-dispatcher` 处理结果（`scenario-dispatcher.js`）：
- `modifiedRows`：命中行，每行带 `_modifiedColumns: Set` + `_hitScenarioId` + `_hitScenarioName`
- `unmatchedRows`：未命中行
- `modifications: Array<{ rowId, column, oldValue, newValue, scenarioId, scenarioName }>`（**字段级变更明细，命中明细列的数据源，现成**）
- 不变量：`modifiedRows + unmatchedRows = bankRows`（互斥完整）

模板：`assets/银行对账单.xlsx`（存在）。

### 3.2 需求（新双 sheet 格式）

**替换** `writeBankStatementMainOutput` 的输出格式（破坏性变更，已确认）：

#### sheet1「未命中场景」
- 名称：`未命中场景`
- **第 1 行 A1 单元格**：加粗文本 `请检查，导入前请删除该sheet`
- **第 2 行**：表头（列名）
- **第 3 行起**：未命中行数据（`unmatchedRows`），排序规则：
  - **先**显示 `FundType === 'Mark without result'` 的行（"Mark without result" 是银行对账单 FundType 列的**数据值**，非引擎标记）
  - **再**显示其他未处理（未命中）行

#### sheet2「命中场景」
- 名称：`命中场景`
- **保留原"渠道对账单标黄"**（命中行 `modifiedRows` 标黄，**不删**）
- **第一列插入新列**「命中明细」，内容组成（每条变更一段，多字段多段拼接）：
  ```
  <命中场景:"场景名称";"发生变更值的字段名";变更前:"变更前的值";变更后:"变更后的值">
  ```
  - 数据源 = 现成 `modifications`（引擎不动）；同一行多个变更字段 → 多段拼接（分隔符见 §九 B-Q2）

### 3.3 验收标准

| AC | 场景 | 期望 |
|----|------|------|
| B-1 | 导出后打开文件 | sheet1 名「未命中场景」，A1 加粗"请检查，导入前请删除该sheet" |
| B-2 | sheet1 含 FundType=Mark without result 行 | 这些行排在其他未命中行**之前** |
| B-3 | sheet2 名「命中场景」 | 命中行**仍标黄**，第一列为「命中明细」列 |
| B-4 | 某命中行改了 N 个字段 | 命中明细列含 N 段，每段格式正确、改前/改后值准确（与 modifications 逐条对应） |
| B-5 | 全部命中 / 全部未命中边界 | sheet1 或 sheet2 为空时仅含 A1 提示 / 表头，不报错 |
| B-6 | 行数守恒 | sheet1 行数 + sheet2 行数 = 原始总行数 |

⚠️ **破坏性提醒**：此变更改写对账主产物的 sheet 名与结构。需确认无下游脚本/用户流程依赖旧 sheet 名「渠道对账单」「未命中场景行」。

---

## 四、需求 C（问题 5）：中台退款订单回填全链路开通

### 4.1 现状：引擎已完整实现，但「整条通路未通电」

经 GAP 逐条核对（见 `退款回填规则原文与GAP核对-v2.1.16-beta.6.md`），现有实现**吻合度高**：

| 组件 | 文件 | 状态 |
|------|------|------|
| 对账引擎（4×4 矩阵 + JPM HK/US） | `scenario-engines/r5-refund-order-backfill.js`（595行） | ✅ 完整，对齐 Q1~Q15 |
| 字段映射 | `constants/refund-backfill-fields.js` | ✅ 完整 |
| 导出 writer（双 sheet） | `main-process/refund-backfill-writer.js` | ✅ 完整 |
| 内置场景 seed | `migrations.js:1534`「中台退款订单回填」(enabled=0 休眠) | ✅ 已种 |

**但生产态喂给引擎的退款数据恒为 `[]`，引擎休眠**：
- 门控关闭：`const ZHONGTAI_REFUND_BATCH_ENABLED = false`（`main.js:11305`）
- 退款 session 恒 null：`let refundOrderSession = null`（`main.js:295`）
- 导入被跳过：`main.js:11459` `zhongtai-refund-order` → `status='disabled'`（不读不写）
- 引擎入参硬桩：`main.js:3608` `refundOrderSession ? ... : []  // 本轮恒 []`

### 4.2 需求：开通通路（引擎/writer 零改）

#### P0-1 开门控
- 解除 `ZHONGTAI_REFUND_BATCH_ENABLED` 门控（`main.js:11305`），打通 `zhongtai-refund-order` 导入分支（`main.js:11459`）。

#### P0-2 退款订单导入落 session（入口：复用《导入对账单》批量多选，**无独立按钮**）
- **入口现成**：《导入对账单》按钮 `bankStatementImportBtn` → `handleBankStatementBatchImport`（`renderer.js:3508`）→ `bank-statement:batch-import`（`main.js:11314`）。用户**一次多选**文件（银行对账单 + 中台退款订单 + …），main 逐文件 `detectTableType(PREPROCESS_TABLE_SIGNATURES)` 表头识别路由。
- **候选集已含**：`PREPROCESS_TABLE_SIGNATURES` = 银行对账单 + 中台退款订单 + 入账原始订单（`table-signatures.js:197-199`）。
- **UI 渲染已预留**：`buildBatchImportSummaryHtml`（`renderer.js:3445`）已有 `'zhongtai-refund-order': '中台退款订单'` 标签（`:3450`）+ `otherOk` 成功渲染分支（`:3481`）。
- **开通点**：`main.js:11459` 现返回 `status='disabled'`（标"未启用跳过"）→ 改为读取行 → 写 `refundOrderSession`（`main.js:295`）→ 返回 `status='ok'`（前端 otherOk 分支自然显示"文件 → 中台退款订单（N 行）"）。
- 数据落 **session**（预加工，非链接表），与现有设计一致。

#### P0-3 解引擎/导出硬桩
- `main.js:3608`：去掉 `// 本轮恒 []`，注入真实 `refundOrderSession.rows`（接线 `3618` `refundContext` 已就绪）。
- `main.js:3786` 导出 block：`refundBackfillRows` 非空时自然进入（writer 已接）。
- `depositRows`（入金表，JPM-US 用）注入 `3607` 已就绪。

#### P0-4 前端导入提醒框（你的规则一，新需求）
- **触发条件**：场景管理里启用了「中台退款订单回填」场景（`migrations.js:1534`，enabled=1）。
- **行为**：用户走《导入对账单》批量导入**完成后**，检查本批结果——若本批**未识别到**中台退款订单表 → 弹提醒框「需要导入中台退款订单表」；若本批**已识别到**该表（落了 session）→ **不弹**。
- **判定数据源**：`bank-statement:batch-import` 返回的 `results` 里是否含 `tableKey==='zhongtai-refund-order'` 且 `status==='ok'` 的项。
- **实现范式 + 接入点**：仿 `maybePromptGatewayReconImport`（`renderer.js:3547`）；接入点在 `handleBankStatementBatchImport` 弹完批量明细之后（`renderer.js:3537` 附近）。

### 4.3 引擎业务规则（权威 spec）

完整规则见 **`退款回填规则原文与GAP核对-v2.1.16-beta.6.md`**（用户 2026-06-08 原文逐字存档 + GAP 核对结论）。摘要：

- 参与对账：银行 `FundType=Ach Return` 且 FundType 未被 R4 改写 ↔ refund `状态=SUBMITTED`
- 唯一值分组：渠道大账号(`MerchantId`↔银行大账号) + 金额(`|Credit−Debit|`↔退款金额) + 币种
- 4 基数（bank 1/N × refund 1/N）× 4 策略（S1 渠道流水号 → S2 附言 MTX → S3 付款人/卡号/虚拟卡号 → S4 金额币种日期），命中即停
- JPM-HK：清洗 `//` → 提 `T54SWIC\d{6}` → **仅比 refund 银行打款流水号单字段**（Q7，本轮确认维持）
- JPM-US：refund 银行打款流水号 → 入金表 ReconId/ChannelOrderNo → CustomerRef ↔ bank CustomerRef
- 回填动作：refund 流水号→退款单号、状态→SUCCESS、bank ReconId→渠道流水号、bank BillDate→渠道退款时间、记命中详情
- 导出：sheet1 回填模板（E 列命中详情 + F~N 银行字段）、sheet2 未匹配 + 报错信息

### 4.4 验收标准

| AC | 场景 | 期望 |
|----|------|------|
| C-1 | 启用退款场景 + 导入对账单不带退款表 | 弹提醒「需导入中台退款订单表」 |
| C-2 | 启用退款场景 + 导入对账单已带退款表 | **不弹**提醒，退款表落 `refundOrderSession` |
| C-3 | 未启用退款场景 | 不弹提醒（导入退款表也跳过，回到休眠语义） |
| C-4 | 启用 + 导入两表 + 开始运行 | 引擎跑出 backfillRows，状态框/导出反映回填行数 |
| C-5 | 导出退款回填文件 | sheet1 回填模板（E 命中详情 + F~N 银行）、sheet2 未匹配+报错；命中详情文案符合规则备注 2 |
| C-6 | 1:1 / 1:N / N:1 / N:N 四基数样本 | 回填/报错/提示与规则一致（重点 §八 手测） |
| C-7 | JPM-HK / JPM-US 样本 | 按 §4.3 JPM 分支正确回填 |
| C-8 | 引擎/writer 代码 | **零改**（diff 仅 main.js 通路 + renderer.js 提醒框 + 测试） |

⚠️🔴 **资金红线**：开通后真实退款数据首次流经引擎，改写退款单状态机 + 回填对账 ID。**必须**真实样本跑通四基数 + JPM 双分支 + 现有单测全绿后才可合并。

---

## 五、关键决策记录

| # | 决策 | 选择 | 轮次 |
|---|------|------|------|
| D1 | 本批范围 | 问题 3/4/5 做；1 搁置、2 不改 | 第二轮 |
| D2 | 版本落点 | 新开 v2.1.16-beta.6 | 第二轮 |
| D3 | 问题 3 落地 | 替换现有预加工导出（破坏性） | 第二轮 |
| D4 | 问题 5 范围 | 导入+引擎+导出全打通 | 第二轮 |
| D5 | 问题 3 命中场景 sheet | 保留原标黄 + **加**命中明细列（非替代） | 第三轮纠正 |
| D6 | JPM-HK 匹配范围 | 维持单字段（Q7），引擎零改 | 第三轮 |
| D7 | 退款导出模板 | 代码重建表头（现状），writer 零改 | 第三轮 |
| D8 | Mark without result | 银行对账单 FundType 列数据值（导出层排序） | 第三轮 |
| D9 | 命中明细数据源 | 引擎不动，导出层消费现成 `modifications`，多字段多段拼 | 第三轮 |
| D10 | 提醒框触发载体（假设） | 场景管理启用「中台退款订单回填」场景时触发 | 假设，待评审确认 |

---

## 六、风险与人工复核点（🔴 资金红线）

| 风险 | 说明 | 缓解 |
|------|------|------|
| 退款单状态机 | `SUBMITTED→SUCCESS` 仅写回填模板，不回写持久层（Q11） | 引擎零改，沿用现成；测试核对模板状态列 |
| 回填字段错位 | ReconId/BillDate/流水号 跨表回填，列名错位即写错钱 | 引擎/字段映射零改（现成已验证） |
| 1v1 单向消费 + 报错/提示分级 | 多笔报错 vs 未匹配提示方向 | 引擎零改；手测四基数样本核对 |
| 导出格式破坏（需求 B） | 改对账主产物 sheet 名/结构 | 确认无下游依赖旧 sheet 名；行数守恒断言 |
| 提醒框误判（需求 C P0-4） | 表头识别去重逻辑错 → 该弹不弹/不该弹乱弹 | 仿成熟 `maybePromptGatewayReconImport`；C-1~C-3 覆盖 |
| 门控开通副作用 | 解桩后真实数据首次入引擎 | 解桩 + 全链路手测 + release-check 全绿才合并 |

---

## 七、PR 拆分（每 PR 3-6 文件，独立可验证）

| PR | 需求 | 关键文件 | 依赖 |
|----|------|---------|------|
| **PR-1** | 需求 A（问题 4） | `renderer.js`（抽 `updateBankStatementExportButtonsDisabled` helper，两路径调用） | 无 |
| **PR-2** | 需求 B（问题 3） | `bank-statement-io.js`、`bank-statement-writer`（双 sheet 重构）、`main.js`（透传 modifications）、测试 | 无 |
| **PR-3** | 需求 C（问题 5） | `main.js`（门控/导入/session/解桩）、`renderer.js`（提醒框 P0-4）、测试 | 无（引擎/writer 零改） |
| **收尾** | 版本+文档 | `package.json`/`package-lock.json` bump、本 PRD/TECH 归档；`/check-vars` + `npm run scan:vars` | PR-1~3 |

> bump 版本 / 合并前必须跑 `/check-vars`（命中 `bankStatementProcessRunMode` / `refundOrderSession` / 金额 / ReconId 等）+ `npm run scan:vars`。
> 前端改动（PR-1/PR-3 动 renderer.js）提 PR 前重跑 `npm run preview`。

---

## 八、测试矩阵

### 单元（`tests/unit/`）
- 需求 A：mode 互斥 disabled helper（bank/gateway/初始/来回切）—— 若可抽纯函数
- 需求 B：双 sheet 写出（A1 提示 / FundType 排序 / 命中明细多段拼接 / 行数守恒 / 空边界）
- 需求 C：batch-import 退款分支落 session（门控开）；提醒框触发判定（启用×带表/不带表矩阵）—— 纯逻辑部分

### 集成（`scripts/integration/`）
- 需求 C 端到端：导入退款表+银行对账单 → run → backfillRows + 导出双 sheet 校验

### 手测（真实样本，🔴 资金红线，记入待测清单）
- 需求 C 四基数（1:1 / 1:N / N:1 / N:N）回填/报错/提示
- 需求 C JPM-HK（清洗//提T54SWIC）/ JPM-US（入金表→CustomerRef）
- 需求 C 提醒框 C-1~C-3
- 需求 B 导出双 sheet 肉眼核对（标黄保留 + 命中明细 + FundType 排序 + A1 提示）

### 回归
- `npm run release-check`（PASS/FAIL 源）
- `npm run preview`（前端改动）

---

## 九、待确认 / 遗留

| # | 项 | 默认假设 | 待确认 |
|---|----|---------|--------|
| B-Q1 | 未命中 sheet 表头行 | ✅ **已定：加表头**——第 1 行 A1 提示、第 2 行表头、第 3 行起数据 | — |
| B-Q2 | 命中明细多段分隔符 | ✅ **已定：换行**（单元格 wrapText 多行，每个字段变更独占一行） | — |
| C-Q1 | 提醒框触发载体（D10） | 场景管理启用「中台退款订单回填」场景 | 评审确认 |
| 遗留-1 | 问题 1（链接表清空） | 搁置，待用户复现信息 | 用户补：升级前版本/纯升级或重导/哪张表/数据行在否 |
