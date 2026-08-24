# E00 Spec — Platform Contract v1 冻结、生命周期映射与持久恢复底座

> Contract Authority v1 revision 1：独立、非生成机器权威为 `changes/background-execution/recovery-contract-authority.v1.json`；binding=`c217253cea4ccc377f030ff5119191a98e8e9c965853c9d9419fdedef9eef0ba`，TaskPolicy inventory=`9538102480f1a714f3839547f294fbe6fd1c19384734addd89dc0ca6e1dbb368`，result KAT=`1ced39a559f93c787da4d520e37dc0a4513c27dd9b60a4c229509e741b5ec039`。本 PR 是该 authority 首次引入，固定 `genesis=true`、`approvalStatus=PENDING_HUMAN_REVIEW`；repo gate 只从 merge-base 读取 previous，base 无该文件时才接受 revision 1 genesis。`genesis` 属于受控 payload；合并后完整 authority 不变可保留 genesis rev1，same-revision flip 必须失败。此 v1 authority 只承诺 `contractVersion=1` 内 revision 精确 +1；未来 v2 需独立 versioned authority 与人工 redline，不由本合同自动推导。机器技术 PASS 不改变人工红线 `PENDING_HUMAN_REVIEW`，也不表示 merge-ready 或 production enablement。

> Genesis evidence gate：即使显式传入 `--authority-mode genesis`，Git worktree 也必须先解析声明的 merge-base；只要 previous authority 已存在就稳定拒绝 `AUTHORITY_GENESIS_PREVIOUS_EXISTS`。所有 Git subprocess 清除 inherited `GIT_*` repository/object/config 控制并设置 `GIT_NO_REPLACE_OBJECTS=1`，再把 Git 返回的 toplevel、gitDir、commonDir、HEAD OID 与物理 `.git` marker/ref 逐项核对；linked worktree 允许 gitDir 与 commonDir 不同，但两者都必须 exact 记录。仅 detached/index-only 的非 Git 副本可降级运行，但报告必须标为 `detached-genesis-non-merge-evidence`、`mergeEvidence=false`，不得冒充 merge evidence。

> Validation report provenance gate：包内 published `validation-report.json` 只允许 repo/default 模式生成；`--no-write-report` 必须把所选 report target 的 complete normalized authority provenance、canonical generation command 与 exact input hashes 同本次实际 authority 解析结果逐项 exact 比较。repo、external、detached、base/merge-base、HEAD/Git physical identity 或 external resolved path/size/SHA-256 任一不同都必须 fail closed；external/detached 正向证据只能写入包外临时 report 后以相同 provenance 复验，不得复用 published repo report。

| 项目 | 内容 |
| --- | --- |
| 工作流编号 | E00 |
| 产品版本 | 非独立产品版本；v3.2.0～v3.2.5 的合并前置 |
| 日期 | 2026-08-21 |
| 状态 | Implementation Ready / 生产 action 仍按独立门禁启用 |
| 设计基线 | 待实现前回填当前 merge SHA |
| 配套 TechDoc | `changes/background-execution/E00-platform-contract-v1-techdoc.md` |
| 规范合同 | `changes/background-execution/platform-contract-v1.md` |
| Policy Schema | `changes/background-execution/platform-contract-v1.schema.json` |
| Protocol Schema | `changes/background-execution/platform-protocol-v1.schema.json` |
| 生命周期映射 | `changes/background-execution/platform-lifecycle-mapping.md` |

## 0. 决策摘要

E00 是后续全部后台执行改造的强制前置，不是额外业务版本。

本工作流解决四个跨版本 P0：

1. **Policy / Protocol 命名和 schema 漂移**；
2. **ResourceGovernor 能力不足以覆盖长驻 Service、交互 token 和 existing nested pool**；
3. **Execution、Commit、TaskLifecycle、Batch、Renderer 之间缺少规范映射**；
4. **缺少跨进程崩溃可恢复的 Critical Intent Store 与 Recovery Hold**。

在 E00 完成以前：

- 可以实施纯解析、只读查询、staging 生成、业务等价 fixture 和 benchmark；
- 可以建立 Worker entry、Parser Core、spool 和 artifact validator；
- 所有新增 Worker pool 的生产有效 Worker 数固定为 1；
- 新平台不得接管 DB mutation、正式发布终态或自动 crash recovery；
- 对无法唯一证明提交状态的 action 必须保持 `blocked` 或 `legacy-preserved`。

E00 完成后，v3.2.0～v3.2.5 只引用公共合同，不再定义同义消息或状态。

## 0.1 本轮 P0 冻结结果

E00 在进入源码实施前进一步冻结：

