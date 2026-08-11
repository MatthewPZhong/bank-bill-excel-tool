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
| Spec 行数与 SHA-256 | 开工基线确认稿为 1618 行、`52a7f430...a31b`（当时归档副本一致）；本轮按 PR 评论反向同步 §5.2 并修正 Markdown 后，当前仓库 Spec 为 1620 行、`f5c871ccd7fd17a0b93459b12a66dfb7528282a6d1f4bee25020108caa02e024` | 产品变化仅 canonical terminal positional 契约的文档纠错 |
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

## PR #132 第三轮评论增量

### Decisions

| 决定 | 证据 | 放弃方案 | 实现约束 |
| --- | --- | --- | --- |
| `persistOperationIntent()` 在写 outbox 前查询既有 operation issuance | Position 的 UI/IPC 与启动恢复最终都进入该 controller 方法；`getOperationIssuance(...).deletedAt` 已是 create/reserve/flush 的 tombstone 权威 | 另建删除状态、查询 live batch、让 flush 以后再丢弃 | 成功读到 deleted 时返回原 batch id、`persisted:false`、`operationStatus:'deleted'`、`ARCHIVE_OPERATION_DELETED`；不 enqueue/append |
| issuance read 异常继续使用 filesystem outbox | intent 本身是 archive DB/正式登记失败后的 durable fallback；把 DB read 设为前置条件会破坏恢复链 | read 失败直接抛出、重试查询或另存一份状态 | 复用 `_warn` 后继续 `_persistOutboxPayload`；不重试，且不吞 outbox 自身错误 |
| deleted intent 作为稳定不可执行证据正常返回 | startup recovery 正常返回后清 pending；operation lifecycle 用返回 batch id 标记既有 durable reference | 抛错导致每次启动继续失败，或返回新 outbox id 假装已登记 | 不新增 `archiveFailed`/retry fallback，不改变原 issuance/cursor |
| 三条非法 direct/internal 输入及 flush/delete 假设竞态不进入实现 | Position descriptor 由主进程 pending 校验/快照产生且 raw sink 不暴露给 IPC；intent 只取设置 retentionDays；`flushOutbox()` 仅启动 initialize 调用 | 为非法 artifact 参数、显式 artifactKey 碰撞、空 retention 字符串或不可达竞态增加防御与测试 | 文档分别澄清真实 persist 旁路与不可达竞态，不混写成同一修复 |

### Evidence

| 证据 | 结果 | 覆盖的行为/风险 |
| --- | --- | --- |
| review `#4897211115` thread-aware 复核 | 四个 thread 均 unresolved、`isOutdated=false`；只有 controller `persistOperationIntent` 有真实 Position 入口 | 严格收缩生产 diff，不把 direct/internal 非法输入提升为生产缺陷 |
| deleted Position intent 最小真实 SQLite 用例 | 单项 1/1 PASS | terminal/delete/restart 后 intent 返回原 batch deleted 证据，outbox 为空，issuance/cursor 不变 |
| 既有 DB unavailable outbox 回归 | 与 deleted 场景合跑 2/2 PASS | issuance read 抛错时产生明确 warning，仍追加同一 durable outbox；恢复 DB 后跨重启语义重放并释放源路径 |
| controller + Position lifecycle/UI 接线回归 | 81/81 PASS | outbox discard、现有重复 intent、Position pending/checkpoint/恢复与 renderer/IPC 静态契约未回归 |
| archive 相关 8 文件回归 | 113/113 PASS | repository/service/controller/tracker/outbox/source snapshot 与 allocator/UI contract 未回归 |
| 最终相关 10 文件合并复跑 | 157/157 PASS | 中途修正 DB read 错误边界后，archive 8 文件与 Position lifecycle/renderer 契约共同全绿 |
| 最终 test-only 断言整理后 controller 复跑 | 19/19 PASS | 保留原 outbox append 覆盖并同时验证 issuance read warning/fallback 后，controller 文件全绿 |
| 第三轮负责人最终 review | 无 P0/P1、无过度防御；独立复跑 controller、Position lifecycle、renderer Position 三个文件 63/63 PASS | tombstone 短路、DB read fallback 与真实 Position 接线通过提交前 review |
| 静态与重要变量门禁 | 相关生产/测试 `node --check` PASS；ESLint PASS；`check-vars -- --include-minor` 自动无命中；base→working tree 与当前增量 diff-check PASS | controller 方法不改变 IPC/preload、retention、skipArchive、重试、Blob/序号行为；按 Important-skeleton 定义位置人工复核未见漂移 |

### Remaining Unknowns（Phase 0）

无本轮 BLOCK。flush/delete 竞态在当前生产调用图不可达；若未来增加运行期 flush 入口，应在该新入口设计中重新评估串行化，而不是在 PR1 预造协调机制。

## PR #132 第四轮评论增量

### Decisions

| 决定 | 证据 | 实现约束 |
| --- | --- | --- |
| deleted startup recovery 在清除 pending 后清理全部已解决 input | archive cleanup/delete 可先留下 tombstone，而 pending 会让首次 source release 跳过 committed staging；随后 deleted intent 不建 outbox | 用 `positionRecoveryCleanupInputPaths` 复用现有未提交输入 helper；仅 deleted code 以空 retained set 取得全部 pending input，非-deleted/outbox/部分提交与 output 选择不变 |
| durable pending 恢复前只读既有 issuance tombstone | `markPositionArchiveDurable()` 先于 cleanup/sync/clear；该窗口崩溃后 durable 早返回不会再次调用 controller | durable 分支沿 main 既有 repository 入口查询同一 operation；仅成功读到 deleted 才复用全量 input cleanup，读取失败保守保留 committed staging，不新增 retry/API/状态 |
| recovery 内部返回字段统一为 `cleanupInputPaths` | deleted 集合不再等同于 uncommitted，旧字段名会误导内部契约 | 只同步 main 内部唯一消费点；仍先清 pending，再走既有 staging-root containment 与 protection filter，不新增清理系统或后台机制 |

### Evidence

| 证据 | 结果 | 覆盖的行为/风险 |
| --- | --- | --- |
| review `PRR_kwDORiHOzM8AAAABI_MpjQ` / thread `PRRT_kwDORiHOzM6X63vt` | unresolved、non-outdated；root 确认生产可达 | 修复限定为 deleted recovery 的 committed staging 清理缺口 |
| 既有真实 repository/controller tombstone 回归 + lifecycle cleanup candidate 断言 | 定向 2/2 PASS；controller 用例保持真实删除后 deleted DTO，既有部分提交 fixture 增量证明 deleted 时返回全部 pending input | 不重复搭 controller/SQLite，不增加 VM/source extraction 或伪 startup 状态 |
| main startup 顺序与既有 staging 保护回归 | controller/Position lifecycle/renderer/archive UI 81/81 PASS；既有 protection 定向 2/2 PASS | archive UI contract 钉死先清 pending 后调用 `cleanupInputPaths`；containment/protection 继续由既有清理实现与测试负责，不重复物理 rm case |
| durable crash 窗口补充复核 | 最小 UI contract + lifecycle 35/35 PASS；controller/Position lifecycle/renderer/archive UI 合并回归 81/81 PASS | lifecycle 单一断言证明 deleted 返回全部 input candidates；静态契约证明 durable 分支先取 tombstone 再交同一 helper，未增加重复状态 case 或 VM/SQLite harness |
| 静态与重要变量门禁 | 相关 4 文件 `node --check`、ESLint、base→working tree/current diff-check PASS；`check-vars -- --include-minor` 自动无命中 | 人工按 Position Risk-sensitive 条目复核 checkpoint/pending 所有权、存档失败隔离与退出顺序；未改 side DB、业务数据、金额/币种/匹配或文件内容 |

---

## PR2 Implementation Notes

### Baseline / Task Brief

- Goal/spec: 实施确认 Spec §14 PR2：before/after lifecycle、TaskPolicyRegistry、BusinessFlowResolver、worker batch context 与现有 12 个 archive scope 接线。
- Context: 基于 PR1 commit `98ddcf9fc02193381f7b31fd5e0252de6476479a`；PR1 已提供原子 reserve、task terminal CAS 与持久 flow anchor。
- Constraints: 不改锁定 `spec.md`；不改业务算法；不做 PR3 VCC/工具箱、PR4+ 目录/迁移/UI；不带入用户未跟踪文件。
- Done when: PR2 可承担实现、Spec §15.2/§15.3 自动化、既有回归与 check-vars 关联 review 通过并进入提交准备；GUI、真实崩溃/重启和资金结果人工验收继续作为待用户测试项。

### PR2 实施前确认事实

| 事实 | 证据 | 对方案的约束 |
| --- | --- | --- |
| 当前 `runArchiveAwareOperation` 在业务成功后调用 tracker | `src/main.js` 的 wrapper 调用顺序 | 必须改为 reserve-before-execute；不能在 tracker 补救 |
| tracker 持有 `pendingInputs/activeBatches` 并调用 `createBatch` | `operation-tracker.js` | 与 C02、跨重启和禁止 find-latest 不变量冲突，生产路径必须移除 |
| PR1 service 已提供 reserve/started/terminal CAS 与 flow anchor | `archive-service.js` / `archive-repository.js` | PR2 只编排，不重复实现分配器或状态机 |
| 平盘普通来源 `prepareSourceImport` 会自动写入；银行 prepare 只产生确认 token | `position-reconciliation/service.js` | 普通来源 picker 必须前移后再 reserve；银行 prepare exclude、apply reserve |
| 现有 worker 已有 operation token / pending 恢复链 | position operation lifecycle / dispatch | batch context 必须沿用该稳定 token，不改 checkpoint 或 worker 业务协议 |

### PR2 Initial Unknowns Register（已消除）

| 未知 | 类型 | 影响 | 处理 | 最便宜验证方式 | 当前决定 |
| --- | --- | --- | --- | --- | --- |
| 哪些 handler 在 picker/确认后才发生首个副作用 | 调用边界 | 高 | PROBE | 逐个读 reserve action 的 dialog/service 调用顺序并以取消测试锁定 | 使用 `{prepare, execute}`；不靠状态字符串猜测 |
| 各模块可用的稳定业务 identity | 数据血缘 | 高 | PROBE | 查 payload/result/run repository/operation token | 只登记可证明 ID；无证据新建流程 |
| PR2 如何保持 PR3 增量可评审 | 分支边界 | 中 | ASSUME | 对照 Spec §14 与 team-lead 补充范围 | 精确列出 PR3 handoff 通道，未知通道仍失败；PR2 不接其 lifecycle |
| archive append 失败怎样不覆盖业务成功 | 部分失败 | 高 | PROBE | controller/outbox 行为测试 | terminal 先按业务结果，archive 失败仅告警/incomplete，不替换 result |

实施前无 BLOCK；上述 PROBE 已由逐 handler inventory、持久 identity 映射和定向失败路径测试消除。

### PR2 Decisions

