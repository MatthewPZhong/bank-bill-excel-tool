# Implementation Notes

## Baseline

- Goal/spec：v3.2.1 Spec §5.2-§6、§8-§11；TechDoc §8-§11、§13-§15；E05-P0 receipt schema + old mixed-result probe。
- Initial plan：[preflight.md](./preflight.md)。
- Done when：receipt schema/contract 与 mixed lifecycle fixture 冻结，定向测试和自审通过，分支提交且 worktree clean。

## Decisions

| 决定 | 原因与证据 | 放弃的方案 | 影响 |
| --- | --- | --- | --- |
| Parser transport crash 映射为当前 file failed 并继续后续 file | 旧 service 对任意 per-file exception 使用同一 `errorResult`；可执行 probe 得到 `[ok,failed,ok]`；父结果和 Task 均成功 | fail-job；保留 E05-A unresolved seam | Coordinator 可冻结 fail-unit-and-continue；父结果仍由现有聚合语义决定 |
| Coordinator 接收上层按旧 `errorResult` 构造的 transport file result，不自行序列化 | 旧精确 item 是 `{status,fileName,code,message,detailLines}`；Coordinator 不拥有源路径，若自行构造会缺 `fileName` 且错误暴露内部 `fileIndex` | Coordinator 从 cause 猜 fileName；在 Coordinator 复制 service serializer | 最终 mixed item 与旧 service shape exact-equal，职责仅限有序 drain |
| receipt 属于临时 MPT 的 source-month Side DB | Platform 要求 worker-durable mutation + module receipt 同事务；业务 batch/rows 只在该 DB | 主库 receipt；results DB；跨库双写 | 未来 E05-B 可在现有 `BEGIN IMMEDIATE` 内写 mutation/noop + receipt |
| receipt 表不对 batch 建 FK | committed receipt 按 TechDoc 永久保留，而用户仍可删除临时业务 batch；FK CASCADE 会删 receipt，RESTRICT 会阻断既有清理 | CASCADE FK；RESTRICT FK | batch 删除后 receipt 仍是历史提交证据；未来 inspector 对已清业务行只能 fail closed，不自行修复 |
| 有 receipt 的空业务月库保留物理文件，无 receipt 保持旧删除语义 | 兼顾 TechDoc committed receipt 不删除与旧 temporary DB 回收合同 | 所有月库永久保留；继续无条件删除 | 仅 receipt-containing DB 的 `deletedFiles` 可能为 0，业务 batch/row 删除结果不变 |
| receipt 唯一键采用 TechDoc 的 `(action_key, operation_key)` | actionKey 是静态 action identity，fileOperationKey 是该 action 的稳定 per-file identity | 单列 operation_key UNIQUE；按 batch/hash 去重 | 同 action/fileOperationKey 表内最多一条；不把 batch/hash 当本 Task 提交证据 |

## Assumptions

| 假设 | 依据 | 失效影响 | 验证与回滚 |
| --- | --- | --- | --- |
| receipt-only DB 的永久 retention 在 E05-P0 可接受 | TechDoc §15 明确不删除 committed receipt，且当前任务禁止擅自增加 TTL/ack 清理 | 长期累积少量 receipt metadata | 后续产品若要求回收，需独立 spec；不得在本 PR 猜 TTL |
| `deletedFiles` 不代表业务数据是否已清空 | store API 同时返回 `deletedBatches/deletedRows`，UI 业务状态从 list/status 读取 | 某个未发现调用方可能把物理文件数当成功条件 | 定向搜索调用方并跑 store/service/parity 回归；若命中则显式兼容 |

## Deviations

| 原计划 | 实际方案 | 原因 | 影响 | Spec 已同步 |
| --- | --- | --- | --- | --- |
| TechDoc 建议 dedicated table，但未写现有月库清理策略 | receipt 放同一 source-month DB，且 receipt 存在时保留空业务 DB | 同事务要求与永久 receipt retention 同时成立的唯一最小方案 | 旧无 receipt 删除不变；新 receipt DB 不物理删除 | 不需要：行为由 TechDoc §8/§15 联合推出，preflight 已显式记录 |

## Evidence

| 证据 | 结果 | 覆盖的行为/风险 |
| --- | --- | --- |
| exact base probe | HEAD/merge-base `5da07fc3...`，parent `8e0e4657...` | 防基线漂移 |
| mixed transport exception probe | `[ok,failed,ok]`；parent ok；2 success/1 failed；Task succeeded | mixed result、继续规则、transport policy |
| `node --test` service/policy/lifecycle/renderer | 113/113 PASS | 旧 handler/Task/Renderer 基线 |
| E05-P0 聚焦 unit | 71/71 PASS | receipt DDL/repository、三 outcome、exact replay/conflict、mixed lifecycle、Coordinator transport、三类删除与旧无表兼容 |
| 扩展 PreFund/TaskLifecycle/Renderer/Parser unit | 223/223 PASS | 既有 PreFund store/run/service、archive policy/lifecycle、Parser/spool、Renderer wiring 回归 |
| `pre-fund-reconciliation-side-db-parity.js` | 69/69 PASS | Side DB 导入/替换/noop/删除、跨月、主库隔离与业务基线 |
| 受影响 ESLint + `node --check` + `git diff --check` | PASS | 生产 JS 静态质量、语法与 diff 结构 |

