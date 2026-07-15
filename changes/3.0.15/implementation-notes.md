# 3.0.15 Implementation Notes — 重复入金匹配

> owner: PM / Dev 共用
> created: 2026-07-14
> status: document-statement enrichment implemented; final release gates and human fund review pending
> rule: 只记录可验证事实；并行草稿代码不自动等于完成证据

## Original request

- 目标：实施用户已批准的 v3.0.15“重复入金匹配”。
- PM 写入范围仅为本 change 的 `spec.md`、`test-spec.md`、`tasks.md`、`implementation-notes.md`。
- v3.0.15 只做重复入金匹配；`MPT_CHANNEL_OTHERS`、临时银行对账单、缺渠道账单顺延 3.0.16。
- 已确认：同一入口一次导入标准 46 列银行和标准 26 列单据；银行 BizId 非空唯一；七字段分组；仅 1R+2I；其余 Reversal 组人工；纯 Inbound 统计；全月份 MPT INBOUND 查询；MPT 与单据唯一/不复用/字段校验；两 sheet；当前启动周期；完整测试与资金人工复核。

## Decisions

| ID | 决策 | 理由 / 影响 | Spec |
|----|------|-------------|------|
| D-01 | 本版只有独立“重复入金匹配”模块。 | 防止 3.0.14 前置资金对账继续膨胀；三项旧 roadmap 统一到 3.0.16。 | §2.3, AC-01 |
| D-02 | 银行输入为单份 `.xls/.xlsx`、`渠道对账单`、标准 46 列。 | 复用唯一标准 reader，避免列语义漂移。 | §5.2 |
| D-03 | BizId 以 trim 后字符串判空和全文件唯一，大小写敏感；原值不改写。 | BizId 是银行行审计锚点；在落库前 fail closed。 | §5.2 |
| D-04 | FundType trim 后只认大小写敏感的 `Reversal`/`Inbound`。 | 锁定相关行全集；其它值只统计。 | §5.3 |
| D-05 | Reversal 只读 Debit、Inbound 只读 Credit；金额用精确十进制字符串。 | 避免非方向字段误报及浮点错组。 | §4, §5.3 |
| D-06 | 银行分组键是结构化七元组；文本不 trim、大小写敏感。 | 保守分组，防止自动合并潜在不同资金主体。 | §4, §5.3 |
| D-07 | 只有严格 1 Reversal + 2 Inbound 进入 MPT。 | 这是自动确认的最小完整业务形态。 | §5.3 |
| D-08 | 其它含 Reversal 组整组人工；纯 Inbound 只统计。 | Reversal 不得静默遗漏；无 Reversal 不生成召回/人工负担。 | §5.3 |
| D-09 | MPT 只查全部保留月份的 INBOUND，且 tradeType 必须为 `Inbound-VA`。 | 用户明确无日期窗口；不把 OUTBOUND/linked pool 混入。 | §5.4 |
| D-10 | 每条银行 Inbound 以 trim 后、大小写敏感的 Channel + MerchantId + ReconciliationId 查询。 | 与 MPT 导入规范化一致；不做模糊或 fallback 匹配。 | §4, §5.4 |
| D-11 | MPT 行不去重、不按月份择优；每条持久行都是独立候选。 | 同键多行本身就是不确定性，必须人工。 | §5.4 |
| D-12 | 自动成功要求每条 Inbound 恰好 1 候选、组内 ID 不同、跨组不复用。 | 阻止 first-wins 和同一资金行重复消费。 | §5.5 |
| D-13 | 跨组共享候选时所有受影响组人工。 | 结果与遍历顺序无关，保守处理资金冲突。 | §5.5 |
| D-14 | 两 MPT 只校验 trim 后非空且一致的 oppBu；clientId/accId/business 不再参与。 | 客户号、账户号已改由单据提供，继续拦截 MPT 旧字段会制造无依据人工组。 | §5.5 |
| D-15 | MPT raw 无法解析/不是 object 为运行硬错误。 | 数据完整性损坏不能伪装成普通人工不确定。 | §5.4, §5.9 |
| D-16 | 固定一个工作簿、两个 sheet；邮件 10 列，人工 46+原因。 | 与业务模板及审计需求一致。 | §5.7 |
| D-17 | 成功/人工/纯 Inbound 采用唯一 disposition，并执行三条银行守恒与 MPT 唯一断言。 | 防止静默丢行、重复行和半组成功。 | §5.6 |
| D-18 | 银行/单据详细数据和三方血缘只进当前周期 side DB，主库仅轻量 mirror。 | 符合 run-scoped policy 和敏感数据最小化。 | §5.8, §8 |
| D-19 | 重启清空银行/单据会话和结果；MPT 保留月份不清空。 | 用户明确“当前启动周期会话”，同时复用 v3.0.14 持久来源。 | §5.8 |
| D-20 | 结果绑定同一银行/单据 import 与全部 INBOUND MPT snapshot；INBOUND 变化 stale，OUTBOUND-only 不 stale。 | 避免导出与运行时不同的数据集，又不制造无关失效。 | §5.8 |
| D-21 | 开始新 run 即禁用旧结果；失败不回退旧导出。 | 防止用户误把旧 snapshot 当作当前运行结果。 | §5.8 |
| D-22 | 模块默认关闭。 | 维持升级用户的现有功能柜和主流程。 | §5.1, §6 |
| D-23 | 不自动发送邮件。 | 本版输出是邮件数据载体，不是邮箱集成。 | §2.3 |
| D-24 | 每个保留月份把 reconciliationId 集合写入 TEMP 表，再以一次 JOIN 批量读取候选。 | 避免按银行行逐条 SQL 和百万级候选常驻内存；查询仍返回该月全部匹配持久行，不改变零/多候选语义。 | §5.4, AC-10/26 |
| D-25 | 同一导入入口一次选择一份银行账单和一份单据对账单；任一失败整批回滚。 | 保持三按钮 UI，并确保运行输入不可形成半会话。 | §5.2 |
| D-26 | 两个 MPT orderId 均须非空、各唯一命中不同单据；单据三字段非空且一致，业务部门还须等于 oppBu。 | 新模板明确取数和校验来源；失败仅转当前组人工，不阻断其它组。 | §5.5.1 |
| D-27 | 单据流式写入当前周期 side DB，主库只镜像文件名/hash。 | 真实单据约 9 万行，需有界内存并避免个人信息进入主库。 | §5.2, §5.8 |
| D-28 | `.xlsx` 文件类型识别只流读 `xl/workbook.xml`，不使用 SheetJS 解压整份工作表；`.xls` 银行仍走兼容路径。 | 真实单据的 sheet XML 解压后约 138 MB，SheetJS `bookSheets` 仍造成高峰内存，违背流式导入目标。 | §5.2, AC-26 |

