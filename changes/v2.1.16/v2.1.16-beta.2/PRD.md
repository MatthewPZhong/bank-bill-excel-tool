# v2.1.16-beta.2 迭代 PRD（需求规格）

> 状态：草稿（待用户 review）
> 分支：`v2.1.16-beta.2`（基于 main，beta.1 地基已随 PR#61 / commit `c6676cb` 合并 main）
> 目标版本号：`2.1.16-beta.2`（当前 `package.json` = `2.1.16-beta.1`，bump 属 T13）
> 创建日期：2026-06-07
> 性质：**后端为主**（5 轮对账引擎 + 编排器 + 导出），含 1 处前端改造（T11 场景列表列）
> 权威来源：team-lead 定稿实施计划 `/Users/pzhong/.claude/plans/2-1-16-1-2-2-1-nifty-pelican.md`

## 一、背景

清结算小助手 2.1.16 迭代的第二阶段。

- **beta.1（地基层 Stage 1）已合并 main**（PR#61，commit `c6676cb`）：批量导入按表头识别、链接表持久化（`linked_gateway_bill` / `linked_mid_allocation` / `linked_fx_settlement`）、自带写死场景「优先级」输入框、版本 bump 至 `2.1.16-beta.1`。
- **beta.2 落地「资金对账」核心引擎**：在「银行对账单预加工」模块里，对导入的银行对账单跑 **5 轮对账**，逐轮演化行状态，产出改写后的银行对账单 + 中台加款单剔除文件。
- 本次为**全量交付**（用户拍板「全做，含 R4 五个资金性质校验子场景」）。

## 二、已确认决策（用户拍板，已定，不再列为开放问题）

| # | 决策 | 选择 |
|---|---|---|
| D1 | 本次范围 | **全做**：R1 + R4 五个资金性质校验子场景判定 + R5 场景2/3 + 5 轮编排器 + 剔除导出 |
| D2 | R5 场景2 金额匹配（🔴 资金红线） | **发生额绝对值**：`\|Credit Amount − Debit Amount\|` 对比 `\|网关 amount\|`，**精确到分**（复用 C3 `BANK_STATEMENT_VIRTUAL_AMOUNT_ABS` 逻辑）；方向已由 FundType 过滤 |
| D3 | 网关数据源 | **从 `linked_gateway_bill` 读回**（新增 `readLinkedTableRows`）；用户须先在「链接表管理」导入网关对账单 |

## 三、目标与范围

### In-scope（本次交付）

1. **场景管理列表改造**（T11，前端）：功能类别更名 + 新增列。
2. **R1 对账ID匹配引擎**：reconciliationid 1v1，记录匹配对，不改字段。
3. **R4 资金性质校验引擎**（第四轮，🔴）：五个子场景按 priority 改写银行 FundType。
4. **R5 场景2「中台调拨订单对账ID回填」**（priority 0）：FundTransfer-out/in 双方向，回填 ReconciliationId。
5. **R5 场景3「中台加款单脏数据处理」**（priority 0）：Inbound-VA 命中生成剔除行。
6. **5 轮对账编排器**：`reconciliation-orchestrator.js` 串联 R1→R2→R3→R4→R5，跨轮累积标黄。
7. **中台加款单剔除导出**：场景3 有产出时，与银行对账单同目录输出 `中台加款单剔除模板-YYYY_MM_DD_HHMM.xlsx`。
8. **场景 seed migration**：5 个 R4 + 2 个 R5 内置场景，幂等不覆盖用户改动。
9. **FundType 枚举补值**（T12，🔴）：补 `Ach Return` / `HX-in` / `HX-out`，修错拼。
10. **版本 bump + 文档三件套 + 校验收口**（T13）。

### Out-of-scope（本次明确不做）

| 项 | 说明 |
|---|---|
| 网关 reader sheet 名 bug | `readGatewayRecon` 硬编码 sheet 名「网关账单」（实际为数字 ID）——**本次不修**。本次网关走链接表（用通用 reader 读真实 sheet）绕开此 bug；该 bug 影响「资金对账不平校验」模块，记为**单独 issue**。 |
| 外汇期权（fx-option） | 模板缺失，本迭代不涉及；`readLinkedTableRows('fx-option')` 返空，沿用 beta.1 占位。 |
| 银行对账单两 sheet 命中明细重构 | R4/R5 改写行进主输出 sheet1 标黄，**不进** N5「命中场景行」独立报表（该报表仅放 R2 命中行）；命中明细报表的重构不在本次。 |
| 其它占位场景 | 中台退款订单回填、入账原始订单对账ID反回填等沿用 beta.1 [UI骨架占位]，本次不接真实引擎。 |
| 资金对账不平校验导出 / 链接表批量导入 UI | 沿用 beta.1 占位（与网关 reader bug 相关联，待后续）。 |

