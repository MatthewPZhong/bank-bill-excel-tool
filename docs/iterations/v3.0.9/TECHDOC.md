# TechDoc - 网银账单生成小助手 v3.0.9（工具箱「按字段值拆分」大文件隔离 worker 化通道）

| 项目 | 内容 |
|------|------|
| 版本 | v3.0.9 |
| 日期 | 2026-06-18 |
| 作者 | PM（实现侧事实源；定稿后交 Dev 评审 / 实施） |
| 状态 | 初稿（待评审） |
| 关联 PRD | `docs/iterations/v3.0.9/PRD.md`（6 条 AC） |
| 实施方式 | ≥1 周项目 → team-lead 不亲自小步写：**PM PRD/TECHDOC → spec（`/propose`）→ 拆 Phase 1 子任务委托 dev agent 分批实施**，team-lead 审 diff + `release-check` 兜底（`feedback_delegate_dev_agent` / `feedback_background_agent_unreliable`） |
| 质量门 | `npm run release-check` 全绿（unit + integration + smoke）；🔴 隔离铁律 + 前端零改动铁律 + 小文件零回归须 team-lead 人工复核 + `/check-vars` |
| 依赖 | 当前已切 `v3.0.9` 分支；`package.json.version` 仍 `3.0.8`，bump 3.0.9 由实施阶段执行（本文档阶段不 bump） |

> **来源 plan（唯一事实源）**：`/Users/pzhong/.claude/plans/snuggly-brewing-ocean.md`（推荐架构 + 6 模块表 + 路由 + 3 硬问题解法 + 分期 + 风险 + 验证）。
>
> 本 TechDoc 以 plan 为设计事实源；**所有复用点的 file:line 由 PM 当面 grep 核实当前 `v3.0.9` 工作树（出处优先，非照抄 plan 行号）**。与 plan 的核实出入见 §十六 Open Technical Questions 末「核实记录」。

---

## 一、PRD 评审意见（技术角度）

### 1.1 可直接落地的部分

| PRD 要点 | 评审 |
|---------|------|
| §2.2 隔离 worker 化大文件通道 | 地基已存在：`big-table-import/zip-reader.js`（`openZipWithEntries`:61 / `locateSheets`:111 / `loadSharedStrings`:212）+ `row-scanner.js scanSheetRows`:427 已提供绕 2³¹ 的 yauzl 流式解压 + 多 sheet 顺序映射；worker 范式照搬 `engine-worker-entry.js` + `big-table-import-dispatch.js`，可行 |
| §5.1.3 路由只用 collectEntrySizes | `xlsx-size-preflight.js collectEntrySizes`:45（yauzl 读中央目录、`lazyEntries:false`、不 openReadStream）返回 `Map<fileName, uncompressedSize>`，足够判 worksheet 数 + 单 worksheet 解压尺寸；禁用 `readXlsxSheetMetaLite`（:352 全读 buffer + JSZip，对 800MB 自身 OOM）正确，可行 |
| §5.1.4 多 sheet 续页 | `locateSheets`:111 已正解 `workbook.xml <sheet r:id>`→rels→物理 sheetN.xml 按显示序返回 `[{name,entryPath}]`；不走 `openWorkbook`:154（它 ≥2 sheet 即 throw :163），直接 `openZipWithEntries`+`locateSheets`+逐 sheet `scanSheetRows`，可行 |
| §2.4 有界累加器（前端零改动） | 新模块 `bounded-values-accumulator.js` 封顶 N=1000 回 `string[]`，与现状 `toolbox.js:186 createValuesByFieldAccumulator` 的 `result()` 同结构；前端 `createSplitFieldPickerDialog` 一行不改，可行 |
| §5.1.3 流式写命中行 | 复用 `toolbox-stream-io.js writeRowsStreamed`:348（`{savePath, normalizedHeaders, sheetBaseName, writeDataRows, formatters, maxRowsPerSheet}`，超 `MAX_DATA_ROWS_PER_SHEET=1048575`:67 自动分 sheet）+ `toolbox.js createRowFilter`:228，可行 |

### 1.2 技术意见 / 风险提醒

| 编号 | 评审 | 处理 |
|------|------|------|
| R-1 | 🔴 **隔离铁律**：新通道绝不 import/改 `streaming-xlsx-reader.js`（银行/Pending/链接表导入复用，触它=全回归资金红线）。注意：现 `toolbox-stream-io.js:34` 已 require `streaming-xlsx-reader` 的 `readXlsxStreamed` —— **新通道不复用 `toolbox-stream-io.js` 的读路径**，只复用它的 `writeRowsStreamed`（写路径，不碰 streaming reader）。读全部走 `big-table-import/` 原语。 | 新模块只 require `big-table-import/zip-reader`+`row-scanner` + `toolbox-stream-io writeRowsStreamed`（写）+ `toolbox.js createRowFilter`；AC1-5 `git diff` 锁 streaming-xlsx-reader 无改动；见 §四模块依赖表 |
| R-2 | 🚩 **前端零改动铁律**：回传 `valuesByField={field:string[]}` 必须与现状逐字节一致（封顶只减数组长度、不改结构、**不暴露 truncated 元数据**）。worker→主侧→handler 返回链任一处加字段都破契约 | 有界累加器 `result()` 只回 `{field:string[]}`；`{truncated, distinctSeen}` 仅留在累加器内部供 log / 护栏，**不进 IPC 返回**；见 §三硬问题① |
| R-3 | 🔴 **小文件路径零回归**：路由 fail-closed 必须确保单 sheet 小文件 / `.csv` / `.xls` / preflight 异常全部回普通通道；main.js 两 handler 现有小文件分支一行不改 | `shouldUseLargeChannel` 默认 false；main.js 只在分叉**前**加 `if (await shouldUseLargeChannel) {...大通道...} else {现有分支原样}`；回归测试「单 sheet 小→false / 多 sheet→true / csv→false / preflight 异常→false」；见 §五路由 + §九测试 |
| R-4 | 🔴 **readXlsxSheetMetaLite 自身 OOM**：它 `:352-354 fs.promises.readFile(整文件) + JSZip.loadAsync(buffer)`；注释自称「不 OOM」仅对 65 万行（压缩 buffer 小）成立，对 800MB 压缩文件读整 buffer 仍 OOM。路由**禁用它** | 路由只用 `collectEntrySizes`（不读文件体）；TECHDOC §五显式标注禁用理由；见 §五 |
| R-5 | **多 sheet 续页边界**：数据行恰等于表头会被当重复表头跳过（不可避免的语义代价） | 文档化 + 测试显式记录（不视为 bug）；见 §三硬问题③ + §九测试 |
| R-6 | **sharedStrings 全量驻内存**：极高基数全唯一长文本文件 sharedStrings 可达 GB 级 | v1 接受全量 + 护栏（解析前读 uncompressedSize 超 ~1.2GB 可解释拒绝 + worker heapUsed >~3GB 主动抛错）；spill 留 v2（OPEN-2）；见 §三硬问题② |
| R-7 | **临时大文件清理（修 B20）**：800MB 级临时文件 try/finally 必须可靠清，含 worker crash | main.js split:export try/finally 清 mkdtemp 目录 + dispatch `.on('exit')` 兜底（照搬 big-table-import-dispatch.js:106）；见 §六 T6 |
| R-8 | main.js 含 NUL 字节（`reference_mainjs_nul_grep`）：编辑 :12947/:12981 区段须确认不与 NUL 行重叠 | 编辑前 `grep -an $'\x00' src/main.js` 定位 NUL 行避开；review 用 `git diff --text`/`grep -a`；见 §十一 |

