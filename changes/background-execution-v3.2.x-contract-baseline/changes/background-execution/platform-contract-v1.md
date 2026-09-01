# Background Execution Platform Contract v1

> Contract Authority v1 revision 1：独立、非生成机器权威为 `changes/background-execution/recovery-contract-authority.v1.json`；binding=`c217253cea4ccc377f030ff5119191a98e8e9c965853c9d9419fdedef9eef0ba`，TaskPolicy inventory=`9538102480f1a714f3839547f294fbe6fd1c19384734addd89dc0ca6e1dbb368`，result KAT=`1ced39a559f93c787da4d520e37dc0a4513c27dd9b60a4c229509e741b5ec039`。本 PR 是该 authority 首次引入，固定 `genesis=true`、`approvalStatus=PENDING_HUMAN_REVIEW`；repo gate 只从 merge-base 读取 previous，base 无该文件时才接受 revision 1 genesis。`genesis` 属于受控 payload；合并后完整 authority 不变可保留 genesis rev1，same-revision flip 必须失败。此 v1 authority 只承诺 `contractVersion=1` 内 revision 精确 +1；未来 v2 需独立 versioned authority 与人工 redline，不由本合同自动推导。机器技术 PASS 不改变人工红线 `PENDING_HUMAN_REVIEW`，也不表示 merge-ready 或 production enablement。

> Genesis evidence gate：即使显式传入 `--authority-mode genesis`，Git worktree 也必须先解析声明的 merge-base；只要 previous authority 已存在就稳定拒绝 `AUTHORITY_GENESIS_PREVIOUS_EXISTS`。所有 Git subprocess 清除 inherited `GIT_*` repository/object/config 控制并设置 `GIT_NO_REPLACE_OBJECTS=1`，再把 Git 返回的 toplevel、gitDir、commonDir、HEAD OID 与物理 `.git` marker/ref 逐项核对；linked worktree 允许 gitDir 与 commonDir 不同，但两者都必须 exact 记录。仅 detached/index-only 的非 Git 副本可降级运行，但报告必须标为 `detached-genesis-non-merge-evidence`、`mergeEvidence=false`，不得冒充 merge evidence。

> Validation report provenance gate：包内 published `validation-report.json` 只允许 repo/default 模式生成；`--no-write-report` 必须把所选 report target 的 complete normalized authority provenance、canonical generation command 与 exact input hashes 同本次实际 authority 解析结果逐项 exact 比较。repo、external、detached、base/merge-base、HEAD/Git physical identity 或 external resolved path/size/SHA-256 任一不同都必须 fail closed；external/detached 正向证据只能写入包外临时 report 后以相同 provenance 复验，不得复用 published repo report。

| 项目 | 内容 |
| --- | --- |
| 合同版本 | 1 |
| 文档性质 | 规范性合同（Normative） |
| 状态 | frozen / Implementation Ready |
| 适用版本 | v3.2.0～v3.2.5 |
| 适用范围 | 所有受 Background Execution Supervisor 管理或适配的 action |
| Policy Schema | `changes/background-execution/platform-contract-v1.schema.json` |
| Protocol Schema | `changes/background-execution/platform-protocol-v1.schema.json` |
| 非目标 | 不定义金额、币种、对账、去重、SQL、Workbook 业务规则 |

## 0. 规范性说明

本文使用以下关键词：

- **MUST / 必须**：实现和文档不得偏离；
- **MUST NOT / 禁止**：违反即为 P0；
- **SHOULD / 应当**：除非有书面证据和评审记录，不应偏离；
- **MAY / 可以**：允许的实现选择。

本合同是 v3.2.x 后台执行平台唯一公共合同。模块 Spec/TechDoc只能：

- 选择 action 的执行模式；
- 声明资源、取消、失败和提交策略；
- 定义模块自己的 payload、result、artifact validator、receipt 与 inspector；
- 说明业务顺序和事务边界。

模块文档禁止重新定义公共身份字段、协议消息、commit policy、Task 状态或 ResourceGovernor lease 类型。

## 1. 平台边界

### 1.1 Main Control Plane

主进程 MUST 保持以下唯一所有权：

- Renderer / preload 业务 IPC；
- 文件选择、危险确认和用户交互；
- 业务互斥锁和 mutation lock；
- FilePlan、输入/目标 snapshot；
- TaskLifecycle、Batch、父子任务和业务血缘；
- Critical Intent Store 与 Recovery Hold；
- Publisher、正式目标落位、archive handoff；
- artifact settlement；
- 用户可见最终状态。

### 1.2 Background Execution Plane

后台执行层 MAY 使用：

- 普通异步 I/O；
- 一个 Worker thread；
- 有界 Worker pool；
- Electron utility process；
- 对既有 dispatcher 的 adapter。

后台执行层 MUST NOT：

- 弹出对话框；
- 自行创建 TaskRun；
- 绕过业务锁；
- 直接将中间 staging 宣布为成功；
- 直接写用户最终目标，除非该 action 的现有正式 Publisher 已被明确登记为 `existing-critical-protocol`；
- 在提交状态未知时自动重跑；
- 把模块业务逻辑塞入 Supervisor、Registry 或 ResourceGovernor。

## 2. 规范身份模型

### 2.1 `actionKey`

静态业务 action 注册身份。

```text
vcc-op:scan-and-compute
vcc-op:save-run
bank-bu:run
statement:generate-current
```

要求：

- 源码静态定义；
- 在一个发布版本中唯一；
- 是 Registry、Inventory、coverage 和 feature flag 的主键；
- 不包含 taskRunId、月份、路径或随机值。

### 2.2 `operation`

协议消息命令/事件名称。

```text
job:start
unit:done
critical:ready
commit:receipt
```

`operation` 不是业务 action 身份。

### 2.3 `operationKey`

一次业务操作的持久幂等和恢复身份。

要求：

- 由 Main Control Plane 生成或确认；
- 跨 Worker/process crash 和 transport retry 稳定；
- 可用于查询 module receipt、Critical Intent 和 Recovery Hold；
- 同一个真实业务操作的 recovery attempt MUST 复用；
- 用户开始真正的新任务时 MUST 使用新值；
- 不能使用随机 `jobId` 代替。

建议构成：

```text
<taskRunId>/<actionKey>/<stable-operation-sequence-or-uuid>
```

模块 MAY 在 receipt 中同时记录月份、datasetId、fileIndex 等业务定位，但这些字段不能单独替代 `operationKey`。

### 2.4 `jobId`

一次 transport attempt 身份。

- 每次 spawn/call 新建；
- crash 后 recovery attempt 使用新 jobId；
- 仅用于消息路由、metrics 和 late-event 丢弃；
- 不能作为业务幂等键或 receipt 唯一键。

### 2.5 `unitId`

parent job 内的工作单元身份。

```text
file:000003
subject:02
output:05
```

要求：

- parent job 内唯一；
- 自动 retry 默认禁止；
- 完成顺序不能替代业务归约顺序；
- `unit:done` 不是 parent job 的终态。

### 2.6 `workerInstanceId` 与 `serviceGeneration`

- `workerInstanceId` 标识当前 Worker/process 实例；重建后变化；
- `serviceGeneration` 标识长驻 Service 代次；crash/restart 后递增；
- 旧 generation 的 event、token、revision 和结果 MUST fail closed。

## 3. Action Inventory 与 Policy Registry

### 3.1 Inventory disposition

每个 action MUST 登记为：

```text
managed
legacy-preserved
inline-excluded
blocked
```

