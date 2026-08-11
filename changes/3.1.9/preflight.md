# v3.1.9 Preflight

## Task Brief

- Goal: 按确认 Spec 的 PR1 边界完成全局批次身份、纯加法数据库迁移、任务状态 CAS、关联查询和跨重启业务身份锚点基础。
- Context: 基线为 `origin/main@63c1ce46357587643e506768f712352cbb6c7127`，`package.json.version=3.1.8`；完整确认稿已原样归档到 `changes/3.1.9/spec.md`，C01—C14 均已确认。
- Constraints: PR1 不接业务 action、IPC、UI、目录物化、存储根迁移、TaskPolicyRegistry 或 BusinessFlowResolver；不修改金额、币种、匹配、回填、业务归档、人工调整和结果模板；保留 v1 `createBatch` 全链兼容。
- Done when: Spec §6 的加法 schema、全局原子 `reserveTaskBatch`、真实 latest issuance、task DTO/CAS、related batch 与 flow anchor 查询落地，并通过 Spec §15.1 的 PR1 核心矩阵及既有 archive 回归。

## 已确认事实

| 事实 | 证据 | 对方案的约束 |
| --- | --- | --- |
| 实施基线为 v3.1.8 当前 main | `git rev-parse HEAD` 与 `origin/main` 均为 `63c1ce4...`；`node -p "require('./package.json').version"` 为 `3.1.8` | 不引用历史 PR6 冻结头 |
| 完整产品合同已锁定 | 确认稿 1618 行，SHA-256 `52a7f4306b004d65cbe68972c22906adf4ad7a460378e216be8fcfcffd58a31b`；C01—C14 全确认 | 不重新选择方案，不改产品口径 |
| v1 批次由 archive repository 自建 schema 和分模块流水 | `src/backend/database/archive-repository.js` 的 `ensureArchiveMetadataSupport`、`createBatch` | PR1 在同一仓储做纯加法迁移；v1 API 保留 |
| archiveStatus 现库有三态 CHECK | `archive_batches.archive_status CHECK IN ('staging','complete','incomplete')` | 业务失败只能写 `task_status`，不得扩 archiveStatus |
| 现有 operation key 已有 `(module_id, operation_key)` 唯一索引 | `idx_archive_batches_operation` | v2 复用该持久幂等边界 |
| SQLite 支持所需加法迁移 | Node SQLite 3.50.4 内存 probe：`ALTER TABLE ADD COLUMN ... CHECK` 成功，非法 task status 被 CHECK 拒绝 | 无需重建 `archive_batches` |
| 现有 v1 archive 基线全绿 | `node --test` archive repository/service/controller：44/44 PASS | 新测试必须保留这些行为 |
| `archive_daily_sequences` 尚不存在 | `rg` 在 `src/ tests/` 零命中 | 新表与 v2 API 无历史实现冲突 |

## Unknowns Register

| 未知 | 类型 | 影响 | 可逆性 | 当前证据 | 处理 | 最便宜验证方式 | 当前决定 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| ADD COLUMN 能否保留现有 archiveStatus CHECK 且新增 taskStatus CHECK | 已知未知 | 高 | 容易 | SQLite 3.50.4 probe 通过 | PROBE | 内存旧 schema 迁移 + 非法值写入 | 已消除：只增列，不重建旧表 |
| 多连接下全局序号是否真正原子 | 已知未知 | 高 | 一般 | `withWriteTransaction` 使用 `BEGIN IMMEDIATE`，DatabaseSync 为同步连接 | PROBE | 临时文件 DB、多 worker/连接真实预留 | 由专项测试验证，不用字符串测试替代 |
| 事务在游标递增后 INSERT 失败能否整体回滚 | 失败模式 | 高 | 容易 | SQLite DDL/写事务支持回滚 | PROBE | 测试触发器在 v2 INSERT 点强制 ABORT | 由真实 SQL 失败路径锁定 |
| v1 与 v2 DTO 如何共存 | 兼容盲区 | 高 | 容易 | 历史行没有 v2 字段，Spec 固定默认值 | ASSUME | 旧 schema fixture 迁移后读取 | v1 映射 `formatVersion=1/taskStatus=succeeded/globalSequence=null`，不猜 parent |
| latest issuance 删除后如何保持且不把 v1 游标推进伪装成 v2 发行 | 状态生命周期 | 高 | 容易 | Spec 明确不得从可见 batch max 计算；PR2 前 v1 tracker 仍可达 | PROBE | v1/v2 交错、发 001/002/003、删 003、只读 latest、再发 004 | 游标与真实发行事实分离；仅 v2 INSERT 成功后同事务记录 issuance |
| 跨重启如何按稳定业务 identity 恢复 parentRunId | 主键血缘 | 高 | 一般 | operationKey 只标 action；parent_run_id 不能按业务 ID 反查 | PROBE | 独立唯一 anchor 表、重启查询、幂等/冲突/跨模块测试 | 增加 `archive_flow_anchors`，不从月份/hash/JSON 猜测 |
| cancel 与原任务 Promise 竞态如何保护 terminal 状态 | 状态竞态 | 高 | 容易 | 两条主进程完成路径可乱序到达 | PROBE | cancelled→late success、succeeded→late cancel 的 DB CAS 测试 | terminal 不可被不同迟到结果覆盖；同 terminal 重放幂等 |

## BLOCK 问题

无。PR1 所需产品口径均已由 C01—C14 和 Spec §6、§14、§15.1 锁定。

## 保守假设

- `BusinessFlowResolver` 留到 PR2；PR1 提供显式 `moduleId + identityType + identityValue -> parentRunId` 持久锚点，严格校验来源批次 module/parent，不按月份、文件 hash、JSON 或 renderer state 猜测。
- PR1 的 latest issuance 是全局只读真实发行 DTO；模块筛选、统计和 UI 组合留到 PR6。
- task 状态接口只实现 PR2 竞态所需的最小 CAS：调用方给定 expected 非终态；terminal 不可互相覆盖，相同 terminal 幂等。不扩展为通用业务状态机。

## 风险优先计划

| 顺序 | 步骤 | 消除的未知/保护的不变量 | 成功证据 | 失败影响 | 回滚/收缩 |
| --- | --- | --- | --- | --- | --- |
| 1 | 增加幂等 schema migration 与旧库 fixture | 历史身份、archiveStatus 三态、加法迁移 | 旧行逐字段不变，新列默认正确，二次迁移 no-op | 数据模型不可用，停止后续实现 | 仅回退新增 DDL/字段映射 |
| 2 | 在 repository 内实现原子 reserve | 全局主键、幂等、回滚、不复用 | 多模块/多连接、失败注入、删除重发测试 | 推翻 PR1 核心，停止 service 接口 | 保留 v1 createBatch，不接调用方 |
| 3 | 增加 task CAS、related/latest 与 flow anchor 查询 | 状态分离、parent 血缘、latest 不倒退、跨重启恢复 | DTO/CAS/锚点/删除与重启测试 | 影响后续 PR 接线，不影响 v1 | 收缩为 repository 基础 API |
| 4 | 追加 ArchiveService 门面但不接业务 | 形成 PR2 可调用接口且不动现有 tracker | service 单测与既有 44 项回归 | 只影响新 API | 移除门面，保留 repository |
| 5 | 跑 PR1 unit 与 blindspot/reconciliation 复核 | 防入口越界和资金行为漂移 | 定向 suite 全绿；业务算法 diff 为零 | 不交 review | 修复后重跑，不扩大 PR 范围 |

