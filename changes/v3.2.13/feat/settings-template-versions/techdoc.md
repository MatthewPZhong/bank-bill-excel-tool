# TechDoc — 设置 · 模板文件（后端阶段：用户版本管理）

| 项目 | 内容 |
| --- | --- |
| 目标版本 | v3.2.13（待合入 `release/v3.2.13`） |
| 功能分支 | `feat/settings-template-versions`，基于正式标签 `v3.2.12`（`0f890fb2`） |
| 日期 | 2026-10-20 |
| 状态 | 已实现，本地验证见第七节；未提交、未合入 release |
| 依据 | `changes/v3.2.12/feat/settings-template-files/techdoc.md` §3.2「后端阶段待实现」与 R1；用户 2026-10-19 确认的决策（见第二节） |
| 格式来源 | `changes/v3.2.12/feat/settings-template-files/techdoc.md` 的章节组织 |

## 一、目标与范围

v3.2.12 的「设置 → 模板文件」页只接了只读查询与另存为，导入新版本等入口按能力置灰。本分支补齐后端阶段：

- 7 个可替换模板可以导入新版本（选择文件 → 预检 → 仅保存 / 保存并启用）、启用、恢复默认、删除版本，并有变更记录与变更通知。
- 各使用模块的新任务读取当前版本，运行中的任务不切换（techdoc v3.2.12 R1：后端阶段与“模块改读当前版本”同时上线）。

| 资源 | 运行时读取方 | 替换后生效的内容 |
| --- | --- | --- |
| `prefund-unbalanced` 资金对账导出不平 | 前置资金对账导出 | 5 张基础 Sheet 的样式 |
| `dup-recall-mail` 重复入金召回邮件模板 | 重复入金匹配导出 | 「邮件模板」表头与数据行样式 |
| `position-bank` 平盘银行对账单 | 平盘对账导出 | 「渠道对账单」样式 |
| `bank-statement` 银行对账单 | 仅重复入金匹配导出（其他模块只作导入结构参考，导入识别用代码常量） | 「匹配不成功需人工判定」样式 |
| `fund-type-enum` FundType枚举值 | 场景配置 C2 | FundType 下拉取值 |
| `gateway-recon` 网关对账单 | 场景配置 C3 | 网关账单字段下拉 |
| `vcc-pending-calc` VCC 移除归档Pending发生额计算表 | VCC 财务OP 结果导出（worker_threads） | 仅第 1、2 行样式与行高、A–K 列隐藏；表头文字、列宽、冻结、筛选、打印设置由代码固定 |

不包含：VCC 结果模板（SHA-256 锁定，需随应用版本更新）、程序生成 / 结构样例 / 未启用 / 示例参考类文件；发布文档（CHANGELOG 等）在发版时统一更新。

## 二、已确认决策

| 编号 | 决策 | 说明 |
| --- | --- | --- |
| D1 | 不兼容处理＝保留并报错 | 升级后已启用的用户版本不再满足代码契约（或文件缺失、被改动）时，仍保留为当前版本；模板页标「不兼容」并给出原因，相关导出中止并提示“请在 设置 → 模板文件 恢复默认或重新导入”。不自动切回内置，避免输出样式在用户不知情时变化。 |
| D2 | 存放位置＝userData | 版本文件 `{userData}/template-resources/<resourceId>/<versionId>.xlsx`；元数据、当前版本指针、变更记录在主 SQLite。 |
| D3 | 纳入 VCC Pending 计算表 | 用户 2026-10-19 要求纳入；结果模板仍锁定。 |

## 三、文件清单

