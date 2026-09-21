# v3.2.10 Spec — 按模块集中执行与归档能力注册

| 项目 | 内容 |
| --- | --- |
| 治理编号 / 优先级 | G7 / P2 |
| 目标版本 | `v3.2.10` |
| 功能分支 | `codex/v3.2.10-execution-descriptors`（计划名，未创建） |
| 开发基线 | `main` / 附注标签 `v3.2.9`，`11086a3cbf632a30adbcfa796e4cd81810c5aef9` |
| 集成目标 / 依赖 | `release/v3.2.10`；交付前已与 v3.2.9 同步；实施时记录 G1→G2 已集成的固定 SHA，见[总索引](../../README.md) |
| 日期 / 状态 | 2026-09-20 / v2（独立审查 R6 修订）设计稿，代码未实施，本文测试未执行 |
| 需求依据 | 用户要求按功能分支明确治理执行；[审查报告 G7](../../../architecture-coupling/2026-09-20/review.md) |
| 配套文档 | [TechDoc](techdoc.md)、[总索引](../../README.md) |

## 1. 目标与范围

为各业务提供固定结构的 execution descriptor（执行能力描述）。每个模块在自己的描述文件里集中登记已有 policy、entry/adapter、validator、topology、Main input binder 和 Archive policy/adapter；一个显式装配入口完成汇总、覆盖校验与冻结。通用 runtime 和 Archive registry 按已验证注册项工作，不再反复根据同一 action/module 做业务分派。

descriptor 是内部代码模块，不是配置文件插件、动态加载框架或新的生命周期引擎。资源准入、worker 管理、task/batch/outbox 和启动恢复继续由现有 governor/supervisor、TaskLifecycle、G1 coordinator 和 G2 adapter/route registry 执行。

本分支迁移当前 runtime 已注册的策略和 Archive task policy 的领域选择；保留未启用能力、legacy-only action 与 canary 的原状态。不通过架构治理扩大后台执行能力或打开 feature flag。

## 2. 当前耦合与治理边界

- [runtime.js](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/src/main-process/background-execution/runtime.js:208) 分别按 action/module 选择 entry、validator、topology 和 Main binder；增加一个业务可能要改多个公共分支。
- [task-policy-registry.js](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/src/main-process/archive-center/task-policy-registry.js:815) 再分配 classifier、flow、metadata 和 result lineage，定义与业务执行装配分散。
- [action-task-binding-registry.js](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/src/main-process/background-execution/action-task-binding-registry.js:6) 的私有 literal 是授权真相，manifest/capability/effective production strategy 为独立检查面。本项必须沿用，不能让 descriptor 自报授权并同时自证。

首版保持基线清单的语义覆盖：67 个 canonical action、74 个 action/task pair、134 个 TaskPolicy inventory、49 个 runtime policy；Capability 与 production flag 分离，当前 13 个 production-enabled action 的有效策略不因搬迁改变。实施期间若依赖分支产生已批准的清单变化，应固定依赖 SHA 并采用该批准清单，不在此分支自行扩容。

## 3. 注册与执行行为

1. Main 在创建 runtime generation 前构造 descriptor。数据库路径、assets/userData、platform resources、startup gate 和授权对象只来自 Main；Renderer 只能传原业务 payload。
2. 启动时检查 descriptor 结构、重复 id/action/runtime value key、必需 entry/validator/topology/binder、action authority 和 task coverage。非法注册在任何业务 worker、publication 或归档副作用前拒绝。
3. 校验通过后冻结 registry，运行时只查表。未知 action、缺失能力、请求覆盖数据库 authority 仍按既有拒绝路径失败；不得退到未登记的 worker 或泛用默认 binder。
4. 每个 action 显式选择已有的 thread/inline/service/adapter 路线和取消错误码。无特别 input binding 的 action 登记显式 passthrough；不能因“不写 binder”默认为允许任意输入。
5. Archive 每个 channel 的结果分类、flow identity、file/no-file/exclude、worker context、source lineage 和 result metadata 与基线一致。G2 的任务适配器和终态路由只被引用装配，不重新实现。
6. G1 的恢复参与者按既定顺序装配，不按 descriptor 排序推导启动顺序；publication owner 只使用 G1 的 `biz-op-v327` 与 `archive-publication` 授权，后者保留明确 taskKey/moduleId 与领域 proof，不能用“其他 owner”兜底。失败关闭、恢复预算、5 秒资源准入和真实 exit 屏障原样保留。
7. 静态能力使用原 registry 的精确 bucket 名（含 `resourceProfileKeys`）；静态资源预算继续来自 `policy.resources.phase`，只有原本注册动态 estimator 的 action 保留该函数。缺失能力不得用泛用 estimator、空函数或占位值补齐。
8. Manifest 的逻辑 action 集合、绑定 authority 和生产策略保持兼容；移动源码产生的 source hashes 必须通过既有生成/校验入口重算。禁止为了通过检查修改独立 authority 去匹配错误的 descriptor。

## 4. 场景与异常矩阵

