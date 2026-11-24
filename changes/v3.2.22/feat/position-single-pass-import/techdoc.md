# TechDoc — v3.2.22 平盘对账数据处理：单遍导入与只存交互字段

> 目标版本：v3.2.22（暂定）
> 适用分支：`feat/position-single-pass-import`（基线 `v3.2.21` / `0e996340`）
> 依据：同目录 `spec.md`
> 状态：四步（银行单遍导入、银行行只存交互字段 + 版本号 + 导出列、来源链路、清理）全部实现并验证；遗留项见 `knowledge/backlog.md` B135–B139。

## 1. 实测

本机（macOS），经真实导入进程（`npm run benchmark:position-import -- --kind=<bank|source> --apply <文件>`）。

银行对账单（100 万行 × 46 列、173MB、解压 1.7GB）：

| | 改造前 | 第一步后 | 最终 |
| --- | --- | --- | --- |
| 端到端耗时 | 107 秒 | 62 秒 | 19 秒（导入进程约 15 秒，其余为基准脚本自身的汇总查询与校验） |
| 侧库 + 临时文件峰值占盘 | 8.8GB | 8.7GB | 0.9GB |
| 导入进程峰值内存 | 316MB | 404MB | 471MB |
| 文件被完整解析的次数 | 2 | 1 | 1 |

链接原始表（中台网关原始出账订单，100 万行、146MB）：

| | 改造前 | 最终 |
| --- | --- | --- |
| 端到端耗时 | 139 秒（预检 41 秒、写入 83 秒、提交 5 秒） | 26 秒（读取 + 写入 20 秒、提交 1 秒） |
| 侧库 + 临时文件峰值占盘 | 4.85GB | 2.67GB |
| 导入进程峰值内存 | 322MB | 477MB |
| 文件被完整解析的次数 | 2 | 1 |

银行导入进程约 15 秒里表扫描约 10 秒，逐行校验与写库约 4～6 秒，提交与 WAL 回写约 0.5 秒。再往下降要换扫描器（B136）。链接原始表占盘仍偏高：来源行与链接行各存一份必用列 JSON，且整批在一个事务里，WAL 在提交前与数据同量级。

## 2. 相对计划的调整

| 计划 | 实际 | 原因 |
| --- | --- | --- |
| 取消模块暂存副本，直接解析用户原文件，存档中心事后复制 | 保留一次暂存复制（顺带算 SHA-256），解析暂存副本 | 存档任务、待恢复操作、崩溃恢复整条链路都以「暂存文件 + SHA-256」为凭证；直接解析原文件要改这整条链路，且「侧库已提交、存档未完成时崩溃、原文件又被移动」会丢原件。复制 + 哈希实测 0.3 秒 / 173MB，不是瓶颈 |
| 原始文件字节只读 2 遍 | 3 遍：暂存复制、解析、存档中心入库复制；链接原始表另有一遍（原件也被登记为存档输入） | 存档中心从暂存副本再复制一次入库，暂存在任务收尾后删除，最终只留一份。硬链接接管与文件计划去重涉及共享的存档服务与存档批次条目，登记 B138 |
| 运行结果行只存结果与血缘 | 运行结果行保留一份交互字段快照（`original_json`，17 个字段），去掉 `result_json` | 已确认的历史运行在银行数据被替换后仍要能导出差异数据，必须自带字段；结果行改由快照 + 结果资金性质推导 |
| 来源行去掉 `row_hash`，同业务单号重复行按交互字段相等判定合并或拒绝 | 保留 `row_hash` 作记录标识，但只按必用列计算、入库时算一次；同单号不同内容各自保留，不拒绝 | 链接行、消费关系、运行血缘都以它为 `sourceRecordKey`；现行契约（v3.1.3 spec D-16）是「内容相同折叠、同单号不同内容各自保留」，改成拒绝是未经确认的业务规则变化 |
| 只解码需要的列 | 未做 | 现用扫描器不支持列白名单；字节级扫描器不带单元格样式，日期判定无法保证与现在一致，需单独做等价性验证（B136） |
| 删除非流式旧导入引擎 | 保留进程内旧路径（生产不调用） | 约 4000 行服务测试靠它搭数据，改测试的量与本次目标不成比例（B135） |

