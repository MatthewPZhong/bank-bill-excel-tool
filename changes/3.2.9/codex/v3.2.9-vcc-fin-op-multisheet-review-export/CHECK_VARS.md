# v3.2.9 VCC 重要变量关联检查

日期：2026-09-18。基线：`2ba9ef14fe972363b604955636cff0c9ac53700f`。范围为 `git diff HEAD -- src/` 加本分支未跟踪的新 JS 文件，未把未改的上下文算成改动。

对照 [check-vars skill](../../../../.claude/skills/check-vars/SKILL.md) 与 [重要变量表](../../../../rules/important-variables.md)。以下“规则原文”直接摘自变量表；执行证据及未执行项见 [实施记录](IMPLEMENTATION_REPORT.md)。

## 实质关联项

### Critical：VCC storage v3 能力、marker 和 guard

代码：src/backend/vcc-financial-op-db/storage-contract.js；src/backend/vcc-financial-op-db/storage-upgrade.js；src/backend/database.js。

核对结论：显式 v2→v3 增量事务；保存点内验证并替换索引/guard/marker；专用迁移连接最终关闭；Main、generic/dedicated Worker 和 COW 按实际版本初始化。已覆盖旧连接写阻断、持久阶段回滚、提交后失败和 canonical guard。

规则原文（`rules/important-variables.md:88`）：

- 变更 review 要点：
  - marker 与 exact trigger 安装必须在同一 SAVEPOINT 原子边界；任何表缺 trigger、错表或非 canonical SQL 都必须失败关闭
  - 每个新版写连接必须在 VCC DML 前显式注册 connection-local capability；不得默认放行、不得依赖进程全局布尔值
  - mutation guard 只能按 exact trigger name/target/SQL 放行该前缀，不能宽泛忽略未知 trigger
  - 合同版本升格必须另立迁移与兼容 Spec；已发布 v3.1.9 必须继续无法写 contract-v2 库
  - 必跑：storage-contract、migrations、generic/dedicated mutation、v3.1.9 downgrade probe、COW candidate 与 `npm run smoke`

### Critical：exact-seven BatchContext 的使用边界

代码：src/main.js；src/backend/vcc-financial-op/worker-entry.js；src/backend/vcc-financial-op/import-handoff.js。

核对结论：exact-seven 定义未修改。v2 来源成员作为独立字段传递并持久化；不把文件清单加入 BatchContext；恢复继续校验原 taskRunId/artifact/member 身份。

规则原文（`rules/important-variables.md:78`）：

- 变更 review 要点：
  - 增删/改名字段必须同步全部 producer、worker entry、持久 checkpoint/recovery 与 controller；禁止 worker 自行补批次、用月份/latest/renderer state 猜身份
  - 不得放宽正整数/非空/exact-set/frozen 约束，也不得把原始行、文件内容、可变 session 或内部路径塞入 context
  - 恢复必须沿用已持久化的同一 seven-field context；缺失/陈旧/不一致时阻断业务恢复，不能另分新批次掩盖
  - 必跑：worker-batch-context、TaskLifecycle、Acquiring resume、Position import、VCC worker、Pending 与工具箱 worker/dispatch 聚焦测试 + `npm run smoke`

### Important-skeleton：TaskPolicyRegistry / TaskLifecycle 的新增入口

代码：src/main-process/archive-center/task-policy-registry.js；src/main.js。

核对结论：新增 review 导出明确注册为 support-action/user-document-export，独立任务租约；导出不创建正式批次；现有后台生产启用开关未变。

规则原文（`rules/important-variables.md:398`）：

