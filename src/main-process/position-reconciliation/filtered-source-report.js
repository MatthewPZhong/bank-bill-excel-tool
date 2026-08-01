'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const ExcelJS = require('exceljs');

const {
  SOURCE_DEFINITIONS,
  SOURCE_TYPES
} = require('./constants');
const {
  PositionReconciliationError,
  text
} = require('./common');
const {
  hashFileSha256Async
} = require('./input-staging');
const {
  openPositionWorkbook,
  valuesFromToolboxRow
} = require('../../backend/position-reconciliation-import/xlsx-reader');
const {
  scanXlsxSheet
} = require('../../backend/toolbox-format/xlsx-sheet-scanner');
const {
  COLUMN_WIDTHS,
  DETAIL_META_HEADERS,
  TEXT_HEADER_PATTERN,
  excelValueForHeader
} = require('../../backend/position-reconciliation-import/anomaly-report');

const RUN_REPORT_COLUMN_WIDTHS = Object.freeze({
  RunID: 14,
  Channel: 20,
  来源Revision: 18,
  过滤行数: 14,
  报告文件: 44,
  '报告SHA-256': 66
});

function integrityError(message, detailLines = []) {
  return new PositionReconciliationError(
    'position-anomaly-report-integrity-invalid',
    message,
    detailLines
  );
}

function normalizeReportReference(value = {}) {
  const filePath = text(value.filePath || value.reportFilePath);
  const sha256 = text(value.sha256 || value.reportSha256).toLowerCase();
  const sizeBytes = Number(value.sizeBytes ?? value.reportSizeBytes);
  if (!filePath
      || !/^[a-f0-9]{64}$/.test(sha256)
      || !Number.isSafeInteger(sizeBytes)
      || sizeBytes < 0) {
    throw integrityError('异常报告引用缺少路径、SHA-256 或文件大小');
  }
  return { ...value, filePath: path.resolve(filePath), sha256, sizeBytes };
}

async function verifyAnomalyReportFile(reference) {
  const normalized = normalizeReportReference(reference);
  let stat;
  try {
    stat = await fs.promises.stat(normalized.filePath);
  } catch (error) {
    throw integrityError('异常报告不存在，审计链不完整', [
      error && error.message ? error.message : String(error)
    ]);
  }
  if (!stat.isFile() || Number(stat.size) !== normalized.sizeBytes) {
    throw integrityError('异常报告文件大小不一致，审计链不完整');
  }
  const actual = await hashFileSha256Async(normalized.filePath);
  if (actual.sha256 !== normalized.sha256 || actual.sizeBytes !== normalized.sizeBytes) {
    throw integrityError('异常报告 SHA-256 校验失败，审计链不完整');
  }
  return normalized;
}

async function copyVerifiedAnomalyReport(reference, outputPath) {
  const verified = await verifyAnomalyReportFile(reference);
  const resolvedOutput = path.resolve(String(outputPath || ''));
  if (path.extname(resolvedOutput).toLowerCase() !== '.xlsx') {
    throw new PositionReconciliationError(
      'position-output-path-invalid',
      '异常数据导出路径必须为 .xlsx 文件'
    );
  }
  await fs.promises.mkdir(path.dirname(resolvedOutput), { recursive: true });
  const temporaryPath = `${resolvedOutput}.${crypto.randomUUID()}.tmp`;
  try {
    await fs.promises.copyFile(verified.filePath, temporaryPath);
    const copied = await hashFileSha256Async(temporaryPath);
    if (copied.sha256 !== verified.sha256 || copied.sizeBytes !== verified.sizeBytes) {
      throw integrityError('异常报告复制后内容校验失败');
    }
    await fs.promises.rename(temporaryPath, resolvedOutput);
    return {
      status: 'ok',
      filePath: resolvedOutput,
      sha256: copied.sha256,
      sizeBytes: copied.sizeBytes
    };
  } catch (error) {
    try { await fs.promises.rm(temporaryPath, { force: true }); } catch (_cleanupError) {}
    throw error;
  }
}

function styleHeader(row) {
  row.font = { bold: true, color: { argb: 'FF1F2937' } };
  row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8EEF8' } };
  row.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
  row.height = 30;
}

