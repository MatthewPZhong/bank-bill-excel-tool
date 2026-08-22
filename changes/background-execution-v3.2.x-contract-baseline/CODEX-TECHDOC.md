# Codex TechDoc — Background Execution Platform Contract v1

## 1. 实施边界

本 TechDoc 用于 Codex 实现 v3.2.0 的 E02-A/B/C1/C2。业务模块后续按 `changes/3.2.0`～`changes/3.2.5` 分版本接入。

建议目录；如仓库已有更接近的命名，可调整文件名，但职责和依赖方向不得改变：

```text
src/main-process/background-execution/
├── index.js
├── protocol.js
├── protocol-validator.js
├── execution-policy-registry.js
├── supervisor.js
├── service-host.js
├── error-codec.js
├── metrics.js
├── resource-governor.js
├── admission-queue.js
├── resource-lease.js
├── recovery-source.js
├── inspector-registry.js
├── settlement-recovery-provider-registry.js
├── recovery-control-repository.js
├── recovery-control-read-repository.js
├── startup-recovery-coordinator.js
├── task-lifecycle-adapter.js
├── canary/
│   ├── worker-entry.js
│   ├── canary-receipt-store.js
│   └── canary-inspector.js
└── adapters/
    ├── inline-async-adapter.js
    ├── worker-thread-adapter.js
    ├── utility-process-adapter.js
    └── existing-dispatch-adapter.js
```

公共层不得 require 具体对账/金额/工作簿业务模块。模块通过 Registry 中的静态 key 注入 entry、inspector、scope resolver、settlement provider 和 validators。

## 2. 依赖方向

```text
Schema/Policy Registry
        ↓
Protocol Validator
        ↓
Supervisor / ServiceHost
        ↓
Transport Adapters

ResourceGovernor ← Supervisor / ServiceHost

Main Control DB
  ├── RecoveryControlRepository（唯一顶层写事务入口）
  │     └── RecoveryControlTransactionV1（作用域内 transition / observation writer）
  ├── RecoveryControlReadRepository（只读扫描）
  └── StartupRecoveryCoordinator

InspectorRegistry ← StartupRecoveryCoordinator → SettlementRecoveryProviderRegistry
```

禁止反向依赖：

- Worker 不得 import ResourceGovernor；
- Provider 不得调用或实现自己的 Inspector；
- Inspector 不得调用 Provider、写业务状态或清理证据；
- Repository 不得依赖 Renderer；
- Supervisor 不得直接写 TaskRun 最终成功。

## 3. Schema 加载

开发/测试使用仓库中的 JSON Schema：

```text
changes/background-execution/platform-contract-v1.schema.json
changes/background-execution/platform-protocol-v1.schema.json
changes/background-execution/platform-recovery-source-v1.schema.json
```

生产代码不得依赖用户可修改路径。构建时采用以下一种方式：

1. 将 Schema 作为受控静态资源打包；或
2. 生成等价的冻结 JS validator，并在测试中用 Schema fixture 对照。

不得手写另一套枚举。

## 4. Policy Registry

### 4.1 Registry API

```javascript
createExecutionPolicyRegistry({
  policies,
  entryRegistry,
  adapterRegistry,
  inspectorRegistry,
  scopeResolverRegistry,
  settlementProviderRegistry,
  publisherRegistry,
  validatorRegistry
})
```

必须提供：

```javascript
registry.freeze();
registry.get(actionKey);
registry.assertRunnable(actionKey, { production });
registry.snapshot();
```

启动 freeze 时检查：

- static `actionKey` 唯一；
- mode 仅四种；
- `existing-dispatch` 是 adapterKind，不是 mode；
- 所有静态 key 可解析；
- commit/receipt/Critical Intent 条件符合 Schema；
- artifact action 具备 FilePlan、Publisher 和双层 validator；
- blocked action 不可 production enabled；
- service action 具备 Service Control 和资源策略。
- 每个 action 都有精确 `protocolLimits.commandMaxBytes/eventMaxBytes=262144`；使用 UTF-8 bytes，不用 JS 字符数估算。

## 5. Protocol v1

### 5.1 唯一规范来源

