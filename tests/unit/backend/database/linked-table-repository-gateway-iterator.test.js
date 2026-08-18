'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');

const {
  iterateGatewayBillRows,
  getGatewayBillRawJsonById
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
      recon_bill_biz_id TEXT,
      source_dataset_id TEXT,
      source_task_run_id TEXT,
      source_contract_version INTEGER NOT NULL DEFAULT 0,
      source_write_nonce TEXT
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
    const rawR2 = '{ "reconciliationid": "R-2", "OrderId": "O-2" }';
    insert.run('R-2', '2026-07-02', rawR2, 'B-2');
    insert.run('R-1', '2026-07-01', JSON.stringify({ reconciliationid: 'R-1', OrderId: 'O-1' }), 'B-1');

    const iterator = iterateGatewayBillRows(db);
    assert.equal(typeof iterator[Symbol.iterator], 'function');
    const rows = [...iterator];

    assert.deepEqual(rows.map((item) => item.id), [1, 2]);
    assert.deepEqual(rows.map((item) => item.reconciliationId), ['R-2', 'R-1']);
    assert.equal(rows[0].row.OrderId, 'O-2');
    assert.equal(rows[0].rawJson, rawR2, '原始 JSON 必须逐字符保留，不能 parse 后重新序列化');
    assert.equal(getGatewayBillRawJsonById(db, 1), rawR2);
    assert.equal(getGatewayBillRawJsonById(db, 999), null);
    assert.equal(rows[1].reconBillBizId, 'B-1');
    db.close();
  });

  test('surfaces malformed or non-object JSON as invalid rows without stopping the cursor', () => {
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

    assert.equal(rows.length, 3);
    assert.deepEqual(rows.slice(0, 2).map((row) => [row.reconciliationId, row.rawJsonInvalid]), [
      ['BAD-JSON', true],
      ['ARRAY', true]
    ]);
    assert.equal(rows[2].reconciliationId, 'GOOD');
    db.close();
  });

  test('resolves exact raw JSON by id while the streaming cursor remains open', () => {
    const db = createDb();
    const insert = db.prepare(`
      INSERT INTO linked_gateway_bill
        (reconciliation_id, bill_date, raw_json, imported_at, recon_bill_biz_id)
      VALUES (?, '', ?, '2026-07-10T00:00:00Z', '')
    `);
    const expected = new Map();
    for (let index = 1; index <= 3; index += 1) {
      const rawJson = `{ "reconciliationid" : "R-${index}" }`;
      const result = insert.run(`R-${index}`, rawJson);
      expected.set(Number(result.lastInsertRowid), rawJson);
    }

    const resolved = [];
    for (const row of iterateGatewayBillRows(db)) {
      resolved.push([row.id, getGatewayBillRawJsonById(db, row.id)]);
    }

    assert.deepEqual(resolved, [...expected.entries()]);
    db.close();
  });
});
