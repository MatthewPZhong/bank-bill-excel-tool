# P0 最终回修：Codex 入口协议、恢复审计原子性与验证漂移门禁

> 本报告中的恢复写 API 已按后续 `P0-recovery-control-transaction-observation-final-closure-report.md` 机械回修；新报告关闭纯观察事件与多对象外层事务缺口。

## 1. 结论

本轮只修复 Codex 实施入口与已冻结平台合同之间的最后一组漂移，不改变 v3.2.0～v3.2.5 的版本拆分、模块拓扑或资金边界。

关闭事项：

1. `CODEX-TECHDOC.md` 不再维护第二套手写 Protocol 类型；改为引用权威 JSON Schema，并保留一份由 Schema 派生、可机器比较的导航摘要；
2. Job Envelope 的 `context`、`unit:progress`、Service `jobRef.unitId` 与两类 seq scope 已和 `platform-protocol-v1.schema.json` 完全一致；
3. TaskRun 恢复相关迁移及 Batch overlay、Recovery Hold、Critical Intent 迁移与对应 recovery event 固定在同一个 Main-owned control DB transaction 内；E00 顶层写入口收敛为 `RecoveryControlRepository.runInControlTransaction()`，两个 writer 只存在于 `RecoveryControlTransactionV1`；
4. Renderer 只使用生命周期合同中的规范状态；恢复和补偿信息进入 metadata，不再产生 `recovered` 或补偿专用状态；
5. mutation action 的 Critical Intent 适用范围改为按 commit policy 判断；publisher journal 与 existing protocol 不创建平台 Intent；
6. Validator 新增 `codex-input-contract-drift`，逐字段核对 Codex Protocol 摘要、seq scope、Renderer 状态、审计原子性和 Critical Intent 映射；
7. 校验报告对全部实际规范、版本文档、fixtures、validator 和 runner 输入记录 SHA-256；
8. 发布包移除 `__pycache__` 与 `.pyc`。

当前状态：

```text
Architecture Approved
Codex Implementation Ready at documentation/contract level
Action Production Enablement remains gated
```

## 2. Protocol v1 唯一入口

权威合同：

```text
changes/background-execution/platform-protocol-v1.schema.json
```

`CODEX-TECHDOC.md` 的 `CODEX_PROTOCOL_SUMMARY_V1` 仅用于导航，由 Validator 与 Schema 机械比较。摘要明确：

- Job Envelope 必填 `context`；
- Job operation 包含 `unit:progress`；
- 非空 Service `jobRef` 必填 `actionKey/operationKey/jobId/unitId`；
- Job seq scope 为 `(jobId, workerInstanceId, direction)`；
- Service seq scope 为 `(serviceKey, serviceGeneration, workerInstanceId, direction)`；
- `controlId` 仅关联一次 control exchange，不属于 seq scope。
- Service reply seq 使用发送方自身 direction 的 `last + 1`，不 echo 对向 seq；exchange 继续由 controlId/requestId/grantId/reservationId 关联。
- PreparedIntentInput 的 persisted `coordinationKind` 与 SQLite CHECK/policy 派生统一为 `worker-critical | main-owned-settlement`；`worker-handshake` 只描述协议动作，不是持久枚举。

## 3. 恢复审计原子性

最终冻结规则：

```text
Task / Batch overlay / Recovery Hold / Critical Intent state transition
+
对应 append-only recovery event
=
同一个 Main-owned control DB transaction
```

Repository 唯一顶层写入口是 `RecoveryControlRepository.runInControlTransaction()`。状态 CAS、状态写入和对应 event insert 由 `tx.transitionWithRecoveryEvent()` 完成；无状态迁移 observation 由 `tx.appendObservationEvent()` 完成；最外层统一 COMMIT。

禁止：

- 顶层公开 scoped writer 或底层 `appendRecoveryEvent()`；
- 先提交状态，再异步补 recovery event；
- 依赖消息先后或重试补齐审计；
- 用“经过测试的确定性顺序”替代数据库原子事务。
- 为 observation 伪造状态迁移，或让多个控制对象分别提交。

## 4. Renderer 与 Critical Intent

Renderer 规范状态只来自 `platform-lifecycle-mapping.md`：

```text
running
waiting-user
cancelling
succeeded
succeeded-with-errors
failed
cancelled
recovering
recovery-required
```

恢复成功仍是 `succeeded`，通过 `metadata.recovered=true` 标识；已验证补偿仍是 `failed`，通过 `metadata.compensated=true` 标识。

Critical Intent 映射：

| commit policy | 平台 Critical Intent |
| --- | --- |
| `worker-durable` | 使用 |
| `main-settlement + target-post-image` | Main-owned，使用 |
| `main-settlement + publisher-journal` | 不使用 |
| `existing-critical-protocol` | 不使用；证据不足保持 blocked |
| `none` | 不使用 |

## 5. 最终验证

最新 Validator 结果：

```text
24 / 24 PASS
52 action policies
23 valid protocol messages
5 complete Job/Service lifecycle sequences
5 valid RecoverySource kinds
59 version action-table rows
292 action-table ↔ Registry static-field comparisons
81 local contract references
60 hashed validation inputs
```

`codex-input-contract-drift` 与新增 `recovery-control-transaction-contract-drift` 会拒绝：

- Codex 文档漏掉 Schema 必填字段或 operation；
- seq scope 错误加入 `controlId`；
- Codex Renderer 状态与生命周期合同不一致；
- Codex 文档允许状态/event 非原子提交；
- 平台总门禁重新泛化为“所有 mutation 都需要 Critical Intent”。
- 缺失显式外层事务、顶层暴露 scoped writer 或多对象分别提交；
- observation event 扩宽/修改状态、TaskRun recovery union 越权、`committed → recovered`。

本轮只修改文档、Schema 对齐说明、validator 和发布包；没有修改业务源码、业务数据库或 Release 资产。
