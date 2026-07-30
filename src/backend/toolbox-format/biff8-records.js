'use strict';

const { BUILTIN_NUMBER_FORMATS } = require('./number-date');

const BIFF8_MAX_RECORD_PAYLOAD = 8224;
const BIFF8_MAX_THEME_LOGICAL_BYTES = 16 * 1024 * 1024;
const BIFF8_MAX_STRING_LOGICAL_BYTES = 1024 * 1024;
const MSO_CRC32_POLYNOMIAL = 0x000000af;

const DEFAULT_BUILTIN_FORMATS = BUILTIN_NUMBER_FORMATS;
const BIFF8_ERROR_CODES = new Set([0x00, 0x07, 0x0f, 0x17, 0x1d, 0x24, 0x2a, 0x2b]);

// BIFF8 允许部分低位 Format 由工作簿物理记录给出本地化/用户定义语义。
// SheetJS 的 BIFF8 writer 也会写出 5..8、23..26、41..44、50..392，
// 并从 0x3C（60）开始分配自定义格式。其余 0..49 是稳定的 canonical
// built-in，物理 Format 可以重复声明同值，但不能冲突覆盖。
const BIFF8_RECORD_AUTHORITATIVE_LOW_FORMAT_RANGES = Object.freeze([
  Object.freeze([5, 8]),
  Object.freeze([23, 26]),
  Object.freeze([41, 44])
]);

// [MS-OSHARED] MsoCrc32Compute uses polynomial 0xAF with MSB-first byte
// ordering. XFCRC starts from zero and stores the running value directly
// (there is no conventional CRC-32 final XOR).
const MSO_CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < table.length; index += 1) {
    let value = (index << 24) >>> 0;
    for (let bit = 0; bit < 8; bit += 1) {
      value = ((value & 0x80000000) !== 0
        ? ((value << 1) ^ MSO_CRC32_POLYNOMIAL)
        : (value << 1)) >>> 0;
    }
    table[index] = value;
  }
  return table;
})();

const RECORD = Object.freeze({
  BOF: 0x0809,
  EOF: 0x000a,
  CONTINUE: 0x003c,
  FILE_PASS: 0x002f,
  CODE_PAGE: 0x0042,
  DATE_1904: 0x0022,
  FONT: 0x0031,
  FORMAT: 0x041e,
  XF: 0x00e0,
  PALETTE: 0x0092,
  BOUND_SHEET_8: 0x0085,
  XF_CRC: 0x087c,
  XF_EXT: 0x087d,
  THEME: 0x0896,
  DEFAULT_ROW_HEIGHT: 0x0225,
  DEFAULT_ROW_HEIGHT_OLD: 0x0025,
  DEF_COL_WIDTH: 0x0055,
  STANDARD_WIDTH: 0x0099,
  DIMENSIONS: 0x0200,
  COL_INFO: 0x007d,
  ROW: 0x0208,
  BLANK: 0x0201,
  NUMBER: 0x0203,
  LABEL: 0x0204,
  BOOL_ERR: 0x0205,
  FORMULA: 0x0006,
  STRING: 0x0207,
  RK: 0x027e,
  MUL_RK: 0x00bd,
  MUL_BLANK: 0x00be,
  LABEL_SST: 0x00fd,
  RSTRING: 0x00d6
});

const CELL_RECORD_NAMES = Object.freeze({
  [RECORD.BLANK]: 'Blank',
  [RECORD.NUMBER]: 'Number',
  [RECORD.LABEL]: 'Label',
  [RECORD.BOOL_ERR]: 'BoolErr',
  [RECORD.FORMULA]: 'Formula',
  [RECORD.RK]: 'RK',
  [RECORD.MUL_RK]: 'MulRK',
  [RECORD.MUL_BLANK]: 'MulBlank',
  [RECORD.LABEL_SST]: 'LabelSst',
  [RECORD.RSTRING]: 'RString'
});

class Biff8RecordError extends Error {
  constructor(code, message, detail = {}) {
    super(message);
    this.name = 'Biff8RecordError';
    this.code = code;
    this.detail = detail;
  }
}

function fail(code, message, detail) {
  throw new Biff8RecordError(code, message, detail);
}

function hex(value, width = 4) {
  return `0x${Number(value).toString(16).toUpperCase().padStart(width, '0')}`;
}

function ensureBuffer(value, label = 'Workbook stream') {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  fail('BIFF8_INVALID_STREAM', `${label} 必须是 Buffer 或 Uint8Array`);
}

function msoCrc32Compute(value, input) {
  let crc = Number(value) >>> 0;
  const buffer = ensureBuffer(input, 'MsoCrc32Compute input');
  for (const byte of buffer) {
    const tableIndex = ((crc >>> 24) ^ byte) & 0xff;
    crc = (((crc << 8) >>> 0) ^ MSO_CRC32_TABLE[tableIndex]) >>> 0;
  }
  return crc;
}

function checkAvailable(buffer, offset, length, context) {
  if (!Number.isInteger(offset) || !Number.isInteger(length) || offset < 0 || length < 0) {
    fail('BIFF8_INVALID_OFFSET', `${context} 使用了非法 offset/length`, { offset, length });
  }
  if (offset + length > buffer.length) {
    fail(
      'BIFF8_TRUNCATED_RECORD',
      `${context} 越过 Workbook stream 边界`,
      { offset, length, streamLength: buffer.length }
    );
  }
}

function readPhysicalRecord(buffer, offset) {
  checkAvailable(buffer, offset, 4, 'BIFF8 record header');
  const type = buffer.readUInt16LE(offset);
  const length = buffer.readUInt16LE(offset + 2);
  if (length > BIFF8_MAX_RECORD_PAYLOAD) {
    fail(
      'BIFF8_RECORD_TOO_LARGE',
      `BIFF8 record ${hex(type)} 长度 ${length} 超过 ${BIFF8_MAX_RECORD_PAYLOAD}`,
      { offset, type, length }
    );
  }
  checkAvailable(buffer, offset + 4, length, `BIFF8 record ${hex(type)}`);
  return {
    type,
    length,
    offset,
    payload: buffer.subarray(offset + 4, offset + 4 + length),
    nextOffset: offset + 4 + length
  };
}

function readLogicalRecord(buffer, offset, options = {}) {
  const first = readPhysicalRecord(buffer, offset);
  if (first.type === RECORD.CONTINUE) {
    fail(
      'BIFF8_ORPHAN_CONTINUE',
      `BIFF8 Continue record 在 ${offset} 没有前置 logical record`,
      { offset }
    );
  }
  const segments = [first.payload];
  let logicalLength = first.payload.length;
  const physical = [{ offset: first.offset, length: first.length, type: first.type }];
  let nextOffset = first.nextOffset;
  while (nextOffset + 4 <= buffer.length) {
    const candidateType = buffer.readUInt16LE(nextOffset);
    if (candidateType !== RECORD.CONTINUE) break;
    const continuation = readPhysicalRecord(buffer, nextOffset);
    segments.push(continuation.payload);
    logicalLength += continuation.payload.length;
    if (options.maxLogicalLength != null && logicalLength > options.maxLogicalLength) {
      fail(
        'BIFF8_LOGICAL_RECORD_TOO_LARGE',
        `BIFF8 logical record ${hex(first.type)} 长度 ${logicalLength} 超过安全上限 ${options.maxLogicalLength}`,
        { offset: first.offset, type: first.type, logicalLength, limit: options.maxLogicalLength }
      );
    }
    physical.push({
      offset: continuation.offset,
      length: continuation.length,
      type: continuation.type
    });
    nextOffset = continuation.nextOffset;
  }
  return {
    type: first.type,
    offset: first.offset,
    physical,
    segments,
    payload: segments.length === 1 || options.materialize !== false
      ? (segments.length === 1 ? segments[0] : Buffer.concat(segments))
      : segments[0],
    logicalLength,
    nextOffset
  };
}

// SST、drawing 等与格式 overlay 无关的 logical record 可能带很多 Continue。
// 扫描时只对确实需要跨段读取的 Theme/字符串物化合并 buffer，避免把整个 SST
// 在已经加载的 Workbook stream 之外再复制一次。
const MATERIALIZED_SCAN_RECORDS = new Set([
  RECORD.THEME,
  RECORD.STRING,
  RECORD.LABEL,
  RECORD.RSTRING
]);

function readScanRecord(buffer, offset) {
  const type = offset + 2 <= buffer.length ? buffer.readUInt16LE(offset) : null;
  const maxLogicalLength = type === RECORD.THEME
    ? BIFF8_MAX_THEME_LOGICAL_BYTES
    : ([RECORD.STRING, RECORD.LABEL, RECORD.RSTRING].includes(type)
        ? BIFF8_MAX_STRING_LOGICAL_BYTES
        : null);
  return readLogicalRecord(buffer, offset, {
    materialize: MATERIALIZED_SCAN_RECORDS.has(type),
    maxLogicalLength
  });
}