Protocol 的字段、必填项、operation 枚举、条件约束与 payload shape **只以**以下机器合同为准：

```text
changes/background-execution/platform-protocol-v1.schema.json
```

本 TechDoc 不维护第二套手写完整类型。实现、fixture、JSDoc/TypeScript 类型和测试必须从该 Schema 生成或机械核对。Schema 与本摘要不一致时，Validator 必须 fail closed，先修正文档/摘要，禁止 Codex 自行选择其中一套。

### 5.2 Schema 派生摘要（机器校验）

以下 JSON 是 Codex 导航摘要，不替代 Schema；`validate_background_execution_baseline.py` 会逐字段与 `$defs.jobEnvelope`、`$defs.serviceControlEnvelope`、`$defs.jobRef` 及规范 seq scope 比较。

<!-- BEGIN CODEX_PROTOCOL_SUMMARY_V1 -->
```json
{
  "summaryVersion": 1,
  "normativeSchema": "changes/background-execution/platform-protocol-v1.schema.json",
  "jobEnvelope": {
    "required": [
      "protocolVersion",
      "channel",
      "direction",
      "operation",
      "actionKey",
      "operationKey",
      "jobId",
      "workerInstanceId",
      "serviceGeneration",
      "unitId",
      "seq",
      "context",
      "payload"
    ],
    "operations": [
      "job:start",
      "unit:start",
      "job:cancel",
      "unit:cancel",
      "critical:ack",
      "critical:reject",
      "job:progress",
      "unit:progress",
      "unit:done",
      "unit:error",
      "critical:ready",
      "commit:receipt",
      "job:done",
      "job:error",
      "cancel:ack"
    ]
  },
  "serviceControlEnvelope": {
    "required": [
      "protocolVersion",
      "channel",
      "direction",
      "operation",
      "serviceKey",
      "controlId",
      "workerInstanceId",
      "serviceGeneration",
      "seq",
      "jobRef",
      "payload"
    ],
    "operations": [
      "executor:init",
      "executor:close",
      "resource:grant",
      "resource:reject",
      "resource:adopt-ack",
      "resource:revoke",
      "resource:release-ack",
      "executor:ready",
      "executor:error",
      "executor:close-ack",
      "resource:request",
      "resource:adopted",
      "resource:release"
    ]
  },
  "jobRef": {
    "required": [
      "actionKey",
      "operationKey",
      "jobId",
      "unitId"
    ]
  },
  "sequenceScopes": {
    "job": [
      "jobId",
      "workerInstanceId",
      "direction"
    ],
    "service-control": [
      "serviceKey",
      "serviceGeneration",
      "workerInstanceId",
      "direction"
    ]
  }
}
```
<!-- END CODEX_PROTOCOL_SUMMARY_V1 -->

实现注意：

- Job Envelope 的 `context` 始终必填；没有业务 context 的平台 canary 也必须使用 Schema 允许的 `none` context，而不是省略字段；
- `unit:progress` 是合法 Job operation；不得只实现 `job:progress`；
- 非空 Service `jobRef` 必须同时包含 `actionKey`、`operationKey`、`jobId` 和 `unitId`；
- `executor:init/ready/close/close-ack` 的 `jobRef` 必须为空；资源采用/替换/phase 请求按 Schema 条件携带完整 `jobRef`；
- `controlId` 只关联一次 control exchange，**不得**作为 seq tracker scope，也不得导致每次请求重置 seq。
- exact-5 只含 `taskRunId/taskKey/moduleId/parentRunId/operationKey`，exact-7 只再增加 `batchId/batchNumber`；context operationKey 必须等于 envelope operationKey，`none.value` 必须为空，job/unit/grant/reservation/intent 与额外字段禁止进入 context；
- 15 个 Job operation 的 payload 必须使用 Schema 冻结的精确外层 wrapper：`input/progress/result/error/critical/receipt/cancel/cancellation`。模块 body 交给 entry/result/SafeError/receipt 等对应 validator，Supervisor 不猜字段；
- 每个 policy 必填 `protocolLimits.commandMaxBytes/eventMaxBytes=262144`，按完整 UTF-8 compact JSON envelope 计数；错误条目、artifact 和 progress 继续复用既有三个 policy 上限。

