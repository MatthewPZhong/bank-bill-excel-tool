const test = require('node:test');
const assert = require('node:assert/strict');

const {
  AMOUNT_EPSILON,
  VALID_DIRECTION_IN,
  VALID_DIRECTION_OUT,
  validateBizOpHeaders,
  validateFlowHeaders,
  validateBizOpRow,
  validateFlowRow,
  parseAmount,
  normalizeHeaderCell
} = require('../../../../src/backend/biz-op-recon-import/validator');
const {
  BIZ_OP_HEADERS,
  FLOW_HEADERS
} = require('../../../../src/backend/biz-op-recon-db/columns');

// ========================================================================
// 常量
// ========================================================================

test.describe('常量', () => {
  test('AMOUNT_EPSILON = 0.01（1 分钱容差）', () => {
    assert.equal(AMOUNT_EPSILON, 1e-2);
  });

  test('VALID_DIRECTION_IN / OUT', () => {
    assert.equal(VALID_DIRECTION_IN, '入');
    assert.equal(VALID_DIRECTION_OUT, '出');
  });
});

// ========================================================================
// parseAmount / normalizeHeaderCell
// ========================================================================

test.describe('parseAmount', () => {
  test('数字直通', () => {
    assert.equal(parseAmount(100.5), 100.5);
    assert.equal(parseAmount(0), 0);
  });

  test('字符串数字 → 数字', () => {
    assert.equal(parseAmount('123.45'), 123.45);
    assert.equal(parseAmount('  -99.9  '), -99.9);
  });

  test('千分位字符串 → 去逗号', () => {
    assert.equal(parseAmount('1,234.56'), 1234.56);
  });

  test('null / undefined / 空 → NaN', () => {
    assert.ok(Number.isNaN(parseAmount(null)));
    assert.ok(Number.isNaN(parseAmount(undefined)));
    assert.ok(Number.isNaN(parseAmount('')));
  });

  test('非法字符串 → NaN', () => {
    assert.ok(Number.isNaN(parseAmount('abc')));
  });
});

test.describe('normalizeHeaderCell', () => {
  test('null/undefined → 空串', () => {
    assert.equal(normalizeHeaderCell(null), '');
    assert.equal(normalizeHeaderCell(undefined), '');
  });

  test('字符串 → trim', () => {
    assert.equal(normalizeHeaderCell('  abc  '), 'abc');
  });
});

// ========================================================================
// validateBizOpHeaders / validateFlowHeaders
// ========================================================================

test.describe('validateBizOpHeaders — 业务 OP 账单表头', () => {
  test('表头完全匹配 → ok', () => {
    const r = validateBizOpHeaders([...BIZ_OP_HEADERS]);
    assert.equal(r.ok, true);
  });

  test('非数组 → 报错', () => {
    const r = validateBizOpHeaders(null);
    assert.equal(r.ok, false);
    assert.match(r.error, /不可读/);
  });

  test('列数不匹配 → 报错', () => {
    const r = validateBizOpHeaders([]);
    assert.equal(r.ok, false);
    assert.match(r.error, /列数不匹配/);
  });

  test('内容不匹配 → 报错', () => {
    const headers = [...BIZ_OP_HEADERS];
    headers[0] = '日期';
    const r = validateBizOpHeaders(headers);
    assert.equal(r.ok, false);
    assert.match(r.error, /第 1 列不匹配/);
  });
});

test.describe('validateFlowHeaders — 流水对账单表头', () => {
  test('表头完全匹配 → ok', () => {
    const r = validateFlowHeaders([...FLOW_HEADERS]);
    assert.equal(r.ok, true);
  });

  test('多列差异 → 全列出', () => {
    const headers = [...FLOW_HEADERS];
    headers[0] = 'X';
    headers[1] = 'Y';
    const r = validateFlowHeaders(headers);
    assert.equal(r.ok, false);
    assert.equal(r.detailLines.length, 2);
  });
});

// ========================================================================
// validateBizOpRow — 双重校验（资金红线 ⚠️）
// ========================================================================

