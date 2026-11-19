'use strict';

// v3.2.19 拆分/合并账单「费用账单发生额特殊取值逻辑」：公式为若干组 { field, op }，最后一组的 op 为 end（运算结束）。
// 先乘除后加减；运算字段按原值带正负号参与，空白或无法识别按 0；按十进制精确计算（不经浮点），
// 结果取绝对值并四舍五入保留 2 位。
// 渲染端 configuration.js 有同口径的保存前校验，改校验规则时两边一起改。

const { FileValidationError, normalizeCell } = require('./common');
const { sanitizeSignedAmountValue } = require('./normalizers');

const FEE_FORMULA_END_OPERATOR = 'end';
const FEE_FORMULA_OPERATORS = Object.freeze(['+', '-', '*', '/', FEE_FORMULA_END_OPERATOR]);
const FEE_FORMULA_OPERATOR_LABELS = Object.freeze({
  '+': '加',
  '-': '减',
  '*': '乘',
  '/': '除',
  [FEE_FORMULA_END_OPERATOR]: '运算结束'
});

function fail(message) {
  throw new FileValidationError('FILE_READ', message);
}

// 接受数组或 JSON 字符串；只保留 { field, op } 两项，丢弃两项都为空白的组（界面上清空一组即视为删除）。
function normalizeFeeAmountFormula(raw) {
  let list = raw;
  if (typeof raw === 'string') {
    if (!raw.trim()) return [];
    try {
      list = JSON.parse(raw);
    } catch (_error) {
      return [];
    }
  }
  if (!Array.isArray(list)) return [];
  return list
    .filter((item) => item && typeof item === 'object' && !Array.isArray(item))
    .map((item) => ({ field: normalizeCell(item.field), op: normalizeCell(item.op) }))
    .filter((item) => item.field !== '' || item.op !== '');
}

// 返回规范化后的公式；headers 为数组时校验字段在模板表头中。
function validateFeeAmountFormula(raw, headers) {
  const formula = normalizeFeeAmountFormula(raw);
  if (!formula.length) {
    fail('请至少新增一组运算字段');
  }
  const headerSet = Array.isArray(headers)
    ? new Set(headers.map((header) => normalizeCell(header)).filter(Boolean))
    : null;
  formula.forEach((item, index) => {
    const groupLabel = `第 ${index + 1} 组`;
    const isLast = index === formula.length - 1;
    if (!item.field) {
      fail(`${groupLabel}：请选择运算字段`);
    }
    if (headerSet && !headerSet.has(item.field)) {
      fail(`映射字段不存在：${item.field}`);
    }
    if (!item.op) {
      fail(`${groupLabel}：请选择运算符`);
    }
    if (!FEE_FORMULA_OPERATORS.includes(item.op)) {
      fail(`${groupLabel}：运算符无效`);
    }
    if (isLast && item.op !== FEE_FORMULA_END_OPERATOR) {
      fail('最后一组的运算符必须是「运算结束」');
    }
    if (!isLast && item.op === FEE_FORMULA_END_OPERATOR) {
      fail(`「运算结束」只能用在最后一组，${groupLabel}之后还有运算字段`);
    }
  });
  return formula;
}

// 精确运算：值用分数 { num, den }（BigInt，den > 0）表示，加减乘除不经浮点，最后一次性舍入。
const ZERO = Object.freeze({ num: 0n, den: 1n });
const DECIMAL_PATTERN = /^([+-]?)(\d*)(?:\.(\d*))?(?:e([+-]?\d+))?$/i;
const SCIENTIFIC_TEXT_PATTERN = /^[+-]?(?:\d+\.?\d*|\.\d+)e[+-]?\d+$/i;

function gcd(a, b) {
  let x = a < 0n ? -a : a;
  let y = b < 0n ? -b : b;
  while (y) [x, y] = [y, x % y];
  return x || 1n;
}

function fraction(num, den) {
  const sign = den < 0n ? -1n : 1n;
  const divisor = gcd(num, den);
  return { num: (num * sign) / divisor, den: (den * sign) / divisor };
}

