# PRD - 网银账单生成小助手 v3.0.9（工具箱「按字段值拆分」支持 800MB / 700 万行多 sheet 大文件 · 隔离 worker 化大文件通道）

| 项 | 值 |
|---|---|
| 版本 | v3.0.9 |
| 状态 | 初稿（待评审） |
| 模块 | 工具箱🧰（拆分表格 / 按字段值拆分）· 大文件流式读写 · worker_threads 隔离通道 |
| 实施方式 | ≥1 周项目 → team-lead 不亲自小步写，按项目惯例 **PM PRD → spec（`/propose`）→ 拆 Phase 1 子任务委托 dev agent 分批实施**，team-lead 审 diff + `release-check` 兜底（`feedback_delegate_dev_agent` / `feedback_background_agent_unreliable`） |
| 质量门 | `npm run release-check` 全绿（unit + integration + smoke）；🔴 隔离铁律 + 前端零改动铁律 + 小文件路径零回归须 team-lead 人工复核 + `/check-vars` |
| 依赖 | 当前已切 `v3.0.9` 开发分支（`git branch --show-current = v3.0.9`）；本 PRD 落地时 `package.json.version` 仍为 `3.0.8`，**bump 3.0.9 由实施阶段执行，本文档阶段不 bump**。仅本迭代单需求，无并入 spec。 |

> **来源事实源（唯一 truth）**：
> 1. 已批准 plan：`/Users/pzhong/.claude/plans/snuggly-brewing-ocean.md`（立项评估：工具箱「按字段值拆分」支持大文件 —— 整体方案、3 硬问题解法、6 个新模块清单、路由、分期、风险、验证）。
> 2. 复用点现状由 PM 当面 grep 核实（见 §三 代码现状的 file:line，**出处优先、非照抄 plan 行号**）。
>
> 本 PRD 是把 plan 落成项目规范文档，**不偏离 plan 的设计决策**；所有 scope / 硬约束 / 硬问题解法原样转述。配套实现侧事实源见 `docs/iterations/v3.0.9/TECHDOC.md`。

---

## 一、需求概述

v3.0.9 集中处理 **1 项**核心需求（无并入 spec）：

1. **工具箱「按字段值拆分」支持 800MB / 700 万行多 sheet 大文件** —— 现工具箱「拆分表格」处理不了 800MB / ~700 万行的多 sheet xlsx（PR #78 收尾时用户提问暴露）。新建**一条隔离的、worker 化的、内存有界的工具箱大文件拆分通道**，复用已有 yauzl 流式原语（`big-table-import/` 的 `zip-reader.js` / `row-scanner.js`），对现有导入链路与小文件路径零影响，**且前端零改动**。

---

## 二、背景与目标

### 2.1 背景

| 需求 | 为什么要做 | 用户 / 业务价值 | 当前问题 |
|------|-----------|----------------|----------|
| 1 大文件按字段拆分 | 工具箱「按字段值拆分」是用户**经常用的核心刚需**（按渠道 / 币种 / 商户 / 状态等维度从一张大表里抽子集），但现实现撑不住 800MB / ~700 万行的多 sheet xlsx，对这类文件直接 OOM 闪退或读错 sheet。 | 大文件也能一键按字段值拆分，内存恒定不闪退，多 sheet 文件读对，跑得动数百万行。 | 现工具箱拆分对 800MB 多 sheet 文件三道硬墙撞死（见下「三道墙」），主进程同步跑数分钟还卡 UI。 |

**三道硬墙（现状基线，详见 §三 代码现状）**：

1. **2³¹ 解压上限 + 自身 OOM**：工具箱 `.xlsx` 现走 `toolbox-stream-io.js` 的流式读，内部 `canStreamXlsx`（`toolbox-stream-io.js:108`）= 「`.xlsx` **且物理单 sheet**」才流式；多 sheet 落回 `readRows`（SheetJS 全量解压）→ 800MB / 700 万行必 OOM。即便强行走单 sheet 流式路径，700 万行解压后 sheet1.xml 远超 2³¹（基于 JSZip 的旧链路 2.147GB/entry 即崩）。
2. **多 sheet**：700 万行必跨 ≥7 个 sheet（Excel 单 sheet 硬上限 1,048,576 行）；现流式只读物理 `xl/worksheets/sheet1.xml`（`streaming-xlsx-reader.js`），F1 护栏（v3.0.8 §12.7）对多 sheet 直接回退全量 `readRows` → 800MB 必 OOM。
3. **拆分第一步去重值累加器无界**：`toolbox.js createValuesByFieldAccumulator`（`toolbox.js:186`）给每列收集**全部**去重值，高基数列 700 万行 → GB 级常驻 + 百万选项下拉不可用。
4. （附带）工具箱在主进程同步跑，700 万行要数分钟 → 卡死 UI（worker 化解决）。

