'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  BANK_DIRECTION,
  RECONCILIATION_RULES,
  resolveBankRuleEligibility
} = require('../../../src/main-process/pre-fund-reconciliation/reconciliation-rules');
const {
  reconcilePreFundRows
} = require('../../../src/main-process/pre-fund-reconciliation/matching-engine');

function bank(overrides = {}) {
  return {
    BillDate: '2026-07-01',
    ValueDate: '2026-07-01',
    Channel: 'CIT',
    MerchantId: 'M-1',
    Currency: 'USD',
    'Credit Amount': '9999980',
    'Debit Amount': '',
    'Extra Fee': '20',
    ReconciliationId: 'R-1',
    FundType: 'Inbound',
    ...overrides
  };
}

function gateway(overrides = {}) {
  return {
    reconciliationId: 'R-1',
    date: '2026-07-01',
    channel: 'CIT',
    merchantId: 'M-1',
    orderId: 'O-1',
    billReconId: 'B-1',
    currency: 'USD',
    amount: '10000000',
    tradeType: 'Inbound-VA',
    realChannel: 'CIT',
    clearingNetwork: 'SWIFT',
    ...overrides
  };
}

test('附件14类规则完整固化，方向和名称保持稳定', () => {
  assert.equal(RECONCILIATION_RULES.length, 14);
  assert.deepEqual(RECONCILIATION_RULES.map((rule) => rule.name), [
    'payout', 'Inbound', 'Return', 'channel-settle-out', 'channel-settle-in',
    'Fund-Outbound', 'Fund-Inbound', 'Fundtransfer-out', 'Fundtransfer-in',
    'WireReturn', 'HX-OUTBOUND', 'HX-INBOUND', 'External_Transfer-out',
    'External_Transfer-in'
  ]);
  assert.equal(RECONCILIATION_RULES.filter((rule) => rule.direction === BANK_DIRECTION.CREDIT).length, 7);
  assert.equal(RECONCILIATION_RULES.filter((rule) => rule.direction === BANK_DIRECTION.DEBIT).length, 7);
});

test('FundType 同时属于多条规则时合并允许的网关类型', () => {
  const result = resolveBankRuleEligibility(' outbound&Ach Return ', 'DEBIT');
  assert.equal(result.eligible, true);
  assert.deepEqual(result.ruleNames, ['payout', 'Return']);
  assert.ok(result.allowedGatewayTradeTypes.includes('Withdraw'));
  assert.ok(result.allowedGatewayTradeTypes.includes('Reversal'));
});

test('规则值只 trim，大小写不等价；方向不符有独立原因', () => {
  assert.equal(resolveBankRuleEligibility(' Inbound ', ' credit ').eligible, true);
  assert.equal(resolveBankRuleEligibility('inbound', 'CREDIT').code, 'bank-fund-type-unmapped');
  assert.equal(resolveBankRuleEligibility('Inbound', 'DEBIT').code, 'bank-rule-direction-mismatch');
});

test('ExternalTransfer 空网关类型不是通配符或空字符串匹配', () => {
  const outbound = resolveBankRuleEligibility('ExternalTransfer-out', 'DEBIT');
  const inbound = resolveBankRuleEligibility('ExternalTransfer-in', 'CREDIT');
  assert.equal(outbound.code, 'bank-rule-no-gateway-trade-type');
  assert.equal(inbound.code, 'bank-rule-no-gateway-trade-type');
  assert.deepEqual(outbound.allowedGatewayTradeTypes, []);
});

test('正手续费和负手续费都按规则及五字段条件平账', () => {
  const result = reconcilePreFundRows({
    bankRows: [
      bank(),
      bank({
        ReconciliationId: 'R-2',
        'Credit Amount': '',
        'Debit Amount': '3300254.4',
        'Extra Fee': '-254.4',
        FundType: 'outbound'
      })
    ],
    temporaryGatewayRows: [
      gateway(),
      gateway({
        reconciliationId: 'R-2',
        orderId: 'O-2',
        amount: '3300000',
        tradeType: 'Withdraw'
      })
    ]
  });
  assert.equal(result.balancedPairs.length, 2);
  assert.deepEqual(result.balancedPairs.map((pair) => pair.bankRow.matchingAmount), [
    '10000000', '3300000'
  ]);
});

test('四字段相同但 tradeType 不允许时不消费候选并输出原因', () => {
  const result = reconcilePreFundRows({
    bankRows: [bank()],
    temporaryGatewayRows: [gateway({ tradeType: 'Withdraw' })]
  });
  assert.equal(result.balancedPairs.length, 0);
  assert.equal(result.unbalancedBankRows.length, 1);
  assert.equal(result.stats.gatewayUnconsumedRows, 1);
  assert.match(result.unbalancedBankRows[0].unbalancedReason, /类型规则/);
});

test('未配置、方向不符和无网关类型均进入不平并分别统计', () => {
  const result = reconcilePreFundRows({
    bankRows: [
      bank({ ReconciliationId: 'U', FundType: 'UNKNOWN' }),
      bank({
        ReconciliationId: 'D', FundType: 'Inbound',
        'Credit Amount': '', 'Debit Amount': '1', 'Extra Fee': '0'
      }),
      bank({ ReconciliationId: 'E', FundType: 'ExternalTransfer-in' })
    ],
    temporaryGatewayRows: [gateway({ reconciliationId: 'OTHER' })]
  });
  assert.equal(result.unbalancedBankRows.length, 3);
  assert.equal(result.stats.bankRuleUnmappedRows, 1);
  assert.equal(result.stats.bankRuleDirectionMismatchRows, 1);
  assert.equal(result.stats.bankRuleNoGatewayTradeTypeRows, 1);
});
