# release/v3.2.10 第十轮审查修复

**RR10-01、RR10-02 已修复，最终冻结候选的完整 release-check 已重跑通过。** 嵌套 AND/OR/nullish 的合法 scoped API 注入不再被误报，工厂内部扩容数组经 spread 传播的同对象越权写入能够拒绝。相邻验证发现的参数同名覆盖和私有候选合并问题也已修正并纳入回归。关闭范围为下列反例与验证，不代表全部 G8 合同或正式发布验收完成。

## 候选与改动

工作区 `/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10`，分支 `release/v3.2.10`，HEAD `9a38b96b1b8006c5851535d0c1e586bbaeb63f10` 加已有未提交修复。依据：[第十轮审查](../2026-09-22-release-rereview-r10/review.md)、[G8 Spec](../../codex/v3.2.10-architecture-guardrails/spec.md) G8-AC-05、[TechDoc](../../codex/v3.2.10-architecture-guardrails/techdoc.md) §4.4。[起点清单](input-manifest.json)冻结 4710 个既有文件，[原 tracked 差异](input-diff.patch)保留已有工作。

本轮修改 [renderer-contracts.js](../../../../scripts/architecture/renderer-contracts.js)，新增 [84 项回归](../../../../tests/unit/architecture/release-rereview-r10.test.js)，同步架构说明、TechDoc、实施记录和 release 状态；集成策略计数由完整门禁刷新。最终检查器 SHA-256 为 `dd34f594f57d0d5d6f33944bed80802d50b4712077e9f4dba1f205d93b19dbb7`。生产 src、共享 scanner/contracts/rules/schema/policy-history、机器配置与旧审查材料保持。没有提交、推送、合并、PR、升版、标签或发布。

## 修复行为与原始问题

1. **RR10-01：按逻辑运算符保留真实可能返回的来源。** `&&`、`||`、`??` 统一处理确定真/假、null/undefined 和未知值。`(undefined && provided) || provided` 及 nullish 形式排除不会返回的 undefined，不再错误触发 shared 默认对象。未知候选只在相应返回分支携带真值或非空证明；能实际触发 shared 默认值的情况仍拒绝越权写入。
2. **RR10-02：在工厂调用环境中读取数组扩容来源。** 固定槽位、push/unshift/splice 及 helper 写入使用数组的 origin 环境，外层读取仍保留调用时点。空数组的内部写入和普通 literal spread 保留可见对象身份；无法证明索引位置时保留不确定性，避免虚构精确数组语义。不同调用实例、旧别名和无关接收者仍分离。
3. **相邻检查：声明归属与候选合并。** 私有参数绑定按声明函数与参数名保存，内层同名实参不再覆盖闭包捕获值；独立复核的 6 个正反例均纳入正式回归。结构相同候选合并时，数组来源取并集，真值/非空证明只保留所有候选共有的事实，新增 4 例覆盖第二分支来源和同一 IPC 候选默认值。

保留真实 Renderer AST 与全部 **20 个 active Renderer boundary** 的 6 个场景，生产基线 0 诊断。其中 2 个逻辑场景验证合法 OR 组合及违规默认来源，4 个数组场景验证固定槽位、push、违规对照和旧别名安全对照；这是在完整 Renderer 配置中的指定装配探针，不等同于逐一运行 20 个控制器。最小配置另验证 8 个逻辑与 7 个数组场景；VM 对照验证实际对象身份与 `outsideScope` 可调用性。

[真实 AST 逻辑结果](r10-renderer-nested-realconfig-current.json)、[真实 AST 数组结果](r10-array-real-neighbor-current.json)、[探针断言](verify-probes.py)与[汇总](probe-verification.json)保留准确起点和最终结果。上述原始反例探针的 before 指本轮 `input-manifest.json` 中的检查器；没有用更早修复前版本代替本轮起点。

## 最终验证

