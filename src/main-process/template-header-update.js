'use strict';

// v3.2.18 模板管理【更新】：新旧表头对比、模板配置中引用源字段的位置收集，以及生成前的失效引用拦截。
// 纯函数，不读写数据库与文件；映射标记常量由 main.js 注入，与保存校验、生成逻辑同一口径。
const {
  FileValidationError,
  FIXED_FIELD_VALUE_PREFIX,
  MERCHANT_ID_CURRENCY_ONLY_MARKER,
  normalizeCell
} = require('../backend/file-service/common');

function normalizeHeaderList(headers) {
  return Array.isArray(headers) ? headers.map((header) => normalizeCell(header)) : [];
}

function uniqueNonEmpty(values) {
  return Array.from(new Set(values.filter((value) => value !== '')));
}

// identical 与 findConflictingTemplateByHeaders 同口径：规范化后整组比较（含中间空白占位）。
function diffTemplateHeaders(previousHeaders, nextHeaders) {
  const previous = normalizeHeaderList(previousHeaders);
  const next = normalizeHeaderList(nextHeaders);
  const identical = JSON.stringify(previous) === JSON.stringify(next);
  const previousSet = new Set(previous.filter(Boolean));
  const nextSet = new Set(next.filter(Boolean));
  const added = uniqueNonEmpty(next).filter((header) => !previousSet.has(header));
  const removed = uniqueNonEmpty(previous).filter((header) => !nextSet.has(header));
  const commonInPrevious = uniqueNonEmpty(previous).filter((header) => nextSet.has(header));
  const commonInNext = uniqueNonEmpty(next).filter((header) => previousSet.has(header));
  const relativeOrderChanged = JSON.stringify(commonInPrevious) !== JSON.stringify(commonInNext);
  // 字段集合未变、仅空白列或重名列位置变化时，也视为顺序调整。
  const orderChanged = !identical && (relativeOrderChanged || (!added.length && !removed.length));
  return { identical, added, removed, orderChanged };
}

