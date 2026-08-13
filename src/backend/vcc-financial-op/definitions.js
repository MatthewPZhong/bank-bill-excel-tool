'use strict';

const SOURCE_TYPES = Object.freeze({
  RECHARGE: 'recharge_refund',
  FEE_FX: 'fee_fx',
  CHANNEL: 'channel',
  PENDING: 'pending_archive_removal',
  SYSTEM_OP: 'system_op'
});

const SOURCE_LABELS = Object.freeze({
  [SOURCE_TYPES.RECHARGE]: 'VCC充值清退明细',
  [SOURCE_TYPES.FEE_FX]: 'VCC费用及换汇明细',
  [SOURCE_TYPES.CHANNEL]: 'VCC通道明细',
  [SOURCE_TYPES.PENDING]: 'VCC_移除归档Pending账单',
  [SOURCE_TYPES.SYSTEM_OP]: '系统财务OP'
});

const SUPPORTED_CURRENCIES = Object.freeze([
  'AUD', 'CAD', 'CNY', 'EUR', 'GBP', 'HKD', 'JPY', 'SGD', 'USD'
]);

// 仅供读取历史派生事实；新导入仍按 SUPPORTED_CURRENCIES 严格拒绝 CNH。
function normalizeLegacyStoredCurrency(value) {
  if (value === null || value === undefined) return value;
  const currency = String(value).trim();
  return currency === 'CNH' ? 'CNY' : currency;
}

const RECHARGE_HEADERS = Object.freeze([
  '穿透节点ID', '对账单ID', 'BillDate', '业务部门', '对手部门', '订单号', '流水对账id',
  '单据对账id', '单据类型', '客户编号', '场景', '账户号', '大账号', '业务子类型', '出入方向',
  '平台', '公司主体', '我方币种', '我方金额', '授信金额', '非授信金额', '账户类型',
  '账户借贷记标识', '手续费', 'extrafee', 'fee', 'fee1', 'finalFee', 'flowMoreFee',
  'fullRcvFee', 'pobofee', 'servicefee', 'splitExtraFeeAmount', 'splitFlowMoreFeeAmount',
  'splitFullRcvFeeAmount', 'splitPoboFeeAmount', 'splitServiceFeeAmount', 'splitWithdrawFee',
  '优惠券', 'bonus', '我方到账金额', '对方币种', '对方金额', '汇率', 'createTime', 'finishTime',
  '备注', '销账类型', '销账说明'
]);

const FEE_FX_HEADERS = Object.freeze([
  '穿透节点ID', '对账单ID', 'BillDate', '业务部门', '对手部门', '订单号', '流水对账id',
  '单据对账id', '单据类型', '客户编号', '场景', '账户号', '大账号', '业务子类型', '出入方向',
  '平台', '公司主体', '我方币种', '我方金额', '手续费', '优惠券', 'bonus', '我方到账金额',
  '授信金额', '非授信金额', '账户类型', '账户借贷记标识', '对方币种', '对方金额', '汇率',
  'createTime', 'finishTime', 'fee', '备注', '销账类型', '销账说明'
]);

const CHANNEL_HEADERS = Object.freeze([
  '账单日期', '部门', '通道名称', 'MID', '类型', '批次号', '结算批次号', '主对账id',
  '渠道订单号', '交易类型', '交易汇总金额', '交易金额', '交易币种', '清算金额', '清算手续费',
  '清算币种', '清算净金额', '汇率', '客户姓名', '客户卡号', '对账单解析时间', '交易完成时间',
  '原始对账ID', '备注', '数据来源', '是否参与本地对账', '系统创建时间', '系统更新时间',
  '防重号', '借贷方向', '客户编号', '场景', '账户编号', 'billdate', '结算币种', '实际到账金额',
  '结算金额', '渠道手续费'
]);

const PENDING_RAW_CONTRACT_V1 = 1;
const PENDING_RAW_CONTRACT_V2 = 2;

// v3.1.8 新导入唯一契约：用户确认的 46 列 Pending 原表。
const PENDING_HEADERS = Object.freeze([
  'pending类型', 'pending资金类型', '账单类型', 'billDate', 'valueDate', '平账账期', '业务BU',
  '对手业务BU', '财务BU', '主体', '对账类型', 'recon_id', '金额', '币种', 'order_no', 'acc_id',
  'finish_time', '穿透ID', 'channel', 'merchant_id', 'bank_ref', '对账明细ID', '对账单ID',
  'PendingBizId', '备注', '计算金额', '计算币种', '是否拆分Pending', '流水_账单日期', '流水_公司主体',
  '流水_流水类型', '流水_业务部门', '流水_主对账ID', '流水_出入方向', '流水_流水单号',
  '流水_用户编号', '流水_账户编号', '流水_币种', '流水_对账金额',
  '流水_账户类型', '授信金额', '非授信金额', '维护人', '维护人BU', '客户所在地', '是否已流水替换'
]);

