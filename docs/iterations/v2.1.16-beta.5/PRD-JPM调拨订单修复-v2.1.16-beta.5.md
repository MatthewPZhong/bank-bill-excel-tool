# PRD - 网银账单小助手 v2.1.16-beta.5「JPM 调拨订单修复」

| 项目 | 内容 |
|------|------|
| 版本 | v2.1.16-beta.5 |
| 日期 | 2026-06-08 |
| 作者 | PM |
| 状态 | 定稿（设计，待实现）｜10 条决策已全部确认 |
| 模块 | 资金对账数据处理 ↔ 对账单 ReconID 修复（网关子模式）+ 链接表管理 + 网关对账单修复-场景管理 |
| 依赖 | ① `linked_bank_deposit`（银行对账单表，v2.1.16-beta.3 ② 已实现）、② `linked_mid_allocation`（中台调拨订单，`ZHONGTAI_DISPATCH_ORDER_SIGNATURE`）、③ 网关 ReconID 修复链路（`recon-id-fix:import/run/export` 已实装）、④ gateway 4-sheet 字段常量 `gateway-bill-recon-fields.js` |

> 🔴 **资金对账敏感迭代**：本迭代新增「渠道账单 ↔ ADM 银行对账单表 ↔ 网关账单」三段自动匹配链路，命中后写入资金对账ID（reconciliationId）、网关账单 Reference / Type、ADM 表匹配标志。任一字段映射 / 金额汇总 / 批次 gating 判定错误 → 写错资金对账 ID 或网关修复行，直接污染资金对账结果。**本版只产出 PRD + TECH 设计文档，不落地任何代码（不碰 `src/`）**。10 条语义决策已由用户逐条敲定（见第「九」章），可作实现版本蓝本。

---

## 一、需求概述

本文件描述 **5 项**需求：

1. **需求1（前端接线）**：「资金对账数据处理」模块的「导入不平表 / 导出文件」两个按钮，复用「对账单 ReconID 修复」网关子模式（`gateway-recon-id-fix`）的 import / export 链路。
2. **需求2（改名）**：链接表管理弹窗里表库名「银行对账单入金表」→「银行对账单表」。
3. **需求3（新增隐藏表 + 派生逻辑）**：导入银行对账单表（其中 `Channel=ADM` 行）后，派生一张隐藏的「ADM 银行对账单链接表」，并与中台调拨订单表（`linked_mid_allocation`）匹配回填调拨号 / 调拨入金金额。
4. **需求4（场景 seed）**：「网关对账单修复-场景管理」新增一条自带写死场景「JPM调拨订单修复」（默认休眠）。
5. **需求5（新增引擎）**：JPM 调拨订单修复引擎，按「渠道账单 ↔ ADM 表 ↔ 网关账单」三段匹配产出网关对账单修复行，复用网关导出。

---

## 二、背景与目标

### 2.1 背景

- **为什么要做**：「资金对账数据处理」模块与「对账单 ReconID 修复」模块此前是两条独立流水线，网关对账数据无法贯通；JPM 银行（`Channel=ADM`）的调拨订单缺少自动化对账修复手段，需人工核对渠道账单 / 网关账单 / 中台调拨订单三方数据，逐条比对出账日期、金额汇总、调拨号，效率低且易错。
- **用户 / 业务价值**：把两个模块的网关导入 / 导出打通（需求1），并新增一条全自动的 JPM 调拨订单修复链路：从银行对账单表派生隐藏的「ADM 银行对账单链接表」（关联中台调拨订单），再由写死场景「JPM调拨订单修复」完成三段匹配，最终产出可导出的网关对账单修复文件，把人工只留给「未匹配报错介入」少数兜底场景。
- **当前问题**：
  1. 资金对账模块「导入不平表」走的是旧 `importGatewayRecon` 占位 IPC、「不平校验导出」是 `showComingSoon` 纯占位（`src/renderer.js:5199-5206`），与已实装的网关 ReconID 修复链路割裂。
  2. 银行对账单表里 `Channel=ADM` 的调拨入金行，与中台调拨订单（调拨单号 / 渠道流水号 / 收款金额）、网关账单（OrderId）之间的三方关联关系散落在多字段，无统一派生与匹配规则。
  3. 网关账单的修复（Reference / Type 回写）目前只能走 C4 渠道账单 ReconID 修复，无法处理 JPM 调拨这种「渠道账单按出账日期整组金额汇总 → ADM 表 → 网关账单」的多段聚合匹配。

### 2.2 目标

- **需求1**：「导入不平表」改绑 `reconIdFix.import({subMode:'gateway'})`、「不平校验导出」改绑《开始运行》（运行场景管理里已启用的 `gateway-recon-id-fix` 场景）+ `reconIdFix.export()`，与 ReconID 修复网关子模式共用同一套 session / 引擎 / 导出（后端零改动）。
- **需求2**：链接表管理弹窗第 5 行表库名改为「银行对账单表」。
- **需求3**：新增隐藏链接表 `linked_adm_bank_deposit`，在导入银行对账单表落库成功后派生：筛 `Channel=ADM` ∧ 指定 FundType 行 → 生成批次号 → 与中台调拨订单按「CustomerRef ↔ 渠道流水号」唯一匹配回填调拨号 / 调拨入金金额；部分成功仍建表，未匹配行弹报错框列明。
- **需求4**：新增写死场景「JPM调拨订单修复」，`category='gateway-recon-id-fix'`，默认 `enabled=0` 休眠，用户手动启用后才运行。
- **需求5**：新增 JPM 调拨订单修复引擎，8 步状态机完成三段匹配，复用网关导出列模板（`ORDER_REPAIR_FIELDS_GATEWAY`）。

### 2.3 明确不做

- **本版不实现任何代码**（不碰 `src/`）。仅产出 PRD + TECH 设计文档作为后续实现版本蓝本。
- 需求1 不改后端 ReconID 修复 IPC（`recon-id-fix:import/run/export`）的契约，仅前端按钮改绑。
- 需求3 不把 ADM 隐藏表暴露给链接表管理弹窗（不进 `ALL_TABLE_KEYS` / `LINKED_TABLE_LABELS`）。
- 不改现有 C4 渠道账单 / 网关账单 ReconID 修复算法；JPM 引擎是 `runReconIdFix` 内新增的分流分支。
- 不在 JPM 引擎内重新实现日期解析 / 金额归一 / 提取 regex —— 复用 `engine-utils` / `engine-date-utils`（`toDate` / `parseNumber` / `normalizeCellValue` / `makeWarningCollector`）与 `normalizers.normalizeDateExportValue`。