### 5.3 Sequence tracker

单调 `seq` 的权威作用域固定为：

```text
Job Envelope:
  (jobId, workerInstanceId, direction)

Service Control Envelope:
  (serviceKey, serviceGeneration, workerInstanceId, direction)
```

每个作用域首条 `seq=1`，之后严格等于 `last + 1`。gap、重复、回退、旧 generation、错 direction、终态后消息和重放消息均 fail closed；late terminal 只记诊断，不再次 settle。`controlId`、`requestId`、`grantId`、`reservationId` 是关联身份，不进入 seq scope。

Service reply 的 `seq` 属于发送方自身 direction 的独立 tracker，必须取该 direction 的 `last + 1`；不得复制或要求等于对向 request/event 的 `seq`。exchange 仅用 `controlId/requestId/grantId/reservationId` 关联。

## 6. Supervisor

### 6.1 Job record

```javascript
{
  actionKey,
  operationKey,
  jobId,
  policySnapshot,
  state: 'queued' | 'spawning' | 'running' | 'cancelling' | 'settled',
  transport,
  resourceLease,
  units: Map,
  seqTrackers: Map,
  criticalIntentId: null,
  settleGate,
  timers,
  metrics
}
```

### 6.2 Exactly-once terminal

第一个合法的：

- `job:done`；
- `job:error`；
- spawn failure；
- timeout；
- unexpected exit；
- protocol failure；

赢得 execution terminal。关闭 gate 后：

1. 清 timer/listener；
2. 停止新 unit dispatch；
3. 释放 execution lease；
4. 仅返回一个 `ExecutionResultV1`；
5. 不直接设置业务 Task success/failed。

ExecutionResultV1 terminalSource 权威枚举：

```text
job:done
job:error
init-timeout
execution-timeout
cancel-timeout
adapter-error
spawn-error
unexpected-exit
protocol-error
```

`job:done.payload.result` 是唯一模块结果载体，先由 `policy.result.validatorKey` 校验，再由 Supervisor 写入唯一 `ExecutionResultV1.result`；其他 terminal 的 result 为 `null`。模块不得另造第二套 canonical internal terminal event。`job:done` 仅在全部 registered unit 为 policy 允许终态且无 unknown unit 时合法；`job:error` 早停时 Supervisor 在内部清理剩余 unit。

### 6.3 Cancellation

- queued：取消 admission；
- pure compute：发 cooperative cancel；
- protected：返回 `protected/not-cancellable`；
- terminate 只释放执行载体，不证明 rollback；
- 只有 inspector/transaction 证明未提交时，Task 才能落 `cancelled`。

## 7. ResourceGovernor

### 7.1 Main-only API

```javascript
governor.acquireBaseLease(request)
governor.acquirePersistentReservation(request)
governor.acquirePendingInteractionReservation(request)
governor.acquirePhaseLease(request)
governor.acquireCompoundLease(request)
governor.replaceReservationAtomically({ oldReservationId, nextRequest })
governor.release(resourceId)
governor.snapshot()
```

每个资源对象包含不可复用的 ID、owner identity、budget、createdAt 和 releasedAt。

### 7.2 Service handshake

```text
Worker: resource:request(requestId, requestKind, footprint, jobRef)
Main:   resource:grant(requestId, grantId, reservationId) 或 resource:reject
Worker: 构造/保留候选 state；未 adopt 前不得公开 token/revision
Worker: resource:adopted(requestId, grantId, reservationId, stateRevision)
Main:   resource:adopt-ack
Worker: 才能对 job 返回新 token/revision
...
Worker: resource:release(reservationId)
Main:   resource:release-ack
```

失败规则：

- grant 后 adoption timeout：Main revoke/release；
- Worker crash：Main 根据 owner identity exactly-once 释放；
- stale generation/requestId/grantId/reservationId：拒绝；
- atomic replace 失败：旧 reservation 继续有效，候选 state 不采用。

request matrix 固定为：persistent-state-replace/service-state（首次 null，后续精确引用当前 adopted reservation）、pending-interaction-create/interaction-token/null、phase-extension/phase/null；错 kind、非法 replaces 和 stale current reservation 均 protocol-error。

