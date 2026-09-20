# B3 Main 锁归属独立审查

审查范围：G6 Main failureListener 最小修复及其调用链。独立审查 Agent 只读生产/测试源码，唯一负责本记录；同一 worktree 中其他 Agent 正在实现 Main 与回归，不改动或撤回他们的文件。

工作目录：`/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/v3210-storage-execution-separation`。基线 HEAD：`11086a3cbf632a30adbcfa796e4cd81810c5aef9`。本记录中的初始 Main 行号来自正式补丁落盘前快照；最终补丁核查在文末追加。

## 结论

删除 pool failureListener 中无归属的全局 release，不会让已进入 run/resume execute 的正常、业务失败、worker crash、取消路径失去 release：它们已有属于当前 invocation 的 `prepared.releaseLock()`，并在 execute 的 finally 中无条件调用。init 失败和 dispatch 同步异常同样经 async rejection 返回该 finally。

Main 中唯一未持有本次 operation ownership 却执行 release 的调用是旧 failureListener `src/main.js:22852`；它可以收到 idle worker 的失败，此时 `hadActiveJob=false`，更不能代新 prepare/其他操作释放锁。其余 7 个 release 调用点都能回溯到所属路径成功 acquire。run/resume 的 release closure 有本次调用专属 `released` 标志；重复 onAbandon/release 不会清理后来获得的锁。

但不能宣称“所有 prepare 后异常均已闭合”：共享 `runArchiveAwareOperation` 在 prepare 成功后、进入 prepared cleanup wrapper 前仍有第二次 Hold gate 和 Archive initialize 抛错缺口。本轮小 VM 已确定该缺口会保留锁、阻止后续 acquire。它是 HEAD 既有缺陷，不由本次删 release 引入，也不造成同 `.mw-tmp` 同时进入；按 root 的跨组边界归 G2 的 prepared 通用清理。直接调用 onAbandon 的回归不能代替这一共享包装器异常链的验证。

## 所属 release 调用链

| 路径 | acquire / owner | 返回/失败如何到达 release | 结论 |
|---|---|---|---|
| 新 run | Main 17546 acquire；17550–17555 本次幂等 release closure | run-data 145 await dispatch → Main 17625 await；正常写镜像与 settleArtifacts 后，或 catch 任意错误后，17662 finally 调 prepared.releaseLock | 不依赖 failureListener release |
| resume | Main 17706 acquire；17710–17715 本次幂等 closure | prepare 异常由 17882 release；成功 prepare 返回 onAbandon；execute 17976 finally release | completed/direct、续跑成功、错误、取消均覆盖 |
| run/resume execute 前被生命周期放弃 | Main 17577 / 17878 交付 onAbandon | interactive-task-preflight.js:257–264 在未 markExecuteStarted 时 finally 调 onAbandon；Main File lifecycle 包装从 21970 起 | 已进入该 wrapper 的文件计划、freshness、reserve、beforeStart 拒绝有 cleanup；不涵盖 wrapper 外的第二 gate |
| Archive center 返回不可用 | Main 21886 初始化返回后判断 | 21888 明确 await prepared.onAbandon | 已闭合；与 initialize 抛错不同 |
| import | Main 17436 acquire | 17467 finally releaseOpLock | 本操作所有 |
| export | Main 18061 acquire | 18080 finally releaseOpLock | 本操作所有 |
| 启动主库孤儿 cleanup | Main 22633 acquire | 22672 finally releaseAcquiringBillCurrencyOpLock | 本 cleanup 所有 |
| 启动侧库孤儿 reconcile | Main 22684 acquire | 22714 finally releaseAcquiringBillCurrencyOpLock | 本 cleanup 所有 |
| 后台 cleanup | Main 22965 acquire | setImmediate 内 22996 finally release，并重置 cleanupBackgroundInProgress | 本 cleanup 所有；该审查不扩修既有通知/调度等其他异常窗口 |

全局 lock 的字段只在 Main 1599–1601（获取）、1605–1607（释放）赋值，没有另一个直接改写 lock 的旁路。cancel IPC Main 17678–17685 只向 pool 投递取消，不释放锁。

## pool 到所属 execute 的完整分支

