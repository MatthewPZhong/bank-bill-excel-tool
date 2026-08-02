'use strict';

const fs = require('node:fs');
const path = require('node:path');
const ExcelJS = require('exceljs');
const {
  SOURCE_TYPES,
  SUPPORTED_CURRENCIES
} = require('../backend/vcc-financial-op/definitions');
const { canonicalizeVccAmount } = require('../backend/vcc-financial-op/amount-rules');
const { writeXlsxAtomically } = require('./vcc-financial-op-output-publication');

const RESULT_SHEET_NAME = '财务OP校验结果表';
const PENDING_SHEET_NAME = '移除归档Pending发生额计算表';
const AMOUNT_NUM_FORMAT = '#,##0.00;[Red]-#,##0.00;-';

function cloneStyle(style) {
  return style ? JSON.parse(JSON.stringify(style)) : {};
}

function applyCellStyle(sourceCell, targetCell) {
  targetCell.style = cloneStyle(sourceCell.style);
  if (sourceCell.numFmt) targetCell.numFmt = sourceCell.numFmt;
}

function copyColumnLayout(sourceSheet, targetSheet, sourceStart, columnCount) {
  for (let index = 0; index < columnCount; index++) {
    const source = sourceSheet.getColumn(sourceStart + index);
    const target = targetSheet.getColumn(index + 1);
    if (source.width != null) target.width = source.width;
    if (source.hidden != null) target.hidden = source.hidden;
  }
}

function styleRowFromTemplate(sourceSheet, sourceRowNumber, targetSheet, targetRowNumber, sourceStart, columnCount) {
  const sourceRow = sourceSheet.getRow(sourceRowNumber);
  const targetRow = targetSheet.getRow(targetRowNumber);
  if (sourceRow.height != null) targetRow.height = sourceRow.height;
  for (let index = 0; index < columnCount; index++) {
    applyCellStyle(
      sourceSheet.getCell(sourceRowNumber, sourceStart + index),
      targetSheet.getCell(targetRowNumber, index + 1)
    );
  }
}

function decimalToExcelNumber(value, label) {
  const canonical = canonicalizeVccAmount(value, label);
  const number = Number(canonical);
  if (!Number.isFinite(number)) throw new Error(`${label}无法写入 Excel：${value}`);
  return number;
}

function sanitizeFilePart(value) {
  const normalized = String(value == null ? '' : value).trim().replace(/[\\/:*?"<>|]/g, '_');
  return normalized || '未命名主体';
}

function loadRunData(db, runId) {
  const run = db.prepare('SELECT * FROM vcc_fin_op_runs WHERE id = ?').get(runId);
  if (!run) throw new Error(`财务OP校验结果不存在：${runId}`);
  const balances = db.prepare(`
    SELECT * FROM vcc_fin_op_run_balances
    WHERE run_id = ? ORDER BY subject, currency
  `).all(runId);
  const movements = db.prepare(`
    SELECT * FROM vcc_fin_op_run_rows
    WHERE run_id = ? ORDER BY subject, source_type, category_major, category_minor, currency
  `).all(runId);
  const pendingSummary = db.prepare(`
    SELECT * FROM vcc_fin_op_pending_summary_rows
    WHERE run_id = ?
    ORDER BY subject, channel_name, currency_mismatch, flow_currency, pending_currency, recon_type
  `).all(runId);
  const pendingTotals = db.prepare(`
    SELECT * FROM vcc_fin_op_pending_currency_totals
    WHERE run_id = ? ORDER BY subject, currency
  `).all(runId);
  const subjects = [...new Set(balances.map((row) => row.subject))].sort();
  if (subjects.length === 0) throw new Error('财务OP校验结果没有主体数据');
  return { run, balances, movements, pendingSummary, pendingTotals, subjects };
}

function pivotMovementRows(rows) {
  const groups = new Map();
  for (const row of rows) {
    const key = JSON.stringify([
      row.source_type,
      row.category_major || '',
      row.category_minor || ''
    ]);
    if (!groups.has(key)) {
      groups.set(key, {
        sourceType: row.source_type,
        categoryMajor: row.category_major || '',
        categoryMinor: row.category_minor || '',
        amounts: Object.fromEntries(SUPPORTED_CURRENCIES.map((currency) => [currency, '0']))
      });
    }
    groups.get(key).amounts[row.currency] = row.amount;
  }
  return [...groups.values()];
}

function balanceMap(rows, field) {
  return Object.fromEntries(rows.map((row) => [row.currency, row[field]]));
}

function pendingTotalMap(rows) {
  const totals = Object.fromEntries(SUPPORTED_CURRENCIES.map((currency) => [currency, '0']));
  for (const row of rows) totals[row.currency] = row.amount;
  return totals;
}

function sourceTemplateRow(sourceType) {
  if (sourceType === SOURCE_TYPES.RECHARGE) return 3;
  if (sourceType === SOURCE_TYPES.FEE_FX) return 7;
  if (sourceType === SOURCE_TYPES.CHANNEL) return 29;
  return 37;
}

function setAmountCells(sheet, rowNumber, amounts, startColumn = 4) {
  for (let index = 0; index < SUPPORTED_CURRENCIES.length; index++) {
    const currency = SUPPORTED_CURRENCIES[index];
    const cell = sheet.getCell(rowNumber, startColumn + index);
    cell.value = decimalToExcelNumber(amounts[currency] || '0', `${currency} 金额`);
    cell.numFmt = AMOUNT_NUM_FORMAT;
  }
}

function formattedAmountLength(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  return value.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }).length;
}

