# PRD - 网银账单小助手 v2.1.16-beta.3 ③「中台退款订单回填引擎」

| 项目 | 内容 |
|------|------|
| 版本 | v2.1.16-beta.3 |
| 日期 | 2026-06-07 |
| 作者 | PM |
| 状态 | 定稿（设计，待实现版本落地）｜12 条澄清项已全部确认（2026-06-07） |
| 模块 | 资金对账数据处理 → 自带写死场景（builtin-fixed）→ R5 新增场景4「中台退款订单回填」 |
| 依赖 | ① Channel 枚举表（本版实现）、② 银行对账单入金表（本版实现）、R1~R5 现有编排器、`ZHONGTAI_REFUND_ORDER_SIGNATURE`、`中台退款订单回填模板.xlsx` |

> 🔴 **资金红线大引擎**：本引擎是 4 基数（1:1 / 1:N / N:1 / N:N）× 4 关联策略 + JPM(HK/US) 双分支的大型对账矩阵。任一字段映射 / 多笔判定错误 → 写错对账 ID / 退款单号 / 退款状态，直接污染资金对账结果。**本版只产出 PRD + TECH 设计文档，不落地任何代码**；第「九」章 12 条语义歧义已由用户逐条敲定（✅，2026-06-07），可作为实现版本蓝本。

---

## 一、需求概述

本文件描述 **1 项**需求（拆分为多个子能力）：

1. **中台退款订单回填引擎** —— 把 builtin-fixed 占位场景「中台退款订单回填」做实：以「渠道大账号 + 金额 + 币种」为唯一值锚点，分别从银行对账单（`FundType=Ach Return` 且未被改写子集）和中台退款订单表（`状态=SUBMITTED` 子集）捞出两侧数据，按 **4 基数 × 4 关联策略**（渠道流水号 / 附言 MTX 提取 / 付款人名称·卡号·虚拟卡号 / 金额币种日期）逐策略匹配，命中后执行统一回填动作（回填渠道流水号 / 渠道退款时间 / 退款单号 + 状态置 SUCCESS + 记录匹配命中详情），并对 Channel=JPM 的 HK / US 两地区在「附言提取」策略上叠加特殊匹配链。导出双 sheet：sheet1 = 回填模板（E 列匹配命中详情 + F 列起银行原数据）、sheet2 = 未匹配银行数据 + 报错信息。

---

## 二、背景与目标

### 2.1 背景

- **为什么要做**：「中台退款订单回填」在 v2.1.16-beta.2 PRD 中明确标注为 **builtin-fixed 占位场景**（「不接真实引擎」）。退款对账目前仍依赖人工核对银行打款流水、附言、付款人信息，逐条回填退款单号 / 渠道流水号 / 状态，效率低且易错。
- **用户 / 业务价值**：自动完成退款单与银行打款的多策略关联回填，覆盖 1:1 到 N:N 全基数场景，并对 JPM 渠道的特殊报文格式（HK 的 `T54SWIC` 流水号、US 的入金表二跳关联）做专门处理，把人工只留给「报错人工介入」少数兜底场景。
- **当前问题**：①占位场景不产出任何回填；②退款单与银行打款的关联关系分散在多个字段（银行打款流水号 / 附言 MTX / 付款人信息 / 金额币种日期），无统一优先级与多笔消歧规则；③JPM 渠道报文需清洗 `//` 与跨入金表二跳，现有引擎不支持。

### 2.2 目标

- 设计一个 **R5 新增场景4** 引擎 `r5-refund-order-backfill.js`，由 `reconciliation-orchestrator.js` 在 R5 内调度，与现有场景2 / 场景3 数据隔离、互不串池。
- 用**决策矩阵**穷举 4 基数 × 4 策略每一格的命中条件、回填动作、多笔时的「报错人工介入」与「不更新并提示」规则。
- 定义统一回填动作、匹配命中详情文本规则、双 sheet 导出结构、JPM-HK / JPM-US 独立匹配链。
- 把所有语义歧义集中成「已确认决议」清单（§九），每条记录用户拍板的最终值 + 说明。

### 2.3 明确不做

- **本版不实现任何代码**（不碰 `src/`）。仅产出 PRD + TECH 设计文档作为后续实现版本蓝本。
- 不做 UI（回填场景启用沿用现有 builtin-fixed 场景管理列表「是否启动」开关；导入提醒沿用现有弹框范式）。
- 不改现有 R1~R5 引擎算法（仅在 orchestrator 内**新增**场景4 调度分支）。
- 不在本引擎内重新实现日期解析 / 金额归一 / 提取 regex —— 复用 `engine-utils` / `engine-date-utils` / C1 `buildFeatureRegex`。
- 不处理 refund order 表 `状态 != SUBMITTED` 的行、不处理银行 `FundType != Ach Return` 或 FundType 已被改写的行（数据筛选阶段即剔除，见 §5.1.2）。

---

## 三、代码现状（必须有出处）

