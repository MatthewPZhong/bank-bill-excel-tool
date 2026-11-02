# Spec — v3.2.14 输入表结构：清晰报错与模板文件版本驱动（第一批：平盘）

> status: in-progress
> created: 2026-10-30
> updated: 2026-10-30
> 目标版本：v3.2.14（暂定；是否纳入本轮由发版时确认）
> 适用分支：`feat/input-template-structures`
> 分支创建基线：`v3.2.13` → `e68089cc46c88c3eaed87b942fcd8badef00dff7`
> 格式参考：`changes/v3.2.14/feat/statement-balance-gap-prompt/spec.md`（release/v3.2.14）

## 1. 背景

用户在 Windows 安装版「平盘对账 → 链接表管理 → 导入」导入中台网关原始入账订单。进度出现后，弹窗直接关闭，没有任何提示。

用户提供了 stderr 和样本，排查确认两点：

1. 系统导出的第 20 列表头是 `fileId`，程序契约（`SOURCE_DEFINITIONS`、随包样例 `assets/中台网关原始入账订单.xlsx`）写的是 `fieldId`。表头识别失败，整份文件被拒（`position-source-unrecognized`）。表头改成 `fieldId` 后，该样本可以通过预检。
2. 选中的文件全部失败时，`authorizeApply` 抛出 `position-streaming-source-empty`，worker 返回 FATAL，IPC 随之 reject。渲染层没有 catch，于是逐文件的失败原因丢失，界面没有提示，日志也没有记录。

用户需求（2026-10-29）：

- R1：以后再遇到文件结构不一致，需要有清晰的报错。
- R2：「设置 → 模板文件」可以导入新版本，用来修改相关输入表的结构参考。

## 2. 代码现状（基线 v3.2.13）

| 位置 | 当前行为 |
| --- | --- |
| `position-reconciliation/service.js` `prepareStreamingSourceImportForLifecycle` | 0 个文件被接受时，worker 以 FATAL 结束，整次 prepare 抛错 |
| `position-reconciliation/interactive-task-preflight.js` 来源导入 contract | prepare 不捕获异常，IPC 直接 reject |
| `renderer-position-reconciliation.js` 导入入口 | 只有 try/finally：进度弹窗关闭后异常继续上抛，没有提示 |
| `position-reconciliation-import/xlsx-reader.js`、`xls-reader.js`、`readers.js` | 必须与常量逐列完全相等；不相等时只报"无法通过表头识别链接原始表"，不给出差异 |
| `template-resources/catalog.js` | 输入类 24 个资源为 `sample` / `cached` / `disabled`，平盘 5 张不可替换 |
| `template-resources/service.js` | 已有用户版本、导入预检、启用、恢复默认、删除与 `acquire`；目前只接入输出模板，以及枚举和网关的取值 |
| `position-reconciliation/store.js` `sourceRecords`、`maintenance-writer.js` | 校验已存行包含常量中的全部表头 |

## 3. 已确认决策（用户，2026-10-29）

| 编号 | 决策 |
| --- | --- |
| D1 | 范围是全部输入类模板，分批交付。第一批：R1、模板中心通用能力、平盘 5 张链接原始表；第二批：其余模块逐个接入，每个模块单独出 spec |
| D2 | 启用新版本后只认当前启用的版本。结构不一致时报错，列出差异，并提示到「设置 → 模板文件」导入新版本 |
| D3 | 新版本可以改列名、调整顺序、增减列；程序按名读取的必用列必须保留且同名，否则导入预检不通过 |
| D4 | 内置契约不改（`fieldId` 保持不变），靠导入新版本生效，随时可以恢复默认 |
| D5 | 平盘功能尚未正式启用，没有旧数据：不做迁移，不加匹配防重。残余风险登记 backlog |
| D6 | 在本分支实施，以上一正式标签 `v3.2.13` 为基线 |

### 3.1 第二批范围（用户，2026-10-30）

| 编号 | 决策 |
| --- | --- |
| D7 | 顺序：VCC 财务OP 5 张 → 单据对账导出不平 → 流水对账单（业务 OP v3.2.7 与 VCC OP 发生额计算共用）→ 移除归档 Pending 账单 → 银行账单处理链接表 4 张（网关对账单、中台调拨订单、中台退款订单、外汇交割表）→ 银行对账单。每个模块单独一节 spec、单独提交 |
| D8 | 银行对账单也要做（46 列共用契约需拆为可变结构，最后做，开始前单独出方案） |
| D9 | Pending.xlsx 本批不做，单独设计（Pending 库按表头建物理列，规则按列名引用） |
| D10 | 不做：Bank BU 的 Pending 数据管理、业务 OP 账单 |
| D11 | 外汇期权表、外汇期权订单、入账原始订单导入未启用，暂不处理，待启用导入时接入 |
| D12 | VCC 财务OP：导入时按列名（同位置改名视为改名）归一到内置列序再入库，新增列不导入、删除的非必用列为空；导入时的表头持久化到 VCC 库（幂等迁移），存档重读按同一结构映射，哈希、血缘与导出不变 |
| D13 | 顺序调整为：单据对账导出不平 → 移除归档 Pending 账单 → 流水对账单 → 银行账单处理链接表 4 张 → VCC 财务OP 5 张 → 银行对账单（取代 D7 的顺序） |
| D14 | 流水对账单移到 VCC 之后：业务 OP v3.2.7 导出「流水校验原表」会重读存档原文件，且数据集复用只按文件摘要判断，需要与 VCC 相同的“记录导入时结构、重读按记录映射”机制；先在 VCC 上落地。顺序更新为：银行账单处理链接表 4 张 → VCC 财务OP 5 张 → 流水对账单 → 银行对账单 |

## 4. 功能规则

### 4.1 清晰报错（R1）

