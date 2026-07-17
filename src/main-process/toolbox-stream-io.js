// v3.0.8 BUG3：工具箱🧰（合表 / 拆表）流式读写封装——修 30 万行级大文件 OOM 闪退。
//
// 背景：
//   工具箱原 handler（src/main.js toolbox:merge / split:read / split:export）全量 readRows 把整个
//   文件物化成 aoa 再变换、再 writeWorkbookRows（SheetJS xlsx-js-style 全量构 workbook）。
//   30 万行 × 数十列时 readRows（SheetJS 全量解压 + sheet_to_json）与 writeFile 双双内存峰值 >1GB，
//   Electron 主进程 OOM 闪退 / RangeError。
//
//   本模块改流式：
//     - 读：.xlsx 复用自研 readXlsxStreamed（边解压 zip entry 边扫 <row>，内存常数）；.csv/.xls 回退全量 readRows
//       （纯文本 CSV / OLE2 二进制 xls 不撞 OOM，且流式引擎不支持二者）。
//     - 写：ExcelJS.stream.xlsx.WorkbookWriter 逐行 addRow().commit()（照搬
//       src/main-process/acquiring-bill-currency-writer.js:128 范式），内存常数；超 Excel 单 sheet
//       数据行上限（1,048,575）自动开 sub-sheet (2)(3)（照搬同文件 :171-180）。
//
// 决策（用户拍板，务必遵守）：
//   ① 写侧【保留现状 by-name 格式】——输出与现状 writeWorkbookRows 完全一致：
//      对 Credit Amount/Debit Amount/Balance 套数字格式、BillDate/ValueDate 套日期 serial、
//      MerchantId/Channel/Currency 套文本，表头行 Courier New 10pt。
//      本模块 useStyles:true + 移植 src/backend/file-service/writers.js:66-143 applyExportFieldFormats
//      的 by-name 单行格式化逻辑（numericFields/dateFields/textFields 按表头名套格式）。
//   ② 合并合计超 Excel 单页上限时【自动分 sheet】。
//
// 🔴 表头/过滤口径与 readers.js 必须 byte 级一致（否则流式 vs 全量的表头校验/去重/过滤结论分叉）：
//   - readRows 用 SheetJS sheet_to_json(header:1, blankrows:false, defval:'')：丢「物理无任何单元格的空行」，
//     保留「有显式空单元格的行」并按 sheet 列宽补 ''。对合并/过滤的「消费语义」而言，等价于「丢全空（isRowMeaningful=false）行」
//     ——空行在合并里只贡献空内容、在过滤里命中不了任何非空值。故流式侧用 isRowMeaningful 过滤即与 readRows 输出口径同源。
//   - extractHeaders：readRows 的第 0 行 → 取到「最后一个非空单元格」止 → 每格 normalizeCell（trim）。
//     本模块 readHeaderRowStreamed 复刻：首个 isRowMeaningful 行 → trimTrailingEmptyCells → normalizeCell。

const fs = require('node:fs');
const path = require('node:path');
const ExcelJS = require('exceljs');
const { readXlsxStreamed } = require('../backend/pending-import/streaming-xlsx-reader');
const {
  isRowMeaningful,
  normalizeCell,
  trimTrailingEmptyCells
} = require('../backend/file-service/common');
const { readRows, extractHeaders, readXlsxSheetMetaLite } = require('../backend/file-service/readers');
const { WATERMARK_AUTHOR } = require('./workbook-watermark');
// toolbox 纯逻辑（合表表头校验 / 全量合并 / 全量去重 / 全量过滤 + 流式增量去重/过滤）——
//   去 dialog 化的流式组装函数与单/多文件拆分共用，
//   使 main.js handler 与集成脚本走「同一份流式组装逻辑」（单一真理来源，消除平行复刻）。
//   toolbox.js 不 require 本模块 → 无循环依赖。
const {
  assertHeadersIdentical,
  mergeAoaRows,
  computeValuesByField,
  filterRowsByFieldValues,
  createValuesByFieldAccumulator,
  createRowFilter
} = require('./toolbox');
// by-name 格式化用的 4 个 formatter（与 writers.js applyExportFieldFormats 注入的同一组单一真理来源）。
//   决策①：输出与现状 writeWorkbookRows 完全一致——直接复用 normalizers 实现，不另起一份。
const {
  inferDateCellFormat,
  parseDateValue,
  parseNumericValue,
  toExcelSerial
} = require('../backend/file-service/normalizers');

