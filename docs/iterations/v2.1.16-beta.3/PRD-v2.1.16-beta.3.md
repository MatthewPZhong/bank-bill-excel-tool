# PRD - 网银账单小助手 v2.1.16-beta.3

| 项目 | 内容 |
|------|------|
| 版本 | v2.1.16-beta.3 |
| 日期 | 2026-06-07 |
| 作者 | PM |
| 状态 | 定稿 |
| 模块 | 资金对账数据处理（链接表管理、银行对账单导入、数据库持久化层）|
| 依赖 | v2.1.16-beta.1 阶段一地基（`table-type-detector.js`、`linked-table-repository.js`、链接表 schema、`bank-statement-merge.js`）已合入 main |

> 本文档承载 v2.1.16-beta.3 的 **①Channel 枚举表** 与 **②银行对账单入金表** 两项需求规格。
> 二者是后续「中台退款订单回填引擎」（③，本版仅产出独立设计文档、不实现）的**前置数据依赖**：
> JPM 退款分支需读 Channel/地区枚举判分支，JPM-US 分支需查入金表的 `ReconciliationId/ChannelOrderNo/CustomerRef`。
> ① ② 均为**纯增量、低风险**：新增 SQLite 表 + 仓储层 + 沉淀/导入挂钩，不改动既有对账逻辑、不破坏 main 可发布性。

---

## 一、需求概述

本次包含 2 项需求：

1. **Channel 枚举表（纯数据沉淀，无 UI）** —— 每次导入银行对账单后，去重沉淀两类枚举值：`Channel` 字段值、`<Channel-地区>` 拼接值（如 `JPM-HK`），落 SQLite 供后续退款回填引擎读库 + 审计值字典。沉淀失败绝不阻断导入。
2. **银行对账单入金表（新链接表库）** —— 链接表管理新增第 5 张表库「银行对账单入金表」，模板取 `assets/银行对账单.xlsx`，**复用现有「导入」按钮**，导入后整表覆盖落库 **C~N 列 + FundType 共 13 字段**。

---

## 二、背景与目标

### 2.1 背景

**需求 ①（Channel 枚举表）**

- **为什么要做**：③ 中台退款订单回填引擎的 JPM 分支需要根据银行对账单的 `Channel`、`地区` 判定走 JPM-HK 还是 JPM-US 子流程。引擎实现前，需要先有一份**真实出现过的 Channel / Channel-地区 枚举字典**作为读库依据与人工审计参照（哪些渠道-地区组合在历史账单里真实出现过）。
- **业务价值**：(a) 为后续引擎提供稳定、去重、可查询的枚举数据源；(b) 沉淀审计值字典，帮助业务人员核对渠道地区组合是否符合预期。
- **当前问题**：系统在导入银行对账单时**未沉淀任何 Channel 维度的去重数据**，每次需要时都得重新全表扫描，且无历史累积。

**需求 ②（银行对账单入金表）**

- **为什么要做**：③ 引擎的 JPM-US 分支匹配链路需要：refund order 的「银行打款流水号」→ 在**入金表**匹配 `ReconciliationId` / `ChannelOrderNo` → 取该行 `CustomerRef` → 与导入银行对账单 `CustomerRef` 匹配回填。这条链路依赖一份**持久化、可重复查询的入金表数据**，而非每次临时导入的内存 session。
- **业务价值**：(a) 给链接表管理体系补齐第 5 张表库，与现有 4 张（网关对账单 / 中台调拨订单 / 外汇交割表 / 外汇期权表）形成统一的「join 键 + 日期 + 整行 raw_json」持久化范式；(b) 复用现有导入按钮，零新增交互、零学习成本。
- **当前问题**：链接表管理弹窗目前只有 4 张表库（`gateway-bill` / `mid-allocation` / `fx-settlement` / `fx-option`，见 `linked-table-repository.js:70` `ALL_TABLE_KEYS`），无入金表；银行对账单数据只能作为预加工主表临时导入内存，不可持久化复查。

### 2.2 目标

