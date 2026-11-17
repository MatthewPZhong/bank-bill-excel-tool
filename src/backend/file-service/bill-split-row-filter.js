'use strict';

// v3.2.19 拆分/合并账单「根据字段值过滤账单」：规则为若干组 { seq, conditions: [{ field, op, value }] }。
// 组内条件全部满足、任一组满足即命中；命中的源行走拆分/合并映射，未命中的行走模板主映射。
// 比较口径：单元格去首尾空白后按文本比较，区分大小写，不做数值换算；值保存时去首尾空白。
// 渲染端 configuration.js 有同口径的保存前校验，改校验规则时两边一起改。

const { FileValidationError, normalizeCell } = require('./common');

const ROW_FILTER_OPERATORS = Object.freeze(['等于', '不等于', '包含', '不包含', '空值', '非空值', '开头为']);
const VALUELESS_OPERATORS = new Set(['空值', '非空值']);

function fail(message) {
  throw new FileValidationError('FILE_READ', message);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function rowFilterOperatorNeedsValue(op) {
  return !VALUELESS_OPERATORS.has(op);
}

// 接受数组或 JSON 字符串。字段与值都为空的条件视为空白（运算符总有默认值）并忽略，没有条件的组整组忽略；
// 空值 / 非空值 不需要值，清掉残留；seq 按顺序重排为 1..n。
function normalizeBillSplitRowFilterRules(raw) {
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
    .filter(isPlainObject)
    .map((group) => (Array.isArray(group.conditions) ? group.conditions : [])
      .filter(isPlainObject)
      .map((condition) => {
        const op = normalizeCell(condition.op);
        return {
          field: normalizeCell(condition.field),
          op,
          value: VALUELESS_OPERATORS.has(op) ? '' : normalizeCell(condition.value)
        };
      })
      .filter((condition) => condition.field !== '' || condition.value !== ''))
    .filter((conditions) => conditions.length > 0)
    .map((conditions, index) => ({ seq: index + 1, conditions }));
}

// 返回规范化后的规则；headers 为数组时校验字段在模板表头中。
function validateBillSplitRowFilterRules(raw, headers) {
  const rules = normalizeBillSplitRowFilterRules(raw);
  if (!rules.length) {
    fail('已勾选「根据字段值过滤账单」，请在【过滤规则设置】中至少设置一条过滤规则');
  }
  const headerSet = Array.isArray(headers)
    ? new Set(headers.map((header) => normalizeCell(header)).filter(Boolean))
    : null;
  rules.forEach((group) => {
    group.conditions.forEach((condition, index) => {
      const label = `过滤规则 #${group.seq} 第 ${index + 1} 个条件`;
      if (!condition.field) {
        fail(`${label}：请选择字段`);
      }
      if (headerSet && !headerSet.has(condition.field)) {
        fail(`映射字段不存在：${condition.field}`);
      }
      if (!ROW_FILTER_OPERATORS.includes(condition.op)) {
        fail(`${label}：运算符无效`);
      }
      if (rowFilterOperatorNeedsValue(condition.op) && !condition.value) {
        fail(`${label}：请填写值`);
      }
    });
  });
  return rules;
}

function collectBillSplitRowFilterFields(raw) {
  const fields = [];
  normalizeBillSplitRowFilterRules(raw).forEach((group) => {
    group.conditions.forEach((condition) => {
      if (condition.field && !fields.includes(condition.field)) {
        fields.push(condition.field);
      }
    });
  });
  return fields;
}

// 生成前编译一次：校验规则并解析每个条件字段在源表头中的下标；字段不在源文件表头中时拒绝生成。
function compileBillSplitRowFilter(raw, sourceIndexByField) {
  return validateBillSplitRowFilterRules(raw, null).map((group) => group.conditions.map((condition) => {
    const sourceIndex = sourceIndexByField.get(condition.field);
    if (sourceIndex === undefined) {
      fail(`映射字段不存在：${condition.field}`);
    }
    return { op: condition.op, value: condition.value, sourceIndex };
  }));
}

function matchRowFilterCondition(cellValue, op, expected) {
  const actual = normalizeCell(cellValue);
  switch (op) {
    case '等于':
      return actual === expected;
    case '不等于':
      return actual !== expected;
    case '包含':
      return actual.includes(expected);
    case '不包含':
      return !actual.includes(expected);
    case '空值':
      return actual === '';
    case '非空值':
      return actual !== '';
    case '开头为':
      return actual.startsWith(expected);
    default:
      return false;
  }
}

function matchesBillSplitRowFilter(row, compiledGroups) {
  return compiledGroups.some((conditions) => conditions.every((condition) => (
    matchRowFilterCondition(row[condition.sourceIndex], condition.op, condition.value)
  )));
}

module.exports = {
  ROW_FILTER_OPERATORS,
  rowFilterOperatorNeedsValue,
  normalizeBillSplitRowFilterRules,
  validateBillSplitRowFilterRules,
  collectBillSplitRowFilterFields,
  compileBillSplitRowFilter,
  matchesBillSplitRowFilter
};
