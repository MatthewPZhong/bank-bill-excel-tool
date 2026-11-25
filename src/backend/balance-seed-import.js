'use strict';

// 补录余额「导入余额文件」——解析余额文件并按待补录账号提取上一账单日余额（v3.2.17 起）。
//   只读：readBalanceSeedImportFile 读文件，解析与匹配为纯函数；写种子仍走现有人工补录链路（逐个账号）。
//   v3.2.22：文件改为清结算系统导出的「银行原始日终余额信息」（随包模板 assets/银行原始日终余额信息.xlsx），
//   按表头列名识别 6 个取值字段：账单日期、银行名、开户地、币种、银行账户号、期末余额；
//   「余额来源」「余额获取方式」可选，仅供用户在同日多个余额时参考选择。其他列忽略。
//   期末余额按人工补录原值使用：清结算系统的余额来自本工具导出的余额账单时已含余额附加值，用户已知并接受（v3.2.17 D2）。

const fs = require('node:fs');
const path = require('node:path');
const XLSX = require('xlsx');
const {
  FileValidationError,
  normalizeCell,
  parseDateValue,
  parseNumericValue
} = require('./file-service');
const { roundAmount, stripDateTimeSuffix } = require('./file-service/normalizers');
const { scanXlsxFormulaCache } = require('./file-service/readers');

const BALANCE_IMPORT_COLUMNS = Object.freeze({
  billDate: '账单日期',
  bankName: '银行名',
  location: '开户地',
  currency: '币种',
  merchantId: '银行账户号',
  endBalance: '期末余额'
});
const BALANCE_IMPORT_OPTIONAL_COLUMNS = Object.freeze({
  balanceSource: '余额来源',
  balanceMethod: '余额获取方式'
});
const REQUIRED_HEADERS = Object.freeze(Object.values(BALANCE_IMPORT_COLUMNS));
const HEADER_SCAN_ROW_LIMIT = 10;
// 读不出原值时（见 prepareWorkbookSheet），该行可能就是本账号的余额、但无法确认的字段；银行账户号读不出时无法归属账号，按无效行跳过
const UNREADABLE_BLOCKING_FIELDS = Object.freeze(['currency', 'bankName', 'location', 'billDate', 'endBalance']);
// 按文本比较的身份字段（与本账号、本组比较）
const IDENTITY_TEXT_FIELDS = Object.freeze(['currency', 'bankName', 'location']);
const MISMATCH_LOCATION_PREVIEW_LIMIT = 3;

function pad(value) {
  return String(value).padStart(2, '0');
}

function formatDateLabel(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function normalizeCurrency(value) {
  return normalizeCell(value).toUpperCase();
}

// 银行名、开户地按去首尾空格、不区分大小写比较（v3.2.22 D3）。
function compareKey(value) {
  return normalizeCell(value).toUpperCase();
}

// 银行账号存成 Excel 数字时，原值不一定等于用户看到的账号，按无效行跳过、让该账号落到手工录入（不错配）：
//   - Excel 数字只保留 15 位有效数字，达到 16 位（或带小数、超出安全整数）的已被截断，截断后的文本可能等于另一个账号；
//   - 数字格式会改变显示（如 000000 把 123 显示为 000123），原值去掉了前导 0，可能等于另一个账号。
//   因此只有显示文本与原值完全一致时才采用；拿不到显示文本（displayValue 为 undefined）时一律不采用。
const EXCEL_EXACT_INTEGER_LIMIT = 1e15;

function normalizeAccountCell(value, displayValue) {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || Math.abs(value) >= EXCEL_EXACT_INTEGER_LIMIT) return '';
    const text = String(value);
    if (displayValue === undefined || normalizeCell(displayValue) !== text) return '';
    return text;
  }
  return normalizeCell(value);
}

// v3.2.22 W1：余额文件只接受 xlsx（清结算系统导出的「银行原始日终余额信息」，随包模板同为 xlsx）。xls、CSV / TSV、HTML、
//   XML 电子表格等格式读取库的解析口径与 Excel 有多处不同（编码、引号、公式、条件格式、工作表顺序等），逐项核对仍不断发现读错的
//   写法，一律不导入，提示在 Excel 中另存为 xlsx。扩展名须为 .xlsx，内容须为 ZIP 容器（按文件字节判断，不只看扩展名）
const XLSX_ONLY_MESSAGE = '余额文件须为 xlsx 格式（清结算系统导出的「银行原始日终余额信息」），请在 Excel 中打开并另存为 xlsx 后重新导入';
function isZipBytes(bytes) {
  return bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4B && bytes[2] === 0x03 && bytes[3] === 0x04;
}

// 按工作表原文确认没有缓存值、读取库却读不出公式的格（共享公式的从属格）补上的公式标记，只用于识别，不显示
const SOURCE_UNCACHED_FORMULA = '（工作表原文中没有缓存值的公式）';

function isMeaningfulRow(row) {
  return Array.isArray(row) && row.some((cell) => normalizeCell(cell) !== '');
}

// 只保留非空行，rowNumbers[i] 为 rows[i] 在原表的物理行号（用户回原表核对用）。
//   markRows[i] 为该行读不出原值的单元格（Map<列下标, 原因>，见 prepareWorkbookSheet）：读取库把它们读成空串，
//   只有这类单元格的行也保留，unreadableCells 与保留的行一一对应
function compactRows(rows, displayRows, rowNumberOf, markRows = null) {
  const kept = { rows: [], displayRows: displayRows ? [] : null, rowNumbers: [], unreadableCells: markRows ? [] : null };
  rows.forEach((row, index) => {
    const rowMarks = markRows ? markRows[index] : null;
    if (!isMeaningfulRow(row) && !rowMarks) return;
    kept.rows.push(row);
    if (kept.displayRows) kept.displayRows.push(displayRows[index]);
    kept.rowNumbers.push(rowNumberOf(index));
    if (kept.unreadableCells) kept.unreadableCells.push(rowMarks || null);
  });
  return kept;
}

function fileReadError(error) {
  if (error instanceof FileValidationError) return error;
  const message = String((error && error.message) || '');
  if (error instanceof RangeError
    || /array buffer allocation failed|invalid (string|array) length|out of memory|heap (out of memory|limit)|cannot allocate|allocation failed/i.test(message)) {
    return new FileValidationError('FILE_READ', '文件过大，超出处理能力，请拆分后再试');
  }
  return new FileValidationError('FILE_READ', '文件为空或不可读，请重新导入');
}

// dense 工作表：本版 SheetJS 为 sheet[r][c]（sheet 本身是数组），新版为 sheet['!data'][r][c]。
function denseRowsOf(sheet) {
  return Array.isArray(sheet) ? sheet : (Array.isArray(sheet['!data']) ? sheet['!data'] : null);
}

