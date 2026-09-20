'use strict';
const { parentPort } = require('node:worker_threads');
parentPort.on('message', (message) => {
  if (message.type === 'close') { setTimeout(() => process.exit(0), 120); return; }
  if (message.type !== 'run') return;
  const root = message.payload.userDataDir;
  parentPort.postMessage({ type: 'progress', jobId: message.jobId, payload: { checkpoint: 'done-before-exit', context: { op: message.op } } });
  parentPort.postMessage({ type: 'done', jobId: message.jobId, result: message.op === 'discover-recovery'
    ? { root, indexDigest: 'empty', records: [], skippedActive: [] }
    : { recovered: [], deferred: [], skippedActive: [], indexDigest: 'empty', resultingIndexDigest: 'empty' } });
});
