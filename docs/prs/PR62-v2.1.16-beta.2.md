# [v2.1.16-beta.2] 资金对账 5 轮编排 + R4 资金性质校验 + R5 中台订单数据处理 + 中台加款单剔除导出

## 背景

v2.1.16「资金对账数据处理」能力扩建分两阶段：

- **阶段一·地基层（beta.1，已随 PR#61 / commit `c6676cb` 合并 main）**：批量导入按表头识别、链接表持久化（`linked_gateway_bill` / `linked_mid_allocation` / `linked_fx_settlement`）、自带写死场景优先级输入框。
- **阶段二·本版（beta.2）**：在「资金对账数据处理」模块预加工流程里落地 **5 轮对账核心引擎**——对导入的银行对账单跑 R1→R2→R3→R4→R5，逐轮演化行状态，产出改写后的银行对账单 + 中台加款单剔除文件。网关数据源从链接表 `linked_gateway_bill` 读回（用户须先在「链接表管理」导入网关对账单）。

本版为**全量交付**（用户拍板「全做，含 R4 五个资金性质校验子场景」）。spec 三件套见 `changes/v2.1.16-beta.2/{PRD,TECH_DESIGN,TASKS}.md`。

> ⚠️ **本版手测范围有限**：用户 2026-06-07 拍板，本版**仅手测了「场景管理列表 UI」**，5 轮对账运行 / 导出全链路 + Q1 网关 TradeType 真实取值核对等留待下版一起测（见文末「下版待测清单」）。自动化测试已全绿，真实网关数据 + 端到端运行导出由下版人工把关。

## 改动清单（T1–T13 + UI 修复）

### 新建文件

| 文件 | 内容 | 🔴 |
|---|---|---|
| `src/main-process/reconciliation-orchestrator.js` | 5 轮编排器 `runReconciliation({bankRows,gwRows,scenarios,deps})`：R1→R2(复用 dispatcher)→R3 nop→R4→R5；按 `funcCategory`/`subCategory` 分桶内置场景；跨轮 `modifiedColumnsByRowId` 累积标黄；返回 `{modifiedRows,unmatchedRows,modifications,errorReport,stats,platformCleanupRows,rounds}`，行数守恒 `modifiedRows+unmatchedRows=bankRows` | 🔴 |
| `src/main-process/scenario-engines/r1-recon-id-match.js` | R1 对账ID 1v1 匹配（`reconciliationid===ReconciliationId` 大小写敏感），产 `matchedGwRows`/`pairs`；不改字段、不产 modification、不标黄 | |
| `src/main-process/scenario-engines/r4-fund-nature-check.js` | R4 资金性质校验：「R1 匹配网关行 × R3 全量银行行」按 reconid 关联，5 可插拔 handler 按 priority 改 `FundType`（判定 config 化复用 `evaluateCondition`）；唯一允许同一行多次改 FundType 的轮次 | 🔴 |
| `src/main-process/scenario-engines/r5-fund-transfer-backfill.js` | R5 场景2：网关 `FundTransfer-out/in` ↔ R4 后银行同 FundType 回填 `ReconciliationId`；`merchantid/currency` + 发生额绝对值精确到分 + 日期两阶段（同日→±1day）+ 严格 1v1 + 覆盖 warn + tie-break | 🔴 |
| `src/main-process/scenario-engines/r5-platform-inbound-cleanup.js` | R5 场景3：网关 `Inbound-VA` ↔ R4 后银行行按 reconid 1v1、`FundType!='Inbound'` 生成剔除行（加款单号=orderid / 附言=R4 后 FundType / C~O 拷贝银行行） | 🔴 |
| `src/main-process/scenario-engines/engine-date-utils.js` | `sameDay`/`dayDiffWithin`（复用 `normalizeDateExportValue`，不自写解析） | |
| `src/main-process/platform-cleanup-writer.js` | 中台加款单剔除 writer，仿 `scenario-hit-rows-writer.js`（15 列加粗 + watermark） | 🔴 |
| `src/constants/platform-cleanup-template-fields.js` | 15 列剔除模板表头单一真相 + C~O ⊆ `BANK_STATEMENT_FIELDS` 漂移守卫 | |

### 改动文件

