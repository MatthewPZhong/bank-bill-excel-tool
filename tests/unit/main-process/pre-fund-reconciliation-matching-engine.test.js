'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  GATEWAY_SOURCE,
  FINGERPRINT_FIELDS,
  GatewayPoolEmptyError,
  canonicalizeDate,
  normalizeGatewayFingerprintFields,
  buildGatewayFingerprint,
  normalizeGatewayCandidate,
  buildBankMatchCriteria,
  gatewayCandidateMatches,
  buildGatewayPools,
  stageGatewayCandidatesIterative,
  reconcileBankRowsIterative,
  reconcilePreFundRows
} = require('../../../src/main-process/pre-fund-reconciliation/matching-engine');
const {
  buildGatewayFingerprint: buildMptGatewayFingerprint
} = require('../../../src/main-process/pre-fund-reconciliation/mpt-schema');

function gateway(overrides = {}) {
  return {
    reconciliationId: 'R-1',
    date: '2026-07-01',
    channel: 'MPT',
    merchantId: 'M-1',
    orderId: 'O-1',
    billReconId: 'B-1',
    currency: 'USD',
    amount: '1.00',
    tradeType: 'PAY',
    realChannel: 'RC',
    clearingNetwork: 'CN',
    name: 'Alice',
    cardNo: 'CARD',
    ...overrides
  };
}

function bank(reconciliationId, overrides = {}) {
  return {
    BillDate: '2026-07-01',
    ValueDate: '2026-07-02',
    Channel: 'MPT',
    MerchantId: 'M-1',
    Currency: 'USD',
    'Credit Amount': '1.00',
    'Debit Amount': '',
    ReconciliationId: reconciliationId,
    'Drawee Name': 'Alice',
    'Drawee CardNo': 'CARD',
    ...overrides
  };
}

test('日期统一 YYYY-MM-DD，含斜杠、ISO时间、Date和Excel序列号', () => {
  assert.equal(canonicalizeDate('2026/7/1'), '2026-07-01');
  assert.equal(canonicalizeDate('2026-07-01 12:30:00'), '2026-07-01');
  assert.equal(canonicalizeDate(new Date('2026-07-01T00:00:00Z')), '2026-07-01');
  assert.equal(canonicalizeDate(46204), '2026-07-01');
  assert.throws(() => canonicalizeDate('2026-02-30'), /日期.*无效/);
});

test('指纹字符串字段只 trim 且大小写敏感，金额按十进制数值等价', () => {
  const a = buildGatewayFingerprint(gateway({ channel: ' MPT ', amount: '1.0' }));
  const b = buildGatewayFingerprint(gateway({ channel: 'MPT', amount: '1.00' }));
  const c = buildGatewayFingerprint(gateway({ channel: 'mpt', amount: '1.00' }));
  assert.match(a, /^[a-f0-9]{64}$/);
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.equal(
    buildGatewayFingerprint(gateway({ amount: '9007199254740993.00' })),
    buildGatewayFingerprint(gateway({ amount: '9007199254740993' }))
  );
});

test('规范MPT行的指纹与并行PR2解析器SHA-256契约一致', () => {
  const row = gateway({ amount: '1.2300' });
  assert.equal(buildGatewayFingerprint(row), buildMptGatewayFingerprint(row));
});

test('十个指纹字段分别变化时均不得误折叠', async (t) => {
  const base = gateway();
  const changes = {
    date: '2026-07-02',
    channel: 'MPT-2',
    merchantId: 'M-2',
    orderId: 'O-2',
    billReconId: 'B-2',
    currency: 'EUR',
    amount: '1.01',
    tradeType: 'REFUND',
    realChannel: 'RC-2',
    clearingNetwork: 'CN-2'
  };
  assert.deepEqual(Object.keys(changes), FINGERPRINT_FIELDS);
  const baseFingerprint = buildGatewayFingerprint(base);
  for (const [field, value] of Object.entries(changes)) {
    await t.test(field, () => {
      assert.notEqual(buildGatewayFingerprint({ ...base, [field]: value }), baseFingerprint);
    });
  }
});

