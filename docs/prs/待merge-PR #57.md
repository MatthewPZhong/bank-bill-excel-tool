# PR #57 — v2.1.12-beta.1：β 性能架构阶段（收单对账多 worker + bizOp 导入流式 + 收单导入 sax→手写）

> base: `main` ← head: `v2.1.12-beta`｜version: `2.1.12-alpha.1` → `2.1.12-beta.1`
> 状态：待 merge｜38 commit（main..HEAD）｜spec：`docs/iterations/v2.1.12/spec-beta.md`

## 0 一句话

v2.1.12 α（PR #56）之后的 **β 性能架构阶段**，三块互相独立的大文件/大计算量提速，全部 **🔴 资金红线 byte-for-byte 守恒**：

| 块 | 目标 | 实测收益 | 资金红线守法 |
|---|---|---|---|
| **β.1 收单对账多 worker** | 大数据量 JOIN 对账并行 | 50万行 plan-b **2.3–2.7x**（M=4，≥100万行才启用）| diff_rows 多 worker vs 单 worker **byte-for-byte 一致** |
| **β.2 bizOp 导入流式** | 百万行 xlsx 导入不 OOM/不卡 | SheetJS 撞 512MB→流式常数内存 | 五条资金红线（整批拒绝/原子替换/失败报告/bu改写/跨BU清）worker 内全保住 |
| **收单导入 sax→手写** | 收单导入解析提速 | **端到端 5.6x（122s→22s/50万）** | 新旧 reader 全行 **SHA1 完全一致**（含金额/币种/raw_json） |

质量门：`npm run release-check` 全绿（**unit 1473 / integration 952 / smoke 全过**）。

---

## 1 β.1 — 收单对账 multi-worker（commits f708842…231bb0e + POC b6f7e57/7fc0ae8）

**问题**：`acquiringBillCurrency` 对账 stage 4' 是 `INSERT INTO diff_rows SELECT … JOIN …`，500万行单 worker 慢；多 worker 并行直接跑会撞 SQLite WAL single-writer → SQLITE_BUSY。

**方案（POC 实测拍板 plan-b · D30）**：主进程按 OFFSET/LIMIT 拆 N chunk → M worker 并行 `SELECT JOIN`（只读，WAL 下并发不冲突）→ 各 worker 写**自己的 temp db** → 主进程按 **chunkIndex 升序 ATTACH 汇总 INSERT**（byte-for-byte 顺序不变量）。

- **POC GO**（spec §5.1）：50万行 plan-b 2.31–2.70x（M=4，chunk 数 >> worker 数为前提）；byte-for-byte 全档 0 差异；无 SQLITE_BUSY；峰值 RSS 实测。
- **决策**：D29（默认 worker 2 / 上限 4 / `cpus-2`）· D30（plan-b）· D31（**<100万行 或 chunk 数<worker 数 → 回退单 worker**）· D32（每模块独立 pool）· D33（settings 默认 2、`freemem<2GB`→1 OOM 降级）· D34（流式进度）· **D-β-1（resume 断点续跑 → 回退单 worker**，只服务全新 run）。
- **自适应分片**：多 worker 路径目标 chunk 数 ≈ 4×worker（下界 2000），喂饱 worker。
- **settings**：新增 `acquiring_bill_worker_count`（默认 2 / 范围 1-8 / 幂等 migration seed）。
- **测试**：byte-for-byte contract 20 例（repository 级跨 chunk 边界/非整除/单 chunk/0diff/空表 + 三方一致 + 🔴失败保守不留半套数据；runCheckCore 级 M=2 vs 单 worker 逐行 + 回退 + default 零变化）+ 嵌套 worker 拓扑集成测试（main→dispatch worker→nested M worker byte-for-byte）。
- 🔴 **资金红线**：diff_rows 多 worker 与单 worker 内容/顺序完全一致；失败时仅清本 run 的 diff（不留半套数据）。**合并门槛：500万真实数据手测**（见 §5）。

## 2 β.2 — bizOp 导入流式 + worker（commits 6417385…5577a5a）

**问题**：`biz-op-recon-import/reader.js` 用 SheetJS `XLSX.readFile` 全量进内存，百万行 xlsx 撞 V8 512MB 单字符串上限静默返回空。

