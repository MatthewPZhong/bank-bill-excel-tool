# v3.2.4 Spec — ReconFix 安全写回与 VCC Financial OP 主体输出图

| 项目 | 内容 |
| --- | --- |
| 目标版本 | v3.2.4 |
| 日期 | 2026-08-21 |
| 状态 | Implementation Ready / 普通与 BOC、VCC single 可推进，JPM/双 Writer 受独立门禁 |
| 实施前置 | 进入本版本编码前，v3.2.0 E02-A～C2 必须已合并并通过 platform canary |
| 配套 TechDoc | `changes/3.2.4/techdoc.md` |
| 涉及范围 | ReconFix Service/normal/BOC/JPM/export；VCC Financial OP result subject output single/dual Writer |

## 0. 规范性依赖与文档状态

本文件是 E00 Platform Contract v1 冻结后的版本级产品规格。以下文件具有更高优先级，本文件不得重新定义同义字段：

- `changes/background-execution/platform-contract-v1.md`；
- `changes/background-execution/platform-contract-v1.schema.json`；
- `changes/background-execution/platform-lifecycle-mapping.md`；
- `changes/background-execution/E00-platform-contract-v1-spec.md`；
- `changes/background-execution/E00-platform-contract-v1-techdoc.md`。

本文件只回答四类问题：

1. 本版本接管哪些静态 `actionKey`；
2. 每个 action 选择哪一种正式 `mode`、`lifetime` 和 `commit.kind`；
3. 模块业务不变量、持久 receipt/inspector 与 artifact 结算边界是什么；
4. 哪些 action 已可生产启用，哪些仍为 `blocked` 或 `legacy-preserved`。

统一术语：

```text
actionKey      静态 Registry / Inventory 主键
operation      Protocol v1 消息命令或事件
operationKey   跨重启稳定的业务幂等与恢复身份
jobId          一次 transport attempt
unitId         parent job 内工作单元
```

正式执行模式仅允许：

```text
inline-async
thread-single
thread-pool
utility-process
```

正式提交策略仅允许：

```text
none
main-settlement
worker-durable
existing-critical-protocol
```

任何 `commitState=unknown`、`partially-committed` 或 committed-but-result-lost 必须按生命周期合同把 TaskRun 置为 `interrupted`；Batch 基础 `task_status` 保持兼容值 `failed`，effective Batch 状态由 Option B overlay 表达为 `interrupted/recovering`。Renderer 显示 `recovery-required` 并创建 Recovery Hold；不得静默降级为普通 failed/cancelled，也不得自动重跑。

## 1. Task Brief

### Goal

把原v3.2.3中两类不同风险能力独立成一个可分开发布的版本：

- ReconFix：长驻Service保存session/result；普通与BOC只读路径先迁；JPM使用ID-aware ADM reader、明确no-op、同事务operation receipt和inspector；
- VCC Financial OP：先把当前主体结果输出迁入单Writer新合同；只有subject filter下推和性能/RSS通过后才启用最多两个Writer；正式发布继续单一Publisher。

### Done when

- ReconFix普通/BOC可在JPM blocked时独立managed；
- JPM不再使用会静默跳坏JSON、缺ID的reader；
- preImage==postImage时明确noop且不进入critical；
- JPM mutation与operation receipt同一DB事务；
- COMMIT后回包前crash可由receipt唯一恢复；
- VCC两个Writer不会各自加载全量主体；
- subjectIndex顺序、金额币种、样式、revision/archive和Publisher等价；
- action独立feature flag与人工资金门禁。

## 3. Action 级范围

| actionKey | currentDisposition | targetDisposition | mode | lifetime | adapterKind | commit.kind | production.enabled（代码合并时） | 说明 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `recon-fix:import` | `legacy-preserved` | `managed` | `thread-single` | `service` | `native` | `none` | `false` | Session 单一所有者 |
| `recon-fix:run-readonly` | `legacy-preserved` | `managed` | `thread-single` | `service` | `native` | `none` | `false` | 普通/BOC 只读运行 |
| `recon-fix:run-jpm` | `legacy-preserved` | `managed` | `thread-single` | `service` | `native` | `worker-durable` | `false` | ID-aware、no-op、同事务 receipt、inspector |
| `recon-fix:export` | `legacy-preserved` | `managed` | `thread-single` | `service` | `native` | `main-settlement` | `false` | main/unmatched 全有或全不发布 |
| `vcc-financial-op:export-subjects` | `legacy-preserved` | `managed` | `thread-pool` | `job` | `native` | `main-settlement` | `false` | subject filter 下推；默认 1 Writer，门禁后最多 2 |
| `vcc-financial-op:export-single` | `legacy-preserved` | `managed` | `thread-single` | `job` | `native` | `main-settlement` | `false` | 单主体/审计/明细 |


## 3. ReconFix Service

Worker唯一持有session、subMode、原始Sheets、result、scenario snapshot和linked evidence。Main持generation/revision/summary/FilePlan/TaskLifecycle。

