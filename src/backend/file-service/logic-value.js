'use strict';

// v3.2.19：映射字段「逻辑取值 → 候补字段取值」。
// 映射行存 mappedField='逻辑取值'、mappedFields=有序候补字段；生成 lookup 里转成内部 token
// `__LOGIC_VALUE__:<JSON 候补字段数组>`，避免与真实表头重名，也不会被当成需要拼接字段。
// 取值：按顺序取第一个去首尾空白后非空的单元格，全部为空时为 ''。
// v3.2.21：候补也可以是模板的特征值，存为 `\u0000__FEATURE_FILTER__:<id>`（LOGIC_VALUE_FEATURE_CANDIDATE_PREFIX，
//   以 NUL 开头，不会与源列名相同）；取该行筛出的特征值，未筛出视为空、取下一个候补，不记「未筛出特征值」提示。
const { LOGIC_VALUE_FEATURE_CANDIDATE_PREFIX, LOGIC_VALUE_FIELD_TOKEN_PREFIX, normalizeCell } = require('./common');

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

// v3.2.21：特征值候补的存储形式；id 去首尾空白，同一特征值只有一种写法（保存时据此查重）。
function buildLogicValueFeatureCandidate(id) {
  return `${LOGIC_VALUE_FEATURE_CANDIDATE_PREFIX}${normalizeCell(id)}`;
}

// v3.2.21：候补是特征值时返回特征值 id（去首尾空白，可能为 ''），否则返回 null（源字段候补，含形如
//   `__FEATURE_FILTER__:1` 的旧源列名）。
function parseLogicValueFeatureFilterRef(field) {
  if (typeof field !== 'string' || !field.startsWith(LOGIC_VALUE_FEATURE_CANDIDATE_PREFIX)) return null;
  return normalizeCell(field.slice(LOGIC_VALUE_FEATURE_CANDIDATE_PREFIX.length));
}

// 收集 lookup（目标字段 → 映射值或其数组）里逻辑取值的候补，按首次出现顺序去重。
//   pick(field) 返回要收集的值（null 表示跳过）。
function collectLogicValueCandidates(lookup, pick) {
  const values = [];
  Object.values(lookup || {}).forEach((value) => {
    [].concat(value).forEach((item) => {
      (parseLogicValueToken(item) || []).forEach((field) => {
        const picked = pick(field);
        if (picked !== null && !values.includes(picked)) values.push(picked);
      });
    });
  });
  return values;
}

// 逻辑取值引用的源字段候补（不含特征值候补，特征值的筛选源字段由特征值启用时校验）。
function collectLogicValueFields(lookup) {
  return collectLogicValueCandidates(lookup, (field) => (parseLogicValueFeatureFilterRef(field) === null ? field : null));
}

// v3.2.21：逻辑取值候补引用的特征值 id。没有 id 的特征值候补收为 ''，由启用时按特征值不存在拒绝（不当作未筛出而回落）。
function collectLogicValueFeatureFilterIds(lookup) {
  return collectLogicValueCandidates(lookup, (field) => parseLogicValueFeatureFilterRef(field));
}

module.exports = {
  LOGIC_VALUE_MIN_FIELDS,
  buildLogicValueFeatureCandidate,
  buildLogicValueToken,
  collectLogicValueFeatureFilterIds,
  collectLogicValueFields,
  normalizeLogicValueFields,
  parseLogicValueFeatureFilterRef,
  parseLogicValueToken,
  resolveLogicValue
};