### 1.3 与 PRD 的差异

无。所有技术实现与 PRD 描述一致。一处需 Dev 拍板的实施期取舍：**是否让小文件通道也切到封顶累加器**（默认不切、新通道独立用新模块，详见 §三硬问题①注 + §十六 OPEN-T1）。

---

## 二、涉及的文件清单

| 文件 | 改动类型 | 概要 |
|------|---------|------|
| `src/backend/toolbox-xlsx-stream/multi-sheet-reader.js` | **新增** | 核心：`streamLogicalTableRows(filePath, { onDataRow, onHeaderRow, cancelToken })` —— `openZipWithEntries`+`locateSheets` 拿有序 sheet → 逐 sheet `openReadStream`+`scanSheetRows` 透传每行；sharedStrings 循环外 `loadSharedStrings` 一次；多 sheet 续页语义 + 列序冲突 `ToolboxHeaderMismatchError`。**不走 `openWorkbook`**（绕 ≥2 sheet 拒绝） |
| `src/backend/toolbox-xlsx-stream/bounded-values-accumulator.js` | **新增** | 有界去重累加器：每列 Set 封顶 N=1000（到顶丢 Set）+ 全局 maxTotalDistinct=200000 兜底；`{addRow(values), result()}`，`result()` 回 `{field:string[]}`（≤N、首现序，**不含 truncated 元数据**）；`merge()` 供分片合并 |
| `src/backend/toolbox-xlsx-stream/split-scan-fields.js` | **新增** | split:read 第一步：`scanFields(filePath, cancelToken)` → multi-sheet-reader 全表扫 → bounded-accumulator → `{headers, valuesByField}` |
| `src/backend/toolbox-xlsx-stream/split-export-filter.js` | **新增** | split:export 第二步：`exportFilter({filePath, field, values, savePath, cancelToken})` → peek 表头 → `createRowFilter` → 命中行喂 `writeRowsStreamed` 写临时 xlsx → `{matchedCount}` |
| `src/backend/toolbox-xlsx-stream/large-split-worker.js` | **新增（worker_threads 入口）** | 薄壳：`parentPort.on('message')` 收 `{op:'scanFields'\|'exportFilter', jobId, ...}`/cancel；postMessage progress/log/done/error；`cancelToken`；照搬 `engine-worker-entry.js` 范式 |
| `src/main-process/toolbox-large-split-dispatch.js` | **新增** | `new Worker(large-split-worker)` + jobId + 协议（progress/log/done/error）+ `deserializeError` 还原 + `terminate` + `.on('exit')` 兜底；`resourceLimits.maxOldGenerationSizeMb=4096`；照搬 `big-table-import-dispatch.js:34-127` |
| `src/main-process/toolbox-large-split-router.js` | **新增** | `shouldUseLargeChannel(filePath)`：只用 `collectEntrySizes`；`.xlsx` 且（worksheet ≥2 或单 worksheet ≥1.5GB）→ true；否则 fail-closed false |
| `src/main.js` | **修改（唯一既有文件）** | `toolbox:split:read`(:12947) / `toolbox:split:export`(:12981) 各加 `if (await shouldUseLargeChannel(...)) {大通道 dispatch} else {现有分支原样}` + split:export try/finally 清临时目录。**不动现有小文件分支** |
| `src/backend/big-table-import/zip-reader.js` | **复用不改** | `openZipWithEntries`:61 / `locateSheets`:111 / `loadSharedStrings`:212（不调 `openWorkbook`:154） |
| `src/backend/big-table-import/row-scanner.js` | **复用不改** | `scanSheetRows`:427（`onRow` 抛 `__stopParsing` 早退/cancel） |
| `src/main-process/toolbox-stream-io.js` | **复用不改** | `writeRowsStreamed`:348 / `MAX_DATA_ROWS_PER_SHEET`:67（仅复用写路径，不复用其读路径） |
| `src/backend/pending-import/xlsx-size-preflight.js` | **复用不改** | `collectEntrySizes`:45 |
| `src/main-process/toolbox.js` | **复用不改** | `createRowFilter`:228 / `buildSplitFileName`:256（默认不改 `createValuesByFieldAccumulator`:186） |
| `src/backend/big-table-import/engine-worker-entry.js` / `src/main-process/big-table-import-dispatch.js` | **照搬范式不改** | worker 协议 + dispatch 模板 |
| 🔴 `src/backend/pending-import/streaming-xlsx-reader.js` | **严禁碰** | 隔离铁律；AC1-5 锁 |
| `tests/unit/backend/toolbox-xlsx-stream/*.test.js` | **新增** | multi-sheet-reader（乱序夹具）/ bounded-accumulator（边界）/ 续页各情形 / router 边界 / 输出分 sheet 单测 |
| `scripts/integration/toolbox-large-split-multi-sheet.js` | **新增** | 运行时程序生成 700 万行多 sheet xlsx（`writeRowsStreamed` 流式写，跑完删、不进 git），真 worker 拓扑跑通，断言内存恒定 + 值正确 + 命中数正确 |
| `src/preload.js` / `src/renderer-dialogs.js` / `src/renderer-previews.js` | **🚩 不动** | 前端零改动铁律；不重跑 preview |

---

## 三、架构 / 模块改动地图（文字版）

```
Renderer（src/renderer-dialogs.js createSplitFieldPickerDialog）🚩 零改动
  │  ipcRenderer.invoke('toolbox:split:read' / 'toolbox:split:export')   （preload 零改动）
  ▼
Main Process（src/main.js）— 🔴 NUL 二进制（grep -a / git diff --text）
  ├─ toolbox:split:read（:12947）
  │     if (await shouldUseLargeChannel(filePath))  ──► 大通道 dispatch scanFields ──► {headers, valuesByField}
  │     else  ──► 【现有小文件分支原样：toolboxIsStreamableXlsx → 流式 / extractHeaders+readRows】
  └─ toolbox:split:export（:12981）
        if (await shouldUseLargeChannel(filePath))  ──► mkdtemp → dispatch exportFilter → copyFile 另存 → try/finally 清临时
        else  ──► 【现有小文件分支原样】
        │
        ├── src/main-process/toolbox-large-split-router.js   shouldUseLargeChannel
        │       └── (复用) xlsx-size-preflight.js collectEntrySizes:45   ← 🔴 禁用 readXlsxSheetMetaLite
        │
        └── src/main-process/toolbox-large-split-dispatch.js   new Worker + 协议 + exit 兜底（照搬 big-table-import-dispatch.js）
                │  Worker
                ▼
            src/backend/toolbox-xlsx-stream/large-split-worker.js  （worker_threads 入口，照搬 engine-worker-entry.js）
                ├── split-scan-fields.js   scanFields  ──► multi-sheet-reader + bounded-values-accumulator
                └── split-export-filter.js exportFilter ──► multi-sheet-reader + createRowFilter + writeRowsStreamed
                        │
                        ├── (复用) big-table-import/zip-reader.js   openZipWithEntries:61 / locateSheets:111 / loadSharedStrings:212
                        ├── (复用) big-table-import/row-scanner.js   scanSheetRows:427（__stopParsing 早退/cancel）
                        ├── (复用) toolbox-stream-io.js   writeRowsStreamed:348（写路径；超 104 万自动分 sheet）
                        └── (复用) toolbox.js   createRowFilter:228 / buildSplitFileName:256
                        🔴 不 import streaming-xlsx-reader.js（隔离铁律）
```

### 三个硬问题的设计（与 plan 逐字对齐）

#### ① 有界去重累加器（🚩 前端零改动约束）

