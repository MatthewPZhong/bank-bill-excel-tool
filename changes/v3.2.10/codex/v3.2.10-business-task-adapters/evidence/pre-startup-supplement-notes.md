# G2 业务任务适配器实施记录

> 2026-09-20。本文件是 G2 切片状态的唯一索引。设计审批、实现、验证和 release 集成分别记录。历史 T1 阻塞记录保留在 [原始快照](evidence/t1-implementation-notes.txt)，其中的旧状态不代表本轮现状。

## 当前代码与依赖

G1 依赖已就绪，G2-T1 至 G2-T5 生产迁移与本地验证已完成；最终完整 release-check 退出码 0。所有 G2 修改尚未提交、未集成到 release。

- 工作目录：`/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/v3210-business-task-adapters`。
- 分支：`codex/v3.2.10-business-task-adapters`；创建基线 `11086a3cbf632a30adbcfa796e4cd81810c5aef9`（本地 main / v3.2.9）。
- G1 功能提交：`856c9dce8ae4c381229e37b5b236e2e2f776921d`；**固定且已纳入本分支的 release 集成提交 / 当前 HEAD：`5ccbf3f022488026f725a5111be00422a04ce221`**。通过 fast-forward 纳入，未创建新的 G2 提交。[依赖核验证据](evidence/dependency-verification.json)记录祖先链与四个 G1 接口未改校验。依赖核对时 G1/release worktree 干净，集成提交包含 G1；G1 63 项受验生产源 SHA256 全部匹配集成内容。
- G1 纳入前，对已有 55 项未跟踪材料作逐字节备份与清单：`/private/tmp/g2-before-g1-tc8urmzq/backup-manifest.json`。仅对确认冲突的 6 项引用文件在备份校验后让位给已提交 G1 版本；原 G2 设计、测试及历史证据保留。没有覆盖主工作区或其他 worktree 改动。
- 当前实现状态是上述 HEAD 加本分支 dirty 差异。最终内容摘要和差异单独落在 evidence，不能用 HEAD 冒充新实现已提交。
- 依据：[Spec](spec.md)、[TechDoc](techdoc.md)、[总索引 §2.2、§6.2–§6.4](../../README.md)。未提交设计从用户指定主工作区绝对路径读取并复制，原材料来源见 [design-inputs.json](evidence/design-inputs.json)。TechDoc 只补已实现内部装配接口说明，业务 AC 未改。

## 切片状态

| 切片 / 本次范围 | 实现状态 | 验证状态 | 集成状态 |
| --- | --- | --- | --- |
| G2-T1：调用方和行为基线、失败探针 | 已实现；原 8 个 TODO 全部替换为实际断言 | 定向通过；目标缺口在当前实现已修复 | 未集成 |
| G2-T2：registry、passthrough、scope、公共入口 | 已实现 | 定向及最终完整门禁通过 | 未集成 |
| G2-T3：Position owner / adapter | 已实现 | 52 项领域测试通过；真实临时 DB 重启组合通过 | 未集成 |
| G2-T4：四条 terminal routes、Toolbox/VCC adapters | 已实现 | 182 项路由相关测试通过；独立兼容差分通过 | 未集成 |
| G2-T5：移除 shim、当前边界、G1+G2 组合验证 | 已实现 | 4/4 组合恢复及最终完整门禁通过 | 未集成；G8 机器配置待 G8 后续集成 |

以下各切片的定向结果存在重叠，不相加宣称测试总数。最终完整门禁覆盖所有切片；实现完成、本地验证通过和 release 尚未集成分别记录。

## G2-T1 — 基线与可执行行为合同

- **职责与边界**：保留 [baseline-inventory.md](baseline-inventory.md) 的 v3.2.9 原始事实；[公共入口夹具](../../../../tests/helpers/archive-aware-operation-harness.js) 执行当前 Main 原函数及真实 IPC prepared 合同、scope、adapter。其 lifecycle/Hold/domain owner 为可注入协作者，不冒充 Electron 或真实数据库组合。
- **调用方与兼容**：268 policies 中 134 受控（69 eager 文件、2 deferred 文件、63 no-file），134 exclude；Position 为 10 eager + 5 no-file。真实 deferred producer 是 monthly-balance/new-account，legacy producer 是 Acquiring resume。Position deferred/legacy 属兼容能力夹具。
- **业务行为**：AC-02/03/06/09 固定 prepared 身份、hook 优先级、三个 gate、domain admission、错误优先级与退出 tail；原 adapter 构造 TODO 现已成为真实 registry.createInvocation 抛错测试，包括原错和清理错同时发生。
- **验证证据**：原 173 通过的基线、37 pass + 8 TODO 的准备和 7 个预期失败探针继续保留在 evidence 原文件。当前 Main 接线四组 76/76 通过，0 TODO；scope 及 registry 早期定向 35/35 通过；日志修正新增用例后也由最终全量覆盖。旧失败不是当前门禁结果，也未覆写成历史 PASS。
- **当前规则入口**：[根 AGENTS](../../../../AGENTS.md) → [任务适配模块说明](../../../../src/main-process/task-adapters/README.md) → 代表测试与本记录。旧准备阶段“无需新增模块导航”已随实际生产迁移失效。

