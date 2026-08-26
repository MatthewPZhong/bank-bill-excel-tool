'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { Worker } = require('node:worker_threads');

const { sourceSnapshotFromStat } = require('../../archive-center/source-snapshot');
const { createOrderedMptCoordinator } = require('./ordered-coordinator');
const { toSafeParserFileResult, writeParserOutcome } = require('./parser-outcome');
const { deriveFileIdentity } = require('./spool-contract');
const { cleanupMptFileSpool, cleanupMptSpoolParents } = require('./spool-writer');

const PARSER_ENTRY = path.join(__dirname, 'parser-worker-entry.js');

function managedError(code, message) {
  return Object.assign(new Error(message), { code });
}

function parserFailure(filePath, error) {
  return toSafeParserFileResult(filePath, error);
}

function runParserWorker(input, options = {}) {
  const WorkerClass = options.WorkerClass || Worker;
  return new Promise((resolve, reject) => {
    const worker = new WorkerClass(PARSER_ENTRY, { workerData: { input } });
    let settled = false;
    let terminalMessage = null;
    let transportError = null;
    let cancelTimer = null;
    let workerExited = false;
    const signal = options.signal || null;
    const abort = () => {
      if (settled || workerExited) return;
      try { worker.postMessage({ operation: 'cancel' }); } catch (error) {
        transportError ||= error;
      }
      if (typeof worker.terminate === 'function') {
        cancelTimer = setTimeout(() => {
          if (settled || workerExited) return;
          try {
            Promise.resolve(worker.terminate()).catch((error) => { transportError ||= error; });
          } catch (error) { transportError ||= error; }
        }, 5000);
        if (cancelTimer.unref) cancelTimer.unref();
      }
    };
    if (signal) {
      if (signal.aborted) abort();
      else signal.addEventListener('abort', abort, { once: true });
    }
    function finish(callback, value) {
      if (settled) return;
      settled = true;
      if (cancelTimer) clearTimeout(cancelTimer);
      if (signal) signal.removeEventListener('abort', abort);
      callback(value);
    }
    worker.once('message', (message) => {
      terminalMessage = message;
    });
    worker.once('error', (error) => { transportError = error; });
    worker.once('exit', (code) => {
      workerExited = true;
      if (code !== 0) {
        finish(reject, managedError('PREFUND_PARSER_TRANSPORT_CRASH', `Parser Worker异常退出：${code}`));
        return;
      }
      if (transportError) {
        finish(reject, transportError);
        return;
      }
      const message = terminalMessage;
      if (!message || message.ok !== true) {
        const error = managedError(
          message && message.error && message.error.code || 'PREFUND_PARSER_WORKER_FAILED',
          message && message.error && message.error.message || 'MPT parser worker失败'
        );
        const safe = message && message.error;
        if (safe && Array.isArray(safe.detailLines)) error.detailLines = safe.detailLines.slice();
        if (safe && safe.cleanupRequired === true && safe.cleanupScope === 'current-file-spool') {
          error.cleanupRequired = true;
          error.cleanupScope = 'current-file-spool';
          if (typeof safe.causeCode === 'string') error.causeCode = safe.causeCode;
        }
        finish(reject, error);
        return;
      }
      const result = message.result;
      const identity = deriveFileIdentity(input.parentOperationKey, input.fileIndex);
      if (!result || result.fileIndex !== input.fileIndex ||
          result.fileOperationKey !== identity.fileOperationKey || result.unitId !== identity.unitId) {
        finish(reject, managedError('PREFUND_PARSER_RESULT_IDENTITY_MISMATCH', 'Parser结果identity不匹配'));
        return;
      }
      finish(resolve, result);
    });
  });
}

function normalizeOptions(options) {
  if (!options || !options.runtime || typeof options.runtime.start !== 'function' ||
      !Array.isArray(options.filePaths) || !options.filePaths.length ||
      !['pre-fund:mpt-import', 'pre-fund:mpt-repair-import'].includes(options.actionKey) ||
      !options.batchContext || typeof options.userDataDir !== 'string' ||
      typeof options.taskStagingDir !== 'string') {
    throw new TypeError('managed PreFund MPT import参数非法');
  }
  const repair = options.actionKey === 'pre-fund:mpt-repair-import';
  const repairFailures = repair ? options.repairFailures : null;
  if (repair && (!Array.isArray(repairFailures) || repairFailures.length === 0 ||
      repairFailures.length !== options.filePaths.length || repairFailures.some((failure, index) => (
        !failure || typeof failure !== 'object' ||
        typeof failure.failureId !== 'string' || !/^[a-f0-9-]{36}$/i.test(failure.failureId) ||
        typeof failure.filePath !== 'string' || !failure.filePath ||
        path.resolve(failure.filePath) !== path.resolve(options.filePaths[index]) ||
        !['MPT_INBOUND_GATEWAY', 'MPT_OUTBOUND_GATEWAY'].includes(failure.sourceType) ||
        typeof failure.sourceBatch !== 'string' || !failure.sourceBatch ||
        !/^[a-f0-9]{64}$/.test(failure.contentHash || '') ||
        !Number.isSafeInteger(failure.rowErrorCount) || failure.rowErrorCount < 1
      )))) {
    throw new TypeError('managed repair failures必须非空、与输入等长同序且identity合法');
  }
  if (!repair && options.repairFailures !== undefined && options.repairFailures !== null) {
    throw new TypeError('managed import不得携带repair expectedContentHash evidence');
  }
  if (!repair && options.expectedContentHash !== undefined && options.expectedContentHash !== '') {
    throw new TypeError('managed import不得携带expectedContentHash');
  }
  if (options.cleanupMainOwnedFile !== undefined &&
      typeof options.cleanupMainOwnedFile !== 'function') {
    throw new TypeError('managed cleanupMainOwnedFile必须是函数');
  }
  return { ...options, repairFailures };
}