- JobEnvelope 与 ServiceControlEnvelope 分离；
- Service 通过 `resource:request/grant/reject/release` 请求 Main-owned Governor；
- TaskRun 真实状态包含 `prepared`，恢复只允许 `interrupted → running(recovery) → terminal`；
- Batch 采用兼容方案 B，不重建表；
- Recovery Hold 支持 Critical Intent、Publisher journal、module receipt 与 existing protocol；
- Recovery event 为 append-only MUST；
- RecoveryControlRepository 顶层只提供显式 `runInControlTransaction()`，状态迁移与纯观察事件只能通过同一个 transaction object 写入；
- TaskRun recovery command exact identity 包含 canonical actionKey、legacy expectedTaskKey、operationKey、taskRunId 与 nullable-pair sourceKind/sourceRef；adapter 必须注入生产 `ActionTaskBindingRegistry` 验证真实 TaskPolicy binding。runtime pair 只来自模块私有常量，public digest/count/version 只来自独立 contract-authority；factory 不接受 caller map，真实 TaskPolicy 由 frozen exact plain host 只 `list()` 一次并复制成 descriptor-safe owned snapshot，122-key JCS digest 固定 `9538102480f1a714f3839547f294fbe6fd1c19384734addd89dc0ca6e1dbb368`。真实 registry module 的 exact CommonJS `require` 必须是 Main 除 directive 外第一个 Program.body statement；不得有前置可执行 statement/side effect/helper wrapper，CI 必须从 byte 0 执行完整 import 前缀并 fresh-load exact target 核对真实 export identity。Main binding freeze 必须早于 DB/IPC，失败时二者调用数为 0；Map/prototype replacement/hostile message accessor fail closed。Action Manifest v3 只作审计 snapshot，Repository CAS 持久 legacy keys/state，旧 task_key 不改写；
- Batch overlay command exact identity 同样包含 canonical actionKey、legacy expectedTaskKey、operationKey、batchId、taskRunId 与 source pair；adapter 验证 action binding，Repository 同事务 CAS Task/Batch identity，event 只写经验证的 canonical actionKey；
- persistent request owner 首次保存 stable requestKey/eventId/createdAt/完整 request_jcs/request_hash，重启或 Hold 重扫必须复用；20 个 branch 的 requestKey 使用 fixture 冻结的 namespace + durable entity/attempt tuple，changed request 保持同 key 并 conflict；owner/event 五项 requestKey/writer/eventId/requestHash/createdAt 由 composite UNIQUE/FK 强制相等；
- 四类 observation 在 owner reserve 前按 durable scope 原子持久正安全整数 `observationAttemptId`；同 ordinal 跨重启 exact replay，下一 ordinal 才能新增 event，attempt/event 三字段 composite FK 保证 owner 相等；
- exact request hash 正式采用 RFC 8785/JCS 与 lowercase `[0-9a-f]{64}` SHA-256，覆盖 eventId、createdAt、safePayload 与全部 transition/event leaf；先按 requestKey 加载 owner 并验证 exact request/eventId/hash/createdAt，再判 replay/conflict 或执行 state CAS，且不接受 caller requestHash；
- `platform-recovery-control-v1.schema.json` 是 event inputs、每个 Task/Batch/CriticalIntent/Hold branch 与 immutable result projection 的 exact runtime 权威，未知 key fail closed；
- BoundedSafePayloadV1/metadataPatch 是 RFC 8785/JCS plain JSON object，UTF-8 最大 16384 bytes，不含完整业务行或账号；raw JSON 任意深度 duplicate key 与超出 ±(2^53-1) 的整数在转换前 fail closed；
- Batch `mark-interrupted` exact 输入显式携带 bounded failureCode/failureMessage；两个 result DTO 是 exact 20-field immutable projection并各自固定 writer/event domain，observation 还固定正安全整数 attempt、null previous/next 与非 manual source，cross-DTO 输入拒绝；20 个 full-result 独立 KAT 的 JCS digest 固定 `1ced39a559f93c787da4d520e37dc0a4513c27dd9b60a4c229509e741b5ec039`，mapper/source/CAS mutations 必须经实际 SQLite DDL/immutable SELECT 后逐字段比对，禁止 candidate 自比；
- RecoveryInspectionResultV1/SettlementRecoveryResultV1 exact keys 由 RecoverySource Schema `$defs` 单点定义；registries freeze 后拒绝注册，startup source/hold scan 完成后才初始化 owner；
- TaskRun 只将中断/恢复相关迁移纳入 RecoveryControlRepository，常规执行生命周期保持既有所有权；
- Policy Schema 对 worker-durable、artifact publisher 与 service resource control 执行值级门禁；
- Schema/Protocol/semantic/link validator 有可复跑脚本和正反 fixtures。

## 1. Task Brief

### Goal