- 选中的链接原始表全部失败时，返回 `status:'failed'` 以及每个文件的失败原因。界面沿用现有的导入结果提示，逐文件列出。
- 来源导入的 prepare 出现任何异常，都转为失败结果（取消转为 `cancelled`），不再让 IPC reject。
- 渲染层的导入入口（来源导入、账户表确认替换、银行对账单写入）兜底捕获异常并弹出提示。提示写入错误日志。
- 表头不一致时，在原错误码不变的前提下补充明细：
  - 最接近的表，以及它的当前版本和列数；
  - 逐列差异（第 N 列应为 X，实际为 Y）、缺少的列、多出的列；
  - 末行提示："如系统导出结构已变更，请在「设置 → 模板文件」导入新版本"；
  - 明细不超过 100 行。

### 4.2 模板版本驱动输入结构（R2，第一批：平盘 5 张）

- 平盘 5 个输入资源（测试付款全量信息表、网关原始入账订单、网关原始出账订单、调拨订单表、清结算银行账户表）改为可替换，读取方式为"运行时读取 · 导入识别结构"。
- 导入新版本时，预检检查以下各项：
  - 找到表头行；
  - 表头非空、不重复；
  - 必用列齐全，缺失为不通过；
  - 新表头不能与另一张平盘来源表的当前结构相同；
  - 与当前版本相比的增加 / 删除列展示在"取值变化"中，改名或调序给出提示。
- 必用列：

  | 来源表 | 必用列 |
  | --- | --- |
  | 清结算银行账户表 | 账户状态、币种、账户性质、银行账号、系统账号 |
  | 中台调拨订单表 | 调拨单号、交易时间、付款币种、收款币种、付款金额、收款金额、调拨状态、渠道流水号、换汇渠道、付款账户（卡号）、收款账户（卡号） |
  | 中台测试付款全量信息表 | 付款单号、创建时间、源币种、目标币种、源金额、目标金额、渠道流水号、付款状态、付款渠道、银行流水号 |
  | 中台网关原始入账订单 | bizId、billDate、currency、tradeType、originOutboundCurrency、reconId、merchantId、channel |
  | 中台网关原始出账订单 | 业务单号、账单日期、币种、主对账id、账户号、交易类型、渠道名称、原始币种、原始金额、银行扣款币种 |

  以 `position-reconciliation/constants.js` 导出的常量为准，实施时逐项与 readers、derivation、logical-accounts 核对。
- 导入链接原始表时：
  - 开始时取一次 5 张表的当前结构，整个任务（预检与写入）只用这一份；
  - 用户版本缺失、被改动或不兼容时，中止导入并提示原因；
  - 识别只认当前结构（D2）。
- 原始表导出、账户链接表、异常报告都按当前结构的表头出列；已存行只校验必用列。
- `row_hash` 与身份语义、派生和匹配读取的列名都不变。

## 5. 非目标

- 第二批模块（银行账单处理链接表、Pending、Bank BU、业务 OP、单据对账、VCC）：本分支不改。
- 以下资源不适用（第二批开始时再请用户确认）：
  - `bank-statement` 银行对账单：46 列是全应用共用的输出契约；
  - `fx-option`、`fx-option-order`、`inbound-raw-order`：导入未启用。
- 不新增 IPC 通道，不改模板文件页前端交互。
- 不改内置样例和代码常量的表头。

## 6. 风险与登记

| 编号 | 风险 | 处理 |
| --- | --- | --- |
| K1 | 平盘启用后，在已有数据上切换结构版本，重导的重叠记录会生成同单号的新 `row_hash`，可能被再次自动匹配 | D5：当前没有旧数据；登记 backlog，上线前评估防重策略 |
| K2 | 后台 managed 导入路径（`position-import-adapter`，生产未启用）全部失败时会抛错，且不读当前结构 | 同类问题登记 backlog，启用前处理 |

## 7. 实施记录

### 7.1 文件

| 文件 | 内容 |
| --- | --- |
| `src/backend/file-service/header-structure-diff.js` | 通用表头差异明细 `describeHeaderMismatch`：选最接近的结构，逐列差异、缺少与多出的列，末行指引；≤100 行，供第二批模块复用 |
| `src/main-process/position-reconciliation/header-mismatch.js` | 平盘链接原始表 / 银行对账单的差异明细（银行 46/49 列契约不可替换，不附模板指引） |
| `src/main-process/position-reconciliation/source-structures.js` | 本次导入冻结的结构 → 来源定义；账户链接表列随结构、已存链接行只校验必用列 |
| `position-reconciliation/constants.js` | 新增 `SOURCE_REQUIRED_FIELDS`（§4.2 表） |
| `position-reconciliation/service.js` | 全部文件被拒返回逐文件原因；导入开始时读取当前结构并冻结到计划与账户确认令牌；导出按当前结构出列 |
| `position-reconciliation/interactive-task-preflight.js` | prepare 异常转为失败结果；预检后组装失败时释放 Worker |
| `position-reconciliation-import/{xlsx,xls}-reader.js`、`readers.js` | 识别时接收本次结构；未识别 / 银行表头不符时附差异明细 |
| `position-reconciliation-import/{preflight,source-writer,account-writer,anomaly-report,worker-entry}.js` | 预检、写入、账户确认、异常报告使用同一份冻结结构（START_JOB `contractOptions.sourceStructures`） |
| `position-reconciliation/{store,excel-io,filtered-source-report}.js`、`maintenance-writer.js` | 已存行只校验必用列；原始表、账户链接表、运行过滤数据按当前结构出列 |
| `renderer-position-reconciliation.js` | 四个导入调用兜底：IPC 被拒转为失败结果并弹窗（写入错误日志） |
| `template-resources/input-structures.js` | 输入原表结构规格（组、模块键、内置表头、必用列） |
| `template-resources/{contracts,workbook-structure,inspection-task,service,catalog}.js` | `inputStructureContract`；表头作为取值快照；`currentInputStructure`；同组结构冲突在预检与启用时拒绝；平盘 5 个资源可替换 |
| `src/main.js` | `resolvePositionSourceStructures` 注入平盘服务 |

### 7.2 偏离与说明

