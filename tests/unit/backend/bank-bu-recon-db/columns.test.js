const test = require('node:test');
const assert = require('node:assert/strict');

const {
  PENDING_GUANLI_COLUMN_DEFS,
  PENDING_GUANLI_HEADERS,
  PENDING_GUANLI_DB_COLUMNS,
  pendingHeaderToDbColumn,
  PENDING_MATCH_KEY_HEADER,
  PENDING_MATCH_KEY_DB_COLUMN,
  PENDING_DIFF_FIELD_HEADER,
  PENDING_DIFF_FIELD_DB_COLUMN,
  BANK_COLUMN_DEFS,
  BANK_HEADERS,
  BANK_DB_COLUMNS,
  bankHeaderToDbColumn,
  BANK_MATCH_KEY_HEADER,
  BANK_MATCH_KEY_DB_COLUMN,
  BANK_DIFF_FIELD_HEADER,
  BANK_DIFF_FIELD_DB_COLUMN,
  DIFF_OUTPUT_PENDING_SHEET,
  DIFF_OUTPUT_BANK_SHEET
} = require('../../../../src/backend/bank-bu-recon-db/columns');

// ========================================================================
// PENDING 数据管理（20 列）
// ========================================================================

test.describe('PENDING_GUANLI_HEADERS / DB_COLUMNS — 20 列', () => {
  test('Object.freeze 锁死', () => {
    assert.ok(Object.isFrozen(PENDING_GUANLI_HEADERS));
    assert.ok(Object.isFrozen(PENDING_GUANLI_DB_COLUMNS));
    assert.ok(Object.isFrozen(PENDING_GUANLI_COLUMN_DEFS));
  });

  test('恰好 20 列', () => {
    assert.equal(PENDING_GUANLI_HEADERS.length, 20);
    assert.equal(PENDING_GUANLI_DB_COLUMNS.length, 20);
    assert.equal(PENDING_GUANLI_COLUMN_DEFS.length, 20);
  });

  test('HEADERS / DB_COLUMNS 一一对应', () => {
    PENDING_GUANLI_COLUMN_DEFS.forEach((def, i) => {
      assert.equal(def.header, PENDING_GUANLI_HEADERS[i]);
      assert.equal(def.dbColumn, PENDING_GUANLI_DB_COLUMNS[i]);
    });
  });

  test('字段名唯一 + DB 列名唯一', () => {
    assert.equal(new Set(PENDING_GUANLI_HEADERS).size, 20);
    assert.equal(new Set(PENDING_GUANLI_DB_COLUMNS).size, 20);
  });

  test('包含核心字段', () => {
    assert.ok(PENDING_GUANLI_HEADERS.includes('主对账单号'));
    assert.ok(PENDING_GUANLI_HEADERS.includes('财务BU'));
  });
});

test.describe('pendingHeaderToDbColumn', () => {
  test('已知 header → DB 列名', () => {
    assert.equal(pendingHeaderToDbColumn('主对账单号'), 'recon_id');
    assert.equal(pendingHeaderToDbColumn('财务BU'), 'finance_bu');
    assert.equal(pendingHeaderToDbColumn('PendingBizId'), 'pending_biz_id');
  });

  test('未知 header → null', () => {
    assert.equal(pendingHeaderToDbColumn('未知字段'), null);
  });

  test('null / undefined → null', () => {
    assert.equal(pendingHeaderToDbColumn(null), null);
    assert.equal(pendingHeaderToDbColumn(undefined), null);
  });

  test('非字符串入参 → String 转换后查找', () => {
    assert.equal(pendingHeaderToDbColumn(123), null);
  });
});

test.describe('PENDING_MATCH_KEY / DIFF_FIELD 语义锚点', () => {
  test('MATCH_KEY = 主对账单号 / recon_id', () => {
    assert.equal(PENDING_MATCH_KEY_HEADER, '主对账单号');
    assert.equal(PENDING_MATCH_KEY_DB_COLUMN, 'recon_id');
  });

  test('DIFF_FIELD = 财务BU / finance_bu', () => {
    assert.equal(PENDING_DIFF_FIELD_HEADER, '财务BU');
    assert.equal(PENDING_DIFF_FIELD_DB_COLUMN, 'finance_bu');
  });

  test('语义锚点 header 必须存在于 HEADERS', () => {
    assert.ok(PENDING_GUANLI_HEADERS.includes(PENDING_MATCH_KEY_HEADER));
    assert.ok(PENDING_GUANLI_HEADERS.includes(PENDING_DIFF_FIELD_HEADER));
  });
});

// ========================================================================
// 银行对账单（44 列）
// ========================================================================

test.describe('BANK_HEADERS / DB_COLUMNS — 44 列', () => {
  test('Object.freeze 锁死', () => {
    assert.ok(Object.isFrozen(BANK_HEADERS));
    assert.ok(Object.isFrozen(BANK_DB_COLUMNS));
  });

  test('恰好 44 列', () => {
    assert.equal(BANK_HEADERS.length, 44);
    assert.equal(BANK_DB_COLUMNS.length, 44);
  });

  test('HEADERS / DB_COLUMNS 一一对应', () => {
    BANK_COLUMN_DEFS.forEach((def, i) => {
      assert.equal(def.header, BANK_HEADERS[i]);
      assert.equal(def.dbColumn, BANK_DB_COLUMNS[i]);
    });
  });

  test('字段名唯一', () => {
    assert.equal(new Set(BANK_HEADERS).size, 44);
    assert.equal(new Set(BANK_DB_COLUMNS).size, 44);
  });

  test('包含 ReconciliationId / Remark-BU 锚点', () => {
    assert.ok(BANK_HEADERS.includes('ReconciliationId'));
    assert.ok(BANK_HEADERS.includes('Remark-BU'));
  });
});

test.describe('bankHeaderToDbColumn', () => {
  test('已知 header → DB 列名', () => {
    assert.equal(bankHeaderToDbColumn('ReconciliationId'), 'reconciliation_id');
    assert.equal(bankHeaderToDbColumn('Remark-BU'), 'remark_bu');
  });

  test('未知 → null', () => {
    assert.equal(bankHeaderToDbColumn('未知'), null);
  });

  test('null/undefined → null', () => {
    assert.equal(bankHeaderToDbColumn(null), null);
    assert.equal(bankHeaderToDbColumn(undefined), null);
  });
});

test.describe('BANK_MATCH_KEY / DIFF_FIELD', () => {
  test('MATCH_KEY = ReconciliationId / reconciliation_id', () => {
    assert.equal(BANK_MATCH_KEY_HEADER, 'ReconciliationId');
    assert.equal(BANK_MATCH_KEY_DB_COLUMN, 'reconciliation_id');
  });

  test('DIFF_FIELD = Remark-BU / remark_bu', () => {
    assert.equal(BANK_DIFF_FIELD_HEADER, 'Remark-BU');
    assert.equal(BANK_DIFF_FIELD_DB_COLUMN, 'remark_bu');
  });
});

test.describe('差异表 sheet 名常量', () => {
  test('DIFF_OUTPUT_PENDING_SHEET = Pending', () => {
    assert.equal(DIFF_OUTPUT_PENDING_SHEET, 'Pending');
  });

  test('DIFF_OUTPUT_BANK_SHEET = 银行对账单', () => {
    assert.equal(DIFF_OUTPUT_BANK_SHEET, '银行对账单');
  });
});
