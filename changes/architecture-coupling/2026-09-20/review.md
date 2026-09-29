# 模块耦合度与治理优先级审查

日期：2026-09-20。基线：`main@11086a3cbf632a30adbcfa796e4cd81810c5aef9`，`package.json` 版本 `3.2.9`。

## 结论

**存在值得治理的耦合，整体呈现“业务算法相对分散，公共编排、恢复和旧 UI 接缝集中”的形态。** 当前最应优先处理的是应用恢复依赖 BizOP、通用 Main 执行器内嵌业务状态机、旧 Renderer 共享全量状态。没有依据要求一次性重写架构，也没有在本次审查中确认需要立即停版本的 P0 事件。

静态文件依赖图没有发现循环，不代表模块已经低耦合：回调注入、全局 DOM、共享数据库、IPC、恢复顺序均不在普通 import 图中。本报告把这些语义依赖纳入排序，避免按文件行数或 import 数直接定性。

这里的 P1/P2 是**治理优先级**，不是线上事故严重度。P1 建议进入下一轮治理；P2 在相关模块迭代时分批处理。结构风险已经有源码依据；除弹窗接缝的局部实验外，没有据此宣称业务故障已复现。

## 范围、方法与边界

- 对冻结提交的 `src/**/*.js` 全量执行 Acorn AST 扫描和 `shit-mountain-detector` 辅助扫描；读取 `index.html`、相关测试、ESLint 和项目约定，并行核对 Main/平台、Renderer/IPC、业务/存储三个范围。
- AST 统计字面量 `require/import` 的本地文件依赖，同一来源到同一目标只计一条边。循环检测采用强连通分量；不计回调、经典脚本全局、worker 路径及 IPC 通道。
- 工作区起始无已跟踪文件修改。已有未跟踪目录 `changes/archive-batch-lifecycle/`、`changes/v3.2.9/codex/v3.2.9-account-mapping-management/` 不纳入冻结基线，也未改动。尚未实施的方案不当作当前代码事实。
- 本次只新增本审查目录中的报告与证据，没有修改被审查源码、提交、推送或开 PR。
- 未执行 `release-check`、完整业务集成或 Electron GUI 验收。本次任务是架构审查；全量测试也不能替代边界和生命周期检查。

## 量化结果

| 指标 | 结果 | 解释 |
| --- | ---: | --- |
| JavaScript 文件 | 685 | 全部解析成功，未因数量上限跳过 |
| 物理行数 | 282,567 | 包含注释与空行，不等同于复杂度 |
| 本地 JS 唯一文件依赖边 | 2,254 | 字面量 require/import |
| 文件级循环依赖 | 0 | 仅适用于上述静态图 |
| 非字面量动态加载位置 | 3 | 未纳入静态边，需要单独理解 |
| backend → main-process | 98 条，来自 40 个文件 | 其中 Position import 占 56 条；同域跨目录、纯工具归属与真正反向编排要分开判断 |
| main.js | 23,503 行、196 个本地 JS 直接依赖 | Main 本来就是装配入口；坏耦合证据是内部持有业务状态机 |
| renderer.js + renderer-dialogs.js | 23,558 行 | 同时共享 state、elements、API 和反向业务回调 |
| Main 直接调用 ipcMain.handle/on 的源码位置 | 122 | 不等于总 IPC 通道数，间接注册器未计入 |

两处未解析相对引用均为构建生成的 `src/build-info`；不把它们当成缺失源码缺陷。三个动态加载点在 `big-table-import/engine.js:207`、`big-table-import/import-worker.js:274`、`acquiring-bill-currency-session.js:424`。

辅助扫描识别了 8,662 个函数，长函数比例 6.5%，最大嵌套深度 12；这些是启发式结果。Main/Renderer 的工厂函数和 IIFE 会显著放大“最长函数”指标，重复块信号也不证明业务重复，因此不据此计算伪精确的全仓“耦合分数”。

## 各模块耦合判断

“高”表示变更需要理解其他模块内部状态、生命周期或广泛共享可变数据；“中”表示共享基础设施较多、存在个别边界穿透；“低—中”表示本次抽查中核心逻辑边界较清楚。评级是针对冻结基线的工程判断，未逐条动态验证所有业务路径。