- 全部文件被拒时仍按原选择文件进入存档任务并记为失败，与 legacy 路径一致；不再引用已被 Worker 删除的暂存文件。计划中“不建存档任务”的设想未采用，以保持失败导入在存档中心可见。
- 平盘 5 个资源复用现有读取方式 `runtime`（运行时读取），模板文件页前端不改。
- 模板文件导入时只读第 1 个工作表的表头行；表头以下有数据时给出提示（版本文件会保留这些内容）。
- 准备导入后切换模板版本不影响进行中的导入（写入与账户确认沿用准备时的结构）；导出读取导出时的当前结构。

## 8. 验收

- 用户样本（`fileId`）在内置版本下导入时，弹窗提示"无法通过表头识别链接原始表"，并显示第 20 列的差异与导入新版本的指引。
- 在「模板文件」导入以 `fileId` 为表头的新版本并启用后，同一文件可以导入；恢复默认后再次被拒，并给出差异明细。
- 缺少必用列的新版本预检不通过；只改非必用列名的新版本预检带提示通过。
- 全部文件失败、prepare 异常、IPC reject 三种情况都有界面提示，且无未处理异常。
- `npm run release-check` 通过；新增或调整的单测与集成脚本覆盖上述场景。

### 8.1 验证结果（2026-10-30，macOS 本机，未提交工作区）

- `npm run release-check` 通过：lint；架构检查 803/803 文件；smoke；单测 9708/9712（4 项为既有条件跳过）；集成 87/87 脚本（新增 `position-input-template-version` 4/4）。首轮唯一失败为 `position-startup-task-recovery` 的测试装配未提供新依赖 `resolvePositionSourceStructures`，已在 `tests/helpers/position-startup-recovery-harness.js` 补上后通过。
- 新增 / 调整的回归：全部文件被拒与 prepare 异常（修复前失败、修复后通过）、表头差异明细（xlsx / xls / legacy / 银行）、输入结构契约与当前结构、按当前结构的流式导入端到端（含准备后切换版本不影响进行中的导入）、渲染层 IPC 被拒提示（renderer-lifecycle 22/22，修复前该用例失败）、必用列静态守卫。
- 用户提供的真实样本（Apache POI 导出、WPS 另存）：内置结构下给出“第 20 列（T）：应为「fieldId」，实际为「fileId」”及模板指引；模板解析与导入读取得到的表头逐列一致。
- 未执行：真实应用 GUI（本机开发版启动受已知 BizOP 资源预检阻断）与 Windows 安装版实测，需用户在新版本中验证。

## 9. 审查与修复

### 9.1 Codex 第一轮只读审查（2026-10-30，`v3.2.13..da20adbe`）

结论：2 个 P2，无 P0/P1；另指出 3 处测试覆盖不足。均已对照代码核实属实，修复如下（每条回归测试都确认修复前失败、修复后通过）：

| 编号 | 发现 | 处理 |
| --- | --- | --- |
| T1（P2） | 模板预检与快照用 SheetJS 读表头，平盘导入用 `row-scanner` 流式读取：inline 富文本只取最后一段 `<t>`，布尔、数字保留 XML 原文。合法启用的新结构仍可能无法识别 | 不改资金红线扫描器。输入结构规格新增 `runtimeHeaders`（平盘为 `openPositionWorkbook` + `readPhysicalHeader`），模板检查在 Worker 临时目录中用它重读表头，与快照逐列比较，不一致时预检不通过并说明“导入时读作 X”。回归：富文本、布尔表头 |
| T2（P2） | “导入并启用”提交时不复核同组结构，两份待提交预检可依次启用相同结构 | `commitImport` 在串行临界区、写版本文件之前，`enable` 时按最新快照复核同组冲突，与 `setCurrentVersion` 共用 `peerConflictOf`；被拒时不留版本文件与记录。回归：双预检依次导入并启用 |
| T3 | 必用列静态守卫按全部来源合并集合比较，不能证明逐类完整 | 改为按来源类型的行为测试 `position-reconciliation-required-fields.test.js`：只含必用列的行与完整行经校验、分类、派生与逻辑账户识别的结果一致；变异验证（删去账户表必用列“币种”）可被捕获 |
| T4 | 全部失败的真实 Worker 路径未断言 job root 删除 | 集成脚本 `position-input-template-version.js` 首例断言结果不引用暂存文件、`import-staging` 下无残留 |
| T5 | 渲染层四个入口中只有来源准备有行为测试 | renderer-lifecycle 新增银行写入与账户表替换 IPC 被拒的用例（23/23） |

Codex 已核查未发现缺陷的方面：冻结结构在预检、重放、异常报告、普通写入与账户确认中一致传递，`import-recovery` 不重读原始表头；全部失败路径的清理与存档计划；必用列覆盖与 `row_hash` / 消费语义未变（K1 / B36 仍需上线前人工复核）；FundType 与网关场景引用保护未被削弱；恢复默认在当前约束下无法制造同组冲突。

## 10. 第二批 · 单据对账导出不平（`doc-recon-unbalanced`，C4 单据模式）

### 10.1 现状（取证 2026-10-30）

- 读取：`recon-id-fix-io.js` `readReconIdFixFile` 读 4 张固定名 sheet，表头必须与常量逐列完全一致（不 trim），行对象按**常量**列名取键。传统 IPC（`main.js` `recon-id-fix:import`）与托管服务（生产未启用）都调用它。
- 按名读取：两张账单的 `BillDate`、`Amount`、`OrderId`、`BizType`、`reconId`、`createTime`（BillDate 为空时补位），以及「订单修复」输出按名复制的 12 列；「对账结果」在子业务类型自动模式下读 5 列；「订单修复」输入 sheet 只校验表头，不影响输出。
- C4 场景按字段名引用两张账单的列（条件字段按主 / 从边、主从字段对），存于 `scenarios.config_json`，运行时不校验字段是否存在（缺失静默为空）。下拉选项来自 `preload.js` 内联常量。模板服务的场景引用保护不含 C4。
- 导入数据只在内存会话中，不落库；输出 15 列固定。

### 10.2 方案