| 场景 | 预期 |
| --- | --- |
| 现有 action 正常执行 | 使用与基线相同的 policy、entry、validator、topology、binder、Archive semantics |
| 同模块多个 action 共用 validator/topology | 在该模块注册表中只声明一次，多 policy 引用同一个 key；不能冲突覆盖 |
| 重复 module id/action/channel/runtime value key | 启动失败并给出冲突 key；不能采用最后一个覆盖前一个 |
| 缺 validator、binder 或 compound topology | 启动或 admission 前拒绝，无 worker、副作用或 TaskRun 误写 |
| Renderer 输入带 databasePath、assetsDir、entryKey 或注册对象 | 保留既有 override-forbidden 行为；注册对象不能经 IPC 扩展 authority |
| unknown action、非法 action/task binding | 由独立 authority/coverage 校验拒绝，descriptor 不能自行授予调用权 |
| 静态资源 action / 动态 estimator | 静态 action 的 profile 由静态 key 声明、没有 runtime estimator，继续取原 phase；NewAccount generation 保留原同步 estimator、输入及拒绝异步/拓扑 slot 变更规则 |
| runtime generation 切换 | 每代重新使用 Main 的有效路径和 authority 装配；已有任务继续用原代冻结证据，不串用新旧路径 |
| production=false 的已实现能力 | 继续原 legacy 路径，不因 descriptor 中存在 entry 被启用 |
| 取消、退出、恢复 | 原错误、5 秒准入、实际 worker exit、receipt/hold/generation 和 owner 保护不变 |

## 5. 兼容与非目标

无公共 IPC、DB schema、文件格式或持久化身份变化。不改业务算法、预算数值、默认并行度、feature flag、历史 terminal route、Archive 删除或保留规则。不支持扫描目录自动发现模块、远程安装描述、配置中写函数名、Renderer 注入模块路径或运行时热注册。

`BACKGROUND_EXECUTION_POLICIES` 的名称与只读清单保留，由纯 policy-catalog 提供；原 runtime 路径的短期兼容转发在所有读取者迁移后移除，才激活通用 runtime 的 G8 边界。TaskPolicyRegistry 等现有接口暂保留兼容，内部从聚合结果取得。兼容导出不能再维护第二份 literal 清单。历史 action/route 不能因当前不产出新任务而删除。

## 6. 验收

| 编号 | 条件 |
| --- | --- |
| G7-AC-01 | runtime 和公共 Archive policy 构造不再逐业务选择 entry/validator/topology/binder/classifier；业务差异在领域 descriptor 中 |
| G7-AC-02 | 现有 policy/Archive policy 的逐 action 行为及有效 production 策略与冻结基线一致，legacy-only/canary 覆盖保留 |
| G7-AC-03 | 重复、缺失、unknown、非法 authority 与输入覆盖均在副作用前失败；registry 冻结后不能改变 |
| G7-AC-04 | descriptor 与私有 action-task authority、manifest、capability inventory 交叉校验；source hash 合法重算，语义 drift 被拒绝 |
| G7-AC-05 | 同一 action 的取消、错误、资源准入、worker exit、跨代隔离和恢复行为不回退 |
| G7-AC-06 | G1 参与者顺序和 G2 adapter/terminal contract 原样接入，没有第二套生命周期引擎或隐式默认 owner |
| G7-AC-07 | 非生产测试 registry 可装配一个独立测试 action，执行时无需修改通用 runtime 业务分支；生产 authority 仍拒绝该 action |
| G7-AC-08 | 全部现有 runtime policy 的静态 bucket/registry 引用按原名字闭合，并通过原 registry 的真实 freeze；逐 action 静态 phase、estimator 有无及其行为与基线一致，静态 action 不被补造函数 |

## 7. 分阶段实施

先引入 G1→G2 的已集成固定 SHA 并记录。A 建立 descriptor contract、聚合校验和基线对照；B 从 Toolbox/NewAccount 开始逐模块迁移，随后迁移有 binder、compound、service 和 mature adapter 的模块；C 迁移 Archive policy 的领域选择并汇总 G1/G2 registrations；D 删除兼容内部分派、更新 manifest source hash 和行为回归。

该分支在 G1/G2 之后集成，G6 Acquiring 服务接口已落地时通过 descriptor 引用其公开工厂；若尚未落地，使用当前工厂，不复制仓储编排。G8 的 `ARCH-DESCRIPTOR-COMPOSITION` 对最终公共 runtime/registry 增加禁止领域深层依赖的检查；Main 的显式 composition、纯 policy-catalog 及明列的 mature/legacy 描述汇总入口保留必要装配权限，准确路径与激活条件见 TechDoc §1。

文档结构参考 v3.2.9“模块存档保留期限”Spec。上述均为拟实施合同，本文没有记录任何测试 PASS。

本次文档补充统一交付要求：每个切片均按[切片完成标准](../../README.md#slice-completion)验收，并按[实施记录与状态要求](../../README.md#slice-record)区分本稿设计 AC、实际实施进度与已取得的验证证据；本补充不改变上述业务验收条件。
