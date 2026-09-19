# 三模块后台执行启用检查与首批开放

> **当前状态：已撤回代码改动。** 用户随后明确要求“不要动代码”；本轮源代码、测试及三份产品文档已恢复到修改前状态，VCC 开关已恢复关闭。本目录保留此前检查与短暂试验的历史证据，不能解读为当前配置已开启。完整 release-check 发现两项失败后按用户要求停止（退出码 130），没有完整 PASS，也没有完成修复或重新验收。

## Task Brief

- Goal：检查资金对账、VCC 财务 OP 校验、网银账单生成，按用户“完成检查后，继续实现并开启具备条件的动作”执行首批开放。
- Context：基线 `f75e76d140c4019980c5387e715ab9a99f9e8ffe`，应用 3.2.7；统一平台已注册 48 项动作，其中新版业务 OP 的 12 项已启用。当前没有本轮之前的已跟踪文件改动。
- Constraints：不更改资金规则、用户数据、历史数据、进程拓扑或恢复合同；不将新功能范围授权记为 Windows、资金样例或性能验收 PASS；不为形成“全部开启”快照而跳过真实调用点。不发布安装包、不重启正在运行的用户应用。
- Done when：完成三模块逐动作检查；只启用已具备真实入口和完整输出合同的动作；验证生产请求、正常输出与故障拒绝；相关回归通过，交付剩余接入计划和生效边界。

## 已确认事实与启用范围

| 模块 / 动作 | 当前调用链证据 | 本次决定 |
| --- | --- | --- |
| 资金对账 import / run / export | `runtime.js` 已注册 `FUND_RECON_POLICIES`，但 Main 的 `bank-statement:import/batch-import/run/export` 仍使用 `bankStatementSession` / `processingResult`；Worker 返回单个 manifest artifact，内部包含主结果、错误报告、命中场景、加款剔除、退款回填及 marker settlement，Main 尚未消费该清单 | 保持关闭，须先接会话、manifest 回读、完整发布与 marker 结算 |
| VCC `export-audit` | Main 两入口 `vccFinancialOp:data-manager:export`、`vccFinancialOp:export:import-audit` 已使用真实开关和 `production: true`，经过模块互斥、冻结来源、只读 Worker、三次 freshness、回读和 durable Publisher | 本次启用，单 Worker，256 MiB 阶段预算保持原值 |
| VCC `export-single` / `export-subjects` | 页面结果导出仍调用 `service.exportRun → writeRunWorkbooksFn`；`vcc-financial-op-output/dispatch.js` 当前仍固定 `production: false` | 保持关闭，须补 Main route、Task authority 和真实生产派发 |
| VCC 导入 / 计算 / 归档 / 修改 / 删除 | `vcc-financial-op-service.js` 已有专用 Worker / 写入 Worker；不在本批统一 Runtime 的三个 VCC action 内 | 保持已有行为；不得将 VCC 业务 OP 计算 `vcc-op:*` 当作此模块 |
| Statement import / resolve-big-account / resolve-manual-balance / generate-current / generate-all | `statement-worker/runtime-bindings.js` 提供 entry registry，但应用 `runtime.js` 未装配；Service 测试从 `changes/.../fixtures/valid/policy-registry.v3.2.x.json` 注入策略；Main 仍使用原 session / generation helper | 保持原路径，须补实际 registry 和完整交互/发布接线 |

本次共检查 11 个规范动作，启用 1 个（覆盖 2 个用户入口），其余 10 个保持原状态。全平台预期为 66 个清单动作、48 个已注册策略、13 个配置启用、53 个 effective legacy。legacy 统计包括未装配与内部验证条目，不代表 53 个用户功能被禁用。

## Unknowns Register

| 未知 | 分类 | 当前证据 / 处理 |
| --- | --- | --- |
| 注册策略是否等同于页面实际接入 | PROBE 已确认 | 逐个核对上述 Main 调用点；资金对账和 VCC 结果导出均存在未接线 |
| VCC 两个只读导出能否以 production 请求工作且结果一致 | PROBE | 临时 SQLite + 实际 native Worker + Workbook 语义比较；不以 production:false 用例代替 |
| VCC 来源变化、取消、模块互斥和输出提交失败是否保留原保护 | PROBE | 运行现有 E13-B、service、output recovery 测试并增加生产路径专项 |
| 资金对账多文件能否装入当前单 artifact 合同 | PROBE 已确认；Main 接线缺口仍阻止直接启用 | `artifact-generator.js` 返回 manifest 而非单个 Excel，已保留完整 outputs 与退款 marker 结算描述。下一批复用该合同，补 Main 回读和唯一发布；不扩大 artifact 数量 |
| Statement 是否覆盖现有大账号、无文件补录和当前/全部/月度输出语义 | PROBE 未完成接入 | 需要先建立 Main → Service 映射，包含最新未维护账号整批取消规则；本次保持原路径 |
| Windows packaged、真实资金和 Excel/WPS、目标规模 | 未执行 | 保留 NOT_RUN，不据本机隔离测试宣布通过；本次不构建或发布 Windows 安装包 |

## 风险优先计划

1. 固定 action/入口/输出归属；发现输出合同差异则停止该动作的直接开关改动。
2. 在临时数据上用真实 production 请求验证 VCC 两个导出变体，先证明当前开关拒绝，再启用并验证成功。
3. 保持原预算、单 Worker、模块互斥和 Publisher；核对来源变化时正式输出次数为零。
4. 运行三个模块平台专项和完整 release-check，生成本次独立策略快照，不覆写历史 v3.2.5 release evidence。
5. 交付配置变化和未开放清单；正在运行的 Electron 不会热切换，需在任务结束后正常重启加载代码。

## 兼容与回滚

本动作只读取业务数据并按用户既有导出操作发布文件，没有清旧、迁移或补写数据库。源代码开启不主动发起导出。真实环境切换前，应结束运行中任务并备份实际 userData 和模块数据库；本轮不触发真实切换，因此不声称已经完成用户数据备份或实机验收。

回滚时将该 action 的 production 恢复为 `enabled=false / effectiveMode=legacy / effectiveWorkerCount=0`，仅从新任务生效；活动任务继续由当前执行器收口。已提交文件和未 ACK 的 journal/receipt 按原 Publisher 恢复流程处理，不直接删除。
