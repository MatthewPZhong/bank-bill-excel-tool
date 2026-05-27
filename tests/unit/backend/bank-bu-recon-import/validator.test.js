const test = require('node:test');
const assert = require('node:assert/strict');

const {
  validatePendingGuanliHeaders,
  validateBankHeaders,
  normalizeHeaderCell
} = require('../../../../src/backend/bank-bu-recon-import/validator');
const {
  PENDING_GUANLI_HEADERS,
  BANK_HEADERS
} = require('../../../../src/backend/bank-bu-recon-db/columns');

// ========================================================================
// normalizeHeaderCell
// ========================================================================

test.describe('normalizeHeaderCell', () => {
  test('null / undefined → 空串', () => {
    assert.equal(normalizeHeaderCell(null), '');
    assert.equal(normalizeHeaderCell(undefined), '');
  });

  test('字符串 → trim', () => {
    assert.equal(normalizeHeaderCell('  abc  '), 'abc');
    assert.equal(normalizeHeaderCell('abc'), 'abc');
  });

  test('数字 → 字符串', () => {
    assert.equal(normalizeHeaderCell(123), '123');
  });

  test('空字符串 / 空白 → 空串', () => {
    assert.equal(normalizeHeaderCell(''), '');
    assert.equal(normalizeHeaderCell('   '), '');
  });
});

// ========================================================================
// validatePendingGuanliHeaders
// ========================================================================

test.describe('validatePendingGuanliHeaders — Pending 表头校验', () => {
  test('表头完全匹配 → ok', () => {
    const r = validatePendingGuanliHeaders([...PENDING_GUANLI_HEADERS]);
    assert.equal(r.ok, true);
  });

  test('非数组 → 报错', () => {
    const r = validatePendingGuanliHeaders('not array');
    assert.equal(r.ok, false);
    assert.match(r.error, /不可读/);
  });

  test('列数不匹配 → 报错并列模板/文件', () => {
    const r = validatePendingGuanliHeaders(['PendingBizId']);
    assert.equal(r.ok, false);
    assert.match(r.error, /列数不匹配/);
    assert.equal(r.detailLines.length, 2);
    assert.match(r.detailLines[0], /模板表头/);
    assert.match(r.detailLines[1], /文件表头/);
  });

  test('第 1 列差异 → 报错具体差异', () => {
    const headers = [...PENDING_GUANLI_HEADERS];
    headers[0] = 'X';
    const r = validatePendingGuanliHeaders(headers);
    assert.equal(r.ok, false);
    assert.match(r.error, /第 1 列不匹配/);
    assert.equal(r.detailLines.length, 1);
  });

  test('多列差异 → 全列出', () => {
    const headers = [...PENDING_GUANLI_HEADERS];
    headers[0] = 'X';
    headers[2] = 'Y';
    const r = validatePendingGuanliHeaders(headers);
    assert.equal(r.ok, false);
    assert.equal(r.detailLines.length, 2);
  });

  test('表头前后空白 → trim 后比较 → ok', () => {
    const headers = PENDING_GUANLI_HEADERS.map((h) => `  ${h}  `);
    const r = validatePendingGuanliHeaders(headers);
    assert.equal(r.ok, true);
  });
});

// ========================================================================
// validateBankHeaders
// ========================================================================

test.describe('validateBankHeaders — 银行对账单表头校验', () => {
  test('表头完全匹配 → ok', () => {
    const r = validateBankHeaders([...BANK_HEADERS]);
    assert.equal(r.ok, true);
  });

  test('非数组 → 报错', () => {
    const r = validateBankHeaders(null);
    assert.equal(r.ok, false);
  });

  test('列数不匹配 → 报错', () => {
    const r = validateBankHeaders([]);
    assert.equal(r.ok, false);
    assert.match(r.error, /列数不匹配/);
  });

  test('内容不匹配 → 报错', () => {
    const headers = [...BANK_HEADERS];
    headers[0] = 'X';
    const r = validateBankHeaders(headers);
    assert.equal(r.ok, false);
    assert.match(r.error, /第 1 列不匹配/);
  });
});
