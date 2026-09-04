'use strict';

const {
  estimateValueBytes,
  roundReservationBytes
} = require('../fund-recon-worker/state-footprint');
const { DUPLICATE_STATE_BUDGET_BYTES } = require('./policies');

function estimateDuplicateStateFootprint(state, options = {}) {
  const budgetBytes = options.budgetBytes ?? DUPLICATE_STATE_BUDGET_BYTES;
  const estimatedBytes = roundReservationBytes(estimateValueBytes(state) * 1.35);
  if (estimatedBytes > budgetBytes) {
    const error = new Error(`Duplicate state requires ${estimatedBytes} bytes, budget is ${budgetBytes}`);
    error.code = 'DUPLICATE_STATE_BUDGET_EXCEEDED';
    throw error;
  }
  return Object.freeze({ estimatedBytes, budgetBytes });
}

module.exports = { estimateDuplicateStateFootprint };
