# Implementation Notes

## Baseline

- Goal/spec: 修复 `background-execution-v3.2.x-codex-implementation-ready.zip` 中恢复控制仓储契约的可实现性缺口，并交付一份新的完整目录与 ZIP；原始 Downloads 包保持不变。
- Initial plan: 先冻结审计观察与状态迁移的边界，再补齐多对象外层事务组合能力；随后同步权威文档、入口文档、校验器、闭环证据和包级校验和。
- Done when:
  - 无状态迁移的检查/瞬时失败/结算恢复事件可以合法、幂等、原子地追加，且不能伪造状态迁移。
  - 一次恢复动作涉及多个控制对象时，Main 可显式开启一个外层事务，所有迁移与观察事件加入同一事务且不得各自提交。
  - `TaskRunTransitionV1` 明确只接管恢复相关迁移；常规 prepared/running/final 生命周期仍由既有 TaskLifecycle/ArchiveRepository 管理。
  - Critical Intent 状态图与命令前置状态唯一一致。
  - 校验器包含上述契约的正向检查和负向自测，并能拒绝旧/漂移写法。
  - 校验、哈希、压缩包完整性可复现；任何未执行项及原因被显式报告。

## Unknowns Register

| 未知 | 分级 | 当前处理 | 关闭证据 |
| --- | --- | --- | --- |
| 无状态迁移的恢复审计事件是否允许独立写入 | BLOCK → 已关闭 | 允许，但只能通过事务作用域内的 `appendObservationEvent()`；事件类型白名单、`previousState/nextState = null`，禁止修改控制状态 | 平台契约、E00 TechDoc、CODEX 文档与校验器一致 |
| 多个控制对象如何共享一个 SQLite 事务 | BLOCK → 已关闭 | 增加 Main-owned `runInControlTransaction()`，回调获得 `RecoveryControlTransactionV1`；作用域内方法只加入事务，不独立 BEGIN/COMMIT | API 契约、伪代码和校验器一致 |
| RecoveryControlRepository 是否接管所有 TaskRun 状态 | BLOCK → 已关闭 | 只接管中断/恢复相关迁移；常规执行生命周期保持既有所有权 | TaskRunTransitionV1 范围条款 |
| `committed` Critical Intent 是否可转 `recovered` | BLOCK → 已关闭 | 不允许；保持 `prepared -> acked -> committed -> closed` 与 `prepared/acked -> recovered -> closed`，已 committed 的恢复结果记录在 Task/Hold/Event，不倒改 intent 语义 | 状态图与 `mark-recovered` 前置状态一致 |
| 本机能否复现锁定版本 `jsonschema==4.26.0` 的权威校验 | PROBE → 已关闭 | 在 `/private/tmp` 隔离 venv 安装锁定依赖并运行，不污染项目 | Validator `21/21 PASS`，runtime check 记录 4.26.0 |

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

## Assumptions

| 假设 | 依据 | 失效影响 | 验证与回滚 |
| --- | --- | --- | --- |
| 当前任务只修订交付文档、Schema/Validator 与证据，不修改业务源码 | 用户要求承接前序文档包 review 后“改一下”；当前包本身不含生产源码改动 | 若用户实际期望直接实现 v3.2.x 代码，本次交付范围不足 | 最终明确交付物性质；代码实施仍受 production-action gate 约束 |
| `inspection-completed`、`inspection-failed-transient`、`settlement-resumed`、`settlement-failed-transient` 是唯一 observation-only 事件 | 生命周期映射中它们不对应控制状态迁移；Inspector 与 Provider transient failure 必须可区分 | 漏掉或混记观察事件会使故障阶段不可审计 | 校验器冻结白名单；sourceKind 使用不含 manual 的 RecoverySource enum；新增类型必须先改权威契约和 validator |

## Deviations

| 原计划 | 实际方案 | 原因 | 影响 | Spec 已同步 |
| --- | --- | --- | --- | --- |
| 原计划只修复评审已指出的 observation 与外层事务 API | 盲区复核后同时冻结 command→event 映射、Batch 邻接与 Hold create-or-get 幂等 | 否则“eventType 由 Repository 推导”仍不可实现，且 `upsert` 可制造同态/跳跃状态 | 不改变业务结果，增加机器可验证约束 | 是 |

## Evidence

| 证据 | 结果 | 覆盖的行为/风险 |
| --- | --- | --- |
| Python AST、25 个 JSON、Bash runner 语法检查 | PASS | 校验器与清单可解析，runner 无语法错误 |
| 锁定 `jsonschema==4.26.0` 的完整 Validator 预跑 | `21/21 PASS`、0 error、58 hashed inputs | Schema/fixture、跨文档合同、10 个 recovery-control mutation self-tests、输入哈希覆盖 |
| Markdown fence、document path、package hygiene | PASS | 文档结构、81 个本地引用、无 pycache/pyc |
| 原包与修订包 `diff -qr` / `git diff --no-index --check` | 仅合同、Codex 输入、Validator、报告/manifest 和两个新增 evidence 文件变化；无 whitespace error | 范围控制、无业务源码或 fixture 漂移 |
| blindspot-pass + reconciliation-blindspot-pass | 无未关闭的文档级 P0；新增关闭 event mapping、Batch 原子兼容写、manual source、Provider transient/idempotency 与审计血缘 | 入口旁路、边界、失败状态、兼容性、资损审计 |
| 最终 report、PACKAGE-SHA256SUMS 与 ZIP test | 在本文件冻结后执行；以包内生成物和交付 SHA-256 为最终证据 | 防止证据自引用导致哈希循环 |

## Remaining Unknowns

| 未知 | 处理 | 负责人/下一步 | 合并影响 |
| --- | --- | --- | --- |
| 无文档级关键未知 | CLOSED | 进入源码实施后按 action probe 与人工资金门禁继续发现 | 不阻塞公共平台编码；不解除任何 action production gate |