- `managed`：由平台策略直接管理；
- `legacy-preserved`：保留现有执行器，但有 adapter/owner/review version；
- `inline-excluded`：有证据证明是轻量同步/异步 action，不需后台管理；
- `blocked`：存在明确 P0，禁止生产启用目标策略。

### 3.2 正式执行模式

`mode` 只能是：

```text
inline-async
thread-single
thread-pool
utility-process
```

`existing-transport` 禁止作为第五种 mode。

既有执行器通过：

```javascript
adapterKind: 'existing-dispatch'
```

表达。例如：

```javascript
{
  actionKey: 'pending:import',
  mode: 'thread-pool',
  adapterKind: 'existing-dispatch',
  adapterKey: 'big-table-engine'
}
```

### 3.3 Lifetime

```text
job
service
```

- `job`：一次 action 一次执行器或 existing dispatcher attempt；
- `service`：长驻 Worker 持有会话或缓存；必须声明 generation、busy、close、base lease 和 persistent state policy。

### 3.4 Commit policy

只允许：

```text
none
main-settlement
worker-durable
existing-critical-protocol
```

#### `none`

纯解析/计算，无业务持久副作用。

#### `main-settlement`

Worker 只产出 compact result 或 validated staging，Main 完成 DB writer、Publisher、原子文件替换、archive 或 artifact settle。`main-settlement` 按权威恢复来源进一步分为两类，二者不得混用：

- `receiptKind=publisher-journal`：用于正式 artifact 发布。`criticalIntent=false`；Publisher 自己的 durable journal 是恢复入口，`settlementKey` 必须解析到可枚举 open journal 的 `SettlementRecoveryProvider`；
- `receiptKind=target-post-image`：用于 Main 控制的单文件 durable mutation，例如 Statement balance seed。`criticalIntent=true`；Main 必须在 mutation 前创建 **Main-owned Critical Intent**，保存 bounded pre/post evidence，但不发送 Worker `critical:ready / critical:ack`；
- 两类 action 都必须登记 inspector、conflict scope resolver 与 settlement key；
- Publisher journal 在进程于“journal prepared 后、Hold 创建前”崩溃时，由启动恢复器直接枚举 journal，不依赖 Critical Intent；
- target post-image 在进程于“rename/fsync 后、回读或 Task settle 前”崩溃时，由 open Main-owned intent 驱动目标文件 inspector；
- Critical Intent 只保存预期证据与允许 Main 进入原子替换的事实，权威提交证明仍是 durable publisher journal 或目标文件 post-image。

#### `worker-durable`

Worker/utility process 在业务事务中完成 mutation；MUST 同事务形成唯一 module receipt，并通过平台 critical handshake。

#### `existing-critical-protocol`

适配已有成熟 grant/journal/commit 协议，例如 Position 或已有 durable Publisher。Adapter 必须把现有状态映射到公共合同，不重写原事务。该 policy **不创建平台 Critical Intent**；其 `criticalIntent` 固定为 `false`，权威提交证据只能来自已经审计的既有协议。若既有证据不足以唯一判定 `committed / not-committed / partially-committed / unknown`，该 action MUST 保持 `blocked`，不得临时改用平台 Intent 包裹旧协议。

#### Receipt kind

`receiptKind` 只能从以下集合选择，并必须与 `commit.kind` 匹配：

```text
module-local
publisher-journal
target-post-image
existing-protocol
```

- `module-local`：与业务 mutation 位于同一数据库事务的模块 receipt；
- `publisher-journal`：正式发布器的 durable journal/receipt；
- `target-post-image`：Main 控制的单文件原子替换，以目标文件 durable post-image（size/hash/必要的业务证据）为权威提交证明；
- target-post-image 在 temp/file fsync + atomic rename 后必须尝试 directory fsync；仅明确 unsupported 错误可记录 capability=`unsupported`，但 intent/source 必须保持 open，并以 `unknown`/`terminal-failure` 创建 `DURABILITY_BARRIER_UNAVAILABLE` hold。Windows packaged probe 证明 durable primitive 前，资金 action 保持 production disabled；legacy ArchiveOutboxStore 静默吞错不构成 durability 证据；
- `existing-protocol`：成熟执行器已有且已审计的 grant/journal/commit 证据。

`main-settlement` 必须使用 `publisher-journal` 或 `target-post-image`；`worker-durable` 必须使用 `module-local`；`existing-critical-protocol` 必须使用 `existing-protocol`。Critical Intent 只记录预期证据和允许进入临界区的事实，不能替代上述 receipt。

#### Settlement recovery source v1

`RecoverySourceV1` 的唯一机器可读定义是 [`platform-recovery-source-v1.schema.json`](platform-recovery-source-v1.schema.json)。TypeScript 类型 MUST 由该 Schema 生成或逐字段等价实现；任何文档、模块或 adapter 不得再定义第二套字段。规范字段为：

```typescript
type RecoverySourceV1 = {
  contractVersion: 1;
  sourceKind: 'critical-intent' | 'publisher-journal' |
              'target-post-image' | 'existing-protocol' |
              'module-recovery';
  sourceRef: string;
  actionKey: string;
  operationKey: string;
  taskRunId: string;
  conflictScopeKey: string;
  inspectorKey: string;
  settlementKey: string | null;
  intentId: string | null;
  evidenceVersion: number;
  boundedEvidence: object;
};
```

禁止字段：`intent`、`receiptHint`、`safeEvidence`。Inspector 如需读取完整 Intent，必须通过 `intentId` 调用只读 `RecoveryControlReadRepository`，不能把可变 repository object 嵌入 DTO。

来源规则与 Intent 映射唯一冻结为：

| commit / recovery class | `sourceKind` | `intentId` | `settlementKey` | 枚举者 |
| --- | --- | --- | --- | --- |
| `worker-durable` | `critical-intent` | 必填 | 可空 | `RecoveryControlReadRepository.listOpenCriticalIntents()` |
| `main-settlement + publisher-journal` | `publisher-journal` | 必须为空 | 必填 | `SettlementRecoveryProvider.listOpenSources()` |
| `main-settlement + target-post-image` | `target-post-image` | 必填 | 必填 | `RecoveryControlReadRepository.listOpenCriticalIntents()` |
| `existing-critical-protocol` | `existing-protocol` | 必须为空 | 必填 | 既有协议的 `SettlementRecoveryProvider.listOpenSources()` |
| 模块启动恢复、且不属于上述 commit policy | `module-recovery` | 必须为空 | 必填 | 模块恢复 Provider |

`manual` **不是** `RecoverySourceV1.sourceKind`。它只属于 `RecoveryHoldSourceKindV1`，表示需要人工处理且没有可自动检查的恢复源。

`SettlementRecoveryProvider` 只负责枚举 open source 和在 Inspector 已给出结论后恢复 settlement；Provider MUST NOT 实现第二套 `inspect()`。所有判定统一走 `inspectorKey → InspectorRegistry`。`recover(source, inspection)` 必须按 `(sourceKind, sourceRef, operationKey)` 幂等，inspection evidence hash 只是 CAS/审计输入而不是新的 mutation identity；重复调用返回同一 settlement 结果，不得重新执行 generation、重复 publish 或业务 mutation。

`RecoveryInspectionResultV1` 与 `SettlementRecoveryResultV1` exact keys 只由 `platform-recovery-source-v1.schema.json` 的 `$defs` 定义。Inspector/Provider 输出 identity、canonical SHA-256 hash 或 byte ceiling mismatch 必须 fail closed；只有 settlement `completed` 可原子收口，`incomplete` 保持 open/interrupted，transient/terminal failure 进入 bounded failure/hold 路径且不得重做业务 mutation。InspectorRegistry 与 SettlementRecoveryProviderRegistry 均在 Main DB init 后完成静态注册并 `freeze()`，freeze 后拒绝 register；open intent/provider source/active hold 扫描结束后，才允许任何 owner initialize/recovery/cleanup。

