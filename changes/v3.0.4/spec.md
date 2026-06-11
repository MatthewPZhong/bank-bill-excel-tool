# Spec — v3.0.4 迭代入口（七块：JSZip 止血 / 引擎第二波迁移 pending+biz-op / 银行对账输出三修复 / BOC调拨订单修复 / Payment线下调拨回填 / Charge转outbound 多行收紧）

> 状态：**implemented（v3.0.4 分支，2026-06-11，commit 934148f..9387655）** —— 七块（A JSZip 止血 / B pending 引擎 / C biz-op flow 引擎 / D 银行对账输出三修复 / E BOC调拨订单修复 / F Payment线下调拨回填 / G Charge转outbound 多行收紧）全部入库，版本 bump 3.0.4 + 文档三件套 + manual-test-checklist + important-variables + backlog 收尾批已落 ｜ 来源分支：`main`（PR #70 已合并）→ 开发分支 `v3.0.4`（已切出） ｜ 目标版本：**3.0.4**
> 性质：🔴🔴 资金敏感区（挂账 pending_rows / 业务OP biz-op 流水均为入库真理源；覆盖删除链触及对账数据污染红线 Codex PR #55 Finding 1；导入链路换引擎必须 byte-for-byte 锁）。
> 上游输入：`knowledge/backlog.md` B9（JSZip 2^31 根因，2026-06-10 实证）+ `changes/acquiring-import-recon-perf/spec.md` §8.5 适配清单 + `changes/big-table-import-engine/spec.md` §1.2（"后续迭代按崩点压力排期——pending 优先"）+ 2026-06-10/11 全链路调研（本 spec §一.1 引用结论）。
> **本 spec 为 v3.0.4 迭代变更目录入口**，统筹**七块**需求：原三块（用户 2026-06-11 圈定：B9 方案 A + 调研排序 ①pending + ③biz-op，本 spec §二~§五详设）+ 用户 2026-06-11 拍板合并进迭代的三个子 change（本 spec 只管编排，详设见各子 spec）：
>   块 D = `changes/bank-recon-output-fixes/spec.md`（银行对账输出三点修复，先行——块 F 依赖其 error-report 终态）
>   块 E = `changes/boc-dispatch-order-fix/spec.md`（BOC调拨订单修复：内置场景 + BOC链接表派生 + 修复引擎）
>   块 F = `changes/payment-offline-allocation-backfill/spec.md`（Payment线下调拨订单回填：R5s2b 引擎 + UI/配置）
>   块 G = `changes/charge-outbound-max-debit/spec.md`（Charge转outbound 多行取 Debit Amount 最大行，用户 2026-06-11 追加并入——「干完后新增…并入3.0.4里做」）

---

## 一、本迭代 3 块需求与依赖关系

| 块 | 需求 | 一句话 | 性质 | 设计 |
|----|------|--------|------|------|
| A | JSZip 崩点止血 + 链接表报错可见性 | 入口预检 ≥2^31 报明确中文错误（不再 "uncompressed data size mismatch" 天书）+ 修「报错信息全链路零落盘」 | 🟡 防御护栏 + 可观测性（不改任何落库语义） | 本 spec §二 |
| B | 挂账 pending 导入迁移大表引擎 | JSZip→引擎（yauzl 基座，300w 设计目标解锁）+ child_process→worker_threads 拓扑统一 + 多文件并行 | 🔴🔴 资金红线（pending_rows 真理源 + 6 表覆盖删除链） | 本 spec §四 |
| C | 业务OP对账 biz-op 流水导入迁移引擎 | flow 侧切引擎（多文件并行 + 崩点解除）；业务OP 侧不迁（✅ OPEN-1 拍板） | 🔴 资金红线（流水入库真理源） | 本 spec §五 |
| D | 银行对账输出三点修复 | Extra Fee 取反 / error-report 与命中场景行目录互换 / 行号列换对账ID | 🔴 资金红线（输出金额符号翻转）+ 对外路径/列契约变更 | `changes/bank-recon-output-fixes/spec.md` |
| E | BOC调拨订单修复 | 内置写死场景 + 两张隐藏链接表派生（外汇交割分组/中台匹配/银行单回填）+ 整组匹配修复引擎 | 🔴 资金红线（修复行生成 + bank-deposit 白名单 13→14） | `changes/boc-dispatch-order-fix/spec.md` |
| F | Payment线下调拨订单回填 | R5s2 config 子开关 + ISO 周数匹配引擎 R5s2b（网关回填优先互斥）+ 弹窗三输入框 | 🔴 资金红线（向 ReconciliationId 写值） | `changes/payment-offline-allocation-backfill/spec.md` |
| G | Charge转outbound 多行行为收紧 | R4 charge-outbound 子场景同桶多条 Charge 行仅转 Debit Amount 最大行（其余四子场景维持全转） | 🔴 资金红线（FundType 改写语义收紧，下游 HX-out 链随动） | `changes/charge-outbound-max-debit/spec.md` |

