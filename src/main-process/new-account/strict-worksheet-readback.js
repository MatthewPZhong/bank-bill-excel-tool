'use strict';

const { TextDecoder } = require('node:util');

const sax = require('sax');

const XLSX_MAX_ROWS = 1048576;
const XLSX_MAX_COLUMNS = 16384;
const DEFAULT_ROW_BATCH_SIZE = 1024;
const SPREADSHEET_NAMESPACES = new Set([
  'http://schemas.openxmlformats.org/spreadsheetml/2006/main',
  'http://purl.oclc.org/ooxml/spreadsheetml/main'
]);
const NUMBER_TEXT = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
const ISO_DATE_TEXT = /^-?\d{4,6}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?)?$/;
const ERROR_VALUES = Object.freeze({
  '#NULL!': 0x00,
  '#DIV/0!': 0x07,
  '#VALUE!': 0x0f,
  '#REF!': 0x17,
  '#NAME?': 0x1d,
  '#NUM!': 0x24,
  '#N/A': 0x2a,
  '#GETTING_DATA': 0x2b,
  '#WTF?': 0xff
});
const SHEETJS_BASE_DATE = new Date(1899, 11, 30, 0, 0, 0);

function fail(code, message) {
  throw Object.assign(new Error(message), { code });
}

function failXml(error) {
  if (error && typeof error.code === 'string' && error.code.startsWith('NEW_ACCOUNT_')) {
    throw error;
  }
  fail('NEW_ACCOUNT_WORKBOOK_XML_INVALID', 'NewAccount输出worksheet XML结构非法');
}

function localName(node) {
  if (!node) return '';
  if (typeof node === 'string') return node.includes(':') ? node.split(':').pop() : node;
  return node.local || (node.name && node.name.includes(':') ? node.name.split(':').pop() : node.name) || '';
}

function attributeValue(node, name) {
  let result = null;
  for (const attribute of Object.values(node.attributes || {})) {
    const local = attribute && typeof attribute === 'object'
      ? (attribute.local || localName(attribute.name))
      : '';
    const uri = attribute && typeof attribute === 'object' ? attribute.uri : '';
    if (local !== name || uri) continue;
    if (result !== null) {
      fail('NEW_ACCOUNT_WORKBOOK_XML_INVALID', 'NewAccount输出XML属性重复');
    }
    result = attribute.value;
  }
  return result;
}

function assertSpreadsheetElement(node) {
  if (!node || !SPREADSHEET_NAMESPACES.has(node.uri)) {
    fail('NEW_ACCOUNT_WORKBOOK_XML_INVALID', 'NewAccount输出SpreadsheetML命名空间非法');
  }
}

function positiveInteger(
  value,
  max,
  label,
  errorCode = 'NEW_ACCOUNT_WORKBOOK_COORDINATE_INVALID'
) {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) {
    fail(errorCode, `${label}必须是正整数`);
  }
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1 || number > max) {
    fail(errorCode, `${label}越界`);
  }
  return number;
}

function columnNumber(letters, errorCode = 'NEW_ACCOUNT_WORKBOOK_COORDINATE_INVALID') {
  let result = 0;
  for (let index = 0; index < letters.length; index += 1) {
    result = result * 26 + letters.charCodeAt(index) - 64;
  }
  if (result < 1 || result > XLSX_MAX_COLUMNS) {
    fail(errorCode, 'NewAccount输出cell列坐标越界');
  }
  return result;
}

function encodeColumnNumber(value) {
  let remaining = value;
  let result = '';
  while (remaining > 0) {
    remaining -= 1;
    result = String.fromCharCode(65 + (remaining % 26)) + result;
    remaining = Math.floor(remaining / 26);
  }
  return result;
}

function encodeCellReference(reference) {
  return `${encodeColumnNumber(reference.columnNumber)}${reference.rowNumber}`;
}

function parseCellReference(value, options = {}) {
  const errorCode = options.errorCode || 'NEW_ACCOUNT_WORKBOOK_COORDINATE_INVALID';
  const label = options.label || 'NewAccount输出cell';
  const match = typeof value === 'string' ? /^([A-Z]{1,3})(\d{1,7})$/.exec(value) : null;
  if (!match) {
    fail(errorCode, `${label}坐标非法`);
  }
  const reference = Object.freeze({
    columnNumber: columnNumber(match[1], errorCode),
    rowNumber: positiveInteger(match[2], XLSX_MAX_ROWS, `${label}行坐标`, errorCode)
  });
  if (encodeCellReference(reference) !== value) {
    fail(errorCode, `${label}坐标必须使用canonical形式`);
  }
  return reference;
}

