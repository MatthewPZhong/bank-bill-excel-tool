# R02 / R06 弹窗修复证据

2026-09-20。工作区：`/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/v3210-renderer-boundaries`。本项修复实现完成；专项验证通过；整项 G3 集成结论由主实施记录汇总。本次没有提交、推送或运行完整 `release-check`。

## 依据、范围与当前规则入口

依据原 [R02 / R06 审查](../../../changes/v3.2.10/codex/v3.2.10-renderer-boundaries/review-2026-09-20.md)、[原 Electron 探针](../../../changes/v3.2.10/codex/v3.2.10-renderer-boundaries/review-2026-09-20-evidence/review-modal-probe.cjs)及 G3 [TechDoc §3.4](../../../changes/v3.2.10/codex/v3.2.10-renderer-boundaries/techdoc.md) 的生产入口关闭协议，覆盖 G3-AC-03 / 13 / 14 / 17。原审查及其证据保持不变。现行导航入口仍是 [AGENTS.md](../../../AGENTS.md) → [Renderer README](../../../src/renderer/README.md)，本修复未修改这些共享资料。

生产改动仅有：

- `src/renderer/dialogs/app-settings.js`：默认存档 API 取值 helper。保持外层窄 API 所有权及显式 override 兼容。
- `src/renderer-dialogs.js`：功能收纳的提交资格、提交参数副本、目标关闭和完成后的 UI 回调。宿主仍为唯一弹窗栈所有者。
- `src/renderer/dialogs/configuration.js`：拆分份数保存的父层/确认层 busy、同步重复提交门和目标句柄结算。保留 `saveBillSplitRowCount({templateId,nextN})` 的通道、参数及 Main 写入语义。

[代码差异](changes.patch)以主 Agent 保存的 `tmp/g3-review-fixes/before` 为修前输入。三份源码修前 SHA-256 已与修前回归记录比对，修后 SHA-256 已与最终回归记录比对；见 [源码身份记录](source-provenance.json)。

## 修前复现

直接运行原审查探针，使用当前生产工厂、隔离的 Electron userData/Documents 和内存 API。日志中的 `3/3 defect reproductions confirmed` 表示三项缺陷均成立，并非修复验收通过：

| 入口 | 修前实际结果 |
| --- | --- |
| 默认设置 → 存档 | 列表调用 0 次；反馈 `Cannot access 'api' before initialization`。同依赖仅显式 override 时列表调用 1 次。 |
| 功能收纳 | 在途保存期间根替换 `opened`；保存成功后旧无目标关闭结束新告警。 |
| 拆分份数 2 → 1 | 连续确认调用保存 2 次；确认按钮未禁用；父层 `close()` 返回 `closed`。 |

见 [原探针本次输出](before-probe.log)及其[运行包装](run-review-probe.cjs)。新正式默认路径与 busy 回归在修前为 **30/43 PASS，13 项失败**，详见 [修前日志](before-fixtures.log)和[命令及源码身份](before-fixtures.json)。默认存档 helper 阻断导致依赖该入口的后续存档父子测试也无法完成初始化。

## 修后行为与调用方兼容

默认存档 helper 使用独立的局部 `archiveApi` 名称，读取外层注入的 `api.archiveCenter`，不再触发 TDZ。正式设置工厂无 override 的路径已经覆盖列表、统计、保留期，以及删除预检/取消/成功/失败的父子流程；显式 override 单独保留兼容验证。

收纳的 `committing` 同时控制同步 `canClose` 和重复提交门。在途期间禁用编辑与提交；根替换、父/子关闭和导航均被宿主拒绝。成功只关闭原 handle；强制销毁之后，`onCommit` 已提交的 Main 写及事实接纳继续完成，但旧窗口不再写 DOM、关闭新窗口或导航。`onCommit` 抛错/返回 false 时原窗口保留草稿、显示错误并允许用户重试。

`createModuleCabinetDialog` 保留原字段，增加可选 `onCommitted(submittedIds)`：

1. `onCommit` 接收本次提交 ID 数组副本；仍按原 truthy/false 结果判断保存成功。
2. 成功且原 handle 仍在顶层时，解除 busy，再以 `{status:'submitted',value:submittedIds}` 关闭该 handle。
3. 只有该次关闭返回 `closed`，才调用 `onCommitted`，参数同样为副本。它适合导航和菜单重绘；强制销毁及保存失败均不调用。
4. `onCommitted` 抛错时明确反馈“模块设置已保存，但刷新界面失败”，不回滚已保存事实。

主 Agent 已在 `renderer.js` 调用方把持久化/事实接纳留在 `onCommit`，将当前模块停用后的导航及菜单重绘迁入 `onCommitted`；实际根装配组合验证由主 Agent 负责。本 Agent 不修改根文件。

拆分份数保持 1–99 验证与原模板 ID/份数参数。减少份数时，父层和确认子层共享一次保存的关闭资格；增加份数的直接保存同样被覆盖。重复确认只发一次 IPC，保存失败或 reject 仍显示本层子告警并可回到原确认重试，取消不新增写入。Main 结算之后，仅原父层和原操作层都存活且操作层仍在顶层时才更新行表并结束原确认；强制销毁不取消 Main 已提交写入，也不更新旧 DOM 或操作新窗口。

## 最终验证

