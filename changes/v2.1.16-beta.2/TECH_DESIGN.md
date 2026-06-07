# v2.1.16-beta.2 技术方案（TECH_DESIGN）

> 配套 `PRD.md`；性质：后端为主（5 轮对账引擎 + 编排器 + 导出），含 1 处前端（T11）。
> 权威来源：team-lead 定稿实施计划 `/Users/pzhong/.claude/plans/2-1-16-1-2-2-1-nifty-pelican.md`。
> 涉及 `src/main-process/` 引擎与编排、`src/backend/database/` 仓储与 migration、`src/main.js` 接入、`src/constants/` 常量、`src/renderer-dialogs.js`（T11）、`assets/`。

## 0. 涉及文件总览

| 文件 | 改动 | 类型 |
|---|---|---|
| `src/main-process/reconciliation-orchestrator.js` | 5 轮编排器：`runReconciliation({bankRows,gwRows,scenarios,deps})` | **新建** |
| `src/main-process/scenario-engines/r1-recon-id-match.js` | R1 reconid 1v1 匹配 | **新建** |
| `src/main-process/scenario-engines/r4-fund-nature-check.js` | R4 资金性质校验（🔴） | **新建** |
| `src/main-process/scenario-engines/r5-fund-transfer-backfill.js` | R5 场景2 回填 ReconciliationId | **新建** |
| `src/main-process/scenario-engines/r5-platform-inbound-cleanup.js` | R5 场景3 生成剔除行 | **新建** |
| `src/main-process/scenario-engines/engine-date-utils.js` | `sameDay` / `dayDiffWithin`（复用 normalizeDateExportValue） | **新建** |
| `src/main-process/platform-cleanup-writer.js` | 中台加款单剔除 writer（仿 scenario-hit-rows-writer） | **新建** |
| `src/main-process/bank-statement-io.js` | 加 `buildTimestampMinuteUnderscore` / `buildPlatformCleanupFileName` | 改动 |
| `src/constants/platform-cleanup-template-fields.js` | 15 列剔除模板表头单一真相 + C~O⊆银行字段断言 | **新建** |
| `src/backend/database/linked-table-repository.js` | 加 `readLinkedTableRows(db, tableKey)` | 改动 |
| `src/backend/database.js` | facade 暴露 `readLinkedTableRows` + 迁移序列接入新 seed | 改动 |
| `src/backend/database/migrations.js` | `ensureReconRoundBuiltinScenariosSeed`（5 R4 + 2 R5） | 改动 |
| `src/main.js` | `bank-statement:run` 接编排器；`bank-statement:export` 接剔除导出（含 NUL 字节，grep 须 `-a`） | 改动 |
| `src/renderer-dialogs.js` | builtin-fixed 列表：功能类别更名 + 新增「功能」「涉及处理文件」列（T11，🔴前端） | 改动 |
| `assets/FundType枚举值.xlsx` | 补 `Ach Return`/`HX-in`/`HX-out`，修错拼（T12，🔴） | 资源 |
| `assets/中台加款单剔除模板.xlsx` | 15 列 C~O 同名校验基准 | 资源（只读） |
| `assets/网关对账单.xlsx` | 真实 31 列字段名核对基准 | 资源（只读） |

> 参照范本（不改）：`src/main-process/scenario-engines/c3-gateway-recon-join.js`（1v1 + usedGwRowIdx + 发生额绝对值 + 回填范式）、`src/main-process/scenario-hit-rows-writer.js`（writer 范式蓝本）、`migrations.js` 的 `ensureBuiltinFixedScenarioMigration`（幂等 migration 范式）。

## 1. 架构决策（沿用 beta.1 已定，无需再确认）

| 决策 | 说明 |
|---|---|
| **funcCategory 入 config_json，不扩 `scenarios.category` 枚举** | `category` 是引擎路由键（builtin-fixed 等），不能塞业务分组。builtin-fixed 场景 config 加 `funcCategory` / `subCategory` / `roundPhase` / `priority` / `involvedFiles`，编排器与 UI 读取分桶。 |
| **编排器独立新建，不改 `scenario-dispatcher.js`** | `reconciliation-orchestrator.js` 为新文件；R2 仍复用 first-match-wins 的 `scenario-dispatcher.js` 作为编排器内部一步。dispatcher 行为零改动。 |
| **新场景走独立幂等 migration** | 仿 `ensureBuiltinFixedScenarioMigration`；**不走**受 `scenarios_seeded` 终态标记保护的 `BUILTIN_SCENARIOS` seed（那是另一套保护机制）。 |
| **R4/R5 不参与 R2 的 `rowLockSet`** | R4 是唯一允许二次改 FundType 的轮次；R5 回填 ReconciliationId / 生成剔除行也独立于 first-match-wins。编排器自持 `modifiedColumnsByRowId: Map<rowId, Set<col>>` 跨 5 轮累积标黄列。 |

