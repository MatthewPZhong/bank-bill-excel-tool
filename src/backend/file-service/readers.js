const fs = require('node:fs');
const path = require('node:path');
const XLSX = require('xlsx');
const JSZip = require('jszip');
const {
  FileValidationError,
  SUPPORTED_EXTENSIONS,
  isRowMeaningful,
  normalizeCell,
  trimTrailingEmptyCells
} = require('./common');
// 自研流式 xlsx 读取器（JSZip + nodeStream 增量解码，内存恒定）。
//   仅用于 readMeaningfulRowsHead 的「只读文件头部前 N 行」场景，规避 SheetJS 全量读大文件 OOM。
const { readXlsxStreamed } = require('../pending-import/streaming-xlsx-reader');

function ensureSupportedFile(filePath) {
  const extension = path.extname(filePath).toLowerCase();

  if (!SUPPORTED_EXTENSIONS.has(extension)) {
    throw new FileValidationError('FILE_TYPE', '文件类型错误，请重新导入');
  }
}

function parseCsvText(content, { blankrows = false } = {}) {
  const rows = [];
  let current = [];
  let cell = '';
  let inQuotes = false;
  let i = 0;

  while (i < content.length) {
    const ch = content[i];

    if (inQuotes) {
      if (ch === '"' && content[i + 1] === '"') {
        cell += '"';
        i += 2;
      } else if (ch === '"') {
        inQuotes = false;
        i++;
      } else {
        cell += ch;
        i++;
      }
    } else if (ch === '"') {
      inQuotes = true;
      i++;
    } else if (ch === ',') {
      current.push(cell);
      cell = '';
      i++;
    } else if (ch === '\r' && content[i + 1] === '\n') {
      current.push(cell);
      cell = '';
      rows.push(current);
      current = [];
      i += 2;
    } else if (ch === '\n' || ch === '\r') {
      current.push(cell);
      cell = '';
      rows.push(current);
      current = [];
      i++;
    } else {
      cell += ch;
      i++;
    }
  }

  if (cell || current.length) {
    current.push(cell);
    rows.push(current);
  }

  if (blankrows) {
    return rows;
  }

  return rows.filter((row) => isRowMeaningful(row));
}

// v2.1.16 PR#61 F4：可选 sheetName —— 缺省 = 第一个 sheet（行为与历史完全一致）。
//   传入 sheetName 时读指定 sheet（detector 多 sheet 扫描用）；sheet 不存在抛 FILE_READ。
//   ⚠️ CSV 无 sheet 概念：传 sheetName 也忽略，仍解析整份 CSV（detector 对 CSV 走单次默认读取）。
function readWorkbookRowsUnchecked(filePath, { blankrows = false, sheetName, maxRows = 0 } = {}) {
  ensureSupportedFile(filePath);

  if (!fs.existsSync(filePath) || fs.statSync(filePath).size === 0) {
    throw new FileValidationError('FILE_READ', '文件为空或不可读，请重新导入');
  }

  const rowLimit = Number.isInteger(maxRows) && maxRows > 0 ? maxRows : 0;

  if (path.extname(filePath).toLowerCase() === '.csv') {
    try {
      const raw = fs.readFileSync(filePath);
      // 检测 magic bytes：XLS (OLE2) = D0CF11E0，XLSX (ZIP) = 504B0304
      // 如果 .csv 文件实际是 Excel 二进制格式，跳过 CSV 解析，走 XLSX 库
      const isOLE2 = raw.length >= 4 && raw[0] === 0xD0 && raw[1] === 0xCF && raw[2] === 0x11 && raw[3] === 0xE0;
      const isZIP = raw.length >= 4 && raw[0] === 0x50 && raw[1] === 0x4B && raw[2] === 0x03 && raw[3] === 0x04;
      if (!isOLE2 && !isZIP) {
        const content = raw[0] === 0xEF && raw[1] === 0xBB && raw[2] === 0xBF
          ? raw.subarray(3).toString('utf-8')
          : raw.toString('utf-8');
        const rows = parseCsvText(content, { blankrows });
        return rowLimit > 0 ? rows.slice(0, rowLimit) : rows;
      }
      // 否则 fall through 到下方 XLSX.readFile
    } catch (error) {
      if (error instanceof FileValidationError) {
        throw error;
      }
      throw new FileValidationError('FILE_READ', '文件为空或不可读，请重新导入');
    }
  }

  try {
    const workbook = XLSX.readFile(filePath, {
      cellDates: false,
      dense: true,
      raw: false,
      ...(rowLimit > 0 ? { sheetRows: rowLimit } : {})
    });
    // 缺省读第一个 sheet（历史行为）；指定 sheetName 时读该 sheet（detector 多 sheet 扫描）。
    const targetSheetName = sheetName != null && sheetName !== ''
      ? sheetName
      : workbook.SheetNames[0];

    if (!targetSheetName) {
      throw new FileValidationError('FILE_READ', '文件为空或不可读，请重新导入');
    }

    const sheet = workbook.Sheets[targetSheetName];
    if (!sheet) {
      // 指定 sheet 不存在（理论上 detector 只用 listSheetNames 返回的名字，不应发生）
      throw new FileValidationError('FILE_READ', '文件为空或不可读，请重新导入');
    }
    const rows = XLSX.utils.sheet_to_json(sheet, {
      header: 1,
      blankrows,
      defval: ''
    });
    return rowLimit > 0 ? rows.slice(0, rowLimit) : rows;
  } catch (error) {
    if (error instanceof FileValidationError) {
      throw error;
    }

    // v3.0.8 BUG3：大文件 SheetJS 全量读会撞 V8 内存上限——抛 RangeError（"Array buffer allocation failed" /
    //   "Invalid string length" / "Invalid array length"）或 OOM 类错误。旧实现统一吞成"文件为空或不可读"，
    //   误导用户（文件明明有内容、只是太大）。改为对内存类错误回真实文案，引导拆分后再试。
    if (isMemoryLimitError(error)) {
      throw new FileValidationError(
        'FILE_READ',
        '文件过大，超出处理能力，请拆分后再试'
      );
    }

    throw new FileValidationError('FILE_READ', '文件为空或不可读，请重新导入');
  }
}

