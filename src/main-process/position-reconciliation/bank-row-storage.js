'use strict';

// 平盘银行行的列式存储（v3.2.22）：只保存交互字段，一行一份，不再保存整行 JSON。
// Main 的 store 与导入进程共用这里的列定义、取值编码和「行 ⇄ 字段对象」换算。
// 本文件不依赖 store，避免与导入进程形成环形依赖。

const {
  POSITION_BANK_INTERACTION_FIELDS,
  POSITION_BANK_ROW_FIELDS,
  RAW_ROW_NUMBER_HEADER,
  RAW_VERSION_HEADER
} = require('./constants');
const { PositionReconciliationError, text } = require('./common');

const DATE_JSON_TYPE_KEY = '__position_reconciliation_type__';
// 既不是有限数字也不是字符串的单元格值（日期、布尔）以此前缀 + JSON 文本保存，读回时还原成原类型。
const ENCODED_CELL_PREFIX = '\u0001';

// 交互字段 → 值列。列不声明类型（无亲和性）：数字按数字存、文本按文本存，读回类型不变，
// 不会把 "00123" 这类长编号转成数字。
const VALUE_COLUMN_BY_FIELD = Object.freeze({
  BillDate: 'raw_bill_date',
  地区: 'region',
  MerchantId: 'merchant_id',
  Currency: 'currency',
  'Credit Amount': 'credit_amount',
  'Debit Amount': 'debit_amount',
  ReconciliationId: 'reconciliation_id',
  ChannelOrderNo: 'channel_order_no',
  CustomerRef: 'customer_ref',
  'Payee CardNo': 'payee_card_no',
  'Drawee CardNo': 'drawee_card_no',
  'Extra Fee': 'extra_fee'
});
// BizId / Channel / FundType 已有规范化后的索引列；原值与索引列完全相同时覆盖列留空，不重复保存。
const OVERRIDE_COLUMN_BY_FIELD = Object.freeze({
  BizId: ['raw_biz_id', 'biz_id'],
  Channel: ['raw_channel', 'channel'],
  FundType: ['raw_fund_type', 'original_fund_type']
});
const BANK_VALUE_COLUMNS = Object.freeze([
  ...Object.values(OVERRIDE_COLUMN_BY_FIELD).map(([column]) => column),
  ...Object.values(VALUE_COLUMN_BY_FIELD)
]);

const RAW_FILE_STATUSES = Object.freeze({
  ACTIVE: 'active',
  SUPERSEDED: 'superseded'
});
const BANK_RAW_FILE_KIND = 'bank';

function encodeStoredCell(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : '';
  if (value instanceof Date) {
    return ENCODED_CELL_PREFIX + JSON.stringify({
      [DATE_JSON_TYPE_KEY]: 'Date',
      value: Number.isNaN(value.getTime()) ? null : value.toISOString()
    });
  }
  return ENCODED_CELL_PREFIX + JSON.stringify(value);
}

function decodeStoredCell(value) {
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string' || !value.startsWith(ENCODED_CELL_PREFIX)) return value;
  let parsed;
  try {
    parsed = JSON.parse(value.slice(ENCODED_CELL_PREFIX.length));
  } catch (error) {
    throw new PositionReconciliationError(
      'position-side-data-invalid',
      `平盘侧库银行行取值损坏：${error.message}`
    );
  }
  if (parsed && typeof parsed === 'object' && parsed[DATE_JSON_TYPE_KEY] === 'Date') {
    if (parsed.value === null) return 'Invalid Date';
    const date = typeof parsed.value === 'string' ? new Date(parsed.value) : new Date(Number.NaN);
    if (Number.isNaN(date.getTime())) {
      throw new PositionReconciliationError(
        'position-side-data-invalid',
        `平盘侧库银行行取值损坏：日期标记无效：${String(parsed.value)}`
      );
    }
    return date;
  }
  return parsed;
}

// 从读出的整行（46 列或结果格式）取出交互字段，缺的列按空串。
function pickInteractionFields(row) {
  const picked = {};
  for (const field of POSITION_BANK_INTERACTION_FIELDS) picked[field] = row[field] ?? '';
  return picked;
}

// 交互字段对象 → 值列（与 BANK_VALUE_COLUMNS 同序）。
function bankValueColumnsFromFields(fields) {
  const overrides = Object.entries(OVERRIDE_COLUMN_BY_FIELD).map(([field]) => {
    const value = fields[field] ?? '';
    return typeof value === 'string' && value === text(value) ? null : encodeStoredCell(value);
  });
  const values = Object.keys(VALUE_COLUMN_BY_FIELD).map((field) => encodeStoredCell(fields[field]));
  return [...overrides, ...values];
}

// 表行 → 原始字段对象（FundType 为导入时的原值），带原始版本号 / 行号。
function bankFieldsFromStoredRow(row) {
  const fields = {};
  for (const field of POSITION_BANK_INTERACTION_FIELDS) {
    const override = OVERRIDE_COLUMN_BY_FIELD[field];
    if (override) {
      const [column, indexColumn] = override;
      const stored = row[column];
      fields[field] = stored === null || stored === undefined
        ? (row[indexColumn] ?? '')
        : decodeStoredCell(stored);
    } else {
      fields[field] = decodeStoredCell(row[VALUE_COLUMN_BY_FIELD[field]]);
    }
  }
  fields[RAW_VERSION_HEADER] = Number(row.raw_version);
  fields[RAW_ROW_NUMBER_HEADER] = Number(row.raw_row_number);
  return fields;
}

// 当前工作行：只有 FundType 可能与原始行不同（已确认的资金性质结果）。
function bankWorkingFieldsFromStoredRow(row, originalFields = bankFieldsFromStoredRow(row)) {
  if (text(row.working_fund_type) === text(row.original_fund_type)) return { ...originalFields };
  return { ...originalFields, FundType: text(row.working_fund_type) };
}

// 结果行由原始行 + 结果资金性质得出，不单独保存。
function bankResultFields(originalFields, resultFundType) {
  if (text(originalFields.FundType) === text(resultFundType)) return { ...originalFields };
  return { ...originalFields, FundType: text(resultFundType) };
}

// 行已全部被替换或删除的银行原始文件版本标为「已被替换」；原件仍在存档中心，可按版本号追溯。
function markSupersededBankRawFiles(db) {
  return Number(db.prepare(`
    UPDATE position_raw_files
    SET status = ?, superseded_at = CURRENT_TIMESTAMP
    WHERE kind = ? AND status = ?
      AND NOT EXISTS (
        SELECT 1 FROM position_bank_rows bank
        WHERE bank.raw_version = position_raw_files.version
      )
  `).run(
    RAW_FILE_STATUSES.SUPERSEDED,
    BANK_RAW_FILE_KIND,
    RAW_FILE_STATUSES.ACTIVE
  ).changes || 0);
}

function insertRawFileStatement(db) {
  return db.prepare(`
    INSERT INTO position_raw_files(
      kind, original_name, original_path, sheet_name, size_bytes, sha256, row_count,
      status, operation_token, archive_batch_number
    ) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?)
  `);
}

module.exports = {
  BANK_RAW_FILE_KIND,
  BANK_VALUE_COLUMNS,
  POSITION_BANK_ROW_FIELDS,
  RAW_FILE_STATUSES,
  bankFieldsFromStoredRow,
  bankResultFields,
  bankValueColumnsFromFields,
  bankWorkingFieldsFromStoredRow,
  decodeStoredCell,
  encodeStoredCell,
  insertRawFileStatement,
  markSupersededBankRawFiles,
  pickInteractionFields
};
