# 应用恢复与共享发布恢复

应用阶段和平台扫描完成事实由 [coordinator.js](coordinator.js) 唯一维护；业务恢复结果、预算、hold、pin、activation 与准入仍属于原业务模块。此说明描述当前功能分支代码；实施及验证状态见 [G1 实施记录](../../../changes/v3.2.10/codex/v3.2.10-application-recovery/implementation-notes.md)，设计合同见 [G1 TechDoc](../../../changes/v3.2.10/codex/v3.2.10-application-recovery/techdoc.md)。

## 应用阶段和 G2/G7 接口

`createApplicationRecoveryCoordinator({ platform, participants })` 返回：

- `platformFacade.scanAndRecover()` / `recoverSource(source, hold)`：转发原平台引擎；只有 scan 成功返回才写 `platformScanCompleted=true`。
- `preflight()`：单飞并保存原 participant results。`ARCHIVE_OWNER_PHASE_REQUIRED` 是 BizOP 可继续结果，预算留在 driver。
- `archiveOwnerHooks()` / `postOutboxHooks()`：提供 Archive Controller 原 hook 形状；Controller 仍负责失败聚合、outbox、interrupted sweep 和 post-outbox 顺序。
- `completeArchiveInitialization()` / `failArchiveInitialization(error)`：Main 在完整 Archive 初始化结束后调用；扫描未完成仍拒绝 ready。
- `snapshot()`：返回冻结的 `{ phase, platformScanCompleted, failureCode }`，业务只能读取。平台成功事实不等价于业务 hold 解除。

`participants` 是冻结有序数组，字段为 `id`、`ownerName`、可选日志名 `hookName`，以及 `preflight`、`recoverOwner`、`postOutbox` 三个函数或 `null`。非法/重复注册在副作用前拒绝。成功 hook 同轮不重复；失败 hook 可显式重试；ready 后不重跑。

[composition.js](composition.js) 导出 `createApplicationRecoveryComposition`。Main 提供 platform、bizOpModule 和原 owner/lineage 回调。固定 owner 顺序为 BizOP → Pending → legacy BizOP → Pre-fund → Position → Toolbox/VCC publication → VCC import terminal；post-outbox 为 BizOP activation → VCC lineage。G7 可以汇总静态注册，不能另建恢复阶段或改预算。G2 继续向同一 Controller 提供终态/owner 合同，不能用 task adapter 的 ready 代替应用 ready。

## publication owner 与权限

[publication-recovery/coordinator.js](../publication-recovery/coordinator.js) 导出 `createPublicationRecoveryCoordinator({ userDataDir, dispatcher, owners })`。Main 只调用一次 `bindDispatcherAuthority()`，向业务注入 `forOwner(ownerId).recover(options)`。root 和 owner 由 Main 固定，Renderer 不接收这些能力。

请求包含 `reason`（startup/live-handoff/receipt-ack/business-retry）、`taskIds`、`acknowledgedCommittedTaskIds`、`deferCommittedFinalization`、私有 observation capability 与进度回调。ack 必须同时限定 taskIds，跨 owner 拒绝。返回 `recovered`、全根 `deferred`、`skippedActive` 和受信任完整 `observation`；absence 只来自本次显式请求且全根确实不存在的任务，不能用过滤空结果证明未提交或已确认。

owner 接口是 `id`、只读 `identify(record)`、只读 `authorize(record, request, identity)`、`acquireObservation(request)`；借用租约另提供 `verifyObservation`。协调器不执行 SQL。BizOP 持久表、closure、commit proof 和原 1 GiB/5 秒预算留在 [publication-owner.js](../biz-op-v327/publication-owner.js)。Main 注册 `publication.publicationOwner` 后调用 `publication.bindRecovery(facade)`。当前 io capability 绑定 task、nonce、操作种类和前置 closure，任意 release 对象不能冒充。

同一 dispatcher FIFO 内：纯读 discover worker 真实退出 → 全根身份与权限判断 → execute worker 在 lifecycle mutex 内重验 index/journal/stage/backup/target 全摘要 → 原恢复算法。未知、冲突、缺 grant 或漂移在恢复写入前拒绝并保留路径。lease 在 enqueue 前取得，相关 worker 全部真实退出后释放；publish preflight/transport 自恢复复用当前 FIFO 项和租约。