**依赖关系**：

- 块 A **完全独立、可先行**（只加预检与日志，不动落库路径）。
- 块 B、C 共同依赖 **§三 引擎扩展包（PR-B）** 先落地；扩展包以"契约不声明新 hook ⇒ 引擎行为零变化"为铁律，收单（已迁用户）零感知。
- 块 B 与块 C 互不依赖，PR-C / PR-D 可并行。
- 块 D **先行**（块 F 的 error-report 形态按其终态书写）；块 E 独立；块 F 依赖块 D 终态。
- 🔴 **main.js 串行约束**：`src/main.js` 含 NUL 字节、git 视为二进制**不可文本合并**——所有触及 main.js 的子任务（A2 / 块 D F2+F3 / 块 E 接线与 run 注入 / 块 F 接线 / 块 B session 接线）必须在主工作区**串行编辑**，纯新文件与互不相交文件的子任务并行。
- **本迭代结束后**，仍留在 JSZip 基座上的模块 = 链接表 + vcc（+ 两条回退旧链路），由块 A 护栏兜底——见 §一.2。

### 1.1 调研结论引用（2026-06-10/11，已核实）

- **根因**（B9，已亲验源码）：JSZip 3.10.1 `DataReader.js:64` `readInt` 用 `(result << 8) + byte` 有符号 32 位累加，entry 解压尺寸 ≥ **2^31 = 2.147GB** 被读成负数 → `compressedObject.js:38` 解压完成校验必不等 → 抛 `Bug : uncompressed data size mismatch`。zip64 救不了（readInt(8) 同溢出）。
- **量化**：链接表 65.7w 行（sheet ≈1.72GB）通过 / 98w 行（≈2.56GB）实证撞崩；pending 300w×31 列设计目标（sheet ≈3-4GB，§8.2 估）**在现基座必然不可达**——按 2.147GB 真实阈值折算，崩点约 **170-200w 行**（121w 实证仅余 ~1.5x 余量）。
- **共用基座暴露面**：`pending-import/streaming-xlsx-reader.js:17`（JSZip require）被 pending worker / linked-table 流式 / biz-op `reader-streamed.js` / vcc reader 四方消费。
- **引擎免疫**：big-table-import `zip-reader.js:22` 基于 yauzl（无符号读取 + 正解 zip64），且已带 W4 worker 拓扑 / 多文件并行（实测 4-worker 3.06x）/ row-scanner 2.32x / cancel / 内存闸 / PRAGMA 第 5 处契约。

### 1.2 不做什么（本迭代非目标）

- **B9 方案 B（streaming-xlsx-reader zip 层整体换 yauzl）**：被「pending/biz-op 直接迁引擎 + 块 A 护栏」组合替代。链接表与 vcc 留在 JSZip 基座，由护栏明确报错（链接表 82w 行密度上限不变，但用户得到可执行指引）。
- **链接表迁移引擎**：独立迭代（缺口=引擎需加"表头扫描定位"模式 + 多表混选分组 dispatch + B8 合并语义，见 backlog B9 方案 C）。
- **vcc 迁移引擎**：调研结论为架构不匹配（聚合器、不存原始行、多 sheet 自动定位），不上引擎；其"主进程同步卡 UI"另立小迭代挪 worker（backlog B10）。
- **业务OP（bizOp）侧迁移**：默认不迁，理由与重启条件见 OPEN-1。
- **收单 dispatch 收编共享模块**：收单 session 的 `dispatchEngineImport` 保持原样不动（其 34 断言对比脚本锁定链路零风险）；本迭代新建共享 dispatch 模块仅供 pending/biz-op 使用，三方收敛留后续迭代（OPEN-2）。
- 引擎 PRAGMA 清单收敛为单一导出模块（engine spec 既有遗留项，继续不做）。
- B8（链接表多选多文件互相覆盖）：留 backlog，随链接表迁移迭代一并。

