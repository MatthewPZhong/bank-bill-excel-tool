# Background Execution E02-C1 RecoveryControl Implementation Notes

> 规范权威仍是冻结合同包 `changes/background-execution-v3.2.x-contract-baseline/`。
> 本文件只记录实现决策、证据与剩余未知，不修改或覆盖合同 authority、report、fixture 与 checksum。

## Goal / Context / Constraints / Done when

- Goal：实现 E02-C1 RecoveryControl writer 第一阶段：TaskRun 恢复边、Batch Option B overlay、四类 observation event、持久 request owner/attempt、跨重启 replay/conflict 与只读查询。
- Context：基于 E02-A/E02-B 已有平台和 production `action-task-binding-registry`；与既有 ArchiveRepository/TaskLifecycle 共用 Main control SQLite。
- Constraints：不实现 Prepared Intent、Recovery Hold、Inspector/Provider、Coordinator/startup scan、ServiceHost/ResourceGovernor、业务 action 迁移、产品 enablement/Main wiring、版本 bump；完整 RecoveryControl Schema 可加载，但 C2 branch 必须稳定 fail closed，且不得建立 C2 表。
- Done when：13 个 C1 branch 的 exact request/SQL/result 与冻结 KAT 一致；唯一事务 writer、lookup-before-CAS、`changes() === 1`、多对象回滚、Task/Batch 完整 identity、bounded canonical lineage、重启 replay/conflict、Archive 兼容均有直接证据。

## Unknowns Register

| 分级 | 未知 | 事实证据与裁决 | 状态 |
| --- | --- | --- | --- |
| BLOCK | 是否需要在 C1 实现 Intent/Hold 或 startup scan | E02-C1/C2 阶段表和父任务明确将它们分配给 C2 | Closed：C2 request 只返回 `RECOVERY_CONTROL_BRANCH_NOT_IMPLEMENTED`，无 C2 表或部分写 |
| PROBE | Main control DB 的 migration/transaction API 与 Task/Batch 物理 identity | `ensureArchiveMetadataSupport()`、`archive_task_runs`、`archive_batches.id`、冻结 TechDoc §8.4/§9.2.1 | Closed：additive migration 进入同一 DB；真实 SQLite identity join/CAS 测试通过 |
| PROBE | requestKey、JCS/hash、20-field result 的机器权威 | 冻结 Schema 与 valid fixture 的 requestKey/KAT contract | Closed：runtime Schema 逐字节相同，9 transition + 4 observation 真实 DDL/KAT 通过 |
| PROBE | Action↔legacy Task binding 的生产 owner | 已有 `action-task-binding-registry` 是冻结 production authority | Closed：adapter 只调用注入 registry 的 `assertPair()`，mismatch 在 owner/CAS 前拒绝 |
| ASSUME | C1 尚未接产品 Main/Coordinator 时，repositories/adapters 的组装位置 | 阶段明确禁止产品 enablement/Main wiring；barrel export 供后续 Main-owned composition 使用 | 保守：不新增 IPC/Renderer/业务入口，C2 或 action migration PR 再接线 |
| BLOCK | 资金/恢复红线人工复核 | 自动测试不能代签 action/task/operation 血缘、幂等 owner、Batch 基础失败历史与回滚语义 | Open for merge/production：见“人工复核项”，不阻塞本地实现与自动验证 |

## Decisions