const DEFAULT_FORMATTERS = { inferDateCellFormat, parseDateValue, parseNumericValue, toExcelSerial };

// Excel 单 sheet 显示硬上限 = 1,048,576 行（含表头）→ 数据 1,048,575 行。
//   与 src/main-process/acquiring-bill-currency-writer.js:40 同源（Microsoft 自 Excel 2007 起硬限制，xlsx row r-attr 上限 2^20）。
const MAX_DATA_ROWS_PER_SHEET = 1048575;

// 流式读单文件「数据行」时每行解析的固定列宽上界——须 ≥ 任何表格可能的列数，避免宽表被截断。
//   工具箱面向任意 Excel/CSV（非 31 列银行账单专表），取一个足够大的上界。
const TOOLBOX_MAX_COL_COUNT = 1024;

// 流式读「表头行」时的早停扫描上界——只需文件头部前若干行即可命中首个有意义行（= 表头）。
//   给 256 行余量：覆盖极端「文件前若干行全空（前导空行）」也能扫到首个有意义行；读够即 destroy stream，
//   不全量扫文件（避免每文件被读两遍中「读表头」这遍退化为全量）。见 readHeaderRowStreamed。
const TOOLBOX_HEADER_SCAN_MAX_ROWS = 256;

// ============================================================
// 读侧
// ============================================================

// 是否走流式引擎：仅 .xlsx（readXlsxStreamed 读 xl/worksheets/sheet1.xml）。.csv/.xls 回退全量 readRows。
//   ⚠️ 这是「按 API 能力」的粗筛——多 sheet 乱序场景还须叠加物理单 sheet 护栏，见 canStreamXlsx。
function isStreamableXlsx(filePath) {
  return path.extname(filePath).toLowerCase() === '.xlsx';
}

// 🔴 F1（PR#78 review）：物理单 sheet 护栏——只对「物理单 sheet」的 .xlsx 走流式，多 sheet 一律回退全量 readRows。
//   分叉根因：流式引擎 readXlsxStreamed 硬编码只读物理 part `xl/worksheets/sheet1.xml`；而全量 readRows 读
//   SheetJS workbook.SheetNames[0]（= Excel 里显示顺序第一个 tab）。当文件 tab 顺序 ≠ 物理 part 命名顺序
//   （workbook.xml 里 <sheet> 元素顺序被打乱）时，SheetNames[0] 可能指向 sheet2.xml/sheet3.xml，两条路径读到
//   不同 sheet → 工具箱合并/拆分静默读错 sheet（相对 BUG3 之前旧工具箱走 readRows 读 SheetNames[0] 的行为回归）。
//   故对多 sheet .xlsx 不走流式、回退 readRows（与 SheetNames[0] 同源，正确）。物理单 sheet 时 sheet1.xml 必 =
//   SheetNames[0]（唯一一张），两路径等价，方可流式（保住 BUG3 的 OOM 修复）。
//   本护栏与 detector 路径既有护栏同款（src/backend/file-service/readers.js readXlsxSheetMetaLite +
//   src/main.js detectTableType 只对物理单 sheet 走流式）——此处把同一道闸补到工具箱。
async function isPhysicallySingleSheetXlsx(filePath) {
  try {
    const { worksheetEntryCount } = await readXlsxSheetMetaLite(filePath);
    return worksheetEntryCount === 1;
  } catch (_e) {
    return false; // 解析失败（非 zip / 缺 workbook.xml / 损坏）→ 不流式、回退全量 readRows（安全）
  }
}

