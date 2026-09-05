# E00 TechDoc — Platform Contract v1、ResourceGovernor、Critical Intent Store 与生命周期接线

> Contract Authority v1 revision 2：独立、非生成机器权威为 `changes/background-execution/recovery-contract-authority.v1.json`；binding=`5c9ee53437d487a94ddb0f0d236dec7b07d4545452c9ebe3c6e98593de209ff2`，TaskPolicy inventory=`9538102480f1a714f3839547f294fbe6fd1c19384734addd89dc0ca6e1dbb368`，result KAT=`1ced39a559f93c787da4d520e37dc0a4513c27dd9b60a4c229509e741b5ec039`。本次受控迁移相对 revision 1 精确提升到 revision 2，删除一条已被实际入口语义替代的 stale pair，并补登记两个冻结 Spec 明确要求的 PreFund deferred legacy action，以 61 条独立 provenance 重新锚定；固定 `genesis=false`、`approvalStatus=PENDING_HUMAN_REVIEW`。repo gate 必须从 merge-base 读取 previous，受控 payload 变化仍须 revision 精确 +1；same-revision flip 必须失败。`contractVersion=1` 保持不变，当前 revision 2 不等同于 Contract Authority v2。机器技术 PASS 不改变人工红线 `PENDING_HUMAN_REVIEW`，也不表示 merge-ready 或 production enablement。

> Genesis evidence gate：即使显式传入 `--authority-mode genesis`，Git worktree 也必须先解析声明的 merge-base；只要 previous authority 已存在就稳定拒绝 `AUTHORITY_GENESIS_PREVIOUS_EXISTS`。所有 Git subprocess 清除 inherited `GIT_*` repository/object/config 控制并设置 `GIT_NO_REPLACE_OBJECTS=1`，再把 Git 返回的 toplevel、gitDir、commonDir、HEAD OID 与物理 `.git` marker/ref 逐项核对；linked worktree 允许 gitDir 与 commonDir 不同，但两者都必须 exact 记录。仅 detached/index-only 的非 Git 副本可降级运行，但报告必须标为 `detached-genesis-non-merge-evidence`、`mergeEvidence=false`，不得冒充 merge evidence。

> Validation report provenance gate：包内 published `validation-report.json` 只允许 repo/default 模式生成；`--no-write-report` 必须把所选 report target 的 complete normalized authority provenance、canonical generation command 与 exact input hashes 同本次实际 authority 解析结果逐项 exact 比较。repo、external、detached、base/merge-base、HEAD/Git physical identity 或 external resolved path/size/SHA-256 任一不同都必须 fail closed；external/detached 正向证据只能写入包外临时 report 后以相同 provenance 复验，不得复用 published repo report。

| 项目 | 内容 |
| --- | --- |
| 工作流编号 | E00 |
| 产品版本 | v3.2.0～v3.2.5 的技术前置 |
| 日期 | 2026-08-21 |
| 状态 | Implementation Ready / 生产 action 仍按独立门禁启用 |
| 产品 Spec | `changes/background-execution/E00-platform-contract-v1-spec.md` |
| 规范合同 | `changes/background-execution/platform-contract-v1.md` |
| Policy Schema | `changes/background-execution/platform-contract-v1.schema.json` |
| Protocol Schema | `changes/background-execution/platform-protocol-v1.schema.json` |
| 可复跑校验 | `changes/background-execution/validation/validate_background_execution_baseline.py` |
| 生命周期映射 | `changes/background-execution/platform-lifecycle-mapping.md` |

## 1. 技术目标

E00 实现一个最小但完整的公共控制层，使后续模块只需要提供：

- action policy；
- module executor / existing adapter；
- payload/result validator；
- business reducer / writer / Publisher；
- module receipt 与只读 inspector；
- conflict scope resolver；
- business artifact validator。

公共层负责：

- 静态 action 注册与 coverage；
- transport lifecycle；
- protocol validation；
-全局资源准入；
- job/unit/service route；
- critical intent；
- recovery hold；
- execution → TaskLifecycle 映射；
- metrics、隐私、故障注入和 app quit。

公共层不理解：

- MPT sequence；
- ReconID；
- VCC 主体和币种；
- BU normalize；
- R1～R5；
- Workbook Sheet 和样式；
- module SQL。

## 2. 建议目录

```text
src/main-process/background-execution/
├── index.js
├── platform-contract.js
├── policy-registry.js
├── policy-schema-validator.js
├── action-manifest.js
├── action-coverage.js
├── protocol-v1.js
├── protocol-validator.js
├── supervisor.js
├── execution-result.js
├── lifecycle-mapper.js
├── task-lifecycle-adapter.js
├── resource-governor.js
├── admission-queue.js
├── resource-lease.js
├── transport/
│   ├── inline-async-adapter.js
│   ├── worker-thread-adapter.js
│   ├── utility-process-adapter.js
│   └── existing-dispatch-adapter.js
├── critical/
│   ├── recovery-control-repository.js
│   ├── recovery-control-read-repository.js
│   ├── critical-coordinator.js
│   ├── recovery-coordinator.js
│   └── inspector-registry.js
├── artifacts/
│   ├── staging-artifacts.js
│   ├── source-evidence.js
│   └── artifact-evidence.js
├── metrics.js
├── privacy.js
├── error-codec.js
├── app-quit-coordinator.js
├── canary/
│   ├── worker-entry.js
│   ├── utility-entry.js
│   ├── canary-inspector.js
│   └── canary-receipt-store.js
└── test-seams.js

src/backend/database/
├── background-execution-schema.js
└── background-execution-repository.js

changes/background-execution/
├── platform-contract-v1.md
├── platform-contract-v1.schema.json
├── platform-protocol-v1.schema.json
├── platform-lifecycle-mapping.md
├── E00-platform-contract-v1-spec.md
├── E00-platform-contract-v1-techdoc.md
├── action-probe-report.md
└── evidence/
```

文件名可按仓库风格调整，但依赖方向必须保持：

```text
Policy/Protocol/Governor/Critical Repository
        ↓
Supervisor / Lifecycle Mapper
        ↓
Transport Adapter
        ↓
Module Executor / Existing Dispatcher
```

模块不得反向 require Supervisor 的内部状态。

## 3. 公共常量与术语

```javascript
const CONTRACT_VERSION = 1;

const EXECUTION_MODES = Object.freeze([
  'inline-async',
  'thread-single',
  'thread-pool',
  'utility-process'
]);

const ADAPTER_KINDS = Object.freeze([
  'native',
  'existing-dispatch'
]);

const LIFETIMES = Object.freeze(['job', 'service']);

const COMMIT_POLICIES = Object.freeze([
  'none',
  'main-settlement',
  'worker-durable',
  'existing-critical-protocol'
]);

const DISPOSITIONS = Object.freeze([
  'managed',
  'legacy-preserved',
  'inline-excluded',
  'blocked'
]);

const TASK_STATUSES = Object.freeze([
  'prepared',
  'running',
  'succeeded',
  'failed',
  'cancelled',
  'interrupted'
]);
```

禁止在其他模块复制不同 enum。所有 policy/schema/protocol validator 从一个模块导出。

### 3.1 Canonical JSON v1（RFC 8785/JCS，冻结）

所有带 `canonical`、`CanonicalSha256`、`request_hash`、`evidenceHash` 或 `resultHash` 的 v1 值统一使用 **RFC 8785 JSON Canonicalization Scheme（JCS）**；算法标识固定为 `RFC8785-JCS`。实现不得用 Python `json.dumps(sort_keys=True)`、locale collation、自定义递归 code-point 排序或普通 `JSON.stringify(object)` 冒充 JCS。编码结果是无 BOM、无空白的 UTF-8 bytes，不做 Unicode normalization。

JCS primitive 规则：

- object property name 按 ECMAScript UTF-16 code unit lexicographic order 递归排序；因此 `U+10000` 的 surrogate pair 排在 `U+E000` 前；
- string escaping 严格使用 ECMAScript `JSON.stringify` 语义：引号、反斜杠、控制字符使用 JSON escape，其他有效 Unicode scalar 原样输出；禁止 lone high/low surrogate；
- number 必须是有限 IEEE-754 binary64，并按 ECMAScript `NumberToString`/`JSON.stringify` 序列化；`1.0 → 1`、`-0 → 0`，指数符号、阈值与最短 round-trip 表示均不得自行改写；
- array 保持 index 顺序；object 只按 key 排序，值语义不做 coercion。

进入 JCS 前必须以不执行用户代码的 descriptor walk 验证 JavaScript runtime domain：

- array 必须是 `Array.prototype` 的 dense array，只含 `0..length-1` own enumerable data properties 与内建 `length`；拒绝 hole、额外 string/symbol key、accessor；
- object prototype 只能是 `Object.prototype` 或 `null`，且只含 own enumerable string-keyed data properties；拒绝 Proxy、Date、Map、Set、class instance、symbol key、non-enumerable property、accessor；
- 任一层出现 own/inherited `toJSON`、`undefined`、BigInt、function、Symbol、NaN、Infinity、循环引用或非法 surrogate 都 fail closed；验证器不得读取 getter 或调用 `toJSON`；
- raw JSON parser 还必须拒绝任意深度的 duplicate property name，不能让 later-key-wins 改写 exact request；进入 `JSON.parse` 前必须使用 duplicate-aware、lossless token parser，禁止先丢失 duplicate/number token 信息再补验；
- 公共合同 JSON domain 的任意整数（包括 bounded object/array 的嵌套 leaf）必须位于 `[-9007199254740991, 9007199254740991]`；raw token `9007199254740992` 与 `9007199254740993` 都必须在转换成 binary64 前拒绝，不能收敛成同一值。Schema 的递归 `CanonicalJsonValue` 与 runtime guard 使用同一上下界。

Python validator 与 Node runtime 共同消费 `validation/fixtures/valid/canonical-json-jcs-v1.json` known-answer vectors；Node 参考实现为 `validation/canonicalize-jcs.js`。KAT 必须覆盖 UTF-16 排序、`1.0`、`-0`、指数、escaping、invalid surrogate、array/plain-object/accessor/toJSON 拒绝，以及 transition/observation full envelope 的 lowercase `[0-9a-f]{64}` SHA-256。任一 KAT、runtime-domain rejection 或跨 runtime digest 不一致都阻断合并。

## 4. Policy Registry

### 4.1 Registry API

```typescript
interface ExecutionPolicyRegistry {
  register(policy: ActionPolicyV1): void;
  freeze(): void;
  get(actionKey: string): Readonly<ActionPolicyV1>;
  has(actionKey: string): boolean;
  list(): ReadonlyArray<Readonly<ActionPolicyV1>>;
  snapshot(): PolicyRegistrySnapshotV1;
}
```

规则：

- 只允许应用启动阶段注册；
- `freeze()` 后禁止 mutation；
- policy 深冻结；
- actionKey 重复立即失败；
- blocked action 的 `production.enabled` 必须 false；
- worker-durable 缺 intent/receipt/inspector 时注册失败；
- service 缺 resource/token/close policy 时注册失败；
- existing-dispatch 必须引用静态 adapterKey；
- Registry 不接受 Renderer payload。

### 4.2 Action manifest

业务 handler 应通过显式 helper 登记：

```javascript
registerBackgroundAction({
  actionKey: 'vcc-op:scan-and-compute',
  ipcChannels: ['vccOp:scan'],
  filePlanActions: ['vcc-op-scan'],
  handlerModule: './vcc-op-calc-session',
  policy
});
```

生成机器可读 manifest：

```javascript
{
  actionKey,
  ipcChannels,
  internalCallers,
  filePlanActions,
  handlerModule,
  policyRef,
  receiptInspectorKey,
  artifactValidatorKey
}
```

Coverage 优先使用 manifest 和静态模块导出；AST 仅用于发现漏登记，不以正则扫描文本作为唯一真相。

独立 `recovery-contract-authority.v1.json` 是 public digest/count/version 权威；生产 `action-task-binding-registry.js` 是 recovery adapter 的 runtime canonical/legacy pair 来源。Action manifest v3 只保存由该 source 导出的审计 snapshot 与独立 provenance，不能授权新 pair：

```typescript
interface ActionManifestV3 {
  manifestVersion: 3;
  bindingAuthoritySource: {
    path: 'src/main-process/background-execution/action-task-binding-registry.js';
    sha256: CanonicalSha256;
    export: 'bindingSnapshot';
    factory: 'createActionTaskBindingRegistry';
    startupConsumer: 'src/main.js#initializeActionTaskBindingStartup(taskPolicyBindingHost,Object.freeze({initializeDatabase,registerIpc}))';
  };
  actions: string[];
  taskPolicyInventorySource: {
    path: 'src/main-process/archive-center/task-policy-registry.js';
    sha256: CanonicalSha256;
    selection: 'single taskPolicyRegistry.list() owned snapshot; batchPolicy in {reserve,no-file}; taskKey === channel';
  };
  taskPolicyInventory: string[];
  allowedLegacyTaskKeysByActionKeySnapshot: Record<string, string[]>;
  callSiteSource: {
    path: 'src/main.js';
    sha256: CanonicalSha256;
    selection: 'real trackedIpcHandle/businessIpcHandle registration literal';
  };
  bindingContract: {
    version: 1;
    contractAuthority: {
      path: 'changes/background-execution/recovery-contract-authority.v1.json';
      contractVersion: 1;
      revision: 1;
      genesis: true;
      approvalStatus: 'PENDING_HUMAN_REVIEW';
    };
    canonicalization: 'RFC8785-JCS';
    sourceBindingMapSha256: CanonicalSha256;
    taskPolicyInventoryCanonicalization: 'RFC8785-JCS';
    taskPolicyInventorySha256: CanonicalSha256;
    expectedActionCount: 52;
    expectedTaskPolicyInventoryCount: 122;
    expectedPairCount: 60;
    expectedForwardBoundTaskKeyCount: 52;
    expectedUnboundTaskPolicyCount: 70;
    expectedProvenanceCount: 60;
  };
  pairProvenance: Array<{
    actionKey: string;
    legacyTaskKey: string;
    canonicalActionSpec: { path: string; line: number };
    callSite: { path: 'src/main.js'; line: number; kind: 'direct-registration' | 'multiline-registration' };
    taskPolicy: { path: 'src/main-process/archive-center/task-policy-registry.js'; line: number };
  }>;
}
```