所有 v1 canonical JSON 正式冻结为 **RFC 8785 JSON Canonicalization Scheme（JCS）**，算法标识 `RFC8785-JCS`。object key 按 UTF-16 code unit 排序（因此 U+10000 在 U+E000 前），number 与 string 使用 ECMAScript 序列化（`1.0 → 1`、`-0 → 0`，指数与 escaping 服从 JCS），UTF-8 bytes 不做 Unicode normalization。runtime 只接受 dense array 与 Object/null-prototype plain object；invalid surrogate、non-finite、sparse/extra-key array、accessor、toJSON、Proxy、cycle、undefined/function/bigint/symbol/non-enumerable/non-plain object 全部 fail closed。raw 入口必须在 `JSON.parse` 前以 duplicate-aware parser 拒绝任意深度 duplicate key；任意嵌套整数必须在 ±(2^53-1) 内，`2^53` 与 `2^53+1` 都在转换前拒绝。SHA 算法固定 lowercase `[0-9a-f]{64}` SHA-256，禁止 SHA-1、Python `sort_keys` 或普通递归排序替代；共享 KAT 与 Node 参考入口见 `validation/fixtures/valid/canonical-json-jcs-v1.json`、`validation/canonicalize-jcs.js`。

TaskRun recovery command exact identity 同时携带 canonical actionKey、persisted legacy expectedTaskKey、operationKey、taskRunId 与 nullable-pair sourceKind/sourceRef。Adapter 验证冻结 action binding；Repository 同事务 CAS legacy task_key、operation_key 与状态，旧 task_key 不改写，event 写 canonical actionKey。BoundedSafePayloadV1/metadataPatch 是 canonical plain JSON object，UTF-8 最大 16384 bytes，不得由 safePayload 反向推导业务列。

public digest/count/version 的单一机器权威是独立、非生成的 `recovery-contract-authority.v1.json`；生产 `src/main-process/background-execution/action-task-binding-registry.js` 内不可注入/替换的模块私有 binding 常量仍是 runtime pair 内容来源，必须逐值服从该 anchor。`bindingSnapshot()` 只返回新的 deep-frozen 审计 copy。v1 受控 value（含 genesis）变化必须相对 external/merge-base previous 精确提升 revision +1；完整 authority 不变则保留 revision/genesis，`contractVersion` 固定为 1。Main 对真实 production module 的唯一 exact CommonJS `require` 必须是除 directive 外第一个 Program.body statement，禁止任何前置可执行 statement/side effect/helper wrapper，且 imported identifier 禁止 shadow/reassign/local fake。CI 必须从 byte 0 编译并执行到该 import 结束的完整 Main 源码前缀，fresh-load exact resolved target，证明唯一 loader request 与真实 export identity。随后把真实 TaskPolicyRegistry 包成 frozen exact plain `{ list }` host，并在 Program.body 直接调用 `initializeActionTaskBindingStartup(taskPolicyBindingHost, frozenContinuations)`、保留同一 registry。initializer declaration/call 不得进入 conditional/try/function/early-return；唯一 awaited `run()` 必须在真实 `app.whenReady()` success callback 的 rethrowing try block 中直接出现，禁止额外 conditional/loop/nested function/吞错 try 或前置 early return，严格执行 DB→IPC 后才建窗。binding freeze 早于任何 `new AppDatabase`/IPC invocation，binding 抛错时后两者调用数必须为 0。initializer 拒绝 Map、非 frozen、替换 prototype 或 extra API；catch/wrap 不读取 hostile `message` accessor，不透传不可信 cause，只返回稳定 `ActionTaskBindingRegistryError.code/message`。`assertPair` 在 type check 前不得读取、插值或 coercion 非 string hostile identity。factory 只调用一次 host `list()`，descriptor-safe 拒绝 Proxy/accessor/non-enumerable/symbol/sparse/extra data 与非 plain/exact policy shape，并复制为 registry-owned snapshot/private membership Sets；caller 后改原 object/array 无效，`allowedTaskKeys()` 不得返回内部数组。Action Manifest v3 的 `allowedLegacyTaskKeysByActionKeySnapshot` 只作审计，不授权新 pair。source map 的 RFC 8785/JCS digest 固定为 `c217253cea4ccc377f030ff5119191a98e8e9c965853c9d9419fdedef9eef0ba`，sorted 122-key TaskPolicy inventory digest 固定为 `9538102480f1a714f3839547f294fbe6fd1c19384734addd89dc0ca6e1dbb368`，并由 60 条独立 spec/call-site/TaskPolicy provenance 反证，不得用 forward snapshot 自生 reverse evidence。硬计数固定 52 actions、122 TaskPolicy、60 pairs、52 bound keys、70 unbound keys；hidden/getter/Proxy、equal-size substitution、duplicate、taskKey/channel mismatch、missing action、empty binding、missing/mismatch task key 均须在真实 Node API/adapter 进入 Repository 前 fail closed；全部 one-to-many 只接受 source 显式列出的每个 pair，禁止凭名称推断 legacy key。

Batch overlay command exact identity 同时携带 canonical actionKey、persisted legacy expectedTaskKey、operationKey、batchId、taskRunId 与 source pair；`mark-interrupted` 还必须显式携带 bounded `failureCode/failureMessage`，不得从 safePayload 猜测。Adapter 验证冻结 action binding；Repository 同事务 CAS Task/Batch 的 legacy task_key、operation_key 与关联 identity，event.action_key 只取 command 中经验证的 canonical actionKey，不得从 legacy key、sourceRef 或 safePayload 猜造。

每个 recovery event 必须持久 `request_key/writer/request_hash`。Main 的持久 request owner 首次生成并保存 eventId、createdAt、完整 request_jcs 与 hash；重启、startup scan 和 Hold 重扫必须按 durable requestKey 复用，不得重建时间或身份。20 个 branch 的 requestKey namespace/identity tuple 以 recovery-control valid fixture 的 `requestKeyContract` 为唯一机器权威：`recovery-control:v1:` + SHA-256(`JCS([namespace, ...identityValues])`)；tuple 含 writer/command 或 eventType discriminator 及 durable entity/attempt identity，并排除 eventId/createdAt/safePayload 等 volatile leaf，使 changed request 用同 key 命中 conflict。Hold create-or-get 的 durable identity 精确为 Hold 表 UNIQUE `(sourceKind, sourceRef)`，不含尚未持久的 holdId。owner/event 通过 `(request_key, writer, event_id, request_hash, created_at)` composite UNIQUE/FK 保证五项相等。Repository 对区分两个 writer 的完整 exact request envelope 计算 RFC 8785/JCS lowercase SHA-256；公共输入不接受 caller requestHash；Repository 在任何 state CAS 前返回 exact replay 或拒绝 conflict，跨进程重启不得退化为内存判定。

四类 observation 在 request owner reserve 前，必须以 durable scope 在短 `BEGIN IMMEDIATE` transaction 中原子分配并持久正安全整数 `observationAttemptId`。同 scope + ordinal 的 prepared/committed row 跨重启复用相同 requestKey 与 immutable result；只有明确分配下一 ordinal 才可追加下一 event，瞬态阈值最后一次也独立可审计。attempt/event 必须以 `(observation_scope_key, observation_attempt_id, request_key)` composite FK 强制相等。

