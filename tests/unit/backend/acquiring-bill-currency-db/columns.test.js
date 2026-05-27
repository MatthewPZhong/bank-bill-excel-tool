const test = require('node:test');
const assert = require('node:assert/strict');

const {
  FLOW_HEADERS,
  FLOW_KEY_COLUMNS,
  FLOW_KEY_COLUMN_INDICES,
  BILL_HEADERS,
  BILL_KEY_COLUMNS,
  BILL_KEY_COLUMN_INDICES,
  WRITER_OUTPUT_HEADERS,
  WRITER_OUTPUT_HEADERS_V2,
  TEMPLATE_BILL_HEADERS,
  WRITER_OUTPUT_BILL_COPY_HEADER,
  WRITER_OUTPUT_FLOW_CURRENCY_HEADER,
  WRITER_OUTPUT_FLOW_AMOUNT_ABS_HEADER
} = require('../../../../src/backend/acquiring-bill-currency-db/columns');

// ========================================================================
// FLOW_HEADERS — 收单流水表 48 列
// ========================================================================

test.describe('FLOW_HEADERS — 48 列', () => {
  test('Object.freeze 锁死', () => {
    assert.ok(Object.isFrozen(FLOW_HEADERS));
  });

  test('恰好 48 列', () => {
    assert.equal(FLOW_HEADERS.length, 48);
  });

  test('字段名唯一', () => {
    assert.equal(new Set(FLOW_HEADERS).size, FLOW_HEADERS.length, '48 列必须全部唯一');
  });

  test('包含核心字段', () => {
    assert.ok(FLOW_HEADERS.includes('账单日期'));
    assert.ok(FLOW_HEADERS.includes('对账主Id'));
    assert.ok(FLOW_HEADERS.includes('通道清算金额'));
    assert.ok(FLOW_HEADERS.includes('通道清算币种'));
  });
});

test.describe('FLOW_KEY_COLUMNS / FLOW_KEY_COLUMN_INDICES — 关键字段', () => {
  test('keys = billDate / reconMainId / settleAmount / settleCurrency', () => {
    assert.deepEqual(Object.keys(FLOW_KEY_COLUMNS).sort(), ['billDate', 'reconMainId', 'settleAmount', 'settleCurrency']);
  });

  test('FLOW_KEY_COLUMN_INDICES 与 FLOW_HEADERS 同步', () => {
    assert.equal(FLOW_KEY_COLUMN_INDICES.billDate, FLOW_HEADERS.indexOf('账单日期'));
    assert.equal(FLOW_KEY_COLUMN_INDICES.reconMainId, FLOW_HEADERS.indexOf('对账主Id'));
    assert.equal(FLOW_KEY_COLUMN_INDICES.settleAmount, FLOW_HEADERS.indexOf('通道清算金额'));
    assert.equal(FLOW_KEY_COLUMN_INDICES.settleCurrency, FLOW_HEADERS.indexOf('通道清算币种'));
  });

  test('所有索引值 ≥ 0（不能是 -1 = 未找到）', () => {
    Object.values(FLOW_KEY_COLUMN_INDICES).forEach((v) => {
      assert.ok(v >= 0, `索引必须 ≥ 0：${v}`);
    });
  });
});

// ========================================================================
// BILL_HEADERS — 收单流水单据表 26 列
// ========================================================================

test.describe('BILL_HEADERS — 26 列', () => {
  test('Object.freeze 锁死', () => {
    assert.ok(Object.isFrozen(BILL_HEADERS));
  });

  test('恰好 26 列', () => {
    assert.equal(BILL_HEADERS.length, 26);
  });

  test('字段名唯一', () => {
    assert.equal(new Set(BILL_HEADERS).size, BILL_HEADERS.length);
  });

  test('包含核心字段', () => {
    assert.ok(BILL_HEADERS.includes('主对账Id'));
    assert.ok(BILL_HEADERS.includes('对账金额'));
    assert.ok(BILL_HEADERS.includes('对账币种'));
  });
});