| 验证 | 结果与证据 |
| --- | --- |
| 新增回归 | **84/84 PASS**；准确起点 **38 FAIL / 46 PASS**。[before 输入哈希](regressions-before-inputs.json)、[before 日志](regressions-before-final.log)、[最终日志](regressions-final.log) |
| 全部架构测试 | **566/566 PASS**，含新增 84 项。[日志](architecture-tests.log) |
| 正式架构 CLI | **31 active、0 pending/partial、0 诊断、0 stale**，765/765 文件解析。[JSON](architecture-check.json)、[日志](architecture-check.log) |
| 共享解析 | **56/56** 预期保持：38 Renderer、18 query，10 个用例执行内存 SQLite 查询；重复扫描、规则前后 scanner 结果及 evidenceId 保持。[汇总](shared-archive-verification.json)、[断言](verify-shared.py) |
| 相邻独立复核 | **6/6**，3 个安全例 0 诊断、3 个越权例各 1 条 scope；使用最终检查器哈希。[报告](r10-adjacent-review/review.md)、[结果](r10-adjacent-review/results.json) |
| 修改/新增 JS lint | **2 个文件 0 error / 0 warning**。[结果](tool-lint.json) |
| 完整门禁 | **PASS**；`UNIT_TEST_CONCURRENCY=2 npm run release-check`；2026-09-23 02:53:40–03:14:31（Asia/Shanghai），沙箱外隔离测试环境。[日志](release-check.log)、[结果](release-check-result.json) |
| 全量单测 | **9340 PASS、0 FAIL、4 项 Windows 条件跳过**；9344 total、828 suites。 |
| 全量集成 | **68/68 脚本 PASS**；有计数项 2901/2901，无计数脚本 1 个；Renderer lifecycle 233/233。 |
| 候选一致性 | **1707 个门禁输入及 HEAD 未漂移**。[冻结清单](gate-input-manifest.json)、[验证汇总](verification.json) |

56 个共享用例中的已知保守拒绝单独记录，没有计作合法放行；IPC Promise/await 的预期沿用第九轮纠正。共享 checker 与政策 SHA-256 在修复起点和当前保持一致。

初补丁的相邻复核发现闭包同名参数的新增误报与既有漏报，已按声明归属修正。最终自检又复现候选合并丢失第二分支数组来源，并补齐同一 IPC 候选的默认来源对照；这一自检的 [before](uncertainty-merge-before.json) 特指本轮中间补丁，[after](uncertainty-merge-after.json) 对应最终 SHA，不能混作本轮接手基线。为修复这些已确认问题，**较早启动的完整门禁主动 SIGTERM 终止，exit -15，不作为 PASS 证据**：[中止结果](preliminary-release-check-result.json)、[中止日志](preliminary-release-check.log)、[当时输入](preliminary-gate-input-manifest.json)。本报告的完整 PASS 来自最终源码冻结后的重新执行；名称带 preliminary 的其他材料也不作为最终通过证据。

## 边界与工作区保护

4710 个既有文件仅 **7 个计划内文件变化**；**792 个生产源码、732 个历史审查/修复文件、2 份机器 JSON，以及主工作区 865 个 dirty 文件保持原字节**。两个工作区 HEAD 未漂移。[保护核对](preservation-final.json)。新增回归文件与本轮证据单独交付，原 renderer-contracts.js 在接手时已为未跟踪文件，未将它误记作本轮新建。

[本轮增量补丁](incremental.patch)相对于本轮起始 dirty 状态生成；反向适用只读预检、git diff --check 和文档链接检查通过。[交付核对](delivery-check.json)、[实施记录](implementation-notes.md)。

本轮包括修复自检和上述有限的独立相邻复核，没有进行覆盖全部 G8 合同的修复后独立审查。跨文件对象时序、动态反射及精确 mutator 索引仍未完整建模，既有保守拒绝不等同于业务不合法。真实产品 Main 全流程、Windows/安装包、Excel/WPS 和资金人工验收未执行；自动门禁通过不等于正式可发布。