- **需求 ①**：导入银行对账单（单选 `bank-statement:import` + 批量 `bank-statement:batch-import` 的每个成功银行对账单文件）成功后，自动去重沉淀 `Channel` 值与 `Channel-地区` 拼接值到新表 `channel_enum_values`；提供 facade 供后续引擎读库。沉淀过程 try-catch 包裹，失败仅记 warn 日志，绝不影响导入结果。
- **需求 ②**：链接表管理弹窗新增「银行对账单入金表」一行；用户点底部现有「导入」按钮选 `银行对账单.xlsx` → 自动识别为入金表 → 裁出 13 字段 → 整表覆盖落库 `linked_bank_deposit`；弹窗显示其数据日期范围 / 更新时间。

### 2.3 明确不做

- ① **不做任何 UI**：枚举表纯后端沉淀，本版不在任何弹窗 / 页面展示枚举值（仅留 facade）。
- ① **不做删除 / 清理入口**：枚举只增量 upsert（更新 `last_seen_at` / `seen_count`），不提供清空、编辑、导出 UI。
- ② **不新增 IPC、不新增交互入口**：严格复用现有 `linked-table:import` handler 与链接表管理弹窗「导入」按钮，不加任何新按钮 / 菜单。
- ② **不为 `ChannelOrderNo` 单独建索引**：暂存 raw_json，下游 JPM-US 匹配数据量小走内存，索引留待 ③ 引擎实现时评估。
- ③ **中台退款订单回填引擎本版不实现**：仅产出独立设计文档（另文 `TECH_DESIGN-v2.1.16-beta.3-refund-engine.md` 或后续版本），代码不在本版落地。
- 文档三件套（CHANGELOG / VERSION_FEATURE_HISTORY / USER_GUIDE）按 beta 惯例**本版不更新**，转正 `2.1.16` 时统一更新。

---

## 三、代码现状（必须有出处）

| 需求 | 相关文件 | 当前行为 | 已知限制 |
|------|---------|---------|---------|
| ① | `src/main.js:3451` `bank-statement:import` | 单选导入银行对账单 → `readBankStatement(filePath)` → 写 `bankStatementSession`（`rows` 为对象数组，key=44 列表头）→ 清 `processingResult`/`gatewayReconSession` | 导入成功后**无任何枚举沉淀**钩子 |
| ① | `src/main.js:11178` `bank-statement:batch-import` | 多选批量导入；`tableKey==='bank-statement'` 分支（11232）`readBankStatement` → `mergeBankStatementRows` 合并/重编号 → 建或追加 session，push `status:'ok'`（11269） | 每个成功银行对账单文件导入后**无枚举沉淀**钩子 |
| ① | `src/main-process/bank-statement-io.js:73` `readBankStatement` | 返回 `{rows, headers, rowCount}`，`rows` 为对象数组（`sheetToObjects(sheet, BANK_STATEMENT_FIELDS)`），可直接 `row['Channel']`/`row['地区']` 取值，已注入 `_rowId` | 无 |
| ① | `src/backend/database/migrations.js:2455` `module.exports` | 现有 40+ 个 `ensureXxxSupport` 迁移函数，启动期幂等执行 | 无 `ensureChannelEnumSupport`，无 `channel_enum_values` 表 |
| ① | `src/backend/database.js:464` `init()` | 启动期顺序调用各 `ensureXxxSupport`（含 `this.ensureLinkedTableSupport()`） | 未调用 channel-enum 迁移；无 channel-enum facade |
| ② | `src/constants/table-signatures.js:37` `BANK_STATEMENT_SIGNATURE` | 银行对账单 44 列签名，`tableKey='bank-statement'`, `scope='preprocess'`，进 `PREPROCESS_TABLE_SIGNATURES` 与 `ALL_TABLE_SIGNATURES` | 无 `BANK_DEPOSIT_SIGNATURE`，无 `LINKED_IMPORT_SIGNATURES` 导出 |
| ② | `src/constants/table-signatures.js:186` `LINKED_TABLE_SIGNATURES` | 4 条 linked 签名（调拨 / 网关 / 交割 / 期权）；`ALL_TABLE_SIGNATURES` = preprocess + linked | 入金表需识别但**不能进 `ALL_TABLE_SIGNATURES`**（同构 ambiguous）|
| ② | `src/main-process/table-type-detector.js:200` `detectTableType(filePath, candidateSignatures=ALL_TABLE_SIGNATURES)` | 仅在传入候选集内匹配；缺省候选集 = `ALL_TABLE_SIGNATURES` | 生产仅 2 调用点：`main.js:11076`(`LINKED_TABLE_SIGNATURES`) / `main.js:11199`(`PREPROCESS_TABLE_SIGNATURES`)，**无人用缺省** |
| ② | `src/main.js:11059` `linked-table:import` | 弹多选文件框 → 逐文件 `detectTableType(filePath, LINKED_TABLE_SIGNATURES)`（11076）→ `LINKED_DETECTOR_TO_REPO_KEY` 映射 → `readLinkedRowsAsObjects(filePath, signature)`（11123）→ `database.replaceLinkedTable(repoKey, rows, ...)`（11124） | 候选集为 `LINKED_TABLE_SIGNATURES`（不含入金表）；落库不裁列 |
| ② | `src/backend/database/linked-table-repository.js:30` `LINKED_TABLE_DEFS` | 4 个 tableKey 自包含定义（table/keyColumn/keyHeader/dateColumn/dateHeader/supported）；`replaceLinkedTable` 整表覆盖（DELETE+批量INSERT+算日期范围+upsert meta） | 无 `bank-deposit` 定义；`ALL_TABLE_KEYS`（:70）仅 4 项 |
| ② | `src/backend/database/migrations.js:2391` `ensureLinkedTableSupport` | 事务内建 `linked_table_meta` + 3 张数据表（gateway/mid-allocation/fx-settlement）+ 6 索引；2446 行有「待补一张表」注释位 | 无 `linked_bank_deposit` 表 |
| ② | `src/renderer-dialogs.js`（链接表弹窗 ~6162） | 弹窗按 `listLinkedTableMeta` 返回的 tableKey 列表渲染行，label 取 `LINKED_TABLE_LABELS` 映射 | 无 `'bank-deposit'` label |