## PR #132 P1 评论复核（2026-08-10）

### Task Brief

- Goal: 在 PR1 内修复删除授权、旧库 cursor seed、flow anchor 来源血缘和 task 预留日期四条 P1 缺陷。
- Context: PR1 head 为 `98ddcf9`；四条缺陷均位于 `ArchiveRepository` / `ArchiveService` 的 PR1 基础契约，尚未接入 PR2 业务 action。
- Constraints: repository 是手工删除与 `cleanupExpired()` 的共用授权点；只做加法迁移和最小时钟契约，不重建 `archive_batches`，不改已有批次号、legacy `createBatch` 显式日期或显式 `retentionUntil` 语义。
- Done when: active 批次不可物理删除；seed 重复执行不烧号；source flow anchor 严格验证 module/parent；task 日期、批次号、`reservedAt` 与默认 retention 来自事务内同一次时钟采样，并通过定向 P0/P1 回归。

### 已确认事实

| 事实 | 证据 | 对方案的约束 |
| --- | --- | --- |
| `deleteBatch` 当前只拒绝 locked | `ArchiveRepository.deleteBatch` 未检查 `task_status`；service 的手工删除和 cleanup 都进入 `_deleteBatchUnlocked` | repository 统一返回 `active`；service 统一映射 `ARCHIVE_BATCH_ACTIVE`，`force/allowLocked` 不绕过 active |
| module cursor 回填发生在 v2 列创建前且扫描全部 batch | `ensureArchiveMetadataSupport` 先从 `archive_batches` 聚合，再 `addColumnsIfMissing(batch_format_version)` | 首次旧 schema 必须先加列，再只按 `batch_format_version=1` 回填 |
| global seed 的 batch JOIN 会按同模块 batch 数倍增 cursor | `archive_batch_sequences LEFT JOIN archive_batches` 后直接 `SUM(s.last_sequence)` | global seed 只聚合去重后的 module cursor，不连接 batch 明细；冲突更新只允许不倒退 |
| source parent 为空时现逻辑会跳过 parent 比较 | `sourceBatch.parent_run_id && sourceBatch.parent_run_id !== parentRunId` | 有 source 时 module 和 parent 必须同时严格相等；无 source 的新 anchor 保持允许 |
| task 日期和时间当前由 service/repository 分别采样且允许 payload 覆盖 | `_batchInput(payload)` 读取 `payload.localDate`，repository 再调用 `_timestamp()` | 事务回调内只采样一次；显式 task `localDate` 拒绝；默认 retention 基于同一 localDate；legacy createBatch 不变 |

### Unknowns Register

| 未知 | 类型 | 影响 | 可逆性 | 当前证据 | 处理 | 最便宜验证方式 | 当前决定 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| active 的精确集合 | 状态边界 | 高 | 容易 | task CHECK 与评论均锁定五态 | PROBE | reserved/running 表驱动删除 + terminal 后删除 | 仅 `reserved/running`；不为 CHECK 已排除状态加 fallback |
| 显式 `retentionUntil` 是否需要改变 | 兼容盲区 | 中 | 容易 | 缺陷只要求默认 retention 与权威日一致 | ASSUME | 既有 service/repository retention 回归 | 保留显式日期语义；仅默认 `retentionDays` 下沉 |
| 时钟样本应由 service 还是 repository 持有 | 并发/午夜边界 | 高 | 一般 | 序号写事务与 DB 幂等均在 repository | PROBE | fake clock 首次/后续样本跨午夜且断言调用次数 | repository 的 `BEGIN IMMEDIATE` 回调内唯一采样 |

### BLOCK 问题

无。现有 Spec、评论和代码证据足以锁定修复方案。

### 风险优先计划

| 顺序 | 步骤 | 消除的未知/保护的不变量 | 成功证据 | 失败影响 | 回滚/收缩 |
| --- | --- | --- | --- | --- | --- |
| 1 | 修正 seed 顺序与聚合 | 老 schema 兼容、cursor 单调与重启幂等 | 同模块多 v1 首迁、跨模块 v2 后重复 ensure | 会继续烧号，停止后续交付 | 回退 seed SQL，不动表结构 |
| 2 | 收紧 repository 删除授权 | active 状态不可销毁且 cleanup/manual 同源 | reserved/running 拒绝，terminal 后原批次可删，cleanup 返回 active | 任务血缘可丢失，停止交付 | 仅回退授权检查 |
| 3 | 收紧 source flow anchor | module/parent 主键血缘 | null-parent source 冲突，exact-parent 成功 | 跨流程串联，停止交付 | 回退单个条件 |
| 4 | 收敛 task 时钟与默认 retention | 日期/号码/时间/保留期同源 | 伪造 localDate 拒绝，跨午夜 fake clock 仅调用一次 | 批次跨日错位，停止交付 | 保留 legacy createBatch，收缩为 task API |
| 5 | 定向回归与 blindspot 复核 | 不扩大资金/业务行为面 | unit、lint、syntax、diff gate 全绿 | 不交 review | 修复后重跑 |

## PR #132 第二轮评论复核（2026-08-10）

### Task Brief

- Goal: 修复 artifact 登记失败后的完整性收敛、operation key 删除后跨重启幂等、task retention undefined、terminal API 文档契约和 PR 全量 diff gate 五个问题。
- Context: 基线为 PR1 `e7653c8`；PR2 当前真实调用均使用 positional terminal API，并已为 complete 的第二参数扩展 metadata/options。
- Constraints: 不新增 timer、lease、latest tracker、fallback 或双形态 overload；artifact 复用既有 failed-artifact/outbox 血缘；operation tombstone 只记录可证明的现存 issuance，不猜已删除历史。
- Done when: 部分 ready + 登记失败在 terminal 后仍 incomplete 且同一 artifact 恢复后 complete；删除 operation 跨重启重放不分新号，legacy/outbox 不复活或自旋；undefined retention 走既有默认/retentionDays；Spec 与真实 positional API 一致；PR base 到工作树的全量 diff check 通过。

### 已确认事实