function requireLength(record, expected, label) {
  if (record.payload.length !== expected || record.segments.length !== 1) {
    fail(
      'BIFF8_INVALID_RECORD_LENGTH',
      `${label} record 长度应为 ${expected}，实际 ${record.payload.length}`,
      {
        offset: record.offset,
        type: record.type,
        expected,
        actual: record.payload.length,
        segments: record.segments.length
      }
    );
  }
}

function requireMinimumLength(record, expected, label) {
  if (record.payload.length < expected) {
    fail(
      'BIFF8_INVALID_RECORD_LENGTH',
      `${label} record 至少需要 ${expected} 字节，实际 ${record.payload.length}`,
      { offset: record.offset, type: record.type, expected, actual: record.payload.length }
    );
  }
}

function makeSegmentCursor(record, startOffset) {
  if (!record.segments.length || startOffset < 0 || startOffset > record.segments[0].length) {
    fail(
      'BIFF8_INVALID_STRING_OFFSET',
      `BIFF8 字符串起点越界：${startOffset}`,
      { offset: record.offset, type: record.type }
    );
  }
  return { record, segmentIndex: 0, offset: startOffset };
}

function moveToNextSegment(cursor) {
  cursor.segmentIndex += 1;
  cursor.offset = 0;
  if (cursor.segmentIndex >= cursor.record.segments.length) {
    fail(
      'BIFF8_TRUNCATED_STRING',
      `BIFF8 字符串在 logical record ${cursor.record.offset} 中被截断`,
      { offset: cursor.record.offset, type: cursor.record.type }
    );
  }
}

function readCursorByte(cursor) {
  let segment = cursor.record.segments[cursor.segmentIndex];
  if (cursor.offset >= segment.length) {
    moveToNextSegment(cursor);
    segment = cursor.record.segments[cursor.segmentIndex];
  }
  const value = segment[cursor.offset];
  cursor.offset += 1;
  return value;
}

function readCursorUInt16(cursor) {
  const lo = readCursorByte(cursor);
  const hi = readCursorByte(cursor);
  return lo | (hi << 8);
}

function readCursorUInt32(cursor) {
  const b0 = readCursorByte(cursor);
  const b1 = readCursorByte(cursor);
  const b2 = readCursorByte(cursor);
  const b3 = readCursorByte(cursor);
  return (b0 | (b1 << 8) | (b2 << 16) | (b3 * 0x1000000)) >>> 0;
}

function cursorRemaining(cursor) {
  let remaining = cursor.record.segments[cursor.segmentIndex].length - cursor.offset;
  for (let index = cursor.segmentIndex + 1; index < cursor.record.segments.length; index += 1) {
    remaining += cursor.record.segments[index].length;
  }
  return remaining;
}

function readUnicodeCharacters(cursor, count, initialHighByte) {
  let highByte = initialHighByte;
  let text = '';
  for (let index = 0; index < count; index += 1) {
    let segment = cursor.record.segments[cursor.segmentIndex];
    if (cursor.offset >= segment.length) {
      moveToNextSegment(cursor);
      if (cursor.record.segments[cursor.segmentIndex].length === 0) {
        fail(
          'BIFF8_EMPTY_STRING_CONTINUE',
          'BIFF8 字符数组仍有内容时遇到空 Continue record',
          { offset: cursor.record.offset, type: cursor.record.type }
        );
      }
      // Continue 在字符数组中断开时，首字节重新声明后续字符压缩方式。
      const continuationFlags = readCursorByte(cursor);
      if ((continuationFlags & ~0x01) !== 0) {
        fail(
          'BIFF8_INVALID_CONTINUE_STRING_FLAGS',
          `BIFF8 Continue 字符串 flags 非法：${hex(continuationFlags, 2)}`,
          { offset: cursor.record.offset, type: cursor.record.type }
        );
      }
      highByte = (continuationFlags & 0x01) !== 0;
      segment = cursor.record.segments[cursor.segmentIndex];
    }
    if (highByte) {
      if (cursor.offset + 2 > segment.length) {
        fail(
          'BIFF8_SPLIT_UTF16_CODE_UNIT',
          'BIFF8 Continue 在 UTF-16 code unit 中间断开',
          { offset: cursor.record.offset, type: cursor.record.type }
        );
      }
      text += String.fromCharCode(segment.readUInt16LE(cursor.offset));
      cursor.offset += 2;
    } else {
      text += String.fromCharCode(segment[cursor.offset]);
      cursor.offset += 1;
    }
  }
  return text;
}

function skipCursorBytes(cursor, count) {
  for (let index = 0; index < count; index += 1) readCursorByte(cursor);
}

function parseUnicodeString(record, startOffset, options = {}) {
  const {
    shortCount = false,
    richExtended = false,
    requireExact = true
  } = options;
  const minimumHeaderLength = shortCount ? 2 : 3;
  if (record.segments[0].length - startOffset < minimumHeaderLength) {
    fail(
      'BIFF8_STRING_HEADER_CONTINUED',
      'BIFF8 Unicode string 的非变量 header 必须完整位于 base record',
      { offset: record.offset, type: record.type, startOffset }
    );
  }
  const cursor = makeSegmentCursor(record, startOffset);
  const count = shortCount ? readCursorByte(cursor) : readCursorUInt16(cursor);
  const flags = readCursorByte(cursor);
  const allowedFlags = richExtended ? 0x0d : 0x01;
  if ((flags & ~allowedFlags) !== 0) {
    fail(
      'BIFF8_INVALID_STRING_FLAGS',
      `BIFF8 Unicode string flags 非法：${hex(flags, 2)}`,
      { offset: record.offset, type: record.type, flags }
    );
  }
  let richRunCount = 0;
  let extensionLength = 0;
  if (richExtended && (flags & 0x08)) richRunCount = readCursorUInt16(cursor);
  if (richExtended && (flags & 0x04)) extensionLength = readCursorUInt32(cursor);
  if (cursor.segmentIndex !== 0) {
    fail(
      'BIFF8_STRING_HEADER_CONTINUED',
      'BIFF8 Unicode string 的非变量 header 不能跨 Continue',
      { offset: record.offset, type: record.type }
    );
  }
  const text = readUnicodeCharacters(cursor, count, (flags & 0x01) !== 0);
  skipCursorBytes(cursor, richRunCount * 4 + extensionLength);
  if (requireExact && cursorRemaining(cursor) !== 0) {
    fail(
      'BIFF8_STRING_TRAILING_BYTES',
      `BIFF8 Unicode string 后存在 ${cursorRemaining(cursor)} 个未解释字节`,
      { offset: record.offset, type: record.type }
    );
  }
  return { text, count, flags, richRunCount, extensionLength };
}

function parseBof(record, expectedType) {
  requireLength(record, 16, 'BOF');
  const version = record.payload.readUInt16LE(0);
  const substreamType = record.payload.readUInt16LE(2);
  if (version !== 0x0600) {
    fail(
      'BIFF8_UNSUPPORTED_VERSION',
      `仅支持 BIFF8（0x0600），当前 BOF version=${hex(version)}`,
      { offset: record.offset, version }
    );
  }
  if (expectedType != null && substreamType !== expectedType) {
    fail(
      'BIFF8_WRONG_SUBSTREAM_TYPE',
      `BIFF8 BOF 子流类型应为 ${hex(expectedType)}，实际 ${hex(substreamType)}`,
      { offset: record.offset, expectedType, substreamType }
    );
  }
  return { version, substreamType };
}

function parseBoundSheet(record) {
  requireMinimumLength(record, 8, 'BoundSheet8');
  if (record.segments.length !== 1) {
    fail('BIFF8_INVALID_BOUND_SHEET', 'BoundSheet8 不允许 Continue', { offset: record.offset });
  }
  const streamOffset = record.payload.readUInt32LE(0);
  const stateByte = record.payload[4];
  if ((stateByte & ~0x03) !== 0 || (stateByte & 0x03) === 0x03) {
    fail(
      'BIFF8_INVALID_SHEET_STATE',
      `BoundSheet8 hidden state 非法：${hex(stateByte, 2)}`,
      { offset: record.offset, stateByte }
    );
  }
  const sheetType = record.payload[5];
  if (![0x00, 0x01, 0x02, 0x06].includes(sheetType)) {
    fail(
      'BIFF8_INVALID_SHEET_TYPE',
      `BoundSheet8 sheet type 非法：${hex(sheetType, 2)}`,
      { offset: record.offset, sheetType }
    );
  }
  const parsedName = parseUnicodeString(record, 6, { shortCount: true, requireExact: true });
  const name = parsedName.text;
  if (name.length < 1 || name.length > 31 || /[\u0000\u0003:\\*?/\[\]]/.test(name) || /^'|'$/.test(name)) {
    fail(
      'BIFF8_INVALID_SHEET_NAME',
      `BoundSheet8 sheet name 非法：${JSON.stringify(name)}`,
      { offset: record.offset, name }
    );
  }
  return {
    streamOffset,
    state: ['visible', 'hidden', 'veryHidden'][stateByte & 0x03],
    stateCode: stateByte & 0x03,
    type: {
      0x00: 'worksheet',
      0x01: 'macro',
      0x02: 'chart',
      0x06: 'vbModule'
    }[sheetType],
    typeCode: sheetType,
    name
  };
}

