const SUPPORTED_EXTENSIONS = new Set(['.xlsx', '.xls', '.csv']);
const FIXED_FIELD_VALUE_PREFIX = '__FIXED__:';

class FileValidationError extends Error {
  constructor(code, message, options = {}) {
    super(message);
    this.name = 'FileValidationError';
    this.code = code;
    this.detailLines = Array.isArray(options.detailLines) ? options.detailLines.slice() : [];
    this.context = options.context && typeof options.context === 'object' ? { ...options.context } : {};
  }
}

function normalizeCell(value) {
  if (value === null || value === undefined) {
    return '';
  }

  return String(value).trim();
}

function isRowMeaningful(row) {
  return Array.isArray(row) && row.some((cell) => normalizeCell(cell) !== '');
}

function trimTrailingEmptyCells(row) {
  if (!Array.isArray(row)) {
    return [];
  }

  const lastMeaningfulIndex = row.reduce((index, cell, currentIndex) => {
    return normalizeCell(cell) !== '' ? currentIndex : index;
  }, -1);

  if (lastMeaningfulIndex < 0) {
    return [];
  }

  return row.slice(0, lastMeaningfulIndex + 1);
}

// 模板表头定位用的候选口径，按顺序尝试：
//   1) 完整结构：只裁首尾空项，保留中间空项（多为合并单元格占位，如 KBANK-VN 的「Số tiền ghi nợ」占 G:I），
//      与原始账单逐列对齐；首尾空项不参与，表头前后有无空列都能靠起始列偏移命中。
//   2) 旧口径：去掉全部空项，兼容「模板有中间空项、实际账单没有这些空列」的已有模板。
// 两种口径相同（无中间空项）时只返回一个；全空或非数组返回 []（调用方按「无表头约束」处理）。
// readRowsWithMetadata 与账号识别的表头定位共用本函数，二者必须同口径。
function buildExpectedHeaderCandidates(expectedHeaders) {
  if (!Array.isArray(expectedHeaders)) {
    return [];
  }

  const normalizedHeaders = trimTrailingEmptyCells(expectedHeaders.map((header) => normalizeCell(header)));
  const firstMeaningfulIndex = normalizedHeaders.findIndex((header) => header !== '');

  if (firstMeaningfulIndex < 0) {
    return [];
  }

  const positionalHeaders = normalizedHeaders.slice(firstMeaningfulIndex);
  const compactHeaders = positionalHeaders.filter((header) => header !== '');

  return compactHeaders.length === positionalHeaders.length
    ? [positionalHeaders]
    : [positionalHeaders, compactHeaders];
}

module.exports = {
  FileValidationError,
  FIXED_FIELD_VALUE_PREFIX,
  SUPPORTED_EXTENSIONS,
  buildExpectedHeaderCandidates,
  isRowMeaningful,
  normalizeCell,
  trimTrailingEmptyCells
};