| 决定 | 原因与证据 | 放弃的方案 | 影响 |
| --- | --- | --- | --- |
| lifecycle 由独立编排器固定 BOR/reserve/started/ALS/append/terminal/end | main 现有 wrapper 次序不满足 Spec §5.4 | 在成功后 tracker 内补建批次 | 预留失败绝不进入业务；所有终态集中 CAS |
| handler 支持显式 `{prepare, execute}` | 多个 action 把 picker/危险确认与副作用混在一个函数 | 预留后再弹 picker、按返回 status 猜是否取消 | 只重排边界，不改 service/算法 |
| TaskPolicyRegistry 使用 literal channel 和有限原因枚举 | Spec §5.1.1/§7.2 | prefix/wildcard exclude | 新通道未声明直接测试失败 |
| operation tracker 变为 stateless file resolver/append adapter | C02 每个 action 独立批次，旧跨 action pending/active 内存不可恢复 | 保留 latest batch fallback | 输入、输出只追加当前 batch；无文件 action也能 complete |
| BusinessFlowResolver 只接受显式 parent 或持久 anchor identity | Spec §5.2.1 和 PR1 flow anchor | 月份/hash/renderer/current-latest 猜 parent | 证据不足时宁可新流程，不错误串联 |
| 稳定 identity 查询成功但无 anchor 时建立并立即绑定新 parent | 历史 run 升级后第一次进入 v3.1.9 必然没有 anchor；Spec §5.2.1 要求“无法证明继承时新建” | 抛 `PARENT_NOT_FOUND` 阻断历史导出 | 查询失败/绑定冲突仍 fail-closed；不使用 latest/month fallback |
| worker batch context 是冻结的纯数据 DTO | worker_threads 只能可靠传播可序列化值 | worker 持有 service/repository 或自行 reserve | worker 子任务共享父 batch identity，不建幽灵批次 |
| worker 入口统一重建恰好 7 字段 DTO；Position ordinary source 只在既有 apply grant 注入 | structured clone 不保留对象冻结状态；source `START_JOB` 发生在 reserve/started 前的预检阶段 | 把 lifecycle controls/`settleArtifacts` 整体发给 worker，或在 preflight START 伪造 context | `batchId/batchNumber/taskRunId/taskKey/moduleId/parentRunId/operationKey` 以外字段被丢弃并重新冻结；source START 无 context，`APPLY_GRANTED` 才获得父任务 context |
| 只接真实异步 worker 边界，不给同步 fallback 造新协议 | Pending/BizOp 有可达 legacy utility；Acquiring legacy 与 Position legacy apply 在主进程同步执行 | 为“形状统一”新增 worker command/version 或改变 legacy 事务边界 | default/legacy parity 保持；resume identity、checkpoint、命令版本、金额/币种/匹配算法均不动 |
| module scope 将 12 primary 与内部 alias 分层 | team-lead 明确 PR2/PR3 边界 | 把 alias 当可见范围或提前加入 VCC/toolbox | PR3 可追加 VCC primary 和 toolbox utility，不改现有 ID |
| 网银大账号选择拆成 prepare preview 与一次性 complete | 选择/取消属于业务前交互；renderer 不应持有源路径或可伪造完整上下文 | 先 reserve 再弹窗、把 `fileRows/filePath` 回传 main | preview/cancel 0 批次；main 以 opaque `contextId` 持有源上下文；complete 校验新鲜度、数量、账号与币种后只执行一个 reserve action |
| 大账号顺序提取是严格只读 preview-only | 该入口只读原文件并返回识别预览，不产生业务产物 | 复用 statement reserve policy | 裸 IPC + exact exclude；fixed 先选服务端 `rowsWithEmptyBlocks` 再按 rowIndex 过滤，renderer 只回传 contextId/rowIndexes |
| 非 bill-split 路径复用 prepare 映射行；bill-split 保留原文件重建 | 大文件 preview 若再次走 `buildMappedRowsForFile` 会产生显著重复 IO；但 bill-split 的 `currencySourceField` 可覆盖所选币种并参与合并不一致判定 | 所有路径一律复用缓存行，或所有路径 execute 全量重读 | 非 bill-split execute 克隆 metadata、注入所选 MerchantId/Currency 并移除已被 selectedCurrency 短路的 `currency-unmapped`；bill-split 显式回退 raw rebuild，源文件新鲜度仍在 reserve 前复核 |
| prepare 数据探测必须真实只读 | 收单侧库 `openSideDb` 会建目录、跑 PRAGMA/DDL，不符合确认前零副作用 | 复用正常侧库初始化入口 | 不存在返回 0 且不建目录；存在以 `DatabaseSync(..., {readOnly:true})` 查询，禁止调用 `openSideDb` |
| statement execute classifier 只额外接受 `manual-balance-required` | 大账号/顺序不匹配/导出 scope 均已在 prepare 以 `proceed:false` 截断 | 将交互 status 继续视为 execute success | 未来交互状态若意外穿透 execute 会 fail-closed，不会悄悄生成 succeeded 批次 |
| full preview/peek 完成后、返回交互结果前再次校验源文件 freshness | 大型 Excel 解析期间文件可能被外部保存；只在探测前和 reserve 后校验会让 preview 证据与源文件脱节 | 增加 lease/retry 框架 | statement 与 acquiring 均在 probe 返回后立即复核，并保留 reserve 后 `beforeStart` 复核 |
| direct recognition 与 fixed auto-match 决策只缓存于 main prepared plan | preview/execute 重复识别会触发 `>64` 行 fallback 或 self-input bridge 的第二次完整读表 | 把识别结果回传 renderer、execute 再识别 | renderer DTO 不变；freshness 通过后 execute 复用 preview 决策 |
| 固定模式顺序设置在账单结果形成后由 complete 单次持久化 | renderer 先 `saveOrder` 再 complete 会产生两个 reserve task，且生成失败仍可能提前改顺序 | 引入跨文件事务框架 | complete payload 携带 remember/clear 意图；保存失败只把既有业务结果提升为 warning，不清生成文件，也不声称已记住 |
| position run 危险替换确认使用 main-only opaque context | `service.run` 原先在 execute 后才返回 `needs-replace-confirmation`，会先建幽灵批次；selection 与当前 pending run 可在 service 只读预检中证明 | renderer 回传 selection/replacePendingRunId，或为 context 引入 lease/replay 状态机 | 首调/取消 0 BOR/reserve/run；确认二次请求只含 `contextId + confirmReplace`，execute 仍调用原 `service.run` 且只 reserve 一次 |
| source import 按引擎建立 lifecycle plan，不改变 worker 协议和文件级事务 | legacy 普通来源原先在 prepare 内直接 apply；streaming 已有 `PREFLIGHT_READY → authorizeApply` 屏障 | 新增 worker command/version，或把 mixed 改为整批账户确认后提交 | legacy prepare 只暂存/解析，execute 沿用逐文件 `store.applySourceImport`；streaming ordinary grant 等 started/execute 才释放；account-only 预检/取消 0 batch，mixed ordinary 仍先提交且账户确认走独立 apply batch |
| prepared source resource 在未进入 execute 时显式 abandon | streaming worker 会在授权 Promise 上等待，legacy plan 持有暂存和账户 token；BOR busy/reserve/started/beforeStart 失败都不会自然进入业务 execute | 定时 lease 或等待进程退出后由启动清理兜底 | lifecycle 只提供最小 `onAbandon` 清理：终止未授权 worker并等待 staging 清理，或删除 legacy 暂存/token；正常 execute 不提前清理 |
| position run prepare 只做范围 COUNT | 原实现 prepare 与 execute 都调用 `getBankRows`，会对大范围银行 JSON 全量解析两次 | 缓存 prepare 全量行供 execute 复用，或增加重试/锁 | store 用 channels/months/status 的轻量 COUNT 验证非空；prepare 读取 pending/checkpoint，execute 保持原算法并只做一次全量 `getBankRows` |
| position prepared resource 只在 outer operation 实际放行后标记 execute | TaskLifecycle 已进入 execute 不代表 `runPositionReconciliationOperation` 会调用业务 callback；active operation、unresolved pending 或 initial pending 写失败均可在 callback 前拒绝 | 修改 outer lifecycle、给 worker 加超时/重试 | 非 position 保持进入 lifecycle execute 即标记；position 在 outer callback 第一行标记，未放行时沿用既有 `onAbandon` 终止 worker/清 staging |
| acquiring resume 在 prepare 阶段锁定唯一恢复源与身份 | 每月 side DB 的 runId 会重复；升级前 side/main partial run 又可能没有 batch context | 固定读 main DB，或只按 month/hash/runId 猜 parent，或拒绝 legacy side partial | side DB 存在时只读 side，否则读 main；compatibility identity 固定包含 `source + monthKey + runId`，持久 context 精确 reopen，legacy 首次稳定 reserve 后在 worker 前回填 |
| acquiring resume 沿用现有月度 operation lock，并由 prepared plan 管理释放 | 第二次 resume 必须在 worker 与 archive reopen 前 busy，且不能把第一批次标失败 | 在 worker 内判重，或引入 generation/lease/timer | prepare 在 BOR/reserve 前获取锁，`onAbandon` 与 execute `finally` 幂等释放，`beforeStart` 复核 progress/context 新鲜度；通用 wrapper 仅透传 recovery/task/operation/flow plan |
| acquiring side resume 只在成功后更新 main mirror | side 是月份事实源，main 只是镜像；legacy main 恢复不能伪造不存在的 side | 执行前写 mirror，或 main 恢复后创建 side DB | worker 始终使用 prepared `dbPath`、持久 chunkSize/context/offset；side 成功后 upsert main，main source 保持 `side_db_rel_path` 为空 |
| legacy existing 非 reserved 批次先 freshness 后 reopen | reserve/started 与 progress context 回填之间崩溃后，下一次 prepared evidence 可能已 stale；先 reopen 会无意义清除原 failure/finished 证据 | 所有 legacy existing 一律先 `beginTaskRecovery`，或把 stale 再次写成 failed | 仅 `recovery.legacy && created=false && taskStatus!=reserved` 延迟 recovery；freshness 失败直接返回且不 recover/fail，existing reserved 与新建路径保持原时序 |
| Acquiring run/resume 的结果 identity 使用专用 source+month+run key | side runId 每月重复，generic raw runId 会把不同月份绑定到同一 flow | 继续复用 `resultBusinessRunIdentities`，或按 latest/month 猜 parent | normal run 固定 `side`，resume 只信 prepared source；月份从 args/prepared 交叉校验，缺证据返回空 identity；import/export/clear 与其他模块不变 |
| Position 恢复暂存只在共享 finalizer 清 pending 后释放 | `getPositionReconciliationService` 提前清理时 pending input 仍在保护集合内，清理会被跳过且后续没有第二次机会 | 在 getService 保留提前 cleanup，或让 direct/outbox 各自清理 | direct recovery 与 outbox success 共用 `finalizeRecoveredPositionPending`；durable/原 task terminal 后按当前 operation 的 pending + side DB 提交凭证重算未提交输入，checkpoint/bootstrap/ownership clear 完成后 best-effort 清理；失败或 ownership 变化保留 pending |
| 保留 integration runner 自动同步的测试清单 | `rules/integration-test-policy.md` §七明示只在全部 PASS 后由 runner 原位写回，历史提交也持续保留 timestamp/count/duration 证据 | 因只有时间戳和耗时变化而手工回退生成段 | 本次 48 个脚本、2459/2459 PASS 的生成证据随 PR2 WIP 保留；不手改自动生成表格 |

### PR2 Assumptions

| 假设 | 依据 | 失效影响 | 验证与回滚 |
| --- | --- | --- | --- |
| 无法证明继承的 action 新建 parent 符合 fail-safe 口径 | Spec §5.2.1 明文 | 关联展示偏少但不串错流程 | 逐模块补稳定 anchor；不采用弱 fallback |
| PR3 exact handoff 可作为 PR2 增量 inventory 的唯一暂存状态 | Spec 按 PR 拆分且 team-lead 禁止提前接线 | 若 handoff 漏项会绕过 CI | 锁定 exact literal 集合；PR3 必须逐项替换，不允许 prefix |

### PR2 Evidence