---

## 四、术语

| 术语 | 含义 |
|------|------|
| Channel | 银行对账单第 6 列（`BANK_STATEMENT_FIELDS` 索引 5），渠道标识，如 `JPM` |
| 地区 | 银行对账单第 7 列（索引 6），渠道所属地区，如 `HK` / `US` |
| Channel-地区拼接值 | `<Channel> + '-' + <地区>`，如 `JPM-HK`；**仅当地区非空才生成**，避免 `JPM-` 脏值 |
| value_type | 枚举值类型，CHECK 约束取 `'channel'` 或 `'channel-region'` 二者之一 |
| 入金表 / bank-deposit | 链接表管理新增第 5 张表库「银行对账单入金表」，存银行对账单的 C~N + FundType 13 字段 |
| C~N 列 | 银行对账单 44 列中的第 3~14 列（`BANK_STATEMENT_FIELDS` 索引 2~13）|
| 链接表（linked table）| scope='linked' 的补充对账数据表，持久化为「join 键列 + 日期列 + raw_json 整行」混合存储 |
| 整表覆盖 | `replaceLinkedTable` 语义：重导即事务内 DELETE 全表 + 批量 INSERT，旧数据全删 |
| 候选集隔离 | `detectTableType` 只在传入的候选签名集内匹配；不同调用点传不同子集互不干扰 |
| facade | `database.js` 上对仓储层纯函数的薄封装方法（如 `database.recordChannelEnumFromBankStatement(rows)`）|

---

## 五、功能详细描述

### 5.1 需求 ①：Channel 枚举表（纯数据沉淀，无 UI）

#### 5.1.1 说明

