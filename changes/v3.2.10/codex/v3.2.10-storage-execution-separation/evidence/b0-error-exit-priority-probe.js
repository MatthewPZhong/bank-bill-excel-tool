'use strict';

// 独立只读取证：真实 Worker 的内存限制产生同栈 error → exit，比较基线与当前 executor。
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const Module = require('node:module');
const { Worker } = require('node:worker_threads');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const assert = require('node:assert/strict');
const relativePath = 'src/main-process/run-check-multiworker.js';
const filename = path.resolve(relativePath);
const workerSource = `
  const { parentPort } = require('node:worker_threads');
  const retained = [];
  parentPort.on('message', message => {
    if (message.type === 'init') parentPort.postMessage({ type: 'init-done' });
    if (message.type === 'select-chunk-to-temp') {
      while (true) retained.push(new Array(20000).fill('bounded-worker-heap'));
    }
    if (message.type === 'close') process.exit(0);
  });
`;
async function probe(label, source) {
  const events = [];
  const workers = [];
  class BoundedWorker extends Worker {
    constructor() {
      super(workerSource, { eval: true, resourceLimits: { maxOldGenerationSizeMb: 8 } });
      workers.push(this);
      this.on('error', error => events.push({ type: 'error', code: error.code, message: error.message }));
      this.on('exit', code => events.push({ type: 'exit', code }));
    }
  }
  const loaded = new Module(filename, module);
  loaded.filename = filename;
  loaded.paths = Module._nodeModulePaths(path.dirname(filename));
  const nativeRequire = loaded.require.bind(loaded);
  loaded.require = name => name === 'node:worker_threads' ? { Worker: BoundedWorker } : nativeRequire(name);
  loaded._compile(source, filename);
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'g6-b0-priority-'));
  let caught;
  try {
    await loaded.exports.runWriteSplitChunks({
      db: { exec() { throw new Error('unexpected merge'); }, prepare() {} },
      dbPath: path.join(tempDir, 'unused.sqlite'),
      workerCount: 1, chunks: [{ chunkIndex: 0, bindParams: [] }],
      selectSql: 'SELECT 1 AS value', partColumns: ['value'],
      targetTable: 'test_rows', targetColumns: ['value'], tempDir,
      initTimeoutMs: 5000, closeTimeoutMs: 5000,
    });
  } catch (error) { caught = { name: error.name, code: error.code, message: error.message }; }
  finally {
    await Promise.all(workers.map(worker => worker.terminate()));
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
  const result = { label, sha256: createHash('sha256').update(source).digest('hex'), events, caught };
  console.log(JSON.stringify(result, null, 2));
  return result;
}
(async () => {
  const baseline = execFileSync('git', ['show', `HEAD:${relativePath}`], { cwd: process.cwd(), encoding: 'utf8' });
  const before = await probe('main@11086a3c', baseline);
  const after = await probe('current-working-tree', fs.readFileSync(filename, 'utf8'));
  assert.equal(before.events[0].code, 'ERR_WORKER_OUT_OF_MEMORY');
  assert.equal(after.events[0].code, 'ERR_WORKER_OUT_OF_MEMORY');
  assert.match(before.caught.message, /worker error 事件.*memory limit/);
  console.log('Current retains first worker error:', /worker error 事件.*memory limit/.test(after.caught.message));
})().catch(error => { console.error(error); process.exitCode = 1; });
