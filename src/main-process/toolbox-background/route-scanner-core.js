'use strict';

const path = require('node:path');
const { Worker } = require('node:worker_threads');

const { fromProtocolError } = require('../background-execution/error-codec');
const {
  normalizeMultiSplitInput,
  validateToolboxMultiGenerationResult
} = require('./generation-contract');
const { scanAndSealRouteDb } = require('./route-db-sealer');

function workerError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function runOutputWriter(input, signal, options = {}) {
  const workerFactory = options.workerFactory || ((entryPath, workerOptions) => (
    new Worker(entryPath, workerOptions)
  ));
  const worker = workerFactory(path.join(__dirname, 'output-writer-worker-entry.js'), {
    workerData: { input }
  });
  return new Promise((resolve, reject) => {
    let settled = false;
    let cancelTimer = null;
    let messageResult = null;
    let messageError = null;
    let transportError = null;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      if (cancelTimer) clearTimeout(cancelTimer);
      if (signal) signal.removeEventListener('abort', onAbort);
      callback(value);
    };
    const onAbort = () => {
      worker.postMessage({ operation: 'cancel' });
      cancelTimer = setTimeout(() => worker.terminate(), 5000);
      cancelTimer.unref();
    };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
    worker.once('message', (message) => {
      if (!message || message.ok !== true) {
        messageError = message && message.error
          ? fromProtocolError(message.error)
          : workerError('TOOLBOX_ROUTE_WRITER_FAILED', 'Route DB Writer返回非法结果');
        return;
      }
      messageResult = message.result;
    });
    worker.once('error', (error) => { transportError = error; });
    worker.once('exit', (code) => {
      if (settled) return;
      if (transportError) return finish(reject, transportError);
      if (messageError) return finish(reject, messageError);
      if (code === 0 && messageResult) return finish(resolve, messageResult);
      return finish(
        reject,
        workerError('TOOLBOX_ROUTE_WRITER_EXIT', `Route DB Writer未返回结果即退出：${code}`)
      );
    });
  });
}

async function executeMultiSplitGeneration(rawInput, signal) {
  const input = normalizeMultiSplitInput(rawInput);
  const seal = await scanAndSealRouteDb(input, signal);
  const result = await runOutputWriter(input, signal);
  if (!validateToolboxMultiGenerationResult(result) ||
      result.routeDb.byteSize !== seal.byteSize ||
      result.routeDb.sha256 !== seal.sha256 ||
      result.routeDb.outputPlanHash !== seal.outputPlanHash ||
      result.routeDb.manifestArtifact.byteSize !== seal.manifestArtifact.byteSize ||
      result.routeDb.manifestArtifact.sha256 !== seal.manifestArtifact.sha256) {
    throw workerError('TOOLBOX_ROUTE_WRITER_RESULT_INVALID', 'Route DB Writer结果与Scanner seal不一致');
  }
  return result;
}

module.exports = { executeMultiSplitGeneration, runOutputWriter };