---

## 三、代码现状（必须有出处）

| 主题 | 相关文件 | 当前行为 | 已知限制 |
|------|---------|---------|---------|
| 资金对账三按钮 | `src/renderer.js:5199-5206` | 「导入不平表」→ `handleBankStatementImportGatewayRecon`（旧 `importGatewayRecon` IPC）；「不平校验导出」→ `showComingSoon('资金对账不平校验导出')` 占位；「链接表管理」→ `createLinkedTableManagerDialog()` | 与已实装的网关 ReconID 修复链路割裂，无《开始运行》入口 |
| 网关 ReconID 修复链路 | `src/main.js`：`recon-id-fix:import`(:3907) / `recon-id-fix:run`(:3958) / `recon-id-fix:export`(:4009) | 已实装。`recon-id-fix:run` 当前调 `runReconIdFix(scenario, clonedSheets)`（**2 参**，:3990），gateway 子模式校验 `scenario.category==='gateway-recon-id-fix'` | `runReconIdFix` 当前不接收 admRows；需新增第三参注入 |
| ReconID 修复顶层引擎 | `src/main-process/recon-id-fix-engine.js`：`runReconIdFix(scenario, sheets)`(:12) | 校验 category ∈ `['recon-id-fix','gateway-recon-id-fix']`(:10)，按 category 推导 subMode，调 `runC4Scenario(scenario, sheets, subMode)` | 单一落点；需加 `config.subCategory==='jpm-dispatch-order-fix'` 分流到新引擎 |
| gateway 4-sheet 字段 | `src/constants/gateway-bill-recon-fields.js` | `CHANNEL_BILL_FIELDS`（渠道账单 16 列，小写：`merchantId`/`reconciliationId`/`receiveAmount`/`additionInfo`，:22）；`GATEWAY_BILL_FIELDS`（网关账单 31 列，驼峰：`MerchantId`/`OrderId`/`Reference`，:14）；`ORDER_REPAIR_FIELDS_GATEWAY`（导出 14 列，:29） | 🔴 网关账单 Type 列名是**超长串且缺右括号**：`GATEWAY_BILL_FIELDS[8]` = `'Type(0:1对1,1:1对多,2:多对1,3:多对1（轧差合并)'`，必须以 `GATEWAY_BILL_FIELDS[8]` 引用，禁止手敲。⚠️ `src/preload.js` 顶部 inline 一份副本，改内容需同步 |
| 写死场景 seed | `src/backend/database/migrations.js`：`RECON_ROUND_BUILTIN_SCENARIOS`(:1424) / `ensureReconRoundBuiltinScenariosSeed`(:1554) / `BUILTIN_SCENARIOS`(:313) | 各 seed 各有独立 `SEEDED_MARKER`，幂等模式：前置校验 CHECK 含目标 category + marker 已写则短路 + 凭 `config_json LIKE` 定位已存在则跳过 + BEGIN/COMMIT/ROLLBACK | gateway 场景的 category=`gateway-recon-id-fix` 已存在于 scenarios CHECK；无需扩枚举 |
| 场景「功能类别」显示 | `src/renderer-dialogs.js`：`SCENARIO_CATEGORY_LABELS['gateway-recon-id-fix']='网关对账单修复'`(:5604) / `FUNC_CATEGORY_LABELS`(:5619) / `getScenarioCategoryDisplay`(:5625) | builtin-fixed 场景按 `config.funcCategory` 映射显示；**无 funcCategory 时回退 `getCategoryLabel(category)`**。JPM 场景 category='gateway-recon-id-fix' → 回退到 `SCENARIO_CATEGORY_LABELS['gateway-recon-id-fix']` = 「网关对账单修复」 | JPM 场景不带 funcCategory，自动回退即得正确分组名 |
| 链接表仓储 | `src/backend/database/linked-table-repository.js`：`LINKED_TABLE_DEFS`(:58) / `BANK_DEPOSIT_FIELDS`(13字段,:29) / `replaceLinkedTable`(:176) / `readLinkedTableRows`(:256) / `ALL_TABLE_KEYS`(:110) | `replaceLinkedTable` **硬编码 4 列**（keyColumn / dateColumn / raw_json / imported_at，INSERT SQL :188）；`readLinkedTableRows` 按 raw_json 还原整行 | ADM 表 6 新字段无键列容身，须新增独立仓储函数（不能复用 `replaceLinkedTable` 4 列硬编码） |
| 链接表建表 | `src/backend/database/migrations.js`：`ensureLinkedTableSupport`(:2531) | 事务内建 `linked_table_meta` + 4 张数据表（含 `linked_bank_deposit`），各 CREATE TABLE / INDEX IF NOT EXISTS 幂等 | ADM 表须新增独立 migration（独立 marker 或紧邻本函数追加 CREATE IF NOT EXISTS） |
| 链接表导入 handler | `src/main.js`：`linked-table:import`(:11135) | bank-deposit 落库在 :11205-11208（`pickBankDepositFields` 裁 13 列 → `replaceLinkedTable('bank-deposit', ...)`），成功后 push results | ADM 派生须挂在 bank-deposit 落库成功之后；当前 handler 无中台读取与 ADM 派生 |
| 中台调拨订单 | `src/constants/table-signatures.js`：`ZHONGTAI_DISPATCH_ORDER_SIGNATURE`(:94) | 26 列，含「调拨单号」(idx0)、「渠道流水号」(idx3)、「收款金额」(idx9)；落 `linked_mid_allocation`（keyColumn=allocation_no，仓储 def :67） | `readLinkedTableRows('mid-allocation')` 读回整行对象，字段名 = 中文真实表头 |
| 表库标签 | `src/renderer-dialogs.js`：`LINKED_TABLE_LABELS`(:6166) | 5 项：`gateway-bill`='网关对账单表库' / `mid-allocation`='中台调拨订单表库' / `fx-settlement`='外汇交割表库' / `fx-option`='外汇期权表库' / `bank-deposit`='银行对账单入金表'(:6172)。⚠️ 唯独 bank-deposit 无「库」后缀 | 需求2 改 `bank-deposit` → '银行对账单表' |
| 表签名 label | `src/constants/table-signatures.js`：`BANK_DEPOSIT_SIGNATURE.label`(:185) | '银行对账单入金表'（导入识别用，44 列同构 `BANK_STATEMENT_FIELDS`，仅在 `LINKED_IMPORT_SIGNATURES` 暴露） | 需求2 改 label → '银行对账单表'（评估是否同步，见 §九 决策2） |
| 报错弹框范式 | `src/renderer-dialogs.js`：`createAlertDialog`(:295) / `buildImportSummaryHtml`(:6255) | `createAlertDialog(html, options)` 渲染 HTML 弹框；`buildImportSummaryHtml(results)` 把 per-file results 渲染成「成功 N 张 / 失败 M 张 + 每文件原因」 | ADM 未匹配报错框可复用此范式渲染未匹配行清单 |
| 最佳复刻范本 | `src/main-process/scenario-engines/r5-refund-order-backfill.js` / `r5-fund-transfer-backfill.js` | 金额 `Math.round(x*100)` 分级比较（`amountEqual`）；1v1 单向消费（`usedBankRowId`）；`makeWarningCollector`；显式跨表字段映射注释 | JPM 引擎复刻其金额分级 / 1v1 / 警告收集范式 |