test('同 reconId+fingerprint 跨来源完全重复折叠，临时来源优先保留', () => {
  const stats = undefined;
  const built = buildGatewayPools({
    temporaryGatewayRows: [gateway(), gateway({ amount: '1.0000' })],
    persistentGatewayRows: [
      gateway({ amount: '1e0' }),
      gateway({ orderId: 'O-DIFFERENT' })
    ]
  }, stats);
  const pool = built.pools.get('R-1');
  assert.equal(pool.candidates.length, 2);
  assert.equal(pool.candidates[0].source, GATEWAY_SOURCE.TEMPORARY);
  assert.equal(pool.candidates[0].sourcePriority, 0);
  assert.equal(pool.candidates[0].sourceOrder, 0);
  assert.equal(pool.candidates[1].source, GATEWAY_SOURCE.PERSISTENT);
  assert.equal(pool.candidates[1].sourcePriority, 1);
  assert.equal(built.stats.gatewayDuplicateFoldedRows, 2);
  assert.equal(built.warnings.filter((item) => item.code === 'pre-fund-gateway-complete-duplicate-folded').length, 2);
  assert.equal(built.duplicateGroups.length, 1);
  assert.equal(built.duplicateGroups[0].keptCandidate.source, GATEWAY_SOURCE.TEMPORARY);
  assert.equal(built.duplicateGroups[0].foldedCandidates.length, 2);
});

test('原始业务JSON只取MPT rawJson或持久entry.row，不混入包装层元数据', () => {
  const mptRawJson = '{"source":"mpt","emoji":"😀"}';
  const mptCandidate = normalizeGatewayCandidate(
    { ...gateway(), rawJson: mptRawJson, sourceFileName: 'mpt.gz', id: 999 },
    GATEWAY_SOURCE.TEMPORARY,
    0
  );
  assert.equal(mptCandidate.rawJson, mptRawJson);

  const persistentRow = gateway({ reconciliationId: 'P-1', amount: '2' });
  const persistentRawJson = '{ "reconciliationId": "P-1", "amount": "2" }';
  const persistentCandidate = normalizeGatewayCandidate({
    id: 88,
    reconciliationId: 'P-1',
    billDate: '2026-07-01',
    reconBillBizId: 'B-1',
    rawJson: persistentRawJson,
    row: persistentRow
  }, GATEWAY_SOURCE.PERSISTENT, 0);
  assert.equal(persistentCandidate.rawJson, persistentRawJson);
  assert.equal(persistentCandidate.rawJson.includes('"id":88'), false);
  assert.equal(persistentCandidate.rawJson.includes('"billDate"'), false);
  assert.equal(persistentCandidate.location.sourceRecordId, 88);
});

test('两条银行同ID、一条网关：银行不去重，第一条平账、第二条右单边', () => {
  const result = reconcilePreFundRows({
    bankRows: [bank(' R-1 '), bank('R-1', { ChannelOrderNo: 'SECOND' })],
    bankContext: { fileName: 'bank.xlsx' },
    temporaryGatewayRows: [gateway()]
  });
  assert.equal(result.balancedPairs.length, 1);
  assert.equal(result.balancedPairs[0].bankRow.inputIndex, 0);
  assert.equal(result.unbalancedBankRows.length, 1);
  assert.equal(result.unbalancedBankRows[0].inputIndex, 1);
  assert.equal(result.stats.bankParticipatingRows, 2);
  assert.equal(result.stats.bankMatchedRows + result.stats.bankMissingGatewayRows, 2);
});

test('一条银行、同ID两条不同指纹网关：只消费稳定第一候选', () => {
  const result = reconcilePreFundRows({
    bankRows: [bank('R-1')],
    bankContext: { fileName: 'bank.xlsx' },
    temporaryGatewayRows: [gateway({ orderId: 'FIRST' }), gateway({ orderId: 'SECOND' })]
  });
  assert.equal(result.balancedPairs[0].gatewayRow.fields.orderId, 'FIRST');
  assert.equal(result.stats.gatewayUnconsumedRows, 1);
});