// 工具箱实际「是否走流式」的总闸：扩展名是 .xlsx 且物理单 sheet。
//   多 sheet .xlsx 在此返回 false → streamDataRows / readHeaderRowStreamed 落入 else 分支走 readRows（读 SheetNames[0]）。
async function canStreamXlsx(filePath) {
  return isStreamableXlsx(filePath) && (await isPhysicallySingleSheetXlsx(filePath));
}

// 流式逐行喂「数据行」给 onDataRow（切掉表头行后，其余行原样透传——含中间空行）。
//   onDataRow(cells: string[]): void —— cells 为固定列宽数组（colCount 宽），与 readRows 行「消费语义」一致。
//
// 🔴 行集口径与全量 readRows + mergeAoaRows 对齐（纯行级搬运，不丢中间行）：
//   - 表头 = 首个有意义行（isRowMeaningful；对齐 extractHeaders 取 readRows[0] 且要求其 meaningful 的口径，
//     并跳过极罕见的「文件前导全空行」）。
//   - 数据行 = 表头之后的所有行**原样透传**（不再按 isRowMeaningful 过滤中间空行）。
//     这与全量路径 mergeAoaRows「切首行后复制其余全部行」逐行等价——含 readRows 保留的「显式空单元格行」。
//     （split 链路的中间空行无害：去重 normalizeCell(...)==='' 跳过、过滤 matches 命不中任何非空值。）
//   - 物理无任何单元格的真·空行：readXlsxStreamed 不产 <row>、readRows 的 blankrows:false 同样丢——两侧天然一致。
//   .csv/.xls 回退全量 readRows 后逐行喂（同样切表头行 + 其余原样透传），handler 上层逻辑单一。
//
// 入参：
//   filePath    源文件
//   onDataRow   每个数据行的回调（不含表头行）
//   onHeaderRow 可选——拿到表头行（首个有意义行）时回调一次（cells 原始未 normalize；调用方按需 normalize）
// 返回：{ headerRow, dataRowCount }
//   headerRow      首个有意义行（原始 cells，未 normalize；空文件为 null）
//   dataRowCount   喂给 onDataRow 的数据行数（= 表头后透传行数）
async function streamDataRows(filePath, onDataRow, onHeaderRow) {
  let headerRow = null;
  let headerSeen = false;
  let dataRowCount = 0;

  const handleRow = (cells) => {
    if (!headerSeen) {
      // 表头取首个有意义行（跳过前导全空行）；表头之前的全空行既不是表头也不是数据行，丢弃。
      if (!isRowMeaningful(cells)) {
        return;
      }
      headerSeen = true;
      headerRow = cells;
      if (typeof onHeaderRow === 'function') {
        onHeaderRow(cells);
      }
      return;
    }
    // 表头之后：原样透传所有行（含中间空行），对齐 mergeAoaRows 的「切首行复制其余」语义。
    dataRowCount += 1;
    onDataRow(cells);
  };

  if (await canStreamXlsx(filePath)) {
    await readXlsxStreamed(
      filePath,
      (cells) => handleRow(cells),
      { colCount: TOOLBOX_MAX_COL_COUNT }
    );
  } else {
    // .csv / .xls 回退：全量 readRows（不撞 OOM 的小/纯文本路径），逐行复用同一切表头 + 透传口径。
    const rows = readRows(filePath);
    for (const row of rows) {
      handleRow(Array.isArray(row) ? row : []);
    }
  }

  return { headerRow, dataRowCount };
}