// 工作簿里读取库会读成空串、但原表并不是空白的单元格（v3.2.22），在转换前识别。返回 Map<原表行下标, Map<相对有效范围首列的列下标, 原因>>：
//   - 合并单元格：Excel 整块显示首格的值。与首格同列的后续行一律换成首格（被遮住的旧值不用；首格读不出时原因随之标记，
//     首格为空时后续行也为空）；首格以外的列（跨列合并）不能确认属于哪一列，标记「跨列合并单元格」并清除被遮住的旧值
//     （表头识别、参考列显示都不用它）；
//   - Excel 错误值（#N/A 等，t='e'）标记「Excel 错误值 #N/A」；
//   - 没有计算结果的公式标记「公式没有计算结果」：数值等公式没有缓存时读取库只留占位（t='z'，保留占位才看得到）；
//     文本公式没有缓存时读成空串、布尔公式读成 FALSE、错误公式没有值，与真有这样的计算结果无法区分，一律按没有计算结果处理；
//     数组公式结果区域里缺失的格（读取库不一定为没有缓存的结果格建单元格）同样标记，只看区域内有内容的行；
//     formulaCache（按 XLSX 工作表原文核对，见 readers.js scanXlsxFormulaCache）：uncachedCells 中的格不论读取库读成什么，
//     一律按没有计算结果的公式处理（共享公式的从属格没有缓存值时读取库读成不带公式的占位）；arrayRanges 与读取库识别出的
//     数组公式区域一并核对（属性用单引号时读取库不认数组公式）。
//   标记后删除占位单元格，转换结果与不保留占位时一致。只处理有内容的行，不为大范围合并的空行分配数组。
function prepareWorkbookSheet(sheet, range, { formulaCache = null } = {}) {
  const uncachedFormulaCells = formulaCache ? formulaCache.uncachedCells : null;
  const marks = new Map();
  const denseRows = denseRowsOf(sheet);
  // 空白：没有单元格、不带公式的占位，或不带公式的空文本（有的工具会给合并区域的后续格写空串）
  const isBlankCell = (cell) => !cell || (!cell.f && !cell.F && (cell.t === 'z' || (cell.t === 's' && normalizeCell(cell.v) === '')));
  const cellAt = (r, c) => (denseRows
    ? (Array.isArray(denseRows[r]) ? denseRows[r][c] : undefined)
    : sheet[XLSX.utils.encode_cell({ r, c })]);
  const setCell = (r, c, cell) => {
    if (!denseRows) {
      if (cell) sheet[XLSX.utils.encode_cell({ r, c })] = cell;
      else delete sheet[XLSX.utils.encode_cell({ r, c })];
      return;
    }
    if (!Array.isArray(denseRows[r])) {
      if (!cell) return;
      denseRows[r] = [];
    }
    if (cell) denseRows[r][c] = cell;
    else delete denseRows[r][c];
  };
  const rowHasCells = (r) => !denseRows || (Array.isArray(denseRows[r]) && denseRows[r].some((cell) => !isBlankCell(cell)));
  const mark = (r, c, reason) => {
    if (r < range.s.r || r > range.e.r || c < range.s.c || c > range.e.c) return;
    if (!marks.has(r)) marks.set(r, new Map());
    const rowMarks = marks.get(r);
    if (!rowMarks.has(c - range.s.c)) rowMarks.set(c - range.s.c, reason);
  };
  // 先换成没有计算结果的公式占位，合并单元格随首格标记、识别与删除占位都按读取库识别出的公式同样处理
  if (uncachedFormulaCells) {
    uncachedFormulaCells.forEach((key) => {
      const [r, c] = String(key).split(':').map(Number);
      if (!(r >= range.s.r && r <= range.e.r && c >= range.s.c && c <= range.e.c)) return;
      const cell = cellAt(r, c);
      // 数组公式首格保留结果区域（F），区域内缺失的格照常标记
      setCell(r, c, { t: 'z', f: (cell && (cell.f || cell.F)) || SOURCE_UNCACHED_FORMULA, ...(cell && cell.F ? { F: cell.F } : {}) });
    });
  }
  // 合并范围：读取库读出的与工作表原文中的（xlsx，读取库会漏掉单引号写法的 ref，见 scanXlsxFormulaCache）合并使用
  const mergeKeys = new Set();
  const merges = [
    ...(Array.isArray(sheet['!merges']) ? sheet['!merges'] : []),
    ...(formulaCache && Array.isArray(formulaCache.mergeRanges) ? formulaCache.mergeRanges.map((ref) => XLSX.utils.decode_range(ref)) : [])
  ].filter((merge) => {
    if (!merge || !merge.s || !merge.e) return false;
    const key = XLSX.utils.encode_range(merge);
    if (mergeKeys.has(key)) return false;
    mergeKeys.add(key);
    return true;
  });
  // 跨列合并只处理有内容的列（R23）：其余列没有任何内容，不是取值列或参考列（表头须有内容），标记了也会在转换时去掉
  //   （见 compactContentColumns）；整行宽的合并标题不逐列标记 16384 列
  const contentColumns = denseRows ? contentColumnsOf(denseRows, range, (cell) => !isBlankCell(cell)) : null;
  const mergeColumns = (merge) => {
    const first = Math.max(merge.s.c, range.s.c);
    const last = Math.min(merge.e.c, range.e.c);
    if (!contentColumns) return Array.from({ length: Math.max(0, last - first + 1) }, (_value, index) => first + index);
    return [...new Set([first, ...contentColumns.filter((c) => c >= first && c <= last)])].filter((c) => c <= last);
  };
  merges.forEach((merge) => {
    if (!merge || !merge.s || !merge.e) return;
    const topLeft = cellAt(merge.s.r, merge.s.c);
    const columns = mergeColumns(merge);
    for (let r = Math.max(merge.s.r, range.s.r); r <= Math.min(merge.e.r, range.e.r); r += 1) {
      if (!rowHasCells(r)) continue;
      for (const c of columns) {
        if (r === merge.s.r && c === merge.s.c) continue;
        if (c !== merge.s.c) {
          // 被遮住的旧值（原值与显示文本）一并清除，不参与表头识别与参考列显示
          mark(r, c, '跨列合并单元格');
          setCell(r, c, null);
        } else {
          setCell(r, c, topLeft ? { ...topLeft } : null);
        }
      }
    }
  });
  const isFormulaWithoutResult = (cell) => Boolean(cell.f || cell.F) && (
    cell.t === 'z' || cell.t === 'b' || (cell.t === 'e' && cell.v === undefined)
    || (cell.t === 's' && normalizeCell(cell.v) === '')
  );
  // 读取库识别出的数组公式区域：区域内缺失的格标记（xlsx 另按原文逐格核对，见下）
  const arrayFormulaRanges = new Set();
  const visit = (cell, r, c) => {
    if (!cell) return;
    if (typeof cell.F === 'string' && cell.F.includes(':')) arrayFormulaRanges.add(cell.F);
    if (isFormulaWithoutResult(cell)) mark(r, c, '公式没有计算结果');
    else if (cell.t === 'e') mark(r, c, `Excel 错误值 ${cell.w || ''}`.trim());
    // 数值单元格读出的不是数（如 <v> 只有空白、写法无法识别）：不当作空值
    else if (cell.t === 'n' && !Number.isFinite(cell.v)) mark(r, c, '数值无法识别');
  };
  if (denseRows) {
    const last = Math.min(range.e.r, denseRows.length - 1);
    for (let r = range.s.r; r <= last; r += 1) {
      const row = denseRows[r];
      if (!Array.isArray(row)) continue;
      row.forEach((cell, c) => {
        visit(cell, r, c);
        if (cell && cell.t === 'z') delete row[c];
      });
    }
  } else {
    Object.keys(sheet).forEach((address) => {
      if (address[0] === '!') return;
      const { r, c } = XLSX.utils.decode_cell(address);
      visit(sheet[address], r, c);
      if (sheet[address] && sheet[address].t === 'z') delete sheet[address];
    });
  }
  // 数组公式：结果区域里没有缓存的格，读取库不一定建单元格（首格以外整格缺失），也可能建成空文本等。只看区域内有内容的行：
  //   读取库识别出的区域标记缺失的格；xlsx 按工作表原文的区域逐格核对有没有可用缓存值（formulaCache.arrayCachedCells）
  const markArrayRange = (ref, hasResult) => {
    let area;
    try {
      area = XLSX.utils.decode_range(ref);
    } catch (_error) {
      return;
    }
    const lastRow = Math.min(area.e.r, range.e.r, denseRows ? denseRows.length - 1 : range.e.r);
    const firstColumn = Math.max(area.s.c, range.s.c);
    const lastColumn = Math.min(area.e.c, range.e.c);
    // 只看有内容的列（R24，与跨列合并同口径）：没有内容的列不是取值列或参考列，标记了也会在转换时去掉；宽数组区域不逐列展开
    const columns = contentColumns
      ? contentColumns.filter((c) => c >= firstColumn && c <= lastColumn)
      : Array.from({ length: Math.max(0, lastColumn - firstColumn + 1) }, (_value, index) => firstColumn + index);
    for (let r = Math.max(area.s.r, range.s.r); r <= lastRow; r += 1) {
      if (!marks.has(r) && !rowHasCells(r)) continue;
      for (const c of columns) {
        if (!hasResult(r, c)) mark(r, c, '公式没有计算结果');
      }
    }
  };
  arrayFormulaRanges.forEach((ref) => markArrayRange(ref, (r, c) => Boolean(cellAt(r, c))));
  if (formulaCache && Array.isArray(formulaCache.arrayRanges)) {
    const cached = formulaCache.arrayCachedCells instanceof Set ? formulaCache.arrayCachedCells : new Set();
    formulaCache.arrayRanges.forEach((ref) => markArrayRange(ref, (r, c) => cached.has(`${r}:${c}`)));
  }
  return marks;
}