## 3. 导入流程

一个导入进程、一次读取、一个 SQLite 事务。公共部分在 `position-reconciliation-import/import-common.js`：取消检查、导入连接参数（128MB 页缓存、256MB mmap）、结构版本核对、范围 revision、暂存文件身份快照比对、提交后 `wal_checkpoint(TRUNCATE)`。

银行与来源导入共同遵守的三条边界：

- **磁盘门禁**：行数要读完才知道，写库前按暂存文件大小估算行数据与 WAL 的增长（银行 5 倍、来源 18 倍，取自 §1 的实测峰值），加上现有侧库、暂存文件与 512MB 余量；空间不足在改动旧数据之前拒绝。
- **取消**：导入进程收到写入授权即进入不可取消阶段（之后的取消应答为未接受）；暂存文件核对结束后、提交前再核一次取消标记。
- **暂存目录归属**：就绪结果（`PREFLIGHT_READY`）发出之前的失败、取消由导入进程删除暂存目录；发出之后暂存归 Main，导入进程只回滚事务、不再删除。原因是确认写入的任务先把暂存文件登记进待完成操作与存档清单、后发授权，登记之后仍可能拒绝授权（模块锁被占、checkpoint 已变、授权器失败）或被取消，而存档结算无论业务成败都要归档这些输入。Main 侧由调度层 `cleanupUncommittedImportArtifacts` 在导入进程失败 / 退出时统一回收：已被待完成操作或未结存档来源引用的作业目录保留，留给任务收尾（§3.6），其余立即删除；存档中心不可用而无法判断时保留，由启动时的过期清理兜底。唯一的例外是正常结束且没有任何文件需要提交或待确认（全部被拒）：Main 不会走失败清理，由导入进程自己删除。与 v3.2.21「授权被拒只清理写入前的产物、不动暂存输入」一致。

XLSX 读取器把行回调（单遍导入在这里写库）抛出的错误原样上抛，不包装成 `position-workbook-invalid`：数据库错误必须让整批回滚，不能被当成单个坏文件。

### 3.1 银行对账单（`BANK_IMPORT`，`bank-import.js`）

1. `stageInputFilesAsync` 复制到暂存目录并算 SHA-256。
2. 打开侧库，`runPositionSideDbMutation` 开事务并核对基准 checkpoint。
3. 每个文件先登记一条 `position_raw_files`（版本号），再流式逐行：取交互字段 → 校验 BizId / Channel / BillDate → 首次遇到的渠道 + 月份先删除旧行（只删本次导入之前的行，以自增 id 区分）→ `INSERT`。
4. `UNIQUE(biz_id)` 冲突：对方是本次导入的行 → 文件内重复，立即拒绝；对方是旧行 → 先挂起（放事务内的临时表，不随行数占用进程内存），全部读完后按原顺序补写一次，仍冲突才报跨范围冲突（旧行所在范围可能在文件后面才出现并被整体替换）。
5. 核对「读取行数 = 写入行数」，把已无行的旧版本标为 superseded，推进范围 revision，向 Main 发 `PREFLIGHT_READY`（范围、行数、被替换行数、文件凭证），事务保持未提交。
6. Main 侧 `prepareStreamingBankImport` 返回 `needs-confirmation`；`existing` 只列确实会被替换的范围，为空时界面不弹确认直接调用 apply。
7. `applyStreamingBankImport` 在存档任务内发 `APPLY_GRANTED`（operation token、基准 checkpoint、batch owner、存档路径）；导入进程核对授权、比对暂存文件身份快照（不重读内容）、写文件凭证、推进 checkpoint、`COMMIT`，随后截断 WAL。
8. 取消 / 拒绝 / 新一次选择文件：`APPLY_REJECTED` → 导入进程回滚，暂存由 Main 回收。确认写入的任务没能接管这次导入（存档初始化失败、任务准入被拒、模块锁被占）时，`abandonPreparedBankImport(token)` 按令牌拒绝授权并等导入进程回滚，释放侧库写锁。「确认写入」这次 IPC 调用结束时还有一道兜底（`trackedIpcHandle` 的 `afterInvocation`）：导入进程是上一步 IPC 留下的，本次调用可能在 prepare 之前就被 Recovery Hold 拒绝，那时 `onAbandon` 还没登记；只要令牌没有被 `applyBankImport` 用掉，就按令牌回滚，令牌已用掉时是空操作。进程异常退出：SQLite 自动回滚；提交后退出：`recoverPositionImportWorkerExit` 按提交链与 ready 消息重建结果。

