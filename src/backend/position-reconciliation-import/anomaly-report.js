'use strict';

const { readIdentityStat } = require('../../main-process/archive-center/filesystem-identity');

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const ExcelJS = require('exceljs');

const {
  RAW_VERSION_HEADER,
  SOURCE_REQUIRED_FIELDS,
  SOURCE_TYPES
} = require('../../main-process/position-reconciliation/constants');
const {
  PositionReconciliationError,
  text
} = require('../../main-process/position-reconciliation/common');
const {
  sourceSnapshotFromStat
} = require('../../main-process/archive-center/source-snapshot');
const {
  hashFileSha256Async
} = require('../../main-process/position-reconciliation/input-staging');
const { parseSourceFields } = require('../../main-process/position-reconciliation/source-row-storage');

const EXCEL_MAX_ROWS = 1048576;
const REPORT_ARTIFACT_KEY = 'source-import-anomaly-report';
const REPORT_SOURCE_OPERATION = 'source-import-anomaly-report';
const SUMMARY_SHEET_NAME = '异常汇总';
const DETAIL_META_HEADERS = Object.freeze([
  '过滤记录标识', '源文件', 'Sheet', 'Excel行号', '来源类型',
  '业务单号', 'ReconID', '错误码', '异常原因', '业务日期', '月份', RAW_VERSION_HEADER
]);
// 导入进程在事务内把过滤行的必用列暂存到这张临时表，供生成异常报告；随连接关闭自动清除。
const FILTERED_PAYLOAD_TABLE = 'position_import_filtered_payload';
const TEXT_HEADER_PATTERN = /id|no|code|账号|账户|卡号|单号|流水号|对账|批次号|清算号码|swift|标识/i;
const COLUMN_WIDTHS = Object.freeze({
  文件名: 44,
  源文件: 44,
  Sheet: 20,
  Excel行号: 12,
  来源类型: 18,
  过滤记录标识: 32,
  业务单号: 32,
  ReconID: 32,
  错误码: 40,
  异常原因: 48,
  原因统计: 48,
  业务日期: 14,
  月份: 12,
  交易时间: 20,
  创建时间: 20,
  更新时间: 20
});

function reportError(message, detailLines = []) {
  return new PositionReconciliationError(
    'position-anomaly-report-failed',
    message,
    detailLines
  );
}

function styleHeader(row) {
  row.font = { bold: true, color: { argb: 'FF1F2937' } };
  row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8EEF8' } };
  row.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
  row.height = 30;
}

function configureColumns(sheet, headers) {
  sheet.columns = headers.map((header) => {
    const normalized = String(header);
    const isReason = normalized === '异常原因' || normalized === '原因统计';
    const isText = TEXT_HEADER_PATTERN.test(normalized);
    return {
      width: COLUMN_WIDTHS[normalized]
        || Math.min(36, Math.max(isText ? 30 : 14, normalized.length * 2 + 4)),
      style: {
        ...(isText ? { numFmt: '@' } : {}),
        ...(isReason ? { alignment: { vertical: 'top', wrapText: true } } : {})
      }
    };
  });
}

function addHeader(sheet, headers) {
  configureColumns(sheet, headers);
  const row = sheet.addRow(headers);
  styleHeader(row);
  row.commit();
  sheet.autoFilter = {
    from: { row: 1, column: 1 },
    to: { row: 1, column: headers.length }
  };
}

function reasonSummary(value) {
  return Object.entries(value || {})
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([code, count]) => `${code}=${Number(count)}`)
    .join('；');
}

function excelValueForHeader(header, value) {
  const normalized = value ?? '';
  if (normalized === '' || !TEXT_HEADER_PATTERN.test(String(header))) return normalized;
  return { richText: [{ text: String(normalized) }] };
}

// 过滤明细列：过滤信息 + 该来源保存下来的必用列。
function detailHeadersFor(sourceType) {
  return [...DETAIL_META_HEADERS, ...SOURCE_REQUIRED_FIELDS[sourceType]];
}