## 四、需求详述（按用户原话组织为可验收条目）

> 跨表字段名遵循**显式映射**原则（网关小写 vs 银行驼峰，绝不假设同名）。完整映射见 `TECH_DESIGN.md` §4。

### 需求 1：场景管理列表改造（前端）

- **R1.1 功能类别更名**：自带写死（builtin-fixed）场景列表中，功能类别「中台订单校验」→「**中台订单数据处理**」。
- **R1.2 列定义**（用户 2026-06-07 澄清，已按实际改正）：自带写死场景列表**实际展示以下 5 列**（与既有 builtin-fixed 列表保持一致，本次仅改「功能类别」取值来源，不增删列）：
  - 序号
  - 功能类别（按 `config.funcCategory` 显示业务分组，如「资金性质校验」/「中台订单数据处理」；无 funcCategory 的既有场景回退既有 category 标签）
  - 场景名称
  - 优先级（priority）
  - 执行操作（builtin-fixed 仅「管理」按钮）
  - 是否启动（启用勾选）

> ⚠️ **澄清记录（2026-06-07）**：早期 PRD 草稿曾把「**功能**」（场景功能描述）「**涉及处理文件**」（如「银行对账单」/「中台加款单剔除模板」）列为展示列——经用户确认，这两项是**需求描述用语 / 内部 config 字段（`involvedFiles` 等），不是场景管理列表的展示列**，已从列定义中去除。代码实测展示列见 `src/renderer-dialogs.js:5590` 注释（`序号 / 功能类别 / 场景名称 / 优先级 / 执行操作 / 是否启动`）。「涉及处理文件」改在 PRD §四 需求 2/3 标题及验收标准里以文字说明（哪个场景产出哪种文件），不再作为 UI 列。

### 需求 2：R5 场景2「中台调拨订单对账ID回填」（priority 0，涉及文件：银行对账单）

- **R2.1 匹配对象**：网关 `TradeType=FundTransfer-out` 行 ↔ **第四轮处理过的**银行 `FundType=FundTransfer-out` 行；`FundTransfer-in` 同逻辑（两方向独立跑）。
- **R2.2 对账字段**：`Billdate`（网关）↔ `BillDate`（银行）、`merchantid`↔`MerchantId`、`currency`↔`Currency`、`amount`（金额）。
- **R2.3 一对一**：严格 1v1（每条银行行最多被一条网关行消费）。
- **R2.4 日期匹配策略**：**优先同日匹配**（网关 `Billdate` 与银行 `BillDate` 同日）；同日匹配不上时，银行 `BillDate` 取 **±1 day**（前后一天）再匹配。
- **R2.5 金额匹配**（🔴 已定 D2）：发生额绝对值 `|Credit Amount − Debit Amount|` vs `|网关 amount|`，**精确到分**（容差 0）。
- **R2.6 命中动作**：命中 → 网关 `reconciliationid` 写入银行 `ReconciliationId`。

### 需求 3：R5 场景3「中台加款单脏数据处理」（priority 0，涉及文件：中台加款单剔除模板）

- **R3.1 匹配对象**：网关 `TradeType=Inbound-VA` 行 ↔ **第四轮处理过的**银行行。
- **R3.2 匹配键**：网关 `reconciliationid` + 银行 `ReconciliationId`，相同且一对一（严格 1v1）。
- **R3.3 触发条件**：命中且银行 `FundType != 'Inbound'`。
- **R3.4 命中动作**：生成 1 条「中台加款单剔除行」（一般不改银行行），写入文件供导出：
  - **加款单号** = 网关 `orderid`
  - **附言** = `<对应银行行 FundType>，中台加款单已关闭。`（默认取 R4 改写后的当前 FundType，见 §八-Q4）
  - **C 列 ~ O 列**（13 列，表头与银行对账单同名）= 直接取对应银行行数据

### 需求 4：导出新增（中台加款单剔除文件）

- **R4.1**：启用「中台加款单脏数据处理」（场景3）后，预加工运行完如有剔除行，与银行对账单导出在**同一文件夹**。
- **R4.2 命名**：`中台加款单剔除模板-YYYY_MM_DD_HHMM.xlsx`（如 `中台加款单剔除模板-2026_06_07_1830.xlsx`）。
- **R4.3 落位兜底**：若主输出（银行对账单）为空、未产生主文件，则剔除文件落 `exportRootDir`（见 §八-Q7）。

