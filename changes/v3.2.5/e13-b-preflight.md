# v3.2.5 E13-B — PreFund/Position/VCCFin Read-only Export Preflight

## Task Brief

- Goal：把 PreFund 逐渠道工作簿（含重复账单审计 sheet）、Position run/筛选结果工作簿，以及 VCCFin dataset/import-audit 工作簿迁入模块专用只读执行器；保持 run/revision/审计血缘、业务 SQL、排序、金额/币种、Workbook 与用户可见结果不变。
- Context：本分支精确基于 E13-A `ea3427f7f3bc75a71baf1f8d1f9736771a03d8ca`；所有 E13-B action 在代码合并时仍为 `production.enabled=false`，legacy 路径继续生效。
- Constraints：不消费 unknown/partial/stale run；不改资金匹配算法；不复用可写 DB worker 冒充只读 worker；不在 `existing-dispatch` 外层再包 Worker；Publisher 成功前不更新 export metadata；不运行 `release-check`、`check-vars` 或 `scan:vars`；不启用 production。
- Done when：PreFund/Position/VCCFin 的真实入口均有稳定来源证据、只读 query/writer/validator、task-private staging 与 Main Publisher；PreFund 多文件保持全有或全无；Position `exported_at` 只在发布后更新；VCC incomplete lineage 提示、异常审计和 archive integrity 行为保持 legacy golden；stale/partial/tamper/cancel/publish-failure 测试通过。

## 已确认事实

| 事实 | 证据 | 对方案的约束 |
| --- | --- | --- |
| PreFund 唯一用户入口一次导出 N 个渠道文件；每个文件包含平账、不平、渠道账单，并按渠道条件附加“重复网关账单”审计 sheet | `src/main.js` 的 `pre-fund-reconciliation:export`；`pre-fund-reconciliation/excel-writer.js` | managed unit 是“一个渠道工作簿”，不是把审计 sheet 拆成第二个用户文件；有重复审计的 unit 用 `pre-fund:export-audit`，其余用 `pre-fund:export-channel`。 |
| 两个 PreFund action 均绑定同一 IPC，Policy 均为 single artifact | action binding registry；canonical policy fixture | Main 顺序提交逐渠道单 artifact job，再把全部 staging artifact 交一次 durable Publisher；任一生成/校验失败均不得发布部分渠道。 |
| PreFund side run 有 `status`、`archive_task_run_id`、`archive_terminal_ack_at`，主库 mirror 保存 exact side locator | run store 与 service receipt/ack 方法 | v1 managed gate 仅接受 `status=success` 且 terminal 已 ACK、mirror 身份一致的 run；同时复核当前来源 snapshot，拒绝 revoked/stale。 |
| PreFund Workbook 依赖 bundled template，路径稳定不等于内容稳定 | `pre-fund-reconciliation/excel-writer.js` 与 `service.templatePath` | 模板 SHA-256/byteSize 必须进入 stable evidence/sourceDigest，并由 Main、Worker、发布前 freshness 一致复核。 |
| Position 只有 import dispatcher；`run:export` 与 `run:export-filtered` 当前直接在 Main 调 service/ExcelJS，不存在 export dispatcher 或 `adapter.position:export-run` 实现 | 全仓 `dispatch/Worker` 搜索；Position service/excel-io | 冻结表中的 `existing-dispatch` 与当前拓扑矛盾，不能伪造 adapter/compound lease。顶层规范纠偏为模块专用 `native thread-single`，历史冻结包保留，E13-G 重建 current-tree fixture。 |
| Position run 导出允许 current pending；差异导出允许 pending/confirmed；pending 必须 snapshot current；结果导出成功后会写 `exported_at` | Position service/store | Worker 只读重验 status/snapshot/筛选集合；`markRunExported` 从 writer 路径移到 Publisher 成功后的 Main settlement，差异/筛选导出不写 metadata。 |
| Position filtered export 还依赖冻结 anomaly report 的 artifact key/hash/size | `resolveRunFilteredReports`、`writeRunFilteredSourcesWorkbook` | Main 解析并核验 archive artifact，Worker 只读消费受管 source；发布前再次核对 report 引用集合，禁止缺失或被替换。 |
| VCC dataset 现有 `export-dataset` module worker 以普通可写 DB 打开并执行 migrations；import audit 当前是 Main direct task | VCC service、backend worker entry、audit writer | E13-B 新建专用 read-only worker；不得从 managed runtime 再调用现有 worker形成双层 spawn，也不得在只读任务执行 migration。 |
| VCC dataset preview 已冻结 total/exportable/missing/incomplete 明细，`vcc_fin_op_datasets` 提供 `(target_month,dataset_type,revision)` 持久变更 authority，writer 在同一 read transaction 重验；archive source 另有 hash/size 核验 | dataset writer/service/importers | stable evidence 必须同时包含 inspection、dataset revision 和 archive set；保留用户确认后的历史 lineage incomplete 导出说明；archive integrity failure 继续 fail closed，不把“历史未绑定”与“已绑定损坏”混为一谈。 |
| VCC import audit 可服务于成功或失败的终态导入，但 `importing` 不是稳定来源 | import record shape、audit writer、data manager UI | managed gate 接受有 finished evidence 且 anomaly count>0 的终态 record；拒绝 active/importing、记录消失或 anomaly 集合变化。 |

## Unknowns Register