| 主题 | 相关文件 | 当前行为 | 已知限制 |
|------|---------|---------|---------|
| 退款回填占位场景 | v2.1.16-beta.2 seed（`migrations.js` `ensureReconRoundBuiltinScenariosSeed`）/ 编排器 `reconciliation-orchestrator.js:51` `bucketScenarios` | 「中台退款订单回填」为 builtin-fixed 占位，**未接真实引擎**；`bucketScenarios` 当前仅识别 `fund-transfer-backfill` / `platform-inbound-cleanup` 两个 R5 子场景 | 无 `refund-order-backfill` 分桶分支、无对应引擎 |
| R5 编排与调度 | `src/main-process/reconciliation-orchestrator.js:149` `runReconciliation` | R1→R2→R3→R4→R5（场景2 / 场景3），bankRows 同一组引用原地演化，`modColsByRowId` 跨轮累积标黄，`buildOutputRows` 行数守恒 | 退款回填需新增第三个 R5 子场景调度块 + 独立产物字段 |
| R5 场景2 范式 | `src/main-process/scenario-engines/r5-fund-transfer-backfill.js` | 显式跨表字段映射注释 / 金额绝对值精确到分（`amountEqual` `Math.round(x*100)`）/ 日期两阶段（Phase1 同日 `sameDay` → Phase2 容差 `dayDiffWithin` 升序 tie-break）/ 严格 1v1 `usedBankRowId` 单向消费 / `warningCollector` + `modificationCollector` | 本引擎复用此范式，但匹配是「多策略 + 多基数」而非单一字段等值 |
| R5 场景3 范式 | `src/main-process/scenario-engines/r5-platform-inbound-cleanup.js` | 产出独立行集合（`cleanupRows`）+ 由独立 writer 落第二文件；reconid 建索引 + 1v1 消费 | 本引擎同样产出独立行集合（回填模板行）+ 独立 writer，但需双 sheet |
| 共享工具 | `engine-utils.js` / `engine-date-utils.js` | `makeWarningCollector` / `makeModificationCollector` / `normalizeCellValue` / `valuesEqual` / `parseNumber` / `sameDay` / `dayDiffWithin` / `toDate` | 可直接复用；金额绝对值 `bankAmountAbs` 在场景2 内（可上提共享） |
| 特征提取 regex | `src/main-process/scenario-engines/c1-extract-recon-id.js:29` `buildFeatureRegex({featureCode,digitCount,totalLength})` | 生成 `/[A-Z]{n}<featureCode>\d{digitCount}/g`；`englishExtraN=0` 时退化为 `/<featureCode>\d{digitCount}/g` | **实测可复用**：MTX→`{featureCode:'MTX',digitCount:19,totalLength:22}` 生成 `/MTX\d{19}/`；T54SWIC→`{featureCode:'T54SWIC',digitCount:6,totalLength:13}` 生成 `/T54SWIC\d{6}/`（见 §5.1.7 实测） |
| 银行 44 列 | `src/constants/bank-statement-fields.js` `BANK_STATEMENT_FIELDS`（Critical 变量） | 顺序固定，含本引擎所需 Channel / 地区 / Currency / Credit Amount / Debit Amount / ReconciliationId / ChannelOrderNo / CustomerRef / Extra Information / Payment Detail / Drawee Name / Drawee CardNo / Payee CardNo / FundType / BillDate / ValueDate / MerchantId / 关联大账号 | 跨表映射必须显式按列名 pick，禁止假设同名 |
| refund order 25 列 | `src/constants/table-signatures.js:53` `ZHONGTAI_REFUND_ORDER_SIGNATURE` | 含 流水号 / 银行打款流水号 / 附言 / 付款人名称 / 付款卡号 / 虚拟卡号 / 银行大账号 / 退款金额 / 原加款金额 / 币种 / 状态（idx14）/ 渠道流水单号 / 渠道退款时间 / valueDate（idx23）/ 退款标识 | 数据来源：预加工导入 session（非链接表） |
| 入金表 | ②（本版实现）链接表 `linked_bank_deposit` | 存银行对账单 C~N + FundType 共 13 字段，可按 `ReconciliationId` / `ChannelOrderNo` 查（C~N 含 ReconciliationId / ChannelOrderNo / CustomerRef） | JPM-US 二跳依赖此表 |
| 回填模板 | `assets/中台退款订单回填模板.xlsx`（实测） | **现仅 4 列**：`退款单号` / `状态` / `渠道流水号` / `渠道退款时间`（实测 sheet「Sheet1」表头 `["退款单号","状态","渠道流水号","渠道退款时间"]`） | 需求要 E 列匹配命中详情 + F 列起银行原数据 → 模板列已扩展（见 §5.1.5；✅ Q4：F 起 9 字段） |
| 启用提醒范式 | `renderer.js:3521` 附近 `maybePromptGatewayReconImport`（参考） | 启用某功能但导入未带必需表 → 弹提醒框 | 本引擎需类似：启用退款回填但导入未带 refund order 表（表头识别 `ZHONGTAI_REFUND_ORDER_SIGNATURE` 未命中）→ 弹提醒 |

> 说明：`reconciliation-orchestrator.js` 已读全文；`r5-fund-transfer-backfill.js` / `r5-platform-inbound-cleanup.js` / `engine-utils.js` / `engine-date-utils.js` / `c1-extract-recon-id.js` / `table-signatures.js` / `bank-statement-fields.js` 均已逐行核对；回填模板列与 refund order 列均经 `node + xlsx` 实测确认。

---

## 四、术语

| 术语 | 含义 |
|------|------|
| refund order 表 | 中台退款订单表（`ZHONGTAI_REFUND_ORDER_SIGNATURE`，25 列）。下文统称 refund order |
| 回填模板 | `中台退款订单回填模板.xlsx`，导出 sheet1 的模板（现 4 列，需扩展） |
| 入金表 | 银行对账单入金表（②本版实现的链接表 `linked_bank_deposit`），存银行 C~N + FundType |
| 唯一值 | 「渠道大账号 + 金额 + 币种」三元组锚点 = 银行 `MerchantId` ↔ refund `银行大账号` + 银行发生额绝对值 `\|Credit Amount − Debit Amount\|` ↔ refund `退款金额` + 银行 `Currency` ↔ refund `币种`（Q1 已确认） |
| 基数 | 同一「唯一值」在银行侧 / refund order 侧各自的命中条数：1 或 N（多笔） |
| 策略 | 4 个关联判定方法：S1 渠道流水号 / S2 附言 MTX 提取 / S3 付款人名称·卡号·虚拟卡号 / S4 金额币种日期 |
| 回填动作 | 命中后对 refund order 对应退款单执行的统一写入（见 §5.1.3） |
| 报错人工介入 | 数据脏 / 多笔无法消歧 → 不回填，写入 sheet2「结果类型=报错-人工介入」，需人工判断 |
| 不更新并提示 | 该退款单 / 银行行未关联成功，**不报错**，落 sheet2「结果类型=未匹配-提示」（Q5 已确认） |
| MTX 加款单 | 格式 `MTX+19位数`，从银行 `Extra Information` 提取，与 refund order `附言` 匹配 |
| T54SWIC 流水号 | 格式 `T54SWIC+6位数`，JPM-HK 从清洗后的 `Extra Information` / `Payment Detail` 提取 |
| Ach Return | 银行 `FundType` 取值；退款回填只消费 `FundType=Ach Return` 且未被改写的银行行 |
| SUBMITTED / SUCCESS | refund order `状态`（idx14）取值；`SUBMITTED` 参与，回填后置 `SUCCESS` |

---

## 五、功能详细描述

### 5.1 需求 1：中台退款订单回填引擎

#### 5.1.1 说明

- **输入**：
  - 银行对账单行（R4 后、带 `_rowId` 的全量 bankRows，由编排器传入）。
  - refund order 行（预加工导入 session 读出的 25 列对象数组）。
  - 入金表（链接表 `linked_bank_deposit` 读回，仅 JPM-US 用）。
  - Channel 枚举（①本版实现，审计 / 校验辅助；JPM 判定主要直接读银行行 `Channel` / `地区`）。
- **输出**：
  - 回填模板行集合（每条命中的 refund order → 一行，含回填后字段 + E 列匹配命中详情 + F 列起银行原数据）。
  - 未匹配集合（未关联成功的银行行 + 报错信息），落 sheet2。
  - warnings / modifications（沿用编排器累积口径；✅ Q11：回填只产独立模板行、不改银行行、不回写持久层）。
- **边界条件**：见 §5.1.2 数据筛选、§5.2 决策矩阵、§5.5 JPM 分支、第「九」章歧义清单。

#### 5.1.2 数据筛选（参与对账的两侧子集）