模块内私有 `ACTION_TASK_BINDINGS` 必须与 `actions` exact 同键，每个 value 是排序、去重的真实 `TaskPolicy.taskKey` 集合；production factory 不接受 `options.bindings` 或任何 caller authority replacement，审计只能调用 `bindingSnapshot()` 取得新的 deep-frozen copy。public digest/count/source contract version 必须从独立非生成 `recovery-contract-authority.v1.json` 读取，source/local/unit/manifest/provenance/report 不能通过同步改写绕过未变化 anchor；v1 受控 value（含 genesis）变化必须按外部 previous 精确提升 revision +1，`contractVersion` 固定为 1，人工 redline 保持 PENDING。binding map 的 RFC 8785/JCS SHA-256 固定为 `5c9ee53437d487a94ddb0f0d236dec7b07d4545452c9ebe3c6e98593de209ff2`。manifest 的 `allowedLegacyTaskKeysByActionKeySnapshot` 必须 value-for-value 等于 source snapshot，但只作审计证据。61 个 exact pair 必须各有独立 canonical Spec、真实 Main call-site 与 TaskPolicy source line provenance；reverse index 只从 provenance pair 构造并与 source authority 等价，禁止从 snapshot 自生 reverse 证据。硬计数固定为 54 actions、122 TaskPolicy inventory、61 pairs、54 bound task keys、68 unbound keys、61 provenance；sorted 122-key inventory 的 RFC 8785/JCS SHA-256 固定为 `9538102480f1a714f3839547f294fbe6fd1c19384734addd89dc0ca6e1dbb368`。空数组表示该 canonical action 当前没有可用于 Task/Batch recovery 的 legacy Task binding，adapter 必须拒绝而不是猜 key。Main 对真实 production module 的唯一 exact CommonJS `require` 必须是除 directive 外第一个 Program.body statement，禁止任何前置可执行 statement/side effect/helper wrapper，且 imported identifier 禁止 shadow/reassign/local fake。CI 必须从 byte 0 编译并执行到该 import 结束的完整 Main 源码前缀，fresh-load exact resolved target，证明唯一 loader request 与真实 export identity。随后把真实 `taskPolicyRegistry` 包成 frozen exact plain `{ list }` host，并在 Program.body 直接调用 `initializeActionTaskBindingStartup(taskPolicyBindingHost, frozenContinuations)`。该 pure seam 立即冻结并保留同一 registry；唯一 awaited `run()` 必须位于真实 `app.whenReady()` success path 的 rethrowing try block，禁止额外 conditional/loop/nested function/吞错 try 或前置 early return，并严格先于建窗。启动 freeze 与 CI 都必须：

1. host 必须 frozen、plain、exact 仅含 own data method `list`，拒绝 Map、array/replaced prototype、非 frozen、accessor/extra API；只调用一次真实 `TaskPolicyRegistry.list()`，descriptor-safe 拒绝 Proxy、accessor、symbol、non-enumerable、sparse/extra array property 与非 plain policy；把返回数组和每个 exact policy shape 复制为 registry-owned snapshot，再取 `batchPolicy in {reserve,no-file}` 的完整 `taskKey` inventory，验证 string/unique、`taskKey === channel`、reserve/no-file 所需 shape、122-key digest 与 manifest snapshot/source SHA 一致；
2. 正向验证每个 allowed legacy key 都存在于真实 inventory，反向构造 `legacyTaskKey → Set<actionKey>` index 并逐 pair 与正向表等价；
3. `ActionTaskBindingRegistry.assertPair(actionKey, expectedTaskKey)` 仅在 action 存在、binding 字段存在且 exact membership 命中时返回；missing action、missing key、mismatch、未登记的一对多扩张都 fail closed；
4. TaskRun/Batch adapter 必须在进入 Repository 前调用上述冻结 binding；Repository 不接受“同 module/name 看起来相似”、prefix、legacy strategy key 或 payload 推断。

构造成功后，caller 再修改原 `list()` 数组或 policy object 不得改变任何授权；registry 内部 membership 必须由 private `Set`/owned copy 持有。`allowedTaskKeys(actionKey)` 每次返回新的 frozen array（未知 action 返回 `undefined`），不得返回模块常量或内部数组。唯一 TaskPolicy create → binding freeze 必须在 source order 上早于任何 `new AppDatabase` 和 `registerAllIpcHandlers()` invocation；binding 抛错时 DB/IPC call count 均为 0。catch/wrap 只使用稳定内部 code/message，不得读取 hostile cause 的 `message` accessor、调用 `String(cause)` 或透传 cause。hidden action、第四次读取才漂移的 getter、等数量 unbound substitution、bound key 缺失、duplicate、taskKey/channel mismatch、Map/prototype host、throwing message getter、返回数组 mutation、barrel export 与 Main order seam 都必须通过真实 Node API 负向门禁并产生稳定 `ActionTaskBindingRegistryError.code`。

一个 canonical action 可以显式绑定多个真实 TaskPolicy key；一个 legacy TaskPolicy key 也可能因冻结的 strategy split 显式关联多个 canonical action。只有生产 source registry 中列出的 exact pair 合法，反向 index 不能自行扩张；Recovery adapter 必须注入 Main 启动创建的同一 registry，禁止导入 manifest snapshot 自行判定。生产源码零命中的 `statement:generate` 不属于 inventory，任何 fixture、KAT 或调用方出现该 key 都必须失败。

### 4.3 Coverage 集合

```text
F = FilePlan action keys
H = Handler manifest action keys
W = Existing Worker/utility dispatcher action keys
I = Inventory action keys
P = Policy action keys
```

Release gate：

```text
(F ∪ H ∪ W) - I = ∅
managed(I) - P = ∅
P - I = ∅
duplicate(actionKey) = ∅
```

额外校验：

- inline-excluded 有 baseline evidence；
- legacy-preserved 有 owner/reason/reviewVersion；
- blocked 有 blocker；
- artifact action 有 validator/Publisher；
- production policy 不指向 test seam。

## 5. Protocol v1

Protocol v1 由 `platform-protocol-v1.schema.json` 机器校验，并明确分为两个 envelope。

### 5.1 JobEnvelopeV1

```typescript
interface JobEnvelopeV1 {
  protocolVersion: 1;
  channel: 'job';
  direction: 'command' | 'event';
  operation: JobOperationV1;
  actionKey: string;
  operationKey: string;
  jobId: string;
  workerInstanceId: string;
  serviceGeneration: number | null;
  unitId: string | null;
  seq: number;
  context: {
    kind: 'operation' | 'file-batch' | 'none';
    value: object;
  };
  payload: object;
}
```

`operation` context 的 value 必须且只能是 `taskRunId/taskKey/moduleId/parentRunId/operationKey`；`file-batch` 再增加且只能增加 `batchId/batchNumber`；两者的 `context.value.operationKey` 必须等于 envelope `operationKey`。`none.value` 必须为空。`jobId/unitId/grant/reservation/critical-intent` 和其他字段一律禁止进入 context。

### 5.2 ServiceControlEnvelopeV1

```typescript
interface ServiceControlEnvelopeV1 {
  protocolVersion: 1;
  channel: 'service-control';
  direction: 'command' | 'event';
  operation: ServiceControlOperationV1;
  serviceKey: string;
  controlId: string;
  workerInstanceId: string;
  serviceGeneration: number;
  seq: number;
  jobRef: null | {
    actionKey: string;
    operationKey: string;
    jobId: string;
    unitId: string | null;
  };
  payload: object;
}
```

Service Control 顶层没有 `actionKey/operationKey/jobId`；需要业务关联时只能放入 `jobRef`。

### 5.3 Operations

```javascript
const JOB_MAIN_TO_EXECUTOR = new Set([
  'job:start', 'unit:start', 'job:cancel', 'unit:cancel',
  'critical:ack', 'critical:reject'
]);
const JOB_EXECUTOR_TO_MAIN = new Set([
  'job:progress', 'unit:progress', 'unit:done', 'unit:error',
  'critical:ready', 'commit:receipt', 'job:done', 'job:error',
  'cancel:ack'
]);
const SERVICE_MAIN_TO_EXECUTOR = new Set([
  'executor:init', 'executor:close',
  'resource:grant', 'resource:reject', 'resource:adopt-ack',
  'resource:revoke', 'resource:release-ack'
]);
const SERVICE_EXECUTOR_TO_MAIN = new Set([
  'executor:ready', 'executor:error', 'executor:close-ack',
  'resource:request', 'resource:adopted', 'resource:release'
]);
```

### 5.4 Validator

```javascript
validateJobEnvelope(envelope, expectedJobRoute);
validateServiceControlEnvelope(envelope, expectedServiceRoute);
```

共同校验顺序：plain object → exact keys → schema → direction/operation → identity → seq → payload size → operation-specific validator → privacy。

Job payload 使用 operation-specific 精确外层 wrapper：start=`input`，progress=`progress`，done=`result`，error=`error`，critical handshake=`critical`，receipt=`receipt`，cancel=`cancel`，ack=`cancellation`。body 分别由 entry、platform progress/SafeError、`policy.result.validatorKey`、Critical Intent、receipt Inspector 和 cancellation tracker 校验；Supervisor 不猜字段。完整 UTF-8 compact JSON envelope 的 command/event ceiling 均为 `262144` bytes，取自必填 `policy.protocolLimits`。

额外规则：

- JobEnvelope 的 actionKey/operationKey/jobId 不可空；
- executor lifecycle control 的 jobRef 必须为空；
- state/token/phase resource request 的 jobRef 必须完整；
- Service Control 不能 settle job；
- `resource:adopt-ack` 前 Worker 不得公开 token/new state revision。

### 5.5 Sequence tracker

```javascript
jobSeq: Map<`${jobId}:${workerInstanceId}:${direction}`, lastSeq>
controlSeq: Map<`${serviceKey}:${serviceGeneration}:${workerInstanceId}:${direction}`, lastSeq>
```

- 必须为安全正整数并精确 `lastSeq + 1`；
- Service reply 的 `seq` 属于发送方自身 direction 的独立 tracker，必须取该 direction 的 `last + 1`；不得复制或要求等于对向 request/event 的 `seq`。exchange 仅用 `controlId/requestId/grantId/reservationId` 关联。
- settled job 的 late event只做最小诊断；
-旧 generation 的 control/job消息直接 stale-drop；
- controlId/requestId/grantId 必须分别防重。

### 5.6 Unit state

```javascript
{
  unitId,
  status: 'pending' | 'running' | 'done' | 'error' | 'cancelled',
  assignedWorkerInstanceId,
  startedAt,
  endedAt,
  resultRef,
  error
}
```

公共层不理解 `fileIndex`、subject 或 output；module planner 将其编码进 unitId/payload。

`job:done` gate 要求所有已登记 unit 均为 policy 允许终态且没有 unknown unit，否则以 `protocol-error` 结束 execution。`job:error` 可早停；Supervisor 在现有内部 unit map 中取消/清理剩余 running unit，拒绝后续消息，不新增 public operation 或 terminal event。

## 6. Supervisor

### 6.1 Job state

```javascript
{
  actionKey,
  operationKey,
  jobId,
  policySnapshot,
  status: 'created' | 'queued' | 'spawning' | 'running' |
          'waiting-critical' | 'protected' | 'cancelling' | 'settled',
  transportHandle,
  lease,
  units,
  sequenceTrackers,
  criticalIntentId,
  executionResult,
  settleGate,
  timers,
  metrics
}
```

### 6.2 API

```typescript
interface BackgroundExecutionSupervisor {
  execute(request: ExecuteRequestV1): Promise<ExecutionResultV1>;
  cancel(jobId: string, reason: CancelReasonV1): Promise<CancelResultV1>;
  inspect(jobId: string): ExecutionDiagnosticsV1 | null;
  closeService(serviceKey: string): Promise<void>;
  stopAcceptingNewJobs(): void;
  shutdown(options: ShutdownOptions): Promise<ShutdownReport>;
}
```

### 6.3 Execute sequence

```text
validate action request
→ read frozen policy
→ resolve conflict hold
→ build resource request
→ admission queue
→ obtain lease
→ create jobId / workerInstanceId
→ create transport
→ protocol init/start
→ process events
→ produce one ExecutionResult
→ release phase/compound lease
→ caller performs commit inspection / settlement mapping
```

`operationKey` 必须由调用方在 Task prepare 阶段提供；Supervisor 不猜测。

### 6.4 Settle gate

第一个有效 execution terminal 赢得：

- `job:done`；
- `job:error`；
- spawn/init timeout；
- protocol error；
- unexpected exit；
- cancel timeout；
- adapter failure。

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

`job:done.payload.result` 先由 `policy.result.validatorKey` 校验，再由 Supervisor 放入唯一 `ExecutionResultV1.result`；其他 terminal 的 result 为 `null`。Supervisor 创建 ExecutionResult wrapper，模块不得再造 canonical internal terminal event。

settle 后：

- 取消 timers；
- 移除 listeners；
- 将 late events 交诊断 sink；
- 关闭/终止 transport；
- 释放 lease exactly once；
- resolve 单个 ExecutionResult；
- 不写 TaskLifecycle。

### 6.5 Critical state

收到 `critical:ready`：

1. 验证 action policy 允许 critical；
2. 验证 payload schema；
3. 调用 CriticalCoordinator `prepareAndAck()`；
4. 持久 intent prepared；
5. 执行主进程 pre-commit checks；
6. 持久 intent acked；
7. 发送 `critical:ack`；
8. job 状态变 protected。

任何步骤失败：

- 发送 `critical:reject`（transport 仍可用时）；
- 不进入 protected；
- Main 关闭 intent 或保留可恢复 prepared 记录；
- job 按模块策略失败。

### 6.6 Service Control Transport

ServiceHost 维护独立 control route：

```javascript
Map<serviceKey, {
  workerInstanceId,
  serviceGeneration,
  nextControlSeq,
  pendingControls: Map<controlId, ControlState>,
  tentativeGrants: Map<grantId, TentativeGrant>,
  adoptedReservations: Map<reservationId, OwnerIdentity>
}>
```

处理 `resource:request`：

1. 校验 Service Control Envelope、generation、jobRef 与 policy；
2. 校验 requestKind、requested vector、owner identity；
3. Main 调用 Governor 创建 tentative grant；
4. 返回 `resource:grant` 或 `resource:reject`；
5. 收到 `resource:adopted` 后原子绑定 owner，并在 replacement 时释放旧 reservation；
6. 返回 `resource:adopt-ack`；
7. adoption 超时、Worker exit、旧 generation 消息时回收 tentative grant。

请求矩阵机器冻结：`persistent-state-replace ↔ service-state`，首次 replaces 可为 `null`，已有 adopted reservation 后必须精确引用当前 reservation；`pending-interaction-create ↔ interaction-token` 首次 replaces 必须为 `null`，替换时只允许同 owner、递增 revision、精确引用当前 adopted reservation 且旧 token 已 published，candidate 必须到 adopt-ack 才公开，reject/revoke/adoption timeout 保留旧 token；`phase-extension ↔ phase` 的 replaces 必须为 `null`。错 kind、stale/current mismatch、跨 owner 或跨 purpose replacement 均 protocol-error。

Worker dynamic resourceVector 只含 memoryBytes/cpuSlots/ioHeavySlots；Main 扩展为五维时固定 workerThreadSlots=0、utilityProcessSlots=0，OS 载体已由 spawn 前 BaseLease 计入。

