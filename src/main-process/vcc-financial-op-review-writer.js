'use strict';
const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const { withBoundedWorkbook } = require('./bounded-xlsx-writer');
const { encodeExcelStXstring } = require('../backend/toolbox-format/excel-text');
const { loadResultTemplateContract, RESULT_TEMPLATE_FILE_NAME } = require('../backend/vcc-financial-op/result-template-contract');
const { encodeAdjustmentLineageName } = require('../backend/vcc-financial-op/adjustment-lineage');
const { adjustmentReasonRowHeight } = require('./vcc-financial-op-writer');
const { getMeta, pageRows, safePoint } = require('../backend/vcc-financial-op/review-export-plan');
const { projectionCell, textCell, framedDigest, comparableCell, reviewError } = require('../backend/vcc-financial-op/review-export-contract');

const clone = (value) => JSON.parse(JSON.stringify(value));
function noteForPage(page, group) { return `VCC Review Source\n${JSON.stringify({ fullLogicalName: group.fullLogicalName,
  rawContractVersion: group.rawContractVersion, headerFingerprint: group.headerFingerprint, partNumber: page.part })}`; }
function expectedDefinedNames(projection) {
  const names = new Map();
  for (const row of projection.rows.filter((r) => r.kind === 'adjustment')) {
    const name = encodeAdjustmentLineageName(row.rowKey, row.currency);
    if (!names.has(name)) names.set(name, []);
    names.get(name).push(`'待确认表'!$M$${row.rowNumber}`);
  }
  return names;
}
function outputProjectionCells(row) {
  const values = Array.from({ length: 14 }, (_unused, index) => row.cells[index] ? projectionCell(row.cells[index]) : { t: 'null', v: null, f: 'General' });
  if (row.kind === 'summary') values[2] = { t: 'null', v: null, f: '@' };
  if (row.kind === 'title') for (let index = 1; index < 14; index += 1) values[index] = { t: 'null', v: null, f: '@' };
  return values;
}
function fillRow(row, cells) {
  cells.forEach((value, index) => {
    const cell = row.getCell(index + 1);
    cell.value = value.t === 'null' ? null : value.t === 'number' ? Number(value.v)
      : value.t === 'text' ? encodeExcelStXstring(value.v) : value.v;
    cell.numFmt = value.f;
  });
}

