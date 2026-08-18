# 重要变量清单

> 手工维护的"关键变量"清单。**每次代码变动前必读**，命中条目要在改动完成后做关联功能 review。
>
> 全量自动统计在 `docs/analysis/var-reference-stats.md`（由 `npm run scan:vars` 生成）。
> 触发节点与 review 流程详见 `CLAUDE.md` § 重要变量变动 check。

## 元数据

| 字段 | 值 |
|---|---|
| 当前清单版本 | v36（app v3.1.11 — Task Run/File Batch 解耦、非空 FilePlan 原子发号、精确 dataset/run lineage、Archive 十四表与 017/018 定点维护） |
| v36 本轮 review | 2026-08-18（以 `origin/main@35f11e153962c34cba0e9d4c7084e9df85c9f209` 为代码基线，复核共享工作树 63 file / 59 no-file / 117 exclude、TaskLifecycle/Archive/VCC/Position/Acquiring/Pending/Biz OP/Pre-fund 跨层合同；不 rebase、不覆盖既有改动） |
| v36 基线数据 | `docs/analysis/var-reference-stats.md`（337 个 git-tracked JS / 4458 个顶层名称；A-share 649 / A-pair 947 / A-local 2695 / B 1596；报告版本 3.1.11） |
| v35 历史版本 | app v3.1.10 — VCC storage contract v2、精简事实/异常审计、Archive source/hold 血缘与 copy-on-write 原子迁移。 |
| v35 本轮 review | 2026-08-17（以 annotated `v3.1.9^{commit}`=`3edf0527d6537d29cb19b48bda2a3f91f0ce6e32` 为 release baseline，覆盖 28 个生产文件；升格 VCC storage capability/guard、VCC COW migration/recovery、import source/Archive hold/durable handoff，并把 Archive 元数据合同从九表扩为十表） |
| v35 基线数据 | `docs/analysis/var-reference-stats.md`（当时 328 个 tracked JS / 4299 个顶层名称；A-share 623 / A-pair 912 / A-local 2598 / B 1535；报告版本 3.1.10） |
| v34 历史版本 | app v3.1.9 — 全局任务生命周期、稳定关联任务身份、exact-seven worker batch context、存档九表审计血缘与真实归档/恢复/迁移。 |
| v34 本轮 review | 2026-08-11（以 annotated `v3.1.8^{commit}`=`688ae2cb4a85d2fe8d74bdbefb06c6e3056ddcfa` 为 release baseline，覆盖 PR1—PR6 的 75 个生产文件；升格 `freezeWorkerBatchContext`、`TaskLifecycle`、`TaskPolicyRegistry`、`BusinessFlowResolver`，并校正 Archive operation/repository/service 生命周期条目） |
| v34 基线数据 | `docs/analysis/var-reference-stats.md`（320 个 tracked JS / 4102 个顶层名称；`freezeWorkerBatchContext` 跨 21 个文件、53 次总引用、5 处声明；报告版本 3.1.9） |
| v33 历史版本 | app v3.1.3 PR-E — 平盘银行/账户流式确认写入、专用 COMMIT 后恢复、百万级管理聚合、磁盘门禁及真实进度/取消。 |
| v33 本轮 review | 2026-07-31（覆盖银行整批 scope 替换与 BizId 唯一约束回滚、账户相同物理行独立身份、bank/account 文件凭证和 SQL 聚合恢复、scope covering index、来源摘要事务缓存、维护作业磁盘门禁、750ms monotonic heartbeat、main/worker 提交阶段双重拒绝取消及生产禁用 main 旧 reader 回退） |
| v32 历史版本 | app v3.1.3 PR-C1 — 平盘百万级导入共享 mutation、`row_hash` 来源身份迁移、archive apply 握手、schema fingerprint 与普通来源 worker exit 证据恢复。 |
| v32 本轮 review | 2026-07-30（覆盖普通来源 `sourceRecordKey`、链接/消费/运行血缘迁移、迁移磁盘门禁与事务回滚、schema-only checkpoint 不推进、pending manifest 持久化先于 apply、普通来源部分提交恢复及 bank/account fail-closed） |
| v31 历史版本 | app v3.1.0 — 平盘银行/五类链接表持久侧库、侧库初始化一致性门禁、十组 FundType 资金性质判断、账户别名归并、严格 1:1、49 列结果、回导确认和 snapshot 失效门禁。 |
| v31 本轮 review | 2026-07-28（覆盖主库 bulk 禁令、主库/side DB 同批备份与缺失阻断、运行 envelope 与明细一致性、原始/工作值隔离、Channel+月份替换、链接 revision、全局单一草稿、三字段 ReconID 候选冲突、调拨 signed `Extra Fee`、账户别名币种判断、零数据文本列、49 列防篡改和确认事务，以及存档替代源 SHA 恢复与 prepared staging 清理） |
| v30 历史版本 | app v3.0.26 — R5 两种调拨来源和多对多审计统一纳入 signed `Extra Fee`；DBS-Charge 显式保持旧无手续费口径；前置资金不平结果新增 `FundType` 并锁定 C4 三代列契约。 |
| v31 基线数据 | `docs/analysis/var-reference-stats.md`（218 个 JS 文件 / 2553 顶层声明；A-share 376 / A-pair 637 / A-local 1396 / B 1013；报告版本 3.1.0） |
| v29 历史版本 | app v3.0.25 — 设置全局【确认】保存存档保留期；模板“不存档”退役并归零历史配置；archiveCenter IPC 由 12 个收敛为 10 个。 |
| v28 历史版本 | app v3.0.24 — 12 个主模块 ID 全集；平盘对账纯前端占位；Payment `bigAccount` 严格顿号列表及按账号隔离的三轮 1:1。 |
| v27 历史版本 | app v3.0.23 — C3 专用 Channel trim+NOCASE 候选池；R4 四类固定资金口径、完整 exactRows、全局银行行 1:1 消费与 R4→R5 no-op 匹配血缘。 |
| v26 历史版本 | app v3.0.22 — 设置页存档中心：轻量元数据、SHA-256 Blob 去重、不可复用批次流水、11 模块首次结果绑定与后台归档队列。 |
| v25 历史版本 | app v3.0.21 — Ach Return 退款过滤改用 R1 具体配对；DBS-Charge 步骤2增加固定 TradeType 白名单和优先银行方向守卫。 |
| v24 历史版本 | app v3.0.19 — 工具箱单/多文件严格多 Sheet 合并、可见性过滤、顺序与表头守恒、流式写出和临时资源清理。 |
| v23 历史版本 | app v3.0.18 — Windows NSIS GitHub stable 在线升级、设置状态页、原子业务忙闸门、可等待退出清理与 tag 发布流水线。 |
| v22 历史版本 | app v3.0.17 — 退款订单银行流水号模糊匹配 + 工具箱最多 8 组一次扫描、多文件原子拆分；自动门禁通过，资金负责人真实退款样本复核仍为发布硬门禁。 |
| v21 历史版本 | app v3.0.16 — 前置资金对账纳入 `Extra Fee` 和 14 条 FundType/方向/tradeType 规则；临时 MPT 明细错误支持审计导出与逻辑排除重跑；`MPT_CHANNEL_OTHERS` 明确取消。 |
| v20 历史版本 | app v3.0.15 — 独立重复入金匹配，严格 1R+2I 七元组、全保留月份 INBOUND MPT 批量候选、全局不复用与身份一致裁决、当前周期 side DB、主库轻量镜像及固定双 sheet 原子导出；自动门禁已通过，资金负责人复核及 Windows Excel/WPS 人工打开待完成。 |
| v19 历史版本 | app v3.0.14 — 2026-07-12：前置资金对账严格 1:1、重复网关审计、双 side DB、按渠道 5/6-sheet；`ALL_MODULE_IDS` 为 10，per-月侧库为 4 个业务模块/5 个存储模块；自动门禁和人工资金复核均已完成。 |
| 清单版本 | v18（对应 app v3.0.13 — 2026-07-04 收尾复核 4 条：**大账号识别阻断**（`matchMerchantIds` 子串 fuzzy 不再作为自动放行依据 + `normalizeMaintainedBigAccounts` 单一展平器 + 识别优先读文件头部）；**调拨状态过滤可观测性**（`buildFundTransferReconRows` 仅派生 `付款成功` + `fundTransferReconDerive.warning` 提醒全过滤）；**`detectFundTransferManyToMany` / `manyToManyReviewRows` 输出口径**（异常说明并入「命中场景」第 2 列，note-only 行可见，独立异常 sheet 停用）；**C3 同值候选优先**（同值候选优先减少无意义覆盖）；触发：v3.0.13 收尾 check-vars 硬节点）；v17（对应 app v3.0.12 — 2026-06-28 v3.0.12 收尾升格 2 条 Risk-sensitive ⚠️🔴 资金红线：**账户映射 → 调拨对账单 `big_account` 派生**（`fund_transfer_account_mappings` 全局表 + 仓储三函数 + `database.js` facade 四方法 + `buildFundTransferReconRows` accountMappingMap 第 2 参 + `linked-derive-rebuild` 单点注入 run/导入两链 + IPC/preload/`createFundTransferAccountMappingDialog`；改「中台调拨订单对账ID回填」R5s2-recon + DBS-Charge R3.5 匹配大账号口径）+ **`detectFundTransferManyToMany` / `manyToManyReviewRows`**（异常-人工判断 sheet 检测器，纯只读不改回填/行数守恒 + writer `appendManyToManyReviewSheet`/`SHEET_MANY_TO_MANY_NAME` + orchestrator `manyToManyReviewCount` + writer 第 8 参透传）；触发：v3.0.12 收尾 check-vars 硬节点；v16（对应 app v3.0.5 — 2026-06-15 size-startup-optimization Part B 升格 2 条：**per-月侧库体系**（Risk-sensitive ⚠️🔴🔴 资金红线 — run-data-store/MODULE_*/SIDE_DB_DDL_*/三编排层/reconcileOrphans/side_db_rel_path + 三 parity 锁；Phase 1/2 三对账模块 run 级批量数据迁出主库）+ **`DEFERRED_WINDOW_STARTUP`**（Runtime-state ⚠️ 启动时序回退开关 + appInitDone/两段式 getInfo/init-done；Phase 3 启动窗口先行）；触发：v3.0.5 Phase 4 守卫固化 check-vars 节点；v15（对应 app v3.0.4 — 2026-06-11 收尾文档批升格 5 条 Critical/Risk-sensitive：`USE_BIG_TABLE_IMPORT_ENGINE_PENDING`/`USE_BIG_TABLE_IMPORT_ENGINE_BIZOP_FLOW` + 共享 dispatch（Critical 🔴🔴 pending/biz-op flow 换引擎）/ `BANK_DEPOSIT_FIELDS` 13→14（Risk-sensitive 🔴）/ BOC调拨订单修复链（Risk-sensitive 🔴）/ R5s2b Payment线下调拨回填（Risk-sensitive 🔴 + weekTag/excludeBankRowIds）；顺带修陈旧行号（`runC3Scenario`:81 / `writeBankStatementOutput`:106 5 参 / `processingResult`:311 结构补 unmatchedRows 等）+ `acquiring-engine-migration` 34→45 断言；触发：v3.0.4 收尾 check-vars 硬节点；v14（对应 app v3.0.0 — 2026-06-08 PR-4 升格 1 条 Runtime-state：`refundOrderSession`（R5 中台退款订单回填引擎入参源 + run 阶段注入 + 🔴 PR#65 收紧生命周期：单文件导入清 main.js:3494 / batch 本批未导退款表清 :11460 严格绑定「本批有效导入」；v3.0.0 需求3 经 session-status 透出 hasRefundOrder 供运行点 shouldPromptRefundAtRun 判就绪，本迭代只读不改写入/清空时机）；触发：v3.0.0 PR-4（退款提醒对齐 C3 + 候选预检 + 运行点编排）提 PR 前 check-vars 节点；v13（对应 app v2.1.16-beta.1）= 2026-06-07 阶段一 A0 收尾升格 3 条 Runtime-state：`bankStatementSession`（资金对账数据处理银行对账单进程级 session + v2.1.16 A5 多文件合并对账语义 + 🔴 `_rowId` 全局唯一不变量）/ `gatewayReconSession`（C3 网关账单数据源 + 导入银行对账单时清空）/ `processingResult`（5 轮对账运行结果缓存 + scenarios 变更/重导入时清空）；触发：v2.1.16 阶段一提 PR 前 check-vars 节点；v12 = 2026-05-28 Phase 6 T33 升格 5 条 v2.1.10 4 主线变量（Critical 4：`runCheckCore` / `clearStaleSuccessfulRawJson` / `ensureDiffRowsCascadeMigration_v2_1_10` / `acquiring_bill_currency_diff_rows` FK CASCADE schema + Important-skeleton 1：`serializeError`/`deserializeError` + 更新 `bill_imports.raw_json` 内容契约）；v11 = 2026-05-26 N1' + N4 升格 7 条；v10 = 2026-05-22 Phase 0 T02 升格 11 条；v9 = 2026-05-21 v2.1.7 T14 收口升格 10 条；v8 = 2026-05-19 v2.1.6 v0.7 fix4 收单流水侧对账字段切换 + DB 重命名 settle_*；v7 = 2026-05-18 acquiring-bill-currency 模块初版；v6 = v2.1.4 dev round 7 新增 2 条 Important-skeleton；v5 = v2.1.3 round 4 自 review 新增 2 条；v4 = v2.1.3 round 3 新增 3 条；v3 = v2.1.3 round 2 新增 1 条；round 1 已升格 13 条 v2.1.3 新符号保持） |
| 上次人工 review | 2026-07-27（v3.1.0 平盘侧库 / 十组 FundType / 跨已确认运行双向 1:1 / 账户别名 / 49 列回导确认 / 日期往返 / 差异范围自动化和代码 review，真实资金逐笔复核待业务负责人）；2026-07-25（v3.0.26 R5 signed Extra Fee / DBS 无手续费隔离 / 多对多只读 / 前置资金 21 列与 C4 三代契约自动化和代码 review，真实资金逐笔复核待业务负责人）；2026-07-23（v3.0.25 设置确认保存 / 模板排除退役 / archiveCenter 10 API 自动化与代码 review）；2026-07-22（v3.0.24 平盘前端占位 / Payment 多账号自动化与代码 review，真实双账号逐笔复核待业务负责人）；2026-07-21（v3.0.23 C3 双候选池 / R4 四类严格 1:1 自动化与代码 review，真实资金逐笔复核待业务负责人）；2026-07-20（v3.0.22 存档中心 — 元数据/Blob/流水游标/运行绑定/失败隔离/IPC/UI）；2026-07-19（v3.0.19 工具箱严格多 Sheet 合并 — 可见性/表头/顺序/分页/资源生命周期/拆分隔离）；2026-07-16（v3.0.18 在线升级 — IPC/设置仓储/升级状态机/业务闸门/退出清理与发布流水线） |
| v3.0.15 人工资金 review | 待业务负责人使用脱敏真实样本完成；当前自动化 review 不替代该发布硬门禁。 |
| v3.0.16 人工资金 review | 待业务负责人逐笔确认 `abs(方向金额) + Extra Fee`、14 条规则映射及错误行逻辑排除结果；自动化 review 不替代该发布硬门禁。 |
| v3.0.17 人工资金 review | 待业务负责人用真实脱敏退款样本逐笔确认新增模糊命中的流水号、金额差、大账号、币种和双向 1:1；自动化 review 不替代该发布硬门禁。 |
| v3.0.21 人工资金 review | 待业务负责人逐笔确认真实退款精准命中、DBS 12 类白名单、金额币种、Credit 方向 warning 和改值/未改值去向；用户已在知悉未完成后授权发布，该项转发布后 follow-up，自动化 review 不等于人工验收。 |
| v3.0.23 人工资金 review | 待业务负责人逐笔确认真实 Ach Return、Wire Return 及冲突候选的 ReconID、账号、币种、方向金额、signed Extra Fee、网关 amount 和严格 1:1 去向；另需用重复 ReconID 样本确认 R4 no-op Ach Return 只排除具体银行行；HX 无真实样本时保留验收缺口。 |
| v3.0.24 人工资金 review | 待业务负责人使用至少两个真实或脱敏大账号，逐笔确认银行 `MerchantId` 与订单“收款账户（卡号）”一致，尤其复核同金额、币种、日期碰撞及 R3 兜底；自动化 review 不替代人工验收。 |
| v3.0.26 人工资金 review | 待业务负责人逐笔核对 R5 默认网关来源与调拨对账单来源的正/负/空手续费、回填 ReconciliationId、严格 1:1 去向和多对多异常说明；并人工打开新 21 列前置资金结果确认 FundType 血缘。自动化 review 不替代人工验收。 |
| v3.1.0 人工资金 review | 待业务负责人使用真实或脱敏银行账单、五类链接原始表逐笔核对十组 FundType、自有/非自有账户别名、币种、方向、日期、signed Extra Fee、严格 1:1、差异和回导确认；Windows Excel/WPS 模板打开及大文件内存也需人工验收。 |
| v3.1.11 人工资金 review | 待业务负责人使用真实或脱敏 Biz OP、Pending、Pre-fund 样本复核 dataset tag → run receipt → 输出文件的直接血缘、行数和金额/币种守恒；并在真实 Archive 数据库副本复核 017/018、001。自动化 release-check 不替代该发布门禁。 |
| 基线数据 | `docs/analysis/var-reference-stats.md`（218 个 JS 文件 / 2553 顶层声明；A-share 376 / A-pair 637 / A-local 1396 / B 1013；报告版本 3.1.0） |
| 下次重扫时机 | 版本号 bump / 合并到 `main` 或 `v1.5.x` 前 |
| 分层定义 | Critical / Important-skeleton / Runtime-state / Risk-sensitive / Minor |

## 如何使用本表

1. 准备改代码前：搜本表，看改动文件 / 改动符号是否在表中出现
2. 改完代码后：对命中的每一条，按"变更 review 要点"列出的清单自查一遍
3. PR body 追加"⚠️ 关联功能 review"段落，列出命中变量与 review 结论
4. 新发现的跨度 ≥ 3 的符号（见自动统计报告），评估是否升格入本表
5. 版本号 bump 时：人工完整 review 一次本表，同步进展到 CHANGELOG

本表中跨度/次数数据为**人工 review 时刻的参考**，不精确追踪每次改动（精确数据看自动报告）。

---

## 1. Critical — 业务契约锚点

**这批常量 / 类承载业务协议。**一旦修改语义，会引起**跨层联动 + 历史数据失效**，属于高风险区。

### `freezeWorkerBatchContext`（v3.1.9 新增 Critical，A-share 跨进程协议）
- 定义：`src/main-process/archive-center/worker-batch-context.js`；由 main、TaskLifecycle、归档恢复和各业务 worker/dispatch 共用
- 当前合同：只接受并冻结 exact-seven `batchId/batchNumber/taskRunId/taskKey/moduleId/parentRunId/operationKey`；`batchId` 必须为正安全整数，其余六项必须为非空字符串；required 调用缺失时 fail-closed
- 关联功能：worker 跨线程消息、崩溃后恢复、批次终态回写、输入输出 artifact 登记、VCC/Acquiring/Position/Pending/工具箱等任务与原批次的唯一身份；自动统计为 21/53/5，属于真实 A-share
- 变更 review 要点：
  - 增删/改名字段必须同步全部 producer、worker entry、持久 checkpoint/recovery 与 controller；禁止 worker 自行补批次、用月份/latest/renderer state 猜身份
  - 不得放宽正整数/非空/exact-set/frozen 约束，也不得把原始行、文件内容、可变 session 或内部路径塞入 context
  - 恢复必须沿用已持久化的同一 seven-field context；缺失/陈旧/不一致时阻断业务恢复，不能另分新批次掩盖
  - 必跑：worker-batch-context、TaskLifecycle、Acquiring resume、Position import、VCC worker、Pending 与工具箱 worker/dispatch 聚焦测试 + `npm run smoke`

### `VCC_STORAGE_CONTRACT_VERSION` / `registerVccStorageWriteCapability` / `installVccStorageWriteGuards` / `setVccStorageContractVersion`（v3.1.10 新增 Critical）
- 定义：`src/backend/vcc-financial-op-db/storage-contract.js`；当前持久合同版本为 `2`，连接能力函数为 `vcc_storage_write_capability_v2()`，guard trigger 前缀为 `vcc_storage_contract_v2_guard_`
- 关联功能：v3.1.10 精简 VCC 表结构、旧版降级写阻断、generic/dedicated worker 首写能力、候选库 marker 与 23 张 `vcc_fin_op_*` 表 I/U/D 保护
- 变更 review 要点：
  - marker 与 exact trigger 安装必须在同一 SAVEPOINT 原子边界；任何表缺 trigger、错表或非 canonical SQL 都必须失败关闭
  - 每个新版写连接必须在 VCC DML 前显式注册 connection-local capability；不得默认放行、不得依赖进程全局布尔值
  - mutation guard 只能按 exact trigger name/target/SQL 放行该前缀，不能宽泛忽略未知 trigger
  - 合同版本升格必须另立迁移与兼容 Spec；已发布 v3.1.9 必须继续无法写 contract-v2 库
  - 必跑：storage-contract、migrations、generic/dedicated mutation、v3.1.9 downgrade probe、COW candidate 与 `npm run smoke`

### `FIXED_FIELD_VALUE_PREFIX`
- 定义：`src/backend/database/utils.js`
- 当前值：`__FIXED__:`
- 关联功能：模板固定字段（如 `__FIXED__:MerchantId=NET001`）的序列化/反序列化
- 变更 review 要点：
  - 改前缀字符串 → 所有历史模板 JSON 失效
  - 改解析逻辑 → 固定字段注入的行数据可能错列
  - 涉及文件：`main.js`、`database/utils.js`、`statement-session.js`、模板 repository
  - 必须跑一次：带固定字段的模板导入 + 导出端到端

### `ADVANCED_MAPPING_FIELDS`
- 定义：`src/main.js`
- 关联功能：决定哪些字段走"高级映射"分支（签名金额 / 字段拆分 / 账单拆分合并 / 字段拼接）
- 变更 review 要点：
  - 增删成员 → 渲染层映射对话框 UI / 模板持久化 schema 都要同步
  - 涉及 CLAUDE.md "Amount mapping modes (4-way)" 的边界

### 4-way 金额映射模式标识
- `SIGNED_AMOUNT_MAPPING_FIELD` — 签名金额拆分
- `AMOUNT_SPLIT_BY_FIELD_MAPPING_FIELD` / `AMOUNT_SPLIT_BY_FIELD_ENABLED_OPTION` — 按字段区分发生额
- `AMOUNT_BASED_ACCOUNT_MAPPING_FIELD` / `AMOUNT_BASED_NAME_MAPPING_FIELD` — 账号 / 户名按金额匹配
- `BILL_SPLIT_MERGE_MAPPING_FIELD` — 账单拆分合并
- 定义位置：均在 `src/main.js`
- 变更 review 要点：
  - 四种模式互斥（CLAUDE.md Key Business Rules），改任意一个都要验证其他三种未串味
  - 模板 JSON bundle 的 `bundleVersion` 可能需要同步升格
  - 必跑：四种模式各一个样例模板的导入/导出

### `CONCAT_FIELDS_MAPPING_FIELD`
- 定义：`src/main.js`
- 关联功能：字段拼接映射（如 Narrative = 摘要 + 备注）
- 变更 review 要点：拼接顺序 / 分隔符变化会直接改动输出内容

### `MERCHANT_ID_SELF_INPUT_OPTION`
- 定义：`src/main.js`
- 关联功能：大账号弹窗"自行输入 MerchantId"选项；CLAUDE.md Big Account Selection 的默认分支来源
- 变更 review 要点：自行输入值落盘到 `lastFileImportContext`，导出时复用——改了标识要同步改匹配逻辑

### `BALANCE_CALCULATED_OPTION` / `BALANCE_DISABLED_OPTION`
- 定义：`src/main.js`
- 关联功能：余额字段的三态（直列 / 发生额推算 / 停用），CLAUDE.md Key Business Rules § Balance calculation
- 变更 review 要点：
  - 改枚举值会让历史模板持久化记录错位
  - **资金相关**，必跑：余额工作表（单币种 + 混币种）导出对比

### `FILENAME_MAPPING_TEMPLATE_ID`
- 定义：`src/main.js`
- 关联功能：文件名映射模板的保留 ID；不能被普通模板占用
- 变更 review 要点：若改 ID，`database/template-repository.js` 里所有 `where id = FILENAME_MAPPING_TEMPLATE_ID` 分支要同步

### `ALL_BANKS_TEMPLATE_SCOPE`
- 定义：`src/main-process/monthly-balance.js`
- 关联功能：月度余额聚合时"全行"特殊 scope 标识
- 变更 review 要点：跨表聚合逻辑依赖它识别"不限银行"

### `SUPPORTED_EXTENSIONS`
- 定义：`src/backend/file-service/common.js`
- 关联功能：文件选择对话框过滤 + 拖入校验
- 变更 review 要点：增加新格式要同步 reader 实现与 UI 提示文案

### `FileValidationError`
- 定义：`src/backend/file-service/common.js`
- 关联功能：**项目唯一自定义错误类**；所有导入/导出的错误报告格式统一靠它
- 变更 review 要点：
  - 字段 (code / message / detail lines / context) 是对外 error-report 的 schema
  - 改字段要同步所有 catch 分支 + 错误报告 writer

### `runReconciliation`（v2.1.3 业务OP数据核对）
- 定义：`src/main-process/biz-op-recon-session.js`
- 关联功能：业务OP 数据核对模块**资金对账总入口**；编排 4 步算法（流水累加 → 计算 T-1 OP → 1:N 逐行精准比 → 账户号差集）+ 落库 runs/diff_rows
- ⚠️ 命名冲突：与 v1.5.x Pending 模块同名 `runReconciliation` 存在；改前必先 `grep -rn "runReconciliation" src/` 确认改的是哪个模块
- 变更 review 要点：
  - **资金红线**：4 步流程任一改动直接影响差异判定结果
  - 改函数签名 / summary 字段 → IPC handler `bizOpRecon:run` 出参 schema 同步 + 前端状态栏文案同步
  - 关联拍板点：fix4（multiOpAccountSeen Set 防重复累加） / fix5（相等多 OP 行 push diffRows） / round1 I3（T-2 NaN end_balance 加 console.warn + summary.t2AnomalyAccountCount）
  - 必跑：smoke biz-op-recon Case A-K 全套 + 真实数据样本回放

### `compareT1OpWithComputed`（v2.1.3 1:N 精准标差异核心）
- 定义：`src/main-process/biz-op-recon-session.js`
- 关联功能：业务OP 模块 OPEN ISSUE #6 拍板 A 1:N 逐行独立比的核心算法；同账户号 N 条 T-1 OP 行各自与计算 T-1 期末余额比较，逐行独立标"相等/不相等"
- 变更 review 要点：
  - **资金红线**：epsilon=1e-2 容差不可放宽；超过 → 标"不相等"，进 diff_rows 表
  - **fix5 选项 B 关键不变量**：多 OP 账户的相等行（`t1Rows.length >= 2 && diff <= epsilon`）也必须 push diffRows，meta = `相等/空/是`；单 OP 相等行不进表
  - `amountDiffCount` 仅累计"不相等"行（相等多 OP 不计入差异计数）；`multiOpAccountCount` 按账户号去重统计
  - 必跑：smoke biz-op-recon Case B（多 OP 行）+ Case J（fix5 反例防回归）

