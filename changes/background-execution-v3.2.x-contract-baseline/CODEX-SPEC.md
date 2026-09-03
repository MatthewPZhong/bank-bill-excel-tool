# Codex Spec — v3.2.x 后台执行平台实施基线

> Contract Authority v1 revision 1：独立、非生成机器权威为 `changes/background-execution/recovery-contract-authority.v1.json`；binding=`c217253cea4ccc377f030ff5119191a98e8e9c965853c9d9419fdedef9eef0ba`，TaskPolicy inventory=`9538102480f1a714f3839547f294fbe6fd1c19384734addd89dc0ca6e1dbb368`，result KAT=`1ced39a559f93c787da4d520e37dc0a4513c27dd9b60a4c229509e741b5ec039`。本 PR 是该 authority 首次引入，固定 `genesis=true`、`approvalStatus=PENDING_HUMAN_REVIEW`；repo gate 只从 merge-base 读取 previous，base 无该文件时才接受 revision 1 genesis。`genesis` 属于受控 payload；合并后完整 authority 不变可保留 genesis rev1，same-revision flip 必须失败。此 v1 authority 只承诺 `contractVersion=1` 内 revision 精确 +1；未来 v2 需独立 versioned authority 与人工 redline，不由本合同自动推导。机器技术 PASS 不改变人工红线 `PENDING_HUMAN_REVIEW`，也不表示 merge-ready 或 production enablement。

> Genesis evidence gate：即使显式传入 `--authority-mode genesis`，Git worktree 也必须先解析声明的 merge-base；只要 previous authority 已存在就稳定拒绝 `AUTHORITY_GENESIS_PREVIOUS_EXISTS`。所有 Git subprocess 清除 inherited `GIT_*` repository/object/config 控制并设置 `GIT_NO_REPLACE_OBJECTS=1`，再把 Git 返回的 toplevel、gitDir、commonDir、HEAD OID 与物理 `.git` marker/ref 逐项核对；linked worktree 允许 gitDir 与 commonDir 不同，但两者都必须 exact 记录。仅 detached/index-only 的非 Git 副本可降级运行，但报告必须标为 `detached-genesis-non-merge-evidence`、`mergeEvidence=false`，不得冒充 merge evidence。

> Validation report provenance gate：包内 published `validation-report.json` 只允许 repo/default 模式生成；`--no-write-report` 必须把所选 report target 的 complete normalized authority provenance、canonical generation command 与 exact input hashes 同本次实际 authority 解析结果逐项 exact 比较。repo、external、detached、base/merge-base、HEAD/Git physical identity 或 external resolved path/size/SHA-256 任一不同都必须 fail closed；external/detached 正向证据只能写入包外临时 report 后以相同 provenance 复验，不得复用 published repo report。

| 项目 | 内容 |
| --- | --- |
| 状态 | Implementation Ready at documentation/contract level |
| 当前 Codex 工作项 | v3.2.0 E02-A → E02-B → E02-C1 → E02-C2 |
| 后续版本 | v3.2.0～v3.2.5 的 action 接入按各版本 Spec 独立执行 |
| 生产启用 | 所有 mutation / Publisher / 自动恢复 action 继续独立门禁 |
| 对外业务 IPC | 不变 |
| 资金口径 | 金额、币种、方向、账期、去重、顺序、事务和输出格式不变 |

## 1. Codex 执行目标

在不改动业务行为的前提下，实现一层 Main-owned 的后台执行平台，使 Electron 主进程能够统一管理：

- `inline-async`；
- `thread-single`；
- `thread-pool`；
- `utility-process`；
- 长驻 Service Worker 的资源申请、状态采用和关闭；
- Execution job 的 exactly-once terminal；
- TaskRun/Batch 的 interrupted/recovery 映射；
- Critical Intent、Recovery Hold、Inspector、Settlement Provider 和启动恢复。

当前 Codex 工作项只实现公共平台和 canary，不迁移具体资金业务 action，不打开任何新的生产 mutation feature flag。

## 2. 唯一规范来源与优先级

Codex 开始修改前必须读取以下文件，按顺序解决冲突：

1. `changes/background-execution/platform-contract-v1.schema.json`
2. `changes/background-execution/platform-protocol-v1.schema.json`
3. `changes/background-execution/platform-recovery-source-v1.schema.json`
4. `changes/background-execution/platform-contract-v1.md`
5. `changes/background-execution/platform-lifecycle-mapping.md`
6. `changes/background-execution/E00-platform-contract-v1-techdoc.md`
7. `changes/background-execution/E00-platform-contract-v1-spec.md`
8. `changes/3.2.0/spec.md` 与 `changes/3.2.0/techdoc.md`

