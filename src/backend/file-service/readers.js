const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const XLSX = require('xlsx');
const JSZip = require('jszip');
const {
  FileValidationError,
  SUPPORTED_EXTENSIONS,
  buildExpectedHeaderCandidates,
  isRowMeaningful,
  isUnverifiedLongNumber,
  normalizeCell,
  trimTrailingEmptyCells
} = require('./common');
// 自研流式 xlsx 读取器（JSZip + nodeStream 增量解码，内存恒定）。
//   仅用于 readMeaningfulRowsHead 的「只读文件头部前 N 行」场景，规避 SheetJS 全量读大文件 OOM。
const { readXlsxStreamed } = require('../xlsx/legacy/streaming-xlsx-reader');

function ensureSupportedFile(filePath) {
  const extension = path.extname(filePath).toLowerCase();

  if (!SUPPORTED_EXTENSIONS.has(extension)) {
    throw new FileValidationError('FILE_TYPE', '文件类型错误，请重新导入');
  }
}

// withSources：另在返回数组上记下每行的原文（不含行尾换行，与返回的行一一对应；v3.2.19 重复账单过滤按原文比较，
//   本解析器会吞掉未加引号字段中间的引号等，读出的值不能证明原文相同）。
// withDisplayText（v3.2.21 B112，网银账单生成）：另记下与读出值不同的「Excel 显示值」（见 resolveCsvDisplayText），
//   返回数组的不可枚举属性 displayText 与返回的行一一对应，每项为 Map<列下标, 显示值> 或 undefined；读出的值本身不变。
function parseCsvText(content, { blankrows = false, withSources = false, withDisplayText = false } = {}) {
  const rows = [];
  const sources = withSources ? [] : null;
  const displays = withDisplayText ? [] : null;
  let rowStart = 0;
  let current = [];
  let parts = [];
  let start = 0;
  let fieldStart = 0;
  let rowDisplays;
  let inQuotes = false;
  let i = 0;
  // 保留原状态机的宽松引号规则；按连续文本片段拼接，避免每字符一个
  // cons string 留存到整表结束。这里仍是既有整表 CSV reader。
  const finishCell = () => {
    parts.push(content.slice(start, i));
    const value = parts.join('');
    parts = [];
    if (displays) {
      const display = resolveCsvDisplayText(content.slice(fieldStart, i), value);
      if (display !== value) {
        if (!rowDisplays) rowDisplays = new Map();
        rowDisplays.set(current.length, display);
      }
    }
    return value;
  };
  const finishRow = () => {
    if (displays) displays.push(rowDisplays);
    rowDisplays = undefined;
  };

  while (i < content.length) {
    const ch = content[i];

    if (inQuotes) {
      if (ch === '"' && content[i + 1] === '"') {
        parts.push(content.slice(start, i), '"');
        i += 2;
        start = i;
      } else if (ch === '"') {
        parts.push(content.slice(start, i));
        inQuotes = false;
        i++;
        start = i;
      } else {
        i++;
      }
    } else if (ch === '"') {
      parts.push(content.slice(start, i));
      inQuotes = true;
      i++;
      start = i;
    } else if (ch === ',') {
      current.push(finishCell());
      i++;
      start = i;
      fieldStart = i;
    } else if (ch === '\r' && content[i + 1] === '\n') {
      current.push(finishCell());
      rows.push(current);
      finishRow();
      if (sources) sources.push(content.slice(rowStart, i));
      current = [];
      i += 2;
      start = i;
      fieldStart = i;
      rowStart = i;
    } else if (ch === '\n' || ch === '\r') {
      current.push(finishCell());
      rows.push(current);
      finishRow();
      if (sources) sources.push(content.slice(rowStart, i));
      current = [];
      i++;
      start = i;
      fieldStart = i;
      rowStart = i;
    } else {
      i++;
    }
  }

  const cell = finishCell();
  if (cell || current.length) {
    current.push(cell);
    rows.push(current);
    finishRow();
    if (sources) sources.push(content.slice(rowStart));
  }

  if (blankrows) {
    if (sources) Object.defineProperty(rows, 'sources', { value: sources, enumerable: false });
    if (displays) Object.defineProperty(rows, 'displayText', { value: displays, enumerable: false });
    return rows;
  }

  const kept = [];
  const keptSources = sources ? [] : null;
  const keptDisplays = displays ? [] : null;
  rows.forEach((row, index) => {
    if (!isRowMeaningful(row)) return;
    kept.push(row);
    if (keptSources) keptSources.push(sources[index]);
    if (keptDisplays) keptDisplays.push(displays[index]);
  });
  if (keptSources) Object.defineProperty(kept, 'sources', { value: keptSources, enumerable: false });
  if (keptDisplays) Object.defineProperty(kept, 'displayText', { value: keptDisplays, enumerable: false });
  return kept;
}

// v3.2.21 B112：CSV 单元格在 Excel 中显示的值。银行常用两种写法让 Excel 把长数字按文本显示：
//   - 整个字段写成 ="…"（Excel 当作返回文本的公式）：取引号内的文本，"" 还原为 "。本解析器读出的值已吞掉引号
//     （="123" 读成 =123），按字段原文判断；带引号字段内容为 ="…"（"=""123"""）时按读出的值判断。
//     未加引号的 =123、=A1+1 等是真公式，不还原；
//   - 首尾加制表符：去掉首尾制表符。
//   rawField 为该字段在文件中的原文（不含分隔符），value 为本解析器读出的值。
const CSV_EXCEL_TEXT_FORMULA = /^="((?:[^"]|"")*)"$/;
function resolveCsvDisplayText(rawField, value) {
  let display = value;
  const formula = CSV_EXCEL_TEXT_FORMULA.exec(rawField) || CSV_EXCEL_TEXT_FORMULA.exec(value);
  if (formula) display = formula[1].replace(/""/g, '"');
  return display.replace(/^\t+|\t+$/g, '');
}

// v2.1.16 PR#61 F4：可选 sheetName —— 缺省 = 第一个 sheet（行为与历史完全一致）。
//   传入 sheetName 时读指定 sheet（detector 多 sheet 扫描用）；sheet 不存在抛 FILE_READ。
//   ⚠️ CSV 无 sheet 概念：传 sheetName 也忽略，仍解析整份 CSV（detector 对 CSV 走单次默认读取）。
// v3.2.19 重复账单过滤：不能按读出的文本比较的单元格：
//   - Excel 错误值（#N/A 等，t='e'）→ { excelError: 文本 }；
//   - 公式单元格（含数组公式范围内的各格）→ { unknownFormula: 公式 }，该行不参与查重。SheetJS 读不出文件里是否有缓存结果
//     （没有缓存时数值公式读成占位、文本公式读成空串、布尔公式读成 false），无法证明读到的就是 Excel 的计算结果，宁可漏判。
//   收集后删除 sheetStubs 产生的占位单元格，使 sheet_to_json 的结果与不开 sheetStubs 时完全一致（普通映射不受影响）。
//   返回 Map<相对 rows 的行下标, Map<相对列下标, 标记>>；兼容 dense（两种存放方式）与普通工作表结构。
function collectSpecialCells(sheet, range) {
  const specials = new Map();
  const setMark = (r, c, mark) => {
    if (r < range.s.r || r > range.e.r || c < range.s.c || c > range.e.c) return;
    const rowIndex = r - range.s.r;
    if (!specials.has(rowIndex)) specials.set(rowIndex, new Map());
    specials.get(rowIndex).set(c - range.s.c, mark);
  };
  // 整行值未知（列下标记为 -1，读取整行时追加到行尾）：数组公式范围、声明范围以外仍有值的行
  const setRowUnknown = (r, reason) => {
    if (r < range.s.r || r > range.e.r) return;
    const rowIndex = r - range.s.r;
    if (!specials.has(rowIndex)) specials.set(rowIndex, new Map());
    if (!specials.get(rowIndex).has(-1)) specials.get(rowIndex).set(-1, { unknownValue: reason });
  };
  // 数组公式：范围内的格可能没有单元格对象，按行标记（不逐格展开）；同一范围只处理一次
  const arrayFormulas = new Set();
  const record = (r, c, cell) => {
    if (cell.F) arrayFormulas.add(String(cell.F));
    // 工作表声明的有效范围（!ref）小于实际数据时，sheet_to_json 读不到范围外的列：整行无法证明相同
    if (c < range.s.c || c > range.e.c) {
      const hasValue = cell.f || cell.F || (cell.t !== 'z' && cell.v !== undefined && cell.v !== null && String(cell.v).trim() !== '');
      if (hasValue) setRowUnknown(r, '有效范围以外的单元格');
      return;
    }
    if (cell.f || cell.F) setMark(r, c, { unknownFormula: String(cell.f || cell.F) });
    else if (cell.t === 'e') setMark(r, c, { excelError: String(cell.w || `#ERROR(${cell.v})`) });
    // 含替换字符（U+FFFD）的文本：可能是上游丢失不同字符后写入的，原文相同也不能证明是同一笔交易
    else if (typeof cell.v === 'string' && cell.v.includes('\uFFFD')) setMark(r, c, { unknownValue: '编码无法识别' });
  };
  // dense 工作表：本版 SheetJS 为 sheet[r][c]（sheet 本身是数组），新版为 sheet['!data'][r][c]
  const denseRows = Array.isArray(sheet) ? sheet : (Array.isArray(sheet['!data']) ? sheet['!data'] : null);
  if (denseRows) {
    denseRows.forEach((row, r) => {
      if (!Array.isArray(row)) return;
      row.forEach((cell, c) => {
        if (cell) record(r, c, cell);
      });
    });
  } else {
    Object.keys(sheet).forEach((address) => {
      if (address[0] === '!') return;
      const cell = sheet[address];
      if (!cell) return;
      const { r, c } = XLSX.utils.decode_cell(address);
      record(r, c, cell);
    });
  }
  arrayFormulas.forEach((formulaRange) => {
    let decoded;
    try {
      decoded = XLSX.utils.decode_range(formulaRange);
    } catch (_error) {
      return;
    }
    // 只在工作表有效范围内、有内容的行标记
    contentRowsWithin(sheet, Math.max(decoded.s.r, range.s.r), Math.min(decoded.e.r, range.e.r))
      .forEach((r) => setRowUnknown(r, `数组公式 ${formulaRange}`));
  });
  specials.markRowUnknown = setRowUnknown;
  // 整行的原始标记（列下标记为 -2，读取整行时追加到行尾，参与指纹比较）：HTML 表格每行的原始标记
  specials.markRowSource = (r, text) => {
    if (r < range.s.r || r > range.e.r) return;
    const rowIndex = r - range.s.r;
    if (!specials.has(rowIndex)) specials.set(rowIndex, new Map());
    specials.get(rowIndex).set(-2, { sourceText: String(text) });
  };
  // 工作簿使用 1904 日期系统（列下标记为 -3，追加到行尾，参与指纹比较）：同一日期序号在两种日期系统下是不同的日期
  specials.markRowDateSystem = (r) => {
    if (r < range.s.r || r > range.e.r) return;
    const rowIndex = r - range.s.r;
    if (!specials.has(rowIndex)) specials.set(rowIndex, new Map());
    specials.get(rowIndex).set(-3, { sourceText: 'date1904' });
  };
  specials.markCell = (r, c, mark) => {
    if (r < range.s.r || r > range.e.r || c < range.s.c || c > range.e.c) return;
    const rowMarks = specials.get(r - range.s.r);
    if (rowMarks && rowMarks.has(c - range.s.c)) return;
    setMark(r, c, mark);
  };
  // 删除 sheetStubs 产生的占位单元格，使 sheet_to_json 的结果与不开 sheetStubs 时一致
  if (denseRows) {
    denseRows.forEach((row) => {
      if (!Array.isArray(row)) return;
      row.forEach((cell, c) => { if (cell && cell.t === 'z') row[c] = undefined; });
    });
  } else {
    Object.keys(sheet).forEach((address) => {
      if (address[0] !== '!' && sheet[address] && sheet[address].t === 'z') delete sheet[address];
    });
  }
  return specials;
}

// v3.2.19 重复账单过滤：区间内有内容的行（dense 工作表的非空行），按区间标记时只标这些行（整列范围的条件格式、合并等
//   不为成千上万的空行逐行分配标记）
// v3.2.22：有效范围内含 Excel 错误值（#N/A、#DIV/0! 等，t='e'）的行（相对 rows 的下标）。读取库把错误值读成空串，
//   只有错误值的行在读取结果里与空行无异；网银账单据此区分「原表只有表头」与「原表有内容、读出来是空」（见 readRowsWithMetadata）
function collectErrorValueRows(sheet, range) {
  const rows = new Set();
  const denseRows = Array.isArray(sheet) ? sheet : (Array.isArray(sheet && sheet['!data']) ? sheet['!data'] : null);
  const hasError = (cell, c) => cell && cell.t === 'e' && c >= range.s.c && c <= range.e.c;
  if (denseRows) {
    const last = Math.min(range.e.r, denseRows.length - 1);
    for (let r = range.s.r; r <= last; r += 1) {
      const row = denseRows[r];
      if (Array.isArray(row) && row.some(hasError)) rows.add(r - range.s.r);
    }
    return rows;
  }
  Object.keys(sheet).forEach((address) => {
    if (address[0] === '!') return;
    const { r, c } = XLSX.utils.decode_cell(address);
    if (r >= range.s.r && r <= range.e.r && hasError(sheet[address], c)) rows.add(r - range.s.r);
  });
  return rows;
}

// v3.2.22 R20：有效范围（!ref，如 xlsx 的 dimension）以外仍有内容的行（相对有效范围首行的下标，可为负）。有的导出工具追加行后
//   不更新声明的范围，读取结果只到有效范围为止；网银账单据此不把这类文件判为「原表只有表头」（见 readRowsWithMetadata）
function collectOutOfRangeContentRows(sheet, range) {
  const rows = new Set();
  const denseRows = Array.isArray(sheet) ? sheet : (Array.isArray(sheet && sheet['!data']) ? sheet['!data'] : null);
  const hasContent = (cell) => cell && cell.t !== 'z' && !(cell.t === 's' && String(cell.v ?? '').trim() === '');
  const outside = (r, c) => r < range.s.r || r > range.e.r || c < range.s.c || c > range.e.c;
  if (denseRows) {
    denseRows.forEach((row, r) => {
      if (Array.isArray(row) && row.some((cell, c) => hasContent(cell) && outside(r, c))) rows.add(r - range.s.r);
    });
    return rows;
  }
  Object.keys(sheet).forEach((address) => {
    if (address[0] === '!') return;
    const { r, c } = XLSX.utils.decode_cell(address);
    if (outside(r, c) && hasContent(sheet[address])) rows.add(r - range.s.r);
  });
  return rows;
}

function contentRowsWithin(sheet, startRow, endRow) {
  const denseRows = Array.isArray(sheet) ? sheet : (Array.isArray(sheet && sheet['!data']) ? sheet['!data'] : null);
  if (!denseRows) {
    const rows = [];
    for (let r = startRow; r <= endRow; r += 1) rows.push(r);
    return rows;
  }
  const rows = [];
  const last = Math.min(endRow, denseRows.length - 1);
  for (let r = Math.max(0, startRow); r <= last; r += 1) {
    if (Array.isArray(denseRows[r]) && denseRows[r].some((cell) => cell && cell.t !== 'z')) rows.push(r);
  }
  return rows;
}

// XLS（BIFF8）工作簿流里是否有 Excel 2007 起的条件格式记录（CondFmt12 0x0879、CF12 0x087A、CFEx 0x087B）；
//   读不到工作簿流时按有处理（无法核对）
function hasBiffConditionalFormat12(filePath) {
  let stream;
  try {
    const container = XLSX.CFB.read(fs.readFileSync(filePath), { type: 'buffer' });
    const entry = XLSX.CFB.find(container, 'Workbook') || XLSX.CFB.find(container, 'Book');
    stream = entry && entry.content ? Buffer.from(entry.content) : null;
  } catch (_error) {
    stream = null;
  }
  if (!stream) return true;
  for (let offset = 0; offset + 4 <= stream.length;) {
    const type = stream.readUInt16LE(offset);
    const size = stream.readUInt16LE(offset + 2);
    if (type === 0x0879 || type === 0x087A || type === 0x087B) return true;
    offset += 4 + size;
  }
  return false;
}

// v3.2.19 重复账单过滤：按文件头判断工作簿的实际格式（与扩展名无关）
function detectWorkbookContainer(filePath) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const head = Buffer.alloc(4);
    const read = fs.readSync(fd, head, 0, 4, 0);
    if (read >= 4 && head[0] === 0xD0 && head[1] === 0xCF && head[2] === 0x11 && head[3] === 0xE0) return 'ole2';
    if (read >= 4 && head[0] === 0x50 && head[1] === 0x4B && head[2] === 0x03 && head[3] === 0x04) return 'zip';
    return 'text';
  } finally {
    fs.closeSync(fd);
  }
}

function decodeXmlAttribute(value) {
  return String(value)
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_m, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_m, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&amp;/g, '&');
}