Worker dynamic resourceVector 只含 memoryBytes/cpuSlots/ioHeavySlots；Main 扩展为五维时固定 workerThreadSlots=0、utilityProcessSlots=0，OS 载体已由 spawn 前 BaseLease 计入。

### 7.3 全局额度

`CPU-2` 是全应用额度，不是每个模块额度。Worker thread slot 与 utility process slot 分开计数。existing nested pool 必须申请 CompoundLease；adapter 不额外 spawn。

`resources.base` 是唯一 root executor，compound 不重复 root 且 `childResource` 必填。active compound = resources.base + resources.phase + childResource * effectiveChildCount；childrenMax/effectiveChildCount 只计 children，不含 root。其他 persistent/pending reservation 按实际存活期另计，不双算。

## 8. Persistence

所有平台控制表固定写入当前 Main-owned 主控制数据库。模块 receipt 继续写在业务 mutation 所在 DB/文件系统边界。

### 8.1 Critical Intent

字段至少包括：

```text
intent_id, action_key, operation_key, task_run_id, job_id,
coordination_kind, state, conflict_scope_key, inspector_key,
evidence_version, evidence_json, evidence_sha256,
receipt_ref_json, result_json, created_at, updated_at, closed_at
```

唯一键：

```text
(task_run_id, action_key, operation_key)
```

合法状态：

```text
prepared → acked → committed → closed
prepared → recovered → closed
acked → recovered → closed
```

禁止 `committed → recovered`。已 committed source 的 settlement 恢复只更新 TaskRun、Batch overlay、Recovery Hold 与 recovery events，Intent 仍由 `committed → closed` 收口。

只允许：

- `worker-durable` → `worker-critical`；
- `main-settlement + target-post-image` → `main-owned-settlement`。

`publisher-journal` 与 `existing-critical-protocol` 不得写平台 Intent。

### 8.2 Recovery Hold

Hold source kind：

```text
critical-intent
publisher-journal
target-post-image
existing-protocol
module-recovery
manual
```

其中 `manual` 不是 RecoverySourceV1。`critical-intent/target-post-image` 必须有 intentId，其他必须为空。

Active hold 对 `conflictScopeKey` 建立唯一 gate，阻断 managed 与 legacy mutation。只读和 recovery action 由 policy 决定。

### 8.3 Batch overlay 与 recovery events

不重建既有 Batch 表。新增 overlay：

```text
state = interrupted | recovering | resolved
finalOutcome = null | succeeded | failed
```

Effective status：

```text
无 overlay                             → 原 task_status
interrupted                            → interrupted
recovering                             → recovering
resolved + succeeded                   → succeeded
resolved + failed                      → failed
```

TaskRun 的恢复相关状态迁移，以及 Batch overlay、Recovery Hold、Critical Intent 的每次状态迁移，与对应 append-only recovery event **必须在同一个 Main-owned control DB transaction 内提交**。Event 不得更新或删除；禁止先提交状态后异步补 event，也禁止以消息顺序、重试或任何事务外排序机制替代数据库原子性。

实现边界固定为：

```javascript
RecoveryControlRepository.runInControlTransaction((tx) => {
  tx.appendObservationEvent(observation);       // zero or more, event-only
  tx.transitionWithRecoveryEvent(transition);   // zero or more, state + event
});
```

`RecoveryControlRepository` 顶层不得暴露上述两个 writer；回调获得的 `RecoveryControlTransactionV1` 才能调用它们。`transitionWithRecoveryEvent()` 是唯一状态 mutation，每次执行一个 CAS transition 并追加一个对应 event；`appendObservationEvent()` 只能追加 observation，不能更新状态。

无状态迁移的 `inspection-completed / inspection-failed-transient / settlement-resumed / settlement-failed-transient` 只能通过同一事务作用域内的 `RecoveryControlTransactionV1.appendObservationEvent()` 追加；该方法不得修改任何控制状态，写入事件的 `previous_state / next_state` 必须均为 `NULL`。sourceKind 必须使用不含 `manual` 的 RecoverySourceV1 enum。

