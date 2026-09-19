# 三模块统一后台执行启用方案

状态：**方案待实施；本次仅新增方案文档，未修改源代码、测试、生产配置或业务数据。**

日期：2026-09-07。代码基线：`f75e76d140c4019980c5387e715ab9a99f9e8ffe`，版本 3.2.7。

当前测试结论以 [current-readiness.md](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/changes/background-enablement-20260907/current-readiness.md) 和 `current-*` 证据为准。本目录此前已撤回试验的 spec、review、verification 不代表当前开启状态，也不是本方案的生产验收证据。

## 1. 目标、范围和完成标准

- **Goal**：资金对账、VCC 财务 OP 校验、网银账单生成在现有功能和业务口径下，完成统一后台平台接入，经过验收后启用下表全部 11 个动作。
- **Context**：资金对账、VCC 导出已有 Worker 和策略；Statement 已有 Service、交互和发布能力。主要缺口在生产装配、Main 入口、会话所有权、持久化和兼容行为。
- **Constraints**：本次只输出方案。未来实施沿用现有对账算法、模板、文件命名和 Excel 格式；不借接入工作修改金额、币种、匹配、主体、日期或历史回填规则。样例验证使用临时数据或脱敏副本。
- **Done when**：11 项均通过真实入口的 `production:true` 路由测试、业务等价验证、资源及恢复测试和适用平台验收；完整 `release-check` 成功；最终配置开启，重启后的目标应用确实采用新路径；未完成项不能以“底层单测通过”替代。

这里的“模块启用”按现有统一平台 Manifest 的范围定义。VCC 导入、计算等已经使用模块专用 Worker，保持现有执行机制，同时纳入完整业务流程回归；不将其误称为新增三个导出策略所托管。将 VCC 所有已有专用任务也迁入统一平台，是另一个任务清单扩容项目，不作为本次三个模块启用的隐含工作。

| 模块 | 要启用的动作 | 用户入口/行为 |
| --- | --- | --- |
| 资金对账 | `fund-recon:import` | 单文件及批量导入；兼容独立资金对账不平文件入口和批量文件角色分流 |
| 资金对账 | `fund-recon:run` | 对当前批次执行原有资金对账编排 |
| 资金对账 | `fund-recon:export` | 主表、错误报告、命中场景行、中台加款单剔除、退款回填输出 |
| VCC 财务 OP | `vcc-financial-op:export-audit` | 数据管理原表/校验表导出、导入异常审计导出 |
| VCC 财务 OP | `vcc-financial-op:export-single` | 单主体校验结果导出 |
| VCC 财务 OP | `vcc-financial-op:export-subjects` | 多主体校验结果导出 |
| 网银账单 | `statement:import` | 文件导入及当前账单生成流程 |
| 网银账单 | `statement:resolve-big-account` | 大账号选择后的续跑 |
| 网银账单 | `statement:resolve-manual-balance` | 余额补录、覆盖确认及后续生成 |
| 网银账单 | `statement:generate-current` | 当前账单明细/余额导出 |
| 网银账单 | `statement:generate-all` | 月度汇总及全部账单范围导出 |

在其他模块没有同期调整的前提下，目标状态应为：Manifest 仍为 66 项，Runtime 注册策略由 48 项增至 53 项，启用动作由 12 项增至 23 项。这个计数只是辅助检查，不能代替逐入口路由验证。

## 2. 已确认的基础和缺口