| 未知 | 类型 | 影响 | 处理 | 最便宜验证方式 | 当前决定 |
| --- | --- | --- | --- | --- | --- |
| PreFund audit 是否必须拆成独立文件/入口 | 输出契约 | 高 | PROBE（已关闭） | 入口→run iterator→writer sheet 数据流 | 不拆文件；以是否含审计 sheet 分类逐渠道 action。 |
| PreFund 多渠道怎样满足 `maxArtifacts=1` 且保持原子性 | 发布/部分失败 | 高 | PROBE（已关闭） | N channel + 第 k 个失败 + Publisher failure fixture | 每 worker job 一个 artifact；Main 收齐并回读后单批 Publisher。 |
| PreFund 数据 revision 未变但模板被替换时是否会误发布 | 来源/Workbook 契约 | 高 | PROBE（已关闭） | freeze 后替换模板并执行 Worker | 旧 path-only 证据不足；现冻结模板 hash/size，漂移时 Worker fail closed 且不留 artifact。 |
| Position `existing-dispatch` 指向哪个既有 dispatcher | 拓扑/资源合同 | 高 | PROBE（已关闭） | 全仓 dispatch/worker/adapterKey 搜索 | 不存在；顶层 Spec 纠偏为 native，禁止复用 import dispatcher 或伪造 topology。 |
| Position `exported_at` 更新失败怎样呈现 | 写后元数据 | 高 | PROBE（已关闭） | Publisher 成功 + injected metadata failure | 文件保持已发布，记录 warning/诊断；不能回滚已发布文件或返回“文件未生成”。 |
| VCC incomplete dataset 是否属于 partial run | 历史兼容 | 高 | PROBE（已关闭） | inspect 分支与说明 sheet golden | 它是已终态数据的历史 archive lineage 缺口；用户确认后保留，绑定 artifact 损坏仍禁止导出。 |
| VCC import audit 哪些状态可导出 | 状态生命周期 | 高 | PROBE（已关闭） | success/failed/all-skipped/importing/deleted fixtures | 以 `finished_at` + 非 importing + anomaly count 为终态 gate；deleted 仍可审计既有异常，不读取已删除主体结果。 |
| VCC dataset 内容同数量变化能否被 inspection 捕获 | 并发/陈旧来源 | 高 | PROBE（已关闭） | freeze 后同数量修改金额并推进 dataset revision | inspection 单独不能捕获；stable evidence 增加 dataset revision digest，Worker/Main freshness 均 fail closed，避免在 Main 全量扫描大表。 |
| Windows/RSS/真实资金文件与人工抽查 | 发布盲区 | 高 | BLOCK（production） | R3.2.5 Windows/观察/人工门禁 | 不阻止 dormant capability；阻止 production/正式发布结论。 |

## Contract Reconciliation

- 顶层 [spec.md](./spec.md) 的 `position:export-run` 改为 `native thread-single`；这是对真实拓扑的纠偏，不改变用户入口、业务结果或生产策略。
- 顶层 [spec.md](./spec.md) 与 [techdoc.md](./techdoc.md) 明确 Position utility-process/child_process adapter 仅属于 `position:import`（E13-F），不适用于 E13-B export；“不改成 thread”的非目标和 adapter 禁令均精确约束 import dispatcher，不否定 3.1 已列出的 native read-only export。
- 历史 contract-baseline 保持原样，作为“实施前冻结证据”；current-tree Policy/Manifest/AST fixture 在 E13-G 依据最终代码重建，不通过伪造 `existing-dispatch` 让旧 fixture 变绿。
- 所有 E13-B capability 仍 `production.enabled=false/effectiveMode=legacy`；本纠偏不授权启用生产。

## 风险优先计划

| 顺序 | 步骤 | 保护的不变量 | 成功证据 | 回滚/收缩 |
| --- | --- | --- | --- | --- |
| 1 | 固化三模块稳定来源证据和 Position topology 纠偏 | 不读 partial/stale、不虚报 adapter 资源 | stable evidence 正反测试、Policy 结构测试 | 全部保持 legacy。 |
| 2 | PreFund 单渠道最小切片 + 整批 Main 编排 | 渠道顺序、四/五 sheet、行数守恒、N 文件原子性 | channel/audit golden、k-th failure/publish failure | 按 handler 保留 legacy。 |
| 3 | Position run/filtered 专用只读 worker | run/snapshot/filter/report 血缘、结果行序、样式 | pending/confirmed/stale/filter golden | 不更新 exported_at，legacy 继续生效。 |
| 4 | VCC dataset/audit 专用只读 worker | incomplete 说明、archive integrity、异常顺序 | raw/check/audit golden、active/stale/tamper | 保留现有 module worker/direct task。 |
| 5 | Main validator/Publisher/metadata 时序、取消和回归 | artifact 全有或全无、失败不改业务 DB/Hold | tamper/cancel/crash/metadata tests + 允许的 unit/integration/smoke | production 维持 false。 |

## Blindspot / Reconciliation Gate

- ⚠️ 资金红线，请人工复核：PreFund 渠道/重复审计行、Position run/差异筛选、VCC 金额币种和异常样本必须用真实业务文件抽查；自动 workbook golden 不能替代。
- PreFund 每渠道 `channelBillCount === unbalancedCount`、重复标记存在时 audit 行不能为零；跨渠道任何失败不得留下部分正式输出。
- PreFund bundled template 的 hash/size 必须与冻结 evidence 一致；模板漂移不能靠旧 run 绿灯代偿。
- Position 行序继续是 channel/month/source_order/id；filter 集合、difference status 与 report artifact 身份必须完整进入 stable evidence。
- VCC 已绑定 artifact 的 hash/size 不一致必须 fail closed；不能降级成“历史不完整”继续导出。
- VCC import audit 的 source lineage 与异常字段 JSON 损坏时必须 fail closed，不能静默输出空来源/空异常字段。
- 生成失败、取消、source stale、validator 或 Publisher 失败均不得写业务 metadata、关闭 Recovery Hold 或启用 production。
