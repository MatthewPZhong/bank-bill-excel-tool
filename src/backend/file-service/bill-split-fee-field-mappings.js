'use strict';

// v3.2.21 拆分/合并账单「字段映射特殊处理」：只作用于费用账单行，按设置覆盖若干模板字段的输出。
// 每项 { templateField, valueType, value }：blank 输出空；input 输出固定值 value；field 取源列 value 的值。
// 账户号、币种、发生额、余额、账单日期与系统按模板名生成的 Channel 不能覆盖（避免费用账单记到别的账户 / 渠道、
//   改变金额 / 余额，或让费用行与交易行的账单日期不同而影响余额按日计算、分段账号识别与查重账期）。
// 渲染端 configuration.js 有同口径的保存前校验，改校验规则时两边一起改。

const { FileValidationError, isWorksheetWritableText, normalizeCell } = require('./common');

const FEE_FIELD_MAPPING_VALUE_TYPES = Object.freeze(['blank', 'input', 'field']);
// 规范化后无法使用的取值类型统一记为 invalid（非空标记）：保证规范化可重复执行，坏行在模板包导入、落库、读取的多次规范化后
//   仍保留下来，界面显示「（无效）」，保存与生成时拒绝，不被当作空白行静默丢弃。
const FEE_FIELD_MAPPING_INVALID_VALUE_TYPE = 'invalid';
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
// 幂等：规范化结果再规范化不变（无效行以 invalid 标记保留）。
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
  // 是否整行空白按原始值判断：显式选过取值方式（或带了值）的坏配置要保留下来报错，不能因规范化抹掉后被当作空白行丢弃。
  //   两个下拉框都为空白（模板字段空、取值类型为空或 blank）的行忽略；blank 类型不看值（界面上 blank 不带值）。
  const isBlankRaw = (value) => value === null || value === undefined || (typeof value === 'string' && value.trim() === '');
  const isBlankType = (value) => isBlankRaw(value) || (typeof value === 'string' && normalizeCell(value) === 'blank');
  const isPlainObject = (item) => Boolean(item) && typeof item === 'object' && !Array.isArray(item);
  return list
    // 不是对象的非空项（误包一层的数组、字符串、数字、布尔值等）是结构错误：记为无效行保留，不静默丢弃后只用其余设置；
    //   null、空白文本、空数组按空白行忽略
    .filter((item) => !isBlankRaw(item) && !(Array.isArray(item) && item.length === 0))
    .filter((item) => !isPlainObject(item)
      || !isBlankRaw(item.templateField)
      || !isBlankType(item.valueType)
      || (isBlankRaw(item.valueType) && !isBlankRaw(item.value)))
    .map((item) => {
      if (!isPlainObject(item)) {
        return { templateField: '', valueType: FEE_FIELD_MAPPING_INVALID_VALUE_TYPE, value: '' };
      }
      // 值只接受文本：界面与应用导出的模板包都按文本保存，数字只会来自手工改写的模板包，而 JSON 数字在读包时已无法确认原文
      //   （长卡号 9007199254740993 读成 …992、20261119.000000001 读成 20261119、1.10 读成 1.1），用作参考号等对账标识会被
      //   静默改写；布尔、对象、数组等也不按字符串化后的 'false'、'[object Object]' 使用。非文本时取值类型记为无效，
      //   保存与生成时拒绝，须以文本重新填写；空白类型不看值。
      // 文本还须能原样写入工作表（见 common.js isWorksheetWritableText；如上游按长度截断留下的 'ref\ud83d'），否则费用行的参考号等标识
      //   将与设置不同或工作表无法解析，同样记为无效（合法的代理对照常接受）。
      const isText = (value) => isWorksheetWritableText(value);
      const rawType = typeof item.valueType === 'string' ? normalizeCell(item.valueType) : '';
      const knownType = FEE_FIELD_MAPPING_VALUE_TYPES.includes(rawType) ? rawType : '';
      const valueAccepted = knownType === 'blank' || item.value === null || item.value === undefined || isText(item.value);
      const templateField = typeof item.templateField === 'string' ? normalizeCell(item.templateField) : '';
      let valueType = knownType && valueAccepted ? knownType : FEE_FIELD_MAPPING_INVALID_VALUE_TYPE;
      // 模板字段不是文本（如数字、对象）且取值为空白的行，规范化后两项都空，会在下一次规范化时被当作空白行丢弃：记为无效保留
      if (!templateField && valueType === 'blank') valueType = FEE_FIELD_MAPPING_INVALID_VALUE_TYPE;
      return {
        templateField,
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
    if (!FEE_FIELD_MAPPING_VALUE_TYPES.includes(item.valueType)) {
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

// 最终写入明细的费用账单行里、取自源列的覆盖值超过单元格 32767 个字符上限时拒绝生成，列出源行、源列与目标字段，不截断。
//   只校验实际输出的行（合计行、合并时不作代表行的费用行不写出，不因其值拒绝整份账单）。
//   含无法写入 Excel 的字符（U+FFFE、U+FFFF、未配对代理项）的值照常写进明细行，由生成前按最终明细的检查与主映射的值一并
//   列出全批位置（statement-generation.js assertStatementRowsWritable，v3.2.22 B113，Codex 第七轮）
function assertFeeFieldOutputWritable(item, value, { sourceRowNumber } = {}) {
  if (!item || item.valueType !== 'field' || typeof value !== 'string' || !value) return;
  const location = `源文件${sourceRowNumber === undefined ? '' : `第 ${sourceRowNumber} 行`}「${item.value}」列的值`;
  if (value.length > FEE_FIELD_MAPPING_INPUT_MAX_LENGTH) {
    fail(`费用账单「字段映射特殊处理」：${location}超过 ${FEE_FIELD_MAPPING_INPUT_MAX_LENGTH} 个字符（Excel 单元格上限），无法输出到「${item.templateField}」，请修正源文件后重新生成`);
  }
}

module.exports = {
  assertFeeFieldOutputWritable,
  FEE_FIELD_MAPPING_EXCLUDED_TEMPLATE_FIELDS,
  FEE_FIELD_MAPPING_INVALID_VALUE_TYPE,
  FEE_FIELD_MAPPING_VALUE_TYPES,
  isFeeFieldMappingTemplateFieldExcluded,
  isWorksheetWritableText,
  normalizeFeeFieldMappings,
  resolveFeeFieldMappingValue,
  validateFeeFieldMappings
};
