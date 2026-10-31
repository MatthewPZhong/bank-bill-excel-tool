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
