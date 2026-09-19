# E05-P0 Unknowns Preflight

## Task Brief

- Goal：冻结旧 PreFund 多文件 mixed-result/transport crash 生命周期，并为每文件业务提交建立最小、幂等、可测试的 operation receipt schema/contract。
- Context：基线为已审查 E05-A commit `5da07fc3b9d73a39aa7864fb42576a0583ec5500`；E05-A 已提供只读 Parser/spool/Ordered Coordinator，但 transport crash 产品映射仍显式未决。
- Constraints：不接 live handler；不实现 Writer mutation、Critical Intent、handshake、inspector 或 Parser Pool >1；不改变金额、币种、source sequence、repair token、候选顺序、dataset version 业务规则或 production enablement；不运行 release-check/check-vars/scan:vars。
- Done when：mixed-result 与 transport crash 结论有真实 service/handler/policy/TaskLifecycle/Renderer golden；source-month Side DB 可幂等升级 receipt schema；outcome 仅允许 `inserted` / `replaced` / `noop-existing-batch`；同 action/fileOperationKey 最多一条 receipt；receipt-only 月库不会被临时批次清理误删；定向回归通过。

## 已确认事实

| 事实 | 证据 | 对方案的约束 |
| --- | --- | --- |
| 精确基线无漂移 | `git rev-parse HEAD` 与 merge-base 均为 `5da07fc3...`；parent 为 `8e0e4657...` | 只在该基线之上实施 E05-P0 |
| 旧 service 对每个 `tempStore.importFile` 的任意异常都转成 file result 并继续 | `service.js:298-355`；只读注入 probe 得到 `[ok, failed, ok]`、父 `status=ok`、2/1 计数 | transport crash 必须 `fail-unit-and-continue`，不能升级为 fail-job |
| mixed parent result 被真实 handler 原样返回 | `main.js:17696-17742` | handler 对 mixed 不抛异常、不改父 status |
| generic policy 把父 `status=ok` 分类为 Task succeeded | `task-policy-registry.js:438-449,771-779`；probe 经真实 policy + `taskResultStatus` 得到 `succeeded` | TaskRun/File Batch 终态均冻结为 succeeded-with-partial-result 语义 |
| Renderer 对 mixed 成功响应弹部分失败提示，finally 后刷新 session 状态 | `renderer.js:6323-6358,6296-6299`；renderer seam 回归通过 | Renderer 不进入全任务失败页；提示后恢复普通 session 状态框 |
| PreFund 临时 MPT 业务 mutation 的唯一真值在 source-month Side DB | `run-data-store.js:53-59,531-610,925-942`；`pre-fund-reconciliation-store.js:335-539` | receipt 必须在同一 source-month DB，才能与未来 Writer mutation 同事务 |
| Platform `worker-durable` 强制 module-local receipt 与业务 mutation 同事务 | `platform-contract-v1.md:244-246,807-819` | 不能把 receipt 放主库/results DB，也不能用跨库双写替代 |
| 旧删除路径在最后 batch 后物理删除月库 | `pre-fund-reconciliation-store.js:785-942` 及 store/parity tests | receipt 出现后必须收窄物理删除条件，否则 committed 证据丢失 |
| v3.2.1 rollback 明确 committed receipt 不删除、不 down migration | TechDoc §15 | receipt-only DB 必须保留；无 receipt 的 legacy 月库仍可维持旧删除语义 |
| Side DB 无集中 schema version，升级入口为每次 `openSideDb` 的幂等 ensure | `run-data-store.js:724-810,920-942` | receipt migration 必须加入 `ensurePreFundGatewayArchiveSupport`，不可另造主库 migration |

## Unknowns Register

