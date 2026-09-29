# release/v3.2.10 第 15 轮审查

本轮未发现新增可确认的必改问题。RR14-01 在原始复现及本轮有限相邻路径中关闭；另记录 **1 项新增保守精度观察 R15-O1**，不将其计为正确通过或必改缺陷。结论只覆盖下述冻结候选与验证范围，不构成整个版本、GUI 或平台验收通过。

## 审查对象与增量

- 工作目录：`/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10`；分支 `release/v3.2.10`；HEAD `9a38b96b1b8006c5851535d0c1e586bbaeb63f10`。
- 冻结时点：2026-09-28 17:42:21 +08:00。对象包含既有未提交与未跟踪文件，共 **5,245 个 Git 非忽略文件**；不能只用 HEAD 代表此次输入。
- 相对第 14 轮审查冻结：7 份原有文件变化，其中实现变化仅 `scripts/architecture/renderer-contracts.js`；其余为 README、TechDoc、实施/发布及验证规则记录。新增正式回归 `tests/unit/architecture/release-rereview-r14.test.js`（34 例），另新增 126 份历史审查/修复材料。
- `src/` 下 792 份生产文件相对上轮均不变；探针额外核对 `index.html`，合计 793 个生产输入相同。此次围绕 RR14 跳转修复审查，再对旧数组、调用顺序、共享解析/SQL 与绑定闭包探针回放，不声称重新逐行审查所有 G1–G8 业务代码。
- before 使用 R14 修复前归档，checker SHA-256 `adc6b47bb07c2c66f0d41b09d42e6195ffa404587bf8b3faceda662ec1767072`；current SHA-256 `eb2aae187b91f9e204eeacf97234ae6a4ebb277a9a0e9ce642cef556153c0e4d`。其余共享工具和政策文件核对冻结哈希。

证据：[冻结输入](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-28-release-rereview-r15/evidence/input-manifest.json)、[相对上轮差异](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-28-release-rereview-r15/evidence/prior-review-comparison.json)、[生产文件比较](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-28-release-rereview-r15/evidence/production-comparison.json)、[checker 增量](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-28-release-rereview-r15/evidence/renderer-incremental.diff)。

## 合同与前轮关闭

依据 [Spec AC-05](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/codex/v3.2.10-architecture-guardrails/spec.md:101)、[TechDoc RR14 条款](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/codex/v3.2.10-architecture-guardrails/techdoc.md:134) 和 [架构说明 RR14 条款](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/architecture/README.md:147)：可能跳过写入而仍到达读取时应保留旧来源；跳转前已完成写入、必经 finally 写入、同时跳过读写以及可证明不可达的字面量分支保持精度。文档同时排除任意循环次数、异常传播与完整 JavaScript 控制流解释。

RR14-01 原始 6 例本轮重新运行：before 诊断数量 `[0,0,0,0,0,1]`，current 为 `[1,0,1,1,0,1]`，3 个原漏检被纠正、2 个安全对照继续通过、1 个原可识别违规继续拒绝。原始真实配置 2 例在全部 **20 个 active Renderer boundaries** 下，current 为违规 1 条、安全 0 条；baseline 0、无 scanError。原问题在此范围关闭。

新补充 8 个 finally/helper 路径：4 个安全例零诊断、4 个存在越权路径的例子拒绝；其中 3 个 before 漏检在 current 被纠正。两版本每例以 `flag=false/true` 在 Node VM 执行并核对注入对象身份、字段及方法调用。1 个含两处 factory 的违规例产生 2 条诊断，不按两个缺陷计数。详见 [8 例审查](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-28-release-rereview-r15/evidence/r15-flow-review.md)及[机器断言](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-28-release-rereview-r15/evidence/r15-flow-verification.json)。

## R15-O1：空数组 for…of 中不可执行的跳转仍被保留

**类型：新增保守精度观察；不是本轮必改 finding。** 涉及 [跳转可达性过滤](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/scripts/architecture/renderer-contracts.js:157)。

最小模式为：外层 `do … while(false)` 内，用 `for (const item of [])` 包住条件 `break outer` 或 `continue outer`，随后无条件执行 `box.api = clean`，读取 `box.api` 并扩展该读取对象，最终注入原来的 `old` scoped API。

```js
outer: do {
  for (const item of []) {
    if (info.hasEnum) break outer;
  }
  box.api = clean;
} while (false);
const alias = box.api;
alias.outsideScope = window.desktopApi.outsideScope;
window.BankStatementController.createBankStatementController({ api: old });
```

事实：空数组不会进入循环体，`box.api = clean` 必然执行，扩展不污染最终注入的 `old`；VM 两种输入均证实原对象仍只有 `run`。修复前后诊断为 **0 → 1**，`continue outer` 安全变体同样 **0 → 1**。将 `[]` 换为 `[0]` 后，true 输入确实能跳过写入并污染原对象；该违规对照也从 **0 → 1**。空数组安全例与非空违规例均在真实 20 边界配置复现，baseline 均 0，无 scanError。

