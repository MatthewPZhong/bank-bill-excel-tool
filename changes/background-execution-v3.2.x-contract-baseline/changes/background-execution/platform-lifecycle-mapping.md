# Platform Lifecycle Mapping v1

| 项目 | 内容 |
| --- | --- |
| 文档性质 | 规范性合同（Normative） |
| 合同版本 | 1 |
| 状态 | frozen / Implementation Ready |
| 适用范围 | 所有由 Background Execution Platform 管理或适配的 action |
| 上游 | Platform Contract v1 |
| 下游 | TaskLifecycle、Batch、Renderer、Recovery Hold、模块 Inspector |

## 1. 目的

本合同规定后台执行结果如何映射为：

```text
ExecutionResult
→ commitState
→ recovery inspection
→ TaskRun status
→ Batch status
→ Renderer status
→ retry / conflict policy
```

它解决以下长期混淆：

- Worker `done` 不等于数据库已提交；
- 数据库已提交不等于正式文件已发布；
- 正式文件已发布不等于归档和 artifact settle 已完成；
- transport 被 terminate 不等于事务已回滚；
- `unknown` 不能落成普通 `failed` 或 `cancelled`；
- committed-but-result-lost 不能通过盲目重跑修复。

## 2. 三层状态

### 2.1 Execution 层

由 `BackgroundExecutionSupervisor` 持有，生命周期仅覆盖一次 `jobId` transport attempt。

终态：

```text
completed
failed
cancelled
transport-lost
```

Execution 层不得直接写 TaskRun 成功或失败。

### 2.2 Commit / Settlement 层

由 action 的 commit policy、Critical Intent Store、模块 receipt/inspector 和 Publisher journal共同判定。

`commitState` 枚举：

```text
not-applicable
not-started
not-committed
committed
partially-committed
compensated
unknown
```

说明：

- `not-applicable`：纯解析、纯计算、无业务副作用；
- `not-started`：尚未进入临界区；
- `not-committed`：通过事务回滚、无 receipt 或 inspector 明确证明未提交；
- `committed`：持久 receipt / journal / post-image 唯一证明提交；
- `partially-committed`：多阶段提交只完成一部分，例如 side DB 成功、main mirror 未完成；
- `compensated`：提交后已完成且验证补偿；
- `unknown`：证据不足或证据冲突，不能判定。

### 2.3 Business Task 层

由 TaskLifecycle、Batch、artifact settlement 和 archive handoff 共同持有。

持久 TaskRun 状态：

```text
prepared
running
succeeded
failed
cancelled
interrupted
```

`prepared` 是当前仓库已存在的真实状态：TaskRun 已创建，但尚未进入 execute。平台 Inventory、恢复扫描和测试不得遗漏。

其中：

- `interrupted` 是所有“需要恢复、提交未知、部分提交、已提交但结果/settlement 丢失”的统一持久状态；
- `recovery-required` 是 Renderer outcome，不是新的 TaskRun 数据库状态；
- `COMMIT_STATE_UNKNOWN` 是错误/结果代码，不是 TaskRun status；
- `compensated`、`invalidated` 是 outcome metadata，不替代 TaskRun status。

## 3. 标准映射表

Batch 列表示 **effective batch status**。现有基础列继续保持兼容值，`interrupted/recovering` 由本合同第 8 节定义的 overlay 计算。