> 🔴 筛选错误会让不该参与的行进入匹配池，污染回填。两侧筛选都必须在进入决策矩阵**之前**完成。

**refund order 侧（SUBMITTED 参与）** —— 需求【二】：

- 仅 `状态 == 'SUBMITTED'`（`ZHONGTAI_REFUND_ORDER_SIGNATURE` idx14）的行参与对账。其余状态行不进池。

**银行侧（Ach Return 且 FundType 未变更）** —— 需求【三】（Q2 已确认）：

- 仅 `FundType == 'Ach Return'` 的行参与；
- 且**筛掉 FundType 值被变更过的行** = 被 R4 资金性质校验改写过 FundType 的行（复用编排器 `modColsByRowId`：该行被改列集合含 `FundType` 即视为变更过）。即：只保留「原生即 `Ach Return`、未经任何轮次改写 FundType」的行。
- 其余 FundType 行、被改写 FundType 的行（即使改写后恰为 `Ach Return`）均不进池。

**唯一值捞取** —— 需求【四】（Q1 已确认）：

- 两侧分别按「渠道大账号 + 金额 + 币种」三元组分组，同一三元组下两侧各自的条数决定落入哪个基数场景（§5.2）。字段映射：
  - 渠道大账号 = 银行 `MerchantId` ↔ refund order `银行大账号`
  - 金额 = 银行发生额绝对值 `|Credit Amount − Debit Amount|`（精确到分）↔ refund order `退款金额`
  - 币种 = 银行 `Currency` ↔ refund order `币种`

#### 5.1.3 回填动作（统一定义）—— 需求备注 1

> 🔴 命中后对该 refund order 退款单执行的统一写入。任一映射错位 = 资金回填错误。

| # | 源（取值） | 目标（写入 refund order / 回填模板） |
|---|-----------|-----------------------------------|
| 1 | 银行 `ReconciliationId` | 退款模板「渠道流水号」 |
| 2 | 银行 `BillDate`（备注原文「billdate」） | 退款模板「渠道退款时间」 |
| 3 | refund order 「流水号」 | 退款模板「退款单号」 |
| 4 | 固定值 `SUCCESS` | 退款模板「状态」（原 `SUBMITTED` → `SUCCESS`） |
| 5 | 匹配命中详情文本（§5.1.4） | 回填模板 E 列「匹配命中详情」 |

- 回填粒度：**1 条命中的 refund order 退款单 → 1 行回填模板**（F 列起放与之配对的那条银行行**指定 9 个字段**原数据，见 §5.1.5）。
- 一条银行行最多被一条 refund order 回填一次（严格 1v1 消费，沿用场景2 `usedBankRowId` 范式）；一条 refund order 退款单也只回填一次。

#### 5.1.4 匹配命中详情文本规则 —— 需求备注 2

命中详情记录「哪个字段的什么信息匹配上了哪个字段的什么信息」，两种句式：

- 银行 ↔ refund order：
  `匹配成功:"银行对账单<字段名>里的<值>"匹配上了"refund order<字段名>的<值>"`
- 银行 ↔ 入金表（JPM-US 二跳）：
  `匹配成功:"银行对账单<字段名>里的<值>"匹配上了"银行对账单入金表<字段名>的<值>"`

> 文本要落到回填模板 E 列。各策略 / JPM 分支命中时填入对应字段名与实际值（见 §5.2 / §5.5 每格「命中详情示例」；✅ Q12 文案口径已定）。

#### 5.1.5 导出双 sheet 结构 —— 需求备注 3

**sheet1 = 中台退款订单回填模板**（Q4 已确认）：

```
取 "中台退款订单回填模板.xlsx" 作为 sheet1。
列布局：
  A 退款单号        ← refund order 流水号
  B 状态            ← SUCCESS
  C 渠道流水号      ← 银行 ReconciliationId
  D 渠道退款时间    ← 银行 BillDate
  E 匹配命中详情    ← §5.1.4 文本
  F 列起（只放银行这 9 个字段，按此顺序）：
     F  BillDate
     G  Channel
     H  地区
     I  MerchantId
     J  Currency
     K  Debit Amount        ← ⚠️ 金额列只有 Debit Amount，没有 Credit Amount
     L  ReconciliationId
     M  ChannelOrderNo
     N  CustomerRef
```

> ⚠️ **Q4 已确认**：现模板实测仅 A~D 4 列（退款单号/状态/渠道流水号/渠道退款时间），需求新增 E（匹配命中详情）+ F 起（银行 9 字段）。**F 起不是 44 列全列，只放上述 9 列**；其余 35 列不放；金额列**只放 Debit Amount，不放 Credit Amount**。

**sheet2 = 未匹配 + 报错**（Q5 已确认）：

```
放未匹配上的银行对账单数据 + 「结果类型」列 + 报错/提示信息列。
结果类型列两种值（同表区分两类输出）：
  - "报错-人工介入"：数据脏 / 多笔无法消歧 / 日期>10天
  - "未匹配-提示"：关联不到（不更新并提示），非脏数据报错
两类输出落同一 sheet2，用「结果类型」列区分，不再拆第三个文件/错误报告。
```

#### 5.1.6 MTX 加款单格式 —— 需求备注 4

- MTX 加款单数据格式：`MTX+19位数`（实测 `buildFeatureRegex({featureCode:'MTX',digitCount:19,totalLength:22})` → `/MTX\d{19}/`）。
- 提取源：银行 `Extra Information`；提取后与 refund order `附言` 做**包含**匹配（`附言.includes(mtx)`）（Q6 已确认）。

#### 5.1.7 提取 regex 可复用性（实测证据）

实测 `buildFeatureRegex`（`c1-extract-recon-id.js:29`）：

```
buildFeatureRegex({featureCode:'MTX',     digitCount:19, totalLength:22}) → /MTX\d{19}/g
buildFeatureRegex({featureCode:'T54SWIC', digitCount:6,  totalLength:13}) → /T54SWIC\d{6}/g
```

- MTX 测试：`"付款备注 MTX1234567890123456789 其它"` → 命中 `["MTX1234567890123456789"]`；`"MTX123"`（不足 19 位）→ `null`。✓
- T54SWIC 测试：`"//T54SWIC494447//ABC"` 含 `//` 直接匹配 → `["T54SWIC494447"]`；清洗 `//` 后 `"T54SWIC494447ABC"` 仍 → `["T54SWIC494447"]`。
  ℹ️ **背景注记**（实测）：因 `T54SWIC` 含数字 `54`，`//T54SWIC\d{6}` 锚定不受 `//` 干扰，即使不清洗 `//` 也能提取。需求【五】.1 仍按规则执行清洗（无副作用，防 `//` 切断流水号的脏形态如 `T54SWI//C494447`）。提取出的 T54SWIC 仅与 refund order「银行打款流水号」单字段**等值**匹配（Q7 已确认，详见 §5.5.1）。

