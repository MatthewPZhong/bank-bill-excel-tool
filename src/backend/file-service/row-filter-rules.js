'use strict';

// 按字段值过滤源行的通用规则（v3.2.19）：规则为若干组 { seq, conditions: [{ field, op, value }] }，
// 组内条件全部满足、任一组满足即命中。用于：
//   - 拆分/合并账单「根据字段值过滤账单」（bill-split-row-filter.js）：命中的源行走拆分/合并映射；
//   - 原始账单预处理「过滤账单」：命中的源行保留为原始账单加工表，其余行不参与生成。
// 比较口径：单元格去首尾空白后按文本比较，区分大小写，不做数值换算；值保存时去首尾空白。
// 字段运算（等于（字段）等）的 value 存另一个字段名，与同一行该字段的单元格比较；
//   被比较字段为空时 包含（字段）不命中、不包含（字段）命中，等于 / 不等于（字段）照常按文本比较。
// 渲染端 configuration.js 有同口径的保存前校验，改校验规则时两边一起改。

const { FileValidationError, normalizeCell } = require('./common');

const FIELD_COMPARE_OPERATORS = Object.freeze(['等于（字段）', '不等于（字段）', '包含（字段）', '不包含（字段）']);
const ROW_FILTER_OPERATORS = Object.freeze([
  '等于', '不等于', '包含', '不包含', '空值', '非空值', '开头为',
  ...FIELD_COMPARE_OPERATORS
]);
const VALUELESS_OPERATORS = new Set(['空值', '非空值']);
const FIELD_COMPARE_OPERATOR_SET = new Set(FIELD_COMPARE_OPERATORS);
// 原始账单预处理「过滤账单」勾选了却没有有效规则时的报错（保存与生成共用）
const PREPROCESS_ROW_FILTER_MISSING_MESSAGE = '已勾选「过滤账单」，请在【规则设置】中至少设置一条过滤规则';

function fail(message) {
  throw new FileValidationError('FILE_READ', message);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function rowFilterOperatorNeedsValue(op) {
  return !VALUELESS_OPERATORS.has(op);
}

function isFieldCompareOperator(op) {
  return FIELD_COMPARE_OPERATOR_SET.has(op);
}

// 接受数组或 JSON 字符串。字段与值都为空的条件视为空白（运算符总有默认值）并忽略，没有条件的组整组忽略；
// 空值 / 非空值 不需要值，清掉残留；seq 按顺序重排为 1..n。
function normalizeRowFilterRules(raw) {
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

// 返回规范化后的规则；headers 为数组时校验字段（含字段运算的比较字段）在模板表头中。
// missingMessage：没有有效规则时的报错（各功能入口文案不同）；ruleLabel：条件报错的前缀（v3.2.21 跨 Sheet 回填复用）。
function validateRowFilterRules(raw, headers, { missingMessage = '请至少设置一条过滤规则', ruleLabel = '过滤规则' } = {}) {
  const rules = normalizeRowFilterRules(raw);
  if (!rules.length) {
    fail(missingMessage);
  }
  const headerSet = Array.isArray(headers)
    ? new Set(headers.map((header) => normalizeCell(header)).filter(Boolean))
    : null;
  rules.forEach((group) => {
    group.conditions.forEach((condition, index) => {
      const label = `${ruleLabel} #${group.seq} 第 ${index + 1} 个条件`;
      if (!condition.field) {
        fail(`${label}：请选择字段`);
      }
      if (headerSet && !headerSet.has(condition.field)) {
        fail(`映射字段不存在：${condition.field}`);
      }
      if (!ROW_FILTER_OPERATORS.includes(condition.op)) {
        fail(`${label}：运算符无效`);
      }
      if (isFieldCompareOperator(condition.op)) {
        if (!condition.value) {
          fail(`${label}：请选择比较字段`);
        }
        if (headerSet && !headerSet.has(condition.value)) {
          fail(`映射字段不存在：${condition.value}`);
        }
      } else if (rowFilterOperatorNeedsValue(condition.op) && !condition.value) {
        fail(`${label}：请填写值`);
      }
    });
  });
  return rules;
}

function collectRowFilterRuleFields(raw) {
  const fields = [];
  const push = (field) => {
    if (field && !fields.includes(field)) fields.push(field);
  };
  normalizeRowFilterRules(raw).forEach((group) => {
    group.conditions.forEach((condition) => {
      push(condition.field);
      if (isFieldCompareOperator(condition.op)) push(condition.value);
    });
  });
  return fields;
}

// 生成前编译一次：校验规则并解析每个条件字段（及比较字段）在源表头中的下标；字段不在源文件表头中时拒绝生成。
function compileRowFilterRules(raw, sourceIndexByField, options) {
  const resolveIndex = (field) => {
    const sourceIndex = sourceIndexByField.get(field);
    if (sourceIndex === undefined) {
      fail(`映射字段不存在：${field}`);
    }
    return sourceIndex;
  };
  return validateRowFilterRules(raw, null, options).map((group) => group.conditions.map((condition) => {
    const compiled = { op: condition.op, value: condition.value, sourceIndex: resolveIndex(condition.field) };
    if (isFieldCompareOperator(condition.op)) {
      compiled.compareSourceIndex = resolveIndex(condition.value);
    }
    return compiled;
  }));
}

function matchRowFilterCondition(row, condition) {
  const actual = normalizeCell(row[condition.sourceIndex]);
  const expected = condition.compareSourceIndex === undefined
    ? condition.value
    : normalizeCell(row[condition.compareSourceIndex]);
  switch (condition.op) {
    case '等于':
    case '等于（字段）':
      return actual === expected;
    case '不等于':
    case '不等于（字段）':
      return actual !== expected;
    case '包含':
      return actual.includes(expected);
    case '不包含':
      return !actual.includes(expected);
    case '包含（字段）':
      return expected !== '' && actual.includes(expected);
    case '不包含（字段）':
      return expected === '' || !actual.includes(expected);
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

function matchesRowFilterRules(row, compiledGroups) {
  return compiledGroups.some((conditions) => conditions.every((condition) => (
    matchRowFilterCondition(row, condition)
  )));
}

module.exports = {
  PREPROCESS_ROW_FILTER_MISSING_MESSAGE,
  FIELD_COMPARE_OPERATORS,
  ROW_FILTER_OPERATORS,
  rowFilterOperatorNeedsValue,
  isFieldCompareOperator,
  normalizeRowFilterRules,
  validateRowFilterRules,
  collectRowFilterRuleFields,
  compileRowFilterRules,
  matchesRowFilterRules
};