> 说明：以上文件均已逐一 Read 核对。`runReconIdFix` 当前 2 参签名、`GATEWAY_BILL_FIELDS[8]` 超长缺括号串、`replaceLinkedTable` 4 列硬编码、`LINKED_TABLE_LABELS['bank-deposit']` 当前值均经源码确认。实现期 dev 须再次核对精确行号（本文档行号为核对时快照）。

---

## 四、术语

| 术语 | 含义 |
|------|------|
| 渠道账单 | gateway 4-sheet 之一（`CHANNEL_BILL_FIELDS`，小写表头）。含 `merchantId`/`reconciliationId`/`receiveAmount`/`additionInfo`。JPM 场景过滤 `merchantId===6300156616` |
| 网关账单 | gateway 4-sheet 之一（`GATEWAY_BILL_FIELDS`，驼峰表头）。含 `MerchantId`/`OrderId`/`Reference`/`Type`(idx8) |
| ADM 表 / ADM 银行对账单链接表 | 隐藏链接表 `linked_adm_bank_deposit`。由银行对账单表 `Channel=ADM` 行派生，13 银行字段 + 6 新字段 |
| 中台调拨订单 | 链接表 `linked_mid_allocation`（`ZHONGTAI_DISPATCH_ORDER_SIGNATURE`）。含「调拨单号」/「渠道流水号」/「收款金额」 |
| 批次号 | ADM 行分组键 = `<规范化BillDate>-<ChannelOrderNo>`（按 ChannelOrderNo 分组，组内取首个可解析 BillDate 规范化）。一个批次号可跨多个出账日期 |
| 出账日期 | 从渠道账单 `additionInfo` 内 `YY/MM/DD` 提取并补世纪为 `20YY-MM-DD`。一个出账日期对一笔渠道账单 |
| Fundtransfer-in金额 / 调拨入金金额 | ADM 行 6 新字段之一 = 中台「收款金额」回填值。步骤4 按出账日期整组汇总与 `receiveAmount` 比较 |
| 资金对账ID | 渠道账单 `reconciliationId`。命中后赋给 ADM 行「资金对账ID」、网关账单 `Reference` |
| 1v1 消费 | 渠道账单行 / 网关账单行命中后单向消费（不再被复用），仿 `r5-*` 的 `usedBankRowId` 范式 |
| 部分成功仍建表 | 需求3 ADM 匹配：已匹配行赋值、未匹配行留空 + 报错框列出，整表仍落库（非全成功才建表） |
| 冲突（两侧任一重复） | CustomerRef ↔ 渠道流水号匹配时，中台侧或 ADM 侧任一出现重复（非唯一）即判冲突，不赋值、进报错框（防步骤4金额汇总重复累加） |

---

## 五、功能详细描述

### 5.1 需求1：资金对账「导入不平表 / 导出文件」复用网关 ReconID 修复

#### 5.1.1 说明

- **导入不平表**：`src/renderer.js:5199-5206` 的「导入不平表」按钮（旧绑 `handleBankStatementImportGatewayRecon`）改绑调用 `reconIdFix.import({subMode:'gateway'})`，与「对账单 ReconID 修复」网关子模式共用 session（`recon-id-fix:import` IPC，`src/main.js:3907`）。导入资金不平结果表（4 sheet：网关账单 / 渠道账单 / 对账结果 / 订单修复，由 IO 层按 subMode 读对应 sheet）。
- **不平校验导出**：原 `showComingSoon` 占位改为两步：先《开始运行》运行场景管理里**已启用**的 `gateway-recon-id-fix` 场景（含 JPM 场景），再调 `reconIdFix.export()`（`recon-id-fix:export` IPC，`src/main.js:4009`）导出网关对账单修复文件。
- **后端零改动**：需求1 不改 `recon-id-fix:import/run/export` 契约，仅前端按钮改绑 + 补《开始运行》入口。

#### 5.1.2 《开始运行》交互（决策2 + 决策3）

资金对账「不平校验」流程在「导入不平表」与「不平校验导出」之间补一个《开始运行》动作（UI 形态见 §5.6 Mockup A）：

1. 用户点「导入不平表」→ `reconIdFix.import({subMode:'gateway'})` 导入 4-sheet。
2. 用户点《开始运行》→ 取场景管理里**已启用**的 `gateway-recon-id-fix` 场景 → 调 `recon-id-fix:run`（携带选中场景 id）。
   - 若选中 JPM 场景：前提是渠道账单 sheet 存在 `merchantId===6300156616` 的行（否则空结果 + 提示，引擎不触发，见 §5.5 步骤1）。
   - 引擎读 ADM 隐藏表（`readAdmBankDepositRows()`）做匹配回写。
3. 用户点「不平校验导出」→ `reconIdFix.export()` 导出网关对账单修复文件（列模板 `ORDER_REPAIR_FIELDS_GATEWAY`）。

#### 5.1.3 影响范围

