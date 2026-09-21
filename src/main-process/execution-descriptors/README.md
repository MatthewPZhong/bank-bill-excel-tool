# 执行与归档描述符

本目录集中 Main 的静态装配。入口是 [composition.js](composition.js)，机制合同是 [contract.js](contract.js)。运行时按冻结 registry 查表；资源准入、Supervisor、TaskLifecycle、publication 授权、应用恢复状态及业务终态仍由既有所有者维护。

| 入口 | 职责与消费者 |
| --- | --- |
| `composeExecutionDescriptors(mainContext)` | 显式调用九个领域 factory、mature 与 legacy 注册，编译后无条件执行私有 action/task authority 与固定批准 capability/production strategy 基线校验，catalog 也独立接受同一基线检查；不接收 descriptor override 或动态发现目录。 |
| `createBackgroundExecutionRuntime` / `createNonProductionBackgroundExecutionRuntime` | 先构造本代描述与 Main authority，再交给公共 runtime。非生产隔离 governor 仍使用原受限入口。 |
| `createBackgroundExecutionRuntimeManager` | 每代重新读取 Main providers；生产策略查询使用纯 catalog，不隐式创建 generation；原 drain/exit 屏障保持。 |
| `createTaskPolicyRegistry` | 显式汇总所有领域与 legacy Archive policies，再交给公共 `archive-center/task-policy-registry.js`。供 Main、operation-tracker、BizOP 与测试读取。 |
| `createExecutionTaskComposition` | 消费 G2 注册快照，在 descriptor 中汇总后交给原 task adapter / terminal route registries。134 个受控 task 必须双向闭合，exclude 不得绑定。 |
| `createApplicationRecoveryComposition` | 消费 G1 注册快照；按 G1 的固定顺序重排，传回原 G1 composition/coordinator。不会按 descriptor 枚举顺序执行恢复。 |
| `validateProductionExecutionDescriptors` | 独立生产校验面，由正式 composition 无条件调用；非生产测试 action 即使自报 production=false 也不能进入生产 inventory。 |
| [policy-catalog.js](policy-catalog.js) | 只读 `BACKGROUND_EXECUTION_POLICIES` 与 production 查询；只引用纯 policy 文件，不运行 descriptor 工厂。 |
| [descriptor-builder.js](descriptor-builder.js) | 领域内构造 exact 字段、引用集合与去重；不能替代独立 compiler 校验，也不补造 estimator 或缺失实现。 |

## 领域归属与资源

Toolbox（含 rows）、NewAccount、PreFund、FundRecon、Duplicate、ReconFix、VCC、Position、BizOP v327 在各自 `execution-descriptor.js` 绑定本域已有 policy、entry、validator、topology、Main input binding。归档规则由同域 `archive-task-policies.js` 提供。

[mature-adapters.js](mature-adapters.js) 只汇总原 Pending / 旧 BizOP / Acquiring 的兼容能力与 Archive hooks；Acquiring 继续调用已经集成的 G6 公开工厂。[legacy-task-policies.js](legacy-task-policies.js) 保留 Statement、Linked、BankBU、VCC OP 和 exclude inventory，不伪造 runtime policy。

五个真实 registry 是 entry、adapter、validator、resourceProfile、topology；精确 14 个 static bucket 与原 policy registry 的名字一致。只有 NewAccount generation 注册动态 estimator。其余 action 的 `resources.profile` binding 为 undefined，预算仍来自 `policy.resources.phase`；compound 继续消费原 planner。没有泛用 estimator、默认 worker 或缺失能力 fallback。

Main input binding 必须逐 action 明确声明。无特别策略的 action 使用显式 passthrough；受保护的 database/assets/provider 来自 Main 本代上下文，原领域 override 错误码保持。通用 Main 派发回调只补充没有领域 beforeDispatch 的条目，不能覆盖 BizOP 自身 authority。compiler 的 `getBeforeCarrierDispatchForAction(actionKey)` 返回该 action 的真实函数或 null；Supervisor 在每次任务开始时固定它。完全未注入 BizOP/通用派发授权时，非生产 closure 无 hook 保持原观察路径；若已注入 BizOP 授权，composition 对其他缺自身 hook 的 action 显式保留旧拒绝函数，非生产也拒绝。production closure 无 hook 始终在载体前拒绝，其他 action 的 hook 不能代替。原单函数 Supervisor 调用方式及严格聚合 `beforeCarrierDispatch` 接口保留。

## 所有权与允许依赖

公共 runtime、execution-policy registry、Archive registry/common 和 descriptor contract 只依赖机制模块；它们不得 import composition、policy-catalog、领域实现，也不得借公共 helper 间接回到领域。精确跨域装配入口是本目录的 composition、policy-catalog、mature-adapters、legacy-task-policies。新增域只能绑定本域实现。

compiler 校验 exact shape、重复、getter/Proxy、静态引用和真实 API，再执行原五 registry 与原 policy registry 的 freeze。它复制并冻结所拥有的数据，保留函数闭包，不冻结外部 owner。compiler 可供独立测试 harness 使用，编译通过不授予生产 action 权限；生产 composition 另外执行私有 authority 与独立 inventory 检查。