Statement/Service Worker 代码不得出现 `governor.acquire*()`；只能通过该 control route 请求。

## 7. ResourceGovernor

### 7.1 核心类型

```typescript
interface ResourceVectorV1 {
  cpuSlots: number;
  workerThreadSlots: number;
  utilityProcessSlots: number;
  ioHeavySlots: number;
  memoryBytes: number;
}

type LeaseKind =
  | 'base'
  | 'persistent'
  | 'pending-interaction'
  | 'phase'
  | 'compound';

interface ResourceLeaseV1 {
  leaseId: string;
  kind: LeaseKind;
  ownerKey: string;
  actionKey: string;
  operationKey: string | null;
  resources: ResourceVectorV1;
  state: 'granted' | 'released';
  grantedAt: number;
  release(reason: string): void;
}
```

### 7.2 Governor state

```javascript
{
  budgets: ResourceVectorV1,
  activeUsage: ResourceVectorV1,
  leases: Map,
  queue: PriorityQueue,
  accepting: true,
  lastMemorySample: {},
  diagnostics: {}
}
```

### 7.3 Budget computation

```javascript
const parallelism = os.availableParallelism?.() || os.cpus().length;
const cpuBudget = Math.max(1, Math.min(4, parallelism - 2));
const workerThreadBudget = Math.max(1, cpuBudget + 1);
const utilityProcessBudget = 1;
const ioHeavyBudget = 2;
```

Memory budget SHOULD use：

```text
min(
  configurable hard ceiling,
  max(0, os.freemem() - systemReserveBytes)
)
```

同时扣除 active reservations。数值由发布 benchmark 固化，不向 Renderer 暴露。

### 7.4 Admission

```typescript
requestLease({
  kind,
  ownerKey,
  actionKey,
  operationKey,
  resources,
  priority,
  timeoutMs,
  downgradeOptions
}): Promise<ResourceLeaseV1>
```

优先级：

```text
recovery > interactive > normal > maintenance
```

使用 aging 防止饿死。

### 7.5 Base / persistent / pending / phase

#### Service start

```text
request BaseLease
→ spawn service
→ service ready
```

#### State adoption

```text
build draft under phase lease
→ estimate new state
→ atomic replace persistent reservation
→ success: adopt state
→ failure: discard draft and keep old adopted state/invalidation semantics
```

#### Waiting user

```text
estimate token context
→ request PendingInteractionReservation
→ store token context
→ return token
→ release phase CPU/I/O lease
```

Token consume/expire/crash releases reservation。

### 7.6 Atomic replace

```typescript
replaceReservation({
  oldLeaseId,
  newResources,
  ownerKey,
  reason
}): Promise<ResourceLeaseV1>
```

Implementation under Governor mutex：

1. confirm old lease active/owned；
2. compute delta；
3. check budget with old usage still counted；
4. reserve delta or release excess atomically；
5. create replacement lease identity；
6. mark old released；
7. return new lease。

Failure leaves old lease unchanged。

### 7.7 Compound lease

Existing nested executor registers topology：

```javascript
{
  base: { cpuSlots: 0, workerThreadSlots: 1, utilityProcessSlots: 0,
          ioHeavySlots: 0, memoryBytes: 128 << 20 },
  phase: { cpuSlots: 0, workerThreadSlots: 0, utilityProcessSlots: 0,
           ioHeavySlots: 1, memoryBytes: 0 },
  childrenMax: 4,
  childResource: { cpuSlots: 1, workerThreadSlots: 1, utilityProcessSlots: 0,
                   ioHeavySlots: 1, memoryBytes: 256 << 20 }
}
```

Governor grants one compound lease for effective child count. Adapter then invokes existing dispatcher with that frozen count or records its fixed internal max. Adapter MUST NOT add a wrapper Worker。

`resources.base` 是唯一 root executor；compound 不再声明 root，且 `childResource` 必填。active compound = resources.base + resources.phase + childResource * effectiveChildCount；childrenMax/effectiveChildCount 只计 children，不含 root。persistent/pending reservation 按实际存活期另计，已有维度不得双算。

### 7.8 Leak detection

每个 test/job end 检查：

- active lease count；
- usage vector returns expected baseline；
- queued requests；
- service base/persistent reservations；
- token reservations；
- transport handles。

## 8. Platform Control Schema

### 8.1 持久化边界（冻结）

Platform Contract v1 的控制表固定写入**当前 Main-owned 主控制 SQLite 数据库**，即与 TaskRun、Batch、archive repository 共用连接与事务域的控制库。v1 不创建独立 platform DB。

理由：

- TaskRun interruption、Batch overlay、Recovery Hold、Critical Intent 的状态迁移与对应 recovery event 必须在同一个 Main-owned control DB transaction 内提交；
- 启动扫描与现有主控备份、迁移和锁顺序一致；
- Main 是平台控制表唯一 writer；
- 表只保存 bounded safe evidence，不保存百万行业务数据。

边界：

- 模块本地 receipt 仍写在业务 mutation 所在的模块 DB 同一事务中；
- Publisher journal 继续使用现有 durable 文件/记录；
- 平台不宣称主控制 DB 与模块 DB/文件系统具备跨存储原子事务；
- 跨存储恢复通过 operationKey、RecoverySourceV1、receipt/journal/post-image 与 inspector 完成。

若未来拆分独立平台数据库，必须升级 Contract 版本并提供 migration、downgrade 和 startup recovery 兼容，不得作为 E02-C1/C2 实现时的自由选择。

### 8.2 Critical intents

```sql
CREATE TABLE IF NOT EXISTS background_execution_critical_intents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  contract_version INTEGER NOT NULL,
  intent_id TEXT NOT NULL UNIQUE,
  action_key TEXT NOT NULL,
  operation_key TEXT NOT NULL,
  task_run_id TEXT NOT NULL,
  job_id TEXT NOT NULL,
  coordination_kind TEXT NOT NULL CHECK (
    coordination_kind IN ('worker-critical', 'main-owned-settlement')
  ),
  state TEXT NOT NULL CHECK (
    state IN ('prepared', 'acked', 'committed', 'recovered', 'closed')
  ),
  conflict_scope_key TEXT NOT NULL,
  inspector_key TEXT NOT NULL,
  evidence_version INTEGER NOT NULL,
  evidence_json TEXT NOT NULL,
  evidence_sha256 TEXT NOT NULL,
  receipt_ref_json TEXT,
  result_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  closed_at TEXT,
  retention_until TEXT,
  UNIQUE(action_key, operation_key, task_run_id)
);

CREATE INDEX IF NOT EXISTS idx_bg_exec_intent_state
  ON background_execution_critical_intents(state, updated_at);

CREATE INDEX IF NOT EXISTS idx_bg_exec_intent_scope
  ON background_execution_critical_intents(conflict_scope_key, state);
```

`coordination_kind` 由 policy 推导：`worker-durable` 使用 `worker-critical`；`main-settlement + target-post-image` 使用 `main-owned-settlement`。后者不发送 Worker `critical:ready / critical:ack`，但仍在 Main 原子替换前持久化 prepared/acked。

`publisher-journal` 与 `existing-critical-protocol` 的 `criticalIntent` 固定为 `false`，不得写入该表。已有协议证据不足时 action 必须保持 `blocked`；不得用临时平台 Intent 掩盖既有协议缺口。

`evidence_json` 必须：

- 经过 module schema validator；
- 有最大字节数；
- 不含完整原始行、密码、完整账号；
- 写入前 canonical JSON + SHA-256。

### 8.3 Recovery holds

Hold 必须支持 Critical Intent 之外的 durable source，尤其是普通 `main-settlement` Publisher journal：

```sql
CREATE TABLE IF NOT EXISTS background_execution_recovery_holds (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  hold_id TEXT NOT NULL UNIQUE,
  source_kind TEXT NOT NULL CHECK (
    source_kind IN (
      'critical-intent', 'publisher-journal',
      'target-post-image', 'existing-protocol',
      'module-recovery', 'manual'
    )
  ),
  source_ref TEXT NOT NULL,
  intent_id TEXT,
  action_key TEXT NOT NULL,
  operation_key TEXT NOT NULL,
  task_run_id TEXT NOT NULL,
  conflict_scope_key TEXT NOT NULL,
  reason_code TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'resolved')),
  resolution TEXT CHECK (
    resolution IS NULL OR resolution IN (
      'committed', 'not-committed', 'compensated', 'manual-override'
    )
  ),
  safe_summary_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  resolved_at TEXT,
  CHECK (
    (source_kind IN ('critical-intent', 'target-post-image') AND intent_id IS NOT NULL)
    OR (source_kind NOT IN ('critical-intent', 'target-post-image') AND intent_id IS NULL)
  ),
  UNIQUE(source_kind, source_ref),
  FOREIGN KEY(intent_id)
    REFERENCES background_execution_critical_intents(intent_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_bg_exec_active_hold_scope
  ON background_execution_recovery_holds(conflict_scope_key)
  WHERE status = 'active';
```

若 SQLite runtime 不支持 partial index，应使用 transaction + query guard 实现等价唯一性。`source_ref` 是 bounded identity，不得直接保存用户任意路径。

### 8.4 Batch recovery overlay（Option B）

不重建现有 Batch 表：

```sql
CREATE TABLE IF NOT EXISTS background_execution_batch_recovery_states (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id INTEGER NOT NULL,
  task_run_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (
    state IN ('interrupted', 'recovering', 'resolved')
  ),
  final_outcome TEXT CHECK (
    final_outcome IS NULL OR final_outcome IN ('succeeded', 'failed')
  ),
  recovery_attempt_id TEXT,
  source_kind TEXT NOT NULL,
  source_ref TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  resolved_at TEXT,
  UNIQUE(batch_id, task_run_id),
  FOREIGN KEY(batch_id) REFERENCES archive_batches(id),
  FOREIGN KEY(task_run_id) REFERENCES archive_task_runs(task_run_id)
);
```

Repository 提供 `getEffectiveBatchStatus()`，优先读取 active overlay；无 overlay 时返回原 Batch `task_status`。旧代码保持把 interrupted 映射为基础 `failed`，新平台查询使用 effective status。

### 8.5 Recovery events（MUST）

Recovery request 的稳定 owner 先持久化完整 exact request；它不是业务状态，也无权直接修改 Task/Batch/Intent/Hold：

四类 observation 在 owner reserve 前，先为 exact durable scope 原子分配并持久化正安全整数 ordinal。`observation_scope_key` 固定为 `observation-attempt:v1:` + lowercase SHA-256(`JCS(['recovery-control/v1/observation-attempt-scope', eventType, actionKey, operationKey, taskRunId, sourceKind, sourceRef, batchId, intentId, holdId, recoveryAttemptId])`)；缺失 optional lineage 仍按位写 JSON `null`。scope 明确排除 `observationAttemptId/eventId/requestHash/request_hash/createdAt/safePayload`。分配必须在短 `BEGIN IMMEDIATE` transaction 中完成，首次持久 `prepared` 后才能 reserve owner；重启先 `resumePreparedObservationAttempt(scope)` 复用相同 ordinal，只有调用方明确开始下一次审计尝试时才可 `allocateNextObservationAttempt(scope)`：

```sql
CREATE TABLE IF NOT EXISTS background_execution_recovery_observation_attempts (
  observation_scope_key TEXT NOT NULL,
  observation_attempt_id INTEGER NOT NULL CHECK (
    observation_attempt_id >= 1
    AND observation_attempt_id <= 9007199254740991
  ),
  event_type TEXT NOT NULL CHECK (
    event_type IN (
      'inspection-completed',
      'inspection-failed-transient',
      'settlement-resumed',
      'settlement-failed-transient'
    )
  ),
  action_key TEXT NOT NULL,
  operation_key TEXT NOT NULL,
  task_run_id TEXT NOT NULL,
  source_kind TEXT NOT NULL,
  source_ref TEXT NOT NULL,
  batch_id INTEGER,
  intent_id TEXT,
  hold_id TEXT,
  recovery_attempt_id TEXT,
  request_key TEXT UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('prepared', 'committed')),
  prepared_at TEXT NOT NULL,
  committed_at TEXT,
  PRIMARY KEY(observation_scope_key, observation_attempt_id),
  UNIQUE(observation_scope_key, observation_attempt_id, request_key),
  CHECK (
    status = 'prepared'
    OR (status = 'committed' AND request_key IS NOT NULL AND committed_at IS NOT NULL)
  )
);
```

`allocateNextObservationAttempt(scope)` 在 `BEGIN IMMEDIATE` 内读取该 scope 的 `MAX(observation_attempt_id) + 1` 并 INSERT `prepared`，随后 `SELECT changes(); -- MUST equal 1`；不得用进程内 counter。owner reserve 生成完整 request 后，`bindObservationAttemptRequest(scope, observationAttemptId, requestKey)` 只允许 `request_key IS NULL OR request_key = :requestKey` 且 `SELECT changes(); -- MUST equal 1`。同 scope + ordinal 的 restart 必须复用已绑定 requestKey；下一 ordinal 才能 append 新 event。瞬态失败达到阈值的最后一次仍占独立 ordinal/event，不能覆盖前次 observation。

```sql
CREATE TABLE IF NOT EXISTS background_execution_recovery_request_owners (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_key TEXT NOT NULL UNIQUE,
  writer TEXT NOT NULL CHECK (
    writer IN ('transitionWithRecoveryEvent', 'appendObservationEvent')
  ),
  event_id TEXT NOT NULL UNIQUE,
  request_hash TEXT NOT NULL CHECK (
    length(request_hash) = 64
    AND request_hash NOT GLOB '*[^0-9a-f]*'
  ),
  request_jcs TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('prepared', 'committed')),
  created_at TEXT NOT NULL,
  committed_at TEXT,
  UNIQUE(request_key, writer, event_id, request_hash, created_at)
);
```

`request_jcs` 是包含 `contractVersion/writer/input` 的完整 RFC 8785/JCS envelope bytes 以 UTF-8 TEXT 无损保存；`request_hash = SHA-256(UTF-8(request_jcs))`。该表只允许 `prepared → committed`，不得覆盖 eventId、createdAt、request body 或 hash。

owner reserve 在调用 `runInControlTransaction()` 前以独立、短 Main DB transaction 持久提交，因此 writer 失败或进程在 event COMMIT 前退出时，`prepared` owner 仍能在下次扫描中复用相同请求。首次 reserve 先生成 eventId/createdAt、组装 exact request、执行 JCS/hash，再 INSERT；重启后的 reserve 读取已存 eventId/createdAt，用当前 draft 重建 candidate exact request 并逐 bytes 比较 `request_jcs`。event 成功 INSERT 的同一个 outer control transaction 必须把对应 owner 从 `prepared` CAS 为 `committed`，且 `changes() === 1`；如果 event 已提交但 owner 状态因旧数据异常不是 `committed`，启动校验必须 fail closed 并报警，不能猜测修复。