| 文件 | 内容 |
| --- | --- |
| `src/backend/database/migrations.js` | `ensureTemplateResourceVersionSupport`：`template_resource_versions`、`template_resource_state`、`template_resource_changes` 三张新表，幂等 `CREATE TABLE IF NOT EXISTS` |
| `src/backend/database/template-resource-repository.js` | 版本行、当前指针、变更记录的事务读写；冲突在事务内判定并整体回滚 |
| `src/backend/database.js` | 启动时建表；门面 `listTemplateResourceVersions/States/Changes`、`commit/setCurrent/deleteTemplateResourceVersion`、`appendTemplateResourceChange`、`listScenarioConfigs` |
| `src/backend/database/scenarios-repository.js` | `listScenarioConfigs`：只读取全部场景配置，供预检找出仍被引用的取值 |
| `src/main-process/template-resources/contracts.js` | 7 个模板的导入契约、场景引用收集、使用方检查与结论 |
| `src/main-process/template-resources/service.js` | 版本合并视图、兼容复核、租约 `acquire/source`、`resolveCurrentFile`、导入（`rememberPickedFile/prepareImport/discardImport/commitImport`）、`setCurrentVersion`、`deleteVersion`、`listChanges`、孤儿清扫 |
| `src/main-process/template-resources/catalog.js` | `vcc-pending-calc` 改为可替换；头注释同步 |
| `src/main-process/{pre-fund-reconciliation,duplicate-inbound-match,position-reconciliation}/service.js` | 构造参数新增模板来源；导出时取租约、`finally` 释放；未注入时沿用原固定路径 |
| `src/main-process/duplicate-inbound-match/excel-writer.js`、`position-reconciliation/excel-io.js` | 抽出 `validateMailTemplateWorkbook`、`validateBankTemplateWorkbook`、`validateResultTemplateWorkbook`，写出与预检共用；平盘 `writeResultWorkbook` 写出前截断模板数据区（ExcelJS 4.4 `spliceRows` 删除末尾多行无效），先取消数据区合并单元格，再核对只剩表头；写入后按 `output-sheet-ranges.js` 调整筛选与打印区域 |
| `src/main-process/output-sheet-ranges.js`、`pre-fund-reconciliation/excel-writer.js` | 新增输出范围调整：模板的筛选与单个打印区域首行固定为表头行、末行为最后一行结果（零结果为表头行），列范围不变；多个打印区域保持原样（预检已拒绝）。平盘结果与资金对账各 Sheet（流式写出，在 commit 前设置）共用 |
| `src/constants/fund-type-enum.js`、`gateway-recon-headers-loader.js`、新增 `sheetjs-sparse-cells.js` | 抽出 `parseFundTypeEnumWorkbook`、`parseGatewayReconHeadersWorkbook`，loader 与预检共用；改为只读实际存在的单元格（取值口径同 `sheet_to_json({header:1, defval:''})`），声明范围再大也不逐格展开 |
| `src/backend/xlsx/zip-reader.js` | `openZipWithEntries` 包装打开与解析错误时保留原始错误（`cause`），供调用方区分运行环境错误 |
| `src/main-process/vcc-financial-op-service.js`、`-result-workbook-runner.js`、`-result-workbook-writer.js` | Pending 模板由 Main 读出字节交给 Worker；Writer 核对 SHA-256 后 `xlsx.load`；新增 `probePendingTemplate` 供预检，试写后临时目录清理失败不覆盖结论 |
| `src/main.js` | 服务装配（主库、日志、变更广播）、7 个新 IPC、枚举 IPC 读当前版本、各模块注入来源、managed 路径守卫 |
| `src/main-process/import-dialog-state.js` | 新增导入目录记忆 scope `template-resources` |
| `src/main-process/archive-center/task-policy-registry.js`、`execution-descriptors/legacy-task-policies.js` | 新通道分类登记 |
| `src/preload.js` | `templateResources` 新增 7 个 invoke 方法与 `onChanged` |
| `src/renderer/dialogs/template-files.js`、`src/styles-gemini-extra.css` | 当前版本不兼容时列表标签显示「Vn · 不兼容」（危险色，悬停显示原因）与详情顶部提示；版本行「不兼容」状态与原因；不兼容版本不能启用。复核未完成（`unverified`）单独显示「暂不可用」（警示色），提示稍后重试，仍可点启用重试 |
| `src/renderer/dialogs/scenarios.js` | C2/C3 配置弹窗每次打开时重新拉取枚举（保留旧值供首帧渲染） |
| `architecture/boundaries.json` | `renderer-dialog-template-files.allowedApiFields.api` 新增 8 个方法，登记 policyChanges |

## 四、接口契约

### 4.1 IPC 与分类

| 方法 | IPC | 分类 | 返回 |
| --- | --- | --- | --- |
| `list()` / `get(id)` | `template-resources:list` / `:get` | exclude / read-only-query | 同 v3.2.12，另带用户版本（见 4.2） |
| `saveAs({resourceId, versionId})` | `template-resources:save-as` | support-action / user-document-export | 支持用户版本；默认文件名为该版本导入时的原文件名 |
| `pickImportFile()` | `template-resources:pick-import-file` | exclude / file-picker-only | `{ status: 'success', filePath, fileName, size }` 或 `cancelled`；经 `showImportOpenDialog('template-resources')`，只允许 .xlsx |
| `prepareImport({resourceId, filePath})` | `template-resources:prepare-import` | exclude / staging-preflight-only | `{ status, importToken, expectedVersionId, expectedVersionLabel, expectedVersionSource, file{name,size,sha256}, verdict, checks[], diff{added,removed} }` |
| `discardImport(token)` | `template-resources:discard-import` | exclude / staging-preflight-only | `{ status: 'success' }`，可重复调用 |
| `commitImport({importToken, enable})` | `template-resources:commit-import` | support-action / template-resource-version | `{ status: 'success', enabled, version }`、`conflict` 或 `failed` |
| `setCurrentVersion({resourceId, versionId, expectedVersionId})` | `template-resources:set-current-version` | support-action / template-resource-version | `success`、`conflict`、`failed`（版本不存在或不可用） |
| `deleteVersion({resourceId, versionId})` | `template-resources:delete-version` | support-action / template-resource-version | 内置、当前、被任务持有的版本拒绝 |
| `listChanges()` | `template-resources:list-changes` | exclude / read-only-query | 最近 200 条 `{ at, resourceId, resourceName, action, from, to, result, detail }` |
| `onChanged(listener)` | 事件 `template-resources:changed` | — | 返回退订函数；Main 在每次变更成功后向所有窗口广播 `{ resourceId }` |

