'use strict';

const { performance } = require('node:perf_hooks');

const OUTCOMES = new Set(['success', 'failed', 'skipped']);

function sanitizeCounts(counts) {
  if (!counts || typeof counts !== 'object' || Array.isArray(counts)) return undefined;
  const safe = Object.fromEntries(Object.entries(counts).flatMap(([key, value]) => (
    /^[a-z][a-zA-Z0-9]*$/.test(key)
      && typeof value === 'number'
      && Number.isFinite(value)
      && value >= 0
      ? [[key, value]]
      : []
  )));
  return Object.keys(safe).length > 0 ? safe : undefined;
}

function startStartupPhase(phase, onRecord = null, now = () => performance.now()) {
  const normalizedPhase = String(phase || '').trim();
  if (!normalizedPhase) throw new TypeError('startup phase 不能为空');
  const emit = typeof onRecord === 'function' ? onRecord : () => undefined;
  const startedAt = now();
  let finished = false;
  emit(Object.freeze({ event: 'startup-phase', phase: normalizedPhase, state: 'start' }));

  return (outcome = 'success', options = {}) => {
    if (finished) return null;
    finished = true;
    if (!OUTCOMES.has(outcome)) throw new TypeError(`startup phase outcome 非法：${outcome}`);
    const durationMs = Math.max(0, Number(now()) - Number(startedAt));
    const counts = sanitizeCounts(options.counts);
    const record = {
      event: 'startup-phase',
      phase: normalizedPhase,
      state: 'end',
      outcome,
      durationMs: Number(durationMs.toFixed(3))
    };
    if (counts) record.counts = counts;
    if (outcome === 'failed') {
      record.code = String(options.error && options.error.code || 'STARTUP_PHASE_FAILED');
      record.message = '启动阶段失败';
    }
    emit(Object.freeze(record));
    return record;
  };
}

async function runStartupPhase(phase, operation, options = {}) {
  const finish = startStartupPhase(phase, options.onRecord, options.now);
  try {
    const result = await operation();
    const skipped = options.isSkipped && options.isSkipped(result);
    finish(skipped ? 'skipped' : 'success', {
      counts: options.counts ? options.counts(result) : undefined
    });
    return result;
  } catch (error) {
    finish('failed', { error });
    throw error;
  }
}

function runStartupPhaseSync(phase, operation, options = {}) {
  const finish = startStartupPhase(phase, options.onRecord, options.now);
  try {
    const result = operation();
    const skipped = options.isSkipped && options.isSkipped(result);
    finish(skipped ? 'skipped' : 'success', {
      counts: options.counts ? options.counts(result) : undefined
    });
    return result;
  } catch (error) {
    finish('failed', { error });
    throw error;
  }
}

module.exports = {
  runStartupPhase,
  runStartupPhaseSync,
  startStartupPhase
};
