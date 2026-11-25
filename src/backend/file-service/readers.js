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
const { decodeExcelStXstring } = require('../xlsx/excel-text');

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

// 注释、CDATA、处理指令按等长空白遮盖：按原文扫描元素时只用于定位（注释中的旧单元格、设置不算元素），需要原文时按位置切取。
//   读取侧与回填写出侧共用
function maskXmlMarkup(xml) {
  return String(xml).replace(/<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>/g, (text) => ' '.repeat(text.length));
}

// 按正则逐个替换元素：在遮盖注释、CDATA、处理指令后的视图中定位（注释中的 <table:table-cell>、<Cell> 不算元素，不会从注释
//   开始一直匹配到下一个真实单元格的结束标签），整段与各分组按位置从原文切取后交给 replacer（参数同 String#replace）。
//   pattern 须为全局正则（第三十二轮审查）
function replaceXmlElements(text, pattern, replacer) {
  const masked = maskXmlMarkup(text);
  const locate = new RegExp(pattern.source, pattern.flags.includes('d') ? pattern.flags : `${pattern.flags}d`);
  let output = '';
  let cursor = 0;
  let match;
  while ((match = locate.exec(masked)) !== null) {
    const [start, end] = match.indices[0];
    const groups = match.indices.slice(1).map((range) => (range ? text.slice(range[0], range[1]) : undefined));
    output += text.slice(cursor, start) + replacer(text.slice(start, end), ...groups);
    cursor = end;
    if (end === start) locate.lastIndex += 1;
  }
  return output + text.slice(cursor);
}

// 元素的字符数据：CDATA 段取原样内容，其余部分解码实体，注释与处理指令不算（第三十一轮审查）
function xmlCharacterData(raw) {
  const pattern = /<!\[CDATA\[([\s\S]*?)\]\]>|<!--[\s\S]*?-->|<\?[\s\S]*?\?>/g;
  let output = '';
  let cursor = 0;
  let match;
  while ((match = pattern.exec(raw)) !== null) {
    output += decodeXmlAttributeValue(raw.slice(cursor, match.index));
    if (match[1] !== undefined) output += match[1];
    cursor = match.index + match[0].length;
  }
  return output + decodeXmlAttributeValue(raw.slice(cursor));
}

// XML 开始标签（含自闭合）：属性值按引号边界读取（属性值中可有字面 `>`，如表名 `A > B`），第 1 组为属性部分。
//   读取侧与回填写出侧定位工作表、关系时共用
function xmlStartTagPattern(localName, flags = 'g') {
  return new RegExp(`<(?:[\\w.-]+:)?${localName}\\b((?:[^>"']|"[^"]*"|'[^']*')*)>`, flags);
}

// v3.2.21 第二十六轮：xlsx 的工作表声明（workbook.xml 的 <sheet>）与关系（*.rels 的 <Relationship>）只认生效的元素。读取库按全文
//   匹配（注释中的旧元素也算，同一 Id 后写的覆盖先写的），与 Excel 不一致：注释等标记中藏有这类元素、或生效的关系 Id 重复时，
//   读取库读到的工作表无法确认，由调用方拒绝
function xmlTagsHiddenInMarkup(xml, localName) {
  const text = Buffer.isBuffer(xml) ? xml.toString('utf8') : String(xml || '');
  const count = (source) => (source.match(xmlStartTagPattern(localName)) || []).length;
  return count(text) !== count(maskXmlMarkup(text));
}

// 生效的关系：Id → { type, target }；同一 Id 重复时返回 null
function parseXlsxRelationships(xml) {
  const text = maskXmlMarkup(Buffer.isBuffer(xml) ? xml.toString('utf8') : String(xml || ''));
  const relationships = new Map();
  for (const tag of text.match(xmlStartTagPattern('Relationship')) || []) {
    const id = readXmlAttribute(tag, 'Id');
    if (!id) continue;
    if (relationships.has(id)) return null;
    relationships.set(id, { type: readXmlAttribute(tag, 'Type') || '', target: readXmlAttribute(tag, 'Target') || '' });
  }
  return relationships;
}

