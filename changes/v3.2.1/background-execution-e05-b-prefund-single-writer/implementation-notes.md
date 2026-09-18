# v3.2.1 E05-B Implementation Notes

## Baseline

- Goal/spec：冻结 v3.2.1 Spec §5-§11、TechDoc §5-§15、Platform Contract v1、Lifecycle Mapping v1 与 RecoverySourceV1。
- Initial plan：[preflight.md](./preflight.md)。
- Done when：parent single Writer、per-file critical/receipt/inspector/recovery hold与旧业务 parity均有可复现证据；production.enabled保持false。

## Decisions

| 决定 | 原因与证据 | 放弃的方案 | 影响 |
| --- | --- | --- | --- |
| 一个 parent job持有单一 Writer transport，unit按 fileIndex动态派发。 | 冻结 action=`thread-pool/job`、parent unit与单 Writer实例合同；E05-B允许parser=1。 | 每文件spawn独立job/Worker。 | N文件只建一个Writer；每文件仍有独立operationKey/intent/receipt。 |
| generic Supervisor原生拥有worker-durable handshake。 | 当前真实平台gap；Main Control Plane必须持有协议、cancel/shutdown与protected。 | 模块私有协议client或测试only seam。 | 其它commit kind保持原行为；worker-durable须注入唯一critical delegate。 |
| 旧 store parser路径与新 spool路径共享同一transaction core。 | 金额/身份/sequence/version语义不能靠复制保持。 | 在Writer复制SQL。 | legacy与managed可做同输入数据库parity。 |
| Hold scope是 `(sourceType, sourceBatch)` 稳定不透明SHA-256，且只在身份已只读解析后gate。 | replacement/repair的业务身份；月份不是冲突身份，同月不同批不应互阻。 | 月级scope、按taskKey全局阻断。 | import/repair同批互阻；delete/date-range/clear仅按其证据破坏范围阻断。 |
| runtime/CompoundLease先于Parser启动；每个固定unit以durable parser-outcome sidecar发布成功或safe error。 | Parser与Writer必须都落在同一parent resource graph，且不能用missing spool模拟parser error。 | 先parse全部文件、每文件重启Writer。 | E05-B Parser严格单飞；repair也申报Writer phase + exactly-one Parser child。 |
| Supervisor deferred start在返回的terminal Promise上附带`dispatchAccepted`权威证据。 | Main只能在`unit:start`成功送入transport后转移spool cleanup ownership，不能猜微任务/state。 | `Promise.resolve()+snapshot`时序推断。 | pre-dispatch失败由Main清理；post-dispatch由Writer清理；critical不确定证据不被Main删除。 |
| Inspector按全体PreFund Side DB核对operation mutation。 | 单库receipt合法不足以排除跨月重复mutation。 | 只信receipt所在月batch。 | inserted/replaced全局恰好一个且定位到receipt batch；noop全局零本operation mutation，否则unknown/Hold。 |
| spool严格验证固定为pre-critical首遍 + ACK后transaction streaming遍。 | 首遍完成hash/count/source identity验证后才允许critical；第二遍逐record重验并写入，末尾TOCTOU失败整体rollback。 | Store先完整重验再为callback第三遍扫描。 | rows/issues各总计两遍；不弱化hash/count/source snapshot/lineage验证。 |
| strict row error复用`createMptRowAggregateError`并只携带bounded sample。 | legacy与managed必须保持可定位detail及repair UX；spool issue的rawLine/fields不得进入result。 | Writer仅构造计数消息或复制完整issue。 | managed与legacy同文件的公开错误shape精确一致；sample仅行号+generic message。 |
| transport在dispatch后、critical前丢失时由Supervisor以`cleanupOwnership:'main'`显式交还当前file staging。 | `dispatchAccepted`只证明交接，不能证明Worker已经完成cleanup；普通transport crash由Inspector/critical state证明不是资金不确定后才可交还。 | 永久以`writerOwned`跳过Main cleanup；用微任务时序猜owner。 | precritical/not-committed为普通file失败并清净staging；committed-lost/unknown仍保留Writer/recovery证据。 |
| 首次Critical Intent的`create-prepared`与`mark-acked`在同一RecoveryControl transaction提交。 | Worker尚未收到ACK时，分步持久化失败不得留下当前进程无法追踪的open prepared Intent。 | 留到下次启动扫描；把pre-ACK失败升级为Recovery Hold。 | 第二步注入失败整体回滚，不发ACK、不建Hold；正常/exact replay合同不变。 |
| Parser sidecar、Writer file result与parent validator复用同一safe error边界，并按import/repair exact public shape校验。 | sealed读取与`job:done`都属于独立privacy边界；构造器过滤不能替代消费者exact validation。 | 只过滤Parser message；parent浅层shape；复制多套path regex。 | 拒绝unsafe code、单段/多段POSIX、Windows、UNC与额外字段；正常URL/自然语言斜杠保留；cleanup内部字段不外泄。 |
| date-range Hold gate与删除共享service/store权威归一化range。 | raw payload与trim后的实际删除范围不一致可绕过active Hold。 | gate与delete各自比较原始字符串。 | 带空白的合法payload仍按真实受影响batch scope阻断，范围外batch不误阻。⚠️ 资金红线，请人工复核。 |
| finance-safe-v1通过既有action result-validator binding注入PreFund exact domain value delegate。 | 合法超长十进制sequence、batch suffix、UUID/file operation与opaque intent SHA会被通用full-account启发式误杀，且receipt/result属于COMMIT后边界。 | 在generic error codec内硬编码MPT grammar；全局放行长数字或hash；仅修`safeMptFileName`。 | 公共privacy walker保持业务无关；仅PreFund action的exact field+grammar放行，message/detailLines与arbitrary account-like identifier继续拒绝。 |
| file operation privacy grammar只接受两个冻结TaskPolicy prefix。 | 真实parent operation是`taskKey:taskRunId`而非裸UUID。 | 放行裸UUID或任意task prefix。 | 仅`pre-fund-reconciliation:import-mpt:<uuid>/file/NNNNNN`与`pre-fund-reconciliation:mpt-errors:repair:<uuid>/file/NNNNNN`可通过，并与同payload fileIndex交叉校验。 |
| Worker `commit:receipt`只作为提交观察信号，Main在`mark-committed`前读取Side DB authoritative receipt并复用canonical Inspector。 | Worker payload不是资金提交权威；Intent、消息receipt、Side DB receipt、batch lineage与实际行数必须唯一一致。 | 只核对receipt id/action/operation/task；只信Worker payload后持久mark-committed。 | inserted/replaced/noop均做exact shape、identity、dataset/version与真实业务证据交叉核验；冲突继续由唯一Inspector判定，不能被后续`unit:done/job:done`覆盖。⚠️ 资金红线，请人工复核。 |
| worker-durable unit一旦由Inspector判为`committed-lost`或`unknown`，Supervisor立即以parent recovery终态收口。 | 非末unit若只settle terminal Promise，单Writer仍等待下一unit且CompoundLease无界占用。 | 由managed调用层补cancel；等待Worker自行退出。 | Supervisor强制有界结束transport、取消未启动unit并释放lease；managed在抛出前等待`control.promise` cleanup barrier；pre-critical普通错误仍继续后续file。 |
| transport terminate/close或resource lease release失败使整体execution使用既有`failed`终态，并保留cleanup ownership供shutdown重试。 | 冻结合同要求cleanup failure被记录且不得报告成功；业务result与cleanup ownership是两类事实。 | 仅诊断cleanup错误但继续`completed`；失败后丢弃lease/transport ownership。 | 已校验业务result可保留，整体不成功；成功重试清除leak，持续失败进入shutdown report。 |
| Parser/Writer公开错误复用同一PreFund path-safe边界识别引号包裹的Node fs.Error。 | 单/双引号中的POSIX、Windows drive与UNC绝对路径可经sidecar或parent result泄露。 | 只识别空格/冒号后的未加引号路径；静默丢弃unsafe detail。 | unsafe message使用稳定业务fallback；detail保留safe项并以单条稳定占位替代unsafe项；URL与普通`a/b`文案不误伤。 |
| exact receipt version-shape把historical migration v0视为合法版本起点。 | additive migration明确将旧batch回填`dataset_version=0`；共享transaction core会合法生成noop `0→0`与replacement `0→1`。 | 把所有非insert receipt错误限定为before>=1，导致已COMMIT的v0操作被误报RESULT_LOST。 | replaced/noop接受非负安全整数起点，仍分别强制`after=before+1`/`after=before`；inserted保持`null→1`，负数、非安全整数与跨步继续fail closed。⚠️ 资金红线，请人工复核。 |