function initializeSheet(workbook, name, headers) {
  const sheet = workbook.addWorksheet(name.slice(0, 31));
  sheet.columns = headers.map((header) => {
    const normalized = String(header);
    const isReason = normalized === '异常原因' || normalized === '原因统计';
    const isText = TEXT_HEADER_PATTERN.test(normalized);
    return {
      width: RUN_REPORT_COLUMN_WIDTHS[normalized]
        || COLUMN_WIDTHS[normalized]
        || Math.min(36, Math.max(isText ? 30 : 14, normalized.length * 2 + 4)),
      style: {
        ...(isText ? { numFmt: '@' } : {}),
        ...(isReason ? { alignment: { vertical: 'top', wrapText: true } } : {})
      }
    };
  });
  const header = sheet.addRow(headers);
  styleHeader(header);
  header.commit();
  sheet.autoFilter = {
    from: { row: 1, column: 1 },
    to: { row: 1, column: headers.length }
  };
  return sheet;
}

function cellValue(value) {
  if (value && typeof value === 'object' && Object.hasOwn(value, 'result')) {
    return value.result ?? '';
  }
  if (value && typeof value === 'object' && Array.isArray(value.richText)) {
    return value.richText.map((part) => part.text || '').join('');
  }
  return value ?? '';
}

function projectValuesByHeaderOccurrence(headers, values, expectedHeaders) {
  const indexes = new Map();
  headers.forEach((header, index) => {
    const normalized = text(header);
    const positions = indexes.get(normalized) || [];
    positions.push(index);
    indexes.set(normalized, positions);
  });
  const occurrences = new Map();
  return expectedHeaders.map((header) => {
    const normalized = text(header);
    const occurrence = Number(occurrences.get(normalized) || 0);
    occurrences.set(normalized, occurrence + 1);
    const index = (indexes.get(normalized) || [])[occurrence];
    return Number.isSafeInteger(index) ? values[index] ?? '' : '';
  });
}

async function streamAnomalyDetailRows(filePath, onRow) {
  let workbook = null;
  try {
    workbook = await openPositionWorkbook(filePath);
    for (const sheet of workbook.sheets) {
      let headers = null;
      let detailSheet = false;
      await scanXlsxSheet({
        zip: workbook.zip,
        sheetEntry: workbook.entries.get(sheet.entryPath),
        sheet,
        sourceFile: workbook.filePath,
        sourceRegistry: workbook.sourceRegistry,
        date1904: workbook.date1904,
        sharedStrings: workbook.sharedStrings,
        themeColors: workbook.themeColors,
        onRow: (row) => {
          const width = headers
            ? headers.length
            : row.cells.reduce(
              (maximum, cell) => Math.max(maximum, Number(cell.columnIndex) + 1),
              0
            );
          const values = valuesFromToolboxRow(row, width).map(cellValue);
          if (row.rowIndex === 1) {
            headers = values.map(text);
            detailSheet = DETAIL_META_HEADERS.every((header) => headers.includes(header));
            return;
          }
          if (!headers || !detailSheet) return;
          if (values.every((value) => text(value) === '')) return;
          const callbackResult = onRow({ headers, values });
          if (callbackResult && typeof callbackResult.then === 'function') {
            throw new TypeError('异常报告行回调必须是同步函数');
          }
        }
      });
    }
  } catch (error) {
    if (error instanceof PositionReconciliationError
        && error.code === 'position-anomaly-report-integrity-invalid') {
      throw error;
    }
    throw integrityError('异常报告明细无法安全读取，审计链不完整', [
      error && error.message ? error.message : String(error)
    ]);
  } finally {
    if (workbook) await workbook.close();
  }
}