## Assumptions

| ID | 等级 | 假设 | 保护措施 | 状态 |
|----|------|------|----------|------|
| A-01 | ASSUME | 新 module id 遵循功能柜现有命名和默认关闭约定。 | 可逆设置；不改变业务数据或资金结果。 | 已纳入 D-22 |
| A-02 | ASSUME | 默认文件名日期取导出时操作系统本地日期。 | 单测跨 UTC/本地日期边界；用户仍可在另存为修改文件名。 | 已纳入 spec |

没有未披露的行为型假设。任何涉及键、金额、候选、数据保留、输出列或失败回退的歧义都不得按 ASSUME 处理。

## Deviations

| ID | 来源 | 偏差 | 处理 | 状态 |
|----|------|------|------|------|
| DV-01 | v3.0.14 spec §1.2 的 roadmap | `MPT_CHANNEL_OTHERS`、临时银行对账单、缺渠道账单原写“顺延 3.0.15”。 | 用户本次明确改为顺延 3.0.16；3.0.15 不实现。发布文档后续需同步，现不回改 3.0.14 历史文档。 | 已批准 |
| DV-02 | 工程门禁 | 原 `scripts/check-vars.js` 只读取 Git 已跟踪改动，会漏掉本次尚未暂存的新建 `src/**/*.js`。 | 扫描器纳入未跟踪源码；新增回归，确保新模块在提 PR 前也能命中重要变量。业务行为不变。 | 已修复 |
| DV-03 | 真实样本复核 | 初版把“业务来源”取自 MPT `business`，且完整复制模板说明行样式使数字型 Debit Amount 被 Excel 按日期显示。 | Reverse Sync 为 `业务来源=oppBu`，只校验 MPT `oppBu` 非空一致；Debit Amount 数据行覆盖为“常规”格式。 | 用户已确认字段来源；已修复 |
| DV-04 | 用户更新输出模板 | 客户号/账户号不再取 MPT clientId/accId，并新增单据业务部门与 oppBu 校验。 | 改为双文件原子导入、单据唯一匹配和分组级人工；真实样本最终回放为 9 成功 + 1 人工。 | 用户已确认；已修复 |

