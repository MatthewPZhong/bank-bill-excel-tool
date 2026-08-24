'use strict';

const path = require('node:path');
const { Worker } = require('node:worker_threads');
const {
  MAX_PARSER_ERROR_ROWS,
  PARSER_CONTRACT_VERSION,
  normalizeParserInput
} = require('./parser-core');
const { createOrderedReducer } = require('./ordered-reducer');
const { WORKER_ERROR_MARKER } = require('./parser-worker');

// E03-A 只交付并发架构与有序归并；生产 benchmark/governor gate 前 effective 必须锁死 1。
const EFFECTIVE_PARSER_WORKER_COUNT = 1;
const MAX_REQUESTED_PARSER_WORKER_COUNT = 4;
const PARSER_WORKER_PATH = path.join(__dirname, 'parser-worker.js');

class VccParserPipelineError extends Error {
  constructor(code, message, options = {}) {
    super(message);
    this.name = 'VccParserPipelineError';
    this.code = code;
    if (Array.isArray(options.detailLines)) this.detailLines = options.detailLines;
    if (options.cause !== undefined) this.cause = options.cause;
  }
}

function fail(code, message, options) {
  throw new VccParserPipelineError(code, message, options);
}

function cancellationError() {
  return new VccParserPipelineError('VCC_PARSER_PIPELINE_CANCELLED', 'VCC 文件解析已取消');
}

function resolveEffectiveWorkerCount({ requestedWorkerCount = 1, effectiveWorkerCount } = {}) {
  if (!Number.isSafeInteger(requestedWorkerCount)
      || requestedWorkerCount < 1
      || requestedWorkerCount > MAX_REQUESTED_PARSER_WORKER_COUNT) {
    fail(
      'VCC_PARSER_REQUESTED_WORKER_COUNT_INVALID',
      `requestedWorkerCount 必须是 1-${MAX_REQUESTED_PARSER_WORKER_COUNT} 的安全整数`
    );
  }
  if (effectiveWorkerCount !== undefined && effectiveWorkerCount !== EFFECTIVE_PARSER_WORKER_COUNT) {
    fail('VCC_PARSER_EFFECTIVE_WORKER_COUNT_LOCKED', 'E03-A effectiveWorkerCount 必须固定为 1');
  }
  return EFFECTIVE_PARSER_WORKER_COUNT;
}

function buildParserUnits(inputs, { maxErrors = MAX_PARSER_ERROR_ROWS } = {}) {
  if (!Array.isArray(inputs) || inputs.length === 0) {
    fail('VCC_PARSER_PIPELINE_INPUTS_INVALID', 'Parser Pipeline 至少需要一个输入文件');
  }
  return inputs.map((input, fileIndex) => normalizeParserInput({
    fileIndex,
    filePath: input && input.filePath,
    sourceSnapshot: input && input.sourceSnapshot,
    maxErrors,
    parserContractVersion: PARSER_CONTRACT_VERSION
  }));
}

function deserializeWorkerError(message) {
  const payload = message && message.error;
  return new VccParserPipelineError(
    payload && typeof payload.code === 'string' ? payload.code : 'VCC_PARSER_WORKER_FAILED',
    payload && payload.message ? String(payload.message) : 'VCC Parser Worker 执行失败',
    { detailLines: payload && Array.isArray(payload.detailLines) ? payload.detailLines : [] }
  );
}

function runParserWorker(input, options = {}) {
  const signal = options.signal;
  const WorkerClass = options.WorkerClass || Worker;
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) {
      reject(cancellationError());
      return;
    }

    let worker;
    try {
      worker = new WorkerClass(PARSER_WORKER_PATH, { workerData: input });
    } catch (error) {
      reject(new VccParserPipelineError(
        'VCC_PARSER_WORKER_SPAWN_FAILED',
        'VCC Parser Worker 启动失败',
        { cause: error }
      ));
      return;
    }

    let settled = false;
    const cleanup = () => {
      if (signal) signal.removeEventListener('abort', onAbort);
    };
    const stopWorker = async () => {
      try {
        const termination = worker.terminate();
        if (termination && typeof termination.then === 'function') await termination;
      } catch (_error) {
        // Worker 已退出时 terminate 可能失败；结果状态已由首个 terminal event 决定。
      }
    };
    const succeed = (result) => {
      if (settled) return;
      settled = true;
      cleanup();
      void stopWorker().then(() => resolve(result));
    };
    const rejectOnce = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      void stopWorker().then(() => reject(error));
    };
    const onAbort = () => rejectOnce(cancellationError());

    worker.once('message', (message) => {
      if (message && message[WORKER_ERROR_MARKER] === true) {
        rejectOnce(deserializeWorkerError(message));
        return;
      }
      succeed(message);
    });
    worker.once('error', (error) => {
      rejectOnce(new VccParserPipelineError(
        'VCC_PARSER_WORKER_CRASHED',
        'VCC Parser Worker 异常退出',
        { cause: error }
      ));
    });
    worker.once('exit', (code) => {
      if (!settled) {
        rejectOnce(new VccParserPipelineError(
          'VCC_PARSER_WORKER_CRASHED',
          `VCC Parser Worker 未返回结果即退出（code=${code}）`
        ));
      }
    });
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
  });
}

function linkAbortSignal(source, target) {
  if (!source) return () => {};
  if (source.aborted) {
    target.abort();
    return () => {};
  }
  const abort = () => target.abort();
  source.addEventListener('abort', abort, { once: true });
  return () => source.removeEventListener('abort', abort);
}

async function runVccParserPipeline(inputs, options = {}) {
  const maxErrors = options.maxErrors === undefined ? MAX_PARSER_ERROR_ROWS : options.maxErrors;
  const units = buildParserUnits(inputs, { maxErrors });
  const workerCount = resolveEffectiveWorkerCount(options);
  const reducer = createOrderedReducer({ inputs: units, maxErrors });
  const runUnit = options.runUnit || runParserWorker;
  const internalAbort = new AbortController();
  const unlinkAbort = linkAbortSignal(options.signal, internalAbort);
  let cursor = 0;
  let completedFiles = 0;
  let firstError = null;

  async function workerLoop() {
    while (!internalAbort.signal.aborted) {
      const unitIndex = cursor;
      if (unitIndex >= units.length) return;
      cursor += 1;
      try {
        const result = await runUnit(units[unitIndex], { signal: internalAbort.signal });
        if (internalAbort.signal.aborted) throw cancellationError();
        reducer.accept(result);
        completedFiles += 1;
        if (typeof options.onUnitComplete === 'function') {
          options.onUnitComplete(Object.freeze({
            fileIndex: unitIndex,
            completedFiles,
            totalFiles: units.length,
            rowCount: result.rowCount
          }));
        }
      } catch (error) {
        if (!firstError) firstError = error;
        internalAbort.abort();
        return;
      }
    }
  }

  try {
    await Promise.all(Array.from({ length: workerCount }, () => workerLoop()));
    if (firstError) throw firstError;
    if (internalAbort.signal.aborted) throw cancellationError();
    return reducer.finalize();
  } finally {
    unlinkAbort();
    internalAbort.abort();
  }
}

module.exports = {
  EFFECTIVE_PARSER_WORKER_COUNT,
  MAX_REQUESTED_PARSER_WORKER_COUNT,
  PARSER_WORKER_PATH,
  VccParserPipelineError,
  buildParserUnits,
  resolveEffectiveWorkerCount,
  runParserWorker,
  runVccParserPipeline
};