规则：

- 机器可读 Schema 对字段、枚举和条件约束具有最高优先级；
- Platform Contract 对语义具有最高优先级；
- 版本文档不得重新定义公共类型；
- 若源码事实与文档冲突，停止对应实现，记录证据并先修订 Spec/TechDoc；不得自行猜测。

## 3. 必须保持的不变量

### 3.1 控制面

Main 继续唯一负责：

- Renderer/IPC；
- 文件对话框；
- 业务锁；
- FilePlan；
- TaskLifecycle；
- Publisher；
- archive/artifact settle；
- 用户可见最终状态。

Worker/utility process 不得自行创建 TaskRun、弹窗、绕过业务锁、直接宣布成功或在未知提交后自动重跑。

### 3.2 数据与顺序

- 不跨线程传递 `DatabaseSync`、Workbook、service 实例、函数或百万行对象；
- 大型中间结果使用任务 staging、临时 SQLite 或模块 spool；
- SQLite 保持单写者；
- 文件完成顺序不得替代输入顺序；
- 共享候选消费、first-match-wins 和原地字段演化不得拆并行；
- 正式目标只能由已登记的 Publisher/settlement 路径落位。
- Protocol context 保留 exact-5/7 的 `operationKey` 并与 envelope 相等；Job payload 使用 operation-specific 精确外层 wrapper；
- 两类 seq 都精确 `last + 1`，`job:done` 受 registered unit gate 约束；
- Service reply seq 由发送方自身 direction tracker 递增，不复制对向 seq；controlId/requestId/grantId/reservationId 仅用于 exchange 关联；
- 每个 policy 的 command/event 完整 UTF-8 JSON ceiling 固定 262144 bytes，业务 body 仍由对应 entry/result/error/receipt validator 负责；
- Worker Service 只动态请求三维 resourceVector，Main 补零载体维度；requestKind/owner/current reservation replacement 矩阵 fail closed；
- compound 的唯一 root 是 `resources.base`，children 数量与其他持久 reservation 分开计账且不双算。

### 3.3 不确定提交

- `job:done` 不是 Task success；
- Worker exit 不能证明事务 rollback；
- `unknown`、`partially-committed` 或 committed-but-unsettled 必须落 TaskRun `interrupted`；
- 不得自动重跑；
- active Recovery Hold 必须阻断 managed 与 legacy 冲突 mutation。

## 4. 唯一身份模型

| 字段 | 含义 | 生命周期 |
| --- | --- | --- |
| `actionKey` | 静态 action 注册身份 | 跨版本稳定 |
| `operation` | Protocol command/event | 单消息 |
| `operationKey` | 业务幂等与跨重启恢复身份 | 跨 job、跨重启 |
| `jobId` | 单次 transport attempt | 单 attempt |
| `unitId` | job 内工作单元 | 单 job |
| `workerInstanceId` | 执行器实例 | 实例生命周期 |
| `serviceKey` | 长驻服务静态身份 | 跨实例稳定 |
| `controlId` | Service control request | 单 control exchange |
| `serviceGeneration` | Service 实例代次 | crash/restart 后递增 |

`actionKey != operationKey != jobId`。Registry/coverage 使用 `actionKey`，恢复使用 `operationKey`，transport 路由使用 `jobId`。

## 5. Commit 与恢复唯一映射

| commit policy | receiptKind | Critical Intent | RecoverySourceV1.sourceKind | 证据不足时 |
| --- | --- | --- | --- | --- |
| `none` | `null` | false | 无 | 不适用 |
| `worker-durable` | `module-local` | true，Worker critical handshake | `critical-intent` | blocked |
| `main-settlement` | `target-post-image` | true，Main-owned；无 Worker handshake | `target-post-image` | blocked |
| `main-settlement` | `publisher-journal` | false | `publisher-journal` | blocked |
| `existing-critical-protocol` | `existing-protocol` | false | `existing-protocol` | blocked；不得临时创建平台 Intent |

模块启动恢复若不属于上述 commit policy，可使用 `module-recovery`。`manual` 只属于 Recovery Hold，不是 `RecoverySourceV1`。

InspectorRegistry 是唯一判定权威。SettlementRecoveryProvider 只能：

- `listOpenSources()`；
- 在 inspection 已给出后 `recover()`。

