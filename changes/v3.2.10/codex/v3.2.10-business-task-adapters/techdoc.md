# v3.2.10 TechDoc — TaskAdapter 与 terminal route registry

| 项目 | 内容 |
| --- | --- |
| 治理编号 / 优先级 | G2 / P1 |
| 目标版本 / 功能分支 | `v3.2.10` / `codex/v3.2.10-business-task-adapters`（计划名，未创建） |
| 开发基线 | `main` / 附注标签 `v3.2.9`，`11086a3cbf632a30adbcfa796e4cd81810c5aef9` |
| 集成目标 / 依赖 | `release/v3.2.10`；交付前已与 v3.2.9 同步；实施时记录 G1 已集成的固定 SHA，见[总索引](../../README.md) |
| 日期 / 状态 | 2026-09-20 / 本稿设计，代码未实施，测试未执行 |
| 产品依据 | [Spec](spec.md)、[G1 TechDoc](../v3.2.10-application-recovery/techdoc.md) |

> 本文保留审批设计基线。当前实现及验证状态见 [implementation-notes.md](implementation-notes.md)，现行调用说明见 [task-adapters/README.md](../../../../src/main-process/task-adapters/README.md)。实现补充：Main 的启动装配提取为 `src/main-process/task-adapter-composition.js`；中立 scope 支持注入 `reportCleanupFailure` 诊断；terminal registry 提供 `createAfterTerminal(route)`，由生命周期实际 operation context 构建原 owner 并复用领域 finalizer。三项均不改变下述业务合同。

## 1. 模块切分

| 文件 | 处理方式 / 所有权 |
| --- | --- |
| `src/main-process/task-adapters/registry.js` | 拟新增；静态 taskKey→adapterId、adapter 与 route 注册校验/冻结；不读 DB、不执行领域逻辑 |
| `src/main-process/task-adapters/passthrough.js` | 拟新增；沿用 prepared 原身份、execute 和 afterTerminal，用于未迁移的业务 |
| `src/main-process/task-adapters/prepared-resources.js` | 拟新增；建立 prepare 成功后的唯一资源 scope，显式修复第二 gate / adapter 构建 / 同步异常漏收口；执行接管点仍由领域 admission 控制 |
| `src/main-process/position-reconciliation/task-adapter.js` | 拟新增；持有每次 invocation token，组合现有 admission/pending/settlement/cleanup 能力 |
| `src/main-process/position-reconciliation/task-owner.js` | 拟新增；迁移 Main 内 Position operation context、pending 标记、持久意图、终态与受管暂存清理函数；通过现有 service/setting 接口读写原存储 |
| `src/main-process/toolbox-background/task-adapter.js`、`src/main-process/vcc-financial-op-output/task-adapter.js` | 拟新增；只迁移 publication-only afterTerminal 选择与原 receipt acknowledgement |
| `src/main-process/archive-center/terminal-route-registry.js` | 拟新增；normalize/finalize 成对注册、不可变路由查找，无领域 SQL |
| `archive-center/task-lifecycle.js`、`ipc-task-contract.js` | 复用现有任务/批次/controls 及 prepare contract；不重建状态机 |

`task-owner.js` 不是新存储。仍使用原 settings/pending/side-DB/checkpoint 和现有 `positionReconciliationOperationContext` 的 AsyncLocalStorage 语义；将变量及仅服务这些函数的辅助一起迁入，Main 只持有工厂返回的受限 API。现有 Position handler 调用这些 API，不能留下第二份 pending 写入口。

## 2. TaskAdapter 内部接口

