# v3.2.1 Spec — Toolbox 后台生成与 PreFund MPT 有序导入

| 项目 | 内容 |
| --- | --- |
| 目标版本 | v3.2.1 |
| 日期 | 2026-08-21 |
| 状态 | Implementation Ready / Toolbox 与 PreFund action 按独立门禁启用 |
| 实施前置 | 进入本版本编码前，v3.2.0 E02-A～C2 必须已合并并通过 platform canary |
| 配套 TechDoc | `changes/3.2.1/techdoc.md` |
| 涉及范围 | Toolbox merge/split generation、Toolbox Publisher handoff、PreFund MPT import/repair import |

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

在 v3.2.0 平台上落地两条“并行准备、单点结算”的链路：

- Toolbox：先把 merge/普通拆分移到单 Worker；性能证据充分后，使用一次 Scanner + sealed Route DB + 最多两个只读 Writer；正式目标仍由既有 FIFO Publisher 一次提交；
- PreFund：MPT 文件可并行解析到任务私有 spool，但业务判断、替换、去重和 SQLite 写入按输入 fileIndex 由单一 Writer 执行，每个文件形成独立 durable receipt。

### Done when

- Toolbox 源文件在双 Writer 路径只解析一次；
- Route DB 完成 sidecar sealing、integrity/hash 和只读 Writer 合同；
- 任一 Toolbox artifact 缺失/失败时 Publisher 调用为 0；
- PreFund 解析完成顺序不改变 source sequence、batch.id、dataset version 或结果数组顺序；
- inserted/replaced/noop-existing-batch 都可按稳定 file operationKey 唯一恢复；
- COMMIT 后回包前 crash 不重复导入；
- 两条链路分别通过性能、RSS、Windows 和人工门禁。

## 2. 范围与非目标

### 必做

- Toolbox merge 与普通单输出拆分 `thread-single`；
- Toolbox multi-output Scanner/Route DB/Writer graph；
- Route DB sealing 与 artifact join；
- PreFund Parser Core、NDJSON spool、Ordered Coordinator；
- PreFund 单一 Writer Worker；
- 每文件 Critical Intent、module receipt 与 inspector；
- spool/Route DB 磁盘预算、背压和 crash 清理；
- action 独立 feature flag 与 benchmark。

### 不做

- 不并行 Toolbox Publisher；
- 不让 Writer 直接写用户目标；
- 不让每个 Toolbox Writer 重新扫描完整源文件；
- 不把同一 MPT 文件拆分给多个 Parser；
- 不并行 PreFund DB Writer、匹配或候选消费；
- 不改变 PreFund 银行导入、run 和结果导出；
- 不自动跨重启续跑 spool/Route DB；
- 不以另一个模块的性能收益替代本 action 门禁。

## 3. Action 级范围

| actionKey | currentDisposition | targetDisposition | mode | lifetime | adapterKind | commit.kind | production.enabled（代码合并时） | 说明 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `toolbox:merge` | `legacy-preserved` | `managed` | `thread-single` | `job` | `native` | `main-settlement` | `false` | Worker 写一个 staging workbook |
| `toolbox:split-single` | `legacy-preserved` | `managed` | `thread-single` | `job` | `native` | `main-settlement` | `false` | 普通拆分或 pool 不合格路径 |
| `toolbox:split-multi-output` | `legacy-preserved` | `managed` | `thread-pool` | `job` | `native` | `main-settlement` | `false` | 先单 Scanner；sealed Route DB；最多两个只读 Writer |
| `toolbox:split-large` | `managed` | `managed` | `thread-single` | `job` | `existing-dispatch` | `main-settlement` | `true` | v3.2.0 adapter，不重复 spawn |
| `toolbox:publish` | `managed` | `managed` | `thread-single` | `job` | `existing-dispatch` | `existing-critical-protocol` | `true` | durable journal 唯一正式发布证据 |
| `pre-fund:mpt-import` | `legacy-preserved` | `managed` | `thread-pool` | `job` | `native` | `worker-durable` | `false` | file parser units + 单 Writer；receipt 通过后启用 |
| `pre-fund:mpt-repair-import` | `legacy-preserved` | `managed` | `thread-single` | `job` | `native` | `worker-durable` | `false` | 复用 Parser/Writer core，effectiveWorkerCount=1 |

Release snapshot 只能填写 canonical 枚举；“managed capability”“blocked → managed”“thread-single / job 或 pool=1”均不是合法 Policy 值。

## 4. Toolbox 行为规格

### 4.1 单 Worker 先行

E04-A 先完成：

```text
Main FilePlan
→ one-shot generation Worker
→ validated staging artifact(s)
→ Main technical/business validation
→ existing FIFO Publisher
→ TaskLifecycle settle
```

这一步不引入 Route DB，先证明主线程卡顿下降、格式/内容等价和 Publisher 边界正确。

### 4.2 单扫描多 Writer

E04-B 只有 benchmark 证明 generation 是主要热点时启用：

```text
Scanner Worker 解析源一次
→ 写 task-private Route DB
→ seal Route DB
→ 1..2 read-only Writer Workers
→ artifact join by outputIndex
→ one Publisher call
```

Route DB 只保存生成输出所需的稳定 row/style representation，不是业务数据库、不是跨重启续跑事实。

### 4.3 发布语义