一次恢复动作更新多个控制对象时，Main 必须只调用一次 `RecoveryControlRepository.runInControlTransaction()`，并在同一个 `RecoveryControlTransactionV1` 上完成全部 transition 与 observation event；事务作用域内方法不得独立 BEGIN、COMMIT 或 ROLLBACK。回调必须同步且不得跨 Inspector/Provider/文件 I/O 的 `await` 持有 SQLite transaction。

RecoveryControlRepository 只接管 `prepared/running → interrupted`、`interrupted → running(recovery)`、`running(recovery) → succeeded/failed/interrupted` 这些 TaskRun 恢复相关边。常规 `prepared → running` 与非恢复执行终态继续由既有 TaskLifecycle/ArchiveRepository 管理。底层 `appendRecoveryEvent()` 只能是 package-private SQL primitive；`RecoveryControlReadRepository` 保持纯只读。

不要让调用方传 `eventType`。`transitionWithRecoveryEvent()` 必须使用 E00 TechDoc 标记区块 `RECOVERY_TRANSITION_EVENT_MAP_V1` 的逐 command 映射；Batch overlay 只允许 `absent → interrupted → recovering → resolved`，Critical Intent 只允许 8.1 的三条路径。Hold `create-or-get` 的 eventId 按 source identity 稳定派生，已有 Hold 搭配新 eventId 必须 fail closed。

`batch-overlay.mark-interrupted` 在同一 transaction object 内完成基础 `task_status=failed`、overlay interrupted 与 event 三项写入；恢复 success 只将 overlay resolve 为 succeeded，基础 failed 作为兼容 interruption 历史保留。

## 9. RecoverySourceV1

唯一字段来自 `platform-recovery-source-v1.schema.json`：

```javascript
{
  contractVersion: 1,
  sourceKind,
  sourceRef,
  actionKey,
  operationKey,
  taskRunId,
  conflictScopeKey,
  inspectorKey,
  settlementKey,
  intentId,
  evidenceVersion,
  boundedEvidence
}
```

禁止字段：`intent`、`receiptHint`、`safeEvidence`。

映射：

| sourceKind | intentId | settlementKey | 来源 |
| --- | --- | --- | --- |
| `critical-intent` | required | null | open worker-durable Intent |
| `target-post-image` | required | required | open Main-owned Intent |
| `publisher-journal` | null | required | Publisher Provider |
| `existing-protocol` | null | required | existing protocol Provider |
| `module-recovery` | null | required | module recovery Provider |

`boundedEvidence` canonical JSON 后不超过 64 KiB；不得包含完整原始行、密码、完整账号或用户任意路径。

## 10. Inspector 与 Provider

### 10.1 InspectorRegistry

```javascript
inspectorRegistry.register(inspectorKey, async source => inspection)
inspectorRegistry.get(inspectorKey)
```

Inspector：

- 只读、幂等；
- 可以通过 `intentId` 读取 Intent；
- 不枚举 source；
- 不恢复 settlement；
- 不清理证据；
- 只能返回 `committed/not-committed/partially-committed/compensated/unknown`；
- `committed` 必须指向唯一权威 receipt/post-image/journal identity。

### 10.2 SettlementRecoveryProviderRegistry

```javascript
provider.listOpenSources()
provider.recover(source, inspection)
```

`recover()` 必须按 `(sourceKind, sourceRef, operationKey)` 幂等；inspection evidence hash 只作 CAS/审计输入。Provider 返回后、控制状态落库前 crash 时，启动恢复可重复调用而不重复 publish、generation 或业务 mutation。

Provider 没有 `inspect()`。

- `listOpenSources()` 只读、有界、幂等；
- `recover()` 只在 Inspector 结论后调用；
- 只恢复 Publisher、archive、continuation、mirror completion 或 Task settlement；
- 不重新 generation，不重新运行业务匹配，不重复 mutation。

## 11. Critical 流程

### 11.1 worker-durable

```text
Main 检查无 active hold
→ create intent prepared
→ 在业务锁内 preCommitCheck
→ mark intent acked
→ 发送 critical:ack
→ Worker BEGIN/mutation/同事务 module receipt/COMMIT
→ commit:receipt
→ Main mark committed
→ job:done
→ Main settlement
→ close intent
```

