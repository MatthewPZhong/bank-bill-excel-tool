'use strict';

const {
  beginExternalParserShutdown,
  registerExternalParserFinalization,
  waitForExternalParserShutdownPhase
} = require('../background-execution/external-parser-finalization');

const DUPLICATE_PAIRED_PROFILE = Object.freeze({
  codePrefix: 'DUPLICATE_PAIRED',
  label: 'Duplicate paired Parser'
});

function assertDuplicateRuntime(runtime) {
  if (!runtime || (typeof runtime !== 'object' && typeof runtime !== 'function')) {
    throw new TypeError('Duplicate paired Parser shutdown runtime非法');
  }
}

function registerDuplicatePairedParserFinalization(runtime, descriptor) {
  assertDuplicateRuntime(runtime);
  return registerExternalParserFinalization(runtime, DUPLICATE_PAIRED_PROFILE, descriptor);
}

function beginDuplicatePairedParserShutdown(runtime) {
  assertDuplicateRuntime(runtime);
  return beginExternalParserShutdown(runtime);
}

function waitForDuplicatePairedParserShutdownPhase(session, phase, timeoutMs) {
  if (phase !== 'workersTerminal' && phase !== 'finalized') {
    throw new TypeError('Duplicate paired Parser shutdown phase非法');
  }
  return waitForExternalParserShutdownPhase(session, phase, timeoutMs);
}

module.exports = {
  beginDuplicatePairedParserShutdown,
  registerDuplicatePairedParserFinalization,
  waitForDuplicatePairedParserShutdownPhase
};