```js
createTaskAdapterRegistry({ adapters, taskBindings })
// adapters: ReadonlyArray<{ id, createInvocation }>
// taskBindings: ReadonlyArray<{ taskKey, adapterId }>；Main 构造
// 返回 resolve(taskKey)；未知受控 taskKey 拒绝，非迁移任务必须显式绑定 passthrough

adapter.createInvocation({ meta, policy, prepared, args }) => {
  identity: { taskRunId: string|undefined, operationKey: string|undefined },
  afterTerminalIntent: object|null,
  afterTerminal: Function|null,
  execute({ taskContext, controls, executeBusiness, markExecuteStarted }): Promise<unknown>
}
```

这是新内部契约。`meta/policy` 来自已冻结的 Main registry；`prepared/args` 来自 `prepareIpcTaskInvocation`，不把含函数 prepared 传给 worker。`taskContext` 保持现有 `createIpcTaskContext` 的字段；`controls` 保持 TaskLifecycle 原对象；`executeBusiness()` 为本次原 handler 的无参闭包。registry 对象与 adapter 注册项冻结，每次 `createInvocation` 新建 invocation，不能跨 task 共享 token 或结果。

`identity` 原样遵守基线优先级：Position 生成一个 operationToken，`taskRunId = prepared.taskRunId || operationToken`、`operationKey = prepared.operationKey || position:<token>:<channel>`；非 Position 只透传 prepared，没有则仍让 TaskLifecycle 生成。Position route 继续保存该 operationToken；若 prepared 显式身份与领域 owner 合同冲突，保留原 admission/owner 校验拒绝，不在适配器偷偷覆盖。

afterTerminal 的选择保持基线：Position 使用 `composePositionTerminalSettlement(finalizePending, prepared.afterTerminal)`；其他文件任务仅在 toolbox/vcc scope 且 `isPublicationOnlyFileTask` 为真时采用原 receipt acknowledgement，仍使用 `toolboxPublicationTaskIds || vccOutputPublicationTaskIds || []` 的有效语义；其他任务透传 prepared hook。无文件任务不套 publication-only 行为。

新增内部注册错误为 `TASK_ADAPTER_REGISTRATION_INVALID`（重复/缺失）、`TASK_ADAPTER_UNBOUND`（已登记业务 task 缺绑定）；均在业务执行前失败，不修改原业务错误映射。禁止动态 require、按 Renderer payload 选 adapter 或给 policy 增加来源不明字段。

## 3. 公共执行器与领域顺序（R4 修订）

### 3.1 基线缺口与本次明确修复

基线第二次 Hold gate 在资源 wrapper 之前；prepare 成功后此处抛错不会调用 `onAbandon`。原 lifecycle 不可用分支则已经会调用 `onAbandon`，不能误写成它完全缺少清理。原 helper 的 `Promise.resolve(run(...))` 还不能捕获调用 `run` 本身的同步抛错。本切片明确修复这些资源交接空隙，将 adapter 构建这个新失败点一并纳入 scope，不能继续声称资源收口完全原样迁移。

### 3.2 prepare 资源唯一 owner

```js
createPreparedResourceScope(prepared) => ({
  run(work): Promise<unknown>,
  enterLifecycle(): void,
  markExecuteStarted(): void,
  snapshot(): { owner: 'scope'|'execution'|'released', abandonAttempted: boolean }
})
// work 仅执行一次；Promise.resolve().then(work) 纳入同步/异步异常。
// run 内部 finally 统一收口；不可由 adapter 或公共入口再手工 onAbandon。
```

`prepareIpcTaskInvocation()` 成功返回 `proceed:true` 时，公共入口下一条资源相关操作就是创建 scope。此前 prepare 自己仍负责取消/抛错路径中的资源；`proceed:false` 不创建 scope，也不新增 BOR/task/batch。scope 只消费现有 `prepared.onAbandon`，不根据 paths 猜测清理文件，更不替代领域自身 durable 后 cleanup。

