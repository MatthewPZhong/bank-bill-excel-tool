# v2.1.16-beta.2 任务拆分（TASKS）

> 配套 `PRD.md` / `TECH_DESIGN.md`。性质：后端为主（5 轮对账引擎 + 编排器 + 导出），含 1 处前端（T11）。
> 权威来源：team-lead 定稿实施计划 `/Users/pzhong/.claude/plans/2-1-16-1-2-2-1-nifty-pelican.md`。
> 状态图例：⬜ 待办 / 🔄 进行中 / ✅ 完成 / ⏸️ 暂缓 / 🚧 阻塞（待用户答复）
> 委托约定：team-lead 委托 dev，每任务 ≤ 3–5 文件。

## 任务清单（T1–T13，Phase 0–5）

> 列：任务号 / 标题 / 改动或新建文件 / 依赖 / 验收方式 / 🔴资金红线 / 前端(需重跑 preview) / 状态

### Phase 0 — 地基 / 数据源

| 任务号 | 标题 | 改动/新建文件 | 依赖 | 验收方式 | 🔴红线 | 前端 | 状态 |
|---|---|---|---|---|---|---|---|
| **T1** | `readLinkedTableRows(db, tableKey)` 网关数据源读回 | `linked-table-repository.js`(改) + `database.js`(facade) | — | **先写脚本验证 `linked_gateway_bill.raw_json` 字段名=真实表头**；unit：解析 raw_json 还原整行 / `ORDER BY id ASC` / fx-option 返空 / 损坏行跳过 | 否 | 否 | ⬜ |
| **T2** | `engine-date-utils.js` 日期工具 | `scenario-engines/engine-date-utils.js`(新) | — | unit：`sameDay(a,b)` / `dayDiffWithin(a,b,n)`（复用 `normalizeDateExportValue`，勿自写解析） | 否 | 否 | ⬜ |

### Phase 1 — 引擎（纯函数，可单测）

> **T3–T6 相互独立，可并行委托。**

| 任务号 | 标题 | 改动/新建文件 | 依赖 | 验收方式 | 🔴红线 | 前端 | 状态 |
|---|---|---|---|---|---|---|---|
| **T3** | R1 对账ID匹配引擎 | `scenario-engines/r1-recon-id-match.js`(新) | — | unit：reconid 1v1 / 多匹配取第一+warn / 空键跳过 / **不改字段·不产 modification**；记 `matchedGwRows`/`pairs` | 否（间接影响下游 1v1 不变量） | 否 | ⬜ |
| **T4** | R4 资金性质校验引擎（5 可插拔 handler） | `scenario-engines/r4-fund-nature-check.js`(新) | T3（matchedGwRows） | unit：单/多 handler 顺序 / **二次改值链** / 枚举外值 warn；matchedGwRows×bank 按 reconid 关联，按 priority 改 FundType（复用 `evaluateCondition`，config 化判定，每步 record） | **🔴** | 否 | ⬜ |
| **T5** | R5 场景2 FundTransfer 回填 | `scenario-engines/r5-fund-transfer-backfill.js`(新) | T2（日期工具） | unit：同日/±1day/方向/1v1/**金额绝对值归分**/覆盖 warn/tie-break；命中回填 `ReconciliationId` | **🔴** | 否 | ⬜ |
| **T6** | R5 场景3 Inbound-VA 剔除行 + 模板字段常量 | `scenario-engines/r5-platform-inbound-cleanup.js`(新) + `constants/platform-cleanup-template-fields.js`(新) | — | unit：命中产剔除行 A/B/C-O 正确 / FundType=Inbound 不产 / 附言用 R4 后值；15 列单一真相 + C~O⊆银行字段断言；`buildCleanupRow` | **🔴** | 否 | ⬜ |

### Phase 2 — 编排器 + run 接入

| 任务号 | 标题 | 改动/新建文件 | 依赖 | 验收方式 | 🔴红线 | 前端 | 状态 |
|---|---|---|---|---|---|---|---|
| **T7** | 5 轮编排器 `runReconciliation` | `reconciliation-orchestrator.js`(新) | T3·T4·T5·T6 | integration：全链路 R1→R5 / **R2 零回归** / R4 改 R2 命中行 / 标黄跨轮合并 / `modifiedRows+unmatchedRows=bankRows` / stats 分项；bucketScenarios 按 funcCategory/subCategory 分桶；R1→R2(dispatcher)→R3 nop→R4→R5；返回 `{modifiedRows,unmatchedRows,modifications,errorReport,stats,platformCleanupRows,rounds}` | **🔴** | 否 | ⬜ |
| **T8** | `main.js bank-statement:run` 接编排器 | `src/main.js`(改，约 L3532-3589；含 NUL，grep 须 `-a`) | T7·T1 | 网关行从 `structuredClone(database.readLinkedTableRows('gateway-bill'))` 取；`processingResult` 加 `platformCleanupRows`；**回归重点**：R2/C3 网关源由 gatewayReconSession 切链接表后，C3 场景 config 字段名与真实网关表头一致 | **🔴** | 否 | ⬜ |