function parseFont(record, fontRecordIndex) {
  requireMinimumLength(record, 16, 'Font');
  if (record.segments.length !== 1) {
    fail('BIFF8_INVALID_FONT', 'Font record 不允许 Continue', { offset: record.offset });
  }
  const payload = record.payload;
  const heightTwips = payload.readUInt16LE(0);
  const flags = payload.readUInt16LE(2);
  const indexedColor = payload.readUInt16LE(4);
  const weight = payload.readUInt16LE(6);
  const escapement = payload.readUInt16LE(8);
  const underlineCode = payload[10];
  const familyCode = payload[11];
  const charset = payload[12];
  const parsedName = parseUnicodeString(record, 14, { shortCount: true, requireExact: true });
  if (heightTwips !== 0 && (heightTwips < 20 || heightTwips > 8191)) {
    fail('BIFF8_INVALID_FONT_HEIGHT', `Font height twips 非法：${heightTwips}`, { offset: record.offset });
  }
  if (weight !== 0 && (weight < 100 || weight > 1000)) {
    fail('BIFF8_INVALID_FONT_WEIGHT', `Font weight 非法：${weight}`, { offset: record.offset });
  }
  if (![0, 1, 2].includes(escapement)) {
    fail('BIFF8_INVALID_FONT_ESCAPEMENT', `Font escapement 非法：${escapement}`, { offset: record.offset });
  }
  if (![0x00, 0x01, 0x02, 0x21, 0x22].includes(underlineCode)) {
    fail('BIFF8_INVALID_FONT_UNDERLINE', `Font underline 非法：${hex(underlineCode, 2)}`, {
      offset: record.offset
    });
  }
  if (parsedName.text.length < 1 || parsedName.text.length > 31) {
    fail('BIFF8_INVALID_FONT_NAME', 'BIFF8 Font name 必须是 1..31 个字符', {
      offset: record.offset,
      name: parsedName.text,
      flags: parsedName.flags
    });
  }
  return {
    recordIndex: fontRecordIndex,
    heightTwips,
    sizePoints: heightTwips / 20,
    italic: (flags & 0x0002) !== 0,
    strike: (flags & 0x0008) !== 0,
    outline: (flags & 0x0010) !== 0,
    shadow: (flags & 0x0020) !== 0,
    condense: (flags & 0x0040) !== 0,
    extend: (flags & 0x0080) !== 0,
    indexedColor,
    weight,
    bold: weight >= 700,
    vertAlign: escapement === 1 ? 'superscript' : (escapement === 2 ? 'subscript' : null),
    underline: {
      0x00: null,
      0x01: 'single',
      0x02: 'double',
      0x21: 'singleAccounting',
      0x22: 'doubleAccounting'
    }[underlineCode],
    familyCode,
    charset,
    name: parsedName.text,
    rawFlags: flags
  };
}

function parseFormat(record) {
  requireMinimumLength(record, 5, 'Format');
  if (record.segments.length !== 1) {
    fail('BIFF8_INVALID_FORMAT_CONTINUE', 'Format record 不应跨 Continue（BIFF8 格式字符串上限内可完整容纳）', {
      offset: record.offset
    });
  }
  const id = record.payload.readUInt16LE(0);
  const parsed = parseUnicodeString(record, 2, { requireExact: true });
  return { id, code: parsed.text };
}

function parsePalette(record) {
  requireMinimumLength(record, 2, 'Palette');
  if (record.segments.length !== 1) {
    fail('BIFF8_INVALID_PALETTE', 'Palette record 不允许 Continue', { offset: record.offset });
  }
  const count = record.payload.readUInt16LE(0);
  if (count > 56 || record.payload.length !== 2 + count * 4) {
    fail(
      'BIFF8_INVALID_PALETTE',
      `Palette 长度/数量不一致：count=${count}, length=${record.payload.length}`,
      { offset: record.offset, count, length: record.payload.length }
    );
  }
  const colors = [];
  for (let index = 0; index < count; index += 1) {
    const base = 2 + index * 4;
    colors.push(
      [record.payload[base], record.payload[base + 1], record.payload[base + 2]]
        .map((part) => part.toString(16).padStart(2, '0'))
        .join('')
        .toUpperCase()
    );
  }
  return colors;
}

function parseXf(record, index) {
  requireLength(record, 20, 'XF');
  const payload = record.payload;
  const fontIndex = payload.readUInt16LE(0);
  const numFmtId = payload.readUInt16LE(2);
  const flags = payload.readUInt16LE(4);
  const a = payload.readUInt32LE(6);
  const b = payload.readUInt32LE(10);
  const c = payload.readUInt32LE(14);
  const d = payload.readUInt16LE(18);
  const isStyle = ((flags >>> 2) & 1) !== 0;
  return {
    index,
    fontIndex,
    numFmtId,
    isStyle,
    parentXfIndex: flags >>> 4,
    protection: {
      locked: (flags & 0x01) !== 0,
      hidden: (flags & 0x02) !== 0
    },
    quotePrefix: (flags & 0x08) !== 0,
    usedAttributes: isStyle
      ? null
      : {
          numberFormat: ((a >>> 26) & 1) !== 0,
          font: ((a >>> 27) & 1) !== 0,
          alignment: ((a >>> 28) & 1) !== 0,
          border: ((a >>> 29) & 1) !== 0,
          fill: ((a >>> 30) & 1) !== 0,
          protection: ((a >>> 31) & 1) !== 0
        },
    alignment: {
      horizontalCode: a & 0x07,
      wrapText: ((a >>> 3) & 1) !== 0,
      verticalCode: (a >>> 4) & 0x07,
      justifyLastLine: ((a >>> 7) & 1) !== 0,
      rotationCode: (a >>> 8) & 0xff,
      indent: (a >>> 16) & 0x0f,
      shrinkToFit: ((a >>> 20) & 1) !== 0,
      readingOrderCode: (a >>> 22) & 0x03
    },
    border: {
      leftStyleCode: b & 0x0f,
      rightStyleCode: (b >>> 4) & 0x0f,
      topStyleCode: (b >>> 8) & 0x0f,
      bottomStyleCode: (b >>> 12) & 0x0f,
      leftColorIndex: (b >>> 16) & 0x7f,
      rightColorIndex: (b >>> 23) & 0x7f,
      diagonalFlags: (b >>> 30) & 0x03,
      topColorIndex: c & 0x7f,
      bottomColorIndex: (c >>> 7) & 0x7f,
      diagonalColorIndex: (c >>> 14) & 0x7f,
      diagonalStyleCode: (c >>> 21) & 0x0f
    },
    // StyleXF 在同一位定义的是 reserved2；只有 CellXF 才定义
    // fHasXFExt。真实 Excel 文件允许 XFExt 扩展 StyleXF。
    hasXfExt: !isStyle && ((c >>> 25) & 1) !== 0,
    styleReserved2: isStyle && ((c >>> 25) & 1) !== 0,
    fill: {
      patternCode: (c >>> 26) & 0x3f,
      foregroundColorIndex: d & 0x7f,
      backgroundColorIndex: (d >>> 7) & 0x7f
    },
    pivotButton: ((d >>> 14) & 1) !== 0,
    raw: { flags, a, b, c, d }
  };
}

function parseFrtHeader(payload, expectedType, recordOffset) {
  if (payload.length < 12) {
    fail('BIFF8_INVALID_FRT_HEADER', `FRT record ${hex(expectedType)} 少于 12 字节`, {
      offset: recordOffset,
      length: payload.length
    });
  }
  const actualType = payload.readUInt16LE(0);
  if (actualType !== expectedType) {
    fail(
      'BIFF8_FRT_TYPE_MISMATCH',
      `FRT header rt=${hex(actualType)} 与 record type=${hex(expectedType)} 不一致`,
      { offset: recordOffset, expectedType, actualType }
    );
  }
  return { flags: payload.readUInt16LE(2) };
}

function parseXfCrc(record) {
  requireLength(record, 20, 'XFCRC');
  parseFrtHeader(record.payload, RECORD.XF_CRC, record.offset);
  const reserved = record.payload.readUInt16LE(12);
  if (reserved !== 0) {
    fail('BIFF8_INVALID_XFCRC_RESERVED', 'XFCRC reserved 字段必须为 0', {
      offset: record.offset,
      reserved
    });
  }
  const xfCount = record.payload.readUInt16LE(14);
  if (xfCount < 16 || xfCount > 4050) {
    fail('BIFF8_INVALID_XFCRC_COUNT', `XFCRC cxfs=${xfCount} 超出 16–4050`, {
      offset: record.offset,
      xfCount
    });
  }
  return {
    xfCount,
    crc: record.payload.readUInt32LE(16)
  };
}

