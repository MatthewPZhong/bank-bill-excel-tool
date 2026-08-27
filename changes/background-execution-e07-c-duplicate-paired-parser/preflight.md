# E07-C Duplicate Paired Parser Unknowns Preflight

## Task Brief

- Goal：在 E07-B durable receipt/recovery 不变量之上，为 production-false Duplicate managed import 增加可选 Bank/Document paired parser；两类 Parser 各写独立 task-private spool，Service 只在两侧完整校验后采用。
- Context：精确基线为三审 P0-P3=0 的 E07-B `1b5b77ab5829db234ae288cc24ca0f6de7bdeb7b`；冻结合同为 v3.2.2 Spec §1-§3、§6、§9-§13，TechDoc §2、§5-§6、§10-§12，implementation sequence 与 E07-A/B notes。
- Constraints：Parser 不读写 side/Main DB，不读取或消费 MPT/candidate，不复制 matching/normalizer/parser 业务逻辑；固定顺序为 reserve Service command → CompoundLease → parse separate spools → validate both → Service mutation/adopt；reservation 全程阻断 import/run/export；不扩 E08/Publisher/live；production 固定 false/single；禁止 `release-check`、`check-vars`、`scan:vars`。
- Done when：paired 与 single 业务结果、角色顺序、source ordinal、receipt/side post-image一致；任一 parse/validate/source-change/cancel/crash 发生在 Service mutation 前并保持零 adopt/零 DB mutation；spool ownership与cleanup exactly once；低资源/单 unit/未通过 gate 使用一个 Parser；本地五轮性能/RSS证据明确是否达到 15%，但不解除 Windows/RSS/资金人工门禁。

## 已确认事实

| 事实 | 证据 | 对方案的约束 |
| --- | --- | --- |
| Duplicate import policy 已冻结为 service-lifetime `thread-pool`、CompoundLease `childrenMax=4`、`lowMemoryBehavior=downgrade-to-single`，production=false。 | `src/main-process/duplicate-inbound-match/policies.js` 与冻结 policy fixture。 | 不改 policy/公共协议；paired 实际只需两个角色，Governor 的实际 child count 是唯一调度权威。 |
| Supervisor 会先 `ServiceHost.openJob()` 占用唯一 job，再基于既有 BaseLease 申请 CompoundLease，之后才发送 `job:start`。 | `supervisor.js#start()` / `acquireCompoundResources()`。 | 已满足 reservation→lease 时序；不能在 runtime.start 前先解析。 |
| `control.snapshot().topology.effectiveChildCount` 在 ready 后暴露 Governor 实际获批数量。 | `supervisor.js#snapshot()`；E05-C precedent。 | Main-side paired coordinator只按该值派发，不从 requested、CPU 或 production flag猜并发。 |
| 当前 Duplicate Worker 收到 `job:start` 即调用真实 managed Service；且 `duplicate:import` 是 `worker-durable`，任何 registered unit 的 `unit:done` 都必须有 critical ACK/receipt。 | `duplicate-inbound-match/worker-host.js#startJob()`；`supervisor.js#processMessage(unit:done)`。 | Parser spool不是business commit，不能伪造critical/receipt；paired mode使用零业务unit的private terminal outcome barrier，普通direct/single入口保持兼容。 |
| 当前 Service 先读完整 Bank 到内存，再在 side transaction 内流式读取 Document。 | `service.js#importFilesAfterInvalidation()`、`duplicate-inbound-match-store.js#createImportBundle()`。 | paired spool consumer必须复用相同 Bank映射/BizId验证与 Document reader语义，最终仍调用同一 store事务/receipt writer。 |
| E07-B replay在任何 cleanup/matching/side mutation前按 operation receipt拦截。 | `service.js#importFiles()` 与 E07-B tests。 | paired路径必须先解析/完整校验才能得到authoritative file hash；之后在任何side mutation前查receipt。exact replay不得消费spool到store、不得新增bundle/receipt或运行matching。 |
| Main不得持有完整业务rows/result。 | Spec §2、E07-A notes。 | Coordinator只持 bounded role/count/RSS/elapsed terminal；敏感 Bank/Document row只存在task-private spool与Service Worker。 |
| `runDuplicateParserWorker()` 只在真实 Worker `exit` 事件后 resolve/reject。 | `paired-parser-dispatch.js#runDuplicateParserWorker()`；100k Bank + tiny Document真实OS Worker测试。 | `Promise.allSettled(parserTasks)` 是现有合同内的Parser terminal barrier；parent reservation/CompoundLease不得在该barrier前释放。 |

## Unknowns Register

