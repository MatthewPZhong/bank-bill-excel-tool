# PRD - 网银账单生成小助手 v3.0.10（🔴 资金红线：R4 方向守卫 / R5s4 网关前置过滤 / 退款回填输出改造）

| 项 | 值 |
|---|---|
| 版本 | v3.0.10 |
| 状态 | 初稿（待评审） |
| 模块 | 对账引擎🔴 — R4 资金性质校验 · R5s4 退款订单回填 · 退款回填输出文件（sheet1/sheet2） |
| 实施方式 | team-lead 不亲自小步写；审批后开 ultracode workflow，**Phase A 文档先行（本 PRD + TECHDOC，含修订后的 D8）→ Phase B 按需求 1/2/3 改 7 个源码文件 + 全部测试（跨接缝处重点 codex review）→ Phase C 收口（release-check + 三件套 + version bump + /check-vars）**。用户手动测试循环 → 用户明确说「提 PR」后才提（不自动提 PR）。 |
| 质量门 | `npm run release-check` 全绿（unit + integration + smoke）；🔴 资金红线（改 R4 FundType 改写口径 + R5s4 退款筛选口径 + 跨接缝标黄）须 team-lead 人工复核 + 跨接缝端到端测试 + codex review + `/check-vars` |
| 依赖 | 分支 **v3.0.10**（从 main 建）；版本 3.0.9 → **3.0.10**，**bump 由 Phase C 执行，本文档阶段不 bump**。本迭代 3 项需求，无并入 spec。 |

> **来源事实源（唯一 truth）**：
> 1. 本迭代已批准实施方案（plan）：v3.0.10 实施方案（Context、全部已锁定决策表、需求 1/2/3 的 file:line 级设计、D8 修订、逐策略标黄映射表、测试与验收），其产品层落地即本 PRD、实现侧 file:line 级事实源见 `docs/iterations/v3.0.10/TECHDOC.md`。
> 2. D8 草稿出处：`会话记录-2026-06-21-对账调研与环境故障.md` 附 D（草稿原文从未进任何 PRD；本迭代正式修订并落地，**不改会话记录原文**）。
>
> 本 PRD 是把 plan 落成产品需求规范文档，**不偏离 plan 的决策**；所有 scope / 资金红线口径 / 已锁定决策原样转述。实现侧 file:line 级事实源见 `docs/iterations/v3.0.10/TECHDOC.md`。

---

## 一、需求概述

v3.0.10 集中处理 **3 项**需求（无并入 spec），本质是**收紧对账引擎两处「取数」口径 + 优化退款回填输出文件可读性**：

1. **R4 资金性质校验加银行行借贷方向守卫** —— R4 命中网关 TradeType 后，再加一层「银行行借贷方向必须与该资金性质相符」守卫；方向录反则**不改写 + 进主错误报告 warning**。这正式修订 2026-06-21 的 D8 草案（详见 §六关键决策）。
2. **R5s4 退款回填加网关 reconid 前置过滤** —— 退款回填的银行候选行入池前，先与网关单做一次 `reconid` 匹配；命中网关的行**静默移出退款池**（这些行已能与网关对账，不该再走退款回填）。
3. **退款回填输出文件改造** —— 3.1：回填模板 sheet1 标黄「本行命中策略实际比对的字段」（交集标黄）提升可审性，并在银行段按模板列序补「Extra Information」「Drawee Name」两列（sheet1 由 31 → 33 列），让 S2/JPM-HK/S3 等命中这两列时也能标黄；3.2：未匹配报错 sheet2 删冗余列（结果类型/退款单号）、报错/提示并入信息列前缀、删 refund-only 噪声行（银行段同步补 2 列后 sheet2 为 13 列）。

---

## 二、背景与目标

### 2.1 背景

| 需求 | 为什么要做 | 用户 / 业务价值 | 当前问题（现状基线） |
|------|-----------|----------------|----------|
| 1 R4 方向守卫 | R4 资金性质校验目前**方向不敏感**——命中网关 TradeType 就改写银行 FundType，不看银行行借贷方向。 | 把「方向录反」的行（如出账性质但 Credit 有值）从「被误打成对应资金性质」变成「不改写 + 明确告警人工核对」，避免资金性质被错误覆盖。 | 命中后无方向守卫：方向录反的行也会被改写成命中的资金性质，错误被静默吞掉、无任何告警。 |
| 2 R5s4 网关前置过滤 | R5s4 退款回填目前只靠 `FundType=='Ach Return' && !isFundTypeChanged` 筛银行候选，不看该行是否已能与网关对账。 | 已能与网关对账（reconid 命中）的行不该再走退款回填；命中即静默移出，闭合已知的 no-op 缝隙，退款池更干净。 | 银行候选只过两道筛（资金性质 + 未被改写），未排除「已和网关匹配上」的行 → 这些行多走一遍退款回填属冗余/潜在误回填。 |
| 3.1 sheet1 标黄 | 退款回填 sheet1（回填模板）目前不标记「本行到底是凭哪些字段命中的」；且银行段只有 10 列、缺「Extra Information」「Drawee Name」——这两列正是 S2/JPM-HK/S3 等策略实际比对的银行字段。 | 审核人员可一眼看出每条回填命中的实际比对字段，提升可审性与可追溯性。 | sheet1 全表无标记，回填命中字段不可见，人工复核要回溯策略逻辑；且 S2/JPM-HK/S3 命中的 Extra Information/Drawee Name 不在 sheet1，命中也无处标黄（候选列被 buildBackfillRow 交集过滤丢弃）。 |
| 3.2 sheet2 改造 | 未匹配报错 sheet2 含冗余列（结果类型/退款单号），报错与提示混在一起难分辨，且含 refund-only 噪声行。 | 列更精简、报错/提示一眼可辨（前缀【报错】/【提示】）、去掉无对应银行行的 refund-only 噪声，报告更聚焦银行侧。 | sheet2 13 列含 2 列冗余；报错/提示无显式区分；refund-only 行（无对应银行行）混在报告里形成噪声。 |

### 2.2 目标（必做）

- **需求 1（R4 方向守卫）**：
  - 4 个 R4 子场景内置配置各加一行**方向守卫字段** `requireBankZeroField`（入账性质 Wire Return/HX-in 要求 `Debit Amount`=0；出账性质 Ach Return/HX-out 要求 `Credit Amount`=0）。
  - R4 引擎在**命中网关 TradeType 之后、改写 FundType 之前**插入方向守卫：应为 0 的金额列非 0 → **不改写该行 + push warning**；warning 进主错误报告文件（场景名「资金性质校验」），新增可读 cause 文案。
  - **一次性幂等迁移**（资金红线必需）：内置 seed「已存在则跳过」会让老库拿不到新字段、守卫静默失效 → 须新增专用迁移在每次启动幂等补回缺失的 `requireBankZeroField`，且**绝不覆盖用户已改的值**。