function parseFullColor(payload, record, extType) {
  if (payload.length !== 16) {
    fail(
      'BIFF8_INVALID_XFEXT_COLOR',
      `XFExt color property ${hex(extType)} 长度应为 16，实际 ${payload.length}`,
      { offset: record.offset, extType, length: payload.length }
    );
  }
  const colorType = payload.readUInt16LE(0);
  const tintRaw = payload.readInt16LE(2);
  const value = payload.readUInt32LE(4);
  if (tintRaw === -32768) {
    fail('BIFF8_INVALID_XFEXT_TINT', 'XFExt nTintShade 不允许 -32768', {
      offset: record.offset,
      extType
    });
  }
  const tint = tintRaw > 0 ? tintRaw / 32767 : (tintRaw < 0 ? tintRaw / 32768 : 0);
  switch (colorType) {
    case 0:
      if (value !== 0) fail('BIFF8_INVALID_XFEXT_COLOR', 'Automatic XFExt color 的 value 必须为 0');
      return { type: 'automatic', tint, rawType: colorType };
    case 1:
      if (value > 0x7fff) {
        fail('BIFF8_INVALID_XFEXT_COLOR', `Indexed XFExt color 越界：${value}`, {
          offset: record.offset,
          extType
        });
      }
      return { type: 'indexed', index: value, tint, rawType: colorType };
    case 2:
      return {
        type: 'rgb',
        rgb: [payload[4], payload[5], payload[6]]
          .map((part) => part.toString(16).padStart(2, '0'))
          .join('')
          .toUpperCase(),
        alpha: payload[7],
        tint,
        rawType: colorType
      };
    case 3:
      return { type: 'theme', theme: value, tint, rawType: colorType };
    case 4:
      if (value !== 0) fail('BIFF8_INVALID_XFEXT_COLOR', 'Not-set XFExt color 的 value 必须为 0');
      return { type: 'notSet', tint, rawType: colorType };
    default:
      fail(
        'BIFF8_UNKNOWN_XCOLOR_TYPE',
        `XFExt 使用未知 XColorType ${hex(colorType)}`,
        { offset: record.offset, extType, colorType }
      );
  }
}

function parseXfExt(record) {
  requireMinimumLength(record, 20, 'XFExt');
  if (record.segments.length !== 1) {
    fail(
      'BIFF8_UNSUPPORTED_XFEXT_CONTINUE',
      'XFExt 跨 Continue，无法在不支持 gradient 的本版安全还原',
      { offset: record.offset, segments: record.segments.length }
    );
  }
  parseFrtHeader(record.payload, RECORD.XF_EXT, record.offset);
  const reserved1 = record.payload.readUInt16LE(12);
  const xfIndex = record.payload.readUInt16LE(14);
  const reserved2 = record.payload.readUInt16LE(16);
  const count = record.payload.readUInt16LE(18);
  if (reserved1 !== 0 || reserved2 !== 0) {
    fail('BIFF8_INVALID_XFEXT_RESERVED', 'XFExt reserved 字段必须为 0', {
      offset: record.offset,
      reserved1,
      reserved2
    });
  }
  const properties = [];
  let offset = 20;
  for (let index = 0; index < count; index += 1) {
    if (offset + 4 > record.payload.length) {
      fail('BIFF8_TRUNCATED_XFEXT', 'XFExt property header 被截断', {
        offset: record.offset,
        propertyIndex: index
      });
    }
    const extType = record.payload.readUInt16LE(offset);
    const byteCount = record.payload.readUInt16LE(offset + 2);
    if (byteCount < 4 || offset + byteCount > record.payload.length) {
      fail(
        'BIFF8_TRUNCATED_XFEXT',
        `XFExt property ${hex(extType)} cb=${byteCount} 越界`,
        { offset: record.offset, propertyIndex: index, byteCount }
      );
    }
    const data = record.payload.subarray(offset + 4, offset + byteCount);
    let value;
    if ([0x04, 0x05, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0d].includes(extType)) {
      value = parseFullColor(data, record, extType);
    } else if (extType === 0x06) {
      value = { type: 'gradient', byteLength: data.length };
    } else if (extType === 0x0e || extType === 0x0f) {
      if (data.length !== 1 && data.length !== 2) {
        fail(
          'BIFF8_INVALID_XFEXT_SCALAR',
          `XFExt property ${hex(extType)} scalar 长度非法：${data.length}`,
          { offset: record.offset, extType }
        );
      }
      value = data.length === 1 ? data[0] : data.readUInt16LE(0);
    } else {
      value = { type: 'unknown', raw: Buffer.from(data) };
    }
    properties.push({ extType, byteCount, value });
    offset += byteCount;
  }
  if (offset !== record.payload.length) {
    fail(
      'BIFF8_XFEXT_TRAILING_BYTES',
      `XFExt 后存在 ${record.payload.length - offset} 个未解释字节`,
      { offset: record.offset, xfIndex }
    );
  }
  return { xfIndex, properties };
}

function parseTheme(record) {
  requireMinimumLength(record, 16, 'Theme');
  parseFrtHeader(record.payload, RECORD.THEME, record.offset);
  const version = record.payload.readUInt32LE(12);
  const packageBytes = record.payload.subarray(16);
  if (version === 123820 || version === 124226) {
    return { version, packageBytes: null, defaultTheme: true };
  }
  if (packageBytes.length < 4 || !packageBytes.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) {
    fail('BIFF8_INVALID_THEME_PACKAGE', 'BIFF8 Theme 没有合法 ZIP package magic', {
      offset: record.offset,
      version,
      packageLength: packageBytes.length
    });
  }
  return { version, packageBytes: Buffer.from(packageBytes), defaultTheme: false };
}

function parseCellHeader(payload, record, recordName) {
  if (payload.length < 6) {
    fail('BIFF8_INVALID_CELL_RECORD', `${recordName} cell header 被截断`, {
      offset: record.offset,
      length: payload.length
    });
  }
  const row = payload.readUInt16LE(0);
  const column = payload.readUInt16LE(2);
  const xfIndex = payload.readUInt16LE(4);
  if (column > 255) {
    fail('BIFF8_INVALID_CELL_COORDINATE', `${recordName} column=${column} 超出 BIFF8 范围`, {
      offset: record.offset,
      row,
      column
    });
  }
  return { row, column, xfIndex };
}

function validateFiniteNumericCell(value, record, recordName, cell) {
  if (Number.isFinite(value)) return value;
  fail(
    'BIFF8_NON_FINITE_CELL_VALUE',
    `${recordName} cached numeric value 不是有限数`,
    {
      offset: record.offset,
      recordType: recordName,
      row: cell.row,
      column: cell.column,
      value: String(value)
    }
  );
}

function decodeRkValue(raw) {
  let value;
  if ((raw & 0x02) !== 0) {
    value = (raw | 0) >> 2;
  } else {
    const bytes = Buffer.alloc(8);
    bytes.writeUInt32LE((raw & 0xfffffffc) >>> 0, 4);
    value = bytes.readDoubleLE(0);
  }
  return (raw & 0x01) !== 0 ? value / 100 : value;
}

function isValidBiff8ErrorCode(value) {
  return BIFF8_ERROR_CODES.has(value);
}

function validateBoolErrValue(record, cell) {
  const value = record.payload[6];
  const flag = record.payload[7];
  const valid = flag === 0
    ? (value === 0 || value === 1)
    : (flag === 1 && isValidBiff8ErrorCode(value));
  if (!valid) {
    fail(
      'BIFF8_INVALID_BOOLERR_VALUE',
      'BoolErr record 的 boolean/error 值域非法',
      {
        offset: record.offset,
        row: cell.row,
        column: cell.column,
        value,
        flag
      }
    );
  }
}

function validateFormulaCachedValue(record, cell) {
  const payload = record.payload;
  if (payload.readUInt16LE(12) !== 0xffff) {
    validateFiniteNumericCell(payload.readDoubleLE(6), record, 'Formula', cell);
    return 'number';
  }

  const resultType = payload[6];
  const value = payload[8];
  if (payload[7] !== 0 || payload[9] !== 0 || payload[10] !== 0 || payload[11] !== 0) {
    fail(
      'BIFF8_INVALID_FORMULA_CACHED_VALUE',
      'Formula special cached value 的 reserved bytes 必须为 0',
      {
        offset: record.offset,
        row: cell.row,
        column: cell.column,
        resultType
      }
    );
  }

  let valid = false;
  let kind = null;
  switch (resultType) {
    case 0x00:
      valid = value === 0;
      kind = 'string';
      break;
    case 0x01:
      valid = value === 0 || value === 1;
      kind = 'boolean';
      break;
    case 0x02:
      valid = isValidBiff8ErrorCode(value);
      kind = 'error';
      break;
    case 0x03:
      valid = value === 0;
      kind = 'blank';
      break;
    default:
      break;
  }
  if (!valid) {
    fail(
      'BIFF8_INVALID_FORMULA_CACHED_VALUE',
      'Formula special cached value 的类型或值域非法',
      {
        offset: record.offset,
        row: cell.row,
        column: cell.column,
        resultType,
        value
      }
    );
  }
  return kind;
}