- **每列 Set 封顶 `N=1000`**：到顶**丢弃该列 Set**（高基数列内存恒 O(N)，不再增长）。
- **全局 `maxTotalDistinct=200000` 兜底**：跨所有列的去重值总数达上限 → 停止收集（病态宽表防护）。
- **回传契约与现状完全一致**：`result()` 回 `valuesByField = {field: string[]}`（封顶后 ≤N 个值、首现序）。**🚩 不暴露截断元数据**——`{truncated, distinctSeen}` 仅留累加器内部供 log / 护栏，**绝不进 IPC 返回**（前端 `createSplitFieldPickerDialog` 一行不改、preview 不重跑）。
- **内存**：典型 ≤10MB、病态宽表 ≤~100MB（vs 现状无界 GB）。
- **`merge(other)`**：供「未来多分片合并」预留（v1 单 worker 全表扫不分片，但累加器设计带 merge 以便日后或测试分段验证）。
- **已知限制（OPEN-1）**：高基数列（>N 去重值）下拉只显示前 N 个、用户无法按超出前 N 的值拆分、且无截断提示（现有 checkbox 浮动勾选面板无手动输入入口）。按字段拆通常用低基数维度（渠道/币种/商户/状态），影响有限。
- **注（实施期取舍 OPEN-T1）**：新通道用本新模块；**小文件通道仍用 `toolbox.js:186 createValuesByFieldAccumulator`（无界）不改**——去重值 ≤N 时两者输出等价，故小文件零回归（AC1-3）。若 Dev 决定统一口径让小文件也封顶，则改 `toolbox.js` 属 `/check-vars` 硬节点，须补「去重值 ≤N 时输出与现状逐字节一致」回归测试。

#### ② sharedStrings 全量驻内存 + 护栏（v1 不 spill）

- **v1 接受全量驻内存**，不做 spill-to-disk（spill 会击穿 `row-scanner` 性能核心 —— sharedStrings 随机访问是逐字节扫行的热路径）。
- **护栏**：
  1. 解析前读 `xl/sharedStrings.xml` `entry.uncompressedSize`（`collectEntrySizes` 已返回此 entry 尺寸）→ 超阈值（~1.2GB）→ 可解释拒绝（`failed` 文案）而非崩溃。
  2. worker 内监控 `process.memoryUsage().heapUsed` 超 ~3GB → 主动抛可解释错误（兜底）。
- **乐观~中位**（枚举型文本，sharedStrings ≤几百 MB）在 4GB worker（`maxOldGenerationSizeMb=4096`）内安全。
- **悲观（OPEN-2）**：极高基数全唯一长文本文件 v1 仍不支持（文档化），v2 评估 spill。

#### ③ 多 sheet 续页语义

- 表头 = 第一个**非空** sheet 的**首个有意义行**（按 `locateSheets`:111 显示序，**非物理 sheetN.xml 编号序**）。
- 后续 sheet 首个有意义行与表头**归一化全等** → 跳过（重复表头分页），否则当数据行。
- 列序与表头不一致 → 抛 `ToolboxHeaderMismatchError`（**不做按名重排**）。
- 输出 >104 万行复用 `writeRowsStreamed` 自动分 sheet（`MAX_DATA_ROWS_PER_SHEET=1048575`:67）。
- ⚠️ **已知边界**：数据行恰等于表头会被当重复表头跳过（测试显式记录、不视为 bug）。
- **rowR 跨 sheet 重置**：`scanSheetRows` 的 `rowR` 取各 sheet 自己的 `<row r>`，跨 sheet 会从 1 重新计；多-sheet-reader 须以「每个 sheet 内首个有意义行」而非「全局 rowR===1」判表头（测试覆盖跨 sheet rowR 重置）。

---

## 四、数据流（端到端，含 worker 消息协议）

### 4.1 split:read（scanFields）端到端

```
main.js toolbox:split:read handler
  showOpenDialog(单选) → sourceFilePath
  if (await shouldUseLargeChannel(sourceFilePath)):
    result = await dispatchLargeSplit({ op:'scanFields', filePath: sourceFilePath })
    return { status:'success', sourceFilePath, headers: result.headers, valuesByField: result.valuesByField }
  else:
    【现有小文件分支原样】

dispatchLargeSplit（toolbox-large-split-dispatch.js）
  worker = new Worker(large-split-worker.js, { resourceLimits:{ maxOldGenerationSizeMb:4096 } })
  jobId = `tbx-split-${Date.now()}-${rand}`
  worker.postMessage({ op:'scanFields', jobId, filePath })
  worker.on('message', msg => { 按 jobId 过滤；progress/log→activity log；done→resolve(result)；error→reject(deserializeError) })
  worker.on('exit', code => { 未 settled 的非零退出→reject })

large-split-worker.js（worker 入口）
  parentPort.on('message', async ({op, jobId, ...args}) => {
    if (op==='scanFields') { result = await scanFields(args.filePath, cancelToken); postMessage({type:'done', jobId, result}) }
    ...catch→ postMessage({type:'error', jobId, error: serializeError(err)})
  })

scanFields（split-scan-fields.js）
  acc = createBoundedValuesAccumulator()   // 表头未知前先缓存，拿到表头再定列
  headers = null
  await streamLogicalTableRows(filePath, {
    onHeaderRow: (h) => { headers = h; acc.setHeaders(h) },
    onDataRow:   (values) => acc.addRow(values),
    cancelToken
  })
  return { headers, valuesByField: acc.result() }   // {field:string[]} 逐字节同契约
```

### 4.2 split:export（exportFilter）端到端

```
main.js toolbox:split:export handler  入参 { sourceFilePath, field, values }
  if (await shouldUseLargeChannel(sourceFilePath)):
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'toolbox-large-'))
    tempPath = path.join(tempDir, `toolbox-${Date.now()}.xlsx`)
    try {
      result = await dispatchLargeSplit({ op:'exportFilter', filePath, field, values, savePath: tempPath })
      if (result.matchedCount === 0) return {…不产文件，沿用现文案…}
      saveChoice = await showSaveDialog(默认名 buildSplitFileName(values, sanitizeFileName))
      if (canceled) return { status:'cancelled' }
      fs.copyFileSync(tempPath, saveChoice.filePath)
      return { status:'success', filePath: saveChoice.filePath }
    } finally {
      // 🔴 修 B20：可靠清临时目录（worker crash 时 dispatch .on('exit') 也兜底清）
      try { fs.rmSync(tempDir, { recursive:true, force:true }) } catch (_) {}
    }
  else:
    【现有小文件分支原样】

exportFilter（split-export-filter.js）
  // peek 表头：multi-sheet-reader 读到 onHeaderRow 即拿表头（不必先扫完）
  let filter = null, headers = null
  await writeRowsStreamed({
    savePath, sheetBaseName:'COMMON',
    normalizedHeaders: <peek 到的表头>,   // 先 peek 表头一行确定 normalizedHeaders + createRowFilter
    writeDataRows: async (emit) => {
      await streamLogicalTableRows(filePath, {
        onHeaderRow: (h) => { headers = h; filter = createRowFilter(h, field, values) },
        onDataRow:   (values) => { if (filter.test(values)) emit(values) },
        cancelToken
      })
    }
  })
  return { matchedCount: <emit 计数> }
```

> **实现注**：`writeRowsStreamed` 需要 `normalizedHeaders` 先于 `writeDataRows` 确定。两种落地方式（Dev 拍板，OPEN-T2）：(a) 先用 multi-sheet-reader 的「仅 peek 表头」模式跑一遍拿表头（`scanSheetRows` 支持 `__stopParsing` 在表头行后早退，成本 O(1)），再正式流式过滤写；(b) 调整 `writeRowsStreamed` 接受「表头在首次 emit 前由回调提供」。推荐 (a)（不改 `writeRowsStreamed` 签名、复用 `__stopParsing` 早退）。

