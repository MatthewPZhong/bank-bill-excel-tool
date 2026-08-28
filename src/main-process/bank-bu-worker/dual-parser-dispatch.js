'use strict';

const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { Worker } = require('node:worker_threads');

const {
  failExecutionTransportForCoordinator
} = require('../background-execution/supervisor');
const {
  BANK_BU_DUAL_IMPORT_CONTRACT_VERSION,
  BANK_BU_INPUT_ROLES,
  normalizeDualImportDescriptor
} = require('./spool-contract');
const {
  cleanupBankBuSpool,
  cleanupBankBuSpoolParents
} = require('./spool-filesystem');
const {
  writeBankBuParserFailure,
  writeBankBuParserSuccess
} = require('./parser-outcome');
const { BANK_BU_SINGLETON_UNIT_ID } = require('./singleton-unit');

const PARSER_ENTRY = path.join(__dirname, 'parser-worker-entry.js');
const MIN_DUAL_IMPROVEMENT_RATIO = 0.15;

function managedError(code, message, details = null) {
  const error = new Error(message);
  error.code = code;
  if (details) error.details = details;
  return error;
}

function isDualParserGateApproved(value) {
  return Boolean(value && typeof value === 'object' && value.enabled === true &&
    Number.isFinite(value.measuredImprovementRatio) &&
    value.measuredImprovementRatio >= MIN_DUAL_IMPROVEMENT_RATIO &&
    Number.isSafeInteger(value.peakRssBytes) && value.peakRssBytes >= 0 &&
    Number.isSafeInteger(value.rssBudgetBytes) && value.rssBudgetBytes > 0 &&
    value.peakRssBytes <= value.rssBudgetBytes);
}

function normalizeOptions(options, { requireDual = true } = {}) {
  if (!options || !options.runtime || typeof options.runtime.execute !== 'function' ||
      typeof options.userDataDir !== 'string' || !path.isAbsolute(options.userDataDir) ||
      typeof options.yearMonth !== 'string' ||
      !options.operationContext || typeof options.operationContext !== 'object' ||
      typeof options.operationContext.operationKey !== 'string' ||
      !options.operationContext.operationKey ||
      typeof options.operationContext.taskRunId !== 'string' ||
      !options.operationContext.taskRunId ||
      (requireDual && (typeof options.runtime.start !== 'function' ||
        !options.workerRuntime || typeof options.workerRuntime !== 'object' ||
        typeof options.taskStagingDir !== 'string' || !path.isAbsolute(options.taskStagingDir) ||
        typeof options.pendingPath !== 'string' ||
        !path.isAbsolute(options.pendingPath) || typeof options.bankPath !== 'string' ||
        !path.isAbsolute(options.bankPath)))) {
    throw new TypeError('managed BankBU dual import参数非法');
  }
  if (options.production === true) {
    throw managedError('BANK_BU_DUAL_PRODUCTION_DISABLED', 'BankBU dual parser生产门禁固定关闭');
  }
  return options;
}

function runBankBuParserWorker(spool, options = {}) {
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
      if (typeof options.onWorkerState === 'function') {
        try { options.onWorkerState({ role: spool.role, exitCode: code, elapsedMs }); }
        catch (_error) { /* diagnostics cannot change lifecycle */ }
      }
      if (code !== 0) {
        finish(reject, managedError(
          'BANK_BU_PARSER_TRANSPORT_CRASH', `BankBU ${spool.role} Parser异常退出：${code}`
        ));
        return;
      }
      if (transportError) return finish(reject, transportError);
      if (!terminalMessage || terminalMessage.ok !== true) {
        const safe = terminalMessage && terminalMessage.error;
        finish(reject, managedError(
          safe && safe.code || 'BANK_BU_PARSER_FAILED',
          safe && safe.message || 'BankBU Parser失败'
        ));
        return;
      }
      const result = terminalMessage.result;
      const keys = [
        'fileName', 'jobId', 'role', 'rowCount', 'rssBytes', 'schemaVersion', 'yearMonth'
      ];
      if (!result || typeof result !== 'object' || Array.isArray(result) ||
          Object.keys(result).sort().join(',') !== keys.sort().join(',') ||
          result.schemaVersion !== 1 || result.jobId !== spool.jobId ||
          result.yearMonth !== spool.yearMonth || result.role !== spool.role ||
          !Object.values(BANK_BU_INPUT_ROLES).includes(result.role) ||
          typeof result.fileName !== 'string' || path.basename(result.fileName) !== result.fileName ||
          !Number.isSafeInteger(result.rowCount) || result.rowCount < 0 ||
          !Number.isSafeInteger(result.rssBytes) || result.rssBytes < 0) {
        finish(reject, managedError(
          'BANK_BU_PARSER_RESULT_IDENTITY_MISMATCH',
          'BankBU Parser结果identity或bounded manifest非法'
        ));
        return;
      }
      finish(resolve, Object.freeze({ ...result, elapsedMs }));
    });
  });
}