| 事实 | 证据 | 对方案的约束 |
| --- | --- | --- |
| artifact 登记失败当前只留下 batch 级错误 | `ArchiveService._prepareFileUnlocked` catch 调 `recordBatchFailure`，没有 `archive_artifacts` 行；`_refreshBatchStatus` 在现有 artifact 全 ready 时会清空该错误 | 用既有 artifact identity 直接持久化 failed 行；不另建恢复表，terminal 继续按 artifact 聚合 |
| controller 已以“结果含 artifact id”判断 durable intent | `filesHaveDurableArtifacts`；缺失时写 filesystem outbox；PR2 outbox 对正式批次追加 `targetBatchId` | failed artifact 行成功写入时无需重复 outbox；DB 无法写入时沿用现有 outbox，不假装数据库不可写也能持久化 |
| operation 幂等当前只依赖 live batch 唯一索引 | `idx_archive_batches_operation`；`deleteBatch` 删除 batch 后不保留 operation identity | 增加纯加法 issuance 表；建批同事务写、删除同事务 tombstone、ensure 只幂等回填当前可见非空 operation key |
| legacy outbox 与 PR2 target-batch outbox 都会受删除影响 | PR1 `flushOutbox` 以 operation key 重跑 `createBatch`，会复活 v1；PR2 对 `targetBatchId` 调 `appendFiles`，删除后会 not-found 并永久保留记录 | flush 在任何 replay 前按 module/operation tombstone 判定；命中即删除 outbox 并走既有源路径释放，不调用 create/append |
| task 显式 `retentionUntil: undefined` 会跳过默认 retentionDays | `_taskBatchInput` 只看 own-property，向 repository 传入 undefined 且不再传 retentionDays | undefined 等同未提供；仅明确 `retentionUntil:null` 或 `retentionDays:null|'permanent'` 表示永久 |
| terminal API 的真实 canonical 是 positional | PR1/PR2 `completeTaskBatch(batchId, options)`、`failTaskBatch(batchId, failure)`、`cancelTaskBatch(batchId, cancellation)` 调用均为 positional；Spec §5.2 写成 object | 只反向同步 Spec/notes/tests，不新增 object overload，不提前移植 PR2 complete metadata 逻辑 |
| 既有 diff 证据不是完整 PR gate | `git diff --check 63c1ce4` 精确报 `spec.md:3-9` 七处 trailing whitespace；此前无参数检查只覆盖当时工作区 | 修正文档证据；最终以 merge-base `63c1ce4...` 到 working tree/staged 等价范围检查 |

### Unknowns Register

| 未知 | 类型 | 影响 | 可逆性 | 当前证据 | 处理 | 最便宜验证方式 | 当前决定 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 登记失败的最小持久身份 | 主键血缘 | 高 | 容易 | controller 文件 payload 已稳定生成 artifactKey、方向、角色、路径和 metadata | PROBE | 注入一次正常 payload 的 `addArtifact` 失败，再走 terminal/retry | 直接落同表 failed artifact；不新增 intent 表 |
| tombstone 是否需要保存完整 batch DTO | 数据模型 | 高 | 一般 | 重放只需判定 module/operation 已发行且已删除；号码审计已有 batch/latest 事实 | PROBE | v2 删除重启重放、v1 outbox 删除重启 | 只存 issuance 的 module/key/batch id/number/issued/deleted 时间，不复制 batch metadata |
| outbox 命中 tombstone 后如何结束 | 状态生命周期 | 高 | 容易 | 现有成功 flush 会 remove 并释放不再 unresolved 的源路径 | PROBE | 真 outbox 跨 controller/repository 重启 | 视为不可重放的已处理记录：remove、计入 discarded、复用源释放；不建批、不追加、不永久自旋 |
| `retentionUntil:'permanent'` 是否是既有契约 | 兼容盲区 | 中 | 容易 | 现有永久枚举属于 `retentionDays`；`retentionUntil` 只接受日期/null | ASSUME | 现有 service/repository 测试与 UI 调用 grep | 不扩大字段语义；只修 undefined，保持日期/null 与 retentionDays 枚举分工 |

### BLOCK 问题

无。schema、公共返回和 outbox 清理的互斥方案均可由现有调用链锁定，不需要新增产品选择。

### 风险优先计划

| 顺序 | 步骤 | 消除的未知/保护的不变量 | 成功证据 | 失败影响 | 回滚/收缩 |
| --- | --- | --- | --- | --- | --- |
| 1 | failed artifact 最小持久化 | 部分 ready 时不能被 terminal 误判 complete | A ready、B 登记失败、terminal incomplete、B retry 后 complete | artifact 完整性仍不可信，停止交付 | 仅回退新 repository 方法与 service 接线 |
| 2 | issuance/tombstone 与 outbox 前置判定 | 删除后 operation 不复活、不烧号、不自旋 | v2 terminal/delete/restart/replay；legacy outbox delete/restart flush | 幂等主键可复用，停止交付 | 纯加法表与三处事务接线可独立回退 |
| 3 | 修正 task retention undefined | 默认保留期不被 own-property 绕过 | 单个表驱动覆盖 default/numeric/permanent | 只影响新 task 输入 | 回退一个 input 分支 |
| 4 | 反向同步 terminal API 与 Markdown | 单一 positional contract、完整 PR diff 可审查 | PR2 调用 grep；base→working tree diff check | 文档继续误导或门禁失败 | 仅文档等价变更 |
| 5 | 最小定向与静态门禁 | 不扩展行为面 | 定向 unit、node --check、lint、base diff gate 全绿 | 不发未提交检查点 | 修正失败根因，不加兼容分支 |

## PR #132 第三轮评论复核（2026-08-10）

### Task Brief

- Goal: 阻止平盘恢复入口在同一 operation 已永久删除后重新登记 filesystem outbox。
- Context: PR1 head 为 `44cdfbc`；review `#4897211115` 的四个 thread 均未过期，其中只有 `persistOperationIntent()` 绕过既有 operation tombstone 存在真实 Position 调用入口。
- Constraints: 复用 `archive_operation_issuances.deleted_at` 单一权威；不新增状态、fallback 或竞态协调；不为非法 artifact 参数、显式 artifactKey 碰撞、`retentionUntil:''` 添加生产防御或测试。
- Done when: Position 恢复 intent 在 tombstone 后返回稳定 deleted 结果，不 enqueue/append、不分号、不改变原 issuance；相关真实 SQLite 回归与静态门禁通过。

### 已确认事实

| 事实 | 证据 | 对方案的约束 |
| --- | --- | --- |
| 真实旁路从 Position IPC/恢复链进入 controller | `trackedIpcHandle` → `runPositionReconciliationOperation` → `runArchiveAwareOperation` / startup recovery → `persistPositionArchiveIntentIfNeeded` → `ArchiveCenterController.persistOperationIntent` | 只在 `_persistOutboxPayload` 前补 tombstone 判定，不泛化其它 controller 输入 |
| operation tombstone 已有单一持久权威 | `ArchiveRepository.getOperationIssuance(moduleId, operationKey)` 返回 `deletedAt`，create/reserve/flush 已使用同一事实 | 成功读到 deleted 时返回原 `batchId` 与稳定 `ARCHIVE_OPERATION_DELETED`，不得写第二套状态 |
| intent 是 archive DB 不可用时的 filesystem 兜底 | `persistPositionArchiveIntentIfNeeded` 在正式登记未形成 durable 证据后调用 controller intent；既有 outbox 跨重启恢复 | issuance read 失败不能阻断 outbox；只沿 controller warning 边界继续写，不新增重试 |
| 三条 direct/internal 输入没有生产入口 | Position 文件 descriptor 由主进程 pending 校验与快照生成；renderer/IPC 不暴露 raw artifact sink；controller intent 固定读取设置中的 retentionDays，不接收 Position retentionUntil | 非法 artifact 参数、显式 artifactKey 碰撞、`retentionUntil:''` 不加代码或测试 |
| flush/delete 竞态没有真实并发入口 | `flushOutbox()` 仅由 controller `initialize()` 调用；renderer 删除只能在启动初始化后由 IPC 触发 | 与真实 persist 旁路分开记录，不新增 lease/timer/锁或竞态测试 |

### Unknowns Register