### 3.2 链接原始表（`SOURCE_IMPORT`，`source-import.js`）

1. 全部文件复制到暂存目录并算 SHA-256；`runPositionSideDbMutation` 开事务。
2. 外层 `SAVEPOINT position_source_attempt`；每个文件一个 `SAVEPOINT position_source_file`：识别表头 → 登记版本号 → 流式逐行取必用列 → `classifySourceRow` 判定正常 / 过滤 → 正常行算记录标识并写 `position_source_rows`（命中同标识时逐值比较，相同则折叠并更新文件血缘，不同则报 `position-source-record-hash-collision`），过滤行写 `position_filtered_source_rows` 与临时表 `position_import_filtered_payload`。
3. 文件级错误（表头不识别、结构不符、读取出错）只回滚该文件的 savepoint 并记为失败；数据库错误（`ERR_SQLITE*`）、取消、侧库状态异常中止整批。
4. 全部读完后统一裁决「过滤行与正常记录（同批任一文件或库内已有）同业务单号」：所有通过文件级校验的正常记录都在库里时一次判定，命中的文件全部加入排除表，回滚到外层 savepoint 整轮重读。不在读完单个文件时判：那时回滚该文件会连它的正常记录一起撤掉，别的文件就查不到与这些记录的冲突，被拒文件的集合会随文件顺序而变（与 v3.2.21 预检的整批判定一致）。冲突按「哪些文件含这条过滤行」判：每个文件出现过的过滤业务单号在折叠之前登记到事务内临时表 `position_import_filtered_keys`。跨文件完全相同的过滤行只保留一条过滤记录（记在先读到的文件名下），若只按过滤记录判，后读到的文件就看不出它也含这条过滤行。异常报告写失败同样把含过滤行的文件排除后重读。
5. 重建受影响来源类型的链接行（`writeLinkRows`）与摘要缓存，写一份异常报告（`anomaly-report.js` 从临时表读过滤行，写出后算一次 SHA-256 作存档凭证）。
6. 发 `PREFLIGHT_READY`（逐文件结果、文件凭证、报告凭证、清单摘要）并暂停；Main 把凭证持久化到 pending 后发 `APPLY_GRANTED`。授权须 jobId、清单摘要、operation token、batch owner、基准 checkpoint 全部一致；有可提交文件时拒绝 `preflightOnly`。过滤记录里的报告键（`report_artifact_key`）保持生成报告时的键：存档批次的删除保护（`archive-report-delete-protection.js`）与运行冻结都按它核对；存档条目自己的键由文件计划另行分配，生成键登记在条目的 `preGeneratedOutput.producerArtifactKey`。
7. 比对暂存文件身份快照 → 写文件凭证 → 推进 checkpoint 一次 → `COMMIT` → 截断 WAL。没有任何可提交文件时内部以 `NothingToCommit` 回滚，checkpoint 不动。

### 3.3 清结算银行账户表（`account-import.js`）

账户表随来源批次读取时只做统计（有效行数、读取行数、sheet），不写库，结果为 `needs-confirmation`，暂存目录保留。用户确认后 `ACCOUNT_APPLY` 重读同一份暂存文件整表替换：读取前后各比对一次文件身份快照，并核对确认时的行数 / sheet，任何一项不一致即拒绝、旧账户表不变；登记新版本、旧版本标为 superseded、重建账户链接行。这样主进程不持有整表数据。

### 3.4 维护命令（`maintenance-writer.js`）

删除来源、映射重建等仍在导入进程里以单事务执行，改用公共的结构核对与连接参数；来源删除后把已无行的版本标为 superseded。

### 3.5 写锁与并发

