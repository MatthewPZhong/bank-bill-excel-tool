# P0 最终关闭：恢复控制事务与纯观察事件

## 1. 结论

前一版把所有 recovery event 都绑定为“一个状态迁移 + 一个事件”，导致 `inspection-completed`、Inspector/Provider 瞬时失败和 `settlement-resumed` 无法合法落审计；同时文档要求多控制对象加入一个外层事务，却没有给 Main 可调用的事务入口。

本轮将合同收敛为一个显式事务边界和两个事务作用域操作：

```typescript
RecoveryControlRepository.runInControlTransaction((tx) => {
  tx.appendObservationEvent(...);       // event only
  tx.transitionWithRecoveryEvent(...);  // one state transition + one event
});
```

`RecoveryControlRepository` 顶层不再暴露任何可独立提交的 writer。最外层统一 BEGIN/COMMIT，任一 CAS、状态写入、event insert、回调或 COMMIT 失败时整体 ROLLBACK。

## 2. Observation-only event

v1 精确允许：

```text
inspection-completed
inspection-failed-transient
settlement-resumed
settlement-failed-transient
```

这些事件：

- 只能通过 `RecoveryControlTransactionV1.appendObservationEvent()` 写入；
- 不得修改 TaskRun、Batch overlay、Recovery Hold 或 Critical Intent；
- `previous_state / next_state` 必须均为 `NULL`；
- 不得使用 `state → same state` 或虚构 transition 替代；
- 与同一 inspection 决定产生的即时控制迁移共用一个 transaction object。

底层 `appendRecoveryEvent()` 仍为 package-private SQL primitive，不是平台调用 API。

## 3. 多对象原子收口

一次恢复决定同时更新 TaskRun、Batch overlay、Intent 或 Hold 时，Main 只调用一次 `runInControlTransaction()`，并显式向下传递同一个 `RecoveryControlTransactionV1`。作用域内方法不得独立 BEGIN、COMMIT 或 ROLLBACK，也不得依赖 ambient transaction 猜测调用关系。

Inspector、Provider 和文件 I/O 在事务外执行，避免跨 `await` 持有 SQLite 写锁：

```text
inspect outside transaction
→ short transaction: inspection observation + immediate transitions
→ provider outside transaction（如需）
→ short transaction: provider outcome transitions/events
```

Provider `recover()` 必须按 `(sourceKind, sourceRef, operationKey)` 幂等，inspection evidence hash 只参与 CAS/审计，以覆盖“外部 settlement 已完成、控制状态尚未提交即 crash”的窗口。

## 4. 状态边界关闭

- `TaskRunTransitionV1` 只包含中断/恢复相关 command；常规 `prepared → running` 与非恢复执行终态仍由既有 TaskLifecycle/ArchiveRepository 管理。
- Batch `mark-interrupted` 同事务写基础兼容 failed、overlay interrupted 与 event；恢复 success 只 resolve overlay，不覆盖基础 interruption 历史。
- Critical Intent 固定为：

```text
prepared → acked → committed → closed
prepared → recovered → closed
acked → recovered → closed
```

`mark-recovered` 不再接受 `committed`。已 committed source 的 settlement 恢复结果进入 TaskRun、Batch overlay、Hold 和 recovery event，Intent 保持 `committed → closed`。

## 5. Validator 关闭证据

新增独立门禁 `recovery-control-transaction-contract-drift`，不再只检查几个关键词。它会：

- 结构化解析 Repository 与 Transaction interface；
- 验证顶层只有 `runInControlTransaction()`，两个 writer 只在 transaction object；
- 精确比对 observation event union 和 TaskRun recovery command union；
- 精确比对 TaskRun/Batch/Intent/Hold command union 与 `RECOVERY_TRANSITION_EVENT_MAP_V1`；
- 验证 observation 输入不允许调用方传 previous/next state，DDL 强制 observation state 为 `NULL`；
- 验证 recovery event 持久化 `actionKey / operationKey / taskRunId` 以及成对的 source identity，审计血缘不能只埋在 JSON；
- 检查 `mark-recovered` 只接受 `prepared | acked`；
- 交叉核对 Platform Contract、E00 TechDoc、CODEX-SPEC、CODEX-TECHDOC 与 Lifecycle Mapping；
- 运行 20 个 recovery-control mutation negative self-tests，证明上述漂移会 fail closed；另有 Protocol/Recovery Result mutation fixtures。

最终机器结果与哈希以根目录 `validation-report.json` 和 `PACKAGE-SHA256SUMS.txt` 为准。

## 6. 治理状态

本文件是 closure evidence，不是规范性合同。优先级仍为 Platform Contract / E00 Spec-TechDoc / Schema / Lifecycle Mapping / CODEX 输入；如报告与权威文件冲突，以权威文件为准并让 validator fail closed。

```text
Architecture                              Approved
Recovery audit atomicity                  Closed
Observation-only audit path               Closed
Multi-object transaction composition      Closed
TaskRun / Critical Intent state scope      Closed
Action Production Enablement               Gated per action
```

本轮未修改 `src/`、业务数据库或 Release 资产。

## 7. Blindspot 与资金审计复核

通用盲区复核已覆盖：

- 入口旁路：顶层 writer、独立 append、正常 TaskLifecycle 越权均由结构校验拒绝；
- 边界条件：manual hold 不进入自动 observation，Batch/Intent/Hold 邻接与幂等重放已冻结；
- 失败模式：任一控制写失败整体回滚，async/nested transaction 被禁止，Inspector/Provider transient failure 分开记账；
- 生命周期：TaskRun 常规所有权、Critical Intent committed 事实、Batch 基础兼容历史均不被恢复流程重解释；
- 可观测性：event 固化 action/operation/task/source 血缘，command→eventType 唯一；
- 测试缺口：新增结构门禁和 20 个 recovery-control mutation negative self-tests。

资金业务盲区复核结论：本轮不改变金额、币种、方向、匹配、行数或输出口径；恢复控制新增的是防重复、血缘与审计约束。各资金 mutation action 的 operationKey/receipt/inspector/fault injection/Windows 与人工样本复核仍是红线，不能因本报告关闭而自动启用生产。
