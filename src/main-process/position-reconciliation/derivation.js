'use strict';

const {
  SOURCE_TYPES,
  VALID_ORDER_STATUSES
} = require('./constants');
const { text, normalizeDate, canonicalDecimal } = require('./common');

const VALID_STATUS_SET = new Set(VALID_ORDER_STATUSES);

function mappedAccount(value, accountMapping) {
  const account = text(value);
  return accountMapping.get(account) || account;
}

function deriveFundTransfer(record, accountMapping) {
  const row = record.row;
  const status = text(row['调拨状态']);
  const payCurrency = text(row['付款币种']);
  const receiveCurrency = text(row['收款币种']);
  if (!VALID_STATUS_SET.has(status) || !payCurrency || !receiveCurrency) {
    return [];
  }
  const visible = payCurrency !== receiveCurrency;
  const common = {
    ReconID: text(row['渠道流水号']),
    调拨单号: text(row['调拨单号']),
    调拨状态: status,
    交易时间: normalizeDate(row['交易时间']),
    付款币种: payCurrency,
    收款币种: receiveCurrency,
    换汇渠道: text(row['换汇渠道'])
  };
  return [
    {
      row: {
        ...common,
        MerchantId: mappedAccount(row['付款账户（卡号）'], accountMapping),
        Currency: payCurrency,
        Amount: text(row['付款金额']),
        FundType: 'FundTransfer-out'
      },
      visible
    },
    {
      row: {
        ...common,
        MerchantId: mappedAccount(row['收款账户（卡号）'], accountMapping),
        Currency: receiveCurrency,
        Amount: text(row['收款金额']),
        FundType: 'FundTransfer-in'
      },
      visible
    }
  ];
}

function deriveTestPayment(record) {
  const row = record.row;
  const status = text(row['付款状态']);
  const sourceAmount = canonicalDecimal(row['源金额']);
  const sourceCurrency = text(row['源币种']);
  const targetCurrency = text(row['目标币种']);
  if (!VALID_STATUS_SET.has(status) || !sourceAmount || !sourceCurrency || !targetCurrency) {
    return [];
  }
  if (sourceAmount.units === 0n) return [];
  return [{
    row: {
      ReconID: text(row['渠道流水号']),
      付款单号: text(row['付款单号']),
      付款状态: status,
      源金额: text(row['源金额']),
      源币种: sourceCurrency,
      目标金额: text(row['目标金额']),
      目标币种: targetCurrency,
      付款渠道: text(row['付款渠道']),
      创建时间: normalizeDate(row['创建时间']),
      银行流水号: text(row['银行流水号'])
    },
    visible: sourceCurrency !== targetCurrency
  }];
}

function deriveGatewayInbound(record) {
  const row = record.row;
  const tradeType = text(row.tradeType);
  const currency = text(row.currency);
  const originOutboundCurrency = text(row.originOutboundCurrency);
  if ((tradeType !== 'Inbound-VA' && tradeType !== 'WireReturn') || !currency) {
    return [];
  }
  return [{
    row: {
      ReconID: text(row.reconId),
      MerchantId: text(row.merchantId),
      Currency: currency,
      bizId: text(row.bizId),
      billDate: normalizeDate(row.billDate),
      tradeType,
      channel: text(row.channel),
      originOutboundCurrency
    },
    visible: Boolean(originOutboundCurrency && currency !== originOutboundCurrency)
  }];
}

function deriveGatewayOutbound(record) {
  const row = record.row;
  return [{
    row: {
      ReconID: text(row['主对账id']),
      MerchantId: text(row['账户号']),
      Currency: text(row['币种']),
      业务单号: text(row['业务单号']),
      账单日期: normalizeDate(row['账单日期']),
      交易类型: text(row['交易类型']),
      渠道名称: text(row['渠道名称']),
      原始币种: text(row['原始币种']),
      原始金额: text(row['原始金额']),
      银行扣款币种: text(row['银行扣款币种'])
    },
    visible: true
  }];
}

function deriveBankAccount(record) {
  if (text(record.row['账户状态']) !== '正常') return [];
  return [{ row: { ...record.row }, visible: true }];
}

function accountMappingFrom(mappings) {
  return new Map(
    (Array.isArray(mappings) ? mappings : []).map((mapping) => [
      text(mapping.midAccountId),
      text(mapping.clearingAccountId)
    ]).filter(([left, right]) => left && right)
  );
}

function deriveLinkedRowsForRecord(sourceType, record, mappings = []) {
  const accountMapping = mappings instanceof Map
    ? mappings
    : accountMappingFrom(mappings);
  let rows;
  if (sourceType === SOURCE_TYPES.FUND_TRANSFER) {
    rows = deriveFundTransfer(record, accountMapping);
  } else if (sourceType === SOURCE_TYPES.TEST_PAYMENT) {
    rows = deriveTestPayment(record);
  } else if (sourceType === SOURCE_TYPES.GATEWAY_INBOUND) {
    rows = deriveGatewayInbound(record);
  } else if (sourceType === SOURCE_TYPES.GATEWAY_OUTBOUND) {
    rows = deriveGatewayOutbound(record);
  } else if (sourceType === SOURCE_TYPES.BANK_ACCOUNT) {
    rows = deriveBankAccount(record);
  } else {
    rows = [];
  }
  return rows.map((item, legIndex) => ({
    sourceType,
    businessKey: record.businessKey,
    sourceRecordKey: record.sourceRecordKey || record.row_hash || record.rowHash || '',
    sourceRowId: record.sourceRowId || record.id || null,
    sourceRowNumber: record.sourceRowNumber,
    legIndex,
    visible: item.visible !== false,
    row: item.row
  }));
}

function deriveLinkedRows(sourceType, records, mappings = []) {
  const accountMapping = new Map(
    (Array.isArray(mappings) ? mappings : []).map((mapping) => [
      text(mapping.midAccountId),
      text(mapping.clearingAccountId)
    ]).filter(([left, right]) => left && right)
  );
  const derived = [];
  for (const record of Array.isArray(records) ? records : []) {
    deriveLinkedRowsForRecord(sourceType, record, accountMapping).forEach((item) => {
      derived.push({
        ...item,
        ordinal: derived.length
      });
    });
  }
  return derived;
}

module.exports = {
  deriveLinkedRows,
  deriveLinkedRowsForRecord,
  deriveFundTransfer,
  deriveTestPayment,
  deriveGatewayInbound,
  deriveGatewayOutbound,
  deriveBankAccount
};