- **前端**：仅 `src/renderer.js:5199-5206` 三按钮改绑 + 《开始运行》入口；UI 是否新增按钮 vs 复用现有控件由 TECH 阶段定。改前端须回归 `npm run preview`。
- **后端**：零改动（复用既有 IPC）。

---

### 5.2 需求2：链接表管理表库名「银行对账单入金表」→「银行对账单表」

- **改 UI 展示**：`src/renderer-dialogs.js:6172` `LINKED_TABLE_LABELS['bank-deposit']` → '银行对账单表'（链接表管理弹窗第 5 行 + 导入结果明细 `buildImportSummaryHtml` 复用同一 map，一处改全生效）。
- **改导入识别 label（评估）**：`src/constants/table-signatures.js:185` `BANK_DEPOSIT_SIGNATURE.label` → '银行对账单表'。该 label 用于导入识别提示，与 UI 表库名应保持一致（见 §九 决策2）。
- 🔴 **波及面提示**：全仓 grep `银行对账单入金表` 命中多处，其中：
  - **退款回填命中详情文案**：`src/main-process/scenario-engines/r5-refund-order-backfill.js`（JPM-US 二跳详情句式含「银行对账单入金表」）+ 对应单测断言。这是退款回填导出 sheet1「匹配命中详情」E 列的用户可见文本，改名会影响导出文案与单测。
  - **场景 involvedFiles**：`src/backend/database/migrations.js`（退款回填场景 config 含 '银行对账单入金表'）+ seed 单测断言。
  - **代码内部注释 / 常量名说明**（不影响行为）。
  - ⚠️ 是否全局统一改（含退款回填文案 + involvedFiles + 注释）由 TECH 阶段确认；§九 决策2 给出本版口径。

---

### 5.3 需求3：ADM 银行对账单链接表派生 + 中台调拨匹配（逻辑A）

> 🔴 派生与匹配错误会写错调拨号 / 调拨入金金额，进而让步骤4 金额汇总错配资金对账ID。两侧匹配必须在赋值之前完成唯一性校验。

#### 5.3.1 触发时机

- 在 `linked-table:import` handler 内，某文件被识别为 `bank-deposit`（银行对账单表）**且落库成功后**（`src/main.js:11205-11208` 之后），读取中台调拨订单链接表（`readLinkedTableRows('mid-allocation')`）→ 派生 ADM 行 → 写入 `linked_adm_bank_deposit` → 回传 ADM 创建结果 / 未匹配明细给前端。

#### 5.3.2 筛选条件

- 从银行对账单表 13 字段行中筛：`Channel==='ADM'`（精确等于，大小写敏感）∧ `FundType∈{'Fundtransfer-out','Fundtransfer-out&FX'}`（精确等于，大小写敏感）。
- ⚠️ **FundType 字面值实现时核对** `assets/FundType枚举值.xlsx`：byte-for-byte 一致（大小写 / 连字符 / `&FX` 后缀），防枚举漂移漏筛或误筛。

#### 5.3.3 ADM 行结构（13 + 6 字段）

| 段 | 字段 | 来源 |
|----|------|------|
| 银行 13 字段 | `BizId / BillDate / ValueDate / Channel / 地区 / MerchantId / Currency / Credit Amount / Debit Amount / ReconciliationId / ChannelOrderNo / CustomerRef / FundType` | `BANK_DEPOSIT_FIELDS`（linked-table-repository.js:29）裁后 13 字段 |
| 新增 6 字段 | 批次号 | `<规范化BillDate>-<ChannelOrderNo>` |
| | 调拨号 | 中台「调拨单号」（匹配命中时赋值，否则空） |
| | Fundtransfer-in金额 | 中台「收款金额」（匹配命中时赋值，否则空） |
| | 资金对账ID | JPM 引擎 run 阶段回写（派生阶段空） |
| | 是否与渠道账单匹配 | 初始 `0`（JPM 引擎 run 阶段命中置 1） |
| | 是否与网关账单匹配 | 初始 `0`（JPM 引擎 run 阶段命中置 1） |

#### 5.3.4 批次号生成（决策细化）

- 按 `ChannelOrderNo` 分组，组内取**首个可解析的 BillDate**，用 `normalizeDateExportValue` 规范化为 `YYYY-MM-DD`，批次号 = `<规范化BillDate>-<ChannelOrderNo>`。
- `ChannelOrderNo` 为空 → 批次号为空（不阻断派生，该行仍落库）。
- 🔴 必须用 `normalizeDateExportValue` 规范化（防 Excel 序列号 / 混合日期格式致同组分裂成多个批次号）。

#### 5.3.5 中台匹配（CustomerRef ↔ 渠道流水号，决策9）

- 建 `Map<规范化渠道流水号, [midRow]>`（normKey = `String(value).trim()`，**大小写敏感**）。
- ADM 行用 `CustomerRef`（规范化后）查该 Map：
  - **冲突（两侧任一重复 → 不赋值、进未匹配报错）**：
    - 中台侧 bucket.length > 1（同一渠道流水号对应多条中台行）；**或**
    - ADM 侧同一 `CustomerRef` 出现多行（ADM 侧不唯一）。
  - **clean（两侧都唯一）→ 赋值**：中台「调拨单号」→ ADM「调拨号」；中台「收款金额」→ ADM「Fundtransfer-in金额」。
- 🔴 两侧任一重复都判冲突的原因：防止步骤4 按出账日期整组金额汇总时，重复行被重复累加导致金额对账错误。

#### 5.3.6 报错框（部分成功仍建表，决策4 + 决策9）

- **部分成功**：已匹配行赋值、未匹配行（含冲突 / 无中台匹配 / 空 CustomerRef）调拨号 + Fundtransfer-in金额留空，整表仍落库。
- **报错框**（复用 `createAlertDialog` + `buildImportSummaryHtml` 范式）：列出未匹配行，每行带 `批次号 / CustomerRef / BillDate / ChannelOrderNo` + 错误码：
  - `no-mid-match`：中台无对应渠道流水号
  - `mid-duplicate`：中台侧渠道流水号重复
  - `adm-duplicate`：ADM 侧 CustomerRef 重复
  - `empty-customerref`：ADM 行 CustomerRef 为空
