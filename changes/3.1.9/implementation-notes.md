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

## Assumptions

| 假设 | 依据 | 失效影响 | 验证与回滚 |
| --- | --- | --- | --- |
| PR2 会为每次新用户任务提供新的稳定 operation/taskRun identity | Spec §5.5，当前 PR1 不接 action | 相同 operation key 会按设计复用批次 | PR2 policy/flow 测试负责；PR1 只锁 repository 幂等 |
| PR1 latest issuance 只提供真实发行事实 DTO，不组合 UI 统计 | PR6 明确负责统计/UI | 后续 DTO 可能追加 status | 追加字段即可，不改分配语义 |

## Deviations

无产品行为偏离。为落实 Spec 已明确的跨重启 parent 恢复与 latest issuance 口径，PR1 追加了纯加法 `archive_flow_anchors` 和日游标上的真实发行事实字段；BusinessFlowResolver 与业务入口接线仍留在 PR2。

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

## Remaining Unknowns

| 未知 | 处理 | 负责人/下一步 | 合并影响 |
| --- | --- | --- | --- |
| PR2 各模块采用哪一种稳定 business identity type/value | 后续实现 | PR2 BusinessFlowResolver 按各模块已有 runId/operationToken 显式选择 | 不阻塞 PR1；禁止月份/hash fallback |
