# G7-T1a registry 与迁移映射清点

> 本文保留依赖前 `11086a3c` 的清点快照；正式迁移、已纳入的 G1/G2 SHA、当前入口及测试结论以 [实施记录](implementation-notes.md) 和 [模块说明](../../../../src/main-process/execution-descriptors/README.md) 为准。

基于 `11086a3cbf632a30adbcfa796e4cd81810c5aef9`。本清单记录既有代码，未执行生产迁移。逐行消费者及对应文件摘要见 [consumer-inventory.json](evidence/consumer-inventory.json)，依赖现状见 [实施记录](implementation-notes.md)。以下代码路径均相对于本 worktree 根目录，行号为本基线。

## 当前装配和调用链

| 职责 | 现有位置 | 后续迁移必须保持 |
| --- | --- | --- |
| policy 聚合 | `src/main-process/background-execution/runtime.js:153` | 49 条 policy，包括 production=false |
| entry/carrier 选择 | 同文件 `:208` | 路径/inline、取消码、Rows limits、Duplicate startup gate、VCC admitted topology workerData |
| mature adapters | 同文件 `:366` | Acquiring/Position 现有工厂与 Main authority |
| validators | 同文件 `:392` | technical/business/result 共用 namespace，异步业务验证仍在 Publisher 前 |
| resource estimator | 同文件 `:465` | 只有 NewAccount generation 有动态 estimator |
| topology | 同文件 `:468` | PreFund/Duplicate/VCC planner、mature inspectTopology |
| static references / freeze | 同文件 `:493`、`:530` | 精确 14 buckets；调用原 registry freeze |
| Main binding / dispatch | 同文件 `:555` | BizOP authority、Pending/旧 BizOP/VCC/ReconFix override 拒绝和 defaultUnits |
| runtime generation | 同文件 `:904` | 每代重读 providers；不能全局缓存带路径 closures |
| production 查询 | 同文件 `:954` | 只读查询不能顺带创建 runtime generation |
| Archive policy 构造 | `src/main-process/archive-center/task-policy-registry.js:815`、`:925` | classifier、flow、metadata、lineage 与独立 file/no-file/exclude inventory |

## 原 registry 精确映射

下表来自 `execution-policy-registry.js:12`。runtime 只传五种实现 registry，其余七种实现 registry 维持未传入；不能为闭合检查制造空函数。

| policy 引用 | static bucket | runtime registry |
| --- | --- | --- |
| `entryKey` | `entryKeys` | `entryRegistry` |
| `adapterKey` | `adapterKeys` | `adapterRegistry` |
| `commit.inspectorKey` | `inspectorKeys` | `inspectorRegistry`（未传） |
| `commit.conflictScopeResolverKey` | `conflictScopeResolverKeys` | `scopeResolverRegistry`（未传） |
| `commit.settlementKey` | `settlementKeys` | `settlementProviderRegistry`（未传） |
| `artifacts.publisherKey` | `publisherKeys` | `publisherRegistry`（未传） |
| `artifacts.technicalValidatorKey` | `technicalValidatorKeys` | `validatorRegistry` |
| `artifacts.businessValidatorKey` | `businessValidatorKeys` | `validatorRegistry` |
| `result.validatorKey` | `resultValidatorKeys` | `validatorRegistry` |
| `service.serviceKey` | `serviceKeys` | `serviceRegistry`（未传） |
| `resources.profile` | `resourceProfileKeys` | `resourceProfileRegistry`（仅一个 estimator） |
| `resources.compound.topologyKey` | `topologyKeys` | `topologyRegistry` |
| `workUnits.plannerKey` | `plannerKeys` | `plannerRegistry`（未传） |
| `workUnits.reducerKey` | `reducerKeys` | `reducerRegistry`（未传） |