`platform-recovery-control-v1.schema.json` 是两个 writer request、每个 Task/Batch/CriticalIntent/Hold discriminated branch、event input 与 `RecoveryControlTransitionResultV1`/`RecoveryObservationEventResultV1` 的唯一 exact runtime shape 权威，所有 object 都必须 unknown-key fail closed。transition result 的 writer 固定 `transitionWithRecoveryEvent`、transition event 与 null `observationAttemptId`；observation result 的 writer 固定 `appendObservationEvent`、正安全整数 attempt、四种 observation event、非 manual source 与 null previous/next，两个 DTO 交叉输入必须拒绝。两个 result 严格等于 machine mapping 从 exact request + 同次 CAS persisted values 推导的 immutable 20-field event projection；独立 versioned 20-result KAT 的 `JCS(resultProjectionKnownAnswers)` SHA-256 固定为 `1ced39a559f93c787da4d520e37dc0a4513c27dd9b60a4c229509e741b5ec039`。mapper、request/CAS/source mutants 必须经真实 owner/attempt/event SQLite DDL 与 immutable SELECT 后逐字段对该 KAT，不能以 mapper candidate 自比。A 提交、B 推进、重启后 replay A 必须逐字段返回首次 projection A，不得重建 current state、添加 replay flag、二次 CAS 或追加 event。

物理 Batch identity 固定 `archive_batches.id === batchId`；`overlay.batch_id` 只属于 overlay 并引用该 id。Task/Batch identity join 与 CAS 必须完整匹配 taskRunId、expectedTaskKey、operationKey、expected state/recoveryAttempt，Task、Batch、overlay、event、owner 每个写 statement 都要求 `changes() === 1`，否则 outer control transaction 整体 rollback。完整冻结 SQL 见 E00 TechDoc §9.2.1。

旧命名全部废弃：

```text
main-controlled         → main-settlement
worker-persistent       → worker-durable
existing-protocol       → existing-critical-protocol
```

## 4. Protocol v1

Protocol v1 明确区分 **Job Envelope** 与 **Service Control Envelope**。两者共享 `protocolVersion=1`，但身份、允许为空的字段和终态作用完全不同。实现不得把 Service 生命周期或资源申请伪装成无业务含义的 job。

### 4.1 Job Envelope v1

```javascript
{
  protocolVersion: 1,
  channel: 'job',
  direction: 'command' | 'event',
  operation: 'job:start',
  actionKey: 'vcc-op:scan-and-compute',
  operationKey: 'stable-business-operation-id',
  jobId: 'transport-attempt-id',
  workerInstanceId: 'worker-instance-id',
  serviceGeneration: null,
  unitId: null,
  seq: 1,
  context: {
    kind: 'operation',
    value: {
      taskRunId: 'task-run-id',
      taskKey: 'task-key',
      moduleId: 'vcc-op',
      parentRunId: 'parent-run-id',
      operationKey: 'stable-business-operation-id'
    }
  },
  payload: { input: {} }
}
```

Job Envelope 的 `actionKey / operationKey / jobId` 均为必填非空值：

- `actionKey`：静态 Registry 身份；
- `operationKey`：跨 transport、跨重启的业务幂等与恢复身份；
- `jobId`：本次 transport attempt；
- `unitId`：仅在 pool unit 消息中必填；
- `serviceGeneration`：one-shot job 为 `null`，Service command 必须为正整数。

### 4.2 Job operations

Main → Executor：

```text
job:start
unit:start
job:cancel
unit:cancel
critical:ack
critical:reject
```

Executor → Main：

```text
job:progress
unit:progress
unit:done
unit:error
critical:ready
commit:receipt
job:done
job:error
cancel:ack
```

规则：

- `unit:done / unit:error` 只终结一个 unit；
- `job:done / job:error` 只形成 ExecutionResult 候选；
- `commit:receipt` 只是提交证据通知，不是 execution 或 Task 终态；
- `job:done` 不得直接写 TaskLifecycle success；
- 协议错误、late event、重复终态不得触发 fallback 或第二次 settle。

Public wire payload 只冻结精确外层 wrapper；每个 wrapper 均 `additionalProperties=false`，Supervisor 不得猜测模块字段：

| operation | 唯一 payload 外层字段 | body validator/所有权 |
| --- | --- | --- |
| `job:start / unit:start` | `input` | `entryKey` 对应输入 validator |
| `job:progress / unit:progress` | `progress` | 平台 bounded/progress validator，并受 rate limit |
| `job:done / unit:done` | `result` | `policy.result.validatorKey`；Supervisor 验证后放入唯一 `ExecutionResultV1.result` |
| `job:error / unit:error` | `error` | 平台 `SafeErrorV1` 与 `result.maxErrorItems` |
| `critical:ready / critical:ack / critical:reject` | `critical` | Critical Intent coordinator |
| `commit:receipt` | `receipt` | `commit.receiptKind` 对应 receipt validator/Inspector |
| `job:cancel / unit:cancel` | `cancel` | Supervisor cancellation policy |
| `cancel:ack` | `cancellation` | Supervisor cancellation tracker |

`job:done` 前，所有已登记 unit 必须处于 policy 允许的终态，且不得存在 unknown unit；否则 Supervisor 产生 `protocol-error`，不得 settle。`job:error` 可早停，Supervisor 在内部把剩余 running unit 清理为 cancelled 并停止接受该 job 的后续消息，不扩展公共 API。

### 4.3 Service Control Envelope v1

长驻 Service 在尚无业务 Task 时仍需要初始化、关闭和资源协调，因此使用独立 envelope：

```javascript
{
  protocolVersion: 1,
  channel: 'service-control',
  direction: 'command' | 'event',
  operation: 'resource:request',
  serviceKey: 'statement-service',
  controlId: 'control-exchange-id',
  workerInstanceId: 'worker-instance-id',
  serviceGeneration: 3,
  seq: 8,
  jobRef: null | {
    actionKey: 'statement:import',
    operationKey: 'stable-business-operation-id',
    jobId: 'transport-attempt-id',
    unitId: null
  },
  payload: {}
}
```

Service Control Envelope 顶层 **不得**出现 `actionKey / operationKey / jobId`。需要关联业务 job 时，只能使用经过严格校验的 `jobRef`。

### 4.4 Service control operations

Main → Executor：

```text
executor:init
executor:close
resource:grant
resource:reject
resource:adopt-ack
resource:revoke
resource:release-ack
```

Executor → Main：

```text
executor:ready
executor:error
executor:close-ack
resource:request
resource:adopted
resource:release
```

这些 operation 只管理 Service 与资源，不产生 job terminal，也不写 TaskLifecycle。

### 4.5 Service identity 与允许为空条件

- `serviceKey` 是静态 Registry 身份；
- `controlId` 标识一次 control exchange，由发送请求的一侧生成；
- `workerInstanceId / serviceGeneration` 始终必填；
- `executor:init / executor:ready / executor:close / executor:close-ack / executor:error` 的 `jobRef` 必须为 `null`；
- `resource:request` 若用于 state adoption、interaction token 或 active phase 扩容，`jobRef` 必须完整；
- idle cleanup 的 `resource:release` 可以使用 `jobRef=null`；
- Service 重建后旧 generation 的 control/job 消息一律视为 stale；
- control envelope 不能借 `jobRef=null` 绕过 action policy、资源上限或隐私限制。

### 4.6 Resource request / grant / adoption

全局 `ResourceGovernor` 只存在于主进程。Worker **MUST NOT** import、持有或直接调用 Governor JS 实例。

Worker 计算出候选 state/token footprint 后发送：