写操作走 `supportIpcHandle`，获得安装 / 关闭时的忙碌拦截。

### 4.2 版本与能力

- 版本号：内置固定 `v1`/V1，不入库；用户版本 `v{n}`，n 从 2 起由 `next_version_no` 递增，删除后不复用。没有 state 行即当前为内置。
- 用户版本字段：`id, label, source: 'user', current, fileName, size, appVersion, sha256, createdAt（本机时间 YYYY-MM-DD HH:mm）, location, validation(passed|warning|failed), validationMessage, sheets, enumValues, tasks`。`versions` 按新→旧排列，内置在最后。
- `capabilities`：`importVersion/setCurrent/deleteVersion` 为“可替换且已接入存储”；`restoreDefault` 另需当前不是内置；`saveAs` 在当前用户版本文件缺失时为 false。未接入存储（单测、夹具）时原因为「版本存储不可用」。

### 4.3 导入流程与一致性

1. `pickImportFile` 记下所选路径；`prepareImport` 只接受本会话选过的路径，Renderer 不能借此读取任意文件。
2. 预检读入不超过 20 MB 的文件，字节暂存内存（令牌 30 分钟过期，最多 4 份，新预检淘汰最早一份），不落临时文件。
3. 提交时按预检记下的当前版本比对，变化则返回 `conflict`、要求重新校验；`verdict=fail` 或已有相同 SHA 的版本时拒绝。
4. 写入顺序：先以 `writeFileAtomicDurable`（临时文件 + fsync + rename）写版本文件，再在一个事务内写版本行、当前指针与变更记录；写库失败删除文件并记一条失败变更。删除顺序相反：先删库，再删文件；删文件失败只记日志。
5. 服务首次使用时清扫已知模板目录下库中无记录的 `v\d+.xlsx` 与写入残留，其他文件不动。
6. 变更操作在服务内串行执行。

### 4.4 兼容复核与租约

- 用户版本在 `list/get/acquire/setCurrentVersion` 时复核：文件存在、SHA-256 与记录一致、按当前代码契约检查（按资源与内容哈希缓存）。任一不满足即 `validation: 'failed'`（D1）。
- 复核或预检中途遇到运行环境错误（Node 系统错误，带 `syscall`，如临时目录不可写、ENOSPC、EMFILE、文件被占用；被读取层包装时沿 `cause` 与 `AggregateError.errors` 查找）时，该检查判 fail 但标为 transient：提示“兼容复核未完成…请稍后重试”，结果不缓存，下次复核重新执行；版本 DTO 的 `validation` 为 `unverified`（区别于不兼容的 `failed`），`acquire` 此时只提示稍后重试，不引导恢复默认或重新导入。VCC 试写结束后清理临时目录失败只留下系统临时目录残留，不改变试写结论。
- 版本文件打不开时：确认不存在或不是普通文件（ENOENT、ENOTDIR、EISDIR，或 stat 显示为目录等）为“版本文件缺失”（`failed`）；权限、占用、句柄耗尽等其他读盘错误同样按运行环境问题处理（`unverified`，提示稍后重试，不缓存）。
- `acquire(resourceId, {moduleId, label, withBytes})`：读出当前版本后、任何等待之前先登记租约，复核失败时释放；内置返回随包路径；用户版本复核不通过抛 `TemplateResourceUnavailableError`（code `template-resource-unavailable`），提示指向设置页。使用用户版本时写一条活动日志（模板、版本、SHA 前 12 位）。返回的租约在 `release()` 前保护该版本不被删除（包括复核进行期间），并在「版本 / 使用方」中显示为任务使用中。
- `source(resourceId, moduleId)` 只向模块暴露 `acquire`。

## 五、预检契约（`contracts.js`）

