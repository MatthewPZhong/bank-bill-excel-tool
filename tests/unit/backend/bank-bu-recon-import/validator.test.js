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

// 注意（v3.0.8 迭代2-B 🔴资金红线）：银行对账单校验由"严格列数+逐列名相等"改为
// "宽容超集模式"（allowSupersetColumns=true），以兼容新版 46 列文件（'Transaction Description'
// 后插入「合并单号」「合并状态」）。多出的列被忽略、不落库。下列断言对应"新契约"。
test.describe('validateBankHeaders — 银行对账单表头校验（宽容超集模式）', () => {
  test('表头完全匹配（44 列）→ ok', () => {
    const r = validateBankHeaders([...BANK_HEADERS]);
    assert.equal(r.ok, true);
  });

  test('新版 46 列：Transaction Description 后插入 合并单号/合并状态 → ok（忽略多余列）', () => {
    const headers = [...BANK_HEADERS];
    const at = headers.indexOf('Transaction Description');
    headers.splice(at + 1, 0, '合并单号', '合并状态');
    assert.equal(headers.length, 46);
    const r = validateBankHeaders(headers);
    assert.equal(r.ok, true);
  });

  test('多余列出现在任意位置（仍是模板有序子序列）→ ok', () => {
    const headers = [...BANK_HEADERS, '额外列A'];
    headers.unshift('额外列B');
    const r = validateBankHeaders(headers);
    assert.equal(r.ok, true);
  });

  test('非数组 → 报错', () => {
    const r = validateBankHeaders(null);
    assert.equal(r.ok, false);
  });

  test('缺模板列 → 报错并指明缺失列名', () => {
    const headers = [...BANK_HEADERS].filter((h) => h !== 'Remark-BU');
    const r = validateBankHeaders(headers);
    assert.equal(r.ok, false);
    assert.match(r.error, /缺失模板列/);
    assert.match(r.error, /Remark-BU/);
  });

  test('空数组（所有模板列缺失）→ 报错', () => {
    const r = validateBankHeaders([]);
    assert.equal(r.ok, false);
    assert.match(r.error, /缺失模板列/);
  });

  test('列乱序（破坏相对顺序）→ 报错（防乱序文件）', () => {
    const headers = [...BANK_HEADERS];
    const a = headers.indexOf('Currency');
    const b = headers.indexOf('MerchantId');
    [headers[a], headers[b]] = [headers[b], headers[a]];
    const r = validateBankHeaders(headers);
    assert.equal(r.ok, false);
    assert.match(r.error, /顺序错乱|缺失/);
  });
});
