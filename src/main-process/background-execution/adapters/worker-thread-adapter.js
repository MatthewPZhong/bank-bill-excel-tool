'use strict';

const { Worker } = require('node:worker_threads');
const { types: utilTypes } = require('node:util');

function ownDataValue(value, key) {
  if (!value || typeof value !== 'object' || utilTypes.isProxy(value)) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && Object.prototype.hasOwnProperty.call(descriptor, 'value')
    ? descriptor.value
    : undefined;
}

function cancellationErrorCode(message) {
  if (ownDataValue(message, 'operation') !== 'job:error') return null;
  const payload = ownDataValue(message, 'payload');
  const error = ownDataValue(payload, 'error');
  const code = ownDataValue(error, 'code');
  return typeof code === 'string' ? code : null;
}

function normalizeWorkerEntry(entry) {
  if (typeof entry === 'string') {
    return { filename: entry, options: {}, cancellationTerminalErrorCodes: Object.freeze([]) };
  }
  if (entry && typeof entry.path === 'string') {
    const {
      path: filename,
      cancellationTerminalErrorCodes = [],
      ...options
    } = entry;
    if (!Array.isArray(cancellationTerminalErrorCodes) ||
        cancellationTerminalErrorCodes.some((code) => typeof code !== 'string' || code.length === 0)) {
      throw new TypeError('worker-thread cancellationTerminalErrorCodes must be a string array');
    }
    return {
      filename,
      options,
      cancellationTerminalErrorCodes: Object.freeze([...new Set(cancellationTerminalErrorCodes)])
    };
  }
  throw new TypeError('worker-thread entry must be a path or { path, ...workerOptions }');
}

function createWorkerThreadAdapter(options = {}) {
  const WorkerClass = options.WorkerClass || Worker;
  return Object.freeze({
    kind: 'worker-thread',
    start(startOptions) {
      const normalized = normalizeWorkerEntry(startOptions.entry);
      const worker = new WorkerClass(normalized.filename, normalized.options);
      let closed = false;
      let readySettled = false;
      let failureReported = false;
      let cancelDispatched = false;
      let resolveReady;
      let rejectReady;
      const ready = new Promise((resolve, reject) => {
        resolveReady = resolve;
        rejectReady = reject;
      });

      function onOnline() {
        readySettled = true;
        resolveReady();
      }
      function onMessage(message) {
        if (closed) return;
        if (cancelDispatched && normalized.cancellationTerminalErrorCodes.includes(cancellationErrorCode(message)) &&
            typeof startOptions.onCancellationTerminal === 'function') {
          startOptions.onCancellationTerminal();
        }
        startOptions.onMessage(message);
      }
      function reportTransportError(error) {
        if (failureReported) return;
        failureReported = true;
        if (!readySettled) {
          readySettled = true;
          rejectReady(error);
          return;
        }
        if (!closed && typeof startOptions.onError === 'function') startOptions.onError(error);
      }
      function onError(error) {
        reportTransportError(error);
      }
      function onMessageError(error) {
        const normalized = error instanceof Error ? error : new Error('Worker message could not be deserialized');
        if (!normalized.code) normalized.code = 'WORKER_MESSAGE_DESERIALIZATION_ERROR';
        reportTransportError(normalized);
      }
      function onExit(code) {
        if (!readySettled) {
          readySettled = true;
          failureReported = true;
          const error = new Error(`Worker exited before ready (code=${code})`);
          error.code = 'WORKER_EXIT_BEFORE_READY';
          rejectReady(error);
          return;
        }
        if (!closed && !failureReported && typeof startOptions.onExit === 'function') startOptions.onExit(code, null);
      }

      worker.once('online', onOnline);
      worker.on('message', onMessage);
      worker.on('messageerror', onMessageError);
      worker.on('error', onError);
      worker.on('exit', onExit);

      function detach({ keepError = false } = {}) {
        if (typeof worker.off !== 'function') return;
        worker.off('online', onOnline);
        worker.off('message', onMessage);
        worker.off('messageerror', onMessageError);
        if (!keepError) worker.off('error', onError);
        worker.off('exit', onExit);
      }

      return Object.freeze({
        ready,
        send(message, transferList) {
          const isCancel = ownDataValue(message, 'operation') === 'job:cancel';
          if (isCancel) cancelDispatched = true;
          try {
            worker.postMessage(message, transferList);
          } catch (error) {
            if (isCancel) cancelDispatched = false;
            throw error;
          }
        },
        close() {
          closed = true;
          // terminate 完成前保留静默 error listener；EventEmitter 的无人监听 error
          // 会升级为未捕获异常，导致清理路径反而冲垮主进程。
          detach({ keepError: true });
        },
        async terminate() {
          closed = true;
          try {
            return await worker.terminate();
          } finally {
            detach();
          }
        },
        worker
      });
    }
  });
}

module.exports = {
  createWorkerThreadAdapter,
  normalizeWorkerEntry
};