### Phase 3 — 导出

| 任务号 | 标题 | 改动/新建文件 | 依赖 | 验收方式 | 🔴红线 | 前端 | 状态 |
|---|---|---|---|---|---|---|---|
| **T9** | 中台加款单剔除导出 | `platform-cleanup-writer.js`(新) + `bank-statement-io.js`(改) + `src/main.js`(改，约 L3591-3716) | T6·T8 | integration：`writePlatformCleanupOutput` 15 列+命名；writer 仿 `scenario-hit-rows-writer.js`（15 列加粗+watermark）；`buildTimestampMinuteUnderscore`(`YYYY_MM_DD_HHMM`)/`buildPlatformCleanupFileName`；export 接入：主输出成功后同目录 `path.dirname(mainFilePath)` 写剔除文件；主输出为空时落 `exportRootDir`；**graceful 失败不阻塞主流程**；return 带剔除路径供 renderer 提示 | **🔴** | 否 | ⬜ |

### Phase 4 — 场景 seed + UI

| 任务号 | 标题 | 改动/新建文件 | 依赖 | 验收方式 | 🔴红线 | 前端 | 状态 |
|---|---|---|---|---|---|---|---|
| **T10** | 场景 seed migration | `migrations.js`(改) + `database.js`(迁移序列接入) | — | 幂等 unit：跑两次只插一次 / 删除不复活 / 改名仍定位；`ensureReconRoundBuiltinScenariosSeed`（5 R4 + 2 R5，config 带 funcCategory/subCategory/roundPhase/priority∈0..3/involvedFiles，定位键 `is_builtin=1 AND category='builtin-fixed' AND config_json LIKE '%"subCategory":"X"%'`，已存在跳过不覆盖）；排在 `ensureScenariosCategoryBuiltinFixed` 之后 | 否（场景配置，建议 review） | 否 | ⬜ |
| **T11** | builtin-fixed 场景列表列改造 | `src/renderer-dialogs.js`(改) | T10 | **提 PR 前重跑 `npm run preview:*` 核对截图**；「功能类别」按 `config.funcCategory` 显示业务分组（`资金性质校验`/`中台订单数据处理`，旧名「中台订单校验」→「中台订单数据处理」）+ 新增「功能」列 + 「涉及处理文件」列（银行对账单/中台加款单剔除模板） | 否 | **✅ 是** | ⬜ |

### Phase 5 — 枚举 + 收尾

| 任务号 | 标题 | 改动/新建文件 | 依赖 | 验收方式 | 🔴红线 | 前端 | 状态 |
|---|---|---|---|---|---|---|---|
| **T12** | FundType 枚举补值 + 修错拼 | `assets/FundType枚举值.xlsx` + 一次性 migration | — | 验证 `loadFundTypeEnum` 读出新值 `Ach Return`/`HX-in`/`HX-out`；修错拼 `Ach Ruturn→Ach Return`（`InternelFundTransfer→Internal` **待定**，见 PRD §八 Q5）；一次性 migration 把存量 config 旧值迁移（评估实际引用面，低风险）；存量场景不破坏 | **🔴** | 否 | ⬜ |
| **T13** | 版本 bump + 文档三件套 + 收口 | `package.json` + `CHANGELOG.md` + `docs/VERSION_FEATURE_HISTORY.md` + `docs/USER_GUIDE.md` | T1–T12 | 版本 `2.1.16-beta.1→beta.2`；文档三件套更新；`npm run scan:vars` + `/check-vars` + `npm run release-check`（PASS/FAIL 源，须全绿） | 否（含红线 check 节点） | 否 | ⬜ |

## 并行建议

- **T3 / T4 / T5 / T6 引擎相互独立，可并行委托**（T4 依赖 T3 的 matchedGwRows 数据结构约定，可先约定接口并行起步；T5 依赖 T2 日期工具）。
- T1 / T2（Phase 0）可与 Phase 1 引擎并行起步（接口约定先行）。
- T7 编排器须等 T3–T6 引擎就绪；T8 须等 T7 + T1；T9 须等 T6 + T8。
- T10 / T11（seed + UI）相对独立，可与引擎/编排器并行；T11 依赖 T10 的 config 字段（funcCategory/involvedFiles）落地。
- T12 / T13 收尾，T13 须最后做。