批准的 runtime/legacy-only/canary 能力及有效生产策略保存在 [approved-execution-baseline.json](../background-execution/approved-execution-baseline.json)，来源是固定 release `8b12a6d5` 的旧 runtime 导出，并与原 `11086a3c` fixture 逐 policy 核对。纯 [批准基线校验器](../background-execution/approved-execution-baseline.js) 私有冻结该快照，分别核验 compiled 与 catalog 的完整 67-action 投影，不允许相互自证，也不接收 baseline override。该投影检查注册状态、mode/adapter/commit/artifact/resource profile 与有效 production 策略；phase 预算、entry/validator/topology 和取消行为仍由原 registry 及固定行为测试验证，不能把投影检查称为全部业务行为验证。

G1/G2 各自的注册快照接口只提取原 registrations，执行机制仍唯一归它们。详见 [应用恢复说明](../application-recovery/README.md)、[任务适配说明](../task-adapters/README.md)。publication owner 仍只有 G1 注册的 `biz-op-v327` 与 `archive-publication`；`toolbox-vcc-publications` 是 participant id，不是新的 publication owner。

## 新增或迁移 action

1. 先明确业务合同与独立 action/task authority、TaskPolicy inventory 及批准能力/生产策略是否允许该 action；descriptor 不能自行扩权。批准基线更新须单独记录来源 SHA 和语义差量，不能从待校验 descriptor/catalog 重采样。
2. 在领域纯 policies 中定义策略，在领域 descriptor 绑定真实 entry/adapter/validator/topology 和明确 Main binder；静态 profile 声明 key，预算留在 policy，确实需要动态估算才注册同步 estimator。
3. 在领域 Archive policies 中维护 classifier/flow/metadata/lineage，保留 file/no-file/exclude 和业务身份。task adapter、terminal route、recovery participant 只消费 G1/G2 公共注册接口。
4. 在显式 composition 和纯 catalog 增加引用；核对旧调用方、脚本与测试。公共 runtime 不增加 action/module 分支。
5. 补固定行为差分、注册负例和适用真实载体验证；通过既有 manifest 生成器更新当前版本证据，不改历史发布快照或私有 authority 来迎合错误实现。manifest `--write` 在任何 mkdir/write 之前核验固定批准基线，并且从不重建批准 JSON。

runtime 旧路径的 `BACKGROUND_EXECUTION_POLICIES`/production 查询转发已删除，读取者改为 catalog；调用 runtime 工厂的生产/脚本/测试改用 composition。公共 Archive registry 不再有无参默认领域装配；同名便利工厂位于显式 composition。G1/G2 原工厂仍作为合法公共接口保留，共用注册快照，不维护第二份清单。

## 验证与边界状态

- [descriptor 合同](../../../tests/unit/main-process/execution-descriptor-contract.test.js)：exact shape、重复、缺能力、恶意输入、冻结与原 registry 消费。
- [基线与资源](../../../tests/unit/main-process/execution-descriptor-resource-profiles.test.js)、[Main 绑定及代际](../../../tests/unit/main-process/execution-descriptor-equivalence.test.js)：49 action 映射、静态 fallback、同步 estimator、正常注入/拒绝与 provider 重读。
- [Archive 行为](../../../tests/unit/main-process/execution-descriptor-archive-baseline.test.js)：268 channel 及固定分类/flow/metadata/lineage 样例。
- [G1/G2 装配及公共依赖](../../../tests/unit/main-process/execution-descriptor-composition.test.js)、[独立扩展与生产拒绝](../../../tests/unit/main-process/execution-descriptor-extension.test.js)。
- [独立批准基线负例](../../../tests/unit/main-process/execution-descriptor-production-baseline.test.js)：已知 action 漏注册、未批准启用、legacy 增补、等数替换、catalog 独立/同步漂移与生成器零写入。
- [派发兼容](../../../tests/unit/main-process/execution-descriptor-dispatch-compatibility.test.js)：非生产 null hook、实际已启用的生产缺 hook、混合列表与本域 authority。
- [真实载体集成](../../../scripts/integration/execution-descriptor-governance.js)：隔离临时数据的 thread、inline、service、adapter；完整恢复另沿用 G1/G2 组合测试。

G8 尚未纳入本 worktree，机器配置未激活、没有增加例外。上述本地传递依赖检查验证现行公共入口；G8 集成时据此登记 `ARCH-DESCRIPTOR-COMPOSITION`，不能把本地测试说成机器配置已 active。人工 Windows、Electron GUI、Excel/WPS 与安装包验收独立记录。

设计合同见 [G7 Spec](../../../changes/v3.2.10/codex/v3.2.10-execution-descriptors/spec.md)、[TechDoc](../../../changes/v3.2.10/codex/v3.2.10-execution-descriptors/techdoc.md)。切片状态、实际验证、SHA 和剩余项仅在 [实施记录](../../../changes/v3.2.10/codex/v3.2.10-execution-descriptors/implementation-notes.md) 维护。
