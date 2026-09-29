# v3.2.10 Spec — 应用恢复与共享发布恢复职责治理

| 项目 | 内容 |
| --- | --- |
| 治理编号 / 优先级 | G1 / P1 |
| 目标版本 | `v3.2.10` |
| 功能分支 | `codex/v3.2.10-application-recovery`（已在独立 worktree 建立） |
| 开发基线 | `main` / 附注标签 `v3.2.9`，`11086a3cbf632a30adbcfa796e4cd81810c5aef9` |
| 集成目标 | `release/v3.2.10`；本功能尚未集成，实际分支/基线及集成状态见[实施记录](implementation-notes.md) |
| 日期 / 状态 | 2026-09-20 / 第三轮设计审查通过；当前实现、验证、集成状态见[实施记录](implementation-notes.md) |
| 需求依据 | 用户要求按功能分支具体编写耦合治理方案；[审查报告 G1](../../../architecture-coupling/2026-09-20/review.md) |
| 配套文档 | [TechDoc](techdoc.md)、[总索引](../../README.md) |

## 1. 目标与范围

由应用层统一拥有“平台恢复是否完成扫描”和“本轮启动处于哪个恢复阶段”的事实。BizOP、Duplicate、Position、Toolbox/VCC 等作为明确的恢复参与者接入；业务模块只管理自身持久化事实、恢复预算和准入。共享 publication journal 的调度入口归到公共发布恢复模块，不能要求 Toolbox/VCC 调用 BizOP 才能恢复自己的输出。

这里的负责人是代码职责所有者。实现为现有 Main 进程内的独立协调模块及领域适配器，不新建进程、数据库、服务或 UI。公共恢复引擎、Archive Controller、resource governor 和 publisher dispatcher 继续复用。

本分支包含：应用恢复协调器、现有 owner/post-outbox hooks 的适配、平台扫描事实迁移、共享 publication 协调器及 BizOP/Archive publication owner 适配器，以及相应行为回归。共享恢复需落实到每次恢复副作用之前的授权，涵盖启动、业务重试、实时交接/ack、NewAccount、mature adapter、发布前隐式恢复和 transport-error 自动恢复。G2 的任务执行适配器和 G7 的 descriptor 装配不在本分支实施。

## 2. 现状与问题依据

| 当前事实 | 治理后的责任 |
| --- | --- |
| [Main 初始化恢复](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/src/main.js:22331) 把公共 coordinator 绑定到 BizOP；Duplicate ready 从 BizOP `hasCompletedPlatformScan()` 读取 | 应用恢复协调器记录成功完成的平台扫描；Duplicate 从应用只读快照获得同一事实 |
| [BizOP recovery driver](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/src/main-process/biz-op-v327/recovery-driver.js:43) 同时管理业务恢复循环、预算与平台扫描状态 | 业务循环和预算留在 BizOP；扫描调用经应用提供的 platform facade，应用持有扫描状态 |
| [Toolbox 启动恢复](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/src/main.js:20768) 调用 BizOP `recoverOtherOwners()`；后者查询 BizOP 表、获取 lease 并过滤共享结果 | 公共 publication 协调器调用 owner adapter；领域表、pending 判断与 lease 策略只在对应 adapter 内 |
| [Archive Controller](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/src/main-process/archive-center/controller.js:310) 会逐 owner 尝试恢复、独立重放 outbox，再汇总 owner 失败阻断启动 | 保留顺序和异常聚合；应用协调器包装现有 hooks，不接管另一套 outbox 引擎 |

独立审查 R1 进一步核实：现有恢复扫描可在返回前取消 prepared、回滚或删除 journal/staging；原设计的“扫描后过滤”无法保证未知 owner 材料保留。本稿据此修订授权时点。这是已验证的基线控制流与设计冲突，不宣称新治理代码已实现或生产数据已经丢失。

## 3. 必须保持的行为

