# Implementation Notes

## Baseline

- Goal/spec: 以用户冻结源包 `background-execution-v3.2.x-codex-implementation-ready-fixed 2/` 为唯一来源建立 E00-F 合同基线，并根据 PR0 审查 finding 在独立 target 目录做可追溯修订；源包保持字节不变。
- Initial plan: 先机械复制冻结源包，再只在 target 内闭合 public Protocol、Policy、Resource、Recovery Control/Result 与启动顺序；随后同步权威文档、Codex 输入、fixtures、validator、报告与包级校验和。
- Done when:
  - 无状态迁移的检查/瞬时失败/结算恢复事件可以合法、幂等、原子地追加，且不能伪造状态迁移。
  - 一次恢复动作涉及多个控制对象时，Main 可显式开启一个外层事务，所有迁移与观察事件加入同一事务且不得各自提交。
  - `TaskRunTransitionV1` 明确只接管恢复相关迁移；常规 prepared/running/final 生命周期仍由既有 TaskLifecycle/ArchiveRepository 管理。
  - Critical Intent 状态图与命令前置状态唯一一致。
  - 校验器包含上述契约的正向检查和负向自测，并能拒绝旧/漂移写法。
  - 自包含目录包的校验、哈希与目录完整性可复现；任何未执行项及原因被显式报告。ZIP 不纳入本 PR，也不创建或提交 target ZIP。

## Unknowns Register

| 未知 | 分级 | 当前处理 | 关闭证据 |
| --- | --- | --- | --- |
| 无状态迁移的恢复审计事件是否允许独立写入 | BLOCK → 已关闭 | 允许，但只能通过事务作用域内的 `appendObservationEvent()`；事件类型白名单、`previousState/nextState = null`，禁止修改控制状态 | 平台契约、E00 TechDoc、CODEX 文档与校验器一致 |
| 多个控制对象如何共享一个 SQLite 事务 | BLOCK → 已关闭 | 增加 Main-owned `runInControlTransaction()`，回调获得 `RecoveryControlTransactionV1`；作用域内方法只加入事务，不独立 BEGIN/COMMIT | API 契约、伪代码和校验器一致 |
| RecoveryControlRepository 是否接管所有 TaskRun 状态 | BLOCK → 已关闭 | 只接管中断/恢复相关迁移；常规执行生命周期保持既有所有权 | TaskRunTransitionV1 范围条款 |
| `committed` Critical Intent 是否可转 `recovered` | BLOCK → 已关闭 | 不允许；保持 `prepared -> acked -> committed -> closed` 与 `prepared/acked -> recovered -> closed`，已 committed 的恢复结果记录在 Task/Hold/Event，不倒改 intent 语义 | 状态图与 `mark-recovered` 前置状态一致 |
| 本机能否复现锁定版本 `jsonschema==4.26.0` 的权威校验 | PROBE → 已关闭 | 在 `/private/tmp` 隔离 venv 安装锁定依赖并运行，不污染项目 | Validator `24/24 PASS`，runtime check 记录 4.26.0 |
| `archive_task_runs.task_key` 是否等于 canonical actionKey | BLOCK → 假设已纠正 | 源码证据显示它是 legacy TaskLifecycle key；command 同时携带 actionKey 与 expectedTaskKey，adapter 验证 binding，Repository 只 CAS 持久 key | E00 command union、事务说明与 mutation gate |
| Windows directory fsync 是否具备可证明 durability | PROBE → 未关闭 | 合同要求必须尝试；仅明确 unsupported 可记录 capability，失败保持 source open 并建 hold | target-post-image 资金 action production=false，等待 packaged probe |

## Decisions