async function writeReviewWorkbook({ filePath, manifestPath, assetsDir, signal, onProgress, transformEnvelope }) {
  const contract = await loadResultTemplateContract({ templatePath: path.join(assetsDir, 'VCC财务OP校验', RESULT_TEMPLATE_FILE_NAME) });
  const db = new DatabaseSync(manifestPath, { readOnly: true });
  try {
    const projection = getMeta(db, 'projection'), provenance = getMeta(db, 'provenance');
    const pages = db.prepare('SELECT p.*,g.descriptor,a.content_digest FROM pages p JOIN groups g USING(group_key) JOIN page_actual a ON a.page_id=p.id ORDER BY p.id').all();
    if (pages.length !== db.prepare('SELECT COUNT(*) n FROM pages').get().n) throw reviewError('vcc-review-validation-failed', '附页尚未完成 E/A 核验');
    if (pages.length >= 4096) throw reviewError('vcc-review-resource-limit', '附页数量超出工作簿读取预算');
    const result = await withBoundedWorkbook({ filePath, signal, safePoint: () => safePoint(signal) }, async (session) => {
      const sheet = session.addWorksheet('待确认表', { pageSetup: { orientation: 'landscape', paperSize: 9, fitToPage: true,
        fitToWidth: 1, fitToHeight: 0, printArea: `A1:N${projection.rowCount}` }, views: [{ state: 'frozen', ySplit: 2 }] });
      sheet.columns = contract.columns.map((column, index) => ({ width: index === 13 ? Math.max(28, column.width || 0)
        : index === 2 ? Math.max(30, column.width || 0) : Math.max(index > 2 ? 14 : 12, column.width || 0) }));
      for (const planned of projection.rows) {
        const row = sheet.getRow(planned.rowNumber);
        if (planned.kind === 'spacer') { await session.commitRow(row); continue; }
        const summaryAnchor = { openingBalance: 'opening', effectiveCalculatedBalance: 'calculated', systemBalance: 'system', effectiveDifference: 'difference' }[planned.summaryKey];
        const anchor = planned.kind === 'header' ? contract.headerRow
          : contract.anchors[summaryAnchor || (planned.kind === 'adjustment' ? 'adjustment' : 'classified')] || contract.anchors.classified || contract.headerRow;
        for (let index = 0; index < 14; index += 1) {
          row.getCell(index + 1).style = clone(anchor.cells[index].style);
          row.getCell(index + 1).alignment = { ...row.getCell(index + 1).alignment, vertical: 'middle',
            horizontal: index >= 3 && index <= 12 ? 'right' : 'left', wrapText: index === 2 || index === 13 };
        }
        fillRow(row, outputProjectionCells(planned));
        row.height = planned.kind === 'detail' || planned.kind === 'adjustment' ? 48 : 24;
        if (planned.kind === 'adjustment') row.height = adjustmentReasonRowHeight(planned.cells[13].display, sheet.getColumn(14).width, 48);
        if (planned.kind === 'title') {
          row.font = { name: '微软雅黑', size: 12, bold: true };
          sheet.mergeCells(planned.rowNumber, 1, planned.rowNumber, 14);
          if (planned.rowNumber === 1) row.getCell(1).note = encodeExcelStXstring(`VCC Review Export\n${JSON.stringify(provenance)}`);
        }
        if (planned.kind === 'summary') sheet.mergeCells(planned.rowNumber, 2, planned.rowNumber, 3);
        if (planned.kind === 'header') {
          planned.balanced.forEach((balanced, index) => { row.getCell(index + 4).fill = clone(balanced ? contract.normalFill : contract.abnormalFill); });
        }
        await session.commitRow(row);
      }
      for (const [name, ranges] of expectedDefinedNames(projection)) for (const range of ranges) session.writer.definedNames.add(range, name);
      await session.commitSheet(sheet);
      let sourceRowCount = 0;
      for (const page of pages) {
        const group = JSON.parse(page.descriptor), sourceSheet = session.addWorksheet(page.name);
        const header = sourceSheet.getRow(1); fillRow(header, group.headers.map(textCell));
        header.font = { name: '微软雅黑', bold: true }; header.getCell(1).note = encodeExcelStXstring(noteForPage(page, group));
        await session.commitRow(header);
        const identityDigest = framedDigest(), contentDigest = framedDigest(); let count = 0;
        for (const expected of pageRows(db, page)) {
          const envelope = transformEnvelope ? transformEnvelope({ ...expected }, page) : expected;
          if (!envelope || envelope.identity !== expected.identity || envelope.ordinal !== expected.ordinal) throw reviewError('vcc-review-validation-failed', `${page.name} Writer 消费身份或顺序不符`);
          const cells = JSON.parse(envelope.cells);
          if (cells.length !== group.headers.length) throw reviewError('vcc-review-validation-failed', `${page.name} 原始列数不符`);
          identityDigest.add([page.group_key, expected.ordinal, envelope.identity]);
          contentDigest.add([page.group_key, expected.ordinal, cells.map(comparableCell)]);
          fillRow(sourceSheet.getRow(++count + 1), cells);
          await session.commitRow(sourceSheet.getRow(count + 1));
        }
        if (count !== page.row_count || identityDigest.finish() !== page.identity_digest || contentDigest.finish() !== page.content_digest) {
          throw reviewError('vcc-review-validation-failed', `${page.name} Writer 行数、身份或内容与冻结清单不符`);
        }
        sourceRowCount += count; await session.commitSheet(sourceSheet);
        onProgress?.({ phase: 'writing', sheets: page.id + 1, sourceRowCount });
      }
      return { subjectCount: projection.blocks.length, sheetCount: pages.length + 1, sourceRowCount,
        resultRevision: provenance.resultRevision };
    });
    return result;
  } finally { db.close(); }
}

module.exports = { writeReviewWorkbook, fillRow, outputProjectionCells, expectedDefinedNames, noteForPage };