ACK 丢失后 intent 保持 acked，必须 inspect；不得删除后重跑。

### 11.2 Main-owned target-post-image

Recovery result 的机器权威是 `platform-recovery-source-v1.schema.json` `$defs`；Provider 输出 identity/hash mismatch fail closed，只有 `completed` 可原子收口，`incomplete` 保持 open/interrupted，transient/terminal failure 创建或累计 hold 且不得重做 mutation。Inspector/Provider registries 必须先 register 全量 static keys 再 freeze，freeze 后 register 拒绝；Main DB init → register/freeze → open intents/provider sources/active holds scan → owner initialize/cleanup。

TaskRun recovery command exact identity 包含 canonical actionKey、legacy expectedTaskKey、operationKey、taskRunId 与 nullable-pair sourceKind/sourceRef；adapter 验证 action binding，Repository 同事务 CAS persisted keys/state 且不改写 legacy task_key。safePayload/metadataPatch 是 canonical plain JSON object，UTF-8 最大 16384 bytes，禁止从审计 payload 反推业务列。

```text
Main 检查无 active hold
→ create intent prepared（expected pre/post）
→ 业务锁内校验 pre-image/CAS
→ mark intent acked
→ temp write + fsync
→ atomic rename + directory fsync
→ inspector 读取 target
→ committed: mark committed，继续 settle
→ not-committed: recovered/close failure
→ unknown: Task interrupted + hold
```

directory fsync 必须尝试；只有明确 unsupported 错误可记录 capability=`unsupported`，此时 source 保持 open 并创建 `DURABILITY_BARRIER_UNAVAILABLE` hold，不得宣称成功。Windows packaged probe 前 target-post-image 资金 action production=false；legacy ArchiveOutboxStore 行为不是 durability 证据。

不发送 Worker critical handshake。权威证据是 target durable post-image，不是 Intent。

### 11.3 existing-critical-protocol

```text
adapter/provider 枚举既有 durable state
→ RecoverySourceV1(existing-protocol)
→ InspectorRegistry 判定
→ Provider 根据判定恢复已有 settlement
```

平台 `criticalIntent=false`。证据不足时 policy `blocked`，不得包平台 Intent。

## 12. Startup Recovery

必须在可能清理/补偿证据的 Service constructor 之前：

```text
open Main control DB
→ migrate platform schema
→ freeze Policy / Inspector / Provider registries
→ load active holds，恢复 conflict gates
→ load open Critical Intents，转换 critical-intent/target-post-image sources
→ call every Provider.listOpenSources()，取得 publisher-journal/existing-protocol/module-recovery sources
→ validate RecoverySourceV1 Schema
→ dedupe by (sourceKind, sourceRef)
→ 对非 manual source 调 InspectorRegistry
→ 用一个短 runInControlTransaction 持久化 inspection observation + 即时控制迁移
→ 如需 Provider：短事务写 settlement-resumed + begin-recovery，事务外调用 Provider.recover
→ 用一个新的短 runInControlTransaction 原子收口 Task/Batch/Intent/Hold transitions/events
→ 最后初始化业务 services
```

Active manual hold 只恢复 gate 和 Renderer `recovery-required`，不进入 InspectorRegistry，直到显式人工 resolution。

同 conflict scope 串行；不同 scope 默认并发 1，可后续有界提高。

## 13. Lifecycle 映射

| inspection / settlement | TaskRun | Batch effective | Renderer | retry |
| --- | --- | --- | --- | --- |
| committed + settle 完整 | succeeded | succeeded | `succeeded`；若由恢复完成，metadata 记录 `recovered=true` 与 recoveryAttemptId | no |
| 明确 not-committed + error | failed | failed | failed | 新 Task 可重试 |
| 明确 not-committed + safe cancel | cancelled | cancelled | cancelled | 新 Task 可重试 |
| committed 但结果/settle 丢失 | interrupted | interrupted | recovery-required | no |
| partially-committed | interrupted | interrupted | recovery-required | no |
| unknown | interrupted | interrupted | recovery-required | no |
| compensated 且已验证 | recovery running → failed | failed | `failed`；metadata 记录 `compensated=true`、compensation receipt 与 recoveryAttemptId | 新 Task 由模块决定 |

