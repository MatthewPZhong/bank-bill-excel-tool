'use strict';

const BANK_DIRECTION = Object.freeze({
  CREDIT: 'CREDIT',
  DEBIT: 'DEBIT'
});

function freezeRule(name, gatewayTradeTypes, bankFundTypes, direction) {
  return Object.freeze({
    name,
    gatewayTradeTypes: Object.freeze(gatewayTradeTypes.slice()),
    bankFundTypes: Object.freeze(bankFundTypes.slice()),
    direction
  });
}

// Source: 资金对账规则.xlsx / 资金对账规则!A2:F15 (2026-07-15).
// Values are exact after trim; case and punctuation are business-significant.
const RECONCILIATION_RULES = Object.freeze([
  freezeRule('payout', [
    'Withdraw', 'LYRepay', 'LYPayment', 'MPT_WITHDRAW', 'MPT_SUPPLIER', 'MPT_VAT',
    'MPT_FLOW_MORE', 'MPT_AMAZON_ADS', 'MPT_TRANSPARENCY', 'MPT_MARKET_PLACE',
    'LY_WITHDRAW', 'ACQ_WITHDRAW', 'B2B_WITHDRAW', 'B2B_SUPPLIER',
    'B2B_MARKET_PLACE', 'B2B_VAT', 'B2B_FLOW_GOLD', 'B2B_FLOW_GOLD_SUPPLIER',
    'FX_WITHDRAW', 'HX_WITHDRAW', 'FIG_WITHDRAW', 'CUR_REMITTANCE', 'CUR_WITHDRAW',
    'CUR_PAY', 'LY_PAY', 'CUR_DEBIT', 'FlowMore_Withdraw', 'OUTBOUND_OFF', 'FX_PAY'
  ], [
    'Not mark yet', 'Mark without result', 'outbound', 'Ach Debit', 'Outbound&FX',
    'outbound&Ach Return', 'outbound&Test'
  ], BANK_DIRECTION.DEBIT),
  freezeRule('Inbound', [
    'B2B_CREDIT', 'Inbound-VA', 'Inbound-Recharge', 'RECEIVE_OFF'
  ], [
    'Inbound', 'Inbound&FX', 'INBOUND&GPAY', 'INBOUND&FIUU', 'INBOUND&FIUUOnline',
    'INBOUND&VNXendit', 'INBOUND&Eft', 'INBOUND&THKbank'
  ], BANK_DIRECTION.CREDIT),
  freezeRule('Return', ['Reversal', 'AchReturn'], [
    'Ach Return', 'Reversal', 'AchReturn&FX', 'Reversal&FX', 'outbound&Ach Return'
  ], BANK_DIRECTION.DEBIT),
  freezeRule('channel-settle-out', [
    'chargeback', 'flowMore_refund_acq', 'b2b_refund_acq', 'detailfund_refund',
    'OutboundDetailFund'
  ], [
    'Acquiring Settle withdrawal-Flowmore', 'Channel-settle-out'
  ], BANK_DIRECTION.DEBIT),
  freezeRule('channel-settle-in', [
    'Purchase', 'chargeback_reversal', 'FxPurchasing', 'DetailFund',
    'outbound_detailfund_refund'
  ], [
    'Acquiring Settle-Flowmore', 'Lejiapay Settle-MPT', 'QBC Settle',
    'Lejiapay Settle-CURRENTS', 'Channel-settle-in'
  ], BANK_DIRECTION.CREDIT),
  freezeRule('Fund-Outbound', ['PPI_PURCHASE'], ['Fund-Outbound'], BANK_DIRECTION.DEBIT),
  freezeRule('Fund-Inbound', ['PPI_REDEMPTION'], ['Fund-Inbound'], BANK_DIRECTION.CREDIT),
  freezeRule('Fundtransfer-out', ['FundTransfer-out'], [
    'FundTransfer-out', 'Fundtransfer-out&FX', 'Fundtransfer-out&FX-split'
  ], BANK_DIRECTION.DEBIT),
  freezeRule('Fundtransfer-in', ['FundTransfer-in'], [
    'FundTransfer-in', 'Fundtransfer-in&FX', 'Fundtransfer-in&FX-split'
  ], BANK_DIRECTION.CREDIT),
  freezeRule('WireReturn', ['WireReturn', 'REFUND_OFF'], [
    'Wire Return', 'WireReturn&FX'
  ], BANK_DIRECTION.CREDIT),
  freezeRule('HX-OUTBOUND', ['HX_OUTBOUND'], ['HX-out'], BANK_DIRECTION.DEBIT),
  freezeRule('HX-INBOUND', ['HX_INBOUND'], ['HX-in'], BANK_DIRECTION.CREDIT),
  freezeRule('External_Transfer-out', [], ['ExternalTransfer-out'], BANK_DIRECTION.DEBIT),
  freezeRule('External_Transfer-in', [], ['ExternalTransfer-in'], BANK_DIRECTION.CREDIT)
]);

const RULES_BY_FUND_TYPE = new Map();
for (const rule of RECONCILIATION_RULES) {
  for (const fundType of rule.bankFundTypes) {
    const rules = RULES_BY_FUND_TYPE.get(fundType) || [];
    rules.push(rule);
    RULES_BY_FUND_TYPE.set(fundType, rules);
  }
}

function normalizeRuleCell(value) {
  return value === null || value === undefined ? '' : String(value).trim();
}

function resolveBankRuleEligibility(fundTypeValue, directionValue) {
  const fundType = normalizeRuleCell(fundTypeValue);
  const direction = normalizeRuleCell(directionValue).toUpperCase();
  const fundTypeRules = RULES_BY_FUND_TYPE.get(fundType) || [];
  if (fundTypeRules.length === 0) {
    return Object.freeze({
      eligible: false,
      code: 'bank-fund-type-unmapped',
      fundType,
      direction,
      ruleNames: Object.freeze([]),
      allowedGatewayTradeTypes: Object.freeze([]),
      reason: `银行 FundType「${fundType || '空'}」未配置对账规则`
    });
  }

  const directionRules = fundTypeRules.filter((rule) => rule.direction === direction);
  if (directionRules.length === 0) {
    const expected = [...new Set(fundTypeRules.map((rule) => rule.direction))].join('/');
    return Object.freeze({
      eligible: false,
      code: 'bank-rule-direction-mismatch',
      fundType,
      direction,
      ruleNames: Object.freeze(fundTypeRules.map((rule) => rule.name)),
      allowedGatewayTradeTypes: Object.freeze([]),
      reason: `银行 FundType「${fundType}」方向应为 ${expected}，实际为 ${direction || '空'}`
    });
  }

  const allowedGatewayTradeTypes = [...new Set(
    directionRules.flatMap((rule) => rule.gatewayTradeTypes)
  )];
  if (allowedGatewayTradeTypes.length === 0) {
    return Object.freeze({
      eligible: false,
      code: 'bank-rule-no-gateway-trade-type',
      fundType,
      direction,
      ruleNames: Object.freeze(directionRules.map((rule) => rule.name)),
      allowedGatewayTradeTypes: Object.freeze([]),
      reason: `银行 FundType「${fundType}」对应规则未配置网关 tradeType`
    });
  }

  return Object.freeze({
    eligible: true,
    code: 'eligible',
    fundType,
    direction,
    ruleNames: Object.freeze(directionRules.map((rule) => rule.name)),
    allowedGatewayTradeTypes: Object.freeze(allowedGatewayTradeTypes),
    reason: ''
  });
}

module.exports = {
  BANK_DIRECTION,
  RECONCILIATION_RULES,
  normalizeRuleCell,
  resolveBankRuleEligibility
};
