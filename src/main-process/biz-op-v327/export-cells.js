'use strict';

const registry = require('./output-schemas.json');
const { canonicalizeDecimal } = require('../financial-decimal');
const { classifyNumericOutput } = require('../../backend/toolbox-format/number-date');
const { assertExcelCellTextLength } = require('../../backend/toolbox-format/excel-text');
const { CELL_CONTRACT_VERSION } = require('./import-adapter');
const { fail } = require('./contracts');

const ERROR_COLUMNS = ['记录类别', '来源原件ID', '文件顺序', '来源工作表', '来源行号', '错误代码', '错误说明'];
const ERROR_SCHEMA = Object.freeze({ outputKind: 'ERRORS', columnSchemaVersion: 1, columnCount: 7,
  columns: ERROR_COLUMNS.map((header, index) => ({ header, domain: [1, 2, 4].includes(index) ? 'integer' : 'text' })) });
const SHEET_NAMES = Object.freeze({ OP_RAW: '业务OP校验原表', FLOW_RAW: '流水校验原表', OP_CHECK: '业务OP校验表',
  FLOW_CHECK: '流水校验表', RESULT_FULL: '结果原表', RESULT_DIFF: '结果表', ERRORS: '导入错误报告' });
const NULL_CELL = Object.freeze({ t: 'null', v: null, f: 'General' });
function schemaFor(kind, version = 1) {
  const schema = kind === 'ERRORS' ? ERROR_SCHEMA : registry.outputKinds[kind];
  if (!schema || !Number.isSafeInteger(version)) fail('BIZOP_OUTPUT_SCHEMA_UNKNOWN');
  if (version === schema.columnSchemaVersion) return schema;
  const revision = registry.outputKindVersions?.[kind]?.[version];
  if (!revision || revision.baseColumnSchemaVersion !== schema.columnSchemaVersion) fail('BIZOP_OUTPUT_SCHEMA_UNKNOWN');
  return { ...schema, columnSchemaVersion: version,
    columns: schema.columns.map((column) => ({ ...column, ...revision.columnOverrides.find((item) => item.index === column.index) })) };
}
function text(value) { return value == null ? NULL_CELL : { t: 'text', v: assertExcelCellTextLength(String(value)), f: '@' }; }
function number(value, onPrecision = () => {}) {
  if (value == null || value === '') return value == null ? NULL_CELL : text('');
  const canonical = canonicalizeDecimal(value);
  const projection = classifyNumericOutput(canonical);
  if (projection.outputType === 'text') { onPrecision(canonical, projection.reason); return text(canonical); }
  return { t: 'number', v: canonical, f: projection.numFmt || 'General' };
}
function cell(value, domain, onPrecision) {
  if (value == null) return NULL_CELL;
  if (domain === 'decimal' || domain === 'integer') return number(value, onPrecision);
  return text(value);
}
function rawCell(source, normalized, kind, index, onPrecision) {
  if (!source || source.cellType === 'blank') return NULL_CELL;
  const dateColumns = kind === 'OP' ? [0, 14, 21, 22] : [1, 16, 17, 20, 26, 27];
  const amountColumns = kind === 'OP' ? [7, 8, 9, 10, 11, 12, 13] : [13];
  const identityColumns = kind === 'OP' ? [1, 4, 6] : [6, 11, 14];
  if (dateColumns.includes(index) || identityColumns.includes(index)) return text(normalized);
  if (amountColumns.includes(index)) return number(normalized, onPrecision);
  if (source.cellType === 'boolean') return { t: 'boolean', v: source.decodedSemanticValue === true, f: 'General' };
  if (source.cellType === 'number') return number(source.rawLexicalValue, onPrecision);
  if (source.hasFormula || source.cellType === 'error') fail('BIZOP_OUTPUT_SOURCE_INVALID');
  return text(normalized);
}
function evidenceIdentity({ outputKind, columnSchemaVersion = 1, objectId, manifestDigest, maxRowsPerSheet }) {
  const schema = schemaFor(outputKind, columnSchemaVersion);
  return { evidenceVersion: registry.evidenceVersion, evidenceSchemaRevision: schema.evidenceSchemaRevision ?? registry.evidenceSchemaRevision,
    outputKind, columnSchemaVersion, cellContractVersion: CELL_CONTRACT_VERSION, ownerId: objectId,
    manifestDigest, maxRowsPerSheet, notesSchemaVersion: schema.notesSchema === null ? null : 1 };
}
function outputName(kind, metadata) {
  schemaFor(kind);
  if (kind === 'ERRORS') return '业务OP导入错误报告';
  if (kind.startsWith('RESULT_')) {
    const end = metadata.startDate.slice(0, 4) === metadata.endDate.slice(0, 4) ? metadata.endDate.slice(5) : metadata.endDate;
    return `业务OP校验${kind === 'RESULT_FULL' ? '结果原表' : '结果表'}_${metadata.startDate}~${end}_v${metadata.version}`;
  }
  return `${SHEET_NAMES[kind]}_${metadata.dataDate}_v${metadata.version}`;
}
function sheetName(kind, page, source) {
  const suffix = page === 1 ? '' : `(${page})`;
  const metadata = source?.metadata;
  let name = SHEET_NAMES[kind] || '核对说明';
  if (metadata && kind.startsWith('RESULT_')) {
    const start = metadata.startDate.replaceAll('-', ''); const end = metadata.endDate.replaceAll('-', '');
    name = `${start}_v${metadata.startInputVersion} VS ${end}_v${metadata.endInputVersion}`;
    if (name.length + suffix.length > 31) name = `${start} VS ${end}`;
  } else if (metadata && ['OP_RAW', 'OP_CHECK', 'FLOW_RAW', 'FLOW_CHECK'].includes(kind)) {
    name = outputName(kind, metadata);
    if (name.length + suffix.length > 31) name = `${kind.startsWith('OP') ? 'OP' : 'FLOW'}_${metadata.dataDate.replaceAll('-', '')}`;
  }
  if (name.length + suffix.length > 31) fail('BIZOP_OUTPUT_SHEET_NAME_INVALID');
  return name + suffix;
}
module.exports = { registry, schemaFor, text, number, cell, rawCell, NULL_CELL, evidenceIdentity, sheetName, outputName };
