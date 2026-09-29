# release/v3.2.10 Spec / TechDoc 实现审查

审查日期：2026-09-21。**结论：不通过，当前候选不能判定为可发布。确认 2 项 P1：一项可见业务流程回归，一项已在集成记录中披露、此次重新证实的架构门禁阻断。** 未修改被审查源码、测试、规则或设计契约。

## 1. 冻结对象与审查方式

| 项目 | 本轮对象 |
| --- | --- |
| 分支 | `release/v3.2.10` |
| HEAD | `9a38b96b1b8006c5851535d0c1e586bbaeb63f10` |
| 正式基线 | `v3.2.9` → `11086a3cbf632a30adbcfa796e4cd81810c5aef9` |
| Worktree | `/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10` |
| 初始工作区 | 干净；复用既有 release worktree，没有切换主工作区 |
| 设计依据 | [G1–G8 总索引](../../README.md)列出的 8 对 Spec / TechDoc，以及各模块现行 README |
| 集成依据 | [release.md](../../release.md)及当前 Git 历史；G1–G8 来源提交均已合入 |
| 差异范围 | 源码、脚本、测试、架构配置、依赖、页面及 CI 共 440 个文件发生变化；按职责和契约检查关键调用链、跨模块交界、失败与恢复路径，并进行聚焦验证，未声称逐行穷尽所有历史证据文件 |
| 输入留存 | [input-manifest.json](evidence/input-manifest.json)：1,697 项源码／测试／脚本／规则等受验文件 SHA-256；Spec / TechDoc 为上述固定提交中的版本 |

使用 `blindspot-pass` 的证据型审查方法，分别检查恢复/任务、Renderer、XLSX/查询/存储，再核对执行描述符和 G8 组合门禁。旧模块审查用于定位风险，不将旧 PASS 或旧问题直接当成本轮结果。本文是审查结果，不授权修复、提交、推送、PR、升版或发布。

## 2. 确认发现

### R1 · P1：BankStatement 确认按钮使用非法关闭原因，阻断退款与 C3 后续操作

- **事实与位置**：[bank-statement.js:62](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/src/renderer/controllers/bank-statement.js:62) 的 `closeModal()` 调用 `ui.modalHost.closeOwner(owner, 'completed')`。生产装配 [renderer.js:480](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/src/renderer.js:480) 将 `modalHost.closeOwner` 原样交给控制器。[modal-host.js:172](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/src/renderer/modal-host.js:172) 仅接受 `cancel/escape/backdrop/replaced/parent-closed/navigation/disposed` 等取消原因；`closeOwner` 在存在该 owner 弹窗时，把传入原因交给同一 outcome 校验，因此必抛 `MODAL_OUTCOME_INVALID`。
- **真实入口**：银行对账单已导入，启用退款回填或 C3 场景、有候选行且缺少所需退款订单表／网关链接表时，点击运行出现确认框。退款提示的“导入文件”“直接运行”在第 319–320 行先调用 `closeModal()`；C3 的“导入文件”经 `importLinked()` 第 259 行、“直接运行”经第 304 行也先调用该方法。公共 `createConfirmDialog` 第 138 行直接执行按钮回调，没有提前关闭弹窗掩盖错误。
- **复现结果**：真实 controller 与真实 modalHost 的小型组合探针中，上述四条用户可见路径全部抛出 `MODAL_OUTCOME_INVALID`，后续 `batchImport/linkedImport/run` 调用为 0，原弹窗仍打开。探针还复现了 gateway picker 的同一错误，但该模式当前生产导航可达性不足，因此不把它计入本发现的用户影响。
- **真实点击补证**：隔离 Electron 中加载真实 controller、`createConfirmDialog`、modal bridge/host 和真实 DOM，点击退款提示“直接运行”同样得到 `MODAL_OUTCOME_INVALID`、`calls: []`、`modalStillOpen: true`。[脚本](evidence/g3-bank-real-click.cjs)、[日志](evidence/g3-bank-real-click.log)。该运行使用临时 userData / Documents 和受控业务 API，没有加载真实产品 Main。
- **影响**：用户无法通过提示框导入缺失文件，也无法选择跳过该类场景继续运行；错误发生在业务 IPC 之前。不是金额计算错误，但阻断正常对账流程。
- **契约**：[G3 Spec §3、AC-13](../../codex/v3.2.10-renderer-boundaries/spec.md) 要求统一 submitted/cancelled outcome，并保持既有导入、运行、取消及错误行为；[G3 TechDoc](../../codex/v3.2.10-renderer-boundaries/techdoc.md) 要求通过同一宿主完成关闭与等待收口。
- **测试为何漏检**：既有退款/C3 部分测试只检查代码字符串及回调形态；部分控制器测试替身的 `closeOwner()` 无条件返回成功。它们不能验证真实宿主的 reason 枚举。本轮既有退款编排与 ready-guard 测试仍为 33/33 PASS；206 项历史 Electron lifecycle 中，application-shell 在 Bank 域只点击场景管理，没有该缺输入的运行确认路径。现有 lifecycle 总数不能替代这条组合点击路径。
- **最便宜验证**：运行 [g3-bank-close-probe.cjs](evidence/g3-bank-close-probe.cjs)，结果见 [g3-bank-close-probe.json](evidence/g3-bank-close-probe.json)。脚本 exit 0 表示成功确认错误存在，不是功能正确的 PASS。
- **处置：BLOCK**。按实际提交／取消语义通过有效 handle/outcome 关闭弹窗，并以真实控制器、真实确认框和真实宿主验证退款/C3 四个按钮。还须保留 busy/canClose 拒绝时不继续业务的语义，不能仅让替身接受 `completed` 或忽略关闭错误。