| 模块/模块组 | 判断 | 主要耦合对象及依据 | 治理对应 |
| --- | --- | --- | --- |
| Main 装配与通用任务入口 | 高 | 业务、归档、后台执行集中装配；公共执行器直接知道 Position pending/settlement 与 Toolbox/VCC receipt | G1、G2 |
| 应用启动/后台恢复 | 高 | 通用平台扫描与 Duplicate ready 从 BizOP recovery 获取，共享 publication 恢复也经过 BizOP | G1 |
| 旧 Renderer + Dialogs | 高 | 全量 state/elements/API 与全局 modalRoot；导航负责领域刷新、弹窗反向控制领域状态 | G3 |
| 归档中心 | 中—高 | 统一生命周期职责合理；业务 terminal route、owner cleanup 和直接跨表查询仍形成泄漏 | G2、G5、G7 |
| 后台执行平台 | 中—高 | runtime 重复按 action/module 选 worker、validator、topology、input binder；基础 governor/supervisor 边界应保留 | G7 |
| BizOP | 高（集成边界） | 承担平台恢复；计算/导出/删除共享裸 catalog.db；核心计算并非普遍跨域互调 | G1、G5 |
| Position 头寸对账 | 中—高 | 导入与业务服务分置 backend/main-process，同域引用较多；生命周期渗入 Main，SST 工具被外域复用 | G2、G4 |
| Toolbox 文件工具 | 中—高 | OOXML/样式能力成为其他域的基础设施；输出恢复受共享 publication 所有权影响 | G1、G4 |
| VCC Financial OP | 中—高 | 复用 Position SST/Toolbox reader；review plan 为校验依赖整套 dataset writer；弹窗有独立生命周期 | G1、G3、G4、G6 |
| Acquiring 收单 | 中 | session → backend repository → main-process worker 执行器反向编排；读取复用 Pending 基础能力 | G4、G6 |
| Pending | 中 | 流式 XLSX reader 被基础 file-service 及多个域引用，基础能力归属不清 | G4 |
| Statement / 新建账户 | 中 | Main、共享 UI、归档、worker/publication 多接缝；worker 契约已有拆分 | G2、G3、G7（公共接缝） |
| PreFund 前置资金对账 | 中 | 导入/存储/worker 共享协议较多；核心 matching-engine 依赖集中在同域规则 | G7；本次不建议重写匹配算法 |
| Duplicate Inbound 重复入账 | 中 | 本域已有 worker/recovery 分层，但启动 ready 依赖 BizOP 平台扫描事实 | G1 |
| Recon ID Fix / 场景引擎 | 中 | 明确的共享引擎/session 属于既有业务决策；后台任务注册和公共 UI 是主要接缝 | G3、G7 |
| Bank BU、Fund Recon、VCC OP Calc | 低—中 | 静态图主要连接同域和公共执行/IO，本次没有比前三个热点更强的单独治理证据 | 沿用公共治理；不单独重构 |
| 主库/配置仓储 | 中 | 多域共享门面合理；应治理跨表读和仓储启动执行器，纯工具放置问题优先级较低 | G5、G6 |
| Preload | 低—中 | 命名 API 隔离良好，订阅可取消；六组字段副本当前一致 | 保留 sandbox；同步校验为后续维护项 |

按路径归并的完整文件/依赖数量见 [evidence/module-groups.json](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/changes/architecture-coupling/2026-09-20/evidence/module-groups.json)。该文件记录的是逻辑组统计，不是业务耦合的精确评分；尤其 Renderer/Preload 的静态边很少，却通过 IPC 与共享状态承担大量依赖。

## 主要问题

1. **恢复所有权放错层。** BizOP 业务模块持有应用级平台扫描完成状态，并承接其他模块的 publication 恢复；业务恢复规则改变会牵动整机启动和其他业务的 ready 判定。
2. **公共执行器掌握领域状态机。** Position 的 admission、pending、settlement、终态、暂存清理散落在 Main 公共入口及 Archive route 装配中，公共调用顺序和领域内部语义难以独立变更。
3. **旧 UI 的共享状态和生命周期尚未形成模块边界。** 拆成多个文件后仍传递完整对象，公共弹窗销毁还会绕过其他模块的清理协议。
4. **共享 Excel 能力以业务模块身份被复用。** VCC、BizOP 会继承 Position 的默认 SST 预算/错误语义，Pending/Toolbox 的基础解析器变动会扩散到多个业务域。
5. **数据访问与执行配置有多处同步点。** 裸数据库、跨归档表 SQL、仓储调 worker、runtime 多次按同一 action 分类，都会放大一次变更需要同时核对的范围。

