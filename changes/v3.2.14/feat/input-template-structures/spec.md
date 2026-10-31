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