## 2. 数据流图

```
【链接表管理】导入网关对账单 ──► linked_gateway_bill（持久化，raw_json = 真实表头整行）
                                          │
【银行对账单预加工】                       │ database.readLinkedTableRows('gateway-bill')
  导入银行对账单(session) ─┐               ▼  → structuredClone 后传入编排器
                          └──► runReconciliation(reconciliation-orchestrator)
                                  R1 reconid 1v1 匹配      → 记 matchedGwRows / pairs（不改字段）
                                  R2 现有 dispatcher       （C2/C3，first-match-wins）
                                  R3 占位 no-op            （透传全量银行行 → r3BankRows = 全量）
                                  R4 资金性质校验          （matchedGwRows × 全量 bank 按 reconid 关联，
                                                            5 子场景按 priority 改 FundType，允许多次改）
                                  R5 场景2（FundTransfer）  （同日/±1day 金额绝对值匹配 → 回填 ReconciliationId）
                                  R5 场景3（Inbound-VA）    （reconid 1v1 → FundType≠Inbound 则生成剔除行）
                                          │
                          ┌───────────────┴───────────────┐
                          ▼                               ▼
                导出银行对账单（2 sheet，标黄）      中台加款单剔除文件（场景3 有产出时，同目录）
                 主输出 mainFilePath                 中台加款单剔除模板-YYYY_MM_DD_HHMM.xlsx
                                                    （主输出为空时落 exportRootDir）
```

- 网关数据源：`structuredClone(database.readLinkedTableRows('gateway-bill'))`（R2/C3 网关源由 `gatewayReconSession` 切到链接表——**回归重点**：现有 C3 场景 config 字段名须与真实网关表头一致）。
- 银行行：同一组对象引用贯穿 R1→R5（各引擎原地改字段，与现有 C1/C2/C3 一致），`_rowId` 全局唯一。

## 3. 5 轮模型与轮间状态

编排器维护以下跨轮状态：

| 状态 | 来源 | 用途 |
|---|---|---|
| `matchedGwRows` | R1 产出 | reconciliationid 1v1 命中的网关行 → R4 用 |
| `pairs` | R1 产出 | reconid 配对（网关行 ↔ 银行行）→ R4 关联依据 |
| `r3BankRows = 全量 bankRows` | R3 no-op = 透传 | **默认**：R4/R5 对全量行操作（见 §11 待确认项） |
| `modifiedColumnsByRowId: Map<rowId, Set<col>>` | 跨轮累积 | 每行被改的列 → 最终 `modifiedRows`（标黄）/ `unmatchedRows` |

**R2 取值约定**：R2 仅取 dispatcher 的 `modifications` / `errorReport` / `stats`（**忽略**其 `modifiedRows` 浅拷贝投影），合并进累积器；R4/R5 改写行进主输出 sheet1 标黄，**不进** N5「命中场景行」独立报表（只放 R2 命中行）。

**编排器返回**：`{ modifiedRows, unmatchedRows, modifications, errorReport, stats, platformCleanupRows, rounds }`。
- 行数守恒不变量：`modifiedRows + unmatchedRows = bankRows`。

## 4. 跨表字段映射表（务必显式映射，绝不假设同名）

| 语义 | 网关（gateway-bill，小写） | 银行（bank statement，驼峰） | 剔除模板 |
|---|---|---|---|
| 对账 ID | `reconciliationid` | `ReconciliationId` | （C~O 含 `ReconciliationId`） |
| 交易类型 | `TradeType` | — | — |
| 资金性质 | — | `FundType` | C~O 含 `FundType` |
| 商户 ID | `merchantid` | `MerchantId` | C~O 含 `MerchantId` |
| 币种 | `currency` | `Currency` | C~O 含 `Currency` |
| 账单日期 | `Billdate` | `BillDate` | C~O 含 `BillDate` |
| 金额 | `amount`（单列） | `Credit Amount` + `Debit Amount`（双列） | C~O 含金额列 |
| 订单号 | `orderid` | — | A 列「加款单号」= 网关 `orderid` |
| 附言 | — | — | B 列「附言」= `<银行行 FundType>，中台加款单已关闭。` |

