'use strict';

const { trimCell } = require('./bank-row');

const BANK_SOURCE = '导入银行对账单';

const UNBALANCED_HEADERS = Object.freeze([
  '对账数据来源',
  '账单日期',
  '支付渠道',
  '业务类型',
  '交易类型',
  '对账结果',
  'reconId',
  '业务订单号',
  '业务订单金额',
  '业务方币种',
  '渠道账号',
  '渠道订单号',
  '渠道订单金额',
  '渠道币种',
  '业务订单交易完成时间',
  '渠道订单交易完成时间',
  '差错类型',
  '备注',
  '业务方原始账单ID',
  '渠道方原始账单ID'
]);

const BALANCED_HEADERS = Object.freeze([
  '网关-数据来源',
  '网关-BillDate',
  '网关-Channel',
  '网关-MerchantId',
  '网关-OrderId',
  '网关-ReconBillBizId',
  '网关-reconciliationId',
  '网关-Currency',
  '网关-Amount',
  '网关-TradeType',
  '网关-name',
  '网关-cardNo',
  '网关-真实渠道',
  '网关-清算网络',
  '对账结果',
  '银行-数据来源',
  '银行-BillDate',
  '银行-ValueDate',
  '银行-Channel',
  '银行-地区',
  '银行-MerchantId',
  '银行-ReconciliationId',
  '银行-ChannelOrderNo',
  '银行-name',
  '银行-cardNo',
  '银行-Currency',
  '银行-Credit Amount',
  '银行-Debit Amount',
  '银行-FundType',
  '银行-清算网络',
  '银行-OriginBillId'
]);

const CHANNEL_BILL_HEADERS = Object.freeze([
  'channelName',
  'merchantId',
  'reconciliationId',
  'channelOrderNo',
  'name',
  'cardNo',
  'currency',
  'requestAmount',
  'receiveAmount',
  'extraFee',
  '清算网络',
  'createTime',
  'finishTime',
  'additionInfo',
  'remark',
  'COriginalId'
]);

const DUPLICATE_GATEWAY_HEADERS = Object.freeze([
  '折叠记录ID',
  '对象类型',
  '分片序号',
  '分片总数',
  '折叠原因',
  '重复指纹',
  '数据来源',
  '数据位置',
  'BillDate',
  'Channel',
  'MerchantId',
  'OrderId',
  'ReconBillBizId',
  'reconciliationId',
  'Currency',
  'Amount',
  'TradeType',
  'name',
  'cardNo',
  '真实渠道',
  '清算网络',
  '原始数据JSON分片'
]);

const DUPLICATE_RAW_JSON_CHUNK_SIZE = 30000;
const DUPLICATE_FOLD_REASON = 'reconciliationId+10字段指纹完全重复';

function rawBankRow(derived) {
  if (!derived || typeof derived !== 'object') return {};
  return derived.rawRow && typeof derived.rawRow === 'object' ? derived.rawRow : derived;
}

function bankValue(derived, field) {
  const row = rawBankRow(derived);
  const value = row[field];
  return value === null || value === undefined ? '' : value;
}

function gatewayFields(candidate) {
  return candidate && candidate.fields && typeof candidate.fields === 'object'
    ? candidate.fields
    : {};
}

function projectOutputRow(headers, row) {
  if (Array.isArray(row)) {
    if (row.length !== headers.length) {
      throw new Error(`输出行列数错误：应为${headers.length}列，实际${row.length}列`);
    }
    return row.slice();
  }
  return headers.map((header) => {
    const value = row && row[header];
    return value === null || value === undefined ? '' : value;
  });
}

function splitUtf16Safe(value, maxLength = DUPLICATE_RAW_JSON_CHUNK_SIZE) {
  const text = value === null || value === undefined ? '' : String(value);
  if (!Number.isSafeInteger(maxLength) || maxLength < 2) {
    throw new TypeError('原始JSON分片长度必须为不小于2的正整数');
  }
  if (text.length === 0) return [''];
  const chunks = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + maxLength, text.length);
    if (end < text.length) {
      const left = text.charCodeAt(end - 1);
      const right = text.charCodeAt(end);
      if (left >= 0xD800 && left <= 0xDBFF && right >= 0xDC00 && right <= 0xDFFF) {
        end -= 1;
      }
    }
    chunks.push(text.slice(start, end));
    start = end;
  }
  return chunks;
}