//   返回有效范围内连续有内容的行段 [首行下标, 末行下标]（有读不出原值的单元格的行也算，见 prepareWorkbookSheet）；
//   没有 dense 数据时退回整个有效范围一段。
function contentRowRuns(sheet, range, marks = new Map()) {
  const denseRows = denseRowsOf(sheet);
  if (!denseRows) return [[range.s.r, range.e.r]];
  const runs = [];
  const end = Math.min(range.e.r, denseRows.length - 1);
  for (let r = range.s.r; r <= end; r += 1) {
    const row = denseRows[r];
    const hasContent = marks.has(r) || (Array.isArray(row) && row.some((cell, c) => c >= range.s.c && c <= range.e.c && cell
      && cell.t !== 'z' && normalizeCell(cell.v) !== ''));
    if (!hasContent) continue;
    const lastRun = runs[runs.length - 1];
    if (lastRun && lastRun[1] === r - 1) lastRun[1] = r;
    else runs.push([r, r]);
  }
  return runs;
}

// v3.2.22 R21 / R22 / R23：转换的列只取有内容的列（取值列的表头都有内容，不会被去掉；只有读不出原值的单元格的列不转换）：远端带样式的空白格或
//   范围外的备注（如 XFD1）会把有效范围撑到 16384 列，逐行按全宽填满会在主进程构造大量无用数组项；中间的空列同样不展开
//   （表头与取值都按列名定位，没有内容的列不影响识别）。返回只含这些列的工作表视图（与原表同一种 dense 结构，单元格对象共用）、
//   视图的范围、按视图列下标换算的 marks 与视图各列在原表中的列下标（columns）；没有 dense 数据或没有内容时原样返回（columns 为 null）
function compactContentColumns(sheet, range, marks) {
  const denseRows = denseRowsOf(sheet);
  if (!denseRows) return { sheet, range, marks, columns: null };
  const end = Math.min(range.e.r, denseRows.length - 1);
  const columns = contentColumnsOf(denseRows, range, (cell) => cell.t !== 'z' && normalizeCell(cell.v) !== '');
  if (!columns.length) return { sheet, range, marks, columns: null };
  const viewRows = [];
  for (let r = range.s.r; r <= end; r += 1) {
    const row = denseRows[r];
    if (!Array.isArray(row)) continue;
    const projected = new Array(columns.length);
    columns.forEach((c, index) => {
      if (row[c]) projected[index] = row[c];
    });
    viewRows[r] = projected;
  }
  const viewRange = { s: { r: range.s.r, c: 0 }, e: { r: range.e.r, c: columns.length - 1 } };
  const view = Array.isArray(sheet) ? viewRows : { '!data': viewRows };
  view['!ref'] = XLSX.utils.encode_range(viewRange);
  // 没有任何内容的列上的标记（跨列合并的标题等）去掉；该行仍保留（空 Map 也算有读不出的格，不当作空行）
  const indexOf = new Map(columns.map((c, index) => [c, index]));
  const projectedMarks = new Map();
  marks.forEach((rowMarks, r) => projectedMarks.set(r, new Map(Array.from(rowMarks)
    .filter(([column]) => indexOf.has(range.s.c + column))
    .map(([column, reason]) => [indexOf.get(range.s.c + column), reason]))));
  return { sheet: view, range: viewRange, marks: projectedMarks, columns };
}

// 有效范围内有内容的列（升序）：hasContent(cell) 判断单元格是否算内容
function contentColumnsOf(denseRows, range, hasContent) {
  const used = new Set();
  const end = Math.min(range.e.r, denseRows.length - 1);
  for (let r = range.s.r; r <= end; r += 1) {
    const row = denseRows[r];
    if (!Array.isArray(row)) continue;
    row.forEach((cell, c) => {
      if (c >= range.s.c && c <= range.e.c && cell && hasContent(cell)) used.add(c);
    });
  }
  return Array.from(used).sort((left, right) => left - right);
}

// 工作表的读取范围：声明的范围（xlsx 的 dimension 等）与实际有单元格的范围的并集。有的导出工具追加行后不更新声明的范围，
//   读取库仍读出范围外的单元格，Excel 照常显示，按声明的范围截取会漏掉最近的余额行（R19）
function sheetCellRange(sheet) {
  const range = XLSX.utils.decode_range(sheet['!ref']);
  const denseRows = denseRowsOf(sheet);
  const visit = (r, c) => {
    if (r < range.s.r) range.s.r = r;
    if (r > range.e.r) range.e.r = r;
    if (c < range.s.c) range.s.c = c;
    if (c > range.e.c) range.e.c = c;
  };
  if (denseRows) {
    denseRows.forEach((row, r) => {
      if (Array.isArray(row)) row.forEach((cell, c) => { if (cell) visit(r, c); });
    });
  } else {
    Object.keys(sheet).forEach((key) => {
      if (key[0] !== '!') {
        const position = XLSX.utils.decode_cell(key);
        visit(position.r, position.c);
      }
    });
  }
  return range;
}

// 身份字段（银行账户号、币种、银行名、开户地）的显示可能与原值不同的格（R23 / R24）：单元格实际生效的数字格式不是常规 / 0 / 文本
//   （含继承的行、列样式与命名样式，见 readers.js xlsxDisplayFormatChecker），或被带数字格式的条件格式覆盖。读取库给的显示文本
//   不应用条件格式与继承的格式，用户在 Excel 中看到的可能是另一个值（如 1 显示为 001、文本 1 显示为 HK1、空文本显示为 A001）：
//   - 身份列表头以下有值的格（含空文本、只有空白的文本）只要有这种可能，整个文件不导入（W3）：无法确认该行属于哪个账号、币种、
//     银行与开户地，按读不出跳过或排除又可能让账号退回更早一天的余额。直接按工作表的单元格逐格核对，不只看保留下来的行；
//   - 参考列（余额来源、余额获取方式）按读不出显示原因（R26：同账号同日多个余额时用户靠它区分，不显示可能与 Excel 不同的文本），
//     不影响该行参与匹配与选择。
//   纵向合并单元格只按首格（Excel 显示首格）核对。没有值的格（不显示内容）不算；找不到表头时不在这里判断
//   （由 parseBalanceSeedImportRows 提示缺列）
const ACCOUNT_DISPLAY_MESSAGE = '余额文件中银行账户号显示的内容可能与原值不同（单元格的数字格式或条件格式），无法确认属于哪个账号，'
  + '请把银行账户号改为常规或文本格式后重新导入';
