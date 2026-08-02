'use strict';

const crypto = require('node:crypto');
const { normalizeDateExportValue } = require('../file-service/normalizers');
const {
  subtractCanonicalDecimals
} = require('../../main-process/financial-decimal');
const { canonicalizeVccAmount } = require('./amount-rules');
const {
  SOURCE_TYPES,
  SUPPORTED_CURRENCIES,
  getSourceDefinition
} = require('./definitions');

const HASH_VERSION = 1;
const CURRENCY_SET = new Set(SUPPORTED_CURRENCIES);
const TEXT_CELL_TYPES = new Set(['s', 'inlineStr', 'str']);

function text(value) {
  return String(value == null ? '' : value).trim();
}

function rawText(value) {
  return String(value == null ? '' : value);
}

function normalizeYearMonth(value) {
  const match = text(value).match(/^(\d{4})-(\d{2})$/);
  if (!match) return null;
  const month = Number(match[2]);
  return month >= 1 && month <= 12 ? `${match[1]}-${match[2]}` : null;
}

function formatDate(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return null;
  return [
    String(date.getFullYear()).padStart(4, '0'),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0')
  ].join('-');
}

function normalizeDate(value) {
  const raw = text(value);
  const normalizedValue = typeof value === 'string'
    && /^\d{1,7}(?:\.\d+)?$/.test(raw)
    && !/^\d{6}$/.test(raw)
    ? Number(raw)
    : value;
  return formatDate(normalizeDateExportValue(normalizedValue).date);
}

function monthOfDate(value) {
  const yearMonth = normalizeYearMonth(value);
  if (yearMonth) return yearMonth;
  const compact = text(value).match(/^(\d{4})(\d{2})$/);
  if (compact) return normalizeYearMonth(`${compact[1]}-${compact[2]}`);
  const iso = normalizeDate(value);
  return iso ? iso.slice(0, 7) : null;
}

function monthEndIso(yearMonth) {
  const normalized = normalizeYearMonth(yearMonth);
  if (!normalized) return null;
  const [year, month] = normalized.split('-').map(Number);
  return formatDate(new Date(year, month, 0));
}

function negateDecimal(value, label) {
  return subtractCanonicalDecimals('0', value, {
    leftLabel: '零',
    rightLabel: label,
    label: `${label}转负`
  });
}

function parseAmount(value, label) {
  return canonicalizeVccAmount(value, label);
}

function signByDirection(amount, direction, label) {
  if (direction === 'in') return amount;
  if (direction === 'out') return negateDecimal(amount, label);
  throw new Error(`${label}方向仅允许 in 或 out，实际为“${direction}”`);
}

function requireText(value, field) {
  const normalized = text(value);
  if (!normalized) throw new Error(`${field}不能为空`);
  return normalized;
}

function requireSupportedCurrency(value, field) {
  const currency = requireText(value, field);
  if (!CURRENCY_SET.has(currency)) {
    throw new Error(`${field}“${currency}”不在支持币种 ${SUPPORTED_CURRENCIES.join('、')} 中`);
  }
  return currency;
}

function rowValue(values, definition, header) {
  return values[definition.indexes[header]];
}

function contentHash(sourceType, rawJson, assignedSubject) {
  const payload = sourceType === SOURCE_TYPES.CHANNEL
    ? JSON.stringify({ raw: rawJson, assignedSubject: text(assignedSubject) })
    : rawJson;
  return crypto.createHash('sha256').update(payload, 'utf8').digest('hex');
}

function baseMappedRow({
  sourceType,
  values,
  targetMonth,
  assignedSubject,
  sourceFile,
  sheetName,
  sourceRow,
  keyCellType
}) {
  const definition = getSourceDefinition(sourceType);
  if (!definition) throw new Error(`不支持的 VCC 财务OP原表类型：${sourceType}`);
  const normalizedValues = definition.headers.map((_header, index) => rawText(values[index]));
  const rawJson = JSON.stringify(normalizedValues);
  const keyRaw = rowValue(normalizedValues, definition, definition.keyHeader);
  const key = text(keyRaw);
  return {
    sourceType,
    targetMonth,
    idempotencyKeyRaw: rawText(keyRaw),
    idempotencyKey: key,
    contentHash: contentHash(sourceType, rawJson, assignedSubject),
    hashVersion: HASH_VERSION,
    subject: null,
    statCurrency: null,
    signedAmount: null,
    businessDepartment: null,
    counterpartyDepartment: null,
    businessSubType: null,
    channelName: null,
    mid: null,
    reconType: null,
    pendingCurrency: null,
    pendingAmount: null,
    flowCurrency: null,
    flowAmount: null,
    currencyMismatch: null,
    sourceFile,
    sheetName,
    sourceRow,
    rawJson,
    disposition: null,
    validationField: null,
    validationMessage: null,
    values: normalizedValues,
    definition,
    keyCellType
  };
}