| 未知 | 类型 | 影响 | 可逆性 | 当前证据 | 处理 | 最便宜验证方式 | 当前决定 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| persist 的删除判定由谁持有 | 状态所有权 | 高 | 容易 | repository issuance 已由 create/reserve/flush 共用 | PROBE | 真实 repository/service/controller 删除后调用 intent | 已消除：直接查询同一 issuance，不查 live batch |
| deleted intent 应抛错还是返回终态证据 | 恢复契约 | 高 | 容易 | startup recovery 在正常返回后清 pending；operation lifecycle 用 `batchId` 标记 durable reference | PROBE | 回查两条调用路径及现有 deleted service DTO | 已消除：返回原 batch id、`persisted:false`、deleted/code；不抛错、不造 outbox id |
| issuance 读取失败是否应阻断 intent | 失败模式 | 高 | 容易 | intent 本身是数据库归档失败后的 filesystem outbox 兜底 | PROBE | 复用既有 DB unavailable→outbox→restart 用例注入 read error | 已消除：warning 后继续 outbox；只有成功读到 deleted 才阻止写入 |
| 是否需要修 flush/delete 竞态 | 可达性 | 中 | 容易 | 生产仅启动时 flush，未发现运行期调用 | PROBE | 全仓 `flushOutbox` 调用搜索与 main 初始化时序 | 已消除：当前不可达，本轮不修 |

### BLOCK 问题

无。状态权威、真实入口与返回语义均可由仓库锁定。

### 风险优先计划

| 顺序 | 步骤 | 消除的未知/保护的不变量 | 成功证据 | 失败影响 | 回滚/收缩 |
| --- | --- | --- | --- | --- | --- |
| 1 | intent 写入前查询 tombstone | 删除后的 operation 不复活且 DB 故障仍能持久兜底 | deleted DTO 时 outbox 为空；read error 时 warning 后写 outbox | 任一边界失败即停止交付 | 回退单个 guard/catch |
| 2 | 扩展既有删除/重启真实 SQLite 用例 | 不烧号、不改原 issuance | cursor/issuance 前后不变 | 状态证据不足，停止交付 | 只保留一个端到端断言链 |
| 3 | 文档与最小静态/定向门禁 | 三条反证和竞态非目标不漂移 | unit、lint、syntax、base diff、check-vars 通过 | 不发未提交检查点 | 只修真实失败根因 |

## PR #133 九条 P1 评论复核（2026-08-11）

### Task Brief

- Goal: 在 PR2 stacked 到 PR1 最终头后，沿真实 UI/IPC → service/worker → DB/output 入口修复 review `#4897404953` 的九条 P1，保持批次血缘、恢复幂等和资金输出可审计。
- Context: PR2 已从旧 base `98ddcf9` restack 到 `origin/codex/v3.1.9-pr1-batch-identity@4933b7b`；旧 PR2 commits `be5cfba/1687cfa` 分别重写为 `80d6567/8f609a9`。九个 thread 均为 unresolved、`isOutdated=false`。
- Constraints: 不新增 timer、lease、generation、第二 tracker、latest fallback、批处理重试或 hash 系统；不改 runCheck SQL/算法、Position checkpoint、金额/币种/匹配和输出格式；每个测试只对应真实入口或明确持久状态。
- Done when: 九条真实 P1 均以最小改动和最小回归锁定；资金红线完成人工复核清单；自动门禁通过。真实 Electron crash/restart 与 GUI 验收仍单独保留，不以自动测试代替。

### 已确认事实与决定

| ID | 真实入口与证据 | 当前决定 | 明确非目标 |
| --- | --- | --- | --- |
| P1-1 | `TaskLifecycle.run()` 的业务结果、artifact 与 flow bind 均完成后写 terminal；非 benign `ok:false` 只 `recordFailure()`，随后释放 BOR，原 batch 可保持 `running/incomplete` | 复用 filesystem outbox；terminal-only intent 只校验已冻结 7-field context、不读取故障中的 archive/settings DB；flush 在附件 durable 后对原 batch 精确 CAS，成功/同终态才移除 | 不建第二 tracker，不加 timer 或无限重试，不新建 batch |
| P1-2 | `acquiringBillCurrency:run` 仅有 `execute`，DB/month admission 与月锁均发生在 reserve/started 之后 | 改为 object handler；prepare 在 BOR/reserve 前校验并取得现有月锁，`onAbandon` 与 execute `finally` 幂等释放；execute 只用 prepared month | 不排列非法 payload；只锁 invalid month 与真实锁争用代表 |
| P1-3 | acquiring run 绑定 `acquiring-run:${source}:${monthKey}:${runId}`，export 却 starts-new-flow 并绑定主库镜像裸 ID | export prepare 读取主库选中镜像；side 镜像只在 side DB 中取得唯一且与镜像字段一致的 run，legacy main 直接使用该行；构造完全相同的 flow identity/plan，证据缺失或冲突 fail-closed | 不按月份/latest 猜 side run，不影响 acquiring import/clear |
| P1-4 | `settlePositionRecoveredTask()` 把任何 terminal conflict 都当幂等成功，随后 finalizer 会清 pending | 仅 `actual taskStatus === wanted taskStatus` 时接受冲突；不一致直接抛错，保持 checkpoint/pending | 不扩通用状态机，不排列无入口状态 |
| P1-5 | Position worker 对 mutating START 使用 optional `freezeWorkerBatchContext()`；普通来源在 `APPLY_GRANTED` 才越过写屏障 | 对 `BANK_APPLY`、`ACCOUNT_APPLY` 和三个 maintenance 写命令强制 required；`SOURCE_PREPARE_AND_APPLY` 的 START 继续无 context，但真正写入前的 `APPLY_GRANTED` 强制 required | `BANK_PREPARE` 与 schema-only 保持豁免；不改变协议版本或读路径 |
| P1-6 | scenarios picker 后先 read/parse bundle，再由 context store `statSync` 建基线，可形成内存 A/归档 B | picker 返回后、读取前由 context store 固定 source evidence；read/parse 后 create 时立即重校验，再保留现有 apply/beforeStart freshness | 不为同 inode/mtime 理论碰撞新增 hash/暂存系统 |
| P1-7 | 大账号 complete 仅比较 assignment 数量；重复 `rowIndex` 会被后续 `Map` 折叠并继续生成资金输出 | 要求 assignment row-index 集合唯一，且与服务端 expected rows 的 index 集合完全相等，再执行账号/币种校验与排序 | 只补 `[0,0]` 对预期 `[0,1]` 的反例；不加重复组合矩阵 |
| P1-8 | statement duplicate resolver 在算 hash/等待覆盖确认后才创建 freshness baseline | picker paths guard 在每次 duplicate confirmation 返回后立即复核，并在 resolver 整体返回后再复核一次；随后以最终 filePaths 创建 source guard，供 preview/beforeStart 使用 | 不让已从最终 selection 移除的输入继续阻断 execute；不重做会话系统或引入 lease/retry |
| P1-9 | side worker 先把 progress 写为 `complete` 并持久化 7-field context/输出路径，main mirror 与 archive terminal 在 worker 返回后才完成；main 此时可仍是上一轮 stale mirror | resume 只接受可证明的 side complete run；execute 沿正常成功路径的 canonical upsert 替换 stale mirror，exact current mirror 才 no-op，再由原 TaskLifecycle 登记/终结 | 不给 legacy complete 猜 batch，不分新号、不 find-latest、不新建恢复系统；输出证据缺失 fail-closed |

### Unknowns Register

