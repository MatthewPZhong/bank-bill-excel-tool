const test = require('node:test');
const assert = require('node:assert/strict');

const {
  validateFlowHeaders,
  validateBillHeaders,
  extractMonthKey,
  normalizeBillDate,
  validateMonthConsistency
} = require('../../../../src/backend/acquiring-bill-currency-import/validator');
const {
  FLOW_HEADERS,
  BILL_HEADERS
} = require('../../../../src/backend/acquiring-bill-currency-db/columns');

// ========================================================================
// validateFlowHeaders / validateBillHeaders
// ========================================================================

test.describe('validateFlowHeaders — 收单流水表头校验', () => {
  test('表头完全匹配 → ok', () => {
    const r = validateFlowHeaders([...FLOW_HEADERS]);
    assert.equal(r.ok, true);
  });

  test('非数组 → 报错', () => {
    const r = validateFlowHeaders(null);
    assert.equal(r.ok, false);
    assert.match(r.error, /不可读/);
  });

  test('列数不匹配 → 报错', () => {
    const r = validateFlowHeaders(['账单日期', 'originBizId']);
    assert.equal(r.ok, false);
    assert.match(r.error, /列数不匹配/);
    assert.equal(r.detailLines.length, 2);
  });

  test('单列内容不匹配 → 报错并列差异', () => {
    const headers = [...FLOW_HEADERS];
    headers[0] = '日期'; // 第 1 列：账单日期 → 日期
    const r = validateFlowHeaders(headers);
    assert.equal(r.ok, false);
    assert.match(r.error, /内容不匹配/);
    assert.equal(r.detailLines.length, 1);
    assert.match(r.detailLines[0], /第 1 列/);
  });

  test('多列差异 → 全列出', () => {
    const headers = [...FLOW_HEADERS];
    headers[0] = 'X';
    headers[1] = 'Y';
    const r = validateFlowHeaders(headers);
    assert.equal(r.ok, false);
    assert.equal(r.detailLines.length, 2);
  });

  test('表头单元格前后空白 → trim 后比较', () => {
    const headers = [...FLOW_HEADERS];
    headers[0] = `  ${FLOW_HEADERS[0]}  `;
    const r = validateFlowHeaders(headers);
    assert.equal(r.ok, true);
  });
});

test.describe('validateBillHeaders — 收单流水单据表头校验', () => {
  test('表头完全匹配 → ok', () => {
    const r = validateBillHeaders([...BILL_HEADERS]);
    assert.equal(r.ok, true);
  });

  test('列数不匹配 → 报错', () => {
    const r = validateBillHeaders([]);
    assert.equal(r.ok, false);
    assert.match(r.error, /列数不匹配/);
  });
});

// ========================================================================
// extractMonthKey
// ========================================================================

test.describe('extractMonthKey — 账单日期 → YYYY-MM', () => {
  test('标准 YYYY-MM-DD → YYYY-MM', () => {
    assert.equal(extractMonthKey('2026-03-10'), '2026-03');
  });

  test('单位月 YYYY-M-DD → 补 0', () => {
    assert.equal(extractMonthKey('2026-3-10'), '2026-03');
  });

  test('YYYY/MM/DD → YYYY-MM', () => {
    assert.equal(extractMonthKey('2026/03/10'), '2026-03');
  });

  test('YYYY-MM-DD HH:mm:ss → YYYY-MM', () => {
    assert.equal(extractMonthKey('2026-03-10 03:45:56'), '2026-03');
  });

  test('YYYY-MM 仅前缀 → YYYY-MM', () => {
    assert.equal(extractMonthKey('2026-03'), '2026-03');
  });

  test('非法日期串 → null', () => {
    assert.equal(extractMonthKey('not-a-date'), null);
    assert.equal(extractMonthKey('20260310'), null);
  });

  test('null / undefined / 空 → null', () => {
    assert.equal(extractMonthKey(null), null);
    assert.equal(extractMonthKey(undefined), null);
    assert.equal(extractMonthKey(''), null);
    assert.equal(extractMonthKey('  '), null);
  });
});

// ========================================================================
// normalizeBillDate
// ========================================================================

