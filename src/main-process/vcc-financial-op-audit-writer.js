'use strict';

const path = require('node:path');
const ExcelJS = require('exceljs');
const repository = require('../backend/vcc-financial-op-db/repository');
const { writeXlsxAtomically } = require('./vcc-financial-op-output-publication');

const MAX_DATA_ROWS_PER_SHEET = 1048575;
const ANOMALY_HEADERS = Object.freeze([
  '幂等键', '文件名', '原表行号', '分类', '异常字段', '说明'
]);
const ANOMALY_CATEGORY_TEXT = Object.freeze({
  invalid_key: '空键/非法键',
  format_error: '格式错误',
  idempotent_conflict: '幂等冲突',
  system_subject_error: '系统主体异常',
  file_failure: '文件级失败'
});

function parseStringArray(value) {
  if (Array.isArray(value)) return value.map((item) => String(item || '').trim()).filter(Boolean);
  try {
    const parsed = JSON.parse(value || '[]');
    return Array.isArray(parsed)
      ? parsed.map((item) => String(item || '').trim()).filter(Boolean)
      : [];
  } catch (_error) {
    return [];
  }
}

function styleHeader(row) {
  row.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2F5EA8' } };
  row.alignment = { vertical: 'middle', horizontal: 'center' };
}

function anomalyValues(row) {
  const fields = [
    ...parseStringArray(row.abnormal_fields_json),
    ...parseStringArray(row.diff_fields_json)
  ];
  return [
    row.idempotency_key || '',
    row.source_file_name || '',
    row.source_row == null ? '' : Number(row.source_row),
    ANOMALY_CATEGORY_TEXT[row.category] || row.category,
    [...new Set(fields)].join('、'),
    row.description || ''
  ];
}

function createSheet(workbook, index) {
  const suffix = index > 1 ? `-${index}` : '';
  const sheet = workbook.addWorksheet(`异常明细${suffix}`.slice(0, 31), {
    views: [{ state: 'frozen', ySplit: 1 }]
  });
  sheet.columns = [
    { width: 34 }, { width: 32 }, { width: 14 },
    { width: 18 }, { width: 28 }, { width: 60 }
  ];
  const header = sheet.addRow(ANOMALY_HEADERS);
  styleHeader(header);
  header.commit();
  return sheet;
}

async function writeImportAuditWorkbook({
  db,
  recordId,
  outputPath,
  maxDataRowsPerSheet = MAX_DATA_ROWS_PER_SHEET
}) {
  const record = repository.getImportRecord(db, Number(recordId));
  if (!record) throw new Error(`导入记录不存在：${recordId}`);
  const anomalyCount = repository.countExportableImportAnomalies(db, record.id);
  if (anomalyCount < 1) {
    const error = new Error('当前导入记录没有可导出的异常明细');
    error.code = 'no-import-anomalies';
    throw error;
  }
  const sheetLimit = Number(maxDataRowsPerSheet);
  if (!Number.isInteger(sheetLimit) || sheetLimit < 1 || sheetLimit > MAX_DATA_ROWS_PER_SHEET) {
    throw new RangeError(`单 sheet 数据行上限必须为 1-${MAX_DATA_ROWS_PER_SHEET}`);
  }

  let rowCount = 0;
  let sheetCount = 1;
  await writeXlsxAtomically({
    outputPath,
    writeStaged: async (stagedPath) => {
      const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({
        filename: stagedPath,
        useStyles: true,
        useSharedStrings: false
      });
      let sheet = createSheet(workbook, sheetCount);
      let rowsInSheet = 0;
      for (const row of repository.iterateExportableImportAnomalies(db, record.id)) {
        if (rowsInSheet >= sheetLimit) {
          sheet.commit();
          sheetCount += 1;
          rowsInSheet = 0;
          sheet = createSheet(workbook, sheetCount);
        }
        sheet.addRow(anomalyValues(row)).commit();
        rowsInSheet += 1;
        rowCount += 1;
      }
      sheet.commit();
      if (rowCount !== anomalyCount) {
        throw new Error('异常明细数与导入记录统计不一致，未生成文件');
      }
      await workbook.commit();
    }
  });
  return {
    filePath: path.resolve(outputPath),
    recordId: record.id,
    rowCount,
    sheetCount
  };
}

module.exports = {
  MAX_DATA_ROWS_PER_SHEET,
  ANOMALY_HEADERS,
  ANOMALY_CATEGORY_TEXT,
  anomalyValues,
  writeImportAuditWorkbook
};