| 项 | 规则 |
| --- | --- |
| 结构 | 4 张按名 sheet 各自一份表头；模板文件须含这 4 张 sheet（其余 sheet 忽略）。用户版本的各 sheet 表头取导入时在检查 Worker 中解析的结构记录 |
| 必用列 | 两张账单：上述固定按名读取的列 ∪ 输出复制的 12 列；对账结果：5 列；订单修复：无（只要求 sheet 存在、表头与当前版本一致） |
| 场景引用 | C4 单据模式场景引用的主边 / 从边字段视同必用列：导入预检与启用时缺失即不通过，列出场景引用 |
| 读取 | 读取时按当前版本各 sheet 表头逐列比对（口径同现状：不 trim）；行对象按文件实际表头取键；结构不一致时按 1b 通用工具给出差异明细与导入新版本指引 |
| 口径核对 | 模板检查用与导入相同的 SheetJS 读法重读 4 张 sheet 表头，与快照不一致即拒绝（同 T1） |
| 下拉 | 新增只读查询 `scenarios:recon-id-fix-fields`（模式同 `scenarios:gateway-recon-headers`），场景弹窗打开时按当前版本刷新单据模式的主 / 从字段；不可用时回落内置字段 |
| 不变 | 输出「订单修复」15 列、未配报告、导出凭证与网关子模式（读的是资金对账导出不平，属输出模板） |

### 10.3 实施记录

| 文件 | 内容 |
| --- | --- |
| `template-resources/input-structures.js` | 结构规格统一为按工作表列表描述（`sheets`、`referenceKey`、`runtimeHeaders` 返回逐表表头）；平盘 5 张为单表（第 1 个工作表），新增 `doc-recon-unbalanced` 4 张按名工作表 |
| `template-resources/contracts.js` | `inputStructureContract` 逐表检查（缺表、空列 / 重复、导入口径核对、必用列、场景引用、数据行），多表的变化以「工作表」列名标签展示；`collectScenarioReferences` 增加 C4 单据模式主 / 从边字段 |
| `template-resources/{service,workbook-structure,inspection-task,catalog}.js` | 多表取值快照为标签列表、当前结构返回逐表表头；场景引用（含启用前复核）覆盖 C4；资源改为可替换 |
| `constants/recon-id-fix-fields.js` | 新增 `RECON_ID_FIX_BILL_REQUIRED_FIELDS`、`RECON_RESULT_REQUIRED_FIELDS` |
| `recon-id-fix-io.js` | `readReconIdFixFile` 接收当前结构，按文件实际表头取键；单据模式结构不符时附与当前版本的差异与指引（错误码不变）；新增 `readReconIdFixSheetHeaders` 供口径核对 |
| `main.js`、`preload.js`、`renderer/scenario-command-service.js`、`renderer/dialogs/scenarios.js` | 单据模式导入读取当前结构（不可用时中止并提示）；新增只读查询 `scenarios:recon-id-fix-fields` 与 `scenarios.getReconIdFixFields`，C4 配置弹窗打开时刷新单据模式主 / 从字段下拉 |
| `task-policy-registry.js`、`legacy-task-policies.js`、`architecture/boundaries.json` | 新通道登记为 exclude / read-only-query；`renderer-dialog-scenarios.allowedApiFields` 放宽并以 `24d1ea82` 为来源登记 policyChanges |

偏离与说明：托管服务路径（生产未启用）未接入，登记 B38；场景引用保护对“恢复默认”不生效（与 FundType / 网关一致，保证随时可回退）。

## 11. 第二批 · 移除归档 Pending 账单（`removed-pending`）

### 11.1 现状与方案

- 现状：`pending-import/removed-reader.js` 读第 1 个 sheet，表头须与内置 46 列逐列一致；行以内置列名存入 `removed_pending_rows.raw_json`（另抽 6 个索引列），导出按内置 46 列重建；移除核对按对账规则 `matchFields` / `compareFields` 的列名读 raw，而规则只能引用 Pending 主表的列（`assertFieldsInPendingColumns`）。生产已有存量数据，导入后不再重读原文件。
- 必用列：前 28 列（与 Pending 主表共有，即规则可引用、且存在于移除文件中的全部列，含 6 个索引列）。后 18 列流水扩展字段可改名、增删。
- 识别只认当前版本表头（口径不变：格式化文本、去首尾空格、末尾空单元格计入列数）；不符时原错误码，附与当前结构的逐列差异与指引。
- 入库前按通用工具 `canonicalHeaderMapping` 对应回内置 46 列：同名优先；内置列找不到同名、且同一位置上的列也不是内置列名时视为改名（按位置）；仍对应不上的内置列为空；多出的列不导入。存量数据、对账规则与导出不变。模板预检以「列对应」提示展示改名、置空与不导入。

### 11.2 实施记录

| 文件 | 内容 |
| --- | --- |
| `backend/file-service/header-structure-diff.js` | 新增 `canonicalHeaderMapping` / `projectRowToCanonical` / `describeCanonicalMapping`（VCC 等按内置列存储的模块复用） |
| `backend/pending-import/removed-reader.js` | `readRemovedPendingFile(filePath, { structure })`：按当前结构识别并对应回内置 46 列；新增 `REMOVED_PENDING_REQUIRED_COLUMNS`、`readRemovedPendingHeaders` |
| `template-resources/{input-structures,contracts,catalog}.js` | 登记 `removed-pending`（`storage: 'canonical'`）；契约对按内置列存储的资源增加「列对应」提示；资源改为可替换 |
| `main.js` | `pending:removed:import` 读取当前结构，不可用时不入库 |

## 12. 第二批 · 银行账单处理链接表 4 张（`gateway-recon`、`transfer-order`、`refund-order`、`fx-delivery`）

### 12.1 决策（用户，2026-10-31）

| 编号 | 决策 |
| --- | --- |
| D15 | 网关对账单入库仍按内置 31 列名（前置资金对账、SQL `json_extract` 与迁移按列名读取）；按位置改名的列存为内置名，新增列也入库（`raw_json` 多出该键）；C3「网关账单字段」下拉 = 入库后实际可用的列名（内置列中未被置空的 + 新增列），场景引用保护按同一口径 |
| D16 | 中台调拨订单（银行账单处理）与平盘「中台调拨订单表」各自独立版本，模板详情互相标注同结构资源 |

