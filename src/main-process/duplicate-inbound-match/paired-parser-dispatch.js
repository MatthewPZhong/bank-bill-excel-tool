'use strict';

const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { Worker } = require('node:worker_threads');

const {
  DUPLICATE_INPUT_ROLES,
  DUPLICATE_PAIRED_IMPORT_CONTRACT_VERSION,
  deriveSlotIdentity,
  normalizePairedImportDescriptor
} = require('./spool-contract');
const {
  cleanupDuplicateSpool,
  cleanupDuplicateSpoolParents
} = require('./spool-filesystem');
const {
  writeDuplicateParserFailure,
  writeDuplicateParserSuccess
} = require('./parser-outcome');

const PARSER_ENTRY = path.join(__dirname, 'parser-worker-entry.js');
const MIN_PAIRED_IMPROVEMENT_RATIO = 0.15;

function managedError(code, message, details = null) {
  const error = new Error(message);
  error.code = code;
  if (details) error.details = details;
  return error;
}

function isPairedParserGateApproved(value) {
  return Boolean(value && typeof value === 'object' && value.enabled === true &&
    Number.isFinite(value.measuredImprovementRatio) &&
    value.measuredImprovementRatio >= MIN_PAIRED_IMPROVEMENT_RATIO &&
    Number.isSafeInteger(value.peakRssBytes) && value.peakRssBytes >= 0 &&
    Number.isSafeInteger(value.rssBudgetBytes) && value.rssBudgetBytes > 0 &&
    value.peakRssBytes <= value.rssBudgetBytes);
}

function normalizeOptions(options, { requirePair = true } = {}) {
  if (!options || !options.runtime || typeof options.runtime.start !== 'function' ||
      typeof options.runtime.execute !== 'function' ||
      !Array.isArray(options.filePaths) || options.filePaths.length < 1 ||
      (requirePair && options.filePaths.length !== 2) ||
      options.filePaths.some((filePath) => typeof filePath !== 'string' || !path.isAbsolute(filePath)) ||
      !options.workerRuntime || typeof options.workerRuntime !== 'object' ||
      typeof options.taskStagingDir !== 'string' || !path.isAbsolute(options.taskStagingDir) ||
      !options.batchContext || typeof options.batchContext !== 'object' ||
      typeof options.batchContext.operationKey !== 'string' || !options.batchContext.operationKey ||
      typeof options.batchContext.taskRunId !== 'string' || !options.batchContext.taskRunId) {
    throw new TypeError('managed Duplicate paired import参数非法');
  }
  if (options.production === true) {
    throw managedError(
      'DUPLICATE_PAIRED_PRODUCTION_DISABLED',
      'Duplicate paired parser生产门禁固定关闭'
    );
  }
  return options;
}