| 事实 | 当前证据 | 对实施的影响 |
| --- | --- | --- |
| 三模块当前功能专项 272 PASS；Electron Node 模式复验 35 PASS | `current-focused-tests.log`、`current-capability-tests.log`、`current-electron-tests.log` | 可复用底层实现；这些结果不证明真实 Main 已接入 |
| 资金对账三策略已注册但关闭，Main 仍持有完整旧会话和运行结果 | [runtime.js](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/src/main-process/background-execution/runtime.js)、[main.js](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/src/main.js:5660) | 需要迁移入口及状态读写，不能单改开关 |
| VCC 审计两类入口已有生产选择器、来源复核和真实 Publisher | [main.js](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/src/main.js:1120) 中 `executeManagedVccFinancialOpReadOnlyExport` | 是最小可验收切片；仍须补生产入口和实机证据 |
| VCC 结果入口走 `service.exportRun`；受管 dispatcher 写死 `production:false` | [service](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/src/main-process/vcc-financial-op-service.js:950)、[dispatch](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/src/main-process/vcc-financial-op-output/dispatch.js:704) | 接入真实 Task/归档权威，并由 Main 明确传生产模式 |
| Statement 五项未装配进生产 Runtime；测试依赖独立策略 fixture | [runtime-bindings](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/src/main-process/statement-worker/runtime-bindings.js)、[Runtime](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/src/main-process/background-execution/runtime.js) | 新建生产策略并完整绑定服务、结果验证、持久化和恢复 |
| 当前项目级复验存在 BizOP IPC 数量断言失败：期望 20、实际 21 | [测试](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tests/unit/main-process/biz-op-v327.test.js:724)、`current-failure-check.log` | 单独排查预期路由集合；不能机械修改数字或绕过 release-check |

## 3. 工作包 A：先固定共同接入约束

**修改位置**：`src/main-process/background-execution/runtime.js`、`action-manifest.js`、`action-task-binding-registry.js`；各模块策略、Main 入口和专项测试。

1. 建立“用户 IPC → Task key → actionKey → Service/Worker → Publisher/settlement”的逐入口表。保留现有用户 IPC 名称和返回字段；内部分发抽到模块适配器，避免将完整新业务链继续堆进 `main.js`。
2. 选择受管路径的生产入口必须调用真实 `runtime.execute({ production: true, ... })`。该请求遇到未注册、未启用、缺失权威、来源过期应显式拒绝；不在失败后自动改走旧入口重做。配置关闭时仍按既有入口选择旧路径，开关组和会话隔离遵循下一项。
3. `fund-recon` 三项作为一个会话开关组，Statement 五项作为另一个会话开关组。启动时验证组内策略完整并固定本次进程路由；禁止导入走新路径、续跑/导出走旧状态。
4. VCC 审计和结果导出可以分阶段验收；最终三项都开启。用户运行期间不热切换执行路径；配置切换在任务已结束、待发布记录已处置后随应用重启生效。
5. 单个 Task 只允许一个最终文件发布责任方。Worker 生成到受管 staging；Main 核对权威、文件计划、hash 和业务内容，再调用现有 durable Publisher，并完成归档交接。
6. 增加入口级证明：记录 `taskRunId/actionKey/serviceGeneration/执行器/最终状态/实际产物数` 等有界信息；来源用受管身份或摘要，日志不回传整表或完整金融数据。
7. 资源指标按实际 topology 和 reservation 检查。生产元数据 `effectiveWorkerCount` 不是实际并发限制，不能只改这个数字声称已限制并发。

**成功证据**：每个 IPC 在开、关配置下路由符合预期；开启时旧执行函数的调用计数为 0；拒绝/失败不会二次提交；真实 Worker 完成后只发布一次；原已启用的 12 项不回归。

## 4. 工作包 B：VCC 数据管理/审计导出

**主要修改文件**：

- `src/main-process/read-only-exports/vcc-financial-op/policies.js`
- `src/main.js` 中 `vccFinancialOp:data-manager:export`、`vccFinancialOp:export:import-audit` 及 `executeManagedVccFinancialOpReadOnlyExport`
- 对应 Main 路由、read-only export、output-recovery 测试。

**具体改动**：

1. 保留已有受管导出实现，补真实入口的配置分支测试：数据原表、校验表、异常审计三种变体分别运行生产路径。
2. 保持 `runManagedReadOnlyExport` 的模块互斥与 taskGeneration；导出期间不允许导入、重算、删除等修改来源。
3. 将 Main 的来源冻结、导出前后 freshness、Workbook 回读、真实 Publisher、归档 handoff 串成完整测试。归档 handoff 不只用观察桩证明。
4. 通过检查后才将 `export-audit` 的生产配置置为启用，补真实 baseline/probe 证据。继续使用单 Writer；预算是否足够由目标样例测量决定。

**验收**：三种变体与旧路径逐 sheet、字段、行数和必要格式一致；业务数据库导出前后未改变；保存框取消不写文件；来源变化、文件占用、发布中断及重启恢复状态正确。