- **输入**：一批银行对账单行（对象数组，每行 `row['Channel']` / `row['地区']` 可取值，来自 `readBankStatement` 的 `rows`）。
- **输出**：去重 upsert 进 `channel_enum_values` 表的两类记录；不返回给用户、不产生文件。
- **沉淀两类值**：
  1. `value_type='channel'`：每行 `Channel` 字段值（trim 后非空才记）。
  2. `value_type='channel-region'`：`<Channel>-<地区>` 拼接值（**仅当 Channel 与 地区 trim 后均非空**才记）。
- **去重 + 累积语义**（upsert，UNIQUE(value_type, enum_value)）：
  - 新值 → INSERT，`first_seen_at = last_seen_at = now`，`seen_count = 1`。
  - 已存在值 → UPDATE，`last_seen_at = now`，`seen_count = seen_count + 1`（`first_seen_at` 不变）。
  - `seen_count` 口径：按「沉淀批次中出现过的行数」累加（同一批多行同值累加多少，见下方边界与 TECH 实现）。
- **边界条件**：
  - 🔴 **地区空只落 channel**：`Channel='JPM'` 但 `地区=''`（或 null / 纯空格）时，**只沉淀 `channel='JPM'`，跳过 `channel-region` 拼接**，绝不生成 `'JPM-'` 脏值。
  - `Channel` 本身为空（trim 后空）→ 该行两类都不沉淀（无渠道无意义）。
  - 进程内先 dedupe 再写库：一批 rows 内重复的 (value_type, enum_value) 合并，减少 upsert 次数（具体计数口径见 TECH §3.4）。
  - 🔴 **不阻断导入**：整个沉淀调用在导入 handler 内 **try-catch 包裹**，任何异常（DB 锁、约束冲突、字段缺失）只记 `console.warn` 级日志，导入结果照常返回 `status:'ok'`。
  - **纯沉淀、非资金红线**：`recordFromBankStatementRows` 只新增/累加枚举字典，不删除、不改写任何对账数据；属审计辅助。代码注释须标注此性质。

#### 5.1.2 影响范围

- 前端：无（纯后端沉淀）。
- 后端：`migrations.js`（新增迁移）、`channel-enum-repository.js`（新建）、`database.js`（facade + init 调用）、`main.js`（2 处导入 handler 加沉淀钩子）。
- 数据库：新增表 `channel_enum_values` + 1 个 type 索引（CREATE IF NOT EXISTS 幂等）。
- 对外接口影响：无（不新增 IPC；facade 仅供进程内后续引擎调用）。
- 兼容性影响：纯增量，旧库启动期自动建表；不影响任何既有功能。

#### 5.1.3 UI Mockup（如适用）

无（需求 ① 无 UI）。

---

### 5.2 需求 ②：银行对账单入金表（新链接表库）

#### 5.2.1 说明

- **输入**：用户在链接表管理弹窗点底部「导入」按钮（现有），选择 `银行对账单.xlsx`（或同结构 44 列文件）。
- **输出**：整表覆盖落库到 `linked_bank_deposit`，仅保留 13 字段；链接表管理弹窗新增「银行对账单入金表」行并显示数据日期范围 / 更新时间。
- **13 字段口径**（来自 `BANK_STATEMENT_FIELDS`，C~N 列 + FundType）：

  | # | 字段名（表头，原样） | `BANK_STATEMENT_FIELDS` 索引 | 列（Excel）|
  |---|------|------|------|
  | 1 | `BizId` | 2 | C |
  | 2 | `BillDate` | 3 | D |
  | 3 | `ValueDate` | 4 | E |
  | 4 | `Channel` | 5 | F |
  | 5 | `地区` | 6 | G |
  | 6 | `MerchantId` | 7 | H |
  | 7 | `Currency` | 8 | I |
  | 8 | `Credit Amount` | 9 | J |
  | 9 | `Debit Amount` | 10 | K |
  | 10 | `ReconciliationId` | 11 | L |
  | 11 | `ChannelOrderNo` | 12 | M |
  | 12 | `CustomerRef` | 13 | N |
  | 13 | `FundType` | 25 | （第 26 列）|

  > C~N = 索引 2~13 共 12 字段（连续），加索引 25 `FundType`，共 13 字段。JPM-US 匹配所需的 `ReconciliationId` / `ChannelOrderNo` / `CustomerRef` 均在 C~N 内。

