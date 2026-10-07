# 固定基线与证据索引 — v3.2.12 业务 OP 升级阻断启动修复

<!-- document-identity
 document-id: v3.2.12-fix-bizop-upgrade-startup/baseline-evidence
 target-version: v3.2.12
 branch: fix/bizop-upgrade-startup
 baseline: 52b92b55c3d91f7a431ff62419e8712a6ed1774e
 revision: R2
-->

> 基线：`52b92b55c3d91f7a431ff62419e8712a6ed1774e`（`v3.2.11` 标签解引用后的提交，即分支创建时的本地 `main`）；核验日期：2026-10-06。
> 目标版本：v3.2.12；功能分支：`fix/bizop-upgrade-startup`；文档修订：R2（2026-10-06 按评审补充 S13–S15）。
> 本文件只记录来源、现状和复现结果，不维护需求或实施状态。方案见 [Spec](spec.md)／[TechDoc](techdoc.md)，实施过程见 [实施记录](implementation-notes.md)。

## 证据使用方式

- 行号均指基线提交中的文件。每条证据标注 **事实**（代码、git、运行结果直接证明）、**推断**（由事实得出的最可能解释）或 **未知**（尚缺证据）。
- 动态复现在 macOS arm64、Electron 36.9.5 开发模式下进行，用 [repro-harness](evidence/repro-harness/README.md) 把资格身份模拟为 win32/x64，并把内存固定为 16 GiB 总量、5 GiB 可用。用户数据目录和文档目录都隔离到临时目录，没有触碰任何真实用户数据。
- 本轮没有拿到报障用户的日志、userData 或 Windows 机器。S01 是用户口头报告，不是机器证据。

<a id="s01"></a>
## S01 — 用户报告

**事实（用户提供）**
- 报错原文：`biz-op-v327：[BIZOP_ACTIVATION_RESOURCE_UNAVAILABLE] 业务 OP 升级需要 1024 MiB 后台内存预算，当前可用 4096 MiB（预算上限 4096 MiB），或后台执行槽位正被占用。请关闭不需要的程序后重新启动；现有迁移进度已保留。`
- 机器：Windows x64，12 个逻辑核心，16 GB 内存，空闲约 5 GB。
- 升级路径：从 **3.0.26** 升级到 3.2.11，更新后立即打开。
- 现象：**每次启动都失败**。

**推断**：预算上限 4096 MiB 等于 16 GiB 的 1/4，与 v3.2.11 的硬预算公式一致（S05），说明用户运行的是带内存准入的 3.2.11。

<a id="s02"></a>
## S02 — 基线、分支与工作区

**事实**
- `git rev-parse v3.2.11^{commit}` 与分支创建前的 `HEAD` 都是 `52b92b55`；工作区干净。
- 本分支由 `git switch -c fix/bizop-upgrade-startup 52b92b55…` 在本地创建，未推送。
- 版本与分支约定见 `AGENTS.md` 第 65–71 行；文档存放规则见 `.agents/skills/save-spec/SKILL.md`。

<a id="s03"></a>
## S03 — v3.2.11 引入的准入路径变化（回归来源）

**事实**（`git cat-file -e <tag>^{commit}:<path>`）

| 文件 | v3.2.6 | v3.2.7 | v3.2.10 | v3.2.11 |
| --- | --- | --- | --- | --- |
| `src/main-process/biz-op-v327/upgrade-main.js` | 无 | 有 | 有 | 有（与 v3.2.10 相同） |
| `src/main-process/background-execution/memory-admission.js` | 无 | 无 | 无 | **新增** |
| `src/main-process/background-execution/memory-activity.js` | 无 | 无 | 无 | **新增** |
| `src/main-process/execution-descriptors/memory-profiles.js` | 无 | 无 | 无 | **新增** |
| `src/main-process/execution-descriptors/memory-qualification.json` | 无 | 无 | 无 | **新增** |

- `git diff v3.2.10 v3.2.11 -- src/main-process/background-execution/runtime.js`：调度器预算由 `createPlatformResourceBudgets`（兼容预算）改为“传入 `createMemoryAdmission` 时使用 `hardBudgets` 并装配内存准入”（`runtime.js:67`）。
- 同一 diff 下，`execution-descriptors/composition.js:211` 新增 `createMemoryAdmission: createProductionMemoryPolicy`，即生产环境固定装配内存准入。
- `CHANGELOG.md` 3.2.11 条目：“生产低内存档按已有人工确认启用”。