## Evidence

| 日期 | 证据 | 结论 | 完成含义 |
|------|------|------|----------|
| 2026-07-14 | `AGENTS.md`、`CODEX.md`、`rules/*` | 明确分支、run-scoped、重要变量、资金 unknown 和交付规则。 | 仅为规则基线，不代表实现通过。 |
| 2026-07-14 | `changes/templates/*`、`docs/templates/PRD-template.md`、`docs/templates/TechDoc-template.md` | 四份 change 文档需覆盖背景、现状、目标、技术决策、数据状态安全、测试和任务。 | 文档结构依据。 |
| 2026-07-14 | `changes/3.0.14/*`、`docs/iterations/v3.0.14/PRD-v3.0.14.md` | v3.0.14 已定义 MPT 持久月份和旧 roadmap；本版只读复用 INBOUND。 | 范围和兼容基线。 |
| 2026-07-14 | `src/constants/bank-statement-fields.js`、`src/main-process/bank-statement-io.js` | 标准银行账单为固定 46 列、`渠道对账单` sheet。 | 输入契约依据。 |
| 2026-07-14 | `src/main-process/pre-fund-reconciliation/mpt-schema.js`、`src/backend/pre-fund-reconciliation-store.js` | MPT INBOUND 按月份侧库保留，含本需求所需字段。 | 全月份只读方案可行。 |
| 2026-07-14 | 解包只读检查 `assets/重复入金召回邮件模板.xlsx` | 原模板有 10 个业务列；说明要求两 orderId 用 `、`，备注固定 `重复入账后被Reverse`。 | 输出映射依据；未改资产。 |
| 2026-07-14 | duplicate-inbound matching/store/service/reader/writer/migration focused tests **59/59** | 覆盖双文件类型识别、单据中途失败原子回滚、MPT `oppBu`、单据 orderId 唯一匹配、字段空/冲突/业务部门校验、三方血缘、MPT 旧 clientId/accId 旁路、生命周期和 Excel 取数。 | 本次增补核心分支实现证据。 |
| 2026-07-14 | 最终重跑 `npm run release-check`；unit 日志 `logs/unit-tests/unit-20260714-101517.log` | ESLint、smoke、unit **3544/3544**、integration **40 个脚本 / 1870/1870** 全部 PASS；新增端到端脚本 **28/28**；集成总耗时 85060 ms。 | AC-26 / P0-44 自动门禁通过。 |
| 2026-07-14 | `npm run benchmark:duplicate-inbound` | 6 个保留月份、150000 条 MPT、6000 个银行查询键：fixture 472.0 ms，查询 78.1 ms；RSS 81.7→104.4 MiB，heap 9.2→25.2 MiB；每月一次批量 SELECT，全部唯一命中。 | U-01 收敛；证明查询次数随月份而非银行行逐条增长。 |
| 2026-07-14 | `npm run startup:measure` | process 平均 643.737 ms、ready-to-show 170.652 ms、window-to-visible 101.382 ms、renderer init 50.06 ms。 | 新模块默认关闭时无明显启动回归证据。 |
| 2026-07-14 | `npm run preview:duplicate-inbound-match` + `docs/previews/duplicate-inbound-match-panel.png` | 3.0.15 面板布局、三个按钮、初始“欢迎使用小助手”、状态区和模块可见性无重叠。 | macOS Electron 视觉证据；不替代 Windows Excel/WPS。 |
| 2026-07-14 | `duplicate-inbound-match-end-to-end.js` **28/28** 的主库/侧库检查 | 主库无银行姓名卡号或单据客户/账户值；重启后当前周期 side DB 物理回收；银行/MPT/单据血缘在有效周期内可反查。 | AC-23/25、P0-37/42 隐私与生命周期证据。 |
| 2026-07-14 | 用户真实银行输入与首次导出只读复核 | 首次导出 10 行 Debit Amount 均为金额数值但继承 `mm-dd-yy`；业务来源均为 business=`MPT`。20 条命中 MPT 的 oppBu 为 SMB/B2B，且 10 个成功组内均一致。 | 复现两个问题，并证明按 oppBu 输出不会改变该样本的成功/人工分组。 |
| 2026-07-14 | 在隔离 userData 中重放用户提供的 32814 行银行文件及现有只读 MPT 月份库 | 成功组仍为 10、人工组 0；10 行 Debit Amount 均为数值且回读为 General；业务来源为 SMB 9 行、B2B 1 行。 | 两项修复在真实样本上成立，且该样本分组结果未改变。 |
| 2026-07-14 | 在全新隔离 userData 中导入 3 份真实 INBOUND MPT、32814 行银行和 90885 行单据，并导出回读 | 最终 **9 个邮件组、1 个人工组（3 行）**；人工原因为单据零候选；Reversal 守恒；邮件/人工回读 9/3；主库未出现成功邮件中的客户号或账户号值。 | 用户要求的最终真实样本计数与三方取数链路成立；仍须资金负责人看样签字。 |
| 2026-07-14 | 独立进程流读真实 90885 行单据 | sheet 识别 + 全文件读取峰值 RSS **80.7 MiB**；RSS 54.7→80.7 MiB，heapUsed 5.1→5.9 MiB；90885 行全部回调。完整银行+MPT+单据进程峰值约 1.3 GiB，既有 MPT/46 列银行解析仍是剩余性能风险。 | 证明新增单据读取器有界内存；不把整体链路既有高峰伪报为已解决。 |
| 2026-07-14 | `npm run scan:vars` | 版本 3.0.15；189 个 JS / 2080 顶层声明；A-share 335 / A-pair 547 / A-local 1065 / B 882。 | v20 变量基线已刷新。 |
| 2026-07-14 | `npm run check:vars -- --include-minor` | 命中 Critical `FileValidationError`；Important `ipcRenderer`；Runtime `MODULES/dialog/elements/state/updateStatusBox`；Risk-sensitive `DuplicateInboundMatchService/buildDuplicateInboundGroups/hasColumn/lookupInboundRows/resolveDuplicateInboundDocumentMatches/resolveDuplicateInboundMptMatches`。命中项已逐项 review；命令以 exit 2 表示“发现命中”，不是测试失败。 | 硬节点扫描和关联功能 review 证据。 |