## 具体治理建议（Concrete Optimization Suggestions）

以下按治理重要性排序。同级优先考虑即将变更的模块。S 表示可以独立交付的小切片，M 表示需要跨层回归的中等工作，L 表示必须分批迁移的结构任务；这些是相对规模，不是排期承诺。

### G1 — P1：把应用恢复与共享 publication 协调移出 BizOP

- **位置/证据：** [src/main.js:22331](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/src/main.js:22331) 把通用 coordinator 绑定给 BizOP 并从其 recovery 启动预检；`:22393` 的 Duplicate ready 取 BizOP `hasCompletedPlatformScan()`。[src/main-process/biz-op-v327/recovery-driver.js:43](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/src/main-process/biz-op-v327/recovery-driver.js:43) 的平台扫描处于 BizOP admission/budget 内。[src/main.js:20768](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/src/main.js:20768) 让 Toolbox/VCC 恢复调用 BizOP `recoverOtherOwners()`，其实现位于 [src/main-process/biz-op-v327/export-publication.js:239](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/src/main-process/biz-op-v327/export-publication.js:239)。
- **问题/触发场景：** 改 BizOP 激活、恢复预算、catalog 或 owner 判定，需要同时证明 Duplicate、Toolbox、VCC 及应用启动阶段仍正确。
- **改法：** 应用级 startup coordinator 持有平台阶段与扫描完成事实；各业务注册 recovery participant。共享 publication coordinator 负责 journal 扫描，BizOP 提供自身 owner/保护/结算适配器。
- **收益：** 恢复职责与状态事实的拥有者一致，业务恢复改动可以在清楚的参与者契约下验证。
- **成本/风险：** L，高。保留当前 preflight → Archive owner → outbox → post-outbox → ready 顺序、预算、receipt 和失败关闭约束；不承诺“某业务失败仍让其他业务启动”。
- **验收：** 无/有 BizOP 待恢复任务、预算耗尽、Duplicate recovery hold、Toolbox/VCC 已提交 journal 的组合；未知 owner 拒绝，receipt 不跨 owner 确认，ready 由平台事实产生。将 [tests/unit/duplicate-inbound-match-wiring.test.js:222](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tests/unit/duplicate-inbound-match-wiring.test.js:222) 的特定源码接线断言迁为阶段行为测试。

### G2 — P1：从 Main 通用执行器提取业务任务适配器

- **位置/证据：** [src/main.js:21849](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/src/main.js:21849) 的 `runArchiveAwareOperation()` 是公共入口，但 `:21901` 按 Position channel 识别领域，`:21930`、`:22006` 两条路径重复处理终态，`:22047` 起负责 Position intent、业务结果、归档 settle 与 cleanup。[src/main-process/archive-center/controller.js:124](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/src/main-process/archive-center/controller.js:124) 和 [src/main.js:19501](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/src/main.js:19501) 共同维护业务 terminal route。
- **问题/触发场景：** Position 改取消/提交/暂存清理规则会触及所有业务经过的入口；公共入口改 prepare/terminal 顺序也必须理解 Position 状态机。
- **改法：** 首先抽取 `PositionTaskAdapter`，显式提供 identity、admission、execute/settle、afterTerminal、recovery。利用已有 TaskLifecycle hook，terminal validator/finalizer 通过启动时冻结的 owner registry 成对注册；再以相同接口接入 Toolbox/VCC receipt 确认。
- **收益：** 缩小公共执行入口的业务知识和回归扩散范围，减少同一 Main 文件的并行修改冲突。
- **成本/风险：** L，高。先原样搬迁调用顺序，不同时改变任务、取消、幂等、文件归属或历史 route 格式。
- **验收：** 文件/无文件任务、prepare 放弃、admission 拒绝、业务提交后归档失败、终态后崩溃与重启恢复；一个非 Position 任务能运行而无须提供 Position 数据库。未知 route 仍失败关闭。

