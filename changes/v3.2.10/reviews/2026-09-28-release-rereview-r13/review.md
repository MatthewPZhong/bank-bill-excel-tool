# release/v3.2.10 第十三轮审查

**结论：发现 1 个新增 P2（RR13-01）；第十二轮 RR12-01 栈溢出问题在列明范围内关闭。当前候选仍存在 Renderer 能力检查漏报，不能以现有自动门禁通过认定该缺口已关闭。**

## 审查对象与依据

- 工作区：`/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10`；分支 `release/v3.2.10`；HEAD `9a38b96b1b8006c5851535d0c1e586bbaeb63f10` 加现有未提交改动。正式基线 `v3.2.9` 为 `11086a3cbf632a30adbcfa796e4cd81810c5aef9`。
- 本轮于 **2026-09-28 14:52:01 +08:00** 冻结 5,006 个 Git tracked/untracked 非忽略文件。对比[第十二轮报告](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-23-release-rereview-r12/review.md)与[修复报告](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-23-release-r12-repair/repair.md)，7 个既有文件变化，新增 1 个架构回归测试文件及 103 个历史审查/修复文件；792 个 `src/` 文件没有变化。
- 实质代码增量仅在 `renderer-contracts.js`：延迟数组内容求值、提取唯一调用入口、通过唯一调用点补回执行时序。审查聚焦这些改动及其共享解析影响，未把 G1–G7 全业务重新逐项验收。
- 对照 [G8 Spec AC-05](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/codex/v3.2.10-architecture-guardrails/spec.md:101)、[TechDoc §4.4](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/codex/v3.2.10-architecture-guardrails/techdoc.md:96)及 [README 当前支持边界](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/architecture/README.md:139)。使用 `blindspot-pass` 的证据纪律区分事实、推断和未验证项。
- before 使用 R12 repair 保存的准确检查器，SHA-256 `6b57b228b5fb576bbd3ea40d42ff010c5414c1a6a96fb7efdc6aba92fd2c2bec`；current 为 `f288b9b66558e1fee0ca9697c493aed3b60c5999fac6c0366b81041a46c4f082`。共享工具与配置逐字节核对。

证据：[冻结清单](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-28-release-rereview-r13/evidence/input-manifest.json)、[差异摘要](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-28-release-rereview-r13/evidence/prior-review-comparison.json)、[检查器增量](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-28-release-rereview-r13/evidence/renderer-incremental.diff)、[生产源码比较](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-28-release-rereview-r13/evidence/production-comparison.json)。

## [P2] RR13-01：唯一调用点不能证明条件 helper 已执行

**事实：** `executionPositions` 新增的 fallback 将 helper 内的写入提升到它唯一的调用位置，但没有带回调用处的条件性。`snapshotMember` 仅检查赋值节点到 helper 函数边界之间的分支，因而将下面的 `box.api=clean` 当成确定发生，用 `clean` 覆盖原来的 `old` 候选。

```js
const old = { run() {} };
const clean = { run() {} };
const box = { api: old };
function replace() { box.api = clean; }
async function run() {
  const info = await window.desktopApi.app.getInfo();
  if (info.hasEnum) replace();
  const alias = box.api;
  alias.outsideScope = window.desktopApi.outsideScope;
  window.BankStatementController.createBankStatementController({ api: old });
  return alias === old;
}
run();
```

当 `hasEnum=false` 时 helper 实际未执行，`alias===old`，注入对象包含可调用的 `outsideScope`。同一源码 `hasEnum=true` 时才替换为 `clean`，注入的 `old` 保持只有 `run`。因此不能只保留替换后的身份。

| 验证 | 修复前检查器 | 当前检查器 | 运行时证据 |
| --- | --- | --- | --- |
| 最小配置：条件调用未进入 | 1 条 scope 诊断 | **0 条诊断** | `same=true`，额外方法存在且调用返回 true |
| 实际 20 个 Renderer 边界：同一条件例 | 1 条 scope 诊断 | **0 条诊断** | false 分支注入对象包含额外方法；true 分支只有 `run` |
| 无条件调用后注入被改写对象 | 1 条 scope 诊断 | 1 条 scope 诊断 | 额外方法存在，正常拒绝 |
| 捕获后才调用 helper 的安全对照 | 1 条 scope 诊断 | 0 条诊断 | 注入对象只有 `run` |
| 无条件替换后注入旧对象的安全对照 | 1 条 scope 诊断 | 0 条诊断 | 注入对象只有 `run`；实际 20 边界也为 1→0 |

全部新时序探针无 `scanError`，实际配置的 before/current 基线均为零诊断。安全对照说明新增时序分析确实改善了原有保守拒绝，问题在于同时丢失条件调用未执行的路径。

**原因与位置：** [唯一调用 fallback](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/scripts/architecture/renderer-contracts.js:114)在 118–121 行无条件采用调用点；[成员快照](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/scripts/architecture/renderer-contracts.js:175)取得 `before=true` 后，只在 184–187 行核查写入本身的函数内祖先，200 行直接替换旧来源。源码与前后实验共同支持该根因。

**影响：** 违反 scoped API 的方法可以通过这种普通条件 helper 形式漏过架构门禁。这是本次 R12 修复引入的检查器回归。当前生产树的正式扫描通过，本轮没有证据表明真实产品业务已经触发这个装配形式；不能将其描述为已发生的业务故障。