| 检查点证据 | 结果 | 覆盖的行为/风险 |
| --- | --- | --- |
| acquiring prepare 只读单测 | 14/14 PASS | 缺失侧库不创建目录/DB；既有侧库只读计数、不调用 DDL 入口且 mtime 不变 |
| lifecycle/policy/IPC/大账号聚焦单测 | 42/42 PASS（与 acquiring 合跑共 56/56） | prepare stop 零 reserve、exact preview-only、opaque DTO、fixed 服务端行选择、乱序 assignments 排序、非 bill-split 缓存行不重读、classifier fail-closed |
| 大账号既有单测 + 账单 pipeline 集成 | 27/27 PASS；45/45 PASS | 模式/顺序持久化、识别边界及金额/币种/Excel 生成主链回归；bill-split 仍沿用原文件重建语义 |
| 语法与 diff 基础检查 | `main.js` / renderer / preload / policy `node --check` PASS；`git diff --check` PASS | 接线语法和空白错误 |
| review follow-up 聚焦回归 | statement preview + tracker 27/27 PASS；大账号既有 27/27 PASS；statement-generation-pipeline 45/45 PASS；smoke PASS | bill-split raw rebuild、伪币种告警清理、probe 后 freshness、main-only 决策复用、complete 单调用及保存失败告警、prepared 输入归档 |
| position P0-B lifecycle 聚焦 | interactive handler/lifecycle 7/7 PASS；policy 13/13 PASS | run selection/replace confirmation 在 prepare 截停，opaque renderer payload，确认后一次 BOR/reserve/execute；source picker/account-only 取消 0 batch，ordinary/mixed 一次真实 execute；reserve 或 position outer 拒绝时 abandon 且 0 apply |
| position service / import 回归 | service 66/66 PASS；operation lifecycle + legacy characterization + streaming preflight 75/75 PASS | legacy/streaming account-only、ordinary、mixed 最终语义；文件级事务、staging、grant、checkpoint、账户 token 与既有匹配/金额逻辑不变 |
| position side-DB integration | 38/38 PASS | 真实侧库导入、运行、确认与 checkpoint parity 回归 |
| position run P1 读取成本回归 | service 66/66 PASS（既有真实运行用例新增计数断言） | prepare 1 次 COUNT、0 次 `getBankRows`；execute 不重复 COUNT 且恰好 1 次全量读取，原错误码/算法/确认 freshness 不变 |
| position renderer 既有契约 | 27/27 PASS | 恢复必须从 pending 取得原 `batchContext` 并调用 `persistAppendIntent`；禁止 create/guess batch，旧 `persistOperationIntent` 字面量契约已退役 |
| worker context + lifecycle/position 聚焦单测 | 175/175 PASS | 7 字段 structured clone/refreeze、Pending/BizOp 真实 utility、Acquiring run-check + nested M=1/2/4、Position source START/grant 边界及 bank/account/schema/maintenance dispatcher 继承 |
| worker engine/legacy 迁移集成 | Pending 57/57 PASS；BizOp flow 65/65 PASS；Acquiring 45/45 PASS | default engine 与可达 legacy utility 继承父 context，既有导入结果、事务和错误 parity 不变 |
| lifecycle policy 接线 + 静态边界 | TaskPolicyRegistry 13/13 PASS；`git diff --check` PASS；worker reserve/`settleArtifacts` 静态扫描无命中 | scoped object handler 仍由受控 lifecycle 执行；worker 不 reserve、不持有 lifecycle control；PR3 handoff inventory 未扩张 |
| acquiring crash/resume P0-D + reviewer P1 聚焦单测 | 164/164 PASS（10 suites）；直接受影响 lifecycle/policy 41/41 PASS | 原 P0-D 覆盖外，新增 stale legacy existing 不 recover/fail，以及同 runId 跨月、legacy main/side result identity 与 flowPlan 一致 |
| acquiring crash/resume 集成回归 | engine migration 45/45 PASS；side-DB parity 19/19 PASS | runCheck SQL/算法/checkpoint/事务/金额币种语义与 per-month side DB 结果不变 |
| acquiring crash/resume 静态检查 | `npm run lint` PASS；相关生产/测试文件 `node --check` PASS；`git diff --check` PASS | 接线语法、lint 与空白错误通过；TaskLifecycle 仅调整指定 legacy existing 分支顺序，未改 worker protocol、runCheckCore |
| PR2 archive UI 静态契约 | 18/18 PASS | `settleArtifacts → settlePositionArchiveResult → return` barrier 与 Position `settle → checkpoint/bootstrap → clear current pending → cleanup` 顺序锁定 |
| Position P0-E 六文件聚焦回归 | 169/169 PASS | archive UI、renderer、position recovery lifecycle/service、controller outbox 与 stateless tracker；direct/outbox 均追加并终结原 batch，未提交 staging 只在 ownership clear 后释放 |
| Position P0-E 行为与 side DB 回归 | 87/87 PASS；side-DB parity 38/38 PASS | streaming preflight、interactive admission、legacy import characterization、TaskLifecycle，以及真实 side DB checkpoint/恢复行为不变 |
| Position P0-E inventory/静态门禁 | policy + module scope 17/17 PASS；`npm run lint`、相关 `node --check`、`git diff --check` PASS | 12 primary scope、literal IPC、reserve/exclude/PR3 handoff inventory 无旁路；生产与契约文件语法/格式通过 |
| PR2 完整 unit 首轮两项收口 | 首轮 4906/4908；原失败两文件修后 13/13 PASS，直接相关 9 文件 90/90 PASS；lint、相关 `node --check`、`git diff --check` PASS | 两项均为测试陈旧而非生产旁路：Position 锁断言未容忍格式化换行；DuplicateInbound 抽取 harness 未注入 `ipcMain`/未执行真实 prepare-execute contract。仅更新测试，生产代码未改 |
| PR2 完整自动门禁 | `npm run release-check` exit 0；unit 4908/4908；48 个 integration 脚本 2459/2459；smoke、lint PASS | PR2 lifecycle、worker、archive、既有业务导入/对账/输出的完整自动回归通过 |
| PR2 提交前 check-vars | `npm run check:vars -- --include-minor` exit 2（命中需 review，不是测试失败）；Critical 5、Important-skeleton 8、Runtime-state 9、Risk-sensitive 3、Minor 4 均完成逐项判定 | 模板常量、错误 schema、资金算法、行守恒、一次性迁移均未改变；真实变更限于 lifecycle/context/freshness/精确恢复接线，详下节 |
| PR2 Windows CI runner follow-up | Actions run `31360364725` 在 smoke PASS 后以 `spawn ENAMETOOLONG` 停于 unit runner；314 个绝对测试路径参数约 35,544 字符。改为仓库相对参数并固定 child cwd 后，直接测试 11/11 PASS；独立完整 `npm run release-check` exit 0：lint/smoke PASS、unit 4909/4909、48 个 integration 脚本 2459/2459（总耗时 399674ms）；语法/diff check PASS | Windows 命令行长度环境差异，不是业务生产回归或陈旧测试；仍保持单次 `node --test`、coverage flag、文件集合/顺序、实时输出、汇总与日志语义 |

PR2 可承担的实现、静态 inventory 与自动门禁已经收口；GUI、真实 Electron 崩溃/重启及资金结果人工复核仍未执行，因此不据此宣称 PR2 人工验收完成。

### PR2 Remaining Unknowns

| 未知 | 处理 | 负责人/下一步 | 合并影响 |
| --- | --- | --- | --- |
| bill-split 的 `currencySourceField` 覆盖与合并币种不一致在真实工作簿上的结果 | 🔴 资金红线人工复核 | 用户测试按 P0 清单验证“所选币种 ≠ 拆分币种”样例及合并不一致提示 | 自动测试已锁 raw rebuild 调度与 45/45 pipeline；合并前仍需人工确认实际 Excel 输出 |
| position 真实 GUI 人工确认 | 🔴 资金红线人工复核 | 用户测试 account-only 取消、mixed ordinary 保留、旧 pending run 替换各一例，并核对存档中心批次数 | 自动测试证明计数/DB 事实；资金模块危险确认仍需人工核对实际 UI 与数据 |
| worker context 的运行时可观测性 | ASSUME / 人工抽查 | 当前协议只继承身份，不新增日志/UI；用户测试任选一个 utility 与 nested worker 退出/取消路径核对业务结果 | 自动测试已证明真实消息拓扑；若需要现场追踪应在后续可观测性任务设计，不能把 lifecycle controls 送入 worker |
| acquiring 真实崩溃/重启与取消路径 | 🔴 幂等/资金红线人工复核 | 用户测试分别用 side new-format、升级前 legacy partial 和 worker 退出/取消各一例，核对原 batch、序号、offset、main mirror 与输出 | 自动测试已锁 identity、reserve/backfill/reopen 和 side/main 路由；真实 Electron 进程边界未在本子阶段人工执行，未复核前不能宣称 PR2 整体完成 |

### ⚠️ 关联功能 review

- 扫描结果：`npm run check:vars -- --include-minor` exit 2；该退出码表示命中强制 review 层级。命中为 Critical 5、Important-skeleton 8、Runtime-state 9、Risk-sensitive 3、Minor 4，逐项结论如下。
- Critical：`FILENAME_MAPPING_TEMPLATE_ID` 与 `FIXED_FIELD_VALUE_PREFIX` 的值、解析和历史模板契约未改，只是网银 prepare/execute 抽取后的引用迁移；`FileValidationError` 类及 `code/message/detailLines/context` schema 未改，prepare 仍抛同类校验错误；`runCheckCore` 只新增 `batchContext` 持久透传，SQL、阶段顺序、chunk/offset、取消边界和输出算法未改；`unmatchedRows` 只用于既有结果快照和 side resume 成功后的 main mirror，dispatcher 反向 filter、行数守恒和 writer 去内部字段逻辑未改。
- Important-skeleton：`ipcRenderer` 的真实变化仅为 scenario import 与大账号取消改传 main-only opaque `contextId`，main/preload/renderer 已同步并有契约测试；Position `saveMappings(mappings, batchContext)` 只把父任务 context 传入既有 streaming maintenance/worker，store 的映射校验和事务未改；`parseDateValue`、`parseNumericValue` 是手动余额预检的等价抽取，`getTemplate`、`loadEnumValues`、`normalizeCell`、`readRows` 是 prepare/execute 调用重排，底层实现、签名、日期/金额/读取语义均未改。
- Runtime-state：`archiveOperationTracker` 的真实变化是移除活动批次内存，收敛为 TaskLifecycle 当前批次的 stateless resolver/append adapter；其本地 `MODULES` 改由集中 `module-scope-registry` 解析 12 primary scope 与内部 alias，renderer 模块枚举未改。`dialog` 调用前移到 reserve 前的 prepare，并保留取消 0 批次；`bankStatementSession`、`statementImportSessions`、`processingResult`、`lastGeneratedExports` 只增加 prepared snapshot/freshness 校验，结构、清空时机和非持久化生命周期未改；renderer `state` 字段未变。`app` 来自 policy 中 `app:*` 通道字符串的词界命中，Electron 启动/退出 hook 未改。
- Risk-sensitive：`cloneRowsWithMetadata` 与 `normalizeInputFilePaths` 的实现未改，分别以原语义用于 prepared 行克隆和 `dedupe:false` 输入路径归一；`splitTemplateName` 命中的是 balance-seed helper 调用，不是 own-account 一次性迁移实现，`MIGRATION_FLAG_KEY` 与迁移流程未改。没有金额、币种、匹配、行过滤或输出列契约变化。
- Minor：`getStatementSessionEntries`、`loadEnumValues`、`getSetting` 为 helper 调用重排；`setSetting` 的真实顺序变化只涉及 Position 恢复在 archive durable 后清 checkpoint/bootstrap/current pending，再释放当前 operation 未提交输入，已有 ownership fail-closed 与 lifecycle 测试覆盖。
- 验证：完整 `npm run release-check` exit 0；unit 4908/4908；48 个 integration 脚本 2459/2459；smoke、lint PASS。仍待人工验证真实 Excel/WPS 账单结果、Position GUI 危险确认，以及 Acquiring Electron 崩溃/重启/取消。

## PR #133 九条 P1 评论 Implementation Notes（实施前）

### Restack Evidence

- PR2 已安全 restack 到 PR1 `4933b7b4a8be73313cffce15c7f84fd021811eaa`，merge-base 精确相同。
- commit mapping：`be5cfba → 80d6567`，`1687cfa → 8f609a9`；Windows unit runner 的 repo-relative args/cwd 修复保留。
- 冲突逐项合并了 PR1 tombstone、deleted Position staging、artifact evidence 与 PR2 lifecycle/controller/main/docs；未使用 whole-file ours/theirs。
- restack 后聚焦 7 个文件、109/109 PASS；`node --check` 与 conflict diff check PASS。tracked clean 时仅存在用户原有 untracked。
- review `#4897404953` 共 9 个 thread，重读结果全部 `unresolved=true`、`isOutdated=false`。

### Decisions