function makeCell(record, recordName, hasValue, payload = record.payload) {
  const cell = parseCellHeader(payload, record, recordName);
  return {
    ...cell,
    recordType: recordName,
    recordOffset: record.offset,
    hasValue,
    explicitBlank: !hasValue
  };
}

function parseCellRecord(record) {
  const name = CELL_RECORD_NAMES[record.type];
  switch (record.type) {
    case RECORD.BLANK:
      requireLength(record, 6, name);
      return [makeCell(record, name, false)];
    case RECORD.NUMBER:
      requireLength(record, 14, name);
      {
        const cell = makeCell(record, name, true);
        validateFiniteNumericCell(record.payload.readDoubleLE(6), record, name, cell);
        return [cell];
      }
    case RECORD.RK: {
      requireLength(record, 10, name);
      const cell = makeCell(record, name, true);
      validateFiniteNumericCell(
        decodeRkValue(record.payload.readUInt32LE(6)),
        record,
        name,
        cell
      );
      return [cell];
    }
    case RECORD.LABEL_SST:
      requireLength(record, 10, name);
      return [makeCell(record, name, true)];
    case RECORD.BOOL_ERR: {
      requireLength(record, 8, name);
      const cell = makeCell(record, name, true);
      validateBoolErrValue(record, cell);
      return [cell];
    }
    case RECORD.FORMULA: {
      requireMinimumLength(record, 22, name);
      if (record.segments.length !== 1) {
        fail('BIFF8_INVALID_FORMULA_CONTINUE', 'Formula record 不允许直接使用 Continue', {
          offset: record.offset,
          segments: record.segments.length
        });
      }
      const cell = makeCell(record, name, true);
      cell.formulaCachedResultType = validateFormulaCachedValue(record, cell);
      return [cell];
    }
    case RECORD.LABEL:
      requireMinimumLength(record, 9, name);
      parseUnicodeString(record, 6, { requireExact: true });
      return [makeCell(record, name, true)];
    case RECORD.RSTRING:
      requireMinimumLength(record, 9, name);
      // RString 可在字符后携带 rich-run 数据；这里只验证字符串边界，不读取值。
      parseUnicodeString(record, 6, { requireExact: false });
      return [makeCell(record, name, true)];
    case RECORD.MUL_BLANK: {
      requireMinimumLength(record, 8, name);
      if (record.segments.length !== 1 || (record.payload.length - 6) % 2 !== 0) {
        fail('BIFF8_INVALID_MULBLANK', 'MulBlank record 长度非法', {
          offset: record.offset,
          length: record.payload.length
        });
      }
      const row = record.payload.readUInt16LE(0);
      const firstColumn = record.payload.readUInt16LE(2);
      const lastColumn = record.payload.readUInt16LE(record.payload.length - 2);
      const count = (record.payload.length - 6) / 2;
      if (lastColumn !== firstColumn + count - 1 || lastColumn > 255) {
        fail('BIFF8_INVALID_MULBLANK', 'MulBlank column range 与 XF 数量不一致', {
          offset: record.offset,
          row,
          firstColumn,
          lastColumn,
          count
        });
      }
      return Array.from({ length: count }, (_, index) => ({
        row,
        column: firstColumn + index,
        xfIndex: record.payload.readUInt16LE(4 + index * 2),
        recordType: name,
        recordOffset: record.offset,
        hasValue: false,
        explicitBlank: true
      }));
    }
    case RECORD.MUL_RK: {
      requireMinimumLength(record, 12, name);
      if (record.segments.length !== 1 || (record.payload.length - 6) % 6 !== 0) {
        fail('BIFF8_INVALID_MULRK', 'MulRK record 长度非法', {
          offset: record.offset,
          length: record.payload.length
        });
      }
      const row = record.payload.readUInt16LE(0);
      const firstColumn = record.payload.readUInt16LE(2);
      const lastColumn = record.payload.readUInt16LE(record.payload.length - 2);
      const count = (record.payload.length - 6) / 6;
      if (lastColumn !== firstColumn + count - 1 || lastColumn > 255) {
        fail('BIFF8_INVALID_MULRK', 'MulRK column range 与 RK 数量不一致', {
          offset: record.offset,
          row,
          firstColumn,
          lastColumn,
          count
        });
      }
      return Array.from({ length: count }, (_, index) => {
        const cell = {
          row,
          column: firstColumn + index,
          xfIndex: record.payload.readUInt16LE(4 + index * 6),
          recordType: name,
          recordOffset: record.offset,
          hasValue: true,
          explicitBlank: false
        };
        validateFiniteNumericCell(
          decodeRkValue(record.payload.readUInt32LE(6 + index * 6)),
          record,
          name,
          cell
        );
        return cell;
      });
    }
    default:
      return null;
  }
}

function parseRow(record) {
  requireLength(record, 16, 'Row');
  const payload = record.payload;
  const row = payload.readUInt16LE(0);
  const firstColumn = payload.readUInt16LE(2);
  const lastColumnExclusive = payload.readUInt16LE(4);
  const heightTwips = payload.readUInt16LE(6);
  const reserved1 = payload.readUInt16LE(8);
  const flags = payload[12];
  const reserved3 = payload[13];
  const xfFlags = payload.readUInt16LE(14);
  if (firstColumn > 255 || lastColumnExclusive > 256 || lastColumnExclusive < firstColumn) {
    fail('BIFF8_INVALID_ROW_RANGE', `Row ${row} 的 column range 非法`, {
      offset: record.offset,
      firstColumn,
      lastColumnExclusive
    });
  }
  if (heightTwips < 2 || heightTwips > 8192) {
    fail('BIFF8_INVALID_ROW_HEIGHT', `Row ${row} 的 height twips 非法：${heightTwips}`, {
      offset: record.offset
    });
  }
  if (reserved1 !== 0 || (flags & 0x08) !== 0 || reserved3 !== 0x01) {
    fail('BIFF8_INVALID_ROW_FLAGS', `Row ${row} reserved flags 非法`, {
      offset: record.offset,
      reserved1,
      flags,
      reserved3
    });
  }
  const formatted = (flags & 0x80) !== 0;
  return {
    row,
    firstColumn,
    lastColumnExclusive,
    heightTwips,
    heightPoints: heightTwips / 20,
    customHeight: (flags & 0x40) !== 0,
    hidden: (flags & 0x20) !== 0,
    collapsed: (flags & 0x10) !== 0,
    outlineLevel: flags & 0x07,
    formatted,
    xfIndex: formatted ? (xfFlags & 0x0fff) : null,
    thickTop: (xfFlags & 0x1000) !== 0,
    thickBottom: (xfFlags & 0x2000) !== 0,
    phonetic: (xfFlags & 0x4000) !== 0,
    recordOffset: record.offset
  };
}

function parseDimensions(record) {
  requireLength(record, 14, 'Dimensions');
  const payload = record.payload;
  const firstRow = payload.readUInt32LE(0);
  const lastRowExclusive = payload.readUInt32LE(4);
  const firstColumn = payload.readUInt16LE(8);
  const lastColumnExclusive = payload.readUInt16LE(10);
  const reserved = payload.readUInt16LE(12);
  if (
    firstRow > 65535
    || lastRowExclusive > 65536
    || lastRowExclusive < firstRow
    || firstColumn > 255
    || lastColumnExclusive > 256
    || lastColumnExclusive < firstColumn
    || reserved !== 0
  ) {
    fail('BIFF8_INVALID_DIMENSIONS', 'Dimensions used range 非法', {
      offset: record.offset,
      firstRow,
      lastRowExclusive,
      firstColumn,
      lastColumnExclusive,
      reserved
    });
  }
  return {
    firstRow,
    lastRowExclusive,
    firstColumn,
    lastColumnExclusive,
    recordOffset: record.offset
  };
}

function parseColInfo(record) {
  requireLength(record, 12, 'ColInfo');
  const payload = record.payload;
  const firstColumn = payload.readUInt16LE(0);
  const rawLastColumn = payload.readUInt16LE(2);
  // LibreOffice 会用 256 表示“从 firstColumn 到 BIFF8 最后一列”的兼容哨兵。
  // BIFF8 实际可寻址列仍只有 0..255；必须在进入布局/样式解析前收口到 255，
  // 否则下游 OOXML writer 会凭空创建第 257 列。
  const lastColumn = rawLastColumn === 256 ? 255 : rawLastColumn;
  const width256 = payload.readUInt16LE(4);
  const xfIndex = payload.readUInt16LE(6);
  const flags = payload.readUInt16LE(8);
  if (firstColumn > 255 || rawLastColumn > 256 || lastColumn < firstColumn) {
    fail('BIFF8_INVALID_COLUMN_RANGE', 'ColInfo column range 非法', {
      offset: record.offset,
      firstColumn,
      lastColumn: rawLastColumn
    });
  }
  if ((flags & 0xe0f0) !== 0) {
    fail('BIFF8_INVALID_COLINFO_FLAGS', 'ColInfo reserved flags 非法', {
      offset: record.offset,
      flags
    });
  }
  return {
    firstColumn,
    lastColumn,
    rawLastColumn,
    endSentinelNormalized: rawLastColumn === 256,
    width256,
    widthCharacters: width256 / 256,
    xfIndex,
    hidden: (flags & 0x0001) !== 0,
    userSet: (flags & 0x0002) !== 0,
    bestFit: (flags & 0x0004) !== 0,
    phonetic: (flags & 0x0008) !== 0,
    outlineLevel: (flags >>> 8) & 0x07,
    collapsed: (flags & 0x1000) !== 0,
    recordOffset: record.offset
  };
}