// 十进制文本（可带科学计数法）→ 分数；无法识别时返回 null。
function parseDecimalFraction(text) {
  const match = DECIMAL_PATTERN.exec(String(text));
  if (!match || (!match[2] && !match[3])) return null;
  const exponent = match[4] ? Number(match[4]) : 0;
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 400) return null;
  const digits = `${match[2] || ''}${match[3] || ''}` || '0';
  let num = BigInt(digits) * (match[1] === '-' ? -1n : 1n);
  let den = 10n ** BigInt((match[3] || '').length);
  if (exponent > 0) num *= 10n ** BigInt(exponent);
  if (exponent < 0) den *= 10n ** BigInt(-exponent);
  return fraction(num, den);
}

// 数值单元格按 JS 最短十进制表示取值（含 1e-7 这类指数形式）；文本去千分位、货币符号等，
// 纯科学计数法文本按指数解析；空白或无法识别按 0。
function readFeeOperand(rawValue) {
  if (typeof rawValue === 'number') {
    return Number.isFinite(rawValue) ? (parseDecimalFraction(String(rawValue)) || ZERO) : ZERO;
  }
  const compact = normalizeCell(rawValue).replace(/[,\s]/g, '');
  if (SCIENTIFIC_TEXT_PATTERN.test(compact)) {
    return parseDecimalFraction(compact) || ZERO;
  }
  const sanitized = sanitizeSignedAmountValue(rawValue);
  return sanitized ? (parseDecimalFraction(sanitized) || ZERO) : ZERO;
}

// 绝对值四舍五入到 2 位（十进制半入：1.005 → 1.01、10000.005 → 10000.01），去掉末尾的 0。
function formatFractionAmount(value) {
  const absolute = value.num < 0n ? -value.num : value.num;
  const cents = (absolute * 200n + value.den) / (2n * value.den);
  const whole = cents / 100n;
  const remainder = cents % 100n;
  if (remainder === 0n) return whole.toString();
  return `${whole}.${remainder.toString().padStart(2, '0')}`.replace(/0$/, '');
}

function roundFeeAmount(value) {
  const parsed = typeof value === 'number' && Number.isFinite(value) ? parseDecimalFraction(String(value)) : null;
  if (!parsed) {
    fail('费用账单发生额计算结果无效');
  }
  return formatFractionAmount(parsed);
}

// formula 须已通过 validateFeeAmountFormula。readCell(field) 返回该行源单元格原值。
// 返回 { amount, divisionByZero }：amount 为绝对值金额字符串（0 时为 ''）；
// 非 0 除以 0 时 divisionByZero = true、amount = ''，由调用方汇总行号后报错；0 ÷ 0 按 0（如空白行）。
function evaluateFeeAmountFormula(formula, readCell) {
  const items = Array.isArray(formula) ? formula : [];
  if (!items.length) {
    return { amount: '', divisionByZero: false };
  }
  let total = ZERO;
  let sign = 1n;
  let product = readFeeOperand(readCell(items[0].field));
  for (let index = 0; index < items.length - 1; index += 1) {
    const operator = items[index].op;
    const next = readFeeOperand(readCell(items[index + 1].field));
    if (operator === '*') {
      product = fraction(product.num * next.num, product.den * next.den);
    } else if (operator === '/') {
      if (next.num === 0n) {
        if (product.num !== 0n) {
          return { amount: '', divisionByZero: true };
        }
        product = ZERO;
      } else {
        product = fraction(product.num * next.den, product.den * next.num);
      }
    } else {
      total = fraction(total.num * product.den + sign * product.num * total.den, total.den * product.den);
      sign = operator === '-' ? -1n : 1n;
      product = next;
    }
  }
  total = fraction(total.num * product.den + sign * product.num * total.den, total.den * product.den);
  const amount = formatFractionAmount(total);
  return { amount: amount === '0' ? '' : amount, divisionByZero: false };
}

function describeFeeAmountFormula(formula) {
  return (Array.isArray(formula) ? formula : [])
    .map((item, index, list) => (index === list.length - 1
      ? item.field
      : `${item.field} ${FEE_FORMULA_OPERATOR_LABELS[item.op] || item.op}`))
    .join(' ');
}

module.exports = {
  FEE_FORMULA_END_OPERATOR,
  FEE_FORMULA_OPERATORS,
  FEE_FORMULA_OPERATOR_LABELS,
  describeFeeAmountFormula,
  evaluateFeeAmountFormula,
  normalizeFeeAmountFormula,
  roundFeeAmount,
  validateFeeAmountFormula
};