| ID | 决定 | 代码证据 | 放弃方案/约束 |
| --- | --- | --- | --- |
| P1-1 | 用现有 archive outbox 保存原 batch terminal outcome；terminal-only 写入只规范化完整 7-field context，不读取 archive/settings DB；同 operation files/terminal 原子合并，flush 在文件 durable 后精确 CAS | 非 benign terminal failure 时 archive DB 可仍不可读；filesystem outbox 与 `targetBatchId` 可独立跨重启重放 | 不增表、不建第二 tracker、不新建 batch、不加 timer/无限 retry |
| P1-2 | fresh acquiring run 的 DB/month admission 与现有月锁移到 object `prepare`，用幂等 release 同时接 `onAbandon` 与 execute `finally` | resume handler 已验证同一模式；fresh handler 当前只在 execute 取锁 | 不改 worker pool、runCheck 算法或 cancel protocol |
| P1-3 | export 只从 prepared 主镜像和精确 side/main run evidence 构造既有 acquiring flow identity；side 必须唯一且逐字段吻合，result identity 复用同一证据 | side fresh run 每次先 `clearRunsByMonth`；主镜像持有 side path/summary/status/output paths；当前裸 mirror ID 与 side run ID 不同 | 不用 latest side run 猜测，不把 export 建成新 parent |
| P1-4 | Position recovery terminal conflict 只有 actual 与 wanted 相等才幂等接受 | 当前 boolean `existingTerminal` 接受三种任意终态，finalizer 随后会清 pending | 不改 repository CAS；不一致时保留原 pending/checkpoint |
| P1-5 | mutating START 强制 7-field context；普通来源 START 保持预检无 context，但进入写入的 APPLY_GRANTED 强制 context | worker command 集合明确区分 BANK_PREPARE、schema-only 和五个写命令；source apply 已有 grant 屏障 | 不改变 protocol version；read-only/preflight/schema-only 不强塞 context |
| P1-6 | scenario context store 增加 read-before source evidence，create 在 parse 后立即对同一 evidence 重校验 | 当前 `create()` 首次 stat 已在 read/parse 之后 | 不做 hash/临时副本；沿用 stat freshness 与 apply/beforeStart 二次检查 |
| P1-7 | assignment rowIndex 必须是 server expected index 的 exact unique set，再沿用账号/币种校验与排序 | 当前只比较 length，重复 index 会在后续 Map 折叠 | 只拒绝真实 `[0,0]`/`[0,1]` 反例，不改变正常乱序 |
| P1-8 | statement 用 picker paths guard 固定 duplicate/hash 决策输入，每次 confirm 返回先复核，resolver 返回后再复核整个窗口；随后另以最终 filePaths 建 source guard | 只在 modal 返回检查会漏掉无 duplicate modal 的 hash 期间变化；单一 guard 又会让已移除输入继续影响 execute | 不改 session/replace 算法，不引入 lease/retry |
| P1-9 | resume 识别有持久 context/输出证据的 side complete run；0 worker 对 stale main mirror 复用 canonical upsert，exact current mirror no-op，返回原输出供 tracker/TaskLifecycle 收口 | progress context 与 run/output 已在 side DB 持久；崩溃时 main 可合法保留上一轮 mirror | legacy complete/context 缺失、输出路径/文件缺失均 fail-closed；不扫描 latest、不分新号、不建启动恢复器 |

### Assumptions / Non-goals

- outbox 是 P1-1 唯一新增持久意图载体；若 artifact retry 与 terminal retry 同时存在，必须落同一 operation record，不能让后写覆盖前写。
- P1-9 的 `complete` 只代表 SQL chunk 完成，不单独证明 writer 完成；必须同时验证 run 成功状态、持久 output paths 和实际文件，才可返回成功恢复结果。
- P1-5 account-only/preflight-only grant 不写 DB，保持无 context；只有 `preflightOnly !== true` 的 APPLY_GRANTED 是写入边界。
- PR3 VCC/toolbox、目录物化、存储迁移、UI redesign 以及真实 Electron 自动 crash harness 均不进入本轮。

### Remaining Unknowns

无实现 BLOCK。P1-1 选择现有 outbox 合并 terminal outcome，P1-9 选择现有 resume/lifecycle；若实现证据迫使新增 schema、second tracker 或 latest fallback，必须停止并重新评审，不能静默扩大状态模型。

### Implementation Evidence（2026-08-11）

- P1-1：terminal-only 写入先用完整 7-field context 规范/校验 identity，再把 operationKey、targetBatchId 与 terminal outcome 原子合并进同一 files outbox record；repository/settings DB 均不可读时仍只靠 filesystem durable。Position route 的 operationToken 只从明示 afterTerminal 写入 record metadata，generic terminal 不猜 route。flush 顺序固定为 artifact→CAS→finalizer→remove；terminal 与 intent 双失败时以 `ARCHIVE_TASK_TERMINAL_INTENT_FAILED` fail-closed。
- P1-2/P1-3：fresh acquiring run 的 admission/月锁已移到 object prepare，abandon/finally 共享幂等 release；export 只以 prepared side/main evidence 构造 `acquiring-run:${source}:${monthKey}:${runId}`，证据不唯一或不吻合时在 copy/reserve 前拒绝。
- P1-4/P1-5：Position recovered terminal 只接受 actual/wanted 相同的幂等冲突；worker 恰好对 BANK_APPLY、ACCOUNT_APPLY、DELETE_BANK、DELETE_SOURCE、REBUILD_FUND_TRANSFER_MAPPING 五个 START 强制 context，普通来源仅在 mutating APPLY_GRANTED 强制，schema/read/preflight-only 不扩大。
- P1-6/P1-8：scenario 在读取前 capture stat、context create 内读后复核并保留 beforeStart；statement selection guard 覆盖 picker paths，在每次 duplicate confirm 和 resolver 返回后复核，最终 source guard 只覆盖 selectionResult.filePaths/preview/beforeStart。
- P1-7：assignments 必须形成与服务端 expected rows 相同的唯一 index 集；`[0,0]` 对 `[0,1]` 在生成/Map 前以 `BIG_ACCOUNT_SELECTION_INVALID` 拒绝，正常乱序仍排序。
- P1-9：side complete 只有持久 7-field context、success run 与两份现存 output evidence 完整时可恢复；0 worker 沿 canonical upsert 替换上一轮 stale main mirror，exact current mirror no-op。真实 TaskLifecycle 把两份输出登记到原 batch 并终结 succeeded，batch 序号不增；legacy complete 缺 context 保持 fail-closed。
- Restack 接线复核：PR1 新增的 deleted Position recovery lookup 曾引用已被 PR2 scope registry 收敛移除的 `positionArchiveModule`；现从该 pending channel 的 exact task policy 读取 `scopeId`，未知 channel 继续 fail-closed，不恢复旧 helper 或复制 scope 映射。
- 聚焦证据：Phase A lifecycle/controller/outbox 52/52 PASS；Acquiring run-data 18/18 PASS；Phase B worker/Position/scenario/statement 151/151 PASS；大账号/statement 11/11 PASS；最终 12 个实际改动测试文件合跑 273/273 PASS。完整自动门禁见下项；真实 GUI/Electron crash 验收仍按 test-spec 人工门禁待执行。
- Final review follow-up：controller/acquiring/statement 三文件 49/49 PASS；outbox/lifecycle/policy/run-worker 相关四文件 66/66 PASS；相关 `node --check`、`npm run lint`、`git diff --check` PASS。未新增 timer/retry/批次扫描或测试框架。
- Final gate `check-vars -- --include-minor`：exit 2 仅命中 Critical `FileValidationError`、`unmatchedRows`。前者只用于新增 assignment exact-set 拒绝，沿用既有 `code/message/detailLines/context` schema 与 catch/writer；后者只用于 Acquiring completed-run summary evidence/canonical main mirror，未改 scenario-dispatcher/reconIdFix 两条同名流水线、`modifiedRows + unmatchedRows = bankRows` 守恒、writer 去内部字段或 runCheck SQL/币种金额算法。按清单必跑 smoke 纳入完整 release-check；真实 Excel/WPS 资金输出仍保留人工门禁。
- Final release-check：首轮 lint/smoke PASS，unit 4921/4922；唯一失败是 `archive-center-ui-contract` 仍按已替换的旧 Position finalizer 函数名截取源码，判定为陈旧静态测试并只对齐 `finalizePositionTerminalIntent`，未改生产。修正后单一 session `npm run release-check` exit 0：lint/smoke PASS；unit 4922/4922（314 files，0 fail/skip）；integration 48/48 scripts、2459/2459 assertions PASS（304260ms）。runner 全绿后自动刷新 `rules/integration-test-policy.md` §七的 timestamp/timings，脚本与断言数未变，按生成证据约定保留。
- Windows CI follow-up：Actions run `31416514064` 的 smoke 已通过，unit 唯一失败为 statement 静态顺序测试以 LF 字面量定位 `createPreviewSourceFreshnessGuard`，Windows CRLF checkout 令索引为 `-1`；生产顺序与行为未失败。该测试现以行尾/缩进无关 regex 定位同一 final accepted-path guard，不加 platform branch、retry 或 timeout。单文件 11/11、12 个改动测试文件 273/273、lint/node/diff check PASS；修正后本地单一 session `npm run release-check` exit 0：unit 4922/4922，integration 48/48 scripts、2459/2459 assertions PASS（283436ms）。

## PR2.5-0 纠错 Spec / TechDoc 合同冻结（2026-08-11）

### Baseline

- Goal/spec：[`changes/3.1.8/erratum/README.md`](../3.1.8/erratum/README.md) 所索引的纠错 Spec v2 与 TechDoc v1.1。
- Initial plan：从 PR2 冻结头 `54b6c01fa93751cd723be53af70af726037343b5` 开始，仅做九个文档文件的合同冻结与 v3.1.9 窄 erratum。
- Done when：来源与转换可复核、严格 PR 顺序唯一、PR1/PR2 证据保留、全部剩余 PROBE 和人工资金门禁明确未完成。

### Decisions

| 决定 | 原因与证据 | 放弃的方案 | 影响 |
| --- | --- | --- | --- |
| 保持 `changes/3.1.8/spec.md` 原 SHA，补遗进入独立目录 | 原 Spec 是已发布合同并被 release-docs 测试锁 hash | 直接 append 已发布 Spec | 历史发布证据不变；PRD 增加前向补遗入口 |
| raw source 只做 12 处 hard-break 等价格式转换 | 两文档各 6 个 header 行尾双空格会让全量 diff-check 失败 | 逐字节复制并声称 diff-check 通过；顺手格式化全文 | 同时记录 raw/repository SHA，并用 normalization-only diff 证明正文不变 |
| 只替代 VCC 归档兼容、操作保护和性能路径 | 纠错 Spec v2 §10.1 明确为窄 erratum | 重写 C01—C14 或 PR1/PR2 | 既有全局批次和生命周期合同保持 |
| 将后续链拆为 A/B/C1/C2、PR3-VCC、PR3-Toolbox 严格串行 | TechDoc §18 冻结所有权和依赖顺序 | 延续合并 PR3 或并行开发 | 后序只从直接前序冻结头开始；PR2 变化触发整链 rebase |
| 本 PR 不改三份发布用户文档 | 无新二进制或用户行为落地；版本文档同步属于 PR7 | 提前写 CHANGELOG/手册并暗示已实现 | 避免把合同冻结误写为发布事实 |

### Assumptions

无资金、兼容或公共接口假设。仓库目录命名和索引形式是低风险、可回滚的文档组织决定；合同正文、来源 SHA 和实际采用基线分别留证。

### Deviations

| 原计划 | 实际方案 | 原因 | 影响 | Spec 已同步 |
| --- | --- | --- | --- | --- |
| 外部 Spec v2 §10.1 写“向 `changes/3.1.8/spec.md` 追加补遗” | 冻结原 Spec，使用 `changes/3.1.8/erratum/` 并由 v3.1.8 PRD、v3.1.9 Spec 互链 | 原 Spec SHA 是已发布证据且有自动测试硬锁；评审已批准独立目录 | 仅改变仓库归档位置，不改变任何产品合同；前向补遗更清楚地与历史发布隔离 | 是 |

### Evidence

| 证据 | 结果 | 覆盖的行为/风险 |
| --- | --- | --- |
| raw source SHA-256 | Spec `34778f...17fcf1`；TechDoc `08e9f9...84549` | 来源身份与用户给定权威值一致 |
| repository copy SHA-256 | Spec `c4354a...c1773`；TechDoc `363533...85b3c` | 仓库副本身份可固定复核 |
| 仓库化 transformation | 两份文档各 6 个 metadata hard-break 从行尾双空格改为 `<br>`，共 12 处 | 不把格式 normalization 冒充 raw byte identity；正文合同不变 |
| v3.1.8 frozen Spec baseline | `1f5f0663ee35436c8b1f7da628822a4f83a3f70db215cd5ebd60a6720bae367d` | 补遗没有追溯改写发布合同 |
| normalization / link / Markdown gate | 只读 normalization 后两份副本 2/2 无差异；九文件本地链接 17/17；tracked diff 与三个新文件分别通过 diff-check | 12 处转换之外无正文漂移，仓库链接与空白门禁可复核 |
| 冻结发布文档定向测试 | `node --test tests/unit/vcc-financial-op-release-docs.test.js` 5/5 PASS；原冻结 Spec 与三份发布用户文档零 diff | 已发布 v3.1.8 hash 与 `6/6 PASS` 历史证据未改写 |
| 提交前 check-vars | 负责人执行 `npm run check:vars -- --include-minor` exit 0；HEAD+working tree 的 `src/` 无改动，脚本 skip | 零变量命中，无需关联功能 review |
| blindspot / reconciliation pass | 未发现需新增防御、兼容矩阵或自动资金结论；PR2 manual、真实 fixture/旧库、packaged runtime、16 GB 与财务人工均保持未完成 | 文档冻结不冒充实现/发布；资金红线仍由人工门禁阻断 |