test('临时和持久来源同ID但不同指纹时临时候选先消费，来源内稳定', () => {
  const result = reconcilePreFundRows({
    bankRows: [bank('R-1'), bank('R-1'), bank('R-1')],
    bankContext: { fileName: 'bank.xlsx' },
    temporaryGatewayRows: [gateway({ orderId: 'T1' }), gateway({ orderId: 'T2' })],
    persistentGatewayRows: [gateway({ orderId: 'P1' })]
  });
  assert.deepEqual(
    result.balancedPairs.map((pair) => [pair.gatewayRow.source, pair.gatewayRow.fields.orderId]),
    [
      [GATEWAY_SOURCE.TEMPORARY, 'T1'],
      [GATEWAY_SOURCE.TEMPORARY, 'T2'],
      [GATEWAY_SOURCE.PERSISTENT, 'P1']
    ]
  );
});

test('匹配仅 trim 后精确且大小写敏感，不做子串兜底', () => {
  const result = reconcilePreFundRows({
    bankRows: [bank('abc'), bank('bc')],
    bankContext: { fileName: 'bank.xlsx' },
    temporaryGatewayRows: [gateway({ reconciliationId: 'ABC' }), gateway({ reconciliationId: 'xabcx' })]
  });
  assert.equal(result.balancedPairs.length, 0);
  assert.equal(result.unbalancedBankRows.length, 2);
});

test('只有对账ID、渠道、十进制金额和币种四项全部相同才平账', () => {
  const result = reconcilePreFundRows({
    bankRows: [
      bank(' R-OK ', { Channel: ' MPT ', Currency: ' USD ', 'Credit Amount': '1.000' }),
      bank('R-CHANNEL'),
      bank('R-AMOUNT'),
      bank('R-CURRENCY')
    ],
    bankContext: { fileName: 'bank.xlsx' },
    temporaryGatewayRows: [
      gateway({ reconciliationId: 'R-OK' }),
      gateway({ reconciliationId: 'R-CHANNEL', channel: 'mpt' }),
      gateway({ reconciliationId: 'R-AMOUNT', amount: '1.01' }),
      gateway({ reconciliationId: 'R-CURRENCY', currency: 'usd' })
    ]
  });
  assert.deepEqual(result.balancedPairs.map((pair) => pair.reconciliationId), ['R-OK']);
  assert.deepEqual(
    result.unbalancedBankRows.map((row) => row.reconciliationId),
    ['R-CHANNEL', 'R-AMOUNT', 'R-CURRENCY']
  );
  assert.equal(result.stats.gatewayUnconsumedRows, 3);
});

test('同ID前候选要素不符时不消费，后续完整匹配候选仍可平账', () => {
  const result = reconcilePreFundRows({
    bankRows: [bank('R-1')],
    bankContext: { fileName: 'bank.xlsx' },
    temporaryGatewayRows: [gateway({ orderId: 'TEMP-MISMATCH', amount: '2' })],
    persistentGatewayRows: [gateway({ orderId: 'PERSISTENT-EXACT', amount: '1.000' })]
  });
  assert.equal(result.balancedPairs.length, 1);
  assert.equal(result.balancedPairs[0].gatewayRow.source, GATEWAY_SOURCE.PERSISTENT);
  assert.equal(result.balancedPairs[0].gatewayRow.fields.orderId, 'PERSISTENT-EXACT');
  assert.equal(result.stats.gatewayUnconsumedRows, 1);
});