## 5. 工作包 C：VCC 单/多主体校验结果导出

**主要修改文件**：

- `src/main.js`：`vccFinancialOp:export:result`
- `src/main-process/vcc-financial-op-service.js`：`exportRun` 及受管任务封装
- `src/main-process/vcc-financial-op-output/dispatch.js`、`authority.js`、`policies.js`、`topology.js`
- 对应 single-writer、dual-writer、subject-query、output-recovery 和 Main 入口测试。

**具体改动**：

1. Main 在保存位置确认后，将 `taskContext` 的真实 FilePlan、目标快照、批次身份、归档 runId、月份和完整主体集合交给受管 dispatcher。不能接受 Renderer 自报的 authority 或 staging 路径。
2. 单主体选择 `export-single`，多主体选择 `export-subjects`。保留现有“一主体一个文件”的名称、顺序、主体集合和 UI 返回字段。
3. 给 `generateValidateAndPublishVccExport` 增加显式生产模式参数，兼容现有非生产能力测试；Main 生产分支传 `true`，去掉该入口固定 `false` 的限制。
4. 受管结果导出仍进入现有模块互斥和 taskGeneration。导出确认前、生成前后、发布前复核月份、runId、归档 digest/revision、主体集合及 Task 所有权。
5. 复用现有 Writer、深度 Workbook 校验和 Publisher；受管分支不再经过 `writeRunWorkbooksFn` 和第二次 `publishOutputFilesFn`。保持已有恢复日志和 durable handoff 的闭环。
6. 初次启用多主体时，建议将实际 topology 限制为 **1 个 Writer child**；单独计入 coordinator 的线程及内存。把上限传入 topology/admission，不能只设置 `production.effectiveWorkerCount=1`。双 Writer 能力保留在专项测试中，实际提高到 2 个须另有资源和一致性证据。

**验收**：1、2、4 及上限附近主体样例；零主体、重复/缺失主体、归档变化、文件名冲突、一个 Writer 失败、发布阶段中断；确认不遗漏主体、不重复文件、不重复归档。旧专用 Worker 的导入→计算→归档→新结果导出完成整条回归。

## 6. 工作包 D：资金对账完整接入

**主要修改文件**：

- `src/main.js`：`bank-statement:*`、`gateway-recon:import`、批量导入角色分流及相关缓存失效入口。
- `src/main-process/fund-recon-worker/service.js`、`worker-host.js`、`evidence-provider.js`、`source-readers.js`、`artifact-generator.js`、`policies.js`。
- 建议新增 `src/main-process/fund-recon-managed-dispatch.js`，负责 Main 会话适配、生产请求与权威；新增模块 publication 文件，负责 manifest 验证、发布和 marker 结算。
- `background-execution/action-manifest.js`、`action-task-binding-registry.js` 中相关入口映射；对应模块与 Main 路由测试。

### D1. 输入、状态与辅助入口

1. 生产路径由 FundRecon Service 持有银行行、退款行和处理结果。Main 只保留会话身份、revision、有界 UI 摘要与文件计划，不将完整 rows 镜像回主进程。
2. 接入单文件、批量和 `gateway-recon:import`。后者补入 `fund-recon:import` 的合法 Task 映射；先完成注册和合同校验再路由，避免有入口继续更新旧全局变量。
3. 批量导入保留现有文件识别、链接表落库、枚举沉淀、逐文件错误及成功统计。不能把整个批量入口直接替换成只接受 bank/gateway/refund 三类的 Service 调用。
4. 保持“新银行批次清旧 gateway/refund/result；同批退款保留；单独导入辅助文件保留银行单”的生命周期；批量合并的 sourceFiles、行编号、列一致性和输入顺序保持一致。
5. 对 `session-status`、C3 候选数、退款候选数、导出预检提供 Service 查询契约。摘要补齐现有页面需要的文件名、来源文件数、Channel-地区、统计及输出 kind/count；候选查询在 Worker 基于当前配置执行，返回有界计数，不回传整表。
6. 场景、账户映射、链接表和日期策略改变时，统一作会话结果失效处理。保留现有共享互斥，且在 Worker 导出前再次检查 revision/证据；不只依赖 UI 刷新来防旧结果导出。

### D2. 运行和数据来源

