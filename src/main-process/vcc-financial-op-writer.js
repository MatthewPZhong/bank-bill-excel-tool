'use strict';

const fs = require('node:fs');
const path = require('node:path');
const ExcelJS = require('exceljs');
const {
  SOURCE_TYPES,
  SUPPORTED_CURRENCIES
} = require('../backend/vcc-financial-op/definitions');
const { canonicalizeVccAmount } = require('../backend/vcc-financial-op/amount-rules');
const { getEffectiveRunResult } = require('../backend/vcc-financial-op/result-adjustments');
const {
  RESULT_TEMPLATE_FILE_NAME,
  RESULT_TEMPLATE_SHEET_NAME,
  RESULT_TEMPLATE_HEADERS,
  loadResultTemplateContract
} = require('../backend/vcc-financial-op/result-template-contract');
const {
  ADJUSTMENT_LINEAGE_NAME_PREFIX,
  encodeAdjustmentLineageName,
  parseAdjustmentLineageName
} = require('../backend/vcc-financial-op/adjustment-lineage');
const {
  isEffectiveDifferenceZero
} = require('../shared/vcc-financial-op-difference');
const {
  encodeExcelStXstring
} = require('../backend/toolbox-format/excel-text');
const { writeXlsxAtomically } = require('./vcc-financial-op-output-publication');

const RESULT_SHEET_NAME = RESULT_TEMPLATE_SHEET_NAME;
const PENDING_SHEET_NAME = '移除归档Pending发生额计算表';
const AMOUNT_NUM_FORMAT = '#,##0.00;[Red]-#,##0.00;-';
const MAX_EXCEL_ROW_HEIGHT = 409.5;

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

function loadEffectiveRunData(db, runId) {
  const effective = getEffectiveRunResult(db, runId);
  if (!effective) throw new Error(`财务OP校验结果不存在：${runId}`);
  const pendingSummary = db.prepare(`
    SELECT * FROM vcc_fin_op_pending_summary_rows
    WHERE run_id = ?
    ORDER BY subject, channel_name, currency_mismatch, flow_currency, pending_currency, recon_type
  `).all(effective.run.runId);
  const pendingTotals = db.prepare(`
    SELECT * FROM vcc_fin_op_pending_currency_totals
    WHERE run_id = ? ORDER BY subject, currency
  `).all(effective.run.runId);
  const subjects = effective.review.subjects.map((row) => row.subject).sort((left, right) => (
    left < right ? -1 : (left > right ? 1 : 0)
  ));
  if (subjects.length === 0) throw new Error('财务OP校验结果没有主体数据');
  return { effective, run: effective.run, pendingSummary, pendingTotals, subjects };
}

function rowAnchorKind(row) {
  if (row.rowKind === 'pending') return 'pending';
  if (row.sourceType === SOURCE_TYPES.CHANNEL) return 'channel';
  return row.categoryMinor ? 'classified' : 'unclassified';
}

function buildSubjectRowPlan(data, subject) {
  const reviewSubject = data.effective.review.subjects.find((row) => row.subject === subject);
  if (!reviewSubject) throw new Error(`财务OP校验结果缺少主体：${subject}`);
  const rows = [{
    rowType: 'opening',
    anchorKind: 'opening',
    subject,
    major: '上月财务OP',
    minor: '',
    amounts: reviewSubject.summaries.openingBalance
  }];
  for (const row of reviewSubject.rows) {
    rows.push({
      rowType: row.type === 'adjustment' ? 'adjustment' : (
        row.rowKind === 'pending' ? 'pending' : 'movement'
      ),
      anchorKind: rowAnchorKind(row),
      rowKey: row.rowKey,
      rowKind: row.rowKind,
      subject,
      sourceType: row.sourceType,
      major: row.categoryMajor,
      minor: row.categoryMinor,
      amounts: row.currencyAmounts,
      currency: row.currency || null,
      adjustmentAmount: row.adjustmentAmount || null,
      reason: row.reason || '',
      sequence: row.sequence || null
    });
  }
  rows.push(
    {
      rowType: 'calculated',
      anchorKind: 'calculated',
      subject,
      major: '当月计算财务OP',
      minor: '',
      amounts: reviewSubject.summaries.effectiveCalculatedBalance
    },
    {
      rowType: 'system',
      anchorKind: 'system',
      subject,
      major: '当月系统财务OP',
      minor: '',
      amounts: reviewSubject.summaries.systemBalance
    },
    {
      rowType: 'difference',
      anchorKind: 'difference',
      subject,
      major: '差异',
      minor: '',
      amounts: reviewSubject.summaries.effectiveDifference
    }
  );
  return {
    subject,
    targetMonth: data.run.targetMonth,
    resultRevision: data.run.resultRevision,
    differences: reviewSubject.summaries.effectiveDifference,
    rows
  };
}