const IDENTITY_DISPLAY_ISSUE = '单元格的数字格式或条件格式可能改变显示的内容，无法确认';
function identityDisplayMessage(key) {
  if (key === 'merchantId') return ACCOUNT_DISPLAY_MESSAGE;
  const label = BALANCE_IMPORT_COLUMNS[key];
  return `余额文件中${label}显示的内容可能与原值不同（单元格的数字格式或条件格式），无法确认余额属于哪个账号，`
    + `请把${label}改为常规或文本格式后重新导入`;
}
// 银行账户号读不出、但 Excel 中看得到账号的原因（见 parseBalanceSeedImportRows；与 prepareWorkbookSheet 的标记一致）
const UNIDENTIFIABLE_ACCOUNT_REASONS = new Set(['公式没有计算结果', '数值无法识别']);
// forEachCellBelow(表头所在的原表行下标, 原表列下标, visit(r, c))：逐个给出该列表头以下有值的格
function markIdentityDisplayRisks({ rows, rowNumbers, unreadableCells, sheetColumnOf, cellPresent, forEachCellBelow, displayRisk }) {
  let header;
  try {
    header = findHeaderRow(rows, unreadableCells.some(Boolean) ? unreadableCells : null);
  } catch (error) {
    if (error instanceof FileValidationError) return;
    throw error;
  }
  const headerRow = rowNumbers[header.rowIndex] - 1;
  ['merchantId', ...IDENTITY_TEXT_FIELDS].forEach((key) => {
    forEachCellBelow(headerRow, sheetColumnOf(header.indexes[key]), (r, c) => {
      if (displayRisk(r, c)) throw new FileValidationError('FILE_READ', identityDisplayMessage(key));
    });
  });
  const referenceColumns = Object.keys(BALANCE_IMPORT_OPTIONAL_COLUMNS).map((key) => header.optionalIndexes[key])
    .filter((column) => Number.isInteger(column) && column >= 0);
  for (let index = header.rowIndex + 1; index < rows.length; index += 1) {
    const r = rowNumbers[index] - 1;
    referenceColumns.forEach((column) => {
      const rowMarks = unreadableCells[index];
      if (rowMarks instanceof Map && rowMarks.has(column)) return;
      const c = sheetColumnOf(column);
      if (!cellPresent(r, c) || !displayRisk(r, c)) return;
      if (!(rowMarks instanceof Map)) unreadableCells[index] = new Map();
      unreadableCells[index].set(column, IDENTITY_DISPLAY_ISSUE);
    });
  }
}

