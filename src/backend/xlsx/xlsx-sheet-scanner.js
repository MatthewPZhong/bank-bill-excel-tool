'use strict';

const {
  StrictXmlSyntaxError,
  createStrictXmlTokenizer
} = require('./strict-xml-tokenizer');
const { openZipEntryReadStream } = require('./zip-reader');
const {
  createScannedToolboxCell,
  createScannedToolboxRow,
  createToolboxCell,
  createToolboxRow,
  createToolboxSheetMeta,
  freezeToolboxStyleRef
} = require('./model');
const {
  classifyNumericLexical,
  decimalComparable,
  parseDecimalLexical,
  parseOoxmlWallClock
} = require('./number-date');
const {
  SPREADSHEETML_NAMESPACES,
  namespaceAllowed,
  normalizedSaxAttributes
} = require('./ooxml-namespaces');
const {
  EXCEL_CELL_TEXT_MAX_UTF16_UNITS,
  EXCEL_ST_XSTRING_MAX_RAW_UTF16_UNITS,
  assertExcelCellTextLength,
  assertExcelStXstringRawLength,
  decodeExcelStXstring
} = require('./excel-text');

const SPREADSHEETML_CANONICAL_ELEMENTS = Object.freeze([
  'worksheet',
  'sheetFormatPr',
  'cols',
  'col',
  'sheetData',
  'row',
  'c',
  'v',
  'f',
  'is',
  'r',
  'rPh',
  'phoneticPr',
  't'
]);
const SPREADSHEETML_ELEMENTS_BY_CASEFOLD = new Map(
  SPREADSHEETML_CANONICAL_ELEMENTS.map((name) => [name.toLowerCase(), name])
);
const SPREADSHEETML_RECOGNIZED_ELEMENTS = new Set(
  SPREADSHEETML_CANONICAL_ELEMENTS.map((name) => name.toLowerCase())
);
const WORKSHEET_CONSUMED_ATTRIBUTES = Object.freeze({
  sheetFormatPr: Object.freeze([
    'defaultColWidth',
    'defaultRowHeight',
    'zeroHeight',
    'customHeight'
  ]),
  col: Object.freeze([
    'min',
    'max',
    'width',
    'hidden',
    'outlineLevel',
    'style',
    'customWidth'
  ]),
  row: Object.freeze([
    'r',
    'ht',
    'hidden',
    'outlineLevel',
    's',
    'customFormat'
  ]),
  c: Object.freeze(['r', 't', 's'])
});
const WORKSHEET_ATTRIBUTES_BY_CASEFOLD = Object.freeze(
  Object.fromEntries(
    Object.entries(WORKSHEET_CONSUMED_ATTRIBUTES).map(([elementName, names]) => [
      elementName,
      new Map(names.map((name) => [name.toLowerCase(), name]))
    ])
  )
);
const OOXML_CELL_TYPES = new Set(['b', 'd', 'e', 'inlineStr', 'n', 's', 'str']);
const OOXML_ERROR_VALUES = new Set([
  '#NULL!',
  '#DIV/0!',
  '#VALUE!',
  '#REF!',
  '#NAME?',
  '#NUM!',
  '#N/A',
  '#GETTING_DATA'
]);
const EXCEL_FORMULA_MAX_UTF16_UNITS = 8192;
// 快路径只接管短文本；更长的缓存值交回逐事件路径，保证分段计长与报错 context 不变。
const FAST_CELL_TEXT_MAX = 4096;
// 样式缓存键的单项上限（XF 号 + 1）；更大的编号不缓存，直接计算。
const STYLE_KEY_LIMIT = 32767;
const MAX_LEXICAL_CELL_XML_UTF16_UNITS = 16 * 1024 * 1024;

class ToolboxXlsxFormatError extends Error {
  constructor(message, context = {}) {
    super(message);
    this.name = 'ToolboxXlsxFormatError';
    this.code = 'TOOLBOX_XLSX_FORMAT_INVALID';
    this.context = { ...context };
  }
}

class ToolboxXlsxCancelledError extends Error {
  constructor(message = '工具箱 XLSX 读取已取消') {
    super(message);
    this.name = 'ToolboxXlsxCancelledError';
    this.code = 'TOOLBOX_XLSX_CANCELLED';
  }
}

function isXmlWhitespaceCode(code) {
  return code === 32 || code === 10 || code === 13 || code === 9;
}

// 快路径接受的行属性（精确拼写）；其中 r/ht/hidden/outlineLevel/s/customFormat 会被读取。
const FAST_ROW_ATTRIBUTE_NAMES = new Set([
  'r', 'spans', 's', 'customFormat', 'ht', 'hidden', 'customHeight', 'outlineLevel',
  'collapsed', 'thickTop', 'thickBot', 'ph'
]);

function isAsciiLetterCode(code) {
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

function isFastRowValueCode(code) {
  return isAsciiAlphanumericCode(code) || code === 46 || code === 58 || code === 43 || code === 45;
}

function isAsciiAlphanumericCode(code) {
  return (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

function parseBoolean(value, fallback = false) {
  if (value === undefined || value === null) return fallback;
  if (value === true || value === 1 || value === '1' || value === 'true') return true;
  if (value === false || value === 0 || value === '0' || value === 'false') return false;
  throw new ToolboxXlsxFormatError('工作表布尔属性不是有效的 OOXML boolean', { value });
}

function parsePositiveLayoutNumber(value, attributeName, context = {}) {
  if (value === undefined || value === null) return null;
  const lexical = String(value);
  const parsedDecimal = lexical !== '' && lexical === lexical.trim()
    ? parseDecimalLexical(lexical)
    : null;
  const parsed = parsedDecimal ? Number(lexical) : NaN;
  if (!parsedDecimal || !Number.isFinite(parsed)) {
    throw new ToolboxXlsxFormatError(
      `工作表布局数值属性 ${attributeName} 不是有效的有限十进制数`,
      { ...context, attributeName, value }
    );
  }
  const roundTrip = parseDecimalLexical(String(parsed));
  if (!roundTrip || decimalComparable(parsedDecimal) !== decimalComparable(roundTrip)) {
    throw new ToolboxXlsxFormatError(
      `工作表布局数值属性 ${attributeName} 超出可保真范围`,
      { ...context, attributeName, value }
    );
  }
  if (parsed <= 0) {
    throw new ToolboxXlsxFormatError(
      `工作表布局宽高属性 ${attributeName} 必须大于 0 才能保真输出`,
      { ...context, attributeName, value }
    );
  }
  return parsed;
}

function parseInteger(value, fallback = null) {
  if (value === undefined || value === null) return fallback;
  const lexical = String(value);
  if (!/^[+-]?\d+$/.test(lexical)) {
    throw new ToolboxXlsxFormatError('工作表整数属性不是有效整数', { value });
  }
  const parsed = Number(lexical);
  if (!Number.isSafeInteger(parsed)) {
    throw new ToolboxXlsxFormatError('工作表整数属性超出安全范围', { value });
  }
  return parsed;
}

function parseOutlineLevel(value, owner, context = {}) {
  if (value === undefined || value === null) return 0;
  const parsed = parseInteger(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 7) {
    throw new ToolboxXlsxFormatError(`${owner} outlineLevel 必须是 0..7 的整数`, {
      ...context,
      outlineLevel: value
    });
  }
  return parsed;
}

function calendarYearIsLeap(yearDigits) {
  const suffix = Number(yearDigits.slice(-4));
  return suffix % 4 === 0 && (suffix % 100 !== 0 || suffix % 400 === 0);
}

function classifyOoxmlWallClockLexical(input) {
  const lexical = String(input == null ? '' : input).trim();
  const match = lexical.match(
    /^(\d{4,})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,18}))?)?)?(?:(Z)|([+-])(\d{2}):(\d{2}))?$/
  );
  if (!match) return Object.freeze({ valid: false, inExcelRange: false });

  const yearDigits = match[1];
  if (/^0+$/.test(yearDigits) || (yearDigits.length > 4 && yearDigits.startsWith('0'))) {
    return Object.freeze({ valid: false, inExcelRange: false });
  }
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4] || '0');
  const minute = Number(match[5] || '0');
  const second = Number(match[6] || '0');
  const daysPerMonth = [
    31,
    calendarYearIsLeap(yearDigits) ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31
  ];
  if (month < 1 || month > 12 ||
      day < 1 || day > daysPerMonth[month - 1] ||
      hour > 23 || minute > 59 || second > 59) {
    return Object.freeze({ valid: false, inExcelRange: false });
  }
  if (match[9]) {
    const offsetHour = Number(match[10]);
    const offsetMinute = Number(match[11]);
    if (offsetHour > 14 || offsetMinute > 59 || (offsetHour === 14 && offsetMinute !== 0)) {
      return Object.freeze({ valid: false, inExcelRange: false });
    }
  }

  return Object.freeze({
    valid: true,
    inExcelRange: yearDigits.length === 4 && Number(yearDigits) >= 1900
  });
}

