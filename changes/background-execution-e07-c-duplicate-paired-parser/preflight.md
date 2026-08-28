# E07-C Duplicate Paired Parser Unknowns Preflight

## Task Brief

- Goal：在 E07-B durable receipt/recovery 不变量之上，为 production-false Duplicate managed import 增加可选 Bank/Document paired parser；两类 Parser 各写独立 task-private spool，Service 只在两侧完整校验后采用。
- Context：精确基线为三审 P0-P3=0 的 E07-B `1b5b77ab5829db234ae288cc24ca0f6de7bdeb7b`；冻结合同为 v3.2.2 Spec §1-§3、§6、§9-§13，TechDoc §2、§5-§6、§10-§12，implementation sequence 与 E07-A/B notes。
- Constraints：Parser 不读写 side/Main DB，不读取或消费 MPT/candidate，不复制 matching/normalizer/parser 业务逻辑；固定顺序为 reserve Service command → CompoundLease → parse separate spools → validate both → Service mutation/adopt；reservation 全程阻断 import/run/export；不扩 E08/Publisher/live；production 固定 false/single；禁止 `release-check`、`check-vars`、`scan:vars`。
- Done when：paired 与 single 业务结果、角色顺序、source ordinal、receipt/side post-image一致；任一 parse/validate/source-change/cancel/crash 发生在 Service mutation 前并保持零 adopt/零 DB mutation；spool ownership唯一，cleanup成功终态 exactly once、失败保留同一owner幂等retry；低资源/单 unit/未通过 gate 使用一个 Parser；本地五轮性能/RSS证据明确是否达到 15%，但不解除 Windows/RSS/资金人工门禁。

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
| Service每10ms读取Parser outcome，正常failure marker同样会立即触发parent终态。 | `spool-reader.js#waitForDuplicateSpoolPairReady()`；坏表头Document + 100k Bank真实Worker测试。 | 不仅exact-control teardown，正常failure marker本身也必须延后到全部Parser exit后发布。 |
| Supervisor shutdown只拥有parent job/transport，不会自动等待Main coordinator的Parser Worker promise或dispatcher `finally`。 | Reviewer-isomorphic 100k Bank probe曾观察Supervisor job/CompoundLease/dependency归零并返回clean，而`rows.ndjson.ready`仍存在。 | paired coordinator必须把Worker terminal与spool cleanup纳入exact runtime的shutdown截止时间；不能把parent terminal误当完整finalization。 |

## Unknowns Register