1. 复用 `reconciliation-orchestrator`，原始银行/退款会话保持不变，每次运行基于独立工作副本；只在完整运行及资源 adopt ACK 成功后发布新结果。
2. 当前真实网关数据源是数据库 `linked_gateway_bill` 按 Channel 过滤得到的 exact/C3 行池，**不是**历史 `gatewayReconSession`。保留此事实；Service 中 gateway 状态不应误接成编排器输入。原 Main 与 evidence-provider 已相互印证。
3. 运行前派生调拨对账单涉及数据库写入，先在受共享锁保护的现有 Main 路径执行，保留 Payment 开启时派生失败必须阻断、其他现有分支相应提示的语义；将结果身份作为 derivationEvidence 交给 Worker 只读快照。该准备段也必须绑定同一 Task、纳入资源准入、进度和主窗口响应测量。若目标规模下此同步段仍阻塞主窗口，作为独立阻断项补串行数据库执行适配和一致性验证，不能只迁移编排器后宣布性能验收通过；不要直接改成并发 DB Writer。
4. 对账依赖快照包括启用场景、日期策略、链接表、Payment/DBS 门控和派生证据；产生的结果绑定会话 revision 和 evidenceSignature。保持旧 runId 语义，防退款历史 marker 的比较口径漂移。

### D3. 多文件发布与 marker

1. 保留“**一个 manifest artifact 对应多份 Excel**”结构，无须把 `maxArtifacts=1` 改成文件总数。根据 Service 返回的有界导出预检建立真实 FilePlan，并在保存确认结束后重新确认结果身份。
2. Main 严格读取 manifest 和实际文件：kind 集合、路径归属、目标一一映射、文件大小/hash、Workbook 结构及行数。旧 manifest 的内部验证不足以代表 Main 已完成这些检查。
3. **补齐已发现的行为差异**：当前 Main 对命中场景行、加款单剔除、退款回填等附属 Writer 错误可记录警告并保留主文件；现 Worker `generate` 任意 Writer 抛错会清理整批并失败。推荐保留旧业务行为，增加版本化的内部 manifest disposition：每个计划 kind 明确为生成成功或附属生成失败，并附有界原因。只对原有允许降级的附属 Writer 错误降级；主输出/错误报告生成失败、来源失效、路径或身份异常仍整体阻断。
4. 对成功产物只调用一次 durable Publisher；失败的可选产物在 Task/FilePlan 中结算为失败，不把缺文件当作成功。保留原 manifest v1 严格路径，增加 v2 读写及兼容测试；不通过放宽 hash/path 校验实现部分成功。
5. marker 保持顺序：读取旧 marker 生成提醒 → 退款文件实际发布成功 → Main 幂等回写 marker。退款文件失败、未发布、来源失效时不得推进 marker。marker 读/写失败仍只警告，不撤销已落地文件。
6. 将 marker 的 runId、目标身份和结算结果与发布恢复记录关联。发布后进程退出时先核实退款目标文件，再决定是否补做 marker；不得自动重新运行对账或重写整个文件集合。

**验收**：单银行、批量多银行、同批/跨批退款、链接表混合导入、全部未命中、全无改动但有错误报告、五类输出集合、附属报表失败、marker 失败与重复导出；原引擎运行结果、实际修改及标黄、未命中集合和行数去向一致。

## 7. 工作包 E：网银账单完整接入

**主要修改文件**：

- 建议新增 `src/main-process/statement-worker/policies.js` 和 `src/main-process/statement-managed-dispatch.js`。
- `src/main-process/background-execution/runtime.js`：装配 Statement 策略、entry、service、state footprint、结果/产物验证及恢复提供者。
- `src/main-process/statement-worker/service.js`、`contracts.js`、`session-state.js`、`waiting-user-coordinator.js`、`runtime-bindings.js`、`publication.js` 等实际涉及的契约文件。
- `src/main-process/manual-balance-seed-preflight.js`、`manual-balance-seed-settlement.js` 的 Main 接线。
- `src/main.js` 的 `registerFileHandlers`、账号顺序提取/取消、文件导出和月度汇总入口；必要的 `preload.js`、`renderer.js`、`renderer-dialogs.js` 适配；相关测试。

### E1. 注册与会话接管

