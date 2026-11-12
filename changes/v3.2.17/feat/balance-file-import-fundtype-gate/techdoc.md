# TechDoc — 补录余额「导入余额文件」与「提取调拨订单对账ID」限定 FundType

| 项目 | 内容 |
| --- | --- |
| 目标版本 | v3.2.17（暂定） |
| 功能分支 | `feat/balance-file-import-fundtype-gate`，基于正式标签 `v3.2.16`（`8e027cb8`） |
| 日期 | 2026-11-11 |
| 状态 | 已实现，待 PR 审查与 GUI 人工检查 |
| 依据 | [spec.md](spec.md) D1–D5 |
| 格式来源 | `changes/v3.2.16/feat/statement-balance-verification/techdoc.md`（按本任务规模精简） |

## 一、技术决策

| 编号 | 决策 | 理由 |
| --- | --- | --- |
| T1 | 确认后由渲染层逐个账号沿用 `file:save-balance-seed`（`{billDate, endBalance}`），不新增批量写入 | 单条写种子绑定了 plan / freshness / 覆盖确认与 `manual-balance-seed-settlement.js` 的恢复契约（`plan.record` 单条）；批量写会改恢复绑定。代价是每个账号重算一次，保存期间显示进度 |
| T2 | 补录请求带 `merchantId` / `currency` / `templateName`（渲染层 `manualBalanceAccountBinding`，手工【完成】与连续保存都带）：带了就必须与 `pendingPrompt` 一致，否则 `prepareManualBalanceSeedSubmission` 返回 `manual-balance-invalid` + `errorCode: BALANCE_SEED_ACCOUNT_CHANGED` 并带回当前提示、不生成写入计划；渲染层据此按当前提示重开且不带草稿；不带字段的旧请求行为不变 | 种子账号与银行始终取自主进程 `lastManualBalancePrompt`，载荷只给日期与金额；渲染层与主进程提示错位（IPC 异常、返回旧表单、跨分组）时会把余额写到别的账号或银行。核对向后兼容；拒绝时带回提示，状态框与弹窗都能按当前账号继续 |
| T3 | 待补录清单：`scanBalanceSeedStatus` 增 `missingAccounts`（排序同 `deriveBalanceRecords` 分组：merchantId、currency，`zh-Hans-CN`）；缺种子 prompt 增 `pendingAccounts`（生产路径 `statement-generation.js` 与 worker 副本 `statement-generation-business.js` 共用 `pendingBalanceSeedAccounts`） | 主进程原本只给当前一个账号；清单随 prompt 存入 `lastManualBalancePrompt`，导入时以主进程持有的清单为准，不信任渲染层 |
| T4 | 解析与匹配为纯模块 `src/backend/balance-seed-import.js`：`parseBalanceSeedImportRows(rows)`、`matchBalanceSeedImport(records, pendingAccounts)`；读文件用 `readRows` | 便于单测；与 IPC、DOM 解耦 |
| T5 | IPC `file:import-balance-seed-file` 为 `ipcMain.handle`，任务策略登记为 exclude · `staging-preflight-only`；导入选择框 scope `balance-seed-file` | **偏离计划**：计划写的是照 `big-account:import-bank-info` 建 File Task（businessIpcHandle + eager filePlan）。实现时核实该入口只读、不写文件或状态、结果仅供确认，与 v3.2.16 账户管理 `bank-accounts:prepare-import`（staging-preflight-only）同类；建 File Task 会把一次预览登记进归档与恢复链路，改动面（基线 fixture、恢复登记）更大而无收益。真正的写入仍在 `file:save-balance-seed` 的 File Task 内 |
| T6 | 导入只在普通缺种子 prompt 可用（无 `reason`、无 `seedMismatch`、`pendingAccounts` 非空）；主进程与渲染层各判断一次 | 断档、核对、确认类提示的补录语义不同 |
| T7 | 渲染层：`createManualBalanceSeedDialog` 内两个容器 `[data-view="manual"]` / `[data-view="confirm"]` 切换 `hidden`（同 `template-files.js` 的 setView），标题与卡片宽度随视图切换；`handleSaveResult` 的草稿改为调用方传入；覆盖确认抽成 `handleSubmitResult`；`runExclusive` 统一保存 / 导入 / 连续保存期间的锁（`registerModal canClose`）；连续保存记住最近确认的提示（`chainPrompt`），中途 IPC 异常后再点【确认】从那里接着保存 | 【返回】保留手工草稿；连续保存的停止结果直接交回原有处理，不复制分支逻辑 |
| T9 | Codex 审查（2026-11-11）后加固：连续保存只在本弹窗分组（`templateName`）内继续；`savedAccountKeys` 跨重试保留、仅在保存成功后记入；部分保存后【返回】按 `chainPrompt` 重建弹窗；数字型银行账号需显示文本与原值一致（`readBalanceSeedImportFile` 另取同一工作表的显示文本，拿不到或行数不符即不采用）；预填余额用普通小数（指数写法改为 12 位小数）；第二轮审查（P2）：`readBalanceSeedImportFile` 同时返回工作簿日期系统 `date1904`，数字型账单日期按 1904 系统加 1462 天换算，读不出日期系统（`null`）时数字日期不采用；第三轮审查（P2）：没有工作簿元数据（CSV，无 `WBProps`）时 `date1904` 为 `null`；第四轮审查（P2）：日期系统改由共享解析器处理——`normalizeDateExportValue` / `parseDateValue` 新增可选 `excelDateSystem`（`'1900'` 默认即原行为 / `'1904'` / `'unknown'`），只作用于原有两个序列号分支（数字单元格；去掉时间后缀后的纯数字文本且 365 < 值 < 200000），导入按 `date1904` 传入，不再另写一套序列号判断；部分保存后已保存行标「已保存」并只读，解锁只恢复未保存行 | 第一轮指出 3 个余额归属错误路径（P1）与 2 个可用性问题（P2）；第二轮核实已修复并指出 1904 日期系统下会把未来余额当作历史余额（P2）；第三轮指出文本序列号与 CSV 绕过日期系统判断（P2）；第四轮指出时间后缀与文本范围未对齐解析器（P2）、已保存行可编辑但修改被静默忽略（P2）；均已补回归 |
| T8 | 「提取调拨订单对账ID」门控写在引擎：`runC1Scenario(scenario, bankRows, { rowGate })`，`scenario-engines/index.js` 的 `builtin-fixed` 分支传入 `builtinExtractRowGate`（`valuesEqual(Channel,'DBS') \|\| FundType ∈ CANONICAL_FUND_TRANSFER_DIRECTIONS[].bankFundType`） | 场景 12 个条件共用一个 OR 开关，FundType 作第 13 个条件只会放宽；自带写死场景 UI 不展示、不编辑条件，写在引擎不需要迁移（同 v3.0.23 R4 先例）；`extract-recon-id`（用户自建）分支不传门控 |

