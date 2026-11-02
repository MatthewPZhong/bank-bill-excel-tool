'use strict';

// 平盘链接原始表的导入识别结构。内置结构为 constants 中的表头；设置 → 模板文件启用用户版本后，
//   Main 在每次导入开始时读取各表当前版本，冻结后随任务传入导入 Worker，预检、写入与账户确认使用同一份。
// 只认当前结构：导入时按它识别文件；已存行只校验必用列，导出按当前结构出列。Main 与导入 Worker 共用。

const {
  LINK_HEADERS,
  POSITION_BANK_HEADERS,
  SOURCE_DEFINITIONS,
  SOURCE_REQUIRED_FIELDS,
  SOURCE_TYPES
} = require('./constants');
const { PositionReconciliationError } = require('./common');
const { BANK_STATEMENT_FIELDS } = require('../../constants/bank-statement-fields');
const { canonicalHeaderMapping, projectObjectToCanonical } = require('../../backend/file-service/header-structure-diff');

// 平盘银行对账单可接受的表头（headers 已去首尾空格与末尾空列）：内置 46 列、平盘结果 49 列，
//   以及设置 → 模板文件「银行对账单（导入识别结构）」当前用户版本（bankSourceHeaders，D17，由 Main 在导入开始时冻结）。
//   返回 { headers, project(row) }：project 把按当前版本读出的行对应回内置 46 列名，其余结构原样；都不符时返回 null。
function bankSourceStructure(headers, bankSourceHeaders = null) {
  const same = (expected) => headers.length === expected.length && headers.every((value, index) => value === expected[index]);
  if (same(BANK_STATEMENT_FIELDS)) return { headers: BANK_STATEMENT_FIELDS, project: (row) => row };
  if (same(POSITION_BANK_HEADERS)) return { headers: POSITION_BANK_HEADERS, project: (row) => row };
  if (Array.isArray(bankSourceHeaders) && bankSourceHeaders.length && same(bankSourceHeaders)) {
    const mapping = canonicalHeaderMapping(BANK_STATEMENT_FIELDS, bankSourceHeaders);
    return {
      headers: [...bankSourceHeaders],
      project: (row) => projectObjectToCanonical(row, BANK_STATEMENT_FIELDS, bankSourceHeaders, mapping)
    };
  }
  return null;
}

function invalidStructure(message) {
  return new PositionReconciliationError('position-source-structure-invalid', message);
}

// structures：{ [sourceType]: { headers, versionLabel } }；缺省（null）时使用内置结构。
function normalizeSourceStructures(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) throw invalidStructure('链接原始表导入识别结构格式无效');
  const result = {};
  for (const [sourceType, structure] of Object.entries(value)) {
    const definition = SOURCE_DEFINITIONS[sourceType];
    if (!definition) throw invalidStructure(`未知的链接原始表类型：${sourceType}`);
    const headers = structure && Array.isArray(structure.headers)
      ? structure.headers.map((header) => String(header ?? '').trim())
      : [];
    if (!headers.length) throw invalidStructure(`${definition.sourceName} 的导入识别结构缺少表头`);
    const missing = SOURCE_REQUIRED_FIELDS[sourceType].filter((header) => !headers.includes(header));
    if (missing.length) {
      throw invalidStructure(`${definition.sourceName} 的导入识别结构缺少必用列：${missing.join('、')}`);
    }
    result[sourceType] = Object.freeze({
      headers: Object.freeze(headers),
      versionLabel: String((structure && structure.versionLabel) || '')
    });
  }
  return Object.freeze(result);
}

function sourceDefinitionsFor(structures) {
  const normalized = normalizeSourceStructures(structures);
  if (!normalized) return SOURCE_DEFINITIONS;
  return Object.freeze(Object.fromEntries(Object.entries(SOURCE_DEFINITIONS).map(([sourceType, definition]) => {
    const structure = normalized[sourceType];
    return [sourceType, structure
      ? Object.freeze({ ...definition, headers: structure.headers, versionLabel: structure.versionLabel })
      : definition];
  })));
}

// 账户表的链接行即原始行，列随当前结构；其余链接表由派生生成，列固定。
function linkHeadersFor(sourceType, definitions = SOURCE_DEFINITIONS) {
  return sourceType === SOURCE_TYPES.BANK_ACCOUNT
    ? definitions[SOURCE_TYPES.BANK_ACCOUNT].headers
    : LINK_HEADERS[sourceType];
}

// 已存链接行必须具备的列：账户表只要求必用列（列名可随结构版本变化），其余为派生的固定列。
function linkRequiredFields(sourceType) {
  return sourceType === SOURCE_TYPES.BANK_ACCOUNT
    ? SOURCE_REQUIRED_FIELDS[SOURCE_TYPES.BANK_ACCOUNT]
    : LINK_HEADERS[sourceType];
}

module.exports = {
  bankSourceStructure,
  linkHeadersFor,
  linkRequiredFields,
  normalizeSourceStructures,
  sourceDefinitionsFor
};
