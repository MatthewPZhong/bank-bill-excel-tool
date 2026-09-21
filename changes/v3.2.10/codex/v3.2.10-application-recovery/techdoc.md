# v3.2.10 TechDoc — 应用恢复协调器与 publication owner 接口

| 项目 | 内容 |
| --- | --- |
| 治理编号 / 优先级 | G1 / P1 |
| 目标版本 / 功能分支 | `v3.2.10` / `codex/v3.2.10-application-recovery`（已在独立 worktree 建立） |
| 开发基线 | `main` / 附注标签 `v3.2.9`，`11086a3cbf632a30adbcfa796e4cd81810c5aef9` |
| 集成目标 | `release/v3.2.10`；本功能尚未集成，实际分支/基线及集成状态见[实施记录](implementation-notes.md) |
| 日期 / 状态 | 2026-09-20 / 第三轮设计审查通过；当前实现、验证、集成状态见[实施记录](implementation-notes.md) |
| 产品依据 | [Spec](spec.md)、[审查报告 G1](../../../architecture-coupling/2026-09-20/review.md) |

## 1. 模块与所有权

以下“拟新增”称谓保留设计阶段的模块规划；当前实际入口见[模块说明](../../../../src/main-process/application-recovery/README.md)，各切片结果见[实施记录](implementation-notes.md)。

| 模块 / 文件 | 职责与写权限 |
| --- | --- |
| 拟新增 `src/main-process/application-recovery/coordinator.js` | 持有本进程恢复阶段、平台扫描完成事实、串行调用 Promise；包装阶段调用，不写业务 SQL |
| 拟新增 `src/main-process/application-recovery/composition.js` | Main 的显式装配入口，绑定参与者和 Archive hooks；不决定恢复结果 |
| 复用 `background-execution/startup-recovery-coordinator.js` | 保留 `scanAndRecover()` / `recoverSource(source, hold)`，仍拥有通用恢复事实核验及 transitions |
| 拟新增 `src/main-process/biz-op-v327/recovery-participant.js` | 封装 preflight、activation、owner 和 post-outbox 调用；业务 driver、admission、sources 和预算所有权留在 BizOP |
| 拟新增 `src/main-process/publication-recovery/coordinator.js` | 静态装配 owner 能力；在同一 dispatcher FIFO 中先只读发现、逐记录授权，再执行恢复；不写业务 SQL |
| 拟新增 `src/main-process/publication-recovery/archive-owner.js` | 封装原共享 Archive handoff 的 exact taskKey/moduleId、task/batch/operation、artifact/terminal/completion 证明；不以非 BizOP 前缀兜底 |
| 修改 `toolbox-output-publication-dispatch.js`、`toolbox-output-publication-worker.js`、`toolbox-output-publication.js` | 将所有恢复副作用置于不可省略的逐记录授权之后；publish 的隐式恢复和 transport-error 自恢复共用此路径 |
| 拟新增 `src/main-process/biz-op-v327/publication-owner.js` | 私有查询未完成 publication、申请原 lease、识别 BizOP publisher task id、提供 ack/cleanup 保护；公共 coordinator 不取 catalog |
| 复用 `archive-center/controller.js` | 原 outbox 重放、owner 失败聚合、interrupted sweep、post-outbox hook 顺序、protected batch 和维护准入唯一执行者 |

`main.js` 只构造上述对象并把 hooks 注入 Controller。各模块 DB 路径、userData、runtime、archive service 均由 Main 闭包传入，不接受 Renderer 配置。

## 2. 应用恢复内部接口

```js
createApplicationRecoveryCoordinator({ platform, participants })
// platform: 现有 createStartupRecoveryCoordinator() 返回对象
// participants: Main 装配、启动前冻结的有序数组
// 返回：
{
  platformFacade: { scanAndRecover(), recoverSource(source, hold = null), snapshot() },
  preflight(): Promise<{ snapshot: PhaseSnapshot,
    participantResults: ReadonlyArray<{ id: string, result: unknown }> }>,
  archiveOwnerHooks(): ReadonlyArray<{ ownerName, recover: () => Promise<unknown> }>,
  postOutboxHooks(): ReadonlyArray<{ hookName, run: () => Promise<unknown> }>,
  completeArchiveInitialization(result): void,
  failArchiveInitialization(error): void,
  snapshot(): PhaseSnapshot
}

// participant 固定字段；缺省阶段写 null，不执行空钩子
{ id: string, ownerName: string, hookName?: string,
  preflight: (() => Promise<unknown>) | null,
  recoverOwner: (() => Promise<unknown>) | null,
  postOutbox: (() => Promise<unknown>) | null }

// PhaseSnapshot：冻结副本，只在当前进程内存在
{ phase: 'created'|'preflight'|'archive'|'ready'|'failed',
  platformScanCompleted: boolean, failureCode: string|null }
```