| 文件 | 改动 | 🔴 |
|---|---|---|
| `src/main.js` | `bank-statement:run` 接编排器（网关行从 `structuredClone(database.readLinkedTableRows('gateway-bill'))` 取，R2/C3 网关源由 `gatewayReconSession` 切链接表）；`bank-statement:export` 接剔除导出（同目录 / 主输出为空落 `exportRootDir` / graceful 失败不阻塞主流程 / return 带剔除路径）。⚠️ 含 NUL 字节，grep 须 `-a` | 🔴 |
| `src/backend/database/linked-table-repository.js` | 新增 `readLinkedTableRows(db, tableKey)`：解析 `raw_json` 还原真实表头整行、`ORDER BY id ASC`、损坏行跳过、`fx-option` 返空 | |
| `src/backend/database.js` | facade 暴露 `readLinkedTableRows` + 迁移序列接入 `ensureReconRoundBuiltinScenariosSeed`（排在 `ensureScenariosCategoryBuiltinFixed` 之后） | |
| `src/backend/database/migrations.js` | `ensureReconRoundBuiltinScenariosSeed`：插 5 R4 + 2 R5 内置 `builtin-fixed` 场景（config 带 `funcCategory`/`subCategory`/`roundPhase`/`priority`/`involvedFiles`），幂等定位键 `config_json LIKE '%"subCategory":"X"%'` 已存在跳过不覆盖；FundType 一次性 migration（修错拼 `Ach Ruturn→Ach Return` 迁移存量 config） | 🔴 |
| `src/main-process/bank-statement-io.js` | 新增 `buildTimestampMinuteUnderscore`（`YYYY_MM_DD_HHMM`）/ `buildPlatformCleanupFileName`（`中台加款单剔除模板-YYYY_MM_DD_HHMM.xlsx`） | |
| `src/renderer-dialogs.js`（前端） | builtin-fixed 列表「功能类别」按 `config.funcCategory` 映射业务分组：`fund-nature-check`→「资金性质校验」、`platform-order`→「中台订单数据处理」（旧称「中台订单校验」更名）；无 funcCategory 既有场景回退既有 category 标签不回归。实际展示列保持 6 列（序号 / 功能类别 / 场景名称 / 优先级 / 执行操作 / 是否启动） | |
| `assets/FundType枚举值.xlsx` | 补 `Ach Return` / `HX-in` / `HX-out`（R4 子场景改写目标值）；修错拼 `Ach Ruturn→Ach Return`（`InternelFundTransfer→Internal` 本版不改） | 🔴 |
| `package.json` / `package-lock.json` | 版本 `2.1.16-beta.1 → 2.1.16-beta.2` | |
| `CHANGELOG.md` / `docs/VERSION_FEATURE_HISTORY.md` / `docs/USER_GUIDE.md` | 文档三件套加 beta.2 条目 | |
| `docs/previews/scenarios-manager.png` | 重跑 preview（T11 前端改动回归，memory `workflow_frontend_previews`） | |

> dispatcher（`scenario-dispatcher.js`）行为**零改动**——R2 仍复用其 first-match-wins 作为编排器内部一步。

### UI 修复 / 收口

- 场景管理列表显示回归核对：无 `funcCategory` 的既有 builtin-fixed 场景（如「从银行对账单提取调拨订单对账ID」）回退到既有 category 标签（实测 `'银行对账单赋值自身'`），既有显示不回归。
- preview 重跑：`docs/previews/scenarios-manager.png`。

## 测试证据

- **`npm run release-check` 全绿（PASS/FAIL 源）**：
  - 单测 **unit 1731 / 1731 PASS**
  - 集成 **integration 952 / 952 PASS**
  - smoke 全过（0 regression）
- 新增单测：R1（`r1-recon-id-match.test.js`）/ R4（`r4-fund-nature-check.test.js`，含二次改值链 + 枚举外值 warn）/ R5场景2（`r5-fund-transfer-backfill.test.js`，含同日/±1day/绝对值归分/1v1/覆盖 warn/tie-break）/ R5场景3（`r5-platform-inbound-cleanup.test.js`）/ 日期工具 / 编排器契约 / `readLinkedTableRows` 还原 / 剔除 writer / migration 幂等 / FundType 枚举与改拼。
- **前端**：`npm run preview:*`（场景管理列表）截图回归——`docs/previews/scenarios-manager.png` 已重跑，功能类别按业务分组正确呈现。

> ⚠️ **本版仅手测「场景管理列表 UI」**；5 轮对账运行 / 导出全链路 + 真实网关数据由下版手测（见下「下版待测清单」）。

## 🔴 资金红线小节

> 命中 `rules/important-variables.md`（scenarios / dispatcher / FundType / 对账逻辑）。提 PR / 版本 bump / 合并前必过 `/check-vars`。

