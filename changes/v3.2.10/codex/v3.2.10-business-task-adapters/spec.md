# v3.2.10 Spec — Main 业务任务适配器与终态路由治理

| 项目 | 内容 |
| --- | --- |
| 治理编号 / 优先级 | G2 / P1 |
| 目标版本 | `v3.2.10` |
| 功能分支 | `codex/v3.2.10-business-task-adapters`（计划名，未创建） |
| 开发基线 | `main` / 附注标签 `v3.2.9`，`11086a3cbf632a30adbcfa796e4cd81810c5aef9` |
| 集成目标 / 依赖 | `release/v3.2.10`；交付前已与 v3.2.9 同步；实施时记录 G1 已集成的固定 SHA，见[总索引](../../README.md) |
| 日期 / 状态 | 2026-09-20 / 设计稿，代码未实施，本文测试未执行 |
| 需求依据 | 用户要求将治理项按功能分支写清楚；[审查报告 G2](../../../architecture-coupling/2026-09-20/review.md) |
| 配套文档 | [TechDoc](techdoc.md)、[总索引](../../README.md) |

## 1. 目标与范围

Main 通用任务入口只负责现有任务生命周期的装配，不再直接处理 Position 的 pending、admission、业务结果、归档 settlement 或暂存清理。Position 的这些规则收进一个领域任务适配器；Toolbox/VCC 的 publication receipt 确认通过各自适配器接入。Archive 的持久终态路由以“校验器＋finalizer”成对注册，保留所有旧 route。

模块拆分以职责为界：通用执行器管理调用顺序，领域适配器管理领域状态，现有 TaskLifecycle 管理 task/batch/outbox；不新建另一套调度器、业务状态机或数据库。外部用户仍使用原 IPC、按钮、文件和错误反馈。

首版覆盖 Main `runArchiveAwareOperation` 全部 Position 文件/无文件/legacy recovery 分支、Toolbox/VCC publication-only afterTerminal，以及四个历史持久 route。其他业务使用透传适配器，保留已经存在的 prepare/execute/hooks。不要求一次重写所有领域服务。

## 2. 现状依据与边界

| 现状 | 本项治理 |
| --- | --- |
| [公共 Main 入口](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/src/main.js:21849) 根据 Position channel 创建 token，再分别拼接文件、无文件生命周期参数 | 用已冻结 taskKey→adapterId 映射选择领域适配器，公共入口不做 Position 前缀分派 |
| [文件执行段](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/src/main.js:22047) 记录 Position intent、捕捉业务异常、mark outcome、settle、cleanup 并恢复原异常 | 原顺序迁入 Position adapter，暂存清理仍须归档 durable 和原 ownership 条件 |
| [Controller route 解析](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/src/main-process/archive-center/controller.js:124) 和 [Main finalizer](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/src/main.js:19501) 分散认识同一组业务 route | 一个 terminal route registry 同时持有 normalize/finalize，Controller 与 live/replay 共用 |
| `runWithPreparedResourceCleanup` 当前放在 Position preflight 文件却被公共入口使用 | 将通用资源清理辅助移至 task-adapters 中立模块，Position 旧导出短期转发 |

本项以所有权和装配迁移为主，同时明确修复独立审查 R4 指出的 prepare 成功后第二次 Hold gate 漏收口，以及新增 adapter 构建/同步抛错的同类空隙。原 lifecycle 不可用分支已经清理，本次只纳入统一 owner，不能重复调用。除这些显式修复外，不改变 prepared 业务含义、取消时机、BOR admission、任务身份或文件计划。

## 3. 任务行为

1. 第一次 Recovery Hold gate 仍在 picker/prepare 前；准备取消不创建任务、批次或 BOR operation。准备完成后再次检查 Hold；lifecycle beforeStart 在任何领域副作用前完成最后一次 gate。
2. `prepareIpcTaskInvocation` 成功返回 proceed:true 后立即建立唯一资源 scope；第二次 gate、Archive 初始化/可用性、adapter 构建和 lifecycle 均在 scope 内。未接管执行就结束时，原 onAbandon 恰好尝试一次，清理失败保留诊断和资源，不自动重复删除。只有领域 admission 真正接受并即将执行时才标记 executeStarted，移交资源义务；此前拒绝不得误标已执行或触发业务 settlement。
3. Position 原有 token、operationKey、owner、taskRunId/batchId 与 pending 一致性保持。显式 prepared 身份沿用原优先级；不“顺手修正”既有历史兼容形状。
4. Position 非 legacy 文件任务保持 intent→业务结果记录→manifest settlement→durable 标记→受管暂存清理顺序。业务异常要先完成原 settlement 尝试，再按原错误优先级返回；归档不 durable 不能清理输入或伪造 succeeded。
5. Position 无文件任务使用原 operation owner；legacyExistingBatchRecovery 使用原批次恢复路径及 source snapshots，不能被当作新文件任务重新分配 batch。
6. TaskLifecycle 继续决定终态/outbox，领域 adapter 只经原 hooks 接入。Toolbox/VCC receipt 仍在当前 publication-only 条件满足后确认，不因公共 afterTerminal 被调用就确认任意 receipt。
7. 恢复 route 保留 `position-reconciliation`、`pending-run`、`biz-op-run`、`pre-fund-run`。字段、历史无 owner 的校验分支、legacy BizOP activation 限制均保留；未知 route 和身份冲突失败关闭。

## 4. 场景与异常矩阵