// 历史 v1 只用于旧审计反序列化和幂等迁移，不参与新文件识别。
const PENDING_V1_HEADERS = Object.freeze([
  ...PENDING_HEADERS.slice(0, 37),
  '是否错币',
  '金额差',
  ...PENDING_HEADERS.slice(37)
]);

const SYSTEM_OP_HEADERS = Object.freeze([
  '账单日期', '主体', '业务部门', '币种', 'OP发生额', '发生额（入）', '发生额（出）',
  '本期移除Pending金额', '调账金额', 'OP期末余额', 'pending余额', '费用项', '财务余额',
  '主体变动发生额', '财务主体余额', '创建时间'
]);

function buildDefinition(sourceType, headers, fields) {
  const indexes = Object.freeze(Object.fromEntries(headers.map((header, index) => [header, index])));
  return Object.freeze({ sourceType, headers, indexes, ...fields });
}

const SOURCE_DEFINITIONS = Object.freeze({
  [SOURCE_TYPES.RECHARGE]: buildDefinition(SOURCE_TYPES.RECHARGE, RECHARGE_HEADERS, {
    keyHeader: '订单号', monthHeader: 'BillDate', subjectHeader: '公司主体'
  }),
  [SOURCE_TYPES.FEE_FX]: buildDefinition(SOURCE_TYPES.FEE_FX, FEE_FX_HEADERS, {
    keyHeader: '订单号', monthHeader: 'BillDate', subjectHeader: '公司主体'
  }),
  [SOURCE_TYPES.CHANNEL]: buildDefinition(SOURCE_TYPES.CHANNEL, CHANNEL_HEADERS, {
    keyHeader: '渠道订单号', monthHeader: '账单日期', subjectHeader: null, requiresFileSubject: true
  }),
  [SOURCE_TYPES.PENDING]: buildDefinition(SOURCE_TYPES.PENDING, PENDING_HEADERS, {
    keyHeader: 'PendingBizId', monthHeader: '平账账期', subjectHeader: '主体'
  })
});

const SYSTEM_OP_DEFINITION = buildDefinition(SOURCE_TYPES.SYSTEM_OP, SYSTEM_OP_HEADERS, {
  monthHeader: '账单日期',
  subjectHeader: '主体',
  departmentHeader: '业务部门',
  currencyHeader: '币种',
  balanceHeader: '财务余额'
});

function normalizeHeader(value) {
  return String(value == null ? '' : value).trim();
}

function normalizeHeaderRow(values) {
  const normalized = (Array.isArray(values) ? values : []).map(normalizeHeader);
  while (normalized.length > 0 && normalized[normalized.length - 1] === '') normalized.pop();
  return normalized;
}

function headersEqual(actual, expected) {
  const normalized = normalizeHeaderRow(actual);
  return normalized.length === expected.length
    && expected.every((header, index) => normalized[index] === header);
}

function detectDetailSourceType(headers) {
  for (const definition of Object.values(SOURCE_DEFINITIONS)) {
    if (headersEqual(headers, definition.headers)) return definition.sourceType;
  }
  return null;
}

function isLegacyPendingHeaders(headers) {
  return headersEqual(headers, PENDING_V1_HEADERS);
}

function getRawContractHeaders(sourceType, rawContractVersion) {
  if (sourceType !== SOURCE_TYPES.PENDING) {
    const definition = getSourceDefinition(sourceType);
    return definition ? definition.headers : null;
  }
  const version = Number(rawContractVersion) || PENDING_RAW_CONTRACT_V1;
  if (version === PENDING_RAW_CONTRACT_V1) return PENDING_V1_HEADERS;
  if (version === PENDING_RAW_CONTRACT_V2) return PENDING_HEADERS;
  return null;
}

function isSystemOpHeaders(headers) {
  return headersEqual(headers, SYSTEM_OP_HEADERS);
}

function getSourceDefinition(sourceType) {
  return SOURCE_DEFINITIONS[sourceType] || null;
}

module.exports = {
  SOURCE_TYPES,
  SOURCE_LABELS,
  SUPPORTED_CURRENCIES,
  normalizeLegacyStoredCurrency,
  RECHARGE_HEADERS,
  FEE_FX_HEADERS,
  CHANNEL_HEADERS,
  PENDING_HEADERS,
  PENDING_V1_HEADERS,
  PENDING_RAW_CONTRACT_V1,
  PENDING_RAW_CONTRACT_V2,
  SYSTEM_OP_HEADERS,
  SOURCE_DEFINITIONS,
  SYSTEM_OP_DEFINITION,
  normalizeHeader,
  normalizeHeaderRow,
  headersEqual,
  detectDetailSourceType,
  isLegacyPendingHeaders,
  getRawContractHeaders,
  isSystemOpHeaders,
  getSourceDefinition
};