- 变更 review 要点：
  - policy 必须显式声明 file/no-file/exclude、allocation、`startsNewFlow` 与 terminal classifier；no-file 禁止携带 filePlan、建 batch 或推进 sequence，file reserve 必须是非空 manifest 与 batch/issuance/artifact 单事务
  - policy inventory、main wrapper、裸 IPC exclude 与 renderer/preload 入口必须同步；禁止以未登记直连绕过 lifecycle
  - `BusinessFlowResolver` 只能接受显式 parent 或已持久化的稳定业务身份；禁止月份、文件 hash、renderer/latest state 猜关联任务，bind intent 必须可重放
  - `archive_task_lineage` 只允许 planned→committed/discarded；只有 interrupted Task Run 可原 owner 恢复，failed/cancelled 不得复活；terminal outbox 不猜 lineage
  - 活动 owner、terminal intent 和恢复要保持幂等；archive 告警不能覆盖已取得的业务结果，也不能把失败任务标成成功
  - 必跑：task lifecycle/policy/IPC inventory/flow resolver、lineage/related、各 worker recovery 与 archive controller/integration 聚焦测试 + `npm run release-check`

### Important-skeleton：ipcRenderer

代码：src/preload.js；src/main-process/vcc-financial-op-review-ipc.js。

核对结论：Main、preload、renderer 同步新增 vccFinancialOp:export:review；请求严格只接受 runId/revision/fingerprint。真实 Electron/preload/IPC 验收已执行。

规则原文（`rules/important-variables.md:447`）：

- 变更 review 要点：新增/删除 IPC channel 必须同步 main 端 `ipcMain.handle`

### Important-skeleton：serializeError / deserializeError

代码：src/main-process/vcc-financial-op-service.js；src/main-process/vcc-financial-op-review-worker.js；src/main-process/vcc-financial-op-review-ipc.js。

核对结论：继续使用既有错误协议；保留 code/detailLines/cause/recoveryPaths。取消清理失败不能被 cancelled 吞掉；发布回滚失败显式返回恢复路径。

规则原文（`rules/important-variables.md:578`）：

- 变更 review 要点：
  - **错误堆栈完整度**：worker 内 throw 的 err.stack 必须含 worker 内文件路径 + 行号（POC §四 已验证）；改序列化逻辑漏字段 → 主进程 catch 的 err 失去定位能力
  - **FileValidationError 专属字段**：`code / message / detailLines / context` 必须完整回传；反序列化后 `err.name === 'FileValidationError'` 判断（**注意**：跨进程 prototype 链丢失，`err instanceof FileValidationError = false`）
  - **cause 链递归序列化**：错误的 `err.cause` 必须递归走 serializeError；改实现不能漏 cause 链
  - **双侧契约**：改 serializeError 输出 schema 必须同步 deserializeError 反序列化逻辑；不能单侧改
  - **与 SR-log-1 集成**：worker 内告警通过 message pipe 上报到 main 后写入同一 SR-log-1 日志（`logs/{YYYY-MM}/{MM-DD}/{level}.log`）；改序列化字段 → SR-log-1 日志格式变化
  - 必跑：unit `tests/unit/main-process/serialize-error.test.js` 8 case + 集成 `v2.1.10-a3-phase1` 错误回传 case

---

### Runtime-state：Electron dialog

代码：src/main.js；src/main-process/vcc-financial-op-review-ipc.js。

核对结论：原生另存为取消不启动 Writer；等待选择路径期间不持 VCC 长任务锁或业务事务。覆盖确认由原生选项负责，已测取消和目标替换；原生交互与 Windows 文件占用待人工验收。

规则原文（`rules/important-variables.md:596`）：

- 变更 review 要点：改 dialog 调用必须考虑用户取消分支
- ⚠️ check-vars 命中说明：`dialog` 是通用名，renderer 层 dialog factory 里也常写 `const dialog = document.createElement(...)`。命中时需人工判断是 `src/main.js` 的 `require('electron').dialog`（真命中）还是渲染层局部变量（可忽略）

### Runtime-state：Electron app 路径和退出

代码：src/main.js；src/main-process/vcc-financial-op-service.js。

核对结论：新入口使用 userData/resources/db 保护路径；关闭服务等待 review Worker 退出和任务清理，不调用导入恢复。Main app 全局启动/退出协议未改。

规则原文（`rules/important-variables.md:644`）：

- 变更 review 要点：改启动 / 退出钩子要考虑未保存状态

### Important-skeleton：AppDatabase.init