function parseDefaultRowHeight(record) {
  requireLength(record, 4, 'DefaultRowHeight');
  const flags = record.payload.readUInt16LE(0);
  const heightTwips = record.payload.readInt16LE(2);
  if (
    (flags & 0xfff0) !== 0
    || heightTwips < 0
    || heightTwips > 8179
    || ((flags & 0x02) === 0 && heightTwips < 1)
  ) {
    fail('BIFF8_INVALID_DEFAULT_ROW_HEIGHT', 'DefaultRowHeight flags/height 非法', {
      offset: record.offset,
      flags,
      heightTwips
    });
  }
  return {
    customHeight: (flags & 0x01) !== 0,
    hidden: (flags & 0x02) !== 0,
    thickTop: (flags & 0x04) !== 0,
    thickBottom: (flags & 0x08) !== 0,
    heightTwips,
    heightPoints: heightTwips / 20
  };
}

function validateCellXfIndex(cell, xfs, sheetName, sourceLabel = 'cell') {
  if (!Number.isInteger(cell.xfIndex) || cell.xfIndex < 0 || cell.xfIndex >= xfs.length) {
    fail(
      'BIFF8_CELL_XF_OUT_OF_RANGE',
      `${sheetName} 的 ${sourceLabel} 引用不存在的 XF ${cell.xfIndex}`,
      {
        sheetName,
        row: cell.row,
        column: cell.column,
        xfIndex: cell.xfIndex,
        xfCount: xfs.length,
        sourceLabel
      }
    );
  }
  if (xfs[cell.xfIndex].isStyle) {
    fail(
      'BIFF8_EXPECTED_CELL_XF',
      `${sheetName} 的 ${sourceLabel} 引用了 Style XF ${cell.xfIndex}，应引用 Cell XF`,
      { sheetName, row: cell.row, column: cell.column, xfIndex: cell.xfIndex, sourceLabel }
    );
  }
}

function scanSheet(buffer, boundSheet, xfs) {
  const start = boundSheet.streamOffset;
  const bof = readScanRecord(buffer, start);
  if (bof.type !== RECORD.BOF) {
    fail(
      'BIFF8_BOUND_SHEET_OFFSET_MISMATCH',
      `BoundSheet8 ${boundSheet.name} offset=${start} 未指向 BOF`,
      { sheetName: boundSheet.name, streamOffset: start, actualType: bof.type }
    );
  }
  const expectedSubstreamType = {
    worksheet: 0x0010,
    macro: 0x0040,
    chart: 0x0020,
    vbModule: 0x0006
  }[boundSheet.type];
  parseBof(bof, expectedSubstreamType);

  const sheet = {
    name: boundSheet.name,
    state: boundSheet.state,
    type: boundSheet.type,
    streamOffset: start,
    endOffset: null,
    dimensions: null,
    defaultRow: null,
    defColWidth: null,
    standardWidth: null,
    rows: [],
    columns: [],
    cells: []
  };
  const rowKeys = new Set();
  const cellKeys = new Set();
  let pendingFormulaString = null;
  let previousRowIndex = -1;
  let offset = bof.nextOffset;
  let foundEof = false;

  while (offset < buffer.length) {
    const record = readScanRecord(buffer, offset);
    offset = record.nextOffset;
    if (record.type === RECORD.BOF) {
      fail('BIFF8_NESTED_BOF', `Sheet ${sheet.name} 在 EOF 前出现 BOF`, { offset: record.offset });
    }
    if (record.type === RECORD.FILE_PASS) {
      fail('BIFF8_ENCRYPTED_FILE', '不支持加密的 BIFF8 工作簿，请另存为未加密 .xls 或 .xlsx', {
        offset: record.offset,
        sheetName: sheet.name
      });
    }
    if (record.type === RECORD.EOF) {
      requireLength(record, 0, 'EOF');
      foundEof = true;
      sheet.endOffset = record.nextOffset;
      break;
    }

    if (record.type === RECORD.DIMENSIONS) {
      if (sheet.dimensions) {
        fail('BIFF8_DUPLICATE_DIMENSIONS', `Sheet ${sheet.name} 存在多个 Dimensions`);
      }
      sheet.dimensions = parseDimensions(record);
      continue;
    }
    if (record.type === RECORD.DEFAULT_ROW_HEIGHT || record.type === RECORD.DEFAULT_ROW_HEIGHT_OLD) {
      if (sheet.defaultRow) {
        fail('BIFF8_DUPLICATE_DEFAULT_ROW_HEIGHT', `Sheet ${sheet.name} 存在多个 DefaultRowHeight`);
      }
      sheet.defaultRow = parseDefaultRowHeight(record);
      continue;
    }
    if (record.type === RECORD.DEF_COL_WIDTH) {
      requireLength(record, 2, 'DefColWidth');
      if (sheet.defColWidth != null) fail('BIFF8_DUPLICATE_DEF_COL_WIDTH', `Sheet ${sheet.name} 存在多个 DefColWidth`);
      sheet.defColWidth = record.payload.readUInt16LE(0);
      if (sheet.defColWidth > 255) {
        fail('BIFF8_INVALID_DEF_COL_WIDTH', `Sheet ${sheet.name} DefColWidth 超过 255`);
      }
      continue;
    }
    if (record.type === RECORD.STANDARD_WIDTH) {
      requireLength(record, 2, 'StandardWidth');
      if (sheet.standardWidth != null) {
        fail('BIFF8_DUPLICATE_STANDARD_WIDTH', `Sheet ${sheet.name} 存在多个 StandardWidth`);
      }
      sheet.standardWidth = record.payload.readUInt16LE(0);
      continue;
    }
    if (record.type === RECORD.COL_INFO) {
      const column = parseColInfo(record);
      validateCellXfIndex(
        { row: null, column: column.firstColumn, xfIndex: column.xfIndex },
        xfs,
        sheet.name,
        `ColInfo ${column.firstColumn}-${column.lastColumn}`
      );
      for (const existing of sheet.columns) {
        if (column.firstColumn <= existing.lastColumn && column.lastColumn >= existing.firstColumn) {
          fail('BIFF8_OVERLAPPING_COLINFO', `Sheet ${sheet.name} 的 ColInfo 范围重叠`, {
            sheetName: sheet.name,
            first: [existing.firstColumn, existing.lastColumn],
            second: [column.firstColumn, column.lastColumn]
          });
        }
      }
      sheet.columns.push(column);
      continue;
    }
    if (record.type === RECORD.ROW) {
      const row = parseRow(record);
      if (rowKeys.has(row.row)) {
        fail('BIFF8_DUPLICATE_ROW', `Sheet ${sheet.name} 存在重复 Row ${row.row + 1}`);
      }
      if (row.row <= previousRowIndex) {
        fail('BIFF8_ROW_ORDER_INVALID', `Sheet ${sheet.name} 的 Row record 未按行号递增`, {
          sheetName: sheet.name,
          previousRowIndex,
          row: row.row
        });
      }
      if (row.formatted) {
        validateCellXfIndex(row, xfs, sheet.name, `Row ${row.row + 1}`);
      }
      rowKeys.add(row.row);
      previousRowIndex = row.row;
      sheet.rows.push(row);
      continue;
    }
    if (record.type === RECORD.STRING) {
      if (!pendingFormulaString) {
        fail('BIFF8_ORPHAN_STRING', `Sheet ${sheet.name} 的 String record 没有对应 Formula`, {
          offset: record.offset
        });
      }
      parseUnicodeString(record, 0, { requireExact: true });
      pendingFormulaString = null;
      continue;
    }

    const cells = parseCellRecord(record);
    if (!cells) continue;
    if (pendingFormulaString) {
      fail(
        'BIFF8_MISSING_FORMULA_STRING',
        `Sheet ${sheet.name} 的 Formula cached string 缺少后续 String record`,
        pendingFormulaString
      );
    }
    for (const cell of cells) {
      validateCellXfIndex(cell, xfs, sheet.name);
      const key = `${cell.row}:${cell.column}`;
      if (cellKeys.has(key)) {
        fail(
          'BIFF8_DUPLICATE_CELL',
          `Sheet ${sheet.name}!R${cell.row + 1}C${cell.column + 1} 存在重复 cell record`,
          { sheetName: sheet.name, row: cell.row, column: cell.column }
        );
      }
      cellKeys.add(key);
      sheet.cells.push(cell);
    }
    if (
      record.type === RECORD.FORMULA
      && cells[0].formulaCachedResultType === 'string'
    ) {
      pendingFormulaString = {
        sheetName: sheet.name,
        row: cells[0].row,
        column: cells[0].column,
        recordOffset: record.offset
      };
    }
  }
  if (!foundEof) {
    fail('BIFF8_MISSING_EOF', `Sheet ${sheet.name} 缺少 EOF`, { sheetName: sheet.name, start });
  }
  if (pendingFormulaString) {
    fail(
      'BIFF8_MISSING_FORMULA_STRING',
      `Sheet ${sheet.name} 的 Formula cached string 缺少后续 String record`,
      pendingFormulaString
    );
  }
  sheet.rows.sort((left, right) => left.row - right.row);
  sheet.columns.sort((left, right) => left.firstColumn - right.firstColumn);
  sheet.cells.sort((left, right) => left.row - right.row || left.column - right.column);
  sheet.defaultColumnWidth = sheet.standardWidth != null
    ? sheet.standardWidth / 256
    : sheet.defColWidth;
  if (sheet.type === 'worksheet' || sheet.type === 'macro') {
    if (!sheet.dimensions) {
      fail('BIFF8_MISSING_DIMENSIONS', `Sheet ${sheet.name} 缺少 Dimensions`, {
        sheetName: sheet.name
      });
    }
    const dimensions = sheet.dimensions;
    for (const row of sheet.rows) {
      const rowRangeEmpty = row.firstColumn === row.lastColumnExclusive;
      if (
        row.row < dimensions.firstRow
        || row.row >= dimensions.lastRowExclusive
        || (!rowRangeEmpty && (
          row.firstColumn < dimensions.firstColumn
          || row.lastColumnExclusive > dimensions.lastColumnExclusive
        ))
      ) {
        fail('BIFF8_ROW_OUTSIDE_DIMENSIONS', `Sheet ${sheet.name} 的 Row ${row.row + 1} 超出 Dimensions`, {
          sheetName: sheet.name,
          row: row.row,
          rowRange: [row.firstColumn, row.lastColumnExclusive],
          dimensions
        });
      }
    }
    const rowsByIndex = new Map(sheet.rows.map((row) => [row.row, row]));
    for (const cell of sheet.cells) {
      if (
        cell.row < dimensions.firstRow
        || cell.row >= dimensions.lastRowExclusive
        || cell.column < dimensions.firstColumn
        || cell.column >= dimensions.lastColumnExclusive
      ) {
        fail(
          'BIFF8_CELL_OUTSIDE_DIMENSIONS',
          `${sheet.name}!R${cell.row + 1}C${cell.column + 1} 超出 Dimensions`,
          {
            sheetName: sheet.name,
            row: cell.row,
            column: cell.column,
            dimensions
          }
        );
      }
      const row = rowsByIndex.get(cell.row);
      // Row、DefaultRowHeight 和 DefColWidth 都可能被合法 BIFF8 生成器省略。
      // 省略 Row 时按工作簿默认行属性解释；一旦存在显式 Row，则其列范围必须与 cell table 一致。
      if (row && (cell.column < row.firstColumn || cell.column >= row.lastColumnExclusive)) {
        fail(
          'BIFF8_CELL_OUTSIDE_ROW_RANGE',
          `${sheet.name}!R${cell.row + 1}C${cell.column + 1} 不在对应 Row record 的 column range 内`,
          {
            sheetName: sheet.name,
            row: cell.row,
            column: cell.column,
            rowRange: row ? [row.firstColumn, row.lastColumnExclusive] : null
          }
        );
      }
    }
  }
  return sheet;
}

