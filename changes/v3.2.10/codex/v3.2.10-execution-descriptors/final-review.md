# G7 执行与归档描述符实施后独立审查

审查日期：2026-09-21。结论：本次限定范围未发现需要阻断 G7 代码交付的 P1/P2 缺陷。正式生产装配已从公共 runtime / Archive registry 移至明确 composition，静态资源 fallback、独立 action authority、原有效生产策略、G1/G2 注册合同和固定基线在本次检查范围内保持。此结论不是 release-ready、G8 规则激活或平台人工验收结论。

## 范围与快照

- worktree：`/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/v3210-execution-descriptors`。
- 分支：`codex/v3.2.10-execution-descriptors`；HEAD：`8b12a6d5fd71b70ade58b9b6e7a347e29dbe8d05`。当前 G7 为该固定 release 基线上的未提交差异，不以 HEAD 冒充 G7 已提交或集成。
- 设计依据：[Spec](spec.md)、[TechDoc](techdoc.md)及其“实施接口补充（固定依赖 8b12a6d5）”。审查读取生产入口、各域 descriptor、公共机制、G1/G2 composition 差异、manifest 生成器及相关新增测试；没有修改代码或测试。
- 本次源摘要：对 `execution-descriptors/*.js`、各直接领域目录的 `execution-descriptor.js` / `archive-task-policies.js`，以及 `src/main.js`、公共 runtime、Archive registry/common、G1/G2 composition 共 30 个文件，按相对路径排序，将每个文件 SHA256 字典以 JSON sorted keys / compact separators 编码后再做 SHA256，结果为 `3ab461d3878338c493e24b0102d0561e03a526fe979b8cec0d6b157b63129e10`。
- 本审查仅独占并新增本文件。其他 Agent 正在维护实施记录、差异及门禁证据；其最终状态以匹配最终源码的实施记录为准。

## 关键检查与结论

| 关注点 | 实際落点与结论 | 验证边界 |
| --- | --- | --- |
| Main 正式装配 | `src/main.js` 的 runtime manager、task/terminal registry、application recovery 三条路径均改为调用 `execution-descriptors/composition.js`。composition 显式列出九个领域 factory 加 mature/legacy，不动态发现目录；编译后无条件做独立生产授权/coverage 校验 | 已阅读生产调用和相关差异；不是只看未被调用的新模块 |
| 公共机制边界 | runtime 只消费注入的冻结 policyRegistry 和 Main binder API；Archive registry 保留独立 file/no-file/exclude inventory 校验并显式接收 policies；common 仅构造公共字段。五个公共入口的实际传递 require 图未发现领域或 composition/catalog 回边 | 已运行 Acorn 传递依赖测试及其正反例。此测试针对当前 require 图；G8 配置仍待集成，不宣称机器规则 active |
| policy-catalog | `BACKGROUND_EXECUTION_POLICIES` / production 查询由纯 catalog 提供。NewAccount save-as action 常量从含执行能力的 artifact-copy 移入纯 generation-contract，使 catalog 不再间接加载其运行能力 | 独立子进程测试拒绝 DB、worker、Electron、runtime/composition 加载并通过。旧 runtime 常量转发已删除 |
| contract 与原 registry | exact descriptor 字段、14 个精确 static buckets、重复 namespace、getter/Proxy、非法 function slot 与 compound planner 闭合均校验；随后仍调用原五个 static registries 与原 execution policy registry 的真实 freeze | 负例与原 freeze 测试通过；公共 registry 没有增加业务实现 |
| 资源静态 fallback | 48 条 action 的 `resources.profile` binding 仍为 undefined；仅 NewAccount generation 注册原 estimator。真实 Supervisor 的无 estimator 分支使用原 static phase；动态估算不允许 Promise 或 carrier slot 漂移 | 已复跑真实准入探针；保留 5000ms 参数、base lease 释放及零 worker 启动断言。它不证明实际超时等待时长或所有载体退出路径 |
| action authority 与生产范围 | `action-task-binding-registry.js`、`action-manifest.js`、`production-strategy-snapshot.js` 相对固定 HEAD 未改。生产 composition 仍对私有 authority、manifest、capability、production strategy 交叉校验；非生产独立 descriptor action 不能加入正式 production 装配 | 固定 67 action / 74 pair / 49 runtime / 134 受控 TaskPolicy / 13 production-enabled；扩展负例通过 |
| runtime 映射与跨代 | 每 action policy、entry 路径/取消码/carrier/API 形状、静态引用与资源元数据匹配冻结基线。全部 Main binder 正常注入和透传、BizOP 派发、缺 authority/override 拒绝均有检查；manager drain/resume 后重新读取 provider | 跨代派发观察使用真实 Supervisor 加可控 transport；不是 Windows packaged worker 验收。callable 表面快照不能独自证明所有业务算法等价 |
| Archive 等价 | 全部 268 channels 的字段和 hook 注册匹配冻结 fixture，file 71 / no-file 63 / exclude 134；受控 134 task inventory 与独立 authority 双向闭合，分类/metadata/lineage/可选 hook 固定样例一致 | Archive 35 tests 通过。27 个固定行为场景组展开 6357 次 channel/sample 比较；不等于 6357 个独立测试，也不穷尽业务输入 |
| G2 注册 | 原工厂提取 `createBusinessTaskAdapterRegistrations`，原 registry 工厂继续复用同一来源。G7 汇总后交给原 task adapter/terminal route registry；134 task 必须完整绑定，重复/缺失/多余/exclude 绑定拒绝，四条历史 route 保持 | 实际 G7 composition 测试使用 G2 原 registry，owner 能力为可观察测试对象；未新建 execute/settle/cleanup 引擎 |
| G1 注册 | 原 participants 构造提取成只读接口，固定八项顺序单独保留；G7 按 id 重排后传回原 G1 composition/coordinator。缺失/重复/额外 participant 在 bindPlatform/恢复副作用前拒绝 | 已执行原 coordinator 阶段、重复调用、失败状态及扫描屏障测试。publication owner 未改；`toolbox-vcc-publications` 仍为 participant id |
| manifest 源证据 | 既有生成器改为当前 G7 evidence 输出，增加真实新增装配/领域源 hash，历史发布快照保留。当前命令检查匹配当前源码 | 本次独立运行 `npm run check:background-execution-manifest` PASS：402/402 surfaces、74 legacy pairs、13 production enabled |