function applyCapturedCellStyle(captured, targetCell) {
  targetCell.style = cloneStyle(captured && captured.style);
  if (captured && captured.numFmt) targetCell.numFmt = captured.numFmt;
}

function applyContractRowStyle(contractRow, sheet, rowNumber) {
  const targetRow = sheet.getRow(rowNumber);
  if (contractRow.height != null) targetRow.height = contractRow.height;
  targetRow.hidden = Boolean(contractRow.hidden);
  targetRow.outlineLevel = contractRow.outlineLevel || 0;
  contractRow.cells.forEach((captured, index) => {
    applyCapturedCellStyle(captured, sheet.getCell(rowNumber, index + 1));
  });
}

function applyContractColumns(contract, sheet) {
  contract.columns.forEach((captured, index) => {
    const column = sheet.getColumn(index + 1);
    if (captured.width != null) column.width = captured.width;
    column.hidden = Boolean(captured.hidden);
    column.outlineLevel = captured.outlineLevel || 0;
    column.style = cloneStyle(captured.style);
  });
}

function unicodeDisplayWidth(value) {
  let width = 0;
  for (const character of String(value == null ? '' : value)) {
    width += character.codePointAt(0) <= 0x7f ? 1 : 2;
  }
  return width;
}

function adjustmentReasonRowHeight(reason, columnWidth, baseHeight) {
  const normalizedBaseHeight = Number.isFinite(Number(baseHeight)) && Number(baseHeight) > 0
    ? Number(baseHeight) : 15;
  const usableWidth = Math.max(1, Math.floor(Number(columnWidth || 0) - 1));
  const lineCount = String(reason == null ? '' : reason)
    .split(/\r\n|\r|\n/)
    .reduce((total, line) => (
      total + Math.max(1, Math.ceil(unicodeDisplayWidth(line) / usableWidth))
    ), 0);
  return Math.min(
    MAX_EXCEL_ROW_HEIGHT,
    Math.max(normalizedBaseHeight, Math.ceil(lineCount * Math.max(normalizedBaseHeight, 15)))
  );
}

function canonicalPlanAmount(amounts, currency, label) {
  const value = amounts && amounts[currency] != null ? amounts[currency] : '0';
  return canonicalizeVccAmount(value, label);
}