function readXmlAttribute(tag, name) {
  const match = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`).exec(tag);
  return match ? decodeXmlAttributeValue(match[1] !== undefined ? match[1] : match[2]) : null;
}

// 文档中绑定到 namespace 的前缀（'p:'，默认命名空间为 ''）；rebound：其中某个前缀在文档中另被绑定到其他命名空间（局部重绑定，
//   不按位置解析时无法确定含义）。text 应为遮盖了注释、CDATA 与处理指令的视图
function namespacePrefixesOf(text, namespace) {
  const prefixes = new Set();
  const others = new Set();
  const declarationPattern = /\sxmlns(?::([\w.-]+))?\s*=\s*(["'])([\s\S]*?)\2/g;
  let declaration;
  while ((declaration = declarationPattern.exec(text))) {
    const prefix = declaration[1] ? `${declaration[1]}:` : '';
    if (decodeXmlAttributeValue(declaration[3]).trim() === namespace) prefixes.add(prefix);
    else others.add(prefix);
  }
  return { prefixes, rebound: Array.from(prefixes).some((prefix) => others.has(prefix)) };
}

// 按命名空间前缀读取属性（属性不继承默认命名空间：只认带前缀的写法）；同名属性在其他命名空间中的写法不论先后都不算
function namespacedAttributeOf(attributes, prefixes, localName) {
  const named = Array.from(prefixes).filter(Boolean);
  if (!named.length) return null;
  const match = new RegExp(`(?:^|\\s)(?:${named.map(escapeRegExpText).join('|')})${localName}\\s*=\\s*(["'])([\\s\\S]*?)\\1`).exec(attributes);
  return match ? match[2] : null;
}

const SPREADSHEETML_MAIN_NAMESPACE_URIS = Object.freeze([
  'http://schemas.openxmlformats.org/spreadsheetml/2006/main',
  'http://purl.oclc.org/ooxml/spreadsheetml/main'
]);

// v3.2.21 第二十五轮：xlsx 工作簿的日期系统按 workbook.xml 中根元素 workbook 的直接子元素 workbookPr（SpreadsheetML 主命名空间）
//   的 date1904 属性确定，与 Excel 一致：注释、CDATA、处理指令中的旧配置与扩展区（extLst）中其他命名空间的同名元素不算。
//   读取库按全文所有 workbookPr 依次覆盖（注释中的 date1904="1" 后接不带该属性的实际元素时读成 1904）。读取侧与回填写出侧共用。
//   返回 true / false；结构或命名空间无法确定（根元素不是主命名空间的 workbook、主命名空间的前缀被重绑定）时返回 null
//   第二十七轮：命名空间按位置解析——根元素的前缀按根元素自身的声明，直接子元素的前缀先看自身的声明、再看根元素的；更深层元素的
//   局部声明（扩展区中另声明默认命名空间等）不影响判断。返回 { namespace（根元素的命名空间）, date1904 }，无法确定时为 null
function xlsxWorkbookRootInfo(workbookXml) {
  const masked = maskXmlMarkup(Buffer.isBuffer(workbookXml) ? workbookXml.toString('utf8') : String(workbookXml || ''));
  const pattern = /<(\/?)((?:[\w.-]+:)?)([\w.-]+)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>/g;
  const root = pattern.exec(masked);
  if (!root || root[1] || root[3] !== 'workbook') return null;
  const declarationsOf = (attributes) => {
    const declarations = new Map();
    const declarationPattern = /(?:^|\s)xmlns(?::([\w.-]+))?\s*=\s*(["'])([\s\S]*?)\2/g;
    let declaration;
    while ((declaration = declarationPattern.exec(attributes))) {
      declarations.set(declaration[1] ? `${declaration[1]}:` : '', decodeXmlAttributeValue(declaration[3]).trim());
    }
    return declarations;
  };
  const rootDeclarations = declarationsOf(root[4]);
  const namespace = rootDeclarations.get(root[2]);
  if (!SPREADSHEETML_MAIN_NAMESPACE_URIS.includes(namespace)) return null;
  if (root[5]) return { namespace, date1904: false };
  let depth = 0;
  let tag;
  while ((tag = pattern.exec(masked))) {
    if (tag[1]) {
      if (depth === 0) break;
      depth -= 1;
      continue;
    }
    if (depth === 0 && tag[3] === 'workbookPr') {
      const own = declarationsOf(tag[4]);
      const childNamespace = own.has(tag[2]) ? own.get(tag[2]) : rootDeclarations.get(tag[2]);
      if (childNamespace === namespace) {
        // xsd:boolean（第三十二轮审查）：去掉首尾空白后 true / 1 为开、false / 0 为关；没有该属性按关；其他取值无法确定，
        //   为 null（读取与回填写出都拒绝，不静默按 1900）
        const value = readXmlAttribute(tag[4], 'date1904');
        if (value === null || value === undefined) return { namespace, date1904: false };
        const normalized = String(value).trim();
        if (normalized === 'true' || normalized === '1') return { namespace, date1904: true };
        return { namespace, date1904: normalized === 'false' || normalized === '0' ? false : null };
      }
    }
    if (!tag[5]) depth += 1;
  }
  return { namespace, date1904: false };
}

function xlsxWorkbookDate1904(workbookXml) {
  const info = xlsxWorkbookRootInfo(workbookXml);
  return info ? info.date1904 : null;
}

// 读取库按 bookFiles 保留的压缩包原文中的 workbook.xml；取不到时返回 null
function xlsxWorkbookXmlOf(workbook) {
  const directory = workbook && workbook.Directory;
  const workbookPath = directory && Array.isArray(directory.workbooks) && directory.workbooks[0];
  return workbookPath ? getZipEntryBuffer(workbook.files, workbookPath) : null;
}

// 工作簿结构是否无法确认（见 xmlTagsHiddenInMarkup）：workbook.xml 的注释等标记中藏有 <sheet>，或工作簿关系中藏有 <Relationship>、
//   生效的关系 Id 重复。取不到原文时返回 false（无从核对，沿用读取库）
function xlsxWorkbookStructureAmbiguous(workbook) {
  const directory = workbook && workbook.Directory;
  const workbookPath = directory && Array.isArray(directory.workbooks) && directory.workbooks[0];
  const workbookXml = workbookPath ? getZipEntryBuffer(workbook.files, workbookPath) : null;
  if (!workbookXml) return false;
  if (xmlTagsHiddenInMarkup(workbookXml, 'sheet')) return true;
  const workbookDir = String(workbookPath).replace(/^\/+/, '').split('/').slice(0, -1).join('/');
  const relsXml = getZipEntryBuffer(workbook.files, `${workbookDir ? `${workbookDir}/` : ''}_rels/${String(workbookPath).split('/').pop()}.rels`);
  if (!relsXml) return false;
  return xmlTagsHiddenInMarkup(relsXml, 'Relationship') || parseXlsxRelationships(relsXml) === null;
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

// v3.2.21：xlsx 中按 ISO 文本存的日期单元格（t="d"），读取库一律换算成 1900 日期系统的序号，且换算带本机时区偏差（上海
//   时区多出数十秒、圣保罗时区少一小段，序号带小数，字符串日期映射按无效值拒绝或取到前一天）；1904 工作簿中与同表按 1904
//   存储的日期序号口径也不同（按工作簿日期系统换算时会再加 1462 天，错移四年）。这里按工作表原文找出这类单元格（物理坐标），由
//   readRowsWithMetadata 只在映射取值中改成按原文换算的本工作簿日期系统的序号（保留时分秒；日期不存在时改为原文，按无效日期处理，
//   不取读取库滚入下月的值）；查重用的整行保持读取库原值（指纹与升级前一致）。只在调用方按工作簿日期系统换算日期时使用
//   （exactIsoDates，网银账单映射与跨 Sheet 回填），其他读取入口保持原结果。单元格省略 r 时按所在行与前一个单元格推出位置
//   （与读取库一致）。原文从已保留的压缩包（bookFiles）取，没有时只为取原文再读一次；取不到原文时保持读取库的结果。
const EXCEL_1904_DAY_OFFSET = 1462;
// ISO 日期文本按字面的年月日时分秒换算成日期序号（不经本机时区；时区后缀不参与换算），保留时间精度（按原值配对等
//   普通字段与读取库同一精度；日期字段取日期部分）：写法无法识别时 null；写法可识别但日期或时间不存在（如 2026-02-30）时 NaN
function isoTextToSerial(text, date1904 = false) {
  const source = String(text || '');
  // 整串校验：日期、可选的时分秒与小数秒、可选的时区后缀（Z、±hh、±hh:mm、±hhmm，小时 00–23、分钟 00–59；时区不参与
  //   换算）。开头是 ISO 日期但其后另有内容（2026-09-25Tbroken、2026-09-25T12:30:00oops）或时区超出范围（+02:60、+99:99）
  //   按无效日期处理，不取日期前缀。
//   v3.2.21 第二十四轮：月、日可为一位数，年月日之间可用 -、/ 或 .（三者择一、前后一致，如 2026/9/25），同样按日历校验；
//   其他写法（2026/02-30、Sep 25 2026 等）一律无效：原生日期单元格的原文不是可识别的日期时，读取库按 JavaScript Date 解析，
//   2026/02/30、2026-2-30 会滚入 3 月 2 日，不能以读取库恰好给出有限数值作为放行条件。空原文返回 null（由调用方决定）
  if (!source.trim()) return null;
  const match = /^\s*(\d{4})([-/.])(\d{1,2})\2(\d{1,2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?)?(?:Z|[+-](?:[01]\d|2[0-3])(?::?[0-5]\d)?)?\s*$/i
    .exec(source);
  if (!match) return NaN;
  // 去掉分隔符分组，其余分组下标与只认 ISO 写法时一致
  match.splice(2, 1);
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const [hour, minute, second] = [Number(match[4] || 0), Number(match[5] || 0), Number(match[6] || 0)];
  // 24:00:00（分、秒与小数秒都为零）是当日结束的合法写法，即次日零点（读取库同样读成次日）；其他超出范围的时间按不存在处理
  const endOfDay = hour === 24 && minute === 0 && second === 0 && !/[1-9]/.test(match[7] || '');
  if ((hour > 23 && !endOfDay) || minute > 59 || second > 59) return NaN;
  const dayTime = Date.UTC(year, month - 1, day);
  const date = new Date(dayTime);
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return NaN;
  // 小数秒截到毫秒（不四舍五入：23:59:59.9999 不能进位到次日）
  const milliseconds = match[7] ? Number(match[7].slice(0, 3).padEnd(3, '0')) : 0;
  const fraction = endOfDay ? 1 : (((hour * 60 + minute) * 60 + second) * 1000 + milliseconds) / 86400000;
  let days = (dayTime - Date.UTC(date1904 ? 1904 : 1899, date1904 ? 0 : 11, date1904 ? 1 : 30)) / 86400000;
  // 1900 日期系统把 1900-02-29 算作存在的日期，1900-03-01 之前的序号比实际天数少 1
  if (!date1904 && days < 61) days -= 1;
  return days + fraction;
}

// SpreadsheetML 2003（XML 格式的 .xls）按原文逐格扫描（v3.2.21 跨 Sheet 回填）。把要找的单元格临时改成带标记的文本后按同一读取库
//   再解析一次，由读取库给出与正式读取一致的坐标（含 ss:Index、合并区域的跳格）：
//   - formulas：没有缓存结果的公式单元格（<Cell ss:Formula="…"/>，没有 <Data> 或 <Data> 为空；读取库会整格丢弃、读成空白）
//     → formulaCells [{ r, c, cached: false }]，不当成可填的空格；
//   - isoDates：DateTime 单元格（读取库一律按 1900 日期系统换算成序号，带本机时区偏差；1904 工作簿中同表的数值日期却是 1904 序号）
//     → isoDateCells [{ r, c, text, serial }]，按原文与工作簿日期系统换算（见 isoTextToSerial），整表日期同一基准。
//   按 BOM / 字节特征识别 UTF-16 文件（UTF-8 与单字节编码按字节读，标记与 ISO 文本都是 ASCII），标记后按同一编码再解析。
//   返回 Map：sheet 名 → { formulaCells, isoDateCells }；sheetNames 为空时扫全部 sheet
const XLML_UNCACHED_FORMULA_MARK = '\u0001__uncached_formula__\u0001';
const XLML_DATETIME_MARK = '\u0001__datetime__\u0001';
// ODS 公式错误（标记后接错误文本，如 #DIV/0!）：读取时与没有缓存结果的公式同样处理；转换写出留档时按错误值写出
const ODS_FORMULA_ERROR_MARK = '\u0001__formula_error__\u0001';
// ODS 自闭合单元格（只有 office:value 等属性、没有显示文本）的原值标记：值类型 + 分隔符 + 原值
const ODS_SELF_CLOSING_VALUE_MARK = '\u0001__ods_value__\u0001';
// ODS 单元格的取值属性（office 命名空间）。其他命名空间中的同名属性（扩展属性 x:value 等）读取库按本地名处理、后写的覆盖先写的，
//   会读出扩展属性的值：有这类属性的单元格按 office 命名空间的属性改写原值
const ODS_VALUE_ATTRIBUTE_NAMES = Object.freeze(['value', 'date-value', 'time-value', 'boolean-value', 'string-value']);
function decodeXmlWorkbookBuffer(buffer) {
  const swapped = (bytes) => {
    const copy = Buffer.from(bytes.subarray(0, bytes.length - (bytes.length % 2)));
    return copy.swap16();
  };
  if (buffer.length >= 2 && buffer[0] === 0xFF && buffer[1] === 0xFE) return { text: buffer.subarray(2).toString('utf16le'), utf16: true };
  if (buffer.length >= 2 && buffer[0] === 0xFE && buffer[1] === 0xFF) return { text: swapped(buffer.subarray(2)).toString('utf16le'), utf16: true };
  if (buffer.length >= 2 && buffer[0] === 0x3C && buffer[1] === 0x00) return { text: buffer.toString('utf16le'), utf16: true };
  if (buffer.length >= 2 && buffer[0] === 0x00 && buffer[1] === 0x3C) return { text: swapped(buffer).toString('utf16le'), utf16: true };
  return { text: buffer.toString('latin1'), utf16: false };
}

// SpreadsheetML 2003 自闭合的合并单元格（<Cell ss:MergeAcross="1"/>，Excel 导出空的合并格的常见写法）：读取库只把列号加一、
//   不按合并跨度定位后续单元格（同一行后面没写 ss:Index 的单元格整体左移），也不记入 !merges。读取前改写成成对的起止标签，
//   读取库即按跨度定位、记下合并范围（v3.2.21 第三十轮审查）。读这类文件的各处（主读取、原文扫描、转换写出）都按同一改写，
//   坐标一致（查重不按原文核对 SpreadsheetML，见 markTextSourceCells）。注释等标记中的不改；没有这类单元格时返回 null
function normalizeXlmlMergedCellsText(text) {
  if (!/Merge(?:Across|Down)/.test(text)) return null;
  const masked = maskXmlMarkup(text);
  const pattern = /<((?:[\w.-]+:)?)Cell\b((?:[^>"']|"[^"]*"|'[^']*')*?)\/>/g;
  let output = '';
  let cursor = 0;
  let match;
  while ((match = pattern.exec(masked))) {
    if (!/(?:^|\s)(?:[\w.-]+:)?Merge(?:Across|Down)\s*=/.test(match[2])) continue;
    const original = text.slice(match.index, match.index + match[0].length);
    output += `${text.slice(cursor, match.index)}${original.slice(0, -2)}></${match[1]}Cell>`;
    cursor = match.index + match[0].length;
  }
  return cursor === 0 ? null : output + text.slice(cursor);
}

// 文本容器的工作簿内容按上面的改写重新编码（UTF-16 带 BOM，其他按原字节）；不需要改写时返回 null
function normalizeXlmlWorkbookBuffer(buffer) {
  if (!Buffer.isBuffer(buffer)) return null;
  const { text, utf16 } = decodeXmlWorkbookBuffer(buffer);
  const normalized = normalizeXlmlMergedCellsText(text);
  if (normalized === null) return null;
  return utf16 ? Buffer.concat([Buffer.from([0xFF, 0xFE]), Buffer.from(normalized, 'utf16le')]) : Buffer.from(normalized, 'latin1');
}

// ODS（content.xml 或平面 OpenDocument 正文）中读取库处理不了坐标的写法，读取前改写（第三十三轮审查；主读取、原文扫描与
//   转换写出同一改写，坐标一致）：
//   - 被合并覆盖的单元格（table:covered-table-cell）：读取库不论 number-columns-repeated 都只前进一列，后面的单元格整体左移。
//     改写成只带重复计数的空单元格（覆盖格的内容在表格软件中本就不显示，合并范围由左上角的格声明）；
//   - 自闭合的行（<table:table-row table:number-rows-repeated="3"/>）：读取库在结束标签处推进行号，自闭合的行不推进，后面的行
//     整体上移。改写成成对的起止标签。
//   在遮盖注释等标记后的视图中定位；没有可改写的返回 null
function normalizeOdsContentText(text) {
  let changed = false;
  const coveredPattern = /<((?:[\w.-]+:)?)covered-table-cell(?=[\s/>])((?:[^>"']|"[^"]*"|'[^']*')*?)(?:\/>|>[\s\S]*?<\/\1covered-table-cell>)/g;
  let output = replaceXmlElements(String(text), coveredPattern, (_whole, prefix, attributes) => {
    changed = true;
    const repeat = /(?:^|\s)((?:[\w.-]+:)?number-columns-repeated\s*=\s*(["'])[\s\S]*?\2)/.exec(attributes || '');
    return `<${prefix}table-cell${repeat ? ` ${repeat[1]}` : ''}/>`;
  });
  output = replaceXmlElements(output, /<((?:[\w.-]+:)?)table-row(?=[\s/>])((?:[^>"']|"[^"]*"|'[^']*')*?)\/>/g, (_whole, prefix, attributes) => {
    changed = true;
    return `<${prefix}table-row${attributes}></${prefix}table-row>`;
  });
  return changed ? output : null;
}

// ODS 按 normalizeOdsContentText 改写后的工作簿内容（ZIP 或平面 OpenDocument，供读取库读取）；不需要改写时返回 null。
//   odsContent 为 loadOdsContent 的结果（不改动其内容）
function odsWorkbookBuffer(odsContent) {
  if (!odsContent || typeof odsContent.text !== 'string') return null;
  const normalized = normalizeOdsContentText(odsContent.text);
  if (normalized === null) return null;
  if (odsContent.flat) return Buffer.from(normalized, 'utf8');
  const originalContent = odsContent.entry.content;
  try {
    odsContent.entry.content = Buffer.from(normalized, 'utf8');
    return XLSX.CFB.write(odsContent.container, { type: 'buffer', fileType: 'zip' });
  } finally {
    odsContent.entry.content = originalContent;
  }
}

// 共享字符串表中实际生效的各项 <si> 的内容原文：在遮盖注释、CDATA、处理指令后的视图中定位（注释中的旧条目不计入下标，与表格
//   软件一致），按位置从原文切取。读取侧与回填写出侧共用（第三十五轮审查）
function sharedStringItemSources(text) {
  const source = String(text || '');
  const masked = maskXmlMarkup(source);
  const pattern = /<(?:[\w.-]+:)?si\b[^>]*?(?:\/>|>([\s\S]*?)<\/(?:[\w.-]+:)?si>)/gd;
  const items = [];
  let match;
  while ((match = pattern.exec(masked)) !== null) {
    items.push(match.indices[1] ? source.slice(match.indices[1][0], match.indices[1][1]) : '');
  }
  return items;
}

// xlsx 共享字符串表原文中读取库算错下标的写法，读取前改写（第三十五、三十六轮审查）：读取库按原文找 <si>、按 </si> 切分条目——
//   注释、处理指令中的旧条目也计入下标，自闭合的空条目（<si/>）不占下标，其后引用共享字符串的单元格整体错位（引用 ORIGINAL 的格
//   读成注释中的空白、日期读成下一行的日期）。去掉注释与处理指令（CDATA 保留），自闭合的空条目展开成成对的空文本条目；
//   没有可改写的返回 null
function normalizeXlsxSharedStringsText(text) {
  let changed = false;
  const stripped = String(text).replace(/<!\[CDATA\[[\s\S]*?\]\]>|<!--[\s\S]*?-->|<\?[\s\S]*?\?>/g, (markup) => {
    if (markup.startsWith('<![CDATA[') || /^<\?xml[\s?]/i.test(markup)) return markup;
    changed = true;
    return '';
  });
  const expanded = replaceXmlElements(stripped, /<((?:[\w.-]+:)?)si(?=[\s/>])((?:[^>"']|"[^"]*"|'[^']*')*?)\/>/g, (_whole, prefix, attributes) => {
    changed = true;
    return `<${prefix}si${attributes}><${prefix}t></${prefix}t></${prefix}si>`;
  });
  return changed ? expanded : null;
}

const XLSX_SHARED_STRINGS_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml';

// ZIP 工作簿内容中的共享字符串表按 normalizeXlsxSharedStringsText 改写后的整份内容，供读取库读取；表的位置按
//   [Content_Types].xml 中共享字符串表的类型（与读取库一致）。不需要改写或无法确认时返回 null。读取侧与转换写出侧共用
function normalizeXlsxSharedStringsBuffer(buffer) {
  let container;
  try {
    container = XLSX.CFB.read(buffer, { type: 'buffer' });
  } catch (_error) {
    return null;
  }
  const types = XLSX.CFB.find(container, '/[Content_Types].xml');
  if (!types || !types.content) return null;
  const override = (maskXmlMarkup(Buffer.from(types.content).toString('utf8')).match(xmlStartTagPattern('Override')) || [])
    .find((tag) => String(readXmlAttribute(tag, 'ContentType') || '').trim() === XLSX_SHARED_STRINGS_CONTENT_TYPE);
  const partName = override ? readXmlAttribute(override, 'PartName') : null;
  const entry = partName ? XLSX.CFB.find(container, `/${partName.replace(/^\/+/, '')}`) : null;
  if (!entry || !entry.content) return null;
  const normalized = normalizeXlsxSharedStringsText(Buffer.from(entry.content).toString('utf8'));
  if (normalized === null) return null;
  entry.content = Buffer.from(normalized, 'utf8');
  return XLSX.CFB.write(container, { type: 'buffer', fileType: 'zip' });
}

// 已读入（保留压缩包原文）的工作簿的共享字符串表是否需要按 normalizeXlsxSharedStringsText 改写（只在需要时整份重读）
function xlsxSharedStringsNeedNormalizing(workbook) {
  const sstPath = workbook && workbook.Directory && typeof workbook.Directory.sst === 'string' ? workbook.Directory.sst : '';
  const sstXml = sstPath && workbook.files ? getZipEntryBuffer(workbook.files, sstPath) : null;
  return Boolean(sstXml) && normalizeXlsxSharedStringsText(sstXml.toString('utf8')) !== null;
}

// 读取工作簿文件（读取库）：已载入的 ODS 按 odsWorkbookBuffer 改写，其他文本容器按 normalizeXlmlWorkbookBuffer 改写，xlsx 共享
//   字符串表需要改写时（见 normalizeXlsxSharedStringsText；只在保留了压缩包原文时能核对）按 normalizeXlsxSharedStringsBuffer 重读
function readSpreadsheetFile(filePath, options, container = detectWorkbookContainer(filePath), odsContent = null) {
  if (odsContent) {
    const normalized = odsWorkbookBuffer(odsContent);
    return normalized ? XLSX.read(normalized, { ...options, type: 'buffer' }) : XLSX.readFile(filePath, options);
  }
  if (container === 'text') {
    const normalized = normalizeXlmlWorkbookBuffer(fs.readFileSync(filePath));
    if (normalized) return XLSX.read(normalized, { ...options, type: 'buffer' });
  }
  const workbook = XLSX.readFile(filePath, options);
  const normalized = container === 'zip' && options && options.bookFiles && xlsxSharedStringsNeedNormalizing(workbook)
    ? normalizeXlsxSharedStringsBuffer(fs.readFileSync(filePath))
    : null;
  return normalized ? XLSX.read(normalized, { ...options, type: 'buffer' }) : workbook;
}

function scanXlmlWorkbookCells(source, { sheetNames = null, formulas = false, isoDates = false, date1904 = false } = {}) {
  const found = new Map();
  if (!formulas && !isoDates) return found;
  let buffer;
  try {
    buffer = Buffer.isBuffer(source) ? source : fs.readFileSync(source);
  } catch (_error) {
    return found;
  }
  const decoded = decodeXmlWorkbookBuffer(buffer);
  const { utf16 } = decoded;
  // 与主读取同一改写（自闭合合并单元格），标记后再解析的坐标与主读取一致
  const text = normalizeXlmlMergedCellsText(decoded.text) || decoded.text;
  if (!(formulas && /Formula\s*=/.test(text)) && !(isoDates && /DateTime/.test(text))) return found;
  const cellPattern = /<((?:[\w.-]+:)?)Cell\b((?:[^>"']|"[^"]*"|'[^']*')*?)(\/>|>([\s\S]*?)<\/\1Cell>)/g;
  const dataPattern = /<((?:[\w.-]+:)?)Data\b((?:[^>"']|"[^"]*"|'[^']*')*?)(?:\/>|>([\s\S]*?)<\/\1Data>)/;
  const typePattern = /((?:^|\s)(?:[\w.-]+:)?Type\s*=\s*)(["'])DateTime\2/;
  let changed = false;
  // 单元格自身的 Data（缓存结果）：批注（Comment）中的 Data 与 XML 注释不算（第三十轮审查：带批注的无缓存公式原先被当成有缓存）
  const directDataOf = (body) => {
    const source = String(body || '');
    const hidden = maskXmlMarkup(source)
      .replace(/<((?:[\w.-]+:)?)Comment\b(?:[^>"']|"[^"]*"|'[^']*')*?(?:\/>|>[\s\S]*?<\/\1Comment>)/g, (comment) => ' '.repeat(comment.length));
    const located = dataPattern.exec(hidden);
    return located ? dataPattern.exec(source.slice(located.index, located.index + located[0].length)) : null;
  };
  const marked = replaceXmlElements(text, cellPattern, (whole, prefix, attributes, _end, body) => {
    const dataMatch = directDataOf(body);
    // 缓存结果按 XML 字符数据判断：只有 XML 注释的 Data（<Data ss:Type="Number"><!-- none --></Data>）不算缓存，按没有缓存结果的
    //   公式处理，不读成 0 / false 参与配对；CDATA 取原样内容（第三十四轮审查）
    const cachedText = dataMatch ? xmlCharacterData(String(dataMatch[3] || '')).trim() : '';
    const hasCachedValue = cachedText !== '';
    if (formulas && !hasCachedValue && /(?:^|\s)(?:[\w.-]+:)?Formula\s*=/.test(attributes)) {
      changed = true;
      const rest = dataMatch ? String(body).replace(dataMatch[0], '') : (body || '');
      return `<${prefix}Cell${attributes}><${prefix}Data ${prefix}Type="String">${XLML_UNCACHED_FORMULA_MARK}</${prefix}Data>${rest}</${prefix}Cell>`;
    }
    if (isoDates && hasCachedValue && typePattern.test(dataMatch[2])) {
      changed = true;
      const dataAttributes = dataMatch[2].replace(typePattern, '$1$2String$2');
      const markedText = cachedText.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      const replaced = `<${dataMatch[1]}Data${dataAttributes}>${XLML_DATETIME_MARK}${markedText}</${dataMatch[1]}Data>`;
      return whole.replace(dataMatch[0], replaced);
    }
    return whole;
  });
  if (!changed) return found;
  let workbook;
  try {
    const markedBuffer = utf16
      ? Buffer.concat([Buffer.from([0xFF, 0xFE]), Buffer.from(marked, 'utf16le')])
      : Buffer.from(marked, 'latin1');
    workbook = XLSX.read(markedBuffer, { type: 'buffer', cellDates: false, dense: false, ...(sheetNames ? { sheets: sheetNames } : {}) });
  } catch (_error) {
    return found;
  }
  return collectMarkedWorkbookCells(workbook, sheetNames, date1904);
}

// ODS 自闭合单元格按值类型还原（与读取库读有显示文本的同类单元格一致）：数值类（float、percentage、currency）取 office:value，
//   布尔取 office:boolean-value（xsd:boolean：true / false / 1 / 0），时间取 office:time-value（ISO 8601 时长，可带天数：
//   PT12H30M → 0.5208…，P1DT2H → 1.0833…，按天的比例；年、月无法换算），文本取 office:string-value；
//   原值无法识别时为无效数值（不当成空单元格）
// 单元格内容中最后一个批注（office:annotation）之后的部分：批注不是单元格的值，读取库在批注的起止处清空已读的文字（ODF 中批注
//   本应在段落之前），只取其后的段落（第三十四轮审查）。在遮盖注释等标记后的视图中定位
function odsCellBody(inner) {
  const source = String(inner || '');
  const masked = maskXmlMarkup(source);
  const pattern = /<((?:[\w.-]+:)?)annotation(?=[\s/>])(?:[^>"']|"[^"]*"|'[^']*')*?(?:\/>|>[\s\S]*?<\/\1annotation>)/g;
  let end = 0;
  let match;
  while ((match = pattern.exec(masked))) end = match.index + match[0].length;
  return source.slice(end);
}

// ODS 各值类型的取值属性（公式的缓存结果）
const ODS_TYPED_VALUE_ATTRIBUTES = Object.freeze({
  float: 'value', percentage: 'value', currency: 'value', date: 'date-value', time: 'time-value', boolean: 'boolean-value'
});

// 一格中 text:s 展开的空格累计上限：Excel 单元格的字符上限，超过时拒绝导入（不截短，截短会把不同的原值读成同一个配对键）
const ODS_CELL_TEXT_SPACE_LIMIT = 32767;

// 文本单元格的显示文本（没有 office:string-value 时读取库读到的值）：与读取库同一口径，只是不解码 _xHHHH_（第三十四轮审查）——
//   批注不算（见 odsCellBody）；各段落（text:p；自闭合的段落、text:h 读取库不计）的原文先把制表符、换行各按一个空格，
//   去首尾空白、连续空格合并为一个，再展开 text:s（按 text:c 个空格）、text:tab、text:line-break，去掉其余标记后解码字符引用；
//   段落之间换行（前面还没有文字时不换行）。段落在遮盖注释等标记后的视图中定位
function odsCellText(inner) {
  const source = odsCellBody(inner);
  const masked = maskXmlMarkup(source);
  const paragraphPattern = /<((?:[\w.-]+:)?)p(?=[\s/>])(?:[^>"']|"[^"]*"|'[^']*')*?(?:\/>|>([\s\S]*?)<\/\1p>)/gd;
  let spaces = 0;
  let text = '';
  let match;
  while ((match = paragraphPattern.exec(masked))) {
    if (!match.indices[2]) continue;
    const paragraph = source.slice(match.indices[2][0], match.indices[2][1])
      // CDATA 是字符数据，按原样保留（转成实体，随后与其余文字一同解码）；注释、处理指令不算（第三十六轮审查）
      .replace(/<!\[CDATA\[([\s\S]*?)\]\]>|<!--[\s\S]*?-->|<\?[\s\S]*?\?>/g, (_markup, cdata) => (cdata === undefined ? ''
        : cdata.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')))
      .replace(/[\t\r\n]/g, ' ').trim().replace(/ +/g, ' ')
      .replace(/<(?:[\w.-]+:)?s\b((?:[^>"']|"[^"]*"|'[^']*')*?)\/?>/g, (_whole, attributes) => {
        const count = Number(xmlAttributeOf(attributes, 'c'));
        const width = Number.isSafeInteger(count) && count > 0 ? count : 1;
        spaces += width;
        if (spaces > ODS_CELL_TEXT_SPACE_LIMIT) {
          throw new FileValidationError('FILE_READ', `ODS 单元格中的空格超过 ${ODS_CELL_TEXT_SPACE_LIMIT} 个（Excel 单元格的字符上限），无法读取，请检查文件后重新导入`);
        }
        return ' '.repeat(width);
      })
      .replace(/<(?:[\w.-]+:)?tab\b[^>]*>/g, '\t')
      .replace(/<(?:[\w.-]+:)?line-break\b[^>]*>/g, '\n')
      .replace(/<[^>]*>/g, '');
    text = `${text.length > 0 ? `${text}\n` : ''}${decodeXmlAttributeValue(paragraph)}`;
  }
  return text;
}

function odsTypedValue(valueType, raw) {
  const text = String(raw).trim();
  if (valueType === 'float' || valueType === 'percentage' || valueType === 'currency') {
    return /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(text) ? Number(text) : Number.NaN;
  }
  if (valueType === 'boolean') {
    if (text === 'true' || text === '1') return true;
    return text === 'false' || text === '0' ? false : Number.NaN;
  }
  if (valueType === 'time') {
    const match = /^(-)?P(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(text);
    // 至少一个分量；写了 T 时至少一个时间分量（P、PT、P1DT 无效）
    if (!match || !match.slice(2).some((part) => part !== undefined) || (/T$/.test(text))) return Number.NaN;
    const seconds = Number(match[2] || 0) * 86400 + Number(match[3] || 0) * 3600 + Number(match[4] || 0) * 60 + Number(match[5] || 0);
    return (match[1] ? -1 : 1) * seconds / 86400;
  }
  return String(raw);
}

// ODS 自闭合单元格（只有 office:date-value / office:value 等属性、没有显示文本）读取库不创建（读成空）：按原文扫描结果补回
//   读取库没有读出的格，已有值的格不动。日期补按原文换算的序号（无效日期补无效数值），其他类型按 odsTypedValue。
//   dateFormat：补回日期时带的数字格式（转换写出用）。读取侧（dense 工作表）与回填写出侧（普通工作表）共用，返回是否补回了单元格
//   第二十五轮：读取库读出了值、却没有把该格计入工作表范围（表尾整行都是只写在属性上的文本格时，读取库创建了单元格，范围仍停在
//   前面），按扫描结果扩展范围，否则读取与转换写出都会漏掉这些行。值类单元格（valueCells）按 office 属性的原值改写已有的格
//   （外来命名空间的同名属性让读取库读错时以标准属性为准），日期单元格只补读取库没有读出的格
function restoreOdsSelfClosingCells(sheet, { isoDateCells = [], valueCells = [] } = {}, { dateFormat = null } = {}) {
  let restored = false;
  // dense 工作表：本版 SheetJS 为 sheet[r][c]（sheet 本身是数组），新版为 sheet['!data'][r][c]
  const denseRows = Array.isArray(sheet) ? sheet : (Array.isArray(sheet['!data']) ? sheet['!data'] : null);
  const extendRange = (r, c) => {
    const range = sheet['!ref'] ? XLSX.utils.decode_range(sheet['!ref']) : { s: { r, c }, e: { r, c } };
    if (sheet['!ref'] && r >= range.s.r && r <= range.e.r && c >= range.s.c && c <= range.e.c) return;
    range.s.r = Math.min(range.s.r, r);
    range.s.c = Math.min(range.s.c, c);
    range.e.r = Math.max(range.e.r, r);
    range.e.c = Math.max(range.e.c, c);
    sheet['!ref'] = XLSX.utils.encode_range(range);
    restored = true;
  };
  // overwrite：已有值时是否按扫描结果改写（true 或按已有单元格判断的函数）
  const put = (r, c, cell, { overwrite = false } = {}) => {
    const address = XLSX.utils.encode_cell({ r, c });
    const existing = denseRows ? (denseRows[r] || [])[c] : sheet[address];
    extendRange(r, c);
    const hasValue = existing && existing.t !== 'z' && existing.v !== undefined && existing.v !== null && existing.v !== '';
    if (hasValue && !(typeof overwrite === 'function' ? overwrite(existing) : overwrite)) return;
    if (hasValue) {
      if (existing.t === cell.t && Object.is(existing.v, cell.v)) return;
      // 保留读取库给出的数字格式等，只换类型与值（显示文本按新值重新生成）
      existing.t = cell.t;
      existing.v = cell.v;
      if (cell.z && !existing.z) existing.z = cell.z;
      delete existing.w;
      restored = true;
      return;
    }
    if (denseRows) {
      if (!denseRows[r]) denseRows[r] = [];
      denseRows[r][c] = cell;
    } else {
      sheet[address] = cell;
    }
    restored = true;
  };
  // 日期单元格：读取库读成数值的（带时区偏差）由调用方按原文换算；读成文本等其他类型的（扩展命名空间的 value-type="string"
  //   写在后面时读取库按文本读出显示文字）按标准日期属性纠正（第二十六轮）
  isoDateCells.forEach(({ r, c, text, serial }) => {
    if (!text) return;
    put(r, c, Number.isFinite(serial)
      ? { t: 'n', v: serial, ...(dateFormat ? { z: dateFormat } : {}) }
      : { t: 'n', v: Number.NaN }, { overwrite: (existing) => existing.t !== 'n' });
  });
  valueCells.forEach(({ r, c, value }) => {
    if (typeof value === 'number') put(r, c, { t: 'n', v: value }, { overwrite: true });
    else if (typeof value === 'boolean') put(r, c, { t: 'b', v: value }, { overwrite: true });
    else put(r, c, { t: 's', v: String(value) }, { overwrite: true });
  });
  return restored;
}

// 按标记文本收集再解析后的单元格坐标（SpreadsheetML 2003 与 ODS 共用）
function collectMarkedWorkbookCells(workbook, sheetNames, date1904, markedValues = []) {
  const found = new Map();
  (sheetNames || workbook.SheetNames).forEach((name) => {
    const sheet = workbook.Sheets[name];
    if (!sheet) return;
    const entry = { formulaCells: [], isoDateCells: [], errorCells: [], valueCells: [], mergeRanges: [] };
    Object.keys(sheet).forEach((address) => {
      if (address[0] === '!') return;
      const value = sheet[address] && sheet[address].v;
      if (typeof value !== 'string') return;
      if (value === XLML_UNCACHED_FORMULA_MARK) {
        entry.formulaCells.push({ ...XLSX.utils.decode_cell(address), cached: false });
        // SpreadsheetML 没有缓存结果的数组公式（ss:ArrayRange）：读取库丢弃锚点、不记范围；标记后重新解析的锚点带范围，
        //   补作不能单独填写的区域（第三十一轮审查）
        if (typeof sheet[address].F === 'string' && sheet[address].F) {
          try {
            entry.mergeRanges.push(XLSX.utils.decode_range(sheet[address].F));
          } catch (_error) { /* 范围无法解析时只记该格 */ }
        }
      } else if (value.startsWith(ODS_FORMULA_ERROR_MARK)) {
        const cell = XLSX.utils.decode_cell(address);
        entry.formulaCells.push({ ...cell, cached: false });
        entry.errorCells.push({ ...cell, text: value.slice(ODS_FORMULA_ERROR_MARK.length) });
      } else if (value.startsWith(XLML_DATETIME_MARK)) {
        const isoText = value.slice(XLML_DATETIME_MARK.length);
        entry.isoDateCells.push({ ...XLSX.utils.decode_cell(address), text: isoText, serial: isoTextToSerial(isoText, date1904) });
      } else if (value.startsWith(ODS_SELF_CLOSING_VALUE_MARK)) {
        // 标记只带序号（只定位坐标），原值取自扫描时记下的属性原文：文本不经读取库的段落空白归一化（REF  123 不折成 REF 123）
        const marked = markedValues[Number(value.slice(ODS_SELF_CLOSING_VALUE_MARK.length))];
        const cell = XLSX.utils.decode_cell(address);
        if (marked && marked.formula) {
          entry.formulaCells.push({ ...cell, cached: false });
          if (typeof marked.errorText === 'string') entry.errorCells.push({ ...cell, text: marked.errorText });
        } else if (marked && marked.valueType === 'date') {
          entry.isoDateCells.push({ ...cell, text: marked.text, serial: isoTextToSerial(marked.text, date1904) });
        } else if (marked && marked.valueType) {
          entry.valueCells.push({ ...cell, value: odsTypedValue(marked.valueType, marked.text) });
        }
        // 合并范围与数组公式范围（读取库未记下的）：按标记位置补出，供不可单独填写的判定使用
        (marked && marked.spans ? marked.spans : []).forEach((span) => {
          entry.mergeRanges.push({ s: cell, e: { r: cell.r + span.rows - 1, c: cell.c + span.columns - 1 } });
        });
      }
    });
    found.set(name, entry);
  });
  return found;
}

// 内容是否为 OpenDocument 表格（ODS，含扩展名为 .xls / .xlsx 的）：按规范 ZIP 的第一个条目是不压缩的 mimetype
// ZIP 格式的 ODS：先按容器签名确认是 ZIP，再看开头的 mimetype（平面 OpenDocument 的根元素属性中也可能出现该 MIME 字符串）
//   第二十六轮：开头没有明文 mimetype（重新压缩过的 ODS）时按 ZIP 中央目录的条目名识别，与读取库判定 ODS 的依据一致
//   （有 META-INF/manifest.xml 或 objectdata.xml 即按 ODS 解析），不因开头特征未命中就按 xlsx 处理、跳过 ODS 原文校正
function isOdsBuffer(buffer) {
  if (!(Buffer.isBuffer(buffer) && buffer.length >= 4 && buffer[0] === 0x50 && buffer[1] === 0x4B && buffer[2] === 0x03 && buffer[3] === 0x04)) {
    return false;
  }
  if (buffer.subarray(0, 512).toString('latin1').includes('application/vnd.oasis.opendocument.spreadsheet')) return true;
  const names = zipEntryNames((offset, length) => buffer.subarray(offset, offset + length), buffer.length);
  return Boolean(names && names.some(isOdsMarkerEntry));
}

function isOdsMarkerEntry(name) {
  const normalized = String(name).replace(/\\/g, '/').replace(/^\/+/, '').toLowerCase();
  return normalized === 'meta-inf/manifest.xml' || normalized === 'objectdata.xml';
}

// ZIP 中央目录中的条目名（支持 ZIP64）；readAt(offset, length) 返回该段字节。结构无法识别时返回 null
function zipEntryNames(readAt, size) {
  const tailLength = Math.min(size, 65557);
  const tail = readAt(size - tailLength, tailLength);
  let eocd = -1;
  for (let index = tail.length - 22; index >= 0; index -= 1) {
    if (tail.readUInt32LE(index) === 0x06054b50) {
      eocd = index;
      break;
    }
  }
  if (eocd < 0) return null;
  let entryCount = tail.readUInt16LE(eocd + 10);
  let directorySize = tail.readUInt32LE(eocd + 12);
  let directoryOffset = tail.readUInt32LE(eocd + 16);
  if (directoryOffset === 0xFFFFFFFF || directorySize === 0xFFFFFFFF || entryCount === 0xFFFF) {
    const locator = eocd - 20;
    if (locator < 0 || tail.readUInt32LE(locator) !== 0x07064b50) return null;
    const zip64Offset = Number(tail.readBigUInt64LE(locator + 8));
    const zip64 = readAt(zip64Offset, 56);
    if (zip64.length < 56 || zip64.readUInt32LE(0) !== 0x06064b50) return null;
    entryCount = Number(zip64.readBigUInt64LE(32));
    directorySize = Number(zip64.readBigUInt64LE(40));
    directoryOffset = Number(zip64.readBigUInt64LE(48));
  }
  if (directoryOffset + directorySize > size || directorySize > 64 * 1024 * 1024) return null;
  const directory = readAt(directoryOffset, directorySize);
  const names = [];
  let cursor = 0;
  while (cursor + 46 <= directory.length && directory.readUInt32LE(cursor) === 0x02014b50 && names.length < entryCount) {
    const nameLength = directory.readUInt16LE(cursor + 28);
    const extraLength = directory.readUInt16LE(cursor + 30);
    const commentLength = directory.readUInt16LE(cursor + 32);
    names.push(directory.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8'));
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return names;
}

// 文本格式工作簿的字节按编码解码：UTF-8（可带 BOM）、UTF-16LE / BE（带 BOM，或 XML 开头 `<` 两字节中有一个 0 字节）
function decodeTextBuffer(buffer) {
  if (buffer.length >= 2 && buffer[0] === 0xFF && buffer[1] === 0xFE) return buffer.subarray(2).toString('utf16le');
  if (buffer.length >= 2 && buffer[0] === 0xFE && buffer[1] === 0xFF) return swapUtf16(buffer.subarray(2)).toString('utf16le');
  if (buffer.length >= 2 && buffer[0] === 0x3C && buffer[1] === 0x00) return buffer.toString('utf16le');
  if (buffer.length >= 2 && buffer[0] === 0x00 && buffer[1] === 0x3C) return swapUtf16(buffer).toString('utf16le');
  return buffer.toString('utf8').replace(/^\uFEFF/, '');
}

function swapUtf16(buffer) {
  const copy = Buffer.from(buffer.subarray(0, buffer.length - (buffer.length % 2)));
  return copy.swap16();
}

// 去掉 XML 开头的空白、声明与注释，返回从根元素开始的文本
function skipXmlProlog(text) {
  let rest = text;
  for (;;) {
    const next = rest.replace(/^\s+/, '').replace(/^<\?[\s\S]*?\?>/, '').replace(/^<!--[\s\S]*?-->/, '').replace(/^<!DOCTYPE[^>]*>/i, '');
    if (next === rest) return rest;
    rest = next;
  }
}

// 文本格式工作簿开头的根元素本地名（小写）与属性；不是 XML / HTML 开头时为 null。只解码开头一段，根开始标签在其中没有结束时
//   再解码整个文件
function readTextRootElement(buffer) {
  const rootPattern = /^<([\w.:-]+)((?:[^>"']|"[^"]*"|'[^']*')*)>/;
  const headLength = 65536;
  let rest = skipXmlProlog(decodeTextBuffer(buffer.subarray(0, headLength)));
  let root = rootPattern.exec(rest);
  if (!root && buffer.length > headLength && rest.startsWith('<')) {
    rest = skipXmlProlog(decodeTextBuffer(buffer));
    root = rootPattern.exec(rest);
  }
  if (!root) return rest.startsWith('<') ? { name: '', attributes: '' } : null;
  return { name: root[1].split(':').pop().toLowerCase(), attributes: root[2] };
}

function isOdsFile(filePath) {
  let handle = null;
  try {
    handle = fs.openSync(filePath, 'r');
    const head = Buffer.alloc(512);
    const length = fs.readSync(handle, head, 0, head.length, 0);
    if (isOdsBuffer(head.subarray(0, length))) return true;
    if (length < 4 || head[0] !== 0x50 || head[1] !== 0x4B || head[2] !== 0x03 || head[3] !== 0x04) return false;
    const fd = handle;
    const size = fs.fstatSync(fd).size;
    const names = zipEntryNames((offset, count) => {
      const chunk = Buffer.alloc(Math.max(0, Math.min(count, size - offset)));
      const read = fs.readSync(fd, chunk, 0, chunk.length, offset);
      return chunk.subarray(0, read);
    }, size);
    return Boolean(names && names.some(isOdsMarkerEntry));
  } catch (_error) {
    return false;
  } finally {
    if (handle !== null) fs.closeSync(handle);
  }
}

function xmlAttributeOf(attributes, name) {
  const match = new RegExp(`(?:^|\\s)(?:[\\w.-]+:)?${name}\\s*=\\s*(["'])([\\s\\S]*?)\\1`).exec(attributes);
  return match ? match[2] : null;
}

// XML 字符引用与预定义实体单遍解码：&#38;amp; 解码为字面的 &amp;，不再二次解码为 &（与读取库一致）。读取侧与回填写出侧的
//   属性、文本统一用此函数（原先逐个实体依次替换的写法先解出 &、再把它与后面的 amp; 当成实体，第三十四轮审查）
function decodeXmlAttributeValue(value) {
  return String(value).replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (whole, entity) => {
    const lower = entity.toLowerCase();
    if (lower[0] === '#') {
      const code = lower[1] === 'x' ? parseInt(lower.slice(2), 16) : parseInt(lower.slice(1), 10);
      return Number.isInteger(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[lower];
  });
}

// ODS 的日期基准（<table:null-date table:date-value="…"/>，读取库不识别、一律按 1900）：没有声明或为 1899-12-30（ODF 缺省）时
//   同 Excel 1900 日期系统，1904-01-01 同 1904 日期系统；其他基准（如 StarCalc 的 1900-01-01）返回 null，由调用方报错
const OPENDOCUMENT_TABLE_NAMESPACE = 'urn:oasis:names:tc:opendocument:xmlns:table:1.0';

function escapeRegExpText(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\-]/g, '\\$&');
}

// 日期基准只取 ODF 表格命名空间中 table:calculation-settings 的 table:null-date（注释、CDATA 中的旧设置与其他元素不算）；
//   没有该设置时按默认基准 1899-12-30。属性同样按命名空间识别：只认绑定到表格命名空间的前缀上的 date-value（不带前缀的属性
//   不属于任何命名空间），其他命名空间的同名属性（x:date-value）不论先后都不算。绑定到表格命名空间的前缀在文档中另被绑定到
//   其他命名空间（局部重绑定）时无法按位置确定含义，返回 null（由调用方报错），不按任一绑定猜测
function resolveOdsDateSystem(contentXml) {
  const text = maskXmlMarkup(contentXml);
  const { prefixes, rebound } = namespacePrefixesOf(text, OPENDOCUMENT_TABLE_NAMESPACE);
  if (!prefixes.size) return '1900';
  if (rebound) return null;
  const prefixPattern = Array.from(prefixes).sort((left, right) => right.length - left.length).map(escapeRegExpText).join('|');
  const settings = new RegExp(`<(${prefixPattern})calculation-settings\\b(?:[^>"']|"[^"]*"|'[^']*')*?(?:\\/>|>([\\s\\S]*?)<\\/\\1calculation-settings>)`)
    .exec(text);
  const element = settings && settings[2]
    ? new RegExp(`<(?:${prefixPattern})null-date\\b((?:[^>"']|"[^"]*"|'[^']*')*?)\\/?>`).exec(settings[2])
    : null;
  const rawValue = element ? namespacedAttributeOf(element[1], prefixes, 'date-value') : null;
  const value = rawValue === null ? null : decodeXmlAttributeValue(rawValue);
  if (value === null) return '1900';
  // XML Schema 日期 / 日期时间可带时区后缀：等价的 UTC 写法（Z、+00:00、-00:00）与不带后缀的同一基准
  const match = /^(\d{4}-\d{2}-\d{2})(?:T00:00:00(?:\.0+)?)?(?:Z|[+-]00:00)?$/.exec(value.trim());
  if (match && match[1] === '1899-12-30') return '1900';
  if (match && match[1] === '1904-01-01') return '1904';
  return null;
}

const OPENDOCUMENT_OFFICE_NAMESPACE = 'urn:oasis:names:tc:opendocument:xmlns:office:1.0';

// 平面 OpenDocument（FODS，单个 XML 文件，读取库同样能打开，含扩展名为 .xls 的）：根元素为 OpenDocument 命名空间的
//   office:document。是时返回全文，否则 null（ZIP、OLE2 与其他文本格式）
//   按编码解码（含 UTF-16），根开始标签可以很长；返回解码后的全文，读取前把 XML 声明的编码改成 UTF-8（按 UTF-8 重新解析）
function flatOdsText(buffer) {
  if (buffer.length >= 4 && ((buffer[0] === 0x50 && buffer[1] === 0x4B) || (buffer[0] === 0xD0 && buffer[1] === 0xCF))) return null;
  const root = readTextRootElement(buffer);
  if (!root || root.name !== 'document' || !root.attributes.includes(OPENDOCUMENT_OFFICE_NAMESPACE)) return null;
  return decodeTextBuffer(buffer).replace(/^(\s*<\?xml\b[^>]*?\bencoding\s*=\s*)(["'])[^"']*\2/i, '$1$2UTF-8$2');
}

// 内容是网页（HTML）表格的工作簿（含扩展名为 .xls 的；读取库把每个 <table> 读成一张表）。平面 OpenDocument 同样含
//   <table:table>，不算 HTML
//   按编码解码后识别（含 UTF-16 的 HTML，读取库同样能读出其中的表格）
function isHtmlWorkbookFile(filePath) {
  try {
    if (detectWorkbookContainer(filePath) !== 'text') return false;
    const buffer = fs.readFileSync(filePath);
    return flatOdsText(buffer) === null && classifyTextWorkbook(decodeTextBuffer(buffer)) === 'html';
  } catch (_error) {
    return false;
  }
}

// 文本容器（非 ZIP、非 OLE2）中读取库读出的数值是否可能由显示文本推断（网页表格、分隔符文本等：读取库把 2026-09-25 这类
//   文本按本机时区推断成带小数的日期序号，不是工作簿原生的日期值）。只有确认是原生值的格式才不算：平面 OpenDocument
//   （odsContent 已按全文识别）、不在 OLE2 容器中的 BIFF2–5 工作表流（与读取库同一判断：首字节 0x09、次字节不大于 0x08）、
//   SpreadsheetML 2003（根元素 Workbook）。其余文本容器（含首行是标题、不含分隔符的分隔符文本）一律算，不能确认时不取日期部分。
//   在读取时调用，只读文件开头（不为此再整文件读取）
function textContainerValuesInferred(filePath, odsContent) {
  if (odsContent && odsContent.flat) return false;
  try {
    const handle = fs.openSync(filePath, 'r');
    let head;
    try {
      head = Buffer.alloc(65536);
      head = head.subarray(0, fs.readSync(handle, head, 0, head.length, 0));
    } finally {
      fs.closeSync(handle);
    }
    if (head.length >= 2 && head[0] === 0x09 && head[1] <= 0x08) return false;
    const root = readTextRootElement(head);
    return !(root && root.name === 'workbook');
  } catch (_error) {
    return true;
  }
}

// 读取 ODS 的内容（按内容识别，含扩展名为 .xls / .xlsx 的）：ZIP 格式为 content.xml，{ container, entry, text, dateSystem }；
//   平面 OpenDocument（FODS）为整个文件，{ flat: true, text, dateSystem }；不是 ODS 或读不出时为 null
function loadOdsContent(source) {
  try {
    const buffer = Buffer.isBuffer(source) ? source : fs.readFileSync(source);
    if (!isOdsBuffer(buffer)) {
      const flatText = flatOdsText(buffer);
      return flatText === null ? null : { flat: true, text: flatText, dateSystem: resolveOdsDateSystem(flatText) };
    }
    const container = XLSX.CFB.read(buffer, { type: 'buffer' });
    const entry = XLSX.CFB.find(container, 'content.xml');
    if (!entry || !entry.content) return null;
    const text = Buffer.from(entry.content).toString('utf8');
    return { container, entry, text, dateSystem: resolveOdsDateSystem(text) };
  } catch (_error) {
    return null;
  }
}

// 只保留指定的工作表（顶层 <table:table> 元素按 table:name 筛选，嵌套的表随所在表保留）；sheetNames 为空时原样返回
function odsTableNameCandidates(attributes) {
  const candidates = [];
  const pattern = /(?:^|\s)(?:[\w.-]+:)?(?:name|名称)\s*=\s*(["'])([\s\S]*?)\1/g;
  let match;
  while ((match = pattern.exec(attributes))) candidates.push(match[2], decodeXmlAttributeValue(match[2]));
  return candidates;
}

// ODS 的工作表（按文档顺序）：name 为实际表名（表名属性解码一次），key 为读取库的工作表键（表名属性原文，读取库不解码字符引用）；
//   表名属性不止一个（读取库取最后一个、本函数无法确认）时 ambiguous 为 true。不是 ODS 时返回 null（第二十九轮）
function odsSheetNameEntries(source) {
  // 已载入的 ODS 内容（loadOdsContent 的结果）直接使用
  const loaded = source && typeof source === 'object' && !Buffer.isBuffer(source) && typeof source.text === 'string'
    ? source
    : loadOdsContent(source);
  if (!loaded) return null;
  const tagPattern = /<(\/?)((?:[\w.-]+:)?)table((?:\s(?:[^>"']|"[^"]*"|'[^']*')*?)?)(\/?)>/g;
  const masked = maskXmlMarkup(loaded.text);
  const entries = [];
  let depth = 0;
  let match;
  while ((match = tagPattern.exec(masked))) {
    const [whole, closing, , maskedAttributes, selfClosing] = match;
    if (closing) {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (depth === 0) {
      // 标签按遮盖注释后的文本定位，属性取原文（遮盖不改变长度）
      const attributes = maskedAttributes ? loaded.text.slice(match.index, match.index + whole.length) : '';
      const raws = [];
      const pattern = /\s(?:[\w.-]+:)?(?:name|名称)\s*=\s*(["'])([\s\S]*?)\1/g;
      let attribute;
      while ((attribute = pattern.exec(attributes))) raws.push(attribute[2]);
      const key = raws.length > 0 ? raws[raws.length - 1] : '';
      entries.push({ key, name: decodeXmlAttributeValue(key), ambiguous: raws.length !== 1 });
    }
    if (!selfClosing) depth += 1;
  }
  return entries;
}

function keepOdsTables(text, sheetNames) {
  if (!Array.isArray(sheetNames)) return text;
  const wanted = new Set(sheetNames);
  const tagPattern = /<(\/?)((?:[\w.-]+:)?)table((?:\s(?:[^>"']|"[^"]*"|'[^']*')*?)?)(\/?)>/g;
  let output = '';
  let cursor = 0;
  let depth = 0;
  let dropFrom = -1;
  // 按遮盖注释后的文本定位标签（注释中的 <table:table> 不计入层级），切取原文
  const masked = maskXmlMarkup(text);
  let match = tagPattern.exec(masked);
  while (match) {
    const [whole, closing, , attributes, selfClosing] = match;
    if (closing) {
      depth = Math.max(0, depth - 1);
      if (depth === 0 && dropFrom >= 0) {
        cursor = match.index + whole.length;
        dropFrom = -1;
      }
    } else {
      if (depth === 0) {
        // 读取库的工作表键是表名属性的原文（不解码字符引用，Cash & Bank 的键是 Cash &amp; Bank）：原文与解码后的写法都比对，
        //   多保留的表只多解析、不影响按键收集（第二十八轮）
        const keep = odsTableNameCandidates(attributes || '').some((name) => wanted.has(name));
        if (!keep) {
          output += text.slice(cursor, match.index);
          cursor = match.index + whole.length;
          if (!selfClosing) dropFrom = match.index;
        }
      }
      if (!selfClosing) depth += 1;
    }
    match = tagPattern.exec(masked);
  }
  return dropFrom >= 0 ? output : output + text.slice(cursor);
}

// ODS 按 content.xml 原文逐格扫描（v3.2.21 跨 Sheet 回填与账单日期），做法同 SpreadsheetML 2003（scanXlmlWorkbookCells）：
//   - isoDates：日期单元格（office:value-type="date"）读取库按本机时区换算成序号（西半球时区取日期部分会早一天）
//     → 按 office:date-value 原文与工作簿日期系统（date1904，由调用方按 loadOdsContent 的 dateSystem 确定）换算；
//   - formulas：没有缓存结果的公式单元格（带 table:formula、没有 office:value-type；读取库整格丢弃、读成空白）。
//   source 可以是路径、Buffer 或 loadOdsContent 的结果。只标记并重新解析 sheetNames 指定的工作表（读取库解析 ODS 不支持
//   只解析部分工作表，先去掉其他表）；没有要标记的单元格时不重新解析。不是 ODS（按内容识别）时返回空 Map
function scanOdsWorkbookCells(source, { sheetNames = null, formulas = false, isoDates = false, date1904 = false } = {}) {
  const found = new Map();
  if (!formulas && !isoDates) return found;
  const loaded = source && typeof source.text === 'string' && (source.container || source.flat) ? source : loadOdsContent(source);
  if (!loaded) return found;
  const cellPattern = /<((?:[\w.-]+:)?)table-cell\b((?:[^>"']|"[^"]*"|'[^']*')*?)(\/>|>([\s\S]*?)<\/\1table-cell>)/g;
  // 取值属性按 office 命名空间读取（第二十五轮）：扩展属性 x:value 等不论先后都不算；office 前缀被局部重绑定时无法确定，拒绝
  const office = namespacePrefixesOf(maskXmlMarkup(loaded.text), OPENDOCUMENT_OFFICE_NAMESPACE);
  if (office.rebound) {
    throw new FileValidationError('FILE_READ', 'ODS 文件的命名空间无法识别，无法确定单元格的值，请用 Excel 另存为 xlsx 后重新导入');
  }
  const officeAttributeOf = (attributes, localName) => namespacedAttributeOf(attributes, office.prefixes, localName);
  const table = namespacePrefixesOf(maskXmlMarkup(loaded.text), OPENDOCUMENT_TABLE_NAMESPACE);
  const spanOf = (attributes, localName) => {
    const count = Number(namespacedAttributeOf(attributes, table.prefixes, localName));
    return Number.isSafeInteger(count) && count > 1 ? count : 1;
  };
  const foreignValueAttribute = (attributes, officeValueType) => {
    const pattern = /(?:^|\s)([\w.-]+:)?([\w.-]+)\s*=\s*(["'])([\s\S]*?)\3/g;
    let attribute;
    while ((attribute = pattern.exec(attributes))) {
      const [, prefix = '', localName, , value] = attribute;
      if (!prefix || office.prefixes.has(prefix)) continue;
      if (ODS_VALUE_ATTRIBUTE_NAMES.includes(localName)) return true;
      // 扩展的值类型（LibreOffice 的 calcext:value-type）与标准值类型相同、或为公式错误（error，另行处理）时不算冲突
      if (localName === 'value-type' && value !== officeValueType && value !== 'error') return true;
    }
    return false;
  };
  let changed = false;
  const markedValues = [];
  // 属性值按 XML 规范化后解码字符引用：行尾先统一（字面 CRLF 与单独的 CR 都按一个换行），再把字面的制表符、换行各按一个
  //   空格（PO<CRLF>123 读成 PO 123，不是两个空格，第三十二轮审查）；原有的连续空格与字符引用（&#10;）保留
  const attributeText = (raw) => decodeXmlAttributeValue(String(raw).replace(/\r\n?/g, '\n').replace(/[\t\n]/g, ' '));
  // 文本单元格读取库读到的值：有 office:string-value 时取其值，否则取显示文本
  const odsStringDisplay = (attributes, inner) => {
    const raw = officeAttributeOf(attributes, 'string-value');
    return raw !== null && attributeText(raw) !== '' ? attributeText(raw) : odsCellText(inner);
  };
  const valueMark = (valueType, text) => {
    markedValues.push({ valueType, text });
    return `${ODS_SELF_CLOSING_VALUE_MARK}${markedValues.length - 1}`;
  };
  // 与主读取同一改写（覆盖格的重复计数、自闭合的行），标记后再解析的坐标与主读取一致
  const odsText = normalizeOdsContentText(loaded.text) || loaded.text;
  const marked = replaceXmlElements(keepOdsTables(odsText, sheetNames), cellPattern, (whole, prefix, attributes, _closing, inner) => {
    const valueType = officeAttributeOf(attributes, 'value-type');
    // 公式错误（LibreOffice 写成 office:value-type="string" 加 calcext:value-type="error"，读取库读成 #DIV/0! 等文本）：与没有
    //   缓存结果的公式同样处理，不提供配对键或回填值（office:value-type 没有 error 这一取值，按任一前缀的 value-type="error" 识别）
    const isFormulaError = /\s(?:[\w.-]+:)?value-type\s*=\s*(["'])error\1/.test(attributes);
    // 文本单元格的值可能与读取库读到的不同：原文含形似 Excel 转义码的 _xHHHH_ 或字符引用（读取库按 SpreadsheetML 规则解码），
    //   或含 CDATA（读取库连同其中的文字一起丢掉，第三十六轮审查）。先粗筛，再按读取库口径取显示文本核对
    const hasCdata = /<!\[CDATA\[/.test(String(inner || ''));
    const literalText = isoDates && valueType === 'string' && (hasCdata
      || /&#|_x[0-9a-f]{4}_/i.test(`${officeAttributeOf(attributes, 'string-value') || ''}${String(inner || '').replace(/<[^>]*>/g, '')}`))
      ? odsStringDisplay(attributes, inner)
      : null;
    let markText = null;
    let errorText = null;
    if (formulas && isFormulaError) {
      // 错误码优先取标准的 office:string-value（可以没有显示文本），没有或为空时取显示文本（第二十八轮）
      const errorValue = officeAttributeOf(attributes, 'string-value');
      errorText = (errorValue !== null && attributeText(errorValue).trim() !== ''
        ? attributeText(errorValue)
        : odsCellText(inner)).trim();
      markText = `${ODS_FORMULA_ERROR_MARK}${errorText.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}`;
    } else if (formulas && xmlAttributeOf(attributes, 'formula') !== null && (valueType === null
      || (valueType === 'string' && odsStringDisplay(attributes, inner) === '')
      || (ODS_TYPED_VALUE_ATTRIBUTES[valueType] && officeAttributeOf(attributes, ODS_TYPED_VALUE_ATTRIBUTES[valueType]) === null))) {
      // 没有缓存结果的公式；结果为空文本的公式（value-type="string"、空的 string-value、没有显示段落，读取库整格丢弃）同样
      //   按没有结果处理，不当成可填的空格覆盖银行公式（第三十三轮审查）；声明了值类型却没有该类型的取值属性（of:=TRUE() 写了
      //   value-type="boolean" 而没有 office:boolean-value，读取库推断成 false）同样没有缓存结果，显式缓存的 false、0 照常保留
      //   （第三十六轮审查）
      markText = XLML_UNCACHED_FORMULA_MARK;
    } else if (isoDates && valueType === 'date' && officeAttributeOf(attributes, 'date-value')) {
      markText = `${XLML_DATETIME_MARK}${officeAttributeOf(attributes, 'date-value').trim()}`;
    } else if (isoDates && valueType !== null && foreignValueAttribute(attributes, valueType)) {
      // 有外来命名空间的同名取值属性：按 office 属性的原值改写（文本格没有 office:string-value 时取显示文本）
      const attributeName = { boolean: 'boolean-value', time: 'time-value', string: 'string-value' }[valueType] || 'value';
      const raw = officeAttributeOf(attributes, attributeName);
      const text = raw === null ? (valueType === 'string' ? odsCellText(inner) : '') : attributeText(raw);
      markText = valueMark(valueType, text);
    } else if (literalText !== null && (hasCdata || /_x[0-9a-f]{4}_/i.test(literalText))) {
      // 文本中形似 Excel 转义码的 _xHHHH_ 在 ODF 中是字面文字，读取库按 SpreadsheetML 的规则解码（Ref_x0041_ 读成 RefA，与另一行
      //   的 RefA 配成一对）：按原文改写，配对键与回填值按 ODF 文本语义（第三十三轮审查）；只看单元格的值，批注中的文字不算
      //   （第三十四轮审查）
      markText = valueMark('string', literalText);
    } else if (isoDates && valueType !== null && !/\S/.test(odsCellBody(inner).replace(/<[^>]*>/g, ''))) {
      // 值只在属性上、没有显示文本的单元格（自闭合，或开闭标签之间没有文字）读取库读成空，或带
      //   table:number-columns-repeated 时只有第一格有值：按值类型记下原值，由 restoreOdsSelfClosingCells 补回（已有值的格不动）
      const attributeName = { boolean: 'boolean-value', time: 'time-value', string: 'string-value' }[valueType] || 'value';
      const raw = officeAttributeOf(attributes, attributeName);
      // 空文本（行尾常见 office:string-value="" 加大量重复列）与空单元格相同，不标记、不展开成数据列
      if (raw !== null && !(valueType === 'string' && attributeText(raw) === '')) {
        markText = valueMark(valueType, attributeText(raw));
      }
    }
    // 单元格声明的合并范围（table:number-columns-spanned / number-rows-spanned）与数组公式范围（number-matrix-*-spanned）：
    //   读取库对自闭合单元格都不记（第二十七轮只补了带值的自闭合合并），数组公式还要求行列两个属性都写才记。按原文补出，
    //   独立于缓存值与标记类型（第二十八轮）：改用带序号的标记，同时带的日期、值、无缓存公式或公式错误随同一标记还原。
    //   读取库已记下的范围重复记入不影响判定（按范围去重）
    if (!table.rebound) {
      const spans = [
        { rows: spanOf(attributes, 'number-rows-spanned'), columns: spanOf(attributes, 'number-columns-spanned') },
        { rows: spanOf(attributes, 'number-matrix-rows-spanned'), columns: spanOf(attributes, 'number-matrix-columns-spanned') }
      ].filter((span) => span.rows > 1 || span.columns > 1);
      if (spans.length > 0) {
        let index;
        if (markText !== null && markText.startsWith(ODS_SELF_CLOSING_VALUE_MARK)) {
          index = Number(markText.slice(ODS_SELF_CLOSING_VALUE_MARK.length));
        } else {
          const original = markText;
          markText = valueMark(null, '');
          index = markedValues.length - 1;
          if (original === XLML_UNCACHED_FORMULA_MARK) {
            markedValues[index].formula = true;
          } else if (original !== null && original.startsWith(ODS_FORMULA_ERROR_MARK)) {
            Object.assign(markedValues[index], { formula: true, errorText });
          } else if (original !== null && original.startsWith(XLML_DATETIME_MARK)) {
            Object.assign(markedValues[index], { valueType: 'date', text: original.slice(XLML_DATETIME_MARK.length) });
          }
        }
        markedValues[index].spans = spans;
      }
    }
    if (markText === null) return whole;
    changed = true;
    // 去掉全部取值属性（含 string-value、boolean-value、time-value：读取库优先取 office:string-value，留着就读不到标记），
    //   重复列数等其他属性保留，由读取库按同一规则展开到每个位置
    const kept = attributes.replace(/\s(?:[\w.-]+:)?(?:value-type|date-value|time-value|boolean-value|string-value|value|formula)\s*=\s*(["'])[\s\S]*?\1/g, '');
    return `<${prefix}table-cell${kept} office:value-type="string"><text:p>${markText}</text:p></${prefix}table-cell>`;
  });
  if (!changed) return found;
  let workbook;
  if (loaded.flat) {
    try {
      workbook = XLSX.read(Buffer.from(marked, 'utf8'), { type: 'buffer', cellDates: false, dense: false });
    } catch (_error) {
      return found;
    }
    return collectMarkedWorkbookCells(workbook, sheetNames, date1904, markedValues);
  }
  const originalContent = loaded.entry.content;
  try {
    loaded.entry.content = Buffer.from(marked, 'utf8');
    workbook = XLSX.read(XLSX.CFB.write(loaded.container, { type: 'buffer', fileType: 'zip' }), { type: 'buffer', cellDates: false, dense: false });
  } catch (_error) {
    return found;
  } finally {
    loaded.entry.content = originalContent;
  }
  return collectMarkedWorkbookCells(workbook, sheetNames, date1904, markedValues);
}

// 按工作表原文逐格扫描（v3.2.21）：isoDates 时收集 ISO 日期单元格（t="d"，附原文与按原文换算的序号，见 isoTextToSerial），formulas 时收集
//   含公式元素的单元格（含没有缓存结果、读取库读成空白的共享公式从属格 <f t="shared" si="0"/>）与数组公式范围。
//   坐标与读取库一致：有 r 取 r，没有时按前一行 / 前一个单元格加 1；自闭合的空行（<row/>、<row r="2"/>）读取库不推进
//   行号，这里同样跳过（实测 SheetJS 0.18.5）。取不到原文时返回空结果（保持读取库的结果）。
function scanXlsxSheetCells(filePath, workbook, sheetName, { isoDates = false, formulas = false, date1904 = false } = {}) {
  const found = { isoDateCells: [], formulaCells: [], arrayFormulaRanges: [] };
  let xml = findXlsxSheetXml(workbook, sheetName);
  if (!xml && !workbook.files) {
    try {
      xml = findXlsxSheetXml(XLSX.readFile(filePath, { bookFiles: true, sheetRows: 1 }), sheetName);
    } catch (_error) {
      xml = null;
    }
  }
  if (!xml) {
    // OOXML 工作簿（workbook.xml）中找不到该表的原文时拒绝，不当成“没有日期、公式单元格”继续：t="d" 的日期会保留读取库换算的
    //   序号（1904 日期系统下再按 1904 解释，差四年），没有缓存结果的公式会当成空格回填（第三十四轮审查）。二进制工作簿（xlsb）
    //   没有这两类写法，ODS 另按 content.xml 扫描，不在此列
    const directory = workbook && workbook.Directory;
    const workbookPath = directory && Array.isArray(directory.workbooks) ? directory.workbooks[0] : '';
    if (/\.xml$/i.test(String(workbookPath || ''))) {
      throw new FileValidationError('FILE_READ', `无法定位工作表「${sheetName}」的原文，无法核对其中的日期与公式，请用 Excel 另存为 xlsx 后重新导入`);
    }
    return found;
  }
  const rowPattern = /<(?:[\w.-]+:)?row\b((?:[^>"']|"[^"]*"|'[^']*')*?)(?:\/>|>([\s\S]*?)<\/(?:[\w.-]+:)?row>)/gd;
  const cellPattern = /<(?:[\w.-]+:)?c\b((?:[^>"']|"[^"]*"|'[^']*')*?)(?:\/>|>([\s\S]*?)<\/(?:[\w.-]+:)?c>)/gd;
  const valuePattern = /<(?:[\w.-]+:)?v\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?v>/d;
  const formulaPattern = /<(?:[\w.-]+:)?f\b((?:[^>"']|"[^"]*"|'[^']*')*?)(?:\/>|>)/;
  // 只扫描 sheetData 中的单元格（与读取库一致）：注释、CDATA 中的旧单元格与 sheetData 以外的元素不算，否则会把注释里同坐标的
  //   旧日期当成银行原值、改写读取库读到的金额
  const sheetXmlText = xml.toString('utf8');
  const sheetData = /<(?:[\w.-]+:)?sheetData\b(?:[^>"']|"[^"]*"|'[^']*')*?(?:\/>|>([\s\S]*?)<\/(?:[\w.-]+:)?sheetData>)/d
    .exec(maskXmlMarkup(sheetXmlText));
  const text = sheetData && sheetData[1] ? sheetData[1] : '';
  // 同一位置的原文（遮盖不改变长度）：元素只在遮盖后的文本中定位，单元格的值（缓存结果、ISO 原文）按位置从原文切取，CDATA
  //   中的值照常读取（读取库同样读出；按遮盖后的空白判断会把有缓存的公式当成没有结果、清空银行金额，第三十一轮审查）
  const originalText = sheetData && sheetData[1] ? sheetXmlText.slice(sheetData.indices[1][0], sheetData.indices[1][1]) : '';
  // 只找 ISO 日期且原文没有 t="d" 时不逐格扫描（大多数账单）
  if (!formulas && !/\st\s*=\s*["']d["']/.test(text)) return found;
  let previousRow = -1;
  let rowMatch;
  while ((rowMatch = rowPattern.exec(text)) !== null) {
    if (rowMatch[2] === undefined) continue;
    const rowAttr = readXmlAttribute(rowMatch[1], 'r');
    const rowIndex = rowAttr && /^\d+$/.test(rowAttr) ? Number(rowAttr) - 1 : previousRow + 1;
    previousRow = rowIndex;
    let previousColumn = -1;
    let cellMatch;
    cellPattern.lastIndex = 0;
    const body = rowMatch[2];
    const bodyStart = rowMatch.indices[2][0];
    while ((cellMatch = cellPattern.exec(body)) !== null) {
      const ref = readXmlAttribute(cellMatch[1], 'r');
      let address = { r: rowIndex, c: previousColumn + 1 };
      if (ref) {
        try {
          address = XLSX.utils.decode_cell(ref);
        } catch (_error) {
          address = null;
        }
      }
      if (!address || address.c < 0 || address.r < 0) break;
      previousColumn = address.c;
      const cellBody = cellMatch[2] || '';
      const cellBodyStart = cellMatch[2] === undefined ? bodyStart : bodyStart + cellMatch.indices[2][0];
      // <v> 的字符数据（取自原文，见 xmlCharacterData）；没有 <v> 时为 null
      const valueTextOf = () => {
        const valueMatch = valuePattern.exec(cellBody);
        return valueMatch
          ? xmlCharacterData(originalText.slice(cellBodyStart + valueMatch.indices[1][0], cellBodyStart + valueMatch.indices[1][1]))
          : null;
      };
      if (isoDates && readXmlAttribute(cellMatch[1], 't') === 'd') {
        const isoText = (valueTextOf() || '').trim();
        found.isoDateCells.push({ r: address.r, c: address.c, text: isoText, serial: isoText ? isoTextToSerial(isoText, date1904) : null });
      }
      const formulaMatch = formulas ? formulaPattern.exec(cellBody) : null;
      if (formulaMatch) {
        // cached：原文是否带非空的缓存结果（<v>0</v> 是确实缓存的 FALSE；<v/>、<v></v> 与没有 <v> 一样没有结果）。没有缓存的
        //   布尔公式会被读取库读成 false，与银行保存的 FALSE 无法区分
        const cachedText = valueTextOf();
        found.formulaCells.push({ r: address.r, c: address.c, cached: cachedText !== null && cachedText.trim() !== '' });
        const formulaRef = readXmlAttribute(formulaMatch[1], 'ref');
        if (readXmlAttribute(formulaMatch[1], 't') === 'array' && formulaRef) {
          try {
            found.arrayFormulaRanges.push(XLSX.utils.decode_range(formulaRef));
          } catch (_error) { /* 范围无法解析时只记该格 */ }
        }
      }
    }
  }
  return found;
}

// v3.2.21：不能单独填写的单元格区域（物理坐标，0 起）：合并单元格与数组公式。区域内除左上角以外的位置读成空值，
//   但显示的是左上角的值 / 公式结果，写入常量也不会生效或会破坏公式（跨 Sheet 回填据此跳过这类目标单元格）
function collectUnwritableRanges(sheet, extraArrayRanges = []) {
  const ranges = [];
  const seen = new Set();
  const add = (range, label) => {
    if (!range || !range.s || !range.e) return;
    if (range.s.r === range.e.r && range.s.c === range.e.c) return;
    const text = XLSX.utils.encode_range(range);
    if (seen.has(text)) return;
    seen.add(text);
    ranges.push(Object.freeze({ s: { r: range.s.r, c: range.s.c }, e: { r: range.e.r, c: range.e.c }, reason: `${label} ${text}` }));
  };
  (Array.isArray(sheet['!merges']) ? sheet['!merges'] : []).forEach((merge) => add(merge, '合并单元格'));
  (Array.isArray(extraArrayRanges) ? extraArrayRanges : []).forEach((range) => add(range, '数组公式'));
  const visit = (cell) => {
    if (!cell || typeof cell.F !== 'string' || !cell.F) return;
    try {
      add(XLSX.utils.decode_range(cell.F), '数组公式');
    } catch (_error) { /* 范围无法解析时不记，整行已由 collectSpecialCells 标记 */ }
  };
  const denseRows = Array.isArray(sheet) ? sheet : (Array.isArray(sheet['!data']) ? sheet['!data'] : null);
  if (denseRows) {
    denseRows.forEach((row) => { if (Array.isArray(row)) row.forEach(visit); });
  } else {
    Object.keys(sheet).forEach((address) => { if (address[0] !== '!') visit(sheet[address]); });
  }
  return ranges;
}

function decodeSheetNameAttribute(value) {
  if (value === null) return null;
  try {
    return decodeExcelStXstring(value);
  } catch (_error) {
    return value;
  }
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
  // 注释、CDATA、处理指令中的标签不算；属性值可含字面 `>`（见 xmlStartTagPattern）
  const workbookText = maskXmlMarkup(rawWorkbookText);
  const sheetTags = workbookText.match(xmlStartTagPattern('sheet')) || [];
  if ((rawWorkbookText.match(xmlStartTagPattern('sheet')) || []).length !== sheetTags.length) return null;
  const sheetIndex = Array.isArray(workbook.SheetNames) ? workbook.SheetNames.indexOf(sheetName) : -1;
  const sheetTag = sheetIndex >= 0 ? sheetTags[sheetIndex] : null;
  // 表名可以按 ST_Xstring 转义存储（如 ABC_x005F_x0041_），读取库给出的是解码后的名字：按同一规则解码后再核对
  if (!sheetTag || decodeSheetNameAttribute(readXmlAttribute(sheetTag, 'name')) !== sheetName) return null;
  const relsText = relsXml.toString('utf8');
  const relationTagsById = new Map();
  (maskXmlMarkup(relsText).match(xmlStartTagPattern('Relationship')) || []).forEach((tag) => {
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
    const relationTag = relsXml && (maskXmlMarkup(relsXml.toString('utf8')).match(xmlStartTagPattern('Relationship')) || [])
      .find((tag) => /\/sharedStrings$/.test(readXmlAttribute(tag, 'Type') || ''));
    const target = relationTag ? readXmlAttribute(relationTag, 'Target') : null;
    if (target) sstPath = normalizeZipPath(workbookDir, target);
  }
  if (!sstPath && directory && directory.sst) sstPath = String(directory.sst);
  if (!sstPath) return [];
  const sstXml = getZipEntryBuffer(files, sstPath);
  if (!sstXml) return null;
  return sharedStringItemSources(sstXml.toString('utf8'));
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
    const relationTag = relsXml && (relsXml.toString('utf8').match(xmlStartTagPattern('Relationship')) || [])
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
    // 按文档根元素区分：Excel 2003 XML 的根元素是 Workbook；HTML 可以声明 SpreadsheetML 命名空间，不能按全文搜索判断。
    //   根元素前的声明、注释可以很长，按全文跳过（只看开头一段时，Workbook 前有长注释的 SpreadsheetML 会因工作表的 <Table>
    //   判成 HTML，第三十二轮审查）
    const rootMatch = /^<([\w.:-]+)/.exec(skipXmlProlog(body));
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
function readWorkbookRowsUnchecked(filePath, {
  blankrows = false, sheetName, maxRows = 0, csvMaxSourceBytes, markErrorCells = false, markCells = false, exactIsoDates = false,
  onlyTargetSheet = false, blankUncachedFormulas = false, headerOnly = false, exactSourceText = false
} = {}) {
  // markErrorCells：重复账单过滤的整行证据（逐格标记 + 按原文核对格式、行摘要等）；markCells（v3.2.21 跨 Sheet 回填）：
  //   只要逐格标记（错误值、公式）与不能单独填写的区域，不做查重证据（按原文核对整张表的格式与行摘要开销大）
  const collectCellMarks = markErrorCells || markCells;
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
        // 每行原文与整行摘要只用于重复账单过滤（markErrorCells）；跨 Sheet 回填只要逐格标记，不为整表逐行计算摘要
        const rows = parseCsvText(content, { blankrows, withSources: markErrorCells, withDisplayText: exactSourceText });
        const result = rowLimit > 0 ? rows.slice(0, rowLimit) : rows;
        if (result !== rows && Array.isArray(rows.displayText)) {
          Object.defineProperty(result, 'displayText', { value: rows.displayText.slice(0, result.length), enumerable: false });
        }
        // v3.2.19 重复账单过滤：每行附该行原文的摘要（列下标 -2，见 collectSpecialCells），原文完全相同的行才可能判为重复——
        //   解析器会吞掉未加引号字段中间的引号（SALE 2" X" 与 SALE 2 X 读成同一文本）等。
        //   有不能按 UTF-8 解码的字节时，不同的原文可能解出同一替换字符（如 café、cafè 都成 caf�），
        //   含替换字符的单元格值未知，该行不参与查重（普通映射照旧）
        if (collectCellMarks) {
          const specials = new Map();
          const sources = Array.isArray(rows.sources) ? rows.sources : [];
          result.forEach((row, rowIndex) => {
            const rowMarks = new Map();
            if (markErrorCells) {
              rowMarks.set(-2, { sourceText: sha256Text(sources[rowIndex] === undefined ? '' : sources[rowIndex]) });
              if (sources[rowIndex] === undefined) rowMarks.set(-1, { unknownValue: '行原文无法核对' });
            }
            (Array.isArray(row) ? row : []).forEach((cell, columnIndex) => {
              if (typeof cell !== 'string') return;
              // Excel 打开时按公式计算的文本（如 ="TX-"&ROW()、+ROW()）：值无法证明
              if (looksLikeSpreadsheetFormula(cell)) rowMarks.set(columnIndex, { unknownValue: '公式' });
              // 含替换字符（U+FFFD）的单元格不论本次解码是否有损都无法核对：文件里的替换字符可能是上游解码丢失后写入的
              else if (cell.includes('\uFFFD')) rowMarks.set(columnIndex, { unknownValue: '编码无法识别' });
            });
            if (rowMarks.size) specials.set(rowIndex, rowMarks);
          });
          Object.defineProperty(result, 'excelErrorCells', { value: specials, enumerable: false });
        }
        // 纯文本 CSV 没有 sheet 维度（与 listSheetNames 一致）
        Object.defineProperty(result, 'sheetNames', { value: [null], enumerable: false });
        // 值都是文本，不是工作簿原生的日期序号（见 textContainerValuesInferred）
        Object.defineProperty(result, 'valuesInferredFromText', { value: true, enumerable: false });
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
    const container = detectWorkbookContainer(filePath);
    const isZipContainer = container === 'zip';
    // blankUncachedFormulas（v3.2.21 跨 Sheet 回填读来源表）：只按原文找没有缓存结果的公式按空值读取，不做逐格标记
    const scanFormulas = markCells || blankUncachedFormulas;
    // ODS：日期单元格与没有缓存结果的公式按 content.xml 原文识别（见 scanOdsWorkbookCells）；按原值换算日期时，日期系统取
    //   ODS 声明的日期基准（table:null-date，读取库不识别），不是 1899-12-30 / 1904-01-01 时报错，不按 1900 猜测
    //   平面 OpenDocument（FODS，文本容器）同样如此
    const odsContent = (scanFormulas || exactIsoDates) && (isZipContainer ? isOdsFile(filePath) : container === 'text')
      ? loadOdsContent(filePath)
      : null;
    const workbook = readSpreadsheetFile(filePath, {
      cellDates: false,
      dense: true,
      raw: false,
      // v3.2.19：查重读取时保留没有缓存结果的公式（占位单元格在 collectSpecialCells 中收集后删除），
      //   并保留压缩包原文（bookFiles），用于按工作表 XML 核对公式
      //   并保留数字格式（cellNF，按格式比较显示文本不同的值）
      //   只做跨 Sheet 回填的逐格标记（不查重）时，ODS 不保留占位单元格：行尾的重复空列（table:number-columns-repeated）会
      //   展开成数据行数乘以整表列数的占位对象；回填所需的公式、公式错误与合并范围由原文扫描与 !merges 提供（第三十轮审查）
      ...(collectCellMarks ? { bookFiles: true, ...(markErrorCells || !odsContent ? { sheetStubs: true } : {}) } : {}),
      // 按原文核对 ISO 日期单元格需要压缩包原文
      ...(exactIsoDates ? { bookFiles: true } : {}),
      // 只解析指定的 sheet（v3.2.21 跨 Sheet 回填：读主表时只解析主表，找到待回填行后再单独读来源表），SheetNames 仍为全部；
      //   未指定 sheetName 时解析第一个 sheet（与缺省读取的表一致）
      ...(onlyTargetSheet ? { sheets: sheetName != null && sheetName !== '' ? sheetName : 0 } : {}),
      ...(markErrorCells ? { cellNF: true } : {}),
      ...(rowLimit > 0 ? { sheetRows: rowLimit } : {})
    }, container, odsContent);
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
    // 读取库没有给出 OOXML 结构（按 ODS 等解析）、这里却没有识别出 ODS 时无法按原文校正日期与取值，拒绝，不按读取库的值静默导入
    if (isZipContainer && exactIsoDates && !odsContent
      && !(workbook.Directory && Array.isArray(workbook.Directory.workbooks) && workbook.Directory.workbooks.length)) {
      throw new FileValidationError('FILE_READ', '无法确认文件格式（ZIP 中不是可识别的 xlsx 或 ODS 结构），请用 Excel 另存为 xlsx 后重新导入');
    }
    let workbookDate1904 = Boolean(workbook.Workbook && workbook.Workbook.WBProps && workbook.Workbook.WBProps.date1904);
    // xlsx：按 workbook.xml 中实际生效的 workbookPr 确定（见 xlsxWorkbookDate1904；与回填写出侧一致），取不到原文时沿用读取库
    if (isZipContainer && !odsContent && workbook.files) {
      if (xlsxWorkbookStructureAmbiguous(workbook)) {
        throw new FileValidationError('FILE_READ', '工作簿结构中有被注释的工作表或关系声明（或关系编号重复），无法确认各工作表的内容，请用 Excel 另存为 xlsx 后重新导入');
      }
      const workbookXml = xlsxWorkbookXmlOf(workbook);
      const ownDate1904 = workbookXml ? xlsxWorkbookDate1904(workbookXml) : null;
      // 有 workbook.xml 原文、却确定不了日期系统时拒绝（与回填写出侧一致），不沿用读取库按全文（含注释）得到的结果
      if (workbookXml && ownDate1904 === null && /^\s*(?:<\?xml[\s\S]*?\?>\s*)?</.test(workbookXml.toString('utf8'))) {
        throw new FileValidationError('FILE_READ', '工作簿的结构或命名空间无法识别，无法确定日期系统，请用 Excel 另存为 xlsx 后重新导入');
      }
      if (ownDate1904 !== null) workbookDate1904 = ownDate1904;
    }
    if (odsContent && exactIsoDates) {
      if (!odsContent.dateSystem) {
        throw new FileValidationError('FILE_READ', 'ODS 文件声明的日期基准不是 1899-12-30 或 1904-01-01（或其命名空间无法确定），无法确定日期，请用 Excel 另存为 xlsx 后重新导入');
      }
      workbookDate1904 = odsContent.dateSystem === '1904';
    }
    const scanned = isZipContainer && !odsContent && (exactIsoDates || scanFormulas)
      ? scanXlsxSheetCells(filePath, workbook, targetSheetName, { isoDates: exactIsoDates, formulas: scanFormulas, date1904: workbookDate1904 })
      : { isoDateCells: [], formulaCells: [], arrayFormulaRanges: [] };
    // SpreadsheetML 2003：读取库丢弃没有缓存结果的公式单元格，按原文补出其坐标（有缓存的公式读取库带 f，已按公式标记）；
    //   按原值换算日期时，DateTime 单元格按原文与工作簿日期系统换算（见 scanXlmlWorkbookCells）
    if (container === 'text' && !odsContent && (scanFormulas || exactIsoDates)) {
      const xlml = scanXlmlWorkbookCells(filePath, {
        sheetNames: [targetSheetName], formulas: scanFormulas, isoDates: exactIsoDates, date1904: workbookDate1904
      }).get(targetSheetName);
      if (xlml) {
        scanned.formulaCells = scanned.formulaCells.concat(xlml.formulaCells);
        scanned.isoDateCells = scanned.isoDateCells.concat(xlml.isoDateCells);
        scanned.arrayFormulaRanges = scanned.arrayFormulaRanges.concat(xlml.mergeRanges || []);
      }
    }
    if (odsContent) {
      const ods = scanOdsWorkbookCells(odsContent, {
        sheetNames: [targetSheetName], formulas: scanFormulas, isoDates: exactIsoDates, date1904: workbookDate1904
      }).get(targetSheetName);
      if (ods) {
        scanned.formulaCells = scanned.formulaCells.concat(ods.formulaCells);
        scanned.isoDateCells = scanned.isoDateCells.concat(ods.isoDateCells);
        // 自闭合单元格声明的合并范围与数组公式范围同样按不能单独填写的区域处理
        scanned.arrayFormulaRanges = scanned.arrayFormulaRanges.concat(ods.mergeRanges || []);
        // 自闭合单元格（日期、数值等只写在属性上）：读取库读成空，按原文补回，不当作空单元格（跨 Sheet 回填不能把它当成待回填的
        //   空格、占用来源行）
        if (exactIsoDates) restoreOdsSelfClosingCells(sheet, ods);
      }
    }
    const isoDateCells = scanned.isoDateCells;
    const sheetRange = sheet['!ref'] ? XLSX.utils.decode_range(sheet['!ref']) : null;
    // 不能单独填写的区域在 collectSpecialCells 删除占位单元格之前收集（没有缓存结果的数组公式锚点读成占位单元格）
    // 不能单独填写的区域（合并单元格、数组公式）只供跨 Sheet 回填（markCells）使用，重复账单过滤不扫描
    const unwritableRanges = markCells && sheetRange ? collectUnwritableRanges(sheet, scanned.arrayFormulaRanges) : null;
    const specialCells = collectCellMarks && sheetRange ? collectSpecialCells(sheet, sheetRange) : null;
    if (specialCells && markErrorCells) {
      // 1904 日期系统：日期序号相同、实际日期不同，不与 1900 日期系统的文件互判重复。按映射实际采用的日期系统（xlsx 按
      //   workbook.xml 原文、ODS 按声明的日期基准校正后的值），不按读取库的判断（第三十三轮审查）
      if (workbookDate1904) {
        for (let r = sheetRange.s.r; r <= sheetRange.e.r; r += 1) specialCells.markRowDateSystem(r);
      }
      // 纵向合并单元格：只有首行存值，其余行的该格为空但实际属于同一值（如合并的流水号标识一笔交易及其费用行），
      //   这些行无法证明整行相同，不参与查重
      (Array.isArray(sheet['!merges']) ? sheet['!merges'] : []).forEach((merge) => {
        if (!merge || !merge.s || !merge.e || merge.e.r <= merge.s.r) return;
        contentRowsWithin(sheet, Math.max(merge.s.r + 1, sheetRange.s.r), Math.min(merge.e.r, sheetRange.e.r))
          .forEach((r) => specialCells.markRowUnknown(r, '纵向合并单元格'));
      });
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
    // headerOnly（网银模板读取表头）：只展开到第一个有值的行，不为有效范围内其后的空行构造行数组（见 rangeThroughFirstValueRow）
    const rowRange = headerOnly && sheetRange ? rangeThroughFirstValueRow(sheet, sheetRange) : null;
    const rows = XLSX.utils.sheet_to_json(sheet, {
      header: 1,
      blankrows,
      defval: '',
      ...(rowRange ? { range: rowRange } : {})
    });
    const result = rowLimit > 0 ? rows.slice(0, rowLimit) : rows;
    // v3.2.21：原文没有缓存结果的公式按空值读取（读取库把其中的布尔公式读成 false，其他类型读成空白），与「空值」条件、
    //   待回填行判定同一口径；该格同时带公式标记，跨 Sheet 回填按「没有结果的公式」跳过，不当成可填的空格
    if (scanFormulas && sheetRange) {
      scanned.formulaCells.forEach(({ r, c, cached }) => {
        if (cached) return;
        const row = result[r - sheetRange.s.r];
        const column = c - sheetRange.s.c;
        if (Array.isArray(row) && column >= 0 && column < row.length) row[column] = '';
      });
    }
    // v3.2.19：有效范围不从第 1 行开始（前几行完全为空）时，rows[0] 对应的 Excel 物理行号；
    //   保留空行读取时「下标 + firstRowNumber」即物理行号。只记偏移，不补出前面的空行。
    Object.defineProperty(result, 'firstRowNumber', { value: sheetRange ? sheetRange.s.r + 1 : 1, enumerable: false });
    // 同理，rows[i][0] 对应的物理列下标（A 列为 0）；只有查重按物理列对齐整行时使用
    Object.defineProperty(result, 'firstColumnIndex', { value: sheetRange ? sheetRange.s.c : 0, enumerable: false });
    // v3.2.21：工作簿的全部 sheet 名（顺序同 listSheetNames），调用方据此核对来源 sheet，不再为表名重开工作簿
    Object.defineProperty(result, 'sheetNames', { value: workbook.SheetNames.slice(), enumerable: false });
    // v3.2.21：工作簿的日期单元格是否按 1904 日期系统读成序号（换算日期时需要）。文本容器（如 SpreadsheetML 2003 的 .xls）
    //   的 DateTime 单元格以 ISO 文本存储，读取库一律换算成 1900 序号，同表的数值日期却是工作簿日期系统的序号：按原值换算
    //   日期（exactIsoDates）时 DateTime 单元格已按原文换算成工作簿日期系统的序号，整表按工作簿日期系统；否则沿用读取库的值、按 1900
    Object.defineProperty(result, 'date1904', {
      value: workbookDate1904 && (container !== 'text' || Boolean(exactIsoDates)),
      enumerable: false
    });
    // v3.2.21：数值是否可能由读取库从显示文本推断（见 textContainerValuesInferred；只在按原值换算日期时判断）
    Object.defineProperty(result, 'valuesInferredFromText', {
      value: Boolean(exactIsoDates) && container === 'text' && textContainerValuesInferred(filePath, odsContent),
      enumerable: false
    });
    // v3.2.21：ISO 日期单元格（行下标 → 列下标 → { text, serial }，与 rows 同一相对坐标），见 scanXlsxSheetCells
    if (isoDateCells.length && sheetRange) {
      const byRow = new Map();
      isoDateCells.forEach(({ r, c, text, serial }) => {
        const rowIndex = r - sheetRange.s.r;
        const columnIndex = c - sheetRange.s.c;
        if (rowIndex < 0 || columnIndex < 0) return;
        if (!byRow.has(rowIndex)) byRow.set(rowIndex, new Map());
        byRow.get(rowIndex).set(columnIndex, { text, serial });
      });
      Object.defineProperty(result, 'isoDateCells', { value: byRow, enumerable: false });
    }
    if (specialCells) {
      Object.defineProperty(result, 'excelErrorCells', { value: specialCells, enumerable: false });
      Object.defineProperty(result, 'unwritableRanges', { value: unwritableRanges || [], enumerable: false });
    }
    if (sourceText) {
      Object.defineProperty(result, 'sourceText', { value: sourceText, enumerable: false });
    }
    // v3.2.21：按原文找到的公式单元格（物理坐标，含读取库读成空白的共享公式从属格），跨 Sheet 回填不填这些格
    if (markCells) Object.defineProperty(result, 'formulaCells', { value: scanned.formulaCells, enumerable: false });
    // v3.2.21 跨 Sheet 回填：ODS 的工作表名与读取键（见 odsSheetNameEntries；不是 ODS 时为 null），按本次已载入的内容取，
    //   核对来源 Sheet 时不再为判断格式整份重读文件（第三十一轮审查）
    if (markCells) Object.defineProperty(result, 'odsSheetEntries', { value: odsContent ? odsSheetNameEntries(odsContent) : null, enumerable: false });
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

// 有效范围从起始行到第一个有值的行（含）：网银模板读取表头只需这一段。有效范围可能因一个空样式格延伸到第 1048576 行，按
//   保留空行展开全部会构造上百万个行数组（第三十五轮审查）。没有有值的行时只取起始行；不是按行存放的工作表时返回 null（不限制）
function rangeThroughFirstValueRow(sheet, range) {
  if (!Array.isArray(sheet)) return null;
  const hasValue = (cell) => Boolean(cell) && cell.v !== undefined && cell.v !== null
    && !(typeof cell.v === 'string' && cell.v.trim() === '');
  let end = range.s.r;
  for (let r = range.s.r; r <= range.e.r; r += 1) {
    const row = sheet[r];
    if (Array.isArray(row) && row.some((cell, c) => c >= range.s.c && c <= range.e.c && hasValue(cell))) {
      end = r;
      break;
    }
  }
  return { s: { r: range.s.r, c: range.s.c }, e: { r: end, c: range.e.c } };
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
  includeFullRows = false,
  includeHeaderRows = false
}) {
  const expectedHeaderCount = normalizedExpectedHeaders.length;
  // v3.2.21 跨 Sheet 回填：includeHeaderRows 时另给各分段表头的整行（模板表头范围以外的列也在内），核对规则引用的列是否重名
  const headerRows = includeHeaderRows ? [meaningfulRows[matchedRowIndex].cells.slice()] : null;
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
      if (headerRows) headerRows.push(row.cells.slice());
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
    ...(fullRows ? { fullRows, fullHeaders } : {}),
    ...(headerRows ? { headerRows } : {})
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
  // allowEmpty（v3.2.21 跨 Sheet 回填读来源 sheet）：整张表没有有值的行时返回空结果，由调用方按表名与所需字段报错
  // exactIsoDates（v3.2.21）：调用方按返回的 excelDateSystem 换算日期序号时传入，见 isoTextToSerial
  // includeCellMarks（v3.2.21 跨 Sheet 回填）：只要逐格标记（cellMarks）与不能单独填写的区域（unwritableRanges），不构造查重整行
  const {
    sheetName, readGuard, onWorkbookRows, includeFullRows = false, includeCellMarks = false, allowEmpty = false, exactIsoDates = false,
    onlyTargetSheet = false, blankUncachedFormulas = false,
    // v3.2.21 跨 Sheet 回填：按表头定位时另给各分段表头的整行（headerRows，第 0 列的物理列下标为 headerColumnOffset）
    includeHeaderRows = false,
    // headerOnly（网银模板读取表头）：只读到第一个有值的行（见 rangeThroughFirstValueRow）
    headerOnly = false,
    // exactSourceText（v3.2.21 B112，网银账单生成）：数据行的长整数换成文件原文、CSV 取 Excel 显示值（见 readWorkbookRowsUnchecked）
    exactSourceText = false
  } = options;
  const rawRows = readWorkbookRows(filePath, {
    blankrows: true, sheetName, readGuard, markErrorCells: includeFullRows, markCells: includeCellMarks, exactIsoDates, onlyTargetSheet,
    blankUncachedFormulas, headerOnly, exactSourceText
  });
  // v3.2.21 B112：大账号识别拿到的行与 readRows 的 exactSourceText 一致：读取值另附长整数原文（sourceText），CSV 显示值不用
  const sourceTextByRow = rawRows.sourceText instanceof Map ? rawRows.sourceText : null;
  // v3.2.21：工作簿的全部 sheet 名（跨 Sheet 回填核对来源 sheet 与主表，不再为表名重开工作簿）
  const sheetNames = Array.isArray(rawRows.sheetNames) ? rawRows.sheetNames : null;
  // 跨 Sheet 回填：ODS 的工作表名与读取键（主表读取时一并取得）
  const odsSheetEntries = rawRows.odsSheetEntries !== undefined ? { odsSheetEntries: rawRows.odsSheetEntries } : {};
  // onWorkbookRows（大账号识别）：读完并定位表头后调用一次，headerRowNumbers 为正式映射命中的各分段表头的物理行号（不按
  //   表头定位时为空；定位不到表头时不调用，随后报错）。识别按读取库的原值找表头，与正式映射的值不同（表头含原生日期、按
  //   原文换算后）时据此定位（第三十一轮审查）
  const notifyWorkbookRows = (headerRowNumbers = []) => {
    if (typeof onWorkbookRows === 'function') onWorkbookRows(rawRows, { headerRowNumbers });
  };
  const headerCandidates = buildExpectedHeaderCandidates(expectedHeaders);
  // 行号是 Excel 物理行号：有效范围不从第 1 行开始时加上起始偏移（与大账号分段识别同一口径）
  const firstRowNumber = Number(rawRows.firstRowNumber) > 0 ? Number(rawRows.firstRowNumber) : 1;
  const errorCells = (includeFullRows || includeCellMarks) && rawRows.excelErrorCells instanceof Map ? rawRows.excelErrorCells : null;
  // v3.2.21：工作簿日期系统；CSV 等没有工作簿属性的按 1900（与原映射口径一致）
  const excelDateSystem = rawRows.date1904 ? '1904' : '1900';
  // v3.2.21：数值是否可能由读取库从显示文本推断（不可枚举，映射据此决定带小数的日期序号是否取日期部分）
  const withReadFacts = (value) => Object.defineProperty(value, 'textInferredValues', {
    value: Boolean(rawRows.valuesInferredFromText),
    enumerable: false
  });
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
  // v3.2.21：逐格标记（物理行号 → 物理列下标 → 标记），只含落在具体单元格上的标记（不含整行级标记）。
  //   跨 Sheet 回填据此区分真正的空单元格与读成空值的 Excel 错误值 / 公式；整行数组不能按下标定位（行尾空格被裁掉后
  //   追加的整行级标记会落在空列的下标上）。
  const firstColumnIndex = Number(rawRows.firstColumnIndex) > 0 ? Number(rawRows.firstColumnIndex) : 0;
  //   只为跨 Sheet 回填（includeCellMarks）构造；只启用重复账单过滤时查重用整行（fullRows），不另建这份索引
  const cellMarks = includeCellMarks && errorCells ? new Map() : null;
  if (cellMarks) {
    errorCells.forEach((rowMarks, rawIndex) => {
      const marks = new Map();
      rowMarks.forEach((mark, columnIndex) => {
        if (columnIndex >= 0) marks.set(columnIndex + firstColumnIndex, mark);
      });
      if (marks.size) cellMarks.set(rawIndex + firstRowNumber, marks);
    });
  }
  // 按原文找到的公式单元格（物理坐标）：读取库读成空白的共享公式从属格等，同样不是可填的空单元格
  if (cellMarks && Array.isArray(rawRows.formulaCells)) {
    rawRows.formulaCells.forEach(({ r, c }) => {
      const rowNumber = r + 1;
      if (!cellMarks.has(rowNumber)) cellMarks.set(rowNumber, new Map());
      const marks = cellMarks.get(rowNumber);
      if (!marks.has(c)) marks.set(c, { unknownFormula: '工作表原文含公式' });
    });
  }
  // 不能单独填写的区域（合并单元格、数组公式；物理坐标）：跨 Sheet 回填按目标坐标判断
  const unwritableRanges = includeCellMarks && errorCells && Array.isArray(rawRows.unwritableRanges) ? rawRows.unwritableRanges : null;
  // ISO 日期单元格：映射取值改成按原文换算的本工作簿日期系统序号；查重整行保持原值（见 isoTextToSerial）
  const isoDateCells = rawRows.isoDateCells instanceof Map ? rawRows.isoDateCells : null;
  // 读成无效数值的原生日期单元格的原文：行号 → Excel 物理列（A 列为 0）→ 原文，只供报错显示
  const invalidDateTexts = new Map();
  const physicalColumnBase = Number(rawRows.firstColumnIndex) > 0 ? Number(rawRows.firstColumnIndex) : 0;
  const meaningfulRows = rawRows
    .map((row, index) => {
      const originalCells = trimTrailingEmptyCells(Array.isArray(row) ? row : []);
      const isoColumns = isoDateCells ? isoDateCells.get(index) : null;
      // 按原文 ISO 换算的序号（不受本机时区影响）；写法无法识别时保持读取库的值（1904 工作簿减 1462，与同表日期序号同口径）
      const cells = isoColumns
        ? originalCells.map((value, column) => {
          // 读取库读成 NaN 的日期（如 ODF 的 2026-09-25+00:00）同样优先取按原文换算的序号；读成文本的（SpreadsheetML 带时区
          //   偏移的 DateTime，读取库读成原文末尾加 Z 的文本）同样如此（第三十一轮审查）
          if (!isoColumns.has(column)) return value;
          const { text, serial } = isoColumns.get(column);
          if (Number.isFinite(serial)) return serial;
          // 读取库读成非数值、原文为空（无从换算）时保持读取库的值
          if (typeof value !== 'number' && serial === null) return value;
          // 原文已判无效（日期不存在、整串校验不通过，如 2026-02-30、2026-09-25 12:30:00 (garbage)），或读取库读成无效值且
          //   原文也无法换算：读成无效数值，状态一路带到日期映射与跨 Sheet 回填（映射按无效日期拒绝；回填不作配对键、回填值与
          //   来源日期）。不返回原文：原文会被文本日期解析去掉时间及其后内容，按 2026-09-25 静默接受
          if (Number.isNaN(serial) || !Number.isFinite(value)) {
            const rowNumber = index + firstRowNumber;
            if (!invalidDateTexts.has(rowNumber)) invalidDateTexts.set(rowNumber, new Map());
            invalidDateTexts.get(rowNumber).set(physicalColumnBase + column, text);
            return Number.NaN;
          }
          return rawRows.date1904 ? value - EXCEL_1904_DAY_OFFSET : value;
        })
        : originalCells;
      const fullCells = includeFullRows ? (buildFullCells(originalCells, index) || (isoColumns ? originalCells : null)) : null;
      // 读取库给出的原值（日期单元格按原文换算前）：升级前保存的模板表头含原生日期时按原值定位表头（见下方）
      const legacyCells = cells !== originalCells && cells.some((value, column) => !Object.is(value, originalCells[column]))
        ? originalCells
        : null;
      const displayCells = buildDisplayCells(cells, index);
      const longIntegerReadValues = buildLongIntegerReadValues(cells, index);
      return {
        rowNumber: index + firstRowNumber,
        cells,
        ...(legacyCells ? { legacyCells } : {}),
        ...(fullCells ? { fullCells } : {}),
        ...(displayCells ? { displayCells } : {}),
        ...(longIntegerReadValues ? { longIntegerReadValues } : {})
      };
    })
    .filter((row) => isRowMeaningful(row.cells));

  if (!meaningfulRows.length) {
    if (allowEmpty && !headerCandidates.length) {
      notifyWorkbookRows();
      return { rows: [], rowNumbers: [], columnOffset: 0, excelDateSystem, ...(sheetNames ? { sheetNames } : {}), ...odsSheetEntries };
    }
    throw new FileValidationError('FILE_READ', '文件为空或不可读，请重新导入');
  }

  if (!headerCandidates.length) {
    notifyWorkbookRows();
    const longIntegerReadValues = meaningfulRows.map((row, index) => (index > 0 && row.longIntegerReadValues) || null);
    return withReadFacts({
      rows: meaningfulRows.map((row, index) => (index > 0 && row.displayCells ? row.displayCells : row.cells)),
      rowNumbers: meaningfulRows.map((row) => row.rowNumber),
      ...(longIntegerReadValues.some(Boolean) ? { longIntegerReadValues } : {}),
      // v3.2.21：rows[i][0] 对应的 Excel 物理列下标（A 列为 0），跨 Sheet 回填写出原始账单时定位单元格
      columnOffset: Number(rawRows.firstColumnIndex) > 0 ? Number(rawRows.firstColumnIndex) : 0,
      excelDateSystem,
      ...(sheetNames ? { sheetNames } : {}),
      ...odsSheetEntries,
      ...(cellMarks ? { cellMarks } : {}),
      ...(unwritableRanges ? { unwritableRanges } : {}),
      ...(invalidDateTexts.size ? { invalidDateTexts } : {}),
      // 不按表头定位时整行即全部列：查重的整行同样带错误值 / 未缓存公式标记与物理列偏移
      ...(includeFullRows ? {
        fullRows: meaningfulRows.map((row) => row.fullCells || row.cells),
        fullHeaders: meaningfulRows.map(() => meaningfulRows[0].fullCells || meaningfulRows[0].cells),
        fullColumnOffset: Number(rawRows.firstColumnIndex) > 0 ? Number(rawRows.firstColumnIndex) : 0
      } : {})
    });
  }

  const meaningfulCells = meaningfulRows.map((row) => row.cells);

  const finishMatch = (rowsForCollect, matchedRowIndex, matchedColumnIndex, normalizedExpectedHeaders) => {
    const matched = collectMatchedRows({
      meaningfulRows: rowsForCollect,
      matchedRowIndex,
      matchedColumnIndex,
      normalizedExpectedHeaders,
      includeFullRows,
      includeHeaderRows
    });
    if (includeHeaderRows) matched.headerColumnOffset = Number(rawRows.firstColumnIndex) > 0 ? Number(rawRows.firstColumnIndex) : 0;
    // v3.2.21：rows[i][0]（按表头截取后）对应的 Excel 物理列下标（A 列为 0），跨 Sheet 回填写出原始账单时定位单元格
    matched.columnOffset = (Number(rawRows.firstColumnIndex) > 0 ? Number(rawRows.firstColumnIndex) : 0) + matchedColumnIndex;
    matched.excelDateSystem = excelDateSystem;
    if (sheetNames) matched.sheetNames = sheetNames;
    Object.assign(matched, odsSheetEntries);
    if (cellMarks) matched.cellMarks = cellMarks;
    if (unwritableRanges) matched.unwritableRanges = unwritableRanges;
    if (invalidDateTexts.size) matched.invalidDateTexts = invalidDateTexts;
    // 整行第 0 个单元格对应的 Excel 物理列下标（A 列为 0），查重按物理列对齐时使用
    if (includeFullRows) matched.fullColumnOffset = Number(rawRows.firstColumnIndex) > 0 ? Number(rawRows.firstColumnIndex) : 0;
    notifyWorkbookRows([rowsForCollect[matchedRowIndex].rowNumber, ...matched.headerBreaks]);
    return withReadFacts(matched);
  };

  // 升级前保存的模板（第三十一、三十二轮审查）：表头中的原生日期单元格当时按读取库的原值保存（1904 工作簿中差 1462 天、带
  //   本机时区偏差等），与按原文换算后的值不同。表头定位与重复表头判定对每一行同时比较两种表示：按物理行序取最先命中的一行
  //   （同一行两种都命中时取换算后的值），不因后面的分段先按换算后的值命中而漏掉前面的分段；命中的表头行按命中的表示取值
  //   （与模板表头一致，字段按表头名绑定），数据行仍取换算后的值
  const legacyHeaderCells = meaningfulRows.some((row) => row.legacyCells)
    ? meaningfulRows.map((row) => row.legacyCells || row.cells)
    : null;
  // 先按完整结构定位；命中的口径同时决定截取宽度与重复表头判定，保证取值下标与物理列一致。
  for (const normalizedExpectedHeaders of headerCandidates) {
    const current = findHeaderMatchPosition(meaningfulCells, normalizedExpectedHeaders);
    const legacy = legacyHeaderCells
      ? findHeaderMatchPosition(legacyHeaderCells, normalizedExpectedHeaders)
      : { matchedRowIndex: -1, matchedColumnIndex: -1 };
    const useLegacy = legacy.matchedRowIndex >= 0 && legacy.matchedColumnIndex >= 0
      && (current.matchedRowIndex < 0 || current.matchedColumnIndex < 0 || legacy.matchedRowIndex < current.matchedRowIndex);
    const { matchedRowIndex, matchedColumnIndex } = useLegacy ? legacy : current;
    if (matchedRowIndex < 0 || matchedColumnIndex < 0) continue;
    if (!legacyHeaderCells) return finishMatch(meaningfulRows, matchedRowIndex, matchedColumnIndex, normalizedExpectedHeaders);
    const width = normalizedExpectedHeaders.length;
    const headerSliceOf = (cells) => {
      const sliced = cells.slice(matchedColumnIndex, matchedColumnIndex + width);
      while (sliced.length < width) sliced.push('');
      return sliced;
    };
    const rowsForCollect = meaningfulRows.map((row, index) => {
      if (!row.legacyCells || index < matchedRowIndex) return row;
      if (index === matchedRowIndex) return useLegacy ? { ...row, cells: row.legacyCells } : row;
      if (isRepeatedMatchedHeader(headerSliceOf(row.cells), normalizedExpectedHeaders)) return row;
      return isRepeatedMatchedHeader(headerSliceOf(row.legacyCells), normalizedExpectedHeaders) ? { ...row, cells: row.legacyCells } : row;
    });
    return finishMatch(rowsForCollect, matchedRowIndex, matchedColumnIndex, normalizedExpectedHeaders);
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

// exactIsoDates：表头取自网银账单导入同一读取结果（readRowsWithMetadata，见 file-service.js buildMappedRows：按原文校正 ODS
//   只写在属性上的文本、ISO 日期按工作簿日期系统换算等），网银模板的创建、更新与按文件名匹配的预检都按这一口径
//   （v3.2.21 第二十九、三十轮审查）
//   按原值读取时只展开到第一个有值的行（第三十五轮审查）；该行经校正后仍没有值（如读取库读成 false 的无缓存公式）时改按整表读取
function extractHeaders(filePath, { exactIsoDates = false } = {}) {
  const readHeaderRows = (headerOnly) => readRowsWithMetadata(filePath, [], {
    exactIsoDates: true, onlyTargetSheet: true, headerOnly, allowEmpty: headerOnly
  }).rows;
  let rows;
  if (exactIsoDates) {
    rows = readHeaderRows(true);
    if (!rows.length || !isRowMeaningful(rows[0])) rows = readHeaderRows(false);
  } else {
    rows = readRows(filePath);
  }
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
  xmlStartTagPattern,
  isHtmlWorkbookFile,
  normalizeOdsContentText,
  normalizeXlsxSharedStringsBuffer,
  odsWorkbookBuffer,
  sharedStringItemSources,
  xmlCharacterData,
  loadOdsContent,
  odsSheetNameEntries,
  maskXmlMarkup,
  decodeXmlAttributeValue,
  normalizeXlmlWorkbookBuffer,
  parseXlsxRelationships,
  restoreOdsSelfClosingCells,
  xlsxWorkbookDate1904,
  xlsxWorkbookRootInfo,
  xlsxWorkbookXmlOf,
  xmlTagsHiddenInMarkup,
  collectMatchedRows,
  ensureSupportedFile,
  extractEnumValuesFromImportedFile,
  extractHeaders,
  findHeaderMatchPosition,
  // v3.0.8 BUG3：大文件全量读触顶内存类错误判定（导出供单测）
  isMemoryLimitError,
  // v3.2.21 D12：ISO 日期单元格按原文换算（导出供单测）
  isoTextToSerial,
  scanOdsWorkbookCells,
  scanXlmlWorkbookCells,
  // v3.2.21：按工作表原文找 ISO 日期单元格（跨 Sheet 回填转换写出时统一日期系统）
  scanXlsxSheetCells,
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