### 2.2 目标（必做）

- **建一条隔离的工具箱大文件拆分通道**：放 `src/backend/toolbox-xlsx-stream/`（纯 Node、worker 安全）+ 主侧 dispatch/router 放 `src/main-process/`；复用已有 yauzl 流式原语（`zip-reader.js openZipWithEntries/locateSheets/loadSharedStrings`、`row-scanner.js scanSheetRows`），**绝不 import/改 `streaming-xlsx-reader.js`**（隔离资金红线）。
- **worker 化**：单文件单作业 → 单 worker（`large-split-worker.js` + `toolbox-large-split-dispatch.js`），照搬 `engine-worker-entry.js` / `big-table-import-dispatch.js` 范式（`resourceLimits.maxOldGenerationSizeMb=4096`），把数分钟的扫描从主进程移走、UI 不卡。
- **内存有界**：split:read 全表扫喂**有界去重累加器**（每列封顶 `N=1000`、到顶丢 Set、全局 `maxTotalDistinct` 兜底）；split:export 命中行流式喂 `writeRowsStreamed`（超 104 万行自动分 sheet）。主/worker 内存峰值恒定、不随行数线性涨。
- **多 sheet 续页**：把多个物理 sheet 当一张逻辑表读（表头 = 第一个非空 sheet 首个有意义行；后续 sheet 首行归一化全等表头 → 跳过、否则当数据；列序冲突报错）。
- **路由 fail-closed**：`shouldUseLargeChannel` 只用 `collectEntrySizes` 判定（不解压、不读文件体）；多 sheet 或单 worksheet 解压 ≥1.5GB → 大通道；否则回普通通道（小文件路径一行不改、行为不变）。
- **🚩 前端零改动**：不动 `renderer*.js` / `preload.js`、不重跑 preview；回传契约 `valuesByField = {field: string[]}` 与现状逐字节一致。
- **收尾**：版本 bump 3.0.9 + 文档三件套（CHANGELOG / VERSION_FEATURE_HISTORY / USER_GUIDE）+ `npm run scan:vars`（bump 前）+ `/check-vars`（提 PR / 合并前硬节点）+ `npm run release-check` 全绿。

### 2.3 明确不做（非目标）

- **不做机械等分拆分**（用户拍板 scope = **按字段值拆分**，非按行数均分）。
- **不碰前端**：`renderer-dialogs.js`（`createSplitFieldPickerDialog`）/ `renderer-previews.js` / `preload.js` 一律不动（用户拍板）；**不重跑 preview**。高基数列退化为「下拉只显示前 N 个值」靠后端封顶实现，前端无感（代价见 §2.4 已知限制 OPEN-1）。
- **🔴 绝不 import/改 `streaming-xlsx-reader.js`**（银行 / Pending / 链接表导入复用，触它要全回归资金红线）。新通道只复用 `big-table-import/` 的 yauzl 原语。
- **不整体复用大表导入引擎**（`big-table-import` engine/pipeline 的 schema 强耦合、rowid 契约、多文件并行不需要）—— 只复用其底层 zip/scan 原语 + worker 范式。
- **sharedStrings 不做 spill-to-disk**（v1 接受全量 + 护栏；spill 会击穿 `row-scanner` 性能核心，留 v2 评估，见 §2.4 OPEN-2）。
- **不做用户级 cancel 按钮 / 进度条 UI**（前端零改动；进度走后端 activity log 不加 UI；worker 内部 cancel 能力保留作进程退出兜底，无前端触发入口，见 §2.4 OPEN-3）。
- **不改合并表格（merge）/ 小文件拆分链路**（本迭代只接管「大文件 + 按字段拆分」；merge 与小文件 split 仍走现有 `toolbox-stream-io.js` 通道，行为不变）。

### 2.4 已知限制（前端零改动的代价，列为 OPEN 待用户确认可接受）

> 前端零改动是用户拍板的硬约束。它带来以下已知限制，PRD 显式列出待用户确认可接受（见 §十 OPEN-1 / OPEN-2 / OPEN-3）。

