# release/v3.2.10 第五轮审查修复

**第五轮 2 项 P2 已修复，最终完整 release-check 已重新执行并通过。** 本轮是修复与自检，结论限定于原始反例、列明静态组合和自动验证，不替代独立复审或平台/资金人工验收。

## 固定对象与变更范围

- 工作区：`/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10`；分支 `release/v3.2.10`，HEAD `9a38b96b1b8006c5851535d0c1e586bbaeb63f10` 加全部既有未提交修复。
- 依据：[第五轮审查](../2026-09-22-release-rereview-r5/review.md)、[G8 Spec](../../codex/v3.2.10-architecture-guardrails/spec.md) G8-AC-05/16、[TechDoc](../../codex/v3.2.10-architecture-guardrails/techdoc.md) §4.4 及 [架构说明](../../../../architecture/README.md)。
- 起点冻结 4268 个既有文件，[SHA-256 清单](input-manifest.json)、[原 tracked 差异](input-diff.patch)；本轮仅修改 3 个检查器文件、回归和配套文档，保留前四轮修复。
- 生产源码、机器边界和授权例外未改变。没有提交、推送、PR、升版、标签或发布。

## 两项发现的修复

### RR5-01：静态成员替换后保留正确对象身份

[scan.js](../../../../scripts/architecture/scan.js) 用 analysis 私有旁表保留成员读取/解构的接收者、键及读取位置，不改变通用扫描结果和 JSON 指纹。[renderer-contracts.js](../../../../scripts/architecture/renderer-contracts.js) 在身份解析时应用读取前已完成的成员替换，再按选中对象的身份检查后续写入和 helper 逃逸。

替换前捕获的旧别名保持旧身份；替换后获得的别名、computed 固定键、嵌套/绑定工厂、父对象别名、浅拷贝共享成员均追踪新对象。工厂内部写入使用真实静态调用帧排序，函数声明的文本位置不冒充执行顺序；条件来源保留可能身份。真实共享对象继续检查，不同实例继续隔离。

原脚本在当前全部 **20 个 Renderer boundary** 下：基线 0 诊断，越权替换例产生 1 条 `ARCH-RENDERER-SCOPE`（outsideScope）；分离旧别名安全例 0 诊断。VM 分别确认真实 API 有/无额外可调用方法。[实际配置与 VM 结果](renderer-realconfig-final.json)、[原复现脚本](../2026-09-22-release-rereview-r5/evidence/r5-renderer-replacement-realconfig.cjs)。

### RR5-02：区分原生函数值比较与恢复执行

[contracts.js](../../../../scripts/architecture/contracts.js) 仅在接收者可解释为静态数组，且方法未被自有成员/Array.prototype 改写、未向未知 helper 逃逸时，将 includes/indexOf/lastIndexOf 的函数实参识别为比较值，不加入执行闭包。别名、静态 computed、call 形式与已解释 helper 参数有合法对照。

不按方法拼写放行：自定义 includes、直接/别名/helper/原型改写及未知 receiver 继续受检。reduce/forEach 等真正执行回调保持受限入口检查；函数型 reduce 累加值若被 reducer 调用也继续拒绝。未新增 allowedSites 或放宽机器边界。

原 VM 探针中 includes/indexOf 和源码比较 helper 均 0 次恢复调用、0 诊断；reduce 为 1 次 stub 调用、1 条入口诊断。[结果](g1-data-after.json)。完整生产源码临时副本 765/765 解析，真实 prepare 中 includes 0 诊断且没有 recovery callback target；reduce 仍在 prepare 处产生 1 条 `ARCH-PUBLICATION-RECOVERY-ENTRY`。[includes 实际源码扫描](g1-real-source-final.json)、[reduce 实际源码扫描](g1-reduce-real-source-final.json)。这两项源码突变仅使用实际 active G1 边界做静态扫描，未执行真实恢复 IO，不作为全 31 边界突变证明。

## 最终验证

| 验证 | 结果及证据 |
| --- | --- |
| 新增回归 | **46 项**；原检查器 **23 FAIL / 23 PASS**，修复后全 PASS。[起点工具哈希](regressions-before-inputs.json)、[before 日志](regressions-before-final.log)、[回归代码](../../../../tests/unit/architecture/release-rereview-r5.test.js) |
| RR2–RR5 | **146/146 PASS**，包含上述 46 项，非额外累加。[日志](regressions-after.log) |
| 全部架构 | **316/316 PASS**，0 fail/skip。[日志](architecture-tests.log) |
| 正式架构 CLI | **31 active、0 pending/partial、0 诊断、0 stale**，765/765 解析；2 个已登记 generated unresolved 和 33 个动态位置按既有合同记录。[报告](architecture-check.json)、[日志](architecture-cli.log) |
| 共享数据与查询 | 原 20 项正反例前后保持预期，含真实内存 SQLite 查询。原脚本中的 before 为 R4 修复起点字节，current 为当前修复；未把这组小夹具计作全仓证明。[结果](shared-data-probes-final.json)、[逐项断言](probe-verification.json) |
| 检查器/新测试 lint | 4 个文件 no-undef，0 错误/告警。[结果](tool-lint.json) |
| 完整门禁 | **PASS**，`UNIT_TEST_CONCURRENCY=2 npm run release-check`；2026-09-22 14:01:31–14:19:51（Asia/Shanghai）。本轮在沙箱外运行，使用既有隔离测试环境。[日志](release-check.log)、[结果](release-check-result.json) |
| 全量单测 | **9090 PASS、0 FAIL、4 项 Windows 条件跳过**；9094 total、828 suites。 |
| 全量集成 | **68/68 脚本 PASS**；有计数用例 2901/2901，另 1 个脚本无用例计数；Renderer lifecycle 233/233。 |
| 输入一致性 | **1702 个门禁输入及 HEAD 前后未漂移**；[门禁清单](gate-input-manifest.json)、[验证汇总](verification.json)。 |

原探针 exit 0 只表示取证完成；结果另作显式断言。原始文件均未修改。初稿曾在扫描确定性、参数投影及扩展时序对照上失败，已修复并重跑最终套件；中间日志不计入 PASS。两个只读命令路径错误已纠正，[命令记录](command-errors.json)。

## 保护、增量与剩余边界

- 起点 4268 个已有文件仅 9 个计划内文件变化；792 个生产 src、295 个历史审查/修复证据、2 份机器 JSON 和主工作区 865 个已有 dirty 文件全部保持。新增本轮测试及证据。[最终保护](preservation-final.json)。
- [本轮增量补丁](incremental.patch) 相对于起始 dirty 状态生成，保留既有修复；反向应用只读预检与 git diff --check 通过。[交付核对](delivery-check.json)。
- [实施记录](implementation-notes.md)说明身份/时序模型及原生方法边界；没有宣称任意 JavaScript 反射、动态重复调用、动态循环、跨文件共享对象时序或所有原生 API 的完整执行语义。其他未建模 API 继续使用既有保守策略。
- 尚未做修复后的独立复审、真实产品 Main 全流程、Windows/安装包、Excel/WPS 或资金人工验收；自动门禁通过不等于正式可发布结论。
