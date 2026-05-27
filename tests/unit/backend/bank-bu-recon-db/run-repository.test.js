const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');

const {
  insertRun,
  updateRunExportPath,
  listRuns,
  getLatestRun,
  getRun
} = require('../../../../src/backend/bank-bu-recon-db/run-repository');
const { ensureBankBuReconTablesSupport } = require('../../../../src/backend/database/migrations');

let db;

test.beforeEach(() => {
  db = new DatabaseSync(':memory:');
  ensureBankBuReconTablesSupport(db);
});

test.afterEach(() => {
  if (db) { try { db.close(); } catch (_) {} db = null; }
});

test.describe('insertRun', () => {
  test('正常 insert + 返回新 id', () => {
    const id = insertRun(db, {
      yearMonth: '2026-05',
      status: 'success',
      pendingTotal: 100,
      bankTotal: 95,
      matchedCount: 90,
      buDiffCount: 5,
      pendingUnmatched: 10,
      bankUnmatched: 5
    });
    assert.ok(id > 0);
  });

  test('缺省字段 → 0', () => {
    const id = insertRun(db, { yearMonth: '2026-05', status: 'success' });
    const r = getRun(db, id);
    assert.equal(r.pending_total, 0);
    assert.equal(r.bank_total, 0);
    assert.equal(r.matched_count, 0);
  });

  test('anomalyReportPath + exportPath 可选', () => {
    const id = insertRun(db, {
      yearMonth: '2026-05',
      status: 'success',
      anomalyReportPath: '/path/to/report',
      exportPath: '/path/to/export'
    });
    const r = getRun(db, id);
    assert.equal(r.anomaly_report_path, '/path/to/report');
    assert.equal(r.export_path, '/path/to/export');
  });
});

test.describe('getRun', () => {
  test('已存在 → 返回 row', () => {
    const id = insertRun(db, { yearMonth: '2026-05', status: 'success' });
    const r = getRun(db, id);
    assert.equal(r.id, id);
    assert.equal(r.year_month, '2026-05');
  });

  test('不存在 → null', () => {
    assert.equal(getRun(db, 9999), null);
  });
});

test.describe('listRuns / getLatestRun', () => {
  test('单月多 run → 列出全部', () => {
    insertRun(db, { yearMonth: '2026-05', status: 'success' });
    insertRun(db, { yearMonth: '2026-05', status: 'success' });
    const r = listRuns(db, '2026-05');
    assert.equal(r.length, 2);
  });

  test('其它月 → 不包含', () => {
    insertRun(db, { yearMonth: '2026-05', status: 'success' });
    insertRun(db, { yearMonth: '2026-04', status: 'success' });
    assert.equal(listRuns(db, '2026-05').length, 1);
  });

  test('listRuns 空月 → []', () => {
    assert.deepEqual(listRuns(db, '2026-05'), []);
  });

  test('getLatestRun 单月单 run', () => {
    const id = insertRun(db, { yearMonth: '2026-05', status: 'success' });
    const r = getLatestRun(db, '2026-05');
    assert.equal(r.id, id);
  });

  test('getLatestRun 空月 → null', () => {
    assert.equal(getLatestRun(db, '2026-05'), null);
  });
});

test.describe('updateRunExportPath', () => {
  test('更新 export_path', () => {
    const id = insertRun(db, { yearMonth: '2026-05', status: 'success' });
    updateRunExportPath(db, id, '/new/path');
    const r = getRun(db, id);
    assert.equal(r.export_path, '/new/path');
  });

  test('置 null', () => {
    const id = insertRun(db, { yearMonth: '2026-05', status: 'success', exportPath: '/x' });
    updateRunExportPath(db, id, null);
    const r = getRun(db, id);
    assert.equal(r.export_path, null);
  });
});