### `runFlowImportAsync`（v2.1.3 流水对账单导入入口，**round 3 P1 升格 ⚠️ 资金红线**）
- 定义：`src/main-process/biz-op-recon-session.js`
- 关联功能：业务OP 模块流水对账单导入核心入口；接收 `{date, filePath}`，事务内做 28 列表头校验 + 出入方向枚举校验 + DELETE 旧流水 + **`clearRunsAndDiffsByDate(db, date)` 清该 date 跨所有 BU 的旧 runs/diff_rows** + INSERT 新流水
- 变更 review 要点:
  - **资金红线**（round 3 P1 修订前曾漏清）：流水换了对账没重跑 → 用户「导出差异」拿 stale 数据 = 资金事故。事务内必须包含 `clearRunsAndDiffsByDate(db, date)` 调用
  - **与业务OP 重导对照**：业务OP 重导只清单 BU（`clearRunsAndDiffsByDateBu`）；流水重导按 date 跨所有 BU 清（`clearRunsAndDiffsByDate`）— 两个清函数语义不可混
  - 改事务边界 / 清函数调用顺序 → 必跑 smoke Case P 防回归（构造同 date 跨 2 BU success run + 重导流水 + 断言所有 BU 的 runs/diff_rows 均被清）
  - 必跑：smoke biz-op-recon Case D（流水累加 + 出入方向）+ Case P（流水重导清 runs）+ 真实数据手测（同 date 跨 ≥ 2 BU 已 success run，重导流水后两 BU 的「导出差异」success 日期均消失，需重新跑对账）

### `runBizOpImportAsync`（v2.1.3 业务OP 导入入口，**round 4 P1 升格 ⚠️ 资金红线**）
- 定义：`src/main-process/biz-op-recon-session.js`
- 关联功能：业务OP 模块业务OP 导入核心入口；接收 `{date, filePath}`，事务内做 23 列表头校验 + 双重校验 + DELETE 旧业务OP `(date, BU)` + **`clearRunsAndDiffsByDateBu(db, date, BU)` 清当天作为 T-1 的 runs/diff_rows**（#15 拍板 A 已实现）+ **`clearRunsAndDiffsByDateBu(db, addOneDay(date), BU)` 清下一日作为 T-2 的 runs/diff_rows**（round 4 P1 新增）+ 落库前 `bu_name = String(rawBuName).trim()`（I2 round 1）+ INSERT 新业务OP
- 变更 review 要点:
  - **资金红线**（round 4 P1 修订前曾漏清下一日）：业务OP 某日数据**双角色** — 既是当天对账 T-1 也是下一日对账 T-2 输入（参见 PRD §3.4.1 步 4.2.a `计算 T-1 OP = T-2 期末 + 流水累加`）。漏清下一日 (date+1, BU) run → D+1 日 run 仍按"旧 T-2 期末 + 流水累加"算 = stale 差额 → 「导出 D+1 差异」拿错数据 = 资金事故
  - **必须两次调用 `clearRunsAndDiffsByDateBu`**：一次 `(date, BU)`（当天 T-1）+ 一次 `(addOneDay(date), BU)`（下一日 T-2）；缺一不可
  - **`addOneDay` 必须 UTC 实现**：避免本地时区抢跑/滞后导致跨日错位；时区错乱直接错日期 → 漏清下一日 run 或误清后天 run = 资金事故（详见 `addOneDay` 条目）
  - **与 `runFlowImportAsync` 区分语义**：业务OP 单 BU 跨 2 日清（D + D+1）；流水跨 BU 单日清（D 跨所有 BU）— 不可对调
  - 改事务边界 / 清函数调用次数 / addOneDay 实现 → 必跑 smoke Case Q 防回归（构造 BU-A 跨 D-1/D/D+1 三日业务OP + 跑 D 与 D+1 两 run 成功 + 重导 D 业务OP + 断言 D 与 D+1 两 run 均被清）
  - 必跑：smoke biz-op-recon Case A（核心对账）+ Case M（C1 大小写归一）+ Case N（I2 BU trim 归一）+ Case Q（业务OP 重导清下一日 runs）+ 真实数据手测（同 BU 跨 ≥ 3 日业务OP + 跑 D 与 D+1 两 run，重导 D 业务OP 后两 run 「导出差异」success 日期均消失）

### `acquiring_bill_currency_flow_imports.settle_amount_abs`（v2.1.6 收单流水通道清算金额绝对值入库列，v0.7 fix4 重命名自 recon_amount_abs）
- 定义：`src/backend/database/migrations.js` 中 `ensureAcquiringBillCurrencyTablesSupport` DDL；写入路径**v3.0.3 PR-H 起默认经引擎契约** `src/backend/acquiring-bill-currency-import/contract-flow.js` 的 `mapRow`（含 `parseAmountAbs`，byte-for-byte 平移 import-repository.insertFlowRow）；`import-repository.parseAmountAbs + insertFlowRow` 仅回退路径（session `USE_BIG_TABLE_IMPORT_ENGINE=false`）使用
- 关联功能：收单单据币种校验 — 流水侧**通道清算金额**绝对值入库列；差异表 `流水_通道清算金额` 直接取该列值（无二次 ABS）
- v0.7 fix4 变更：取值列从 Excel 第 13 列「对账金额」(values[12]) 切换为第 29 列「通道清算金额」(values[28])
- 变更 review 要点：
  - **资金红线**：`parseAmountAbs` 改实现（含 `Number(...)` 解析方式 / `Math.abs` / `toString` 精度） → 差异表金额值漂移；**v3.0.3 PR-H 后须同步改 contract-flow.js 的 parseAmountAbs（它是 insertFlowRow 的 byte-for-byte 平移副本，两路必须一致 — acquiring-engine-migration.js 集成脚本锁死）**
  - 修改 DDL 列类型（TEXT → REAL 等） → 必须同步 reader 入库 + writer 输出格式
  - 改取值列号（values[28]） → 必须同步 spec §3.1 ★ 标列 + smoke fixture + contract-flow.js（白名单 FLOW_VALUE_WHITELIST 派生自 FLOW_KEY_COLUMN_INDICES，自动跟随）
  - 必跑：smoke acquiring-bill-currency Case A / J（通道清算金额入库 + 输出值精度）+ 集成 acquiring-engine-migration.js（新旧两路 byte-for-byte）+ 真实数据手测（含负数金额行）

### `acquiring_bill_currency_*.settle_currency` / `settle_currency_norm`（v2.1.6 收单流水/单据通道清算币种入库列，v0.7 fix4 对账核心字段）
- 定义：`src/backend/database/migrations.js` DDL；写入路径**v3.0.3 PR-H 起默认经引擎契约** `contract-flow.js`（流水侧 values[29]）/ `contract-bill.js`（单据侧 values[19]）的 `mapRow` + `normalizeCurrency`（byte-for-byte 平移 import-repository.insertFlowRow/insertBillRow）；`import-repository.insertFlowRow/insertBillRow + normalizeCurrency` 仅回退路径使用
- 关联功能：收单单据币种校验 — **对账核心比对字段**，SQL JOIN 时与对侧 settle_currency_norm 比较判定是否差异
- v0.7 fix4 关键决策：流水侧取值列从 Excel 第 14 列「币种」(values[13]) 切换为第 30 列「通道清算币种」(values[29])；单据侧列号 values[19] 保持（语义本就是清算视角，仅 DB 字段重命名）。原因 = 单据「对账币种」是清算视角，订单视角的「币种」对账必然 100% match 是字段语义错位
- 变更 review 要点：
  - **资金红线**：流水侧取值列号改动 → 完全改变对账结果（v0.6 = 100% match / v0.7 ≈ 56% mismatch）
  - `normalizeCurrency`（LOWER+TRIM）改实现 → 大小写/空格差异被误判为不一致；**v3.0.3 PR-H 后 contract-flow.js / contract-bill.js 各自有 normalizeCurrency 副本，须与 import-repository 同步（acquiring-engine-migration.js 锁死两路一致）**
  - 必跑：smoke acquiring-bill-currency Case J/K/L 全套（matching / mismatch / 流水侧空）+ 集成 acquiring-engine-migration.js + 真实数据手测（混合多币种）

### `acquiring_bill_currency_diff_rows.flow_currency` / `flow_amount_abs`（v2.1.6 差异表输出关键 2 列）
- 定义：`src/backend/database/migrations.js` DDL；写入路径在 `src/backend/acquiring-bill-currency-db/run-repository.js` 的 `insertDiffRowsByJoin`（核心 SQL JOIN）
- 关联功能：收单单据币种校验差异表输出末尾 2 列 — `流水_通道清算币种` + `流水_通道清算金额`（v0.7 fix4 输出标签修订）；财务据此判断是否需要修正单据币种
- v0.7 fix4 变更：DB 列名保留 flow_currency/flow_amount_abs（避免 schema 二次变更），**值的语义改为通道清算视角**（SQL `SELECT f.settle_currency, f.settle_amount_abs`）
- 变更 review 要点：
  - **资金红线**：`insertDiffRowsByJoin` SQL JOIN 条件改动（`f.month_key = b.month_key AND f.recon_main_id = b.recon_main_id` + `COALESCE(b.settle_currency_norm, '') <> COALESCE(f.settle_currency_norm, '')`） → 直接影响差异表行选择
  - 改 `diff_type` 判定逻辑（`bill_currency_missing` vs `currency_mismatch`）→ 用户语义混淆
  - 改 SQL `settle_currency_norm` 比较 → 必须同步 import-repository 入库归一函数 `normalizeCurrency`
  - 改输出列名常量 `WRITER_OUTPUT_FLOW_CURRENCY_HEADER` / `_FLOW_AMOUNT_ABS_HEADER` → 必须同步 spec §6.2 + smoke Case A 末列表头断言
  - 必跑：smoke acquiring-bill-currency Case A/C/E/J/K/L 全套 + writer 输出 xlsx 末 3 列值断言

### `USE_BIG_TABLE_IMPORT_ENGINE` + 收单导入引擎契约（v3.0.3 PR-H 升格 Critical ⚠️ 资金红线 — 收单导入链路换引擎 + 单行回退开关）
- 定义：`src/main-process/acquiring-bill-currency-session.js` 模块顶部 `const USE_BIG_TABLE_IMPORT_ENGINE = process.env.ACQUIRING_FORCE_LEGACY_IMPORT === '1' ? false : true`（生产默认 true=引擎）；契约模块 `src/backend/acquiring-bill-currency-import/contract-flow.js` / `contract-bill.js`（引擎 `mapRow`/`insertSql`/`validateHeaders`/`monthKeyOf`/`formatBatchError`/`deleteSqlForOverwrite`）
- 关联功能：收单 flow/bill 导入（`importFilesInTransaction` / `importFilesWithOverwrite`）默认 dispatch 大表导入引擎（`big-table-import/engine-worker-entry.js` worker，主进程零阻塞 + 多文件并行 + 字节层 row-scanner）；开关拨 false / `db.location()` 拿不到 dbPath → 回退 `runImportLegacyInTransaction` / `runImportLegacyWithOverwrite`（reader-handrolled 直调，v3.0.2 行为）
- 跨文件度：A-pair（session 定义 dispatch + 契约模块 + 引擎 import-worker 给 mapRow 注入 ctx.sourceFile + engine formatBatchError/errorName 接线）
- 关联引擎改动（v3.0.3 PR-H 对 PR-G1/G2 untracked 引擎文件的最小改动）：
  1. `big-table-import/import-worker.js`：`mapRow({rowR,values,ctx})` 传 ctx（sourceFile 逐文件动态，不能走 contractOptions）；batch 元素带 `rowR`；表头错 message 加 `${sourceFile}：` 前缀
  2. `big-table-import/engine.js`：INSERT 失败/跨月行级错误行号用真实 `rowR`（非 batch 索引）；整批拒绝调契约 `formatBatchError` 生成 message/detailLines/name；peek/表头错经契约 `errorName` 改名
- 变更 review 要点：
  - **🔴🔴 资金红线（放行闸）**：收单导入是对账金额/币种入库真理源。改 contract-flow/bill 的 mapRow 取值/归一/列序、改引擎 writeBatch 错误行号/formatBatchError → 必须重跑 `acquiring-engine-migration.js`（新旧两路 byte-for-byte：含 rowid 逐行 + 对账统计 + 错误 message/detailLines/name 逐字符）
  - 错误对外契约：契约 `errorName='ImportValidationError'` + `formatBatchError` 保证引擎抛错的 name/message/detailLines 与旧 reader byte-for-byte → main.js handler 错误识别（status='error' + detailLines 透传）+ smoke caseB/F/H3/M 零改动
  - **回退完整性**：reader.js / reader-handrolled.js / import-repository.js 一字不改且仍被回退路径引用；拨 false 即恢复 v3.0.2（含旧路径自带 wal_checkpoint）
  - DB 连接：引擎 worker 自开 `dbPath`（`db.location()`）连接写；主进程 db 连接并存（WAL + busy_timeout 30s）；COMMIT 后引擎自带 `wal_checkpoint(TRUNCATE)`（session 引擎分支不再 checkpoint，回退分支保留）
  - 必跑：集成 `acquiring-engine-migration.js`（45 断言；v3.0.4 块 D PR-D biz-op flow 引擎迁移扩到 45）+ `big-table-import-engine.js`（19 断言，引擎改动不回归）+ smoke acquiring-bill-currency（203）+ acquiring-bill-currency-progress（34，reading 事件契约）+ acquiring-bill-currency-pragma（27）+ 真实数据手测（W4 UI 流畅 / 取消 / 覆盖导入）

### `USE_BIG_TABLE_IMPORT_ENGINE_PENDING` / `USE_BIG_TABLE_IMPORT_ENGINE_BIZOP_FLOW` + 共享 dispatch（v3.0.4 块 B/C 升格 Critical ⚠️🔴🔴 资金红线 — pending/biz-op flow 导入链路换引擎 + 单行回退开关）
- 定义：`src/main-process/pending-session.js:49` `const USE_BIG_TABLE_IMPORT_ENGINE_PENDING = process.env.PENDING_FORCE_LEGACY_IMPORT === '1' ? false : true`；`src/main-process/biz-op-recon-session.js:598` `const USE_BIG_TABLE_IMPORT_ENGINE_BIZOP_FLOW = process.env.BIZOP_FLOW_FORCE_LEGACY_IMPORT === '1' ? false : true`（均生产默认 true=引擎）；共享 dispatch `src/main-process/big-table-import-dispatch.js`（`dispatchEngineImport`，平移收单 `dispatchEngineImport` 范式 + `resourceLimits.maxOldGenerationSizeMb=4096`，pending/biz-op flow 复用、OPEN-2 不收编收单）
- 关联功能：pending 挂账导入（契约 `src/backend/pending-import/contract-pending.js`）/ biz-op flow 流水导入（契约 `src/backend/biz-op-recon-import/contract-flow.js`）默认走大表导入引擎（yauzl 基座、worker 拓扑统一、多文件并行）；开关拨 false / 拿不到 dbPath → 回退原 utilityProcess + `worker.js`（pending）/ `import-worker.js`（biz-op flow）全旧链路（旧 reader/repository 一字不改保留可达）
- 关联引擎扩展（PR-B E1-E5 契约可选项，不声明=行为零变化）：E1 多语句覆盖删除（pending deleteMonth 6 表顺序敏感 🔴 Codex PR #55 Finding 1 / biz-op flow 2 条 clear）；E2 事务内 finalizeForCommit（pending upsertMonthMeta COMMIT 前原子）；E3 空文件整批拒绝；E4 `maxCollectedErrors:1000` + `captureRowValues:true`（错误报告 xlsx 需整行 cells）；E5 写侧跨文件 sha 去重 Set
- 变更 review 要点：
  - **🔴🔴 资金红线（放行闸）**：pending_rows / biz-op flow 流水为入库真理源 + pending 6 表覆盖删除链（removed_pending_rows 残留→reconcile 用陈旧归档错标）。改契约 mapRow/insertSql/deleteForOverwrite/dedupeKeyOf → 必跑 parity 脚本 `pending-engine-migration.js`（45 断言）/ `bizop-flow-engine-migration.js`（47 断言，legacy vs 引擎 byte-for-byte：全表 dump + 错误路径文案/计数/cells/截断标志逐字段）
  - **行为收紧 divergence（intentional）**：旧 pending 硬编码 `sheet1.xml`（多 sheet 静默读第一个）→ 引擎 rels 正解多 sheet **报错**（防静默读错表）；错误超 1000 截断计数语义随引擎口径
  - **回退完整性**：旧链路文件全保留；env `PENDING_FORCE_LEGACY_IMPORT=1` / `BIZOP_FLOW_FORCE_LEGACY_IMPORT=1` 即恢复 v3.0.3 行为
  - **资源**：worker_threads 堆 vs 旧 child 8GB；dedupe Set 300w≈360MB + 写批缓冲，`resourceLimits.maxOldGenerationSizeMb=4096` 显式设置

### `runAllScenarios` / scenario-dispatcher（v2.1.7 F8 升格 Critical ⚠️ 资金红线契约锚点）
- 定义：`src/main-process/scenario-dispatcher.js:66` `function runAllScenarios(bankRows, gwRows, scenarios)`
- 关联功能：银行账单场景化引擎统一入口 — 编排 C1（提取reconId）/ C2（账单打标）/ C3（网关核销）三类场景；按 scenarios 顺序遍历 first-match-wins；维护 `rowLockSet` 命中集合；**v2.1.7 F8 新增反向 filter `unmatchedRows = bankRows.filter(r => !rowLockSet.has(r._rowId))` 保证 `modifiedRows + unmatchedRows = bankRows`（无遗漏 + 互斥契约）**
- 跨文件度：3+（`src/main.js:3033/3036/3109/3116` IPC handler 接入 + `src/main-process/bank-statement-io.js:213` writer 桥接 + 自身 dispatcher）
- 变更 review 要点：
  - **资金红线**：first-match-wins 改为多 match 会破契约 → 同一行可能被 C1+C2 双改 → 输出错列；改遍历顺序（C1→C2→C3）→ 优先级语义变 → 用户配置场景顺序失效
  - **`unmatchedRows` 反向 filter 契约**（v2.1.7 F8 新增 Critical）：`modifiedRows + unmatchedRows.length === bankRows.length` 必须永远成立；改 `rowLockSet.has(r._rowId)` 判断条件 → 双计 / 漏计 → 第 2 sheet "未命中场景行" 数据集合错位
  - 改返回字段 schema（`{modifiedRows, unmatchedRows, stats}`）→ `src/main.js:3033-3116` IPC + `src/main-process/bank-statement-io.js:212-213` writer 接入必须同步
  - C4 走独立流水线（reconIdFix 模块）**不进 dispatcher** — 不要把 C4 加进 scenarios 数组
  - 必跑：smoke `npm run smoke`（19 suite 含 c1/c2/c3 全套）+ 真实银行账单端到端（混合 C1+C2+C3+空场景） + F8 第 2 sheet 行数 = bankRows - modifiedRows 断言

### `unmatchedRows`（v2.1.7 F8 dispatcher 反向 filter 输出字段，升格 Critical ⚠️ 资金红线）
- 定义：`src/main-process/scenario-dispatcher.js:152` 反向 filter；引用 `src/main.js:3036/3110/3116/3270/3309-3420`（reconIdFix 模块也用同名字段，**两条流水线共享名但语义独立** — 见下方区分说明）+ `src/main-process/bank-statement-io.js:212-213` writer 第 2 sheet 输入 + `src/main-process/acquiring-bill-currency-session.js:211` 收单单据校验也用
- 关联功能：dispatcher first-match-wins 遍历后未命中任何场景规则的行集合；导出阶段透传给 `writeBankStatementOutput` 输出第 2 sheet "未命中场景行"
- 跨流水线区分（两条 unmatchedRows 不可混）：
  1. **dispatcher unmatchedRows**（`scenario-dispatcher.js:152`）— 所有场景未命中的银行账单行；服务于 F8 第 2 sheet
  2. **reconIdFix unmatchedRows**（`src/main.js:3309-3420`）— C4 reconId 修复模块的未匹配行；服务于"导出未匹配"独立功能
- 变更 review 要点：
  - **资金红线**：dispatcher unmatchedRows 是反向 filter 派生数据；保证 `modifiedRows + unmatchedRows = bankRows` 是核心契约（F8 spec §9.8 + spec §11.3 反向同步明确）
  - 改 `_rowId` 内部字段名 → 必须同步 dispatcher rowLockSet add + 反向 filter has 判断 + writer 输出剥 internal field
  - dispatcher 与 reconIdFix 两条同名字段维护**严格分离** — 改一条不要扩散到另一条
  - writer `stripInternalFields` helper 必须保证第 2 sheet 输出不暴露 `_rowId` 等内部字段
  - 必跑：smoke 19 suite 含 baseline `modifiedRows.length` 不变（F8 上线后 baseline 严守）+ F8 第 2 sheet 行数 + unmatchedRowCount stats

### `conditionsLogic`（v2.1.7 F1 C1 AND/OR 切换契约字段，升格 Critical ⚠️ 资金红线）
- 定义：scenario.config 持久化字段 — `src/main-process/scenario-engines/c1-extract-recon-id.js:103` `runC1Scenario` 消费 + `src/renderer-dialogs.js:5744/6292/6298/6303/6306` dialog 创建+读取 + `src/renderer-previews.js:872` preview 注入；schema 位置：scenario 配置 JSON（数据库 + 内存）
- 当前值域：`'AND'` / `'OR'` / `undefined`（老 scenario 无字段 → fallback `'OR'` 维持 v2.1.7 前历史行为）
- 关联功能：F1 C1 提取 reconId 场景多条件聚合逻辑切换 — `'AND'` = 同时满足所有条件才命中；`'OR'` = 满足任一条件即命中（默认 fallback）；**新 scenario 强制默认 `'AND'`**（R5 资金红线三层护栏：createDefaultScenarioConfig 注入 + dialog helper + 引擎 fallback）
- 变更 review 要点：
  - **资金红线**（R5 三层护栏拍板）：默认值改回 `'OR'` 或删除 fallback → 用户新建多条件场景被静默"或"逻辑命中过多行 → 错改账单
  - 三层护栏缺一不可：① `createDefaultScenarioConfig` 默认 `'AND'`（renderer-dialogs.js:5744）② `pickConditionsLogicChecked` helper mode=create 跟随 draft / mode=edit-老数据 fallback `'OR'`（renderer-dialogs.js:6298-6306）③ `runC1Scenario` 引擎 fallback `'OR'`（c1-extract-recon-id.js:103）
  - 改字段名 `conditionsLogic` → 所有 scenario 持久化 JSON 失效 + 老用户配置回退到默认
  - 改值域字符串（'AND'/'OR' → 'AND_MODE'/'OR_MODE'）→ 同上失效
  - 必跑：smoke c1 AND/OR 切换 + 新建场景 dialog 默认 AND radio 选中（preview F1 截图）+ 老 scenario 编辑 OR radio 选中（兼容性）

### `findBestAmountSubset`（v2.1.8 F5 新增 Critical ⚠️ 资金红线 — C4 manyToOne subset-sum 核心）
- 定义：`src/main-process/scenario-engines/c4-recon-id-fix.js:298` `function findBestAmountSubset(candidates, targetCents, mainBillDate, options = {})`
- 关联功能：C4 网关对账 ReconID 修复模块 manyToOne 子集和算法核心；从 left 候选池找出金额合计 = right 目标金额的子集；F5 算法重设主修对象（v2.1.7 PRD §10.3 根因 #2 maxSize=8 硬上限）
- 变更 review 要点：
  - **资金红线**：subset-sum 等式 `Σ(left subset amount) === right.amount` 不变量绝对不可破坏
  - F5 实施方案（spec.md §1.2 F5-D1）：maxSize 动态档位 — pool ≤ 12 全跑 / 12-20 maxSize=12 / > 20 maxSize=10 + warn；F5-D5 性能护栏 — candidates > 25 → 降级 maxSize=8
  - 改 maxSize → 性能 O(2^n) 影响巨大，必须性能 smoke + 单渠道超时降级
  - F5 acceptance（spec.md §1.4）：TEST2.xlsx 跑出 57 行 / 10 渠道；TEST.xlsx 仍为 0 行（不应误升）
  - 必跑：smoke `npm run smoke` 全套 + F5 fixture（F5-TEST.xlsx / F5-TEST2.xlsx）+ unit case（G1 协同）

### `tryManyToOnePool`（v2.1.8 F5 新增 Critical ⚠️ 资金红线 — C4 网关单向消费遍历）
- 定义：`src/main-process/scenario-engines/c4-recon-id-fix.js:719` `function tryManyToOnePool(leftRows, rightRows, fieldPairs, billDateMode, ...)`
- 关联功能：C4 manyToOne 主循环；按 right 行遍历 left 池子（subset-sum + 单向消费）；F5 算法重设核心改造点（v2.1.7 PRD §10.3 根因 #3 遍历顺序偏置）
- 变更 review 要点：
  - **资金红线**：「网关 right 行单向消费」不变量（每条 right 最多匹配 1 个 left subset）+ first-match-wins 不可破坏
  - F5 实施方案（spec.md §1.2 F5-D2）：复合排序 — 金额降序 + 子集大小降序；保大渠道优先
  - F5-D3 currency 字段过滤：在候选池构造时加 currency 等值过滤
  - 改遍历顺序 → 命中行数变化（v2.1.7 实测 28 行 vs TEST2.xlsx 期望 57 行差距即源于此）
  - 必跑：smoke + F5 fixture + TEST2.xlsx 3 个关键子集验证（T54SWIC494447 16 行 / T54SWIC506630 11 行 / T54SWIC470181 4M 子池）

### `WRITER_OUTPUT_HEADERS_V2`（v2.1.8 N4 新增 Critical ⚠️ 资金红线 — 收单差异表对外输出 12 列契约）
- 定义：`src/backend/acquiring-bill-currency-db/columns.js:88` `const WRITER_OUTPUT_HEADERS_V2 = Object.freeze([...TEMPLATE_BILL_HEADERS, 单据_对账币种, 流水_通道清算币种, 流水_通道清算金额])`
- 关联功能：收单单据币种校验差异表 xlsx 12 列输出契约（spec v0.10 §三.1 N4-D3 = 模版顺序）；用户 / 财务 / Excel 自动化下游 100% 依赖
- 变更 review 要点：
  - **对外输出契约**：任何修改（加/删/换列名 / 改顺序）→ 用户 Excel 自动化失效
  - 必须同步：模版 xlsx + writer.js + smoke caseA 末 N 列断言 + USER_GUIDE
  - 旧 `WRITER_OUTPUT_HEADERS`（29 列）标 deprecated 仅历史参照，新代码用 V2
  - 列名常量来源：`TEMPLATE_BILL_HEADERS`（前 9）+ `WRITER_OUTPUT_BILL_COPY_HEADER`（10）+ `WRITER_OUTPUT_FLOW_CURRENCY_HEADER`（11）+ `WRITER_OUTPUT_FLOW_AMOUNT_ABS_HEADER`（12）
  - 必跑：smoke caseA 列数 = 12 + 末 4 列表头断言 + N4 migration 用例

### `TEMPLATE_BILL_HEADERS`（v2.1.8 N4 新增 Critical ⚠️ 资金红线 — 模版 9 列 truth source）
- 定义：`src/backend/acquiring-bill-currency-db/columns.js:82` `const TEMPLATE_BILL_HEADERS = Object.freeze(['账单日期', 'originBillBizId', '单据类型', '主对账Id', '业务订单号', '对账金额', '对账币种', 'valueDate', 'channel'])`
- 关联功能：模版（`assets/收单币种校验导出差异表模版.xlsx`）前 9 列字段；writer + migration 共用 truth；DB raw_json 瘦身后唯一保留的 9 字段
- 变更 review 要点：
  - **对外输出契约**：模版字段是 N4 设计的 PSU；改之 → migration 失效 + 历史数据中 raw_json 仅含旧 9 字段
  - 必须同步：assets/收单币种校验导出差异表模版.xlsx + WRITER_OUTPUT_HEADERS_V2 + ensureBillRawJsonV2Slim N4_TEMPLATE_BILL_HEADERS 内部副本
  - 字段顺序（D3=a）：必须与模版一致；不可按其他顺序保留
  - 必跑：N4 caseN4_billRawJsonSlimMigration 全流程