// 工作表中 (r, c) 的显示可能与原值不同（见 markIdentityDisplayRisks）；不需要核对时返回 null
function workbookDisplayRiskOf({ formulaCache, merges }) {
  let cellRisk = null;
  if (formulaCache) {
    const areas = Array.isArray(formulaCache.conditionalFormatAreas) ? formulaCache.conditionalFormatAreas : [];
    const formatCells = formulaCache.displayFormatCells instanceof Set ? formulaCache.displayFormatCells : new Set();
    // 没有任何可能改变显示的格式时不用逐格核对（R25）
    if (!formulaCache.displayFormatUnknown && !formatCells.size && !areas.length) return null;
    const wholeSheet = Boolean(formulaCache.displayFormatUnknown) || areas.some((area) => area === null);
    // 条件格式区域按列建行区间索引（R26：只为核对到的列建，同列的区间排序后合并重叠 / 相邻的，二分查找；不再每格遍历全部区域）
    const spansByColumn = new Map();
    const spansOf = (c) => {
      if (!spansByColumn.has(c)) {
        const merged = [];
        areas.filter((area) => c >= area.s.c && c <= area.e.c)
          .map((area) => [area.s.r, area.e.r])
          .sort((left, right) => left[0] - right[0])
          .forEach(([first, last]) => {
            const tail = merged[merged.length - 1];
            if (tail && first <= tail[1] + 1) tail[1] = Math.max(tail[1], last);
            else merged.push([first, last]);
          });
        spansByColumn.set(c, merged);
      }
      return spansByColumn.get(c);
    };
    const inConditionalArea = (r, c) => {
      const spans = spansOf(c);
      let low = 0;
      let high = spans.length - 1;
      while (low <= high) {
        const middle = (low + high) >> 1;
        if (spans[middle][1] < r) low = middle + 1;
        else if (spans[middle][0] > r) high = middle - 1;
        else return true;
      }
      return false;
    };
    cellRisk = (r, c) => wholeSheet || formatCells.has(`${r}:${c}`) || inConditionalArea(r, c);
  }
  if (!cellRisk) return null;
  // 纵向合并的格 Excel 显示首格：只按首格核对（R25：被遮住的格自身残留的格式不影响显示）。合并范围按首列索引、按首行排序，
  //   二分查找所在范围（每格不再遍历全部合并范围）；prefixEnds[i] 为前 i + 1 个范围的最大末行，重叠的异常写法也能找到
  const byColumn = new Map();
  merges.forEach((merge) => {
    if (!byColumn.has(merge.s.c)) byColumn.set(merge.s.c, []);
    byColumn.get(merge.s.c).push(merge);
  });
  const indexByColumn = new Map();
  byColumn.forEach((list, column) => {
    list.sort((left, right) => left.s.r - right.s.r);
    const prefixEnds = [];
    list.forEach((merge, index) => prefixEnds.push(Math.max(index ? prefixEnds[index - 1] : -1, merge.e.r)));
    indexByColumn.set(column, { list, prefixEnds });
  });
  const displayedCellOf = (r, c) => {
    const index = indexByColumn.get(c);
    if (!index) return [r, c];
    let low = 0;
    let high = index.list.length - 1;
    let found = -1;
    while (low <= high) {
      const middle = (low + high) >> 1;
      if (index.list[middle].s.r <= r) {
        found = middle;
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }
    for (let i = found; i >= 0 && index.prefixEnds[i] >= r; i -= 1) {
      if (index.list[i].e.r >= r) return [index.list[i].s.r, index.list[i].s.c];
    }
    return [r, c];
  };
  return (r, c) => {
    const [displayedRow, displayedColumn] = displayedCellOf(r, c);
    return cellRisk(displayedRow, displayedColumn);
  };
}

// 读余额文件（只读一次文件字节，原值、显示值、日期系统与行号都取自这一份字节，文件中途被改也不会错配）：
//   rows 为非空行的原值；rowNumbers 为各行在原表的物理行号（选择余额弹窗的「行号」）。
//   读第一张工作表（Excel 的第一个标签；第一张表隐藏时不导入）：原值与 readRows 同一读取选项（sheet_to_json 默认取原值），
//   另取同一工作表的显示文本（用于核对数字型银行账户号，以及余额来源等参考列的显示）与日期系统（1904 / 1900）。
//   导入前按部件原文核对结构与公式的缓存值（readers.js scanXlsxFormulaCache，含结构白名单 W2），无法核对时不导入。
//   只逐段转换连续有内容的行，有效范围延伸到大量空行、或内容之间隔着大量空行时都不为空行分配数组。
//   合并单元格、Excel 错误值、没有计算结果的公式在转换前识别（prepareWorkbookSheet），unreadableCells[i] 为 rows[i] 中读不出原值的单元格。
//   读取失败（含文件被移走、无权限）一律转为 FileValidationError，不把带路径的系统错误带出。
function readBalanceSeedImportFile(filePath) {
  if (path.extname(filePath).toLowerCase() !== '.xlsx') {
    throw new FileValidationError('FILE_TYPE', XLSX_ONLY_MESSAGE);
  }
  let snapshot;
  try {
    const bytes = fs.readFileSync(filePath);
    if (!isZipBytes(bytes)) throw new FileValidationError('FILE_READ', XLSX_ONLY_MESSAGE);
    // 保留占位单元格（sheetStubs）才能看到没有计算结果的公式，识别后删除（见 prepareWorkbookSheet）。只解析第一张表（sheets: 0），
    //   另保留压缩包原文（bookFiles），按部件原文核对
    const workbook = XLSX.read(bytes, { type: 'buffer', cellDates: false, dense: true, sheetStubs: true, sheets: 0, bookFiles: true });
    const sheetName = workbook.SheetNames[0];
    const sheet = sheetName ? workbook.Sheets[sheetName] : null;
    if (!sheet || !sheet['!ref']) throw new FileValidationError('FILE_READ', '文件为空或不可读，请重新导入');
    const sheetProps = workbook.Workbook && Array.isArray(workbook.Workbook.Sheets) ? workbook.Workbook.Sheets[0] : null;
    if (sheetProps && sheetProps.Hidden) {
      throw new FileValidationError('FILE_READ', '余额文件的第一个工作表是隐藏的，请把余额所在的工作表取消隐藏并移到第一个后重新导入');
    }
    const range = sheetCellRange(sheet);
    const formulaCache = scanXlsxFormulaCache(workbook, sheetName);
    if (!formulaCache) {
      throw new FileValidationError('FILE_READ', '无法核对余额文件的工作表内容，请在 Excel 中打开并另存为 xlsx 后重新导入');
    }
    const { sheet: readSheet, range: readRange, marks, columns } = compactContentColumns(sheet, range,
      prepareWorkbookSheet(sheet, range, { formulaCache }));
    const rows = [];
    const displayRows = [];
    const rowNumbers = [];
    const unreadableCells = [];
    let displayAligned = true;
    contentRowRuns(readSheet, readRange, marks).forEach(([first, last]) => {
      const runRange = { s: { r: first, c: readRange.s.c }, e: { r: last, c: readRange.e.c } };
      const runRows = XLSX.utils.sheet_to_json(readSheet, { header: 1, blankrows: true, defval: '', range: runRange });
      const runDisplayRows = XLSX.utils.sheet_to_json(readSheet, { header: 1, blankrows: true, defval: '', raw: false, range: runRange });
      if (runDisplayRows.length !== runRows.length) displayAligned = false;
      const runMarkRows = runRows.map((_row, index) => marks.get(first + index) || null);
      const kept = compactRows(runRows, runDisplayRows, (index) => first + index + 1, runMarkRows);
      kept.rows.forEach((row, index) => {
        rows.push(row);
        displayRows.push(kept.displayRows[index]);
        rowNumbers.push(kept.rowNumbers[index]);
        unreadableCells.push(kept.unreadableCells[index]);
      });
    });
    // 身份字段的显示可能与原值不同的格（R23 / R24 / W3，见 markIdentityDisplayRisks）
    const displayRisk = workbookDisplayRiskOf({
      formulaCache,
      merges: [
        ...(Array.isArray(sheet['!merges']) ? sheet['!merges'] : []),
        ...(Array.isArray(formulaCache.mergeRanges) ? formulaCache.mergeRanges.map((ref) => XLSX.utils.decode_range(ref)) : [])
      ]
    });
    if (displayRisk) {
      const sheetRows = denseRowsOf(sheet) || [];
      const cellAt = (r, c) => (Array.isArray(sheetRows[r]) ? sheetRows[r][c] : undefined);
      const hasValue = (cell) => Boolean(cell) && cell.t !== 'z';
      markIdentityDisplayRisks({
        rows,
        rowNumbers,
        unreadableCells,
        sheetColumnOf: (column) => (columns ? columns[column] : range.s.c + column),
        cellPresent: (r, c) => hasValue(cellAt(r, c)),
        forEachCellBelow: (headerRow, c, visit) => {
          for (let r = headerRow + 1; r < sheetRows.length; r += 1) {
            if (hasValue(cellAt(r, c))) visit(r, c);
          }
        },
        displayRisk
      });
    }
    const workbookProps = workbook.Workbook && workbook.Workbook.WBProps;
    snapshot = {
      rows,
      displayRows: displayAligned ? displayRows : null,
      rowNumbers,
      unreadableCells: unreadableCells.some(Boolean) ? unreadableCells : null,
      date1904: Boolean(workbookProps && workbookProps.date1904)
    };
  } catch (error) {
    throw fileReadError(error);
  }
  if (!snapshot.rows.length) throw new FileValidationError('FILE_READ', '文件为空或不可读，请重新导入');
  return snapshot;
}

// 文本形式的账单日期只接受四位年份在前的写法（白名单，v3.2.22 W4）：YYYY-M-D、YYYY/M/D、YYYY.M.D、YYYY年M月D日与有效的
//   YYYYMMDD，可带时间后缀（见 stripDateTimeSuffix）。共享解析口径还会猜其他写法（如 26年9月30日 读成 2030-09-26、03/02/2026
//   按日在前读成 2 月 3 日，Excel 按区域设置可能读成另一天），一律不采用：日在前、两位年份与不是有效 YYYYMMDD 的 8 位数字
//   返回「无法确认年、月、日的顺序」，其余文本（含纯数字的序列号文本，Excel 按文本显示）返回「无法识别为日期」；不是文本时返回 null
const BILL_DATE_ORDER_ISSUE = '无法确认年、月、日的顺序';
const BILL_DATE_UNRECOGNIZED = '无法识别为日期';
const YEAR_FIRST_DATE_TEXT = /^(?:\d{4}([-/.])\d{1,2}\1\d{1,2}|\d{4}年\d{1,2}月\d{1,2}日)$/;
function billDateTextIssue(value) {
  if (typeof value !== 'string') return null;
  const text = stripDateTimeSuffix(value);
  if (YEAR_FIRST_DATE_TEXT.test(text)) return null;
  if (/^\d{8}$/.test(text)) {
    return parseDateValue(`${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}`) ? null : BILL_DATE_ORDER_ISSUE;
  }
  if (/^\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4}$/.test(text) || /^\d{1,3}年\d{1,2}月\d{1,2}日$/.test(text)) return BILL_DATE_ORDER_ISSUE;
  return BILL_DATE_UNRECOGNIZED;
}

// 期末余额：数字单元格取原值；文本按共享金额口径（parseNumericValue），其中带逗号的只接受千分位分组正确的写法
//   （1,234.56）：12,34 等可能是十进制逗号（12.34），去掉逗号会放大成 1234，不猜，按读不出处理
const GROUPED_AMOUNT_TEXT = /^[+-]?\d{1,3}(?:,\d{3})+(?:\.\d+)?$/;
function parseBalanceAmountCell(value) {
  if (typeof value === 'string' && value.includes(',') && !GROUPED_AMOUNT_TEXT.test(normalizeCell(value))) return null;
  return parseNumericValue(value);
}

