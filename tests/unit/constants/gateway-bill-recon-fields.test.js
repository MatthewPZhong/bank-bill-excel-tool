const test = require('node:test');
const assert = require('node:assert/strict');

const {
  GATEWAY_BILL_FIELDS,
  CHANNEL_BILL_FIELDS,
  ORDER_REPAIR_FIELDS_GATEWAY,
  RECON_RESULT_FIELDS_GATEWAY,
  GATEWAY_BILL_SHEET_NAME,
  CHANNEL_BILL_SHEET_NAME,
  ORDER_REPAIR_SHEET_NAME_GATEWAY,
  RECON_RESULT_SHEET_NAME_GATEWAY
} = require('../../../src/constants/gateway-bill-recon-fields');

test.describe('GATEWAY_BILL_FIELDS — 31 列', () => {
  test('Object.freeze 锁死', () => {
    assert.ok(Object.isFrozen(GATEWAY_BILL_FIELDS));
  });

  test('31 列 + 包含 reconciliationId', () => {
    assert.equal(GATEWAY_BILL_FIELDS.length, 31);
    assert.ok(GATEWAY_BILL_FIELDS.includes('reconciliationId'));
  });

  test('字段无重复', () => {
    assert.equal(new Set(GATEWAY_BILL_FIELDS).size, GATEWAY_BILL_FIELDS.length);
  });
});

test.describe('CHANNEL_BILL_FIELDS — 16 列', () => {
  test('Object.freeze 锁死', () => {
    assert.ok(Object.isFrozen(CHANNEL_BILL_FIELDS));
  });

  test('16 列 + 包含 reconciliationId（小写 c）+ receiveAmount', () => {
    assert.equal(CHANNEL_BILL_FIELDS.length, 16);
    assert.ok(CHANNEL_BILL_FIELDS.includes('reconciliationId'));
    assert.ok(CHANNEL_BILL_FIELDS.includes('receiveAmount'));
  });
});

test.describe('ORDER_REPAIR_FIELDS_GATEWAY — 14 列（不含 SubBizType）', () => {
  test('Object.freeze 锁死', () => {
    assert.ok(Object.isFrozen(ORDER_REPAIR_FIELDS_GATEWAY));
  });

  test('恰好 14 列', () => {
    assert.equal(ORDER_REPAIR_FIELDS_GATEWAY.length, 14);
  });

  test('不含 SubBizType（与 business 模式 ORDER_REPAIR_FIELDS 15 列区分）', () => {
    assert.equal(ORDER_REPAIR_FIELDS_GATEWAY.includes('SubBizType'), false);
  });
});

test.describe('RECON_RESULT_FIELDS_GATEWAY — 19 列', () => {
  test('Object.freeze 锁死', () => {
    assert.ok(Object.isFrozen(RECON_RESULT_FIELDS_GATEWAY));
  });

  test('19 列', () => {
    assert.equal(RECON_RESULT_FIELDS_GATEWAY.length, 19);
  });
});

test.describe('sheet 名常量', () => {
  test('GATEWAY_BILL_SHEET_NAME = 网关账单', () => {
    assert.equal(GATEWAY_BILL_SHEET_NAME, '网关账单');
  });

  test('CHANNEL_BILL_SHEET_NAME = 渠道账单', () => {
    assert.equal(CHANNEL_BILL_SHEET_NAME, '渠道账单');
  });

  test('ORDER_REPAIR_SHEET_NAME_GATEWAY = 订单修复', () => {
    assert.equal(ORDER_REPAIR_SHEET_NAME_GATEWAY, '订单修复');
  });

  test('RECON_RESULT_SHEET_NAME_GATEWAY = 对账结果', () => {
    assert.equal(RECON_RESULT_SHEET_NAME_GATEWAY, '对账结果');
  });
});