### 12.2 方案

- 识别只认当前版本：每次导入按 4 个资源的当前结构生成本次的识别签名（`expectedHeaders` 取当前版本；外汇交割表的 L1 锚点取第一个空列之前的连续段），L1 要求整行列宽与位置完全一致；只靠 L2 指纹命中、或 L1 命中但列宽不一致时，按“结构不一致”报错并附 1b 差异明细与指引。其余固定签名（银行对账单、入账原始订单、外汇期权、银行对账单表）不变。
- 入库 / 会话前统一按 `canonicalHeaderMapping` 对应回内置列：网关保留新增列（D15），调拨与外汇丢弃新增列，退款订单丢弃新增列；内置结构中的空列（外汇第 10 列）不参与对应、不计为置空；外汇按物理行号分组（BOC）不受影响。流式路径的列宽随当前版本。
- 必用列：
  - 网关：Billdate、Channel、merchantid、orderid、currency、amount、ReconBillBizId、reconciliationid、TradeType、name、cardNo、真实渠道、清算网络（13），另加 C3 场景引用的字段（按入库后列名判断）。
  - 中台调拨订单：`FT_RECON_FIELD_MAP.mid` 的 13 列（已覆盖 ADM、BOC 读取的列）。
  - 中台退款订单：`REFUND_RO_COLUMNS` ∪ 回填读取的退款单列（16）。
  - 外汇交割表：交易编号、交易日期、到期日、货币1金额、货币2金额。
- 冲突：新结构不能与本次识别候选中的其他签名（含固定签名与其余 3 个资源的当前结构）表头完全相同。
- 口径核对：xlsx 单表文件走流式读取、其余走 SheetJS，模板检查两种读法都要与快照一致（布尔表头两者读法不同）。模板版本须为 .xlsx；导入文件仍可为 .xls。
- 报错可见：链接表导入与“导入文件”的结果带 `detailLines`，界面导入结果摘要显示明细。
- 不变：`linked_*` 表结构与键、派生（FT_RECON / ADM / BOC / 退款回填）读取的列名、导出与前置资金对账口径。

### 12.3 风险

| 编号 | 风险 | 处理 |
| --- | --- | --- |
| K3 | v3.2.13 用户可能已为 C3 下拉启用网关对账单用户版本；升级后该版本同时驱动导入识别，若实际导入的文件仍是旧结构会被拒 | 发版说明写明；报错明细与指引提示恢复默认或导入与系统导出一致的版本 |
| K4 | 后台 `fund-recon` worker（生产未启用）用固定签名重读退款订单 | 已登记 backlog B39，启用前接入当前结构 |

### 12.4 实施记录

| 文件 | 内容 |
| --- | --- |
| `main-process/linked-structure-signatures.js`（新增） | 4 张链接表 → 模板资源；按当前结构生成本次识别签名（用户版本 `structureExact`，不可用时 `structureUnavailable`）；读出的行对应回内置列名（网关保留新增列）；识别失败时的差异明细 |
| `main-process/table-type-detector.js` | `structureExact` 签名只认整行逐列一致；指纹相近但不一致返回 `structure-mismatch`；未识别 / 不一致都带前 3 个非空行（`headerCandidates`） |
| `backend/file-service/header-structure-diff.js` | 新增 `projectObjectToCanonical`、`storedHeaderNames`；内置结构中的空列不参与对应；差异明细支持调用方给出的行描述（`rowLabel`） |
| `template-resources/input-structures.js` | 登记 4 个资源（组 `bank-linked`，`storage: 'canonical'`）；网关 `keepExtra` + `values: 'stored'`；外汇 `headerRow: 2` + `allowBlank`；固定签名（银行对账单、入账原始订单、外汇期权、银行对账单表）作为识别冲突对象；导入口径核对同时比较 SheetJS 与流式读法 |
| `template-resources/contracts.js` | 删除旧 `gatewayContract`（网关改走 `inputStructureContract`）；`__CUSTOM__` 保留值提示迁入；外汇允许空列；场景引用按入库后的列名、只拦“当前可用而新版本不可用”的列 |
| `template-resources/{workbook-structure,service,catalog}.js` | 网关取值快照 = 入库后的列名（C3 下拉与场景引用同口径）；比较基准、同组冲突与启用前复核按版本记录的各表表头计算；4 个资源可替换；中台调拨订单与平盘「中台调拨订单表」`twin` + `twinNote` |
| `constants/refund-backfill-fields.js` | 新增 `REFUND_ORDER_REQUIRED_COLUMNS`（`REFUND_RO_COLUMNS` + 状态，16 列） |
| `main.js` | 链接表管理与导入文件两个入口每次导入解析当前结构；流式 / 数组路径与退款会话按当前结构读后对应回内置列；结构不一致返回 `unrecognized` + `detailLines`；当前版本不可用时该表 `read-error`；链接表导入失败日志带明细 |
| `renderer-dialogs.js`、`renderer/controllers/bank-statement.js` | 链接表管理导入结果在失败项下显示明细；导入文件有结构不一致时先弹差异明细（写入错误日志），确认后再给退款 / 网关提示 |
| `renderer/dialogs/template-files.js` | 带 `twinNote` 的资源详情显示“同一系统导出（版本各自独立，需分别导入）”，其余仍为“内容相同” |
| `knowledge/backlog.md` | B39（K4） |

偏离与说明：

