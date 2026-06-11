// v3.0.4 块 E（需求2）：BOC 链接表派生跨表字段映射「单一真相」（仿 adm-bank-deposit-fields.js）。
//
// 🔴 资金红线（spec §4 F2.2 / R-1）：外汇交割表（中文表头）/ 中台调拨订单（中文）/ 银行对账单（驼峰）
//    三张源表字段名口径不一致，绝不能假设同名。BOC 派生（buildBocFxLink，本批次）与 BOC 引擎（后续）
//    必须全程经本文件常量 pick，禁止手敲字段名。本文件是这批字段名的唯一来源。
//
// 字段名口径对照（务必记牢）：
//   概念        外汇交割表(中文)   中台调拨(中文)   银行对账单(驼峰/中文混)
//   交易/调拨号  交易编号          调拨单号         —
//   金额        货币1金额/货币2金额  收款金额        Credit Amount
//   日期        到期日            交易时间         BillDate
//   渠道        —                付款渠道         Channel
//   地区/币种    —                —              地区 / Currency
//   对账ID      —                —              ReconciliationId
//   交易明细     —                —              Payment Detail（银行单交易编号提取源）

const { FX_DELIVERY_SIGNATURE } = require('./table-signatures');
const { BANK_DEPOSIT_FIELDS } = require('../backend/database/linked-table-repository');

// —— BOC 渠道取值（中台「付款渠道」与银行 Channel 共用同一字面值；精确等于、大小写敏感）——
const BOC_CHANNEL_VALUE = 'BOC';

// —— BOC 银行对账单派生筛选条件（2.4）——
//   地区='CN' ∧ Currency='USD' ∧ Credit Amount 转分=0（精确等于；金额走 toCents 转分比 0）。
const BOC_BANK_FILTER = Object.freeze({
  地区: 'CN',
  Currency: 'USD',
  creditAmountCents: 0
});

// —— Payment Detail 提取关键词（含此词时从中提取最长连续数字串赋「银行单交易编号」，U3 拍板）——
const BOC_PAYMENT_DETAIL_KEYWORD = '无折存款借记交易';

// —— BOC链接表在交割表 34 列之外追加的 3 字段（全进 raw_json）——
//   分组 = 物理行序连续段编号（2.2 剔除后清空）；调拨单号 = 2.3 回填可空；
//   资金对账不平表链接ID = 2.5 回填可空（前端不显示空值，需求 2.5 末句）。
const BOC_LINK_EXTRA_FIELDS = Object.freeze(['分组', '调拨单号', '资金对账不平表链接ID']);

// —— BOC调拨银行对账单表在银行字段之外追加的 1 字段 ——
const BOC_BANK_EXTRA_FIELD = '银行单交易编号';

// —— BOC链接表完整表头 = 交割表 34 列 + 3 新字段（供单测 / 文档参照）——
const BOC_LINK_HEADERS = Object.freeze([
  ...FX_DELIVERY_SIGNATURE.expectedHeaders,
  ...BOC_LINK_EXTRA_FIELDS
]);

// —— 跨表字段映射（显式，含口径差异）——
//   fxXxx = 外汇交割表（中文）；linkXxx = BOC链接表 3 新字段（中文）；
//   midXxx = 中台调拨（中文）；bankXxx = 银行对账单（驼峰/中文）；bankTxnNo = BOC 银行表新字段。
const FIELD_MAP = Object.freeze({
  // 外汇交割表（中文真实表头，第 2 行）
  fxTransactionNo: '交易编号',
  fxCcy1Amount: '货币1金额',
  fxCcy2Amount: '货币2金额',
  fxMaturityDate: '到期日',
  // BOC链接表 3 新字段
  linkGroup: '分组',
  linkAllocationNo: '调拨单号',
  linkReconLinkId: '资金对账不平表链接ID',
  // 中台调拨（中文）
  midAllocationNo: '调拨单号',
  midPayChannel: '付款渠道',
  midReceiveAmount: '收款金额',
  midTransactionTime: '交易时间', // U1 拍板：无「交易日期」列，取「交易时间」日期部分
  // 银行对账单（驼峰 / 中文混）
  bankChannel: 'Channel',
  bankRegion: '地区',
  bankCurrency: 'Currency',
  bankCreditAmount: 'Credit Amount',
  bankReconId: 'ReconciliationId',
  bankBillDate: 'BillDate',
  bankPaymentDetail: 'Payment Detail',
  bankTxnNo: '银行单交易编号'
});

// 模块加载期断言①：交割表表头含 交易编号 / 货币2金额 / 到期日（防 FX_DELIVERY_SIGNATURE 列序漂移致字段名失配）。
//   🔴 这三列是分组 / 金额匹配 / 日期匹配的热列，一旦表头被改名，派生会读不到值 → 分组 / 调拨单号全空。
const __fxHeaders = FX_DELIVERY_SIGNATURE.expectedHeaders || [];
for (const required of [FIELD_MAP.fxTransactionNo, FIELD_MAP.fxCcy2Amount, FIELD_MAP.fxMaturityDate]) {
  if (!__fxHeaders.includes(required)) {
    throw new Error(
      `[boc-fx-link-fields] FX_DELIVERY_SIGNATURE.expectedHeaders 缺少「${required}」— 交割表常量列序疑似漂移，须同步 FIELD_MAP`
    );
  }
}

// 模块加载期断言②：BANK_DEPOSIT_FIELDS 含 'Payment Detail'（防白名单回退漂移 → 银行单交易编号提取断源）。
//   🔴 需求 2.4「银行单交易编号」完全依赖 Payment Detail；若白名单回退到 13 字段，落库 raw_json 不含该字段，
//      buildBocBankRows 将判为 missing-payment-detail 永远无法回填 → 资金对账链接ID 全空。
if (!BANK_DEPOSIT_FIELDS.includes(FIELD_MAP.bankPaymentDetail)) {
  throw new Error(
    `[boc-fx-link-fields] BANK_DEPOSIT_FIELDS 不含「${FIELD_MAP.bankPaymentDetail}」— bank-deposit 白名单疑似回退，银行单交易编号提取将断源`
  );
}

module.exports = {
  BOC_CHANNEL_VALUE,
  BOC_BANK_FILTER,
  BOC_PAYMENT_DETAIL_KEYWORD,
  BOC_LINK_EXTRA_FIELDS,
  BOC_BANK_EXTRA_FIELD,
  BOC_LINK_HEADERS,
  FIELD_MAP
};
