const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');

const {
  TABLE,
  clearByDateBu,
  insertRows,
  getRowsByDateBu,
  getRowById,
  listDistinctBus,
  listImportedDateBuPairs,
  countDistinctDatesByBu,
  getLatestDateByBu
} = require('../../../../src/backend/biz-op-recon-db/imports-repository');
const { ensureBizOpReconTablesSupport } = require('../../../../src/backend/biz-op-recon-db/migrations');

let db;

test.beforeEach(() => {
  db = new DatabaseSync(':memory:');
  ensureBizOpReconTablesSupport(db);
});

test.afterEach(() => {
  if (db) { try { db.close(); } catch (_) {} db = null; }
});

function makeRow(idx, extras = {}) {
  return Object.assign({
    _rowIndex: idx,
    bu_name: 'BU-A',
    account_no: `A${idx}`
  }, extras);
}

test.describe('表常量', () => {
  test('TABLE = biz_op_recon_imports', () => {
    assert.equal(TABLE, 'biz_op_recon_imports');
  });
});

test.describe('insertRows', () => {
  test('插入 N 行 → 返回行数', () => {
    const n = insertRows(db, '2026-05-22', [makeRow(1), makeRow(2)]);
    assert.equal(n, 2);
  });

  test('空数组 → 0', () => {
    assert.equal(insertRows(db, '2026-05-22', []), 0);
  });

  test('null 字段 → 空串', () => {
    insertRows(db, '2026-05-22', [makeRow(1, { begin_balance: null })]);
    const r = getRowsByDateBu(db, '2026-05-22', 'BU-A');
    assert.equal(r[0].begin_balance, '');
  });
});

test.describe('clearByDateBu — LOWER+TRIM 资金红线', () => {
  test('删除同 (date, BU) 行（不区分大小写 + trim）', () => {
    insertRows(db, '2026-05-22', [makeRow(1, { bu_name: 'BU-A' })]);
    insertRows(db, '2026-05-22', [makeRow(2, { bu_name: 'BU-B' })]);
    const deleted = clearByDateBu(db, '2026-05-22', '  bu-a  ');
    assert.equal(deleted, 1);
    const r = getRowsByDateBu(db, '2026-05-22', 'BU-B');
    assert.equal(r.length, 1);
  });

  test('其他日期不受影响', () => {
    insertRows(db, '2026-05-22', [makeRow(1)]);
    insertRows(db, '2026-05-23', [makeRow(1)]);
    clearByDateBu(db, '2026-05-22', 'BU-A');
    assert.equal(getRowsByDateBu(db, '2026-05-23', 'BU-A').length, 1);
  });

  test('未匹配 → 0', () => {
    assert.equal(clearByDateBu(db, '2099-01-01', 'BU-A'), 0);
  });
});

test.describe('getRowsByDateBu', () => {
  test('按 row_index ASC + LOWER/TRIM 匹配', () => {
    insertRows(db, '2026-05-22', [
      makeRow(2, { bu_name: 'BU-A' }),
      makeRow(1, { bu_name: 'bu-a' }),
      makeRow(3, { bu_name: '  BU-A  ' })
    ]);
    const r = getRowsByDateBu(db, '2026-05-22', 'BU-A');
    assert.equal(r.length, 3);
    assert.equal(r[0].row_index, 1);
    assert.equal(r[2].row_index, 3);
  });
});

test.describe('getRowById', () => {
  test('已存在 → row', () => {
    insertRows(db, '2026-05-22', [makeRow(1)]);
    const rows = getRowsByDateBu(db, '2026-05-22', 'BU-A');
    const r = getRowById(db, rows[0].id);
    assert.ok(r);
    assert.equal(r.id, rows[0].id);
  });

  test('不存在 → undefined', () => {
    assert.equal(getRowById(db, 9999), undefined);
  });
});

test.describe('listDistinctBus — 保留原值（#A 拍板）', () => {
  test('多 BU 按字面值 distinct', () => {
    insertRows(db, '2026-05-22', [
      makeRow(1, { bu_name: 'BU-A' }),
      makeRow(2, { bu_name: 'BU-A' }),
      makeRow(3, { bu_name: 'BU-B' })
    ]);
    const r = listDistinctBus(db);
    assert.equal(r.length, 2);
    const buA = r.find((x) => x.buName === 'BU-A');
    assert.equal(buA.count, 2);
  });

  test('大小写不同视作 2 个 distinct（#A 拍板设计接受）', () => {
    insertRows(db, '2026-05-22', [
      makeRow(1, { bu_name: 'BU-A' }),
      makeRow(2, { bu_name: 'bu-a' })
    ]);
    const r = listDistinctBus(db);
    assert.equal(r.length, 2);
  });
});

test.describe('listImportedDateBuPairs', () => {
  test('多 (date, BU) 对，date DESC + BU ASC', () => {
    insertRows(db, '2026-05-22', [makeRow(1, { bu_name: 'BU-A' })]);
    insertRows(db, '2026-05-23', [makeRow(1, { bu_name: 'BU-A' }), makeRow(2, { bu_name: 'BU-B' })]);
    const r = listImportedDateBuPairs(db);
    assert.equal(r[0].date, '2026-05-23');
  });
});

test.describe('countDistinctDatesByBu / getLatestDateByBu', () => {
  test('countDistinctDatesByBu', () => {
    insertRows(db, '2026-05-22', [makeRow(1, { bu_name: 'BU-A' })]);
    insertRows(db, '2026-05-23', [makeRow(1, { bu_name: 'BU-A' })]);
    insertRows(db, '2026-05-23', [makeRow(2, { bu_name: 'BU-B' })]);
    assert.equal(countDistinctDatesByBu(db, 'BU-A'), 2);
    assert.equal(countDistinctDatesByBu(db, 'BU-B'), 1);
  });

  test('LOWER+TRIM 匹配', () => {
    insertRows(db, '2026-05-22', [makeRow(1, { bu_name: 'BU-A' })]);
    assert.equal(countDistinctDatesByBu(db, '  bu-a  '), 1);
  });

  test('无 BU → 0', () => {
    assert.equal(countDistinctDatesByBu(db, 'NoSuchBu'), 0);
  });

  test('getLatestDateByBu 取最新日期', () => {
    insertRows(db, '2026-04-01', [makeRow(1, { bu_name: 'BU-A' })]);
    insertRows(db, '2026-05-22', [makeRow(1, { bu_name: 'BU-A' })]);
    assert.equal(getLatestDateByBu(db, 'BU-A'), '2026-05-22');
  });

  test('getLatestDateByBu 无 BU → null', () => {
    assert.equal(getLatestDateByBu(db, 'NoSuchBu'), null);
  });
});