function parseCanonicalRangeReference(value, options = {}) {
  const errorCode = options.errorCode || 'NEW_ACCOUNT_WORKBOOK_DIMENSION_INVALID';
  const label = options.label || 'NewAccount输出range';
  const match = typeof value === 'string'
    ? /^([A-Z]{1,3}\d{1,7})(?::([A-Z]{1,3}\d{1,7}))?$/.exec(value)
    : null;
  if (!match) fail(errorCode, `${label}非法`);
  const start = parseCellReference(match[1], { errorCode, label: `${label}起点` });
  const end = parseCellReference(match[2] || match[1], { errorCode, label: `${label}终点` });
  if (start.columnNumber > end.columnNumber || start.rowNumber > end.rowNumber) {
    fail(errorCode, `${label}端点倒置`);
  }
  if (!match[2] && (start.columnNumber !== end.columnNumber || start.rowNumber !== end.rowNumber)) {
    fail(errorCode, `${label}非法`);
  }
  if (match[2] && start.columnNumber === end.columnNumber && start.rowNumber === end.rowNumber) {
    fail(errorCode, `${label}必须使用canonical单cell形式`);
  }
  const canonical = match[2]
    ? `${encodeCellReference(start)}:${encodeCellReference(end)}`
    : encodeCellReference(start);
  if (canonical !== value) fail(errorCode, `${label}必须使用canonical形式`);
  return Object.freeze({ start, end });
}

function parseDimensionReference(value) {
  const range = parseCanonicalRangeReference(value, {
    errorCode: 'NEW_ACCOUNT_WORKBOOK_DIMENSION_INVALID',
    label: 'NewAccount输出dimension'
  });
  if (range.start.columnNumber !== 1 || range.start.rowNumber !== 1) {
    fail('NEW_ACCOUNT_WORKBOOK_DIMENSION_INVALID', 'NewAccount输出dimension必须从A1开始');
  }
  return range;
}

function rangeContains(outer, inner) {
  return inner.start.columnNumber >= outer.start.columnNumber &&
    inner.start.rowNumber >= outer.start.rowNumber &&
    inner.end.columnNumber <= outer.end.columnNumber &&
    inner.end.rowNumber <= outer.end.rowNumber;
}

function rangesEqual(left, right) {
  return left.start.columnNumber === right.start.columnNumber &&
    left.start.rowNumber === right.start.rowNumber &&
    left.end.columnNumber === right.end.columnNumber &&
    left.end.rowNumber === right.end.rowNumber;
}

// SheetJS `unescapexml` 对 `_xHHHH_` 只做一次替换；XML实体由strict SAX先解码。
function decodeExcelEscapes(value) {
  return String(value).replace(/_x([0-9A-Fa-f]{4})_/g, (_match, hex) => (
    String.fromCharCode(Number.parseInt(hex, 16))
  ));
}

function sheetJsDateSerial(value) {
  if (!ISO_DATE_TEXT.test(value)) {
    fail('NEW_ACCOUNT_WORKBOOK_CELL_INVALID', 'NewAccount输出date cell payload非法');
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    fail('NEW_ACCOUNT_WORKBOOK_CELL_INVALID', 'NewAccount输出date cell payload非法');
  }
  // 对齐 xlsx@0.18.5 parseDate(value, 1) + datenum(value) 的local-time语义。
  parsed.setTime(parsed.getTime() + parsed.getTimezoneOffset() * 60 * 1000);
  const threshold = SHEETJS_BASE_DATE.getTime() + (
    parsed.getTimezoneOffset() - SHEETJS_BASE_DATE.getTimezoneOffset()
  ) * 60 * 1000;
  const serial = (parsed.getTime() - threshold) / (24 * 60 * 60 * 1000);
  if (!Number.isFinite(serial) || (Number.isInteger(serial) && !Number.isSafeInteger(serial))) {
    fail('NEW_ACCOUNT_WORKBOOK_CELL_INVALID', 'NewAccount输出date cell超出安全范围');
  }
  return serial;
}