冻结并实施一套唯一的后台执行平台合同，使以下对象具有稳定、机器可校验且跨版本一致的语义：

- action 静态身份；
- transport attempt 与业务幂等身份；
- 四种执行模式；
- job/unit/service 协议；
- 全局资源 lease；
- critical / protected / commit receipt；
- startup recovery 与 mutation hold；
- ExecutionResult 到 TaskLifecycle/Batch/Renderer 的映射；
- action-level Registry、Inventory 和 release gate。

### Context

当前 v3.2.x 方案的模块边界和财务顺序设计总体正确：

- 主进程继续负责 TaskLifecycle、FilePlan、锁、Publisher 和归档；
- Worker 只承担解析、计算和工作簿生成；
- SQLite 保持单写；
- 多 Worker 完成顺序不改变文件序、行序、候选消费或正式发布顺序。

但公共平台合同在后续版本中被逐步扩展，产生了不兼容命名和能力差异：

- Registry 中的 `operation` 有时表示 action，有时表示协议命令；
- 后续出现 `existing-transport`，与“四种正式 mode”冲突；
- `unitDone / criticalReady / committed` 与 `unit:done / critical:ready / commit:receipt` 混用；
- `main-controlled / worker-persistent / existing-protocol` 与 v3.2.0 commit policy 不一致；
- ResourceGovernor 初版只定义单次 lease，后续模块依赖 base、persistent、phase、compound 和 atomic replace；
- 文档引入 `recovery-required`、`COMMIT_STATE_UNKNOWN`、partial commit，但没有明确落库到 TaskRun/Batch 的状态；
- JPM、BankBU、Duplicate 等恢复路径需要持久 critical intent，但公共层只有 inspector 接口。

如果不先冻结合同，模块实现会出现消息不兼容、双终态、资源超配和不确定提交被误重跑。

### Constraints

- 不改变 Renderer / preload 现有业务 IPC 名称、参数和返回结构；新增内部状态由主进程适配为兼容 DTO。
- 不改变 exact-5 `operationContext` 和 exact-7 `batchContext`。
- 不把业务 SQL、金额、币种、排序、去重、Workbook 内容校验搬入平台层。
- 不把 `jobId` 用作业务幂等或提交证明。
- 不把 transport exit、terminate 或 `job:done` 直接映射为 Task 成功/失败/取消。
- 不在 inspector 返回 `unknown` 时自动重试。
- 不允许 legacy fallback 绕过 Recovery Hold。
- E00 可以新增**平台控制 schema**，但不改变业务金额、订单或对账表的口径。
- Platform Contract v1 的 Critical Intent、Recovery Hold、Batch overlay 与 recovery events **冻结存放在当前 Main-owned 主控制数据库**；v1 不允许临时切换为独立平台 DB。
- TaskRun 的恢复相关状态迁移，以及 Batch overlay、Recovery Hold、Critical Intent 的每次状态迁移，与对应 append-only recovery event **必须在同一个 Main-owned control DB transaction 内提交**。
- `inspection-completed / inspection-failed-transient / settlement-resumed / settlement-failed-transient` 是无状态迁移 observation，只能在显式 transaction scope 内追加，且不得伪造状态迁移或使用 manual hold 作为自动 source。
- 模块本地 commit receipt 仍必须与业务 mutation 位于同一业务数据库事务；Publisher journal 仍使用其既有 durable 文件/日志边界。
- 所有新表和状态迁移必须具备升级、回滚和启动恢复测试。
- E00 不实施具体模块的业务 Worker 化；只提供合同、平台组件、canary 和 action probes。

### Done when

