# 三模块启用检查结论

> **当前状态：已撤回代码改动。** 用户随后明确要求“不要动代码”；本轮源代码、测试及三份产品文档已恢复到修改前状态，VCC 开关已恢复关闭。本目录保留此前检查与短暂试验的历史证据，不能解读为当前配置已开启。完整 release-check 发现两项失败后按用户要求停止（退出码 130），没有完整 PASS，也没有完成修复或重新验收。

本轮按用户要求检查三个模块，开启其中已完成 Main 接线的 VCC 只读数据/异常审计导出。其余动作继续使用原路径。没有重启用户程序，没有修改真实数据或发布安装包。

## 动作清单

| 模块 | actionKey | 本轮结果 | 实际用户行为 |
| --- | --- | --- | --- |
| VCC 财务 OP 校验 | `vcc-financial-op:export-audit` | 配置已开启 | 数据管理导出原表/校验表；导入异常审计导出；单 Worker |
| VCC 财务 OP 校验 | `vcc-financial-op:export-single` | 未开启 | 单主体校验结果仍走原 writer |
| VCC 财务 OP 校验 | `vcc-financial-op:export-subjects` | 未开启 | 多主体校验结果仍走原 writer |
| 资金对账 | `fund-recon:import` | 未开启 | Main 继续持有银行/网关/退款等会话 |
| 资金对账 | `fund-recon:run` | 未开启 | 原场景执行和结果快照路径 |
| 资金对账 | `fund-recon:export` | 未开启 | 原多文件导出和退款命中标记路径 |
| 网银账单生成 | `statement:import` | 未装配 | 原导入/模板映射链 |
| 网银账单生成 | `statement:resolve-big-account` | 未装配 | 原大账号选择、账号维护检查和整批取消 |
| 网银账单生成 | `statement:resolve-manual-balance` | 未装配 | 原余额补录及持久化链 |
| 网银账单生成 | `statement:generate-current` | 未装配 | 原当前明细/余额导出 |
| 网银账单生成 | `statement:generate-all` | 未装配 | 原全部/月度组合与导出 |

VCC 财务 OP 的导入、计算与修改等已有专用后台 Worker，此处的“未开启”仅指对应动作没有切到统一平台；不代表用户无法使用模块，也不把 `vcc-op:*`（另一模块 VCC 业务 OP 计算）计入本范围。

## 证据型盲区检查

### [Important] 资金对账的 Runtime 注册尚未连接用户会话

- 场景：直接把三项 FundRecon policy 改为 enabled 后，从实际页面导入/运行/导出。
- 事实与证据：`src/main-process/background-execution/runtime.js` 注册 `FUND_RECON_POLICIES`；`src/main.js` 的 `bank-statement:*` 入口仍直接读取/写入 `bankStatementSession` 和 `processingResult`。Main 没有引用 FundRecon Worker 的生产 selector。
- 推断/未知：只改开关不会切换当前页面；补接时如果导入和运行分开切换，会形成两个互不一致的状态持有者。
- 影响：平台快照可声称启用而实际业务仍旧路；后续不完整接线可能读旧会话或漏掉网关/退款/链接表输入。
- 最便宜验证：逐入口捕获真实 Runtime action、Service generation/state revision，并比较完整输入/运行/导出流程。
- 处置：本轮保持原路径。后续把导入、运行、状态查询与导出作为同一接入单元。

### [Important] FundRecon 单 artifact 是多文件 manifest，需要 Main 完整消费

- 场景：资金对账同时产生主结果、错误报告、命中场景、加款剔除或退款回填。
- 事实与证据：`fund-recon-worker/artifact-generator.js` 的 `generate` 生成所有 eligible outputs，再返回包含 `outputs` 和 `settlement.refundHitMarkers` 的 JSON 清单；`service.js` 返回单个清单 artifact。Main 当前未调用此链。
- 推断/未知：不存在“Worker 只能输出一份 Excel”的结论。真正待接部分是清单身份/哈希回读、全部文件的唯一发布，以及正确时点的退款 marker 结算。
- 影响：若把 JSON 清单当 Excel，或只取某个输出，会破坏审计和可追溯性。此问题是后续接线约束，不是本轮发现已运行生产路径丢文件。
- 最便宜验证：实际多种输出并存的临时工作簿回放、发布前后故障注入，检查正式文件集合与 marker 写入顺序。
- 处置：复用现有 manifest 合同，保持关闭；本轮不更改 `maxArtifacts`。