```javascript
{
  operation: 'resource:request',
  payload: {
    requestId: 'request-id',
    requestKind: 'persistent-state-replace' |
                 'pending-interaction-create' |
                 'phase-extension',
    requested: {
      memoryBytes: 104857600,
      cpuSlots: 0,
      ioHeavySlots: 0
    },
    replacesReservationId: null,
    owner: {
      kind: 'service-state' | 'interaction-token' | 'phase',
      ownerKeyHash: 'bounded-stable-digest',
      candidateRevision: 12
    }
  }
}
```

Main 通过 ServiceHost 调用 Governor，并返回：

```javascript
{
  operation: 'resource:grant',
  payload: {
    requestId: 'request-id',
    grantId: 'grant-id',
    reservationId: 'reservation-id',
    replacesReservationId: null,
    granted: { memoryBytes: 104857600, cpuSlots: 0, ioHeavySlots: 0 },
    adoptionDeadlineMs: 5000
  }
}
```

原子采用时序：

```text
Worker 构造候选但不公开
→ resource:request
→ Main 持有 tentative grant
→ resource:grant
→ Worker 原子采用 state/token，并保存 reservationId/grantId
→ resource:adopted
→ Main 校验 owner/revision 后 resource:adopt-ack
→ Worker 才能向 Renderer 返回 token 或向调用方公布新 revision
```

约束：

- `resource:reject` 或 adoption 超时：候选不得公开，旧 reservation 保持不变；
- replacement 只有在 `resource:adopted` 校验成功后才释放旧 reservation；
- `resource:adopt-ack` 前不得发送包含新 token 的 `job:done`；
- `resource:release` / `resource:release-ack` 必须 exactly-once；
- grant、reservation、token/state 必须通过 identity 关联，不能仅凭字节数猜测；
- BaseLease 在 Main spawn Service 前获取，不由 Worker 反向申请。

`requestKind / owner.kind / replacesReservationId` 是封闭矩阵：

- `persistent-state-replace` 仅允许 `service-state`；同一 owner 首次请求允许 `null`，已有 adopted reservation 后必须精确引用当前 reservation；
- `pending-interaction-create` 仅允许 `interaction-token`；首次请求的 replaces 必须为 `null`，替换已发布 token 时必须使用同 owner、递增 revision，并精确引用当前 adopted reservation；
- `phase-extension` 仅允许 `phase`，且 replaces 必须为 `null`；
- pending-interaction replacement 的旧 token 必须仍为 published；candidate 在 adopt-ack 前不得公开，reject、revoke、adoption timeout 或 stale current 均保留旧 token；
- stale、非当前、跨 owner 或跨 purpose 的 replacement 一律 protocol-error。

Worker dynamic resourceVector 只含 memoryBytes/cpuSlots/ioHeavySlots；Main 扩展为五维时固定 workerThreadSlots=0、utilityProcessSlots=0，OS 载体已由 spawn 前 BaseLease 计入。

### 4.7 `seq`

Job Envelope 的追踪范围：

```text
(jobId, workerInstanceId, direction)
```

Service Control Envelope 的追踪范围：

```text
(serviceKey, serviceGeneration, workerInstanceId, direction)
```

每个范围首条 `seq=1`，之后严格等于 `last + 1`。gap、重复、回退或旧 generation 消息均视为协议错误或 stale event。

Service reply 的 `seq` 属于发送方自身 direction 的独立 tracker，必须取该 direction 的 `last + 1`；不得复制或要求等于对向 request/event 的 `seq`。exchange 仅用 `controlId/requestId/grantId/reservationId` 关联。

### 4.8 Context

- `operation` context MUST 使用现有 exact-5 validator；
- `file-batch` context MUST 使用现有 exact-7 validator；
- `none` 仅限 `background-execution:pure-compute-canary`/内部 maintenance；durable `background-execution:canary` 继续使用 operation/exact-5；
- exact-5 必须且只能包含 `taskRunId/taskKey/moduleId/parentRunId/operationKey`；
- exact-7 在 exact-5 基础上必须且只能增加 `batchId/batchNumber`；
- `context.value.operationKey` 必须与 envelope `operationKey` 完全相等；
- `jobId`、`unitId`、grant、reservation、critical intent 或任何额外字段不得夹带进 context；
- `none.value` 必须是空对象；
- Service Control Envelope 不携带业务 context，业务关联只使用 `jobRef`。

### 4.9 Payload 与隐私

每个 policy MUST 声明 `protocolLimits.commandMaxBytes/eventMaxBytes`。v1 统一冻结为每个完整 UTF-8 compact JSON envelope `262144` bytes；业务精调只能在 action migration 评审后进入新合同。错误条目继续使用 `result.maxErrorItems`，artifact 数量继续使用 `artifacts.maxArtifacts`，progress 继续使用 `metrics.progressRateLimitPerSecond`。

禁止：

- 百万行对象；
- 完整 Workbook；
- DatabaseSync/service/function/Electron 对象；
- 通用日志中的完整账号、订单号、ReconID、金额明细、原始行和用户目录。

大型数据 MUST 使用任务 staging、临时 SQLite、spool 或临时工作簿传递。

## 5. Supervisor Contract

Supervisor 负责：

- policy snapshot；
- admission；
- transport lifecycle；
- protocol validation；
- job/unit route；
- cancel/timeout/exit；
- exactly-once execution result；
- metrics；
- lease release。

Supervisor 不负责：

- 业务事务；
- 模块排序和 reducer；
- TaskLifecycle 最终状态；
- Publisher；
- module receipt 的业务判定；
- 自动重试。

状态：

```text
created
queued
spawning
running
waiting-critical
protected
cancelling
settled
```

`protected` 仅表示 Main 已允许执行器进入不可强制取消的临界区，不表示已经 committed。

## 6. ResourceGovernor v1

### 6.1 所有权

`ResourceGovernor` 是 **Main-only** 单例。Worker、utility process 和业务 Service 不得直接调用 Governor 方法；它们只能：

- 在 job 开始前由 Supervisor/ServiceHost 申请 lease；
- 通过 Protocol v1 Service Control Envelope 发出受 policy 限制的 `resource:request`；
- 引用 Main 返回的 `grantId / reservationId` 完成采用或释放。

### 6.2 资源维度

```text
cpuSlots
workerThreadSlots
utilityProcessSlots
ioHeavySlots
memoryBytes
```

`CPU-2` 是全应用预算，不是每个模块各自额度。已有 nested pool 和 utility process 也必须计入。

### 6.3 Lease 类型

#### BaseLease

长驻 Service 或 existing pool 的基础 Worker/process 与 baseline RSS；Main 在 executor spawn 前获取。

#### PersistentReservation

已采用的 Service session/result 长期内存。Worker 通过 `persistent-state-replace` 请求替换，但真正 reservation 由 Main 持有。

#### PendingInteractionReservation

Statement 等 waiting-user token 私有 context。token 返回 Renderer 前必须完成 `grant → adopted → adopt-ack`。

#### PhaseLease

当前 read/parse/compute/write/generate 阶段的 CPU、I/O 和临时内存。通常由 Main 在 job admission 时申请；仅允许 policy 明确声明的 `phase-extension` 动态请求。

#### CompoundLease

包含多个子 Worker 或 existing nested pool 的 parent action完整拓扑预算。

### 6.4 Tentative grant 与原子替换

平台 MUST 实现：

```text
requestReplacement(oldReservationId, requestedVector)
→ tentative grant
→ Worker adopts candidate
→ Main validates resource:adopted
→ atomic switch old → new
```

禁止：

```text
先释放旧 reservation
→ 再申请新 reservation
```