代码：src/backend/database.js。

核对结论：持久 v2 在 Main 业务连接创建前由专用连接迁移；新空库经 v2 阶段后重新打开 Main 连接去除旧能力函数，保持原六项 PRAGMA。初始化失败关闭连接。

规则原文（`rules/important-variables.md:661`）：

- 变更 review 要点：
  - **WAL 模式破坏性副作用**：用户机器 `tool-data.sqlite` 同目录会产生 `*.sqlite-wal` + `*.sqlite-shm` 旁文件；备份策略必须同步含旁文件（USER_GUIDE 已加 F7 WAL 旁文件备份提示）
  - 改 `cache_size` / `mmap_size` 数值 → 内存占用直接放大（64M cache + 256M mmap）；低配 Windows 机器需评估
  - 改 `journal_mode` → 回滚到 DELETE/MEMORY 会让并发读写性能退化（v2.1.6 → v2.1.7 性能提升核心来源）
  - 改 `synchronous` → NORMAL→FULL 写性能下降 ~2x；NORMAL→OFF 崩溃可能丢已提交事务（资金红线警戒）
  - init() 调用时机变化（如延迟到首次操作）→ 启动期间未跑迁移即用 DB
  - 必跑：smoke 19 suite 全套（PRAGMA 全局影响）+ 真实 DB 备份恢复演练（含 WAL 旁文件）+ 启动 cold/warm 双跑

### Risk-sensitive：VCC storage COW migration / recovery

代码：src/main-process/vcc-financial-op-storage-migration.js；src/main-process/vcc-financial-op-storage-rebuild.js。

核对结论：v1 非空保持维护/COW 入口和 ready/ack；候选保留 v2 中间阶段，再形成 v3；v2 专用增量迁移不清业务数据。

规则原文（`rules/important-variables.md:787`）：

- 变更 review 要点：
  - worker 完整复验后仍须持有源 `BEGIN IMMEDIATE`；coordinator 关闭全部主库连接并持 mutation lease 后才 ack 释放，禁止候选复验后出现成功写被覆盖
  - `prepared/copying/verifying/switching/switched/reopen-verified/rolling-back/rolled-back/done` journal 只能按唯一物理真相推进；候选不可读、rename/fsync失败和二次崩溃必须恢复完整 v1 或明确停止
  - 迁移不得改变有效主键/内容哈希、各月来源行数、结果、调整、归档或九币种余额；压缩率低于75%不得切换
  - updater/exit/migration 使用 owner/token lease，只能释放自己的 token；旧库删除必须由用户选择且在首次只读校验后执行
  - 必跑：真实 SQLite COW 故障矩阵、worker ready/ack、recovery 双启动、business-operation-registry、app update/exit、Archive lineage/hold、资金回归与 `npm run smoke`

### Risk-sensitive：ArchiveRepository / ArchiveService / archive_*

代码：src/backend/database/archive-repository.js。

核对结论：仅增加受验证的输入成员 metadata 持久方法，不新增业务明细表或修改存档删除合同；同一原件多个 source owner 独立 hold。正式导出批次协议保留。

规则原文（`rules/important-variables.md:797`）：

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

### Risk-sensitive：VCC import handoff / lineage / import_sources

代码：src/main-process/vcc-financial-op-archive-lineage.js；src/backend/vcc-financial-op/import-handoff.js；src/backend/vcc-financial-op/import-service.js。

核对结论：v2 成员清单先持久、原件 ready、全部来源与 hold 原子建立，再逐组写事实；同名同内容的不同输入保留不同来源，即使冻结后共用 Blob 路径。原表重建按原件和原 Sheet/行核验。

规则原文（`rules/important-variables.md:815`）：

