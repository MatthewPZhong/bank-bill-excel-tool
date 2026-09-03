# v3.2.5 TechDoc — Read-only Export Executors、Existing Dispatcher Adapters 与 Coverage Closure

| 项目 | 内容 |
| --- | --- |
| 目标版本 | v3.2.5 |
| 日期 | 2026-08-21 |
| 状态 | Implementation Ready / action 不合格则保持 legacy/blocked |
| 实施前置 | 进入本版本编码前，v3.2.0 E02-A～C2 必须已合并并通过 platform canary |
| 产品 Spec | `changes/3.2.5/spec.md` |
| 涉及范围 | 模块专用导出Workers、Acquiring分类、成熟adapters、manifest/AST coverage、生产策略快照 |

## 0. 规范性技术依赖

本 TechDoc 直接实现 Platform Contract v1，不另起协议方言。所有消息使用 Protocol v1 的 canonical operation：

```text
job:start
unit:start
unit:done
unit:error
critical:ready
critical:ack
critical:reject
commit:receipt
job:done
job:error
job:cancel
cancel:ack
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

## 1. 目录

```text
src/main-process/background-execution/
├── action-manifest.js
├── coverage-check.js
├── capability-inventory.js
├── production-strategy-snapshot.js
└── adapters/
    ├── big-table-engine-adapter.js
    ├── acquiring-adapter.js
    └── position-utility-adapter.js

src/main-process/read-only-exports/
├── pending/
├── biz-op/
├── pre-fund/
├── position/
├── vcc-financial-op/
└── acquiring/
```

每个模块目录有自己的query、writer、business-validator和worker entry；公共目录不包含业务SQL或Workbook规则。

`position:export-run` 属于本节的模块专用 native read-only executor。仓库中没有可复用的 Position export dispatcher；第 5 节 Position utility-process adapter 仅适用于 `position:import`（E13-F），不得把 import dispatcher、虚构的 compound topology 或外层套 Worker 代替真实 export 拓扑。

## 2. Read-only executor contract

Worker输入：

```javascript
{
  actionKey,
  operationKey,
  taskRunId,
  stableRunEvidence,
  dbPathOrManagedSource,
  generationPlan,
  context
}
```

Worker：

- read-only打开DB/文件；
-验证run/dataset/revision/status；
-调用模块专用query/sort/writer；
-写FilePlan staging；
-执行业务回读；
-返回artifact manifest；
-finally关闭DB/fd。

Main：technical validator、source/target snapshot、Publisher、archive和Task settle。

## 3. Stable run gate

每个导出action必须定义：

-可导出的持久status；
- runId/datasetId/revision；
-参与 Workbook 语义的模板或受管归档文件 SHA-256/byteSize authority；Main 与 Worker 均须复核，不能只冻结路径；
- partial/interrupted/expired/stale的拒绝规则；
- Recovery Hold conflict scope；
- dual-source历史兼容；
- export metadata何时更新（仅Publisher成功后）。

只读并不意味着可忽略提交状态。unknown/partial run必须fail closed。

## 4. Acquiring classification

构建时Action Manifest分别注册copy和regenerate，不在同一handler中由文件大小/按钮名称动态更换mode。

Copy executor：

```text
verify managed source handle/hash
→ fs.promises copy to task staging
→ verify copy
→ Publisher
```

Regenerate executor：

```text
read stable run DB
→ module writer
→ staging
→ business validator
→ Publisher
```

Current-tree authority：`acquiringBillCurrency:export` 的 source 是已发布 `diff_file_path`，只走
copy executor；它不能在文件缺失时静默转为 regenerate。Regenerate executor 作为独立、
production-disabled capability 注册，输入必须显式携带 stable completed run DB authority；当前没有
独立 IPC/button，故不与任何 legacy TaskPolicy 绑定。`partial`、`in-progress`、`data-complete`、
progress 缺失/破坏或 source 漂移全部 fail closed。

## 5. Existing dispatcher adapter interface

```javascript
createExistingDispatchAdapter({
  adapterKey,
  describeTopology,
  start,
  cancel,
  close,
  mapEvent,
  inspectOutcome
})
```

`describeTopology()`在admission前返回childrenMax、worker/process slots、memory/I/O profile，供CompoundLease。Adapter的start调用原dispatcher，不new Worker。

### Big table

- root engine Worker + N parser children；
-保留fileIndex reducer/单Writer/大事务；
- existing cancellation边界映射cancel:ack；
-事务不确定调用模块inspector。

### Acquiring

- import pool、runCheck pool、eligible multiworker、single/resume不变；
- adapter读取现有workerCount/chunk/temp预算；
- `unit:done`只做child metrics；parent terminal来自原dispatcher；
- idle cleanup与DB busy保护不变。

### Position

- mode=`utility-process`；
- adapter映射现有prepare/apply/grant/critical/commit/cancel；
- utilityProcess不可用时的child_process fallback仍由原dispatcher决定；
- protected committing不映射cancelled；
- journal/ledger是`existing-critical-protocol`证据。

## 6. Action Manifest / AST gate

推荐每个注册点：

```javascript
registerBusinessAction({
  actionKey,
  handler,
  filePlanKey,
  inventoryOwner,
  artifactKeys,
  inspectorKey
});
```

Build script加载模块导出/AST验证，而非执行业务代码。输出：

```json
{
  "handlers": [],
  "filePlans": [],
  "inventory": [],
  "registry": [],
  "inspectors": [],
  "publishers": []
}
```

Gate检查集合差、重复actionKey、非法mode/commit、blocked却enabled、worker-durable缺inspector、service缺资源、artifact缺Publisher。

## 7. Production snapshot

由Registry + benchmark evidence + feature flags在release构建时生成，不由人工复制表格。示例：

```json
{
  "actionKey": "vcc-financial-op:export-result",
  "capabilityMode": "thread-pool",
  "effectiveMode": "thread-pool",
  "effectiveWorkerCount": 1,
  "downgradeReason": "subject-filter-benchmark-below-threshold",
  "recoveryStatus": "main-settlement-journal-ready",
  "legacyAvailable": true
}
```

发布说明从snapshot提取，防止“代码有pool”被写成“生产已启用多核”。

## 8. Recovery Hold enforcement

所有mutation handler（包括legacy）在获取业务锁后、开始mutation前调用：

```javascript
assertNoRecoveryHold(conflictScopeKey)
```

只读导出可按策略读取hold：

-如果hold意味着run状态不确定，拒绝；
-如果hold与导出stable run无关，可允许但必须由action policy明确；
-绝不能用一次成功导出自动关闭hold。

## 9. Fault / regression tests

- read-only Worker source/run revision变化；
- artifact tamper/Publisher crash；
- adapter extra-spawn topology assertion；
- old dispatcher done/error/exit race；
- compound lease accounting与queue cancel；
- Position protected quit；
- Acquiring resume/multiworker gates；
- coverage新增/删除action fixture；
- snapshot capability/effective mismatch gate；
- Windows Setup/portable、event-loop/RSS、release-check。

## 10. Release evidence

每个action形成：

```text
baseline fixture id
new/old semantic comparison
DB/read evidence
workbook comparison
fault injection result
resource metrics
Windows result
manual review
production decision
```

不允许用模块级“通过”覆盖action级blocked。

## 11. Rollback

- adapter可从新job开始切回原dispatcher直接入口；
- active job不切换；
- read-only executor可回legacy，不影响run数据；
-已发布artifact按Publisher/journal处理，不自动删除；
-coverage/Inventory文件保留，即使action回legacy；
-legacy seam删除另开版本。