1. 将已验证的五项策略合同实现为生产源码模块，不能从 `changes/.../validation/fixtures` 加载生产策略。绑定真实 result validator；发布前执行异步技术和业务校验，不使用测试中的恒真 validator。
2. Worker Service 持有文件 entry、解析数据、模板快照及 current/all 范围状态。Main 持有有界 session handle、UI 摘要、真实输入路径和 Task 身份；旧 `statementImportSessions`、`lastFileImportContext`、`lastGeneratedExports` 的使用点按入口逐项适配。
3. `file:import` 的完成标准包括后续自动生成及可能的交互续跑。接入不能停在“解析成功”就返回原本代表已生成文件的成功结果。
4. 保留多模板/按文件名映射、current/all、重新导入替换、来源去重、明细与余额单独生成等用户行为。模板/配置变化后旧会话应拒绝或按已有规则重建，不能混用两代数据。

### E2. 大账号、余额补录与取消

1. 复用已有 token-store 的 generation、sessionRevision、选择摘要、TTL 和一次性消费。前端仅持有有界令牌与选项；不能从前端提交原始 rows、任意私有文件路径或 authority。
2. 现 `waiting-user-coordinator` 只接受 `purpose=big-account`。按 `contracts.js` 明确支持的 `manual-balance`、`scope-generation` 补对应转换、Task 身份和恢复测试；不能简单删除 purpose 校验。等待时释放阶段资源，保留受计量会话；续跑重新获取资源和锁，资源不足仍保留有效交互或可解释地结束。
3. `file:complete-big-account-selection`、`file:cancel-big-account-selection`、`file:extract-big-account-order` 及顺序保存均读取同一代冻结证据。提取顺序时保留“识别到未维护账号则取消当前批次”的检查；覆盖未选行、手工绑定和空交易分段，不重新读取已变化源文件。
4. 当前批次取消后不生成账单、不保存新账号顺序，保留此前成功会话。令牌过期、重复提交、旧弹窗、Worker 崩溃后不得继续写余额或输出文件；正常生成阶段是否可取消必须服从对应 policy，不能由 UI 伪装支持。
5. `file:save-balance-seed` 保持 eager FilePlan 真实源文件要求，保留 `BALANCE_SEED_SOURCE_MISSING` 及余额 `0`；覆盖确认绑定一次性上下文。余额写入使用已有 Main settlement intent/receipt/recovery 能力，Worker 不另起一个余额文件写入口。
6. 余额已持久化但后续生成失败时，状态明确说明余额已保存、生成未完成；重启检查目标 post-image/receipt 后继续既有恢复流程，不重复补录。多账号多币种连续提示必须归属于同一业务会话。
7. 保留前端错误可见、草稿保留和防重复提交；错误对象仍通过原 UI 错误展示机制反馈。

### E3. 生成和发布

1. 接入 `file:export-detail`、`file:export-balance`、`monthly-balance:assemble`、`monthly-balance:export`。分别验证它们原有“生成”和“导出已有结果”的职责，避免一次用户操作触发重复生成。
2. 复用 `generation.js` 和 `publication.js` 的文件身份、源文件摘要、sessionRevision、rowCounts 和业务回读；使真实 Main Task 的 artifact settlement/归档记录闭合。当前 publisher 能力测试不代表真实 Task handoff 已连好。
3. 所有目标路径从 FilePlan 取得；保存框取消、目标被替换、发布中断时保持可解释结果。主进程缓存只指向已发布产物，不能先展示 staging 为导出成功。
4. 明细、余额和月汇总保持四种金额模式、余额三种来源、混合币种、零金额过滤、双非零拒绝及历史模板兼容。算法或格式差异另立问题，不在此接入阶段顺手改动。

**验收**：普通模板、按文件名映射、多账号多币种、四种金额模式、余额 0/覆盖/多次补录、旧模板、current/all、月边界、重复输入、源文件变化、未维护账号取消、前一成功会话保留、崩溃/重启/重复续跑。逐 sheet 比较字段、金额、日期、行数、标黄和文件集合。

## 8. 未知项登记与盲区处置

本轮没有需要阻断“出方案”的用户决策。以下项目应在实施对应步骤先做 PROBE；验证失败会阻断相关动作启用，不能以低风险假设跳过。