公共检查：扩展名为 .xlsx、大小、可读；与已有版本内容相同时判 fail（区分“与当前版本相同”和“与 Vn 相同，可直接启用”）；按 binding 输出使用方检查（不读取的绑定显示“不受影响”）。

| 资源 | 判定（fail 阻止导入，warn 需确认） |
| --- | --- |
| `prefund-unbalanced` | ExcelJS 读入后调用写出端 `validateTemplateWorkbook`：5 个 Sheet 名称与顺序、每个 Sheet 表头逐列一致且无多余表头；任一 Sheet 有多个打印区域 fail（筛选与单个打印区域在写出时随各 Sheet 行数调整） |
| `dup-recall-mail` | `validateMailTemplateWorkbook`：只有 1 个 Sheet、前 10 列表头一致；右侧多余表头 warn（不写入导出） |
| `bank-statement` | `validateBankTemplateWorkbook`：含「渠道对账单」、前 46 列一致；多余表头 warn |
| `position-bank` | `validateResultTemplateWorkbook`：含「渠道对账单」、前 49 列一致；另外两种情况判 fail：内置之外的 Sheet（整本模板会写进输出），以及多余非空表头（结果回读要求恰好 49 列）；第 2 行起有内容时 warn（如把旧结果当模板导入，写出时清空，不进入结果）；含 Excel 表（Table）fail（结果行数变化后范围无法安全调整，需转为普通区域）；含数据验证或条件格式 warn（按原范围带入结果）；多个打印区域 fail。筛选与单个打印区域在写出时随结果行数调整 |
| `fund-type-enum` | 与运行时同口径解析；无取值 fail；与当前版本 diff；移除已保存场景引用的值（任意 `{field:'FundType', value}`）fail |
| `gateway-recon` | 与运行时同口径解析；缺少 `GATEWAY_RECON_SIGNATURE.signatureHeaders` 任一项 fail；含 `__CUSTOM__` warn（已忽略）；移除 C3 场景引用的字段（`reconFields[].gwField`、`conditions[side=网关].field`、`assign.gwField`，自取值除外）fail |
| `vcc-pending-calc` | 需有第 1 个 Sheet；第 1、2 行行高不超过 409.5；用正式导出的流式 Writer 与 `validateResultWorkbook` 试写一个 Pending Sheet（`probePendingTemplate`），写不出或校验不过 fail；附一条生效范围说明 |

另有两类提示（warn，不阻止导入）：

- 资金对账、平盘、VCC Pending：契约列被设为隐藏，或列 / 第 2 行的数字格式会遮盖、替换显示内容（前三段全空，或第 4 段不含 `@`）。金额等数据在这三处输出中仍是原值（资金对账、平盘写文本；VCC 金额列格式由程序固定），风险只在人工核对时看不到或看错。
- FundType：新增取值与当前取值仅大小写或空格不同（下游规则按原值匹配，多半是笔误）。

已存版本的兼容复核只跑契约检查（不含场景引用与重复版本检查）。

结构描述（各 Sheet 表头、数据行数、枚举取值）与 FundType / 网关表头解析只遍历实际存在的单元格，数据行数按行区间求并集计算：`<dimension>` 声明或一个零散单元格覆盖整张表（如 `XFD1048576`）的小文件，不会让主进程按整张表展开。结构描述失败时预检判 fail，不发放可提交的暂存。

以 ExcelJS 读入的模板（资金对账、重复入金、银行对账单、平盘、VCC Pending），读入前先用 `jszip` + `sax` 流式扫描各工作表 XML：ExcelJS 4.4 读入时把数据验证（`sqref`）与合并单元格（`ref`）逐格展开，二者合计覆盖超过 1048576 个单元格时预检判 fail（“表格范围”），不再读入；扫描失败同样判 fail。同一次扫描从 `xl/workbook.xml` 读取原始打印区域定义（Excel 可在一个定义中用逗号写多个区域，ExcelJS 读入后只保留第一个），供资金对账与平盘判断是否只有一个打印区域。已存版本复核走同一契约，导出时读入的模板都已通过该上限。

FundType 的取值（含展示用的 `enumValues`）与运行时 loader 同口径（声明范围首列、跳过首行）。导入时按运行时口径解析的取值另存为版本记录的 `structure.comparableValues` 快照（内容由 SHA-256 锁定）。预检中新增 / 移除与场景引用保护的比较基准：内置版本解析随包文件；用户版本取快照；早期记录没有快照时，核对 SHA-256 后重新解析版本文件。都取不到可信取值（文件被改动、缺失或读不出）时提示“比较基准”warn，并假定场景引用的值都在当前版本中，新版本缺少其中任何一个都判 fail。