// 账单日期按共享日期解析口径（parseDateValue），只采用四位年份在前的文本（见 billDateTextIssue）；数字单元格按工作簿日期系统
//   换算序列号：date1904 为 null（日期系统未知）时不采用。
function parseBillDateCell(value, date1904) {
  if (billDateTextIssue(value)) return null;
  const excelDateSystem = date1904 === null ? 'unknown' : (date1904 ? '1904' : '1900');
  return parseDateValue(value, { excelDateSystem });
}

// 表头在前 10 个非空行内查找（读取时保留了空行，空行不占这 10 行；只有读不出原值的单元格的行不是空行）。
function findHeaderRow(rows, unreadableCells = null) {
  let bestMissing = REQUIRED_HEADERS;
  let scanned = 0;
  for (let rowIndex = 0; rowIndex < rows.length && scanned < HEADER_SCAN_ROW_LIMIT; rowIndex += 1) {
    const cells = Array.isArray(rows[rowIndex]) ? rows[rowIndex].map((cell) => normalizeCell(cell)) : [];
    if (!cells.some((cell) => cell !== '') && !(unreadableCells && unreadableCells[rowIndex])) continue;
    scanned += 1;
    const missing = REQUIRED_HEADERS.filter((header) => !cells.includes(header));
    if (!missing.length) {
      return {
        rowIndex,
        indexes: Object.fromEntries(Object.entries(BALANCE_IMPORT_COLUMNS)
          .map(([key, header]) => [key, cells.indexOf(header)])),
        optionalIndexes: Object.fromEntries(Object.entries(BALANCE_IMPORT_OPTIONAL_COLUMNS)
          .map(([key, header]) => [key, cells.indexOf(header)]))
      };
    }
    if (missing.length < bestMissing.length) bestMissing = missing;
  }
  throw new FileValidationError(
    'BALANCE_IMPORT_HEADER_MISSING',
    `余额文件缺少列：${bestMissing.join('、')}`,
    { detailLines: [
      `余额文件需为「银行原始日终余额信息」，前 ${HEADER_SCAN_ROW_LIMIT} 个非空行里需要有一行表头同时包含：${REQUIRED_HEADERS.join('、')}`
    ] }
  );
}

// 参考列优先取显示文本（与用户在 Excel 里看到的一致），没有显示文本时取原值；读不出原值的格（rowMarks）显示原因，
//   不显示读取库读出的空串、FALSE 等并不存在的结果（只用于参考，不影响该行参与匹配与选择）。
function referenceCell(cells, displayCells, index, rowMarks = null) {
  if (index < 0) return '';
  if (rowMarks instanceof Map && rowMarks.has(index)) return `读不出（${rowMarks.get(index)}）`;
  if (Array.isArray(displayCells) && displayCells[index] !== undefined) return normalizeCell(displayCells[index]);
  return normalizeCell(cells[index]);
}

/**
 * 解析余额文件的行（readRows 结果）。displayRows 为同一工作表的显示文本（readBalanceSeedImportFile），
 * 用于核对数字型银行账户号（不传时数字型账号一律跳过）与参考列显示；date1904 为工作簿日期系统，
 * 不传按 1900 系统，传 null（未知）时数字形式的账单日期一律跳过。
 * rowNumbers 为各行在原表的物理行号（readBalanceSeedImportFile），供用户回原表核对；不传时按下标 + 1。
 * unreadableCells 为各行读不出原值的单元格（readBalanceSeedImportFile；Map<列下标, 原因>）：币种、银行名、开户地、账单日期、
 *   期末余额读不出时记入 record.unreadableFields（{ 字段: 原因 }），不当作空值或无效值，该行留给匹配判断
 *   （见 matchBalanceSeedImport；读不出的账单日期为空串、期末余额为 null）；银行账户号读不出时无法归属，按无效行跳过计数。
 * @returns {{ records: Array<{merchantId, currency, bankName, location, billDate, endBalance, balanceSource, balanceMethod, rowNumber,
 *   unreadableFields?}>, skippedRowCount: number }}
 */
function parseBalanceSeedImportRows(rows, { displayRows = null, date1904 = false, rowNumbers = null, unreadableCells = null } = {}) {
  const safeRows = Array.isArray(rows) ? rows : [];
  const safeDisplayRows = Array.isArray(displayRows) && displayRows.length === safeRows.length ? displayRows : null;
  const safeUnreadableCells = Array.isArray(unreadableCells) && unreadableCells.length === safeRows.length ? unreadableCells : null;
  const { rowIndex: headerRowIndex, indexes, optionalIndexes } = findHeaderRow(safeRows, safeUnreadableCells);
  const safeRowNumbers = Array.isArray(rowNumbers) && rowNumbers.length === safeRows.length ? rowNumbers : null;
  const records = [];
  let skippedRowCount = 0;
  safeRows.slice(headerRowIndex + 1).forEach((row, offset) => {
    const cells = Array.isArray(row) ? row : [];
    const raw = Object.fromEntries(Object.entries(indexes).map(([key, index]) => [key, cells[index]]));
    const rowMarks = safeUnreadableCells ? safeUnreadableCells[headerRowIndex + 1 + offset] : null;
    const unreadable = rowMarks instanceof Map
      ? Object.fromEntries(Object.entries(indexes).filter(([, index]) => rowMarks.has(index)).map(([key, index]) => [key, rowMarks.get(index)]))
      : {};
    // 取值列与参考列都为空、也都没有读不出的格才是空行（不计入跳过数）；只有参考列有内容的残缺行按无效行计数
    const referenceIndexes = Object.values(optionalIndexes).filter((index) => index >= 0);
    const referenceBlank = referenceIndexes.every((index) => normalizeCell(cells[index]) === ''
      && !(rowMarks instanceof Map && rowMarks.has(index)));
    if (referenceBlank && !Object.keys(unreadable).length && Object.values(raw).every((value) => normalizeCell(value) === '')) return;
    const displayCells = safeDisplayRows ? safeDisplayRows[headerRowIndex + 1 + offset] : null;
    const displayOf = (key) => (Array.isArray(displayCells) ? displayCells[indexes[key]] : undefined);
    const accountDisplay = displayOf('merchantId');
    // 银行账户号显示的内容与原值不同（如 000000 格式把 123 显示为 000123、自定义格式的文本段）：无法确认属于哪个账号，
    //   跳过又可能让该账号退回更早一天的余额，整个文件不导入（R24；拿不到显示文本时数字账号照旧跳过，见 normalizeAccountCell）
    if (!unreadable.merchantId && accountDisplay !== undefined && normalizeCell(raw.merchantId) !== ''
      && normalizeCell(accountDisplay) !== normalizeCell(raw.merchantId)) {
      throw new FileValidationError('FILE_READ', ACCOUNT_DISPLAY_MESSAGE);
    }
    const merchantId = unreadable.merchantId ? '' : normalizeAccountCell(raw.merchantId, accountDisplay);
    // 银行账户号在 Excel 中看得到、却无法确认原值（R24）：超过 15 位或带小数的数字（Excel 只保留 15 位有效数字）、拿不到显示文本的
    //   数字、没有计算结果的公式、无法识别的数值。跳过该行又可能让该账号退回更早一天的余额，整个文件不导入。
    //   Excel 错误值与被跨列合并遮住的格在 Excel 中也看不到账号，照常按无效行跳过
    const accountIssue = unreadable.merchantId
      ? (UNIDENTIFIABLE_ACCOUNT_REASONS.has(unreadable.merchantId) ? `读不出（${unreadable.merchantId}）` : '')
      : (!merchantId && typeof raw.merchantId === 'number' ? '是无法确认原值的数字（超过 15 位、带小数，或无法核对显示的内容）' : '');
    if (accountIssue) {
      const rowNumber = safeRowNumbers ? safeRowNumbers[headerRowIndex + 1 + offset] : headerRowIndex + offset + 2;
      throw new FileValidationError('FILE_READ', `余额文件第 ${rowNumber} 行的银行账户号${accountIssue}，无法确认属于哪个账号，`
        + '请把银行账户号改为文本或修正后重新导入');
    }
    const parsedDate = unreadable.billDate ? null : parseBillDateCell(raw.billDate, date1904);
    const endBalance = unreadable.endBalance ? null : parseBalanceAmountCell(raw.endBalance);
    if (!merchantId || (!parsedDate && !unreadable.billDate) || (endBalance === null && !unreadable.endBalance)) {
      skippedRowCount += 1;
      // 账号可识别、账单日期或期末余额为空 / 无法识别的行：不能作为余额（照常计入跳过数），但可能就是该账号当天的余额行，
      //   按读不出处理，匹配时该账号不退回更早一天的余额（见 matchBalanceSeedImport）
      if (!merchantId) return;
      if (!parsedDate && !unreadable.billDate) {
        unreadable.billDate = normalizeCell(raw.billDate) === '' ? '为空' : (billDateTextIssue(raw.billDate) || BILL_DATE_UNRECOGNIZED);
      }
      if (endBalance === null && !unreadable.endBalance) unreadable.endBalance = normalizeCell(raw.endBalance) === '' ? '为空' : '无法识别为金额';
    }
    // 币种为空的行无法确认属于哪个币种的账号，同样按读不出处理
    if (!unreadable.currency && normalizeCell(raw.currency) === '') unreadable.currency = '为空';
    // 币种、银行名、开户地存成数字等非文本的格（R22 / R23）：数字格式、条件格式都会改变显示（如 000 把 1 显示为 001），
    //   原值不一定是用户看到的，一律按读不出处理，不当作另一开户地而排除该行、退回更早一天的余额
    //   文本格显示的内容与原值不同（自定义格式的文本段，如 0;0;0;"HK"@ 把 1 显示为 HK1）同样按读不出处理（R24）
    IDENTITY_TEXT_FIELDS.forEach((key) => {
      const value = raw[key];
      if (unreadable[key] || value === undefined || value === null) return;
      if (typeof value !== 'string') {
        unreadable[key] = '单元格不是文本，无法确认显示的内容';
        return;
      }
      const display = displayOf(key);
      if (display !== undefined && normalizeCell(display) !== normalizeCell(value)) unreadable[key] = '单元格显示的内容与原值不同';
    });
    const unreadableFields = Object.fromEntries(Object.entries(unreadable).filter(([key]) => UNREADABLE_BLOCKING_FIELDS.includes(key)));
    records.push({
      merchantId,
      currency: normalizeCurrency(raw.currency),
      bankName: normalizeCell(raw.bankName),
      location: normalizeCell(raw.location),
      billDate: parsedDate ? formatDateLabel(parsedDate) : '',
      endBalance,
      balanceSource: referenceCell(cells, displayCells, optionalIndexes.balanceSource, rowMarks),
      balanceMethod: referenceCell(cells, displayCells, optionalIndexes.balanceMethod, rowMarks),
      rowNumber: safeRowNumbers ? safeRowNumbers[headerRowIndex + 1 + offset] : headerRowIndex + offset + 2,
      ...(Object.keys(unreadableFields).length ? { unreadableFields } : {})
    });
  });
  return { records, skippedRowCount };
}

