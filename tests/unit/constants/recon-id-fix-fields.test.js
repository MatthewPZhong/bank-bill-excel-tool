const test = require('node:test');
const assert = require('node:assert/strict');

const {
  RECON_RESULT_FIELDS,
  BUSINESS_BILL_FIELDS,
  OPPONENT_BILL_FIELDS,
  ORDER_REPAIR_FIELDS,
  RECON_RESULT_SHEET_NAME,
  BUSINESS_BILL_SHEET_NAME,
  OPPONENT_BILL_SHEET_NAME,
  ORDER_REPAIR_SHEET_NAME
} = require('../../../src/constants/recon-id-fix-fields');

test.describe('RECON_RESULT_FIELDS — 18 列', () => {
  test('Object.freeze 锁死', () => {
    assert.ok(Object.isFrozen(RECON_RESULT_FIELDS));
  });

  test('恰好 18 列', () => {
    assert.equal(RECON_RESULT_FIELDS.length, 18);
  });

  test('字段无重复', () => {
    assert.equal(new Set(RECON_RESULT_FIELDS).size, RECON_RESULT_FIELDS.length);
  });

  test('包含核心字段', () => {
    assert.ok(RECON_RESULT_FIELDS.includes('账单日期'));
    assert.ok(RECON_RESULT_FIELDS.includes('对账结果'));
    assert.ok(RECON_RESULT_FIELDS.includes('reconId'));
  });
});

test.describe('BUSINESS_BILL_FIELDS — 23 列（主边）', () => {
  test('Object.freeze 锁死', () => {
    assert.ok(Object.isFrozen(BUSINESS_BILL_FIELDS));
  });

  test('恰好 23 列', () => {
    assert.equal(BUSINESS_BILL_FIELDS.length, 23);
  });

  test('包含 reconId / Amount / BizType', () => {
    assert.ok(BUSINESS_BILL_FIELDS.includes('reconId'));
    assert.ok(BUSINESS_BILL_FIELDS.includes('Amount'));
    assert.ok(BUSINESS_BILL_FIELDS.includes('BizType'));
  });
});

test.describe('OPPONENT_BILL_FIELDS — 22 列（从边，少 1 列）', () => {
  test('Object.freeze 锁死', () => {
    assert.ok(Object.isFrozen(OPPONENT_BILL_FIELDS));
  });

  test('恰好 22 列', () => {
    assert.equal(OPPONENT_BILL_FIELDS.length, 22);
  });

  test('比 BUSINESS_BILL_FIELDS 少 "订单创建来源" 字段', () => {
    assert.equal(BUSINESS_BILL_FIELDS.length - OPPONENT_BILL_FIELDS.length, 1);
    assert.equal(BUSINESS_BILL_FIELDS.includes('订单创建来源'), true);
    assert.equal(OPPONENT_BILL_FIELDS.includes('订单创建来源'), false);
  });
});

test.describe('ORDER_REPAIR_FIELDS — 15 列（含 SubBizType）', () => {
  test('Object.freeze 锁死', () => {
    assert.ok(Object.isFrozen(ORDER_REPAIR_FIELDS));
  });

  test('恰好 15 列', () => {
    assert.equal(ORDER_REPAIR_FIELDS.length, 15);
  });

  test('含 SubBizType（与 gateway 模式 ORDER_REPAIR_FIELDS_GATEWAY 14 列区分）', () => {
    assert.ok(ORDER_REPAIR_FIELDS.includes('SubBizType'));
  });
});

test.describe('sheet 名常量', () => {
  test('RECON_RESULT_SHEET_NAME = 对账结果', () => {
    assert.equal(RECON_RESULT_SHEET_NAME, '对账结果');
  });

  test('BUSINESS_BILL_SHEET_NAME = 业务部门账单', () => {
    assert.equal(BUSINESS_BILL_SHEET_NAME, '业务部门账单');
  });

  test('OPPONENT_BILL_SHEET_NAME = 对手部门账单', () => {
    assert.equal(OPPONENT_BILL_SHEET_NAME, '对手部门账单');
  });

  test('ORDER_REPAIR_SHEET_NAME = 订单修复', () => {
    assert.equal(ORDER_REPAIR_SHEET_NAME, '订单修复');
  });
});
