'use strict';

const ExcelJS = require('exceljs');

const {
  RESULT_TEMPLATE_FILE_NAME,
  loadResultTemplateContract
} = require('../../backend/vcc-financial-op/result-template-contract');
const {
  PENDING_SHEET_NAME,
  RESULT_SHEET_NAME,
  buildPendingSheet,
  buildResultSheet,
  buildSubjectRowPlan,
  validateResultSheet
} = require('../vcc-financial-op-writer');
const { canonicalSha256 } = require('../background-execution/canonical-json-v1');
const path = require('node:path');

function evidenceError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function normalizeStyle(value) {
  if (Array.isArray(value)) return value.map(normalizeStyle);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, normalizeStyle(value[key])]));
}

function cellValue(value) {
  if (value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (value && typeof value === 'object') return normalizeStyle(value);
  return value;
}

function pendingSheetProjection(sheet) {
  const rowCount = sheet.actualRowCount;
  const columnCount = Math.max(sheet.actualColumnCount, 11);
  const rows = [];
  for (let rowNumber = 1; rowNumber <= rowCount; rowNumber += 1) {
    const row = sheet.getRow(rowNumber);
    const cells = [];
    for (let columnNumber = 1; columnNumber <= columnCount; columnNumber += 1) {
      const cell = sheet.getCell(rowNumber, columnNumber);
      cells.push({
        value: cellValue(cell.value),
        style: normalizeStyle(cell.style),
        numFmt: cell.numFmt || 'General'
      });
    }
    rows.push({
      height: row.height == null ? null : row.height,
      hidden: Boolean(row.hidden),
      outlineLevel: row.outlineLevel || 0,
      cells
    });
  }
  return {
    name: sheet.name,
    state: sheet.state || 'visible',
    properties: normalizeStyle(sheet.properties || {}),
    headerFooter: normalizeStyle(sheet.headerFooter || {}),
    rowCount,
    columnCount,
    columns: Array.from({ length: columnCount }, (_unused, index) => {
      const column = sheet.getColumn(index + 1);
      return {
        width: column.width == null ? null : column.width,
        hidden: Boolean(column.hidden),
        outlineLevel: column.outlineLevel || 0
      };
    }),
    rows,
    views: normalizeStyle(sheet.views),
    autoFilter: normalizeStyle(sheet.autoFilter),
    pageSetup: normalizeStyle(sheet.pageSetup)
  };
}

async function loadValidationContext(assetsDir) {
  const resultTemplatePath = path.join(
    assetsDir,
    'VCC财务OP校验',
    RESULT_TEMPLATE_FILE_NAME
  );
  const pendingTemplatePath = path.join(
    assetsDir,
    'VCC财务OP校验',
    '移除归档Pending发生额计算表.xlsx'
  );
  const resultContract = await loadResultTemplateContract({ templatePath: resultTemplatePath });
  const pendingTemplate = new ExcelJS.Workbook();
  await pendingTemplate.xlsx.readFile(pendingTemplatePath);
  const pendingTemplateSheet = pendingTemplate.worksheets[0];
  if (!pendingTemplateSheet) {
    throw evidenceError('VCC_EXPORT_TEMPLATE_INVALID', 'VCC Pending 模板缺少工作表');
  }
  return Object.freeze({ resultContract, pendingTemplateSheet });
}

async function validateVccSubjectArtifact({
  artifactPath,
  snapshot,
  subjectIndex,
  validationContext
}) {
  const subject = snapshot.data.subjects[subjectIndex];
  const expectedAuthority = snapshot.authority.subjects[subjectIndex];
  if (typeof subject !== 'string' || !expectedAuthority ||
      expectedAuthority.subjectIndex !== subjectIndex) {
    throw evidenceError('VCC_EXPORT_SUBJECT_AUTHORITY_INVALID', 'VCC subjectIndex authority 非法');
  }
  const plan = buildSubjectRowPlan(snapshot.data, subject);
  const scratchResult = new ExcelJS.Workbook();
  const { renderedRows, lastRow } = buildResultSheet(
    scratchResult,
    validationContext.resultContract,
    plan
  );
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(artifactPath);
  if (workbook.worksheets.length !== 2 ||
      workbook.worksheets[0].name !== RESULT_SHEET_NAME ||
      workbook.worksheets[1].name !== PENDING_SHEET_NAME) {
    throw evidenceError('VCC_EXPORT_WORKBOOK_STRUCTURE_INVALID', 'VCC artifact sheet set/order 非法');
  }
  validateResultSheet(
    workbook,
    validationContext.resultContract,
    plan,
    renderedRows,
    lastRow
  );
  const expectedPendingWorkbook = new ExcelJS.Workbook();
  const expectedPending = buildPendingSheet(
    expectedPendingWorkbook,
    validationContext.pendingTemplateSheet,
    subject,
    snapshot.data
  );
  const expectedPendingSerialized = new ExcelJS.Workbook();
  await expectedPendingSerialized.xlsx.load(await expectedPendingWorkbook.xlsx.writeBuffer());
  const normalizedExpectedPending = expectedPendingSerialized.getWorksheet(PENDING_SHEET_NAME);
  const actualPending = workbook.getWorksheet(PENDING_SHEET_NAME);
  if (canonicalSha256(pendingSheetProjection(actualPending)) !==
      canonicalSha256(pendingSheetProjection(normalizedExpectedPending))) {
    throw evidenceError(
      'VCC_EXPORT_PENDING_EVIDENCE_MISMATCH',
      'VCC artifact Pending 金额/币种/样式回读不一致'
    );
  }
  if (lastRow !== expectedAuthority.resultRowCount ||
      actualPending.actualRowCount !== expectedAuthority.pendingRowCount ||
      expectedPending.actualRowCount !== expectedAuthority.pendingRowCount) {
    throw evidenceError('VCC_EXPORT_ROW_COUNT_MISMATCH', 'VCC artifact 业务行数不守恒');
  }
  return Object.freeze({
    subjectIndex,
    subjectDigest: expectedAuthority.subjectDigest,
    businessDigest: expectedAuthority.businessDigest,
    resultRowCount: lastRow,
    pendingRowCount: actualPending.actualRowCount
  });
}

module.exports = {
  loadValidationContext,
  pendingSheetProjection,
  validateVccSubjectArtifact
};