#### 5.1.8 影响范围

- **前端**：仅「导入未带 refund order 表」的提醒框（沿用现有 prompt 范式）；不新增页面。
- **后端**：新增引擎 `r5-refund-order-backfill.js`；orchestrator 新增场景4 调度块 + 产物字段；新增独立 writer（双 sheet）；新增 builtin-fixed seed config（`funcCategory='platform-order'` + `subCategory='refund-order-backfill'`）。
- **数据库**：依赖 ②`linked_bank_deposit` + ①`channel_enum_values`（本版已实现）；本引擎实现版本可能新增 seed config 行（幂等）。
- **对外接口影响**：导出文件结构变化（退款回填双 sheet）—— 资金对账下游产物。
- **兼容性影响**：纯新增 R5 子场景，默认是否启用待定（建议默认禁用，见 Q 区）；不改现有场景2 / 场景3 行为。

#### 5.1.9 UI Mockup（启用提醒）

```
┌─────────────────────────────────────────────┐
│  提示                                          │
├─────────────────────────────────────────────┤
│  已启用「中台退款订单回填」功能，                │
│  但本次导入未检测到「中台退款订单表」。          │
│  请补充导入中台退款订单表后再运行对账。          │
│                                  [ 知道了 ]    │
└─────────────────────────────────────────────┘
触发：启用退款回填场景 + 导入文件集合按表头识别
      ZHONGTAI_REFUND_ORDER_SIGNATURE 未命中。
若导入已带该表（表头命中）→ 不弹（需求【一】）。
```

---

### 5.2 决策矩阵：4 基数 × 4 策略

> 🔴 这是本引擎的核心。**行 = 4 基数场景**，**列 = 4 关联策略**。每格写清：命中条件 / 命中后回填动作 / 多笔时的报错（报错人工介入）或提示（不更新并提示）规则。
>
> **基数定义**（同一「渠道大账号+金额+币种」唯一值下）：
> - 基数1 = 银行 1 笔 + refund order 1 笔（1:1）
> - 基数2 = 银行 1 笔 + refund order N 笔（1:N）
> - 基数3 = 银行 N 笔 + refund order 1 笔（N:1）
> - 基数4 = 银行 N 笔 + refund order N 笔（N:N）
>
> **策略优先级**（✅ Q3 已确认）：按 S1 渠道流水号 → S2 附言 MTX → S3 付款人/卡号/虚拟卡号 → S4 金额币种日期 顺序「命中即停」；某策略「报错人工介入」则停于该策略不再尝试后续，仅「未命中」才进下一策略。
>
> **统一约定**：所有「命中后回填动作」均指 §5.1.3 统一回填动作。「关联到」= 该策略 ID 在对侧字段查到对应值。

#### 策略字段定义（4 策略各自的「关联 ID」与「被查字段」）

| 策略 | 关联 ID（取值方） | 被查字段（查找方） | 命中详情句式 |
|------|------------------|-------------------|-------------|
| **S1 渠道流水号** | refund order「银行打款流水号」 | 银行 `ChannelOrderNo` 或 `CustomerRef` | 银行 ChannelOrderNo/CustomerRef ↔ refund order 银行打款流水号 |
| **S2 附言 MTX** | 银行 `Extra Information` 提取 `MTX+19位数` | refund order「附言」 | 银行 Extra Information(MTX) ↔ refund order 附言 |
| **S3 付款人/卡号/虚拟卡号** | refund order「付款人名称」或「付款卡号」或「虚拟卡号」 | 银行 `Drawee Name` 或 `Drawee CardNo` 或 `Payee CardNo` | 银行 Drawee Name/Drawee CardNo/Payee CardNo ↔ refund order 付款人名称/付款卡号/虚拟卡号 |
| **S4 金额币种日期** | 金额 + 币种（已是唯一值一部分）+ 日期比对 | 银行 `BillDate` vs refund order `valueDate`（起息日 idx23） | 银行 BillDate ↔ refund order valueDate（≤10 天取最近） |

> ✅ Q8b 已确认：S3 字段**按位对应** —— 付款人名称↔Drawee Name / 付款卡号↔Drawee CardNo / 虚拟卡号↔Payee CardNo。

---

#### 【基数场景 1】银行 1 笔 + refund order 1 笔（1:1）—— 需求【基数场景 1】

| 策略 | 命中条件 | 命中后 | 未命中 / 多笔 |
|------|---------|--------|--------------|
| **S1 渠道流水号** | refund order「银行打款流水号」去银行查，关联到 `ChannelOrderNo` 或 `CustomerRef` | 执行回填动作 | 关联不到 → 进 S2 |
| **S2 附言 MTX** | 银行 `Extra Information` 提取 MTX 加款单信息，匹配上 refund order「附言」 | 执行回填动作 | 提取不到 / 匹配不上 → 进 S3 |
| **S3 付款人/卡号/虚拟卡号** | refund order「付款人名称」/「付款卡号」/「虚拟卡号」去银行查，关联到 `Drawee Name` / `Drawee CardNo` / `Payee CardNo` | 执行回填动作 | 关联不到 → 进 S4 |
| **S4 金额币种日期** | 无任何关联关系时：金额 + 币种已关联，比对银行 `BillDate` 与 refund order `valueDate`，差异 **≤10 天** | 取最接近时间那条作退款单数据回填（1:1 下即唯一一条） | 差异 **>10 天** → **报错人工介入** |

> 1:1 场景无「多笔」消歧问题；S4 是无关联兜底，日期 >10 天报错。

---

#### 【基数场景 2】银行 1 笔 + refund order N 笔（1:N）—— 需求【基数场景 2】

| 策略 | 命中条件 | 命中后 | 多笔 / 未命中规则 |
|------|---------|--------|------------------|
| **S1 渠道流水号** | refund order「银行打款流水号」去银行查 | 「银行打款流水号」**只有一笔**且关联到 `ChannelOrderNo` / `CustomerRef` → 回填 | 「银行打款流水号」**有多笔** → **报错人工介入**；关联不到的 refund order 退款单 → **不更新并提示** |
| **S2 附言 MTX** | 银行 `Extra Information` 提取 MTX 匹配 refund order「附言」 | 匹配上**且只有一笔** → 回填 | 关联到**多笔** → **报错人工介入**；关联不到的 refund order → **不更新并提示** |
| **S3 付款人/卡号/虚拟卡号** | refund order 三者之一去银行查 | refund order 侧判断ID **只有一笔**且关联到 `Drawee Name`/`Drawee CardNo`/`Payee CardNo` → 回填 | refund order 侧判断ID **有多笔 → 报错人工介入**（✅ Q9 已确认：原文「有一笔报错」为笔误，按「多笔报错、一笔回填」） |
| **S4 金额币种日期** | 金额 + 币种关联 | refund order **只有一笔** → 比对 `BillDate` vs `valueDate`，≤10 天取最近回填；refund order **有多笔** → 同样比对，≤10 天取最近回填 | **>10 天** → 报错人工判断 |