## 六、模块接入

| 模块 | 接入点 | 说明 |
| --- | --- | --- |
| 前置资金对账 | `export()` 在冲突检查后、备份已有文件前取租约，拆出 `_writeExport` | 模板不可用时不改动用户已有文件 |
| 重复入金匹配 | `export()` 依次取邮件模板与银行对账单租约 | 任一失败或写出失败都释放已取的租约 |
| 平盘对账 | `exportBank`、`exportRun` 经 `_writeResultWorkbook` 取租约 | — |
| VCC 财务OP | `exportRun` 在状态复核后 `acquire({withBytes: true})`，字节、SHA、版本号进 `workerData.pendingTemplate`，Writer 返回后释放 | Writer 核对 SHA 再 `xlsx.load`，写出与校验共用同一模板对象；缺省时仍读 `assetsDir`。导出完成后归档、恢复、复核都不再读模板，版本只需在导出期间保留 |
| 场景配置 | `scenarios:fund-type-enum`、`scenarios:gateway-recon-headers` 改为 async，读当前版本路径（loader 按路径缓存，新版本自然不命中旧缓存）；用户版本不可用时按原降级（空列表 / 旧字段） | Renderer 弹窗每次打开时刷新，实现“下次打开场景配置生效” |

## 七、已知限制与偏离

| 编号 | 内容 | 处理 |
| --- | --- | --- |
| L1 | 资金对账、平盘的 managed（后台 Worker）只读导出在生产中未启用（`production.enabled: false`），仍按 `service.templatePath` 读内置模板 | 偏离原计划“按准备时的当前版本解析”：改为启用了用户版本时在准备阶段拒绝（`assertManagedExportUsesBuiltinTemplate`），不静默改用内置模板。启用 managed 路径前须把版本路径与证据接入，已登记 `knowledge/backlog.md` B31（编号接续 `release/v3.2.13` 的 B30） |
| L2 | VCC managed 导出（`writer-core / dispatch / artifact-evidence`）在生产中未接线，仍读 `assetsDir` 内置 Pending 模板 | 接线时须携带 Pending 模板版本并让 `validateJoin` 使用同一版本，同登记于 B31 |
| L3 | 预检引用检查基于提交前的场景配置快照；预检与提交之间新增的场景引用不会再次检查 | 场景下拉只提供当前版本取值，新引用只会是当前版本已有的值；风险低，未额外处理 |
| L4 | 枚举类模板的当前用户版本不可用时，场景配置沿用原降级（FundType 空列表、网关旧字段），弹窗不单独提示原因 | 原因显示在模板页 |

## 八、架构与策略登记

- 新增 4 个 exclude（`pick-import-file` file-picker-only、`prepare-import`/`discard-import` staging-preflight-only、`list-changes` read-only-query）与 3 个 support action（reason `template-resource-version`）；IPC 总数 276 → 283，exclude 138 → 142，support 4 → 7。固定基线 fixture 不改，新增项在基线测试的显式清单中比对。
- `renderer-dialog-template-files.allowedApiFields.api` 由 3 个方法扩为 11 个，按 policyChanges 记录：来源提交 `0f890fb2`（v3.2.12），来源 blob `77bb6897`。合入 `release/v3.2.13` 时若 release 侧之后的提交仍持有原值，按 v3.2.12 先例以合并前 release 末端补登同一变更，release → main 仍须 merge commit。

## 九、测试与验收

