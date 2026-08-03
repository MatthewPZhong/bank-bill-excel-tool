// v3.1.7「Payment线下调拨订单回填处理」跨表字段映射（资金红线）。
// Payment 与 R5s2-recon 共用调拨对账单派生行，不再直接读取中台调拨订单 26 列。

const { BANK_STATEMENT_FIELDS } = require('./bank-statement-fields');
const { FT_RECON_FIELD_MAP } = require('./fund-transfer-recon-fields');

const R = FT_RECON_FIELD_MAP.recon;

const PAYMENT_OFFLINE_FIELD_MAP = Object.freeze({
  recon: Object.freeze({
    dispatchNo: R.allocationNo,
    payMethod: R.payMethod,
    reconId: R.reconId,
    txTime: R.billDate,
    bigAccount: R.bigAccount,
    amount: R.amount,
    currency: R.currency,
    receiveChannel: R.receiveChannel,
    payAccount: R.payAccount,
    fundType: R.fundType,
    used: R.used
  }),
  bank: Object.freeze({
    merchantId: 'MerchantId',
    fundType: 'FundType',
    region: '地区',
    billDate: 'BillDate',
    creditAmount: 'Credit Amount',
    currency: 'Currency',
    draweeCardNo: 'Drawee CardNo',
    reconciliationId: 'ReconciliationId'
  }),
  FUND_TYPE_IN: 'FundTransfer-in',
  OFFLINE_PAY_METHOD: '线下',
  MATCH_RULES: Object.freeze({ txLagToleranceDays: 2, relaxedWindowDays: 7 })
});

const __bankCols = Object.values(PAYMENT_OFFLINE_FIELD_MAP.bank);
const __missingBankColumns = __bankCols.filter((field) => !BANK_STATEMENT_FIELDS.includes(field));
if (__missingBankColumns.length > 0) {
  throw new Error(
    `[payment-offline-allocation-fields] bank 映射含非 BANK_STATEMENT_FIELDS 字段：${__missingBankColumns.join(', ')}`
  );
}

const __reconCols = Object.values(PAYMENT_OFFLINE_FIELD_MAP.recon);
const __knownReconCols = Object.values(R);
const __missingReconColumns = __reconCols.filter((field) => !__knownReconCols.includes(field));
if (__missingReconColumns.length > 0) {
  throw new Error(
    `[payment-offline-allocation-fields] recon 映射含非调拨派生字段：${__missingReconColumns.join(', ')}`
  );
}

module.exports = {
  PAYMENT_OFFLINE_FIELD_MAP
};
