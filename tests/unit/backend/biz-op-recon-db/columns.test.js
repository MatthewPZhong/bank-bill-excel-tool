const test = require('node:test');
const assert = require('node:assert/strict');

const {
  AMOUNT_EPSILON,
  BIZ_OP_COLUMN_DEFS,
  BIZ_OP_HEADERS,
  BIZ_OP_DB_COLUMNS,
  bizOpHeaderToDbColumn,
  bizOpRowToArray,
  BIZ_OP_BU_FIELD_DB_COLUMN,
  BIZ_OP_ACCOUNT_KEY_DB_COLUMN,
  BIZ_OP_BEGIN_BALANCE_DB_COLUMN,
  BIZ_OP_AMOUNT_DB_COLUMN,
  BIZ_OP_AMOUNT_IN_DB_COLUMN,
  BIZ_OP_AMOUNT_OUT_DB_COLUMN,
  BIZ_OP_END_BALANCE_DB_COLUMN,
  FLOW_COLUMN_DEFS,
  FLOW_HEADERS,
  FLOW_DB_COLUMNS,
  flowHeaderToDbColumn,
  flowRowToArray,
  FLOW_BU_FIELD_DB_COLUMN,
  FLOW_DIRECTION_DB_COLUMN,
  FLOW_ACCOUNT_KEY_DB_COLUMN,
  FLOW_RECON_AMOUNT_DB_COLUMN,
  DIFF_HEADER_TAIL,
  ERROR_HEADER_TAIL
} = require('../../../../src/backend/biz-op-recon-db/columns');

// ========================================================================
// 资金红线常量
// ========================================================================

test.describe('AMOUNT_EPSILON — 资金红线 ⚠️ 单一真理来源', () => {
  test('= 0.01（1 分钱容差）', () => {
    assert.equal(AMOUNT_EPSILON, 1e-2);
    assert.equal(AMOUNT_EPSILON, 0.01);
  });
});

// ========================================================================
// 业务 OP 账单（23 列）
// ========================================================================

test.describe('BIZ_OP_HEADERS / DB_COLUMNS — 23 列', () => {
  test('Object.freeze 锁死', () => {
    assert.ok(Object.isFrozen(BIZ_OP_HEADERS));
    assert.ok(Object.isFrozen(BIZ_OP_DB_COLUMNS));
    assert.ok(Object.isFrozen(BIZ_OP_COLUMN_DEFS));
  });

  test('恰好 23 列', () => {
    assert.equal(BIZ_OP_HEADERS.length, 23);
    assert.equal(BIZ_OP_DB_COLUMNS.length, 23);
  });

  test('HEADERS / DB_COLUMNS 一一对应', () => {
    BIZ_OP_COLUMN_DEFS.forEach((def, i) => {
      assert.equal(def.header, BIZ_OP_HEADERS[i]);
      assert.equal(def.dbColumn, BIZ_OP_DB_COLUMNS[i]);
    });
  });

  test('字段唯一', () => {
    assert.equal(new Set(BIZ_OP_HEADERS).size, 23);
    assert.equal(new Set(BIZ_OP_DB_COLUMNS).size, 23);
  });
});

test.describe('bizOpHeaderToDbColumn', () => {
  test('已知 header → DB 列名', () => {
    assert.equal(bizOpHeaderToDbColumn('期初余额'), 'begin_balance');
    assert.equal(bizOpHeaderToDbColumn('发生额'), 'amount');
    assert.equal(bizOpHeaderToDbColumn('期末余额'), 'end_balance');
  });

  test('未知 → null', () => {
    assert.equal(bizOpHeaderToDbColumn('未知'), null);
  });

  test('null → null', () => {
    assert.equal(bizOpHeaderToDbColumn(null), null);
  });
});

test.describe('bizOpRowToArray — DB 行 → 数组', () => {
  test('按 BIZ_OP_DB_COLUMNS 顺序返回字符串数组', () => {
    const row = {
      bill_date_raw: '2026-05-22',
      bu_name: 'BU-A',
      customer_no: 'C-001',
      entity: 'E-001'
    };
    const arr = bizOpRowToArray(row);
    assert.equal(arr.length, 23);
    assert.equal(arr[0], '2026-05-22');
    assert.equal(arr[1], 'BU-A');
  });

  test('缺失字段 → 空串', () => {
    const arr = bizOpRowToArray({});
    assert.equal(arr.length, 23);
    arr.forEach((v) => assert.equal(v, ''));
  });

  test('null row → 空串数组', () => {
    const arr = bizOpRowToArray(null);
    assert.equal(arr.length, 23);
    arr.forEach((v) => assert.equal(v, ''));
  });

  test('数字字段 → 字符串', () => {
    const arr = bizOpRowToArray({ begin_balance: 100.5 });
    const idx = BIZ_OP_DB_COLUMNS.indexOf('begin_balance');
    assert.equal(arr[idx], '100.5');
  });
});