**方案（仿 pending/VCC 成熟范式）**：
- 新增流式 reader `reader-streamed.js`（JSZip + SAX 扫 `<row>`，复用 `streaming-xlsx-reader` 的 `parseRowXml`/`readSharedStrings`），镜像 SheetJS reader 语义（真实 `<row r>` 行号 / `isRowMeaningful` / 表头校验 / 列多检测）。
- 导入移入 child-process worker `import-worker.js`（Electron `utilityProcess.fork` / Node `spawn` fallback），边流式读边分批 INSERT（不堆百万行数组）。
- IPC `bizOpRecon:import:run-biz-op/run-flow` 改调 worker 化入口（传 `dbPath=database.dbPath` 与 acquiring worker 同库 WAL 并发）；`onProgress` 透传 renderer `bizOpRecon:import:progress`；无 dbPath 回退旧同步。
- 🔴 **worker 内五条资金红线**：① 整批拒绝（errorRows 非空 → ROLLBACK 不入任何行）② (date,BU)+D+1 替换原子事务 ③ `bu_name=firstBu` 改写 ④ 失败报告 xlsx（worker emit errorRows → 主进程写盘）⑤ flow 跨 BU 清（`clearRunsAndDiffsByDate` 全 BU）。
- **测试**：reader contract 11 例（与 SheetJS byte-level 等价）+ worker contract 10 例（worker vs 旧同步同输出：成功行数/firstBu/落库内容/拒绝 errorRows/DB 0 行/🔴D+1 同清/🔴flow 跨 BU 清/bu_name 改写/表头不匹配）。
- **合并门槛：真实大文件手测**（见 §5）。

## 3 收单导入 — sax→手写字节扫描（commits b6e7418…0ed5ee6，本轮）

**问题**：用户实测收单**导入**慢。profile POC 定位：导入 50万行 122s，**解析占 ~90%**（sax 库逐 cell ~7 次事件回调 ≈ 1.68 亿次），insert+raw_json 仅 ~6%（早期误判方向已纠正）。

**make-or-break POC**：同一真实 fixture 上 sax 库 vs 手写字节扫描——
- **纯解析 sax→手写 8.7x(50万)/9.1x(100万)**（A/C 同用 yauzl 解压，唯一变量 sax↔手写）。
- **JSZip 在 100万行(~3.8GB 解压 entry)崩** `uncompressed data size mismatch`，yauzl 同文件 OK → **最优架构 = yauzl(保留)+手写扫描**，**不引入 JSZip**。

**实现**：新建 `reader-handrolled.js`（yauzl 解压 + sharedStrings 走 sax 复用 + sheet 扫描换手写）。reader.js 纯追加导出 helper（零函数体改动，作基线+一行回滚）。生产路径 `acquiring-bill-currency-session.js:16` 单行 require 切换。
- 🔴🔴 **数字 cell 取值逐字对齐 sax**：取 `<v>` 原始文本（仅实体解码），**绝不 `parseFloat→String`**（否则 `"1000.00"`→`"1000"` 丢小数改写金额）。**未复用** pending 的 `parseRowXml`（它有 parseFloat），改写专用 `parseAcquiringRowXml`。
- **实测端到端 5.6x**：122s→22s(50万) / ~250s→45s(100万) / 500万外推 ~20min→~3.8min；内存更低。
- 🔴 **双层资金闸**：① contract test 18 例（含 sharedStrings `t="s"` 路径 + number cell + 稀疏行 + 中文实体 + 表头列少/多/错 + peek，sax vs 手写全等）；② **真实规模 scalediff**：50万/100万行**全行 SHA1 + importedCount + monthKey 完全一致**（`scripts/poc/v2.1.12-acquiring-import-parser-compare.js scalediff`）。

---

## 4 ⚠️ 关联功能 review（`/check-vars --since main`）

命中 `rules/important-variables.md`：**Critical 4 / Important-skeleton 6 / Runtime-state 2 / Risk-sensitive 6**（Critical+Risk-sensitive → 已跑 smoke 全绿）。

| 层 | 命中 | 自查结论 |
|---|---|---|
| **Critical** | `runCheckCore` | β.1 加 workerCount/dbPath/tempDir 入参 + stage4' 三路 gate；default=1 时现有调用零行为变化（contract GroupB 锁）|
| | `runBizOpImportAsync`/`runFlowImportAsync` | β.2 保留作 contract 基线 + 无 dbPath 回退路径；worker 路径 contract 锁与旧同步同输出 |
| | `FileValidationError` | reader-handrolled 复用同一个类（自 reader.js 导入）→ 上层 instanceof/错误处理不变 |
| **Important-skeleton** | `FLOW_HEADERS`/`BIZ_OP_HEADERS` | 列定义未改，新 reader 复用同一 columns 常量 |
| | `normalizeCell`/`normalizeBu`/`serializeError`/`settingsRepository` | β.1/β.2 复用，未改语义；settings 仅新增 worker_count 项 |
| **Runtime-state** | `app`/`dialog` | main.js 仅新增 run handler 注入 workerCount/tempDir，未动全局生命周期 |
| **Risk-sensitive** | `validateBizOpRow`/`validateFlowRow`/`isRowMeaningful` | β.2 worker 内复用同校验，contract 锁拒绝语义一致 |
| | `clearRunsAndDiffsByDate`/`clearRunsAndDiffsByDateBu`/`addOneDay` | β.2 (date,BU)+D+1 原子替换语义未改，worker 内同事务执行，contract 覆盖 D+1 同清/跨 BU 清 |