function failRow(row, disposition, field, message) {
  return {
    ...row,
    disposition,
    validationField: field,
    validationMessage: message
  };
}

function validateCommon(row, assignedSubject) {
  if (!row.idempotencyKey) {
    return failRow(row, 'invalid_key', row.definition.keyHeader, `${row.definition.keyHeader}不能为空或仅含空白`);
  }
  if (row.keyCellType !== undefined && !TEXT_CELL_TYPES.has(row.keyCellType)) {
    return failRow(
      row,
      'invalid_key',
      row.definition.keyHeader,
      `${row.definition.keyHeader}必须在 Excel 中存为文本，数值型业务键无法保证无损读取`
    );
  }

  const rowMonth = monthOfDate(rowValue(row.values, row.definition, row.definition.monthHeader));
  if (!rowMonth) {
    return failRow(row, 'format_error', row.definition.monthHeader, `${row.definition.monthHeader}无法解析为有效日期`);
  }
  if (rowMonth !== row.targetMonth) {
    return failRow(
      row,
      'format_error',
      row.definition.monthHeader,
      `${row.definition.monthHeader}账期为 ${rowMonth}，与本次导入账期 ${row.targetMonth} 不一致`
    );
  }

  try {
    row.subject = row.definition.requiresFileSubject
      ? requireText(assignedSubject, '公司主体')
      : requireText(rowValue(row.values, row.definition, row.definition.subjectHeader), row.definition.subjectHeader);
  } catch (error) {
    return failRow(row, 'format_error', '公司主体', error.message);
  }
  return row;
}

function mapNonChannel(row) {
  const d = row.definition;
  try {
    const direction = requireText(rowValue(row.values, d, '出入方向'), '出入方向');
    const amount = parseAmount(rowValue(row.values, d, '我方到账金额'), '我方到账金额');
    row.statCurrency = requireSupportedCurrency(rowValue(row.values, d, '我方币种'), '我方币种');
    row.signedAmount = signByDirection(amount, direction, '我方到账金额');
    row.businessDepartment = text(rowValue(row.values, d, '业务部门'));
    row.counterpartyDepartment = row.sourceType === SOURCE_TYPES.RECHARGE
      ? text(rowValue(row.values, d, '对手部门'))
      : '';
    row.businessSubType = text(rowValue(row.values, d, '业务子类型'));
    return row;
  } catch (error) {
    const field = /方向/.test(error.message) ? '出入方向'
      : (/币种/.test(error.message) ? '我方币种' : '我方到账金额');
    return failRow(row, 'format_error', field, error.message);
  }
}

function mapChannel(row) {
  const d = row.definition;
  try {
    const direction = requireText(rowValue(row.values, d, '借贷方向'), '借贷方向');
    row.channelName = requireText(rowValue(row.values, d, '通道名称'), '通道名称');
    row.mid = text(rowValue(row.values, d, 'MID'));
    row.businessDepartment = text(rowValue(row.values, d, '部门'));

    let amount;
    if (row.channelName === 'CITI') {
      row.statCurrency = requireSupportedCurrency(rowValue(row.values, d, '交易币种'), '交易币种');
      amount = parseAmount(rowValue(row.values, d, '交易金额'), '交易金额');
    } else {
      const billDate = normalizeDate(rowValue(row.values, d, 'billdate'));
      if (!billDate) throw new Error('billdate无法解析为有效日期');
      if (billDate > monthEndIso(row.targetMonth)) {
        row.statCurrency = requireSupportedCurrency(rowValue(row.values, d, '清算币种'), '清算币种');
        amount = parseAmount(rowValue(row.values, d, '清算金额'), '清算金额');
      } else {
        row.statCurrency = requireSupportedCurrency(rowValue(row.values, d, '结算币种'), '结算币种');
        amount = parseAmount(rowValue(row.values, d, '实际到账金额'), '实际到账金额');
      }
    }
    row.signedAmount = signByDirection(amount, direction, '通道发生额');
    return row;
  } catch (error) {
    let field = '通道金额';
    if (/方向/.test(error.message)) field = '借贷方向';
    else if (/币种/.test(error.message)) field = '统计币种';
    else if (/billdate/.test(error.message)) field = 'billdate';
    return failRow(row, 'format_error', field, error.message);
  }
}