// 流式读「表头行」——复刻 extractHeaders 口径：首个有意义行 → trimTrailingEmptyCells → normalizeCell（trim）。
//   仅扫到首个有意义行即停（.xlsx 用 readXlsxStreamed maxRows 提前 destroy stream，内存/耗时只取决于前几行）。
//   空文件（无任何有意义行）→ 抛 ToolboxStreamEmptyError，由 handler 归一为 failed（与 readRows 空文件口径一致）。
async function readHeaderRowStreamed(filePath) {
  let headerCells = null;

  if (await canStreamXlsx(filePath)) {
    await readXlsxStreamed(
      filePath,
      (cells) => {
        if (headerCells !== null) {
          return;
        }
        if (isRowMeaningful(cells)) {
          headerCells = cells;
        }
      },
      // 🔴 性能：maxRows 必须给【小正数】上界——readXlsxStreamed 把 maxRows<=0 当「不限制」(streaming-xlsx-reader.js
      //   hasLimit=maxRows>0)，传 0 会全量扫完整文件才返回（每文件被读两遍：读表头一遍 + 读数据行一遍），
      //   30 万行级大文件下读表头这一步本身就慢且无谓。给 256 行上界：命中首个有意义行（含极端「前导若干空行」）后
      //   readXlsxStreamed 读够 256 行即 destroy stream 提前 resolve，内存/耗时只取决于前 256 行。
      { colCount: TOOLBOX_MAX_COL_COUNT, maxRows: TOOLBOX_HEADER_SCAN_MAX_ROWS }
    );
  } else {
    const rows = readRows(filePath);
    for (const row of rows) {
      const cells = Array.isArray(row) ? row : [];
      if (isRowMeaningful(cells)) {
        headerCells = cells;
        break;
      }
    }
  }

  if (headerCells === null) {
    throw new ToolboxStreamEmptyError('文件为空或不可读，请重新导入');
  }

  // extractHeaders 口径：取到最后一个非空单元格止 + 每格 normalizeCell。
  return trimTrailingEmptyCells(headerCells).map((cell) => normalizeCell(cell));
}

// 空文件专用错误——handler 据 name / message 归一为 {status:'failed'}（与 readers.js 空文件文案一致）。
class ToolboxStreamEmptyError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ToolboxStreamEmptyError';
  }
}

// ============================================================
// 写侧（决策①：by-name 格式，输出与现状 writeWorkbookRows 完全一致）
// ============================================================

// 移植 src/backend/file-service/writers.js:36-64 buildNumericCellValue —— 数字字段单元格值构造：
//   - 有效数字 >15 位 → 文本（z:'@'），防 Excel 15 位精度截断（如长卡号/订单号被当数字）。
//   - 解析不出数字 → 返回 null（调用方降级为「按文本原样写」，与全量路径 worksheet[addr]=undefined 时
//     ExcelJS 行为对齐：全量路径 buildNumericCellValue 返回 null 时 return 不覆盖 aoa_to_sheet 的原值，
//     即保留 aoa 原始字符串；流式无 aoa 兜底，故显式按文本原样写）。
//   - ≤2 位小数 → 数字 + z:'0.00'；>2 位小数 → 数字（不套 z，保留原始精度显示）。
function countSignificantDigitsFromString(str) {
  return str.replace(/[^0-9]/g, '').replace(/^0+/, '').length;
}
function hasMoreThanTwoDecimalsFromString(str) {
  const dotIndex = str.indexOf('.');
  if (dotIndex < 0) return false;
  return str.length - dotIndex - 1 > 2;
}
function buildNumericCellSpec(rawStringValue, parseNumericValue) {
  const str = String(rawStringValue || '');
  if (countSignificantDigitsFromString(str) > 15) {
    return { type: 'text', value: str };
  }
  const numericValue = parseNumericValue(str);
  if (numericValue === null) {
    return null;
  }
  if (hasMoreThanTwoDecimalsFromString(str)) {
    return { type: 'number', value: numericValue, numFmt: null };
  }
  return { type: 'number', value: numericValue, numFmt: '0.00' };
}

// 与 writers.js applyExportFieldFormats 同源的 by-name 字段分组（大小写敏感，normalizeCell 比对）。
const NUMERIC_FIELDS = ['Balance', 'Credit Amount', 'Debit Amount'];
const DATE_FIELDS = ['BillDate', 'ValueDate'];
const TEXT_FIELDS = ['MerchantId', 'Channel', 'Currency'];

// 由 normalize 后的表头行构造「列索引 → 格式类别」映射。
//   同名表头重复时全部纳入（与 writers.js fieldIndexMap 一致：每个匹配列都套格式）。
function buildColumnFormatPlan(normalizedHeaderRow) {
  const plan = new Map(); // colIdx -> 'numeric' | 'date' | 'text'
  normalizedHeaderRow.forEach((header, colIdx) => {
    if (NUMERIC_FIELDS.includes(header)) {
      plan.set(colIdx, 'numeric');
    } else if (DATE_FIELDS.includes(header)) {
      plan.set(colIdx, 'date');
    } else if (TEXT_FIELDS.includes(header)) {
      plan.set(colIdx, 'text');
    }
  });
  return plan;
}