## G2-T2 — 中立注册、资源 scope 与 Main

- **职责与边界**：[registry](../../../../src/main-process/task-adapters/registry.js) 只存冻结注册和显式 binding；[passthrough](../../../../src/main-process/task-adapters/passthrough.js) 透传 prepared；[prepared-resources](../../../../src/main-process/task-adapters/prepared-resources.js) 独占通用 abandon。Main 公共入口只做 gate、prepare、scope、adapter 与原 TaskLifecycle 编排；领域工厂由 [静态 composition](../../../../src/main-process/task-adapter-composition.js) 装配。
- **调用方与兼容**：所有受控任务已绑定，107 passthrough / 15 Position / 10 VCC / 2 Toolbox；exclude 和未知任务不能解析。注册重复、缺失 createInvocation 或未知 adapter 失败关闭。仍复用原 IPC contract 和 TaskLifecycle，不增加 Renderer 协议或业务存储。
- **业务行为**：AC-01/02/07/09。scope 从 prepare 成功立即接管，第二 gate、初始化、adapter 构建、同步和异步错误都能执行一次 abandon；未接管的正常返回也等待 cleanup。enterLifecycle 不是接管；实际业务执行前 markExecuteStarted 才转交。生命周期前双异常保留原错并诊断清理错，进入生命周期后保留旧 finally 的清理错优先。整个 scope Promise 及 cleanup/诊断纳入退出 tail。
- **验证证据**：scope+registry 早期定向 35/35；日志修正后资源/入口 44/44；Main 接线 76/76；新增 composition 2/2 验证全部 134 binding 和公共入口无领域分派。独立复核五组 103/103 通过，见 [审查](implementation-review.md) 与 [源码/绑定快照](evidence/implementation-review-snapshot.json)。实际 TaskLifecycle、G1 publication 实现相对固定依赖未改。
- **当前规则入口**：模块说明的“入口与职责”“prepare 后的资源交接”已更新；根仅加导航。G8 未集成，本分支实际边界检查在 composition 单测；未伪造 `ARCH-TASK-ADAPTER` active 或新增例外。

## G2-T3 — Position 所有权

- **职责与边界**：[task-owner](../../../../src/main-process/position-reconciliation/task-owner.js) 持有 AsyncLocalStorage/active operation、pending/checkpoint、取消耐久意图、恢复意图、终态和受管 staging 清理；[task-adapter](../../../../src/main-process/position-reconciliation/task-adapter.js) 持有 invocation token 并组合准入/业务/settlement。Main 通过 getter/设置能力装配，业务 handler 和启动保护调用 owner API；没有第二份 Main pending 写入口。
- **调用方与兼容**：Main 原 owner 函数、恢复保护、服务初始化 pending 收口均迁移；Position 原方法对已有 handler 保留在 owner 上。prepared 显式 taskRunId/operationKey 优先，route token 仍为本次 token，历史不匹配继续拒绝。current/eager、deferred 兼容夹具、no-file、legacy 的上下文形状保持。`executeAfterPositionAdmission` 是领域准入 helper，继续保留。
- **业务行为**：AC-03/04/08。current 文件先登记 intent，再执行业务并记录 outcome，再单次 settle 完整 manifest；durable 才进行域清理，否则保留 incomplete/pending。业务错和 settlement 错同时出现保持 settlement 优先；外层 owner/checkpoint 原错误映射保留。取消保持 pending → terminal outbox → 原 task CAS 顺序。清理仅作用于受管 import-staging，并保护 pending/outbox/active 引用与外部输入。
- **验证证据**：Position lifecycle + adapter 52/52 通过，其中新增 23 项使用真实 owner；原源码布局/VM atomic 断言转成真实模块行为。组合恢复 4/4 通过，包含业务已提交但 artifact settlement 故障、pending owner 冲突、原批次回放和二次重开。实际文件/SQLite 永久删除回归仍纳入全量检查。
- **当前规则入口**：模块说明的领域身份、settlement、暂存保护和恢复章节是现行入口；[run-scoped-data-policy](../../../../rules/run-scoped-data-policy.md) 与原数据路径/生命周期不变，无需另写存储规则。

## G2-T4 — 终态路由与 publication hooks