- **中台表为空**时特别提示：「请先导入中台调拨订单表」。
- **全部完成**（无未匹配）弹「ADM银行对账单链接表已创建」。

#### 5.3.7 落库与覆盖

- 新表 `linked_adm_bank_deposit`（隐藏，**不进** `ALL_TABLE_KEYS` / `LINKED_TABLE_LABELS`，前端弹窗看不到），整表覆盖（DELETE + INSERT）。
- 🔴 **重导银行对账单表 = ADM 重建 = 已有匹配标志（是否与渠道账单匹配 / 是否与网关账单匹配 / 资金对账ID）归零**，需 UI 提示用户「重新导入银行对账单表将重建 ADM 表，已有 JPM 匹配结果会清空」。

---

### 5.4 需求4：写死场景「JPM调拨订单修复」seed

- 在 `src/backend/database/migrations.js` 新增 `JPM_DISPATCH_ORDER_SCENARIO` + `ensureJpmDispatchOrderScenarioSeed` + 独立 `SEEDED_MARKER`，幂等补种（仿 `ensureReconRoundBuiltinScenariosSeed`）。
- 字段：

| 字段 | 值 | 说明 |
|------|----|----|
| `category` | `'gateway-recon-id-fix'` | scenarios CHECK 已含此 category，无需扩枚举 |
| `name` | `'JPM调拨订单修复'` | |
| `is_builtin` | `1` | |
| `enabled` | `0` | 🔴 默认休眠（决策10），用户手动启用后才运行 |
| `priority` | `3` | 兜底值；**待实现时验证** compact 单类别视图序号稳定为 1（is_builtin 置顶机制） |
| `config` | `{subCategory:'jpm-dispatch-order-fix', merchantId:'6300156616'}` | **不带 funcCategory** → 自动回退显示「网关对账单修复」 |

- 「功能类别」显示：JPM 场景 category='gateway-recon-id-fix' 且不带 funcCategory → `getScenarioCategoryDisplay`（renderer-dialogs.js:5625）回退到 `SCENARIO_CATEGORY_LABELS['gateway-recon-id-fix']` = 「网关对账单修复」。

---

### 5.5 需求5：JPM 调拨订单修复引擎（逻辑B，8 步状态机）

> 🔴 资金红线。三段匹配任一环节字段映射 / 金额汇总 / 批次 gating 错误 → 写错资金对账ID 或网关修复行。

- **入参**：`{sheets, admRows, scenario}`。`merchantId = scenario.config.merchantId = '6300156616'`（不散落引擎）。
- **运行流程（三步法，决策3）**：导入资金不平结果表(4 sheet) → 检查 JPM 场景是否启用 → 《开始运行》（前提：渠道账单 sheet 存在 `merchantId=6300156616`；读 ADM 隐藏表回写）→ 导出网关对账单修复文件。

#### 8 步业务规则

1. **渠道账单过滤**：渠道账单 filter `merchantId===6300156616`。空 → 空结果 + 提示（不触发，引擎 no-op）。
2. **提取出账日期**：每行 `additionInfo` 用正则提取 `YY/MM/DD` → 补世纪 `20YY-MM-DD`，`toDate` 校验。
   - 真实样例：`additionInfo` 内 `PAYDET=/ROC/ATS OF 26/05/04  {"prtryAmt":[],"txAmt":{"amt":{"amount":2100000.00,"currency":"USD"}}}` → 出账日期 `2026-05-04`。
   - 🔴 正则须只锚定 ` 空格 + 两位/两位/两位 + 空格 ` 形态，JSON 内 `2100000.00`（无斜杠）不得误匹配。
   - 提取不到 → 跳过该行 + warn。
3. **ADM 行按出账日期分组**：ADM 行 filter `BillDate===出账日期`（规范化后比较）。
4. **金额整组汇总比较（决策6）**：BillDate=出账日期 的**全部** ADM 行的「Fundtransfer-in金额」**逐笔 `Math.round(v*100)` 转分再累加** === `Math.round(receiveAmount*100)`（容差 0）。
   - 🔴 **严禁先浮点累加后 round**（必须逐笔转分再累加，防浮点误差）。
   - 一个出账日期对一笔渠道账单（整组求和，非逐笔匹配）。
5. **命中回写渠道段**：金额汇总命中 → 组内 ADM 行全部赋值：渠道账单 `reconciliationId` → ADM「资金对账ID」、ADM「是否与渠道账单匹配」=1；该渠道账单行 1v1 消费（不再被其他出账日期复用）。
6. **批次 gating + 网关过滤（决策7）**：对每个批次号检查「是否与渠道账单匹配」**全为 1**（同一批次号的 ADM 行可能跨多个出账日期，需各自匹配齐）→ 才进网关段。网关段：网关账单 filter `MerchantId===6300156616`，OrderId ↔ 调拨号准备 1v1 匹配。
7. **网关 1v1 匹配 + Type 标记（决策8）**：每个调拨号各匹配一个网关行（`OrderId ↔ 调拨号` 1v1）。命中网关行写：
   - `Reference` = 该批次号资金对账ID（组内同值）
   - `GATEWAY_BILL_FIELDS[8]`(Type) = 该批次号行数 `>1 ? 2 : 0`
     - 🔴 **Type=2 仅标记「该批次号属多行聚合」，非传统多对1聚合**；一个批次号 N 个调拨号 → N 个网关行，每行各自写 Type（同批次号同值）。
   - 对应 ADM 行「是否与网关账单匹配」=1。
8. **收集 fixedRows**：收集网关账单中 Type ∧ Reference 均有值的行 → fixedRows（导出用）。

#### 5.5.1 分流与导出

- **分流**：`runReconIdFix` 加第三参 `{admRows}`；`scenario.config.subCategory==='jpm-dispatch-order-fix'` → 走新引擎 `runJpmDispatchOrderFix`，否则原 C4。`main.js recon-id-fix:run` 注入 `database.readAdmBankDepositRows()`。
- **导出**：复用 `writeReconIdFixOutput({subMode:'gateway'})`（列模板 `ORDER_REPAIR_FIELDS_GATEWAY` 与 C4 gateway 一致）。
- **ADM 副作用**：run 阶段把匹配标志 / 资金对账ID **整批幂等重写**回 ADM 表（可重入；与 C4「run 无副作用」不同）。