---

## 二、块 A：JSZip 崩点止血 + 报错可见性（PR-A）

### 2.1 A1 · 入口尺寸预检（止血）

**设计**：新增预检函数（落点 `src/backend/pending-import/streaming-xlsx-reader.js` 内部或同目录独立小模块），用 **yauzl 读中央目录的无符号 entry 尺寸**（yauzl 已是依赖、正解 zip64 与 data descriptor——中央目录恒有真值），检查目标 sheet XML 与 `xl/sharedStrings.xml` 的 `uncompressedSize`：

- `≥ 2^31` → 抛 `FileValidationError`，中文文案（最终措辞实施时定稿，要素必含）：
  - 「文件数据量过大：表格内容解压后约 X.XX GB，超出当前导入通道单文件上限（2GB）」
  - 「请将文件拆分为多个较小文件分批导入（参考：约 80 万行以内/文件）」
  - detailLines 带 entry 名与字节数（供日志/排查）。
- 预检自身失败（zip 打不开/找不到 entry）→ **fail-open 放行**，让原链路报原错（预检只拦"确定超限"，不引入新误伤面）。

**调用落点**（3 处，实施时逐一核实是否独立持有 JSZip `loadAsync`，独立则各自加调用）：

1. `readXlsxStreamed` 入口（覆盖 pending 旧链路 / linked-table 流式 / biz-op fallback）；
2. `vcc-op-calc-import/reader.js`（自带 JSZip 走查，见 `streaming-xlsx-reader.js:326` 注释）；
3. `biz-op-recon-import/reader-streamed.js`（`:35` 自带 JSZip require）。

### 2.2 A2 · 链接表报错可见性（修「报错全链路零落盘」）

B9 已查实的三处丢失点与对策：

| # | 丢失点 | 现状 | 改法 |
|---|--------|------|------|
| 1 | `linked-table:import` handler（`main.js:11273`） | per-file 失败仅进返回值，不写 activity log | 循环结束后若存在 `read-error / write-error / ambiguous / unrecognized` → `appendActivityLogEntry`（error 级，message 含 N/M 失败计数，details 列 per-file `fileName + status + message`） |
| 2 | 链接表管理弹窗 alert `skipLogReport: true`（`renderer-dialogs.js:6399`） | UI 显示但绕开日志上报 | **保留 skipLogReport**（日志改由 #1 handler 权威落盘，避免双写）；仅在注释标注"日志由 main 侧 handler 落" |
| 3 | C3/运行前提醒两个入口（`renderer.js:3738` / `:3885`） | `await window.desktopApi.linkedTable.import()` 返回值直接丢弃，用户完全无感 | 消费返回值：存在失败项 → 弹 alert 列 per-file 失败明细（走默认 error 日志路径或依赖 #1，实施时统一） |

### 2.3 验收（PR-A）

- 单测：预检函数对「正常 / ≥2^31 构造样本 / 损坏 zip（fail-open）/ zip64」四态断言。≥2^31 fixture 用高重复内容生成（解压 2.2GB+ 压缩后预计几十 MB）或脚本直改中央目录尺寸字段，取实施时成本低者。
- 集成：链接表导入失败路径 → activity log 出现 error 条目断言。
- 手测：98w 行实证文件重导 → 弹明确中文错误 + 日志可查。
- 前端涉及 `renderer.js`/`renderer-dialogs.js` → 跑 `npm run preview` 回归（A2 不动 dialog 结构，preview 兜底确认无布局回归）。

---

## 三、引擎扩展包（PR-B，块 B/C 共同前置）

> 铁律：**所有扩展均为契约可选项——契约不声明 ⇒ 引擎行为与 v3.0.3 完全一致**。收单契约（contract-flow/bill）一字不改，`acquiring-engine-migration.js` 全链对比脚本必须全绿（回归锁）。

