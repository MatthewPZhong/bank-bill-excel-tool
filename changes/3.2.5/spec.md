# v3.2.5 Spec — 剩余只读导出、成熟执行器 Adapter 与全量 Action 收口

| 项目 | 内容 |
| --- | --- |
| 目标版本 | v3.2.5 |
| 日期 | 2026-08-21 |
| 状态 | Implementation Ready / 平台收口 action 按证据独立启用 |
| 实施前置 | 进入本版本编码前，v3.2.0 E02-A～C2 必须已合并并通过 platform canary |
| 配套 TechDoc | `changes/3.2.5/techdoc.md` |
| 涉及范围 | Pending/BizOP/PreFund/Position/VCCFin只读导出、Acquiring导出分类、成熟adapters、Action Coverage、最终策略快照 |

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

完成后台执行平台的外围收口：

1. 将仍会阻塞主线程的只读查询/工作簿生成迁到模块专用单Worker或异步复制；
2. 将Pending、BizOP、Acquiring、Position成熟执行器接入统一Protocol/Resource/Lifecycle，但不重写业务引擎；
3. 对全部action实现100% Manifest/Inventory/Registry覆盖；
4. 分开发布Capability Inventory与Effective Production Strategy Snapshot，不再以固定“7+7”数量作为成功标准。

### Done when

- 每个handler/FilePlan action都有唯一静态actionKey和明确disposition；
- read-only导出不改变SQL、排序、金额、格式和Publisher；
-成熟adapter不额外spawn，不改变内部worker/process数量、事务和cancel；
- Recovery Hold能阻断managed和legacy冲突mutation；
- release-check基于显式manifest/AST/模块导出，不依赖脆弱文本正则；
-最终策略快照准确显示effectiveMode/effectiveWorkerCount/降级原因/恢复状态/legacy可用性。

## 2. 范围

### Read-only outputs

- Pending差异、汇总、错误报告；
- BizOP单日、日期区间；
- PreFund渠道、平账、不平、审计；
- Position银行、Linked、Raw、Run、筛选；
- VCC Financial OP非主体类审计/明细；
- Acquiring已有差异文件复制或重新生成的action分类。

### Mature adapters

- Pending/BizOP big-table engine；
- Acquiring import pool、runCheckWorkerPool、eligible multiworker、single/resume；
- Position utilityProcess/child_process fallback与既有grant/commit/cancel；
-必要的Toolbox/VCC existing publisher adapter复核。

### Platform closure

- Action Manifest与coverage；
- Capability Inventory；
- Effective Production Strategy Snapshot；
-legacy seam保留/删除决策；
-release-check、Windows与观察窗口。

### 非目标

- 不新增匹配/对账算法；
-不重写成熟池；
-不把 Position 现有 import utility-process/child_process dispatcher 改成 worker thread；只读 export 按 3.1 的 native thread-single action 执行；
-不删除所有legacy seam；
-不因“全量收口”强行启用并行；
-不允许只读action解除mutation Recovery Hold。

## 3. Action 级范围

### 3.1 剩余只读导出

