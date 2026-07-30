'use strict';

const { isMainThread, parentPort } = require('node:worker_threads');

if (!isMainThread && parentPort) {
  parentPort.on('message', (message) => {
    if (!message || message.type !== 'run') return;
    const label = String(
      message.payload && message.payload.userDataDir
        ? message.payload.userDataDir
        : 'unknown'
    );
    parentPort.postMessage({
      type: 'progress',
      jobId: message.jobId,
      payload: { checkpoint: 'start', context: { label, startedAt: Date.now() } }
    });
    const deadline = Date.now() + 150;
    while (Date.now() < deadline) {
      // 故意同步忙碌，证明耗时 worker 作业不会阻塞调度线程 heartbeat。
    }
    parentPort.postMessage({
      type: 'done',
      jobId: message.jobId,
      result: { recovered: [], label }
    });
  });
}
