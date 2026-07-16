'use strict';

const crypto = require('node:crypto');
const path = require('node:path');

const { FileValidationError } = require('../../backend/file-service/common');

const MPT_DELIMITER = '|$|';
const MPT_EXPECTED_FIELD_COUNT = 33;
const SOURCE_TYPE_INBOUND = 'MPT_INBOUND_GATEWAY';
const SOURCE_TYPE_OUTBOUND = 'MPT_OUTBOUND_GATEWAY';

const INBOUND_FIELDS = Object.freeze([
  'batchNo', 'billDate', 'channel', 'entity', 'merchantId', 'business', 'oppBu', 'tradeType',
  'fileId', 'txId', 'orderId', 'reconId', 'billReconId', 'clientId', 'accId', 'cardNo',
  'platform', 'currency', 'originAmount', 'fee', 'amount', 'payerName', 'payerAccount',
  'valueDate', 'bookDate', 'created', 'accountReference', 'tradeScope', 'businessDate',
  'tradeSubType', 'realChannel', 'clearingNetwork', 'batchSeq',
]);

const OUTBOUND_FIELDS = Object.freeze([
  'batchNo', 'billDate', 'entity', 'bizType', 'oppBu', 'tradeType', 'orderNo', 'gwOrderNo',
  'billReconId', 'reconId', 'clientId', 'name', 'cardNo', 'originCurrency', 'targetCurrency',
  'originAmount', 'fee', 'originNetAmount', 'targetAmount', 'createTime', 'finishTime',
  'channel', 'merchantId', 'remark', 'tradeScope', 'extInfo', 'bankDebitCurrency',
  'bankDebitAmount', 'businessDate', 'tradeSubType', 'realChannel', 'clearingNetwork', 'batchSeq',
]);

const MPT_SCHEMAS = Object.freeze({
  [SOURCE_TYPE_INBOUND]: Object.freeze({
    sourceType: SOURCE_TYPE_INBOUND,
    batchPrefix: 'MPT_INBOUND_',
    fields: INBOUND_FIELDS,
    decimalFields: Object.freeze(['originAmount', 'fee', 'amount']),
    dateFields: Object.freeze(['billDate', 'valueDate', 'bookDate', 'created', 'businessDate']),
  }),
  [SOURCE_TYPE_OUTBOUND]: Object.freeze({
    sourceType: SOURCE_TYPE_OUTBOUND,
    batchPrefix: 'MPT_OUTBOUND_',
    fields: OUTBOUND_FIELDS,
    decimalFields: Object.freeze([
      'originAmount', 'fee', 'originNetAmount', 'targetAmount', 'bankDebitAmount',
    ]),
    dateFields: Object.freeze(['billDate', 'createTime', 'finishTime', 'businessDate']),
  }),
});

function validationError(code, message, context = {}) {
  const detailLines = [];
  if (context.fileName) detailLines.push(`文件：${context.fileName}`);
  if (context.rowNumber) detailLines.push(`行号：${context.rowNumber}`);
  if (context.fieldName) detailLines.push(`字段：${context.fieldName}`);
  return new FileValidationError(code, message, { context, detailLines });
}

function normalizeText(value) {
  return value === null || value === undefined ? '' : String(value).trim();
}

