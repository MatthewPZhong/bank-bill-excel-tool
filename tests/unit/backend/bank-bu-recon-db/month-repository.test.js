const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');

const {
  listMonths,
  getMonthMeta,
  importMonthAtomic,
  getPendingRows,
  getBankRows,
  PENDING_TABLE,
  BANK_TABLE,
  RUNS_TABLE
} = require('../../../../src/backend/bank-bu-recon-db/month-repository');
const { ensureBankBuReconTablesSupport } = require('../../../../src/backend/database/migrations');

let db;

test.beforeEach(() => {
  db = new DatabaseSync(':memory:');
  ensureBankBuReconTablesSupport(db);
});

test.afterEach(() => {
  if (db) { try { db.close(); } catch (_) {} db = null; }
});

test.describe('表常量', () => {
  test('PENDING_TABLE / BANK_TABLE / RUNS_TABLE', () => {
    assert.equal(PENDING_TABLE, 'bank_bu_recon_pending_imports');
    assert.equal(BANK_TABLE, 'bank_bu_recon_bank_imports');
    assert.equal(RUNS_TABLE, 'bank_bu_recon_runs');
  });
});

test.describe('listMonths', () => {
  test('空 DB → []', () => {
    assert.deepEqual(listMonths(db), []);
  });

  test('多月按 yearMonth 倒序 + 含 pending/bank count', () => {
    importMonthAtomic(db, '2026-03', [{ _rowIndex: 1, recon_id: 'R1' }], []);
    importMonthAtomic(db, '2026-05', [], [{ _rowIndex: 1, reconciliation_id: 'B1' }]);
    importMonthAtomic(db, '2026-04', [{ _rowIndex: 1 }], [{ _rowIndex: 1 }]);
    const r = listMonths(db);
    assert.equal(r.length, 3);
    assert.equal(r[0].yearMonth, '2026-05');
    assert.equal(r[2].yearMonth, '2026-03');
    // 2026-04 pendingCount=1 bankCount=1
    const m4 = r.find((x) => x.yearMonth === '2026-04');
    assert.equal(m4.pendingCount, 1);
    assert.equal(m4.bankCount, 1);
  });
});

test.describe('getMonthMeta', () => {
  test('空月 → 0 count', () => {
    const r = getMonthMeta(db, '2026-05');
    assert.equal(r.yearMonth, '2026-05');
    assert.equal(r.pendingCount, 0);
    assert.equal(r.bankCount, 0);
  });

  test('导入后 count 反映行数', () => {
    importMonthAtomic(db, '2026-05', [
      { _rowIndex: 1, recon_id: 'R1' },
      { _rowIndex: 2, recon_id: 'R2' }
    ], [
      { _rowIndex: 1, reconciliation_id: 'B1' }
    ]);
    const r = getMonthMeta(db, '2026-05');
    assert.equal(r.pendingCount, 2);
    assert.equal(r.bankCount, 1);
  });
});

test.describe('importMonthAtomic', () => {
  test('覆盖导入：旧数据清空 + 新数据落库', () => {
    importMonthAtomic(db, '2026-05', [{ _rowIndex: 1, recon_id: 'OLD' }], []);
    importMonthAtomic(db, '2026-05', [{ _rowIndex: 1, recon_id: 'NEW' }], []);
    const rows = getPendingRows(db, '2026-05');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].recon_id, 'NEW');
  });

  test('返回 pendingCount + bankCount', () => {
    const r = importMonthAtomic(db, '2026-05',
      [{ _rowIndex: 1 }, { _rowIndex: 2 }],
      [{ _rowIndex: 1 }]
    );
    assert.equal(r.pendingCount, 2);
    assert.equal(r.bankCount, 1);
  });

  test('空数组 → count 0', () => {
    const r = importMonthAtomic(db, '2026-05', [], []);
    assert.equal(r.pendingCount, 0);
    assert.equal(r.bankCount, 0);
  });

  test('其他月不受影响', () => {
    importMonthAtomic(db, '2026-04', [{ _rowIndex: 1 }], []);
    importMonthAtomic(db, '2026-05', [{ _rowIndex: 1 }], []);
    assert.equal(getPendingRows(db, '2026-04').length, 1);
    assert.equal(getPendingRows(db, '2026-05').length, 1);
  });
});

test.describe('getPendingRows / getBankRows', () => {
  test('按 row_index ASC 排序', () => {
    importMonthAtomic(db, '2026-05', [
      { _rowIndex: 2, recon_id: 'R2' },
      { _rowIndex: 1, recon_id: 'R1' }
    ], []);
    const r = getPendingRows(db, '2026-05');
    assert.equal(r[0].row_index, 1);
    assert.equal(r[1].row_index, 2);
  });

  test('其它月不返回', () => {
    importMonthAtomic(db, '2026-04', [{ _rowIndex: 1, recon_id: 'X' }], []);
    assert.equal(getPendingRows(db, '2026-05').length, 0);
  });

  test('空字段 → 空串（不是 null）', () => {
    importMonthAtomic(db, '2026-05', [{ _rowIndex: 1 }], []);
    const r = getPendingRows(db, '2026-05');
    assert.equal(r[0].recon_id, '');
  });
});