### G3 — P1：按领域收窄旧 Renderer 依赖；先统一弹窗销毁

- **位置/证据：** [src/renderer.js:217](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/src/renderer.js:217) 集中多域 state；`:599` 注入完整 state/elements/desktopApi 与业务回调，`:1598` 的 `setCurrentModule` 负责领域刷新。[src/renderer-dialogs.js:8103](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/src/renderer-dialogs.js:8103) 需要反向区分并刷新业务面板。[index.html:610](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/index.html:610) 以经典脚本顺序装配。
- **问题/触发场景：** 修改领域状态、场景 CRUD 后的失效规则或导航刷新策略，必须理解主 Renderer、Dialogs、全局 DOM 和多个业务。
- **改法：** 模块控制器只接收本域 API、面板根节点、公共 UI 服务；导航调用 enter/leave/dispose，弹窗返回操作结果，由调用方处理业务失效。参考 [src/renderer-position-reconciliation.js:59](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/src/renderer-position-reconciliation.js:59) 的 scoped API/私有 state。
- **可先交付的小切片：** 公共 [src/renderer-dialogs.js:279](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/src/renderer-dialogs.js:279) 清空 modalRoot，而 VCC [src/renderer-vcc-financial-op.js:193](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/src/renderer-vcc-financial-op.js:193) 仅自身 close 才解绑 keydown、调用 onClose。建立带 close/dispose/canClose 的 modalHost 句柄，先迁移 VCC 和账户映射嵌套弹窗，再逐步迁移旧 Dialogs。
- **局部实验：** 对两段真实源码用模拟 DOM 调用“VCC mountDialog → 公共 closeModal”，可见节点变为 0，但 onClose 调用为 0、keydown 监听剩余 1。证据见 [evidence/modal-lifecycle-probe.json](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/changes/architecture-coupling/2026-09-20/evidence/modal-lifecycle-probe.json)。这是接缝不兼容证明，不是完整 GUI 触发链复现。
- **收益：** 状态和事件生命周期随模块收拢；避免一个公共 UI 操作移除另一个模块的节点却未执行其清理。
- **成本/风险：** L，中—高；modalHost 首个切片 S。保留现有跨域 session 的业务约定；不可仅拆文件后继续传整个 state。
- **验收：** 弹窗清理恰好一次、保留底层弹窗、Promise 有取消结果、保存中遵守 canClose；反复进入/退出无重复绑定，快速导航不接受过期响应，场景变更只失效目标域。迁移相关源码字符串测试为控制器公开行为测试。

### G4 — P2：提取中性的 XLSX 基础设施，业务策略显式传入

- **位置/证据：** [src/backend/file-service/readers.js:14](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/src/backend/file-service/readers.js:14) 依赖 Pending 流式 reader；另有 Toolbox、linked-table、Acquiring、VCC OP Calc、旧 BizOP 等域外消费者。[src/backend/xlsx-rich-reader.js:11](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/src/backend/xlsx-rich-reader.js:11)、[src/backend/vcc-financial-op/workbook-reader.js:16](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/src/backend/vcc-financial-op/workbook-reader.js:16) 依赖 Position shared-strings provider。[src/backend/position-reconciliation-import/shared-strings-provider.js:14](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/src/backend/position-reconciliation-import/shared-strings-provider.js:14) 导入 Position 默认预算，`:24` 定义 Position 专属错误，`:55` 使用默认值。
- **问题/触发场景：** 调整 Position SST 预算/错误码或 Toolbox 解析器，影响 VCC/BizOP/文件服务，却容易按目录归属缩小回归范围。
- **改法：** 建立 `backend/xlsx/` 的共用 SST、XML/OOXML primitives、rich reader；先保留旧路径转发，各业务 adapter 明确预算、sheet/row 策略和错误映射。暂不强行合并各业务的 parser。
- **收益：** 基础设施拥有者和消费者清晰，默认值不再以其他业务的配置隐式继承。
- **成本/风险：** M，中。表头、日期、公式缓存、样式、多 sheet、取消和临时文件归属各域存在真实差异。
- **验收：** 共用 fixture 对比提取前后输出，同时保留各域契约；SST 溢出、取消、关闭失败和临时目录 ownership。复用 `tests/unit/backend/shared-strings-ownership.test.js`、`tests/unit/main-process/biz-op-v327-export-sst.test.js` 等现有入口。