function createSpools(options, jobId) {
  return Object.freeze([
    Object.freeze({
      taskStagingDir: path.resolve(options.taskStagingDir),
      jobId,
      operationKey: options.operationContext.operationKey,
      producerTaskRunId: options.operationContext.taskRunId,
      yearMonth: options.yearMonth,
      role: BANK_BU_INPUT_ROLES.PENDING,
      source: Object.freeze({ filePath: path.resolve(options.pendingPath) })
    }),
    Object.freeze({
      taskStagingDir: path.resolve(options.taskStagingDir),
      jobId,
      operationKey: options.operationContext.operationKey,
      producerTaskRunId: options.operationContext.taskRunId,
      yearMonth: options.yearMonth,
      role: BANK_BU_INPUT_ROLES.BANK,
      source: Object.freeze({ filePath: path.resolve(options.bankPath) })
    })
  ]);
}

function cleanupSpools(spools, cleanup = cleanupBankBuSpool) {
  let failure = null;
  for (const spool of spools) {
    try {
      cleanup(spool);
      cleanupBankBuSpoolParents(spool);
    } catch (error) { failure ||= error; }
  }
  if (failure) throw failure;
}

function directRequest(options) {
  const input = {
    userDataDir: options.userDataDir,
    yearMonth: options.yearMonth,
    pendingPath: options.pendingPath,
    bankPath: options.bankPath,
    runtime: options.workerRuntime
  };
  return {
    actionKey: 'bank-bu:import-month',
    operationKey: options.operationContext.operationKey,
    production: false,
    context: { kind: 'operation', value: options.operationContext },
    input,
    units: Object.freeze([{ unitId: BANK_BU_SINGLETON_UNIT_ID, input }])
  };
}