Provider 不得实现 `inspect()`。
`recover(source, inspection)` 必须按 `(sourceKind, sourceRef, operationKey)` 幂等；inspection evidence hash 只参与 CAS/审计，不产生新的 mutation identity。crash 后重复调用不得重复 publish、generation 或业务 mutation。

## 6. 当前 Codex 必做范围

### E02-A：Policy、Protocol、Supervisor 与 Transport

交付：

- Schema 驱动的 Policy Registry；
- Job Envelope 与 Service Control Envelope validator；
- `inline-async`、worker thread、utility process、existing dispatcher adapter；
- Supervisor job/unit routing；
- per-sender monotonic `seq`；
- exactly-once execution terminal；
- error codec 复用现有 `serialize-error.js`；
- late message、duplicate terminal、unexpected exit、timeout、cancel 的测试；
- platform canary action，生产不触碰业务数据。

### E02-B：ResourceGovernor

交付：

- `BaseLease`；
- `PersistentReservation`；
- `PendingInteractionReservation`；
- `PhaseLease`；
- `CompoundLease`；
- admission queue、FIFO/aging、queue cancel；
- tentative `resource:grant`；
- `resource:adopted → resource:adopt-ack`；
- `resource:release → resource:release-ack`；
- atomic reservation replace；
- service crash/close 的 exactly-once 释放；
- existing nested executor 的 compound accounting。

ResourceGovernor 只存在于 Main。Worker 只能通过 Service Control Protocol 请求资源。

### E02-C1：TaskLifecycle 与 Batch recovery overlay

交付：

- 保留 TaskRun 当前基础状态：`prepared/running/succeeded/failed/cancelled/interrupted`；
- 邻接表：
  - `prepared → running | failed | cancelled | interrupted`；
  - `running → succeeded | failed | cancelled | interrupted`；
  - `interrupted → running(recovery) → succeeded | failed | interrupted`；