- 识别：4 张表的用户版本统一按“某一非空行去掉末尾空单元格后与当前版本表头逐列一致”判定，外汇交割表不另取空列之前的 L1 锚点段（实测读取保留中间空单元格，整行比对可直接命中）。内置版本保持原签名与原识别（L1 连续段 + L2 指纹），不收紧现有行为。
- 场景引用保护（所有输入原表）：只拦截当前版本中可用、新版本中不可用的被引用列，与切换版本时的复核同口径。原实现要求“被引用的列全部存在”，会被预置 C3 场景（引用 `Amount`、`MerchantId`、`Bank`、`reconciliationId`，与网关表头大小写不符，属存量配置）拦下任何网关新版本；集成测试在真实主库上发现。取不到当前取值时仍按全部被引用值逐项核对。
- 网关对账单的旧模板契约（`识别字段` 检查 `signatureHeaders`、表头取声明范围首行）由输入结构契约取代：必用列 13 个；表头须在第 1 行、从 A 列起（与导入读取口径一致），v3.2.13 测试中表头从 C2 起的版本现在预检不通过。
- 导入口径核对：SheetJS 与流式两种读法结果不同时，不一致的列标出两种结果（如「true / TRUE」），预检必不通过；不只返回其中一种，避免一种读法与快照一致而另一种不一致时放行。
- 未接入：`gateway-recon:import`（`readGatewayRecon`，渲染层无调用方）与后台 `fund-recon` worker（B39）。

### 12.5 验证结果（2026-10-31，macOS 本机，未提交工作区）

- `npm run release-check` 通过：lint；架构检查 804/804 文件；smoke；单测 9746/9750（4 项为既有条件跳过）；集成 88/88 脚本（新增 `linked-input-template-version` 7/7）。
- 新增 / 调整的回归：识别器 `structureExact`（命中、内置结构 / 多列 / 错位为结构不一致、未识别带各行表头）、签名解析与行对应（改名、删列、新增列、外汇空列、读取异常按内置）、两个导入入口在入库前拦截当前版本不可用（源码守卫）、链接表模板预检（场景引用口径、调拨订单独立版本、外汇第 2 行表头与空列、退款必用列、布尔表头两种读法不一致）、导入文件差异弹窗与后续提示顺序、差异明细行描述；v3.2.13 网关模板测试改为输入结构语义。
- 集成测试在真实主库上发现的问题已修复：预置 C3 场景引用了网关表头中不存在的列，原口径会拦下任何网关新版本（见 12.4 偏离与说明）。
- 复查中修复：「导入文件」入口的链接表分支在当前版本不可用时仍按内置结构入库，已改为该表中止（与链接表管理一致）。
- 未执行：真实应用 GUI（本机开发版启动受已知 BizOP 资源预检阻断）与 Windows 安装版实测；用户真实网关样本未在本模块重跑（该样本属平盘中台网关入账订单，不是本模块的表）。

## 13. 第二批 · VCC 财务OP 5 张（`vcc-recharge-refund`、`vcc-fee-fx`、`vcc-channel`、`vcc-removed-pending`、`vcc-system-op`）

### 13.1 现状（取证 2026-11-01）

- 识别：选文件后在 worker 中预检出导入计划（`workbook-import-plan.classifyHeaderRow`，按 `HEADER_RULES` 逐列一致）；应用前用同一函数重新预检并按 Sheet 计划摘要核对。不符时界面只显示“业务表头缺列、错序或含额外列”，逐列差异（`candidates[].mismatches`）不展示。
- 存储：明细按内置原始结构的位置存 `raw_json`（`raw_contract_version`：明细 1，Pending 2）；幂等键、`content_hash` 按内置列计算；同键内容不同记为 `idempotent_conflict` 并列出差异字段。系统财务OP 快照的 `displayHeaders` 固定为内置 16 列。
- 血缘：导入交接成员清单（归档原件元数据 `vccSourceMembers[].sheets`：sheetName / sheetIndex / headerRow / rawContractVersion，受原件 SHA 与成员摘要保护）是重读原件的唯一定位依据。数据集导出（明细 `streamStoredDetailRows`、系统 `readSystemOpSheetCandidates`）与审阅导出（`extractReviewSources`）按它重读、重新映射并校验 `content_hash`。没有按文件摘要复用数据集的逻辑。
- VCC 的 Pending 46 列与「移除归档Pending账单」（§11）表头完全相同。

### 13.2 方案

- 识别只认当前版本：选文件预检时解析 5 个资源的当前结构，冻结进导入计划（重新预检沿用冻结结构）；规则表按当前结构逐列一致。用户版本不可用时预检失败并指向设置。表头不符时诊断附 1b 差异明细（与当前结构比较），界面显示。
- 记录当时结构：计划 Sheet 与交接成员 Sheet 增加 `sourceHeaders`（仅启用用户版本时写入；内置版本不写，成员摘要与存量元数据不变），随成员清单存入归档原件元数据（主库，与 VCC 表同库）。
- 归一：读取时按 `sourceHeaders` 定位表头、按位置读取，读出后立即按 `canonicalHeaderMapping` 对应回内置列序（同名优先，同位置非内置名视为改名，其余置空，多出的列不导入）。`raw_contract_version`、映射、幂等键、`content_hash`、`raw_json` / fallback、导出与存量数据口径不变。
- 重读：数据集导出与审阅导出从成员 Sheet 取 `sourceHeaders`，经同一归一后校验血缘；审阅导出的原表页按导入时的原表结构输出（按表头指纹分组，已支持不同表头）。
- 系统财务OP：按 `sourceHeaders` 定位表头与财务余额列，“模板外列”按导入时结构判断；读出后归一，快照 `displayHeaders` 仍为内置 16 列。
- 必用列（程序按列名读取）：
  - VCC充值清退明细：订单号、BillDate、公司主体、出入方向、我方到账金额、我方币种、业务部门、对手部门、业务子类型。
  - VCC费用及换汇明细：同上去掉对手部门。
  - VCC通道明细：渠道订单号、账单日期、借贷方向、通道名称、MID、部门、交易币种、交易金额、billdate、清算币种、清算金额、结算币种、实际到账金额。
  - VCC_移除归档Pending账单：PendingBizId、平账账期、主体、对账类型、channel、币种、流水_币种、金额、流水_对账金额。
  - 系统财务OP：账单日期、主体、业务部门、币种、财务余额。
- 冲突：5 张互相不能相同，也不能与旧 48 列 Pending 模板相同。`vcc-removed-pending` 与 `removed-pending` 标注同一系统导出、版本各自独立。

