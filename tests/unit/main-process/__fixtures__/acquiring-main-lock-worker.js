// Main 锁归属回归：真实线程保持 job 活跃，由测试显式完成/取消/崩溃；只打开测试 SQLite。
'use strict';
const { parentPort } = require('node:worker_threads');
const { DatabaseSync } = require('node:sqlite');
let db;
let activeJob = null;
parentPort.on('message', (msg) => {
  if (msg.type === 'init') {
    db = new DatabaseSync(msg.dbPath);
    parentPort.postMessage({ type: 'init-done', pragmaValues: null });
  } else if (msg.type === 'run') {
    activeJob = msg;
    parentPort.postMessage({ type: 'progress', jobId: msg.jobId, payload: { stage: 'fixture-started' } });
  } else if (msg.type === 'test-complete' && activeJob) {
    parentPort.postMessage({ type: 'done', jobId: activeJob.jobId, result: { runId: 7, mismatchRows: 0 } });
    activeJob = null;
  } else if (msg.type === 'cancel' && activeJob) {
    parentPort.postMessage({ type: 'error', jobId: activeJob.jobId,
      error: { name: 'CancelError', message: 'fixture cancelled', stage: 'fixture' } });
    activeJob = null;
  } else if (msg.type === '__crash_for_test__') {
    process.exit(1);
  } else if (msg.type === 'close') {
    if (db) db.close();
    process.exit(0);
  }
});