| 编号 | 扩展 | 动机（消费方） | 设计要点 |
|------|------|----------------|----------|
| E1 | **多语句覆盖删除**：契约可声明 `deleteForOverwrite(deleteKey) => Array<{sql, params}>`（函数式，替代单串 `deleteSqlForOverwrite`） | pending `deleteMonth` 是 **6 条 DELETE、参数形态不一（2 参 ×3 + 1 参 ×3）、顺序敏感**（`month-repository.js:77-93`，含 Codex PR #55 Finding 1 红线注释：先删 pending_removal_matches → diff_rows → diff_runs → removed_pending_rows → pending_rows → pending_months）；biz-op flow clear 为 2 条 | 引擎在大事务内按返回顺序逐条 prepare+run；与既有 `deleteSqlForOverwrite`（string）互斥共存，优先函数式；`deletedCount` 取各语句 changes 之和 |
| E2 | **事务内收尾**：契约可声明 `finalizeForCommit({ totalImported, sourceFiles }) => Array<{sql, params}>`，引擎在 COMMIT 前执行 | pending `upsertMonthMeta`（rowCount/sourceFiles/archivePath/importedAt）必须与行 INSERT 同事务原子（崩溃中间态=有行无月元数据，资金敏感） | 纯声明式（不暴露 db 句柄给契约）；archivePath/importedAt 经 contractOptions 闭包注入 |
| E3 | **空文件整批拒绝**：契约可声明 `rejectEmptyFiles: true` + `formatEmptyFileError(sourceFile)` | pending 语义「文件为空或只有表头行」→ 整批拒绝（`worker.js:148-151`） | 引擎 writer 侧按 sourceFile 统计数据行数，0 行 → 记批级错误（与行级错误同走整批 ROLLBACK） |
| E4 | **行级错误捕获增强**：契约可声明 `maxCollectedErrors`（覆盖默认 100）+ `captureRowValues: true`（错误记录附带原始 cells） | pending/biz-op 错误上限均为 **1000** 且错误报告 xlsx 需要整行 cells（pending `worker.js:26/127`；biz-op `import-worker.js:46` + rawRow 报告）——引擎现状 100 条、无 cells，迁移即降级 | cells 从 batch 行内已有数据取（whitelist=null 时 values 即全列），仅错误行复制，内存可控 |
| E5 | **写侧跨文件去重**：契约可声明 `dedupeKeyOf({ values }) => string`（解析 worker 算 key 随 batch 传递）+ `formatDuplicateError({ key }) => message`；引擎 writer 维护 Set，命中 → 记行级错误（不 INSERT） | pending 跨文件 sha 去重 + 重复行=整批拒绝语义（`worker.js:118-132`，文案 `发现重复行（hash xxxxxxxx...）` 必须逐字平移） | key 计算在解析 worker（并行摊销）；Set 在 import-worker 写循环（按文件序单写 ⇒ 结果确定性与旧串行一致）；300w 行 Set ≈360MB，见 R-5 资源限制 |
| E6 | （**预留，OPEN-1 决定是否实施**）peek 派生批级键注入 mapRow ctx + 跨键错误文案 hook | 仅业务OP（bizOp）侧需要（firstBu 数据驱动清理 + 逐行 BU 一致 + bu_name 改写）；flow 侧与 pending 均不需要 | OPEN-1 若维持"bizOp 不迁"则本扩展整体裁剪 |

**PR-B 验收**：引擎单测覆盖 E1-E5 各扩展（声明/不声明两态）；`npm run release-check` 全绿；收单全链对比脚本（34 断言）全绿 = 回归锁。

---

## 四、块 B：pending 迁移引擎（PR-C）🔴🔴

### 4.1 现状基线（已查实，file:line）

- 拓扑：`pending:import:start`（`main.js:10322`）→ pending-session **utilityProcess.fork**（8GB 堆，`pending-session.js:40-46`）→ `worker.js`（child 入口，stdout JSON 行协议，exit code 0/1/2）。
- 读取：`readXlsxStreamed`（JSZip，硬编码 `xl/worksheets/sheet1.xml`）；表头物理第 1 行 31 列严格校验；小样本走主进程同步兜底（`pending-session.js:37` 阈值）。
- 落库语义（**全部必须逐字平移**）：单大事务 BEGIN → `deleteMonth`（6 表，顺序敏感）→ 逐行 `computeRowHash` 跨文件去重 → `createRowInserter`（33 参 INSERT）→ 任一错误（含单条重复行）→ **整批 ROLLBACK** → 全通过 → `upsertMonthMeta` → COMMIT。
- 错误协议：`{severity: fatal|row, file, sheetRow, message, cells}`，row 级上限 1000 条带 cells（供 `pending:error:export-report` 导报错 xlsx），`rowErrorTotal/rowErrorTruncated` 真实计数。
- 月份：单月 `yearMonth` 由 UI 入参，行内无月份列。