test('银行四字段条件与规范网关候选使用同一严格比较口径', () => {
  const classified = reconcilePreFundRows({
    bankRows: [bank('R-1', { Channel: ' MPT ', Currency: ' USD ', 'Credit Amount': '1e0' })],
    bankContext: { fileName: 'bank.xlsx' },
    temporaryGatewayRows: [gateway({ amount: '1.00' })]
  }).balancedPairs[0].bankRow;
  const criteria = buildBankMatchCriteria(classified);
  const candidate = normalizeGatewayCandidate(gateway(), GATEWAY_SOURCE.TEMPORARY, 0);
  assert.deepEqual(criteria, {
    reconciliationId: 'R-1',
    channel: 'MPT',
    amount: '1',
    currency: 'USD'
  });
  assert.equal(gatewayCandidateMatches(candidate, criteria), true);
  assert.equal(gatewayCandidateMatches(candidate, { ...criteria, currency: 'usd' }), false);
});

test('银行空ID/双零和网关空ID分类统计可见且不进入匹配结果', () => {
  const result = reconcilePreFundRows({
    bankRows: [
      bank('', { 'Credit Amount': 1 }),
      bank('ZERO', { 'Credit Amount': '', 'Debit Amount': '0.000' }),
      bank('R-1')
    ],
    bankContext: { fileName: 'bank.xlsx' },
    temporaryGatewayRows: [gateway({ reconciliationId: '' }), gateway()]
  });
  assert.equal(result.stats.bankEmptyReconciliationIdRows, 1);
  assert.equal(result.stats.bankZeroAmountRows, 1);
  assert.equal(result.stats.gatewayEmptyReconciliationIdRows, 1);
  assert.equal(result.stats.bankParticipatingRows, 1);
  assert.equal(result.balancedPairs.length, 1);
  assert.ok(result.warnings.some((item) => item.code === 'pre-fund-bank-empty-reconciliation-id'));
  assert.ok(result.warnings.some((item) => item.code === 'pre-fund-gateway-empty-reconciliation-id'));
});

test('网关空ID先排除，不因该无关行的日期或金额脏值阻断指纹构建', () => {
  const excluded = normalizeGatewayCandidate(
    gateway({ reconciliationId: '', date: '坏日期', amount: '坏金额' }),
    GATEWAY_SOURCE.TEMPORARY,
    0
  );
  assert.equal(excluded.reconciliationId, '');
  assert.equal(excluded.fingerprint, '');
  const result = reconcilePreFundRows({
    bankRows: [bank('R-1')],
    bankContext: { fileName: 'bank.xlsx' },
    temporaryGatewayRows: [
      gateway({ reconciliationId: '', date: '坏日期', amount: '坏金额' }),
      gateway()
    ]
  });
  assert.equal(result.balancedPairs.length, 1);
  assert.equal(result.stats.gatewayEmptyReconciliationIdRows, 1);
});

test('同一网关行同时存在别名字段时，空首选字段不会遮蔽后续非空规范字段', () => {
  const fields = normalizeGatewayFingerprintFields({
    ...gateway(),
    billReconId: '',
    ReconBillBizId: 'B-FALLBACK',
    amount: '',
    Amount: '3.00'
  });
  assert.equal(fields.billReconId, 'B-FALLBACK');
  assert.equal(fields.amount, '3');
});

test('持久网关游标 wrapper 的 envelope 字段和 raw row 正确合并规范化', () => {
  const wrapper = {
    id: 99,
    reconciliationId: ' WRAP-ID ',
    billDate: '2026/07/03',
    reconBillBizId: ' WRAP-BIZ ',
    row: {
      Bank: 'GW-CHANNEL',
      merchantid: 'M',
      OrderId: 'O',
      Currency: 'USD',
      Amount: '2.00',
      tradeType: 'PAY',
      '真实渠道': 'REAL',
      '清算网络': 'CLEAR'
    }
  };
  const normalized = normalizeGatewayFingerprintFields(wrapper);
  assert.deepEqual(normalized, {
    date: '2026-07-03',
    channel: 'GW-CHANNEL',
    merchantId: 'M',
    orderId: 'O',
    billReconId: 'WRAP-BIZ',
    currency: 'USD',
    amount: '2',
    tradeType: 'PAY',
    realChannel: 'REAL',
    clearingNetwork: 'CLEAR'
  });
  const result = reconcilePreFundRows({
    bankRows: [bank('WRAP-ID', { Channel: 'GW-CHANNEL', 'Credit Amount': '2' })],
    bankContext: { fileName: 'bank.xlsx' },
    persistentGatewayRows: [wrapper]
  });
  assert.equal(result.balancedPairs.length, 1);
  assert.equal(result.balancedPairs[0].gatewayRow.location.sourceRowNumber, 99);
});