// 把一行原始 cells 按 formatPlan + formatters 转成 ExcelJS 行值数组 + 逐列样式补丁。
//   返回 { values: any[], patches: Array<{colIdx, numFmt}> }
//     values  传给 sheet.addRow（数字字段为 number、日期字段为 Excel serial number、其余为原始字符串）
//     patches addRow 后逐个 cell.numFmt 赋值（ExcelJS 流式无法在 addRow 时带 numFmt）
//   未命中任何 by-name 字段的列：原样写字符串（与全量路径「aoa_to_sheet 原值、不覆盖」一致）。
function buildFormattedRow(rawCells, formatPlan, formatters) {
  const { parseDateValue, parseNumericValue, toExcelSerial, inferDateCellFormat } = formatters;
  const len = rawCells.length;
  const values = new Array(len);
  const patches = [];

  for (let colIdx = 0; colIdx < len; colIdx += 1) {
    const rawValue = rawCells[colIdx];
    const category = formatPlan.get(colIdx);

    if (!category) {
      values[colIdx] = rawValue;
      continue;
    }

    // 空值：与 writers.js 一致——空字符串/ null / undefined 不套格式（保留 aoa 原值，即空）。
    if (rawValue === null || rawValue === undefined || rawValue === '') {
      values[colIdx] = rawValue;
      continue;
    }

    if (category === 'numeric') {
      const spec = buildNumericCellSpec(rawValue, parseNumericValue);
      if (!spec) {
        values[colIdx] = rawValue; // 解析不出数字 → 原样字符串
      } else if (spec.type === 'text') {
        values[colIdx] = spec.value;
        patches.push({ colIdx, numFmt: '@' });
      } else {
        values[colIdx] = spec.value;
        if (spec.numFmt) {
          patches.push({ colIdx, numFmt: spec.numFmt });
        }
      }
      continue;
    }

    if (category === 'date') {
      const dateValue = parseDateValue(rawValue);
      if (!dateValue) {
        values[colIdx] = rawValue; // 解析不出日期 → 原样字符串（与 writers.js 一致）
      } else {
        values[colIdx] = toExcelSerial(dateValue);
        patches.push({ colIdx, numFmt: inferDateCellFormat(rawValue) });
      }
      continue;
    }

    // text
    values[colIdx] = String(rawValue);
    patches.push({ colIdx, numFmt: '@' });
  }

  return { values, patches };
}

async function closeWorkbookOutputStream(writer) {
  const outputStream = writer && writer.stream;
  try {
    if (writer && writer.zip && typeof writer.zip.abort === 'function') {
      await writer.zip.abort();
    }
  } catch (_e) { /* abort continues by closing the output stream */ }

  if (!outputStream || outputStream.closed) return;
  await new Promise((resolve) => {
    let finished = false;
    const done = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      outputStream.removeListener('close', done);
      outputStream.removeListener('error', done);
      resolve();
    };
    const timer = setTimeout(done, 2000);
    outputStream.once('close', done);
    outputStream.once('error', done);
    try {
      outputStream.destroy();
      if (outputStream.closed) done();
    } catch (_e) {
      done();
    }
  });
}

async function removeOutputFileWithRetry(filePath) {
  const retryableCodes = new Set(['EBUSY', 'EACCES', 'EPERM']);
  let lastError = null;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      await fs.promises.rm(filePath, { force: true });
      return;
    } catch (error) {
      lastError = error;
      if (!retryableCodes.has(error && error.code) || attempt === 5) break;
      await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
    }
  }
  throw new Error(`清理临时输出失败：${filePath}（${lastError && lastError.message ? lastError.message : String(lastError)}）`);
}