test.describe('BILL_KEY_COLUMNS / BILL_KEY_COLUMN_INDICES', () => {
  test('keys = billDate / reconMainId / reconAmount / settleCurrency', () => {
    assert.deepEqual(Object.keys(BILL_KEY_COLUMNS).sort(), ['billDate', 'reconAmount', 'reconMainId', 'settleCurrency']);
  });

  test('索引与 BILL_HEADERS 同步', () => {
    assert.equal(BILL_KEY_COLUMN_INDICES.billDate, BILL_HEADERS.indexOf('账单日期'));
    assert.equal(BILL_KEY_COLUMN_INDICES.reconMainId, BILL_HEADERS.indexOf('主对账Id'));
    assert.equal(BILL_KEY_COLUMN_INDICES.reconAmount, BILL_HEADERS.indexOf('对账金额'));
    assert.equal(BILL_KEY_COLUMN_INDICES.settleCurrency, BILL_HEADERS.indexOf('对账币种'));
  });
});

// ========================================================================
// WRITER_OUTPUT_HEADERS / V2
// ========================================================================

test.describe('WRITER_OUTPUT_HEADERS — v2.1.7 之前 29 列（deprecated）', () => {
  test('Object.freeze 锁死', () => {
    assert.ok(Object.isFrozen(WRITER_OUTPUT_HEADERS));
  });

  test('= BILL_HEADERS (26) + 3 个差异输出列 = 29 列', () => {
    assert.equal(WRITER_OUTPUT_HEADERS.length, 29);
  });

  test('尾部 3 列 = bill_copy / flow_currency / flow_amount_abs', () => {
    assert.equal(WRITER_OUTPUT_HEADERS[26], WRITER_OUTPUT_BILL_COPY_HEADER);
    assert.equal(WRITER_OUTPUT_HEADERS[27], WRITER_OUTPUT_FLOW_CURRENCY_HEADER);
    assert.equal(WRITER_OUTPUT_HEADERS[28], WRITER_OUTPUT_FLOW_AMOUNT_ABS_HEADER);
  });
});

test.describe('WRITER_OUTPUT_HEADERS_V2 — v2.1.8 N4 瘦身 12 列', () => {
  test('Object.freeze 锁死', () => {
    assert.ok(Object.isFrozen(WRITER_OUTPUT_HEADERS_V2));
  });

  test('恰好 12 列', () => {
    assert.equal(WRITER_OUTPUT_HEADERS_V2.length, 12);
  });

  test('= TEMPLATE_BILL_HEADERS (9) + 3 个差异输出列 = 12 列', () => {
    assert.equal(TEMPLATE_BILL_HEADERS.length, 9);
    assert.equal(WRITER_OUTPUT_HEADERS_V2.length, TEMPLATE_BILL_HEADERS.length + 3);
  });

  test('尾部 3 列 = bill_copy / flow_currency / flow_amount_abs', () => {
    assert.equal(WRITER_OUTPUT_HEADERS_V2[9], WRITER_OUTPUT_BILL_COPY_HEADER);
    assert.equal(WRITER_OUTPUT_HEADERS_V2[10], WRITER_OUTPUT_FLOW_CURRENCY_HEADER);
    assert.equal(WRITER_OUTPUT_HEADERS_V2[11], WRITER_OUTPUT_FLOW_AMOUNT_ABS_HEADER);
  });
});

test.describe('差异输出列名常量（⚠️ 资金红线 hardcode）', () => {
  test('WRITER_OUTPUT_BILL_COPY_HEADER = 单据_对账币种', () => {
    assert.equal(WRITER_OUTPUT_BILL_COPY_HEADER, '单据_对账币种');
  });

  test('WRITER_OUTPUT_FLOW_CURRENCY_HEADER = 流水_通道清算币种（v0.7 fix4）', () => {
    assert.equal(WRITER_OUTPUT_FLOW_CURRENCY_HEADER, '流水_通道清算币种');
  });

  test('WRITER_OUTPUT_FLOW_AMOUNT_ABS_HEADER = 流水_通道清算金额（v0.7 fix4）', () => {
    assert.equal(WRITER_OUTPUT_FLOW_AMOUNT_ABS_HEADER, '流水_通道清算金额');
  });
});