导入进程从启动到结束持有或即将持有侧库写锁。主进程的其他写操作（`store._mutation`、其他导入与维护命令）经 `assertNoImportHoldingWriteLock` 直接报错，不排队等锁：银行等待覆盖确认时报 `position-bank-import-awaiting-confirmation`，其余导入进行中报 `position-import-in-progress`。

### 3.6 暂存副本回收

暂存副本在三处被引用：存档中心未完成的条目、主库里的待完成操作记录（pending）、主进程里的活动导入与待确认令牌。回收点有两个：存档完成时的来源释放回调，以及任务收尾。改造前（v3.2.21 同样如此）两处都被尚未清除的 pending 挡住，pending 清除后又没有再触发，副本只能等 7 天后的启动清理。现在 `task-owner.js` 的 `finalizePositionOwnedPending` 在清除 pending 后对它登记的文件补一次回收；仍未存档的文件、活动导入的作业目录继续受保护。待确认账户表的令牌除作业根目录外单独登记它的暂存文件（保护规则按「目标目录内是否含受保护路径」判断，只登记根目录护不住其下的文件目录）。异常报告的暂存文件随作业目录一并删除，之后的导出从存档中心取回：`findArchivedPositionReportArtifact` 按侧库记录的生成键在原批次里找报告条目（集成脚本 `position-anomaly-report-archive-recall.js` 用真实存档库走完导入 → 回收 → 导出）。原来的回退逻辑直接拿生成键当条目键去查，查不到（v3.2.21 起如此，暂存要 7 天后才回收所以没暴露），回收提前后必须一并修正。

### 3.7 删除的代码

`preflight.js`、`ledger.js`、`bank-writer.js`、`source-writer.js`、`account-writer.js`、`apply-grant.js`、`contracts.js`、`large-import-schema.js` 及其专属测试；`BANK_PREPARE` / `BANK_APPLY` / `SOURCE_PREPARE_AND_APPLY` / `ENSURE_LARGE_IMPORT_INDEXES` 四个命令在导入进程里收到即拒绝（常量保留，B135 / B37）。主进程不再派发结构迁移进程，也不再做 `foreign_key_check` 与整库 `quick_check`。

## 4. 存储结构（侧库结构版本 3）

主进程建库时直接建成最终形态，导入进程只核对 `position_meta.position_schema_version`。

- `position_raw_files`：`version`（自增，即版本号）、`kind`（bank / 各来源类型）、原始文件名 / 路径、sheet、大小、`sha256`、行数、`status`（active / superseded）、`operation_token`、`archive_batch_number`、导入与被替换时间。
- `position_bank_rows`：索引列（`biz_id` 唯一、`channel`、`month_key`、`bill_date`、`status`、`import_order`、两个资金性质、三个审计列）+ `raw_version`、`raw_row_number` + 12 个交互字段值列 + 3 个覆盖列（BizId / Channel / FundType 的原值与规范化值不同时才存）。值列不声明类型，数字按数字、文本按文本保存；日期、布尔以「前缀 + JSON 标记」保存并在读取时还原，取值与原来经 JSON 往返的结果一致；原文本身以该前缀开头时按 JSON 字符串保存，读回仍是原文。列映射与换算集中在 `position-reconciliation/bank-row-storage.js`。
- `position_run_rows`：去掉 `result_json`；`original_json` 为交互字段 + 原始版本号 / 行号。
- `position_source_rows`：`source_type`、`business_key`、`raw_version`、`source_row_number`、`row_hash`、`fields_json`（只含该来源的必用列），`UNIQUE(source_type, row_hash)`。记录标识与字段取舍集中在 `position-reconciliation/source-row-storage.js`；账户表的标识另含行号（内容相同的物理行不折叠）。标识、相等判断与落库用同一套带类型的表示：日期单元格与内容相同的 ISO 文本是两个值。这套标识算法对应结构版本 3；开发期间的版本 2 用的是不区分两者的算法，两种标识不能在同一个库里混用（含日期的同一条记录重导时会查不到旧记录而重复入库），版本 2 的库按旧库丢弃。版本 2 没有随任何正式版本发布。
- `position_filtered_source_rows`：以 `raw_version` 取代原来的文件路径 / 文件名 / sheet 三列，读取时经版本记录取回文件名与 sheet；`report_row_key` 为 `<jobId>#<文件序号>#<行号>`。
- `position_link_rows` / `position_consumed_sources`：直接带 `source_record_key`，不再有旧身份模式的分支。账户链接行的币种取「币种」列，列为 5 个必用列。
- 内存中的银行行对象字段为 `POSITION_BANK_ROW_FIELDS`（15 个交互字段 + 原始版本号 + 原始行号）；导出 / 回导列 `POSITION_BANK_HEADERS` = 3 个审计列 + 这 17 列，共 20 列。结果模板 `assets/平盘银行对账单.xlsx` 已按新表头重建。`assets/清结算银行账户表.xlsx` 同时是账户表的导入识别结构，保持 40 列不变。
- 旧结构的库不迁移：`main.js` 启动时 `discardOutdatedPositionSideDb` 先清空主库里的 checkpoint / bootstrap / pending 绑定、再删除旧库，之后按全新侧库初始化。顺序不能反：三项写入可重复执行，删除放最后，任何一步中断后旧库还在，下次启动会重做；先删库则会留下「绑定还在、库已不存在」无法自愈的状态。
- 只丢弃能认出是旧版本结构的库：有整数版本标记且低于当前版本，或没有版本标记但银行行表带 `original_json` / `working_json` 两列（v3.2.22 之前各版本的共同特征）。没有任何平盘表的文件、只有零散 `position_` 表的文件、版本标记损坏的库都不删除，由 store 按原有的「侧库不完整」阻断。

