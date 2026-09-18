# v3.2.2 Spec — FundRecon / Duplicate 长驻 Service 与 BankBU 有序后台执行

| 项目 | 内容 |
| --- | --- |
| 目标版本 | v3.2.2 |
| 日期 | 2026-08-21 |
| 状态 | Implementation Ready / FundRecon 可推进，Duplicate/BankBU mutation 受独立门禁 |
| 实施前置 | 进入本版本编码前，v3.2.0 E02-A～C2 必须已合并并通过 platform canary |
| 配套 TechDoc | `changes/3.2.2/techdoc.md` |
| 涉及范围 | FundRecon Service、Duplicate Service/paired parser、BankBU job/dual parser、side-main recovery |

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

把共享可变业务状态明显的三类流程移出 Electron 主线程，但不把顺序匹配强行分片：

- FundRecon：一个长驻 Service 唯一持有银行、网关、退款和 processingResult，R1→R5/M2M串行；
- Duplicate：一个长驻 Service 唯一持有双输入、候选消费、side store、mirror 和 lastRun；可选 paired parser只负责准备 spool；
- BankBU：每个 import/run/export 使用 one-shot job；可选双 Parser只负责两个输入，数据库覆盖和匹配串行。

### Done when

- 主进程不保留 FundRecon/Duplicate 第二份完整可变业务 state；
- Service 的 BaseLease、PersistentReservation、busy/close/crash 规则可审计；
- Duplicate startup recovery先于 compensation和Service构造；
- BankBU side run/main mirror共享 operationKey，mirror保存sideRunId；
- committed/not-committed/partial/unknown可唯一判断；
-匹配顺序、候选消费、镜像、输出和错误与旧路径等价；
- paired/dual parser未过15%与RSS门禁时生产固定single。

## 2. 范围与非目标

### 必做

- FundRecon Service Worker：import/run/export/status/invalidate；
- Duplicate Service Worker与独立startup recovery coordinator；
- Duplicate可选Bank/Document paired parser + spool；
- BankBU import/run/single/aggregate export one-shot Worker；
- BankBU可选Pending/Bank dual parser；
- Duplicate/BankBU operation receipt、inspector、Recovery Hold；
- Service资源、app quit、stale token/revision、Windows测试。

### 不做

- 不按FundRecon轮次、candidate bucket、BU key或Duplicate group并行；
- 不持久化恢复FundRecon内存会话；
- 不让主进程镜像完整rows/result；
- 不新增用户线程设置；
- 不在crash后自动切回inline重跑；
- 不让paired/dual parser写业务库；
- 不改变金额币种、first-match、normalize、runId或输出格式。

## 3. Action 级范围

| actionKey | currentDisposition | targetDisposition | mode | lifetime | adapterKind | commit.kind | production.enabled（代码合并时） | 说明 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `fund-recon:import` | `legacy-preserved` | `managed` | `thread-single` | `service` | `native` | `none` | `false` | 纯内存 state adoption，Service 单一所有者 |
| `fund-recon:run` | `legacy-preserved` | `managed` | `thread-single` | `service` | `native` | `none` | `false` | R1→R5 串行 |
| `fund-recon:export` | `legacy-preserved` | `managed` | `thread-single` | `service` | `native` | `main-settlement` | `false` | Worker staging、Main Publisher |
| `duplicate:import` | `legacy-preserved` | `managed` | `thread-pool` | `service` | `native` | `worker-durable` | `false` | paired parser 可选；Service 单写；startup inspector 前置 |
| `duplicate:run` | `legacy-preserved` | `managed` | `thread-single` | `service` | `native` | `worker-durable` | `false` | side/mirror共同identity |
| `duplicate:export` | `legacy-preserved` | `managed` | `thread-single` | `service` | `native` | `main-settlement` | `false` | lastRun稳定后只读输出 |
| `bank-bu:import-month` | `legacy-preserved` | `managed` | `thread-pool` | `job` | `native` | `worker-durable` | `false` | dual parser可选；月库单事务 |
| `bank-bu:run` | `legacy-preserved` | `managed` | `thread-single` | `job` | `native` | `worker-durable` | `false` | side/new receipt + previous mirror pre-image + main mirror |
| `bank-bu:export-single` | `legacy-preserved` | `managed` | `thread-single` | `job` | `native` | `main-settlement` | `false` | dual-source 不变 |
| `bank-bu:export-aggregate` | `legacy-preserved` | `managed` | `thread-single` | `job` | `native` | `main-settlement` | `false` | 月份顺序与 included/skipped 不变 |