## 5 🔴 合并门槛与手测状态

- ✅ **自动化全绿**：`npm run release-check`（unit 1473 / integration 952 / smoke 全过，含 acquiring 203 / progress 34 / pragma 27）。
- ✅ **合成数据 byte-for-byte**：β.1 contract 20 + 嵌套拓扑；β.2 reader 11 + worker 10；收单导入 contract 18 + **真实规模 SHA1（50万/100万行）完全一致**。
- ⚠️ **真实清结算数据手测**：合成 fixture 已充分证 byte-for-byte，但真实文件可能有畸形 XML 等边角，**由用户用真实大文件把关三块**（提 PR 即用户确认触发）。reviewer 重点抽查：① 收单对账 ≥100万行多 worker 结果与单 worker 一致；② bizOp 真实大文件导入五条红线；③ 收单导入入库金额/币种抽样对原文件。

## 6 回滚

- 收单导入：`acquiring-bill-currency-session.js:16` 改回 `require('.../reader')` 一行恢复 sax。
- β.2 bizOp 导入：无 dbPath 自动回退旧同步路径。
- β.1 多 worker：settings `acquiring_bill_worker_count=1` 即全程单 worker。

## 7 文档

- `CHANGELOG.md` / `docs/VERSION_FEATURE_HISTORY.md` / `docs/USER_GUIDE.md` 同步 v2.1.12-beta.1。
- spec：`docs/iterations/v2.1.12/spec-beta.md`（§4 决策 / §5 POC GO / §9 β.2 重定向 / §10 收单导入提速 / **§11 self-review**）。

## 8 Self-review（用户真实数据手测通过后 · 对抗式审查 + 修复 · spec §11）

对抗式审查（probe 找测试盲区 + 逐处验代码）发现并**已修复 + 补回归测试**：

- 🔴 **β.1 Critical ×2**（commit `b320fa0`）：**C1** 固定 tempDir 跨 run 复用，崩溃残留 `part-N.sqlite` 被追加 → diff_rows 重复 → 修：writeChunkToTemp 写前 unlink。**C2** MW 崩/cancel mid-merge（不经 catch）留半套 + chunk_progress 恒 -1 → resume 单 worker 从 0 不清 → diff_rows 翻倍 → 修：resumeFromChunkIndex===0 时先 `clearDiffRowsByRunId`。各补回归测试（#10 / B4）。
- 🟡 **β.2 Important ×3**（commit `f921439`）：**I1** 中途 DB 写错被误判 header → 改 insertFatal 标志 + fatal；**I2** 失败报告静默截断 → rowErrorTotal/truncated 透传 + 报告标注；**I3** emit 后立即 exit 大包截断 → emitAndExit 刷盘后退 + 单发守卫。各补回归测试（import-worker-contract 13/13）。
- ⏸️ **Defer**：I4（worker 写事务锁窗口放大→并发 SQLITE_BUSY，架构性）→ β.2-T3 + 中间确认 renderer 禁并发导入；3 个 Minor（MW 无 cancelToken / chunk 无超时 / utilityProcess 无 error 兜底）随后续。
- 🟢 收单导入块 self-review **clean**（contract 18 + scalediff 已充分覆盖）。
- 验收：修复后全量 `release-check` exit 0（**unit 1473/1473** + integration 952/952 + smoke biz-op154/acquiring203）。

## 9 PR review 评论处理（reviewer @MatthewPZhong + Codex bot）

- **Codex P1**（`run-check-multiworker-worker.js` clear stale temp）：= self-review C1，**已在 `b320fa0` 修**（Codex 审的是 self-review 前的 `9d1ff32`）。
- **P2 MW 路径未接 cancelToken**（大文件 run 取消违反手册 `<5s`）：✅ 修——`cancelToken` 透传 session→`insertDiffRowsByJoinMultiWorker`→`runWriteSplitChunks`，workerLoop 每 chunk 间 check（与单 worker 同语义）→ 停派发 + abort（CancelError）→ 不汇总（无 diff_rows 写入）+ temp 清理。回归测试 `run-check-multiworker #11`（运行中取消 → CancelError + 0 行 + 不泄漏）。
- **P2 package-lock 未同步**：✅ 修——`package-lock.json` 版本 `2.1.12-alpha.1` → `2.1.12-beta.1`（仅版本字段，无依赖变动）。
- **P3 文档 release-check 计数不一致**：✅ 修——CHANGELOG / VERSION_FEATURE_HISTORY / 本草稿统一最终 **unit 1473**。
- 验收：最终全量 `release-check` exit 0（**unit 1473/1473** + integration 952/952 + smoke）。