| 未知 | 类型 | 影响 | 当前证据 | 处理 | 当前决定 |
| --- | --- | --- | --- | --- | --- |
| terminal intent 与 artifact outbox 如何避免同 operation 覆盖 | 持久状态 | 高 | controller 当前同 operation 只保留一个 outbox，`append()` 只合并 files | PROBE | 在同一 record 原子合并 terminal outcome；flush 顺序固定为 files durable → terminal CAS → Position callback/remove，不创建平行记录 |
| side export 如何证明主镜像对应的 side run | 主键血缘 | 高 | side 新 run 在事务内先 `clearRunsByMonth`，每月只保留当前 run；主镜像有 side path、summary、状态与输出路径 | PROBE | side 查询必须唯一且逐字段匹配 prepared 主镜像；不以 `ORDER BY latest` 建立身份 |
| complete recovery 能否在输出未完成时安全收口 | 崩溃窗口 | 高 | progress 可在 writer 前已为 complete，但成功 worker 返回前 run paths 未必齐全 | PROBE | 只有成功状态、两条持久输出路径和文件新鲜度都可证明时进入 completed recovery；否则保持 fail-closed，不伪造成功 |
| Position APPLY_GRANTED 的 account-only preflight 是否需要 context | 可达性 | 中 | account-only 只结束 preflight、不写库；普通来源有 accepted rows 时才等待 lifecycle apply gate | PROBE | required 只落在实际写入分支；preflight-only grant 保持无批次，测试明确区分 |

### BLOCK 问题

无。九条均有真实入口和单一最小状态所有者；实现开始前不需要新增产品决策。

### 风险优先计划

| 阶段 | 范围 | 最小成功证据 | 停止条件 |
| --- | --- | --- | --- |
| A | P1-1、P1-2、P1-3、P1-9 | terminal intent 跨重启收口原 batch；fresh invalid/busy 0 issuance；run→重复 export 同 parent；complete side crash 恢复 0 worker/0 新号且补 mirror/output/terminal | 任一身份需要 latest 猜测或新恢复系统 |
| B | P1-4、P1-5、P1-6、P1-8 | Position conflict 保留 pending；真实写命令缺 context 零副作用；scenario/statement 人工确认窗口源变化 fail-closed | 需要改协议版本、checkpoint 或引入 hash/lease |
| C | P1-7 与综合门禁 | 单一 `[0,0]` 资金反例被拒；聚焦/完整 unit、integration、smoke、lint、syntax、diff/check-vars 通过 | 行集合校验改变正常乱序输出或金额/币种语义 |

## PR2.5-0 纠错合同冻结 Preflight（2026-08-11）

### Task Brief

- Goal：把 v3.1.8 上线后 VCC 财务 OP 纠错 Spec v2 / TechDoc v1.1 冻结为仓库合同，并只对 v3.1.9 的 VCC 归档兼容、操作保护和性能路径增加窄范围 erratum。
- Context：实施基线为 PR2 冻结头 `54b6c01fa93751cd723be53af70af726037343b5`；PR2 自动门禁已通过，但 GUI、真实崩溃/重启及资金人工验收仍待完成。
- Constraints：纯文档；不改生产/测试代码，不改金额、币种、五表计算和 PR1/PR2 合同，不改三份用户发布文档，不追溯声称 v3.1.8 二进制已包含纠错。
- Done when：来源、版本、日期、raw/repository SHA 和等价格式转换可追溯；v3.1.9 erratum 与严格串行顺序冻结；测试/发布 PROBE 和资金人工门禁不被自动化替代。

### 已确认事实

| 事实 | 证据 | 对方案的约束 |
| --- | --- | --- |
| 外部 Spec v2 与 TechDoc v1.1 内容已锁定 | raw SHA-256 分别为 `34778f235705ceea9f5a00d732ab3e97d1873d5105e0e4b55908f2ef5917fcf1`、`08e9f90600ec81dd881fdb12e4e2fb8a10b39baa9ec01918a08a05509ee84549` | 不修改产品/技术正文；仓库化转换必须显式留证 |
| v3.1.8 原 Spec 是发布冻结证据 | `changes/3.1.8/spec.md` 规范化 SHA-256 `1f5f0663ee35436c8b1f7da628822a4f83a3f70db215cd5ebd60a6720bae367d`；release-docs 测试锁定该值 | 不向原文件 append；补遗使用独立目录并由 PRD 索引 |
| raw 两文档各有 6 处 metadata hard-break | header 行尾两个空格会触发 `git diff --check` | 仅把 12 处等价改为 `<br>`，记录 raw/repository 双 SHA，并验证除此之外一致 |
| 当前 3.1.9 原计划把 VCC 与工具箱合在 PR3 | 本 Spec 原 §14 与 tasks 后续清单 | 仅改 normative schedule 为 PR2.5 四阶段及 PR3-VCC/PR3-Toolbox 独立串行；历史 evidence 不重写 |
| TechDoc implementation-ready 不等于 merge/release ready | TechDoc §20 与 Definition of Done | runtime、真实旧库、16 GB 和人工资金门禁继续保留为 PROBE |

### Unknowns Register

| 未知 | 类型 | 影响 | 可逆性 | 当前证据 | 处理 | 最便宜验证方式 | 当前决定 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| PR2 人工 GUI、真实崩溃/重启与资金结果 | 上游基线 | 高 | 一般 | 自动门禁全绿，人工项仍明确 pending | PROBE | 按 PR2 test-spec P0→P1 人工清单 | 未通过则整条 PR2.5+ 堆叠 rebase/重验，禁止合并 |
| 真实 v3.1.7 归档经 current migration 的精确形态 | 数据兼容 | 高 | 困难 | 当前只有合同，无真实生成 fixture | PROBE | 用 v3.1.7 真实代码生成 fixture + manifest | 不符先修合同或阻断，不放宽 classifier |
| Windows packaged SQLite 能力 | Runtime | 高 | 一般 | 本机/设计证据不能替代 packaged runtime | PROBE | installer/portable 验证 `createSession/readOnly/query_only/UPDATE FROM` | 任一缺失阻断；不降级无保护提交 |
| 目标生产库 trigger 与 legacy-four 形态 | 兼容/数据 | 高 | 困难 | 未对一致性生产副本完成本轮 inspect | PROBE | `sqlite_schema` 与完整副本只读报告 | 未批准 trigger 或非标准形态均 fail-closed |
| 约 16 GB 库的 P95、WAL 和主进程延迟 | 性能 | 高 | 一般 | 设计门禁已定义，目标副本尚未跑 | PROBE | 冷/热基准、SQL trace、event-loop lag | 不达标继续定位，不用机器差异放宽门禁 |
| 主体、九币种、金额、跨月血缘和审计结果 | 资金 | 高 | 困难 | 自动化不能证明真实财务事实 | PROBE / 人工 | 财务逐项复核与备份恢复演练 | ⚠️ 资金红线；阻断发布，不以 CI 替代 |

### BLOCK 问题

无。仓库化路径、冻结 Spec 保护和窄 erratum 均已由现有证据与评审决定，不需要新增产品选择。

### 保守假设

- `changes/3.1.8/erratum/` 只承载本次两份合同及来源索引，不复制其它版本文档或另造兼容矩阵。
- 本 PR 未发布新版本且没有用户行为落地，因此不修改 `CHANGELOG.md`、`docs/USER_GUIDE.md` 或 `docs/VERSION_FEATURE_HISTORY.md`；PR7 发布时再按版本规则同步。