## 5. 兼容与影响

- 银行结果 / 银行数据导出由 49 列变为 20 列（spec D1）；回导只接受 20 列并逐列比对（含原始版本号 / 行号）。旧版本导出的 49 列结果文件不能再回导，也不再被银行导入接受。
- 原始表导出为必用列 + 原始版本号 / 行号；账户链接表导出为 5 列；异常报告与运行过滤数据导出的明细列为固定信息列（末尾加「原始版本号」）+ 必用列，整批一份、不再分片。
- 「设置 → 模板文件」里已启用的「平盘银行对账单」用户版本（49 列）会在导出时校验失败，需恢复默认或按 20 列重新导入。
- 链接原始表从「每份文件各自生效、各推进一次 checkpoint」变为「整批生效一次」。
- 后台 managed 导入适配器（生产未启用）的 intents 指向已停用的命令（B37 已补充）。
- 匹配规则、差异口径、日期 / 金额解析口径未改。

## 6. 对账专项审查（改动涉及身份、幂等、血缘、输出契约）

| 项 | 结论 | 证据 |
| --- | --- | --- |
| 主键与血缘 | 银行行、来源行 → `raw_version` + 行号 → 版本记录 → 存档批次号；版本号在事务内分配，取消 / 失败不留记录。来源记录标识仍是链接行、消费关系、运行血缘的键 | `position-bank-single-pass-import.test.js`、`position-source-single-pass-import.test.js`、`position-reconciliation-import-preflight.test.js` |
| 行数守恒 | 读取行数、写入行数、各范围 / 各文件行数、版本记录行数在提交前核对；恢复时按范围、`import_order` 连续性、版本记录行数再核对 | `bank-import.js`、`source-import.js`、`import-recovery.js` |
| 幂等 / 重复 | 银行：文件内重复、跨范围冲突整批拒绝，范围整体替换。来源：内容相同折叠、同单号不同内容各自保留、标识相同内容不同中止。同文件重导得到新版本号，旧版本转 superseded | 同上测试；真实应用实测 |
| 金额 / 币种 / 日期 | 读取器未改；值按原类型保存，BillDate 原值保留，引擎读到的值与改造前一致 | `position-reconciliation-service.test.js` 日期往返与回导篡改用例、`position-reconciliation-side-db-parity.js` 42 项 |
| 状态 / 部分失败 | 单事务；提交前其他连接只见旧数据；失败、取消、进程退出均回滚。来源的文件级错误只影响该文件 | 单遍导入测试（银行 8 项、来源 9 项） |
| 输出契约 | 导出 / 回导列变化为用户决定（D1） | spec §3.2 |