### 需求 5：R4 资金性质校验（第四轮，🔴 资金红线）

- **R5.1 对账字段**：网关 `reconciliationid` + 银行 `ReconciliationId`。
- **R5.2 参与数据**：**第一轮（R1）匹配成功的网关行** × **第三轮（R3）处理过的全部银行行**，按 `reconciliationid === ReconciliationId` 关联。
- **R5.3 五子场景**：见 §五判定表，按 `priority` 顺序跑可插拔 handler 改写银行 `FundType`。
- **R5.4 允许多次改**：**同一银行行允许被多次改写 FundType**（叠加链，如 Charge→outbound 后再 →HX-out）；R4 是唯一允许二次改 FundType 的轮次。

## 五、R4 五子场景判定表（🔴 资金红线）

> **TradeType 真实取值 / priority 顺序待用户核对，已 config 化可调**（判定条件存 seed `config_json`，改值不动代码）。

| 子场景 | 网关 TradeType | 银行 FundType（改写前） | 改写为 | priority（默认） |
|---|---|---|---|---|
| Ach Return | `AchReturn` | ≠ `Ach Return` | `Ach Return` | 3 |
| Wire Return | `WireReturn` | ≠ `Wire Return` | `Wire Return` | 2 |
| Charge→outbound | （有 R1 匹配即可） | = `Charge` | `outbound` | 1 |
| HX-out | `HX_OUTBOUND` | ≠ `HX-out` | `HX-out` | 1 |
| HX-in | `HX_INBOUND` | ≠ `HX-in` | `HX-in` | 0 |

## 六、验收标准

> 逐条对应 §四需求，给可验证标准。

### 对应需求 1（场景管理列表）

1. builtin-fixed 场景列表功能类别旧名「中台订单校验」不再出现，显示「中台订单数据处理」。
2. 场景列表展示**实际 5 列**：序号 / 功能类别 / 场景名称 / 优先级 / 执行操作 + 是否启动勾选（与既有 builtin-fixed 列表一致，本次只改「功能类别」取值来源）；R4 五子场景「功能类别」显示「资金性质校验」分组，R5 两场景显示「中台订单数据处理」分组。
3. 「涉及处理文件」为**需求描述用语 / config 字段（非 UI 展示列）**：R5 场景2 产出/改写「银行对账单」、场景3 产出「中台加款单剔除模板」——在文档与 config（`involvedFiles`）中记录，不在场景管理列表呈现。
4. `npm run preview:*`（场景管理相关）截图回归通过，新增列正确呈现。

### 对应需求 2（R5 场景2 回填）

5. 网关 `FundTransfer-out` 与银行 `FundTransfer-out`（R4 后）按 merchantid/currency/金额绝对值/日期命中后，银行 `ReconciliationId` 被写为网关 `reconciliationid`；`FundTransfer-in` 同样生效。
6. 同日有候选时优先消费同日；同日无候选时 ±1day 命中；超过 ±1day 不命中。
7. 金额按发生额绝对值精确到分匹配：相差 1 分即不命中。
8. 严格 1v1：一条银行行不被两条网关行重复回填；多候选按 tie-break（同日优先→`|Δday|`小→银行行原序最前）选定并发 warning。
9. 银行 `ReconciliationId` 原值非空被覆盖时发 warning 但仍写入（与 C1/C3 一致）。

### 对应需求 3 + 4（R5 场景3 + 剔除导出）

10. 网关 `Inbound-VA` 与银行行按 `reconciliationid===ReconciliationId` 1v1 命中、且银行 `FundType != 'Inbound'` 时，生成 1 条剔除行。
11. 剔除行：加款单号 = 网关 `orderid`；附言 = `<银行行 FundType>，中台加款单已关闭。`；C~O 列 = 对应银行行字段。
12. 银行 `FundType == 'Inbound'` 时不生成剔除行。
13. 启用场景3 且有剔除行 → 与银行对账单同目录生成 `中台加款单剔除模板-YYYY_MM_DD_HHMM.xlsx`；无剔除行不生成文件。
14. 主输出为空时，剔除文件落 `exportRootDir`；剔除文件写入失败不阻塞主流程（graceful），renderer 收到剔除文件路径用于提示。

### 对应需求 5（R4 资金性质校验）

15. 仅「R1 匹配成功的网关行 × R3 全量银行行」按 reconciliationid 关联参与 R4；R1 未匹配的网关行不参与。
16. 五子场景按 priority 顺序执行，命中条件成立时改写银行 `FundType` 为目标值。
17. 同一银行行可被多个子场景叠加改写（如先 Charge→outbound，再 HX-out 链路生效）。
18. 被 R4 改写的银行行在主输出 sheet1 中标黄；改写不进 N5「命中场景行」报表。