- **需求 2（R5s4 网关前置过滤）**：
  - 退款回填引擎拿到网关行集合，建一个网关 `reconciliationid` 集合；银行候选行在「资金性质 + 未被改写」两道筛之后，追加第 3 道筛——银行行 `ReconciliationId` 命中网关集合即**静默 drop**（不回填 / 不进 sheet2 / 不留痕）。
  - **不破审计不变量**：过滤发生在「入池前」，被 drop 的行根本没进 bankPool；退款引擎旁路，不进 modifiedRows/unmatchedRows 分区，行数守恒不受影响。
- **需求 3.1（sheet1 交集标黄 + 银行段补列）**：
  - 各匹配策略命中时诚实记录「候选比对列」，**单点收口过滤**到「既参与匹配、又在 sheet1 列」的交集字段；非空才在 sheet1 对应单元格标黄。零交集不标（不退标详情列）。
  - 银行段按模板序补「Extra Information」「Drawee Name」两列（10→12，sheet1 31→33），让 S2/JPM-HK/S3 命中这两列时也落入交集标黄；S4 命中按详情文案口径标 8 列（bank 日期/大账号/金额/币种 + ro 日期/大账号/金额/币种）。
- **需求 3.2（sheet2 改造）**：
  - 删「结果类型」「退款单号」两列；银行段随 `REFUND_BANK_COLUMNS` 10→12 → sheet2 最终 13 列（银行 12 + 信息 1）；报错/提示**并入信息列文案前缀** `【报错】`/`【提示】`（单点加在 `buildUnmatchedBankRow`）；删 refund-only 收尾行（**完全静默删除，不留后台痕迹**）。
- **收尾**：版本 bump 3.0.10 + 文档三件套（CHANGELOG / VERSION_FEATURE_HISTORY / USER_GUIDE，USER_GUIDE 零工程术语）+ `npm run scan:vars`（bump 前）+ `/check-vars`（提 PR / 合并前硬节点）+ `npm run release-check` 全绿。

### 2.3 明确不做（非目标）

- **不动 R3.5 / R5 的方向口径**：R3.5、R5（绝对值匹配那部分）**保持方向不敏感**（绝对值匹配不变）。本迭代方向守卫**只加在 R4**（详见 §六关键决策 D8 修订）。
- **不改 R4 的金额匹配口径**：方向守卫只是「命中后的一层闸门」，不改 R4 命中网关 TradeType 的既有判定逻辑（`gwTradeType` 匹配规则零改动）。
- **不覆盖用户已改的方向守卫配置值**：迁移只补回「缺失」的字段，用户手工改过的 `requireBankZeroField` 一律保留。
- **需求 2 不改匹配键以外的退款筛选逻辑**：只在 bankPool 第 3 道筛追加网关命中条件；资金性质筛、未被改写筛两道既有条件不动。
- **需求 3.1 零交集不退标详情列**：候选比对列全部不在 sheet1 时不标黄、也不额外往 sheet1 加列（plan 已锁定「交集标黄」口径）。
- **需求 3.2 不删 bank-only 提示行**：只删 refund-only 收尾行；银行侧 bank-only NOTICE 行保留（银行侧审计不变量不动）。
- **不改回传 IPC 契约 / 不动前端**：本迭代是后端对账引擎 + 输出文件改造，无新 IPC、不动 `renderer*.js`/`preload.js`、不重跑 preview。
- **不改 `refund-backfill-fields.js`**（仅被引用做 filter，无需改动）。

---

## 三、代码现状（必须有出处）

> 以下 file:line 为 plan 锁定的设计锚点（实现侧 file:line 级核实见 TECHDOC §代码现状；本章为产品层概览）。

| 主题 | 相关文件 | 当前行为 | 现状口径 |
|------|---------|---------|---------|
| R4 子场景内置配置 | `src/backend/database/migrations.js` `RECON_ROUND_BUILTIN_SCENARIOS`（4 个 R4 子场景 ach-return/wire-return/hx-out/hx-in，各含 `gwTradeType?`/`requireBankFundType?`/`setFundType`） | 4 子场景只描述「命中什么网关 TradeType → 改写成什么 FundType」，**无方向守卫字段** | 命中即改写，不看银行借贷方向 |
| R4 内置 seed 幂等 | `src/backend/database/migrations.js` `ensureReconRoundBuiltinScenariosSeed`（凭 subCategory 定位「已存在则跳过」+ 全局 marker 短路） | 老库已 seed 过 → 整体不再 seed | 🔴 仅靠 seed 加新字段，老库拿不到 `requireBankZeroField` → 守卫静默失效（须新增专用迁移补字段） |
| R4 引擎 | `src/main-process/scenario-engines/r4-fund-nature-check.js`（纯函数 `applyHandler(gwRow, bankRow, config)` + 主循环改写） | `applyHandler` 决定「命中→改写成哪个 FundType」；主循环执行改写、叠加链每 handler 各判各的 | `applyHandler` 不读金额列、无 warning 权；命中后直接改写，无方向闸门 |
| R5s4 退款候选筛选 | `src/main-process/scenario-engines/r5-refund-order-backfill.js` bankPool 构建 | 银行候选筛两道：`FundType==='Ach Return' && !isFundTypeChanged` | 不排除「已和网关 reconid 匹配上」的行 |
| 退款 writer sheet1 | `src/main-process/refund-backfill-writer.js`（`REFUND_TEMPLATE_HEADERS` + sheet1 写循环） | sheet1 逐行 `projectRow` 写入，**全表无标黄** | 无单元格级标记 |
| 退款 writer sheet2 | `src/main-process/refund-backfill-writer.js` `UNMATCHED_HEADERS` | 含「结果类型」+「退款单号」+ 银行列 + 报错/提示列（13 列），报错/提示不分前缀 | 列冗余、报错/提示混排 |
| 未匹配行构建 | `src/main-process/scenario-engines/r5-refund-order-backfill.js` `buildUnmatchedBankRow`（含 refund-only 收尾循环 2 段） | 构建未匹配 bank 形状行 + 产 refund-only 收尾行 | 报错/提示无前缀；refund-only 行进 sheet2 形成噪声 |
| warning 落盘链 | `r4.warnings` → 编排器 `allWarnings` → `errorReport` → `writeErrorReportOutput`（按 rowId enrich 出 ReconciliationId）→ `writeErrorReport` | 主错误报告 5 列 `时间戳\|场景名\|对账ID\|原因\|可能原因`，落 `error-reports/{YYYY-MM-DD}/{时间戳}-error-report.xlsx` | warning 全链路已验证可用，新增 warning code 即可复用 |
| cause 文案映射 | `src/backend/file-service/error-causes.js` `CAUSE_MAP` | code → 中文「可能原因」文案 | 新 warning code 须补一条文案 |