若 grant 被拒绝、Service crash 或 adoption 超时：

- tentative grant 自动回收；
- 旧 reservation 保持有效；
- 新 state/token 不得公开；
- linked job 按模块既有语义失败或保留旧状态。

### 6.5 Service request policy

每个 `lifetime=service` policy MUST 静态声明：

- `serviceKey`；
- 允许的 requestKind；
- 单 Service 最大 pending requests；
- grant/adoption timeout；
- state footprint estimator；
- token maxOutstanding/TTL；
- crash/close release policy。

ServiceHost MUST 拒绝 Worker 请求超过 policy 的资源、未知 requestKind、错误 jobRef、旧 generation 或重复 owner identity。

### 6.6 Existing nested executors

成熟池必须声明：

- 内部最大 Worker/process 数；
- 基础和峰值内存；
- I/O 级别；
- 是否动态创建子 Worker；
- 何时释放。

Adapter 不得额外包一层 Worker。Governor 必须以 compound lease 计入内部拓扑。

`resources.base` 是唯一 root executor 预算，compound 不得再声明或重复 root，`childResource` 必填。active compound = resources.base + resources.phase + childResource * effectiveChildCount；childrenMax/effectiveChildCount 只计 children，不含 root。其他 persistent/pending reservation 按实际存活期另计，已经包含在 active compound 的维度不得双算。

### 6.7 Admission 与降级

- 同优先级 FIFO，支持 aging；
- queued job 可取消；
- 低内存或槽位不足时排队或在 job start 前降级；
- 运行中不动态切换策略；
- 完整 Governor 尚未上线前，所有新增 `thread-pool` 生产策略固定 `effectiveWorkerCount=1`；
- 降级原因必须可观测；
- lease、tentative grant、adoption timeout 和 release 均必须有泄漏测试。

## 7. Critical Intent 与 Commit Recovery

### 7.1 适用范围

Critical Intent 的使用只由规范 commit policy 决定，不得按“看起来复杂”临时增加：

| commit policy | `criticalIntent` | coordination | 不足时的处置 |
| --- | --- | --- | --- |
| `worker-durable` | `true` | 平台 `critical:ready / critical:ack` | 缺 module-local receipt 或 inspector 时 `blocked` |
| `main-settlement + target-post-image` | `true` | Main-owned intent；不发送 Worker critical handshake | 缺 pre/post inspector 时 `blocked` |
| `main-settlement + publisher-journal` | `false` | durable Publisher journal | journal/provider 不足时 `blocked` |
| `existing-critical-protocol` | `false` | 既有 grant/journal/commit 证据 | 证据不足时保持 `blocked`，不得临时创建平台 Intent |
| `none` | `false` | 无持久提交 | 不适用 |

具有 side/main mirror 或多阶段提交的新 action，若由平台协调，应建模为 `worker-durable` 并形成同事务 module receipt；若保留成熟协议，则归入 `existing-critical-protocol`，且只能使用其既有证据。`mutation 后回包可能丢失` 本身不是额外创建 Intent 的理由，必须先按上表选择唯一 policy。

### 7.2 Intent key

```text
(taskRunId, actionKey, operationKey)
```

`jobId` 不进入业务唯一键。

### 7.3 Intent state

```text
prepared → acked → committed → closed
prepared → recovered → closed
acked → recovered → closed
```

`recovered` 表示 inspector 已证明 mutation 未提交或已由受控恢复消解，不能覆盖已经确认的 `committed` 事实。v1 明确禁止 `committed → recovered`；已 committed source 的 settlement 恢复结果记录在 TaskRun、Batch overlay、Recovery Hold 和 recovery event 中，Intent 仍按 `committed → closed` 收口。

### 7.4 时序

```text
Main 持久化 prepared
→ Main 持久化 acked
→ Main 发送 critical:ack
→ Worker 进入事务/protected
→ Worker 同事务写 module receipt
→ Worker 发 commit:receipt
→ Main 按 receipt/inspection 标记 committed；只有明确 not-committed 时才从 prepared/acked 标记 recovered
→ Task/Artifact settle
→ Main 标记 closed
```

如果 acked 持久化成功但 ACK 未送达，启动恢复时 inspector 应得到 not-committed；这比 Worker 已收到 ACK 而平台无记录更安全。

### 7.5 Critical Intent Store 不替代 module receipt

Intent 证明“允许进入临界区”，不能证明业务已 COMMIT。

`worker-durable` MUST 具备：

```text
平台 Critical Intent
+
模块本地、与业务 mutation 同事务的 Commit Receipt
```

已有 durable journal 若要继续作为唯一权威证据，必须把 action 登记为 `existing-critical-protocol`，不能在 `worker-durable` 下替代 module-local receipt。

### 7.6 Inspector

每个 mutation / settlement action MUST 静态注册只读 inspector。Inspector 接收通用恢复来源，不再假设一定存在 Critical Intent：

```typescript
inspectOutcome(source: RecoverySourceV1): Promise<RecoveryInspectionResultV1>
```

- `intentId` 仅对 `critical-intent` 与 `target-post-image` 必填；Inspector 通过 Repository 只读加载 Intent；
- `publisher-journal`、`existing-protocol`、`module-recovery` 的 `intentId` 必须为空；
- `boundedEvidence` 由来源枚举器生成，必须通过对应 module schema 和大小门禁；
- Inspector 不负责枚举来源、恢复 settlement 或创建新业务 mutation；
- `settlementKey` 对应的 Provider 只负责枚举 open source 与在 inspection 后恢复正式 settlement。

返回：

```text
committed
not-committed
partially-committed
compensated
unknown
```

Inspector MUST：

- 可重复调用；
- 不修改业务状态；
- 不清理后续 recovery 需要的证据；
- committed 指向唯一 receipt；
- 无法唯一判断时返回 unknown。

### 7.7 Recovery Hold

以下结果创建 hold：

- unknown；
- partially-committed；
- committed 但 settlement 无法恢复；
- compensation 未知；
- receipt/evidence 冲突；
- Publisher journal 无法判断正式发布状态。

Hold 使用通用来源身份：

```text
sourceKind = critical-intent | publisher-journal | target-post-image | existing-protocol | module-recovery | manual
sourceRef  = bounded stable identity
intentId   = nullable
```

`sourceKind=critical-intent` 或 `sourceKind=target-post-image` 时 `intentId` 必填；后者引用 Main-owned intent。`publisher-journal / existing-protocol / module-recovery / manual` 的 `intentId` 必须为空。`manual` hold 不转换为自动 Inspector 输入；任何来源都不得为了满足外键伪造 Critical Intent。

Hold 按模块 `conflictScopeKey` 阻断冲突 mutation。Legacy fallback 不得绕过 hold；只读操作是否允许由 action policy 明确。

## 8. Lifecycle Mapping

规范映射见 `platform-lifecycle-mapping.md`。

核心规则：