### 全链路与回归

19. 编排器全链路 R1→R5 跑通；`modifiedRows + unmatchedRows = bankRows`（行数守恒）。
20. **R2 零回归**：现有 C2/C3 场景行为不变（R2 仍复用 first-match-wins dispatcher）；C3 网关源由 gatewayReconSession 切到链接表后，C3 场景 config 字段名与真实网关表头一致。
21. seed migration 幂等：跑两次只插一次；删除场景不复活；用户改名后仍能定位不覆盖。
22. `loadFundTypeEnum` 读出新增枚举值（`Ach Return`/`HX-in`/`HX-out`）；存量场景 config 不被破坏。
23. `npm run release-check` 全绿（PASS/FAIL 源）。

## 七、🔴 资金红线提醒（实现 / 提 PR / 版本 bump / 合并前必过 `/check-vars`）

> 命中 `rules/important-variables.md`（scenarios / dispatcher / FundType / 对账逻辑）。

- **R4 改写 FundType**：R4 是**唯一允许二次改值**的轮次，五子场景判定条件正确性、叠加链顺序须人工复核。配对必须来自 R1 的 reconciliationid 配对。
- **R5 场景2 金额发生额绝对值匹配 + ±1day**：金额归分错误或日期 ±1day 配错会写错 `ReconciliationId`（资金对账ID错配，下游影响大）。
- **R5 场景3 剔除行正确性**：加款单号（=orderid）/ 附言（FundType + 固定文案）/ C~O（银行行字段）任一错位都会导出错误的剔除清单。
- **R1 严格 1v1 不变量**：1v1 破坏会引发后续轮次多重匹配。
- **FundType 枚举改错拼**：改拼影响存量 config 的枚举引用（`Ach Ruturn→Ach Return`、`InternelFundTransfer→Internal` 见 §八-Q5）。

## 八、待确认项（来自权威计划，转述不拍板；默认值已 config 化可调）

> 以下 6 条 team-lead 批准时可纠偏；文档先按默认值成稿，对应判定/取值均 config 化，改值不动代码。

| # | 待确认项 | 默认值（计划） | config 化可调？ |
|---|---|---|---|
| Q1 | R4 各子场景**网关 TradeType 真实取值字符串**（`AchReturn` 还是 `Ach Return`？`HX_OUTBOUND` 还是 `HX-OUTBOUND`？`HX_INBOUND` 还是 `HX-INBOUND`？） | 见 §五表（来自原始 spec，真实网关数据待核） | 是（seed config_json） |
| Q2 | R4 各子场景 **priority / 执行顺序**（尤其 Charge→outbound 与 HX-out 同为 priority 1，平级时叠加链先后） | 见 §五表（3/2/1/1/0） | 是 |
| Q3 | R4 **Charge→outbound 触发条件**：是否仅凭「有 R1 匹配」、无需校验网关 TradeType | 仅凭有 R1 匹配（计划 line 69 ③） | 是 |
| Q4 | R5 场景3 **附言 FundType 取值时机**：用 R4 改写后当前值，还是 R4 前原值 | R4 改写后的**当前** FundType（计划 line 84 / line 152） | — |
| Q5 | **FundType 枚举改拼口径**：`InternelFundTransfer→Internal` 是否本次改 | `Ach Ruturn→Ach Return` **确定改**；`InternelFundTransfer→Internal` **待定**（T12） | — |
| Q6 | **reconciliationid 匹配大小写**：是否大小写敏感 | 大小写**敏感**（沿用 `normalizeCellValue` trim，不改大小写） | — |

### 其它默认值（计划「默认值与待确认项表」，沿用）

| 项 | 默认 |
|---|---|
| R3「处理过的行」 | = 全量 bank 行（R3 no-op 透传） |
| R4/R5 改写行 | 进主输出 sheet1 标黄，不进 N5 命中场景行报表 |
| 剔除文件落位 | 与主输出同目录；主输出为空时落 `exportRootDir` |
| seed enabled | R4/R5 场景默认 `enabled=1`（场景3 禁用即不产剔除文件） |
| 金额容差 | 0（精确到分） |
| ±1day tie-break | 同日优先 → `|Δday|` 小 → 银行原序最前 + warn 不阻断 |

## 九、实施记录（合并后回填）

> 由 `TASKS.md` 进度日志同步；本节为合并后回填（workflow_pr_integrate_prd）。

