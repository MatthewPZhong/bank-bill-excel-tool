> **历史说明：** 本文件记录前一轮评审关闭过程，不是规范来源。字段、枚举和恢复语义以 `changes/background-execution/platform-contract-v1.md`、`platform-recovery-source-v1.schema.json` 和最新 `P0-recovery-source-contract-final-alignment-report.md` 为准。

# Background Execution v3.2.x — 最终恢复来源合同关闭报告

| 项目 | 结论 |
| --- | --- |
| 基线 | v3.2.0～v3.2.5 + Platform Contract v1 |
| 回修范围 | 1 个剩余平台 P0 + 2 个 P1 + validator 可复跑性 |
| 文档/合同状态 | **Implementation Ready** |
| 生产启用状态 | Action Production Enablement remains gated |
| 源码变更 | 无；仅文档、Schema、fixtures、validator |

## 1. `main-settlement` 恢复来源闭环

冻结为两种互斥策略：

```text
publisher-journal:
  criticalIntent = false
  Startup 由 SettlementRecoveryProvider 枚举 open journal

target-post-image:
  criticalIntent = true
  Main-owned Critical Intent 保存 expected pre/post
  不发送 Worker critical handshake
```

Inspector 统一接收 `RecoverySourceV1`。Startup Coordinator 依次处理：

```text
open intents
+ open publisher journals / existing settlement sources
+ active holds
```

这关闭了两个崩溃盲区：

- Publisher journal prepared 后、Hold 创建前崩溃；
- Statement seed rename/fsync 后、回读或 Task settle 前崩溃。

## 2. TaskRun 与 Batch 完整状态合同

正常 TaskRun 邻接表冻结为：

```text
prepared → running | failed | cancelled | interrupted
running  → succeeded | failed | cancelled | interrupted
interrupted → running(recovery) → succeeded | failed | interrupted
```

Batch 继续采用 Option B：基础 interrupted 兼容写 `failed`，effective status 由 overlay 映射：

```text
interrupted → interrupted
recovering → recovering
state=resolved, finalOutcome=succeeded → succeeded
state=resolved, finalOutcome=failed → failed
```

所有恢复状态变化必须写 append-only recovery event。

## 3. 平台持久边界

Platform Contract v1 固定使用当前 Main-owned 主控制数据库存放：

- Critical Intents；
- Recovery Holds；
- Batch recovery overlay；
- Recovery events。

模块本地 receipt 仍与业务 mutation 同事务；Publisher journal 仍使用既有 durable 边界。v1 不允许在实现中临时改为独立平台 DB。

## 4. Statement seed

`statement:resolve-manual-balance` 固定：

```text
commit.kind = main-settlement
receiptKind = target-post-image
criticalIntent = true
operationKey = taskRunId/actionKey/interactionOrdinal
```

权威证据是目标 seed 文件 durable post-image。Intent 只保存 expected pre/post 和 operation identity。

## 5. 机器校验增强

validator 现在真实验证：

- Policy/Protocol Draft 2020-12 Schema；
- request/grant/adopt/release 跨消息 identity 与状态连续性；
- `publisher-journal=false intent`、`target-post-image=true intent`；
- Statement/Policy/Startup/Lifecycle 跨文档一致性；
- Main-owned 持久边界；
- 正反 fixtures、action coverage、静态 key 与文档链接。

最终复跑结果：

```text
15 / 15 checks PASS
52 action policies
23 valid protocol messages
1 valid resource lifecycle sequence
59 canonical action-table rows
67 local contract references
```

运行器优先支持 `$PYTHON_BIN`，兼容旧的 `$PYTHON`，否则自动选择 `python3`/`python`；运行前验证依赖精确固定为 `jsonschema==4.26.0`。

最终独立重跑结果：

```text
status: PASS
15 / 15 checks passed
52 action policies
9 individually valid protocol messages
5 complete Job/Service lifecycle sequences
59 action-table rows
292 action-table ↔ Registry static-field comparisons
67 local contract references
20 negative policy/protocol/sequence fixtures rejected
```

本轮重跑还实际发现并修复了两个校验器自身问题：缺失的 `VALID_PROTOCOL_SEQUENCE_PATH` 常量，以及依赖整篇文档词面命中的 startup 检查。当前 validator 会在 Startup Recovery 章节范围内分别验证 open intents、open publisher journals、active holds、provider enumeration 与 `RecoverySourceV1` 去重。

## 6. 最终签字边界

```text
Architecture Approved
Implementation Ready at documentation/contract level
Action Production Enablement remains gated
```

这允许开始 E02-A/B/C1/C2 编码。BankBU、Statement seed、JPM、VCC saveRun、PreFund Writer 等 mutation 仍必须分别完成 schema/receipt、故障注入、Windows 和人工资金复核后才可启用生产。