## 4. Service 公共行为

长驻 Service 必须：

- 每次重建递增 serviceGeneration；
- 同时最多一个 mutation/import/run/export command；
- active时拒绝过期/重入命令，不静默排队；
- status只返回有上限DTO；
- 主进程不保存完整state；
-采用新state前先原子替换PersistentReservation；
- idle关闭释放BaseLease/State；
- crash后旧generation、revision、token和result全部fail closed；
-若有持久mutation，startup inspector必须在任何清理/compensation前运行。

## 5. FundRecon 行为规格

Worker唯一持有：bank/gateway/refund session、working result、scenario/link evidence、warning和export qualification。

严格顺序：

```text
R1 → R2 → R3(no-op) → R3.5 → R4
→ R5s2b → R5s2 → R5s3 → R5s4 → M2M → buildOutputRows
```

- 所有轮次使用同一working rows与候选消费集合；
- run失败不修改stable session；
-全成功后原子采用processingResult；
-场景/链接/日期策略变更通过持久signature在run/export重新核对；
- invalidate ACK丢失也不能让旧result导出；
- Worker crash后会话丢失，用户重新导入；不从已发布文件猜测session。

## 6. Duplicate 行为规格

### 6.1 Startup 顺序

固定为：

```text
Platform startup recovery scan
→ independent read-only Duplicate inspector
→ persist inspection outcome / Recovery Hold
→ approved compensation or expiration
→ construct DuplicateInboundMatchService
```

禁止先构造Service触发`clearAll()`后再inspect。

### 6.2 Import / run

- 新import一经接受，旧session/lastRun资格立即失效；
- paired parser只读两类文件并写spool；Service在reservation内单事务采用；
- 新run先失效lastRun和mirror资格，再串行group/MPT/document candidate消费；
- side store和main mirror记录同一operationKey；
- MPT snapshot变化使lastRun stale；
- export只使用当前generation且持久证据一致的lastRun。

### 6.3 Crash recovery

- side commit、mirror未完成：`partially-committed`，不得重新匹配；
- recovery coordinator可根据side receipt补建mirror，或创建hold；
- committed但内存session/lastRun丢失：Task可能interrupted，用户重新导入/重建view；不得重复mutation；
- compensation必须有持久审计，不在constructor中隐式执行。

## 7. BankBU 行为规格

### 7.1 Import

- Pending与Bank reader可并行，但Writer按固定角色顺序接收；
-两者都成功才进入月侧库事务；
- clear pending/bank/runs + insert pending then bank + operation receipt同事务；
- reader失败发生在事务前；
- source row index、month、BU、账号和原始顺序不变。

### 7.2 Run

- match key只trim；BU trim+lowercase；
- 1:1、1:N、N:1 matched；N:M写异常sheet且run可success；
- side run先COMMIT并保存operationKey；
- main mirror再COMMIT并保存operationKey+sideRunId；
- side有、mirror无是partial，不重新运行算法；
- recovery只补镜像或进入hold。

### 7.3 Export

单月/汇总按既有dual-source读取，月份、included/skipped、异常Sheet和对外runId不变。Worker写staging，Main发布。


### 7.4 同月重跑恢复合同

进入 critical 前，Main 必须在 operation lock 内读取并持久化当前月份主 mirror pre-image：

```text
expectedPreviousMirror = absent
或
expectedPreviousMirror = { mirrorId, sideRunId, operationKey, status, stableHash }
```

