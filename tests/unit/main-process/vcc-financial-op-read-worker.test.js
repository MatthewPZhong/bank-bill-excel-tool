'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { Worker } = require('node:worker_threads');
const { DatabaseSync } = require('node:sqlite');
const {
  ensureVccFinancialOpTablesSupport
} = require('../../../src/backend/vcc-financial-op-db/migrations');
const {
  createVccFinancialOpService
} = require('../../../src/main-process/vcc-financial-op-service');

const WORKER_PATH = path.resolve(
  __dirname,
  '../../../src/main-process/vcc-financial-op-read-worker.js'
);
const LEGACY_FIXTURE_PATH = path.resolve(
  __dirname,
  '../../fixtures/vcc-financial-op/v3.1.7-four-dataset.sqlite'
);

function sha256File(filename) {
  return crypto.createHash('sha256').update(fs.readFileSync(filename)).digest('hex');
}

function runReadWorker(workerData) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(WORKER_PATH, { workerData });
    let settled = false;
    worker.on('message', (message) => {
      if (settled) return;
      settled = true;
      resolve(message);
    });
    worker.on('error', (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
    worker.on('exit', (code) => {
      if (!settled && code !== 0) reject(new Error(`read worker exit ${code}`));
    });
  });
}

test('B-07 unknown read action 在打开数据库前 allowlist 拒绝', async () => {
  const message = await runReadWorker({
    action: 'write-anything',
    payload: {},
    dbPath: path.join(os.tmpdir(), 'must-not-be-opened.sqlite')
  });
  assert.equal(message.type, 'error');
  assert.equal(message.error.code, 'invalid-vcc-read-action');
  assert.match(message.error.message, /未知 VCC 财务OP只读 worker action/);
});

test('B-08 真实 legacy fixture 在 read worker 中枚举/preview，SQL预算与主线程 lag 达标', async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vcc-read-worker-'));
  const dbPath = path.join(tempRoot, 'legacy.sqlite');
  fs.copyFileSync(LEGACY_FIXTURE_PATH, dbPath);
  const db = new DatabaseSync(dbPath);
  ensureVccFinancialOpTablesSupport(db);
  db.close();
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
  const beforeSha = sha256File(dbPath);

  const lags = [];
  let expectedTick = performance.now() + 5;
  const interval = setInterval(() => {
    const now = performance.now();
    lags.push(Math.max(0, now - expectedTick));
    expectedTick = now + 5;
  }, 5);
  const listedMessage = await runReadWorker({
    action: 'list-archive-months',
    payload: { taskGeneration: 3, taskActive: false, includeSqlTrace: true },
    dbPath
  });
  clearInterval(interval);
  assert.equal(listedMessage.type, 'result');
  assert.equal(listedMessage.result.months.length, 1);
  assert.equal(listedMessage.result.months[0].archiveContract, 'legacy-v3.1.7-four-dataset');
  assert.equal(listedMessage.result.readMetrics.queryCount, 10);
  assert.equal(listedMessage.result.readMetrics.sqlTrace.length, 10);
  assert.doesNotMatch(
    listedMessage.result.readMetrics.sqlTrace.map((entry) => entry.sql).join('\n'),
    /vcc_fin_op_import_rows|vcc_fin_op_opening_balances/i
  );
  assert.ok(lags.length > 0, 'worker 执行期间主线程计时器必须继续运行');
  assert.ok(Math.max(...lags) < 100, `主线程最大 lag ${Math.max(...lags).toFixed(3)}ms`);
  assert.ok(listedMessage.result.readMetrics.workerWallMs < 500, '小 fixture 仅作 gross regression');

  const previewMessage = await runReadWorker({
    action: 'preview-unarchive',
    payload: {
      targetMonth: '2026-06',
      taskGeneration: 3,
      taskActive: false,
      includeSqlTrace: true
    },
    dbPath
  });
  assert.equal(previewMessage.type, 'result');
  assert.equal(previewMessage.result.archiveContract, 'legacy-v3.1.7-four-dataset');
  assert.equal(previewMessage.result.canExport, true);
  assert.equal(previewMessage.result.canUnarchive, true);
  assert.match(previewMessage.result.previewToken, /^v2:[0-9a-f]{64}$/);
  assert.equal(previewMessage.result.readMetrics.queryCount, 13);
  assert.equal(sha256File(dbPath), beforeSha, 'read worker 不得修改数据库文件');
});

test('B-12 真实 legacy fixture 的初读与导出租约内二次重查均可达 writer', async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vcc-legacy-export-'));
  const dbPath = path.join(tempRoot, 'legacy.sqlite');
  fs.copyFileSync(LEGACY_FIXTURE_PATH, dbPath);
  const db = new DatabaseSync(dbPath);
  ensureVccFinancialOpTablesSupport(db);
  const writerCalls = [];
  const service = createVccFinancialOpService({
    database: { db, dbPath },
    assetsDir: '',
    writeRunWorkbooksFn: async (args) => {
      writerCalls.push(args);
      return { filePaths: ['/tmp/legacy-result.xlsx'] };
    }
  });
  t.after(async () => {
    await service.terminate();
    db.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  const target = await service.getArchivedRunByMonth('2026-06');
  assert.equal(target.archiveContract, 'legacy-v3.1.7-four-dataset');
  assert.equal(target.runId, 1);
  assert.deepEqual(await service.exportRun({
    targetMonth: '2026-06',
    outputPath: '/tmp/legacy-result.xlsx'
  }), { filePaths: ['/tmp/legacy-result.xlsx'] });
  assert.equal(writerCalls.length, 1);
  assert.equal(writerCalls[0].runId, 1);
});