```sql
CREATE TABLE IF NOT EXISTS background_execution_recovery_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_key TEXT NOT NULL UNIQUE,
  writer TEXT NOT NULL CHECK (
    writer IN ('transitionWithRecoveryEvent', 'appendObservationEvent')
  ),
  event_id TEXT NOT NULL UNIQUE,
  request_hash TEXT NOT NULL CHECK (
    length(request_hash) = 64
    AND request_hash NOT GLOB '*[^0-9a-f]*'
  ),
  action_key TEXT NOT NULL,
  operation_key TEXT NOT NULL,
  task_run_id TEXT NOT NULL,
  source_kind TEXT,
  source_ref TEXT,
  batch_id INTEGER,
  intent_id TEXT,
  hold_id TEXT,
  recovery_attempt_id TEXT,
  observation_scope_key TEXT,
  observation_attempt_id INTEGER,
  event_type TEXT NOT NULL,
  previous_state TEXT,
  next_state TEXT,
  safe_payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  CHECK (
    event_type NOT IN (
      'inspection-completed',
      'inspection-failed-transient',
      'settlement-resumed',
      'settlement-failed-transient'
    )
    OR (previous_state IS NULL AND next_state IS NULL)
  ),
  CHECK (
    (source_kind IS NULL AND source_ref IS NULL)
    OR (source_kind IS NOT NULL AND source_ref IS NOT NULL)
  ),
  CHECK (
    source_kind IS NULL OR source_kind IN (
      'critical-intent', 'publisher-journal',
      'target-post-image', 'existing-protocol',
      'module-recovery', 'manual'
    )
  ),
  CHECK (
    (writer = 'transitionWithRecoveryEvent'
      AND observation_scope_key IS NULL
      AND observation_attempt_id IS NULL)
    OR (writer = 'appendObservationEvent'
      AND observation_scope_key IS NOT NULL
      AND observation_attempt_id >= 1
      AND observation_attempt_id <= 9007199254740991)
  ),
  FOREIGN KEY(request_key, writer, event_id, request_hash, created_at)
    REFERENCES background_execution_recovery_request_owners(
      request_key, writer, event_id, request_hash, created_at
    ),
  FOREIGN KEY(observation_scope_key, observation_attempt_id, request_key)
    REFERENCES background_execution_recovery_observation_attempts(
      observation_scope_key, observation_attempt_id, request_key
    )
);

CREATE INDEX IF NOT EXISTS idx_bg_exec_recovery_events_task
  ON background_execution_recovery_events(task_run_id, id);

CREATE INDEX IF NOT EXISTS idx_bg_exec_recovery_events_operation
  ON background_execution_recovery_events(action_key, operation_key, id);
```

该表为 append-only MUST。任何状态更新不得删除或覆写旧事件。`request_key/writer/request_hash` 必须逐项等于 owner 行；observation 的 `(observation_scope_key, observation_attempt_id, request_key)` 必须逐项等于已持久 attempt owner，transition 的这两列必须均为 NULL。`action_key / operation_key / task_run_id` 提供业务操作血缘；存在 RecoverySource 时 `source_kind / source_ref` 成对持久化，不能只埋在 free-form JSON 中。`safe_payload_json` 只保存 bounded、脱敏证据摘要。`request_hash` 保存 Repository 对完整 exact request 计算的 lowercase RFC 8785/JCS SHA-256，用于跨进程重启判定同一 `event_id` 是 exact replay 还是 conflict；调用方不得传入或覆盖 request hash。

## 9. Repository API

### 9.1 RecoveryControlRepository 事务边界与作用域写入口

TaskRun 的恢复相关状态迁移，以及 Batch overlay、Recovery Hold、Critical Intent 的每次状态迁移，与对应 append-only recovery event **必须在同一个 Main-owned control DB transaction 内提交**。

无状态迁移的 `inspection-completed / inspection-failed-transient / settlement-resumed / settlement-failed-transient` 只能通过同一事务作用域内的 `RecoveryControlTransactionV1.appendObservationEvent()` 追加；该方法不得修改任何控制状态，写入事件的 `previous_state / next_state` 必须均为 `NULL`。

平台调用方不得分别提交“状态写入”和“事件追加”。Repository 顶层只公开事务边界；所有持久写必须使用回调收到的 transaction object：

```typescript
type RecoveryControlTransitionV1 =
  | TaskRunTransitionV1
  | BatchOverlayTransitionV1
  | CriticalIntentTransitionV1
  | RecoveryHoldTransitionV1;

type RecoveryObservationEventTypeV1 =
  | 'inspection-completed'
  | 'inspection-failed-transient'
  | 'settlement-resumed'
  | 'settlement-failed-transient';

interface RecoveryTransitionEventInputV1 {
  eventId: string;
  createdAt: string;
  safePayload: BoundedSafePayloadV1;
}

interface RecoveryObservationEventInputV1 {
  eventId: string;
  eventType: RecoveryObservationEventTypeV1;
  observationAttemptId: number;
  actionKey: string;
  operationKey: string;
  taskRunId: string;
  sourceKind: RecoverySourceV1['sourceKind'];
  sourceRef: string;
  batchId?: number | null;
  intentId?: string | null;
  holdId?: string | null;
  recoveryAttemptId?: string | null;
  createdAt: string;
  safePayload: BoundedSafePayloadV1;
}

interface RecoveryEventProjectionV1 {
  contractVersion: 1;
  requestKey: string;
  writer: 'transitionWithRecoveryEvent' | 'appendObservationEvent';
  eventId: string;
  requestHash: CanonicalSha256;
  actionKey: string;
  operationKey: string;
  taskRunId: string;
  sourceKind: RecoveryHoldSourceKindV1 | null;
  sourceRef: string | null;
  batchId: number | null;
  intentId: string | null;
  holdId: string | null;
  recoveryAttemptId: string | null;
  observationAttemptId: number | null;
  eventType: RecoveryEventTypeV1;
  previousState: string | null;
  nextState: string | null;
  safePayload: BoundedSafePayloadV1;
  createdAt: string;
}

type RecoveryTransitionEventTypeV1 = Exclude<
  RecoveryEventTypeV1,
  RecoveryObservationEventTypeV1
>;

type RecoveryControlTransitionResultV1 = Readonly<
  RecoveryEventProjectionV1 & {
    writer: 'transitionWithRecoveryEvent';
    observationAttemptId: null;
    eventType: RecoveryTransitionEventTypeV1;
  }
>;

type RecoveryObservationEventResultV1 = Readonly<
  RecoveryEventProjectionV1 & {
    writer: 'appendObservationEvent';
    observationAttemptId: number;
    eventType: RecoveryObservationEventTypeV1;
    previousState: null;
    nextState: null;
    sourceKind: RecoverySourceV1['sourceKind'];
    sourceRef: string;
  }
>;

interface RecoveryRequestOwnerRepositoryV1 {
  reserveTransitionRequest<T extends RecoveryControlTransitionV1>(input: {
    requestKey: string;
    transition: T;
    safePayload: BoundedSafePayloadV1;
  }): { transition: T; event: RecoveryTransitionEventInputV1 };

  reserveObservationRequest(input: {
    requestKey: string;
    observationScopeKey: string;
    event: Omit<RecoveryObservationEventInputV1, 'eventId' | 'createdAt'>;
  }): RecoveryObservationEventInputV1;
}

interface RecoveryObservationAttemptRepositoryV1 {
  allocateNextObservationAttempt(scope: {
    eventType: RecoveryObservationEventTypeV1;
    actionKey: string;
    operationKey: string;
    taskRunId: string;
    sourceKind: RecoverySourceV1['sourceKind'];
    sourceRef: string;
    batchId: number | null;
    intentId: string | null;
    holdId: string | null;
    recoveryAttemptId: string | null;
  }): { observationScopeKey: string; observationAttemptId: number; status: 'prepared' };

  resumePreparedObservationAttempt(
    observationScopeKey: string
  ): { observationScopeKey: string; observationAttemptId: number; status: 'prepared' } | null;
}

interface RecoveryControlRepository {
  runInControlTransaction<T>(
    work: (tx: RecoveryControlTransactionV1) => T
  ): T;
}

interface RecoveryControlTransactionV1 {
  transitionWithRecoveryEvent<T extends RecoveryControlTransitionV1>(input: {
    transition: T;
    event: RecoveryTransitionEventInputV1;
  }): RecoveryControlTransitionResultV1;

  appendObservationEvent(
    event: RecoveryObservationEventInputV1
  ): RecoveryObservationEventResultV1;
}
```

`platform-recovery-control-v1.schema.json` 是上述两个 event input、四个 transition union 的每个判别分支、两个完整 request 和两个 result DTO 的唯一机器权威。TypeScript 只是 schema 的可读镜像；所有入口在生成 hash 或读写数据库前都必须按 schema 做 exact runtime validation，未知 key、缺 required key、错误类型、`requestHash`/`request_hash` alias、调用方传入的 state/eventType/identity 均 fail closed。`additionalProperties: false` 必须作用到顶层 request、event、每个 command 分支及嵌套 `PreparedIntentInput`/`RecoveryHoldCreateInput`，不能只检查 discriminant。

`RecoveryControlTransitionResultV1` 与 `RecoveryObservationEventResultV1` 严格等于 immutable `background_execution_recovery_events` 行的 exact projection；因新增 observation durable ordinal，20 个字段全部返回：transition 的 `observationAttemptId` 固定 `null`，observation 必须返回正安全整数；其余 nullable lineage 也显式为 `null`。不得添加 `replayed`、`currentState`、当前实体快照或其他随时间变化的字段。Repository 必须按 machine `resultProjectionContract` 从 exact request + 同次 `changes() === 1` CAS 的 persisted owner/previous/next values 构造 INSERT，并从已提交 event 行逐字段投影返回；不能根据当前 Task/Batch/Intent/Hold 状态重建结果。

结果正确性的独立权威是 valid recovery-control fixture 中 versioned `resultProjectionKnownAnswerContract` + 20 个 `resultProjectionKnownAnswers`，不是 mapper 自己生成的 candidate。KAT exact 固定 20 branches × 20 fields，preimage 为 `JCS(resultProjectionKnownAnswers)`，RFC 8785/JCS SHA-256 为 `1ced39a559f93c787da4d520e37dc0a4513c27dd9b60a4c229509e741b5ec039`；version、count、field inventory、entry order 或任一 value 改变都必须显式更新合同并阻断旧 digest。validator 必须将每个 request/CAS 经真实 mapper 后写入上述 owner/attempt/event DDL，再由 `PHYSICAL_SQL_IMMUTABLE_RESULT_V1` 读取并逐字段与独立 KAT 比较；20×20 field mutants 与 20×3 actionKey/operationKey/taskRunId wrong-owner mutants也必须走同一 mapper→SQLite→KAT 路径。特别是 `task-mark-interrupted.actionKey` 漂移不得通过 candidate 与自身比较而“自证”。

`RecoveryRequestOwnerRepositoryV1` 是 Main 内部的稳定请求 owner，不是 Renderer/Preload/IPC 公共接口。调用方先用可持久重算的 `requestKey` reserve；首次 reserve 在 control DB 中一次生成并保存 UUID `eventId`、UTC `createdAt`、完整 JCS request envelope 与 hash，随后只允许 `prepared → committed`。同一 `requestKey` 在进程重启、startup scan 或 Hold 重扫后必须复用所保存的 `eventId/createdAt/request_jcs/request_hash`；其余 draft 任一 leaf 不同即 `RECOVERY_REQUEST_KEY_CONFLICT`，不得生成新时间或新 eventId 后重试。requestKey 的 exact machine contract 位于 valid recovery-control fixture 的 `requestKeyContract`；计算式固定为 `recovery-control:v1:` + lowercase SHA-256(`JCS([namespace, ...identityValues])`)。machine fields 固定 `tupleEncoding=RFC8785-JCS-array`、`identityPathEncoding=RFC6901-JSON-Pointer`与 `delimiterConcatenation=false`；因此 namespace/每个 identity 是独立 JSON array element，不存在 delimiter/escaping 歧义，缺失 optional identity 固定放 JSON `null`。tuple 的首元素 namespace 必须编码 writer kind 与 command/eventType discriminator，其余元素必须是 durable entity/attempt identity；严格排除 `eventId/requestHash/request_hash/createdAt/safePayload/failureCode/failureMessage/metadataPatch/expectedState` 等 volatile/request body leaf，使同一 durable operation 的任一 exact request 变化仍命中同一 key 并 conflict。

冻结的 20 个 namespace 与 identity tuple 如下，顺序即 JCS array 顺序，不得排序或省略：

| writer / branch | namespace | identityValues |
|---|---|---|
| transition / task mark-interrupted | `recovery-control/v1/transition/task-run/mark-interrupted` | `actionKey, expectedTaskKey, operationKey, taskRunId, sourceKind, sourceRef` |
| transition / task begin-recovery | `recovery-control/v1/transition/task-run/begin-recovery` | 上述六项 + `recoveryAttemptId` |
| transition / task complete-recovery-success | `recovery-control/v1/transition/task-run/complete-recovery-success` | 上述六项 + `recoveryAttemptId` |
| transition / task complete-recovery-failure | `recovery-control/v1/transition/task-run/complete-recovery-failure` | 上述六项 + `recoveryAttemptId` |
| transition / task interrupt-recovery | `recovery-control/v1/transition/task-run/interrupt-recovery` | 上述六项 + `recoveryAttemptId` |
| transition / batch mark-interrupted | `recovery-control/v1/transition/batch-overlay/mark-interrupted` | `actionKey, expectedTaskKey, operationKey, batchId, taskRunId, sourceKind, sourceRef` |
| transition / batch begin-recovery | `recovery-control/v1/transition/batch-overlay/begin-recovery` | 上述七项 + `recoveryAttemptId` |
| transition / batch resolve-success | `recovery-control/v1/transition/batch-overlay/resolve-success` | 上述七项 + `recoveryAttemptId` |
| transition / batch resolve-failure | `recovery-control/v1/transition/batch-overlay/resolve-failure` | 上述七项 + `recoveryAttemptId` |
| transition / intent create-prepared | `recovery-control/v1/transition/critical-intent/create-prepared` | `input.intentId` |
| transition / intent mark-acked | `recovery-control/v1/transition/critical-intent/mark-acked` | `intentId` |
| transition / intent mark-committed | `recovery-control/v1/transition/critical-intent/mark-committed` | `intentId` |
| transition / intent mark-recovered | `recovery-control/v1/transition/critical-intent/mark-recovered` | `intentId` |
| transition / intent close | `recovery-control/v1/transition/critical-intent/close` | `intentId` |
| transition / hold create-or-get | `recovery-control/v1/transition/recovery-hold/create-or-get` | `input.sourceKind, input.sourceRef`；该 durable pair 也是 Hold 表的 UNIQUE identity，`holdId` 是首次 request body，不能先于 owner lookup 充当重扫 key |
| transition / hold resolve | `recovery-control/v1/transition/recovery-hold/resolve` | `holdId` |
| observation / inspection-completed | `recovery-control/v1/observation/inspection-completed` | `actionKey, operationKey, taskRunId, sourceKind, sourceRef, observationAttemptId, batchId, intentId, holdId, recoveryAttemptId` |
| observation / inspection-failed-transient | `recovery-control/v1/observation/inspection-failed-transient` | 同上十项 |
| observation / settlement-resumed | `recovery-control/v1/observation/settlement-resumed` | 同上十项 |
| observation / settlement-failed-transient | `recovery-control/v1/observation/settlement-failed-transient` | 同上十项 |