### R2 · P1：G8 配置与已合入实现未对齐，当前必经 release 门禁确定失败

- **事实与位置**：[package.json:165](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/package.json:165) 已把架构检查接入 `release-check`。本轮在固定 HEAD 执行 `UNIT_TEST_CONCURRENCY=1 npm run release-check`，lint 通过，`check:architecture` exit 1，smoke、全量 unit、全量 integration 未执行。[原始日志](evidence/release-check.log)
- **明确的配置错配**：[boundaries.json:3900](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/architecture/boundaries.json:3900) 给 G7 的 `policy-catalog`、`mature-adapters`、`legacy-task-policies` 登记了空 `allowedTargets`；composition 的具名导出仍是早期拟定名称，未反映实际 `createModuleExecutionDescriptor`、`archivePolicies` 等装配。G7 Spec / TechDoc 明确允许这些显式装配入口，当前却产生 38 条 `ARCH-DESCRIPTOR-COMPOSITION` 诊断。
- **明确的规则范围问题**：[rules.js:279](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/scripts/architecture/rules.js:279) 对 Q3 的 `protectedScopes` 按整模块依赖展开闭包。[import-main.js:5](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/src/main-process/biz-op-v327/import-main.js:5) 为取得自身 TaskPolicy 引用 G7 composition，闭包进一步扩展到其他领域仓储；于是 Acquiring `import-repository.js` 中正常的 SQL INSERT/DELETE 也被归类为 BizOP 读取协调器违规。不能把这类静态可达诊断当成相同数量的业务 raw-query 缺陷。
- **激活尚未完成**：全部 765 个目标文件可解析，但只有 `platform-core` 和 `production-graph` 为 active，29 个已有治理边界仍在配置中为 pending，扫描报告列为 partial，另有 111 条失效历史例外。部分登记的激活测试文件不存在，消费者、工厂/API 合同也未随真实实现完成核对。仅消除即时误报或机械把状态改为 active，不能完成验收。
- **影响**：任何按项目要求执行的本地 release-check，以及继承该命令的 Windows 构建／发布流程，都无法形成成功门禁。当前没有 G1–G8 最终组合的完整 PASS，且已有治理边界未完成 G8 激活闭合。
- **契约**：[G8 Spec §4、§6，AC-05/09/16–19](../../codex/v3.2.10-architecture-guardrails/spec.md) 要求真实 scoped API／授权恢复／显式 composition 合法、边界随实际迁移激活、首次落地保持合法实现通过；[G8 TechDoc §4.7–4.10](../../codex/v3.2.10-architecture-guardrails/techdoc.md)规定准确保护范围和合法装配。
- **最便宜验证**：`node scripts/check-architecture.js --json <absolute-report-path>`。本轮 exit 1，完整机器结果见 [architecture-check.json](evidence/architecture-check.json)，分类见 [architecture-summary.json](evidence/architecture-summary.json)。该阻断已在 [release.md](../../release.md)披露，本轮为独立复验，不冒称新发现了 2,195 个业务缺陷。
- **处置：BLOCK**。在固定 release 候选逐项对齐真实领域入口、具名导出、scoped API、受限操作和消费者；修正模块闭包与调用职责混淆，保留确有违规的诊断；补“合法装配通过／真实旁路仍失败”反例，完成 activation 与失效例外清理后重新运行最终完整门禁。不得删除检查命令、吞退出码或批量放行其他仓储来消除诊断。