function parseCellType(value, context = {}) {
  if (value === undefined || value === null) return '';
  const lexical = String(value);
  if (!OOXML_CELL_TYPES.has(lexical)) {
    throw new ToolboxXlsxFormatError('单元格声明了不支持的 OOXML 数据类型', {
      ...context,
      cellType: value
    });
  }
  return lexical;
}

function exactLocalName(nodeOrName) {
  if (nodeOrName && typeof nodeOrName === 'object' &&
      typeof nodeOrName.local === 'string') {
    return nodeOrName.local;
  }
  const value = String(
    nodeOrName && typeof nodeOrName === 'object'
      ? nodeOrName.name || ''
      : nodeOrName || ''
  );
  const colon = value.indexOf(':');
  return colon >= 0 ? value.slice(colon + 1) : value;
}

// 规范名称本身的校验结果固定；只缓存这 14 个名称，避免按文件内容无界增长。
const CANONICAL_ELEMENT_CASE_RESULTS = new Map(
  SPREADSHEETML_CANONICAL_ELEMENTS.map((name) => [
    name,
    Object.freeze({ canonicalName: name, normalizedName: name.toLowerCase() })
  ])
);

function validateWorksheetElementCase(nodeOrName, context = {}) {
  const exactName = exactLocalName(nodeOrName);
  const cached = CANONICAL_ELEMENT_CASE_RESULTS.get(exactName);
  if (cached) return cached;
  const canonicalName = SPREADSHEETML_ELEMENTS_BY_CASEFOLD.get(exactName.toLowerCase()) || null;
  if (canonicalName && exactName !== canonicalName) {
    throw new ToolboxXlsxFormatError(
      `工作表元素 ${exactName} 大小写无效；规范名称必须为 ${canonicalName}`,
      {
        ...context,
        elementName: exactName,
        canonicalElementName: canonicalName
      }
    );
  }
  return {
    canonicalName,
    normalizedName: exactName.toLowerCase()
  };
}

function validateConsumedAttributeCase(attributes, canonicalElementName, context = {}) {
  const expectedAttributes = WORKSHEET_ATTRIBUTES_BY_CASEFOLD[canonicalElementName];
  if (!expectedAttributes) return;
  const source = attributes || {};
  const names = Object.keys(source);
  for (let index = 0; index < names.length; index += 1) {
    const rawName = names[index];
    const rawAttribute = source[rawName];
    const qualifiedName = rawAttribute && typeof rawAttribute === 'object' && rawAttribute.name
      ? String(rawAttribute.name)
      : String(rawName);
    const prefix = rawAttribute && typeof rawAttribute === 'object'
      ? String(rawAttribute.prefix || '')
      : (qualifiedName.includes(':') ? qualifiedName.slice(0, qualifiedName.indexOf(':')) : '');
    if (prefix) continue;
    const attributeName = rawAttribute && typeof rawAttribute === 'object' &&
      typeof rawAttribute.local === 'string'
      ? rawAttribute.local
      : qualifiedName;
    const canonicalAttributeName = expectedAttributes.get(attributeName.toLowerCase());
    if (canonicalAttributeName && attributeName !== canonicalAttributeName) {
      throw new ToolboxXlsxFormatError(
        `工作表元素 ${canonicalElementName} 的属性 ${attributeName} 大小写无效；` +
          `规范名称必须为 ${canonicalAttributeName}`,
        {
          ...context,
          elementName: canonicalElementName,
          attributeName,
          canonicalAttributeName
        }
      );
    }
  }
}

function normalizedAttributes(attributes) {
  return normalizedSaxAttributes(attributes);
}

function columnLettersToIndex(letters) {
  const value = String(letters || '').toUpperCase();
  if (!/^[A-Z]{1,3}$/.test(value)) return -1;
  let result = 0;
  for (let i = 0; i < value.length; i += 1) {
    result = result * 26 + value.charCodeAt(i) - 64;
  }
  result -= 1;
  return result >= 0 && result <= 16383 ? result : -1;
}

// 纯 ASCII 坐标的手写解析，结果与下方正则路径一致；undefined 表示需要走正则路径
// （非字符串或含非 ASCII 字符：toUpperCase 可能把 ß、ſ 等展开成 ASCII 字母）。
function parseAsciiCellReference(reference) {
  const length = reference.length;
  let index = 0;
  let column = 0;
  for (; index < length; index += 1) {
    const code = reference.charCodeAt(index);
    if (code >= 65 && code <= 90) column = column * 26 + code - 64;
    else if (code >= 97 && code <= 122) column = column * 26 + code - 96;
    else break;
  }
  const letterCount = index;
  let row = 0;
  for (; index < length; index += 1) {
    const code = reference.charCodeAt(index);
    if (code >= 48 && code <= 57) {
      if (index === letterCount && code === 48) return null;
      if (index - letterCount < 8) row = row * 10 + code - 48;
    } else {
      return code < 128 ? null : undefined;
    }
  }
  if (letterCount < 1 || letterCount > 3 || index === letterCount) return null;
  if (index - letterCount >= 8 || row > 1048576) return null;
  const columnIndex = column - 1;
  if (columnIndex > 16383) return null;
  return { columnIndex, rowIndex: row };
}

function parseCellReference(reference) {
  if (typeof reference === 'string') {
    const parsed = parseAsciiCellReference(reference);
    if (parsed !== undefined) return parsed;
  }
  const match = String(reference || '').toUpperCase().match(/^([A-Z]{1,3})([1-9]\d*)$/);
  if (!match) return null;
  const columnIndex = columnLettersToIndex(match[1]);
  const rowIndex = Number.parseInt(match[2], 10);
  if (columnIndex < 0 || rowIndex < 1 || rowIndex > 1048576) return null;
  return { columnIndex, rowIndex };
}

function rowHasColumn(columnIndexes, columnIndex) {
  return columnIndexes.indexOf(columnIndex) >= 0;
}

function findColumnMetadata(columns, columnIndex) {
  // OOXML 允许 col 范围重叠；后声明的范围覆盖先声明范围，因此从尾部查找。
  for (let index = columns.length - 1; index >= 0; index -= 1) {
    const column = columns[index];
    if (columnIndex >= column.minColumnIndex && columnIndex <= column.maxColumnIndex) return column;
  }
  return null;
}

function legacyNumericProjection(rawValue) {
  const parsed = Number.parseFloat(rawValue);
  return Number.isFinite(parsed) ? String(parsed) : rawValue;
}

function sharedStringCount(sharedStrings) {
  if (sharedStrings && typeof sharedStrings.get === 'function') {
    return Number.isSafeInteger(sharedStrings.count) ? sharedStrings.count : 0;
  }
  return Array.isArray(sharedStrings) ? sharedStrings.length : 0;
}

function sharedStringAt(sharedStrings, index) {
  if (sharedStrings && typeof sharedStrings.get === 'function') {
    return sharedStrings.get(index);
  }
  return Array.isArray(sharedStrings) ? sharedStrings[index] : undefined;
}

function decodeCellPayload({
  type,
  rawValue,
  inlineText,
  sharedStrings,
  valueSeen = false,
  context = {}
}) {
  return decodeCellPayloadAt(type, rawValue, inlineText, sharedStrings, valueSeen, () => context);
}

// 纯数字共享字符串下标（不超过 9 位、无空白）直接按位累加；其他情况沿用 trim + 正则口径。
function sharedStringLexicalIndex(rawValue) {
  if (typeof rawValue === 'string' && rawValue.length > 0 && rawValue.length <= 9) {
    let index = 0;
    for (let position = 0; position < rawValue.length; position += 1) {
      const code = rawValue.charCodeAt(position);
      if (code < 48 || code > 57) return sharedStringLexicalIndexSlow(rawValue);
      index = index * 10 + code - 48;
    }
    return index;
  }
  return sharedStringLexicalIndexSlow(rawValue);
}

function sharedStringLexicalIndexSlow(rawValue) {
  const lexicalIndex = String(rawValue || '').trim();
  return /^\d+$/.test(lexicalIndex) ? Number.parseInt(lexicalIndex, 10) : -1;
}