// 把表头行 + 数据行逐行流式写入 ExcelJS WorkbookWriter，超 MAX_DATA_ROWS_PER_SHEET 自动开 sub-sheet (2)(3)。
//   - 决策①：useStyles:true + by-name 格式（数字/日期/文本）+ 表头 Courier New 10pt。
//   - 决策②：自动分 sheet（照搬 acquiring-bill-currency-writer.js:171-180）。
//
// 入参：
//   savePath           输出 .xlsx 路径
//   normalizedHeaders  normalize 后的表头行（extractHeaders / readHeaderRowStreamed 结果）
//   sheetBaseName      首 sheet 名（缺省 'COMMON'）
//   writeDataRows      async (emit) => {...}：调用方在内部流式读源 → 对每个「命中的原始数据行 cells」调用 emit(cells)
//   formatters         { parseDateValue, parseNumericValue, toExcelSerial, inferDateCellFormat }
//   maxRowsPerSheet    分 sheet 阈值（缺省 = MAX_DATA_ROWS_PER_SHEET；仅单测传小值确定性验证分 sheet）
// 返回：{ filePath, dataRowCount, sheetCount }
function createRowsStreamWriter({
  savePath,
  normalizedHeaders,
  sheetBaseName = 'COMMON',
  formatters = DEFAULT_FORMATTERS,
  // 分 sheet 阈值——缺省 = Excel 单 sheet 数据行硬上限。仅单测用极小值确定性验证分 sheet 逻辑（生产恒用缺省）。
  maxRowsPerSheet = MAX_DATA_ROWS_PER_SHEET
}) {
  fs.mkdirSync(path.dirname(savePath), { recursive: true });

  const writer = new ExcelJS.stream.xlsx.WorkbookWriter({
    filename: savePath,
    useStyles: true,
    useSharedStrings: false
  });
  // 与现状所有 xlsx 导出一致的 workbook 元数据 watermark（writers.js 走 applyWatermark；流式 WorkbookWriter
  //   直接设 lastModifiedBy，同 acquiring-bill-currency-writer.js:133 范式）。
  writer.lastModifiedBy = WATERMARK_AUTHOR;

  const formatPlan = buildColumnFormatPlan(normalizedHeaders);
  const headerValues = normalizedHeaders.slice();

  // 表头行（Courier New 10pt，与 writers.js applyHeaderRowFont 一致）。
  const HEADER_FONT = { name: 'Courier New', size: 10 };

  let sheet = writer.addWorksheet(sheetBaseName);
  const commitHeader = (ws) => {
    const headerRow = ws.addRow(headerValues);
    for (let c = 1; c <= headerValues.length; c += 1) {
      headerRow.getCell(c).font = HEADER_FONT;
    }
    headerRow.commit();
  };
  commitHeader(sheet);

  let curSheetRowCount = 0;
  let subSheetIndex = 1;
  let sheetCount = 1;
  let dataRowCount = 0;

  // 🔴 输出宽度锚点 = 表头列数（commitHeader 写出的 headerValues.length）。见下方 emit 的「裁到表头宽」注释。
  const headerWidth = headerValues.length;

  const emit = (rawCells) => {
    // 当前 sheet 数据行满阈值 → commit + 开新 sub-sheet（加后缀 (2)(3)）+ 重写表头。
    if (curSheetRowCount >= maxRowsPerSheet) {
      sheet.commit();
      subSheetIndex += 1;
      sheetCount += 1;
      const subName = sanitizeSheetName(`${sheetBaseName}(${subSheetIndex})`);
      sheet = writer.addWorksheet(subName);
      commitHeader(sheet);
      curSheetRowCount = 0;
    }
    // 🔴 输出宽度对齐全量路径，且【不丢全空行 / 不裁尾部空白 cell】：
    //   流式 .xlsx reader 把每行补到 colCount(1024) 宽（parseRowXml: new Array(1024).fill('')），其中
    //   超出真实内容的尾部全是 '' padding。直接写会让 sheet 宽达 1024 列、且与全量 aoa_to_sheet 输出分叉。
    //
    //   旧实现用 trimTrailingEmptyCells（normalizeCell/trim 判空裁尾）过度裁剪，导致 vs 全量 writeWorkbookRows 分叉：
    //     - 整行全空的数据行被裁成 [] → addRow([]) → SheetJS blankrows:false readback 直接丢（全量保留空行）；
    //     - 尾部「纯空白」cell（如 '  '）被 trim 当空裁掉（全量保留字面值 '  '）；
    //     → 成功日志「数据行数」(dataRowCount，含全空行) 与产物可读行数对不上。
    //
    //   正确口径：裁到「表头列数」宽——去掉超出 headerWidth 的 reader padding，但 headerWidth 以内的所有 cell
    //   （含空串 / 纯空白）原样保留、全空行不丢（保留 headerWidth 个空 cell）。
    //   罕见异常数据：某行真实非空内容超过 headerWidth → 保留到该行最末非 padding（最末非空）列，
    //   即 keepWidth = max(headerWidth, 最末非空索引+1)；与全量「aoa_to_sheet 按最宽行定宽 + 窄行补空」对齐
    //   （ExcelJS addRow 对空串 cell 同样产 {t=s,v=''} 对象，故 !ref 宽度与 blankrows readback 与全量逐 cell 一致）。
    const cells = Array.isArray(rawCells) ? rawCells : [];
    const keepWidth = computeKeepWidth(cells, headerWidth);
    const trimmed = cells.slice(0, keepWidth);
    const { values, patches } = buildFormattedRow(trimmed, formatPlan, formatters);
    const row = sheet.addRow(values);
    for (const { colIdx, numFmt } of patches) {
      // ExcelJS cell 列号 1-based。
      row.getCell(colIdx + 1).numFmt = numFmt;
    }
    row.commit();
    curSheetRowCount += 1;
    dataRowCount += 1;
  };

  let state = 'open';
  return {
    emit,
    get dataRowCount() {
      return dataRowCount;
    },
    get sheetCount() {
      return sheetCount;
    },
    async commit() {
      if (state !== 'open') {
        throw new Error(`工具箱流式输出已结束：${savePath}`);
      }
      state = 'committing';
      try {
        await sheet.commit();
        await writer.commit();
        state = 'committed';
        return { filePath: savePath, dataRowCount, sheetCount };
      } catch (error) {
        state = 'failed';
        throw error;
      }
    },
    async abort() {
      if (state === 'aborted') return;
      const previousState = state;
      state = 'aborted';
      if (previousState !== 'committed') {
        await closeWorkbookOutputStream(writer);
      }
      await removeOutputFileWithRetry(savePath);
    }
  };
}