1. 启动保持“主库初始化 → registry 冻结及 preflight → Archive owner recovery → outbox 与 interrupted 收口 → post-outbox hooks → 启动允许”的相对顺序。只有原条件全部满足后才注册业务 IPC、创建业务窗口。
2. BizOP 无待恢复来源时，preflight 可完成原平台扫描；存在来源、需要 Archive owner 时，返回既有 `ARCHIVE_OWNER_PHASE_REQUIRED`，将同一预算和期限带入 owner 阶段，不能重置计数制造额外扫描。
3. 应用平台扫描完成与 BizOP `recoveryReady` 是两个不同事实。BizOP 保护状态、activation 状态、各 scope hold 继续依据既有合同判断；不得把某一业务 `ready` 当作全应用启动许可，也不得因提取模块自动放宽启动条件。
4. 每个 owner 独立尝试收口；一个失败后仍尝试后续 owner，并重放已耐久写入的 outbox。随后继续按既有 `ARCHIVE_STARTUP_OWNER_RECOVERY_FAILED`、`ARCHIVE_STARTUP_OUTBOX_*`、`ARCHIVE_STARTUP_HOOK_FAILED` 等失败关闭。
5. publication 恢复先完整只读发现同一 journal 根，再由正确 owner 决定逐记录权限，最后重验快照后执行。未知或身份冲突在任何取消、回滚、cleanup、journal/index 更新之前拒绝，不能事后过滤。提交事实、receipt 确认和 cleanup 仍由正确 owner 证明；Toolbox/VCC 不得确认 BizOP receipt，缺 batchContext/files 不再等价于已确认。
6. 保留 managed-only 文件范围、task/batch/operation/owner 身份、receipt/hold/generation 检查、文件校验与真实 worker exit 屏障。5 秒仅限制资源准入排队；已准入执行不能用超时 race 提前释放 lease、pin 或写入器保护。

## 4. 场景与异常矩阵

| 场景 | 可观察结果 |
| --- | --- |
| 无 BizOP 未决来源 | 平台扫描事实来自应用；原正常启动成功；BizOP 与 Duplicate 原 ready 判断等价 |
| BizOP 未决且依赖 Archive | preflight 不提前恢复 owner；owner 阶段续用原预算；未发生额外无界扫描 |
| BizOP 尚需 activation | 保留 quiesceOnly 和 post-outbox retryRecovery 顺序，其他 owner 的接管机会不被吞掉 |
| 固定总资源预算不足 | 不入无界等待，不执行 publisher，不改原任务/receipt/pin；保留原领域错误 |
| 资源暂缺或排队取消 | 5 秒有界排队；取消立即退出准入；worker 未真实退出时 lease 保持 |
| Duplicate 活动 hold | 平台扫描完成不代表 hold 消失；exact scope gate 继续拒绝对应操作 |
| Toolbox/VCC 与 BizOP 均有已提交 journal | 全根扫描但按 owner 分发；附件/终态耐久后才确认各自 receipt；重复恢复不重复发布 |
| owner 失败但已写 outbox | 后续 owner 仍执行，post-owner outbox 仍重放，最终启动失败；外部源文件不删除 |
| journal 根损坏、未知/冲突 owner、post-outbox 校验失败 | fail-closed，保留诊断和恢复路径，不创建业务窗口；未知/冲突记录的 index、journal、stage、backup 和正式目标在授权拒绝前后不变 |
| preparing / prepared / publishing / committed / finalizing 的未知 owner | 全部状态使用同一前置 gate；不能因尚未提交可取消、或已经提交可清理就跳过归属证明 |
| 有效旧 exact-7/绑定记录与无 discoveryState 的历史 index | 前者按原 owner/状态机恢复；后者沿原人工恢复；有锚点但 owner 证据不足者明确保留并报错，不靠前缀补猜 |
| live ack、NewAccount ack、BizOP retry、发布前隐式恢复及发布 worker 异常 | 全部进入相同授权 primitive；跨 owner ack 零写拒绝；失败 worker 先实际退出；在已有 FIFO 项内恢复不能嵌套 enqueue |
| discovery 后 journal/index/目标身份变化 | 重验失败，执行本轮恢复写入为零；保留材料等待显式重试 |
| 同时触发启动恢复和业务重试 | 同一协调器调用串行化，同一 phase 重入复用正在执行的 Promise，不重复 owner 副作用 |
| 请求确认的 task 被 owner deferred | BizOP 用原 ACK_PENDING 拒绝且不写 acknowledged、不 cleanup；Archive helper 三阶段不得丢掉 deferred，启动保留未决并阻断、live 保留 pending 反馈，不能以 recovered 缺失判断已清理 |
| 重复 ack 时 receipt 已不存在 | 仅受信任完整 snapshot 对本次 task 明确 absence，且原 durable binding/commit/terminal/closure 等证明仍成立时保留幂等成功；过滤空结果或 proof 不足均不能确认 |