| ExecutionResult | commitState / inspection | Artifact / settlement | TaskRun | Effective Batch | Renderer | Retry / conflict policy |
| --- | --- | --- | --- | --- | --- | --- |
| `completed` | `not-applicable` | 无 artifact，结果已验证 | `succeeded` | `succeeded` 或 N/A | 成功 | 不自动重跑 |
| `completed` | `committed` | 全部发布、归档、settle 完成 | `succeeded` | `succeeded` | 成功 | 禁止重复 mutation |
| `failed` | `not-started` / `not-committed` | 无正式 artifact | `failed` | `failed` | 失败 | 用户可显式新建任务 |
| `cancelled` | `not-started` / `not-committed` | 无正式 artifact | `cancelled` | `cancelled` | 已取消 | 用户可显式新建任务 |
| `transport-lost` | inspector=`committed` | settlement 可由 receipt 完整恢复 | `interrupted → running(recovery) → succeeded` | `recovering → succeeded` | 已恢复成功 | 禁止重复 mutation |
| `transport-lost` | inspector=`not-committed` | 未发生可证明的业务提交 | `interrupted → running(recovery) → failed` | `recovering → failed` | 恢复判定失败 | 同一 control transaction 原子组合 Task/Batch/Intent/event；可用新 operationKey 重试 |
| `transport-lost` | inspector=`committed` | 业务已提交，但结果/文件/归档无法自动恢复 | `interrupted` | `interrupted` | 需要恢复 | 创建 Recovery Hold；禁止冲突 mutation |
| 任意 | `partially-committed` | 未完成剩余提交 | `interrupted` | `interrupted` | 需要恢复 | 只允许专用 recovery/compensation，不重跑算法 |
| 任意 | `unknown` | 任意 | `interrupted` | `interrupted` | 需要恢复 | 创建 Recovery Hold；禁止重试和冲突 mutation |
| `failed` | `compensated` | 补偿结果已验证 | `interrupted → running(recovery) → failed` | `recovering → failed` | 已回滚/补偿 | 可在新 operationKey 下重新开始 |
| 任意 | compensation=`unknown` | 任意 | `interrupted` | `interrupted` | 需要恢复 | 保持 hold，禁止新 mutation |
| `completed` | `committed` | generation 完成、Publisher 未开始 | `running` 直到 settlement | 基础状态不提前终结 | 正在发布/结算 | 不允许 Renderer提前显示成功 |
| `completed` | `committed` | Publisher journal=`prepared/unknown` | `interrupted` | `interrupted` | 发布恢复中/需人工处理 | 以 publisher-journal source 建 hold；只运行 Publisher recovery |
| 任意 | `unknown` | Publisher journal带target-parent evidence且当前direct parent漂移/不可可靠验证 | `interrupted` | `interrupted` | 需要人工恢复 | target mutation前停止，保留journal并创建Hold；禁止重publish |
| `failed` | `not-started` | required target parent与fixed Publisher recovery root相等或双向包含 | `failed` | `failed` | 发布前拒绝 | journal/index/target写入为0；无RecoverySource/Hold，修正目标后用新operationKey |


## 4. 规范性判定顺序

调用方必须按以下顺序判定，不能跳步：

```text
1. 取得唯一 ExecutionResult
2. 读取 policy.commit.kind
3. 若有 critical intent，读取 intent state
4. 调用模块 inspector 或 Publisher recovery
5. 归一化 commitState
6. 判断 artifact / archive settlement 是否完整
7. 映射 TaskRun / Batch
8. 生成 Renderer outcome
9. 决定是否创建或释放 Recovery Hold
```

禁止：

- 根据 Worker exit code 猜测事务是否提交；
- 根据 `job:done` 直接写 TaskRun success；
- 根据 `job:error` 直接写 TaskRun failed；
- 在 inspector 返回 `unknown` 时自动重跑；
- 将 protected phase 的 terminate 映射为 `cancelled`；
- 先释放业务冲突锁，再异步决定是否创建 hold。

## 5. ExecutionResult v1

```javascript
{
  contractVersion: 1,
  actionKey: 'bank-bu:run',
  operationKey: 'stable-business-operation-id',
  jobId: 'transport-attempt-id',
  outcome: 'completed' | 'failed' | 'cancelled' | 'transport-lost',
  terminalSource: 'job:done' | 'job:error' | 'init-timeout' |
                  'execution-timeout' | 'cancel-timeout' | 'adapter-error' |
                  'spawn-error' | 'unexpected-exit' | 'protocol-error',
  result: null | {},
  error: null | {
    code: 'SAFE_CODE',
    message: 'safe message',
    stage: '...',
    detailLines: []
  },
  receiptHint: null | {
    receiptKind: 'module-local' | 'publisher-journal' | 'target-post-image' | 'existing-protocol',
    receiptIdentity: {}
  },
  metrics: {
    queuedAt: 0,
    startedAt: 0,
    endedAt: 0,
    workerCount: 1
  }
}
```

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

`job:done.payload.result` 是唯一模块结果载体。Supervisor 必须先按 `policy.result.validatorKey` 校验 body，再把同一值放入 `ExecutionResultV1.result`；其他 terminal 的 `result=null`。`ExecutionResultV1` wrapper、terminalSource、error 与 metrics 由 Supervisor 创建，模块不得另造第二套 canonical internal terminal event。

`ExecutionResult` 不允许包含：

- TaskRun 最终状态；
- “数据库已回滚”的无证据断言；
- Renderer 最终成功文本；
- 完整业务行；
- 用户任意路径。

