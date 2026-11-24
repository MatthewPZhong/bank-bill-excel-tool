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

// XML 注释不是内容：注释里的旧关系、旧 <sheet> 等不能当作有效标签（release 审查）
function stripXmlComments(text) {
  return String(text).replace(/<!--[\s\S]*?-->/g, '');
}

// 读取库与本模块对下列写法的解析口径不同，无法证明两边读的是同一张表、同一行（B133）：
//   - 内容含尖括号的 XML 注释或 CDATA：读取库不跳过注释（注释里的 <sheet>、关系、<row>、<c> 都会被解析），本模块按
//     有效内容定位；未闭合的注释或 CDATA 同样无法核对；
//   - 标签内出现空格、回车、换行以外的空白（制表符等）：读取库（parsexmltag）只把这三种当作标签名的结束，
//     认不出 <Relationship\t…> 这类标签，本模块的正则却认得出。
//   Excel、WPS 与银行系统不会生成这些写法；出现时整张表不还原，按无法核对原值提示，也不参与重复账单过滤。
//   内容不含尖括号的注释、CDATA 里没有标签，两边读到的结构相同，照常还原（Codex 第三轮：一律不还原会让普通注释的文件
//   只剩近似值），检查标签内空白时也不把其中的文字（如 CDATA 正文里的制表符）当作标签。
//   标签按引号边界识别（属性值里的 > 不是标签结尾），属性值内的这类空白同样算在内
const UNVERIFIABLE_TAG_WHITESPACE = /<(?:[^\s>"']|[ \r\n]|"[^"]*"|'[^']*')*?(?:[^\S \r\n]|"[^"]*?[^\S \r\n]|'[^']*?[^\S \r\n])/;
function hasUnverifiableXmlMarkup(text) {
  let markupInside = false;
  const outside = String(text).replace(/<!--([\s\S]*?)-->|<!\[CDATA\[([\s\S]*?)\]\]>/g, (_match, comment, cdata) => {
    if (/[<>]/.test(comment !== undefined ? comment : cdata)) markupInside = true;
    return '';
  });
  return markupInside
    || outside.includes('<!--')
    || outside.includes('<![CDATA[')
    || UNVERIFIABLE_TAG_WHITESPACE.test(outside);
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
//   workbook.xml 或关系文件含注释、标签内有制表符等写法时（hasUnverifiableXmlMarkup）直接返回 null（B133）；
//   同一关系 Id 有多条有效关系、或 <sheet> 的关系属性无法唯一确认时无法确认来源，同样返回 null（按无法核对原值处理）
//   还须确认读取库实际读的就是这个条目（release 审查）：
//   - 读取库只要有一张表的关系解析不到，就放弃整份关系表、改按物理序号（xl/worksheets/sheetN.xml）读表：每张表的关系都须
//     唯一确认，否则返回 null；
//   - 读取库按「xl/ + 去掉其中第一个 xl/ 前缀的 Target」定位，找不到时依次取 Target 原样、关系文件所在目录 + Target：
//     须与按关系文件所在目录解析 Target 落到同一个条目；Target 含字符引用（读取库按原文使用）时同样无法确认；
//   - 读取库解析 workbook.xml 与关系文件时不跳过注释（注释里的 <sheet> 也算工作表、注释里的关系也算），关系只认不带前缀的
//     <Relationship>、同一 Id 取后一条：注释里有 <sheet> 时序号会错开，返回 null；每张表的关系按读取库的口径也须找到、
//     且与按本模块口径（注释不算、带不带前缀都认、同一 Id 唯一）确认的那条 Target 相同
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
  const relsText = relsXml.toString('utf8');
  if (hasUnverifiableXmlMarkup(rawWorkbookText) || hasUnverifiableXmlMarkup(relsText)) return null;
  const workbookText = stripXmlComments(rawWorkbookText);
  const sheetTagPattern = /<(?:[\w.-]+:)?sheet\b[^>]*>/g;
  const sheetTags = workbookText.match(sheetTagPattern) || [];
  if ((rawWorkbookText.match(sheetTagPattern) || []).length !== sheetTags.length) return null;
  const sheetIndex = Array.isArray(workbook.SheetNames) ? workbook.SheetNames.indexOf(sheetName) : -1;
  const sheetTag = sheetIndex >= 0 ? sheetTags[sheetIndex] : null;
  if (!sheetTag || readXmlAttribute(sheetTag, 'name') !== sheetName) return null;
  const relationTagsById = new Map();
  (stripXmlComments(relsText).match(/<(?:[\w.-]+:)?Relationship\b[^>]*>/g) || []).forEach((tag) => {
    const id = readXmlAttribute(tag, 'Id');
    if (!relationTagsById.has(id)) relationTagsById.set(id, []);
    relationTagsById.get(id).push(tag);
  });
  const readerRelationTagById = new Map();
  (relsText.match(/<Relationship\b[^>]*>/g) || []).forEach((tag) => readerRelationTagById.set(readXmlAttribute(tag, 'Id'), tag));
  const uniqueRelationTag = (tag) => {
    const id = readSheetRelationId(tag, workbookText);
    const tags = id ? relationTagsById.get(id) : null;
    const readerTag = id ? readerRelationTagById.get(id) : null;
    if (!tags || tags.length !== 1 || !readerTag) return null;
    // 关系的 Id、Target 含字符引用时，读取库按原文使用、与解码后的值不同，无法确认
    if ([tags[0], readerTag].some((relation) => attributeHasReference(relation, 'Id') || attributeHasReference(relation, 'Target'))) return null;
    return readXmlAttribute(readerTag, 'Target') === readXmlAttribute(tags[0], 'Target') ? tags[0] : null;
  };
  if (!sheetTags.every((tag) => uniqueRelationTag(tag))) return null;
  const relationTag = uniqueRelationTag(sheetTag);
  const target = readXmlAttribute(relationTag, 'Target');
  if (!target) return null;
  const entryKey = resolveZipEntryKey(files, normalizeZipPath(workbookDir, target));
  let readerPath = `xl/${target.replace(/[/]?xl\//, '')}`;
  if (!findZipEntryKeyLikeReader(files, readerPath)) readerPath = target;
  if (!findZipEntryKeyLikeReader(files, readerPath)) readerPath = `${relsDirPrefix}${target}`;
  if (!entryKey || findZipEntryKeyLikeReader(files, readerPath) !== entryKey) return null;
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
function readXlsxStylesText(workbook) {
  const files = workbook && workbook.files;
  const directory = workbook && workbook.Directory;
  const workbookPath = directory && Array.isArray(directory.workbooks) && directory.workbooks[0];
  let stylesPath = '';
  if (workbookPath) {
    const workbookDir = String(workbookPath).replace(/^\/+/, '').split('/').slice(0, -1).join('/');
    const relsXml = getZipEntryBuffer(files, `${workbookDir ? `${workbookDir}/` : ''}_rels/${String(workbookPath).split('/').pop()}.rels`);
    const relationTag = relsXml && (relsXml.toString('utf8').match(/<(?:[\w.-]+:)?Relationship\b[^>]*>/g) || [])
      .find((tag) => /\/styles$/.test(readXmlAttribute(tag, 'Type') || ''));
    const target = relationTag ? readXmlAttribute(relationTag, 'Target') : null;
    if (target) stylesPath = normalizeZipPath(workbookDir, target);
  }
  if (!stylesPath && directory && directory.style) stylesPath = String(directory.style);
  if (!stylesPath) return '';
  const stylesXml = getZipEntryBuffer(files, stylesPath);
  return stylesXml ? stylesXml.toString('utf8') : null;
}

// XLSX 单元格样式序号（cellXfs 下标）→ 数字格式标识：自定义格式按格式代码（不同文件的格式编号可以不同），内置格式按编号。
//   样式表读不到时返回 null（无法核对显示格式）。
function readXlsxCellFormatResolver(workbook) {
  const text = readXlsxStylesText(workbook);
  if (text === null) return null;
  // 属性值里可以有未转义的 >（如格式代码 [>0]"A-"000;General）：按引号边界匹配整个标签；读不到格式代码时记为 null（无法核对）
  const customFormats = new Map();
  (text.match(/<(?:[\w.-]+:)?numFmt\b(?:[^>"']|"[^"]*"|'[^']*')*>/g) || []).forEach((tag) => {
    const id = readXmlAttribute(tag, 'numFmtId');
    if (id !== null) customFormats.set(Number(id), readXmlAttribute(tag, 'formatCode'));
  });
  const xfTags = (pattern) => {
    const block = pattern.exec(text);
    return block ? block[1].match(/<(?:[\w.-]+:)?xf\b(?:[^>"']|"[^"]*"|'[^']*')*>/g) || [] : [];
  };
  const cellXfs = xfTags(/<(?:[\w.-]+:)?cellXfs\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?cellXfs>/);
  const cellStyleXfs = xfTags(/<(?:[\w.-]+:)?cellStyleXfs\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?cellStyleXfs>/);
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

// XLSX 样式表中带数字格式（numFmt）的差异格式（dxf）序号；样式表读不到时返回 null（按可能带数字格式处理）。
function readXlsxNumberFormatDxfIds(workbook) {
  const text = readXlsxStylesText(workbook);
  if (text === null) return null;
  const dxfsMatch = /<(?:[\w.-]+:)?dxfs\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?dxfs>/.exec(text);
  const ids = new Set();
  if (!dxfsMatch) return ids;
  const dxfPattern = /<(?:[\w.-]+:)?dxf\b[^>]*?(?:\/>|>([\s\S]*?)<\/(?:[\w.-]+:)?dxf>)/g;
  let index = 0;
  let match;
  while ((match = dxfPattern.exec(dxfsMatch[1])) !== null) {
    if (/<(?:[\w.-]+:)?numFmt\b/.test(match[1] || '')) ids.add(index);
    index += 1;
  }
  return ids;
}

// XLSX 条件格式可以给满足条件的单元格换数字格式（如把 123 显示为 TX-A-0123），读取只得到值：
//   带数字格式的条件格式（含 x14 扩展）覆盖的行不参与查重。
function markConditionalNumberFormatRows(workbook, sheet, text, range, specials) {
  if (!/conditionalFormatting/.test(text)) return;
  let numberFormatDxfIds;
  const blockPattern = /<((?:[\w.-]+:)?conditionalFormatting)\b([^>]*)>([\s\S]*?)<\/\1>/g;
  let match;
  while ((match = blockPattern.exec(text)) !== null) {
    const attrs = match[2] || '';
    const body = match[3] || '';
    let hasNumberFormat = /<(?:[\w.-]+:)?numFmt\b/.test(body);
    if (!hasNumberFormat) {
      const dxfIds = Array.from(body.matchAll(/\bdxfId\s*=\s*["'](\d+)["']/g)).map((item) => Number(item[1]));
      if (dxfIds.length) {
        if (numberFormatDxfIds === undefined) numberFormatDxfIds = readXlsxNumberFormatDxfIds(workbook);
        hasNumberFormat = numberFormatDxfIds === null || dxfIds.some((id) => numberFormatDxfIds.has(id));
      }
    }
    if (!hasNumberFormat) continue;
    const sqref = readXmlAttribute(attrs, 'sqref') || ((/<(?:[\w.-]+:)?sqref>([^<]*)<\//.exec(body) || [])[1]) || '';
    const refs = sqref.trim().split(/\s+/).filter(Boolean);
    if (!refs.length) {
      contentRowsWithin(sheet, range.s.r, range.e.r).forEach((r) => specials.markRowUnknown(r, '条件格式'));
      continue;
    }
    refs.forEach((ref) => {
      let decoded;
      try {
        decoded = XLSX.utils.decode_range(ref);
      } catch (_error) {
        decoded = range;
      }
      contentRowsWithin(sheet, Math.max(decoded.s.r, range.s.r), Math.min(decoded.e.r, range.e.r))
        .forEach((r) => specials.markRowUnknown(r, '条件格式'));
    });
  }
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
  // 与长数字还原同一判定（B133）：读取库可能按注释里的行取值，原文行与读到的行无法一一对应
  if (hasUnverifiableXmlMarkup(text)) {
    markAllRows('工作表原文含注释或非常规空白，无法核对');
    return;
  }
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
      source = { files, Directory: workbook.Directory, SheetNames: workbook.SheetNames };
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
  // 含注释掉的标签或标签内有制表符等写法时，读取库可能按注释里的行、单元格取值（与本模块取到的原文不是同一行），整张表不给
  //   原文（B133）。其余注释不含标签，按 XML 语义去掉后取原文（与 v3.2.21 相同；还原前仍核对原文与读取库的值相等）
  const rawText = xml.toString('utf8');
  if (hasUnverifiableXmlMarkup(rawText)) return null;
  const text = stripXmlComments(rawText);
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
function readWorkbookRowsUnchecked(filePath, { blankrows = false, sheetName, maxRows = 0, csvMaxSourceBytes, markErrorCells = false, exactSourceText = false } = {}) {
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
  const rawRows = readWorkbookRows(filePath, { blankrows: true, sheetName, readGuard, markErrorCells: includeFullRows, exactSourceText });
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
  openZipEntriesLazily
};