### G5 — P2：收拢 BizOP 查询契约，封住跨归档表 SQL

- **位置/证据：** [src/main-process/biz-op-v327/catalog.js:387](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/src/main-process/biz-op-v327/catalog.js:387) 公开 db/archive/transaction；`compute-inputs.js:33`、`export-inputs.js:11`、`delete-preview.js:23` 分别掌握 ACTIVE/PUBLISHED/READY 查询；[src/main-process/biz-op-v327/delete-preview.js:54](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/src/main-process/biz-op-v327/delete-preview.js:54) 直接查询 `archive_artifacts`。
- **问题/触发场景：** 同域拆分文件本身合理；真正的成本是有效状态/结果形状散落，以及业务组件依赖归档内部表。修改 schema、状态机、blob 引用规则会跨组件同步。
- **改法：** 先建立 readActiveDatasetWithSources、readPublishedRunForExport、readDiagnosticForExport、collectDeleteClosure 等只读 query 接口；共享 blob 引用经 archive repository 的只读方法查询。稳定后再缩减公开 db 面。
- **收益：** 把状态过滤与数据形状留在有所有权的查询层，缩小迁移影响。
- **成本/风险：** M，中。保持原事务、generation、hold、receipt 与删除语义；现有代码有安全检查，本项不指称绕过删除保护。
- **验收：** 覆盖导入替换、计算、导出、过期删除预览和 generation 变化，结果/错误码不变；协调器不得新增裸业务表或归档表 SQL。

### G6 — P2：拆开仓储与 worker 编排，纯校验不经 writer 引入

- **位置/证据：** [src/main-process/acquiring-bill-currency-session.js:776](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/src/main-process/acquiring-bill-currency-session.js:776) 选择 worker 参数后调用 repository；[src/backend/acquiring-bill-currency-db/run-repository.js:476](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/src/backend/acquiring-bill-currency-db/run-repository.js:476) 反向载入 `run-check-multiworker` 并执行，`:509` 接管失败清理；[src/main-process/run-check-multiworker.js:75](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/src/main-process/run-check-multiworker.js:75) 实际启动 Worker。另一个较小接缝：[src/backend/vcc-financial-op/review-export-plan.js:17](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/src/backend/vcc-financial-op/review-export-plan.js:17) 为 `assertMappedLineage` 引入整套 dataset writer，校验定义在 [src/main-process/vcc-financial-op-dataset-writer.js:689](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/src/main-process/vcc-financial-op-dataset-writer.js:689)。
- **问题/触发场景：** 修改取消、worker crash 或事务清理，需要联合理解 session、仓储、执行器；纯 lineage 校验又拉入 ExcelJS/写出依赖。
- **改法：** Acquiring service 组织 buildChunkPlan → execute → commit/cleanup，repository 负责 SQL 计划和持久化；可先显式注入 executor。小切片是将 VCC lineage 校验及其必需哈希版本规则移至同域 contract，plan/writer 共用。
- **收益：** 分离执行资源与数据访问；只验证数据的代码无须载入完整 writer。
- **成本/风险：** 整项 M，VCC 校验切片 S；必须保留旧哈希版本、异常码与事务/cleanup 顺序，不把版本规则误当无关依赖删掉。
- **验收：** 单/多 worker 顺序等价、取消、worker crash、合并失败清理及 resume；旧/新哈希 lineage 的有效和失效样例不变。复用 `tests/unit/main-process/acquiring-multiworker-contract.test.js`、`run-check-multiworker.test.js`。

### G7 — P2：用模块 descriptor 收敛执行与归档注册