### 4.2 迁移设计

1. **契约模块** `src/backend/pending-import/contract-pending.js`（PR-H contract-flow 范式：复制 SQL/逻辑不 require 仓储，parity 锁防漂移）：
   - `expectedHeaders` = PENDING_COLUMNS（31 列）；`valueColumnWhitelist: null`（全列入库，无可裁）；`requiredColumns` = 全列索引。
   - `validateHeaders` 复用 `pending-import/validator`（纯函数）。
   - `mapRow` → 33 参 params（yearMonth 经 contractOptions 闭包 + rowHash 由 E5 路径产出——实施时定 rowHash 进 params 的衔接形态：dedupeKeyOf 与 mapRow 共算一次 hash，避免双算）。
   - `insertSql` = `createRowInserter` 的 INSERT 语句逐字平移。
   - `monthKeyOf: () => null`（跨月校验旁路——已核实 `engine.js:313` null 基准时整体跳过）；**引擎 `monthKey` 参数不传**。
   - `deleteForOverwrite`（E1）= deleteMonth 6 条 SQL+参数逐字平移（闭包 yearMonth）。
   - `finalizeForCommit`（E2）= upsertMonthMeta SQL（rowCount=totalImported、sourceFiles、archivePath、importedAt 闭包注入）。
   - `rejectEmptyFiles: true`（E3）+ `maxCollectedErrors: 1000` + `captureRowValues: true`（E4）+ `dedupeKeyOf/formatDuplicateError`（E5，sha 算法与 `computeRowHash` 同源——契约 require validator 的 computeRowHash，纯函数合法）。
2. **dispatch**：新建共享模块 `src/main-process/big-table-import-dispatch.js`（平移收单 `dispatchEngineImport` 范式：engine-worker-entry + jobId + progress/log/done/error 协议 + `serialize-error` 还原），增加 `resourceLimits` 选项（见 R-5）。pending-session 改调它；**移除小样本主进程同步兜底分支**（引擎统一处理大小文件，见 R-9）。
3. **回退开关**（PR-H 范式）：`USE_BIG_TABLE_IMPORT_ENGINE_PENDING`，默认 true；false = 原 utilityProcess + worker.js 全旧链路（`worker.js` / `month-repository.js` / 旧 reader 一字不改保留）。测试经 env `PENDING_FORCE_LEGACY_IMPORT=1` 强制旧路径做对照。
4. **session 适配**：引擎错误对象 → 还原为现行 `lastImportErrors` 形态（severity/file/sheetRow/message/cells），`pending:error:export-report` 与 UI 弹窗**零改动**；进度事件由引擎 `{sourceFile, importedCount}`（每 1w 行）适配为现行 renderer payload 形态。

### 4.3 验收（PR-C）

- **parity 集成脚本** `scripts/integration/pending-engine-migration.js`（收单 acquiring-engine-migration.js 范式）：同 fixture 集双跑（legacy env vs 引擎），断言 `pending_rows` / `pending_months` 全表 dump byte-for-byte + 错误路径（文案/计数/cells/截断标志）逐字段一致。fixture 必含：多文件、跨文件重复行、表头错、空文件（仅表头）、小文件、错误超 1000 条截断。
- release-check 全绿；手测：大文件导入期间 UI 流畅（W4 属性不回退）、取消、覆盖重导后 diff_runs/removed_pending_rows 联动清理（R-1 人工复核项）。

---

## 五、块 C：biz-op 迁移引擎（PR-D）🔴

### 5.1 范围裁定：**只迁 flow（流水）侧**

