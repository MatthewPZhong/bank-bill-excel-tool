# release/v3.2.10 两项 P1 修复与验证

本次依据[独立审查](../2026-09-21-release-review/review.md)修复 R1/R2，工作区为 `tmp/worktrees/release-v3.2.10`，接手 HEAD 为 `9a38b96b1b8006c5851535d0c1e586bbaeb63f10`。本文件为修复记录，不覆盖原审查结论和证据。本次改动尚未提交。

**结论：两项 P1 已修复，最终完整本地 `release-check` PASS，exit 0。** R1 的真实组合回归和 R2 的独立反例复验均通过；31 个架构边界 active，0 诊断、0 stale。该结论适用于 HEAD 加本次未提交修复的冻结候选，不等于真实产品、平台人工验收或正式发布完成。

## R1：退款／C3 的确认操作

`src/renderer/controllers/bank-statement.js` 保存 `openRoot` 返回的具体句柄，在处理“导入文件”或“直接运行”前，检查控制器代次及句柄的打开／栈顶状态，使用 `handle.close({ status: 'submitted' })` 提交。只有宿主返回 `closed` 后才执行后续业务。关闭被拒、旧代次、旧句柄及非栈顶路径均不继续业务；取消仍使用既有 `cancelled` 语义。同一确认工具的导入后提醒与网关场景选择一并使用合法句柄提交。

- 修复前重新复现退款／C3 四条按钮路径阻断，后续业务调用为 0。
- `scenario-change-routing.test.js` 使用真实 modalHost 验证 31 项；退款及控制器相关专项 94 项通过。
- 新增自动纳入 Renderer 生命周期集成的 `bank-statement-confirmation` fixture，使用真实 Electron DOM、controller、确认框、bridge 和 host，27 项通过。
- 业务 API 使用隔离桩记录调用；该 Electron 组合回归不等于真实产品 Main 和实际资金文件的端到端验收。

完整 R1 处置及日志见 [R1 记录](r1/repair.md)和[验证数据](r1/verification.json)。

## R2：G8 与已集成实现对齐

修复前本次复验为 2,195 条诊断，2 个 active、29 个 partial，日志见 [架构检查原始结果](architecture-before.json)。诊断数量包含配置和调用归因问题，不等于相同数量的业务缺陷。

处理遵循 G1–G8 已有合同：

1. G7 装配按实际源文件、目标和具名导出登记，识别 namespace 上实际读取的具名成员，禁止动态或整包转交继承具名授权。登记不扩展为整个领域目录。
2. G5 Q1–Q3 登记真实 catalog 查询注入链；查询及 Main 编排沿实际调用能力检查，保留公共模块的禁止反向依赖规则。模块的初始化、被调用 helper、返回函数及可解释回调保持追踪，不能把单纯 policy 注册扩展成所有领域仓储执行，也不能放过真实原始 DB 调用。
3. G1 同时保护旧 `recover` 和现有 `execute-recovery` 命令；现有授权队列、worker 装配与传输位置使用准确函数／AST 指纹登记。原动态恢复例外不用于放过整个文件或目录。
4. G3 按真实工厂、Preload 域 API、面板及 UI 服务能力登记；补充越权实参、对象修改、脚本时序和不透明来源的负例。真实生命周期与业务行为仍由 G3 测试负责。
5. G4 的 Toolbox 聚合入口从中性 XLSX 模块导出共用 helper，原公开名称及每个值的引用身份均保持。兼容测试 11/11 通过，没有修改 Excel 生成算法。
6. 删除 111 条已失效例外及 1 条被精确授权合同替代的动态恢复例外，保留固定 v3.2.9 的 2 条扩展 worker SCC 例外。没有增加循环豁免或重置事实基线，历史防倒退继续执行。

`cli.test.js` 及第三至第五轮的最小调用图 fixture 不再继承真实 release 的整套入口激活证据；原规则和否定断言保留，36/36 通过。真实 release 的 active 完整性仍由正式 CLI 检查。

## 独立复核

修复期间使用独立探针复核新检查器，确认了导入／工厂返回 callback 的调用传播、Renderer 完整 API 经参数转交、对象修改及重写时序的漏报。修复并冻结后，原样复验 12 条实际 SQL 旁路及 5 条 Renderer 越权，全部产生预期诊断；只注册而未执行 policy、合法具名 namespace 和合法 UMD scoped 对照通过。原版对照明确区分本轮新增和既有缺口，均已关闭，见[独立复核报告](independent-review/review.md)。该复核没有为其作者实现的 R1 提供独立通过背书，R1 依据真实组合测试及主任务核对。

## 最终验证

所有代码、机器配置及测试已冻结，共 1698 个输入，以 `UNIT_TEST_CONCURRENCY=1 npm run release-check` 执行完整 lint → architecture → smoke → unit → integration，**exit 0**。macOS arm64 / Node v25.8.0；2026-09-21 22:21:50—22:45:10（Asia/Shanghai），约 23 分 20 秒。运行脚本为 [run-release-check.py](run-release-check.py)，输入见 [gate-input-manifest.json](gate-input-manifest.json)，结果见 [verification.json](verification.json)、[完整日志](release-check.log)和[运行记录](release-check-result.json)。

| 验证范围 | 本次最终结果 |
| --- | --- |
| lint / architecture / smoke | PASS |
| 全量单测 | 564 个文件；8944 通过、0 失败、4 项 Windows 条件跳过，共 8948 |
| 集成 | 68/68 个脚本通过；有计数脚本合计 2901/2901 |
| Renderer 真实 Electron 生命周期 | 233/233，包含本次退款／C3 确认 fixture |
| 架构专项 | 170/170，0 skip |
| 冻结输入与 HEAD | 1698/1698 SHA-256 保持，HEAD 保持 |

既有 `v2.1.12-beta-multiworker-nested` 集成脚本返回 PASS 但不输出计数，因此 2901 是其余有计数脚本的合计，不给该脚本虚构用例数。4 项单测跳过为真实 Windows PowerShell／CIM／packaged canary 条件项，详细名称保存在验证 JSON 中。集成 runner 在全部成功后自动更新 `rules/integration-test-policy.md` §七，未手工填写 PASS 清单。

[激活证据映射](activation-ledger.json)核对了 31 个边界声明的 39 个唯一行为验证入口，全部由本次 unit 或 integration runner 覆盖。静态配置与行为执行结果分开留存。

已完成的最终专项：架构 170/170 PASS、目标 lint PASS；[最终 CLI](architecture-final.json)为 765/765 解析、31 active、0 pending/partial、0 诊断、0 stale。报告仍披露 2 个未解析加载与 33 个动态位置，由现有准确生成/动态加载合同约束；没有将静态覆盖写成完整运行时证明。两条既有扩展 worker SCC 例外继续保留。

## 保留与交付边界

- 原审查 24 文件和主工作区 865 个 dirty 文件的初始 SHA-256 见 [input-preservation.json](input-preservation.json)；交付前复查全部保持，见 [preservation-final.json](preservation-final.json)。
- 本次没有提交、推送、合并到 main、升版、创建标签或发布。
- 真实产品 Main 全流程、Windows／安装包、Excel／WPS，以及既有 G3 资金相关人工复核仍需单独完成；静态 active 或本地自动门禁不会替代这些验收。
