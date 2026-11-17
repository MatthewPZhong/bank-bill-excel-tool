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
    REUSE_MODULE_MAPPING_FIELD,
    SIGNED_AMOUNT_MAPPING_FIELD,
    AMOUNT_BASED_NAME_MAPPING_FIELD,
    AMOUNT_BASED_ACCOUNT_MAPPING_FIELD
  } = constants;
  // 生成器把这三个高级字段的映射值整体当作一个列名读取（file-service.js normalizeCell(amountMappingRules.*)），
  // 多字段配置会被拼成「A,B」这一列名，而不是分别读取 A、B。
  const scalarSourceTargetFields = new Set([
    SIGNED_AMOUNT_MAPPING_FIELD,
    AMOUNT_BASED_NAME_MAPPING_FIELD,
    AMOUNT_BASED_ACCOUNT_MAPPING_FIELD
  ].filter(Boolean));
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

  // 一条映射实际引用的源字段，与生成器（main.js buildMappedFieldLookup、file-service.js buildMappedRows）逐项一致：
  // - 模式只由外层 mappedField 决定：字段筛选特征值不读源列；拼接取 mappedFields；其余在 mappedFields（含单个元素）
  //   非空时优先于 mappedField。展开后的 token 即使与模式名称、选项文字同名，也按源列读取。
  // - MerchantId 只在第一个 token 为按币种取大账号标记时整体走回填（其余 token 不读）；标记在后续位置时按源列读取。
  // - Balance 只在整条映射是单个「无」「通过发生额计算」时为选项；拼接中的同名 token 按源列读取。
  // - 按正负号拆分的发生额、根据发生额做映射的户名 / 账户号：整体作为一个列名读取（多字段时为逗号拼接的列名）。
  // - 固定值（__FIXED__: 前缀）不读源列。
  function mappingSourceFields(target, mapping) {
    const mappedField = normalizeCell(mapping && mapping.mappedField);
    if (mappedField === FEATURE_FILTER_MAPPING_FIELD) return [];
    const values = normalizeMappedFields(mapping);
    const multi = mappedField === CONCAT_FIELDS_MAPPING_FIELD || values.length > 1;
    if (scalarSourceTargetFields.has(target)) {
      // 与 buildMappedFieldLookup 得到的取值一致，再按生成器的 normalizeCell(String(value)) 得到实际读取的列名。
      const rawFields = Array.isArray(mapping && mapping.mappedFields) ? mapping.mappedFields : [];
      const lookupValue = mappedField === CONCAT_FIELDS_MAPPING_FIELD
        ? (rawFields.length ? rawFields : values)
        : (values.length > 1 ? values : (values[0] || ''));
      const field = normalizeCell(String(lookupValue));
      return isRuleSourceValue(field) ? [field] : [];
    }
    const tokens = multi ? values : values.slice(0, 1);
    if (target === 'MerchantId' && tokens[0] === MERCHANT_ID_CURRENCY_ONLY_MARKER) return [];
    if (target === 'Balance' && !multi
      && (tokens[0] === BALANCE_DISABLED_OPTION || tokens[0] === BALANCE_CALCULATED_OPTION)) return [];
    return uniqueNonEmpty(tokens).filter(isRuleSourceValue);
  }

  // v3.2.18 多特征值：映射行所选特征值 id 存于 mappedFields[0]（与 file-service getFeatureFilterRef 一致）。
  function usedFeatureFilterIds(mappings) {
    const ids = new Set();
    (mappings || []).forEach((mapping) => {
      if (normalizeCell(mapping && mapping.mappedField) !== FEATURE_FILTER_MAPPING_FIELD) return;
      const ref = normalizeCell(Array.isArray(mapping.mappedFields) ? mapping.mappedFields[0] : '');
      if (ref) ids.add(ref);
    });
    return ids;
  }

  // 收集模板配置中所有引用源字段的位置。active 与生成时实际读取的口径一致：
  // 主映射始终读取；按字段区分发生额开启时读取完整规则；拆分/合并开启时读取拆分行（仅 completed）、
  // 拆分金额规则与按正负号拆分的字段，不复用主映射时还读取拆分映射；
  // 费用账单发生额公式（v3.2.19）在拆分开启、勾选特殊取值且有已完成的费用账单行时读取；
  // 特征值（v3.2.18 起可有多个）各自的筛选字段只在实际生效的映射选用该特征值时读取。
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

    const billSplitRows = Array.isArray(input.billSplitRows) ? input.billSplitRows : [];
    const feeFormulaActive = billSplitEnabled
      && Boolean(input.billSplitFeeAmountFormulaEnabled)
      && billSplitRows.some((row) => (
        row && row.isFeeBill === true && normalizeCell(row.rowStatus) === 'completed'
      ));

    billSplitRows.forEach((row, index) => {
      const seqNo = Number(row && row.seqNo) || index + 1;
      const active = billSplitEnabled && normalizeCell(row && row.rowStatus) === 'completed';
      // v3.2.19：费用账单行不读 Credit；特殊取值生效时也不读 Debit（映射保留，标为未启用）
      const isFeeBill = Boolean(row && row.isFeeBill === true);
      [
        ['Currency', row && row.currencySourceField, active],
        ['Credit Amount', row && row.creditSourceField, active && !isFeeBill],
        ['Debit Amount', row && row.debitSourceField, active && !(isFeeBill && feeFormulaActive)],
        ['Amount', row && row.amountSourceField, active]
      ].forEach(([target, field, fieldActive]) => {
        push({ area: 'bill-split-row', target, role: String(seqNo), field, active: fieldActive });
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

    (Array.isArray(input.billSplitFeeAmountFormula) ? input.billSplitFeeAmountFormula : []).forEach((item, index) => {
      push({
        area: 'bill-split-fee-formula',
        target: '',
        role: String(index + 1),
        field: item && item.field,
        active: feeFormulaActive
      });
    });

    const usedIds = usedFeatureFilterIds(billSplitMappingActive ? billSplitMappings : mappings);
    (Array.isArray(input.featureFilters) ? input.featureFilters : []).forEach((featureFilter) => {
      const id = normalizeCell(featureFilter && featureFilter.id);
      push({
        area: 'feature-filter',
        target: normalizeCell(featureFilter && featureFilter.name),
        role: '',
        field: featureFilter && featureFilter.sourceField,
        active: Boolean(id) && usedIds.has(id)
      });
    });

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
      return `拆分账单 · 按正负号取发生额 ← ${field}${suffix}`;
    case 'bill-split-fee-formula':
      return `拆分账单 · 费用账单发生额公式第 ${reference.role} 组 ← ${field}${suffix}`;
    case 'feature-filter':
      return reference.target
        ? `特征值「${reference.target}」 · 筛选字段 ← ${field}${suffix}`
        : `字段筛选特征值 · 筛选字段 ← ${field}${suffix}`;
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