function isLeapYear(year) {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function isValidDateParts(year, month, day) {
  if (year < 1 || month < 1 || month > 12 || day < 1) return false;
  const days = [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= days[month - 1];
}

function normalizeDate(value) {
  const text = normalizeText(value);
  let match = /^([0-9]{4})([0-9]{2})([0-9]{2})$/.exec(text);
  if (!match) match = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/.exec(text);
  if (!match) return null;
  const year = Number.parseInt(match[1], 10);
  const month = Number.parseInt(match[2], 10);
  const day = Number.parseInt(match[3], 10);
  if (!isValidDateParts(year, month, day)) return null;
  return `${match[1]}-${match[2]}-${match[3]}`;
}

function isValidDateTime(value) {
  const text = normalizeText(value);
  if (text === '') return true;
  const match = /^([0-9]{4})-([0-9]{2})-([0-9]{2})(?:[ T]([0-9]{2}):([0-9]{2}):([0-9]{2})(?:[.]([0-9]+))?(?:Z|([+-])([0-9]{2}):?([0-9]{2}))?)?$/.exec(text);
  if (!match) return false;
  const year = Number.parseInt(match[1], 10);
  const month = Number.parseInt(match[2], 10);
  const day = Number.parseInt(match[3], 10);
  if (!isValidDateParts(year, month, day)) return false;
  if (match[4] === undefined) return true;
  const hour = Number.parseInt(match[4], 10);
  const minute = Number.parseInt(match[5], 10);
  const second = Number.parseInt(match[6], 10);
  if (hour > 23 || minute > 59 || second > 59) return false;
  if (match[9] !== undefined) {
    const offsetHour = Number.parseInt(match[9], 10);
    const offsetMinute = Number.parseInt(match[10], 10);
    if (offsetHour > 23 || offsetMinute > 59) return false;
  }
  return true;
}

// 十进制金额只用字符串处理。返回规范形式，使 1 / 1.0 / 1.00 的指纹完全一致。
function normalizeDecimalString(value) {
  const text = normalizeText(value);
  if (!/^[+-]?(?:[0-9]+(?:[.][0-9]*)?|[.][0-9]+)$/.test(text)) return null;

  let sign = '';
  let unsigned = text;
  if (unsigned[0] === '+' || unsigned[0] === '-') {
    sign = unsigned[0] === '-' ? '-' : '';
    unsigned = unsigned.slice(1);
  }

  let [integerPart, fractionPart = ''] = unsigned.split('.');
  if (integerPart === '') integerPart = '0';
  integerPart = integerPart.replace(/^0+(?=[0-9])/, '');
  fractionPart = fractionPart.replace(/0+$/, '');
  const normalized = fractionPart ? `${integerPart}.${fractionPart}` : integerPart;
  return normalized === '0' ? '0' : `${sign}${normalized}`;
}

function compactDate(isoDate) {
  return isoDate.replace(/-/g, '');
}

function parseMptFileName(filePath) {
  const sourceFileName = path.basename(normalizeText(filePath));
  if (/^MPT_CHANNEL_OTHERS(?:_|[.])/.test(sourceFileName)) {
    throw validationError(
      'MPT_CHANNEL_OTHERS_UNSUPPORTED',
      '当前版本不支持 MPT_CHANNEL_OTHERS 文件类型',
      { fileName: sourceFileName }
    );
  }

  const patterns = [
    { sourceType: SOURCE_TYPE_INBOUND, re: /^MPT_INBOUND_GATEWAY_([0-9]{8})_?([0-9]+)[.](txt|gz)$/ },
    { sourceType: SOURCE_TYPE_OUTBOUND, re: /^MPT_OUTBOUND_GATEWAY_([0-9]{8})_?([0-9]+)[.](txt|gz)$/ },
  ];

  for (const { sourceType, re } of patterns) {
    const match = re.exec(sourceFileName);
    if (!match) continue;
    const sourceDate = normalizeDate(match[1]);
    if (!sourceDate) {
      throw validationError('MPT_FILE_DATE_INVALID', 'MPT 文件名中的账单日期无效', {
        fileName: sourceFileName,
      });
    }
    return {
      sourceType,
      sourceDate,
      fileDateCompact: match[1],
      sourceFileName,
      sourceFileSequence: match[2],
      extension: match[3].toLowerCase(),
      monthKey: sourceDate.slice(0, 7),
    };
  }

  throw validationError(
    'MPT_FILE_NAME_INVALID',
    '仅支持 MPT_INBOUND_GATEWAY / MPT_OUTBOUND_GATEWAY 的 .txt 或 .gz 文件',
    { fileName: sourceFileName }
  );
}

function identifyMptHeader(fields, fileMetadata) {
  const values = fields.map(normalizeText);
  if (values.length !== 3) {
    throw validationError('MPT_HEADER_FIELD_COUNT', 'MPT 首行必须且只能包含日期、批次号和声明明细数', {
      fileName: fileMetadata.sourceFileName,
      rowNumber: 1,
    });
  }

  const schema = MPT_SCHEMAS[fileMetadata.sourceType];
  const batchPattern = fileMetadata.sourceType === SOURCE_TYPE_INBOUND
    ? /^MPT_INBOUND_[0-9]{8}[A-Za-z0-9_-]*$/
    : /^MPT_OUTBOUND_[0-9]{8}[A-Za-z0-9_-]*$/;
  const dateCandidates = [];
  const batchCandidates = [];
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (normalizeDate(value) === fileMetadata.sourceDate) dateCandidates.push(index);
    if (batchPattern.test(value) && value.startsWith(schema.batchPrefix)) {
      const embedded = value.slice(schema.batchPrefix.length, schema.batchPrefix.length + 8);
      if (/^[0-9]{8}$/.test(embedded) && value.length >= schema.batchPrefix.length + 8) {
        batchCandidates.push(index);
      }
    }
  }

  if (dateCandidates.length !== 1 || batchCandidates.length !== 1 || dateCandidates[0] === batchCandidates[0]) {
    throw validationError('MPT_HEADER_IDENTITY_INVALID', 'MPT 首行无法唯一识别与文件名一致的日期和批次号', {
      fileName: fileMetadata.sourceFileName,
      rowNumber: 1,
    });
  }

  const batchIndex = batchCandidates[0];
  const sourceBatch = values[batchIndex];
  const batchDate = sourceBatch.slice(schema.batchPrefix.length, schema.batchPrefix.length + 8);
  if (batchDate !== fileMetadata.fileDateCompact) {
    throw validationError('MPT_HEADER_BATCH_MISMATCH', 'MPT 首行批次号中的账期与文件名不一致', {
      fileName: fileMetadata.sourceFileName,
      rowNumber: 1,
    });
  }

  const countCandidates = values
    .map((value, index) => ({ value, index }))
    .filter(({ index }) => index !== dateCandidates[0] && index !== batchIndex);
  if (countCandidates.length !== 1 || !/^[0-9]+$/.test(countCandidates[0].value)) {
    throw validationError('MPT_HEADER_COUNT_INVALID', 'MPT 首行声明明细数必须为非负整数', {
      fileName: fileMetadata.sourceFileName,
      rowNumber: 1,
    });
  }
  const declaredRowCount = Number.parseInt(countCandidates[0].value, 10);
  if (!Number.isSafeInteger(declaredRowCount)) {
    throw validationError('MPT_HEADER_COUNT_INVALID', 'MPT 首行声明明细数超出安全范围', {
      fileName: fileMetadata.sourceFileName,
      rowNumber: 1,
    });
  }

  return {
    ...fileMetadata,
    sourceBatch,
    declaredRowCount,
  };
}

function rowObjectFromFields(fields, schema) {
  const row = {};
  for (let index = 0; index < schema.fields.length; index += 1) {
    row[schema.fields[index]] = fields[index];
  }
  return row;
}

function assertDecimalFields(rawRow, schema, metadata, sourceRowNumber) {
  for (const fieldName of schema.decimalFields) {
    const value = normalizeText(rawRow[fieldName]);
    if (value !== '' && normalizeDecimalString(value) === null) {
      throw validationError('MPT_DECIMAL_INVALID', 'MPT 金额字段不是合法十进制字符串', {
        fileName: metadata.sourceFileName,
        rowNumber: sourceRowNumber,
        fieldName,
      });
    }
  }
}

function assertDateFields(rawRow, schema, metadata, sourceRowNumber) {
  for (const fieldName of schema.dateFields) {
    const value = normalizeText(rawRow[fieldName]);
    if (value !== '' && !isValidDateTime(value)) {
      throw validationError('MPT_DATE_INVALID', 'MPT 日期或时间字段格式无效', {
        fileName: metadata.sourceFileName,
        rowNumber: sourceRowNumber,
        fieldName,
      });
    }
  }
}

function pickOutboundCurrencyAmount(rawRow, metadata, sourceRowNumber) {
  const candidates = [
    ['bankDebitCurrency', 'bankDebitAmount'],
    ['targetCurrency', 'targetAmount'],
    ['originCurrency', 'originAmount'],
  ];
  for (const [currencyField, amountField] of candidates) {
    const currency = normalizeText(rawRow[currencyField]);
    const amountText = normalizeText(rawRow[amountField]);
    if (currency === '' || amountText === '') continue;
    const amount = normalizeDecimalString(amountText);
    if (amount !== null) return { currency, amount };
  }
  throw validationError('MPT_OUTBOUND_AMOUNT_PAIR_MISSING', 'OUTBOUND 未找到完整的币种/金额对', {
    fileName: metadata.sourceFileName,
    rowNumber: sourceRowNumber,
  });
}

function buildGatewayFingerprint(row) {
  const values = [
    row.date,
    row.channel,
    row.merchantId,
    row.orderId,
    row.billReconId || row.reconBillBizId,
    row.currency,
    normalizeDecimalString(row.amount),
    row.tradeType,
    row.realChannel,
    row.clearingNetwork,
  ].map((value) => normalizeText(value));
  return crypto.createHash('sha256').update(JSON.stringify(values), 'utf8').digest('hex');
}

function normalizeMptRow(fields, metadata, sourceRowNumber) {
  const schema = MPT_SCHEMAS[metadata.sourceType];
  if (!schema) throw new Error(`未知 MPT sourceType：${metadata.sourceType}`);
  if (!Array.isArray(fields) || fields.length !== MPT_EXPECTED_FIELD_COUNT) {
    throw validationError('MPT_ROW_FIELD_COUNT', `MPT 明细行必须为 ${MPT_EXPECTED_FIELD_COUNT} 个字段`, {
      fileName: metadata.sourceFileName,
      rowNumber: sourceRowNumber,
    });
  }

  const rawRow = rowObjectFromFields(fields, schema);
  const rowBatch = normalizeText(rawRow.batchNo);
  if (rowBatch !== metadata.sourceBatch) {
    throw validationError('MPT_ROW_BATCH_MISMATCH', 'MPT 明细行批次号与首行不一致', {
      fileName: metadata.sourceFileName,
      rowNumber: sourceRowNumber,
      fieldName: 'batchNo',
    });
  }

  const rowDate = normalizeDate(rawRow.billDate);
  if (!rowDate || rowDate !== metadata.sourceDate) {
    throw validationError('MPT_ROW_DATE_MISMATCH', 'MPT 明细行账单日期与文件名/首行不一致', {
      fileName: metadata.sourceFileName,
      rowNumber: sourceRowNumber,
      fieldName: 'billDate',
    });
  }

  assertDecimalFields(rawRow, schema, metadata, sourceRowNumber);
  assertDateFields(rawRow, schema, metadata, sourceRowNumber);

  let currency;
  let amount;
  let name;
  let cardNo;
  let orderId;
  if (metadata.sourceType === SOURCE_TYPE_INBOUND) {
    currency = normalizeText(rawRow.currency);
    amount = normalizeDecimalString(rawRow.amount);
    if (currency === '' || amount === null) {
      throw validationError('MPT_INBOUND_AMOUNT_PAIR_MISSING', 'INBOUND 币种和实际金额必须成对存在', {
        fileName: metadata.sourceFileName,
        rowNumber: sourceRowNumber,
      });
    }
    name = normalizeText(rawRow.payerName);
    cardNo = normalizeText(rawRow.payerAccount);
    orderId = normalizeText(rawRow.orderId);
  } else {
    ({ currency, amount } = pickOutboundCurrencyAmount(rawRow, metadata, sourceRowNumber));
    name = normalizeText(rawRow.name);
    cardNo = normalizeText(rawRow.cardNo);
    orderId = normalizeText(rawRow.orderNo);
  }

  const billReconId = normalizeText(rawRow.billReconId);
  const normalized = {
    sourceType: metadata.sourceType,
    sourceBatch: metadata.sourceBatch,
    sourceDate: metadata.sourceDate,
    sourceFileName: metadata.sourceFileName,
    sourceFileSequence: metadata.sourceFileSequence,
    sourceRowNumber,
    reconciliationId: normalizeText(rawRow.reconId),
    date: rowDate,
    channel: normalizeText(rawRow.channel),
    merchantId: normalizeText(rawRow.merchantId),
    orderId,
    billReconId,
    reconBillBizId: billReconId,
    currency,
    amount,
    tradeType: normalizeText(rawRow.tradeType),
    name,
    cardNo,
    realChannel: normalizeText(rawRow.realChannel),
    clearingNetwork: normalizeText(rawRow.clearingNetwork),
    rawJson: JSON.stringify(rawRow),
  };
  normalized.fingerprint = buildGatewayFingerprint(normalized);
  return normalized;
}

function compareFileSequences(left, right) {
  const normalize = (value) => normalizeText(value).replace(/^0+(?=[0-9])/, '');
  const a = normalize(left);
  const b = normalize(right);
  if (!/^[0-9]+$/.test(a) || !/^[0-9]+$/.test(b)) {
    throw new Error('MPT 文件序号必须为数字字符串');
  }
  if (a.length !== b.length) return a.length < b.length ? -1 : 1;
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

module.exports = {
  INBOUND_FIELDS,
  MPT_DELIMITER,
  MPT_EXPECTED_FIELD_COUNT,
  MPT_SCHEMAS,
  OUTBOUND_FIELDS,
  SOURCE_TYPE_INBOUND,
  SOURCE_TYPE_OUTBOUND,
  buildGatewayFingerprint,
  compareFileSequences,
  identifyMptHeader,
  isValidDateTime,
  normalizeDate,
  normalizeDecimalString,
  normalizeMptRow,
  parseMptFileName,
  validationError,
};