权限为 `recover-uncommitted`、`observe-committed`、`ack-stage`、`ack-finalize`。观察不清理；stage 保留 finalizing receipt；finalize 满足原 owner proof 才清理。raw recover 的 async 导出已移除，dispatcher `.recover()` 仅保留固定拒绝（不能恢复）的诊断入口；core 仅由 dispatcher/worker 消费签名授权，prepare 必须消费一次性 preflight，不能隐式全根恢复；publishPrepared 只接受本次成功 prepare 返回的原对象，并核对 root/task/journal、单次消费，不能凭 plain/复制对象推进历史 journal。测试合成材料只使用 `tests/helpers/publication-authority.js`。

## Archive producer 与证明来源

静态表唯一代码入口为 [archive-owner.js](../publication-recovery/archive-owner.js)。所有身份要求原 Archive exact-7 批次/任务证明；不按前缀兜底。

| taskKey | moduleId | proof provider |
| --- | --- | --- |
| toolbox:merge；toolbox:split:export（含按行拆分） | toolbox | legacy exact-7 或 manifest；ready artifacts + succeeded；publication-only completion |
| vccFinancialOp:data-manager:export；vccFinancialOp:export:import-audit；vccFinancialOp:export:result | vcc-financial-op | 同上 |
| pending:error:export-report；pending:diff:export-single；pending:diff:export-aggregate | pending-reconciliation | 同上 |
| bizOpRecon:export:date；bizOpRecon:export:date-range | biz-op-recon | 同上 |
| pre-fund-reconciliation:export | pre-fund-reconciliation | 同上 |
| acquiringBillCurrency:export | acquiring-bill-currency | 同上 |
| recon-id-fix:export | recon-fix | 原 exact-7 + ready artifacts + succeeded |
| new-account:export | new-account | save-as manifest；原 new-account-source-artifact/new-account-save-as-output 角色、new-account:save-as 来源、hash/size、succeeded |
| position-reconciliation:run:export；position-reconciliation:run:export-filtered | position-reconciliation-process | 原 exact-7 + manifest/ready artifacts + succeeded；领域 metadata 收口仍在 Position |

manifest 核验 artifact keys、方向、角色、来源、路径、摘要和大小；legacy batch 允许既有嵌入 taskStatus，manifest 要求独立 Task Run。publication-only completion 可合法为 `afterTerminal:null`，仍核验实例、exact owner 和 succeeded。NewAccount 的 `taskTerminalPersisted:true` 不替代这些证明。

[toolbox-archive-recovery.js](../toolbox-archive-recovery.js) 保留 handoff 三阶段；各次 observation 分别保留，只有同 task/owner 的明确 commit-cleanup 才撤销 earlier deferred。启动自身 owner deferred 仍阻断，live 未决保留 warning/receipt，不诱导重复发布。

## 边界与验证入口

- [应用阶段测试](../../../tests/unit/main-process/application-recovery.test.js)：单飞、正常/deferred/activation、真实 SQLite/outbox、失败后继续 owner 及原阻断。
- [授权材料测试](../../../tests/unit/main-process/publication-recovery-owner.test.js)：五状态未知/冲突、缺 grant、全根漂移、活动记录冲突、真实 worker preflight/transport。
- [Archive owner 测试](../../../tests/unit/main-process/publication-recovery-archive-owner.test.js)、[producer 合同测试](../../../tests/unit/main-process/publication-recovery-producer-contracts.test.js)：持久 proof、未决聚合和实际 producer。
- [BizOP owner 测试](../../../tests/unit/main-process/biz-op-v327-publication-owner.test.js)：capability、ACK_PENDING、可信 absence 与 durable proof。
- [应用恢复集成](../../../scripts/integration/application-recovery-governance.js)：隔离 SQLite/journal 两次重启及 startup/live/真实 worker transport 保留。

G8 尚未集成，本分支不标机器规则 active。后续 G8 激活 `ARCH-BIZOP-RECOVERY-PRIVATE`、`ARCH-PUBLICATION-RECOVERY-ENTRY`：Main composition 静态装配、dispatcher/worker/core 是允许范围；测试 authority 仅用于 tests 和隔离验证脚本。业务不得引回 recoverOtherOwners、raw recovery 或 prepare 隐式恢复。尚未开放的 mature/Statement seam 保持原 production-disabled 策略，缺注入拒绝，不因接口接入擅自开放。