| 未知 | 类型 | 影响 | 可逆性 | 当前证据 | 处理 | 最便宜验证方式 | 当前决定 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| mixed success 的父结果 shape、继续规则与 Task/Renderer 终态 | 已知未知 | 高 | 一般 | 真实 service/handler/policy/lifecycle/renderer 均可取证 | PROBE | 注入第 2 文件 transport 异常并执行真实 classifier；核 renderer seam | 已关闭：父 ok、等长同序、继续；Task succeeded；Renderer 部分失败提示后刷新 |
| Parser transport crash 是 fail-unit 还是 fail-job | 已知未知 | 高 | 一般 | 旧 service catch 不区分异常种类 | PROBE | 向真实 `tempStore.importFile` 注入 transport crash code | 已关闭：fail-unit-and-continue |
| receipt 应属于哪个 DB | 已知未知 | 高 | 困难 | Platform 同事务 + 业务真值仅 source-month Side DB | PROBE | 沿 open/import transaction 与 Platform contract 取证 | 已关闭：`MODULE_PRE_FUND_RECONCILIATION` source-month DB |
| receipt 与最后批次物理删除如何兼容 | 状态生命周期盲区 | 高 | 一般 | 旧路径删文件；TechDoc 明确 committed receipt 不删除 | PROBE | 查 delete/clear tests 与现有未 ACK receipt owner 先例 | 已关闭：有 receipt 时只删业务 batch，保留 receipt-only DB；无 receipt 沿旧语义 |
| receipt 字段是否偏离 TechDoc 建议表 | 数据契约未知 | 高 | 一般 | 当前 batch/dataset 字段与 TechDoc 建议字段可一一映射 | PROBE | 对照 DDL、mapBatchRow、version 更新 SQL | 已关闭：采用建议字段；不加 batch FK，避免删除业务 batch 时级联/阻断 receipt retention |
| operation identity 唯一范围 | 幂等盲区 | 高 | 一般 | TechDoc 明确 `UNIQUE(action_key, operation_key)`；fileOperationKey 按 parent+index 稳定 | PROBE | 对照 spec §5.2/TechDoc §8/Platform operationKey | 已关闭：表内 `(action_key, operation_key)` 唯一；确定性 source-month routing 是跨文件边界 |

## BLOCK 问题

无。数据模型所有权、retention 和生命周期均已由规范与当前代码事实唯一收口。

## 已执行 PROBE

1. 只读注入 probe：真实 `PreFundReconciliationService.importMptFiles` 第 2 文件抛 `PREFUND_PARSER_TRANSPORT_CRASH`，结果精确为父 `status=ok`、`results=[ok,failed,ok]`、`successCount=2`、`failedCount=1`，且第 3 文件执行。
2. 真实 policy/lifecycle probe：`pre-fund-reconciliation:import-mpt` policy classifier 与 `taskResultStatus` 均返回 `succeeded`。
3. handler/Renderer seam：handler 原样返回 service result；Renderer mixed 分支展示部分失败，finally 调用 status refresh。
4. 基线回归：service、TaskPolicy、TaskLifecycle、Renderer 四文件共 113/113 PASS。
5. Side DB ownership/delete probe：source-month import transaction、Side DB ensure、deleteBatch/date-range/clearAll 及现有未 ACK run receipt guard 已逐段核对。

## 保守假设

- `deletedFiles` 是内部清理统计，不是 receipt 合同。receipt-only DB 返回未物理删除，用户可见的 batch/row 清理计数保持准确。
- E05-P0 不增加 receipt ack/TTL。TechDoc 明确 committed receipt 不删除，因此 retention 先保持永久；未来若产品要回收，必须另立有证据的生命周期规格。

## 风险优先计划

| 顺序 | 步骤 | 消除的未知/保护的不变量 | 成功证据 | 失败影响 | 回滚/收缩 |
| --- | --- | --- | --- | --- | --- |
| 1 | 建 mixed-result action fixture 与 golden tests | 保护旧父结果/Task/Renderer 终态 | service + policy + coordinator + renderer assertions | 推翻 transport 策略，停止 receipt 之外接线 | 只保留 probe 文档，不改 coordinator |
| 2 | 在 source-month Side DB 增加幂等 receipt ensure | 保护同事务所有权与兼容升级 | 新旧库重复 open schema 相同 | 数据模型不成立，停止实现 | 回退加法 DDL（未上线，无 down migration） |
| 3 | 建最小 repository contract | 保护 enum、identity、单 receipt、字段边界 | inserted/replaced/noop + exact replay + conflict tests | E05-B 无可复用提交合同 | 收缩为 schema/read API，不接 Writer |
| 4 | 收窄物理删除条件 | 保护 committed receipt retention，保持 legacy 无 receipt 删除语义 | batch/date/clear receipt retention + 原回归 | 恢复证据可能丢失 | fail closed 保留 DB 文件 |
| 5 | blindspot 与资金盲区复核 | 检查入口旁路、部分失败、幂等、审计去向 | 无存活 BLOCK/Critical 自动缺口 | 不提交 | 补测试或停止 |