| 项目 | 决定 | 合同对应与影响 |
| --- | --- | --- |
| Runtime contract | 将冻结 `platform-recovery-control-v1.schema.json` 逐字节放入 runtime；入口统一 exact Schema validation，raw JSON 在 parse 前拒绝 nested duplicate key 与 unsafe integer | 不从 `changes/` 读取运行时合同；C2 union 仍可验证后稳定返回 branch-not-implemented |
| Canonical evidence | 使用 RFC 8785/JCS UTF-8、lowercase SHA-256；拒绝 Proxy/accessor/toJSON/sparse/cycle/invalid surrogate/unsafe integer；safePayload/metadataPatch 以 16384 bytes 为界 | request JCS/hash 覆盖完整 writer-specific envelope；公共输入不接受 request hash |
| Migration | 只建 Batch overlay、observation attempts、request owners、recovery events 及权威 indexes/FKs；由 Archive schema migration 在同一 Main DB 中 additive/idempotent 建立 | 不建 Intent/Hold 表；嵌套启动 migration 使用 savepoint，不拆数据库事务域 |
| Stable owner/attempt | owner 与 observation attempt 在 control transaction 外各用短 `BEGIN IMMEDIATE` 持久 prepared；owner 首次生成 stable eventId/createdAt/JCS/hash，重启复用 | writer 失败保留 prepared 供重放；实际 state/event/owner committed 仍在一个 `runInControlTransaction()` 内完成 |
| Unique writer | `RecoveryControlRepository` 顶层只公开 `runInControlTransaction()`；transaction object 只公开 `transitionWithRecoveryEvent()` / `appendObservationEvent()`，同步、不可嵌套、关闭后不可复用 | 每个 mutation 紧跟 `changes() === 1`；任一步/COMMIT 失败整体 rollback |
| Task/Batch | Task 只接管中断/恢复边，保持 legacy taskKey；Batch 使用 exact parent Task join，mark-interrupted 同事务把基础状态写 failed 并建 overlay，恢复成功只 resolve overlay | 保持旧 Archive/TaskLifecycle 正常路径；基础 failed 是 interruption 历史，effective status 由 overlay 覆盖 |
| Replay/result | 每次先查 owner；committed replay 直接从 immutable event row 返回 exact 20-field projection，不读取当前 Task/Batch；changed request 或 eventId owner 冲突 fail closed | A→B→restart→A 不二次 CAS/event，不添加 replay/current-state 字段 |
| Read API | C1 只暴露合同内 `getEffectiveBatchStatus()` 与 `listRecoveryEvents()`；repository 构造不建表、不迁移 | 保持纯只读；cursor 使用持久 event sequence，结果附带 sequenceId 与 event projection 血缘 |
| Binding | Task/Batch adapter 消费生产 `ActionTaskBindingRegistry.assertPair()`，不接受 caller binding map | canonical actionKey 只来自已验证 command；legacy taskKey/operation/taskRun/batch identity 在同事务 CAS |
| Poisoned transaction | scoped writer 首次异常会永久 poison 当前 control transaction；callback 即使捕获后正常返回，COMMIT 前仍重抛同一个首错并整体 rollback；后续 scoped 调用稳定拒绝 | 防止调用方误吞 event/owner/attempt/CAS 异常后提交先前 state；outer transaction 外创建的 prepared owner/attempt 按合同保留供重启重放 |
| Task recovery interrupt post-image | `interrupt-recovery` 强制把持久 active fields 写为 `recoveryMode=false`、`recoveryAttemptId=null`，但 immutable event 继续保存被中断 attempt ID；正常 `mark-interrupted` 的 metadata CAS 不允许绕过 active recovery owner | attempt1 中断后（含关闭/重开 DB）可由严格 begin CAS 建立 attempt2，旧 attempt lineage 不被改写 |
| Archive permanent delete | ArchiveRepository 的手工删除与 retention 共用事务先检查 Batch overlay；interrupted/recovering 返回结构化 `recovery-active`，resolved 则先显式删除 overlay 再删父 Batch | 冻结 DDL 不增加 cascade；append-only recovery events/request owners 不参与删除，父 Batch 删除后仍保留审计血缘 |

## Deviations

无行为性偏离。实现未修改冻结合同包；未新增 C2 数据表、状态写或产品 wiring。

实施期 blindspot pass 曾发现 Task recovery mode 被初稿写成字符串 `"recovery"`，与权威生命周期的 `recovery=true` 及 fixture patch 不符；在全量门禁前已统一为布尔 `true`，并补充每个 Task branch 的真实持久 post-image 断言。该问题未进入最终实现。

## Evidence

| 检查 | 结果 | 覆盖 |
| --- | --- | --- |
| Schema byte equality | PASS | runtime Schema 与冻结 authority 逐字节相同 |
| E02-C1 targeted unit | 27/27 PASS | 13 branch、迁移幂等/纯只读、KAT、owner/attempt、replay/conflict、eventId conflict、回滚、Option B、raw/Schema 负例、C2 fail closed、唯一 writer、binding、legacy 兼容 |
| 文件 SQLite integration | 27/27 PASS | Task+Batch 三阶段同事务、关闭/重开数据库 replay、基础 failed/effective succeeded、冲突、prepared owner 与回滚、event lineage/FK |
| Archive/TaskLifecycle/binding adjacent unit | 115/115 PASS | 旧 Archive 与 TaskLifecycle owner、production binding/startup seam、E02-C1 targeted 回归 |
| Targeted ESLint | PASS | 全部新增/修改的 C1 JS 与测试 |
| Full lint / smoke | PASS / PASS | 全仓静态检查与 smoke 回归 |
| Full unit | `5870/5871 PASS`，0 fail，1 个既有平台 skip | 362 个 unit 文件；新 C1 suite 由 runner 自动发现 |
| Full integration | 50/50 scripts、`2446/2446 PASS` | 新 C1 文件 SQLite 脚本 `27/27 PASS`；runner 机械同步 `rules/integration-test-policy.md` |
| Release check | PASS | 最终 lint、smoke、`5870/5871` unit、50/50 scripts 与 `2446/2446` integration 全链通过 |

### Review Round 1 closure evidence