### 交付摘要（2026-06-07，提 PR 前回填）

本版（2.1.16-beta.2）按 T1–T13 全量交付 5 轮对账核心：

| 任务 | 交付内容 | 主要文件 |
|---|---|---|
| T1 | `readLinkedTableRows(db, tableKey)` 网关数据源读回（解析 raw_json 还原真实表头 / ORDER BY id ASC / 损坏行跳过 / fx-option 返空） | `linked-table-repository.js` + `database.js` facade |
| T2 | `engine-date-utils.js` 日期工具 `sameDay`/`dayDiffWithin`（复用 `normalizeDateExportValue`） | `scenario-engines/engine-date-utils.js`（新） |
| T3 | R1 对账ID 1v1 匹配引擎（大小写敏感，产 `matchedGwRows`/`pairs`，不改字段不标黄） | `scenario-engines/r1-recon-id-match.js`（新） |
| T4 🔴 | R4 资金性质校验引擎（5 可插拔 handler 按 priority 改 `FundType`，唯一允许二次改值轮次，判定 config 化复用 `evaluateCondition`） | `scenario-engines/r4-fund-nature-check.js`（新） |
| T5 🔴 | R5 场景2 FundTransfer 回填 `ReconciliationId`（发生额绝对值精确到分 + 同日/±1day 两阶段 + 严格 1v1 + 覆盖 warn + tie-break） | `scenario-engines/r5-fund-transfer-backfill.js`（新） |
| T6 🔴 | R5 场景3 Inbound-VA 剔除行（加款单号=orderid / 附言=R4 后 FundType / C~O 拷贝银行行）+ 15 列模板字段常量 + C~O⊆银行字段守卫 | `scenario-engines/r5-platform-inbound-cleanup.js`（新）+ `constants/platform-cleanup-template-fields.js`（新） |
| T7 🔴 | 5 轮编排器 `runReconciliation`（R1→R2→R3→R4→R5，按 funcCategory/subCategory 分桶，跨轮累积标黄，行数守恒，不改 dispatcher） | `reconciliation-orchestrator.js`（新） |
| T8 🔴 | `main.js bank-statement:run` 接编排器（网关行从 `structuredClone(database.readLinkedTableRows('gateway-bill'))` 取，R2/C3 网关源切链接表） | `src/main.js`（改） |
| T9 🔴 | 中台加款单剔除导出（同目录 / 主输出为空落 exportRootDir / graceful 失败不阻塞 / 命名 `中台加款单剔除模板-YYYY_MM_DD_HHMM.xlsx`） | `platform-cleanup-writer.js`（新）+ `bank-statement-io.js`（改）+ `src/main.js`（改） |
| T10 | 场景 seed migration `ensureReconRoundBuiltinScenariosSeed`（5 R4 + 2 R5 内置场景，幂等不覆盖用户改动） | `migrations.js`（改）+ `database.js`（迁移序列接入） |
| T11（前端） | builtin-fixed 列表「功能类别」按 `config.funcCategory` 映射业务分组显示（资金性质校验 / 中台订单数据处理）；实际 5 列不变 | `src/renderer-dialogs.js`（改）；重跑 `docs/previews/scenarios-manager.png` |
| T12 🔴 | FundType 枚举补 `Ach Return`/`HX-in`/`HX-out` + 修错拼 `Ach Ruturn→Ach Return`（一次性 migration 迁移存量 config）；`InternelFundTransfer→Internal` 本版不改 | `assets/FundType枚举值.xlsx` + 一次性 migration |
| T13 | 版本 bump `2.1.16-beta.1→beta.2` + 文档三件套（CHANGELOG / VERSION_FEATURE_HISTORY / USER_GUIDE）+ spec 三件套回填 + 收口 | `package.json` + 三件套 + 本 spec |

**UI 修复 / 收口**：场景管理列表显示回归核对（无 funcCategory 既有场景回退既有 category 标签，不回归）；preview 重跑（`scenarios-manager.png`）。

**验证证据**：`npm run release-check` 全绿——**unit 1731 / integration 952 / smoke 全过**；`npm run scan:vars` + `/check-vars`（提 PR 前由 team-lead 执行）。

**⚠️ 本版手测范围**：用户 2026-06-07 拍板，本版**仅手测「场景管理列表 UI」**；5 轮对账运行 / 导出全链路、Q1 网关 TradeType 真实取值核对、C3 网关源切链接表后 config 字段大小写回归等留待下版一起测——详见 `TASKS.md`「下版待测清单」。

_（待续：PR review 修复 / 合并 & 转正记录合并后追加。）_
