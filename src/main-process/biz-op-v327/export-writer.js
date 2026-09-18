'use strict';

const { withBoundedWorkbook } = require('../bounded-xlsx-writer');
const { encodeExcelStXstring } = require('../../backend/toolbox-format/excel-text');
const { fail } = require('./contracts');

async function writeExportWorkbook({ filePath, spool, expected, safePoint }) {
  return withBoundedWorkbook({ filePath, safePoint,
    compatibilityError: () => { fail('BIZOP_WRITER_COMPATIBILITY_REQUIRED'); } }, async (session) => {
    for (const page of expected.pages) {
      const sheet = session.addWorksheet(page.name);
      const emit = async (values) => {
        const row = sheet.addRow(values.map((cell) => cell.t === 'null' ? null : cell.t === 'number' ? Number(cell.v)
          : cell.t === 'text' ? encodeExcelStXstring(cell.v) : cell.v));
        values.forEach((cell, index) => { if (cell.t !== 'null') row.getCell(index + 1).numFmt = cell.f; });
        await session.commitRow(row);
      };
      await emit(page.headers.map((value) => ({ t: 'text', v: value, f: '@' })));
      let count = 0;
      for (const row of spool.rows(page)) { await emit(JSON.parse(row.cells)); count += 1; }
      if (count !== page.rowCount) fail('BIZOP_OUTPUT_ROW_COUNT');
      await session.commitSheet(sheet);
    }
  });
}

module.exports = { writeExportWorkbook };
