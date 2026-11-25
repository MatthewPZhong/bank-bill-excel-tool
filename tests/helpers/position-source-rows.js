'use strict';

// 直接向平盘侧库写入链接原始表行 / 过滤记录的测试夹具（v3.2.22：行只存必用列并挂原始文件版本号）。
// 只用于需要绕过导入流程、手工摆数据的测试。
const path = require('node:path');

const {
  insertSourceRawFile,
  insertSourceRowStatement,
  pickSourceFields,
  serializeSourceFields,
  sourceRecordKeyOf
} = require('../../src/main-process/position-reconciliation/source-row-storage');

// 同一来源类型 + 文件路径复用同一个版本号。
function ensureSourceRawFile(db, {
  sourceType,
  filePath = '/tmp/source.xlsx',
  fileName = '',
  sheetName = 'Sheet1'
}) {
  const resolved = path.resolve(filePath);
  const existing = db.prepare(`
    SELECT version FROM position_raw_files
    WHERE kind = ? AND original_path = ?
    ORDER BY version DESC LIMIT 1
  `).get(sourceType, resolved);
  if (existing) return Number(existing.version);
  return insertSourceRawFile(db, {
    sourceType,
    originalName: fileName || path.basename(resolved),
    originalPath: resolved,
    sheetName
  });
}

// row：来源行字段对象（可以是完整表头，只取必用列）。返回 { id, rowHash, rawVersion, fields }。
function insertSourceRowFixture(db, {
  sourceType,
  businessKey,
  eventDate = null,
  monthKey = null,
  row,
  rowNumber = 2,
  rowHash = null,
  filePath,
  fileName,
  sheetName
}) {
  const fields = pickSourceFields(sourceType, row || {});
  const rawVersion = ensureSourceRawFile(db, { sourceType, filePath, fileName, sheetName });
  const key = rowHash || sourceRecordKeyOf(fields);
  const result = insertSourceRowStatement(db).run(
    sourceType,
    businessKey,
    eventDate,
    monthKey,
    rawVersion,
    rowNumber,
    key,
    serializeSourceFields(fields)
  );
  return { id: Number(result.lastInsertRowid), rowHash: key, rawVersion, fields };
}

// 过滤记录夹具：未给的报告字段用占位值。返回 { id, rawVersion }。
function insertFilteredSourceFixture(db, {
  reportRowKey,
  sourceType,
  businessKey,
  reconId = '',
  eventDate = null,
  monthKey = null,
  errorCode = 'TEST_FILTER',
  errorReason = '测试过滤',
  rowNumber = 2,
  rowHash,
  importOperationToken = 'operation',
  archiveOperationKey = 'archive-operation',
  reportKey = 'report',
  reportArtifactKey = 'artifact',
  reportFilePath = '/tmp/report.xlsx',
  reportFileName = 'report.xlsx',
  reportSha256 = 'a'.repeat(64),
  reportSizeBytes = 10,
  reportRowCount = 0,
  filePath = '/tmp/filter.xlsx',
  fileName,
  sheetName
}) {
  const rawVersion = ensureSourceRawFile(db, { sourceType, filePath, fileName, sheetName });
  const result = db.prepare(`
    INSERT INTO position_filtered_source_rows(
      report_row_key, source_type, business_key, recon_id,
      event_date, month_key, error_code, error_reason,
      raw_version, source_row_number, row_hash,
      import_operation_token, archive_operation_key,
      report_key, report_artifact_key, report_file_path, report_file_name,
      report_sha256, report_size_bytes, report_row_count
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    reportRowKey,
    sourceType,
    businessKey,
    reconId,
    eventDate,
    monthKey,
    errorCode,
    errorReason,
    rawVersion,
    rowNumber,
    rowHash || `filtered-${reportRowKey}`,
    importOperationToken,
    archiveOperationKey,
    reportKey,
    reportArtifactKey,
    reportFilePath,
    reportFileName,
    reportSha256,
    reportSizeBytes,
    reportRowCount
  );
  return { id: Number(result.lastInsertRowid), rawVersion };
}

module.exports = {
  ensureSourceRawFile,
  insertFilteredSourceFixture,
  insertSourceRowFixture
};