实现补充：`hookName` 仅用于保留既有 post-outbox 日志名，缺省取 `ownerName`；它不改变参与者身份、阶段或顺序。

`platformFacade.scanAndRecover` 原样 await 公共 platform；只有 Promise 成功返回才把 `platformScanCompleted` 设为 true，随后返回原 summary。失败不把本次失败当作扫描完成。成功事实在当前进程内单调，不因随后业务 ready=false 被清掉；应用仍通过完整阶段判断是否允许启动。`recoverSource` 原样转发，不改变错误或预算。BizOP `bindPlatform()` 改绑定该 facade。

`preflight()` 同时调用返回同一 pending Promise；完成后重复调用返回该阶段结果。owner hooks 的执行与错误仍由 Archive Controller 串行组织，协调器只记录每个 hook 的 pending/completed 状态；失败的 hook 允许后续显式重试，成功 hook 在同轮初始化不重复执行。所有 BizOP 业务重试仍走其 driver 单飞和 admission，不另加第二把领域锁。

`platformFacade.snapshot()` 只返回协调器快照，允许旧 driver 兼容读取，不能反向查询 BizOP。`participantResults` 保存各参与者原返回，Main 日志从中读取原 `sourceCount/activeHoldCount/reason`，不丢弃预算和诊断。阶段由 `created` 在 preflight 开始时进入 `preflight`，成功进入 `archive`，完整 Archive 初始化成功进入 `ready`；任一抛出的阶段错误进入 `failed`。原 `ARCHIVE_OWNER_PHASE_REQUIRED` 是参与者的可继续结果，不是 `failed`。

`completeArchiveInitialization` 仅在 Archive 初始化 Promise 成功后由 Main 调用；若扫描未完成抛现有 `BACKGROUND_RECOVERY_SCAN_PENDING`。Main 随后沿用原 Toolbox startup error 检查及启动后续步骤。重复完成幂等；完成后不得倒退或再次启动 hooks。归档初始化失败记录原 code，继续抛原错误。

协调器装配非法 id/重复 id/非法函数时抛拟新增内部错误 `APPLICATION_RECOVERY_PARTICIPANT_INVALID`，发生于恢复副作用前。此错误不新增 IPC。

## 3. 阶段装配与预算

参与者和 hooks 使用固定顺序，不能用模块加载顺序或对象枚举顺序推断：

固定 participant id 为 `biz-op-v327`、`pending-runs`、`legacy-biz-op-runs`、`pre-fund-runs`、`position`、`toolbox-vcc-publications`、`vcc-import-terminal`、`vcc-import-lineage`。BizOP 一个 participant 同时提供 preflight/owner/post-outbox；VCC lineage 只提供 post-outbox；其余仅提供 owner hook。`ownerName`/`hookName` 保留基线日志名称，顺序由 composition 显式表指定。

| 阶段 | 确定调用顺序 |
| --- | --- |
| preflight | registry 冻结 → BizOP `recovery.run({initialPlatformOnly:true})` → 原 active hold/action 绑定校验和各 hold gate 装配 |
| Archive owner | BizOP activation quiesce/recovery → Pending runs → 旧 BizOP runs → Pre-fund runs → Position → Toolbox/VCC publications → VCC import terminal |
| Archive 内部 | 每个 owner 尝试完成 → post-owner outbox replay → 原失败聚合 → flow intent replay、protected/interrupted 与 artifact 收口 |
| post-outbox | BizOP activation/recovery → VCC import lineage/hold reconcile |
| 完成 | Archive 初始化成功 → 平台扫描完成断言 → Toolbox 原 startup error 断言 → 原后续启动 |

BizOP preflight 因来源非空返回 `ARCHIVE_OWNER_PHASE_REQUIRED` 时不改变原 `deferredStartupBudget`。仍使用基线 limits：4096 sources、8 MiB source/decision 总量、8192 bytes 单 source、32768 evaluations、2 full scans、4 enumerations、60000 ms admission、每 32 步 yield。两次 scan 的 budget charge 仍在 driver 内，应用 facade 不再重复 charge。

BizOP participant 的 preflight 原样检查 `summary.reason`：非空且不是 `ARCHIVE_OWNER_PHASE_REQUIRED` 时，用原启动预检文案和该 reason 作为 code 抛出。owner 阶段则原样执行 activation quiesce、`openObligations()` 与 recovery，并按原 ready 值记录 info/warning；不能把原本返回 `ready:false` 的业务保护结果一律改成 owner 抛错。post-outbox 仅在 activation 仍 needed 时调用原 retryRecovery。这三个分支分别保留现有判断，不能合并成统一的“ready=false 即启动失败”。

