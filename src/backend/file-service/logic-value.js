'use strict';

// v3.2.19：映射字段「逻辑取值 → 候补字段取值」。
// 映射行存 mappedField='逻辑取值'、mappedFields=有序候补字段；生成 lookup 里转成内部 token
// `__LOGIC_VALUE__:<JSON 候补字段数组>`，避免与真实表头重名，也不会被当成需要拼接字段。
// 取值：按顺序取第一个去首尾空白后非空的单元格，全部为空时为 ''。
const { LOGIC_VALUE_FIELD_TOKEN_PREFIX, normalizeCell } = require('./common');

const LOGIC_VALUE_MIN_FIELDS = 2;

// 候补字段：去首尾空白、去空、去重，保持顺序。只读 mappedFields，不回落到 mappedField（其值是模式名）。
function normalizeLogicValueFields(fields) {
  const result = [];
  (Array.isArray(fields) ? fields : []).forEach((value) => {
    const field = normalizeCell(value);
    if (field && !result.includes(field)) result.push(field);
  });
  return result;
}

function buildLogicValueToken(fields) {
  return `${LOGIC_VALUE_FIELD_TOKEN_PREFIX}${JSON.stringify(normalizeLogicValueFields(fields))}`;
}

// lookup 值是 buildLogicValueToken 构造的 token（前缀 + 非空 JSON 字符串数组）时返回候补字段数组，否则返回 null。
// 只是以前缀开头、不是这种形状的值（如旧模板里恰好以该前缀开头的真实列名）按普通源字段处理，不当成空的逻辑取值。
function parseLogicValueToken(value) {
  if (typeof value !== 'string' || !value.startsWith(LOGIC_VALUE_FIELD_TOKEN_PREFIX)) {
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(value.slice(LOGIC_VALUE_FIELD_TOKEN_PREFIX.length));
  } catch (_error) {
    return null;
  }
  if (!Array.isArray(parsed) || !parsed.every((field) => typeof field === 'string')) return null;
  const fields = normalizeLogicValueFields(parsed);
  return fields.length ? fields : null;
}

// readCell(field) 返回该行源字段的原值；返回第一个非空的原值（不改写，交给目标字段的规范化）。
function resolveLogicValue(fields, readCell) {
  for (const field of Array.isArray(fields) ? fields : []) {
    const value = readCell(field);
    if (normalizeCell(value) !== '') return value;
  }
  return '';
}

// 收集 lookup（目标字段 → 映射值或其数组）里逻辑取值引用的候补字段，按首次出现顺序去重。
function collectLogicValueFields(lookup) {
  const fields = [];
  Object.values(lookup || {}).forEach((value) => {
    [].concat(value).forEach((item) => {
      (parseLogicValueToken(item) || []).forEach((field) => {
        if (!fields.includes(field)) fields.push(field);
      });
    });
  });
  return fields;
}

module.exports = {
  LOGIC_VALUE_MIN_FIELDS,
  buildLogicValueToken,
  collectLogicValueFields,
  normalizeLogicValueFields,
  parseLogicValueToken,
  resolveLogicValue
};
