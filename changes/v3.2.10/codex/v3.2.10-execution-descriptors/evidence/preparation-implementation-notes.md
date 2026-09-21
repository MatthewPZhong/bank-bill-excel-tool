# G7 执行与归档描述符实施记录

本文件是本功能的切片索引。设计合同见 [Spec](spec.md)、[TechDoc](techdoc.md)；完成标准见 [总索引 §6.2–§6.4](../../README.md#slice-completion)。原设计文件保持输入原貌，元数据中的“计划分支、未创建”等描述是设计时状态；当前事实以本记录及证据为准。

## 当前范围与固定基线

- 分支：`codex/v3.2.10-execution-descriptors`。
- worktree：`/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/v3210-execution-descriptors`。
- 初始及当前 HEAD：`11086a3cbf632a30adbcfa796e4cd81810c5aef9`（本地 main / v3.2.9）；本次差异未提交。
- 2026-09-21 复核 release：`320d20df68bdeb175060ed37513a2fe5f23436bc`。G1 功能提交 `856c9dce8ae4c381229e37b5b236e2e2f776921d` 已经由 `5ccbf3f022488026f725a5111be00422a04ce221` 集成。
- **G2 尚无 release 集成提交**：G2 分支 HEAD 仍是上述 G1 集成点，其实现处于另一个 worktree 的 dirty 状态。G2 自身记录写明生产迁移完成、未提交/未集成；本任务仅引用其状态，不将它的历史测试算作 G7 验证。
- 依据用户允许的依赖前工作范围，本轮仅完成 `G7-T1a`（父切片 G7-T1）的 registry 清点、映射核对和测试准备；纯 descriptor contract/聚合器及正式装配尚未开始。没有复制 G2 dirty 源码、没有更改生产 registry，也未移动 G7 HEAD。
- 依赖与未提交状态证据：[dependency-verification.json](evidence/dependency-verification.json)。原样带入的设计及必要引用：[design-inputs.json](evidence/design-inputs.json)。

## 切片状态

| 切片 / 本次范围 | 实现状态 | 验证状态 | 集成状态 |
| --- | --- | --- | --- |
| G7-T1a / G7-T1：基线 inventory、映射、资源与 Archive 行为 fixture、测试准备 | 已实现（仅准备范围） | 新增 43/43、既有 69/69 通过；manifest 基线命令失败另列 | 未集成 |
| G7-T1 剩余：纯 contract 与聚合校验 | 未开始 | 未执行 | 未集成；等待 G1/G2 固定依赖 |
| G7-T2：Toolbox/NewAccount 装配 | 未开始 | 未执行 | 未集成 |
| G7-T3：其余 runtime bindings 装配 | 未开始 | 未执行 | 未集成 |
| G7-T4：Archive/G1/G2 registrations | 未开始 | 未执行 | 未集成 |
| G7-T5：shim、manifest、最终策略与边界收口 | 未开始 | 未执行 | 未集成 |

## G7-T1a：职责、兼容与行为边界

1. **职责与边界**：本次只增加测试 helper、冻结 JSON fixture 和测试。生产职责仍由 `background-execution/runtime.js` 完成业务选择，`execution-policy-registry.js` 完成引用冻结，`archive-center/task-policy-registry.js` 完成领域 policy 选择。独立 `action-task-binding-registry.js` 私有 literal 仍是授权事实源。没有生产职责迁移，也没有 descriptor 工厂接入 Main。
2. **调用方与兼容**：本轮无生产调用方迁移、无新 shim、无删除旧入口。保留 runtime 的 `BACKGROUND_EXECUTION_POLICIES` 导出；后续迁移清单和静态 bucket 映射见 [registry-inventory.md](registry-inventory.md)，机器清单保存 74 个已跟踪文件的 329 条符号命中（含定义/字符串，不能当真实调用数）。测试 helper 只允许测试读取，不作为生产 policy catalog。
3. **业务行为**：为 G7-AC-02/04/08 准备逐项基线，保留 67 canonical action、74 action/task pair、49 runtime policy、134 mutation TaskPolicy、13 production-enabled；legacy-only/canary 不通过 descriptor 自动开启。静态资源继续来自 `policy.resources.phase`，仅 NewAccount generation 有动态 estimator。fixture 比较和负例测试不代表 descriptor 完成，也不代表取消、真实 worker exit、恢复、跨代装配已验收。
4. **验证证据**：见下节。所有必要测试均针对 worktree HEAD + 本次新增测试，不采用 G1/G2 或设计审查的 PASS 代替。集成、GUI、Windows packaged、Excel/WPS 和 release-check 未执行：当前未修改生产路径，且完整迁移受 G2 release 依赖约束。
5. **当前规则入口**：继续使用根 `AGENTS.md`、`CODEX.md` 及 [TechDoc §2.1/2.2](techdoc.md#21-原-registry-的精确-bucket-与转换)。测试期望的现行说明为 [fixtures README](../../../../tests/fixtures/execution-descriptors/README.md)，入口由本记录及基线测试引用。本轮没有生产职责变化，因此不新增拟实现的 `src/main-process/execution-descriptors/README.md`，也不把拟新增模块加入根规则导航。G8 在此基线未接入，`ARCH-DESCRIPTOR-COMPOSITION` 未激活、无例外变化；正式迁移后 G7-T5/G8 联合集成负责登记。

## 验证记录与已知基线问题

- macOS / Node `v25.8.0`；本 worktree 的 gitignored `node_modules` 链接到主仓已安装依赖，未安装新依赖。
- 四个既有 registry/authority/coverage/Archive 测试文件：首次 68/69，唯一失败是历史 checkout 子进程缺 `xlsx`（NODE_PATH 指向新 worktree 不存在的 node_modules）。补齐本地依赖链接后 **69/69 PASS，exit 0**，未改任何测试：[重跑记录](evidence/existing-registry-tests-retry.json)、[日志](evidence/existing-registry-tests-retry.log)。首次失败保留在 [原始日志](evidence/existing-registry-tests.log)。
- 新增测试联合执行：`node --test tests/unit/main-process/execution-descriptor-resource-profiles.test.js tests/unit/main-process/execution-descriptor-archive-baseline.test.js`，**43/43 PASS，0 fail / skip / TODO**（runtime 11，Archive 32）；最终源摘要与平台见 [preparation-tests.json](evidence/preparation-tests.json)，输出见 [preparation-tests.tap](evidence/preparation-tests.tap)。
- runtime fixture 保存 49 policies 的完整字段与绑定，重新注册五个原 registry 并执行原 freeze；静态 action 的 profile binding 为 undefined，唯一动态 estimator 为 NewAccount generation。真实 Supervisor 探针验证静态 phase、动态 memory、Promise 与两种 carrier slot 漂移拒绝、5000ms 参数，均在载体创建前停止。真实 runtime 另执行 19 次缺 authority 和 10 次覆盖字段拒绝；正常注入、passthrough、BizOP beforeDispatch、跨 generation、真实 validator/topology 行为仍待后续。
- Archive fixture 保存 268 个 channel（71 file / 63 no-file / 134 exclude）及 67/74/134 独立 authority。27 个固定场景组包含 **6,357 次 channel/sample 行为比较**，不是 6,357 项独立单测。覆盖已登记 classifier、metadata、lineage、flow、filePlan、promotion hooks；不涵盖真实文件/DB proof、terminal route 和端到端恢复。
- 四个新增 CommonJS 文件语法与显式 `no-undef` 检查通过（0 error / warning），未跟踪新增文件单独做 whitespace 检查；见 [preparation-static-checks.json](evidence/preparation-static-checks.json)。仓库原 `npm run lint` 仅匹配 `src`，未把它当新增测试已检查的依据。
- `npm run check:background-execution-manifest`：**FAIL，exit 1**，原始 main 基线就存在的 `E13-G Action Manifest drift`。历史快照为 54 action / 61 pair / 36 runtime / 0 enabled，当前模型为 67 / 74 / 49 / 13；差量为 BizOP v327 十二项及 Toolbox rows。当前生成模型的独立 coverage 是 402/402，capability/strategy 自洽；这不能把原命令失败改写为通过。[原始失败](evidence/manifest-baseline.log)、[诊断](evidence/manifest-baseline-diagnosis.json)。本切片不改历史快照或 authority，G7-T5 在固定依赖基础执行合法生成/校验并保留历史来源。

- [独立准备复核](preparation-review.md)未发现阻断项，独立复跑 43/43。Main binder 分组和 estimatorOwner 为人工清点元数据，不是从 closure 自动证明来源；不扩大本次行为结论。

## 差异与准备切片结论

G7-T1a 的五项准备要求已落实；本轮不宣称 G7-T1 整体或任何完整 G7 AC 完成。正式 descriptor contract/转换器、production composition、G1/G2 接入、兼容转发移除和 G8 激活均未实施。

本次生产 `src`、现有 scripts、authority、manifest snapshot 与既有测试没有修改。新增两个 helper、两个 fixture、两个单测文件及使用说明；代码差异见 [test-code.diff](evidence/test-code.diff)，最终文件摘要见 [delivery-snapshot.json](evidence/delivery-snapshot.json)。设计副本与原输入逐字节一致，不把输入带入计作功能实现。

## 剩余项与回退

- BLOCK（集成依赖）：由 G2/release 任务提交并集成 G2，提供固定 release SHA。G7 后续需先核验接口及其祖先链，纳入固定提交并记录 SHA，再对依赖产生的已批准差量更新基线。不能以 G2 dirty 文件、分支名称或 G1 SHA 替代 G2 集成证据。
- G7-T1 剩余和 T2–T5 仍按原 Spec/TechDoc 实施；没有改变验收范围、生命周期契约或 authority。
- 本准备切片回退只移除本次测试、fixture 和记录；无需改 DB/journal/receipt/outbox 或用户文件。生产切片仍按 TechDoc §6 整体回退装配及合法 source-hash 证据。
- 未执行提交、推送、合并、PR、升版、发布。