只删除 driver 私有 `platformScanCompleted` 写入。过渡期 `hasCompletedPlatformScan()` 转发注入 facade 的只读 snapshot；G1 完成时 Main/Duplicate 已迁至应用 snapshot，兼容方法只保留给尚未迁移的测试，并在测试同步完成后删除。不能让 facade 从 BizOP 查询自身状态形成环。

## 4. 共享 publication 协调接口（R1 修订）

### 4.1 已核实的基线与本次有意修复

基线 `recoverPendingToolboxPublications()` 不是只读扫描：preparing/cancelling 会删 staging 和 journal，prepared 会取消，未提交状态会回滚，finalizing 会删 index/journal；`deferCommittedRecovery` 只约束部分 committed 记录，缺 batchContext/files 时仍可能直接 cleanup。故不得采用“先运行旧扫描，再按 owner 过滤”的实现。

本次明确修复两项行为：**未知/冲突/无充分归属证据的旧记录在任何恢复写入之前被保留并拒绝；全部实时及隐式恢复入口适用同一边界。** 对证据充分的已支持 owner 保留原状态机、receipt、cleanup、错误和恢复结果。下列新授权状态不持久化、不升级 journal 格式；合法旧记录仍由原 owner 恢复。只移动文件不能满足本切片。

### 4.2 精确接口及责任

```js
createPublicationRecoveryCoordinator({ userDataDir, dispatcher, owners }) => ({
  forOwner(ownerId): { recover(options): Promise<RecoverySummary> },
  bindDispatcherAuthority(): void // Main 启动时仅一次；冻结后不可热替换
})
// owner facade 的 options：
{ reason: 'startup'|'live-handoff'|'receipt-ack'|'business-retry',
  taskIds?: ReadonlyArray<string>,
  acknowledgedCommittedTaskIds?: ReadonlyArray<string>,
  deferCommittedFinalization?: boolean,
  observation?: ObservationCapability, onProgress?: Function }
// root 在工厂固定；deferCommittedRecovery 始终 true；旧 options.root 不可覆盖。
// dispatcher 内部还使用 reason=publish-preflight / transport-error，
// 只由当前队列项产生，不开放给业务方；owner 从原 publisher 身份装配确定。

// owner 注册项，只由 Main composition 创建；注册时唯一 id、成对方法校验/冻结
{ id: 'biz-op-v327'|'archive-publication',
  identify(record): Promise<'not-owned'|OwnerIdentity>,
  authorize(record, request, identity): Promise<OwnerDecision>,
  acquireObservation(request): Promise<ObservationCapability|null> }
// identify/authorize 只读业务事实，不执行 recovery、不分配任务、不写 receipt。
// OwnerIdentity = { ownerId, publisherTaskId, taskRunId, batchId, operationKey,
//                   proofDigest, legacyProofKind: string|null }
// OwnerDecision = { disposition: 'allow'|'defer'|'reject',
//   permission: 'recover-uncommitted'|'observe-committed'|'ack-stage'|'ack-finalize'|null,
//   identity, code?: string }
// ObservationCapability：Main 私有、不可由 IPC 构造，绑定 root/owner/本次 work，
// 只暴露 verifyScope(request) 和 release(reason)，不能用任意 {release(){}} 冒充。

dispatcher.runAuthorizedRecovery({ request, authorizeSnapshot })
// 进入既有 FIFO 后，依次运行只读 discover worker、Main authorizeSnapshot(snapshot)、
// execute-recovery worker；直到全部实际 exit 后才结算。回调从不发给 worker。
// 内部 snapshot：
{ root, indexDigest, records: [{ taskId, journalPath, discoveryState,
  journalStatus: string|null, recordDigest, indexEntry, journal: object|null }],
  skippedActive: ReadonlyArray<string> }
// 内部 grants（只作为此次队列项的工作参数，不能存盘/复用）：
{ root, indexDigest, entries: [{ taskId, recordDigest, ownerId, identity,
  permission, acknowledged: boolean }] }
```

`recordDigest` 覆盖规范化 index entry、journal 内容/缺失标记和原路径/parent identity 证据；不能只散列 taskId。发现阶段复用现有纯读取和校验函数，禁止调用 `recoverOneJournal`、`markManualRecovery` 或任何写入、mkdir、rename、unlink、index 修复。损坏内容以只读诊断报错，不将原文件改为 manual-recovery 才报错。

`RecoverySummary` 明确使用下列 Main 内部结构；`recovered` 只返回请求 owner 的已授权恢复/观察结果，另外两类未决记录不得因为结果过滤而消失：

```js
{ recovered, skippedActive,
  deferred: [{ taskId, ownerId, code, recoveryPaths }],
  observation: { root, indexDigest, complete: true,
    requestedTaskIds: ReadonlyArray<string>, absentTaskIds: ReadonlyArray<string> } }
```