function numericValue(value) {
  const normalized = value.trim();
  if (!NUMBER_TEXT.test(normalized)) {
    fail('NEW_ACCOUNT_WORKBOOK_CELL_INVALID', 'NewAccount输出numeric cell payload非法');
  }
  const number = Number(normalized);
  if (!Number.isFinite(number) || (Number.isInteger(number) && !Number.isSafeInteger(number))) {
    fail('NEW_ACCOUNT_WORKBOOK_CELL_INVALID', 'NewAccount输出numeric cell超出安全范围');
  }
  return number;
}

function decodeCell(cell, sharedStrings) {
  const type = cell.type === null ? 'n' : cell.type;
  if (cell.hasFormula && !cell.hasValue) {
    fail('NEW_ACCOUNT_WORKBOOK_CELL_INVALID', 'NewAccount输出formula缺少cached value');
  }
  if (cell.hasValue && cell.hasInlineString) {
    fail('NEW_ACCOUNT_WORKBOOK_CELL_INVALID', 'NewAccount输出cell同时包含value和inline string');
  }
  const rawValue = cell.hasValue ? decodeExcelEscapes(cell.valueText) : null;
  switch (type) {
    case 'n':
      if (cell.hasInlineString) {
        fail('NEW_ACCOUNT_WORKBOOK_CELL_INVALID', 'NewAccount输出numeric cell结构非法');
      }
      if (!cell.hasValue || rawValue === '') return Object.freeze({ present: false, meaningful: false });
      return Object.freeze({ present: true, meaningful: true, value: numericValue(rawValue) });
    case 's': {
      if (cell.hasFormula || cell.hasInlineString || !cell.hasValue || !/^\d+$/.test(rawValue)) {
        fail('NEW_ACCOUNT_WORKBOOK_SHARED_STRING_INVALID', 'NewAccount输出shared string索引非法');
      }
      const index = Number(rawValue);
      if (!Number.isSafeInteger(index) || index < 0 || index >= sharedStrings.length) {
        fail('NEW_ACCOUNT_WORKBOOK_SHARED_STRING_INVALID', 'NewAccount输出shared string索引越界');
      }
      return Object.freeze({ present: true, meaningful: true, value: sharedStrings[index] });
    }
    case 'inlineStr':
      if (cell.hasFormula || cell.hasValue) {
        fail('NEW_ACCOUNT_WORKBOOK_CELL_INVALID', 'NewAccount输出inline string结构非法');
      }
      return Object.freeze({
        present: true,
        meaningful: true,
        value: cell.hasInlineString ? decodeExcelEscapes(cell.inlineText) : ''
      });
    case 'str':
      if (cell.hasInlineString) {
        fail('NEW_ACCOUNT_WORKBOOK_CELL_INVALID', 'NewAccount输出string cell结构非法');
      }
      return Object.freeze({
        present: true,
        meaningful: true,
        value: cell.hasValue ? rawValue : ''
      });
    case 'b':
      if (!cell.hasValue || cell.hasInlineString) {
        fail('NEW_ACCOUNT_WORKBOOK_CELL_INVALID', 'NewAccount输出boolean cell payload非法');
      }
      if (['1', 'true', 'TRUE'].includes(rawValue)) {
        return Object.freeze({ present: true, meaningful: true, value: true });
      }
      if (['0', 'false', 'FALSE'].includes(rawValue)) {
        return Object.freeze({ present: true, meaningful: true, value: false });
      }
      fail('NEW_ACCOUNT_WORKBOOK_CELL_INVALID', 'NewAccount输出boolean cell payload非法');
      break;
    case 'd':
      if (!cell.hasValue || cell.hasInlineString) {
        fail('NEW_ACCOUNT_WORKBOOK_CELL_INVALID', 'NewAccount输出date cell payload非法');
      }
      return Object.freeze({ present: true, meaningful: true, value: sheetJsDateSerial(rawValue) });
    case 'e': {
      if (!cell.hasValue || cell.hasInlineString || !Object.hasOwn(ERROR_VALUES, rawValue)) {
        fail('NEW_ACCOUNT_WORKBOOK_CELL_INVALID', 'NewAccount输出error cell payload非法');
      }
      // 对齐 sheet_to_json(raw:true,defval:'')：#NULL!为null，其余error落defval；error不使blank row有效。
      return Object.freeze({
        present: true,
        meaningful: false,
        value: ERROR_VALUES[rawValue] === 0 ? null : ''
      });
    }
    default:
      fail('NEW_ACCOUNT_WORKBOOK_CELL_INVALID', 'NewAccount输出cell type非法');
  }
}