- 正常 done：run-check-worker-pool.js:109–116 取当前 activeJob、清槽并 resolve；Main 等待 run-data 镜像及 artifact settlement 后 finally release。
- 业务 error / graceful CancelError：pool 121–128 reject；Main run 17650–17662、resume 17967–17976 catch 分类结果并 finally release。若 Notification 自身抛错，finally 仍执行。
- active worker error：pool 76–77 → handleWorkerFailure 140；先保存并 reject 当前 job（147–162），随后才发 failureListener（172–181）。Promise rejection 仍沿 run-data 145 / 546 await 向所属 Main execute 传播。
- active worker 非零 exit、正常 exit 但没交付 done：pool 79–85 同样进入 handleWorkerFailure 并 reject 当前 job。过期 worker 事件在 142 被身份检查过滤。
- init 期 crash/exit/10s timeout：pool 241–248 safeReject；278–297 的 error/exit/timeout 都进入它。此时还没有 activeJob，failureListener 不能负责当前 prepare 的锁，但 await ensureInitialized 的 rejection 仍由 Main finally 释放。
- hard cancel：pool 393–398 到期调用原 worker terminate，exit 路径 reject 原 job，再由 Main finally release；取消接口没有提前解锁。
- shutdown：pool 432–441 主动 reject 并保留 shutdownPending 标志，caller 释放不依赖后续 failureListener；后续消息不二次 settle。此处只审查锁是否释放，不把该既有外层 shutdown 行为升级为 G6 B0 的 JS finally 退出屏障证明。
- idle worker crash：hadActiveJob=false，没有属于它的当前 execute；删掉无归属 release 后，应该只清 pool 状态和日志/通知，保留正在 prepare 或其他操作持有的锁。

## 已证实的 G2 既有准备清理缺口

原路径：`trackedIpcHandle` Main 22166–22171 直接 await `runArchiveAwareOperation`，没有外层 onAbandon finally。`runArchiveAwareOperation` 在 21867 await prepare 成功后，21884 第二次 `assertTaskPolicyNotHeld`、21886 `initializeArchiveCenter` 发生在 21905/21970 的 `runWithPreparedResourceCleanup` 之前。第二次 gate 的注释本身明确要处理 preparation 期间新 Hold，属于设计中的可达异常分支。

`prepareIpcTaskInvocation`（ipc-task-contract.js:67 起）也没有替调用方兜底上述异常。补丁不能通过保留错误的全局 failureListener release 来“修”这一缺口：该异常不需要发生 worker failure，且无归属 release 本身会破坏别的 operation 的互斥。

只读 VM 证据：精确提取当前 Main 的 lock 定义/函数与完整 `runArchiveAwareOperation` 原文，使用实际 ipc-task-contract 模块；只替换外部 gate、Archive initialize 和受控 prepare fixture。未启动 Electron、DB、Worker、测试套件或写 runtime 数据。runner 原文 SHA-256：`9ee898a69117a5697749ae69d5458234d3b125e2bab4b4892247398c3c0c09cf`。

| 注入场景 | gate 调用数 | onAbandon | execute | 返回后 inFlight | 第二次 acquire |
|---|---:|---:|---:|---|---|
| 第二次 Hold gate 抛 PROBE_HOLD | 2 | 0 | 0 | true | false |
| Archive initialize 抛 PROBE_INIT | 2 | 0 | 0 | true | false |
| Archive center 返回 null | 2 | 1 | 0 | false | true |

前两项证明共享包装器边界遗漏、表现为模块锁保留；不证明真实生产某一 Hold race 的发生频率。该问题属于 G2 跟进项，本次 G6 最小修复不修改共享包装器，不以直接 onAbandon 测试冒充已解决。

## 本次回归所需证据

正式测试应从实际 Main 的 run/resume prepare/execute、cancel 和 failureListener 原文装配，覆盖 idle crash 不解新 owner、active crash 经旧 owner finally 解锁、正常完成、graceful/hard cancel、prepare 后 onAbandon、重复旧 closure 不清后继 owner。failureListener 的 partial 扫描、chunkSize 透传、日志及通知必须保留。

测试应清楚区分直接 onAbandon 验证与完整共享 wrapper；与 G6 B0 真实 worker exit barrier 的既有证据合看，不宣称覆盖 Electron GUI、Windows 进程生命周期或 G2 全部 prepared 资源异常。独立审查 Agent 没有启动大型测试。

## 最终补丁与回归边界核查