`deferred` 保留全根已识别 owner 的未决事实；未知/冲突不伪装成 deferred，仍整体拒绝。`observation.complete` 只表示本轮发现及执行前重验完整，不表示恢复全部完成。`absentTaskIds` 只由 coordinator 对本轮显式请求的 taskId、完整重验后的全根 snapshot 生成；存在于 recovered、skippedActive、deferred 或原 snapshot 的 taskId 不能进入该列表。不公开给 Renderer，不允许 owner 调用方自填。legacy helper 缺这些字段时视为合同未闭合，不能把 undefined 当空集合。

BizOP `reconcile()` 对 recovered 已明确返回的 `rolled-back`、`cancelled`、`cancelled-preparing`、`cancelled-prepared` 继续沿原判定形成 `NOT_COMMITTED`。**仅当 recovered 缺少本任务记录时**，才要求自身任务也不在 skippedActive/deferred，且受信任 observation 对本次 bound.publisherTaskId 给出显式 absence，方可沿原 `no-open-journal/not-started` 分支形成 `NOT_COMMITTED`。不能以过滤后的空数组证明未提交，也不能用新 absence 条件阻断已有明确回滚/取消事实。

BizOP `acknowledge()` 同样必须在 `saveOutcome`、`acknowledged=1` 和 `cleanupStage()` **之前**消费这三类结果：请求的 publisherTaskId 在 `deferred` 或 `skippedActive` 中，或 recovered 存在但不是 `commit-cleanup`，均用原 `BIZOP_PUBLICATION_ACK_PENDING` 拒绝，零 acknowledgement 写入、零 staging/receipt cleanup；原 io 的 attempt/真实退出 closure 记录仍正常完成。recovered 缺失时不能直接落入成功分支：仅当受信任完整 observation 明确确认该 requested task 全根无记录，且原 binding、commit proof、archive_settled、succeeded terminal、closure/protection 等 durable 条件仍全部成立，才保留原“先前已清理 receipt”的幂等确认。没有 absence 证明或原 proof 不成立则继续 pending，不写新成功、不释放义务。`row.acknowledged` 已为 true 的历史路径继续沿原 cleanupStage 自身证明，不因此次迁移重写既有持久确认。

共享 `toolbox-archive-recovery` 的 discover→ack-stage→ack-finalize 聚合需同时透传三阶段的 `deferred` 和 `skippedActive`，按 taskId/ownerId 去重；只有后续同身份明确 `commit-cleanup` 的正向证明才可移除该 task 的 earlier deferred，不能靠“最后一次 recovered 没有它”移除。返回的 observation 必须保留请求/absence 的来源，不能把不同扫描的 absent 集合并成一个不存在的全根 snapshot；若聚合不再代表单次扫描，则使用 `observations:[...]` 保留各次原 observation，消费端按各自 requested task 和最新有效证明判断。最终结果及抛错诊断都保留未决列表与恢复路径，不能沿原 :363–374 只拼 recovered/skippedActive 后丢掉 deferred。

- 启动 Archive owner hook：自身 `archive-publication` 仍有 deferred 时以原 startup-blocking recovery 错误、`preserveTemporaryFiles=true` 和未决证据报错，Controller 继续后续 owner/outbox 尝试后按原规则阻断；不报告“全量恢复完成”。其他已识别 owner 的 deferred 原样传递给该 owner 的恢复/admission 判断，不由 Archive hook 冒充接管或修改其 ready 策略。
- 实时 handoff/receipt ack：请求 task deferred 时不 settlement/ack/cleanup，不把缺少 recovered 当成功；返回/抛出原 owner 的 pending 反馈。已 committed 发布仍由原调用方保留 `pendingArchiveHandoff`/warning，不诱导重新执行发布；后续重试从耐久事实重新发现，不凭内存列表授权。
- 新发布 preflight：继续检查全根 unresolved，包括其他 owner 的 deferred，不能因为当前 owner 的结果已完成就放行新发布。

### 4.3 不可绕过的执行顺序

