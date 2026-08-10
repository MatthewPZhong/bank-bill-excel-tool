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

### Remaining Unknowns

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
