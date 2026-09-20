// B0 真实线程故障 fixture：测试显式允许退出前保留线程与测试 SQLite 连接。
'use strict';
const { parentPort, workerData } = require('node:worker_threads');
const { DatabaseSync } = require('node:sqlite');
let db;
parentPort.on('message', (msg) => {
  if (msg.type === 'test-exit') {
    if (db) db.close();
    process.exit(0);
  }
  if (msg.type === 'test-init-done') { parentPort.postMessage({ type: 'init-done' }); return; }
  if (msg.type === 'close') return; // 测试控制退出时刻，模拟无法及时完成的优雅关闭。
  if (msg.type === 'init') {
    if (workerData.mode === 'init-error') {
      parentPort.postMessage({ type: 'init-error', error: { message: 'fixture init failure', name: 'Error' } });
      return;
    }
    if (workerData.mode === 'init-timeout' || workerData.mode === 'late-init') return;
    if (workerData.mode === 'init-crash') throw new Error('fixture init crash');
    db = new DatabaseSync(msg.dbPath, { readOnly: true });
    parentPort.postMessage({ type: 'init-done' });
    return;
  }
  if (msg.type === 'select-chunk-to-temp') {
    if (workerData.mode === 'chunk-exit-zero') process.exit(0);
    if (workerData.mode === 'chunk-oom') {
      const retained = [];
      // Worker 堆限定为 8 MiB，由真实运行时发出 error 后同栈 exit。
      for (;;) retained.push(new Array(20000).fill('bounded-worker-heap'));
    }
    const part = new DatabaseSync(msg.tempDbPath);
    part.exec('CREATE TABLE diff_part (seq INTEGER PRIMARY KEY, bill_import_id INTEGER, flow_currency TEXT, flow_amount_abs TEXT, diff_type TEXT)');
    part.prepare('INSERT INTO diff_part VALUES (1, 1, ?, ?, ?)').run('USD', '1.00', 'fixture');
    part.close();
    parentPort.postMessage({ type: 'temp-done', jobId: msg.jobId, tempDbPath: msg.tempDbPath, rowCount: 1 });
  }
});
