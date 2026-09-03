'use strict';

const path = require('node:path');

const { createMptRowAggregateError } = require('../mpt-parser');
const { readAndValidateMptFileSpool } = require('./spool-reader');
const { deriveFileIdentity, normalizeFileIndex } = require('./spool-contract');
const { cleanupMptFileSpool, cleanupMptSpoolParents } = require('./spool-writer');
const { readParserOutcome } = require('./parser-outcome');
const { safeMptFileName, toSafeMptErrorFields } = require('./file-result-safety');

function writerError(code, message) {
  return Object.assign(new Error(message), { code });
}

function errorResult(fileName, error, extra = {}) {
  const safeError = toSafeMptErrorFields(error, {
    fallbackCode: 'PREFUND_WRITER_FILE_FAILED',
    fallbackMessage: 'PreFund Writer处理当前文件失败',
    maxDetailLines: 100
  });
  return Object.freeze({
    status: 'failed',
    fileName: safeMptFileName(fileName),
    ...safeError,
    ...extra
  });
}

function successResult(imported, fileName) {
  return Object.freeze({
    status: 'ok',
    importStatus: imported.status,
    fileName: path.basename(fileName || imported.batch.sourceFileName),
    sourceType: imported.batch.sourceType,
    rowCount: imported.batch.rowCount,
    excludedRowCount: imported.batch.excludedRowCount
  });
}

function normalizeJobInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      !Number.isSafeInteger(input.fileCount) || input.fileCount < 0 ||
      typeof input.parentOperationKey !== 'string' || !input.parentOperationKey ||
      typeof input.producerTaskRunId !== 'string' || !input.producerTaskRunId) {
    throw writerError('PREFUND_WRITER_JOB_INPUT_INVALID', 'PreFund Writer job input非法');
  }
  return Object.freeze({
    fileCount: input.fileCount,
    parentOperationKey: input.parentOperationKey,
    producerTaskRunId: input.producerTaskRunId
  });
}

function normalizeUnitInput(input, job, actionKey, expectedIndex) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw writerError('PREFUND_WRITER_UNIT_INPUT_INVALID', 'PreFund Writer unit input非法');
  }
  const fileIndex = normalizeFileIndex(input.fileIndex);
  const identity = deriveFileIdentity(job.parentOperationKey, fileIndex);
  if (fileIndex !== expectedIndex || input.fileOperationKey !== identity.fileOperationKey ||
      input.unitId !== identity.unitId) {
    throw writerError('PREFUND_WRITER_FILE_ORDER_INVALID', 'PreFund Writer fileIndex或operation identity不连续');
  }
  if (input.kind === 'parser-error') {
    if (!input.fileResult || typeof input.fileResult !== 'object') {
      throw writerError('PREFUND_WRITER_UNIT_INPUT_INVALID', 'parser-error unit缺少fileResult');
    }
    return Object.freeze({ kind: input.kind, fileIndex, ...identity, fileResult: input.fileResult });
  }
  if (!['spool', 'parser-outcome'].includes(input.kind) ||
      !input.spool || typeof input.spool !== 'object' ||
      typeof input.datasetId !== 'string' || !input.datasetId) {
    throw writerError('PREFUND_WRITER_UNIT_INPUT_INVALID', 'spool unit identity非法');
  }
  const repair = actionKey === 'pre-fund:mpt-repair-import';
  if ((!repair && input.expectedContentHash !== undefined && input.expectedContentHash !== '') ||
      (repair && !/^[a-f0-9]{64}$/.test(input.expectedContentHash || ''))) {
    throw writerError(
      'PREFUND_WRITER_UNIT_INPUT_INVALID',
      repair ? 'repair unit缺少expectedContentHash' : 'import unit不得携带expectedContentHash'
    );
  }
  return Object.freeze({
    kind: input.kind,
    fileIndex,
    ...identity,
    spool: input.spool,
    datasetId: input.datasetId,
    skipInvalidRows: repair,
    expectedContentHash: repair ? String(input.expectedContentHash || '') : ''
  });
}

