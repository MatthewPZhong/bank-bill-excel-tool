# release/v3.2.10 第九轮审查修复

**RR9-01、RR9-02 已修复，最终完整 release-check 重新执行并通过。** 原始 AND 默认对象越权、push/splice 静态 spread 越权均被拒绝，真值及旧别名安全例继续通过。关闭范围为本报告列明反例与自动验证，不等于所有 G8 合同或正式发布验收完成。

## 候选与改动

工作区 `/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10`，分支 `release/v3.2.10`，HEAD `9a38b96b1b8006c5851535d0c1e586bbaeb63f10` 加已有未提交修复。依据：[第九轮审查](../2026-09-22-release-rereview-r9/review.md)、[G8 Spec](../../codex/v3.2.10-architecture-guardrails/spec.md) G8-AC-05、[TechDoc](../../codex/v3.2.10-architecture-guardrails/techdoc.md) §4.4。冻结 4607 个既有文件，[输入清单](input-manifest.json)与[原 tracked 差异](input-diff.patch)保留起点。

本轮修改 [renderer-contracts.js](../../../../scripts/architecture/renderer-contracts.js)，新增 [50 项回归](../../../../tests/unit/architecture/release-rereview-r9.test.js)，同步架构说明、TechDoc、实施记录及 release 状态；集成策略计数由完整门禁刷新。生产 src、共享 scanner/contracts/rules/schema、机器边界及例外 JSON、旧审查材料保持。没有提交、推送、合并、PR、升版、标签或发布。

## 修复行为

1. **RR9-01：保留 AND 返回来源。** 确定假值返回左侧，确定真值返回右侧，未知 IPC 字段保留两个来源。后续默认参数可以继续取得 shared 身份，别名越权写入不再消失。登记的 Preload 对象能证明真实 Position 装配的 API 守卫为真；完整 API 本身仍禁止注入，没有增加授权白名单。
2. **RR9-02：按 spread 展开时点保留插入来源。** 字面量/具名/工厂返回数组、嵌套 spread、固定槽位替换、可见扩容及源数组已有 mutator 写入纳入来源候选。初始空数组也检查后续插入对象。未知结果保留不确定性及可见来源，不假装精确模拟所有 mutator 索引；替换前捕获的旧对象与独立实例继续分离。

## 原始反例与安全对照

保留真实 Renderer AST、全部 **20 个 active Renderer boundary**，基线 **0 诊断**。具体向 BankStatement 增加装配，不表示逐一执行全部 20 个工厂。

| 场景 | 修复起点 | 修复后 | VM |
| --- | --- | --- | --- |
| IPC 缺失字段经 AND 触发 shared 默认值 | 0 诊断 | 1 条诊断 | shared 含可调用 outsideScope |
| true AND 显式另一个对象 | 0 诊断 | 0 诊断 | shared 没有额外方法 |
| push 静态 spread 插入对象 | 0 诊断 | 1 条诊断 | current API 含额外方法 |
| splice 静态 spread 插入对象 | 0 诊断 | 1 条诊断 | current API 含额外方法 |
| 直接 push 的违规对照 | 1 条诊断 | 1 条诊断 | current API 含额外方法 |
| spread 复制后替换源槽位的安全对照 | 0 诊断 | 0 诊断 | current API 保持独立 |

修复起点的原配置结果来自只读 R9 审查归档；新增 50 项测试另用字节匹配的本轮起点检查器运行。[逻辑结果](r9-renderer-logical-realconfig.json)、[数组结果](r9-array-selected-real.json)、[显式断言](verify-probes.py)、[探针汇总](probe-verification.json)。

## 最终验证

| 验证 | 结果与证据 |
| --- | --- |
| 新增回归 | **50/50 PASS**；起点 **27 FAIL / 23 PASS**。[before 哈希](regressions-before-inputs.json)、[before 日志](regressions-before-final.log)、[当前日志](regressions-current.log) |
| 全部架构测试 | **482/482 PASS**，包含新增 50 项。[日志](architecture-tests.log) |
| 正式架构 CLI | **31 active、0 pending/partial、0 诊断、0 stale**，765/765 文件解析。[JSON](architecture-check.json)、[日志](architecture-check.log) |
| 共享解析 | **50/50** 预期保持：32 Renderer、18 query，10 次内存 SQLite 查询；重复扫描、规则执行前后 scanner JSON 和 evidenceId 保持。[汇总](shared-archive-verification.json)、[断言](verify-shared.py) |
| 新增/修改 JS lint | **2 个文件 0 error / 0 warning**。[结果](tool-lint.json) |
| 完整门禁 | **PASS**；`UNIT_TEST_CONCURRENCY=2 npm run release-check`；2026-09-22 19:41:10–20:00:20（Asia/Shanghai），沙箱外隔离测试环境。[日志](release-check.log)、[结果](release-check-result.json) |
| 全量单测 | **9256 PASS、0 FAIL、4 项 Windows 条件跳过**；9260 total、828 suites。 |
| 全量集成 | **68/68 脚本 PASS**；有计数项 2901/2901，另 1 个脚本无计数；Renderer lifecycle 233/233。 |
| 候选一致性 | **1706 个门禁输入及 HEAD 未漂移**。[冻结清单](gate-input-manifest.json)、[验证汇总](verification.json) |

共享探针沿用 R9 对旧同步 invoke stub 的纠正：未 await 就读取 Promise 字段，会触发 other 默认频道；异步 VM 确认 app:get-info → other，当前拒绝正确。所有 beforeR9 指本轮修复起点，不混用 R8 修复前版本，历史文档保持原样。

初版全量检查曾发现 Position API 守卫的误报，已使用 Preload 对象证据修正；[初版失败日志](preliminary-architecture-tests.log)保留，最终验证均在修正后完成。初版未完成的正式 CLI 主动停止，其日志不作为 PASS 证据。完整门禁只在最终冻结候选上执行一次。

## 保守范围与工作区保护

`select(info.api && {})` 的对象实参组合在修复前后均因未知 helper 逃逸保守拒绝，已单独保留测试。未声明形状的 IPC 字段仍不能证明非 undefined；mutator 结果位置、动态长度、未知 helper/反射、跨文件对象时序不属于本轮精确解释承诺。[实施记录](implementation-notes.md)记载取证和决定。没有把这些有限验证扩展为默认值、数组语义或 G8 全部合同闭环。

4607 个既有文件仅 7 个计划内文件变化；**792 个生产源码、630 个历史审查/修复文件、2 份机器 JSON 和主工作区 865 个 dirty 文件保持原字节**。HEAD 均未漂移。[保护核对](preservation-final.json)。

[本轮增量补丁](incremental.patch)相对于本轮起始 dirty 状态生成，反向应用只读预检、git diff --check 和文档链接检查通过。[交付核对](delivery-check.json)。

本轮为修复自检。修复后独立复审、真实产品 Main 全流程、Windows/安装包、Excel/WPS 和资金人工验收未执行；自动门禁通过不等于正式可发布。