`runInControlTransaction()` 是 Main 唯一可调用的顶层写入口。它必须在当前 Main-owned control DB connection 上同步执行回调；回调不得返回 Promise、不得等待 Inspector/Provider/文件 I/O，也不得嵌套调用另一个 `runInControlTransaction()`。已有 transaction object 必须显式向下传递。

外层事务时序：

```text
BEGIN Main control transaction
→ invoke synchronous work(tx)
→ tx.transitionWithRecoveryEvent(...) zero or more times
→ tx.appendObservationEvent(...) zero or more times
→ COMMIT exactly once at the outer boundary
```

`transitionWithRecoveryEvent()` 在当前 transaction object 上执行：

```text
validate exact request against platform-recovery-control-v1.schema.json
→ load the persistent request owner + verify RFC8785-JCS request hash
→ lookup requestKey owner, verify its exact request/eventId/hash/createdAt, and return the immutable persisted event projection on an exact replay
→ validate current state + CAS preconditions only when the matching owner is not committed
→ derive canonical eventType and previousState/nextState from transition
→ apply exactly one control-state transition
→ INSERT exactly one append-only recovery event with request_hash
→ return without COMMIT
```

`appendObservationEvent()` 在当前 transaction object 上先按 requestKey 加载 owner 并逐项验证同一 canonical request/eventId/hash/createdAt，再验证 `(observationScopeKey, observationAttemptId, requestKey)` 等于 owner reserve 前已持久的 attempt row；未提交时只 INSERT 一个 event 并返回，不读取或更新控制状态。它只接受 `inspection-completed / inspection-failed-transient / settlement-resumed / settlement-failed-transient`；对应行的 `previous_state / next_state` 必须由 Repository 固定写为 `NULL`。输入类型故意不暴露这两个字段，`sourceKind` 也故意使用不含 `manual` 的 RecoverySourceV1 enum；禁止用同态 `state → state`、虚构 transition 或 manual hold 记录自动观察事实。同 ordinal + exact request 跨重启只返回首次 event；同 scope 的下一次真实 observation 必须先分配下一 ordinal，因而得到不同 requestKey 并追加新 event。

任一 SQL、CAS、约束、event insert、回调异常或 COMMIT 失败时，外层事务整体 ROLLBACK。事务作用域内两个方法都不得独立 BEGIN、COMMIT 或 ROLLBACK。

幂等规则：

- `eventId` 由 Main 生成并全局唯一；
- Repository 必须先验证完整 exact request，再使用冻结 envelope 的 RFC 8785/JCS UTF-8 bytes 计算 lowercase `[0-9a-f]{64}` SHA-256；`transitionWithRecoveryEvent()` 的 envelope exact 为 `{ contractVersion: 1, writer: 'transitionWithRecoveryEvent', input: { transition, event } }`，`appendObservationEvent()` 的 envelope exact 为 `{ contractVersion: 1, writer: 'appendObservationEvent', input: { event } }`；
- hash 覆盖 request 的全部 exact 字段，包括 `eventId`、`createdAt`、`safePayload` 以及 transition/observation 的全部字段；两个 writer 名称是 domain separator。Repository 内部生成并持久化 `request_hash`，公共输入不得接受 caller-controlled `requestHash`；
- Repository 必须在任何 state CAS 之前按 `requestKey` 读取已持久 owner，验证 candidate exact request JCS/hash 与 owner 的 eventId/createdAt；owner 为 committed 时再按 requestKey/eventId/hash 读取 event 并返回已提交结果，不重复 CAS、状态迁移或 event insert；
- 同一 `requestKey` 对应不同 exact request 时返回 `RECOVERY_REQUEST_KEY_CONFLICT`；同一 `eventId` 被不同 requestKey 或 hash 占用时返回 `RECOVERY_EVENT_ID_CONFLICT`。判定只依赖持久 owner/event 行，进程重启后语义不变；
- 任何直接 `interrupted → succeeded/failed` 的 transition 在 repository 层拒绝；恢复必须先进入 `running(recovery)`。

重启回放的冻结例：请求 A 提交并得到 event projection A，随后请求 B 推进同一实体，进程重启后再次提交 A；Repository 必须在读取当前实体状态或执行 CAS 前命中 A 的持久 owner/event 行，并逐字段返回首次调用的 immutable projection A。它不得返回 B 后的当前状态、不得附加 `replayed=true`、不得二次 CAS，也不得追加第二条 event。若 A 的 `createdAt`、safePayload、evidence、transition 或任一 optional lineage leaf 改变，即使 eventId 相同也必须 conflict。

一次恢复动作更新多个控制对象时，Main 必须只调用一次 `RecoveryControlRepository.runInControlTransaction()`，并在同一个 `RecoveryControlTransactionV1` 上完成全部 transition 与 observation event；事务作用域内方法不得独立 BEGIN、COMMIT 或 ROLLBACK。

不得在 `RecoveryControlRepository` 顶层公开 `transitionWithRecoveryEvent()` 或 `appendObservationEvent()`；不得公开独立的底层 `appendRecoveryEvent()`，它只能是 transaction object 内部的 package-private SQL primitive。也不得公开可绕开事件写入的 `markAcked()`、`resolve()`、`markTaskInterrupted()` 等独立 mutation 方法。

### 9.2 Transition command union

规范 transition 至少覆盖：

```typescript
type BoundedSafePayloadV1 = PlainCanonicalJsonObject<16384>;
type BoundedMetadataPatchV1 = PlainCanonicalJsonObject<16384>;
type BoundedIntentPatchV1 = PlainCanonicalJsonObject<16384>;
type BoundedReceiptRefV1 = PlainCanonicalJsonObject<16384>;
type BoundedRecoveryResultV1 = PlainCanonicalJsonObject<16384>;
type BoundedRecoveryEvidenceV1 = PlainCanonicalJsonObject<16384>;
type BoundedSafeSummaryV1 = PlainCanonicalJsonObject<16384>;
type Resolution = 'committed' | 'not-committed' | 'compensated' | 'manual-override';

interface PreparedIntentInput {
  contractVersion: 1;
  intentId: string;
  actionKey: string;
  operationKey: string;
  taskRunId: string;
  jobId: string;
  coordinationKind: 'worker-critical' | 'main-owned-settlement';
  conflictScopeKey: string;
  inspectorKey: string;
  evidenceVersion: number;
  evidenceHash: CanonicalSha256;
  boundedEvidence: BoundedRecoveryEvidenceV1;
}

interface RecoveryHoldCreateInput {
  contractVersion: 1;
  holdId: string;
  sourceKind: RecoveryHoldSourceKindV1;
  sourceRef: string;
  intentId: string | null;
  actionKey: string;
  operationKey: string;
  taskRunId: string;
  conflictScopeKey: string;
  reasonCode: string;
  safeSummary: BoundedSafeSummaryV1;
  evidenceHash: CanonicalSha256;
}

type TaskRunTransitionV1 =
  | { entityKind: 'task-run'; command: 'mark-interrupted'; actionKey: string; expectedTaskKey: string; operationKey: string; taskRunId: string; sourceKind: RecoverySourceV1['sourceKind'] | null; sourceRef: string | null; expectedState: 'prepared' | 'running'; failureCode: BoundedFailureCodeV1; failureMessage: BoundedFailureMessageV1; metadataPatch: BoundedMetadataPatchV1 }
  | { entityKind: 'task-run'; command: 'begin-recovery'; actionKey: string; expectedTaskKey: string; operationKey: string; taskRunId: string; sourceKind: RecoverySourceV1['sourceKind'] | null; sourceRef: string | null; expectedState: 'interrupted'; recoveryAttemptId: string; metadataPatch: BoundedMetadataPatchV1 }
  | { entityKind: 'task-run'; command: 'complete-recovery-success'; actionKey: string; expectedTaskKey: string; operationKey: string; taskRunId: string; sourceKind: RecoverySourceV1['sourceKind'] | null; sourceRef: string | null; expectedState: 'running'; recoveryAttemptId: string; metadataPatch: BoundedMetadataPatchV1 }
  | { entityKind: 'task-run'; command: 'complete-recovery-failure'; actionKey: string; expectedTaskKey: string; operationKey: string; taskRunId: string; sourceKind: RecoverySourceV1['sourceKind'] | null; sourceRef: string | null; expectedState: 'running'; recoveryAttemptId: string; failureCode: BoundedFailureCodeV1; failureMessage: BoundedFailureMessageV1; metadataPatch: BoundedMetadataPatchV1 }
  | { entityKind: 'task-run'; command: 'interrupt-recovery'; actionKey: string; expectedTaskKey: string; operationKey: string; taskRunId: string; sourceKind: RecoverySourceV1['sourceKind'] | null; sourceRef: string | null; expectedState: 'running'; recoveryAttemptId: string; failureCode: BoundedFailureCodeV1; failureMessage: BoundedFailureMessageV1; metadataPatch: BoundedMetadataPatchV1 };

type BatchOverlayTransitionV1 =
  | { entityKind: 'batch-overlay'; command: 'mark-interrupted'; actionKey: string; expectedTaskKey: string; operationKey: string; batchId: number; taskRunId: string; expectedState: null; failureCode: BoundedFailureCodeV1; failureMessage: BoundedFailureMessageV1; sourceKind: RecoveryHoldSourceKindV1; sourceRef: string }
  | { entityKind: 'batch-overlay'; command: 'begin-recovery'; actionKey: string; expectedTaskKey: string; operationKey: string; batchId: number; taskRunId: string; expectedState: 'interrupted'; recoveryAttemptId: string; sourceKind: RecoveryHoldSourceKindV1; sourceRef: string }
  | { entityKind: 'batch-overlay'; command: 'resolve-success'; actionKey: string; expectedTaskKey: string; operationKey: string; batchId: number; taskRunId: string; expectedState: 'recovering'; recoveryAttemptId: string; finalOutcome: 'succeeded'; sourceKind: RecoveryHoldSourceKindV1; sourceRef: string }
  | { entityKind: 'batch-overlay'; command: 'resolve-failure'; actionKey: string; expectedTaskKey: string; operationKey: string; batchId: number; taskRunId: string; expectedState: 'recovering'; recoveryAttemptId: string; finalOutcome: 'failed'; sourceKind: RecoveryHoldSourceKindV1; sourceRef: string };

type CriticalIntentTransitionV1 =
  | { entityKind: 'critical-intent'; command: 'create-prepared'; input: PreparedIntentInput }
  | { entityKind: 'critical-intent'; command: 'mark-acked'; intentId: string; expectedState: 'prepared'; patch: BoundedIntentPatchV1 }
  | { entityKind: 'critical-intent'; command: 'mark-committed'; intentId: string; expectedState: 'acked'; receiptRef: BoundedReceiptRefV1 }
  | { entityKind: 'critical-intent'; command: 'mark-recovered'; intentId: string; expectedState: 'prepared' | 'acked'; inspection: RecoveryInspectionResultV1 }
  | { entityKind: 'critical-intent'; command: 'close'; intentId: string; expectedState: 'committed' | 'recovered'; result: BoundedRecoveryResultV1 };

type RecoveryHoldTransitionV1 =
  | { entityKind: 'recovery-hold'; command: 'create-or-get'; input: RecoveryHoldCreateInput }
  | { entityKind: 'recovery-hold'; command: 'resolve'; holdId: string; expectedState: 'active'; resolution: Resolution; evidence: BoundedRecoveryEvidenceV1 };
```

Command 到 event type 的映射固定如下；实现不得自行命名第二套事件：

<!-- BEGIN RECOVERY_TRANSITION_EVENT_MAP_V1 -->
```json
{
  "task-run.mark-interrupted": "interrupted-recorded",
  "task-run.begin-recovery": "recovery-started",
  "task-run.complete-recovery-success": "recovery-succeeded",
  "task-run.complete-recovery-failure": "recovery-failed",
  "task-run.interrupt-recovery": "recovery-interrupted",
  "batch-overlay.mark-interrupted": "batch-overlay-transitioned",
  "batch-overlay.begin-recovery": "batch-overlay-transitioned",
  "batch-overlay.resolve-success": "batch-overlay-transitioned",
  "batch-overlay.resolve-failure": "batch-overlay-transitioned",
  "critical-intent.create-prepared": "critical-intent-transitioned",
  "critical-intent.mark-acked": "critical-intent-transitioned",
  "critical-intent.mark-committed": "critical-intent-transitioned",
  "critical-intent.mark-recovered": "critical-intent-transitioned",
  "critical-intent.close": "critical-intent-transitioned",
  "recovery-hold.create-or-get": "hold-created",
  "recovery-hold.resolve": "hold-resolved"
}
```
<!-- END RECOVERY_TRANSITION_EVENT_MAP_V1 -->

`TaskRunTransitionV1` 故意只包含中断与恢复相关边：`prepared/running → interrupted`、`interrupted → running`（transition mode=`recovery`）、`running`（recovery mode）`→ succeeded/failed/interrupted`。`running(recovery)` 只是文档/事件 mode 记法，不是 `archive_task_runs` 的新状态字符串；真实持久枚举始终写 `interrupted → running`，并以 `recoveryAttemptId` 关联该 recovery attempt。常规 `prepared → running` 及非恢复执行的 `running → succeeded/failed/cancelled` 保持既有 TaskLifecycle/ArchiveRepository 所有权，不得为了满足 recovery event 合同改由本 Repository 重写。

