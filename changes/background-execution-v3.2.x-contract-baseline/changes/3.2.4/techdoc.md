# v3.2.4 TechDoc — JPM ID-aware Durable Writeback 与 VCC Subject-filtered Writer Graph

| 项目 | 内容 |
| --- | --- |
| 目标版本 | v3.2.4 |
| 日期 | 2026-08-21 |
| 状态 | Implementation Ready / JPM 与双 Writer 默认 blocked |
| 实施前置 | 进入本版本编码前，v3.2.0 E02-A～C2 必须已合并并通过 platform canary |
| 产品 Spec | `changes/3.2.4/spec.md` |
| 涉及范围 | ReconFix Service/JPM reader+receipt+inspector/export；VCC subject query/shard writers/artifact join |

## 0. 规范性技术依赖

本 TechDoc 直接实现 Platform Contract v1，不另起协议方言。业务命令使用 JobEnvelope；Service 生命周期与资源协调使用独立 ServiceControlEnvelope。

Job operations：

```text
job:start / unit:start / unit:done / unit:error
critical:ready / critical:ack / critical:reject / commit:receipt
job:done / job:error / job:cancel / cancel:ack
```

Service control operations：

```text
executor:init / executor:ready / executor:error / executor:close / executor:close-ack
resource:request / resource:grant / resource:reject
resource:adopted / resource:adopt-ack / resource:release / resource:release-ack
```

所有 Policy 使用 `actionKey` 作为静态主键；运行期 `operationKey` 只用于幂等、Critical Intent、module receipt 与 Recovery Hold。既有执行器使用真实 `mode` 加 `adapterKind='existing-dispatch'`，不得创建第五种 mode，也不得在外层再包一个 Worker。

ResourceGovernor 必须计入：

- BaseLease；
- PersistentReservation；
- PendingInteractionReservation；
- PhaseLease；
- CompoundLease；
- `replacePersistentReservation` 原子替换。

本文件中的任何 action 只有在 Registry coverage、资源 lease、取消/关闭、receipt/inspector、故障注入、Windows packaged 和人工资金门禁全部满足后，才允许从 `blocked/legacy-preserved` 切到 managed production。

## 1. 文件边界

```text
src/main-process/recon-id-fix-worker/
├── worker-entry.js
├── service.js
├── run-evidence.js
├── jpm-writeback-plan.js
├── jpm-outcome-inspector.js
└── artifact-generator.js

src/backend/database/
├── linked-table-writeback-reader.js
└── recon-fix-operation-receipt-repository.js

src/main-process/vcc-financial-op-output/
├── subject-query.js
├── shard-planner.js
├── writer-worker-entry.js
├── artifact-join.js
└── dispatch.js
```

## 2. ReconFix state

```javascript
{
  serviceGeneration,
  revision,
  session,
  result,
  stableSummary,
  persistentReservation,
  activeJobId
}
```

result保存scenarioSnapshot、linkedEvidence、inputEvidenceHash、runKind、fixed/unmatched和export qualification。Main只存小型summary。

## 3. ID-aware ADM Reader

建议接口：

```javascript
readAdmRowsForWriteback(db) => {
  rows: [{ id, rawJsonText, parsed, currentMatchFlag }],
  rowCount,
  idSequenceDigest,
  imageHash
}
```

实现要求：

- SQL `ORDER BY id ASC`；
- JSON.parse失败抛`ADM_RAW_JSON_CORRUPTED`并包含有限id样本；
-不filter/drop任何行；
- digest覆盖id序列；
- imageHash覆盖id+canonical match flag/相关writeback字段；
- read-only inspector和writer使用同一canonicalizer。

## 4. JPM Plan

Worker运行引擎后构造：

```javascript
{
  operationKey,
  sourceEvidence,
  preImageHash,
  expectedPostImageHash,
  idSequenceDigest,
  rowCount,
  changedRows: [{ id, expectedPre, expectedPost }],
  resultHandle: 'service-private-handle'
}
```

`resultCandidate` 保留在 ReconFix Service 内部，以 `(serviceGeneration, operationKey, resultHandle)` 索引，不进入 `postMessage`。如果 changedRows 为空或 pre==post，返回 `job:done { resultKind:'noop', resultHandle, boundedSummary }`，不发送 `critical:ready`。Main 不得收到完整 fixed/unmatched 候选数组。

## 5. JPM Receipt schema

建议主库表：

