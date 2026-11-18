'use strict';

// v3.2.19 拆分/合并账单「根据字段值过滤账单」：命中的源行走拆分/合并映射，未命中的行走模板主映射。
// 规则形状、比较口径与字段运算见 row-filter-rules.js（与原始账单预处理「过滤账单」共用）。

const {
  ROW_FILTER_OPERATORS,
  rowFilterOperatorNeedsValue,
  normalizeRowFilterRules,
  validateRowFilterRules,
  collectRowFilterRuleFields,
  compileRowFilterRules,
  matchesRowFilterRules
} = require('./row-filter-rules');

const BILL_SPLIT_ROW_FILTER_MISSING_MESSAGE = '已勾选「根据字段值过滤账单」，请在【过滤规则设置】中至少设置一条过滤规则';

function normalizeBillSplitRowFilterRules(raw) {
  return normalizeRowFilterRules(raw);
}

// 返回规范化后的规则；headers 为数组时校验字段在模板表头中。
function validateBillSplitRowFilterRules(raw, headers) {
  return validateRowFilterRules(raw, headers, { missingMessage: BILL_SPLIT_ROW_FILTER_MISSING_MESSAGE });
}

function collectBillSplitRowFilterFields(raw) {
  return collectRowFilterRuleFields(raw);
}

// 生成前编译一次：校验规则并解析每个条件字段在源表头中的下标；字段不在源文件表头中时拒绝生成。
function compileBillSplitRowFilter(raw, sourceIndexByField) {
  return compileRowFilterRules(raw, sourceIndexByField, { missingMessage: BILL_SPLIT_ROW_FILTER_MISSING_MESSAGE });
}

function matchesBillSplitRowFilter(row, compiledGroups) {
  return matchesRowFilterRules(row, compiledGroups);
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