async function writeRunFilteredSourcesWorkbook({
  outputPath,
  run,
  filteredSources,
  reportFiles
}) {
  const requested = new Map((Array.isArray(filteredSources) ? filteredSources : []).map(
    (item) => [text(item.reportRowKey), item]
  ));
  if (requested.size === 0) {
    throw new PositionReconciliationError(
      'position-run-filtered-empty',
      '本次运行没有过滤数据'
    );
  }
  const resolvedOutput = path.resolve(String(outputPath || ''));
  if (path.extname(resolvedOutput).toLowerCase() !== '.xlsx') {
    throw new PositionReconciliationError(
      'position-output-path-invalid',
      '过滤数据导出路径必须为 .xlsx 文件'
    );
  }
  await fs.promises.mkdir(path.dirname(resolvedOutput), { recursive: true });
  const temporaryPath = `${resolvedOutput}.${crypto.randomUUID()}.tmp`;
  const found = new Set();
  try {
    const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({
      filename: temporaryPath,
      useStyles: true,
      useSharedStrings: false
    });
    const summaryHeaders = [
      'RunID', 'Channel', '月份', '来源类型', '来源Revision',
      '过滤行数', '报告文件', '报告SHA-256'
    ];
    const summarySheet = initializeSheet(workbook, '运行与过滤汇总', summaryHeaders);
    const scope = run && run.scope ? run.scope : {};
    const groups = new Map();
    for (const item of requested.values()) {
      const key = `${item.sourceType}\u0000${item.sourceRevision}\u0000${item.reportKey}`;
      const group = groups.get(key) || { item, count: 0 };
      group.count += 1;
      groups.set(key, group);
    }
    for (const { item, count } of groups.values()) {
      const values = [
        Number(run.id),
        (scope.channels || []).join(' / '),
        (scope.months || []).join(' / '),
        item.sourceType,
        Number(item.sourceRevision),
        count,
        item.reportFileName,
        item.reportSha256
      ];
      const reportRow = summarySheet.addRow(values.map(
        (value, index) => excelValueForHeader(summaryHeaders[index], value)
      ));
      reportRow.height = 30;
      reportRow.commit();
    }
    summarySheet.commit();

    const detailSheets = new Map();
    const detailHeaders = new Map([
      [SOURCE_TYPES.FUND_TRANSFER, [
        ...DETAIL_META_HEADERS,
        ...SOURCE_DEFINITIONS[SOURCE_TYPES.FUND_TRANSFER].headers
      ]],
      [SOURCE_TYPES.TEST_PAYMENT, [
        ...DETAIL_META_HEADERS,
        ...SOURCE_DEFINITIONS[SOURCE_TYPES.TEST_PAYMENT].headers
      ]]
    ]);
    for (const sourceType of [SOURCE_TYPES.FUND_TRANSFER, SOURCE_TYPES.TEST_PAYMENT]) {
      if (![...requested.values()].some((item) => item.sourceType === sourceType)) continue;
      detailSheets.set(sourceType, initializeSheet(
        workbook,
        sourceType === SOURCE_TYPES.FUND_TRANSFER
          ? '调拨过滤数据'
          : '测试付款过滤数据',
        detailHeaders.get(sourceType)
      ));
    }

    for (const report of Array.isArray(reportFiles) ? reportFiles : []) {
      const verified = await verifyAnomalyReportFile(report);
      await streamAnomalyDetailRows(verified.filePath, ({ headers, values }) => {
        const reportRowKeyIndex = headers.indexOf('过滤记录标识');
        const sourceTypeIndex = headers.indexOf('来源类型');
        const reportRowKey = text(values[reportRowKeyIndex]);
        const target = requested.get(reportRowKey);
        if (!target || found.has(reportRowKey)) return;
        if (text(values[sourceTypeIndex]) !== text(target.sourceType)) {
          throw integrityError(`过滤记录来源类型与运行快照不一致：${reportRowKey}`);
        }
        const expectedHeaders = detailHeaders.get(target.sourceType);
        const sheet = detailSheets.get(target.sourceType);
        if (!sheet || !expectedHeaders) {
          throw integrityError(`过滤记录来源类型无法导出：${target.sourceType}`);
        }
        const projected = projectValuesByHeaderOccurrence(
          headers,
          values,
          expectedHeaders
        );
        const reportRow = sheet.addRow(expectedHeaders.map(
          (header, index) => excelValueForHeader(header, projected[index])
        ));
        reportRow.height = 30;
        reportRow.getCell(9).alignment = { vertical: 'top', wrapText: true };
        reportRow.commit();
        found.add(reportRowKey);
      });
    }
    const missing = [...requested.keys()].filter((key) => !found.has(key));
    if (missing.length > 0) {
      throw integrityError(
        '运行冻结的过滤记录在异常报告中缺失',
        missing.slice(0, 20)
      );
    }
    for (const sheet of detailSheets.values()) sheet.commit();
    await workbook.commit();
    await fs.promises.rename(temporaryPath, resolvedOutput);
    return {
      status: 'ok',
      filePath: resolvedOutput,
      runId: Number(run.id),
      rowCount: requested.size,
      fileName: path.basename(resolvedOutput)
    };
  } catch (error) {
    try { await fs.promises.rm(temporaryPath, { force: true }); } catch (_cleanupError) {}
    throw error;
  }
}

module.exports = {
  copyVerifiedAnomalyReport,
  normalizeReportReference,
  projectValuesByHeaderOccurrence,
  streamAnomalyDetailRows,
  verifyAnomalyReportFile,
  writeRunFilteredSourcesWorkbook
};