## 二、改动文件

| 文件 | 改动 |
| --- | --- |
| `src/backend/balance-seed-import.js` | 新增：余额文件解析与按账号匹配 |
| `src/backend/file-service/normalizers.js` | `normalizeDateExportValue` / `parseDateValue` 可选 `excelDateSystem`（默认行为不变） |
| `src/main-process/statement-generation-business.js` | `scanBalanceSeedStatus` 返回 `missingAccounts`；worker 副本 prompt 带 `pendingAccounts` |
| `src/main-process/statement-generation.js` | `pendingBalanceSeedAccounts`；生产 prompt 带 `pendingAccounts` |
| `src/main-process/manual-balance-seed-preflight.js` | 请求账号核对（T2） |
| `src/main.js` | `file:import-balance-seed-file` |
| `src/preload.js` | `files.importBalanceSeedFile` |
| `src/main-process/import-dialog-state.js` | scope `balance-seed-file` |
| `src/main-process/execution-descriptors/legacy-task-policies.js`、`src/main-process/archive-center/task-policy-registry.js` | exclude · staging-preflight-only 登记 |
| `architecture/boundaries.json` | `renderer-dialog-configuration`、`renderer-statement` 的 `allowedApiFields.api` 增 `files.importBalanceSeedFile` 及对应 `policyChanges`（statement 控制器持有整个 files 命名空间而可达，不调用） |
| `src/renderer/dialogs/configuration.js` | 补录弹窗导入按钮、余额确认视图、连续保存 |
| `src/styles-gemini-extra.css` | 左右页脚内边距、确认视图与表格样式 |
| `src/renderer-previews.js` | 补录预览带 `pendingAccounts`（显示导入按钮） |
| `src/main-process/scenario-engines/c1-extract-recon-id.js`、`index.js` | `rowGate` 与自带场景门控（T8） |
| `rules/important-variables.md` | `conditionsLogic` 条目补门控说明 |