---

## 四、术语

| 术语 | 含义 |
|------|------|
| R4 资金性质校验 | 对账第 4 类规则：银行行命中网关 TradeType 后，把银行行 FundType 改写成对应资金性质（Ach Return / Wire Return / HX-out / HX-in 等）。退化为 4 子场景 |
| R4 子场景 | `ach-return` / `wire-return` / `hx-out` / `hx-in`，分别对应 `setFundType` = Ach Return / Wire Return / HX-out / HX-in |
| 方向守卫（requireBankZeroField） | 本迭代新增字段：命中资金性质后，规定银行行哪一金额列「应为 0」（`Debit Amount` 或 `Credit Amount`）；非 0 即方向不符、不改写 + warning |
| 入账性质 / 出账性质 | 入账性质 = Wire Return / HX-in（要求 `Debit Amount`=0）；出账性质 = Ach Return / HX-out（要求 `Credit Amount`=0） |
| 「应为 0」判定口径 | `(parseNumber(x) \|\| 0) === 0`；空 / garbage 当 0 = 满足、不拦截（与全仓口径一致） |
| 叠加链（R4） | 同一银行行可被多个 R4 handler 依次改写；某跳方向不符 → 停在上一跳值、不续改、push warn，其余跳各判各的 |
| no-op（R4） | 方向满足但 `oldValue==decision`（改写前后相等）→ 不 warn 不 record（既有语义不变） |
| R5s4 退款回填 | 对账退款链路：把网关退款单的字段回填到对应银行退款行 |
| 网关前置过滤（reconid） | 需求 2：银行候选行入池前，先与网关 `reconciliationid` 集合匹配；命中即静默移出退款池 |
| 静默移出 / 静默 drop | 命中网关的行不回填、不进 sheet2、不留任何后台痕迹 |
| sheet1（回填模板） | 退款回填输出第 1 个 sheet：命中并回填后的退款行模板（列 = `REFUND_TEMPLATE_HEADERS`） |
| sheet2（未匹配报错） | 退款回填输出第 2 个 sheet：未匹配 / 报错 / 提示的银行行清单 |
| 交集标黄 | 需求 3.1：只标「既参与匹配（候选比对列）、又在 sheet1 列」的字段；零交集不标、不退标详情列 |
| 候选比对列（_matchedColumns） | matcher 命中时诚实列出的实际比对字段数组（可含不在 sheet1 的字段，过滤后入 sheet1） |
| refund-only 行 | sheet2 里「只有退款单、无对应银行行」的收尾行（需求 3.2 完全静默删除） |
| bank-only NOTICE 行 | sheet2 里「只有银行行、无对应退款单」的提示行（保留，银行侧审计不变量不动） |
| 🔴 资金红线 | 本迭代改 R4 FundType 改写口径 + R5s4 退款筛选口径 + 跨接缝标黄；任一改错都可能让资金性质 / 退款回填出错，必须人工复核 + 端到端测试 + codex review |

---

## 五、功能详细描述

### 5.1 需求 1：R4 资金性质校验加银行行方向守卫

#### 5.1.1 说明

- **触发**：R4 引擎在主循环中，某银行行命中某网关 TradeType（`applyHandler` 返回非空 decision = 要改写成的资金性质）。
- **守卫**：读该子场景配置的 `requireBankZeroField`（`Debit Amount` / `Credit Amount` / 未配置）：
  - 未配置 → 维持原行为（命中即改写），不引入方向闸门。
  - 配置了 → 检查银行行对应金额列：`(parseNumber(bankRow[zf]) || 0) === 0` 为「满足」；非 0 为「方向不符」。
- **方向不符的处置**：**不改写该行 FundType + push 一条 warning**（warning 进主错误报告文件），跳过本跳改写。
- **方向满足**：执行原有改写逻辑（零改动）。
- **4 子场景方向映射**（逐字对齐需求原文）：

| 子场景 subCategory | setFundType（资金性质） | 性质 | 方向守卫 requireBankZeroField | 守卫语义 |
|---|---|---|---|---|
| `wire-return` | Wire Return | 入账性质 | `Debit Amount`（应为 0） | Debit 非 0 → 方向不符，不改写 + warn |
| `hx-in` | HX-in | 入账性质 | `Debit Amount`（应为 0） | Debit 非 0 → 方向不符，不改写 + warn |
| `ach-return` | Ach Return | 出账性质 | `Credit Amount`（应为 0） | Credit 非 0 → 方向不符，不改写 + warn |
| `hx-out` | HX-out | 出账性质 | `Credit Amount`（应为 0） | Credit 非 0 → 方向不符，不改写 + warn |

> **规律**：入账性质（Wire Return / HX-in）要求 `Debit Amount`=0；出账性质（Ach Return / HX-out）要求 `Credit Amount`=0。

#### 5.1.2 影响范围

- **改既有文件**：
  - `src/backend/database/migrations.js` — 4 子场景内置 seed 各加 `requireBankZeroField` + 新增专用幂等迁移 `ensureR4DirectionGuardConfigMigration` + 导出。
  - `src/backend/database.js` — require + 薄壳方法 + 在内置 seed 之后调用迁移。
  - `src/main-process/scenario-engines/r4-fund-nature-check.js` — 主循环加方向守卫 + import `parseNumber`。
  - `src/backend/file-service/error-causes.js` — `CAUSE_MAP` 加新 warning code 文案。
- **不改**：`applyHandler` 纯函数（守卫不放纯函数，职责分离——applyHandler 无 warning 权、且无法区分「网关没匹配」vs「匹配了但方向不符」，只有后者才 warn）。
- **数据 / 迁移影响**：DB config_json 内 4 子场景各补一字段；**无 marker、每次启动幂等补回缺失字段、绝不覆盖用户改值**。
- **对外接口影响**：无 IPC 变更。warning 走既有主错误报告文件链路（新增一类 warning 行）。

#### 5.1.3 交互与规则（权威细则）

**A. 「应为 0」判定**：`(parseNumber(x) || 0) === 0`。空 / garbage（无法解析为数字）当 0 = 满足、不拦截（与全仓口径一致）。

**B. 守卫落位**：放 R4 引擎**主循环内层**（命中 decision 之后、改写之前）；**不放纯函数 `applyHandler`**：
- `applyHandler` 返回 null（网关 TradeType 没匹配）→ 静默 `continue`，**不 warn**。
- `applyHandler` 返回非空 decision（命中）→ 读 `requireBankZeroField` 守卫：方向不符 → push warning + `continue`（不改写）；方向满足 → 走原有改写。

