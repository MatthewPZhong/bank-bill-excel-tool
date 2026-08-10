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