- **flow 侧**（迁）：多文件 multiSelections（v3.0.2 需求1b）、单日量级大（历史曾撞 SheetJS 512MB 上限而催生流式 reader）、clear 语义简单（`clearRunsAndDiffsByDate(date)` + `clearByDate(date)` 2 条、参数=入参 date、**与行内容无关**）→ E1 即可表达；多文件并行收益真实。
- **bizOp（业务OP）侧**（默认不迁，OPEN-1）：单文件、几百-几千行/日、清理参数 `firstBu` 由**第一个数据行内容决定**（`import-worker.js:161-163`：clear(date,BU)+(D+1,BU)）、逐行 BU 一致校验 + `bu_name=firstBu` 改写 + `firstBuEmpty` 特例（仅报一条、不写报告、不校验后续行）——与引擎"参数先于解析"的覆盖模型及行级错误模型冲突，需 E6 + 跨键文案 hook 才能 byte 平移。**量级无痛点，扩展成本不成比例。**

### 5.2 迁移设计（flow）

1. 契约模块 `src/backend/biz-op-recon-import/contract-flow.js`：`expectedHeaders` = FLOW_HEADERS（28 列）；whitelist 实施时评估（流水入库列消费面待核，保守先 null + useWhitelist 对照）；`validateHeaders/validateFlowRow` 复用 validator 纯函数（mapRow 三态表达行级校验错误）；`monthKeyOf: () => null`；`deleteForOverwrite` = 2 条 clear SQL 平移（闭包 date）；`maxCollectedErrors: 1000` + `captureRowValues: true`（错误报告 `writeFlowErrorReportXlsx` 需 rawRow）；多文件"清一次后续累加"语义 = 引擎 overwrite 天然（事务头清一次）。
2. dispatch 走 §四共享模块 + 回退开关 `USE_BIG_TABLE_IMPORT_ENGINE_BIZOP_FLOW`（旧 import-worker 全保留；bizOp 侧继续走旧 worker 不动）。
3. 行内 date 与入参 date 的一致性校验语义（若存在）实施时核实并平移进 mapRow（标注：调研未见、待核）。

### 5.3 验收（PR-D）

- parity 集成脚本 `scripts/integration/bizop-flow-engine-migration.js`：legacy vs 引擎双跑，流水表 dump + 错误报告 xlsx 内容 + rejected 路径文案逐字段一致；fixture 含多文件合并、行级校验错、整批拒绝。
- release-check 全绿；bizOp 侧旧链路回归不动（既有集成脚本全绿即可）。

---

## 六、实施编排（PR 级）

| 任务块 | 内容 | 依赖 | 预估 |
|----|------|------|------|
| PR-A | 块 A：A1 预检（3 落点）+ A2 报错可见性（3 改点） | 无（A2 占 main.js 串行窗口） | 0.5-1 天 |
| PR-B | 引擎扩展包 E1-E5（E6 已裁剪，OPEN-1 拍板不迁 bizOp）+ 单测 + 🔴 收单回归锁 | 无（纯引擎目录，可并行） | 1-1.5 天 |
| PR-C | pending 契约 + 共享 dispatch + session 接线 + 回退开关 + parity 脚本 | PR-B | 1.5-2 天 |
| PR-D | biz-op flow 契约 + session 接线 + 回退开关 + parity 脚本 | PR-B（与 PR-C 可并行） | 1-1.5 天 |
| 块 D | recon-fixes：F1 取反（无 main.js，可并行）→ F3 对账ID列 → F2 目录互换（F3/F2 占 main.js 串行窗口，顺序见其 spec §8） | 无 | 0.5-1 天 |
| 块 E | BOC：数据层（无 main.js，可并行）→ 接线（main.js 串行窗口）→ 种子 → 引擎 | 数据层先行 | 1.5-2 天 |
| 块 F | payment：PR-1 地基（main.js 串行窗口）→ PR-2 引擎 → PR-3 UI | 块 D 终态 | 1.5-2 天 |
| 收尾 | 版本 bump 3.0.4 + 文档三件套（CHANGELOG / VERSION_FEATURE_HISTORY / USER_GUIDE）+ `npm run scan:vars` + `/check-vars` 硬节点 + release-check 全绿 | 全部块合入 | 0.5 天 |

> 集成形态：全部任务块按「一块一/多 commit」串到 `v3.0.4` 分支（commit 前缀 `[v3.0.4]`），最终**单 PR 合入 main**（沿 v3.0.3 PR #70 模式）；coding 由 dev agent 执行、team-lead 审 diff + 跑测试后才 commit。

