'use strict';

const { canonicalizeDecimal } = require('../../main-process/financial-decimal');

const MAX_FRACTION_DIGITS = 2;
const MAX_EXCEL_SIGNIFICANT_DIGITS = 15;

function decimalMetrics(canonical) {
  const unsigned = canonical.replace(/^-/, '');
  const [, fraction = ''] = unsigned.split('.');
  const significantDigits = unsigned.replace('.', '').replace(/^0+/, '').length;
  return { fractionDigits: fraction.length, significantDigits };
}

function canonicalizeVccAmount(value, label) {
  const canonical = canonicalizeDecimal(value, { label });
  const metrics = decimalMetrics(canonical);
  if (metrics.fractionDigits > MAX_FRACTION_DIGITS) {
    throw new Error(`${label}最多支持 ${MAX_FRACTION_DIGITS} 位小数，系统不会自动四舍五入：${value}`);
  }
  if (metrics.significantDigits > MAX_EXCEL_SIGNIFICANT_DIGITS) {
    throw new Error(`${label}超过 Excel ${MAX_EXCEL_SIGNIFICANT_DIGITS} 位有效数字限制：${value}`);
  }
  return canonical;
}

module.exports = {
  MAX_FRACTION_DIGITS,
  MAX_EXCEL_SIGNIFICANT_DIGITS,
  decimalMetrics,
  canonicalizeVccAmount
};
