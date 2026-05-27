const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');

const importRepo = require('../../../../src/backend/acquiring-bill-currency-db/import-repository');
const { ensureAcquiringBillCurrencyTablesSupport } = require('../../../../src/backend/database/migrations');
const { FLOW_HEADERS, BILL_HEADERS } = require('../../../../src/backend/acquiring-bill-currency-db/columns');

let db;

test.beforeEach(() => {
  db = new DatabaseSync(':memory:');
  ensureAcquiringBillCurrencyTablesSupport(db);
});

test.afterEach(() => {
  if (db) { try { db.close(); } catch (_) {} db = null; }
});

// ========================================================================
// normalizeCurrency
// ========================================================================

test.describe('normalizeCurrency', () => {
  test('字符串归一：trim + lower', () => {
    assert.equal(importRepo.normalizeCurrency('CNY'), 'cny');
    assert.equal(importRepo.normalizeCurrency('  CnY  '), 'cny');
  });

  test('null / undefined → 空串', () => {
    assert.equal(importRepo.normalizeCurrency(null), '');
    assert.equal(importRepo.normalizeCurrency(undefined), '');
  });

  test('数字 → 字符串', () => {
    assert.equal(importRepo.normalizeCurrency(123), '123');
  });
});

// ========================================================================
// parseAmountAbs
// ========================================================================

test.describe('parseAmountAbs', () => {
  test('正数', () => {
    assert.equal(importRepo.parseAmountAbs('100.5'), '100.5');
  });

  test('负数 → 绝对值', () => {
    assert.equal(importRepo.parseAmountAbs('-100.5'), '100.5');
  });

  test('千分位 → 去逗号', () => {
    assert.equal(importRepo.parseAmountAbs('1,234.56'), '1234.56');
  });

  test('空 → 抛错', () => {
    assert.throws(() => importRepo.parseAmountAbs(''), /为空/);
    assert.throws(() => importRepo.parseAmountAbs(null), /为空/);
    assert.throws(() => importRepo.parseAmountAbs(undefined), /为空/);
  });

  test('非数字 → 抛错', () => {
    assert.throws(() => importRepo.parseAmountAbs('abc'), /无法解析/);
  });

  test('自定义 fieldLabel 在错误信息中', () => {
    assert.throws(() => importRepo.parseAmountAbs('', '对账金额'), /对账金额/);
  });
});

// ========================================================================
// insertFlowRow / insertBillRow
// ========================================================================

function makeFlowValues(overrides = {}) {
  const values = FLOW_HEADERS.map((h) => overrides[h] != null ? overrides[h] : '');
  // 默认非空字段（v2.1.9 Reverse Sync：用 `'字段' in overrides` 判定显式传 ''，避免 `|| 默认值` 误覆盖）
  values[FLOW_HEADERS.indexOf('账单日期')] = ('账单日期' in overrides) ? overrides['账单日期'] : '2026-03-10';
  values[FLOW_HEADERS.indexOf('对账主Id')] = ('对账主Id' in overrides) ? overrides['对账主Id'] : 'R001';
  values[FLOW_HEADERS.indexOf('通道清算金额')] = ('通道清算金额' in overrides) ? overrides['通道清算金额'] : '100.50';
  values[FLOW_HEADERS.indexOf('通道清算币种')] = ('通道清算币种' in overrides) ? overrides['通道清算币种'] : 'CNY';
  return values;
}

function makeBillValues(overrides = {}) {
  const values = BILL_HEADERS.map((h) => overrides[h] != null ? overrides[h] : '');
  // 同 makeFlowValues — 用 `in overrides` 判定显式传 ''
  values[BILL_HEADERS.indexOf('账单日期')] = ('账单日期' in overrides) ? overrides['账单日期'] : '2026-03-10';
  values[BILL_HEADERS.indexOf('主对账Id')] = ('主对账Id' in overrides) ? overrides['主对账Id'] : 'R001';
  values[BILL_HEADERS.indexOf('对账币种')] = ('对账币种' in overrides) ? overrides['对账币种'] : 'CNY';
  return values;
}

