# G7 审查修复复核 — 2026-09-21

**当前结论：R1（P2，独立批准基线缺失）与补修后的 R2（P3，非生产派发兼容性）通过本次专项复核，未发现本次修复范围内的剩余阻断。** P3 首轮修复曾误放行混合 BizOP 场景，并被完整门禁暴露；补修后独立新跑 P3 11 项和旧兼容测试 1 项，全部通过。第 7 节保留发现与纠正过程。首轮 20 项专项与 3 项边界测试为历史证据，其中原混合场景错误期望不能证明兼容。固定 release 旧源码独立导出与新批准数据相等的 P2 证据不受影响；最终完整门禁仍以主任务新跑结果为准。

本报告补充当前修复后的验收状态，不改写[原独立审查](final-review.md)或[用户分支审查](review-2026-09-21.md)。原 `final-review.md` 的“未发现 P1/P2”没有覆盖用户随后提供的 canonical action 漂移反例，不能作为修复前 R1 已通过的依据。

## 1. 范围与状态

- worktree：`/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/v3210-execution-descriptors`；本次每条命令都显式使用该工作目录。
- 分支：`codex/v3.2.10-execution-descriptors`；HEAD：`8b12a6d5fd71b70ade58b9b6e7a347e29dbe8d05`。G1/G2 已在该固定依赖基线集成；G7 及两项修复仍是工作区变更，不将 HEAD 表述为 G7 提交。
- 依据：[Spec §2、§3](spec.md)、[TechDoc §独立校验与实施接口补充](techdoc.md)及用户审查 R1/R2。此次只复核批准基线闭合、派发 hook 兼容和相关机制边界，未重做全项目审查。
- 本次仅新增本报告，未修改源码、测试、实施记录或原审查；历史源码导出使用自建临时目录，结束后已清理。未提交、推送、合并或发布。

| 问题 | 当前实现结论 | 本次验证 | 集成与交付状态 |
| --- | --- | --- | --- |
| R1 / P2 | compiled policies 和纯 catalog 分别与固定批准 capability/production 投影比较；不再互为期望。manifest `--write` 同样在写产物前验证 | 原三反例及反向关闭、legacy-disabled、等数替换、catalog 单独/同步漂移、零写入负例通过；独立历史导出相等 | 工作区实现与专项验收完成；G7 尚未合入 release |
| R2 / P3 | 纯无 hook 路径保持 null；注入 BizOP 时其他 action 缺 hook 显式拒绝，保留旧混合门禁 | 首轮新增混合期望错误已纠正；修订 P3 11/11 与旧772单项 1/1 独立通过 | 补修实现与专项验收完成；最终完整门禁由主任务刷新，平台未验收 |

## 2. R1：独立基线来源与拒绝路径

[approved-execution-baseline.js](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/v3210-execution-descriptors/src/main-process/background-execution/approved-execution-baseline.js:13) 在模块初始化时把固定 JSON 深拷贝并递归冻结；仅导出校验函数，无调用方替换批准对象的参数。候选 policies 仍生成其实际 manifest/capability/strategy，然后由原 validator 与固定批准数据做严格相等比较。

[composition.js](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/v3210-execution-descriptors/src/main-process/execution-descriptors/composition.js:115) 先保留原 TaskPolicy inventory、私有 action/task registry 和 coverage 检查，再分别核验 compiled 与 catalog。正式创建 runtime 必须经过该路径；错误注册在 runtime/Governor/载体创建之前失败。descriptor 与 catalog 同时修改也不能彼此充当批准来源。私有 action/task literal 没有变为 descriptor 的自报数据。

[manifest 生成器](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/v3210-execution-descriptors/scripts/check-background-execution-manifest.js:95) 的 `buildArtifacts()` 必须先通过固定批准检查；`main()` 随后才进入 `--write` 的四项证据输出。批准 JSON 不在 OUTPUT_PATHS 中，批准 JSON 与 validator 在 SOURCE_PATHS 中。负例实际观察 `mkdirSync`/`writeFileSync` 调用均为零，既有产物 hash 不变，因此 `--write` 不能把错误 catalog 刷成新的批准期望。

独立来源核查没有使用当前 catalog、descriptor 或生成器来计算期望：