**C. 叠加链行为**：某跳方向不符 → 停在上一跳值、不续改、push warn；其余跳各判各的（叠加链下每 handler 独立判定）。

**D. no-op 交互**：方向满足但 `oldValue==decision`（改写前后相等）→ 不 warn 不 record（既有语义不变，不因引入守卫而改变 no-op 语义）。

**E. warning 落盘**：
- warning 经 `r4.warnings` → 编排器 `allWarnings` → `errorReport` → `writeErrorReportOutput`（按 rowId enrich 出 ReconciliationId）→ `writeErrorReport`。
- **落位**：`Documents/网银账单生成小助手/error-reports/{YYYY-MM-DD}/{时间戳}-error-report.xlsx`，5 列 `时间戳 | 场景名 | 对账ID | 原因 | 可能原因`，场景名 = 「资金性质校验」。
- **新增 cause 文案**（`error-causes.js` `CAUSE_MAP`）：
  - code：`r4-fund-direction-mismatch`
  - 文案：`资金性质命中但银行行借贷方向不符（应为0的金额列非0），已跳过该行资金性质改写，请人工核对方向`

**F. 一次性幂等迁移（资金红线必需）**：
- 新增 `ensureR4DirectionGuardConfigMigration(db)`，范式照搬现有 `ensureFundTypeAchReturnConfigMigration`：
  - 对 4 个 subCategory 各按 config_json 定位 → `JSON.parse`；
  - **若 `requireBankZeroField` 已存在则跳过（不覆盖用户改值）**，否则补对应值 → 回写；
  - 事务包裹；表不存在 → no-op；幂等（二次跑 updated=0）。
- 注册：`database.js` require + 薄壳方法 + 调用插在内置 seed（及 charge 退役清理）之后；`migrations.js` 导出。

#### 5.1.4 状态流转（R4 单行命中 → 守卫 → 处置）

```
银行行 bankRow ──(主循环)──> applyHandler(gwRow, bankRow, config)
        │
        ├── decision == null（网关 TradeType 没匹配）──> 静默 continue（不 warn）
        │
        └── decision 非空（命中资金性质 X）
                │
                └── 读 config.requireBankZeroField (zf)
                        │
                        ├── zf 未配置 ──> 执行原有改写（命中即改）
                        │
                        ├── (parseNumber(bankRow[zf])||0) === 0（方向满足）
                        │       ├── oldValue == X（no-op）──> 不改不 warn 不 record
                        │       └── oldValue != X ──────────> 改写 FundType = X
                        │
                        └── (parseNumber(bankRow[zf])||0) !== 0（方向不符）
                                └── 不改写 + push warning(r4-fund-direction-mismatch) + continue
```

---

### 5.2 需求 2：R5s4 退款回填加网关 reconid 前置过滤

#### 5.2.1 说明

- **触发**：R5s4 退款回填构建银行候选池（bankPool）时。
- **匹配键**：**全新 reconid 集合命中** —— 网关侧 `reconciliationid`（小写）建集合；银行侧 `ReconciliationId`（驼峰）取值；银行行 `ReconciliationId` ∈ 网关集合 → 命中。
- **命中后处置**：**静默移出退款池**（不回填 / 不进 sheet2 / 不留痕）。
- **筛选顺序**：在既有两道筛（`FundType==='Ach Return' && !isFundTypeChanged`）之后，追加第 3 道筛——银行行 reconid 命中网关集合即 drop。
- **空键不参与**：银行行 reconid 为空 → 不参与命中判定（空 ∉ 任何集合），照常入池。
- **大小写敏感**：网关侧小写字段 + 银行侧驼峰字段，集合命中按归一化后的值精确比对（大小写敏感，见 §六关键决策与 TECHDOC）。

#### 5.2.2 影响范围

- **改既有文件**：
  - `src/main-process/reconciliation-orchestrator.js` — R5s4 调用处把网关行集合（`gwRows`）传入退款引擎。
  - `src/main-process/scenario-engines/r5-refund-order-backfill.js` — 建网关 reconid 集合 + bankPool 第 3 道筛 + 文件头注释补「网关前置过滤」。
- **审计不变量**：过滤发生在「入池前」，被 drop 的行根本没进 bankPool，与「FundType≠Ach Return 不进池」同级；退款引擎旁路，不进 modifiedRows/unmatchedRows 分区，**行数守恒不受影响**。
- **对外接口影响**：无 IPC 变更；退款回填输出文件中，命中网关的行不再出现（静默）。

#### 5.2.3 交互与规则（权威细则）

| 规则点 | 规则 |
|---|---|
| 匹配键 | 银行 `ReconciliationId` ∈ 网关 `reconciliationid` 集合 |
| 命中处置 | 静默 drop（不回填 / 不进 sheet2 / 不留痕） |
| 筛选位置 | bankPool 第 3 道筛，在 `FundType==='Ach Return' && !isFundTypeChanged` 之后 |
| 空键 | 银行 reconid 为空 → 不参与命中、照常入池 |
| 网关集合缺省 | 未传网关行 / 网关无 reconid → 集合为空 → 第 3 道筛恒不命中 → 退化为原行为（向后兼容） |
| 审计不变量 | 入池前过滤，行数守恒不受影响；不变量不破 |

---

### 5.3 需求 3.1：回填 sheet1 标黄命中字段（交集标黄）

#### 5.3.1 说明

- **目的**：让审核人员在 sheet1 一眼看出每条回填命中的**实际比对字段**。
- **标黄口径（交集标黄）**：各匹配策略命中时，诚实记录「候选比对列」`_matchedColumns`（可含不在 sheet1 的字段）；**单点收口过滤**到「既参与匹配、又在 sheet1 列（`REFUND_TEMPLATE_HEADERS`）」的交集字段；交集非空才在 sheet1 对应单元格标黄。**零交集不标、不退标详情列**。
- **银行段补 2 列（sheet1 31 → 33 列）**：在银行段按 `BANK_STATEMENT_FIELDS` 模板列序补「Extra Information」「Drawee Name」两列——这两列正是 S2-MTX / JPM-HK / S2b / S3b / S3c（提取源 Extra Information）与 S3（被查字段 Drawee Name）实际比对的银行字段。补进 sheet1 后，这些策略命中时对应列**自然落入交集 → 命中即标黄**（此前候选列含这两列，但因不在 sheet1 被交集过滤丢弃，命中也无处标）。
  - **列序锚**（`BANK_STATEMENT_FIELDS` 下标）：CustomerRef=idx13 → Extra Information=idx18 → Payment Detail=idx19 → Drawee Name=idx22；故银行段新序为 `Extra Information` 插在 `CustomerRef` 后、`Payment Detail` 前，`Drawee Name` 接在 `Payment Detail` 后（银行段末位，第 12 列）。
  - **不改 matcher 候选逻辑**：各 matcher 早已把 Extra Information / Drawee Name 进 `_matchedColumns` 候选；本次仅靠「把列加进 sheet1」让交集过滤自然保留它们，matcher 端零改动。