**推断**：升级预检代码没有变化，变化的是准入规则。按用户机器计算，v3.2.10 的兼容预算为 min(4096, 5 GiB − 2 GiB) = 3072 MiB，1024 MiB 的申请可以通过；v3.2.11 改走严格路径（S05）。

<a id="s04"></a>
## S04 — 升级预检与报错文案

**事实**（`src/main-process/biz-op-v327/upgrade-main.js`）
- `acquirePrecheckCapacity`（第 199–217 行）以 `resources: EXPORT_IO_RESOURCES, lowMemoryBehavior: 'reject', timeoutMs: 0` 申请（第 206 行）。捕获 `RESOURCE_BUDGET_UNAVAILABLE` 或 `ADMISSION_TIMEOUT` 后，丢弃原错误，用 `runtime.resourceGovernor.snapshot()` 的 `available` 和 `budgets` 拼出文案（第 209–213 行），“1024 MiB”是写死的。
- `EXPORT_IO_RESOURCES` 为 1 CPU、1 Worker、1 I/O 槽、1 GiB 内存（`publication-owner.js:11-12`）。
- 已 ACTIVE 时直接 `verifyActive` 并返回，不做预检（第 224–227 行）。续跑路径在第 235 行预检，首次路径在第 241 行预检。
- 两轮旧数据扫描：第 124–125 行注释与代码“先完整检查路径和旧 schema，再允许原 provider 打开侧库”，执行 `scan(context, false)` 后调用 `recoverLegacy`；第 137 行在 `LEGACY_QUIESCED` 阶段执行严格的 `scan(context, true)`，并据此授权清理。
- 诊断日志只记录带 `memoryProfile` 的 `resource-granted` / `resource-released`，`resource-rejected` 被过滤（`src/main.js:832-838`）。

<a id="s05"></a>
## S05 — 预算、资格与内存准入

**事实**
- 存在内存准入时使用硬预算，内存上限 = max(768 MiB, totalmem/4)；兼容预算为 min(硬上限, freemem − 2 GiB)，在 runtime 创建时只计算一次（`resource-budget.js:33-74`）。
- `biz-op-v327:upgrade-preflight` 被映射到 `bizop-maintenance` 档：普通档 384 MiB、低内存档 128 MiB，系统保留分别为 192 MiB / 128 MiB（`memory-profiles.js:25`、`:28-56`）。
- 资格清单只认 `win32` + `x64`（`memory-evidence.js:44`）。本地重算 18 个 profile 的 `policyDigest`，与 `memory-qualification.json` 全部一致。Windows 包为 `--x64` 构建（`package.json` 的 `dist:win*` 脚本，`build-windows.yml`、`release-windows.yml`）。
- `evaluate` 中，只要活动租约或外部阻塞项里有任何一项 `maxGrowthBytes` 为 null，就直接返回 false，且发生在系统内存采样之前（`memory-admission.js:92-111`）。
- 调度器在队列为空时立即尝试；尝试被推迟且 `lowMemoryBehavior` 为 `reject` 时，立即以 `RESOURCE_BUDGET_UNAVAILABLE` 拒绝（`resource-governor.js:413-425`）。队列非空时，`timeoutMs: 0` 的请求在 `expireDueEntries` 中立即超时（`admission-queue.js:125-134`）。
- 主进程和后台 runtime 的 Worker/子进程都会登记为增长未知的载体，直到 `exit` 事件才移除（`background-execution/memory-activity.js:44-53`；runtime 适配器 `adapters/worker-thread-adapter.js:108`）。

<a id="s06"></a>
## S06 — 失败位置

**事实**
- 存档控制器把 owner 失败聚合为 `ARCHIVE_STARTUP_OWNER_RECOVERY_FAILED`，`detailLines` 格式为 `${ownerName}：[${code}] ${message}`，并附带原错误的 `detailLines`（`controller.js:316-317`）。启动失败对话框只展示 `detailLines`，最多 20 行（`src/backend/startup-failure.js:13-37`）。
- post-outbox 钩子失败会包装为 `ARCHIVE_STARTUP_HOOK_FAILED`，不带 `detailLines`，对话框只显示“存档启动校验未完成：BizOP activation and recovery”。
- BizOP 是第一个 owner。`recoverOwner` 调用 `activation.run({ quiesceOnly: true })`（`recovery-participant.js:16`），post-outbox 阶段调用 `retryRecovery`（`module.js:188`）。

