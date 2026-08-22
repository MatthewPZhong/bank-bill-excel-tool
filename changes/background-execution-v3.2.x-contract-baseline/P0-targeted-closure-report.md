> **历史说明：** 本文件记录前一轮评审关闭过程，不是规范来源。字段、枚举和恢复语义以 `changes/background-execution/platform-contract-v1.md`、`platform-recovery-source-v1.schema.json` 和最新 `P0-recovery-source-contract-final-alignment-report.md` 为准。

# Background Execution v3.2.x — P0 定点回修与 Implementation-Ready 关闭报告

| 项目 | 结论 |
| --- | --- |
| 文档基线 | v3.2.0～v3.2.5 + E00 Platform Contract v1 |
| 回修性质 | 定点回修；不推翻模块拓扑，不退回旧稿 |
| 文档/合同状态 | **Implementation Ready** |
| 生产启用状态 | 资金 mutation、正式发布和自动恢复仍按 action 独立门禁 |
| 机器验证 | `validation-report.json = PASS` |

## 1. 最终评审结论

本轮接受同事 Review 的全部 6 个 P0 和 4 个 P1。模块层的单写者、有序归约、Service 状态所有权和 Publisher 边界保持不变；回修集中在公共协议、生命周期、机器 Schema、恢复 Hold 和两个 action 的恢复身份。

完成后，文档从：

```text
Architecture Approved with Conditions
```

升级为：

```text
Implementation Ready at documentation/contract level
Action Production Enablement remains gated
```

“Implementation Ready”表示可以按 PR 开始实现公共平台和各 action 的受控切片；它不表示所有 mutation action 已通过 receipt migration、fault injection、Windows 和人工资金门禁。

本轮产物仅包含文档、Schema、fixtures 与可复跑 validator；未修改业务源码、数据库或 Release 资产。

## 2. P0-1：Service Control Protocol 与全局资源请求

### 问题

原 Job Envelope 强制 `actionKey / operationKey / jobId`，无法表达：

- 尚无业务 Task 的 Service init/ready/close；
- Worker 计算 state/token footprint 后向 Main-owned Governor 申请 reservation；
- grant identity、adoption 与 release ACK。

### 冻结结果

Platform Contract v1 现在区分：

```text
Job Envelope v1
Service Control Envelope v1
```

Service Control identity：

```text
serviceKey
controlId
workerInstanceId
serviceGeneration
seq
optional jobRef
```

规范 resource operations：

```text
resource:request
resource:grant
resource:reject
resource:adopted
resource:adopt-ack
resource:revoke
resource:release
resource:release-ack
```

关键规则：

- 全局 Governor 只存在于 Main；
- Worker 禁止直接调用 Main 的 JS Governor 实例；
- candidate state/token 只有在取得 `grantId + reservationId`、完成 adopt handshake 后才可公开；
- executor init/ready/close 的 `jobRef=null`；
- resource 操作通过严格 `jobRef` 关联业务 Task；
- Service control 与 Job 各自维护单调 `seq` 域。

### 关闭证据

- `changes/background-execution/platform-contract-v1.md`
- `changes/background-execution/platform-protocol-v1.schema.json`
- `changes/background-execution/E00-platform-contract-v1-techdoc.md`
- Statement TechDoc 的 token grant/adopt 顺序
- Protocol 正反 fixtures

**状态：P0 合同已关闭。**

## 3. P0-2：TaskLifecycle / Batch 与当前持久状态兼容

### 问题

当前仓库真实状态包含 `prepared`；恢复路径必须先：

```text
interrupted → running(recovery) → succeeded/failed/interrupted
```

Batch 基础 `task_status` 又不支持 `interrupted`，并将 Task interrupted 兼容映射成 `failed`。

### 冻结结果

TaskRun 规范状态：

```text
prepared
running
succeeded
failed
cancelled
interrupted
```

明确禁止：

```text
interrupted → succeeded
interrupted → failed
interrupted → cancelled
```

恢复只能通过 repository 的 recovery transition：

```text
interrupted
→ running(recovery)
→ succeeded / failed / interrupted
```

Batch 正式选择 **Option B**：

- 旧基础列继续保留兼容 `failed`；
- 新增 recovery overlay；
- 新平台查询使用 effective Batch status；
- 旧查询不被破坏；
- interruption 和 recovery 历史由 append-only events 保留。

Recovery event 由 SHOULD 提升为 MUST，并给出平台表、Repository API 和同事务写入要求。

### 关闭证据

- `changes/background-execution/platform-lifecycle-mapping.md`
- E00 TechDoc 的 Batch overlay DDL
- E00 TechDoc 的 `background_execution_recovery_events` DDL
- `TASK_STATUSES` 已包含 `prepared`

**状态：P0 合同已关闭。**