1. 用 `git archive 8b12a6d5fd71b70ade58b9b6e7a347e29dbe8d05 src` 导出不可变旧源码到本次专属临时目录，只共享当前依赖目录。
2. 从该临时目录 require **旧 runtime** 的 `BACKGROUND_EXECUTION_POLICIES` 和旧 action-task binding、action manifest、capability inventory、production strategy 模块，重新生成两个投影。
3. 用 `assert.deepEqual` 对照当前批准 JSON 的两项数据；旧 runtime 的 49 条原始 policy 按 actionKey 排序后，与冻结 `11086a3c` fixture 的 `actions[].policy` 做完整 JSON 深比较。
4. 逐字节复算五个历史源文件、冻结 fixture、新批准 JSON 的 SHA-256，与[来源记录](evidence/review-fix-20260921/approved-baseline-provenance.json)比较。

结果均通过：

```json
{
  "sourceCommit": "8b12a6d5fd71b70ade58b9b6e7a347e29dbe8d05",
  "historicalProjectionEqualsApproved": true,
  "oldRawRuntime49EqualsFrozenFixture": true,
  "sourceHashesMatchProvenance": true,
  "approvedBaselineSha256": "2dfaf3fcc4014fa8b71a225a0eed1787a9c2d814e41d2d586003233ca9a2241b",
  "runtimePolicies": 49,
  "capabilityCounts": {
    "actionCount": 67,
    "implementedCount": 49,
    "legacyOnlyCount": 16,
    "platformCanaryCount": 2
  },
  "productionCounts": {
    "actionCount": 67,
    "productionEnabledCount": 13,
    "legacyEffectiveCount": 54
  },
  "currentCatalogRequired": false,
  "currentDescriptorRequired": false
}
```

这使 G7-AC-02/04 中此次暴露的注册范围与有效生产策略独立检查得到补齐。批准投影有明确边界：它不保存所有 `resources.phase`、entry 路径、函数行为或 Archive hook 行为，不能替代原完整 policy/registry fixture、业务行为和载体测试。未来合法能力调整仍需单独批准并记录来源 SHA 与语义差量；本次未提供自动刷新批准基线的入口。

## 3. R2：派发兼容与授权保持

[contract.js](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/v3210-execution-descriptors/src/main-process/execution-descriptors/contract.js:300) 新增 `getBeforeCarrierDispatchForAction(actionKey)`，从已校验的当前 action Main binding 返回真实 hook 或 null；原严格聚合 `beforeCarrierDispatch()` 保留，不以 no-op 冒充能力。

[runtime.js](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/v3210-execution-descriptors/src/main-process/background-execution/runtime.js:70) 把 getter 传给公共 Supervisor。[Supervisor](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/v3210-execution-descriptors/src/main-process/background-execution/supervisor.js:318) 每次执行固定当前 action 的 hook，并按原语义区分：

- 非生产关闭观察、没有通用 hook 且未注入 BizOP Main bindings：允许进入原 adapter 路径，恢复 R2 中 `toolbox:merge` 的历史行为。
- 已注入 BizOP Main bindings、其他 closure action 缺自身 hook：composition 把原 null binding 显式装配为拒绝函数，非生产也返回 `CARRIER_DISPATCH_BINDING_REQUIRED`，保留旧混合门禁；详见第 7 节。
- production=true、实际已启用 action、没有 hook：仍抛 `CARRIER_DISPATCH_BINDING_REQUIRED`，测试以已启用 `toolbox:split-rows` 排除先被 production-disabled 遮挡的假通过。
- 配置真实 hook：先 await hook，再进入 admitting/adapter；真实 hook 拒绝不会被非生产分支吞掉。
- 其他 action 的 hook 不能给当前 action 代授权；BizOP 原本域 hook 优先，通用 hook 不替代它。未使用 getter 的 Supervisor 调用方仍保留原单回调接口。

此次修改只把真实能力选择从聚合包装函数改为 per-action getter，没有向公共 runtime/Supervisor 加入领域分支。公共机制的传递依赖探针和反例继续通过；catalog 的隔离读取仍不加载 descriptor 工厂、数据库或 worker 引擎。

## 4. 首轮独立验证及其后发现的适用限制

以下命令均在第 1 节 worktree 执行，均 exit 0。

```sh
node --test \
  tests/unit/main-process/execution-descriptor-production-baseline.test.js \
  tests/unit/main-process/execution-descriptor-dispatch-compatibility.test.js
```

