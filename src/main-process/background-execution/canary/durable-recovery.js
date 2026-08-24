'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { Worker } = require('node:worker_threads');
const { canonicalSha256, canonicalizeJson } = require('../canonical-json-v1');
const { writeFileAtomicDurable } = require('../durable-file');
const { normalizeRecoverySource } = require('../recovery-source');
const { ensureCanaryReceiptSchema } = require('./canary-schema');

const CANARY_ACTION_KEY = 'background-execution:canary';
const CANARY_INSPECTOR_KEY = 'inspector.background-execution:canary';
const CANARY_SETTLEMENT_KEY = 'settlement.background-execution:canary';
const WORKER_PATH = path.join(__dirname, 'durable-worker.js');

function runWorkerDurableCanary(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('worker durable canary input 必须是对象');
  }
  return new Promise((resolve, reject) => {
    let message = null;
    const worker = new Worker(WORKER_PATH, { workerData: input });
    worker.once('message', (value) => { message = value; });
    worker.once('error', reject);
    worker.once('exit', (code) => {
      if (code === 0) resolve(Object.freeze({ status: 'completed', receipt: message }));
      else if (input.crashAfterCommit === true && code === 91) {
        resolve(Object.freeze({ status: 'crashed-after-commit', exitCode: code }));
      } else {
        const error = new Error(`canary worker exit ${code}`);
        error.code = 'CANARY_WORKER_EXIT';
        reject(error);
      }
    });
  });
}

function createCanaryReceiptInspector(db) {
  if (!db || typeof db.prepare !== 'function') throw new TypeError('canary inspector 需要 DatabaseSync');
  return async function inspectCanaryReceipt(sourceInput) {
    const source = normalizeRecoverySource(sourceInput);
    const row = db.prepare(`
      SELECT operation_key, value, committed_at
      FROM background_execution_canary_receipts
      WHERE operation_key = ?
    `).get(source.operationKey);
    let outcome;
    let boundedEvidence;
    if (!row) {
      outcome = 'not-committed';
      boundedEvidence = { receiptPresent: false };
    } else if (source.boundedEvidence.expectedValue === row.value) {
      outcome = 'committed';
      boundedEvidence = { receiptPresent: true, valueMatches: true };
    } else {
      outcome = 'unknown';
      boundedEvidence = { receiptPresent: true, valueMatches: false };
    }
    return Object.freeze({
      contractVersion: 1,
      sourceKind: source.sourceKind,
      sourceRef: source.sourceRef,
      actionKey: source.actionKey,
      operationKey: source.operationKey,
      taskRunId: source.taskRunId,
      outcome,
      evidenceVersion: 1,
      evidenceHash: canonicalSha256(boundedEvidence),
      boundedEvidence
    });
  };
}

function createCanaryPostImageInspector(options = {}) {
  if (typeof options.resolveTargetPath !== 'function') {
    throw new TypeError('post-image inspector 需要 resolveTargetPath');
  }
  return async function inspectCanaryPostImage(sourceInput) {
    const source = normalizeRecoverySource(sourceInput);
    const targetPath = options.resolveTargetPath(source);
    let actualHash = null;
    if (fs.existsSync(targetPath)) {
      actualHash = createHash('sha256').update(fs.readFileSync(targetPath)).digest('hex');
    }
    const expectedPostHash = source.boundedEvidence.expectedPostHash;
    const expectedPreHash = source.boundedEvidence.expectedPreHash ?? null;
    const outcome = actualHash === expectedPostHash
      ? 'committed'
      : actualHash === expectedPreHash
        ? 'not-committed'
        : 'unknown';
    const boundedEvidence = {
      targetPresent: actualHash !== null,
      matchesExpectedPost: actualHash === expectedPostHash,
      matchesExpectedPre: actualHash === expectedPreHash
    };
    return Object.freeze({
      contractVersion: 1,
      sourceKind: source.sourceKind,
      sourceRef: source.sourceRef,
      actionKey: source.actionKey,
      operationKey: source.operationKey,
      taskRunId: source.taskRunId,
      outcome,
      evidenceVersion: 1,
      evidenceHash: canonicalSha256(boundedEvidence),
      boundedEvidence
    });
  };
}

function writeCanaryTargetPostImage(targetPath, content, options = {}) {
  return writeFileAtomicDurable(targetPath, content, options);
}

function canarySource(input) {
  if (input.settlementKey !== CANARY_SETTLEMENT_KEY) {
    throw new TypeError('canary provider settlementKey 必须匹配 canonical static key');
  }
  return normalizeRecoverySource({
    contractVersion: 1,
    sourceKind: input.sourceKind,
    sourceRef: input.sourceRef,
    actionKey: CANARY_ACTION_KEY,
    operationKey: input.operationKey,
    taskRunId: input.taskRunId,
    conflictScopeKey: input.conflictScopeKey,
    inspectorKey: CANARY_INSPECTOR_KEY,
    settlementKey: input.settlementKey,
    intentId: input.intentId,
    evidenceVersion: 1,
    boundedEvidence: input.boundedEvidence
  });
}