## 三、测试

| 层 | 入口 | 覆盖 |
| --- | --- | --- |
| 单测 | `tests/unit/backend/balance-seed-import.test.js` | 表头定位（首行 / 标题行后 / 列序不同）、缺列、无效行跳过、数字型账号（截断、补零显示、无显示文本）跳过、真实 xlsx 零填充格式、1900 / 1904 日期系统的数字日期与文本序列号、xls 与 CSV 的日期系统、未知日期系统、最近一天、排除当日及之后、同日同额与多额、币种大小写、0 余额、顺序 |
| 单测 | `tests/unit/backend/file-service/normalizers.test.js` | `excelDateSystem`：默认不变；1904 数字与带时间后缀的文本序列号；unknown 下序列号不解析、日历写法与范围外值不变 |
| 单测 | `tests/unit/main-process/statement-balance-gap.test.js` | `missingAccounts` 排序与排除已有种子；请求账号核对拒绝 / 放行 / 不带账号 |
| 单测 | `statement-balance-verify.test.js`、`statement-legacy-golden-e09-p0.test.js` | prompt 形状同步 `pendingAccounts` |
| 单测 | `c1-extract-recon-id.test.js`、`scenario-dispatcher-builtin-fixed.test.js` | `rowGate` 行为与默认不变；门控真值表（含相近写法、DBS、dbs 小写）；被挡行留给后续场景、行数守恒；用户自建场景不受影响；既有用例行补 `FundType` |
| 单测 | `archive-task-policy-registry.test.js`、`execution-descriptor-archive-baseline.test.js` | 新 exclude 通道计数与基线后新增清单 |
| Renderer 生命周期 | `scripts/renderer-lifecycle/fixtures/configuration-dialogs.js` | 按钮出现条件、导入 → 确认视图、返回保留草稿、标红校验、连续保存带账号与锁定、遇清单外 / 校验失败停下、中途 IPC 异常后重试接续、部分保存后返回重建当前账号、重试不重提已保存账号且跨分组停下、已保存行只读、账号已变化按当前提示重开、小额余额预填、导入失败提示、150% 缩放布局 |
| 集成 | `scripts/integration/statement-balance-file-import.js` | 真实 xlsx：生成层清单 → 余额文件解析匹配 → 逐个补录（含错位拒绝）→ 余额回读与人工种子落盘 |
| 集成 | `scripts/integration/bank-statement-builtin-extract-fundtype-gate.js` | 真实 seed 与迁移 + 编排器：非 DBS 只认调拨 FundType；DBS 不受限且 R3.5 归组不变；行数守恒 |

## 四、兼容与回滚

- prompt 新增字段 `pendingAccounts`，旧渲染层忽略；没有该字段时不显示导入按钮。
- 补录请求新增可选字段，不带时与原行为一致。
- 场景门控不涉及数据库与迁移；回滚只需撤回引擎改动。
- 未接入的 statement-worker 合同（`MANUAL_BALANCE_PROMPT_KEYS`）不含 `pendingAccounts`（同 v3.2.16 `seedMismatch`），接入时需一并处理。