### `bill_imports.raw_json`（v2.1.8 N4 内容契约变更 ⚠️ 资金红线 — 永久删除 17 字段；v2.1.10 N4-cont-1 扩内容语义）
- 定义：`src/backend/database/migrations.js:1023` DDL `raw_json TEXT NOT NULL`
- 关联功能：收单单据导入数据的 JSON 序列化字段；v2.1.7 及之前存 26 字段，v2.1.8 N4 起仅存 9 模版字段；migration 通过 `ensureBillRawJsonV2Slim` 一次性 rewrite；**v2.1.10 N4-cont-1 起对账成功老行 raw_json 可被自动清空为 `''`（sentinel，非 NULL — 兼容 v2.1.8 NOT NULL schema）；差异行 raw_json 永远保留以保证差异 xlsx 完整可重导**
- 变更 review 要点：
  - **数据不可逆**：17 字段值（ReconBillBizId / 公司主体 / 业务部门 / 对手部门 / 订单创建来源 / 财务BU / 账单类型 / 业务子类型 / 交易类型 / 对账子类型 / 单据状态 / 用户编号 / 账户号 / 账户类型 / remark / 创建时间 / 完成时间）永久删除
  - 历史月份差异表重导出也少这些字段 → 不能反悔
  - 下游消费方调研（v2.1.8 commit 37299cf）：仅 writer.js + run-repository.js 4 处 SQL `json_extract '$."账单日期"'` 使用；17 字段无下游消费
  - import-repository 写入 raw_json 时**仍按 26 字段写入**（reader 读 xlsx 全字段），migration 后续生效；下次需要时可在 import 阶段也裁字段
  - **v2.1.10 N4-cont-1 sentinel 修订（v0.3）**：清空标记必须用 `''`（空字符串）而非 `NULL` — v2.1.8 N4 DDL 含 `NOT NULL` 约束；改用 `NULL` 会让 UPDATE 失败（CHECK 违反）。所有 idempotent guard / 查询请用 `raw_json != ''` 而非 `raw_json IS NOT NULL`
  - **v2.1.10 N4-cont-1 差异行永不清空契约**：`clearStaleSuccessfulRawJson` 用 `NOT IN (SELECT bill_import_id FROM diff_rows)` 子查询排除；改子查询 → 资金红线（差异 xlsx 重导丢字段）
  - 必跑：N4 migration 全流程 + caseA 末 N 列表头 + readback raw_json 仅 9 字段；v2.1.10 必跑 `v2.1.10-n4-cont-1-phase4` 集成（差异行 `raw_json != ''` 100% + 对账成功老行 `raw_json = ''` + retention 边界）

### `runCheckCore`（v2.1.10 A3 新增 Critical ⚠️ 资金红线 — runCheck 核心算法 worker/main 共用入口）
- 定义：`src/main-process/acquiring-bill-currency-session.js:runCheckCore(workerDb, payload, onProgress, cancelToken)`（Phase 1 T09 提取自原 `runCheck` 内 DB/算法部分）
- 跨文件度：A-pair（`acquiring-bill-currency-session.js` 定义 + `run-check-worker.js` 调用；总命中 4 次 — `src/main-process/acquiring-bill-currency-session.js(3), src/main-process/run-check-worker.js(1)`）
- 关联功能：v2.1.10 A3 跨进程化的核心 — runCheck 5 阶段 (`clearOldRuns / computeStats / insertRun / insertDiffByJoin / writeRunOutputs`) 算法主体；**worker 进程与主进程必须 byte-for-byte 一致**（contract test 锁定）
- 变更 review 要点：
  - **资金红线**：runCheckCore 输出（diff_rows 内容 + 行数）与 v2.1.9 旧 runCheck 必须 byte-for-byte 一致；改一个 SQL / 阶段顺序 / cancel 边界都可能影响差异表内容
  - **cancelToken 必须在 5 阶段间检查**（T13 已实现）：cancel 触发当前事务 graceful ROLLBACK；不能跳过任何阶段间检查 → cancel 响应延迟超阈值
  - **worker / main 双调用方**：worker 路径调用走 `dispatchRunCheck` → IPC 序列化；main 路径走 facade 直调（兼容老调用方）；任一路径改动必须双侧验证
  - **A4 chunked 分批集成**：runCheckCore 内 `insertDiffByJoin` 阶段已透传 chunkSize 给 `insertDiffRowsByJoinChunked`；chunk 边界 cancel + idempotent / 重跑保护由本函数 + run-repository 共同维护
  - 跨主线影响：A3 worker 跨进程化 + A4 chunked 分批 + N4-cont-2 CASCADE 删 run 时 diff_rows 自动清 — 改 runCheckCore 必须同步验证 4 主线集成路径
  - 必跑：unit `tests/unit/main-process/run-check-worker.test.js` 12 case + 集成 `v2.1.10-a3-phase1` 40 case + `v2.1.10-a3-phase2` 33 case + `v2.1.10-a4-phase3` 25 case

### `clearStaleSuccessfulRawJson`（v2.1.10 N4-cont-1 新增 Critical ⚠️ 资金红线 — NOT IN 子查询排除差异行）
- 定义：`src/backend/acquiring-bill-currency-db/raw-json-retention.js:clearStaleSuccessfulRawJson(db, retentionDays)`
- 跨文件度：A-pair（`raw-json-retention.js` 定义 + `main.js` idle cleanup 回调调用；总命中 3 次 — `src/backend/acquiring-bill-currency-db/raw-json-retention.js(2), src/main.js(1)`）
- 关联功能：v2.1.10 N4-cont-1 raw_json 体积治理核心 — 单 SQL `UPDATE acquiring_bill_currency_bill_imports SET raw_json = '' WHERE id NOT IN (SELECT bill_import_id FROM acquiring_bill_currency_diff_rows) AND imported_at < datetime('now', '-N days') AND raw_json != ''`；由 N1' idle 30min cleanup 回调自动触发；返回 `{ affectedRows }`
- 变更 review 要点：
  - **资金红线**：`NOT IN (SELECT bill_import_id FROM diff_rows)` 子查询是差异行保留的**唯一保护**；改子查询条件 / 写错表名 / 列名 → 差异行 raw_json 被误清 → 差异 xlsx 重导丢字段 = 资金事故
  - **sentinel = `''`**（v0.3 修订）：不能用 `NULL`（违反 v2.1.8 N4 NOT NULL 约束）；所有 idempotent guard 用 `raw_json != ''`
  - **idempotent**：函数本身按 `raw_json != ''` 守卫；重复调用 0 行影响；不能改成 `raw_json IS NOT NULL`（无效查询，落 v2.1.8 NOT NULL schema 后没有 NULL 行）
  - **失败 graceful**：调用方 (main.js setupIdleCleanupTimer 回调) 必须独立 try/catch + activity log + 不阻塞主 cleanup
  - **retention_days 边界**：由 `getAcquiringBillRawJsonRetentionDays(db)` 提供（settings 单键 + 范围 1-30 + 范围外回退 7）；改函数签名要同步 setting key
  - 必跑：unit `tests/unit/backend/acquiring-bill-currency-db/raw-json-retention.test.js` 8 case + 集成 `v2.1.10-n4-cont-1-phase4` 23 case

### `ensureDiffRowsCascadeMigration_v2_1_10`（v2.1.10 N4-cont-2 新增 Critical ⚠️ DB 不可逆 schema + 8-status state machine）
- 定义：`src/backend/database/migrations.js:ensureDiffRowsCascadeMigration_v2_1_10(db, dbPath, createBackupFn)`
- 跨文件度：A-pair（`migrations.js` 定义 + `database.js` 启动期调用；总命中 6 次 — `src/backend/database.js(4), src/backend/database/migrations.js(2)`）
- 关联功能：v2.1.10 N4-cont-2 FK CASCADE 改造核心 — 在 `acquiring_bill_currency_diff_rows` 的 2 个 FK（`bill_import_id` → `acquiring_bill_currency_bill_imports.id` 和 `run_id` → `acquiring_bill_currency_runs.id`）上加 `ON DELETE CASCADE`；沿用 v2.1.9 N5 8-status state machine 范式（pending / backed-up / checked / rebuilt / data-copied / fk-verified / cleaned-up / done）+ 复用 SR-backup-1 createBackupFn 注入；标志位 `n4_cont_2_diff_rows_cascade_migrated`
- 变更 review 要点：
  - **数据不可逆**：FK CASCADE 改造涉及 schema rebuild（CREATE TEMP TABLE + DROP + RENAME）；migration 失败必须 ROLLBACK 到 v2.1.9 状态 + 备份保留（SR-backup-1 VACUUM INTO 前置）
  - **8-status state machine 顺序固定**：pending → backed-up → checked → rebuilt → data-copied → fk-verified → cleaned-up → done；改顺序 → 中断恢复时 status 判断错乱 → 重复 migration 或漏 backfill
  - **跨版本迁移**：必须支持 v2.1.7 / v2.1.8 / v2.1.9 → v2.1.10 一步迁；不能假设上游 migration 已跑（启动期 migration 序列由 `database.js` 编排）
  - **PRAGMA foreign_key_check 0 violation 是 hard requirement**：fk-verified status 若有 violation 必须 fail-fast + ROLLBACK；不能跳过
  - **FK 范式 vs v2.1.9 N5**：N5 `channels` FK 是 `ON UPDATE CASCADE`（不带 ON DELETE — channels 禁删）；N4-cont-2 是 `ON DELETE CASCADE`（删 run → diff_rows 自动清）+ 不带 ON UPDATE；两者范式差异是设计 — 不能复用同一辅助函数
  - **createBackupFn 注入范式**：沿用 v2.1.9 N4 重构 + SR-backup-1 范式；不能改用 `fs.copyFileSync`（v2.1.8 N4 旧方式已废弃）
  - **幂等保护**：标志位 `n4_cont_2_diff_rows_cascade_migrated='1'` 已设 → 跳过；ROLLBACK 不写 marker → 下次重试
  - 必跑：unit `tests/unit/backend/database/migrations-n4-cont-2.test.js` 12 case + 集成 `v2.1.10-n4-cont-2-phase5` 43 case（含跨版本 fixture + ROLLBACK + 老数据保留 + 幂等）

### `acquiring_bill_currency_diff_rows` FK CASCADE schema（v2.1.10 N4-cont-2 升格 Critical ⚠️ DB schema 契约 — spec §九 拍板）
- 定义：`src/backend/database/migrations.js:1506-1515` DDL — `bill_import_id INTEGER REFERENCES acquiring_bill_currency_bill_imports(id) ON DELETE CASCADE` + `run_id INTEGER REFERENCES acquiring_bill_currency_runs(id) ON DELETE CASCADE`（v2.1.10 N4-cont-2 改造完成后）
- 关联功能：v2.1.10 N4-cont-2 改造目标 schema；之前（v2.1.7/v2.1.8/v2.1.9）FK 不带 CASCADE，删 run / 删 bill_import 时孤儿 diff_rows 残留；本版 ON DELETE CASCADE 后自动清；clearOldRuns + chunked 重跑 idempotent 也依赖本契约
- 变更 review 要点：
  - **资金红线**：改 FK schema 必须配套 migration（不能直接改 DDL 不写 migration → 老库不升级）；FK 引用错表 / 错列 / 错 action（CASCADE / SET NULL / RESTRICT）→ 资金事故
  - **与 N4-cont-1 配合**：N4-cont-1 clearStaleSuccessfulRawJson 排除差异行；如果 N4-cont-2 CASCADE 删了 run → diff_rows 跟着删 → 这些行的 raw_json 不再受 N4-cont-1 保护 → 可被下一轮 idle cleanup 清空；这是预期行为（用户删了 run 表示不再需要差异记录）
  - **不能加 ON UPDATE CASCADE**：v2.1.10 spec §6.2 只加 ON DELETE；ON UPDATE 与 v2.1.9 N5 channels FK 范式不同（详 `ensureDiffRowsCascadeMigration_v2_1_10` 条目）
  - **PRAGMA foreign_keys=ON** 必须在 worker / main 双进程连接生效（v2.1.10 A3 worker DB 连接 PRAGMA 6 条清单）；FK 不开启 CASCADE 不生效
  - 必跑：sqlite3 `PRAGMA foreign_key_list('acquiring_bill_currency_diff_rows')` 显示 ON DELETE CASCADE × 2 + 集成 `v2.1.10-n4-cont-2-phase5` 删 run / 删 bill_import case

---

## 2. Important-skeleton — 系统骨架

**跨层协作入口。**改函数签名/语义会让上下游解析错位，但不会让历史数据失效。

### `TaskLifecycle`（v3.1.9 新增 Important-skeleton）
- 定义：`src/main-process/archive-center/task-lifecycle.js`
- `TaskPolicyRegistry` / `BusinessFlowResolver` — 分别定义 63 个 file、59 个 no-file、117 个 exclude channel 的 literal policy，以及跨任务稳定 `parentRunId` 的解析、绑定与 bind-intent 重放
- 关联功能：所有受控任务先建立无编号 Task Run；只有具备非空冻结 manifest 的 File Task 才在同一原子事务申请全局日批次号。no-file worker 使用 exact-five operation context，file worker/恢复使用 exact-seven batch context；崩溃、取消、artifact settle 与 dataset/run lineage 均沿原 owner 收口
- 变更 review 要点：
  - policy 必须显式声明 file/no-file/exclude、allocation、`startsNewFlow` 与 terminal classifier；no-file 禁止携带 filePlan、建 batch 或推进 sequence，file reserve 必须是非空 manifest 与 batch/issuance/artifact 单事务
  - policy inventory、main wrapper、裸 IPC exclude 与 renderer/preload 入口必须同步；禁止以未登记直连绕过 lifecycle
  - `BusinessFlowResolver` 只能接受显式 parent 或已持久化的稳定业务身份；禁止月份、文件 hash、renderer/latest state 猜关联任务，bind intent 必须可重放
  - `archive_task_lineage` 只允许 planned→committed/discarded；只有 interrupted Task Run 可原 owner 恢复，failed/cancelled 不得复活；terminal outbox 不猜 lineage
  - 活动 owner、terminal intent 和恢复要保持幂等；archive 告警不能覆盖已取得的业务结果，也不能把失败任务标成成功
  - 必跑：task lifecycle/policy/IPC inventory/flow resolver、lineage/related、各 worker recovery 与 archive controller/integration 聚焦测试 + `npm run release-check`

### `templateRepository`
- 定义：`src/backend/database.js`（门面）
- 关联功能：所有模板 CRUD 的唯一入口；`main.js` 里 33 次调用
- 子方法（均在 `database/template-repository.js`）：
  - `saveMappings` / `getTemplate` / `deleteTemplate` / `listTemplates`
  - `saveBillSplitAmountRules` / `saveBillSplitMeta` / `saveBillSplitMappings`
  - `saveBillSplitMergeGroup` / `clearBillSplitMergeGroups` / `saveBillSplitRow`
  - `saveBillSplitRowCount` / `deleteBillSplitRow` / `setChildParent` / `setParentStatus`
  - `saveAmountSplitRules` / `getAmountSplitRules` / `getTemplateBigAccounts`
- 变更 review 要点：增减方法要同步 preload IPC 暴露与 renderer 对应调用

### `settingsRepository`
- 定义：`src/backend/database.js`
- 关联功能：全局设置读写（背景色、启动偏好等）
- 变更 review 要点：renderer 侧缓存与 main 侧持久化的 key 必须对齐

### 数据清洗基础设施
- `normalizeCell` — `file-service/common.js`（**跨 13 个文件**）
- `normalizeText` — `database/utils.js` + `database/migrations.js`
- `parseNumericValue` — `file-service/normalizers.js`
- `parseDateValue` — `file-service/normalizers.js`
- `sanitizeAmountValue` — `file-service/normalizers.js`
- 变更 review 要点：
  - 任何改动都会放大到 reader/writer/migrations 三条链
  - 必跑：`npm run smoke`（会触发读写管线）
  - 必验证：多种源文件格式（Excel / CSV / PDF）输入下的规范化一致性

### 读/写管线入口
- `readRows` / `readRowsWithMetadata` — `file-service/readers.js`
- `extractHeaders` / `loadEnumValues` — `file-service/readers.js`
- `writeWorkbookRows` / `writeBalanceWorkbook` — `file-service.js`（经由 `backend/file-service.js` 门面）
- `loadCurrencyMappings` — `file-service.js`（加载 `assets/币种映射表.xlsx`）
- 变更 review 要点：
  - 签名变化要同步 `main.js` orchestration
  - 输出列变化要同步 `writers.js` 的格式化规则
  - 币种映射改动 → 混币种余额表可能出现分表错位

### `ipcRenderer`（preload）
- 定义：`src/preload.js`（61 次出现）
- 关联功能：主/渲染进程通讯唯一桥；整个 `window.desktopApi` 的底座
- 变更 review 要点：新增/删除 IPC channel 必须同步 main 端 `ipcMain.handle`

### `ArchiveCenterController` / `archiveCenter` IPC（v3.0.22 新增 Important-skeleton）
- 定义：`src/main-process/archive-center/controller.js`；preload 门面为 `src/preload.js` 的 `window.desktopApi.archiveCenter`
- 关联功能：存档批次查询、详情、统计、保留期、锁定、删除、重试、替代源选择、打开只读副本和另存为的唯一跨进程入口；renderer 通常只传批次/文件 ID，替代源重试仅允许额外传递本次原生对话框选择的文件路径
- 变更 review 要点：
  - controller / main IPC / preload 11 个方法 / renderer 调用必须同步，禁止 renderer 取得 Blob 路径、已登记原始源路径、预期 SHA 或预期大小
  - `selectRetrySources` 只能为具备不可变业务摘要的失败 artifact 选择替代路径；`retryBatch` 必须按 artifact ID 白名单透传，并由 ArchiveService 重新校验普通文件、大小、读取稳定性和 SHA
  - `archive_center_retention_days` 只接受 30/60/90/180/365/永久；缺失或非法值按 60，改枚举必须同步 UI、controller、ArchiveService 和既有设置兼容
  - `archive_center_excluded_template_ids` 自 v3.0.25 起为退役兼容 key，控制器启动时必须规范化为 `[]`；不得恢复隐藏的模板级跳过
  - 网银账单与月度余额不得再由模板元数据产生 `skipArchive`；operation tracker 通用 `skipArchive` 能力仍需回归
  - 删除元数据成功但物理清理失败是部分成功，UI 必须刷新批次并保留残留清理提示
  - 必跑：archive controller/UI contract 单测 + 设置页预览 + `npm run verify:app-settings-layout` + `npm run smoke`

### `normalizeBu`（v2.1.3 业务OP / v2.1.2 月度BU回填校验共用）
- 定义：`src/main-process/biz-op-recon-session.js` + `src/backend/biz-op-recon-import/validator.js`（v2.1.3）；v2.1.2 月度BU回填校验也有同名实现
- 实现：`String(v).trim().toLowerCase()`
- 关联功能：BU 名归一化比较；流水 `bu_dept` vs 业务OP `bu_name` 跨表关联；OPEN ISSUE #7 拍板 C
- 变更 review 要点：
  - 多文件多 repository SQL 内嵌 `LOWER(TRIM(...))` 必须与函数实现保持一致（C1 round1 fix：`clearByDateBu` 已对齐 `LOWER(TRIM(?))`）
  - 改 normalize 规则要同步 v2.1.2 + v2.1.3 两处实现 + repository 内 SQL
  - 仅用于比较，**不改写落库原值**
  - 必跑：smoke biz-op-recon Case G（BU 隔离 + 大小写差异容忍）

### `normalizeAccountKey`（v2.1.3 账户号匹配 anchor）
- 定义：`src/main-process/biz-op-recon-session.js` + `src/main-process/biz-op-recon-writer.js`
- 实现：仅 `String(v).trim()`（**不**做大小写归一；账户号是资金 key）
- 关联功能：业务OP `账户号` 与流水 `账户编号` 跨表 key 归一；区间导出 sort key（M4 round1：writer 排序 key 改用 normalizeAccountKey）
- 变更 review 要点：
  - 跨 session.js / writer.js 两文件使用，改实现要同步
  - 不可加 toLowerCase（账户号大小写有业务含义）
  - 必跑：smoke biz-op-recon Case A/B + Case K（区间排序）

### `BIZ_OP_HEADERS`（v2.1.3 业务OP 23 列定义）
- 定义：`src/backend/biz-op-recon-db/columns.js`
- 关联功能：业务OP 表头校验 anchor + writer 输出列顺序 + reader 字段映射；模板 `assets/业务OP账单.xlsx` 23 列冻结数组
- 变更 review 要点：
  - 改顺序/列名 → 表头严格匹配会拒绝旧版业务OP 文件
  - writer / reader / validator 三处必须同步引用本数组
  - 配合 differ 的 4 列 meta（比对T-2日 / 同账户号多个OP / 比对测算金额 / 测算金额差额）→ 差异表 27 列结构
  - 必跑：smoke biz-op-recon Case A/E + 真实业务OP 文件回放

### `FLOW_HEADERS`（v2.1.3 流水对账单 28 列定义）
- 定义：`src/backend/biz-op-recon-db/columns.js`
- 关联功能：流水对账单表头校验 anchor + reader 字段映射；模板 `assets/流水对账单.xlsx` 28 列冻结数组
- 变更 review 要点：
  - 改顺序/列名 → 表头严格匹配会拒绝旧版流水文件
  - 与 BIZ_OP_HEADERS 同步管理（配套常量）
  - 必跑：smoke biz-op-recon Case D（流水累加 + 出入方向）+ 真实流水文件回放

### `ALL_MODULE_IDS`（v2.1.4 建立；v3.0.24 扩为 12 个主模块 ID 全集 anchor）
- 定义：`src/backend/database/settings-repository.js`
- 关联功能：单文件定义，但被 `CURRENT_MODULE_VALID`（`setCurrentModule` 校验）+ `setEnabledModules`（启用列表校验）共用；renderer 端 `MODULES` 常量必须与之一致；新增模块时两边都要加
- 变更 review 要点：
  - 新增模块 → 必须同步加到 `ALL_MODULE_IDS` + renderer 端 `src/renderer.js` 的 `MODULES` 常量（两边定义必须完全一致）
  - 如忘了同步 → 用户切到新模块会抛 `Invalid current_module`（v2.1.2/v2.1.3 即遗留过此 bug，v2.1.4 修复）
  - 修改 ID 字符串 → DB 内已持久化的 `current_module` / `enabled_modules` 会因 sanitize 被回退到默认值
  - 必跑：`npm run smoke`（settings-repository 内部测试）+ 手动验证 12 个模块逐一切换 + 收纳弹窗启用各模块后切换；新模块默认关闭时还要验证旧用户启用列表不被扩写

### `enabled_modules`（v2.1.4 — 左上角模块切换菜单的启用列表全链路）
- 定义：
  - 持久化 key：`app_settings.enabled_modules`（JSON 数组）— `src/backend/database/settings-repository.js`（`ENABLED_MODULES_KEY` 常量 + `getEnabledModules` / `setEnabledModules` / `DEFAULT_ENABLED_MODULES`）
  - facade：`src/backend/database.js`（`AppDatabase.getEnabledModules` / `setEnabledModules`）
  - IPC channel：`settings:get-enabled-modules` / `settings:set-enabled-modules` — `src/main.js` + `src/preload.js`
  - app:get-info 启动注入字段：`enabledModules`
  - renderer 缓存：`state.enabledModules`（`src/renderer.js`）
  - 渲染入口：`renderTopModuleSwitcher()`（`src/renderer.js`，按 `state.enabledModules` 动态渲染 `#moduleSwitcherMenu`）
  - 收纳弹窗工厂：`createModuleCabinetDialog`（`src/renderer-dialogs.js`）
- 关联功能：左上角模块切换菜单的状态驱动；用户可通过 🔄 收纳弹窗自定义启用模块及顺序；持久化跨重启
- 跨文件度：5+ 文件（settings-repository / database / main / preload / renderer / renderer-dialogs / renderer-previews）
- 变更 review 要点：
  - 改持久化 schema（JSON 数组元素 → 对象）→ 必须写迁移读旧格式 + 改 `getEnabledModules` sanitize 逻辑
  - 改 `DEFAULT_ENABLED_MODULES`（默认 3 个 → 改 N 个）→ 影响新用户首次启动体验；旧用户已 seed 不受影响
  - 改启用区"至少保留 1"约束（O3）→ 需同步 renderer 端 `updateControls` + repo 端 `setEnabledModules('') throw` 校验
  - 改 `setCurrentModule` fallback 逻辑（`current_module` 不在启用列表时切到第 1 个）→ 影响 `initialize()` 启动序 + 收纳弹窗 `onCommit` 回调
  - 必跑：① 新 DB 启动 → seed 默认值；② 旧 DB（无该 key）启动 → seed；③ DB 写入非法 JSON → 回退默认；④ `setEnabledModules([])` 抛错；⑤ 弹窗 ➡️/⬅️/拖拽 三种交互后菜单同步刷新

### `parseBillDateMs`（v2.1.8 F5 新增 Important-skeleton — BillDate 字符串化入口）
- 定义：`src/main-process/scenario-engines/c4-recon-id-fix.js:168` `function parseBillDateMs(s)`
- 关联功能：C4 BillDate 日期解析，正则 `^(\d{4})[-/](\d{1,2})[-/](\d{1,2})`；v2.1.7 PRD §10.3 根因 #1 — Excel 真日期 raw:true 读出 number 序列号导致解析全 fail（v2.1.7 单点 fix 仅修 28 行的根因）
- 变更 review 要点：
  - F5 实施方案（spec.md F5-D4 v0.3 Reverse Sync 后）：**不动** parseBillDateMs 本身，**不动** reader 入口 raw 模式；改在 `c4-recon-id-fix.js:1058-1065` gateway 映射段做 number → ISO 字符串转换后再赋给 BillDate（让 parseBillDateMs 拿到字符串能解析）
  - 跨文件度 10（scan-vars baseline），改函数签名 / 返回类型要 grep 全部调用方
  - 改正则 → 历史 BillDate 字符串可能匹配失败 → 候选池消失
  - 必跑：smoke c4 + F5 fixture + unit case（输入字符串 / 输入 number 序列号 → ISO 后输入对比）

### `cleanupAfterRunBackground`（v2.1.8 N1 新增 Important-skeleton — runCheck 后置清理函数；v0.7 N1' 加 includeDiff 参数）
- 定义：`src/main-process/acquiring-bill-currency-session.js:295` `async function cleanupAfterRunBackground({ db, monthKey, runId, onProgress, includeDiff = false })`
- 关联功能：收单单据币种校验模块 runCheck 后清理；每批 50000 行 + setImmediate 让出 event loop
- 变更 review 要点：
  - N1 β 方案（spec.md §三）：触发链路改造 — runCheck → app.before-quit 主 + 进入模块兜底
  - **N1' v0.7 改造**（spec.md v0.10 §三）：
    - 主触发改 idle 30min（`setupIdleCleanupTimer`）；before-quit 降级静默兜底；进入模块降级崩溃恢复兜底
    - 新增 `includeDiff=false` 参数（默认）：仅清 flow_imports；bill_imports + diff_rows 保留（**FK 约束** `diff_rows.bill_import_id REFERENCES bill_imports(id)` 无 CASCADE 强制）
    - `includeDiff=true` 仅 cleanupOrphanData Phase 2 用（清孤儿 run 脏数据 → diff → bill → flow 顺序解 FK）
  - **不动 cleanup 算法本身**（50000 行/批 + setImmediate）；仅触发时机 + 范围
  - 调用方变化：v2.1.7 main.js:10307 setImmediate → v2.1.8 移除 → v0.7 新增 setupIdleCleanupTimer / before-quit / listMonths 三触发
  - 必跑：smoke caseP（默认 includeDiff=false → bill/diff 保留 + flow 清）+ caseP2（includeDiff=true → 3 表清）+ caseQ cleanupOrphanData 不动