## 🔴 资金红线任务汇总（实现 / 提 PR / 版本 bump / 合并前必过 `/check-vars`）

- **T4**：R4 改写 FundType（唯一允许二次改值轮次）+ 五子场景判定正确性 + 叠加链顺序。
- **T5**：R5 场景2 金额发生额绝对值匹配 + ±1day 配错会写错 ReconciliationId。
- **T6**：R5 场景3 剔除行（加款单号/附言/C~O）正确性。
- **T7**：编排器配对必须来自 R1 reconciliationid 配对；行数守恒。
- **T9**：剔除导出落位 / graceful 不阻塞主流程。
- **T12**：FundType 枚举改错拼影响存量 config。
- 均命中 `rules/important-variables.md`（scenarios / dispatcher / FundType / 对账逻辑）。

## 前端任务（需重跑 preview）

- **T11**：`renderer-dialogs.js` builtin-fixed 场景列表列改造——**提 PR 前必须重跑 `npm run preview:*`**（场景管理相关截图），核对功能类别更名 + 新增「功能」「涉及处理文件」列（memory `workflow_frontend_previews`）。

## 进度日志

- 2026-06-07：建 `v2.1.16-beta.2` 分支（已在该分支，由 team-lead 完成）；落 spec 三件套（PRD / TECH_DESIGN / TASKS）。

## 未决项（待用户答复，不阻塞已落 spec；详见 PRD §八 / TECH_DESIGN §11）

1. **Q1** R4 各子场景网关 TradeType 真实取值字符串（`AchReturn` vs `Ach Return` 等）。
2. **Q2** R4 各子场景 priority / 执行顺序（Charge→outbound 与 HX-out 同 priority 平级次序）。
3. **Q3** R4 Charge→outbound 触发条件（是否仅凭「有 R1 匹配」）。
4. **Q4** R5 场景3 附言 FundType 取值时机（R4 后当前值 vs R4 前原值）。
5. **Q5** FundType 枚举改拼口径（`InternelFundTransfer→Internal` 是否本次改）。
6. **Q6** reconciliationid 匹配大小写（是否大小写敏感）。

> 上述均 config 化可调（Q1–Q3）或低风险（Q4–Q6），已按默认值落 spec，不阻塞 T1–T13 起步；批准时可纠偏。

## 下版待测清单（用户 2026-06-07 拍板：本版未测，下版一起测）

> 背景：本版（2.1.16-beta.2）用户**仅手测了「场景管理列表 UI」**（功能类别按业务分组显示、新增内置场景呈现）。以下项本版**未做端到端 / 真实数据手测**，下版统一回归。自动化测试（unit 1731/1731 + integration 952/952 + smoke 全绿）已覆盖引擎纯函数 / 编排器契约 / 仓储 / writer / migration / 漂移守卫，但**真实网关数据 + 全链路运行导出仍需人工把关**（涉及资金红线）。

1. **5 轮对账端到端**（运行 + 导出全链路）：链接表导入网关对账单 → 预加工导入银行对账单 → 「开始运行」跑 R1→R5 → 导出银行对账单 + 中台加款单剔除文件。**本版只测了「场景管理」列表 UI**，编排器接入 `bank-statement:run` / 剔除导出接入 `bank-statement:export` 的真实运行链路未手测。核对：改写行标黄正确、行数守恒 `modifiedRows+unmatchedRows=bankRows`、剔除文件命名与落位（同目录 / 主输出为空落 `exportRootDir`）。

2. **🔴 Q1 网关 TradeType 真实取值核对**：R4/R5 子场景判定用的网关交易类型字符串目前取 seed 默认值——`AchReturn` / `WireReturn` / `HX_OUTBOUND` / `HX_INBOUND`（R4），`Inbound-VA`（R5 场景3），`FundTransfer-out` / `FundTransfer-in`（R5 场景2）。**若与真实网关对账单里的字面值不符（大小写 / 连字符 / 拼写），R4/R5 会静默不匹配**（不报错，只是不命中、不改写、不剔除）。判定条件已 config 化（存 seed `config_json`），改值不动代码——下版用真实网关数据逐子场景核对并按需改 config。

3. **C3 回归（网关源切链接表后的 config 字段大小写）**：内置 `gateway-recon-join`（C3）场景**默认禁用**，但本版已把 R2/C3 的网关数据源由 `gatewayReconSession` 切到链接表 `linked_gateway_bill`（真实小写表头）。C3 场景 config 里引用的字段名若是驼峰（`Currency` / `Amount` / `MerchantId` / `Bank` / `reconciliationId` 等）与链接表真实**小写**表头（`currency` / `amount` / `merchantid` / ...）不符，**启用 C3 后会失效（匹配不上）**。下版决定：是修 C3 场景 config 字段名、还是在读链接表时做字段名归一。