test.describe('normalizeBillDate — 账单日期归一为 YYYY-MM-DD', () => {
  test('YYYY-MM-DD → 原样', () => {
    assert.equal(normalizeBillDate('2026-03-10'), '2026-03-10');
  });

  test('YYYY/MM/DD → YYYY-MM-DD（替换斜杠 + 补 0）', () => {
    assert.equal(normalizeBillDate('2026/3/10'), '2026-03-10');
    assert.equal(normalizeBillDate('2026/03/10'), '2026-03-10');
  });

  test('YYYY-M-D → 补 0', () => {
    assert.equal(normalizeBillDate('2026-3-1'), '2026-03-01');
  });

  test('YYYY-MM-DD HH:mm:ss → 截取日期段', () => {
    assert.equal(normalizeBillDate('2026-03-10 03:45:56'), '2026-03-10');
  });

  test('null / 空 → 空串', () => {
    assert.equal(normalizeBillDate(null), '');
    assert.equal(normalizeBillDate(undefined), '');
    assert.equal(normalizeBillDate(''), '');
    assert.equal(normalizeBillDate('   '), '');
  });

  test('无法解析 → 返回原值（reader 已 extractMonthKey 校验）', () => {
    assert.equal(normalizeBillDate('not-a-date'), 'not-a-date');
  });
});

// ========================================================================
// validateMonthConsistency
// ========================================================================

test.describe('validateMonthConsistency — 同批同月校验', () => {
  test('全部同月 → ok + monthKey', () => {
    const rows = [
      { billDateRaw: '2026-03-10', sourceFile: 'a.xlsx', sourceRowIndex: 2 },
      { billDateRaw: '2026-03-15', sourceFile: 'a.xlsx', sourceRowIndex: 3 },
      { billDateRaw: '2026-03-20', sourceFile: 'a.xlsx', sourceRowIndex: 4 }
    ];
    const r = validateMonthConsistency(rows);
    assert.equal(r.ok, true);
    assert.equal(r.monthKey, '2026-03');
  });

  test('空数组 → ok=false（导入数据为空）', () => {
    const r = validateMonthConsistency([]);
    assert.equal(r.ok, false);
    assert.match(r.error, /为空/);
  });

  test('非数组 → ok=false', () => {
    const r = validateMonthConsistency(null);
    assert.equal(r.ok, false);
  });

  test('日期格式坏 → 报错（列前 5 行）', () => {
    const rows = [
      { billDateRaw: 'invalid', sourceFile: 'a.xlsx', sourceRowIndex: 2 },
      { billDateRaw: '2026-03-10', sourceFile: 'a.xlsx', sourceRowIndex: 3 }
    ];
    const r = validateMonthConsistency(rows);
    assert.equal(r.ok, false);
    assert.match(r.error, /账单日期格式无法解析/);
    assert.equal(r.detailLines.length, 1);
  });

  test('跨多月 → 报错 + 按行数降序列出', () => {
    const rows = [
      { billDateRaw: '2026-03-01', sourceFile: 'a.xlsx', sourceRowIndex: 2 },
      { billDateRaw: '2026-03-02', sourceFile: 'a.xlsx', sourceRowIndex: 3 },
      { billDateRaw: '2026-04-01', sourceFile: 'a.xlsx', sourceRowIndex: 4 }
    ];
    const r = validateMonthConsistency(rows);
    assert.equal(r.ok, false);
    assert.match(r.error, /同一批导入跨多个月份/);
    assert.equal(r.detailLines.length, 2);
    // 排序：2026-03 (2 行) > 2026-04 (1 行)
    assert.match(r.detailLines[0], /2026-03/);
    assert.match(r.detailLines[0], /2 行/);
    assert.match(r.detailLines[1], /2026-04/);
  });

  test('单月单行 → ok', () => {
    const rows = [{ billDateRaw: '2026-03-10', sourceFile: 'a.xlsx', sourceRowIndex: 2 }];
    const r = validateMonthConsistency(rows);
    assert.equal(r.ok, true);
    assert.equal(r.monthKey, '2026-03');
  });
});
