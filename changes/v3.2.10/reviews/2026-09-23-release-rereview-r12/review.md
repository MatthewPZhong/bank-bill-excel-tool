# release/v3.2.10 第十二轮独立增量审查

确认 **1 项 P2：RR12-01，普通数组 helper 引起检查器递归栈溢出**。该问题在 R11 repair 起点和当前均存在，属于本轮新发现的既有缺陷。第十一轮 RR11-01/02 的原始反例已通过独立复核；IPC 修复的六个邻近组合也符合预期。另记录一个新增保守拒绝观察，不计为确定缺陷。

## 1. 冻结对象与审查范围

| 项目 | 事实 |
|---|---|
| 分支 | `release/v3.2.10` |
| worktree | `/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10` |
| HEAD | `9a38b96b1b8006c5851535d0c1e586bbaeb63f10` 加已有未提交修复 |
| 固定基线 | `v3.2.9` → `11086a3cbf632a30adbcfa796e4cd81810c5aef9` |
| 冻结时间 | 2026-09-23 13:44:56 Asia/Shanghai |
| 冻结文件 | 4,902 个 Git 可见文件，另保存 status 与 tracked binary diff |
| 当前 Renderer 检查器 SHA256 | `6b57b228b5fb576bbd3ea40d42ff010c5414c1a6a96fb7efdc6aba92fd2c2bec` |
| before 检查器 | R11 repair 准确起点 `dd34f594f57d0d5d6f33944bed80802d50b4712077e9f4dba1f205d93b19dbb7` |

与第十一轮冻结快照相比，既有文件变化 7 个：Renderer 检查器及 6 个说明文件；审查目录外新增 `release-rereview-r11.test.js`（11 项回归）。792 个 `src/` 文件、机器边界及例外、共享 scan/contracts/rules/schema/policy-history 均未变。

本轮沿用 blindspot-pass 证据方法，检查 IPC 成员证明清除和重排来源聚合的增量，有限核验 helper、时点、对象隔离及共享解析。没有重新审计 G1–G8 全部生产流程。所有仓库命令显式使用上述独立 worktree；before 取 repair 的归档检查器，其余 4 个工具必须匹配同一 repair 起点 hash，未混用更早版本。

范围依据：[起点清单](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-23-release-rereview-r12/evidence/input-manifest.json)、[前轮差异](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-23-release-rereview-r12/evidence/prior-review-comparison.json)、[检查器增量](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-23-release-rereview-r12/evidence/renderer-incremental.diff)、[生产与政策比较](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-23-release-rereview-r12/evidence/policy-production-comparison.json)。

## 2. 确认问题

### [P2] RR12-01：普通 helper 包装数组重排，导致检查器栈溢出

**事实与触发条件：** 同一文件中将 `reverse()` 放入普通、非递归的单调用 helper。生产样例本身执行结束，但静态规则评估抛出 `RangeError: Maximum call stack size exceeded`。

```js
function provide() { return { api: { run() {} } }; }
const old = provide();
const clean = provide();
function make(value) {
  const args = [];
  args.push(value);
  return args;
}
const list = [...make(old)];
function reorder(target) { target.reverse(); }
list[1] = clean;
reorder(list);
const alias = list[0].api;
alias.outsideScope = window.desktopApi.outsideScope;
window.BankStatementController.createBankStatementController({ api: clean.api });
```

VM 确认该违规样例正常结束，`alias === clean.api`，额外方法可调用并返回 `true`。将 `reorder(list)` 移到 `list[1] = clean` 之前的安全对照，VM 注入对象只有 `run`，但检查器仍抛出同一异常。因此它不是正常的 scoped API 拒绝，也不能视为 0 条诊断的通过。

**前后版本与实际配置：** 8 个有限数组邻近场景中，4 个 helper 场景在 before/current 均抛 `RangeError`，按一个根因计为一项 P2。完整生产 Renderer AST 加全部 **20 个 active Renderer 边界**的代表验证中，违规 helper 与安全 helper 都在两侧抛异常；两侧生产基线均 0 诊断、765/765 文件解析。正常接收者别名重排在当前输出 1 条诊断，捕获旧值的安全对照仍为 0，故不是整个实际配置普遍失败。

**位置与原因判断：** [sameObject](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/scripts/architecture/renderer-contracts.js:65) 在 68 行重新以 `depth=0` 和空 `visited` 调用 `resolve`，递归保护缓存又按 `env` 对象区分。异常调用栈包含 `sameObject → unsupportedArrayMutation → resolve → parameterValue`；结合 [参数环境与实参重求值](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/scripts/architecture/renderer-contracts.js:310)，判断是工厂／参数重求值产生新环境，导致当前身份求值的缓存无法阻断这条环路，且深度上限反复被重置。源码 helper 没有递归调用；循环发生在检查器内部。