test.describe('insertFlowRow', () => {
  test('正常插入 + 写入归一化字段', () => {
    const stmt = importRepo.prepareFlowInsert(db);
    importRepo.insertFlowRow(stmt, {
      monthKey: '2026-03',
      sourceFile: 'flow.xlsx',
      row: { rowIndex: 2, values: makeFlowValues() },
      importedAt: new Date().toISOString()
    });
    const row = db.prepare(`SELECT * FROM acquiring_bill_currency_flow_imports`).get();
    assert.equal(row.recon_main_id, 'R001');
    assert.equal(row.settle_currency_norm, 'cny');
    assert.equal(row.settle_amount_abs, '100.5');
  });

  test('负数金额 → ABS', () => {
    const stmt = importRepo.prepareFlowInsert(db);
    importRepo.insertFlowRow(stmt, {
      monthKey: '2026-03',
      sourceFile: 'flow.xlsx',
      row: { rowIndex: 2, values: makeFlowValues({ '通道清算金额': '-100.50' }) },
      importedAt: new Date().toISOString()
    });
    const row = db.prepare(`SELECT * FROM acquiring_bill_currency_flow_imports`).get();
    assert.equal(row.settle_amount_abs, '100.5');
  });

  test('空金额 → 允许（4 种非清算流水子类型）', () => {
    const stmt = importRepo.prepareFlowInsert(db);
    importRepo.insertFlowRow(stmt, {
      monthKey: '2026-03',
      sourceFile: 'flow.xlsx',
      row: { rowIndex: 2, values: makeFlowValues({ '通道清算金额': '' }) },
      importedAt: new Date().toISOString()
    });
    const row = db.prepare(`SELECT * FROM acquiring_bill_currency_flow_imports`).get();
    assert.equal(row.settle_amount, '');
    assert.equal(row.settle_amount_abs, '');
  });

  test('对账主Id 空 → 抛错', () => {
    const stmt = importRepo.prepareFlowInsert(db);
    assert.throws(
      () => importRepo.insertFlowRow(stmt, {
        monthKey: '2026-03',
        sourceFile: 'flow.xlsx',
        row: { rowIndex: 5, values: makeFlowValues({ '对账主Id': '' }) },
        importedAt: new Date().toISOString()
      }),
      /第 5 行：对账主Id 为空/
    );
  });

  test('账单日期 YYYY/MM/DD → 归一为 YYYY-MM-DD（raw_json 内）', () => {
    const stmt = importRepo.prepareFlowInsert(db);
    importRepo.insertFlowRow(stmt, {
      monthKey: '2026-03',
      sourceFile: 'flow.xlsx',
      row: { rowIndex: 2, values: makeFlowValues({ '账单日期': '2026/3/10' }) },
      importedAt: new Date().toISOString()
    });
    const row = db.prepare(`SELECT * FROM acquiring_bill_currency_flow_imports`).get();
    const raw = JSON.parse(row.raw_json);
    assert.equal(raw['账单日期'], '2026-03-10');
  });
});

test.describe('insertBillRow', () => {
  test('正常插入', () => {
    const stmt = importRepo.prepareBillInsert(db);
    importRepo.insertBillRow(stmt, {
      monthKey: '2026-03',
      sourceFile: 'bill.xlsx',
      row: { rowIndex: 2, values: makeBillValues() },
      importedAt: new Date().toISOString()
    });
    const row = db.prepare(`SELECT * FROM acquiring_bill_currency_bill_imports`).get();
    assert.equal(row.recon_main_id, 'R001');
    assert.equal(row.settle_currency_norm, 'cny');
  });

  test('raw_json 仅含 TEMPLATE_BILL_HEADERS 9 列（v2.1.8 N4 SR7）', () => {
    const stmt = importRepo.prepareBillInsert(db);
    importRepo.insertBillRow(stmt, {
      monthKey: '2026-03',
      sourceFile: 'bill.xlsx',
      row: { rowIndex: 2, values: makeBillValues() },
      importedAt: new Date().toISOString()
    });
    const row = db.prepare(`SELECT * FROM acquiring_bill_currency_bill_imports`).get();
    const raw = JSON.parse(row.raw_json);
    // TEMPLATE_BILL_HEADERS 9 列
    const { TEMPLATE_BILL_HEADERS } = require('../../../../src/backend/acquiring-bill-currency-db/columns');
    assert.equal(Object.keys(raw).length, TEMPLATE_BILL_HEADERS.length);
  });

  test('主对账Id 空 → 抛错', () => {
    const stmt = importRepo.prepareBillInsert(db);
    assert.throws(
      () => importRepo.insertBillRow(stmt, {
        monthKey: '2026-03',
        sourceFile: 'bill.xlsx',
        row: { rowIndex: 5, values: makeBillValues({ '主对账Id': '' }) },
        importedAt: new Date().toISOString()
      }),
      /第 5 行：主对账Id 为空/
    );
  });
});

// ========================================================================
// listMonths / getMonthReadiness
// ========================================================================