---

### 5.6 UI Mockup

#### Mockup A：资金对账「不平校验」组 +《开始运行》

```
┌────────────────────────────────────────────────────────────┐
│  资金对账数据处理                                            │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐       │
│  │导入不平表 │ │ 开始运行 │ │不平校验导出│ │链接表管理 │       │
│  └────┬─────┘ └────┬─────┘ └────┬─────┘ └──────────┘       │
│       │            │            │                           │
│  reconIdFix     运行已启用的    reconIdFix                   │
│  .import        gateway-recon   .export()                   │
│  ({subMode:     -id-fix 场景    （网关修复文件）            │
│   'gateway'})   （含 JPM 场景）                              │
└────────────────────────────────────────────────────────────┘
说明：「开始运行」为新增/接线入口（UI 形态 TECH 阶段定）。
      选 JPM 场景时前提：渠道账单 sheet 含 merchantId=6300156616。
```

#### Mockup B：ADM 表创建成功提示

```
┌─────────────────────────────────────────────┐
│  提示                                          │
├─────────────────────────────────────────────┤
│  ADM银行对账单链接表已创建。                    │
│                                  [ 知道了 ]    │
└─────────────────────────────────────────────┘
触发：导入银行对账单表 → ADM 派生全部行均匹配成功（无未匹配）。
```

#### Mockup C：ADM 表部分成功 + 未匹配报错框

```
┌──────────────────────────────────────────────────────────┐
│  ADM 银行对账单链接表已创建（部分行未匹配中台调拨订单）     │
├──────────────────────────────────────────────────────────┤
│  以下 N 行未匹配，调拨号 / 调拨入金金额留空：              │
│  • 批次号 2026-05-04-CO123 ｜ CustomerRef=CR-9 ｜          │
│      BillDate=2026-05-04 ｜ ChannelOrderNo=CO123          │
│      → 中台无对应渠道流水号（no-mid-match）                │
│  • 批次号 2026-05-05-CO456 ｜ CustomerRef=CR-7 ｜ …       │
│      → 中台侧渠道流水号重复（mid-duplicate）               │
│                                          [ 知道了 ]        │
└──────────────────────────────────────────────────────────┘
中台表为空时顶部额外提示：「请先导入中台调拨订单表」。
```

---

## 六、验收标准

> 本章共 **22 条** AC（本版为设计文档，AC 作为后续实现版本的验收蓝本；本版 AC 即「文档完整性 + 设计自洽」验收）。

### 6.1 需求1 接线 AC

| AC 编号 | 验收条件 |
|---------|---------|
| AC1-1 | 「导入不平表」改绑 `reconIdFix.import({subMode:'gateway'})`，与网关 ReconID 修复共用 session |
| AC1-2 | 「不平校验导出」先《开始运行》（运行已启用 gateway-recon-id-fix 场景）再 `reconIdFix.export()`，不再 `showComingSoon` |
| AC1-3 | 后端 `recon-id-fix:import/run/export` 契约零改动 |
| AC1-4 | 选 JPM 场景且渠道账单无 merchantId=6300156616 → 空结果 + 提示，不报错 |

### 6.2 需求2 改名 AC

| AC 编号 | 验收条件 |
|---------|---------|
| AC2-1 | 链接表管理弹窗第 5 行表库名显示「银行对账单表」 |
| AC2-2 | 导入结果明细（buildImportSummaryHtml）对 bank-deposit 显示「银行对账单表」 |
| AC2-3 | `BANK_DEPOSIT_SIGNATURE.label` 与 UI 表库名一致（按 §九 决策2 口径） |

### 6.3 需求3 ADM 派生 AC

| AC 编号 | 验收条件 |
|---------|---------|
| AC3-1 | 导入银行对账单表落库成功后触发 ADM 派生；非 bank-deposit 文件不触发 |
| AC3-2 | 仅 `Channel==='ADM'` ∧ `FundType∈{Fundtransfer-out, Fundtransfer-out&FX}` 行进 ADM 表（精确等于、大小写敏感） |
| AC3-3 | ADM 行 = 13 银行字段 + 6 新字段；匹配标志初始 0、资金对账ID 初始空 |
| AC3-4 | 批次号 = `<规范化BillDate>-<ChannelOrderNo>`（同 ChannelOrderNo 组统一 BillDate）；ChannelOrderNo 空 → 批次号空、不阻断 |
| AC3-5 | 中台匹配两侧都唯一 → 回填调拨号 / Fundtransfer-in金额；两侧任一重复 → 冲突、不赋值、进报错 |
| AC3-6 | 部分成功仍建表：未匹配行留空 + 报错框列 批次号/CustomerRef/BillDate/ChannelOrderNo + 错误码 |
| AC3-7 | 中台表为空 → 报错框提示「请先导入中台调拨订单表」 |
| AC3-8 | 全部匹配成功 → 弹「ADM银行对账单链接表已创建」 |
| AC3-9 | ADM 表隐藏（不进 ALL_TABLE_KEYS / LINKED_TABLE_LABELS）；整表覆盖；重导有 UI 提示标志归零 |

### 6.4 需求4 场景 seed AC

| AC 编号 | 验收条件 |
|---------|---------|
| AC4-1 | seed 出 1 条 category='gateway-recon-id-fix'、name='JPM调拨订单修复'、is_builtin=1、enabled=0 的场景 |
| AC4-2 | config = `{subCategory:'jpm-dispatch-order-fix', merchantId:'6300156616'}`，不带 funcCategory |
| AC4-3 | 「功能类别」显示「网关对账单修复」（funcCategory 回退） |
| AC4-4 | 独立 SEEDED_MARKER 幂等：重复启动不重复插；用户删除后重启不复活 |

### 6.5 需求5 引擎 AC