- **金额比对口径（🔴 D2）**：网关 `|amount|` vs 银行 `|Credit Amount − Debit Amount|`，精确到分。方向已由 FundType 过滤（FundTransfer-out/in 分别匹配）。
- 剔除模板 C~O（13 列）表头与银行对账单同名，直接拷贝银行行字段；A/B 两列为剔除模板专属。完整 15 列见 `constants/platform-cleanup-template-fields.js`（单一真相），漂移守卫断言 C~O ⊆ `BANK_STATEMENT_FIELDS`。

## 5. 各引擎设计

### 5.1 R1 — `r1-recon-id-match.js`（reconid 1v1，不改字段）

- 输入 `{ bankRows, gwRows }`；按 `reconciliationid === ReconciliationId`（大小写敏感，沿用 `normalizeCellValue` trim）做 1v1 匹配。
- 产出 `matchedGwRows` / `pairs`；**不改任何字段**，**不产 modification**（不标黄）。
- 一条键多匹配 → 取第一条 + `warning`。
- 空键（reconid 为空）→ 跳过不参与匹配。

### 5.2 R4 — `r4-fund-nature-check.js`（🔴 资金性质校验，可插拔 handler）

- 输入 `matchedGwRows × 全量 bank 行`，按 `reconciliationid === ReconciliationId` 关联（来自 R1 配对）。
- **5 个可插拔 handler**，按 `priority` 顺序跑（判定条件全部 config 化，存 seed config_json，**复用 `evaluateCondition`**）。
- **允许同一银行行被多次改 FundType**（叠加链如 Charge→outbound 后再 →HX-out）；每步改写 `record` 进 `modifiedColumnsByRowId`（标黄 `FundType` 列）。
- 判定表见 §10（与 PRD §五同步）。**TradeType 真实取值 / priority 顺序待用户核对，已 config 化可调**。
- 单测须含：单 / 多 handler 顺序、二次改值链、no-op 守卫、priority 顺序。
- R4 **不做运行时 FundType 枚举校验**：`setFundType` 来自受控 seed config（builtin-fixed config 不可经 UI 编辑、枚举已含全部目标值），非法值仅可能来自直接改库，本期不防护（PR#62 Codex F3：文档对齐真实行为）。

### 5.3 R5 场景2 — `r5-fund-transfer-backfill.js`（回填 ReconciliationId）

- 方向 out：网关 `TradeType=FundTransfer-out` ↔ R4 后银行 `FundType=FundTransfer-out`；方向 in：`FundTransfer-in` ↔ `FundTransfer-in`（两方向独立跑，config `directions[]`）。
- 对账字段：`merchantid↔MerchantId`、`currency↔Currency`（`valuesEqual` 字符串）+ **金额发生额绝对值 `|Credit−Debit|` vs `|amount|` 精确到分**（🔴 D2）+ 日期。
- **日期两阶段**：
  - Phase1 严格同日（`Billdate` 同日，消费掉同日命中）。
  - Phase2 剩余 gw 用银行 `BillDate` **±1day**。
  - 日期解析复用 `normalizers.normalizeDateExportValue(v).date`（**勿自写解析**），经 `engine-date-utils.js` 的 `sameDay` / `dayDiffWithin`。
- 严格 1v1（`usedBankRowId` 单向消费）；多候选 tie-break：同日优先（Phase 分离已保证）→ `|Δday|` 小 → 银行行原序最前 + `warning`。
- 命中 → 银行 `ReconciliationId = 网关 reconciliationid`（原值非空被覆盖发 warning 但仍写，与 C1/C3 一致），标黄 `ReconciliationId` 列。
- 单测须含：同日 / ±1day / 方向 / 1v1 / 绝对值归分 / 覆盖 warn / tie-break。

### 5.4 R5 场景3 — `r5-platform-inbound-cleanup.js`（生成剔除行）

- 网关 `TradeType=Inbound-VA` ↔ R4 后银行行，键 `reconciliationid === ReconciliationId`，严格 1v1。
- 命中且银行 `FundType != 'Inbound'` → 生成 1 条剔除行（一般不改银行行）：
  - A「加款单号」= 网关 `orderid`
  - B「附言」= `<对应银行行 FundType>，中台加款单已关闭。`（**默认用 R4 后当前 FundType**，见 §11 Q4）
  - C~O（13 列，表头与银行对账单同名）= 直接拷贝银行行字段
- 剔除行存入 `processingResult.platformCleanupRows`（`buildCleanupRow` 构造）。
- `constants/platform-cleanup-template-fields.js`：15 列表头单一真相 + C~O ⊆ 银行字段断言。
- 单测须含：命中产剔除行 A/B/C-O 正确、`FundType=Inbound` 不产、附言用 R4 后值。

## 6. 网关数据源 `readLinkedTableRows`（linked-table-repository.js）

