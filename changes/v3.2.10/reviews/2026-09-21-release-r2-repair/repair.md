# v3.2.10 第二轮审查修复与验证

本轮针对[第二轮审查](../2026-09-21-release-rereview-r2/review.md)的 **RR2-01～05 五项 P2**。五项反例已修复，新增 34 项回归全部通过；全部架构测试 204/204 PASS，真实配置 CLI 31 active、0 诊断、0 stale。最终完整 `release-check` 已在本轮冻结输入上通过：**8978 项单测通过、0 失败、4 项 Windows 条件跳过；68/68 集成脚本通过**。本轮于 2026-09-21 23:59:32 启动，2026-09-22 00:19:13 完成（Asia/Shanghai），耗时约 19 分 41 秒；未复用上一轮完整门禁结论。

## 工作区与范围

- 工作区：`tmp/worktrees/release-v3.2.10`，分支 `release/v3.2.10`，HEAD `9a38b96b1b8006c5851535d0c1e586bbaeb63f10` 加既有未提交修复。
- 修改前冻结 4049 个已有文件及 tracked diff：[输入清单](input-manifest.json)、[原有差异](input-diff.patch)。本轮只修改检查器、架构配置、回归测试及说明；生产 `src/` 源码保持原状，退款/C3 的上轮修复保留。
- 使用 implementation-notes 与 blindspot-pass 完成实施记录及本轮自检；未委派独立审查。本报告是修复证据，不把自检称为独立 review。
- 没有提交、推送、PR、升版、打标签或发布。

## 逐项处置

| 项目 | 修复和不变量 | 可复验依据 |
| --- | --- | --- |
| RR2-01 数组回调脱离查询闭包 | 静态数组按索引、嵌套索引、解构、spread 与调用参数传播，真实选中的回调进入查询检查。元素直接作为函数但未知或越界时报告 coverage；未调用的危险成员不污染 safe 导出，普通数据的字符串方法保持合法。 | 6 例真实内存 SQLite 执行后均报查询违规；3 类不可解释元素调用拒绝，safe 对照通过。 |
| RR2-02 bind 丢失预绑定参数 | Renderer 工厂逐层保留预绑定参数，调用时按前置参数后接后传参数的顺序绑定函数形参。 | 单层/多层 bound factory 实际返回完整 API 的 VM 反例均拒绝；窄能力及前置普通参数的合法工厂通过。 |
| RR2-03 别名写入遗漏 | 对象描述保留原始 AST 身份；const 与对象解构别名上的静态写入或未知 helper 逃逸计入原对象。Renderer 按原 AST 顺序处理 spread，保留源身份与覆盖顺序。 | 工厂返回、静态 spread、嵌套对象解构与 Object.assign 的 4 条 VM 路径均确认额外方法实际可调用且被拒绝；同名不同对象和合法 freeze/spread 对照通过。 |
| RR2-04 initialInfo 非递归校验 | initialInfo / initialBillCategory 保留现有参数授权，递归检查数据。仅允许纯数据或明确 app:get-info IPC 数据，拒绝嵌套函数/API/state/elements/未知对象和其他 IPC 来源。 | 6 类嵌套反例、纯数据/实际 IPC 合法对照和真实 Statement 配置反例。 |
| RR2-05 G1 内部恢复配置过期 | 保留旧 recoverPendingInternal 禁令，补齐 recoverOneJournal、recoverPreparingIntent、recoverFinalizingIntent；配置与调用按函数绑定身份比较。正常恢复链路 6 处调用以函数位置和 AST 指纹逐项登记。 | 3 个入口各自通过直接、别名、bind 在 prepare 内调用的 9 例全部拒绝；完整生产配置通过。 |

G1 合法位置已逐段读码核对：recoverPendingToolboxPublications 在 IO 前执行 verify，并在遍历任何恢复记录前验证完整 grants/snapshot；进入 recoverOneJournal 后依据 discovery/journal 状态路由到两类内部阶段。新增许可只覆盖这些现有调用位置，不能复用于 prepare。静态许可仍不替代运行时授权验证。