| actionKey | currentDisposition | targetDisposition | mode | lifetime | adapterKind | commit.kind | production.enabled（代码合并时） | 说明 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `pending:export-diff` | `legacy-preserved` | `managed` | `thread-single` | `job` | `native` | `main-settlement` | `false` | stable run snapshot → workbook → Publisher |
| `pending:export-summary` | `legacy-preserved` | `managed` | `thread-single` | `job` | `native` | `main-settlement` | `false` | 模块专用 writer |
| `pending:export-errors` | `legacy-preserved` | `managed` | `thread-single` | `job` | `native` | `main-settlement` | `false` | 错误总数/样本不变 |
| `biz-op:export-day` | `legacy-preserved` | `managed` | `thread-single` | `job` | `native` | `main-settlement` | `false` | 按日期稳定顺序 |
| `biz-op:export-range` | `legacy-preserved` | `managed` | `thread-single` | `job` | `native` | `main-settlement` | `false` | 区间单 workbook 串行 |
| `pre-fund:export-channel` | `legacy-preserved` | `managed` | `thread-single` | `job` | `native` | `main-settlement` | `false` | 共享候选已提交结果只读 |
| `pre-fund:export-audit` | `legacy-preserved` | `managed` | `thread-single` | `job` | `native` | `main-settlement` | `false` | 审计顺序/血缘不变 |
| `position:export-run` | `legacy-preserved` | `managed` | `thread-single` | `job` | `native` | `main-settlement` | `false` | 模块专用只读 Worker；不得复用 position import dispatcher |
| `vcc-financial-op:export-audit` | `legacy-preserved` | `managed` | `thread-single` | `job` | `native` | `main-settlement` | `false` | 非主体类输出 |
| `acquiring:copy-existing-diff` | `inline-excluded` | `managed` | `inline-async` | `job` | `native` | `main-settlement` | `false` | 已有稳定文件时只异步复制 |
| `acquiring:export-diff-workbook` | `legacy-preserved` | `managed` | `thread-single` | `job` | `native` | `main-settlement` | `false` | 需要查询/重建时使用 |

### 3.2 成熟执行器适配

| actionKey | currentDisposition | targetDisposition | mode | lifetime | adapterKind | commit.kind | production.enabled（代码合并时） | 说明 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `pending:import` | `managed` | `managed` | `thread-pool` | `job` | `existing-dispatch` | `existing-critical-protocol` | `true` | 现有 big-table engine；不额外 spawn |
| `biz-op:import-flow` | `managed` | `managed` | `thread-pool` | `job` | `existing-dispatch` | `existing-critical-protocol` | `true` | 现有 ordered writer |
| `acquiring:import` | `legacy-preserved` | `managed` | `thread-pool` | `job` | `existing-dispatch` | `existing-critical-protocol` | `false` | adapterKey 固化现有 import pool |
| `acquiring:run-new-eligible` | `legacy-preserved` | `managed` | `thread-pool` | `job` | `existing-dispatch` | `existing-critical-protocol` | `false` | 仅符合既有 multiworker gate 的全新 run；adapterKey 固定 |
| `acquiring:run-single-or-resume` | `legacy-preserved` | `managed` | `thread-single` | `job` | `existing-dispatch` | `existing-critical-protocol` | `false` | small / resume / forced-single；不得在运行中切换 |
| `position:import` | `legacy-preserved` | `managed` | `utility-process` | `job` | `existing-dispatch` | `existing-critical-protocol` | `false` | 保留 prepare/grant/apply/recovery |

`adapterKey`、`entryKey`、`inspectorKey` 等必须在机器可读 Registry fixture 中给出，不能写“native 或 existing-dispatch”“模块现有映射”“job/service”等非 canonical 值。

## 4. Read-only export 合同

统一技术流程：

```text
Main冻结run/dataset/revision/FilePlan
→ module-specific read-only Worker
→ module SQL/排序/Workbook writer
→ staging
→ technical + business validation
→ module Publisher
→ archive/Task settle
```

公共层不统一：Sheet、列、金额、币种、标黄、warning、行顺序或业务错误。

- Worker使用read-only DB连接；
-输入evidence在开始和生成前复核；
-大结果写staging，不通过postMessage；
- artifact全有或全不发布；
- generation失败不改变run；
-Publisher不确定状态走现有journal/inspector。

## 5. Acquiring 导出分类

Inventory必须依据实际代码和稳定artifact判断：

-若action只复制已经存在且hash可验证的差异文件：`inline-async`；
-若仍需查询DB、组装行或生成XLSX：`thread-single`；
-不能仅根据按钮文案“导出差异”分类；
-两个action应使用不同actionKey，避免运行时猜测策略。

## 6. Mature adapter 合同

Adapter只负责：

- Protocol v1 envelope；
- jobId/operationKey映射；
- ResourceGovernor CompoundLease；
- progress/metrics/error codec；
- cancel/close/exit；
- exactly-once ExecutionResult；
-调用既有receipt/inspector并映射Lifecycle。