| AC 编号 | 验收条件 |
|---------|---------|
| AC5-1 | 渠道账单 filter merchantId=6300156616；空 → 空结果 + 提示 |
| AC5-2 | additionInfo 提取 `YY/MM/DD` → `20YY-MM-DD`（样例 `ATS OF 26/05/04`→`2026-05-04`）；JSON 内金额不误匹配；提取不到跳过 + warn |
| AC5-3 | ADM 行按出账日期整组 Fundtransfer-in金额逐笔转分累加 === receiveAmount 分值（容差0），严禁先浮点累加 |
| AC5-4 | 命中 → 组内 ADM 行赋资金对账ID + 是否与渠道账单匹配=1；渠道账单 1v1 消费 |
| AC5-5 | 批次 gating：同批次号「是否与渠道账单匹配」全为1 才进网关段 |
| AC5-6 | 网关 OrderId↔调拨号 1v1；命中行写 Reference=批次号资金对账ID + Type=(批次号行数>1?2:0) + ADM「是否与网关账单匹配」=1 |
| AC5-7 | fixedRows = Type ∧ Reference 均有值的网关行；导出复用 ORDER_REPAIR_FIELDS_GATEWAY |
| AC5-8 | 分流：subCategory='jpm-dispatch-order-fix' 走新引擎，否则原 C4；run 注入 admRows |
| AC5-9 | run 阶段匹配标志 / 资金对账ID 整批幂等重写回 ADM 表（可重入） |

---

## 七、手动测试清单

> 本版为设计文档，以下为后续实现版本的手测蓝本。本版的「测试」= 文档评审（设计完整、10 条决策已列、三段匹配链无遗漏）。

### 7.1 P0 必测场景

| 场景 | 输入 | 前置条件 | 预期结果 |
|------|------|----------|---------|
| 需求1 导入接线 | 点「导入不平表」选资金不平 4-sheet | gateway 场景已启用 | 走 reconIdFix.import gateway，session 建立 |
| 需求1 运行导出 | 《开始运行》→「不平校验导出」 | 已导入 + JPM 场景启用 | 运行 JPM 引擎 → 导出网关修复文件 |
| 需求2 改名 | 打开链接表管理 | — | 第 5 行显示「银行对账单表」 |
| ADM 派生全匹配 | 导入银行对账单表(含 ADM 行)+ 中台调拨可全对上 | 中台调拨已导入 | 弹「ADM银行对账单链接表已创建」，ADM 行调拨号/金额已回填 |
| ADM 派生部分匹配 | ADM 行中含 1 个中台无对应 + 1 个中台重复 | 同上 | 部分成功建表，报错框列 2 行未匹配 + 错误码 |
| ADM 中台空 | 导入银行对账单表但未导中台调拨 | — | 报错框提示「请先导入中台调拨订单表」 |
| JPM 单出账日期单批次 | 渠道账单1笔(merchantId=6300156616,additionInfo含 26/05/04) + ADM 同出账日期金额汇总=receiveAmount + 网关 OrderId 对得上调拨号 | JPM 场景启用 | ADM 标志置1，网关行 Reference/Type 写入，fixedRows 含该行 |
| JPM 批次跨多出账日期 | 同批次号 ADM 行跨 2 个出账日期，各自金额对得上 | 同上 | 两出账日期均命中后该批次进网关段，N 调拨号各匹配 1 网关行 |
| JPM 金额不平 | ADM 整组汇总 ≠ receiveAmount | 同上 | 该出账日期组不命中，不写 ADM 标志，不进网关段 |
| JPM merchantId 不命中 | 渠道账单无 6300156616 | 同上 | 空结果 + 提示，引擎 no-op |

### 7.2 P1 应测场景

| 场景 | 输入 | 前置条件 | 预期结果 |
|------|------|----------|---------|
| ADM 重导覆盖 | 二次导入银行对账单表 | 首次已派生 | ADM 重建、匹配标志归零、UI 提示 |
| JPM run 可重入 | 同一 JPM 场景连续运行 2 次 | — | ADM 表标志幂等（不累计、不冲突） |
| Type 分支 | 批次号行数=1 vs >1 | — | Type 分别为 0 / 2（=2 仅标记多行聚合） |
| 批次 gating 部分匹配 | 同批次号部分出账日期未命中 | — | 该批次不进网关段（全为1 才进） |
| additionInfo 多斜杠串 | additionInfo 含 JSON 金额 `2100000.00` + ` 26/05/04 ` | — | 仅提取 26/05/04，金额不误匹配 |

### 7.3 不测项与原因

- 本版不跑代码（无实现），仅文档评审 —— 设计未定稿前任何运行测试无意义。
- 真实 FundType 枚举字面值（`Fundtransfer-out` / `Fundtransfer-out&FX` 大小写与 `&FX` 后缀）、真实 additionInfo 出账日期格式变体：依赖 `assets/FundType枚举值.xlsx` 与真实样本，在实现版本手测时核对。

---

## 八、数据 / 状态 / 安全影响

| 类别 | 说明 |
|------|------|
| 数据结构变更 | 实现版本：新增隐藏表 `linked_adm_bank_deposit`（独立 migration，幂等 CREATE IF NOT EXISTS）；新增 1 条写死场景 seed（独立 marker，幂等，默认 enabled=0）。本版无（设计文档） |
| 状态流转变更 | ADM 行「是否与渠道账单匹配 / 是否与网关账单匹配」0→1、资金对账ID 空→赋值（JPM 引擎 run 阶段，幂等可重入）—— 🔴 资金对账状态机变更，人工复核 |
| 权限 / 安全 | 不涉及鉴权；处理资金对账数据（调拨入金 / 网关账单），属敏感资金数据 |
| 回滚策略 | 实现版本：JPM 场景默认 enabled=0 即等同回滚（不运行引擎）；ADM 表纯新增隐藏表、重导覆盖；seed 幂等可删；需求1 仅前端改绑可还原 |

> 🔴 **资金 / 状态机风险高亮**：
> - 金额汇总（步骤4）逐笔转分累加，严禁先浮点累加后 round。
> - 唯一匹配重复键（CustomerRef↔渠道流水号、OrderId↔调拨号）两侧任一重复判冲突 / 报错，不任取一条。
> - 跨表字段名 merchantId(渠道,小写) vs MerchantId(网关/银行,驼峰)、Type 超长缺括号列名 —— 一律常量引用。
> - merchantId `6300156616` 收进 `scenario.config.merchantId`，不散落引擎。
> - ADM 表重导 = 标志归零，UI 提示。
> - JPM run 副作用改 ADM 表状态，须幂等可重入。

---

## 九、已确认决议（✅ 用户已逐条敲定）

> 以下 10 条已由用户逐条确认，本章记录最终决议；正文 §五 已按此回写。进入实现版本直接以此为准。