| 层 | 入口 | 覆盖 |
| --- | --- | --- |
| Unit | `tests/unit/main-process/template-resources-versions.test.js` | 预检与仅保存、启用/租约/冲突/恢复默认/删除、版本号不复用、预检期间版本变化冲突、重复内容、令牌过期与上限、7 类输出契约的 fail/warn、枚举与网关的场景引用、文件篡改与缺失、升级后契约变化（D1）、复核期间租约拦截删除、环境性失败（含读取层包装的系统错误）不缓存且恢复后重新复核、试写清理失败不覆盖结论、声明范围覆盖整张表的小文件、声明范围不从 A1 开始时的比较基准与场景引用保护、比较基准不信任被改动或读不出的当前文件（快照、SHA 核对后重新解析、按场景引用逐项核对）、版本文件读盘错误按暂不可用处理、版本路径被目录替代判为缺失、数据验证或合并单元格范围超限在读入前拒绝、多个打印区域（Excel 逗号写法与多个定义）拒绝、平盘模板数据区提示、Excel 表拒绝与数据验证 / 条件格式提示、孤儿清扫与重建后状态保持、写库失败回滚 |
| Unit | `tests/unit/main-process/position-reconciliation-excel-io.test.js` | 模板数据区的旧行（含金额）、合并单元格与仅有样式的行在写出前全部清空，回读只含本次数据；筛选与打印区域按结果行数调整（5 行、0 行），筛选起点不在第 1 行时首行归为表头，多个打印区域保持原样，内置模板不新增 |
| Unit | `tests/unit/main-process/pre-fund-reconciliation-excel-writer.test.js` | 新增：模板的筛选与打印区域按各 Sheet 本次行数调整（含筛选起点不在第 1 行、零数据 Sheet），未设置时不新增 |
| Unit | `tests/unit/backend/database/template-resource-repository.test.js` | 建表幂等、事务内更新、冲突与 CHECK 失败整体回滚 |
| Unit | `tests/unit/main-process/template-resources-consumers.test.js` | 三个输出服务取/放租约；模板不可用时不改动已有文件、不写出 |
| Unit | `template-resources-service.test.js`、`template-resources-ipc.test.js` | 可替换范围固定 7 个；未接存储时能力关闭；preload 与 Main 通道一一对应，导入经选择框、广播与变更记录 |
| Unit | `vcc-financial-op-result-workbook.test.js`、`vcc-financial-op-result-export-service.test.js` | 传入版本字节按该样式写出并通过正式校验；SHA 不符拒绝；服务取租约、交字节、结束释放，模板不可用时不启动 Writer |
| Unit | IPC 清单与基线测试 | 通道数量与分类 |
| Integration | `scripts/integration/template-resources-versions.js` | 真实主库迁移 + 真实 writer：导入并启用后经资金对账、重复入金、平盘、VCC 结果 Worker 导出，输出采用用户版本样式且表头/数据不变；恢复默认；不兼容版本报指引错误；重建服务后状态保持 |
| Renderer 生命周期 | `scripts/renderer-lifecycle/fixtures/template-files.js` | 新增「不兼容」状态：列表标签（浅色与深色下为危险色）、版本行、不能启用、顶部提示；「暂不可用」状态：警示色标签、稍后重试提示、仍可点启用 |

人工检查：真实应用中 设置 → 模板文件 完成导入、启用、导出核对、恢复默认、删除，并查看变更记录。

### 9.1 本分支验证结果（2026-10-20，macOS 本机）

- 逐项执行 `release-check` 包含的全部检查，均通过（未用 `npm run release-check` 一次性串跑）：
  - `npm run lint` 通过，无告警
  - `npm run check:architecture` 通过，对比 `0f890fb2`，policyChanges 历史校验通过
  - `npm run smoke` 通过
  - `npm run test:unit`：9654/9658，0 失败，4 项为既有条件跳过
  - `npm run test:integration`：86/86 脚本通过（含新增 `template-resources-versions.js` 6/6、`template-resources-save-as.js` 7/7）
- 首轮全量集成中 `position-startup-task-recovery.js` 失败（`getTemplateResourceService is not defined`）：其 harness 在 `Function` 中执行 Main 的 `getPositionReconciliationService`，未提供新依赖。已在 `tests/helpers/position-startup-recovery-harness.js` 注入空来源替身，复跑后全量通过。
- 全量单测之后又调整了 `contracts.js`（隐藏列、遮盖格式、相近取值提示），受影响的模板单测（34 项）已复跑通过，lint 与架构检查也已复跑。
- Renderer 生命周期 `template-files` 16/16 通过，含「不兼容」用例（列表标签、版本行、顶部提示；浅色与深色），以及 1080×760 浅色、深色和 150% 缩放的无横向溢出检查。
- 对账专项（`reconciliation-blindspot-pass`）：资金对账、平盘输出的金额为文本，数字格式不改变取值；VCC 金额列格式由程序固定。隐藏列、遮盖格式与 FundType 相近取值已加预检提示，结论见第五节。
- Windows 实机 GUI 检查未做，仍挂 backlog B26。

### 9.2 真实应用走查（2026-10-20，macOS 本机）

启动方式：`electron .`，用 `APP_USER_DATA_DIR` / `APP_DOCUMENTS_DIR` 指向临时目录，不触及本机真实数据。`NODE_OPTIONS=--require` 加载走查钩子，钩子只做两件事：

- 打开 / 保存对话框返回预设路径（沿用 v3.2.12 复现 harness 的做法），并记录每次调用；
- 固定 `os.freemem` 为 6 GiB。本机 `os.freemem` 只计完全空闲页，未固定时业务 OP 升级预检读到 244 MiB 并阻止启动，与 v3.2.12 发布记录是同一个既有问题。

界面经远程调试协议在真实 DOM 上点击、读取并截图。重复入金的导入、运行、导出经 `window.desktopApi` 调真实 IPC。