## 独立执行的验证

全部命令的工作目录均明确为上述 worktree。

```sh
node --test \
  tests/unit/main-process/execution-descriptor-composition.test.js \
  tests/unit/main-process/execution-descriptor-equivalence.test.js \
  tests/unit/main-process/execution-descriptor-archive-baseline.test.js \
  tests/unit/main-process/execution-descriptor-resource-profiles.test.js \
  tests/unit/main-process/execution-descriptor-contract.test.js \
  tests/unit/main-process/execution-descriptor-extension.test.js
```

结果：**73 tests / 73 pass / 0 fail / 0 skipped / 0 todo，exit 0**。分项为 composition 9、equivalence 5、Archive 35、resource 11、contract 11、extension 2；resource 数量包含 3 个 estimator 子测试。

```sh
npm run check:background-execution-manifest
```

结果：**PASS，exit 0**；输出 `E13-G manifest gate PASS: 402/402 surfaces, 74 legacy pairs, 13 production enabled`。命令名保留 E13-G 历史标识，当前产物 release/workItem 已指向 v3.2.10/G7。

另以文件字节直接对照 HEAD，确认 action-task authority、action manifest、Supervisor、execution-policy registry、production strategy 五个原机制/授权文件没有变化。原静态 fallback 与取消/资源/退出引擎不是本次重写。

## 需要保留的验收与证据边界

本次未发现阻断代码交付的具体缺陷，下列事项仍须在总交付记录中分别列明，不能由本审查自动升级为完成：

1. 完整 `release-check` 及最终差异检查由主任务维护。本审查只复跑上述 73 个定向测试和 manifest，不覆盖其他测试文件的最终状态。
2. 已阅读 `scripts/integration/execution-descriptor-governance.js` 的 thread/inline/service/adapter 四条真实载体场景，本审查未重复执行。该脚本的 adapter 场景使用 G2 原 passthrough/registry/TaskLifecycle API 手动创建最小绑定；实际完整 134-task/四 route 的 descriptor 聚合由 composition 单测覆盖，不能把二者描述成同一条真实 Main 启动端到端路径。G1/G2 原组合集成与 Position 启动测试是否在最终源码上通过，以主任务证据为准。
3. runtime fixture 的 Main binding 分类及 estimatorOwner 是人工基线元数据；新增行为测试补了正常注入和跨代派发，但不存在从 callable 名称、源码或 identity 推导全部算法等价的证据。
4. G8 `ARCH-DESCRIPTOR-COMPOSITION` 配置尚未纳入本 worktree。当前本地传递依赖测试可以证明本次源码边界，不能代替后续 G8 联合集成登记和激活。
5. Windows packaged carrier、Electron GUI、Excel/WPS、安装包和人工用户数据验收未在本审查执行。真实故障恢复/强制终止行为不能由正常载体成功路径或合成 owner 测试替代。
6. G7 当前未提交、未推送、未合并 release。固定 HEAD 是已纳入依赖的基线，不是本次 G7 变更的提交 SHA。

如后续变更触及本审查的 30 个核心源文件、Main 调用或实际验证产物，应按变更范围刷新证据；无需无差异重复全量审查。