- [x] **决策1（需求1 = 复用同一套 import/export）**：前端按钮改绑 `reconIdFix.import({subMode:'gateway'})` / `export()`，共用 session，后端零改动。
- [x] **决策2（需求1 导出落地）**：资金对账「不平校验」补《开始运行》→ 运行场景管理里**已启用**的 gateway-recon-id-fix 场景 → 再导出。
  - 配套（需求2 改名波及面口径）：UI 表库名 `LINKED_TABLE_LABELS['bank-deposit']` + 导入识别 `BANK_DEPOSIT_SIGNATURE.label` 统一改「银行对账单表」；退款回填命中详情文案 / 场景 involvedFiles / 内部注释是否同步全局改，TECH 阶段确认（本版倾向：用户可见文本统一改，内部注释可保留旧称作历史说明）。
- [x] **决策3（JPM 运行流程，三步法）**：导入资金不平结果表(4 sheet) → 检查 JPM 场景是否启用 → 开始运行（前提：渠道账单 sheet 存在 merchantId=6300156616；读 ADM 隐藏表回写）→ 导出网关对账单修复文件。
- [x] **决策4（需求3 ADM 匹配失败 = 部分成功仍建表）**：已匹配行赋值、未匹配行留空 + 弹报错框列出未匹配行；全部完成弹「ADM银行对账单链接表已创建」。
- [x] **决策5（出账日期格式）**：additionInfo 内 `YY/MM/DD`（真实样例 `PAYDET=/ROC/ATS OF 26/05/04  {"prtryAmt":[],"txAmt":{"amt":{"amount":2100000.00,"currency":"USD"}}}`）→ 补世纪 `20YY` → `YYYY-MM-DD`，与 ADM 表 BillDate 规范化后比较。
- [x] **决策6（步骤4 汇总分组 = 仅出账日期整组求和）**：BillDate=出账日期 的**全部** ADM 行 Fundtransfer-in金额汇总 = receiveAmount；一个出账日期对一笔渠道账单。
- [x] **决策7（步骤6 gating）**：同一批次号(同 ChannelOrderNo)的 ADM 行「是否与渠道账单匹配」全为1，才进网关段（该批次号行可能跨多个出账日期，需各自匹配齐）。
- [x] **决策8（步骤6/7 网关匹配 = 每调拨号各匹配一个网关行）**：OrderId↔调拨号 1v1；一个批次号 N 个调拨号 → N 个网关行，每行 Reference=该批次号资金对账ID（组内同值），Type 按同批次号行数 >1→2、=1→0（**Type=2 仅标记「该批次号属多行聚合」，非传统多对1聚合**），对应 ADM 行「是否与网关账单匹配」=1。
- [x] **决策9（需求3 ADM 侧重复 CustomerRef = 判冲突）**：CustomerRef↔渠道流水号匹配，**两侧任一重复（非唯一）均判冲突**、不赋值、进报错框（防步骤4金额汇总重复累加）。
- [x] **决策10（需求4 JPM 场景默认 enabled=0 休眠）**：与退款回填一致，用户手动启用后才运行。

### 九 bis、待实现时验证（非决策，1 点）

- **JPM 场景 priority**：给 `priority=3` 兜底，实现时验证 compact 单类别视图序号稳定为 1（is_builtin 置顶机制）；若不稳定再调整排序逻辑。

---

## 十、非功能性要求

| 类别 | 要求 |
|------|------|
| 向下兼容 | 纯新增隐藏表 + 写死场景（默认休眠）+ 前端改绑；不改现有 ReconID 修复 / C4 / 链接表既有行为；JPM 场景默认 enabled=0 不影响现有对账 |
| 性能 | 数据量级与现有网关对账同量级；中台匹配走内存 Map（按渠道流水号建索引）；ADM 行按出账日期 / 批次号分组走内存，避免 O(n²) 全表笛卡尔 |
| 鲁棒性 | 空入参（无 ADM 行 / 无渠道账单 6300156616 行 / 无中台调拨）→ 返回空结果不报错；additionInfo 提取不到出账日期 → 跳过该行 + warn 不抛异常；日期 / 金额非法值复用工具的 null 防御 |

---

## 十一、变更记录

| 日期 | 变更内容 |
|------|---------|
| 2026-06-08 | 初稿 = 定稿：JPM 调拨订单修复 PRD（5 需求：网关导入导出接线 / 表库改名 / ADM 隐藏表派生+中台匹配 / JPM 写死场景 seed / JPM 三段匹配引擎 + 10 条已确认决策 + 22 条 AC + 8 步状态机业务规则）。本版仅设计不实现 |

---

## 十二、实施记录

本版（v2.1.16-beta.5）**已实现落地**，PR-1~4 + 布局修订全部完成，release-check 三层全绿（unit 1953 / integration 952 / smoke）。

- **PR-1 地基层**：`linked_adm_bank_deposit` 表 + 仓储（`replaceAdmBankDeposit`/`readAdmBankDepositRows`/`writeAdmMatchFlags`）+ `adm-bank-deposit-fields.js` 常量 + 表库改名（需求2）。
- **PR-2 ADM 派生**：`buildAdmRows`（筛选/批次号/两侧唯一匹配/部分成功）+ `linked-table:import` 接线 + 报错/成功弹框（需求3）。
- **PR-3 JPM 场景+引擎**：JPM seed（enabled=0/priority=3/独立 marker）+ `jpm-dispatch-order-fix.js` 8 步 + `runReconIdFix` 分流 + ADM 标志回写（需求4/5）。
- **PR-4 按钮复用 + 布局修订**：需求1 资金对账「不平校验」= 「导入不平表/导出文件」两按钮 + row1《开始运行》智能路由复用（用户反馈：仅 'gateway' 模式走网关、否则 R1-R5，不串引擎）；需求4 场景操作列保护收窄到 `gateway-recon-id-fix`（只 JPM 不可删/操作列只读，C2/C3/builtin-fixed 零回归）。

**实现期偏离（Reverse Sync）**：详见 TECH 变更记录；用户确认决策——需求1 复用 row1 开始运行（智能路由）、需求4 场景保护只收窄到 JPM。

**待测**：见 `manual-test-checklist.md`（本版 36 + 累积 beta.2~4 共 15 = 51 case）。
