# G7 执行与归档描述符实施记录

> 2026-09-21 第二轮复审通过：R1/P2 自证校验缺口与 R2/P3 非生产兼容回退均已关闭，本轮审查范围内未发现新增问题。当前实现、本地验证与复审通过，尚未提交或集成；平台验收与 G8 激活仍待完成。修复过程见 [审查修复](#review-fixes)，最新结论见 [第二轮复审](#review-r2-accepted)。历史记录按原时点保留。

本文件记录当前实现、验证与集成状态。设计合同见 [Spec](spec.md)、[TechDoc](techdoc.md)，完成标准见[总索引 §6.2–§6.4](../../README.md#slice-completion)。Spec 表头和 TechDoc 原设计章节中的“拟新增/未实施”是设计时状态；实际接口补充与本记录说明后续实施事实，不把设计审查当测试证据。

## 固定代码与文档来源

- 分支：`codex/v3.2.10-execution-descriptors`；worktree：`/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/v3210-execution-descriptors`。
- 初始基线：本地 main / v3.2.9，`11086a3cbf632a30adbcfa796e4cd81810c5aef9`。先完成 registry 清点及基线测试准备，未在 G2 dirty 状态迁移生产装配。
- 正式迁移前纳入固定 release 提交：`8b12a6d5fd71b70ade58b9b6e7a347e29dbe8d05`，也是当前 HEAD。采用 fast-forward，没有创建本任务提交。
- G1：功能提交 `856c9dce8ae4c381229e37b5b236e2e2f776921d`，集成提交 `5ccbf3f022488026f725a5111be00422a04ce221`。G2：功能提交 `3e203858ea49fc2935f5ab847de8af7f793d356a`，集成提交即上述固定 release。四个提交均经 ancestor 检查；该 release 也已含 G4/G5/G6，使用其现有接口。
- 当前 G7 代码是 **HEAD + 未提交差异**，未集成到 release。完整源码及测试差异见 [code.diff](evidence/code.diff)，文件摘要见 [source-snapshot.json](evidence/source-snapshot.json)；已跟踪与新增文件均包含，未用暂存/提交来生成差异。依赖证据见 [dependency-integration.json](evidence/dependency-integration.json)。
- 设计首先从用户指定主工作区绝对路径读取，原输入摘要保留于 [design-inputs.json](evidence/design-inputs.json)。纳入 release 时采用其已集成文档，G7 实施补充更新本项及 G1/G2 接口说明；不能再将“原输入摘要”称为所有当前文档摘要。
- 依赖前记录保留于 [preparation-implementation-notes.md](evidence/preparation-implementation-notes.md)、[registry-inventory.md](registry-inventory.md) 和 [preparation-review.md](preparation-review.md)。其中 G2 阻塞结论已经失效。`preparation-delivery-snapshot.json` 存在读取 refs 与旧状态文字的时间交错，不作为当前依赖结论。

## 首轮切片状态（后续修复见文末）

| 切片 | 实现状态 | 验证状态 | 集成状态 |
| --- | --- | --- | --- |
| G7-T1 / 含准备子切片 T1a | 已实现：固定基线、exact contract、真实 registry 编译冻结 | 通过：专项及最终完整门禁 | 未集成 |
| G7-T2 | 已实现：Toolbox/NewAccount 与独立测试 action | 通过：专项、真实 thread/inline 及完整门禁 | 未集成 |
| G7-T3 | 已实现：其余 runtime bindings 与纯 catalog | 通过：专项、真实 service/adapter 及完整门禁 | 未集成 |
| G7-T4 | 已实现：Archive policies、G1/G2 registrations | 通过：专项及最终完整门禁 | 未集成 |
| G7-T5 | 代码及 source-hash 收口已实现；G8 配置激活待与 G8 联合集成 | 通过：本地传递边界、manifest 及完整门禁；G8 激活未验 | 未集成；G8 未纳入此固定依赖 |

状态不把局部 PASS 扩大为正式交付通过。下面每个切片的代码状态均为上述固定 HEAD + 本任务差异。

## G7-T1：冻结基线与编译合同

1. **职责与边界**：`execution-descriptors/contract.js` 仅负责 exact shape、引用闭合、重复检查和调用原五种 registry / policy registry 的真实 freeze；`descriptor-builder.js` 减少领域结构重复。生产独立 authority 校验归 `composition.validateProductionExecutionDescriptors`，无可跳过的生产 override。
2. **调用方与兼容**：所有领域 factory 使用同一固定结构；compiler 也供非生产测试 harness 使用。编译成功不授予生产权限，私有 `action-task-binding-registry.js` literal 未改。
3. **业务行为**：保留全部 14 个 static bucket、49 个 runtime policy 和 estimator 有无。拒绝 getter/Proxy、稀疏/循环/符号/额外字段、重复 key、缺 binder/capability/compound planner；复制并冻结所拥有的数据，不冻结传入 owner。对应 AC-02/03/04/08。
4. **验证证据**：6 个新增单测文件联合 **73/73 PASS**，见 [descriptor-suite-final.tap](evidence/descriptor-suite-final.tap)。其中合同与扩展 13 项、资源 11 项；固定 runtime / Archive JSON fixture 采自初始 `11086a3c`，迁移后未重新采样。真实 Supervisor 验证静态 phase、动态 memory、Promise 与 slot 漂移拒绝，且在载体创建前停止。
5. **当前规则入口**：新增 [模块 README](../../../../src/main-process/execution-descriptors/README.md) 的合同、依赖、资源和新增 action 章节；根 AGENTS 与总索引增加导航。G8 状态见 T5。

## G7-T2：Toolbox / NewAccount 首批装配

1. **职责与边界**：两个领域的 `execution-descriptor.js` 显式绑定原 worker/inline entry、validator、topology、Main binder，公共 runtime 接收冻结描述，不再选择业务实现。
2. **调用方与兼容**：Main、脚本及测试的 runtime 工厂移到显式 composition；核心 runtime 仍提供通用机制构造，但必须注入 descriptor。运行数据和 IPC payload 不能提供 descriptor。没有保留反向 import 领域的 runtime shim。
3. **业务行为**：Toolbox rows 原生产启用、其余 Toolbox 及 NewAccount 原 legacy 状态保持。静态资源仍取原 phase；NewAccount generation 是唯一动态 estimator。save-as action 常量移至已有纯 `generation-contract.js`，`artifact-copy.js` 保留原导出、值与 copy 行为不变。对应 AC-01/03/07/08。
4. **验证证据**：两个独立非生产 action 经真实 Supervisor 执行，生产 authority 都拒绝；真实 Toolbox thread 生成并读回 XLSX，NewAccount inline 按模板复制并核对 hash，见 [carrier-integration-final.txt](evidence/carrier-integration-final.txt)。save-as/资源/等价相关回归 68 项在修复后通过；完整门禁覆盖其最终源状态。
5. **当前规则入口**：模块 README 的 Main binding、静态资源及新增 action 步骤；旧路径迁移说明由同一 README 维护，无第二份 literal。

## G7-T3：其余 runtime bindings

1. **职责与边界**：PreFund、FundRecon、Duplicate、ReconFix、VCC、Position、BizOP v327 各域 descriptor 拥有原 validator/topology/binder；`mature-adapters.js` 仅承接 Pending/旧 BizOP/Acquiring 原兼容装配，Acquiring 使用集成 G6 的公开工厂。
2. **调用方与兼容**：`BACKGROUND_EXECUTION_POLICIES` 与 production 查询移至纯 `policy-catalog.js`，保持名称、原只读清单和策略；全部真实 runtime 调用方转用 composition。manager 保持 lazy 创建，每代重新读取原 Main providers。具体迁移文件见最终差异。
3. **业务行为**：49 action 的原绑定、默认 units、取消码、拓扑与保护字段不变；显式 passthrough 不代替受保护 binder。通用 beforeDispatch 只填原本无领域 hook 的条目，不能覆盖 BizOP authority；13 个 production-enabled 保持，未开启 legacy/canary。按域聚合后的内部 `policyRegistry.list()` 枚举顺序变化，无调度语义；纯 catalog 的原顺序保留，G1 恢复顺序另由其固定合同保证。对应 AC-01/02/05。
4. **验证证据**：逐 action fixture 对照、全部 Main binder 正常路径、19 次缺 authority / 10 次覆盖拒绝、12 项 BizOP 委派、跨 generation provider、真实 service/adapter 集成均通过。严格 catalog 子进程测试曾发现 NewAccount 经常量 import 间接加载 worker 模块，修复后不加载 descriptor 工厂、DB 或 worker 引擎。
5. **当前规则入口**：模块 README 的领域归属、允许依赖、调用方兼容和每代装配；G6 原模块说明继续拥有 executor/service 语义，未重复定义。

## G7-T4：Archive 与 G1/G2 注册

1. **职责与边界**：Archive 公共 registry 仅校验显式 policies、独立 file/no-file/exclude inventory；同域 `archive-task-policies.js` 持有 classifier、flow、metadata、lineage。公共 `task-policy-common.js` 只有纯机制；mature/legacy 精确入口承接既有跨域兼容集合。TaskLifecycle、adapter registry、terminal registry、G1 coordinator 仍为唯一执行机制。
2. **调用方与兼容**：无参 `createTaskPolicyRegistry()` 便利装配入口移至 composition；公共 registry 需显式 policies。少数原领域 helper 导出迁入实际所属域/common/legacy，消费者同步。G1 新增纯参与者快照接口和固定顺序导出，G2 新增纯 adapter/binding 注册快照接口，原工厂复用，原调用方式保留。
3. **业务行为**：完整 268 channel = 71 file + 63 no-file + 134 exclude；134 可恢复任务双向闭合，4 adapter、4 历史 route 保留。G1 参与者按原固定顺序重排，重复调用仍由原 coordinator 收敛；publication owner 仍为 `biz-op-v327` / `archive-publication`，不新增默认 owner。对应 AC-01/02/06。
4. **验证证据**：Archive 基线 35 项测试，27 组固定样例执行 6,357 次 channel/sample 行为比较（不是 6,357 项单测）；composition 9 项验证真 G2 factory、缺失/重复/多余/exclude 注册、装配无 DB 副作用、真 G1 hooks/顺序/失败屏障。Pending 真实 XLSX→SQLite 导入经过 G2 prepared scope、TaskLifecycle 与 Archive，输入 blob hash/终态/outbox/BOR 均核对。该集成手动创建最小 passthrough 绑定；完整 134-task/四 route 的真实 composition 由单测覆盖，两者不合称完整 Main 启动端到端验收。完整恢复继续由既有 G1/G2 集成及最终门禁覆盖。
5. **当前规则入口**：同步 [G1 README](../../../../src/main-process/application-recovery/README.md)、[G2 README](../../../../src/main-process/task-adapters/README.md) 与两份 TechDoc 的快照 API；本模块 README 仅链接其生命周期正文。

## G7-T5：消费者、manifest 与边界收口

1. **职责与边界**：删除旧公共 runtime 内部分派和 catalog 转发；公共 registry 不再偷偷装配领域。独立 authority/coverage/capability/production strategy 始终校验。现有 manifest 生成器重算 source hashes，输出当前版本 G7 evidence，已发布 v3.2.5 历史证据不改。
2. **调用方与兼容**：生产、脚本、既有测试与子进程 fixture 一并迁移；保留刻意使用 core runtime 的非生产扩展测试。对旧装配函数名的源码断言改为验证新入口及其返回 registry，不删除原 Position owner 安全断言。内部 policy list 测试改为排序后比较完整独立集合，资源和启用断言保留。
3. **业务行为**：独立覆盖仍为 67 canonical action / 74 pair / 49 runtime policy / 134 mutation TaskPolicy / 13 enabled。无 IPC、DB schema、输出格式、预算、feature flag、归档删除或保留规则变化。对应 AC-01—08。
4. **验证证据**：`node scripts/check-background-execution-manifest.js --write` 合法生成，`npm run check:background-execution-manifest` 校验当前 source hashes；coverage 402/402。新增 Acorn 正反例检查 5 公共入口共 31 传递依赖文件；含经 helper 回边负例，避免只查直接 import。最终完整门禁通过，详见下节。
5. **当前规则入口**：根 AGENTS → 模块 README 的依赖/消费者/验证章节，总索引 G7 入口改为功能分支已建立。**G8 尚未纳入固定 release，`ARCH-DESCRIPTOR-COMPOSITION` 配置未激活，也未增加例外**；本地测试不冒充 G8 active。G7-T5 的机器规则激活须在 G8 联合集成时登记，属剩余集成工作。

## 首轮验证过程与证据（修复前）

平台为 macOS 15.7.4 arm64 / Node v25.8.0；本 worktree gitignored `node_modules` 链接主工作区现有安装，不新增依赖。真实数据验证使用隔离临时目录，所有 carrier 在 shutdown/exit 与 lease/dependency 归零后才清理。

- 依赖前新测试 43/43、既有 registry 69/69；最初缺 `xlsx` 的测试环境失败及修复后重跑保留在 preparation 证据中。
- 初始 manifest 校验发现历史快照为 54/61/36/0，而初始真实基线已为 67/74/49/13。诊断见 [manifest-baseline-diagnosis.json](evidence/manifest-baseline-diagnosis.json)；当前改为独立校验当前版本合法生成结果，未修改历史 authority。
- 第一轮全量单测：**8,377/8,417，36 fail、4 skip，exit 1**，见 [unit-implementation.txt](evidence/unit-implementation.txt)。其中 29 项在迁移文件临时移除期间遇到 `MODULE_NOT_FOUND`；其余暴露 4 项子进程仍使用旧 core runtime、1 项错误 catalog import、1 项内部 list 顺序断言、1 项旧 Main 工厂名称断言。已据此修复调用方与精确断言，旧日志保留；不能将此轮算作 PASS。
- 最终新增 descriptor 单测：**73/73，0 fail/skip/TODO**，见 [descriptor-suite-final.tap](evidence/descriptor-suite-final.tap)。
- 真实四载体集成：**4/4 PASS，exit 0**，见 [carrier-integration-final.txt](evidence/carrier-integration-final.txt)。
- 最终命令 `UNIT_TEST_CONCURRENCY=4 npm run release-check`：**PASS，exit 0**。lint、smoke 通过；单测 **8,508/8,512，0 fail、4 skip**，536 个文件，431,407 ms；**67/67 集成脚本、2,668/2,668 检查通过**，352,661 ms。日志见 [release-check-final.txt](evidence/release-check-final.txt)，该轮机器摘要见 [before-validation-final.json](evidence/review-fix-20260921/before-validation-final.json)。4 个 skip 是 Windows PowerShell snapshot/token cleanup、真实 CIM 遍历及两个 packaged canary 测试，不计为本机已验证。G1 application-recovery-governance 4/4、G2 task-adapter-recovery 4/4、Position startup-task-recovery 3/3 均在本次完整命令通过。
- 集成 runner 按既有规则自动同步 `rules/integration-test-policy.md` §七（67 脚本、2668 检查）；未改其测试政策正文。最终已跟踪差异和新增源码 whitespace 检查通过；当前模块说明/实施记录/审查的本地链接可达。
- 独立最终审查见 [final-review.md](final-review.md)，审查是补充证据，不代替自动化与平台验收。

## 剩余项与回退

- G8 联合集成后激活实际机器规则并跑其正反例，记录 release SHA；当前未宣称该规则 active。
- Windows packaged carrier、Electron GUI、Excel/WPS 与安装包人工验收未执行。本次治理不改变界面，但源码/本机真实载体测试不能证明打包平台验收。
- 本功能未提交、未推送、未合入 release/main、未开 PR、未升版或发布；以上操作等待用户后续明确指令。
- 回退仍按 TechDoc §6：整体回退 descriptor 装配与其对应消费者/source-hash 证据，恢复原业务工厂入口；不能只留下半套 shim。无本项持久化格式迁移，无需回写用户 DB/journal/receipt/outbox。依赖固定 release 保持独立，不将其既有实现视为 G7 回退范围。

<a id="review-fixes"></a>

## 实施后审查修复：R1 / R2

代码仍为 `codex/v3.2.10-execution-descriptors`、固定 HEAD `8b12a6d5` 加未提交差异；复用同一worktree，未移动HEAD或覆盖既有改动。[用户审查报告](review-2026-09-21.md)及其原始证据原样带入；[本轮修复差异](evidence/review-fix-20260921/fix-code.diff)对照用户隔离快照，并核对首轮128文件摘要，Supervisor旧内容取自固定HEAD。

| 修复切片 / 父切片 | 实现状态 | 验证状态 | 集成状态 |
| --- | --- | --- | --- |
| G7-T5-R1 / G7-T1、T5：固定批准基线 | 已实现，R1 已关闭 | 定向及修复后完整本地门禁通过；第二轮复审通过 | 未提交、未集成 |
| G7-T3-R2 / G7-T3：派发hook兼容 | 已实现，R2 已关闭 | 定向及修复后完整本地门禁通过；第二轮复审通过 | 未提交、未集成 |

### G7-T5-R1：从自校验改为独立批准基线

1. **职责与边界**：新增纯`background-execution/approved-execution-baseline.{js,json}`；JSON来自`git archive 8b12a6d5`的旧runtime实际导出。与原冻结fixture逐policy深比较一致，来源及hash见[provenance](evidence/review-fix-20260921/approved-baseline-provenance.json)。helper私有冻结数据，不import领域或composition/catalog，不接受baseline override。
2. **调用方与兼容**：正式composition对compiled/catalog分别校验固定67-action capability和strategy；manifest生成器在任何写入前执行相同检查，不刷新批准JSON。私有action/task authority与独立非生产compiler harness保持原用途。
3. **业务行为**：原三反例已复现，见[p2-before.json](evidence/review-fix-20260921/p2-before.json)；复用用户探针、仅改变负例预期后的[authority-after.json](evidence/review-fix-20260921/authority-after.json)显示原三反例均拒绝。修复后漏注册、未批准启用及legacy新增均拒绝；同数量action替换、仅catalog漂移及两者同步漂移也拒绝。当前合法49 runtime / 13 production及67 canonical / 74 pair不变。批准投影不代表启动时验证所有policy字段，静态phase、entry/validator/topology、取消等仍由原registry和等价测试负责。对应AC-02/04。
4. **验证证据**：先加9项负例得到红结果[p2-red.tap](evidence/review-fix-20260921/p2-red.tap)，修复后加正常49/13用例为10项全通过。与补修后的P3联合21/21，见[fixes-focused.tap](evidence/review-fix-20260921/fixes-focused.tap)；manifest写入负例断言零mkdir/零write、四份输出及批准JSON摘要不变。
5. **当前规则入口**：更新[模块README](../../../../src/main-process/execution-descriptors/README.md)的批准来源、投影范围、新action步骤及生成器约束，TechDoc补接口；沿用根AGENTS/总索引导航。G8尚未集成，无active或例外变更。

### G7-T3-R2：非生产关闭观察兼容

1. **职责与边界**：compiler提供只读`getBeforeCarrierDispatchForAction`；runtime注入Supervisor，Supervisor在任务开始时固定当前action的真实hook或null。仍由原Supervisor负责生产必需检查、准入、载体与真实退出。
2. **调用方与兼容**：保留Supervisor旧`beforeCarrierDispatch`单回调入口及compiler严格聚合接口；生产runtime使用新逐action查询。无全局any-hook、no-op或按错误码吞异常，混合列表不能借其他action的hook。
3. **业务行为**：完全未注入BizOP/通用派发授权的非生产无hook恢复到达adapter的旧行为；已注入BizOP时，其他action无自身hook继续显式拒绝（含非生产）。实际已启用的`toolbox:split-rows`生产缺hook仍在载体前拒绝，避免被production-disabled错误遮挡；已有hook时序、主动拒绝与BizOP本域authority保持。对应AC-02/05。
4. **验证证据**：首版专项曾错误地将混合列表的非生产放行也作为目标（首次终端结果7 pass / 3 fail，未单独落盘），首版10/10及20/170联合PASS因此不覆盖旧混合拒绝合同。完整门禁发现这一范围错误后，保留原BizOP断言并纠正新增测试；以显式拒绝fallback恢复旧语义。原问题的原始文件证据为[用户差分输出](review-2026-09-21-evidence/runtime-diff-output.txt)，当前复用同一差分探针的[runtime-after.txt](evidence/review-fix-20260921/runtime-after.txt)显示旧/新非生产均spawned=1且49条映射一致。首版20/170结果保留在`fixes-focused-initial.tap`与`descriptor-supervisor-initial.tap`；纠正后的最终专项与完整门禁以本节最新记录为准，不能复用首版PASS。专项替身adapter只用于观察入口边界，不冒充实际业务worker验收。
5. **当前规则入口**：模块README与TechDoc补逐action hook语义；不改变carrier identity、协议、取消及终态合同。G8状态同上。

### 本轮最终证据与剩余事项

- `npm run check:background-execution-manifest`已通过；source hashes纳入批准JSON/helper与本轮修改的Supervisor。
- 修复后首轮完整门禁 **exit 1：8527/8532，1 fail、4 skip**，未进入集成。唯一失败是原`biz-op-v327.test.js:772`混合授权拒绝合同，日志[release-check-first-attempt.txt](evidence/review-fix-20260921/release-check-first-attempt.txt)。已保留旧断言并修复composition的明确拒绝fallback；补修后的21项专项、171项descriptor/Supervisor联合及12项P3/原BizOP混合门禁定向全部通过（有重叠，不相加）；最终完整门禁已重新执行并通过，日志为[release-check.txt](evidence/review-fix-20260921/release-check.txt)。原8508/8512及67脚本PASS也仅属于更早修复前内容。
- **修复后的最终门禁：`UNIT_TEST_CONCURRENCY=4 npm run release-check`，exit 0。** lint、smoke通过；538个单测文件，**8529/8533，0 fail、4个Windows专用skip**，总耗时399408 ms；**67/67集成脚本、2668/2668检查**，530328 ms。G7真实载体4/4、G1恢复4/4、G2恢复4/4、Position启动恢复3/3、后台恢复控制27/27均在本次命令通过。当前49 runtime/13 production、67 canonical/74 pair、268 Archive channel不变。
- 最新专项日志：[21项修复专项](evidence/review-fix-20260921/fixes-focused.tap)、[171项descriptor/Supervisor联合](evidence/review-fix-20260921/descriptor-supervisor.tap)、[12项P3/原BizOP回归](evidence/review-fix-20260921/p3-mixed-gate-green.tap)，这些集合有重叠，不相加。新增混合负例的[红阶段日志](evidence/review-fix-20260921/p3-mixed-gate-red.tap)保留，既有BizOP断言未改。
- 最终[机器验证摘要](evidence/validation-final.json)与[交付快照](evidence/delivery-snapshot.json)已刷新；133个源码/测试文件、本轮9个修复文件及manifest 42个source hash逐字节核验一致，见[收尾核对](evidence/review-fix-20260921/closeout-checks.json)。完整门禁期间源码未变化。已跟踪差异与43个新增源码文件whitespace检查通过；四份当前文档的本地链接已再次核对可达；独立复核阶段的84条链接检查也已通过。
- 独立修复复核见[review-fix-2026-09-21.md](review-fix-2026-09-21.md)，历史`final-review.md`及用户报告均不改写。
- G8联合集成、Windows packaged、Electron GUI、Excel/WPS及安装包人工验收仍未执行；未提交、推送、合并、开PR、升版或发布。
- 回退按原TechDoc整套装配/消费者回退；仅回退本次修复会重新引入R1/R2，不能恢复“独立校验验收通过”的结论。无持久化schema或用户文件迁移。

<a id="review-r2-accepted"></a>

## 第二轮复审接收与问题关闭（2026-09-21）

用户提供的[第二轮审查报告](review-2026-09-21-r2.md)及其证据已从主工作区绝对路径原样带入本 worktree，复制后逐文件核对内容一致。本次只归档复审材料并更新本实施记录；源码、测试、Spec/TechDoc 及既有完整门禁记录均未修改，没有重新执行测试，也没有新增实现切片。

- **实现状态**：G7-T5-R1（父切片 T1/T5）、G7-T3-R2（父切片 T3）已实现，R1/P2 与 R2/P3 均按本轮复审结论关闭；审查范围内未发现新增问题。代码状态仍为 `8b12a6d5fd71b70ade58b9b6e7a347e29dbe8d05` HEAD 加既有未提交实现与修复。
- **验证状态**：本轮独立复审实际执行 206/206 单测（11 个文件、0 fail/skip）、4/4 真实载体集成、manifest 402/402 surfaces / 74 pairs / 13 production-enabled，以及原反例、批准来源和 getter 生命周期探针。详见[结构化汇总](review-2026-09-21-r2-evidence/verification-summary.json)；探针与单测不合并计数。
- **既有全量证据**：复审核对修复后的 133 个文件摘要、源码快照摘要和完整日志摘要均匹配。已有 `release-check` 为 8529 pass / 4 skip / 0 fail、67 个集成脚本及 2668 检查全通过，详见[已有证据审计](review-2026-09-21-r2-evidence/existing-evidence-audit.json)。完整门禁未在本轮复审或本次归档时重跑，不把上述结果记作新执行。
- **职责、调用方与业务边界**：沿用上文 R1/R2 五项记录；复审独立确认固定批准基线不读取候选 descriptor/catalog 生成期望，getter 每任务只读取一次自身 hook、不能借用其他 action 授权，等待 hook 时取消最终零 worker、零活动租约且 shutdown 正常。当前仍为 49 runtime / 13 production；复审未引入新合同或扩大批准投影范围。
- **当前规则入口**：继续以[模块 README](../../../../src/main-process/execution-descriptors/README.md)、本项 TechDoc 及根 AGENTS/总索引为准。本次仅接受验证结论，职责和接口未变化，因此无需更新模块规则正文。G8 配置仍未激活，留待对应联合集成变更。
- **集成状态与剩余事项**：G1/G2 依赖维持已记录的固定 release SHA；G7 未提交、未推送、未合入 release/main、未开 PR、未升版或发布。G8 规则激活、Windows 打包、Electron GUI、Excel/WPS、安装包及真实用户数据故障恢复验收仍未完成，不纳入此次复审通过结论。回退仍沿用原 TechDoc 与上文记录。