scope 状态由 `scope` 开始。`run()` 单飞并复用已完成结果，禁止再次执行 work；返回 Promise 及所有清理均纳入退出等待 tail。`markExecuteStarted()` 仅允许在 domain admission 已接受、即将调用真实业务执行时从 `scope` 转为 `execution`；对同一 invocation 重复标记幂等，终结后再标记拒绝。BOR.begin、预留 batch、构造 adapter、beforeStart 成功均不等于业务已接管。`execution` 状态下通用 scope 永不调用 onAbandon；业务执行、settlement 和现有领域 finally 接管后续资源义务。

work 在接管前成功返回（例如 lifecycle 不可用、BOR/admission 拒绝）或抛错时，scope 先记录 `abandonAttempted=true` 再 await 原 onAbandon；因此并发收口、重复 finally 或清理抛错不会再次调用。只有清理成功才标 `released`；失败保留可诊断状态和剩余资源，不自动重试删除。没有 callback 时记录本次无可调用资源并结算，不能伪造文件已删。prepare 对外返回前的内部资源失败不由一个尚未获得 prepared 的通用 scope 推测处理。

### 3.3 公共执行顺序

`runArchiveAwareOperation` 保留公共编排，但 gate 和构造步骤必须位于同一 scope.run 内：

1. normalize handler / policy；初次 Hold gate；await prepare；`proceed=false` 原样返回。
2. 立即创建 prepared scope；启动 `scope.run(async () => { ... })` 并用 `trackArchiveOperationPromise` 登记它，**登记的是包含全部前置步骤和 cleanup 的 Promise**，不只 lifecycle 返回的 Promise。
3. scope 内执行第二次 Hold gate、`initializeArchiveCenter()` / lifecycle 可用性检查；不可用返回原 `ARCHIVE_TASK_LIFECYCLE_UNAVAILABLE` 结果，删掉旧分支手工 onAbandon，由 scope 收口一次。
4. scope 内构造 effectiveArgs、业务闭包，resolve adapter 并 createInvocation，构造 FilePlan/flow/result resolver；任一步同步抛错或 Promise 拒绝都在 scope 内。
5. 调 lifecycle 前标记 `enterLifecycle()`，然后 await 原 `runOperationOnly`、`runFileTask`、`runDeferredFileTask` 或 legacy `run`。beforeStart 第三次 gate 和原 prepared hook 仍在任何领域副作用前；legacy 分支仍保留源快照。
6. lifecycle execute 构造原 taskContext，委托 invocation.execute，并传 `scope.markExecuteStarted`；afterTerminal/intent 仍交 TaskLifecycle。领域 admission 拒绝或未调用 executeBusiness 时不能提前接管。
7. work/生命周期 Promise 真正结算后 scope 完成必要收口，整个已登记 Promise 才结束。BOR token 仍由 TaskLifecycle 持有、释放；scope 不释放 BOR、不重复终态 settlement、不写领域 pending。

`passthrough` 在即将进入真实 executeBusiness 前标记接管；Position 继续在 `executeAfterPositionAdmission` 的 admit callback 内标记。Position 内部业务在接管后尚未实际 apply 时的既有 `abandonPreparedSourceImport` finally 仍由 Position 负责，通用 scope 不再触发第二次清理。

### 3.4 错误和清理优先级

明确区分本次新覆盖路径与基线已有 finally 行为，避免笼统写“保留原异常”而意外改变既有反馈：

| 路径 | onAbandon 与对外结果 |
| --- | --- |
| 第二 gate、Archive 初始化或 adapter 构建抛错；尚未 enterLifecycle | abandon 恰好尝试一次；成功则重抛同一原错误；若 cleanup 也失败，原 gate/构建错误保持主错误和 code，cleanup failure 作为内部诊断记录，保留资源信息；不吞 cleanup 失败或伪称已释放 |
| lifecycle 不可用返回原 failed 结果 | 清理成功后返回原结果；清理抛错时沿原分支传播 cleanup error，不返回虚假的已收口结果 |
| 已 enterLifecycle、尚未 executeStarted 的 beforeStart/BOR/reserve/admission 失败 | 延续旧 wrapper 的 Promise-finally 语义：cleanup 成功保留原结果/异常；cleanup 抛错则 cleanup error 为对外异常，原失败保留为内部诊断。不得顺手更改这条已有优先级 |
| 同步调用 work/lifecycle 抛错 | 同样被 scope 捕获；按抛错时是否 enterLifecycle 使用上面规则，补上旧 Promise.resolve(run()) 的覆盖空隙 |
| executeStarted 后业务/settlement 双异常 | scope 不调用 onAbandon；沿领域 adapter 的基线错误优先级，不加 finally 覆盖业务/归档错误 |

