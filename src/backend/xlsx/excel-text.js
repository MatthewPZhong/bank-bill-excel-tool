'use strict';

const EXCEL_CELL_TEXT_MAX_UTF16_UNITS = 32767;
const EXCEL_ST_XSTRING_MAX_RAW_UTF16_UNITS =
  EXCEL_CELL_TEXT_MAX_UTF16_UNITS * 7;
const ST_XSTRING_ESCAPE_PATTERN = /_[xX]([0-9A-Fa-f]{4})_/g;
const ST_XSTRING_ESCAPE_AT_START = /^_[xX][0-9A-Fa-f]{4}_/;

class ToolboxExcelTextError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'ToolboxExcelTextError';
    this.code = 'TOOLBOX_EXCEL_TEXT_INVALID';
    this.details = { ...details };
  }
}

function assertWellFormedUtf16(text) {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code === 0xFFFE || code === 0xFFFF) {
      throw new ToolboxExcelTextError('文本包含 Excel/OOXML 无法保真的 Unicode 非字符', {
        utf16Index: index,
        codeUnit: code
      });
    }
    if (code >= 0xD800 && code <= 0xDBFF) {
      const next = index + 1 < text.length ? text.charCodeAt(index + 1) : -1;
      if (next < 0xDC00 || next > 0xDFFF) {
        throw new ToolboxExcelTextError('文本包含未配对的 UTF-16 高代理项', {
          utf16Index: index,
          codeUnit: code
        });
      }
      index += 1;
    } else if (code >= 0xDC00 && code <= 0xDFFF) {
      throw new ToolboxExcelTextError('文本包含未配对的 UTF-16 低代理项', {
        utf16Index: index,
        codeUnit: code
      });
    }
  }
}

function decodeExcelStXstring(value) {
  const source = String(value == null ? '' : value);
  const decoded = source.replace(
    ST_XSTRING_ESCAPE_PATTERN,
    (_match, hex) => String.fromCharCode(Number.parseInt(hex, 16))
  );
  assertWellFormedUtf16(decoded);
  return decoded;
}

function shouldEncodeCodeUnit(code) {
  return code <= 0x0008 ||
    (code >= 0x000B && code <= 0x000C) ||
    (code >= 0x000D && code <= 0x001F) ||
    code === 0x007F;
}

function encodeExcelStXstring(value) {
  const source = String(value == null ? '' : value);
  assertWellFormedUtf16(source);
  let encoded = '';
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] === '_' &&
        ST_XSTRING_ESCAPE_AT_START.test(source.slice(index, index + 7))) {
      // 只转义开头下划线；剩余 xHHHH_ 继续按普通文本写入。
      encoded += '_x005F_';
      continue;
    }
    const code = source.charCodeAt(index);
    if (shouldEncodeCodeUnit(code)) {
      encoded += `_x${code.toString(16).toUpperCase().padStart(4, '0')}_`;
      continue;
    }
    encoded += source[index];
    if (code >= 0xD800 && code <= 0xDBFF) {
      index += 1;
      encoded += source[index];
    }
  }
  return encoded;
}

function assertExcelCellTextLength(value) {
  const text = String(value == null ? '' : value);
  if (text.length > EXCEL_CELL_TEXT_MAX_UTF16_UNITS) {
    throw new ToolboxExcelTextError(
      `文本超过 Excel 单元格 ${EXCEL_CELL_TEXT_MAX_UTF16_UNITS} 个 UTF-16 code unit 上限`,
      {
        utf16Length: text.length,
        maxUtf16Length: EXCEL_CELL_TEXT_MAX_UTF16_UNITS
      }
    );
  }
  return text;
}

function assertExcelStXstringRawLength(value) {
  const text = String(value == null ? '' : value);
  if (text.length > EXCEL_ST_XSTRING_MAX_RAW_UTF16_UNITS) {
    throw new ToolboxExcelTextError(
      'ST_Xstring 词法长度超过单个 Excel 单元格的保守读取上限',
      {
        rawUtf16Length: text.length,
        maxRawUtf16Length: EXCEL_ST_XSTRING_MAX_RAW_UTF16_UNITS
      }
    );
  }
  return text;
}

module.exports = {
  EXCEL_CELL_TEXT_MAX_UTF16_UNITS,
  EXCEL_ST_XSTRING_MAX_RAW_UTF16_UNITS,
  ToolboxExcelTextError,
  assertExcelCellTextLength,
  assertExcelStXstringRawLength,
  assertWellFormedUtf16,
  decodeExcelStXstring,
  encodeExcelStXstring
};