1. Main 冻结 owner 表和 dispatcher authority；缺失/重复注册在副作用前以 `PUBLICATION_RECOVERY_OWNER_REGISTRATION_INVALID` 拒绝。旧 raw recovery export 不保留“无 authority 默认放行”。
2. 调用方提交 root 固定的请求，在进入 FIFO **前**按原资源合同取得 observation lease；publish 同样在 enqueue 前取得并保持至 publish/必要自恢复全部结束，自动恢复不得在占有 FIFO 时再等额外 lease。已有 BizOP `io()` 租约通过受验证的 capability 借用，避免同一操作再申请 1 GiB 造成自阻塞。只读 owner 身份判断不依赖新写入。需要新租约时继续沿原 5 秒 admission，不在占用 FIFO 后排队申请。
3. 同一 FIFO 队列项中等待只读 discover worker 真正退出，然后由 Main 对整份 snapshot 逐项确定归属和权限。一个记录匹配两个 owner、字段相互矛盾或未知，整轮在执行 worker 启动前拒绝；不先清理前面的合法记录。非法 ack ids 同样先拒绝。`defer` 可保留已知但 closure/hold 未放行的记录，绝不授予写权限。
4. 已授权集合送入 execute worker。worker 在 lifecycle mutex 内重新读取并核对完整 indexDigest、每条 recordDigest 及原 target-parent/anchor 证据；发现外部变化，以 `PUBLICATION_RECOVERY_SNAPSHOT_CHANGED` 零写拒绝，等待下一次显式重试。先验证整份快照，再逐记录调用原恢复算法；任何缺 grant、taskId/owner/permission 错配均拒绝，不能降级为全根扫描。原算法每次文件修改前的 fresh identity/hash 校验继续保留。
5. `recover-uncommitted` 只允许原取消/回滚路径；`observe-committed` 只返回原 handoff-pending 事实；`ack-stage` 允许原 backup/staging 清理但必须保留 finalizing receipt；`ack-finalize` 才允许在原 proof 条件满足后完成 journal/index 收尾。缺 batchContext/files 不再隐式视为 ack。不得把观察许可用于 cleanup。
6. 执行已开始后的 IO 错误仍按原算法留存 durable evidence 和错误，并不承诺整根事务回滚。所有已启动 discover/execute/transport-recovery worker 真实退出后才结算公共 Promise，再释放本次拥有的 lease；借用租约仍由原 `io()` 外层写 closure、释放。未真实 exit 不记 closure、不释放 pin、不通过 Promise.race 提前返回。

所有 grant 和 capability 均是 Main 内部能力，不构成新 Renderer IPC。Worker 只能接收 coordinator 经同一 dispatcher 队列生成的 frozen data；不得接受调用业务方提供的 grant、ownerId 或路径。新 worker op 使用 `discover-recovery` / `execute-recovery`，旧不带 grant 的 `recover` 在生产路由禁用，直接调用底层恢复函数缺 authority 以 `PUBLICATION_RECOVERY_AUTHORITY_REQUIRED` 零写拒绝；grant 的字段/许可不匹配使用 `PUBLICATION_RECOVERY_GRANT_INVALID`。这两类错误与 unknown/conflict/snapshot-changed 一样设置 `preserveTemporaryFiles=true` 并携带原恢复路径，不通过清空目录恢复“正常”。

### 4.4 owner 识别与历史记录

| 记录证据 | 归属与权限 |
| --- | --- |
| `biz-op-v327-export-<taskRunId>` + 持久 publication binding/intent digest + exact-7 batchContext 一致 | `biz-op-v327`；前缀仅作为候选，必须通过现有 binding、task、protection/closure、commit proof、archive-settled/terminal 判断；ack 继续由原 `io()` 调用链提出 |
| exact-7 context 能绑定原 Archive batch/task/operation，符合共享发布调用方的静态登记 | `archive-publication`；复用原 manifest/legacy handoff、ready artifacts、terminal/completion 验证，不能因为不是 BizOP 就自动接受 |
| 已确认的历史有锚点记录，缺新增加的内存 owner 字段 | 按原持久 exact-7、绑定与路径证据识别；不要求回写 owner 字段；满足相同证明即可恢复 |
| 旧 index 缺 `discoveryState` | 沿用原 legacy-index 人工恢复错误，保留原始 index/journal/staging/目标；不能补猜锚点 |
| 有锚点但缺足够的 task/batch/owner 证明，或只有任务前缀/当前文件存在 | `PUBLICATION_RECOVERY_OWNER_UNKNOWN`，所有状态保留；这是本次明确的兼容安全收紧，不能写成所有旧记录自动恢复等价 |
| 两 owner 均声明、index/journal 的身份不一致或跨 owner ack | `PUBLICATION_RECOVERY_OWNER_CONFLICT`（原身份错误能更准确表达时保留原 code）；保留材料，无 receipt 确认 |

BizOP 当前 `io()` 会在 work 之前写本次 STARTED/attempt nonce，因此 owner 授权不能再次把“本次 io 的 live closed=false”当成其他活跃发布。借用 capability 必须绑定同一 task、nonce、operation kind 和 io 进入前已通过的 closure/protection 证明，允许当前 io 的恢复 work；其他 task/nonce 的活动写入仍 deferred。新 closure 只在当前全部 worker 真正退出后由原 io finally 写入。最小回归须证明自身 recover/ack 不自阻塞、伪造或异任务 capability 不被接受。