| 未知 | 类型 | 影响 | 可逆性 | 当前证据 | 处理 | 最便宜验证方式 | 当前决定 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 如何把 Governor 实际 child count用于 Parser，同时不扩公共 Protocol。 | 平台 seam | 高 | 一般 | count只在 Main `control.snapshot()`；Worker不应自行猜；worker-durable unit不能承载Parser artifact。 | PROBE | managed coordinator先start/ready，再按snapshot启动Parser；断言native实际1、隔离non-production实际2。 | 使用 module-private coordinator + 零业务unit的filesystem terminal outcome barrier；不新增operation/schema；P1仅增加exact-control内部teardown seam，不扩枚举API。 |
| exact replay是否必须先于 Parser。 | 幂等/资金 | 高 | 一般 | paired输入证据由两份源文件hash组成，未解析/取证前无法证明exact evidence；E07-B禁止的是cleanup/matching/side mutation重跑。 | PROBE | same operation二次调用记录side bundle/receipt/row count与spool cleanup。 | paired Parser与两侧完整校验先完成；Service随后receipt-first于任何side mutation。exact replay只恢复bounded session，side计数不增。 |
| 两侧spool如何证明source未变、角色不串、ordinal稳定。 | 血缘/TOCTOU | 高 | 一般 | Bank reader返回原数组序；Document reader流式给出sourceOrdinal。 | PROBE | role swap、manifest tamper、source after-parse变化、乱序完成测试。 | 固定role/job/op/source snapshot/hash/count/row digest；clean-exit success outcome后Service消费前完整首遍验证，事务COMMIT前按首次manifest digest再次验证。 |
| 解析失败后如何保证零 adopt/零 DB mutation。 | 部分失败 | 高 | 容易 | store事务只有Service双侧validate后才打开；policy是shutdown-only，普通`control.cancel()`不会被接受。 | PROBE | Bank失败、Document失败、一个manifest后crash、source变更，检查side/Main/adopt。 | Parser失败发布exact job/op/owner/slot的脱敏failure outcome；Service权威读到后自行terminal；Main等parent barrier再清理，不伪造普通cancel。 |
| Parser失败后何时允许发布normal marker或强制终结parent。 | 资源生命周期 | 高 | 容易 | P1 exact-control teardown与正常failure marker任一提前发生，都会在sibling Worker exit前释放job/CompoundLease并形成未记账活Worker窗口。 | PROBE | tiny success/bad-header Document + 100k Bank真实Worker；分别注入outcome EACCES与正常marker，检查Bank exit前marker/job/lease/dependency/冲突命令。 | 先记录首个bounded failure identity并abort；所有parserTasks `allSettled`后才发布normal marker，发布失败才触发exact-control transport failure，随后parent terminal与cleanup。 |
| app graceful shutdown何时可报告clean。 | 关闭生命周期/残留 | 高 | 容易 | parent terminal会先释放Supervisor job/CompoundLease；dispatcher仍可能等待真实Worker exit或执行spool cleanup。 | PROBE | 100k Bank + tiny Document在`rows.ready`/`rows.part`窗口调用runtime shutdown；记录Worker exit、parent/resource release、cleanup、shutdown resolve顺序，并用零timeout复核报告。 | exact runtime WeakMap登记paired lifecycle；shutdown先abort并等Worker barrier，再由Supervisor收parent，最后等dispatcher finalization。超时合并到既有`errors/leakedTransports`，不得报告clean。 |
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
| 3 | private terminal outcome coordinator + Worker reservation。 | 先占Service、后lease/parse；两侧clean-exit success才Service；任何failure marker/teardown都必须在全部Parser exit后才允许parent释放；shutdown-only不被普通cancel旁路；clean shutdown还必须等待dispatcher cleanup。 | completion乱序、busy冲突、normal/EACCES outcome、两类真实Worker terminal barrier、真实Worker graceful/timeout shutdown、manifest后crash零adopt/零DB。 | reservation旁路、未记账Worker、staging残留或部分采用。 | paired gate关闭，direct single保留。 |
| 4 | Service spool consumer复用同一 store事务/receipt。 | Bank/Document顺序、行数、E07-B receipt/recovery不变量。 | single/paired side DB与receipt parity、exact replay side计数不增。 | 资金/恢复语义漂移。 | consumer停用，不改store schema。 |
| 5 | cleanup、RSS/perf、盲区与affected验证。 | 无敏感spool泄漏，不伪造production通过。 | fault matrix、5-run报告、unit/integration/static。 | 不能交付。 | production保持false/single并记录未通过门禁。 |

## Reviewer Round 1 Repair Preflight（2026-08-28）

### Goal / Context / Constraints / Done when

- Goal：关闭 paired Service `persist` yield 到 side COMMIT 的 shutdown 竞态，并让 cleanup rejection 保持 exact-runtime unresolved owner 直到真实重试成功。
- Context：Round 1 为 P0=0/P1=1/P2=1/P3=0；项目负责人已确认两项均真实可达且非重复。当前 head 为 E07-B non-ff 堆叠后的 `98892c5a`。
- Constraints：只传递现有 `jobContext.signal`；不新增 critical handshake、公共 schema、全局锁或持久化 cleanup 状态；不扩 E08/Publisher/live；production 保持 false/legacy/0。
- Done when：persist yield 或双 spool COMMIT 前复核期间收到 shutdown 均在 receipt/COMMIT 前回滚，不能同时出现 caller `DUPLICATE_SHUTDOWN`、clean shutdown 和 durable import/receipt；cleanup 失败在重复 shutdown 中稳定 non-clean，恢复真实文件系统权限/阻塞并重试删除后才释放同一 owner、报告 clean。