- 签名：`readLinkedTableRows(db, tableKey)`。
- 解析 `raw_json` 还原整行（字段名 = 真实表头），`ORDER BY id ASC`。
- `fx-option` 返空（外汇期权本迭代不涉及）。
- 损坏行（JSON 解析失败）**跳过**，不中断整批。
- `database.js` 加 facade 暴露。
- **前置验证**：先写脚本验证 `linked_gateway_bill.raw_json` 字段名 = 真实网关表头（避免假设同名）。

## 7. 中台加款单剔除导出

- **writer**：`platform-cleanup-writer.js`（仿 `scenario-hit-rows-writer.js`）：15 列表头加粗 + watermark。
- **文件名 formatter**（`bank-statement-io.js`）：
  - `buildTimestampMinuteUnderscore()` → `YYYY_MM_DD_HHMM`
  - `buildPlatformCleanupFileName()` → `中台加款单剔除模板-YYYY_MM_DD_HHMM.xlsx`
- **export 接入点**（`main.js` `bank-statement:export`，约 L3591-3716）：
  - 主输出成功后，同目录 `path.dirname(mainFilePath)` 写剔除文件。
  - 主输出为空时，落 `exportRootDir`。
  - **graceful 失败不阻塞主流程**；return 带剔除路径供 renderer 提示。
- **run 接入点**（`main.js` `bank-statement:run`，约 L3532-3589）：改调 orchestrator；网关行从 `structuredClone(database.readLinkedTableRows('gateway-bill'))` 取；`processingResult` 加 `platformCleanupRows`。

## 8. seed migration（migrations.js）

- 新增 `ensureReconRoundBuiltinScenariosSeed`：
  - 插入 5 个 R4 + 2 个 R5 内置场景；config 带 `funcCategory` / `subCategory` / `roundPhase` / `priority`（∈ 0..3）/ `involvedFiles`。
  - **幂等定位键**：`is_builtin=1 AND category='builtin-fixed' AND config_json LIKE '%"subCategory":"X"%'`。
  - 已存在则**跳过不覆盖**用户改动。
- `database.js` 迁移序列接入：排在 `ensureScenariosCategoryBuiltinFixed` **之后**。
- 幂等单测：跑两次只插一次 / 删除不复活 / 改名仍定位。

## 9. 测试策略

| 层 | 范围 |
|---|---|
| **引擎 unit**（`tests/unit/main-process/scenario-engines/`） | R1（1v1 / 多匹配 / 空键 / 不产 modification）；R4（单 / 多 handler 顺序 / 二次改值链 / no-op 守卫 / priority 顺序）；R5场景2（同日 / ±1day / 方向 / 1v1 / 绝对值归分 / 覆盖 warn / tie-break）；R5场景3（命中产剔除行 A/B/C-O 正确、FundType=Inbound 不产、附言用 R4 后值） |
| **编排器 integration**（`tests/integration/`） | 全链路 R1→R5；R2 零回归；R4 改 R2 命中行；标黄跨轮合并；`modifiedRows+unmatchedRows=bankRows`；stats 分项 |
| **仓储 / writer / migration** | `readLinkedTableRows` 还原 / 损坏 / 顺序；`writePlatformCleanupOutput` 15 列 + 命名；migration 幂等 |
| **漂移守卫** | `CLEANUP_TEMPLATE_HEADERS` vs assets 真实表头一致；C~O ⊆ `BANK_STATEMENT_FIELDS` |
| **smoke + release-check** | release-check 为 PASS/FAIL 源 |
| **前端**（T11） | 重跑 `npm run preview:*`（场景管理列表截图回归） |
| **变量** | `npm run scan:vars` + `/check-vars`（命中 scenarios/dispatcher/FundType/对账逻辑） |
| **手动** | 链接表导入网关 → 预加工导入银行对账单 → 运行 5 轮 → 导出银行对账单 + 剔除文件 |

## 10. R4 五子场景判定表（与 PRD §五同步收录，🔴 资金红线）

> **TradeType 真实取值 / priority 顺序待用户核对，已 config 化可调**（判定条件存 seed `config_json`，改值不动代码）。R4 对「matchedGwRows × 全量 bank 行」按 `reconciliationid === ReconciliationId` 关联；按 `priority` 顺序跑可插拔 handler，**允许同一银行行被多次改 FundType**。