test.describe('listMonths', () => {
  test('空 DB → []', () => {
    assert.deepEqual(importRepo.listMonths(db), []);
  });

  test('flow + bill 合并 DISTINCT + DESC', () => {
    const stmt = importRepo.prepareFlowInsert(db);
    importRepo.insertFlowRow(stmt, {
      monthKey: '2026-03', sourceFile: 'f', row: { rowIndex: 2, values: makeFlowValues() }, importedAt: new Date().toISOString()
    });
    const bstmt = importRepo.prepareBillInsert(db);
    importRepo.insertBillRow(bstmt, {
      monthKey: '2026-04', sourceFile: 'b', row: { rowIndex: 2, values: makeBillValues() }, importedAt: new Date().toISOString()
    });
    const r = importRepo.listMonths(db);
    assert.deepEqual(r, ['2026-04', '2026-03']);
  });
});

test.describe('getMonthReadiness', () => {
  test('空月 → 双 0', () => {
    const r = importRepo.getMonthReadiness(db, '2026-05');
    assert.equal(r.flowCount, 0);
    assert.equal(r.billCount, 0);
    assert.equal(r.flowReady, false);
    assert.equal(r.billReady, false);
  });

  test('有 flow + bill → 双 ready', () => {
    const fstmt = importRepo.prepareFlowInsert(db);
    importRepo.insertFlowRow(fstmt, {
      monthKey: '2026-03', sourceFile: 'f', row: { rowIndex: 2, values: makeFlowValues() }, importedAt: new Date().toISOString()
    });
    const bstmt = importRepo.prepareBillInsert(db);
    importRepo.insertBillRow(bstmt, {
      monthKey: '2026-03', sourceFile: 'b', row: { rowIndex: 2, values: makeBillValues() }, importedAt: new Date().toISOString()
    });
    const r = importRepo.getMonthReadiness(db, '2026-03');
    assert.equal(r.flowReady, true);
    assert.equal(r.billReady, true);
  });
});

// ========================================================================
// deleteMonthBySide
// ========================================================================

test.describe('deleteMonthBySide', () => {
  test('kind=flow 删流水（不动 bill）', () => {
    const fstmt = importRepo.prepareFlowInsert(db);
    importRepo.insertFlowRow(fstmt, {
      monthKey: '2026-03', sourceFile: 'f', row: { rowIndex: 2, values: makeFlowValues() }, importedAt: new Date().toISOString()
    });
    const bstmt = importRepo.prepareBillInsert(db);
    importRepo.insertBillRow(bstmt, {
      monthKey: '2026-03', sourceFile: 'b', row: { rowIndex: 2, values: makeBillValues() }, importedAt: new Date().toISOString()
    });

    const r = importRepo.deleteMonthBySide(db, { kind: 'flow', monthKey: '2026-03' });
    assert.equal(r.deletedCount, 1);
    assert.equal(importRepo.getMonthReadiness(db, '2026-03').flowCount, 0);
    assert.equal(importRepo.getMonthReadiness(db, '2026-03').billCount, 1);
  });

  test('kind=bill 删单据', () => {
    const bstmt = importRepo.prepareBillInsert(db);
    importRepo.insertBillRow(bstmt, {
      monthKey: '2026-03', sourceFile: 'b', row: { rowIndex: 2, values: makeBillValues() }, importedAt: new Date().toISOString()
    });
    const r = importRepo.deleteMonthBySide(db, { kind: 'bill', monthKey: '2026-03' });
    assert.equal(r.deletedCount, 1);
  });

  test('unknown kind → 抛错', () => {
    assert.throws(
      () => importRepo.deleteMonthBySide(db, { kind: 'wrong', monthKey: '2026-03' }),
      /unknown kind/
    );
  });
});

// ========================================================================
// clearMonth — 4 表事务清理
// ========================================================================

test.describe('clearMonth', () => {
  test('清流水 + 单据（4 表事务）', () => {
    const fstmt = importRepo.prepareFlowInsert(db);
    importRepo.insertFlowRow(fstmt, {
      monthKey: '2026-03', sourceFile: 'f', row: { rowIndex: 2, values: makeFlowValues() }, importedAt: new Date().toISOString()
    });
    const bstmt = importRepo.prepareBillInsert(db);
    importRepo.insertBillRow(bstmt, {
      monthKey: '2026-03', sourceFile: 'b', row: { rowIndex: 2, values: makeBillValues() }, importedAt: new Date().toISOString()
    });
    importRepo.clearMonth(db, '2026-03');
    assert.equal(importRepo.getMonthReadiness(db, '2026-03').flowCount, 0);
    assert.equal(importRepo.getMonthReadiness(db, '2026-03').billCount, 0);
  });

  test('其它月不动', () => {
    const fstmt = importRepo.prepareFlowInsert(db);
    importRepo.insertFlowRow(fstmt, {
      monthKey: '2026-04', sourceFile: 'f', row: { rowIndex: 2, values: makeFlowValues() }, importedAt: new Date().toISOString()
    });
    importRepo.clearMonth(db, '2026-03');
    assert.equal(importRepo.getMonthReadiness(db, '2026-04').flowCount, 1);
  });
});
