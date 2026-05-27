const test = require('node:test');
const assert = require('node:assert/strict');

const PENDING_COLUMNS = require('../../../../src/backend/pending-db/columns');

test.describe('PENDING_COLUMNS — Pending.xlsx 31 列', () => {
  test('Object.freeze 锁死', () => {
    assert.ok(Object.isFrozen(PENDING_COLUMNS));
  });

  test('恰好 31 列', () => {
    assert.equal(PENDING_COLUMNS.length, 31);
  });

  test('字段唯一', () => {
    assert.equal(new Set(PENDING_COLUMNS).size, PENDING_COLUMNS.length);
  });

  test('字段全非空字符串', () => {
    PENDING_COLUMNS.forEach((col, i) => {
      assert.equal(typeof col, 'string', `第 ${i} 列必须是字符串`);
      assert.ok(col.length > 0, `第 ${i} 列不可为空`);
    });
  });

  test('第 1 列 = pending类型', () => {
    assert.equal(PENDING_COLUMNS[0], 'pending类型');
  });

  test('包含核心字段', () => {
    assert.ok(PENDING_COLUMNS.includes('PendingBizId'));
    assert.ok(PENDING_COLUMNS.includes('recon_id'));
    assert.ok(PENDING_COLUMNS.includes('billDate'));
    assert.ok(PENDING_COLUMNS.includes('金额'));
    assert.ok(PENDING_COLUMNS.includes('币种'));
  });

  test('包含 v2.0.0-beta.2 还原后的 pending资金类型（允许任意文本）', () => {
    assert.ok(PENDING_COLUMNS.includes('pending资金类型'));
  });
});
