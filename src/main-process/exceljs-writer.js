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
const { applyWatermark } = require('./workbook-watermark');

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

// v2.1.7 round 3 F8 (spec §9.8.4)：stripInternalFields helper
//   过滤 _ 前缀字段（如 _rowId / _hitScenarioId / _modifiedColumns），返回干净对象
//   未命中场景行 sheet 不应暴露内部诊断字段（用户期望"原始银行对账单行所有列"）
//   注：写 sheet 用 headers 投影，本 helper 主要给未来需要 JSON 输出场景用
function stripInternalFields(row) {
  const cleaned = {};
  for (const k of Object.keys(row)) {
    if (!k.startsWith('_')) cleaned[k] = row[k];
  }
  return cleaned;
}

// rows: Array<{ ...原列, _rowId, _modifiedColumns: Set<columnName>, _hitScenarioName }>
// headers: Array<string>（44 列原表头）
// savePath: 绝对路径（含 .xlsx）
// unmatchedRows: Array<{...原列}> | null（v2.1.7 F8 round 3 可选；spec §9.8.4 第 2 sheet "未命中场景行"）
async function writeBankStatementOutput(rows, headers, savePath, unmatchedRows = null) {
  const workbook = new ExcelJS.Workbook();
  // sheet 名沿用样例文件 / PRD §7.5 约定：'渠道对账单'
  const sheet = workbook.addWorksheet('渠道对账单');

  const sheetData = buildSheetData(rows, headers);
  sheetData.forEach((rowValues) => sheet.addRow(rowValues));

  // 表头加粗 + 字号 10（v2.0.0 GA：所有导出表头统一 size 10）
  const headerRow = sheet.getRow(1);
  headerRow.font = { bold: true, size: 10 };

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

  // v2.1.7 round 3 F8 (spec §9.8.4)：可选第 2 sheet "未命中场景行"
  //   - 仅当 caller 显式传 unmatchedRows（Array）时输出（向下兼容旧 caller 不传 → 单 sheet 不变）
  //   - 即使 0 行也输出含表头 sheet（与 v2.1.6 acquiring-bill-currency 差异表"0 差异行仍输出"一致）
  //   - 用 headers 投影（与第 1 sheet 同 44 列），自动过滤内部 _ 前缀字段
  //   - 不标黄（未命中行无 _modifiedColumns 数据）
  if (Array.isArray(unmatchedRows)) {
    const unmatchedSheet = workbook.addWorksheet('未命中场景行');
    const unmatchedSheetData = buildSheetData(unmatchedRows, headers);
    unmatchedSheetData.forEach((rowValues) => unmatchedSheet.addRow(rowValues));
    const unmatchedHeaderRow = unmatchedSheet.getRow(1);
    unmatchedHeaderRow.font = { bold: true, size: 10 };
  }

  applyWatermark(workbook);
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
  // 表头加粗 + 字号 10（v2.0.0 GA：所有导出表头统一 size 10）
  sheet.getRow(1).font = { bold: true, size: 10 };

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

  applyWatermark(workbook);
  await workbook.xlsx.writeFile(savePath);
  return { filePath: savePath };
}

module.exports = {
  writeBankStatementOutput,
  writeErrorReport,
  stripInternalFields,     // v2.1.7 round 3 F8 (spec §9.8.4)
  YELLOW_FILL,
  INTERNAL_FIELDS
};
