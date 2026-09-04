'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  FUND_RECON_STATE_BUDGET_BYTES
} = require('../../../src/main-process/fund-recon-worker/policies');
const {
  estimateFundReconStateFootprint,
  estimateValueBytes,
  roundReservationBytes
} = require('../../../src/main-process/fund-recon-worker/state-footprint');

test('state footprint按共享引用去重、页对齐并保留35% headroom', () => {
  const shared = { value: 'x'.repeat(64) };
  const state = { rows: [shared, shared], result: shared };
  const rawBytes = estimateValueBytes(state);
  const footprint = estimateFundReconStateFootprint(state);
  assert.equal(footprint.estimatedBytes, roundReservationBytes(rawBytes * 1.35));
  assert.equal(footprint.estimatedBytes % 4096, 0);
  assert.equal(footprint.budgetBytes, FUND_RECON_STATE_BUDGET_BYTES);
});

test('超过PersistentReservation预算时在adoption前稳定拒绝', () => {
  assert.throws(
    () => estimateFundReconStateFootprint({ payload: 'x'.repeat(8192) }, { budgetBytes: 4096 }),
    (error) => error.code === 'FUND_RECON_STATE_BUDGET_EXCEEDED' &&
      error.details.estimatedBytes > error.details.budgetBytes
  );
});

test('连续十轮替换只估算当前stable graph，不累加历史state', () => {
  let peak = 0;
  let previous = null;
  for (let revision = 1; revision <= 10; revision += 1) {
    const current = {
      bankSession: { rows: Array.from({ length: 100 }, (_, index) => ({ index, amount: index })) },
      gatewaySession: null,
      refundSession: null,
      processingResult: { rows: Array.from({ length: 100 }, (_, index) => ({ index, revision })) },
      stateRevision: revision
    };
    const footprint = estimateFundReconStateFootprint(current);
    peak = Math.max(peak, footprint.estimatedBytes);
    if (previous !== null) assert.equal(footprint.estimatedBytes, previous);
    previous = footprint.estimatedBytes;
  }
  assert.ok(peak < FUND_RECON_STATE_BUDGET_BYTES);
});