- TaskRun 真实基础状态包含 `prepared / running / succeeded / failed / cancelled / interrupted`；
- 正常邻接表冻结为 `prepared → running | failed | cancelled | interrupted` 与 `running → succeeded | failed | cancelled | interrupted`；
- 恢复必须走 `interrupted → running(recovery) → succeeded/failed/interrupted`，禁止直接 `interrupted → succeeded/failed`；
- 当前 Batch `task_status` 不扩表重建；采用兼容 overlay（Option B）表达 `interrupted/recovering/resolved`，并按 overlay 计算 effective status；
- recovery events 是 MUST 的 append-only 审计，不再是推荐项；
- TaskRun 的恢复相关状态迁移，以及 Batch overlay、Recovery Hold、Critical Intent 的每次状态迁移，与对应 append-only recovery event **必须在同一个 Main-owned control DB transaction 内提交**。不得用异步补写、消息顺序、重试或任何事务外排序机制替代数据库原子性；
- 平台 Repository 顶层公共写入口只能是 `RecoveryControlRepository.runInControlTransaction()`；事务作用域内唯一状态 mutation 是 `RecoveryControlTransactionV1.transitionWithRecoveryEvent()`，纯观察事件通过同一作用域内的 `appendObservationEvent()` 追加；
- 无状态迁移的 `inspection-completed / inspection-failed-transient / settlement-resumed / settlement-failed-transient` 只能通过同一事务作用域内的 `RecoveryControlTransactionV1.appendObservationEvent()` 追加；该方法不得修改任何控制状态，写入事件的 `previous_state / next_state` 必须均为 `NULL`；
- 一次恢复动作更新多个控制对象时，Main 必须只调用一次 `RecoveryControlRepository.runInControlTransaction()`，并在同一个 `RecoveryControlTransactionV1` 上完成全部 transition 与 observation event；事务作用域内方法不得独立 BEGIN、COMMIT 或 ROLLBACK；
- Batch overlay command 必须以 exact keys 携带 canonical actionKey、legacy expectedTaskKey、operationKey、batchId、taskRunId 与 source pair；adapter 验证 action binding，Repository CAS Task/Batch identity 后才能写 canonical event lineage；
- persistent request owner 与 recovery event 必须持久完整 exact request 的 RFC 8785/JCS lowercase SHA-256；在任何 state CAS 前先按 requestKey 加载 owner 并验证 exact request/eventId/hash/createdAt，再返回 replay 或拒绝 conflict，caller 不得传 requestHash；
- `recovery-required` 是 Renderer outcome；
- `COMMIT_STATE_UNKNOWN` 是 code；
- unknown/partial/committed-but-result-lost MUST 映射 TaskRun `interrupted`；
- protected terminate MUST NOT 映射 `cancelled`；
- Publisher unknown 可以通过 journal source 创建 Recovery Hold，不要求存在 Critical Intent。

### 8.1 Recovery Audit Atomicity（MUST）

TaskRun 的恢复相关状态迁移，以及 Batch overlay、Recovery Hold、Critical Intent 的每次状态迁移，与对应 append-only recovery event **必须在同一个 Main-owned control DB transaction 内提交**。

无状态迁移的 `inspection-completed / inspection-failed-transient / settlement-resumed / settlement-failed-transient` 只能通过同一事务作用域内的 `RecoveryControlTransactionV1.appendObservationEvent()` 追加；该方法不得修改任何控制状态，写入事件的 `previous_state / next_state` 必须均为 `NULL`。

该规则是平台审计红线，适用于：

- TaskRun 的 `prepared/running → interrupted`、`interrupted → running(recovery)` 与 `running(recovery) → succeeded/failed/interrupted`；常规 `prepared → running` 和非恢复执行的终态仍由既有 TaskLifecycle/ArchiveRepository 负责，不属于 `RecoveryControlRepository`；
- Batch recovery overlay 的 `interrupted/recovering/resolved` 迁移；
- Recovery Hold 的创建、更新与解除；
- Critical Intent 的 `prepared/acked/committed/recovered/closed` 迁移。

Repository 层必须提供唯一顶层公共写入口 `RecoveryControlRepository.runInControlTransaction()`。Main 在回调中取得事务作用域 `RecoveryControlTransactionV1`；该作用域只允许两类写操作：

- `transitionWithRecoveryEvent()`：执行且只执行一个合法控制状态迁移，并追加一个由 transition 推导的 recovery event；
- `appendObservationEvent()`：只追加 `inspection-completed / inspection-failed-transient / settlement-resumed / settlement-failed-transient` 之一，不修改任何 TaskRun、Batch overlay、Recovery Hold 或 Critical Intent 状态；`sourceKind` 必须来自不含 `manual` 的 RecoverySourceV1 enum。

Transition event type 必须按 E00 TechDoc 的 `RECOVERY_TRANSITION_EVENT_MAP_V1` 推导，调用方不得传入自定义 event type。Batch overlay 邻接固定为 `absent → interrupted → recovering → resolved`，禁止同态 upsert、跳跃或改写 resolved；Critical Intent 邻接按 7.3 执行。

Batch 首次 interrupted 时，兼容基础 `task_status=failed`、overlay `state=interrupted` 与对应 event 必须作为一个 `batch-overlay.mark-interrupted` 逻辑 transition 在同一事务写入；恢复成功不回写基础行，effective status 只由 overlay 计算。

Batch overlay 的四个 command 都必须显式携带 canonical `actionKey`、persisted legacy `expectedTaskKey`、`operationKey`、`batchId`、`taskRunId` 与 source pair。Adapter 先验证冻结 action binding；Repository 在当前事务内 CAS Task/Batch identity，禁止从 legacy task_key、sourceRef 或 safePayload 推导 `event.action_key`。

`transitionWithRecoveryEvent()` 必须在同一 Main control DB transaction 上：

1. 按 `platform-recovery-control-v1.schema.json` 校验完整 exact request，并按 writer-specific envelope 生成 RFC 8785/JCS lowercase SHA-256；
2. 在任何 state CAS 前按 requestKey 加载持久 owner：逐项验证 exact request JCS/hash 与 owner 的 eventId/createdAt；owner 为 committed 时再按 requestKey/eventId/hash 读取 event 并返回 immutable 结果，任一不同拒绝对应 conflict；
3. owner 未提交且 candidate 与已冻结 request 完全一致时，校验当前状态与 compare-and-set 前置条件并写入状态迁移；
4. 追加唯一、append-only 且持久 `request_hash` 的 recovery event；
5. 将结果留在当前事务作用域，禁止自行 COMMIT。

`appendObservationEvent()` 写入的 `previous_state / next_state` 必须均为 `NULL`。它可以是一次事务中的唯一写入，也可以和由同一恢复决定产生的多个状态迁移一起提交；不得使用 `state → same state` 或虚构 transition 代替观察事件。

request hash envelope exact 为：transition writer 使用 `{ contractVersion: 1, writer: 'transitionWithRecoveryEvent', input: { transition, event } }`；observation writer 使用 `{ contractVersion: 1, writer: 'appendObservationEvent', input: { event } }`。完整 exact input 包含 eventId、createdAt、safePayload 及 transition/event 全字段；persistent owner 保存 stable eventId/createdAt/request_jcs/hash，Repository 内部生成 lowercase SHA-256，公共 request 不得出现 caller-controlled `requestHash`。

一次恢复动作更新多个控制对象时，Main 必须只调用一次 `RecoveryControlRepository.runInControlTransaction()`，并在同一个 `RecoveryControlTransactionV1` 上完成全部 transition 与 observation event；事务作用域内方法不得独立 BEGIN、COMMIT 或 ROLLBACK。由最外层一次性 COMMIT；任一步失败时全部 ROLLBACK，也不得通过隐式 ambient transaction 猜测调用关系。

不得在 `RecoveryControlRepository` 顶层公开 `transitionWithRecoveryEvent()` 或 `appendObservationEvent()`，不得公开绕过 event 的独立状态 mutation，也不得公开底层 `appendRecoveryEvent()`。`appendRecoveryEvent()` 只能是 transaction object 内部的 package-private SQL primitive。禁止使用异步补写、消息顺序、重试或任何事务外排序机制替代数据库事务原子性。

## 9. Staging / Artifact Contract

公共层只负责技术完整性：

