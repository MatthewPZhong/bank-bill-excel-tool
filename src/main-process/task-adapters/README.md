# 业务任务适配与资源所有权

本目录维护公共任务适配协议。Main 的 `runArchiveAwareOperation` 继续复用既有 [TaskLifecycle](../archive-center/task-lifecycle.js)；BOR、Task Run、Batch、manifest、终态和 outbox 的状态机仍归 TaskLifecycle / ArchiveCenter。适配层不建立第二套调度或持久存储。

## 入口与职责

| 入口 | 职责与调用方 |
| --- | --- |
| [registry.js](registry.js) | `createTaskAdapterRegistry({ adapters, taskBindings })` 冻结注册表及注册项；只按显式 taskKey 查找。重复或缺失注册失败；未知受控任务返回 `TASK_ADAPTER_UNBOUND`，无默认 fallback。 |
| [task-adapter-composition.js](../task-adapter-composition.js) | Main 启动时静态装配四种 adapter，并从既有 policy 清单生成全部受控 taskKey 的显式绑定；exclude 不绑定。领域依赖只允许在该装配层和领域模块。新增受控任务必须核对其 scope、适配行为和 binding 测试。 |
| [passthrough.js](passthrough.js) | 透传 prepared 身份、hook、intent；在真实业务闭包执行前标记接管。没有显式身份仍由 TaskLifecycle 生成。 |
| [prepared-resources.js](prepared-resources.js) | prepare 返回 `proceed:true` 后立即建立唯一 scope；只调用 prepared 原有 `onAbandon`，不推测文件路径、不替代领域清理。 |
| [Position owner](../position-reconciliation/task-owner.js) / [adapter](../position-reconciliation/task-adapter.js) | owner 持有 operation context/active state、pending/checkpoint、恢复意图和受管暂存清理；adapter 持有 invocation token 并组合 admission、业务、settlement、终态。设置与服务访问由 Main 注入，数据位置不变。 |
| [Toolbox adapter](../toolbox-background/task-adapter.js) / [VCC adapter](../vcc-financial-op-output/task-adapter.js) | 仅选择原 publication-only receipt hook；继续调用 Main 注入的 G1 publication 确认能力。 |
| [terminal-route-registry.js](../archive-center/terminal-route-registry.js) | 冻结成对的 normalize/finalize 注册，Controller 和 live operation hook 共用；不保存领域 SQL 或可变路由扩展入口。 |

公共目录 `task-adapters/` 不依赖 Position、Toolbox、VCC 或业务数据库。Main 的公共执行函数不读取领域 pending、checkpoint、receipt 或根据 channel 前缀分派；领域 handler 通过 owner API 访问对应状态。Renderer 输入不能提供注册项或选择 adapter。

## prepare 后的资源交接

顺序固定为：首次 Hold gate → prepare → scope → scope.run 内第二次 gate、Archive 初始化、adapter 构造 → enterLifecycle → 既有生命周期 → beforeStart 第三次 gate → 原领域 beforeStart → domain admission → execute。

- `scope.run(work)` 单飞，重复调用复用同一 Promise；其前置步骤、业务和清理一起计入 `archiveOperationTail`。
- `enterLifecycle()` 仅划定旧异常优先级的边界，不转交资源。BOR、预留批次和 beforeStart 也不代表业务接管。
- `markExecuteStarted()` 只在领域 admission 接受、即将执行业务闭包时转为 execution。转交后通用 abandon 永不执行。
- 未接管而返回或抛错，都等待一次 `onAbandon`；清理抛错不重试，快照保留 `owner:scope, abandonAttempted:true`。清理成功为 released；完成后不能再接管。
- 生命周期之前原错误和清理错误同时发生时保留原错误，清理错误经注入的诊断回调记录；进入生命周期后沿用原 finally 的清理错误优先级。正常的 lifecycle-unavailable 返回若清理失败，仍以清理错误结束。诊断失败不改变原异常优先级；默认和兜底诊断使用项目 [appendModuleLog](../../backend/logger.js)，与 Main 注入的活动日志共享配置，不直接写 console。
- prepare 自身取消或抛错时，由 prepare 原有合同处理资源。scope 不处理尚未取得的 prepared。

## 领域与兼容合同

Position 仍按 prepared 显式 taskRunId/operationKey 优先，否则使用每次 invocation 生成的 operationToken；终态 route 保存原 token。历史显式身份冲突保留原 owner 校验，不隐式改写。当前 Position 生产者为 10 eager + 5 no-file；deferred/legacy 测试是兼容能力夹具。