每个 TaskRun command 必须显式携带 canonical `actionKey`、持久 legacy `expectedTaskKey`、`operationKey`、`taskRunId` 与 nullable-pair `sourceKind/sourceRef`，并保持 exact keys。TaskLifecycle adapter/调用方先用冻结 action binding/policy 验证 `actionKey ↔ expectedTaskKey`；Repository 不依赖 Policy Registry，而是在同一 control transaction 内按 `taskRunId` 加载持久行并 CAS `archive_task_runs.task_key === expectedTaskKey`、`archive_task_runs.operation_key === operationKey`、state 与 recoveryAttempt。旧 Task 的 `task_key` 永不改写；event.action_key 记录经 adapter 验证的 canonical actionKey，event.operation_key 与 source 列原样取已 CAS 的 command identity。不存在、binding/CAS 不一致或 source 只有一项为 null 均 fail closed，禁止只凭 taskRunId、外部值或 safePayload 派生审计血缘。存在 RecoverySource 时 TaskRun command source pair 必填；纯 observation 不借用 TaskRun command identity，inspection/provider observation 按 9.1 显式记录其实际 RecoverySource pair。

每个 Batch overlay command 同样必须显式携带 canonical `actionKey`、持久 legacy `expectedTaskKey`、`operationKey`、`batchId`、`taskRunId` 与 source pair，并保持各判别分支的 exact keys。Batch/TaskLifecycle adapter 先验证冻结的 `actionKey ↔ expectedTaskKey` binding；Repository 在同一 control transaction 内同时 CAS `archive_task_runs.task_key === expectedTaskKey`、`archive_task_runs.operation_key === operationKey`，以及目标 Batch 的 `archive_batches.id/task_run_id/task_key/operation_key` identity。物理映射固定为 `archive_batches.id === batchId`；只有 recovery overlay 表使用 `overlay.batch_id`，且 `overlay.batch_id` 引用 `archive_batches.id`。`event.action_key` 只能取 command 中已验证的 canonical `actionKey`；禁止从 Batch/Task legacy `task_key`、`sourceRef` 或 `safePayload` 猜造 canonical action identity。任一 binding、Task、Batch、operation 或 state 不一致均 fail closed。

`BoundedFailureCodeV1` 是 1..64 字符 safe code；`BoundedFailureMessageV1` 是 1..1000 UTF-8 字符脱敏消息。`BoundedSafePayloadV1` 与 `BoundedMetadataPatchV1` 都是 plain JSON object；按 RFC 8785/JCS canonical JSON（UTF-8、UTF-16 key ordering、ECMAScript number/escaping、无 undefined/非有限数/invalid surrogate/循环/accessor/toJSON）编码后最大 16384 bytes，禁止覆盖 identity/state/recoveryAttempt 字段。ASCII 与多字节值都按 UTF-8 bytes 计；safe payload/metadata 只存隐私安全摘要，不含完整业务行或账号。

`PreparedIntentInput`、`RecoveryHoldCreateInput` 与所有 bounded patch/result 类型也都是 exact keys。Prepared Intent 的 `coordinationKind/conflictScopeKey/inspectorKey` 必须逐项等于 Policy 派生值，`evidenceHash` 必须是 boundedEvidence canonical SHA-256。Recovery Hold 的 source/intent 组合遵守 RecoverySource 条件；status 固定由 Repository 写为 `active`，调用方不得传 state/status/timestamp/event type。`Resolution` 精确为 `committed | not-committed | compensated | manual-override`；resolve evidence 复用同一 16384-byte canonical bounded 类型。

唯一 writer 直接按 command 写业务列：

- `mark-interrupted` merge metadataPatch，并写入/替换 failureCode 与 failureMessage；
- `begin-recovery` merge metadataPatch，保留 interruption failure，写 recovery mode/attempt；
- `complete-recovery-success` 只接受 metadataPatch，清空当前 failureCode/failureMessage；
- `complete-recovery-failure` 与 `interrupt-recovery` merge metadataPatch，并写入/替换 failureCode/failureMessage；
- `safePayload` 只记录 writer 完成后的 bounded 审计结果，禁止从 safePayload 反向猜测或回填 TaskRun 业务列。

每个 transition 的 `previousState/nextState`、canonical event type、task/batch/intent/hold identity 由 Repository 根据 command 和数据库当前值推导；调用方只提供 `eventId` 与 bounded safe payload，不得伪造状态或 event type。Critical Intent 邻接表固定为 `prepared → acked → committed → closed`、`prepared → recovered → closed`、`acked → recovered → closed`；禁止 `committed → recovered`。

Batch overlay 只允许 `absent → interrupted → recovering → resolved`，`resolved` 必须带与 command 一致的 finalOutcome；禁止同态 upsert、跳过 recovering 或改写 resolved。Recovery Hold `create-or-get` 只有两种合法结果：首次 `absent → active + hold-created`，或经同一 persistent `requestKey` 复用首次保存的 stable `eventId/createdAt` 与相同 JCS hash 后重放并返回原结果；已有 Hold 搭配新 eventId 必须返回 `RECOVERY_HOLD_ALREADY_EXISTS`，不得产生无 transition 的新 event。Hold 扫描必须以 Hold 表的 durable UNIQUE `(sourceKind, sourceRef)` 先重算 requestKey，不得每次重建 holdId、eventId 或 createdAt；Main 必须先通过 `RecoveryRequestOwnerRepositoryV1` reserve/reuse 固定请求，不同 holdId 因同 key 不同 exact hash 而 conflict。

Hold startup dedupe 对同一 `(sourceKind, sourceRef)` 必须先比较完整 owner tuple `(actionKey, operationKey, taskRunId)`：完全相同的重复行只调用 Inspector/Provider 一次；同 source pair 但 owner tuple 任一项不同必须裁决为 `unknown`、创建/复用 Hold，且 Inspector/Provider 调用数均为 0。禁止取 first row 后 `continue`、latest-row 或任意 winner。

`batch-overlay.mark-interrupted` 是一个逻辑 transition：必须在当前 transaction object 内同时把既有 Batch 基础 `task_status` 写为兼容值 `failed`、创建 overlay `interrupted` 并追加 `batch-overlay-transitioned`；任何一步失败整体回滚。恢复成功后基础值仍保留历史兼容 `failed`，新查询只通过 overlay 得到 effective `succeeded`，不得回写基础行抹掉 interruption 历史。

### 9.2.1 物理 identity join、CAS 与 row-count gate

<!-- BEGIN PHYSICAL_BATCH_IDENTITY_MAPPING_V1 -->
PHYSICAL_BATCH_IDENTITY_V1: logical `batchId` maps exactly to column `id` of table `archive_batches`; `overlay.batch_id` names only the child foreign key in `background_execution_batch_recovery_states` and references that parent `id`.
<!-- END PHYSICAL_BATCH_IDENTITY_MAPPING_V1 -->

每个 Batch command 在任何 UPDATE/INSERT 前必须执行下列 exact identity join，且只允许一行：

<!-- BEGIN PHYSICAL_SQL_IDENTITY_JOIN_V1 -->
```sql
SELECT batch.id, batch.task_run_id, batch.task_key, batch.operation_key,
       batch.task_status, task.status, task.metadata_json
FROM archive_batches AS batch
JOIN archive_task_runs AS task
  ON task.task_run_id = batch.task_run_id
 AND task.task_key = batch.task_key
 AND task.operation_key = batch.operation_key
WHERE batch.id = :batchId
  AND batch.task_run_id = :taskRunId
  AND batch.task_key = :expectedTaskKey
  AND batch.operation_key = :operationKey
  AND task.task_run_id = :taskRunId
  AND task.task_key = :expectedTaskKey
  AND task.operation_key = :operationKey;
```
<!-- END PHYSICAL_SQL_IDENTITY_JOIN_V1 -->

Task CAS 的 identity predicate 固定为全部三项 legacy identity 加 expected state；begin 以外的 recovery completion/interruption 还必须匹配持久 metadata 中的 attempt。每条 UPDATE 后立即读取同 connection 的 `changes()`，必须严格等于 1：

<!-- BEGIN PHYSICAL_SQL_TASK_CAS_V1 -->
```sql
UPDATE archive_task_runs
SET status = :nextState,
    failure_code = :nextFailureCode,
    failure_message = :nextFailureMessage,
    metadata_json = :nextMetadataJson,
    started_at = :nextStartedAt,
    finished_at = :nextFinishedAt,
    updated_at = :updatedAt
WHERE task_run_id = :taskRunId
  AND task_key = :expectedTaskKey
  AND operation_key = :operationKey
  AND status = :expectedState
  AND (
    :recoveryAttemptId IS NULL
    OR json_extract(metadata_json, '$.recoveryAttemptId') = :recoveryAttemptId
  );
SELECT changes(); -- MUST equal 1
```
<!-- END PHYSICAL_SQL_TASK_CAS_V1 -->

`:recoveryAttemptId` 只有 `mark-interrupted` 为 `NULL`；`begin-recovery` 在 CAS 后首次把新 attempt 写入 `:nextMetadataJson`，其 UPDATE 使用专门的 `status='interrupted' AND json_extract(metadata_json, '$.recoveryAttemptId') IS NULL` predicate。completion/failure/interruption 必须用上面的 exact attempt predicate。不能把 `OR` 改为由调用方随意传 `NULL` 来旁路 attempt；Repository 由 command discriminant 固定 bind shape。

Batch 的基础兼容写只发生于 `batch-overlay.mark-interrupted`，predicate 包含完整 identity 与允许的当前基础状态；row count 也必须恰为 1：

<!-- BEGIN PHYSICAL_SQL_BATCH_CAS_V1 -->
```sql
UPDATE archive_batches
SET task_status = 'failed',
    failure_code = :failureCode,
    failure_message = :failureMessage,
    finished_at = :finishedAt,
    updated_at = :updatedAt
WHERE id = :batchId
  AND task_run_id = :taskRunId
  AND task_key = :expectedTaskKey
  AND operation_key = :operationKey
  AND task_status IN ('reserved', 'running');
SELECT changes(); -- MUST equal 1
```
<!-- END PHYSICAL_SQL_BATCH_CAS_V1 -->

Overlay 的四个 command 只使用 `overlay.batch_id`，但同一 transaction 中已经通过上面的 identity join 锁定对应 `archive_batches.id`。所有 source、state、attempt 与 terminal outcome predicates 都必须保留：

<!-- BEGIN PHYSICAL_SQL_OVERLAY_CAS_V1 -->
```sql
INSERT INTO background_execution_batch_recovery_states AS overlay (
  batch_id, task_run_id, state, final_outcome, recovery_attempt_id,
  source_kind, source_ref, created_at, updated_at, resolved_at
) VALUES (
  :batchId, :taskRunId, 'interrupted', NULL, NULL,
  :sourceKind, :sourceRef, :createdAt, :createdAt, NULL
);
SELECT changes(); -- mark-interrupted: MUST equal 1

UPDATE background_execution_batch_recovery_states AS overlay
SET state = 'recovering', recovery_attempt_id = :recoveryAttemptId,
    updated_at = :updatedAt
WHERE overlay.batch_id = :batchId
  AND overlay.task_run_id = :taskRunId
  AND overlay.state = 'interrupted'
  AND overlay.final_outcome IS NULL
  AND overlay.recovery_attempt_id IS NULL
  AND overlay.source_kind = :sourceKind
  AND overlay.source_ref = :sourceRef;
SELECT changes(); -- begin-recovery: MUST equal 1

UPDATE background_execution_batch_recovery_states AS overlay
SET state = 'resolved', final_outcome = :finalOutcome,
    updated_at = :updatedAt, resolved_at = :updatedAt
WHERE overlay.batch_id = :batchId
  AND overlay.task_run_id = :taskRunId
  AND overlay.state = 'recovering'
  AND overlay.final_outcome IS NULL
  AND overlay.recovery_attempt_id = :recoveryAttemptId
  AND overlay.source_kind = :sourceKind
  AND overlay.source_ref = :sourceRef;
SELECT changes(); -- resolve-success / resolve-failure: MUST equal 1
```
<!-- END PHYSICAL_SQL_OVERLAY_CAS_V1 -->

`finalOutcome` 必须由 discriminant 固定：`resolve-success → succeeded`、`resolve-failure → failed`。event INSERT 与 owner `prepared → committed` UPDATE 也各自要求 `changes() === 1`。Task、Batch、overlay、event、owner 任一 statement 的 row count 不等于 1，或 identity join 不恰为一行，外层 transaction 必须整体 ROLLBACK；禁止将 0 行当作 replay，replay 只允许由提交前按 requestKey 加载 owner、验证 exact request/eventId/hash/createdAt 并读取 committed event 判定。

每次首次调用与 replay 都使用下列 immutable result query；列别名逐一对应 `RecoveryEventProjectionV1`，`safe_payload_json` 解析后仍须过 exact schema/JCS domain validation：

<!-- BEGIN PHYSICAL_SQL_IMMUTABLE_RESULT_V1 -->
```sql
SELECT 1 AS contractVersion,
       event.request_key AS requestKey,
       event.writer AS writer,
       event.event_id AS eventId,
       event.request_hash AS requestHash,
       event.action_key AS actionKey,
       event.operation_key AS operationKey,
       event.task_run_id AS taskRunId,
       event.source_kind AS sourceKind,
       event.source_ref AS sourceRef,
       event.batch_id AS batchId,
       event.intent_id AS intentId,
       event.hold_id AS holdId,
       event.recovery_attempt_id AS recoveryAttemptId,
       event.observation_attempt_id AS observationAttemptId,
       event.event_type AS eventType,
       event.previous_state AS previousState,
       event.next_state AS nextState,
       event.safe_payload_json AS safePayload,
       event.created_at AS createdAt
FROM background_execution_recovery_events AS event
WHERE event.request_key = :requestKey
  AND event.event_id = :eventId
  AND event.request_hash = :requestHash;
```
<!-- END PHYSICAL_SQL_IMMUTABLE_RESULT_V1 -->

### 9.3 Read-only repositories

读取与扫描 API 可以独立暴露，但必须只读：

```typescript
interface RecoveryControlReadRepository {
  getCriticalIntentById(intentId: string): CriticalIntent | null;
  getCriticalIntentByOperation(actionKey: string, operationKey: string, taskRunId: string): CriticalIntent | null;
  listOpenCriticalIntents(): CriticalIntent[];
  listCriticalIntentsByScope(conflictScopeKey: string): CriticalIntent[];

  getRecoveryHoldBySource(sourceKind: string, sourceRef: string): RecoveryHold | null;
  getActiveRecoveryHoldByScope(conflictScopeKey: string): RecoveryHold | null;
  listActiveRecoveryHolds(): RecoveryHold[];

  getEffectiveBatchStatus(batchId: number, taskRunId: string): string;
  listRecoveryEvents(taskRunId: string, cursor?: number, limit?: number): RecoveryEvent[];
}
```

Closed intent 的 retention cleanup 使用专用 maintenance transaction；它只能删除已经 `closed` 且超过 retention 的 Intent 记录，不得删除 append-only recovery events，也不得伪装成 `RecoveryControlTransactionV1` transition。

### 9.4 RecoverySourceV1 与 InspectorRegistry

`RecoverySourceV1` 不在 TechDoc 内重复定义。唯一权威定义为：

```text
changes/background-execution/platform-recovery-source-v1.schema.json
```