- **OPEN-1 高基数列下拉只显示前 N=1000 个值**：有界累加器对去重值 >N 的列封顶到前 N 个（首现序），回传 `string[]` 仍是 ≤N 个值。后果：用户**无法按超出前 N 的值拆分**，且**下拉无截断提示**（现有 checkbox 浮动勾选面板无手动输入入口，加提示需改前端 = 违反零改动铁律）。**影响评估**：按字段拆通常用**低基数维度**（渠道 / 币种 / 商户 / 状态，去重值远 <1000），影响有限；高基数列（订单号 / 流水号 / 时间戳级唯一值）本就不适合做拆分维度。
- **OPEN-2 sharedStrings 悲观 1GB+ 情形 v1 不支持**：v1 sharedStrings 全量驻内存 + 护栏（`uncompressedSize` 超阈值可解释拒绝、worker `heapUsed` 监控）；极高基数全唯一长文本文件（sharedStrings 解压 >~1.2GB）v1 用「可解释拒绝」兜底而非崩溃，spill-to-disk 留 v2 评估。
- **OPEN-3 Phase 2 进度走后端 log、无 UI**：前端零改动 → 不加进度条 / cancel 按钮；进度仅可走 activity log（运维可见），用户侧无进度反馈。

---

## 三、代码现状（必须有出处）

> 以下 file:line 由 PM 当面 grep 核实当前 `v3.0.9` 分支工作树（出处优先，非照抄 plan 行号）。

| 主题 | 相关文件 | 当前行为 | 已知限制 |
|------|---------|---------|---------|
| 工具箱 split 现路径 | `src/main.js:12947` `toolbox:split:read` / `:12981` `toolbox:split:export`（`registerToolboxHandlers`:12871 注册）；handler 用 `toolboxIsStreamableXlsx`（= `isStreamableXlsx`，仅判扩展名）分叉，`.xlsx` 走 `toolboxStreamDataRows` / `toolboxReadHeaderRowStreamed`，否则 `extractHeaders`+`readRows` | split:read 回传 `{ status:'success', sourceFilePath, headers, valuesByField }`；split:export 入参 `{ sourceFilePath, field, values[] }` → 过滤 → 写临时 → 另存为 | 仅扩展名分叉，不判文件大小 / sheet 数 |
| 流式读「物理单 sheet」护栏 | `src/main-process/toolbox-stream-io.js:108` `canStreamXlsx`（= `isStreamableXlsx` 且 `isPhysicallySingleSheetXlsx`:97）；`streamDataRows`(:154) / `readHeaderRowStreamed`(:177) 内部以 `await canStreamXlsx` 收口 | `.xlsx` **物理单 sheet** 才走自研 `readXlsxStreamed`（内存恒定，硬编码读 `xl/worksheets/sheet1.xml`）；**多 sheet 落回 `readRows`（SheetJS 全量）** | 🔴 **多 sheet 大文件落回 `readRows` → 800MB 全量解压必 OOM**（v3.0.9 痛点根因） |
| 去重值累加器无界 | `src/main-process/toolbox.js:186` `createValuesByFieldAccumulator(headers)` → `{addRow, result}`；`:109` `computeValuesByField`（全量版） | 每列 `Set` 收集**全部**去重值（首现序），`result()` 回 `{field: string[]}` | 🔴 高基数列 700 万行 → GB 级常驻 + 百万选项下拉不可用（无封顶） |
| 行过滤 / 文件名 | `src/main-process/toolbox.js:228` `createRowFilter(normalizedHeaders, field, values)` → `{fieldFound, test}`；`:256` `buildSplitFileName(values, sanitizeFileName, date)` | 按字段值过滤行（多选值 → 单文件）；拆分文件名 `拆分-{值拼接 sanitize}-{时间戳}.xlsx` | 复用，新通道直接调用 |
| 流式写（已就绪） | `src/main-process/toolbox-stream-io.js:348` `writeRowsStreamed({savePath, normalizedHeaders, sheetBaseName, writeDataRows, formatters, maxRowsPerSheet})`；`:67` `MAX_DATA_ROWS_PER_SHEET=1048575` | `ExcelJS.stream.xlsx.WorkbookWriter` 逐行 `addRow().commit()`，超 `maxRowsPerSheet` 自动开 sub-sheet (2)(3)；by-name 格式与 `writeWorkbookRows` 同源 | 复用，命中行 >104 万自动分 sheet 已就绪 |
| yauzl 流式原语（复用核心） | `src/backend/big-table-import/zip-reader.js:61` `openZipWithEntries`（autoClose:false）/ `:111` `locateSheets`（正解 `workbook.xml <sheet r:id>` → rels → 物理 sheetN.xml，**按显示序**返回 `[{name, entryPath}]`）/ `:212` `loadSharedStrings`（sax 流式 → `string[]`）/ `:154` `openWorkbook`（≥2 sheet 即 `throw BigTableImportError`，:163） | 绕开 2³¹ 的 yauzl 流式解压；多 sheet 顺序映射已正解 | `openWorkbook`(:154) 对 ≥2 sheet 显式拒绝 → 新通道**不走 `openWorkbook`**，直接 `openZipWithEntries`+`locateSheets` |
| 逐字节扫行（复用核心） | `src/backend/big-table-import/row-scanner.js:427` `scanSheetRows({stream, expectedHeaders, sharedStrings, onRow, valueColumnWhitelist})`；`onRow({rowR, values, hasAnyCellText})`；`onRow` 抛 `{__stopParsing:true, __stopValue}`(:424/:458/:472) → destroy stream 早退 | 边解压边逐字节扫行，恒定内存，能读解压后 >2GB 的 sheet | 复用，cancel 靠 `__stopParsing` |
| 尺寸预检（路由用） | `src/backend/pending-import/xlsx-size-preflight.js:45` `collectEntrySizes(filePath)`（yauzl 读中央目录、`lazyEntries:false`、**不 openReadStream / 不读文件体**）→ `Map<fileName, uncompressedSize>`（sharedStrings + 全部 worksheet entry） | 不解压拿到全部 worksheet 解压尺寸 + 数量 | 路由判定的安全依据（不会自身 OOM） |
| 🔴 禁用的 meta 探针 | `src/backend/file-service/readers.js:352` `readXlsxSheetMetaLite(filePath)` → `fs.promises.readFile(filePath)` 全读整文件 buffer → `JSZip.loadAsync(buffer)` | 解析 `workbook.xml` 取 sheet 名顺序 + 数 worksheet entry | 🔴 **注释自称「不 OOM」仅对 65 万行（压缩 buffer 小）成立；对 800MB 压缩文件「读整 buffer + JSZip 解析」仍 OOM** → 路由**禁用它**，改用 `collectEntrySizes`（plan 关键发现） |
| worker 范式（照搬） | `src/backend/big-table-import/engine-worker-entry.js`（`parentPort.on('message')`:60 收 run/cancel；postMessage `progress`:91 / `log`:94 / `done`:98 / `error`:100；`cancelToken`:96）+ `src/main-process/big-table-import-dispatch.js`（`new Worker`:52 / `resourceLimits`:41-52 / `jobId`:57 / `terminate`:63 / `deserializeError`:100 / `.on('exit')`:106 兜底） | worker 薄壳协议 + dispatch + 错误还原 + 退出兜底 | 单 worker（单文件单作业）即可，无需 pipeline 多文件并行 |
| 既有大文件流式集成测试 | `scripts/integration/toolbox-large-file-stream.js`（v3.0.8 BUG3，30 万行级 merge/split 不 OOM） | 复刻 handler「流式读源 → toolbox 纯逻辑 → 流式写 → readback」整链路，**单 sheet** 30 万行验内存/正确性 | 未覆盖**多 sheet + 700 万行**；v3.0.9 新集成脚本须补这两维度 |

