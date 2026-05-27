const test = require('node:test');
const assert = require('node:assert/strict');

const {
  BANK_STATEMENT_FIELDS,
  BANK_STATEMENT_FIELDS_FOR_C3,
  BANK_STATEMENT_VIRTUAL_AMOUNT_ABS
} = require('../../../src/constants/bank-statement-fields');

test.describe('BANK_STATEMENT_FIELDS — 44 列固定字段', () => {
  test('Object.freeze 锁死', () => {
    assert.ok(Object.isFrozen(BANK_STATEMENT_FIELDS));
  });

  test('恰好 44 列', () => {
    assert.equal(BANK_STATEMENT_FIELDS.length, 44);
  });

  test('包含核心字段（账户主体 / Credit Amount / Debit Amount / ReconciliationId）', () => {
    assert.ok(BANK_STATEMENT_FIELDS.includes('账户主体'));
    assert.ok(BANK_STATEMENT_FIELDS.includes('Credit Amount'));
    assert.ok(BANK_STATEMENT_FIELDS.includes('Debit Amount'));
    assert.ok(BANK_STATEMENT_FIELDS.includes('ReconciliationId'));
  });

  test('包含 v2.1.9 N5 关联字段（Channel / 地区）', () => {
    assert.ok(BANK_STATEMENT_FIELDS.includes('Channel'));
    assert.ok(BANK_STATEMENT_FIELDS.includes('地区'));
  });

  test('字段名无重复', () => {
    const set = new Set(BANK_STATEMENT_FIELDS);
    assert.equal(set.size, BANK_STATEMENT_FIELDS.length, '字段名应全部唯一');
  });

  test('字段名全非空字符串', () => {
    BANK_STATEMENT_FIELDS.forEach((f, i) => {
      assert.equal(typeof f, 'string', `第 ${i} 列必须是字符串`);
      assert.ok(f.length > 0, `第 ${i} 列不可为空`);
    });
  });

  test('顺序：账户主体 = 第 1 列', () => {
    assert.equal(BANK_STATEMENT_FIELDS[0], '账户主体');
  });

  test('顺序：拆分信息 = 第 44 列（最后）', () => {
    assert.equal(BANK_STATEMENT_FIELDS[43], '拆分信息');
  });
});

test.describe('BANK_STATEMENT_VIRTUAL_AMOUNT_ABS — 虚拟字段', () => {
  test('值 = "发生额绝对值"', () => {
    assert.equal(BANK_STATEMENT_VIRTUAL_AMOUNT_ABS, '发生额绝对值');
  });
});

test.describe('BANK_STATEMENT_FIELDS_FOR_C3 — 44 + 1 虚拟字段', () => {
  test('Object.freeze 锁死', () => {
    assert.ok(Object.isFrozen(BANK_STATEMENT_FIELDS_FOR_C3));
  });

  test('恰好 45 列', () => {
    assert.equal(BANK_STATEMENT_FIELDS_FOR_C3.length, 45);
  });

  test('前 44 项 = BANK_STATEMENT_FIELDS', () => {
    for (let i = 0; i < 44; i++) {
      assert.equal(BANK_STATEMENT_FIELDS_FOR_C3[i], BANK_STATEMENT_FIELDS[i]);
    }
  });

  test('第 45 项 = 发生额绝对值（虚拟字段）', () => {
    assert.equal(BANK_STATEMENT_FIELDS_FOR_C3[44], '发生额绝对值');
  });

  test('字段名无重复', () => {
    const set = new Set(BANK_STATEMENT_FIELDS_FOR_C3);
    assert.equal(set.size, BANK_STATEMENT_FIELDS_FOR_C3.length);
  });
});
