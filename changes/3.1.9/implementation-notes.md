# v3.1.9 Implementation Notes

## Baseline

- Goal/spec: `changes/3.1.9/spec.md`；C01—C14 全部确认。
- Initial plan: 当前分支只实施 Spec §14 的 PR1「批次身份与数据库迁移」。
- Baseline SHA: `origin/main@63c1ce46357587643e506768f712352cbb6c7127`，版本 `3.1.8`。
- Done when: `changes/3.1.9/tasks.md` 的 PR1 项全部完成，PR1 自动化和既有 archive 回归通过，无 PR2—PR7 接线。

## Decisions

| 决定 | 原因与证据 | 放弃的方案 | 影响 |
| --- | --- | --- | --- |
| v2 批次身份与 v1 `createBatch` 并存 | Spec 要求历史兼容且 PR1 不接业务入口 | 原地把 `createBatch` 改成 v2 | PR2 可逐入口迁移，PR1 不改变生产业务时点 |
| schema 只用 `CREATE TABLE/INDEX IF NOT EXISTS` 与逐列 `ALTER TABLE ADD COLUMN` | Spec §12.4 和 PR1 约束为纯加法；SQLite 3.50.4 probe 已通过 | 重建 `archive_batches` 扩 CHECK | 保留 archiveStatus 三态 CHECK 和历史唯一约束 |
| 全局序号只由 repository 的单个 `BEGIN IMMEDIATE` 事务分配 | C01、Spec §6.3；跨连接唯一性必须由 SQLite 保证 | 读 max 后 +1、内存锁、renderer 分号 | 并发、失败回滚和重启语义集中在持久层 |
| 分离不可复用日游标与真实 latest issuance | PR2 前 v1 `createBatch` 仍可达；把兼容游标格式化为 v2 会展示从未发放的号 | 从游标或可见 `archive_batches MAX` 推断 | `reserveTaskBatch` INSERT 成功后同事务记录真实 batch id/number/time；v1 只推进游标；删除不回退 |
| 增加显式持久 flow anchor | operationKey 只标 action，`parent_run_id` 无法按稳定业务 identity 跨重启反查 | 月份/hash/renderer state/JSON 全表猜测 | `(module_id, identity_type, identity_value)` 唯一映射 parent；source batch module/parent 血缘 fail-closed |
| terminal task 状态使用最小 CAS | cancel IPC 与原任务 Promise 可乱序完成 | 后返回结果无条件覆盖 | expected 非终态才更新；相同 terminal 幂等，不同 terminal 返回 conflict |
| task terminal 同事务收敛 archiveStatus | C04 无文件元数据任务没有 artifact 事件触发原 `_refreshBatchStatus`，会永久停在 staging；但登记前 archive failure 也可能留下 0 artifact | 把 task failed/cancelled 直接写成 archive failed/incomplete，或把所有 0 artifact 一律 complete | 0 artifact 且无当前 archive failure 证据/all ready=`complete`，pending=`staging`，failed 或登记失败证据=`incomplete`；累计 failureCount 不阻止真实重试转 complete |
| task 状态和 archiveStatus 使用独立列/接口 | Spec §4.3、§17.13 | 把 failed/cancelled 塞进 archiveStatus | 保留既有 archive 文件状态与 CHECK |
| 删除授权由 repository 同时保护 locked 与 active | 手工删除和 `cleanupExpired()` 最终都调用 `ArchiveRepository.deleteBatch`；active 的 reserved/running 尚未形成可删除事实 | 只在 service/UI 拦截，或让 `force` 绕过 active | repository 返回 `active`，service 稳定映射 `ARCHIVE_BATCH_ACTIVE`；force 仍只绕过 locked |
| cursor seed 先完成 v2 列迁移，再仅回填 v1 module cursor；global seed 独立聚合 module cursor | 首次旧 schema 无 `batch_format_version`，现 SQL又会纳入 v2；batch JOIN 造成 fan-out | 重建 batch 表、按可见 batch max 重算、降低已有 cursor | 不改已有号；重复 ensure 只取 MAX，v2 重启不再推动 module/global cursor |
| 有 source 的 flow anchor 要求 source module/parent 双严格等值 | 空 parent 不能证明来源属于目标 flow | 把 null/空 parent 当继承证据，或新增 fallback | 继续使用 `ARCHIVE_FLOW_ANCHOR_CONFLICT`；无 source 的新流程 anchor 不受影响 |
| task 权威时间由 repository 写事务内唯一采样 | localDate、号码和 reservedAt 都在同一预留事务形成；service/repository 双采样会跨午夜错位 | service 先采样再传日期，或继续允许 caller localDate | 显式 task localDate 拒绝；默认 retentionDays 基于同一 localDate；显式 retentionUntil 与 legacy createBatch 兼容语义保留 |
| 登记失败的 artifact 复用现有失败血缘 | batch error 不能表达“已成功 A、待恢复 B”的完整集合；现有 retry 已按 `archive_artifacts.status=failed` 工作 | 全局 batch error 永久 sticky，或另建恢复表/循环 | addArtifact 失败后以同 artifact key 登记 failed placeholder 并返回 durable artifact id；placeholder 也失败才沿用 batch error + filesystem outbox，原错误仍返回 |
| operation issuance 独立于可删除 batch 行 | 删除后仅靠 live batch 无法区分“从未发行”和“已永久删除”，重放会复用 operation key 分新号 | 推进 cursor、保留假 batch、内存 latest/timer | 纯加法 `archive_operation_issuances` 同事务记录发行/删除；create/reserve 先返回 `ARCHIVE_OPERATION_DELETED`，outbox 公共 replay 明确 discarded、告警并释放源路径 |
| `retentionUntil: undefined` 等同未提供 | task payload 的 own-property 判断把 undefined 错当永久，覆盖 retentionDays/default | 收紧 legacy createBatch 或所有 retention 输入 | 只忽略 task 的 undefined；显式 `retentionUntil:null` 与 `retentionDays:'permanent'` 仍永久，显式日期及 legacy 语义不变 |
| terminal API 唯一采用 positional batchId | PR1、PR2 真实调用均为 positional，Spec §5.2 的 object 示例与代码不一致 | 双形态 overload 或提前移植 PR2 metadata | `completeTaskBatch(batchId, options)` / `failTaskBatch(batchId, failure)` / `cancelTaskBatch(batchId, cancellation)`；PR1 不提前扩 complete options |

