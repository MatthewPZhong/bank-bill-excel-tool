'use strict';

// v3.2.16「字段筛选特征值」：从原始账单的一个源字段里按分隔符拆段，取第一个满足条件的片段。
// 一个模板只有一套规则（存 templates.feature_filter_json），选该映射值的目标字段共用同一个结果。
// 渲染端 configuration.js 有同口径的样例校验，改动匹配规则时两边一起改。

const { FileValidationError, normalizeCell } = require('./common');

const FEATURE_FILTER_MAX_LENGTH = 200;

// 分隔符存键名而非字符本身：空格经 normalizeCell 会被裁掉。'' 表示不拆分、整格匹配。
const FEATURE_FILTER_SEPARATOR_SPLITTERS = Object.freeze({
  '': null,
  space: /\s+/u,
  slash: '/',
  comma: ',',
  dot: '.',
  backslash: '\\'
});

const FEATURE_FILTER_SEPARATOR_LABELS = Object.freeze({
  '': '不拆分',
  space: '空格',
  slash: '/',
  comma: ',',
  dot: '.',
  backslash: '\\'
});

function fail(message) {
  return new FileValidationError('FILE_READ', `筛选特征值：${message}`);
}

function parseOptionalCount(value, label, { allowZero = false } = {}) {
  if (value === null || value === undefined) {
    return null;
  }
  const text = normalizeCell(value);
  if (text === '') {
    return null;
  }
  if (!/^\d+$/.test(text)) {
    throw fail(`${label}须为整数`);
  }
  const count = Number(text);
  if (count === 0 && allowZero) {
    return null;
  }
  if (count < 1 || count > FEATURE_FILTER_MAX_LENGTH) {
    throw fail(`${label}须在 1–${FEATURE_FILTER_MAX_LENGTH} 之间`);
  }
  return count;
}

function isAsciiLetter(char) {
  return /^[A-Za-z]$/.test(char);
}

function isAsciiDigit(char) {
  return /^[0-9]$/.test(char);
}

function splitFeatureTokens(cellValue, separator) {
  const text = normalizeCell(cellValue);
  if (!text) {
    return [];
  }
  const splitter = FEATURE_FILTER_SEPARATOR_SPLITTERS[separator];
  if (!splitter) {
    return [text];
  }
  return text
    .split(splitter)
    .map((part) => part.trim())
    .filter((part) => part !== '');
}

function matchesFeatureFilter(token, rule) {
  const chars = Array.from(String(token ?? ''));
  if (!chars.length) {
    return false;
  }
  if (rule.length !== null && chars.length !== rule.length) {
    return false;
  }
  const prefixCount = rule.letterPrefixCount || 0;
  if (prefixCount > 0) {
    if (chars.length < prefixCount || !chars.slice(0, prefixCount).every(isAsciiLetter)) {
      return false;
    }
  }
  if (rule.digitsOnly) {
    const rest = chars.slice(prefixCount);
    if (!rest.length || !rest.every(isAsciiDigit)) {
      return false;
    }
  }
  return true;
}

function extractFeatureValue(cellValue, rule) {
  const match = splitFeatureTokens(cellValue, rule.separator).find((token) => matchesFeatureFilter(token, rule));
  return match === undefined ? '' : match;
}

// 规范化并校验规则；headers 为模板表头时校验源字段存在。失败抛 FileValidationError。
function normalizeFeatureFilterRule(raw, { headers = null } = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw fail('尚未设置筛选条件，请点击【筛选条件】设置');
  }

  const sourceField = normalizeCell(raw.sourceField);
  if (!sourceField) {
    throw fail('请选择筛选字段');
  }
  if (Array.isArray(headers)) {
    const headerSet = new Set(headers.map((header) => normalizeCell(header)).filter(Boolean));
    if (!headerSet.has(sourceField)) {
      throw fail(`筛选字段不存在：${sourceField}`);
    }
  }

  const separator = normalizeCell(raw.separator);
  if (!Object.prototype.hasOwnProperty.call(FEATURE_FILTER_SEPARATOR_SPLITTERS, separator)) {
    throw fail(`不支持的分隔符：${separator}`);
  }

  const length = parseOptionalCount(raw.length, '特征长度');
  const letterPrefixCount = parseOptionalCount(raw.letterPrefixCount, '前几位英文', { allowZero: true });
  const digitsOnly = raw.digitsOnly === true;

  if (length === null && letterPrefixCount === null && !digitsOnly) {
    throw fail('特征长度、前几位英文、纯数字至少设置一项');
  }
  if (length !== null && letterPrefixCount !== null) {
    if (letterPrefixCount > length) {
      throw fail('前几位英文不能大于特征长度');
    }
    if (digitsOnly && letterPrefixCount === length) {
      throw fail('勾选纯数字时，特征长度须大于前几位英文');
    }
  }

  const rule = {
    sourceField,
    separator,
    length,
    letterPrefixCount,
    digitsOnly,
    sample: normalizeCell(raw.sample)
  };

  if (rule.sample) {
    const sampleTokens = splitFeatureTokens(rule.sample, separator);
    if (sampleTokens.length !== 1 || sampleTokens[0] !== rule.sample) {
      throw fail(`特征值「${rule.sample}」不能包含所选分隔符`);
    }
    if (!matchesFeatureFilter(rule.sample, rule)) {
      throw fail(`特征值「${rule.sample}」不符合当前筛选条件`);
    }
  }

  return rule;
}

function describeFeatureFilterRule(rule) {
  const parts = [`源字段「${rule.sourceField}」`, `分隔符：${FEATURE_FILTER_SEPARATOR_LABELS[rule.separator] || '不拆分'}`];
  if (rule.length !== null) parts.push(`长度 ${rule.length}`);
  if (rule.letterPrefixCount !== null) parts.push(`前 ${rule.letterPrefixCount} 位英文`);
  if (rule.digitsOnly) parts.push(rule.letterPrefixCount ? '其余为纯数字' : '纯数字');
  return parts.join('，');
}

module.exports = {
  FEATURE_FILTER_MAX_LENGTH,
  FEATURE_FILTER_SEPARATOR_LABELS,
  describeFeatureFilterRule,
  extractFeatureValue,
  matchesFeatureFilter,
  normalizeFeatureFilterRule,
  splitFeatureTokens
};
