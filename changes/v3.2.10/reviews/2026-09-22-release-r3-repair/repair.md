# v3.2.10 第三轮 G8 审查修复

依据：[第三轮独立审查](../2026-09-22-release-rereview-r3/review.md)。RR3-01～05 的确认反例已修复；额外补齐本轮原始探针中本地工厂返回对象后的别名写入。新增 33 项回归与上轮 34 项合计 67/67 PASS，架构专项 237/237 PASS；完整 release-check 已在最终冻结的 1700 个输入上重新运行并通过：9011 项单测通过、4 项 Windows 条件跳过、68/68 集成脚本通过。本报告为修复记录和自检，不代替修复后的独立复审。

## 输入与变更范围

- 工作区 `tmp/worktrees/release-v3.2.10`，分支 `release/v3.2.10`，HEAD `9a38b96b1b8006c5851535d0c1e586bbaeb63f10` 加原有未提交修复。
- 开始前冻结 4106 个已有文件，[SHA-256 清单](input-manifest.json)和[原有 tracked diff](input-diff.patch)保留。计划修改的 4 个检查器和说明/清单共 10 个文件另存 before/ 字节副本，便于审核本轮增量。
- 本轮生产 `src/`、机器 `boundaries.json`、例外清单、schema、policyChanges 和准确 allowedSites 保持；没有放宽配置或新增例外。
- 修复只涉及检查器、回归及说明；没有提交、推送、PR、升版、标签或发布。原有三轮审查和前两轮修复证据保持。

## 逐项处置

| 项目 | 修复与边界 | 验证 |
| --- | --- | --- |
| RR3-01 未知数组 spread 的位置误判 | 未知长度使整个数组位置不确定，保留 opaque 标记；不能把 spread 伪造成一个元素。受保护索引/解构回调和 apply 实参无法解释时报告 coverage；已知静态数组仍精确选择。 | 参数、工厂、嵌套 spread、解构、apply 的 5 条真实 SQLite 反例被拒绝；已知数组危险/安全对照分别拒绝/通过。完整 31 边界实际配置下原反例从 0 诊断变为 coverage。 |
| RR3-02 嵌套对象跳过变更检查 | 判断依据包含 objectStart，不再要求必须有 chain；已构造对象的成员/别名写入和 helper 逃逸进入核验。字面量直接在实参位置创建单独处理，保留现有工厂装配。 | 5 种嵌套变更/逃逸的 VM 反例均实际获得额外方法并被拒绝，安全嵌套、字面量、freeze/keys 及 spread 对照通过。 |
| RR3-02 相邻的工厂返回别名 | 本轮探针仍显示同文件工厂返回对象后别名写入漏报，故继续沿已解释返回表达式追踪 AST 对象身份。 | 工厂返回后别名写入与 Object.assign 的 VM 反例均被拒绝，无修改的工厂返回通过。 |
| RR3-03 特殊自有键丢失 | scanner、Renderer 和合成模块导出的属性字典使用 Object.create(null)，保留 computed 自有 __proto__。真实 prototype setter 单独解释：明确 null 合法，其他来源保守拒绝。 | 自有键、嵌套、spread、prototype setter、scoped 未授权特殊方法均拒绝；VM 验证普通自有属性真实持有 API、并未污染原型；纯数据特殊键与 null prototype 保持通过。 |
| RR3-04 数据合同层级错误 | 在真实 config.initialBillCategory 叶路径执行递归纯数据/app:get-info 来源约束，先于通用 config 可调用能力许可。 | 实际 ReconID 配置下函数、嵌套能力、完整 API 和其他 IPC 均拒绝；分类字符串及 app:get-info 字段合法。 |
| RR3-05 恢复能力经 helper 丢失 | G1 复用实际调用闭包，代入静态数组、参数、返回值和跨文件 helper，按最终函数的文件/AST 身份匹配已登记恢复能力。准确授权位置是闭包停止点，不扩展 prepare 许可。 | 新增 6 类静态透传与合法未调用成员/同名普通函数对照；原报告 12 种调用形式全部拒绝，完整实际生产配置保持通过。 |

实现：[scan.js](../../../../scripts/architecture/scan.js)、[renderer-contracts.js](../../../../scripts/architecture/renderer-contracts.js)、[contracts.js](../../../../scripts/architecture/contracts.js)、[rules.js](../../../../scripts/architecture/rules.js)。回归：[release-rereview-r3.test.js](../../../../tests/unit/architecture/release-rereview-r3.test.js)。

