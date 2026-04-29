// v2.0.0-beta.3 PR #32a：exceljs 标黄输出 + error-report 写出
// v2.0.0-beta.4：error-report 加「可能原因」列（5 列），文案来自 file-service/error-causes.js
//
// 仅本模块（bank-statement-process）使用 exceljs；
// 其他 3 模块（statementGenerator / newAccountGenerator / pendingReconciliation）继续 SheetJS。
//
// 核心能力：
//   - writeBankStatementOutput：仅修改行 + 单元格黄底 + 表头
//   - writeErrorReport：5 列（时间戳 / 场景名 / 行号 / 原因 / 可能原因）
//
// 标黄约定：
//   cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFFF00' } }

const ExcelJS = require('exceljs');
const { errorCodeToCause } = require('../backend/file-service/error-causes');

const YELLOW_FILL = {
  type: 'pattern',
  pattern: 'solid',
  fgColor: { argb: 'FFFFFF00' }
};

// 内部字段（不写入 xlsx）
const INTERNAL_FIELDS = new Set([
  '_rowId',
  '_modifiedColumns',
  '_hitScenarioId',
  '_hitScenarioName'
]);

function buildSheetData(rows, headers) {
  const dataRows = rows.map((row) => headers.map((h) => row[h]));
  return [headers, ...dataRows];
}

// rows: Array<{ ...原列, _rowId, _modifiedColumns: Set<columnName>, _hitScenarioName }>
// headers: Array<string>（44 列原表头）
// savePath: 绝对路径（含 .xlsx）
async function writeBankStatementOutput(rows, headers, savePath) {
  const workbook = new ExcelJS.Workbook();
  // sheet 名沿用样例文件 / PRD §7.5 约定：'渠道对账单'
  const sheet = workbook.addWorksheet('渠道对账单');

  const sheetData = buildSheetData(rows, headers);
  sheetData.forEach((rowValues) => sheet.addRow(rowValues));

  // 表头加粗
  const headerRow = sheet.getRow(1);
  headerRow.font = { bold: true };

  // 标黄：rows 中每行的 _modifiedColumns 对应的单元格
  rows.forEach((row, rowIdx) => {
    const modifiedColumns = row._modifiedColumns;
    if (!modifiedColumns || modifiedColumns.size === 0) return;
    headers.forEach((header, colIdx) => {
      if (!modifiedColumns.has(header)) return;
      // sheet 行号从 1 起，第 1 行是表头，数据从第 2 行起
      const cell = sheet.getCell(rowIdx + 2, colIdx + 1);
      cell.fill = YELLOW_FILL;
    });
  });

  await workbook.xlsx.writeFile(savePath);
  return { filePath: savePath };
}

// warnings: Array<{ scenarioId, scenarioName, rowId, code, message }>
// savePath: 绝对路径（含 .xlsx）
async function writeErrorReport(warnings, savePath) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('error-report');

  const headers = ['时间戳', '场景名', '行号', '原因', '可能原因'];
  sheet.addRow(headers);
  sheet.getRow(1).font = { bold: true };

  const timestamp = new Date().toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
  warnings.forEach((w) => {
    sheet.addRow([
      timestamp,
      w.scenarioName ?? `场景 #${w.scenarioId}`,
      w.rowId ?? '',
      w.message ?? w.code ?? '',
      errorCodeToCause(w.code)
    ]);
  });

  await workbook.xlsx.writeFile(savePath);
  return { filePath: savePath };
}

module.exports = {
  writeBankStatementOutput,
  writeErrorReport,
  YELLOW_FILL,
  INTERNAL_FIELDS
};
