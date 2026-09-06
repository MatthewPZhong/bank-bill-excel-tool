'use strict';

const { performance } = require('node:perf_hooks');
const { fail } = require('./contracts');

const RECOVERY_LIMITS = Object.freeze({ sources: 4096, sourceBytes: 8 * 1024 * 1024,
  singleSourceBytes: 8192, decisionBytes: 8 * 1024 * 1024, evaluations: 32768,
  fullScans: 2, enumerations: 4, admissionMs: 60000, yieldEvery: 32 });

function createRecoveryBudget({ limits = RECOVERY_LIMITS, monotonicNow = () => performance.now() } = {}) {
  const started = monotonicNow();
  const counters = { fullScans: 0, enumerations: 0, evaluations: 0, inspector: 0, provider: 0, main: 0, normalized: 0 };
  let stopReason = null;
  function reject(code) { stopReason ||= code; fail(code); }
  function admit() {
    if (stopReason) fail(stopReason);
    if (monotonicNow() - started >= limits.admissionMs) reject('BIZOP_RECOVERY_DEADLINE');
  }
  function charge(kind) {
    admit();
    if (counters.evaluations >= limits.evaluations) reject('BIZOP_RECOVERY_WORK_LIMIT');
    counters.evaluations += 1;
    counters[kind] += 1;
  }
  function begin(kind) {
    admit();
    if (counters[kind] >= limits[kind]) reject('BIZOP_RECOVERY_ATTEMPT_LIMIT');
    counters[kind] += 1;
  }
  return Object.freeze({ limits, admit, charge, begin, reject,
    snapshot: () => Object.freeze({ ...counters, stopReason, elapsedMs: Math.ceil(monotonicNow() - started) }) });
}

module.exports = { RECOVERY_LIMITS, createRecoveryBudget };