- **单行单策略**：命中即停 → 单行只来自单一策略，无需合并多策略列集。
- **标黄样式**：黄色填充（与既有 exceljs-writer 黄色填充同字面常量，单一真相）。

#### 5.3.2 逐策略候选比对列 → sheet1 实际标黄列（产品层映射）

> ★ = 候选比对列不在 sheet1（过滤后丢弃，不标黄）。每命中至少标到一个「RO 侧锚点列 ∈ sheet1」，不会零交集。
> 银行段补「Extra Information」「Drawee Name」两列后（§5.3.1），这两列已 ∈ sheet1，命中即标黄（下表已去掉它们的 ★）。

| 策略 | 候选比对列（★=不在 sheet1） | sheet1 实际标黄列 |
|---|---|---|
| S1 | 命中的 ChannelOrderNo 或 CustomerRef + 银行打款流水号 | 两者 |
| S2-MTX | Extra Information + 附言 | Extra Information + 附言（两列） |
| S2 JPM-HK | 命中的 Payment Detail / Extra Information + 银行打款流水号 | 银行打款流水号 + 命中的 Payment Detail / Extra Information |
| S2 JPM-US / R3 二跳 | CustomerRef + 入金 CustomerRef★ | CustomerRef |
| S2b | 命中的 memoField（Payment Detail / Extra Information）+ 入金 CustomerRef★ | 命中的 memoField（Payment Detail / Extra Information 均 ∈ sheet1） |
| S3 | Drawee Name / 卡号★ + 命中位 付款人名称 / 付款卡号 / 虚拟卡号 | 命中位 RO 列 +（命中位为付款人名称时）Drawee Name |
| S3b | Drawee Name（门）+ memoField（Payment Detail / Extra Information）+ 入金 ValueDate★ | Drawee Name + 命中的 memoField |
| S3c | memoField（Payment Detail / Extra Information）+ 入金 ValueDate★ / Credit Amount★ / Currency★ | 命中的 memoField |
| S4 | 文案口径「退款提交日期+大账号+金额+币种」展开为 8 列（bank 4 + ro 4，全 ∈ sheet1） | BillDate + MerchantId + Debit Amount + Currency（bank 侧）；valueDate + 银行大账号 + 退款金额 + 币种（ro 侧）|

> **S4 标黄 8 列**：S4 命中详情是固定文案「命中唯一值:退款提交日期+大账号+金额+币种」，标黄按该文案口径展开为两侧各 4 列——bank 侧 `BillDate`（退款提交日期/日期比对列）+ `MerchantId`（大账号）+ `Debit Amount`（金额展示列）+ `Currency`（币种）；ro 侧 `valueDate`（实际日期比对列，文案口径「退款提交日期」）+ `银行大账号` + `退款金额` + `币种`。⚠️ 资金红线：S4「金额」实际匹配口径是 `|Credit Amount − Debit Amount|` 绝对值（唯一值分组），`Debit Amount` 列仅作 sheet1 银行金额**展示列**标黄（银行段只放 Debit Amount、无 Credit Amount）。

#### 5.3.3 影响范围

- **改既有文件**：
  - `src/constants/refund-backfill-fields.js` — `REFUND_BANK_COLUMNS` 10 → 12 列（按模板序插 `Extra Information` + `Drawee Name`）；`REFUND_TEMPLATE_HEADERS` 随之 31 → 33；两列均 ∈ `BANK_STATEMENT_FIELDS`，启动期断言①自动通过。
  - `src/main-process/scenario-engines/r5-refund-order-backfill.js` — 各 matcher 产 hit 时附候选 `_matchedColumns`（候选逻辑不动）；回填透传；`buildBackfillRow` 末位参收口过滤（仅保留 ∈ sheet1 的列），非空才挂 `row._matchedColumns`；S4 命中 `_matchedColumns` 由 `[BillDate, valueDate]` 扩为按文案口径的 8 列（全 ∈ sheet1）。
  - `src/main-process/refund-backfill-writer.js` — 顶部就地定义黄色填充常量（注释指向单一真相）；sheet1 写循环按 `_matchedColumns` 给命中列标黄（列偏移对齐退款 sheet1 无前导列）；sheet1 表头随常量自动 33 列、sheet2 `UNMATCHED_HEADERS` 随 `REFUND_BANK_COLUMNS` 自动 13 列。
- **不改**：编排器 / `main.js`（export 浅拷贝 `{...r}` 自动保 `_` 前缀字段）；各 matcher 候选列逻辑（靠列加入 sheet1 自动生效）。
- **对外接口影响**：sheet1 银行段新增 2 列（命中即标黄）；sheet1 由 31 → 33 列、sheet2 由 11 → 13 列（银行段同步补 2 列，详见 §5.4）。

---

### 5.4 需求 3.2：未匹配报错 sheet2 改造

#### 5.4.1 说明

- **删两列**：sheet2 删「结果类型」（原 A 列）+「退款单号」（原 B 列）——`UNMATCHED_HEADERS = [...REFUND_BANK_COLUMNS, '报错/提示信息']`，不含这两列。
- **银行段同步补 2 列**：sheet2 银行段随 `REFUND_BANK_COLUMNS` 10 → 12（含 Extra Information / Drawee Name，见 §5.3），故最终 sheet2 = **13 列**（银行 12 列 + 报错/提示信息列 1）。注意此 13 列与改造前的 13 列**构成不同**：改造前 = 结果类型 + 退款单号 + 银行 10 + 信息 1；改造后 = 银行 12 + 信息 1。
- **报错 / 提示并入前缀**：报错与提示文案合并进「报错/提示信息」列，按类型加前缀 `【报错】` / `【提示】`（**单点加在 `buildUnmatchedBankRow`**）；走该函数的 bank 形状行自动带前缀。
- **删 refund-only 行**：删 sheet2 里「只有退款单、无对应银行行」的 refund-only 收尾行（**完全静默删除，不留后台痕迹**）。
- **保留 bank-only NOTICE**：银行侧 bank-only 提示行保留（银行侧审计不变量不动）。
- **审计不变量收窄**：refund-only 不再产 notice 行，不变量收窄为「银行侧全覆盖」。

#### 5.4.2 sheet2 列对比（13 → 13，构成变化）

