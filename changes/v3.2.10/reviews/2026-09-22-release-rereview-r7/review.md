# release/v3.2.10 第七轮增量审查

**结论：第六轮两项发现的原始反例已关闭；本轮确认 1 项新增 P2：Renderer 默认参数实际生效时丢失默认对象来源，越权方法写入被零诊断放行。** 356 项架构测试和正式 CLI 均通过，但没有覆盖这个新反例。G1 和共享解析的本轮有限对照未确认新增问题。

依据：[第六轮审查](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-22-release-rereview-r6/review.md)、[第六轮修复](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-22-release-r6-repair/repair.md)、[G8 Spec](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/codex/v3.2.10-architecture-guardrails/spec.md)、[TechDoc](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/codex/v3.2.10-architecture-guardrails/techdoc.md)。沿用 blindspot-pass 的证据型审查方式。本轮仅新增审查文档和证据，未修复源码、检查器、测试或配置。

## 1. 固定对象与范围

| 项目 | 当前事实 |
| --- | --- |
| worktree | `/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10` |
| 分支 / HEAD | `release/v3.2.10 / 9a38b96b1b8006c5851535d0c1e586bbaeb63f10` |
| 实际候选 | HEAD 加已有全部未提交修复，包含 R6 修复 |
| 上一正式版事实基线 | `v3.2.9 / 11086a3cbf632a30adbcfa796e4cd81810c5aef9` |
| 冻结时间 | 2026-09-22 15:41:57，Asia/Shanghai |
| 文件冻结 | 4,391 个已有文件 SHA-256；[清单](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-22-release-rereview-r7/evidence/input-manifest.json)、[tracked 差异](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-22-release-rereview-r7/evidence/input-diff.patch) |
| 相对 R6 审查 | 8 个已有文件变化，新增 `tests/unit/architecture/release-rereview-r6.test.js`；[逐文件比较](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-22-release-rereview-r7/evidence/prior-review-comparison.json) |
| 生产与机器合同 | 792 个 src 文件、boundaries、legacy-allowlist、schema、policy-history 和 scan.js 均与 R6 修复起点相同；[核对](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-22-release-rereview-r7/evidence/policy-production-comparison.json) |
| 最近完整门禁 | HEAD 与 1,703 个门禁输入均匹配当前；[核对](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-22-release-rereview-r7/evidence/gate-evidence-comparison.json) |

本轮集中复核 R6 的两个检查器修复、原始反例、默认参数及有限相邻身份组合，并核对共享解析对 Renderer/G5 的影响。没有重新审查全部未变化业务模块，也没有把任意反射、循环、多次动态调用或跨文件共享对象时序纳入证明范围。

## 2. 第六轮问题复核

| 原问题 | 本轮结果 |
| --- | --- |
| RR6-01 参数解构未按调用时点读取成员 | 原样复跑实际全部 20 个 Renderer boundary 探针：基线 0；越权例 1 条 ARCH-RENDERER-SCOPE；旧别名分离安全例 0。原问题关闭。 |
| RR6-02 参数投影后方法已改写仍按原生比较放行 | 原 8 类与相邻 6 类探针，共 9 个实际执行路径被拒绝、5 个安全路径通过。实际源码投影改写产生 1 条恢复入口诊断；原生 includes 0、真实 reduce 1。原问题关闭。 |

正式定向回归为 Renderer **21/21**、G1 **19/19**，均包含在本轮 **356/356** 架构测试内，不相加。[Renderer 原样结果](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-22-release-rereview-r7/evidence/r7-renderer-original-realconfig.json)、[G1 原 8 类前后对照](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-22-release-rereview-r7/evidence/r7-g1-before-current.json)、[G1 相邻 6 类前后对照](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-22-release-rereview-r7/evidence/r7-g1-adjacent-before-current.json)。

G1 的三份实际源码扫描均解析 765/765 文件、parseErrors=0，只对实际 active G1 边界求值，不是全 31 边界突变扫描。投影改写恢复了 callback target，原生 includes 的 callbackTargets 为空；真实 reduce 继续拒绝。只运行内存 stub 和静态扫描，没有执行生产恢复 IO。[投影改写](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-22-release-rereview-r7/evidence/r7-g1-projection-real-source-probe.json)、[原生比较](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-22-release-rereview-r7/evidence/r7-g1-native-data-real-source-probe.json)、[真实回调](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-22-release-rereview-r7/evidence/r7-g1-preparing-real-source-probe.json)。

