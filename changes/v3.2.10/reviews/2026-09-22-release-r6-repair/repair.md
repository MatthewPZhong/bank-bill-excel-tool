# release/v3.2.10 第六轮审查修复

**第六轮 2 项 P2 已修复，最终完整 release-check 已重新执行并通过。** 本轮是修复与自检，结论限于原始反例、列明静态组合和自动验证；修复后的独立复审及平台/资金人工验收尚未进行。

## 固定对象与变更范围

- 工作区：`/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10`；分支 `release/v3.2.10`，HEAD `9a38b96b1b8006c5851535d0c1e586bbaeb63f10` 加全部既有未提交修复。
- 依据：[第六轮审查](../2026-09-22-release-rereview-r6/review.md)、[G8 Spec](../../codex/v3.2.10-architecture-guardrails/spec.md) AC05/16、[TechDoc](../../codex/v3.2.10-architecture-guardrails/techdoc.md) §4.4 与恢复入口规则，以及 [架构说明](../../../../architecture/README.md)。
- 起点冻结 4348 个既有文件，[SHA-256 清单](input-manifest.json)、[原 tracked 差异](input-diff.patch)。本轮只修改 2 个检查器文件、新增回归和配套文档，保留前五轮修复。
- 生产源码、机器边界和授权例外未改；没有提交、推送、PR、升版、标签或发布。

## 两项发现的修复

### RR6-01：参数解构读取调用时点的成员

[renderer-contracts.js](../../../../scripts/architecture/renderer-contracts.js) 对工厂及 bound 实参先保留对象身份，再以调用 AST 位置应用现有成员快照；返回和实际使用处检查完整能力。对象参数、改名、嵌套、固定 computed 键、已提供默认参数、helper 转发、静态数组参数均复用该选择规则。

`envelope.api` 已替换时，解构得到的新别名现在追踪新对象；对该别名的越权写入被拒绝。替换前捕获的旧别名保持分离，直接注入该旧别名也保留正确能力集合；同一工厂的不同调用实例继续隔离。已重赋值的参数不绕过既有候选分析。

原脚本在实际全部 **20 个 Renderer boundary** 下：基线 0 诊断，原越权例 **1 条 ARCH-RENDERER-SCOPE**，旧别名安全例 **0 诊断**；VM 分别确认真正注入的 API 有/无额外可调用方法。[实际配置与 VM 结果](renderer-realconfig.json)、[原脚本](../2026-09-22-release-rereview-r6/evidence/r6-renderer-parameter-realconfig.cjs)。

### RR6-02：间接改写后取消原生比较语义

[contracts.js](../../../../scripts/architecture/contracts.js) 的来源解析保留参数 selector、成员链、静态容器及有限 helper 返回投影。数组成员、Array.prototype 经对象/解构/原型参数改写，或包在对象中传给未知 helper 后，不再清空恢复回调目标。未知候选不能抹掉已知可能的数组/原型来源；合法比较要求所有接收者来源均可证明。

helper 返回来源使用调用局部参数环境，不把全仓无关实参加入执行闭包；完整根查询按参数闭包 revision 缓存，递归和局部上下文不共用结果。返回容器保留参数来源，继续检查内部能力逃逸。未改变受限函数配置、allowedSites 或历史例外。

原 G1 **8 项** VM 对照中，对象参数、解构参数、原型参数和直接改写均为恢复 stub 执行 **1 次 / 1 条入口诊断**；原生 includes/lastIndexOf 和纯比较 helper 为 **0 次 / 0 诊断**。[结果](g1-neighbors.json)、[原脚本](../2026-09-22-release-rereview-r6/evidence/r6-g1-neighbor-probe.cjs)。