function manualAccount(account, reason) {
  return { ...account, billDate: '', endBalance: null, source: 'manual', reason };
}

function bankLocationLabel(bankName, location) {
  return `${bankName || '(空)'} / ${location || '(空)'}`;
}

function toChoice(record) {
  return {
    rowNumber: record.rowNumber,
    billDate: record.billDate,
    bankName: record.bankName,
    location: record.location,
    currency: record.currency,
    merchantId: record.merchantId,
    endBalance: record.endBalance,
    balanceSource: record.balanceSource,
    balanceMethod: record.balanceMethod
  };
}

/**
 * 按待补录账号（银行账户号 + 币种 + 银行名 + 开户地）取早于当前账单日期的最近一天的期末余额。
 *   待补录账号带 minBillDate（核对提示的已有种子日期）时，最近一天早于它的余额不采用：
 *   重算取当前账单日期前最近的种子，更早日期的余额写入后仍用已有种子，修正不了本次余额。
 *   结果账号原样带上 minBillDate，确认页据此提示可填写的日期范围。
 *   group 为本组的银行名、开户地（输出名称「银行名-所在地」拆分，与余额账单写入的银行名称、所在地同口径）。
 *   - 该日只有一个余额（按分去重）→ source='file'
 *   - 该日有多个不同余额 → source='choice'，choices 列出该日全部行，由用户单选（v3.2.22 D4）
 *   - 没有早于当前账单日期的余额、文件中没有该账号，或银行名 / 开户地对不上 → source='manual'，附原因
 *   - 币种 / 银行名 / 开户地 / 账单日期 / 期末余额读不出（record.unreadableFields）、其余可读字段与本账号和本组一致，
 *     日期早于当前账单日期且不早于可核对的最近余额（日期读不出时一律算）→ source='manual'：读不出的值不当作空值匹配，
 *     也不退回更早一天
 * 银行账户号按文本精确匹配（去首尾空格）；币种、银行名、开户地去首尾空格后不区分大小写。
 */