### 风险优先计划

| 顺序 | 步骤 | 消除的未知/保护的不变量 | 成功证据 | 失败影响 | 回滚/收缩 |
| --- | --- | --- | --- | --- | --- |
| 1 | 归档双合同与 provenance | 原文来源、格式转换和合同关系可追溯 | raw/repository SHA、12 处 normalization-only diff、链接存在 | 合同身份不可信，停止交付 | 删除独立 erratum 目录，不碰冻结 Spec |
| 2 | 增加 v3.1.9 窄 erratum 与严格 schedule | C01—C14/PR1/PR2 不漂移，VCC/Toolbox 不混合 | 精确文本检查与人工 diff review | 后续实施边界错误，停止 A | 回退本 PR 文档增量 |
| 3 | 增量维护 tasks/test/notes | 既有 PR1/PR2 证据和 pending 人工项不被覆盖 | 原证据仍在；A/B/C/PROBE 均未误标完成 | 产生虚假验收，停止交付 | 删除新增节，不改历史节 |
| 4 | targeted docs gate | 冻结 hash、链接、Markdown 与 docs-only 边界 | normalization、hash/link、diff-check、release-docs 定向测试 | 不进入 review | 修正文档后重跑 |

## PR2.5-A 兼容合同 Preflight（2026-08-11）

### Task Brief

- Goal：只建立 ArchiveEvidenceV2、生效结果纯校验器、current/legacy/inconsistent classifier、独立 unarchive gate，以及真实 v3.1.7 fixture；不切换现有生产入口。
- Context：基线为 PR2.5-0 冻结头 `967a3ad91d49c27e62044ee25e57039ca576a0a5`。当前 `unarchive.js` 把 DB 读取、current-only 分类和 gate 耦合，`getEffectiveRunResult()` 仍逐 run 查询；这些读取路径只允许 PR2.5-B 修改。
- Constraints：四个 `src/backend/vcc-financial-op/` 新模块保持纯函数/DTO 层，零 SQL、零 DatabaseSync、零 task/runtime state、零现有 production consumer 接线；不实现 B 的 loader/worker/token/schema-ready/cache 或 C1/C2 写保护与删除计划。
- Done when：纯结果证据重算 rowKey、调整 sequence/revision、基础余额公式和九币种有效余额；classifier 精确区分 current-five、legacy-v3.1.7-four 和 inconsistent；gate 与 classifier 正交；真实 tag fixture 经 current migration 后分类 legacy；自动证据不替代真实旧库和财务人工门禁。

### Phase 0 已确认事实

| 事实 | 证据 | 对实现的约束 |
| --- | --- | --- |
| tag 与 commit 精确 | `v3.1.7^{commit}=1117c8b7d047cf408807b023368c63123a90d81f` | 生成器必须先核 tag/commit，再从 tag 源调用真实入口 |
| tag/current 依赖锁一致 | 两份 lock 除根版本号外等价；xlsx 0.18.5、sax 1.6.0、yauzl 3.3.0、buffer-crc32 0.2.13、pend 1.2.0、Electron 36.9.5 均一致 | 生成证据记录 declared/locked/resolved 版本与真实路径，不静默借用未核依赖 |
| 真实 tag 链可完成 | tag migration → inspect/import 四文件 → initializeOpeningBalances → calculateMonth → archiveRun → close/reopen 全部成功 | 禁止手工 INSERT 业务表模拟旧库 |
| tag 原始 run 没有三个新列 | `result_revision/input_fingerprint/updated_at` 在 v3.1.7 schema 物理不存在 | manifest 必须区分 column absent 与 SQL NULL |
| current migration 得到精确 legacy shape | 新列为 `result_revision=0`、`input_fingerprint IS NULL`、`updated_at=archived_at`；四 dataset archived/run 对齐，adjustment/Pending 全 0 | classifier 不以“缺 Pending”单条件猜 legacy，也不放宽为 empty fingerprint |
| 资金结果可逐坐标解释 | PPHK 九币种：USD 期初100+发生额8=108，EUR 100+3=103，其余100；archive 与 stored calculated balance 一致 | 纯校验器必须重算公式并按 effectiveCalculatedBalance 比 archive |

原型实际运行于 macOS arm64 / Node 24.13.0 / SQLite 3.50.4；同一锁定 Electron 36.9.5 的只读 runtime probe 为 Node 22.19.0 / SQLite 3.50.4。Windows packaged runtime 仍是发布 PROBE，不由本机证据关闭。

### Unknowns Register

| 未知 | 类型 | 影响 | 处理 | 当前决定 |
| --- | --- | --- | --- | --- |
| tracked 生成器能否复现同一业务 shape | Fixture | 高 | PROBE：由脚本重新生成 DB/manifest 并校验 manifest 与文件 SHA | 失败即停止，不复制 Phase 0 临时 DB 或手修二进制 |
| 纯 classifier 是否接受真实 migrated fixture | 兼容 | 高 | PROBE：测试复制 fixture、current migration、close/reopen 后构造同一 ArchiveEvidenceV2 | 不符先修实现或合同，禁止 fallback |
| 真实生产旧库是否为标准 legacy-four | 数据兼容 | 高 | PROBE / 上线前完整副本只读 inspect | 非标准一律 inconsistent |
| 主体、九币种、跨月与审计是否符合真实财务事实 | 资金 | 高 | ⚠️ 财务人工复核 | 自动测试不得宣称关闭 |

当前无 BLOCK。Phase 0 首次工作簿把方向写成中文“入/出”，tag importer 以真实 `format_error` 拒绝，属于测试设计错误；改为 tag 合同 `in/out` 后重建全新临时库通过，未手工补表或放宽生产约束。

### 风险优先计划

| 顺序 | 步骤 | 最小成功证据 | 停止条件 |
| --- | --- | --- | --- |
| 1 | 纯 result evidence | valid adjusted current 与各独立资金/血缘 invariant 的一个 table-driven 反例 | 需要 DB/SQL 或默认容错 |
| 2 | archive evidence/classifier/gate | current、真实 legacy、单一 Pending SQLite 变异与 gate 正交 | current 失败后尝试 legacy fallback，或 structural reasons 混入 task/later/import |
| 3 | tag 生成器与 manifest | 真实函数链、schema/counts/run/revisions/九币种/DB SHA 可追溯 | 需要手工业务 INSERT、复制临时 DB 或依赖版本漂移 |
| 4 | 聚焦门禁与人工边界 | 10 个 top-level 测试、syntax/lint/diff/check-vars；资金人工项保持 pending | 自动 PASS 被写成真实旧库/财务验收结论 |

### Phase 1 收敛证据