function setResultAmountCells(sheet, rowNumber, amounts) {
  for (let index = 0; index < SUPPORTED_CURRENCIES.length; index++) {
    const currency = SUPPORTED_CURRENCIES[index];
    const canonical = canonicalPlanAmount(amounts, currency, `${currency} 金额`);
    sheet.getCell(rowNumber, index + 4).value = decimalToExcelNumber(canonical, `${currency} 金额`);
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

function buildResultSheet(workbook, contract, plan) {
  const sheet = workbook.addWorksheet(RESULT_SHEET_NAME, {
    views: cloneStyle(contract.views),
    properties: cloneStyle(contract.properties),
    pageSetup: cloneStyle(contract.pageSetup),
    headerFooter: cloneStyle(contract.headerFooter),
    state: contract.state
  });
  applyContractColumns(contract, sheet);
  applyContractRowStyle(contract.headerRow, sheet, 1);
  RESULT_TEMPLATE_HEADERS.forEach((header, index) => {
    sheet.getCell(1, index + 1).value = header;
  });
  SUPPORTED_CURRENCIES.forEach((currency, index) => {
    const zero = isEffectiveDifferenceZero(plan.differences[currency]);
    sheet.getCell(1, index + 4).fill = cloneStyle(
      zero ? contract.normalFill : contract.abnormalFill
    );
  });

  const renderedRows = plan.rows.map((row, index) => ({ ...row, rowNumber: index + 2 }));
  const lineageAssignments = [];
  for (const row of renderedRows) {
    const anchor = contract.anchors[row.anchorKind];
    if (!anchor) throw new Error(`结果模板缺少语义锚点：${row.anchorKind}`);
    applyContractRowStyle(anchor, sheet, row.rowNumber);
    sheet.getCell(row.rowNumber, 1).value = plan.subject;
    sheet.getCell(row.rowNumber, 2).value = row.major || '';
    sheet.getCell(row.rowNumber, 3).value = row.minor || '';
    sheet.getCell(row.rowNumber, 13).value = null;
    sheet.getCell(row.rowNumber, 14).value = null;
    setResultAmountCells(sheet, row.rowNumber, row.amounts);
    if (anchor.mergeMajorMinor) sheet.mergeCells(row.rowNumber, 2, row.rowNumber, 3);

    if (row.rowType === 'adjustment') {
      const currencyIndex = SUPPORTED_CURRENCIES.indexOf(row.currency);
      if (currencyIndex < 0) throw new Error(`调整币种非法：${row.currency}`);
      const targetCell = sheet.getCell(row.rowNumber, currencyIndex + 4);
      targetCell.font = cloneStyle(contract.adjustmentValueStyle.style.font);
      targetCell.numFmt = contract.adjustmentValueStyle.numFmt;
      const valueCell = sheet.getCell(row.rowNumber, 13);
      valueCell.value = decimalToExcelNumber(row.adjustmentAmount, '调整值');
      valueCell.font = cloneStyle(contract.adjustmentValueStyle.style.font);
      valueCell.numFmt = contract.adjustmentValueStyle.numFmt;
      const reasonCell = sheet.getCell(row.rowNumber, 14);
      // ExcelJS 会把业务原文中的字面 _xHHHH_ 当作 OOXML ST_Xstring escape。
      // 仅在 Excel 边界做一次安全编码，DB/review/audit 继续保留原始调整原因。
      reasonCell.value = encodeExcelStXstring(row.reason);
      reasonCell.font = cloneStyle(contract.adjustmentReasonFont);
      reasonCell.alignment = {
        ...cloneStyle(reasonCell.alignment),
        wrapText: true
      };
      sheet.getRow(row.rowNumber).height = adjustmentReasonRowHeight(
        row.reason,
        sheet.getColumn(14).width,
        anchor.height
      );
      lineageAssignments.push({
        rowNumber: row.rowNumber,
        rowKey: row.rowKey,
        currency: row.currency
      });
    }
  }

  const lastRow = renderedRows[renderedRows.length - 1].rowNumber;
  sheet.mergeCells(2, 1, lastRow, 1);
  sheet.pageSetup = cloneStyle(contract.pageSetup);
  sheet.pageSetup.printArea = `A1:${contract.printAreaRightColumn}${lastRow}`;
  sheet.autoFilter = `A1:${contract.printAreaRightColumn}${lastRow}`;

  // Excel defined name 在最终 sheet 名和动态行结构确定后创建，避免产生孤儿引用。
  for (const assignment of lineageAssignments) {
    sheet.getCell(assignment.rowNumber, 13).name = encodeAdjustmentLineageName(
      assignment.rowKey,
      assignment.currency
    );
  }
  return { sheet, renderedRows, lastRow };
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

function exportValidationError(message, detailLines = []) {
  const error = new Error(message);
  error.code = 'vcc-result-export-validation-failed';
  error.detailLines = detailLines;
  return error;
}

function styleSignature(value) {
  const normalize = (item) => {
    if (Array.isArray(item)) return item.map(normalize);
    if (!item || typeof item !== 'object') return item;
    return Object.fromEntries(Object.keys(item).sort().map((key) => [key, normalize(item[key])]));
  };
  return JSON.stringify(normalize(value == null ? null : value));
}

function comparableCellStyle(cell, { includeFill = true } = {}) {
  return {
    font: cloneStyle(cell.font),
    fill: includeFill ? cloneStyle(cell.fill) : null,
    border: cloneStyle(cell.border),
    alignment: cloneStyle(cell.alignment),
    numFmt: cell.numFmt || 'General',
    protection: cloneStyle(cell.protection)
  };
}

function comparableCapturedStyle(captured, { includeFill = true } = {}) {
  const style = captured.style || {};
  return {
    font: cloneStyle(style.font),
    fill: includeFill ? cloneStyle(style.fill) : null,
    border: cloneStyle(style.border),
    alignment: cloneStyle(style.alignment),
    numFmt: captured.numFmt || style.numFmt || 'General',
    protection: cloneStyle(style.protection)
  };
}

function assertStyleMatches(cell, captured, label, options) {
  if (styleSignature(comparableCellStyle(cell, options))
      !== styleSignature(comparableCapturedStyle(captured, options))) {
    throw exportValidationError(`VCC 财务OP导出样式校验失败：${label}`);
  }
}

function structuralStyleFromCell(cell, { includeNumFmt = false } = {}) {
  const fill = cloneStyle(cell.fill);
  const normalizedFill = fill && fill.type === 'pattern' && fill.pattern === 'none'
    && !fill.fgColor && !fill.bgColor ? {} : fill;
  return {
    fill: normalizedFill,
    border: cloneStyle(cell.border),
    alignment: cloneStyle(cell.alignment),
    protection: cloneStyle(cell.protection),
    ...(includeNumFmt ? { numFmt: cell.numFmt || 'General' } : {})
  };
}

function structuralStyleFromCaptured(captured, {
  includeNumFmt = false,
  wrapText = null
} = {}) {
  const style = captured.style || {};
  const alignment = cloneStyle(style.alignment);
  const fill = cloneStyle(style.fill);
  const normalizedFill = fill && fill.type === 'pattern' && fill.pattern === 'none'
    && !fill.fgColor && !fill.bgColor ? {} : fill;
  if (wrapText !== null) alignment.wrapText = wrapText;
  return {
    fill: normalizedFill,
    border: cloneStyle(style.border),
    alignment,
    protection: cloneStyle(style.protection),
    ...(includeNumFmt ? { numFmt: captured.numFmt || style.numFmt || 'General' } : {})
  };
}

function assertStructuralStyleMatches(cell, captured, label, options) {
  if (styleSignature(structuralStyleFromCell(cell, options))
      !== styleSignature(structuralStyleFromCaptured(captured, options))) {
    throw exportValidationError(`VCC 财务OP导出结构样式校验失败：${label}`, [
      `实际：${styleSignature(structuralStyleFromCell(cell, options))}`,
      `期望：${styleSignature(structuralStyleFromCaptured(captured, options))}`
    ]);
  }
}

function mergeRangeString(range) {
  const { top, left, bottom, right } = range.model;
  const start = `${String.fromCharCode(64 + left)}${top}`;
  const end = `${String.fromCharCode(64 + right)}${bottom}`;
  return `${start}:${end}`;
}

function assertMergeLayout(sheet, renderedRows, contract, lastRow) {
  const expected = new Set([`A2:A${lastRow}`]);
  for (const row of renderedRows) {
    if (contract.anchors[row.anchorKind].mergeMajorMinor) {
      expected.add(`B${row.rowNumber}:C${row.rowNumber}`);
    }
  }
  const actualRanges = Object.values(sheet._merges).map(mergeRangeString);
  const actual = new Set(actualRanges);
  if (actual.size !== expected.size
      || [...expected].some((range) => !actual.has(range))) {
    throw exportValidationError('VCC 财务OP导出动态合并区域校验失败', [
      `期望：${[...expected].join('、')}`,
      `实际：${actualRanges.join('、')}`
    ]);
  }
  const models = Object.values(sheet._merges).map((range) => range.model);
  for (let leftIndex = 0; leftIndex < models.length; leftIndex++) {
    for (let rightIndex = leftIndex + 1; rightIndex < models.length; rightIndex++) {
      const left = models[leftIndex];
      const right = models[rightIndex];
      const overlaps = left.left <= right.right && right.left <= left.right
        && left.top <= right.bottom && right.top <= left.bottom;
      if (overlaps) throw exportValidationError('VCC 财务OP导出存在重叠合并区域');
    }
  }
}

function assertCanonicalCellAmount(cell, expected, label) {
  if (typeof cell.value !== 'number' || !Number.isFinite(cell.value)) {
    throw exportValidationError(`${label}不是有限 Excel 数值`);
  }
  const actual = canonicalizeVccAmount(cell.value, label);
  if (actual !== expected) {
    throw exportValidationError(`${label}回读不一致`, [`期望 ${expected}，实际 ${actual}`]);
  }
}

function markerModels(workbook) {
  const prefix = ADJUSTMENT_LINEAGE_NAME_PREFIX.toLocaleLowerCase('en-US');
  return (workbook.definedNames.model || []).filter((item) => (
    String(item.name || '').toLocaleLowerCase('en-US').startsWith(prefix)
  ));
}

function assertAdjustmentLineage(workbook, sheet, renderedRows, lastRow) {
  const adjustments = renderedRows.filter((row) => row.rowType === 'adjustment');
  const expectedByRow = new Map(adjustments.map((row) => [
    row.rowNumber,
    encodeAdjustmentLineageName(row.rowKey, row.currency)
  ]));
  const models = markerModels(workbook);
  const namesCaseInsensitive = new Set();
  const seenRows = new Set();
  for (const model of models) {
    const normalizedName = String(model.name).toLocaleLowerCase('en-US');
    if (namesCaseInsensitive.has(normalizedName)) {
      throw exportValidationError('调整血缘名称存在大小写重复');
    }
    namesCaseInsensitive.add(normalizedName);
    const lineage = parseAdjustmentLineageName(model.name);
    if (!lineage) throw exportValidationError(`调整血缘名称非法：${model.name}`);
    if (!Array.isArray(model.ranges) || model.ranges.length !== 1) {
      throw exportValidationError(`调整血缘必须且只能引用一个单元格：${model.name}`);
    }
    const rangeMatch = /^(?:'财务OP校验结果表'|财务OP校验结果表)!\$M\$(\d+)$/.exec(model.ranges[0]);
    if (!rangeMatch) {
      throw exportValidationError(`调整血缘必须引用结果表 M 列单个单元格：${model.name}`);
    }
    const rowNumber = Number(rangeMatch[1]);
    if (rowNumber < 2 || rowNumber > lastRow || seenRows.has(rowNumber)) {
      throw exportValidationError(`调整血缘引用行无效或重复：${model.name}`);
    }
    seenRows.add(rowNumber);
    const expectedName = expectedByRow.get(rowNumber);
    if (expectedName !== model.name) {
      throw exportValidationError(`调整血缘与 adjustment 行不一致：${model.name}`);
    }
    const cell = sheet.getCell(rowNumber, 13);
    const cellMarkers = cell.names.filter((name) => (
      name.toLocaleLowerCase('en-US').startsWith(
        ADJUSTMENT_LINEAGE_NAME_PREFIX.toLocaleLowerCase('en-US')
      )
    ));
    if (cellMarkers.length !== 1 || cellMarkers[0] !== model.name) {
      throw exportValidationError(`调整行 M${rowNumber} 血缘标记不唯一`);
    }
    const expectedRow = adjustments.find((row) => row.rowNumber === rowNumber);
    if (lineage.rowKey !== expectedRow.rowKey || lineage.currency !== expectedRow.currency) {
      throw exportValidationError(`调整血缘无法还原目标坐标：${model.name}`);
    }
  }
  if (models.length !== adjustments.length || seenRows.size !== adjustments.length) {
    throw exportValidationError('调整行与血缘标记数量不一致');
  }
}

function validateResultSheet(workbook, contract, plan, renderedRows, lastRow) {
  const sheet = workbook.getWorksheet(RESULT_SHEET_NAME);
  if (!sheet) throw exportValidationError('VCC 财务OP导出缺少结果 sheet');
  const headers = RESULT_TEMPLATE_HEADERS.map((_, index) => sheet.getCell(1, index + 1).text);
  if (styleSignature(headers) !== styleSignature(RESULT_TEMPLATE_HEADERS)) {
    throw exportValidationError('VCC 财务OP导出结果表头校验失败');
  }
  if (sheet.actualRowCount !== lastRow || sheet.actualColumnCount !== 14) {
    throw exportValidationError('VCC 财务OP导出结果区域校验失败', [
      `期望 A1:N${lastRow}，实际有效行为 ${sheet.actualRowCount}、列为 ${sheet.actualColumnCount}`
    ]);
  }
  if (sheet.getCell('A2').text !== plan.subject) {
    throw exportValidationError('VCC 财务OP导出主体校验失败');
  }
  if (sheet.pageSetup.printArea !== `A1:${contract.printAreaRightColumn}${lastRow}`) {
    throw exportValidationError('VCC 财务OP导出打印区域校验失败');
  }
  if (sheet.autoFilter !== `A1:${contract.printAreaRightColumn}${lastRow}`) {
    throw exportValidationError('VCC 财务OP导出筛选区域校验失败');
  }
  if (styleSignature(sheet.views) !== styleSignature(contract.views)) {
    throw exportValidationError('VCC 财务OP导出冻结窗格校验失败');
  }
  contract.columns.forEach((column, index) => {
    const actualWidth = sheet.getColumn(index + 1).width;
    if ((column.width == null && actualWidth != null)
        || (column.width != null && actualWidth !== column.width)) {
      throw exportValidationError(`VCC 财务OP导出第 ${index + 1} 列列宽校验失败`);
    }
  });
  [1, 2, 13, 14].forEach((columnNumber) => {
    assertStyleMatches(
      sheet.getCell(1, columnNumber),
      contract.headerRow.cells[columnNumber - 1],
      `表头 ${sheet.getColumn(columnNumber).letter}1`
    );
  });
  SUPPORTED_CURRENCIES.forEach((currency, index) => {
    const cell = sheet.getCell(1, index + 4);
    assertStyleMatches(cell, contract.headerRow.cells[index + 3], `${currency} 表头`, {
      includeFill: false
    });
    const expectedFill = isEffectiveDifferenceZero(plan.differences[currency])
      ? contract.normalFill : contract.abnormalFill;
    if (styleSignature(cell.fill) !== styleSignature(expectedFill)) {
      throw exportValidationError(`${currency} 表头生效差异填充校验失败`);
    }
  });

  for (const row of renderedRows) {
    const anchor = contract.anchors[row.anchorKind];
    const majorCell = sheet.getCell(row.rowNumber, 2);
    if (majorCell.text !== (row.major || '')) {
      throw exportValidationError(`结果第 ${row.rowNumber} 行大类校验失败`);
    }
    if (!anchor.mergeMajorMinor && sheet.getCell(row.rowNumber, 3).text !== (row.minor || '')) {
      throw exportValidationError(`结果第 ${row.rowNumber} 行分类校验失败`);
    }
    const actualHeight = sheet.getRow(row.rowNumber).height == null
      ? null : sheet.getRow(row.rowNumber).height;
    const expectedHeight = row.rowType === 'adjustment'
      ? adjustmentReasonRowHeight(row.reason, sheet.getColumn(14).width, anchor.height)
      : anchor.height;
    if (actualHeight !== expectedHeight) {
      throw exportValidationError(`结果第 ${row.rowNumber} 行行高校验失败`);
    }
    assertStyleMatches(majorCell, anchor.cells[1], `结果第 ${row.rowNumber} 行大类`);
    for (let index = 0; index < SUPPORTED_CURRENCIES.length; index++) {
      const currency = SUPPORTED_CURRENCIES[index];
      const expected = canonicalPlanAmount(row.amounts, currency, `${currency} 回读金额`);
      const cell = sheet.getCell(row.rowNumber, index + 4);
      assertCanonicalCellAmount(cell, expected, `结果第 ${row.rowNumber} 行 ${currency}`);
      if (row.rowType !== 'adjustment' || currency !== row.currency) {
        assertStyleMatches(cell, anchor.cells[index + 3], `结果第 ${row.rowNumber} 行 ${currency}`);
      }
    }
    const valueCell = sheet.getCell(row.rowNumber, 13);
    const reasonCell = sheet.getCell(row.rowNumber, 14);
    if (row.rowType === 'adjustment') {
      assertCanonicalCellAmount(
        valueCell,
        canonicalizeVccAmount(row.adjustmentAmount, '调整值回读'),
        `结果第 ${row.rowNumber} 行调整值`
      );
      if (reasonCell.value !== row.reason) {
        throw exportValidationError(`结果第 ${row.rowNumber} 行调整原因回读失败`);
      }
      const targetCell = sheet.getCell(
        row.rowNumber,
        SUPPORTED_CURRENCIES.indexOf(row.currency) + 4
      );
      assertStructuralStyleMatches(
        targetCell,
        anchor.cells[SUPPORTED_CURRENCIES.indexOf(row.currency) + 3],
        `结果第 ${row.rowNumber} 行目标币种`
      );
      assertStructuralStyleMatches(
        valueCell,
        anchor.cells[12],
        `结果第 ${row.rowNumber} 行 M 列`
      );
      assertStructuralStyleMatches(
        reasonCell,
        anchor.cells[13],
        `结果第 ${row.rowNumber} 行 N 列`,
        { includeNumFmt: true, wrapText: true }
      );
      if (styleSignature(targetCell.font)
          !== styleSignature(contract.adjustmentValueStyle.style.font)
          || targetCell.numFmt !== contract.adjustmentValueStyle.numFmt
          || styleSignature(valueCell.font)
          !== styleSignature(contract.adjustmentValueStyle.style.font)
          || valueCell.numFmt !== contract.adjustmentValueStyle.numFmt
          || styleSignature(reasonCell.font) !== styleSignature(contract.adjustmentReasonFont)) {
        throw exportValidationError(`结果第 ${row.rowNumber} 行调整样式校验失败`);
      }
    } else if (valueCell.value != null || reasonCell.value != null) {
      throw exportValidationError(`结果第 ${row.rowNumber} 行泄漏模板样例值`);
    }
  }
  assertMergeLayout(sheet, renderedRows, contract, lastRow);
  assertAdjustmentLineage(workbook, sheet, renderedRows, lastRow);
}

async function validateStagedWorkbook({ stagedPath, resultContract, plan, renderedRows, lastRow }) {
  const validation = new ExcelJS.Workbook();
  await validation.xlsx.readFile(stagedPath);
  const sheetNames = validation.worksheets.map((sheet) => sheet.name);
  if (sheetNames.length !== 2
      || sheetNames[0] !== RESULT_SHEET_NAME
      || sheetNames[1] !== PENDING_SHEET_NAME) {
    throw exportValidationError('VCC 财务OP导出文件结构校验失败');
  }
  validateResultSheet(validation, resultContract, plan, renderedRows, lastRow);
  const pendingSheet = validation.getWorksheet(PENDING_SHEET_NAME);
  if (pendingSheet.getCell('A1').value !== 'channel'
      || pendingSheet.getCell('K1').value !== '差额') {
    throw exportValidationError('VCC 财务OP导出 Pending 表头校验失败');
  }
}

async function writeSubjectWorkbook({ data, plan, outputPath, resultContract, pendingTemplateSheet }) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = '网银账单生成小助手';
  workbook.created = new Date();
  const { renderedRows, lastRow } = buildResultSheet(workbook, resultContract, plan);
  buildPendingSheet(workbook, pendingTemplateSheet, plan.subject, data);
  return writeXlsxAtomically({
    outputPath,
    writeStaged: (stagedPath) => workbook.xlsx.writeFile(stagedPath),
    validateStaged: (stagedPath) => validateStagedWorkbook({
      stagedPath,
      resultContract,
      plan,
      renderedRows,
      lastRow
    })
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

function planRunWorkbookOutputPaths({ targetMonth, subjects, outputDirectory, outputPath }) {
  const plannedSubjects = Array.isArray(subjects) ? subjects : [];
  if (plannedSubjects.length === 1 && outputPath) {
    return Object.freeze([path.resolve(outputPath)]);
  }
  const usedNames = new Set();
  return Object.freeze(plannedSubjects.map((subject) => {
    const baseName = `${targetMonth}_${sanitizeFilePart(subject)}_VCC财务OP校验结果表`;
    return path.resolve(nextAvailableOutputPath(outputDirectory, baseName, usedNames));
  }));
}

async function writeRunWorkbooks({
  db,
  runId,
  outputPaths,
  assetsDir,
  publicationStagingDirectory = null,
  writeSubjectWorkbookFn = writeSubjectWorkbook
}) {
  const resultTemplatePath = path.join(assetsDir, 'VCC财务OP校验', RESULT_TEMPLATE_FILE_NAME);
  const pendingTemplatePath = path.join(assetsDir, 'VCC财务OP校验', '移除归档Pending发生额计算表.xlsx');
  // 两份模板必须在解析任何目标输出路径前完整读取；模板异常时不得触碰用户文件。
  const resultContract = await loadResultTemplateContract({ templatePath: resultTemplatePath });
  const pendingTemplate = new ExcelJS.Workbook();
  await pendingTemplate.xlsx.readFile(pendingTemplatePath);
  const pendingTemplateSheet = pendingTemplate.worksheets[0];
  if (!pendingTemplateSheet) throw new Error('移除归档Pending发生额计算模板缺少工作表');

  const data = loadEffectiveRunData(db, Number(runId));
  const plans = data.subjects.map((subject) => buildSubjectRowPlan(data, subject));
  const destinations = outputPaths.map((filePath) => path.resolve(filePath));
  const deferredPublication = Boolean(publicationStagingDirectory);
  const generationPaths = [];
  if (deferredPublication) {
    fs.mkdirSync(publicationStagingDirectory, { recursive: true });
  }
  try {
    for (let index = 0; index < plans.length; index += 1) {
      const plan = plans[index];
      const destination = destinations[index];
      const generationPath = deferredPublication
        ? path.join(
            publicationStagingDirectory,
            `${String(index + 1).padStart(3, '0')}-${sanitizeFilePart(plan.subject) || '未命名主体'}.xlsx`
          )
        : destination;
      generationPaths.push(await writeSubjectWorkbookFn({
        data,
        plan,
        outputPath: generationPath,
        resultContract,
        pendingTemplateSheet
      }));
    }
  } catch (error) {
    if (deferredPublication) {
      for (const filePath of generationPaths) {
        try { fs.rmSync(filePath, { force: true }); } catch (_cleanupError) { /* caller also owns dir */ }
      }
    }
    error.partialResult = Object.freeze({
      status: 'error',
      partialCommitted: deferredPublication ? false : generationPaths.length > 0,
      runId: Number(runId),
      targetMonth: data.run.targetMonth,
      subjects: Object.freeze(data.subjects.slice(0, generationPaths.length)),
      filePaths: Object.freeze(deferredPublication ? [] : [...generationPaths])
    });
    throw error;
  }
  return {
    runId: Number(runId),
    targetMonth: data.run.targetMonth,
    subjects: data.subjects,
    filePaths: destinations,
    ...(deferredPublication
      ? { generationFilePaths: generationPaths.map((filePath) => path.resolve(filePath)) }
      : {})
  };
}

module.exports = {
  RESULT_SHEET_NAME,
  PENDING_SHEET_NAME,
  AMOUNT_NUM_FORMAT,
  MAX_EXCEL_ROW_HEIGHT,
  decimalToExcelNumber,
  unicodeDisplayWidth,
  adjustmentReasonRowHeight,
  setReadableAmountColumnWidths,
  configurePrintLayout,
  sanitizeFilePart,
  loadEffectiveRunData,
  rowAnchorKind,
  buildSubjectRowPlan,
  buildResultSheet,
  validateResultSheet,
  validateStagedWorkbook,
  assertAdjustmentLineage,
  nextAvailableOutputPath,
  planRunWorkbookOutputPaths,
  writeRunWorkbooks
};