- 变更 review 要点：
  - worker 首笔业务 DML 前必须精确比较 taskRunId、artifactId、类型、ordinal 顺序、SHA和大小；缺失、重复或 A→B 变化均须零业务写
  - startup 固定 module owner→terminal/file outbox→flow intent→ownerless sweep→raw storage/hold/retention；hook 失败时不得先清理可能被有效数据引用的 artifact
  - v1 source 只允许按持久 artifactId 直查，并复核 artifact 所属 batch.taskRunId/sourceOperation/SHA/size；不得仅凭 path、metadata、文件名或 ordinal 换绑；只有 null-ID 历史 v0 可走命名 legacy 兼容
  - source/artifact/hold 重放必须幂等，禁止按月份、文件名或 latest 猜身份；SQLite 不存完整 Excel 字节
  - 必跑：archive-lineage 真实 SQLite+FS、actual worker A→B、crash双启动、hold manual/retention、dataset artifact corruption、TaskLifecycle/outbox 与 `npm run smoke`

## 定义文件命中、对应符号语义未改

以下条目因其定义/门面文件为 `main.js`、`preload.js` 或 `database.js` 而保守纳入；已核对 diff，对应常量、方法和生命周期没有改动。未把这些同文件命中说成新业务变更。

### `ADVANCED_MAPPING_FIELDS`

来源：`rules/important-variables.md:108`。

- 变更 review 要点：
  - 增删成员 → 渲染层映射对话框 UI / 模板持久化 schema 都要同步
  - 涉及 CLAUDE.md "Amount mapping modes (4-way)" 的边界

### 4-way 金额映射模式标识

来源：`rules/important-variables.md:115`。

- 变更 review 要点：
  - 四种模式互斥（CLAUDE.md Key Business Rules），改任意一个都要验证其他三种未串味
  - 模板 JSON bundle 的 `bundleVersion` 可能需要同步升格
  - 必跑：四种模式各一个样例模板的导入/导出

### `CONCAT_FIELDS_MAPPING_FIELD`

来源：`rules/important-variables.md:126`。

- 变更 review 要点：拼接顺序 / 分隔符变化会直接改动输出内容

### `MERCHANT_ID_SELF_INPUT_OPTION`

来源：`rules/important-variables.md:131`。

- 变更 review 要点：自行输入值落盘到 `lastFileImportContext`，导出时复用——改了标识要同步改匹配逻辑

### `BALANCE_CALCULATED_OPTION` / `BALANCE_DISABLED_OPTION`

来源：`rules/important-variables.md:136`。

- 变更 review 要点：
  - 改枚举值会让历史模板持久化记录错位
  - **资金相关**，必跑：余额工作表（单币种 + 混币种）导出对比

### `FILENAME_MAPPING_TEMPLATE_ID`

来源：`rules/important-variables.md:143`。

- 变更 review 要点：若改 ID，`database/template-repository.js` 里所有 `where id = FILENAME_MAPPING_TEMPLATE_ID` 分支要同步

### `unmatchedRows`（v2.1.7 F8 dispatcher 反向 filter 输出字段，升格 Critical ⚠️ 资金红线）

来源：`rules/important-variables.md:269`。

- 变更 review 要点：
  - **资金红线**：dispatcher unmatchedRows 是反向 filter 派生数据；保证 `modifiedRows + unmatchedRows = bankRows` 是核心契约（F8 spec §9.8 + spec §11.3 反向同步明确）
  - 改 `_rowId` 内部字段名 → 必须同步 dispatcher rowLockSet add + 反向 filter has 判断 + writer 输出剥 internal field
  - dispatcher 与 reconIdFix 两条同名字段维护**严格分离** — 改一条不要扩散到另一条
  - writer `stripInternalFields` helper 必须保证第 2 sheet 输出不暴露 `_rowId` 等内部字段
  - 必跑：smoke 19 suite 含 baseline `modifiedRows.length` 不变（F8 上线后 baseline 严守）+ F8 第 2 sheet 行数 + unmatchedRowCount stats

### `templateRepository`

来源：`rules/important-variables.md:410`。

- 变更 review 要点：增减方法要同步 preload IPC 暴露与 renderer 对应调用

### `settingsRepository`

来源：`rules/important-variables.md:421`。

- 变更 review 要点：renderer 侧缓存与 main 侧持久化的 key 必须对齐