| 决定 | 原因与证据 | 放弃的方案 | 影响 |
| --- | --- | --- | --- |
| 将恢复写入口拆为“仓储事务入口 + 事务作用域写方法”两层 | 既要维持单一状态写入口，又要支持一个恢复动作跨 Task/Batch/Intent/Hold 原子收口 | 顶层暴露多个可独立提交的 repository 方法 | Main 明确拥有事务边界；实现不得在作用域内隐式提交 |
| 观察事件采用封闭白名单，且状态前后值必须为 `null` | 检查完成和瞬时检查失败是事实记录，不是状态迁移 | 用同态 `state -> state` 或虚构状态迁移写审计 | 审计语义可验证，避免状态机被噪声污染 |
| 从 `mark-recovered` 移除 `committed` 前置状态 | 与既有 Critical Intent 状态图一致；committed 已表达外部副作用确认 | 新增 `committed -> recovered` 回退边 | 避免已确认事实被恢复动作重解释 |
| 闭环报告归类为 evidence，不列作 normative contract | 报告用于证明修订，不应覆盖 Spec/TechDoc/Schema 的优先级 | 继续称其为 `newNormativeFiles` | Manifest 治理语义更清晰 |
| 冻结 `RECOVERY_TRANSITION_EVENT_MAP_V1`，Batch 使用判别式 command union | transition eventType 由 Repository 推导时必须有唯一映射；原 `upsert` 类型允许同态与跳跃状态 | 让实现者自行命名 eventType，并仅在运行时检查宽泛 upsert | Validator 可逐 command 比对；Batch 只允许 `absent → interrupted → recovering → resolved` |
| Hold create-or-get 使用 source identity 派生 stable eventId | 已存在 Hold + 新 eventId 没有真实状态迁移，不能合法追加 transition event | 每次扫描都追加新的 hold-created event | 首次创建写 event；完全相同重放返回原结果，其余 fail closed |
| Recovery event 固化 action/operation/task/source 血缘，Provider recovery 固化幂等键 | Publisher journal 等 source 可能没有 Intent/Hold；只把身份放 JSON 不利于审计，provider outcome 落库前 crash 会重复调用 | 仅依赖 safe payload 和实现惯例 | 事件可按操作/source 查询；重复 recovery 不得造成二次 publish/mutation |
| Batch 首次 interruption 把基础兼容 failed、overlay interrupted 与 event 视为一个逻辑 transition | 三项分别提交会出现旧查询与新查询对同一 Batch 给出不可解释的中间状态 | 允许既有 TaskLifecycle 先写基础 failed、再补 overlay | `batch-overlay.mark-interrupted` 同事务完成三项；恢复只 resolve overlay，基础 interruption 历史保留 |
| Protocol v1 冻结 exact context/wrapper、双 scope `last+1` 与统一 262144-byte ceiling | Supervisor 不能猜 payload；多字节消息必须按 UTF-8 bytes fail closed | 只用开放 object 或业务 action 自行决定首版 ceiling | 52 policies 都要求 protocolLimits；fixtures 覆盖全 Job operation、gap/duplicate/backtrack/old generation |
| 新增 pure-compute canary，保留 durable canary | E00-F 纯计算探针与 E02-C2 durable recovery 的依赖/commit 语义不同 | 复用同一 actionKey 随阶段改变含义 | Registry 52 policies，版本表 59 行；八个 platform:* 明确是 scenario labels |
| Recovery result exact keys 进入 RecoverySource Schema `$defs` | 单一机器权威可同时约束 Inspector/Provider identity/hash/outcome | 在 Lifecycle/TechDoc 再定义第二套 DTO | 正负 fixtures 与 mutation 校验 canonical hash、UTF-8 bytes、identity mismatch |
| Registry startup 必须 register 全量后 freeze | 恢复扫描前需证明 static key 完整且禁止运行时漂移 | 边 initialize 模块边动态注册 | Main DB init → register/freeze → source/hold scan → owner initialize/cleanup |
| Service command/event direction 各自维护 seq | 权威 scope 已包含 direction；跨方向 exchange 应由 control/resource identity 关联 | reply 复制或校验对向 seq | revoke 交错正例证明 grant/adopt/release/close reply 可使用不同 seq，同时各 direction 仍严格 last+1 |
| PreparedIntentInput coordinationKind 使用持久枚举 | SQLite CHECK 与 policy 派生已冻结 `worker-critical/main-owned-settlement` | `worker-handshake/main-owned` 这组协议层误名 | input、SQL CHECK、policy derivation 三方结构检查与 3 个 mutation 一致 |

## Assumptions