function readWorkbookRows(filePath, options = {}) {
  const readGuard = options && options.readGuard;
  const token = readGuard && typeof readGuard.beforeRead === 'function'
    ? readGuard.beforeRead(filePath)
    : undefined;
  let rows;
  try {
    rows = readWorkbookRowsUnchecked(filePath, options);
  } catch (error) {
    if (readGuard && typeof readGuard.afterRead === 'function') {
      try {
        readGuard.afterRead(token, filePath);
      } catch (stabilityError) {
        throw stabilityError;
      }
    }
    throw error;
  }
  if (readGuard && typeof readGuard.afterRead === 'function') {
    readGuard.afterRead(token, filePath);
  }
  return rows;
}

// 判定是否为内存/容量类错误（大文件全量读触顶）：RangeError（含 Array buffer / string length / array length）
//   或 message 命中 V8 OOM 关键字。命中 → 回"文件过大"真实文案而非"文件为空或不可读"。
function isMemoryLimitError(error) {
  if (!error) return false;
  if (error instanceof RangeError) return true;
  const message = String(error.message || '');
  return /array buffer allocation failed|invalid (string|array) length|out of memory|heap (out of memory|limit)|cannot allocate|allocation failed/i.test(message);
}

function readRows(filePath, { blankrows = false, maxRows = 0, readGuard } = {}) {
  const rows = readWorkbookRows(filePath, { blankrows, maxRows, readGuard });

  if (!Array.isArray(rows) || rows.length === 0 || !rows.some(isRowMeaningful)) {
    throw new FileValidationError('FILE_READ', '文件为空或不可读，请重新导入');
  }

  return rows;
}

function countNonEmptyCells(cells = []) {
  return cells.reduce((count, cell) => count + (normalizeCell(cell) !== '' ? 1 : 0), 0);
}

function getFirstNonEmptyCell(cells = []) {
  return cells.find((cell) => normalizeCell(cell) !== '') || '';
}

function isRepeatedMatchedHeader(cells, normalizedExpectedHeaders) {
  return cells.every((cell, headerIndex) => normalizeCell(cell) === normalizedExpectedHeaders[headerIndex]);
}