### `ArchiveCenterController` / `archiveCenter` IPC（v3.0.22 新增 Important-skeleton）

来源：`rules/important-variables.md:452`。

- 变更 review 要点：
  - controller / main IPC / preload 11 个方法 / renderer 调用必须同步，禁止 renderer 取得 Blob 路径、已登记原始源路径、预期 SHA 或预期大小
  - `selectRetrySources` 只能为具备不可变业务摘要的失败 artifact 选择替代路径；`retryBatch` 必须按 artifact ID 白名单透传，并由 ArchiveService 重新校验普通文件、大小、读取稳定性和 SHA
  - `archive_center_retention_days` 只接受 30/60/90/180/365/永久；缺失或非法值按 60，改枚举必须同步 UI、controller、ArchiveService 和既有设置兼容
  - `archive_center_excluded_template_ids` 自 v3.0.25 起为退役兼容 key，控制器启动时必须规范化为 `[]`；不得恢复隐藏的模板级跳过
  - 网银账单与月度余额不得再由模板元数据产生 `skipArchive`；operation tracker 通用 `skipArchive` 能力仍需回归
  - 删除元数据成功但物理清理失败是部分成功，UI 必须刷新批次并保留残留清理提示
  - 必跑：archive controller/UI contract 单测 + 设置页预览 + `npm run verify:app-settings-layout` + `npm run smoke`

### `setupIdleCleanupTimer`（v2.1.8 N1' v0.7 新增 Important-skeleton — idle 30min cleanup 触发器）

来源：`rules/important-variables.md:549`。

- 变更 review 要点：
  - **触发条件 AND 设计**（spec v0.10 §3.2.2 N1''-D6）：renderer 上报 user-activity + mutex 间接判定 main 未忙；改任一条件 → idle 误判风险
  - 改 IDLE_CLEANUP_MS 常量 → 用户体验大变（短 → cleanup 频繁打扰；长 → 数据长期不清）
  - 改 tick 粒度 → 触发延迟 + CPU 开销 trade-off
  - **不能加 .unref() 删除**（避免阻塞退出，但要确保 cleanup mutex 在 before-quit 之前抢到）
  - 必跑：手测 30min 不动 → 触发 + log；smoke 中 fake timer 验证 idle 路径（v2.1.9 G1 全量铺时补 unit case）

### `lastGeneratedExports`

来源：`rules/important-variables.md:622`。

- 变更 review 要点：
  - 改生命周期会让重复导出/打开导出目录的行为异常
  - 已知副作用：重启丢失，不要为它加持久化（与现有设计冲突）

### `statementImportSessions` / `lastFileImportContext`

来源：`rules/important-variables.md:629`。

- 变更 review 要点：session key 生成逻辑变化会让导出阶段丢失上下文

### `archiveOperationTracker` / `archiveOperationContext` / `archiveOperationTail`（v3.0.22 新增 Runtime-state）

来源：`rules/important-variables.md:649`。

- 变更 review 要点：
  - 批次键必须沿用 lifecycle 的 `moduleId/taskRunId/taskKey/operationKey/parentRunId`；不能把链接表、临时 MPT、资金对账、工具箱和对账单修复串到同一批次
  - 仅 `ARCHIVE_CHANNELS` 白名单进入 AsyncLocalStorage；不能让无关 IPC 参数被闭包或队列长期持有
  - 业务 handler 返回值必须先返回，归档失败只能告警；后台任务只保存轻量文件路径/结果快照，不持有银行行数组
  - 首次结果冻结和当前周期边界不可放宽；无活动批次的历史导出不得建立 output-only 批次
  - 业务成功时必须先固化源文件身份；后台复制前若文件已变化，应标记失败并要求重新执行业务，不能归档变化后的内容
  - 正常退出和在线升级退出必须等待归档队列完整排空；5 秒只用于慢退出告警，不能作为放弃尚未登记任务的上限
  - 必跑：archive operation tracker 全策略测试 + 13 主模块/工具箱关键路径 + TaskLifecycle/worker context + 启动性能检查