4. **「从银行对账单的信息里提取调拨订单对账ID」场景功能类别显示**：该既有 builtin-fixed 场景无 `config.funcCategory`，列表「功能类别」列回退到既有 category 标签——实测显示为「**银行对账单赋值自身**」（`renderer-dialogs.js` `FUNC_CATEGORY_LABELS` 映射不到 → `getCategoryLabel('builtin-fixed')` = `'银行对账单赋值自身'`）。下版确认这个回退显示值是否符合预期、是否要改成更贴切的分组名。

5. **Q2–Q6 默认值核对**（本版按默认落地、未经真实数据验证）：
   - **Q2** R4 五子场景 priority 平级序：Charge→outbound 与 HX-out 同为 priority 1，平级时叠加链执行先后；默认 3/2/1/1/0（config 化可调）。
   - **Q3** R4 Charge→outbound 触发条件：默认**仅凭「有 R1 匹配」**（不校验网关 TradeType），`FundType=Charge` 即改 `outbound`（config 化可调）。
   - **Q4** R5 场景3 剔除行附言 FundType 取值时机：默认取 **R4 改写后的当前 FundType**（而非 R4 前原值）。
   - **Q5** FundType 枚举改拼：本版 `Ach Ruturn → Ach Return` 已改；**`InternelFundTransfer → Internal` 本版不改**（下版评估是否改 + 存量 config 迁移）。
   - **Q6** reconciliationid 匹配大小写：默认**大小写敏感**（沿用 `normalizeCellValue` trim，不改大小写）；下版确认真实数据两侧对账ID 大小写是否一致。

6. **🚧 工作树未跟踪 / 污染文件（非本 PR 内容，待用户处置）**：dev 并行 `git stash` 操作误把以下改动灌入工作树，**不属于本 PR、不应随本 PR 提交**——
   - `assets/外汇期权表.xlsx`（未跟踪新增）
   - `docs/iterations/v2.1.12/PRD-v2.1.12.md` / `docs/iterations/v2.1.13/` / `docs/iterations/v2.1.14/` / `docs/iterations/v2.1.15/PRD-v2.1.15.md` / `docs/iterations/v2.1.16-beta.1/`（未跟踪归档目录）
   - `docs/prs/PR58-v2.1.13.md`（未跟踪事后补建归档）
   - `rules/doc-archive-policy.md`（未跟踪新增）
   - `rules/integration-test-policy.md`（已跟踪文件被改动）
   - `scripts/perf/bench-acquiring-overwrite-delete.js`（未跟踪新增，会话起始即存在）

   > 提 PR 时须只 add 本版交付相关文件（src/ 引擎 + migration + 三件套 + spec 三件套 + PR 草稿 + 重跑的 `docs/previews/scenarios-manager.png`），**不要 `git add -A`**，避免把上述污染一并提交。最终如何处置（保留 / 归档到对应分支 / 丢弃）由用户拍板。

## 实施记录（合并后回填）

> 本节为合并后回填（workflow_pr_integrate_prd）。

### v2.1.16-beta.2 交付摘要（2026-06-07）

T1 `readLinkedTableRows` 网关数据源读回 + T2 `engine-date-utils` 日期工具 + T3 R1 对账ID 1v1 匹配引擎 + T4 R4 资金性质校验引擎（5 可插拔 handler 按 priority 改 `FundType`，唯一允许二次改值轮次）+ T5 R5 场景2 FundTransfer 回填 `ReconciliationId`（发生额绝对值精确到分 + 同日/±1day）+ T6 R5 场景3 Inbound-VA 剔除行 + 模板字段常量 + T7 5 轮编排器 `runReconciliation`（R1→R2→R3→R4→R5，跨轮累积标黄，行数守恒）+ T8 `main.js bank-statement:run` 接编排器（网关源切链接表）+ T9 中台加款单剔除导出（同目录 / graceful）+ T10 场景 seed migration（5 R4 + 2 R5，幂等不覆盖）+ T11 builtin-fixed 列表「功能类别」按业务分组显示 + T12 FundType 枚举补 `Ach Return`/`HX-in`/`HX-out` + 修错拼 `Ach Ruturn→Ach Return` + T13 版本 bump（`2.1.16-beta.1→beta.2`）+ 文档三件套 + 收口；附 UI 修复（场景管理列表显示回归核对、preview 重跑）。质量门：`npm run release-check` 全绿（unit 1731 / integration 952 / smoke 全过）。⚠️ 本版用户仅手测场景管理 UI，5 轮端到端 + Q1 真实网关取值核对等见上「下版待测清单」。
