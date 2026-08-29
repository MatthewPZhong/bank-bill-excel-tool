'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { createDuplicateInboundMatchService } = require('./service');
const { createDuplicateMirrorDatabase } = require('./mirror-database');
const { DUPLICATE_ACTIONS } = require('./policies');
const { createDuplicateManagedStartupGate } = require('./startup-gate');
const { estimateDuplicateStateFootprint } = require('./state-footprint');

class DuplicateManagedServiceError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'DuplicateManagedServiceError';
    this.code = code;
  }
}

function emptySummary() {
  return Object.freeze({ bankRowCount: 0, documentRowCount: 0, canRun: false, canExport: false });
}

function summaryFromService(service) {
  if (!service || typeof service.status !== 'function') {
    throw new DuplicateManagedServiceError(
      'DUPLICATE_STATUS_UNAVAILABLE',
      'Duplicate Service缺少真实status资格'
    );
  }
  const status = service.status();
  return Object.freeze({
    bankRowCount: status && status.bank ? Number(status.bank.rowCount) || 0 : 0,
    documentRowCount: status && status.document ? Number(status.document.rowCount) || 0 : 0,
    canRun: Boolean(status && status.canRun === true),
    canExport: Boolean(status && status.canExport === true)
  });
}

function requirePlainObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw new DuplicateManagedServiceError('DUPLICATE_INPUT_INVALID', `${label}必须是plain object`);
  }
  return value;
}

function runtimeIdentity(raw) {
  const value = requirePlainObject(raw, 'runtime');
  const fields = ['userDataDir', 'databasePath', 'mailTemplatePath', 'bankTemplatePath'];
  const result = {};
  for (const field of fields) {
    if (typeof value[field] !== 'string' || value[field].trim().length === 0) {
      throw new DuplicateManagedServiceError('DUPLICATE_RUNTIME_INVALID', `runtime.${field}不能为空`);
    }
    result[field] = path.resolve(value[field]);
  }
  return Object.freeze(result);
}

function sameRuntime(left, right) {
  return left && Object.keys(left).every((key) => left[key] === right[key]);
}

function artifactFor(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    let byteSize = 0;
    const stream = fs.createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', (chunk) => {
      byteSize += chunk.length;
      hash.update(chunk);
    });
    stream.on('end', () => resolve(Object.freeze({
      artifactKey: 'duplicate-result',
      stagingPath: path.resolve(filePath),
      byteSize,
      sha256: hash.digest('hex')
    })));
  });
}