async function executeManagedBankBuDualImport(rawOptions) {
  const options = normalizeOptions(rawOptions);
  const jobId = options.jobId || `bank-bu-dual-${randomUUID()}`;
  const spools = createSpools(options, jobId);
  const dualParserImport = normalizeDualImportDescriptor({
    contractVersion: BANK_BU_DUAL_IMPORT_CONTRACT_VERSION,
    spools
  });
  const writerInput = Object.freeze({
    userDataDir: options.userDataDir,
    yearMonth: options.yearMonth,
    runtime: options.workerRuntime,
    dualParserImport
  });
  const control = options.runtime.start({
    actionKey: 'bank-bu:import-month',
    operationKey: options.operationContext.operationKey,
    jobId,
    production: false,
    context: { kind: 'operation', value: options.operationContext },
    input: writerInput,
    units: Object.freeze([{ unitId: BANK_BU_SINGLETON_UNIT_ID, input: writerInput }])
  });
  const parserController = new AbortController();
  const outerSignal = options.signal || null;
  const abort = () => parserController.abort();
  if (outerSignal) {
    if (outerSignal.aborted) abort();
    else outerSignal.addEventListener('abort', abort, { once: true });
  }
  let parentTerminal = false;
  let failureOutcomePublished = false;
  try {
    await control.ready;
    const snapshot = control.snapshot();
    if (!snapshot || snapshot.state !== 'running') {
      await control.promise;
      parentTerminal = true;
      throw managedError('BANK_BU_DUAL_START_FAILED', 'BankBU dual Writer未进入running');
    }
    const parserCount = snapshot.topology && snapshot.topology.effectiveChildCount;
    if (![1, 2].includes(parserCount)) {
      throw managedError('BANK_BU_DUAL_TOPOLOGY_INVALID', 'BankBU dual topology非法');
    }
    const parserRunner = options.parserRunner || runBankBuParserWorker;
    let parserPhaseComplete = false;
    const parentWatcher = control.promise.then((execution) => {
      if (!parserPhaseComplete && (!execution || execution.outcome !== 'completed')) abort();
      return execution;
    });
    let nextIndex = 0;
    const results = new Array(2);
    let firstFailure = null;
    let failureSpool = null;
    async function parseNext() {
      while (nextIndex < spools.length) {
        const index = nextIndex;
        nextIndex += 1;
        try {
          const result = await parserRunner(spools[index], {
            signal: parserController.signal,
            ...(options.ParserWorkerClass ? { WorkerClass: options.ParserWorkerClass } : {}),
            ...(options.onParserWorkerState ? { onWorkerState: options.onParserWorkerState } : {})
          });
          writeBankBuParserSuccess(spools[index], result);
          results[index] = result;
          if (typeof options.onParserComplete === 'function') {
            try { options.onParserComplete(Object.freeze({
              role: result.role,
              rowCount: result.rowCount,
              elapsedMs: result.elapsedMs,
              rssBytes: result.rssBytes
            })); } catch (_error) { /* diagnostics cannot change lifecycle */ }
          }
        } catch (error) {
          if (!firstFailure) {
            firstFailure = error;
            failureSpool = spools[index];
          }
          abort();
          throw error;
        }
      }
    }
    const settled = await Promise.allSettled(
      Array.from({ length: parserCount }, () => parseNext())
    );
    parserPhaseComplete = true;
    const parserFailure = settled.find((item) => item.status === 'rejected');
    if (parserFailure) {
      try {
        writeBankBuParserFailure(failureSpool || spools[0], firstFailure || parserFailure.reason);
        failureOutcomePublished = true;
      } catch (publicationError) {
        const combined = new AggregateError(
          [firstFailure || parserFailure.reason, publicationError],
          'BankBU Parser terminal outcome无法发布'
        );
        combined.code = 'BANK_BU_PARSER_OUTCOME_PUBLISH_FAILED';
        failExecutionTransportForCoordinator(control, combined);
        throw combined;
      }
      await parentWatcher;
      parentTerminal = true;
      throw firstFailure || parserFailure.reason;
    }
    if (results[0].role !== BANK_BU_INPUT_ROLES.PENDING ||
        results[1].role !== BANK_BU_INPUT_ROLES.BANK) {
      throw managedError('BANK_BU_DUAL_ROLE_CONFLICT', 'BankBU dual Parser角色冲突');
    }
    const execution = await parentWatcher;
    parentTerminal = true;
    if (!execution || execution.outcome !== 'completed') {
      const error = managedError(
        execution && execution.error && execution.error.code || 'BANK_BU_DUAL_IMPORT_FAILED',
        execution && execution.error && execution.error.message || 'BankBU dual import失败'
      );
      error.execution = execution;
      throw error;
    }
    return Object.freeze({
      ...execution,
      dualParser: Object.freeze({
        effectiveWorkerCount: parserCount,
        completionOrderIndependent: true,
        peakRssBytes: Math.max(...results.map((result) => result.rssBytes)),
        parserElapsedMs: Object.freeze(results.map((result) => result.elapsedMs))
      })
    });
  } catch (error) {
    abort();
    if (!parentTerminal) {
      if (!failureOutcomePublished) {
        try {
          writeBankBuParserFailure(spools[0], error);
          failureOutcomePublished = true;
        } catch (publicationError) {
          const combined = new AggregateError(
            [error, publicationError], 'BankBU Parser terminal outcome无法发布'
          );
          combined.code = 'BANK_BU_PARSER_OUTCOME_PUBLISH_FAILED';
          failExecutionTransportForCoordinator(control, combined);
        }
      }
      await control.promise;
      parentTerminal = true;
    }
    throw error;
  } finally {
    if (outerSignal) outerSignal.removeEventListener('abort', abort);
    cleanupSpools(spools, options.cleanupSpool || cleanupBankBuSpool);
  }
}

async function executeBankBuImportWithOptionalDualParser(rawOptions) {
  const options = normalizeOptions(rawOptions, { requireDual: false });
  const hasTwoInputs = typeof options.pendingPath === 'string' &&
    path.isAbsolute(options.pendingPath) && typeof options.bankPath === 'string' &&
    path.isAbsolute(options.bankPath) &&
    path.resolve(options.pendingPath) !== path.resolve(options.bankPath);
  if (!hasTwoInputs || options.lowMemory === true ||
      !isDualParserGateApproved(options.dualParserGate)) {
    return options.runtime.execute(directRequest(options));
  }
  return executeManagedBankBuDualImport(options);
}

module.exports = {
  MIN_DUAL_IMPROVEMENT_RATIO,
  executeBankBuImportWithOptionalDualParser,
  executeManagedBankBuDualImport,
  isDualParserGateApproved,
  runBankBuParserWorker
};