| 步骤 | 结果 |
| --- | --- |
| 设置 → 模板文件 | 39 个模板；可替换模板的「导入新版本」可用，变更记录入口出现 |
| FundType 导入（新增 1 个取值）→ 保存并启用 | 预检通过，显示 `+ TemplateWalk-新增`；V2 成为当前版本，文件落在隔离 userData；时间按本机时间显示 |
| 资金对账 → 场景管理 → 内置 C2 场景「outbound改标为outbound Fail」 | FundType 下拉含新增取值；恢复默认后再次打开，下拉回到 12 个内置值 |
| 资金对账导出不平导入表头错误的文件 | 预检判 fail，原因与写出端校验一致，两个保存按钮置灰；重新选择正确文件 → 仅保存 → 在「版本」中启用 |
| 重启应用 | 两个 V2 仍为当前版本 |
| 重复入金召回邮件模板导入宽列版并启用 → 重复入金导入 MPT、银行与单据 → 运行 → 导出 | 输出「邮件模板」A 列宽 36（内置 19.66），表头与数据不变；活动日志记录「使用用户版本 V2」与 SHA 前 12 位 |
| 恢复默认后再导出 | A 列宽回到 19.66 |
| 另存为用户版本 | 默认文件名为导入时的原文件名，另存文件、版本文件与原文件 SHA-256 一致 |
| 改动当前版本文件（追加字节） | 详情顶部提示不可用，版本行「当前 · 不兼容」并给出原因 |
| 恢复默认 → 删除 V2 | 确认后删除，版本目录清空 |
| FundType 导入删除 `outbound` 的文件 | 按真实场景配置判 fail「已被场景使用：outbound」 |
| 变更记录 | 8 条，与操作顺序、版本变化一致 |

走查期间应用日志无报错。warning 日志中只有新库首次启动的迁移提示，以及前置资金对账、重复入金的 usage-stats「unregistered function」（既有登记缺口，与本次改动无关）。走查发现：当前版本不兼容时，左侧列表的版本标签仍只显示「V2」。已补上：标签改为「V2 · 不兼容」，使用危险色，悬停显示原因。Renderer 生命周期「不兼容」用例在浅色和深色主题下核对了标签文字、原因和颜色，`template-files` 16/16 通过。

### 9.3 代码审查与修复（2026-10-20）

四轮审查：先由 Claude 审查分支全部改动，再由 Codex 三次只读复审（每次都含此前的修复）。已修复以下 18 项，其余审查发现记为已知、本轮不修：

| 来源 | 问题 | 修复 |
| --- | --- | --- |
| 第一轮 | `acquire` 复核完成后才登记租约，复核期间切换并删除该版本会删掉正在取用的文件 | 读出当前版本后、任何等待前登记租约，复核失败时释放 |
| 第一轮 | 运行环境错误（临时目录不可写、文件被占用）被当作不兼容缓存，进程内一直拒绝导出；VCC 试写的临时目录清理失败会覆盖试写结论 | 环境错误标为 transient、不缓存；清理失败不再抛出 |
| Codex 一轮 P1（资金红线） | 平盘模板数据区的旧行（含金额）会和本次结果一起写出：ExcelJS 4.4 `spliceRows` 删除末尾多行无效，预检也不提示 | 写出前截断数据区、取消数据区合并单元格并核对只剩表头；预检对数据区内容 warn |
| Codex 一轮 P1 | 几 KB 的小文件只要有一个单元格落在 `XFD1048576`，结构描述就按整张表（约 172 亿格）展开，主进程耗尽内存；FundType / 网关表头解析对超大声明范围同样会展开 | 改为只遍历实际存在的单元格；结构描述失败时预检判 fail |
| Codex 一轮 P2 | 试写回读经 `openZipWithEntries` 时系统错误被包装，丢失 `syscall`，仍被当作不兼容缓存 | ZIP 读取层保留 `cause`；契约层沿 `cause` 与 `AggregateError.errors` 识别环境错误 |
| Codex 一轮 P3 | 复核未完成在界面上仍显示「不兼容」并引导恢复默认 | DTO 区分 `unverified`；界面显示「暂不可用」（警示色）、提示稍后重试、仍可点启用 |
| Codex 二轮 P2 | 平盘清空旧数据行后，模板的筛选与打印区域仍停在旧行数（如 `A1:AW3`），多出的结果行落在筛选与打印范围之外；Excel 表同理 | 写入后把筛选与打印区域下边界调整到最后一行；含 Excel 表的模板预检 fail；数据验证与条件格式 warn（按原范围带入） |
| Codex 二轮 P2 | 声明范围不从 A1 开始的 FundType 版本，版本记录按物理 A 列保存取值，下一次导入的比较基准为空，移除被场景引用的值不会被拦下；网关表头同理 | FundType 取值改用运行时 loader 解析；比较基准用运行时 loader 重新解析当前版本文件 |
| Codex 二轮 P3 | 版本文件因权限、占用等读盘错误打不开时仍标为不兼容（缺失 / 读取失败），引导恢复默认 | 只有确认不存在才算缺失；其余读盘错误为暂不可用、稍后重试、不缓存 |