### `setupIdleCleanupTimer`（v2.1.8 N1' v0.7 新增 Important-skeleton — idle 30min cleanup 触发器）
- 定义：`src/main.js:10620` `function setupIdleCleanupTimer()`；关联常量 `IDLE_CLEANUP_MS = 30 * 60 * 1000` / `IDLE_CHECK_INTERVAL_MS = 2 * 60 * 1000`；关联状态 `lastUserActivityTs`
- 关联功能：app.whenReady 后启动定时器；每 2min tick 检查 `Date.now() - lastUserActivityTs >= 30min` → 复用 `triggerAcquiringBillCurrencyBackgroundCleanupIfNeeded`（含 mutex 抢锁 + 防重入）
- 变更 review 要点：
  - **触发条件 AND 设计**（spec v0.10 §3.2.2 N1''-D6）：renderer 上报 user-activity + mutex 间接判定 main 未忙；改任一条件 → idle 误判风险
  - 改 IDLE_CLEANUP_MS 常量 → 用户体验大变（短 → cleanup 频繁打扰；长 → 数据长期不清）
  - 改 tick 粒度 → 触发延迟 + CPU 开销 trade-off
  - **不能加 .unref() 删除**（避免阻塞退出，但要确保 cleanup mutex 在 before-quit 之前抢到）
  - 必跑：手测 30min 不动 → 触发 + log；smoke 中 fake timer 验证 idle 路径（v2.1.9 G1 全量铺时补 unit case）

### `INTERNAL_FIELDS`（v2.1.8 N3-2 新增 Important-skeleton — writer 内部字段过滤白名单）
- 定义：`src/main-process/exceljs-writer.js:25` `const INTERNAL_FIELDS = new Set([...])`
- 关联功能：exceljs-writer 输出 Excel 时过滤行数据的"内部字段"（`_hitScenarioId` / `_hitScenarioName` / `_rowId` 等下划线前缀字段不暴露给用户）
- 变更 review 要点：
  - N3-2 实施（spec.md §五）：新增 Sheet 3「命中场景行」时，保留 INTERNAL_FIELDS 过滤总规则，仅「命中场景」列通过**白名单显式拼装**（不破坏其他下划线字段的过滤）
  - 改字段名集合 → 其他下游 writer 可能漏过滤导致内部字段泄露
  - 必跑：smoke N3-2（Sheet 3 含「命中场景」列 + 其他 _ 前缀字段仍被过滤）+ N3-1 状态框 displayIndex 对齐

### `BANK_STATEMENT_FIELDS_FOR_C3`（v2.1.8 N2 新增 Important-skeleton ⚠️ preload 双写坑）
- 定义：
  - `src/constants/bank-statement-fields.js:60` `const BANK_STATEMENT_FIELDS_FOR_C3 = Object.freeze([...])`
  - `src/preload.js:19`（inline 重复一份，**双写坑**）
- 关联功能：C3「对账成立后赋值」第二下拉（assign-bank）的枚举源；45 项（44 标准字段 + 1 虚拟字段「发生额绝对值」）
- 变更 review 要点：
  - N2 实施（spec.md §四）：枚举列表第 2 位插入「自取值」`{ value: '__CUSTOM__', label: '自取值' }`
  - **必须两处同步**：`bank-statement-fields.js` + `preload.js` —— 漏改一处 UI / 引擎语义就分裂
  - 跨文件度 3（scan-vars baseline），改字段集合 → C3 dialog 显示 / 引擎赋值 / scenario 持久化都受影响
  - 必跑：smoke N2（dialog 显示「自取值」第 2 位 + 引擎 mode='custom' 分支 + DB migration 旧 scenario 升级）

### `serializeError` / `deserializeError`（v2.1.10 A3 新增 Important-skeleton — worker / main 跨进程错误回传契约）
- 定义：`src/main-process/serialize-error.js`（v2.1.10 Phase 1 T08 新建）
- 跨文件度：A-pair（`serialize-error.js` 定义 + `run-check-worker.js` worker 端 + `run-check-worker-pool.js` main 端反序列化；serializeError 总命中 10 次 / deserializeError 4 次）
- 关联功能：worker 内 throw error → 跨进程 IPC 序列化 → main 进程 deserialize → 调用方 catch；保留 stack / cause 链 / FileValidationError 专属字段（code / detailLines / context）；spec §2.4 完整契约
- 变更 review 要点：
  - **错误堆栈完整度**：worker 内 throw 的 err.stack 必须含 worker 内文件路径 + 行号（POC §四 已验证）；改序列化逻辑漏字段 → 主进程 catch 的 err 失去定位能力
  - **FileValidationError 专属字段**：`code / message / detailLines / context` 必须完整回传；反序列化后 `err.name === 'FileValidationError'` 判断（**注意**：跨进程 prototype 链丢失，`err instanceof FileValidationError = false`）
  - **cause 链递归序列化**：错误的 `err.cause` 必须递归走 serializeError；改实现不能漏 cause 链
  - **双侧契约**：改 serializeError 输出 schema 必须同步 deserializeError 反序列化逻辑；不能单侧改
  - **与 SR-log-1 集成**：worker 内告警通过 message pipe 上报到 main 后写入同一 SR-log-1 日志（`logs/{YYYY-MM}/{MM-DD}/{level}.log`）；改序列化字段 → SR-log-1 日志格式变化
  - 必跑：unit `tests/unit/main-process/serialize-error.test.js` 8 case + 集成 `v2.1.10-a3-phase1` 错误回传 case

---

## 3. Runtime-state — 运行时全局状态

**运行时唯一实例。**改赋值/清理时机会让 UI 与数据不同步。

### `dialog`
- 定义：`src/main.js`（来自 `require('electron')`）
- 次数：230+
- 关联功能：所有原生对话框（文件选择 / 错误报告 / 覆盖确认）
- 变更 review 要点：改 dialog 调用必须考虑用户取消分支
- ⚠️ check-vars 命中说明：`dialog` 是通用名，renderer 层 dialog factory 里也常写 `const dialog = document.createElement(...)`。命中时需人工判断是 `src/main.js` 的 `require('electron').dialog`（真命中）还是渲染层局部变量（可忽略）

### `state`
- 定义：`src/renderer.js` 顶层（单例）
- 次数：120+
- 关联功能：渲染层唯一状态对象；CLAUDE.md State Management § Renderer
- 变更 review 要点：
  - 任何子字段改动都可能引起 UI 重渲染失效
  - 特别注意：模板列表 / 当前模块 / 导出可用性 三组联动

### `elements`
- 定义：`src/renderer.js` 顶层
- 次数：100+
- 关联功能：DOM 引用缓存；初始化后不可变
- 变更 review 要点：增删 DOM 节点要同步 cache 初始化

### `setStatus`
- 定义：`src/renderer.js`
- 关联功能：状态栏唯一写入口；UI 反馈核心
- 变更 review 要点：改消息格式要同步所有调用点的语气一致性

### `lastGeneratedExports`
- 定义：`src/main.js`
- 关联功能：上次导出缓存；**CLAUDE.md State Management 明确列为"不持久化全局"**
- 变更 review 要点：
  - 改生命周期会让重复导出/打开导出目录的行为异常
  - 已知副作用：重启丢失，不要为它加持久化（与现有设计冲突）

### `statementImportSessions` / `lastFileImportContext`
- 定义：`src/main.js`
- 关联功能：会话级导入上下文（CLAUDE.md State Management 提及）
- 变更 review 要点：session key 生成逻辑变化会让导出阶段丢失上下文

### `MODULES` / `setCurrentModule`
- 定义：`src/renderer.js`
- 关联功能：模块切换状态机
- 变更 review 要点：增加模块枚举要同步 UI tab + 路由分发；`position-reconciliation-process` 仍默认闲置，但 v3.1.0 起已接入一期业务 IPC 和存档批次，不能再按纯占位模块处理

### `refreshTemplates`
- 定义：`src/renderer.js`
- 关联功能：模板列表刷新唯一入口
- 变更 review 要点：模板增删改后必须调用此函数，否则列表不同步

### `app`
- 定义：`src/main.js`（来自 `require('electron')`）
- 关联功能：Electron app 生命周期
- 变更 review 要点：改启动 / 退出钩子要考虑未保存状态

### `archiveOperationTracker` / `archiveOperationContext` / `archiveOperationTail`（v3.0.22 新增 Runtime-state）
- 定义：`src/main.js`；策略实现为 `src/main-process/archive-center/operation-tracker.js`，批次身份由 v3.1.9 `TaskLifecycle` 提供
- 关联功能：当前启动周期内为 13 个主模块与工具箱捕获本次输入/输出，把真实业务调用追加到已预留批次，并串行收口后台文件登记；不再自行持有另一套活动批次分配状态
- 变更 review 要点：
  - 批次键必须沿用 lifecycle 的 `moduleId/taskRunId/taskKey/operationKey/parentRunId`；不能把链接表、临时 MPT、资金对账、工具箱和对账单修复串到同一批次
  - 仅 `ARCHIVE_CHANNELS` 白名单进入 AsyncLocalStorage；不能让无关 IPC 参数被闭包或队列长期持有
  - 业务 handler 返回值必须先返回，归档失败只能告警；后台任务只保存轻量文件路径/结果快照，不持有银行行数组
  - 首次结果冻结和当前周期边界不可放宽；无活动批次的历史导出不得建立 output-only 批次
  - 业务成功时必须先固化源文件身份；后台复制前若文件已变化，应标记失败并要求重新执行业务，不能归档变化后的内容
  - 正常退出和在线升级退出必须等待归档队列完整排空；5 秒只用于慢退出告警，不能作为放弃尚未登记任务的上限
  - 必跑：archive operation tracker 全策略测试 + 13 主模块/工具箱关键路径 + TaskLifecycle/worker context + 启动性能检查

### `AppDatabase` / `AppDatabase.init`（v2.1.7 F7-A1 升格 Important-skeleton ⚠️ 全局影响）
- 定义：`src/backend/database.js:33` `class AppDatabase`（门面）；`init()` 方法在 `database.js:42` 附近设全局 PRAGMA
- 关联功能：项目唯一 SQLite DB 入口；CLAUDE.md State Management § SQLite 唯一持久化层；**v2.1.7 F7-A1 在 init() 内设全局 PRAGMA**（`journal_mode=WAL` / `synchronous=NORMAL` / `cache_size=-65536` 即 64 MB / `mmap_size=268435456` 即 256 MB）
- 跨文件度：2+（`src/backend/database.js` 定义 + `src/main.js:10431` 单例 `new AppDatabase(dataPath)`）
- 变更 review 要点：
  - **WAL 模式破坏性副作用**：用户机器 `tool-data.sqlite` 同目录会产生 `*.sqlite-wal` + `*.sqlite-shm` 旁文件；备份策略必须同步含旁文件（USER_GUIDE 已加 F7 WAL 旁文件备份提示）
  - 改 `cache_size` / `mmap_size` 数值 → 内存占用直接放大（64M cache + 256M mmap）；低配 Windows 机器需评估
  - 改 `journal_mode` → 回滚到 DELETE/MEMORY 会让并发读写性能退化（v2.1.6 → v2.1.7 性能提升核心来源）
  - 改 `synchronous` → NORMAL→FULL 写性能下降 ~2x；NORMAL→OFF 崩溃可能丢已提交事务（资金红线警戒）
  - init() 调用时机变化（如延迟到首次操作）→ 启动期间未跑迁移即用 DB
  - 必跑：smoke 19 suite 全套（PRAGMA 全局影响）+ 真实 DB 备份恢复演练（含 WAL 旁文件）+ 启动 cold/warm 双跑

### `updateStatusBox`（v2.1.7 R3+B5 升格 Important-skeleton ⚠️ 全局影响）
- 定义：`src/renderer.js:520` `function updateStatusBox(box, message, tone, options)`
- 当前实现：`String(message).replace(/：/g, '：\n')` 中文「：」自动换行（R3 全局规则）+ `box.dataset.tone = tone` 联动 `data-tone` 属性选择器（解决历史 tone 不生效 bug）
- 关联功能：渲染层状态栏唯一写入口；**v2.1.7 R3 加全局中文「：」换行**（配合 `src/styles-gemini-extra.css:1852` `white-space: pre-wrap`）；**B5 wiring 加固后**所有模块（acquiring / bankStatement / reconIdFix / bankBuRecon / bizOpRecon 等 6+ 模块）的状态栏全部走该入口
- 跨文件度：4+（`src/renderer.js`:520/552/561/3333/3686/3913/4143/4254 共 8+ 直接调用 + `src/styles-gemini-extra.css` + `src/styles.css` CSS 联动 + `src/renderer-dialogs.js` 部分模块间接调用）
- 变更 review 要点：
  - **全局影响**：改 `replace(/：/g, '：\n')` 规则 → 全模块状态栏文案视觉变化；删除 → 所有 ":" 文案重新挤一行
  - **B5 wiring 契约**（v2.1.7 round 3）：所有 statusBox 写入必须走 `updateStatusBox(box, message, tone)` 不能直写 `box.textContent = ...`（绕过会丢 tone + 换行）；新增模块状态栏时必须走该入口
  - 改 `box.dataset.tone` 联动逻辑 → CSS `[data-tone="error"]` / `[data-tone="success"]` 选择器失效
  - 改 `options` 参数 schema → 6+ 调用方需同步
  - **半角 `:`** 不在 R3 规则范围（仅中文「：」）；改规则覆盖半角需评估 acquiring 模块时间戳文案影响
  - 必跑：smoke 19 suite（含 R3 全局回归）+ 6+ 模块状态栏手测（每模块写入一次状态后检查换行 + tone 颜色生效）+ B5 wiring 防回归（直写 `box.textContent` 引入 → smoke 应拒绝）

### `bankStatementSession`（v2.1.16 阶段一 A5 升格 Runtime-state ⚠️ 资金对账数据处理进程级 session）
- 定义：`src/main.js:266` `let bankStatementSession = null;`（进程级，重启不持久化，与 `lastFileImportContext` 一致）
- 结构：`{ filePath, fileName, rows, headers, importedAt, sourceFiles }`（`sourceFiles` 为 v2.1.16 A5 批量合并导入新增——合并来源文件名清单；单选导入入口 `src/main.js:3449` 不带该字段，读取方按 `Array.isArray` 兜底）
- 关联功能：「资金对账数据处理」模块（`module.id='bank-statement-process'`）银行对账单数据源；被 `bank-statement:run`（clone rows 跑 dispatcher）/ `bank-statement:export`（headers + modifiedRows/unmatchedRows 写盘）/ `bank-statement:session-status`（L3712）/ `bank-statement:c3-candidate-count`（L3733）读取
- 变更 review 要点：
  - **v2.1.16 合并语义**（🔴 资金红线，2026 用户拍板「合并不覆盖」）：批量导入多份银行对账单 = **追加 rows 到同一 session 统一对账**（`src/main.js:11163` 起）；第一个建 session（含 `sourceFiles`），后续银行对账单先校验 `headers` 与 session **完全一致**（44 列同结构同顺序，`bankStatementHeadersEqual`）才追加，不一致该文件标 `invalid` 不合并（防异构表混入污染对账）
  - 🔴 **`_rowId` 全局唯一不变量**：`readBankStatement` 注入的 `row_0..row_N` 是「文件内」编号，多文件合并会重复；合并后**必须对 `session.rows` 统一重编号** `_rowId='row_'+全局index`（0-based 跨文件唯一，`src/main.js:11204`），否则 dispatcher 的 `rowLockSet`（以 `_rowId` 为键的 first-match-wins 锁）会把不同文件的同序号行当成同一行 → **漏对 / 误锁**（`scenario-dispatcher.js` modifiedRows / unmatchedRows filter 全依赖 `_rowId`，见 Critical 层 `runAllScenarios` / `unmatchedRows` 条目）
  - 改 `headers` 一致校验逻辑 → 异构表可能混入合并 → 对账数据集污染
  - 重导入（单选 / 批量首个）时同步清空 `processingResult` + `gatewayReconSession`，否则老结果 / 老网关行误用到新数据
  - 必跑：单选导入 + 批量合并多文件导入后跑 run/export，核对 `_rowId` 全局唯一 + modifiedRows + unmatchedRows.length === rows.length

### `gatewayReconSession`（v2.1.16 阶段一 A5 升格 Runtime-state ⚠️ 资金对账数据处理进程级 session）
- 定义：`src/main.js:267` `let gatewayReconSession = null;`（进程级，重启不持久化）
- 结构：`{ filePath, fileName, gwRows, importedAt }`
- 关联功能：C3「网关对账单赋值银行对账单」（`gateway-recon-join`）的网关账单数据源（资金对账不平结果表）；导入入口 `src/main.js:3490`；被 run / `c3-candidate-count` / `session-status` 读取
- 变更 review 要点：
  - **导入银行对账单时被清空**（`src/main.js:3459` 单选 / `src/main.js:11182` 批量首个）——避免把上一批 `gwRows` 误用到新银行对账单（Codex F2 P1 修复语义）
  - 改 `gwRows` 字段名 / 结构 → C3 join 比对取数失败
  - 必跑：导入网关 → 导入新银行对账单 → 确认 `gatewayReconSession` 已清空（session-status `hasGatewayRecon=false`）

### `processingResult`（v2.1.16 阶段一 A5 升格 Runtime-state ⚠️ 资金对账数据处理进程级 session）
- 定义：`src/main.js:311` `let processingResult = null;`（进程级，重启不持久化；行号以代码实际为准，旧注 :268 已陈旧）
- 结构（实际赋值见 `src/main.js:3671`）：`{ modifiedRows, unmatchedRows, modifications, errorReport, stats, platformCleanupRows, refundBackfillRows, refundUnmatchedRows, scenariosSnapshot, ranAt }`（F8 反向 filter 契约：`modifiedRows + unmatchedRows = workingBankRows`，互斥无遗漏；`unmatchedRows` 为 bank-recon-output-fixes F3「对账ID列」enrich 全覆盖 Map 的依赖之一——R5s4 warning 行多落 unmatchedRows）
- 关联功能：「资金对账数据处理」5 轮对账（C1–C4 dispatcher）运行结果缓存；run 写入、export 读取、`session-status` 透出 `stats`
- 变更 review 要点：
  - **scenarios 变更 / 重导入银行对账单 / 重导入网关时主动清空**（`src/main.js:3458` / `3496` / `11181`）——避免老运行结果被新数据 / 新场景配置误用导出（资金红线：导出的命中行必须对应当前 session + 当前场景快照）
  - 改 `modifiedRows` / `stats` 结构 → export 写盘 + 状态框统计取数错位
  - 必跑：跑出结果后改场景 / 重导入 → 确认 `processingResult` 已清空（不残留老 stats / 老命中行）

### `refundOrderSession`（v3.0.0 PR-4 升格 Runtime-state ⚠️ 资金对账数据处理进程级 session — 退款回填引擎入参源）
- 定义：`src/main.js:297` `let refundOrderSession = null;`（进程级，重启不持久化；beta.6 需求C 开通真实退款数据流）
- 结构：`{ fileName, rows, importedAt }`（`rows` = 中台退款订单 25 列对象数组）
- 关联功能：R5 场景4「中台退款订单回填」（`scenario-engines/r5-refund-order-backfill.js`，🔴 资金红线）的退款订单数据源；run 阶段 main.js 注入（`src/main.js:3612` `workingRefundOrderRows = refundOrderSession ? structuredClone(refundOrderSession.rows) : []`，未导入退款表时注入 `[]` 引擎 no-op）；v3.0.0 需求3 经 `session-status` 透出 `hasRefundOrder`（`refundOrderSession !== null`）供前端运行点 `shouldPromptRefundAtRun` 判就绪
- 变更 review 要点：
  - 🔴 **生命周期 PR#65 已收紧**（单文件导入无条件清 `src/main.js:3494`；批量导入「本批未识别到退款表」时清 `src/main.js:11460` `if (!refundImportedThisBatch) refundOrderSession = null;`）——严格绑定「本批有效导入退款表」；否则旧 refundOrderSession 残留 → 下次 run 把上一批退款订单注入新银行单 = **跨批错回填**（资金事故）
  - 🔴 **就绪判据写反 = 漏跑退款**：v3.0.0 需求3 `hasRefundOrder = refundOrderSession !== null`；前端 `shouldPromptRefundAtRun` / `maybePromptRefundOrderImport` 据此 + 退款候选预检（`countRefundBankCandidates` = FundType=Ach Return 计数）门控提醒；本迭代**只读不改其写入/清空时机**
  - 落 session 入口（`src/main.js:11529` `refundOrderSession = { fileName, rows: refundRows, importedAt }`）整体覆盖；改 `rows` 字段名/结构 → 退款回填引擎跨表字段映射（`refund-backfill-fields.js`）取数失败 = 写错回填
  - 必跑：批量导入退款表 → 跑 run（确认回填命中）→ 重导无退款表的批次 → 确认 `refundOrderSession` 已清空（session-status `hasRefundOrder=false`、run 注入 `[]` no-op，不跨批回填）

---

## 4. Risk-sensitive — 资金 / 过滤 / 迁移红线

**CLAUDE.md 第 7 条"风险显式提醒"覆盖区。**错一次会直接变成业务事故。

### 金额计算
- `roundAmount` — `file-service/normalizers.js`
- `sanitizeAmountValue` — `file-service/normalizers.js`
- 关联功能：金额舍入 + 格式标准化
- 变更 review 要点：
  - **资金安全**：精度/舍入规则变化会直接改账单数值
  - 必须跑：带小数点精度的 Excel 样例 + 负数样例 + 货币别名样例
  - 必须高亮提醒人工复核

### 余额计算
- `calculateEndingBalanceFromAmounts` — `file-service/normalizers.js`
- `inferEndingBalance` — `file-service/normalizers.js`
- 关联功能：由发生额倒推期末余额（CLAUDE.md Balance calculation）
- 变更 review 要点：
  - 算法变化会让所有"通过发生额计算"模式的模板输出数值变化
  - 必跑：单币种 + 混币种余额表对比
  - **资金相关**，必须高亮

### 行过滤
- `isRowMeaningful` — `file-service/common.js`
- `hasEffectiveAmount` — `file-service/normalizers.js`
- 关联功能：CLAUDE.md "Rows with both Credit and Debit = 0/empty are silently skipped"——**静默跳过判定依据**
- 变更 review 要点：
  - 判定变宽 → 会引入无意义空行
  - 判定变严 → 会吞掉真实数据（**风险更高**）
  - 必跑：带零值样本 / 仅单边有值 / 两边都非零（应该 abort）的样例

### 账单合并
- `mergeMappedDetailRows` — `main-process/statement-session.js`
- `cloneRowsWithMetadata` — `main-process/statement-session.js`
- 关联功能：账单拆分合并模式的核心实现
- 变更 review 要点：合并键变化会让历史模板合并行为不一致

### 固定字段解析
- `resolveSinglePreparedFieldValue` — `main-process/statement-session.js`
- 关联功能：`FIXED_FIELD_VALUE_PREFIX` 的消费方
- 变更 review 要点：与 Critical § `FIXED_FIELD_VALUE_PREFIX` 一起改，不可单独改

### 数据库迁移
- `hasColumn` — `database/migrations.js`
- `ensureAccountMappingCurrencySupport` / `ensureAccountMappingTemplateSupport`
- `ensureAmountSplitRulesSupport`
- `ensureBillSplitMergeSupport` / `ensureBillSplitTargetSeqSupport`
- `ensureParentTemplateSupport`
- `ensureTemplateBigAccountNatureSupport`
- `ensureTemplateDateFormatSupport`
- `ensureTemplateFilenameFixedFieldSupport`
- 定义：全部在 `src/backend/database/migrations.js`
- 关联功能：幂等 schema 升级
- 变更 review 要点：
  - **数据库迁移**，CLAUDE.md 第 7 条明确红线
  - 新增迁移必须幂等（可重复运行不破坏）
  - 必跑：空库启动 + 老版本库启动（可用之前的 `tool-data.sqlite` 备份）
  - 不允许 DROP / 破坏性 ALTER
  - **N4 例外（v2.1.8 破坏性 raw_json rewrite）**：`ensureBillRawJsonV2Slim` 是已立项的破坏性 migration，强制配套 DB 备份 + 事务回滚 + 标志位

### VCC storage COW migration / recovery（v3.1.10 新增 Risk-sensitive ⚠️🔴 数据迁移红线）
- 定义：`createVccStorageMigrationCoordinator`、`buildVccStorageCandidate`、`recoverVccStorageMigration` 及其 worker/ready-ack 协议，位于 `src/main-process/vcc-financial-op-storage-migration*.js` 与 `vcc-financial-op-storage-rebuild.js`
- 关联功能：显式维护模式、WAL checkpoint、空间预检、VCC v1→contract-v2 copy-on-write 重建、六类计数/哈希/九币种/Archive 守恒、原子切换、首次只读校验与崩溃回滚
- 变更 review 要点：
  - worker 完整复验后仍须持有源 `BEGIN IMMEDIATE`；coordinator 关闭全部主库连接并持 mutation lease 后才 ack 释放，禁止候选复验后出现成功写被覆盖
  - `prepared/copying/verifying/switching/switched/reopen-verified/rolling-back/rolled-back/done` journal 只能按唯一物理真相推进；候选不可读、rename/fsync失败和二次崩溃必须恢复完整 v1 或明确停止
  - 迁移不得改变有效主键/内容哈希、各月来源行数、结果、调整、归档或九币种余额；压缩率低于75%不得切换
  - updater/exit/migration 使用 owner/token lease，只能释放自己的 token；旧库删除必须由用户选择且在首次只读校验后执行
  - 必跑：真实 SQLite COW 故障矩阵、worker ready/ack、recovery 双启动、business-operation-registry、app update/exit、Archive lineage/hold、资金回归与 `npm run smoke`

### `ArchiveRepository` / `ArchiveService` / `archive_*` 十四表（v3.0.22 新增、v3.1.9～v3.1.11 扩展 Risk-sensitive ⚠️ 审计血缘）
- 定义：`src/backend/database/archive-repository.js`、`src/main-process/archive-center/archive-service.js`
- `ArchiveService` — 唯一业务编排入口，串联 repository、存储物化、任务状态、repair/retention、只读副本和存储根迁移
- 关联功能：原十表加 `archive_task_runs` / `archive_task_flow_bind_intents` / `archive_task_lineage` / `archive_maintenance_audits` 共十四表保存轻量任务、文件、直接血缘、恢复与维护审计；Documents 下年/月/日/批次目录与 SHA-256 内容寻址 Blob 保存 13 个主模块及工具箱真实输入/输出
- 变更 review 要点：
  - 十四表 schema 必须 additive/idempotent；主库只存元数据/摘要/任务身份，禁止把银行明细、Excel 字节或个人信息写入 SQLite
  - 公共 list/get/stats/latest/related 必须先套统一 visible predicate，公共 DTO 不暴露 TaskRun/dataset/parent/lineage/source path；repository raw 查询只供 recovery、hold、repair 和 migration
  - 批次号只随非空 manifest 在单事务原子递增；无文件任务、reserve 失败和 deferred 空结果不得推进；删除批次不得回退或复用已展示号码，operation issuance 永久删除后仍须阻止旧 operation key 复活
  - taskStatus 与 archiveStatus 必须分离；parent 仅保留单次 run→export 兼容关系，复用数据链由 committed direct lineage 表达，禁止递归扩散或 date/month/latest 修补
  - Blob 发布必须先在同文件系统 staging 流式写入并计算 SHA-256，再原子 rename；不得整文件读入内存或仅按文件名/大小去重
  - 删除顺序必须先移除逻辑引用，最后引用才允许删物理 Blob；部分失败要可修复，不能误删仍被其它批次引用的文件
  - `archive_artifact_holds` 是业务引用锁，不等于用户 lock；manual delete、unlock 与 retention 都不得绕过，只有对应有效数据删除或严格 lineage reconcile 才能释放
  - 017/018 maintenance 只接受显式双批号和完整事故指纹，默认 dry-run、apply 前一致性 backup、删除/重算/audit 同事务；001 永远只读，禁止进入 repair
  - 打开只能暴露只读副本，另存为覆盖失败必须恢复原目标；renderer 不得取得内部相对路径
  - 归档失败不能回滚或改写业务成功状态；日志不得输出源文件绝对路径或表格内容
  - 必跑：archive repository/service 真实 SQLite + 临时文件测试、全局批次并发、TaskLifecycle/lineage/flow anchor、共享引用删除、启动修复、失败重试、storage migration/repair/retention、`npm run release-check`
  - ⚠️ 人工复核：真实输入/结果与 Blob 的 SHA-256、模块归属和首次结果集合；自动测试不能替代