### 4.3 worker 消息协议（照搬 engine-worker-entry.js:60-100 范式）

| 方向 | 消息 | 字段 | 说明 |
|------|------|------|------|
| 主→worker | run | `{ op:'scanFields'\|'exportFilter', jobId, filePath, field?, values?, savePath? }` | 启动作业 |
| 主→worker | cancel | `{ type:'cancel', jobId }` | 置 `cancelToken.cancelled=true`（v1 无前端触发，仅兜底） |
| worker→主 | progress | `{ type:'progress', jobId, payload }` | 进度（走 activity log，无 UI；OPEN-3） |
| worker→主 | log | `{ type:'log', jobId, entry }` | 日志透传 |
| worker→主 | done | `{ type:'done', jobId, result }` | `result` = scanFields `{headers, valuesByField}` / exportFilter `{matchedCount}` |
| worker→主 | error | `{ type:'error', jobId, error: serializeError(err) }` | 主侧 `deserializeError` 还原（保 name/message/detailLines） |
| worker exit | — | `code` | dispatch `.on('exit')`：未 settled 的非零退出→reject（兜底 + 临时清理）|

---

## 五、路由：`shouldUseLargeChannel`（toolbox-large-split-router.js）

### 5.1 实现方案

```js
// v3.0.9：工具箱大文件拆分通道路由。只用 collectEntrySizes（yauzl 读中央目录、不解压、不读文件体）判定。
//   🔴 禁用 readXlsxSheetMetaLite（readers.js:352）——它 fs.readFile(整文件)+JSZip.loadAsync(buffer)，对 800MB 自身 OOM。
const { collectEntrySizes } = require('../backend/pending-import/xlsx-size-preflight');
const SINGLE_WORKSHEET_LARGE_BYTES = 1610612736; // 1.5GB
const WORKSHEET_RE = /^xl\/worksheets\/sheet\d+\.xml$/;

async function shouldUseLargeChannel(filePath) {
  if (!filePath || !/\.xlsx$/i.test(filePath)) return false;   // .csv/.xls → fail-closed
  let sizes;
  try { sizes = await collectEntrySizes(filePath); }
  catch (_e) { return false; }                                 // preflight 异常 → fail-closed
  const worksheets = [...sizes.entries()].filter(([n]) => WORKSHEET_RE.test(n));
  if (worksheets.length >= 2) return true;                     // 多 sheet → 大通道
  const onlySize = worksheets.length === 1 ? worksheets[0][1] : 0;
  if (typeof onlySize === 'number' && onlySize >= SINGLE_WORKSHEET_LARGE_BYTES) return true; // 单 worksheet ≥1.5GB
  return false;                                                // 单 sheet 小文件 → fail-closed（普通通道）
}
```

### 5.2 设计要点

- **只用 `collectEntrySizes`**（`xlsx-size-preflight.js:45`）：yauzl 读中央目录、`lazyEntries:false` 一次枚举、**不 openReadStream / 不读文件体** → 不会自身 OOM；返回 `Map<fileName, uncompressedSize>`（含全部 worksheet entry + sharedStrings）。
- **🔴 禁用 `readXlsxSheetMetaLite`**（`readers.js:352`）：它 `fs.promises.readFile(整文件 buffer)` + `JSZip.loadAsync(buffer)`——其注释「不 OOM」仅对 65 万行（压缩 buffer 小）成立，对 800MB 压缩文件读整 buffer 仍 OOM（plan 关键发现）。
- **条件**：`.xlsx` 且（worksheet 数 ≥2 **或** 单 worksheet 解压尺寸 ≥1.5GB`(1610612736)`）→ 大通道。
- **fail-closed**：`.csv`/`.xls`、单 sheet 小文件、`collectEntrySizes` 异常 → 一律 false（回普通通道，**小文件路径一行不改、行为不变**）。

---

## 六、Phase 1 离散任务拆分（给 dev 分批委托用）

> Phase 1（MVP，让 700 万行字段拆分端到端跑通、内存有界）拆成 7 个有清晰边界、可独立实现 + 测试的子任务。每个写清输入/输出/复用点/测试要求/依赖关系。约 **8–12 dev-日（1.5–2.5 周）**。
>
> **依赖拓扑**：T1、T2 无依赖（可并行起）→ T3 依赖 T1+T2 → T4 依赖 T3 → T5 无依赖（可与 T1-T4 并行）→ T6 依赖 T4+T5 → T7 依赖 T1-T6（端到端）。

### T1 — multi-sheet-reader（多 sheet 逻辑表读）

| 项 | 内容 |
|----|------|
| 文件 | `src/backend/toolbox-xlsx-stream/multi-sheet-reader.js`（新增） |
| 职责 | `streamLogicalTableRows(filePath, { onHeaderRow, onDataRow, cancelToken })`：`openZipWithEntries`→`locateSheets` 拿有序 sheet → 循环外 `loadSharedStrings` 一次 → 逐 sheet `openReadStream`+`scanSheetRows` 透传行；多 sheet 续页语义（§三③）；列序冲突 `ToolboxHeaderMismatchError` |
| 输入 | `filePath`、回调、`cancelToken` |
| 输出 | 通过 `onHeaderRow(headers)`（一次）+ `onDataRow(values)`（每数据行）回调流式输出；无返回值（或返回 `{sheetCount, dataRowCount}`） |
| 复用点 | `zip-reader.js openZipWithEntries:61 / locateSheets:111 / loadSharedStrings:212`（**不调 openWorkbook:154**）、`row-scanner.js scanSheetRows:427`、归一化口径对齐 `toolbox.js`/`file-service/normalizers.js`（与现状 normalizeCell 一致） |
| 测试要求 | 单测：乱序多 sheet 夹具（workbook.xml `<sheet>` 序 ≠ 物理 sheetN.xml 编号，验证按显示序读对）；重复表头跳过 / 仅首页有表头 / 列序冲突报错 / 空 sheet / 跨 sheet rowR 重置 / 数据行恰等表头被跳过（边界记录） |
| 依赖 | 无（可立即起） |
| 🔴 红线 | 不 import `streaming-xlsx-reader.js`；不调 `openWorkbook`（绕 ≥2 sheet 拒绝） |

### T2 — bounded-values-accumulator（有界去重累加器）

| 项 | 内容 |
|----|------|
| 文件 | `src/backend/toolbox-xlsx-stream/bounded-values-accumulator.js`（新增） |
| 职责 | 有界去重累加器：`setHeaders(headers)` / `addRow(values)` / `result()` / `merge(other)`；每列 Set 封顶 N=1000（到顶丢 Set）+ 全局 maxTotalDistinct=200000 兜底 |
| 输入 | headers、逐行 values |
| 输出 | `result()` → `{field: string[]}`（≤N、首现序，**不含 truncated 元数据**）；内部留 `{truncated, distinctSeen}` 供 log/护栏 |
| 复用点 | 归一化口径与 `toolbox.js:109 computeValuesByField` / `:186 createValuesByFieldAccumulator` 一致（首现序、normalizeCell） |
| 测试要求 | 单测：恰好 N（不截断）/ N+1（截断后该列不再增内存）/ 首现序保持 / merge 正确 / 全局 maxTotalDistinct 闸生效 / `result()` 不含 truncated 字段（契约锁） |
| 依赖 | 无（可立即起） |
| 🚩 红线 | `result()` 只回 `{field:string[]}`，不暴露截断元数据（前端零改动契约） |

