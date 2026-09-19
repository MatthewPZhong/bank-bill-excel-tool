# 三模块启用条件评估（仅测试，当前有效结论）

## 范围与代码状态

用户最终指令：**“仅做测试，看是否有启动的条件，不要动代码。”**

本报告基于恢复后的原始工作区 `f75e76d140c4019980c5387e715ab9a99f9e8ffe`，版本 3.2.7。此前短暂试验的源代码、测试与三份产品文档修改均已撤回；本阶段没有修改这些文件或任何开关。测试结束后 `git diff --exit-code` 为 0。只新增检查报告、测试日志及只读策略盘点结果。

没有写入真实业务数据库、启动真实应用 Main、关闭用户应用、进行数据迁移、提交或发布。测试使用临时数据库和临时工作簿。本目录的旧 spec/review/verification 与 strategy-snapshot 是已撤回试验记录，不能作为当前开启状态；以本报告和 `current-*` 文件为准。

## 结论

**三个模块当前不具备一起直接开启统一后台平台的完整条件。VCC 财务 OP 的数据/异常审计导出最接近首批开放；资金对账、网银账单生成和 VCC 校验结果导出仍有实际接线缺口。**

| 模块 / 范围 | 当前测试与调用链 | 启用判断 |
| --- | --- | --- |
| 资金对账：导入、运行、导出 | 三项 policy 已注册；Worker、证据快照、原逻辑 golden、manifest 和状态/资源保护测试通过。但 Main 的 bank-statement 入口仍持有 `bankStatementSession` / `processingResult`，没有切到该 Service | **暂不具备直接改开关的条件。** 必须先接完整输入、状态查询、运行、manifest 回读/发布及退款 marker 结算 |
| VCC 财务 OP：数据管理导出原表/校验表、导入异常审计导出 | 两个用户入口均有真实 production selector，经模块互斥、来源冻结、只读 Worker、freshness、产物回读和 Publisher。现有相关测试通过 | **具备首批候选的实现基础与隔离测试证据。** 当前开关保持关闭；真实页面、目标平台与业务样例验收未完成，不判为已经满足全部生产启用条件 |
| VCC 财务 OP：单/多主体校验结果导出 | Worker、主体查询、单/双 Writer、authority 与发布能力测试通过；Main 仍走 `service.exportRun → writeRunWorkbooksFn`；受管 dispatcher 固定 `production:false` | **暂不具备直接开启条件。** 需接 Main 的真实 Task/run/archive authority 与生产请求 |
| 网银账单生成：五项 Statement 动作 | Service、token 交互、原逻辑 golden、生成与余额持久化测试通过。但生产 Runtime 未装配这五项；Service 测试使用独立 fixture registry，Main 保留原路径 | **暂不具备直接开启条件。** 需接应用 Registry、完整交互与输出发布，并验证最新账号维护/取消语义 |

VCC 的导入、计算、修改等已有模块专用 Worker。统一平台的三个 VCC 导出动作不代表整个模块的全部后台能力；也不能用另一模块 `vcc-op:*` 的状态替代本模块。

资金对账 `maxArtifacts=1` 的准确含义是一个 **JSON manifest artifact**，其 `outputs` 可以包含多份 Excel，并含 `settlement.refundHitMarkers`；不是只能生成一个 Excel。未完成部分在 Main 消费与发布/结算接线，不能据单 artifact 数量声称原代码丢失业务输出。

## 当前原代码上的测试结果

| 检查 | 实际结果 | 日志 |
| --- | --- | --- |
| Node 24.13.0：平台、VCC 恢复/service/export、FundRecon runtime/artifact、Statement service，共 8 文件 | **144 PASS / 0 FAIL / 0 SKIP**，退出码 0 | `current-focused-tests.log` |
| Node 24.13.0：FundRecon service/evidence/readers/policy、Statement golden/contracts/interaction/generation/manual seed、VCC dual writer/subject query，共 11 文件 | **128 PASS / 0 FAIL / 0 SKIP**，退出码 0 | `current-capability-tests.log` |
| 两项既有失败定向复验 | **1 PASS / 1 FAIL**，退出码 1；工具箱资源/泄漏测试通过，BizOP IPC 数量断言仍失败 | `current-failure-check.log` |
| Electron 36.9.5 / Node 22.19.0 的 Node 模式，VCC 只读导出、FundRecon native runtime、Statement service，共 3 文件 | **35 PASS / 0 FAIL / 0 SKIP**，退出码 0 | `current-electron-tests.log` |
| 原代码与开关核对 | `git diff` 为空；指定 11 项均未启用，Statement 五项未装配；全平台原有 BizOP 十二项继续开启 | `current-policy-check.json` |

前两组当前功能专项合计 **272 项全部通过**。第三组为另行排查；Electron 35 项是跨运行时复验，不当作新增独立业务覆盖数量。当前开关保持关闭，capability 测试中的 `production:false` 与隔离 fixture 不能等同实际页面的生产启用成功。

## 尚未通过的项目级检查

当前 `tests/unit/main-process/biz-op-v327.test.js:724` 断言注册 20 个 IPC，实际为 21 个：`21 !== 20`。已在原始代码恢复后重新执行并稳定复现。该失败属于新版业务 OP，**不归因于这三个模块，也没有在本轮修改代码或断言修复**。

因此目前不能将项目完整 `release-check` 记为 PASS。本阶段未重新运行一次完整 release-check；此前试验配置下的全量运行已按用户指令停止（退出码 130），不作为当前原代码全量通过的证据。

## 开启前还需完成的条件

1. 资金对账和 Statement 先补实际 Main 接线；VCC 结果导出接生产路由。现在只改配置无法消除这些代码缺口。
2. 处理当前项目级 IPC 测试失败，之后完整运行 release-check；本轮只记录，未修复。
3. 用真正的 Electron 页面和代表性脱敏样例检查导入/运行/导出、取消与重启恢复；核对账号、主体、金额、币种、行数及输出文件集合。
4. 如果目标为 Windows，验证打包后的 Worker/Publisher、文件耐久与恢复，并实际用目标 Excel/WPS 打开文件；本机自动测试不能替代。
5. 真正切换前检查活动任务，备份实际 userData 和相关数据库；测试阶段没有执行真实数据切换或备份。

建议优先安排 VCC 数据管理/异常审计导出的实机验收，再分别推进资金对账与网银账单生成的接线工作。本报告不执行这些后续操作。