function collectMatchedRows({
  meaningfulRows,
  matchedRowIndex,
  matchedColumnIndex,
  normalizedExpectedHeaders
}) {
  const expectedHeaderCount = normalizedExpectedHeaders.length;
  const rows = [];
  const rowNumbers = [];
  const headerBreaks = [];
  const summaryLabels = ['总收入笔数', '总收入金额', '总支出笔数', '总支出金额'];

  for (const [index, row] of meaningfulRows.slice(matchedRowIndex).entries()) {
    const normalizedCells = row.cells.slice(matchedColumnIndex, matchedColumnIndex + expectedHeaderCount);

    while (normalizedCells.length < expectedHeaderCount) {
      normalizedCells.push('');
    }

    if (
      index > 0 &&
      summaryLabels.some((label) => normalizeCell(normalizedCells[0]).includes(label))
    ) {
      break;
    }

    if (index > 0 && isRepeatedMatchedHeader(normalizedCells, normalizedExpectedHeaders)) {
      headerBreaks.push(row.rowNumber);
      continue;
    }

    if (index > 0 && !isRowMeaningful(normalizedCells)) {
      continue;
    }

    rows.push(normalizedCells);
    rowNumbers.push(row.rowNumber);
  }

  return {
    rows,
    rowNumbers,
    headerBreaks
  };
}

// 在「有意义行」二维数组里定位表头：找首个「连续子序列全等 normalizedExpectedHeaders」的行 + 起始列偏移。
//   rowsCells：每行为一个 cell 数组（调用方负责已 trimTrailingEmptyCells + 过滤全空行）。
//   normalizedExpectedHeaders：已 normalizeCell + 去空的锚点表头段。
//   返回 { matchedRowIndex, matchedColumnIndex }；未命中均为 -1。
// 这是表类型识别 / 表头定位的「连续子序列全等」匹配核心算法（大小写敏感，由 normalizeCell 仅 trim 保证）。
//   readRowsWithMetadata 与 table-type-detector 的 L1 共用此函数 → 二者识别语义同源、零漂移；改动须同步回归两侧单测。
function findHeaderMatchPosition(rowsCells, normalizedExpectedHeaders) {
  const expectedHeaderCount = normalizedExpectedHeaders.length;
  let matchedRowIndex = -1;
  let matchedColumnIndex = -1;
  if (expectedHeaderCount === 0) {
    return { matchedRowIndex, matchedColumnIndex };
  }

  rowsCells.some((cells, rowIndex) => {
    const row = Array.isArray(cells) ? cells : [];
    const maximumStartIndex = row.length - expectedHeaderCount;

    for (let startIndex = 0; startIndex <= maximumStartIndex; startIndex += 1) {
      const candidateHeaders = row
        .slice(startIndex, startIndex + expectedHeaderCount)
        .map((cell) => normalizeCell(cell));

      if (candidateHeaders.every((cell, index) => cell === normalizedExpectedHeaders[index])) {
        matchedRowIndex = rowIndex;
        matchedColumnIndex = startIndex;
        return true;
      }
    }

    return false;
  });

  return { matchedRowIndex, matchedColumnIndex };
}

// v2.1.16 PR#61 F4：可选第三参 { sheetName } 透传给 readWorkbookRows（缺省读第一个 sheet，行为不变）。
function readRowsWithMetadata(filePath, expectedHeaders = [], options = {}) {
  const { sheetName, readGuard, onWorkbookRows } = options;
  const rawRows = readWorkbookRows(filePath, { blankrows: true, sheetName, readGuard });
  if (typeof onWorkbookRows === 'function') onWorkbookRows(rawRows);
  const normalizedExpectedHeaders = Array.isArray(expectedHeaders)
    ? expectedHeaders.map((header) => normalizeCell(header)).filter((header) => header !== '')
    : [];
  const meaningfulRows = rawRows
    .map((row, index) => ({
      rowNumber: index + 1,
      cells: trimTrailingEmptyCells(Array.isArray(row) ? row : [])
    }))
    .filter((row) => isRowMeaningful(row.cells));

  if (!meaningfulRows.length) {
    throw new FileValidationError('FILE_READ', '文件为空或不可读，请重新导入');
  }

  if (!normalizedExpectedHeaders.length) {
    return {
      rows: meaningfulRows.map((row) => row.cells),
      rowNumbers: meaningfulRows.map((row) => row.rowNumber)
    };
  }

  const { matchedRowIndex, matchedColumnIndex } = findHeaderMatchPosition(
    meaningfulRows.map((row) => row.cells),
    normalizedExpectedHeaders
  );

  if (matchedRowIndex < 0 || matchedColumnIndex < 0) {
    throw new FileValidationError(
      'FILE_READ',
      '当前导入文件未匹配到所选模板的表头，请确认模板或原始网银账单是否正确'
    );
  }

  return collectMatchedRows({
    meaningfulRows,
    matchedRowIndex,
    matchedColumnIndex,
    normalizedExpectedHeaders
  });
}

