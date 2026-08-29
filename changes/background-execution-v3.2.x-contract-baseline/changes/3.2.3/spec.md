# v3.2.3 Spec — Statement 交互式大状态 Service 与 NewAccount 单 Worker

| 项目 | 内容 |
| --- | --- |
| 目标版本 | v3.2.3 |
| 日期 | 2026-08-21 |
| 状态 | Implementation Ready / Statement import/generation 可推进，manual seed 受独立门禁 |
| 实施前置 | 进入本版本编码前，v3.2.0 E02-A～C2 必须已合并并通过 platform canary |
| 配套 TechDoc | `changes/3.2.3/techdoc.md` |
| 涉及范围 | Statement Service/tokens/waiting-user/current-all generation/manual balance seed；NewAccount generation/export copy |

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

本版本只处理两类相邻但风险可控的能力：

- Statement：长驻 Service 唯一持有大量映射行、批次、交互上下文和生成状态；用户交互使用受内存预算约束的 opaque token；
- NewAccount：单工作簿生成进入 one-shot Worker；另存为采用 `inline-async`，不为纯复制启动 Worker。

ReconFix、VCC Financial OP、成熟 adapters 和最终 coverage 已移至 v3.2.4/v3.2.5。

### Done when

- token返回Renderer前已成功申请PendingInteractionReservation；
- outstanding重型token数量、TTL、总字节和释放可证明；
- waiting-user期间CPU/I/O lease和业务锁释放，continuation重新获取并复核evidence；
-主进程不持有detailRows/prepared batch等大状态；
- manual balance seed使用临时文件、fsync、原子rename、pre/post hash和inspector；
- current/all、四金额模式、余额、多币种、warning、输出与旧路径等价；
- NewAccount生成/复制不阻塞主线程且结果等价。

## 3. Action 级范围

| actionKey | currentDisposition | targetDisposition | mode | lifetime | adapterKind | commit.kind | production.enabled（代码合并时） | 说明 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `statement:import` | `legacy-preserved` | `managed` | `thread-single` | `service` | `native` | `none` | `false` | 大状态仅在 Service；资源 grant 后采用 |
| `statement:resolve-big-account` | `legacy-preserved` | `managed` | `thread-single` | `service` | `native` | `none` | `false` | pending token 单次消费 |
| `statement:resolve-manual-balance` | `legacy-preserved` | `managed` | `thread-single` | `service` | `native` | `main-settlement` | `false` | 每个 interactionOrdinal 独立 operationKey；文件 post-image inspector |
| `statement:generate-current` | `legacy-preserved` | `managed` | `thread-single` | `service` | `native` | `main-settlement` | `false` | current batch 稳定顺序 |
| `statement:generate-all` | `legacy-preserved` | `managed` | `thread-single` | `service` | `native` | `main-settlement` | `false` | 全 session 稳定顺序 |
| `new-account:generate` | `legacy-preserved` | `managed` | `thread-single` | `job` | `native` | `main-settlement` | `false` | 模板/日期/币种 golden |
| `new-account:save-as` | `inline-excluded` | `managed` | `inline-async` | `job` | `native` | `main-settlement` | `false` | 异步复制 staging 后 Publisher |


## 3. Statement 状态所有权

Worker唯一持有：

- statementImportSessions；
- fileEntries/detailRows/rowMeta/issues；
- batches/currentBatchId；
-大账号选择上下文；
- manual balance prepared context；
- current/all generation context；
- stable summary和artifact metadata。

主进程只持：serviceGeneration、sessionRevision、opaque token、小型DTO、FilePlan、TaskLifecycle和正式artifact handle。

## 4. Pending interaction reservation

### 4.1 创建顺序

```text
Worker完成候选draft
→ 估算private context footprint
→ Main/Service申请PendingInteractionReservation
→ 成功后写token store
→ 返回token + bounded DTO
```

禁止先保存大draft/返回token后再计费。