---

#### 【基数场景 3】银行 N 笔 + refund order 1 笔（N:1）—— 需求【基数场景 3】

| 策略 | 命中条件 | 命中后 | 多笔 / 未命中规则 |
|------|---------|--------|------------------|
| **S1 渠道流水号** | refund order「银行打款流水号」去银行查 | 关联到 `ChannelOrderNo`/`CustomerRef` **只有一笔** → 回填 | 关联不到的银行对账单数据 → **提示**；关联到**多笔** → **报错人工介入** |
| **S2 附言 MTX** | 银行 `Extra Information` 提取 MTX 匹配 refund order「附言」 | 银行**只有一笔**且匹配上 → 回填 | 关联不到的 refund order → **不更新并提示**；银行**有多笔** → **报错人工介入** |
| **S3 付款人/卡号/虚拟卡号** | refund order 三者之一去银行查 | refund order **只有一笔**且关联到 `Drawee Name`/`Drawee CardNo`/`Payee CardNo` **且银行数据只有一笔** → 回填 | 关联到的银行对账单**有多笔** → **报错人工介入** |
| **S4 金额币种日期** | 金额 + 币种关联（refund order 只有一笔） | 按银行 `BillDate` **早→晚**顺序匹配，先从最早 BillDate 去关联 refund order，`BillDate` 与 `valueDate` 差异 **≤10 天** → 取最近那条回填，多出来的 refund order 不更新 | **>10 天** → 报错人工判断 |

---

#### 【基数场景 4】银行 N 笔 + refund order N 笔（N:N）—— 需求【基数场景 4】

| 策略 | 命中条件（回填成立） | 命中后 | 报错 / 提示规则 |
|------|---------------------|--------|----------------|
| **S1 渠道流水号** | refund order「银行打款流水号」**只有一笔**且关联到 `ChannelOrderNo`/`CustomerRef` **也只有一笔** | 回填 | 关联不到的银行对账单 → **提示**；关联不到的 refund order → **不更新并提示**；「银行打款流水号有多笔且关联到一笔或多笔」**或**「银行打款流水号一笔但关联到多笔」 → **报错人工介入** |
| **S2 附言 MTX** | 银行**只有一笔**且关联到的 refund order **也只有一笔** | 回填 | 关联不到的 refund order → **不更新并提示**；「银行多笔且关联到一笔或多笔」**或**「银行一笔但关联到多笔」 → **报错人工介入** |
| **S3 付款人/卡号/虚拟卡号** | refund order **只有一笔**且关联到银行 `Drawee Name`/`Drawee CardNo`/`Payee CardNo` **且银行只有一笔** | 回填 | 「refund order 多笔且关联到一笔或多笔」**或**「refund order 一笔但关联到多笔」 → **报错人工介入** |
| **S4 金额币种日期** | 金额 + 币种关联，银行与 refund order 均多笔 | **银行条数 < refund order 条数**：按银行 `BillDate` 早→晚匹配，先从最早 BillDate 关联，≤10 天取最近回填，多出来的 refund order 不更新；**银行条数 > refund order 条数**：同样按 BillDate 早→晚匹配，≤10 天取最近回填 | **>10 天** → 报错人工判断 |

> ✅ Q10 已确认：N:N 的 S4「银行条数 == refund order 条数」分支 = 按 BillDate 早→晚逐条 1v1，≤10 天取最近回填、>10 天报错。

---

### 5.3 多笔结果分类口径（统一术语，全矩阵适用）

| 输出类别 | 含义 | 触发示例 | 去向 |
|---------|------|---------|------|
| **回填成功** | 唯一确定地命中一条配对 | 各格「命中后」 | sheet1 模板行（含命中详情） |
| **报错人工介入** | 数据脏 / 多笔无法消歧 / 日期 >10 天 | 关联到多笔、关联 ID 本身多笔、日期超容差 | sheet2（未匹配 + 报错信息） |
| **不更新并提示** | 该退款单 / 银行行未关联成功，但非「脏数据报错」 | 「关联不到的 refund order 退款单不更新并提示」「关联不到的银行对账单数据提示」 | ✅ Q5 已确认：落 sheet2，「结果类型」列标 `未匹配-提示`（与 `报错-人工介入` 同表区分） |

> ⚠️ **「报错人工介入」与「不更新并提示」是两类不同输出**，实现时必须用不同标记 / 不同去向区分（需求在每格反复强调二者并存）。

---

### 5.4 策略推进与命中即停（建议）

```
对每个「唯一值」分组（确定基数后）：
  按 S1 → S2 → S3 → S4 顺序尝试：
    若当前策略产出「回填成功」 → 执行回填、消费银行行（usedBankRowId）→ 停止后续策略（✅ Q3 已确认：命中即停）
    若当前策略产出「报错人工介入」 → 停于该策略并记报错，不再尝试后续策略（✅ Q3 已确认）
    若当前策略「未命中（关联不到）」 → 进入下一策略
  4 策略走完仍未回填 → 该唯一值分组按最后状态落 sheet2（报错或提示）
```

---

### 5.5 JPM 特殊分支（需求【第五点】）

> 仅当导入银行对账单 `Channel == 'JPM'` 时，在 **S2「附言信息提取」策略**上叠加以下匹配逻辑。地区（银行 `地区` 列）分 HK / US 两条独立链。

#### 5.5.1 JPM-HK 匹配链（`Channel=JPM` 且 `地区=HK`）

```
跳1  清洗：银行 Extra Information 和 Payment Detail 里的 "//" 清洗掉（替换为空，✅ Q7 已确认）
       cleanedExtra   = bank['Extra Information'].split('//').join('')
       cleanedPayDtl  = bank['Payment Detail'].split('//').join('')
跳2  提取：从清洗后文本提取流水号，格式 <T54SWIC+6位数>
       regex = buildFeatureRegex({featureCode:'T54SWIC', digitCount:6, totalLength:13}) → /T54SWIC\d{6}/
       swicNo = 提取结果（提取不到 → 该分支不命中，回落常规 S2/S3/S4）
跳3  匹配：用 swicNo 与 refund order「银行打款流水号」**单字段等值**匹配（✅ Q7 已确认：仅此字段，不再遍历 25 列）
       命中 ⟺ refundOrder['银行打款流水号'] == swicNo
跳4  命中 → 执行回填动作；命中详情：
       匹配成功:"银行对账单 Extra Information/Payment Detail 里的 <swicNo>"匹配上了"refund order 银行打款流水号 的 <值>"
```