| 验证 | 结果 | 证据 |
| --- | --- | --- |
| Electron `app-settings` | 7/7 PASS | 正式默认 API + override + 存档父子合同 |
| Electron `shared-dialogs` | 9/9 PASS | 原映射合同 + 收纳父子/busy/迟到/错误回调 |
| Electron `configuration-dialogs` | 28/28 PASS | 原配置合同 + 拆分份数减少/增加/失败/取消/强制结束 |
| Electron `legacy-dialogs` | 10/10 PASS | 相邻旧向导与失败返回合同 |
| 三组聚焦 unit：存档 UI、应用更新、module router | 46/46 PASS，0 skipped | [unit 日志](focused-unit.log) |
| 三份源码及三份 fixture 的 ESLint | PASS | [lint 日志](lint.log)，空日志表示无诊断 |
| `git diff --check` | PASS | 无空白错误 |

最终 Electron 合计 **54/54 PASS**。见 [最终日志](final-fixtures.log)、[命令/退出状态/最终源码及 fixture 哈希](final-fixtures.json)。[运行包装](run-fixtures.cjs)使用已有隔离 runner，不修改共享 runner 或 fixture 注册。

这些是加载真实 Renderer 工厂、DOM 和宿主的隔离 Electron 行为证据。API 为可控替身，不连接真实 Main、存档目录或财务文件；不替代真实产品 GUI、Windows/Excel/WPS 或完整发布门禁。R02/R06 的本项专项验证已完成，其他审查项及 G3 总体集成仍由主 Agent 汇总。


## R01 正式 F1/F2 补充闭合（2026-09-20）

本节是前述 54/54 阶段之后的补充；原审查、修前记录、54 条日志和源码身份文件均保留。当前源码增加以下变动，旧 54/54 记录不能当作这一追加改动的最终运行证据。

**职责与边界。** 独立只读复查 R01 控制器时，未发现已报告的 A/B 来源串账路径残留；发现正式 `createVccOpCalcComputeDialog` 在 `await onCompute` 后没有原句柄检查。最小实际函数探针及随后真实 Electron 回归均证实：强制销毁后，成功、失败或取消响应仍修改 detached 旧节点。旧节点保留的事件也能够再次调用回调并无目标关闭新窗口。本次仅补 `src/renderer-dialogs.js` 的 F2 工厂，不改变 Main 金额计算、任务、缓存或 IPC；实际根装配由主 Agent 验证。

**调用方与兼容。** F2 增加可选同步 `canClose(reason)`，默认允许；工厂以 `!computing && canClose(reason)` 合并本地提交锁与领域来源锁。控制器维护者已把 `sourceOperation.kind !== 'save'` 通过此选项传入，移除工厂返回后的第二次 `registerModal(canClose)`，不再覆盖视图资格。原 `onCompute(beginOp)`、`onClose` 及金额字符串参数保持；`onCompute` 已开始后无论视图是否销毁都继续等待真实结算。仅原存活顶层句柄显示结果，取消仅关闭原句柄，成功关闭才调用 `onClose`；强制销毁不伪造 Main 取消。

**业务行为。** F2 在回调首个 await 前锁定提交；双击、程序化重复事件和已完成后的重复事件不会增加回调。普通根替换、父/子关闭和 owner 导航关闭被 busy 同步拒绝。失败或 reject 显示原错误并恢复输入供重试；正常成功只展示后端 `endOp`，不在 Renderer 加减金额。句柄最终销毁会 abort 本地 DOM 事件，晚到成功/失败/取消均不修改已移除节点，也不关闭或替换新窗口。实际 F1 的同步 `closeModal()` → `onConfirm()` 时序经真实工厂验证：`decided` 在 `closed` Promise continuation 前设置，不误取消正常确认。

**验证证据。**

- 稳定的修前真实 Electron `shared-dialogs` 结果为 **11/17 PASS**：原 9 条、F1 时序与错误重试通过，新增 6 条 F2 边界失败，见 [修前日志](rone-f-two-before-checked-fixtures.log)。更早的 [初始 fixture 日志](rone-f-two-before-fixtures.log)含两个 harness 问题（返回不可克隆的 handle、错误替换工厂主动抛错），仅留作过程记录，不作为缺陷判定依据。
- 修后同组 **17/17 PASS**，见 [修后日志](rone-f-two-after-fixtures.log)和[命令/退出码/源码身份](rone-f-two-after-fixtures.json)。新增 8 条覆盖真实 F1 关闭确认、F2 提交锁/原金额参数、销毁后成功/失败/取消三种响应、错误重试、旧事件、领域与视图关闭资格组合。
- [追加源码差异](r01-f2-changes.patch)仅以保存的 [本次修前源码](r01-f2-before-renderer-dialogs.js)对比 F2 改动。该修前 SHA 同时匹配历史 54 条记录及本次修前回归；修后源码/fixture SHA 已校验。
- 生产工厂及本 fixture ESLint **PASS**，见 [lint 日志](r01-f2-lint.log)；`git diff --check` **PASS**。控制器维护者报告聚焦的来源归属与原域回归 **58/58 PASS**；该项执行日志由其 R01 证据目录负责，本节不冒充重新执行。

**当前规则入口与状态。** 仍按 G3 Spec §4 的后台写结算/页面代次与 TechDoc §3 的句柄关闭协议、G3-AC-08/14 执行；现行入口为 AGENTS.md → Renderer README。本补充实现与专项验证完成，源码/fixture 已冻结；根装配、真实 Main 和总体 G3 集成结论由主实施记录汇总。此 Electron harness 加载真实工厂、宿主和浏览器 DOM，但 API 为可控替身。来源归属专项虽使用真实 parser/session/SQLite，仍不含 Main `trackedIpcHandle` 的 Task 与活动日志：`compute-amounts` 每次调用会产生这些副作用，不能称为无副作用读取；没有增加或假定公开扫描 ID/hash。未运行完整 `release-check`、真实产品 Main、Windows/Excel/WPS 或安装包验收，也未提交或发布。