test.describe('BIZ_OP 语义锚点常量', () => {
  test('BU_FIELD = bu_name', () => {
    assert.equal(BIZ_OP_BU_FIELD_DB_COLUMN, 'bu_name');
    assert.ok(BIZ_OP_DB_COLUMNS.includes(BIZ_OP_BU_FIELD_DB_COLUMN));
  });

  test('ACCOUNT_KEY = account_no', () => {
    assert.equal(BIZ_OP_ACCOUNT_KEY_DB_COLUMN, 'account_no');
  });

  test('BEGIN_BALANCE = begin_balance', () => {
    assert.equal(BIZ_OP_BEGIN_BALANCE_DB_COLUMN, 'begin_balance');
  });

  test('AMOUNT* = amount/amount_in/amount_out', () => {
    assert.equal(BIZ_OP_AMOUNT_DB_COLUMN, 'amount');
    assert.equal(BIZ_OP_AMOUNT_IN_DB_COLUMN, 'amount_in');
    assert.equal(BIZ_OP_AMOUNT_OUT_DB_COLUMN, 'amount_out');
  });

  test('END_BALANCE = end_balance', () => {
    assert.equal(BIZ_OP_END_BALANCE_DB_COLUMN, 'end_balance');
  });
});

// ========================================================================
// 流水对账单（28 列）
// ========================================================================

test.describe('FLOW_HEADERS / DB_COLUMNS — 28 列', () => {
  test('Object.freeze 锁死', () => {
    assert.ok(Object.isFrozen(FLOW_HEADERS));
    assert.ok(Object.isFrozen(FLOW_DB_COLUMNS));
  });

  test('恰好 28 列', () => {
    assert.equal(FLOW_HEADERS.length, 28);
    assert.equal(FLOW_DB_COLUMNS.length, 28);
  });

  test('HEADERS/DB 一一对应', () => {
    FLOW_COLUMN_DEFS.forEach((def, i) => {
      assert.equal(def.header, FLOW_HEADERS[i]);
      assert.equal(def.dbColumn, FLOW_DB_COLUMNS[i]);
    });
  });

  test('字段唯一', () => {
    assert.equal(new Set(FLOW_HEADERS).size, 28);
    assert.equal(new Set(FLOW_DB_COLUMNS).size, 28);
  });
});

test.describe('flowHeaderToDbColumn / flowRowToArray', () => {
  test('已知 header → DB 列名', () => {
    assert.equal(flowHeaderToDbColumn('出入方向'), 'direction');
    assert.equal(flowHeaderToDbColumn('对账金额'), 'recon_amount');
  });

  test('未知 → null', () => {
    assert.equal(flowHeaderToDbColumn('未知'), null);
  });

  test('rowToArray null → 空串数组', () => {
    const arr = flowRowToArray(null);
    assert.equal(arr.length, 28);
  });

  test('rowToArray 字段顺序', () => {
    const arr = flowRowToArray({ direction: '入', recon_amount: 100 });
    const dirIdx = FLOW_DB_COLUMNS.indexOf('direction');
    const amtIdx = FLOW_DB_COLUMNS.indexOf('recon_amount');
    assert.equal(arr[dirIdx], '入');
    assert.equal(arr[amtIdx], '100');
  });
});

test.describe('FLOW 语义锚点', () => {
  test('BU_FIELD = bu_dept', () => {
    assert.equal(FLOW_BU_FIELD_DB_COLUMN, 'bu_dept');
  });

  test('DIRECTION = direction', () => {
    assert.equal(FLOW_DIRECTION_DB_COLUMN, 'direction');
  });

  test('ACCOUNT_KEY = account_no', () => {
    assert.equal(FLOW_ACCOUNT_KEY_DB_COLUMN, 'account_no');
  });

  test('RECON_AMOUNT = recon_amount', () => {
    assert.equal(FLOW_RECON_AMOUNT_DB_COLUMN, 'recon_amount');
  });
});

// ========================================================================
// DIFF / ERROR 头部尾巴
// ========================================================================

test.describe('DIFF_HEADER_TAIL / ERROR_HEADER_TAIL', () => {
  test('DIFF_HEADER_TAIL Object.freeze + 4 列', () => {
    assert.ok(Object.isFrozen(DIFF_HEADER_TAIL));
    assert.equal(DIFF_HEADER_TAIL.length, 4);
  });

  test('ERROR_HEADER_TAIL = [失败行号, 失败原因]', () => {
    assert.ok(Object.isFrozen(ERROR_HEADER_TAIL));
    assert.deepEqual([...ERROR_HEADER_TAIL], ['失败行号', '失败原因']);
  });
});