### 尚待人工证据

- [ ] Windows Excel/WPS 两 sheet 视觉核对。
- [ ] 资金负责人人工复核样本、守恒计算、血缘反查和签字。

## Reconciliation Blindspot Pass

> 扫描范围：银行账单、MPT 候选、金额/币种、匹配状态、Excel 输出与当前周期存储。
> 结论：存在资金红线，已转化为 spec 不变量和发布硬门禁；未发现可安全放宽的自动 fallback。

### 1. Critical — MPT 候选跨组复用导致同一入金被重复召回

- 证据：同一 MPT 行可能因银行键重复被多个 1+2 组查询到；边遍历边消费会由输入顺序决定赢家。
- 触发条件：两个或更多组的单候选集合共享同一“月份 + 行 ID”。
- 失败后果：同一加款单可能被重复召回，或另一真实组被静默遗漏，属于潜在资损/客户误处理。
- 当前防线：D-12/D-13；两阶段全局裁决；所有共享组整组人工；MPT 唯一断言。
- 自动证据：跨组共享链、反序输入稳定排序、所有受影响组人工、运行摘要复用计数和人工原因测试均已 Green。
- 是否需要人工确认：**是，资金负责人必须确认“全部冲突组人工”符合业务容错。**

### 2. Important — 金额方向或规范化错误改变银行组

- 证据：Reversal 与 Inbound 使用不同金额列；浮点、科学计数或空格策略会改变等价关系。
- 触发条件：高精度/大金额、负零、非法方向金额、非方向字段脏值。
- 失败后果：错组、漏组、币种下金额误匹配，邮件金额与真实交易不一致。
- 当前防线：D-05/D-06；精确十进制字符串；Currency 入键；非法方向金额 fail closed。
- 自动证据：方向字段隔离、等价/高精度/负零、科学计数与千分位拒绝、文本空格/大小写和结构化键碰撞 corpus 均已 Green；金额 key 不使用浮点计算。
- 是否需要人工确认：是，抽样复算金额与币种。

### 3. Important — 全月份边界与混合 snapshot

- 证据：候选来自多个持久月份；运行期间批次可被替换/删除。
- 触发条件：查询跨月份时并发导入/删除，或仅以最新月份查询。
- 失败后果：零/多候选判定不稳定，同一导出混合两个数据版本。
- 当前防线：D-09/D-20；全部月份、INBOUND fingerprint、共享锁/前后复核、stale 禁导出。
- 自动证据：跨月命中、INBOUND 新增/替换/删除 stale、OUTBOUND-only 不 stale、运行前后 snapshot 复核及共享操作锁均已覆盖。
- 是否需要人工确认：是，确认业务确实不设月份窗口。