## 3. 新增发现

### RR7-01 [P2] 缺省参数被当作已提供实参，默认来源丢失后静默放行越权 API

**位置：** [renderer-contracts.js:174](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/scripts/architecture/renderer-contracts.js:174)，174–178 行，核心为第 178 行的默认参数快捷返回；关联第 155 行 AssignmentPattern 绑定。

```js
const shared = { run() {} };
function select({ api = shared }) { return api; }
const alias = select({});
alias.outsideScope = window.desktopApi.outsideScope;
window.BankStatementController.createBankStatementController({
  api: shared
});
```

**触发与影响：** `select({})` 缺少 api 成员，JavaScript 应使用默认对象 shared。运行时 alias 与 shared 是同一对象，后续写入会把可调用的 outsideScope 一并注入已迁移控制器。当前检查器返回零 scope/coverage 诊断，无法阻止违反 scoped API 的代码通过架构门禁。这里确认的是检查器的漏报，没有发现当前生产源码已含该注入。

**根因：** `bindPattern` 遇到 AssignmentPattern 只绑定左侧，没有求值默认表达式。缺失成员、undefined 或 missing-factory-argument 占位值仍会进入参数环境。R6 新增分支仅根据 `env.has(name)`、`binding.defaultInit` 和未重赋值就返回该环境值，把“环境中有绑定”当作“实参已提供且不应触发默认值”。结果丢失 shared 的身份，alias 写入无法传播至实际注入对象。

| 同脚本小夹具 | R6 修复前 | 当前 | VM 事实 |
| --- | --- | --- | --- |
| 缺成员：select({}) | 1 条 ARCH-RENDERER-SCOPE | **0，漏报** | alias === shared，含可调用 outsideScope |
| 显式 undefined：select({ api: undefined }) | 1 条 ARCH-RENDERER-SCOPE | **0，漏报** | alias === shared，含可调用 outsideScope |
| 普通默认参数：select(api = shared)，select() | 1 条 ARCH-RENDERER-SCOPE | **0，漏报** | alias === shared，含可调用 outsideScope |
| 明确提供不同对象：select({ api: provided }) | 1 条 scope 误报 | 0，正确 | 不同对象，注入 shared 只有 run |

[修复前 8 个相邻例](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-22-release-rereview-r7/evidence/r7-renderer-neighbors-before.jsonl)、[当前 8 个相邻例](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-22-release-rereview-r7/evidence/r7-renderer-neighbors-current.jsonl)。before 使用 R6 修复起点的两份工具副本及三份未变工具，5/5 SHA-256 与 R6 manifest 一致；current 5/5 与 R7 冻结清单一致，排除了错误版本对照。[before 校验](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-22-release-rereview-r7/evidence/r7-renderer-before-inputs.json)、[current 校验](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-22-release-rereview-r7/evidence/r7-renderer-current-inputs.json)。

**实际配置验证：** 保留当前全部 **20 个 Renderer boundary**，向真实 src/renderer.js 的 AST 追加缺成员反例和提供不同对象的安全对照。两例原始基线均 0、追加后也均 0；VM 证明反例为同一引用、API 键为 run/outsideScope、额外方法返回 true，安全例为不同引用且只有 run。[可复现脚本](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-22-release-rereview-r7/evidence/r7-renderer-default-realconfig.cjs)、[结果](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-22-release-rereview-r7/evidence/r7-renderer-default-realconfig.json)。该 VM 使用内存 stub，没有执行业务 IO。

**合同依据：** [Spec G8-AC-05](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/codex/v3.2.10-architecture-guardrails/spec.md:101) 要求已迁移域拒绝越权 API 注入；[TechDoc 第六轮修复约定](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/codex/v3.2.10-architecture-guardrails/techdoc.md:114)要求参数绑定保留对象身份、使用处核验能力。[架构能力说明](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/architecture/README.md:109)对已提供参数默认值的支持，不意味着可把实际触发的默认对象来源静默抹去。