## Assumptions

| 假设 | 依据 | 失效影响 | 验证与回滚 |
| --- | --- | --- | --- |
| E05-B capability parser数固定1。 | E05-C才拥有Pool>1与性能门禁。 | 无并行收益，但合同能力完整。 | runtime real-worker max concurrency测试=1；production仍false/effectiveWorkerCount=0。 |

## Deviations

| 原计划 | 实际方案 | 原因 | 影响 | Spec 已同步 |
| --- | --- | --- | --- | --- |
| repair policy无CompoundLease | repair使用冻结Writer phase 192MiB + childrenMax=1 Parser child 256MiB | 实际执行图同时存在Parser/Writer；Parser Core与import相同，不能错误复用192MiB Writer资源。 | runtime预算可容纳精确组合；production gate不变。 | 冻结TechDoc §12已有“Parser + Writer图申请CompoundLease”，policy fixture保留repair Writer 192MiB。 |
| parser error由Coordinator内存传递 | 固定identity的fsync/rename sidecar，exact safe schema | 单Writer transport只能消费预注册unit；错误不能靠missing spool或input override表达。 | sidecar纳入known-file cleanup、tamper/path/privacy测试。 | 无public/data schema变更。 |
| generic Supervisor过去在`job:done`后cleanup失败仍返回`completed` | cleanup失败返回既有`failed` outcome、保留已验证result与可重试ownership | Reviewer确认该行为违反冻结“cleanup failures recorded, never success” | 调用方继续以`outcome`判成功；未新增public字段或终态枚举。 | 无冻结合同偏差；修正既有实现偏差。 |
| receipt authority曾把historical v0误作非法shape | version下界由1修正为0，其他exact identity与Side DB/Inspector authority不变 | 正式迁移与receipt transaction core已证明v0可达 | 避免合法COMMIT后误建RESULT_LOST Hold；没有迁移、schema或public shape变化。 | 无冻结合同偏差；恢复历史兼容语义。 |

