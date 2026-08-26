'use strict';

const path = require('node:path');

const SUPPORTED_DIRECTORY_FSYNC_PRELOAD = path.join(
  __dirname,
  'supported-directory-fsync-preload.js'
);

function supportedDirectoryFsync() {
  return Object.freeze({ capability: 'supported' });
}

function withSupportedDirectoryFsync(options = {}) {
  return {
    fsyncDirectory: supportedDirectoryFsync,
    ...options
  };
}

function createSupportedDirectoryFsyncWorkerClass(WorkerClass) {
  return function SupportedDirectoryFsyncWorker(entry, workerOptions = {}) {
    return new WorkerClass(entry, {
      ...workerOptions,
      execArgv: [
        // node --test 的隐式进程参数包含 Worker 禁止显式传入的标志；这里只保留调用方显式参数。
        ...(workerOptions.execArgv || []),
        '--require',
        SUPPORTED_DIRECTORY_FSYNC_PRELOAD
      ]
    });
  };
}

module.exports = {
  createSupportedDirectoryFsyncWorkerClass,
  supportedDirectoryFsync,
  withSupportedDirectoryFsync
};