### `buildVccImportArchiveHandoffFiles` / `reconcileVccImportArchiveLineage*` / `vcc_fin_op_import_sources`（v3.1.10 新增 Risk-sensitive ⚠️🔴 审计血缘）
- 定义：`src/main-process/vcc-financial-op-archive-lineage.js`、VCC repository/schema 与 Main/Service startup hook
- 关联功能：File Task 先按冻结 manifest settle 输入，取得真实 artifactId，再把 exact-seven owner + artifactId/sourceType/ordinal/SHA/size durable handoff 给 worker；业务 source 行直接持久 exact artifactId，崩溃重启按原 TaskRun/batch 补 hold 并收口
- 变更 review 要点：
  - worker 首笔业务 DML 前必须精确比较 taskRunId、artifactId、类型、ordinal 顺序、SHA和大小；缺失、重复或 A→B 变化均须零业务写
  - startup 固定 module owner→terminal/file outbox→flow intent→ownerless sweep→raw storage/hold/retention；hook 失败时不得先清理可能被有效数据引用的 artifact
  - v1 source 只允许按持久 artifactId 直查，并复核 artifact 所属 batch.taskRunId/sourceOperation/SHA/size；不得仅凭 path、metadata、文件名或 ordinal 换绑；只有 null-ID 历史 v0 可走命名 legacy 兼容
  - source/artifact/hold 重放必须幂等，禁止按月份、文件名或 latest 猜身份；SQLite 不存完整 Excel 字节
  - 必跑：archive-lineage 真实 SQLite+FS、actual worker A→B、crash双启动、hold manual/retention、dataset artifact corruption、TaskLifecycle/outbox 与 `npm run smoke`

### `ensureBillRawJsonV2Slim`（v2.1.8 N4 新增 Important-skeleton + 🔴 破坏性 + 资金红线）
- 定义：`src/backend/database/migrations.js:803` `function ensureBillRawJsonV2Slim(db, dbPath)`
- 关联功能：v2.1.8 首次启动自动备份 DB 到 `<dbDir>/backups/tool-data-bak-pre-N4-<ts>.sqlite` → 事务包裹分批 rewrite `acquiring_bill_currency_bill_imports.raw_json` 仅保留 9 模版字段 → 写 marker `app_settings.acquiring_bill_raw_json_v2_migrated=true`
- 变更 review 要点：
  - **数据不可逆**：17 字段值永久删除；备份失败 → migration 不启动（数据完整性优先）
  - 幂等保护：marker 已写 → 跳过；失败回滚不写 marker → 下次重试
  - **不能改 N4_TEMPLATE_BILL_HEADERS 内部副本**而不同步 `TEMPLATE_BILL_HEADERS` 常量（Critical §1）
  - 备份方式 `PRAGMA wal_checkpoint(TRUNCATE) + fs.copyFileSync` 不能改成不一致的方式
  - 必跑：smoke caseN4_billRawJsonSlimMigration（首次 migrated + 幂等跳过 + 备份文件存在 + 9 字段保留 + 17 字段删除）

### `lastUserActivityTs` + `IDLE_CLEANUP_MS` + `reportUserActivity`（v2.1.8 N1' v0.7 新增 Runtime-state）
- 定义：
  - `src/main.js:25` `let lastUserActivityTs = Date.now()`（模块级）
  - `src/main.js:23` `const IDLE_CLEANUP_MS = 30 * 60 * 1000`
  - `src/preload.js:88` `reportUserActivity: () => ipcRenderer.send('app:user-activity')`
  - `src/main.js:3550` `ipcMain.on('app:user-activity', () => { lastUserActivityTs = Date.now(); })`
  - `src/renderer.js:226` `setupUserActivityReporter()`（mousemove/keydown/click/wheel/touchstart 10s 节流）
- 关联功能：N1' idle 30min 后台 cleanup 判定依据（spec v0.10 §3.2.2 N1''-D6/D7/D8）
- 变更 review 要点：
  - **节流间隔 10s**：renderer 10s 内必上报一次（避免长按拖动误判）；改短 → IPC 压力；改长 → 误判风险
  - **常量 IDLE_CLEANUP_MS 改值** → 用户体验大变；建议常量集中保留，未来 v2.1.9 评估 settings 化（D8=a 锁定不做）
  - lastUserActivityTs 是模块级单例 `let`，跨 IPC handler 共享；不能改成对象属性 + 多实例
  - 必跑：手测移鼠标 → lastUserActivityTs 更新；闲置 30min → setupIdleCleanupTimer tick 触发 cleanup

### 大账号数据迁移
- `splitTemplateName` — `database/own-accounts-migration.js` + `database.js`
- `appendMigrationLog` / `MIGRATION_FLAG_KEY` / `buildSanitizedBankNameIndex`
- 定义：`src/backend/database/own-accounts-migration.js`
- 关联功能：2026-04 之前大账号数据从 template-scoped 到 own-accounts-scoped 的迁移（详见 memory `workflow_multi_version`）
- 变更 review 要点：
  - 这是"一次性且不可回退"的迁移
  - MIGRATION_FLAG_KEY 的含义不可改（已落盘到用户机器）

### 路径归一化
- `normalizeInputFilePaths` — `main-process/statement-session.js`
- 关联功能：跨平台路径处理（Windows 反斜杠 / 网络路径）
- 变更 review 要点：必跑 Windows 环境 + 中文路径

### `aggregateFlowByAccount`（v2.1.3 流水按账户汇总）
- 定义：`src/main-process/biz-op-recon-session.js`
- 关联功能：业务OP 模块步骤 4.1 — 按 normalizeBu 过滤 + 按账户号累加 signedAmount → Map
- 变更 review 要点：
  - **资金红线**：累加错误直接导致计算 T-1 期末错位 → 全表差异判定失效
  - 内部依赖 `parseSignedAmount`（Risk-sensitive 红线）+ `normalizeBu` + `normalizeAccountKey` 三个函数
  - NaN 行 continue 跳过（导入阶段已通过 `validateFlowRow` 拦截，对账阶段二次保护）
  - 必跑：smoke biz-op-recon Case D（流水累加）+ Case G（BU 隔离）

### `parseSignedAmount`（v2.1.3 出入方向 → 正负号）
- 定义：`src/main-process/biz-op-recon-session.js`
- 实现：`'入' → +num` / `'出' → -num` / 其他 → `NaN`（OPEN ISSUE #3 拍板）
- 关联功能：流水累加时把出入方向枚举转换为正负发生额；**资金红线核心**
- 变更 review 要点：
  - **资金红线最高级**：错一个 case 分支直接资金事故（正负号倒置）
  - case 必须**完全枚举**（仅「入」/「出」），未知值必须返回 NaN，不可默认 +/-
  - 与 `VALID_DIRECTION_IN` / `VALID_DIRECTION_OUT` 常量配套（Risk-sensitive）
  - 与 `validateFlowRow` 配套：导入拦截 + 对账二次保护
  - 必跑：smoke biz-op-recon Case D（含「DEBIT」/ 空值 / 错别字反例）

### `validateBizOpRow`（v2.1.3 业务OP 双重校验）
- 定义：`src/backend/biz-op-recon-import/validator.js`
- 关联功能：业务OP 行级双重校验（OPEN ISSUE #1 拍板 B）：
  - `(1) 发生额 == 发生额（入） - 发生额（出）`
  - `(2) 期末余额 == 期初余额 + 发生额`
  - epsilon = `AMOUNT_EPSILON` (1e-2)
- 变更 review 要点：
  - **资金红线**：任一行不过 → 整批拒绝 + 失败报告（OPEN ISSUE #5 拍板）
  - 改 epsilon 阈值 → 直接影响整批拒绝判定，可能让带瑕疵数据漏入主表
  - reason 文案变化要同步失败报告 writer 的展示
  - 必跑：smoke biz-op-recon Case E（双重校验失败 + 整批拒绝 + 失败报告 xlsx）

### `validateFlowRow`（v2.1.3 流水出入方向枚举校验）
- 定义：`src/backend/biz-op-recon-import/validator.js`
- 关联功能：流水行级校验：`direction ∈ {入, 出}` + `recon_amount` 可数值化 + `account_no` 非空（OPEN ISSUE #3 拍板）
- 变更 review 要点：
  - **资金红线**：枚举判定不严会让脏值漏到对账阶段，触发 `parseSignedAmount` NaN → 静默跳过（资金事故）
  - 与 `VALID_DIRECTION_IN` / `VALID_DIRECTION_OUT` 共用常量；改任一处必须同步
  - 必跑：smoke biz-op-recon Case D + 真实流水样本检查脏值

### `AMOUNT_EPSILON`（v2.1.3 浮点精度门槛）
- 定义：`src/backend/biz-op-recon-db/columns.js`（M2 round1 提取后 — 原分散在 session.js / validator.js 两处）+ `src/backend/biz-op-recon-import/validator.js` + `src/main-process/biz-op-recon-session.js` 引用
- 当前值：`1e-2`（即 1 分钱）
- 关联功能：业务OP 双重校验（`validateBizOpRow`）+ 测算金额对比（`compareT1OpWithComputed`）共用浮点精度门槛
- 变更 review 要点：
  - **资金红线**：放宽 → 带瑕疵数据漏过校验/比对；收紧 → 误判增多
  - 必须保证多处引用同一常量（M2 round1 已提取，避免数值不一致）
  - 必跑：smoke biz-op-recon Case A/B/E（覆盖测算 + 双重校验两种使用路径）

### `VALID_DIRECTION_IN` / `VALID_DIRECTION_OUT`（v2.1.3 出入方向枚举常量）
- 定义：`src/backend/biz-op-recon-import/validator.js`（+ 引用 `src/main-process/biz-op-recon-session.js` `parseSignedAmount`）
- 当前值：`'入'` / `'出'`（中文字符）
- 关联功能：流水「出入方向」字段的合法值枚举（OPEN ISSUE #3 拍板）
- 变更 review 要点：
  - **资金红线**：值变化（如改成 'IN' / 'OUT'）→ 历史数据全部不通过校验，导入全部失败
  - 与 `validateFlowRow` + `parseSignedAmount` 三处必须同步
  - 不能加同义词（如 'in' / '入款'），避免歧义
  - 必跑：smoke biz-op-recon Case D（覆盖正反例）

### `subOneDay`（v2.1.3 业务OP T-1 → T-2 日期减一 helper，**双源**）
- 定义：`src/main-process/biz-op-recon-session.js:83` + `src/backend/biz-op-recon-db/run-repository.js:155`（**双源副本**，实现完全一致）
- 实现：`UTC + setUTCDate(getUTCDate() - 1)` + `toISOString().slice(0, 10)`（避免本地时区抢跑导致跨日错日期）
- 关联功能：业务OP 模块对账日期减一（D → D-1），即 T-1 → T-2；
  - `runReconciliation` 在 session.js 调用本地 `subOneDay` 计算 t2Date
  - `listReadyDates` 在 run-repository.js 调用本地 `subOneDay` 判定"三件齐"日期
- 变更 review 要点：
  - **资金红线**：时区错乱直接错日期 → 整批对账日期偏 1 天 → 拿错 T-2 业务OP 数据 → 计算 T-1 OP 错位 → 差异表全部失真
  - **双源**：保留双源符合 architecture 边界（避免 backend → main-process 反向依赖）；维护时**必须双侧同步**
  - **维护检查**：改任一处实现后，`grep -n "function subOneDay" src/` 确认两处行为一致
  - 不能改用 `setDate(getDate() - 1)`（本地时区版）— 在 UTC+12 / UTC-12 边界时区会抢跑或滞后 1 天
  - round 2 R2-M4 升格（spec ↔ code 对齐时发现双源；保留双源 + 加显式 review 要点）
  - 必跑：smoke biz-op-recon Case A（核心对账，验证 T-1/T-2 取数日期正确）

### `addOneDay`（v2.1.3 业务OP D → D+1 日期加一 helper，**round 4 P1 资金红线 ⚠️ 新增**）
- 定义：`src/main-process/biz-op-recon-session.js`（**单源**，与 `subOneDay` 双源不同 — addOneDay 仅在业务OP 重导清逻辑使用，无 backend 反向依赖问题）
- 实现：`new Date(date + 'T00:00:00Z')` + `setUTCDate(getUTCDate() + 1)` + `toISOString().slice(0, 10)`（与 `subOneDay` 对偶；UTC 处理避免本地时区抢跑/滞后导致跨日错位）
- 关联功能：业务OP `(date, BU)` 重导时，`runBizOpImportAsync`/worker 在事务内调用 `clearRunsAndDiffsByDateBu(db, addOneDay(date), BU)` 清下一日作为 T-2 的 run；per-month 编排层还用同一 helper 形成月末 D/D+1 下月 admission（业务OP 某日数据双角色：当天 T-1 + 下一日 T-2，参见 PRD §3.4.1 步 4.2.a）
- 变更 review 要点：
  - **资金红线**（round 4 P1 新增）：时区错乱直接错日期 → 漏清下一日 (date+1) run（用 setDate 在 UTC+12 滞后到 date）或误清后天 (date+2) run（在 UTC-12 抢跑到 date+2）→ stale 差异表 = 资金事故
  - **必须 UTC 实现**：不能改用 `setDate(getDate() + 1)`（本地时区版）；与 `subOneDay` UTC 实现完全对偶
  - **单源**：addOneDay 的实现只在 `src/main-process/biz-op-recon-session.js`；同步导入、worker 与 per-month 编排均引用该单源，无 listReadyDates 一类的第二份实现
  - **维护检查**：改实现后 `grep -n "function addOneDay" src/` 确认仅 1 处命中（如出现 2 处 → 评估是否可合并 / 是否双源同步）
  - **与 `subOneDay` 对照**：subOneDay 双源（session.js + run-repository.js）；addOneDay 单源（仅 session.js）— 业务边界不同
  - round 4 P1 升格 Risk-sensitive（与 `subOneDay` round 2 R2-M4 升格 Risk-sensitive 对齐 — 时区操作类 helper 同级红线）
  - 必跑：smoke biz-op-recon Case Q（业务OP 重导清下一日 runs；验证 addOneDay 时区安全性 + 不抢跑 / 不滞后）+ 真实数据手测（UTC+12 / UTC-12 边界时区设备跑 Case Q 不出错）

### `clearRunsAndDiffsByDate`（v2.1.3 流水重导清 runs，**round 3 P1 资金红线 ⚠️ 新增**）
- 定义：`src/backend/biz-op-recon-db/run-repository.js`
- 实现：DELETE diff_rows WHERE run_id IN (SELECT id FROM biz_op_recon_runs WHERE data_date=?) → DELETE biz_op_recon_runs WHERE data_date=?（按 date **跨所有 BU** 清）
- 关联功能：流水对账单 (`biz_op_recon_flow_imports`) 重导时清该 date 所有 BU 的旧 runs + diff_rows；由 `runFlowImportAsync` 在事务内调用
- 变更 review 要点：
  - **资金红线**（round 3 P1 新增）：流水按 date 跨 BU 共用，重导后该 date 所有 BU 旧 run 失效；漏调本函数 → 用户拿旧差异表上报 = 资金事故
  - **与 `clearRunsAndDiffsByDateBu` 区分语义不能混**：本函数按 date 跨 BU 清；`clearRunsAndDiffsByDateBu` 按 (date, BU) 单 BU 清。流水重导专用本函数；业务OP 重导专用 `clearRunsAndDiffsByDateBu`。误用对方 → 资金红线（流水重导只清单 BU 残留其他 BU stale / 业务OP 重导清光所有 BU 数据丢失）
  - DELETE 顺序固定：diff_rows → runs（FK 依赖；若反序 → 外键约束错）
  - 必跑：smoke biz-op-recon Case P（构造同 date 跨 2 BU success run + 重导流水 + 断言两 BU runs/diff_rows 均被清，业务OP 主表不动）

### `clearRunsAndDiffsByDateBu`（v2.1.3 业务OP 重导清 runs，**round 3 升格 Risk-sensitive ⚠️**）
- 定义：`src/backend/biz-op-recon-db/run-repository.js`
- 实现：DELETE diff_rows WHERE run_id IN (SELECT id FROM biz_op_recon_runs WHERE data_date=? AND LOWER(TRIM(bu_name))=LOWER(TRIM(?))) → DELETE biz_op_recon_runs WHERE data_date=? AND LOWER(TRIM(bu_name))=LOWER(TRIM(?))（按 (date, BU) **单 BU** 清；C1 round 1 修订已对齐 LOWER+TRIM）
- 关联功能：业务OP (`biz_op_recon_imports`) 重导时清该 (date, BU) 二元组的旧 runs + diff_rows；由 `runBizOpImportAsync` 在事务内调用（OPEN ISSUE #15 拍板 A 联动清空）
- 变更 review 要点：
  - **资金红线**：与 `clearRunsAndDiffsByDate` 区分语义不能混（详见上一条）；业务OP 按 (date, BU) 分片，本函数只清单 BU；其他 BU 数据保留
  - **C1 round 1 修订**：BU 比较 SQL 必须 `LOWER(TRIM(bu_name)) = LOWER(TRIM(?))`，与 `getRowsByDateBu` 完全对齐；脱口 → 大小写差异时清不掉旧数据 = 资金红线
  - DELETE 顺序固定：diff_rows → runs（FK 依赖）
  - 必跑：smoke biz-op-recon Case L（C1 大小写归一防回归）+ Case O（I2 BU trim 边界扩展）

### `pickConditionsLogicChecked`（v2.1.7 F1+R5 helper，升格 Risk-sensitive ⚠️ 资金红线三层护栏第 2 层）
- 定义：`src/renderer-dialogs.js:6298-6306` 函数
- 实现：
  - mode=create（draft.config.conditionsLogic 已注入 'AND'）→ `cfg.conditionsLogic === 'OR' ? 'OR' : 'AND'`（跟随 draft）
  - mode=edit/view（老 scenario 无字段）→ `cfg.conditionsLogic === 'AND' ? 'AND' : 'OR'`（fallback 'OR' 兼容历史）
- 关联功能：F1 C1 dialog conditionsLogic radio 默认选中决策；R5 资金红线**三层护栏第 2 层**（第 1 层 createDefaultScenarioConfig 默认 / 第 3 层 runC1Scenario fallback）
- 变更 review 要点：
  - **资金红线**（R5 三层护栏）：与 `conditionsLogic` 字段配套维护；改 helper 决策方向（如把 edit fallback 改为 AND）→ 老用户编辑场景被默认改为 AND → 多条件场景命中行数突变 → 错改账单
  - helper 必须**只读决策**：不能修改 draft.config（用户切换 radio 后才落 config.conditionsLogic）
  - 改 mode 判定逻辑（mode === 'create' / 'edit' / 'view' 分支）→ 必须同步 dialog 三种入口的 wiring
  - 必跑：smoke c1 AND/OR 默认值（mode=create 新建场景默认 AND）+ 老 scenario 编辑（mode=edit，conditionsLogic 字段缺失，默认 OR）+ preview F1 mode=create 截图 AND radio 选中

### `runC1Scenario`（v2.1.7 F1 C1 提取 reconId 引擎，升格 Risk-sensitive ⚠️ 资金红线三层护栏第 3 层）
- 定义：`src/main-process/scenario-engines/c1-extract-recon-id.js:103` `function runC1Scenario(scenario, bankRows)`
- 关联功能：C1 场景执行 — 按 scenario.config.conditions（数组）+ scenario.config.conditionsLogic（'AND'/'OR'/undefined）遍历 bankRows；命中行按 regex 提取 reconId 写入 row[reconIdField]；**v2.1.7 F1 引擎 fallback**：`conditionsLogic === 'AND' ? AND逻辑 : OR逻辑`（**默认 OR 维持历史行为** — R5 三层护栏第 3 层）
- 跨文件度：2+（自身定义 + `src/main-process/scenario-dispatcher.js` runAllScenarios 调用 + smoke test 引用）
- 变更 review 要点：
  - **资金红线**（R5 三层护栏第 3 层）：fallback 默认改为 AND → 老 scenario 无 conditionsLogic 字段会被引擎"且"逻辑跳过原本应命中行 → 漏改账单
  - 改 conditions 数组语义（regex / value 字段判定）→ 影响所有 C1 场景命中行集合
  - 改 reconId 写入字段名（默认 `reconId`）→ 下游所有依赖该字段的功能失效（C3 网关核销 / reconIdFix / 导出）
  - 与 `pickConditionsLogicChecked` helper 默认值"对偶"：helper edit fallback `'OR'` ↔ 引擎 fallback `'OR'` 必须一致
  - 必跑：smoke c1 AND/OR 切换全套 + 真实银行账单 C1 端到端 + R5 三层护栏防回归

### `runC2Scenario`（v2.1.7 F4 C2 银行对账单字段赋值引擎，升格 Risk-sensitive ⚠️ 资金红线）
- 定义：`src/main-process/scenario-engines/c2-offset-bill-mark.js:57` `function runC2Scenario(scenario, bankRows)`
- 关联功能：C2 场景执行 — 按 scenario.config.billTypes（≥ 1，v2.1.7 F4 放宽，原为 ≥ 2）+ scenario.config.reconFields（可 0，v2.1.7 F4 放宽）筛选命中行，命中行字段赋值；**v2.1.7 F4 重命名**：原 "账单打标" → "银行对账单字段赋值"（功能扇出 ~10 处文案）
- 跨文件度：2+（自身定义 + `src/main-process/scenario-dispatcher.js` runAllScenarios 调用 + smoke）
- 变更 review 要点：
  - **资金红线**（F4 放宽）：billTypes ≥ 1 + reconFields 0 无条件赋值是 v2.1.7 拍板（spec §5.7 方案 A），改回 ≥ 2 + ≥ 1 → 用户场景全部失效
  - reconFields = 0 时无条件赋值（不需要条件匹配）— 改回带条件 → 用户单 billType + 0 reconFields 场景失效
  - 改 billTypes 校验逻辑 → 必须同步 dialog 校验（renderer-dialogs.js C2 dialog `>= 1` 门槛）+ delete 按钮门槛（F4 R1 + F4 删空）
  - 字段重命名扇出（10+ 处）→ 已 v2.1.7 commit a5d6eed 全量替换；新增引用必须用新名"银行对账单字段赋值"
  - 必跑：smoke c2 全套（billTypes=1 / reconFields=0 / 混合）+ 真实银行账单 C2 端到端

### `config.billTypes` / `config.conditions`（C2 银行对账单字段赋值 config schema，v2.1.12 I7 升格 Risk-sensitive ⚠️ 资金红线）
- 定义：scenario.config JSON 字段 — `billTypes`（数组，≥ 1，v2.1.7 F4 放宽）+ `conditions`（数组，可空）；序列化在 `scenarios.config_json`（`src/backend/database/scenarios-repository.js` serializeConfig/parseConfig），引擎消费 `src/main-process/scenario-engines/c2-offset-bill-mark.js:57 runC2Scenario`，弹窗读写 `src/renderer-dialogs.js` C2 dialog
- 关联功能：C2 命中行筛选契约 — `billTypes` 决定命中哪些账单类型；`conditions` 决定附加筛选条件（配 `conditionsLogic` AND/OR）；命中行做银行对账单字段赋值（资金影响）
- 跨文件度：4+（config schema / 引擎 runC2Scenario / dialog 校验 / bundle 旧结构升级 / scan:vars 盲区）
- 变更 review 要点：
  - **资金红线**：billTypes/conditions schema 改动直接影响 C2 命中行集合 → 错改/漏改银行对账单字段
  - 改字段名/结构 → 必须同步：引擎（c2-offset-bill-mark.js）+ dialog 校验（renderer-dialogs.js C2 `>= 1` 门槛）+ bundle 旧结构升级（detectBundleType / 升级路径）+ createDefaultScenarioConfig 默认值
  - 与 `runC2Scenario`（命中算法）+ `conditionsLogic`（AND/OR 切换契约）配套维护
  - check:vars 历史盲区（v2.1.12 I7 升格原因）：billTypes/conditions 作为 config 字段名此前仅在 runC2Scenario 描述行内出现、无独立符号条目 → scan:vars 符号匹配扫不到
  - 必跑：smoke c2 全套（billTypes=1 / conditions / 混合）+ bundle 旧结构 C2 导入升级 e2e（I6）+ `npm run scan:vars` 刷新

### `readGatewayBillRowPoolsByChannels` / `c3GwRows`（v3.0.23 新增 Risk-sensitive ⚠️🔴 资金候选边界）
- 定义：
  - `src/backend/database/linked-table-repository.js`：一次 `ORDER BY id ASC` 查询返回 `{ exactRows, c3Rows }`；有效相同行只 `JSON.parse` 一次并在两数组共享对象。
  - `src/backend/database.js`：facade `readGatewayBillRowPoolsByChannels(channels)`。
  - `src/main.js` / `src/main-process/reconciliation-orchestrator.js`：`exactRows` 作为 `gwRows` 供 R1/R3.5/R4/R5，`c3Rows` 只作为可选 `c3GwRows` 注入 R2 dispatcher。
- 关联功能：银行账单运行的网关大表预筛；决定哪些网关记录能进入 C3 及其它资金轮次候选池。
- 🔴 变更 review 要点：
  - **双池隔离**：`exactRows` 必须保留旧 trim 后大小写敏感、空/缺 Channel 和损坏 JSON 跳过语义；`c3Rows` 才允许 `TRIM(Channel) COLLATE NOCASE`。禁止把 c3Rows 传给 R1、DBS-Charge、R4、R5 或退款过滤。
  - **精确而非模糊**：`Maybank` 只扩展到大小写/首尾空格变体，不得使用 `LIKE '%...%'`、`includes` 或前缀匹配；`MAYBANK2` 必须排除。
  - **C3 内部仍严格**：双池只改变数据库预筛；场景显式 Channel condition/recon field 继续走现有大小写敏感比较。
  - **大表资源边界**：只能一次 SQL、一次 JSON 解析；禁止恢复全表读取、双查询或为两个池深拷对象。SQL 必须保留 `json_valid` 和 `id ASC`。
  - **兼容入口**：`runReconciliation` 未传 `c3GwRows` 时必须回退 `gwRows`，避免旧集成脚本和直接调用失效。
  - 必跑：`gateway-channel-filter.test.js`、`bank-statement-run-handler-seam.test.js`、C3/R1/R4 隔离编排器测试、`gateway-channel-filter-equivalence.js` 与 `npm run release-check`。