- 禁止直接 `interrupted → succeeded/failed`；
- RecoveryControlRepository 只接管中断与恢复相关 TaskRun 边；常规 `prepared → running` 和非恢复执行终态继续由既有 TaskLifecycle/ArchiveRepository 管理；
- Batch 采用 Option B：基础 `task_status` 继续兼容写 `failed`，新增 overlay 计算 effective `interrupted/recovering/resolved`；
- append-only recovery events 为 MUST；
- TaskRun 的恢复相关状态迁移，以及 Batch overlay、Recovery Hold、Critical Intent 的每次状态迁移，与对应 append-only recovery event **必须在同一个 Main-owned control DB transaction 内提交**。禁止使用异步补写、消息顺序、重试或任何事务外排序机制替代原子事务。
- `RecoveryControlRepository` 顶层只公开 `runInControlTransaction()`；状态 mutation 只能调用 transaction object 的 `transitionWithRecoveryEvent()`，纯观察事件只能调用同一对象的 `appendObservationEvent()`。
- 无状态迁移的 `inspection-completed / inspection-failed-transient / settlement-resumed / settlement-failed-transient` 只能通过同一事务作用域内的 `RecoveryControlTransactionV1.appendObservationEvent()` 追加；该方法不得修改任何控制状态，写入事件的 `previous_state / next_state` 必须均为 `NULL`。sourceKind 不允许 `manual`。
- 一次恢复动作更新多个控制对象时，Main 必须只调用一次 `RecoveryControlRepository.runInControlTransaction()`，并在同一个 `RecoveryControlTransactionV1` 上完成全部 transition 与 observation event；事务作用域内方法不得独立 BEGIN、COMMIT 或 ROLLBACK。
- transition event type 必须由 E00 `RECOVERY_TRANSITION_EVENT_MAP_V1` 推导；Batch overlay 只允许 `absent → interrupted → recovering → resolved`，禁止同态 upsert/跳跃/改写 resolved。
- 四个 Batch overlay command 必须 exact 携带 canonical actionKey、legacy expectedTaskKey、operationKey、batchId、taskRunId 与 source pair；`mark-interrupted` 额外显式携带 bounded failureCode/failureMessage。adapter 必须注入生产 `ActionTaskBindingRegistry` 并只接受其 60 条 exact binding；factory 不接受 caller map，只调用一次 frozen exact plain `{ list }` host 并持有 descriptor-safe owned snapshot/private Sets，`allowedTaskKeys()` 返回新 frozen copy。public digest/count/version 只从独立 contract-authority anchor 读取；Main 对真实 registry module 的 exact CommonJS `require` 必须是除 directive 外第一个 Program.body statement，不允许任何前置可执行 statement、side effect 或 helper wrapper；CI 从 byte 0 执行到该 statement 结束的完整源码前缀，并 fresh-load exact target、核对 request 与真实 export identity。Main binding freeze 必须在 DB/IPC invocation 之前，失败时二者调用数为 0。Map、prototype replacement、hostile message accessor 均 fail closed 且不泄露 cause。Action Manifest v3 只是带独立 provenance 的审计 snapshot。source map JCS digest 固定 `c217253cea4ccc377f030ff5119191a98e8e9c965853c9d9419fdedef9eef0ba`，sorted 122-key inventory digest 固定 `9538102480f1a714f3839547f294fbe6fd1c19384734addd89dc0ca6e1dbb368`；hidden/accessor/Proxy、后改、等数量替换、bound 缺失、duplicate 与 taskKey/channel mismatch 均 fail closed。Repository 同事务 CAS Task/Batch identity，event 不得从 legacy key 或 payload 猜 actionKey。
- `platform-recovery-control-v1.schema.json` 是 transition/observation event input、全部 Task/Batch/CriticalIntent/Hold branch 与两个 immutable result DTO 的 exact runtime 权威；所有入口未知 key fail closed。
- persistent request owner 首次生成并保存 stable eventId/createdAt、完整 request_jcs 与 request_hash；20 个 requestKey branch 按 fixture 的 namespace + durable entity/attempt tuple 重算，排除 volatile leaf；重启/startup/Hold 重扫按 durable requestKey 复用，changed exact request 同 key conflict。owner/event 的 requestKey/writer/eventId/requestHash/createdAt 必须由 composite FK 强制相等。
- 四类 observation 在 owner reserve 前必须先按 durable scope 原子持久 `observationAttemptId` 正安全整数；同 scope + ordinal 跨重启复用同一 requestKey/result，只有下一 ordinal 才能追加新 event。attempt/event 以 `(observationScopeKey, observationAttemptId, requestKey)` composite FK 强制相等，瞬态阈值的最后一次也必须是独立可审计 attempt。
- recovery request/event hash 固定 RFC 8785/JCS UTF-8 + lowercase `[0-9a-f]{64}` SHA-256；raw 入口拒绝 nested duplicate key 与超出 ±(2^53-1) 的整数，覆盖完整 writer-specific exact envelope，在任何 state CAS 前判 exact replay 或 conflict，且公共输入不得接受 requestHash。
- replay result 严格是 immutable persisted 20-field event projection：transition/observation DTO 分别固定 writer/event domain，transition 的 `observationAttemptId` 为 null，observation 为正安全整数且固定 null previous/next 与非 manual source，cross-DTO 拒绝；projection 必须从 exact request + 同次 CAS persisted values 逐字段构造，并逐字段匹配独立 versioned 20-result KAT（JCS digest `1ced39a559f93c787da4d520e37dc0a4513c27dd9b60a4c229509e741b5ec039`）。400 field + 60 owner mutants 必须经 mapper→实际 SQLite DDL→immutable SELECT→KAT，不能 candidate 自比。A 提交、B 推进、重启后 replay A 仍返回首次 A，不二次 CAS/event、不返回 current state 或 replay flag。
- Batch 物理 identity 固定 `archive_batches.id === batchId`，overlay 才使用 `overlay.batch_id`；Task/Batch identity join、CAS 和每个写 statement 都要求完整 predicate 与 `changes() === 1`。
- `batch-overlay.mark-interrupted` 必须同事务写基础兼容 `task_status=failed`、overlay interrupted 和 event；恢复成功只改变 overlay effective status，不改写基础 interruption 历史。

### E02-C2：Recovery Contract

交付：

- Main-owned 主控制库中的 Critical Intent Store；
- Critical Intent 邻接表固定为 `prepared → acked → committed → closed`、`prepared → recovered → closed`、`acked → recovered → closed`，拒绝 `committed → recovered`；
- generic Recovery Hold；
- InspectorRegistry；
- SettlementRecoveryProviderRegistry；
- `RecoverySourceV1` Schema validator/normalizer；
- Startup Recovery Coordinator；
- conflict scope gate 同时约束新平台和 legacy mutation；
- `worker-durable` critical handshake；
- Main-owned target-post-image settlement；
- Recovery result exact keys 由 RecoverySource Schema `$defs` 单点冻结；identity/hash/UTF-8 byte mismatch fail closed，registry freeze 后拒绝注册；startup source/hold scan 完成后才允许 owner initialize/cleanup；
- TaskRun recovery command 同时 CAS canonical actionKey binding、legacy expectedTaskKey、operationKey、taskRunId 与 nullable source pair；safePayload/metadataPatch 为 16384-byte canonical plain JSON object；
- Batch overlay recovery command 同时 CAS canonical actionKey binding、legacy expectedTaskKey、operationKey、batchId、taskRunId 与 source pair；
- eventId 幂等以持久完整 exact request hash 为唯一重启安全判据；transition/observation writer 分域，hash 覆盖 eventId、createdAt、safePayload 和全部 request 字段；
- publisher journal / existing protocol / module recovery provider enumeration；
- Task interrupted/recovery lifecycle 接线；
- fault injection：COMMIT/rename/journal prepared 后回包前崩溃。

