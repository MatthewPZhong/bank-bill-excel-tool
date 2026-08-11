'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildArchiveEvidenceV2
} = require('../../../../src/backend/vcc-financial-op/archive-evidence');
const {
  createCurrentRawEvidence
} = require('./_archive-evidence-fixture');

function validationFor(rawEvidence) {
  return buildArchiveEvidenceV2(rawEvidence).resultValidations[0];
}

test('A-01 合法 current 调整重算 rowKey、revision、基础公式和九币种生效余额', () => {
  const validation = validationFor(createCurrentRawEvidence());
  assert.deepEqual(validation.violations, []);
  assert.equal(validation.baseRowCount, 1);
  assert.equal(validation.adjustmentCount, 1);
  assert.equal(validation.adjustmentSequenceMax, 1);
  assert.equal(validation.sequenceContinuous, true);
  assert.equal(validation.revisionMatchesAdjustmentCount, true);
  assert.equal(validation.adjustmentTargetsValid, true);
  assert.equal(validation.adjustmentMetadataValid, true);
  assert.equal(validation.baseBalanceFormulaValid, true);
  assert.equal(validation.currenciesComplete, true);
  assert.equal(validation.effectiveBalances.length, 9);
  const eur = validation.effectiveBalances.find((balance) => balance.currency === 'EUR');
  assert.deepEqual(eur, {
    runId: 7,
    subject: 'PPHK',
    currency: 'EUR',
    openingBalance: '100',
    basePeriodAmount: '0',
    baseCalculatedBalance: '100',
    baseDifference: '0',
    systemBalance: '100',
    adjustmentAmount: '5',
    effectivePeriodAmount: '5',
    effectiveCalculatedBalance: '105',
    effectiveDifference: '-5'
  });
});

test('A-02 TechDoc 明示的独立 result invariant 各用一个最小反例', async (t) => {
  const cases = [
    ['revision/count', 'result-revision-inconsistent', (raw) => { raw.runs[0].resultRevision = 2; }],
    ['sequence 断裂', 'adjustment-sequence-inconsistent', (raw) => { raw.runAdjustments[0].sequence = 2; }],
    ['rowKey 缺失', 'invalid-adjustment-target', (raw) => { raw.runAdjustments[0].rowKey = 'v1:missing'; }],
    ['基础行 metadata 缺失', 'invalid-run-row-metadata', (raw) => { raw.runRows[0].sourceType = null; }],
    ['metadata 错配', 'invalid-adjustment-metadata', (raw) => { raw.runAdjustments[0].subject = 'OTHER'; }],
    ['币种错配', 'invalid-adjustment-currency', (raw) => { raw.runAdjustments[0].currency = 'NZD'; }],
    ['基础余额公式', 'run-base-balance-mismatch', (raw) => {
      raw.storedRunBalances.find((balance) => balance.currency === 'USD').calculatedBalance = '109';
    }],
    ['九币种缺失', 'run-balance-currencies-incomplete', (raw) => {
      raw.storedRunBalances = raw.storedRunBalances.filter((balance) => balance.currency !== 'AUD');
    }]
  ];
  for (const [name, expectedViolation, mutate] of cases) {
    await t.test(name, () => {
      const raw = createCurrentRawEvidence();
      mutate(raw);
      assert.ok(validationFor(raw).violations.includes(expectedViolation));
    });
  }
});

test('A-03 evidence 数组输入顺序不影响稳定结果', () => {
  const left = createCurrentRawEvidence();
  const right = structuredClone(left);
  right.datasets.reverse();
  right.runRows.reverse();
  right.runAdjustments.reverse();
  right.storedRunBalances.reverse();
  assert.deepEqual(buildArchiveEvidenceV2(right), buildArchiveEvidenceV2(left));
});