内部诊断使用现有日志能力并保存原 error/code 和 cleanup error；不把 callback、路径集合或函数放入 Renderer payload。不新增对用户承诺的自动清理重试。scope 失败不改变既有任务身份、历史 route 或 durable evidence。

### 3.5 领域业务顺序

Position invocation.execute 内先调用原 `executeAfterPositionAdmission`，其中 admit 由 `task-owner.runOperation(channel, execute, {operationToken, batchContext|operationContext})` 实现；markExecuteStarted 的位置保持原函数。无文件执行 admission 后直接调用 executeBusiness；文件分两路：

| 分支 | 固定顺序 |
| --- | --- |
| 当前 FilePlan | recordFilePlanIntent → 捕获 executeBusiness 结果/异常 → markBusinessOutcome（terminalForCurrentTask:true）→ `controls.settleArtifacts({files})` → durable 时 markArchiveDurable 并 cleanup → 非 durable 时 markArchiveIncomplete → 原业务异常重新抛出或原结果返回 |
| legacyExistingBatchRecovery | 捕获 executeBusiness → markBusinessOutcome → `controls.settleArtifacts({result,error})` → 原 `settlePositionArchiveResult`（persistRecovery/mark/cleanup/reportFailure）→ 原业务异常重新抛出或返回 settledResult |

settle 自身抛出时保留基线传播优先级及 pending；不得在新增 finally 中提前 cleanup。`task-owner` 清理能力必须调用原 managed ownership/path/checkpoint 检查，接收的 cleanupPaths 只是候选，不是删除授权。旧 imported source 和用户另存目标不因 adapter 被移出 Main 改变归属。

## 4. 持久 terminal route 注册

```js
createTerminalRouteRegistry(entries) => {
  normalize(value): Readonly<object>|null,
  finalize({ route, record, created }): Promise<void>
}
// entries 固定结构：
{ route: string, normalize(value): object, finalize(payload): Promise<void> }
```

`normalize(null|undefined)` 返回 null；有 route 时必须注册且通过领域 normalizer。保留当前字符串 trim、字段必填及输出字段裁剪语义，不因新 registry 改为严格拒绝历史多余字段。registry 深冻结 normalized 普通数据，不能把函数持久化。

| route | 正常化输出 / finalizer 所有权 |
| --- | --- |
| `position-reconciliation` | `{route, operationToken}`；Position task-owner 校验 pending、原 task owner、targetBatchId、token 和历史无 owner 兼容分支后调用原 finalizeRecoveredPositionPending |
| `pending-run` | `{route, taskRunId}`；复用现有 Pending finalizer 和 pendingDb |
| `biz-op-run` | `{route, taskRunId}`；复用旧 BizOP finalizer，保留 `legacyMode` 与 activation retired guard、`withLegacyRecovery` |
| `pre-fund-run` | `{route, taskRunId}`；复用现有 PreFund finalizer 和 service |

这些 registration 由各域返回，在 Main composition root 汇总；G7 后续移动汇总位置，不改变 route。Archive Controller 的 `normalizeTerminalOutcome` 接收 registry normalize，原 `onTerminalIntentFlushed` 转发 registry finalize。live afterTerminal 与 replay finalizer 的业务终结逻辑共用领域函数；live 路径不能绕过 owner 检查。