function formatDuplicateDataPosition(candidate) {
  const location = candidate && candidate.location && typeof candidate.location === 'object'
    ? candidate.location
    : {};
  const source = trimCell(candidate && candidate.source);
  const fileName = trimCell(location.sourceFileName);
  const rowNumber = location.sourceRowNumber ?? location.sourceIndex;
  if (fileName) return `文件「${fileName}」第${rowNumber ?? '未知'}行`;
  if (source === '网关对账单') return `linked_gateway_bill#${rowNumber ?? '未知'}`;
  return `${source || '网关账单'}#${rowNumber ?? '未知'}`;
}

function mapDuplicateAuditRow(record, chunk, chunkIndex, chunkCount) {
  if (!record || !record.candidate) {
    throw new TypeError('重复网关账单映射需要折叠记录及候选快照');
  }
  const candidate = record.candidate;
  const fields = gatewayFields(candidate);
  return {
    '折叠记录ID': record.foldRecordId || '',
    '对象类型': record.objectType || '',
    '分片序号': chunkIndex + 1,
    '分片总数': chunkCount,
    '折叠原因': record.foldReason || DUPLICATE_FOLD_REASON,
    '重复指纹': candidate.fingerprint || '',
    '数据来源': candidate.source || '',
    '数据位置': formatDuplicateDataPosition(candidate),
    BillDate: fields.date || '',
    Channel: fields.channel || '',
    MerchantId: fields.merchantId || '',
    OrderId: fields.orderId || '',
    ReconBillBizId: fields.billReconId || '',
    reconciliationId: candidate.reconciliationId || '',
    Currency: fields.currency || '',
    Amount: fields.amount || '',
    TradeType: fields.tradeType || '',
    name: candidate.name || '',
    cardNo: candidate.cardNo || '',
    '真实渠道': fields.realChannel || '',
    '清算网络': fields.clearingNetwork || '',
    '原始数据JSON分片': chunk
  };
}

function* iterateDuplicateAuditRows(records) {
  for (const record of records || []) {
    if (!record || !record.candidate || typeof record.candidate.rawJson !== 'string') {
      throw new Error('前置资金对账重复审计原始JSON缺失或结构无效');
    }
    const chunks = splitUtf16Safe(record.candidate.rawJson);
    for (let index = 0; index < chunks.length; index += 1) {
      yield mapDuplicateAuditRow(record, chunks[index], index, chunks.length);
    }
  }
}

function* iterateDuplicateGroupRecords(groups, channel) {
  const ordered = [...(groups || [])]
    .filter((group) => trimCell(group && group.channel) === channel)
    .sort((left, right) => (
      (Number(left.firstEventOrder) || 0) - (Number(right.firstEventOrder) || 0)
      || String(left.foldRecordId || '').localeCompare(String(right.foldRecordId || ''))
    ));
  for (const group of ordered) {
    yield {
      foldRecordId: group.foldRecordId,
      objectType: '保留记录',
      foldReason: DUPLICATE_FOLD_REASON,
      candidate: group.keptCandidate
    };
    for (const candidate of group.foldedCandidates || []) {
      yield {
        foldRecordId: group.foldRecordId,
        objectType: '被折叠记录',
        foldReason: DUPLICATE_FOLD_REASON,
        candidate
      };
    }
  }
}

function mapUnbalancedRow(bankRow, options = {}) {
  if (!bankRow || typeof bankRow !== 'object') {
    throw new TypeError('不平结果映射需要派生后的银行行对象');
  }
  return {
    '对账数据来源': BANK_SOURCE,
    '账单日期': bankValue(bankRow, 'ValueDate'),
    '支付渠道': bankValue(bankRow, 'Channel'),
    '业务类型': 'null',
    '交易类型': bankRow.transactionType || '',
    '对账结果': '不平账',
    reconId: bankRow.reconciliationId || trimCell(bankValue(bankRow, 'ReconciliationId')),
    '业务订单号': '',
    '业务订单金额': '0.000000000000',
    '业务方币种': '',
    '渠道账号': bankValue(bankRow, 'MerchantId'),
    '渠道订单号': bankValue(bankRow, 'ChannelOrderNo'),
    '渠道订单金额': bankRow.amount || '',
    '渠道币种': bankValue(bankRow, 'Currency'),
    '业务订单交易完成时间': '',
    '渠道订单交易完成时间': bankValue(bankRow, 'ValueDate'),
    '差错类型': '右单边账',
    '备注': trimCell(options.reason || bankRow.unbalancedReason),
    '业务方原始账单ID': '',
    '渠道方原始账单ID': bankRow.originBillId || ''
  };
}

