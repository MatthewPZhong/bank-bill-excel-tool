'use strict';

function defaultUtilityFork(filename, args, options) {
  const electron = require('electron');
  if (!electron || !electron.utilityProcess || typeof electron.utilityProcess.fork !== 'function') {
    throw new Error('Electron utilityProcess.fork is unavailable');
  }
  return electron.utilityProcess.fork(filename, args, options);
}

function normalizeUtilityEntry(entry) {
  if (typeof entry === 'string') {
    return { filename: entry, args: [], options: {} };
  }
  if (entry && typeof entry.path === 'string') {
    return {
      filename: entry.path,
      args: Array.isArray(entry.args) ? entry.args : [],
      options: entry.options || {}
    };
  }
  throw new TypeError('utility-process entry must be a path or { path, args, options }');
}

function utilityProcessError(type, location, report) {
  if (type instanceof Error) return type;
  const typeText = typeof type === 'string' && type ? type : 'unknown';
  const locationText = typeof location === 'string' && location ? location : 'unknown';
  const reportText = typeof report === 'string' && report ? report : 'no report';
  const error = new Error(`Utility process error (${typeText}) at ${locationText}: ${reportText}`);
  error.name = 'UtilityProcessError';
  error.code = 'UTILITY_PROCESS_ERROR';
  error.type = typeText;
  error.location = locationText;
  error.report = reportText;
  return error;
}

function timeoutError(timeoutMs) {
  const error = new Error(`Utility process did not exit within ${timeoutMs}ms after kill`);
  error.code = 'UTILITY_PROCESS_TERMINATE_TIMEOUT';
  return error;
}

function killFailedError() {
  const error = new Error('Utility process kill() returned false');
  error.code = 'UTILITY_PROCESS_KILL_FAILED';
  return error;
}

function createUtilityProcessAdapter(options = {}) {
  const fork = options.fork || defaultUtilityFork;
  return Object.freeze({
    kind: 'utility-process',
    start(startOptions) {
      const entry = normalizeUtilityEntry(startOptions.entry);
      const child = fork(entry.filename, entry.args, entry.options);
      if (!child || typeof child.on !== 'function' || typeof child.once !== 'function' ||
          typeof child.off !== 'function' || typeof child.kill !== 'function' ||
          typeof child.postMessage !== 'function') {
        throw new TypeError('utilityProcess.fork must return a ChildProcess with on/once/off/postMessage/kill APIs');
      }
      let closed = false;
      let spawned = false;
      let readySettled = false;
      let exited = false;
      let exitResult = null;
      let resolveReady;
      let rejectReady;
      let resolveExit;
      const ready = new Promise((resolve, reject) => {
        resolveReady = resolve;
        rejectReady = reject;
      });
      const exitedPromise = new Promise((resolve) => { resolveExit = resolve; });

      function onSpawn() {
        spawned = true;
        if (!readySettled) {
          readySettled = true;
          resolveReady();
        }
      }

      function onMessage(eventOrMessage) {
        const message = eventOrMessage && eventOrMessage.data !== undefined
          ? eventOrMessage.data
          : eventOrMessage;
        if (!closed) startOptions.onMessage(message);
      }
      function onError(type, location, report) {
        const error = utilityProcessError(type, location, report);
        if (!readySettled) {
          readySettled = true;
          rejectReady(error);
          return;
        }
        if (!closed && typeof startOptions.onError === 'function') startOptions.onError(error);
      }
      function onExit(code, signal) {
        exited = true;
        exitResult = Object.freeze({ code, signal: signal === undefined ? null : signal });
        resolveExit(exitResult);
        if (!spawned) {
          if (!readySettled) {
            readySettled = true;
            const error = new Error(`Utility process exited before spawn (code=${code})`);
            error.code = 'UTILITY_PROCESS_EXIT_BEFORE_SPAWN';
            rejectReady(error);
          }
          if (closed) detach();
          return;
        }
        if (closed) {
          detach();
          return;
        }
        if (!closed && typeof startOptions.onExit === 'function') startOptions.onExit(code, signal);
      }
      child.once('spawn', onSpawn);
      child.on('message', onMessage);
      child.on('error', onError);
      child.on('exit', onExit);

      function detach({ keepLifecycle = false } = {}) {
        child.off('spawn', onSpawn);
        child.off('message', onMessage);
        if (!keepLifecycle) {
          child.off('error', onError);
          child.off('exit', onExit);
        }
      }

      return Object.freeze({
        ready,
        send(message) {
          if (!spawned || exited) throw new Error('Utility process is not available for messages');
          child.postMessage(message);
        },
        close() {
          closed = true;
          detach({ keepLifecycle: true });
        },
        async terminate() {
          closed = true;
          const terminateTimeoutMs = Number.isFinite(options.terminateTimeoutMs) && options.terminateTimeoutMs >= 0
            ? options.terminateTimeoutMs
            : (startOptions.policy && startOptions.policy.cancellation &&
              startOptions.policy.cancellation.terminateTimeoutMs || 5000);
          try {
            if (exited) return exitResult;
            if (child.kill() === false) throw killFailedError();
            let timer;
            try {
              return await Promise.race([
                exitedPromise,
                new Promise((_resolve, reject) => {
                  timer = setTimeout(() => reject(timeoutError(terminateTimeoutMs)), terminateTimeoutMs);
                })
              ]);
            } finally {
              clearTimeout(timer);
            }
          } finally {
            if (exited) detach();
            else detach({ keepLifecycle: true });
          }
        },
        child
      });
    }
  });
}

module.exports = {
  createUtilityProcessAdapter,
  defaultUtilityFork,
  killFailedError,
  normalizeUtilityEntry,
  utilityProcessError
};