**推断**：用户看到的 `biz-op-v327：[…]` 只可能来自 owner 阶段，也就是本次启动的**第一次**升级预检。

首次升级的那次启动实际会预检两次，post-outbox 入口的失败会丢掉明细，见 [S13](#s13)。

<a id="s07"></a>
## S07 — 用户机器条件排除表

| 候选原因 | 对用户机器的判断 | 依据 |
| --- | --- | --- |
| 兼容上限不足 | 排除（x64 走已验收档，不受兼容上限约束） | S05 |
| CPU 槽位不足 | 排除（12 核对应 cpuSlots = min(4, 12−2) = 4） | `resource-budget.js` |
| 系统内存不足 | 基本排除：普通档需 ≥ 576 MiB，低档需 ≥ 256 MiB，用户约 5 GB | S05 |
| 增长未知的活动或载体、其他租约、队列前序 | **唯一剩余的一类**，但本地复现中从未出现（S09、S10） | — |

<a id="s08"></a>
## S08 — 生产内存策略探针

**事实**（[precheck-policy-probe.js](evidence/repro-harness/precheck-policy-probe.js)，真实 `createProductionMemoryPolicy`，模拟 Windows x64 / 16 GiB / 5 GiB，沿用原参数 `reject + timeoutMs:0`）

| 现场 | 结果 |
| --- | --- |
| P1 冷启动空闲 | 获批，实际 384 MiB |
| P2 存在一个尚未发出 `exit` 的受观察载体 | 拒绝 `RESOURCE_BUDGET_UNAVAILABLE`；原文案会显示“当前可用 4096 MiB（预算上限 4096 MiB）”，与用户报错一致 |
| P3 该载体 `exit` 之后 | 获批，384 MiB |

<a id="s09"></a>
## S09 — 真实启动复现（5 个场景 + 2 次重启）

**事实**（[startup-scenarios-2026-10-06.json](evidence/traces/startup-scenarios-2026-10-06.json)）

| 场景 | 数据来源 | 预检现场（两次） | 结果 |
| --- | --- | --- | --- |
| S1 | 全新 userData | 载体 0 / 租约 0 / 排队 0 | 升级到 ACTIVE，窗口创建 |
| S2 | v3.2.6 生成的 userData | 同上 | 成功 |
| S3 | v3.2.6 加 3 个旧月度文件（v3.2.6 建表） | 同上；inspect/reclaim Worker 均在下一步前正常退出 | 成功 |
| S4 | v3.0.26 生成的 userData | 同上 | 成功 |
| S5 | v3.0.26 加 3 个旧月度文件（v3.0.26 建表） | 第一次预检获批 | **失败：`BIZOP_LEGACY_SCHEMA_INCOMPLETE`** |
| S5-R2、S5-R3 | 同一 userData 重启 | 续跑预检获批 | **每次同样失败** |

- 每个场景里，调度器都是在第一次预检调用 `host.getRuntime()` 时才创建（runtime 懒创建单例，`runtime.js:375`），所以那一刻不可能存在租约或排队。
- `RESOURCE_UNAVAILABLE` 在所有本地场景中**均未复现**。

<a id="s10"></a>
## S10 — 第一次预检之前不存在阻塞来源（静态排除）

**事实**

| 来源 | 结论 | 依据 |
| --- | --- | --- |
| 业务 IPC（`runMemoryActivity` 包装） | 预检时尚未注册 | `action-task-binding-registry.js` 的 `run()` 先 `initializeDatabase()` 再 `registerIpc()` |
| 其余 `runMemoryActivity` 调用 | 全部晚于预检 | `main.js:4609`（更新检查，窗口创建后由 `:21628` 调度）、`:21658`（`runStartupPostSetup`，在 `:21566`）、`:21993`（IPC/空闲定时器） |
| 启动链本身 | 没有包在活动作用域内 | 同上 `run()` |
| 活动清单是否完整 | 模块加载时即封存 | `main.js:577` |
| 更新服务初始化 | 只加载 electron-updater，不起载体 | `app-updater.js:223-263` |
| run-check 线程池 | 懒加载，不预热 | `run-check-worker-pool.js:6` |
| 常驻服务（3 类 service policy） | 按请求才启动 | `service-host.js:1576`、`:1717` |
| 发布调度器 | 每个任务临时起 Worker，用完终止 | `toolbox-output-publication-dispatch.js:53-127` |
| 启动恢复 provider/inspector（6 个） | 不使用 runtime，也不起 Worker | `duplicate-inbound-match/startup-recovery.js` 等，逐个 grep |
| BizOP 恢复源 | 同上 | `recovery-sources.js` 等 6 个文件 |
| VCC 存储迁移 Worker | 协调器未被调用 | 全仓 grep `createVccStorageMigrationCoordinator` |
| Windows 专属分支 | 只有 `setAppUserModelId` | `main.js:750` |

**推断**：在原版 3.2.11、Windows x64、空闲 5 GB 的条件下，owner 阶段的第一次预检理论上应当通过。用户每次失败，说明存在本地无法观察的因素（Windows 运行时行为或用户真实数据）。

<a id="s11"></a>
## S11 — 旧业务 OP 月度文件的 schema 世代（`BIZOP_LEGACY_SCHEMA_INCOMPLETE`）

**事实**
- 第一轮扫描要求月度文件 6 张表齐全（`upgrade-legacy.js:73`，表名见 `:10-11`）；`quiescent` 分支查询 `biz_op_recon_runs.archive_contract_version`（`:74-78`）。月度文件以只读方式打开（`:92`）。该检查由 `cedd713b`（2026-09-06）引入，自 v3.2.7 起生效。
- 各标签中 `run-data-store.js` 与 `biz-op-recon-db/migrations.js` 是否含相关定义：

| 标签 | `archive_contract_version` | `biz_op_recon_dataset_heads` | `month_end_copy_intents` |
| --- | --- | --- | --- |
| v3.0.26 / v3.1.0 / v3.1.5 / v3.1.10 | 无 | 无 | 无 |
| v3.1.11 / v3.1.12 / v3.1.13 / v3.1.14 / v3.2.x | 有 | 有 | 有 |

- 实际结构对比（[side-db-upgrade-probe.js](evidence/repro-harness/side-db-upgrade-probe.js)）：

| 状态 | 表 | `archive_*` 列 | 触发器 | 第一轮 | 第二轮 |
| --- | --- | --- | --- | --- | --- |
| v3.0.26 建表、原样 | 4 张（加 `sqlite_sequence`） | 无 | 0 | `SCHEMA_INCOMPLETE` | `SCHEMA_INCOMPLETE` |
| 经当前 `openSideDb` 打开一次后 | 6 张（加 `sqlite_sequence`） | 3 列 | 7 | PASS | PASS |

- 两轮扫描之间的 `recoverLegacy` 调用 `recoverBizOpRunsBeforeInterruptedSweep`（`main.js:4869-4874`），其中 `recoverRunReceipts`（`biz-op-recon-run-data.js:917-920`）对**每个**月度文件调用 `openSideDb`；后者对业务 OP 执行 `ensureBizOpReconTablesSupport`（`run-data-store.js:1041-1052`），补齐表、列和触发器，原有行保留。
- CI 的 Windows 正式包验收用 `tests/helpers/biz-op-v327-upgrade.js` 的 `seedLegacy` 造旧数据（`scripts/biz-op-v327/verify-windows-app.js:126`），而 `seedLegacy` 用当前代码建月度文件，因此从未覆盖 v3.1.10 及以前的格式。

**推断**：从 v3.1.10 及更早版本直接升级、且有业务 OP 旧月度文件的用户，在 v3.2.7–v3.2.11 中每次启动都会被第一轮扫描阻断。报障用户从 3.0.26 升级上来，属于这一人群；是否真有旧月度文件，**未知**。

<a id="s12"></a>
## S12 — 交付约束

**事实**
- 自动更新检查在窗口创建之后才调度（`main.js:21626-21628`），启动失败的用户收不到自动更新。
- `build-windows.yml` 支持 `workflow_dispatch`（第 4 行）。对本分支会依次执行 `release-check`、打包、打包后 canary、正式包启动与 BizOP 验收，并上传 `windows-installer` / `windows-portable-exe` 产物（第 217–235 行）。触发前需要先把分支推送到远端。

<a id="s13"></a>
## S13 — 一次启动中的两个预检入口，post-outbox 入口丢失明细（R2 补充）

**事实**
- 首次升级的那次启动会预检两次。owner 阶段调用 `activation.run({ quiesceOnly: true })`（`recovery-participant.js:16`），走首次入口（`upgrade-main.js:241`），只做到第一轮扫描和原 provider 恢复就返回（`upgrade-main.js:125-127`）。post-outbox 阶段调用 `retryRecovery`（`recovery-participant.js:23-25`），它再调用 `activation.run()`（`module.js:188`）。这时已有迁移记录，于是走续跑入口，再预检一次（`upgrade-main.js:235`），之后才做第二轮严格扫描和清理。之后每次重启，两个阶段都走续跑入口。
- post-outbox 钩子失败时，控制器新建 `ARCHIVE_STARTUP_HOOK_FAILED`，只设置 `hookName` 和 `cause`，不复制 `detailLines`、`recoveryPaths`（`controller.js:453-462`）。owner 入口则会复制（`controller.js:315-321`）。
- 启动失败对话框和日志只读取顶层错误的 `detailLines`、`recoveryPaths`，不读 `cause`（`src/backend/startup-failure.js:18-23`、`49-54`）。

**推断**：post-outbox 入口上的续跑预检被拒绝，或者第二轮扫描失败（包括原 provider 没补齐 G1 文件的情形），弹窗和日志都只有一行“存档启动校验未完成：BizOP activation and recovery”。F2 让 owner 预检可以等待以后，失败点可能正好后移到这个入口。

<a id="s14"></a>
## S14 — 拒绝原因在调度器内部就已丢失（R2 补充）

**事实**
- 内存准入的 `evaluate` 在各个拒绝分支直接 `return false`（`memory-admission.js:92-126`），调度器的 `canAdmit` 也只返回布尔值（`resource-governor.js:188-199`）。判定原因没有保存。
- 立即拒绝时，`unavailable(prepared)` 抛出的错误 `details` 只有 `kind` 和 `ownerKeyHash`（`resource-governor.js:374-383`、`421-425`）；排队中按 `reject` 拒绝也一样（`resource-governor.js:457-461`）。只有稳定上限拒绝（`stable-limit`）带 `candidateMemoryBytes`（`resource-governor.js:175-186`）。
- 排队超时的 `ADMISSION_TIMEOUT` 只带 `requestId`（`admission-queue.js:91-93`、`125-134`）。
- `phase-admission.js` 只有在 `cause.details.candidateMemoryBytes` 存在时才输出“实际候选额度”（`phase-admission.js:22-23`）。

**推断**：只在 helper 里补快照，超时路径既拿不到实际候选额度（x64 上为 384 / 128 MiB），也拿不到判定原因。R1 TechDoc §3.2 的示例因此不成立。

<a id="s15"></a>
## S15 — 拒绝后快照与判定时现场的时序差（R2 补充）

**事实**
- 排队到期由定时器触发 `runDrain`（`admission-queue.js:262-264`）。`runDrain` 先拒绝所有到期项，然后在同一个同步循环里继续处理后面的请求，可能当场授予新租约（`admission-queue.js:136-192`）。被拒请求的 Promise `catch` 要等这一轮同步代码结束后才执行。
- 队首推迟时，非队首请求不会被判定（`admission-queue.js:54-68`）。

**推断**：helper 在 `catch` 中采集到的活动、租约和队列都是“拒绝后现场”，不一定是阻塞原因。R1 TechDoc §3.1 所说“与判定时基本一致”不成立。评审（2026-10-06）用最小探针复现了一个反例：队首与预检同时到期，后续请求随即获批，预检的 `catch` 看到的是空队列和一个新租约。本地没有重复这项实验。

<a id="e01"></a>
## E01 — Electron 正式包对 `NODE_OPTIONS` 的限制（外部资料）

Electron 官方环境变量文档（2026-10-06 查阅，<https://www.electronjs.org/docs/latest/api/environment-variables>）说明：正式打包的应用中 `NODE_OPTIONS` 被禁止，仅放行 `--max-http-header-size` 与 `--http-parser`；`nodeOptions` fuse 关闭时会被完全忽略。所以复现钩子只能用于开发模式。

## 未知项登记

| 未知项 | 分类 | 下一步 |
| --- | --- | --- |
| 用户机器上第一次预检时的实际阻塞项 | `PROBE` | 由 F1 诊断包在弹窗和日志中给出 |
| 用户 userData 中是否有 v3.1.10 及更早的旧月度文件 | `PROBE` | 诊断包装上后，若越过资源预检，F3 即会生效；无需单独取证 |
| Windows 下载体 `exit` 时序、句柄等是否与 macOS 不同 | `ASSUME`（按代码合同一致处理） | Windows 实机或 CI 安装包上的“旧版本首次升级”验收 |