function createTemplateHeaderUpdateTools(constants = {}) {
  const {
    BALANCE_DISABLED_OPTION,
    BALANCE_CALCULATED_OPTION,
    CONCAT_FIELDS_MAPPING_FIELD,
    FEATURE_FILTER_MAPPING_FIELD,
    AMOUNT_SPLIT_BY_FIELD_MAPPING_FIELD,
    AMOUNT_SPLIT_BY_FIELD_ENABLED_OPTION,
    BILL_SPLIT_MERGE_MAPPING_FIELD,
    BILL_SPLIT_MERGE_ENABLED_OPTION,
    REUSE_MODULE_MAPPING_FIELD
  } = constants;
  const switchTargetFields = new Set([
    AMOUNT_SPLIT_BY_FIELD_MAPPING_FIELD,
    BILL_SPLIT_MERGE_MAPPING_FIELD,
    REUSE_MODULE_MAPPING_FIELD
  ].filter(Boolean));
  // 规则类引用（判断字段、取值字段、拆分行字段、筛选字段）：非空且不是固定值即为源字段。
  function isRuleSourceValue(value) {
    const normalized = normalizeCell(value);
    return normalized !== '' && !normalized.startsWith(FIXED_FIELD_VALUE_PREFIX);
  }

  // 展开后的映射取值（token）按目标字段解释，与生成器一致：拼接 / 筛选模式只由外层 mappedField 决定（见 mappingSourceFields），
  // 展开后的 token 即使与模式名称同名也按源列读取；「无」「通过发生额计算」只在 Balance 上是选项；
  // 按币种取大账号的存储标记只在 MerchantId 上生效；固定值不读源列。其余取值（包括与选项同名的真实列名）都按源字段读取。
  function isMappingSourceValue(target, value) {
    const normalized = normalizeCell(value);
    if (!isRuleSourceValue(normalized)) return false;
    if (target === 'Balance' && (normalized === BALANCE_DISABLED_OPTION || normalized === BALANCE_CALCULATED_OPTION)) return false;
    if (target === 'MerchantId' && normalized === MERCHANT_ID_CURRENCY_ONLY_MARKER) return false;
    return true;
  }

  // 与 main.js normalizeMappedFields 一致：mappedFields 非空（去空去重后）优先，否则取 mappedField。
  function normalizeMappedFields(mapping) {
    const fields = uniqueNonEmpty((Array.isArray(mapping && mapping.mappedFields) ? mapping.mappedFields : [])
      .map((value) => normalizeCell(value)));
    if (fields.length) return fields;
    const fallback = normalizeCell(mapping && mapping.mappedField);
    return fallback ? [fallback] : [];
  }

  function findSwitchValue(mappings, targetField) {
    const mapping = (mappings || []).find((item) => normalizeCell(item && item.templateField) === targetField);
    return normalizeCell(mapping && mapping.mappedField);
  }

  // 一条映射实际引用的源字段，取值顺序与 main.js buildMappedFieldLookup 一致：
  // 字段筛选特征值不读源字段；拼接取 mappedFields；其余在 mappedFields（含单个元素）非空时优先于 mappedField。
  function mappingSourceFields(target, mapping) {
    const mappedField = normalizeCell(mapping && mapping.mappedField);
    if (mappedField === FEATURE_FILTER_MAPPING_FIELD) return [];
    const values = normalizeMappedFields(mapping);
    const tokens = mappedField === CONCAT_FIELDS_MAPPING_FIELD || values.length > 1 ? values : values.slice(0, 1);
    return uniqueNonEmpty(tokens).filter((token) => isMappingSourceValue(target, token));
  }

  function usesFeatureFilter(mappings) {
    return (mappings || []).some((mapping) => {
      return normalizeCell(mapping && mapping.mappedField) === FEATURE_FILTER_MAPPING_FIELD;
    });
  }

  // 收集模板配置中所有引用源字段的位置。active 与生成时实际读取的口径一致：
  // 主映射始终读取；按字段区分发生额开启时读取完整规则；拆分/合并开启时读取拆分行（仅 completed）、
  // 拆分金额规则与按正负号拆分的字段，不复用主映射时还读取拆分映射；字段筛选在实际生效的映射用到时读取。
  function collectTemplateFieldReferences(input = {}) {
    const mappings = Array.isArray(input.mappings) ? input.mappings : [];
    const references = [];
    // 映射类引用已按目标字段过滤；规则类引用只排除空值与固定值。
    const push = (reference) => {
      if (isRuleSourceValue(reference.field)) {
        references.push({ ...reference, field: normalizeCell(reference.field) });
      }
    };

    const amountSplitEnabled = findSwitchValue(mappings, AMOUNT_SPLIT_BY_FIELD_MAPPING_FIELD)
      === AMOUNT_SPLIT_BY_FIELD_ENABLED_OPTION;
    const billSplitEnabled = findSwitchValue(mappings, BILL_SPLIT_MERGE_MAPPING_FIELD)
      === BILL_SPLIT_MERGE_ENABLED_OPTION;
    const reuseModuleMapping = findSwitchValue(mappings, REUSE_MODULE_MAPPING_FIELD) !== '否';
    const billSplitMappingActive = billSplitEnabled && !reuseModuleMapping;

    mappings.forEach((mapping) => {
      const target = normalizeCell(mapping && mapping.templateField);
      if (!target || switchTargetFields.has(target)) return;
      mappingSourceFields(target, mapping).forEach((field) => {
        push({ area: 'mapping', target, role: '', field, active: true });
      });
    });

    (Array.isArray(input.amountSplitRules) ? input.amountSplitRules : []).forEach((rule) => {
      const target = normalizeCell(rule && rule.targetField);
      const conditionField = normalizeCell(rule && rule.conditionField);
      const mappedField = normalizeCell(rule && rule.mappedField);
      const active = amountSplitEnabled && Boolean(target && conditionField && mappedField);
      push({ area: 'amount-split', target, role: 'condition', field: conditionField, active });
      push({ area: 'amount-split', target, role: 'mapped', field: mappedField, active });
    });

    const billSplitMappings = Array.isArray(input.billSplitMappings) ? input.billSplitMappings : [];
    billSplitMappings.forEach((mapping) => {
      const target = normalizeCell(mapping && mapping.templateField);
      if (!target) return;
      mappingSourceFields(target, mapping).forEach((field) => {
        push({ area: 'bill-split-mapping', target, role: '', field, active: billSplitMappingActive });
      });
    });

    (Array.isArray(input.billSplitRows) ? input.billSplitRows : []).forEach((row, index) => {
      const seqNo = Number(row && row.seqNo) || index + 1;
      const active = billSplitEnabled && normalizeCell(row && row.rowStatus) === 'completed';
      [
        ['Currency', row && row.currencySourceField],
        ['Credit Amount', row && row.creditSourceField],
        ['Debit Amount', row && row.debitSourceField],
        ['Amount', row && row.amountSourceField]
      ].forEach(([target, field]) => {
        push({ area: 'bill-split-row', target, role: String(seqNo), field, active });
      });
    });

    (Array.isArray(input.billSplitAmountRules) ? input.billSplitAmountRules : []).forEach((rule) => {
      const target = normalizeCell(rule && rule.targetField);
      push({ area: 'bill-split-amount', target, role: 'condition', field: rule && rule.conditionField, active: billSplitEnabled });
      push({ area: 'bill-split-amount', target, role: 'mapped', field: rule && rule.mappedField, active: billSplitEnabled });
    });

    push({
      area: 'bill-split-signed',
      target: '',
      role: '',
      field: input.billSplitSignedAmountSourceField,
      active: billSplitEnabled
    });

    const featureFilterSourceField = normalizeCell(input.featureFilter && input.featureFilter.sourceField);
    if (featureFilterSourceField) {
      const effectiveMappings = billSplitMappingActive ? billSplitMappings : mappings;
      push({
        area: 'feature-filter',
        target: '',
        role: '',
        field: featureFilterSourceField,
        active: usesFeatureFilter(effectiveMappings)
      });
    }

    return references;
  }

  return Object.freeze({
    collectTemplateFieldReferences,
    findStaleFieldReferences,
    formatFieldReferenceLines,
    assertTemplateFieldReferencesAvailable(template, input) {
      return assertTemplateFieldReferencesAvailable(template, input, collectTemplateFieldReferences);
    }
  });
}

