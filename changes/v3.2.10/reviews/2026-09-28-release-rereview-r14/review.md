# release/v3.2.10 第十四轮审查

**结论：发现 1 个新增 P2（RR14-01）。上一轮 RR13-01 条件 helper 漏报在原始反例及安全对照范围内关闭；本次新增的 do 首轮判断仍会丢失跳过写入的路径。**

## 冻结范围与依据

工作区 `/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10`，分支 `release/v3.2.10`，HEAD `9a38b96b1b8006c5851535d0c1e586bbaeb63f10` 加当前未提交改动。本轮于 **2026-09-28 16:57:01 +08:00** 冻结 5,118 个 Git tracked/untracked 非忽略文件。

相对[第十三轮报告](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-28-release-rereview-r13/review.md)，7 个既有文件变化，新增 1 个回归测试文件及 111 个历史审查/修复文件；792 个 `src/` 文件没有变化。代码增量集中于 `renderer-contracts.js` 的 `conditionalWrite` 和确定覆盖处理。本轮沿用 `blindspot-pass` 的证据纪律，聚焦该增量、旧问题关闭和共享解析影响，没有重新执行 G1–G7 全业务人工验收。

依据：[G8 Spec AC-05](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/codex/v3.2.10-architecture-guardrails/spec.md:101)、[TechDoc RR13 条件写入合同](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/codex/v3.2.10-architecture-guardrails/techdoc.md:132)、[架构 README](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/architecture/README.md:145)、[R13 修复报告](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-28-release-r13-repair/repair.md)。

before 使用 R13 repair 保存的检查器，SHA-256 `f288b9b66558e1fee0ca9697c493aed3b60c5999fac6c0366b81041a46c4f082`；current 为 `adc6b47bb07c2c66f0d41b09d42e6195ffa404587bf8b3faceda662ec1767072`。共享工具、机器配置及实际源码逐字节核对，不用 HEAD 代替未提交源码身份。

证据：[冻结清单](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-28-release-rereview-r14/evidence/input-manifest.json)、[增量摘要](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-28-release-rereview-r14/evidence/prior-review-comparison.json)、[检查器差异](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-28-release-rereview-r14/evidence/renderer-incremental.diff)、[生产源码比较](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-28-release-rereview-r14/evidence/production-comparison.json)。

## [P2] RR14-01：do 首轮进入不代表其中的写入必执行

**事实：** 新增的 `conditionalWrite` 将 do 首轮视为确定执行，但写入之前的条件 `break` 或 `continue` 可以跳过该写入；条件 `break` 也会跳过 do 的条件测试。当前检查器仍用未执行的新成员值覆盖旧来源，导致未授权方法注入漏报。

最小主反例只有单轮 `do…while(false)`，没有动态迭代或异常路径：

```js
const old = { run() {} };
const clean = { run() {} };
const box = { api: old };
async function run() {
  const info = await window.desktopApi.app.getInfo();
  do {
    if (info.hasEnum) break;
    box.api = clean;
  } while (false);
  const alias = box.api;
  alias.outsideScope = window.desktopApi.outsideScope;
  window.BankStatementController.createBankStatementController({ api: old });
  return alias === old;
}
run();
```

当 `hasEnum=true` 时提前跳出，`box.api` 仍为 `old`，注入对象包含可调用的 `outsideScope`；false 时正常替换，注入的 `old` 只有 `run`。这是正常的条件跳转，不是无条件 `break` 后不可达的语句。主例和写入先于跳转的安全对照均通过仓库现有 ESLint 规则（0 error / 0 warning）；该检查仅证明现有 lint 不会拦截这两份源码。

| 六个相邻用例 | before 诊断 | current 诊断 | VM 结果 / 判断 |
| --- | ---: | ---: | --- |
| 条件 break 在写入之前 | 1 | **0** | true 时旧对象获得额外方法，新增漏报 |
| 写入先于条件 break | 1 | 0 | true/false 均安全，原保守拒绝改善 |
| 条件 continue 在写入之前 | 1 | **0** | true 时写入被跳过，新增漏报 |
| 条件 break 跳过 do 条件测试中的写入 | 1 | **0** | true 时写入被跳过，新增漏报 |
| for 初始化写入 | 1 | 0 | true/false 均安全，必执行对照 |
| while 零次循环中的写入 | 1 | 1 | false 时旧来源保留，正确拒绝 |

三项漏报按同一个根因计为 **1 个 finding**。6 例均完成 false/true 的 VM 对照，共 12 次；before/current 均无 `scanError`。保留真实 **20 个 Renderer 边界**的实际配置探针也复现主反例 **1→0**，安全对照 **1→0**，两侧基线均为零诊断。

**原因与位置：** [conditionalWrite 的循环判断](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/scripts/architecture/renderer-contracts.js:155)在 155–160 行区分 for/while，却没有证明 do 内部具体写入及其条件测试能否到达；162–164 行因此返回非条件写入。随后[成员候选覆盖](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/scripts/architecture/renderer-contracts.js:223)在 228 行选择新值，丢弃仍可保留的旧来源。修复前这些 do 写入被保守合并；同一源码、相同配置的前后实验确认本轮修复引入了漏报。

**影响与未知：** 这种普通有限控制流会让实际带有未授权方法的 API 对象通过 G8 scoped API 检查。当前生产树扫描通过，本轮未证明真实业务已经使用该装配形式或发生产品故障。结论针对新增的必执行判断，不要求实现完整 JavaScript 控制流解释器。