> ℹ️ 背景（实测）：因 `T54SWIC` 含数字，`//` 不影响 `T54SWIC\d{6}` 锚定（§5.1.7），清洗对标准形态无副作用（防 `//` 切断流水号如 `T54SWI//C123456` 的脏形态）。✅ Q7 已确认：提取出的 swicNo **仅与 refund order「银行打款流水号」单字段等值匹配**，不再遍历其余字段。

#### 5.5.2 JPM-US 匹配链（`Channel=JPM` 且 `地区=US`）

```
跳1  取 ID：取「关联到的 refund order 表」的「银行打款流水号」的值
       payNo = refundOrder['银行打款流水号']
       （✅ Q8 已确认："关联到的 refund order" = 当前唯一值分组下、S1 关联出的那条 refund order）
跳2  入金表匹配：用 payNo 去链接表「银行对账单入金表」(linked_bank_deposit) 匹配 ReconciliationId 或 ChannelOrderNo
       depositRow = 入金表中 (ReconciliationId == payNo) 或 (ChannelOrderNo == payNo) 命中的行
       （✅ Q8 已确认：OR —— 任一字段等于 payNo 即命中）
跳3  取 CustomerRef：取该入金表行的 CustomerRef 值
       depositCustomerRef = depositRow['CustomerRef']
跳4  比对：与导入的银行对账单的 CustomerRef 值匹配
       命中 ⟺ depositCustomerRef == bank['CustomerRef']
跳5  命中 → 执行回填动作；命中详情（含入金表句式）：
       匹配成功:"银行对账单 CustomerRef 里的 <值>"匹配上了"银行对账单入金表 CustomerRef 的 <depositCustomerRef>"
       （注：二跳来源 payNo 来自 refund order 银行打款流水号；✅ Q12：详情文案按 §5.1.4 两句式）
```

> ⚠️ JPM-US 是**跨 3 表二跳关联**（refund order → 入金表 → 银行），任一跳字段映射错误都会写错回填（✅ Q8 已确认各跳语义；资金红线，实现需对每跳单测覆盖）。

---

## 六、验收标准

> 本章节共 **24 条** AC（本版为设计文档，AC 作为后续实现版本的验收蓝本；本版 AC 即「文档完整性 + 设计自洽」验收）。

### 6.1 数据筛选 AC

| AC 编号 | 验收条件 |
|---------|---------|
| AC1-1 | refund order 仅 `状态=='SUBMITTED'` 行参与对账 |
| AC1-2 | 银行仅 `FundType=='Ach Return'` 行参与对账 |
| AC1-3 | 银行 FundType 被改写过的行（含改写后恰为 Ach Return）不参与对账（依赖 Q2 标记位） |
| AC1-4 | 两侧按「渠道大账号+金额+币种」分组确定基数（依赖 Q1 字段映射） |

### 6.2 回填动作 AC

| AC 编号 | 验收条件 |
|---------|---------|
| AC2-1 | 命中后：银行 `ReconciliationId` → 模板「渠道流水号」 |
| AC2-2 | 命中后：银行 `BillDate` → 模板「渠道退款时间」 |
| AC2-3 | 命中后：refund order「流水号」→ 模板「退款单号」 |
| AC2-4 | 命中后：状态 `SUBMITTED` → `SUCCESS` |
| AC2-5 | 命中后：E 列写入匹配命中详情文本（符合 §5.1.4 句式） |
| AC2-6 | 一条银行行最多被回填一次（严格 1v1 消费） |

### 6.3 决策矩阵 AC（4 基数 × 4 策略）

| AC 编号 | 验收条件 |
|---------|---------|
| AC3-1 | 基数1 S1~S4 行为符合 §5.2【基数场景1】表（S4 >10 天报错） |
| AC3-2 | 基数2 S1~S4：单笔关联回填、多笔报错人工介入、关联不到不更新并提示，区分两类输出 |
| AC3-3 | 基数3 S1~S4：含 S4 按 BillDate 早→晚顺序匹配、多出 refund order 不更新 |
| AC3-4 | 基数4 S1~S4：含「银行条数<refund order」与「银行条数>refund order」两分支 S4 行为 |
| AC3-5 | 「报错人工介入」与「不更新并提示」在所有格子里用不同标记 / 去向输出 |
| AC3-6 | 策略按 S1→S2→S3→S4 优先级推进（依赖 Q3 命中即停） |

### 6.4 JPM 分支 AC

| AC 编号 | 验收条件 |
|---------|---------|
| AC4-1 | `Channel=JPM` 才触发 JPM 分支；非 JPM 走常规 4 策略 |
| AC4-2 | JPM-HK：清洗 `//` → 提取 `T54SWIC+6位数` → 遍历 refund order 所有字段命中回填 |
| AC4-3 | JPM-US：refund order 银行打款流水号 → 入金表 ReconciliationId/ChannelOrderNo → 取 CustomerRef → 比对银行 CustomerRef → 回填 |
| AC4-4 | JPM-HK / JPM-US 命中详情文案符合对应句式（含「入金表」句式） |

### 6.5 导出 AC

| AC 编号 | 验收条件 |
|---------|---------|
| AC5-1 | sheet1 取回填模板，E 列=匹配命中详情，F 列起=配对银行原数据 |
| AC5-2 | sheet2 = 未匹配银行数据 + 报错信息 |
| AC5-3 | 「不更新并提示」类输出按 Q5 确定去向呈现 |

### 6.6 集成 / 提醒 AC

| AC 编号 | 验收条件 |
|---------|---------|
| AC6-1 | 引擎作为 R5 场景4 由 orchestrator 调度，与场景2/3 数据隔离、不串池 |
| AC6-2 | 启用退款回填 + 导入未带 refund order 表（表头未命中）→ 弹提醒；已带则不弹 |
| AC6-3 | 跨表字段映射全部显式按列名 pick（无同名假设），与 TECH §跨表字段映射常量一致 |

---

## 七、手动测试清单

> 本版为设计文档，以下为**后续实现版本**的手测蓝本。本版的「测试」= 文档评审（设计完整、12 条歧义已列、矩阵无遗漏）。

### 7.1 P0 必测场景

| 场景 | 输入 | 前置条件 | 预期结果 |
|------|------|----------|---------|
| 基数1-S1 命中 | 银行1笔 + refund order1笔，银行打款流水号关联到 ChannelOrderNo | 启用退款回填 | 回填成功，sheet1 一行，E 列详情正确 |
| 基数1-S4 >10天 | 银行1笔 + refund order1笔，无关联，日期差 15 天 | 同上 | 报错人工介入，落 sheet2 |
| 基数2-S1 多笔 | 银行1笔 + refund orderN笔，银行打款流水号多笔 | 同上 | 报错人工介入；关联不到的 refund order 不更新并提示 |
| 基数3-S4 早→晚 | 银行N笔 + refund order1笔，多条银行 BillDate 不同 | 同上 | 从最早 BillDate 关联，≤10 天取最近回填，多余不更新 |
| 基数4-S4 银行<refund | 银行2笔 + refund order3笔 | 同上 | 早→晚匹配，多出 refund order 不更新 |
| JPM-HK | Channel=JPM,地区=HK，Extra Information 含 `//T54SWIC123456//` | 同上 | 清洗提取后遍历 refund order 命中回填 |
| JPM-US | Channel=JPM,地区=US，refund order 银行打款流水号可在入金表命中 | 入金表已导入 | 二跳取 CustomerRef 比对银行 CustomerRef 回填 |
| 启用提醒 | 启用退款回填，导入不含 refund order 表 | 启用 | 弹提醒框 |

