'use strict';

const { EventEmitter } = require('node:events');
const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const {
  ensureVccFinancialOpTablesSupport
} = require('../../../src/backend/vcc-financial-op-db/migrations');
const {
  createVccFinancialOpService
} = require('../../../src/main-process/vcc-financial-op-service');

class FakeWorker extends EventEmitter {
  constructor(filename, options) {
    super();
    this.filename = filename;
    this.options = options;
    this.terminateCount = 0;
  }

  postMessage() {}

  async terminate() {
    this.terminateCount += 1;
    this.emit('exit', 1);
    return 1;
  }
}

function workerFactory(target) {
  return (filename, options) => {
    const worker = new FakeWorker(filename, options);
    target.push(worker);
    return worker;
  };
}

function createService(options = {}) {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  ensureVccFinancialOpTablesSupport(db);
  return {
    db,
    service: createVccFinancialOpService({
      database: { db, dbPath: ':memory:' },
      assetsDir: '',
      ...options
    })
  };
}

function completeRead(worker, result) {
  worker.emit('message', { type: 'result', result: {
    taskGeneration: worker.options.workerData.payload.taskGeneration,
    ...result
  } });
}

test('B-09 active month cache 按 generation 复用并在写任务释放后失效', async (t) => {
  const readWorkers = [];
  const writeWorkers = [];
  const { db, service } = createService({
    readWorkerFactory: workerFactory(readWorkers),
    workerFactory: workerFactory(writeWorkers)
  });
  t.after(async () => {
    await service.terminate();
    db.close();
  });

  const firstRead = service.listImportMonths();
  assert.equal(readWorkers.length, 1);
  completeRead(readWorkers[0], { months: ['2026-06'] });
  assert.deepEqual(await firstRead, ['2026-06']);
  assert.deepEqual(await service.listImportMonths(), ['2026-06']);
  assert.equal(readWorkers.length, 1, '同 generation 命中缓存');

  const calculation = service.calculate({
    targetMonth: '2026-06',
    expectedInputFingerprint: 'a'.repeat(64)
  });
  writeWorkers[0].emit('message', { type: 'result', result: { status: 'calculated' } });
  await calculation;
  const nextRead = service.listImportMonths();
  assert.equal(readWorkers.length, 2, '写任务 release 推进 generation 后缓存失效');
  completeRead(readWorkers[1], { months: ['2026-07', '2026-06'] });
  assert.deepEqual(await nextRead, ['2026-07', '2026-06']);
});

test('B-10 Main 在 read worker 返回后复核 generation 与 active task identity', async (t) => {
  const readWorkers = [];
  const writeWorkers = [];
  const { db, service } = createService({
    readWorkerFactory: workerFactory(readWorkers),
    workerFactory: workerFactory(writeWorkers)
  });
  t.after(async () => {
    await service.terminate();
    db.close();
  });

  const archiveRead = service.listArchivedResultMonths();
  assert.equal(readWorkers[0].options.workerData.payload.taskActive, false);
  const calculation = service.calculate({
    targetMonth: '2026-06',
    expectedInputFingerprint: 'a'.repeat(64)
  });
  completeRead(readWorkers[0], { months: [], diagnostics: [] });
  await assert.rejects(archiveRead, (error) => error.code === 'state-changed');
  writeWorkers[0].emit('message', { type: 'result', result: { status: 'calculated' } });
  await calculation;
});

test('B-11 结果导出初读和 runDirectTask 内二次重查都消费同一 B archive action', async (t) => {
  const readWorkers = [];
  const writerCalls = [];
  const { db, service } = createService({
    readWorkerFactory: workerFactory(readWorkers),
    writeRunWorkbooksFn: async (args) => {
      writerCalls.push(args);
      return { filePaths: ['/tmp/result.xlsx'] };
    }
  });
  t.after(async () => {
    await service.terminate();
    db.close();
  });
  const archive = {
    targetMonth: '2026-06',
    runId: 17,
    archivedAt: '2026-08-01 09:00:00',
    resultRevision: 0,
    subjects: ['PPHK'],
    archiveContract: 'legacy-v3.1.7-four-dataset'
  };

  const initialRead = service.getArchivedRunByMonth('2026-06');
  assert.equal(readWorkers.length, 1);
  assert.equal(readWorkers[0].options.workerData.action, 'list-archive-months');
  assert.equal(readWorkers[0].options.workerData.payload.taskActive, false);
  completeRead(readWorkers[0], { months: [archive], diagnostics: [] });
  assert.deepEqual(await initialRead, archive);

  const exporting = service.exportRun({
    targetMonth: '2026-06',
    outputPath: '/tmp/result.xlsx'
  });
  assert.equal(readWorkers.length, 2);
  assert.equal(readWorkers[1].options.workerData.action, 'list-archive-months');
  assert.equal(readWorkers[1].options.workerData.payload.taskActive, true);
  completeRead(readWorkers[1], { months: [archive], diagnostics: [] });
  assert.deepEqual(await exporting, { filePaths: ['/tmp/result.xlsx'] });
  assert.equal(writerCalls.length, 1);
  assert.equal(writerCalls[0].runId, 17);
  assert.equal(service._taskStateForTests().taskGeneration, 1);
});