**建议验收：** 参数绑定应按缺失/undefined 语义选择默认表达式，保留其对象身份；无法证明时保留候选或给出 coverage 拒绝。补齐上述三种触发默认值的反例，同时保留显式提供不同对象的安全例，以及 R6 的旧别名、独立实例和参数读取时点用例。现有 `default with provided member` 回归始终提供 api，只覆盖默认值不触发的路径，因此不能覆盖本项。

## 4. 有限相邻检查与剩余边界

共享解析共 **38 个小夹具 × before/current 两版本**：20 个 Renderer、18 个查询场景，35 个结果保持，3 个 helper 返回数据/未进入调用路径的误报被修正。10 个查询反例实际执行内存 SELECT 并被拒绝，8 个安全查询场景没有执行 SQL。扫描 JSON、重复扫描、规则求值前后和 site evidenceId 均保持一致，机器策略未变化。[共享解析汇总](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-22-release-rereview-r7/evidence/r7-data-verification.json)及[本轮归档证据断言](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-22-release-rereview-r7/evidence/probe-verification.json)。

Renderer 绑定旧成员的安全例通过；绑定容器后、调用前替换成员的越权例由原先漏报变为正确拒绝。另一个静态数组元素替换小夹具在 before/current **均漏报**；本轮保留了该观察，未扩展到完整实际配置验证，不计入新增回归数量，也没有把它标记为已关闭或已通过。证据位于两个 neighbors JSONL 的 `array-replaced-element`；这限制了对任意静态数组写入的泛化结论。

scan.js 本轮未变化；仅重新核验本轮小夹具的扫描输出与 evidenceId，不声称重跑了过去的私有旁表隔离专项。G1 对任意原生 API、反射和动态循环的处理不在本轮关闭范围内。

## 5. 验证与门禁证据

| 验证 | 本轮动作 / 结果 |
| --- | --- |
| 全架构单测 | 实际执行 `node --test --test-concurrency=1 tests/unit/architecture/*.test.js`：356/356 PASS，0 fail/skip |
| RR6 定向测试 | 实际执行 Renderer 21/21、G1 19/19 PASS；包含于上述 356 项 |
| 正式架构 CLI | 实际执行 `node scripts/check-architecture.js --json ...`：31 active，0 pending/partial，0 violations/stale；765/765 parsed，0 parseErrors，2 个既有 generated unresolved，33 dynamicSites |
| 反例与对照 | 实际执行上述 Renderer、G1、共享解析探针；确认 RR7-01 漏报，不能把探针 exit 0 当作产品通过 |
| 证据一致性 | 实际执行归档 verify-probes.py，断言通过；其 PASS 仅表示预期观察被证据支持 |
| 完整 release-check | **本轮未重跑。** 逐一核对最新 R6 修复门禁的 HEAD 与 1,703 个输入均未变化后复用 |

最新完整门禁运行于 **2026-09-22 15:19:39–15:38:20（Asia/Shanghai）**，命令 `UNIT_TEST_CONCURRENCY=2 npm run release-check`，exit 0。单测 **9,134 total / 9,130 PASS / 0 fail / 4 Windows 条件 skip**；集成 **68/68 脚本通过**，可计数结果 **2,901/2,901**，其中 `v2.1.12-beta-multiworker-nested` 无单项计数；Renderer lifecycle 233/233。这些数字来自[R6 修复 verification](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-22-release-r6-repair/verification.json)，不冒充本轮重新执行，也不与架构或定向测试数字相加。

本轮没有 Windows 安装包、真实 PowerShell、GUI、Excel/WPS、真实数据恢复或正式发布验收。自动门禁通过不能消除本次确认的检查器缺陷，也不能推导 release 整体验收完成。

## 6. 保全与交付

结束时逐字节核验 4,391 个冻结文件，HEAD、Git status 和 tracked 差异均保持；本轮目录外没有新增文件。详见[最终保全核验](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-22-release-rereview-r7/evidence/preservation-final.json)。未提交、推送、合并、开 PR 或升版。

[机器摘要](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-22-release-rereview-r7/verification.json)、[复现说明](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-22-release-rereview-r7/evidence/README.md)、[证据一致性验证脚本](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-22-release-rereview-r7/evidence/verify-probes.py)、[归档 SHA-256](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-22-release-rereview-r7/evidence/artifact-sha256.json)。