- `platform-contract-v1.md` 经评审冻结，并成为 v3.2.x 唯一公共合同。
- Policy Registry 通过 `platform-contract-v1.schema.json` 校验；CI 额外检查 property key 与 `actionKey` 相等。
- 身份模型固定为：`actionKey / operation / operationKey / jobId / unitId / workerInstanceId / serviceGeneration`。
- mode 只允许 `inline-async / thread-single / thread-pool / utility-process`；existing dispatcher 通过 `adapterKind` 表达。
- commit policy 只允许 `none / main-settlement / worker-durable / existing-critical-protocol`。
- Protocol v1 使用唯一 namespaced operation 集；unit/job/commit/Task 终态可区分。
- ResourceGovernor 支持 BaseLease、PersistentReservation、PendingInteractionReservation、PhaseLease、CompoundLease 和 atomic replace。
- TaskLifecycle 能持久表达 `interrupted`，并按规范映射到 Renderer `recovering / recovery-required`。
- Critical Intent Store 能持久化 `prepared / acked / committed / recovered / closed`，启动时可扫描恢复。
- RecoveryControlRepository 能通过一次 `runInControlTransaction()` 原子组合多个控制对象；`transitionWithRecoveryEvent()` 与 `appendObservationEvent()` 只存在于该 transaction object 上。
- `appendObservationEvent()` 只能写四类 observation event，不能修改状态，事件 `previous_state / next_state` 均为 `NULL`，sourceKind 不含 `manual`。
- transition command 到 eventType 有唯一机器可比对映射；Batch overlay 只允许 `absent → interrupted → recovering → resolved`，Hold create-or-get 使用 persistent request owner 保存的 stable eventId/createdAt 幂等重放。
- Batch exact command 的 canonical/legacy/operation identity 与 recovery event `request_hash` 由机器门禁冻结；`archive_batches.id === batchId`，Task/Batch/overlay 写入均要求完整 predicate 与 `changes() === 1`。
- 请求 A 提交、B 推进、重启后 replay A 必须返回首次 immutable persisted event projection A，不重建 current state、不二次 CAS/event；A 任一 leaf 改变均 conflict。
- Action/task startup freeze 必须拒绝 caller binding injection、hidden/accessor/Proxy policy、post-construction mutation、等数量 inventory 替换、bound key 缺失、duplicate 与 taskKey/channel mismatch；`allowedTaskKeys()` 不得泄漏内部数组。
- Batch 首次 interrupted 的基础兼容 failed、overlay interrupted 和 event 同事务；恢复成功只改变 overlay effective status，不覆盖基础 interruption 历史。
- `SettlementRecoveryProvider` 能枚举 open publisher journals；Startup Coordinator 扫描 `open intents + open settlement sources + active holds`。
- `main-settlement + target-post-image` 使用 Main-owned intent；`main-settlement + publisher-journal` 不创建 intent。
- Recovery Hold 能按 conflict scope 阻断冲突 mutation，legacy path 不能绕过。
- 平台 canary 完成“COMMIT 后、回包前崩溃”恢复；无证据时正确进入 `interrupted + hold`。
- VCC OP、PreFund、Duplicate、BankBU、Statement、ReconFix JPM 的 receipt/inspector probe 形成书面结论和 action disposition。
- v3.2.0～v3.2.3 现有文档有机械迁移清单；v3.2.4/v3.2.5 新边界已确认。

## 2. 范围

### 2.1 必做

#### A. 规范合同

1. 冻结 Identity Model。
2. 冻结 Policy Registry v1。
3. 冻结 Protocol v1。
4. 冻结 ResourceGovernor v1。
5. 冻结 Critical Intent / Commit Receipt / Inspector v1。
6. 冻结 Lifecycle Mapping v1。
7. 冻结 Action Coverage v1。
8. 冻结 contract versioning 与兼容规则。

#### B. 平台实现

1. Policy schema validator；
2. action manifest / inventory coverage；
3. Supervisor envelope 和 protocol validator；
4. ResourceGovernor 单例、admission queue 和 lease API；
5. Critical Intent Store repository；
6. SettlementRecoveryProvider Registry 与 publisher-journal 枚举器；
7. Recovery Hold repository；
8. startup recovery coordinator（open intents + open settlement sources + active holds）；
9. TaskLifecycle `interrupted` 接线；
10. Renderer recovery DTO 适配；
11. platform canary executors；
12. fault-injection seams；
13. metrics 与隐私约束。

#### C. Action-level probes

必须取证，但不一定在 E00 完成业务实现：

- VCC OP `saveRun` 是否能新增同事务 operation receipt；
- PreFund `inserted / replaced / noop-existing-batch` 的唯一 receipt；
- Duplicate startup inspector 与 constructor compensation 的正确顺序；
- BankBU side run / main mirror 的 operation identity；
- Statement pending interaction memory、waiting-user 和 manual seed；
- ReconFix JPM ID-aware reader、no-op 与 pre/post image；
- Toolbox Route DB sealing；
- VCC Financial OP subject filter pushdown。

### 2.2 明确不做

- 不迁移 Statement、FundRecon、Duplicate、ReconFix 业务会话；
- 不实现 VCC OP、PreFund、Toolbox 等模块的完整业务 Worker；
- 不修改财务匹配规则；
- 不启用新的多 Worker 生产策略；
- 不删除 legacy dispatcher；
- 不新增用户线程数设置；
- 不提供“强制忽略 Recovery Hold”的普通 UI；
- 不把 Critical Intent Store 当作业务 commit receipt；
- 不以日志代替持久 intent/receipt；
- 不通过正则扫描 IPC 文本作为唯一 action coverage。

## 3. 规范身份与术语