| 项目 | 已知事实/尚缺证据 | 分类与最便宜验证 | 失败时的处理 |
| --- | --- | --- | --- |
| 输入规模兼容 | FundRecon 输入上限 64 个来源；VCC 有主体边界；Statement 公共交互有条数/字节限制。真实目标批次是否落在范围内未验证 | PROBE：旧入口同样本回放，覆盖上限前后及用户常用最大脱敏批次；测峰值内存、耗时、线程/子进程数 | 补有界分页/分批及资源设计或明确适用范围并复验；禁止静默截断和临时扩大预算后宣称安全 |
| 资金对账附属报表部分失败 | Main 容许部分成功，Worker 当前为整体失败 | PROBE：分别注入三类附属 Writer 失败，用旧入口结果冻结合同；再验证 manifest v2、Task 结算及恢复 | 该合同未对齐前不开放 fund-recon:export，也不开放资金对账会话组 |
| 会话辅助入口完整性 | 状态、候选数、配置失效、账号顺序和取消入口依赖旧会话 | PROBE：对引用旧全局状态的全部调用点做清单检查，再从真实 IPC 跑整条流程 | 存在未接旁路即不启用对应会话组 |
| 资金持久化边界 | 派生表、退款 marker、余额补录有持久化副作用 | PROBE：副本 DB/临时文件注入提交前后硬退出，二启检查身份、receipt 和重入 | 不允许自动重跑；保留证据并修复恢复路径 |
| 目标平台资源和文件恢复 | 当前 Electron Node 模式通过；真实 Main、Windows 包、Excel/WPS 未验 | PROBE：适用的打包程序、代表性样例和故障注入 | 未验证平台保持未验状态，不能据 macOS Node 结果宣布 Windows 可生产开启 |
| 项目级测试失败 | BizOP 注册数量 20/21 不一致已复现 | PROBE：对照实际 IPC 清单、业务需求和新增路由来源，核对精确集合及重复注册 | 修正实际缺陷或过时合同后完整 release-check；不得改数字遮盖未核实入口 |

**盲区扫描存活项**：上述部分失败合同、等待交互 purpose、旧状态辅助入口、生产请求固定 false、实际 topology 限制及 Main settlement/handoff，均已进入必做工作。

**已被代码反证的候选问题**：FundRecon 并非只支持一个 Excel；gatewaySession 未喂入当前编排器并非新发现的漏数据；VCC 财务 OP 并非所有流程都在主线程；Statement 并非完全没有 Worker 实现。

**⚠️ 资金红线，请人工复核**：实施后的账号/主体/币种归属、退款跨期提醒及 marker 时序、余额补录恢复、行数去向和实际回填字段，需要脱敏业务样例人工复核。自动化测试通过不能替代这些业务验收；此处是后续启用门槛，本轮不执行真实数据写入。

## 9. 工作包 F：验证、分批启用和回退

### 必过检查

| 层次 | 执行内容 | PASS 标准 |
| --- | --- | --- |
| 路由合同 | 11 action 与所有真实 IPC 的开/关分支、模块开关组、旧函数调用侦测 | 开启时进入正确受管生产路径，执行/发布各一次，无旁路 |
| 业务等价 | 临时/脱敏样例从旧入口与新入口回放 | 业务字段、来源、sheet/列/行、修改与警告去向一致；仅剔除经确认的时间戳等非业务差异，不能笼统忽略格式或字段 |
| 故障与恢复 | 来源变化、资源不足、重复提交、Writer 失败、发布各阶段退出、余额/marker 提交前后退出 | 不发布陈旧产物、不重复写、不漏状态；恢复后 Task 和文件/DB 一致 |
| 资源与响应 | 普通及目标最大样例、三模块同时使用、空闲及退出 | 实际线程/进程/内存计入统一预算；Busy/低内存提示正确；结束后 reservation/锁无泄漏；主窗口响应达到事先记录的目标 |
| 项目回归 | 先解决已知 BizOP 失败，再 `npm run release-check` | 完整运行结束且结论成功；不得以部分日志 PASS 或已停止运行替代 |
| 真实应用 | 启用配置的 Electron Main；若交付 Windows，则测试打包 Worker 路径、文件锁、长/中文路径、恢复 | 实际页面整条流程通过，Excel/WPS 可打开，文件和任务状态一致 |
| 业务验收 | 三模块代表性脱敏样例及上述资金红线 | 人工核对并记录结论；与自动化 PASS 分开记录 |