实现 SHOULD 从该 Schema 生成 TypeScript/JSDoc 类型；手写类型必须逐字段等价。规范字段为 `contractVersion / sourceKind / sourceRef / actionKey / operationKey / taskRunId / conflictScopeKey / inspectorKey / settlementKey / intentId / evidenceVersion / boundedEvidence`。禁止 `intent / receiptHint / safeEvidence`。

`sourceKind` 只允许：

```text
critical-intent
publisher-journal
target-post-image
existing-protocol
module-recovery
```

`manual` 只属于 Recovery Hold，不是可自动 inspect 的 `RecoverySourceV1`。

```typescript
interface InspectorRegistry {
  register(key: string, inspector: OutcomeInspector): void;
  get(key: string): OutcomeInspector;
  freeze(): void;
}

type OutcomeInspector = (
  source: RecoverySourceV1
) => Promise<RecoveryInspectionResultV1>;
```

规则：

- Inspector 输入不嵌入 Intent object；`critical-intent` 与 `target-post-image` 必须提供 `intentId`，Inspector 通过 Repository 只读加载；
- `publisher-journal`、`existing-protocol`、`module-recovery` 的 `intentId` 必须为空；
- `worker-durable`、`main-settlement`、`existing-critical-protocol` 均必须注册 inspector；
- Inspector 是唯一判定权威，只读、幂等，不负责枚举来源或恢复 settlement；
- Registry 在 startup `freeze()`；register() 必须拒绝 freeze 后注册，freeze 时按 Static Key Manifest 检查完整性，缺少静态引用时 action 不可生产启用。
- `RecoveryInspectionResultV1` 的 exact keys 与 outcome enum 只由 `platform-recovery-source-v1.schema.json#/$defs/RecoveryInspectionResultV1` 定义；identity 必须逐项等于输入 source，`evidenceHash` 是 boundedEvidence canonical JSON 的 SHA-256，canonical UTF-8 bytes 最大 65536。

### 9.5 SettlementRecoveryProviderRegistry

```typescript
interface SettlementRecoveryProviderRegistry {
  register(key: string, provider: SettlementRecoveryProvider): void;
  get(key: string): SettlementRecoveryProvider;
  list(): Array<{ key: string; provider: SettlementRecoveryProvider }>;
  freeze(): void;
}

interface SettlementRecoveryProvider {
  listOpenSources(): Promise<RecoverySourceV1[]>;
  recover(
    source: RecoverySourceV1,
    inspection: RecoveryInspectionResultV1
  ): Promise<SettlementRecoveryResultV1>;
}
```

- `publisher-journal` provider MUST 枚举所有 prepared/committing/committed-but-unsettled/unknown journal；
- `existing-protocol` 与 `module-recovery` provider MUST 枚举其既有 durable open state；
- source enumeration 必须 read-only、幂等、有界，并返回稳定 `sourceRef`；
- `target-post-image` source 由 open Main-owned intent 枚举，provider 的 `listOpenSources()` 可返回空；
- provider MUST NOT 自行 inspect；Coordinator 必须先通过 `source.inspectorKey → InspectorRegistry` 获得唯一 inspection；
- `recover(source, inspection)` 必须按 `(sourceKind, sourceRef, operationKey)` 幂等；inspection evidence hash 只是 CAS/审计输入，不得成为新的 mutation identity。COMMIT 后 crash 的重复调用必须返回同一 settlement 结果，不得重复 publish、generation 或业务 mutation；
- provider 只能根据 inspection 恢复发布、归档、continuation 或 Task settlement，不得重新 generation 或重复业务 mutation；
- `settlementKey` 是该 Registry 的静态 key。
- provider Registry 的 register() 必须拒绝 freeze 后注册；freeze 时按 Static Key Manifest 检查完整性，`list()` 可保留为只读枚举。
- `SettlementRecoveryResultV1` exact keys 与条件 outcome 只由 `platform-recovery-source-v1.schema.json#/$defs/SettlementRecoveryResultV1` 定义。provider 结果 identity/hash mismatch 必须 fail closed：五项 source identity、settlementKey、inspectionEvidenceHash、boundedResult canonical resultHash 任一不符都不得进入 transition。
- `completed` 才允许原子收口；`incomplete` 保持 open/interrupted；`transient-failure` 在同一 control transaction 原子累计失败，达到阈值后创建 `SETTLEMENT_PROVIDER_UNAVAILABLE` hold；`terminal-failure` 立即创建 hold。所有结果都不得重做业务 mutation。

## 10. Critical / Settlement Coordinators

### 10.1 Worker-durable `prepareAndAck`

```typescript
prepareAndAck({
  actionKey,
  operationKey,
  taskRunId,
  jobId,
  conflictScopeKey,
  inspectorKey,
  evidence,
  preCommitCheck,
  sendAck
}): Promise<{ intentId: string }>
```

算法：

```text
check no active hold for conflict scope
validate bounded evidence
create prepared intent in Main control DB
run preCommitCheck under business lock
mark intent acked in Main control DB
send critical:ack
return intentId
```

若 `sendAck` 失败，intent 保持 acked；立即或启动恢复调用 inspector，禁止删除 intent 后盲重跑。

### 10.2 Main-owned target-post-image settlement

用于 `main-settlement + target-post-image`，不发送 Worker `critical:ready / critical:ack`：

```typescript
runMainOwnedPostImageSettlement({
  actionKey,
  operationKey,
  taskRunId,
  jobId,
  conflictScopeKey,
  inspectorKey,
  settlementKey,
  expectedPre,
  expectedPost,
  mutateAtomically
}): Promise<SettlementResultV1>
```

算法：

```text
assert no active hold
create prepared intent with bounded pre/post evidence
under business lock verify expectedPre / CAS
mark intent acked (Main-owned admission)
execute temp write + fsync + atomic rename + directory fsync
inspect target post-image
committed → mark intent committed and continue settlement
not-committed → mark recovered/close with failure outcome
unknown → Task interrupted + target-post-image hold
```

temp/file fsync 与 atomic rename 后必须尝试 directory fsync。仅当平台返回明确的“不支持目录 fsync”错误时，记录 capability=`unsupported`；不得静默吞掉后宣称 durable success。该情况下 intent/source 保持 open，inspection/settlement 进入 `unknown` 或 `terminal-failure`，并创建 reason=`DURABILITY_BARRIER_UNAVAILABLE` hold。Windows packaged probe 证明 durable primitive 前，所有 target-post-image 资金 action 的 `production.enabled` 必须保持 false；v1 不要求 native addon，也不得伪造等价原语。legacy `ArchiveOutboxStore` 吞 directory fsync 错误的行为不能作为平台 durability 证据。

`acked` 表示 Main 已持久准许自身进入 mutation，不表示任何 Worker ACK。

### 10.3 `observeReceipt`

收到 `commit:receipt`：

1. 验证 action/operation/task/job/intent identity；
2. 验证 receipt envelope 和 module receipt identity；
3. mark intent committed；
4. 保存 bounded receipt ref；
5. 不直接 settle Task；
6. 等待 `job:done` 和 Main settlement。

对于 target-post-image，`commit:receipt` 只是“Main 已观察到 post-image”的通知；startup recovery 仍重新读取目标文件。

### 10.4 `recoverSource`

```typescript
recoverSource(source: RecoverySourceV1): Promise<RecoveryDecision>
```

```text
resolve policy
→ inspector = InspectorRegistry.get(source.inspectorKey)
→ inspection = await inspector(source)                  // control transaction 外，只读
→ provider = source.settlementKey ? SettlementRecoveryProviderRegistry.get(source.settlementKey) : null
→ RecoveryControlRepository.runInControlTransaction(tx =>
     tx.appendObservationEvent(inspection-completed)
     + 同一 inspection 立即决定的 Task/Batch/Intent/Hold transitions)
→ committed:
     若需 provider：先在短事务内 append settlement-resumed + begin-recovery transitions
     recover settlement through provider                // control transaction 外，必须幂等
     在新的短事务内原子提交 provider outcome transitions/events
     completed → close source / Task recovery success
     incomplete → keep source open / Task interrupted
     transient-failure → atomically increment provider failure; threshold creates SETTLEMENT_PROVIDER_UNAVAILABLE hold
     terminal-failure → immediately create hold / Task interrupted
→ not-committed:
     interrupted → running(recovery) → failed; atomically close the applicable Task/Batch/Intent and append events
→ partially-committed:
     hold / Task interrupted / module-specific recovery action
→ compensated:
     close / Task recovery failure + compensated metadata
→ unknown:
     hold / Task interrupted
```

Publisher journal source可以在没有 Critical Intent 的情况下进入该流程。

`not-committed` 必须走 `interrupted → running(recovery) → failed`，RecoveryControl command union 不扩到 cancelled。startup/transport-loss recovery 不得写 cancelled；`cancelled` 仅限 live execution 在进入 critical/protected 之前，由既有 normal TaskLifecycle 路径完成。

同一 conflict scope 的多个 source 必须串行。若已有 active hold 且发现不同 source，不创建第二个 hold、不覆盖 primary hold，也不视为已解决；仍以既有 `inspection-completed`（transient 时对应既有 transient observation）记录真实 sourceKind/sourceRef，关联 existing holdId，并在 bounded safePayload 写 `disposition=blocked-by-active-scope-hold`。新 source 的 intent/journal/provider open state 保持 open；primary hold resolve 后必须重新枚举与 inspect，禁止随 primary hold 一并收口，也不新增 observation event 或表。

不得跨 `await inspector()` 或 `await provider.recover()` 持有 SQLite control transaction。一个 inspection 结果直接引发多个控制对象变化时，inspection observation 与这些即时 transition 必须放在同一个 `runInControlTransaction()` 中；provider 返回后的多对象收口同样使用一个新的事务作用域。

## 11. Startup Recovery Coordinator

### 11.1 启动顺序

必须在会清理/补偿持久状态的 Service constructor 之前执行：

```text
Main DB init → 构造并注册全部 inspectors/providers → freeze
scan platform open intents + provider open sources + active holds
load active Recovery Holds
load open Critical Intents
call every provider.listOpenSources()，枚举 open publisher journals / existing settlement sources
Startup Coordinator MUST scan open publisher journals through registered `SettlementRecoveryProvider` instances even when no Critical Intent or active Recovery Hold exists.
normalize and deduplicate RecoverySourceV1 by (sourceKind, sourceRef)
inspect/recover sources under recovery admission
persist each observation and its immediate control transitions through one runInControlTransaction scope
之后才允许 `initializeArchiveCenter()` 或任何已有 owner recovery/cleanup 消费证据
```

Registry provider registration 必须与有副作用的模块 initialize 分离：构造 provider 仅注册函数与只读枚举能力，不得打开业务 consumer、运行 cleanup 或 mutation。freeze 与全量 source/hold scan 完成后才可初始化这些 owner。

这关闭：

- Publisher journal prepared 后、创建 hold 前崩溃；
- target rename 后、回读/Task settle 前崩溃；
- active hold 存在但对应 intent/journal 未重新扫描。

Duplicate 等模块不得先构造 Service 再 inspect。

### 11.2 Source normalization 与去重

- open intent 转为 `critical-intent` 或 `target-post-image` source；
- provider 返回 `publisher-journal` / `existing-protocol` / `module-recovery` source；
- active hold 先恢复 conflict gate；非 `manual` hold 必须通过 intent/provider 重新取得并校验原 RecoverySource，不能从 safe summary 猜造 source；
- `manual` hold 不进入 InspectorRegistry，保持 active，直到显式人工 resolution；
- 相同 `(sourceKind, sourceRef)` 只运行一次 inspector；
- source identity 与 policy actionKey/operationKey/taskRunId 冲突时直接 `unknown + hold`。

### 11.3 并发

- recovery 使用 priority=`recovery`；
- 同 conflict scope 串行；
- 不同 scope 可有界并行，但默认 1；
- inspector 必须 read-only；
- recovery settlement 如需 mutation，使用模块专用 recovery lock；
- UI 可启动，但核心 source scan 完成前冲突 action 显示 recovering/blocked。

### 11.4 失败退避

Inspector/provider transient error：

- 不立即改为 unknown；
- Inspector 失败通过 `runInControlTransaction(tx => tx.appendObservationEvent(...))` 写 `inspection-failed-transient`；Provider 失败写 `settlement-failed-transient`；
- 分别执行 bounded exponential backoff；
- Inspector 达到阈值后，在同一新事务作用域中追加最后一次 observation，并通过 `transitionWithRecoveryEvent()` 创建 hold reason=`INSPECTOR_UNAVAILABLE`、完成必要的 Task/Batch interruption；
- Provider 达到阈值后执行同样的原子收口，但 hold reason=`SETTLEMENT_PROVIDER_UNAVAILABLE`；
- 不自动清理 intent、journal 或 hold。

## 12. Lifecycle Mapper

### 12.1 API

```typescript
interface LifecycleMapper {
  settleAfterExecution(input: {
    taskRunId: string;
    batchIds: string[];
    policy: ActionPolicyV1;
    execution: ExecutionResultV1;
    recoverySource?: RecoverySourceV1;
    commitInspection?: RecoveryInspectionResultV1;
    artifactSettlement?: ArtifactSettlementResultV1;
  }): Promise<BusinessOutcomeV1>;
}
```

### 12.2 BusinessOutcome

```javascript
{
  taskStatus: 'succeeded' | 'failed' | 'cancelled' | 'interrupted',
  batchStatus: 'succeeded' | 'failed' | 'cancelled' | 'interrupted' | null,
  rendererStatus: 'succeeded' | 'succeeded-with-errors' | 'failed' |
                  'cancelled' | 'recovering' | 'recovery-required',
  code: null | 'COMMIT_STATE_UNKNOWN' | 'PARTIAL_COMMIT' | '...',
  retryAllowed: false,
  recoveryRequired: false,
  holdId: null,
  safeMessage: '',
  metadata: {}
}
```

### 12.3 Mapping algorithm

```text
if commit.kind == none:
  execution completed → settlement result
  execution failed/cancelled → failed/cancelled
else:
  derive RecoverySourceV1 from intent/provider/existing adapter
  derive commitState from receipt/inspector/journal/post-image
  committed + settlement complete → succeeded
  not-committed + cancelled → cancelled（仅限 live execution 在进入 critical/protected 前，由 normal TaskLifecycle 完成）
  not-committed + failed → failed
  unknown/partial → interrupted + hold
  committed + settlement incomplete → interrupted or recover settlement
```

上述 cancelled 映射不适用于 startup/transport-loss recovery；后者必须遵循 §10.5 的 `interrupted → running(recovery) → failed`，不得写 cancelled。LifecycleMapper 不得把恢复上下文中的 `not-committed` 解释为取消。

### 12.4 TaskLifecycle adapter

Repository 必须冻结完整邻接表：