- **落库口径**：
  - 复用 `replaceLinkedTable(db, 'bank-deposit', rows13, {sourceFileName})` 整表覆盖。
  - 键列 `reconciliation_id = ReconciliationId`，日期列 `bill_date = BillDate`（与签名 `dateColumn:'BillDate'` 对齐）。
  - `raw_json` 天然只存裁列后的 13 字段对象（裁列在 handler 完成，`replaceLinkedTable` 不感知裁列）。
- **入口与识别机制**（🔴 关键）：
  1. 新增 `BANK_DEPOSIT_SIGNATURE`：复用 `BANK_STATEMENT_FIELDS`（44 列 `expectedHeaders`，指纹列同主表），`tableKey='bank-deposit'`, `scope='linked'`。
  2. 新增导出 `LINKED_IMPORT_SIGNATURES = [...LINKED_TABLE_SIGNATURES, BANK_DEPOSIT_SIGNATURE]`。
  3. `main.js:11076` 的 `detectTableType` 候选集由 `LINKED_TABLE_SIGNATURES` 改为 `LINKED_IMPORT_SIGNATURES`；`getLinkedSignatureByKey` 改用 `LINKED_IMPORT_SIGNATURES` 查找。
  4. 🔴 **`ALL_TABLE_SIGNATURES` 必须保持不含 `BANK_DEPOSIT_SIGNATURE`**：入金表签名与主表 `BANK_STATEMENT_SIGNATURE` 是**同构 44 列**（指纹完全相同），若两者同时进缺省候选集 `ALL_TABLE_SIGNATURES`，任何缺省调用都会 ambiguous。做法：不把它塞进会被 ALL 聚合的 `LINKED_TABLE_SIGNATURES`，单独经 `LINKED_IMPORT_SIGNATURES` 仅供链接表导入候选集使用。
- **边界条件**：
  - 🔴 **裁列必须在 44 列校验之后**：`readLinkedRowsAsObjects(filePath, BANK_DEPOSIT_SIGNATURE)` 按 44 列 `expectedHeaders` 读全行（含 detector L1/L2 校验把关，异构文件读不出来），裁列在此**之后**对每行按 13 个字段名 pick 构造新对象，防异构文件错列污染 JPM-US 匹配键。
  - 🔴 **裁列按字段名 pick，非纯索引切片**：用 13 个字段名常量 pick（`row['ReconciliationId']` 等），不用 `slice(2,14)`，防 `BANK_STATEMENT_FIELDS` 列顺序变动导致裁错列。
  - **预加工导入不受影响**：同一份 `银行对账单.xlsx` 走「批量导入对账单」（`bank-statement:batch-import`，候选集 `PREPROCESS_TABLE_SIGNATURES`）仍识别为 `bank-statement` 主表（不串）。
  - 重导覆盖：`replaceLinkedTable` 整表 DELETE + 重新 INSERT，旧入金表数据全删（与现有 4 张链接表同语义）。

#### 5.2.2 影响范围

- 前端：`renderer-dialogs.js` 仅新增 1 行 label（`'bank-deposit':'银行对账单入金表'`），弹窗自适应渲染第 5 行，无布局改动。
- 后端：`table-signatures.js`（新签名 + 新导出）、`migrations.js`（建 `linked_bank_deposit` 表 + 索引）、`linked-table-repository.js`（`LINKED_TABLE_DEFS` + `ALL_TABLE_KEYS` 追加 bank-deposit）、`main.js`（`LINKED_DETECTOR_TO_REPO_KEY` 追加 + 候选集改 `LINKED_IMPORT_SIGNATURES` + bank-deposit 分支裁列）。
- 数据库：新增表 `linked_bank_deposit`（id / reconciliation_id / bill_date / raw_json / imported_at）+ recon/date 两索引（CREATE IF NOT EXISTS 幂等）；`linked_table_meta` 自动新增一行（无需改表结构）。
- 对外接口影响：无新增 IPC（复用 `linked-table:import`）；`database.js` facade `replaceLinkedTable` / `listLinkedTableMeta` 已通用，走 `ALL_TABLE_KEYS` 自动含 bank-deposit，**facade 无需改**。
- 兼容性影响：纯增量；旧库启动期自动建表；预加工主表识别不受影响（候选集隔离已验证）。

