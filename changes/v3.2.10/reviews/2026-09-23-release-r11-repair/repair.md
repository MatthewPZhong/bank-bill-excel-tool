# release/v3.2.10 第十一轮审查修复

**RR11-01、RR11-02 已修复，最终冻结候选的完整 `release-check` 通过。** 第十轮原始反例继续由 577 项架构测试覆盖；本轮新增 11 项运行时与静态正反回归。

## 候选和修复

分支 `release/v3.2.10`，HEAD `9a38b96b1b8006c5851535d0c1e586bbaeb63f10` 加此前未提交修复。本轮依据：[第十一轮审查](../2026-09-23-release-rereview-r11/review.md)、[G8 Spec](../../codex/v3.2.10-architecture-guardrails/spec.md) AC-05、[TechDoc](../../codex/v3.2.10-architecture-guardrails/techdoc.md) §4.4。[接手清单](input-manifest.json)和[原 tracked 差异](input-diff.patch)保存起点。

1. [Renderer 检查器](../../../../scripts/architecture/renderer-contracts.js)在 IPC 成员投影时不继承父值的真值/非空证明。`(info || fallback).api` 在 `info` 存在但缺少 `api` 时，重新保留默认对象来源；成员自身的 `||` 或 `??` 仍能证明选中值。
2. 对 `reverse`、`shift`、`splice` 等可见数组重排，检查器在读取某一槽位时，保留重排前同一数组其他固定数字槽位的赋值来源。它继续排除无关数组、重排后才发生的写入，不声称精确模拟动态数组索引。

新增[11 项回归](../../../../tests/unit/architecture/release-rereview-r11.test.js)，同步架构说明、TechDoc、实施记录与 release 状态。生产业务源码、共享 scanner/contracts/rules/schema、机器边界与历史审查材料保持。集成耗时策略表由正式门禁刷新。本轮没有提交、推送、合并、PR、升版、标签或发布。

## 验证结果

| 验证 | 结果 |
| --- | --- |
| 新增回归 | **11/11 PASS**；修复起点 **5 FAIL / 6 PASS**。[起点日志](regressions-before.log)、[最终日志](regressions-current.log) |
| 全部架构测试 | **577/577 PASS**。[日志](architecture-tests.log) |
| 正式架构 CLI | **31 active、0 pending/partial、0 诊断、0 stale**，765/765 文件解析。[JSON](architecture-check.json) |
| 实际配置 | 保留全部 **20 个 active Renderer 边界**；父成员违规 1 条诊断、安全例 0；数组重排违规 1、安全例 0。[成员结果](renderer-member-realconfig.json)、[数组结果](array-neighbor-realconfig.json) |
| 审查邻近探针 | **成员 6/6、数组 8/8** 正反结果符合预期。[成员结果](renderer-member-minimal.jsonl)、[数组结果](array-neighbor-minimal.json) |
| 共享解析重放 | **56/56**，38 个 Renderer 与 18 个 query 用例相对第十一轮审查均无诊断或 scanner 结构漂移。[汇总](shared-verification.json) |
| 两个 JS 文件 lint | 0 error / 0 warning。[JSON](tool-lint.json) |
| 完整门禁 | **PASS**；`UNIT_TEST_CONCURRENCY=2 npm run release-check`，2026-09-23 10:32:54–10:50:35（Asia/Shanghai）。[日志](release-check.log)、[结果](release-check-result.json) |
| 全量单测 | **9351 PASS、0 FAIL、4 项 Windows 条件跳过** |
| 全量集成 | **68/68 个脚本 PASS**；Renderer lifecycle 233/233 |
| 输入一致性 | **1708 个门禁输入和 HEAD 未漂移**。[清单](gate-input-manifest.json)、[汇总](verification.json) |

两个真实配置探针仅在完整边界配置中追加指定装配，未逐一运行 20 个控制器。回归测试同时用 VM 核对别名与注入对象是否相同、额外方法是否可调用。第十一轮独立审查已经复核 6 个参数绑定例；本轮源代码修复后重新执行了 56 个共享解析用例。

## 保全与边界

冻结的 **4866 个既有文件**中，只有 **7 个计划内文件**变化；其中 `rules/integration-test-policy.md` 的耗时计数由门禁刷新。**792 个生产源码和 887 个历史审查/修复文件逐字节保持**，机器配置与共享检查器保持。HEAD 未漂移。[保全核对](preservation-final.json)。

[本轮增量补丁](incremental.patch)相对于本轮接手时的未提交状态生成；反向适用只读预检、`git diff --check` 与文档链接检查通过。[交付核对](delivery-check.json)、[实施记录](implementation-notes.md)。

结论限定于列明的 G8 静态漏报及自动验证。真实产品 Main、Windows 实机/安装包、Excel/WPS 和资金人工验收未执行；自动门禁通过不等于整个 release 可以发布。
