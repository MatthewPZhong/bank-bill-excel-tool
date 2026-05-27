const test = require('node:test');
const assert = require('node:assert/strict');

const { GATEWAY_RECON_FIELDS } = require('../../../src/constants/gateway-recon-fields');

test.describe('GATEWAY_RECON_FIELDS — 31 列固定字段', () => {
  test('Object.freeze 锁死', () => {
    assert.ok(Object.isFrozen(GATEWAY_RECON_FIELDS));
  });

  test('恰好 31 列', () => {
    assert.equal(GATEWAY_RECON_FIELDS.length, 31);
  });

  test('包含核心字段（BillDate / OrderId / Amount / reconciliationId）', () => {
    assert.ok(GATEWAY_RECON_FIELDS.includes('BillDate'));
    assert.ok(GATEWAY_RECON_FIELDS.includes('OrderId'));
    assert.ok(GATEWAY_RECON_FIELDS.includes('Amount'));
    assert.ok(GATEWAY_RECON_FIELDS.includes('reconciliationId'));
  });

  test('字段名无重复', () => {
    const set = new Set(GATEWAY_RECON_FIELDS);
    assert.equal(set.size, GATEWAY_RECON_FIELDS.length);
  });

  test('字段全非空字符串', () => {
    GATEWAY_RECON_FIELDS.forEach((f, i) => {
      assert.equal(typeof f, 'string');
      assert.ok(f.length > 0, `第 ${i} 列不可为空`);
    });
  });

  test('顺序：第 1 列 = BillDate', () => {
    assert.equal(GATEWAY_RECON_FIELDS[0], 'BillDate');
  });

  test('未包含 v2.1.8 N2 sentinel "__CUSTOM__"（防 sentinel 冲突）', () => {
    // 见 src/constants/gateway-recon-fields.js 注释 v2.1.8 N2 sentinel 保留字
    assert.equal(GATEWAY_RECON_FIELDS.includes('__CUSTOM__'), false);
  });
});