验证：新增与改动的回归用例在旧实现上均失败（声明范围覆盖整张表的用例除外：旧实现会耗尽内存，未在本机运行）。FundType / 网关解析与结构描述在 `assets/` 全部 39 个 xlsx 上与旧实现逐项比对一致。`npm run test:unit` 9660/9664（0 失败，4 项为既有条件跳过）；`npm run lint`、`npm run check:architecture` 通过；集成脚本 `template-resources-versions`、`template-resources-save-as`、`position-reconciliation-side-db-parity`、`position-startup-task-recovery`、`vcc-financial-op-result-workbook`、`big-table-import-engine`、`bank-statement-universal-import-routing` 通过；Renderer 生命周期 `template-files` 17/17 通过。全量 `npm run test:integration` 与 smoke 本轮未重跑。
| Codex 三轮 P1 | ExcelJS 读入时把数据验证范围逐格展开：几 KB 的模板把 `sqref` 写成整张表，预检就会让主进程分配约 172 亿项 | 读入前流式扫描工作表 XML，数据验证与合并单元格合计超过 1048576 个单元格即拒绝 |
| 核对三轮时发现 | 合并单元格同理：ExcelJS 读入时逐格创建合并区域内的单元格 | 同上，合并单元格计入同一上限 |
| Codex 三轮 P2 | 比较基准直接重新解析当前版本文件，不核对 SHA-256：文件被改动后可绕过场景引用保护 | 导入时保存取值快照；早期记录核对 SHA 后才重新解析 |
| Codex 三轮 P2 | 当前文件读不出时退回的结构在声明范围不从 A1 开始时为空，场景引用保护失效 | 取不到可信取值时提示并按场景引用逐项核对 |
| Codex 三轮 P2 | Excel 在一个定义里用逗号写多个打印区域，ExcelJS 读入后只剩第一个 | 预检从原始 `workbook.xml` 读取打印区域，多个区域拒绝 |
| Codex 三轮 P2 | 筛选起点不在第 1 行时只调整末行，第 1 条结果落在筛选外 | 筛选与打印区域首行统一为表头行 |
| Codex 三轮 P2 | 上下分段的打印区域逐段延伸后互相重叠 | 只调整单个打印区域；多个区域预检拒绝、写出端保持原样 |
| 核对三轮时发现 | 资金对账导出同样原样复制模板的筛选与打印区域，用户版本设置的旧行数范围会留在输出里 | 资金对账各 Sheet 在 commit 前按行数调整，规则与平盘相同 |
| Codex 三轮 P3 | 版本路径被同名目录替代时读取报 EISDIR，被当作暂不可用 | 不是普通文件或 EISDIR 判为版本文件缺失 |

二轮复审修复后：新增 4 个回归用例在旧实现上均失败、在新实现上通过；`npm run test:unit` 9664/9668（0 失败，4 项为既有条件跳过）；`npm run lint`、`npm run check:architecture` 通过；集成脚本 `template-resources-versions`、`template-resources-save-as`、`position-reconciliation-side-db-parity`、`position-startup-task-recovery` 通过；FundType / 网关解析在 `assets/` 39 个 xlsx 上仍与旧实现一致。本轮未改 Renderer，生命周期未重跑；全量 `npm run test:integration` 与 smoke 未重跑。

三轮复审修复后：新增 5 个回归用例在旧实现上均失败、在新实现上通过（数据验证 / 合并单元格超限用例除外：旧实现会耗尽内存，未在本机运行）；`npm run test:unit` 9669/9673（0 失败，4 项为既有条件跳过）；`npm run lint`、`npm run check:architecture` 通过；集成脚本 `template-resources-versions`、`template-resources-save-as`、`position-reconciliation-side-db-parity`、`position-startup-task-recovery`、`pre-fund-reconciliation-output-contract`、`pre-fund-reconciliation-side-db-parity`、`duplicate-inbound-match-end-to-end`、`vcc-financial-op-result-workbook` 通过；5 个以 ExcelJS 读入的内置模板预检均通过（扫描在上限内）。本轮未改 Renderer，生命周期未重跑；全量 `npm run test:integration`、smoke 与 Excel 实机打印未做。