## 6. RecoveryInspectionResult v1

`RecoveryInspectionResultV1` 与 `SettlementRecoveryResultV1` 的唯一机器权威分别是 `platform-recovery-source-v1.schema.json#/$defs/RecoveryInspectionResultV1` 与 `#/$defs/SettlementRecoveryResultV1`，本文不重复第二套字段。

要求：

- Inspector 必须是只读、可重复调用、结果稳定；
- 相同持久状态下重复调用不得产生 mutation；
- Inspector 不能清理其后还需要的证据；
- Inspector 输出 source/action/operation/task identity 必须逐项等于输入 source；canonical SHA-256 evidenceHash 与 UTF-8 byte ceiling 必须校验；
- Provider 输出相同 identity、settlementKey、inspectionEvidenceHash 与 resultHash 任一 mismatch 均 fail closed；
- `completed` 才允许原子收口，`incomplete` 保持 open/interrupted，transient/terminal failure 按合同创建或累计 hold，且不得重做业务 mutation；
- 不能唯一证明时返回 `unknown`，不得“倾向成功”或“倾向失败”。

## 7. TaskLifecycle 扩展合同

### 7.1 真实基础状态与正常转换

TaskRun 基础状态冻结为：

```text
prepared
running
succeeded
failed
cancelled
interrupted
```

正常执行邻接表（与当前 repository 能力对齐）：

```text
prepared → running | failed | cancelled | interrupted
running  → succeeded | failed | cancelled | interrupted
```

- `prepared → failed`：pre-execute 校验、FilePlan、admission 或初始化失败；
- `prepared → cancelled`：排队/等待执行期间的明确取消；
- `prepared → interrupted`：应用退出、恢复证据未决或启动前后崩溃；
- terminal 状态无出边。

`prepared` 是已创建 TaskRun、尚未进入 execute 的真实状态，Inventory、恢复扫描和测试不得遗漏。

### 7.2 恢复转换

恢复不得直接把 `interrupted` 改成终态。唯一允许路径：

```text
interrupted
→ running(recovery=true, recoveryAttemptId)
→ succeeded | failed | interrupted
```

因此平台 API 应为：

```javascript
beginRecovery({ taskRunId, recoveryAttemptId, intentId, holdId })
completeRecoverySuccess({ taskRunId, recoveryAttemptId, metadata })
completeRecoveryFailure({ taskRunId, recoveryAttemptId, metadata })
interruptRecovery({ taskRunId, recoveryAttemptId, code })
```

以上是 TaskLifecycle 语义 API，不是独立数据库 writer。其恢复相关持久化边必须转换为同一个 `RecoveryControlTransactionV1` 上的 `transitionWithRecoveryEvent()`；常规 `prepared → running` 和非恢复执行终态继续由既有 TaskLifecycle/ArchiveRepository 管理。

禁止：

```text
interrupted → succeeded
interrupted → failed
interrupted → cancelled
```

`not-committed` 必须走 `interrupted → running(recovery) → failed`。startup recovery 不得写 `cancelled`；cancelled 仅由 live execution 在进入 critical/protected 前的 normal TaskLifecycle 路径写入，RecoveryControl command union 不包含 cancelled。

### 7.3 Append-only recovery events（MUST）

每次 interruption、inspection、recovery start/finish、hold create/resolve 都必须追加不可覆盖事件。TaskRun 状态更新不能替代审计事件，纯检查/恢复活动也不能通过虚构状态迁移来换取 event。

至少记录：

```text
interrupted-recorded
inspection-completed
inspection-failed-transient
recovery-started
settlement-resumed
settlement-failed-transient
recovery-succeeded
recovery-failed
recovery-interrupted
batch-overlay-transitioned
critical-intent-transitioned
hold-created
hold-resolved
```

事件写入分为两类：

| 类型 | 写入口 | 状态要求 |
| --- | --- | --- |
| 与 TaskRun、Batch overlay、Recovery Hold、Critical Intent 迁移绑定的事件 | `RecoveryControlTransactionV1.transitionWithRecoveryEvent()` | 一个合法 transition 对应一个 event，二者同事务 |
| `inspection-completed`、`inspection-failed-transient`、`settlement-resumed`、`settlement-failed-transient` | `RecoveryControlTransactionV1.appendObservationEvent()` | 不得修改控制状态；`previous_state / next_state` 均为 `NULL`；sourceKind 不含 `manual` |