当前静态诊断分类：

| 规则 | 条数 |
| --- | ---: |
| ARCH-BIZOP-QUERY | 1,485 |
| ARCH-STATIC-COVERAGE | 542 |
| ARCH-RENDERER-SCOPE | 109 |
| ARCH-DESCRIPTOR-COMPOSITION | 38 |
| ARCH-TASK-ADAPTER | 19 |
| ARCH-PUBLICATION-RECOVERY-ENTRY | 2 |
| 合计 | 2,195 |

## 3. G1–G8 契约覆盖与结论边界

| 治理项 | 本轮重点检查 | 结果 |
| --- | --- | --- |
| G1 应用恢复 | 平台扫描事实、固定 participant 顺序、全根 owner identify/authorize、startup/live/transport 恢复、unknown/deferred/receipt、真实 worker exit 后释放 | 未发现新实质问题；局部单测和隔离恢复集成支持合同，仍不等于真实产品冷启动／强杀验收 |
| G2 任务适配 | prepare 后第二 gate、Archive initialize、adapter 构造失败收口；Position task-owner；live/replay routes；G7 wrapper 接线 | 未发现新实质问题；真实 Main 提取入口、TaskLifecycle/outbox/两次重启均有本轮覆盖 |
| G3 Renderer | controller enter/leave、请求代次、共享来源、modal owner、真实确认回调和宿主合同 | R1 阻断；既有隔离 lifecycle 证据不足以证明该按钮流程 |
| G4 XLSX | 核心迁移等价、消费者预算、SST 私有目录、strictClose、兼容入口、G6 hash/lineage 重叠 | 未发现新实质问题；7 个核心叶文件与基线逐字一致，其他差异符合 import/常量迁移；legacy 全量 ZIP/SST 内存限制仍是明示边界 |
| G5 查询边界 | SQL/过滤/顺序/投影、同步 iterator 提前关闭、Archive blob 其他引用语义、导入/计算/七类导出/删除预览 | 未发现新实质问题；G8 的整模块闭包诊断不能代替业务查询判断 |
| G6 存储执行 | partial init/terminate rejection 的 exit 屏障、清理顺序、部分 COMMIT/resume、所属 Main lock 释放、G2 prepared scope 组合 | 未发现新实质问题；Main 组合静态核对和局部运行不等于完整 Electron IPC 验收 |
| G7 执行描述符 | exact shape/冻结、action 与独立批准基线、按 action 派发 hook、原 registry、静态/动态预算、跨 generation 及 G1/G2 registrations | 94 单测、402 manifest surfaces、4 类真实载体集成通过；未发现新实质问题 |
| G8 架构检查 | 当前组合 CLI、历史底线、合法 composition、Q3 作用域、生产配置、激活状态 | 143 检查器测试通过，但当前生产组合 FAIL；见 R2 |

上述“未发现”仅适用于所述契约、阅读范围与验证，不是全应用无缺陷声明。

## 4. 本轮实际验证

所有命令在上述 release worktree 执行；业务测试使用合成数据或测试自行创建的临时数据库／文件。各组结果分别列出，避免与旧 release 组合结果相加。

