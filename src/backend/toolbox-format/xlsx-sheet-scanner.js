'use strict';

const sax = require('sax');
const {
  createToolboxCell,
  createToolboxRow,
  createToolboxSheetMeta
} = require('./model');
const {
  classifyNumericOutput,
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

function validateWorksheetElementCase(nodeOrName, context = {}) {
  const exactName = exactLocalName(nodeOrName);
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
  for (const [rawName, rawAttribute] of Object.entries(attributes || {})) {
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

function parseCellReference(reference) {
  const match = String(reference || '').toUpperCase().match(/^([A-Z]{1,3})([1-9]\d*)$/);
  if (!match) return null;
  const columnIndex = columnLettersToIndex(match[1]);
  const rowIndex = Number.parseInt(match[2], 10);
  if (columnIndex < 0 || rowIndex < 1 || rowIndex > 1048576) return null;
  return { columnIndex, rowIndex };
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

function decodeCellPayload({
  type,
  rawValue,
  inlineText,
  sharedStrings,
  valueSeen = false,
  context = {}
}) {
  const normalizedType = type === undefined || type === null ? '' : String(type);
  if (normalizedType !== '' && !OOXML_CELL_TYPES.has(normalizedType)) {
    throw new ToolboxXlsxFormatError('单元格声明了不支持的 OOXML 数据类型', {
      ...context,
      cellType: type
    });
  }
  if (normalizedType === 's') {
    const lexicalIndex = String(rawValue || '').trim();
    const index = /^\d+$/.test(lexicalIndex) ? Number.parseInt(lexicalIndex, 10) : -1;
    if (!Number.isSafeInteger(index) || index < 0 || index >= sharedStrings.length ||
        sharedStrings[index] === undefined) {
      throw new ToolboxXlsxFormatError('共享字符串索引越界或无效，无法安全读取单元格', {
        ...context,
        sharedStringIndex: rawValue,
        sharedStringCount: sharedStrings.length
      });
    }
    const decoded = sharedStrings[index];
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
        ...context,
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
        ...context,
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
        ...context,
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
        ...context,
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
        ...context,
        rawValue
      });
    }
    const parsedDate = classification.inExcelRange
      ? parseOoxmlWallClock(rawValue)
      : null;
    if (classification.inExcelRange && !parsedDate) {
      throw new ToolboxXlsxFormatError('日期单元格缓存值与声明类型不一致', {
        ...context,
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

  const parsed = parseDecimalLexical(rawValue);
  if (!parsed) {
    throw new ToolboxXlsxFormatError('数值单元格缓存值与声明类型不一致', {
      ...context,
      rawValue
    });
  }
  const numericOutput = classifyNumericOutput(rawValue, 'General');
  return {
    cellType: 'number',
    decodedSemanticValue: numericOutput && numericOutput.outputType === 'number'
      ? numericOutput.outputValue
      : parsed.canonical,
    matchProjectionValue: legacyNumericProjection(rawValue)
  };
}

function openEntryStream(zip, entry) {
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (error, stream) => {
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

  if (!zip || !sheetEntry || !sourceRegistry) {
    throw new TypeError('scanXlsxSheet 需要 zip、sheetEntry 与 sourceRegistry');
  }
  if (cancelToken && cancelToken.cancelled) {
    throw new ToolboxXlsxCancelledError();
  }

  const stream = await openEntryStream(zip, sheetEntry);
  const columns = [];
  let defaultColWidth = null;
  let defaultRowHeight = null;
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

  function explicitStyleId(value, owner, coordinate = null) {
    if (value === undefined) return null;
    const styleId = parseInteger(value);
    if (!Number.isInteger(styleId) || styleId < 0 || !sourceRegistry.hasXf(styleId)) {
      throw new ToolboxXlsxFormatError(`${owner}引用了不存在的 cell XF`, {
        sourceFile,
        sheetName,
        coordinate,
        sourceStyleId: value
      });
    }
    return styleId;
  }

  function effectiveRefFor({ cellStyleId, rowStyleId, rowCustomFormat, columnIndex }) {
    const column = findColumnMetadata(columns, columnIndex);
    const styleRef = sourceRegistry.effectiveStyleRef({
      cellStyleId,
      rowStyleId,
      rowCustomFormat,
      columnStyleId: column ? column.sourceStyleId : null
    });
    return sourceRegistry.compoundRef(styleRef);
  }

  function buildSheetMeta() {
    if (sheetMeta) return sheetMeta;
    sheetMeta = createToolboxSheetMeta({
      name: sheetName,
      sheetIndex,
      state: sheet && sheet.state ? sheet.state : 'visible',
      date1904,
      defaultColWidth,
      defaultRowHeight,
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
    const rawValue = currentCell.valueParts.join('');
    const inlineText = currentCell.inlineParts.join('');
    const decoded = decodeCellPayload({
      type: currentCell.type,
      rawValue,
      inlineText,
      sharedStrings,
      valueSeen: currentCell.valueSeen,
      context: {
        sourceFile,
        sheetName,
        rowIndex: currentRow.rowIndex,
        columnIndex: currentCell.columnIndex
      }
    });
    const effectiveStyleRef = effectiveRefFor({
      cellStyleId: currentCell.sourceStyleId,
      rowStyleId: currentRow.sourceStyleId,
      rowCustomFormat: currentRow.customFormat,
      columnIndex: currentCell.columnIndex
    });
    const effectiveStyle = sourceRegistry.get(effectiveStyleRef.styleRef);
    const cell = createToolboxCell({
      rawLexicalValue: currentCell.type === 'inlineStr' ? inlineText : rawValue,
      cachedValue: decoded.decodedSemanticValue,
      cellType: decoded.cellType,
      decodedSemanticValue: decoded.decodedSemanticValue,
      matchProjectionValue: decoded.matchProjectionValue,
      sourceStyleId: currentCell.sourceStyleId,
      effectiveStyleRef,
      isExplicitCell: true,
      sourceDateSystem: date1904 ? 1904 : 1900,
      sourceFormat: effectiveStyle.numFmt,
      sourceFile,
      sourceSheet: sheetName,
      rowIndex: currentRow.rowIndex,
      columnIndex: currentCell.columnIndex,
      hasFormula: currentCell.formulaSeen,
      formulaLexical: currentCell.formulaSeen ? currentCell.formulaParts.join('') : null
    });
    currentRow.cells.set(cell.columnIndex, cell);
    currentRow.nextColumnIndex = cell.columnIndex + 1;
    explicitCellCount += 1;
    maxColumnIndex = Math.max(maxColumnIndex, cell.columnIndex);
    currentCell = null;
  }

  function finalizeRow() {
    if (!currentRow) return;
    emitSheetMeta();
    if (currentCell) finalizeCell();
    const rowStyleRef = sourceRegistry.effectiveStyleRef({
      rowStyleId: currentRow.sourceStyleId,
      rowCustomFormat: currentRow.customFormat
    });
    const row = createToolboxRow({
      cells: Array.from(currentRow.cells.values()),
      rowIndex: currentRow.rowIndex,
      height: currentRow.height,
      hidden: currentRow.hidden,
      outlineLevel: currentRow.outlineLevel,
      sourceStyleId: currentRow.sourceStyleId,
      effectiveStyleRef: sourceRegistry.compoundRef(rowStyleRef),
      customFormat: currentRow.customFormat,
      sourceFile,
      sourceSheet: sheetName
    });
    previousRowIndex = currentRow.rowIndex;
    rowCount += 1;
    const result = onRow ? onRow(row, buildSheetMeta()) : null;
    if (result && typeof result.then === 'function') {
      throw new TypeError('scanXlsxSheet 的 onRow 必须是同步回调');
    }
    if (cancelToken && cancelToken.cancelled) {
      throw new ToolboxXlsxCancelledError();
    }
    currentRow = null;
  }

  const parser = sax.createStream(true, {
    trim: false,
    normalize: false,
    xmlns: true
  });

  parser.on('opentag', (node) => {
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
      if (cancelToken && cancelToken.cancelled) throw new ToolboxXlsxCancelledError();
      if (currentRow) {
        throw new ToolboxXlsxFormatError('工作表存在嵌套 row，文件结构已损坏', { sourceFile, sheetName });
      }
      const explicitRowIndex = parseInteger(attrs.r);
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
          attrs.ht,
          'row.ht',
          { sourceFile, sheetName, rowIndex }
        ),
        hidden: parseBoolean(attrs.hidden),
        outlineLevel: parseOutlineLevel(
          attrs.outlinelevel,
          '行',
          { sourceFile, sheetName, rowIndex }
        ),
        sourceStyleId: explicitStyleId(attrs.s, '行样式', String(rowIndex)),
        customFormat: parseBoolean(attrs.customformat),
        cells: new Map(),
        nextColumnIndex: 0
      };
      return;
    }

    if (name === 'c' && currentRow) {
      if (currentCell) {
        throw new ToolboxXlsxFormatError('工作表存在嵌套 cell，文件结构已损坏', { sourceFile, sheetName });
      }
      const hasExplicitReference = attrs.r !== undefined && attrs.r !== null;
      const reference = hasExplicitReference ? parseCellReference(attrs.r) : null;
      if (hasExplicitReference && !reference) {
        throw new ToolboxXlsxFormatError('单元格坐标无效或超出 XLSX 范围', {
          sourceFile,
          sheetName,
          cellReference: attrs.r
        });
      }
      if (reference && reference.rowIndex !== currentRow.rowIndex) {
        throw new ToolboxXlsxFormatError('单元格坐标行号与所属 row 不一致', {
          sourceFile,
          sheetName,
          cellReference: attrs.r,
          rowIndex: currentRow.rowIndex
        });
      }
      const columnIndex = reference ? reference.columnIndex : currentRow.nextColumnIndex;
      if (currentRow.cells.has(columnIndex)) {
        throw new ToolboxXlsxFormatError('同一 row 内存在重复单元格坐标', {
          sourceFile,
          sheetName,
          rowIndex: currentRow.rowIndex,
          columnIndex,
          cellReference: attrs.r || null
        });
      }
      currentCell = {
        columnIndex,
        type: parseCellType(attrs.t, {
          sourceFile,
          sheetName,
          rowIndex: currentRow.rowIndex,
          columnIndex
        }),
        sourceStyleId: explicitStyleId(
          attrs.s,
          '单元格样式',
          attrs.r || `${currentRow.rowIndex}:${reference ? reference.columnIndex : currentRow.nextColumnIndex}`
        ),
        valueParts: [],
        valueLexicalLength: 0,
        inlineParts: [],
        inlineSemanticLength: 0,
        formulaParts: [],
        formulaLexicalLength: 0,
        formulaSeen: false,
        valueSeen: false,
        inlineStringSeen: false,
        inlineStringMode: null,
        plainInlineTextSeen: false,
        richRunTextSeen: false
      };
      return;
    }

    if (!currentCell) return;
    if (name === 'v') {
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
  });

  function collectText(text) {
    if (!currentCell) return;
    if (collectingValue) {
      currentCell.valueParts.push(text);
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
    if (collectingFormula) {
      currentCell.formulaParts.push(text);
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
  parser.on('text', collectText);
  parser.on('cdata', collectText);

  parser.on('closetag', (rawName) => {
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
          currentCell.inlineParts.push(decodedText);
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
  });

  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      stream.removeAllListeners('data');
      stream.removeAllListeners('end');
      stream.removeAllListeners('error');
      parser.removeAllListeners();
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

    parser.on('error', (error) => {
      if (error instanceof ToolboxXlsxFormatError) {
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
    });
    stream.on('data', (chunk) => {
      if (settled) return;
      if (cancelToken && cancelToken.cancelled) {
        fail(new ToolboxXlsxCancelledError());
        return;
      }
      try {
        parser.write(chunk);
      } catch (error) {
        fail(error);
      }
    });
    stream.on('end', () => {
      if (settled) return;
      try {
        parser.end();
        finish();
      } catch (error) {
        fail(error);
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
