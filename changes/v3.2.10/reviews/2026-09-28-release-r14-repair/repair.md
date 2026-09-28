# release/v3.2.10 第十四轮审查修复

**RR14-01 已修复，最终候选的完整 `release-check` 已重新运行并通过。** do 首轮内的写入若可能被 break/continue 跳过，检查器保留旧对象来源；原始三个漏报均变为 `ARCH-RENDERER-SCOPE` 诊断，列明的安全对照继续通过。

## 依据与改动

分支 `release/v3.2.10`，HEAD `9a38b96b1b8006c5851535d0c1e586bbaeb63f10` 加既有未提交修复。本次依据[第十四轮审查](../2026-09-28-release-rereview-r14/review.md)、[G8 Spec](../../codex/v3.2.10-architecture-guardrails/spec.md) AC-05 和 [TechDoc](../../codex/v3.2.10-architecture-guardrails/techdoc.md) §4.4。

[Renderer 检查器](../../../../scripts/architecture/renderer-contracts.js)的成员快照新增有限跳转检查：

1. 解析同一函数内静态 break/continue 的目标，核对跳转是否位于写入之前、是否能跳过写入而仍到达读取；沿现有 helper 调用位置传递这一判断。
2. break 可跳过 do 剩余 body 和条件测试；continue 仍执行 do 条件测试。内层循环/switch/label 的跳转只影响其实际目标。
3. 跳转前的写入、跳转必经的 finally 写入、字面量不可达分支，以及同时跳过写入和读取的安全路径保持精度。可跳过的写入仅合并来源，后续确定覆盖沿用既有规则。

新增 [34 项回归](../../../../tests/unit/architecture/release-rereview-r14.test.js)，逐项使用异步 VM 的 false/true 输入核实对象身份、额外能力和静态诊断；涵盖 helper、数组槽位、label、switch、finally 与跳转前后顺序。共享 scan/contracts/rules/schema、机器配置、授权集合及生产业务源码均保持。

## 验证

| 范围 | 结果与证据 |
| --- | --- |
| 准确修复起点 | 最终同一 34 项测试：**15 FAIL / 19 PASS**，检查器逐文件哈希匹配。[日志](regressions-before-final.log)、[输入](regressions-before-inputs.json) |
| 新增回归 / 全部架构单测 | 新增 **34/34 PASS**，包含于 **655/655 PASS**。[架构日志](architecture-tests-final.log)、[预检](preflight-verification.json) |
| 审查原始案例 | **6 例符合预期、12 次 VM 分支验证**；三个原始 do 漏报均从 0 变为 1 条 scope 诊断，无异常。[修复前](renderer-before.jsonl)、[修复后](renderer-after.jsonl)、[VM](renderer-vm.json) |
| 实际 Renderer 配置 | 保留 **20 个 active 边界**；代表反例 1 条 scope 诊断、安全例 0 条、基线 0 条、无扫描异常。[结果](do-realconfig.json) |
| 覆盖顺序 / RR12 数组 | 顺序 **8 例**保持（5 安全通过、3 违规拒绝）；数组 **14 例**无异常（7 违规拒绝、6 安全通过、1 既有保守拒绝单列）。[顺序](order.json)、[数组](array-original.json)、[嵌套/helper](array-finite.json)、[核对](probe-verification.json) |
| 共享解析 / 参数绑定 | **56 + 6 例**诊断、scanner 结构及 evidenceId 与 R14 审查结果一致。[共享汇总](shared-verification.json)、[绑定](bindings-probe.json) |
| 修改的 JS lint | **0 error / 0 warning**。[结果](tool-lint.json) |
| 正式架构 CLI | **31 active、0 pending/partial、0 诊断、0 stale**，从本次完整门禁内同一 CLI 调用提取。[日志](architecture-check.log) |
| 完整门禁 | **PASS**：`UNIT_TEST_CONCURRENCY=2 npm run release-check`。[完整日志](release-check.log)、[进程结果](release-check-result.json) |
| 全量单测 / 集成 | **9429 项单测通过、0 失败、4 项 Windows 条件跳过，68/68 集成脚本通过**；Renderer lifecycle 233/233 |
| 候选一致性 | **1711 个门禁输入与 HEAD 未漂移**。[冻结清单](gate-input-manifest.json)、[验证汇总](verification.json) |

完整门禁开始于 **2026-09-28T17:19:43.887250+08:00**，结束于 **2026-09-28T17:39:54.344494+08:00**。本轮重跑全套，没有复用旧候选的完整门禁结论。实际配置探针在内存中追加 AST 样例、VM 使用 mock API，不等于执行 20 个控制器的真实业务。

## 保全与限制

接手时冻结 **5190 个既有文件**，仅 **7 个计划内文件**变化：检查器、5 份设计/状态文档和完整门禁自动刷新的集成耗时表。其余 **5183 个文件逐字节保持**，包含 **792 个生产源码文件**和 **1208 个历史审查/修复文件**。新增本轮测试和证据，HEAD 未变；未提交、推送、开 PR、升版或发布。[保全核对](preservation-final.json)。

[本轮增量补丁](incremental.patch)相对接手时的未提交候选生成；反向适用只读预检和 `git diff --check` 均通过。[交付核对](delivery-check.json)、[实施记录](implementation-notes.md)。复现入口为 [起点回归](run-baseline.py)、[原始与相邻探针](replay-probes.py)、[共享探针](verify-shared.py)；脚本结果写入本轮目录，不覆盖历史审查证据。

本轮复核围绕 do、静态跳转目标、具体写入及读取位置；列明用例内没有待处理的确认缺陷。既有“槽位先覆盖再重排”和不同纯字符串候选的保守拒绝继续保留，不计作合法通过。本次不声明任意循环次数、异常传播、动态调用或完整 JavaScript 控制流均得到证明，也不扩大为整个 G8 无缺口的结论。

真实产品 Main 全流程、GUI、Windows 实机/安装包、Excel/WPS 和资金人工验收未执行。完整自动门禁通过不等于整个 release 的人工验收或发布完成。
