const SUPPORTED_EXTENSIONS = new Set(['.xlsx', '.xls', '.csv']);
const FIXED_FIELD_VALUE_PREFIX = '__FIXED__:';
// v3.2.16：映射值「字段筛选特征值」在生成 lookup 里的内部 token，避免与真实表头重名。
// v3.2.18：token 带所选特征值 id（`__FEATURE_FILTER__:<id>`），由 feature-filter.js 构造与解析。
const FEATURE_FILTER_FIELD_TOKEN_PREFIX = '__FEATURE_FILTER__:';
// v3.2.19：映射值「逻辑取值」在生成 lookup 里的内部 token（`\u0000__LOGIC_VALUE__:<JSON 候补字段数组>`），由 logic-value.js 构造与解析。
//   以 NUL 开头：XLSX / XLS / 常规文本表头不会含 NUL，真实列名不会与 token 相同（旧模板的列名即使形如 `__LOGIC_VALUE__:[…]`
//   也照常按源字段直接取值，新配置的逻辑取值也不会被同名列覆盖）。token 只在生成时使用，不落库。
const LOGIC_VALUE_FIELD_TOKEN_PREFIX = '\u0000__LOGIC_VALUE__:';
// v3.2.21：「逻辑取值」候补中的特征值，落库为 `\u0000__FEATURE_FILTER__:<id>`（由 logic-value.js 构造与解析）。
//   以 NUL 开头：v3.2.19/v3.2.20 的候补都是源列名，表头不会含 NUL，旧候补（即使形如 `__FEATURE_FILTER__:1`）仍按源列读取。
//   不同于生成 lookup 里直选特征值的 token（FEATURE_FILTER_FIELD_TOKEN_PREFIX，不落库）。
const LOGIC_VALUE_FEATURE_CANDIDATE_PREFIX = '\u0000__FEATURE_FILTER__:';
// v3.2.16：MerchantId「原始账单仅有币种无账户号」在模板映射中的存储值。
// 刻意不带 __FIXED__: 前缀：带前缀的值会被当成「自己输入」或固定账号，漏改的路径会静默出错；
// 不带前缀时漏改的路径会按“映射字段不存在”报错，buildMappedRows 另有拦截。
const MERCHANT_ID_CURRENCY_ONLY_MARKER = '__CURRENCY_ONLY_BIG_ACCOUNT__';

class FileValidationError extends Error {
  constructor(code, message, options = {}) {
    super(message);
    this.name = 'FileValidationError';
    this.code = code;
    this.detailLines = Array.isArray(options.detailLines) ? options.detailLines.slice() : [];
    // v3.2.21：写入活动日志的明细（不给时同 detailLines）；报错文件保留核对所需原值，日志可只记行号与原因
    if (Array.isArray(options.logDetailLines)) this.logDetailLines = options.logDetailLines.slice();
    this.context = options.context && typeof options.context === 'object' ? { ...options.context } : {};
  }
}

function normalizeCell(value) {
  if (value === null || value === undefined) {
    return '';
  }

  return String(value).trim();
}

// v3.2.21 B112：读取库读成数字、且超出安全整数范围的整数——文件里写的长卡号 / 流水号可能已丢失末几位。
//   网银账单生成按原文还原后仍是这种数字的，说明文件里没有可核对的原值（二进制 .xls、Excel 另存的 xlsx 等）
function isUnverifiedLongNumber(value) {
  return typeof value === 'number' && Number.isInteger(value) && !Number.isSafeInteger(value);
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

// 能原样写入 XLSX 工作表的文本：未配对 UTF-16 代理项写出后变成「�」；U+FFFE、U+FFFF 是 XML 1.0 禁止的字符，写出后工作表无法解析。
//   其他控制字符写出时按 _xHHHH_ 转义，字面的 _xHHHH_ 由写出边界转义（writers.js，B113），都可原样读回。
function isWorksheetWritableText(value) {
  return typeof value === 'string' && value.isWellFormed() && !/[\uFFFE\uFFFF]/.test(value);
}

// v3.2.22 B113：行数据中无法原样写入工作表的文本。行号定位交易所在的源行；值可能取自源文件，也可能来自大账号回填、
//   手动选择或固定值配置，提示不限定为修正源文件。rows 首行为表头（列名），rowMetas[i] 对应 rows[i + 1]（取源行号）；
//   include(row) 为 false 的行不看（如收付金额均为空或 0、不导出的行）。只保留前 limit 处位置说明，另计总数（大批出错时不随错误数占用内存）
const UNWRITABLE_TEXT_DETAIL_LIMIT = 20;
function noteUnwritableRowText(found, row, fieldNames, meta) {
  row.forEach((value, columnIndex) => {
    if (typeof value !== 'string' || isWorksheetWritableText(value)) return;
    found.total += 1;
    if (found.labels.length >= UNWRITABLE_TEXT_DETAIL_LIMIT) return;
    const rowLabel = meta && meta.sourceRowNumber !== undefined ? `第 ${meta.sourceRowNumber} 行` : '';
    found.labels.push(`${rowLabel}写进「${fieldNames[columnIndex]}」列的值`);
  });
  return found;
}

function collectUnwritableRowText(rows, { rowMetas = [], include = null, found = { total: 0, labels: [] } } = {}) {
  const fieldNames = Array.isArray(rows[0]) ? rows[0] : [];
  for (let index = 1; index < rows.length; index += 1) {
    const row = rows[index];
    if (!Array.isArray(row) || (include && !include(row))) continue;
    noteUnwritableRowText(found, row, fieldNames, rowMetas[index - 1]);
  }
  return found;
}

// 无法写入的字符的拒绝只需行列位置与数量：标记 positionsOnly，调用方不要把整批记录（如完整账号）放进报错文件
function markPositionsOnly(error) {
  Object.defineProperty(error, 'positionsOnly', { value: true, enumerable: false });
  return error;
}

function assertNoUnwritableRowText(found) {
  if (!found.total) return;
  const detailLines = found.labels.slice();
  if (found.total > detailLines.length) detailLines.push(`另有 ${found.total - detailLines.length} 处，共 ${found.total} 处`);
  throw markPositionsOnly(new FileValidationError(
    'FILE_READ',
    `源文件${found.labels[0]}含无法写入 Excel 的字符（U+FFFE、U+FFFF 或不完整的 Unicode 字符）${found.total > 1 ? `等 ${found.total} 处` : ''}，请按值的来源修正源文件或模板的大账号、固定值配置后重新生成`,
    { detailLines }
  ));
}

module.exports = {
  FEATURE_FILTER_FIELD_TOKEN_PREFIX,
  FileValidationError,
  FIXED_FIELD_VALUE_PREFIX,
  LOGIC_VALUE_FIELD_TOKEN_PREFIX,
  LOGIC_VALUE_FEATURE_CANDIDATE_PREFIX,
  MERCHANT_ID_CURRENCY_ONLY_MARKER,
  SUPPORTED_EXTENSIONS,
  buildExpectedHeaderCandidates,
  isRowMeaningful,
  isUnverifiedLongNumber,
  isWorksheetWritableText,
  UNWRITABLE_TEXT_DETAIL_LIMIT,
  assertNoUnwritableRowText,
  collectUnwritableRowText,
  markPositionsOnly,
  noteUnwritableRowText,
  normalizeCell,
  trimTrailingEmptyCells
};
