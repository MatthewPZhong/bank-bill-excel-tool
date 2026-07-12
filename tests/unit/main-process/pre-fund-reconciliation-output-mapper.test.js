'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { reconcilePreFundRows } = require('../../../src/main-process/pre-fund-reconciliation/matching-engine');
const {
  BANK_SOURCE,
  UNBALANCED_HEADERS,
  BALANCED_HEADERS,
  CHANNEL_BILL_HEADERS,
  projectOutputRow,
  mapUnbalancedRow,
  mapBalancedRow,
  mapChannelBillRow,
  assertOutputConservation,
  listResultChannels,
  iterateChannelExports
} = require('../../../src/main-process/pre-fund-reconciliation/output-mapper');

function bank(reconciliationId, channel = 'CHANNEL-A', overrides = {}) {
  return {
    BillDate: '2026-07-01',
    ValueDate: '2026-07-02',
    Channel: channel,
    '地区': 'HK',
    MerchantId: 'MID-1',
    Currency: 'USD',
    'Credit Amount': '10.50',
    'Debit Amount': '',
    ReconciliationId: reconciliationId,
    ChannelOrderNo: 'CO-1',
    'Drawee Name': 'Alice',
    'Drawee CardNo': 'CARD-1',
    'Extra Fee': '0.10',
    '清算网络': 'SWIFT',
    'Extra Information': 'extra',
    'Remark-description': 'remark',
    FundType: 'Inbound',
    OriginBillId: '',
    ...overrides
  };
}

function gateway(reconciliationId, overrides = {}) {
  return {
    reconciliationId,
    date: '2026/07/01',
    channel: 'CHANNEL-A',
    merchantId: 'GW-MID',
    orderId: 'GW-ORDER',
    billReconId: 'GW-BIZ',
    currency: 'USD',
    amount: '10.5000',
    tradeType: 'PAY',
    name: 'Gateway Name',
    cardNo: 'GW-CARD',
    realChannel: 'GW-REAL',
    clearingNetwork: 'GW-CLEAR',
    ...overrides
  };
}

function buildResult() {
  return reconcilePreFundRows({
    bankRows: [
      bank('MATCH', 'CHANNEL-A', { OriginBillId: 'BANK-ORIGIN-1' }),
      bank('MISS', 'CHANNEL-B', { ChannelOrderNo: 'CO-MISS' })
    ],
    bankContext: { fileName: '银行.xlsx' },
    temporaryGatewayRows: [gateway('MATCH')]
  });
}

test('固定输出表头严格为20列不平、31列平账、16列渠道账单', () => {
  assert.equal(UNBALANCED_HEADERS.length, 20);
  assert.equal(BALANCED_HEADERS.length, 31);
  assert.equal(CHANNEL_BILL_HEADERS.length, 16);
  assert.deepEqual(UNBALANCED_HEADERS, [
    '对账数据来源', '账单日期', '支付渠道', '业务类型', '交易类型', '对账结果', 'reconId',
    '业务订单号', '业务订单金额', '业务方币种', '渠道账号', '渠道订单号', '渠道订单金额',
    '渠道币种', '业务订单交易完成时间', '渠道订单交易完成时间', '差错类型', '备注',
    '业务方原始账单ID', '渠道方原始账单ID'
  ]);
  assert.deepEqual(BALANCED_HEADERS.slice(0, 4), [
    '网关-数据来源', '网关-BillDate', '网关-Channel', '网关-MerchantId'
  ]);
  assert.equal(BALANCED_HEADERS[14], '对账结果');
  assert.equal(BALANCED_HEADERS[15], '银行-数据来源');
  assert.equal(BALANCED_HEADERS[30], '银行-OriginBillId');
  assert.deepEqual(CHANNEL_BILL_HEADERS, [
    'channelName', 'merchantId', 'reconciliationId', 'channelOrderNo', 'name', 'cardNo',
    'currency', 'requestAmount', 'receiveAmount', 'extraFee', '清算网络', 'createTime',
    'finishTime', 'additionInfo', 'remark', 'COriginalId'
  ]);
});

test('不平结果只映射银行右单边，固定值和稳定追溯ID正确', () => {
  const result = buildResult();
  const mapped = mapUnbalancedRow(result.unbalancedBankRows[0]);
  assert.equal(mapped['对账数据来源'], BANK_SOURCE);
  assert.equal(mapped['账单日期'], '2026-07-02');
  assert.equal(mapped['支付渠道'], 'CHANNEL-B');
  assert.equal(mapped['业务类型'], 'null');
  assert.equal(mapped['交易类型'], 'CREDIT');
  assert.equal(mapped['对账结果'], '不平账');
  assert.equal(mapped.reconId, 'MISS');
  assert.equal(mapped['业务订单金额'], '0.000000000000');
  assert.equal(mapped['渠道订单金额'], '10.5');
  assert.equal(mapped['差错类型'], '右单边账');
  assert.equal(mapped['业务方原始账单ID'], '');
  assert.equal(mapped['渠道方原始账单ID'], '银行.xlsx#3');
  assert.equal(projectOutputRow(UNBALANCED_HEADERS, mapped).length, 20);
});