async function executeManagedPreFundMptImport(rawOptions) {
  const options = normalizeOptions(rawOptions);
  const parentOperationKey = options.batchContext.operationKey;
  const jobId = `prefund-writer-${randomUUID()}`;
  if (options.actionKey === 'pre-fund:mpt-import' && options.service &&
      typeof options.service.beginManagedMptImport === 'function') {
    options.service.beginManagedMptImport();
  }
  const inputs = options.filePaths.map((filePath, fileIndex) => {
    const identity = deriveFileIdentity(parentOperationKey, fileIndex);
    const spool = {
      taskStagingDir: options.taskStagingDir,
      jobId,
      fileIndex,
      parentOperationKey,
      source: {
        filePath,
        sourceSnapshot: sourceSnapshotFromStat(fs.lstatSync(filePath, { bigint: true }))
      },
      invalidRowDisposition: options.actionKey === 'pre-fund:mpt-repair-import' ? 'excluded' : 'error'
    };
    return Object.freeze({
      kind: 'parser-outcome',
      fileIndex,
      ...identity,
      spool,
      datasetId: randomUUID(),
      expectedContentHash: options.repairFailures
        ? options.repairFailures[fileIndex].contentHash
        : ''
    });
  });
  const control = options.runtime.start({
    actionKey: options.actionKey,
    operationKey: parentOperationKey,
    jobId,
    input: {
      userDataDir: options.userDataDir,
      fileCount: inputs.length,
      parentOperationKey,
      producerTaskRunId: options.batchContext.taskRunId
    },
    context: { kind: 'file-batch', value: options.batchContext },
    units: inputs.map((input) => ({ unitId: input.unitId, input })),
    deferUnitStart: true,
    production: options.production === true,
    ...(typeof options.onProgress === 'function' ? { onProgress: options.onProgress } : {})
  });
  // job:start前Supervisor已经持有parent base/phase/compound child leases。
  // E05-B随后才派发唯一Parser Worker，资源申报与真实并发保持一致。
  await control.ready;
  const executionSignal = control.promise.then((execution) => ({ kind: 'execution', execution }));
  const writerOwned = new Set();
  const mainCleanupAttempted = new Set();
  const cleanupMainOwnedFile = options.cleanupMainOwnedFile || ((spool) => {
    cleanupMptFileSpool(spool);
    cleanupMptSpoolParents(spool);
  });

  function cleanupMainOwned(predicate) {
    let cleanupFailure = null;
    for (let index = 0; index < inputs.length; index += 1) {
      if (!predicate(index) || mainCleanupAttempted.has(index)) continue;
      mainCleanupAttempted.add(index);
      try {
        cleanupMainOwnedFile(inputs[index].spool);
      } catch (error) { cleanupFailure ||= error; }
    }
    if (cleanupFailure) throw cleanupFailure;
  }

  async function requireOrdinaryUnitTerminal(fileIndex) {
    const terminalPromise = control.startUnit(inputs[fileIndex].unitId);
    if (!terminalPromise || !terminalPromise.dispatchAccepted) {
      throw managedError('PREFUND_WRITER_DISPATCH_EVIDENCE_MISSING', 'Supervisor未返回unit dispatch证据');
    }
    if (await terminalPromise.dispatchAccepted) writerOwned.add(fileIndex);
    const terminal = await terminalPromise;
    if (terminal.cleanupOwnership === 'main') {
      writerOwned.delete(fileIndex);
      cleanupMainOwned((index) => index === fileIndex);
    }
    if (terminal.status === 'interrupted') {
      // Supervisor拥有Writer transport与CompoundLease；资金结果不确定时先等待其
      // authoritative parent cleanup barrier，再把中断交还TaskLifecycle。
      await control.promise;
      const error = managedError(
        'PREFUND_WRITER_UNIT_INTERRUPTED',
        'PreFund Writer当前file提交结果无法唯一判定，父任务已中断'
      );
      error.cause = terminal.error || terminal.inspection || null;
      throw error;
    }
    return terminal;
  }

  const coordinatorFactory = options.coordinatorFactory || createOrderedMptCoordinator;
  const coordinator = coordinatorFactory({
    fileCount: inputs.length,
    readyHighWaterMark: 2,
    async consumeReady(_spool, { fileIndex }) {
      const terminal = await requireOrdinaryUnitTerminal(fileIndex);
      return terminal.result || null;
    },
    async consumeError(_fileResult, { fileIndex }) {
      await requireOrdinaryUnitTerminal(fileIndex);
    }
  });

  try {
  for (let fileIndex = 0; fileIndex < inputs.length; fileIndex += 1) {
    await coordinator.waitForDispatchCapacity();
    if (typeof options.onProgress === 'function') {
      options.onProgress({
        stage: options.actionKey === 'pre-fund:mpt-repair-import' ? 'mpt-repair' : 'mpt-import',
        current: fileIndex + 1,
        total: inputs.length,
        fileName: path.basename(options.filePaths[fileIndex])
      });
    }
    const parserController = new AbortController();
    let parentTerminatedDuringParser = false;
    let readyForWriter = false;
    let failed = null;
    try {
      const parserAttempt = runParserWorker(inputs[fileIndex].spool, {
        signal: parserController.signal,
        ...(options.ParserWorkerClass ? { WorkerClass: options.ParserWorkerClass } : {})
      }).then(
        (value) => ({ kind: 'parser', ok: true, value }),
        (error) => ({ kind: 'parser', ok: false, error })
      );
      const settled = await Promise.race([parserAttempt, executionSignal]);
      if (settled.kind === 'execution') {
        parentTerminatedDuringParser = true;
        parserController.abort();
        await parserAttempt;
        throw managedError(
          'PREFUND_WRITER_PARENT_INTERRUPTED',
          'PreFund Single Writer在Parser完成前已结束，未提交spool已清理'
        );
      }
      if (!settled.ok) throw settled.error;
      writeParserOutcome(inputs[fileIndex].spool, { kind: 'spool' });
      readyForWriter = true;
    } catch (error) {
      if (parentTerminatedDuringParser) throw error;
      failed = parserFailure(options.filePaths[fileIndex], error);
      try { writeParserOutcome(inputs[fileIndex].spool, { kind: 'parser-error', fileResult: failed }); } catch (sealError) {
        // Writer将missing/invalid sealed outcome作为当前file技术错误收口；Main仍保留
        // seal错误用于父mixed结果，不改变unit identity或绕过Single Writer。
        failed = parserFailure(options.filePaths[fileIndex], sealError);
      }
    }
    // sidecar已经sealed后，Coordinator失败必须保留原始原因并由Main owner清理，
    // 不能再次以wx写parser-error覆盖或掩盖已发布的outcome。
    if (readyForWriter) coordinator.submitReady(fileIndex, inputs[fileIndex].spool);
    else coordinator.submitBusinessError(fileIndex, failed);
  }
  await coordinator.completion();
  const execution = await control.promise;
  if (execution.outcome !== 'completed' || !execution.result || !Array.isArray(execution.result.results)) {
    throw managedError(
      'PREFUND_WRITER_PARENT_INTERRUPTED',
      'PreFund Single Writer未形成可用父结果，任务已中断'
    );
  }
  const results = execution.result.results.slice();
  let adopted = results;
  if (options.actionKey === 'pre-fund:mpt-import' && options.service &&
      typeof options.service.adoptManagedMptImportResults === 'function') {
    adopted = options.service.adoptManagedMptImportResults(options.filePaths, results);
  } else if (options.actionKey === 'pre-fund:mpt-repair-import' && options.service &&
      typeof options.service.adoptManagedMptRepairResults === 'function') {
    adopted = options.service.adoptManagedMptRepairResults(options.repairFailures, results);
  }
  return Object.freeze({
    status: 'ok',
    results: Object.freeze(adopted),
    successCount: adopted.filter((item) => item.status === 'ok').length,
    failedCount: adopted.filter((item) => item.status !== 'ok').length,
    ...(options.actionKey === 'pre-fund:mpt-repair-import' ? {
      importedRowCount: adopted.reduce((sum, item) => sum + (Number(item.rowCount) || 0), 0),
      excludedRowCount: adopted.reduce((sum, item) => sum + (Number(item.excludedRowCount) || 0), 0)
    } : {})
  });
  } catch (error) {
    try {
      cleanupMainOwned((index) => !writerOwned.has(index));
    } catch (cleanupError) {
      cleanupError.cause = error;
      throw cleanupError;
    }
    throw error;
  }
}

module.exports = {
  executeManagedPreFundMptImport,
  runParserWorker
};