新 side run receipt 与新 main mirror 均写本次 `operationKey`；新 mirror 还必须写 `sideRunId`。Inspector 使用下表判定：

| 新 side receipt | 当前 main mirror | commitState / recovery |
| --- | --- | --- |
| 不存在 | 等于 captured pre-image | `not-committed` |
| 存在且完整 | 等于本次 `operationKey + sideRunId` | `committed` |
| 存在且完整 | 等于 captured pre-image，包括旧 mirror 仍存在 | `partially-committed`；只允许 `complete-mirror` |
| 不存在 | 不等于 captured pre-image | `unknown` + Recovery Hold |
| 存在 | 既非 pre-image 也非新 post-image | `unknown` + Recovery Hold |

`complete-mirror` 只能使用已提交的 side run 结果做 CAS 补镜像；禁止重新运行 1:1 / 1:N / N:1 / N:M 算法。⚠️ 该 inspector、pre-image canonicalizer 和补镜像 CAS 是资金恢复红线，生产启用前必须人工复核“无旧 mirror / 有旧 mirror / mirror 并发变化”三类样本。

## 8. Receipt / Inspector

### Duplicate

Inspector检查：

- side operation receipt；
- main mirror operationKey；
- MPT snapshot和run status；
- compensation/expiration审计。

输出 committed/not-committed/partially-committed/compensated/unknown。

### BankBU

- import：月库operation receipt是单事务证据；
- run：side run operationKey + main mirror(sideRunId, operationKey)；
- side无/mirror无 → not-committed；
- side有/mirror同identity → committed；
- side有/mirror无 → partially-committed；
- mirror无对应side或identity冲突 → unknown。

## 9. 资源与性能

- FundRecon/Duplicate Service持有BaseLease；
-正式session/result采用PersistentReservation；
- Duplicate paired parser先reserve Service command，再原子申请CompoundLease；
- BankBU dual parser使用CompoundLease；
- pure compute phase释放I/O lease；
- paired/dual parser大型样本提升<15%或RSS超预算时effectiveWorkerCount=1；
- single Worker隔离不承诺端到端加速，只要求event-loop改善和small regression≤5%。

## 10. 验收与测试

- Service generation/revision/busy/close/crash；
- FundRecon全轮次golden、候选消费和失效矩阵；
- Duplicate startup顺序探针，证明inspector先于constructor；
- Duplicate side/mirror crash windows和candidate lineage；
- BankBU import atomic overwrite、四种基数、normalize、dual source；
- BankBU side/mirror partial recovery；
- paired/dual parser乱序完成但业务顺序不变；
- artifact全有或全不发布；
- app quit protected映射interrupted；
- Windows native SQLite、RSS、连续十轮和人工资金复核。

## 11. PR 顺序

| PR | 内容 | 门禁 |
| --- | --- | --- |
| E06-P0 | Service resource framework + receipt probes | startup顺序、schema决定 |
| E06-A | FundRecon Service | 全轮次golden、RSS |
| E07-A | Duplicate startup coordinator + single Service | inspector先于compensation |
| E07-B | Duplicate receipt/mirror recovery | crash windows、资金复核 |
| E07-C | optional paired parser | 15%/RSS |
| E08-A | BankBU single job import/run/export | side/main identity |
| E08-B | optional dual parser | 等价/性能 |
| R3.2.2 | Windows、人工、策略快照 | action独立enable |

## 12. 强制 BLOCK

- Duplicate inspector未能在Service构造前完成；
- Duplicate side/mirror无共同operation identity；
- BankBU mirror未保存sideRunId/operationKey；
- 任一inspector不能唯一返回状态；
- matched/candidate/golden出现顺序漂移。

这些BLOCK不阻止FundRecon纯内存Service或BankBU只读export独立上线。

## 13. 资金红线

⚠️ FundRecon first-match、同值no-op、回填/标黄；Duplicate BizId/MPT/document lineage和候选消费；BankBU 1:N/N:1/N:M、BU normalize、side/main run identity必须真实样本人工复核。partial/unknown不得自动重跑。
