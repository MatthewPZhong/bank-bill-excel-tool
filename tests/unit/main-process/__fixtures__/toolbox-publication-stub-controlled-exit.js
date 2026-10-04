'use strict';
const { parentPort } = require('node:worker_threads');
parentPort.on('message', (message) => {
  if (message.type === 'allow-exit') { process.exit(0); return; }
  if (message.type !== 'run') return;
  const root = message.payload.userDataDir;
  parentPort.postMessage({ type: 'done', jobId: message.jobId, result: message.op === 'discover-recovery'
    ? { root, indexDigest: 'empty', records: [], skippedActive: [] }
    : { recovered: [], deferred: [], skippedActive: [], indexDigest: 'empty', resultingIndexDigest: 'empty' } });
  // close 和 terminate 已请求时仍存活，由测试显式放行真实 exit。
});