- artifactKey 属于当前 FilePlan；
- generation path 位于任务 staging 根；
- 拒绝绝对路径注入、`..`、symlink/reparse escape；
- stat/size/hash 与 manifest 一致；
- 输出全集、唯一性和顺序完整；
- source/target snapshot 未变化；
- part/ready/sealed 状态合法；
- 清理失败有可恢复路径。

模块层负责：

- Sheet/列顺序；
- 金额、币种、方向；
- 单元格值、格式、样式、标黄；
- warning/error report；
- 业务行数守恒；
- 模板和 lineage。

正式目标 MUST 由单一 Publisher 或 action 明确登记的 existing Publisher落位。

## 10. Cancellation Contract

每个 action MUST 声明：

```text
user-cooperative
shutdown-only
not-supported
```

并声明 safe points。

规则：

- queue 中可取消；
- pure compute 可在安全点协作取消；
- 进入 protected 后返回 `protected/not-cancellable`；
- terminate 是资源手段，不证明 rollback；
- cancel 只有在 inspector/transaction 明确未提交后才映射 Task cancelled；
- app quit 期间 protected action超时后写 interrupted，不写 cancelled。

## 11. Service Contract

### 11.1 Main-owned ServiceHost

每个长驻 Service 必须由 Main `ServiceHost` 管理：

- ServiceHost 在 spawn 前取得 BaseLease；
- 使用 Service Control Envelope 执行 init/ready/close；
- 将 Worker 的 `resource:request` 转给 Main-only Governor；
- 维护 tentative grant、adoption timeout、reservation ownership；
- 路由 job envelope，并校验 serviceGeneration；
- crash 后释放 Main 持有的 lease/reservation 并使 generation 失效。

Worker 不得持有 Governor、TaskLifecycle、FilePlan、Publisher 或业务锁实例。

### 11.2 Service state

长驻 Service MUST：

- 一次最多一个 mutation/import/run/export command；
- 使用 generation/revision 拒绝 stale command；
- status 只返回 bounded stable summary；
- 大状态采用前完成 `resource:grant → resource:adopted → resource:adopt-ack`；
- token 对外返回前完成 PendingInteractionReservation adoption；
- close/crash 后使所有 token 和旧 generation 结果失效；
- 明确 startup recovery 在 Service constructor 之前还是之后执行，资金模块默认必须先 inspector、后 constructor。

### 11.3 Resource request safety

Service policy 必须声明允许的 resource request kinds。ServiceHost 拒绝：

- 无完整 jobRef 的 state/token request；
- 旧 generation、重复 controlId/requestId；
- requested vector 超出 policy；
- owner identity 与候选 revision 不一致；
- adoption deadline 后的 `resource:adopted`；
- 未收到 `resource:adopt-ack` 即通过 job result 公开 token/new revision。

### 11.4 Control 与 job 终态隔离

`executor:*` 和 `resource:*` 不能 settle job。资源拒绝只能由模块 job coordinator 转换为一个标准 `job:error`；Service close 也不能把 active protected job写成 cancelled。

## 12. Coverage Contract

Coverage 的静态主键是 `actionKey`。

CI MUST 检查：

- Inventory actionKey 唯一；
- Registry actionKey 唯一；
- FilePlan action 与 Inventory 差集；
- handler manifest 与 Inventory 差集；
- managed action 有 policy；
- worker-durable 有 intent/receipt/inspector；
- thread-pool 有 unit failure policy；
- service 有 resource/close/token policy；
- artifact action 有 FilePlan/validator/Publisher；
- production strategy 不指向 test seam；
- Capability Inventory 与 Effective Production Snapshot 不混淆。

不得以正则扫描 IPC 文本作为唯一 coverage 手段。应优先使用显式 action manifest、注册函数元数据或 AST/模块导出检查。

## 13. Versioning

Protocol/Policy/Intent/Lifecycle 的公共字段发生不兼容变化时：

- 必须升级 contractVersion；
- 提供 adapter/migration；
- 旧 active intent 和 recovery record 必须可识别；
- 模块文档不得自行声称“仍是 v1”同时增加不兼容消息。

v1 冻结后，以下词形是唯一合法公共名称：

```text
actionKey
operation
operationKey
jobId
unitId
unit:done
critical:ready
commit:receipt
main-settlement
worker-durable
existing-critical-protocol
```

## 14. 生产启用总门禁

一个 action 只有满足全部条件才可从 legacy/blocked 切到 managed production：

1. Registry/Inventory/handler coverage 通过；
2. 新旧业务结果等价；
3. 行数、金额、币种、方向、月份、顺序和错误分类守恒；
4. 资源 lease 和低内存降级通过；
5. cancel/close/app quit 通过；
6. Worker crash/OOM/protocol error 通过；
7. mutation action 已按其 commit policy 满足恢复门禁：仅 `worker-durable` 与 `main-settlement + target-post-image` 使用平台 Critical Intent；`publisher-journal` 与 `existing-critical-protocol` 不创建平台 Intent，并分别以 durable journal / existing protocol evidence 完成 receipt、Inspector、Lifecycle Mapping 与故障注入；
8. “COMMIT 后、回包前”故障注入通过；
9. artifact action 的 staging、Publisher、部分发布恢复通过；
10. Windows packaged 通过；
11. action 要求的人工资金/审计复核完成；
12. 性能门禁满足，或明确生产固定 single/legacy。

## 15. Canonical 术语迁移表

| 旧写法 | v1 标准写法 |
| --- | --- |
| Registry `operation` | `actionKey` |
| Protocol `type` | `operation` |
| `existing-transport` mode | 实际 `mode` + `adapterKind='existing-dispatch'` |
| `unitDone` | `unit:done` |
| `unitError` | `unit:error` |
| `criticalReady` | `critical:ready` |
| `criticalAck` | `critical:ack` |
| `committed` event | `commit:receipt` |
| `main-controlled` | `main-settlement` |
| `worker-persistent` | `worker-durable` |
| `existing-protocol` | `existing-critical-protocol` |
| coverage duplicate `operationKey` | duplicate `actionKey` |
| `recovery-required` Task status | TaskRun=`interrupted` + Renderer=`recovery-required` |

## 16. 当前 action 级强制 BLOCK

本合同不直接解决模块证据缺口。以下 action 在对应 probe 关闭前 MUST 保持 blocked/legacy：

- VCC OP `saveRun`：缺唯一 operation receipt；
- Statement manual balance seed：缺原子替换、pre/post hash 和 inspector；
- ReconFix JPM：no-op 二义性、缺 ID-aware 不丢坏行 reader；
- BankBU run：side run/main mirror 缺共同 operation identity；
- Duplicate mutation：startup inspector 必须先于 constructor compensation；
- 任何无法唯一返回 committed/not-committed 的 PreFund file outcome；
- VCC Financial OP 双 Writer：subject filter 未下推或 RSS/性能门禁未过。

这些 BLOCK 不阻止纯 Parser、只读 query、staging generation、benchmark 和无关 action实施。


## 15. 机器验证与冻结门禁

本合同只有在以下命令通过时视为冻结：

```bash
changes/background-execution/validation/run-validation.sh
```

该命令必须实际执行：

- Policy Registry Draft 2020-12 Schema；
- Protocol v1 Job/Service envelopes Schema；
- Registry property key 与 `actionKey` 一致；
- static entry/adapter/inspector/publisher/resource-control key 非空；
- `worker-durable`、artifact、service 的值级安全条件；
- version action tables 中 canonical enum；
- 本地 Markdown link 与 backtick contract path；
- 正反 fixtures。

仅扫描废弃词不构成合同验证。
