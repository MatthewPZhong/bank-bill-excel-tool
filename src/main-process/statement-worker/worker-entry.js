'use strict';

const { parentPort, workerData } = require('node:worker_threads');
const fs = require('node:fs');
const path = require('node:path');

const { createStatementService } = require('./service');

if (!parentPort) throw new Error('Statement Service requires worker_threads parentPort');

let candidateOrdinal = 0;
let adoptionGrantOrdinal = 0;
const failBeforeAdoptOrdinal = workerData && workerData.statementFaultInjection
  ? workerData.statementFaultInjection.failBeforeAdoptOrdinal
  : null;
const withholdAdoptOrdinal = workerData && workerData.statementFaultInjection
  ? workerData.statementFaultInjection.withholdAdoptOrdinal
  : null;
const failAfterGrantOrdinal = workerData && workerData.statementFaultInjection
  ? workerData.statementFaultInjection.failAfterGrantOrdinal
  : null;
let statementSourceRoot = null;
if (workerData && typeof workerData.statementSourceRoot === 'string') {
  try {
    statementSourceRoot = path.resolve(fs.realpathSync(workerData.statementSourceRoot));
  } catch (_error) {
    statementSourceRoot = null;
  }
}

function resolveSourceResource(resourceId) {
  if (!statementSourceRoot || typeof resourceId !== 'string') return null;
  try {
    const requested = path.resolve(statementSourceRoot, resourceId);
    const resolved = path.resolve(fs.realpathSync(requested));
    const relative = path.relative(statementSourceRoot, resolved);
    if (relative === '' ||
        (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`))) {
      return Object.freeze({
        path: resolved,
        legacyPath: requested,
        allowedRoot: statementSourceRoot
      });
    }
  } catch (_error) {
    return null;
  }
  return null;
}

const service = createStatementService({
  postMessage(message) {
    parentPort.postMessage(message);
  },
  resolveSourceResource,
  close() {
    parentPort.close();
  },
  beforeAdopt() {
    candidateOrdinal += 1;
    if (Number.isSafeInteger(failBeforeAdoptOrdinal) && candidateOrdinal === failBeforeAdoptOrdinal) {
      const error = new Error('Injected Statement candidate adoption failure');
      error.code = 'STATEMENT_ADOPTION_FAILED';
      throw error;
    }
  },
  withholdAdopt() {
    adoptionGrantOrdinal += 1;
    if (Number.isSafeInteger(failAfterGrantOrdinal) &&
        adoptionGrantOrdinal === failAfterGrantOrdinal) {
      const error = new Error('Injected Statement post-grant adoption failure');
      error.code = 'STATEMENT_POST_GRANT_ADOPTION_FAILED';
      throw error;
    }
    return Number.isSafeInteger(withholdAdoptOrdinal) &&
      adoptionGrantOrdinal === withholdAdoptOrdinal;
  }
});

parentPort.on('message', (message) => service.handleMessage(message));
