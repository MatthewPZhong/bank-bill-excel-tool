// v2.1.16-beta.5 需求3 / 需求5：ADM 银行对账单链接表 + JPM 调拨订单修复引擎 跨表字段映射「单一真相」。
//
// 🔴 资金红线（TECH §七 / R-1 / R-3）：渠道账单 / 网关账单 / ADM 表 / 中台调拨四张表字段名大小写不一致，
//    绝不能假设同名。ADM 派生（buildAdmRows，PR-2）与 JPM 引擎（jpm-dispatch-order-fix，PR-3）
//    必须全程经本文件常量 pick，禁止手敲字段名。本文件是这批字段名的唯一来源。
//
// 字段名大小写对照（务必记牢）：
//   概念       渠道账单(小写m)   网关账单(驼峰M)   ADM/银行(驼峰)   中台调拨(中文)
//   商户号     merchantId       MerchantId       MerchantId       —
//   对账ID     reconciliationId reconciliationId 资金对账ID       —
//   金额       receiveAmount    Amount           Fundtransfer-in金额  收款金额
//   附加信息   additionInfo     —                —                —
//   订单/调拨号 —               OrderId          调拨号           调拨单号
//   引用       —                Reference        —                —
//   类型       —                GATEWAY_BILL_FIELDS[8] —          —
//   客户参考   —                —                CustomerRef      渠道流水号

const { GATEWAY_BILL_FIELDS } = require('./gateway-bill-recon-fields');

// —— 需求3 ADM 派生筛选条件 ——
// Channel 列精确等于 'ADM'（大小写敏感）。
const CHANNEL_VALUE = 'ADM';

// FundType 白名单（精确等于、大小写敏感、含 '&FX' 后缀）。
//   ⚠️ 实现/手测期须核对 assets/FundType枚举值.xlsx byte-for-byte 一致（大小写 / 连字符 / &FX），防枚举漂移漏筛误筛。
const ADM_FUND_TYPES = Object.freeze(['Fundtransfer-out', 'Fundtransfer-out&FX']);

// —— ADM 行 6 新增字段名（在 13 银行字段之外追加；全部进 raw_json）——
//   批次号 = <规范化BillDate>-<ChannelOrderNo>；调拨号/Fundtransfer-in金额 = 中台匹配命中回填；
//   资金对账ID / 两个匹配标志 = JPM 引擎 run 阶段回写（派生阶段：调拨号/金额/资金对账ID 空，标志 0）。
const ADM_EXTRA_FIELDS = Object.freeze([
  '批次号',
  '调拨号',
  'Fundtransfer-in金额',
  '资金对账ID',
  '是否与渠道账单匹配',
  '是否与网关账单匹配'
]);

// —— JPM 默认商户号 ——
//   也存 scenario.config.merchantId（引擎从 config 读，不散落）；本常量供派生/单测/兜底引用（R-10）。
const ADM_MERCHANT_ID = '6300156616';

// —— 跨表字段映射（显式，含大小写差异）——
//   admXxx = 银行/ADM 表（驼峰）；midXxx = 中台调拨（中文）；
//   chXxx = 渠道账单（小写 m）；gwXxx = 网关账单（驼峰 M；Type 用索引引用）。
const FIELD_MAP = Object.freeze({
  // 银行 / ADM 表（驼峰）
  admChannel: 'Channel',
  admFundType: 'FundType',
  admBillDate: 'BillDate',
  admChannelOrderNo: 'ChannelOrderNo',
  admCustomerRef: 'CustomerRef',
  admReconFundId: '资金对账ID',
  admAllocationNo: '调拨号',
  admFundtransferInAmount: 'Fundtransfer-in金额',
  admBatchNo: '批次号',
  admChannelMatched: '是否与渠道账单匹配',
  admGatewayMatched: '是否与网关账单匹配',
  // 中台调拨（中文）
  midAllocationNo: '调拨单号',
  midChannelSerial: '渠道流水号',
  midReceiveAmount: '收款金额',
  // 渠道账单（小写 m）
  chMerchantId: 'merchantId',
  chReconId: 'reconciliationId',
  chReceiveAmount: 'receiveAmount',
  chAdditionInfo: 'additionInfo',
  // 网关账单（驼峰 M；Type 用索引引用 GATEWAY_BILL_FIELDS[8]）
  gwMerchantId: 'MerchantId',
  gwOrderId: 'OrderId',
  gwReference: 'Reference',
  gwTypeIndex: 8
});

// 模块加载期断言：GATEWAY_BILL_FIELDS[gwTypeIndex] 必须是 Type 超长缺括号列（防 gateway 常量列序漂移致索引失配）。
//   🔴 R-1/R-3 护栏：索引 8 一旦指向别的列，JPM 引擎会把 Type 写到错列 → 污染网关对账单修复行。
const __gwTypeCol = GATEWAY_BILL_FIELDS[FIELD_MAP.gwTypeIndex];
if (typeof __gwTypeCol !== 'string' || __gwTypeCol.indexOf('Type') !== 0) {
  throw new Error(
    `[adm-bank-deposit-fields] GATEWAY_BILL_FIELDS[${FIELD_MAP.gwTypeIndex}] 不是 Type 列（实际为「${__gwTypeCol}」）— gateway 常量列序疑似漂移，须同步 gwTypeIndex`
  );
}

module.exports = {
  CHANNEL_VALUE,
  ADM_FUND_TYPES,
  ADM_EXTRA_FIELDS,
  ADM_MERCHANT_ID,
  FIELD_MAP
};
