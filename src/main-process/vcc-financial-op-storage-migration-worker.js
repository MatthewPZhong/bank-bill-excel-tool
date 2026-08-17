'use strict';

const { parentPort, receiveMessageOnPort } = require('node:worker_threads');

const { serializeError } = require('./serialize-error');

const {
  buildVccStorageCandidate
} = require('./vcc-financial-op-storage-rebuild');

function waitForCoordinatorRelease() {
  const signal = new Int32Array(new SharedArrayBuffer(4));
  while (true) {
    const received = receiveMessageOnPort(parentPort);
    const message = received && received.message;
    if (message && message.action === 'release') {
      if (message.decision === 'commit') return;
      const error = new Error('coordinator 未确认候选库切换，旧数据库保持不变');
      error.code = 'vcc-storage-migration-coordinator-aborted';
      throw error;
    }
    Atomics.wait(signal, 0, 0, 25);
  }
}

if (parentPort) {
  parentPort.once('message', (message = {}) => {
    if (message.action !== 'build') {
      parentPort.postMessage({ type: 'error', error: serializeError(new Error('未知迁移动作')) });
      return;
    }
    try {
      const result = buildVccStorageCandidate({
        sourcePath: message.sourcePath,
        targetPath: message.targetPath,
        archiveRootDir: message.archiveRootDir,
        onProgress: (progress) => parentPort.postMessage({ type: 'progress', progress }),
        holdSourceLockUntilAck: (candidate) => {
          parentPort.postMessage({ type: 'ready', result: candidate });
          waitForCoordinatorRelease();
        }
      });
      parentPort.postMessage({ type: 'complete', result });
    } catch (error) {
      parentPort.postMessage({ type: 'error', error: serializeError(error) });
    }
  });
}

module.exports = { serializeError };