function fontIndexToRecordIndex(fontIndex) {
  if (fontIndex === 4) {
    fail('BIFF8_RESERVED_FONT_INDEX', 'BIFF8 FontIndex 4 为保留值，不能被 XF 引用', { fontIndex });
  }
  return fontIndex > 4 ? fontIndex - 1 : fontIndex;
}

function isRecordAuthoritativeFormatId(id) {
  return id >= 50 || BIFF8_RECORD_AUTHORITATIVE_LOW_FORMAT_RANGES.some(
    ([minimum, maximum]) => id >= minimum && id <= maximum
  );
}

function validateXfLineage(xfs, fonts, formats) {
  let firstCellXfIndex = null;
  xfs.forEach((xf) => {
    const fontRecordIndex = fontIndexToRecordIndex(xf.fontIndex);
    if (fontRecordIndex < 0 || fontRecordIndex >= fonts.length) {
      fail('BIFF8_XF_FONT_OUT_OF_RANGE', `XF ${xf.index} 引用不存在的 Font ${xf.fontIndex}`, {
        xfIndex: xf.index,
        fontIndex: xf.fontIndex,
        fontRecordIndex,
        fontCount: fonts.length
      });
    }
    xf.fontRecordIndex = fontRecordIndex;
    if (xf.isStyle) {
      if (xf.parentXfIndex !== 0x0fff) {
        fail('BIFF8_INVALID_STYLE_XF_PARENT', `Style XF ${xf.index} 的 parent 必须为 0xFFF`, {
          xfIndex: xf.index,
          parentXfIndex: xf.parentXfIndex
        });
      }
    } else {
      if (firstCellXfIndex == null) firstCellXfIndex = xf.index;
      if (xf.parentXfIndex >= xfs.length || !xfs[xf.parentXfIndex].isStyle) {
        fail(
          'BIFF8_INVALID_CELL_XF_PARENT',
          `Cell XF ${xf.index} 的 parent ${xf.parentXfIndex} 不是有效 Style XF`,
          { xfIndex: xf.index, parentXfIndex: xf.parentXfIndex }
        );
      }
    }
    if (!formats.has(xf.numFmtId)) {
      fail('BIFF8_XF_NUMFMT_OUT_OF_RANGE', `XF ${xf.index} 引用未知 numFmt ${xf.numFmtId}`, {
        xfIndex: xf.index,
        numFmtId: xf.numFmtId
      });
    }
  });
  if (firstCellXfIndex == null) {
    fail('BIFF8_MISSING_CELL_XF', 'BIFF8 Globals 中没有 Cell XF');
  }
  if (!xfs.length || !xfs[0].isStyle) {
    fail('BIFF8_MISSING_NORMAL_STYLE_XF', 'BIFF8 第一个 XF 必须是 Normal Style XF');
  }
  return firstCellXfIndex;
}