禁止：

-外层再spawn一个Worker；
-复制内部Parser Pool；
-改变nextWriteIndex/chunk merge/eligibility gate；
-把 Position 现有 import utility-process/child_process dispatcher 改为 thread；
-让旧dispatcher和Supervisor各settle一次；
-在unknown时自动fallback。

## 7. Action Coverage Gate

每个action必须为：

```text
managed
legacy-preserved
inline-excluded
blocked
```

CI交叉验证：

- Handler Manifest；
- FilePlan definitions；
- Inventory；
- Registry；
- Inspector Registry；
- Publisher/Validator registry；
-Feature flag/legacy strategy。

扫描方式优先：显式注册metadata、构建时module exports或AST。正则只能辅助，不能作为唯一证据。

特别要求：v3.2.1 deferred的`pre-fund:bank-import`、`pre-fund:run`必须显示真实策略；不能因MPT/export已后台化就宣称PreFund全链路完成。

## 8. 两份最终清单

### Capability Inventory

记录代码具备的安全能力：single、pool、utility process、async I/O、receipt/inspector、artifact Publisher。

### Effective Production Strategy Snapshot

每个action记录：

```text
actionKey
disposition
effectiveMode
effectiveWorkerCount
adapterKind
eligibilityThreshold
downgradeReason
featureFlag
benchmarkEvidenceId
recoveryStatus
legacyAvailable
```

实现了pool但生产count=1，应如实显示1；不以固定数量KPI迫使开启并行。

## 8.1 可执行 Coverage / Policy 校验

发布门禁必须运行：

```bash
changes/background-execution/validation/run-validation.sh
```

它至少执行：

- Draft 2020-12 JSON Schema 校验；
- 合法 Registry fixture 通过；
- worker-durable 缺 receipt/inspector、artifact 缺 Publisher、service 缺 resource control 等反例必须失败；
- Protocol Job/Service Control 正反 fixtures；
- property name == actionKey、静态引用、disposition/mode/lifetime/commit 语义校验；
- 本地 Markdown 链接与已知非法复合枚举扫描。

只扫描废弃词的报告不能作为 release evidence。

## 9. 验收标准

- 全action静态coverage=100%；
- managed action policy通过JSON Schema和语义gate；
-只读输出新旧workbook/DB读取等价；
- adapter进程拓扑无额外spawn；
- mature事务/cancel/recovery零漂移；
- unknown/partial映射interrupted+hold；
- read-only action不绕过hold；
- capability与effective snapshot不混淆；
-端到端回退≤5%或有明确保留legacy结论；
- Windows packaged、release-check、人工抽查通过。

## 10. PR 顺序

| PR | 内容 | 门禁 |
| --- | --- | --- |
| E13-A | Pending/BizOP只读导出 | workbook/排序golden |
| E13-B | PreFund/Position/VCCFin只读导出 | run/revision/审计golden |
| E13-C | Acquiring copy vs regenerate分类 | actionKey静态分离 |
| E13-D | Pending/BizOP adapters | 无额外spawn/事务零漂移 |
| E13-E | Acquiring adapter | pool/gate/resume零漂移 |
| E13-F | Position utility adapter | grant/critical/cancel映射 |
| E13-G | Manifest/AST coverage与策略快照 | 100% coverage |
| R3.2.5 | 全系列release evidence | Windows/观察窗口/人工复核 |

## 11. Legacy seam

本版本不自动删除legacy。删除条件：

-至少一个后续稳定观察版本；
-无open Recovery Hold与P0；
- Windows与大样本证据充分；
-单独change/PR与rollback设计；
-不影响历史DB/文件读取。

## 12. 资金与审计红线

⚠️ 适配不能改变Pending/BizOP/Acquiring/Position的行序、事务、幂等、chunk、runId、输出或恢复；只读导出不能误读stale/partial run。任何策略快照必须如实区分“已实现能力”和“当前生产启用”。