## Assumptions

| 假设 | 依据 | 失效影响 | 验证与回滚 |
| --- | --- | --- | --- |
| PR2 会为每次新用户任务提供新的稳定 operation/taskRun identity | Spec §5.5，当前 PR1 不接 action | 相同 operation key 会按设计复用批次 | PR2 policy/flow 测试负责；PR1 只锁 repository 幂等 |
| PR1 latest issuance 只提供真实发行事实 DTO，不组合 UI 统计 | PR6 明确负责统计/UI | 后续 DTO 可能追加 status | 追加字段即可，不改分配语义 |

## Deviations

无产品行为偏离。为落实 Spec 已明确的跨重启 parent 恢复与 latest issuance 口径，PR1 追加了纯加法 `archive_flow_anchors`、日游标上的真实发行事实字段，以及防止永久删除后 operation key 复活的 `archive_operation_issuances`；BusinessFlowResolver 与业务入口接线仍留在 PR2。

## Evidence

| 证据 | 结果 | 覆盖的行为/风险 |
| --- | --- | --- |
| 确认稿行数与 SHA-256 | 1618 行；`52a7f430...a31b`，归档副本一致 | 产品合同未被重写 |
| 基线检查 | HEAD/origin/main 均为 `63c1ce4...`；版本 3.1.8 | 实施基线锁定 |
| SQLite ADD COLUMN probe | SQLite 3.50.4；默认值回填成功，非法 task status 被 CHECK 拒绝 | 可用纯加法迁移，不需重建旧表 |
| archive 定向基线 | repository/service/controller 44/44 PASS | v1 兼容基线 |
| PR1 archive 定向（含 controller） | 55/55 PASS | 旧库迁移、100 次真实多连接预留、失败回滚、latest、task CAS、零文件 terminal finalize、flow anchor、v1 controller/service 回归 |
| 全量 unit | 4813/4813 PASS | 304 个测试文件，无跨模块回归；含 C04 terminal finalize 修正后复跑 |
| 全量 integration | 48/48 脚本、2459/2459 PASS | 业务导入、对账、工具箱、VCC 链路回归 |
| smoke | PASS | 既有主流程、writer、场景、日志与进度回归 |
| `check-vars -- --include-minor` | PASS，未命中重要变量 | 无需追加重要变量专项 review |
| blindspot / reconciliation 复核 | 已修复 latest 伪发行、terminal 迟到覆盖、零文件 staging 悬挂，同时保留登记前失败证据；flow anchor 跨模块串联已拒绝；无金额/币种/匹配/Excel 输出改动 | 主键血缘、状态生命周期、部分失败、并发、兼容和资金边界闭合 |
| PR #132 P1 定向测试 | `node --test` allocator/repository/service：40/40 PASS；完整 archive 相关 8 文件：110/110 PASS | active 删除、seed 幂等、flow parent 血缘、权威日期与既有 controller/tracker/outbox/service 回归 |
| PR #132 静态门禁（首轮增量范围） | ESLint PASS；相关生产/测试 `node --check` PASS；当时的 `git diff --check` 仅检查工作区/末次补丁，未覆盖 base→PR 全量，故不作为全量 diff gate 证据 | 语法、编码规范通过；全量补丁空白证据由第二轮 base SHA 门禁补齐 |
| PR #132 重要变量复核 | `npm run check:vars -- --include-minor` PASS、脚本无命中；人工按 `ArchiveRepository` / `ArchiveService` Risk-sensitive 条目复核 schema 幂等、序号不复用、Blob 删除顺序和业务/存档隔离 | 未改金额、币种、匹配、artifact/Blob 内容或 Excel 输出；无资金红线人工样本项 |
| PR #132 完整 release-check | exit 0；lint PASS；smoke PASS；unit 4816/4816 PASS（304 files，Node 测试 15177.643ms、runner 15214ms）；integration 48/48 scripts、2459/2459 assertions PASS（386135ms） | 四项修复之外无 unit/integration/smoke 回归；integration runner 自动生成的 policy 耗时刷新不属于本轮交付范围 |
| PR #132 team-lead review | 无 P0/P1、无入口旁路、无过度防御；独立复跑两个相关文件 34/34 PASS，git diff/status 边界正确 | 四项修复与测试范围通过最终代码 review |
| PR #132 第二轮评论定向 | allocator/repository/service/controller 共 61/61 PASS（首次扩大到 repository 时仅 schema inventory 陈旧，补入新增 issuance 表后复跑全绿） | failed artifact 血缘、terminal 收敛、删除 tombstone 跨重启、legacy outbox discarded、retention undefined 与既有 repository/service/controller 回归 |
| PR #132 第二轮静态与全量 diff 门禁 | 相关 3 个生产与 4 个测试文件 `node --check` PASS；ESLint PASS；`git diff --check 63c1ce46357587643e506768f712352cbb6c7127` PASS | base→working tree 的完整 PR 等价范围通过，已包含并修复 Spec 原有行尾空白；不是仅检查工作区/末次提交 |
| 第二轮 blindspot pass | 真实 create/reserve/delete/cleanup/outbox/retry 链路均回查；issuance read 与 replay 已纳入同一 per-record 错误边界，DB read failure 保留 outbox/源路径并继续；未发现会改变方案的存活盲区 | artifact placeholder 只覆盖合法 payload 后的 addArtifact 失败；非法 expected hash/size 不扩大恢复语义；PR2 targetBatchId 由公共 replay 前置判定自然覆盖 |
| PR #132 第二轮负责人 full-gate review | 无 P0/P1、无过度防御或重复/不可达防御；负责人独立 archive 8 文件 113/113 PASS、base→working-tree diff-check PASS | 生产状态模型、入口边界和最小测试范围通过未提交代码 review |
| PR #132 第二轮完整 release-check | exit 0；lint PASS、smoke PASS；unit 4819/4819 PASS（304 files，Node 测试 15377.901125ms、runner 15415ms）；integration 48/48 scripts、2459/2459 assertions PASS（394086ms） | 完整 unit/integration/smoke 回归通过；runner 仅刷新的 `rules/integration-test-policy.md` timestamp/耗时已按 HEAD 精确撤回，未纳入交付 diff |
| PR #132 第二轮重要变量与人工软复核 | 负责人独立 `npm run check:vars -- --include-minor` exit 0，3 个生产文件自动无命中；人工按 ArchiveRepository/ArchiveService/Controller 软复核 schema 幂等、序号不复用、Blob 删除顺序、业务/存档隔离，以及 controller IPC/retention/skipArchive/部分删除语义，均未发现漂移 | 未改金额、币种、匹配、Excel 输出；identity tombstone 与 failed artifact 仍按风险敏感持久化边界 review |
| reconciliation 审计红线剩余人工项 | 自动化已覆盖状态与幂等，但不把自动化冒充真实环境验收 | 合并前仍需人工核验：真实 terminal 批次永久删除→重启→同 operation 被拒且不分新号；真实 outbox discard 的 warning 可见且源路径释放；A/B artifact 首次结果集合、模块归属与 ready 内容 SHA 在失败/恢复前后一致 |

## Remaining Unknowns

| 未知 | 处理 | 负责人/下一步 | 合并影响 |
| --- | --- | --- | --- |
| PR2 各模块采用哪一种稳定 business identity type/value | 后续实现 | PR2 BusinessFlowResolver 按各模块已有 runId/operationToken 显式选择 | 不阻塞 PR1；禁止月份/hash fallback |
| PR #132 四条 P1 评论是否引入新的产品口径 | PROBE 已消除 | 现有 Spec 与 review 评论已锁定；按定向测试验证 | 不阻塞；无 Spec 偏差 |
| PR #132 第二轮五条评论是否要求新增恢复系统或双形态 API | PROBE 已消除 | 复用 failed artifact/outbox，新增纯加法 issuance tombstone；terminal 统一 positional | 不阻塞；无 timer/lease/latest tracker/fallback/overload |