- **职责与边界**：[terminal registry](../../../../src/main-process/archive-center/terminal-route-registry.js) 成对冻结 normalizer/finalizer，Controller 只调用 registry。Position/Pending/BizOP/PreFund 各自实现领域注册；Main 装配四项。三个 operation live hook 由 `createAfterTerminal(route)` 使用实际 context 构造原 exact-5 owner，进入同一 finalizer。Toolbox/VCC adapter 只选择 receipt hook，仍注入原 G1 确认能力。
- **调用方与兼容**：四个历史 route 永久保留，trim、必填项、额外字段裁剪和未知 route TypeError 保持；无动态路由注册与生产旧 fallback。无 route 的 Controller 调用者默认冻结空 registry，测试要明确注入历史 route 夹具。Position live/replay 共享 owner 中同一收口函数，保留原不同 owner 校验和 replay 专用 checkpoint/cleanup。BizOP 保留 ACTIVE / 清库阶段 guard 与 `withLegacyRecovery`。
- **业务行为**：AC-05/06/07/08。receipt override 严格五项：toolbox merge、split export 及 VCC data-manager/import-audit/result export，须同时满足原 scope 与 publication-only 条件。`toolboxPublicationTaskIds || vccOutputPublicationTaskIds || []` 语义不变，其他域或 no-file 透传 prepared hook。错误 owner 不能 ACK，非成功终态不确认 receipt。
- **验证证据**：七文件 182/182，含真实 Pending SQLite receipt、BizOP 主/侧库 receipt、重复 ACK、owner 错配、legacy retired 与连接关闭屏障，见 [日志](evidence/terminal-route-tests.log)、[源快照](evidence/terminal-route-snapshot.json)。另一 Agent 对固定 G1 normalizer 与当前 registry/Controller 的 162 组持久化 payload 做独立差分，0 差异，原领域 finalizer 正文一致，见[逐样本结果与源摘要](evidence/terminal-compatibility-probe.json)、[独立审查证据](evidence/terminal-compatibility-review.log)。
- **当前规则入口**：模块说明“领域与兼容合同”描述四条数据兼容 route 和五项 ACK 条件；不会因 shim 删除而删除持久化路由。G1 恢复/确认入口继续引用 [application-recovery/README.md](../../../../src/main-process/application-recovery/README.md)。

## G2-T5 — 收口与组合验证

- **职责与边界**：删除旧 `runWithPreparedResourceCleanup` 及全部生产/测试调用方；不保留通用入口到 Position 的兼容转发。公共执行器、领域 owner 与中立目录边界由 composition 单测验证。未新建调度器或改动 TaskLifecycle。
- **调用方与兼容**：原 Main 布局断言、恢复 VM 和文件清理夹具随入口迁移到 owner/adapter/scope；继续保留业务和真实文件断言。历史 outbox schema、四 routes、原 legacy settlement 均保留。G8 机器规则待后续 G8 集成登记，本功能没有相应例外。
- **业务行为**：AC-01–09 的组合验证使用真实 TaskLifecycle、BOR、Archive SQLite/manifest/blob、outbox、Position adapter/owner、terminal registry 和 G1 coordinator。业务侧以隔离 SQLite ledger/checkpoint 代替 Excel 引擎。四故障场景：终态写入后 hook 失败、业务提交后归档失败、owner 错配、no-file 终态写入失败；成功恢复后再重开一次，确保不重执行业务、不新建 task/batch、不重复清 pending，blob bytes/hash/identity 保持。
- **验证证据**：[集成脚本](../../../../scripts/integration/task-adapter-recovery.js) **4/4 PASS**，见 [日志](evidence/task-adapter-recovery.log)。通过真实连接关闭重开验证，未模拟进程被强杀。最终完整 release-check 通过：8300 个单测通过、4 个 Windows 专用跳过、0 失败、0 TODO；62/62 集成脚本通过。旧 Main 布局夹具和 worktree node_modules 路径问题已按原行为约束修正并复验。
- **当前规则入口**：模块说明、根 AGENTS 导读、总索引 §6.4 已同步；TechDoc 补实际装配/诊断/live hook API，不改 Spec AC。G8 目前未集成，不能标为规则激活，也不能把 G8 缺席当作免除本分支验证。

## 验证环境、未执行项与回退

运行环境为 macOS arm64 / Node v25.8.0。每条命令显式使用本 worktree，测试只接触隔离 tmp / DB。worktree 的被忽略 `node_modules` 链接指向主工作区已有依赖，仅用于复用安装；历史隔离 clone 测试依赖该路径。不安装或升级依赖，不修改锁文件。

最终完整门禁于 **2026-09-20 22:49（Asia/Shanghai）通过，exit 0**，命令为 `UNIT_TEST_CONCURRENCY=4 npm run release-check`。四路文件并发仅限制本机负载，不筛选测试。完整日志见 [release-check.log](evidence/release-check.log)，机器可读结果见 [validation-status.json](evidence/validation-status.json)，交付状态见 [delivery-state.json](evidence/delivery-state.json)。