---

## 四、术语

| 术语 | 含义 |
|------|------|
| 大文件拆分通道（大通道） | v3.0.9 新建的隔离 worker 化通道，处理「多 sheet 或单 worksheet 解压 ≥1.5GB」的 `.xlsx` 按字段值拆分；与现有小文件通道（`toolbox-stream-io.js`）物理隔离 |
| 小文件通道（普通通道） | 现有 `toolbox-stream-io.js` 路径（`.csv`/`.xls`/单 sheet 小 `.xlsx`）；本迭代**一行不改、行为不变** |
| `shouldUseLargeChannel(filePath)` | 路由谓词（`main-process/toolbox-large-split-router.js`）：只用 `collectEntrySizes` 判定，命中大文件条件 → 走大通道，否则 fail-closed 回普通通道 |
| 大文件条件 | `.xlsx` 且（worksheet 数 ≥2 **或** 单 worksheet 解压尺寸 ≥ 1.5GB`(1610612736)`） |
| fail-closed（回普通通道） | `.csv`/`.xls`、单 sheet 小文件、preflight 异常 → 一律回普通通道（保小文件零回归） |
| 逻辑表（多 sheet 续页） | 把一个 `.xlsx` 的多个物理 sheet（按 `locateSheets` 显示序）拼成一张逻辑表读：表头 = 第一个非空 sheet 首个有意义行；后续 sheet 首行归一化全等表头 → 跳过（重复表头），否则当数据行 |
| 有界去重累加器 | `bounded-values-accumulator.js`：每列 `Set` 封顶 `N=1000`（到顶丢弃该列 Set，内存恒 O(N)）+ 全局 `maxTotalDistinct=200000` 兜底；**回传 `string[]`（≤N 个、首现序）与现状契约逐字节一致，不暴露截断元数据** |
| scanFields（split:read 第一步） | 大通道：worker 全表扫 → 有界累加器 → 回传 `{headers, valuesByField}` |
| exportFilter（split:export 第二步） | 大通道：worker peek 表头 + `createRowFilter` + 命中行喂 `writeRowsStreamed` 写临时 xlsx → 主侧另存为 |
| sharedStrings 护栏 | v1 接受全量驻内存；解析前读 `sharedStrings.xml uncompressedSize` 超阈值（~1.2GB）→ 可解释拒绝（`failed` 文案）；worker 内 `heapUsed` 超 ~3GB 主动抛可解释错误 |
| 🚩 前端零改动铁律 | 不动 `renderer*.js`/`preload.js`、不重跑 preview；回传 `valuesByField={field:string[]}` 必须与现状逐字节一致（封顶只减少数组长度、不改结构） |
| 🔴 隔离铁律 | 新通道绝不 import/改 `streaming-xlsx-reader.js`（银行/Pending/链接表导入复用） |