`archive-publication` 的静态调用表须在 G1-T4 记录完整 `taskKey/moduleId` 与 proof provider。初始以现有 `PUBLICATION_ONLY_FILE_TASKS` 十二项为一个来源，同时独立登记 ReconID 导出和 NewAccount save-as 的原 owner contract；这个列表不是全部 publisher 的兜底权限。Toolbox split-rows 等若与上述已有 taskKey 共用身份，沿原 producer 的真实 exact-7 值核对，不按 UI 名猜测新增键。实施补充：沿实际 `publishReadOnlyExportArtifacts` 调用链还登记 `position-reconciliation:run:export` 与 `position-reconciliation:run:export-filtered`（`position-reconciliation-process`）；bank/linked/raw 旧 service 导出不因此获得权限。NewAccount manifest 的专用角色和 `new-account:save-as` 来源沿原 save-as 合同核验。实际调用表与 proof provider 见[现行说明](../../../../src/main-process/application-recovery/README.md)。

NewAccount 的 `taskTerminalPersisted:true` 只是调用前置，不能替代真实 Archive terminal/artifact 证明。不存在持久 proof 的测试合成记录使用测试 authority，生产不得为测试放宽校验。

| journal/index 状态 | 已知合法 owner | 未知、冲突或证据不足 |
| --- | --- | --- |
| preparing / prepared / cancelling | `recover-uncommitted` 后执行原取消及受管 stage 清理 | index、journal、stage、backup、正式目标均保持原样 |
| publishing / rolling-back / rolled-back / rollback-finalizing | `recover-uncommitted` 后执行原回滚或回滚收尾；保留原 target/backup 核验 | 同左五类材料均不修改、不先试回滚 |
| committed / committed-cleanup-pending / finalizing | 先 observe；只有合法 owner 的相应 ack/proof 才 stage/finalize | 不 cleanup、不删除 receipt；缺 lineage 也不隐式确认 |
| manual-recovery / 损坏 / 无锚点旧格式 | 保留现有失败关闭及恢复路径 | 保留文件，仅返回可诊断错误 |
| 活动任务或 known owner 的 closure/hold 尚未放行 | 原 active 跳过，或显式 deferred；不得返回“没有 journal” | 不通过活动标签掩盖跨 owner 身份冲突 |

### 4.5 全部调用方迁移及队列重入

| 当前入口 | 迁移后的唯一路径 / 保留责任 |
| --- | --- |
| Main `recoverToolboxPublicationsAtStartup` → BizOP `recoverOtherOwners` | 注入 `forOwner('archive-publication').recover`；原 Archive owner hook/错误汇总不变；兼容 `recoverOtherOwners` 仅转发，生产迁完删除 |
| Main `publishToolboxArtifacts` 实时 Archive handoff、`acknowledgeToolboxPublicationReceipts` | 所有 discover、ack-stage、ack-finalize 调用都用同一受限 facade；原 outbox/manifest/terminal/completion 顺序留在 `toolbox-archive-recovery.js`；聚合完整透传 deferred/observation，requested task 未决不确认 |
| `toolbox-archive-recovery.js` 与 `vcc-financial-op-output-recovery.js` 的默认 raw fallback，以及 VCC output dispatch 的注入 | 改为必需的受控 facade；未注入在开始恢复前拒绝；继续保留原 VCC generation cleanup 所有者和 handoff warning |
| BizOP `export-publication.reconcile/acknowledge` 与业务 retry | 原任务级 `io()`、proof、pin、closure 保留；在 work 内调用 BizOP facade，传已验证的 observation capability；reconcile 与 acknowledge 都传 `taskIds:[bound.publisherTaskId]` 并显式消费 deferred/absence，ack 另传同 task 的 acknowledgedCommittedTaskIds；ACK_PENDING 前不写 acknowledgement/cleanup |
| NewAccount `acknowledgeNewAccountSaveAsPublication` | 注入 Archive owner facade 的 task 受限接口，复核原 exact-7/terminal/artifact 后确认；移除 raw fallback |
| `createToolboxPublicationMatureBinding` 的 recover operation | Main 装配受控 facade；request payload 不能自选 root/owner/授权；原 publish 仍用同一 FIFO |
| dispatcher `publish` transport-error 自动恢复 | 等失败 worker 真实 exit 后，在**当前队列项内部**调用同一个 discover→authorize→execute primitive；不得调用会再次 enqueue 的公共 facade 造成自等待；仅符合原 committed handoff 条件才报告 recovered commit |
| `prepareToolboxPublication` 的隐式 `recoverPendingInternal`（原 `:2412`） | publish 队列项先完成同样的授权恢复；底层 prepare 不再自发全根恢复，收到一次性 preflight snapshot 证明后只读复核 root 未变化；若有 pending handoff 继续原阻断，不自行 ack |
| ReconID/NewAccount/VCC/Toolbox/BizOP 各 publish caller | 全部使用已绑定 authority 的 dispatcher；新发布前恢复和失败后恢复不能依赖调用者是否恰好传了 recover 参数 |