### 4.2 限制

初始生产策略：

- 每个Statement Service最多1个重型未完成token；
- token TTL由Registry固定；
- token单次消费；
-总PendingInteractionReservation有硬预算；
-新import/session mutation使旧token stale并释放reservation；
- expiry、cancel、service crash、app quit均释放；
- Renderer不能延长TTL或回传rows。

## 5. waiting-user 生命周期

TaskRun保持`running`，phase=`waiting-user`，不是新的持久终态。

等待期间：

-释放PhaseLease的CPU/I/O部分；
-保留PendingInteractionReservation；
-释放业务operation lock；
-UI可显式取消，证明无持久提交时Task cancelled；
- unexpected app quit落interrupted并清内存token；
- continuation重新获取业务锁，并重新核对serviceGeneration、sessionRevision、模板/mapping、source evidence；
-任一变化返回stale，不继续采用draft。

## 6. Statement 业务不变量

保持：

- direct debit/credit、signed split、field-conditional split、bill split/merge四金额路径；
-零发生额、双非零拒绝；
-模板parent/child、固定赋值、Merchant/大账号；
-币种映射、多币种余额；
-current仅currentBatchId entries，all为全部entries稳定顺序；
- amount/bill split warning、manual balance required、error report；
-新import/remove/prune后的artifact qualification失效。

## 7. Manual balance seed

seed是文件持久mutation，不是纯内存命令。主进程执行：

```text
读取target pre snapshot/hash
计算expected post bytes/hash
若pre==post：返回noop，不创建intent
MainSettlementIntentCoordinator持久化Main-owned intent prepared/acked
（不发送Worker critical:ready/critical:ack）
写同目录临时文件
fsync temp
rename原子替换target
fsync directory
回读post hash
回读并记录target-post-image observation：命中expected post时mark committed，仍为pre时仅从prepared/acked mark recovered
通知Service继续生成并完成main settlement
```

Inspector：

- current hash == expected post hash → committed；
- current hash == pre hash → not-committed；
- 其它 → unknown + Recovery Hold。

seed提交成功但Service crash时，不能重复写seed；Task可interrupted，用户重新进入生成时先读取已提交seed。

### 7.1 多次 manual-balance operation identity

一个 TaskRun 可顺序出现多个 manual-balance prompt。Main 必须持久分配 `interactionOrdinal=1..N`：

```text
operationKey = derive(
  taskRunId,
  'statement:resolve-manual-balance',
  interactionOrdinal
)
```

同一个 token 的 transport recovery 复用同一 ordinal/operationKey；新的 token/账户 seed 必须使用新 ordinal。不得为整个 Task 复用一个 continuation operationKey。

Policy 固定为 `main-settlement + target-post-image + criticalIntent=true`。权威提交证据是目标 seed 文件的 durable post-image；Main-owned Critical Intent 只保存 pre/post 期望和 operation identity，不替代 post-image inspector，也不走 Worker critical handshake。

## 8. Current / all generation

Worker根据token/revision选取entries，顺序生成所需detail/balance artifacts。全部业务校验通过后返回manifest；Main做technical validation和Publisher。多artifact全有或全不发布。

Main publication 必须另持有 bounded expected artifact descriptor，按冻结顺序把
artifactKey/kind/task staging resource 与 FilePlan 绑定，并回读核对 sheet、精确 headers、
行守恒、有序记录以及日期/账户/币种/金额、cell type/format/style、watermark/template lineage
的摘要证据。该 descriptor 不由 Worker manifest 自报，也不得包含 raw rows/prepared batch。
task staging root、每级现存祖先和最终文件必须通过非 symlink、realpath/inode/平台 alias
归属验证；technical validation、默认 Publisher 前复核和 restart cleanup 使用同一规则。
未通过归属验证的 manifest 路径不得驱动清理。

Service crash后：