function readXmlAttribute(tag, name) {
  const match = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`).exec(tag);
  return match ? decodeXmlAttribute(match[1] !== undefined ? match[1] : match[2]) : null;
}

function normalizeZipPath(baseDir, target) {
  const parts = (String(target).startsWith('/') ? String(target) : `${baseDir}/${target}`).split('/');
  const out = [];
  parts.forEach((part) => {
    if (!part || part === '.') return;
    if (part === '..') out.pop();
    else out.push(part);
  });
  return out.join('/');
}

// 条目名：先按原样（去掉开头的 /），找不到时不区分大小写
function resolveZipEntryKey(files, entryPath) {
  if (!files || !entryPath) return null;
  const key = String(entryPath).replace(/^\/+/, '');
  if (files[key]) return key;
  const lower = key.toLowerCase();
  return Object.keys(files).find((name) => name.replace(/^\/+/, '').toLowerCase() === lower) || null;
}

function getZipEntryBuffer(files, entryPath) {
  const key = resolveZipEntryKey(files, entryPath);
  const entry = key ? files[key] : null;
  return entry && entry.content ? Buffer.from(entry.content) : null;
}

// 读取库（safegetzipfile）找条目的口径：名称不区分大小写、按原样比较（不规范化 . 与 ..），斜杠与反斜杠两种写法都认
function findZipEntryKeyLikeReader(files, entryPath) {
  const backslashed = String(entryPath).toLowerCase().replace(/[/]/g, '\\');
  const slashed = backslashed.replace(/\\/g, '/');
  return Object.keys(files).find((name) => {
    const lower = name.replace(/^Root Entry[/]/, '').toLowerCase();
    return lower === backslashed || lower === slashed;
  }) || null;
}

// ---- 读取库（SheetJS 0.18.5）解析 XLSX 内部 XML 的口径 ----
// 逐行移植自其 tagregex1、attregexg、parsexmltag、cc2str、parse_rels、parse_zip（工作表条目定位）与 parse_ws_xml_data（行与单元格
//   坐标），只用于确认本模块按原文核对的位置就是读取库实际读取的位置，不能证明一致时不核对。不要按 XML 规范「修正」这些写法：
//   例如标签名只到第一个空格 / 换行 / 回车为止（制表符不算），属性的引号前有换行时引号也算进值里，自闭合的 <row/> 不推进行号。
//   升级读取库时须对照新版本重新核对（B133）。
const READER_TAG_PATTERN = /<[/?]?[a-zA-Z0-9:_-]+(?:\s+[^"\s?>/]+\s*=\s*(?:"[^"]*"|'[^']*'|[^'">\s=]+))*\s*[/?]?>/g;
const READER_ATTRIBUTE_PATTERN = /([^"\s?>/]+)\s*=\s*((?:")([^"]*)(?:")|(?:')([^']*)(?:')|([^'">\s]+))/g;

// parsexmltag：返回属性对象（另有小写键），skipRoot 为假时 [0] 为标签名（到第一个空格 / 换行 / 回车为止）
function readerTagAttributes(tag, skipRoot = false) {
  const z = {};
  let eq = 0;
  let c = 0;
  for (; eq !== tag.length; eq += 1) if ((c = tag.charCodeAt(eq)) === 32 || c === 10 || c === 13) break;
  if (!skipRoot) z[0] = tag.slice(0, eq);
  if (eq === tag.length) return z;
  const m = tag.match(READER_ATTRIBUTE_PATTERN);
  if (!m) return z;
  for (let i = 0; i !== m.length; i += 1) {
    const cc = m[i];
    for (c = 0; c !== cc.length; c += 1) if (cc.charCodeAt(c) === 61) break;
    let q = cc.slice(0, c).trim();
    while (cc.charCodeAt(c + 1) === 32) c += 1;
    const quot = ((eq = cc.charCodeAt(c + 1)) === 34 || eq === 39) ? 1 : 0;
    const v = cc.slice(c + 1 + quot, cc.length - quot);
    let j = 0;
    for (; j !== q.length; j += 1) if (q.charCodeAt(j) === 58) break;
    if (j === q.length) {
      if (q.indexOf('_') > 0) q = q.slice(0, q.indexOf('_'));
      z[q] = v;
      z[q.toLowerCase()] = v;
    } else {
      const k = (j === 5 && q.slice(0, 5) === 'xmlns' ? 'xmlns' : '') + q.slice(j + 1);
      if (z[k] && q.slice(j - 3, j) === 'ext') continue;
      z[k] = v;
      z[k.toLowerCase()] = v;
    }
  }
  return z;
}

// cc2str：读取库把 XML 条目按字节当作单字节字符处理；带 UTF-16 BOM 的条目另行转码，这里不核对（返回 null）
function readerXmlText(buffer) {
  if (!buffer) return null;
  const bytes = Buffer.from(buffer);
  if ((bytes[0] === 0xFF && bytes[1] === 0xFE) || (bytes[1] === 0xFE && bytes[2] === 0xFF)) return null;
  return bytes.toString('latin1');
}

// 读取库实际读取第 sheetIndex 张工作表（SheetNames 的下标）的压缩包条目键（parse_zip）。工作表的关系 Id 取读取库自己解析出的
//   Workbook.Sheets[i].id；关系文件按 parse_rels 的口径解析（只认标签名恰为 <Relationship 的标签、同一 Id 取后一条、注释不跳过）。
//   只要有一张表的关系找不到，读取库就改按物理序号（xl/worksheets/sheet{序号}.xml）读所有表。无法确认时返回 null
function readerWorksheetEntryKey(workbook, sheetIndex) {
  const files = workbook && workbook.files;
  const directory = workbook && workbook.Directory;
  const workbookPath = directory && Array.isArray(directory.workbooks) ? directory.workbooks[0] : null;
  const readerSheets = workbook && workbook.Workbook && Array.isArray(workbook.Workbook.Sheets) ? workbook.Workbook.Sheets : null;
  if (!files || typeof workbookPath !== 'string' || /\.bin$/i.test(workbookPath) || !readerSheets) return null;
  if (!Array.isArray(workbook.SheetNames) || readerSheets.length !== workbook.SheetNames.length || !readerSheets[sheetIndex]) return null;
  const relsSlash = workbookPath.lastIndexOf('/');
  let relsPath = `${workbookPath.slice(0, relsSlash + 1)}_rels/${workbookPath.slice(relsSlash + 1)}.rels`.replace(/^\//, '');
  if (!findZipEntryKeyLikeReader(files, relsPath)) relsPath = 'xl/_rels/workbook.xml.rels';
  const relsKey = findZipEntryKeyLikeReader(files, relsPath);
  const targetsById = new Map();
  if (relsKey) {
    const relsText = readerXmlText(files[relsKey] && files[relsKey].content);
    if (relsText === null && files[relsKey] && files[relsKey].content && files[relsKey].content.length) return null;
    (relsText ? relsText.match(READER_TAG_PATTERN) || [] : []).forEach((tag) => {
      const relation = readerTagAttributes(tag);
      if (relation[0] === '<Relationship') targetsById.set(String(relation.Id), relation.Target);
    });
  }
  const idOf = (sheet) => String(sheet.id || sheet.strRelID);
  let entryPath;
  if (readerSheets.every((sheet) => targetsById.has(idOf(sheet)))) {
    const target = targetsById.get(idOf(readerSheets[sheetIndex]));
    if (typeof target !== 'string') return null;
    entryPath = `xl/${target.replace(/[/]?xl\//, '')}`;
    if (!findZipEntryKeyLikeReader(files, entryPath)) entryPath = target;
    if (!findZipEntryKeyLikeReader(files, entryPath)) entryPath = relsPath.replace(/_rels\/.*$/, '') + target;
  } else {
    const zeroKey = findZipEntryKeyLikeReader(files, 'xl/worksheets/sheet.xml');
    const zeroBased = zeroKey && files[zeroKey] && files[zeroKey].content && files[zeroKey].content.length ? 1 : 0;
    entryPath = `xl/worksheets/sheet${sheetIndex + 1 - zeroBased}.xml`.replace(/sheet0\./, 'sheet.');
  }
  return findZipEntryKeyLikeReader(files, entryPath);
}

// parse_ws_xml_data：按读取库的口径逐格给出单元格的位置引用（单元格 r 属性按 parsexmltag 取，没有时为所在行与列的推算）、
//   开始标签的属性与其后的内容（到下一个单元格开始为止）。text 为 readerXmlText 的结果；visit 返回 false 时停止并返回 false。
//   读取库只认第一个 <sheetData>…最后一个 </sheetData> 之间的内容，按 </row> 切行；行内第一个不以 /> 结尾的标签为行标签
//   （自闭合的 <row/> 被并入下一行、不推进行号），行号取其 r 属性（parseInt），没有时为上一行 + 1；单元格按 <c 加空格、/ 或 >
//   切分，列号取片段中第一个 r="…" 的字母部分，没有时为上一格 + 1
const READER_SHEET_DATA_PATTERN = /<(?:\w+:)?sheetData[^>]*>([\s\S]*)<\/(?:\w+:)?sheetData>/;
const READER_ROW_END_PATTERN = /<\/(?:\w+:)?row>/;
const READER_CELL_START_PATTERN = /<(?:\w+:)?c[ />]/;
const READER_CELL_REF_PATTERN = /r=["']([^"']*)["']/;
function forEachReaderCell(text, visit) {
  const sheetData = text.match(READER_SHEET_DATA_PATTERN);
  if (!sheetData) return true;
  let tagr = 0;
  let tagc = 0;
  const rowChunks = sheetData[1].split(READER_ROW_END_PATTERN);
  for (let mt = 0; mt !== rowChunks.length; mt += 1) {
    const x = rowChunks[mt].trim();
    const xlen = x.length;
    if (xlen === 0) continue;
    let rstarti = 0;
    let ri = 0;
    for (; ri < xlen; ri += 1) {
      if (x[ri] === '>' && x[ri - 1] !== '/') {
        ri += 1;
        break;
      }
      if (x[ri] === '<') rstarti = ri;
    }
    if (rstarti >= ri) break;
    const rowTag = readerTagAttributes(x.slice(rstarti, ri), true);
    tagr = rowTag.r != null ? parseInt(rowTag.r, 10) : tagr + 1;
    tagc = -1;
    let cells = x.slice(ri).split(READER_CELL_START_PATTERN);
    let rslice = 0;
    for (; rslice !== cells.length; rslice += 1) if (cells[rslice].trim().charAt(0) !== '<') break;
    cells = cells.slice(rslice);
    for (let ci = 0; ci !== cells.length; ci += 1) {
      let cx = cells[ci].trim();
      if (cx.length === 0) continue;
      const cref = cx.match(READER_CELL_REF_PATTERN);
      cx = `<c ${cx.slice(0, 1) === '<' ? '>' : ''}${cx}`;
      if (cref != null && cref.length === 2) {
        let idx = 0;
        const letters = cref[1];
        for (let i = 0; i !== letters.length; i += 1) {
          const cc = letters.charCodeAt(i) - 64;
          if (cc < 1 || cc > 26) break;
          idx = 26 * idx + cc;
        }
        tagc = idx - 1;
      } else {
        tagc += 1;
      }
      let end = 0;
      for (; end !== cx.length; end += 1) if (cx.charCodeAt(end) === 62) break;
      end += 1;
      const cellTag = readerTagAttributes(cx.slice(0, end), true);
      const ref = cellTag.r ? cellTag.r : XLSX.utils.encode_cell({ r: tagr - 1, c: tagc });
      if (visit(ref, cellTag, cx.slice(end)) === false) return false;
    }
  }
  return true;
}

// XML 注释不是内容：注释里的旧关系、旧 <sheet> 等不能当作有效标签（release 审查）
function stripXmlComments(text) {
  return String(text).replace(/<!--[\s\S]*?-->/g, '');
}

// OOXML 关系命名空间（过渡与严格两种写法）
const OOXML_RELATIONSHIP_NAMESPACES = new Set([
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
  'http://purl.oclc.org/ooxml/officeDocument/relationships'
]);

// <sheet> 的关系 Id：标签上须恰好一个「前缀:id」属性，且该前缀在 workbook.xml 中只绑定到 OOXML 关系命名空间。读取库按属性的
//   本地名取 id（有多个时取后一个），标签另带扩展属性（如 custom:id）或前缀绑定不明时无法唯一确认它读的是哪张表，返回 null
//   （release 审查：否则可能取到另一张表的 XML，两表同一位置的数值舍入后相等时把另一张表的流水号写进当前表）
function readSheetRelationId(sheetTag, workbookText) {
  const idAttributes = sheetTag.match(/\s[\w.-]+:id\s*=/g) || [];
  if (idAttributes.length !== 1) return null;
  const prefix = idAttributes[0].trim().replace(/:id\s*=$/, '');
  const escapedPrefix = prefix.replace(/[.-]/g, '\\$&');
  const bindings = new Set();
  const declarationPattern = new RegExp(`\\sxmlns:${escapedPrefix}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'g');
  let declaration;
  while ((declaration = declarationPattern.exec(workbookText)) !== null) {
    bindings.add(declaration[1] !== undefined ? declaration[1] : declaration[2]);
  }
  if (bindings.size !== 1 || !OOXML_RELATIONSHIP_NAMESPACES.has(Array.from(bindings)[0])) return null;
  // 读取库按属性原文（不解码字符引用）查找关系：值含字符引用（如 rId&#49;）时两边的 Id 可能不同，无法确认（release 审查）
  if (attributeHasReference(sheetTag, `${escapedPrefix}:id`)) return null;
  return readXmlAttribute(sheetTag, `${escapedPrefix}:id`);
}

// 属性值是否含字符引用（&…;）：读取库按原文使用的属性，含引用时与解码后的值不同
function attributeHasReference(tag, name) {
  return new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"[^"]*&|'[^']*&)`).test(tag);
}

// 按 workbook.xml 中 <sheet> 的顺序（即 SheetNames 的顺序）与关系文件找到工作表 XML；找不到返回 null。
//   注释里的标签不算；同一关系 Id 有多条有效关系、或 <sheet> 的关系属性无法唯一确认时无法确认来源，同样返回 null
//   （按无法核对原值处理）
//   还须确认读取库实际读的就是这个条目（release 审查）：
//   - 读取库只要有一张表的关系解析不到，就放弃整份关系表、改按物理序号（xl/worksheets/sheetN.xml）读表：每张表的关系都须
//     唯一确认，否则返回 null（读取库自己能否解析到关系、按哪条路径读表见最后一条）；
//   - 读取库按「xl/ + 去掉其中第一个 xl/ 前缀的 Target」定位，找不到时依次取 Target 原样、关系文件所在目录 + Target：
//     须与按关系文件所在目录解析 Target 落到同一个条目；Target 含字符引用（读取库按原文使用）时同样无法确认；
//   - 读取库解析 workbook.xml 与关系文件时不跳过注释（注释里的 <sheet> 也算工作表、注释里的关系也算），关系只认不带前缀的
//     <Relationship>、同一 Id 取后一条：注释里有 <sheet> 时序号会错开，返回 null；每张表的关系按读取库的口径也须找到、
//     且与按本模块口径（注释不算、带不带前缀都认、同一 Id 唯一）确认的那条 Target 相同；
//   - 最后按读取库的口径（readerWorksheetEntryKey，含它认不出关系时改按物理序号读表，如 `<Relationship` 后用制表符分隔属性、
//     属性的引号前有换行，B133 构造①）算出它实际读取的条目，须与按关系文件确认的条目相同
function findXlsxSheetXml(workbook, sheetName) {
  const files = workbook && workbook.files;
  const directory = workbook && workbook.Directory;
  const workbookPath = directory && Array.isArray(directory.workbooks) && directory.workbooks[0];
  const workbookXml = getZipEntryBuffer(files, workbookPath);
  if (!workbookXml) return null;
  const workbookDir = String(workbookPath).replace(/^\/+/, '').split('/').slice(0, -1).join('/');
  const relsDirPrefix = workbookDir ? `${workbookDir}/` : '';
  const relsXml = getZipEntryBuffer(files, `${relsDirPrefix}_rels/${String(workbookPath).split('/').pop()}.rels`);
  if (!relsXml) return null;
  const rawWorkbookText = workbookXml.toString('utf8');
  const workbookText = stripXmlComments(rawWorkbookText);
  const sheetTagPattern = /<(?:[\w.-]+:)?sheet\b[^>]*>/g;
  const sheetTags = workbookText.match(sheetTagPattern) || [];
  if ((rawWorkbookText.match(sheetTagPattern) || []).length !== sheetTags.length) return null;
  const sheetIndex = Array.isArray(workbook.SheetNames) ? workbook.SheetNames.indexOf(sheetName) : -1;
  const sheetTag = sheetIndex >= 0 ? sheetTags[sheetIndex] : null;
  if (!sheetTag || readXmlAttribute(sheetTag, 'name') !== sheetName) return null;
  const relsText = relsXml.toString('utf8');
  const relationTagsById = new Map();
  (stripXmlComments(relsText).match(/<(?:[\w.-]+:)?Relationship\b[^>]*>/g) || []).forEach((tag) => {
    const id = readXmlAttribute(tag, 'Id');
    if (!relationTagsById.has(id)) relationTagsById.set(id, []);
    relationTagsById.get(id).push(tag);
  });
  const uniqueRelationTag = (tag) => {
    const id = readSheetRelationId(tag, workbookText);
    const tags = id ? relationTagsById.get(id) : null;
    if (!tags || tags.length !== 1) return null;
    // 关系的 Id、Target 含字符引用时，读取库按原文使用、与解码后的值不同，无法确认
    if (attributeHasReference(tags[0], 'Id') || attributeHasReference(tags[0], 'Target')) return null;
    return tags[0];
  };
  if (!sheetTags.every((tag) => uniqueRelationTag(tag))) return null;
  const relationTag = uniqueRelationTag(sheetTag);
  const target = readXmlAttribute(relationTag, 'Target');
  if (!target) return null;
  const entryKey = resolveZipEntryKey(files, normalizeZipPath(workbookDir, target));
  if (!entryKey || readerWorksheetEntryKey(workbook, sheetIndex) !== entryKey) return null;
  return getZipEntryBuffer(files, entryKey);
}

// 按需解压 ZIP 条目：按中央目录（与读取库同口径）登记各条目，读取 content 时才解压该条目（release 审查：核对长数字只需
//   workbook.xml、其关系文件与目标工作表，不必把其他工作表、嵌入图片等整包再解压一次）。ZIP64、加密、条目名重复（不区分
//   大小写）、未知压缩方式或结构异常时返回 null，由调用方退回整包读取。条目数据读不出、解压失败或长度与登记不符时 content 为 null
//   （按无法核对原值处理）；容量类错误照常抛出
function openZipEntriesLazily(buffer) {
  const EOCD_SIZE = 22;
  if (!Buffer.isBuffer(buffer) || buffer.length < EOCD_SIZE) return null;
  let eocd = -1;
  const lowest = Math.max(0, buffer.length - EOCD_SIZE - 0xffff);
  for (let offset = buffer.length - EOCD_SIZE; offset >= lowest; offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50 && offset + EOCD_SIZE + buffer.readUInt16LE(offset + 20) === buffer.length) {
      eocd = offset;
      break;
    }
  }
  if (eocd < 0) return null;
  const entryCount = buffer.readUInt16LE(eocd + 10);
  const directorySize = buffer.readUInt32LE(eocd + 12);
  const directoryOffset = buffer.readUInt32LE(eocd + 16);
  if (entryCount === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff) return null;
  if (directoryOffset + directorySize > eocd) return null;
  const files = {};
  const seenNames = new Set();
  let cursor = directoryOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (cursor + 46 > eocd || buffer.readUInt32LE(cursor) !== 0x02014b50) return null;
    const flags = buffer.readUInt16LE(cursor + 8);
    const method = buffer.readUInt16LE(cursor + 10);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const uncompressedSize = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const nameEnd = cursor + 46 + nameLength;
    if (nameEnd > eocd) return null;
    const name = buffer.toString(flags & 0x800 ? 'utf8' : 'latin1', cursor + 46, nameEnd);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    cursor = nameEnd + buffer.readUInt16LE(cursor + 30) + buffer.readUInt16LE(cursor + 32);
    if (flags & 0x1) return null;
    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localOffset === 0xffffffff) return null;
    const key = name.replace(/^\/+/, '');
    const lowerKey = key.toLowerCase();
    if (seenNames.has(lowerKey)) return null;
    seenNames.add(lowerKey);
    if (key.endsWith('/')) continue;
    if (method !== 0 && method !== 8) return null;
    let loaded = false;
    let content = null;
    files[key] = {
      get content() {
        if (!loaded) {
          loaded = true;
          content = inflateZipEntry(buffer, { localOffset, method, compressedSize, uncompressedSize });
        }
        return content;
      }
    };
  }
  return files;
}

function inflateZipEntry(buffer, { localOffset, method, compressedSize, uncompressedSize }) {
  if (localOffset + 30 > buffer.length || buffer.readUInt32LE(localOffset) !== 0x04034b50) return null;
  const dataStart = localOffset + 30 + buffer.readUInt16LE(localOffset + 26) + buffer.readUInt16LE(localOffset + 28);
  if (dataStart + compressedSize > buffer.length) return null;
  const data = buffer.subarray(dataStart, dataStart + compressedSize);
  let output;
  try {
    output = method === 0 ? data : zlib.inflateRawSync(data);
  } catch (error) {
    if (isMemoryLimitError(error)) throw error;
    return null;
  }
  return output.length === uncompressedSize ? output : null;
}

function sha256Text(text) {
  return crypto.createHash('sha256').update(String(text)).digest('hex');
}

// XLSX 共享字符串表：每项 <si> 的原始 XML（不解码，字符引用、富文本标记都按原样保留）。
//   没有共享字符串表时返回 []；声明了却读不到时返回 null。
function readXlsxSharedStringSources(workbook) {
  const files = workbook && workbook.files;
  const directory = workbook && workbook.Directory;
  const workbookPath = directory && Array.isArray(directory.workbooks) && directory.workbooks[0];
  let sstPath = '';
  if (workbookPath) {
    const workbookDir = String(workbookPath).replace(/^\/+/, '').split('/').slice(0, -1).join('/');
    const relsXml = getZipEntryBuffer(files, `${workbookDir ? `${workbookDir}/` : ''}_rels/${String(workbookPath).split('/').pop()}.rels`);
    const relationTag = relsXml && (stripXmlComments(relsXml.toString('utf8')).match(/<(?:[\w.-]+:)?Relationship\b[^>]*>/g) || [])
      .find((tag) => /\/sharedStrings$/.test(readXmlAttribute(tag, 'Type') || ''));
    const target = relationTag ? readXmlAttribute(relationTag, 'Target') : null;
    if (target) sstPath = normalizeZipPath(workbookDir, target);
  }
  if (!sstPath && directory && directory.sst) sstPath = String(directory.sst);
  if (!sstPath) return [];
  const sstXml = getZipEntryBuffer(files, sstPath);
  if (!sstXml) return null;
  const sources = [];
  const itemPattern = /<(?:[\w.-]+:)?si\b[^>]*?(?:\/>|>([\s\S]*?)<\/(?:[\w.-]+:)?si>)/g;
  const text = sstXml.toString('utf8');
  let match;
  while ((match = itemPattern.exec(text)) !== null) sources.push(match[1] || '');
  return sources;
}