### `bankStatementSession`（v2.1.16 阶段一 A5 升格 Runtime-state ⚠️ 资金对账数据处理进程级 session）

来源：`rules/important-variables.md:686`。

- 变更 review 要点：
  - **v2.1.16 合并语义**（🔴 资金红线，2026 用户拍板「合并不覆盖」）：批量导入多份银行对账单 = **追加 rows 到同一 session 统一对账**（`src/main.js:11163` 起）；第一个建 session（含 `sourceFiles`），后续银行对账单先校验 `headers` 与 session **完全一致**（44 列同结构同顺序，`bankStatementHeadersEqual`）才追加，不一致该文件标 `invalid` 不合并（防异构表混入污染对账）
  - 🔴 **`_rowId` 全局唯一不变量**：`readBankStatement` 注入的 `row_0..row_N` 是「文件内」编号，多文件合并会重复；合并后**必须对 `session.rows` 统一重编号** `_rowId='row_'+全局index`（0-based 跨文件唯一，`src/main.js:11204`），否则 dispatcher 的 `rowLockSet`（以 `_rowId` 为键的 first-match-wins 锁）会把不同文件的同序号行当成同一行 → **漏对 / 误锁**（`scenario-dispatcher.js` modifiedRows / unmatchedRows filter 全依赖 `_rowId`，见 Critical 层 `runAllScenarios` / `unmatchedRows` 条目）
  - 改 `headers` 一致校验逻辑 → 异构表可能混入合并 → 对账数据集污染
  - 重导入（单选 / 批量首个）时同步清空 `processingResult` + `gatewayReconSession`，否则老结果 / 老网关行误用到新数据
  - 必跑：单选导入 + 批量合并多文件导入后跑 run/export，核对 `_rowId` 全局唯一 + modifiedRows + unmatchedRows.length === rows.length

### `gatewayReconSession`（v2.1.16 阶段一 A5 升格 Runtime-state ⚠️ 资金对账数据处理进程级 session）

来源：`rules/important-variables.md:697`。

- 变更 review 要点：
  - **导入银行对账单时被清空**（`src/main.js:3459` 单选 / `src/main.js:11182` 批量首个）——避免把上一批 `gwRows` 误用到新银行对账单（Codex F2 P1 修复语义）
  - 改 `gwRows` 字段名 / 结构 → C3 join 比对取数失败
  - 必跑：导入网关 → 导入新银行对账单 → 确认 `gatewayReconSession` 已清空（session-status `hasGatewayRecon=false`）

### `processingResult`（v2.1.16 阶段一 A5 升格 Runtime-state ⚠️ 资金对账数据处理进程级 session）

来源：`rules/important-variables.md:706`。

- 变更 review 要点：
  - **scenarios 变更 / 重导入银行对账单 / 重导入网关时主动清空**（`src/main.js:3458` / `3496` / `11181`）——避免老运行结果被新数据 / 新场景配置误用导出（资金红线：导出的命中行必须对应当前 session + 当前场景快照）
  - 改 `modifiedRows` / `stats` 结构 → export 写盘 + 状态框统计取数错位
  - 必跑：跑出结果后改场景 / 重导入 → 确认 `processingResult` 已清空（不残留老 stats / 老命中行）

### `refundOrderSession`（v3.0.0 PR-4 升格 Runtime-state ⚠️ 资金对账数据处理进程级 session — 退款回填引擎入参源）

来源：`rules/important-variables.md:715`。