**资金红线，须人工复核：**

1. 旧结构侧库启动即丢弃（D4）。前提是所有使用者的平盘侧库都没有需要保留的数据；一旦有人已用平盘做过确认，升级会清掉已确认结果与消费关系。
2. 银行覆盖替换改为「读到哪个渠道 + 月份就先删哪个范围的旧行」，冲突行挂起到末尾补写。结果与原先「先删全部范围再写」一致，但实现路径不同，建议用真实多月份文件核对一次替换结果。
3. 导出只含交互字段 / 必用列后，下游若仍按全列使用结果文件、原始表导出、账户链接表会缺列；旧 49 列结果不能回导。
4. 运行结果行完整性摘要的输入变了（结果行改为推导）；只影响新结构的库，无旧数据需要兼容。
5. 链接原始表的判重范围收窄为必用列：两行只在非必用列上不同，以前是两条记录，现在折叠为一条。若存在「必用列完全相同但确属两笔业务」的来源数据，会少一条可供匹配的记录。
6. 链接原始表整批一次提交：一批里任何一份文件触发数据库错误会让整批作废（以前已提交的文件保留）。文件级错误仍只拒绝单个文件。
7. 导入进行中其他写操作被直接拒绝。界面异常重载时导入会一直占着写锁，重新点一次导入（会作废上一次）或重启可解除。
8. 暂存副本改为任务收尾即删。依赖前提是存档条目已完成或仍被未完成清单保护；实测覆盖了导入、账户确认、重导三种路径，未覆盖存档位置离线后重试的路径（保护逻辑未改，由未完成清单兜住）。

## 7. 验证记录

| 命令 | 结果 |
| --- | --- |
| `npm run lint`、`npm run check:architecture` | 通过 |
| `npm run test:unit`（2026-11-23，四步完成后） | 9042 通过 / 0 失败 / 4 跳过 |
| `node scripts/integration/position-input-template-version.js` | 4/4 |
| `node scripts/integration/position-reconciliation-side-db-parity.js` | 42/42 |
| `node scripts/integration/position-startup-task-recovery.js` | 3/3 |
| `node scripts/integration/bank-statement-input-template-version.js` | 6/6 |
| `npm run benchmark:position-import -- --kind=bank --apply` / `--kind=source --apply`（各 100 万行） | 见 §1 |
| 真实应用实测（临时数据目录，替换系统对话框，脚本不入库）：银行导入 2 行 → 一批 3 份来源（调拨 2 行 + 1 过滤行、出账 1 行、账户表待确认）→ 账户确认 → 同文件重导 → 三种导出 → 打开「对账数据管理」「链接表管理」「链接原始表」截图 | 全部符合预期：版本号 V1–V5 均带存档批次号，重导后旧版本为 superseded；银行导出 20 列、原始表导出必用列 + 版本号 / 行号、账户链接表 5 列；两处界面显示「原始版本」列；15 条存档条目全部就绪，结束时暂存目录为空 |
| `npm run release-check`（2026-11-23，首次提交 `361ccd05`） | 通过：lint、架构检查、smoke、单测 9042 通过 / 0 失败 / 4 跳过、90 个集成脚本全部通过（已按规则回写 `rules/integration-test-policy.md`「七」） |

### Codex 审查（第一轮，2026-11-23，`codex review --base v3.2.21`）

9 条 P1、5 条 P2，逐条对照代码核实均属实，全部修复并补回归测试：

