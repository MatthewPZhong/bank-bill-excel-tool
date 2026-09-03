'use strict';

const fs = require('node:fs');

const {
  absolutePath,
  exactKeys,
  normalizeReadOnlyExportInput
} = require('../common/contract');
const {
  VCC_FINANCIAL_OP_READ_ONLY_ACTION_SET
} = require('./policies');

function inputError(message) {
  const error = new TypeError(message);
  error.code = 'VCC_FINANCIAL_OP_EXPORT_INPUT_INVALID';
  return error;
}

function digest(value, label, nullable = false) {
  if (nullable && value === null) return null;
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) {
    throw inputError(`${label}必须为 SHA-256`);
  }
  return value;
}

function positiveInteger(value, label, nullable = false) {
  if (nullable && value === null) return null;
  if (!Number.isSafeInteger(value) || value < 1) throw inputError(`${label}必须为正整数`);
  return value;
}

function nonNegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw inputError(`${label}必须为非负整数`);
  }
  return value;
}

function normalizeSource(value) {
  exactKeys(value, ['kind', 'mainDatabasePath'], 'VCC Financial OP source');
  if (value.kind !== 'sqlite') throw inputError('VCC Financial OP source kind 非法');
  const mainDatabasePath = absolutePath(value.mainDatabasePath, 'mainDatabasePath');
  const stat = fs.lstatSync(mainDatabasePath);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw inputError('VCC Financial OP 数据库必须为普通文件');
  }
  return Object.freeze({ kind: value.kind, mainDatabasePath });
}

function normalizeMissingRows(value) {
  if (!Array.isArray(value)) throw inputError('missingByImportRecord 必须为数组');
  const ids = new Set();
  return Object.freeze(value.map((item) => {
    exactKeys(item, ['importRecordId', 'missingRows'], 'missingByImportRecord item');
    const importRecordId = positiveInteger(item.importRecordId, 'importRecordId');
    const missingRows = nonNegativeInteger(item.missingRows, 'missingRows');
    if (ids.has(importRecordId) || missingRows === 0) {
      throw inputError('missingByImportRecord identity 重复或行数为零');
    }
    ids.add(importRecordId);
    return Object.freeze({ importRecordId, missingRows });
  }));
}

function normalizeInspection(value) {
  if (value === null) return null;
  exactKeys(value, [
    'exportableRows', 'incomplete', 'missingByImportRecord', 'missingRows',
    'sourceType', 'targetKind', 'targetMonth', 'totalRows'
  ], 'VCC dataset inspection');
  if (typeof value.targetMonth !== 'string' || !/^\d{4}-\d{2}$/.test(value.targetMonth) ||
      typeof value.sourceType !== 'string' || !value.sourceType ||
      !['raw', 'check'].includes(value.targetKind) || typeof value.incomplete !== 'boolean') {
    throw inputError('VCC dataset inspection identity 非法');
  }
  for (const key of ['totalRows', 'exportableRows', 'missingRows']) {
    nonNegativeInteger(value[key], `inspection.${key}`);
  }
  if (value.totalRows < 1 || value.exportableRows > value.totalRows ||
      value.missingRows !== value.totalRows - value.exportableRows ||
      value.incomplete !== (value.missingRows > 0)) {
    throw inputError('VCC dataset inspection 行数或 incomplete 关系不守恒');
  }
  const missingByImportRecord = normalizeMissingRows(value.missingByImportRecord);
  const itemizedMissingRows = missingByImportRecord.reduce(
    (sum, item) => sum + item.missingRows,
    0
  );
  if (itemizedMissingRows > value.missingRows) {
    throw inputError('VCC dataset inspection 分项缺失行数超过总缺失行数');
  }
  return Object.freeze({
    targetMonth: value.targetMonth,
    sourceType: value.sourceType,
    targetKind: value.targetKind,
    totalRows: value.totalRows,
    exportableRows: value.exportableRows,
    missingRows: value.missingRows,
    incomplete: value.incomplete,
    missingByImportRecord
  });
}

function normalizeArchiveSources(value) {
  if (!Array.isArray(value)) throw inputError('archiveSources 必须为数组');
  const ids = new Set();
  return Object.freeze(value.map((item) => {
    exactKeys(item, ['fileName', 'filePath', 'sha256', 'sizeBytes', 'sourceId'], 'archiveSource');
    const sourceId = positiveInteger(item.sourceId, 'archiveSource.sourceId');
    const filePath = absolutePath(item.filePath, 'archiveSource.filePath');
    const fileName = typeof item.fileName === 'string' ? item.fileName : '';
    const stat = fs.lstatSync(filePath);
    if (ids.has(sourceId) || stat.isSymbolicLink() || !stat.isFile() || stat.size < 1 ||
        !fileName || !Number.isSafeInteger(item.sizeBytes) || item.sizeBytes < 1 ||
        Number(stat.size) !== item.sizeBytes) {
      throw inputError('archiveSource identity 非法或重复');
    }
    ids.add(sourceId);
    return Object.freeze({
      sourceId,
      filePath,
      fileName,
      sha256: digest(item.sha256, 'archiveSource.sha256'),
      sizeBytes: item.sizeBytes
    });
  }));
}