- 所有输出先写 FilePlan staging；
- outputIndex 全集唯一且顺序稳定；
- 任一 Writer/artifact 失败时不调用 Publisher；
- Publisher journal recovery 只恢复发布状态，不重新 generation；
- 正式目标全有或由既有 journal 给出明确 recovered/manual-recovery 状态。

## 5. PreFund 行为规格

### 5.1 解析与有序提交

```mermaid
flowchart LR
    P[Parser Pool] --> S[Per-file Spool]
    S --> O[Ordered Coordinator]
    O --> W[Single Writer]
    W --> R[Per-file Receipt]
```

- Parser 可乱序完成；
- Coordinator 只按 fileIndex 递增调用 Writer；
- Parser 业务错误形成当前文件 error，后续文件按现有语义继续；
- Writer 当前文件 rollback 不撤销前序 committed 文件；
- 结果数组与输入等长、同序。

### 5.2 文件级 operation identity

父任务拥有 `parentOperationKey`。每个文件派生稳定：

```text
fileOperationKey = parentOperationKey + '/file/' + zeroPaddedFileIndex
unitId = file:NNNNNN
```

Critical Intent、receipt 与 inspector 使用 fileOperationKey，避免一个 parent operation 下多次独立 COMMIT 无法区分。

### 5.3 Receipt outcome

receipt outcome 必须显式区分：

```text
inserted
replaced
noop-existing-batch
```

`noop-existing-batch` 可以引用旧 batchId，但必须为本次 fileOperationKey 写一条新的 operation receipt；不能把旧 batch 的存在直接当成本 Task 的提交证据。

### 5.4 业务不变量

保持：

- 文件名、content hash、sourceType/sourceBatch/source sequence；
- 同名同 hash noop、同名异 hash 冲突；
- 高 sequence 替换、低/同 sequence 拒绝；
- replacement 保留 batch.id；
- strict/skip invalid、repair token；
- datasetId、producerTaskRunId、dataset version；
- valid/excluded/error/noop/replaced 行数去向。

## 6. Commit 与恢复

每个非 parser-error 文件：

```text
persist critical intent prepared
→ persist acked
→ critical:ack
→ Writer BEGIN IMMEDIATE
→ existing identity/sequence checks
→ data mutation or noop decision
→ insert operation receipt in same transaction
→ COMMIT
→ commit:receipt
→ unit:done
```

Inspector：

- receipt 唯一且 batch/dataset/version/source hash 匹配：committed；
- 无 receipt 且无本 operation mutation：not-committed；
- receipt 与业务行、batch/version 冲突：unknown；
- parent task中部分文件 committed 不是自动 rollback；Task 的 mixed-result 终态必须与旧 handler golden 一致。

## 7. 资源与性能

- Toolbox multi-output requested max 2；
- Route DB + Writer 使用 CompoundLease；
- Route DB 生成后才释放 Scanner active phase，Writer 只读阶段另申请 phase lease；
- PreFund Parser Pool requested max 4，单 Writer计入同一 CompoundLease；
- ready spool 有高水位，Writer 落后时停止派发；
- 任务前估算 staging/spool 空间；
- 低内存降级 single；
- 生产并行只有端到端五次中位数改善 ≥15%、small regression ≤5%、RSS/磁盘合格才启用。

## 8. 验收标准

- Toolbox single Worker 与旧路径 workbook 语义/格式等价；
- Route DB 双 Writer 不重复解析源，outputIndex、Sheet、值、格式、样式、warning一致；
- Route DB seal 后无 WAL/SHM/journal sidecar，integrity/hash通过；
- generation failure 时 Publisher 调用为 0；
- Publisher uncertain 只走 journal recovery；
- PreFund 乱序 Parser 仍按 fileIndex提交；
- inserted/replaced/noop receipt 可唯一查询；
- COMMIT 后回包前 crash 不重复 mutation；
- mixed success/failure 与旧 Task/Renderer语义一致；
- spool/path/symlink/hash/count/source change全部 fail closed；
- Windows、RSS、event-loop、资金人工复核通过。

## 9. PR 顺序

| PR | 内容 | 门禁 |
| --- | --- | --- |
| E04-A | Toolbox merge/single split one-shot Worker | 格式等价、无主线程卡顿、Publisher不变 |
| E04-B | Scanner + sealed Route DB + 1 Writer | 单扫描、seal、artifact join |
| E04-C | 可选第 2 Writer | 15%收益、RSS、Windows |
| E05-A | PreFund Parser Core/spool/Coordinator | 只读等价、无 DB mutation |
| E05-P0 | receipt schema、旧 Task mixed result probe | outcome 唯一、生命周期冻结 |
| E05-B | 单 Writer + critical/inspector | crash recovery、资金复核 |
| E05-C | Parser Pool >1 | 性能/资源门禁 |
| R3.2.1 | release evidence | action独立 enable/rollback |

## 10. Unknowns / BLOCK

- PreFund mixed-result TaskLifecycle 当前精确映射必须由现有 handler golden 锁定；
- dedicated receipt table 与现有 dataset/batch fields 的最小方案需在 E05-P0 确认；
- Toolbox Route DB row/style codec 需证明格式保真；
- 双 Writer若无法把源扫描与主体数据解耦，保持单 Worker。

## 11. 资金与审计红线

⚠️ PreFund 的 source identity、sequence replacement、batch.id、dataset version、金额币种、repair token 和候选顺序必须人工核对。Toolbox 每个输出的行集、格式、Publisher journal 和全有或全无状态必须人工抽查。receipt 不明确时不得自动重跑。
