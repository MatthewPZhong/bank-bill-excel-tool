# release/v3.2.10 第十三轮审查修复

**RR13-01 已修复；最终候选的完整 `release-check` 已重新运行并通过。** 条件 helper 未执行时的旧成员来源得到保留，原始反例产生 `ARCH-RENDERER-SCOPE` 诊断；无条件替换和提前捕获别名的安全对照继续通过。

## 修复与候选

分支 `release/v3.2.10`，HEAD `9a38b96b1b8006c5851535d0c1e586bbaeb63f10` 加既有未提交修复。[第十三轮审查](../2026-09-28-release-rereview-r13/review.md)与 [G8 Spec](../../codex/v3.2.10-architecture-guardrails/spec.md) AC-05 为本次依据；[TechDoc](../../codex/v3.2.10-architecture-guardrails/techdoc.md) §4.4 已同步。

[Renderer 检查器](../../../../scripts/architecture/renderer-contracts.js)保留 RR12 的数组延迟求值和调用位置解析，调整成员替换判断：

1. 沿写入到读取的调用链核对条件性。if/else、三元、短路、可零次执行的循环或 catch 中的 helper 写入不再因“唯一调用位置”被认作确定发生；未执行路径仍保留旧来源。
2. 区分可能跳过的语句与必执行位置。读写共有的已进入分支、条件测试、for 初始化和迭代源、逻辑左侧、do 首轮及可证明选中的字面量分支保持精度。
3. 后续确定覆盖仅在可证明晚于先前写入时清除旧候选；不能排序的写入继续合并。避免把条件性永久附在对象上，误拒绝后续已经确定替换的合法代码。

新增 [32 项回归](../../../../tests/unit/architecture/release-rereview-r13.test.js)，每项同时用 VM 检查 false/true 两种输入和静态诊断。覆盖嵌套 helper、工厂调用帧、数组固定槽位及各项安全对照。公共 scan/contracts/rules/schema、机器边界及生产业务源码保持。

## 验证

| 范围 | 结果与证据 |
| --- | --- |
| 准确修复起点 | 最终同一 32 项测试：**16 FAIL / 16 PASS**；使用 hash 匹配的旧检查器。[日志](regressions-before-final.log)、[输入](regressions-before-inputs.json) |
| 新增回归 | **32/32 PASS**。[日志](targeted-tests.log) |
| 全部架构单测 | **621/621 PASS**。[日志](architecture-tests-final.log) |
| 实际 Renderer 配置 | 保留全部 **20 个 active 边界**，原条件反例 1 条 scope 诊断，安全对照 0 条，基线 0 条，无扫描异常。[结果](conditional-realconfig.json) |
| RR12 数组回放 | **14 例无异常**：7 个违规正确拒绝、6 个安全通过、1 个既有保守拒绝单列。[原数组](array-original.json)、[对象/解构/嵌套 helper](array-finite.json) |
| 共享解析 / 参数绑定 | **56 + 6** 例与 R13 审查的诊断、scanner 结构及 evidenceId 保持一致。[共享汇总](shared-verification.json)、[绑定结果](bindings-probe.json) |
| 修改的 JS lint | **0 error / 0 warning**。[结果](tool-lint.json) |
| 正式架构 CLI | **31 active、0 pending/partial、0 诊断、0 stale**；来自本次完整门禁内同一 CLI 调用。[日志](architecture-check.log) |
| 完整门禁 | **PASS**：`UNIT_TEST_CONCURRENCY=2 npm run release-check`。[完整日志](release-check.log)、[进程结果](release-check-result.json) |
| 全量单测 / 集成 | **9395 项单测通过、0 失败、4 项 Windows 条件跳过，68/68 集成脚本通过**；Renderer lifecycle 233/233 |
| 候选一致性 | **1710 个门禁输入与 HEAD 未漂移**。[冻结清单](gate-input-manifest.json)、[验证汇总](verification.json) |

完整门禁开始于 **2026-09-28T16:33:19.646795+08:00**，结束于 **2026-09-28T16:50:50.044266+08:00**。本轮重新执行了完整门禁。实际配置实验只追加指定装配，不等于逐一执行 20 个控制器业务。中间候选结果已保留在 preliminary 目录，最终结论仅使用表内列出的最终输入与结果。

## 保全与限制

接手时冻结 **5074 个既有文件**，其中 **7 个计划内文件**变化：检查器、5 份架构/状态文档，以及门禁自动刷新的集成耗时策略表。其余 **5067 个**逐字节保持，包括 **792 个生产源码**和 **1093 个历史审查/修复文件**。新增本轮测试与证据。HEAD 未变，未提交、推送、开 PR、升版或发布。[保全核对](preservation-final.json)。

[增量补丁](incremental.patch)相对于本次接手的未提交状态生成，反向适用只读预检与 `git diff --check` 通过。[交付核对](delivery-check.json)、[实施记录](implementation-notes.md)。

本轮的 `blindspot-pass` 聚焦写入条件与执行顺序，并将发现的必执行位置及后续确定覆盖问题纳入回归；列明范围内没有尚未处理的确认缺陷。既有“槽位先覆盖再重排”和不同纯字符串候选的保守拒绝继续保留，不计作合法通过。此次不声明任意 JavaScript 控制流、异常路径或整个 G8 的完备性。真实产品 Main 全流程、GUI、Windows 实机/安装包、Excel/WPS 和资金人工验收未执行，自动门禁不等于整个 release 已验收或可发布。
