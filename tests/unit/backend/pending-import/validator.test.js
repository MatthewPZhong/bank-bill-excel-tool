const test = require('node:test');
const assert = require('node:assert/strict');

const {
  validateHeaders,
  computeRowHash
} = require('../../../../src/backend/pending-import/validator');
const PENDING_COLUMNS = require('../../../../src/backend/pending-db/columns');

// ========================================================================
// validateHeaders
// ========================================================================

test.describe('validateHeaders — Pending 31 列表头校验', () => {
  test('表头完全匹配 → ok', () => {
    const r = validateHeaders([...PENDING_COLUMNS]);
    assert.equal(r.ok, true);
  });

  test('非数组 → 报错', () => {
    const r = validateHeaders(null);
    assert.equal(r.ok, false);
    assert.match(r.error, /不可读/);
  });

  test('列数不匹配 → 报错', () => {
    const r = validateHeaders(['pending类型', 'extra']);
    assert.equal(r.ok, false);
    assert.match(r.error, /列数不匹配/);
  });

  test('第 1 列不匹配 → 报错具体位置', () => {
    const headers = [...PENDING_COLUMNS];
    headers[0] = 'X';
    const r = validateHeaders(headers);
    assert.equal(r.ok, false);
    assert.match(r.error, /第 1 列不匹配/);
    assert.match(r.error, /pending类型/);
  });

  test('表头严格相等（不 trim — 与 bank-bu / biz-op 验证不同）', () => {
    // Pending validator 直接 === 比较（不调 normalizeHeaderCell）
    const headers = [...PENDING_COLUMNS];
    headers[0] = `  ${PENDING_COLUMNS[0]}  `;
    const r = validateHeaders(headers);
    assert.equal(r.ok, false, 'Pending validator 不 trim 表头 → 多空格被视作差异');
  });
});

// ========================================================================
// computeRowHash
// ========================================================================

test.describe('computeRowHash — sha1 行 hash', () => {
  test('相同输入 → 相同 hash', () => {
    const h1 = computeRowHash(['A', 'B', 'C']);
    const h2 = computeRowHash(['A', 'B', 'C']);
    assert.equal(h1, h2);
  });

  test('不同输入 → 不同 hash', () => {
    const h1 = computeRowHash(['A', 'B', 'C']);
    const h2 = computeRowHash(['A', 'B', 'D']);
    assert.notEqual(h1, h2);
  });

  test('hash 长度 = 40（sha1 hex）', () => {
    const h = computeRowHash(['X']);
    assert.equal(h.length, 40);
  });

  test('null / undefined 视作空串', () => {
    const h1 = computeRowHash([null, undefined, '']);
    const h2 = computeRowHash(['', '', '']);
    assert.equal(h1, h2);
  });

  test('数字转字符串', () => {
    const h1 = computeRowHash([123]);
    const h2 = computeRowHash(['123']);
    assert.equal(h1, h2);
  });

  test('SOH 分隔符防边界混淆：["AB", "CD"] ≠ ["A", "BCD"]', () => {
    // 关键防护：分隔符是 ，列值不会出现该字符 → 防 "AB"+"CD" 和 "A"+"BCD" 同 hash
    const h1 = computeRowHash(['AB', 'CD']);
    const h2 = computeRowHash(['A', 'BCD']);
    assert.notEqual(h1, h2);
  });

  test('空数组 → 仍能算 hash', () => {
    const h = computeRowHash([]);
    assert.equal(h.length, 40);
  });

  test('列数不同 → hash 不同', () => {
    const h1 = computeRowHash(['A', 'B']);
    const h2 = computeRowHash(['A', 'B', '']);
    assert.notEqual(h1, h2);
  });
});