function mapPending(row) {
  const d = row.definition;
  try {
    row.reconType = requireText(rowValue(row.values, d, '对账类型'), '对账类型');
    row.channelName = text(rowValue(row.values, d, 'channel'));
    row.pendingCurrency = requireSupportedCurrency(rowValue(row.values, d, '币种'), '币种');
    row.flowCurrency = requireSupportedCurrency(rowValue(row.values, d, '流水_币种'), '流水_币种');
    const pending = parseAmount(rowValue(row.values, d, '金额'), '金额');
    const flow = parseAmount(rowValue(row.values, d, '流水_对账金额'), '流水_对账金额');

    if (row.reconType === 'VCC_clearing_credit') {
      row.pendingAmount = negateDecimal(pending, '金额');
      row.flowAmount = flow;
    } else if (row.reconType === 'VCC_clearing_debit') {
      row.pendingAmount = pending;
      row.flowAmount = negateDecimal(flow, '流水_对账金额');
    } else {
      throw new Error(`对账类型仅允许 VCC_clearing_credit 或 VCC_clearing_debit，实际为“${row.reconType}”`);
    }
    row.currencyMismatch = row.pendingCurrency === row.flowCurrency ? 0 : 1;
    return row;
  } catch (error) {
    let field = '金额';
    if (/对账类型/.test(error.message)) field = '对账类型';
    else if (/流水_币种/.test(error.message)) field = '流水_币种';
    else if (/币种/.test(error.message)) field = '币种';
    else if (/流水_对账金额/.test(error.message)) field = '流水_对账金额';
    return failRow(row, 'format_error', field, error.message);
  }
}

function mapDetailRow(input) {
  const targetMonth = normalizeYearMonth(input && input.targetMonth);
  if (!targetMonth) throw new Error(`导入账期格式无效：${input && input.targetMonth}`);
  let row = baseMappedRow({ ...input, targetMonth });
  row = validateCommon(row, input.assignedSubject);
  if (row.disposition) return row;

  if (row.sourceType === SOURCE_TYPES.RECHARGE || row.sourceType === SOURCE_TYPES.FEE_FX) {
    return mapNonChannel(row);
  }
  if (row.sourceType === SOURCE_TYPES.CHANNEL) return mapChannel(row);
  if (row.sourceType === SOURCE_TYPES.PENDING) return mapPending(row);
  return failRow(row, 'format_error', '', `不支持的原表类型：${row.sourceType}`);
}

function mappedRowToInsertParams(recordId, row) {
  return [
    recordId,
    row.sourceType,
    row.targetMonth,
    row.idempotencyKeyRaw,
    row.idempotencyKey,
    row.contentHash,
    row.hashVersion,
    row.subject,
    row.statCurrency,
    row.signedAmount,
    row.businessDepartment,
    row.counterpartyDepartment,
    row.businessSubType,
    row.channelName,
    row.mid,
    row.reconType,
    row.pendingCurrency,
    row.pendingAmount,
    row.flowCurrency,
    row.flowAmount,
    row.currencyMismatch,
    row.sourceFile,
    row.sheetName,
    row.sourceRow,
    row.rawJson,
    row.disposition,
    row.validationField,
    row.validationMessage
  ];
}

module.exports = {
  HASH_VERSION,
  TEXT_CELL_TYPES,
  normalizeYearMonth,
  normalizeDate,
  monthOfDate,
  monthEndIso,
  contentHash,
  mapDetailRow,
  mappedRowToInsertParams
};