**处置建议：** 修复时沿执行位置/调用帧传递分支和循环的不确定性；只有可证明必执行的写入才能覆盖原成员身份，否则合并旧值与新值候选。保留无条件替换和捕获旧别名的安全对照，并增加 `hasEnum=false/true` 的运行时与静态回归。该项需修复后复审；本轮不改实现。

**最便宜验证（已完成）：** [最小配置 before](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-28-release-rereview-r13/evidence/r13-renderer-probes-before.jsonl)、[current](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-28-release-rereview-r13/evidence/r13-renderer-probes-current.jsonl)、[实际配置 before](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-28-release-rereview-r13/evidence/r13-renderer-conditional-realconfig-before.json)、[current](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-28-release-rereview-r13/evidence/r13-renderer-conditional-realconfig.json)、[分支 VM 对照](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-28-release-rereview-r13/evidence/r13-renderer-branch-vm.json)。重放入口与输入哈希见[证据说明](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-28-release-rereview-r13/evidence/README.md)。

## 原问题关闭与保留边界

| 范围 | 本轮结果 | 结论边界 |
| --- | --- | --- |
| RR12 原 8 例 + 现有对象/解构/单层嵌套 6 例 | before 10 个 RangeError；current 0 异常；7 违规各 1 条诊断、6 安全零诊断、1 已记录保守拒绝仍 1 条 | RR12-01 在这 14 个既有 fixture 范围内关闭；不是新增 14 项仓库测试 |
| 原始未捕获 helper 探针 | exit 0，正常输出 scope 诊断 | 没有把捕获异常的进程 exit 0 当作通过 |
| 56 个共享 fixture | 38 Renderer、18 query 的前后诊断一致；10 个 query 实际运行内存 SQLite | 共享解析未见本轮回归 |
| 6 个绑定/闭包对照 | 3 安全 0→0，3 违规 1→1；VM 身份一致 | 原绑定语义保持 |
| 62 个共享与绑定 fixture 的 scanner | 重复扫描、规则前后、before/current digest 与 evidenceId 一致 | 只证明列明样例的稳定性 |

证据：[数组复核](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-28-release-rereview-r13/evidence/r13-array-review.md)、[数组机器断言](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-28-release-rereview-r13/evidence/r13-array-verification.json)、[共享与绑定断言](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-28-release-rereview-r13/evidence/r13-shared-verification.json)。

以下为既有精度边界，不计新增 finding，也不冒充合法通过：槽位先写入 clean、再覆盖 old、然后重排仍被保守拒绝；`flag ? "business" : "gateway"` 的不同纯字符串候选仍被拒绝。未 await 的 IPC Promise 分类样例保持正确的拒绝期望（`expectedClean=false`）。

## 验证与完整门禁证据

| 检查 | 结果 |
| --- | --- |
| 本轮架构单测 | **589/589 PASS**，0 fail、0 skip；[日志](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-28-release-rereview-r13/evidence/architecture-tests.log)、[结果](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-28-release-rereview-r13/evidence/architecture-tests-result.json) |
| 本轮正式架构 CLI | **31 active、0 pending/partial、0 诊断、0 stale**；解析 765/765，unresolved 2、dynamic 33，历史 21 commits；[日志](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-28-release-rereview-r13/evidence/architecture-check.log)、[JSON](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-28-release-rereview-r13/evidence/architecture-check.json) |
| 完整门禁输入核对 | **1,709 个文件集合与哈希及 HEAD 全部匹配**；[比较](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-28-release-rereview-r13/evidence/gate-evidence-comparison.json) |
| 复用的完整门禁 | 2026-09-23 14:44:29–15:05:10 +08:00 执行 `UNIT_TEST_CONCURRENCY=2 npm run release-check`，exit 0；9363 项单测通过、0 失败、4 项 Windows 条件跳过；68/68 集成脚本通过，Renderer lifecycle 233/233 |

完整门禁**本轮未重跑**：输入未变化，复核了原日志及进程结果后复用。见[原门禁日志](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-23-release-r12-repair/release-check.log)、[原进程记录](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-23-release-r12-repair/release-check-result.json)、[本轮日志核对](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-28-release-rereview-r13/evidence/gate-log-audit.json)。既有 PASS 不包含 RR13-01 的新反例，不能反证新发现。

## 保全及未验证项

只新增本轮审查文档、探针和证据；实现、测试、配置及历史审查文件没有修改。冻结的 5,006 个非忽略文件逐字节保持，HEAD、Git status 与 tracked diff 保持，本轮目录外没有新增非忽略文件。见[最终保全](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-28-release-rereview-r13/evidence/preservation-final.json)、[产物校验](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-28-release-rereview-r13/evidence/artifact-validation.json)。

实际配置实验使用生产 AST 的内存副本，VM 只执行人工源码及 mock API/controller；未执行真实 Renderer/Preload/业务 IPC，也不等同于逐一运行 20 个控制器。GUI、Windows 实机/安装包、Excel/WPS、真实资金数据和全业务人工验收本轮未执行。未提交、推送、开 PR、升版或发布。

存活必改项为 **RR13-01**。RR12 helper 崩溃及列明相邻对照已被本轮证据关闭；已记录的保守拒绝继续作为精度边界。修复 RR13-01 后应重跑条件调用正反例、受影响架构测试，并为最终修改后的候选重新取得所需门禁证据。