#### 5.2.3 UI Mockup（如适用）

链接表管理弹窗（现有，新增最后一行；布局不变）：

```
┌──────────────────────── 链接表管理 ──────────────────────────┐
│ 表名                  │ 数据日期范围          │ 表更新日期       │
│──────────────────────│──────────────────────│─────────────────│
│ 网关对账单            │ 2026-01-01 ~ 2026-03-31 │ 2026-06-07     │
│ 中台调拨订单表        │ —                     │ 未导入          │
│ 外汇交割表            │ —                     │ 未导入          │
│ 外汇期权表            │ —（待阶段二接入）      │ —              │
│ 银行对账单入金表 ★新   │ —                     │ 未导入          │  ← 本版新增行
│──────────────────────────────────────────────────────────────│
│                                              [导入]  [退出]     │  ← 复用现有按钮
└────────────────────────────────────────────────────────────────┘
```

> 「导入」按钮选 `银行对账单.xlsx` → detector 在链接候选集内唯一命中 `bank-deposit` → 裁 13 字段落库 → 该行刷新日期范围 / 更新日期。

---

## 六、验收标准

> 本章节共 **18 条** AC（① 8 条 + ② 10 条）。

### 6.1 需求 ①：Channel 枚举表 AC

| AC 编号 | 验收条件 |
|---------|---------|
| AC1-1 | 启动应用后，SQLite 存在表 `channel_enum_values`，含列 `id` / `value_type` / `enum_value` / `first_seen_at` / `last_seen_at` / `seen_count`，且 `value_type` 有 CHECK IN('channel','channel-region') 约束、`(value_type, enum_value)` 有 UNIQUE 约束、`value_type` 有索引 |
| AC1-2 | 单选导入（`bank-statement:import`）一份 `Channel` 非空、`地区` 非空的银行对账单后，查库 `channel_enum_values` 同时出现该行的 `channel`（如 `JPM`）与 `channel-region`（如 `JPM-HK`）两类去重记录 |
| AC1-3 | 批量导入（`bank-statement:batch-import`）多份银行对账单，每个识别为 `bank-statement` 且导入成功的文件都触发沉淀；最终库内枚举值为各文件去重并集 |
| AC1-4 | 🔴 **地区空只落 channel**：导入一行 `Channel='JPM'`、`地区=''`（空 / 空格 / null）的数据后，库内有 `channel='JPM'`、**无** `channel-region='JPM-'` 记录 |
| AC1-5 | `Channel` 为空（trim 后空）的行不产生任何枚举记录 |
| AC1-6 | 重复导入同值：同一 (value_type, enum_value) 不产生重复行（UNIQUE 生效），`last_seen_at` 刷新、`seen_count` 累加、`first_seen_at` 不变 |
| AC1-7 | 🔴 **沉淀不阻断导入**：人为构造沉淀异常（如模拟 DB 抛错）时，导入 handler 仍返回 `status:'ok'`，仅打印 warn 日志；导入的 `bankStatementSession` 数据完整可用于后续对账 |
| AC1-8 | `database.listChannelEnumValues('channel')` 与 `listChannelEnumValues('channel-region')` 能分别按 type 过滤返回对应枚举值列表 |

### 6.2 需求 ②：银行对账单入金表 AC