测试按修改范围先跑专项，再跑完整 release-check；只有新增修改、失败或未解决风险才重复扩测。生产路由证明必须使用真实 Worker/Publisher；测试 mock 可用于定位失败分支，但不能充当生产闭环证据。

### 实施与开放顺序

| 顺序 | 工作包 | 交付与依赖 | 不通过时 |
| --- | --- | --- | --- |
| 1 | A 共同接入约束与基线 | 冻结入口表、真实输出合同和状态所有权；调查 BizOP 已知失败 | 未核清合同不进入对应接入开发 |
| 2 | B VCC 审计 | 验证最小真实生产闭环，补 handoff 和实机证据 | 保持该动作关闭，不妨碍后续模块开发 |
| 3 | C VCC 结果 | 接 Main authority、production 请求和实际并发上限 | 结果导出两项保持关闭 |
| 4 | D 资金对账 | 先输入/状态→运行→发布/marker，三项整体完成 | 三项整体保持关闭 |
| 5 | E 网银账单 | 先 Registry/会话→完整等待/续跑→余额 settlement→生成发布 | 五项整体保持关闭 |
| 6 | F 统一验收与最终配置 | 全量回归、目标平台、业务复核；最终 11 项开启并重启验证 | 报告具体未过动作及原因，不宣布三模块全部完成 |

可以在开发阶段逐个工作包形成可审阅提交，但最终交付要求全部三个模块满足标准；不以只开放 VCC 审计作为本目标完成。

### 切换与回退

1. 切换前读取当前任务、待交互和待恢复发布状态。正常结束或按既有取消能力处置后，再做一致性备份；不得在 SQLite 写入中途简单复制一个主 DB 文件。备份范围含相关 userData/DB、余额文件、发布/恢复日志及任务证据，记录恢复位置。
2. 将经过验收的策略组开启，重启目标应用，读取新进程配置和实际执行日志，跑三模块最小流程。开关配置已改与目标程序已生效分开确认。
3. 回退按模块组关闭并重启。先处理新路径未完成的发布/settlement，不丢弃恢复 journal，不复用另一个执行器持有的内存会话；必要时提示重新导入。
4. 若新增内部 manifest/recovery schema，当前版本需能读取旧记录；记录尚未结算时不能直接回退到不理解新记录的旧程序。文件已发布但 DB/marker 未结算时先完成对应恢复检查，不自动重跑业务。

## 10. 方案决策与后续记录

- **Decision**：复用三个模块已验证的业务引擎、Writer、Service 与 Publisher，新增 Main 适配层和必要内部合同；避免重写金额/匹配算法。
- **Decision**：资金对账与 Statement 按完整会话组开放；VCC 导出可以分阶段验证，最终三项都开放。
- **Decision**：保留资金对账原有附属报表失败语义，通过显式 manifest disposition 和 Task 结算补齐兼容，不静默改为缺文件仍全成功，也不随意弱化完整性校验。
- **Decision**：VCC 多主体首次生产使用一个实际 Writer child；调整 topology 后验证真实资源，后续双 Writer 另补证据。
- **Assumption**：新适配器文件名为建议，不属于公共接口，可按仓库组织调整；职责、入口映射和验收要求不随文件名变化。
- **Deviation**：本方案从早先“只启用已具备条件的动作”扩展为三个模块 11 项全部可启用的完整交付；本轮仍仅输出文档，原开关状态不变。
- **Evidence**：当前原代码测试结果见 current-readiness；本轮新增的是调用链和合同核对，没有将文档编写算作新增测试 PASS。
- **Remaining unknowns**：输入规模、故障恢复、目标平台和业务复核按第 8、9 节执行。实施时若涉及金额/归属/文件格式等行为变更，应单独说明并更新方案，不能借“后台接入”默认批准。

版本交付时按仓库约定同步 CHANGELOG、VERSION_FEATURE_HISTORY、USER_GUIDE，描述实际已开放范围、启用方式及使用限制；本次不修改这些产品文档。