`execution-policy-registry.js:255` 用 static OR runtime 解析引用，同时强制 entry/adapter/validator 真实 API。原 freeze 本身不强制 topology callable；后续 descriptor contract 必须补 compound planner 闭合验证，不能用本次 registry 测试替代。`supervisor.js:1478` 无 estimator 时使用 `policy.resources.phase`；thenable 和 carrier slots 改变分别拒绝为 `RESOURCE_PROFILE_ESTIMATOR_ASYNC_UNSUPPORTED`、`RESOURCE_PROFILE_TOPOLOGY_INVALID`。

## 调用方与兼容迁移

`BACKGROUND_EXECUTION_POLICIES` 有 10 个既有外部文件读取者，正式阶段全部改到纯 policy-catalog；同时读取 runtime factory 的文件须拆开 import。准备切片新增的 helper 属于后续新增测试消费者，也须同步迁移。

| 类型 | 文件 |
| --- | --- |
| scripts（4） | `scripts/check-background-execution-manifest.js`；`scripts/validate-v3-2-2-release-evidence.js`；`scripts/validate-v3-2-3-release-evidence.js`；`scripts/validate-v3-2-4-release-evidence.js` |
| unit（2） | `tests/unit/main-process/acquiring-read-only-export-e13-c.test.js`；`tests/unit/main-process/biz-op-v327-upgrade.test.js` |
| background unit（4） | `tests/unit/main-process/background-execution/acquiring-adapters-e13-e.test.js`；`pending-bizop-adapters-e13-d.test.js`；`position-import-adapter-e13-f.test.js`；`manifest-coverage-e13-g.test.js` |

runtime manager 的生产调用在 `src/main.js:513,832`，另有 carrier-observation / toolbox-background-generation 测试。runtime factory 被 5 个脚本和 24 个单测文件直接调用；非生产 factory 被 1 个 benchmark、1 个 helper 和 7 个单测文件调用。完整命中在机器清单中。这些工厂调用者需要正式 composition 或测试装配，不能把全部 import 简单改成 policy-catalog。非生产 governor override 仍只属于受限测试入口。

Archive factory 的生产调用方：

| 位置 | 目的 |
| --- | --- |
| `src/main.js:1285` | 全局 registry，随后冻结 action/task binding |
| `src/main-process/archive-center/operation-tracker.js:36` | module load 阶段无参构造 registry 并取 list，生成 channel 集合 |
| `src/main-process/biz-op-v327/module.js:137`、`import-main.js:54` | import policy |
| 同目录 `compute-main.js:30`、`delete-main.js:25` | run/delete policy |
| 同目录 `export-main.js:20`、`upgrade-main.js:250` | export suffix / maintenance policy |

此外有 3 个 integration scripts、5 个 fixture、15 个单测文件；精确路径/行号见机器清单。Main 还直接读取 `createBankStatementRunFlowIdentity`、`invocationBusinessRunIdentity`；helpers 移到领域或纯 common 时也必须迁移这些读取者。`TaskPolicyRegistry` 类和 `ARCHIVE_TASK_POLICIES` 除定义/导出外未发现生产直接调用；规则测试中的字符串不是调用者。

保留 runtime 常量转发仅限迁移期；全部读取者迁移后删转发，才激活 G8 公共 runtime 边界。Archive 无参 `buildPolicies()` 不能成为永久兼容漏洞。module-load 的 operation-tracker 和 manager 的纯 production 查询是两个容易遗漏的入口，正式迁移需专门验证初始化次序与无副作用读取。

## 独立 authority 与后续门禁

- `action-task-binding-registry.js:6,21` 固定 67 action / 74 pair / 134 mutation TaskPolicy 和 digest，私有 literal 不由 descriptor 生成。
- `coverage-check.js:93` 拒绝不在独立 canonical 清单内的 action；manifest/capability/production 三个检查面继续独立。
- `manifest-coverage-e13-g.test.js:50,86` 已固定 67/74/49/13；现有实际运行结果在实施记录。
- `scripts/check-background-execution-manifest.js:38` 目前记录九个 source paths。G7-T5 需把正式新装配入口纳入既有来源摘要流程；准备阶段不改历史 snapshot。
- 本轮新测试 fixture 是固定期望，不作为生产授权；依赖集成后先核实批准差量及 SHA，再有依据地调整基线。
