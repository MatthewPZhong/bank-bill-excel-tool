# G2-T1 基线与调用方清点

固定代码状态：`11086a3cbf632a30adbcfa796e4cd81810c5aef9`。本文只描述当前代码，不把 G2 设计接口写成现状；实施进度见 [implementation-notes.md](implementation-notes.md)。下列行号来自本 worktree 未修改的生产源码。

## 入口、身份和所有权

| 范围 | 当前事实 | 代码位置 |
| --- | --- | --- |
| Policy inventory | 268 条；69 eager file、2 deferred file、63 no-file、134 exclude；T2 必须显式绑定全部 134 个受控 task | `src/main-process/archive-center/task-policy-registry.js:825,939`；[数据快照](evidence/task-policy-inventory.json) |
| 四种执行形态 | no-file→runOperationOnly；file→runFileTask/runDeferredFileTask；legacyExistingBatchRecovery→旧 run 并保留 sourceSnapshots | `src/main.js:21904,21964,22020` |
| Position 现行 producer | 10 eager + 5 no-file；没有 Position deferred producer；deferred 现行两项为 monthly-balance:assemble 和 new-account:generate | `archive-center/task-file-plan-registry.js:135,156`、`task-policy-registry.js:99`，相对 `src/main-process/` |
| legacy producer | 实际仅 Acquiring resume 设置 legacyExistingBatchRecovery；Position legacy 测试是保留能力，不是现行 taskKey | `src/main.js:17740,17813` |
| 身份优先级 | prepared.taskRunId/operationKey 优先于生成 token；Position terminal route 始终保存生成 token | `src/main.js:21915,21990,22017` |
| Position 写者 | Main 的 AsyncLocalStorage/active operation；admission 固定 operation/file owner，pending 修改/清除校验 token；live finalizer 要求 token===context.taskRunId，文件 owner 还匹配 batchId | `src/main.js:1281,18972,19747,19333` |
| hook 优先级 | Position finalizer→prepared hook；prepared.flowPlan 优先；第三 gate→prepared.beforeStart；无文件不采用 publication-only hook | `src/main.js:21930,22006,22020`；`src/main-process/read-only-exports/position/settlement.js:3` |
| receipt 范围 | Main 精确五项：Toolbox merge/split export 与 VCC data-manager export/import-audit/result；空 toolbox ids 数组仍优先 | `src/main.js:22006,20634`；`src/main-process/toolbox-archive-recovery.js:11,94,308` |

公共 wrappers 为 Main 的 `businessIpcHandle`、`trackedIpcHandle` 和 `dynamicTrackedIpcHandle`，当前全部仍进入 runArchiveAwareOperation；`supportIpcHandle` 使用独立 BOR wrapper，不属于 adapter 绑定范围。

## 四个历史 route

| route | live 生产者 / 终结者 | replay 终结者与兼容合同 |
| --- | --- | --- |
| position-reconciliation | Main 公共入口生成；finalizePositionPendingAfterTaskTerminal；`src/main.js:21930,19333` | `src/main.js:19456` 校验 route/record/pending token、owner 与 targetBatchId；历史无 owner 仅匹配 file-batch；`19361` 收口 checkpoint/pending/受管暂存 |
| pending-run | pending:reconcile:run 的 prepared hook；成功后 acknowledgePendingRunByTaskRun；`src/main.js:13982` | Main 注入 pendingDb；`src/main-process/pending-archive-lineage.js:152`，实际 terminalResult 状态优先，非 succeeded 不 ACK；成功要求 operation owner/taskRunId 匹配 |
| biz-op-run | legacy bizOpRecon:run；成功后 acknowledgeRunByTaskRun；`src/main.js:14936` | `src/main.js:19508` 保留 legacyMode、activation retired guard 和 withLegacyRecovery；`src/main-process/biz-op-recon-run-data.js:869` 校验成功终态和 operation owner/taskRunId |
| pre-fund-run | pre-fund-reconciliation:run；成功后 service.acknowledgeRunByTaskRun；`src/main.js:18482` | Main 注入 service；`src/main-process/pre-fund-archive-lineage.js:187`，成功终态和 operation owner/taskRunId 校验 |

公共 normalizer 在 `src/main-process/archive-center/controller.js:105`：trim、必填校验、裁剪字段，未知 route 抛 TypeError。Controller 的旧 append replay（673）及 owner terminal replay（820）先持久终态，再 finalizer；失败保留 outbox。Main 分派仍在 19501。T4 必须以同一领域函数收口 live/replay，同时保留这些检查，不能只移动分派表。

## 错误、资源与清理

| 路径 | 基线合同 / 待修复缺口 |
| --- | --- |
| prepare 后前置步骤 | Main:21884 第二 gate 和初始化在 wrapper 外，错误漏 abandon；21887 lifecycle unavailable 已有手工 abandon，不能称为完全无清理 |
| 旧 helper | interactive-task-preflight.js:257 的 Promise.resolve(run()) 漏掉同步抛错；已有 finally 的 cleanup error 覆盖原结果/异常 |
| executeStarted | interactive-task-preflight.js:267 在 Position admission callback 真正执行时标记，busy/reject 不接管 |
| current Position | Main:22047 intent→业务结果/错误→outcome→manifest settle→durable+cleanup 或 incomplete→原错误；settle 抛错先于原业务错误传播 |
| legacy Position | Main:22086 业务结果/错误→mark→settleArtifacts({result,error})→settlePositionArchiveResult→恢复原业务错误；operation-lifecycle.js:730 对 archive/cleanup 失败标 incomplete 并返回原 result |
| 外层错误 | operation-lifecycle.js:789 的 pending/checkpoint 校验可返回 failureResult；Main:19802 最外 catch 也归一失败结果，T3 不得把最终合同改为 raw throw |
| 清理权限 | Main:21745,21773 使用 managed staging root、pending/outbox、active import 保护；cleanupPaths 仅是候选，不是删除授权 |

上表 helper 路径均为 `src/main-process/position-reconciliation/`。本次新增测试隔离了外围服务，未证明 owner/checkpoint 全链路、真实文件 ownership 或重启行为。

## 后续测试接续

既有七组 173 测试通过的原始证据见 [baseline-tests.json](evidence/baseline-tests.json)。本次清点本身仅执行源码与 registry 读取。

G2-T2/T3/T5 迁移时更新依赖布局的旧测试：`position-reconciliation-operation-lifecycle.test.js:1049,1127` 以及 `archive-task-policy-registry.test.js:249,618`（均位于 `tests/unit/main-process/`）。新 VM 夹具仅在准备阶段提供真实公共函数接线证据，最终应随着公开接口测试迁移，不能依靠旧 Main 函数物理布局宣称 adapter 架构完成。