- 变更 review 要点：
  - 🔴 **生命周期 PR#65 已收紧**（单文件导入无条件清 `src/main.js:3494`；批量导入「本批未识别到退款表」时清 `src/main.js:11460` `if (!refundImportedThisBatch) refundOrderSession = null;`）——严格绑定「本批有效导入退款表」；否则旧 refundOrderSession 残留 → 下次 run 把上一批退款订单注入新银行单 = **跨批错回填**（资金事故）
  - 🔴 **就绪判据写反 = 漏跑退款**：v3.0.0 需求3 `hasRefundOrder = refundOrderSession !== null`；前端 `shouldPromptRefundAtRun` / `maybePromptRefundOrderImport` 据此 + 退款候选预检（`countRefundBankCandidates` = FundType=Ach Return 计数）门控提醒；本迭代**只读不改其写入/清空时机**
  - 落 session 入口（`src/main.js:11529` `refundOrderSession = { fileName, rows: refundRows, importedAt }`）整体覆盖；改 `rows` 字段名/结构 → 退款回填引擎跨表字段映射（`refund-backfill-fields.js`）取数失败 = 写错回填
  - 必跑：批量导入退款表 → 跑 run（确认回填命中）→ 重导无退款表的批次 → 确认 `refundOrderSession` 已清空（session-status `hasRefundOrder=false`、run 注入 `[]` no-op，不跨批回填）

---

### `DEFERRED_WINDOW_STARTUP`（v3.0.5 Part B Phase 3 新增 Runtime-state ⚠️ 启动时序回退开关）

来源：`rules/important-variables.md:1159`。

- 变更 review 要点：
  - 回退开关一行切回旧时序（=0），旧时序分支必须保持完整可达（仿 `USE_BIG_TABLE_IMPORT_ENGINE` 退役路径，稳定一版后移除）。
  - `register*Handlers` 上移依赖「handler 体惰性引用 database（闭包），注册时不解引用」—— 新增 handler 若在注册时直接解引用 `database.xxx()` 会 NPE（必须 `() => database && database.db` 惰性）。
  - `app:get-info` 两段式：init 未完返回 `{initPending:true,version}`；改字段须同步 renderer `applyFullInfo` 消费。
  - 前端改动 → 重跑 `npm run preview`；改时序 → `npm run startup:measure` 对比（建窗≤300ms / 日常≤1.5s / 升级首启≤3s）。

## 同名与陈旧定位的处理

- VCC `SOURCE_TYPES` 与头寸模块同名，但定义和语义不同；没有修改头寸来源枚举。
- 新文件里的 `state`、`rows`、`JSON.parse`、`Object.assign`、`undefined`、`false` 属于局部字段或语言用法，不据此声称改动了资金对账 session、条件逻辑或退款策略。
- renderer 的局部 dialog 与 Electron 原生 `dialog` 分开核对；本次原生调用见上面的实质关联项。
- `setStatus` 是 VCC 模块已有局部函数，新增预检/读取/汇总调用不改变全局 renderer 状态栏。
- 变量表中的 `DEFERRED_WINDOW_STARTUP` 描述属于旧启动方式；本基线实际通过 `runActionTaskBindingStartup()` 完成初始化后注册 IPC。已核对 `registerAllIpcHandlers()`，没有按旧规则推定一个不存在的提前注册入口。
- Minor：未命中新增的 Minor 语义变化。

## 重要变量升格候选

`withBoundedWorkbook`、`projectReview` 各由三个生产文件共同定义或消费，分别承载共享写入资源合同、页面与 Sheet1 布局合同。可在后续变量表维护时评估升格；本次未自动新增注册条目。

## 可粘贴到 PR 的关联功能 review

本次改动触及 VCC storage v3、输入成员与 artifact hold、IPC 支持操作和数据库连接生命周期。

- Critical：marker 与 exact trigger 在同一 SAVEPOINT 原子切换；每个新版写连接显式注册能力；旧连接拒绝写 v3；exact-seven BatchContext 不扩字段。
- Important-skeleton：policy inventory、Main、preload、renderer 入口同步；错误保留 code/detailLines/cause/recoveryPaths；Main PRAGMA 不改变。
- Risk-sensitive：先固化原件与来源 hold 再提交事实；按持久身份重建和恢复；Review 导出无业务 DML；共享 Writer 的 Biz OP 回归必须保留。

检查状态由实施记录中的最终命令结果确定。Windows 安装版、原生另存为/占用、Excel/WPS、完整 PF01–PF05 和生产配置冷/热启动、含 WAL 的人工备份恢复演练仍需实际记录，不能由专项通过代替。