| 最终检查 | 结果 |
| --- | --- |
| lint / smoke | 均通过 |
| unit | 519 文件、831 suites；8304 tests = 8300 pass + 4 Windows skip；0 fail、0 cancelled、0 TODO；422742.778209 ms |
| integration | 62/62 脚本通过；带数字摘要的脚本合计 2587/2587，一项历史 nested-worker 脚本无数字计数；526172 ms |
| G1+G2 组合恢复 | 包含在完整 integration 内，4/4；真实临时 SQLite/archive/outbox 关闭重开，不等同于强杀进程 |
| 最终内容与补充静态检查 | [44 项 SHA256](evidence/source-snapshot.json)全部匹配；[43 项 JS 静态检查](evidence/final-code-lint.json) 0 error / 0 warning；git diff --check 与代码 patch 反向适用性检查通过 |

runner 仅在全 PASS 后自动更新 [integration-test-policy §七](../../../../rules/integration-test-policy.md)，本轮新增 `task-adapter-recovery.js` 并同步实际计数与耗时；未手改门禁阈值或跳过失败测试。

此前轮次均按原结果保留，不覆盖为 PASS：

| 轮次 | 当时结果、修正及证据 |
| --- | --- |
| 第一轮 | 已知旧布局/VM 断言及历史独立 clone 的 node_modules 路径失败后主动中止，exit 130；[原日志](evidence/release-check-initial-interrupted.log)。补复用依赖链接并迁移夹具，未安装或升级依赖。 |
| 第二轮 | 完整单测 8303 tests = 8295 pass + 4 fail + 4 Windows skip、0 TODO，exit 1；[原日志](evidence/release-check-layout-regressions.log)。四处剩余旧布局失败为 Acquiring resume、statement reader 闭包、VCC 生命周期选择、Pre-fund live hook，均只迁移测试且保留真实行为断言，定向分别 45/45、6/6、8/8 通过。Renderer 合同在本轮尚未加载该文件时迁移，定向 29/29 且本轮完整执行通过；初始与更新源快照均保留。 |
| 第三轮 | 单测 8299 pass / 4 Windows skip / 0 fail；integration 61/62，exit 1；[原日志](evidence/release-check-logging-regression.log)。唯一失败为新增 scope 的 console.error 违反现行日志规范，生产日志接线修正及独立复核见下节。 |
| 第四轮（最终） | 修正后重新冻结源码，完整运行通过，exit 0。运行期间未修改上述 44 项受验内容；代码与测试差异见 [code-diff.patch](evidence/code-diff.patch)。 |


按 CODEX 条件化风险规则核查 `important-variables.md` 中 archiveOperationTail 和 Position checkpoint/pending 条目；本次不改金额、匹配、存储路径或规则版本，因此不刷新无关全量变量统计。现行职责/退出顺序在任务适配说明维护。额外只读调用默认 E13-G checker 命中继承的 54 项历史文件与 67 项现行 authority drift；G1 [既有定位](../v3.2.10-application-recovery/implementation-notes.md)已记录同一基线问题，本次未改历史 JSON 或 production flags。历史独立 clone gate 在依赖路径补齐后 9/9 测试通过。

当前没有宣称 PR-ready、正式 GUI 或发布验收完成。未执行 Windows 文件占用/退出、真实 Electron 强杀恢复、Excel/WPS 和安装包验收；本次主要改动为内部任务编排，平台人工验证应由相应平台完成，不以 macOS fixture 代替。

没有已知需要更改 IPC/schema/金额逻辑的新增需求。用户尚未授权提交、推送、G2 合并、PR、升版或发布，因此不执行这些动作。回退遵循 TechDoc §5：退出屏障结束后整体回退本 G2 接线与模块差异；不删除 pending/journal/receipt/outbox 或业务侧库，不撤销已经固定的 G1 集成。历史证据与设计输入按来源区分，不误删主工作区资料。

### 完整门禁发现的日志接线修正

第三轮完整单测为 8303 tests / 8299 pass / 0 fail / 4 Windows skip；integration 为 61/62 脚本通过，唯一失败是 SR-log-1 禁止业务源码直接 console.error/warn，发现 scope 新增默认/兜底诊断用了 console.error。原日志保留为 [release-check-logging-regression.log](evidence/release-check-logging-regression.log)。已改为既有 `backend/logger.appendModuleLog`，继续共用 Main 配置的日志根和 graceful 处理；错误优先级、abandon 次数与资源状态未改。新增真实临时日志落盘断言，确认原错误和清理错误均可诊断。受影响三组 [44/44 PASS](evidence/resource-logging-fix.tap)，日志策略 [33/33 PASS](evidence/resource-logging-integration.log)。这是本次实现的日志接线修正，未放宽原集成门禁；第四轮完整门禁已验证修正后的源码快照并通过；没有以定向测试替代完整复验。
