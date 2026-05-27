const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');

const {
  TABLE,
  clearByDate,
  insertRows,
  getRowsByDate,
  getRowsByDateBu,
  listImportedDates
} = require('../../../../src/backend/biz-op-recon-db/flow-imports-repository');
const { ensureBizOpReconTablesSupport } = require('../../../../src/backend/biz-op-recon-db/migrations');

let db;

test.beforeEach(() => {
  db = new DatabaseSync(':memory:');
  ensureBizOpReconTablesSupport(db);
});

test.afterEach(() => {
  if (db) { try { db.close(); } catch (_) {} db = null; }
});

test.describe('表常量', () => {
  test('TABLE = biz_op_recon_flow_imports', () => {
    assert.equal(TABLE, 'biz_op_recon_flow_imports');
  });
});

test.describe('insertRows', () => {
  test('插入 N 行 → 返回行数', () => {
    const n = insertRows(db, '2026-05-22', [
      { _rowIndex: 1, account_no: 'A001', direction: '入', recon_amount: '100' },
      { _rowIndex: 2, account_no: 'A002', direction: '出', recon_amount: '50' }
    ]);
    assert.equal(n, 2);
  });

  test('空数组 → 0', () => {
    assert.equal(insertRows(db, '2026-05-22', []), 0);
  });

  test('非数组 → 0', () => {
    assert.equal(insertRows(db, '2026-05-22', null), 0);
  });

  test('null/undefined 字段 → 空串', () => {
    insertRows(db, '2026-05-22', [
      { _rowIndex: 1, account_no: 'A001', direction: '入', recon_amount: '100', bu_dept: null }
    ]);
    const rows = getRowsByDate(db, '2026-05-22');
    assert.equal(rows[0].bu_dept, '');
  });
});

test.describe('clearByDate', () => {
  test('删除指定日期全部行', () => {
    insertRows(db, '2026-05-22', [{ _rowIndex: 1, account_no: 'A', direction: '入', recon_amount: '1' }]);
    insertRows(db, '2026-05-23', [{ _rowIndex: 1, account_no: 'B', direction: '入', recon_amount: '2' }]);
    clearByDate(db, '2026-05-22');
    assert.equal(getRowsByDate(db, '2026-05-22').length, 0);
    assert.equal(getRowsByDate(db, '2026-05-23').length, 1);
  });

  test('返回删除行数', () => {
    insertRows(db, '2026-05-22', [
      { _rowIndex: 1, account_no: 'A', direction: '入', recon_amount: '1' },
      { _rowIndex: 2, account_no: 'B', direction: '入', recon_amount: '2' }
    ]);
    const n = clearByDate(db, '2026-05-22');
    assert.equal(n, 2);
  });

  test('空日期 → 0', () => {
    assert.equal(clearByDate(db, '2099-01-01'), 0);
  });
});

test.describe('getRowsByDate', () => {
  test('按 row_index ASC', () => {
    insertRows(db, '2026-05-22', [
      { _rowIndex: 3, account_no: 'A3', direction: '入', recon_amount: '1' },
      { _rowIndex: 1, account_no: 'A1', direction: '入', recon_amount: '1' },
      { _rowIndex: 2, account_no: 'A2', direction: '入', recon_amount: '1' }
    ]);
    const r = getRowsByDate(db, '2026-05-22');
    assert.equal(r[0].account_no, 'A1');
    assert.equal(r[1].account_no, 'A2');
    assert.equal(r[2].account_no, 'A3');
  });

  test('其它日期不返回', () => {
    insertRows(db, '2026-05-22', [{ _rowIndex: 1, account_no: 'A', direction: '入', recon_amount: '1' }]);
    assert.equal(getRowsByDate(db, '2099-01-01').length, 0);
  });
});

test.describe('getRowsByDateBu — SQL 层 normalizeBu 过滤', () => {
  test('LOWER(TRIM) 匹配（不区分大小写 + trim）', () => {
    insertRows(db, '2026-05-22', [
      { _rowIndex: 1, account_no: 'A', direction: '入', recon_amount: '1', bu_dept: 'BU-A' },
      { _rowIndex: 2, account_no: 'B', direction: '入', recon_amount: '1', bu_dept: 'bu-a' },
      { _rowIndex: 3, account_no: 'C', direction: '入', recon_amount: '1', bu_dept: '  BU-A  ' },
      { _rowIndex: 4, account_no: 'D', direction: '入', recon_amount: '1', bu_dept: 'BU-B' }
    ]);
    const r = getRowsByDateBu(db, '2026-05-22', 'bu-a');
    assert.equal(r.length, 3, 'LOWER+TRIM 命中 BU-A / bu-a / "  BU-A  "');
  });

  test('未匹配 → []', () => {
    insertRows(db, '2026-05-22', [{ _rowIndex: 1, account_no: 'A', direction: '入', recon_amount: '1', bu_dept: 'X' }]);
    assert.deepEqual(getRowsByDateBu(db, '2026-05-22', 'Y'), []);
  });
});

test.describe('listImportedDates', () => {
  test('空 DB → []', () => {
    assert.deepEqual(listImportedDates(db), []);
  });

  test('多日期按 date DESC + 含 rowCount', () => {
    insertRows(db, '2026-05-22', [{ _rowIndex: 1, account_no: 'A', direction: '入', recon_amount: '1' }]);
    insertRows(db, '2026-05-23', [
      { _rowIndex: 1, account_no: 'B', direction: '入', recon_amount: '1' },
      { _rowIndex: 2, account_no: 'C', direction: '入', recon_amount: '1' }
    ]);
    const r = listImportedDates(db);
    assert.equal(r[0].date, '2026-05-23');
    assert.equal(r[0].rowCount, 2);
    assert.equal(r[1].rowCount, 1);
  });
});