function reportDetailValues(item, sourceType) {
  const headers = detailHeadersFor(sourceType);
  const values = [
    item.reportRowKey,
    item.fileName,
    item.sheetName,
    item.rowNumber,
    item.sourceType,
    item.businessKey,
    item.reconId,
    item.errorCode,
    item.errorReason,
    item.eventDate || '',
    item.monthKey || '',
    item.rawVersion,
    ...SOURCE_REQUIRED_FIELDS[sourceType].map((header) => item.row[header] ?? '')
  ];
  return values.map((value, index) => excelValueForHeader(headers[index], value));
}

function createFilteredPayloadTable(db) {
  db.exec(`
    CREATE TEMP TABLE IF NOT EXISTS ${FILTERED_PAYLOAD_TABLE} (
      filtered_id INTEGER PRIMARY KEY,
      file_index INTEGER NOT NULL,
      fields_json TEXT NOT NULL
    );
    DELETE FROM ${FILTERED_PAYLOAD_TABLE};
  `);
}

// 过滤行内容由 serializeSourceFields 写入，日期单元格带类型标记：按配套的方式还原，
// 报告里写出的是日期本身，而不是内部标记的 JSON 文本。
function parsePayload(value) {
  return parseSourceFields(value);
}

function detailSheetBaseName(sourceType) {
  if (sourceType === SOURCE_TYPES.FUND_TRANSFER) return '调拨异常明细';
  if (sourceType === SOURCE_TYPES.TEST_PAYMENT) return '测试付款异常明细';
  throw reportError(`不支持生成异常明细的来源：${sourceType}`);
}