### `runC3Scenario`（v2.1.7 F2 C3 网关 1v1 引擎，升格 Risk-sensitive ⚠️ 资金红线方案 A）
- 定义：`src/main-process/scenario-engines/c3-gateway-recon-join.js:81` `function runC3Scenario(scenario, bankRows, gwRows)`（行号以代码实际为准，旧注 :68 已陈旧）
- ⚠️ v3.0.4 块 D F1：C3 Extra Fee 写盘取相反数（匹配语义不变，写盘点 `normalizeCellValue(-fee)`）——存量已配置 extraFee 的场景升级后同输入产出相反符号，取反值同时出现于主输出 / 命中明细文本 / 命中场景行报表三个出口（资金红线，详见 `changes/bank-recon-output-fixes/spec.md` F1）
- 关联功能：C3 场景执行 — 网关 reconId 1v1 join；**v2.1.7 F2 方案 A**：用 Set 候选池（gwCandidatePool）严格 1v1 — 一个网关行匹配后从池移除，避免同一网关行被多个银行行重复匹配（资金红线核心修复）
- 跨文件度：2+（自身定义 + `src/main-process/scenario-dispatcher.js` runAllScenarios 调用 + smoke c3 5 case）
- 变更 review 要点：
  - **资金红线**（F2 方案 A 核心契约）：删除 Set 候选池 / 改回 1v多 → 同一网关行可能被多个银行行重复匹配 → 用户错改账单出现"幽灵核销"
  - 改 Set 数据结构（如改 Array indexOf）→ 性能 O(n²) 风险 + 删除语义不变
  - 改 match key（默认 reconId）→ 必须同步 dialog 配置 + bankRows / gwRows reader 字段
  - gwRows 入参允许 null/empty（C3 场景 gw 文件可选）→ 改逻辑必须保留空数组兜底
  - v3.0.23 生产编排器可传 C3 专用 Channel trim+NOCASE 候选池；这不改变本引擎 conditions/reconFields 的大小写敏感比较或内部 1v1 消费
  - 必跑：smoke c3 5 case（包含 1v1 / 1v多反例 / 候选池耗尽 / 空 gw）+ 真实银行账单 + 网关账单端到端

### `writeBankStatementOutput`（v2.1.7 F8 升格 Risk-sensitive ⚠️ 资金红线 + F8 第 2 sheet 契约）
- 定义：`src/main-process/exceljs-writer.js:106` `async function writeBankStatementOutput(rows, headers, savePath, unmatchedRows = null, modifications = null)`（行号与签名以代码实际为准，旧注 :53 与 4 参签名已陈旧）
- 关联功能：银行账单导出唯一 writer — 仅修改行 + 单元格黄底 + 表头；**v2.1.7 F8 新增第 4 参数 `unmatchedRows`**：非 null 时输出第 2 sheet "未命中场景行"；命名 sheet 1 = "渠道对账单"（exceljs-writer.js:56 SHEET_NAME 常量真实值，self-review I-10 修正）、sheet 2 = "未命中场景行"
- 跨文件度：2+（自身定义 + `src/main-process/bank-statement-io.js:20/212-213` 桥接调用）
- 变更 review 要点：
  - **资金红线**（F8 契约）：sheet 1 仅写 rows（modifiedRows）— 严守 v2.1.7 之前 baseline 不变（smoke baseline 已锁定 modifiedRows.length 不漂移）
  - sheet 2 输入 unmatchedRows 必须经 `stripInternalFields` 剥 `_rowId` 等内部字段
  - 改第 4 参数默认值（null → []）→ 老调用方未传第 4 参数时**不应**触发第 2 sheet 输出（兼容性）
  - 改 sheet 命名（"已处理" / "未命中场景行"）→ 用户文件名认知不一致 + USER_GUIDE 同步
  - 改黄底单元格判定逻辑 → 全模块视觉变化
  - **ExcelJS vs SheetJS**：v2.1.7 dev 路径已用 ExcelJS（commit d289779）；spec §9.8.4 PM sketch 当初按 SheetJS 起草已反向同步双版本说明；改 writer 库需评估 cellStyle / sheet 命名 / 性能
  - 必跑：smoke `npm run smoke` 全 19 suite（含 F8 第 2 sheet 行数断言）+ 真实银行账单端到端（带未命中场景）+ baseline modifiedRows 防回归

### `BANK_DEPOSIT_FIELDS`（链接表 bank-deposit 落库白名单，v3.0.4 块 E 升格 Risk-sensitive ⚠️🔴 13→14）
- 定义：`src/backend/database/linked-table-repository.js:37`（v3.0.4 在 CustomerRef 与 FundType 之间插入 `'Payment Detail'`，13→14）
- 关联功能：链接表「银行对账单入金表」落库裁列白名单；BOC调拨银行对账单表派生（`buildBocBankRows`）的「银行单交易编号」提取完全依赖 `Payment Detail` 字段
- 变更 review 要点：
  - 🔴 **存量已导入 bank-deposit 行 raw_json 无 `Payment Detail`、无法 migration 补**——只能识别后引导**重新导入银行对账单表**才支持 BOC 回填（availability 三态 `missing-payment-detail`）；对外契约变更（CHANGELOG 已注）
  - ADM 派生行 `{...r}` 浅拷贝连带多带该字段（JPM 引擎全程 FIELD_MAP pick，已核无副作用）；`boc-fx-link-fields.js` / `adm-bank-deposit-fields.js` 模块加载期断言防白名单回退漂移
  - 必跑：`linked-table-boc.test.js`（BANK_DEPOSIT_FIELDS=14 断言）+ 既有 bank-deposit-import 13→14 断言同步

### BOC调拨订单修复链（v3.0.4 块 E 新增 Risk-sensitive ⚠️🔴 资金红线 — 两张隐藏表 + 派生 builder + 整组匹配引擎）
- 定义：隐藏表 `linked_boc_fx_settlement` / `linked_boc_bank_deposit`（DDL `migrations.js:2947` `ensureBocFxLinkSupport`，**不进 `ALL_TABLE_KEYS` / 不写 `linked_table_meta`** 隐藏红线）；派生纯函数 `src/main-process/boc-fx-link-builder.js`（scanFxGroups / matchBocToMidAllocation / buildBocBankRows / backfillBocReconLinkIds）；修复引擎 `src/main-process/scenario-engines/boc-dispatch-order-fix.js:34` `runBocDispatchOrderFix({sheets, bocLinkRows, scenario})`（纯函数、入参只读、链接表只读不回写）；常量 `src/constants/boc-fx-link-fields.js` / `boc-dispatch-order-fields.js`
- 关联功能：外汇交割表导入→全量重建 BOC链接表（分组/中台匹配/调拨单号回填）；银行对账单表导入→重派生 BOC调拨银行对账单表 + 对现有链接表补做 2.5 回填（按 id UPDATE）；内置场景「BOC调拨订单修复」（`migrations.js` `ensureBocDispatchOrderScenarioSeed`，priority=3 / enabled=0 / config.subCategory='boc-dispatch-order-fix'）；run 注入 `runOpts.bocLinkRows = database.readBocFxLinkRows()`
- 变更 review 要点：
  - 🔴 **修复行生成属资金对账输出**：D1-D11 全从严（组级校验任一失败→整组不产出不消耗；OrderId 唯一命中才生成；Type=2 number / Reference=链接ID / Amount=货币1金额原值透传）；引擎头注释防后人「对齐 JPM 取第一」误改
  - 🔴 **交割表强制数组路径**：`useStreamingPath = ... && repoKey !== 'fx-settlement'`（流式 feed 过滤空行且不透传 rowIdx，分组依赖物理行号断档）——守卫即契约，勿删
  - **stale 风险（U4 拍板）**：中台调拨订单表重导后 BOC链接表调拨单号不自动重算，须重导交割表（CHANGELOG/USER_GUIDE 已注）
  - 必跑：`boc-fx-link-builder.test.js` / `linked-table-boc.test.js` / `boc-dispatch-order-fix.test.js` / `migrations-boc-dispatch-order-seed.test.js` + 集成 `v3.0.4-boc-dispatch-order-fix.js` + 真实样本人工核对 14 列/Type=2/Reference/Amount

### R5s2b Payment线下调拨订单回填（v3.0.4 块 F 新增；v3.0.24 扩展多大账号 Risk-sensitive ⚠️🔴 资金红线 — 向 ReconciliationId 写值 + 网关回填优先互斥；修订 R2 方向翻转）
- 定义：引擎 `src/main-process/scenario-engines/r5-payment-offline-allocation-backfill.js`（纯函数 `(bankRows, midAllocationRows, options) → {modifications, warnings, matchedPairs}`，修订 R2 返回值扩展——matchedPairs 项 `{bankRow, orderRow, round, oldReconciliationId, dayDiff(带符号)}` 供导出 3 核对 sheet）；周数工具 `src/main-process/scenario-engines/engine-week-utils.js:75` `weekTag(value)`（ISO 8601 + ISO week-year）/ `weekTagPlusOne`（日期语义 +7 天所在周，禁 YYWW 数字加法）；字段常量 `src/constants/payment-offline-allocation-fields.js`（修订 R2：删 payChannel，+payMethod/receiveChannel/OFFLINE_PAY_METHOD/`MATCH_RULES`{txLagToleranceDays:2, relaxedWindowDays:7}）；共享解析器 `src/shared/payment-big-accounts.js`；config schema `config.paymentOfflineBackfill = {enabled, bankChannel, region, bigAccount}`，其中 `bigAccount` 仍为字符串，但语义是严格中文顿号分隔的一个或多个账号
- ⚠️ **修订 R2（2026-06-12，spec §R2）已取代初版匹配规则**：① join 方向翻转「银行周 + 1 = 订单周」（线下钱先动单后补，weekTagPlusOne 在银行侧）；② 订单池三条件 = 收款账户（卡号）∧ 付款方式==='线下' ∧ **收款渠道**===bankChannel（初版「付款渠道」筛选废弃）；③ 三轮阶梯 R1 main / R2 date-tolerance(回看2天) / R3 relaxed-week(不限周±7天) 取代「主轮+差错池」（billDateEarlier/errorPool 已删）；④ 导出链 `paymentOfflineMatchedPairs` 经 orchestrator→processingResult→`writeBankStatementOutput` 第 6 参追加 3 核对 sheet（匹配对照/银行行-原始/订单行-原始；pairs 空时主文件形态零变化）
- 关联功能：编排器 R5s2b 步骤（`reconciliation-orchestrator.js:247` gating = r5s2Bucket 非空 ∧ `config.paymentOfflineBackfill.enabled===true` ∧ midRows 非空）；run 时按 gating 读 `database.readLinkedTableRows('mid-allocation')` 全表注入 `midAllocationContext`；UI 在「请选择适用的银行渠道」弹窗按 `subCategory==='fund-transfer-backfill'` 条件渲染勾选行 + 三输入框
- 变更 review 要点：
  - 🔴 **双引擎互斥（Q3 网关回填优先）**：R5s2 先跑，已消费/已回填 bank `_rowId` 经 `options.excludeBankRowIds` 剔除出本引擎银行池（编排器 `excludeBankRowIds` = union(modifications rowId ∪ R5s2 引擎返回 `usedBankRowIds`)，`reconciliation-orchestrator.js:218-239`）——零互相覆盖，单测含互斥断言
  - 🔴 **config 整包覆盖红线**：UI 保存浅合并严禁丢 funcCategory/subCategory/roundPhase/directions/dateToleranceDays（丢任一字段场景静默掉 r5s2 桶或引擎漂移）；main 进程 builtin-fixed config 更新最小校验 + bucketScenarios 不掉桶单测
  - **周数口径**：weekTag 订单侧/银行侧共用同一实现；基准四元组写死断言 2026-06-02→2623 / 2026-01-01→2601 / 2025-12-29→2601 / 2027-01-01→2653
  - 🔴 **多账号隔离**：UI 与主进程必须复用 `parsePaymentBigAccounts`；只接受 `、`，拒绝空段/重复/逗号。订单和银行先做集合 membership，再要求 `bank.MerchantId === mid.收款账户（卡号）`；R1/R2 按“账号 × 周”分桶，R3 也必须带同账号条件，禁止金额币种日期碰撞时跨账号回填
  - **历史配置兼容**：单账号字符串是合法单元素列表；非法历史字符串必须安全 no-op 并输出 `payment-offline-invalid-big-account-config`，不得静默合池或退回模糊匹配
  - **stale 资金数据**：mid-allocation 导入补清 `processingResult`（本功能改变「mid 不喂 run 不清」前提）
  - **既有疑点（记 backlog）**：`ADM_FUND_TYPES` 'Fundtransfer-out' 小写 t 与资产表 `FundType枚举值.xlsx` 不一致；本功能取大写 T 不顺手改 ADM
  - 必跑：引擎单测（FTA/周数/双引擎互斥/Q6 同日算晚于/三轮阶梯/matchedPairs 形状）+ writer 3 核对 sheet 单测 + orchestrator 行数守恒与 matchedPairs 透传 + config 合并不掉桶 + renderer-dialogs 源码字符串断言 + 真实数据回放基准（spec §R2.4：100 对 R1=87/R2=7/R3=6、唯一未消费订单 FTA202606021000465）+ 手测 /verify（勾选→导两表→run→标黄/3 核对 sheet/未匹配报告 + stale 拒导出）

### `cleanup_pending`（v2.1.8 N1 新增 Risk-sensitive — DB 新列，cleanup 延后触发标志）
- 定义：`acquiring_bill_currency_runs.cleanup_pending INTEGER DEFAULT 0`（v2.1.8 N1 新增列，migration 在 `src/backend/database/migrations.js`）
- 关联功能：N1 β 方案 — runCheck 成功后 SET=1 标识"待清理"；app.before-quit 钩子检测并触发清理；cleanup 完成后 SET=0
- 变更 review 要点：
  - **migration 必须幂等**：`ALTER TABLE ... ADD COLUMN ... DEFAULT 0`，旧记录默认 0（已完成清理）
  - 改默认值 → 旧记录可能被误判为"待清理"触发不必要的清理
  - 改列类型 / 列名 → 所有 runs 表查询 / repository 方法同步
  - 涉及 API：`run-repository.js` 新增 `markCleanupPending` / `clearCleanupPending` / `listPendingCleanupRuns`
  - 必跑：smoke N1（migration 幂等 + 标志位 SET/CLEAR + 启动孤儿清理仍工作）

### `config_json.assign`（v2.1.8 N2 新增 Risk-sensitive ⚠️ 对账契约扩展 — v0.5 修订）
- 定义：scenarios.config_json 字段下 `assign` 对象（v2.1.7 仅 `{gwField, bankField}`，v2.1.8 扩展为 `{gwField, bankField, mode, customValue}`）
- 关联功能：C3「对账成立后赋值」配置；v2.1.8 N2 新增"自取值"模式 — **「自取值」加在 assign-gw（数据源），v0.5 修订 from assign-bank（写入目标）**；`mode: 'direct' | 'custom'`；`customValue` 在 mode='custom' 时使用
- 变更 review 要点：
  - **对账契约扩展**：scenarios 数据结构升级，老 scenario 必须 graceful 升级（用户场景库已沉淀不能丢）
  - migration 必须幂等：扫描所有 category='gateway-recon-join' 的 scenarios，对缺 `assign.mode` 的补 `mode='direct'`
  - bundle 兼容（spec.md §四 N2-D4/D5）：v3 bundle 向前兼容 — 旧 bundle 自动补 mode='direct'；v2.1.8 bundle export 时 mode='direct' 省略字段（体积更小）
  - **`__CUSTOM__` sentinel（v0.5）**：mode='custom' 时 gwField='__CUSTOM__'（数据源 sentinel）+ customValue=用户输入；bankField 不变（仍是真实银行字段写入目标）；旧 reader 看到 gwField='__CUSTOM__' → chosen.row['__CUSTOM__']=undefined → normalizeCellValue → '' → 不抛错但行为退化为"写空值"
  - 引擎读取（`c3-gateway-recon-join.js:158-172`）必须按 mode 分支：`mode==='custom'` → `String(assign.customValue || '')` / 否则 → `normalizeCellValue(chosen.row[assign.gwField])`
  - 必跑：smoke N2（migration + 引擎分支 + bundle 来回 import/export 兼容）

### ~~`GATEWAY_RECON_FIELDS`~~（v0.5 升 Important-skeleton 计划 → **v0.6 撤回**）

**v0.6 撤回原因**：v2.1.8 N2 实施前发现 GATEWAY_RECON_FIELDS 被 `bank-statement-io.js:114` 用作网关账单 reader 表头校验 + `renderer-dialogs.js:5908/6131/6212` 多处条件下拉。在数组里加 `'__CUSTOM__'` 会破坏 reader 表头校验。改为仅在 `renderer-dialogs.js:6105-6108` assign-gw select 渲染层单独拼接 `<option value="__CUSTOM__">自取值</option>`，constants 保持不变。

GATEWAY_RECON_FIELDS 维持原有非升格状态（已经在 scan-vars 中是 A-share 跨度）。

### `hitScenarios`（v2.1.8 N3-1 新增 Risk-sensitive ⚠️ IPC 字段重命名 + 结构变更；v3.0.3 PR-E 双维路径再扩展）
- 定义：scenario-dispatcher.js stats.hitScenarios 数组元素 `{id, displayIndex, name}` —— **取代 v2.1.7 的 hitScenarioIds (number[])**
  - **v3.0.3 PR-E**：**双维路径**（deps 提供）元素再附带 `channelId`（number）+ `channelName`（string，channels.name；通用渠道为「通用」）；
    去重键由 `scenario.id` → `${channelId}:${scenario.id}`（场景与渠道多对多 → 同场景跨渠道命中各记一条）。
    **legacy 单维路径不变**：元素仍 `{id, displayIndex, name}`，去重靠单维顺序（无 channelId/channelName）。
- 关联功能：
  - 推送：`src/main-process/scenario-dispatcher.js:99` `hitScenarios.push({id, displayIndex, name})`
    （v3.0.3 PR-E：双维 runChannelBatch push 再加 `channelId/channelName`；去重键 `hitKey=${hitChannelId}:${scenario.id}`）
  - IPC：`src/main.js:3045` 返回 `stats.hitScenarios`
  - 状态框：`src/renderer.js:3319` 显示 `displayIndex` 替代 DB id
    （v3.0.3 PR-E：updateBankStatementUi 在新数据「每条均有非空 channelName」时按 channelName 分组换行展示「渠道名:序号」，半角冒号；旧持久化/legacy 数据回退原 `（场景 1、3）` 格式）
- 变更 review 要点：
  - **IPC 字段重命名**：`hitScenarioIds` → `hitScenarios`，必须 grep 全部调用方同步
  - 结构变更（number[] → object[]）：消费方读取方式从 `ids.join('、')` 改 `arr.map(s => s.displayIndex).join('、')`
  - **v3.0.3 PR-E 结构再扩展（向后兼容）**：双维路径加 `channelId/channelName` 属字段追加（消费方读特定字段不受影响）；
    改去重键 `${channelId}:${scenario.id}` 仅影响双维 hitScenarios 去重粒度（同场景跨渠道由 1 条变多条），legacy 路径与所有行级资金红线不变量不受影响；
    renderer 分组展示必须用半角 `:`（全角「：」会被 updateStatusBox 自动补 \n 打断「渠道名:序号」同行）。
  - 不变量护栏（v2.1.7 F8 已有）：`modifiedRows + unmatchedRows = inputRows` 不变
  - 必跑：smoke N3-1（状态框序号 = 场景管理 UI 序号 + grep `hitScenarioIds` 零命中）+ smoke F8（modifiedRows + unmatchedRows 守恒）
    + v3.0.3 PR-E：unit `scenario-dispatcher.test.js` 双维 channelId/channelName + 同场景双渠道两条 + legacy 无新字段；preview 状态框多行可滚 + 单行居中

### `displayIndex`（v2.1.8 N3-1 新增 Risk-sensitive ⚠️ 跨多层一致性）
- 定义：scenarios 实体新增计算字段 `displayIndex`（1-based 按 sort_order + id 顺序），在 `src/backend/database/scenarios-repository.js.listScenarios` 返回时统一附加
- 关联功能：N3-1 修复"状态框命中场景号与场景管理 UI 序号不一致"
- 变更 review 要点：
  - **派发口径**（spec.md §五 N3-D1）：在 repository 层统一附 displayIndex，UI / 引擎共享同一份计算 — 避免双源真理
  - 改派发口径（移到 UI 自算 / dispatcher 入参时算）→ 编号体系再次分裂，N3-1 修复失效
  - 必跑：smoke N3-1（main 端 displayIndex 与 UI 列表 displayIndex 字段值逐项相等）+ 手测对比场景管理 dialog 与状态框

### per-月侧库体系（v3.0.5 建立；v3.0.15 接入重复入金匹配，Risk-sensitive ⚠️🔴🔴 资金红线）
- 定义：
  - `src/backend/run-data-store.js`：`KNOWN_MODULES` 新增 `MODULE_PRE_FUND_RECONCILIATION`（跨重启临时 MPT）和 `MODULE_PRE_FUND_RECONCILIATION_RESULTS`（当前 run 可回收结果）；`SIDE_DB_DDL_PRE_FUND_GATEWAY` / `SIDE_DB_DDL_PRE_FUND_RUNS` 分别是两套 DDL 唯一真相。
  - v3.0.15 新增 `MODULE_DUPLICATE_INBOUND_MATCH` / `SIDE_DB_DDL_DUPLICATE_INBOUND_MATCH`，只保存当前启动周期的银行 46 列、运行结果和组级血缘；主库 `duplicate_inbound_match_run_mirrors` 只保存轻量状态/摘要/hash/side path。
  - 既有三模块编排层不变；前置资金对账由 `src/main-process/pre-fund-reconciliation/service.js` 统一编排 import/run/mirror/export，`pre-fund-reconciliation-run-store.js` 只操作 side DB。
  - 主库新增轻量 `pre_fund_reconciliation_run_mirrors`，保存 `side_db_rel_path + side_run_id + status + summary`；不保存任何 MPT/候选/结果 bulk 行。
- `MODULE_PRE_FUND_RECONCILIATION` / `MODULE_PRE_FUND_RECONCILIATION_RESULTS` / `SIDE_DB_DDL_PRE_FUND_GATEWAY` / `SIDE_DB_DDL_PRE_FUND_RUNS` / `PreFundReconciliationRunStore` — 前置资金对账双生命周期侧库入口、两套 DDL 单一真相和结果游标。
- 关联功能：五个对账模块、六个存储模块的 run 级批量数据位于 `{userData}/run-data/{module}/month-{YYYY-MM}.sqlite`；前置资金对账还把跨重启临时 MPT 批次放侧库，主库 `linked_gateway_bill` 绝不被临时导入覆盖。
- 🔴 变更 review 要点（资金红线，改动前必读）：
  - **算法零改动不变量**：`runCheckCore`（acquiring）/ `runReconciliation`（biz-op/bank-bu）/ 4 步算法 / diff JOIN / epsilon **一字不改** —— 它们在「侧库 db 句柄」上跑 = 在主库上跑（同库自洽）。改动算法须重跑 `acquiring-side-db-parity` / `biz-op-recon-side-db-parity` / `bank-bu-recon-side-db-parity` 三 parity（byte-for-byte + 主库表恒 0 行 + 冻结 golden）。
  - **DDL 单一真相**：既有三模块仍要求 side/main schema byte-for-byte；前置资金对账从未在主库建 bulk 表，side DDL 只在 `run-data-store.js` 定义，主库镜像 schema 有意不同。改 side DDL 后必须跑 store/run-store 两层测试和 parity。
  - **runId 命名空间**：侧库自增 run id ≠ 主库镜像 id。对外 UI/IPC 一律返回主库镜像 id；前置资金对账导出必须使用内存绑定的 `sideRunId` 读 side DB。混用会跨月读错结果。
  - **biz-op per-month 跨月边界**（单库自洽命门）：月末 D 导入时编排层补清下月侧库 (D,BU)+(D+1,BU) 旧 run + 写 D 的 T-2 冗余副本到下月侧库；月初对账 date 的 T-2(上月末) 由该冗余副本在当月侧库保证单库自洽。改 `handleMonthEndCrossMonth` / `runViaSideDb` / 双源去重逻辑须重跑 biz-op parity 的跨月用例。
  - **双源过渡（B-D2）**：side_db_rel_path 非空读侧库、NULL 读主库旧表。双源移除 + 二次 VACUUM 顺延 v3.0.5 之后版本——届时删双源分支前确认历史主库 run 已迁清。
  - **前置资金对账生命周期**：临时批次按账单月保存在 MPT 模块，run 结果按运行月保存在 results 模块。新 run 删除旧 results 文件并标镜像 superseded；重启标 expired 并回收 results；清临时批次只删 MPT 模块，绝不能碰独立 results。启动时 running 镜像标 interrupted，镜像有而侧库无则标 missing-side-db。
  - **重复入金当前周期生命周期**：选中新银行文件立即清旧银行/结果侧库；新 run 清旧结果；重启物理删除本模块 side DB 及孤立 WAL/SHM，并将镜像标 interrupted/expired。主文件缺失或 side run 缺失/损坏分别标 missing-side-db/invalid-side-db。目录扫描、删除或校验失败必须显式阻断，不能在含姓名/卡号的文件仍存在时报告回收成功；临时 MPT 模块继续跨重启保留。
- 必跑：`npm run release-check`（含四 parity）+ `pre-fund-reconciliation-side-db-parity.js` + 重复入金 store/service/端到端测试 + 同月 MPT/import/run/export/删除来源后 stale 回归。

### `DEFERRED_WINDOW_STARTUP`（v3.0.5 Part B Phase 3 新增 Runtime-state ⚠️ 启动时序回退开关）
- 定义：`src/main.js` 模块级 `const DEFERRED_WINDOW_STARTUP = process.env.DEFERRED_WINDOW_STARTUP === '0' ? false : true`（默认 true=新时序：窗口先行）。配套 `appInitDone`（app:get-info 两段式判定）+ `runBackgroundInitChain`/`registerAllIpcHandlers`/`markAppInitDone`/`runStartupPostSetup` + IPC `app:init-done`/`app:init-progress` + preload `app.onInitDone`/`onInitProgress` + renderer `initialize`/`applyFullInfo` 两段式。
- 关联功能：启动窗口先行——whenReady 立即 createWindow(loading 态)+register*Handlers，后台跑 init 链，完成后 send('app:init-done') 放开功能（spec §B.4 Phase 3，B-D5）。
- 变更 review 要点：
  - 回退开关一行切回旧时序（=0），旧时序分支必须保持完整可达（仿 `USE_BIG_TABLE_IMPORT_ENGINE` 退役路径，稳定一版后移除）。
  - `register*Handlers` 上移依赖「handler 体惰性引用 database（闭包），注册时不解引用」—— 新增 handler 若在注册时直接解引用 `database.xxx()` 会 NPE（必须 `() => database && database.db` 惰性）。
  - `app:get-info` 两段式：init 未完返回 `{initPending:true,version}`；改字段须同步 renderer `applyFullInfo` 消费。
  - 前端改动 → 重跑 `npm run preview`；改时序 → `npm run startup:measure` 对比（建窗≤300ms / 日常≤1.5s / 升级首启≤3s）。

