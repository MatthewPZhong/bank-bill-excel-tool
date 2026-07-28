'use strict';

const { BANK_STATEMENT_FIELDS } = require('../../constants/bank-statement-fields');

const MODULE_ID = 'position-reconciliation-process';
const MODULE_NAME = '平盘对账数据处理';
const MODULE_CODE = 'POSITION';
const POSITION_DB_RELATIVE_PATH = 'run-data/position-reconciliation/position-data.sqlite';
const POSITION_RULESET_VERSION = 1;

const AUDIT_HEADERS = Object.freeze(['命中明细', '命中类型', '匹配命中详情']);
const POSITION_BANK_HEADERS = Object.freeze([...AUDIT_HEADERS, ...BANK_STATEMENT_FIELDS]);
const BANK_SHEET_NAME = '渠道对账单';

const SOURCE_TYPES = Object.freeze({
  BANK_ACCOUNT: 'bank-account',
  FUND_TRANSFER: 'fund-transfer',
  TEST_PAYMENT: 'test-payment',
  GATEWAY_INBOUND: 'gateway-inbound',
  GATEWAY_OUTBOUND: 'gateway-outbound'
});

const SOURCE_DISPLAY_ORDER = Object.freeze([
  SOURCE_TYPES.FUND_TRANSFER,
  SOURCE_TYPES.TEST_PAYMENT,
  SOURCE_TYPES.GATEWAY_INBOUND,
  SOURCE_TYPES.GATEWAY_OUTBOUND,
  SOURCE_TYPES.BANK_ACCOUNT
]);

const SOURCE_DEFINITIONS = Object.freeze({
  [SOURCE_TYPES.BANK_ACCOUNT]: Object.freeze({
    sourceName: '清结算银行账户表',
    legacySourceName: '清结算自有账户表',
    linkedName: '清结算银行账户表',
    keyField: null,
    dateField: null,
    headers: Object.freeze([
      '主体', '开户名称', 'PengdingBU', '账户名称', '银行/通道简称', '银行/通道全称',
      '支行简称', '类型', '开户地', '省份', '城市', '币种', '银行账号', '系统账号',
      '关联大账号', '主子账号性质', 'SwiftCode', 'FX属性', '账户性质', 'IBanCode',
      'CodeType', 'CodeNumber', 'BankCode', 'BranchCode', '收款银行地址', '收款人地址',
      '短账号', '基账号', '账户类型', '大额行号', '开户日期', '注销日期', '账户状态',
      '是否参与对账', '备注', '签字人', '操作人', '修改操作人', '创建时间', '最近更新时间'
    ])
  }),
  [SOURCE_TYPES.FUND_TRANSFER]: Object.freeze({
    sourceName: '中台调拨订单表',
    linkedName: '中台调拨平盘对账单',
    keyField: '调拨单号',
    dateField: '交易时间',
    headers: Object.freeze([
      '调拨单号', '调拨状态', '付款方式', '渠道流水号', '交易时间', '付款账户（卡号）',
      '收款账户（卡号）', '付款金额', '付款币种', '收款金额', '收款币种', '清算模式',
      '扣费方式', '中间行', '银行说明', '附言', '换汇渠道', '调拨业务类型', '业务日期',
      '调拨模式', '付款账号', '付款账号性质', '付款渠道', '收款账号', '收款账号性质', '收款渠道'
    ])
  }),
  [SOURCE_TYPES.TEST_PAYMENT]: Object.freeze({
    sourceName: '中台测试付款全量信息表',
    linkedName: '中台测试付款对账单',
    keyField: '付款单号',
    dateField: '创建时间',
    headers: Object.freeze([
      '业务名称', '客户号', '分发单号', '付款单号', '付款状态', '源金额', '源币种',
      '目标金额', '目标币种', '汇率', '付款渠道', '收款卡类型', '收款银行', '收款户名',
      '银行卡号', '代发平台', '贸易类型', '清算号类型', '清算号码', '付款方式', '是否BOC',
      '渠道流水号', '附言', '退票标识', '扣费方式', '中间行', '是否POBO', 'swiftCode',
      '收款地区', '银行流水号', '创建时间', '更新时间'
    ])
  }),
  [SOURCE_TYPES.GATEWAY_INBOUND]: Object.freeze({
    sourceName: '中台网关原始入账订单',
    linkedName: '中台网关入账对账单',
    keyField: 'bizId',
    dateField: 'billDate',
    headers: Object.freeze([
      'bizId', 'batchNo', 'billDate', 'entity', 'business', 'oppBu', 'tradeType', 'reconId',
      'billReconId', 'orderNo', 'channel', 'merchantId', 'currency', 'amount', 'originAmount',
      'fee', 'clientId', 'accId', 'VA', 'fieldId', 'name', 'cardNo', 'tradeSubType',
      'originOutboundNo', 'originOutboundAmount', 'originOutboundCurrency', 'businessDate',
      'realChannel', 'clearingNetwork', 'createTime', 'finishTime', 'created', 'modified',
      'bookDate', 'valueDate', 'accountReference', 'remark', 'measureAmount', 'measureCurrency',
      'exchangeDiff', 'batchSeq'
    ])
  }),
  [SOURCE_TYPES.GATEWAY_OUTBOUND]: Object.freeze({
    sourceName: '中台网关原始出账订单',
    linkedName: '中台网关出账对账单',
    keyField: '业务单号',
    dateField: '账单日期',
    headers: Object.freeze([
      '账单日期', '批次号', '渠道名称', '账户号', '公司主体', '订单创建来源', '业务部门',
      '对手部门', '交易类型', '主对账id', '单据对账id', '业务单号', '币种', '金额',
      '原始币种', '原始金额', '手续费', '原始到账金额', '银行扣款币种', '银行扣款金额',
      '客户编号', '收款人姓名', '收款人卡号', '交易子类型', '退款关联原单号',
      '应结算币种', '应结算金额', '汇兑损益', '业务日期', '真实渠道', '清算网络',
      '对账批次号', '创建时间', '完成时间', '清结算系统创建时间', '清结算系统更新时间'
    ])
  })
});