| AC 编号 | 验收条件 |
|---------|---------|
| AC2-1 | 链接表管理弹窗渲染 **5 行**，最后一行为「银行对账单入金表」，初始日期范围「—」、更新日期「未导入」 |
| AC2-2 | 在弹窗点「导入」选 `assets/银行对账单.xlsx` → 返回 `status:'ok'`，该文件 result `tableKey='bank-deposit'`、`status:'ok'`、`rowCount` 等于文件数据行数 |
| AC2-3 | 导入后查库 `linked_bank_deposit`，每行 `raw_json` 解析出的对象**恰好含 13 个字段**（`BizId`/`BillDate`/`ValueDate`/`Channel`/`地区`/`MerchantId`/`Currency`/`Credit Amount`/`Debit Amount`/`ReconciliationId`/`ChannelOrderNo`/`CustomerRef`/`FundType`），不含其余 31 列 |
| AC2-4 | `linked_bank_deposit` 行的 `reconciliation_id` 列 = 该行 `ReconciliationId` 值（归一为 String）；`bill_date` 列 = 该行 `BillDate` 归一后的 `YYYY-MM-DD` |
| AC2-5 | 导入后重开链接表弹窗，「银行对账单入金表」行显示正确的数据日期范围（min~max BillDate）与更新时间 |
| AC2-6 | 🔴 **整表覆盖**：第二次导入另一份入金表后，`linked_bank_deposit` 仅含第二份数据（第一份全部被删除）|
| AC2-7 | 🔴 **ALL_TABLE_SIGNATURES 隔离**：单测断言 `ALL_TABLE_SIGNATURES` **不含** `BANK_DEPOSIT_SIGNATURE`（tableKey 'bank-deposit' 不在其中）；`LINKED_IMPORT_SIGNATURES` **含**之 |
| AC2-8 | 🔴 **预加工不串**：同一份 `银行对账单.xlsx` 走「批量导入对账单」仍识别为 `bank-statement` 主表（写入 `bankStatementSession`），不被识别为 bank-deposit |
| AC2-9 | 🔴 **裁列在校验之后**：导入一份缺列 / 列错位的异构 44 列文件，detector 因 L1/L2 校验不通过返回 `unrecognized`/`ambiguous`/`read-error`，**不会**裁列落库脏数据 |
| AC2-10 | `database.listLinkedTableMeta()` 返回 **5 个** tableKey 的 meta（含 `bank-deposit`），顺序中入金表在末位 |

---

## 七、手动测试清单

### 7.1 P0 必测场景

| 场景 | 输入 | 前置条件 | 预期结果 |
|------|------|----------|---------|
| ② 入金表导入 | 链接表弹窗点「导入」→ `assets/银行对账单.xlsx` | 应用启动、库已建 `linked_bank_deposit` | 提示导入成功 N 行；重开弹窗第 5 行显示日期范围/更新时间 |
| ② 整表覆盖 | 连续导入两份不同入金表 | 第一份已导入 | 第二份覆盖第一份；弹窗日期范围更新为第二份 |
| ② 预加工不串 | 「批量导入对账单」选同一 `银行对账单.xlsx` | — | 识别为银行对账单主表，进入对账流程；不写 `linked_bank_deposit` |
| ① 枚举沉淀 | 单选 / 批量导入银行对账单（含 JPM-HK 等组合） | 库已建 `channel_enum_values` | 查库出现去重的 channel 与 channel-region 值 |
| ① 地区空边界 | 导入含 `Channel='X'`、`地区` 空的行 | — | 库有 `channel='X'`，无 `channel-region='X-'` |

### 7.2 P1 应测场景

| 场景 | 输入 | 前置条件 | 预期结果 |
|------|------|----------|---------|
| ② 异构文件 | 导入缺列 / 错位的 44 列文件 | — | detector 不唯一命中 → 报 unrecognized/ambiguous；不落脏数据 |
| ② 非入金表链接文件 | 导入 `网关对账单.xlsx` | — | 仍正确识别为 gateway-bill 并落库（入金表签名不干扰）|
| ① 重复导入累积 | 同份银行对账单导入两次 | — | 枚举无重复行，`seen_count` 增长，`last_seen_at` 刷新 |
| ① 沉淀异常容错 | （需 dev 临时注入异常）导入触发沉淀报错 | — | 导入仍成功，控制台 warn，无弹错 |
| 旧库升级 | 用 beta.2 旧库启动 beta.3 | 旧库无新表 | 启动期自动建 `channel_enum_values` / `linked_bank_deposit`，无报错 |

### 7.3 不测项与原因

