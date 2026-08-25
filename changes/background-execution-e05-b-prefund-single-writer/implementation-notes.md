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

## Assumptions

| 假设 | 依据 | 失效影响 | 验证与回滚 |
| --- | --- | --- | --- |
| E05-B capability parser数固定1。 | E05-C才拥有Pool>1与性能门禁。 | 无并行收益，但合同能力完整。 | runtime real-worker max concurrency测试=1；production仍false/effectiveWorkerCount=0。 |

## Deviations

| 原计划 | 实际方案 | 原因 | 影响 | Spec 已同步 |
| --- | --- | --- | --- | --- |
| repair policy无CompoundLease | repair使用Writer phase + childrenMax=1 Parser child | 实际执行图同时存在Parser/Writer；只申报phase会漏算一个worker。 | runtime预算不变且可容纳；production gate不变。 | 冻结TechDoc §12已有“Parser + Writer图申请CompoundLease”；实现按其收紧。 |
| parser error由Coordinator内存传递 | 固定identity的fsync/rename sidecar，exact safe schema | 单Writer transport只能消费预注册unit；错误不能靠missing spool或input override表达。 | sidecar纳入known-file cleanup、tamper/path/privacy测试。 | 无public/data schema变更。 |

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

## Remaining Unknowns

| 未知 | 处理 | 负责人/下一步 | 合并影响 |
| --- | --- | --- | --- |
| Windows packaged、人工资金与性能门禁 | BLOCK production enable | E05-C/R3.2.1负责人 | 不阻断E05-B capability；production保持false |
| Windows目录fsync与真实杀进程fault矩阵尚未在Windows人工执行 | 保留unknown，不伪造通过 | E05-C/最终版本负责人 | 不阻断本地capability；阻断production enable |