### T3 — split-scan-fields + split-export-filter（两步纯逻辑）

| 项 | 内容 |
|----|------|
| 文件 | `src/backend/toolbox-xlsx-stream/split-scan-fields.js` + `split-export-filter.js`（新增） |
| 职责 | scanFields：multi-sheet-reader 全表扫 → bounded-accumulator → `{headers, valuesByField}`；exportFilter：peek 表头 → `createRowFilter` → 命中行喂 `writeRowsStreamed` 写临时 xlsx → `{matchedCount}` |
| 输入 | scanFields: `(filePath, cancelToken)`；exportFilter: `({filePath, field, values, savePath, cancelToken})` |
| 输出 | scanFields: `{headers, valuesByField}`；exportFilter: `{matchedCount}` + 写出 savePath |
| 复用点 | T1 multi-sheet-reader、T2 bounded-accumulator、`toolbox.js createRowFilter:228`、`toolbox-stream-io.js writeRowsStreamed:348`（写路径，超 104 万自动分 sheet）；peek 表头用 `scanSheetRows` `__stopParsing` 早退（OPEN-T2 推荐方案 a） |
| 测试要求 | 单测：scanFields 多 sheet 夹具回正确 valuesByField；exportFilter 命中子集正确、命中 0 行、>maxRowsPerSheet（传小值）确定性分 sheet |
| 依赖 | T1 + T2 |

### T4 — large-split-worker + toolbox-large-split-dispatch（worker + 主侧调度）

| 项 | 内容 |
|----|------|
| 文件 | `src/backend/toolbox-xlsx-stream/large-split-worker.js` + `src/main-process/toolbox-large-split-dispatch.js`（新增） |
| 职责 | worker 薄壳：`parentPort.on('message')` 收 run/cancel、postMessage progress/log/done/error、cancelToken；dispatch：new Worker + jobId + 协议 + deserializeError + terminate + `.on('exit')` 兜底，`resourceLimits.maxOldGenerationSizeMb=4096` |
| 输入 | dispatch: `{op, filePath, field?, values?, savePath?}`；worker 收同 + jobId |
| 输出 | dispatch: Promise<result>（done resolve / error·exit reject）|
| 复用点 | 照搬 `engine-worker-entry.js:60-100`（协议）+ `big-table-import-dispatch.js:34-127`（new Worker:52 / resourceLimits:41-52 / jobId:57 / terminate:63 / deserializeError:100 / exit 兜底:106）；`serialize-error`/`deserialize-error` 复用 `main-process/serialize-error` |
| 测试要求 | 集成（在 T7）：真 worker 拓扑跑通 scanFields/exportFilter；单测可对 dispatch 的 error 还原 / exit 兜底打桩 |
| 依赖 | T3 |
| 🔴 红线 | sharedStrings 护栏（解析前 uncompressedSize 超 ~1.2GB 可解释拒绝 + worker heapUsed >~3GB 抛错）落在 worker/scanFields 内 |

### T5 — toolbox-large-split-router（路由）

| 项 | 内容 |
|----|------|
| 文件 | `src/main-process/toolbox-large-split-router.js`（新增） |
| 职责 | `shouldUseLargeChannel(filePath)`：只用 `collectEntrySizes`；`.xlsx` 且（worksheet ≥2 或单 worksheet ≥1.5GB）→ true；否则 fail-closed false（见 §五）|
| 输入 | `filePath` |
| 输出 | `Promise<boolean>` |
| 复用点 | `xlsx-size-preflight.js collectEntrySizes:45`；🔴 禁用 `readers.js readXlsxSheetMetaLite:352` |
| 测试要求 | 单测：单 sheet 小→false / 多 sheet→true / 单 worksheet ≥1.5GB→true / `.csv`→false / `.xls`→false / collectEntrySizes 抛异常→false（fail-closed） |
| 依赖 | 无（可与 T1-T4 并行）|

### T6 — main.js 两 handler 路由分叉 + 临时清理（修 B20）

| 项 | 内容 |
|----|------|
| 文件 | `src/main.js`（修改，唯一既有文件）|
| 职责 | `toolbox:split:read`(:12947) / `toolbox:split:export`(:12981) 各加 `if (await shouldUseLargeChannel(...)) {大通道 dispatch} else {现有分支原样}`；split:export try/finally 清 mkdtemp 目录（修 B20）；回传契约不变 |
| 输入 | 同现有 handler |
| 输出 | split:read `{status,sourceFilePath,headers,valuesByField}`（逐字节同契约）；split:export `{status,filePath}` |
| 复用点 | T5 shouldUseLargeChannel、T4 dispatch、`toolbox.js buildSplitFileName:256`、现有 dialog/showSaveDialog |
| 测试要求 | 集成（T7）端到端；接缝盲区（`feedback_multiagent_seam_gap`）：大通道分叉与现有小文件分支的 handler 返回结构必须逐字节一致 |
| 依赖 | T4 + T5 |
| 🔴 红线 | 不动现有小文件分支；main.js NUL 字节编辑前 `grep -an $'\x00'` 避开（R-8）；try/finally + dispatch exit 兜底可靠清临时大文件 |

### T7 — 测试夹具 + 集成脚本（端到端 + 内存恒定）

| 项 | 内容 |
|----|------|
| 文件 | `scripts/integration/toolbox-large-split-multi-sheet.js`（新增）+ 各单测补全 |
| 职责 | 运行时程序生成 700 万行多 sheet xlsx（用 `writeRowsStreamed` 流式写，跑完删、不进 git），真 worker 拓扑跑通；断言内存恒定 + 值正确 + 命中数正确 |
| 输入 | 生成的大 xlsx（含乱序 sheet + 重复表头 + 已知去重集合 + 已知命中数）|
| 输出 | `N/N PASS`（exit 0/1）|
| 复用点 | `writeRowsStreamed` 生成夹具、真 dispatch + worker 跑 scanFields/exportFilter、`readXlsxStreamed` 或 multi-sheet-reader 做 readback 校验（避免 SheetJS 全量读大输出再 OOM）|
| 测试要求 | 断言：(a) 主/worker 内存峰值**恒定 RSS 不随行数线性涨**；(b) scanFields 的 valuesByField 与注入去重集合一致（≤N）；(c) exportFilter matchedCount 与已知命中数一致、产物可 readback；(d) cancel 中途 <5s 停（如测）|
| 依赖 | T1-T6（端到端）|

---

## 七、需求 1 全链路接缝契约（main ↔ dispatch ↔ worker ↔ backend 模块）

> 🔴 跨接缝盲区（`feedback_multiagent_seam_gap`）：6 模块 + main.js 跨进程 / 跨文件协作，逐文件 review 看不见接缝，**必须补跨接缝端到端测试（T7）+ codex review**。

| 接缝 | 契约 | 不变量 |
|------|------|--------|
| main.js → router | `await shouldUseLargeChannel(filePath)` 返回 boolean；异常内部吞→false | fail-closed：任何不确定都回普通通道（小文件零回归 AC1-3）|
| main.js → dispatch | `dispatchLargeSplit({op, filePath, field?, values?, savePath?})` → Promise<result>；error·exit reject | dispatch 必 terminate worker（done/error/exit 后）；exit 兜底 reject + main try/finally 清临时 |
| dispatch ↔ worker | 消息协议（§4.3）：run/cancel ↔ progress/log/done/error；jobId 过滤 | jobId 不匹配的非 log 消息忽略（照搬 big-table-import-dispatch.js:81）|
| worker → backend | `scanFields`/`exportFilter` 纯函数（无 Electron 依赖）| backend 模块纯 Node（worker 安全），不 require electron / main-process 重模块 |
| worker → main 返回 | scanFields `{headers, valuesByField}`；valuesByField=`{field:string[]}` | 🚩 逐字节同现状契约，**不含 truncated 元数据**（AC1-4）|
| main.js handler 返回 | split:read `{status,sourceFilePath,headers,valuesByField}`；split:export `{status,filePath}` | 大通道与现有小文件分支返回结构**逐字节一致**（前端无感）|

