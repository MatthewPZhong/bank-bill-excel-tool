'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { runResultWorkbookWorker, acquireResultExportLease, RESULT_EXPORT_RESOURCES } =
  require('../../../src/main-process/vcc-financial-op-result-workbook-runner');
const { createResourceGovernor } = require('../../../src/main-process/background-execution/resource-governor');

const tick = () => new Promise((resolve) => setImmediate(resolve));

test('结果消息到达后仍持有资源直到真实 exit，错误 exit 不得发布结果', async () => {
  for (const exitCode of [0, 1]) {
    const events = [], worker = new EventEmitter();
    const running = runResultWorkbookWorker({ workerFactory: () => worker,
      acquireLease: async () => ({ release: () => events.push('release') }) });
    let outcome;
    const finished = running.then((value) => { outcome = value; }, (error) => { outcome = error; });
    await tick();
    worker.emit('message', { type: 'result', result: { filePaths: ['one.xlsx'] } });
    await tick();
    assert.equal(outcome, undefined); assert.deepEqual(events, []);
    worker.emit('exit', exitCode); await finished;
    assert.deepEqual(events, ['release']);
    if (exitCode === 0) assert.deepEqual(outcome.filePaths, ['one.xlsx']);
    else assert.equal(outcome.code, 'vcc-result-worker-failed');
  }
});

test('重复结果、缺少结果和 Worker error 均在 exit 后失败并释放资源', async () => {
  for (const kind of ['duplicate', 'missing', 'error']) {
    const worker = new EventEmitter(); let released = false;
    const result = runResultWorkbookWorker({ workerFactory: () => worker,
      acquireLease: async () => ({ release: () => { released = true; } }) });
    const rejection = assert.rejects(result);
    await tick();
    if (kind === 'duplicate') {
      worker.emit('message', { type: 'result', result: {} });
      worker.emit('message', { type: 'result', result: {} });
    } else if (kind === 'error') worker.emit('error', new Error('worker failed'));
    await tick(); assert.equal(released, false);
    worker.emit('exit', 0); await rejection; assert.equal(released, true);
  }
});

test('资源预算不足和排队超时均启动零 Worker', async () => {
  const small = createResourceGovernor({ budgets: { ...RESULT_EXPORT_RESOURCES, memoryBytes: 1024 } });
  let spawned = 0;
  await assert.rejects(runResultWorkbookWorker({ workerFactory: () => { spawned += 1; },
    acquireLease: () => acquireResultExportLease(small, 'test') }), { code: 'vcc-result-resource-limit' });
  await assert.rejects(runResultWorkbookWorker({ workerFactory: () => { spawned += 1; },
    acquireLease: () => acquireResultExportLease({ snapshot: () => ({ accepting: true, budgets: RESULT_EXPORT_RESOURCES }),
      acquirePhaseLease: async (request) => {
        assert.equal(request.timeoutMs, 5000);
        throw Object.assign(new Error('timeout'), { code: 'ADMISSION_TIMEOUT' });
      } }, 'test') }), { code: 'vcc-result-resource-timeout' });
  assert.equal(spawned, 0);
});

test('构造 Worker 失败也释放已获资源；共享 Governor 真实授予和释放', async () => {
  const governor = createResourceGovernor({ budgets: RESULT_EXPORT_RESOURCES });
  await assert.rejects(runResultWorkbookWorker({
    acquireLease: () => acquireResultExportLease(governor, 'construct-failed'),
    workerFactory() { throw new Error('cannot spawn'); }
  }), /cannot spawn/);
  assert.equal(governor.snapshot().available.memoryBytes, RESULT_EXPORT_RESOURCES.memoryBytes);
});