test('平账结果完整映射网关14列、结果列和银行16列', () => {
  const result = buildResult();
  const mapped = mapBalancedRow(result.balancedPairs[0]);
  assert.equal(mapped['网关-数据来源'], '临时网关对账单');
  assert.equal(mapped['网关-BillDate'], '2026-07-01');
  assert.equal(mapped['网关-Channel'], 'CHANNEL-A');
  assert.equal(mapped['网关-ReconBillBizId'], 'GW-BIZ');
  assert.equal(mapped['网关-reconciliationId'], 'MATCH');
  assert.equal(mapped['网关-Amount'], '10.5');
  assert.equal(mapped['网关-name'], 'Gateway Name');
  assert.equal(mapped['网关-cardNo'], 'GW-CARD');
  assert.equal(mapped['对账结果'], '平账');
  assert.equal(mapped['银行-数据来源'], BANK_SOURCE);
  assert.equal(mapped['银行-Channel'], 'CHANNEL-A');
  assert.equal(mapped['银行-name'], 'Alice');
  assert.equal(mapped['银行-cardNo'], 'CARD-1');
  assert.equal(mapped['银行-Credit Amount'], '10.50');
  assert.equal(mapped['银行-OriginBillId'], 'BANK-ORIGIN-1');
  assert.equal(projectOutputRow(BALANCED_HEADERS, mapped).length, 31);
});

test('渠道账单16列只映射同一缺网关银行行', () => {
  const result = buildResult();
  const mapped = mapChannelBillRow(result.unbalancedBankRows[0]);
  assert.equal(mapped.channelName, 'CHANNEL-B');
  assert.equal(mapped.merchantId, 'MID-1');
  assert.equal(mapped.reconciliationId, 'MISS');
  assert.equal(mapped.channelOrderNo, 'CO-MISS');
  assert.equal(mapped.name, 'Alice');
  assert.equal(mapped.cardNo, 'CARD-1');
  assert.equal(mapped.requestAmount, '');
  assert.equal(mapped.receiveAmount, '10.5');
  assert.equal(mapped.extraFee, '0.10');
  assert.equal(mapped.createTime, '2026-07-01');
  assert.equal(mapped.finishTime, '2026-07-02');
  assert.equal(mapped.additionInfo, 'extra');
  assert.equal(mapped.remark, 'remark');
  assert.equal(mapped.COriginalId, '银行.xlsx#3');
  assert.equal(projectOutputRow(CHANNEL_BILL_HEADERS, mapped).length, 16);
});

test('输出统计严格守恒：参与行=平账+不平，渠道账单行数=不平', () => {
  const stats = assertOutputConservation(buildResult());
  assert.deepEqual(stats, {
    participatingBankRows: 2,
    balancedResultRows: 1,
    unbalancedResultRows: 1,
    channelBillRows: 1
  });
});

test('集合或统计漂移时中文 fail-fast，不静默导出', () => {
  const result = buildResult();
  result.stats.bankParticipatingRows = 99;
  assert.throws(() => assertOutputConservation(result), /输出行数不守恒/);
});

test('逐渠道输出暴露 generator，不复制全量数组且内容不串渠道', () => {
  const result = buildResult();
  assert.deepEqual(listResultChannels(result), ['CHANNEL-A', 'CHANNEL-B']);
  const exports = [...iterateChannelExports(result)];
  assert.equal(exports.length, 2);
  assert.equal(Array.isArray(exports[0].balancedRows), false);
  assert.equal(Array.isArray(exports[1].unbalancedRows), false);
  assert.equal([...exports[0].balancedRows].length, 1);
  assert.equal([...exports[0].unbalancedRows].length, 0);
  const channelBUnbalanced = [...exports[1].unbalancedRows];
  const channelBBills = [...exports[1].channelBillRows];
  assert.equal(channelBUnbalanced.length, 1);
  assert.equal(channelBUnbalanced[0]['支付渠道'], 'CHANNEL-B');
  assert.equal(channelBBills.length, 1);
  assert.equal(channelBBills[0].channelName, 'CHANNEL-B');
});

test('数组行投影也必须严格匹配固定列数', () => {
  assert.throws(() => projectOutputRow(UNBALANCED_HEADERS, ['too-short']), /应为20列/);
  assert.deepEqual(
    projectOutputRow(['A', 'B'], { A: 0, B: null }),
    [0, '']
  );
});