```text
prepared → running | failed | cancelled | interrupted
running → succeeded | failed | cancelled | interrupted
interrupted → running(recovery=true, recoveryAttemptId)
running(recovery) → succeeded | failed | interrupted
```

禁止直接 `interrupted → succeeded/failed/cancelled`。API：

```javascript
await taskLifecycle.settleInterrupted({
  actionKey,
  operationKey,
  sourceKind,
  sourceRef,
  failureCode,
  failureMessage,
  metadataPatch
});

await taskLifecycle.beginRecovery({
  actionKey,
  recoveryAttemptId,
  sourceKind,
  sourceRef,
  metadataPatch
});

await taskLifecycle.settleRecovery({
  actionKey,
  recoveryAttemptId,
  toStatus: 'succeeded' | 'failed' | 'interrupted',
  failureCode,
  failureMessage,
  metadataPatch
});
```

`toStatus='succeeded'` 时 API 必须拒绝 `failureCode/failureMessage`，只接收 metadataPatch；`failed/interrupted` 时两项 failure 字段必填。Adapter 只把这些字段转换为上面的判别式 command，不读取 safePayload 推导 patch。

每次状态转换必须与 recovery event 在同一 Main-owned 控制数据库事务中提交。Batch overlay effective 映射固定为：

```text
interrupted → interrupted
recovering → recovering
state=resolved, finalOutcome=succeeded → succeeded
state=resolved, finalOutcome=failed → failed
```

必须保留原 interrupted 时间、原因和全部 recovery events。

## 13. Recovery Hold Gate

所有 mutation handler 在业务锁之前或同一原子 gate 中执行：

```javascript
assertNoRecoveryHold({
  actionKey,
  conflictScopeKey
});
```

推荐顺序：

```text
prepare user input/FilePlan
→ resolve conflict scope
→ check hold
→ acquire business lock
→ re-check hold
→ acquire resource lease
→ execute
```

二次检查防止 prepare/lock 之间新建 hold。

Legacy handler 也必须调用同一 gate。Feature flag 不得跳过。

## 14. Transport adapters

### 14.1 Worker thread

- Main 决定绝对 entry path；
- packaged/as ar path 可解析；
- Worker entry 校验 init envelope；
- resourceLimits 只由 policy；
- error/exit/message 映射协议；
- close/terminate 幂等。

### 14.2 Utility process

- Electron runtime 使用 `utilityProcess.fork`；
- test fallback 只由 adapter配置；
- process slot 和 RSS 独立计数；
- `existing-critical-protocol` 可映射 Position 的 grant/commit/cancel；
- 不强制把现有 process 改成 thread。

### 14.3 Inline async

```javascript
runInlineAsync({ signal, payload, reportProgress })
```

- 必须使用异步 API；
- 不能调用已知大型同步 XLSX/DatabaseSync loop；
- 可占 I/O slot；
- 同样产生 ExecutionResult；
- timeout 通过 AbortSignal；
- 不伪造 workerInstanceId 为 OS 线程，可使用 adapter instance id。

### 14.4 Existing dispatch

Adapter 接口：

```typescript
interface ExistingDispatchAdapter {
  inspectTopology(request): CompoundResourceRequest;
  start(request, emit): ExistingHandle;
  cancel(handle, reason): Promise<CancelResult>;
  close(handle): Promise<void>;
}
```

要求：

- 不额外 spawn wrapper Worker；
- 不复制内部 pool；
- 旧 dispatcher resolve/reject 只映射一次；
- old progress/error 先转换为 v1；
- 业务事务和 cancel 边界不变；
- topology 纳入 compound lease。

## 15. Staging / Artifact

### 15.1 Technical manifest

```javascript
{
  contractVersion: 1,
  artifactKey,
  generationPath,
  fileName,
  byteSize,
  sha256,
  validationVersion,
  sourceEvidenceDigest,
  metadata: {}
}
```

### 15.2 Common validator

```text
FilePlan ownership
absolute resolved path
inside staging root
lstat regular file
reject symlink/reparse escape
size/hash
artifactKey uniqueness
expected artifact set/order
source/target snapshot
```

### 15.3 Part / ready / sealed

- `.part`：未完成，不可消费；
- `.ready`：单文件原子完成，可由 consumer 验证；
- `sealed`：临时 SQLite 等多文件/sidecar 产物已关闭并完整验证。

Route DB seal：

```text
commit
checkpoint/delete WAL as contract requires
close all connections
verify no unexpected -wal/-shm/-journal
fsync DB
fsync directory
integrity_check
record size/hash/schema/user_version
publish sealed manifest
```

## 16. App Quit

### 16.1 Coordinator

```text
stop accepting new jobs
cancel queued admission
invalidate waiting-user tokens per policy
close idle services
request cooperative cancel for safe compute
wait protected jobs bounded time
persist interrupted/intent/hold for unresolved protected jobs
flush platform DB
return shutdown report
```

### 16.2 Shutdown report

```javascript
{
  closedServices: [],
  cancelledJobs: [],
  protectedJobs: [],
  interruptedTasks: [],
  activeHolds: [],
  leakedTransports: [],
  errors: []
}
```

应用退出不能因为任意 Worker 未响应而无限等待；超时后必须保留恢复证据，而不是写 cancelled。

## 17. Platform Canary

### 17.1 Canary actions

以下八个 `platform:*` 名称只是 test scenario labels，不是 Action Manifest/Policy Registry 的 `actionKey`。正式 actionKey 只有纯计算 `background-execution:pure-compute-canary` 与 E02-C2 durable recovery `background-execution:canary`；scenario label 不得进入生产 Registry。

```text
platform:inline-async-canary
platform:thread-single-canary
platform:thread-pool-canary
platform:utility-process-canary
platform:service-canary
platform:main-settlement-canary
platform:worker-durable-canary
platform:existing-critical-canary
```

不从 Renderer 暴露，不处理真实业务数据。

### 17.2 Worker-durable canary

使用测试表：

```sql
CREATE TABLE background_execution_canary_receipts (
  operation_key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  committed_at TEXT NOT NULL
);
```

事务：

```text
BEGIN
write canary value
write receipt same table/transaction
COMMIT
fault injection kill before commit:receipt event
```

Inspector 按 operationKey 查询：

- row存在且 value/evidence一致 → committed；
- 不存在 → not-committed；
- 多行/损坏/冲突 → unknown。

### 17.3 Main-settlement canary

必须分别覆盖两条路径：

#### A. `publisher-journal`

Worker 写 staging；Main 验证并通过测试 Publisher 落位。注入：

- journal prepared 后、Recovery Hold 创建前 crash；
- generation 完成前 crash；
- manifest tamper；
- target replace 后回包前 crash；
- startup provider 枚举 open journal 并恢复。

验证：policy `criticalIntent=false`，没有伪造 intent；`SettlementRecoveryProvider.listOpenSources()` 可独立发现 open journal。

#### B. `target-post-image`

Main 创建 Main-owned intent，执行 temp/fsync/rename/fsync，再回读目标。注入：

- prepared 后 crash；
- acked 后、rename 前 crash；
- rename 后、回读前 crash；
- post-image 既非 pre 也非 expected post。

验证：policy `criticalIntent=true`；无 Worker critical handshake；startup open-intent scan 可得到 committed/not-committed/unknown。

## 18. Action Probe 实施

### 18.1 报告模板

```markdown
## <actionKey>
- Current owner:
- Current commit points:
- Existing persistent evidence:
- Missing identity/evidence:
- Proposed operationKey placement:
- Proposed receipt transaction:
- Inspector algorithm:
- Conflict scope:
- Fault windows:
- Schema impact:
- Disposition: managed / legacy-preserved / blocked
- Required human review:
```

### 18.2 VCC OP

Probe：

- run repository schema；
- saveRun transaction；
- 是否可加 operation_key unique；
- 同事务 receipt；
- duplicate operationKey handling；
- old runs compatibility。

### 18.3 PreFund

Probe：

- dataset_id / producer_task_run_id / version；
- old batch reused on noop；
- replacement preserves batch.id；
- receipt outcome per fileIndex；
- partial success parent mapping。

### 18.4 Duplicate

Probe：

- constructor startup side effects；
- mirror/store current evidence；
- inspector before compensation；
- operation receipt for import/run；
- stale/expired distinction。

### 18.5 BankBU

Probe：

- side run schema；
- main mirror schema；
- operation_key / side_run_id placement；
- partial side-only recovery；
- historical compatibility。

### 18.6 Statement

Probe：

- prepare/import/interaction current Task boundary；
- pending context size；
- token count/TTL；
- business lock during waiting；
- balance seed write format and atomicity；
- pre/post hash inspector。

### 18.7 ReconFix JPM

Probe：

- ADM reader id availability；
- malformed JSON behavior；
- no-op frequency；
- writeAdmMatchFlags transaction；
- operation marker placement；
- pre/post digest。

## 19. Mechanical Doc Alignment

E00-F 脚本/检查应完成：

- Registry `operation:` 字段迁为 `actionKey:`；
- envelope `type:` 迁为 `operation:`；
- existing-transport mode 拆为 mode + adapterKind；
- camel event names 迁为 namespaced；
- commit policy 名称统一；
- coverage `duplicate operationKey` 改 `duplicate actionKey`；
- `recovery-required` 从 Task status 移到 Renderer outcome；
- v3.2.3 内容按 version split迁到 v3.2.4/v3.2.5。

文档 lint 应扫描废弃词并在非“迁移表/兼容 adapter”上下文中失败。

## 20. 测试设计

### 20.1 Schema / Registry

- valid policies per mode/lifetime/commit；
- invalid fifth mode；
- existing-dispatch missing adapterKey；
- native missing entryKey；
- thread-pool missing workUnits/failure policy；
- service missing service policy；
- worker-durable missing intent/receipt/inspector/scope；
- blocked production enabled；
- action property key mismatch；
- duplicate actionKey。

### 20.2 Protocol

- all operations direction；
- exact keys；
- version mismatch；
- seq duplicate/backward；
- request/grant/reject 的 requestId、controlId、jobRef 连续性；
- grant/adopted/adopt-ack 的 grantId、reservationId、owner revision 连续性；
- release/release-ack 只能引用已采用 reservation；
- replacement reservation 原子采用前不得释放旧 reservation；
- job/action/operationKey mismatch；
- old service generation；
- oversized payload；
- invalid context；
- late unit/job events；
- commit receipt before ack；
- job done before required units complete。

### 20.3 Governor

- base/persistent/pending/phase/compound；
- cross-module budget；
- low memory；
- queue cancel/timeout/aging；
- atomic replace success/failure；
- spawn failure release；
- duplicate release；
- service crash release；
- token expiry release；
- existing nested topology。

### 20.4 Intent / Hold

- state transitions；
- duplicate operation unique；
- ACK send failure；
- COMMIT after kill；
- inspector outcomes；
- unknown hold；
- conflict gate managed/legacy；
- hold resolution；
- retention only closed；
- corrupted evidence；
- startup scan order before Service constructor；
- publisher journal prepared 且无 intent/hold 时仍被 provider 枚举；
- target-post-image Main-owned intent 的 pre/post/unknown；
- RecoverySourceV1 Schema 五类 source、intentId 条件与无 Intent inspector 调用。

### 20.5 Lifecycle

- every table row in lifecycle mapping；
- protected cancel；
- committed/result lost；
- Publisher unknown；
- partial commit；
- compensated；
- interrupted recovery to success/failure；
- Renderer no retry。

### 20.6 Windows

- SQLite migration；
- partial index fallback；
- fsync/rename；
- Worker/utility paths；
- app quit；
- startup recovery；
- DB busy/file lock；
- no residual process/thread。

## 21. PR 顺序与版本别名

本节 workstream 与 v3.2.0 代码 PR 是同一实现，不得重复建设：`E00-A=E02-A`、`E00-B=E02-B`、`E00-C=E02-C1`、`E00-D=E02-C2`。E00 名称用于合同评审，E02 名称用于产品版本合并记录。



### E00-A — Contract / Policy / Protocol

- constants；
- schema validator；
- action manifest/coverage skeleton；
- protocol v1；
- canary no-mutation paths。

### E00-B — ResourceGovernor

- queue；
- lease types；
- atomic replace；
- compound topology；
- leak diagnostics。

### E00-C — Lifecycle

- interrupted persistence；
- lifecycle mapper；
- Renderer recovery DTO；
- Batch mapping。

### E00-D — Critical Recovery

- DB migration；
- repositories；
- coordinator；
- startup scan；
- hold gate；
- worker-durable canary。

### E00-E — Probes

- module evidence reports；
- schema proposals；
- blockers/dispositions。

### E00-F — Docs / Version split

- mechanical alignment；
- v3.2.3 scope reduction；
- v3.2.4/v3.2.5 skeleton；
- release gate。

## 22. 回滚与 Migration

### 22.1 Schema migration

- additive tables/indexes；
- contract_version 列；
- migration in transaction；
- failure leaves old app usable；
- active intent/hold 不做 destructive down migration。

### 22.2 Code rollback

若回滚到不理解 v1 intent 的版本：

- 启动前检测 active intents/holds；
- 阻止不安全 downgrade，或要求先由兼容 recovery tool关闭；
- 不允许旧版本忽略平台表继续 mutation。

### 22.3 Feature flags

可以关闭新 action admission，但：

- startup recovery 始终运行；
- hold gate 始终运行；
- active intents 始终可检查；
- 不能通过 flag关闭安全合同。

## 23. Performance

E00 不追求业务吞吐提升，但平台开销需基准：

- Registry lookup；
- admission no-wait；
- protocol encode/validate；
- intent create/transition；
- lifecycle settle；
- canary worker spawn；
- startup scan 0/10/100 intents。

门禁建议：

- inline-async 小 action平台固定开销中位数可解释且不超过产品可接受阈值；
-无 active intent 启动扫描不造成明显启动回退；
- 100 closed intents scan 走索引；
- metrics/log 不包含敏感数据。

具体毫秒阈值由同机 benchmark 决定，不在文档中拍脑袋写死。

## 24. Implementation Notes 契约

每个 E00 PR 记录：

- Decisions；
- Assumptions；
- Deviations；
- Evidence；
- Remaining unknowns；
- Schema migration id；
- Windows result；
- Security/privacy review；
- 哪些 action 仍 blocked。

任何公共字段变化必须先更新 Platform Contract 和 JSON Schema，再修改代码/模块文档。

## 25. 资金与审计门禁

⚠️ 以下必须人工复核：

- operationKey 与业务 Task 的唯一关联；
- intent/receipt 分工；
- Task interrupted 与 hold；
- BankBU side/main、Duplicate compensation、JPM ADM、VCC saveRun、PreFund noop；
- unknown 不自动重试；
- legacy path 不绕过 hold；
- Publisher committed 与 archive/Task success 的区分；
- recovery event 保留完整审计轨迹。