// XLSX 样式表原文：没有样式表时返回 ''；声明了却读不到时返回 null。
//   v3.2.22 R24：关系文件与样式表中的注释去掉（注释里的 <Relationship>、<dxf/>、<xf> 不算，Excel 不读注释）；样式表不是 UTF-8
//   （UTF-16 等，按 UTF-8 解码后认不出元素）、有 CDATA / DTD，或注释没有结束时按读不到处理（无法核对）
function readXlsxStylesText(workbook) {
  const files = workbook && workbook.files;
  const directory = workbook && workbook.Directory;
  const workbookPath = directory && Array.isArray(directory.workbooks) && directory.workbooks[0];
  let stylesPath = '';
  if (workbookPath) {
    const workbookDir = String(workbookPath).replace(/^\/+/, '').split('/').slice(0, -1).join('/');
    const relsXml = getZipEntryBuffer(files, `${workbookDir ? `${workbookDir}/` : ''}_rels/${String(workbookPath).split('/').pop()}.rels`);
    const relationTag = relsXml && (stripXmlComments(relsXml.toString('utf8')).match(/<(?:[\w.-]+:)?Relationship\b[^>]*>/g) || [])
      .find((tag) => /\/styles$/.test(readXmlAttribute(tag, 'Type') || ''));
    const target = relationTag ? readXmlAttribute(relationTag, 'Target') : null;
    if (target) stylesPath = normalizeZipPath(workbookDir, target);
  }
  if (!stylesPath && directory && directory.style) stylesPath = String(directory.style);
  if (!stylesPath) return '';
  const stylesXml = getZipEntryBuffer(files, stylesPath);
  if (!stylesXml) return null;
  const bytes = Buffer.from(stylesXml);
  if (readerXmlText(bytes) === null || bytes.includes(0)) return null;
  const text = stripXmlComments(bytes.toString('utf8'));
  return /<!--|<!\[CDATA\[|<!DOCTYPE|<!ENTITY/i.test(text) ? null : text;
}

// XLSX 单元格样式序号（cellXfs 下标）→ 数字格式标识：自定义格式按格式代码（不同文件的格式编号可以不同），内置格式按编号。
//   样式表读不到时返回 null（无法核对显示格式）。
function readXlsxCellFormatResolver(workbook) {
  const text = readXlsxStylesText(workbook);
  if (text === null) return null;
  // 属性值里可以有未转义的 >（如格式代码 [>0]"A-"000;General）：按引号边界匹配整个标签；读不到格式代码时记为 null（无法核对）
  const customFormats = new Map();
  // 自定义格式只取 <numFmts> 中的（R25：差异格式 <dxf> 里的 numFmt 不定义单元格格式，同号时不得覆盖）。这几张表只认主命名空间的
  //   直接子元素（R26：扩展命名空间的同名元素会让样式序号错位），表出现多次或结构无法确认时无法核对（见 xlsxStyleTableChildren）
  const tables = xlsxStyleTables(text, [['numFmts', 'numFmt'], ['cellXfs', 'xf'], ['cellStyleXfs', 'xf']]);
  if (!tables) return null;
  const [numFmtTags, cellXfChildren, cellStyleXfChildren] = tables;
  numFmtTags.forEach(({ tag }) => {
    const id = readXmlAttribute(tag, 'numFmtId');
    if (id !== null) customFormats.set(Number(id), readXmlAttribute(tag, 'formatCode'));
  });
  const cellXfs = cellXfChildren.map(({ tag }) => tag);
  const cellStyleXfs = cellStyleXfChildren.map(({ tag }) => tag);
  const formatKey = (formatId) => {
    if (!customFormats.has(formatId)) return `builtin:${formatId}`;
    const code = customFormats.get(formatId);
    return code === null ? null : `custom:${code}`;
  };
  // 单元格样式自身的格式与其所属命名样式（cellStyleXfs[xfId]）的格式都计入：applyNumberFormat="0" 时显示用的是命名样式的格式，
  //   不判断继承规则，两者都相同才算同一格式。引用的样式不存在时返回 null（无法核对）
  return (styleIndex) => {
    const index = Number(styleIndex) || 0;
    if (index === 0 && !cellXfs.length) return JSON.stringify([formatKey(0), null, null]);
    const xf = cellXfs[index];
    if (!xf) return null;
    const ownFormat = formatKey(Number(readXmlAttribute(xf, 'numFmtId') || 0));
    if (ownFormat === null) return null;
    // applyNumberFormat 决定用自身格式还是命名样式的格式：一并计入（不判断取舍规则）
    const applyNumberFormat = readXmlAttribute(xf, 'applyNumberFormat');
    const parentIndex = readXmlAttribute(xf, 'xfId');
    // 没有命名样式表（cellStyleXfs）时没有可继承的格式
    if (parentIndex === null || !cellStyleXfs.length) return JSON.stringify([ownFormat, null, applyNumberFormat]);
    const parent = cellStyleXfs[Number(parentIndex)];
    if (!parent) return null;
    const parentFormat = formatKey(Number(readXmlAttribute(parent, 'numFmtId') || 0));
    if (parentFormat === null) return null;
    return JSON.stringify([ownFormat, parentFormat, applyNumberFormat]);
  };
}

// XLSX 样式表中带数字格式（numFmt）的差异格式（dxf）序号 { ids, count（差异格式的个数，R27） }；样式表读不到时返回 null（按可能带数字格式处理）。
//   v3.2.22 R24：差异格式表（dxfs）不止一个，或表内除 <dxf> 外还有别的内容时同样返回 null（序号无法确认）；R26 起只认主命名空间的直接子元素
function readXlsxNumberFormatDxfIds(workbook) {
  const text = readXlsxStylesText(workbook);
  if (text === null) return null;
  // R26：只给主命名空间的直接 <dxf> 子元素编号（扩展命名空间的 <extra:dxf/> 等 Excel 忽略，计入会让序号错位），见 xlsxStyleTableChildren
  const dxfs = xlsxStyleTables(text, [['dxfs', 'dxf']]);
  if (!dxfs) return null;
  const ids = new Set();
  dxfs[0].forEach(({ inner }, index) => {
    if (/<(?:[\w.-]+:)?numFmt\b/.test(inner)) ids.add(index);
  });
  return { ids, count: dxfs[0].length };
}

// XLSX 条件格式可以给满足条件的单元格换数字格式（如把 123 显示为 TX-A-0123），读取只得到值：
//   带数字格式的条件格式（含 x14 扩展）覆盖的行不参与查重。
function markConditionalNumberFormatRows(workbook, sheet, text, range, specials) {
  conditionalNumberFormatAreas(workbook, text).forEach((area) => {
    const decoded = area || range;
    contentRowsWithin(sheet, Math.max(decoded.s.r, range.s.r), Math.min(decoded.e.r, range.e.r))
      .forEach((r) => specials.markRowUnknown(r, '条件格式'));
  });
}

// 带数字格式的条件格式（含 x14 扩展）覆盖的区域（v3.2.22 R24 抽出，账单查重与补录余额「导入余额文件」共用）：
//   返回区域数组，元素为 decode_range 的结果，null 表示整张表（没有 sqref、引用写法无法解析）。工作表 XML 有注释时
//   （注释里的结束标签会截断条件格式块）只要提到条件格式就按整张表处理
function conditionalNumberFormatAreas(workbook, text) {
  if (!/conditionalFormatting/.test(text)) return [];
  if (text.includes('<!--')) return [null];
  // 条件格式块按 XML 元素逐个取（R27：按正则配对时，结束标签带空白（</conditionalFormatting >）、自闭合的块会漏读或吞掉下一块）；
  //   sheetData 之后的结构无法解析、块嵌套，或原文中的条件格式块与取到的个数不同时按整张表处理
  const sheetTail = xlsxSheetParts(text);
  if (!sheetTail) return [null];
  const blocks = [];
  let open = null;
  let selfClosingBlocks = 0;
  const walked = walkXmlTags(sheetTail.tail, sheetTail.mainPrefixes, (item) => {
    if (item.name !== 'conditionalFormatting') return true;
    if (!item.closing) {
      if (open) return false;
      if (item.selfClosing) selfClosingBlocks += 1;
      else open = { tag: item.tag, depth: item.depth, start: item.end };
      return true;
    }
    if (!open || item.depth !== open.depth) return false;
    blocks.push({ tag: open.tag, body: sheetTail.tail.slice(open.start, item.index) });
    open = null;
    return true;
  });
  const openingCount = (text.match(/<(?:[\w.-]+:)?conditionalFormatting\b/g) || []).length;
  if (!walked || openingCount !== blocks.length + selfClosingBlocks) return [null];
  const areas = [];
  let numberFormatDxfs;
  for (const { tag, body } of blocks) {
    let hasNumberFormat = /<(?:[\w.-]+:)?numFmt\b/.test(body);
    if (!hasNumberFormat) {
      // dxfId 不是纯数字（如字符引用 &#48;，R25），或差异格式表里没有这一项（R27）时无法确认，按带数字格式处理
      const dxfIdValues = Array.from(body.matchAll(/\bdxfId\s*=\s*(["'])([^"']*)\1/g)).map((item) => item[2]);
      if (dxfIdValues.some((value) => !/^\d+$/.test(value))) {
        hasNumberFormat = true;
      } else if (dxfIdValues.length) {
        if (numberFormatDxfs === undefined) numberFormatDxfs = readXlsxNumberFormatDxfIds(workbook);
        hasNumberFormat = numberFormatDxfs === null
          || dxfIdValues.some((id) => Number(id) >= numberFormatDxfs.count || numberFormatDxfs.ids.has(Number(id)));
      }
    }
    if (!hasNumberFormat) continue;
    const sqref = readXmlAttribute(tag, 'sqref') || ((/<(?:[\w.-]+:)?sqref\s*>([^<]*)<\//.exec(body) || [])[1]) || '';
    const refs = sqref.trim().split(/\s+/).filter(Boolean);
    if (!refs.length) {
      areas.push(null);
      continue;
    }
    refs.forEach((ref) => {
      let decoded = null;
      try {
        decoded = XLSX.utils.decode_range(ref);
      } catch (_error) {
        decoded = null;
      }
      const valid = decoded && [decoded.s.r, decoded.s.c, decoded.e.r, decoded.e.c].every((value) => Number.isInteger(value) && value >= 0);
      areas.push(valid ? decoded : null);
    });
  }
  return areas;
}

// XLSX：按工作表 XML 原文核对，不依赖 SheetJS 读出的值（它会把超过 15 位有效数字的数值舍入、把字符引用与文字读成同一文本等）：
//   - 含公式元素的行、共享 / 数组公式引用范围内的行不参与查重：共享公式的从属单元格可以写成空的
//     <f t="shared" si="0"></f>，此时 SheetJS 不给 f，读成空白（实测）；
//   - 其余每行取各单元格的列号、类型与原始 XML（共享字符串换成该项 <si> 原始 XML 的摘要，每项只算一次）的摘要附在该行指纹上：
//     原文完全相同的行才可能判为重复（同一值的不同写法按不同处理，宁可漏判）；
//   - 原文行须与读到的行一一对应：有 <row> 省略行号时整张表不参与（自闭合空行等写法下计数可能与读取库不同）；
//     单元格省略位置、或原文的单元格个数与读到的不同时该行不参与；
//   找不到工作表或共享字符串的原文时整张表都不参与查重。
function markXlsxSourceEvidence(workbook, sheetName, sheet, range, specials) {
  const markAllRows = (reason) => {
    for (let r = range.s.r; r <= range.e.r; r += 1) specials.markRowUnknown(r, reason);
  };
  const xml = findXlsxSheetXml(workbook, sheetName);
  if (!xml) {
    markAllRows('无法核对工作表原文');
    return;
  }
  const text = xml.toString('utf8');
  markConditionalNumberFormatRows(workbook, sheet, text, range, specials);
  // 单元格实际的数字格式（显示文本可以因格式不同）：单元格自身的样式，没有时继承行样式（customFormat）、再继承列样式。
  //   读取库只按单元格自身的样式给格式（继承的读成 General），这里按原文解析
  const formatOf = readXlsxCellFormatResolver(workbook);
  if (!formatOf) {
    markAllRows('无法核对样式表原文');
    return;
  }
  const columnStyles = (((/<(?:[\w.-]+:)?cols\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?cols>/.exec(text) || [])[1] || '')
    .match(/<(?:[\w.-]+:)?col\b(?:[^>"']|"[^"]*"|'[^']*')*>/g) || [])
    .map((tag) => ({
      min: Number(readXmlAttribute(tag, 'min') || 0),
      max: Number(readXmlAttribute(tag, 'max') || 0),
      style: readXmlAttribute(tag, 'style')
    }));
  const columnStyleOf = (column) => {
    const hit = columnStyles.find((item) => column + 1 >= item.min && column + 1 <= item.max);
    return hit && hit.style !== null ? hit.style : null;
  };
  let sharedStrings;
  const sharedDigests = new Map();
  const sharedDigest = (index) => {
    if (!sharedDigests.has(index)) {
      const source = sharedStrings ? sharedStrings[index] : undefined;
      sharedDigests.set(index, source === undefined ? undefined : sha256Text(source));
    }
    return sharedDigests.get(index);
  };
  const typedRows = Array.isArray(sheet) ? sheet : (Array.isArray(sheet && sheet['!data']) ? sheet['!data'] : []);
  const typedCellCount = (rowIndex) => (Array.isArray(typedRows[rowIndex]) ? typedRows[rowIndex] : [])
    .filter((cell) => cell && cell.t !== 'z' && cell.v !== undefined).length;
  const formulaTag = /<(?:[\w.-]+:)?f[\s>/]/;
  const rowPattern = /<(?:[\w.-]+:)?row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:[\w.-]+:)?row>)/g;
  const cellPattern = /<(?:[\w.-]+:)?c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:[\w.-]+:)?c>)/g;
  const sharedIndexPattern = /<(?:[\w.-]+:)?v\b[^>]*>\s*(\d+)\s*<\/(?:[\w.-]+:)?v>/;
  // 已核对原文（得到原文摘要）的行；其余有内容的行（原文没有匹配到、写法未识别等）一律不参与查重。
  //   出现过的行号另记（含公式等提前跳过的行），行号重复声明时整张表不参与
  const verifiedRows = new Set();
  const declaredRows = new Set();
  let match;
  while ((match = rowPattern.exec(text)) !== null) {
    const rowAttr = readXmlAttribute(match[1], 'r');
    if (!rowAttr || !/^\d+$/.test(rowAttr)) {
      markAllRows('工作表原文的行号无法核对');
      return;
    }
    const rowIndex = Number(rowAttr) - 1;
    if (declaredRows.has(rowIndex)) {
      markAllRows('工作表原文的行号重复');
      return;
    }
    declaredRows.add(rowIndex);
    const body = match[2] || '';
    if (formulaTag.test(body)) {
      specials.markRowUnknown(rowIndex, '公式');
      continue;
    }
    const rowCustomFormat = /^(?:1|true)$/i.test(readXmlAttribute(match[1], 'customFormat') || '');
    const rowStyle = rowCustomFormat ? readXmlAttribute(match[1], 's') : null;
    const cells = [];
    let cellMatch;
    let unresolved = '';
    cellPattern.lastIndex = 0;
    while ((cellMatch = cellPattern.exec(body)) !== null) {
      const ref = readXmlAttribute(cellMatch[1], 'r');
      let column;
      try {
        column = ref ? XLSX.utils.decode_cell(ref).c : NaN;
      } catch (_error) {
        column = NaN;
      }
      if (!Number.isInteger(column) || column < 0) {
        unresolved = '单元格位置无法核对';
        break;
      }
      const cellBody = cellMatch[2] || '';
      if (!cellBody.trim()) continue;
      const type = readXmlAttribute(cellMatch[1], 't') || 'n';
      const cellStyle = readXmlAttribute(cellMatch[1], 's');
      const format = formatOf(cellStyle !== null ? cellStyle : (rowStyle !== null ? rowStyle : columnStyleOf(column)));
      if (format === null) {
        unresolved = '数字格式无法核对';
        break;
      }
      if (type === 's') {
        if (sharedStrings === undefined) sharedStrings = readXlsxSharedStringSources(workbook);
        const indexMatch = sharedIndexPattern.exec(cellBody);
        const digest = indexMatch ? sharedDigest(Number(indexMatch[1])) : undefined;
        if (digest === undefined) {
          unresolved = '共享字符串无法核对';
          break;
        }
        cells.push([column, 's', digest, format]);
      } else {
        cells.push([column, type, cellBody, format]);
      }
    }
    if (!unresolved && cells.length !== typedCellCount(rowIndex)) unresolved = '工作表原文与读取结果对不上';
    if (unresolved) {
      specials.markRowUnknown(rowIndex, unresolved);
    } else {
      specials.markRowSource(rowIndex, sha256Text(JSON.stringify(cells)));
      verifiedRows.add(rowIndex);
    }
  }
  for (let r = range.s.r; r <= range.e.r; r += 1) {
    if (!verifiedRows.has(r) && typedCellCount(r) > 0) specials.markRowUnknown(r, '工作表原文未核对');
  }
  const refs = new Set();
  (text.match(/<(?:[\w.-]+:)?f\b[^>]*>/g) || []).forEach((tag) => {
    const ref = readXmlAttribute(tag, 'ref');
    if (ref) refs.add(ref);
  });
  refs.forEach((ref) => {
    let decoded;
    try {
      decoded = XLSX.utils.decode_range(ref);
    } catch (_error) {
      markAllRows(`公式范围 ${ref}`);
      return;
    }
    contentRowsWithin(sheet, Math.max(decoded.s.r, range.s.r), Math.min(decoded.e.r, range.e.r))
      .forEach((r) => specials.markRowUnknown(r, `公式范围 ${ref}`));
  });
}

// 文本单元格在 Excel 中会按公式计算：以 =、@ 开头，或以 +、- 开头但不是普通带符号数字（+ROW()、-A1 等）。
//   普通带符号金额（+100、-1,234.56、-5%）与只有正负号的占位（-、--）照常比较。
function looksLikeSpreadsheetFormula(value) {
  const text = String(value == null ? '' : value).trim();
  if (!text) return false;
  if (text[0] === '=' || text[0] === '@') return true;
  if (text[0] !== '+' && text[0] !== '-') return false;
  if (/^[+-]+$/.test(text)) return false;
  return !/^[+-]\s*(?:\d[\d,]*(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?%?$/.test(text);
}

// XLSX / XLS：数字格式可以给同一个值加上不同的显示文本（如 123 按 "TX-A-"0000、"TX-B-"0000 显示为 TX-A-0123、TX-B-0123），
//   读取只得到值。带非常规格式的单元格按「类型 + 值 + 格式代码」比较（同一值不同格式按不同处理，宁可漏判）。
//   includeGeneral（二进制 XLS，没有原文行摘要）：常规格式的值也按「类型 + 值」比较（布尔值 TRUE 与文本 true 不同）。
function markNumberFormatCells(sheet, specials, { includeGeneral = false } = {}) {
  const denseRows = Array.isArray(sheet) ? sheet : (Array.isArray(sheet && sheet['!data']) ? sheet['!data'] : null);
  if (!denseRows) return;
  denseRows.forEach((row, r) => {
    if (!Array.isArray(row)) return;
    row.forEach((cell, c) => {
      if (!cell || cell.t === 'z' || cell.v === undefined) return;
      const format = typeof cell.z === 'string' ? cell.z : 'General';
      if (format === 'General' && !includeGeneral) return;
      specials.markCell(r, c, { sourceText: JSON.stringify(['format', format, cell.t, String(cell.v)]) });
    });
  });
}

// 文本型工作簿（扩展名为 .xls / .xlsx 的非 OLE2 / ZIP 文件）的实际格式。只核对能正向识别、能证明原文的两种：
//   HTML 表格、分隔符文本（首行含制表符、逗号、分号或竖线，或以 sep= 声明分隔符）；其他（Excel 2003 XML、SYLK、DIF、
//   SocialCalc、RTF、固定宽度文本、含 NUL 字节的二进制格式、UTF-16 等）整张表不参与查重。按 latin1 看字节，不丢失任何字节。
function classifyTextWorkbook(latinText) {
  if (/^(?:\xFF\xFE|\xFE\xFF)/.test(latinText)) return 'unsupported';
  const body = latinText.replace(/^\xEF\xBB\xBF/, '');
  if (body.slice(0, 4096).includes('\x00')) return 'unsupported';
  const head = body.replace(/^\s+/, '').slice(0, 4096);
  if (head.startsWith('<')) {
    // 按文档根元素区分：Excel 2003 XML 的根元素是 Workbook；HTML 可以声明 SpreadsheetML 命名空间，不能按全文搜索判断
    let rest = head;
    for (;;) {
      const next = rest.replace(/^\s+/, '').replace(/^<\?[\s\S]*?\?>/, '').replace(/^<!--[\s\S]*?-->/, '').replace(/^<!DOCTYPE[^>]*>/i, '');
      if (next === rest) break;
      rest = next;
    }
    const rootMatch = /^<([\w.:-]+)/.exec(rest);
    const rootName = rootMatch ? rootMatch[1].split(':').pop().toLowerCase() : '';
    if (rootName === 'workbook') return 'unsupported';
    return /<table/i.test(latinText) ? 'html' : 'unsupported';
  }
  if (/^(?:ID;|TABLE\r?\n|\{\\rtf|socialcalc:version:)/i.test(head)) return 'unsupported';
  if (/^sep=./.test(body)) return 'delimited';
  const firstLine = body.split(/\r\n|\n|\r/)[0];
  return /[\t,;|]/.test(firstLine) ? 'delimited' : 'unsupported';
}

// HTML 表格：SheetJS 只读第一个表格，按 <tr> 切行，单元格文本会去掉标签与标签两侧的空白（REF <b>A</b> 与 REFA 都读成 REFA）。
//   按与 SheetJS 相同的切分规则从原始字节（latin1，不丢字节）取每行的原始标记，附在该行指纹上：原始标记完全相同的行才可能判为重复。
//   切出的行与读到的工作表对不上时返回 false（整张表不参与查重）。
function markHtmlRowSources(latinText, sheet, range, specials) {
  const source = latinText.replace(/<!--.*?-->/g, '');
  const tableStart = source.search(/<table/i);
  if (tableStart < 0) return false;
  const tableEndMatch = source.match(/<\/table/i);
  const tableEnd = tableEndMatch && tableEndMatch.index || source.length;
  // 行摘要另含表格各行以外的文档原文（BOM、<head> 中声明的字符编码与样式表、<table> 开始标签、表格之后的内容）：
  //   同样的行字节在不同编码下是不同的文字（C3 A9 在 UTF-8 是 é、在 Windows-1252 是 Ã©），样式表里的 mso-number-format
  //   可以把同一个值显示成不同的文本（123 显示为 TX-A-0123、TX-B-0123）。这些上下文不同的文件不互判重复。
  //   上下文取未删注释的原文：样式可以写在 <style><!-- … --></style> 里，注释分隔符不影响其中的 CSS
  const originalTableStart = latinText.search(/<table/i);
  const originalFirstRow = originalTableStart >= 0 ? latinText.slice(originalTableStart).search(/<tr[^>]*>/i) : -1;
  const originalTableEndOffset = originalFirstRow >= 0
    ? latinText.slice(originalTableStart + originalFirstRow).search(/<\/table/i)
    : -1;
  const documentContext = originalFirstRow >= 0
    ? sha256Text(latinText.slice(0, originalTableStart + originalFirstRow)
      + (originalTableEndOffset >= 0 ? latinText.slice(originalTableStart + originalFirstRow + originalTableEndOffset) : ''))
    : sha256Text(latinText);
  const pieces = source.slice(tableStart, tableEnd).split(/(:?<tr[^>]*>)/i);
  // 每行原文含 <tr> 开始标签（行的 class / style 可以决定单元格的数字格式）与各单元格标记
  //   行所在的表格分组（<thead> / <tbody> / <tfoot> 开始标签，其 class 同样可以决定单元格的数字格式）一并计入
  const rowSources = [];
  let rowIndex = -1;
  let currentSection = '';
  const updateSection = (markup) => {
    const sectionPattern = /<(\/?)(?:thead|tbody|tfoot)\b[^>]*>/gi;
    let sectionMatch;
    while ((sectionMatch = sectionPattern.exec(markup)) !== null) {
      currentSection = sectionMatch[1] ? '' : sectionMatch[0];
    }
  };
  pieces.forEach((piece) => {
    const trimmed = piece.trim();
    const head = trimmed.slice(0, 3).toLowerCase();
    if (head === '<tr') {
      rowIndex += 1;
      rowSources[rowIndex] = { tag: trimmed, cells: '', section: currentSection };
      return;
    }
    if (rowIndex < 0 || (head !== '<td' && head !== '<th')) {
      updateSection(trimmed);
      return;
    }
    const rowEnd = trimmed.search(/<\/tr/i);
    rowSources[rowIndex].cells += rowEnd >= 0 ? trimmed.slice(0, rowEnd) : trimmed;
    if (rowEnd >= 0) updateSection(trimmed.slice(rowEnd));
  });
  // 表格各行之间有注释（含 Office 条件注释 <!--[if gte mso 9]>…<![endif]-->）时，读取库删除注释、行原文也取不到其中的内容，
  //   而 Excel 会按条件显示：无法核对，整张表不参与查重
  if (originalFirstRow >= 0
    && latinText.slice(originalTableStart + originalFirstRow, originalTableEndOffset >= 0
      ? originalTableStart + originalFirstRow + originalTableEndOffset
      : latinText.length).includes('<!--')) {
    return false;
  }
  // 引用外部样式表（<link rel="stylesheet">、@import）时，实际生效的样式不在文件里，无法核对显示格式：整张表不参与查重
  if (/<link\b[^>]*\bstylesheet\b/i.test(latinText) || /@import\b/i.test(latinText)) return false;
  // 样式表按行位置选择（:nth-child 等）设置数字格式时，相同标记的行显示可以不同：整张表不参与查重
  if (/mso-number-format/i.test(latinText) && /:(?:nth-|first-child|last-child|only-child|first-of-type|last-of-type)/i.test(latinText)) {
    return false;
  }
  const typedRows = Array.isArray(sheet) ? sheet : (Array.isArray(sheet['!data']) ? sheet['!data'] : null);
  if (!typedRows || rowSources.length <= range.e.r) return false;
  for (let r = range.s.r; r <= range.e.r; r += 1) {
    const typedRow = Array.isArray(typedRows[r]) ? typedRows[r] : [];
    const hasCell = typedRow.some((cell) => cell && cell.v !== undefined && cell.v !== null && String(cell.v) !== '');
    const rowSource = rowSources[r] || { tag: '', cells: '', section: '' };
    if (hasCell && !rowSource.cells) return false;
    specials.markRowSource(r, sha256Text(`${documentContext}\n${rowSource.section}\n${rowSource.tag}\n${rowSource.cells}`));
    // Excel 导出的 HTML 用 x:fmla 属性记公式（读取库不当作公式），显示的是计算结果：值无法证明，该行不参与查重
    if (/[\s:]fmla\s*=/i.test(rowSource.cells)) specials.markRowUnknown(r, '公式');
  }
  return true;
}

// 文本型工作簿：SheetJS 会把单元格文本推断成数值、日期、布尔值，00001 与 1、1,000 与 1000 读成同一个值。
//   按不推断类型（raw）再读一次取原文：读出的不是原样文本的单元格按原文比较；含替换字符（U+FFFD，解码有损）的单元格、
//   分隔符文本中含换行的单元格（读取库会改写引号字段内的换行）值未知，该行不参与查重。HTML 另按每行的原始标记比较（见 markHtmlRowSources）。两次读取结构不一致、或格式无法核对原文时，
//   整张表都不参与查重。普通映射仍用推断后的值。
function markTextSourceCells(filePath, sheetName, sheet, range, specials) {
  const markAllRows = (reason) => {
    for (let r = range.s.r; r <= range.e.r; r += 1) specials.markRowUnknown(r, reason);
  };
  let latinText = '';
  try {
    latinText = fs.readFileSync(filePath).toString('latin1');
  } catch (_error) {
    markAllRows('无法核对单元格原文');
    return;
  }
  const kind = classifyTextWorkbook(latinText);
  if (kind === 'unsupported') {
    markAllRows('文件格式无法核对单元格原文');
    return;
  }
  let rawSheet = null;
  try {
    const rawBook = XLSX.readFile(filePath, { cellDates: false, dense: true, raw: true });
    rawSheet = rawBook.Sheets[sheetName] || null;
  } catch (_error) {
    rawSheet = null;
  }
  if (!rawSheet || rawSheet['!ref'] !== sheet['!ref']) {
    markAllRows('无法核对单元格原文');
    return;
  }
  const rowsOf = (target) => (Array.isArray(target) ? target : (Array.isArray(target['!data']) ? target['!data'] : null));
  const typedRows = rowsOf(sheet);
  const rawRows = rowsOf(rawSheet);
  if (!typedRows || !rawRows) {
    markAllRows('无法核对单元格原文');
    return;
  }
  if (kind === 'html' && !markHtmlRowSources(latinText, sheet, range, specials)) {
    markAllRows('无法核对表格原文');
    return;
  }
  // 分隔符文本：读取库对带 UTF-8 BOM 的文件按 UTF-8 解码，否则逐字节读（latin1）：不同字节的两个文件可以读成同一文本
  //   （无 BOM 的 café 与带 BOM 的 cafÃ© 都读成 cafÃ©）。每行另附文件的解码方式，解码方式不同的文件不互判重复；
  //   逐字节读时替换字符读成 ï¿½（EF BF BD），同样按替换字符处理
  const utf8Bom = latinText.startsWith('\xEF\xBB\xBF');
  if (kind === 'delimited') {
    for (let r = range.s.r; r <= range.e.r; r += 1) specials.markRowSource(r, utf8Bom ? 'decode:utf-8-bom' : 'decode:bytes');
  }
  const isBlank = (cell) => !cell || cell.t === 'z' || cell.v === undefined || cell.v === null || String(cell.v) === '';
  const hasReplacement = (cell) => Boolean(cell) && typeof cell.v === 'string'
    && (cell.v.includes('\uFFFD') || (!utf8Bom && cell.v.includes('\u00EF\u00BF\u00BD')));
  const rowCount = Math.max(typedRows.length, rawRows.length);
  for (let r = 0; r < rowCount; r += 1) {
    const typedRow = Array.isArray(typedRows[r]) ? typedRows[r] : [];
    const rawRow = Array.isArray(rawRows[r]) ? rawRows[r] : [];
    const colCount = Math.max(typedRow.length, rawRow.length);
    for (let c = 0; c < colCount; c += 1) {
      const typed = typedRow[c];
      const raw = rawRow[c];
      if (isBlank(typed) && isBlank(raw)) continue;
      if (hasReplacement(typed) || hasReplacement(raw)) {
        specials.markCell(r, c, { unknownValue: '编码无法识别' });
        continue;
      }
      // Excel 会按公式计算的文本（如 ="TX-"&ROW()、+ROW()），读取库当作文本：值无法证明，该行不参与查重
      if (raw && typeof raw.v === 'string' && looksLikeSpreadsheetFormula(raw.v)) {
        specials.markCell(r, c, { unknownValue: '公式' });
        continue;
      }
      // 分隔符文本：读取库把引号字段内部的 CRLF 一律改成 LF（REF\r\nA 与 REF\nA 读成同一文本），含换行的单元格无法核对原文
      if (kind === 'delimited' && raw && typeof raw.v === 'string' && /[\r\n]/.test(raw.v)) {
        specials.markCell(r, c, { unknownValue: '单元格内换行无法核对' });
        continue;
      }
      if (typed && typed.t === 's' && raw && String(raw.v) === String(typed.v)) continue;
      if (isBlank(raw)) specials.markCell(r, c, { unknownValue: '单元格原文无法读取' });
      else specials.markCell(r, c, { sourceText: String(raw.v) });
    }
  }
}

// v3.2.21 B112（网银账单生成）：读取库把超出安全整数范围的整数读成数字时已丢失末几位（长卡号、流水号），
//   按文件原文取这类单元格的文本。没有这类单元格时不做任何额外读取。按文件实际内容（不看扩展名）取原文：
//   - XLSX：工作表 XML 中该单元格 <v> 的字面值；
//   - 文本 / HTML（扩展名为 .xls 等的 CSV、制表符文本、HTML 表格）：按文本重新读取同一张表的同一位置；
//   - 二进制 .xls 存的就是双精度数，没有原文。
//   只取非负整数写法、且与读到的数字是同一个双精度数的原文（负数多是发生额，改成文本会改变取发生额时的正负号处理）；
//   其余（指数写法、无法定位等）不给原文，由生成侧按 isUnverifiedLongNumber 提示无法核对原值。
//   不改工作表本身：返回 Map<相对行下标, Map<相对列下标, 原文>>（与 blankrows 读取的行、列下标一致），
//   由调用方决定用在哪些行（表头定位仍按读取库的值，与模板导入读表头一致）。
function collectLongIntegerSourceText({ filePath, workbook, sheet, sheetName, range, rowLimit }) {
  const candidates = [];
  const visit = (r, c, cell) => {
    if (r < range.s.r || r > range.e.r || c < range.s.c || c > range.e.c) return;
    if (cell && cell.t === 'n' && isUnverifiedLongNumber(cell.v) && cell.v > 0) candidates.push({ r, c, cell });
  };
  const denseRows = Array.isArray(sheet) ? sheet : (Array.isArray(sheet['!data']) ? sheet['!data'] : null);
  if (denseRows) {
    denseRows.forEach((row, r) => {
      if (Array.isArray(row)) row.forEach((cell, c) => visit(r, c, cell));
    });
  } else {
    Object.keys(sheet).forEach((address) => {
      if (address[0] === '!') return;
      const { r, c } = XLSX.utils.decode_cell(address);
      visit(r, c, sheet[address]);
    });
  }
  if (!candidates.length) return null;
  const container = detectWorkbookContainer(filePath);
  let literalOf = null;
  if (container === 'zip') literalOf = readXlsxIntegerLiterals(filePath, workbook, sheetName, candidates);
  else if (container === 'text') literalOf = readTextIntegerLiterals(filePath, sheet, sheetName, rowLimit);
  if (!literalOf) return null;
  const sourceText = new Map();
  candidates.forEach(({ r, c, cell }) => {
    const literal = literalOf(r, c);
    if (typeof literal !== 'string' || !/^\d+$/.test(literal) || Number(literal) !== cell.v) return;
    const rowIndex = r - range.s.r;
    if (!sourceText.has(rowIndex)) sourceText.set(rowIndex, new Map());
    sourceText.get(rowIndex).set(c - range.s.c, literal);
  });
  return sourceText.size ? sourceText : null;
}

// XLSX 工作表 XML 中候选单元格（按 r 属性定位，且须与所在 <row> 的行号一致）的 <v> 字面值；数值单元格的前导 0 不属于原值，去掉；
//   公式单元格的值是缓存的计算结果，不给原文。
//   读取时没有保留压缩包（未开查重）时只解开压缩包取 XML，不再解析工作表（只在有候选单元格时多读这一次；
//   不为所有读取保留压缩包，以免每个文件都多占一份 XML 内存）；按需解压，只解开用到的条目（openZipEntriesLazily），
//   压缩包结构不支持按需读取时退回整包解压。扫完整张表：同一位置出现多次（含乱序声明）、
//   类型不是数值的不给原文；有单元格没有（或无法解析）位置属性时，读取库按前一格顺推位置、可能与其他单元格重叠，
//   整张表都不给原文。容量类错误照常抛出（按文件过大处理），其余读不到时不给原文。
function readXlsxIntegerLiterals(filePath, workbook, sheetName, candidates) {
  let source = workbook;
  if (!workbook.files) {
    try {
      const buffer = fs.readFileSync(filePath);
      let files = openZipEntriesLazily(buffer);
      if (!files) {
        const container = XLSX.CFB.read(buffer, { type: 'buffer' });
        files = {};
        container.FullPaths.forEach((fullPath, index) => {
          files[String(fullPath).replace(/^Root Entry\//, '')] = container.FileIndex[index];
        });
      }
      source = { files, Directory: workbook.Directory, SheetNames: workbook.SheetNames, Workbook: workbook.Workbook };
    } catch (error) {
      if (isMemoryLimitError(error)) throw error;
      return null;
    }
  }
  const xml = findXlsxSheetXml(source, sheetName);
  if (!xml) return null;
  const wanted = new Set(candidates.map(({ r, c }) => `${r}:${c}`));
  const literals = new Map();
  const duplicated = new Set();
  // XML 注释不是内容：先去掉，避免注释里的 <c> / <v> 被当成单元格或值
  const text = stripXmlComments(xml.toString('utf8'));
  // 各 <row> 的起点与行号（没有 r 属性时按前一行顺推，与读取库相同）
  const rowStarts = [];
  const rowTagPattern = /<(?:[\w.-]+:)?row\b([^>]*?)\/?>/g;
  let rowMatch;
  while ((rowMatch = rowTagPattern.exec(text)) !== null) {
    const rowRef = readXmlAttribute(rowMatch[1], 'r');
    const previousRow = rowStarts.length ? rowStarts[rowStarts.length - 1].row : -1;
    const row = rowRef ? Number(rowRef) - 1 : previousRow + 1;
    if (!(Number.isInteger(row) && row >= 0)) return null;
    rowStarts.push({ index: rowMatch.index, row });
  }
  // 数组公式、模拟运算表等的结果区域（<f ref="…">）：只有首格带公式，区域内其他格只有缓存的 <v>，同样不是原文
  //   （release 审查）。共享公式的各格都自带 <f t="shared">，不按区域判断。区域须是单格或矩形引用（decode_range
  //   不校验写法，如 "C2:C3,B3:B8" 也能解出；列名统一大写后再解码，它把小写列名解成别的列），写法异常或显式为空时
  //   整张表不还原。单格区域就是首格本身。按区域的并集判断（区域互相重叠时不影响区域外的格）：只按候选格所在的列建索引，
  //   列内按起始行排序并记前缀最大结束行，二分查找，大账单不必把每个候选格与整表的公式区域逐一比对
  const candidateColumns = Array.from(new Set(candidates.map(({ c }) => c)));
  const formulaRowsByColumn = new Map();
  const formulaTagPattern = /<(?:[\w.-]+:)?f\b([^>]*?)\/?>/g;
  const rangePattern = /^\$?[A-Z]{1,3}\$?[1-9]\d{0,6}(?::\$?[A-Z]{1,3}\$?[1-9]\d{0,6})?$/;
  let formulaMatch;
  while ((formulaMatch = formulaTagPattern.exec(text)) !== null) {
    const formulaRef = readXmlAttribute(formulaMatch[1], 'ref');
    if (formulaRef === null || readXmlAttribute(formulaMatch[1], 't') === 'shared') continue;
    const normalizedRef = formulaRef.trim().toUpperCase();
    if (!rangePattern.test(normalizedRef)) return null;
    let range;
    try {
      range = XLSX.utils.decode_range(normalizedRef.replace(/\$/g, ''));
    } catch (_error) {
      return null;
    }
    const valid = range && [range.s.r, range.s.c, range.e.r, range.e.c].every((value) => Number.isInteger(value) && value >= 0)
      && range.e.r >= range.s.r && range.e.c >= range.s.c;
    if (!valid) return null;
    if (range.s.r === range.e.r && range.s.c === range.e.c) continue;
    for (const c of candidateColumns) {
      if (c < range.s.c || c > range.e.c) continue;
      if (!formulaRowsByColumn.has(c)) formulaRowsByColumn.set(c, []);
      formulaRowsByColumn.get(c).push([range.s.r, range.e.r]);
    }
  }
  // 各列：按起始行排序，maxEnds[i] 为前 i+1 个区域的最大结束行；某行被覆盖 ⇔ 起始行不超过它的区域中最大结束行不小于它
  const maxEndsByColumn = new Map();
  for (const [column, spans] of formulaRowsByColumn) {
    spans.sort((left, right) => left[0] - right[0]);
    const maxEnds = [];
    spans.forEach(([, end], index) => maxEnds.push(index ? Math.max(maxEnds[index - 1], end) : end));
    maxEndsByColumn.set(column, maxEnds);
  }
  const inFormulaRange = (r, c) => {
    const spans = formulaRowsByColumn.get(c);
    if (!spans) return false;
    let low = 0;
    let high = spans.length - 1;
    let last = -1;
    while (low <= high) {
      const middle = (low + high) >> 1;
      if (spans[middle][0] <= r) {
        last = middle;
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }
    return last >= 0 && maxEndsByColumn.get(c)[last] >= r;
  };
  const cellPattern = /<(?:[\w.-]+:)?c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:[\w.-]+:)?c>)/g;
  const valuePattern = /<(?:[\w.-]+:)?v\b[^>]*>([^<]*)<\/(?:[\w.-]+:)?v>/g;
  let match;
  let rowCursor = -1;
  while ((match = cellPattern.exec(text)) !== null) {
    const ref = readXmlAttribute(match[1], 'r');
    if (!ref) return null;
    let position;
    try {
      position = XLSX.utils.decode_cell(ref);
    } catch (_error) {
      return null;
    }
    if (!(position.r >= 0 && position.c >= 0)) return null;
    // 单元格引用的行须与所在 <row> 一致（release 审查）：两层坐标不同时这一格属于哪笔交易有歧义，
    //   数值相同也不能证明原文属于该行（如两个舍入为同一数值的流水号互换了引用），整张表不给原文
    while (rowCursor + 1 < rowStarts.length && rowStarts[rowCursor + 1].index < match.index) rowCursor += 1;
    if (rowCursor < 0 || rowStarts[rowCursor].row !== position.r) return null;
    const key = `${position.r}:${position.c}`;
    if (!wanted.has(key)) continue;
    if (literals.has(key) || duplicated.has(key)) {
      literals.delete(key);
      duplicated.add(key);
      continue;
    }
    const type = readXmlAttribute(match[1], 't') || 'n';
    // 公式（含共享、数组公式及其结果区域内的格）单元格的 <v> 是计算结果的缓存，不是录入的原文：不还原，按无法核对原值提示（release 审查）
    const hasFormula = /<(?:[\w.-]+:)?f\b/.test(match[2] || '') || inFormulaRange(position.r, position.c);
    // 只认唯一的 <v>：有多个（自闭合的空 <v/> 也算一个）或写法异常（如 CDATA）时不还原，按无法核对原值提示
    const valueMatches = type === 'n' && !hasFormula ? Array.from((match[2] || '').matchAll(valuePattern)) : [];
    const valueElementCount = type === 'n' ? ((match[2] || '').match(/<(?:[\w.-]+:)?v\b[^>]*>/g) || []).length : 0;
    const literal = valueMatches.length === 1 && valueElementCount === 1 ? valueMatches[0][1].trim() : '';
    literals.set(key, /^\d+$/.test(literal) ? literal.replace(/^0+(?=\d)/, '') : null);
  }
  return (r, c) => literals.get(`${r}:${c}`);
}

// v3.2.22 R19：补录余额「导入余额文件」只核对规范写法的工作表数据（<sheetData>）。读取库按正则切分行与单元格，与 Excel 的
//   XML 解析有多处不同（如 <c 后接换行时整格漏读、数值格 <v>20,50</v> 按 parseFloat 读成 20），不逐一移植，只接受能确认两者
//   一致的写法，其余返回 false（调用方按无法核对处理）：
//   - 只有标签与文本；没有注释、CDATA、处理指令；字符实体只有 XML 预定义实体与数字实体；属性值里没有 < 与 >；
//   - 标签名后紧接空格、/ 或 >（不是制表符、换行）；属性的 = 前后没有空白（读取库只跳过 = 后的空格，换行时属性被漏读）；结束标签只有 </名称>；元素正确嵌套：<row> 只含 <c>，<c> 只含 <f>、<v>、<is>
//     （各至多一个），<v> 只含文本、开始标签除 xml:space="preserve" 外没有属性；文本只出现在 <f>、<v>、<t> 中（其余位置只有空白）；
//   - <row>、<c> 都带 r 属性：行号递增，单元格引用的行与所在行一致、列递增；<c> 只有 r、s、t、cm、vm、ph 属性，
//     <row> 的属性名不带下划线、带前缀的属性不与行属性重名（读取库去掉前缀、截掉下划线后取属性）；
//   - <v> 的内容按单元格类型是完整的字面值：数值（t 缺省或为 n）为完整的十进制数字（可带正负号），共享字符串（s）为非负整数，
//     布尔（b）为不带空白的 0 / 1 / true / false（读取库不去空白，带空白的真值读成 FALSE），
//     错误（e）以 # 开头；日期格（t="d"）不接受（读取库按 1900 日期系统换成序列号，与工作簿的 1904 日期系统不一致）；
//     内联文本（inlineStr）不带 <v>；文本（str）与公式以外的格 <v> 不为空，公式格的空缓存可写作 <v/> 或 <v></v>
const SHEET_DATA_TOKEN_PATTERN = /<(?:[^'"<>]|"[^"<>]*"|'[^'<>]*')*>|[^<]+|</g;
const SHEET_DATA_CHILDREN = Object.freeze({
  '': ['row'], row: ['c'], c: ['f', 'v', 'is'], f: [], v: [], is: ['t', 'r', 'rPh', 'phoneticPr'], r: ['rPr', 't'], rPh: ['t'], t: [],
  phoneticPr: []
});
const SHEET_DATA_TEXT_ELEMENTS = new Set(['f', 'v', 't']);
const CELL_ATTRIBUTE_PATTERNS = Object.freeze({
  r: /^[A-Z]{1,3}[1-9]\d{0,6}$/, s: /^\d+$/, t: /^(?:n|s|str|inlineStr|b|e)$/, cm: /^\d+$/, vm: /^\d+$/, ph: /^(?:0|1|true|false)$/
});
const ROW_ATTRIBUTES = new Set(['r', 'spans', 's', 'customFormat', 'ht', 'hidden', 'customHeight', 'outlineLevel', 'collapsed',
  'thickTop', 'thickBot', 'ph']);
const CELL_VALUE_PATTERNS = Object.freeze({
  n: /^\s*[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?\s*$/,
  s: /^\s*\d+\s*$/,
  b: /^(?:[01]|true|false)$/,
  e: /^\s*#\S+\s*$/,
  str: /^[\s\S]*$/
});
const XML_INVALID_ENTITY_PATTERN = /&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/;
// 规范写法的属性（名称不重复，值用引号、没有非法实体）；标签名后的第一个分隔符须是空格。不是规范写法时返回 null
function canonicalAttributes(attributeText) {
  const attributes = {};
  if (!attributeText) return attributes;
  if (attributeText[0] !== ' ') return null;
  const pattern = /\s+([A-Za-z][\w.:-]*)=(?:"([^"]*)"|'([^']*)')/y;
  let offset = 0;
  while (offset < attributeText.length) {
    pattern.lastIndex = offset;
    const match = pattern.exec(attributeText);
    if (!match) return /^\s*$/.test(attributeText.slice(offset)) ? attributes : null;
    const value = match[2] !== undefined ? match[2] : match[3];
    if (Object.hasOwn(attributes, match[1]) || XML_INVALID_ENTITY_PATTERN.test(value)) return null;
    attributes[match[1]] = value;
    offset = pattern.lastIndex;
  }
  return attributes;
}

// v3.2.22 R21：按 Excel 的口径解码 OOXML 文本（ST_Xstring）：XML 预定义实体与数字字符引用，再解开 _xHHHH_ 转义。大写 _XHHHH_
//   （读取库不区分大小写解开、Excel 的口径不明确）或字符引用超出 Unicode 范围时返回 null。text 为已按 UTF-8 解码的文本
const XML_PREDEFINED_ENTITIES = Object.freeze({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" });
function decodeOoxmlText(text) {
  if (/_X[\da-fA-F]{4}_/.test(text)) return null;
  try {
    return String(text)
      .replace(/&(?:(amp|lt|gt|quot|apos)|#(\d+)|#x([\da-fA-F]+));/g, (_match, named, decimal, hex) => (named
        ? XML_PREDEFINED_ENTITIES[named]
        : String.fromCodePoint(decimal !== undefined ? Number(decimal) : parseInt(hex, 16))))
      .replace(/_x([\da-fA-F]{4})_/g, (_match, hex) => String.fromCharCode(parseInt(hex, 16)));
  } catch (_error) {
    return null;
  }
}

// v3.2.22 R25：SpreadsheetML 主命名空间（过渡与严格两种写法）。工作表、共享字符串里的元素只按局部名称比较时，绑定到别的命名空间的
//   同名元素（如声明为 mc:Ignorable 的 <aux:v>）会被当作单元格的值（Excel 忽略它，读取库照读）
const SPREADSHEET_MAIN_NAMESPACES = new Set([
  'http://schemas.openxmlformats.org/spreadsheetml/2006/main',
  'http://purl.oclc.org/ooxml/spreadsheetml/main'
]);
// 按元素上的命名空间声明更新绑定到主命名空间的前缀集合（'' 为默认命名空间）；返回新集合
function mainNamespacePrefixesOf(attributes, inherited = new Set()) {
  const prefixes = new Set(inherited);
  Object.entries(attributes).forEach(([key, value]) => {
    const declaration = /^xmlns(?::([\w.-]+))?$/.exec(key);
    if (!declaration) return;
    if (SPREADSHEET_MAIN_NAMESPACES.has(value)) prefixes.add(declaration[1] || '');
    else prefixes.delete(declaration[1] || '');
  });
  return prefixes;
}
// 标签的前缀（没有前缀为 ''）
function xmlTagPrefix(token) {
  const match = /^<\/?(?:([\w.-]+):)?[A-Za-z]/.exec(token);
  return match ? (match[1] || '') : null;
}
// 属性中有命名空间声明、或值里有字符引用 / 实体（R25：customFormat="&#49;" 与 "1" 相同，按原文比较会认错）
function hasNamespaceOrReferenceAttribute(attributes) {
  return Object.entries(attributes).some(([key, value]) => /^xmlns(?::|$)/.test(key) || value.includes('&'));
}
// 标签原文中有命名空间声明
function hasXmlnsDeclaration(tag) {
  return /\sxmlns(?::[\w.-]+)?\s*=/.test(tag);
}

// v3.2.22 R26：逐个走 XML 片段中的标签（属性值里可以有未转义的 >，按引号边界匹配）。onTag 收到
//   { closing, selfClosing, depth（元素所在层级，片段顶层为 0）, prefix, name（局部名）, tag（标签原文）, index, end（标签在片段中的起止）,
//   inExtension（在主命名空间的 <extLst> 内：扩展内容 Excel 按扩展的命名空间处理） }；返回 false 时停止。片段中有注释、CDATA、
//   处理指令等（标签按文本处理，与 Excel 不同），或开始与结束标签不成对时返回 false
function walkXmlTags(fragment, mainPrefixes, onTag) {
  if (/<[!?]/.test(fragment)) return false;
  const pattern = /<(\/?)(?:([\w.-]+):)?([A-Za-z_][\w.-]*)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>/g;
  const stack = [];
  let match;
  while ((match = pattern.exec(fragment)) !== null) {
    const [tag, closing, prefix = '', name, , selfClosing] = match;
    const inExtension = stack.some((item) => item.name === 'extLst' && mainPrefixes.has(item.prefix));
    if (closing) {
      const top = stack.pop();
      if (!top || top.name !== name || top.prefix !== prefix) return false;
      if (onTag({ closing: true, selfClosing: false, depth: stack.length, prefix, name, tag, index: match.index, end: pattern.lastIndex,
        inExtension: stack.some((item) => item.name === 'extLst' && mainPrefixes.has(item.prefix)) }) === false) return false;
      continue;
    }
    if (onTag({ closing: false, selfClosing: Boolean(selfClosing), depth: stack.length, prefix, name, tag, index: match.index,
      end: pattern.lastIndex, inExtension }) === false) return false;
    if (!selfClosing) stack.push({ prefix, name });
  }
  return stack.length === 0;
}

// v3.2.22 R26：样式表根元素 <styleSheet> 上绑定到主命名空间的前缀；根元素不在主命名空间或属性无法解析时返回 null
function xlsxStylesMainPrefixes(text) {
  const root = /^\uFEFF?\s*(?:<\?xml\b(?:[^?]|\?(?!>))*\?>)?\s*(<(?:[\w.-]+:)?styleSheet((?:[^>"']|"[^"]*"|'[^']*')*?)\s*\/?>)/.exec(text);
  const attributes = root ? canonicalAttributes(root[2].replace(/^\s+/, ' ')) : null;
  if (!attributes) return null;
  const prefixes = mainNamespacePrefixesOf(attributes);
  return prefixes.has(xmlTagPrefix(root[1])) ? prefixes : null;
}

// v3.2.22 R26：样式表中一张表（numFmts / cellXfs / cellStyleXfs / dxfs）的直接子元素 [{ tag, inner }]，按出现顺序（即序号）。
//   读取库与原先的正则按局部名称取同名元素，绑定到别的命名空间的扩展元素（如 mc:Ignorable 的 <extra:dxf/>，Excel 忽略）、
//   嵌套的同名元素会让序号错位。表与子元素须在主命名空间且只含 childName 子元素，表内（扩展列表 <extLst> 以外）不声明命名空间、
//   不嵌套同名元素；不符合、表出现多次（含别的命名空间的同名表）或结构无法解析时返回 null；没有这张表时返回空数组
function xlsxStyleTableChildren(text, mainPrefixes, tableName, childName) {
  const openings = Array.from(text.matchAll(new RegExp(`<(?:[\\w.-]+:)?${tableName}\\b(?:[^>"']|"[^"]*"|'[^']*')*>`, 'g')));
  if (!openings.length) return [];
  if (openings.length > 1) return null;
  const opening = openings[0];
  if (!mainPrefixes.has(xmlTagPrefix(opening[0])) || hasXmlnsDeclaration(opening[0])) return null;
  if (/\/>$/.test(opening[0])) return [];
  const start = opening.index + opening[0].length;
  const closingPattern = new RegExp(`</(?:[\\w.-]+:)?${tableName}\\s*>`, 'g');
  closingPattern.lastIndex = start;
  const closing = closingPattern.exec(text);
  if (!closing || xmlTagPrefix(closing[0]) !== xmlTagPrefix(opening[0])) return null;
  const inner = text.slice(start, closing.index);
  const children = [];
  let current = null;
  let outside = '';
  let last = 0;
  const walked = walkXmlTags(inner, mainPrefixes, (item) => {
    if (item.inExtension) return true;
    if (!mainPrefixes.has(item.prefix) || (!item.closing && hasXmlnsDeclaration(item.tag))) return false;
    if (item.depth === 0) {
      if (item.name !== childName) return false;
      if (!item.closing) {
        outside += inner.slice(last, item.index);
        if (item.selfClosing) {
          children.push({ tag: item.tag, inner: '' });
          last = item.end;
        } else {
          current = { tag: item.tag, contentStart: item.end };
        }
      } else {
        children.push({ tag: current.tag, inner: inner.slice(current.contentStart, item.index) });
        current = null;
        last = item.end;
      }
      return true;
    }
    return item.name !== childName;
  });
  outside += inner.slice(last);
  return walked && outside.trim() === '' ? children : null;
}

// v3.2.22 R27：按 [[表名, 子元素名]] 取样式表中各张表的直接子元素（见 xlsxStyleTableChildren）。工作簿没有样式表部件（text 为 ''，
//   样式表是可选部件）时各表都为空：只有样式 0（常规格式）可用，单元格引用的其他样式不存在，由调用方按无法核对处理；
//   样式表根元素无法确认、任一张表无法核对时返回 null
function xlsxStyleTables(text, specs) {
  if (text === '') return specs.map(() => []);
  const mainPrefixes = xlsxStylesMainPrefixes(text);
  if (!mainPrefixes) return null;
  const tables = specs.map(([tableName, childName]) => xlsxStyleTableChildren(text, mainPrefixes, tableName, childName));
  return tables.some((table) => !table) ? null : tables;
}

// v3.2.22 R21：按 Excel 的口径解析共享字符串表（xl/sharedStrings.xml 等），返回各项的文本；不是规范写法时返回 null。
//   读取库按正则切分 <si>（自闭合的 <si/> 不切分，后面各项的下标整体错位，实测把账号 A 的格读成账号 B），不逐一移植，
//   由调用方逐格比对读取库读出的值：<sst> 只含 <si> 与 <extLst>；<si> 不带属性，只含 <t>、<r>、<rPh>、<phoneticPr>，直接的 <t>
//   至多一个、不与 <r> 并存；<r> 只含 <rPr> 与 <t>；文本只在 <t> 中（注音 <rPh> 里的不算）；没有注释、CDATA、处理指令（开头的
//   XML 声明除外）、非预定义实体；条目带 UTF-16 BOM 时不核对
const SHARED_STRING_CHILDREN = Object.freeze({
  '': ['sst'], sst: ['si', 'extLst'], si: ['t', 'r', 'rPh', 'phoneticPr'], r: ['rPr', 't'], rPh: ['t'], t: [], phoneticPr: []
});
function parseSharedStringsStrict(buffer) {
  const latin1 = readerXmlText(buffer);
  if (latin1 === null) return null;
  const text = Buffer.from(latin1, 'latin1').toString('utf8').replace(/^\uFEFF/, '').replace(/^<\?xml\b(?:[^?]|\?(?!>))*\?>/, '');
  const strings = [];
  const stack = [];
  let item = null;
  let rawText = null;
  let rootSeen = false;
  let mainPrefixes = new Set();
  SHEET_DATA_TOKEN_PATTERN.lastIndex = 0;
  let match;
  while ((match = SHEET_DATA_TOKEN_PATTERN.exec(text)) !== null) {
    const token = match[0];
    const parent = stack.length ? stack[stack.length - 1] : '';
    const opaque = stack.includes('extLst') || stack.includes('rPr');
    if (token[0] !== '<') {
      if (XML_INVALID_ENTITY_PATTERN.test(token)) return null;
      if (parent === 't' && rawText !== null) rawText += token;
      else if (!opaque && parent !== 't' && token.trim() !== '') return null;
      continue;
    }
    if (/^<[!?]/.test(token)) return null;
    const closing = /^<\/(?:\w+:)?([A-Za-z]\w*)>$/.exec(token);
    if (closing) {
      if (!opaque && !mainPrefixes.has(xmlTagPrefix(token))) return null;
      if (stack.pop() !== closing[1]) return null;
      if (closing[1] === 't' && rawText !== null) {
        const decoded = decodeOoxmlText(rawText);
        if (decoded === null) return null;
        item.text += decoded;
        rawText = null;
      } else if (closing[1] === 'si' && !opaque) {
        strings.push(item.text);
        item = null;
      }
      continue;
    }
    const opening = /^<(?:\w+:)?([A-Za-z]\w*)((?: [\s\S]*?)?)\s*(\/?)>$/.exec(token);
    if (!opening) return null;
    const [, name, attributeText, selfClosing] = opening;
    const attributes = canonicalAttributes(attributeText);
    if (!attributes) return null;
    if (!opaque) {
      if (!SHARED_STRING_CHILDREN[parent].includes(name) && !(name === 'rPr' && parent === 'r')) return null;
      // 元素须在主命名空间（R25）：命名空间只在根元素 <sst> 上声明，其余元素的属性不带声明与字符引用
      if (name === 'sst') mainPrefixes = mainNamespacePrefixesOf(attributes);
      else if (hasNamespaceOrReferenceAttribute(attributes)) return null;
      if (!mainPrefixes.has(xmlTagPrefix(token))) return null;
      if (name === 'sst') {
        if (rootSeen) return null;
        rootSeen = true;
      } else if (name === 'si') {
        if (attributeText) return null;
        item = { text: '', directTexts: 0, runs: 0 };
        if (selfClosing) {
          strings.push('');
          item = null;
        }
      } else if (name === 't' || name === 'r') {
        if (name === 't' && Object.keys(canonicalAttributes(attributeText)).some((key) => key !== 'xml:space')) return null;
        if (name === 'r' && attributeText) return null;
        if (name === 't' && parent === 'si') item.directTexts += 1;
        if (name === 'r') item.runs += 1;
        if (item.directTexts > 1 || (item.directTexts && item.runs)) return null;
        if (name === 't' && !selfClosing && !stack.includes('rPh')) rawText = '';
      }
    }
    if (!selfClosing) stack.push(name);
  }
  return rootSeen && stack.length === 0 ? strings : null;
}

// v3.2.22 R21：Excel 读取的共享字符串表条目：工作簿关系文件中类型为 sharedStrings 的关系（恰好一条；没有时返回空 Buffer，
//   表示没有共享字符串表）。关系不唯一、Target 含字符引用或条目不存在时无法确认，返回 null
const SHARED_STRINGS_RELATIONSHIP_TYPES = new Set([
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings',
  'http://purl.oclc.org/ooxml/officeDocument/relationships/sharedStrings'
]);
function findXlsxSharedStringsXml(workbook) {
  const files = workbook && workbook.files;
  const directory = workbook && workbook.Directory;
  const workbookPath = directory && Array.isArray(directory.workbooks) && directory.workbooks[0];
  if (!files || typeof workbookPath !== 'string') return null;
  const workbookDir = workbookPath.replace(/^\/+/, '').split('/').slice(0, -1).join('/');
  const relsXml = getZipEntryBuffer(files, `${workbookDir ? `${workbookDir}/` : ''}_rels/${workbookPath.split('/').pop()}.rels`);
  if (!relsXml) return null;
  const relations = (stripXmlComments(relsXml.toString('utf8')).match(/<(?:[\w.-]+:)?Relationship\b[^>]*>/g) || [])
    .filter((tag) => SHARED_STRINGS_RELATIONSHIP_TYPES.has(readXmlAttribute(tag, 'Type')));
  if (!relations.length) return Buffer.alloc(0);
  if (relations.length !== 1 || attributeHasReference(relations[0], 'Target')) return null;
  const target = readXmlAttribute(relations[0], 'Target');
  return target ? getZipEntryBuffer(files, normalizeZipPath(workbookDir, target)) : null;
}

// v3.2.22 R21：逐格比对读取库读出的文本格与按 Excel 口径解码的文本（textCells 来自 isCanonicalSheetData），全部一致时返回
//   核对过的文本 Map<"行下标:列下标", 文本>（R23：判断公式缓存是否为空白时用），有不一致时返回 null。
//   读取库读文本（str）格时先解开字符引用再按 UTF-8 解码（实测 &#39321;&#28207;「香港」读成乱码，最新一行因银行名对不上被排除，
//   较早的余额被当作最近一天的）；共享字符串表的下标可能错位（见 parseSharedStringsStrict）
function verifyReaderTextCells(workbook, sheet, textCells) {
  const verified = new Map();
  if (!textCells.length) return verified;
  let sharedStrings = null;
  if (textCells.some(([, , expected]) => expected.sharedStringIndex !== undefined)) {
    const sharedStringsXml = findXlsxSharedStringsXml(workbook);
    sharedStrings = sharedStringsXml === null ? null : (sharedStringsXml.length ? parseSharedStringsStrict(sharedStringsXml) : []);
    if (!sharedStrings) return null;
  }
  const denseRows = Array.isArray(sheet) ? sheet : (Array.isArray(sheet && sheet['!data']) ? sheet['!data'] : null);
  const matched = textCells.every(([r, c, expected]) => {
    const cell = denseRows ? (Array.isArray(denseRows[r]) ? denseRows[r][c] : undefined) : sheet[XLSX.utils.encode_cell({ r, c })];
    const text = expected.sharedStringIndex !== undefined ? sharedStrings[expected.sharedStringIndex] : expected.text;
    if (typeof text !== 'string' || !cell || cell.t !== 's' || cell.v !== text) return false;
    verified.set(`${r}:${c}`, text);
    return true;
  });
  return matched ? verified : null;
}

function isCanonicalSheetData(text, onTextCell = null, onCellStyle = null) {
  const sheetData = text.match(READER_SHEET_DATA_PATTERN);
  if (!sheetData) return !/<(?:\w+:)?(?:row|c)[\s/>]/.test(text);
  if (/<\/?(?:\w+:)?sheetData[\s/>]/.test(sheetData[1])) return false;
  // 命名空间（R25）：根元素 <worksheet> 与 <sheetData> 须在主命名空间，sheetData 内的元素只用绑定到主命名空间的前缀，
  //   且不再声明命名空间（声明只认根元素与 sheetData 上的）
  const root = /^(?:\xEF\xBB\xBF)?\s*(?:<\?xml\b(?:[^?]|\?(?!>))*\?>)?\s*(<(?:[\w.-]+:)?worksheet((?:[^>"']|"[^"]*"|'[^']*')*?)\s*>)/.exec(text);
  const sheetDataOpening = /^<(?:[\w.-]+:)?sheetData((?:[^>"']|"[^"]*"|'[^']*')*?)\s*>/.exec(sheetData[0]);
  // 根元素的属性之间可以换行（标签名后的第一个分隔符按空格处理）
  const rootAttributes = root ? canonicalAttributes(root[2].replace(/^\s+/, ' ')) : null;
  const sheetDataAttributes = sheetDataOpening ? canonicalAttributes(sheetDataOpening[1].replace(/^\s+/, ' ')) : null;
  if (!rootAttributes || !sheetDataAttributes) return false;
  const rootPrefixes = mainNamespacePrefixesOf(rootAttributes);
  if (!rootPrefixes.has(xmlTagPrefix(root[1]))) return false;
  const mainPrefixes = mainNamespacePrefixesOf(sheetDataAttributes, rootPrefixes);
  if (!mainPrefixes.has(xmlTagPrefix(sheetDataOpening[0]))) return false;
  const stack = [];
  let rowNumber = 0;
  let rowStyle = null;
  let column = -1;
  let cell = null;
  const checkCellValue = () => {
    const pattern = CELL_VALUE_PATTERNS[cell.t];
    if (cell.v === null) return cell.t !== 'inlineStr' || cell.is <= 1;
    if (cell.t === 'inlineStr' || !pattern) return false;
    // 空的 <v>：文本（str，读取库与 Excel 都是空文本）与公式（没有缓存值，另行标记）以外不核对
    if (cell.v.trim() === '') return cell.t === 'str' || cell.f > 0;
    return pattern.test(cell.v);
  };
  // 文本格交给 onTextCell 核对（R21）：共享字符串（s）给出下标，文本（str）与内联文本（inlineStr）给出按 Excel 口径解码的文本
  const finishCell = () => {
    if (!checkCellValue()) return false;
    if (!onTextCell || !['s', 'str', 'inlineStr'].includes(cell.t)) return true;
    // 共享字符串类型公式的空缓存（<v/>）没有下标，按没有缓存值的公式另行标记，不比对
    if (cell.t === 's') return cell.v === null || cell.v.trim() === '' || onTextCell(cell.r, cell.c, { sharedStringIndex: Number(cell.v.trim()) }) !== false;
    const expected = cell.t === 'str' ? (cell.v === null ? '' : decodeOoxmlText(Buffer.from(cell.v, 'latin1').toString('utf8'))) : cell.inline;
    return expected !== null && onTextCell(cell.r, cell.c, { text: expected }) !== false;
  };
  SHEET_DATA_TOKEN_PATTERN.lastIndex = 0;
  let match;
  while ((match = SHEET_DATA_TOKEN_PATTERN.exec(sheetData[1])) !== null) {
    const token = match[0];
    const parent = stack.length ? stack[stack.length - 1] : '';
    if (token[0] !== '<') {
      if (XML_INVALID_ENTITY_PATTERN.test(token)) return false;
      if (!SHEET_DATA_TEXT_ELEMENTS.has(parent) && token.trim() !== '') return false;
      if (parent === 'v') cell.v += token;
      if (parent === 't' && cell.tRaw !== null) cell.tRaw += token;
      continue;
    }
    const closing = /^<\/(?:\w+:)?([A-Za-z]\w*)>$/.exec(token);
    if (closing) {
      if (!stack.includes('rPr') && !mainPrefixes.has(xmlTagPrefix(token))) return false;
      if (stack.pop() !== closing[1]) return false;
      if (closing[1] === 't' && cell.tRaw !== null) {
        // 内联文本按 <t> 逐个解码后拼接（_xHHHH_ 转义不跨 <t>）
        const decoded = decodeOoxmlText(Buffer.from(cell.tRaw, 'latin1').toString('utf8'));
        if (decoded === null) return false;
        cell.inline += decoded;
        cell.tRaw = null;
      }
      if (closing[1] === 'c') {
        if (!finishCell()) return false;
        cell = null;
      }
      continue;
    }
    const opening = /^<(?:\w+:)?([A-Za-z]\w*)((?: [\s\S]*?)?)\s*(\/?)>$/.exec(token);
    if (!opening) return false;
    const [, name, attributeText, selfClosing] = opening;
    const inRichTextProperties = stack.includes('rPr');
    if (!inRichTextProperties && !(SHEET_DATA_CHILDREN[parent] || []).includes(name)) return false;
    if (name === 'rPr' && !(SHEET_DATA_CHILDREN[parent] || []).includes(name)) return false;
    const attributes = canonicalAttributes(attributeText);
    if (!attributes) return false;
    if (!inRichTextProperties && (!mainPrefixes.has(xmlTagPrefix(token)) || hasNamespaceOrReferenceAttribute(attributes))) return false;
    if (name === 'row') {
      const names = Object.keys(attributes);
      if (names.some((key) => key.includes('_') || (key.includes(':') ? ROW_ATTRIBUTES.has(key.slice(key.indexOf(':') + 1)) : !ROW_ATTRIBUTES.has(key)))) return false;
      if (!/^[1-9]\d{0,6}$/.test(attributes.r || '') || Number(attributes.r) <= rowNumber) return false;
      rowNumber = Number(attributes.r);
      column = -1;
      // 行样式只在 customFormat 时对该行的单元格生效（R24：交给 onCellStyle 一并核对）
      rowStyle = /^(?:1|true)$/i.test(attributes.customFormat || '') && attributes.s !== undefined ? attributes.s : null;
    } else if (name === 'c') {
      if (Object.entries(attributes).some(([key, value]) => !CELL_ATTRIBUTE_PATTERNS[key] || !CELL_ATTRIBUTE_PATTERNS[key].test(value))) return false;
      if (!attributes.r) return false;
      const position = XLSX.utils.decode_cell(attributes.r);
      if (position.r !== rowNumber - 1 || position.c <= column) return false;
      column = position.c;
      if (onCellStyle) onCellStyle(position.r, position.c, attributes.s === undefined ? null : attributes.s, rowStyle);
      cell = { t: attributes.t || 'n', v: null, f: 0, is: 0, r: position.r, c: position.c, inline: '', tRaw: null, directTexts: 0, runs: 0 };
    } else if (name === 'v') {
      // 只允许 xml:space="preserve"（首尾有空白的文本，读取库与 Excel 都按原样取）
      const preserveOnly = Object.keys(attributes).length === 1 && attributes['xml:space'] === 'preserve';
      if ((attributeText && !preserveOnly) || cell.v !== null || (selfClosing && !cell.f)) return false;
      cell.v = '';
    } else if (name === 'f') {
      cell.f += 1;
      if (cell.f > 1) return false;
    } else if (name === 'is') {
      if (attributeText || cell.t !== 'inlineStr') return false;
      cell.is += 1;
      if (cell.is > 1) return false;
    } else if (!inRichTextProperties && (name === 't' || name === 'r') && !stack.includes('rPh')) {
      // 内联文本：<t> 只带 xml:space，<r> 不带属性；直接的 <t> 至多一个、不与 <r> 并存（Excel 的取值不明确）。注音（rPh）不算
      if (name === 't' && Object.keys(attributes).some((key) => key !== 'xml:space')) return false;
      if (name === 'r' && attributeText) return false;
      if (name === 't' && parent === 'is') cell.directTexts += 1;
      if (name === 'r') cell.runs += 1;
      if (cell.directTexts > 1 || (cell.directTexts && cell.runs)) return false;
      if (name === 't' && !selfClosing) cell.tRaw = '';
    }
    if (selfClosing) {
      if (name === 'c') {
        if (!finishCell()) return false;
        cell = null;
      }
      continue;
    }
    stack.push(name);
  }
  return stack.length === 0;
}

// v3.2.22 R27：工作表 XML 中 sheetData 之前（head：列样式等）与之后、根元素 <worksheet> 结束之前（tail：合并范围、条件格式等）
//   的原文，以及根元素上绑定到主命名空间的前缀。根元素或 sheetData 的边界无法确认时返回 null。text 可以是按 latin1 或 UTF-8 解码的原文
function xlsxSheetParts(text) {
  const root = /^(?:\xEF\xBB\xBF|\uFEFF)?\s*(?:<\?xml\b(?:[^?]|\?(?!>))*\?>)?\s*(<(?:[\w.-]+:)?worksheet((?:[^>"']|"[^"]*"|'[^']*')*?)\s*>)/.exec(text);
  const rootAttributes = root ? canonicalAttributes(root[2].replace(/^\s+/, ' ')) : null;
  if (!rootAttributes) return null;
  const mainPrefixes = mainNamespacePrefixesOf(rootAttributes);
  const sheetDataEnd = /<(?:[\w.-]+:)?sheetData\b(?:[^>"']|"[^"]*"|'[^']*')*?\/>|<\/(?:[\w.-]+:)?sheetData\s*>/.exec(text);
  const rootClosing = /<\/(?:[\w.-]+:)?worksheet\s*>\s*$/.exec(text);
  const sheetDataStart = /<(?:[\w.-]+:)?sheetData\b/.exec(text);
  if (!sheetDataEnd || !rootClosing || !sheetDataStart || rootClosing.index < sheetDataEnd.index || sheetDataStart.index < root[0].length) return null;
  return {
    head: text.slice(root[0].length, sheetDataStart.index),
    tail: text.slice(sheetDataEnd.index + sheetDataEnd[0].length, rootClosing.index),
    mainPrefixes
  };
}

// v3.2.22 R27：工作表的列样式 [{ min, max, style }]：只取根元素直属 <cols> 下的 <col>（主命名空间、不声明命名空间，在 sheetData 之前）。
//   按正则配对时结束标签带空白（</cols >）会漏读整段列样式；结构无法解析、主命名空间的 col / cols 出现在别的位置时返回 null
function xlsxSheetColumnStyles(text) {
  const parts = xlsxSheetParts(text);
  if (!parts) return null;
  const columnStyles = [];
  let inCols = false;
  const walked = walkXmlTags(parts.head, parts.mainPrefixes, (item) => {
    if (item.inExtension || !parts.mainPrefixes.has(item.prefix)) return true;
    if (item.name !== 'cols' && item.name !== 'col') return true;
    if (item.closing) {
      if (item.name === 'cols') inCols = false;
      return true;
    }
    if (hasXmlnsDeclaration(item.tag)) return false;
    if (item.name === 'cols') {
      if (item.depth !== 0) return false;
      inCols = !item.selfClosing;
      return true;
    }
    if (!inCols || item.depth !== 1) return false;
    const style = readXmlAttribute(item.tag, 'style');
    if (style !== null) columnStyles.push({ min: Number(readXmlAttribute(item.tag, 'min')), max: Number(readXmlAttribute(item.tag, 'max')), style });
    return true;
  });
  return walked ? columnStyles : null;
}

// v3.2.22 R26：工作表实际生效的合并范围（规范化的 A1:B2 写法）：只取根元素 <worksheet> 的直接子元素 <mergeCells> 下的
//   <mergeCell>（都在主命名空间、不声明命名空间）。扩展列表 <extLst> 里、别的命名空间的同名元素 Excel 不当作合并范围，不取；
//   主命名空间的 mergeCell / mergeCells 出现在别的位置（如 mc:AlternateContent 内、R27 起含父元素不是 <mergeCells> 的，如声明为
//   mc:Ignorable 的扩展元素内：Excel 忽略，读取库照读）、引用写法异常、sheetData 之后的结构无法解析时返回 null
function xlsxSheetMergeRanges(text, rangePattern) {
  const sheetTail = xlsxSheetParts(text);
  if (!sheetTail) return null;
  const { tail, mainPrefixes } = sheetTail;
  const ranges = [];
  let inMergeCells = false;
  const walked = walkXmlTags(tail, mainPrefixes, (item) => {
    if (item.inExtension || !mainPrefixes.has(item.prefix)) return true;
    if (item.name !== 'mergeCells' && item.name !== 'mergeCell') return true;
    if (item.closing) {
      if (item.name === 'mergeCells') inMergeCells = false;
      return true;
    }
    if (hasXmlnsDeclaration(item.tag)) return false;
    if (item.name === 'mergeCells') {
      if (item.depth !== 0) return false;
      inMergeCells = !item.selfClosing;
      return true;
    }
    // 父元素须为工作表直属的 <mergeCells>（R27）
    if (!inMergeCells || item.depth !== 1) return false;
    const ref = String(readXmlAttribute(item.tag, 'ref') || '').trim().toUpperCase().replace(/\$/g, '');
    if (!rangePattern.test(ref)) return false;
    const area = XLSX.utils.decode_range(ref);
    if (!(area.e.r >= area.s.r && area.e.c >= area.s.c)) return false;
    ranges.push(XLSX.utils.encode_range(area));
    return true;
  });
  return walked ? ranges : null;
}

// ---- v3.2.22 W2：补录余额「导入余额文件」的结构白名单 ----
// 读取库与 Excel 解析 XLSX 的口径有多处不同（读取库按局部名称取元素、不认命名空间，注释、字符引用、扩展元素等写法的处理也不同），
//   逐个找差异再补救的做法不收敛。导入前先按原始字节核对读取用到的部件（根关系、工作簿与其关系、第一张工作表、共享字符串、样式表），
//   只接受两边读法一定相同的规范结构，其余一律不导入（提示在 Excel 中另存为 xlsx）。核对项：
//   - UTF-8 编码、XML 1.0 字符；除开头的 XML 声明外没有 <? 与 <!（处理指令、注释、CDATA、DTD）；标签内只用空格与换行分隔；
//   - 命名空间只在根元素、主命名空间 <extLst> 下的 <ext> 子树与 mc:AlternateContent 子树中声明，用到的前缀都已声明；
//   - 实体只用五个预定义实体；字符引用（&#…;）只出现在 <t>、<v>、<f> 的文本中，属性里一律不允许；
//   - 读取用到的元素（WHITELIST_PART_RULES 的 parents，按局部名称认，不论前缀）：在 <ext> 外须在主命名空间、父元素为规定的
//     主命名空间元素，不在 mc:AlternateContent 内，个数符合 counts；在 <ext> 内只允许条件格式、差异格式等扩展会用到的几种
//     （WHITELIST_EXT_NAMES，由各自的核对按保守口径处理）；
//   - 这些元素的属性：读取库按局部名称取值，未带前缀的名称在第一个下划线处截断、另存一份小写名称，后出现的覆盖先出现的；
//     本模块按原名取值。为两边取到同一个值：名称只含字母数字（关系部件只认 Id、Type、Target、TargetMode，其他部件首字母小写），
//     小写后不重复；带前缀的只认 Excel 会写的几种（WHITELIST_PREFIXED_ATTRIBUTES）；序号、开关、单元格引用类属性为规范写法
//     （WHITELIST_ATTRIBUTE_VALUES，不带首尾空白、不带前缀），值里没有 >（数字格式的格式代码除外）。
const MARKUP_COMPATIBILITY_NAMESPACE = 'http://schemas.openxmlformats.org/markup-compatibility/2006';
const XML_NAMESPACE = 'http://www.w3.org/XML/1998/namespace';
const PACKAGE_RELATIONSHIP_NAMESPACES = new Set(['http://schemas.openxmlformats.org/package/2006/relationships']);
const WHITELIST_QNAME = '[A-Za-z_][\\w.-]*(?::[A-Za-z_][\\w.-]*)?';
const WHITELIST_TOKEN_SOURCE = `<(${WHITELIST_QNAME})((?:[ \\r\\n]+${WHITELIST_QNAME}[ \\r\\n]*=[ \\r\\n]*(?:"[^"<]*"|'[^'<]*'))*)[ \\r\\n]*(/?)>`
  + `|</(${WHITELIST_QNAME})[ \\r\\n]*>|[^<]+`;
const WHITELIST_ATTRIBUTE_PATTERN = new RegExp(`[ \\r\\n]+(${WHITELIST_QNAME})[ \\r\\n]*=[ \\r\\n]*(?:"([^"<]*)"|'([^'<]*)')`, 'g');
const WHITELIST_CELL_REF = '[A-Z]{1,3}[1-9]\\d{0,6}';
const WHITELIST_CELL_RANGE = `${WHITELIST_CELL_REF}(?::${WHITELIST_CELL_REF})?`;
const WHITELIST_RANGE_PATTERN = new RegExp(`^${WHITELIST_CELL_RANGE}$`);
const WHITELIST_SQREF_PATTERN = new RegExp(`^${WHITELIST_CELL_RANGE}(?: ${WHITELIST_CELL_RANGE})*$`);
const WHITELIST_ATTRIBUTE_VALUES = Object.freeze({
  s: /^\d+$/, style: /^\d+$/, numFmtId: /^\d+$/, xfId: /^\d+$/, dxfId: /^\d+$/, min: /^\d+$/, max: /^\d+$/, sheetId: /^\d+$/,
  customFormat: /^(?:0|1|true|false)$/, applyNumberFormat: /^(?:0|1|true|false)$/, date1904: /^(?:0|1|true|false)$/,
  sqref: WHITELIST_SQREF_PATTERN
});
const WHITELIST_REF_ELEMENTS = new Set(['mergeCell', 'dimension']);
const WHITELIST_ATTRIBUTE_NAME = /^[a-z][A-Za-z0-9]*$/;
const WHITELIST_RELATIONSHIP_ATTRIBUTES = new Set(['Id', 'Type', 'Target', 'TargetMode']);
// 带前缀的属性（局部名称）：工作表关系编号（r:id）、行高下沉（x14ac:dyDescent）、修订编号（xr:uid）
const WHITELIST_PREFIXED_ATTRIBUTES = new Set(['id', 'dyDescent', 'uid']);
const WHITELIST_EXT_NAMES = new Set(['conditionalFormatting', 'cfRule', 'dxf', 'dxfs', 'numFmt', 'workbookPr', 'sqref']);
const WHITELIST_PART_RULES = Object.freeze({
  workbook: {
    root: 'workbook',
    namespaces: SPREADSHEET_MAIN_NAMESPACES,
    parents: { sheets: ['workbook'], sheet: ['sheets'], workbookPr: ['workbook'] },
    counts: { sheets: [1, 1], workbookPr: [0, 1] }
  },
  worksheet: {
    root: 'worksheet',
    namespaces: SPREADSHEET_MAIN_NAMESPACES,
    parents: {
      sheetData: ['worksheet'], row: ['sheetData'], c: ['row'], mergeCells: ['worksheet'], mergeCell: ['mergeCells'],
      cols: ['worksheet'], col: ['cols'], conditionalFormatting: ['worksheet'], cfRule: ['conditionalFormatting'], dimension: ['worksheet']
    },
    counts: { sheetData: [1, 1], mergeCells: [0, 1], dimension: [0, 1] }
  },
  styles: {
    root: 'styleSheet',
    namespaces: SPREADSHEET_MAIN_NAMESPACES,
    parents: {
      numFmts: ['styleSheet'], cellXfs: ['styleSheet'], cellStyleXfs: ['styleSheet'], dxfs: ['styleSheet'],
      numFmt: ['numFmts', 'dxf'], xf: ['cellXfs', 'cellStyleXfs'], dxf: ['dxfs']
    },
    counts: { numFmts: [0, 1], cellXfs: [0, 1], cellStyleXfs: [0, 1], dxfs: [0, 1] }
  },
  sharedStrings: { root: 'sst', namespaces: SPREADSHEET_MAIN_NAMESPACES, parents: { si: ['sst'] }, counts: {} },
  relationships: { root: 'Relationships', namespaces: PACKAGE_RELATIONSHIP_NAMESPACES, parents: { Relationship: ['Relationships'] }, counts: {} }
});

function splitQName(qname) {
  const colon = qname.indexOf(':');
  return colon < 0 ? ['', qname] : [qname.slice(0, colon), qname.slice(colon + 1)];
}

// 文本 / 属性值中的实体：只允许预定义实体；allowCharacterReferences 时另允许字符引用
function whitelistEntitiesAllowed(text, allowCharacterReferences) {
  const rest = text.replace(/&(?:amp|lt|gt|quot|apos);/g, '');
  if (!rest.includes('&')) return true;
  return allowCharacterReferences && !rest.replace(/&#(?:\d+|x[\da-fA-F]+);/g, '').includes('&');
}

function whitelistSensitiveAttributes(local, attributes) {
  const aliases = new Set();
  for (const [name, value] of attributes) {
    if (/^xmlns(?::|$)/.test(name)) continue;
    const [prefix, attributeLocal] = splitQName(name);
    if (local === 'Relationship' ? (prefix || !WHITELIST_RELATIONSHIP_ATTRIBUTES.has(attributeLocal))
      : (!WHITELIST_ATTRIBUTE_NAME.test(attributeLocal) || (prefix && !WHITELIST_PREFIXED_ATTRIBUTES.has(attributeLocal)))) return false;
    const alias = attributeLocal.toLowerCase();
    if (aliases.has(alias)) return false;
    aliases.add(alias);
    const pattern = WHITELIST_ATTRIBUTE_VALUES[attributeLocal]
      || (attributeLocal === 'ref' && WHITELIST_REF_ELEMENTS.has(local) ? WHITELIST_RANGE_PATTERN : null);
    if (pattern && (prefix || !pattern.test(value))) return false;
    if (local !== 'numFmt' && value.includes('>')) return false;
  }
  return true;
}

// 按白名单核对一个部件（Buffer）。onElement(局部名称, 属性 Map) 收到 <ext> 外按规定位置出现的读取用到的元素（按出现顺序）。
//   不符合时返回 false
function whitelistXmlPart(buffer, rule, onElement = null) {
  if (!buffer || !buffer.length) return false;
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch (_error) {
    return false;
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/.test(text)) return false;
  const declaration = /^<\?xml[ \r\n]+version=(["'])1\.0\1(?:[ \r\n]+encoding=(["'])utf-8\2)?(?:[ \r\n]+standalone=(["'])(?:yes|no)\3)?[ \r\n]*\?>/i.exec(text);
  let offset = declaration ? declaration[0].length : 0;
  if (/<[!?]/.test(text.slice(offset))) return false;
  const pattern = new RegExp(WHITELIST_TOKEN_SOURCE, 'y');
  const counts = new Map();
  const stack = [];
  let rootSeen = false;
  while (offset < text.length) {
    pattern.lastIndex = offset;
    const match = pattern.exec(text);
    if (!match) return false;
    offset = pattern.lastIndex;
    const [token, openName, attributeText, selfClosing, closeName] = match;
    const top = stack.length ? stack[stack.length - 1] : null;
    if (openName === undefined && closeName === undefined) {
      if (!top) {
        if (token.trim() !== '') return false;
        continue;
      }
      if (!whitelistEntitiesAllowed(token, top.local === 't' || top.local === 'v' || top.local === 'f')) return false;
      if (top.text !== null) top.text += token;
      continue;
    }
    if (closeName !== undefined) {
      if (!top || top.qname !== closeName) return false;
      if (top.text !== null && !WHITELIST_SQREF_PATTERN.test(top.text)) return false;
      stack.pop();
      continue;
    }
    if (!top && rootSeen) return false;
    const attributes = new Map();
    let declares = false;
    WHITELIST_ATTRIBUTE_PATTERN.lastIndex = 0;
    let attributeMatch;
    while ((attributeMatch = WHITELIST_ATTRIBUTE_PATTERN.exec(attributeText)) !== null) {
      const name = attributeMatch[1];
      const value = attributeMatch[2] !== undefined ? attributeMatch[2] : attributeMatch[3];
      if (attributes.has(name) || !whitelistEntitiesAllowed(value, false)) return false;
      attributes.set(name, value);
      if (/^xmlns(?::|$)/.test(name)) declares = true;
    }
    let bindings = top ? top.bindings : new Map([['xml', XML_NAMESPACE]]);
    if (declares) {
      bindings = new Map(bindings);
      attributes.forEach((value, name) => {
        const declared = /^xmlns(?::(.+))?$/.exec(name);
        if (declared) bindings.set(declared[1] || '', value);
      });
    }
    const [prefix, local] = splitQName(openName);
    if (prefix && !bindings.has(prefix)) return false;
    for (const name of attributes.keys()) {
      const [attributePrefix] = splitQName(name);
      if (attributePrefix && attributePrefix !== 'xmlns' && !bindings.has(attributePrefix)) return false;
    }
    const namespace = bindings.get(prefix);
    const isMain = rule.namespaces.has(namespace);
    const inExt = Boolean(top && (top.inExt || (local === 'ext' && top.local === 'extLst' && top.main)));
    const inAlternate = Boolean(top && top.inAlternate) || (local === 'AlternateContent' && namespace === MARKUP_COMPATIBILITY_NAMESPACE);
    if (!top) {
      if (!isMain || local !== rule.root) return false;
      rootSeen = true;
    } else {
      if (declares && !inExt && !inAlternate) return false;
      if (local === rule.root) return false;
      const parents = Object.hasOwn(rule.parents, local) ? rule.parents[local] : null;
      if (parents || WHITELIST_EXT_NAMES.has(local)) {
        if (inAlternate) return false;
        if (inExt) {
          if (!WHITELIST_EXT_NAMES.has(local)) return false;
        } else {
          if (!parents || !isMain || !top.main || !parents.includes(top.local)) return false;
          counts.set(local, (counts.get(local) || 0) + 1);
        }
        if (!whitelistSensitiveAttributes(local, attributes)) return false;
        if (onElement && !inExt) onElement(local, attributes);
      }
    }
    if (!selfClosing) {
      stack.push({ qname: openName, local, main: isMain, bindings, inExt, inAlternate, text: local === 'sqref' ? '' : null });
    } else if (local === 'sqref') {
      return false;
    }
  }
  if (!rootSeen || stack.length) return false;
  return Object.entries(rule.counts).every(([name, [min, max]]) => {
    const count = counts.get(name) || 0;
    return count >= min && count <= max;
  });
}

// 关系部件中各关系的 { id, type, target }（按白名单核对，见 whitelistXmlPart）；Id / Type / Target 缺失、带 & 或外部关系时返回 null
function whitelistRelationships(buffer) {
  const relations = [];
  let valid = true;
  const passed = whitelistXmlPart(buffer, WHITELIST_PART_RULES.relationships, (local, attributes) => {
    const [id, type, target, mode] = ['Id', 'Type', 'Target', 'TargetMode'].map((name) => attributes.get(name));
    if (!id || !type || !target || [id, type, target].some((value) => value.includes('&')) || (mode !== undefined && mode !== 'Internal')) {
      valid = false;
    }
    relations.push({ id, type, target });
  });
  return passed && valid ? relations : null;
}

// 关系中类型以 /typeSuffix 结尾的部件路径（相对 baseDir 解析）：恰好一条时返回路径，没有时返回 ''，多于一条时返回 null
function whitelistRelatedPath(relations, baseDir, typeSuffix) {
  const matched = relations.filter((relation) => relation.type.endsWith(`/${typeSuffix}`));
  if (matched.length > 1) return null;
  return matched.length ? normalizeZipPath(baseDir, matched[0].target) : '';
}

function samePartPath(left, right) {
  return String(left || '').replace(/^\/+/, '').toLowerCase() === String(right || '').replace(/^\/+/, '').toLowerCase();
}

// 补录余额「导入余额文件」导入前的结构白名单（见上）。sheetXml 为第一张工作表的原文（findXlsxSheetXml）；
//   另核对：根关系指向的工作簿、工作簿关系指向的共享字符串表与样式表，与读取库按 [Content_Types].xml 取的部件相同；工作簿只有
//   一个 <sheets>，第一个 <sheet> 就是读取库读的第一张表（名称一致、张数一致）且不是隐藏表；<workbookPr> 的 date1904 与读取库
//   读出的日期系统一致。全部符合时返回 true
function verifyXlsxStructureWhitelist(workbook, sheetName, sheetXml) {
  const files = workbook && workbook.files;
  const directory = workbook && workbook.Directory;
  if (!files || !directory || !Array.isArray(directory.workbooks) || directory.workbooks.length !== 1) return false;
  const workbookPath = String(directory.workbooks[0]).replace(/^\/+/, '');
  const rootRelations = whitelistRelationships(getZipEntryBuffer(files, '_rels/.rels'));
  if (!rootRelations || !samePartPath(whitelistRelatedPath(rootRelations, '', 'officeDocument'), workbookPath)) return false;
  const sheets = [];
  let workbookProps = null;
  const workbookPassed = whitelistXmlPart(getZipEntryBuffer(files, workbookPath), WHITELIST_PART_RULES.workbook, (local, attributes) => {
    if (local === 'sheet') sheets.push(attributes);
    if (local === 'workbookPr') workbookProps = attributes;
  });
  if (!workbookPassed || !Array.isArray(workbook.SheetNames) || sheets.length !== workbook.SheetNames.length) return false;
  const decodeName = (value) => String(value || '').replace(/&(amp|lt|gt|quot|apos);/g, (_match, named) => XML_PREDEFINED_ENTITIES[named]);
  if (workbook.SheetNames[0] !== sheetName || decodeName(sheets[0].get('name')) !== sheetName) return false;
  if (sheets[0].has('state') && sheets[0].get('state') !== 'visible') return false;
  const date1904 = /^(?:1|true)$/.test((workbookProps && workbookProps.get('date1904')) || '');
  const readerProps = workbook.Workbook && workbook.Workbook.WBProps;
  if (date1904 !== Boolean(readerProps && readerProps.date1904)) return false;
  const workbookDir = workbookPath.split('/').slice(0, -1).join('/');
  const relations = whitelistRelationships(getZipEntryBuffer(files, `${workbookDir ? `${workbookDir}/` : ''}_rels/${workbookPath.split('/').pop()}.rels`));
  if (!relations || !whitelistXmlPart(sheetXml, WHITELIST_PART_RULES.worksheet)) return false;
  return [['sharedStrings', 'sst', 'strs', WHITELIST_PART_RULES.sharedStrings], ['styles', 'style', 'styles', WHITELIST_PART_RULES.styles]]
    .every(([typeSuffix, directoryKey, directoryList, rule]) => {
      const partPath = whitelistRelatedPath(relations, workbookDir, typeSuffix);
      if (partPath === null || (Array.isArray(directory[directoryList]) && directory[directoryList].length > 1)) return false;
      if (!samePartPath(partPath, directory[directoryKey])) return false;
      return partPath === '' || whitelistXmlPart(getZipEntryBuffer(files, partPath), rule);
    });
}

// 只按结构白名单（W2）核对读取库实际读取的部件，不做后续的公式缓存、合并范围等核对（导出供单测分层验证白名单本身）
function checkXlsxStructureWhitelist(workbook, sheetName) {
  const xml = findXlsxSheetXml(workbook, sheetName);
  return Boolean(xml) && verifyXlsxStructureWhitelist(workbook, sheetName, xml);
}

// v3.2.22：补录余额「导入余额文件」——按 XLSX 工作表 XML 原文核对公式的缓存值，不依赖读取库读出的公式与值：
//   - uncachedCells：带公式元素、却没有可用缓存值的单元格位置 Set<"行下标:列下标">（与读取库的单元格坐标一致）。可用缓存值按
//     读取库取值的口径：内联文本格（t="inlineStr"）为 <is> 中去掉注音后的文本，其余为第一个 <v> 的内容，去掉空白后非空才算。
//     共享公式的从属单元格可以写成空的 <f t="shared" si="0"></f>，没有缓存值时读取库读成不带公式的占位（实测）；
//     数值公式的 <v> 只有空白时读取库读成 NaN；
//   - arrayRanges：数组公式（<f t="array" ref="…">）的结果区域（规范化的 A1:B2 写法）；arrayCachedCells：这些区域内有可用缓存值的格。
//     属性用单引号时读取库不认数组公式，区域内没有缓存的结果格可能不建单元格、也可能建成空文本等（实测），须按原文逐格核对。
//   - mergeRanges：工作表实际生效的合并范围（见 xlsxSheetMergeRanges）。读取库只认双引号、大写写法的 ref（实测单引号写法的
//     合并范围读取库会漏掉），由调用方与读取库读出的合并范围合并使用；读取库读出的合并范围不在其中时（R26）返回 null。
//   单元格的位置按读取库的口径逐格推算（forEachReaderCell），与读取库放置单元格的位置相同。找不到读取库实际读取的工作表原文
//   （见 findXlsxSheetXml）、位置推算不出合法坐标、数组 / 合并区域写法异常、条目带 UTF-16 BOM，或工作表 XML 有注释（读取库会解析
//   注释里的行，B133 构造②）时返回 null（无法核对）
function scanXlsxFormulaCache(workbook, sheetName) {
  const xml = findXlsxSheetXml(workbook, sheetName);
  if (!xml) return null;
  // 结构白名单（W2）：不符合时不核对
  if (!verifyXlsxStructureWhitelist(workbook, sheetName, xml)) return null;
  const text = readerXmlText(xml);
  const textCells = [];
  if (text === null || text.includes('<!--')) return null;
  // 单元格实际生效的数字格式可能改变显示的格（R24：displayFormatCells，见 xlsxDisplayFormatChecker）；样式表无法核对时
  //   displayFormatUnknown 为 true（所有格都按可能改变显示处理）
  const displayFormatCells = new Set();
  const plainDisplayStyle = xlsxDisplayFormatChecker(workbook, text);
  const onCellStyle = plainDisplayStyle ? (r, c, style, rowStyle) => {
    if (!plainDisplayStyle(c, style, rowStyle)) displayFormatCells.add(`${r}:${c}`);
  } : null;
  if (!isCanonicalSheetData(text, (r, c, expected) => { textCells.push([r, c, expected]); }, onCellStyle)) return null;
  // 文本格须与读取库读出的值一致（R21）
  const verifiedTexts = verifyReaderTextCells(workbook, workbook.Sheets && workbook.Sheets[sheetName], textCells);
  if (!verifiedTexts) return null;
  const formulaPattern = /<(?:[\w.-]+:)?f\b([^>]*?)\/?>/g;
  // 读取库取值的写法（match_v、isregex）
  const valuePattern = /<(?:\w+:)?v(?: xml:space="preserve")?(?:[^>]*)>([\s\S]*?)<\/(?:\w+:)?v>/;
  const inlineStringPattern = /<(?:\w+:)?is>([\S\s]*?)<\/(?:\w+:)?is>/;
  const phoneticPattern = /<(?:\w+:)?rPh\b[\s\S]*?<\/(?:\w+:)?rPh>/g;
  const rangePattern = /^[A-Z]{1,3}[1-9]\d{0,6}(?::[A-Z]{1,3}[1-9]\d{0,6})?$/;
  const meaningful = (latin1Text) => Buffer.from(latin1Text, 'latin1').toString('utf8').trim() !== '';
  // 文本类缓存值（文本、内联文本、共享字符串）按核对过的解码文本判断是否为空白（R23：&#32; 等字符引用写的空白同样算没有缓存，
  //   共享字符串按引用项的实际文本），其余按原文
  const hasCachedValue = (cellTag, body, position) => {
    const key = `${position.r}:${position.c}`;
    if (verifiedTexts.has(key)) return verifiedTexts.get(key).trim() !== '';
    if (cellTag.t === 'inlineStr') {
      const inline = inlineStringPattern.exec(body);
      return Boolean(inline) && meaningful(inline[1].replace(phoneticPattern, '').replace(/<[^>]*>/g, ''));
    }
    const value = valuePattern.exec(body);
    return Boolean(value) && meaningful(value[1]);
  };
  // 按读取库的口径逐格给出位置与内容；位置推算不出合法坐标时返回 false
  const visitCells = (visit) => forEachReaderCell(text, (ref, cellTag, body) => {
    let position;
    try {
      position = XLSX.utils.decode_cell(ref);
    } catch (_error) {
      return false;
    }
    if (!(Number.isInteger(position.r) && position.r >= 0 && Number.isInteger(position.c) && position.c >= 0)) return false;
    return visit(position, body, cellTag);
  });
  const uncachedCells = new Set();
  const arrayRanges = [];
  // 有单元格的列（R25：数组区域的索引只建在这些列上，宽数组区域不逐列展开）
  const cellColumns = new Set();
  const scanned = visitCells((position, body, cellTag) => {
    cellColumns.add(position.c);
    const formulaTags = Array.from(body.matchAll(formulaPattern));
    if (!formulaTags.length) return true;
    for (const [, attributes] of formulaTags) {
      if (readXmlAttribute(attributes, 't') !== 'array') continue;
      const ref = String(readXmlAttribute(attributes, 'ref') || '').trim().toUpperCase().replace(/\$/g, '');
      if (!rangePattern.test(ref)) return false;
      const area = XLSX.utils.decode_range(ref);
      if (!(area.e.r >= area.s.r && area.e.c >= area.s.c)) return false;
      arrayRanges.push(XLSX.utils.encode_range(area));
    }
    if (!hasCachedValue(cellTag, body, position)) uncachedCells.add(`${position.r}:${position.c}`);
    return true;
  });
  if (!scanned) return null;
  const mergeRanges = xlsxSheetMergeRanges(text, rangePattern);
  if (!mergeRanges) return null;
  // 读取库读出的合并范围须都在其中（R26：读取库按局部名称在 sheetData 之后的全部原文里找 mergeCell，扩展元数据里的同名元素也会
  //   读成合并范围，被当作合并遮住的账号会改取首格的账号）
  const readerSheet = workbook.Sheets && workbook.Sheets[sheetName];
  const mergeKeys = new Set(mergeRanges);
  if (readerSheet && Array.isArray(readerSheet['!merges'])
    && readerSheet['!merges'].some((merge) => !merge || !merge.s || !merge.e || !mergeKeys.has(XLSX.utils.encode_range(merge)))) return null;
  // 数组区域内有可用缓存值的格（只在有数组公式时再扫一遍）。按列建区域索引：同列的行区间排序后合并重叠 / 相邻的，
  //   二分查找所在区间（逐行一个单格数组公式时不必逐格比对全部区间）
  const arrayCachedCells = new Set();
  if (arrayRanges.length) {
    const rowSpansByColumn = new Map();
    const sortedCellColumns = Array.from(cellColumns).sort((left, right) => left - right);
    arrayRanges.forEach((ref) => {
      const area = XLSX.utils.decode_range(ref);
      sortedCellColumns.forEach((c) => {
        if (c < area.s.c || c > area.e.c) return;
        if (!rowSpansByColumn.has(c)) rowSpansByColumn.set(c, []);
        rowSpansByColumn.get(c).push([area.s.r, area.e.r]);
      });
    });
    rowSpansByColumn.forEach((spans, c) => {
      spans.sort((left, right) => left[0] - right[0]);
      const merged = [];
      spans.forEach(([first, last]) => {
        const previous = merged[merged.length - 1];
        if (previous && first <= previous[1] + 1) previous[1] = Math.max(previous[1], last);
        else merged.push([first, last]);
      });
      rowSpansByColumn.set(c, merged);
    });
    const inArrayRange = (r, c) => {
      const spans = rowSpansByColumn.get(c);
      if (!spans) return false;
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
    visitCells((position, body, cellTag) => {
      if (inArrayRange(position.r, position.c) && hasCachedValue(cellTag, body, position)) arrayCachedCells.add(`${position.r}:${position.c}`);
      return true;
    });
  }
  // 带数字格式的条件格式覆盖的区域（R23 / R24）：读取库按单元格自身的格式给显示文本，不应用条件格式（如把 1 显示为 001、
  //   把文本 1 显示为 HK1），这些格的显示无法核对；与账单查重同口径（conditionalNumberFormatAreas，null 为整张表）
  const conditionalFormatAreas = conditionalNumberFormatAreas(workbook, text);
  return {
    uncachedCells, arrayRanges, arrayCachedCells, mergeRanges, conditionalFormatAreas,
    displayFormatCells, displayFormatUnknown: !plainDisplayStyle
  };
}

// v3.2.22 R24：补录余额「导入余额文件」——单元格的显示是否一定与原值相同。只认常规（General，编号 0）、整数（0，编号 1）与
//   文本（@，编号 49）三种格式：文本在这三种格式下原样显示，数值的显示另按读取库的显示文本核对；其余格式（含自定义格式的文本段，
//   如 0;0;0;"HK"@ 把文本 1 显示为 HK1）一律按可能改变显示处理。单元格样式所属命名样式（cellStyleXfs）的格式一并须为这三种。
//   单元格没有自身样式时，样式 0、customFormat 的行样式与列样式都须为这三种（继承规则不判断）。
//   返回 (列下标, 单元格样式, 行样式) => 是否一定原样显示；样式表无法核对时返回 null
const PLAIN_DISPLAY_FORMAT_KEYS = new Set(['builtin:0', 'builtin:1', 'builtin:49', 'custom:General', 'custom:0', 'custom:@']);
function xlsxDisplayFormatChecker(workbook, sheetText) {
  const formatOf = readXlsxCellFormatResolver(workbook);
  if (!formatOf) return null;
  // 样式表的格式编号、样式序号写成字符引用等（R25）时无法确认对应关系
  const stylesText = readXlsxStylesText(workbook) || '';
  if (/\b(?:numFmtId|xfId)\s*=\s*(["'])(?!\d+\1)/.test(stylesText)) return null;
  // 列样式按元素取（R27，见 xlsxSheetColumnStyles）；无法确认时所有格按可能改变显示处理
  const columnStyles = xlsxSheetColumnStyles(sheetText);
  if (!columnStyles) return null;
  const plainStyles = new Map();
  const isPlain = (style) => {
    const key = String(style);
    if (!plainStyles.has(key)) {
      const resolved = /^\d+$/.test(key) ? formatOf(key) : null;
      const [own, parent] = resolved === null ? [null, null] : JSON.parse(resolved);
      plainStyles.set(key, PLAIN_DISPLAY_FORMAT_KEYS.has(own) && (parent === null || PLAIN_DISPLAY_FORMAT_KEYS.has(parent)));
    }
    return plainStyles.get(key);
  };
  return (column, style, rowStyle) => {
    if (style !== null) return isPlain(style);
    if (!isPlain('0') || (rowStyle !== null && !isPlain(rowStyle))) return false;
    // 列样式：min / max 写法异常时按可能改变显示处理
    return columnStyles.every((item) => (Number.isInteger(item.min) && Number.isInteger(item.max)
      ? (column + 1 < item.min || column + 1 > item.max || isPlain(item.style))
      : false));
  };
}

// 文本 / HTML 工作簿：按文本重新读取同一张表（同样的截取行数），读取范围须与原读取一致。
function readTextIntegerLiterals(filePath, sheet, sheetName, rowLimit) {
  let rawSheet = null;
  try {
    const rawBook = XLSX.readFile(filePath, {
      cellDates: false,
      dense: true,
      raw: true,
      ...(rowLimit > 0 ? { sheetRows: rowLimit } : {})
    });
    rawSheet = rawBook.Sheets[sheetName] || null;
  } catch (error) {
    if (isMemoryLimitError(error)) throw error;
    return null;
  }
  if (!rawSheet || rawSheet['!ref'] !== sheet['!ref']) return null;
  const rawRows = Array.isArray(rawSheet) ? rawSheet : (Array.isArray(rawSheet['!data']) ? rawSheet['!data'] : null);
  if (!rawRows) return null;
  return (r, c) => {
    const rawCell = Array.isArray(rawRows[r]) ? rawRows[r][c] : null;
    return rawCell && typeof rawCell.v === 'string' ? rawCell.v.trim() : null;
  };
}

// exactSourceText（v3.2.21 B112，只由网银账单生成传入，须同时 blankrows）：读出的值不变，另附不可枚举属性——
//   sourceText：长整数的文件原文（collectLongIntegerSourceText）；displayText：CSV 的「Excel 显示值」（parseCsvText）。
//   readRowsWithMetadata 只用于数据行；readRows 原样带出 sourceText，由大账号识别定位表头后用于账户信息行。
function readWorkbookRowsUnchecked(filePath, { blankrows = false, sheetName, maxRows = 0, csvMaxSourceBytes, markErrorCells = false, exactSourceText = false, markErrorValueRows = false } = {}) {
  ensureSupportedFile(filePath);

  if (!fs.existsSync(filePath) || (fs.statSync(filePath).size === 0 && csvMaxSourceBytes === undefined)) {
    throw new FileValidationError('FILE_READ', '文件为空或不可读，请重新导入');
  }

  const rowLimit = Number.isInteger(maxRows) && maxRows > 0 ? maxRows : 0;

  if (path.extname(filePath).toLowerCase() === '.csv') {
    try {
      const raw = csvMaxSourceBytes === undefined ? fs.readFileSync(filePath) : readBoundedCsvBytes(filePath, csvMaxSourceBytes);
      // 检测 magic bytes：XLS (OLE2) = D0CF11E0，XLSX (ZIP) = 504B0304
      // 如果 .csv 文件实际是 Excel 二进制格式，跳过 CSV 解析，走 XLSX 库
      const isOLE2 = raw.length >= 4 && raw[0] === 0xD0 && raw[1] === 0xCF && raw[2] === 0x11 && raw[3] === 0xE0;
      const isZIP = raw.length >= 4 && raw[0] === 0x50 && raw[1] === 0x4B && raw[2] === 0x03 && raw[3] === 0x04;
      if (!isOLE2 && !isZIP) {
        const body = raw[0] === 0xEF && raw[1] === 0xBB && raw[2] === 0xBF ? raw.subarray(3) : raw;
        const content = body.toString('utf-8');
        const rows = parseCsvText(content, { blankrows, withSources: markErrorCells, withDisplayText: exactSourceText });
        const result = rowLimit > 0 ? rows.slice(0, rowLimit) : rows;
        if (result !== rows && Array.isArray(rows.displayText)) {
          Object.defineProperty(result, 'displayText', { value: rows.displayText.slice(0, result.length), enumerable: false });
        }
        // v3.2.19 重复账单过滤：每行附该行原文的摘要（列下标 -2，见 collectSpecialCells），原文完全相同的行才可能判为重复——
        //   解析器会吞掉未加引号字段中间的引号（SALE 2" X" 与 SALE 2 X 读成同一文本）等。
        //   有不能按 UTF-8 解码的字节时，不同的原文可能解出同一替换字符（如 café、cafè 都成 caf�），
        //   含替换字符的单元格值未知，该行不参与查重（普通映射照旧）
        if (markErrorCells) {
          const specials = new Map();
          const sources = Array.isArray(rows.sources) ? rows.sources : [];
          result.forEach((row, rowIndex) => {
            const rowMarks = new Map();
            rowMarks.set(-2, { sourceText: sha256Text(sources[rowIndex] === undefined ? '' : sources[rowIndex]) });
            if (sources[rowIndex] === undefined) rowMarks.set(-1, { unknownValue: '行原文无法核对' });
            (Array.isArray(row) ? row : []).forEach((cell, columnIndex) => {
              if (typeof cell !== 'string') return;
              // Excel 打开时按公式计算的文本（如 ="TX-"&ROW()、+ROW()）：值无法证明
              if (looksLikeSpreadsheetFormula(cell)) rowMarks.set(columnIndex, { unknownValue: '公式' });
              // 含替换字符（U+FFFD）的单元格不论本次解码是否有损都无法核对：文件里的替换字符可能是上游解码丢失后写入的
              else if (cell.includes('\uFFFD')) rowMarks.set(columnIndex, { unknownValue: '编码无法识别' });
            });
            specials.set(rowIndex, rowMarks);
          });
          Object.defineProperty(result, 'excelErrorCells', { value: specials, enumerable: false });
        }
        return result;
      }
      if (csvMaxSourceBytes !== undefined) {
        throw new FileValidationError('TOOLBOX_SPLIT_READ_CONTEXT_STALE', 'CSV 文件类型已变化，请重新选择');
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
      // v3.2.19：查重读取时保留没有缓存结果的公式（占位单元格在 collectSpecialCells 中收集后删除），
      //   并保留压缩包原文（bookFiles），用于按工作表 XML 核对公式
      //   并保留数字格式（cellNF，按格式比较显示文本不同的值）
      ...(markErrorCells ? { sheetStubs: true, bookFiles: true, cellNF: true } : {}),
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
    const sheetRange = sheet['!ref'] ? XLSX.utils.decode_range(sheet['!ref']) : null;
    const specialCells = markErrorCells && sheetRange ? collectSpecialCells(sheet, sheetRange) : null;
    if (specialCells) {
      // 1904 日期系统：日期序号相同、实际日期不同，不与 1900 日期系统的文件互判重复
      if (workbook.Workbook && workbook.Workbook.WBProps && workbook.Workbook.WBProps.date1904) {
        for (let r = sheetRange.s.r; r <= sheetRange.e.r; r += 1) specialCells.markRowDateSystem(r);
      }
      // 纵向合并单元格：只有首行存值，其余行的该格为空但实际属于同一值（如合并的流水号标识一笔交易及其费用行），
      //   这些行无法证明整行相同，不参与查重
      (Array.isArray(sheet['!merges']) ? sheet['!merges'] : []).forEach((merge) => {
        if (!merge || !merge.s || !merge.e || merge.e.r <= merge.s.r) return;
        contentRowsWithin(sheet, Math.max(merge.s.r + 1, sheetRange.s.r), Math.min(merge.e.r, sheetRange.e.r))
          .forEach((r) => specialCells.markRowUnknown(r, '纵向合并单元格'));
      });
      const container = detectWorkbookContainer(filePath);
      if (container === 'zip' || container === 'ole2') markNumberFormatCells(sheet, specialCells, { includeGeneral: container === 'ole2' });
      // XLS：读取库不解析 Excel 2007 起的条件格式记录（CondFmt12 / CF12 / CFEx，可以改数字格式），有这类记录时整张表不参与查重
      if (container === 'ole2' && hasBiffConditionalFormat12(filePath)) {
        contentRowsWithin(sheet, sheetRange.s.r, sheetRange.e.r).forEach((r) => specialCells.markRowUnknown(r, '条件格式'));
      }
      if (container === 'zip') markXlsxSourceEvidence(workbook, targetSheetName, sheet, sheetRange, specialCells);
      else if (container === 'text') markTextSourceCells(filePath, targetSheetName, sheet, sheetRange, specialCells);
    }
    // 下标与 blankrows 读取的行、列一致（行从有效范围首行起、列从首列起），不保留空行时无法对应，不取原文。
    //   取不到原文时保持读取结果（生成时按无法核对原值提示）；容量类错误照常按文件过大处理
    let sourceText = null;
    if (exactSourceText && blankrows && sheetRange) {
      try {
        sourceText = collectLongIntegerSourceText({ filePath, workbook, sheet, sheetName: targetSheetName, range: sheetRange, rowLimit });
      } catch (sourceTextError) {
        if (isMemoryLimitError(sourceTextError)) throw sourceTextError;
      }
    }
    const rows = XLSX.utils.sheet_to_json(sheet, {
      header: 1,
      blankrows,
      defval: ''
    });
    const result = rowLimit > 0 ? rows.slice(0, rowLimit) : rows;
    // v3.2.19：有效范围不从第 1 行开始（前几行完全为空）时，rows[0] 对应的 Excel 物理行号；
    //   保留空行读取时「下标 + firstRowNumber」即物理行号。只记偏移，不补出前面的空行。
    Object.defineProperty(result, 'firstRowNumber', { value: sheetRange ? sheetRange.s.r + 1 : 1, enumerable: false });
    // 同理，rows[i][0] 对应的物理列下标（A 列为 0）；只有查重按物理列对齐整行时使用
    Object.defineProperty(result, 'firstColumnIndex', { value: sheetRange ? sheetRange.s.c : 0, enumerable: false });
    if (specialCells) {
      Object.defineProperty(result, 'excelErrorCells', { value: specialCells, enumerable: false });
    }
    if (sourceText) {
      Object.defineProperty(result, 'sourceText', { value: sourceText, enumerable: false });
    }
    // 下标与 blankrows 读取的行对应，不保留空行时无法对应，不收集
    if (markErrorValueRows && blankrows && sheetRange) {
      const errorValueRows = collectErrorValueRows(sheet, sheetRange);
      if (errorValueRows.size) Object.defineProperty(result, 'errorValueRows', { value: errorValueRows, enumerable: false });
      const outOfRangeContentRows = collectOutOfRangeContentRows(sheet, sheetRange);
      if (outOfRangeContentRows.size) Object.defineProperty(result, 'outOfRangeContentRows', { value: outOfRangeContentRows, enumerable: false });
    }
    return result;
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

// 限额应用于实际读取量；即使 stat 后文件增长，也只读到上限加一个哨兵字节。
function readBoundedCsvBytes(filePath, maxBytes) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes >= 2 ** 30) throw new TypeError('CSV 读取上限无效');
  const fd = fs.openSync(filePath, 'r');
  try {
    const unsuitable = () => new FileValidationError('EXECUTION_INPUT_PROFILE_UNSUITABLE',
      '当前 CSV 超出本次低内存读取容量，请重新选择文件后重试');
    if (fs.fstatSync(fd).size > maxBytes) throw unsuitable();
    const buffer = Buffer.allocUnsafe(maxBytes + 1);
    let size = 0;
    while (size <= maxBytes) {
      const read = fs.readSync(fd, buffer, size, buffer.length - size, null);
      if (read === 0) return buffer.subarray(0, size);
      size += read;
    }
    throw unsuitable();
  } finally { fs.closeSync(fd); }
}

// 有界 CSV 允许空表返回 []，避免旧空表兼容分支重新做无界读取。
function readCsvRowsWithinBudget(filePath, maxBytes) {
  if (path.extname(filePath).toLowerCase() !== '.csv') throw new TypeError('有界 CSV 读取仅接受 CSV 路径');
  return readWorkbookRows(filePath, { csvMaxSourceBytes: maxBytes });
}

// exactSourceText（v3.2.21 B112，大账号识别）：读出的值不变，另附长整数的文件原文（不可枚举属性 sourceText，
//   Map<行下标, Map<列下标, 原文>>）；大账号识别按读取值定位表头后，只把原文用于表头以外的行（main.js）
function readRows(filePath, { blankrows = false, maxRows = 0, readGuard, exactSourceText = false } = {}) {
  const rows = readWorkbookRows(filePath, { blankrows, maxRows, readGuard, exactSourceText });

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
  normalizedExpectedHeaders,
  includeFullRows = false
}) {
  const expectedHeaderCount = normalizedExpectedHeaders.length;
  const rows = [];
  const rowNumbers = [];
  // v3.2.19 重复账单过滤：includeFullRows 时另给与 rows 同下标对齐的整行（含模板表头范围以外的列、Excel 错误值标记）
  //   与该行所属分段的整行表头（遇到重复表头即换成新分段的表头）。
  const fullRows = includeFullRows ? [] : null;
  const fullHeaders = includeFullRows ? [] : null;
  const fullCellsOf = (row) => row.fullCells || row.cells;
  let currentFullHeader = includeFullRows ? fullCellsOf(meaningfulRows[matchedRowIndex]) : null;
  const headerBreaks = [];
  // v3.2.21 B112：与 rows 同下标，换成长整数原文的数据单元格 → 读取库的值（Map<列下标, 值>，没有为 null）
  const longIntegerReadValues = [];
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
      if (fullRows) currentFullHeader = fullCellsOf(row);
      continue;
    }

    // v3.2.21 B112：数据行取长整数原文与 CSV 的 Excel 显示值（readRowsWithMetadata 的 displayCells）；表头行与上面的判定仍按读取值
    let dataCells = normalizedCells;
    let readValues = null;
    if (index > 0 && row.displayCells) {
      dataCells = row.displayCells.slice(matchedColumnIndex, matchedColumnIndex + expectedHeaderCount);
      while (dataCells.length < expectedHeaderCount) {
        dataCells.push('');
      }
    }
    if (index > 0 && row.longIntegerReadValues) {
      row.longIntegerReadValues.forEach((value, columnIndex) => {
        const dataColumnIndex = columnIndex - matchedColumnIndex;
        if (dataColumnIndex < 0 || dataColumnIndex >= expectedHeaderCount) return;
        if (!readValues) readValues = new Map();
        readValues.set(dataColumnIndex, value);
      });
    }

    if (index > 0 && !isRowMeaningful(dataCells)) {
      continue;
    }

    rows.push(dataCells);
    rowNumbers.push(row.rowNumber);
    longIntegerReadValues.push(readValues);
    if (fullRows) {
      fullRows.push(fullCellsOf(row));
      fullHeaders.push(currentFullHeader);
    }
  }

  return {
    rows,
    rowNumbers,
    headerBreaks,
    ...(longIntegerReadValues.some(Boolean) ? { longIntegerReadValues } : {}),
    ...(fullRows ? { fullRows, fullHeaders } : {})
  };
}

// 在「有意义行」二维数组里定位表头：找首个「连续子序列全等 normalizedExpectedHeaders」的行 + 起始列偏移。
//   rowsCells：每行为一个 cell 数组（调用方负责已 trimTrailingEmptyCells + 过滤全空行）。
//   normalizedExpectedHeaders：已 normalizeCell 的表头段；空项（''）按位置参与比较，只匹配空单元格。
//   返回 { matchedRowIndex, matchedColumnIndex }；未命中均为 -1。
// 这是表类型识别 / 表头定位的「连续子序列全等」匹配核心算法（大小写敏感，由 normalizeCell 仅 trim 保证）。
//   readRowsWithMetadata 与 table-type-detector 的 L1 共用此函数；改动须同步回归两侧单测。
//   两侧传入的表头口径不同：账单模板按 buildExpectedHeaderCandidates 先保留中间空项再退回去空；
//   detector 的内置签名锚点仍去空（含中间空列的表用 l1MatchHeaders 取空列前的连续段），不要互相对齐。
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
  const { sheetName, readGuard, onWorkbookRows, includeFullRows = false, exactSourceText = false } = options;
  const rawRows = readWorkbookRows(filePath, { blankrows: true, sheetName, readGuard, markErrorCells: includeFullRows, exactSourceText, markErrorValueRows: true });
  // v3.2.21 B112：大账号识别拿到的行与 readRows 的 exactSourceText 一致：读取值另附长整数原文（sourceText），CSV 显示值不用
  const sourceTextByRow = rawRows.sourceText instanceof Map ? rawRows.sourceText : null;
  if (typeof onWorkbookRows === 'function') onWorkbookRows(rawRows);
  const headerCandidates = buildExpectedHeaderCandidates(expectedHeaders);
  // 行号是 Excel 物理行号：有效范围不从第 1 行开始时加上起始偏移（与大账号分段识别同一口径）
  const firstRowNumber = Number(rawRows.firstRowNumber) > 0 ? Number(rawRows.firstRowNumber) : 1;
  const errorCells = includeFullRows && rawRows.excelErrorCells instanceof Map ? rawRows.excelErrorCells : null;
  // 查重用的整行（只在 includeFullRows 时构造，普通映射不受影响）：Excel 错误值、没有缓存结果的公式记为标记对象
  //   （见 collectSpecialCells），指纹序列化时与任何文本、空白都不同。物理列偏移另行返回（fullColumnOffset），不展开空列。
  const buildFullCells = (cells, rawIndex) => {
    const rowMarks = errorCells && errorCells.get(rawIndex);
    if (!rowMarks) return null;
    const full = cells.slice();
    const rowLevelMarks = [];
    rowMarks.forEach((mark, columnIndex) => {
      if (columnIndex < 0) {
        rowLevelMarks.push([columnIndex, mark]);
        return;
      }
      while (full.length < columnIndex) full.push('');
      full[columnIndex] = mark;
    });
    // 整行级标记按固定顺序追加在行尾：整行原始标记（-2，参与比较）、整行值未知（-1，见到即不为该行生成指纹）
    rowLevelMarks.sort((left, right) => left[0] - right[0]).forEach(([, mark]) => full.push(mark));
    return full;
  };
  // v3.2.21 B112：长整数的文件原文与 CSV 单元格的 Excel 显示值（="…"、首尾制表符，见 parseCsvText）。
  //   表头定位与重复表头判定仍按读取库的值（与模板导入读表头一致，旧模板里存的就是这个值），
  //   只有表头以下的数据行换成原文 / 显示值；查重的整行（fullCells）仍按读取库的值（另有原文核对）。
  const displayTextByRow = Array.isArray(rawRows.displayText) ? rawRows.displayText : null;
  const buildDisplayCells = (cells, rawIndex) => {
    const overrides = [sourceTextByRow && sourceTextByRow.get(rawIndex), displayTextByRow && displayTextByRow[rawIndex]]
      .filter(Boolean);
    if (!overrides.length) return null;
    const displayCells = cells.slice();
    overrides.forEach((rowOverrides) => rowOverrides.forEach((text, columnIndex) => {
      if (columnIndex < displayCells.length) displayCells[columnIndex] = text;
    }));
    return displayCells;
  };
  // 换成长整数原文的单元格 → 读取库的值（Map<列下标, 值>）：生成时发生额、余额列仍按读取值计算（见 buildMappedRows）
  const buildLongIntegerReadValues = (cells, rawIndex) => {
    const rowText = sourceTextByRow && sourceTextByRow.get(rawIndex);
    if (!rowText) return null;
    const readValues = new Map();
    rowText.forEach((_text, columnIndex) => {
      if (columnIndex < cells.length) readValues.set(columnIndex, cells[columnIndex]);
    });
    return readValues.size ? readValues : null;
  };
  const meaningfulRows = rawRows
    .map((row, index) => {
      const cells = trimTrailingEmptyCells(Array.isArray(row) ? row : []);
      const fullCells = includeFullRows ? buildFullCells(cells, index) : null;
      const displayCells = buildDisplayCells(cells, index);
      const longIntegerReadValues = buildLongIntegerReadValues(cells, index);
      return {
        rowNumber: index + firstRowNumber,
        cells,
        ...(fullCells ? { fullCells } : {}),
        ...(displayCells ? { displayCells } : {}),
        ...(longIntegerReadValues ? { longIntegerReadValues } : {})
      };
    })
    .filter((row) => isRowMeaningful(row.cells));

  if (!meaningfulRows.length) {
    throw new FileValidationError('FILE_READ', '文件为空或不可读，请重新导入');
  }

  if (!headerCandidates.length) {
    const longIntegerReadValues = meaningfulRows.map((row, index) => (index > 0 && row.longIntegerReadValues) || null);
    return {
      rows: meaningfulRows.map((row, index) => (index > 0 && row.displayCells ? row.displayCells : row.cells)),
      rowNumbers: meaningfulRows.map((row) => row.rowNumber),
      ...(longIntegerReadValues.some(Boolean) ? { longIntegerReadValues } : {}),
      // 不按表头定位时整行即全部列：查重的整行同样带错误值 / 未缓存公式标记与物理列偏移
      ...(includeFullRows ? {
        fullRows: meaningfulRows.map((row) => row.fullCells || row.cells),
        fullHeaders: meaningfulRows.map(() => meaningfulRows[0].fullCells || meaningfulRows[0].cells),
        fullColumnOffset: Number(rawRows.firstColumnIndex) > 0 ? Number(rawRows.firstColumnIndex) : 0
      } : {})
    };
  }

  const meaningfulCells = meaningfulRows.map((row) => row.cells);

  // 先按完整结构定位；命中的口径同时决定截取宽度与重复表头判定，保证取值下标与物理列一致。
  for (const normalizedExpectedHeaders of headerCandidates) {
    const { matchedRowIndex, matchedColumnIndex } = findHeaderMatchPosition(
      meaningfulCells,
      normalizedExpectedHeaders
    );

    if (matchedRowIndex >= 0 && matchedColumnIndex >= 0) {
      const matched = collectMatchedRows({
        meaningfulRows,
        matchedRowIndex,
        matchedColumnIndex,
        normalizedExpectedHeaders,
        includeFullRows
      });
      // 整行第 0 个单元格对应的 Excel 物理列下标（A 列为 0），查重按物理列对齐时使用
      if (includeFullRows) matched.fullColumnOffset = Number(rawRows.firstColumnIndex) > 0 ? Number(rawRows.firstColumnIndex) : 0;
      // v3.2.22：表头以下的非空行数——任意列有值即算，在截取模板列宽、遇汇总行截断之前统计；供网银账单区分
      //   「原表只有表头」与「原表有内容、映射后没有输出」。只有 Excel 错误值的行读出来是空行，按原表单元格另行计入；
      //   有效范围以外仍有内容的行（R20）同样计入。不可枚举，不改变既有返回结构
      const headerRawIndex = meaningfulRows[matchedRowIndex].rowNumber - firstRowNumber;
      let hiddenRowsBelowHeader = 0;
      const hiddenContentRows = new Set([
        ...(rawRows.errorValueRows instanceof Set ? rawRows.errorValueRows : []),
        ...(rawRows.outOfRangeContentRows instanceof Set ? rawRows.outOfRangeContentRows : [])
      ]);
      hiddenContentRows.forEach((rawIndex) => {
        if (rawIndex > headerRawIndex && !isRowMeaningful(trimTrailingEmptyCells(Array.isArray(rawRows[rawIndex]) ? rawRows[rawIndex] : []))) {
          hiddenRowsBelowHeader += 1;
        }
      });
      Object.defineProperty(matched, 'rowsBelowHeader', {
        value: meaningfulRows.length - matchedRowIndex - 1 + hiddenRowsBelowHeader,
        enumerable: false
      });
      return matched;
    }
  }

  throw new FileValidationError(
    'FILE_READ',
    '当前导入文件未匹配到所选模板的表头，请确认模板或原始网银账单是否正确'
  );
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
  readCsvRowsWithinBudget,
  readRows,
  readRowsWithMetadata,
  readXlsxSheetMetaLite,
  // 按需解压 ZIP 条目（导出供单测）
  openZipEntriesLazily,
  // v3.2.22：补录余额「导入余额文件」按部件原文核对结构白名单与公式的缓存值（含共享公式的从属单元格、数组公式的结果区域）
  scanXlsxFormulaCache,
  // v3.2.22：只核对结构白名单（导出供单测）
  checkXlsxStructureWhitelist
};