| 名称 | 唯一含义 | 稳定范围 | 禁止用途 |
| --- | --- | --- | --- |
| `actionKey` | 静态 action 注册身份 | 跨版本稳定 | 不能包含运行时月份/路径 |
| `operation` | 协议命令/事件 | 单条消息 | 不能作为 Registry 主键 |
| `operationKey` | 业务幂等/恢复身份 | 跨 job、跨重启 | 不能每次 retry 随机生成 |
| `jobId` | transport attempt | 一次 attempt | 不能作为 receipt 唯一键 |
| `unitId` | parent job 的工作单元 | 单 job | 不能用完成顺序决定业务顺序 |
| `workerInstanceId` | Worker/process 实例 | 实例生命周期 | 不能恢复业务提交 |
| `serviceGeneration` | 长驻 Service 代次 | Service 生命周期 | 不能替代 operationKey |
| `taskRunId` | TaskLifecycle 身份 | 业务 Task | 不能单独证明哪个 mutation 已提交 |

必须机械替换：

```text
Registry operation                  → actionKey
Protocol type                       → operation
existing-transport mode             → actual mode + adapterKind
unitDone / unitError                → unit:done / unit:error
criticalReady / criticalAck         → critical:ready / critical:ack
committed event                     → commit:receipt
main-controlled                     → main-settlement
worker-persistent                   → worker-durable
existing-protocol                   → existing-critical-protocol
coverage duplicate operationKey     → duplicate actionKey
```

## 4. Policy Registry 产品规格

### 4.1 每个 action 的最小信息

```javascript
{
  actionKey,
  moduleId,
  disposition,
  mode,
  adapterKind,
  adapterKey,
  entryKey,
  lifetime,
  context,
  protocolLimits,
  workUnits,
  resources,
  cancellation,
  failure,
  commit,
  result,
  artifacts,
  service,
  metrics,
  featureFlag,
  legacyStrategyKey,
  blocker,
  production
}
```

### 4.2 Disposition

- `managed`；
- `legacy-preserved`；
- `inline-excluded`；
- `blocked`。

任何 action 未登记时，release-check 失败。

### 4.3 Production snapshot

Capability 与实际启用必须分开：

```javascript
production: {
  enabled,
  effectiveMode,
  effectiveWorkerCount,
  recoveryStatus,
  evidenceStatus,
  downgradeReason,
  benchmarkEvidenceId
}
```

有 pool 能力但生产固定 single，不得在发布说明中写“已多核并行”。

## 5. Protocol v1 产品规格

### 5.1 唯一 operation 集

Main → Executor：

```text
executor:init
job:start
unit:start
job:cancel
unit:cancel
critical:ack
critical:reject
executor:close
```

Executor → Main：

```text
executor:ready
job:progress
unit:progress
unit:done
unit:error
critical:ready
commit:receipt
job:done
job:error
cancel:ack
executor:close-ack
```

### 5.2 用户可见要求

- late/duplicate event 不得产生第二次弹窗或第二 Task 终态；
- `job:done` 后仍在 Publisher/归档时，UI 继续显示“正在发布/结算”；
- protected action 收到取消时显示不可取消或正在等待提交终态，不得显示“已取消”；
- `unknown` 显示“需要恢复”，并禁止重试按钮；
- 旧 Renderer 忽略新增 progress 字段时仍能完成任务。

### 5.3 机器协议门禁

- exact-5/7 保留真实 `operationKey` 并要求等于 envelope operationKey；只禁止 transport/resource/intent 与额外字段，`none` 必须为空；
- 每个 Job operation 使用 Schema 冻结的单字段外层 wrapper；result 经 policy validator 后进入唯一 `ExecutionResultV1.result`；
- Job 与 Service seq 首条为 1，之后精确 `last + 1`；
- Service command/event direction 各自独立计数；reply seq 取自身 direction 的下一值，不 echo 对向 seq，exchange 只按 control/resource identity 关联；
- `job:done` 要求所有 registered unit 为 policy 允许终态且无 unknown unit；`job:error` 可早停并内部清理其余 unit；
- 每个 action 的 command/event 完整 UTF-8 JSON 上限统一为 262144 bytes；
- Service resource request 的 requestKind/owner/replacement 矩阵由 Schema 与 stateful validator 共同拒绝 stale replacement。

## 6. ResourceGovernor 产品规格

### 6.1 全局资源

应用级统一管理：

```text
CPU slots
Worker thread slots
Utility process slots
I/O-heavy slots
Memory reservations
```

同一时刻不同模块不得各自独立使用 `CPU-2`。

### 6.2 Lease

- BaseLease：长驻 transport 和基础 RSS；
- PersistentReservation：正式采用的 Service state；
- PendingInteractionReservation：等待用户的重型 token context；
- PhaseLease：当前执行阶段；
- CompoundLease：内部已有 pool / 多角色执行图。

### 6.3 交互规则