function createSingleWriterSession(options) {
  if (!options || !options.store || typeof options.store.importValidatedSpool !== 'function' ||
      typeof options.emit !== 'function' ||
      !['pre-fund:mpt-import', 'pre-fund:mpt-repair-import'].includes(options.actionKey)) {
    throw new TypeError('Single Writer Session依赖非法');
  }
  const job = normalizeJobInput(options.jobInput);
  const store = options.store;
  const emit = options.emit;
  const actionKey = options.actionKey;
  const results = new Array(job.fileCount);
  let nextFileIndex = 0;
  let active = null;
  let terminal = false;
  let cancelRequested = false;
  const cleanupAttempted = new Set();

  function cleanupUnit(unit) {
    if (!unit.spool || cleanupAttempted.has(unit.fileIndex)) return;
    cleanupAttempted.add(unit.fileIndex);
    cleanupMptFileSpool(unit.spool);
    // Parser 可以并发生成后续 file spool；中间 unit 只删除自己的目录，避免把尚在
    // createDirectoryLayer 的 Parser 共用 job/mpt 父目录移走。Writer 严格按
    // fileIndex 消费，所以最后一个 unit 开始时所有 Parser outcome 都已发布。
    if (unit.fileIndex === job.fileCount - 1) cleanupMptSpoolParents(unit.spool);
  }

  function finishIfComplete() {
    if (terminal || nextFileIndex !== job.fileCount || active) return;
    terminal = true;
    const frozenResults = Object.freeze(results.slice());
    emit('job:done', {
      result: {
        status: 'ok',
        results: frozenResults,
        successCount: frozenResults.filter((item) => item.status === 'ok').length,
        failedCount: frozenResults.filter((item) => item.status !== 'ok').length,
        ...(actionKey === 'pre-fund:mpt-repair-import' ? {
          importedRowCount: frozenResults.reduce((sum, item) => sum + (Number(item.rowCount) || 0), 0),
          excludedRowCount: frozenResults.reduce(
            (sum, item) => sum + (Number(item.excludedRowCount) || 0),
            0
          )
        } : {})
      }
    });
  }

  async function processUnit(unit, unitId) {
    let parserFileResult = unit.kind === 'parser-error' ? unit.fileResult : null;
    if (unit.kind === 'parser-outcome') {
      const parserOutcome = readParserOutcome(unit.spool);
      if (parserOutcome.kind === 'parser-error') parserFileResult = parserOutcome.fileResult;
    }
    if (parserFileResult) {
      // sealed sidecar的cleanup元数据只用于当前owner收口，不进入公开file result。
      let failed = errorResult(parserFileResult.fileName, parserFileResult);
      try { cleanupUnit(unit); } catch (cleanupError) {
        failed = errorResult(unit.spool && unit.spool.source.filePath, cleanupError);
      }
      results[unit.fileIndex] = failed;
      emit('unit:error', {
        error: {
          code: failed.code || 'PREFUND_PARSER_BUSINESS_ERROR',
          message: failed.message || 'MPT parser business error',
          stage: 'execute',
          detailLines: Array.isArray(failed.detailLines) ? failed.detailLines : []
        }
      }, unitId);
      return;
    }

    let validated;
    try {
      validated = await readAndValidateMptFileSpool(unit.spool);
      if (validated.fileIndex !== unit.fileIndex ||
          validated.fileOperationKey !== unit.fileOperationKey ||
          validated.unitId !== unit.unitId) {
        throw writerError('PREFUND_SPOOL_IDENTITY_MISMATCH', 'Writer unit与validated spool identity不一致');
      }
      if (validated.counts.error > 0) {
        throw createMptRowAggregateError({
          sourceFileName: validated.header.sourceFileName,
          sourceType: validated.header.sourceType,
          sourceBatch: validated.header.sourceBatch,
          contentHash: validated.contentHash,
          rowErrorCount: validated.counts.error,
          rowErrorSamples: validated.rowErrorSamples
        });
      }
      if (unit.skipInvalidRows && validated.counts.excluded + validated.counts.valid !==
          validated.counts.parsed) {
        throw writerError('PREFUND_SPOOL_COUNT_MISMATCH', 'repair spool行数去向不守恒');
      }
      if (cancelRequested) throw writerError('PREFUND_WRITER_CANCELLED', 'PreFund Writer已在critical前取消');
    } catch (error) {
      if (error && error.code === 'PREFUND_WRITER_CANCELLED') {
        let cancellationError = error;
        try { cleanupUnit(unit); } catch (cleanupError) { cancellationError = cleanupError; }
        if (cancellationError !== error) {
          const failed = errorResult(unit.spool.source.filePath, cancellationError);
          results[unit.fileIndex] = failed;
          emit('unit:error', { error: {
            code: failed.code,
            message: failed.message,
            stage: 'execute',
            detailLines: failed.detailLines
          } }, unitId);
          return;
        }
        terminal = true;
        emit('cancel:ack', { cancellation: { scope: 'job' } });
        emit('job:error', { error: {
          code: error.code,
          message: error.message,
          stage: 'cancel',
          detailLines: []
        } });
        return;
      }
      const repairEvidence = validated && error && error.code === 'MPT_ROW_ERRORS'
        ? {
            sourceType: validated.header.sourceType,
            sourceBatch: validated.header.sourceBatch,
            contentHash: validated.contentHash,
            rowErrorCount: validated.counts.error
          }
        : null;
      let failure = error;
      try { cleanupUnit(unit); } catch (cleanupError) { failure = cleanupError; }
      const failed = errorResult(
        validated ? validated.header.sourceFileName : unit.spool.source.filePath,
        failure,
        repairEvidence && failure === error ? { managedRepairEvidence: repairEvidence } : {}
      );
      results[unit.fileIndex] = failed;
      emit('unit:error', { error: {
        code: failed.code,
        message: failed.message,
        stage: 'execute',
        detailLines: failed.detailLines
      } }, unitId);
      return;
    }

    const ack = new Promise((resolve, reject) => {
      active.resolveAck = resolve;
      active.rejectAck = reject;
    });
    emit('critical:ready', {
      critical: {
        fileOperationKey: unit.fileOperationKey,
        fileIndex: unit.fileIndex,
        sourceType: validated.header.sourceType,
        sourceBatch: validated.header.sourceBatch,
        sourceDate: validated.header.sourceDate,
        sourceFileSequence: validated.header.sourceFileSequence,
        monthKey: validated.header.sourceDate.slice(0, 7),
        sourceFileName: validated.header.sourceFileName,
        sourceSha256: validated.source.sha256,
        contentHash: validated.contentHash,
        datasetId: unit.datasetId,
        expectedContentHash: unit.expectedContentHash,
        counts: validated.counts
      }
    }, unitId);
    await ack;

    const imported = await store.importValidatedSpool(unit.spool, {
      actionKey,
      operationKey: unit.fileOperationKey,
      producerTaskRunId: job.producerTaskRunId,
      datasetId: unit.datasetId,
      fileIndex: unit.fileIndex,
      skipInvalidRows: unit.skipInvalidRows,
      expectedContentHash: unit.expectedContentHash,
      prevalidatedSpool: validated
    });
    const fileResult = successResult(imported, validated.header.sourceFileName);
    results[unit.fileIndex] = fileResult;
    emit('commit:receipt', { receipt: imported.receipt }, unitId);
    // COMMIT后、unit:done前由Writer owner清理当前file spool。失败会沿外层
    // unit:error进入receipt-backed inspection，不能静默把残留artifact报成成功。
    cleanupUnit(unit);
    emit('unit:done', { result: fileResult }, unitId);
  }

  async function startUnit(unitInput, unitId) {
    if (terminal || active) {
      throw writerError('PREFUND_WRITER_CONCURRENT_UNIT', 'Single Writer一次只能处理一个file unit');
    }
    const unit = normalizeUnitInput(unitInput, job, actionKey, nextFileIndex);
    if (unitId !== unit.unitId) {
      throw writerError('PREFUND_WRITER_UNIT_ID_MISMATCH', 'unit:start route与input unitId不一致');
    }
    active = { unit, unitId, resolveAck: null, rejectAck: null, critical: false };
    try {
      await processUnit(unit, unitId);
    } catch (error) {
      let failure = error;
      try { cleanupUnit(unit); } catch (cleanupError) { failure = cleanupError; }
      const failed = errorResult(
        unit.spool && unit.spool.source && unit.spool.source.filePath,
        failure
      );
      results[unit.fileIndex] = failed;
      emit('unit:error', { error: {
        code: failed.code,
        message: failed.message,
        stage: 'execute',
        detailLines: failed.detailLines
      } }, unitId);
    } finally {
      active = null;
      nextFileIndex += 1;
      finishIfComplete();
    }
  }

  function acknowledge(unitId, critical) {
    if (!active || active.unitId !== unitId || !active.resolveAck ||
        !critical || critical.fileOperationKey !== active.unit.fileOperationKey ||
        typeof critical.intentId !== 'string' || !critical.intentId) {
      throw writerError('PREFUND_WRITER_CRITICAL_ACK_INVALID', 'critical ACK与当前file unit不匹配');
    }
    const resolve = active.resolveAck;
    active.resolveAck = null;
    active.critical = true;
    resolve(critical);
  }

  function cancel() {
    if (terminal || (active && (active.resolveAck || active.critical))) return false;
    cancelRequested = true;
    if (active) return true;
    terminal = true;
    emit('cancel:ack', { cancellation: { scope: 'job' } });
    emit('job:error', {
      error: {
        code: 'PREFUND_WRITER_CANCELLED',
        message: 'PreFund Writer已在安全点取消',
        stage: 'cancel',
        detailLines: []
      }
    });
    return true;
  }

  if (job.fileCount === 0) queueMicrotask(finishIfComplete);
  return Object.freeze({ acknowledge, cancel, startUnit });
}

module.exports = {
  createSingleWriterSession,
  errorResult,
  normalizeJobInput,
  normalizeUnitInput,
  successResult
};
