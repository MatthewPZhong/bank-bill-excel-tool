// v3.0.9 需求1 · T1：工具箱大文件按字段拆分 —— multi-sheet-reader（多 sheet 逻辑表流式读）
//
// 职责：把一个 .xlsx 的多个物理 sheet（按 locateSheets「显示序」）拼成一张逻辑表流式读，
//   通过 onHeaderRow(headers)（一次）+ onDataRow(values)（每数据行）回调透传，内存恒定。
//
//   streamLogicalTableRows(filePath, { onHeaderRow, onDataRow, cancelToken }):
//     ① openZipWithEntries（autoClose:false，caller 显式 close）+ locateSheets 拿按显示序的 [{name,entryPath}]。
//     ② loadSharedStrings 在「逐 sheet 循环外」加载一次（不每 sheet 重载）。
//     ③ 逐 sheet openReadStream + scanSheetRows 流式扫行；本模块按「多 sheet 续页语义」识别表头/数据/重复表头。
//
// 🔴 红线（必守）：
//   - 纯 Node、worker 安全：不 require electron / main.js / 任何带 Electron 依赖的 main-process 重模块
//     （本模块将在 worker_threads 内被调用）。
//   - 绝不调用 zip-reader.openWorkbook（它对 ≥2 sheet 显式 throw，本模块要读多 sheet）。
//   - 绝不 import pending-import/streaming-xlsx-reader.js（隔离铁律）。只复用 big-table-import 的
//     zip-reader（openZipWithEntries / locateSheets / loadSharedStrings）+ row-scanner（scanSheetRows）。
//
// 多 sheet 续页语义（TECHDOC v3.0.9 §三③ / PRD §5.1.4，权威）：
//   - 表头 = 第一个「非空」sheet 的首个「有意义行」（按 locateSheets 显示序，非物理 sheetN.xml 编号序）。
//   - 后续 sheet 首个有意义行与表头「归一化全等」→ 跳过（重复表头分页）；否则当数据行。
//   - 列序与表头不一致 → 抛 ToolboxHeaderMismatchError（不做按列名重排）。
//   - ⚠️ 已知边界：数据行「恰等于」表头会被当重复表头跳过（不可避免的语义代价，不视为 bug）。
//   - ⚠️ rowR 跨 sheet 会从 1 重置（scanSheetRows 取各 sheet 自己的 <row r>）——表头判定按「每个 sheet 内
//     首个有意义行」而非全局 rowR===1，否则跨 sheet 误判。
//
// 归一化口径（与现状 src/backend/file-service/common.js + src/main-process/toolbox.js 一致）：
//   - normalizeCell：null/undefined→''，否则 String(v).trim()。
//   - 有意义行：isRowMeaningful（任一 cell normalizeCell !== ''）。注意「不」用 scanSheetRows 的
//     hasAnyCellText（它判 cell 取值 !== ''，对纯空格 cell 会判 true，与 normalizeCell trim 后判空口径分叉）。
//   - 表头 / 列序比对：trimTrailingEmptyCells（切尾部空 cell）→ normalizeCell 逐格，再 JSON.stringify 全等
//     （与 toolbox.js assertHeadersIdentical「列名 + 列序，大小写敏感」同口径）。

const path = require('node:path');
const {
  openZipWithEntries,
  locateSheets,
  loadSharedStrings
} = require('../big-table-import/zip-reader');
const { scanSheetRows } = require('../big-table-import/row-scanner');
const {
  normalizeCell,
  isRowMeaningful,
  trimTrailingEmptyCells
} = require('../file-service/common');
// 列序冲突错误类复用 toolbox.js 的定义（name='ToolboxHeaderMismatchError'，携带 message+detailLines）；
//   handler 据 name 判定后回 {status:'failed'}。toolbox.js 只 require file-service/common（纯 Node），
//   worker 内 require 安全（无 Electron 依赖）。
const { ToolboxHeaderMismatchError } = require('../../main-process/toolbox');

// scanSheetRows 需要 expectedHeaders 决定「数据行」列宽 + 越界裁剪（colIdx >= expectedLen 丢弃）。
//   本模块表头未知前先用一个足够大的上界占位数组，使数据行不被截断、全列解析（valueColumnWhitelist=null）。
//   与 toolbox-stream-io.js TOOLBOX_MAX_COL_COUNT=1024 同口径（工具箱面向任意 Excel/CSV，非定列银行专表）。
const TOOLBOX_MAX_COL_COUNT = 1024;