### 4. Important — 人工组或纯 Inbound 处置造成行数不守恒

- 证据：相同 pipeline 同时存在成功、银行计数人工、MPT 人工、纯 Inbound、忽略五种路径。
- 触发条件：组级失败只写部分行、成功后重复追加、ignored 与 pure inbound 混淆。
- 失败后果：Reversal 行消失、同一银行行重复出现、人工无法看到完整上下文。
- 当前防线：D-17；唯一 disposition；三条守恒；整组人工；稳定源序号。
- 自动证据：混合成功、银行人工、MPT 人工、纯 Inbound、忽略行 fixture 与 Reversal/相关行/MPT 唯一硬断言均已 Green。
- 是否需要人工确认：是，逐项复算输出和统计。

### 5. Important — 固定邮件列隐藏内部匹配血缘

- 证据：业务模板只有 10 列，没有银行 Inbound BizId 或 MPT 行 ID。
- 触发条件：用户质疑某邮件行时只查看导出文件。
- 失败后果：无法仅凭 Excel 解释自动判定，问题排查依赖不可见状态。
- 当前防线：成功组在当前周期侧库保存 Reversal/Inbound BizId、源序号、两个 MPT 月份/行 ID，以及两个单据文件/源行/匹配单号；邮件列保持业务契约。
- 自动证据：side DB audit 可反查银行、MPT 和单据三方血缘；端到端验证重启物理回收，邮件固定列不扩张。
- 是否需要人工确认：是，确认“Excel 固定列 + 侧库血缘”满足当前审计要求。

### 6. Important — 敏感姓名、卡号、账号进入主库或日志

- 证据：分组键含双方姓名卡号；邮件含客户号/账户号。
- 触发条件：错误对象序列化完整 row、run mirror 保存 raw、进度打印 key。
- 失败后果：敏感数据超生命周期保留或出现在常规日志。
- 当前防线：D-18/D-27；side DB 当前周期；主库仅摘要和两份文件名/hash；错误以行号/BizId 局部定位并避免原始身份字段。
- 自动证据：主库文件/WAL 敏感哨兵扫描、mirror error code 脱敏和 side DB 生命周期测试均已 Green；真实环境日志仍纳入人工抽查。
- 是否需要人工确认：安全/业务负责人抽查。

### 盲区扫描结论

- 必须新增/保留测试：候选跨组复用、顺序置换、高精度金额、全月份与并发 snapshot、混合处置守恒、血缘完整性、隐私落点、原子导出。
- 必须补真实数据验证：生产规模月份池性能、实际重复键分布、Excel/WPS 长数字展示。
- 属于有意设计而非缺陷：纯 Inbound 不导出；空/重复单据订单号不阻断导入但被引用时转人工；银行分组文本不 trim；结果重启失效。
- ⚠️ **资金红线，请人工复核。** 在人工复核签字前不得将该功能标记为可发布。

## Remaining unknowns

| ID | 等级 | 内容 | Owner | 下一证据 | 状态 |
|----|------|------|-------|----------|------|
| U-01 | PROBE | 生产规模下各月份批量查询和 side DB 写入性能。 | Dev | 6 月份 / 15 万 MPT / 6000 查询键基准。 | resolved（查询 78.1 ms；RSS 增量约 22.7 MiB） |
| U-02 | PROBE | Windows Excel/WPS 对模板样式、长卡号/单号、长原因的显示。 | Dev + QA | 截图/人工核对记录。 | open |
| U-03 | PROBE | 实施是否完整接通 main-process service/IPC/lifecycle。 | Dev | wiring tests + 28/28 端到端集成。 | resolved |
| U-04 | BLOCK（发布） | 资金负责人尚未完成全月份、唯一不复用、守恒和血缘人工复核。 | 业务负责人 | `test-spec.md` §8 签字记录。 | blocks release, not implementation |
| U-05 | PROBE | 90885 行真实单据是否保持有界内存。 | Dev | 独立流读进程内存测量。 | resolved（峰值 RSS 80.7 MiB；heapUsed 增量 0.8 MiB） |
| U-06 | PROBE | 完整真实链路的既有 MPT/银行解析峰值内存偏高。 | 后续性能迭代 | 分离 MPT 导入与 46 列银行 SheetJS 解析 profile。 | open；不由本次单据流式读取扩张 |