function runDuplicateParserWorker(spool, options = {}) {
  const WorkerClass = options.WorkerClass || Worker;
  return new Promise((resolve, reject) => {
    const worker = new WorkerClass(PARSER_ENTRY, { workerData: { spool } });
    const signal = options.signal || null;
    let terminalMessage = null;
    let transportError = null;
    let settled = false;
    let exited = false;
    let terminateTimer = null;
    const startedAt = process.hrtime.bigint();
    const observe = typeof options.onWorkerState === 'function' ? options.onWorkerState : null;
    const notify = (value) => {
      if (!observe) return;
      try { observe(Object.freeze(value)); } catch (_error) { /* diagnostics cannot change lifecycle */ }
    };
    notify({ state: 'started', slotIndex: spool.slotIndex });

    function abort() {
      if (settled || exited) return;
      try { worker.postMessage({ operation: 'cancel' }); } catch (error) { transportError ||= error; }
      terminateTimer = setTimeout(() => {
        if (settled || exited || typeof worker.terminate !== 'function') return;
        try { Promise.resolve(worker.terminate()).catch((error) => { transportError ||= error; }); }
        catch (error) { transportError ||= error; }
      }, options.terminateTimeoutMs || 5000);
      if (terminateTimer.unref) terminateTimer.unref();
    }

    function finish(callback, value) {
      if (settled) return;
      settled = true;
      if (terminateTimer) clearTimeout(terminateTimer);
      if (signal) signal.removeEventListener('abort', abort);
      callback(value);
    }

    if (signal) {
      if (signal.aborted) abort();
      else signal.addEventListener('abort', abort, { once: true });
    }
    worker.once('message', (message) => { terminalMessage = message; });
    worker.once('error', (error) => { transportError = error; });
    worker.once('exit', (code) => {
      exited = true;
      const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
      notify({ state: 'exited', slotIndex: spool.slotIndex, exitCode: code, elapsedMs });
      if (code !== 0) {
        finish(reject, managedError(
          'DUPLICATE_PARSER_TRANSPORT_CRASH',
          `Duplicate Parser Worker异常退出：${code}`
        ));
        return;
      }
      if (transportError) {
        finish(reject, transportError);
        return;
      }
      if (!terminalMessage || terminalMessage.ok !== true) {
        const safe = terminalMessage && terminalMessage.error;
        const error = managedError(
          safe && safe.code || 'DUPLICATE_PARSER_FAILED',
          safe && safe.message || 'Duplicate Parser Worker失败'
        );
        if (safe && Array.isArray(safe.detailLines)) error.detailLines = safe.detailLines.slice();
        finish(reject, error);
        return;
      }
      const result = terminalMessage.result;
      const resultKeys = [
        'fileName', 'jobId', 'role', 'rowCount', 'rssBytes', 'schemaVersion', 'slotIndex', 'unitId'
      ];
      if (!result || typeof result !== 'object' || Array.isArray(result) ||
          Object.keys(result).sort().join(',') !== resultKeys.sort().join(',') ||
          result.schemaVersion !== 1 || result.jobId !== spool.jobId ||
          result.slotIndex !== spool.slotIndex || result.unitId !== spool.unitId ||
          !Object.values(DUPLICATE_INPUT_ROLES).includes(result.role) ||
          typeof result.fileName !== 'string' || path.basename(result.fileName) !== result.fileName ||
          !Number.isSafeInteger(result.rowCount) || result.rowCount < 0 ||
          !Number.isSafeInteger(result.rssBytes) || result.rssBytes < 0) {
        finish(reject, managedError(
          'DUPLICATE_PARSER_RESULT_IDENTITY_MISMATCH',
          'Duplicate Parser结果identity或bounded manifest非法'
        ));
        return;
      }
      finish(resolve, Object.freeze({ ...result, elapsedMs }));
    });
  });
}

function createSpools(options, jobId) {
  return Object.freeze(options.filePaths.map((filePath, slotIndex) => {
    const identity = deriveSlotIdentity(slotIndex);
    return Object.freeze({
      taskStagingDir: path.resolve(options.taskStagingDir),
      jobId,
      operationKey: options.batchContext.operationKey,
      producerTaskRunId: options.batchContext.taskRunId,
      ...identity,
      source: Object.freeze({ filePath: path.resolve(filePath) })
    });
  }));
}

function cleanupSpools(spools, cleanup = cleanupDuplicateSpool) {
  let failure = null;
  for (const spool of spools) {
    try {
      cleanup(spool);
      cleanupDuplicateSpoolParents(spool);
    } catch (error) { failure ||= error; }
  }
  if (failure) throw failure;
}