function setReadableAmountColumnWidths(sheet, columnNumbers, minWidth = 13) {
  for (const columnNumber of columnNumbers) {
    let width = minWidth;
    sheet.getColumn(columnNumber).eachCell({ includeEmpty: false }, (cell) => {
      width = Math.max(width, Math.min(24, formattedAmountLength(cell.value) + 2));
    });
    sheet.getColumn(columnNumber).width = width;
  }
}

function configurePrintLayout(sheet, lastCell) {
  sheet.pageSetup = {
    orientation: 'landscape',
    paperSize: 9,
    fitToPage: true,
    fitToWidth: 1,
    fitToHeight: 0,
    horizontalCentered: true,
    printArea: `A1:${lastCell}`,
    margins: {
      left: 0.25,
      right: 0.25,
      top: 0.5,
      bottom: 0.5,
      header: 0.2,
      footer: 0.2
    }
  };
}

function addResultRow({ targetSheet, templateSheet, rowNumber, templateRow, subject, major, minor, amounts, mergeLabel }) {
  styleRowFromTemplate(templateSheet, templateRow, targetSheet, rowNumber, 2, 12);
  targetSheet.getCell(rowNumber, 1).value = subject || '';
  targetSheet.getCell(rowNumber, 2).value = major || '';
  targetSheet.getCell(rowNumber, 3).value = minor || '';
  if (mergeLabel) targetSheet.mergeCells(rowNumber, 2, rowNumber, 3);
  setAmountCells(targetSheet, rowNumber, amounts);
}