function createStrictParser(handlers) {
  const parser = sax.parser(true, { trim: false, normalize: false, xmlns: true });
  let parseError = null;
  parser.onerror = (error) => { parseError = error; };
  Object.assign(parser, handlers);
  return {
    write(text) {
      if (text) parser.write(text);
      if (parseError) failXml(parseError);
    },
    close() {
      parser.close();
      if (parseError) failXml(parseError);
    }
  };
}

async function parseUtf8StreamStrict(stream, handlers, assertNotCancelled) {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const parser = createStrictParser(handlers);
  await new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      stream.removeAllListeners('data');
      stream.removeAllListeners('end');
      stream.removeAllListeners('error');
      try { stream.destroy(); } catch (_) {}
      if (error) reject(error);
      else resolve();
    };
    stream.on('data', (chunk) => {
      if (settled) return;
      stream.pause();
      try {
        if (assertNotCancelled) assertNotCancelled();
        parser.write(decoder.decode(chunk, { stream: true }));
      } catch (error) {
        try { failXml(error); } catch (wrapped) { finish(wrapped); }
        return;
      }
      Promise.resolve(typeof handlers.afterChunk === 'function' ? handlers.afterChunk() : undefined)
        .then(() => {
          if (!settled) stream.resume();
        }, (error) => {
          try { failXml(error); } catch (wrapped) { finish(wrapped); }
        });
    });
    stream.on('end', () => {
      if (settled) return;
      try {
        parser.write(decoder.decode());
        parser.close();
        if (assertNotCancelled) assertNotCancelled();
        finish();
      } catch (error) {
        try { failXml(error); } catch (wrapped) { finish(wrapped); }
      }
    });
    stream.on('error', (error) => {
      try { failXml(error); } catch (wrapped) { finish(wrapped); }
    });
  });
}

function openZipEntryStream(zip, entry) {
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (error, stream) => {
      if (error) reject(error);
      else resolve(stream);
    });
  });
}

async function loadNewAccountSharedStrings(zip, entry, options = {}) {
  if (!entry) return Object.freeze([]);
  const stream = await openZipEntryStream(zip, entry);
  const values = [];
  const stack = [];
  let rootSeen = false;
  let current = null;
  let inText = false;
  let inPhoneticRun = false;
  const handlers = {
    onopentag(node) {
      const name = localName(node);
      const parent = stack[stack.length - 1] || null;
      if (name === 'sst') {
        assertSpreadsheetElement(node);
        if (rootSeen || parent !== null) fail('NEW_ACCOUNT_WORKBOOK_XML_INVALID', 'sharedStrings root非法');
        rootSeen = true;
      } else if (name === 'si') {
        assertSpreadsheetElement(node);
        if (!rootSeen || current !== null || parent !== 'sst') {
          fail('NEW_ACCOUNT_WORKBOOK_XML_INVALID', 'sharedStrings item结构非法');
        }
        current = '';
      } else if (name === 'rPh' && current !== null) {
        assertSpreadsheetElement(node);
        if (inPhoneticRun) fail('NEW_ACCOUNT_WORKBOOK_XML_INVALID', 'sharedStrings phonetic run嵌套非法');
        inPhoneticRun = true;
      } else if (name === 't' && current !== null) {
        assertSpreadsheetElement(node);
        if (inText) fail('NEW_ACCOUNT_WORKBOOK_XML_INVALID', 'sharedStrings text嵌套非法');
        inText = true;
      }
      stack.push(name);
    },
    ontext(text) {
      if (current !== null && inText && !inPhoneticRun) current += text;
    },
    oncdata(text) {
      if (current !== null && inText && !inPhoneticRun) current += text;
    },
    onclosetag(node) {
      const name = localName(node) || stack[stack.length - 1];
      if (name === 't' && current !== null) inText = false;
      if (name === 'rPh' && current !== null) inPhoneticRun = false;
      if (name === 'si') {
        if (current === null) fail('NEW_ACCOUNT_WORKBOOK_XML_INVALID', 'sharedStrings item结构非法');
        values.push(decodeExcelEscapes(current));
        current = null;
      }
      const opened = stack.pop();
      if (opened !== name) fail('NEW_ACCOUNT_WORKBOOK_XML_INVALID', 'sharedStrings标签错位');
    }
  };
  await parseUtf8StreamStrict(stream, handlers, options.assertNotCancelled);
  if (!rootSeen || stack.length || current !== null || inText || inPhoneticRun) {
    fail('NEW_ACCOUNT_WORKBOOK_XML_INVALID', 'sharedStrings XML截断');
  }
  return Object.freeze(values);
}