| 结论 | 处理 |
| --- | --- |
| 暂存报告回收后异常报告取不回（库里记的是生成键，回退逻辑却拿它当存档条目键去查） | 取回时按条目登记的生成键查找；库里的键不动。真实应用实测回收后导出成功。第一版修法是把库里的键改写成存档键，`release-check` 里存档批次删除保护的两条用例随即失败（保护按生成键核对），已撤回 |
| 互为「过滤行撞对方正常记录」的两份文件只拒绝后读的那份 | 改为全部读完后统一裁决 |
| 写库时的数据库错误被读取器包装成坏工作簿，其余文件仍提交 | 读取器原样上抛回调错误 |
| 写入授权之后到达的取消被应答为已接受，但仍然提交 | 授权即进入不可取消阶段，提交前再核一次 |
| 银行确认写入未被任务接管时导入进程一直占着写锁 | `onAbandon` 与模块锁被占时按令牌放弃 |
| 旧库删除与主库解绑之间中断后无法自愈 | 先解绑后删除 |
| 任意带 `position_` 表或版本标记损坏的库都会被当旧库删除 | 只丢弃能认出的旧结构 |
| 授权后提交失败时导入进程删除已交接给 Main 的暂存文件 | 授权后不再删除 |
| 账户表重读期间文件被替换成同 sheet 同行数的另一份不被发现 | 读完再核一次身份快照 |
| 磁盘门禁行数恒为 0 | 按暂存文件大小估算增长 |
| 银行冲突行全部缓存在内存 | 改存事务内临时表 |
| 与类型标记同前缀的原文读回出错或变成布尔 | 可逆转义 |
| 日期单元格与同内容 ISO 文本标识相同、相等判断不同 | 统一用带类型的表示 |
| 异常报告把日期写成内部标记的 JSON 文本 | 按配套方式还原日期 |

修复后重跑 `npm run release-check`（2026-11-23，修复的最终代码）：通过，lint、架构检查、smoke、单测 9051 通过 / 0 失败 / 4 跳过、90 个集成脚本全部通过（集成用例数未变，`rules/integration-test-policy.md` 无回写）。修复未再经 Codex 复审。

对账专项补充（§6 资金红线第 8 项）：暂存报告回收后，异常报告与运行过滤数据的导出、以及含过滤行的运行确认都改从存档取报告；存档批次被永久删除前仍由删除保护按生成键拦住（`archive-position-fileplan-delete.test.js`）。

### Codex 审查（第二轮，2026-11-23，`codex review --commit 62337f95`）

3 条 P1、3 条 P2，逐条对照代码核实均属实，全部修复并补回归测试：

| 结论 | 处理 |
| --- | --- |
| 跨文件完全相同的过滤行被折叠后，后读到的文件 `filteredRows` 为 0，批末裁决看不到它，被拒文件随选择顺序变化 | 折叠前按文件登记过滤业务单号，冲突按登记判；三份文件三种顺序结果一致 |
| 模块锁被占时放弃导入，导入进程删除了存档清单已登记的暂存原件 | 暂存归属改为「就绪结果发出后归 Main」：导入进程只回滚，调度层按保护规则回收。同一问题也存在于授权器失败、checkpoint 已变等拒绝路径，一并覆盖 |
| 首次 Recovery Hold 检查在 prepare 之前拒绝银行确认，`onAbandon` 尚未登记，导入进程一直占着写锁 | 「确认写入」调用结束时按令牌兜底回滚（`afterInvocation`） |
| 异常报告日期按本地时间读、按 UTC 写，非 UTC 时区偏移一个时区（东八区 01:30 变成前一天 17:30） | 写出前把本地日历日期时间搬到 UTC；往返断言序号相等，另在固定东八区的子进程里验证 |
| 同一结构版本下换了来源记录标识算法，用上一提交写过数据的库重导含日期的记录会重复入库 | 结构版本升到 3，版本 2 的库按旧库丢弃（只影响跑过上一提交的开发库） |
| 异常报告取回的测试用手写仓库夹具，真实文件计划不再登记生成键也能通过 | 新增集成脚本 `position-anomaly-report-archive-recall.js`：真实存档库、任务生命周期、Main 取回函数原样执行 |

修复后重跑 `npm run release-check`（2026-11-23，第二轮修复的最终代码）：通过，lint、架构检查、smoke、单测 9058 通过 / 0 失败 / 4 跳过、91 个集成脚本全部通过（新增 1 个脚本，已按规则回写 `rules/integration-test-policy.md`「七」）；真实应用实测复跑通过（16 条存档条目全部就绪，结束时暂存目录为空）。第二轮修复未再经 Codex 复审。

未做（B139）：界面人工点按、Windows 实机、真实 1.2GB 文件。