function buildResultSheet(workbook, templateSheet, subject, data) {
  const sheet = workbook.addWorksheet(RESULT_SHEET_NAME, {
    views: [{ state: 'frozen', ySplit: 1 }]
  });
  copyColumnLayout(templateSheet, sheet, 2, 12);
  styleRowFromTemplate(templateSheet, 1, sheet, 1, 2, 12);
  const headers = ['主体', '大类', '分类', ...SUPPORTED_CURRENCIES];
  headers.forEach((header, index) => { sheet.getCell(1, index + 1).value = header; });

  const subjectBalances = data.balances.filter((row) => row.subject === subject);
  const movements = pivotMovementRows(data.movements.filter((row) => row.subject === subject));
  const pendingTotals = pendingTotalMap(data.pendingTotals.filter((row) => row.subject === subject));
  let rowNumber = 2;

  addResultRow({
    targetSheet: sheet,
    templateSheet,
    rowNumber,
    templateRow: 2,
    subject,
    major: '上月财务OP',
    minor: '',
    amounts: balanceMap(subjectBalances, 'opening_balance'),
    mergeLabel: true
  });
  rowNumber += 1;

  for (const sourceType of [SOURCE_TYPES.RECHARGE, SOURCE_TYPES.FEE_FX, SOURCE_TYPES.CHANNEL]) {
    const sourceRows = movements.filter((row) => row.sourceType === sourceType);
    const groupStart = rowNumber;
    for (const movement of sourceRows) {
      addResultRow({
        targetSheet: sheet,
        templateSheet,
        rowNumber,
        templateRow: sourceTemplateRow(sourceType),
        subject,
        major: movement.categoryMajor,
        minor: movement.categoryMinor,
        amounts: movement.amounts,
        mergeLabel: sourceType === SOURCE_TYPES.FEE_FX && !movement.categoryMinor
      });
      rowNumber += 1;
    }
    if (rowNumber - groupStart > 1) sheet.mergeCells(groupStart, 1, rowNumber - 1, 1);
  }

  addResultRow({
    targetSheet: sheet,
    templateSheet,
    rowNumber,
    templateRow: 37,
    subject,
    major: '当月移除pending',
    amounts: pendingTotals,
    mergeLabel: true
  });
  rowNumber += 1;
  addResultRow({
    targetSheet: sheet,
    templateSheet,
    rowNumber,
    templateRow: 38,
    subject,
    major: '当月计算财务OP',
    amounts: balanceMap(subjectBalances, 'calculated_balance'),
    mergeLabel: true
  });
  rowNumber += 1;
  addResultRow({
    targetSheet: sheet,
    templateSheet,
    rowNumber,
    templateRow: 39,
    subject,
    major: '当月系统财务OP',
    amounts: balanceMap(subjectBalances, 'system_balance'),
    mergeLabel: true
  });
  rowNumber += 1;
  styleRowFromTemplate(templateSheet, 40, sheet, rowNumber, 2, 12);
  sheet.mergeCells(rowNumber, 1, rowNumber, 3);
  sheet.getCell(rowNumber, 1).value = '差异';
  setAmountCells(sheet, rowNumber, balanceMap(subjectBalances, 'difference'));
  sheet.getColumn(1).width = 16;
  sheet.getColumn(2).width = 22;
  sheet.getColumn(3).width = 24;
  setReadableAmountColumnWidths(sheet, SUPPORTED_CURRENCIES.map((_, index) => index + 4));
  sheet.autoFilter = { from: 'A1', to: 'L1' };
  configurePrintLayout(sheet, `L${rowNumber}`);
  return sheet;
}

function buildPendingSheet(workbook, templateSheet, subject, data) {
  const sheet = workbook.addWorksheet(PENDING_SHEET_NAME, {
    views: [{ state: 'frozen', ySplit: 1 }]
  });
  copyColumnLayout(templateSheet, sheet, 1, 11);
  styleRowFromTemplate(templateSheet, 1, sheet, 1, 1, 11);
  const headers = [
    'channel', '是否错币', '流水_币种', '币种', '备注',
    '求和项:流水_对账金额', '求和项:金额', '', '', '币种', '差额'
  ];
  headers.forEach((header, index) => { sheet.getCell(1, index + 1).value = header; });

  const summary = data.pendingSummary.filter((row) => row.subject === subject);
  const totals = data.pendingTotals.filter((row) => row.subject === subject);
  const maxRows = Math.max(summary.length, totals.length, 1);
  for (let index = 0; index < maxRows; index++) {
    const rowNumber = index + 2;
    styleRowFromTemplate(templateSheet, 2, sheet, rowNumber, 1, 11);
    const source = summary[index];
    if (source) {
      sheet.getCell(rowNumber, 1).value = source.channel_name || '';
      sheet.getCell(rowNumber, 2).value = Boolean(source.currency_mismatch);
      sheet.getCell(rowNumber, 3).value = source.flow_currency || '';
      sheet.getCell(rowNumber, 4).value = source.pending_currency || '';
      sheet.getCell(rowNumber, 5).value = source.recon_type || '';
      sheet.getCell(rowNumber, 6).value = decimalToExcelNumber(source.flow_amount, '流水金额汇总');
      sheet.getCell(rowNumber, 7).value = decimalToExcelNumber(source.pending_amount, 'Pending金额汇总');
      sheet.getCell(rowNumber, 6).numFmt = AMOUNT_NUM_FORMAT;
      sheet.getCell(rowNumber, 7).numFmt = AMOUNT_NUM_FORMAT;
    }
    const total = totals[index];
    if (total) {
      sheet.getCell(rowNumber, 10).value = total.currency;
      sheet.getCell(rowNumber, 11).value = decimalToExcelNumber(total.amount, `${total.currency} Pending差额`);
      sheet.getCell(rowNumber, 11).numFmt = AMOUNT_NUM_FORMAT;
    }
  }
  [16, 12, 12, 12, 28].forEach((width, index) => {
    sheet.getColumn(index + 1).width = width;
  });
  sheet.getColumn(8).width = 3;
  sheet.getColumn(9).width = 3;
  sheet.getColumn(10).width = 12;
  setReadableAmountColumnWidths(sheet, [6, 7, 11], 15);
  sheet.autoFilter = { from: 'A1', to: 'G1' };
  configurePrintLayout(sheet, `K${maxRows + 1}`);
  return sheet;
}

