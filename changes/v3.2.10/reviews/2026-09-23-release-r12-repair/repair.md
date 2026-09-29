# release/v3.2.10 第十二轮审查修复

**RR12-01 已修复；最终候选的完整 `release-check` 已重新运行并通过。** 普通数组 helper 不再引起检查器递归栈溢出，原始违规例产生 scope 诊断，安全例正常通过。

## 修复与候选

分支 `release/v3.2.10`，HEAD `9a38b96b1b8006c5851535d0c1e586bbaeb63f10` 加既有未提交修复。[第十二轮审查](../2026-09-23-release-rereview-r12/review.md)与 [G8 Spec](../../codex/v3.2.10-architecture-guardrails/spec.md) AC-05 为本次依据；[TechDoc](../../codex/v3.2.10-architecture-guardrails/techdoc.md) §4.4 已同步。

[Renderer 检查器](../../../../scripts/architecture/renderer-contracts.js)调整两处：

1. 数组分配身份与元素求值分开。比较接收者身份时保留分配节点和调用环境，不提前展开 spread、扫描元素变更；真正读元素时延续原来的 depth/visited 求值链。这消除了 `sameObject → 数组展开 → helper 参数重求值 → sameObject` 的循环。
2. 参数绑定与执行顺序比较复用同一个唯一调用入口。当数组在外层创建时，也能按 helper 的调用位置区分“先写后重排”和“先重排后写”，避免修好崩溃后将安全样例误判为违规。

新增 [12 项回归](../../../../tests/unit/architecture/release-rereview-r12.test.js)，同时用 VM 核对对象是否相同及额外方法是否存在。覆盖普通 helper、对象参数、解构参数、嵌套 helper、直接重排和旧别名安全对照。没有修改生产业务源码、公共解析器、机器边界或例外配置。

## 验证

| 范围 | 结果与证据 |
| --- | --- |
| 准确修复起点 | 12 项中 **10 FAIL（RangeError）/ 2 PASS**；使用 hash 匹配的旧检查器及最终同一测试文件。[日志](regressions-before-final.log)、[输入](regressions-before-inputs.json) |
| 新增回归 | **12/12 PASS**。[日志](targeted-tests.log) |
| 全部架构单测 | **589/589 PASS**。[日志](architecture-tests-final.log) |
| 原始未捕获探针 | 正常 exit 0；输出 `ARCH-RENDERER-SCOPE`，无异常。[结果](raw-helper.json) |
| 实际 Renderer 配置 | 保留全部 **20 个 active 边界**，8 例均无异常；7 例符合正反预期，1 例既有保守拒绝单列。[结果](actual-array-probe.json)、[进度日志](actual-array-probe.log) |
| 共享解析 / 参数绑定 | **56 + 6** 例与 R12 审查的诊断、scanner 结构及 evidenceId 保持一致。[共享汇总](shared-verification.json)、[绑定结果](bindings-probe.json) |
| 修改的 JS lint | **0 error / 0 warning**。[结果](tool-lint.json) |
| 正式架构 CLI | **31 active、0 pending/partial、0 诊断、0 stale**，来自本次完整门禁内同一 CLI 调用。[日志](architecture-check.log) |
| 完整门禁 | **PASS**：`UNIT_TEST_CONCURRENCY=2 npm run release-check`。[完整日志](release-check.log)、[进程结果](release-check-result.json) |
| 全量单测 / 集成 | **9363 项单测通过、0 失败、4 项 Windows 条件跳过，68/68 集成脚本通过**；Renderer lifecycle 233/233 |
| 候选一致性 | **1709 个门禁输入与 HEAD 未漂移**。[冻结清单](gate-input-manifest.json)、[验证汇总](verification.json) |

完整门禁开始于 **2026-09-23T14:44:29.241195+08:00**，结束于 **2026-09-23T15:05:10.069504+08:00**。本次没有复用上一轮的完整门禁结果。实际配置探针仅追加指定装配，不等于逐一执行 20 个控制器业务。

## 保全与限制

接手时冻结 **4966 个既有文件**，其中 **7 个计划内文件**发生变更：检查器、5 份架构/状态文档，以及门禁自动刷新的集成耗时策略表。其余 **4959 个**保持逐字节一致，包括 **792 个生产源码**和 **986 个历史审查/修复文件**。新增本轮测试与证据。HEAD 未变，未提交、推送、开 PR、升版或发布。[保全核对](preservation-final.json)。

[增量补丁](incremental.patch)相对于本次接手的未提交状态生成，反向适用只读预检与 `git diff --check` 通过。[交付核对](delivery-check.json)、[实施记录](implementation-notes.md)。

“槽位先写入 clean、再覆盖为 old、然后重排”的样例仍被保守拒绝；这是审查已记录的边界，不计作合法通过，也未在本轮扩修为精确数组模拟。此次关闭的是列明的 helper 崩溃及其安全/违规对照，不代表任意 JavaScript 静态解释均完整。真实产品 Main 全流程、GUI、Windows 实机/安装包、Excel/WPS 和资金人工验收未执行，自动门禁不等于整个 release 已验收或可发布。