## 7. 明确不做

当前工作项不得：

- 迁移 Statement、FundRecon、Duplicate、BankBU、ReconFix 等业务模块；
- 修改金额、币种、SQL、去重键、输出文件或 IPC；
- 让新 thread pool 默认使用多个 Worker；完整 Governor 上线前有效并行度固定 1；
- 删除 legacy path；
- 让 existing dispatcher 外再包一层 Worker；
- 为 `existing-critical-protocol` 临时创建平台 Critical Intent；
- 让 Provider 和 Inspector 各自判定一次；
- 把 `manual` Hold 发送到 InspectorRegistry；
- 在 recovery unknown 时自动重放。

## 8. Codex 变更纪律

1. 先读取现有代码与测试，再创建文件；
2. 优先复用仓库现有 database facade、TaskLifecycle、error serializer、Worker dispatch 风格；
3. 每个 PR 只实现一个 E02 阶段；
4. 不做无关重命名、格式化或目录迁移；
5. 所有新 public/internal interface 必须有单测；
6. Schema、JSDoc/TypeScript shape、fixture 和文档同步修改；
7. 遇到资金口径、事务边界或当前代码与文档不一致时停止并报告，不自行修正业务；
8. 实现阶段发现需要改变 Contract v1 时，先修改合同和 validator，再修改源码。

## 9. 完成标准

公共平台只有满足以下条件才算完成：

- Policy、Protocol、RecoverySource、RecoveryControl 四份 Schema meta-validation 通过；
- Registry fixture、静态引用和 action manifest 全部通过；
- Service request/grant/adopt/release 完整序列测试通过；
- Supervisor exactly-once terminal 与 late event 测试通过；
- Governor 所有失败路径无 lease/reservation 泄漏；
- TaskRun 邻接表和 Batch overlay 与当前持久结构兼容；
- RecoveryControl 外层事务可原子组合多个控制对象，任一写入失败时状态与全部 events 一起回滚；
- observation-only event 不修改状态、前后状态均为 `NULL`，且 validator 负向自测能拒绝伪造 transition 和缺失外层事务入口；
- command → eventType 映射、Batch exact identity、persistent owner + request-hash replay/conflict、Batch overlay 邻接和 Hold create-or-get stable eventId/createdAt 均有机器门禁；
- `RecoverySourceV1` 只有一套字段；
- Provider 无 `inspect()`；
- Startup scan 覆盖 open intents、provider open sources 和 active holds；
- manual hold 只恢复 gate，不进入自动 inspection；
- unknown/partial 不自动重跑；
- platform canary 完成正常、取消、COMMIT 后 crash、unknown hold 与启动恢复；
- Windows packaged canary 通过；
- Codex 入口文档的 Protocol 摘要、sequence scope、Renderer 状态与原子性规则通过 `codex-input-contract-drift` 机器检查；
- 恢复事务入口、transaction-scoped writer、observation event、command→event 映射、Batch exact identity、request-hash replay、审计血缘、TaskRun/Batch/Critical Intent 边界通过 `recovery-control-transaction-contract-drift` 及其 mutation negative self-tests；
- `changes/background-execution/validation/run-validation.sh` PASS；
- 仓库既有 unit/integration/release-check 全部通过。

## 10. Action 生产启用门禁

公共平台实现完成不等于资金 action 可以生产启用。以下至少保持 `production.enabled=false`，直到各自版本门禁完成：

- VCC OP `saveRun`；
- PreFund Writer；
- Duplicate import/run mutation；
- BankBU import/run；
- Statement manual balance seed；
- ReconFix JPM ADM writeback；
- 任何无法唯一判断 commit 的 action。

每个 action 需要独立：operation receipt/identity、Inspector、故障注入、Windows、golden/数据库对照与人工资金复核。