| | 改造前（13 列）| 删冗余列后（11 列）| 银行段补 2 列后（13 列，最终）|
|---|---|---|---|
| A | 结果类型 | ❌ 删除 | ❌ 删除 |
| B | 退款单号 | ❌ 删除 | ❌ 删除 |
| 银行列 | 10 列银行字段 | 10 列银行字段（保留）| **12 列**银行字段（补 Extra Information / Drawee Name，见 §5.3）|
| 末列 | 报错/提示信息（无前缀）| 报错/提示信息（前缀【报错】/【提示】）| 报错/提示信息（前缀【报错】/【提示】）|

> sheet2 列结构始终随 `REFUND_BANK_COLUMNS` 自动传播（`UNMATCHED_HEADERS = [...REFUND_BANK_COLUMNS, '报错/提示信息']`），无硬编码列数；银行段 10→12 后，sheet2 自然由 11 → 13。

#### 5.4.3 影响范围

- **改既有文件**：
  - `src/main-process/refund-backfill-writer.js` — `UNMATCHED_HEADERS` 删「结果类型」「退款单号」两列、随 `REFUND_BANK_COLUMNS` 自动为 13 列（银行 12 + 信息 1）；文件头注释同步。
  - `src/main-process/scenario-engines/r5-refund-order-backfill.js` — `buildUnmatchedBankRow` 加前缀（**保留 row 上的 `结果类型` key 供引擎内部测试 filter，仅不进 sheet2 投影**）；删 refund-only 两段收尾循环；审计不变量注释收窄。
- **对外接口影响**：无 IPC 变更；sheet2 文件列结构变化（用户可见输出改造）。

---

## 六、关键决策

> 本章是本迭代资金红线口径的权威记录，逐条与 plan「已锁定决策」表对齐。

### 6.1 【修订后的 D8】R4 方向敏感、R3.5/R5 方向不敏感

> **修订自**：2026-06-21 会话记录（`会话记录-2026-06-21-对账调研与环境故障.md`）附 D 的 **D8 草稿**。
> **D8 草稿原文**（仅在会话记录里、从未进任何 PRD）将 **R3.5/R4/R5 一律按金额绝对值匹配、方向由对手方裁决、全流程不设 FundType↔借贷方向一致性校验**。
> **本迭代正式修订并落地**（**不改会话记录原文**，仅在本 PRD 记录修订后的口径）：

| 规则 | 方向敏感性 | 口径 |
|---|---|---|
| R3.5 | **方向不敏感**（不变） | 绝对值匹配 `\|Credit−Debit\|` + 大账号 + 币种；方向由对手方裁决；不设借贷方向一致性校验 |
| R5（绝对值匹配部分） | **方向不敏感**（不变） | 同上，绝对值匹配不变 |
| R4（资金性质校验） | **方向敏感（本迭代新增）** | 命中网关 TradeType 后，加银行行借贷方向守卫（入账性质要 Debit=0、出账性质要 Credit=0）；方向不符 → **不改写 + warn 进主错误报告**（不报错拦截整体导出，仅跳过该行改写） |

**修订理由**：R4 是「改写资金性质」的写操作，命中后若方向录反、仍照改，会把错误方向「洗白」成对应资金性质且无告警；加方向守卫把这类行从「静默误改」变为「不改 + 明确告警人工核对」。R3.5/R5 是绝对值匹配/标记，方向交由对手方裁决，维持不敏感。

### 6.2 其余已锁定决策（资金红线口径）

| # | 决策点 | 结论 |
|---|---|---|
| 需求 1 失败行 | 方向不满足怎么办 | **不改写 + 记 warning**（warning 进主错误报告文件） |
| 需求 1 口径 | 「应为 0」判定 | `(parseNumber(x) \|\| 0) === 0`；空 / garbage 当 0 = 满足、不拦截（与全仓口径一致） |
| 需求 1 迁移 | 老库补字段 | **无 marker、每次启动幂等补回缺失的 `requireBankZeroField`**；**绝不覆盖**用户已改的值 |
| 需求 2 匹配键 | 银行↔网关 | **全新 reconid 集合命中**（银行 `ReconciliationId` ∈ 网关 `reconciliationid` 集合） |
| 需求 2 命中后 | 移出方式 | **静默移出**（不回填 / 不进 sheet2 / 不留痕） |
| 需求 3.1 标黄 | 不在 sheet1 的比对字段 | **交集标黄**：只标「既参与匹配、又在 sheet1 列」的字段；零交集不标（不退标详情列） |
| 需求 3.1 银行段补列 | sheet1 列扩展 | 银行段按模板序补 `Extra Information` + `Drawee Name`（10→12）→ sheet1 31→33；让 S2/JPM-HK/S3 命中这两列时也标黄（不改 matcher 候选逻辑） |
| 需求 3.1 S4 | 标黄范围 | 按命中详情文案口径标 8 列：bank 侧 `BillDate`+`MerchantId`+`Debit Amount`+`Currency`、ro 侧 `valueDate`+`银行大账号`+`退款金额`+`币种`（金额实际匹配口径为 `\|Credit−Debit\|`，`Debit Amount` 仅作展示列标黄）|
| 需求 3.2 列 | 删列 + 银行段补列 | 删「结果类型」+「退款单号」、银行段随 `REFUND_BANK_COLUMNS` 10→12 → sheet2 最终 13 列（银行 12 + 信息 1）|
| 需求 3.2 区分 | 报错 / 提示 | 并入「报错/提示信息」文案前缀 `【报错】` / `【提示】`（单点加在 `buildUnmatchedBankRow`） |
| 需求 3.2 refund-only | 删除方式 | **完全静默删除，不留后台痕迹** |
| 黄色填充常量 | 来源 | 退款 writer 就地定义同字面常量 + 注释指向 exceljs-writer 单一真相 |

---

## 七、验收标准

> 本章节共 **10 条** AC（对应 plan 的 Verification；v3.0.10 退款输出细化追加 AC3-1b/AC3-1c）。

### 7.1 需求 1：R4 方向守卫 AC

| AC 编号 | 验收条件 |
|---------|---------|
| AC1-1 | 4 子场景方向映射正确：Wire Return / HX-in 要求 `Debit Amount`=0；Ach Return / HX-out 要求 `Credit Amount`=0。命中且方向满足 → 正常改写；命中但应为 0 的金额列非 0 → **不改写 + 主错误报告新增 `r4-fund-direction-mismatch` 行**（场景名「资金性质校验」、5 列含对账 ID 与可读「可能原因」文案） |
| AC1-2 | 边界口径正确：空 / garbage / 0 / 双零当满足（不拦截）；负数等非 0 当方向不符（不改写 + warn）。叠加链中途某跳方向不符 → 停在上一跳值、其余跳各判各的；no-op（oldValue==decision）不 warn 不 record |
| AC1-3 | 🔴 **迁移幂等且不覆盖用户值**：老库每次启动幂等补回缺失的 `requireBankZeroField`；二次跑 updated=0；用户手工改过的值一律保留；表不存在 → no-op、不误伤其它场景 |
| AC1-4 | 职责分离：`applyHandler` 纯函数不读金额列、无 warning 权（守卫只在主循环）；`applyHandler` 返回 null（网关没匹配）静默不 warn，仅「命中但方向不符」才 warn |