const LINK_HEADERS = Object.freeze({
  [SOURCE_TYPES.FUND_TRANSFER]: Object.freeze([
    'ReconID', 'MerchantId', 'Currency', 'Amount', 'FundType', '调拨单号', '调拨状态',
    '交易时间', '付款币种', '收款币种', '换汇渠道'
  ]),
  [SOURCE_TYPES.TEST_PAYMENT]: Object.freeze([
    'ReconID', '付款单号', '付款状态', '源金额', '源币种', '目标金额', '目标币种',
    '付款渠道', '创建时间', '银行流水号'
  ]),
  [SOURCE_TYPES.GATEWAY_INBOUND]: Object.freeze([
    'ReconID', 'MerchantId', 'Currency', 'bizId', 'billDate', 'tradeType', 'channel',
    'originOutboundCurrency'
  ]),
  [SOURCE_TYPES.GATEWAY_OUTBOUND]: Object.freeze([
    'ReconID', 'MerchantId', 'Currency', '业务单号', '账单日期', '交易类型', '渠道名称',
    '原始币种', '原始金额', '银行扣款币种'
  ]),
  [SOURCE_TYPES.BANK_ACCOUNT]: SOURCE_DEFINITIONS[SOURCE_TYPES.BANK_ACCOUNT].headers
});

const BANK_STATUSES = Object.freeze({
  UNPROCESSED: '未处理',
  FUND_NATURE_CHECKED: '已校验性质',
  BACKFILLED: '已回填',
  ARCHIVABLE: '可归档'
});

const MATCH_TYPES = Object.freeze({
  PRECISE: '精准命中',
  FUZZY: '模糊命中',
  UNMATCHED: '未命中',
  MANUAL: '需人工判定',
  NOT_APPLICABLE: '不适用',
  USER_MODIFIED: '人工修改'
});

const DIFFERENCE_STATUSES = Object.freeze({
  PENDING: '待确认',
  ACCEPTED: '人工确认保留',
  MODIFIED: '人工修改后确认'
});

const FUND_TYPE_PAIRS = Object.freeze([
  Object.freeze(['Inbound', 'Inbound&FX']),
  Object.freeze(['outbound', 'Outbound&FX']),
  Object.freeze(['FundTransfer-in', 'FundTransfer-in&FX']),
  Object.freeze(['FundTransfer-out', 'FundTransfer-out&FX']),
  Object.freeze(['Ach Return', 'Ach Return&FX']),
  Object.freeze(['Wire Return', 'Wire Return&FX']),
  Object.freeze(['Others', 'Others&FX']),
  Object.freeze(['Revenue Clear', 'Revenue Clear&FX']),
  Object.freeze(['From TREASURY FUND', 'From TREASURY FUND&FX']),
  Object.freeze(['Test', 'Test&FX'])
]);

const VALID_ORDER_STATUSES = Object.freeze(['付款成功', '付款失败', '已提交渠道', '剔除']);

module.exports = {
  MODULE_ID,
  MODULE_NAME,
  MODULE_CODE,
  POSITION_DB_RELATIVE_PATH,
  POSITION_RULESET_VERSION,
  AUDIT_HEADERS,
  POSITION_BANK_HEADERS,
  BANK_SHEET_NAME,
  SOURCE_TYPES,
  SOURCE_DISPLAY_ORDER,
  SOURCE_DEFINITIONS,
  LINK_HEADERS,
  BANK_STATUSES,
  MATCH_TYPES,
  DIFFERENCE_STATUSES,
  FUND_TYPE_PAIRS,
  VALID_ORDER_STATUSES
};
