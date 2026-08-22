'use strict';

const CANARY_RESULT_KEYS = Object.freeze(['checksum', 'count', 'rounds', 'sum']);

function normalizeInput(input = {}) {
  const values = Array.isArray(input.values) ? input.values : [];
  if (values.length === 0 || values.length > 10000 ||
      values.some((value) => typeof value !== 'number' || !Number.isFinite(value))) {
    const error = new TypeError('pure-compute canary values must be a non-empty finite number array');
    error.code = 'CANARY_INPUT_INVALID';
    throw error;
  }
  const rounds = input.rounds === undefined ? 1 : input.rounds;
  if (!Number.isSafeInteger(rounds) || rounds < 1 || rounds > 1000000) {
    const error = new TypeError('pure-compute canary rounds must be an integer between 1 and 1000000');
    error.code = 'CANARY_INPUT_INVALID';
    throw error;
  }
  return { values: values.slice(), rounds };
}

function resultFor(input, checksum) {
  return {
    checksum,
    count: input.values.length,
    rounds: input.rounds,
    sum: input.values.reduce((total, value) => total + value, 0)
  };
}

async function executePureComputeCanary({ input, signal, reportProgress = () => {} }) {
  const normalized = normalizeInput(input);
  let checksum = 0;
  const chunkSize = Math.max(1, Math.min(1000, Math.ceil(normalized.rounds / 100)));
  const progressStep = Math.max(1, Math.ceil(normalized.rounds / 10));
  let nextProgressRound = progressStep;
  for (let start = 0; start < normalized.rounds; start += chunkSize) {
    if (signal && signal.aborted) {
      const error = new Error('pure-compute canary cancelled');
      error.code = 'CANARY_CANCELLED';
      throw error;
    }
    const end = Math.min(normalized.rounds, start + chunkSize);
    for (let round = start; round < end; round += 1) {
      for (let index = 0; index < normalized.values.length; index += 1) {
        checksum = (checksum + Math.trunc(normalized.values[index] * 1000) + round + index) % 2147483647;
      }
    }
    if (end >= nextProgressRound || end === normalized.rounds) {
      reportProgress({ completedRounds: end, totalRounds: normalized.rounds });
      while (nextProgressRound <= end) nextProgressRound += progressStep;
    }
    if (end < normalized.rounds) {
      await new Promise((resolve) => setImmediate(resolve));
    }
  }
  return resultFor(normalized, checksum);
}

function validatePureComputeCanaryResult(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value).sort();
  if (keys.length !== CANARY_RESULT_KEYS.length || keys.some((key, index) => key !== CANARY_RESULT_KEYS[index])) {
    return false;
  }
  return Number.isSafeInteger(value.checksum) && value.checksum >= 0 &&
    Number.isSafeInteger(value.count) && value.count > 0 &&
    Number.isSafeInteger(value.rounds) && value.rounds > 0 &&
    typeof value.sum === 'number' && Number.isFinite(value.sum);
}

module.exports = {
  CANARY_RESULT_KEYS,
  executePureComputeCanary,
  normalizeInput,
  validatePureComputeCanaryResult
};