function scanBiff8WorkbookStream(stream, options = {}) {
  const buffer = ensureBuffer(stream);
  if (buffer.length < 8) fail('BIFF8_TRUNCATED_STREAM', 'Workbook stream 太短');
  const first = readScanRecord(buffer, 0);
  if (first.type !== RECORD.BOF) {
    fail(
      'BIFF8_MISSING_GLOBAL_BOF',
      `Workbook stream 必须从 BIFF8 BOF ${hex(RECORD.BOF)} 开始，实际 ${hex(first.type)}`,
      { actualType: first.type }
    );
  }
  parseBof(first, 0x0005);

  const result = {
    format: 'biff8',
    streamLength: buffer.length,
    globalEndOffset: null,
    codePage: null,
    date1904: false,
    fonts: [],
    formats: new Map(),
    customFormats: [],
    palette: null,
    xfs: [],
    xfCrc: null,
    computedXfCrc: 0,
    xfExts: [],
    theme: null,
    boundSheets: [],
    sheets: [],
    workbookDefaultCellXfIndex: null
  };

  const builtinFormats = {
    ...(options.builtinFormats || {}),
    ...DEFAULT_BUILTIN_FORMATS
  };
  for (const [key, value] of Object.entries(builtinFormats)) {
    result.formats.set(Number(key), value);
  }

  let offset = first.nextOffset;
  let foundGlobalEof = false;
  let seenDate1904 = false;
  const definedFormatIds = new Set();
  while (offset < buffer.length) {
    const record = readScanRecord(buffer, offset);
    offset = record.nextOffset;
    if (record.type === RECORD.BOF) {
      fail('BIFF8_GLOBAL_EOF_MISSING', 'Globals Substream 在 worksheet BOF 前缺少 EOF', {
        offset: record.offset
      });
    }
    if (record.type === RECORD.FILE_PASS) {
      fail('BIFF8_ENCRYPTED_FILE', '不支持加密的 BIFF8 工作簿，请另存为未加密 .xls 或 .xlsx', {
        offset: record.offset
      });
    }
    if (record.type === RECORD.EOF) {
      requireLength(record, 0, 'EOF');
      result.globalEndOffset = record.nextOffset;
      foundGlobalEof = true;
      break;
    }
    switch (record.type) {
      case RECORD.CODE_PAGE:
        requireLength(record, 2, 'CodePage');
        if (result.codePage != null) fail('BIFF8_DUPLICATE_CODEPAGE', 'Globals 中存在多个 CodePage');
        result.codePage = record.payload.readUInt16LE(0);
        if (result.codePage === 0) fail('BIFF8_INVALID_CODEPAGE', 'BIFF8 CodePage 不能为 0');
        break;
      case RECORD.DATE_1904:
        requireLength(record, 2, 'Date1904');
        if (seenDate1904) fail('BIFF8_DUPLICATE_DATE1904', 'Globals 中存在多个 Date1904');
        if (record.payload.readUInt16LE(0) > 1) {
          fail('BIFF8_INVALID_DATE1904', 'Date1904 只能为 0 或 1', { offset: record.offset });
        }
        seenDate1904 = true;
        result.date1904 = record.payload.readUInt16LE(0) === 1;
        break;
      case RECORD.FONT:
        result.fonts.push(parseFont(record, result.fonts.length));
        break;
      case RECORD.FORMAT: {
        const format = parseFormat(record);
        const existingCode = result.formats.get(format.id);
        if (!isRecordAuthoritativeFormatId(format.id)) {
          if (existingCode == null || existingCode !== format.code) {
            fail(
              'BIFF8_PROTECTED_FORMAT_OVERRIDE',
              `Format id ${format.id} 不能冲突覆盖 canonical built-in`,
              {
                offset: record.offset,
                id: format.id,
                expectedCode: existingCode == null ? null : existingCode,
                actualCode: format.code
              }
            );
          }
          definedFormatIds.add(format.id);
          break;
        }
        if (definedFormatIds.has(format.id) && existingCode !== format.code) {
          fail('BIFF8_DUPLICATE_FORMAT_ID', `Format id ${format.id} 被定义为不同字符串`, {
            offset: record.offset,
            id: format.id
          });
        }
        definedFormatIds.add(format.id);
        result.formats.set(format.id, format.code);
        result.customFormats.push(format);
        break;
      }
      case RECORD.PALETTE:
        if (result.palette) fail('BIFF8_DUPLICATE_PALETTE', 'Globals 中存在多个 Palette');
        result.palette = parsePalette(record);
        break;
      case RECORD.XF: {
        const parsedXf = parseXf(record, result.xfs.length);
        if (parsedXf.styleReserved2) {
          fail('BIFF8_INVALID_STYLE_XF_RESERVED', `Style XF ${parsedXf.index} 的 reserved2 必须为 0`, {
            offset: record.offset,
            xfIndex: parsedXf.index
          });
        }
        result.xfs.push(parsedXf);
        result.computedXfCrc = msoCrc32Compute(result.computedXfCrc, record.payload);
        break;
      }
      case RECORD.XF_CRC:
        if (result.xfCrc) fail('BIFF8_DUPLICATE_XFCRC', 'Globals 中存在多个 XFCRC');
        result.xfCrc = parseXfCrc(record);
        break;
      case RECORD.XF_EXT:
        result.xfExts.push(parseXfExt(record));
        break;
      case RECORD.THEME:
        if (result.theme) fail('BIFF8_DUPLICATE_THEME', 'Globals 中存在多个 Theme');
        result.theme = parseTheme(record);
        break;
      case RECORD.BOUND_SHEET_8:
        result.boundSheets.push(parseBoundSheet(record));
        break;
      default:
        break;
    }
  }
  if (!foundGlobalEof) fail('BIFF8_MISSING_GLOBAL_EOF', 'Globals Substream 缺少 EOF');
  if (result.codePage == null) fail('BIFF8_MISSING_CODEPAGE', 'BIFF8 Globals 缺少 CodePage');
  if (!result.fonts.length) fail('BIFF8_MISSING_FONT', 'BIFF8 Globals 缺少 Font records');
  if (!result.xfs.length) fail('BIFF8_MISSING_XF', 'BIFF8 Globals 缺少 XF records');
  if (!result.boundSheets.length) fail('BIFF8_MISSING_BOUND_SHEET', 'BIFF8 Globals 缺少 BoundSheet8');

  const seenSheetNames = new Set();
  const seenSheetOffsets = new Set();
  result.boundSheets.forEach((sheet) => {
    const nameKey = sheet.name.toLocaleLowerCase('en-US');
    if (seenSheetNames.has(nameKey)) {
      fail('BIFF8_DUPLICATE_SHEET_NAME', `BIFF8 sheet name（不区分大小写）重复：${sheet.name}`);
    }
    if (seenSheetOffsets.has(sheet.streamOffset)) {
      fail('BIFF8_DUPLICATE_SHEET_OFFSET', `多个 BoundSheet8 指向同一 offset ${sheet.streamOffset}`);
    }
    if (sheet.streamOffset < result.globalEndOffset || sheet.streamOffset + 4 > buffer.length) {
      fail('BIFF8_BOUND_SHEET_OFFSET_OUT_OF_RANGE', `BoundSheet8 ${sheet.name} offset 越界`, {
        sheetName: sheet.name,
        streamOffset: sheet.streamOffset,
        globalEndOffset: result.globalEndOffset,
        streamLength: buffer.length
      });
    }
    seenSheetNames.add(nameKey);
    seenSheetOffsets.add(sheet.streamOffset);
  });

  result.workbookDefaultCellXfIndex = validateXfLineage(result.xfs, result.fonts, result.formats);
  if (result.xfExts.length > 0 && !result.xfCrc) {
    fail('BIFF8_MISSING_XFCRC', '存在 XFExt 时 Globals 必须包含 XFCRC', {
      xfExtCount: result.xfExts.length
    });
  }
  if (result.xfCrc && result.xfExts.length === 0) {
    fail('BIFF8_ORPHAN_XFCRC', '不存在 XFExt 时 Globals 不得包含 XFCRC');
  }
  if (result.xfCrc && result.xfCrc.xfCount !== result.xfs.length) {
    fail('BIFF8_XFCRC_COUNT_MISMATCH', `XFCRC cxfs=${result.xfCrc.xfCount}，实际 XF=${result.xfs.length}`, {
      xfCrcCount: result.xfCrc.xfCount,
      xfCount: result.xfs.length
    });
  }
  if (result.xfCrc && result.xfCrc.crc !== result.computedXfCrc) {
    fail(
      'BIFF8_XFCRC_MISMATCH',
      `XFCRC crc=${hex(result.xfCrc.crc, 8)}，实际 XF checksum=${hex(result.computedXfCrc, 8)}`,
      {
        expectedCrc: result.xfCrc.crc,
        actualCrc: result.computedXfCrc
      }
    );
  }
  const seenXfExt = new Set();
  result.xfExts.forEach((extension) => {
    if (extension.xfIndex >= result.xfs.length) {
      fail('BIFF8_XFEXT_INDEX_OUT_OF_RANGE', `XFExt 引用不存在的 XF ${extension.xfIndex}`, {
        xfIndex: extension.xfIndex,
        xfCount: result.xfs.length
      });
    }
    if (seenXfExt.has(extension.xfIndex)) {
      fail('BIFF8_DUPLICATE_XFEXT', `XF ${extension.xfIndex} 存在多个 XFExt`);
    }
    seenXfExt.add(extension.xfIndex);
  });
  result.xfs.forEach((xf) => {
    if (xf.isStyle) return;
    const hasExtension = seenXfExt.has(xf.index);
    if (xf.hasXfExt !== hasExtension) {
      fail(
        'BIFF8_XFEXT_FLAG_MISMATCH',
        `Cell XF ${xf.index} 的 fHasXFExt=${xf.hasXfExt ? 1 : 0}，实际 XFExt=${hasExtension ? 1 : 0}`,
        {
          xfIndex: xf.index,
          hasXfExt: xf.hasXfExt,
          hasExtension
        }
      );
    }
  });

  // BoundSheet8 的数组顺序就是标签显示顺序；物理 offset 只用于定位子流。
  result.sheets = result.boundSheets.map((sheet) => scanSheet(buffer, sheet, result.xfs));
  const physicalSheets = result.sheets.slice().sort((left, right) => left.streamOffset - right.streamOffset);
  for (let index = 0; index < physicalSheets.length; index += 1) {
    const current = physicalSheets[index];
    const next = physicalSheets[index + 1];
    if (next && current.endOffset > next.streamOffset) {
      fail('BIFF8_OVERLAPPING_SHEET_SUBSTREAM', `Sheet ${current.name} 子流与 ${next.name} 重叠`, {
        current: [current.streamOffset, current.endOffset],
        next: [next.streamOffset, next.endOffset]
      });
    }
  }

  return result;
}

module.exports = {
  BIFF8_MAX_RECORD_PAYLOAD,
  BIFF8_MAX_THEME_LOGICAL_BYTES,
  BIFF8_MAX_STRING_LOGICAL_BYTES,
  DEFAULT_BUILTIN_FORMATS,
  RECORD,
  CELL_RECORD_NAMES,
  Biff8RecordError,
  readPhysicalRecord,
  readLogicalRecord,
  msoCrc32Compute,
  parseUnicodeString,
  scanBiff8WorkbookStream,
  fontIndexToRecordIndex
};