// 流式读取「文件头部前 N 个有意义行」——用于 detector 表头识别（表头/列宽守卫只需前几十行）。
//   规避 SheetJS 全量读大文件 OOM：内部用 readXlsxStreamed 边解压边扫，读够 maxRows 即 destroy stream。
//   ⚠️ 仅适用于 .xlsx（流式引擎读 xl/worksheets/sheet1.xml）；.csv/.xls 不在此路径（detector 仍走全量读，
//      纯文本 CSV 与 OLE2 二进制 xls 不撞 OOM，且流式引擎不支持二者）。
//   返回值与 readRowsWithMetadata(filePath, []) 的 rows 同构：每行经 trimTrailingEmptyCells、过滤全空行，
//   故 detector 的 L1（连续子序列全等）/ L2（指纹命中率）/ 列宽守卫逻辑可直接复用、识别语义不变。
//   maxColCount：流式解析每行的固定列宽上界（须 ≥ 任何候选表头可能的列数，避免宽表头被截断；detector 传足够大值）。
//   返回 { rows, truncated }：rows 为前 N 个有意义行的 cell 数组；truncated 表示文件还有更多行（已达 maxRows 上限）。
async function readMeaningfulRowsHead(filePath, maxRows, { maxColCount = 256 } = {}) {
  ensureSupportedFile(filePath);

  if (!fs.existsSync(filePath) || fs.statSync(filePath).size === 0) {
    throw new FileValidationError('FILE_READ', '文件为空或不可读，请重新导入');
  }

  const rows = [];
  // readXlsxStreamed 缺 sheet1.xml 时会 throw（如极罕见的非 sheet1 物理名/真损坏）；由调用方捕获回退/转 read-error。
  const { truncated } = await readXlsxStreamed(
    filePath,
    (cells) => {
      const trimmed = trimTrailingEmptyCells(cells);
      if (isRowMeaningful(trimmed)) {
        rows.push(trimmed);
      }
    },
    { colCount: maxColCount, maxRows }
  );

  return { rows, truncated: !!truncated };
}

// 轻量读取 .xlsx 的 sheet 元信息（仅解析 xl/workbook.xml 取 sheet 名顺序 + 数物理 worksheet entry）。
//   ⚠️ 仅 .xlsx：用于 detector 在「不全量解压」前提下判定单/多 sheet（SheetJS listSheetNames 的
//      bookSheets:true 对 65 万行大文件仍会全量解压 → 撞 ~4GB RSS；本函数 JSZip 只读 workbook.xml 小 entry，
//      峰值与 readMeaningfulRowsHead 同量级，不 OOM）。
//   返回 { sheetNames, worksheetEntryCount }：sheetNames 顺序与 SheetJS SheetNames 一致（同读 workbook.xml）。
//   解析失败（非 zip / 缺 workbook.xml / 损坏）抛错，由调用方回退 SheetJS listSheetNames。
async function readXlsxSheetMetaLite(filePath) {
  const buffer = await fs.promises.readFile(filePath);
  const zip = await JSZip.loadAsync(buffer);
  const wbEntry = zip.file('xl/workbook.xml');
  if (!wbEntry) {
    throw new FileValidationError('FILE_READ', '文件为空或不可读，请重新导入');
  }
  const wbXml = await wbEntry.async('string');
  const sheetNames = [];
  // <sheet name="..." sheetId=".." r:id="..">（顺序即 workbook 定义顺序，与 SheetJS SheetNames 一致）
  const re = /<sheet\b[^>]*?\bname="([^"]*)"/g;
  let m;
  while ((m = re.exec(wbXml))) {
    sheetNames.push(xmlUnescapeName(m[1]));
  }
  const worksheetEntryCount = Object.keys(zip.files)
    .filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n)).length;
  return { sheetNames, worksheetEntryCount };
}