| Reviewer finding | 结果 | 直接 probe |
| --- | --- | --- |
| P1 transaction poison | PASS | 后续 Batch identity 失败、真实 recovery event INSERT trigger、owner committed UPDATE trigger、observation attempt committed UPDATE trigger 均由 callback 捕获并正常返回；outer API 仍重抛同一首错，后续 scoped 调用返回 `RECOVERY_CONTROL_TRANSACTION_POISONED`，Task/overlay/event 全回滚，outer transaction 外的 owner/attempt 保持 prepared |
| P1 interrupt-recovery post-image | PASS | attempt1 begin→普通 mark 绕过被拒→interrupt 强制清 active fields→关闭/重开 SQLite→attempt2 begin 成功；4 条 immutable event 分别保留 attempt1/attempt2 lineage，旧 interrupt replay 不增 event |
| P2 Archive 删除兼容 | PASS | 真实 ArchiveService 手工强删与 `cleanupExpired()` 共用路径：active overlay 均返回 `ARCHIVE_BATCH_RECOVERY_ACTIVE` 且父 Batch 保留；resolved 后 retention 删除父 Batch并显式删除 overlay，3 条 event 与 3 条 committed owner 保留，`PRAGMA foreign_key_check` 为空 |
| Round 1 targeted/adjacent | PASS | RecoveryControl `31/31`；ArchiveRepository `17/17`；ArchiveService `64/64`；本轮触及文件 ESLint PASS |

### 失败与复跑记录

- 首轮 targeted unit 曾有 1 个断言失败：SQLite row 是 null-prototype object，而期望是普通 object；生产行为无误，测试改为字段投影后 `25/25 PASS`。
- 补持久 post-image 时，`task-begin-recovery` 断言暴露实现把权威 `recovery=true` 写成字符串 `"recovery"`；生产实现与测试均修为布尔 `true` 后 targeted unit `27/27 PASS`、integration `27/27 PASS`，随后所有 full gates 与 release-check 一次通过。
- Review Round 1 新增 Archive 删除 probe 首跑失败：测试仅预留 Batch、未建立 RecoveryControl 权威要求的 Batch↔TaskRun physical join；补真实 `beginTaskRun()` 后该 probe 与完整 ArchiveService suite 均通过，生产实现无需为缺失 join 放宽。

## Blindspot / Reconciliation Review

- 入口：只有 adapter 经 production binding reserve owner，再进入唯一 control transaction；repository 内部仍按 Task/Batch persisted identity fail closed。
- 状态：Task 无 `interrupted → terminal` 直跳；Batch overlay 只允许 absent→interrupted→recovering→resolved，resolved 不改写。
- 幂等：durable requestKey 排除 volatile leaf；完整 exact request hash 包含 eventId/createdAt/safe payload；committed replay 先于 state lookup/CAS。
- 原子性：Task/Batch state、event、owner committed（observation 另含 attempt committed）由同一 outer transaction 提交；注入失败测试证明无部分 event/state。
- 血缘：event 固定记录 canonical actionKey、operationKey、taskRunId、source pair、Batch/attempt identity；safe payload/result 都经 bounded canonical validation。
- 兼容：Archive normal lifecycle 与 legacy recovery path 不写 recovery event；Batch 基础 failed 历史不因 overlay success 被覆盖。
- 可观测：conflict、identity/state/CAS、owner/event/attempt 异常都有稳定 error code；append-only event 支持 task cursor 扫描。

## 资金/恢复红线人工复核项

自动测试只提供证据，不能代签以下结论：

1. 抽样核对真实 actionKey ↔ expectedTaskKey ↔ operationKey ↔ taskRunId/Batch 的业务所有权与审计含义。
2. 核对 requestKey durable scope 是否符合实际恢复动作“一次”的业务边界，changed payload conflict 是否符合运营重试预期。
3. 核对 Batch “基础 `failed` 保留中断历史、overlay 提供 effective succeeded/failed”对所有现有报表/查询的解释是否可接受。
4. 人工审阅 state/event/owner/attempt 同事务、FK 与 rollback 证据，确认不存在可绕过的生产 writer。
5. 人工检查 safePayload/metadataPatch 的真实调用样例，确认不包含账号、金额明细、原始行等敏感或非 bounded 数据。

## Remaining Unknowns

| 未知 | 分级/下一步 | 合并影响 |
| --- | --- | --- |
| 资金/恢复红线人工结论 | BLOCK：由熟悉 Archive/资金恢复语义的 reviewer 按上表签核 | 阻塞 merge/production enablement；自动测试不能关闭 |
| C2 Coordinator/startup scan 如何消费 prepared owner/attempt | PROBE：C2 按同一冻结合同组装，不在 C1 预埋 partial tables/writes | 不阻塞 C1；阻塞真实 startup recovery enablement |
| Windows packaged Main control DB 重启行为 | PROBE：产品接线后在 packaged Windows 做断点/重启演练 | 不阻塞未接线的 C1 persistence layer；阻塞 production enablement |

## Rollback / Compatibility

- Migration 仅 additive 建表/index，不改旧 Archive 列或旧状态值；代码回滚后这些空闲表可保留，不影响旧读写路径。
- E02-C1 尚未发布且不做历史回填；不提供 destructive down migration。若需物理删除表，必须在独立维护变更中先确认无 event/owner 数据并人工批准。
- 旧 ArchiveRepository/TaskLifecycle 继续负责正常生命周期；本 PR 不迁移真实资金 action，也不改变 IPC/Renderer 行为。