Renderer 的规范状态只能来自 `platform-lifecycle-mapping.md`：

```text
running
waiting-user
cancelling
succeeded
succeeded-with-errors
failed
cancelled
recovering
recovery-required
```

恢复完成、补偿完成、已提交但结果丢失等内部语义只能作为 code/metadata，不得创建新的 Renderer status。

恢复必须：

```text
interrupted → running(recovery) → succeeded/failed/interrupted
```

## 14. Canary

Canary 只能写应用私有临时/测试 DB，不触碰业务表。至少覆盖：

1. `background-execution:pure-compute-canary`：`none/platform-none`、commit none 的纯计算协议 canary；
2. `background-execution:canary`：E02-C2 `worker-durable` 同事务 receipt 与恢复 canary；
3. critical ack 前/后崩溃；
4. COMMIT 后、`commit:receipt` 前崩溃；
5. Inspector committed/not-committed/unknown；
6. Recovery Hold gate；
7. Main-owned target-post-image；
8. provider-only publisher-journal source；
9. Service resource request/grant/adopt/release；
10. app quit protected task。

## 15. 测试文件与门禁

按仓库现有测试目录约定放置；至少覆盖：

```text
policy-registry.test.js
protocol-validator.test.js
supervisor-state-machine.test.js
service-control-resource-sequence.test.js
resource-governor.test.js
task-lifecycle-recovery.test.js
recovery-control-transaction.test.js
critical-intent-repository.test.js
recovery-hold-repository.test.js
recovery-source-schema.test.js
inspector-provider-authority.test.js
startup-recovery-coordinator.test.js
background-execution-canary.integration.test.js
```

必须包含负例：

- `manual` 作为 RecoverySource；
- critical-intent 无 intentId；
- publisher-journal 带 intentId；
- target-post-image 无 settlementKey；
- RecoverySource 带 `intent/receiptHint/safeEvidence`；
- Provider 实现或调用独立 inspect；
- existing-critical-protocol 创建平台 Intent；
- resource grant/adopt/release identity 错配；
- duplicate/late terminal；
- unknown 自动重跑；
- legacy mutation 绕过 hold。
- Repository 顶层暴露 `transitionWithRecoveryEvent()` 或 `appendObservationEvent()`；
- transaction object 内 writer 独立 COMMIT，或多对象恢复分别提交；
- observation event 修改状态、写入非 `NULL` previous/next，或用同态 transition 代替；
- `mark-recovered` 接受 `committed`；

文档基线校验：

```bash
python3 -m pip install -r changes/background-execution/validation/requirements-validation.txt
PYTHON_BIN=python3 changes/background-execution/validation/run-validation.sh
```

仓库门禁按实际 `package.json` 执行，至少包括现有 unit、integration、smoke、release-check、`git diff --check`。不要杜撰不存在的 npm script；先读取 `package.json`。

## 16. PR 切分

### PR E02-A

- Registry、Schemas runtime validator；
- Protocol、Supervisor、Adapters；
- pure compute canary；
- 不建平台 DB 表。

### PR E02-B

- ResourceGovernor、AdmissionQueue、ServiceHost handshake；
- resource sequence tests；
- existing nested topology accounting。

### PR E02-C1

- Main control DB migration：Batch overlay/recovery events；
- TaskLifecycle adapter；
- lifecycle tests；
- 不实现业务 Inspector。

### PR E02-C2

- Critical Intent/Hold repositories；
- RecoverySource validator；
- Inspector/Provider registries；
- Startup Coordinator；
- canary durable receipt/post-image/provider recovery；
- conflict gate。

每个 PR 单独通过全部已有回归；不得把四个阶段合成一个不可审查的大提交。

## 17. Codex 输出要求

每次 Codex 实施 PR 时必须输出：

- 修改文件清单；
- 关键设计决定及与本合同的对应条款；
- 数据库 migration 与 rollback 说明；
- 实际运行的测试命令和结果；
- 未运行测试及原因；
- 仍为 blocked 的 action；
- 任何与文档不一致的源码事实。

禁止仅回复“已完成”而不提供证据。