判断：当前实现识别字面量 `if`、`while`、`for` 条件的不可达分支，但没有分析 `for…of` 的空集合基数。虽然字面量 `[]` 可以被静态证明为空，现有条款没有明确将这一分析纳入承诺，且明确限制循环次数分析；主审与两项独立审查据此将其列为精度观察。修复前连 `[0]` 违规也未检出，因此不能仅以旧版本的零诊断证明存在既定精度保证。若后续将空迭代精度明确纳入契约，这两个安全例可直接作为后续回归样例。

详细 source、诊断与分类依据见 [Renderer 子审](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-28-release-rereview-r15/evidence/r15-renderer-review.md)、[真实配置 current](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-28-release-rereview-r15/evidence/r15-renderer-forof-realconfig-current.json)及 [12 次 VM 实值](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-28-release-rereview-r15/evidence/r15-renderer-branch-vm.json)。

本项不掩盖实际拒绝行为，也不作为“无误报”证明。本轮 6 个新跳转样例的准确分布为：**2 个安全例保守拒绝、2 个安全例正确通过、2 个违规例正确拒绝**；共 12 次 VM 分支执行符合样例预期。

## 验证结果及复用边界

| 验证 | 本轮证据 | 结果与边界 |
|---|---|---|
| 架构正式单测 | 本轮新执行 | **655/655 PASS**，0 失败、0 跳过，exit 0；包含既有 RR14 新增 34 回归 |
| 正式架构 CLI | 本轮新执行 | **31 active**，0 pending/partial、0 违规、0 stale；765/765 解析、0 解析错误，exit 0 |
| 原 RR14 复现 | 本轮 before/current 重放 | 6 个最小例及 2 个真实配置例支持上述有限关闭 |
| 新跳转/标签探针 | 本轮 before/current 重放 | 6 例及 2 个真实配置代表；包含 R15-O1 的 2 个安全保守拒绝 |
| finally/helper 探针 | 本轮 before/current 重放 | 8 例，4 安全通过、4 违规拒绝，无 scanError |
| 旧数组来源探针 | 本轮 before/current 重放 | 14 例诊断不变：7 违规拒绝、6 安全通过、1 已知安全保守拒绝 |
| 旧执行顺序探针 | 本轮 before/current 重放 | 8 例诊断不变：5 安全通过、3 违规拒绝；每例两种 VM 输入 |
| 共享与闭包绑定探针 | 本轮 before/current 重放 | 62 例诊断与 scanner 证据稳定；包含 10 个实际 SQLite 夹具、6 个绑定身份对照；已有纯字符串条件值保守拒绝单列 |
| 完整 release-check | **复用 R14 修复门禁，本轮未重跑** | 1,711 个门禁输入集合、内容哈希和 HEAD 完全匹配；原门禁单测 **9,429 PASS / 0 FAIL / 4 Windows skips**，集成 **68/68**，lifecycle **233/233**，exit 0 |

架构 CLI 还记录 unresolved 2、dynamic sites 33，报告不是“没有动态盲区”的证明。62 例稳定性包含重复扫描、规则执行前后扫描序列化、before/current digest 与 siteEvidenceIds；不是全业务集成覆盖。历史 async IPC 样例的 `expectedClean=false` 修正保持，已有纯值保守拒绝不计为合法通过。

复用的完整门禁实际执行时间为 2026-09-28 17:19:43–17:39:54 +08:00，命令 `UNIT_TEST_CONCURRENCY=2 npm run release-check`，Node `v25.8.0`、npm `11.11.0`。本轮核对原始日志与退出状态，而不是根据历史报告标题推断通过。

证据：[架构单测](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-28-release-rereview-r15/evidence/architecture-tests-result.json)、[架构 CLI](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-28-release-rereview-r15/evidence/architecture-check-result.json)、[数组/顺序断言](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-28-release-rereview-r15/evidence/r15-regression-verification.json)、[共享断言](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-28-release-rereview-r15/evidence/r15-shared-verification.json)、[门禁输入比较](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-28-release-rereview-r15/evidence/gate-evidence-comparison.json)、[原门禁日志核验](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-28-release-rereview-r15/evidence/gate-log-audit.json)。

## 保全与交付边界

本轮只新增此审查目录及临时探针，未修改源码、测试、配置、既有未提交实现或旧证据，未提交、推送或发布。结束时逐项比较冻结的 5,245 个非忽略文件，并核对 HEAD、Git 状态及 tracked binary diff；结果见 [保全核验](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-28-release-rereview-r15/evidence/preservation-final.json)。

此次未进行 Electron GUI、Windows、Excel/WPS、安装包和真实业务人工验收；4 项 Windows 单测跳过仍保留。静态架构规则通过与有限探针闭环，不代表生产背景执行、恢复授权、业务输出及整版正式发布就绪。

本轮汇总断言的 PASS 表示归档证据、预期诊断、样例运行及复用条件一致；它包含已明确记录的保守拒绝，不表示全部安全样例通过。

交付：[证据索引与重放说明](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-28-release-rereview-r15/evidence/README.md)、[主审机器核验](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-28-release-rereview-r15/evidence/verification.json)、[文档及 JSON 校验](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-28-release-rereview-r15/evidence/artifact-validation.json)、[产物 SHA-256](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-28-release-rereview-r15/evidence/artifact-sha256.json)。