function createCanarySettlementProvider(options = {}) {
  const journalDirectory = options.journalDirectory;
  if (typeof journalDirectory !== 'string' || journalDirectory.length === 0) {
    throw new TypeError('canary provider 需要 journalDirectory');
  }
  const resultDirectory = path.join(journalDirectory, 'settled');

  function journalPath(sourceRef) {
    return path.join(journalDirectory, `${canonicalSha256(sourceRef)}.json`);
  }

  return Object.freeze({
    prepare(sourceInput) {
      const source = canarySource(sourceInput);
      fs.mkdirSync(journalDirectory, { recursive: true });
      const result = writeFileAtomicDurable(
        journalPath(source.sourceRef),
        canonicalizeJson({ state: 'prepared', source })
      );
      return Object.freeze({ source, durability: result });
    },

    async listOpenSources() {
      if (!fs.existsSync(journalDirectory)) return Object.freeze([]);
      const sources = [];
      for (const name of fs.readdirSync(journalDirectory).sort()) {
        if (!name.endsWith('.json')) continue;
        const record = JSON.parse(fs.readFileSync(path.join(journalDirectory, name), 'utf8'));
        if (!record || !['prepared', 'settled'].includes(record.state)) {
          throw Object.assign(new Error('canary journal state 非法'), {
            code: 'CANARY_JOURNAL_STATE_INVALID'
          });
        }
        if (record.state === 'prepared') sources.push(normalizeRecoverySource(record.source));
      }
      return Object.freeze(sources);
    },

    async recover(sourceInput, inspection) {
      const source = normalizeRecoverySource(sourceInput);
      if (source.settlementKey !== CANARY_SETTLEMENT_KEY) {
        throw Object.assign(new Error('canary provider 收到其他 settlementKey'), {
          code: 'CANARY_SETTLEMENT_KEY_MISMATCH'
        });
      }
      const boundedResult = inspection.outcome === 'committed'
        ? { receipt: `canary:${source.operationKey}` }
        : { disposition: 'kept-open' };
      if (inspection.outcome === 'committed') {
        fs.mkdirSync(resultDirectory, { recursive: true });
        const target = path.join(resultDirectory, `${canonicalSha256(source.sourceRef)}.json`);
        const durability = writeFileAtomicDurable(target, canonicalizeJson(boundedResult));
        if (durability.status !== 'committed') {
          return Object.freeze({
            contractVersion: 1,
            sourceKind: source.sourceKind,
            sourceRef: source.sourceRef,
            actionKey: source.actionKey,
            operationKey: source.operationKey,
            taskRunId: source.taskRunId,
            settlementKey: CANARY_SETTLEMENT_KEY,
            inspectionEvidenceHash: inspection.evidenceHash,
            outcome: 'terminal-failure',
            resultVersion: 1,
            resultHash: canonicalSha256(boundedResult),
            boundedResult,
            safeError: {
              code: 'DURABILITY_BARRIER_UNAVAILABLE',
              message: 'directory fsync capability unavailable'
            },
            retryAfterMs: null
          });
        }
        const journal = journalPath(source.sourceRef);
        const settledRecord = { state: 'settled', source, boundedResult };
        const journalResult = writeFileAtomicDurable(journal, canonicalizeJson(settledRecord));
        if (journalResult.status !== 'committed') {
          throw Object.assign(new Error('canary journal close durability unavailable'), {
            code: 'DURABILITY_BARRIER_UNAVAILABLE'
          });
        }
      }
      return Object.freeze({
        contractVersion: 1,
        sourceKind: source.sourceKind,
        sourceRef: source.sourceRef,
        actionKey: source.actionKey,
        operationKey: source.operationKey,
        taskRunId: source.taskRunId,
        settlementKey: CANARY_SETTLEMENT_KEY,
        inspectionEvidenceHash: inspection.evidenceHash,
        outcome: inspection.outcome === 'committed' ? 'completed' : 'incomplete',
        resultVersion: 1,
        resultHash: canonicalSha256(boundedResult),
        boundedResult,
        safeError: null,
        retryAfterMs: null
      });
    }
  });
}

module.exports = {
  CANARY_ACTION_KEY,
  CANARY_INSPECTOR_KEY,
  CANARY_SETTLEMENT_KEY,
  createCanaryReceiptInspector,
  createCanaryPostImageInspector,
  createCanarySettlementProvider,
  ensureCanaryReceiptSchema,
  runWorkerDurableCanary,
  writeCanaryTargetPostImage
};
