# v3.2.10 TechDoc — Execution Descriptor 装配与校验

| 项目 | 内容 |
| --- | --- |
| 治理编号 / 优先级 | G7 / P2 |
| 目标版本 / 功能分支 | `v3.2.10` / `codex/v3.2.10-execution-descriptors`（计划名，未创建） |
| 开发基线 | `main` / 附注标签 `v3.2.9`，`11086a3cbf632a30adbcfa796e4cd81810c5aef9` |
| 集成目标 / 依赖 | `release/v3.2.10`；交付前已与 v3.2.9 同步；实施时记录 G1→G2 已集成的固定 SHA，见[总索引](../../README.md) |
| 日期 / 状态 | 2026-09-20 / v2（独立审查 R6 修订）；本稿设计，代码未实施，测试未执行 |
| 产品依据 | [Spec](spec.md)、[G1 TechDoc](../v3.2.10-application-recovery/techdoc.md)、[G2 TechDoc](../v3.2.10-business-task-adapters/techdoc.md) |

## 1. 文件与边界

| 位置 | 处理 |
| --- | --- |
| 拟新增 `src/main-process/execution-descriptors/contract.js` | 校验固定 descriptor 字段、重复与引用闭合；只依赖纯合同工具，无 Electron/业务 DB |
| 拟新增 `src/main-process/execution-descriptors/composition.js` | 显式 import 每个模块 factory，按固定列表装配；这是含 Main authority 的跨业务汇总点，由 Main 调用并将结果注入 runtime |
| 拟新增 `src/main-process/execution-descriptors/policy-catalog.js` | 只汇总各域 `policies` 常量并保留同名只读清单导出，供 Main/manifest/静态工具读取；不调用 factory、不持有运行状态 |
| 各域拟新增 `execution-descriptor.js` | 本域已有 policy/entry/validator/topology/binder/Archive hooks 的声明和闭包；不持有第二套运行状态 |
| `background-execution/runtime.js` | 消费聚合的现有 registry，删除 `entryBindingForPolicy` 及 validator/topology/input binder 的领域分支；保留 governor/supervisor/service 生命周期 |
| `archive-center/task-policy-registry.js` | 保留公共 file/no-file/exclude 和 inventory 校验，领域分类器/flow/metadata 从描述汇总；不再知道领域 channel 前缀 |
| G1/G2 的 coordinator/registry | 使用原接口；descriptor 只提供现有 registrations，不改内部执行顺序 |

领域文件固定放置：Toolbox 用 `toolbox-background/`（同时引用 row-split）、PreFund 用 `pre-fund-reconciliation/`、NewAccount 用 `new-account/`、FundRecon 用 `fund-recon-worker/`、Duplicate 用 `duplicate-inbound-match/`、ReconFix 用 `recon-id-fix-service/`、VCC 用 `vcc-financial-op-output/`、Position 用 `position-reconciliation/`、BizOP v327 用 `biz-op-v327/`。Pending/旧 BizOP/Acquiring mature adapter 暂存于拟新增 `execution-descriptors/mature-adapters.js`，只引用现有 adapter factory；statement/BankBU/VCC OP 和 exclude-only channels 由 `execution-descriptors/legacy-task-policies.js` 保留清单，不伪造 runtime policy。

上述两个兼容描述模块是明确的迁移归属，不允许 public runtime 再长回 switch。G6 调整 Acquiring 应用 service 后只更换 mature factory import；无需更改 descriptor contract。

G8 的最终公共机制检查覆盖 `background-execution/runtime.js`、`background-execution/execution-policy-registry.js`、`archive-center/task-policy-registry.js`、拟新增 `archive-center/task-policy-common.js` 与 `execution-descriptors/contract.js`；这些入口及其公共 helper 不能通过 import/require、聚合转发或动态加载回到领域实现，也不 import composition/policy-catalog。Main 调用 composition 后传入冻结聚合物，runtime 只消费它。允许跨域装配的精确文件为 `execution-descriptors/composition.js`、`policy-catalog.js`、`mature-adapters.js`、`legacy-task-policies.js`；各域 `execution-descriptor.js` 只绑定本域实现，mature/legacy 模块限于上文明列的兼容归属。policy-catalog 只读常量，不能借此运行 Main 工厂。迁移过程中保留旧转发的边界仍为 pending，最终转发删除后才能 active；不能把正常 Main 装配引用业务误判成通用引擎越界。