- **位置/证据：** [src/main-process/background-execution/runtime.js:208](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/src/main-process/background-execution/runtime.js:208) 选择 entry/workerData，`:393` 选择 validator，`:468` 选择 topology，`:557` 再选择 binder；[src/main-process/archive-center/task-policy-registry.js:815](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/src/main-process/archive-center/task-policy-registry.js:815)、`:828`、`:868` 继续分配 classifier、flow、metadata、lineage。
- **问题/触发场景：** 新增 action 或改结果形状需要同时修改多个公共分派点，模块开发经常碰同一组共享文件。
- **改法：** 每个业务输出固定形状的 descriptor，包含 policy、entry、validator、topology、Main binder、Archive adapter；composition root 显式汇总，通用 runtime 校验/冻结/消费。
- **收益：** 减少多点同步，新增业务主要改自身 descriptor 与一个装配点。
- **成本/风险：** M，中—高。沿用 action-task-binding authority、静态 inventory/hash、预算和能力白名单，禁止 Renderer 注入执行策略。
- **验收：** 测试 action 不需修改通用引擎分支即可接入；重复 key、缺失 validator/binder、非法 authority 均在启动或 admission 被拒绝。

### G8 — P2：增加依赖边界基线，保护本轮治理成果

- **位置/证据：** [eslint.config.js:20](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/eslint.config.js:20) 排除四个旧 Renderer，`:41` 只开启 no-undef；这有明确历史原因，但不阻止新增跨模块依赖。现有 manifest 检查针对 action coverage，不等于通用依赖边界检查。[tests/unit/renderer-dialogs-toolbox.test.js:1](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tests/unit/renderer-dialogs-toolbox.test.js:1) 等源码提取测试会锁住当前文件布局。
- **问题/触发场景：** 每迁出一个模块后，仍可通过新的深层 import、裸 SQL、全量 state 注入重新穿透边界；字符串测试可能阻止正常迁移，却未覆盖真实生命周期组合。
- **改法：** 用本次图作为有注释的历史基线，首批只限制新增循环、核心纯模块依赖 Electron/writer、已经迁出域的跨域深层依赖。迁移 G2/G3 时同步加入公开入口的生命周期行为测试；不一口气清零所有旧依赖或重写所有测试。
- **收益：** 边界逐步收紧，并能清楚看到本轮治理是否降低了变更范围。
- **成本/风险：** S，低；不增加大规模历史噪音。测试与 lint 路径必须在正式实现时接入仓库门禁，本报告的扫描脚本只是证据工具。
- **验收：** 新增一个受禁依赖应失败，删除已有边应通过；拆文件/改局部函数名而公共行为不变时，行为测试仍通过。检查对动态 require、IPC 和共享状态的覆盖边界须保留说明。

## 建议实施顺序

1. **先交付可独立验证的小切片：** G3 的 modalHost、G6 的 VCC lineage 校验边界、G8 的新增依赖基线。它们成本较小，分别解决已证实的生命周期接缝、缩小 writer 依赖、建立防回退检查。
2. **P1 主线：** G1 恢复所有权先明确契约与组合回归，再做 G2 业务任务适配器；旧 Renderer 按一个领域一个切片持续推进 G3。避免同一轮同时重写恢复、业务提交和清理语义。
3. **P2 扩展：** 先把 G4 共用解析、G5 query、G6 Acquiring 编排边界收拢，再用 G7 descriptor 减少公共注册点。每次只迁移一个消费者/业务，并保留兼容转发到验证结束。

优先级与施工顺序不同：小切片可以先落地，P1 表示最需要安排资源和契约验证的结构问题，不表示应直接开始大搬代码。

## 应保留的边界与不建议的治理

- BOR、resource governor、task lineage、outbox 和共享 publication 的一致性能力具有跨模块职责，应保留统一约束，不复制成各业务一套。
- [src/main-process/archive-center/task-lifecycle.js:15](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/src/main-process/archive-center/task-lifecycle.js:15) 已通过结果分类器和生命周期 hook 注入领域行为，可用作 G2 的基础；startup recovery coordinator 本身也已有中立接口。
- Position Renderer 的私有 state/scoped API、BizOP 控制器的 routeVersion 保护、Preload 的命名 API/取消订阅均是可复用的现有模式。
- [src/renderer.js:7133](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/src/renderer.js:7133) 明确记录资金对账网关流程与 ReconID 修复共享 session/引擎/导出的业务决策，不应为“低耦合”复制两套事实。
- backend 引用纯计算 `financial-decimal`、`engine-utils`，以及 Position 同域代码分在两层目录，主要是归属可读性问题；不应把全部 98 条反向引用判成 98 个缺陷。
- preload 六组字段副本当前比对一致，银行字段已有 smoke 同步断言。后续可补齐机器校验/生成，优先级低于本次八项；不以解除 sandbox 换取 require 便利。
- 不为降低行数机械拆 Main/Dialogs，不引入框架式插件系统，不为了统计消灭兼容代码，不把不同业务 reader 的日期/样式/表头规则强行合并。