- 排队可取消；
- 低内存可排队、降级 single 或拒绝；
- active job 不动态改变 Worker 数；
- Service idle 释放 CPU/I/O，但保留 base；
- persistent state 替换必须原子；
- lease 在 spawn failure、late error、cancel、close、app quit 等所有路径 exactly-once 释放。

### 6.4 过渡规则

完整 compound accounting 合并前，所有新增多 Worker action：

```text
effectiveWorkerCount = 1
```

已有成熟 pool 保持旧策略，但必须在 Inventory 标记“尚未纳入全局 compound accounting”，不得宣称全局治理已覆盖。

## 7. Lifecycle 产品规格

### 7.1 TaskRun 状态

持久状态只使用：

```text
prepared / running / succeeded / failed / cancelled / interrupted
```

正常邻接表冻结为：

```text
prepared → running | failed | cancelled | interrupted
running  → succeeded | failed | cancelled | interrupted
interrupted → running(recovery) → succeeded | failed | interrupted
```

RecoveryControlRepository 只接管 `prepared/running → interrupted`、`interrupted → running(recovery)` 和 `running(recovery) → succeeded/failed/interrupted`。常规 `prepared → running` 与非恢复执行终态继续由既有 TaskLifecycle/ArchiveRepository 管理。

TaskRun 的恢复相关状态迁移，以及 Batch overlay、Recovery Hold、Critical Intent 的每次状态迁移，与对应 append-only recovery event **必须在同一个 Main-owned control DB transaction 内提交**。纯观察事件通过同一 transaction object 的 `appendObservationEvent()` 写入，不得为 observation 伪造 transition。

### 7.2 Renderer 状态

```text
running / waiting-user / cancelling / succeeded /
succeeded-with-errors / failed / cancelled /
recovering / recovery-required
```

### 7.3 核心映射

- committed + settlement 完整 → succeeded；
- 明确 not-committed 的 error → failed；
- 安全取消且 not-committed → cancelled；
- unknown / partial / committed-but-result-lost → interrupted；
- interrupted 通过 recovery 可终结 succeeded 或 failed；
- recovery history 不得被覆盖删除。

## 8. Critical Intent Store 产品规格

### 8.1 Intent state

```text
prepared → acked → committed → closed
prepared → recovered → closed
acked → recovered → closed
```

禁止 `committed → recovered`。已 committed source 的 settlement 恢复结果写入 TaskRun、Batch overlay、Recovery Hold 与 recovery events，Intent 保持 `committed` 并最终 `closed`。

### 8.2 Recovery Hold

active hold 必须阻断同 `conflictScopeKey` 的 mutation，包括 legacy path。

允许：

- status；
- inspector；
-专用 recovery；
- policy 明确允许的只读 export。

禁止：

- 普通 import/run/delete/overwrite；
- 新 operationKey 绕过；
- feature flag 切回 legacy 后继续写。

### 8.3 启动体验

应用启动后：

1. 打开并迁移 Main-owned 主控制数据库；
2. 注册 Inspector 与 SettlementRecoveryProvider；
3. 扫描未 closed intent；
4. 枚举 open publisher journals / existing settlement sources；
5. 读取 active holds 并恢复 conflict gate；非 manual hold 通过对应 Intent/Provider 重新取得原 source；
6. 按 `sourceKind + sourceRef` 去重 RecoverySourceV1，并通过 InspectorRegistry 运行唯一只读判定；
7. 在 inspection 后调用 Provider 执行受控 settlement recovery；
8. 可自动恢复的显示 recovering；
9. 无法确认的显示 recovery-required；
10. 恢复完成前，对应 action 明确不可用；
11. 不影响无冲突 scope 的模块正常使用。

## 9. Action Probe 规格

### 9.1 VCC OP saveRun

必须二选一：

- run 表增加 `operation_key / task_run_id`；或
- 同事务写独立 operation receipt。

仅使用月份、金额、文件数不能判定当前 Task 的 run。

### 9.2 PreFund

分别定义：

```text
inserted
replaced
noop-existing-batch
rejected
```

`noop-existing-batch` 可以引用旧 batchId，但 receipt 必须记录本次 operationKey 和 outcome，不能冒充新 COMMIT。

### 9.3 Duplicate

启动顺序固定：

```text
startup intent scan
→ independent read-only inspector
→ persist inspection
→ compensation/expiration
→ construct Service
```

### 9.4 BankBU

side run 和 main mirror 必须共享 operation identity；main mirror 必须能定位 sideRunId。

### 9.5 Statement