本 PR 未运行完整 `release-check`；以上只记录本次 targeted docs evidence，不重复宣称 PR1/PR2 的既有全量门禁为本 PR 新证据。

### Remaining Unknowns

| 未知 | 处理 | 负责人/下一步 | 合并影响 |
| --- | --- | --- | --- |
| PR2 GUI、真实崩溃/重启和资金人工验收 | PROBE / 人工 | 用户按 PR2 P0→P1 清单执行 | 整组 merge gate；失败则整链 rebase/重验 |
| 真实 v3.1.7 fixture、目标 legacy-four 与生产 trigger | PROBE | A 阶段生成真实 fixture；上线前完整副本只读 inspect | 不符不放宽 classifier；阻断对应合并/发布 |
| packaged runtime `createSession/readOnly/query_only/UPDATE FROM` | PROBE | C1/C2 与 Windows installer/portable feature test | 不可用则阻断，不降级无保护提交 |
| 约 16 GB 性能与财务人工复核 | PROBE / ⚠️ 人工资金红线 | B/C 性能报告；财务逐主体×九币种、跨月和审计复核 | 阻断发布；自动测试不能替代 |

## PR2.5-A 兼容合同 Implementation Notes（实施中）

### Decisions

| 决定 | 证据 | 放弃方案/约束 |
| --- | --- | --- |
| A 只新增四个纯合同模块 | 当前 `unarchive.js` 把 SQL/state/classifier/gate 耦合；TechDoc 把集合读取明确归入 B | 不改现有 unarchive/result/service exports，不提前做 loader/worker/token/cache |
| result evidence 从 raw rows 重算 | 现有 `result-adjustments.js` 已冻结 rowKey、金额、sequence、metadata、基础/有效余额语义 | 复用 `buildRunRowKey`、金额和九币种语义；不相信 SQL boolean 摘要，不逐 run 查询 |
| 通用结构检查先于 current/legacy | TechDoc §5.2 要求通用失败直接 inconsistent | 不做 current 失败后 legacy fallback，不按 app version/time/file name 猜测 |
| fixture 由生成器真实运行 tag | Phase 0 证明 importer 四类、期初、计算、归档链可达 | 不用当前 schema 手工 INSERT，不从临时 probe 复制后二次修补 |
| manifest 的 DB SHA 是 generation-time 证据 | tag 使用 SQLite localtime，跨时间重生字节可能不同 | 不宣称跨次 DB SHA 恒定；输入 workbook hash只记录本次 provenance，不作为跨次稳定断言 |

### Phase 0 Evidence

- tag close/reopen：schema hash `7d77867f868356074eec0c4428c332ca7f0d36cd770334edc58b28eb9c6a5cb7`，DB SHA `ff6edac077fa9f4f13a72ab2e509e4ccefa01729e869b7a6b9430f1661ca994c`；四 datasets、三 effective/run rows、九 balances、一个 archive，Pending 全 0，adjustment 表尚不存在。
- current VCC migration close/reopen：schema hash `a6a7b42c08db101b24930ce805580ce1d1adc7e35ee53de17796248bb27fcb05`，DB SHA `438a8952d6e21b3b56eac329d0560c514a3b6ac7a3443edb2793ba1c3c06b3d4`；业务 counts/金额不变，新增 result revision 0、SQL NULL fingerprint、adjustments 0。
- 首次临时输入失败分类为测试设计错误：方向 token 应为 `in/out`，中文值被 tag importer 正常拒绝；生产合同无需修改。

### Deviations

无。当前实现边界与 TechDoc v1.1、负责人批准的 ownership 和 10 个 top-level 测试计划一致。

### Remaining Unknowns

- tracked fixture/manifest 尚待生成器重新生成，Phase 0 临时 SHA 仅作原型证据。
- 真实旧库、Windows packaged runtime、约 16 GB 和财务人工复核仍未完成；均不得由 A 的自动测试替代。

### Phase 1 Evidence

- tracked 生成器重新生成 raw fixture/manifest；generation-time DB SHA `6de511e630c420b60fa5dc1d858fd0cd40fb7261b33503756abf6dba6b57952b`。跨时间 SHA 与 Phase 0 不同，符合 tag SQLite localtime 事实，没有回写时间或伪造确定性。
- `buildArchiveEvidenceV2()` 只排序/派生 rowKey/调用纯 validator；`validateEffectiveResultEvidence()` 从 raw rows、adjustments、stored balances 重算 sequence/revision/base/effective 九币种；classifier 先做通用合同，再按 exact dataset set 进入唯一 current 或 legacy 分支；gate 只消费 contract result 和 UnarchiveGateEvidence。
- 静态盲区检查确认四个新生产文件无 SQL、DatabaseSync、loader/worker/token/schema/cache、现有 production consumer 或 task 状态读取。`archive-state-inconsistent` / `dataset-archive-state-mismatch` 中的单词 `state` 触发 check-vars Runtime-state 扫描，但未定义或修改 `src/renderer.js` 全局 `state`，属于可忽略同词命中。
- reconciliation 检查锁定 run/dataset/archive FK、rowKey metadata、subject×currency 唯一、sequence/revision、基础公式、有效余额和 archive 对账；A 零写入、零部分提交。真实主体/九币种/跨月资金复核仍为人工红线。
- Root diff review 的 P1 metadata probe 把物理可为 NULL 的 `run_rows.source_type` 置空后，发现 evidence builder 在 validator 前抛出既有 `invalid-run-row-metadata`。修复只收敛该精确错误为缺失 rowKey sentinel，并按既有 nullish metadata 语义交给 result validator 记录 violation；其它异常继续抛，classifier 对损坏证据结构化归 `inconsistent`。
- Root diff review 的 P1 provenance 修复在 A-05 现有正例内同时核对当前 generator 文件 SHA、manifest `generator.sha256` 和 fixture generation-time DB SHA；脚本变化必须重新生成 manifest/fixture，不新增 top-level 测试。
- Review 修复首次聚焦 17/18：唯一失败是新增 classifier 断言误要求只有一个 reason；缺失基础行同时令 effective archive 金额不符，生产正确返回 `effective-run-result-invalid` 与金额 mismatch，分类为测试设计错误。断言收窄为 review 要求的“不抛、包含通用 reason、contract 为 inconsistent”，未放宽 classifier。
- 修正后聚焦 18/18 PASS（仍为 10 个 top-level，A-02 八个 table-driven 子项）；相关 `node --check`、`npm run lint`、`git diff --check` PASS。复跑 check-vars 仍只命中 reason/code 中的 Runtime-state 同词 `state`，无代码变量或关联功能变化，沿用既有人工 review 结论。
- `targetMonth` 被手工错配属于 B loader 尚未接线时的 Service 可构造反例；TechDoc 已要求 B 按 `target_month/run_id` 分组，本 PR 不添加无真实入口证据的 guard/test，留待 B 接线 review。
- 完整门禁首轮 lint/smoke PASS、unit 4940/4940，integration 47/48；唯一失败为既有 `toolbox-large-split-multi-sheet` 的 tier2 RSS 样本 `[150,135,135]MB` 含一个恰等于严格 `<150MB` 上限，30/31。独立原脚本复跑 31/31（tier1 `[88,88,87]MB`、tier2 `[137,133,137]MB`），分类为环境边界采样，不改阈值、不加 retry、不修改生产或测试。
- 第二次完整 `npm run release-check` exit 0：lint/smoke PASS；unit 4940/4940（317 files，0 fail/skip）；integration 48/48 scripts、2459/2459 assertions（311123ms）。runner 全绿后自动刷新 policy §七 timestamp/timings，总数不变并按生成证据保留。

### Remaining Unknowns（收敛后）

- 目标真实生产旧库 legacy-four/trigger、Windows packaged runtime、约 16 GB 与财务人工复核仍未完成；阻断对应 merge/release，不影响 A 纯合同代码 review。

## PR2.5-B 读取性能 Implementation Notes（实施中）

### Decisions

| 决定 | 证据 | 放弃方案/约束 |
| --- | --- | --- |
| read/write 使用物理分离 entry | 现有 `worker-entry.js` 打开可写连接并运行 migration；action 配置错误会扩大权限 | 新 read entry 先校验 allowlist，再以 readOnly/query_only 打开；不复用可写 entry 的 `openDb()` |
| B 零 schema migration | TechDoc 已确认现有 `idx_vcc_fin_op_effective_month_source` 足够，负责人锁定本方案不新增 schema | schema-ready 只断言现有表/列/PK/index；其他表允许一次 set scan，16 GB 不达标则保持 PROBE 并反向同步合同 |
| archive set loader 保持 A 纯模块不变 | A 已冻结 evidence builder/validator/classifier/gate 为零 SQL 的唯一语义 | 新 SQL 进入独立 `read-snapshot.js`；不把 loader 混入 A 文件，不逐 run 调 `getEffectiveRunResult()` |
| 导出两次读取都消费 B snapshot | current/legacy 可枚举但二次重查若回到旧 current-only state，legacy 仍不可导出 | 初次对话框读取和现有 `runDirectTask` 内重查复用同一 read action/loader；只复用 activeTask/taskGeneration，不新造 claim/lease/timer |
| B 正式生成 token v2，旧 v1 write 中间 fail-closed | C2 才拥有 write lock 下同源 v2 重算；兼容桥会形成弱保护 | B/C1 intermediate non-release；只保留一条生产链 0-DML 证据，不改旧 write，不为 target 建重复矩阵 |
| 删除目标响应就是 preview cache | TechDoc §10/§14 要求共享 DeleteEvidenceV2 后内存派生，target change ≤50ms | renderer 切 target 零 IPC；month/state-changed/refresh 失效整批 cache，submit 仍携 token+generation |

### Remaining Unknowns

- Windows installer/portable 的 worker、readOnly 和 query_only 行为仍为发布 PROBE。
- 约 16 GB 真实副本的冷/热 P95、WAL 与 main event-loop lag 尚未执行；小 fixture 只作 gross regression，不关闭该项。
- 目标生产 legacy/trigger、主体×九币种、有效余额、跨月依赖与备份恢复仍需人工复核。

### Implementation Evidence

- `read-schema.js` 只读断言 current migration 已存在的必要表/列/PK，以及唯一性能硬依赖 `idx_vcc_fin_op_effective_month_source`；真实 read handle 设置 `readOnly/query_only/foreign_keys/busy_timeout`，没有调用 migration/recovery/journal mode。unknown action 在开库前 allowlist 拒绝。
- archive loader 固定 10 个 set query，在同一 `BEGIN DEFERRED` 内按 target_month/run_id 组装 A 的 raw evidence；0/1/100 候选 SQL 数不变，trace 零 `vcc_fin_op_import_rows`、零 opening。query-plan 盲区 probe 首次发现 Pending effective 查询会按 source-leading unique index 扫描全 source 并建 GROUP 临时树；实现随即收窄为 candidate-first `CROSS JOIN` 并显式使用现有 month/source covering index，EXPLAIN 硬断言禁止 fact scan，未增加 migration/index。
- current 与真实 migrated v3.1.7 legacy 都经同一 A builder/validator/classifier 枚举；active/importing 只改变 gate；破坏 archive 后月份从列表排除并返回 event/month/hasEvidence/reasons 诊断。真实 legacy 初读和既有 `runDirectTask` 内二次重查都可到达既有 writer，文件写出逻辑未改。
- Main 捕获 generation 与 active task 对象 identity，read worker 返回后精确复核；active month cache 只按 generation 复用，任一写任务 release 后失效。没有新增 claim、lease、timer、TaskLifecycle 或 worker batch context。
- DeleteEvidenceV2 固定 9 SQL 派生五 source、opening、result 完整 preview；renderer target change 只选 cache item，1000 次七目标函数级切换低于 50ms。数据管理在任一 backend await 前挂载 month/archive loading 与 content skeleton，失败保留 modal + inline retry，成功/破坏性完成只执行一次 months/archive/section refresh。
- 生产 preview 已正式生成 v2；唯一真实 service delete 链证明旧 v1 write 返回 `state-changed`，effective/run/dataset 三张业务表不变且无 success evidence。旧 worker 允许留下 rolled_back 诊断；既有 v1 成功/取消/保护测试改为显式 legacy helper，记录合同时间点变化，不建立 v1/v2 bridge。
- 首次旧测试迁移为 33/41：一条 renderer 静态断言仍要求逐 target preview，七条 service 测试仍把 async read 当同步或假设生产 v2 可提交旧 write，均分类为合同时间点变化。专属测试首次 4/6 的两项失败是 opening 测试夹具误用旧列、effective fixture 缺 NOT NULL import_record_id；修正夹具后生产代码未放宽。后续陈旧 current 集成夹具因空 revisions/非 SHA fingerprint 被 B classifier 正确排除，补成真实 current evidence 后收敛。
- 当前相关自动证据：B-01—B-12 专属 12/12；A/B 合同、service、旧 destructive 保护与 renderer 聚焦合跑 158/158；显式 legacy 破坏性链 64/64、历史 current/legacy 导出链 28/28。15 个本次 JS 文件 `node --check` 与 ESLint、`git diff --check` 均通过。
- 性能脚本在 current migration 后的 tracked v3.1.7 legacy fixture 上复跑 5 次：archive/active/unarchive preview/delete 的 SQL 数分别稳定为 10/1/13/9，WAL 0→0，最大 main lag 1.760 ms；worker P95 分别 6.661/0.130/2.221/0.780 ms，并独立报告首个与后续样本。该结果只用于结构硬门禁和小 fixture gross regression，不关闭真实约 16 GB、Windows packaged 冷/热 P95。