// 从侧库（事务内、尚未提交）读取本次导入的过滤行生成异常报告。
// files：本次被接受且含过滤行的文件统计（fileIndex、fileName、sourceType、各行数、原因统计）。
async function writePositionAnomalyReport({
  db,
  files,
  jobRoot,
  jobId,
  artifactKey = REPORT_ARTIFACT_KEY,
  fileName = `平盘来源异常数据_${String(jobId)}.xlsx`,
  displayRole = '异常数据'
}) {
  const reportFiles = (Array.isArray(files) ? files : [])
    .filter((file) => Number(file.filteredRows) > 0)
    .sort((left, right) => Number(left.fileIndex) - Number(right.fileIndex));
  const filteredCount = reportFiles.reduce((sum, file) => sum + Number(file.filteredRows), 0);
  if (filteredCount === 0) return null;
  const fileIndexes = reportFiles.map((file) => Number(file.fileIndex));

  const reportDir = path.join(path.resolve(jobRoot), 'anomaly-report');
  await fs.promises.mkdir(reportDir, { recursive: true, mode: 0o700 });
  const normalizedArtifactKey = text(artifactKey);
  const normalizedFileName = text(fileName);
  if (!normalizedArtifactKey || !normalizedFileName || path.basename(normalizedFileName) !== normalizedFileName) {
    throw new TypeError('异常报告 artifact key 或文件名非法');
  }
  const outputPath = path.join(reportDir, normalizedFileName);
  const temporaryPath = `${outputPath}.${crypto.randomUUID()}.tmp`;
  const reportKey = `${String(jobId)}:${normalizedArtifactKey}`;
  let workbook;
  try {
    workbook = new ExcelJS.stream.xlsx.WorkbookWriter({
      filename: temporaryPath,
      useStyles: true,
      useSharedStrings: false
    });
    const summaryHeaders = [
      '文件名', '来源类型', '物理数据行数', '正常落库行数', '过滤行数',
      '重复折叠行数', '生成链接行数', '原因统计'
    ];
    const summary = workbook.addWorksheet(SUMMARY_SHEET_NAME);
    addHeader(summary, summaryHeaders);
    for (const file of reportFiles) {
      const reportRow = summary.addRow([
        file.fileName,
        file.sourceType,
        file.scannedNonBlankRows,
        file.persistedCandidateRows,
        file.filteredRows,
        file.collapsedDuplicateRows,
        Number(file.visibleLinkRows) + Number(file.hiddenLinkRows),
        reasonSummary(file.filterReasonCounts)
      ]);
      reportRow.height = 30;
      reportRow.getCell(8).alignment = { vertical: 'top', wrapText: true };
      reportRow.commit();
    }
    summary.commit();

    const readDetails = db.prepare(`
      SELECT filtered.report_row_key AS reportRowKey,
             raw.original_name AS fileName, raw.sheet_name AS sheetName,
             filtered.source_row_number AS rowNumber,
             filtered.source_type AS sourceType,
             filtered.business_key AS businessKey, filtered.recon_id AS reconId,
             filtered.error_code AS errorCode, filtered.error_reason AS errorReason,
             filtered.event_date AS eventDate, filtered.month_key AS monthKey,
             filtered.raw_version AS rawVersion, payload.fields_json AS fieldsJson
      FROM ${FILTERED_PAYLOAD_TABLE} payload
      JOIN position_filtered_source_rows filtered ON filtered.id = payload.filtered_id
      JOIN position_raw_files raw ON raw.version = filtered.raw_version
      WHERE filtered.source_type = ?
        AND payload.file_index IN (${fileIndexes.map(() => '?').join(', ')})
      ORDER BY payload.file_index, filtered.source_row_number, filtered.id
    `);
    let writtenRows = 0;
    for (const sourceType of [SOURCE_TYPES.FUND_TRANSFER, SOURCE_TYPES.TEST_PAYMENT]) {
      const headers = detailHeadersFor(sourceType);
      let sheet = null;
      let sheetIndex = 0;
      let dataRows = 0;
      for (const stored of readDetails.iterate(sourceType, ...fileIndexes)) {
        if (!sheet || dataRows >= EXCEL_MAX_ROWS - 1) {
          if (sheet) sheet.commit();
          sheetIndex += 1;
          dataRows = 0;
          const baseName = detailSheetBaseName(sourceType);
          const name = sheetIndex === 1 ? baseName : `${baseName}_${sheetIndex}`;
          sheet = workbook.addWorksheet(name.slice(0, 31));
          addHeader(sheet, headers);
        }
        const reportRow = sheet.addRow(reportDetailValues(
          { ...stored, row: parsePayload(stored.fieldsJson) },
          sourceType
        ));
        reportRow.height = 30;
        reportRow.getCell(9).alignment = { vertical: 'top', wrapText: true };
        reportRow.commit();
        dataRows += 1;
        writtenRows += 1;
      }
      if (sheet) sheet.commit();
    }
    if (writtenRows !== filteredCount) {
      throw reportError('异常报告明细行数与过滤行数不一致', [
        `过滤 ${filteredCount} 行，写出 ${writtenRows} 行`
      ]);
    }
    await workbook.commit();
    await fs.promises.rename(temporaryPath, outputPath);
    // 报告是本次生成的产物：发布后算一次 SHA-256 作为存档与后续导出的凭证。
    const hashed = await hashFileSha256Async(outputPath);
    const stat = await readIdentityStat(fs, outputPath, 'stat');
    const snapshot = sourceSnapshotFromStat(stat);
    if (!snapshot || hashed.sizeBytes !== snapshot.sizeBytes) {
      throw reportError('异常报告发布后大小不一致');
    }
    return {
      reportKey,
      artifactKey: normalizedArtifactKey,
      sourceOperation: REPORT_SOURCE_OPERATION,
      filePath: outputPath,
      fileName: normalizedFileName,
      sha256: hashed.sha256,
      sizeBytes: hashed.sizeBytes,
      sourceSnapshot: snapshot,
      filteredRowCount: filteredCount,
      sourceFileIndexes: fileIndexes,
      role: 'output',
      displayRole: text(displayRole) || '异常数据'
    };
  } catch (error) {
    try { await fs.promises.rm(temporaryPath, { force: true }); } catch (_cleanupError) {}
    try { await fs.promises.rm(outputPath, { force: true }); } catch (_cleanupError) {}
    if (error instanceof PositionReconciliationError) throw error;
    throw reportError(
      '生成平盘来源异常报告失败',
      [text(error && error.message ? error.message : error)]
    );
  }
}

module.exports = {
  COLUMN_WIDTHS,
  DETAIL_META_HEADERS,
  EXCEL_MAX_ROWS,
  FILTERED_PAYLOAD_TABLE,
  REPORT_ARTIFACT_KEY,
  REPORT_SOURCE_OPERATION,
  SUMMARY_SHEET_NAME,
  TEXT_HEADER_PATTERN,
  createFilteredPayloadTable,
  detailHeadersFor,
  excelValueForHeader,
  reportDetailValues,
  writePositionAnomalyReport
};