async function writeSubjectWorkbook({ data, subject, outputPath, resultTemplatePath, pendingTemplatePath }) {
  const resultTemplate = new ExcelJS.Workbook();
  const pendingTemplate = new ExcelJS.Workbook();
  await resultTemplate.xlsx.readFile(resultTemplatePath);
  await pendingTemplate.xlsx.readFile(pendingTemplatePath);

  const workbook = new ExcelJS.Workbook();
  workbook.creator = '网银账单生成小助手';
  workbook.created = new Date();
  buildResultSheet(workbook, resultTemplate.worksheets[0], subject, data);
  buildPendingSheet(workbook, pendingTemplate.worksheets[0], subject, data);
  return writeXlsxAtomically({
    outputPath,
    writeStaged: (stagedPath) => workbook.xlsx.writeFile(stagedPath),
    validateStaged: async (stagedPath) => {
      const validation = new ExcelJS.Workbook();
      await validation.xlsx.readFile(stagedPath);
      const sheetNames = validation.worksheets.map((sheet) => sheet.name);
      if (sheetNames.length !== 2
          || sheetNames[0] !== RESULT_SHEET_NAME
          || sheetNames[1] !== PENDING_SHEET_NAME) {
        throw new Error('VCC 财务OP导出文件结构校验失败');
      }
      if (validation.getWorksheet(RESULT_SHEET_NAME).getCell('A1').value !== '主体'
          || validation.getWorksheet(PENDING_SHEET_NAME).getCell('K1').value !== '差额') {
        throw new Error('VCC 财务OP导出文件表头校验失败');
      }
    }
  });
}

function nextAvailableOutputPath(outputDirectory, baseName, usedNames) {
  let fileName = `${baseName}.xlsx`;
  let suffix = 2;
  while (usedNames.has(fileName.toLocaleLowerCase('en-US'))
      || fs.existsSync(path.join(outputDirectory, fileName))) {
    fileName = `${baseName}_(${suffix}).xlsx`;
    suffix += 1;
  }
  usedNames.add(fileName.toLocaleLowerCase('en-US'));
  return path.join(outputDirectory, fileName);
}

async function writeRunWorkbooks({ db, runId, outputDirectory, outputPath, assetsDir }) {
  const data = loadRunData(db, Number(runId));
  const resultTemplatePath = path.join(assetsDir, 'VCC财务OP校验', '财务OP校验结果表.xlsx');
  const pendingTemplatePath = path.join(assetsDir, 'VCC财务OP校验', '移除归档Pending发生额计算表.xlsx');
  const paths = [];
  const usedNames = new Set();
  for (const subject of data.subjects) {
    let destination;
    if (data.subjects.length === 1 && outputPath) {
      destination = outputPath;
    } else {
      if (!outputDirectory) throw new Error('多主体导出必须指定保存目录');
      const baseName = `${data.run.target_month}_${sanitizeFilePart(subject)}_VCC财务OP校验结果表`;
      destination = nextAvailableOutputPath(outputDirectory, baseName, usedNames);
    }
    paths.push(await writeSubjectWorkbook({
      data,
      subject,
      outputPath: destination,
      resultTemplatePath,
      pendingTemplatePath
    }));
  }
  return {
    runId: Number(runId),
    targetMonth: data.run.target_month,
    subjects: data.subjects,
    filePaths: paths
  };
}

module.exports = {
  RESULT_SHEET_NAME,
  PENDING_SHEET_NAME,
  AMOUNT_NUM_FORMAT,
  decimalToExcelNumber,
  setReadableAmountColumnWidths,
  configurePrintLayout,
  sanitizeFilePart,
  loadRunData,
  pivotMovementRows,
  nextAvailableOutputPath,
  writeRunWorkbooks
};
