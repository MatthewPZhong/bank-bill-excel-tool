'use strict';

const { parentPort, workerData } = require('node:worker_threads');
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
const statementSourceRoot = workerData && typeof workerData.statementSourceRoot === 'string'
  ? path.resolve(workerData.statementSourceRoot)
  : null;

function resolveSourceResource(resourceId) {
  if (!statementSourceRoot || typeof resourceId !== 'string') return null;
  const resolved = path.resolve(statementSourceRoot, resourceId);
  if (resolved !== statementSourceRoot && !resolved.startsWith(`${statementSourceRoot}${path.sep}`)) {
    return null;
  }
  return resolved;
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
    return Number.isSafeInteger(withholdAdoptOrdinal) &&
      adoptionGrantOrdinal === withholdAdoptOrdinal;
  }
});

parentPort.on('message', (message) => service.handleMessage(message));