-内存session/token清空；
-已正式发布历史文件保留但不恢复session；
-未发布staging清理；
- committed seed按inspector保留，不回滚猜测。

## 9. NewAccount

- Main做payload大小/schema和FilePlan；
- Worker复用单一generation core完成必填、日期、10年/昨日边界、账户/币种、记录和文件名；
- Worker读取白名单模板，写一个staging workbook并回读；
- Main在dispatch前只从冻结payload/asOf/template异步分批推导out-of-band expected authority；每个bounded batch必须让出event loop并检查Task cancel/app-quit signal，取消时不得spawn Worker或留下staging。该authority冻结精确Sheet集合、完整列schema、expected used/dimension range、rowCount与业务digests，不信任Worker result/manifest；
- Main authority readback拒绝任何越过冻结列/range的cell（含styled blank）、merge或dimension，并在Publisher前拒绝formula cached、calcChain、external link、hyperlink等打开后可改变业务语义的动态内容；合法trusted writer纯值workbook与legacy raw oracle/golden不变；
- `new-account:save-as`只消费Main当前进程已brand的normalized FilePlan authority，禁止再次normalize/resnapshot；copy前、handoff前、Publisher前均对用户确认时的同一source/target snapshot复核，absent后出现未知文件或existing被替换均fail closed；
- Main在dispatch前只从冻结payload/asOfDate/模板证据构造bounded expected artifact；Worker result/manifest仅是untrusted observation。Main回读必须核对精确Sheet顺序/数量、列、记录数及日期/账户/币种/records digests，再发布到managed location并保存小型artifact handle；
-另存为用异步复制到staging、校验source identity/snapshot/hash与副本identity/size/hash，再Publisher到用户目标；Publisher必须保留既有archive-handoff journal，Task artifact durable settlement完成且Task终态持久化后才ack清理。committed后丢回包/崩溃只从同一journal恢复settlement，不重复generation/copy/publish；
- `inline-async` transport的close/terminate必须有界等待实际execution结算；deadline内未收口必须报告transport leak/cleanup evidence并保留cleanup owner，不得提前释放后宣称leak=0；
-不建立池，不宣称多核加速。

## 10. 验收标准

- 主进程heap探针不含detailRows/prepared batch；
- token创建前reservation成功；数量、TTL、expiry/replay/stale/crash测试；
- waiting-user锁/lease释放与continuation重验证；
-四金额模式、余额、current/all和workbook golden；
- seed no-op、COMMIT后回包前crash、pre/post/unknown；
- NewAccount日期/币种/命名/模板等价；
- copy source变化时fail closed；
- event-loop delay、RSS、Windows长驻Service/app quit通过。

## 11. PR 顺序

| PR | 内容 | 门禁 |
| --- | --- | --- |
| E09-P0 | Statement state footprint/token/现状golden | DTO与资源模型冻结 |
| E09-A | Service import/session/revision | 无大状态回Main |
| E09-B | pending interaction + waiting-user | reservation/TTL/lock |
| E09-C | current/all generation | workbook等价/all-or-none |
| E09-D | manual seed atomic settlement/inspector | crash恢复 |
| E10-A | NewAccount generation core/Worker |业务golden |
| E10-B | async copy/Publisher | source/target evidence |
| R3.2.3 | Windows、RSS、人工复核 | action独立enable |

## 12. BLOCK / Unknowns

-现有manual seed业务文件格式和调用顺序必须由golden锁定；
- waiting-user期间是否保留TaskRun同一ID已在本版固定，Renderer适配需验证；
-最大session/token内存预算由批准真实样本probe，不允许Renderer配置；
-若Statement必须跨重启恢复session，转后续版本，不在本版暗中持久化。

## 13. 资金红线

⚠️ Statement金额模式、借贷方向、余额seed、币种和current/all；NewAccount日期、账户、币种和输出记录必须人工复核。seed状态unknown时不得自动覆盖或继续生成。