### 7.2 P1 应测场景

| 场景 | 输入 | 前置条件 | 预期结果 |
|------|------|----------|---------|
| FundType 已改写剔除 | 银行行 FundType 被 R4 改为 Ach Return | R4 启用 | 该行不参与退款回填（依赖 Q2） |
| 非 SUBMITTED 剔除 | refund order 状态=SUCCESS/其他 | — | 不参与对账 |
| 1v1 消费不重复 | 一条银行行可被多条 refund order 候选 | — | 仅被回填一次，其余走后续/报错 |
| 命中详情两句式 | 银行↔refund / 银行↔入金表 | — | 两种句式分别正确 |
| 数据隔离 | 同时启用场景2/3/4 | — | 三场景互不串池，bankRows 演化正确 |

### 7.3 不测项与原因

- 本版不跑代码（无实现），仅文档评审 —— 设计未定稿前任何运行测试无意义。
- 真实 JPM 报文 `//` 形态、真实 Channel/地区 字面值、真实「渠道大账号」字段归属：依赖用户提供真实样本，在实现版本手测时核对（与 beta.2「下版待测清单」同源风险）。

---

## 八、数据 / 状态 / 安全影响

| 类别 | 说明 |
|------|------|
| 数据结构变更 | 本版无（设计文档）。实现版本：可能新增 builtin-fixed seed config 行（`subCategory='refund-order-backfill'`，幂等）；依赖 ②`linked_bank_deposit` + ①`channel_enum_values`（本版已实现） |
| 状态流转变更 | refund order「状态」`SUBMITTED → SUCCESS`（命中回填时）—— 🔴 资金状态机变更，人工复核 |
| 权限 / 安全 | 不涉及鉴权；处理资金对账数据（退款单 / 银行打款），属敏感资金数据 |
| 回滚策略 | 实现版本：场景4 默认禁用即等同回滚（不调度引擎）；导出为独立 sheet 不影响主对账输出；seed config 幂等可删 |

> 🔴 **资金 / 状态机风险高亮**：回填动作改写退款单状态 + 写入对账 ID / 退款单号，属资金红线。决策矩阵任一格判定错误 → 错回填。**进入实现前必须完成第「九」章 12 条确认。**

---

## 九、已确认决议（✅ 用户已逐条敲定，2026-06-07）

> 以下 12 条（+Q8b）已由用户逐条确认，本章记录最终决议；正文 §5 已按此回写。进入实现版本直接以此为准。

- [x] **Q1 唯一值字段映射**：「渠道大账号 + 金额 + 币种」三元组的精确映射？
  - ✅ 最终：渠道大账号 = 银行 `MerchantId` ↔ refund order `银行大账号`；金额 = 银行发生额绝对值 `|Credit Amount − Debit Amount|` ↔ refund order `退款金额`；币种 = 银行 `Currency` ↔ refund order `币种`。
  - 说明：用户拍板「渠道大账号」取银行 `MerchantId`（非关联大账号）、金额取 refund `退款金额`（非原加款金额）。

- [x] **Q2 「FundType 值变更过的行」定义**：是否 = 被 R4 资金性质校验改写过 FundType 的行？
  - 建议：是。需 R4 / 编排器为「本轮改写过 FundType 的行」留改写标记位（如 `modColsByRowId` 含 `FundType` 列即视为变更过），退款回填筛选时排除这些行。
  - 理由：`modColsByRowId`（orchestrator）已逐列累积改写记录，复用即可判定 FundType 是否被改写，无需新增字段。

- [x] **Q3 4 策略优先级与命中即停**：S1→S2→S3→S4 是否按序「命中即停」？报错是否中止后续策略？
  - 建议：命中（回填成功）即停；某策略「报错人工介入」则停于该策略并记报错（不再尝试后续）；「未命中（关联不到）」才进下一策略。
  - 理由：与需求各格「关联不到的→进下一判断」「关联到多笔→报错」语义一致；避免一条数据被多策略重复回填。

- [x] **Q4 回填模板完整列**：现模板仅 4 列（退款单号/状态/渠道流水号/渠道退款时间）；需求要 E 列匹配详情 + F 列起原数据。
  - ✅ 最终：A=退款单号、B=状态、C=渠道流水号、D=渠道退款时间、E=匹配命中详情、F 起 = 银行 **9 字段**（按序）：`BillDate, Channel, 地区, MerchantId, Currency, Debit Amount, ReconciliationId, ChannelOrderNo, CustomerRef`。
  - 说明：用户指定 F 起只放上述 9 列（⚠️ 非 44 列全列；金额列只放 Debit Amount，不放 Credit Amount）；其余 35 列不放。

- [x] **Q5 「提示」vs「报错」输出去向**：报错→sheet2 已明确；「不更新并提示」去哪？
  - 建议：sheet2 增设一列「结果类型」区分「报错-人工介入」与「未匹配-提示」，二者同表不同标记（也便于人工筛选）。
  - 理由：需求反复区分二者；同落 sheet2 但用列区分，避免拆三个文件。

- [x] **Q6 MTX 提取与匹配方式**：从 `Extra Information` 提取 `MTX+19位数`（已实测 `/MTX\d{19}/`）；提取后与 refund order `附言` 如何匹配？
  - 建议：提取出的 MTX 串与 refund order `附言`做「包含」匹配（`附言.includes(mtx)`）。
  - 理由：附言通常是含 MTX 的长文本，等值过严；与 C1 多字段提取「值一致」语义不同（此处是跨表比对）。需确认是否「等值」。

- [x] **Q7 JPM-HK 清洗与遍历**：清洗 `//`（替换为空？）；`T54SWIC+6位数` 提取；遍历 refund order 所有字段（任一包含即命中？）。
  - ✅ 最终：清洗 = `split('//').join('')`；提取 `/T54SWIC\d{6}/` 后**仅与 refund order「银行打款流水号」单字段等值匹配**（不再遍历 25 列）。
  - 说明：用户将匹配范围从「遍历所有字段」收窄为「仅银行打款流水号等值」；清洗保留（实测对标准形态无副作用，防 `//` 切断流水号脏形态）。