**影响：** 合法的 helper 形式也无法得到正常规则评估，架构门禁被分析器异常阻断，无法按 scope/coverage 合同输出诊断。当前生产树没有触发它，正式 CLI 仍通过；不能把该反例说成已经发生的产品业务故障。

**处置建议：** 身份比较应保留跨环境重求值的递归链，或按稳定的调用身份建立正在求值标记；超过可解释边界时返回受控 unknown/coverage，而非无限递归。补齐单调用 helper 的违规与安全对照，并确认分析器能终止和给出正确结果。依据为 [Spec AC-05 / 静态覆盖验收](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/codex/v3.2.10-architecture-guardrails/spec.md:101)、[helper 与调用环境支持](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/codex/v3.2.10-architecture-guardrails/techdoc.md:126)、[当前重排来源合同](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/codex/v3.2.10-architecture-guardrails/techdoc.md:128)。

**最便宜验证（已执行）：**

- [最小配置前后结果](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-23-release-rereview-r12/evidence/r12-array-neighbor-before-current.json)：4 个 `scanError`，没有将异常转换为 `violations: []`。
- [实际配置前后结果](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-23-release-rereview-r12/evidence/r12-array-neighbor-real-before-current.json) 与 [实际配置脚本](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-23-release-rereview-r12/evidence/r12-array-neighbor-real-probe.cjs)：同一源、同一边界，安全和违规 helper 均报异常。
- [未捕获单例脚本](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-23-release-rereview-r12/evidence/r12-array-raw-helper-probe.cjs)、[原始 stderr](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-23-release-rereview-r12/evidence/r12-array-raw-helper.stderr)、[进程退出记录](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-23-release-rereview-r12/evidence/r12-array-raw-helper-exit.json)：单例进程 exit **1**、signal null。该退出码来自原始 probe，不冒称正式架构 CLI 的 fixture 退出码。
- [受控版本比较入口](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-23-release-rereview-r12/evidence/r12-array-compare.cjs)：核对 5 工具、2 配置和 793 个 `src/*` 加 `index.html` 输入，前后源码 0 mismatch。

后续逐例捕获异常仅用于完成其余案例采集，JSON 明确保留 `scanError` 与调用栈；捕获后的脚本 exit 0 不表示这些案例通过。

## 3. 原问题关闭及观察

| 范围 | 本轮独立结果 | 边界 |
|---|---|---|
| RR11-01 原 6 例 | 全部符合修复后的预期 | 父成员缺失路径拒绝，成员自身回退允许 |
| RR11-01 原实际配置 2 例 | 违规 1，安全 0 | 完整 20 Renderer 配置中的指定装配 |
| 新 IPC 邻近 6 例 | 全部符合预期 | 嵌套成员、参数解构、helper 返回后成员从 0→1；自身 OR/?? 安全 0→0；假值父成员默认继续拒绝 |
| RR11-02 原 8 例 | 全部符合预期 | 原 reverse 漏报 0→1，其余不退化 |
| RR11-02 原实际配置 3 例 | 2 违规各 1，1 安全 0 | 原问题关闭 |
| 新数组邻近 8 例 | 3 符合预期，4 个 helper 异常，1 个保守拒绝观察 | 不称为 8/8 通过；异常按 RR12-01 一个根因计 |
| 共享 56 例 | 前后诊断数组一致 | 38 Renderer、18 query；10 个 query 实际执行内存 SQLite |
| 闭包绑定 6 例 | 3 安全 0→0，3 违规 1→1 | 独立 helper、同名参数捕获、sibling 工厂保持 |
| scanner 稳定性 62 例 | 重复、规则前后、before/current digest 与 evidenceId 一致 | 限定于共享和绑定样例，不包含抛异常的数组邻近样例 |

证据：[原 IPC](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-23-release-rereview-r12/evidence/r12-renderer-original-probes.jsonl)、[IPC 邻近](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-23-release-rereview-r12/evidence/r12-renderer-probes-current.jsonl)、[原 IPC 实际配置](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-23-release-rereview-r12/evidence/r12-renderer-original-realconfig.json)、[原数组前后](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-23-release-rereview-r12/evidence/r12-array-original-before-current.json)、[原数组实际配置](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-23-release-rereview-r12/evidence/r12-array-original-real.json)、[共享与绑定验证](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-23-release-rereview-r12/evidence/shared-archive-verification.json)。