---

## 五、功能详细描述

### 5.1 需求 1：工具箱「按字段值拆分」支持大文件（隔离 worker 化大文件通道）

#### 5.1.1 说明

- **输入**：用户在工具箱「拆分表格」点 `[导入文件]` → 单选 1 个 `.xlsx`（可能 800MB / ~700 万行 / 多 sheet）→ 选定字段 + 选定该字段若干值 → 导出。**前端交互一字不变**（沿用现 `createSplitFieldPickerDialog`）。
- **输出**：
  - split:read → `{ status:'success', sourceFilePath, headers, valuesByField }`，`valuesByField={field: string[]}`（每列 ≤N 个去重值，首现序）—— **与现状逐字节一致**。
  - split:export → `{ status:'success', filePath }`，子集 xlsx 含全部选中值的命中行（>104 万行自动分 sheet）。
- **边界条件**：
  - 路由 `shouldUseLargeChannel`=true（多 sheet 或单 worksheet ≥1.5GB）才走大通道；否则走现有小文件通道（行为不变）。
  - 多 sheet 续页：表头 = 第一个非空 sheet 首个有意义行；后续 sheet 首行归一化全等表头 → 跳过、否则当数据；列序与表头不一致 → `ToolboxHeaderMismatchError`（不按名重排）。
  - 高基数列：去重值 >N=1000 时下拉只显示前 N 个（OPEN-1）。
  - sharedStrings 解压 >~1.2GB → 可解释拒绝（OPEN-2）。
  - split:export 命中 0 行 → 不产文件（沿用现文案，与小文件通道一致）。
  - 临时大文件：split:export 写临时目录，`try/finally` 必须可靠清（含 worker crash 时 dispatch `exit` 兜底）—— 顺带修 backlog B20。

#### 5.1.2 影响范围

- **新建（6 个模块，纯后端）**：
  - `src/backend/toolbox-xlsx-stream/multi-sheet-reader.js`（核心多 sheet 逻辑表读）
  - `src/backend/toolbox-xlsx-stream/bounded-values-accumulator.js`（有界去重累加器）
  - `src/backend/toolbox-xlsx-stream/split-scan-fields.js`（split:read 第一步）
  - `src/backend/toolbox-xlsx-stream/split-export-filter.js`（split:export 第二步）
  - `src/backend/toolbox-xlsx-stream/large-split-worker.js`（worker_threads 入口）
  - `src/main-process/toolbox-large-split-dispatch.js`（主侧 dispatch）
  - `src/main-process/toolbox-large-split-router.js`（路由 `shouldUseLargeChannel`）
- **改既有文件（唯一）**：`src/main.js` —— `toolbox:split:read`(:12947) / `toolbox:split:export`(:12981) 各加 `await shouldUseLargeChannel()` 分叉 + try/finally 临时清理（**不动现有小文件分支**）。回传契约不变。
- **复用不改**：`zip-reader.js`、`row-scanner.js`、`toolbox-stream-io.js writeRowsStreamed`、`xlsx-size-preflight.js collectEntrySizes`、`toolbox.js createRowFilter/buildSplitFileName`、`engine-worker-entry.js`/`big-table-import-dispatch.js`（照搬范式）。
- **🚩 前端零改动**：`src/renderer-dialogs.js`、`src/renderer-previews.js`、`src/preload.js` **一律不动**；不重跑 preview。
- **🔴 严禁碰**：`src/backend/pending-import/streaming-xlsx-reader.js`（隔离铁律）。
- **对外接口影响**：无新 IPC（复用现有 `toolbox:split:read`/`toolbox:split:export`，回传契约不变）。
- **兼容性影响**：小文件 / merge 链路零影响；大文件从「OOM 闪退 / 读错 sheet」变为「能跑通、内存恒定」。

#### 5.1.3 交互与规则（权威细则）

