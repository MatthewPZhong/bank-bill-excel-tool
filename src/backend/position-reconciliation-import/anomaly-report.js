'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const ExcelJS = require('exceljs');

const {
  SOURCE_DEFINITIONS,
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

const EXCEL_MAX_ROWS = 1048576;
const REPORT_ARTIFACT_KEY = 'source-import-anomaly-report';
const REPORT_SOURCE_OPERATION = 'source-import-anomaly-report';
const SUMMARY_SHEET_NAME = '异常汇总';
const DETAIL_META_HEADERS = Object.freeze([
  '过滤记录标识', '源文件', 'Sheet', 'Excel行号', '来源类型',
  '业务单号', 'ReconID', '错误码', '异常原因', '业务日期', '月份'
]);
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

function reportDetailValues(item, sourceType) {
  const definition = SOURCE_DEFINITIONS[sourceType];
  const headers = [...DETAIL_META_HEADERS, ...definition.headers];
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
    ...definition.headers.map((header) => item.row[header] ?? '')
  ];
  return values.map((value, index) => excelValueForHeader(headers[index], value));
}

function detailSheetBaseName(sourceType) {
  if (sourceType === SOURCE_TYPES.FUND_TRANSFER) return '调拨异常明细';
  if (sourceType === SOURCE_TYPES.TEST_PAYMENT) return '测试付款异常明细';
  throw reportError(`不支持生成异常明细的来源：${sourceType}`);
}

async function writePositionAnomalyReport({ ledger, jobRoot, jobId }) {
  const filteredCount = Number(ledger.db.prepare(`
    SELECT COUNT(*) AS count FROM filtered_source_rows WHERE is_owner = 1
  `).get().count);
  if (filteredCount === 0) return null;

  const reportDir = path.join(path.resolve(jobRoot), 'anomaly-report');
  await fs.promises.mkdir(reportDir, { recursive: true, mode: 0o700 });
  const fileName = `平盘来源异常数据_${String(jobId)}.xlsx`;
  const outputPath = path.join(reportDir, fileName);
  const temporaryPath = `${outputPath}.${crypto.randomUUID()}.tmp`;
  const reportKey = `${String(jobId)}:${REPORT_ARTIFACT_KEY}`;
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
    for (const file of ledger.listFiles().filter((item) => (
      item.preflightStatus === 'accepted' && Number(item.filteredRows) > 0
    ))) {
      const reportRow = summary.addRow([
        file.originalName,
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

    for (const sourceType of [SOURCE_TYPES.FUND_TRANSFER, SOURCE_TYPES.TEST_PAYMENT]) {
      const definition = SOURCE_DEFINITIONS[sourceType];
      const headers = [...DETAIL_META_HEADERS, ...definition.headers];
      let sheet = null;
      let sheetIndex = 0;
      let dataRows = 0;
      for (const item of ledger.iterateFilteredRows({ sourceTypes: [sourceType] })) {
        if (!sheet || dataRows >= EXCEL_MAX_ROWS - 1) {
          if (sheet) sheet.commit();
          sheetIndex += 1;
          dataRows = 0;
          const baseName = detailSheetBaseName(sourceType);
          const name = sheetIndex === 1 ? baseName : `${baseName}_${sheetIndex}`;
          sheet = workbook.addWorksheet(name.slice(0, 31));
          addHeader(sheet, headers);
        }
        const reportRow = sheet.addRow(reportDetailValues(item, sourceType));
        reportRow.height = 30;
        reportRow.getCell(9).alignment = { vertical: 'top', wrapText: true };
        reportRow.commit();
        dataRows += 1;
      }
      if (sheet) sheet.commit();
    }
    await workbook.commit();
    await fs.promises.rename(temporaryPath, outputPath);
    const first = await hashFileSha256Async(outputPath);
    const stat = await fs.promises.stat(outputPath);
    const snapshot = sourceSnapshotFromStat(stat);
    const second = await hashFileSha256Async(outputPath);
    if (!snapshot
        || first.sha256 !== second.sha256
        || first.sizeBytes !== second.sizeBytes
        || first.sizeBytes !== snapshot.sizeBytes) {
      throw reportError('异常报告发布后哈希或大小不一致');
    }
    return {
      reportKey,
      artifactKey: REPORT_ARTIFACT_KEY,
      sourceOperation: REPORT_SOURCE_OPERATION,
      filePath: outputPath,
      fileName,
      sha256: first.sha256,
      sizeBytes: first.sizeBytes,
      sourceSnapshot: snapshot,
      filteredRowCount: filteredCount,
      role: 'output',
      displayRole: '异常数据'
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
  REPORT_ARTIFACT_KEY,
  REPORT_SOURCE_OPERATION,
  SUMMARY_SHEET_NAME,
  TEXT_HEADER_PATTERN,
  excelValueForHeader,
  reportDetailValues,
  writePositionAnomalyReport
};