- import成功替换session并清result；
- run前深拷贝工作数据；
-场景、ADM/BOC相关数据变更使result失效；
- export准备与执行时均重读evidence；
- Service crash后内存session/result丢失，不从已发布文件恢复。

## 4. JPM 安全写回

### 4.1 ID-aware Reader

新增资金写回专用reader，必须：

- `ORDER BY id ASC`；
-每行返回DB id与原始raw_json；
-坏JSON hard fail，禁止静默跳行；
-返回完整rowCount、idSequenceDigest和preImageHash；
-写回前重新校验count/idSequenceDigest。

### 4.2 No-op

引擎计算后先构造changed row set：

- changedRowCount==0或preImageHash==expectedPostImageHash → outcome=noop；
-不创建Critical Intent、不开始事务、不写operation receipt；
- result可按现有业务语义采用并导出；
-transport丢失可安全重新计算，因为无持久mutation。

### 4.3 Mutation

非noop：

```text
persist critical intent prepared/acked
→ critical:ack
→ BEGIN IMMEDIATE
→ re-read ID-aware evidence
→ update exact ids
→ insert operation receipt(pre/post/id digest/count)
→ COMMIT
→ commit:receipt
→ adopt in-memory result
```

receipt与ADM mutation必须同一主库事务。

## 5. JPM Inspector

优先使用operation receipt：

- receipt唯一、post hash/count/id digest与当前DB匹配 → committed；
- receipt不存在且当前DB等于pre image → not-committed；
- receipt不存在但当前DB等于expected post → unknown，而不是猜测committed；
- 当前既非pre也非post、坏JSON、ID变化或receipt冲突 → unknown；
- unknown创建ADM conflict-scope Recovery Hold。

这样消除pre==post的二义性，并防止其它操作恰好产生相同post image被误认成本operation。

## 6. ReconFix Export

Worker根据result决定main/unmatched输出。所有需要的artifact在staging生成、回读、hash和业务校验完整后，Main一次Publisher。任一失败不发布部分文件。

## 6.1 JPM 大结果消息边界

JPM `resultCandidate` 始终保留在 ReconFix Service Worker 内：

- no-op：Service 内原子采用结果，只返回 `resultHandle + boundedSummary`；
- mutation：candidate 进入 Service private pending map，ADM receipt committed 后才采用；
- crash：pending candidate 丢失，主进程不得从 protocol payload 重建完整结果；
- `job:done`、`critical:ready` 和 `commit:receipt` 均不得携带完整 fixed/unmatched rows。

## 7. VCC Financial OP 输出

### 7.1 单Writer新合同

先把现有顺序生成迁到one-shot Writer contract，保持：

-同一activeTask/taskGeneration；
-runId/month/resultRevision/inputFingerprint/archive state复核；
-每主体模板、金额、币种、Pending sheet、样式和lineage；
-所有artifact完成后一次Publisher。

### 7.2 Subject filter下推

双Writer前，查询层必须提供：

```text
loadEffectiveRunDataForSubject(runId, subject)
```

或等价SQL filter。禁止每个Writer加载全量subjects再丢弃非本分片数据。

### 7.3 最多两个Writer

- subjectIndex唯一覆盖；
-每Worker read-only DB，独占generation paths；
-完成顺序不影响subjectIndex输出顺序；
-任一失败Publisher调用0；
-所有成功后单Publisher；
-双Writer端到端提升≥15%、small regression≤5%、RSS合格才启用。

## 8. 验收标准

- ReconFix import/standard/BOC/JPM/export golden；
- ID-aware reader不静默丢坏行；
- JPM noop不进入critical/DB transaction；
- JPM receipt同事务、crash recovery、hold；
- ADM id/order/count变化时rollback；
-双输出全有或全不发布；
- VCC single Writer等价；
-subject query实际下推（SQL/row count探针）；
- 1 vs 2 Writer金额/币种/style/order等价；
- Publisher一次或0次；
- Windows/RSS/人工资金复核。

## 9. PR 顺序

| PR | 内容 | 门禁 |
| --- | --- | --- |
| E11-A | ReconFix Service import/standard/BOC | 只读golden、state失效 |
| E11-P0 | ID-aware reader + no-op + receipt schema | 坏行/ID/事务审计 |
| E11-B | JPM worker-durable + inspector | crash/hold/人工资金复核 |
| E11-C | ReconFix export | all-or-none Publisher |
| E12-A | VCC single Writer新合同 |主体golden |
| E12-B | subject filter下推 | 查询/RSS证据 |
| E12-C | optional second Writer | 15%/Windows |
| R3.2.4 | release evidence | ReconFix/VCC独立enable |

## 10. 强制 BLOCK

- JPM reader仍跳过坏JSON或不返回ID；
- no-op未在critical前识别；
- receipt不与ADM update同事务；
- inspector依赖pre/post hash猜测committed而无receipt；
- VCC Writer仍加载全量主体；
- VCC双Writer无15%收益或RSS超预算。

## 11. 资金红线

⚠️ JPM ADM id顺序、changed rows、pre/post hash、标志和receipt；VCC每主体金额、币种、差异、revision、archive和输出顺序必须人工复核。JPM unknown不得自动重跑。
