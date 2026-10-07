# TechDoc — v3.2.12 业务 OP 升级阻断启动修复

<!-- document-identity
 document-id: v3.2.12-fix-bizop-upgrade-startup/techdoc
 target-version: v3.2.12
 branch: fix/bizop-upgrade-startup
 baseline: 52b92b55c3d91f7a431ff62419e8712a6ed1774e
 revision: R2
-->

> status: review（R2 已实施，本地门禁通过；Windows 正式包验收待 CI，见[实施记录](implementation-notes.md)）
> created: 2026-10-06 · updated: 2026-10-06 · 文档修订：R2
> 目标版本：v3.2.12 · 功能分支：`fix/bizop-upgrade-startup` · 固定设计基线：`main@52b92b55`（= `v3.2.11`）
> 依据：[Spec](spec.md) · [基线证据](baseline-evidence.md) · [实施记录](implementation-notes.md) · [复现工具](evidence/repro-harness/README.md)
> 本文中的新增函数、字段、常量和文案都是**拟定设计**，不是现有实现。
>
> **R2 修订**（2026-10-06，依据评审意见，已逐条核实，见 [S13](baseline-evidence.md#s13)–[S15](baseline-evidence.md#s15)）：
> 1. F1 诊断拆成两类事实：“判定记录”在判定时采集，用来判断阻塞原因；“拒绝后现场”在错误处理时采集，只作辅助并明确标注。
> 2. post-outbox 入口的失败也透传明细。
> 3. G1 旧格式回归纳入持续门禁。
>
> 改动范围相应扩大到内存准入、调度器、存档控制器和 Windows 验收脚本；`admission-queue.js` 仍然不改。

## 一、Spec 评审意见（技术角度）

### 1.1 可直接复用

- `acquireBizOpPhaseLease`（`src/main-process/biz-op-v327/phase-admission.js:27-46`）已经实现 Spec F2 需要的全部语义：
  - 未装配内存准入时，固定预算不足直接拒绝；
  - `timeoutMs` 固定为 5000；
  - `RESOURCE_BUDGET_UNAVAILABLE` 映射为 `BIZOP_RESOURCE_BUDGET_INSUFFICIENT`，`ADMISSION_TIMEOUT` 映射为 `BIZOP_RESOURCE_WAIT_TIMEOUT`，其他错误原样抛出。

  它已被 5 个业务 OP 阶段使用，并有专门测试（`tests/unit/main-process/biz-op-v327-phase-admission.test.js`）。
- 调度器自带排队截止时间和取消（`admission-queue.js`）；装配了内存准入时，每秒重查一次（`resource-governor.js:101` 的 `memoryRecheckMs`）。不需要外层计时器。
- 以下两处可以作为“拒绝后现场”的数据来源，但它们不是判定时的现场（见 1.2）：
  - `inventoryForGovernor`（`background-execution/memory-activity.js:94-104`）：给出增长未知的活动清单，包括上一代 runtime 遗留的租约；
  - `governor.snapshot()`（`resource-governor.js:894`）：给出活动租约和队列。
- 两轮旧数据扫描本来就预留了“原 provider 补齐旧结构”的环节（`upgrade-main.js:124-137`，[S11](baseline-evidence.md#s11)）。

### 1.2 必须补齐的风险

- 改为排队后，`biz-op-v327-upgrade-resource.test.js` 第 91 行的用例（要求 1 秒内结算）会超时，需要改用假时钟调度器，写法见 `biz-op-v327-phase-admission.test.js:15-24`。
- `phase-admission.js` 新增的诊断会影响另外 5 个调用方的错误明细。只追加行，不改错误码，也不改已有行的顺序和内容。
- F3 只能放宽**第一轮**扫描。第二轮负责授权清理，必须保持严格。
- **（R2）拒绝原因在调度器内部就丢失了**：`evaluate` 和 `canAdmit` 只返回布尔值，立即拒绝和超时错误都不带候选额度和原因（[S14](baseline-evidence.md#s14)）。只在 helper 里补快照，超时路径拿不到实际候选额度，也拿不到判定原因。
- **（R2）helper `catch` 时的快照不等于判定时的现场**：到期拒绝与随后的授予在同一个同步循环里完成（[S15](baseline-evidence.md#s15)）。
- **（R2）post-outbox 入口的失败会丢掉全部明细**（[S13](baseline-evidence.md#s13)）。F2 生效后，失败点可能正好后移到这个入口。
- **（R2）G1 旧格式此前没有任何持续门禁覆盖**（[S11](baseline-evidence.md#s11)）。只靠单测和人工复现，不足以防止再次漏检。

### 1.3 与此前 startup-admission 方案（v2 文档）的对照

| 项目 | 此前方案 | 本分支 |
| --- | --- | --- |
| 诊断 | A 阶段：重构为结构化判定（`AdmissionDecisionV1`），改动调度器、内存准入、队列 3 个核心模块 | 内存准入和调度器增加可选的判定记录，只做记录，判定分支、返回值和错误码都不变；队列模块不改。helper 另附“拒绝后现场”并明确标注 |
| 有界等待 | A 阶段：`queue` + 5000 ms | 相同，直接复用现有 helper |
| 失败明细透传 | 未涉及 | owner 入口与 post-outbox 入口采用同一格式 |
| 启动恢复窗口 | B 阶段：挂起初始化、重试、安全退出协议 | 不做：对“每次必现”的用户无法恢复可用性，而且要改动启动和退出主链路 |
| 旧月度文件 schema | 未涉及（schema 错误按 fail-closed 处理） | F3：只放宽第一轮；G1 场景进入集成测试和 Windows 正式包验收 |
| 根因修复 | C 阶段：凭现场证据修复 | 相同，等 F1 诊断结果 |

## 二、涉及的文件清单

| 文件 | 功能点 | 改动 |
| --- | --- | --- |
| `src/main-process/biz-op-v327/upgrade-main.js` | F1、F2 | `acquirePrecheckCapacity` 改用 `acquireBizOpPhaseLease`；映射为外层错误，保留 `cause` 和 `detailLines`；修正文案 |
| `src/main-process/biz-op-v327/phase-admission.js` | F1 | `capacityError` 追加“判定记录”和“拒绝后现场”两组明细；新增内部函数 `decisionDetailLines(cause)`、`pressureDetailLines(governor)` |
| `src/main-process/background-execution/memory-admission.js` | F1 | `evaluate` 增加可选参数 `trace`，在每个拒绝分支写入原因码和相关数值；返回值和判定逻辑不变 |
| `src/main-process/background-execution/resource-governor.js` | F1 | `canAdmit` 透传 `trace`，并补上自身的拒绝原因；`acquireExact` 为每个申请保留最后一次判定记录；立即拒绝、排队中拒绝、排队超时这三处错误在 `details.decision` 中附上该记录 |
| `src/main-process/archive-center/controller.js` | F1 | post-outbox 钩子失败时，按 owner 入口的格式透传 `detailLines` 和 `recoveryPaths`（第 453–462 行） |
| `src/main-process/biz-op-v327/upgrade-legacy.js` | F3 | 新增常量 `LATER_SIDE_TABLES`；调整 `validateSchema` 第 73 行的判断 |
| `tests/unit/main-process/background-execution/memory-admission.test.js` | F1 | 每个拒绝原因码及数值；三处错误都带 `decision`；与队首同时到期时记为“未轮到”；错误码和消息不变。用该文件已有的内存准入夹具，原计划放在 `resource-governor.test.js` 的用例也合并到这里 |
| `tests/unit/main-process/archive-center-controller.test.js` | F1 | post-outbox 失败时透传明细；`code`、`cause` 不变 |
| `tests/unit/main-process/biz-op-v327-upgrade-resource.test.js` | F1、F2 | 更新第 84–85 行的断言；用假时钟重写第 91–113 行的用例；新增生产内存策略用例，以及两个入口经 `reportStartupFailure` 的弹窗和日志用例 |
| `tests/unit/main-process/biz-op-v327-phase-admission.test.js` | F1 | 增加诊断行断言；已有断言不变 |
| `tests/unit/main-process/biz-op-v327-upgrade.test.js` | F3 | 新增旧格式月度文件的校验用例和端到端升级用例 |
| `tests/fixtures/biz-op-v327-legacy-side-ddl-v3.1.10.sql`（新增，沿用该目录 `biz-op-v327-*` 的平铺命名） | F3 | 从 `git show v3.1.10^{commit}:src/backend/run-data-store.js` 的 `SIDE_DB_DDL_BIZ_OP` 原样提取；v3.0.13–v3.1.10 的该语句完全相同 |
| `tests/helpers/biz-op-v327-upgrade.js` | F3 | 新增 `seedLegacyG1Month`：用夹具 DDL 建旧格式月度文件，并写入少量行。原 `seedLegacy` 不变 |
| `scripts/integration/biz-op-legacy-side-db-upgrade.js`（新增） | F3 | G1 集成回归，纳入 `npm run test:integration`（`release-check` 的一部分） |
| `scripts/biz-op-v327/verify-windows-app.js` | F3 | 在原有 G2 种子之外再加一个 G1 月度文件，断言它被回收 |

**明确不改**：
- `admission-queue.js`：排队、超时、取消的语义都不变；
- 各处判定分支、返回值和错误码；
- `src/main.js` 对 `resource-rejected` 的日志过滤：启动失败记录已经包含全部 `detailLines`，见 `startup-failure.js:46-66`；
- `src/backend/startup-failure.js`：不改成递归读取 `cause`，由控制器在包装处透传（§3.4）。

## 三、F1 诊断合同

### 3.1 两类事实

| 类别 | 采集时点 | 来源 | 用途 |
| --- | --- | --- | --- |
| 申请参数 | — | `request`、`snapshot.budgets` | 已有的 4 行，不变 |
| **判定记录** | 调度器每判定一次本申请就更新一次，产生错误时冻结 | 错误的 `details.decision` | 判断阻塞原因 |
| **拒绝后现场** | helper 的 `catch` 中 | `inventoryForGovernor(() => governor)`、`governor.snapshot()`、`os.freemem()` | 辅助判读；可能已经变化，明细中如实标注 |

阻塞原因只依据判定记录。拒绝后现场可能和判定时不同（[S15](baseline-evidence.md#s15)），因此不能单凭它下结论。

### 3.2 判定记录

`acquireExact` 为每个申请建一个记录对象，在 `enqueue` 的立即判定和每次 drain 判定中更新：

```js
// 拟定字段（数值为 x64 上有一个未退出载体时的示例）
details.decision = Object.freeze({
  attempts: 5,          // 本申请被判定的次数；0 表示一直没有轮到它
  queuedAhead: 0,       // 进入队列时前面已有的排队数；立即判定时为 0
  lastElapsedMs: 4000,  // 最后一次判定距申请开始的毫秒数
  candidates: [         // 最后一次判定中各候选的结果，顺序与候选一致
    { mode: 'normal', memoryBytes: 402653184, reason: 'unbounded-growth',
      facts: { lease: 0, carrier: 1, main: 0, previousRuntime: 0, other: 0 } },
    // 低内存档要求独占，遇到任何重型外部活动先按 heavy-active 拒绝（memory-admission.js:105）
    { mode: 'low', memoryBytes: 134217728, reason: 'heavy-active' }
  ]
});
```

记录附在以下三处错误上：
- 立即拒绝：`unavailable(prepared, { decision })`，`resource-governor.js:424`；
- 排队中按 `reject` 拒绝：`resource-governor.js:459`；
- 排队超时：在 `enqueue` 的 `.catch`（`resource-governor.js:449`）中，对 `ADMISSION_TIMEOUT` 用 `details` 加上 `decision` 后的新冻结对象替换原 `details`。

三处都保持原有的错误类型、`code` 和 `message`，只是 `details` 多了一个字段。生产调用方都只按 `code` 判断（`main.js:20477`、`supervisor.js:1691`、`service-host.js:1164`、`toolbox-split-read-owner.js:72`、`toolbox-row-split/service.js:121`、`vcc-financial-op-result-workbook-runner.js:34`），不受影响。

原因码：

| `reason` | 写入位置 | 明细文案 | 附带数值 |
| --- | --- | --- | --- |
| `stable-limit` | `acquireExact` 跳过稳定上限放不下的候选（`resource-governor.js:478`） | 超出稳定上限 | 上限 |
| `evaluation-busy` | `canAdmit` 发现正在判定中（`resource-governor.js:189`） | 内存判定重入 | — |
| `slots` | `canAdmit` 的 `canAdd`（`:190`） | 槽位或固定预算已占满 | — |
| `memory-limit` | `canAdmit` 的额度检查（`:192-193`） | 内存额度已占满 | 已用、本次、上限 |
| `low-mode-active` | `evaluate`（`memory-admission.js:97`、`:100`） | 有低内存档任务在执行 | — |
| `heavy-active` | `evaluate`（`:98`、`:105`） | 低内存档需要独占，但有其他重任务 | — |
| `inventory-incomplete` | `evaluate`（`:102-104`） | 活动清单未封存或无效 | — |
| `unbounded-growth` | `evaluate`（`:107-108`） | 存在增长未知的活动 | 按来源计数：未登记租约、载体、主进程活动、上一代 runtime |
| `system-memory` | `evaluate`（`:124-125`） | 系统可用内存不足 | 判定时的采样值；需要量 = 本次 + 预留 + 未兑现增长 |

`evaluate` 中抛出的异常（采样无效、证据无效）不属于“拒绝”，仍按原样向上抛出，不写入记录。只有调用方传了 `trace` 时才会计数；不传时与现状的执行路径相同。

### 3.3 明细格式与示例（拟定）

示例场景：x64，一个未退出载体，等待超时。

```text
biz-op-v327：[BIZOP_ACTIVATION_RESOURCE_UNAVAILABLE] 业务 OP 升级等待后台资源超过 5 秒，升级尚未开始；现有迁移检查点已保留。请将本窗口截图发送给技术支持。
内部原因：BIZOP_RESOURCE_WAIT_TIMEOUT
动作：biz-op-v327:upgrade-preflight
内存：需要 1024.0 MiB，本次预算 4096.0 MiB，当前剩余 4096.0 MiB
CPU / Worker / I/O 槽位：需要 1 / 1 / 1，本次预算 4 / 5 / 2
本阶段尚未开始执行；未完成的任务和恢复记录继续保留。
判定记录：共判定 5 次，最后一次在第 4.0 秒，入队时前方 0 项（上方“需要”是兼容请求额度，下面是实际候选）
· 普通档 384.0 MiB：存在增长未知的活动（未登记租约 0 / 载体 1 / 主进程活动 0 / 上一代 runtime 0）
· 低内存档 128.0 MiB：低内存档需要独占，但有其他重任务
拒绝后现场（错误处理时采集，可能已变化）：增长未知活动 载体 1 / 主进程活动 0 / 上一代 runtime 0，清单已封存；活动租约 0 项；排队 0 项；系统可用内存 5120.0 MiB
```

- 第 1 行由存档控制器生成；第 2 行由 upgrade-main 加在 helper 明细之前；第 3–6 行是 helper 已有的行，不变；其余为新增。
- 活动租约多于 0 项时，再加一行“拒绝后现场·活动租约”，列前 3 项的 `kind`、`actionKey`、执行档（已登记的 profileId，或“未登记”）和额度。
- 一直没有轮到本申请时，判定记录写成“等待期间一直没有轮到本申请（入队时前方 N 项）”，不列候选行。
- 稳定上限拒绝时，保留已有的“实际候选额度”行，再加一行“调度器原因：stable-limit（兼容上限 / 硬件上限 X MiB）”。
- 总计不超过 12 行，加上第 1 行也低于对话框的 20 行上限（`startup-failure.js:19`）。日志记录全部行，不截断（`startup-failure.js:49-66`）。

**阻塞租约的判读**：非 `base` 类型、执行档为“未登记”的租约，增长量未知，会让已登记执行档的申请被拒绝（`memory-admission.js:107-108`）。目标任务的 `base` 租约增长量为 0，不构成阻塞（`memory-profiles.js:84`）。明细只列事实，判读规则写在本节，不写进用户文案。

### 3.4 两个入口的透传

- **owner 入口**：控制器聚合时，已经把 `${ownerName}：[code] message` 和原错误的 `detailLines`、`recoveryPaths` 放到顶层（`controller.js:315-321`）。这里不改。
- **post-outbox 入口**：`controller.js:453-462` 改为同样的格式（示意）：

  ```js
  error.detailLines = [
    `${hook.hookName}：${cause && cause.code ? `[${cause.code}] ` : ''}${cause && cause.message || String(cause)}`,
    ...(Array.isArray(cause && cause.detailLines) ? cause.detailLines : [])
  ];
  error.recoveryPaths = [...new Set(Array.isArray(cause && cause.recoveryPaths) ? cause.recoveryPaths : [])];
  ```

  `code`、`message`、`hookName`、`cause` 都不变，`application-recovery.test.js:226` 等已有断言继续成立。这一改动对所有 post-outbox 钩子生效（例如 VCC 血缘校验）：它们失败时，弹窗也会多出原错误的明细，属于只增不减。
- 不改 `startup-failure.js`。递归读取 `cause` 会改变所有启动失败的展示方式，范围过大。

### 3.5 文案（拟定，可调整）

| 内部原因 | 外层 `message` |
| --- | --- |
| `BIZOP_RESOURCE_BUDGET_INSUFFICIENT` | 业务 OP 升级所需后台资源超过本次可用上限，升级尚未开始；现有迁移检查点已保留。请将本窗口截图发送给技术支持。 |
| `BIZOP_RESOURCE_WAIT_TIMEOUT` | 业务 OP 升级等待后台资源超过 5 秒，升级尚未开始；现有迁移检查点已保留。请将本窗口截图发送给技术支持。 |

不再写死“1024 MiB”，也不再笼统建议“关闭不需要的程序”。只有判定记录显示 `system-memory` 时，技术支持才据此建议用户释放内存。

### 3.6 隐私

判定记录和明细只包含 actionKey、资源向量、字节数、计数、执行档 ID 和原因码。不输出 ownerKey、operationKey、任务 ID、路径或业务数据。`recoveryPaths` 是原有的“人工恢复路径”区块，不属于本诊断，透传规则与 owner 入口一致。

## 四、F2 准入时序

### 4.1 调用改造（示意，非最终代码）

```js
// upgrade-main.js
const { acquireBizOpPhaseLease } = require('./phase-admission');

async function acquirePrecheckCapacity() {
  const runtime = host.getRuntime();
  if (!runtime?.resourceGovernor) fail('BIZOP_ACTIVATION_RUNTIME_REQUIRED');
  try {
    // 暂时占用最多排队 5 秒；不可能满足的申请由 helper 或调度器立即拒绝。
    return await acquireBizOpPhaseLease(runtime, { ownerKey: `biz-op-v327:precheck:${randomUUID()}`,
      actionKey: ACTION, operationKey: `biz-op-v327:precheck:${randomUUID()}`, resources: EXPORT_IO_RESOURCES });
  } catch (error) {
    if (!['BIZOP_RESOURCE_BUDGET_INSUFFICIENT', 'BIZOP_RESOURCE_WAIT_TIMEOUT'].includes(error.code)) throw error;
    throw activationResourceError(error); // code=BIZOP_ACTIVATION_RESOURCE_UNAVAILABLE，cause=error，detailLines=[内部原因, ...error.detailLines]
  }
}
```

两处调用方（续跑第 235 行、首次第 241 行）不需要改动：前者拿到租约后立即 `release`，后者在 `finally` 中 `release`。

### 4.2 各情形下的行为

| 情形 | 调度器 | helper 结果 | 对启动的影响 |
| --- | --- | --- | --- |
| 立即可批 | 授予租约 | 返回租约 | 无等待 |
| 未装配内存准入，申请超出固定预算 | 不进入调度器 | `BUDGET_INSUFFICIENT` | 立即失败（与现状一致） |
| 装配了内存准入，所有候选都超出稳定上限 | `assertStable` 立即抛 `RESOURCE_BUDGET_UNAVAILABLE`（`stable-limit`） | `BUDGET_INSUFFICIENT`，带 `cause` | 立即失败 |
| 暂时不满足（槽位、增长未知的阻塞项、系统内存、队列前序） | 入队；释放资源时触发 drain，有内存准入时每秒重查 | 获批，或 5 秒后 `WAIT_TIMEOUT`（带判定记录） | 最多多等 5 秒 |
| 取消、调度器关闭、内存采样或证据错误 | 原错误 | 原样抛出 | 与现状一致，不改写成资源错误 |

与现状相比的差别：原来队列非空时立即超时（`admission-queue.js:125-134`），被推迟的申请也立即拒绝（`resource-governor.js:422-425`）；现在这两种情况都改为最多等 5 秒。

### 4.3 与 v3.2.7 `biz-op-startup-resource-wait` 约束的关系

- 不在永远无法满足的预算上排队：由 helper 的预检和调度器的 `assertStable` 保证。
- 不用 `Promise.race` 加外层计时器：只用调度器原生的截止时间，超时项由队列移除，不会迟到授予。
- 授予后不因等待期限提前释放：预检租约照原逻辑，在磁盘和耐久检查之后才释放。
- `upgrade-main.js:203` 的注释（“启动阶段不能等待不可满足的固定预算；已有队列时 reject 仍会排队，必须同时限定等待时间”）要同步改成新语义。

### 4.4 启动时序上的风险

- owner 阶段的预检发生在 runtime 刚创建时，调度器为空（[S09](baseline-evidence.md#s09)），正常情况下会立即获批，不会等待。
- 首次升级的那次启动，post-outbox 阶段还会走续跑入口再预检一次（[S13](baseline-evidence.md#s13)）。这时其他 owner 可能还有发布 Worker 在收尾（S3 场景中都在 24 ms 内退出）。原来遇到这种时刻会立即失败，现在最多等 5 秒；失败时的明细由 §3.4 透传。
- 不会形成循环等待：其他 owner 的工作不依赖升级完成；即使出现，也会在 5 秒后以明确原因失败。

## 五、F3 两轮扫描与旧格式月度文件

### 5.1 现状时序（`upgrade-main.js:121-149`）

```text
MIGRATING
  ├─ validateSchema(主库)
  ├─ scan(quiescent=false)   ← 第一轮：只读检查路径与 schema（upgrade-legacy.js:73 在此拒绝 4 表文件）
  ├─ recoverLegacy           ← 原 provider：recoverRunReceipts 对每个月度文件调用 openSideDb → ensureBizOpReconTablesSupport
  └─ (quiesceOnly 返回)
LEGACY_QUIESCED
  ├─ flushLegacyOutbox / assertLegacySettled
  ├─ scan(quiescent=true)    ← 第二轮：严格检查，记录文件身份与哈希，授权清理
  └─ 清空主库旧表 → LEGACY_DB_CLEARED → 回收文件 → ACTIVE
```

### 5.2 改动（示意）

```js
// upgrade-legacy.js
// v3.1.11 起新增到月度文件的两张表；更早版本创建的文件缺少它们，由原 provider 在 recoverLegacy 中补齐。
const LATER_SIDE_TABLES = Object.freeze(['biz_op_recon_dataset_heads', 'biz_op_recon_month_end_copy_intents']);

// validateSchema 内，替换原第 73 行：
const missing = TABLES.filter((name) => !tables.includes(name));
if (side && missing.some((name) => quiescent || !LATER_SIDE_TABLES.includes(name))) fail('BIZOP_LEGACY_SCHEMA_INCOMPLETE');
```

### 5.3 为什么安全

- 第一轮本来只用于“允许原 provider 打开之前的只读检查”，它的结果不授权清理（`upgrade-main.js:124` 注释）。
- 以下检查全部保留：
  - 未知表（第 61 行）；
  - 外键（第 62–69 行）；
  - 未知触发器（第 70–72 行）；
  - `quick_check`（第 96 行）；
  - 文件身份与哈希（第 81–85 行）。
- 原 provider 补齐结构的效果已验证：v3.0.26 建的文件经当前 `openSideDb` 打开后，补齐了 2 张表、3 个 `archive_*` 列和 7 个触发器，原有行保留，两轮校验都通过（[S11](baseline-evidence.md#s11)）。v3.1.11 及以后的版本平时打开旧月份，走的也是这条路径。评审另用 v3.0.26 和 v3.1.10 的原始 DDL 做了内存实验，结论相同。
- 第二轮仍要求 6 张表齐全。原 provider 一旦没补齐，就照旧以 `BIZOP_LEGACY_SCHEMA_INCOMPLETE` 阻断（fail-closed）。

### 5.4 月度文件格式世代

| 世代 | 版本 | 表 | `biz_op_recon_runs.archive_*` | 触发器 |
| --- | --- | --- | --- | --- |
| G1 | v3.0.13–v3.1.10（本地可核对的标签） | 4 张 | 无 | 无 |
| G2 | v3.1.11 及以后 | 6 张 | 3 列 | 7 个 |

v3.0.13 之前的版本在本地没有对应标签，无法核对。如果存在缺少基础 4 表的更老格式，第一轮仍会按原规则失败，不会被误放行。

## 六、兼容、回滚与风险

| 风险 | 影响 | 处置 |
| --- | --- | --- |
| 判定记录改动了调度核心的两个模块 | 可能波及所有后台任务的准入 | 只加可选参数和记录，不改判定分支、返回值和错误码；现有 memory-admission、resource-governor 测试锁定原有行为，新增测试覆盖每个原因码 |
| 调度器错误的 `details` 多出 `decision` | 对 `details` 做整体比较的测试会受影响 | 生产调用方只按 `code` 判断（§3.2 列出 6 处）；实施时搜索测试中对 `details` 的整体比较并同步 |
| 拒绝后现场与判定时不同 | 判读出现偏差 | 明细标注“错误处理时采集，可能已变化”；原因只依据判定记录（§3.1） |
| post-outbox 钩子的失败弹窗多出明细 | 其他钩子（如 VCC 血缘校验）的弹窗变长 | 只增不减；20 行上限不变 |
| 启动最多多等 5 秒 | 预检排队时启动变慢 | 只在暂时不满足时发生；不可能满足时立即失败 |
| 其他 5 个阶段的明细变长 | 弹窗和日志多出约 4–6 行 | 只追加，不改错误码；用 phase-admission 测试锁定 |
| 原 provider 在 Windows 上补齐结构失败（句柄、WAL、杀毒） | 第二轮失败 | 保持 fail-closed；Windows 正式包验收包含 G1（§7.3），失败时明细由 §3.4 透传 |
| G1 文件补齐后才被第二轮哈希 | 第一轮与第二轮的文件身份不同 | 原设计如此：清理授权只使用第二轮的清单（`upgrade-main.js:137-147`） |
| 回滚到 v3.2.11 | 补齐过的月度文件，v3.2.11 能正常识别；已经 ACTIVE 的不再预检 | 无数据迁移，只回退源码 |

## 七、测试与验收

### 7.1 P0 必测

| 编号 | 场景 | 前置条件 | 预期 | 对应 |
| --- | --- | --- | --- | --- |
| T1 | 兼容预算不足（无内存准入） | 沿用 `biz-op-v327-upgrade-resource.test.js:73` 的用例：512 MiB 预算 | 立即失败；外层码不变；明细含 `BUDGET_INSUFFICIENT`；没有创建任务或迁移 intent | AC2.3、AC1.4 |
| T2 | 队列前序阻塞 | 假时钟调度器（`biz-op-v327-phase-admission.test.js:15-24`），加一个永远无法满足的排队请求 | 推进 5000 ms 后失败，内部原因 `WAIT_TIMEOUT`；判定记录为“一直没有轮到本申请（入队时前方 1 项）”；原排队项不变 | AC2.2、AC1.7 |
| T3 | 生产内存策略 + 存活载体 | `createExperimentalMemoryPolicy` 的 `inventory` 接 `inventoryForGovernor`；用 `observeMemoryCarrier` 登记一个载体 | 推进 5000 ms 后失败；判定记录中两个候选为 384 / 128 MiB：普通档原因为 `unbounded-growth`，来源计数为载体 1；低内存档原因为 `heavy-active`；拒绝后现场带标注。测试结束时发出 `exit`，清理全局活动表 | AC1.1 |
| T4 | 载体在等待期间退出 | 同 T3，在 2000 ms 时发出 `exit` | 下一次每秒重查时获批，升级继续 | AC2.1 |
| T5 | 稳定上限不足（有内存准入、未匹配资格） | 兼容上限 512 MiB；用 `createMemoryAdmissionPolicy` 构造未登记申请，避免 Windows x64 宿主上资格生效改变路径 | 立即失败；明细含 `stable-limit` 和实际上限 | AC1.2 |
| T6 | 旧格式文件第一轮通过 | 用夹具 `biz-op-v327-legacy-side-ddl-v3.1.10.sql` 建月度文件 | `validateSchema(side)` 通过；`validateSchema(side, quiescent)` 报 `SCHEMA_INCOMPLETE` | AC3.2 |
| T7 | 旧格式文件含未知表或未知触发器 | 在夹具上另建表或触发器 | 第一轮报 `SCHEMA_UNKNOWN` 或 `TRIGGER_UNKNOWN` | AC3.3 |
| T8 | 旧格式端到端升级 | `createUpgradeHost` + `seedLegacy` 主库 + 夹具月度文件 | `activation.run()` 到 ACTIVE，经过 5 个 stage，月度文件被回收 | AC3.1 |
| T9 | 当前格式（G2）回归 | 原 `seedLegacy` | 现有升级测试全部通过 | AC3.4 |
| T13 | 每个原因码 | `memory-admission.test.js`：逐个构造 §3.2 表中的拒绝条件（`evaluation-busy` 无法从外部稳定构造，未单测） | `trace.reason` 和数值正确；不传 `trace` 时返回值与现状相同 | AC1.4、AC1.7 |
| T14 | 三处错误都带判定记录 | `memory-admission.test.js`：立即拒绝、排队中按 `reject` 拒绝、排队超时 | `details.decision` 存在且已冻结；`code`、`message` 不变；超时项被移除，之后释放的容量不会迟到授予 | AC1.7、AC2.2 |
| T15 | 时序反例 | 假时钟：队首与预检同时到期，之后有可立即获批的请求 | 预检的判定记录仍是“0 次，入队时前方 1 项”；拒绝后现场显示空队列和新租约，并带标注 | AC1.7 |
| T16 | post-outbox 入口 | 真实控制器 + BizOP participant：owner 预检通过，post-outbox 续跑预检超时；再交给 `reportStartupFailure` | 弹窗和日志都含 `BizOP activation and recovery：[BIZOP_ACTIVATION_RESOURCE_UNAVAILABLE] …`、内部原因和判定记录；`code` 仍是 `ARCHIVE_STARTUP_HOOK_FAILED`，`cause` 不变 | AC1.6 |
| T17 | owner 入口 | 同 T16，但 owner 预检失败 | 弹窗和日志的格式与现有 owner 聚合一致，并含新增明细 | AC1.6 |
| T18 | G1 集成回归 | `scripts/integration/biz-op-legacy-side-db-upgrade.js`：真实 `run-data-store` 和原 provider，一个 G1 月份和一个 G2 月份；先 `run({ quiesceOnly: true })`，再 `run()`，模拟 owner 与 post-outbox | ACTIVE；两个月度文件及其 `-wal`/`-shm` 都被回收；主库非目标数据和外部文件不变。反例：G1 文件含未知表时第一轮报 `SCHEMA_UNKNOWN`，stage 不推进，文件不变。任何失败都 `exit 1` | AC3.5 |
| T19 | Windows 正式包 G1 验收 | `verify-windows-app.js` 在原 G2 种子之外，用 `seedLegacyG1Month` 再加一个 G1 月份 | 沿用原有的 ACTIVE、单实例锁、正常窗口和后续业务流程断言，另加 G1 文件已回收；失败时脚本以非零退出，CI 步骤失败 | AC3.5、AC3.1 |

### 7.2 P1 应测

| 编号 | 场景 | 预期 |
| --- | --- | --- |
| T10 | phase-admission 的其他调用方 | 已有断言全部通过；新增行出现在原有行之后 |
| T11 | 明细隐私 | 明细里没有 ownerKey、UUID 或路径 |
| T12 | 续跑入口（`MIGRATING`、`LEGACY_DB_CLEARED`） | 沿用 `biz-op-v327-upgrade-resource.test.js:135` 起的用例，改为新文案后仍能用同一任务继续 |

### 7.3 门禁与实机

- **持续门禁**：
  - T18 进入 `npm run test:integration`，它是 `release-check` 的一部分（`package.json` 第 165 行）；
  - T19 进入 `build-windows.yml`（第 199–204 行）和 `release-windows.yml`（第 97 行）的正式包验收步骤；
  - 两者失败都会让命令非零退出。`verify-windows-app.js` 在不设置 `BIZOP_ACCEPTANCE_APP` 时以开发模式启动；但在不在资格清单内的平台上，预检走兼容上限，系统空闲内存低于约 3 GiB 时会以 `stable-limit` 立即拒绝，所以本地跑不通不代表失败，T19 以 Windows CI 结果为准。
- **本地门禁**：`npm run test:unit`、`npm run lint`、`npm run release-check`。
- **复现工具**：[repro-harness](evidence/repro-harness/README.md) 只作为证据工具，用于对照 v3.2.11 基线和本分支的追踪，不判定通过与否，也不代替上面的门禁。
- **Windows x64 实机**：可选的补充验收，结果写入实施记录。

### 7.4 不测项

- 启动恢复窗口：本分支不实现。
- 用户机器上 P-RES 的真实根因：等 F1 诊断结果，C 阶段再测。

## 八、交付

1. 文档不单独提交：开发完成、门禁通过后，文档和代码一起提交，合入 `release/v3.2.12`（用户决定，2026-10-06）。提交和推送仍需用户明确授权。
2. 在 GitHub Actions 中，对已推送的分支（`fix/bizop-upgrade-startup` 或合入后的 `release/v3.2.12`）手动触发 `Build Windows Packages`（`workflow_dispatch`），下载 `windows-installer` 或 `windows-portable-exe` 产物。这个工作流本身会跑 T19。
3. 不打 tag，不发布 Release，不改 `package.json.version`。诊断包只发给报障用户，用户需要手动覆盖安装（启动失败时自动更新不可用，[S12](baseline-evidence.md#s12)）。
4. 结果分两种：
   - 用户能正常打开：记录现场，说明 F2 或 F3 生效；
   - 仍然失败：用户把对话框截图发回，按判定记录定位后进入 C 阶段，并同步 Spec 和本文。
5. 合入路径：`fix/bizop-upgrade-startup` → `release/v3.2.12` → `main`（`AGENTS.md:69-71`）。
   - `release/v3.2.12` 尚未创建。按 `AGENTS.md:70`，它以 `v3.2.11` 标签提交为基线，与本分支相同。
   - 合入前以 `npm run release-check` 作为本地 PASS/FAIL 依据（`CODEX.md`「交付门禁与完成」）。
   - 共享状态相关的风险参考 `rules/important-variables.md`。旧的 check-vars 固定流程已移除，见 `CLAUDE.md`。

## 九、实施顺序

每一步都先写测试并确认失败，再实现。

1. **F3 与 G1 门禁**：
   1. 加夹具，T6/T7 先失败；
   2. 改 `upgrade-legacy.js`，T6–T9 通过；
   3. 加 `seedLegacyG1Month` 和 T18，先在基线代码上确认 T18 失败，再确认通过；
   4. 在 `verify-windows-app.js` 中加 G1（T19），在本地开发模式跑一遍。
2. **F1 判定记录**：给 `memory-admission.js` 加 `trace`（T13）；给 `resource-governor.js` 加判定记录（T13、T14、T15）。
3. **F1 明细**：`phase-admission.js`（T10、T11），以及 T3 中与判定记录无关的断言。
4. **F1 透传**：`controller.js`（T17，以及控制器单测）。
5. **F2**：改 `upgrade-main.js`（T1–T5、T12、T16）。
6. **收尾**：用复现工具对照基线；跑门禁；更新实施记录和本文中的偏差。