async function executeManagedDuplicatePairedImport(rawOptions) {
  const options = normalizeOptions(rawOptions);
  const jobId = options.jobId || `duplicate-paired-${randomUUID()}`;
  const spools = createSpools(options, jobId);
  const pairedImport = normalizePairedImportDescriptor({
    contractVersion: DUPLICATE_PAIRED_IMPORT_CONTRACT_VERSION,
    spools
  });
  const control = options.runtime.start({
    actionKey: 'duplicate:import',
    operationKey: options.batchContext.operationKey,
    jobId,
    production: false,
    context: { kind: 'operation', value: options.batchContext },
    input: { runtime: options.workerRuntime, pairedImport },
    ...(typeof options.onProgress === 'function' ? { onProgress: options.onProgress } : {})
  });
  let parentTerminal = false;
  let primaryError = null;
  try {
    await control.ready;
    const snapshot = control.snapshot();
    if (!snapshot || snapshot.state !== 'running') {
      await control.promise;
      parentTerminal = true;
      throw managedError('DUPLICATE_PAIRED_START_FAILED', 'Duplicate paired Service未进入running');
    }
    const parserCount = snapshot.topology && snapshot.topology.effectiveChildCount;
    if (![1, 2].includes(parserCount)) {
      writeDuplicateParserFailure(spools[0], managedError(
        'DUPLICATE_PAIRED_TOPOLOGY_INVALID', 'Duplicate paired topology非法'
      ));
      await control.promise;
      parentTerminal = true;
      throw managedError('DUPLICATE_PAIRED_TOPOLOGY_INVALID', 'Duplicate paired topology非法');
    }

    const parserController = new AbortController();
    const parserRunner = options.parserRunner || runDuplicateParserWorker;
    let parserPhaseComplete = false;
    const parentWatcher = control.promise.then((execution) => {
      if (!parserPhaseComplete && (!execution || execution.outcome !== 'completed')) {
        parserController.abort();
      }
      return execution;
    });
    let nextSlot = 0;
    const results = new Array(2);
    async function parseNext() {
      while (nextSlot < spools.length) {
        const slotIndex = nextSlot;
        nextSlot += 1;
        try {
          const result = await parserRunner(spools[slotIndex], {
            signal: parserController.signal,
            ...(options.ParserWorkerClass ? { WorkerClass: options.ParserWorkerClass } : {}),
            ...(options.onParserWorkerState ? { onWorkerState: options.onParserWorkerState } : {})
          });
          // manifest-last只说明Parser业务写入完成；只有transport terminal + clean
          // Worker exit之后由coordinator发布success outcome，Service才可采用。
          writeDuplicateParserSuccess(spools[slotIndex], result);
          results[slotIndex] = result;
          if (typeof options.onParserComplete === 'function') {
            try {
              options.onParserComplete(Object.freeze({
                slotIndex,
                role: result.role,
                rowCount: result.rowCount,
                elapsedMs: result.elapsedMs,
                rssBytes: result.rssBytes
              }));
            } catch (_error) { /* diagnostics cannot change parser/service lifecycle */ }
          }
        } catch (error) {
          writeDuplicateParserFailure(spools[slotIndex], error);
          parserController.abort();
          throw error;
        }
      }
    }
    const parserTasks = Array.from({ length: parserCount }, () => parseNext());
    const settled = await Promise.allSettled(parserTasks);
    parserPhaseComplete = true;
    const parserFailure = settled.find((item) => item.status === 'rejected');
    if (parserFailure) {
      await parentWatcher;
      parentTerminal = true;
      throw parserFailure.reason;
    }
    const bankResults = results.filter((result) => result && result.role === DUPLICATE_INPUT_ROLES.BANK);
    const documentResults = results.filter(
      (result) => result && result.role === DUPLICATE_INPUT_ROLES.DOCUMENT
    );
    if (bankResults.length !== 1 || documentResults.length !== 1) {
      await parentWatcher;
      parentTerminal = true;
      throw managedError(
        'DUPLICATE_PAIRED_ROLE_CONFLICT',
        'Duplicate paired Parser必须形成唯一Bank/Document角色'
      );
    }
    // Parser完成顺序不参与业务顺序；Service只在两份ready manifest齐备后，
    // 由spool pair resolver固定按Bank→Document校验与采用。
    const execution = await parentWatcher;
    parentTerminal = true;
    if (!execution || execution.outcome !== 'completed') {
      const error = managedError(
        execution && execution.error && execution.error.code || 'DUPLICATE_PAIRED_IMPORT_FAILED',
        execution && execution.error && execution.error.message || 'Duplicate paired import失败'
      );
      error.execution = execution;
      throw error;
    }
    return Object.freeze({
      ...execution,
      pairedParser: Object.freeze({
        effectiveWorkerCount: parserCount,
        completionOrderIndependent: true,
        peakRssBytes: Math.max(...results.map((result) => result.rssBytes)),
        parserElapsedMs: Object.freeze(results.map((result) => result.elapsedMs))
      })
    });
  } catch (error) {
    primaryError = error;
    if (!parentTerminal) {
      try { writeDuplicateParserFailure(spools[0], error); } catch (_markerError) { /* barrier timeout wins */ }
      await control.promise;
      parentTerminal = true;
    }
    throw error;
  } finally {
    try { cleanupSpools(spools, options.cleanupSpool || cleanupDuplicateSpool); } catch (cleanupError) {
      if (primaryError) cleanupError.cause = primaryError;
      throw cleanupError;
    }
  }
}

async function executeDuplicateImportWithOptionalPairedParser(rawOptions) {
  const options = normalizeOptions(rawOptions, { requirePair: false });
  if (options.filePaths.length !== 2 || !isPairedParserGateApproved(options.pairedParserGate)) {
    return options.runtime.execute({
      actionKey: 'duplicate:import',
      operationKey: options.batchContext.operationKey,
      production: false,
      context: { kind: 'operation', value: options.batchContext },
      input: { runtime: options.workerRuntime, filePaths: options.filePaths }
    });
  }
  return executeManagedDuplicatePairedImport(options);
}

module.exports = {
  MIN_PAIRED_IMPROVEMENT_RATIO,
  executeDuplicateImportWithOptionalPairedParser,
  executeManagedDuplicatePairedImport,
  isPairedParserGateApproved,
  runDuplicateParserWorker
};