**新增保守拒绝观察，不计 finding：** `overwritten-before-reorder-safe` 先把 `clean` 写入数组槽位，再用旧对象覆盖后重排，VM 最终未改写注入对象；静态结果从 before 0 变成 current 1。当前实现会将重排前的可见写入保留为可能来源。鉴于 [README 的保守集合和非精确索引边界](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/architecture/README.md:141)，本轮将其记为精度限制，不据此断言违反合同，也不称为合法通过。原始来源和结果保留在数组邻近 JSON；若未来要保证此类形式通过，需另补槽位覆盖消除及正反验收。

另外两项既有边界继续保留：未 await 的 IPC Promise 分类取值会触发 `other` 默认来源，正确期望为拒绝；`flag ? "business" : "gateway"` 的两个纯字符串分支仍被保守拒绝，未计为合法放行或新增问题。

实际配置探针只在生产 AST 内存副本追加样例；VM 执行人工源码和 mock API/controller，未执行真实 Renderer/Preload 或业务 IPC。“20 个边界”不等同于逐一运行 20 个真实控制器。

## 4. 正式验证与完整门禁

本轮重新执行：

- `node --test --test-concurrency=1 tests/unit/architecture/*.test.js`：**577/577 PASS，0 fail、0 skip，exit 0**。[日志](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-23-release-rereview-r12/evidence/architecture-tests.log)
- `node scripts/check-architecture.js --json <本轮绝对输出路径>`：**exit 0，31 active、0 pending/partial、0 诊断、0 stale**；765/765 文件解析，未解析 2、动态位置 33，历史 21 个提交。[JSON](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-23-release-rereview-r12/evidence/architecture-check.json)、[日志](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-23-release-rereview-r12/evidence/architecture-check.log)
- [归档断言脚本](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-23-release-rereview-r12/evidence/verify-probes.py) 与 [结果](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-23-release-rereview-r12/evidence/probe-verification.json)：包括版本 hash、原例关闭、helper 异常、保守观察和门禁输入一致性；PASS 表示证据一致，不表示候选无缺陷。
- [共享归档断言](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-23-release-rereview-r12/evidence/verify-shared-archive.py)：62 例的版本、SQL/Promise、VM、scanner 稳定性全部符合记录。

完整 `release-check` **本轮未重跑**。复用 R11 repair 于 2026-09-23 **10:32:54–10:50:35 Asia/Shanghai** 完成的最终门禁：`UNIT_TEST_CONCURRENCY=2 npm run release-check`，exit 0；**9351 项单测通过、0 失败、4 项 Windows 条件跳过**（9355 total）；**68/68 集成脚本通过**，有数字摘要的合计 2901/2901，另 1 个脚本无数量摘要，Renderer lifecycle 233/233。

本轮逐一核对其 HEAD 和 **1708 个门禁输入**与当前候选完全一致，且核对实际日志与进程结果。577 项架构测试和 11 项新增回归属于完整测试的子集，不能把这些计数相加。

依据：[完整门禁验证](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-23-release-r11-repair/verification.json)、[进程结果](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-23-release-r11-repair/release-check-result.json)、[门禁输入](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-23-release-r11-repair/gate-input-manifest.json)、[本轮复用核验](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-23-release-rereview-r12/evidence/reused-gate-verification.json)。

## 5. 结项与保全

会影响验收的存活问题为 RR12-01。IPC 证明泄漏和原固定槽位重排漏报在列出的原例与对照中已关闭；完整 G8、任意动态 JavaScript 和整个 release 的可发布性没有因此获得全面确认。

没有修改生产代码、检查器、测试、配置或历史记录；没有提交、合并、推送、PR、升版、标签或发布。真实产品 Main 全流程、GUI、Windows 实机/安装包、Excel/WPS 和真实资金人工验收未执行。

最终保全对照 **4902 个冻结文件**、HEAD、Git status、tracked binary diff，检查本轮报告目录外无新增 Git 可见文件。[保全结果](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-23-release-rereview-r12/evidence/preservation-final.json)；[文档链接和 JSON/JSONL 校验](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-23-release-rereview-r12/evidence/artifact-validation.json)、[归档 SHA256](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-23-release-rereview-r12/evidence/artifact-sha256.json)。[复现说明](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-23-release-rereview-r12/evidence/README.md) 保留所有关键脚本入口与依赖。