function normalizeContext(value) {
  exactKeys(value, [
    'archiveSources', 'expectedInspection', 'kind', 'recordId',
    'sourceType', 'targetKind', 'targetMonth'
  ], 'VCC Financial OP context');
  const archiveSources = normalizeArchiveSources(value.archiveSources);
  if (value.kind === 'vcc-import-audit') {
    if (archiveSources.length || value.expectedInspection !== null ||
        value.sourceType !== null || value.targetKind !== null || value.targetMonth !== null) {
      throw inputError('VCC import-audit context 携带了 dataset 字段');
    }
    return Object.freeze({
      kind: value.kind,
      recordId: positiveInteger(value.recordId, 'recordId'),
      targetMonth: null,
      sourceType: null,
      targetKind: null,
      expectedInspection: null,
      archiveSources
    });
  }
  if (value.kind !== 'vcc-dataset-export' || value.recordId !== null) {
    throw inputError('VCC Financial OP context kind 非法');
  }
  const expectedInspection = normalizeInspection(value.expectedInspection);
  if (!expectedInspection || expectedInspection.targetMonth !== value.targetMonth ||
      expectedInspection.sourceType !== value.sourceType ||
      expectedInspection.targetKind !== value.targetKind) {
    throw inputError('VCC dataset context/inspection 不一致');
  }
  return Object.freeze({
    kind: value.kind,
    recordId: null,
    targetMonth: String(value.targetMonth || ''),
    sourceType: String(value.sourceType || ''),
    targetKind: String(value.targetKind || ''),
    expectedInspection,
    archiveSources
  });
}

function normalizeEvidence(value) {
  exactKeys(value, [
    'anomalyCount', 'anomalyDigest', 'archiveSetDigest', 'contractVersion',
    'datasetRevisionDigest', 'inspectionDigest', 'recordDigest', 'recordId',
    'sourceDigest', 'variant'
  ], 'VCC Financial OP stableRunEvidence');
  if (value.contractVersion !== 1 || !['dataset', 'import-audit'].includes(value.variant)) {
    throw inputError('VCC Financial OP stableRunEvidence 非法');
  }
  if (value.variant === 'import-audit') {
    if (value.datasetRevisionDigest !== null || value.inspectionDigest !== null) {
      throw inputError('VCC import-audit evidence 携带了 dataset 字段');
    }
    return Object.freeze({
      contractVersion: 1,
      variant: value.variant,
      recordId: positiveInteger(value.recordId, 'recordId'),
      recordDigest: digest(value.recordDigest, 'recordDigest'),
      anomalyCount: positiveInteger(value.anomalyCount, 'anomalyCount'),
      anomalyDigest: digest(value.anomalyDigest, 'anomalyDigest'),
      datasetRevisionDigest: null,
      inspectionDigest: null,
      archiveSetDigest: digest(value.archiveSetDigest, 'archiveSetDigest'),
      sourceDigest: digest(value.sourceDigest, 'sourceDigest')
    });
  }
  if (value.recordId !== null || value.recordDigest !== null ||
      value.anomalyCount !== null || value.anomalyDigest !== null) {
    throw inputError('VCC dataset evidence 携带了 import-audit 字段');
  }
  return Object.freeze({
    contractVersion: 1,
    variant: value.variant,
    recordId: null,
    recordDigest: null,
    anomalyCount: null,
    anomalyDigest: null,
    datasetRevisionDigest: digest(value.datasetRevisionDigest, 'datasetRevisionDigest'),
    inspectionDigest: digest(value.inspectionDigest, 'inspectionDigest'),
    archiveSetDigest: digest(value.archiveSetDigest, 'archiveSetDigest'),
    sourceDigest: digest(value.sourceDigest, 'sourceDigest')
  });
}

function normalizeVccFinancialOpReadOnlyExportInput(value) {
  const normalized = normalizeReadOnlyExportInput(
    value,
    VCC_FINANCIAL_OP_READ_ONLY_ACTION_SET,
    normalizeSource,
    normalizeEvidence,
    normalizeContext
  );
  const expectedKind = normalized.stableRunEvidence.variant === 'dataset'
    ? 'vcc-dataset-export'
    : 'vcc-import-audit';
  if (normalized.context.kind !== expectedKind ||
      normalized.context.recordId !== normalized.stableRunEvidence.recordId) {
    throw inputError('VCC context/evidence identity 不一致');
  }
  return normalized;
}

module.exports = {
  normalizeArchiveSources,
  normalizeContext,
  normalizeEvidence,
  normalizeInspection,
  normalizeSource,
  normalizeVccFinancialOpReadOnlyExportInput
};