`appendObservationEvent()` 只允许上述四个 v1 observation event type。一次 inspection 决定若同时引发 Task/Batch/Intent/Hold 迁移，Main 必须在一个 `RecoveryControlRepository.runInControlTransaction()` 中先追加 observation，再用同一个 transaction object 完成全部迁移；任一写入失败时整体回滚。Inspector/Provider 调用本身不得在 SQLite transaction 内执行。Inspector transient error 写 `inspection-failed-transient`，Provider transient error 写 `settlement-failed-transient`，不得混记。

Transition event type 不由调用方传入：TaskRun command 映射到对应 `interrupted/recovery-*` event，Batch overlay command 统一映射 `batch-overlay-transitioned`，Critical Intent command 统一映射 `critical-intent-transitioned`，Hold create/resolve 映射 `hold-created/hold-resolved`。逐 command 唯一映射以 E00 TechDoc 的 `RECOVERY_TRANSITION_EVENT_MAP_V1` 为准。

每个 event 还必须持久 Repository 生成的 `request_key/writer/request_hash`。Main-owned persistent request owner 首次保存 stable eventId、createdAt、完整 RFC 8785/JCS `request_jcs` 与 lowercase SHA-256，startup/Hold 重扫按 durable requestKey 复用；20 个 branch 的 namespace + durable entity/attempt tuple 由 recovery-control fixture 冻结，volatile leaf 不进入 key，changed exact request 仍用同 key conflict。owner/event 的 requestKey/writer/eventId/requestHash/createdAt 通过 composite UNIQUE/FK 强制相等；调用方不得传 requestHash。hash 覆盖 writer-specific 完整 exact request 的每个 leaf。Repository 必须在任何 state CAS 前判定 exact replay 或 conflict，因此进程重启不改变幂等结论。

四类 observation 在 owner reserve 前必须先按 durable scope 原子持久正安全整数 `observationAttemptId`。同 scope + ordinal 跨重启复用同一 requestKey/result；下一 ordinal 才能追加新 event，瞬态阈值的最后一次也独立可审计。attempt/event 的 `(observation_scope_key, observation_attempt_id, request_key)` 必须由 composite FK 保持一致。

transition 与 observation 的 exact input/union/result shape 只由 `platform-recovery-control-v1.schema.json` 定义，未知字段或缺 required field 均 fail closed；Batch mark-interrupted 显式携带 failureCode/failureMessage。transition/observation result 分别固定 writer/event domain，transition attempt 为 null，observation attempt 为正安全整数且固定 null previous/next 与非 manual source，cross-DTO 拒绝。两个 result 是从 exact request + 同次 CAS persisted values 推导的 immutable 20-field projection，并须匹配独立 versioned 20-result KAT（JCS SHA-256 `1ced39a559f93c787da4d520e37dc0a4513c27dd9b60a4c229509e741b5ec039`）；field/owner mutations 必须实际经过 mapper→SQLite event projection 后比较，不能 candidate 自比。A 提交、B 推进、进程重启后 replay A 仍逐字段返回首次 A，不读取 B 后 current state、不二次 CAS/event。

## 8. Batch 兼容方案：Option B（冻结）

当前 Batch `task_status` 不支持 `interrupted`，且现有兼容行为把 Task `interrupted` 映射为基础 Batch `failed`。本合同不要求 SQLite 重建旧 Batch 表，正式采用 overlay 方案：

1. 现有 Batch 基础列继续写兼容值；Task interrupted 时基础值保持 `failed`；
2. 新增 `background_execution_batch_recovery_states`；
3. 所有后台执行平台查询使用 `effective batch status` view/repository；
4. 旧查询可继续看到兼容 `failed`，新 Renderer/Recovery 使用 overlay；
5. 恢复完成不覆盖原 interruption 历史，最终状态由 overlay + recovery events 计算。

首次 interruption 的基础兼容写 `task_status=failed`、overlay `state=interrupted` 与 `batch-overlay-transitioned` event 必须由 `batch-overlay.mark-interrupted` 在同一个 control transaction 完成。恢复成功时不把基础行改回 succeeded，避免旧 interruption 历史被覆盖；平台读路径只使用 effective status。

