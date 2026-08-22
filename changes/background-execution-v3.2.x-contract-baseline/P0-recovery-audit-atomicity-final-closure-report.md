# P0 最终关闭：恢复状态与审计事件原子性

> 本报告保留上一轮“状态迁移与对应 event 同事务”的关闭证据。上一轮顶层 `transitionWithRecoveryEvent()` API 已由 `P0-recovery-control-transaction-observation-final-closure-report.md` 回修为显式 `runInControlTransaction()` + transaction-scoped writer；以新报告和当前权威合同为准。

## 1. 结论

上一版残留的“同一主控事务或具备可证明的恢复顺序”已经删除。当前最高合同、E00 实施文档和 Codex 两份入口文档只有一个口径：

> TaskRun 的恢复相关状态迁移，以及 Batch overlay、Recovery Hold、Critical Intent 的每次状态迁移，与对应 append-only recovery event 必须在同一个 Main-owned control DB transaction 内提交。

不存在可替代该事务的消息顺序、重试、异步补写或“经过测试/可证明的恢复顺序”。

## 2. Repository API 收敛

E00 TechDoc 不公开彼此独立提交的状态 mutation 与 event append。当前唯一顶层写入口为：

```typescript
RecoveryControlRepository.runInControlTransaction((tx) => {
  tx.transitionWithRecoveryEvent({ transition, event });
  tx.appendObservationEvent(observation);
});
```

其强制时序为：

```text
validate CAS
→ state transition
→ append-only event INSERT
→ one COMMIT
```

`transitionWithRecoveryEvent()` 仍保持“一次状态迁移 + 一个对应 event”，但只能在 `RecoveryControlTransactionV1` 上调用；`appendObservationEvent()` 只记录无状态迁移的检查/结算活动。外层一次 COMMIT，任一步失败整体 ROLLBACK。`appendRecoveryEvent` 只能作为该事务内部的 package-private primitive。读取/扫描接口单独归入只读 `RecoveryControlReadRepository`。

## 3. Validator 门禁

`codex-input-contract-drift` 现在同时扫描：

```text
platform-contract-v1.md
E00-platform-contract-v1-techdoc.md
CODEX-SPEC.md
CODEX-TECHDOC.md
```

它与新增 `recovery-control-transaction-contract-drift` 会拒绝：

- 任一文档缺少 canonical same-transaction MUST；
- “或具备可证明的恢复顺序”等替代语句；
- E00 顶层继续公开 writer 或底层 `appendRecoveryEvent()`；
- 缺失显式外层事务、多对象分别提交；
- observation event 修改状态或用虚构 transition 代替；
- TaskRun/Critical Intent 状态边界漂移。

Validation README 已同步列出全部 24 项真实检查。

## 4. 状态

```text
Architecture                         Approved
Codex documentation/contract         Implementation Ready
Action Production Enablement         Gated per action
```

本回修仅修改文档、validator、报告和发布包，没有修改业务源码、业务数据库或 Release 资产。资金 mutation 仍需各 action 的 receipt、Inspector、fault injection、Windows 与人工资金门禁。