| 未知 | 类型 | 影响 | 可逆性 | 当前证据 | 处理 | 最便宜验证方式 | 当前决定 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 如何把 Governor 实际 child count用于 Parser，同时不扩公共 Protocol。 | 平台 seam | 高 | 一般 | count只在 Main `control.snapshot()`；Worker不应自行猜；worker-durable unit不能承载Parser artifact。 | PROBE | managed coordinator先start/ready，再按snapshot启动Parser；断言native实际1、隔离non-production实际2。 | 使用 module-private coordinator + 零业务unit的filesystem terminal outcome barrier；不新增operation/schema；P1仅增加exact-control内部teardown seam，不扩枚举API。 |
| exact replay是否必须先于 Parser。 | 幂等/资金 | 高 | 一般 | paired输入证据由两份源文件hash组成，未解析/取证前无法证明exact evidence；E07-B禁止的是cleanup/matching/side mutation重跑。 | PROBE | same operation二次调用记录side bundle/receipt/row count与spool cleanup。 | paired Parser与两侧完整校验先完成；Service随后receipt-first于任何side mutation。exact replay只恢复bounded session，side计数不增。 |
| 两侧spool如何证明source未变、角色不串、ordinal稳定。 | 血缘/TOCTOU | 高 | 一般 | Bank reader返回原数组序；Document reader流式给出sourceOrdinal。 | PROBE | role swap、manifest tamper、source after-parse变化、乱序完成测试。 | 固定role/job/op/source snapshot/hash/count/row digest；clean-exit success outcome后Service消费前完整首遍验证，事务COMMIT前按首次manifest digest再次验证。 |
| 解析失败后如何保证零 adopt/零 DB mutation。 | 部分失败 | 高 | 容易 | store事务只有Service双侧validate后才打开；policy是shutdown-only，普通`control.cancel()`不会被接受。 | PROBE | Bank失败、Document失败、一个manifest后crash、source变更，检查side/Main/adopt。 | Parser失败发布exact job/op/owner/slot的脱敏failure outcome；Service权威读到后自行terminal；Main等parent barrier再清理，不伪造普通cancel。 |
| terminal outcome文件系统失效时，何时可由coordinator强制终结parent。 | 资源生命周期 | 高 | 容易 | P1 exact-control teardown若在sibling Worker exit前执行，会提前释放job/CompoundLease并形成未记账活Worker窗口。 | PROBE | tiny Document + 100k Bank真实Worker；第二次outcome EACCES后在Bank exit前检查job/lease/dependency与冲突命令。 | marker失败先记录错误并abort；所有parserTasks `allSettled`后才触发exact-control transport failure，随后清理。 |
| cancel/crash时谁清 spool。 | 生命周期/隐私 | 高 | 一般 | Parser result只有clean exit后才可信；app quit是冻结的shutdown-only cancellation。 | PROBE | app shutdown、manifest后transport crash、Service pre-mutation failure。 | Main始终拥有task-private spool cleanup；只有parent terminal barrier后按已知文件删除并只`rmdir`空父目录；spool不作为durable recovery evidence。 |
| native资源与15%/RSS是否允许pair。 | 性能/门禁 | 高 | 容易 | E00 IO预算把native actual降1；darwin parser-only五轮改善40.18%、RSS低于声明预算。 | PROBE | standard runtime + 隔离non-production Governor，single/pair各5轮交替。 | 本地capability gate通过，但native/Windows/人工门禁未过；production仍single/false。 |
| Windows locked-file/Worker/RSS与真实资金样本是否通过。 | 外部门禁 | 高 | 容易 | 当前环境非 packaged Windows，合成fixture不能证明资金口径。 | BLOCK（production） | Windows packaged fault matrix与脱敏真实样本人工复核。 | 不阻断 false-gated E07-C 实现；明确阻断 enable。 |

## BLOCK 与保守假设

- 当前 implementation 没有需要用户决策的 BLOCK；Windows/RSS/真实资金是 production/manual gate。
- ASSUME：task-private spool 不是 durable business evidence，只有 E07-B side receipt/result 与 Main mirror是恢复权威；因此 pre-critical parser crash可在 clean barrier后删除spool。
- ASSUME：paired capability只接受精确两个输入并解析成唯一Bank/Document；单文件、gate disabled或资源降级使用single，未知/重复角色fail closed，不泛化成 N-file pool。
- ASSUME：本PR不改变 Bank/Document公开错误文案；若 parser transport失败，新增错误只返回bounded code/message，不包含本地路径或行内容。

## 风险优先计划

| 顺序 | 步骤 | 消除的未知/保护的不变量 | 成功证据 | 失败影响 | 回滚/收缩 |
| --- | --- | --- | --- | --- | --- |
| 1 | reservation + pure topology planner。 | Service command先于CompoundLease/Parser；actual count与lease一致。 | reservation冲突三命令；native downgrade1/isolated2矩阵。 | 入口旁路或超卖资源。 | topology固定1，保留direct import。 |
| 2 | role-separated spool contract/Parser core。 | Parser只读文件、角色/ordinal/source identity稳定、无DB依赖。 | dependency scan、golden parity、tamper/source-change测试。 | 输入血缘或隐私风险。 | 删除spool path，不接Service。 |
| 3 | private terminal outcome coordinator + Worker reservation。 | 先占Service、后lease/parse；两侧clean-exit success才Service；outcome写失败也必须在全部Parser exit后才释放；shutdown-only不被普通cancel旁路。 | completion乱序、busy冲突、success/failure outcome、真实Worker terminal barrier、app shutdown、manifest后crash零adopt/零DB。 | reservation旁路、未记账Worker或部分采用。 | paired gate关闭，direct single保留。 |
| 4 | Service spool consumer复用同一 store事务/receipt。 | Bank/Document顺序、行数、E07-B receipt/recovery不变量。 | single/paired side DB与receipt parity、exact replay side计数不增。 | 资金/恢复语义漂移。 | consumer停用，不改store schema。 |
| 5 | cleanup、RSS/perf、盲区与affected验证。 | 无敏感spool泄漏，不伪造production通过。 | fault matrix、5-run报告、unit/integration/static。 | 不能交付。 | production保持false/single并记录未通过门禁。 |