四个 Batch overlay command 必须以 exact keys 携带 canonical actionKey、legacy expectedTaskKey、operationKey、batchId、taskRunId 与 source pair。Adapter 必须注入生产 `ActionTaskBindingRegistry` 并只接受模块私有 source authority 中从真实 TaskPolicy owned snapshot 验证的 exact canonical/legacy binding；factory 禁止 caller map，只 `list()` 一次，122-key inventory JCS digest 固定 `9538102480f1a714f3839547f294fbe6fd1c19384734addd89dc0ca6e1dbb368`，caller/返回数组 mutation 均不得改变内部 membership。Action Manifest v3 仅为审计 snapshot。Repository 同事务 CAS Task/Batch identity，禁止从 legacy task_key、sourceRef 或 safePayload 猜造 event.action_key。物理映射固定 `archive_batches.id === batchId`，仅 overlay 使用 `overlay.batch_id`；完整 identity predicate 后每条写入都必须 `changes() === 1`。

规范状态：

```text
state=interrupted
state=recovering
state=resolved, finalOutcome=succeeded
state=resolved, finalOutcome=failed
```

建议 overlay 记录：

```javascript
{
  batchId,
  taskRunId,
  state: 'interrupted' | 'recovering' | 'resolved',
  finalOutcome: null | 'succeeded' | 'failed',
  recoveryAttemptId,
  sourceKind,
  sourceRef,
  updatedAt
}
```

Effective Batch status 映射冻结为：

```text
无 overlay                         → base task_status
state=interrupted                  → interrupted
state=recovering                   → recovering
state=resolved, finalOutcome=succeeded    → succeeded
state=resolved, finalOutcome=failed       → failed
```

Task interrupted 时基础 Batch `task_status` 继续写兼容值 `failed`；新平台与 Renderer 必须通过 `getEffectiveBatchStatus()` 读取 overlay，不得直接把基础 `failed` 当作已确定失败。

多文件部分成功任务：

- parent Renderer 可显示 `succeeded-with-errors`，但每个文件必须有独立 result/receipt；
- parent crash 后若无法确定全部文件结果，TaskRun 与 effective Batch 均为 `interrupted`；
- 已 committed 文件不能因 parent failure 被标成未导入；
- `noop` 必须是本 operation 的明确 receipt/outcome，不能借旧 batch 冒充新 COMMIT。


## 9. Renderer 状态合同

Renderer 可见状态：

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

映射要求：

- `waiting-user` 仍对应 TaskRun `running`；
- `recovering` 对应 TaskRun `interrupted`，启动恢复器正在工作；
- `recovery-required` 对应 TaskRun `interrupted`，无法自动完成；
- `succeeded-with-errors` 只用于业务明确支持部分成功的 action；
- 任何 `commitState=unknown` 不得显示普通 `failed`，以免用户直接重试；
- Renderer 不显示内部 `jobId`、数据库表名或敏感路径。

建议结构：

```javascript
{
  status: 'recovery-required',
  code: 'COMMIT_STATE_UNKNOWN',
  message: '任务提交状态无法自动确认，已暂停冲突操作。',
  taskRunId: 'safe-public-id',
  canRetry: false,
  canCancel: false,
  recoveryRequired: true
}
```

## 10. Retry Policy

### 10.1 允许重试

仅当满足全部条件：

- inspector 明确返回 `not-committed`；
- 无 Recovery Hold；
- 原 action 支持重新选择输入或使用新 operationKey；
- source/target evidence 重新验证；
- 用户显式发起新任务。

### 10.2 禁止重试

- `committed`；
- `partially-committed`；
- `unknown`；
- Publisher journal 尚未恢复；
- compensation 状态未知；
- 同一 operationKey 已有 active/held intent；
- 用户仅重复点击旧 UI callback。

### 10.3 operationKey 重用

同一业务操作的 transport 恢复必须重用相同 `operationKey`，但使用新的 `jobId`。

用户真正开始一个新的业务任务时，生成新的 `operationKey`。不能通过换 `jobId` 规避幂等和 hold。

## 11. Recovery Hold

创建条件：

- `commitState=unknown`；
- `partially-committed`；
- `committed` 但 settlement 不完整且无法立即恢复；
- compensation 结果未知；
- 持久证据冲突或损坏；
- Publisher journal 无法证明 committed 或 rolled back。
- Publisher journal携带的direct target parent identity在任何恢复mutation前漂移或不可可靠验证。

Hold 至少包含：