// contextOf() 只在报错时调用，返回本次报错使用的 context 副本来源（键顺序与原实现一致）。
function decodeCellPayloadAt(type, rawValue, inlineText, sharedStrings, valueSeen, contextOf) {
  const normalizedType = type === undefined || type === null ? '' : String(type);
  if (normalizedType !== '' && !OOXML_CELL_TYPES.has(normalizedType)) {
    throw new ToolboxXlsxFormatError('单元格声明了不支持的 OOXML 数据类型', {
      ...contextOf(),
      cellType: type
    });
  }
  if (normalizedType === 's') {
    const index = sharedStringLexicalIndex(rawValue);
    const count = sharedStringCount(sharedStrings);
    const decoded = Number.isSafeInteger(index) && index >= 0 && index < count
      ? sharedStringAt(sharedStrings, index)
      : undefined;
    if (decoded === undefined) {
      throw new ToolboxXlsxFormatError('共享字符串索引越界或无效，无法安全读取单元格', {
        ...contextOf(),
        sharedStringIndex: rawValue,
        sharedStringCount: count
      });
    }
    return {
      cellType: 'text',
      decodedSemanticValue: decoded,
      matchProjectionValue: decoded
    };
  }
  if (normalizedType === 'inlineStr') {
    try {
      assertExcelCellTextLength(inlineText);
    } catch (error) {
      throw new ToolboxXlsxFormatError('内联字符串超过 Excel 单元格文本上限', {
        ...contextOf(),
        cause: error.message
      });
    }
    return {
      cellType: 'text',
      decodedSemanticValue: inlineText,
      matchProjectionValue: inlineText
    };
  }
  if (normalizedType === 'str') {
    let decoded;
    try {
      decoded = decodeExcelStXstring(rawValue);
      assertExcelCellTextLength(decoded);
    } catch (error) {
      throw new ToolboxXlsxFormatError('字符串缓存值包含无效或超长的 ST_Xstring/UTF-16 文本', {
        ...contextOf(),
        cause: error.message
      });
    }
    return {
      cellType: 'text',
      decodedSemanticValue: decoded,
      matchProjectionValue: decoded
    };
  }
  if (normalizedType === 'b') {
    const booleanLexical = String(rawValue == null ? '' : rawValue).trim();
    if (!['0', '1', 'false', 'true'].includes(booleanLexical)) {
      throw new ToolboxXlsxFormatError('布尔单元格缓存值不是有效的 OOXML boolean', {
        ...contextOf(),
        rawValue
      });
    }
    const booleanValue = booleanLexical === '1' || booleanLexical === 'true';
    return {
      cellType: 'boolean',
      decodedSemanticValue: booleanValue,
      matchProjectionValue: booleanValue ? 'TRUE' : 'FALSE'
    };
  }
  if (normalizedType === 'e') {
    if (!valueSeen || !OOXML_ERROR_VALUES.has(rawValue)) {
      throw new ToolboxXlsxFormatError('错误单元格缓存值不是受支持的 Excel 错误码', {
        ...contextOf(),
        rawValue,
        valueSeen,
        allowedErrorValues: Array.from(OOXML_ERROR_VALUES)
      });
    }
    return {
      cellType: 'error',
      decodedSemanticValue: rawValue,
      matchProjectionValue: rawValue
    };
  }
  if (normalizedType === 'd') {
    if (!valueSeen) {
      return {
        cellType: 'blank',
        decodedSemanticValue: null,
        matchProjectionValue: ''
      };
    }
    const classification = classifyOoxmlWallClockLexical(rawValue);
    if (!classification.valid) {
      throw new ToolboxXlsxFormatError('日期单元格缓存值与声明类型不一致', {
        ...contextOf(),
        rawValue
      });
    }
    const parsedDate = classification.inExcelRange
      ? parseOoxmlWallClock(rawValue)
      : null;
    if (classification.inExcelRange && !parsedDate) {
      throw new ToolboxXlsxFormatError('日期单元格缓存值与声明类型不一致', {
        ...contextOf(),
        rawValue
      });
    }
    return {
      cellType: 'date',
      decodedSemanticValue: parsedDate || rawValue,
      matchProjectionValue: rawValue
    };
  }
  if (!valueSeen && rawValue === '') {
    return {
      cellType: 'blank',
      decodedSemanticValue: null,
      matchProjectionValue: ''
    };
  }

  // 等价于先 parseDecimalLexical 判定、再 classifyNumericOutput(rawValue, 'General')，只解析一次。
  const numericOutput = classifyNumericLexical(rawValue, 'General');
  if (!numericOutput) {
    throw new ToolboxXlsxFormatError('数值单元格缓存值与声明类型不一致', {
      ...contextOf(),
      rawValue
    });
  }
  return {
    cellType: 'number',
    decodedSemanticValue: numericOutput.outputType === 'number'
      ? numericOutput.outputValue
      : numericOutput.canonical,
    matchProjectionValue: legacyNumericProjection(rawValue)
  };
}

function openEntryStream(zip, entry) {
  return new Promise((resolve, reject) => {
    openZipEntryReadStream(zip, entry, (error, stream) => {
      if (error) reject(error);
      else resolve(stream);
    });
  });
}