- [x] **Q8 JPM-US 匹配链每跳**：refund order `银行打款流水号` →（入金表匹配 `ReconciliationId` 和 `ChannelOrderNo`）→ 取 `CustomerRef` → 比对银行 `CustomerRef`。
  - ✅ 最终：跳2 = **OR**（`入金表.ReconciliationId == payNo` 或 `入金表.ChannelOrderNo == payNo` 任一命中）；「关联到的 refund order」= 当前唯一值分组下 S1 已关联出的那条。
  - 说明：用户确认 OR（非 AND）。

- [x] **Q8b S3 字段映射方向**：refund order「付款人名称/付款卡号/虚拟卡号」↔ 银行「Drawee Name/Drawee CardNo/Payee CardNo」是否「按位对应」？
  - 建议：按位对应 —— 付款人名称↔Drawee Name、付款卡号↔Drawee CardNo、虚拟卡号↔Payee CardNo。
  - 理由：名称↔Name、卡号↔CardNo 语义对齐；虚拟卡号→Payee CardNo（收款卡号）是唯一剩余配对。需确认是否允许「任一对任一」交叉匹配。

- [x] **Q9 基数2-S3 自相矛盾**：原文「refund order 侧有一笔则报错人工介入」。
  - ✅ 最终：按「**多笔**报错人工介入、一笔回填」（用户确认原文「有一笔报错」为笔误）。
  - 说明：与基数3/4 的 S3「多笔报错、一笔回填」一致。

- [x] **Q10 基数4-S4「条数相等」分支**：原文只给「银行<refund」「银行>refund」，未给「相等」。
  - 建议：相等时按 BillDate 早→晚逐条 1v1，≤10 天取最近回填，>10 天报错。
  - 理由：与两个已定义分支同口径；相等是两者特例。需确认。

- [x] **Q11 回填动作改写对象 / 标黄**：回填动作改的是 refund order 行（流水号/状态等）还是只产出回填模板行？是否需要标黄 / 进 modifications？
  - 建议：本引擎不改 bankRows（银行行只读消费），回填动作产出**独立的回填模板行集合**（仿场景3 `cleanupRows`），不进银行行标黄；warnings 用于报错收集。状态机变更体现在导出模板「状态=SUCCESS」，不回写 refund order 链接表/session。
  - 理由：与场景3 范式一致（独立行集合 + 独立 writer），避免污染主对账银行行输出；但需确认是否还要把 SUCCESS 写回 refund order 持久层。

- [x] **Q12 启用提醒触发点 + 命中详情文案定稿**：提醒触发点参考 `maybePromptGatewayReconImport`（`renderer.js:3521`）；命中详情精确文案。
  - 建议：触发点仿网关提醒（导入文件集合按表头识别 refund order 签名未命中即弹）；命中详情文案按 §5.1.4 两句式，字段名用中文展示名（如「银行对账单 ChannelOrderNo」「refund order 银行打款流水号」），实际值取原始单元格值。
  - 理由：复用现有提醒范式成本最低；文案需用户拍板（影响人工审计可读性）。

> ✅ 已确认：**场景4 默认禁用**（builtin-fixed seed `enabled=false`，与场景2/3 一致，用户手动开启）。

### 九 bis、实现期新增决议（✅ 用户确认，2026-06-08；v2.1.16-beta.4 对抗式矩阵验证发现）

> 实现版本 v2.1.16-beta.4 对引擎做 4 基数×4 策略真跑对抗验证，发现收敛模型在「反向多笔 / S4 报错顺序依赖 / 报错后 refund 复用」三处与 §5.2 逐格规则不等价或 PRD 未写死。以下 3 条经用户拍板，作为实现契约（正文 §5.2/§5.3 据此为准）：

- [x] **Q13（= 验证 G1）S4 超容差报错粒度**：S4 兜底中多条银行行均因「BillDate 与 valueDate 差异 >10 天」无法匹配时，**每条超容差银行行各产 1 行 `报错-人工介入`**（与 §5.1.5 sheet2 银行行粒度一致），非整组汇总一行。
- [x] **Q14（= 验证 G2）反向多笔（N 银行行命中同 1 refund）**：同一唯一值分组下，某条 refund order 被 ≥2 条银行行经 S1/S2/S3 命中时，**这些涉事银行行全部落 `报错-人工介入`、该 refund 不回填**（资金红线保守，人工决定配对；与 Q9「多笔报错不回填」精神一致）。即：策略命中后必须做「按 refund 反向聚合」检测——任一 refund 被多银行命中 → 涉事银行整体报错，不回填一条。
- [x] **Q15（= 验证 G3）报错链路 refund 锁定**：因 S1~S3 多笔（正向或反向）报错而卷入的 refund order，**标记锁定、退出本组后续对账，不可再被同组其他银行行经 S4 兜底静默回填**（避免「应人工介入的退款单被错配到别的银行行」）。
- 配套修复（实现层，非业务歧义）：S4「报错 vs 提示」判定改为基于 **S4 入口冻结的候选集**（该银行行在原始同组 refund 内是否存在但日期超容差 → 报错；本就无同金额币种候选 → 提示），消除「超容差行排在被消费之后被静默降级为提示」的顺序依赖。

---

## 十、非功能性要求

| 类别 | 要求 |
|------|------|
| 向下兼容 | 纯新增 R5 场景4；不改场景2/3/R1/R2/R3/R4 行为；默认禁用不影响现有对账 |
| 性能 | 数据量级与场景2/3 同量级（银行对账单万级、refund order 千级）；唯一值分组 + 策略匹配走内存，避免 O(n²) 全表笛卡尔（按唯一值分组后组内匹配）；JPM-US 入金表查询走内存索引（按 ReconciliationId/ChannelOrderNo 建 Map） |
| 鲁棒性 | 空入参（无 refund order / 无银行 Ach Return 行）→ 返回空结果不报错；提取不到 MTX/T54SWIC → 回落常规策略不抛异常；日期 / 金额非法值复用工具的 null 防御 |

---

## 十一、变更记录

| 日期 | 变更内容 |
|------|---------|
| 2026-06-07 | 初稿：③ 中台退款订单回填引擎 PRD（4 基数×4 策略决策矩阵 + JPM HK/US 双分支 + 数据筛选 / 回填动作 / 命中详情 / 双 sheet 导出 + 12 条歧义）。本版仅设计不实现 |
| 2026-06-07 | 定稿：12 条歧义经用户逐条确认回写 —— Q1 大账号=MerchantId/金额=退款金额；Q4 F 起 9 字段；Q7 JPM-HK 仅等值匹配「银行打款流水号」；Q8 JPM-US OR；Q9 基数2-S3 多笔报错一笔回填；余采纳默认；场景4 默认禁用。 |

---

## 十二、实施记录

> 由 PR merged + 归档后自动追加，PM 不需要手动填写。本版仅设计文档，无代码实施。