**A. 路由分叉（`main.js` 两 handler，唯一改的既有文件）**：
- `toolbox:split:read`：`showOpenDialog`(单选) → `if (await shouldUseLargeChannel(sourceFilePath))` → 大通道 dispatch `scanFields` → 回传 `{headers, valuesByField}`；否则**保持现有分支不动**（`toolboxIsStreamableXlsx` → 流式 / `extractHeaders`+`readRows`）。
- `toolbox:split:export`：入参 `{sourceFilePath, field, values}` → `if (await shouldUseLargeChannel(sourceFilePath))` → 主侧 `mkdtempSync` → dispatch `exportFilter` → done → `copyFileSync`/另存为 → **`try/finally` 清临时目录**；否则保持现有分支不动。

**B. 路由 `shouldUseLargeChannel(filePath)`（`toolbox-large-split-router.js`）**：
- **只用 `collectEntrySizes`**（yauzl 读中央目录、不解压、不全读）拿到 worksheet 数量 + 各 worksheet 解压尺寸 + sharedStrings 尺寸。
- **🔴 禁用 `readXlsxSheetMetaLite`**（它 `fs.readFile` 全读 + `JSZip.loadAsync(整文件 buffer)`，对 800MB 自身就 OOM —— plan 关键发现）。
- 条件：`.xlsx` 且（worksheet 数 ≥2 **或** 单 worksheet 解压尺寸 ≥ 1.5GB`(1610612736)`）→ 返回 true（大通道）。
- `.csv`/`.xls`、单 sheet 小文件、`collectEntrySizes` 异常 → **fail-closed 返回 false**（回普通通道，小文件路径一行不改、行为不变）。

**C. split:read 数据流（scanFields）**：
- 主侧 dispatch `{ op:'scanFields', filePath }` → worker `streamLogicalTableRows(filePath, onDataRow, onHeaderRow)`：`locateSheets` 拿有序 sheet → 逐 sheet `openReadStream` + `scanSheetRows` 透传每行；sharedStrings 循环外 `loadSharedStrings` 加载一次。
- worker 喂**有界累加器**（每列封顶 N=1000）→ done 回传 `{headers, valuesByField}`（封顶后 ≤N 个、首现序）。
- 主侧把 worker 结果原样作为 handler 返回的 `valuesByField`（结构与现状一致）。

**D. split:export 数据流（exportFilter）**：
- 主侧 `mkdtempSync` → dispatch `{ op:'exportFilter', filePath, field, values, savePath }` → worker peek 表头 + `createRowFilter` → 命中行喂 `writeRowsStreamed`（命中超 1,048,575 自动分 sheet，已就绪）→ done 回 `{matchedCount}` → 主侧 `copyFileSync` 另存 → **`try/finally` 清临时目录**。

**E. 多 sheet 续页语义**：见 §五·5.1.4 与 TECHDOC §三硬问题③。

**F. cancel（worker 内部能力，v1 无前端触发）**：worker `cancelToken` + onRow 抛 `{__stopParsing:true}` → `scanSheetRows` 立即 destroy 当前 sheet stream；sheet 边界检查 token 停后续 sheet（<5s）。**v1 无前端 cancel 按钮**（前端零改动），仅作进程退出兜底（OPEN-3）。

#### 5.1.4 多 sheet 续页规则（权威，与 TECHDOC §三硬问题③逐字对齐）

| 情形 | 规则 |
|------|------|
| 表头来源 | 第一个**非空** sheet 的**首个有意义行**（按 `locateSheets` 显示序，非物理 sheetN.xml 编号序） |
| 后续 sheet 首行 = 表头 | 后续 sheet 首个有意义行与表头**归一化全等** → 跳过（视为重复表头分页） |
| 后续 sheet 首行 ≠ 表头 | 当数据行处理 |
| 列序冲突 | 列序与表头不一致 → 抛 `ToolboxHeaderMismatchError`（**不做按名重排**） |
| 空 sheet | 跳过（无有意义行） |
| 输出 >104 万行 | split:export 复用 `writeRowsStreamed` 自动分 sheet（已就绪） |
| ⚠️ 已知边界 | 数据行**恰等于**表头会被当重复表头跳过（测试显式记录、不视为 bug） |

#### 5.1.5 UI Mockup

> 🚩 前端零改动：UI 与 v3.0.8 完全一致，本节仅说明大文件路径在现有 UI 下的表现。

```
[工具箱弹框 → 拆分表格行 → 点 [导入文件] 选 800MB 多 sheet xlsx]
  ┌── 选择拆分字段 ─────────────────────────┐   ← 现有 createSplitFieldPickerDialog，零改动
  │ 字段：[单选下拉 = 表头列名 ▾]            │
  │ 值：  [浮动勾选面板 = 该字段去重值]      │   ← 高基数列只显示前 N=1000 个（OPEN-1，无截断提示）
  │                          [完成]          │
  └──────────────────────────────────────────┘
  （后台：worker 全表扫，主进程不卡；内存恒定）

[选完字段 → [导出文件] → 另存为 拆分-{值}-{时间戳}.xlsx]
  （后台：worker 流式过滤 + 写临时 → 另存；命中 >104 万行自动分 sheet）
```