## 辅助定性评价与置信度

这些 0–10 分仅用于描述已检查热点的维护性（高分较好），不是客观全仓得分，也不参与优先级计算。

| 维度 | 判断 | 依据 |
| --- | ---: | --- |
| 命名清晰度 | 7 | 大多数领域和协议名称明确；共享 SST/reader 的业务前缀隐藏真实归属 |
| 结构一致性 | 5 | 已有 worker/contract/repository 分拆，但 Main/旧 UI 仍集中跨域行为 |
| 耦合与依赖边界 | 4 | 无静态文件环是优点；恢复所有权、共享状态、跨表访问仍有高成本隐式依赖 |
| 错误处理可解释性 | 7 | 大量显式错误、失败关闭、owner/receipt 检查；基础读取错误仍携带 Position 语义 |
| 演进可理解性 | 6 | legacy guard 与分阶段接入有约束，但版本化模块和源码结构测试增加迁移成本 |

依赖数量与引用事实置信度高；优先级和成本估计为中等置信度，取决于后续业务变更频率。完整动态故障率、性能收益、Windows/Excel/WPS 行为不在本次已验证范围。

## 证据与复核

- [evidence/baseline.json](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/changes/architecture-coupling/2026-09-20/evidence/baseline.json)：冻结提交、起始工作区范围。
- [evidence/dependencies.json](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/changes/architecture-coupling/2026-09-20/evidence/dependencies.json) / `metrics-summary.json`：AST 依赖、精确源行、扇入扇出、循环、未解析及动态加载。
- [evidence/analyzer.json](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/changes/architecture-coupling/2026-09-20/evidence/analyzer.json)：技能工具原始输出，完整 685 文件，无扫描上限截断。
- [evidence/module-groups.json](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/changes/architecture-coupling/2026-09-20/evidence/module-groups.json)：路径归并统计，用于观察依赖方向，不能替代业务所有权判断。
- [evidence/modal-lifecycle-probe.cjs](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/changes/architecture-coupling/2026-09-20/evidence/modal-lifecycle-probe.cjs) / `.json`：真实源码片段的模拟 DOM 微探针。
- [evidence/preload-constants-probe.cjs](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/changes/architecture-coupling/2026-09-20/evidence/preload-constants-probe.cjs) / `.json`：六组字段副本与 constants 的一致性比对。

本次已复跑保存的三个证据脚本，与原始结果逐项相同；报告源码链接的文件存在性与行号范围已核对。结果见 [verification.json](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/changes/architecture-coupling/2026-09-20/evidence/verification.json)。

AST 扫描复核命令（输出到临时文件；需项目现有 Acorn 依赖）：

```sh
node changes/architecture-coupling/2026-09-20/evidence/scan-dependencies.cjs /private/tmp/bank-bill-coupling-20260920.4KM42C /private/tmp/coupling-dependencies-recheck.json 11086a3cbf632a30adbcfa796e4cd81810c5aef9
```

两项微探针复核命令：

```sh
node changes/architecture-coupling/2026-09-20/evidence/modal-lifecycle-probe.cjs /private/tmp/bank-bill-coupling-20260920.4KM42C
node changes/architecture-coupling/2026-09-20/evidence/preload-constants-probe.cjs /private/tmp/bank-bill-coupling-20260920.4KM42C
```

快照目录仅用于本次隔离取证；以后重新分析应从同一提交重新创建快照，或明确选择新基线。报告源码链接指向当前工作区，若工作区推进，请用本报告固定的提交与证据源行复核。