每 PR 提交前软约束：对照 `rules/important-variables.md` 汇报「⚠️ 关联功能 review」；PR-A 涉及 renderer* → preview 回归。

---

## 七、🔴 风险段（人工复核点）

| # | 风险 | 等级 | 缓解 |
|---|------|------|------|
| R-1 | pending 覆盖删除 6 表顺序/范围错 → 对账数据污染（Codex PR #55 Finding 1 同款红线：removed_pending_rows 残留会让 reconcile 用陈旧归档错标核对结论） | 🔴🔴 | E1 逐字平移 6 条 SQL + 顺序；parity 脚本含「覆盖重导后关联表清空」断言；人工复核 deleteForOverwrite diff |
| R-2 | pending 去重/整批拒绝语义漂移（单条重复行=全量 ROLLBACK；文案 `发现重复行（hash …）` 逐字） | 🔴 | E5 写侧 Set + 按文件序单写保证确定性；parity 错误路径逐字段断言 |
| R-3 | upsertMonthMeta 脱出事务 → 崩溃中间态（有行无月元数据） | 🔴 | E2 finalizeForCommit 在 COMMIT 前事务内执行；单测断言中途失败月元数据不残留 |
| R-4 | 引擎扩展回归收单已迁链路 | 🔴 | 扩展全部契约可选 + 收单契约零改动 + acquiring-engine-migration.js 34 断言全绿为合并门 |
| R-5 | worker_threads 堆 vs 旧 child 8GB：dedupe Set 300w≈360MB + 写批缓冲 | 🟡 | dispatch `resourceLimits.maxOldGenerationSizeMb=4096` 显式设置；121w 实证档 + 合成 300w fixture 实测 RSS/heap 留档 |
| R-6 | 行为收紧 D1：旧 pending 硬编码 sheet1.xml（多 sheet 静默读第一个）→ 引擎 rels 正解多 sheet **报错** | 🟡 | 记为 intentional divergence（防静默读错表，方向正确）；fixture 验证报错文案可读；CHANGELOG 注明 |
| R-7 | biz-op flow 错误报告 rawRow / 1000 上限 parity | 🔴 | E4 captureRowValues + maxCollectedErrors=1000；报告 xlsx 对比断言 |
| R-8 | A1 预检误伤正常文件 | 🟡 | 仅"中央目录尺寸 ≥2^31"拦截；预检自身异常 fail-open；zip64/data-descriptor fixture 单测 |
| R-9 | pending 小文件同步兜底移除 → 引擎统一路径的 spawn 开销与 smoke 兼容 | 🟢 | worker 启动 ~百 ms 级可接受；smoke/集成全部走引擎路径过一遍即验证 |

---

## 八、OPEN 决策（✅ 全部拍板，2026-06-11，按建议执行）

- [x] **OPEN-1**：bizOp（业务OP）侧**不迁**引擎（按建议；E6 扩展整体裁剪，PR-D 范围 = flow 侧）。重启条件：bizOp 量级出现真实痛点时另立迭代。
- [x] **OPEN-2**：共享 dispatch 模块本迭代**不收编**收单（按建议；三方收敛留后续迭代）。
- [x] **OPEN-3**：A1 预检上限值 = **2^31 整（2147483648）**（按建议；精确对应崩点）。

---

## 九、变更记录

- 2026-06-11 立项草拟（来源：用户圈定"A + ①pending + ③biz-op 一起写 spec"；版本归属 v3.0.4 经确认）。
- 2026-06-11 用户拍板：①三 spec 合并为 v3.0.4 迭代（本 spec 升格六块入口，新增块 D/E/F 引用三子 spec）；②OPEN-1/2/3 按建议收口；③payment Q1-Q6 与 BOC O1-O4 全部拍板（回写各子 spec）；④流程 = PRD/TechDoc → dev agent coding（team-lead 不亲码）→ 单 PR → self-review → codex review → self-review → 无 P3+ finding 即 merge。
- 2026-06-11 用户追加需求并拍板并入本迭代：块 G Charge转outbound 多行取 Debit Amount 最大行（spec `changes/charge-outbound-max-debit/spec.md`，commit 9387655）——本 spec 升格七块入口。