publish preflight 检查的是全根授权结果，任何 owner 的 handoff-pending 或 deferred 都继续阻止新发布，不能使用对调用方过滤后的 recovered 空数组放行。preflight 的证明绑定当前 FIFO 项、root、恢复后的 indexDigest 和待发布 taskId，只能消费一次。恢复结束与 prepare 之间 index 有变化则拒绝，不能跳过授权重扫。owner 的 identify/authorize/lease 方法禁止调用 publisher dispatcher；业务 handler 不可持有通用 recovery grant。该限制防止嵌套队列和租约相互等待。

BizOP observation 预算沿用 `EXPORT_IO_RESOURCES`（CPU 1 / worker 1 / I/O 1 / memory 1 GiB）。借用有效 `io()` lease 时不再申请；其他 owner 触发共享扫描且 BizOP 存在 `cleanup_completed=0` 时仍按原条件申请共享 observation lease。新设计不得向所有注册 owner 无条件再申请一份预算。Archive adapter 未新增额外资源配额。半途 admission 失败只释放已经取得且未启动 work 的本次 lease。

## 5. 兼容、异常与回滚

除 §4 明确的 owner 授权错误和历史证据不足时保留行为外，公共数据和原错误归一保持原样。持久化 source、request owner、hold、receipt、journal、Archive terminal intent 不升级版本，不迁移历史记录。共享协调器的 owner 注册表在任何扫描前校验/冻结，不提供热注册或 Renderer 插件入口。

历史 terminal route 的解析留给 G2/现有 Controller，本分支不能因为 owner registry 没有某个旧业务而丢弃其 outbox。恢复顺序中 owner 失败仍按原 Controller 聚合；`summary.ready=false` 继续由既有 BizOP admission 阻断对应业务，不擅自升级或降级为新的全局策略。

回滚以本功能代码为单位恢复原装配/调用，数据库和恢复文件不回写。只要尚未放行业务，不允许新旧协调器同时运行；如本次启动已经执行持久副作用，退出后由上一版本从同一 durable facts 恢复。不得删除待恢复 journal、pin、receipt 或临时目录作为回滚步骤。

## 6. 实施任务及验收映射

| 任务 | 具体完成条件 | AC |
| --- | --- | --- |
| G1-T1 | 为基线 normal/deferred/owner 失败/activation 录制行为断言，建立 phase spy 和临时 DB 组合 fixture | G1-AC-02、G1-AC-03、G1-AC-06 |
| G1-T2 | 新增应用协调器与 participant；Main 和 Duplicate 改用平台只读 snapshot；旧 driver 状态移除 | G1-AC-01、G1-AC-02、G1-AC-07 |
| G1-T3 | 按 §3 接入原 Archive hooks；验证 post-owner replay、失败聚合、post-outbox 和 ready 的顺序 | G1-AC-02、G1-AC-03、G1-AC-06 |
| G1-T4 | 实现只读 discovery / owner 决策 / 授权执行；按 §4.5 逐个迁移启动、live ack、BizOP retry、NewAccount、mature、隐式 preflight、transport-error，保留原资源闭包 | G1-AC-04、G1-AC-05、G1-AC-07、G1-AC-08、G1-AC-09 |
| G1-T5 | 迁移接线字符串测试为公开接口行为；生产调用与测试不再引用兼容入口后删除 shim | G1-AC-01、G1-AC-06、G1-AC-07 |

## 7. 测试与完成门禁