---

## 六、验收标准

> 本章节共 **6 条** AC（对应 plan 验证章节）。

### 6.1 需求 1：大文件按字段拆分 AC

| AC 编号 | 验收条件 |
|---------|---------|
| AC1-1 | 单个**多 sheet** `.xlsx`（程序生成 700 万行级）能 split:read 列出各列去重值（每列 ≤N=1000、首现序）、split:export 出正确命中子集且产物可 readback 校验（行数 / 内容 / 命中数正确） |
| AC1-2 | 主进程 / worker 内存峰值**恒定**（RSS 不随行数线性涨、不 OOM）——集成脚本断言峰值有界 |
| AC1-3 | 🔴 **小文件路径零回归**：单 sheet 小文件 / `.csv` / `.xls` 仍走原通道（`shouldUseLargeChannel`=false）、行为不变；去重值 ≤N 时输出与现状逐字节一致 |
| AC1-4 | 🚩 **前端零改动**：`renderer-dialogs.js` / `renderer-previews.js` / `preload.js` 无 diff；preview 无需重跑；回传 `valuesByField={field:string[]}` 结构与现状逐字节一致 |
| AC1-5 | 🔴 **未碰 `streaming-xlsx-reader.js`**（隔离铁律）：`git diff` 该文件无改动；新通道不 import 它 |
| AC1-6 | `npm run release-check` 全绿（unit + integration + smoke）；`/check-vars` 无 Critical/Important/Risk-sensitive 行为未受控命中 |

---

## 七、手动测试清单

### 7.1 P0 必测场景

| 场景 | 输入 | 前置条件 | 预期结果 |
|------|------|----------|---------|
| 大文件多 sheet 按字段拆分端到端 | 程序生成 / 真实 800MB 级多 sheet `.xlsx` | 工具箱 → 拆分表格 → `[导入文件]` | split:read 列出各列去重值（高基数列前 N 个）、选字段 + 多选值 → `[导出文件]` → 子集 `拆分-{值}-{时间戳}.xlsx` 命中正确；**全程主进程不卡 UI、不闪退** |
| 内存恒定 | 同上，监控 RSS | — | 主 / worker 内存峰值恒定、不随行数线性涨、不 OOM |
| 小文件零回归 | 单 sheet 小 `.xlsx` / `.csv` | — | 仍走原通道、拆分行为与 v3.0.8 完全一致 |
| 临时文件清理 | 大文件 split:export 后 | — | 临时目录被清（含手动 kill worker 模拟 crash 后 dispatch exit 兜底也清） |

### 7.2 P1 应测场景

| 场景 | 输入 | 前置条件 | 预期结果 |
|------|------|----------|---------|
| 多 sheet 续页正确性 | 乱序多 sheet（workbook.xml `<sheet>` 序 ≠ 物理 sheetN.xml 编号）+ 后续 sheet 含重复表头 | — | 按显示序读对、重复表头跳过、数据不丢不重 |
| 列序冲突报错 | 某后续 sheet 列序与表头不一致 | — | 抛 `ToolboxHeaderMismatchError`、可解释失败文案、不静默错位 |
| sharedStrings 护栏 | sharedStrings 解压 >~1.2GB 的病态文件（如可构造） | — | 可解释拒绝（`failed` 文案）而非崩溃 |
| 高基数列 | 某列去重值 >1000 | — | 下拉只显示前 1000 个（首现序）、能按这些值拆分；超出值无法选（OPEN-1 已知限制） |

### 7.3 不测项与原因

- worker 内部 cancel：v1 无前端 cancel 按钮（前端零改动），不单独 GUI 手测用户级取消（OPEN-3）。
- Phase 2 spill-to-disk：v1 不实现（OPEN-2），不测。
- 前端 UI 视觉：前端零改动，不重跑 preview、不测视觉像素。

---

## 八、数据 / 状态 / 安全影响

