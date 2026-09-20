# Acquiring 仓储与多 worker 执行边界

本页记录已经落地的入口；版本设计见 [G6 Spec](../../../changes/v3.2.10/codex/v3.2.10-storage-execution-separation/spec.md) 和 [TechDoc](../../../changes/v3.2.10/codex/v3.2.10-storage-execution-separation/techdoc.md)，切片证据见 [G6 实施索引](../../../changes/v3.2.10/codex/v3.2.10-storage-execution-separation/implementation-notes.md)。run 级存储约束以 [run-scoped-data-policy](../../../rules/run-scoped-data-policy.md) 为准。

## 当前入口和职责

- [run-repository.js](run-repository.js) 拥有 SQL、计划和数据库事务。`buildMultiworkerPlan(db, { runId, monthKey, chunkSize })` 只读取 COUNT 并复用既有 SELECT SQL；`cleanupFailedMultiworkerRun(db, { runId })` 只在事务中删除指定 run 的 diff，失败回滚并抛出。仓储不创建或调用 worker。
- [acquiring-bill-currency-multiworker-service.js](../../main-process/acquiring-bill-currency-multiworker-service.js) 的 `createAcquiringMultiworkerService({ runRepository, executeWriteSplitChunks }).insertDiffRows(db, options)` 拥有参数校验、计划→执行→失败清理的编排；仅可信 Main/session 装配依赖，Renderer 不传入 executor/SQL。
- [acquiring-bill-currency-session.js](../../main-process/acquiring-bill-currency-session.js) 负责资源参数、run 状态和既有 partial/resume；只清理自己创建的独占外层临时目录。
- [run-check-multiworker.js](../../main-process/run-check-multiworker.js) 负责单次调用的 worker 组、chunk 分发、逐 chunk 合并及结束阶段的精确 part 清理。执行器不创建 run、不推进持久化 chunk 进度、不决定 partial/resume。

## B0 退出屏障

每个 Worker 构造成功即登记到本次调用的 group，并立即安装贯穿初始化、执行和关闭的退出监听。初始化采用全量 `allSettled`；任一失败保留首异常、终止新派发、使所有初始化 Promise 收口，并关闭所有已登记线程。初始化晚到消息不能重启派发，chunk 未完成便以任何 exit code 退出都属于失败。chunk 失败在事件 handler 内同步登记首错，避免原生 OOM 同栈 `error → exit` 用通用 exit 覆盖原错误。

关闭按单线程 `stopPromise` 幂等执行：先发 close，默认 5 秒优雅关闭期限到期或发送失败时只触发一次 terminate。只有真实 exit 事件或 terminate Promise 成功完成才确认退出；terminate 抛错/reject 会记录含 worker/taskRunId/阶段的诊断并继续等待 exit。默认初始化期限仍为 10 秒。优雅关闭期限不承诺线程必定在 5 秒内终止；尚未确认退出时调用链和资源继续被该 Promise 持有。

`finally` 先等待本组全部已创建线程退出，再清理本次派发的精确 part 路径及 `-wal/-shm/-journal`。不扫描目录，不递归清 caller 外层目录，不将文件名匹配视为授权。相同受管 part 命名空间只能在前次调用完成后顺序复用；[worker 写前重建](../../main-process/run-check-multiworker-worker.js) 仍保留 C1 合同，重建本次 chunk 对应的受管历史残留，避免旧行污染。

reader 全部成功才开始 merge；merge 仍按 chunkIndex、seq 物理顺序逐 chunk 事务。merge 失败可能保留已提交 chunk，外层依旧按当前 run 清理并保留原错误，session 按既有合同处理 partial/resume。本次不增加全批原子性或新的目录并发能力。

## 兼容与验证入口

`runWriteSplitChunks` 的生产参数、默认值、成功结果和原失败优先级保持；新增退出屏障是已批准的 P1 行为修复。仓储旧 `insertDiffRowsByJoinMultiWorker` 已移除，唯一直接生产调用 session 及全部 8 处测试调用已切为显式 service 装配；没有仓储 executor 注入后门。错误文本仍保留旧函数前缀以维持兼容。内部 `startWorker/closePool` 无仓内调用方，随 record 所有权改为私有实现，不提供用于旁路退出屏障的入口。

代表性测试：[run-check-multiworker.test.js](../../../tests/unit/main-process/run-check-multiworker.test.js)。真实 worker fixture 使用自建临时 SQLite；故障覆盖 init 部分失败/构造/发送/timeout/error/晚到就绪，close 发送/超时，terminate 延迟/reject/throw，运行中 code=0 退出。测试明确释放 exit 前检查 executor pending、part 保留，退出后检查线程回收和单次关闭；既有 M=1/2/4 逐行等价、C1 与取消回归也继续运行。平台 GUI、Windows 文件占用和完整交付门禁另行记录，不由本页局部测试代替。

## 失败顺序、调用前提和当前验证边界

当前生产调用方向为 Main → run-data → worker pool → worker/session → service → repository/executor。session 决定性能 gate、chunkSize/workerCount 和 run 状态，service 保留原校验次序及参数有效值；reader progress 只通知，不提前写 chunk_progress。executor 结束后，service 才尝试事务删除当前 run 的 diff，清理也失败仍抛原执行错误；session 标 partial。resume 从 -1 起点先清本 run 残留再走单 worker，可信已提交 chunk 的后续续跑不变。

可信 Main 提供应用 Documents storageRoot 下固定 `.mw-tmp`，session 无 caller 目录时使用独占私有目录。文件名不提供授权；只能顺序复用 part 命名空间。Main 的模块锁由取得它的 prepare 所返回的幂等 release closure 持有；run/resume 的 execute finally 和 onAbandon 负责释放。pool failureListener 只记录失败、通知并执行原 partial 兜底，不拥有全局解锁权限。旧 idle worker 失败不得解下一 prepare 的锁，active failure 则沿等待链返回所属 finally。该行为依据[用户已确认的 B3 补充](../../../changes/v3.2.10/codex/v3.2.10-storage-execution-separation/b3-lock-fix-proposal.md)。

[Main 锁归属回归](../../../tests/unit/main-process/acquiring-main-lock-ownership.test.js)使用实际 Main 注册体、真实 pool/线程和自建 SQLite，覆盖 run/resume idle/active failure、正常、取消、abandon 与旧 owner 重复释放。共享 runArchiveAwareOperation 在 prepare 后第二 Hold gate 或 initialize 抛错时漏调用 onAbandon 的既有路径不在这组回归中；它会保留锁、阻止后续请求，属于 G2 的通用 prepared 清理范围，见[独立审查](../../../changes/v3.2.10/codex/v3.2.10-storage-execution-separation/evidence/b3-main-lock-independent-review.md)。本次最小修复没有改变该共享包装器，不把上述测试扩称为其全部异常路径通过。

代表性新增验证：[service 合同单测](../../../tests/unit/main-process/acquiring-multiworker-service.test.js)、[单/多 worker 与 session 行序合同](../../../tests/unit/main-process/acquiring-multiworker-contract.test.js)、[真实 worker 与 partial/resume 集成](../../../scripts/integration/acquiring-worker-boundary.js)。集成使用真实临时 SQLite trigger 制造部分 merge 与清理双失败，覆盖受管旧 part、caller 根/无关文件/未派发 part 保留以及从 0 resume。

根导读为 `AGENTS.md → 本 README`；存储专项规则语义未变，无需改写。G8 的 `architecture/boundaries.json` 尚未集成，此处不登记 active 或临时例外；后续由 G8 登记实际边界，当前测试及全仓调用清点提供本分支验证。