- tracked 生成器已从 tag 重新运行真实链并生成 fixture/manifest；未复制 Phase 0 临时 DB，也没有手工业务 INSERT。生成时 DB SHA 为 `6de511e630c420b60fa5dc1d858fd0cd40fb7261b33503756abf6dba6b57952b`，source/current-migrated schema hash 分别为 `237871d5b4534b3c57d8f2059214a75b85a633054494bb3707a0e6f2d23970ba`、`b168643ede7071e5c01c395b11bbc8e4be2a8d1b71e0c2189ac6149016fb83c1`。
- generator SHA、fixture SHA、依赖版本/相对解析路径、schema/counts/run/revisions/主体×九币种和 current migration probe 均写入 manifest；输入 workbook hash 明确只作当次 generation provenance。
- pure modules 静态检查为零 SQL/DatabaseSync/现有 production consumer 接线；task/runtime state 只存在于独立 gate evidence DTO，不进入 structural classifier。
- Unknowns 中 tracked 复现与 pure classifier 接受真实 migrated fixture 两项已消除；真实生产旧库、Windows、16 GB 与财务人工继续保留 PROBE。
- 最终本地门禁第二轮 `release-check` 全绿：lint/smoke PASS，unit 4940/4940（317 files，0 fail/skip），integration 48/48 scripts、2459/2459 assertions。首轮唯一失败是既有大文件拆分 RSS 样本恰等于严格 `<150MB` 上限；原脚本独立复跑 31/31、第二轮完整门禁 31/31，确认环境边界波动，未改阈值、未加重试、未改 PR2.5-A 代码。
- integration runner 只在第二轮全绿后自动刷新 `rules/integration-test-policy.md` §七的 timestamp/timings，总数保持 48/2459；该生成证据按仓库惯例保留，未手工编辑。

## PR2.5-B 读取性能 Preflight（2026-08-11）

### Task Brief

- Goal：把 VCC 数据管理、归档枚举与破坏性操作 preview 的重读取移出 Main，同一只读快照内集合加载 PR2.5-A 证据并生成 token v2；补齐活动月份、删除目标一次快照、弹窗 shell/cache 和 SQL/响应性证据。
- Context：基线为 PR2.5-A 冻结头 `26d91e8b673a4e6f306ee608d545efa5d0971e4c`。现有 production 仍在 Main 同步执行 `listArchivedResultMonths()` / `buildOperationState()` / `getEffectiveRunResult()`，数据管理弹窗在月份读取完成前不会挂载。
- Constraints：read worker 使用 `DatabaseSync(dbPath, { readOnly: true })`、`query_only/foreign_keys/busy_timeout` 和 `BEGIN DEFERRED`；零 migration、DDL、DML、recovery 和业务写。只断言仓库现有 schema/PK/index，不新增表、列或索引。不实现 C1 mutation guard/adjustment/archive 写链，不实现 C2 unarchive/delete 写计划，不改变金额、币种、九币种或导出文件内容，不增加 fallback。
- Done when：current/legacy 都可枚举和导出；inconsistent 排除并带结构化诊断；active/importing/unresolved/later 只影响 gate，不隐藏月份；archive 0/1/100 候选保持常数 SQL 且零 import rows/opening/N+1；delete targets 一次 evidence；modal 先于后端完成出现且 target change 零 IPC；Main 复核 generation 和 active task identity；自动证据不冒充约 16 GB、Windows packaged 或财务人工验收。

### 已确认事实

| 事实 | 证据 | 对实现的约束 |
| --- | --- | --- |
| 数据管理首屏被读取阻塞 | `openDataManager()` 在 `mountDialog()` 前等待 `Promise.all(listImportMonths, listArchivedResultMonths)` | shell、月份 loading、归档按钮 loading 和内容 skeleton 必须先挂载，再启动读取 |
| 归档枚举是逐月/逐 run 重读取 | `unarchive.js` 先候选 UNION，再逐月 `buildOperationState()`；一致性检查逐 run 调 `getEffectiveRunResult()` | production 枚举/preview 改用 set loader；A 的纯 validator/classifier 是唯一结果语义 |
| v1 state 会读取禁表 | `buildOperationState()` 包含 opening、source facts 和 `vcc_fin_op_import_rows` | B archive list/preview 的 SQL trace 必须为零 import rows、零 opening |
| 删除目标重复读取同一月份 | `listDeleteTargets()` 对 source/opening/result 逐项调用 preview，并额外 COUNT runs | 同一 DeleteEvidenceV2 一次读取，内存派生完整 target preview cache |
| 活动月份当前不完整 | renderer 的月份来自 `listImportMonths()`，repository 只按 import records 分组 | 使用 TechDoc §9.1 的八来源 UNION；active/unresolved/importing 是可见事实和 gate，不是隐藏条件 |
| Node 只读连接合同本机成立 | `/tmp` probe：Node 24.13.0 / SQLite 3.50.4 上 readOnly、三 PRAGMA、BEGIN DEFERRED 成立；DDL 报 readonly | 作为实现证据；Windows installer/portable 仍需独立 PROBE |
| 现有 effective index 可覆盖活动月份 | `EXPLAIN QUERY PLAN` 使用 `idx_vcc_fin_op_effective_month_source` covering index | 不新增 migration/index；其他表允许各一次集合扫描，真实大库不达标则阻断并反向同步合同 |
| worker 会被现有打包规则包含 | `package.json build.files` 已包含 `src/**/*`，现有 VCC worker 同样从 `__dirname` 拉起 | 新 read entry 无额外资源配置；packaged Windows 仍需 runtime 验证 |

### Unknowns Register

| 未知 | 类型 | 影响 | 处理 | 当前决定 |
| --- | --- | --- | --- | --- |
| token v2 与现有 v1 write 的中间状态 | 合同/安全 | 高 | BLOCK 已由负责人裁决 | B 正式切 v2 preview；B/C1 中间分支不可发布，旧 write 必须 fail-closed 且零业务 DML；禁止兼容桥，C2 才恢复最终提交 |
| Windows packaged readOnly/query_only/worker | Runtime | 高 | PROBE | installer/portable 验证失败即阻断，不降级到 Main 同步或可写连接 |
| 约 16 GB 库 P50/P95、WAL 和 event-loop lag | 性能 | 高 | PROBE | B 只提供结构硬门禁、合成 0/1/100 和本机 gross regression；真实副本未达标不得用机器差异关闭 |
| 目标生产库 legacy-four/trigger | 兼容 | 高 | PROBE | 非标准 legacy 一律 inconsistent；trigger 与写保护留给 C1/C2 只读 inspect/人工门禁 |
| 主体、九币种、有效余额和跨月血缘 | 资金 | 高 | PROBE / 人工 | ⚠️ 自动测试只证明算法合同；真实导出与备份恢复由财务人工复核 |

当前无待用户确认的 BLOCK。B/C1 intermediate non-release 是阶段合同，不是最终用户行为。

### 精确 Ownership

- 新增 `src/backend/vcc-financial-op/read-schema.js`：只读 schema-ready 断言。
- 新增 `src/backend/vcc-financial-op/read-snapshot.js`：archive set loader、gate evidence、active months、DeleteEvidenceV2/target previews 和 SQL trace hook。
- 新增 `src/backend/vcc-financial-op/operation-token-v2.js`：canonical payload、稳定 SHA 和 validated result digest。
- 新增 `src/main-process/vcc-financial-op-read-worker.js`：五个 read action 的独立 read-only entry。
- 修改 `src/main-process/vcc-financial-op-service.js`：read dispatch、generation/active identity 复核、活动月份 generation cache、async read API，以及复用现有 `runDirectTask` 的导出二次重查。
- 修改 `src/main.js`：现有 VCC read/export IPC await async service；不新增通道、preload 或 TaskPolicy。
- 修改 `src/renderer-vcc-financial-op.js` / `src/styles-vcc-financial-op.css`：shell-first、mutable state、inline retry、target cache 和 refresh-once。
- 新增/修改聚焦 unit、VCC integration、`scripts/perf/vcc-financial-op-read-performance.js` 与本版本四份管理文档。
- 明确不修改 `vcc-financial-op-db/migrations.js`、PR2.5-A 四个纯模块、`operation-state.js`、`unarchive.js`、`data-target-deletion.js`、现有 write worker、三份发布用户文档。