### 已确认事实与 Unknowns Register

| 事实/未知 | 分类 | 代码证据 | 处理与当前决定 |
| --- | --- | --- | --- |
| paired managed import 没有把 `jobContext.signal` 传给 `importPreparedSpools`，正常 `persist` progress 后存在 `setImmediate` yield。 | P1 / PROBE | `managed-service.js#executeImport`；`service.js#importPreparedSpools`。 | 传递 exact job signal；yield 返回立即检查 abort。 |
| side store 在 `await beforeCommit()` 后同步 insert receipt 与 COMMIT；若 abort guard 位于异步 callback 内，callback 返回仍留下一个 await 边界。 | P1 / PROBE | `duplicate-inbound-match-store.js#createImportBundle`。 | 增加 module-private 同步 `beforeCommitGuard`；权威双 spool async 复核完成后调用 guard，此后到 receipt insert/COMMIT 不再 await。 |
| finalization observer 把 rejection 映射为 fulfilled outcome，而注册器对该 Promise 无条件删除 record。 | P2 / PROBE | `paired-parser-shutdown.js#observeBarrier/registerDuplicatePairedParserFinalization`。 | 只有 fulfilled outcome 删除 owner；rejected record 保留 `retryCleanup`，每次 shutdown 最多复用/发起一个幂等 cleanup attempt。 |
| cleanup 重试必须证明真实 artifact 被删除，而非 fault-only shortcut。 | P2 / PROBE | `spool-filesystem.js` 只删 known files、只 rmdir 空 owner 目录。 | POSIX 使用真实目录去写权限并保留外部 lock marker；其它平台使用真实 non-empty lock marker。阻塞时重复 shutdown non-clean，恢复后 retry 必须令 staging 实际消失。 |
| 金额、币种、matching、candidate、result digest 与恢复 schema是否需要调整。 | 边界 / ASSUME | 两 finding 都位于 cancel/commit 与 task-private cleanup 生命周期；业务行转换和 E07-B receipt schema未涉入。 | 不改这些边界；affected 与 integration 证明无回归，真实资金/恢复仍保留人工门禁。 |

- BLOCK：无；accepted finding 已给出最小合同，仓库代码足以确定实现。
- 保守假设：`beforeCommitGuard` 必须同步；返回 thenable 视为合同错误，防止未来重新引入 COMMIT 前 yield。

### 风险优先计划

| 顺序 | 步骤 | 保护的不变量 | 成功证据 | 失败影响 | 回滚/收缩 |
| --- | --- | --- | --- | --- | --- |
| 1 | signal 血缘与同步 commit guard。 | abort 不跨越 receipt/COMMIT；双 spool 仍先完整复核。 | persist-window shutdown 形成 `DUPLICATE_SHUTDOWN`、clean report、side import/rows/receipt全0。 | 重复记账或 clean 假报告。 | paired gate关闭；不触碰 single/live。 |
| 2 | unresolved owner + 幂等 retryCleanup。 | cleanup失败不丢owner；仅真实删除后clean。 | 阻塞下两次 shutdown均error/leak；恢复后第三次删除staging且clean。 | 敏感spool残留被静默遗漏。 | owner持续保留并报告non-clean。 |
| 3 | affected/盲区/门禁复核。 | E07-B恢复、Supervisor资源、金额行数语义和production gate不漂移。 | E07-C、Duplicate、background/Supervisor、integration与static通过。 | 不可交付。 | 不合并未证实修复。 |