**接缝陷阱**：
- `scanSheetRows` 的 `onRow({rowR, values, hasAnyCellText})` 回调 `values` 是**按列索引的数组**（不是对象）；multi-sheet-reader 透传给 `onDataRow(values)` 也是数组；累加器 / filter 须按列索引操作。
- backend 模块（`toolbox-xlsx-stream/*`）必须**纯 Node**（worker 安全）：不 require `electron` / `main.js` / 任何带 Electron 依赖的 main-process 模块。`writeRowsStreamed`（`toolbox-stream-io.js`）目前在 main-process 但其实现仅依赖 `exceljs` + `file-service`（纯 Node）—— Dev 须确认它在 worker 内可安全 require（若它顶部 require 了 electron 相关，需抽出纯 Node 写函数；OPEN-T3）。
- sharedStrings 在 multi-sheet-reader 循环外 `loadSharedStrings` 一次（不要每 sheet 重载）。

---

## 八、需求 1：实现方案补充

### 8.1 为什么不整体复用 big-table-import engine/pipeline

`big-table-import` 的 engine/pipeline 与目标 schema 强耦合（列映射、入库、rowid 契约、多文件并行）；工具箱拆分是「无 schema 的行级搬运」+ 单文件单作业，整体复用反而背上不需要的复杂度。只复用其**底层 zip/scan 原语**（`zip-reader.js`/`row-scanner.js`）+ **worker 范式**（`engine-worker-entry.js`/`big-table-import-dispatch.js` 照搬模板）。

### 8.2 为什么不复用 toolbox-stream-io.js 的读路径

`toolbox-stream-io.js:34` require 了 `streaming-xlsx-reader.js` 的 `readXlsxStreamed`（隔离铁律禁区），且其 `canStreamXlsx`:108 对多 sheet 落回 `readRows`（SheetJS 全量 → 800MB OOM）。新通道**读路径全部走 `big-table-import/` 原语**，**仅复用 `toolbox-stream-io.js` 的写路径 `writeRowsStreamed`:348**（该函数仅依赖 exceljs + file-service，不碰 streaming reader）。

### 8.3 单 worker 即可

单文件单作业，无需 pipeline 的多文件并行 / rowid 契约 → 单 worker（`large-split-worker.js`）。`resourceLimits.maxOldGenerationSizeMb=4096`（与 pending dispatch 同口径，R-5 范式）。

---

## 九、测试计划

> plan 验证章节落地。Unit（隔离逻辑/边界）+ Integration（真 worker 拓扑 + 真大文件 + 内存恒定）。release-check 全绿。

### 9.1 单元测试（`tests/unit/backend/toolbox-xlsx-stream/`）

| 测试 | 覆盖 | 对应 T |
|------|------|--------|
| multi-sheet-reader 乱序夹具 | workbook.xml `<sheet>` 序 ≠ 物理 sheetN.xml 编号 → 按显示序读对（程序生成小规模夹具，含乱序 `<sheet r:id>`）| T1 |
| multi-sheet-reader 续页各情形 | 重复表头跳过 / 仅首页有表头 / 列序冲突 `ToolboxHeaderMismatchError` / 空 sheet / 跨 sheet rowR 重置 / 数据行恰等表头被跳过（边界记录）| T1 |
| bounded-accumulator 边界 | 恰好 N（不截断）/ N+1（截断后该列不再增内存）/ 首现序 / merge / 全局 maxTotalDistinct 闸 / `result()` 不含 truncated 字段（🚩 契约锁）| T2 |
| split-scan/export 逻辑 | scanFields 多 sheet 夹具回正确 valuesByField（≤N）；exportFilter 命中子集正确 / 命中 0 行 / 小 `maxRowsPerSheet` 确定性分 sheet | T3 |
| router 边界 | 单 sheet 小→false / 多 sheet→true / 单 worksheet ≥1.5GB→true / `.csv`→false / `.xls`→false / collectEntrySizes 异常→false | T5 |
| 复用 row-scanner 等价 harness | 复用 `row-scanner` 自带的「四方等价」harness（手卷扫行 vs SheetJS 等价），证明 multi-sheet-reader 透传的行与权威解析一致（plan 验证项）| T1 |

### 9.2 集成测试（`scripts/integration/toolbox-large-split-multi-sheet.js`，新增）

> 命名遵循 `rules/integration-test-policy.md`：按模块命名、不带版本前缀、stdout 含 `N/N PASS`、exit 0/1、自建 tmp 跑完删。

- 运行时**程序生成** 700 万行多 sheet xlsx（用 `writeRowsStreamed` 流式写，含乱序 sheet + 重复表头 + 已知去重集合 + 已知命中数），**跑完删、不进 git**。
- 真 worker 拓扑（真 dispatch + 真 `new Worker`）跑通 scanFields / exportFilter。
- 断言：
  - (a) 主 / worker 内存峰值**恒定 RSS 不随行数线性涨**（采样 `process.memoryUsage().rss` / worker 内 heapUsed）；
  - (b) scanFields 的 valuesByField 与注入的去重集合一致（每列 ≤N=1000）；
  - (c) exportFilter matchedCount 与已知命中数一致、产物可 readback 校验（用 multi-sheet-reader 或 `readXlsxStreamed` readback，避免 SheetJS 全量读大输出再 OOM）；
  - (d) cancel 中途 <5s 停（如纳入）。

### 9.3 回归与零改动锁

| 锁 | 验证 |
|----|------|
| 🔴 小文件零回归（AC1-3）| 单 sheet 小文件 / `.csv` / `.xls` → `shouldUseLargeChannel`=false 走原通道；现有 `toolbox-roundtrip.js` + `toolbox-large-file-stream.js` 集成脚本全绿（去重值 ≤N 时输出与现状逐字节一致）|
| 🚩 前端零改动（AC1-4）| `git diff` 确认 `renderer-dialogs.js`/`renderer-previews.js`/`preload.js` 无改动；不重跑 preview |
| 🔴 隔离铁律（AC1-5）| `git diff src/backend/pending-import/streaming-xlsx-reader.js` 无改动；`grep -rn "streaming-xlsx-reader" src/backend/toolbox-xlsx-stream/` 无命中（新通道不 import 它）|
| release-check（AC1-6）| `npm run release-check` 全绿；`npm run scan:vars`（bump 前）+ `/check-vars`（提 PR / 合并前）|

---

## 十、N+2、任务分解

> 见 §六 Phase 1 离散任务（T1-T7）。下表为收尾任务。

| 序号 | 任务 | 涉及文件 | 验证方式 | 状态 |
|------|------|---------|---------|------|
| 0 | bump version 3.0.9 + `npm run scan:vars` | `package.json` | `npm run scan:vars` | todo（实施期）|
| T1-T7 | 见 §六 | `toolbox-xlsx-stream/*` + `main-process/*` + `main.js` + 测试 | 单测 + 集成 + release-check | todo |
| 收尾-1 | 文档三件套（CHANGELOG / VERSION_FEATURE_HISTORY / USER_GUIDE）| docs | — | todo |
| 收尾-2 | `npm run release-check` 全绿 + `/check-vars` | — | PASS/FAIL 源 | todo |
| 收尾-3 | PRD/TechDoc 实施记录回填（Reverse Sync）| 本两文档 | — | todo |