## 2. 内部 descriptor 合同

上述最终公共机制边界对应 G8 的 `ARCH-DESCRIPTOR-COMPOSITION`，正式规则及正反例见 [G8 TechDoc](../v3.2.10-architecture-guardrails/techdoc.md#governance-rules)；本项 G7-T5 负责更新实际消费者、删除精确兼容例外并激活。

```js
createModuleExecutionDescriptor(mainContext) => ({
  schemaVersion: 1,
  moduleId: string,
  policies: ExecutionPolicy[],
  entries: [{ key, value }],
  adapters: [{ key, value }],
  validators: [{ key, value }],
  resourceProfiles: [{ key, value }], // 仅动态 estimator，value 必须是同步函数
  topologies: [{ key, value }],
  mainBindings: [{ actionKey, bindInput, beforeDispatch, defaultUnits }],
  staticKeys: {
    entryKeys: string[], adapterKeys: string[],
    inspectorKeys: string[], conflictScopeResolverKeys: string[],
    settlementKeys: string[], publisherKeys: string[],
    technicalValidatorKeys: string[], businessValidatorKeys: string[], resultValidatorKeys: string[],
    serviceKeys: string[], resourceProfileKeys: string[], topologyKeys: string[],
    plannerKeys: string[], reducerKeys: string[]
  },
  archivePolicies: TaskPolicy[],
  taskAdapters: TaskAdapterRegistration[],
  taskBindings: [{ taskKey, adapterId }],
  terminalRoutes: TerminalRouteRegistration[],
  recoveryParticipants: RecoveryParticipant[]
})
```

全部字段必有，无能力用空数组；`mainBindings` 中 `bindInput` 必为函数（无专属策略用公共 `passthroughInput`），`beforeDispatch` 与 `defaultUnits` 不需要时显式 null。`ExecutionPolicy`/`TaskPolicy` 沿用既有精确字段，G2/G1 registration 完全引用其 TechDoc，禁止扩展新的 lifecycle hook。该新对象只存在 Main 内存中，不跨 IPC/worker。

entries 的 `value` 直接使用当前 entry binding 允许的函数、绝对 worker 路径或含 `path/workerData/cancellationTerminalErrorCodes/admittedTopologyWorkerData` 的对象，不重新定义 carrier contract。validator 等 key/value 也沿用现有静态 registry。同一 runtime registry namespace 中的 key 只能定义一次；多个 policy 可以引用它，但跨 descriptor 重复定义 value 一律拒绝，不以函数看似相同为理由覆盖。`staticKeys` 是无 value 的能力引用集合，允许多项 policy/descriptor 引用同一已声明 key，由聚合器去重；不能把同名字符串重复引用误判为重复 runtime 定义。

`mainContext` 是 composition 按域传入的最小能力对象：Main 确定的路径/getRuntime/getArchiveService、所需 DB provider、日志、startup gate 与 availableParallelism。不得传整个 Main globals 或可修改平台 registry。各 factory 只闭包捕获当前 generation 的 authority，不能回读 Renderer payload 作为 DB/entry/workerData 来源。

### 2.1 原 registry 的精确 bucket 与转换

直接使用 [STATIC_REFERENCE_PATHS:12](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/src/main-process/background-execution/execution-policy-registry.js:12) 的 bucket 名，不再提供 `inspectors`、`publishers` 等短别名，不在调用原 registry 前增加另一套重命名规则。全部 14 个 bucket 必有，空能力用 `[]`；只接受非空字符串元素。policy 中为 null/undefined 的可选引用不放入集合。对相同 bucket 做稳定并集并冻结，不同 bucket 不能互相抵消缺项。

| policy 引用字段 | descriptor / 聚合输出 `staticKeys` bucket | 可提供实现的原 runtime registry | 本次提供方式 |
| --- | --- | --- | --- |
| `entryKey` | `entryKeys` | `entryRegistry` | `entries` 的 key/value 建表；静态字符串不能替代真实 entry API |
| `adapterKey` | `adapterKeys` | `adapterRegistry` | `adapters` 的 key/value 建表；保留原 dispatch/start API 校验 |
| `commit.inspectorKey` | `inspectorKeys` | `inspectorRegistry` | 沿用静态 key 能力声明；实际 durable coordinator 不迁入 descriptor |
| `commit.conflictScopeResolverKey` | `conflictScopeResolverKeys` | `scopeResolverRegistry` | 沿用静态 key 声明及原提交机制 |
| `commit.settlementKey` | `settlementKeys` | `settlementProviderRegistry` | 沿用静态 key 声明及原 settlement 机制 |
| `artifacts.publisherKey` | `publisherKeys` | `publisherRegistry` | 沿用静态 key 声明及原 Publisher 装配 |
| `artifacts.technicalValidatorKey` | `technicalValidatorKeys` | `validatorRegistry` | `validators` 建表，保留原 callable 校验 |
| `artifacts.businessValidatorKey` | `businessValidatorKeys` | `validatorRegistry` | 与 technical/result 共用同一 validator namespace |
| `result.validatorKey` | `resultValidatorKeys` | `validatorRegistry` | 同上，不以 key-only 声明掩盖缺实现 |
| `service.serviceKey` | `serviceKeys` | `serviceRegistry` | 原三个 service key 与原 service 引擎；本次不额外制造 service value |
| `resources.profile` | `resourceProfileKeys` | `resourceProfileRegistry` | 每个静态 profile 均声明 key；只有原动态 estimator 才建 value，详见 §2.2 |
| `resources.compound.topologyKey` | `topologyKeys` | `topologyRegistry` | `topologies` 建表；compound 所需 planner 必须实际可调用 |
| `workUnits.plannerKey` | `plannerKeys` | `plannerRegistry` | 原 workUnits 静态声明；adapter/topology 的实际方法保持原装配 |
| `workUnits.reducerKey` | `reducerKeys` | `reducerRegistry` | 原 workUnits 静态声明，不新增占位 reducer |

转换只包含两个步骤：把 `entries/adapters/validators/resourceProfiles/topologies` 五组 `{key,value}` 分别注册进原五个 `createStaticRegistry()` 并 `.freeze()`；把各 descriptor 的 `staticKeys` 按上述同名 bucket 做并集。其余七个可选 runtime registry 本轮仍按原 runtime 不传入，不能为了让引用检查通过填 `{}`、`true`、空函数或泛用实现。冻结原 policy registry 时对静态 bucket 与对应 runtime registry 做原有 OR 解析，entry/adapter/validator 必须继续通过原 `requireRuntimeApis` 检查；本稿额外的 descriptor 闭合检查还要求 compound topology 是实际 planner。

### 2.2 静态资源 profile 与动态 estimator

三种数据各归原处，不能相互替代：

1. **静态能力 key**：每个 policy 的 `resources.profile` 都进入本域 `staticKeys.resourceProfileKeys`，包括有 estimator 的 profile；聚合后按字符串去重。此列表只证明名称存在，不含预算数值。
2. **静态预算**：完整保留该 policy 的 `resources.phase`（以及 compound/topology 原字段），随原 `ExecutionPolicy` 做 JSON snapshot/freeze；不创建第二张 profile→budget 表，不用占位函数搬运预算。
3. **动态估算**：`resourceProfiles` 只放当前确实注册了 estimator 的 key/value。[基线 runtime:465](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/src/main-process/background-execution/runtime.js:465) 只有 `resource.new-account:generate → estimateNewAccountGenerationPhaseResources`；其他 profile 不注册 value。该函数的作用域与参数规则原样迁移。

因此，普通静态 action 的 `policyRegistry.getBinding(actionKey, 'resources.profile')` 仍为 `undefined`，Supervisor 的 [resolveSimplePhaseResources:1478](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/src/main-process/background-execution/supervisor.js:1478) 仍直接使用 `policy.resources.phase`。NewAccount generation 得到原同步函数，输入仍为冻结的 `{actionKey,operationKey,jobId,context,input,staticPhase}`；Promise/thenable 继续触发 `RESOURCE_PROFILE_ESTIMATOR_ASYNC_UNSUPPORTED`，改变 workerThreadSlots/utilityProcessSlots 仍触发 `RESOURCE_PROFILE_TOPOLOGY_INVALID`。compound 继续走原 topology/预算机制，不能为了统一 profile 表而转到 simple-phase 分支。

迁移核对以冻结基线的每个 action 为行，保存 `profileKey, staticPhase, hasEstimator, estimatorOwner, topologyKey`；不能只比较 profile 总数。动态 estimator 定义重复或 key 不对应任何注册 policy 为设计错误，静态 profile 缺 key 为闭合失败；不得通过给所有 profile 新建函数绕过。若前置分支获批增加 estimator，必须记录其固定 SHA 和差量，再更新 fixture。

## 3. 聚合与接口输出

```js
composeExecutionDescriptors(mainContext) => {
  policies, entryRegistry, adapterRegistry, validatorRegistry,
  resourceProfileRegistry, topologyRegistry, staticKeys,
  bindInputForAction({actionKey, operationKey, input}),
  beforeCarrierDispatch(identity), defaultUnitsForAction(actionKey),
  archivePolicies, taskAdapters, taskBindings, terminalRoutes, recoveryParticipants
}
```

输出列表/对象与内部 map 均冻结，不返回可变 Map；使用封装 lookup 或 `createStaticRegistry().freeze()`。聚合过程固定：

1. 执行显式 factory 列表，校验 plain own-data descriptor（拒绝 getter、Proxy、额外键和非法函数槽）及 schemaVersion。
2. 对 moduleId、actionKey、channel、各 runtime value key namespace、adapterId、route 分别查重；staticKeys 的同 bucket 引用做稳定并集，语义允许引用，不允许第二次定义 value。
3. 按 §2.1 的精确 bucket/registry 映射检查 entry/adapter、result/artifact validator、resource profile、compound topology 全部闭合；按 §2.2 分开验证静态 profile 与动态 estimator。每个 runtime action 恰好一个 Main binding。
4. 用独立 `action-task-binding-registry` 验证 action/task 授权和完整 TaskPolicy inventory；legacy-only/canary 继续列入 manifest，但不强求它们有 production runtime entry。
5. 冻结上述五个 runtime registry 和同名 staticKeys；使用原 `createExecutionPolicyRegistry({policies,entryRegistry,adapterRegistry,validatorRegistry,resourceProfileRegistry,topologyRegistry,staticKeys,generatedAt})`，沿用现有 generatedAt 再调用 `.freeze()`，不得跳过真实原 registry 冻结过程。G2 registry/G1 coordinator 再按自身合同验证注册项。
6. Main 将已验证聚合输出交给 runtime，创建原 governor/supervisor。首次 worker/admission 前必须完成以上步骤，失败不留下部分可用 runtime generation。runtime 不自行 import composition 或按 action 补缺字段。

新增结构错误统一 `EXECUTION_DESCRIPTOR_INVALID`，冲突用 `EXECUTION_DESCRIPTOR_DUPLICATE`，缺 capability 用 `EXECUTION_DESCRIPTOR_REFERENCE_MISSING`，包含可信 descriptor id/key 诊断。现有 binder 对 payload override 的领域错误保持原码。未知 action 仍经原 policy/authority 失败关闭，不存在兜底 worker。

## 4. 领域映射与迁移的确定策略

| 领域组 | descriptor 移入的现有分派 |
| --- | --- |
| Toolbox（含 rows） | merge/split/route scanner/rows entry、取消码、单/多输出 validator；原 generation policy 原样引用 |
| NewAccount | generation worker 与 save-as inline 两路；resource estimator 按原 profile 登记 |
| PreFund / Duplicate / VCC subjects | 原 compound topology planner 和 child count；Duplicate workerData startup gate；VCC admitted topology workerData |
| FundRecon / Duplicate / ReconFix | 原 service keys、service entry 与不同 action result validator；不改 service lifetime 和 reservation |
| read-only exports | 现有领域目录 policies/validators/entry；Pending/旧 BizOP/VCC/Main authority binder 原样移动 |
| BizOP v327 | candidate/export validator 按原 commit kind 静态展开，beforeDispatch/bindInput 仍调用 module authority；carrier closure action keys 不减少 |
| mature adapters | Pending/旧 BizOP/Acquiring/Position 的现有 native adapter、inspectTopology、planner/reducer 与 workUnits 配套登记 |
| Archive 全部 channels | 当前 classifier、flowPlan/identity、resultMetadata/resultFlowIdentities 按模块移入；file plan 定义和 no-file/exclude inventory 独立校验 |

所有 action→entry 映射必须由迁移前 fixture 逐项保存期望（路径、carrier 种类、取消码、validator key、topology key、production flags），迁移后比较，而不是只比较 policy 数量。复杂 binder 使用输入样例验证冻结 authority 注入与 override 拒绝；函数源码或函数对象 identity 不作为行为等价依据。

Archive policy 构造将共用字段生成器保留为纯 `createBaseTaskPolicy`（拟新增于 `src/main-process/archive-center/task-policy-common.js`），领域 descriptor 传入明确 resolver/classifier，公共生成器不识别 channel 前缀。现有 `RESERVE_CHANNELS_BY_SCOPE`/`EXCLUDED_CHANNELS_BY_REASON` 等独立 inventory 保留校验职责，不用聚合结果反向生成“预期清单”。

## 5. G1/G2 装配和运行代际

恢复 participants 以 G1 定义的固定 id 顺序装配，composition 使用明确顺序表选择，descriptor 返回顺序不具有阶段含义；缺失、重复 participant 拒绝。G2 task adapter/terminal registry 分别接收聚合列表，不增加新的 execute/settle/cleanup 调用路径。

publication owner 与 application participant 是不同身份。仅复用 G1 已冻结的 `biz-op-v327`、`archive-publication` owner 注册及其 `forOwner(...)` 恢复能力；`archive-publication` 必须继续使用明确 taskKey/moduleId 白名单和各域 proof provider。`toolbox-vcc-publications` 若保留，只是 G1 的应用阶段/日志 participant id，不能登记为 publication owner，也不能将未识别记录自动转给 Archive owner。descriptor 不追加任意 publication owner 字段，不重写 G1 在副作用前验证 owner 的扫描/恢复接口；G1-T4 的实时恢复调用方清单和证明合同在 G7-T4 等价验证中一并保留。

每次 runtime manager generation 重建时重新构造 Main authority closures；旧 generation 的 active leases/workers 必须经原 drain/exit 屏障结束后才释放。不得缓存全局 descriptor 导致 DB 路径/资产目录变更后仍用旧 authority。纯 policy constants 可共享冻结引用，带路径与 DB provider 的 bindings 必须按代创建。

5 秒准入、超预算立即拒绝、取消、真实 worker exit、carrier closure、receipt/hold/generation 都继续由原引擎执行。descriptor 不持有任务运行表，不新增取消/重试策略，不处理用户文件删除。

## 6. Manifest、兼容和回滚

`BACKGROUND_EXECUTION_POLICIES` 的名称、只读值和清单用途保留，由新 `execution-descriptors/policy-catalog.js` 汇总提供；必须确保读取清单不触发 DB/worker 初始化。领域 `policies` 与含 Main closures 的 factory 分离，catalog 只 import 纯 policy 导出。旧 runtime 路径可在迁移期转发该常量，但必须全仓迁移其读取者到 policy-catalog 后删除转发，随后才激活 §1 的 G8 公共 runtime 边界；不能一面保留 runtime→catalog→领域路径，一面宣称该边界完成。其他兼容导出同样记录调用者与移除条件。避免 runtime→composition→runtime 环。

action authority 的私有 literal、binding digest、TaskPolicy inventory 的语义不变；源码迁移会改变 source hashes，更新 `scripts/check-background-execution-manifest.js` 使用的既有 snapshot/生成逻辑并重新校验。检查必须能发现“不更新 authority 就增加生产 action”的错误，不能把所有预期都从 descriptor 自身推导。基线固定 67 action / 74 pair / 49 runtime / 134 TaskPolicy / 13 production-enabled，若依赖分支获批改动，则在验证记录明确列出批准提交及差量。

迁移期可以由 composition 包装某域旧工厂，但一个 action 只能走一套绑定；每迁完一域删除 runtime 对应分支。终态 legacy route 和 compatibility exports 保持可读取；生产无调用的内部选择 helper 在最终阶段删除。回滚只还原装配代码与相应源 hash snapshot，不迁移/删除 DB、journal、receipt 或用户文件；退出仍等原屏障。

## 7. 实施任务、测试与完成

| 任务 | 完成标准 | AC |
| --- | --- | --- |
| G7-T1 | 保存基线 action/capability/binder/Archive behavior fixture；实现纯 contract 与聚合校验 | G7-AC-02、G7-AC-03、G7-AC-04、G7-AC-08 |
| G7-T2 | 迁移 Toolbox/NewAccount；建立正反注册与无分支测试 action 验证 | G7-AC-01、G7-AC-03、G7-AC-07 |
| G7-T3 | 迁移 compound/service/read-only/BizOP/mature bindings；删原重复选择分支 | G7-AC-01、G7-AC-02、G7-AC-05 |
| G7-T4 | 迁移 Archive 领域 policy，装配 G1/G2 registrations，保持固定顺序与历史 routes | G7-AC-01、G7-AC-02、G7-AC-06 |
| G7-T5 | 更新合法 source hashes/coverage，删除 shim，加入依赖边界并完成所有有效策略对照 | G7-AC-01—G7-AC-08 |

| 测试路径 | 内容 | AC |
| --- | --- | --- |
| 拟新增 `tests/unit/main-process/execution-descriptor-contract.test.js` | exact shape、重复 key、缺 capability、冻结、getter/Proxy、未知 action，副作用计数为零 | G7-AC-03、G7-AC-04 |
| 拟新增 `tests/unit/main-process/execution-descriptor-equivalence.test.js` | 每 action 映射 fixture、Archive policy行为、binder override、跨 generation authority、production false | G7-AC-01、G7-AC-02、G7-AC-05、G7-AC-06 |
| 拟新增 `tests/unit/main-process/execution-descriptor-resource-profiles.test.js` | 逐当前 runtime action 对照全部 14 类静态引用、phase 和 estimator 有无；真实调用原 registry freeze/getBinding，覆盖纯静态 action、NewAccount 动态估算、缺 profile、错误旧 bucket 名、Promise 与 topology slot 变更拒绝；无新增泛用 estimator | G7-AC-02、G7-AC-03、G7-AC-05、G7-AC-08 |
| 拟新增 `tests/unit/main-process/execution-descriptor-extension.test.js` | 独立非生产 harness 增加测试 action 仅改 descriptor；生产 authority 拒绝它；不提供 production override 参数 | G7-AC-03、G7-AC-07 |
| 复用 `tests/unit/main-process/background-execution/action-task-binding-registry.test.js`、`manifest-coverage-e13-g.test.js` | 独立 authority、67/74/49 等覆盖面与有效生产策略；源 hash 合法更新 | G7-AC-02、G7-AC-04 |
| 复用 `tests/unit/main-process/background-execution/policy-registry.test.js`、`supervisor.test.js`、`carrier-observation.test.js` | 准入/取消/退出、validator/topology、closure | G7-AC-03、G7-AC-05 |
| 复用 `tests/unit/main-process/archive-task-policy-registry.test.js`、G1/G2 新增组合测试 | task kind、flow/metadata/lineage，participant 顺序与旧终态路由 | G7-AC-02、G7-AC-06 |
| 拟新增 `scripts/integration/execution-descriptor-governance.js` | 使用隔离临时数据对 thread/inline/service/adapter 各一条既有样例进行端到端验证 | G7-AC-02、G7-AC-05、G7-AC-06 |

本次测试均未执行。实施时先跑对应单测、`npm run check:background-execution-manifest` 和集成脚本，正式 PR-ready/交付运行最终 `npm run release-check`。非生产 harness 的测试 action 不进入生产 manifest；涉及 Windows packaged carrier 的验证沿用现有 canary，未执行必须单列，不能用源码 registry PASS 代表已打包运行成功。

## 8. 切片实施记录与规则同步（文档补充）

沿用本稿既有阶段及任务 ID，按[切片完成标准](../../README.md#slice-completion)逐项交付。优先复用本功能目录已有的 `implementation-notes.md` / `verification.md`；首次实施且没有适用记录时建立 `implementation-notes.md`，使用[实施记录与状态要求](../../README.md#slice-record)中的最小字段，避免同一事实多处维护。设计 AC 和测试计划与实际迁移状态、执行结果分别记录，本次不建立实施记录占位文件。

按[各治理项现行规则入口映射](../../README.md#current-rule-entrypoints)同步本切片影响的规则正文和入口链接。只有职责已在实际生产调用路径落地的模块才能记为现行入口，尚未实现的模块继续标为拟新增；不影响规则时，在切片记录中写明无需更新及原因。本次为文档要求补充，不表示生产实现、边界激活或验证已经完成。

## 实施接口补充（固定依赖 8b12a6d5）

- `contract.compileExecutionDescriptors(descriptors, { generatedAt })` 负责结构/引用/真实 registry freeze；生产 `composition.composeExecutionDescriptors` 无条件调用独立 `validateProductionExecutionDescriptors`，不提供 authority 或 production override。分开是为非生产 harness 复用机制，未放松正式入口。
- `mainBindings.defaultUnits` 为显式 `null` 或返回原冻结 units 的函数；beforeDispatch 为显式 `null` 或原派发函数。新增纯 `descriptor-builder.js` 仅减少领域结构重复。
- 各域 Archive hooks 在 `archive-task-policies.js`，mature/legacy 的兼容范围仍由本稿 §1 的两个精确文件承接；没有另增跨域 helper。
- G1 的 `createApplicationRecoveryParticipants`/固定顺序、G2 的 `createBusinessTaskAdapterRegistrations` 从原工厂提取只读注册快照；原工厂复用它们。所有者 TechDoc 与当前 README 同步，coordinator、TaskLifecycle、adapter/terminal 引擎不变。
- Main 的启动 task/terminal 装配与后续 recovery 装配只提交当时就绪的对应 registrations，runtime generation 每代重建路径/authority closures。全量 action/Archive inventory 校验每次仍执行；不在 recovery 未就绪时伪造空 hook。
- 既有 manifest 生成器输出当前版本 G7 evidence/manifest-current，source hashes 纳入新增实际装配/领域源码；已发布 v3.2.5 快照原样保留。

本节记录实际接口落点，验证结果仅见 implementation-notes.md；不修改原 G7 AC。

## 实施后审查修复（2026-09-21，R1 / R2）

[用户分支审查](review-2026-09-21.md)补充了原正向验证未覆盖的反例。本次修复落实已有 AC-02/04/05，不改变业务验收范围或默认策略。

- R1：新增纯 `background-execution/approved-execution-baseline.js` 与只读 JSON。批准数据取自固定 `8b12a6d5` 的旧 runtime 实际导出，与冻结 `11086a3c` fixture 的49条 policies核对一致；保存67-action capability及effective strategy投影。composition分别对compiled和catalog核验该固定数据，禁止二者相互或同时漂移自证。私有action/task authority继续独立校验。
- manifest生成器复用同一固定基线检查；`--write`在任何mkdir/write前拒绝漂移，不生成或覆盖批准JSON。批准JSON及validator加入source hash。未来批准更新须有独立来源SHA、明确语义差量和审查，不能靠刷新manifest吸收错误。该投影不涵盖全部资源phase或载体函数行为，原fixture/registry/真实载体测试继续负责。
- R2：compiler新增`getBeforeCarrierDispatchForAction(actionKey)`，返回真实hook或null。runtime交给Supervisor，Supervisor每次start固定本action的hook，然后沿用原production必需检查与派发时序。保留旧单回调接口和严格聚合beforeCarrierDispatch；完全未注入BizOP/通用派发授权的非生产无hook恢复旧行为；若已注入BizOP，composition为其他缺自身hook的action保留原必抛拒绝函数，含非生产，不引入成功no-op或跨action借用。

复现、红绿测试、独立复核和更新后的完整门禁仅见[实施记录](implementation-notes.md#review-fixes)，旧审查及旧门禁日志保留其原适用范围。
