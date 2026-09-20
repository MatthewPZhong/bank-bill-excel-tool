'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const runRepository = require('../../../src/backend/acquiring-bill-currency-db/run-repository');

// B1 固定的旧入口 fixture 不变，B2 显式装配 service。
const { createAcquiringMultiworkerService } = require('../../../src/main-process/acquiring-bill-currency-multiworker-service');
const { insertDiffRows } = createAcquiringMultiworkerService({ runRepository, executeWriteSplitChunks() { throw new Error('空表不得启动 executor'); } });
const valid = { runId: 1, monthKey: '2026-04', chunkSize: 2, dbPath: '/managed/side.sqlite', workerCount: 2, tempDir: '/managed/parts' };
const emptyResult = { totalChunks: 0, totalProcessedBillRows: 0, totalInsertedDiffRows: 0, lastCompletedChunkIndex: -1 };

const invalidCases = [
  [{}, 'insertDiffRowsByJoinMultiWorker: runId 必填且为 number'],
  [{ ...valid, runId: '1', monthKey: '' }, 'insertDiffRowsByJoinMultiWorker: runId 必填且为 number'],
  [{ ...valid, runId: 0 }, 'insertDiffRowsByJoinMultiWorker: runId 必填且为 number'],
  [{ ...valid, runId: NaN }, 'insertDiffRowsByJoinMultiWorker: runId 必填且为 number'],
  [{ ...valid, monthKey: '', chunkSize: 0 }, 'insertDiffRowsByJoinMultiWorker: monthKey 必填'],
  [{ ...valid, chunkSize: 0, dbPath: '' }, 'insertDiffRowsByJoinMultiWorker: chunkSize 必须为正整数，收到：0'],
  [{ ...valid, chunkSize: 1.5 }, 'insertDiffRowsByJoinMultiWorker: chunkSize 必须为正整数，收到：1.5'],
  [{ ...valid, dbPath: '', workerCount: 0 }, 'insertDiffRowsByJoinMultiWorker: dbPath 必填（worker 各自 open 只读 connection）'],
  [{ ...valid, dbPath: 3 }, 'insertDiffRowsByJoinMultiWorker: dbPath 必填（worker 各自 open 只读 connection）'],
  [{ ...valid, workerCount: '2', tempDir: '' }, 'insertDiffRowsByJoinMultiWorker: workerCount 必须 ≥1 整数，收到："2"'],
  [{ ...valid, workerCount: 0 }, 'insertDiffRowsByJoinMultiWorker: workerCount 必须 ≥1 整数，收到：0'],
  [{ ...valid, tempDir: '' }, 'insertDiffRowsByJoinMultiWorker: tempDir 必填'],
  [{ ...valid, tempDir: 3 }, 'insertDiffRowsByJoinMultiWorker: tempDir 必填'],
];
for (const [options, message] of invalidCases) {
  test(`参数验证先于 COUNT：${message}`, async () => {
    let reads = 0;
    const db = { prepare() { reads++; throw new Error('不应查询'); } };
    await assert.rejects(insertDiffRows(db, options), { message });
    assert.equal(reads, 0);
  });
}

test('兼容数值字符串 chunkSize、truthy number runId/monthKey 与未 trim 路径，空表摘要不变', async () => {
  for (const overrides of [{ chunkSize: '2' }, { runId: -1 }, { runId: Infinity }, { monthKey: 123 }, { dbPath: ' ', tempDir: ' ' }]) {
    let reads = 0;
    const options = { ...valid, ...overrides };
    const db = { prepare(sql) {
      assert.match(sql, /SELECT COUNT\(\*\).*acquiring_bill_currency_bill_imports/s);
      reads++;
      return { get(monthKey) { assert.equal(monthKey, options.monthKey); return { c: 0 }; } };
    } };
    assert.deepEqual(await insertDiffRows(db, options), emptyResult);
    assert.equal(reads, 1);
  }
});

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
const planFor = (totalBillRows = 5) => ({
  totalBillRows, totalChunks: Math.ceil(totalBillRows / 2),
  chunks: Array.from({ length: Math.ceil(totalBillRows / 2) }, (_, chunkIndex) => ({ chunkIndex, bindParams: [valid.monthKey, 2, chunkIndex * 2] })),
  selectSql: 'trusted SQL', partColumns: ['value'], targetTable: 'trusted_target', targetColumns: ['run_id', 'value'], prefixValues: [1],
});