- token 返回前申请 pending interaction memory；
- 有数量上限和 TTL；
- waiting-user 释放 CPU/I/O 和业务锁，保留 memory reservation；
- continuation 重新获取锁并验证 evidence；
- manual seed 使用 temp + fsync + rename + pre/post hash + inspector；
- `target-post-image` policy 必须 `criticalIntent=true`，由 Main-owned intent 保存 expected pre/post；不走 Worker critical handshake。

### 9.6 ReconFix JPM

- pre==post 时明确 `noop`，不进入 critical；
- reader 必须返回 DB id 且坏 JSON hard fail；
- id sequence/count/digest 全部核对；
- mutation 与 operation marker/receipt 同事务。

### 9.7 Toolbox Route DB

sealed 条件至少包括：

```text
COMMIT
close all connections
no WAL/SHM/journal sidecar
fsync DB and directory
integrity_check
size/hash evidence
```

### 9.8 VCC Financial OP

双 Writer 前必须将 subject filter 下推，不能每个 Worker 读取全量主体。

## 10. 验收标准

### AC-01：唯一术语

仓库文档和平台代码中，不再使用废弃公共术语；兼容 adapter 内可出现旧模块消息，但必须在边界转换。

### AC-02：Schema

- Registry JSON 通过 schema；
- action property key 与 `actionKey` 相等；
- mode 不含 `existing-transport`；
- worker-durable 缺 inspector/receipt/intent 时拒绝启动；
- blocked action production.enabled 必须 false。

### AC-03：Protocol

- unit/job/commit 终态不混淆；
- seq、jobId、workerInstanceId、generation 校验；
- duplicate/late event不二次 settle；
- payload size 和 privacy gate。

### AC-04：ResourceGovernor

- base/persistent/pending/phase/compound 全部可申请和释放；
- atomic replace 失败时旧 reservation 保留；
- existing nested executor 不额外 spawn；
- 跨模块并发不能超出全局预算；
- 所有 failure path 无 lease 泄漏。

### AC-05：Lifecycle

- unknown/partial 映射 interrupted；
- protected terminate 不映射 cancelled；
- committed + recovered settlement 可终结 succeeded；
- interrupted 记录可由启动恢复器读取；
- Renderer recovery-required 无 retry。

### AC-06：Critical Intent 与 Settlement Recovery

- prepared/acked/committed/recovered/closed 状态可恢复；
- Worker durable ACK 前持久 acked；Main-owned target-post-image 在原子替换前持久 acked；
- COMMIT/rename 后回包丢失可调用 inspector；
- Publisher journal prepared 后即使尚未创建 Hold，启动扫描也能由 Provider 枚举；
- Startup Coordinator 覆盖 open intents、open settlement sources 与 active holds；
- unknown 创建 hold；
- hold 阻断 managed 和 legacy mutation；
- close/retention 不删除 active 证据。

### AC-07：Canary

平台 canary覆盖：

- main-settlement 正常/失败；
- worker-durable 正常；
- COMMIT 后 kill；
- inspector committed/not-committed/unknown；
- partial settlement；
- Publisher journal recovery；
- app quit protected task。

### AC-08：Action probes

每个 probe 形成：

```text
current evidence
missing evidence
proposed schema/receipt
inspector algorithm
blocker status
implementation owner
review version
```

### AC-09：Windows packaged

Setup/portable 下验证：

- intent/recovery schema migration；
- Worker/utility process canary；
- app quit；
- SQLite file lock；
- fsync/rename；
- startup recovery；
- 无残留线程/进程。

## 11. 测试与发布门禁

### P0 自动化

- Policy schema 正反例；
- manifest/inventory/handler coverage；
- protocol validator 全 operation；
- Supervisor exactly-once；
- ResourceGovernor 并发、排队、atomic replace、compound；
- TaskLifecycle interrupted；
- RecoveryControl 外层事务、多对象原子回滚、observation-only event、Batch exact identity 与持久 request-hash eventId 幂等冲突；
- Critical Intent Store CRUD/状态转换，并拒绝 `committed → recovered`；
- Recovery Hold conflict；
- startup scan；
- canary fault matrix；
- app quit；
- schema migration/rollback；
- privacy / payload bounds。

### P0 人工

- 检查全部公共术语和字段；
- 检查 Task/Batch/Renderer 映射；
- 检查 recovery-required UI 和冲突操作阻断；
- Windows Setup/portable recovery；
- 对 VCC/PreFund/BankBU/Duplicate/JPM probes 做资金与审计确认。

### P1

- 多个 recovery hold 并存；
- inspector 连续失败和退避；
- intent retention/cleanup；
- 系统时钟变化；
- disk full/DB busy；
- corrupted intent/evidence JSON；
- action manifest AST 构建性能。

## 11.1 合同 Gate 与源码 PR 映射

E00-A～F 是规范 acceptance 编号；平台源码只在 v3.2.0 的 E02 系列 PR 中实现一次，不得分别以 E00 与 E02 名义重复建设。

