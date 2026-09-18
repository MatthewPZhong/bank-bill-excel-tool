'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { projectionCell, rawCell, historicCell } = require('../../../../src/backend/vcc-financial-op/review-export-contract');
const { projectReview, formatAmount, CURRENCIES } = require('../../../../src/shared/vcc-review-projection');

test('金额输出坚持精确往返和页面显示：15 位、16 位、极小数、正负零、尾零及科学计数法', () => {
  const examples = [
    ['1234.56', 'number', '#,##0.00'], ['123456789012345', 'number', '#,##0'],
    ['1234567890123456', 'text', '@'], ['0.000000000000000001', 'number', '#,##0.000000000000000000'],
    ['0', 'number', '#,##0'], ['-0.00', 'text', '@'], ['+0', 'text', '@'],
    ['1.2300', 'number', '#,##0.0000'], ['1e-400', 'text', '@'], ['1e+5', 'text', '@']
  ];
  for (const [value, type, format] of examples) {
    const cell = projectionCell({ kind: 'amount', value, display: formatAmount(value) });
    assert.equal(cell.t, type, value); assert.equal(cell.f, format, value); assert.equal(cell.semantic, value);
    if (type === 'text') assert.equal(cell.v, formatAmount(value));
  }
});
test('所有主体按页面行序展开；四个汇总位于明细与调整之后，零差异显示短横线', () => {
  const amount = Object.fromEntries(CURRENCIES.map((c) => [c, '0']));
  const makeSubject = (subject) => ({ subject, rows: [{ type: 'base', subject, categoryMajor: '大类', categoryMinor: '明细', sourceType: 'channel', currencyAmounts: { USD: '1234' } },
    { type: 'adjustment', subject, categoryMajor: '大类', categoryMinor: '明细', sourceType: 'channel', currency: 'USD', currencyAmounts: { USD: '-1' }, adjustmentAmount: '-1', reason: '复核说明' }],
    summaries: { openingBalance: amount, effectiveCalculatedBalance: amount, systemBalance: amount, effectiveDifference: amount } });
  const projection = projectReview({ currencies: CURRENCIES, subjects: [makeSubject('乙'), makeSubject('甲')] });
  assert.deepEqual(projection.blocks.map((b) => b.subject), ['乙','甲']);
  assert.deepEqual(projection.rows.map((r) => r.kind), ['title','header','detail','adjustment','summary','summary','summary','summary','spacer',
    'title','header','detail','adjustment','summary','summary','summary','summary']);
  assert.equal(projection.rows[2].cells[11].display, '1,234');
  assert.equal(projection.rows[3].cells[2].display, '明细\nVCC通道明细\n人工调整');
  assert.equal(projection.rows[7].cells[11].display, '-');
  assert.equal(projection.rows[4].cells[11].display, '0');
});
test('原表文本不推断类型；公式缺缓存或历史值类型不可验证时拒绝', () => {
  for (const value of ['00001', '1234567890123456789', '=1+1', '+cmd', '1.0000']) {
    assert.deepEqual(rawCell({ cellType: 'text', decodedSemanticValue: value }, '金额'), { t: 'text', v: value, f: '@' });
  }
  assert.throws(() => rawCell({ cellType: 'blank', hasFormula: true }), { code: 'vcc-review-source-unavailable' });
  assert.throws(() => historicCell({ formula: '1+1' }), { code: 'vcc-review-source-unavailable' });
});