// 把一行 raw values（scanSheetRows 透传的「按列索引数组」）归一为「逻辑行」：切尾部空 cell + 逐格 normalizeCell。
//   用于表头识别 / 列序比对（与 toolbox.js / common.js 同口径）。返回 string[]。
function normalizeLogicalRow(values) {
  const trimmed = trimTrailingEmptyCells(Array.isArray(values) ? values : []);
  return trimmed.map((cell) => normalizeCell(cell));
}

// 内部早退信号：cancelToken 触发时抛此对象，scanSheetRows 捕获 __stopParsing → resolve（停 stream，不 reject）。
//   外层主循环检测 cancelled 后不再读下一个 sheet。
function makeStopSignal() {
  const e = new Error('__toolbox_multi_sheet_cancelled__');
  e.__stopParsing = true;
  return e;
}

// 流式读多 sheet 逻辑表。
//   入参：
//     filePath  string                       .xlsx 路径
//     onHeaderRow(headers: string[])         逻辑表头确定时回调一次（headers 已 trim + normalizeCell）
//     onDataRow(values: any[])               每条数据行回调；values 是「按列索引的数组」（scanSheetRows 原样透传，不归一化）
//     cancelToken  { cancelled?: boolean }   中途取消（每行检查；触发后 <一行内停当前 sheet 并不再读后续 sheet）
//   返回：{ sheetCount, dataRowCount, headerFound, cancelled }
//
//   🔴 onDataRow 收到的 values 保持「数组」形态（不转对象）——累加器 / filter 按列索引操作（接缝契约）。
//      数据行 values 为定长（TOOLBOX_MAX_COL_COUNT）数组，尾部空 cell 为 ''（与 row-scanner 数据行口径一致）。
async function streamLogicalTableRows(filePath, options = {}) {
  const onHeaderRow = typeof options.onHeaderRow === 'function' ? options.onHeaderRow : null;
  const onDataRow = typeof options.onDataRow === 'function' ? options.onDataRow : null;
  const cancelToken = options.cancelToken && typeof options.cancelToken === 'object' ? options.cancelToken : null;

  const sourceFile = path.basename(filePath);
  const { zip, entries } = await openZipWithEntries(sourceFile, filePath);

  // 逻辑表头状态（跨 sheet 共享）。
  let headerNormalized = null;   // string[]（trim + normalizeCell）；null = 尚未确定
  let headerKey = null;          // JSON.stringify(headerNormalized)，供后续 sheet 全等比对
  let dataRowCount = 0;
  let physicalSheetCount = 0;

  // expectedHeaders 占位：大上界数组（数据行不截断、全列解析）。scanSheetRows 内部只用其 .length。
  const placeholderExpectedHeaders = new Array(TOOLBOX_MAX_COL_COUNT).fill('');

  function isCancelled() {
    return !!(cancelToken && cancelToken.cancelled);
  }

  try {
    const sheets = await locateSheets(zip, entries);   // 按 workbook.xml 显示序；entryPath 经 rels 正解
    physicalSheetCount = sheets.length;

    // 循环外加载 sharedStrings 一次（全 sheet 共享同一串表，不每 sheet 重载）。
    //   优先 SHARED_STRINGS_ENTRY_NAME；缺失（纯 inlineStr）→ loadSharedStrings 返回 []。
    const sharedStrings = await loadSharedStrings(zip, entries.get('xl/sharedStrings.xml') || null);

    for (let s = 0; s < sheets.length; s += 1) {
      if (isCancelled()) break;
      const sheet = sheets[s];
      // entryPath=null（rels 正解失败 / 缺 r:id）→ 该 sheet 无法定位物理 part，跳过（不静默错读其它 sheet）。
      if (!sheet || !sheet.entryPath) continue;
      const sheetEntry = entries.get(sheet.entryPath);
      if (!sheetEntry) continue;

      // 每个 sheet 内「是否已遇到首个有意义行」——表头判定按「每 sheet 内首个有意义行」（rowR 跨 sheet 重置，
      //   不能用全局 rowR===1）。
      let sheetFirstMeaningfulSeen = false;

      const stream = await new Promise((resolve, reject) => {
        zip.openReadStream(sheetEntry, (err, st) => {
          if (err) return reject(err);
          resolve(st);
        });
      });

      await scanSheetRows({
        stream,
        expectedHeaders: placeholderExpectedHeaders,
        sharedStrings,
        // 全列解析（白名单 null）：工具箱无 schema，须取所有列。
        valueColumnWhitelist: null,
        onRow: ({ values }) => {
          // cancelToken：每行检查，触发即抛 __stopParsing 早退（停当前 sheet stream，外层不再读后续 sheet）。
          if (isCancelled()) throw makeStopSignal();

          // 空行（无任何 trim 后非空 cell）→ 静默跳过（对齐 readRows blankrows:false / isRowMeaningful 口径）。
          //   ⚠️ 用 isRowMeaningful（normalizeCell trim）而非 scanSheetRows 的 hasAnyCellText（取值 !==''），
          //   对纯空格 cell 行二者分叉——以现状 common.js 口径为准。
          if (!isRowMeaningful(values)) return;

          if (!sheetFirstMeaningfulSeen) {
            // 本 sheet 的首个有意义行。
            sheetFirstMeaningfulSeen = true;

            if (headerNormalized === null) {
              // 第一个「非空」sheet 的首个有意义行 = 逻辑表头。
              headerNormalized = normalizeLogicalRow(values);
              headerKey = JSON.stringify(headerNormalized);
              if (onHeaderRow) onHeaderRow(headerNormalized.slice());
              return;   // 表头不作数据行
            }

            // 后续 sheet 的首个有意义行：与表头比对。
            const rowNormalized = normalizeLogicalRow(values);
            if (JSON.stringify(rowNormalized) === headerKey) {
              // 归一化全等 → 重复表头分页，跳过。
              //   ⚠️ 已知边界：数据行恰等表头也走这里被跳过（不视为 bug）。
              return;
            }
            // 列序冲突判据：trim 后列数「多于」表头 → 续页 sheet 出现超过逻辑表头的额外列，无法对齐
            //   → 抛 ToolboxHeaderMismatchError（不按名重排）。
            //   ⚠️ 只对「多出列」报错：trim 后列数 ≤ 表头（含相等内容不同 / 更短的参差数据行——尾部空列被 trim 掉）
            //   一律当数据行（与该 sheet 第 2 行起的数据行口径一致，也与全量 aoa「参差短行合法、按最宽定宽」一致）；
            //   若用 `!==` 会把「无重复表头、首行带尾部空列的合法参差数据行」误判为冲突（口径自相矛盾）。
            if (rowNormalized.length > headerNormalized.length) {
              throw new ToolboxHeaderMismatchError(
                `${sourceFile}：sheet「${sheet.name || `(未命名 ${s + 1})`}」首行列数（${rowNormalized.length}）多于逻辑表头（${headerNormalized.length}），出现表头之外的额外列，无法作为同一逻辑表的续页`,
                [
                  `逻辑表头（${headerNormalized.length} 列）：${headerNormalized.join(' | ') || '（空）'}`,
                  `该 sheet 首行（${rowNormalized.length} 列）：${rowNormalized.join(' | ') || '（空）'}`,
                  '多 sheet 续页要求每个 sheet 的列结构不超过首个非空 sheet 的表头（不做按列名重排），请确认后重试。'
                ]
              );
            }
            // trim 后列数 ≤ 表头（内容不同）→ 该 sheet 无重复表头，首行即数据行（参差短行合法）。
            dataRowCount += 1;
            if (onDataRow) onDataRow(values);
            return;
          }

          // sheet 内非首行 → 数据行（原样透传数组，不归一化）。
          dataRowCount += 1;
          if (onDataRow) onDataRow(values);
        }
      });

      if (isCancelled()) break;
    }
  } finally {
    try { zip.close(); } catch (_e) { /* ignore */ }
  }

  return {
    sheetCount: physicalSheetCount,
    dataRowCount,
    headerFound: headerNormalized !== null,
    cancelled: isCancelled()
  };
}

module.exports = {
  streamLogicalTableRows,
  // 导出供单测 / 复用
  TOOLBOX_MAX_COL_COUNT,
  normalizeLogicalRow
};
