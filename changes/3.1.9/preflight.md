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