---

## 十一、N+3、实施计划（Commit 粒度）

> 一 task 一 commit，message `[v3.0.9] <简述>`。team-lead 自行 `git diff`+`release-check`+`/check-vars` 核实（不轻信 agent 汇报，`feedback_background_agent_unreliable`）。main.js 编辑前 `grep -an $'\x00'` 定位 NUL 行避开（R-8）。

| 序号 | Commit message | 涉及文件 | 子任务 |
|------|---------------|---------|--------|
| 0 | `[v3.0.9] bump 3.0.9 + PRD/TechDoc（工具箱大文件按字段拆分隔离 worker 通道）` | `package.json` + docs | — |
| 1 | `[v3.0.9] multi-sheet-reader：多 sheet 逻辑表流式读（复用 yauzl 原语，绕 openWorkbook 单 sheet 拒绝）` | `multi-sheet-reader.js` + 单测 | T1 |
| 2 | `[v3.0.9] bounded-values-accumulator：每列封顶 N=1000 有界去重（回传 string[] 同契约）` | `bounded-values-accumulator.js` + 单测 | T2 |
| 3 | `[v3.0.9] split-scan-fields + split-export-filter 两步纯逻辑` | `split-scan-fields.js` / `split-export-filter.js` + 单测 | T3 |
| 4 | `[v3.0.9] large-split-worker + dispatch（照搬 big-table-import 范式 + sharedStrings 护栏）` | `large-split-worker.js` / `toolbox-large-split-dispatch.js` | T4 |
| 5 | `[v3.0.9] toolbox-large-split-router：collectEntrySizes 判定 + fail-closed（禁用 readXlsxSheetMetaLite）` | `toolbox-large-split-router.js` + 单测 | T5 |
| 6 | `[v3.0.9] main.js 两 handler 大通道路由分叉 + 临时大文件 try/finally 清理（修 B20）` | `main.js` | T6 |
| 7 | `[v3.0.9] 大文件多 sheet 拆分集成测试（700 万行程序生成跑完删 + 内存恒定断言）` | `scripts/integration/toolbox-large-split-multi-sheet.js` | T7 |
| 8 | `[v3.0.9] 文档三件套 + PRD/TechDoc 实施记录` | docs | 收尾 |

---

## 十二、N+4、实施日志

> 记录实施过程中的关键决策、风险发现和可沉淀知识。由 Dev/team-lead 在实施期填写。

### 2026-06-18（TechDoc 初稿，PM）

- 动作：读 plan `snuggly-brewing-ocean.md` + v3.0.8 PRD/TECHDOC 房屋风格 + 模板；当面 grep 核实全部复用点 file:line（出处优先），落 PRD + TechDoc。
- 证据（grep 核实，当前 v3.0.9 工作树）：
  - 复用核心确认：`zip-reader.js openZipWithEntries:61 / locateSheets:111 / loadSharedStrings:212 / openWorkbook:154（≥2 sheet throw :163）`；`row-scanner.js scanSheetRows:427（__stopParsing :424/:458/:472）`；`toolbox-stream-io.js writeRowsStreamed:348 / MAX_DATA_ROWS_PER_SHEET=1048575:67 / canStreamXlsx:108`；`xlsx-size-preflight.js collectEntrySizes:45（返回 Map<fileName,uncompressedSize>）`；`toolbox.js createValuesByFieldAccumulator:186 / createRowFilter:228 / buildSplitFileName:256`；`main.js registerToolboxHandlers:12871 / toolbox:split:read:12947 / toolbox:split:export:12981`。
  - 禁用项确认：`readers.js readXlsxSheetMetaLite:352-354` 确为 `fs.promises.readFile(整文件)+JSZip.loadAsync(buffer)`（对 800MB 自身 OOM；其「不 OOM」注释仅对 65 万行压缩 buffer 成立）。
  - worker 范式确认：`engine-worker-entry.js`（parentPort.on message:60 / progress:91 / log:94 / done:98 / error:100 / cancelToken:96）+ `big-table-import-dispatch.js`（new Worker:52 / resourceLimits:41-52 / jobId:57 / terminate:63 / deserializeError:100 / exit 兜底:106）。
  - 现状基线确认：v3.0.8 §12.7 F1 已为工具箱加 `canStreamXlsx`「物理单 sheet」护栏 → 多 sheet 落回 `readRows`（SheetJS 全量），这正是 v3.0.9 痛点根因；现 `toolbox:split:read` 回传 `{status,sourceFilePath,headers,valuesByField}`、valuesByField=`{field:string[]}`（封顶后须逐字节一致）。
- 风险：
  - 🔴 隔离铁律：注意 `toolbox-stream-io.js:34` 已 require streaming-xlsx-reader → 新通道只复用其 `writeRowsStreamed`（写），读全走 big-table-import 原语（R-1）。
  - 🚩 前端零改动：valuesByField 不暴露 truncated 元数据（R-2）。
  - 🔴 小文件零回归：路由 fail-closed + main.js 现有小文件分支一行不改（R-3）。
- 决策：
  - v3.0.9 沿用单主题约定：`docs/iterations/v3.0.9/` 裸文件名 PRD.md + TECHDOC.md（与 v3.0.8 一致）。
  - 新通道读路径全走 `big-table-import/` 原语，仅复用 `toolbox-stream-io.js writeRowsStreamed`（写），不复用其读路径（不碰 streaming-xlsx-reader）。
  - 默认不改 `toolbox.js createValuesByFieldAccumulator`（小文件通道仍无界、去重值 ≤N 等价），新通道独立用 `bounded-values-accumulator.js`（OPEN-T1 待 Dev 拍板是否统一）。

### 2026-06-18（Phase 1 实施完成 + team-lead 核验）

- T1~T7 全部完成并由 team-lead 逐一独立核验（不轻信 agent 汇报，`feedback_background_agent_unreliable`）：读模块源码 + 跑各自单测 + require 级隔离铁律 grep + main.js 逐行 diff。
- **三条红线全清**：① 🔴 新通道 5+2 模块零 `require streaming-xlsx-reader`、该文件零改动；② 🚩 前端 4 文件（`renderer*.js`/`preload.js`）零改动、未重跑 preview；③ 🔴 main.js 现有小文件分支字节级未动（T6 仅在两 handler 入口加 `shouldUseLargeChannel` 分叉 + export try/finally 清理）。
- T1 review 抓出并修正参差短行边界 bug：列冲突判据由 `length !== headerLength` 收窄为 `length > headerLength`（参差续页首数据行尾部空列 trim 后变短，旧判据误抛 `ToolboxHeaderMismatchError`）+ 补 2 测。
- OPEN-T2/T3 落地：exportFilter 采方案 (a) peek 表头 O(1) 早退（不改 `writeRowsStreamed` 签名）；`writeRowsStreamed` require 链（exceljs + file-service）确认 electron-free、worker 内 require 安全（streaming-xlsx-reader 传递性加载但本通道从不调用，纯加载无害）。
- 质量门：`npm run release-check` 全绿（unit + 35 集成脚本含 T7 700 万行多 sheet 端到端 + 内存恒定断言 + smoke 全模块 PASS）；`/check-vars` 仅命中 `normalizeCell`（只读复用自 `file-service/common`、同语义）、无 Critical/Runtime-state/Risk-sensitive 命中。