### 13.3 风险

| 编号 | 风险 | 处理 |
| --- | --- | --- |
| K5 | 切换结构后重导已导入账期的数据：被置空的列使同键行内容不同 | 记为幂等冲突并列出差异字段，不静默覆盖或重复计入；发版说明提示同一账期内保持结构一致 |
| K6 | 预检后、应用前切换模板版本 | 计划已冻结，导入沿用预检时的结构（与平盘一致） |

### 13.4 实施记录

| 文件 | 内容 |
| --- | --- |
| `backend/vcc-financial-op/source-structure.js`（新增） | 导入时结构 → 读取表头与对应回内置列序（`createSourceProjection`；`keepTail` 保留结构宽度外的单元格供“模板外列”检查） |
| `backend/vcc-financial-op/definitions.js` | 新增 `REQUIRED_HEADERS`（§13.2 必用列，纯数据，不新增依赖） |
| `backend/vcc-financial-op/workbook-import-plan.js` | `headerRulesFor(sourceStructures)`：识别规则按当前结构；命中时 Sheet 记 `sourceHeaders`；表头不符的诊断附差异明细（`detailLines`），计划失败时一并抛出；计划冻结 `sourceStructures`，重新预检沿用 |
| `backend/vcc-financial-op/import-handoff.js` | 成员 Sheet 保留并校验 `sourceHeaders`（非空、无首尾空格、不重复），纳入成员摘要；内置结构不写该键 |
| `backend/vcc-financial-op/workbook-reader.js`、`detail-importer.js` | 明细流式读取按 `sourceHeaders` 定位表头与业务键单元格类型，读出即对应回内置列序；新增 `readFirstSheetHeaderRow` 供模板口径核对 |
| `backend/vcc-financial-op/system-op-importer.js` | 系统财务OP 按 `sourceHeaders` 定位表头与财务余额列，矩阵对应回内置 16 列后解析 |
| `backend/vcc-financial-op/review-export-plan.js` | 审阅导出的原表页按导入时结构输出（分组表头 = `sourceHeaders`），核验时对应回内置列 |
| `main-process/vcc-financial-op-source-structures.js`（新增）、`vcc-financial-op-service.js`、`worker-entry.js`、`main.js` | 选文件预检时解析 5 个资源当前结构（不可用时预检失败）并传入 worker 冻结进计划 |
| `template-resources/{input-structures,catalog}.js` | 登记 5 个资源（组 `vcc-sources`，`storage: 'canonical'`，旧 48 列 Pending 模板为识别冲突对象）；口径核对同时比较导入预检、明细流式读取（系统财务OP 为显示值）；可替换；`vcc-removed-pending` ↔ `removed-pending` 互标同一系统导出 |
| `renderer-vcc-financial-op.js` | 预检确认弹窗在诊断下显示差异明细 |

偏离与说明：

- 记录位置（D12 写作“持久化到 VCC 库（幂等迁移）”）：导入时表头记在交接成员清单上，随存档原件元数据保存在主库（与 VCC 表同库），不改 VCC 表结构，也不升级存储合同 v3（触发器写保护与逐句 schema 校验）。成员清单本就是两条重读路径定位原件的唯一依据，受原件 SHA 与成员摘要保护；内置结构不写新键，存量清单与摘要不变。未存档的新导入走 fallback（已是内置列序），不需要导入时结构。
- 按位置改名只认同一位置：删除列会使其后各列左移，左移后的同名列仍按列名对应；位置不同的改名列视为“删除 + 新增”（导入后为空、不导入），预检「列对应」逐列列出。
- 系统财务OP 的布尔表头在各读法下都读作 `true`，不拦；明细表的布尔表头在富工作簿与流式读取下不同（`true / 1`），预检不通过。
- 未接入：worker 的旧 `inspect` 动作与不带计划 Sheet 的 SheetJS 系统读取（生产无调用方，正式导入的文件都带 Sheet），保持内置结构。

### 13.5 验证结果（2026-11-01，macOS 本机，未提交工作区）

- `npm run release-check`：lint、架构检查 806/806 文件、smoke、单测 9756/9760（4 项为既有条件跳过）通过；集成阶段首轮 `toolbox-csv-admission` 1 项失败（低内存档排队计时，与本模块无关；单独重跑 17/17），随后完整重跑 `npm run test:integration` 89/89 通过（新增 `vcc-input-template-version` 4/4）。
- 新增 / 调整的回归：预检按当前结构识别与差异明细、计划冻结结构与重新预检、成员清单记录与摘要保护（含篡改）、明细 / Pending / 系统财务OP 按导入时结构导入后 `content_hash` 与内置结构同值导入一致、数据集导出与审阅导出重读存档原件核验通过（审阅原表页按导入时结构）、系统财务OP 结构外数据列仍拒绝、模板预检（必用列、旧 48 列 Pending 冲突、明细布尔表头两种读法不一致）、版本不可用时预检中止、`vcc-removed-pending` 与 `removed-pending` 互标；既有 VCC 与模板测试全部通过。
- 未执行：真实应用 GUI（本机开发版启动受已知 BizOP 资源预检阻断）与 Windows 安装版实测；worker 线程中的预检与导入由单测和集成脚本在本进程调用同一函数覆盖。

## 14. 第二批 · 流水对账单（`flow-statement`，业务 OP v3.2.7 与 VCC OP 发生额计算共用）

### 14.1 现状（取证 2026-11-01）

- 业务 OP 新版（`biz-op-v327`，v3.2.7 起启动时自动升级启用，旧版导入已退役）：worker 中单文件单 Sheet，第 1 行逐列一致识别 OP / 流水（`import-adapter.detectHeader`），按固定列下标读取（`FLOW_PROJECTION` 等）。数据集清单 `catalog.sources`（artifactId / sha256 / order / sheetName / bu / rowCount）封存于数字摘要保护的 manifest；`inputFingerprint` 按原件 SHA 等计算，重复导入同一组原件复用已有数据集。「流水校验原表」导出（`FLOW_RAW`）重读存档原件，按 `FLOW_HEADERS` 位置读取并核对行数。
- VCC OP 发生额计算（`vcc-op-calc`）：流式读取固定 28 列，首行与 `FLOW_HEADERS` 逐列一致，按 `FLOW_DB_COLUMNS` 位置取方向、对账金额、账单日期、币种计算；不持久化行，也不事后重读原件。worker 输入键固定（`PARSER_INPUT_KEYS`）。
- 两个模块的 28 列定义一致。