current file 先登记 frozen manifest intent，再记录业务结果或失败，单次 settlement 完整 manifest；durable 后才允许领域暂存清理，否则保留 pending / incomplete。legacy 沿用原 result/error settlement、sourceSnapshots 和持久意图。暂存清理限于受管 import-staging，并保护 pending/outbox/active 引用；不删除用户原始文件。

Toolbox/VCC receipt override 仅覆盖原 scope 下的五项：`toolbox:merge`、`toolbox:split:export`、`vccFinancialOp:data-manager:export`、`vccFinancialOp:export:import-audit`、`vccFinancialOp:export:result`。`toolboxPublicationTaskIds || vccOutputPublicationTaskIds || []` 保持原优先级，空 toolbox 数组仍优先。其他任务保留 prepared hook；no-file 不套用此规则。

四个历史 route `position-reconciliation`、`pending-run`、`biz-op-run`、`pre-fund-run` 是保留的数据合同。各领域 normalizer 保留 trim、必填字段、丢弃额外字段的语义；未知 route 拒绝。Main 注册各领域工厂，Controller 仅消费冻结 registry。Pending/BizOP/PreFund live hook 通过 `createAfterTerminal(route)` 从生命周期实际 context 构建 exact-5 operation owner，再进入同一领域 finalizer。Position live/replay 在同一 owner 内保留原各自身份检查与恢复专用收口步骤。

旧 `runWithPreparedResourceCleanup` 已移除；`executeAfterPositionAdmission` 继续作为 Position 内部准入 helper，未成为通用执行器依赖。Controller 没有旧路由 fallback；未传 registry 的无路由调用方使用冻结空 registry，任何持久 route 都必须显式注册。

## 恢复边界与验证入口

恢复协调及 publication 所有者调用见 [G1 当前说明](../application-recovery/README.md)。本分支固定依赖经 release 集成的 `5ccbf3f022488026f725a5111be00422a04ce221`；本次不改变 G1 公共接口、IPC、schema、retention、输出列或金额算法。

- 公共实际函数与故障注入：[archive-aware-prepared-resource-entry.test.js](../../../tests/unit/main-process/archive-aware-prepared-resource-entry.test.js)、[task-adapters.test.js](../../../tests/unit/main-process/task-adapters.test.js)。外围 lifecycle/领域服务为夹具；不等同 GUI。
- scope、冻结注册和完整绑定：[prepared-resource-scope.test.js](../../../tests/unit/main-process/prepared-resource-scope.test.js)、[task-adapter-registry.test.js](../../../tests/unit/main-process/task-adapter-registry.test.js)、[task-adapter-composition.test.js](../../../tests/unit/main-process/task-adapter-composition.test.js)。后者同时校验当前公共入口边界。
- 领域所有权与历史路由：[position-task-adapter.test.js](../../../tests/unit/main-process/position-task-adapter.test.js)、[archive-terminal-route-registry.test.js](../../../tests/unit/main-process/archive-terminal-route-registry.test.js)。
- 已有 outbox 的真实临时 DB / archive 重放：[task-adapter-recovery.js](../../../scripts/integration/task-adapter-recovery.js)。其业务侧提交/checkpoint 与 G1 participant 为夹具，不能据此推断完整生产启动入口已运行。
- 生产 Position 启动入口：[position-startup-task-recovery.js](../../../scripts/integration/position-startup-task-recovery.js) 通过 [Main 原函数测试装配](../../../tests/helpers/position-startup-recovery-harness.js)，运行真实 G1 composition、Position streaming 导入/side DB、owner 与 Archive Controller。覆盖已提交且 pending 存在但 outbox 尚未生成、恢复等待屏障、checkpoint token 错配阻断 sweep、durable 后 pending 写失败重放及二次重开；不等同真实 Electron 进程强杀或 Windows 文件锁验收。

设计依据：[Spec](../../../changes/v3.2.10/codex/v3.2.10-business-task-adapters/spec.md)、[TechDoc](../../../changes/v3.2.10/codex/v3.2.10-business-task-adapters/techdoc.md)。实际运行结果、平台限制和切片状态仅在[实施记录](../../../changes/v3.2.10/codex/v3.2.10-business-task-adapters/implementation-notes.md)维护。

G8 尚未纳入本分支；`ARCH-TASK-ADAPTER` 的机器配置未激活，没有新增例外。按总索引 §6.2 由后续 G8 集成负责登记本说明对应边界，T5 保留联合验收待完成；当前行为和边界测试不代替该配置激活。