async function writeRowsStreamed({
  savePath,
  normalizedHeaders,
  sheetBaseName = 'COMMON',
  writeDataRows,
  formatters = DEFAULT_FORMATTERS,
  maxRowsPerSheet = MAX_DATA_ROWS_PER_SHEET
}) {
  const streamWriter = createRowsStreamWriter({
    savePath,
    normalizedHeaders,
    sheetBaseName,
    formatters,
    maxRowsPerSheet
  });
  try {
    await writeDataRows(streamWriter.emit);
    return await streamWriter.commit();
  } catch (error) {
    try {
      await streamWriter.abort();
    } catch (cleanupError) {
      if (error && typeof error === 'object') {
        error.detailLines = [
          ...(Array.isArray(error.detailLines) ? error.detailLines : []),
          cleanupError.message || String(cleanupError)
        ];
      }
    }
    throw error;
  }
}

// 多文件拆分写侧：所有输出 writer 同时接收一次源数据遍历，允许同一行进入多个文件。
// outputs: [{ savePath, matches(cells), sheetBaseName? }]
async function writeRowsToMultipleFilesStreamed({
  outputs,
  normalizedHeaders,
  writeDataRows,
  formatters = DEFAULT_FORMATTERS,
  maxRowsPerSheet = MAX_DATA_ROWS_PER_SHEET
}) {
  const safeOutputs = Array.isArray(outputs) ? outputs : [];
  if (safeOutputs.length === 0) {
    throw new Error('未提供多文件拆分输出');
  }
  const writers = [];

  try {
    for (const output of safeOutputs) {
      writers.push({
        output,
        writer: createRowsStreamWriter({
          savePath: output.savePath,
          normalizedHeaders,
          sheetBaseName: output.sheetBaseName || 'COMMON',
          formatters,
          maxRowsPerSheet
        })
      });
    }

    await writeDataRows((rawCells) => {
      for (const entry of writers) {
        if (typeof entry.output.matches === 'function' && entry.output.matches(rawCells)) {
          entry.writer.emit(rawCells);
        }
      }
    });

    const results = [];
    for (const entry of writers) {
      results.push(await entry.writer.commit());
    }
    return results;
  } catch (error) {
    const cleanupResults = await Promise.allSettled(writers.map((entry) => entry.writer.abort()));
    const cleanupErrors = cleanupResults
      .filter((result) => result.status === 'rejected')
      .map((result) => result.reason && result.reason.message ? result.reason.message : String(result.reason));
    const finalError = error && typeof error === 'object' ? error : new Error(String(error));
    if (cleanupErrors.length > 0) {
      finalError.detailLines = [
        ...(Array.isArray(finalError.detailLines) ? finalError.detailLines : []),
        ...cleanupErrors
      ];
      finalError.preserveTemporaryFiles = true;
    }
    throw finalError;
  }
}