正式补丁已落盘并完成独立末审。`git diff -- src/main.js` 仅有 failureListener 附近两个 hunk：更新归属注释，删除无归属 release 调用及其旧注释。新 listener 位于 Main 22836；active partial 兜底位于 22869；后台 cleanup 原有 release 顺移到 22993；run/resume prepare、finally 与共享包装器行号不变。

已将 HEAD 的 listener 函数原文仅删除目标 release 两行后与当前函数精确比较，结果 **remainingListenerExactHEAD=true**。partial 扫描、chunkSize、日志、通知及错误吞吐边界全部逐字保留。共享 runArchiveAwareOperation 与 HEAD 精确相同（sharedWrapperExactHEAD=true）。因此未发现本次最小补丁新增的锁泄漏或失去所属 owner 的分支。G2 既有缺口仍按上述边界保留，不能将此报告理解为所有准备异常都已修复。

末审快照 Main SHA-256：`8e189ff35f1a5d79447a94881f5896958c5c89870e725c0a0fba27d95bd7bd56`。

正式回归 `tests/unit/main-process/acquiring-main-lock-ownership.test.js` 已逐段阅读，包含 **11 项**（run/resume 各 5 项，加 resume prepare 预检失败 1 项）：

| 测试位置 | 实际覆盖 | 替身/未覆盖边界 |
|---|---|---|
| 22–37、114–125 | 精确提取完整 Main 锁函数、run/resume 注册体、cancel 注册体、listener 并在 VM 执行 | 未启动 Electron，也未执行共享 runArchiveAwareOperation |
| 163 起，run/resume 两项 | 真实生产 pool/worker 预热 → idle crash → 下一 prepare 已持锁；保持 busy，日志/通知保留，idle 不写 partial | side DB bridge 与 Archive 为自建 fixture |
| 186 起，run/resume 两项 | 真实 pool + 受控真实 Worker active exit；listener 运行时锁仍在，所属 execute finally 后释放一次；partial 与 chunkSize 保持 | 受控 Worker 不执行真实对账 SQL；SQL/B0另有既有证据 |
| 218 起，normal/cancel × run/resume 四项 | 真实 Main execute 返回，正常 settlement 一次，取消 settlement 零次，所属 release 一次 | cancel fixture 返回 CancelError；测试 84 行将 hardTimeoutMs 设为 0，因此不覆盖 5 秒强杀兜底 |
| 248 起，run/resume 两项 | 直接调用实际 prepare.onAbandon；零 dispatch；旧 owner 的重复 release/abandon 不释放后继 owner | 这是直接 abandonment，不是第二 Hold gate/initialize 异常链 |
| 262 起 | 实际 resume prepare 在业务预检抛错时走 catch release，后续 run 可获取 | prepareRunResume 业务层故障由 fixture 注入 |

共用后继 owner 验证在 148–159：获取下一轮后重复旧 releaseLock/onAbandon，要求释放计数不增加、monthKey 仍归下一轮、第三轮 busy。该断言能抓住仅有全局 bool 幂等、却会清后继 owner 的错误实现。

Worker fixture `__fixtures__/acquiring-main-lock-worker.js` 确实使用原生 worker_threads 和独立 SQLite，只让测试控制 init/run/正常完成/取消/exit，并在 close 时关闭 DB。测试源码 SHA-256：`ccb4569a2ce5ab257f9deb29bfc530b3b85becaeba24240cc644200469e39d63`。

本独立审查没有额外执行正式测试。已阅读实现 Agent 保存的 [b3-main-lock-tests.txt](b3-main-lock-tests.txt)：tests=11、pass=11、fail=0、skipped=0；root 确认退出 0。保存的 [b3-main-lock-file-sha256.txt](b3-main-lock-file-sha256.txt) 与本次独立末审 Main/测试 hash 一致。另已阅读 [b3-main-lock-red.txt](b3-main-lock-red.txt) 的原实现失败证据，其中 active listener 提前解锁断言实际失败；原错误可被新增回归识别。这些是定向回归证据，不替代完整门禁。尚未在这个新增测试中单独模拟 worker error 事件、init failure、hard terminate、completed resume、结算失败或共享包装器第二 gate；其释放分支有上述调用链证据，不将未执行分支列为运行覆盖。

审查结论：**本次最小 Main 修复的方向与实现可接受；未发现新增阻断缺陷。** 正式定向回归已记录 11/11 PASS，并明确保留 G2 准备资源缺口；可将此次无归属 release 修复视为完成。该判断不升级完整 release-check、Windows/GUI 或 G2 验收状态。