async function scanXlsxSheet(options = {}) {
  const {
    zip,
    sheetEntry,
    sheet,
    sourceFile,
    sourceRegistry,
    date1904 = false,
    sharedStrings = [],
    themeColors = {},
    cancelToken = null
  } = options;
  const onSheetMeta = typeof options.onSheetMeta === 'function' ? options.onSheetMeta : null;
  const onRow = typeof options.onRow === 'function' ? options.onRow : null;
  const onCellLexical = typeof options.onCellLexical === 'function' ? options.onCellLexical : null;
  const maxRowBytes = options.maxRowBytes === undefined ? Infinity : options.maxRowBytes;
  // 只需前若干行模型的调用方（如写后复核只看表头）可限定 onRow 次数；之后的行照常解析、解码、
  // 校验样式与计数，只是在没有逐 cell 审计与行字节预算时不再构造冻结的行 / 单元格对象。
  const rowCallbackLimit = options.rowCallbackLimit === undefined ? Infinity : options.rowCallbackLimit;
  if (rowCallbackLimit !== Infinity && (!Number.isSafeInteger(rowCallbackLimit) || rowCallbackLimit < 1)) {
    throw new TypeError('scanXlsxSheet 的 rowCallbackLimit 必须是正整数');
  }
  if (maxRowBytes !== Infinity && (!Number.isSafeInteger(maxRowBytes) || maxRowBytes < 1)) throw new TypeError('XLSX 单行读取预算无效');

  if (!zip || !sheetEntry || !sourceRegistry) {
    throw new TypeError('scanXlsxSheet 需要 zip、sheetEntry 与 sourceRegistry');
  }
  if (cancelToken && cancelToken.cancelled) {
    throw new ToolboxXlsxCancelledError();
  }

  const stream = await openEntryStream(zip, sheetEntry);
  // 明细导入按 UTF-8 读取工作表；审计入口沿用其编码，保留当前 cell 的原始 XML。
  // SAX 与审计窗口消费同一解码字符串，位置按 UTF-16 计数，跨 chunk 不拆坏中文。
  if (onCellLexical) stream.setEncoding('utf8');
  let lexicalXml = '';
  let lexicalOffset = 0;
  const columns = [];
  let defaultColWidth = null;
  let defaultRowHeight = null;
  let defaultRowHidden = false;
  let customHeight = false;
  let sheetMeta = null;
  let sheetMetaEmitted = false;
  let previousRowIndex = 0;
  let currentRow = null;
  let currentCell = null;
  let collectingValue = false;
  let collectingFormula = false;
  let collectingInlineText = false;
  let currentInlineText = '';
  let insideInlineString = false;
  let phoneticDepth = 0;
  let rowCount = 0;
  let explicitCellCount = 0;
  let maxColumnIndex = -1;
  let sheetDataSeen = false;
  let sheetDataClosed = false;
  let sheetDataOpen = false;
  let sheetDataElementCount = 0;
  let worksheetSeen = false;
  let worksheetClosed = false;
  let worksheetElementCount = 0;
  let sheetFormatPrSeen = false;
  let colsSeen = false;
  let colsOpen = false;
  const elementStack = [];

  const sheetName = String(sheet && sheet.name ? sheet.name : '');
  const sheetIndex = Number.isInteger(sheet && sheet.sheetIndex) ? sheet.sheetIndex : 0;

  // 已通过校验的样式属性原文 → XF 号；只缓存成功结果，失败照常逐次报错。
  const verifiedStyleIds = new Map();
  function explicitStyleId(value, owner, coordinate = null) {
    if (value === undefined) return null;
    const cachedStyleId = verifiedStyleIds.get(value);
    if (cachedStyleId !== undefined) return cachedStyleId;
    const styleId = parseInteger(value);
    if (!Number.isInteger(styleId) || styleId < 0 || !sourceRegistry.hasXf(styleId)) {
      throw new ToolboxXlsxFormatError(`${owner}引用了不存在的 cell XF`, {
        sourceFile,
        sheetName,
        coordinate,
        sourceStyleId: value
      });
    }
    if (typeof value === 'string' && verifiedStyleIds.size < 4096) verifiedStyleIds.set(value, styleId);
    return styleId;
  }

  // 生效样式：effectiveStyleRef 在扫描期间只取决于入参（XF 绑定在扫描前已固定，列元数据不能出现在
  // sheetData 之后），按入参缓存冻结样式引用与 numFmt；解析失败不缓存，原错误照常抛出。
  const columnStyleIds = [];
  const cellStyleInfos = new Map();
  function cellStyleInfo(cellStyleId, rowStyleId, rowCustomFormat, columnIndex) {
    let columnStyleId = columnStyleIds[columnIndex];
    if (columnStyleId === undefined) {
      const column = findColumnMetadata(columns, columnIndex);
      columnStyleId = column ? column.sourceStyleId : null;
      columnStyleIds[columnIndex] = columnStyleId;
    }
    const cellKey = cellStyleId === null ? 0 : cellStyleId + 1;
    const rowKey = rowStyleId === null ? 0 : rowStyleId + 1;
    const columnKey = columnStyleId === null ? 0 : columnStyleId + 1;
    const cacheable = cellKey <= STYLE_KEY_LIMIT && rowKey <= STYLE_KEY_LIMIT && columnKey <= STYLE_KEY_LIMIT;
    const key = cacheable
      ? ((cellKey * (STYLE_KEY_LIMIT + 1) + rowKey) * 2 + (rowCustomFormat ? 1 : 0)) * (STYLE_KEY_LIMIT + 1) + columnKey
      : -1;
    if (cacheable) {
      const cached = cellStyleInfos.get(key);
      if (cached !== undefined) return cached;
    }
    const styleRef = freezeToolboxStyleRef(sourceRegistry.compoundRef(sourceRegistry.effectiveStyleRef({
      cellStyleId,
      rowStyleId,
      rowCustomFormat,
      columnStyleId
    })));
    const numFmt = sourceRegistry.get(styleRef.styleRef).numFmt;
    const info = { styleRef, sourceFormat: String(numFmt == null ? 'General' : numFmt) };
    if (cacheable) cellStyleInfos.set(key, info);
    return info;
  }

  const rowStyleRefs = new Map();
  function rowStyleRefFor(rowStyleId, rowCustomFormat) {
    const key = rowStyleId === null ? (rowCustomFormat ? -1 : -2) : rowStyleId * 2 + (rowCustomFormat ? 1 : 0);
    const cached = rowStyleRefs.get(key);
    if (cached !== undefined) return cached;
    const styleRef = freezeToolboxStyleRef(sourceRegistry.compoundRef(sourceRegistry.effectiveStyleRef({
      rowStyleId,
      rowCustomFormat
    })));
    rowStyleRefs.set(key, styleRef);
    return styleRef;
  }

  const sourceFileText = String(sourceFile || '');
  const sourceDateSystem = date1904 ? 1904 : 1900;
  const cellErrorContext = () => ({
    sourceFile,
    sheetName,
    rowIndex: currentRow.rowIndex,
    columnIndex: currentCell.columnIndex
  });

  function buildSheetMeta() {
    if (sheetMeta) return sheetMeta;
    sheetMeta = createToolboxSheetMeta({
      name: sheetName,
      sheetIndex,
      state: sheet && sheet.state ? sheet.state : 'visible',
      date1904,
      defaultColWidth,
      defaultRowHeight,
      defaultRowHidden,
      customHeight,
      columns,
      sourceRegistryId: sourceRegistry.sourceRegistryId,
      sourceFile,
      themeColors
    });
    return sheetMeta;
  }

  function emitSheetMeta() {
    if (sheetMetaEmitted) return;
    sheetMetaEmitted = true;
    const result = onSheetMeta ? onSheetMeta(buildSheetMeta()) : null;
    if (result && typeof result.then === 'function') {
      throw new TypeError('scanXlsxSheet 的 onSheetMeta 必须是同步回调');
    }
  }

  function finalizeCell() {
    if (!currentCell || !currentRow) return;
    const rawValue = currentCell.valueText;
    const inlineText = currentCell.inlineText;
    const columnIndex = currentCell.columnIndex;
    const decoded = decodeCellPayloadAt(
      currentCell.type,
      rawValue,
      inlineText,
      sharedStrings,
      currentCell.valueSeen,
      cellErrorContext
    );
    const styleInfo = cellStyleInfo(
      currentCell.sourceStyleId,
      currentRow.sourceStyleId,
      currentRow.customFormat,
      columnIndex
    );
    const rawLexicalValue = currentCell.type === 'inlineStr' ? inlineText : rawValue;
    const formulaLexical = currentCell.formulaSeen ? currentCell.formulaText : null;
    if (currentRow.materialized || columnIndex > 16383) {
      finalizeCellModel(decoded, styleInfo, rawLexicalValue, formulaLexical, columnIndex);
    }
    if (columnIndex <= currentRow.lastColumnIndex) currentRow.ascending = false;
    else currentRow.lastColumnIndex = columnIndex;
    currentRow.columnIndexes.push(columnIndex);
    currentRow.nextColumnIndex = columnIndex + 1;
    explicitCellCount += 1;
    maxColumnIndex = Math.max(maxColumnIndex, columnIndex);
    currentCell = null;
  }

  function finalizeCellModel(decoded, styleInfo, rawLexicalValue, formulaLexical, columnIndex) {
    // 无坐标的单元格可能顺延到 16384；交给 createToolboxCell 按原样报错。
    const cell = columnIndex <= 16383
      ? createScannedToolboxCell(
        rawLexicalValue,
        decoded.decodedSemanticValue,
        decoded.cellType,
        decoded.matchProjectionValue,
        currentCell.sourceStyleId,
        styleInfo.styleRef,
        sourceDateSystem,
        styleInfo.sourceFormat,
        sourceFileText,
        sheetName,
        currentRow.rowIndex,
        columnIndex,
        formulaLexical
      )
      : createToolboxCell({
        rawLexicalValue,
        cachedValue: decoded.decodedSemanticValue,
        cellType: decoded.cellType,
        decodedSemanticValue: decoded.decodedSemanticValue,
        matchProjectionValue: decoded.matchProjectionValue,
        sourceStyleId: currentCell.sourceStyleId,
        effectiveStyleRef: styleInfo.styleRef,
        isExplicitCell: true,
        sourceDateSystem,
        sourceFormat: styleInfo.sourceFormat,
        sourceFile,
        sourceSheet: sheetName,
        rowIndex: currentRow.rowIndex,
        columnIndex,
        hasFormula: currentCell.formulaSeen,
        formulaLexical
      });
    // 原始 body 交给调用方复用历史解析器；不能从 SAX 语义值反推 CDATA、注音或空标签。
    // 不改变中性 cell 的语义值，也不额外读取工作表。
    if (onCellLexical) {
      const end = currentCell.xmlSelfClosing ? currentCell.xmlBodyStart : parser.startTagPosition - 1;
      assertLexicalCellLength(end - currentCell.xmlBodyStart);
      const body = lexicalXml.slice(currentCell.xmlBodyStart - lexicalOffset, end - lexicalOffset);
      const result = onCellLexical(cell, { type: currentCell.type, body });
      if (result && typeof result.then === 'function') throw new TypeError('onCellLexical 必须是同步回调');
    }
    if (maxRowBytes !== Infinity) {
      const charge = 512 + Object.values(cell).reduce((total, value) => total + (typeof value === 'string' ? value.length * 2 : 0), 0);
      currentRow.chargedBytes = (currentRow.chargedBytes || 0) + charge;
      if (currentRow.chargedBytes > maxRowBytes) {
        throw Object.assign(new Error('当前 XLSX 行超过获批读取预算'), { code: 'EXECUTION_ROW_MEMORY_LIMIT' });
      }
    }
    currentRow.cells.push(cell);
  }

  function finalizeRow() {
    if (!currentRow) return;
    emitSheetMeta();
    if (currentCell) finalizeCell();
    if (!currentRow.materialized) {
      previousRowIndex = currentRow.rowIndex;
      rowCount += 1;
      if (cancelToken && cancelToken.cancelled) {
        throw new ToolboxXlsxCancelledError();
      }
      currentRow = null;
      return;
    }
    const rowStyleRef = rowStyleRefFor(currentRow.sourceStyleId, currentRow.customFormat);
    const rowInput = {
      cells: currentRow.cells,
      rowIndex: currentRow.rowIndex,
      height: currentRow.height,
      hidden: currentRow.hidden,
      outlineLevel: currentRow.outlineLevel,
      sourceStyleId: currentRow.sourceStyleId,
      effectiveStyleRef: rowStyleRef,
      customFormat: currentRow.customFormat,
      sourceFile: sourceFileText,
      sourceSheet: sheetName
    };
    // 单元格按列严格递增（常见情况）时无需原实现的去重排序；乱序时仍交给 createToolboxRow 排序。
    const row = currentRow.ascending
      ? createScannedToolboxRow(rowInput, rowStyleRef)
      : createToolboxRow(rowInput);
    previousRowIndex = currentRow.rowIndex;
    rowCount += 1;
    const result = onRow && rowCount <= rowCallbackLimit ? onRow(row, buildSheetMeta()) : null;
    if (result && typeof result.then === 'function') {
      throw new TypeError('scanXlsxSheet 的 onRow 必须是同步回调');
    }
    if (cancelToken && cancelToken.cancelled) {
      throw new ToolboxXlsxCancelledError();
    }
    currentRow = null;
  }

  function assertLexicalCellLength(length) {
    if (length < 0 || length > MAX_LEXICAL_CELL_XML_UTF16_UNITS) {
      throw new ToolboxXlsxFormatError('单元格原始 XML 超出审计读取预算', {
        sourceFile, sheetName, rowIndex: currentRow?.rowIndex, columnIndex: currentCell?.columnIndex,
        rawUtf16Length: length, maxRawUtf16Length: MAX_LEXICAL_CELL_XML_UTF16_UNITS
      });
    }
  }

  // 单元格扫描期间的可变状态。finalizeCell 把需要的值拷进冻结 cell 后即作废，整个工作表复用同一对象。
  const cellState = {
    columnIndex: 0,
    type: '',
    sourceStyleId: null,
    valueText: '',
    valueLexicalLength: 0,
    inlineText: '',
    xmlBodyStart: null,
    xmlSelfClosing: false,
    inlineSemanticLength: 0,
    formulaText: '',
    formulaLexicalLength: 0,
    formulaSeen: false,
    valueSeen: false,
    inlineStringSeen: false,
    inlineStringMode: null,
    plainInlineTextSeen: false,
    richRunTextSeen: false
  };

  // `<row>` 开标签的语义处理；通用事件路径与快路径共用，校验顺序与错误文案不变。
  function beginRow(rawReference, rawHeight, rawHidden, rawOutlineLevel, rawStyle, rawCustomFormat) {
    if (cancelToken && cancelToken.cancelled) throw new ToolboxXlsxCancelledError();
    if (currentRow) {
      throw new ToolboxXlsxFormatError('工作表存在嵌套 row，文件结构已损坏', { sourceFile, sheetName });
    }
    const explicitRowIndex = parseInteger(rawReference);
    const rowIndex = explicitRowIndex === null ? previousRowIndex + 1 : explicitRowIndex;
    if (rowIndex < 1 || rowIndex > 1048576) {
      throw new ToolboxXlsxFormatError('工作表行号超出 XLSX 范围', {
        sourceFile,
        sheetName,
        rowIndex
      });
    }
    if (rowIndex <= previousRowIndex) {
      throw new ToolboxXlsxFormatError('工作表 row r 必须严格递增', {
        sourceFile,
        sheetName,
        previousRowIndex,
        rowIndex
      });
    }
    currentRow = {
      rowIndex,
      height: parsePositiveLayoutNumber(
        rawHeight,
        'row.ht',
        { sourceFile, sheetName, rowIndex }
      ),
      hidden: parseBoolean(rawHidden),
      outlineLevel: parseOutlineLevel(
        rawOutlineLevel,
        '行',
        { sourceFile, sheetName, rowIndex }
      ),
      sourceStyleId: explicitStyleId(rawStyle, '行样式', String(rowIndex)),
      customFormat: parseBoolean(rawCustomFormat),
      cells: [],
      columnIndexes: [],
      // 超过 rowCallbackLimit 且无需逐 cell 审计 / 行字节计费时，不构造该行的模型对象。
      materialized: rowCount < rowCallbackLimit || onCellLexical !== null || maxRowBytes !== Infinity,
      lastColumnIndex: -1,
      ascending: true,
      nextColumnIndex: 0
    };
  }

  // `<c>` 开标签的语义处理；通用事件路径与快路径共用，校验顺序与错误文案不变。
  function beginCell(rawReference, rawStyle, rawType, selfClosing) {
    if (currentCell) {
      throw new ToolboxXlsxFormatError('工作表存在嵌套 cell，文件结构已损坏', { sourceFile, sheetName });
    }
    const hasExplicitReference = rawReference !== undefined && rawReference !== null;
    const reference = hasExplicitReference ? parseCellReference(rawReference) : null;
    if (hasExplicitReference && !reference) {
      throw new ToolboxXlsxFormatError('单元格坐标无效或超出 XLSX 范围', {
        sourceFile,
        sheetName,
        cellReference: rawReference
      });
    }
    if (reference && reference.rowIndex !== currentRow.rowIndex) {
      throw new ToolboxXlsxFormatError('单元格坐标行号与所属 row 不一致', {
        sourceFile,
        sheetName,
        cellReference: rawReference,
        rowIndex: currentRow.rowIndex
      });
    }
    const columnIndex = reference ? reference.columnIndex : currentRow.nextColumnIndex;
    if (columnIndex <= currentRow.lastColumnIndex && rowHasColumn(currentRow.columnIndexes, columnIndex)) {
      throw new ToolboxXlsxFormatError('同一 row 内存在重复单元格坐标', {
        sourceFile,
        sheetName,
        rowIndex: currentRow.rowIndex,
        columnIndex,
        cellReference: rawReference || null
      });
    }
    const type = rawType === undefined || rawType === null
      ? ''
      : (OOXML_CELL_TYPES.has(rawType) ? rawType : parseCellType(rawType, {
        sourceFile,
        sheetName,
        rowIndex: currentRow.rowIndex,
        columnIndex
      }));
    const sourceStyleId = explicitStyleId(
      rawStyle,
      '单元格样式',
      rawReference || `${currentRow.rowIndex}:${reference ? reference.columnIndex : currentRow.nextColumnIndex}`
    );
    const cell = cellState;
    cell.columnIndex = columnIndex;
    cell.type = type;
    cell.sourceStyleId = sourceStyleId;
    cell.valueText = '';
    cell.valueLexicalLength = 0;
    cell.inlineText = '';
    cell.xmlBodyStart = onCellLexical ? parser.position : null;
    cell.xmlSelfClosing = selfClosing;
    cell.inlineSemanticLength = 0;
    cell.formulaText = '';
    cell.formulaLexicalLength = 0;
    cell.formulaSeen = false;
    cell.valueSeen = false;
    cell.inlineStringSeen = false;
    cell.inlineStringMode = null;
    cell.plainInlineTextSeen = false;
    cell.richRunTextSeen = false;
    currentCell = cell;
  }

  // `<v>` 开标签的语义处理（父元素与命名空间已由调用方保证）。
  function beginValue() {
    if (currentCell.type === 'inlineStr') {
      throw new ToolboxXlsxFormatError('inlineStr 单元格不能声明 v 缓存值', {
        sourceFile,
        sheetName,
        rowIndex: currentRow.rowIndex,
        columnIndex: currentCell.columnIndex
      });
    }
    if (currentCell.valueSeen) {
      throw new ToolboxXlsxFormatError('同一单元格重复声明 v 缓存值', {
        sourceFile,
        sheetName,
        rowIndex: currentRow.rowIndex,
        columnIndex: currentCell.columnIndex
      });
    }
    if (currentCell.inlineStringSeen) {
      throw new ToolboxXlsxFormatError('同一单元格不能同时声明 v 与 is', {
        sourceFile,
        sheetName,
        rowIndex: currentRow.rowIndex,
        columnIndex: currentCell.columnIndex
      });
    }
    currentCell.valueSeen = true;
    collectingValue = true;
  }

  function appendValueText(text) {
    currentCell.valueText += text;
    currentCell.valueLexicalLength += text.length;
    if (currentCell.valueLexicalLength > EXCEL_ST_XSTRING_MAX_RAW_UTF16_UNITS) {
      throw new ToolboxXlsxFormatError(
        '单元格缓存值词法长度超过 Excel 单元格读取上限',
        {
          sourceFile,
          sheetName,
          rowIndex: currentRow.rowIndex,
          columnIndex: currentCell.columnIndex,
          rawUtf16Length: currentCell.valueLexicalLength,
          maxRawUtf16Length: EXCEL_ST_XSTRING_MAX_RAW_UTF16_UNITS
        }
      );
    }
  }

  // 单元格快路径：只认 `<c r s t/>` 与 `<c r s t><v>文本</v></c>` 两种形态（属性仅限精确小写的
  // r/s/t、各至多一次、值为 ASCII 字母数字；文本不含 `<`、`&` 且不超过 FAST_CELL_TEXT_MAX）。
  // 这些形态在逐事件路径上只会触发 beginCell → beginValue → appendValueText → finalizeCell，
  // 大小写、命名空间、父子结构校验必然通过；其他任何形态或状态都返回 -1 交回通用路径。
  let fastNamespaceScope = null;
  let fastReference;
  let fastStyle;
  let fastType;
  let fastText = null;

  // 无前缀元素的 URI 取法与分词器 _emitOpenTag 一致；同一作用域对象的结果不变，按身份缓存。
  function fastNamespaceAllowed(nsScope) {
    if (nsScope === fastNamespaceScope) return true;
    if (!namespaceAllowed(nsScope[''] || '', SPREADSHEETML_NAMESPACES)) return false;
    fastNamespaceScope = nsScope;
    return true;
  }

  function matchFastMarkup(buf, lt, len, nsScope) {
    fastKind = buf.charCodeAt(lt + 1);
    return fastKind === 99 ? matchFastCell(buf, lt, len, nsScope) : matchFastRow(buf, lt, len, nsScope);
  }

  function applyFastMarkup() {
    if (fastKind === 99) applyFastCell();
    else applyFastRow();
  }

  // 行开标签快路径：`<row` + 属性 + `>`。属性名限于下列精确拼写（大小写变体交回通用路径报错），
  // 或前缀已绑定、非 xmlns 的前缀属性（例如 x14ac:dyDescent，行处理本就忽略）；不得重复、不得声明
  // 命名空间，值只含 ASCII 字母数字与 `.:+-`。元素保持打开，`</row>` 仍走通用路径收尾。
  let fastRowReference;
  let fastRowHeight;
  let fastRowHidden;
  let fastRowOutlineLevel;
  let fastRowStyle;
  let fastRowCustomFormat;
  let fastRowPrefixScope = null;
  let fastRowPrefix = '';
  const fastRowNames = [];

  function matchFastRow(buf, lt, len, nsScope) {
    if (currentRow || currentCell || collectingValue || collectingFormula || collectingInlineText ||
        insideInlineString || phoneticDepth !== 0 || !sheetDataOpen || elementStack.length !== 2 ||
        elementStack[1] !== 'sheetdata' || buf.charCodeAt(lt + 2) !== 111 || buf.charCodeAt(lt + 3) !== 119 ||
        !fastNamespaceAllowed(nsScope)) {
      return -1;
    }
    let reference;
    let height;
    let hidden;
    let outlineLevel;
    let style;
    let customFormat;
    fastRowNames.length = 0;
    let index = lt + 4;
    for (;;) {
      if (index >= len) return -1;
      let code = buf.charCodeAt(index);
      if (code === 62) {
        fastRowReference = reference;
        fastRowHeight = height;
        fastRowHidden = hidden;
        fastRowOutlineLevel = outlineLevel;
        fastRowStyle = style;
        fastRowCustomFormat = customFormat;
        fastPathHooks.lastTagStart = lt;
        fastPathHooks.openTagName = 'row';
        return index + 1;
      }
      if (!isXmlWhitespaceCode(code)) return -1;
      index += 1;
      while (index < len && isXmlWhitespaceCode(buf.charCodeAt(index))) index += 1;
      if (index >= len) return -1;
      code = buf.charCodeAt(index);
      if (code === 62) continue;
      if (!isAsciiLetterCode(code)) return -1;
      const nameStart = index;
      let colon = -1;
      index += 1;
      for (; index < len; index += 1) {
        code = buf.charCodeAt(index);
        if (isAsciiAlphanumericCode(code)) continue;
        if (code === 58 && colon < 0) {
          colon = index;
          continue;
        }
        break;
      }
      if (index + 1 >= len || code !== 61) return -1;
      const quote = buf.charCodeAt(index + 1);
      if (quote !== 34 && quote !== 39) return -1;
      const name = buf.slice(nameStart, index);
      if (fastRowNames.indexOf(name) >= 0) return -1;
      fastRowNames.push(name);
      if (colon >= 0) {
        const prefix = buf.slice(nameStart, colon);
        if (colon === index - 1 || prefix === 'xmlns') return -1;
        if (nsScope !== fastRowPrefixScope || prefix !== fastRowPrefix) {
          if (!nsScope[prefix]) return -1;
          fastRowPrefixScope = nsScope;
          fastRowPrefix = prefix;
        }
      } else if (!FAST_ROW_ATTRIBUTE_NAMES.has(name)) {
        return -1;
      }
      const valueStart = index + 2;
      let valueEnd = valueStart;
      while (valueEnd < len && isFastRowValueCode(buf.charCodeAt(valueEnd))) valueEnd += 1;
      if (valueEnd >= len || buf.charCodeAt(valueEnd) !== quote) return -1;
      if (colon < 0) {
        const value = buf.slice(valueStart, valueEnd);
        if (name === 'r') reference = value;
        else if (name === 'ht') height = value;
        else if (name === 'hidden') hidden = value;
        else if (name === 'outlineLevel') outlineLevel = value;
        else if (name === 's') style = value;
        else if (name === 'customFormat') customFormat = value;
      }
      index = valueEnd + 1;
    }
  }

  function applyFastRow() {
    elementStack.push('row');
    beginRow(fastRowReference, fastRowHeight, fastRowHidden, fastRowOutlineLevel, fastRowStyle, fastRowCustomFormat);
  }

  function matchFastCell(buf, lt, len, nsScope) {
    if (currentCell || !currentRow || collectingValue || collectingFormula || collectingInlineText ||
        insideInlineString || phoneticDepth !== 0 || elementStack.length !== 3 ||
        elementStack[2] !== 'row' || !fastNamespaceAllowed(nsScope)) {
      return -1;
    }
    let reference;
    let style;
    let type;
    let index = lt + 2;
    for (;;) {
      if (index >= len) return -1;
      let code = buf.charCodeAt(index);
      if (code === 32 || code === 10 || code === 13 || code === 9) {
        index += 1;
        while (index < len && isXmlWhitespaceCode(buf.charCodeAt(index))) index += 1;
        if (index + 1 >= len) return -1;
        code = buf.charCodeAt(index);
        if ((code === 114 || code === 115 || code === 116) && buf.charCodeAt(index + 1) === 61) {
          const quote = buf.charCodeAt(index + 2);
          if (quote !== 34 && quote !== 39) return -1;
          const valueStart = index + 3;
          let valueEnd = valueStart;
          while (valueEnd < len && isAsciiAlphanumericCode(buf.charCodeAt(valueEnd))) valueEnd += 1;
          if (valueEnd === valueStart || valueEnd >= len || buf.charCodeAt(valueEnd) !== quote) return -1;
          const value = buf.slice(valueStart, valueEnd);
          if (code === 114) {
            if (reference !== undefined) return -1;
            reference = value;
          } else if (code === 115) {
            if (style !== undefined) return -1;
            style = value;
          } else {
            if (type !== undefined) return -1;
            type = value;
          }
          index = valueEnd + 1;
          continue;
        }
      }
      if (code === 47) {
        if (index + 1 >= len || buf.charCodeAt(index + 1) !== 62) return -1;
        fastReference = reference;
        fastStyle = style;
        fastType = type;
        fastText = null;
        fastPathHooks.lastTagStart = lt;
        fastPathHooks.openTagName = null;
        return index + 2;
      }
      if (code !== 62 || buf.charCodeAt(index + 1) !== 60 || buf.charCodeAt(index + 2) !== 118 ||
          buf.charCodeAt(index + 3) !== 62) {
        return -1;
      }
      const textStart = index + 4;
      const textEnd = buf.indexOf('<', textStart);
      if (textEnd < 0 || textEnd - textStart > FAST_CELL_TEXT_MAX || !buf.startsWith('</v></c>', textEnd)) return -1;
      const text = buf.slice(textStart, textEnd);
      if (text.indexOf('&') >= 0) return -1;
      fastReference = reference;
      fastStyle = style;
      fastType = type;
      fastText = text;
      fastPathHooks.lastTagStart = textEnd + 4;
      fastPathHooks.openTagName = null;
      return textEnd + 8;
    }
  }

  let fastKind = 0;
  const fastPathHooks = {
    leadCodes: [99, 114],
    match: matchFastMarkup,
    apply: applyFastMarkup,
    lastTagStart: -1,
    openTagName: null
  };

  function applyFastCell() {
    beginCell(fastReference, fastStyle, fastType, fastText === null);
    if (fastText !== null) {
      beginValue();
      if (fastText !== '') appendValueText(fastText);
      collectingValue = false;
    }
    finalizeCell();
  }

  function handleOpenTag(node) {
    const elementName = validateWorksheetElementCase(node, { sourceFile, sheetName });
    const name = elementName.normalizedName;
    validateConsumedAttributeCase(
      node.attributes,
      elementName.canonicalName,
      { sourceFile, sheetName }
    );
    const attrs = normalizedAttributes(node.attributes);
    const parentName = elementStack.length > 0
      ? elementStack[elementStack.length - 1]
      : null;
    const depth = elementStack.length;

    if (SPREADSHEETML_RECOGNIZED_ELEMENTS.has(name) &&
        !namespaceAllowed(node.uri, SPREADSHEETML_NAMESPACES)) {
      throw new ToolboxXlsxFormatError(
        `工作表元素 ${name} 不属于受支持的 SpreadsheetML 命名空间`,
        {
          sourceFile,
          sheetName,
          namespaceUri: node.uri || ''
        }
      );
    }

    if (collectingValue || collectingFormula || collectingInlineText) {
      const container = collectingValue ? 'v' : (collectingFormula ? 'f' : 't');
      throw new ToolboxXlsxFormatError(`${container} 只能包含文本，不能嵌套子元素`, {
        sourceFile,
        sheetName,
        childElement: name
      });
    }

    if (depth === 0) {
      if (name !== 'worksheet') {
        throw new ToolboxXlsxFormatError('工作表 XML 根元素必须为 worksheet', {
          sourceFile,
          sheetName,
          rootElement: name
        });
      }
      if (worksheetElementCount !== 0 || worksheetClosed) {
        throw new ToolboxXlsxFormatError('worksheet 必须是工作表 XML 的唯一根元素', {
          sourceFile,
          sheetName
        });
      }
      worksheetElementCount += 1;
      worksheetSeen = true;
    } else if (name === 'worksheet') {
      throw new ToolboxXlsxFormatError('worksheet 必须是工作表 XML 的唯一根元素', {
        sourceFile,
        sheetName,
        parentElement: parentName
      });
    }

    if (name === 'sheetformatpr') {
      if (parentName !== 'worksheet' || depth !== 1 || sheetFormatPrSeen) {
        throw new ToolboxXlsxFormatError(
          'sheetFormatPr 必须是 worksheet 的唯一直接子元素',
          { sourceFile, sheetName, parentElement: parentName }
        );
      }
      sheetFormatPrSeen = true;
    } else if (name === 'cols') {
      if (parentName !== 'worksheet' || depth !== 1 || colsSeen) {
        throw new ToolboxXlsxFormatError('cols 必须是 worksheet 的唯一直接子元素', {
          sourceFile,
          sheetName,
          parentElement: parentName
        });
      }
      if (sheetDataSeen) {
        throw new ToolboxXlsxFormatError('列元数据出现在 sheetData 之后，无法安全确定输出布局', {
          sourceFile,
          sheetName
        });
      }
      colsSeen = true;
      colsOpen = true;
    } else if (name === 'col' &&
               (!colsOpen || parentName !== 'cols' || depth !== 2)) {
      throw new ToolboxXlsxFormatError('col 必须是合法 cols 的直接子元素', {
        sourceFile,
        sheetName,
        parentElement: parentName
      });
    } else if (name === 'sheetdata') {
      if (parentName !== 'worksheet' || depth !== 1) {
        throw new ToolboxXlsxFormatError('sheetData 必须是 worksheet 的直接子元素', {
          sourceFile,
          sheetName,
          parentElement: parentName
        });
      }
      if (sheetDataElementCount !== 0) {
        throw new ToolboxXlsxFormatError('worksheet 必须包含唯一一个 sheetData', {
          sourceFile,
          sheetName
        });
      }
      sheetDataElementCount += 1;
      sheetDataSeen = true;
      sheetDataOpen = true;
    } else if (name === 'row' &&
               (!sheetDataOpen || parentName !== 'sheetdata' || depth !== 2)) {
      throw new ToolboxXlsxFormatError('row 必须是合法 sheetData 的直接子元素', {
        sourceFile,
        sheetName,
        parentElement: parentName
      });
    } else if (name === 'c' &&
               (!currentRow || parentName !== 'row' || depth !== 3)) {
      throw new ToolboxXlsxFormatError('c 必须是合法 row 的直接子元素', {
        sourceFile,
        sheetName,
        parentElement: parentName
      });
    } else if (['v', 'f', 'is'].includes(name) &&
               (!currentCell || parentName !== 'c' || depth !== 4)) {
      throw new ToolboxXlsxFormatError(`${name} 必须是合法 c 的直接子元素`, {
        sourceFile,
        sheetName,
        parentElement: parentName
      });
    } else if ((name === 'rph' || name === 'phoneticpr') && insideInlineString &&
               (parentName !== 'is' || depth !== 5)) {
      throw new ToolboxXlsxFormatError(`${name} 必须是合法 is 的直接子元素`, {
        sourceFile,
        sheetName,
        parentElement: parentName
      });
    } else if (name === 'r' && insideInlineString) {
      if (parentName !== 'is' || depth !== 5) {
        throw new ToolboxXlsxFormatError('富文本 r 必须是合法 is 的直接子元素', {
          sourceFile,
          sheetName,
          parentElement: parentName
        });
      }
      currentCell.inlineStringMode = 'rich';
      currentCell.richRunTextSeen = false;
    } else if (name === 't' && insideInlineString && phoneticDepth === 0) {
      const grandParentName = elementStack.length > 1
        ? elementStack[elementStack.length - 2]
        : null;
      if (!(
        (parentName === 'is' && depth === 5) ||
        (parentName === 'r' && grandParentName === 'is' && depth === 6)
      )) {
        throw new ToolboxXlsxFormatError('富文本 t 必须位于合法 is 或 r 内', {
          sourceFile,
          sheetName,
          parentElement: parentName
        });
      }
      if (parentName === 'is') {
        if (currentCell.plainInlineTextSeen) {
          throw new ToolboxXlsxFormatError('同一 is 只能声明一个直属 plain t', {
            sourceFile,
            sheetName,
            rowIndex: currentRow.rowIndex,
            columnIndex: currentCell.columnIndex
          });
        }
        currentCell.inlineStringMode = 'plain';
        currentCell.plainInlineTextSeen = true;
      } else {
        if (currentCell.richRunTextSeen) {
          throw new ToolboxXlsxFormatError('每个 rich r 只能声明一个直属 t', {
            sourceFile,
            sheetName,
            rowIndex: currentRow.rowIndex,
            columnIndex: currentCell.columnIndex
          });
        }
        currentCell.inlineStringMode = 'rich';
        currentCell.richRunTextSeen = true;
      }
    }

    elementStack.push(name);

    if (name === 'worksheet') {
      return;
    }

    if (name === 'sheetformatpr') {
      if (sheetDataSeen) {
        throw new ToolboxXlsxFormatError('sheetFormatPr 出现在 sheetData 之后，无法安全确定输出布局', {
          sourceFile,
          sheetName
        });
      }
      defaultColWidth = parsePositiveLayoutNumber(
        attrs.defaultcolwidth,
        'defaultColWidth',
        { sourceFile, sheetName }
      );
      defaultRowHeight = parsePositiveLayoutNumber(
        attrs.defaultrowheight,
        'defaultRowHeight',
        { sourceFile, sheetName }
      );
      defaultRowHidden = parseBoolean(attrs.zeroheight);
      customHeight = parseBoolean(attrs.customheight);
      return;
    }

    if (name === 'col') {
      if (sheetDataSeen) {
        throw new ToolboxXlsxFormatError('列元数据出现在 sheetData 之后，无法安全确定输出布局', {
          sourceFile,
          sheetName
        });
      }
      const min = parseInteger(attrs.min);
      const max = parseInteger(attrs.max);
      if (!Number.isInteger(min) || !Number.isInteger(max) || min < 1 || max < min || max > 16384) {
        throw new ToolboxXlsxFormatError('工作表列范围无效', {
          sourceFile,
          sheetName,
          min: attrs.min,
          max: attrs.max
        });
      }
      const sourceStyleId = explicitStyleId(attrs.style, '列样式', `${min}:${max}`);
      columns.push({
        minColumnIndex: min - 1,
        maxColumnIndex: max - 1,
        width: parsePositiveLayoutNumber(
          attrs.width,
          'col.width',
          { sourceFile, sheetName, min, max }
        ),
        hidden: parseBoolean(attrs.hidden),
        outlineLevel: parseOutlineLevel(
          attrs.outlinelevel,
          '列',
          { sourceFile, sheetName, min, max }
        ),
        sourceStyleId,
        effectiveStyleRef: sourceRegistry.compoundRef(sourceRegistry.styleRefForXf(sourceStyleId)),
        customWidth: parseBoolean(attrs.customwidth)
      });
      return;
    }

    if (name === 'sheetdata') {
      emitSheetMeta();
      return;
    }

    if (name === 'row') {
      beginRow(attrs.r, attrs.ht, attrs.hidden, attrs.outlinelevel, attrs.s, attrs.customformat);
      return;
    }

    if (name === 'c' && currentRow) {
      beginCell(attrs.r, attrs.s, attrs.t, node.isSelfClosing === true);
      return;
    }

    if (!currentCell) return;
    if (name === 'v') beginValue();
    else if (name === 'f') {
      if (currentCell.type === 'inlineStr') {
        throw new ToolboxXlsxFormatError('inlineStr 单元格不能声明 f 公式', {
          sourceFile,
          sheetName,
          rowIndex: currentRow.rowIndex,
          columnIndex: currentCell.columnIndex
        });
      }
      if (currentCell.formulaSeen) {
        throw new ToolboxXlsxFormatError('同一单元格重复声明 f 公式', {
          sourceFile,
          sheetName,
          rowIndex: currentRow.rowIndex,
          columnIndex: currentCell.columnIndex
        });
      }
      if (currentCell.valueSeen || currentCell.inlineStringSeen) {
        throw new ToolboxXlsxFormatError('单元格 f 必须位于 v/is 之前且不能与 is 并存', {
          sourceFile,
          sheetName,
          rowIndex: currentRow.rowIndex,
          columnIndex: currentCell.columnIndex
        });
      }
      currentCell.formulaSeen = true;
      collectingFormula = true;
    }
    else if (name === 'is') {
      if (currentCell.type !== 'inlineStr') {
        throw new ToolboxXlsxFormatError('is 仅允许用于 t="inlineStr" 的单元格', {
          sourceFile,
          sheetName,
          rowIndex: currentRow.rowIndex,
          columnIndex: currentCell.columnIndex,
          cellType: currentCell.type || '(default n)'
        });
      }
      if (currentCell.inlineStringSeen) {
        throw new ToolboxXlsxFormatError('同一单元格重复声明 is 内联字符串', {
          sourceFile,
          sheetName,
          rowIndex: currentRow.rowIndex,
          columnIndex: currentCell.columnIndex
        });
      }
      if (currentCell.valueSeen || currentCell.formulaSeen) {
        throw new ToolboxXlsxFormatError('同一单元格不能同时声明 is 与 f/v', {
          sourceFile,
          sheetName,
          rowIndex: currentRow.rowIndex,
          columnIndex: currentCell.columnIndex
        });
      }
      currentCell.inlineStringSeen = true;
      insideInlineString = true;
    }
    else if (name === 'rph' || name === 'phoneticpr') phoneticDepth += 1;
    else if (name === 'r' && insideInlineString) currentCell.richRunTextSeen = false;
    else if (name === 't' && insideInlineString && phoneticDepth === 0) {
      collectingInlineText = true;
      currentInlineText = '';
    }
  }

  function collectText(text) {
    if (!currentCell) return;
    if (collectingValue) appendValueText(text);
    if (collectingFormula) {
      currentCell.formulaText += text;
      currentCell.formulaLexicalLength += text.length;
      if (currentCell.formulaLexicalLength > EXCEL_FORMULA_MAX_UTF16_UNITS) {
        throw new ToolboxXlsxFormatError(
          '单元格公式词法长度超过 Excel 上限',
          {
            sourceFile,
            sheetName,
            rowIndex: currentRow.rowIndex,
            columnIndex: currentCell.columnIndex,
            formulaUtf16Length: currentCell.formulaLexicalLength,
            maxFormulaUtf16Length: EXCEL_FORMULA_MAX_UTF16_UNITS
          }
        );
      }
    }
    if (collectingInlineText) {
      currentInlineText += text;
      try {
        assertExcelStXstringRawLength(currentInlineText);
      } catch (error) {
        throw new ToolboxXlsxFormatError(
          '内联字符串 t 词法长度超过 Excel 单元格读取上限',
          {
            sourceFile,
            sheetName,
            rowIndex: currentRow.rowIndex,
            columnIndex: currentCell.columnIndex,
            cause: error.message
          }
        );
      }
    }
  }
  function handleCloseTag(rawName) {
    const name = validateWorksheetElementCase(
      rawName,
      { sourceFile, sheetName }
    ).normalizedName;
    const openName = elementStack.pop();
    if (openName !== name) {
      throw new ToolboxXlsxFormatError('工作表 XML 元素闭合顺序无效', {
        sourceFile,
        sheetName,
        openElement: openName || null,
        closeElement: name
      });
    }
    if (name === 'v') collectingValue = false;
    else if (name === 'f') collectingFormula = false;
    else if (name === 't') {
      if (collectingInlineText && currentCell) {
        try {
          const decodedText = decodeExcelStXstring(currentInlineText);
          currentCell.inlineSemanticLength += decodedText.length;
          if (currentCell.inlineSemanticLength > EXCEL_CELL_TEXT_MAX_UTF16_UNITS) {
            throw new Error(
              `内联字符串超过 ${EXCEL_CELL_TEXT_MAX_UTF16_UNITS} 个 UTF-16 code unit`
            );
          }
          currentCell.inlineText += decodedText;
        } catch (error) {
          throw new ToolboxXlsxFormatError(
            '内联字符串包含无效的 ST_Xstring/UTF-16 文本',
            {
              sourceFile,
              sheetName,
              rowIndex: currentRow && currentRow.rowIndex,
              columnIndex: currentCell.columnIndex,
              cause: error.message
            }
          );
        }
      }
      currentInlineText = '';
      collectingInlineText = false;
    }
    else if (name === 'r' && currentCell) currentCell.richRunTextSeen = false;
    else if (name === 'rph' || name === 'phoneticpr') phoneticDepth = Math.max(0, phoneticDepth - 1);
    else if (name === 'is') insideInlineString = false;
    else if (name === 'c') finalizeCell();
    else if (name === 'row') finalizeRow();
    else if (name === 'sheetdata') {
      sheetDataOpen = false;
      sheetDataClosed = true;
    } else if (name === 'cols') {
      colsOpen = false;
    } else if (name === 'worksheet') {
      worksheetClosed = true;
    }
  }

  // 事件、命名空间与严格错误判定与原 sax.createStream(true, { xmlns: true }) 一致，见 strict-xml-tokenizer。
  const parser = createStrictXmlTokenizer({
    onOpenTag: handleOpenTag,
    onCloseTag: handleCloseTag,
    onText: collectText,
    onCdata: collectText,
    fastPath: options.fastPath === false || onCellLexical ? null : fastPathHooks
  });

  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      stream.removeAllListeners('data');
      stream.removeAllListeners('end');
      stream.removeAllListeners('error');
    };
    const fail = (error) => {
      if (settled) return;
      settled = true;
      try { stream.destroy(); } catch (_error) {}
      cleanup();
      reject(error);
    };
    const finish = () => {
      if (settled) return;
      try {
        if (!worksheetSeen || !worksheetClosed || worksheetElementCount !== 1 ||
            !sheetDataSeen || !sheetDataClosed || sheetDataOpen || sheetDataElementCount !== 1 ||
            colsOpen || elementStack.length !== 0 ||
            currentCell || currentRow || collectingValue || collectingFormula ||
            collectingInlineText || insideInlineString || phoneticDepth !== 0) {
          throw new ToolboxXlsxFormatError('工作表 XML 未完整闭合，文件可能已截断或损坏', {
            sourceFile,
            sheetName
          });
        }
        settled = true;
        emitSheetMeta();
        cleanup();
        resolve({
          sheetMeta: buildSheetMeta(),
          rowCount,
          explicitCellCount,
          maxColumnIndex,
          cancelled: false
        });
      } catch (error) {
        fail(error);
      }
    };

    // 只有 XML 语法错误需要翻译；事件处理器抛出的业务/格式错误原样失败。
    const failParser = (error) => {
      if (!(error instanceof StrictXmlSyntaxError)) {
        fail(error);
        return;
      }
      if (worksheetClosed) {
        fail(new ToolboxXlsxFormatError('worksheet 必须是工作表 XML 的唯一根元素', {
          sourceFile,
          sheetName,
          parserMessage: error && error.message ? error.message : String(error)
        }));
        return;
      }
      fail(new ToolboxXlsxFormatError('工作表 XML 无效、未完整闭合或已经截断', {
        sourceFile,
        sheetName,
        parserMessage: error && error.message ? error.message : String(error)
      }));
    };
    stream.on('data', (chunk) => {
      if (settled) return;
      if (cancelToken && cancelToken.cancelled) {
        fail(new ToolboxXlsxCancelledError());
        return;
      }
      try {
        if (onCellLexical) lexicalXml += chunk;
        parser.write(chunk);
        if (onCellLexical) {
          const retainedStart = currentCell ? currentCell.xmlBodyStart : parser.position;
          lexicalXml = lexicalXml.slice(retainedStart - lexicalOffset);
          lexicalOffset = retainedStart;
          assertLexicalCellLength(lexicalXml.length);
        }
      } catch (error) {
        failParser(error);
      }
    });
    stream.on('end', () => {
      if (settled) return;
      try {
        parser.end();
        finish();
      } catch (error) {
        failParser(error);
      }
    });
    stream.on('error', fail);
  });
}

module.exports = {
  ToolboxXlsxCancelledError,
  ToolboxXlsxFormatError,
  columnLettersToIndex,
  decodeCellPayload,
  findColumnMetadata,
  legacyNumericProjection,
  parseCellReference,
  scanXlsxSheet
};