test('网关联合池无非空ID数据时阻断运行，避免整表误报', () => {
  assert.throws(
    () => reconcilePreFundRows({
      bankRows: [bank('R-1')],
      temporaryGatewayRows: [gateway({ reconciliationId: '' })]
    }),
    (error) => error instanceof GatewayPoolEmptyError
      && error.code === 'pre-fund-gateway-pool-empty'
      && error.message.includes('请先导入或维护网关账单')
  );
});

test('双非零失败携带截至失败行的非法统计，运行不返回部分成功结果', () => {
  assert.throws(
    () => reconcilePreFundRows({
      bankRows: [
        bank('R-1'),
        bank('BAD', { 'Credit Amount': '1', 'Debit Amount': '2' })
      ],
      bankContext: { fileName: 'bad.xlsx' },
      temporaryGatewayRows: [gateway()]
    }),
    (error) => error.code === 'pre-fund-bank-both-amounts-nonzero'
      && error.stats.bankInvalidBothNonzeroRows === 1
      && error.excelRowNumber === 3
  );
});

test('side-DB adapter迭代路径不保留全量数组，仍保持临时优先、重复折叠和银行行守恒', () => {
  const candidates = new Map();
  const candidateOrder = [];
  const staged = stageGatewayCandidatesIterative({
    temporaryGatewayRows: [gateway({ orderId: 'T1' }), gateway({ orderId: 'T1', amount: '1.0' })],
    persistentGatewayRows: [gateway({ orderId: 'P1' })],
    insertCandidate(candidate) {
      const key = JSON.stringify([candidate.reconciliationId, candidate.fingerprint]);
      if (candidates.has(key)) return false;
      candidates.set(key, candidate);
      candidateOrder.push(candidate);
      return true;
    }
  });
  assert.equal(staged.stats.gatewayCandidateRows, 2);
  assert.equal(staged.stats.gatewayDuplicateFoldedRows, 1);

  const pools = new Map();
  for (const candidate of candidateOrder) {
    if (!pools.has(candidate.reconciliationId)) pools.set(candidate.reconciliationId, []);
    pools.get(candidate.reconciliationId).push(candidate);
  }
  const balanced = [];
  const unbalanced = [];
  const reconciled = reconcileBankRowsIterative({
    bankRows: [bank('R-1'), bank('R-1'), bank('R-1')],
    bankContext: { fileName: 'bank.xlsx' },
    stats: staged.stats,
    warnings: staged.warnings,
    consumeGatewayCandidate(criteria) {
      const pool = pools.get(criteria.reconciliationId) || [];
      const matchIndex = pool.findIndex((candidate) => gatewayCandidateMatches(candidate, criteria));
      return matchIndex >= 0 ? pool.splice(matchIndex, 1)[0] : null;
    },
    countUnconsumedGatewayRows() {
      return [...pools.values()].reduce((sum, pool) => sum + pool.length, 0);
    },
    onBalanced(pair) { balanced.push(pair); },
    onUnbalanced(row) { unbalanced.push(row); }
  });
  assert.deepEqual(
    balanced.map((pair) => [pair.gatewayRow.source, pair.gatewayRow.fields.orderId]),
    [
      [GATEWAY_SOURCE.TEMPORARY, 'T1'],
      [GATEWAY_SOURCE.PERSISTENT, 'P1']
    ]
  );
  assert.equal(unbalanced.length, 1);
  assert.equal(reconciled.stats.bankParticipatingRows, 3);
  assert.equal(reconciled.stats.bankMatchedRows + reconciled.stats.bankMissingGatewayRows, 3);
  assert.equal(reconciled.stats.gatewayUnconsumedRows, 0);
});