## Evidence

| 证据 | 结果 | 覆盖的行为/风险 |
| --- | --- | --- |
| E05-B/E05-A/E05-P0/Service/Supervisor/Recovery/E04定向unit | `218/218 PASS` | transaction receipt/replay、Inspector、Hold、shutdown、parser lifecycle、mixed golden、repair token、shared runtime零回归。 |
| Background Recovery Control integration | `27/27 PASS` | RecoveryControl DDL/CAS/event与启动恢复。 |
| Background Recovery canary integration | `9/9 PASS` | durable inspector/provider与directory fsync。 |
| PreFund Side DB parity integration | `69/69 PASS` | 金额/币种/sequence/version/候选与side DB业务语义。 |
| E05-B real runtime/fault tests | PASS | parent单Writer；Parser max concurrent=1；message+clean exit；result后nonzero crash；active shutdown cleanup；sealed submit failure不二次写；cleanup failure保持Writer权威结果。 |
| Inspector duplicate mutation fault | PASS | 合法receipt/batch + 另一Side DB重复operation mutation => unknown，真实global count=2。 |
| exact scope/legacy mutation side doors | PASS | 同批import/repair/delete阻断，同月不同批放行；range/clear覆盖；prepare后换header仍在BEGIN/ACK前拒绝。 |
| Worker transport fault classification | PASS | pre-critical与ACK后`not-committed`均为普通file error；仅`committed-lost/unknown`返回interrupted/Hold。 |
| spool pass counter + strict result parity | PASS | rows/issues首遍+transaction遍各2次；managed/legacy `code/message/detailLines/rowErrorCount/canRepair/sourceType`一致。 |
| parser privacy boundary | PASS | `/private/tmp/...` OS error转稳定safe result，首file失败后续继续，结果/progress无路径。 |
| Main cleanup ownership counter | PASS | active shutdown下当前与未来未dispatch file各由Main cleanup delegate调用恰好1次；parent parser终止只由外层catch统一清理。 |
| 本轮项目负责人findings定向unit | `234/234 PASS` | dispatch后precritical transport exit清理交还、prepared→acked原子回滚、sidecar tamper code、单段POSIX/Windows/UNC隐私、Writer parent result exact validator、date-range trim Hold gate、repair 192+256MiB资源。 |
| 本轮 Recovery/Side DB integration | `27/27`、`9/9`、`69/69 PASS` | RecoveryControl事务/CAS、durable recovery canary，以及PreFund金额/币种/source sequence/version/候选与side DB parity不漂移。 |
| 本轮静态验证 | affected ESLint、14个JS `node --check`、`git diff --check` PASS | 新共享privacy helper、Main/runtime/store/service/worker/supervisor与测试均通过语法、风格和whitespace检查。 |
| long sequence完整managed protocol回归 | PASS | canonical long `fileName/sourceFileSequence/sourceBatch`、UUID `datasetId/producerTaskRunId/fileOperationKey`与deterministic opaque `intentId`贯穿critical-ready→ACK→receipt→unit/job done；COMMIT后validator不误报，结果保留legacy basename。 |
| finance-safe窄域反例 | PASS | arbitrary account-like filename、错误sequence/fileIndex、以及相同数字或opaque ID放入message时仍为`PRIVACY_VALUE_FORBIDDEN`；generic profile未全局放行MPT值。 |
| long numeric batch strict parity | PASS | `managedRepairEvidence`无sourceDate时仍以exact sourceType+sourceBatch grammar通过完整job result，legacy/managed row-error detail与repair shape一致。 |
| production TaskLifecycle operation identity | PASS | deterministic digit-run UUID使用真实import `taskKey:taskRunId/file`贯穿完整managed protocol；repair prefix正例通过，裸UUID、任意prefix、run task与fileIndex mismatch均拒绝。 |
| Reviewer四项修复扩展unit（18个相关test files） | `416/416 PASS` | receipt authoritative exact evidence、非末committed/unknown parent终结、pre-critical继续、quoted fs path、terminate/close/resource release失败与正常cleanup回归。 |
| receipt authority模块定向 | `35/35 PASS` | inserted/replaced/noop exact receipt+batch actual evidence；不完整receipt拒绝；canonical Inspector identity/schema/evidenceHash复核；拒绝后Intent保持acked并由Inspector形成RESULT_LOST Hold。⚠️ 资金红线，请人工复核。 |
| 本轮平台与资金integration | RecoveryControl `27/27`、recovery canary `9/9`、pure-compute canary `9/9`、PreFund Side DB parity `69/69 PASS` | Control transaction/CAS/startup recovery、共享Supervisor兼容，以及金额/币种/source sequence/dataset version/候选与Side DB语义不漂移。 |
| Main startup contract | `7/7 PASS` | 新receipt authority wiring未改变DB→IPC→window启动屏障、loader与VCC gate入口。 |
| Reviewer修复静态验证 | affected ESLint、9个改动JS `node --check`、`git diff --check` PASS | Main wiring、receipt authority、Supervisor cleanup/recovery终态、privacy helper及其测试通过语法、风格与whitespace门禁。 |
| historical v0 receipt authority定向 | E05-B `36/36 PASS`；相关PreFund六文件 `133/133 PASS` | 真实store历史batch→删除archive columns→additive migration回填v0→validated spool→同事务receipt→Inspector→authority；repair noop `0→0`、import replacement `0→1`及其exact same-operation replay与v1+正例通过，负数/非安全整数/跨步/伪inserted反例拒绝。⚠️ 资金红线，请人工复核。 |
| historical v0相关integration | RecoveryControl `27/27`、recovery canary `9/9`、PreFund Side DB parity `69/69 PASS` | 恢复CAS/扫描与金额、币种、source sequence、dataset lineage、Side DB候选语义无漂移。 |
| historical v0静态验证 | affected ESLint、2个改动JS `node --check`、`git diff --check` PASS | version-shape谓词、真实迁移测试与implementation notes通过风格、语法和whitespace门禁。 |