### 14.2 方案

- 识别只认当前版本：业务 OP 在导入任务开始时解析当前结构，冻结进 worker 计划文档（数字摘要保护，恢复沿用）；VCC OP 计算在每次扫描时解析。用户版本不可用时中止并指向设置。表头不符时附 1b 差异明细（与当前结构比较）。业务 OP 账单（OP）不变。
- 归一：按导入时结构读出后立即对应回内置 28 列（同名优先，同位置非内置名视为改名，其余置空，多出的列不导入；导入时结构宽度之外有数据仍按“超出原表模板”拒绝）。下游列下标、校验、计算、导出列与存量数据不变。
- 记录当时结构（业务 OP）：数据集 `catalog.sources[]` 中该原件增加 `sourceHeaders`（仅用户版本时写入），计入 `sourceManifestDigest`，不计入 `inputFingerprint`（同一原件的表头由其字节决定，对应结果只取决于原件本身，复用判断不受影响）。「流水校验原表」导出重读时按记录的结构识别并对应回内置列，输出仍为内置 28 列。存量数据集没有该键，按内置结构。
- 必用列（程序按列下标 / 列名读取）：账单日期、公司主体、业务部门、出入方向、流水单号、账户编号、对账金额、币种、账户类型（覆盖 VCC OP 计算读取的 4 列）。其余日期列（流水开始 / 完成时间、valueDate、系统创建 / 修改时间）有值时仍按日期校验，删除后为空。
- 口径核对：模板表头须与业务 OP 富工作簿读法、VCC OP 计算流式读法一致。

### 14.3 风险

| 编号 | 风险 | 处理 |
| --- | --- | --- |
| K7 | 业务 OP 同一账期重导：新结构下被置空的列不进入 `inputFingerprint`（按原件 SHA），不同原件即视为新版本输入 | 与内置结构下更换原件一致：生成新输入版本，旧版本与结果保留可追溯 |
| K8 | VCC OP 计算的保存运行回执按扫描时结构计算，不记录结构 | 回执记录原件快照与计算结果，不重读原件，不受之后切换版本影响 |

### 14.4 实施记录

| 文件 | 内容 |
| --- | --- |
| `main-process/flow-statement-structure.js`（新增） | 解析「流水对账单」当前结构（用户版本返回表头，内置返回 null，不可用时抛错） |
| `backend/biz-op-recon-db/columns.js` | 新增 `FLOW_REQUIRED_HEADERS`（§14.2 必用列） |
| `main-process/biz-op-v327/import-adapter.js` | `detectHeader(row, { flowHeaders })`：流水按导入时结构识别，不符时消息附与当前结构的逐列差异与指引；`createImportAdapter(kind, { sourceHeaders })`：单元格对应回内置 28 列下标，`cellsOf` 供原表导出使用；结构宽度之外的数据仍按“超出原表模板”拒绝 |
| `main-process/biz-op-v327/{import-main,module,import-pipeline,worker-entry,candidate-router}.js` | 导入开始时（建立任务前）解析结构并冻结进 worker 计划；数据集 `catalog.sourceHeaders` 记录导入时结构，计入 `sourceManifestDigest`，不计入 `inputFingerprint` |
| `main-process/biz-op-v327/export-source.js` | 「流水校验原表」导出按数据集记录的结构重读原件，输出内置 28 列 |
| `backend/vcc-op-calc-import/{reader,validator}.js`、`main-process/vcc-op-calc-session.js` | `streamFlowFile(…, { sourceHeaders })`：按当前结构校验表头与列宽，行对应回内置 28 列；未找到数据表时附模板指引；新增 `readFirstWorksheetHeaderRow` 供模板口径核对 |
| `main.js` | 业务 OP 模块注入 `resolveSourceStructures`；VCC OP 扫描开始时解析结构 |
| `template-resources/{input-structures,catalog}.js` | 登记 `flow-statement`（`storage: 'canonical'`，业务 OP 账单表头为识别冲突对象，口径核对比较两种读法）；可替换 |
| `knowledge/backlog.md` | B40（Parser Worker 路径） |

偏离与说明：

- 导入时结构按数据集记一份（`catalog.sourceHeaders`），不按原件逐条记：同一次导入的流水原件共用计划冻结的结构，数据集只来自一次导入；这样「流水校验原表」导出的来源快照（64 KiB 上限）不随原件数增长，来源条目字段与导出核对不变。
- 旧版业务 OP 导入（`biz-op-recon-import`，v3.2.7 起启动时升级后退役）与 VCC OP 计算的 Parser Worker 路径（生产未启用，B40）未接入，保持内置结构。

### 14.5 验证结果（2026-11-01，macOS 本机，未提交工作区）

- `npm run release-check` 通过：lint；架构检查 807/807 文件；smoke；单测 9763/9767（4 项为既有条件跳过）；集成 90/90 脚本（新增 `flow-statement-template-version` 3/3）。
- 新增 / 调整的回归：业务 OP 真实模块宿主上按当前结构导入、数据集记录导入时结构、「流水校验原表」与校验表导出、恢复默认后已导入数据集仍可导出、内置结构文件被拒且错误报告列出逐列差异、适配器结构宽度外数据拒绝；VCC OP 计算按当前结构读取并对应回内置列、内置结构文件被拒附指引；模板预检（必用列、两种读法不一致的布尔表头）、版本不可用时中止；既有业务 OP、VCC OP 与模板测试全部通过。
- 未执行：真实应用 GUI（本机开发版启动受已知 BizOP 资源预检阻断）与 Windows 安装版实测。
