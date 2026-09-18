(function init(root, factory) {
  const difference = typeof module === 'object' && module.exports
    ? require('./vcc-financial-op-difference') : root.__vccFinancialOpDifference;
  const api = factory(difference);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.__vccReviewProjection = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function createProjection(difference) {
  'use strict';
  const CURRENCIES = Object.freeze(['AUD', 'CAD', 'CNY', 'EUR', 'GBP', 'HKD', 'JPY', 'SGD', 'USD']);
  const HEADERS = Object.freeze(['主体', '大类', '分类', ...CURRENCIES, '调整值', '调整原因']);
  const SUMMARIES = Object.freeze([['openingBalance', '期初财务OP'], ['effectiveCalculatedBalance', '当月计算财务OP'],
    ['systemBalance', '系统财务OP'], ['effectiveDifference', '差异']]);
  const LABELS = { recharge_refund: 'VCC充值清退明细', fee_fx: 'VCC费用及换汇明细', channel: 'VCC通道明细',
    pending_archive_removal: 'VCC_移除归档Pending账单', system_op: '系统财务OP' };
  function formatAmount(value) {
    const text = String(value == null ? '0' : value);
    const match = text.match(/^(-?)(\d+)(\.\d+)?$/);
    return match ? `${match[1]}${match[2].replace(/\B(?=(\d{3})+(?!\d))/g, ',')}${match[3] || ''}` : text;
  }
  const textCell = (value) => ({ kind: 'text', value: String(value ?? ''), display: String(value ?? '') });
  function amountCell(value, zeroAsDash = false) {
    if (value === null || value === undefined) return textCell('-');
    difference.assertCanonicalDifference(value);
    return { kind: 'amount', value, display: zeroAsDash && difference.isEffectiveDifferenceZero(value) ? '-' : formatAmount(value) };
  }
  function projectReview(review) {
    if (JSON.stringify(review?.currencies) !== JSON.stringify(CURRENCIES) || !review.subjects?.length) throw new Error('确认页主体或币种合同无效');
    const rows = [], blocks = [], seen = new Set();
    const push = (row) => { row.rowNumber = rows.length + 1; rows.push(row); return row; };
    for (const subjectResult of review.subjects) {
      const subject = subjectResult.subject;
      if (typeof subject !== 'string' || !subject.trim() || seen.has(subject)) throw new Error('确认页主体为空或重复');
      seen.add(subject);
      if (rows.length) push({ kind: 'spacer', cells: [] });
      const balanced = CURRENCIES.map((currency) => difference.isEffectiveDifferenceZero(subjectResult.summaries.effectiveDifference[currency]));
      const title = push({ kind: 'title', subject, cells: [textCell(subject)] });
      push({ kind: 'header', subject, balanced, cells: HEADERS.map(textCell) });
      const bodyRows = [];
      for (const original of subjectResult.rows || []) {
        const adjustment = original.type === 'adjustment';
        const sourceLabel = original.sourceLabel || LABELS[original.sourceType] || original.sourceType || '-';
        const categoryMinor = original.categoryMinor || '-';
        bodyRows.push(push({ kind: adjustment ? 'adjustment' : 'detail', subject,
          categoryMinor, sourceLabel, rowKey: original.rowKey, currency: original.currency, adjustmentId: original.adjustmentId,
          cells: [textCell(original.subject || subject), textCell(original.categoryMajor || '-'),
            textCell([categoryMinor, sourceLabel, ...(adjustment ? ['人工调整'] : [])].join('\n')),
            ...CURRENCIES.map((currency) => amountCell(original.currencyAmounts?.[currency])),
            adjustment ? amountCell(original.adjustmentAmount) : textCell('-'), textCell(adjustment ? original.reason : '-')] }));
      }
      for (const [key, label] of SUMMARIES) {
        const amounts = subjectResult.summaries[key];
        if (!amounts || CURRENCIES.some((currency) => !Object.hasOwn(amounts, currency))) throw new Error(`${subject} 缺少 ${label} 币种汇总`);
        bodyRows.push(push({ kind: 'summary', subject, summaryKey: key, label, difference: key === 'effectiveDifference',
          cells: [textCell(subject), textCell(label), textCell(''),
            ...CURRENCIES.map((currency) => amountCell(amounts[currency], key === 'effectiveDifference')), textCell('-'), textCell('-')] }));
      }
      blocks.push({ subject, titleRow: title.rowNumber, balanced, bodyRows });
    }
    return { headers: HEADERS, currencies: CURRENCIES, blocks, rows, rowCount: rows.length };
  }
  return Object.freeze({ CURRENCIES, HEADERS, SUMMARIES, formatAmount, projectReview });
}));