```sql
CREATE TABLE IF NOT EXISTS recon_fix_adm_operation_receipts (
  action_key TEXT NOT NULL,
  operation_key TEXT NOT NULL,
  producer_task_run_id TEXT NOT NULL,
  scenario_id TEXT NOT NULL,
  pre_image_hash TEXT NOT NULL,
  post_image_hash TEXT NOT NULL,
  id_sequence_digest TEXT NOT NULL,
  row_count INTEGER NOT NULL,
  changed_row_count INTEGER NOT NULL,
  committed_at TEXT NOT NULL,
  PRIMARY KEY(action_key, operation_key)
);
```

事务：

```text
BEGIN IMMEDIATE
re-read rows with ID-aware reader
assert rowCount/idSequenceDigest/preImageHash
apply updates by exact id
insert receipt
COMMIT
```

不得按数组下标隐式匹配未验证的DB行。

## 6. JPM Inspector

```javascript
inspectReconFixJpmOutcome({ actionKey, operationKey, taskRunId })
```

流程：

1. 查receipt；
2. read current ADM image with hard-fail reader；
3. receipt存在且task/scenario/current post匹配 → committed；
4. receipt不存在且current==persisted pre evidence → not-committed；
5. receipt不存在但current==post或其它变化 → unknown；
6. receipt冲突/坏行/ID变化 → unknown。

pre evidence保存在Critical Intent bounded payload；receipt是committed权威证据。

## 7. Result adoption after commit

COMMIT成功后Worker才采用result。如果COMMIT后Worker crash：

- startup inspector恢复committed；
- DB mutation不重复；
-内存result无法跨重启恢复时Task可interrupted并提示重新加载/重新生成只读result；
-新run必须识别已有operationKey，不重新写ADM。

是否从receipt+输入artifact重建result是后续优化，不作为自动mutation重跑。

## 8. ReconFix export

Worker按既有命名/Sheet/列生成main和可选unmatched。Main Join验证：

- scenario/linked evidence未变；
- artifactKey/FilePlan；
- manifest全集和顺序；
- size/hash/business readback；
-一次Publisher。

## 9. VCC subject query

新增read-only query只返回一个subject所需行、balance、Pending和lineage。应通过SQL WHERE/索引下推，并有测试断言每Worker读取行数≈其subject，而非全量。

Worker输入：

```javascript
{
  runId,
  targetMonth,
  expectedResultRevision,
  expectedInputFingerprint,
  expectedArchiveState,
  subjects: [{ subjectIndex, subject, generationPath }]
}
```

每Worker在打开DB后重新核对run evidence。

## 10. Shard Planner / Join

- 1或2个shard；
- subjectIndex唯一覆盖；
- generationPath由FilePlan分配；
-每Writer顺序生成自己的subjects；
- Join按subjectIndex排序；
-任一revision/fingerprint/archive/manifest变化取消全组；
-全部成功后调用一次现有Publisher。

## 11. Resource policy

- ReconFix Service Base/Persistent/Phase lease；
- JPM DB write protected phase不允许terminate当cancel；
- VCC single/dual Writer使用CompoundLease；
-每个Writer memory estimate基于subject query，不以全量load估计；
-低内存固定single；
-并行失败不运行中fallback。

## 12. Fault matrix

| 故障 | 结果 |
| --- | --- |
| ADM bad JSON | JPM hard fail，DB无变化 |
| no-op | 无critical/receipt，安全返回noop |
| ID/count变更 | transaction rollback |
| COMMIT后reply前crash | receipt committed，hold不误建 |
| current==post但无receipt | unknown，禁止猜测 |
| Service crash | session/result失效；持久DB按inspector |
| VCC one Writer crash | 取消其它，Publisher 0 |
| VCC revision变化 | fail closed |
| Publisher uncertain | existing journal recovery |

## 13. Tests

- hard-fail reader bad JSON/ID order；
- no-op不调用critical/DB；
- receipt与ADM同事务故障注入；
- pre/post/receipt inspector矩阵；
- standard/BOC/JPM golden；
- ReconFix双artifact all-or-none；
- VCC subject SQL pushdown/read count；
- 1/2 Writer等价、RSS、15% benchmark；
- Windows native DB locks、Publisher recovery和人工复核。

## 14. Rollback

- standard/BOC、JPM、VCC single、VCC dual使用独立flags；
- JPM blocked时不影响只读路径；
- dual回退single不改变Publisher；
- receipt表不down-migrate；
- Recovery Hold同时阻断legacy JPM mutation。