function matchBalanceSeedImport(records, pendingAccounts, group = {}) {
  const groupBankName = normalizeCell(group && group.bankName);
  const groupLocation = normalizeCell(group && group.location);
  // 本组的银行名 / 开户地不为空、文件行的为空：可能是同一开户地漏填或没读到，不能断定是另一开户地，按读不出（为空）处理，
  //   不排除该行后退回更早一天的余额（R19）；本组的也为空时照常按空值比较
  const blankIdentity = (record, key, groupValue) => groupValue !== '' && normalizeCell(record[key]) === ''
    && !(record.unreadableFields && Object.hasOwn(record.unreadableFields, key));
  const safeRecords = (Array.isArray(records) ? records : []).map((record) => {
    if (!record) return record;
    const blanks = Object.fromEntries([['bankName', groupBankName], ['location', groupLocation]]
      .filter(([key, groupValue]) => blankIdentity(record, key, groupValue)).map(([key]) => [key, '为空']));
    return Object.keys(blanks).length ? { ...record, unreadableFields: { ...(record.unreadableFields || {}), ...blanks } } : record;
  });
  const unreadableRecords = safeRecords.filter((record) => record && record.unreadableFields);
  const verifiableRecords = safeRecords.filter((record) => record && !record.unreadableFields);
  const groupBankKey = compareKey(groupBankName);
  const groupLocationKey = compareKey(groupLocation);
  const accounts = (Array.isArray(pendingAccounts) ? pendingAccounts : []).map((pending) => {
    const account = {
      merchantId: normalizeCell(pending && pending.merchantId),
      currency: normalizeCell(pending && pending.currency),
      targetBillDate: normalizeCell(pending && pending.targetBillDate)
    };
    const minBillDate = normalizeCell(pending && pending.minBillDate);
    // 确认页按它限制可填写的日期（主进程保存时同样拒绝更早的日期）
    if (minBillDate) account.minBillDate = minBillDate;
    const currencyKey = normalizeCurrency(account.currency);
    const isEarlier = (record) => !account.targetBillDate || record.billDate < account.targetBillDate;
    const hasUnreadable = (record, key) => Boolean(record.unreadableFields) && Object.hasOwn(record.unreadableFields, key);
    // 账号是否在文件中、银行名 / 开户地是否一致：按可读的身份字段判断（期末余额、日期读不出的行也算，见下方原因）；
    //   余额能否采用只看所有字段都可读的行（sameAccount）
    const identityRecords = safeRecords.filter((record) => (
      record && record.merchantId === account.merchantId && !hasUnreadable(record, 'currency') && record.currency === currencyKey
    ));
    const sameAccount = verifiableRecords.filter((record) => (
      record.merchantId === account.merchantId && record.currency === currencyKey
    ));
    // 有字段读不出、其余可读字段都与本账号和本组一致的行：可能就是本账号的余额，但无法确认。日期不早于可核对的最近余额
    //   （或日期读不出）时，取哪一行都可能错（读不出的开户地不当作空值去匹配空的开户地），整个账号改为手工录入
    const unreadable = unreadableRecords.filter((record) => (
      record.merchantId === account.merchantId
      && (hasUnreadable(record, 'billDate') || isEarlier(record))
      && (hasUnreadable(record, 'currency') || record.currency === currencyKey)
      && (hasUnreadable(record, 'bankName') || compareKey(record.bankName) === groupBankKey)
      && (hasUnreadable(record, 'location') || compareKey(record.location) === groupLocationKey)
    ));
    const verifiedLatestDate = sameAccount
      .filter((record) => isEarlier(record) && compareKey(record.bankName) === groupBankKey && compareKey(record.location) === groupLocationKey)
      .reduce((latest, record) => (record.billDate > latest ? record.billDate : latest), '');
    const sortDate = (record) => (hasUnreadable(record, 'billDate') ? '9999-99-99' : record.billDate);
    const blocking = unreadable
      .filter((record) => hasUnreadable(record, 'billDate') || record.billDate >= verifiedLatestDate)
      .sort((left, right) => (sortDate(right).localeCompare(sortDate(left)) || left.rowNumber - right.rowNumber));
    if (blocking.length) {
      const [first] = blocking;
      const fields = Object.entries(first.unreadableFields)
        .map(([key, reason]) => `${BALANCE_IMPORT_COLUMNS[key]}读不出（${reason}）`).join('、');
      const day = first.billDate ? ` ${first.billDate} ` : '';
      const more = blocking.length > 1 ? ` 等 ${blocking.length} 行` : '';
      return manualAccount(
        account,
        `文件中该账号${day}的余额行（第 ${first.rowNumber} 行${more}）${fields}，无法确认该账号的余额，请手工填写`
      );
    }
    if (!identityRecords.length) {
      return manualAccount(account, '文件中没有该账号');
    }
    // 读不出的银行名 / 开户地可能与本组一致，不算对不上
    const mayBeSameBank = (record) => (hasUnreadable(record, 'bankName') || compareKey(record.bankName) === groupBankKey)
      && (hasUnreadable(record, 'location') || compareKey(record.location) === groupLocationKey);
    if (!identityRecords.some(mayBeSameBank)) {
      const shownIdentity = (record, key) => {
        if (!hasUnreadable(record, key)) return record[key];
        return record.unreadableFields[key] === '为空' ? '' : '（读不出）';
      };
      const fileLabels = [...new Set(identityRecords.map((record) => bankLocationLabel(
        shownIdentity(record, 'bankName'), shownIdentity(record, 'location')
      )))];
      const shown = fileLabels.slice(0, MISMATCH_LOCATION_PREVIEW_LIMIT).join('、');
      const more = fileLabels.length > MISMATCH_LOCATION_PREVIEW_LIMIT ? ` 等 ${fileLabels.length} 组` : '';
      return manualAccount(
        account,
        `文件中该账号的银行名 / 开户地为 ${shown}${more}，与本组 ${bankLocationLabel(groupBankName, groupLocation)} 不一致`
      );
    }
    const candidates = sameAccount.filter((record) => (
      isEarlier(record) && compareKey(record.bankName) === groupBankKey && compareKey(record.location) === groupLocationKey
    ));
    if (!candidates.length) {
      return manualAccount(account, `文件中没有该账号早于 ${account.targetBillDate} 的余额`);
    }
    const latestDate = candidates.reduce((latest, record) => (record.billDate > latest ? record.billDate : latest), '');
    if (minBillDate && latestDate < minBillDate) {
      return manualAccount(
        account,
        `文件中该账号最近的余额在 ${latestDate}，早于已有的 ${minBillDate} 余额，导入后仍按已有余额核对，请手工填写`
      );
    }
    const sameDay = candidates.filter((record) => record.billDate === latestDate);
    const distinctAmounts = new Set(sameDay.map((record) => roundAmount(record.endBalance)));
    if (distinctAmounts.size > 1) {
      return {
        ...account,
        billDate: latestDate,
        endBalance: null,
        source: 'choice',
        reason: `文件中 ${latestDate} 有 ${distinctAmounts.size} 个不同余额，请选择`,
        choices: sameDay.map(toChoice)
      };
    }
    return {
      ...account,
      billDate: latestDate,
      endBalance: sameDay[0].endBalance,
      source: 'file',
      reason: ''
    };
  });
  const matchedCount = accounts.filter((account) => account.source === 'file').length;
  const choiceCount = accounts.filter((account) => account.source === 'choice').length;
  return {
    accounts,
    matchedCount,
    choiceCount,
    manualCount: accounts.length - matchedCount - choiceCount
  };
}

// 导入余额文件的待匹配账号（v3.2.22 D1）：只接受普通缺种子补录与「核对上一账单日余额」两种提示（prompt 无 reason）。
//   核对提示：当前核对账号在前（它已有种子，不在 pendingAccounts 内），带已有种子日期 minBillDate
//   （见 matchBalanceSeedImport），再加本分组缺种子的账号；按 银行账号 + 币种 去重。
// options.previousSeedDate({ merchantId, currency, targetBillDate })：按当前种子记录取核对账号在当前账单日期前最近的余额日期
//   （与重算取种子同口径），作为该账号可填日期的下限（minBillDate）；不给时退回提示生成时记下的种子日期。
function balanceImportAccountsForPrompt(prompt, { previousSeedDate } = {}) {
  if (!prompt || typeof prompt !== 'object' || prompt.reason) return [];
  const accounts = [];
  const seen = new Set();
  const add = (account, minBillDate = '') => {
    const merchantId = normalizeCell(account && account.merchantId);
    const currency = normalizeCell(account && account.currency);
    if (!merchantId) return;
    const key = JSON.stringify([merchantId, currency]);
    if (seen.has(key)) return;
    seen.add(key);
    accounts.push({
      merchantId,
      currency,
      targetBillDate: normalizeCell(account && account.targetBillDate),
      ...(minBillDate ? { minBillDate } : {})
    });
  };
  if (prompt.seedMismatch) {
    add(prompt, typeof previousSeedDate === 'function'
      ? normalizeCell(previousSeedDate({
        merchantId: normalizeCell(prompt.merchantId),
        currency: normalizeCell(prompt.currency),
        targetBillDate: normalizeCell(prompt.targetBillDate)
      }))
      : normalizeCell(prompt.seedMismatch.seedDate));
  }
  (Array.isArray(prompt.pendingAccounts) ? prompt.pendingAccounts : []).forEach((account) => add(account));
  return accounts;
}

module.exports = {
  BALANCE_IMPORT_COLUMNS,
  BALANCE_IMPORT_OPTIONAL_COLUMNS,
  balanceImportAccountsForPrompt,
  matchBalanceSeedImport,
  parseBalanceSeedImportRows,
  readBalanceSeedImportFile
};