### [Important] Statement 测试装配不等于应用装配

- 场景：试图启用网银账单生成的五项动作。
- 事实与证据：`statement-worker/runtime-bindings.js` 已有 entry registry；`statement-service-e09-a.test.js` 从合同 fixture 注入五项 policy 和验证器。应用 `runtime.js` 未注册这五项，Main 仍调用原 session/generation helper。
- 推断/未知：还需确认大账号与手工余额 continuation、当前/全部/月度范围、无文件补录、最新账号维护检查与已有 token 生命周期能够在真正 Main 入口保持语义一致。
- 影响：单独搬迁导入会使后续选择/生成读不到同一状态，部分交互可能失去原保护。
- 最便宜验证：接通最小“导入→选择大账号→生成当前”闭环，再覆盖无文件人工余额及跨文件/月度组合。
- 处置：保持原路径，不从 fixture 动态加载生产策略。

### [Important] VCC 结果导出仍是独立能力代码

- 场景：开启单/多主体结果导出 policy。
- 事实与证据：Main 的 `vccFinancialOp:export:result` 调 `service.exportRun → writeRunWorkbooksFn`；`vcc-financial-op-output/dispatch.js` 的 `generateValidateAndPublishVccExport` 固定 `production:false`。已具备 Worker、authority、回读与 Publisher，但没有这条生产 Main 路由。
- 推断/未知：需要接入真实任务代次/身份与 run/revision/archive authority，并将生产请求显式传入；仅打开 policy 无法完成。
- 最便宜验证：用真实 Main Handler/Service task lifecycle 走单主体和多主体两种入口，冻结来源，分别注入解归档/源变化/发布失败。
- 处置：本轮不扩大结果导出的接入面，保留两项关闭。

### [Important] 已启用的 VCC 只读导出保护

- 来源：Main 冻结数据库或存档来源；Worker 使用只读数据库和原查询/writer。
- 状态：`runManagedReadOnlyExport` 共用模块互斥；三次来源 freshness 与产物回读完成后才调用一次 Publisher。
- 输出：保持原文件名、工作表、列序、数据及缺失说明；输出提交/存档接管沿用现有 receipt 与启动恢复。
- 验证：新增 production:true 的 audit/raw/check 三种回放，真实 native Worker 和 durable Publisher；与原路径的 Workbook 语义相同，所有业务表快照相同。既有来源损坏、取消、串行互斥与硬退出恢复专项同时运行。
- 处置：本机隔离自动测试已覆盖；实机导出、Windows packaged、真实样例和 Excel/WPS 保留人工验收边界。

## 人工复核与验收边界

本次未改变账号/主体/币种识别、金额方向或舍入、对账主键、幂等范围和历史回填逻辑，未确认新增的资金红线缺陷。不能以合成样例自动测试代替真实业务验收。后续 FundRecon 会话/marker 和 Statement 账号/余额接线必须再次检查上述红线。

用户正常重启后，请在真实代表性数据上确认 VCC 两个导出入口的文件内容、账号/主体/币种、异常说明与原结果一致，并实际用目标 Excel/WPS 打开。当前记录不声称这一步已执行。

## 下一批实施顺序

1. 资金对账：Main/Service 状态单一归属 → 全部输入及场景快照 → 运行/状态查询 → manifest 完整发布与退款 marker 结算 → 失败/重试/关闭回归 → 同组启用。
2. 网银账单生成：生产 policies/registries → 原模板与账户输入证据 → token continuation 与整批取消 → 人工余额持久化 → 当前/全部/月度输出 Publisher → 成套回归后启用。
3. VCC 校验结果导出：先接单主体真实 route/authority，再接多主体；将后台开放和提高并发分别验收。

本次策略与测试结果见 [strategy-snapshot.json](strategy-snapshot.json) 和 [implementation-notes.md](implementation-notes.md)。