// workbook.xml 内 sheet name 的最小 XML 实体反转义（名字里可能含 & < > 等被转义字符）。
function xmlUnescapeName(s) {
  if (typeof s !== 'string' || s.indexOf('&') < 0) return s;
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

function extractHeaders(filePath) {
  const rows = readRows(filePath);
  const headerRow = rows[0];

  if (!isRowMeaningful(headerRow)) {
    throw new FileValidationError('FILE_READ', '文件为空或不可读，请重新导入');
  }

  const lastMeaningfulIndex = headerRow.reduce((index, cell, currentIndex) => {
    return normalizeCell(cell) !== '' ? currentIndex : index;
  }, -1);

  if (lastMeaningfulIndex < 0) {
    throw new FileValidationError('FILE_READ', '文件为空或不可读，请重新导入');
  }

  return headerRow.slice(0, lastMeaningfulIndex + 1).map((cell) => normalizeCell(cell));
}

function loadEnumValues(enumFilePath) {
  const rows = readRows(enumFilePath);
  const firstRow = rows[0] || [];
  const shouldSkipFirstRow =
    firstRow.filter((cell) => normalizeCell(cell) !== '').length === 1 &&
    ['common字段', '映射字段', '枚举值'].includes(normalizeCell(firstRow[0]).toLowerCase());
  const values = [];
  const seen = new Set();

  rows.forEach((row, rowIndex) => {
    if (rowIndex === 0 && shouldSkipFirstRow) {
      return;
    }

    const value = normalizeCell(row[0]);

    if (!value || seen.has(value)) {
      return;
    }

    seen.add(value);
    values.push(value);
  });

  return values;
}

function extractEnumValuesFromImportedFile(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  const fileName = path.basename(filePath);

  if (extension !== '.xlsx' || !fileName.includes('枚举')) {
    throw new FileValidationError('FILE_TYPE', '请导入文件名带有“枚举”的xlsx文件');
  }

  const values = loadEnumValues(filePath);

  if (!values.length) {
    throw new FileValidationError('FILE_READ', '枚举表为空或不可读，请重新导入');
  }

  return values;
}

// v2.1.16 PR#61 F4：列出工作簿全部 sheet 名（detector 多 sheet 扫描用）。
//   - .xlsx / .xls：返回 workbook.SheetNames（原始顺序）。
//   - .csv：无 sheet 概念 → 返回 [null]（detector 据此对 CSV 走单次默认读取，sheetName=null）。
//   - 文件不存在 / 空 / 类型不支持：抛 FileValidationError（与 readWorkbookRows 一致），由调用方转 read-error。
function listSheetNames(filePath) {
  ensureSupportedFile(filePath);

  if (!fs.existsSync(filePath) || fs.statSync(filePath).size === 0) {
    throw new FileValidationError('FILE_READ', '文件为空或不可读，请重新导入');
  }

  // .csv 真·纯文本（非伪装的 Excel 二进制）→ 单一逻辑表，无 sheet 维度。
  if (path.extname(filePath).toLowerCase() === '.csv') {
    try {
      const raw = fs.readFileSync(filePath);
      const isOLE2 = raw.length >= 4 && raw[0] === 0xD0 && raw[1] === 0xCF && raw[2] === 0x11 && raw[3] === 0xE0;
      const isZIP = raw.length >= 4 && raw[0] === 0x50 && raw[1] === 0x4B && raw[2] === 0x03 && raw[3] === 0x04;
      if (!isOLE2 && !isZIP) {
        return [null];
      }
      // 否则是伪装成 .csv 的 Excel 二进制 → fall through 走 XLSX 解析 sheet 列表
    } catch (error) {
      if (error instanceof FileValidationError) {
        throw error;
      }
      throw new FileValidationError('FILE_READ', '文件为空或不可读，请重新导入');
    }
  }

  try {
    // bookSheets:true 仅解析 sheet 目录，不解析单元格 → 比全量 readFile 轻量。
    const workbook = XLSX.readFile(filePath, { bookSheets: true });
    const names = Array.isArray(workbook.SheetNames) ? workbook.SheetNames : [];
    if (names.length === 0) {
      throw new FileValidationError('FILE_READ', '文件为空或不可读，请重新导入');
    }
    return names;
  } catch (error) {
    if (error instanceof FileValidationError) {
      throw error;
    }
    throw new FileValidationError('FILE_READ', '文件为空或不可读，请重新导入');
  }
}

module.exports = {
  collectMatchedRows,
  ensureSupportedFile,
  extractEnumValuesFromImportedFile,
  extractHeaders,
  findHeaderMatchPosition,
  // v3.0.8 BUG3：大文件全量读触顶内存类错误判定（导出供单测）
  isMemoryLimitError,
  listSheetNames,
  loadEnumValues,
  readMeaningfulRowsHead,
  readRows,
  readRowsWithMetadata,
  readXlsxSheetMetaLite
};