async function scanNewAccountWorksheetRows(options) {
  const {
    stream,
    expectedColumnCount,
    sharedStrings = [],
    onRow,
    onRowBatch,
    assertNotCancelled,
    rowBatchSize = DEFAULT_ROW_BATCH_SIZE
  } = options;
  if (!stream || !Number.isSafeInteger(expectedColumnCount) || expectedColumnCount < 1 ||
      expectedColumnCount > XLSX_MAX_COLUMNS ||
      !Array.isArray(sharedStrings) || typeof onRow !== 'function' ||
      !Number.isSafeInteger(rowBatchSize) || rowBatchSize < 1) {
    throw new TypeError('NewAccount strict worksheet scanner参数非法');
  }
  const stack = [];
  let worksheetSeen = false;
  let worksheetClosed = false;
  let dimension = null;
  let dimensionOpen = false;
  let dimensionClosed = false;
  let sheetDataSeen = false;
  let sheetDataClosed = false;
  let inSheetData = false;
  let currentRow = null;
  let currentCell = null;
  let lastRowNumber = 0;
  let parsedRows = 0;
  let nextBatchAt = rowBatchSize;
  let batchDue = false;
  let usedRange = null;
  let mergeCellsSeen = false;
  let inMergeCells = false;

  function includeUsedRange(range) {
    if (!usedRange) {
      usedRange = {
        start: { ...range.start },
        end: { ...range.end }
      };
      return;
    }
    usedRange.start.columnNumber = Math.min(
      usedRange.start.columnNumber,
      range.start.columnNumber
    );
    usedRange.start.rowNumber = Math.min(usedRange.start.rowNumber, range.start.rowNumber);
    usedRange.end.columnNumber = Math.max(usedRange.end.columnNumber, range.end.columnNumber);
    usedRange.end.rowNumber = Math.max(usedRange.end.rowNumber, range.end.rowNumber);
  }

  function assertRangeInsideDimension(range) {
    if (!dimension || !rangeContains(dimension, range)) {
      fail(
        'NEW_ACCOUNT_WORKBOOK_DIMENSION_INVALID',
        'NewAccount输出cell或merge超出dimension'
      );
    }
  }

  function assertDimensionMatchesUsedRange() {
    if (!dimension) {
      fail('NEW_ACCOUNT_WORKBOOK_DIMENSION_INVALID', 'NewAccount输出dimension缺失');
    }
    if (!usedRange) {
      const emptyRange = Object.freeze({
        start: Object.freeze({ columnNumber: 1, rowNumber: 1 }),
        end: Object.freeze({ columnNumber: 1, rowNumber: 1 })
      });
      if (rangesEqual(dimension, emptyRange)) return;
      fail('NEW_ACCOUNT_WORKBOOK_DIMENSION_INVALID', 'NewAccount空worksheet dimension非法');
    }
    if (rangesEqual(dimension, usedRange)) return;
    const headerOnlyWriterFloor = usedRange.start.columnNumber === 1 &&
      usedRange.start.rowNumber === 1 &&
      usedRange.end.columnNumber === expectedColumnCount &&
      usedRange.end.rowNumber === 1 &&
      dimension.start.columnNumber === 1 &&
      dimension.start.rowNumber === 1 &&
      dimension.end.columnNumber === expectedColumnCount &&
      dimension.end.rowNumber === 2;
    if (headerOnlyWriterFloor) return;
    fail(
      'NEW_ACCOUNT_WORKBOOK_DIMENSION_INVALID',
      'NewAccount输出dimension与实际used range不一致'
    );
  }

  function startRow(node, parent) {
    if (!inSheetData || parent !== 'sheetData' || currentRow || currentCell) {
      fail('NEW_ACCOUNT_WORKBOOK_XML_INVALID', 'NewAccount输出row结构非法');
    }
    const rowNumber = positiveInteger(
      attributeValue(node, 'r'),
      XLSX_MAX_ROWS,
      'NewAccount输出outer row坐标'
    );
    if (rowNumber <= lastRowNumber) {
      fail('NEW_ACCOUNT_WORKBOOK_COORDINATE_INVALID', 'NewAccount输出row坐标重复或乱序');
    }
    currentRow = {
      rowNumber,
      previousColumnNumber: 0,
      values: new Array(expectedColumnCount).fill(''),
      hasAnyCellValue: false
    };
  }

  function startCell(node, parent) {
    if (!currentRow || currentCell || parent !== 'row') {
      fail('NEW_ACCOUNT_WORKBOOK_XML_INVALID', 'NewAccount输出cell结构非法');
    }
    const reference = parseCellReference(attributeValue(node, 'r'));
    if (reference.rowNumber !== currentRow.rowNumber) {
      fail('NEW_ACCOUNT_WORKBOOK_COORDINATE_INVALID', 'NewAccount输出outer row与cell行坐标不一致');
    }
    if (reference.columnNumber <= currentRow.previousColumnNumber) {
      fail('NEW_ACCOUNT_WORKBOOK_COORDINATE_INVALID', 'NewAccount输出cell列坐标重复或乱序');
    }
    const cellRange = Object.freeze({ start: reference, end: reference });
    assertRangeInsideDimension(cellRange);
    includeUsedRange(cellRange);
    currentRow.previousColumnNumber = reference.columnNumber;
    currentCell = {
      columnNumber: reference.columnNumber,
      type: attributeValue(node, 't'),
      hasValue: false,
      valueText: '',
      inValue: false,
      hasFormula: false,
      inFormula: false,
      hasInlineString: false,
      inInlineString: false,
      inInlinePhoneticRun: false,
      inInlineText: false,
      inlineText: ''
    };
  }

  function finishCell() {
    if (!currentCell || !currentRow) fail('NEW_ACCOUNT_WORKBOOK_XML_INVALID', 'NewAccount输出cell闭合非法');
    const decoded = decodeCell(currentCell, sharedStrings);
    if (decoded.present && currentCell.columnNumber <= expectedColumnCount) {
      currentRow.values[currentCell.columnNumber - 1] = decoded.value;
    }
    if (decoded.meaningful) currentRow.hasAnyCellValue = true;
    currentCell = null;
  }

  function finishRow() {
    if (!currentRow || currentCell) fail('NEW_ACCOUNT_WORKBOOK_XML_INVALID', 'NewAccount输出row闭合非法');
    onRow(Object.freeze({
      rowNumber: currentRow.rowNumber,
      values: currentRow.values,
      hasAnyCellValue: currentRow.hasAnyCellValue
    }));
    lastRowNumber = currentRow.rowNumber;
    currentRow = null;
    parsedRows += 1;
    if (parsedRows >= nextBatchAt) {
      batchDue = true;
      while (nextBatchAt <= parsedRows) nextBatchAt += rowBatchSize;
    }
  }

  const handlers = {
    onopentag(node) {
      const name = localName(node);
      const parent = stack[stack.length - 1] || null;
      if (dimensionOpen) {
        fail('NEW_ACCOUNT_WORKBOOK_XML_INVALID', 'NewAccount输出dimension子元素非法');
      } else if (name === 'worksheet') {
        assertSpreadsheetElement(node);
        if (worksheetSeen || parent !== null) {
          fail('NEW_ACCOUNT_WORKBOOK_XML_INVALID', 'NewAccount输出worksheet root非法');
        }
        worksheetSeen = true;
      } else if (parent === null) {
        fail('NEW_ACCOUNT_WORKBOOK_XML_INVALID', 'NewAccount输出worksheet root非法');
      } else if (name === 'dimension') {
        assertSpreadsheetElement(node);
        if (parent !== 'worksheet' || dimension || sheetDataSeen) {
          fail('NEW_ACCOUNT_WORKBOOK_DIMENSION_INVALID', 'NewAccount输出dimension重复或位置非法');
        }
        dimension = parseDimensionReference(attributeValue(node, 'ref'));
        dimensionOpen = true;
      } else if (name === 'sheetData') {
        assertSpreadsheetElement(node);
        if (!dimension || !dimensionClosed) {
          fail('NEW_ACCOUNT_WORKBOOK_DIMENSION_INVALID', 'NewAccount输出dimension缺失或未闭合');
        }
        if (parent !== 'worksheet' || sheetDataSeen || inSheetData || currentRow || currentCell) {
          fail('NEW_ACCOUNT_WORKBOOK_XML_INVALID', 'NewAccount输出sheetData结构非法');
        }
        sheetDataSeen = true;
        inSheetData = true;
      } else if (name === 'row' && inSheetData) {
        assertSpreadsheetElement(node);
        startRow(node, parent);
      } else if (name === 'c' && currentRow) {
        assertSpreadsheetElement(node);
        startCell(node, parent);
      } else if (currentCell) {
        assertSpreadsheetElement(node);
        if (name === 'v') {
          if (parent !== 'c' || currentCell.hasValue || currentCell.inValue) {
            fail('NEW_ACCOUNT_WORKBOOK_XML_INVALID', 'NewAccount输出value结构非法');
          }
          currentCell.hasValue = true;
          currentCell.inValue = true;
        } else if (name === 'f') {
          if (parent !== 'c' || currentCell.hasFormula || currentCell.inFormula) {
            fail('NEW_ACCOUNT_WORKBOOK_XML_INVALID', 'NewAccount输出formula结构非法');
          }
          currentCell.hasFormula = true;
          currentCell.inFormula = true;
        } else if (name === 'is') {
          if (parent !== 'c' || currentCell.hasInlineString || currentCell.inInlineString) {
            fail('NEW_ACCOUNT_WORKBOOK_XML_INVALID', 'NewAccount输出inline string结构非法');
          }
          currentCell.hasInlineString = true;
          currentCell.inInlineString = true;
        } else if (name === 't' && currentCell.inInlineString) {
          if (currentCell.inInlineText) {
            fail('NEW_ACCOUNT_WORKBOOK_XML_INVALID', 'NewAccount输出inline text嵌套非法');
          }
          currentCell.inInlineText = true;
        } else if (name === 'rPh' && currentCell.inInlineString) {
          if (currentCell.inInlinePhoneticRun) {
            fail('NEW_ACCOUNT_WORKBOOK_XML_INVALID', 'NewAccount输出inline phonetic run嵌套非法');
          }
          currentCell.inInlinePhoneticRun = true;
        } else if (!currentCell.inInlineString) {
          fail('NEW_ACCOUNT_WORKBOOK_XML_INVALID', 'NewAccount输出cell子元素非法');
        }
      } else if (currentRow && parent === 'row') {
        fail('NEW_ACCOUNT_WORKBOOK_XML_INVALID', 'NewAccount输出row子元素非法');
      } else if (inSheetData && parent === 'sheetData') {
        fail('NEW_ACCOUNT_WORKBOOK_XML_INVALID', 'NewAccount输出sheetData子元素非法');
      } else if (name === 'mergeCells') {
        assertSpreadsheetElement(node);
        if (parent !== 'worksheet' || mergeCellsSeen || inMergeCells) {
          fail('NEW_ACCOUNT_WORKBOOK_XML_INVALID', 'NewAccount输出mergeCells结构非法');
        }
        mergeCellsSeen = true;
        inMergeCells = true;
      } else if (name === 'mergeCell') {
        assertSpreadsheetElement(node);
        if (!inMergeCells || parent !== 'mergeCells') {
          fail('NEW_ACCOUNT_WORKBOOK_XML_INVALID', 'NewAccount输出mergeCell结构非法');
        }
        const mergeRange = parseCanonicalRangeReference(attributeValue(node, 'ref'), {
          errorCode: 'NEW_ACCOUNT_WORKBOOK_DIMENSION_INVALID',
          label: 'NewAccount输出merge range'
        });
        assertRangeInsideDimension(mergeRange);
        includeUsedRange(mergeRange);
      } else if (inMergeCells) {
        fail('NEW_ACCOUNT_WORKBOOK_XML_INVALID', 'NewAccount输出mergeCells子元素非法');
      }
      stack.push(name);
    },
    ontext(text) {
      if ((dimensionOpen || inMergeCells) && text.trim() !== '') {
        fail('NEW_ACCOUNT_WORKBOOK_XML_INVALID', 'NewAccount输出range结构含非法文本');
      } else if (currentCell && currentCell.inValue) currentCell.valueText += text;
      else if (currentCell && currentCell.inInlineText && !currentCell.inInlinePhoneticRun) {
        currentCell.inlineText += text;
      }
      else if (currentCell && currentCell.inFormula) {
        // 公式文本只用于确认存在；业务值始终来自cached value。
      } else if (currentCell && currentCell.inInlineString) {
        // rich-text格式节点中的非<t>文本不构成cell值。
      } else if (inSheetData && text.trim() !== '') {
        fail('NEW_ACCOUNT_WORKBOOK_XML_INVALID', 'NewAccount输出sheetData含非法文本');
      }
    },
    oncdata(text) {
      handlers.ontext(text);
    },
    onclosetag(node) {
      const name = localName(node) || stack[stack.length - 1];
      if (name === 'dimension') {
        if (!dimensionOpen) {
          fail('NEW_ACCOUNT_WORKBOOK_DIMENSION_INVALID', 'NewAccount输出dimension闭合非法');
        }
        dimensionOpen = false;
        dimensionClosed = true;
      } else if (name === 'mergeCells') {
        if (!inMergeCells) fail('NEW_ACCOUNT_WORKBOOK_XML_INVALID', 'NewAccount输出mergeCells闭合非法');
        inMergeCells = false;
      } else if (currentCell && name === 'v') currentCell.inValue = false;
      else if (currentCell && name === 'f') currentCell.inFormula = false;
      else if (currentCell && name === 't' && currentCell.inInlineString) currentCell.inInlineText = false;
      else if (currentCell && name === 'rPh' && currentCell.inInlineString) {
        currentCell.inInlinePhoneticRun = false;
      }
      else if (currentCell && name === 'is') currentCell.inInlineString = false;
      else if (name === 'c') finishCell();
      else if (name === 'row') finishRow();
      else if (name === 'sheetData') {
        if (!inSheetData || currentRow || currentCell) {
          fail('NEW_ACCOUNT_WORKBOOK_XML_INVALID', 'NewAccount输出sheetData闭合非法');
        }
        inSheetData = false;
        sheetDataClosed = true;
      } else if (name === 'worksheet') {
        if (!worksheetSeen || !sheetDataClosed || currentRow || currentCell) {
          fail('NEW_ACCOUNT_WORKBOOK_XML_INVALID', 'NewAccount输出worksheet闭合非法');
        }
        worksheetClosed = true;
      }
      const opened = stack.pop();
      if (opened !== name) fail('NEW_ACCOUNT_WORKBOOK_XML_INVALID', 'NewAccount输出XML标签错位');
    },
    async afterChunk() {
      if (!batchDue) return;
      batchDue = false;
      if (typeof onRowBatch === 'function') {
        await onRowBatch(Object.freeze({ parsedRows, lastRowNumber }));
      }
    }
  };

  await parseUtf8StreamStrict(stream, handlers, assertNotCancelled);
  if (!worksheetSeen || !worksheetClosed || !dimension || !dimensionClosed || dimensionOpen ||
      !sheetDataSeen || !sheetDataClosed || inSheetData || inMergeCells || currentRow ||
      currentCell || stack.length) {
    fail('NEW_ACCOUNT_WORKBOOK_XML_INVALID', 'NewAccount输出worksheet XML截断');
  }
  assertDimensionMatchesUsedRange();
  return Object.freeze({ parsedRows, lastRowNumber });
}

module.exports = {
  decodeCell,
  loadNewAccountSharedStrings,
  parseCellReference,
  parseDimensionReference,
  scanNewAccountWorksheetRows,
  sheetJsDateSerial
};