### 风险优先计划

| 顺序 | 步骤 | 最小成功证据 | 停止条件 |
| --- | --- | --- | --- |
| 1 | schema-ready/token/set loader | 缺 schema fail-closed；current/真实 migrated legacy 同一 A classifier；0/1/100 固定 SQL | 需要 migration、新索引、import rows/opening、逐月或逐 run 查询 |
| 2 | read worker 与 Main freshness | readOnly/BEGIN DEFERRED；unknown action 先拒；worker 返回后 generation/active identity 精确复核 | 需要 TaskLifecycle/batch、retry/lease/timer 或可写连接 |
| 3 | service/main/export 接线 | 初次导出读取和 `runDirectTask` 内二次重查都消费 B snapshot；legacy 可导出 | 仅初次读取走 B、二次回退 v1/current-only |
| 4 | renderer shell/cache | mount 早于 await；完整 target response 缓存；state-changed 全量刷新；成功 refresh-once | cache 放宽 token/generation freshness，或 target change 再发 preview IPC |
| 5 | 聚焦/性能/人工边界 | SQL硬门禁、main lag、target switch、gross budget、intermediate fail-closed 单一真实链 | 小 fixture 被写成 16 GB/Windows/财务验收，或为边界样本加 retry/放宽阈值 |

## PR2.5-C1 写保护 Preflight（2026-08-11）

### Task Brief

- Goal：为 adjustment/archive 建立单一 table policy/SQL step registry、generation-bound 独占 claim、专用零 migration write worker，并在 `BEGIN IMMEDIATE` 内以 B 的同源 raw evidence 重算 token v2，再生成和执行固定 MutationPlan。
- Context：基线为 PR2.5-B 冻结头 `ac882a3846571ab57692b8be633413e919cf2a54`。当前两个生产写入在 Main 中走 `runDirectTask`，且使用 `snapshotResultMutationState()` 扫描全部 19 张 VCC 表；旧 rollback audit 也不是受保护的独立事务。
- Constraints：零 schema/index/migration；不改金额、币种、九币种和跨月公式；不造第二 token/state/tracker；不增加 lease/timer/retry/fallback；不触碰 C2 unarchive/delete 计划或 v2→v1 桥接；不为 renderer/IPC 真实不可达反例加防御。
- Done when：adjustment 固定总变化 `2`，archive 固定总变化 `N+7`；所有生产 DML 仅来自 registry；同事务 token 与 preview 精确一致；legacy-four calculated 在 plan 前返回 `result-recalculation-required` 且零 DML；safe failure 仅在原事务回滚后走 audit-only，unsafe failure 数据库零失败审计；归档 UI 保持响应。

### 已确认事实与批准修订

| 事实 | 证据 | 对实现的约束 |
| --- | --- | --- |
| current migration 产生 19 张 VCC 表、零 production VCC trigger | `ensureVccFinancialOpTablesSupport(:memory:)` 后枚举 `sqlite_schema` | registry 必须 exact-match 19 表；approved trigger set 固定为空，未知表/trigger 首写前失败关闭 |
| 本机 SQLite session 基础合同成立 | Node 24.13.0 / SQLite 3.50.4：`createSession` 存在，空 changeset=0，trigger 间接写 changeset 非空，`total_changes` 包含 trigger，commit/rollback 后可 close | 开发机 probe 不代替 Windows packaged probe；失败不得降级 |
| 四张大表不能建普通 protected session | 负责人在 preflight 批准时明确修订 | `effective_rows/import_rows/system_snapshots/system_snapshot_attempts` 的 C1 `largeTableScopeProof` 固定为 approved-trigger=0 + immutable registry 零 C1 step 指向大表 + 每 step `.changes` + operation `total_changes` 精确守恒；只对其余小型 protected 表建 empty-session |
| 旧 helper 可保留 | 旧 calculator/result-adjustments 测试仍用于 legacy/offline 证据 | 不为旧 helper 补 C1 防御；静态生产调用图必须证明 adjustment/archive 只有 C1 worker+registry 唯一路径 |

### Unknowns Register

| 未知 | 类型 | 影响 | 当前决定 |
| --- | --- | --- | --- |
| result-write preview 尚无 v2 token | PROBE 已收敛 | 高 | 在同一 `operation-token-v2.js` 和 B raw evidence 上扩展 adjustment/archive action；`run:get` 返回 token+generation，不造第二系统 |
| Windows installer/portable `createSession` | PROBE | 高 | 跑专用 runtime probe；任一合同不成立阻断发布 |
| 目标生产 trigger/legacy shape | PROBE | 高 | 上线前只读 inspect；未批准 trigger 或非 exact legacy 失败关闭 |
| 约 16 GB P95/WAL/main lag | PROBE | 高 | 小 fixture 仅 gross regression，真实副本不达标继续定位而不放宽 |
| 主体×九币种、有效余额、跨月和审计 | PROBE / 人工 | 高 | ⚠️ 资金红线，必须财务人工复核，自动化不关闭 |

当前无 BLOCK。

### 精确 Ownership 与风险优先顺序

- 新增 mutation policy/guard/result-write 纯合同与执行模块、C1 专用 write worker、runtime probe、result-write performance 脚本及聚焦测试。
- 修改 B token/read snapshot/read worker/read schema，仅扩展 result-write preview；修改 service/main/preload/renderer，仅切换现有 adjustment/archive 入口、progress 和 async `run:get`。
- 不修改 migrations/schema/index、A 四纯模块/classifier、C2 三个写模块、PR2 TaskLifecycle 或发布文档。七字段 context 只允许缺失或恰好 refreeze，PR3 前不伪造。

| 顺序 | 纵切 | 最小成功证据 | 停止条件 |
| --- | --- | --- | --- |
| 1 | policy/registry + runtime/trigger probe | 19 表 exact；四大表零 session；未知表/trigger/runtime 失败前零 DML | 需要 migration、fallback 或大表 session |
| 2 | result preview token + claim/worker | generation/identity 失效零 worker；critical 前可 cancel、后不 terminate | 需要第二 tracker/lease/timer 或伪 context |
| 3 | adjustment 2 变化 | 两 step 预算、session/total/postcondition/success evidence 全通过 | 任一 DML 不来自 registry |
| 4 | archive N+7 | A effective balance、九币种、五 dataset、success audit 精确 | 依赖旧全事实 SHA/preflight scan |
| 5 | failure audit/UI/perf | safe audit-only；unsafe 0 audit；main lag/P95 门禁 | audit 覆盖原错误、retry 或放宽阈值 |

### 测试边界

- 每个独立写不变量仅一个 table-driven/故障注入代表；不做 step×fault 笛卡尔积。
- 每个 registered step 按合同各保留一个 `.changes` mismatch；相同 rollback/audit 语义不复制。
- 四大表用一个代表直接写故障证明 registry/total 守恒，且断言从未 `createSession`。
- legacy-four adjustment/archive 两 action 使用同一 table-driven 合同；C2 v2→v1 只保留 B 既有中间失败关闭证据。
- ⚠️ 金额、币种、跨月期初和审计结果必须人工复核。