完整生产源码临时副本 **765/765** 解析：prepare 内 helper 改写例和真正 reduce 各产生 **1 条 ARCH-PUBLICATION-RECOVERY-ENTRY**，原生 includes **0 诊断且无恢复回调目标**。[间接改写](g1-real-source.json)、[原生比较](g1-native-real-source.json)、[reduce](g1-reduce-real-source.json)。这三份突变只使用实际 active G1 边界静态扫描，不执行真实恢复 IO，也不作为全部 31 边界突变证明。

## 最终验证

| 验证 | 结果及证据 |
| --- | --- |
| 新增回归 | **40 项**；起点检查器 **23 FAIL / 17 PASS**，修复后全 PASS。[起点工具哈希](regressions-before-inputs.json)、[before 日志](regressions-before-final.log)、[测试代码](../../../../tests/unit/architecture/release-rereview-r6.test.js) |
| RR2–RR6 | **186/186 PASS**，包含新增 40 项，非额外累加。[日志](regressions-after.log) |
| 全部架构 | **356/356 PASS**，0 fail/skip。[日志](architecture-tests.log) |
| 正式架构 CLI | **31 active、0 pending/partial、0 诊断、0 stale**；765/765 解析，2 个已登记 generated unresolved、33 个动态位置继续按既有合同记录。[JSON](architecture-check.json)、[日志](architecture-cli.log) |
| 共享数据与查询 | **28 项**正反例符合预期，含内存 SQLite SQL 执行；scanner 序列化、重复扫描及 evidenceId 前后保持。[20 项](shared-data-query.json)、[8 项](shared-destructure.json)、[旁表隔离](descriptor-isolation.json) |
| 检查器和新测试 lint | 3 个文件 0 错误/告警。[结果](tool-lint.json) |
| 完整门禁 | **PASS**，`UNIT_TEST_CONCURRENCY=2 npm run release-check`；2026-09-22 15:19:39–15:38:20（Asia/Shanghai）；在沙箱外使用项目既有隔离测试环境。[完整日志](release-check.log)、[结果](release-check-result.json) |
| 全量单测 | **9130 PASS、0 FAIL、4 项 Windows 条件跳过**；9134 total、828 suites。 |
| 全量集成 | **68/68 脚本 PASS**；有计数用例 2901/2901，另 1 个脚本无计数；Renderer lifecycle 233/233。 |
| 输入一致性 | **1703 个门禁输入及 HEAD 未漂移**。[门禁清单](gate-input-manifest.json)、[验证汇总](verification.json) |

原探针 exit 0 只代表取证完成，结果由[显式断言脚本](verify-probes.py)逐项检查，见[探针汇总](probe-verification.json)。共享探针内 beforeR5 为历史第五轮修复起点；本轮修复起点由独立的 [run-baseline.py](run-baseline.py)及文件哈希固定，不混用两个 before。

初稿暴露的安全旧别名误报、bound helper 候选丢失和全仓扫描开销均在最终验证前处理；中间日志和被停止的扫描不计入 PASS。[实施记录](implementation-notes.md)、[中间命令记录](command-errors.json)。

## 保护、增量与剩余边界

- 起点 4348 个既有文件仅 8 个计划内文件变化；792 个生产 src、374 个历史审查/修复证据、2 份机器 JSON 及主工作区 865 个已有 dirty 文件全部保持。[保护核对](preservation-final.json)。
- [本轮增量补丁](incremental.patch)相对于起始 dirty 状态生成；反向应用只读预检、git diff --check 和文档链接检查通过。[交付核对](delivery-check.json)。生产源码与 scanner 旁表实现保持本轮起点字节。
- 已覆盖参数形态、成员替换前后、不同实例、真正回调与纯函数值比较、间接数组/原型改写和未知 helper 容器逃逸；不宣称任意动态循环、重复调用、反射、跨文件共享对象时序或所有原生 API 的完整静态证明。
- 修复后的独立复审、真实产品 Main 全流程、Windows/安装包、Excel/WPS 与资金人工验收未执行。自动门禁 PASS 不等于正式可发布结论。