## 5. 兼容与非目标

公共 IPC、用户文件、DB schema、持久化 journal/receipt/terminal route 格式均不变；旧应用产生的记录仍能读取。原业务错误保持；新增内部授权拒绝码见 TechDoc §4。本次明确收紧的是未知/冲突 owner 和缺归属证明旧记录的自动清理：即使旧引擎可能取消/回滚/接受，也一律在写入前保留。证据充分的合法历史 owner 继续原样恢复；无 discoveryState 的旧 index 仍人工恢复。新增阶段状态只在内存中存在，每次进程启动重新建立。不得新增“某模块恢复失败但照常放行业务”的降级策略。

不调整恢复预算数值、业务计算、存档保留期、删除资格、批次分类或退出自动清理。`changes/archive-batch-lifecycle/` 为相邻设计，不是当前能力或前置条件。

## 6. 验收

| 编号 | 验收条件 |
| --- | --- |
| G1-AC-01 | 业务运行路径中 Duplicate/Toolbox/VCC 不调用 BizOP 的平台扫描状态或 `recoverOtherOwners`；平台事实唯一由应用协调器写入 |
| G1-AC-02 | 上述正常、deferred、activation 组合的阶段事件顺序及扫描次数与基线一致，预算跨 preflight/owner 连续 |
| G1-AC-03 | owner 失败后继续后续 owner 和 post-owner 重放；所有原阻断条件仍阻止 IPC/窗口启用 |
| G1-AC-04 | 同根多 owner 先只读识别再授权，按领域确认 receipt；未知/冲突 owner、错误 task/batch/operation 及跨 owner ack 均在首个恢复副作用前拒绝 |
| G1-AC-05 | 固定预算不足、5 秒排队超时、排队取消、真实 exit 未完成时，任务/pin/receipt/lease 与原结果一致 |
| G1-AC-06 | 旧持久化记录、重复恢复、同时重试、被阻断 scope、旧 activation 状态均不丢失义务或重复发布 |
| G1-AC-07 | 协调器不执行业务表 SQL；BizOP 适配器不可修改应用阶段；针对真实入口的组合测试通过并记录验证边界 |
| G1-AC-08 | TechDoc §4.5 全入口均适用相同逐记录授权，含 live/receipt/BizOP retry/NewAccount/mature/prepare 隐式恢复/transport-error；未注入、缺 grant 或发现后漂移不得执行恢复写入 |
| G1-AC-09 | 对准备、发布、提交、收尾各状态，未知/冲突/旧证据不足时五类恢复材料前后不变；合法历史恢复、ack-stage 与 ack-finalize、borrowed lease 和真实 exit 不回退，deferred 不被当作无 journal：reconcile/ack 与 Archive 三阶段聚合均保留未决；requested ack deferred 时零 acknowledged/cleanup，完整 absence 加原 durable proof 才允许既有幂等确认 |

## 7. 阶段与依赖

阶段 A 固定现有恢复组合和资源失败回归；阶段 B 迁移平台事实与 hook 装配；阶段 C 修复副作用前授权并提取共享 publication 协调与 owner 适配，逐个迁移 TechDoc §4.5 的全部入口；阶段 D 去除生产调用方的兼容访问、完成启动集成验证。四阶段均属于本功能分支，不能以“新增协调文件但仍从 BizOP 取 ready”判为完成。

本分支不依赖 G2/G7。G2 的终态 registry 后续供同一 Archive Controller 使用；G7 仅汇总本分支 participant 的注册项，不能重写这里的恢复阶段。G8 在本分支落地后激活 `ARCH-BIZOP-RECOVERY-PRIVATE` 与 `ARCH-PUBLICATION-RECOVERY-ENTRY`；精确允许装配范围、例外撤销和行为测试补位见 TechDoc。

文档结构参考 v3.2.9“模块存档保留期限”Spec；本稿给出拟实施行为，不代表已经落地或验收通过。

本次文档补充统一交付要求：每个切片均按[切片完成标准](../../README.md#slice-completion)验收，并按[实施记录与状态要求](../../README.md#slice-record)区分本稿设计 AC、实际实施进度与已取得的验证证据；本补充不改变上述业务验收条件。