### Blindspot / Reconciliation Pass

- 真实入口逐段复核为 `renderer-vcc-financial-op → preload 既有 channel → main async IPC → service generation/activeTask 复核 → 独立 read worker → readOnly DB`；没有保留 renderer/IPC 可达的旧 archive/current-only loader 旁路。导出在 picker 初读与 `runDirectTask` 内二次重查均走同一 B action，current/legacy 都到既有 writer。
- 权限/失败生命周期复核覆盖 unknown action 开库前拒绝、schema-ready 失败关闭、worker error/exit、service closing、read 返回时 generation 或 activeTask identity 改变、缓存失效和 modal inline retry。`serializeError`/`deserializeError` 复用既有双侧 schema，未修改 stack/cause/FileValidationError 字段；renderer `state` 命中是 data-manager dialog 的局部状态，不是 `src/renderer.js` 全局单例。
- 性能盲区发现并修正了 Pending effective 的 source-leading scan + GROUP 临时树；最终 EXPLAIN 锁 candidate-first 既有 covering index。其余 run rows/balances/adjustments/Pending 表按冻结合同各一次 set scan；若真实 16 GB 不达标，保持 PROBE 并反向同步合同，不擅增 migration/index/retry/阈值放宽。
- 资金复核确认本 PR 不改金额、币种、九币种算法、rowKey/revision/sequence、archive writer 或破坏性 write；集合 loader 仍把同源 run/dataset/archive/balance/adjustment/Pending raw evidence 交给 A validator/classifier/gate。自动证据覆盖 current/legacy、孤立/不一致排除、active/unresolved/later 只影响 gate、删除目标共享 evidence 与 v2→v1 零业务 DML；目标生产主体×九币种、有效余额、跨月依赖和备份恢复仍是人工资金红线。
- 最终 `check-vars -- --include-minor` exit 2：Important-skeleton 命中 `serializeError`，Runtime-state 命中 `state`。前者是新 read worker 沿用既有序列化双侧，不改 schema；后者是局部 dialog state 同词误命中。相关 worker error 路径、renderer 重渲染/缓存/导出可用性已纳入聚焦测试，完整 smoke 纳入 release-check。
- 最终单一 session `npm run release-check` exit 0：lint、smoke PASS；unit 4953/4953（320 files，0 fail/skip，node test 15622 ms）；integration 48/48 scripts、2459/2459 assertions（385077 ms）。本轮无失败、retry、阈值或测试框架修改；runner 只在全绿后自动刷新 `rules/integration-test-policy.md` §七的 timestamp/timings，脚本/断言总数不变，按生成证据约定保留。

### Deviations

无行为合同偏离。集成夹具补齐 current provenance、旧写成功链显式标记 legacy，以及 candidate-first query-plan 修正都用于对齐冻结合同；未修改 A 纯模块、旧 write 实现、migration、金额/币种或 C1/C2 范围。

## PR2.5-C1 写保护 Implementation Notes（实施中）

### Decisions

| 决定 | 证据 | 放弃方案/约束 |
| --- | --- | --- |
| C1 复用 `activeTask/taskGeneration` 作唯一 claim 所有权 | B 已实现 generation 和进程内 task identity 复核 | 不新增 tracker/lease/TTL/timer/retry；claim 绑 action/generation/object identity 且只 release 一次 |
| result-write token 扩展 B 单一 v2 实现 | 当前 adjustment/archive preview 只有 revision，无可供锁内精确重算的 token | 不造第二 token/state；`run:get` 走 read worker 并返回两 action token+generation |
| C1 使用物理独立 write worker | 现 `worker-entry.js` 开库时会 migration，且混合 import/calculate/C2 actions | 新 worker 仅 allow adjustment/archive，critical ack 后才开库，零 migration、零 lifecycle 对象 |
| 19 表 policy 和 DML step registry 是单一写权限源 | 旧 production DML 散落在 calculator/result-adjustments，且 preserved-state 扫全表 | 旧 helper 可作 legacy/offline 测试保留，不补新防御；生产调用图只允许 worker+registry |
| 四张大表不建 session | 负责人批准修订与 TechDoc 的大表内存约束 | C1 largeTableScopeProof = approved trigger 0 + immutable registry 零 step 指向大表 + 每 step `.changes` + operation `total_changes` 精确；只小型 protected 表建 empty-session |
| legacy-four calculated 是 plan 前零 DML 结果 | 纠错 Spec/TechDoc 要求 adjustment/archive 返回 `result-recalculation-required` | token 重算后、plan 前返回；不写 business/success/rollback audit，不 fallback 到 current |
| 测试去组合爆炸 | 负责人批准要求每个独立不变量一个代表 | registered step 各一 `.changes` mismatch；相同 rollback/audit 语义只测一次；不增不可达 renderer/IPC 反例 |

### Phase 0 Evidence

- 基线已核为 `ac882a3846571ab57692b8be633413e919cf2a54`，tracked clean、无 upstream；已创建本地分支 `codex/v3.1.9-pr2.5-c1-guard-adjustment-archive`，无 push/PR/GitHub 写入。
- Node 24.13.0 / SQLite 3.50.4 临时内存 probe：`createSession=function`，empty changeset 0 bytes，trigger 写 protected table changeset 28 bytes，statement `.changes=1`时 `total_changes` delta=2，commit/rollback 后 session close 均成功。
- current migration 内存库枚举得到 19 张 `vcc_fin_op_%` 表、0 个 production VCC trigger。该证据只关闭本机实现未知，Windows packaged 和目标生产 trigger 仍为 PROBE。
- 真实当前写入路径是 `renderer → preload → main tracked IPC → service.runDirectTask → archiveRun/addRunAdjustment → Main database.db`；旧函数使用全事实 SHA，并且 archive 失败直接尝试无保护 rollback audit。

### Remaining Unknowns

- Windows installer/portable `createSession`/trigger/total/session close 仍须 runtime probe，不可用开发 Node 代替。
- 目标生产库 trigger、真实 legacy shape、约 16 GB 冷热 P95/WAL/main lag 仍未关闭。
- ⚠️ 主体×九币种、调整后有效余额、跨月期初、success/rollback audit 和备份恢复必须财务人工复核。

### Implementation Evidence

- 19 表 policy 与七个 SQL step registry 已冻结。adjustment 只允许 `run_adjustments/runs`，固定 `2`；archive 只允许 `operation_audit/archives/runs/datasets`，固定 `N+7`；audit-only 只允许 `operation_audit`，固定 `1`。每个 registered step 都有一项 table-driven `.changes` mismatch 证据。
- 四张大表 `effective_rows/import_rows/system_snapshots/system_snapshot_attempts` 不创建 session；运行时证明固定为未批准 trigger=0、不可变 registry 零 C1 step 指向它们、逐 step `.changes` 和 operation `total_changes` 精确守恒。其余小型 protected 表使用 empty-session。
- production 调用图已切为 `renderer token+generation → preload/main progress bridge → Service generation-bound claim → dedicated result write worker → BEGIN IMMEDIATE → B raw evidence/token v2 → A validator → MutationPlan → registry → SQLite`。Service 不再 import/call `archiveRun` 或 `addRunAdjustmentToDb`；旧 helper 仅保留 legacy/offline 测试用途。
- claim 绑定 action/base generation/进程内 object identity，父进程在发 `critical-ack` 前置 `protected=true`；进入后 cancel/terminate 只等待 terminal，重复 terminal 不重复 release，generation 只推进一次。七字段 context 缺失接受，存在时 Service 与 worker 都按既有 helper 精确 refreeze；worker 不接 reserve/reopen/create batch、service/repository 或 settleArtifacts。
- adjustment/archive 在同一 `BEGIN IMMEDIATE` 内从 A validator + B set evidence 重算对应 token v2，精确等于 preview 后才生成 plan。真实 legacy fixture 变异为 calculated 后，两 action 都在 plan 前返回 `result-recalculation-required`，业务/success/rollback audit 均为 0 DML。
- safe revision failure 先回滚业务连接，再以新连接和独立 audit-only plan 写一条 protected rollback audit；audit 注入失败仍上抛原 revision error。`vcc-trigger-policy-violation`、`mutation-guard-unavailable`、`vcc-schema-not-ready` 和 runtime/连接不可信均数据库零 failure audit。实现复核发现业务连接 `createSession/changeset` 原生失败可能未稳定归类，已收敛为 `mutation-guard-unavailable` 并增加零 audit 代表测试。
- archive postcondition 保存 A 验证后的 `effectiveCalculatedBalance`，测试锁定 PPHK 的 USD=`110`、EUR=`105`、完整九币种、五 dataset 和 success audit `preview_token IS NULL`；未修改金额、币种、跨月公式或 classifier。
- production Service 真实链完成 `getRunResult token/generation → adjustment worker → refetch 新 token/generation → archive worker`，并核对 adjustment/archive app/build provenance。renderer/main/preload 静态契约锁定两 action payload、progress 过滤/退订、成功 refetch 和 legacy 明确提示。
- 首次失败均已分类且没有 production regression：两次是同步 fail-closed 被测试误用 `assert.rejects` 的 test design；一次是 `getRunResult` 改为 read worker 后旧测试仍同步读取的 stale test，已按真实调用时间点迁移。当前 guard/result/write/service 聚焦 36/36，renderer/preview/usage 44/44，B read 相关 47/47 PASS；A/B/C1 与 renderer 扩大聚焦 110/110 PASS。
- `scripts/perf/vcc-financial-op-result-write-performance.js` 对每个样本复制离线 current DB、read worker 取 preview、dedicated worker 归档并测主线程 lag；同时静态禁止旧 full-fact fingerprint helper/Service DML 旁路。小 fixture 五次 worker P95 `75.549ms`、main lag P95/max `2.077ms`、WAL 均 `0→0`、输入 SHA 不变；只作本机 gross evidence，不关闭约 16 GB/Windows 门禁。
- `npm run lint`、13 个本次生产/脚本文件 `node --check`、`git diff --check` 均 PASS；A/B/C1/renderer 扩大聚焦 110/110，另行 `serialize-error` 17/17 PASS。
- 首次完整 `release-check` 的 lint/smoke 与 unit 4972/4972 全绿，integration 46/48；两项均分类为 C1 生产合同迁移后的 stale integration：调整归档链仍同步消费 async `getRunResult`/旧 success audit full evidence，历史导出链未携 archive token/generation。只机械迁移为真实 preview → submit → refetch，并按冻结边界删除 renderer/IPC 不可达且与 options guard 重复的 archived direct-Service write 断言；未改生产、阈值或 retry。调整链 297→209 是 success audit 按 TechDoc 从完整 effectiveRun 改为 digest 摘要后，旧九币种×多字段 audit 内嵌重复断言合法移除；金额仍由正式 refetch、archive DB 行和 Excel 回读覆盖。历史链 28→29 增加写后 refetch，因此 integration 总断言 2459→2372。两条脚本分别定向 209/209、29/29 PASS。
- 第二次且最终单一 session `npm run release-check` exit 0：lint、smoke PASS；unit 4972/4972（324 files，0 fail/skip，node test 15290 ms）；integration 48/48 scripts、2372/2372 assertions（1286511 ms）。runner 仅在全绿后按仓库规则自动同步 `rules/integration-test-policy.md` §七；无重试或门禁放宽。