## Check-vars Review

- `FileValidationError`：标准 46 列、sheet、BizId 和 MPT raw 的 fail-closed 校验仍使用统一错误契约；错误摘要不写银行 raw/姓名/卡号。
- `ipcRenderer`：main/preload 的 import/status/run/export channel 与三个进度事件一致，wiring test 和端到端流程已覆盖。
- `MODULES` / `ALL_MODULE_IDS`：两端都包含 `duplicate-inbound-match`；默认启用列表未增加该模块，升级用户可见模块不变。
- `dialog` / `elements` / `state` / `updateStatusBox`：取消选择保持状态；选中新文件立即使旧结果失效；按钮资格和状态文本由单一 renderer state 更新；Electron 预览无重叠。
- `DuplicateInboundMatchService` / `buildDuplicateInboundGroups` / `lookupInboundRows` / `resolveDuplicateInboundMptMatches`：精确金额、七元组、1R+2I、全月份 INBOUND、候选不复用、身份一致、snapshot、守恒及双 sheet 输出已由 unit/integration/benchmark 覆盖。
- `npm run scan:vars` 已刷新 v20 基线；`npm run check:vars -- --include-minor` 已执行并完成上述人工关联 review。后续若提 PR 或合并受保护分支，仍须在对应硬节点重跑。

## Implementation log

### 2026-07-14 — PM/spec baseline

- 动作：读取项目规则、change/PRD/TechDoc 模板、v3.0.14 文档、相关银行/MPT 存储事实和邮件模板；完成 unknowns-first 与 reconciliation blindspot pass。
- 证据：见 Evidence 表。
- 风险：候选复用、金额规范化、全月份 snapshot、守恒和血缘均为资金高风险点。
- 决策：全部转为明确算法、不变量、测试和人工发布门禁；不修改并行 Dev 代码。

### 2026-07-14 — Dev implementation and automated verification

- 动作：完成 current-cycle side DB、轻量 run mirror、严格银行导入、分组与全局 MPT 裁决、双 sheet writer、IPC/UI、版本文档和门禁脚本接线。
- 性能实现：MPT 查询按月建立 TEMP reconciliationId 集合，每个月执行一次 JOIN 批量读取，避免每行 SQL 与全库候选常驻内存。
- 验证：完整 `release-check`、多月份基准、启动性能、Electron 预览、scan-vars/check-vars、隐私与重启清理均已有 Evidence。
- 收尾 review：发现运行状态框未展示后端已有的 MPT 零/多候选、跨组复用、身份冲突和总分组计数；补齐 summary/UI/wiring test 后重跑完整门禁，匹配与导出数据未改变。
- 故障注入 review：发现 side DB 清理抛错时，旧银行会话或旧运行结果可能在内存中继续保留；调整为先让旧状态失效、再清理侧库，并新增新导入/新运行两条失败用例，确保异常路径 fail closed。
- 真实样本反馈：修复 Debit Amount 继承日期格式和业务来源误取 business；匹配公共字段、邮件映射、writer 格式及 spec/test/docs 已同步到 oppBu 口径。
- 未完成：Windows Excel/WPS 人工打开，以及业务负责人使用真实脱敏样本完成资金复核签字；两项均阻塞发布，不阻塞代码实现。

### 可沉淀知识

- [ ] 若该需求验证通过，可将“资金匹配必须先构建全局候选关系、禁止 first-wins”沉淀到资金匹配通用规则。
- [ ] 可将“业务固定 Excel 列与内部审计血缘分层保存”沉淀到输出设计规范。
- [ ] 可将“snapshot 只纳入实际候选 source type，避免无关 stale”沉淀到 run-scoped policy 示例。

## Handoff / Completion

- 代码实现、版本 bump、三份版本文档、自动化回归、性能/启动探针、macOS Electron 预览和 check-vars 关联 review 已完成。
- 当前分支：`codex/v3.0.15-duplicate-inbound-match`；未创建 commit、未推送、未创建 PR。
- 发布阻塞：U-02 Windows Excel/WPS 人工打开；U-04 真实脱敏样本资金复核与签字。完成前 AC-27 不通过，不得把 v3.0.15 标记为可发布。
- 回滚边界：关闭/移除新模块 UI、IPC、side DB 和轻量 mirror 即可；不得删除或改写 v3.0.14 已保留的 MPT INBOUND 批次。