function mapBalancedRow(pair) {
  if (!pair || !pair.bankRow || !pair.gatewayRow) {
    throw new TypeError('平账结果映射需要 { bankRow, gatewayRow } 配对对象');
  }
  const bankRow = pair.bankRow;
  const gatewayRow = pair.gatewayRow;
  const fields = gatewayFields(gatewayRow);
  return {
    '网关-数据来源': gatewayRow.source || '',
    '网关-BillDate': fields.date || '',
    '网关-Channel': fields.channel || '',
    '网关-MerchantId': fields.merchantId || '',
    '网关-OrderId': fields.orderId || '',
    '网关-ReconBillBizId': fields.billReconId || '',
    '网关-reconciliationId': gatewayRow.reconciliationId || '',
    '网关-Currency': fields.currency || '',
    '网关-Amount': fields.amount || '',
    '网关-TradeType': fields.tradeType || '',
    '网关-name': gatewayRow.name || '',
    '网关-cardNo': gatewayRow.cardNo || '',
    '网关-真实渠道': fields.realChannel || '',
    '网关-清算网络': fields.clearingNetwork || '',
    '对账结果': '平账',
    '银行-数据来源': BANK_SOURCE,
    '银行-BillDate': bankValue(bankRow, 'BillDate'),
    '银行-ValueDate': bankValue(bankRow, 'ValueDate'),
    '银行-Channel': bankValue(bankRow, 'Channel'),
    '银行-地区': bankValue(bankRow, '地区'),
    '银行-MerchantId': bankValue(bankRow, 'MerchantId'),
    '银行-ReconciliationId': bankRow.reconciliationId || trimCell(bankValue(bankRow, 'ReconciliationId')),
    '银行-ChannelOrderNo': bankValue(bankRow, 'ChannelOrderNo'),
    '银行-name': bankRow.name || '',
    '银行-cardNo': bankRow.cardNo || '',
    '银行-Currency': bankValue(bankRow, 'Currency'),
    '银行-Credit Amount': bankValue(bankRow, 'Credit Amount'),
    '银行-Debit Amount': bankValue(bankRow, 'Debit Amount'),
    '银行-FundType': bankValue(bankRow, 'FundType'),
    '银行-清算网络': bankValue(bankRow, '清算网络'),
    '银行-OriginBillId': bankRow.originBillId || ''
  };
}

function mapChannelBillRow(bankRow) {
  if (!bankRow || typeof bankRow !== 'object') {
    throw new TypeError('渠道账单映射需要派生后的银行行对象');
  }
  return {
    channelName: bankValue(bankRow, 'Channel'),
    merchantId: bankValue(bankRow, 'MerchantId'),
    reconciliationId: bankRow.reconciliationId || trimCell(bankValue(bankRow, 'ReconciliationId')),
    channelOrderNo: bankValue(bankRow, 'ChannelOrderNo'),
    name: bankRow.name || '',
    cardNo: bankRow.cardNo || '',
    currency: bankValue(bankRow, 'Currency'),
    requestAmount: '',
    receiveAmount: bankRow.amount || '',
    extraFee: bankValue(bankRow, 'Extra Fee'),
    '清算网络': bankValue(bankRow, '清算网络'),
    createTime: bankValue(bankRow, 'BillDate'),
    finishTime: bankValue(bankRow, 'ValueDate'),
    additionInfo: bankValue(bankRow, 'Extra Information'),
    remark: bankValue(bankRow, 'Remark-description'),
    COriginalId: bankRow.originBillId || ''
  };
}

function* iterateBalancedRows(pairs) {
  for (const pair of pairs || []) yield mapBalancedRow(pair);
}

function* iterateUnbalancedRows(bankRows) {
  for (const bankRow of bankRows || []) yield mapUnbalancedRow(bankRow);
}

function* iterateChannelBillRows(bankRows) {
  for (const bankRow of bankRows || []) yield mapChannelBillRow(bankRow);
}