| 类别 | 说明 |
|------|------|
| 数据结构变更 | 无新表 / 无新字段 / 无 migration / 无 DB 改动（纯文件读写 + worker）。 |
| 状态流转变更 | 新增主侧 worker 作业生命周期（dispatch → run → progress/log → done/error → terminate/exit 兜底），照搬 `big-table-import-dispatch.js` 范式；无 IPC 通道新增（复用现有 `toolbox:split:read`/`toolbox:split:export`）。 |
| 权限 / 安全 | 无鉴权变更。worker 仅读用户选中文件 + 写临时目录 + 另存为；临时大文件 `try/finally` 可靠清理（含 worker crash dispatch exit 兜底，修 B20）。`resourceLimits.maxOldGenerationSizeMb=4096` 限 worker 堆。 |
| 🔴 隔离铁律 | 新通道**绝不 import/改 `streaming-xlsx-reader.js`**（银行/Pending/链接表导入复用，触它要全回归资金红线）。只复用 `big-table-import/` 的 `zip-reader.js`/`row-scanner.js`（这两个已是大表导入专用、非资金对账读值热点）。AC1-5 锁。 |
| 🚩 前端零改动铁律 | 不动 `renderer*.js`/`preload.js`、不重跑 preview；回传 `valuesByField={field:string[]}` 逐字节一致（封顶只减数组长度、不改结构）。AC1-4 锁。代价见 §2.4 OPEN-1/2/3。 |
| 🔴 改 `toolbox.js` 否？ | 本迭代**新通道用新模块 `bounded-values-accumulator.js`**，**不改** `toolbox.js createValuesByFieldAccumulator`（小文件通道仍用现有无界累加器，去重值 ≤N 时本就等价）。若实施期决定让小文件通道也切到封顶语义（统一口径），则改 `toolbox.js` 属 `/check-vars` 硬节点，须「去重值 ≤N 时输出与现状逐字节一致」回归测试背书。**默认不改 toolbox.js**（见 TECHDOC §三硬问题①注）。 |
| 回滚策略 | 纯新增 6 模块 + main.js 两 handler 加分叉。回滚 = revert main.js 两 handler 的 `shouldUseLargeChannel` 分叉（自动全部回落现有小文件通道）+ 删 6 新模块；无 migration、无 DB、无前端、无 schema 需回退。 |

---

## 九、非功能性要求

| 类别 | 要求 |
|------|------|
| 向下兼容 | 小文件 / merge 链路零行为变化（路由 fail-closed 保证）；前端零改动（回传契约逐字节一致）；不碰 `streaming-xlsx-reader.js`（银行/Pending/链接表导入零影响）。 |
| 性能 | 大文件 split:read / split:export 主 + worker 内存峰值**恒定**（不随行数线性涨）；800MB / 700 万行能跑通不 OOM；扫描移到 worker → 主进程 UI 不卡。worker `resourceLimits.maxOldGenerationSizeMb=4096`。 |
| 鲁棒性 | 有界累加器封顶（每列 N=1000 + 全局 maxTotalDistinct=200000 兜底）防 OOM；sharedStrings 护栏（uncompressedSize 超阈值可解释拒绝 + worker heapUsed 监控）；列序冲突显式报错（不静默错位）；临时文件 try/finally + worker exit 兜底可靠清理；路由 fail-closed 保小文件零回归。 |

---

## 十、待澄清问题

- [ ] **OPEN-1（前端零改动代价）**：高基数列（去重值 >N=1000）下拉只显示前 N 个值、用户无法按超出前 N 的值拆分、且无截断提示（现有浮动勾选面板无手动输入入口，加提示需改前端 = 违反零改动铁律）。按字段拆通常用低基数维度（渠道/币种/商户/状态），影响有限。**待用户确认可接受**。
- [ ] **OPEN-2（sharedStrings 悲观情形）**：极高基数全唯一长文本文件（sharedStrings 解压 >~1.2GB）v1 用「可解释拒绝」兜底而非支持；spill-to-disk 留 v2 评估（spill 会击穿 row-scanner 性能核心）。**待用户确认 v1 拒绝可接受**。
- [ ] **OPEN-3（Phase 2 进度无 UI）**：前端零改动 → 进度走后端 activity log、无进度条 / cancel 按钮；用户侧无进度反馈。**待用户确认可接受**。
- [ ] N=1000 / maxTotalDistinct=200000 / 1.5GB 路由阈值 / sharedStrings 1.2GB 护栏阈值的具体取值（实施期可按真实数据微调；当前取 plan 建议值）。

---

## 十一、变更记录

| 日期 | 变更内容 |
|------|---------|
| 2026-06-18 | 初稿：依据已批准 plan `snuggly-brewing-ocean.md` 撰写 v3.0.9 PRD（12 章范式，6 条 AC），覆盖工具箱「按字段值拆分」大文件隔离 worker 化通道单需求。复用点 file:line 由 PM 当面 grep 核实（出处优先）。3 项前端零改动代价列为 OPEN-1/2/3 待用户确认。 |

---

## 十二、实施记录

> 由 PR merged + 归档后自动追加，PM 不需要手动填写。