### 账户映射 → 调拨对账单 `big_account` 派生（v3.0.12 功能2 新增 Risk-sensitive ⚠️🔴 资金红线 — 全局对照表改对账大账号取值）
- 定义：
  - 全局表 `fund_transfer_account_mappings`（DDL `migrations.js` `ensureFundTransferAccountMappingSupport`，`UNIQUE(mid_account_id)`，幂等 `CREATE TABLE IF NOT EXISTS`、**不进 `ALL_TABLE_KEYS`**）。
  - 仓储 `src/backend/database/fund-transfer-account-mapping-repository.js`：`listMappings`（UI 回填，按 `row_index` 升序）/ `saveMappings`（事务内全删重插、空行跳过、半填抛错）/ `getMappingMap`（归一化 `Map<midAccountId, clearingAccountId>` + 🔴 空键护栏）。
  - facade `database.js`：`ensureFundTransferAccountMappingSupport` / `listFundTransferAccountMappings` / `saveFundTransferAccountMappings` / `getFundTransferAccountMappingMap`。
  - 消费点 `src/main-process/fund-transfer-recon-builder.js` `buildFundTransferReconRows(midRows, { accountMappingMap })` 第 2 参——in 行 `big_account`（收款卡号）/ out 行 `big_account`（付款卡号）取 `accountMappingMap.get(acc) ?? acc`（命中换清结算账号、未命中原样）；注入点 `src/main-process/linked-derive-rebuild.js` `rebuildFundTransferReconDerivation`（builder **唯一生产调用处**，run / mid-allocation 导入两链皆经此）实时取 `database.getFundTransferAccountMappingMap()` 传入。
  - IPC `fund-transfer-account-mapping:list` / `:save`（`main.js` `registerFundTransferAccountMappingHandlers` + `validateFundTransferAccountMappings` 完整性/唯一/长度≤128）；preload `fundTransferAccountMappings.list/save`；UI `createFundTransferAccountMappingDialog`（链接表管理左下角入口）。
- 关联功能：软件自动整理出的「调拨对账单」是「中台调拨订单对账ID回填」（R5s2-recon）与「DBS-Charge资金校验」（R3.5）的对账对手方；`big_account` 是这两处对账的匹配键（账号维度）。映射改了 `big_account` ＝ 改了这两处的命中口径。
- 🔴 变更 review 要点（资金红线，改动前必读）：
  - **口径单一真值源**：map 键值与 builder 内 `payAccount`/`payeeAccount` 均经 `normalizeCellValue`——`getMappingMap` 写入即归一化、builder **不再二次归一化**（二次归一化口径漂移 ＝ `map.get` 落空 ＝ 该换没换 ＝ 写错对账 ID）。改任一侧归一化口径须同步另一侧。
  - **仅作用 `big_account`**：付款/收款展示账户、渠道、金额、币种、FundType 一律不动；映射只换匹配用的大账号。
  - **空表 ＝ 零变化护栏**：映射表空 / facade 缺失（旧 mock database 单测）→ 空 `Map` → 全 passthrough → 调拨派生与升级前字节级一致。改 `rebuildFundTransferReconDerivation` 注入点须保 run / 导入两链一致（漏一条 ＝ 两链口径分裂）。
  - **唯一性**：`UNIQUE(mid_account_id)` + IPC validate 双重兜底；一个中台调拨单账户号只能映一个清结算银行账号。
  - 必跑：`fund-transfer-account-mapping-repository.test.js` + `fund-transfer-recon-builder.test.js`（映射组）+ 集成 `fund-transfer-recon-account-mapping.js`（导入中台单 → 配映射 → 派生 `big_account` 换值端到端）+ 真实数据手测（配映射前后调拨对账命中变化）。

### `PreFundReconciliationService` / `SCENARIO_MISSING_GATEWAY` / `RECONCILIATION_RULES`（v3.0.14 新增、v3.0.16 扩展 Risk-sensitive ⚠️🔴🔴 资金红线）
- 定义：
  - `src/main-process/pre-fund-reconciliation/service.js`：银行 session、来源快照、严格 1:1、主库 run 镜像、side DB 结果和导出资格总编排。
  - `matching-engine.js` / `reconciliation-rules.js`：`GATEWAY_SOURCE` / `FINGERPRINT_FIELDS` / `normalizeGatewayCandidate` / `RECONCILIATION_RULES` / `resolveBankRuleEligibility`，按非空对账 ID + 渠道 + 含手续费金额 + 币种 + 规则允许的网关 tradeType 精确匹配，并用 10 字段指纹折叠完全重复。
  - `bank-row.js`：`classifyBankRow` 派生 CREDIT/DEBIT、方向金额、`Extra Fee`、匹配金额、name/cardNo 和稳定追溯 ID；金额加总只用十进制字符串与 BigInt 缩放整数。
  - `mpt-schema.js` / `mpt-parser.js` / `mpt-error-report-writer.js`：INBOUND/OUTBOUND 33 字段强校验、OUTBOUND bankDebit -> target -> origin 成对 fallback、可修复明细错误汇总和错误工作簿原子导出。
  - `pre-fund-reconciliation-store.js` / `run-data-store.js`：严格导入整批回滚、按源文件哈希逻辑排除错误行、排除行 side DB 审计和旧批次幂等升级。
  - `excel-writer.js` / `output-mapper.js`：v3.0.26 起前 5-sheet 的 21/31/31/16/14 固定契约；`不平结果` 第 6 列 `FundType` 直接取银行原始值。存在完全重复记录时末尾动态追加 22 列 `重复网关账单` 审计页。
  - `recon-id-fix-io.js`：C4 只接受旧 19 列 `对账结果`、v3.0.14-v3.0.25 的 20 列 `不平结果`、v3.0.26 的 21 列 `不平结果` 三种精确契约，并统一投影为旧 19 列内部数据。
- `GATEWAY_SOURCE` / `FINGERPRINT_FIELDS` / `classifyBankRow` / `RECONCILIATION_RULES` / `resolveBankRuleEligibility` / `writeMptErrorReport` / `buildChannelFileName` — 匹配来源、去重、银行派生、规则资格、错误审计和按渠道文件边界。
- 关联功能：`前置资金对账 > 缺网关账单`，本方为本次导入银行对账单，对手方为临时 MPT + 持久网关链接表；输出渠道取银行 Channel 与重复记录 Channel 并集，各文件严格按渠道隔离。
- 🔴 变更 review 要点：
  - **唯一平账条件**：只允许非空 `trim(bank.ReconciliationId) === trim(gateway.reconciliationId)`，且渠道、精确十进制匹配金额、币种相同，网关 `tradeType` 还必须属于银行 `FundType + CREDIT/DEBIT` 命中规则的允许集合；字符串 trim 后大小写敏感，禁止 includes、日期或其它兜底。任一要素不符的同 ID 候选不得消费。
  - **手续费金额口径**：匹配金额固定为 `abs(Credit 或 Debit 方向金额) + Extra Fee`；`Extra Fee` 空值按 0，正负号原样参与，非空非法值整次银行导入失败。双边非零仍整次失败，双零仍跳过，即使手续费非零也不得提升为参与行；禁止 JS 浮点加法和隐式舍入。
  - **14 条规则资格**：FundType、方向和网关 tradeType 均 trim 后大小写敏感；同一 FundType 同方向多规则取允许 tradeType 并集。未映射、方向不符和规则无网关类型必须形成可见不平原因，不能读取候选；`ExternalTransfer` 的空网关类型不是通配符。规则附件变化须同步常量、spec 和单测。
  - **严格 1:1 与顺序**：银行永不去重；临时候选优先、持久候选其次，来源内稳定顺序逐个消费。改顺序会改变哪一行平账。
  - **重复折叠**：仅 `reconciliationId + 10字段fingerprint` 完全一致时折叠；金额按十进制数值等价，字符串只 trim。不同指纹同 ID 必须全部保留。
  - **重复审计血缘**：首次出现完全重复时才按来源记录 ID 回读并保存保留行原始 JSON，被折叠行保存当前原文；候选池保存 SHA-256 身份摘要，回读原文必须先验哈希，唯一候选不得复制完整 raw。双方按最多 30000 字符分片输出并可逐字符重组，审计行绝不重新参与 C4 匹配。
  - **姓名/卡号与网关金额**：Credit 用 Drawee，Debit 用 Payee；空 ID 分类排除；网关 OUTBOUND 币种金额必须成对 fallback，禁止跨层拼接。银行输出仍保留原方向金额，只有匹配键使用含手续费金额。
  - **MPT 错误修复边界**：结构、文件身份、gzip/UTF-8、声明笔数等错误不可修复；只有明细行校验错误可逻辑排除。严格导入出现任一错误行必须整批回滚，用户明确点击后才按同一 SHA-256 源文件导入有效行；不得改写原文件或把错误行写入候选池。
  - **失败令牌与错误审计**：导出/重跑只接受主进程当前周期 UUID 令牌；新导入或重启必须失效。错误工作簿只含实际失败类型 sheet，保存文件/来源/原始行号/错误原因/33 字段和最多 30000 UTF-16 字符的原始行分片；写前后源文件哈希变化或单 sheet 超过 Excel 行数上限必须阻断且不得覆盖目标。逻辑排除后 side DB 必须保存排除数量和逐行审计，替换失败须恢复旧批次及旧审计。
  - **来源快照**：银行重导、临时批次变化、持久网关 meta 变化后旧结果必须 stale，不能导出；run 失败后不得回退导出旧结果。
  - **结果库并发**：正式 Electron 应用必须持有单实例锁；两个实例不得同时回收或重建同一 userData 下的结果 side DB。仅 `APP_CAPTURE_PATH` 隔离的 preview/startup 测量可绕过。
  - **临时逻辑表库隔离**：`MPT_INBOUND_GATEWAY` / `MPT_OUTBOUND_GATEWAY` 共用物理月侧库，但管理汇总、日期预统计和删除必须携带同一个 `sourceType`；删一类不得删另一类或提前回收仍非空的月库。运行时仍联合两类进入临时候选池。
  - **结果守恒**：银行参与行 = 平账 + 不平；网关候选 = 已消费 + 未使用；不平结果和渠道账单行数一致，按渠道不得串数据。
  - **模板与 C4 契约**：前 5 个 sheet 名/顺序固定；v3.0.26 `不平结果` 为 21 列且 `FundType` 固定在第 6 列，只取对应银行原值，空值不推导。本渠道无重复时保持 5-sheet，有重复时只在末尾追加固定 22 列第 6 sheet；0 不平及重复专属渠道仍导出；来源枚举必须区分 `临时网关对账单` / `网关对账单` / `导入银行对账单`。C4 只能兼容上述 19/20/21 三种精确头，必须拒绝错列、错序和未知额外列。
  - 必跑：pre-fund 全部 unit + side-db parity + 错误 xlsx 写后回读/源变化/no-clobber + 严格回滚/逻辑排除/旧库兼容 + 真实 5/6-sheet 导出；⚠️ ID/渠道/含手续费金额/币种/tradeType 规则、候选顺序、指纹、重复双方原文、姓名/卡号、错误行排除和按渠道拆分必须人工资金复核。

### `buildDuplicateInboundGroups` / `resolveDuplicateInboundMptMatches` / `resolveDuplicateInboundDocumentMatches` / `lookupInboundRows` / `DuplicateInboundMatchService`（v3.0.15 新增 Risk-sensitive ⚠️🔴🔴 资金红线）
- `buildDuplicateInboundGroups` / `resolveDuplicateInboundMptMatches` / `resolveDuplicateInboundDocumentMatches` / `lookupInboundRows` / `DuplicateInboundMatchService` — 银行分组、MPT 批量候选查询、单据唯一回填和当前周期编排五个契约入口。
- 定义：
  - `src/main-process/duplicate-inbound-match/matching-engine.js`：银行方向金额规范化、七元组分组、严格 1 Reversal + 2 Inbound 分类，MPT 唯一/互异/全局不复用/oppBu 裁决，以及单据 orderId 唯一/互异/身份字段裁决。
  - `src/backend/pre-fund-reconciliation-store.js:lookupInboundRows`：把银行候选键放入每个月库的 TEMP ID 集合，每月份单次 JOIN 查询全部保留的 `MPT_INBOUND_GATEWAY + Inbound-VA` 行；不读 OUTBOUND 或主链接表。
  - `src/main-process/duplicate-inbound-match/document-statement-reader.js` / `src/backend/duplicate-inbound-match-store.js`：标准 26 列单据流式读取、非唯一业务订单号索引、有限候选回读和当前周期三方审计。
  - `src/main-process/duplicate-inbound-match/service.js`：银行+单据双文件原子导入、BizId 强校验、当前周期 side DB、INBOUND MPT snapshot、主库轻量镜像、守恒、导出资格和两 sheet writer 总编排。
  - `src/main-process/duplicate-inbound-match/excel-writer.js`：固定 `邮件模板` 10 列与 `匹配不成功需人工判定` 46+1 列，临时文件发布及已有目标回滚。
- 关联功能：`重复入金匹配` 把银行 Reversal/Inbound 分组与跨全部保留月份的临时中台入金 MPT、当前导入单据三方关联；成功组生成召回邮件数据，任何银行计数、MPT 候选或单据字段不确定性整组进入人工判定。
- 🔴 变更 review 要点（资金红线，改动前必读）：
  - **金额与银行组唯一口径**：FundType 只 trim 后大小写敏感识别；Reversal 只读 `Debit Amount`、Inbound 只读 `Credit Amount`；金额用十进制字符串规范化，禁止 JS 浮点计算。分组键固定为金额 + 双方姓名/卡号 + Channel + Currency，六个文本字段保持原值、不 trim、不改大小写；BizId/MerchantId/ReconciliationId 不进银行分组键。
  - **自动候选门槛**：只有 1R+2I 进入 MPT；其它所有含 Reversal 的组将组内全部相关行送人工，纯 Inbound 只统计。相关金额非法必须整次 fail closed，不得降级忽略或人工。
  - **MPT 精确查询**：每条银行 Inbound 仅按 trim 后、大小写敏感的 Channel + MerchantId + ReconciliationId，再附加 `sourceType=MPT_INBOUND_GATEWAY` 与 `tradeType=Inbound-VA` 精确匹配；空 `ReconciliationId` 固定不入候选池并按零候选人工，禁止 includes、金额/日期 fallback、OUTBOUND 或 linked pool 旁路。每个月库只能做一次批量候选 SELECT，不能恢复“月份 × 银行 ID”逐条查询。重复查询三元组必须共享精确 candidateCount；多候选最多物化稳定前 2 条审计样本，但所有命中行的 raw JSON 仍须逐条流式校验。
  - **唯一与全局不复用**：两条 Inbound 必须各唯一命中一条不同 MPT；同一 MPT 在全运行只能使用一次。组内同候选、0/多候选或跨组共享候选时，所有相关组整组人工，禁止 first-wins/贪心消费。
  - **MPT 身份**：两 MPT 的 `oppBu` trim 后必须非空且一致；MPT `business/clientId/accId` 不参与成功判定或客户/账户输出。MPT raw JSON 损坏整次阻断。
  - **单据唯一回填**：两 MPT `orderId` trim 后必须非空，分别大小写敏感精确命中一条不同单据；单据用户编号/账户号/业务部门 trim 后须非空且组内一致，业务部门还须等于 `oppBu`。失败仅当前组人工，禁止回退 MPT clientId/accId。
  - **守恒与血缘**：全部相关银行行必须唯一落到成功/人工/纯 Inbound；全部 Reversal 必须为成功或人工；成功组选用的 MPT ID 数 = 成功组×2 且全局唯一。每组 side DB 审计必须保留银行 BizId/源行、MPT 月份/行 ID 和单据文件/源行/匹配单号，主库不得保存银行 raw、姓名、卡号或单据客户/账户值。
  - **snapshot 与生命周期**：结果绑定同一银行+单据 import 和全部 INBOUND 批次 identity/hash/行数；INBOUND 导入、替换或删除后 stale，OUTBOUND-only 变化不 stale。选新双文件、开始新 run、失败和重启都不得恢复旧可导出结果；启动必须物理回收含个人信息的 side DB。
  - **Excel 契约**：只允许最新成功且 snapshot 有效、邮件或人工至少一类非空的结果导出；两个 sheet 名/顺序/表头固定，邮件业务来源取 MPT oppBu、客户号/账户号取单据，Debit Amount 数据行显式使用“常规”格式，人工组保留全部原 46 列；超 Excel 上限写前失败，临时文件必须回读校验 sheet/表头/行数后才能发布，发布失败恢复原目标且不留下伪成功文件。
  - 必跑：duplicate-inbound matching/store/service/reader/writer/wiring 全部 unit + `duplicate-inbound-match-end-to-end.js` + 真实 9 万行单据有界内存回放 + `npm run benchmark:duplicate-inbound` + `npm run release-check`；⚠️ 金额方向、七元组空格/大小写、跨月 MPT、候选复用、姓名卡号、orderId、三方回填血缘、守恒和 Excel/WPS 必须用脱敏真实样本人工复核。

### `runRound4FundNatureCheck` / `R4_RULES_BY_SUBCATEGORY` / `matchedPairs`（v3.0.23 收紧 Risk-sensitive ⚠️🔴🔴 资金红线）
- 定义：
  - `src/main-process/scenario-engines/r4-fund-nature-check.js`：四个固定 subCategory 从完整 `exactRows` 按 ReconID、MerchantId、Currency、固定 TradeType、方向金额、signed Extra Fee 与相反方向做严格匹配；返回全部成功关系 `matchedPairs`，包含 no-op。
  - `src/main-process/reconciliation-orchestrator.js`：R4 直接接收 `safeGwRows`，不再接收 R1 `matchedGwRows`；四类共用同一次引擎调用和银行对象消费集合，并将 `r4MatchedPairs` 传给 R5。
  - `src/backend/database/migrations.js`：`ensureR4StrictDescriptionMigration` 只幂等刷新四个内置场景 `config.function`，不覆盖其它配置。
  - `src/backend/file-service/error-causes.js`：`r4-fund-match-mismatch`、`r4-fund-multi-candidate`、`r4-fund-direction-mismatch` 中文原因。
- 关联功能：「资金对账数据处理 > 资金性质校验」Ach Return、Wire Return、HX-out、HX-in 的 FundType 认定、标黄与主错误报告。
- 🔴 变更 review 要点：
  - **固定四类**：AchReturn/HX_OUTBOUND 用 `abs(Debit Amount)` 且要求 Credit 空/0；WireReturn/HX_INBOUND 用 `abs(Credit Amount)` 且要求 Debit 空/0。目标 FundType 分别固定为 Ach Return/Wire Return/HX-out/HX-in；旧 config 中可漂移字段不再决定资金口径。
  - **完整文本锚点**：ReconID、MerchantId、Currency、TradeType 均 trim 后大小写敏感精确比较且关键值非空；银行原 FundType、Channel 和日期不参与候选。
  - **金额精确语义**：固定计算 `canonical(abs(主金额) + signed Extra Fee) === canonical(gateway.amount)`；使用 `financial-decimal` 字符串/BigInt 运算，不得改 JS 浮点或按分舍入。主金额空/非法/0 阻断；Extra Fee 空按 0、非空非法阻断；相反方向空按 0、合法非0或非法均阻断并告警。
  - **全局 1:1 与顺序**：按 `exactRows` 的链接表 `id ASC` 顺序优先，再按银行 Excel 原序选第一条；每条银行对象只能被四类之一消费。多个完整银行候选取首条并 warning；后续网关不得复用。no-op 也消费，但不 modification、不标黄。
  - **匹配血缘独立于改值**：每次成功消费都必须返回 `{gwRow,bankRow,subCategory,targetFundType,changed}`；`changed=false` 仍保留关系。禁止用伪 modification 表达 no-op，也禁止漏掉该关系导致下游重复处理。
  - **可观测性**：无同 ReconID 银行桶静默；有桶但完整条件失败或候选已消费必须 `r4-fund-match-mismatch`；多个完整候选必须 `r4-fund-multi-candidate`；方向非法/非0另有方向 warning。
  - **轮次隔离**：只读取大小写敏感 `exactRows`，不得读取 C3 `c3Rows`；R1 与 `r1.pairs` 保留给退款过滤，DBS-Charge 仍是独立 R3.5 规则。
  - 必跑：R4 引擎全矩阵、orchestrator/R1退款/DBS-Charge 回归、error-causes、双池隔离、行数守恒与 `npm run release-check`；⚠️ 真实 Ach/Wire/HX 逐笔复核不能由自动测试替代。

### `runRound5RefundOrderBackfill` / `r1Pairs` / `r4MatchedPairs`（v3.0.21 收紧、v3.0.23 补血缘 Risk-sensitive ⚠️🔴🔴 资金红线）
- 定义：
  - `src/main-process/scenario-engines/r1-recon-id-match.js`：`runRound1ReconIdMatch` 返回原引用 `pairs: [{gwRow, bankRow}]`，同 reconid 多银行候选仍按原序取第一条并 warning。
  - `src/main-process/reconciliation-orchestrator.js`：R1 后把 `r1.pairs` 作为 `r1Pairs` 传给 R5；R4 后再把含 no-op 的 `matchedPairs` 作为 `r4MatchedPairs` 传入。
  - `src/main-process/scenario-engines/r5-refund-order-backfill.js`：R1 只把网关 TradeType trim 后严格等于 `AchReturn` 的具体 `pair.bankRow` 排除；R4 只把 `subCategory='ach-return'` 的具体 `pair.bankRow` 排除。
- 关联功能：「资金对账数据处理 > 中台退款订单回填」Ach Return 银行池准入；会决定某银行行进入退款回填、人工结果还是静默排除。
- 🔴 变更 review 要点（资金红线，改动前必读）：
  - **具体配对，不按 ID 扩散**：过滤身份必须是 R1 选中的 `pair.bankRow` 原对象；禁止重新构造全量 reconid Set，禁止把同 ID 其它银行行连带排除。
  - **R4 no-op 也必须排除**：银行原 FundType 已是 Ach Return、R4 严格匹配成功但未改值时，`r4MatchedPairs` 仍须把具体银行对象移出退款池；不得依赖 modification 或 `changed=true`。
  - **R4 类型隔离**：只有标准化后严格等于 `ach-return` 的 R4 subCategory 可触发；Wire Return/HX-out/HX-in、畸形关系或 clone 对象不得误过滤。
  - **TradeType 严格值**：只去首尾空格、大小写敏感严格等于 `AchReturn`；`Inbound-VA`、空值、`achreturn`、`Ach Return` 均不得触发。
  - **缺省兼容**：未传/非数组/空 `r1Pairs` 或 `r4MatchedPairs` 时对应过滤为空；旧 `options.gwRows` 不得恢复旁路过滤。
  - **轮次血缘**：生产编排器各轮复用同一组 `bankRows` 对象引用；若未来改成 clone，必须同步设计稳定行 ID 身份，否则 Set 对象判断会静默失效。
  - **R4 与审计边界**：R1 仍取第一条，合法 AchReturn pair 仍静默排除；R4 独立读取完整 exactRows 并严格 1:1。两路过滤最终并集，但各自只认自己的具体银行对象，不得混用 ReconID 扩散。
  - 必跑：`r5-refund-order-backfill.test.js` + `reconciliation-orchestrator.test.js` + `reconciliation-orchestrator-refund.test.js` + `gateway-channel-filter-equivalence.js` 完整链路回放 + 受控本地问题样本精准命中回放（业务标识不得入库）+ 资金负责人逐笔人工复核。

### `STEP2_GW_TRADE_TYPE_WHITELIST` / `runDbsChargeFundCheck` / `dbs-charge-fund-direction-mismatch`（v3.0.21 新增 Risk-sensitive ⚠️🔴🔴 资金红线）
- 定义：
  - `src/main-process/scenario-engines/dbs-charge-fund-check.js`：步骤2只索引固定白名单网关，再对 DBS 的 Charge/outbound 行先做 Credit 方向守卫，方向通过后执行金额币种判断。
  - `src/backend/file-service/error-causes.js`：方向不符 warning 的固定中文“可能原因”，经编排器 `errorReport` 输出。
- 关联功能：「资金性质校验 > DBS-Charge资金校验」步骤2 FundType 改写；决定 DBS 银行行保持 Charge/outbound、改成 outbound、回落 Charge 或进入方向人工告警。
- 🔴 变更 review 要点（资金红线，改动前必读）：
  - **固定 12 类白名单**：只能包含 `AchReturn / ACQ_WITHDRAW / B2B_FLOW_GOLD / B2B_FLOW_GOLD_SUPPLIER / B2B_SUPPLIER / B2B_WITHDRAW / CUR_PAY / FX_WITHDRAW / HX_WITHDRAW / MPT_SUPPLIER / MPT_WITHDRAW / PUBLIC_PAY`；仅 trim、仍区分大小写。权威来源为 `DBS-Charge网关TradeType白名单.xlsx` `Sheet1!A2:A13`，当前 SHA-256 `78fbffcd9d2dcca8755124fc92b6aa2c58fc53bd60f945668203d685225160f0`；附件口径变化必须同步常量、spec、版本文档和枚举测试。
  - **非白名单隔离**：只有非白名单网关行的 reconid 桶必须完全跳过、保持原 FundType且不告警；混合桶只允许白名单候选参与，非白名单金额命中不得影响结果。
  - **方向先于金额币种**：同 ID 存在白名单候选时先执行 `(parseNumber(Credit Amount) || 0) === 0`。正/负非零必须保持进入步骤2前的 FundType、步骤2不新增 modification、有 warning；即使金额币种不匹配，进入步骤2时的 outbound 也不得回落 Charge。步骤1此前产生的 sibling→Charge modification 保留，不得由步骤2回滚。
  - **DBS 步骤2既有口径**：Credit 为 0、`0.00`、空、null 或非法文本都按 0 放行；该规则只属于 DBS-Charge。v3.0.23 R4 四类已独立收紧为“空按 0、非法阻断”，不得把两者互相套用。
  - **DBS 手续费隔离**：步骤1继续通过 `bankAmountAbs` 比较调拨对账单金额，步骤2只能通过 `bankAmountEqualWithoutExtraFee` 比较网关金额；两步都固定忽略银行 `Extra Fee`。禁止直接复用 R5 的 `amountEqual` / `bankAmountWithExtraFee`，否则 v3.0.26 会静默改变 DBS-Charge 既有结果。
  - **方向通过后的旧语义**：金额币种命中→outbound；未命中时 outbound→Charge、Charge no-op；FundTransfer-in/out 不进候选。DBS 步骤1、调拨方向、大账号、ReconciliationId 回填和“只修改 DBS 银行目标行”的渠道门控必须不变；不要把它误写成网关 Channel 隔离。
  - **明确残余**：步骤2仍不检查网关 MerchantId/Channel，也不严格 1:1 消费网关候选；不得把自动测试结果解释为这些风险已消除。
  - 必跑：`dbs-charge-fund-check.test.js` + `reconciliation-orchestrator-dbs-charge.test.js` + `error-causes.test.js` + `gateway-channel-filter-equivalence.js` + 真实脱敏 DBS 白名单/方向人工复核。

### `bankAmountWithExtraFee` / `amountEqual` / `runRound5FundTransferBackfill` / `runRound5FundTransferReconBackfill`（v3.0.26 收紧 Risk-sensitive ⚠️🔴🔴 资金红线）
- 定义：
  - `src/main-process/scenario-engines/r5-fund-transfer-backfill.js`：共享 `bankAmountWithExtraFee` 固定计算 `abs(Credit Amount - Debit Amount) + signed Extra Fee`；`amountEqual` 与网关 `abs(amount)` 先加总再沿用精确到分比较。
  - `src/main-process/scenario-engines/r5-fund-transfer-recon-backfill.js`：调拨对账单来源复用同一银行金额 helper，与调拨单 `abs(ORDER_AMOUNT)` 比较。
  - `src/main-process/scenario-engines/many-to-many-detector.js`：只读审计复用相同银行金额，保证异常说明与实际 R5 候选金额一致。
  - `src/backend/file-service/error-causes.js`：`r5-invalid-extra-fee` 进入主错误报告，并保留原始手续费值。