### Mixed-result 证据边界

- service 的 `[ok, failed, ok]`、等长同序、继续执行、父 `status=ok` 与计数，是通过真实 `PreFundReconciliationService.importMptFiles` 行为执行得到。
- policy classifier 与 `taskResultStatus` 是真实行为执行，终态为 `succeeded`。
- live handler 未改动；测试对 handler 做源码 seam，冻结其把 service 结果原样返回。
- Renderer 未做动态 DOM 执行；测试是源码 seam，冻结 mixed 分支的部分失败提示与 `finally` session refresh。既有 Renderer wiring unit 同时通过，但不把它表述为 E05-P0 的完整 UI 行为执行。

## Blindspot Self-review

| 盲区 | 结论 | 证据/处置 |
| --- | --- | --- |
| 入口旁路 | receipt DDL 只加入 PreFund MPT source-month Side DB 的既有幂等 ensure；未接 live handler/Writer | schema 重复 open test；生产 diff 无 IPC/registry/worker 接线 |
| 状态与部分失败 | transport crash 只占当前 unit，后续 ready unit 仍按序消费；failed item 保持旧 service 的 `fileName` shape，不泄漏内部 `fileIndex`；父终态继续沿旧 service/policy | 真实 service golden + Coordinator 对 fixture failed item exact-equal + policy/lifecycle execution |
| 生命周期/清理 | batch/date/clear 只有 receipt=0 才物理删除；receipt>0 清业务 batch 并保留 receipt-only DB | 三条删除路径测试；clearAll 明确验证事务级联 rows/excluded 且 `deletedFiles=0`；旧无表 clearAll 为 `deletedFiles=1` |
| 兼容升级 | 新/旧月库重复打开幂等；未建 receipt 表的旧月库查询按 0 receipt | DDL idempotency + drop-table legacy deletion tests |
| 幂等冲突 | 同 action/fileOperationKey exact replay 返回已有 receipt；payload 不同显式冲突且仍只有一行 | repository transaction/replay/conflict test |
| 可观测性 | receipt 保留 action、operation、TaskRun、file index、batch/dataset version、source/hash、commit time | schema/mapper 精确字段断言；未增加日志或 UI，留给 E05-B inspector |

未发现需要扩大 E05-P0 范围的 Block/Critical 自动缺口。

## Reconciliation Blindspot Self-review

- 主键血缘：receipt 唯一键严格为 TechDoc 冻结的 `(action_key, operation_key)`；batch 无 FK 是为保证业务 batch 删除后 committed receipt 仍可审计，不把 batch 当前存在误作本次 Task 的提交证据。
- 金额/币种/匹配：未修改金额、币种、tradeType、候选条件、候选消费或 source sequence；既有 PreFund parity 69/69 通过。
- 幂等/部分失败：三 outcome 唯一显式；noop 也形成当前 file operation 的独立 receipt；transport/business 单文件失败不回滚前序文件或终止后序文件。
- 行数与审计去向：receipt retention 分支只删除 batch，依赖既有 CASCADE 同事务清 rows/excluded；测试验证 batch/rows/excluded 全部为 0、receipt 仍为 1。
- 🔴 资金红线人工复核：合并前请人工复核 source-month DB 所有权、`(action_key, operation_key)` 唯一范围、无 batch FK 与 receipt-only 永久保留。E05-P0 未改资金算法，但这些合同直接决定未来 E05-B 的重复提交与恢复判定。

## Remaining Unknowns

| 未知 | 处理 | 负责人/下一步 | 合并影响 |
| --- | --- | --- | --- |
| E05-B Writer 如何把业务 mutation/noop 与 receipt 接入同一事务 | PROBE | E05-B；复用本 PR repository，不在 E05-P0 实现 | 不阻断 E05-P0；阻断 production enable |
| Critical Intent/handshake/inspector 与 receipt-only DB 的启动枚举 | PROBE | E05-B 按 Platform contract 实现 | 不阻断 E05-P0；阻断 crash recovery/production enable |
| receipt 历史回收策略 | ASSUME | 当前永久保留；如需清理另立规范 | 不阻断；禁止本 PR 自行增加 TTL |
| 资金红线人工复核 | REVIEW | 项目负责人/Reviewer 核对 DB 所有权、唯一键、无 FK、retention | E05-P0 自动验证已通过；production enable 前必须完成人工复核 |