## 4. P0-3：Policy/Protocol Schema 与真实安全门禁

### 问题

旧 Schema 只要求字段存在，仍可接受：

```json
{
  "criticalIntent": false,
  "receiptKind": null,
  "inspectorKey": null
}
```

也允许非 `none` artifact 缺 Publisher；版本表含非 canonical 组合值；旧报告只做浅层词汇扫描。

### 冻结结果

Policy Schema 现在值级强制：

#### `worker-durable`

```text
criticalIntent = true
receiptKind = module-local
inspectorKey != null
conflictScopeResolverKey != null
settlementKey = null
```

#### `main-settlement`

```text
publisher-journal  → criticalIntent = false
target-post-image  → criticalIntent = true
receiptKind = publisher-journal 或 target-post-image
inspectorKey != null
conflictScopeResolverKey != null
settlementKey != null
```

- 有正式 artifact 的 action 必须使用 `publisher-journal`；
- Statement manual balance seed 这类 Main 控制的单文件原子替换使用 `target-post-image`；
- Critical Intent 不能替代两者的权威提交证据。

产生正式 artifact 时进一步强制：

```text
receiptKind = publisher-journal
filePlanRequired = true
technicalValidatorKey != null
businessValidatorKey != null
publisherKey != null
maxArtifacts >= 1
```

#### Service

必须登记：

```text
serviceKey
controlProtocol = service-control-v1
resourceControl
stateAdoption
atomicReplaceRequired = true
grantIdentityRequired = true
adoptAckRequired = true
```

#### Adapter

- `native`：`entryKey` 非空、`adapterKey=null`；
- `existing-dispatch`：`adapterKey` 非空、`entryKey=null`。

版本 action 表拆为 canonical columns；说明文字不能进入 mode/lifetime/adapter/commit/production enum 单元格。

### 可复跑验证

```bash
changes/background-execution/validation/run-validation.sh
```

当前结果：

```text
PASS
15 / 15 checks passed
52 action policies
9 individually valid protocol messages
5 complete Job/Service lifecycle sequences
59 action-table rows
全部负例被拒绝
```

验证不只扫描词汇，而是执行：

- Draft 2020-12 Policy Schema；
- Protocol Schema；
- semantic static-key validator；
- property key == actionKey；
- 正反 fixtures；
- action 表 canonical enum；
- 本地合同路径；
- 必需文件完整性。

### 关闭证据

- `platform-contract-v1.schema.json`
- `platform-protocol-v1.schema.json`
- `changes/background-execution/validation/validate_background_execution_baseline.py`
- `changes/background-execution/validation/fixtures/`
- 根目录 `validation-report.json`

**状态：P0 已关闭。**

## 5. P0-4：Publisher unknown 可独立创建 Recovery Hold

### 问题

普通 `main-settlement` Publisher 不一定存在 Critical Intent；旧 Hold 结构却要求非空 `intent_id` 外键，导致 Publisher journal unknown 无法合法落 Hold。

### 冻结结果

Recovery Hold 改为通用 source identity：

```text
sourceKind = critical-intent | publisher-journal | target-post-image | existing-protocol | module-recovery | manual
sourceRef  = bounded durable identity
intentId   = nullable
```

约束：

- `sourceKind=critical-intent` 时 `intentId` 必填；
- `sourceKind=publisher-journal / existing-protocol / module-recovery / manual` 时 `intentId` 必须为空；`target-post-image` 必须引用 Main-owned intent；
- `sourceRef` 使用 journal identity，不保存任意用户路径；
- `(sourceKind, sourceRef)` 幂等；
- active hold 按 conflict scope 同时阻断 managed 和 legacy mutation。

### 关闭证据

- Lifecycle Mapping 的 Recovery Hold 合同
- E00 TechDoc `background_execution_recovery_holds` DDL
- 当前合同中的 `RecoveryControlRepository.runInControlTransaction()` + `tx.transitionWithRecoveryEvent(command='create-or-get')`；旧独立 Hold writer 已废止

**状态：P0 合同已关闭。**

## 6. P0-5：BankBU 同月重跑旧 mirror pre-image

### 问题

同月重跑时：

```text
新 side run COMMIT
→ main mirror 事务尚未开始
```

Main 中通常仍有旧 mirror，而不是 mirror 不存在。仅识别“side 有 + mirror 无”会把可恢复 partial 错判 unknown。

### 冻结结果

进入 critical 前持久捕获：

```text
expectedPreviousMirror = absent
或
{ mirrorId, sideRunId, operationKey, status, stableHash }
```

Inspector：

