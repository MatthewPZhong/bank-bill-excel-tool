// v3.0.4 块 F「Payment线下调拨订单回填处理」—— 跨表字段映射单一真相（🔴 资金红线）
// changes/payment-offline-allocation-backfill/spec.md §F3 / §F5
//
// 🔴 跨表字段（显式映射，绝不假设同名 —— 仿 refund-backfill-fields.js / r5-fund-transfer-backfill.js 文件头风格）：
//   ⚠️ 修订 R2（2026-06-12）：订单池渠道筛选列翻转——线下调拨「付款渠道」=出款行（如 BGL），
//     「收款渠道」才是账单所属渠道（如 CITI）。订单池改筛「付款方式==='线下' ∧ 收款渠道===bankChannel」，
//     原「付款渠道」筛选废弃（删 payChannel，新增 payMethod / receiveChannel）。详 spec §R2.2 Q10。
//   中台调拨订单（mid-allocation，中文，ZHONGTAI_DISPATCH_ORDER_SIGNATURE 26 列，table-signatures.js:98-103）：
//     mid['调拨单号']               idx0  —— FTA+8位日期，派生「订单对账周数号」来源
//     mid['付款方式']               idx2  —— 订单池筛选 === OFFLINE_PAY_METHOD（'线下'；过滤线上 CFT 单）
//     mid['渠道流水号']             idx3  —— 命中后回填进 bank.ReconciliationId 的来源值
//     mid['交易时间']               idx4  —— 与 bank.BillDate 比对（Q6 同日算晚于，日粒度）
//     mid['收款账户（卡号）']        idx6  —— ⚠️【全角括号】订单池筛选属于 bigAccount 配置集合；勿与 idx23「收款账号」混拿
//     mid['收款金额']               idx9  —— 与 bank['Credit Amount'] 比对（Math.round(*100) 分级精度）
//     mid['收款币种']               idx10 —— 与 bank.Currency 比对（valuesEqual）
//     mid['收款渠道']               idx25 —— ⚠️【26 列签名最后一列】订单池筛选 === bankChannel（账单所属渠道）
//   银行对账单（bank statement，驼峰，BANK_STATEMENT_FIELDS 44 列）：
//     bank.MerchantId               商户 ID —— 银行池筛选属于 bigAccount 配置集合，且匹配时须等于订单收款账户
//     bank.FundType                 资金性质 —— 银行池筛选 === 'FundTransfer-in'（⚠️【大写 T】，资产表实证）
//     bank['地区']                  地区 —— 银行池筛选 === region（Q1 拍板：地区参与银行侧筛选）
//     bank.BillDate                 账单日期 —— 派生「银行对账周数号」+ 与 mid.交易时间 比对
//     bank['Credit Amount']         发生额（⚠️【含空格】，单列）—— 与 mid.收款金额 比对
//     bank.Currency                 币种 —— 与 mid.收款币种 比对
//     bank.ReconciliationId         对账 ID —— 回填的目标列
//     bank._rowId                   行唯一键（上游注入，全局唯一；严格 1v1 消费 + warning 反查依赖）
//
// 仿 refund-backfill-fields.js：Object.freeze + 启动期断言（防常量漂移）。引擎一律取本模块常量，禁手敲列名。

const { BANK_STATEMENT_FIELDS } = require('./bank-statement-fields');

const PAYMENT_OFFLINE_FIELD_MAP = Object.freeze({
  // —— 中台调拨订单侧（mid-allocation）——
  mid: Object.freeze({
    dispatchNo: '调拨单号',          // FTA+8位日期 → 订单对账周数号
    payMethod: '付款方式',           // 订单池 === OFFLINE_PAY_METHOD（'线下'；过滤线上 CFT 单）—— 修订 R2
    channelSerialNo: '渠道流水号',   // → 回填 bank.ReconciliationId 的来源
    txTime: '交易时间',              // 与 bank.BillDate 比对
    payeeAccountCard: '收款账户（卡号）', // ⚠️ 全角括号；订单池属于 bigAccount 集合（勿与「收款账号」混）
    payeeAmount: '收款金额',         // 与 bank['Credit Amount'] 比对
    payeeCurrency: '收款币种',       // 与 bank.Currency 比对
    receiveChannel: '收款渠道'       // 订单池 === bankChannel（账单所属渠道，非「付款渠道」出款行）—— 修订 R2
  }),
  // —— 银行对账单侧（bank statement）——
  bank: Object.freeze({
    merchantId: 'MerchantId',        // 银行池属于 bigAccount 集合，配对时与订单账号严格相等
    fundType: 'FundType',            // 银行池 === FUND_TYPE_IN（大写 T）
    region: '地区',                  // 银行池 === region
    billDate: 'BillDate',            // → 银行对账周数号 + 比对
    creditAmount: 'Credit Amount',   // 与 mid.收款金额 比对（含空格）
    currency: 'Currency',            // 与 mid.收款币种 比对
    reconciliationId: 'ReconciliationId' // 回填目标
  }),
  // —— 银行池筛选固定值（资产表 FundType枚举值.xlsx 实证大写 T）——
  FUND_TYPE_IN: 'FundTransfer-in',
  // —— 订单池付款方式固定值（修订 R2 Q10：仅线下单参与本引擎，线上 CFT 单归 R5s2 网关回填）——
  OFFLINE_PAY_METHOD: '线下',
  // —— 匹配阶梯参数（修订 R2 Q11/Q12；仿 FTA_FEATURE 范式 Object.freeze，禁引擎手敲魔数）——
  //   txLagToleranceDays：R2 容差轮回看天数（救录单滞后）；relaxedWindowDays：R3 兜底轮就近窗口（救跨周界）。
  MATCH_RULES: Object.freeze({ txLagToleranceDays: 2, relaxedWindowDays: 7 })
});

// 启动期断言①：bank 侧映射列全部 ∈ BANK_STATEMENT_FIELDS（防银行列名漂移 → 静默回填错列）
const __bankCols = Object.values(PAYMENT_OFFLINE_FIELD_MAP.bank);
const __missingBankColumns = __bankCols.filter((f) => !BANK_STATEMENT_FIELDS.includes(f));
if (__missingBankColumns.length > 0) {
  throw new Error(
    `[payment-offline-allocation-fields] bank 映射含非 BANK_STATEMENT_FIELDS 字段（常量漂移）：${__missingBankColumns.join(', ')}`
  );
}

// 启动期断言②：mid 侧 7 列全部就位（防漏配 / 误删；不与表签名硬绑，仅防空键漂移）
const __midCols = Object.values(PAYMENT_OFFLINE_FIELD_MAP.mid);
const __emptyMidColumns = __midCols.filter((f) => typeof f !== 'string' || f.trim() === '');
if (__emptyMidColumns.length > 0) {
  throw new Error('[payment-offline-allocation-fields] mid 映射存在空列名（常量漂移）');
}

module.exports = {
  PAYMENT_OFFLINE_FIELD_MAP
};
