'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');

const {
  iterateGatewayBillRows
} = require('../../../../src/backend/database/linked-table-repository');

function createDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE linked_gateway_bill (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      reconciliation_id TEXT,
      bill_date TEXT,
      raw_json TEXT NOT NULL,
      imported_at TEXT NOT NULL,
      recon_bill_biz_id TEXT
    );
  `);
  return db;
}

test.describe('iterateGatewayBillRows', () => {
  test('streams valid rows in id order and preserves projected metadata', () => {
    const db = createDb();
    const insert = db.prepare(`
      INSERT INTO linked_gateway_bill
        (reconciliation_id, bill_date, raw_json, imported_at, recon_bill_biz_id)
      VALUES (?, ?, ?, '2026-07-10T00:00:00Z', ?)
    `);
    insert.run('R-2', '2026-07-02', JSON.stringify({ reconciliationid: 'R-2', OrderId: 'O-2' }), 'B-2');
    insert.run('R-1', '2026-07-01', JSON.stringify({ reconciliationid: 'R-1', OrderId: 'O-1' }), 'B-1');

    const iterator = iterateGatewayBillRows(db);
    assert.equal(typeof iterator[Symbol.iterator], 'function');
    const rows = [...iterator];

    assert.deepEqual(rows.map((item) => item.id), [1, 2]);
    assert.deepEqual(rows.map((item) => item.reconciliationId), ['R-2', 'R-1']);
    assert.equal(rows[0].row.OrderId, 'O-2');
    assert.equal(rows[1].reconBillBizId, 'B-1');
    db.close();
  });

  test('skips malformed or non-object JSON without stopping the cursor', () => {
    const db = createDb();
    const insert = db.prepare(`
      INSERT INTO linked_gateway_bill
        (reconciliation_id, bill_date, raw_json, imported_at, recon_bill_biz_id)
      VALUES (?, '', ?, '2026-07-10T00:00:00Z', ?)
    `);
    insert.run('BAD-JSON', '{', 'B-0');
    insert.run('ARRAY', '[]', 'B-1');
    insert.run('GOOD', JSON.stringify({ reconciliationid: 'GOOD' }), 'B-2');

    const rows = [...iterateGatewayBillRows(db)];

    assert.equal(rows.length, 1);
    assert.equal(rows[0].reconciliationId, 'GOOD');
    db.close();
  });
});