| 场景 | 预期行为 |
| --- | --- |
| prepare 取消 / prepare 抛错 | 原返回或原异常；无 BOR/task/batch；已登记 prepare 资源按原规则释放 |
| 准备期间新增 Hold / beforeStart 前新增 Hold | gate 拒绝；业务零次、onAbandon 恰好尝试一次；第二 gate 拒绝不创建 BOR/task/batch，beforeStart 的已分配身份继续由原生命周期收口 |
| adapter 构建抛错、Archive 初始化抛错、scope work 同步异常 | 全部已在唯一 scope；业务零次，abandon 一次；不遗留未登记的 cleanup Promise |
| lifecycle 不可用 | 沿原失败结果与 cleanup-error 优先级；删掉分支手工 cleanup，统一 scope 执行一次 |
| abandon 本身抛错、双异常 | 不自动重试；新覆盖的 pre-lifecycle 路径保留原 gate/构建错误为主，cleanup 单独诊断；已有 lifecycle finally 的 cleanup-error 优先级保持，详见 TechDoc §3.4 |
| Position admission busy/rejected | executeStarted 不提前置位；pending/task 不跨身份写入 |
| 普通非 Position 任务 | 无 Position DB/service 依赖也可运行，结果和 hooks 不变 |
| Position 成功、settlement durable | 原结果返回；先记录业务与归档事实，再 managed-only cleanup |
| Position 业务提交、归档失败 | 保留 pending/intent/可恢复暂存，返回原业务/归档反馈；重启不重复业务提交 |
| execute 抛错且 settlement 也失败 | 原错误优先级不变，保留恢复义务；不以 finally cleanup 丢掉证据 |
| terminal 后、afterTerminal 前崩溃 | outbox 历史 route 在重启时完成同一任务；重复 finalizer 幂等 |
| Toolbox/VCC 已提交但 receipt 未确认 | 仅正确 owner、task/batch 和 durable proof 满足后确认；错误 receipt 保留 |
| 多任务并发、重复回放 | 每任务独立 adapter invocation；现有 BOR/admission/owner gate 串行约束不变 |

## 5. 兼容与非目标

不变更 IPC 名称和参数、`FilePlanV1`、TaskRun/owner/terminal intent schema、业务错误码和分类器结果。禁止新增 DB migration、自动清理规则、退出策略、存档保留期和业务算法变更。旧持久化 route 必须保留可恢复能力，不能仅因当前没有新生产者就删 route。

终态 registry 只接受 Main 静态装配，不能从 IPC payload 指定 finalizer、函数名或模块路径。公共执行器不得获得各领域裸 DB，只接受能力受限的适配器。G1 管理恢复阶段；本项仅提供领域终态处理能力。

## 6. 验收

| 编号 | 验收条件 |
| --- | --- |
| G2-AC-01 | `runArchiveAwareOperation` 不再判断 Position 前缀、直接调用 Position pending/settle/cleanup；非 Position 运行无需 Position 服务 |
| G2-AC-02 | 三次 gate、prepare 取消、BOR 开始、领域 admission 与 executeStarted 接管点保持；明确修复第二 gate / 构建 / 同步异常漏收口，其他结果及 TechDoc §3.4 已有错误优先级保持 |
| G2-AC-03 | Position 文件、deferred、无文件与 legacy recovery 保持 task/batch/owner/operation 身份及历史结果 |
| G2-AC-04 | 成功、业务错误、归档不 durable、取消和崩溃时，不丢 pending/receipt/hold/暂存证据，不重复提交，不删除外部源 |
| G2-AC-05 | 四个历史 route 的合法/非法/重复回放样例与旧行为等价；未知 route 和不匹配 owner fail-closed |
| G2-AC-06 | Toolbox/VCC publication-only receipt 接入符合原确认条件；普通 prepared afterTerminal 仍按原优先级生效 |
| G2-AC-07 | registry 启动前冻结，重复 adapter/taskKey/route 或 normalize/finalize 不成对立即拒绝；Renderer 无法注入注册项 |
| G2-AC-08 | live execute 和重启 replay 使用同一领域 finalizer；行为测试覆盖生命周期，不再靠 Main 函数物理位置判断正确性 |
| G2-AC-09 | 真实公共入口覆盖 prepare 后第二 gate、adapter 构建、初始化、lifecycle 不可用和 beforeStart 拒绝，业务零次且 onAbandon 一次；接管后通用 abandon 零次；cleanup 失败不重试，退出 tail 等待收口并保留规定错误优先级 |

## 7. 阶段与依赖

本分支从 v3.2.9 创建，实施 G1 后通过 release 中已核验固定 SHA 引入所需成果，记录实际依赖提交；不直接追随浮动旧 release head。先锁定 G1 的恢复接入，再实施 A：透传 adapter/terminal registry；B：Position 文件与无文件迁移；C：Toolbox/VCC 与历史 route 迁移；D：移除生产 shim、组合验证。

G7 后续只汇总本项 adapter/route 注册项，不修改接口语义。G8 在 G2-T5 激活 `ARCH-TASK-ADAPTER`，约束公共入口/中立资源模块不能深层依赖 Position 状态机；允许 Main 静态装配领域 adapter，移除兼容例外。源码交集以 Main 和 Archive Controller 为主，集成时逐段保留 G1 已完成的恢复 hooks。

文档结构参考 v3.2.9“模块存档保留期限”Spec；本稿仅完成设计，不视为治理代码已交付。

本次文档补充统一交付要求：每个切片均按[切片完成标准](../../README.md#slice-completion)验收，并按[实施记录与状态要求](../../README.md#slice-record)区分本稿设计 AC、实际实施进度与已取得的验证证据；本补充不改变上述业务验收条件。