| 检查 | 当前结果 | 本轮证据 |
| --- | --- | --- |
| `UNIT_TEST_CONCURRENCY=1 npm run release-check` | FAIL，exit 1；lint PASS，架构阶段失败；后续三个阶段未执行 | [release-check.log](evidence/release-check.log) |
| 架构 CLI + JSON | FAIL，exit 1；765/765 解析，2,195 诊断 | [architecture-check.log](evidence/architecture-check.log)、[JSON](evidence/architecture-check.json) |
| G8 `tests/unit/architecture/*.test.js` | 143/143 PASS，0 fail / skip | [architecture-tests.log](evidence/architecture-tests.log) |
| G7 `execution-descriptor-*.test.js` | 94/94 PASS，0 fail / skip | [descriptor-tests.log](evidence/descriptor-tests.log) |
| `npm run check:background-execution-manifest` | PASS；402/402 surfaces，74 legacy pairs，13 production enabled | [execution-manifest.log](evidence/execution-manifest.log) |
| G7 descriptor governance 集成 | 4/4 PASS；thread/inline/service/adapter | [descriptor-integration.log](evidence/descriptor-integration.log) |
| G1/G2 首组 9 文件 | 126/126 PASS，0 fail / skip | [g1-g2-tests.log](evidence/g1-g2-tests.log) |
| G1/G2 入口组 5 文件 | 40/40 PASS，0 fail / skip | [g1-g2-entry-tests.log](evidence/g1-g2-entry-tests.log) |
| G1 应用恢复集成 | 4/4 PASS | [g1-integration.log](evidence/g1-integration.log) |
| G2 task-adapter recovery 集成 | 4/4 PASS | [g2-integration.log](evidence/g2-integration.log) |
| G4/G5/G6 聚焦单测 | 145/145 PASS，0 fail / skip | [g4-g5-g6-tests.log](evidence/g4-g5-g6-tests.log) |
| G5 查询边界集成 | 9/9 PASS，0 skip | [g5-integration.log](evidence/g5-integration.log) |
| G6 worker 边界集成 | 14/14 PASS | [g6-integration.log](evidence/g6-integration.log) |
| G3 既有退款编排 / ready guard | 33/33 PASS，仍未覆盖 R1 | [g3-refund-existing-tests.log](evidence/g3-refund-existing-tests.log) |
| G3 真实 Electron 确认按钮点击 | 已复现 R1；exit 0 表示缺陷存在断言成立 | [g3-bank-real-click.log](evidence/g3-bank-real-click.log) |
| G3 controller + host 错误探针 | 5/5 复现，其中 4 条确认生产用户影响；这是缺陷证据 | [g3-bank-close-probe.json](evidence/g3-bank-close-probe.json) |

G1/G2 入口组的现有 dispatcher 测试包含 256 MiB hash/target-drift 用例，本轮实际执行并完成；未追加大型压力验证。Electron 首次沙箱内启动 SIGABRT，随后获授权在沙箱外使用隔离临时目录完成真实点击；中间脚本导入错误已纠正。最终日志中的 Chromium cache 警告未妨碍点击断言，不将首次环境失败算成功。具体命令、退出码及文件指纹见本目录 [验证清单](evidence/verification.json)。

## 5. 已排除候选与剩余验收

本轮没有把以下情况列为缺陷：

- Main 调用 `createApplicationRecoveryComposition()` 看似没有显式传 participants，但其 import 已指向 G7 wrapper；wrapper 按固定顺序装配再转交 G1，不构成漏接。
- G6 Main pool failure listener 不再直接解锁；prepared scope / 所属 execute finally 承担本 run 释放，未发现旧 worker 解开新 run 锁的回退。
- G7 当前 policy/capability 校验使用独立批准基线；不是 compiled 与 catalog 相互比较即可自证。当前 source manifest 校验通过。
- `package.json` 仍是 `3.2.9`，属于尚未执行正式升版的已披露状态；此次只审查集成分支，不把未获授权升版当作代码缺陷。
- G3 gateway picker 的相同关闭问题和 dispose 原因差异未单独计数；前者缺生产导航可达证据，后者有整壳 dispose 收口，避免重复或夸大用户影响。

仍需保留的边界：

1. 修复 R1/R2 后，在最终候选上重新执行完整 `release-check`。此前 G1–G7 的 8,773 单测 PASS / 68 集成 PASS 属于旧候选，不能替代当前结果。
2. G3 来源绑定的资金相关人工复核仍未完成：界面确认账期、期初、Main snapshot、逐文件明细及落库 receipt 一致性，沿用既有实施记录，不因此次测试而升级结论。
3. 未执行真实产品 Main 全流程冷启动／强杀／恢复、Windows 文件锁／workflow／安装包、Excel/WPS 及真实业务数据人工验收。小型 Node 集成与隔离 Renderer 探针不能代表这些平台验收。
4. G8 激活证据要求实际消费者和行为测试，单有测试文件、检查器单测 PASS 或静态无循环不足以完成治理验收。

交付前 [preservation.json](evidence/preservation.json) 核对：HEAD 保持 `9a38b96b`，1,697 项受验文件 SHA-256 全部一致，工作区仅新增 `changes/v3.2.10/reviews/`。本次仅新增本审查文档和证据；源码修复、配置对齐和发布操作均未执行。
