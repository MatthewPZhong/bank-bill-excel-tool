// v3.0.6 需求1「调拨对账单派生」—— 跨表字段映射单一真相（🔴 资金红线）
// 中台调拨订单（mid-allocation）一行 → 调拨对账单 FundTransfer-in + FundTransfer-out 两行。
// plan「需求1」字段映射表 / 决策 D1（大账号按方向固化 big_account，匹配引擎零方向分支）。
//
// 🔴 跨表字段（显式映射，绝不假设同名 —— 仿 payment-offline-allocation-fields.js / refund-backfill-fields.js）：
//   中台调拨订单源列名一律从 ZHONGTAI_DISPATCH_ORDER_SIGNATURE.expectedHeaders 逐字取（含全角括号
//   「付款账户（卡号）」「收款账户（卡号）」—— 半角化即取空 → big_account 取空 → 下游引擎会误命中
//   MerchantId 也为空的银行行（valuesEqual('','')===true），写错 ReconciliationId，资金红线；
//   故 r5-fund-transfer-recon / dbs-charge 引擎均加 big_account 非空护栏）。
//
// 派生方向（决策 D1）：
//   FundTransfer-in  行：渠道=收款渠道、金额=收款金额、币种=收款币种、big_account=收款账户（卡号）
//   FundTransfer-out 行：渠道=付款渠道、金额=付款金额、币种=付款币种、big_account=付款账户（卡号）
//     —— out 行币种取「付款币种」（用户原文此处笔误写成 in 行，按收/付对称纠正为 out）。

const { ZHONGTAI_DISPATCH_ORDER_SIGNATURE } = require('./table-signatures');

const FT_RECON_FIELD_MAP = Object.freeze({
  // —— 中台调拨订单源列（mid-allocation，readLinkedTableRows('mid-allocation') 还原的中文真实表头）——
  mid: Object.freeze({
    allocationNo: '调拨单号',
    status: '调拨状态',
    txTime: '交易时间',
    channelSerial: '渠道流水号',
    payCard: '付款账户（卡号）', // 全角括号；out 行 big_account 来源
    payeeCard: '收款账户（卡号）', // 全角括号；in 行 big_account 来源
    receiveChannel: '收款渠道',
    receiveAmount: '收款金额',
    receiveCurrency: '收款币种',
    payChannel: '付款渠道',
    payAmount: '付款金额',
    payCurrency: '付款币种'
  }),
  // —— 调拨对账单派生字段（落库 raw_json + 提列；builder 产出、需求2/3 引擎读取）——
  recon: Object.freeze({
    allocationNo: '调拨单号',
    billDate: 'BillDate',
    reconId: 'ReconID',
    payAccount: '付款账号',
    payeeAccount: '收款账号',
    payChannel: '付款渠道',
    receiveChannel: '收款渠道',
    amount: '金额',
    currency: '币种',
    fundType: 'fund_type', // 方向标记 + 匹配热列（FundTransfer-in/out）
    bigAccount: 'big_account' // D1 按方向固化（in=收款卡号 / out=付款卡号）
  }),
  // —— 方向固定值（资产表 FundType枚举值.xlsx 实证大写 T，与 R5s2 / R5s2b 一致）——
  FUND_TYPE_IN: 'FundTransfer-in',
  FUND_TYPE_OUT: 'FundTransfer-out'
});

const MID_ALLOCATION_SUCCESS_STATUS = '付款成功';

// 启动期断言①：mid 源列全部 ∈ ZHONGTAI_DISPATCH_ORDER_SIGNATURE.expectedHeaders
//   （防全角括号被手敲成半角 / 列名漂移 → 派生取空 → big_account 取空 → 需求2/3 引擎会误命中
//    MerchantId 也为空的银行行（valuesEqual('','')===true），写错 ReconciliationId，资金红线；
//    故两引擎均加 big_account 非空护栏）。
const __midCols = Object.values(FT_RECON_FIELD_MAP.mid);
const __sigHeaders = (ZHONGTAI_DISPATCH_ORDER_SIGNATURE && ZHONGTAI_DISPATCH_ORDER_SIGNATURE.expectedHeaders) || [];
const __missingMid = __midCols.filter((f) => !__sigHeaders.includes(f));
if (__missingMid.length > 0) {
  throw new Error(
    `[fund-transfer-recon-fields] mid 源列不在中台调拨订单签名内（字段漂移）：${__missingMid.join(', ')}`
  );
}

// 启动期断言②：recon 派生列非空（防漏配 / 误删）。
const __reconCols = Object.values(FT_RECON_FIELD_MAP.recon);
const __emptyRecon = __reconCols.filter((f) => typeof f !== 'string' || f.trim() === '');
if (__emptyRecon.length > 0) {
  throw new Error('[fund-transfer-recon-fields] recon 派生列存在空列名（字段漂移）');
}

module.exports = {
  FT_RECON_FIELD_MAP,
  MID_ALLOCATION_SUCCESS_STATUS
};