test.describe('validateBizOpRow — 业务 OP 行双重校验', () => {
  test('合法行（双重校验通过）→ ok', () => {
    const r = validateBizOpRow({
      begin_balance: 100,
      amount: 50,
      amount_in: 80,
      amount_out: 30,
      end_balance: 150
    });
    assert.equal(r.ok, true);
  });

  test('校验 (1) 失败：发生额 ≠ 入 - 出 → ok=false', () => {
    const r = validateBizOpRow({
      begin_balance: 100,
      amount: 50, // 错的：应该 80 - 30 = 50（这里仍是 50 — 故意构造错的）
      amount_in: 100, // 入 100
      amount_out: 30, // 出 30 → 入-出 = 70 ≠ amount 50 → 校验 1 失败
      end_balance: 150
    });
    assert.equal(r.ok, false);
    assert.match(r.reason, /发生额.*≠.*发生额\(入\)/);
  });

  test('校验 (2) 失败：期末 ≠ 期初 + 发生额 → ok=false', () => {
    const r = validateBizOpRow({
      begin_balance: 100,
      amount: 50,
      amount_in: 80,
      amount_out: 30,
      end_balance: 200 // 错的：应该 100 + 50 = 150
    });
    assert.equal(r.ok, false);
    assert.match(r.reason, /期末余额.*≠.*期初余额/);
  });

  test('字段非数值 → ok=false', () => {
    const r = validateBizOpRow({
      begin_balance: 'abc',
      amount: 50,
      amount_in: 80,
      amount_out: 30,
      end_balance: 150
    });
    assert.equal(r.ok, false);
    assert.match(r.reason, /字段非数值/);
  });

  test('epsilon 边界：差额 0.005 < epsilon 0.01 → ok（在容差内）', () => {
    const r = validateBizOpRow({
      begin_balance: 100,
      amount: 50.005, // 差额 0.005 < 0.01 → 校验 2 在容差内
      amount_in: 80,
      amount_out: 30.005, // 80 - 30.005 = 49.995；发生额 50.005 - 49.995 = 0.01 → 边界
      end_balance: 150.005
    });
    // 校验 1: |50.005 - (80 - 30.005)| = |50.005 - 49.995| = 0.01 = epsilon → 严格大于才 fail，所以 ok
    // 校验 2: |150.005 - (100 + 50.005)| = 0 → ok
    assert.equal(r.ok, true);
  });

  test('epsilon 边界：差额 0.02 > epsilon → ok=false', () => {
    const r = validateBizOpRow({
      begin_balance: 100,
      amount: 50,
      amount_in: 80,
      amount_out: 30,
      end_balance: 150.02 // 差 0.02 > 0.01 → 校验 2 fail
    });
    assert.equal(r.ok, false);
  });

  test('字符串数字（千分位）→ 解析后双重校验', () => {
    const r = validateBizOpRow({
      begin_balance: '1,000',
      amount: '500',
      amount_in: '800',
      amount_out: '300',
      end_balance: '1,500'
    });
    assert.equal(r.ok, true);
  });
});

// ========================================================================
// validateFlowRow
// ========================================================================

test.describe('validateFlowRow — 流水对账单行校验', () => {
  test('合法 入 方向 + 数值 + 账户 → ok', () => {
    const r = validateFlowRow({
      direction: '入',
      recon_amount: 100.5,
      account_no: 'ACC001'
    });
    assert.equal(r.ok, true);
  });

  test('合法 出 方向 → ok', () => {
    const r = validateFlowRow({
      direction: '出',
      recon_amount: 50,
      account_no: 'ACC001'
    });
    assert.equal(r.ok, true);
  });

  test('方向带空白 → trim 后允许', () => {
    const r = validateFlowRow({
      direction: '  入  ',
      recon_amount: 100,
      account_no: 'ACC001'
    });
    assert.equal(r.ok, true);
  });

  test('方向非法（IN/OUT）→ ok=false', () => {
    const r = validateFlowRow({
      direction: 'IN',
      recon_amount: 100,
      account_no: 'ACC001'
    });
    assert.equal(r.ok, false);
    assert.match(r.reason, /出入方向非法/);
  });

  test('方向 null → ok=false', () => {
    const r = validateFlowRow({
      direction: null,
      recon_amount: 100,
      account_no: 'ACC001'
    });
    assert.equal(r.ok, false);
    assert.match(r.reason, /出入方向非法/);
  });

  test('金额非数值 → ok=false', () => {
    const r = validateFlowRow({
      direction: '入',
      recon_amount: 'abc',
      account_no: 'ACC001'
    });
    assert.equal(r.ok, false);
    assert.match(r.reason, /对账金额非数值/);
  });

  test('账户号空 → ok=false', () => {
    const r = validateFlowRow({
      direction: '入',
      recon_amount: 100,
      account_no: ''
    });
    assert.equal(r.ok, false);
    assert.match(r.reason, /账户编号为空/);
  });

  test('账户号 null → ok=false', () => {
    const r = validateFlowRow({
      direction: '入',
      recon_amount: 100,
      account_no: null
    });
    assert.equal(r.ok, false);
    assert.match(r.reason, /账户编号为空/);
  });

  test('账户号纯空格 → ok=false', () => {
    const r = validateFlowRow({
      direction: '入',
      recon_amount: 100,
      account_no: '   '
    });
    assert.equal(r.ok, false);
    assert.match(r.reason, /账户编号为空/);
  });
});