```javascript
{
  holdId,
  sourceKind: 'critical-intent' | 'publisher-journal' |
              'target-post-image' | 'existing-protocol' |
              'module-recovery' | 'manual',
  sourceRef: 'bounded-stable-reference',
  intentId: null | 'critical-intent-id',
  actionKey,
  operationKey,
  taskRunId,
  conflictScopeKey,
  reasonCode,
  createdAt,
  status: 'active' | 'resolved',
  resolution: null | 'committed' | 'not-committed' |
              'compensated' | 'manual-override'
}
```

约束：

- `sourceKind=critical-intent` 时 `intentId` 必填；
- `sourceKind=publisher-journal` 时 `intentId` 可空，`sourceRef` 必须指向 durable journal identity，而不是任意文件路径；
- `sourceKind=target-post-image` 时 `intentId` 必填并引用 Main-owned intent；`sourceRef` 必须由 `actionKey + operationKey + canonical target identity` 派生，当前文件 hash 只是 inspector 证据，不能直接充当 hold 主键；
- 同一 source identity 重复创建必须幂等；
- active hold 按 `conflictScopeKey` 阻断 managed 与 legacy mutation；
- recovery action 可运行；普通 feature flag/fallback 不得绕过。


## 11.1 Startup 恢复来源闭环

启动恢复器必须统一处理三类输入：

```text
1. open Critical Intents
2. SettlementRecoveryProvider 枚举的 open publisher journals / existing sources
3. active Recovery Holds
```

open Intent 与 Provider 枚举结果统一转换为 `RecoverySourceV1`，按 `sourceKind + sourceRef` 幂等去重。Active Hold 先恢复 conflict gate：非 `manual` hold 必须通过对应 Intent/Provider 重新取得原 source；`manual` hold 不转换为 `RecoverySourceV1`，只等待显式人工 resolution。Publisher journal 不能因为没有 Critical Intent 而漏扫；target-post-image 不能因为没有 Publisher journal 而漏扫。

## 12. App Quit 映射

| 退出时状态 | 行为 |
| --- | --- |
| queued | 取消 admission，TaskRun cancelled 或 failed，按现有用户退出语义 |
| pure compute，可安全取消 | 发 cancel，等待 ACK，未提交后可 cancelled |
| waiting-user | 使 token 失效，释放 reservation；TaskRun cancelled 或 interrupted 由 action 声明 |
| critical prepared，未 ACK | 关闭 intent，证明未提交后 failed/cancelled |
| critical acked / protected | 不声称取消；等待有限时间，超时写 interrupted 并保留 intent/hold |
| commit receipt 已存在、settlement 未完成 | 写 interrupted，启动时恢复 settlement |
| Publisher journal prepared/committed | 由 Publisher recovery 判定，不重新 generation |
| Publisher journal带`expectedTargetParentIdentity` | 先复核resolved direct parent；漂移则manual recovery/Hold，任何target mutation与重publish均为0 |
| 旧Publisher journal缺parent identity | 按既有reader/recovery兼容语义处理，不批量取消prepared，不做DB migration |
| 新required publication的target parent与fixed recovery root双向包含 | 在journal/index/target写入前按`not-started`拒绝；旧journal recovery不应用此新建门禁 |

## 13. 故障注入最低矩阵

每个 mutation action 至少验证：

1. `critical:ready` 前崩溃；
2. intent=`prepared` 后崩溃；
3. intent=`acked`、ACK 尚未送达；
4. Worker 收到 ACK、事务 BEGIN 前；
5. 事务中；
6. DB COMMIT 后、`commit:receipt` 回包前；
7. receipt 回包后、`job:done` 前；
8. `job:done` 后、TaskLifecycle settle 前；
9. Publisher prepared 后；
10. 正式目标替换后、Publisher committed 回包前；
11. direct target parent在prepare/stage/pre-commit/恢复前被rename并由ordinary directory replacement；
12. archive handoff 后、Task success 前。

每个窗口必须给出：

```text
持久事实
Inspector 结果
TaskRun/Batch 状态
Renderer 状态
是否创建 hold
是否允许重试
```

## 14. 兼容与迁移

在 E00 合并后，旧模块未适配前：

- 继续使用既有 TaskLifecycle 语义；
- adapter 必须将旧结果映射到本合同；
- 无法映射为唯一 commitState 的 action 标记 `legacy-preserved` 或 `blocked`；
- 不允许通过默认映射把所有 transport error 写为 `failed`。

本合同冻结后，所有 v3.2.x Spec/TechDoc 不再自行定义新的 Task/Recovery 状态。新增状态必须升级 Platform Contract 版本并提供兼容迁移。