// 防御性 sanitize sheet 名（Excel 禁用 / \ * ? [ ] :，长度 ≤ 31）——与 acquiring-bill-currency-writer.js:110 同源。
function sanitizeSheetName(name) {
  return String(name).replace(/[\/\\*?\[\]:]/g, '-').slice(0, 31);
}

// 计算一行数据写出时保留的列宽（emit 用）：
//   keepWidth = max(headerWidth, 最末非 padding cell 索引 + 1)
//   - 常态：行真实内容 ≤ headerWidth（reader parseRowXml 把尾部补字面 '' padding）→ keepWidth = headerWidth
//     → 裁掉 headerWidth 以外的 padding，但保留 headerWidth 以内全部 cell（含空串 / 纯空白），全空行保留 headerWidth 个空 cell。
//   - 罕见异常：行真实内容超过 headerWidth（最末非 padding 列 > headerWidth-1）→ keepWidth 扩到该列，保住超宽真实数据
//     （对齐全量 aoa_to_sheet「按最宽行定宽」：超宽行的真实尾 cell 会让 !ref 变宽，窄行补空）。
//   判 padding 口径：reader 的 padding 是【字面空串 ''】，而源文件的纯空白 cell（如 '  '）字面非空、是真实内容
//     （全量 aoa_to_sheet 会为 '  ' 产 {t=s,v='  '} 并撑宽 !ref）。故这里用「字面 !== ''」判非 padding，
//     使纯空白尾 cell 与全量逐 cell 一致地保真（不能用 normalizeCell/trim，否则 '  ' 会被当 padding 误裁）。
function computeKeepWidth(cells, headerWidth) {
  let lastNonPadding = -1;
  for (let i = cells.length - 1; i >= 0; i -= 1) {
    const cell = cells[i];
    // 字面非空串即非 padding（null/undefined 经 reader 不会出现，防御性按 padding 处理）。
    if (cell !== '' && cell !== null && cell !== undefined) {
      lastNonPadding = i;
      break;
    }
  }
  return Math.max(headerWidth, lastNonPadding + 1);
}

module.exports = {
  MAX_DATA_ROWS_PER_SHEET,
  TOOLBOX_MAX_COL_COUNT,
  TOOLBOX_HEADER_SCAN_MAX_ROWS,
  DEFAULT_FORMATTERS,
  ToolboxStreamEmptyError,
  isStreamableXlsx,
  canStreamXlsx,
  isPhysicallySingleSheetXlsx,
  streamDataRows,
  readHeaderRowStreamed,
  createRowsStreamWriter,
  writeRowsStreamed,
  writeRowsToMultipleFilesStreamed,
  // 导出纯函数供单测
  buildColumnFormatPlan,
  buildFormattedRow,
  buildNumericCellSpec,
  computeKeepWidth,
  sanitizeSheetName
};