| 类型 / 路径 | 场景 | AC |
| --- | --- | --- |
| 拟新增 `tests/unit/main-process/application-recovery.test.js` | platform facade 仅成功写完成事实；phase 单飞；有/无 BizOP 来源；owner 失败后后续 hook 与 outbox 顺序 | G1-AC-01、G1-AC-02、G1-AC-03、G1-AC-07 |
| 拟新增 `tests/unit/main-process/publication-recovery-owner.test.js` | preparing/prepared/publishing/committed/finalizing 各状态未知/冲突/旧证据不足时 index/journal/stage/backup/目标前后摘要不变；合法历史 owner 正向；snapshot 漂移和缺 grant 零写拒绝 | G1-AC-04、G1-AC-06、G1-AC-08、G1-AC-09 |
| 拟新增 `tests/unit/main-process/publication-recovery-entrypoints.test.js` | §4.5 每入口均触发同一授权，含 publish 内隐式恢复及 transport-error；requested ack 被 defer 时 BizOP ACK_PENDING、acknowledged/cleanup_completed 不变且 cleanupStage 零次；完整 absence+原 proof 才允许幂等，reconcile 原明确回滚/取消结果仍能形成 NOT_COMMITTED；Archive 三阶段透传 deferred，启动阻断/live pending/全根 preflight 不放行；ack-stage 不删 receipt；借用 lease 不二次申请；延迟 exit 不早释资源；内部恢复不 enqueue 自等待 | G1-AC-04、G1-AC-05、G1-AC-08、G1-AC-09 |
| 复用 `tests/unit/main-process/biz-op-v327-startup-resource-recovery.test.js`、`biz-op-v327-phase-admission.test.js` | 原任务恢复、零预算、5 秒排队、取消和 pin/closure；按新入口更新装配 | G1-AC-02、G1-AC-05、G1-AC-06 |
| 复用 `tests/unit/main-process/archive-center-controller.test.js`、`toolbox-archive-integration.test.js` | outbox/owner 故障顺序、已提交 publication 归档后 ack | G1-AC-03、G1-AC-04、G1-AC-06 |
| 复用 `tests/unit/duplicate-inbound-match-wiring.test.js` 和 `tests/unit/main-process/duplicate-inbound-match/startup-recovery.test.js` | 以应用 snapshot/hold 行为替换 BizOP 文件字面量断言 | G1-AC-01、G1-AC-02、G1-AC-06 |
| 拟新增 `scripts/integration/application-recovery-governance.js` | 真实临时 SQLite、journal 与隔离 userData，组合历史 owner 和被中断任务，重启两次核对幂等；未知 owner prepared 与 committed 从实际启动/live/transport 路径均保留 | G1-AC-02—G1-AC-06、G1-AC-08、G1-AC-09 |

上述为设计阶段的验证计划；实际已执行命令和结果在实施记录中单独维护。实施时先跑对应单测与集成脚本；正式 PR-ready/交付再跑 `npm run release-check` 并保存最终验证记录。真实 Electron 冷启动须使用隔离 userData/Documents；Windows 文件锁、真实进程退出和平台耐久性未验证时单独标注，不能以 stub PASS 代替。

G7 只能引用本稿 participant/coordinator 接口并汇总注册，不改变阶段、预算或 owner 失败策略。G8 同步激活 `ARCH-BIZOP-RECOVERY-PRIVATE`（其他业务不得深引 BizOP recovery/publication 私有入口，Main composition 的静态装配允许）和 `ARCH-PUBLICATION-RECOVERY-ENTRY`（raw recovery、worker 恢复 op 与底层 prepare 恢复仅允许 §4 的 dispatcher/worker/core 实现调用；业务必须经受限 facade）。每条历史 shim 按精确文件/符号登记，G1-T5 删除后撤销例外。最小反例分别是 Toolbox 再次调用 `recoverOtherOwners`、NewAccount 引回 raw fallback、publish prepare 恢复无 grant；合法例为 Main 装配 owner 和 worker 执行经验证 grants。静态规则不能证明授权先于 IO，必须由 entrypoints 行为测试作为同切片门禁；只有两者均通过才激活。

## 8. 切片实施记录与规则同步（文档补充）

沿用本稿既有阶段及任务 ID，按[切片完成标准](../../README.md#slice-completion)逐项交付。优先复用本功能目录已有的 `implementation-notes.md` / `verification.md`；首次实施且没有适用记录时建立 `implementation-notes.md`，使用[实施记录与状态要求](../../README.md#slice-record)中的最小字段，避免同一事实多处维护。设计 AC 和测试计划与实际迁移状态、执行结果分别记录，本次不建立实施记录占位文件。

按[各治理项现行规则入口映射](../../README.md#current-rule-entrypoints)同步本切片影响的规则正文和入口链接。只有职责已在实际生产调用路径落地的模块才能记为现行入口，尚未实现的模块继续标为拟新增；不影响规则时，在切片记录中写明无需更新及原因。本次为文档要求补充，不表示生产实现、边界激活或验证已经完成。

## G7 消费的注册快照入口（实施补充）

`application-recovery/composition.js` 导出 `createApplicationRecoveryParticipants(context)` 和固定 `RECOVERY_PARTICIPANT_ORDER`，供 G7 聚合已有注册项；`createApplicationRecoveryComposition` 可消费显式 `participants`，必须与原固定顺序完整一致，否则在创建 coordinator 前拒绝。默认调用仍使用同一注册快照工厂。此补充只提取既有 registrations，恢复执行、phase、owner proof、publication 授权和副作用仍归 G1 原 coordinator，不引入第二套恢复路径。G7 拆分/重新聚合后须按该 G1 顺序传回，不能由 descriptor 枚举顺序决定启动次序。