| 新 side receipt | 当前 mirror | 结论 |
| --- | --- | --- |
| 无 | 等于 pre-image | `not-committed` |
| 有 | 等于新 operationKey + sideRunId | `committed` |
| 有 | 仍等于 captured pre-image，包括旧 mirror 仍存在 | `partially-committed` / `complete-mirror` |
| 任意 | 既非 pre-image 也非新 post-image | `unknown` + Hold |

`complete-mirror` 只能用已提交 side run 做 CAS 补镜像，禁止重新运行匹配算法。

### 关闭证据

- `changes/3.2.2/spec.md` §7.4
- `changes/3.2.2/techdoc.md` §8.1～8.3
- 故障矩阵包含“无旧 mirror / 有旧 mirror / 并发变化”

**状态：设计 P0 已关闭；BankBU run 生产启用仍需 schema migration、fault injection 与人工资金复核。**

## 7. P0-6：Statement 同一 Task 多个 manual balance seed

### 问题

一个 TaskRun 可顺序出现多个 manual-balance prompt。整个 Task 共用一个 continuation operationKey 会与 intent/receipt 唯一键冲突。

### 冻结结果

Main 在 Task 持久 metadata 中原子分配：

```text
interactionOrdinal = 1..N
operationKey = taskRunId / statement:resolve-manual-balance / interactionOrdinal
```

规则：

- 同一 token 的 transport recovery 复用 ordinal/operationKey；
- 新 token、新账户或下一 seed 使用新 ordinal；
- token 返回前必须完成 PendingInteractionReservation grant/adopt；
- seed durable post-image 是权威提交证据；
- Critical Intent 只保存 expected pre/post、operation identity 和冲突 scope；
- `commit:receipt` 只是已观察到 post-image 的通知，startup recovery 必须重读目标文件。

### 关闭证据

- `changes/3.2.3/spec.md` §7.1
- `changes/3.2.3/techdoc.md` §4、§7
- Protocol Service resource grant/adopt schema

**状态：设计 P0 已关闭；manual seed 生产启用仍需 atomic writer/inspector/fault injection。**

## 8. P1 关闭情况

### 8.1 VCC OP Task 边界

冻结为三个独立 action：

```text
vcc-op:scan-and-compute
vcc-op:compute-amounts
vcc-op:save-run
```

scan 在 Compute Snapshot adoption 后成功终结；不保持 running 等待未来 save。`compute-amounts` 是轻量 `inline-excluded`；save 使用新 Task 和稳定 operationKey。

### 8.2 E00 与 v3.2.0 PR 不重复实现

E00-A～F 是 contract/gate/evidence track；唯一源码实现为 v3.2.0 E02-A～C2。`implementation-sequence.md` 和 E00 Spec 已冻结映射。

### 8.3 E00 链接

所有路径统一为真实文件名：

```text
E00-platform-contract-v1-spec.md
E00-platform-contract-v1-techdoc.md
```

validator 检查所有以 changes/ 开头的合同引用均真实存在。

### 8.4 JPM 大结果不走 postMessage

`resultCandidate` 保留在 ReconFix Service 内；Job 只返回：

```text
resultHandle
boundedSummary
```

no-op 不进入 critical；Main 不接收完整 fixed/unmatched 候选数组。

## 9. 仍然保留的 action 生产门禁

以下不是平台合同缺口，而是实施/生产门禁：

- VCC OP `saveRun` 同事务 operation receipt migration；
- PreFund inserted/replaced/noop receipt 与 fault injection；
- Duplicate startup inspector 必须先于 Service construction；
- BankBU side/main identity schema、CAS mirror recovery 和人工资金复核；
- Statement atomic balance seed、post-image inspector、Windows 文件语义；
- ReconFix JPM ID-aware reader、坏 JSON hard fail、receipt 与人工复核；
- Toolbox Route DB sidecar sealing 和双 Writer benchmark；
- VCC Financial OP subject filter query pushdown；
- 成熟 adapters 零额外 spawn、零双 settle、零业务漂移。

未通过的 action 保持：

```text
production.enabled = false
legacy-preserved 或 blocked
```

## 10. 实施入口

先执行：

```bash
changes/background-execution/validation/run-validation.sh
```

然后按：

```text
v3.2.0 E02-A Policy/Protocol
→ E02-B ResourceGovernor
→ E02-C1 Lifecycle/Batch overlay/events
→ E02-C2 Critical Intent/Hold/startup recovery
→ action probes 和各版本业务 PR
```

公共平台可以开始编码；任何资金 mutation 不得因“文档已 Implementation Ready”跳过 action-specific receipt/inspector/人工门禁。


## 后续定点回修

本报告之后又关闭了 `main-settlement` 恢复来源闭环、TaskRun 完整邻接表和 Main-owned 持久边界。最终结论与证据以 `P0-final-recovery-contract-closure-report.md`、最新 Schema/validator 和 `validation-report.json` 为准。