**处置建议：** 把“进入循环首轮”与“必然到达该写入/条件测试”分开；遇到可跳过目标位置的 `break/continue`，不能据首轮入口直接清除旧来源，可保守合并或给出 coverage 诊断。补齐三个单轮反例，并保留写入先于跳转和 for 初始化的安全对照。修复后重新验证最终候选；本轮不改实现。

**证据与最便宜验证（已完成）：** [最小配置 before](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-28-release-rereview-r14/evidence/r14-renderer-probes-before.jsonl)、[current](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-28-release-rereview-r14/evidence/r14-renderer-probes-current.jsonl)、[12 次 VM 对照](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-28-release-rereview-r14/evidence/r14-renderer-branch-vm.json)、[实际配置 before](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-28-release-rereview-r14/evidence/r14-renderer-do-realconfig-before.json)、[current](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-28-release-rereview-r14/evidence/r14-renderer-do-realconfig-current.json)、[局部 lint](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-28-release-rereview-r14/evidence/r14-renderer-lint.json)。[证据说明](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-28-release-rereview-r14/evidence/README.md)提供重放入口。

## 旧问题关闭及相邻验证

| 范围 | 本轮结果 | 结论边界 |
| --- | --- | --- |
| RR13 原 4 例 | 当前诊断 `[1,1,0,0]`，原条件漏报已拒绝，两个安全对照通过 | RR13-01 原始范围关闭 |
| RR13 原实际配置 2 例 | 基线零诊断；违规 1 条 scope，安全 0 条；无异常 | 保留真实 20 边界中的指定装配 |
| 覆盖顺序新 8 例 | 5 安全零诊断、3 违规各 1 条，before/current 保持；每例 VM 执行两个输入 | 嵌套覆盖、工厂帧、数组槽位、重复 helper、声明文本顺序及旧别名范围未见新缺陷 |
| RR12 数组/helper 14 例 | 无异常、无诊断变化；7 违规、6 安全、1 既有保守拒绝 | 未重新出现栈溢出或本次来源退化 |
| 共享 56 + 绑定 6 例 | 前后诊断一致；62 例 scanner 重复/规则前后/版本间 digest 与 evidenceId 一致 | 38 Renderer、18 query；10 个 query 实际执行内存 SQLite |

证据：[RR13 原样例](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-28-release-rereview-r14/evidence/r14-renderer-original-probes.jsonl)、[原实际配置](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-28-release-rereview-r14/evidence/r14-renderer-original-realconfig.json)、[覆盖顺序断言](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-28-release-rereview-r14/evidence/r14-order-verification.json)、[数组断言](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-28-release-rereview-r14/evidence/r14-array-verification.json)、[共享与绑定断言](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-28-release-rereview-r14/evidence/r14-shared-verification.json)。

“槽位写入 clean、再覆盖 old、然后重排”以及不同纯字符串候选仍被保守拒绝，继续记为已有精度限制，不计新增缺陷，也不冒充合法通过。未 await 的异步 IPC Promise 样例保持正确的拒绝期望。

## 正式验证与门禁证据

| 检查 | 结果 |
| --- | --- |
| 本轮架构单测 | **621/621 PASS**，0 fail、0 skip；[日志](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-28-release-rereview-r14/evidence/architecture-tests.log)、[结果](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-28-release-rereview-r14/evidence/architecture-tests-result.json) |
| 本轮正式架构 CLI | **31 active、0 pending/partial、0 诊断、0 stale**；解析 765/765，unresolved 2、dynamic 33，历史 21 commits；[日志](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-28-release-rereview-r14/evidence/architecture-check.log)、[JSON](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-28-release-rereview-r14/evidence/architecture-check.json) |
| 完整门禁输入匹配 | **1,710 个文件集合、哈希及 HEAD 全匹配**；[比较](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-28-release-rereview-r14/evidence/gate-evidence-comparison.json) |
| 复用完整门禁 | 2026-09-28 16:33:19–16:50:50 +08:00，`UNIT_TEST_CONCURRENCY=2 npm run release-check` exit 0；9395 项单测通过、0 失败、4 项 Windows 条件跳过；68/68 集成脚本通过，Renderer lifecycle 233/233 |

完整门禁**本轮未重跑**。已核实输入未变并复查原日志和进程记录，见[日志核对](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-28-release-rereview-r14/evidence/gate-log-audit.json)、[原完整日志](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-28-release-r13-repair/release-check.log)、[原进程结果](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-28-release-r13-repair/release-check-result.json)。既有 PASS 没有覆盖 RR14-01 新反例，不能据此关闭该问题。

## 保全与未验证边界

只新增本轮审查文档、脚本和证据。冻结的 **5,118 个既有非忽略文件**逐字节保持；HEAD、Git status 和 tracked diff 保持，本轮目录外无新增非忽略文件。[最终保全](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-28-release-rereview-r14/evidence/preservation-final.json)、[产物校验](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-28-release-rereview-r14/evidence/artifact-validation.json)、[机器汇总](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-28-release-rereview-r14/evidence/verification.json)。

实际配置探针只在生产 AST 内存副本追加指定源码，VM 仅执行人工源码与 mock API/controller；不是执行真实 Renderer/Preload、业务 IPC 或逐一运行 20 个控制器。GUI、Windows 实机/安装包、Excel/WPS、真实资金数据及全业务人工验收本轮未执行。未提交、推送、开 PR、升版或发布。

存活必改项为 **RR14-01**。RR13 原反例及安全对照已关闭；覆盖顺序、数组和共享解析的列明对照未出现新回归，已有保守精度边界仍保留。后续验收应加入三个单轮跳过写入反例及安全对照，并在修复后的最终输入上重新取得所需门禁证据。