## Remaining Unknowns

| 未知 | 处理 | 负责人/下一步 | 合并影响 |
| --- | --- | --- | --- |
| Windows packaged、人工资金与性能门禁 | BLOCK production enable | E05-C/R3.2.1负责人 | 不阻断E05-B capability；production保持false |
| Windows目录fsync与真实杀进程fault矩阵尚未在Windows人工执行 | 保留unknown，不伪造通过 | E05-C/最终版本负责人 | 不阻断本地capability；阻断production enable |
| date-range destructive Hold gate与同batch恢复证据的资金边界 | 已用真实Side DB与空白payload定向回归，仍要求人工复核 | 项目负责人 | ⚠️ 资金红线，请人工复核；production保持false |
| packaged Windows中的真实transport terminate/close与ResourceGovernor release失败恢复 | 本地以确定性fault injection覆盖失败、ownership保留及shutdown重试 | E05-C/最终版本负责人 | 不阻断E05-B capability；production保持false，人工门禁前不得宣称实机通过 |
| 真实客户历史Side DB中的v0 noop/replacement资金审计 | 自动测试使用真实迁移DDL与transaction core证明合同；仍需在脱敏历史库副本人工核对receipt/batch lineage | 项目负责人 | ⚠️ 资金红线，请人工复核；不阻断production=false capability |