function assertOutputConservation(result) {
  if (!result || !result.stats) throw new TypeError('输出守恒校验需要对账结果 stats');
  const stats = result.stats;
  const balancedCount = Array.isArray(result.balancedPairs)
    ? result.balancedPairs.length
    : stats.bankMatchedRows;
  const unbalancedCount = Array.isArray(result.unbalancedBankRows)
    ? result.unbalancedBankRows.length
    : stats.bankMissingGatewayRows;

  const failures = [];
  if (balancedCount !== stats.bankMatchedRows) {
    failures.push(`平账集合${balancedCount}行≠统计${stats.bankMatchedRows}行`);
  }
  if (unbalancedCount !== stats.bankMissingGatewayRows) {
    failures.push(`不平集合${unbalancedCount}行≠统计${stats.bankMissingGatewayRows}行`);
  }
  if (stats.bankParticipatingRows !== balancedCount + unbalancedCount) {
    failures.push(`参与${stats.bankParticipatingRows}行≠平账${balancedCount}行+不平${unbalancedCount}行`);
  }
  if (failures.length > 0) {
    throw new Error(`前置资金对账输出行数不守恒：${failures.join('；')}`);
  }

  return {
    participatingBankRows: stats.bankParticipatingRows,
    balancedResultRows: balancedCount,
    unbalancedResultRows: unbalancedCount,
    channelBillRows: unbalancedCount
  };
}

function bankChannel(derived) {
  return derived && Object.prototype.hasOwnProperty.call(derived, 'channel')
    ? trimCell(derived.channel)
    : trimCell(bankValue(derived, 'Channel'));
}

function listResultChannels(result) {
  const channels = [];
  const seen = new Set();
  const append = (bankRow) => {
    const channel = bankChannel(bankRow);
    if (!seen.has(channel)) {
      seen.add(channel);
      channels.push(channel);
    }
  };
  const bankEvents = [];
  for (const pair of result.balancedPairs || []) bankEvents.push(pair.bankRow);
  for (const bankRow of result.unbalancedBankRows || []) bankEvents.push(bankRow);
  bankEvents.sort((left, right) => (
    (Number(left && left.inputIndex) || 0) - (Number(right && right.inputIndex) || 0)
  ));
  for (const bankRow of bankEvents) append(bankRow);
  const duplicateGroups = [...(result.duplicateGroups || [])].sort((left, right) => (
    (Number(left.firstEventOrder) || 0) - (Number(right.firstEventOrder) || 0)
  ));
  for (const group of duplicateGroups) {
    const channel = trimCell(group && group.channel);
    if (!seen.has(channel)) {
      seen.add(channel);
      channels.push(channel);
    }
  }
  return channels;
}

/**
 * 小数据/单测便利适配器。每个渠道暴露 generator，不复制任何全量结果数组。
 * 大数据生产链可直接从 side DB 为 writer 提供同形状的逐渠道 iterable。
 */
function* iterateChannelExports(result) {
  assertOutputConservation(result);
  for (const channel of listResultChannels(result)) {
    const hasDuplicateRecords = (result.duplicateGroups || [])
      .some((group) => trimCell(group && group.channel) === channel);
    yield {
      channel,
      hasDuplicateRecords,
      balancedRows: (function* balanced() {
        for (const pair of result.balancedPairs || []) {
          if (bankChannel(pair.bankRow) === channel) yield mapBalancedRow(pair);
        }
      }()),
      unbalancedRows: (function* unbalanced() {
        for (const bankRow of result.unbalancedBankRows || []) {
          if (bankChannel(bankRow) === channel) yield mapUnbalancedRow(bankRow);
        }
      }()),
      channelBillRows: (function* channelBills() {
        for (const bankRow of result.unbalancedBankRows || []) {
          if (bankChannel(bankRow) === channel) yield mapChannelBillRow(bankRow);
        }
      }()),
      duplicateRows: hasDuplicateRecords
        ? iterateDuplicateAuditRows(iterateDuplicateGroupRecords(result.duplicateGroups, channel))
        : []
    };
  }
}

module.exports = {
  BANK_SOURCE,
  UNBALANCED_HEADERS,
  BALANCED_HEADERS,
  CHANNEL_BILL_HEADERS,
  DUPLICATE_GATEWAY_HEADERS,
  DUPLICATE_RAW_JSON_CHUNK_SIZE,
  DUPLICATE_FOLD_REASON,
  projectOutputRow,
  splitUtf16Safe,
  formatDuplicateDataPosition,
  mapDuplicateAuditRow,
  iterateDuplicateAuditRows,
  mapUnbalancedRow,
  mapBalancedRow,
  mapChannelBillRow,
  iterateBalancedRows,
  iterateUnbalancedRows,
  iterateChannelBillRows,
  assertOutputConservation,
  listResultChannels,
  iterateChannelExports
};