function createDuplicateManagedService(options = {}) {
  const createMirrorDatabase = options.createMirrorDatabase || createDuplicateMirrorDatabase;
  const createLegacyService = options.createLegacyService || createDuplicateInboundMatchService;
  const estimateFootprint = options.estimateFootprint || estimateDuplicateStateFootprint;
  const startupGate = options.startupGate || createDuplicateManagedStartupGate(
    options.startupGateDescriptor
  );
  if (!startupGate || typeof startupGate.assertOperationAllowed !== 'function') {
    throw new TypeError('Duplicate managed Service需要startupGate');
  }
  let service = null;
  let mirrorDatabase = null;
  let runtime = null;
  let stateRevision = 0;
  let stableSummary = emptySummary();
  let active = false;
  let closed = false;

  function assertOpen() {
    if (closed) throw new DuplicateManagedServiceError('DUPLICATE_SERVICE_CLOSED', 'Duplicate Service已关闭');
  }

  function ensureService(input) {
    const next = runtimeIdentity(input.runtime);
    if (runtime && !sameRuntime(runtime, next)) {
      throw new DuplicateManagedServiceError('DUPLICATE_RUNTIME_CHANGED', 'Duplicate Service runtime身份不可变');
    }
    startupGate.assertOperationAllowed(next, { initializing: !service });
    if (!service) {
      runtime = next;
      mirrorDatabase = createMirrorDatabase(runtime.databasePath);
      service = createLegacyService({
        userDataDir: runtime.userDataDir,
        database: mirrorDatabase,
        mailTemplatePath: runtime.mailTemplatePath,
        bankTemplatePath: runtime.bankTemplatePath
      });
    }
    return service;
  }

  function refreshStableSummary() {
    if (service) stableSummary = summaryFromService(service);
    return stableSummary;
  }

  async function adopt(jobContext, operation) {
    if (!jobContext || typeof jobContext.adoptCandidate !== 'function') {
      throw new DuplicateManagedServiceError(
        'DUPLICATE_ADOPTION_REQUIRED',
        'Duplicate mutation必须等待PersistentReservation adopt ACK'
      );
    }
    // candidate在ACK前只能作为adoption payload存在，不能写入对外稳定快照。
    const candidateSummary = summaryFromService(service);
    const candidateRevision = stateRevision + 1;
    const footprint = estimateFootprint({ runtime, summary: candidateSummary });
    await jobContext.adoptCandidate({ summary: candidateSummary }, {
      candidateRevision,
      memoryBytes: footprint.estimatedBytes,
      operation
    });
    stateRevision = candidateRevision;
    stableSummary = candidateSummary;
  }

  function compact(operation, extra = {}) {
    return Object.freeze({
      status: 'ok',
      operation,
      stateRevision,
      summary: stableSummary,
      ...extra
    });
  }

  async function executeImport(input, jobContext) {
    const current = ensureService(input);
    stateRevision += 1;
    stableSummary = emptySummary();
    let imported = false;
    let durableCommit = false;
    try {
      const result = await current.importFiles(
        input.filePaths, jobContext.onProgress, jobContext.operationIdentity
      );
      imported = true;
      durableCommit = Boolean(result && result.durableCommit);
      await adopt(jobContext, 'import');
      return compact('import');
    } catch (error) {
      if (imported) {
        try {
          if (durableCommit && typeof current.detachCommittedSession === 'function') {
            current.detachCommittedSession();
          } else {
            current.invalidateForNewImport();
          }
        } catch (_cleanupError) { /* 原错误优先 */ }
      }
      throw error;
    }
  }

  async function executeRun(input, jobContext) {
    const current = ensureService(input);
    stateRevision += 1;
    stableSummary = Object.freeze({ ...summaryFromService(current), canExport: false });
    let completed = false;
    let durableCommit = false;
    try {
      const result = await current.run({
        onProgress: jobContext.onProgress,
        operationIdentity: jobContext.operationIdentity
      });
      completed = true;
      durableCommit = Boolean(result && result.durableCommit);
      await adopt(jobContext, 'run');
      return compact('run', { runId: Number(result.runId) });
    } catch (error) {
      if (completed) {
        try {
          if (durableCommit && typeof current.detachCommittedRun === 'function') {
            current.detachCommittedRun();
          } else {
            current.clearPreviousRun();
          }
        } catch (_cleanupError) { /* 原错误优先 */ }
      }
      throw error;
    }
  }

  async function executeExport(input, jobContext) {
    const current = ensureService(input);
    const savePath = typeof input.savePath === 'string' && input.savePath.length > 0
      ? path.resolve(input.savePath)
      : null;
    if (!savePath) {
      throw new DuplicateManagedServiceError('DUPLICATE_EXPORT_PATH_REQUIRED', 'Duplicate export需要savePath');
    }
    await current.export({ savePath, onProgress: jobContext.onProgress });
    return compact('export', { artifacts: Object.freeze([await artifactFor(savePath)]) });
  }

  async function execute(actionKey, rawInput, jobContext = {}) {
    assertOpen();
    if (active) throw new DuplicateManagedServiceError('SERVICE_BUSY', 'Duplicate Service正在执行另一条命令');
    const input = requirePlainObject(rawInput, 'input');
    active = true;
    try {
      if (jobContext.signal && jobContext.signal.aborted) {
        throw new DuplicateManagedServiceError('DUPLICATE_SHUTDOWN', 'Duplicate Service正在关闭');
      }
      if (actionKey === DUPLICATE_ACTIONS.IMPORT) return await executeImport(input, jobContext);
      if (actionKey === DUPLICATE_ACTIONS.RUN) return await executeRun(input, jobContext);
      if (actionKey === DUPLICATE_ACTIONS.EXPORT) return await executeExport(input, jobContext);
      throw new DuplicateManagedServiceError('DUPLICATE_ACTION_UNKNOWN', `未知Duplicate action：${actionKey}`);
    } finally {
      refreshStableSummary();
      active = false;
    }
  }

  return Object.freeze({
    execute,
    status() {
      return Object.freeze({
        active,
        closed,
        stateRevision,
        // Legacy Service会在PersistentReservation adopt ACK前先持有candidate。
        // managed边界在命令active期间只发布最后一个稳定快照，避免绕过adopt。
        stableSummary: active ? stableSummary : refreshStableSummary()
      });
    },
    close() {
      if (active) throw new DuplicateManagedServiceError('SERVICE_BUSY', 'Duplicate Service仍在执行命令');
      if (closed) return;
      closed = true;
      if (mirrorDatabase) mirrorDatabase.close();
      service = null;
      mirrorDatabase = null;
      runtime = null;
      stableSummary = emptySummary();
    }
  });
}

module.exports = {
  DuplicateManagedServiceError,
  createDuplicateManagedService,
  emptySummary,
  runtimeIdentity,
  summaryFromService
};