| 子场景 | 网关 TradeType | 银行 FundType（改写前） | 改写为 | priority（默认） |
|---|---|---|---|---|
| Ach Return | `AchReturn` | ≠ `Ach Return` | `Ach Return` | 3 |
| Wire Return | `WireReturn` | ≠ `Wire Return` | `Wire Return` | 2 |
| Charge→outbound | （有 R1 匹配即可） | = `Charge` | `outbound` | 1 |
| HX-out | `HX_OUTBOUND` | ≠ `HX-out` | `HX-out` | 1 |
| HX-in | `HX_INBOUND` | ≠ `HX-in` | `HX-in` | 0 |

## 11. 默认值与待确认项表（直接搬权威计划）

> team-lead 批准时可纠偏；判定 / 取值均 config 化（改值不动代码）。

| 项 | 默认 |
|---|---|
| R4 五子场景 TradeType / FundType / priority | 见 §10 表（config 化可调，待核对真实网关取值）—— **Q1 / Q2** |
| R3「处理过的行」 | = 全量 bank 行（R3 no-op 透传） |
| R4/R5 改写行 | 进主输出 sheet1 标黄，不进 N5 命中场景行报表 |
| reconciliationid 匹配 | 大小写敏感（沿用 `normalizeCellValue` trim，不改大小写）—— **Q6** |
| 剔除行附言 FundType | R4 改写后当前值 —— **Q4** |
| 剔除文件落位 | 与主输出同目录；主输出为空时落 `exportRootDir` |
| seed enabled | R4/R5 场景默认 `enabled=1`（场景3 禁用即不产剔除文件） |
| 金额容差 | 0（精确到分） |
| ±1day tie-break | 同日优先 → `|Δday|` 小 → 银行原序最前 + warn 不阻断 |
| Charge→outbound 触发条件 | 仅凭「有 R1 匹配」无需看网关 TradeType —— **Q3** |
| FundType 枚举改拼 | `Ach Ruturn→Ach Return` 确定改；`InternelFundTransfer→Internal` 待定 —— **Q5** |

> Q1–Q6 与 PRD §八「待确认项」一一对应，文档先按默认值成稿，不替 team-lead 拍板。

## 12. 阻塞 / 风险

- **网关 reader sheet 名 bug**：`readGatewayRecon` 硬编码 `'网关账单'`（实际数字 ID）——**不阻塞 beta.2**（本次网关走链接表，链接表导入用通用 reader 读真实 sheet）；但影响「资金对账不平校验」模块，记为**单独 issue**。
- **T8 网关源切换回归**：R2/C3 由 `gatewayReconSession` 切链接表，须验证现有 C3 场景 config 字段名与真实网关表头一致。
- **外汇期权表**：模板缺失，本迭代不涉及（沿用 beta.1 占位，`readLinkedTableRows('fx-option')` 返空）。
- **main.js 含 NUL 字节**：grep 须加 `-a`（memory `reference_mainjs_nul_grep`）；git diff 显示二进制拿不到 diff 行。

## 13. 实施记录（合并后回填）

> 由 `TASKS.md` 进度日志同步；本节为合并后回填。

### 交付摘要（2026-06-07，提 PR 前回填）

按本技术方案全量落地：新建 `reconciliation-orchestrator.js`（5 轮编排，R1→R2(复用 dispatcher)→R3 nop→R4→R5，跨轮 `modifiedColumnsByRowId` 累积标黄，行数守恒）+ 4 个引擎（`r1-recon-id-match.js` / `r4-fund-nature-check.js` 🔴 / `r5-fund-transfer-backfill.js` 🔴 / `r5-platform-inbound-cleanup.js` 🔴）+ `engine-date-utils.js` + `platform-cleanup-writer.js` 🔴 + `constants/platform-cleanup-template-fields.js`（15 列单一真相 + C~O⊆银行字段守卫）；改动 `linked-table-repository.js`/`database.js`（`readLinkedTableRows`）、`migrations.js`/`database.js`（`ensureReconRoundBuiltinScenariosSeed` 幂等 5 R4+2 R5）、`bank-statement-io.js`（`buildTimestampMinuteUnderscore`/`buildPlatformCleanupFileName`）、`src/main.js`（`bank-statement:run` 接编排器 + 网关源切链接表、`bank-statement:export` 接剔除导出 graceful）、`src/renderer-dialogs.js`（T11 builtin-fixed 列表「功能类别」按 funcCategory 映射）、`assets/FundType枚举值.xlsx`（T12 补值 + 修错拼）。dispatcher 行为零改动（R2 仅复用）。验证：`npm run release-check` 全绿（unit 1731 / integration 952 / smoke 全过）。⚠️ §11 待确认 Q1–Q6 按默认值落地、config 化，真实网关数据核对见 `TASKS.md`「下版待测清单」。

_（待续：PR review 修复 / 回归结论合并后追加。）_