- 关联功能：「资金对账数据处理 > 中台调拨订单对账ID回填」两种数据来源、严格 1:1 消费、下游 Payment 排除集合及调拨多对多异常说明。
- 🔴 变更 review 要点（资金红线，改动前必读）：
  - **唯一银行金额口径**：必须先算旧 `bankAmountAbs=abs(Credit-Debit)`，再加 signed `Extra Fee`；空手续费按 0，正数增加、负数冲减。加总后不得再次取绝对值，不得把手续费加到网关或调拨对手金额。
  - **比较精度不漂移**：R5 继续沿用现有 `Math.round(value*100)` 分精度、容差 0；本次不改为原值字符串全精度，也不允许新增 epsilon。银行合计为负数时不会命中取绝对值的正/负对手金额，这是明确 fail-closed 行为。
  - **非法值可观测**：`Extra Fee` 非空但无法解析时，该银行行退出两条 R5 路径；必须产生 `r5-invalid-extra-fee`，warning 包含原始值，并优先按标准化 `_rowId` 去重为每行一次。即使对手池为空也不能被早退吞掉。
  - **两条来源一致**：默认网关来源和取消勾选后的调拨对账单来源必须复用同一 helper；日期优先、账号、币种、方向、原序、多候选、同值消费和 `usedBankRowIds` 不变。
  - **DBS 隔离**：`bankAmountAbs` 不得改为含手续费；DBS 步骤1固定使用 `bankAmountAbs`，步骤2固定使用 `bankAmountEqualWithoutExtraFee`。R4、Payment、退款和前置资金各自保留自己的手续费规则。
  - **多对多只读**：检测器金额与 R5 一致，但仍不得修改银行行、modifications 或消费集合；非法/负合计不形成金额分组，不能单独制造回填或命中。
  - 必跑：两条 R5 引擎、orchestrator 两种来源、DBS-Charge、多对多、error writer 回读及 `npm run release-check`；⚠️ 正负手续费、回填 ID、1:1 去向与异常说明必须用真实或脱敏样本逐笔人工复核。

### `bankPaymentSerialFuzzyMatchEnabled` / `runBankPaymentSerialFuzzyFallback` / `financial-decimal`（v3.0.17 新增 Risk-sensitive ⚠️🔴🔴 资金红线）
- 定义：
  - `src/main-process/scenario-engines/r5-refund-order-backfill.js`：在既有 S1-S4 后构建普通未命中银行行与未消费退款单的流水号候选图，按大账号、币种、流水号和精确金额差做双向 1:1 裁决。
  - `src/main-process/financial-decimal.js`：十进制字符串规范化、绝对值、加减和比较的共享实现；`pre-fund-reconciliation/bank-row.js` 通过错误工厂保持原 `BankRowValidationError` 契约。
  - `src/main-process/reconciliation-orchestrator.js` / `renderer-dialogs.js` / `migrations.js`：开关从自带退款场景完整 config 浅合并保存、随 bundle 透传，旧配置缺字段时为 `false`。
- 关联功能：「中台退款订单回填」可选救回普通未命中行，并改变回填模板与人工 sheet 的行去向。
- 🔴 变更 review 要点（资金红线，改动前必读）：
  - **旧流程隔离**：必须先执行 S1-S4，只允许最终文案为“未能关联到任何退款订单”的普通未命中进入新规则；已消费退款单和被多候选、日期异常等人工结论锁定的退款单不得重新入池。开关关闭或旧 config 缺字段时结果必须保持旧行为。
  - **四锚点口径**：`MerchantId=银行大账号`、`Currency=币种`、退款「银行打款流水号」等于银行 `ChannelOrderNo` 或 `CustomerRef`，均只 trim 且大小写敏感；流水号必须非空，禁止 includes、大小写折叠或其它兜底。
  - **精确金额**：固定计算 `abs(abs(Credit Amount - Debit Amount) - 退款金额) < 10`，等于 10 不命中；银行空发生额侧按 0，非空非法金额和空/非法退款金额不得降级为 0。运算只能走共享字符串/BigInt helper，不得使用 JS 浮点加减比较。
  - **双向严格 1:1**：先建立全局候选关系再裁决；一对多、多对一和非法金额产生的未决关系均转人工，禁止 first-wins、按金额差最小抢占或复用退款单。
  - **去向与审计**：成功行必须从 `unmatchedRows` 精确移除并进入既有回填模板，银行候选行仍满足单一去向；详情写实际金额差，标黄只投影实际参与且存在于模板的流水号、金额、大账号和币种列。
  - 必跑：financial-decimal、退款 fuzzy、orchestrator、config/bundle/wiring unit + `refund-backfill-yellow-fill-e2e.js` + 开关前后真实脱敏退款样本逐笔人工复核。

### `streamStrictWorkbookSheetTables` / `mergeToolboxFilesToXlsx` / `publishMergedWorkbook`（v3.0.19 新增 Risk-sensitive ⚠️ 行级合并与输出完整性）
- 定义：
  - `src/backend/big-table-import/zip-reader.js` / `toolbox-xlsx-stream/multi-sheet-reader.js`：按 workbook 显示序定位 sheet，解析 `visible/hidden/veryHidden`，严格模式逐可见 sheet 回调独立表头与数据行。
  - `src/main-process/toolbox-merge-io.js`：XLSX/XLS/CSV 与伪 CSV 路由、跨文件表头全等校验、首表头懒创建 writer、文件/sheet/行顺序编排、失败 abort，以及目标目录内暂存/备份/原子替换/回滚。
  - `src/main.js` 的 `toolbox:merge`：系统文件选择、OS 临时目录、另存为发布、活动日志和全路径清理。
- 关联功能：工具箱「合并表格」单文件多 sheet、多文件多 sheet、单 sheet 兼容和超行上限分页。
- 变更 review 要点：
  - **输入范围**：XLSX/XLS 只合并可见非空 sheet，CSV 视为单表；hidden/veryHidden/空白跳过，只有表头的 sheet 参与校验。每个选中文件至少一张有效 sheet，禁止静默跳过整文件。
  - **严格表头**：每张 sheet 首个有意义行是表头；normalizeCell trim + 尾部空列裁剪后，列名/大小写/列序必须全等。失败明细必须同时保留基准与异常文件/sheet，且不得留下输出。
  - **顺序与守恒**：顺序固定为文件选择序 → workbook 标签序 → 物理行序；每张 sheet 只去掉首个表头，数据区恰等表头的行、重复数据和仅空值字段不得被额外去重或排序。
  - **读取模式隔离**：严格入口只供 merge；`streamLogicalTableRows` 的拆分续页语义仍允许后续 sheet 不带重复表头，禁止用严格规则污染拆分 worker。
  - **格式与分页**：继续复用 `createRowsStreamWriter` 的 by-name 格式、`COMMON` 命名和 1,048,575 数据行分页；不复制源样式、公式或合并单元格。
  - **资源生命周期**：任何 reader/header/writer 失败都 abort 输出并关闭 zip；handler 成功、取消和失败都必须删除 OS 临时目录。发布先复制到目标目录暂存文件，再备份同名旧文件并原子替换；失败必须恢复旧文件，清理/恢复错误不得静默吞掉。
  - 必跑：strict multi-sheet reader / toolbox merge io / renderer handler unit + `toolbox-multi-sheet-merge.js` + 既有 `toolbox-roundtrip.js`、`toolbox-large-file-stream.js`、`toolbox-large-split-multi-sheet.js`。

### `normalizeMultiSplitGroups` / `writeRowsToMultipleFilesStreamed` / `publishPreparedSplitFiles`（v3.0.17 新增 Risk-sensitive ⚠️ 过滤与原子发布）
- 定义：
  - `src/main-process/toolbox-multi-split.js`：1-8 组契约、文件名规范化、过滤器编译和批量发布/回滚。
  - `src/main-process/toolbox-stream-io.js` / `toolbox-xlsx-stream/split-export-filter.js`：一次数据区遍历向多个 ExcelJS writer 分流，允许重叠和零命中表头文件。
  - `src/main.js` / `toolbox-large-split-dispatch.js` / `large-split-worker.js`：兼容式 IPC 分支、一次目录选择/覆盖确认和普通、大文件、多 sheet、CSV/XLS 路由。
- 关联功能：工具箱「拆分表格」旧单文件流程和新增最多 8 个文件的批量输出。
- 变更 review 要点：
  - **兼容分支**：只有 `mode==='multiple'` 进入新契约；旧 `{sourceFilePath,field,values}` 请求、另存为对话框、零命中行为和 `{status,filePath}` 返回不得变化。
  - **分组边界**：1-8 组，每组文件名/字段/值完整；文件名统一一个 `.xlsx`，拒绝非法字符、系统保留名、尾点/空格及大小写不敏感重复名。分组可重叠，零命中也必须生成合法表头文件。
  - **一次数据遍历**：普通 XLSX、大文件/多 sheet worker、CSV/XLS 的数据行只能遍历一次并同时判断全部过滤器；输出保持源行顺序，不得为每组重新读取源数据。
  - **全批原子性**：目标冲突只确认一次；取消必须零写入。全部结果先写同目录临时批次，发布失败删除本批新文件并恢复旧文件；恢复失败时必须保留唯一备份路径并阻止上层 finally 删除恢复目录。
  - **资源清理**：writer 初始化、源读取或任一 commit 失败时须关闭全部句柄并清理已提交/未提交临时文件；Windows 文件锁使用有界重试，清理失败必须可见。
  - 必跑：toolbox multi-split/stream/dispatch/renderer unit + `toolbox-multi-split-roundtrip.js` + 既有 large-file/multi-sheet/toolbox roundtrip 集成。

### `detectFundTransferManyToMany` / `manyToManyReviewRows`（v3.0.12 新增；v3.0.14 收紧为仅实际改值行检测/输出）
- 定义：
  - 检测器 `src/main-process/scenario-engines/many-to-many-detector.js` `detectFundTransferManyToMany(bankRows, gwRows, reconRows, options) → { reviewRows: [{row, note}] }`（纯只读；分组键 = 归一化账号 + 币种 + 金额分，组内日期容差建二部图求连通分量、分量内 银行≥2 ∧ 对手≥2 命中；网关/调拨各跑一遍按 `_rowId` 去重）。
  - 编排器 `reconciliation-orchestrator.js`：先用 `hasActualFieldChanges` 取实际改值行，再把该子集传给检测器；产出 `manyToManyReviewRows` + `stats.manyToManyReviewCount`，但不参与对账/匹配/派生。
  - 编排器 v3.0.14 输出口径：`buildOutputRows` 只按实际字段修改决定 `modifiedRows`；note-only、dispatcher 锁定 no-op、C3/R5 同值赋值都进入 `unmatchedRows`，保持 `modifiedRows.length + unmatchedRows.length === bankRows.length`。
  - writer `exceljs-writer.js`：`MANY_TO_MANY_NOTE_HEADER='异常说明'` + `buildManyToManyNoteByRowId` 将 `manyToManyRows` 按 `_rowId` 汇总到「命中场景」第 2 列；`writeBankStatementOutput` 第 8 参仍为 `manyToManyRows`，但不再生成独立异常 sheet。`SHEET_MANY_TO_MANY_NAME='异常-人工判断'` 仅保留给回归测试断言旧 sheet 不出现。
- `hasActualFieldChanges` / `buildOutputRows` — v3.0.14 命中唯一判据和命中/未命中行守恒入口。
- 关联功能：多对多异常说明只作为“实际改值命中行”的附加审计信息；异常候选本身不再把未改字段行提升为命中。
- 🔴 变更 review 要点（资金红线·只读）：
  - **绝对只读**：检测器不 mergeMods、不进 modColsByRowId、不改任何 `bankRow` 字段 / `modifications` / 回填。检测器误写 row 字段 ＝ 污染资金对账输出。
  - **先过滤再检测**：检测器入参必须是 `hasActualFieldChanges` 子集；若传全量 bankRows，note-only 会重新出现并与 3.0.14 产品口径背离。
  - **空值护栏**：账号/币种归一化为空、金额非有限数（`!Number.isFinite`）的行不进池（否则空账号 `normalizeCellValue('')===''` 全并成巨型假组、误标一大片）。
  - **复用引擎访问器（禁自写解析）**：银行金额必须走 `bankAmountWithExtraFee`，网关/调拨金额与日期分别走 `gwAmountAbs`/`reconAmountAbs`/`dayDiffWithin`，防跨表字段漂移——银行驼峰 / 网关小写 / 调拨 `RECON` 常量三套表头不假设同名。`Extra Fee` 非空非法或合计为负时银行行不进金额分组；该只读审计不得另外产生回填。
  - **偏全可接受**：金额取绝对值、不分 in/out 方向 → 同 |金额| 的 credit/debit、in/out 对手会并组可能多标；属「供人工判断」可接受偏全。
  - **命中唯一判据**：`_modifiedColumns` 非空才进命中；异常说明不得改变行去向。实际改值+异常说明仍保留 note，且改值列继续标黄。
  - **输出高亮偏移**：「命中场景」新增前缀列后，标黄列必须按 `hitHeaders.length - headers.length + 1` 派生，禁止手写固定偏移，避免后续插列时黄色标错银行字段。
  - 必跑：`reconciliation-orchestrator.test.js`（改值+异常 / no-op+异常候选 / C3 同值 / 行数守恒）+ `many-to-many-detector.test.js` + 集成 `bank-statement-many-to-many-review-sheet.js`。

---

### `POSITION_BANK_HEADERS` / `POSITION_RULESET_VERSION` / `POSITION_SIDE_DB_CHECKPOINT_SETTING` / `POSITION_SIDE_DB_PENDING_SETTING` / `SOURCE_TYPES` / `SOURCE_DISPLAY_ORDER` / `PositionReconciliationStore` / `runPositionSideDbMutation` / `ensurePositionLargeImportSchema` / `runPositionFundNatureCheck`（v3.1.0 新增；v3.1.3 扩展百万级导入基础设施 Risk-sensitive ⚠️🔴🔴 资金红线）
- 定义：
  - `src/main-process/position-reconciliation/constants.js`：49 列银行结果契约、side DB 跨库 checkpoint、五类来源、十组基础/FX配对和状态枚举。
  - `store.js` / `service.js` / `input-staging.js`：独立持久 side DB、原始/工作值、revision+规则版本 snapshot、不可变输入暂存、单一待确认草稿、回导和确认事务。
  - `side-db-mutation.js` / `large-import-schema.js` / `import-dispatch.js` / `import-recovery.js` / `source-summary-cache.js`：唯一 checkpoint mutation helper、`row_hash` 来源身份迁移、现代索引/schema fingerprint、事务内来源摘要缓存、`PREFLIGHT_READY → APPLY_GRANTED` 和来源/银行/账户专用 worker exit 证据恢复。
  - `position-reconciliation-import/bank-writer.js` / `account-writer.js` / `source-writer.js` / `maintenance-writer.js` / `disk-space-gate.js`：银行整批、账户整表、普通来源逐文件和维护作业的流式事务、磁盘门禁、进度与取消。
  - `matching-engine.js` / `logical-accounts.js` / `decimal.js`：ReconID 候选图、全局严格 1:1、方向/日期/手续费、账户别名归并和 FundType 判定。
- 关联功能：「平盘对账数据处理 → 平盘资金性质校验」的银行/链接导入、十组性质判断、差异、49 列结果、人工回导和确认。
- 🔴 变更 review 要点（资金红线）：
  - **主库隔离与原始值不变**：银行、订单、账户和运行结果只能进入 `{userData}/run-data/position-reconciliation/position-data.sqlite`；主库不得出现批量明细。`original_json/original_fund_type` 永不改写，确认只更新工作值、审计和状态。
  - **导入原子与血缘**：银行按 Channel+月份整批替换，BizId 全选择唯一；普通来源 `business_key` 仅作业务展示且允许重复，完整规范行 `row_hash` 是稳定 `sourceRecordKey`。同 `sourceType + row_hash` 的完全重复行折叠并更新文件血缘，同业务主键不同内容全部保留、独立派生和消费。错误必须保留文件/sheet/行号/字段。
  - **候选和去向守恒**：三种银行标识只 trim、大小写敏感；不同标识命中不同记录、多候选、链接复用均转人工。所有订单类场景先建立全局关系再裁决，禁止 first-wins；每条目标银行行必须恰有一个结果去向。
  - **跨运行双向消费**：已确认订单来源的 `source_type + source_record_key + leg_index` 与 `bank_biz_id` 均为全局唯一；`business_key` 只保留为审计字段。跨月份和来源重建后不得复用。同 BizId+同来源只允许幂等复核，同 BizId 改配必须转人工。
  - **金额/方向/日期**：调拨固定使用 `abs(方向金额)+signed Extra Fee`，空手续费按 0，非法或负合计 fail closed；入出账方向、Test 只校验 Debit、FundTransfer-in/out 日期门禁不可互相套用。
  - **币种和账户**：Inbound 仅在银行/订单/原始出金币种三者明确相同时移除 `&FX`；仅当银行币种=订单币种且不同于原始出金币种时增加 `&FX`，三币种互异必须转人工。三类账户场景先唯一识别自有账户，再从剩余银行字段唯一识别非自有逻辑账户。别名、多币种、多性质或多候选不得按表序取第一条。
  - **草稿与确认**：银行/来源/映射 revision 或 `POSITION_RULESET_VERSION` 变化后旧草稿禁止导出、回导和确认，范围外 FundTransfer-out 变化也必须通过银行全局 revision 失效；第一期全局只能有一个待确认草稿。回导只允许原 FundType 基础/FX二元组变化，禁止缺行、加行、仅改详情或其它字段篡改；Excel 日期时间只豁免已知时区往返；未成功导出/合法回导前不得确认。未解决人工差异不得消费来源，唯一成功匹配被人工修改时仍须保留原来源血缘。
  - **输出与存档**：49 列名称和顺序固定，只有实际改变的 FundType 标黄，同值匹配不伪造修改；标识符列使用列级文本格式，`客户号/accountReference` 与零数据文件也必须保留。银行导入、账户快照和结果回导必须从私有不可变副本完成解析、写库与存档；每次成功输入、导出和回导独立即时存档，业务返回成功前须完成存档或形成可重试失败记录。
  - **侧库结构完整性**：主库必须在侧库写入前持久登记基准 checkpoint 与 operation token；side DB 的实例身份、generation、事务 token、父 token 和 operation token 历史必须同时满足契约。缺失、旧主库单独恢复、旧库回滚、同代或更高代次分叉必须阻断，旧 initialized 标记只能迁移真实旧库；备份恢复必须同时包含主库和 `run-data/`。银行、来源、链接、运行结果与血缘 JSON 不仅要求语法合法，还必须包含契约字段；运行来源由原始行推导，消费冲突由血缘重算，scope/snapshot/summary 共同篡改也必须 fail closed。
  - **百万级来源身份迁移**：旧 `(source_type,business_key)` 唯一库只能在磁盘空间门禁通过后，用单笔 `BEGIN IMMEDIATE` 重建来源/链接/消费三表；旧消费和运行血缘必须唯一解析并回填 `sourceRecordKey`，重复来源腿、哈希碰撞、缺失来源或未知 schema 一律回滚阻断。schema-only 迁移不得推进业务 checkpoint。
  - **apply 存档握手与崩溃恢复**：普通来源 worker 发出 `PREFLIGHT_READY` 后必须暂停；main 将全部接受文件证据和 manifest hash 持久化到 pending，才可连同当前 checkpoint/schema fingerprint 发 `APPLY_GRANTED`。worker exit/fatal 后只按 checkpoint history 和 `position_operation_inputs` 恢复已提交文件，禁止凭最后 IPC、扫描进度或 ledger 声明成功。
  - **银行/账户流式确认**：银行确认后只能在一个事务内删除 manifest scope、按文件/物理行序插入并推进一次 checkpoint；跨 scope BizId 必须由正式唯一约束阻断且回滚旧 scope。账户只保留状态正常行，但内容相同的 Excel 物理行不得折叠。两类 COMMIT 后 worker exit 只能通过精确文件 proof、checkpoint 次数、scope/source/link SQL 聚合恢复。
  - **百万级管理与磁盘**：状态页和管理页不得通过 `getBankRows()` 物化明细，bank scope/date/status 聚合必须命中覆盖索引；普通来源/链接摘要缓存必须与导入、删除、账户替换和映射重建同事务刷新，缺失或损坏时回退事实表。删除、映射重建和导入在改动旧数据前执行保守磁盘门禁，磁盘空间未知不得降级放行。
  - **进度与取消真实性**：预检、写入和派生必须持续上报有界进度；dispatcher 只能用 monotonic clock 每 750ms 重复最后真实阶段/计数，禁止虚增。提交前取消后由 SQLite 回滚，超时可终止 worker 并恢复证据。`summarizing/committing` 阶段 service、worker 和 renderer 都必须拒绝取消；竞态 ACK 必须返回 `accepted=false` 并清除强制终止计时器。
  - **顺序与退出**：`SOURCE_DISPLAY_ORDER` 固定五张链接表的业务展示顺序；普通退出和更新重启都必须先阻止新业务并等待活动业务、worker 与存档队列排空，再关闭 side DB。
  - 必跑：position reconciliation unit、`position-reconciliation-large-import-schema.test.js`、`position-reconciliation-import-preflight.test.js`、`position-reconciliation-side-db-parity.js`、archive operation tracker、12 张 preview、release-check、启动性能；⚠️ 来源身份迁移、真实账号别名、币种、正负手续费、日期和 1:1 冲突必须逐笔人工复核。

## 5. Minor — 提示性（次要）

不在前四层、但跨 ≥3 文件、且命中频率高的符号。改动时**知会**即可，不强制全量 review。

- `sanitizeBankName` — 银行名规范化，3 文件跨度
- `compileRegexLiteral` / `isRegexLiteral` — 正则字面量识别，映射 UI 用
- `groupBigAccountRows` — 大账号行聚合工具
- `inferDateCellFormat` / `toExcelSerial` — 日期格式推断
- `getStatementSessionEntries` / `getStatementSessionKey` — session 查询
- `getSetting` / `setSetting` — settings 读写
- `loadEnumValues` / `loadCurrencyMappings` — 资源加载入口
- ~~`recon-id-fix-io.js raw 模式`~~（v2.1.8 F5 立项时计划，**T08 Reverse Sync v0.2 已撤回** — sheetToObjects 共用函数 raw:false 影响 8 sheet × N 字段；改为方案 C：在 `c4-recon-id-fix.js:1058-1065` gateway 映射段做 number → ISO 字符串转换，影响面收敛到 c4 引擎一处。详 spec.md F5-D4 v0.3）

这一层从自动扫描报告里可以随时捞出 top—N，不需要在本表硬编码。

---

## 如何维护本表

本表覆盖范围有意做窄（约 60 条），追求**高信噪比**而非全覆盖。表是活的，需要随代码演进升格/降级。

### 维护分工：agent 起草 + 用户审批

**默认由 agent 起草条目草稿，用户只做审批**。用户不需要自己写变量名、关联功能、review 要点——这些由 agent 从 `scan-vars` 数据 + 代码上下文推断填入。

| 环节 | 谁做 |
|---|---|
| 发现升格/降级候选 | 脚本 (`scan:vars`) + agent (`/check-vars`) 自动扫 |
| 起草条目（层级 / 定义位置 / 关联功能 / review 要点） | agent，按下文"双门槛"判断 |
| 起草降级/删除 diff | agent |
| 最终审批 / 层级拍板 | 用户（看 diff 后 yes / no / 改层级） |
| 元数据"上次人工 review"更新 | agent，在用户 yes 后自动更新 |

**典型交互**：agent 在 PR 前 / 版本 bump 时主动汇报候选 + diff → 用户看一眼说 yes 或微调层级 → agent 落盘。用户 90% 只需说 yes，除非有层级边界争议或业务语义判断。

如果 agent 该主动起草却没起草，提醒用户：**请 agent 重读本节的"维护分工"**。

### 会不会新增？

**会**。新增来源有四类：
1. 新功能引入的新常量 / 类 / 门面（最常见）
2. 现有符号跨度扩大（本来单文件私有 → 重构后跨多文件共享）
3. 首批漏收的既有符号（数据驱动发现）
4. 降级/移出后释放出的位置

### 升格标准（双门槛，两条都过才入表）

#### 门槛一：数据门槛（硬性，由 `scripts/scan-vars.js` 自动判断）

候选必须满足以下至少一条（阈值参考 `docs/analysis/var-reference-stats.md`）：

| 条件 | 阈值 |
|---|---|
| **A-share** | `fileSpan ≥ 3` |
| **A-pair 高频** | `fileSpan = 2` 且 `totalHits ≥ 15` |
| **单文件高位** | `fileSpan = 1` 且 `totalHits ≥ 60`（仅 Runtime-state 例外） |

数据门槛未过 → 留在自动报告，**不入本表**。

#### 门槛二：语义门槛（软性，人工判断决定层级）

过数据门槛后，按语义命中决定入哪层。必须**至少命中一条**才升格：

| 层级 | 语义判据 | 参考例子 |
|---|---|---|
| **Critical** | 承载跨进程/跨版本**协议**：字符串前缀、枚举值、保留 ID、bundle 版本号、错误类 schema | `FIXED_FIELD_VALUE_PREFIX`、4-way 映射标识、`FileValidationError` |
| **Important-skeleton** | 跨层**门面 / 入口**：Repository、IPC、读/写管线 | `templateRepository`、`normalizeCell`、`ipcRenderer` |
| **Runtime-state** | 运行时**唯一实例**：单例全局 / DOM 缓存 / 会话缓存 | `state`、`elements`、`lastGeneratedExports` |
| **Risk-sensitive** | 踩 CLAUDE.md 第 7 条**红线**：资金 / 行过滤 / 迁移 / 状态机 | `roundAmount`、`isRowMeaningful`、`hasColumn` |
| **Minor** | 过数据门槛但不命中以上四条的**公共工具** | `sanitizeBankName`、`pad` |

数据门槛过 + 语义门槛未过 → 只留在自动报告，不入本表（噪音过滤）。
语义门槛过 + 数据门槛未过 → 继续观察，跨度攒够再入。

### 明确排除（不升格）

- **技术性 require**：`fs`、`path`、`XLSX` 等（运行时底座，不是业务锚点）
- **测试/脚本专用符号**：`scripts/` 不在 `scan:vars` 扫描范围内
- **私有辅助函数**：大文件内部跨度高但无跨文件协作

### 降级 / 移出标准

为避免表膨胀失焦：

1. **跨度跌破**：连续两个版本 scan-vars 显示 `fileSpan < 2` 且非 Runtime-state 单例 → 降入 Minor 或移出
2. **改名/内联**：原名不存在 → 直接删除，不保留墓碑
3. **语义消失**：业务规则变更导致该符号不再承载契约 → 按新形态重评
4. **被更高抽象替代**：出现新的更高层门面取代它 → 移入 Minor 或删除

### 触发时机与责任人

| 节点 | 动作 | 责任方 |
|---|---|---|
| 提 PR 前 | `/check-vars` 输出「升格候选」段（自动报告里新出现的 A-share ∉ 本表） | team-lead agent 提示 |
| 版本号 bump | 完整过一遍本表 + scan-vars，评估升格/降级 | 用户 + Claude 协作 |
| 合并到受保护分支前 | 增量评估（不要求全量） | team-lead agent |
| 日常 Edit/Write | 不做升格判断（只做命中 review） | agent |

### 元数据维护

每次升格/降级后，更新本文件顶部元数据表的两项：

- `上次人工 review` → 当天日期
- `清单版本` → 若结构性变化（增删层级 / 大量条目变更），版本号小升

### 结语

本表是"给下一个改代码的人 / agent 看的 SOP 手册"，不是"全量索引"。宁可漏收 2 条边缘符号，也不要把表膨胀到没人愿意看的地步。