首轮结果：**20 tests / 20 pass / 0 fail / 0 skipped**。P2 为 10 项；P3 为 10 项，包含 4 个子测试。该次 P3 混合非生产场景的期望错误，故测试通过不构成完整兼容证据；补修后复跑结果见第 7 节。P3 的可控 adapter 仅观察派发边界，没有创建真实 worker 或执行业务 IO；不能把其 `PROBE_REACHED_ADAPTER` 视为 worker 业务成功。

```sh
node --test --test-name-pattern='五个公共机制|Acorn 边界|纯查询' \
  tests/unit/main-process/execution-descriptor-composition.test.js
node --test --test-name-pattern='隔离进程只读取 policy-catalog' \
  tests/unit/main-process/execution-descriptor-composition.test.js
```

第一条实际匹配传递依赖与 Acorn 正反例两项，**2/2 PASS**；第二条纯 catalog 读取 **1/1 PASS**。三项互不重叠。本次没有重跑完整 composition suite 或完整 `release-check`；主任务正在刷新最终门禁，应以匹配最终源码的[实施记录](implementation-notes.md#review-fixes)为准。

R1 负向覆盖的具体边界如下：

| 输入漂移 | 当前拒绝结果 |
| --- | --- |
| 删除 `toolbox:merge` policy 与 Main binding | `CAPABILITY_INVENTORY_SNAPSHOT_MISMATCH` |
| 启用原禁用的 `toolbox:merge` | `PRODUCTION_STRATEGY_SNAPSHOT_MISMATCH` |
| 把 legacy-only `toolbox:split-large` 加入 runtime 并启用 | `CAPABILITY_INVENTORY_SNAPSHOT_MISMATCH` |
| 把 legacy-only action 加入 runtime，保持 disabled | `CAPABILITY_INVENTORY_SNAPSHOT_MISMATCH` |
| 删除原 runtime action、用 legacy-only action 等数替换 | `CAPABILITY_INVENTORY_SNAPSHOT_MISMATCH` |
| 关闭原批准启用的 `toolbox:split-rows` | `PRODUCTION_STRATEGY_SNAPSHOT_MISMATCH` |
| 只改 catalog；descriptor 和 catalog 同步启用 merge | 两个独立负例均 `PRODUCTION_STRATEGY_SNAPSHOT_MISMATCH` |
| 错误 catalog 执行 manifest `--write` | strategy mismatch；零 mkdir/write，产物 hash 不变 |

## 5. 证据适用范围与剩余事项

R1 与补修后的 R2 可以关闭对应代码修复项，依据分别是独立批准基线和第 7 节新的兼容验证。不能把首轮专项通过或旧正向测试通过改写成未存在兼容缺陷。

1. 最终完整门禁、整批差异检查和真实载体/G1/G2 集成结果由主任务在修复后刷新；本报告不引用修复前完整门禁作为修复后已通过的证据。
2. Windows packaged carrier、Electron GUI、Excel/WPS、安装包及真实用户数据/故障恢复验收，本次未执行。
3. G8 `ARCH-DESCRIPTOR-COMPOSITION` 联合集成与规则激活，本次未执行。此处 3 项源码边界测试不等于 G8 已 active。
4. 修复不改静态资源 fallback、Archive 268-channel 注册或原 G1/G2 调度语义；本次不重复声称这些整体场景已重新全量验收，原独立 fixture 与最终专项/集成记录继续承担相应证据。
5. G7 的实现、验证与 release 集成状态应分别保留。当前两项修复在工作区实现并通过上述专项；提交与集成仍待用户后续明确指令。

## 6. 首轮修复审查源码锚点

以下 SHA-256 保留首轮独立测试与阅读对应的文件字节，包含随后被发现不充分的 P3 首版。第 7 节记录补修变更文件的新 hash；其余文件本次补修未改。后续若这些文件变化，按差异范围刷新证据。

| 文件 | SHA-256 |
| --- | --- |
| `background-execution/approved-execution-baseline.js` | `603e6d4cf87dfd6218a61e55fba7f2960b06b6563aee8171d74f5dfaf64ae9a5` |
| `background-execution/approved-execution-baseline.json` | `2dfaf3fcc4014fa8b71a225a0eed1787a9c2d814e41d2d586003233ca9a2241b` |
| `execution-descriptors/composition.js` | `2a6cc12e6c154c401284423b2bd55ee9d916f564d42776ef673e20b57dee78f7` |
| `execution-descriptors/contract.js` | `5d05799bd4de91b2a7ed6c0674a72d4711bb9c1c77bf720787ee540e24c0751c` |
| `background-execution/runtime.js` | `62a110aa4ddd561d18675bceea648ec4b925a957a3a2a1524f78b174532cc6d0` |
| `background-execution/supervisor.js` | `6d634a7146fcddadc59ac5d1d148aed235be758c85985a63517bf6b42d14f012` |
| `scripts/check-background-execution-manifest.js` | `c2d162201db521d6d3ddd9f55852fb948134a1f185b9fa4a59c0a38fda92d9ec` |
| `tests/unit/main-process/execution-descriptor-production-baseline.test.js` | `6c082e4ff02f86077bfbdaecf03a52f220111a577e45f87d7a0537ad2b966fea` |
| `tests/unit/main-process/execution-descriptor-dispatch-compatibility.test.js` | `9a4f8a94ce377ca6c19e9b6a68fe2e2d4d6c7cddd4d95e5187cfc6d83c69490a` |

前六个相对模块文件均位于 `src/main-process/`。

## 7. 完整门禁发现的 P3 补充兼容边界与补修复核

完整门禁执行原 `biz-op-v327.test.js:772` 发现：旧 `8b12a6d5` runtime:558–568 在注入 `bizOpV327` bindings 时，即使没有通用 dispatch hook，也会创建严格聚合 wrapper；对其他 closure action 缺本模块 hook 的情况，非生产同样返回 `CARRIER_DISPATCH_BINDING_REQUIRED`、`NOT_CREATED`、零活动 lease。首轮修复与新增混合场景测试误将此分支视为纯无 hook 场景并允许到达 adapter。本次独立初审也遗漏该条件，应撤回首轮 P3 已关闭的结论。

补修在 [composition.js](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/v3210-execution-descriptors/src/main-process/execution-descriptors/composition.js:149) 选择 `fallbackDispatch`：仅当 `options.bizOpV327` 存在且 `options.beforeCarrierDispatch == null` 时，给其他原 null binding 装配必抛 `CARRIER_DISPATCH_BINDING_REQUIRED` 的函数；原本域 hook 优先，完全无 BizOP/无 hook 时仍为 null。该函数明确拒绝，不制造成功 no-op；公共 runtime/Supervisor 无需辨识 BizOP。混合场景提供通用 hook 时仍先调用该 hook，再进入 adapter。

已检查旧 `biz-op-v327.test.js` 的差异：只有本轮 G7 既有的 runtime require 入口迁移，772 对应测试的原拒绝断言、`NOT_CREATED` 与零 lease 断言均未修改。独立新跑如下：

```sh
node --test tests/unit/main-process/execution-descriptor-dispatch-compatibility.test.js
node --test --test-name-pattern='新模块绑定不能替另一个模块满足关闭观察的 Main 持久绑定' \
  tests/unit/main-process/biz-op-v327.test.js
```

结果：修订 P3 专项 **11/11 PASS**（包含 5 个子测试），旧兼容单项 **1/1 PASS**，均 exit 0、零 fail/skipped。此次新的 12 项与第 4 节历史测试有重叠，不相加宣称 35 项不重复验证。覆盖纯无 BizOP/无 hook 的原 R2 可达 adapter、混合缺 hook 非生产拒绝、混合已配置 hook 的顺序、production 缺 hook 拒绝、真实 hook 错误传播与 BizOP 本域授权。P2 数据与校验逻辑未改，没有无变化重复其历史导出探针。

因此这次补修恢复了旧混合兼容范围，R2 可按上述专项证据关闭；完整 `release-check` 的首轮失败仍须保留，并由主任务在最终源码重新运行。此处不以 12 项通过提前宣称完整门禁通过。

| 补修后文件 | SHA-256 |
| --- | --- |
| `src/main-process/execution-descriptors/composition.js` | `cc26d261b8d24ec506e1716158a421abe1c1b47e99f8391a82b40c53c856d543` |
| `tests/unit/main-process/execution-descriptor-dispatch-compatibility.test.js` | `73de4eb45d00e8fdee97187ceb89fd62dd8a9af322397130c681cfa8c5b9cc5f` |
| `tests/unit/main-process/biz-op-v327.test.js`（既有断言未改） | `9c50209d10be5cb3baca42fdc88039dddb201c1cc0298672d341e68c56e71e45` |