test('service 一次装配计划/执行；数值转换、冻结上下文、取消与进度保留；reader进度不等提交', async () => {
  const barrier = deferred(); const calls = []; const db = {};
  const batchContext = Object.freeze({ taskRunId: 'fixture' }); const cancelToken = { cancelled: false };
  const plan = planFor(); let captured; let settled = false;
  const service = createAcquiringMultiworkerService({
    runRepository: {
      buildMultiworkerPlan(actualDb, options) { calls.push('plan'); assert.equal(actualDb, db); assert.deepEqual(options, { runId: 1, monthKey: valid.monthKey, chunkSize: 2 }); return plan; },
      cleanupFailedMultiworkerRun() { assert.fail('成功不清理 run'); },
    },
    executeWriteSplitChunks(options) { calls.push('execute'); captured = options; return barrier.promise; },
  });
  const progress = [];
  const promise = service.insertDiffRows(db, { ...valid, chunkSize: '2', batchContext, cancelToken,
    onChunkDone(ev) { progress.push(ev); throw new Error('UI callback'); },
  }).finally(() => { settled = true; });
  assert.deepEqual(calls, ['plan', 'execute']);
  assert.equal(captured.db, db); assert.equal(captured.batchContext, batchContext); assert.equal(captured.cancelToken, cancelToken);
  for (const field of ['chunks', 'selectSql', 'partColumns', 'targetTable', 'targetColumns', 'prefixValues']) assert.equal(captured[field], plan[field]);
  for (const field of ['dbPath', 'workerCount', 'tempDir']) assert.equal(captured[field], valid[field]);
  assert.equal('initTimeoutMs' in captured, false); assert.equal('closeTimeoutMs' in captured, false);
  captured.onProgress({ chunkIndex: 2, totalChunks: 3, rowCount: 1 });
  assert.deepEqual(progress, [{ chunkIndex: 2, totalChunks: 3, processedRows: 1, insertedDiffRows: 1, elapsedMs: 0 }]);
  await new Promise(resolve => setImmediate(resolve)); assert.equal(settled, false);
  barrier.resolve({ insertedRows: 4, totalChunks: 3, workerCount: 2 });
  assert.deepEqual(await promise, { totalChunks: 3, totalProcessedBillRows: 5, totalInsertedDiffRows: 4, lastCompletedChunkIndex: 2 });
  assert.deepEqual(calls, ['plan', 'execute']);
});

for (const name of ['reader-crash', 'merge-interrupted', 'CancelError']) {
  test(`${name}：executor退出屏障未完成不清run/结算，清理失败保原错误对象`, async () => {
    const barrier = deferred(); const calls = []; const db = {}; const error = new Error(name);
    error.name = name; error.code = 'ORIGINAL'; let settled = false;
    const service = createAcquiringMultiworkerService({
      runRepository: {
        buildMultiworkerPlan() { return planFor(); },
        cleanupFailedMultiworkerRun(actualDb, options) { calls.push('cleanup'); assert.equal(actualDb, db); assert.deepEqual(options, { runId: 1 }); throw new Error('cleanup-failed'); },
      },
      executeWriteSplitChunks() { calls.push('execute'); return barrier.promise; },
    });
    const promise = service.insertDiffRows(db, valid).finally(() => { settled = true; });
    const rejected = assert.rejects(promise, actual => actual === error);
    await new Promise(resolve => setImmediate(resolve)); assert.equal(settled, false); assert.deepEqual(calls, ['execute']);
    barrier.reject(error); await rejected;
    assert.deepEqual(calls, ['execute', 'cleanup']); assert.equal(settled, true);
  });
}

test('COUNT/计划失败先于 executor 且不误清历史 run', async () => {
  const error = new Error('COUNT-failed');
  const service = createAcquiringMultiworkerService({
    runRepository: { buildMultiworkerPlan() { throw error; }, cleanupFailedMultiworkerRun() { assert.fail('计划失败不清理'); } },
    executeWriteSplitChunks() { assert.fail('计划失败不执行'); },
  });
  await assert.rejects(service.insertDiffRows({}, valid), actual => actual === error);
});

test('repository只构造现有SQL计划与清理事务，不再导出worker wrapper', () => {
  assert.equal('insertDiffRowsByJoinMultiWorker' in runRepository, false);
  const queries = [];
  const db = { prepare(sql) { queries.push(sql); return { get(monthKey) { assert.equal(monthKey, valid.monthKey); return { c: 5 }; } }; } };
  const plan = runRepository.buildMultiworkerPlan(db, { runId: 17, monthKey: valid.monthKey, chunkSize: 2 });
  assert.equal(queries.length, 1); assert.equal(plan.totalBillRows, 5); assert.equal(plan.totalChunks, 3);
  assert.deepEqual(plan.chunks, [0, 1, 2].map(chunkIndex => ({ chunkIndex, bindParams: [valid.monthKey, 2, chunkIndex * 2] })));
  assert.equal(plan.selectSql, runRepository.buildSelectOnlyChunkSql());
  assert.deepEqual(plan.partColumns, ['bill_import_id', 'flow_currency', 'flow_amount_abs', 'diff_type']);
  assert.deepEqual(plan.targetColumns, ['run_id', ...plan.partColumns]);
  assert.equal(plan.targetTable, 'acquiring_bill_currency_diff_rows'); assert.deepEqual(plan.prefixValues, [17]);
});

for (const failingPhase of [null, 'BEGIN', 'DELETE', 'COMMIT']) {
  test(`repository失败清理事务原语：${failingPhase || '成功'}`, () => {
    const events = []; const error = new Error(failingPhase || 'unused');
    const db = {
      exec(sql) { events.push(sql); if (sql === failingPhase) throw error; },
      prepare(sql) { assert.match(sql, /DELETE FROM acquiring_bill_currency_diff_rows WHERE run_id = \?/); return { run(runId) { assert.equal(runId, 17); events.push('DELETE'); if (failingPhase === 'DELETE') throw error; } }; },
    };
    if (failingPhase) assert.throws(() => runRepository.cleanupFailedMultiworkerRun(db, { runId: 17 }), actual => actual === error);
    else runRepository.cleanupFailedMultiworkerRun(db, { runId: 17 });
    assert.deepEqual(events, failingPhase === 'BEGIN' ? ['BEGIN'] : failingPhase === 'DELETE' ? ['BEGIN', 'DELETE', 'ROLLBACK'] : failingPhase === 'COMMIT' ? ['BEGIN', 'DELETE', 'COMMIT', 'ROLLBACK'] : ['BEGIN', 'DELETE', 'COMMIT']);
  });
}