### Blindspot / Reconciliation Pass

- 入口旁路复核确认 renderer/IPC 可达的 adjustment/archive 只有 C1 worker+registry；`getEffectiveRunResult` 只生成单 run review shape，不参与 token/plan 真相或 fallback。C2 的 unarchive/delete 仍保持 v2 preview → 旧 v1 write fail-closed，本 PR 未桥接或修复。
- 状态/失败复核覆盖 unknown action 开库前拒绝、stale generation 零 worker、critical 前协作取消、critical 后禁止 terminate、worker error/exit、trigger/runtime/schema/session/rollback/connection close 和 audit-only 二次失败。未增加 TTL、timer、retry、lease 或 fallback。
- 资金血缘复核保持 run/dataset/revision/fingerprint、rowKey metadata、adjustment sequence、主体×九币种和 A effective balance 为同源证据；archive 不信任 renderer 金额，也不从旧 DB-bound helper 回退。⚠️ 真实主体×九币种、跨月期初、success/rollback audit 与备份恢复仍须财务人工复核。
- `check-vars -- --include-minor` exit 2（命中需 review，不是测试失败）：Important-skeleton 命中 `ipcRenderer/serializeError`，Runtime-state 命中 `state`。新 progress channel 已同步 main/preload/renderer并有退订契约；序列化仅复用既有双侧 schema且专属测试全绿；`state` 只命中新文件 `operation-state` 路径同词，`src/renderer.js` 顶层全局 state 零改动。无 Critical/Risk-sensitive 命中。

### Deviations

无。负责人批准时对四张大表保护做了必须修订：它们不进入 empty-session，而是使用零目标 DML registry + trigger policy + 逐 step/operation 变化守恒。本节已在任何生产编辑前与 preflight 同步。

## PR2.5-C2 解归档/删除 Implementation Notes（本地代码完成）

### Decisions

| 决定 | 证据 | 放弃方案/约束 |
| --- | --- | --- |
| C2 扩展 C1 单一 policy/registry/guard/claim/write worker | B 已冻结 v2 raw evidence，C1 已冻结 protected write protocol | 不新增 guard、token、tracker、claim、worker entry、TTL、retry 或 fallback |
| 大表放行绑定 operation、registered step 与固定 scope metadata | C2 必须写四张 large-table-scope-proof 表，C1 又必须继续保持零大表 step | guard 精确核对 registry scope ID、锁前 pre-count 与 step budget；四张大表仍不创建 session |
| write lock 内使用 claim base generation 重载 B 同源 evidence | token canonical payload 包含 taskGeneration，B 的 active batch evidence 是全局范围 | 不使用释放后 generation，不按目标月收窄 active evidence，不接旧 v1/full-fact SHA |
| source delete 先物化并逐字段验证，再清 FK/删事实 | import audit 是有效事实删除后的唯一可追溯血缘 | detail 使用单次 `UPDATE ... FROM`；system 先补 B、再物化 A；不回退旧多相关子查询 |
| deletionId 只作返回值与后置证据 | plan 必须在首写前独立完成，不能执行后回填预算 | import records 固定 SQL 通过 deletion boundary、scope 与事务时间定位唯一新 row；postcondition 再核 returned id |
| 自动测试按代表场景覆盖，不展开组合爆炸 | 负责人明确禁止为重复、理论、renderer/IPC 不可达 case 增加 guard/test | current/legacy 各一条真实生产入口；共享 failure/audit 语义各保留一个代表 |

### Phase 0 Evidence

- 基线精确核为 `f92b8cc81801935ef95683e68671235ba4decf74`（parent `ac882a3846571ab57692b8be633413e919cf2a54`），tracked clean、无 upstream；获批后创建唯一分支 `codex/v3.1.9-pr2.5-c2-unarchive-delete`。
- 真实旧旁路为 `Service → generic worker-entry → migration → unarchive/data-target-deletion/dataset-deletion`；C2 将生产入口切到 C1 dedicated worker，并从 generic worker 删除 destructive action 路由。
- Node 24.13.0 / SQLite 3.50.4 内存 probe 通过 C1 session/trigger/total/close；`UPDATE ... FROM` 语义通过。detail query plan 命中 `idx_vcc_fin_op_import_rows_existing`，system 当前为 attempts scan + snapshot PK lookup。
- 上述只关闭本机实现未知。Windows packaged runtime、真实 legacy/trigger、约 16 GB P50/P95/WAL/main lag，以及主体×九币种/跨月/审计/备份恢复仍为 PROBE 和资金人工门禁。

### Remaining Unknowns

- Windows installer/portable 的 session/changeset/total/close 与 `UPDATE ... FROM` 仍须 runtime probe；不可用即阻断发布。
- system attempt 物化在现有无 `existing_snapshot_id` 专用索引的 schema 上须通过约 16 GB 性能门禁；C2 禁止 schema/index migration，也不能回退旧相关子查询。
- 目标生产库必须只读确认 exact current/legacy 和 trigger shape；非 exact four 或未知 trigger 保持 fail-closed。
- ⚠️ 真实主体×九币种、跨月 tail/opening、detail/system 审计血缘、部分失败、备份恢复须财务人工复核。

### Implementation Evidence

- C1 的 19 表 `VCC_TABLE_POLICY_REGISTRY` 和 immutable SQL step registry 已扩展为 C2 唯一写权限源。大表 step 必须同时精确匹配 operation、registered step、registry scope ID 和锁内 pre-count/budget；四张大表仍不创建 session，C1 adjustment/archive 仍为零大表 step。
- current/legacy 解归档在同一 `BEGIN IMMEDIATE` 内以 claim base generation 重载 B 的 archive/global-active/gate evidence，exact compare v2 token 后才生成独立 plan。current 预算 `N+7`，真实 v3.1.7 exact-four 预算 `N+6`；legacy 不创建/更新 Pending dataset/facts。
- result/opening 删除将 adjustment/row/balance/pending-summary/pending-currency 保留为五个独立 step，再删 runs；预算分别为 `1+R+ΣC` 与 `1+R+ΣC+O`。opening 提交前精确复核 `module_state` 全行未变且 `first_month` 保持目标月。
- detail source 按 `2+R+ΣC+2Q+E+D+M` 执行 `UPDATE ... FROM` 物化、逐字段复核、清 FK、删 effective/dataset、作废 run children、写 deletion/success audit；测试锁定 D=0 orphan 不造 dataset、M>0 exact，以及非目标月 effective row 保留。
- system source 按 `2+R+ΣC+B+2A+S+D+M` 先补语义唯一 accepted attempt，再逐字段物化/清 FK/删 snapshot。真实 production Service→dedicated worker integration 锁定 B=1/A=1/S=1/M=1、最终 accepted 恰好一条、九币种/raw/source/import-record snapshot 不丢失。
- deletionId 只使用锁内 boundary 与 INSERT returned ID 作后置证据；plan/budget 没有在执行后回填。source 成功记录通过 boundary/scope/transaction time 精确绑定单一 deletion row。
- 生产 unarchive/delete 已从 generic migration worker 切到 C1 dedicated write worker/claim/critical progress/cancel，generic worker 不再包含两个 destructive action。Main 将两者进度转发到既有 channel，renderer 按 action 订阅并在 `finally` 退订，复用现有运行中状态文案。
- 一个中途 fault 代表在五 child 已执行、runs 删除前注入：业务事务完整回滚、success audit=0，只在独立 protected audit-only 事务中留一条 rolled_back。未建立 step×fault 笛卡尔积。
- 扩大聚焦覆盖 A/B/C1/C2 相关 archive/read/guard/write/legacy helper/service/renderer/serialize-error，最终 195/195 PASS；真实 destructive integration 增加 system 切片后 77/77 PASS。

### Failure Classification

- detail/system 首跑 4/6：SQLite row 为 null-prototype 而断言用 plain object，分类 test design；仅归一化测试比较形状。
- M/stale/safe/unsafe 首跑 7/9：共享 rollback audit postcondition 将 SQL NULL run_id 当成数值 0，分类 production regression；改为 nullable exact compare，C1 回归同时通过。
- production 链首跑 21/25：四项均为旧 B/C1 fail-closed 时点或注入 generic `workerFactory` 的 stale tests；仅迁移到 C2 真实 dedicated route。
- destructive integration 首跑停在旧 success audit 完整 facts 断言，分类 stale test；迁移为 C2 symbols/digest 合同。第二跑 60/61 暴露 non-tail error 只写 `context.dependentMonths`，统一 IPC 会丢用户依赖提示，分类 production regression；在真实 gate 抛错点恢复顶层字段后通过。
- 首次完整 `release-check` 的 lint/smoke 与 unit 4984/4984 全绿，integration 前 47 个脚本通过，最后一条 historical integration 仍以 legacy helper 生成 v1 token 提交给 C2 dedicated worker，分类 stale integration test；按授权只机械迁移为 `service.previewUnarchive(targetMonth)` 返回的 v2 token/taskGeneration，再调用 `service.unarchiveMonth` 并写后正式 refetch，单脚本 29/29 PASS。未硬编码 token、未改生产、未重试该次 full。

### Blindspot / Reconciliation Pass

- 入口旁路复核确认 renderer/preload/main 可达的 unarchive/delete 只进入 Service 的同一 generation claim 和 dedicated worker；旧 full-fact SHA/v1 helper 仅剩 legacy/offline 测试用途，generic worker 无 destructive route。
- 状态/失败复核覆盖 global active/tail/unresolved、claim base generation、critical 前 cancel/后禁 terminate、valid/null 七字段 context、stale 真实状态变更、单一中途 fault、M=0 safe audit 和 unknown trigger unsafe 零 DB audit。未增加 lease/timer/retry/fallback 或不可达 payload 防御。
- 资金血缘复核确认本轮不改金额/币种/计算公式；删除前物化 raw/subject/source/import-record/time，system 另物化九币种 balances，且 run 五 child、dataset deletion、success/rollback audit 行数守恒。⚠️ 真实大库主体/币种/跨月/备份恢复仍须财务人工复核。
- 性能证据只保留结构门禁：B 的 archive/unarchive/delete read SQL 预算、detail existing-effective index 与 system attempts scan+snapshot PK query plan。当前工作区没有约 16 GB 离线副本或 Windows packaged runtime，因此未生成 C2 P50/P95/WAL/main-lag 数字，也不用小 fixture 声称关闭 PROBE。
- `npm run check:vars -- --include-minor` exit 2 是命中 review 的预期结果：仅 Runtime-state `setStatus`/`state`，无 Critical/Risk-sensitive。`src/renderer.js` 全局 state 零改；C2 只复用 VCC module 既有 `setStatus` 调用和文案风格，没有改状态单例生命周期。
- 第二次且最终单一 session `npm run release-check` exit 0：lint、smoke PASS；unit 4984/4984（325 files，0 fail/skip）；integration 48/48 scripts、2385/2385 assertions（295658ms），其中 destructive 77/77、historical 29/29。runner 只在全部脚本 PASS 后自动同步 `rules/integration-test-policy.md` §七；无 retry、阈值放宽或生产补丁。

### Deviations

当前无。

## PR3-VCC TaskLifecycle Implementation Notes（本地代码完成）

### Decisions

| 决定 | 证据 | 放弃方案/约束 |
| --- | --- | --- |
| 新增独立 primary scope `vcc-financial-op/VCCFINOP` | VCC 财务OP是 13+1 主模块；既有业务OP scope 为 `vcc-op-calc/VCCOP` | 不把财务OP做 alias/toolbox；既有 `vcc/VCCOP` operation tracker 映射保持不变 |
| VCC action inventory 精确冻结为 11 reserve、15 exclude | main/preload literal inventory、Spec C03/C04 与负责人裁决一致 | 不使用 wildcard；progress sideband 不进 policy；PR3-Toolbox 三项继续 handoff |
| 显式业务实例续接稳定 identity，其余动作开启新 parent | runId、import batch/recordId 都由 prepared 或业务结果证明 | 不按月份/latest/hash 猜 parent；重算、每次 import apply、无唯一实例动作均新 parent |
| reserve 链 worker context 必须 exact7 | PR2 `worker-batch-context` 是唯一 DTO 冻结器 | Main/Service 先 freeze、worker refreeze；read worker 无 context；生产 reserve 链不接受 null |
| VCC cancel 只在 Service 接受 pre-critical 取消后 CAS 原 batch | C1/C2 claim/critical-ready/protected 协议决定是否还能取消 | protected/direct 阶段只等待业务终态；不先写 cancelled 再发现 protected；不建第二批次 |
| 文件登记使用业务实际结果 | import result records 提供逐 sourceType 状态，三类 writer 返回最终输出路径 | 五类 import 只登记 success/success_with_skips/all_skipped；失败组不归档；metadata-only 不强制空目录 |