- **R4 改写 `FundType`（唯一允许二次改值轮次）**：五子场景判定条件正确性、叠加链顺序须人工复核；配对必须来自 R1 的 reconciliationid 配对。
- **R5 场景2 金额发生额绝对值匹配 + ±1day**：金额归分错误或日期 ±1day 配错会写错 `ReconciliationId`（资金对账ID 错配，下游影响大）。
- **R5 场景3 剔除行正确性**：加款单号（=`orderid`）/ 附言（FundType + 固定文案）/ C~O（银行行字段）任一错位都会导出错误的剔除清单。
- **R1 严格 1v1 不变量**：1v1 破坏会引发后续轮次多重匹配。
- **FundType 枚举改错拼**：`Ach Ruturn→Ach Return` 影响存量 config 的枚举引用（一次性 migration 已迁移）。
- **网关数据源切链接表**：R2/C3 网关源由 `gatewayReconSession` 切到链接表 `linked_gateway_bill`——C3 场景 config 字段名须与真实网关（小写）表头一致（回归重点，见下版待测 C3 项）。

## 下版待测清单

> 用户 2026-06-07 拍板：本版只测了场景管理列表 UI，以下留待下版一起测（全文同 `changes/v2.1.16-beta.2/TASKS.md`「下版待测清单」）。

1. **5 轮对账端到端**（运行 + 导出全链路）：链接表导入网关 → 预加工导入银行对账单 → 跑 R1→R5 → 导出银行对账单 + 中台加款单剔除文件。核对改写行标黄、行数守恒、剔除文件命名与落位。
2. **🔴 Q1 网关 TradeType 真实取值核对**：seed 默认值 `AchReturn` / `WireReturn` / `HX_OUTBOUND` / `HX_INBOUND` / `Inbound-VA` / `FundTransfer-out`·`FundTransfer-in`——若与真实网关数据字面不符，R4/R5 会**静默不匹配**（不报错、不命中）；判定已 config 化可调。
3. **C3 回归**：内置 `gateway-recon-join`（C3，默认禁用）config 字段大小写（`Currency`/`Amount`/`MerchantId`/`Bank`/`reconciliationId`）与链接表真实小写表头不符，启用会失效——下版决定修 C3 config 还是读链接表时做字段名归一。
4. **「从银行对账单的信息里提取调拨订单对账ID」场景功能类别**：无 funcCategory 回退显示「**银行对账单赋值自身**」，待确认是否要改。
5. **Q2–Q6 默认值**：R4 子场景 priority 平级序（Charge→outbound 与 HX-out 同 1）/ Charge→outbound 触发条件（仅凭有 R1 匹配）/ 剔除附言取 R4 后 FundType / `InternelFundTransfer` 拼写本版不改 / reconciliationid 大小写敏感。
6. **🚧 工作树未跟踪 / 污染文件（非本 PR 内容，待用户处置）**：`assets/外汇期权表.xlsx`、`docs/iterations/v2.1.12~v2.1.16-beta.1/`、`docs/prs/PR58-v2.1.13.md`、`rules/doc-archive-policy.md`、`rules/integration-test-policy.md`、`scripts/perf/bench-acquiring-overwrite-delete.js`——dev 并行 `git stash` 误灌入工作树，**不随本 PR 提交**（提 PR 时只 add 本版交付相关文件，勿 `git add -A`），最终处置由用户拍板。

## ⚠️ 关联功能 review（/check-vars）

`npm run check:vars`（扫 6 个 tracked 改动文件）命中 `rules/important-variables.md`：

**Critical**
- `runAllScenarios`：dispatcher 入口**未改**；编排器 R2 复用它，仅取其 `modifications`/`errorReport`/`stats`/`modifiedRows` 元数据。integration「R2 零回归」用例通过。
- `runReconciliation`：新 5 轮编排器入口；`bank-statement:run` 改调它。行数守恒 `modifiedRows + unmatchedRows = bankRows` 由 `buildOutputRows` 互否 filter 保证（编排器 integration 断言）。
- `unmatchedRows`：现由编排器 `buildOutputRows` 反向 filter 产生（与 `modifiedRows` 互斥全覆盖），导出 sheet2 依赖此不变量——已断言成立。

**Runtime-state**
- `processingResult`：新增 `platformCleanupRows` 字段；其余字段来源由 dispatcher 单层切为编排器聚合产物。`scenariosSnapshot` 校验链（run 记录 / export 比对）未改。
- `gatewayReconSession`：仅 `bank-statement:run` 的网关来源由它切到 `linked_gateway_bill`；其定义及在「资金对账不平校验」模块的使用未动。

**Risk-sensitive**
- `runReconciliation`：R4 改写 `FundType`（唯一允许二次改值轮次）+ R5 回填 `ReconciliationId`，均经引擎单测 + 编排器 integration 覆盖。🔴 真实网关 TradeType 取值（Q1）待下版核对——错值会**静默不命中**（不误改）。

**smoke**：Critical / Risk-sensitive 命中 → 已跑 `npm run smoke` 全过（release-check 含 smoke 全绿）。