- ③ 中台退款订单回填引擎相关场景：本版不实现，不测。
- 枚举表 UI 展示：本版无 UI，不测。
- `ChannelOrderNo` 索引查询性能：本版未建该索引，下游走内存，不测。
- 跨平台（Win/macOS）SQLite 行为差异：`node:sqlite` 一致，沿用既有链接表回归结论，不单独测。

---

## 八、数据 / 状态 / 安全影响

| 类别 | 说明 |
|------|------|
| 数据结构变更 | 🔴 新增表 `channel_enum_values`（6 列 + UNIQUE + CHECK + type 索引）；新增表 `linked_bank_deposit`（5 列 + recon/date 两索引）；`linked_table_meta` 自动多一行（结构不变）。均 CREATE IF NOT EXISTS 幂等。 |
| 状态流转变更 | 无状态机变化。运行时状态 `bankStatementSession` / `processingResult` / `gatewayReconSession` 语义不变（沉淀钩子只读 rows，不改 session）。 |
| 权限 / 安全 | 不涉及鉴权。沉淀/落库均为本地 SQLite，无敏感数据外发。Channel/地区/ReconciliationId 等为业务标识，非个人隐私字段。 |
| 回滚策略 | 纯增量，回滚 = revert 代码即可；新建表为 IF NOT EXISTS，残留空表不影响旧版本运行（旧版本不读它们）。无数据迁移、无破坏性 DDL。 |

> 🔴 **资金/数据红线提醒**（须人工复核）：
> 1. **入金表整表覆盖**：`replaceLinkedTable` 重导=旧数据全删，与现有链接表同语义，但仍属删除数据操作。
> 2. **裁列字段-列顺序耦合**：`BANK_STATEMENT_FIELDS` 列顺序属 Critical 变量；裁列须按字段名 pick + 启动期 assert 13 字段 ∈ 常量表防漂移。
> 3. **ALL_TABLE_SIGNATURES 隔离不变量**：入金表签名进 ALL 会致缺省候选 ambiguous，须单测守护。
> 4. **沉淀不可阻断导入**：① 沉淀失败 try-catch 吞掉记 warn，绝不让导入失败。

---

## 九、非功能性要求

| 类别 | 要求 |
|------|------|
| 向下兼容 | 旧库（beta.2 及更早）启动 beta.3 自动建新表，零手动迁移；旧版本读旧库不受新表影响 |
| 性能 | 枚举沉淀进程内先 dedupe 再单事务批量 upsert，单次导入额外开销可忽略（数千行量级）；入金表落库复用既有 `replaceLinkedTable` 单事务批量 INSERT |
| 鲁棒性 | ① 沉淀全程 try-catch，失败不阻断导入；② 裁列按字段名 pick 防列序漂移；detector 候选集隔离防误识别 |

---

## 十、待澄清问题

- [x] 入金表导入入口 → 用户拍板**复用现有链接表「导入」按钮**（决策表 #5）。
- [x] 枚举表是否需要 UI → 用户拍板**纯数据沉淀，不做 UI**（决策表 #6）。
- [x] 13 字段范围 → C~N + FundType，已与 `BANK_STATEMENT_FIELDS` 索引逐列核对。
- [x] 地区空时 channel-region 处理 → **只落 channel，跳过拼接**。
- [ ] `seen_count` 累加口径细节：是否按「同一批去重前的行数」累加（同批 3 行同值 +3）还是「按批次 +1」→ 默认按 TECH §3.4 口径（去重前出现行数累加），dev 实现前如有歧义回 PM 确认。
- [ ] 入金表导入成功后的前端提示文案是否区别于其他链接表（默认沿用现有 `linked-table:import` 结果提示，不特殊化）。

---

## 十一、变更记录

| 日期 | 变更内容 |
|------|---------|
| 2026-06-07 | 初稿 + 定稿：① Channel 枚举表 + ② 银行对账单入金表 需求规格（基于已批准实施计划与已核实代码事实）|

---

## 十二、实施记录

> 由 PR merged + 归档后自动追加，PM 不需要手动填写。