## 验证证据

| 验证 | 当前结果 |
| --- | --- |
| 最终 33 项回归在修复前版本上运行 | 7 PASS / 26 FAIL；使用 before/ 检查器字节副本，逐文件匹配起始 SHA，临时仓库内运行最终测试。[日志](regressions-before-final.log) |
| 第三轮 33 项 + 第二轮 34 项 | 67/67 PASS，0 fail/skip；[日志](regressions-after.log) |
| 全部架构专项 | 237/237 PASS；最终完整门禁包含同一套件并全部通过。[专项日志](architecture-tests.log)、[完整日志](release-check.log) |
| 正式架构 CLI | 31 active、0 pending/partial、0 诊断、0 stale；解析 765/765 文件。最终完整门禁再次通过。[专项日志](architecture-cli.log)、[完整日志](release-check.log) |
| 检查器和新测试 no-undef | 5 个文件 0 errors/warnings；[结果](tool-lint.json) |
| 原始探针 | 脚本原样重跑，仅输出到本轮目录；详细前后对照见下方。 |
| 完整 release-check | **PASS**。2026-09-22 01:45:20–02:09:31（Asia/Shanghai），UNIT_TEST_CONCURRENCY=1；lint、架构、smoke、全量单测和全部集成均通过。[输入清单](gate-input-manifest.json)、[日志](release-check.log)、[退出与输入核对](release-check-result.json)。 |
| 全量单测 | 9015 total：9011 PASS、0 FAIL、4 项 Windows 条件跳过；828 suites。 |
| 全量集成 | 68/68 脚本通过；有计数脚本合计 2901/2901，另 1 个脚本不提供用例计数。含 Renderer lifecycle 233/233、大文件 50/50、多 Sheet 大规模拆分 31/31。[汇总](verification.json) |

探针前后：[查询完整配置前](query-realconfig-before.json)／[后](query-realconfig-after.json)、[Renderer 前](renderer-realconfig-before.json)／[后](renderer-realconfig-after.json)（[最终输入下的当前检查器复验](renderer-final.json)）、[数据合同前](data-realconfig-before.json)／[后](data-realconfig-after.json)、[G1 前](g1-before.json)／[后](g1-after.json)。探针 exit 0 仅表示取证完成；违规路径应产生诊断，正常路径应保持无诊断。

## 自检与验收边界

本轮沿用 implementation-notes / blindspot-pass。重要不变量是：未知长度不能伪造确定索引、同一可解析对象的别名不能丢失变更、属性存储不得吞掉自有键、数据合同落在真实装配路径、已知受限恢复能力不得在有限静态转发后消失。

本地工厂返回后的别名变更是原样探针发现的相邻存活问题，已在本轮继续修复；已列明的无变更对象/工厂返回、静态数组、安全读取和正常初始化数据均保留对照。检查器不会执行工厂、getter 或生产模块来猜测结果。

保守边界：包含未知长度 spread 的数组不推断参数/工厂返回的实际长度，因此依赖该位置的调用可能被 coverage 拒绝；真实 prototype setter 除明确 null 外保守拒绝。任意运行时 this 分派、跨文件动态对象身份及任意回调/反射仍不构成完整语义证明。五项反例及本轮补充路径关闭，不等于所有 G8 合同或运行时安全已全部验收。

本轮没有独立复审。真实产品 Main 全流程、Windows/安装包、Excel/WPS 和资金人工验收未执行，不由本次静态检查和自动门禁代替。

## 保护与回退

交付核对确认：门禁前后 1700 个输入和 HEAD 一致；起始冻结的 4106 个文件中，仅计划内 10 个检查器/说明文件变化（含集成 runner 自动更新的策略结果表）。792 个 src/ 文件、135 个既有审查/修复证据、2 个架构机器 JSON 及主工作区 865 个既有 dirty 文件均未变化。另新增本轮回归测试和证据目录。详见[最终保护清单](preservation-final.json)、[验证汇总](verification.json)及[交付核对](delivery-check.json)。

[本轮增量补丁](incremental.patch)只包含相对起始 dirty 状态的源码、测试、说明与集成结果差异，反向应用预检通过。回退应仅针对该增量，保留退款/C3 与前两轮 G8 修复；before/ 保存这 10 个既有文件的原始内容，不应整体撤销原有未提交差异。
