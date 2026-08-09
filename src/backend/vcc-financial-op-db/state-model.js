'use strict';

const STRICT_YEAR_MONTH_PATTERN = /^\d{4}-(?:0[1-9]|1[0-2])$/;

function readFirstMonthFacts(db) {
  const state = db.prepare(`
    SELECT first_month
    FROM vcc_fin_op_module_state
    WHERE singleton_id = 1
  `).get() || null;
  const openingMonths = db.prepare(`
    SELECT DISTINCT target_month
    FROM vcc_fin_op_opening_balances
    ORDER BY target_month
  `).all().map((row) => String(row.target_month == null ? '' : row.target_month));
  return {
    firstMonth: state && state.first_month !== null ? String(state.first_month) : null,
    openingMonths
  };
}

function diagnoseFirstMonthFacts(facts) {
  const invalidFirstMonth = facts.firstMonth !== null
    && !STRICT_YEAR_MONTH_PATTERN.test(facts.firstMonth);
  const invalidOpeningMonths = facts.openingMonths.filter(
    (month) => !STRICT_YEAR_MONTH_PATTERN.test(month)
  );
  if (invalidFirstMonth || invalidOpeningMonths.length > 0) {
    const invalidValues = [
      ...(invalidFirstMonth ? [`first_month=${JSON.stringify(facts.firstMonth)}`] : []),
      ...invalidOpeningMonths.map((month) => `opening=${JSON.stringify(month)}`)
    ];
    return {
      blocked: true,
      code: 'vcc-first-month-migration-blocked',
      reason: 'invalid-month-format',
      message: `检测到非严格 YYYY-MM 的首月状态：${invalidValues.join('、')}，已阻止 VCC 财务OP运行`,
      invalidFirstMonth,
      invalidOpeningMonths,
      ...facts
    };
  }
  if (facts.openingMonths.length > 1) {
    return {
      blocked: true,
      code: 'vcc-first-month-migration-blocked',
      reason: 'multiple-opening-months',
      message: `检测到多个首月期初初始化月份：${facts.openingMonths.join('、')}，已阻止 VCC 财务OP运行`,
      ...facts
    };
  }
  if (
    facts.firstMonth
    && facts.openingMonths.length === 1
    && facts.openingMonths[0] !== facts.firstMonth
  ) {
    return {
      blocked: true,
      code: 'vcc-first-month-migration-blocked',
      reason: 'first-month-opening-conflict',
      message: `首月状态 ${facts.firstMonth} 与期初初始化月份 ${facts.openingMonths[0]} 冲突，已阻止 VCC 财务OP运行`,
      ...facts
    };
  }
  return { blocked: false, code: '', reason: '', message: '', ...facts };
}

module.exports = {
  STRICT_YEAR_MONTH_PATTERN,
  diagnoseFirstMonthFacts,
  readFirstMonthFacts
};
