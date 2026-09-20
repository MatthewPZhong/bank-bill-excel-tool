# G1 实施记录

本记录是切片实现、验证、集成状态的唯一索引；设计依据为 [Spec](spec.md)、[TechDoc](techdoc.md)及[总索引 §6.2–§6.4](../../README.md#slice-completion)。设计状态与本次实施证据分别保留。当前代码说明见[应用恢复 README](../../../../src/main-process/application-recovery/README.md)，独立审查及关闭证据见[实施审查](implementation-review.md)。

## 代码与运行边界

- 分支：`codex/v3.2.10-application-recovery`。
- worktree：`/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/v3210-application-recovery`。
- 基线 / HEAD：`11086a3cbf632a30adbcfa796e4cd81810c5aef9`（本地 main / v3.2.9）；代码为该 HEAD 上未提交差异。最终差异见[code-diff.patch](evidence/code-diff.patch)，文件摘要见[source-snapshot.json](evidence/source-snapshot.json)。
- 主工作区中尚未提交的 G1 Spec/TechDoc、总索引及直接审查材料已复制到本 worktree；来源仍是用户给定的主工作区绝对路径。本功能未修改主工作区设计文件。
- 实现、验证、集成分列。没有提交、推送、开 PR、合并、升版或发布；所有切片均未集成到 release。
- 环境：macOS、Node v25.8.0；复用已有 node_modules。测试使用隔离临时目录/SQLite/journal，不以真实用户数据做恢复实验。

## 最终验证结论

`UNIT_TEST_CONCURRENCY=2 npm run release-check` **exit 0 / PASS**：lint、smoke、单测和全量集成均通过。单测 **8167 passed / 8171 total、0 fail、0 cancelled、4 skipped**；4 项跳过均依赖 Windows PowerShell 或 Windows packaged canary。**61/61 个集成脚本通过**，runner 清单可解析计数为 **2583**。完整原始输出见 [最终门禁日志](evidence/release-check-final.log)，机器摘要见 [verification-summary.json](evidence/verification-summary.json)。

集成 runner 仅在全通过后自动更新 [rules/integration-test-policy.md §七](../../../../rules/integration-test-policy.md#七当前集成测试清单自动同步)，新增本项脚本并刷新当次清单及耗时；专项规则正文没有变更。

## 切片状态

| 切片 | 实现 | 验证 | 集成 | 本次范围与剩余 |
| --- | --- | --- | --- | --- |
| G1-T1 | 已实现 | 通过（含最终完整门禁） | 未集成 | normal/deferred/owner 失败/activation 行为断言，完整本地门禁另列 |
| G1-T2 | 已实现 | 通过（含最终完整门禁） | 未集成 | 应用协调器、participant、平台事实唯一写入者与 Duplicate 迁移 |
| G1-T3 | 已实现 | 通过（含最终完整门禁） | 未集成 | 原 Archive hook 顺序、outbox、失败聚合和 post-outbox |
| G1-T4 | 已实现 | 通过（含最终完整门禁） | 未集成 | 全入口及资源闭包聚焦验证通过；扩展 Archive 最终 52/52 PASS |
| G1-T5 | 已实现 | 通过（含最终完整门禁） | 未集成 | 原 raw/shim 迁移，生产与测试入口已迁移；最终 publication 127/127、旧 fixture 26/26、Main 接线 15/15、VCC 双 Writer 8/8 通过；最终完整门禁 PASS |

G1-T1—T5 的实现、各切片五项记录及本机适用自动验证均已完成；最终完整门禁 PASS。所有切片仍未集成。Windows 专属测试的 4 项条件跳过、真实 Electron/Windows 人工验收和 G8 后续激活不计为已完成。

## G1-T1：固定原恢复行为

- **职责与边界**：`application-recovery.test.js` 的 phase spy 与临时 SQLite/Archive Controller 组合 fixture 固定应用阶段合同；业务 ready/hold 仍由原模块写入，测试不模拟一个新的业务状态所有者。
- **调用方与兼容**：复用原 Archive Controller、BizOP driver/activation、Duplicate 与 VCC migration；既有接线断言更新到公开 application snapshot，原预算和保护闭包测试继续运行。
- **业务行为**：对应 G1-AC-02/03/06。normal、资源 deferred、有/无来源、activation 的事件顺序；owner 失败继续后续 owner/post-owner replay，原启动阻断仍生效。
- **验证**：应用/原模块组合 112/112；BizOP 原资源/发布/owner 36/36；临时 SQLite 启动重启 4/4。具体命令和日志见下表。真实 Electron/Windows 不在这些证据范围内。
- **当前规则入口**：[模块 README「应用阶段和 G2/G7 接口」](../../../../src/main-process/application-recovery/README.md#应用阶段和-g2g7-接口)；根 AGENTS 导航已增加。未改资源政策正文，因为预算、排队期限和退出合同未变；G8 尚未集成。

## G1-T2：应用协调器与 participant

- **职责与边界**：原 `biz-op-v327/recovery-driver.js` 不再保存或暴露平台扫描完成事实；`application-recovery/coordinator.js` 是 phase/platformScanCompleted 唯一写入者。`platformFacade` 转发原平台扫描，成功返回才记录完成。`biz-op-v327/recovery-participant.js` 封装原业务 preflight/owner/post-outbox 行为，不写应用阶段。
- **调用方与兼容**：Main 建立 composition；Duplicate 从 application snapshot 读取平台事实；删除 `hasCompletedPlatformScan` 业务访问。协调器保留原错误码、单飞、成功 hook 不重复、失败 hook 显式可重试；无旧 getter 转发 shim。
- **业务行为**：对应 G1-AC-01/02/07。扫描成功不等于业务 hold 解除；`ARCHIVE_OWNER_PHASE_REQUIRED` 沿原规则可继续。应用 ready 必须等待完整 Archive 初始化且扫描完成。
- **验证**：112/112 组合测试及 4/4 重启集成覆盖上述阶段与实际 SQLite/outbox；真实 5 秒期限和预检/owner 连续性由原 BizOP 场景复用。不会将 phase 字面量出现当作业务行为证据。
- **当前规则入口**：模块 README 的实际 coordinator/composition/participant 接口；AGENTS 只导航。G8 后续维护 `ARCH-BIZOP-RECOVERY-PRIVATE`，Main 静态装配是合法入口，业务深引不是例外。

## G1-T3：Archive hooks 装配

- **职责与边界**：`application-recovery/composition.js` 固定 participant 顺序；Controller 继续拥有 hook 失败聚合、owner 后重放、outbox、interrupted sweep。Main 只在原 initialize Promise 成功/失败后通知协调器，不把领域失败降为新全局策略。
- **调用方与兼容**：owner 顺序 BizOP → Pending → legacy BizOP → Pre-fund → Position → Toolbox/VCC publication → VCC import terminal；post-outbox 为 BizOP activation → VCC lineage。hookName 可单独保留原日志名，Controller hook 对象形状兼容。
- **业务行为**：对应 G1-AC-02/03/06。失败 owner 后继续原后续 owner，不能提前启用窗口/IPC；activation 保持先 quiesce、再 owner、后 outbox 重放和 retry。业务 ready=false 保持原保护诊断，不新增降级策略。
- **验证**：112/112 中真实 SQLite/outbox 失败/activation/post-outbox 测试；4/4 集成含合法 committed receipt 两次重启不重复接管及未知 owner 启动后后续 owner 仍执行。
- **当前规则入口**：模块 README 的固定注册表与 G2/G7 接口；没有修改 Controller 的终态路由合同。G2 后续应向同一 Controller 装配 registry，G7 只汇总 participant。

## G1-T4：副作用前 owner 授权和入口迁移

- **职责与边界**：`publication-recovery/coordinator.js` 只做 owner registry、全根决定、grants 与受限 facade，不执行业务 SQL。Archive 与 BizOP owner 分别核对原持久化证明；`worker-authority.js` 为 Main 私有签名边界。dispatcher FIFO 内先 discover，Main 对完整记录集合识别/授权，再由 execute worker 在生命周期互斥内重验完整摘要，之后才运行原恢复算法。
- **调用方与兼容**：Main 启动、Toolbox/VCC live handoff/receipt ack、BizOP reconcile/ack/retry、NewAccount save-as、mature recovery、publish preflight、transport-error 均迁移。完整静态 producer 表见模块 README，共 16 个 taskKey/moduleId 配对，包含实际 Position 两入口及 NewAccount 专用 proof。尚未启用的 Statement seam 只接受显式 Publisher 注入，未开放生产策略。
- **业务行为**：对应 G1-AC-04/05/07/08/09。未知/冲突/缺 grant/摘要漂移在首个恢复写入前拒绝；五类材料保持。committed 观察、ack-stage、ack-finalize 分权；stage 保留 receipt。deferred/active/没有受信任完整 observation 不等于 journal 不存在，BizOP 保留 ACK_PENDING 和 staging；只有完整 absence 加原 durable proof 才幂等确认。Archive 三阶段保留全根 deferred，只有同 task/owner 明确 commit-cleanup 清除先前未决。
- **资源闭包**：沿用 BizOP CPU1/worker1/IO1/1 GiB、5 秒等待；固定不足立即拒绝。observation 在 enqueue 前申请、实际 worker exit 后释放；借用 capability 绑定 root/task/nonce/kind/closure，不重复租约；publish 内部恢复在当前 FIFO 项执行，不等待自身队列。
- **验证**：owner/core 101/101、dispatcher 12/12、BizOP 36/36、Archive/rows 33/33、Toolbox Archive 11/11、NewAccount/VCC 121/121、真实 producer proof 3/3；新集成 4/4、rows 删除集成 2/2。扩展 Archive 删除初次 15/52 后因磁盘空间不足阻塞，空间回升后以原代码/原准入复跑，最终 **52/52 PASS**；两个运行分别留证。
- **当前规则入口**：模块 README「publication owner 与权限」「Archive producer 与证明来源」「边界与验证入口」，并链接实际 owner 和 core。G8 后续激活两条既定规则，本分支仅记录入口库存和真实行为测试，没有伪造 boundaries.json active。

## G1-T5：兼容入口与验证调用方清理

- **职责与边界**：删除 `recoverToolboxPublicationsAsync` 导出、BizOP `recoverOtherOwners` 与平台 getter；所有业务 fallback 不再绕过 facade。dispatcher `.recover()` 只保留固定拒绝诊断，不能进行恢复；core raw recover/prepare 缺私有授权拒绝。
- **调用方与兼容**：老合成 journal fixture 使用 `tests/helpers/publication-authority.js` 的测试专用 authority；真实业务验证继续使用生产 Archive/BizOP owner。适用脚本、跨进程 fixture、rows 准入及容量脚本已迁移；没有降低 production 证明要求来适配测试。mature 与 Statement 的 production-disabled 状态维持。
- **业务行为**：对应 G1-AC-01/06/07。测试仍验证原发布、取消、目标保护及恢复行为；不以替换字符串检查代替入口授权测试。独立审查的 Position 注册、NewAccount 角色、Statement raw seam 三项已修正并有回归。
- **验证**：Statement 22/22 与独立精确复现 2/2；producer 3/3；最终 publisher/core/owner/dispatcher/mature 127/127；旧 fixture 三文件 26/26；Main/PreFund 15/15；VCC 双 Writer 8/8；最终入口库存已完成；R4 provenance 独立复测 2/2。初始迁移失败日志保留在 evidence 中，不覆盖成一直通过。最终复核还修复 R4：历史 plain prepared 可跳过 prepare 的旁路，现以私有 WeakMap 绑定授权 prepare 原对象及 scope，单次消费；对应回归先 RED 后 GREEN。
- **当前规则入口**：模块 README 明确 core/worker/dispatcher 允许范围、测试 helper 的适用范围、拒绝 shim。AGENTS 导航与 G1 TechDoc 的实际 producer 补充同步；其余长期业务规则无需更改。G8 集成时撤销旧 raw fallback 例外。

## 验证证据

下列命令全部在本文记录的 worktree 工作目录执行。日志数字各自计数、有交叉覆盖，不相加宣称独立总数。最终代码状态由交付快照固定；初始失败证据用于说明修复过程。

| 命令或测试组 | 结果 | 日志 |
| --- | --- | --- |
| 应用 coordinator、Archive Controller、Duplicate、Biz lineage、VCC migration 组合（准确命令补在 evidence/commands.txt） | 112/112 PASS | [应用组合](evidence/g1-application-stable-tests.log) |
| 最终 publisher/core/owner/dispatcher/mature 四文件（命令见 [commands.txt](evidence/commands.txt)） | **127/127 PASS**，包含最终 R4 修复 | [最终 publication](evidence/publication-final-tests.log) |
| `node --test tests/unit/main-process/publication-recovery-owner.test.js tests/unit/toolbox-output-publication.test.js` | 101/101 PASS | [owner/core](evidence/g1-core-final.log) |
| `node --test tests/unit/main-process/toolbox-output-publication-dispatch.test.js` | 12/12 PASS | [dispatcher](evidence/g1-dispatch-final.log) |
| BizOP export-main、startup-resource、phase-admission、publication-owner（准确命令见 commands.txt） | 36/36 PASS | [BizOP](evidence/bizop-publication-combined.log) |
| NewAccount save-as + VCC recovery/single-writer | 121/121 PASS | [NewAccount/VCC](evidence/g1-newaccount-vcc-tests.log) |
| `node --test tests/unit/main-process/publication-recovery-archive-owner.test.js tests/unit/main-process/toolbox-row-split.test.js tests/unit/main-process/toolbox-multi-split-ipc.test.js` | 33/33 PASS | [Archive/rows](evidence/g1-archive-rows-tests.log) |
| `node --test tests/unit/main-process/toolbox-archive-integration.test.js` | 11/11 PASS | [Toolbox Archive](evidence/g1-toolbox-archive.log) |
| `node --test tests/unit/main-process/publication-recovery-producer-contracts.test.js` | 3/3 PASS | [实际 producer proof](evidence/g1-review-producer-contracts.log) |
| `node --test tests/unit/main-process/statement-generation-e09-c.test.js` | 22/22 PASS | [Statement seam](evidence/g1-statement-seam.log) |
| `node scripts/integration/application-recovery-governance.js` | 最终代码 **4/4 PASS** | [恢复集成](evidence/governance-final-integration.log) |
| `node scripts/integration/toolbox-row-split-admission.js` | **2/2 PASS**，768 MiB 立即拒绝 1 GiB、2 GiB 正向真实 Worker/Publisher | [rows 准入](evidence/rows-admission-authority-green.log) |
| `node scripts/integration/toolbox-row-split-archive-delete.js` | 2/2 PASS | [rows 集成](evidence/toolbox-row-split-archive-delete.log) |
| `node scripts/integration/archive-center-permanent-delete.js` | 最终 **52/52 PASS**；初次磁盘阻塞日志保留 | [最终扩展 Archive 集成](evidence/archive-center-permanent-delete-final.log) |
| `UNIT_TEST_CONCURRENCY=2 npm run release-check` | **PASS / exit 0**；8167 passed、0 fail、4 Windows skipped；61/61 integration scripts | [最终完整门禁](evidence/release-check-final.log) |
| `UNIT_TEST_CONCURRENCY=4 npm run release-check` | **FAIL / exit 1**；lint、smoke 通过，unit 8138/8170 PASS、28 fail、0 cancelled、4 skipped；未进入全量 integration。失败处置见下文 | [初始完整门禁](evidence/release-check-initial.log) |

## 完整门禁失败处置

初次完整门禁运行约 17 分钟，512 个单测文件，8138/8170 PASS、28 个失败；原始输出完整保留，没有用后续聚焦结果改写总数。最终状态逐项记录；初次 28 个失败已分别完成修复或独立复测，但这些结果不能合并成一次完整门禁 PASS：

| 初次失败组 | 数量 | 处置与证据 |
| --- | --- | --- |
| mature 请求仍带 root；ReconFix 与 rows dispatcher 缺 authority；Main/PreFund 仍按旧内联文本判断；VCC dual Writer 缺 recovery 依赖 | 12 | 已迁移测试合同且保留原业务断言。最终 127/127 publication 组、[26/26 旧 fixture](evidence/fixture-authority-green.log)、[15/15 启动接线](evidence/startup-prefund-contract-final.log)、[8/8 双 Writer](evidence/vcc-dual-writer-targeted-final.log) PASS；没有为测试放宽生产 proof。 |
| R3.2.5 历史发布证据被现行生成器刷新后与 exact-54 合同冲突 | 13 | 撤销本任务四份历史文件的生成修改，当前生成结果单独留证；[历史 25/25 PASS](evidence/historical-v325-final.log)。 |
| BizOP 1024 来源恢复返回 ERR_SQLITE_ERROR | 1 | 原 driver 未保留初次 SQLite message，不断言具体磁盘因果。原代码原测试独立 [1/1 PASS](evidence/bizop-scale-1024-targeted.log)：2 scans、3072 Inspector、1024 completed。 |
| VCC 1100 长文本 SST fixture 的 SQLite 报 database or disk is full | 1 | 明确环境失败；保持原代码与 64 MiB 预算独立复测 [1/1 PASS](evidence/sst-budget-isolated-final.log)，实际 1100 条长文本、spill 清理和只读保护均通过。 |
| R3.2.3 历史候选 checkout 返回 128 | 1 | 初次仅有 HISTORICAL_CANDIDATE_GIT_CHECKOUT_FAILED；原测试独立复测 [1/1 PASS](evidence/historical-v323-isolated-final.log)，没有修改历史验证器或由返回码推断确定因果。 |

扩展 Archive 集成初次执行到 15/52 后被 Position 磁盘准入阻塞，不属于上表 unit 计数；空间回升后以原代码/原准入复测已 **52/52 PASS**。最终 `UNIT_TEST_CONCURRENCY=2 npm run release-check` 已以 exit 0 完整通过，结果记录在 [release-check-final.log](evidence/release-check-final.log)。

## 决策、偏离与未覆盖项

1. 不新增 schema 或持久化版本；原记录可读，但未知/冲突/不足 proof 的自动清理按设计有意收紧。
2. 测试计划中的 `publication-recovery-entrypoints.test.js` 场景落在 owner、dispatcher、BizOP、Archive、NewAccount/VCC、mature、Statement 和重启集成文件中，以实际入口覆盖为准，没有重复建一个文件名占位。
3. 实际调用库存补出 Position 两入口；NewAccount proof 沿已有专用 role/sourceOperation，不错误套通用 input/output。TechDoc 和当前规则表已同步，未新增业务 owner 权限。
4. 现行 manifest 生成器仍写入历史 v3.2.5 路径。最初刷新成 67 actions 后，冻结历史校验器明确要求 54 actions，造成完整门禁 13 个历史用例失败。已撤销本任务对四份历史 JSON 的生成修改并核对与 HEAD 相同，历史测试恢复 25/25 PASS。现行 67 项结果仅保存在 [manifest-current](evidence/manifest-current/e13-g-action-manifest.json)，验证输出 402/402 surfaces、74 legacy pairs、13 production enabled；没有修改 policy/feature flag。默认现行 checker 与冻结路径冲突的只读失败保留在 [日志](evidence/manifest-historical-conflict.log)，不靠重写历史证据或放宽历史验收解决该问题。 独立以 `11086a3c` 精确归档源码复现相同 drift，基线/当前均生成 67 actions，manifest/binding/policy 摘要相同；因此 67/54 冲突是基线既有问题，证据见 [manifest-baseline-triage.json](evidence/manifest-baseline-triage.json)。Main/runtime 的正常源码指纹变化另行记录。
5. 本机磁盘空间曾不足（仅数百 MiB），阻断扩展 Position 集成和 SST SQLite 写入。未降低存储准入或删除用户/其他任务文件；空间回升后两者原代码复测通过。初次完整门禁保留 FAIL，最终以并发 2 完整复跑并 PASS；没有删除初次失败或将分批结果拼成最终门禁。
6. 没有执行真实 Electron 隔离冷启动、Windows 文件锁/安装包/平台耐久性、Excel/WPS 人工验收；完整单测中 4 项 Windows 专属用例按既有条件跳过。已执行真实 Node worker exit、子进程 crash/reopen 与临时 SQLite；这些证据不替代上述平台验收。
7. `verify-toolbox-row-split-capacity.js` 仅迁移授权 fixture，未重跑 1000 输出容量实验，不作性能或容量提升声明。
8. 回退遵循 TechDoc：应用装配迁移可回到原控制流程，但不能在本轮中单独撤销授权 gate 或恢复业务 raw fallback。当前尚未集成，需整体审查相关 source/测试/文档差异后再执行后续集成指令。

## G2 / G7 交接

实际接口与当前规则以[模块 README](../../../../src/main-process/application-recovery/README.md)为准。G2 沿同一 Archive Controller 的终态/owner 合同接入，不将 task adapter ready 作为全局 ready。G7 可静态汇总 `createApplicationRecoveryComposition` 的 participants（id/ownerName/hookName/preflight/recoverOwner/postOutbox）及 Main 注册的 publication owners；只取得 root/owner 绑定 facade，不写阶段、业务 proof 或预算。

本次交接是未提交功能分支实现及实际测试证据，不表示 G2/G7 已集成，也不自动激活 G8。