新 registry 未冻结、重复 route、缺 normalize/finalize 在 Controller 初始化前以 `ARCHIVE_TERMINAL_ROUTE_REGISTRATION_INVALID` 拒绝。未知 route 沿用当前失败关闭消息和异常类型；不默认 fallback 到 Position。未确认的 outbox 继续留存，不标完成、不吞异常。

## 5. 迁移、并发与回滚

第一阶段建立新接口但仍用 passthrough，先落实 §3 的 prepare 资源收口修复及负向测试；第二阶段迁移 Position，再迁移 publication-only 和四个 routes。现有 Main 领域函数可暂留单行转发以缩小 handler 改动，但不得持有第二份状态。所有生产调用和对应测试迁完即移除转发；历史持久 route 不属于可删除 shim。

registry 启动前冻结；执行期不能注册新 route/adapter。领域现有 admission/AsyncLocalStorage 继续管理并发，公共层不加全局锁。退出等待沿用 `archiveOperationTail`，取消仍由现有业务执行与 worker signal 接管；5 秒资源排队和真实 worker exit 屏障由原 governor/dispatcher 控制，不被 adapter Promise 包装削弱。

无数据库或文件格式迁移，回退恢复旧代码接线即可。回滚时先停止接新任务并等待原退出屏障；不删除 pending、journal、receipt 或 outbox。G1 恢复协调器仍使用相同 owner 恢复入口，所以回退 G2 不要求回退 G1。

## 6. 实施任务与验证

| 任务 | 交付 | AC |
| --- | --- | --- |
| G2-T1 | 锁定所有 task kind、prepared hook 优先级和基线错误传播；新增第二 gate、构建异常、同步异常的显式修复 fixture，不把基线缺口录成目标 | G2-AC-02、G2-AC-03、G2-AC-04、G2-AC-09 |
| G2-T2 | 建 registry/passthrough/prepared-resources；成功 prepare 后立即建 scope；全部 gate/构造/生命周期在同一 run；收口后整体退出等待；全部受控 task 显式绑定 | G2-AC-01、G2-AC-02、G2-AC-07、G2-AC-09 |
| G2-T3 | 迁移 Position task-owner 与 adapter，覆盖 current/legacy/no-file；Main 不再写领域状态 | G2-AC-01、G2-AC-03、G2-AC-04 |
| G2-T4 | 成对注册四个 routes，live/replay 共用；接入 Toolbox/VCC receipt adapter | G2-AC-05、G2-AC-06、G2-AC-08 |
| G2-T5 | 删除兼容转发，更新源码布局型测试和 G8 边界规则，完成 G1+G2 重启组合验证 | G2-AC-01、G2-AC-07、G2-AC-08 |

