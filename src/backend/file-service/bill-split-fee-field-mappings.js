'use strict';

// v3.2.21 拆分/合并账单「字段映射特殊处理」：只作用于费用账单行，按设置覆盖若干模板字段的输出。
// 每项 { templateField, valueType, value }：blank 输出空；input 输出固定值 value；field 取源列 value 的值。
// 账户号、币种、发生额、余额、账单日期与系统按模板名生成的 Channel 不能覆盖（避免费用账单记到别的账户 / 渠道、
//   改变金额 / 余额，或让费用行与交易行的账单日期不同而影响余额按日计算、分段账号识别与查重账期）。
// 渲染端 configuration.js 有同口径的保存前校验，改校验规则时两边一起改。

const { FileValidationError, normalizeCell } = require('./common');

const FEE_FIELD_MAPPING_VALUE_TYPES = Object.freeze(['blank', 'input', 'field']);
const FEE_FIELD_MAPPING_EXCLUDED_TEMPLATE_FIELDS = Object.freeze([
  'BillDate',
  'MerchantId',
  'Currency',
  'Credit Amount',
  'Debit Amount',
  'Balance',
  'Channel'
]);
const EXCLUDED_TEMPLATE_FIELD_SET = new Set(FEE_FIELD_MAPPING_EXCLUDED_TEMPLATE_FIELDS);
const FEE_FIELD_MAPPING_INPUT_MAX_LENGTH = 32767;

function fail(message) {
  throw new FileValidationError('FILE_READ', message);
}

// 接受数组或 JSON 字符串；值去首尾空白，blank 的值清空；丢弃模板字段与映射都为空白的项（界面上清空一行即视为删除）。
function normalizeFeeFieldMappings(raw) {
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
  // 是否整行空白按原始值判断：显式选过取值方式（或带了值）的坏配置要保留下来报错，不能因规范化抹掉后被当作空白行丢弃
  const isBlankRaw = (value) => value === null || value === undefined || (typeof value === 'string' && value.trim() === '');
  return list
    .filter((item) => item && typeof item === 'object' && !Array.isArray(item))
    .filter((item) => !isBlankRaw(item.templateField)
      || (!isBlankRaw(item.valueType) && normalizeCell(item.valueType) !== 'blank')
      || !isBlankRaw(item.value))
    .map((item) => {
      // 只接受文本与能原样表示的数字（布尔、对象、数组等不按字符串化后的 'false'、'[object Object]' 使用；
      //   超出安全整数范围的整数已丢失精度，如 JSON 数字写的长卡号 9007199254740993 读成 …992，须以文本提供）：
      //   非法时取值类型记为无效，保存与生成时拒绝；空白类型不看值。
      const isText = (value) => typeof value === 'string'
        || (typeof value === 'number' && Number.isFinite(value) && (!Number.isInteger(value) || Number.isSafeInteger(value)));
      const rawType = typeof item.valueType === 'string' ? normalizeCell(item.valueType) : '';
      const knownType = FEE_FIELD_MAPPING_VALUE_TYPES.includes(rawType) ? rawType : '';
      const valueAccepted = knownType === 'blank' || item.value === null || item.value === undefined || isText(item.value);
      const valueType = knownType && valueAccepted ? knownType : '';
      return {
        templateField: typeof item.templateField === 'string' ? normalizeCell(item.templateField) : '',
        valueType,
        value: valueType === 'blank' || !isText(item.value) ? '' : normalizeCell(item.value)
      };
    });
}

function isFeeFieldMappingTemplateFieldExcluded(templateField) {
  return EXCLUDED_TEMPLATE_FIELD_SET.has(normalizeCell(templateField));
}

// 返回规范化后的设置。headers 为数组时校验映射字段在模板表头中；allowedTemplateFields 为数组时校验模板字段在可选范围内。
function validateFeeFieldMappings(raw, { headers = null, allowedTemplateFields = null } = {}) {
  const mappings = normalizeFeeFieldMappings(raw);
  if (!mappings.length) {
    fail('请至少新增一个模板字段');
  }
  const headerSet = Array.isArray(headers)
    ? new Set(headers.map((header) => normalizeCell(header)).filter(Boolean))
    : null;
  const allowedSet = Array.isArray(allowedTemplateFields)
    ? new Set(allowedTemplateFields.map((field) => normalizeCell(field)).filter(Boolean))
    : null;
  const seen = new Set();
  mappings.forEach((item, index) => {
    const rowLabel = `第 ${index + 1} 行`;
    if (!item.templateField) {
      fail(`${rowLabel}：请选择模板字段`);
    }
    if (isFeeFieldMappingTemplateFieldExcluded(item.templateField)
      || (allowedSet && !allowedSet.has(item.templateField))) {
      fail(`${rowLabel}：模板字段「${item.templateField}」不支持字段映射特殊处理`);
    }
    if (seen.has(item.templateField)) {
      fail(`模板字段「${item.templateField}」重复，每个模板字段只能设置一次`);
    }
    seen.add(item.templateField);
    if (!item.valueType) {
      fail(`${rowLabel}：映射字段无效`);
    }
    if (item.valueType === 'input' && !item.value) {
      fail(`${rowLabel}：请输入「${item.templateField}」的映射值`);
    }
    // Excel 单元格最多 32767 个字符，超出时明细无法写出
    if (item.valueType === 'input' && item.value.length > FEE_FIELD_MAPPING_INPUT_MAX_LENGTH) {
      fail(`${rowLabel}：「${item.templateField}」的映射值超过 ${FEE_FIELD_MAPPING_INPUT_MAX_LENGTH} 个字符（Excel 单元格上限）`);
    }
    if (item.valueType === 'field') {
      if (!item.value) {
        fail(`${rowLabel}：请选择映射字段`);
      }
      if (headerSet && !headerSet.has(item.value)) {
        fail(`映射字段不存在：${item.value}`);
      }
    }
  });
  return mappings;
}

// 费用账单行某一项的输出原值；readSourceCell(field) 读该行源单元格。
// 取源列时与主映射同口径（resolveRawValueByMapping 把单元格拼成文本）：空白输出空，其余按文本输出，
//   长流水号、卡号等数值单元格不会以数值写出（避免 1.23457E+15 这类显示与精度问题）。
function resolveFeeFieldMappingValue(item, readSourceCell) {
  if (!item) return '';
  if (item.valueType === 'input') return item.value;
  if (item.valueType === 'field') {
    const raw = readSourceCell(item.value);
    return normalizeCell(raw) === '' ? '' : String(raw);
  }
  return '';
}

module.exports = {
  FEE_FIELD_MAPPING_EXCLUDED_TEMPLATE_FIELDS,
  FEE_FIELD_MAPPING_VALUE_TYPES,
  isFeeFieldMappingTemplateFieldExcluded,
  normalizeFeeFieldMappings,
  resolveFeeFieldMappingValue,
  validateFeeFieldMappings
};