### 7.2 需求 2：R5s4 网关前置过滤 AC

| AC 编号 | 验收条件 |
|---------|---------|
| AC2-1 | 银行候选行 `ReconciliationId` 命中网关 `reconciliationid` 集合 → **静默移出退款池**（不回填 / 不进 sheet2 / 不留痕）；空键不参与命中、照常入池；网关集合缺省时退化为原行为 |
| AC2-2 | 🔴 **审计不变量不破**：过滤发生在入池前，行数守恒不受影响；被 drop 行不进 modifiedRows/unmatchedRows 分区；被 drop 后某三元组只剩 refund 等组合行为正确 |

### 7.3 需求 3：退款输出改造 AC

| AC 编号 | 验收条件 |
|---------|---------|
| AC3-1 | 🔴 **跨接缝标黄端到端正确**：引擎产 backfillRows（带 `_matchedColumns`）→ export 浅拷贝 `{...r}` 存活 → writer 在 sheet1 对命中列标黄。逐策略命中标到正确 sheet1 列（交集标黄、零交集不标、`_matchedColumns` 为空无黄）；标黄填充与 exceljs-writer 同字面常量（argb 黄色） |
| AC3-1b | **sheet1 银行段含 12 列**：sheet1 = 33 列（固定 6 + 银行 12 + 中台 15）；银行段按模板序含 `Extra Information`（CustomerRef 后）、`Drawee Name`（Payment Detail 后、银行段末位）；S2-MTX/JPM-HK/S2b/S3b/S3c 命中 Extra Information 或 S3 命中 Drawee Name 时该列标黄 |
| AC3-1c | **S4 标黄 8 列**：S4 命中行标黄 bank 侧 `BillDate`+`MerchantId`+`Debit Amount`+`Currency`、ro 侧 `valueDate`+`银行大账号`+`退款金额`+`币种`（金额实际匹配口径为 `\|Credit−Debit\|`，`Debit Amount` 仅作展示列标黄）|
| AC3-2 | sheet2 改造正确：**13 列**（银行 12 + 报错/提示信息 1，已删「结果类型」「退款单号」、银行段随 `REFUND_BANK_COLUMNS` 补 Extra Information/Drawee Name）；走 `buildUnmatchedBankRow` 的行「报错/提示信息」带 `【报错】` / `【提示】` 前缀；**无 refund-only 行**（完全静默删除）；bank-only NOTICE 行保留 |

### 7.4 总质量门 AC

| AC 编号 | 验收条件 |
|---------|---------|
| AC4-1 | `npm run test:unit` 全绿（预计净增 ~50-65 用例）；`npm run release-check`（unit + integration + smoke）PASS |
| AC4-2 | `/check-vars` 无遗漏（命中 FundType 改写口径 + Ach Return 筛选条件等重要变量，PR body 追加 review 段） |

---

## 八、手动测试清单

### 8.1 P0 必测场景（资金红线，必须人工端到端）

| 场景 | 输入 | 前置条件 | 预期结果 |
|------|------|----------|---------|
| R4 方向录反行 | 导入含「方向录反的 Wire Return 行」（命中 Wire Return 但 Debit Amount 非 0） | 走 R4 资金性质校验 | (a) 录反行 FundType **未改** + 主错误报告有 `r4-fund-direction-mismatch` 行（对账 ID + 可读「可能原因」） |
| R5s4 网关已匹配行 | 导入含「网关已匹配的 Ach Return 行」（银行 reconid ∈ 网关 reconid 集合） | 走 R5s4 退款回填 | (b) 网关命中行**未进退款文件**（sheet1/sheet2 均无该行、无痕迹） |
| 退款 sheet1 标黄 | 导入各策略命中的退款行（含 S2-MTX / JPM-HK / S3 / S4） | 走 R5s4 退款回填并导出 | (c) 退款 sheet1 命中字段标黄正确（逐策略对应 §5.3.2 实际标黄列、交集标黄、零交集不标）；银行段含 Extra Information / Drawee Name 两列、命中即标黄；S4 命中行标黄 8 列（日期/大账号/金额/币种两侧）；sheet1 = 33 列 |
| 退款 sheet2 改造 | 同上（含报错 / 提示 / refund-only 组合） | 同上 | (d) sheet2 **13 列**（银行 12 + 信息 1，已删结果类型/退款单号）、带【报错】/【提示】前缀、**无 refund-only 行** |

### 8.2 P1 应测场景

| 场景 | 输入 | 前置条件 | 预期结果 |
|------|------|----------|---------|
| R4 叠加链中途不符 | 银行行被多个 R4 handler 叠加改写，中途某跳方向不符 | — | 停在上一跳值、不续改、push warn；其余跳各判各的 |
| R4 边界口径 | 应为 0 的列分别为空 / garbage / 0 / 负数 / 正数 | — | 空 / garbage / 0 满足（改写或 no-op）；负数 / 正数方向不符（不改 + warn） |
| 迁移老库 | 拿一个老库（已 seed 过 R4 子场景、无 `requireBankZeroField`） | 启动 | 4 子场景补回正确字段；用户手工改过的值不被覆盖；二次启动 updated=0 |
| R5s4 空键 / 缺省 | 银行 reconid 为空；或不传网关行 | — | 空键照常入池；网关集合缺省退化为原行为（不误 drop） |
| R5s4 大小写 | 银行 reconid 与网关 reconid 仅大小写不同 | — | 按归一化后精确比对（大小写敏感，不误命中） |

### 8.3 不测项与原因

- 前端 UI：本迭代不动前端、无 IPC 变更，不重跑 preview、不测视觉。
- R3.5 / R5 绝对值匹配口径：本迭代不改其方向口径（仍方向不敏感），无回归点，不专项手测。

---

## 九、数据 / 状态 / 安全影响