| E00 gate | 唯一源码实现 PR |
| --- | --- |
| E00-A Policy / Protocol | v3.2.0 E02-A |
| E00-B ResourceGovernor / Service resource control | v3.2.0 E02-B |
| E00-C Lifecycle / Batch overlay / mandatory recovery events | v3.2.0 E02-C1 |
| E00-D Critical Intent / SettlementRecoveryProvider / generic Recovery Hold / startup scan | v3.2.0 E02-C2 |
| E00-E Action probes | 各 action 所属版本 P0 PR |
| E00-F 文档对齐与 validator | 本文档包 |

同一组件不得分别以 E00 和 E02 名义重复交付。

## 12. PR 拆分与 v3.2.0 别名

E00 是合同/门禁工作流；平台代码实际随 v3.2.0 合并。以下编号是同一组 PR 的两个视图，不得重复实现：

| E00 workstream | v3.2.0 code PR alias | 交付 |
| --- | --- | --- |
| E00-A | E02-A | Contract、Policy/Protocol schema、Supervisor/adapters |
| E00-B | E02-B | 完整 ResourceGovernor、Service control/resource grant |
| E00-C | E02-C1 | TaskLifecycle prepared/interrupted/recovery、Batch overlay、mandatory events |
| E00-D | E02-C2 | Critical Intent、SettlementRecoveryProvider、generic Recovery Hold、startup recovery |
| E00-E | E01/E03 probes | VCC/PreFund/Duplicate/BankBU/Statement/JPM 证据与 blockers |
| E00-F | 文档交付 | 机械回修 v3.2.0～v3.2.5、schema/semantic validation |

依赖：

```text
E00-A/E02-A
→ E00-B/E02-B + E00-C/E02-C1
→ E00-D/E02-C2
→ E00-E
→ E00-F
```

合并记录必须只出现一次代码实现 PR；E00 与版本文档互相引用同一 commit/evidence id。

## 13. 灰度与回滚

- E00 平台表和代码先由 canary 使用；
- 未注册业务 action 不受影响；
- platform feature flag 可关闭新 admission，但不能忽略已存在 intent/hold；
- 回滚代码前必须保证新 contractVersion 的 active intent 可被旧版本安全识别；否则阻止 downgrade；
- migration 必须保留已写 intent/hold，不能 down migration 删除恢复证据；
- 新 pool 在 E00 完成前保持 Worker=1；
- legacy path继续可用，但受到 hold 检查。

## 14. Unknowns Register

| 未知 | 分类 | 当前决定 |
| --- | --- | --- |
| Platform Control Store 位置 | DECIDED | v1 固定使用当前 Main-owned 主控制数据库；独立平台 DB 需要未来合同版本与迁移方案 |
| TaskLifecycle interrupted 转换 | DECIDED | 按当前真实邻接表扩展；恢复必须 `interrupted → running(recovery) → terminal`，并写 mandatory recovery events |
| Batch interrupted 表达方式 | DECIDED | 采用 Option B：基础 task_status 保持兼容 failed，平台 overlay/view 表达 interrupted/recovering/recovered |
| operationKey 生成策略是否统一 UUID | ASSUME | 平台提供 opaque generator；模块 receipt 存相同值，不从业务字段猜测 |
| hold conflict scope 的粒度 | MODULE-PROBE | 每个 action 注册 resolver；公共层不猜月份/数据集 |
| intent retention 天数 | PROBE | closed intent 可按审计要求清理；active/unknown 永不自动清理 |
| utility process existing protocol 的映射细节 | PROBE | Position adapter 在 v3.2.5 前完成，E00 只做 canary |

## 15. 资金与审计红线

### [Critical] Intent 不能代替业务 receipt

若业务 DB 已 COMMIT、intent 表尚未更新而崩溃，只有同事务 module receipt 能证明提交。任何仅凭 intent=`acked` 宣布成功的实现禁止上线。

### [Critical] Unknown 不能自动重跑

任何 inspector 结果 `unknown` 必须写 `interrupted`、创建 Recovery Hold并阻断冲突 mutation。换 jobId、切 legacy、重启应用都不能绕过。

### [Critical] Side/Main 多阶段提交必须可定位同一 operation

BankBU、Duplicate 等两阶段写入必须共享 operation identity；只看“最新一条”或月份/金额相同不构成唯一证据。

### [Important] 等待用户的内存同样是资源

Statement 等 pending token 返回前必须持有 memory reservation。未计费大对象不能长期留在 Service Map。

### [Important] 发布完成与业务提交是独立状态

DB committed、generation ready、formal publish、archive handoff 和 Task success 必须分别记录；任何一步未知不得静默成功。