| 现有或拟新增测试路径 | 关键场景 | AC |
| --- | --- | --- |
| 拟新增 `tests/unit/main-process/task-adapters.test.js` | registration、passthrough、隔离 invocation、非 Position 无 DB、优先级与 gate 时序 | G2-AC-01、G2-AC-02、G2-AC-06、G2-AC-07 |
| 拟新增 `tests/unit/main-process/prepared-resource-scope.test.js` | run 同步抛错/异步拒绝、重复收口、abandon 抛错不重试、executeStarted 接管、各错误优先级及延迟 cleanup 时 tail 未结算 | G2-AC-02、G2-AC-04、G2-AC-09 |
| 拟新增 `tests/unit/main-process/archive-aware-prepared-resource-entry.test.js` | 通过真实公共入口运行 prepare 已分配资源→第二 gate 拒绝、adapter 构建抛错、初始化抛错、lifecycle 不可用、beforeStart 拒绝：业务零次、abandon 恰好一次；普通执行成功后 abandon 零次 | G2-AC-01、G2-AC-02、G2-AC-04、G2-AC-09 |
| 拟新增 `tests/unit/main-process/position-task-adapter.test.js` | 文件/deferred/no-file/legacy、admission 拒绝、双异常、durable 前后 cleanup、任务身份 | G2-AC-02、G2-AC-03、G2-AC-04 |
| 拟新增 `tests/unit/main-process/archive-terminal-route-registry.test.js` | 四个 route 历史 payload、unknown、owner/token 错配、重复 replay、activation guard | G2-AC-05、G2-AC-07、G2-AC-08 |
| 复用 `tests/unit/main-process/position-interactive-task-preflight.test.js`、`position-reconciliation-operation-lifecycle.test.js` | prepared cleanup、pending 终态、取消、原任务恢复 | G2-AC-02—G2-AC-04、G2-AC-08 |
| 复用 `tests/unit/main-process/archive-ipc-task-contract.test.js`、`archive-task-lifecycle.test.js`、`archive-center-controller.test.js` | prepared contract、BOR/outbox、beforeStart/afterTerminal 失败 | G2-AC-02、G2-AC-03、G2-AC-05、G2-AC-08 |
| 复用 `tests/unit/main-process/toolbox-archive-integration.test.js`、`position-read-only-export-e13-b.test.js` | receipt 与 read-only export hooks 不回退 | G2-AC-04、G2-AC-06 |
| 拟新增 `scripts/integration/task-adapter-recovery.js` | 临时 DB/受管文件：提交后归档失败、终态后崩溃、旧 outbox 重放、二次重启幂等 | G2-AC-03—G2-AC-06、G2-AC-08 |

测试计划尚未执行。本分支实施先跑这些风险相关验证，正式 PR-ready/交付再运行 `npm run release-check`；涉及真实文件打开/锁定的 Windows 和 Excel/WPS 验收单列。验证记录保存本功能目录，明确自动化、模拟故障、真实 GUI 各自覆盖，不以静态依赖减少代替行为正确。

## 7. 跨分支约束

G1 拥有恢复阶段与 participant；本分支只注册领域 terminal 能力。G7 的 descriptor 可返回 task adapter 与 terminal registrations，但不能重建本稿 registry 校验、TaskLifecycle 状态机或平台恢复顺序。descriptor 只汇总本稿确立的接口。本分支不得依赖 G5 新 query API 或尚未实施的批次分类/退出清理方案。G8 的 `ARCH-TASK-ADAPTER` 在 G2-T5 激活：通用入口函数 `runArchiveAwareOperation` 的调用闭包及 `task-adapters/{registry,passthrough,prepared-resources}.js` 不得依赖 Position pending/admission/settlement/cleanup 或前缀分派；Main composition 可静态构造领域 adapter，Position adapter 可调用本领域 task-owner。精确旧转发例外随迁移删除。负例为公共入口重新导入 Position preflight 清理辅助或直接调用 pending writer；正例为注册表返回的 invocation.execute。静态规则只限制依赖/调用边，三次 gate、唯一 resource owner、异常优先级和真实入口行为仍由上述测试证明，不能用无依赖替代。

## 8. 切片实施记录与规则同步（文档补充）

沿用本稿既有阶段及任务 ID，按[切片完成标准](../../README.md#slice-completion)逐项交付。优先复用本功能目录已有的 `implementation-notes.md` / `verification.md`；首次实施且没有适用记录时建立 `implementation-notes.md`，使用[实施记录与状态要求](../../README.md#slice-record)中的最小字段，避免同一事实多处维护。设计 AC 和测试计划与实际迁移状态、执行结果分别记录，本次不建立实施记录占位文件。

按[各治理项现行规则入口映射](../../README.md#current-rule-entrypoints)同步本切片影响的规则正文和入口链接。只有职责已在实际生产调用路径落地的模块才能记为现行入口，尚未实现的模块继续标为拟新增；不影响规则时，在切片记录中写明无需更新及原因。本次为文档要求补充，不表示生产实现、边界激活或验证已经完成。