| 假设 | 依据 | 失效影响 | 验证与回滚 |
| --- | --- | --- | --- |
| 当前任务只修订 target 合同包的文档、Schema/Validator/fixtures 与证据，不修改业务源码 | PR0 明确限定本 target 包目录 | 若后续 PR 实现源码，必须消费本包而非旧草案 | 本轮 git scope/包级 checksum 验证；production action gate 保留 |
| `inspection-completed`、`inspection-failed-transient`、`settlement-resumed`、`settlement-failed-transient` 是唯一 observation-only 事件 | 生命周期映射中它们不对应控制状态迁移；Inspector 与 Provider transient failure 必须可区分 | 漏掉或混记观察事件会使故障阶段不可审计 | 校验器冻结白名单；sourceKind 使用不含 manual 的 RecoverySource enum；新增类型必须先改权威契约和 validator |

## Deviations

| 原计划 | 实际方案 | 原因 | 影响 | Spec 已同步 |
| --- | --- | --- | --- | --- |
| 原计划只修复评审已指出的 observation 与外层事务 API | 盲区复核后同时冻结 command→event 映射、Batch 邻接与 Hold create-or-get 幂等 | 否则“eventType 由 Repository 推导”仍不可实现，且 `upsert` 可制造同态/跳跃状态 | 不改变业务结果，增加机器可验证约束 | 是 |
| 初始审查指令曾把 persisted task_key 与 actionKey 视为相同 | 源码证据后改为 canonical actionKey + legacy expectedTaskKey 双身份 | 真实 key 示例不同，等价会破坏旧 Task 并污染 event 血缘 | Adapter 校验 binding；Repository CAS task_key/operation_key 且禁止改写旧 key | 是 |
| 首轮 Service sequence fixture 的 request/reply seq 数值恰好相同 | 增加 revoke 导致双向计数交错的正例，并删除四类跨 direction equality guard | direction 已在 scope 中，数值相同只是样例巧合而非合同 | 不削弱单向连续性；新增 event-direction gap/duplicate/backtrack 与双向 old-generation 负例 | 是 |
| 冻结源包原有 60 文件 | target 增加 2 个 recovery result fixture，形成 62 文件审查性修订包 | 新 public result contract 必须有独立正负 fixture | checksum 与 validator input 统计按 target 实际集合重建 | 是 |

## Evidence

| 证据 | 结果 | 覆盖的行为/风险 |
| --- | --- | --- |
| Python AST、27 个 JSON、Bash runner 语法检查 | PASS | 校验器与清单可解析，runner 无语法错误 |
| 锁定 `jsonschema==4.26.0` 的完整 Validator 预跑 | `24/24 PASS`、0 error、60 hashed inputs；23 messages、5 valid/24 invalid sequences、20 recovery-control mutations | Schema/fixture、双向 seq、PreparedIntent enum、Recovery result/Control mutation、跨文档合同、输入哈希覆盖 |
| Markdown fence、document path、package hygiene | PASS | 文档结构、81 个本地引用、无 pycache/pyc |
| 原包与修订包 `diff -qr` / whitespace scan | 仅 target 合同包发生审查性变化；源包、旧草案与业务源码未改；无 trailing whitespace | 范围控制与冻结源保护 |
| blindspot-pass + reconciliation-blindspot-pass | 无未关闭的文档级 P0；新增关闭 event mapping、Batch 原子兼容写、manual source、Provider transient/idempotency 与审计血缘 | 入口旁路、边界、失败状态、兼容性、资损审计 |
| 最终 report、PACKAGE-SHA256SUMS 与目录包完整性检查 | Validator 默认模式生成报告后，以目录内 61 条 checksum 覆盖除 checksum 文件自身外的 61 个文件；本 PR 未创建、未测试、也不提交 target ZIP | 证明 62 文件自包含目录包可复现，并避免把未执行 ZIP test 写成证据 |

## Remaining Unknowns

| 未知 | 处理 | 负责人/下一步 | 合并影响 |
| --- | --- | --- | --- |
| Windows packaged directory fsync durable primitive | PROBE | E02-C2 在 packaged Windows 环境验证；unsupported/failure 走 DURABILITY_BARRIER_UNAVAILABLE hold | 不阻塞公共平台编码；阻塞所有 target-post-image 资金 action production enablement |
