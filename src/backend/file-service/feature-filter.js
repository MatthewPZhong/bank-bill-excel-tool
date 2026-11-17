'use strict';

// v3.2.16「字段筛选特征值」：从原始账单的一个源字段里按分隔符拆段，取第一个满足条件的片段。
// v3.2.18：一个模板可有多个具名特征值（templates.feature_filter_json 存数组），
//   映射行在 mapped_fields_json 里存所选特征值的 id；选同一特征值的目标字段共用同一个结果。
// 渲染端 configuration.js 有同口径的样例与名称校验，改动规则时两边一起改。

const { FEATURE_FILTER_FIELD_TOKEN_PREFIX, FileValidationError, normalizeCell } = require('./common');

const FEATURE_FILTER_MAX_LENGTH = 200;
const FEATURE_FILTER_NAME_MAX_LENGTH = 30;
// v3.2.18：v3.2.16/3.2.17 的单套规则升级为特征值时使用的 id 与名称（启动迁移 migrations.js 同口径）。
const LEGACY_FEATURE_FILTER_ID = '1';
const LEGACY_FEATURE_FILTER_NAME = '特征值1';

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

function fail(message, name = '') {
  return new FileValidationError('FILE_READ', name ? `特征值「${name}」：${message}` : `特征值：${message}`);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function parseOptionalCount(value, label, { allowZero = false, name = '' } = {}) {
  if (value === null || value === undefined) {
    return null;
  }
  const text = normalizeCell(value);
  if (text === '') {
    return null;
  }
  if (!/^\d+$/.test(text)) {
    throw fail(`${label}须为整数`, name);
  }
  const count = Number(text);
  if (count === 0 && allowZero) {
    return null;
  }
  if (count < 1 || count > FEATURE_FILTER_MAX_LENGTH) {
    throw fail(`${label}须在 1–${FEATURE_FILTER_MAX_LENGTH} 之间`, name);
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

// 规范化并校验一条筛选条件；headers 为模板表头时校验源字段存在；name 只用于错误提示。失败抛 FileValidationError。
function normalizeFeatureFilterRule(raw, { headers = null, name = '' } = {}) {
  if (!isPlainObject(raw)) {
    throw fail('尚未设置筛选条件，请点击【特征值管理】设置', name);
  }

  const sourceField = normalizeCell(raw.sourceField);
  if (!sourceField) {
    throw fail('请选择筛选字段', name);
  }
  if (Array.isArray(headers)) {
    const headerSet = new Set(headers.map((header) => normalizeCell(header)).filter(Boolean));
    if (!headerSet.has(sourceField)) {
      throw fail(`筛选字段不存在：${sourceField}`, name);
    }
  }

  const separator = normalizeCell(raw.separator);
  if (!Object.prototype.hasOwnProperty.call(FEATURE_FILTER_SEPARATOR_SPLITTERS, separator)) {
    throw fail(`不支持的分隔符：${separator}`, name);
  }

  const length = parseOptionalCount(raw.length, '特征长度', { name });
  const letterPrefixCount = parseOptionalCount(raw.letterPrefixCount, '前几位英文', { allowZero: true, name });
  const digitsOnly = raw.digitsOnly === true;

  if (length === null && letterPrefixCount === null && !digitsOnly) {
    throw fail('特征长度、前几位英文、纯数字至少设置一项', name);
  }
  if (length !== null && letterPrefixCount !== null) {
    if (letterPrefixCount > length) {
      throw fail('前几位英文不能大于特征长度', name);
    }
    if (digitsOnly && letterPrefixCount === length) {
      throw fail('勾选纯数字时，特征长度须大于前几位英文', name);
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
      throw fail(`输入特征值「${rule.sample}」不能包含所选分隔符`, name);
    }
    if (!matchesFeatureFilter(rule.sample, rule)) {
      throw fail(`输入特征值「${rule.sample}」不符合当前筛选条件`, name);
    }
  }

  return rule;
}

function normalizeFeatureFilterName(rawName) {
  const name = normalizeCell(rawName);
  if (!name) {
    throw fail('请输入特征值名');
  }
  if (Array.from(name).length > FEATURE_FILTER_NAME_MAX_LENGTH) {
    throw fail(`特征值名「${name}」超过 ${FEATURE_FILTER_NAME_MAX_LENGTH} 个字`);
  }
  return name;
}

// v3.2.18：规范化整张特征值列表（保存特征值、导入模板包时使用）。
//   - 每条：名称必填、≤30 字、同模板不重复；筛选条件按 normalizeFeatureFilterRule 校验。
//   - knownIds 为库中已有 id（Set）时，列表里带 id 的条目必须是已有的；不带 id 的分配新 id
//     （已有与列表内最大数字 id + 1，改名不变 id）。knownIds 为 null（模板包）时保留包内 id。
//   - preserved 为库中已保存的列表时，筛选条件与已保存完全相同的已有条目不按 headers 校验筛选字段：
//     模板【更新】可能删掉多个特征值共用的筛选字段，整表提交时须能逐个修复（被映射选用时，
//     保存映射与生成仍按表头拦截）。新增或改了条件的条目照常按 headers 校验。
function normalizeFeatureFilterList(rawList, { headers = null, knownIds = null, preserved = null } = {}) {
  if (!Array.isArray(rawList)) {
    throw fail('特征值列表格式不正确');
  }
  const preservedRules = new Map();
  // 条件与已保存完全相同才豁免；条件本身不合法时不豁免，交给下面按 headers 校验以保持原有报错顺序
  const isPreservedRule = (id, raw) => {
    if (!id || !preservedRules.has(id)) return false;
    try {
      return preservedRules.get(id) === JSON.stringify(normalizeFeatureFilterRule(raw));
    } catch {
      return false;
    }
  };
  (Array.isArray(preserved) ? preserved : []).forEach((item) => {
    const id = isPlainObject(item) ? normalizeCell(item.id) : '';
    if (!id) return;
    try {
      preservedRules.set(id, JSON.stringify(normalizeFeatureFilterRule(item)));
    } catch {
      // 已保存条目本身不合法时不豁免，按 headers 照常校验
    }
  });
  const seenIds = new Set();
  const seenNames = new Set();
  let maxNumericId = 0;
  const trackId = (id) => {
    if (/^\d+$/.test(id)) {
      maxNumericId = Math.max(maxNumericId, Number(id));
    }
  };
  if (knownIds) {
    knownIds.forEach((id) => trackId(String(id)));
  }
  const pending = rawList.map((raw) => {
    if (!isPlainObject(raw)) {
      throw fail('特征值列表格式不正确');
    }
    const name = normalizeFeatureFilterName(raw.name);
    if (seenNames.has(name)) {
      throw fail(`特征值名「${name}」已存在`);
    }
    seenNames.add(name);
    const id = normalizeCell(raw.id);
    if (id) {
      if (knownIds && !knownIds.has(id)) {
        throw fail(`特征值「${name}」不存在或已被删除，请重新打开【特征值管理】`);
      }
      if (seenIds.has(id)) {
        throw fail(`特征值 id 重复：${id}`);
      }
      seenIds.add(id);
      trackId(id);
    }
    return { id, name, rule: normalizeFeatureFilterRule(raw, { headers: isPreservedRule(id, raw) ? null : headers, name }) };
  });
  return pending.map(({ id, name, rule }) => {
    let resolvedId = id;
    if (!resolvedId) {
      maxNumericId += 1;
      resolvedId = String(maxNumericId);
    }
    return { id: resolvedId, name, ...rule };
  });
}

// v3.2.18：v3.2.16/3.2.17 的单套规则（对象）升级为一条特征值；已是数组或为空时原样返回列表。
function upgradeLegacyFeatureFilter(raw) {
  if (Array.isArray(raw)) {
    return raw.filter(isPlainObject).map((item) => ({ ...item }));
  }
  if (!isPlainObject(raw)) {
    return [];
  }
  const { id: _id, name: _name, ...rule } = raw;
  return [{ id: LEGACY_FEATURE_FILTER_ID, name: LEGACY_FEATURE_FILTER_NAME, ...rule }];
}

// 映射行所选特征值的 id（mappedFields 的第一个值）；未选为 ''。
function getFeatureFilterRef(mapping) {
  const values = mapping && Array.isArray(mapping.mappedFields) ? mapping.mappedFields : [];
  return normalizeCell(values[0]);
}

function buildFeatureFilterToken(id) {
  return `${FEATURE_FILTER_FIELD_TOKEN_PREFIX}${normalizeCell(id)}`;
}

// lookup 值是特征值 token 时返回 id，否则返回 null。
function parseFeatureFilterToken(value) {
  if (typeof value !== 'string' || !value.startsWith(FEATURE_FILTER_FIELD_TOKEN_PREFIX)) {
    return null;
  }
  return value.slice(FEATURE_FILTER_FIELD_TOKEN_PREFIX.length);
}

// 收集 lookup（目标字段 → 映射值或其数组）里引用的特征值 id，按首次出现顺序去重。
function collectFeatureFilterIds(lookup) {
  const ids = [];
  Object.values(lookup || {}).forEach((value) => {
    [].concat(value).forEach((item) => {
      const id = parseFeatureFilterToken(item);
      if (id !== null && !ids.includes(id)) {
        ids.push(id);
      }
    });
  });
  return ids;
}

// v3.2.18：按实际生效映射所选的特征值取规则；未选或选的特征值不存在时抛错。
//   refs：[{ templateField, ref }]；返回 { [id]: { id, name, ...rule } }（纯对象，可随生成配置传递）。
function resolveUsedFeatureFilters(featureFilters, refs, { headers = null } = {}) {
  const byId = new Map(
    (Array.isArray(featureFilters) ? featureFilters : [])
      .filter(isPlainObject)
      .map((item) => [normalizeCell(item.id), item])
  );
  const resolved = {};
  (Array.isArray(refs) ? refs : []).forEach(({ templateField, ref }) => {
    const id = normalizeCell(ref);
    if (!id) {
      throw fail(`${templateField} 选择了「字段筛选特征值」，请选择特征值`);
    }
    const item = byId.get(id);
    if (!item) {
      throw fail(`${templateField} 选择的特征值不存在，请重新选择`);
    }
    if (!resolved[id]) {
      const name = normalizeCell(item.name);
      resolved[id] = { id, name, ...normalizeFeatureFilterRule(item, { headers, name }) };
    }
  });
  return resolved;
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
  FEATURE_FILTER_NAME_MAX_LENGTH,
  FEATURE_FILTER_SEPARATOR_LABELS,
  LEGACY_FEATURE_FILTER_ID,
  LEGACY_FEATURE_FILTER_NAME,
  buildFeatureFilterToken,
  collectFeatureFilterIds,
  describeFeatureFilterRule,
  extractFeatureValue,
  getFeatureFilterRef,
  matchesFeatureFilter,
  normalizeFeatureFilterList,
  normalizeFeatureFilterRule,
  parseFeatureFilterToken,
  resolveUsedFeatureFilters,
  splitFeatureTokens,
  upgradeLegacyFeatureFilter
};