实现入口：[查询执行闭包](../../../../scripts/architecture/contracts.js)、[Renderer 合同解析](../../../../scripts/architecture/renderer-contracts.js)、[AST 身份](../../../../scripts/architecture/scan.js)、[规则](../../../../scripts/architecture/rules.js)、[机器配置](../../../../architecture/boundaries.json)。正式回归：[release-rereview-r2.test.js](../../../../tests/unit/architecture/release-rereview-r2.test.js)。

## 验证与证据

| 检查 | 实际结果 |
| --- | --- |
| 新增回归，修复前 | 34 项中 31 项失败，稳定暴露待修路径及合法 bind 对照的误判；[日志](regressions-before.log) |
| 新增回归，修复后 | 34/34 PASS；[日志](regressions-after.log) |
| 全部架构单测 | 204/204 PASS，0 fail/skip；[日志](architecture-tests.log) |
| 正式架构 CLI | PASS：解析 765/765，31 active、0 pending/partial、0 诊断；[日志](architecture-cli.log) |
| lint | `npm run lint` PASS；额外对本轮 4 个检查器文件和新测试执行 no-undef，5 文件 0 errors/warnings；[源码 lint](lint.log)、[工具 lint](tool-lint.json) |
| 原审查探针原样重跑 | 两条数组查询均诊断；4 条真实配置 Renderer 注入均诊断且无基线诊断；3 个当前 G1 内部函数和旧名均诊断。见下方前后证据。 |
| 完整 release-check | **PASS，exit 0**；8982 项单测中 8978 通过、0 失败、4 条 Windows 条件跳过；68/68 集成脚本通过，有计数合计 2901/2901，1 个脚本无计数但 exit 0。Renderer 生命周期 233/233；[输入清单](gate-input-manifest.json)、[完整日志](release-check.log)、[原始运行结果](release-check-result.json)、[验证摘要](verification.json) |

本轮原始复现：[查询修复前](query-execution-probe-before.json) → [修复后](query-execution-probe-after.json)、[Renderer 修复前](renderer-realconfig-before.json) → [修复后](renderer-realconfig-after.json)、[G1 修复前](g1-internal-probe-before.json) → [修复后](g1-internal-probe-after.json)。复现脚本来自原审查 evidence，原文件未改。脚本 exit 0 只表示取证成功，结论按每例 diagnostics 和运行结果判断。

## 自检与剩余边界

- **已反证的误报候选**：按数组元素传播时曾将数据元素的 charCodeAt 方法判作未知回调；现只对直接被执行的数组元素做该 coverage 判定，回归保留合法数据路径。多层 bind 顺序、对象别名身份、spread 覆盖次序和递归数据入口均有正反对照。
- **事实与限制**：原查询探针附带的 class-this/object-this 探索样例仍为零诊断，本轮没有扩展任意 this 分派分析；它们不属于原报告确认的 RR2-01～05。静态解释范围见 [architecture README](../../../../architecture/README.md#覆盖与验证边界)。本轮五项关闭不能推导为所有 JavaScript 旁路均已证明不存在，也不据此宣称 G8 防倒退合同全部验收完成。
- 本轮没有改变业务金额、币种、匹配/回填、Excel 输出、数据库或恢复授权行为，未重做对应资金人工验收。真实产品 Main 全流程、Windows/安装包、Excel/WPS、G3 资金人工验收仍未完成。
- 修复后的独立复审未执行。后续复审可直接基于本目录冻结清单、34 项回归及原样前后探针核验。

## 回退与保护

仅回退本轮列明检查器、配置和测试增量；不要撤销上轮退款/C3 或 G8 对齐修复。交付前核验：1699 个门禁输入与 HEAD 在运行前后保持；792 个 src/ 目录文件、79 个既有审查/修复证据文件、主工作区 865 个既有 dirty 文件 SHA-256 全部保持。既有 4049 文件中仅列明的 11 个检查器/配置/说明文件变化，另新增 1 个回归测试及本目录证据；`rules/integration-test-policy.md` 由全部集成成功后的 runner 自动更新。没有非预期变化。见[最终保护结果](preservation-final.json)。