### 2026-06-18（codex review + team-lead self-review 修复，PR #79）

- 提 PR #79（v3.0.9 → main）后按「无 P4 以上 finding」标准做 codex review（`codex exec review --base main`）+ team-lead self-review。codex 报 3 个 finding（P2/P2/P3）+ self-review SR-1（与 codex P3 独立撞车），全部修复 + 补单测，复跑 release-check exit 0（unit 3137 + 35 集成 + smoke）：
  - **[P2]** `toolbox-large-split-router.js`：单 sheet 但 sharedStrings 解压 ≥1.2GB（高基数长文本）原落普通通道 → `streaming-xlsx-reader` JSZip 全量载 SST → OOM 且【永不到达】worker SST 护栏；`shouldUseLargeChannel` 判据纳入 `xl/sharedStrings.xml` 尺寸（`SHARED_STRINGS_LARGE_BYTES` 对齐 worker `SHARED_STRINGS_UNCOMPRESSED_LIMIT` 1.2GB），超阈值走大通道可解释拒绝。+2 测。
  - **[P2]** `split-export-filter.js peekNormalizedHeaders`：`__stopParsing` 仅停当前 sheet 的 stream，多 sheet 下 `streamLogicalTableRows` 主循环仍读后续 sheet（peek 退化为近全量扫、对 700 万行多 sheet ~翻倍 I/O）；拿表头即置内部停扫令牌（与调用方 cancelToken 兼容）使主循环 sheet 边界 break，恢复真 O(1)。+2 测（reader 级 cancel-in-header 用 S2 列冲突作误扫探针 + peek 多 sheet 不误扫）。
  - **[P3]/SR-1** `main.js toolbox:split:read` 大通道：空文件 `scanFields` 回 `headers=null` 却报 `success` → 渲染层强转空表头、开无列可选弹框；改与小文件路径（`readHeaderRowStreamed` 抛 `ToolboxStreamEmptyError` → `toolboxFailureResult`）逐字节对齐回 `failed`「文件为空或不可读，请重新导入」。空→null 后端行为已由 `split-scan-fields.test:187` 覆盖。
- self-review 另记 2 个 P4（不阻塞、本 PR 不修）：① 小的「多 sheet」文件现也路由进大通道（按设计 = 修 v3.0.8 §12.7 F1 旧「只读 sheet1」缺陷，故"小文件零回归"精确为"**单 sheet** 小文件零回归"；异构多 tab 文件转多 sheet 续页语义）；② 字段缺失文案大通道（「字段「X」不在表头中…」）与小文件（「源文件中找不到字段「X」」）略不一致（字段恒来自下拉、极边缘）。
- backlog 三角分诊：仅 **B20**（split:export 半）在本 PR 范围内已修；其余 P3+ 均与本通道正交——资金红线需独立 review（B17/B18/B14/B5/B8/B11）/ 大改有独立 spec（B9/B7/B10/B6）/ 前端项违反零改动（B12）/ 测试基建（B19/B13/B4/B3/B2/B1），不折叠进本 PR（rule 5 小批次 + 隔离纪律）。

### 可沉淀知识

- [ ] 「隔离新通道复用旧原语」范式：复用底层 zip/scan 原语 + worker 模板，绕开 schema 强耦合的整引擎 + 绕开资金红线读取器（streaming-xlsx-reader）——可沉淀为「在不碰资金红线复用文件前提下新建隔离大文件通道」的标准做法。
- [ ] 路由判定「只用不读文件体的 collectEntrySizes、禁用全读 buffer 的 readXlsxSheetMetaLite」——大文件路由探针选型经验（探针自身不能 OOM）。

---

## 十三、N+5、Open Technical Questions

| # | 问题 | 处理 |
|---|------|------|
| OPEN-1（PRD §十）| 高基数列下拉只显示前 N=1000 个值、无截断提示（前端零改动代价）| 🚩 **待用户确认可接受**；按字段拆通常用低基数维度，影响有限 |
| OPEN-2（PRD §十）| sharedStrings 悲观 1GB+ 全唯一长文本文件 v1 不支持（可解释拒绝）| 🚩 **待用户确认 v1 拒绝可接受**；spill-to-disk 留 v2（会击穿 row-scanner 性能核心）|
| OPEN-3（PRD §十）| Phase 2 进度走后端 activity log、无 UI / 无 cancel 按钮（前端零改动）| 🚩 **待用户确认可接受**；worker 内部 cancel 能力保留作进程退出兜底 |
| OPEN-T1 | 是否让小文件通道也切到封顶累加器（统一口径）| Dev 拍板。**默认不切**（新通道独立用新模块，去重值 ≤N 等价、小文件零回归）；若切则改 `toolbox.js` 属 `/check-vars` 硬节点 + 「≤N 逐字节一致」回归测试 |
| OPEN-T2 | exportFilter 如何让 `writeRowsStreamed` 在数据行前拿到 `normalizedHeaders` | 推荐方案 (a)：先用 multi-sheet-reader「仅 peek 表头」（`scanSheetRows` `__stopParsing` 表头行后早退，成本 O(1)）拿表头，再正式流式过滤写（不改 `writeRowsStreamed` 签名）。Dev 实施期定 |
| OPEN-T3 | `writeRowsStreamed`（`toolbox-stream-io.js`）在 worker 内 require 是否安全（纯 Node）| Dev 确认其依赖链（exceljs + file-service）无 Electron 依赖即可在 worker require；若顶部 require 了 electron 相关需抽纯 Node 写函数 |
| OPEN-T4 | N=1000 / maxTotalDistinct=200000 / 1.5GB / sharedStrings 1.2GB 阈值具体取值 | 当前取 plan 建议值；实施期按真实数据微调 |

---

### 核实记录（与 plan 的出入）

> PM 当面 grep 核实复用点，与 plan 的对照结论：

- **无重大出入**。plan 引用的所有复用点（`openZipWithEntries` / `locateSheets` / `loadSharedStrings` / `scanSheetRows` / `writeRowsStreamed` / `collectEntrySizes` / `createValuesByFieldAccumulator` / `createRowFilter` / `engine-worker-entry` / `big-table-import-dispatch` / `registerToolboxHandlers` / `toolbox:split:read` / `toolbox:split:export`）全部真实存在；行号与 plan 标注基本一致（plan 标的 `:12871/:12947/:12981`、`writeRowsStreamed:348`、`createValuesByFieldAccumulator:186`、`createRowFilter:228`、`collectEntrySizes`、`openZipWithEntries:61`、`locateSheets:111`、`loadSharedStrings:212`、`scanSheetRows:427` 与现状实测吻合）。
- **一处补充事实**（plan 未明说，本 TechDoc 补强 R-1 / §8.2）：现 `toolbox-stream-io.js:34` **已 require** `streaming-xlsx-reader.js readXlsxStreamed`。故「绝不碰 streaming-xlsx-reader」要求新通道**只复用 `toolbox-stream-io.js` 的写路径 `writeRowsStreamed`**、读路径全走 `big-table-import/` 原语，不能图省事整体复用 `toolbox-stream-io.js` 的读函数（`streamDataRows`/`readHeaderRowStreamed` 内部依赖 streaming reader + canStreamXlsx 多 sheet 落回 readRows）。
- **一处现状基线确认**（plan 隐含、本 TechDoc 明示）：v3.0.8 §12.7 F1 已给工具箱加 `canStreamXlsx`「物理单 sheet」护栏 → 多 sheet 落回 `readRows`（SheetJS 全量）= 800MB OOM 的直接根因；v3.0.9 大通道正是接管这条「多 sheet / 大文件」分支。