### Implementation Evidence

- 基线精确核为 `e1979c2e8fda87ade96c7f60f7c55f7f834d1034`（parent `f92b8cc81801935ef95683e68671235ba4decf74`），tracked clean、无 upstream；获批后创建本地分支 `codex/v3.1.9-pr3-vcc-task-lifecycle`，无 push/PR/GitHub 写入。
- `TaskPolicyRegistry` 已将 VCC 11 个实际生产动作接为 reserve，并将 15 个 picker/preview/query/cancel 入口逐项 exclude；既有 `vcc-op-calc/VCCOP` 与 operation tracker `vcc -> VCCOP` 未改，新增 `vccFinancial -> VCCFINOP`。
- parent 所有权已按裁决实现：calculate/recalculate 与每次 import apply 新建；archive/adjust/unarchive/result export 以 runId 续接；resolve/audit 以 recordId 续接；import 结果绑定 batchId 与 recordId；opening、source/opening/multi-run delete、data export 新建；result delete 仅 prepared 证明唯一 runId 时续接。
- import/calculate/export generic worker 与 C1/C2 dedicated write worker 都由 Service 冻结、worker 再冻结 exact7；opening/resolve/result export/audit export 等 direct action 在进入业务任务前验证同一 context。缺失或字段不全均拒绝，inspect/read worker 继续无 context。
- 三个 save/directory dialog 均移到 lifecycle prepare；取消返回 `proceed:false`，因此 0 BOR/0 reserve。reserve 失败代表测试确认 0 execute/0 worker；业务动作仍由 PR2 lifecycle 按 BOR→reserve→started→execute→artifacts→terminal 收口。
- pre-critical cancel 只取消活动原 batch；protected 后 cancel hook 不执行并等待 worker terminal；late cancel 返回 not-found，succeeded 不被覆盖；worker crash 归 failed。未修改 C1/C2 token/classifier/generation claim/critical-ready/protected、MutationPlan/SQL budget 或通用 TaskLifecycle 核心。
- 五类 import 输入 artifact 只按成功 record 的 sourceType 登记；失败组仍保留 task failed/cancelled/diagnostic。result export 登记 writer 的全部 `filePaths`，data/audit export 登记 writer `filePath`；opening/adjust/archive/unarchive/delete 等 metadata-only action 不强制物理目录。
- artifact append 与 terminal 持久化失败代表测试确认业务终态和 archiveStatus 分离，outbox intent 保留原 batchContext/parentRunId/operationKey，reserve 次数仍为 1。
- 首次 focused 失败分类：operation tracker 局部 payload 引用是 production regression，已修；required context 后旧 unit/direct integration fixture 缺 context 是 stale tests；旧 Archive Center 排除 VCC scope 与旧 export handler 变量断言是 stale tests。未降低生产 required 合同、未增加 renderer/IPC 不可达防御。
- VCC/Archive 扩大聚焦 unit 460/460 PASS；四条真实 VCC integration 分别 19/19、209/209、77/77、29/29，共 334/334 PASS，覆盖主体×九币种自动回归、调整后余额、跨月期初、revision、归档/解归档/delete 审计与 Excel 回读。本地自动化只作回归证据，不替代资金人工复核。
- `npm run lint`、changed JS `node --check`、`git diff --check` 均 PASS。`npm run check:vars -- --include-minor` exit 2 是命中 review 的预期结果：仅 Runtime-state `MODULES/app/dialog`，无 Critical/Risk-sensitive。`MODULES` 只移除 Archive Center 对既有 VCC 枚举的过滤，模块路由/启用持久化不变；`app` 只在 prepare 中沿用 `getPath`，未改启动/退出钩子；`dialog` 三个保存选择均在取消时 `proceed:false`，契约测试确认 execute 不在 prepare 前出现。operation tracker 仅增 literal VCC 文件通道和独立 descriptor，不改变 ALS/退出队列或既有 VCCOP 映射。
- 最终且唯一一次 `npm run release-check` exit 0：lint、smoke PASS；unit 4990/4990（326 files，0 fail/skip，node test 15616.298875ms）；integration 48/48 scripts、2385/2385 assertions（384212ms）。本次 full 无失败、retry、阈值或测试框架修改；runner 仅在全绿后合法刷新 `rules/integration-test-policy.md` §七 timestamp/timings，脚本与断言总数不变，生成结果纳入本分支。

### Remaining Unknowns

- Windows installer/portable 的 worker/context 序列化、session/trigger/total/close 与 production legacy-trigger 仍是 PROBE；不可用开发机 Node 结果代替。
- 约 16 GB 真实库的冷/热 P50/P95、WAL 与 main lag 未在本分支执行，继续受 C1/C2 发布门禁约束。
- ⚠️ 真实主体×九币种、调整后余额、跨月期初、归档/解归档/delete 审计和全部导出文件仍须财务人工逐项复核；自动测试不能关闭资金红线。

### Blindspot / Reconciliation Pass

- 入口旁路复核按 literal inventory 对齐 main/preload/policy；所有 VCC 生产 mutation/export action 要么 reserve、要么以明确原因 exclude，progress 不参与批次。Archive Center renderer 已显示新 primary scope，不再静默过滤 VCC 财务OP。
- 状态复核覆盖 reserve 失败、pre-critical/protected/late cancel、worker crash、first-terminal-wins CAS、artifact/terminal outbox 原批次重放；未新增 tracker、terminal 状态、batch allocator、latest/month fallback 或 retry。
- 血缘复核保持 run/dataset/revision/record/deletion/audit 和 writer 输出为真实证据；本轮不改金额、币种、九币种集合、跨月公式、schema/migration、C1/C2 写预算或 VCC UI 业务行为。

### Deviations

无。

## PR3-Toolbox TaskLifecycle Implementation Notes（本地代码完成）

### Decisions

| 决定 | 证据 | 放弃方案/约束 |
| --- | --- | --- |
| toolbox 是唯一 utility scope | archive 筛选需可见，但业务模块菜单冻结为 13 primary | 精确 `{toolbox,TOOLBOX,工具箱,utility}`；不改 settings/renderer MODULES，不新增 alias visible item |
| 三通道 literal policy 为 reserve/exclude/reserve | merge/export 有最终文件副作用；read 只选文件和预览 | 无 wildcard/额外 alias/handoff；split read 不建 batch/parent |
| split read 证据只保留 Main 单一当前 context | export 必须关联一次明确 read，且重启后失效 | opaque token+path+stat；无 TTL/timer/Map/WeakMap、hash/path/latest fallback |
| 所有最终输出位置在 prepare 确认 | PR2 明确 dialog 必须在 BOR/reserve 前完成 | merge/save、split save/directory/overwrite 取消均 `proceed:false`；算法不先产用户输出 |
| 最终 artifact 通过 operation-scoped prepared/runtime 交既有 tracker | publication worker 已返回所有 final path/size/SHA | 不建第二 tracker/evidence store；公开 single result shape 不变；tmp 不登记 |
| large/multi/publication 只继承 exact7 | PR2 worker-batch-context 是唯一冻结器 | Main freeze、worker refreeze；scanFields 无 context；worker 不 reserve/reopen |

### Evidence

- 基线精确核为 `df3409b25782ead0ea944c00439dca0149c69a8d`（parent `e1979c2e8fda87ade96c7f60f7c55f7f834d1034`），tracked clean、无 upstream；获批后创建本地分支 `codex/v3.1.9-pr3-toolbox-task-lifecycle`，无 push/PR/GitHub 写入。
- primary scope 保持 13；archive visible scopes 为 13+1 utility。`toolbox:merge`、`toolbox:split:export` 是唯一两个 TOOLBOX reserve action且各自 `startsNewFlow:true`；`toolbox:split:read` 是唯一 toolbox exclude，理由为 preview-only。
- split read 在扫描开始前和结束后复核 stat，并保存随机 token、resolved source path 与 read-time stat。新 read 清旧；输出 dialog 取消不清；beforeStart missing/mismatch 清并由 lifecycle 将已 reserve 原批次标 failed且0 execute；成功 publication 后清；普通业务失败保留供重试。
- merge beforeStart 为全部实际输入捕获 source snapshot；split export 使用 read snapshot 作为 input descriptor。publication 返回的全部最终 files 被转为 output descriptors，保留 expected SHA/size；normal/large/multi 均只更新本次 prepared，不登记 generation/tmp。
- large split export dispatch 和 publication dispatch 要求 exact7，worker 再冻结；scanFields 与启动恢复不伪造 batch。Main 的普通算法只在真实副作用 publication 边界传 context，不建立无用第二状态。
- 首次 focused 共 80 项出现 3 个失败：visible reserve scope 仍断言 13、renderer 仍以 tracked split-read 定位边界，均为 stale test；multi source slice 被内部 large 判断提前截断为 test design。机械更新真实合同后 80/80 PASS；无 production regression/environment。
- lifecycle/freshness/worker/publication 代表 51/51 PASS：reserve failure 0 execute/output；freshness failure 终结原 batch；token 覆盖/重试/清除；large normal/multi worker 与 publication exact7；artifact append/outbox 保留业务成功和原 batch。
- toolbox integrations：roundtrip 30/30、multi-split 17/17、multi-sheet merge 16/16、300k×2 large-file 50/50、500k/1.5m multi-sheet large split 31/31 PASS。large-file 生成 600k 合并输出与 100k 拆分输出，RSS 峰值 642MB；large split 1.5m tier 的 paired RSS 中位增量 137MB，31/31 脚本合同通过。
- 扩大聚焦 131/131 PASS；archive filter/scope/policy 追加复核 38/38 PASS；`npm run lint`、changed JS `node --check`、`git diff --check` PASS。
- `npm run check:vars -- --include-minor` 最终 exit 0，仅命中 Runtime-state `MODULES/app/dialog`，无 Critical/Risk-sensitive。`MODULES` 定义与模块路由/启用列表未改，工具箱只追加到存档筛选独立 Map；`app` 只沿用 `getPath('userData')` 向 publication worker 传原 context，启动/退出钩子未改；`dialog` 的 merge/save/directory/overwrite 全移到 prepare 且取消 `proceed:false`，0 BOR/reserve 契约与 UI 静态测试通过。
- 最终且唯一一次 `npm run release-check` exit 0：lint、smoke PASS；unit 4999/4999（327 files，0 fail/skip，node test 15564.311584ms）；integration 48/48 scripts、2385/2385 assertions（381885ms）。首次 full 无失败、retry、阈值或测试框架修改；runner 仅在全绿后合法自动同步 `rules/integration-test-policy.md` §七 timestamp/timings，脚本与断言总数不变。

### Remaining Unknowns

- Windows installer/portable 的 worker context 序列化、文件选择/覆盖、publication recovery 与路径语义仍是 PROBE。
- Excel/WPS 实际打开、格式保真、日期系统、超 104 万行/多 sheet、多输出文件逐项可读性仍需人工验收。
- 约 16GB/700万行真实样本、冷/热耗时和 RSS 阈值仍是性能 PROBE；本机 300k/1.5m 自动脚本不能关闭。
- ⚠️ 文件数、sheet 数、输入/输出行数守恒和资金相关表格内容/血缘仍须人工复核；自动回读不替代真实业务验收。

### Blindspot / Reconciliation Pass

- literal inventory 已覆盖三个真实入口，无旁路 handoff；split read 是 raw exclude，merge/export 只经现有 `runArchiveAwareOperation → TaskLifecycle`。
- 状态复核覆盖新 read 覆盖、取消保留、missing/mismatch 清除、成功清除、普通失败保留和重启失效；没有第二 tracker/lifecycle/allocator/terminal 或 latest/path/hash fallback。
- 输出血缘只使用 publication worker 的最终 descriptors；多输出以同一 batch/parent/context 一次登记，tmp/journal recovery 路径不冒充业务 artifact。archive failure/outbox 不覆盖业务成功，source freshness/business failure 不被 archive 结果掩盖。
- 核心 merge/split 算法、字段/值选择、sheet/日期/样式、命名、行数与 RSS 阈值未改；资金与人工红线继续开放。

### Deviations

无。