| 类别 | 说明 |
|------|------|
| 数据结构变更 | DB config_json 内 4 个 R4 子场景各补一字段 `requireBankZeroField`（`Debit Amount` / `Credit Amount`）；**无新表 / 无新列定义 / 仅 JSON 字段补写**。退款回填输出文件：sheet1 银行段补 `Extra Information` + `Drawee Name` 两列（31→33 列）+ 命中单元格加黄色填充；sheet2 删「结果类型/退款单号」两列、银行段随 `REFUND_BANK_COLUMNS` 补 2 列 → 最终 13 列（银行 12 + 信息 1）。 |
| 状态流转变更 | R4 单行命中后新增「方向守卫」分支（满足→改写 / 不符→不改+warn / no-op→不动）；R5s4 bankPool 新增第 3 道筛（网关命中静默 drop）。无 IPC 通道新增。 |
| 迁移影响 | `ensureR4DirectionGuardConfigMigration` 每次启动幂等运行：补回缺失字段、不覆盖用户改值、事务包裹、表不存在 no-op、二次跑 updated=0。**无 marker**（与依赖 marker 短路的 seed 不同）。 |
| 🔴 资金红线 | 本迭代改 **R4 FundType 改写口径**（命中后加方向守卫）+ **R5s4 退款筛选口径**（网关前置过滤）+ **跨接缝标黄**（引擎记列→浅拷贝→writer 标黄）。任一改错都可能让资金性质 / 退款回填出错。须 team-lead 人工复核 + 跨接缝端到端测试 + codex review + `/check-vars`（命中 FundType 改写口径 + Ach Return 筛选条件等重要变量，PR body 追加 review 段）。 |
| 审计不变量 | 需求 2 过滤在入池前、行数守恒不破；需求 3.2 refund-only 不再产 notice 行，不变量**收窄为「银行侧全覆盖」**（bank-only NOTICE 保留）。 |
| 权限 / 安全 | 无鉴权变更。warning 仅写主错误报告文件；迁移仅改本地 SQLite config_json。 |
| 回滚策略 | 需求 1：revert R4 引擎守卫 + 迁移注册（DB 多出的字段无害、引擎不读即失效）。需求 2：revert bankPool 第 3 道筛 + 编排器传参。需求 3：revert writer 标黄 / 表头 + 引擎 `_matchedColumns` / 前缀 / refund-only 删除。无破坏性 schema 变更需回退。 |

---

## 十、非功能性要求

| 类别 | 要求 |
|------|------|
| 向下兼容 | 迁移幂等不覆盖用户值；网关集合缺省时 R5s4 退化为原行为；R4 未配置 `requireBankZeroField` 的场景维持命中即改（无方向闸门）；R3.5 / R5 方向口径不变。 |
| 正确性（资金红线） | R4 方向守卫 4 子场景映射逐字对齐；「应为 0」判定与全仓口径一致；reconid 集合命中大小写敏感、空键不参与；交集标黄口径精确（零交集不标）；sheet2 前缀 / 列数 / refund-only 删除精确。 |
| 鲁棒性 | 迁移事务包裹 + 表不存在 no-op + 二次跑 updated=0；守卫 garbage/空安全（不误拦截）；跨接缝 `_matchedColumns` 非空才挂、收口过滤单点；浅拷贝自动保 `_` 字段。 |
| 可审计性 | R4 方向不符进主错误报告（可读 cause 文案）；退款 sheet1 命中字段标黄（一眼可审）；sheet2 报错/提示前缀化（一眼可辨）。 |

---

## 十一、🔴 资金红线提醒

> 本迭代触动 3 处资金敏感口径，按项目硬约定与历史经验（多 agent 拆活跨接缝最易出致命 bug）显式高亮人工复核：

1. **R4 FundType 改写口径变更**：命中网关 TradeType 后新增银行行借贷方向守卫；方向不符不改写 + warn。改错会让「资金性质改写」要么漏改（守卫误拦正确行）、要么误改（守卫失效）。**迁移须保证老库幂等补字段且绝不覆盖用户值**——否则守卫静默失效。
2. **R5s4 退款筛选口径变更**：bankPool 新增网关 reconid 前置过滤；命中静默 drop。改错会让本该回填的退款行被误 drop、或本不该回填的行漏过。**须保证空键不参与、网关缺省退化、审计不变量不破**。
3. **需求 3.1 跨接缝标黄**（引擎记 `_matchedColumns` → export 浅拷贝 `{...r}` → writer 标黄）：按经验**跨接缝最易出致命 bug**（逐文件 review 看不见接缝）。实现后**必须补端到端测试（引擎产行 → 浅拷贝 → writer 读回断言标黄）+ codex review 兜底**。

**质量门（缺一不可）**：team-lead 审 diff + `npm run release-check` 全绿 + 跨接缝端到端测试 + codex review + `/check-vars`（命中 FundType 改写口径 + Ach Return 筛选条件等重要变量，PR body 追加关联功能 review 段）。

---

## 十二、待澄清问题

- [ ] 无（plan 已逐条锁定全部资金红线口径；4 子场景方向映射、判定口径、迁移策略、匹配键、标黄口径、sheet2 列与前缀、refund-only 删除均已定稿）。

---

## 十三、变更记录

| 日期 | 变更内容 |
|------|---------|
| 2026-06-21 | 初稿：依据本迭代已批准实施方案（plan）撰写 v3.0.10 PRD，覆盖 3 项需求——R4 方向守卫（4 子场景方向映射 + 不改写+warn + 幂等迁移）、R5s4 网关 reconid 前置过滤（静默移出）、退款回填输出改造（sheet1 交集标黄 + sheet2 删列/前缀/删 refund-only）。**关键决策章记录修订后的 D8**（R4 方向敏感新增；R3.5/R5 方向不敏感不变；修订自 2026-06-21 会话记录附 D 的 D8 草稿，不改会话记录原文）。8 条 AC、P0/P1 手动测试清单、🔴 资金红线提醒段齐备。 |
| 2026-06-21 | 退款回填输出细化（代码已最终，本次同步文档）：①需求 3.1 sheet1 银行段按 `BANK_STATEMENT_FIELDS` 模板序补「Extra Information」（CustomerRef 后）+「Drawee Name」（Payment Detail 后、银行段末位）两列——sheet1 31→33、sheet2 11→13（银行 12 + 信息 1），让 S2-MTX/JPM-HK/S2b/S3b/S3c 命中 Extra Information、S3 命中 Drawee Name 时也标黄（不改 matcher 候选逻辑，靠列加入 sheet1 自动生效）；②需求 3.1 S4 标黄由 `BillDate`+`valueDate` 两列扩为按命中详情文案「退款提交日期+大账号+金额+币种」展开的 8 列（bank `BillDate`/`MerchantId`/`Debit Amount`/`Currency` + ro `valueDate`/`银行大账号`/`退款金额`/`币种`；金额实际匹配口径 `\|Credit−Debit\|`、`Debit Amount` 仅展示列）。同步 §一/§三/§5.3/§5.4/§六/§七（追加 AC3-1b/AC3-1c）/§九；AC 8→10。 |

---

## 十四、实施记录

> 由 PR merged + 归档后自动追加，PM 不需要手动填写。