// headers 不是数组（无表头信息）时不判定失效，保持原行为。
function findStaleFieldReferences(references, headers) {
  if (!Array.isArray(headers)) return [];
  const headerSet = new Set(headers.map((header) => normalizeCell(header)).filter(Boolean));
  return (references || []).filter((reference) => !headerSet.has(normalizeCell(reference.field)));
}

const ROLE_LABELS = Object.freeze({ condition: '判断字段', mapped: '取值字段' });

function formatFieldReferenceLine(reference) {
  const suffix = reference.active ? '' : '（未启用）';
  const field = reference.field;
  switch (reference.area) {
    case 'mapping':
      return `${reference.target} ← ${field}${suffix}`;
    case 'amount-split':
      return `按字段区分发生额 · ${reference.target || '（未设置目标字段）'} ${ROLE_LABELS[reference.role] || ''} ← ${field}${suffix}`;
    case 'bill-split-mapping':
      return `拆分账单映射 · ${reference.target} ← ${field}${suffix}`;
    case 'bill-split-row':
      return `拆分账单第 ${reference.role} 份 · ${reference.target} ← ${field}${suffix}`;
    case 'bill-split-amount':
      return `拆分账单发生额规则 · ${reference.target || '（未设置目标字段）'} ${ROLE_LABELS[reference.role] || ''} ← ${field}${suffix}`;
    case 'bill-split-signed':
      return `拆分账单 · 按正负号拆分的发生额 ← ${field}${suffix}`;
    case 'feature-filter':
      return `字段筛选特征值 · 筛选字段 ← ${field}${suffix}`;
    default:
      return `${reference.target || ''} ← ${field}${suffix}`;
  }
}

function formatFieldReferenceLines(references) {
  return Array.from(new Set((references || []).map(formatFieldReferenceLine)));
}

// 生成前拦截：模板配置实际会读取的源字段不在模板表头中时拒绝生成，避免该列静默输出空值。
function assertTemplateFieldReferencesAvailable(template, input, collect) {
  const headers = template && template.headers;
  const stale = findStaleFieldReferences(collect(input), headers).filter((reference) => reference.active);
  if (!stale.length) return;
  const templateName = normalizeCell(template && template.name);
  const missingFields = uniqueNonEmpty(stale.map((reference) => reference.field));
  throw new FileValidationError(
    'TEMPLATE_MAPPING_FIELD_MISSING',
    `模板「${templateName}」的映射字段不存在：${missingFields.join('、')}，请在模板管理中修改映射关系后重新导入`,
    {
      detailLines: ['以下映射引用的字段已不在模板表头中：'].concat(formatFieldReferenceLines(stale)),
      context: { templateName, missingFields }
    }
  );
}

module.exports = {
  createTemplateHeaderUpdateTools,
  diffTemplateHeaders,
  findStaleFieldReferences,
  formatFieldReferenceLines
};
