'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const XLSX = require('xlsx');
const {
  assertBiff8ValueFormatsMatch,
  openToolboxBiff8Pass,
  projectOutputCell,
  toMatchValue
} = require('../../src/backend/toolbox-format');

test('真实 BIFF8 值层与样式 overlay 汇入统一 ToolboxRow 契约', async () => {
  const fixture = path.join(__dirname, '..', '..', 'assets', '外汇交割表.xls');
  const pass = await openToolboxBiff8Pass(fixture);
  try {
    assert.equal(pass.format, 'biff8');
    assert.equal(pass.sheets.length, 1);
    pass.overlay.sheets[0].defaultRow.customHeight = true;
    let firstMeaningful = null;
    let sheetMeta = null;
    const summary = pass.scanSheet(0, {
      onSheetMeta: (meta) => {
        sheetMeta = meta;
      },
      onRow: (row) => {
        if (!firstMeaningful && row.cells.some((cell) => toMatchValue(cell, 'xls-legacy') !== '')) {
          firstMeaningful = row;
        }
      }
    });
    assert.ok(firstMeaningful);
    assert.equal(sheetMeta.customHeight, true);
    assert.ok(summary.explicitCellCount > 0);
    const sourceCell = firstMeaningful.cells[0];
    assert.equal(sourceCell.effectiveStyleRef.sourceRegistryId, pass.sourceRegistryId);
    const style = pass.sourceRegistry.get(sourceCell.effectiveStyleRef.styleRef);
    assert.equal(typeof style.numFmt, 'string');
    assert.ok(style.font && style.fill && style.border && style.alignment);
  } finally {
    pass.close();
  }
});

test('BIFF8 pass 关闭后拒绝继续扫描', async () => {
  const fixture = path.join(__dirname, '..', '..', 'assets', '外汇交割表.xls');
  const pass = await openToolboxBiff8Pass(fixture);
  pass.close();
  assert.throws(() => pass.scanSheet(0), /已关闭/);
});

test('SheetJS 实际 BIFF8 的低位 id 60 自定义日期格式受物理 FORMAT 驱动，并按 Date1904 加 1462', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'toolbox-biff8-low-format-'));
  try {
    for (const date1904 of [false, true]) {
      const workbook = XLSX.utils.book_new();
      const worksheet = XLSX.utils.aoa_to_sheet([[1]]);
      worksheet.A1.z = 'yyyy-mm-dd hh:mm';
      XLSX.utils.book_append_sheet(workbook, worksheet, 'Data');
      workbook.Workbook = { WBProps: { date1904 } };
      const filePath = path.join(tempDir, `date-${date1904 ? 1904 : 1900}.xls`);
      XLSX.writeFile(workbook, filePath, { bookType: 'biff8', cellStyles: true });

      const pass = await openToolboxBiff8Pass(filePath);
      try {
        assert.ok(pass.overlay.recordDefinedNumberFormatIds.includes(60));
        assert.equal(
          pass.overlay.numberFormats.find((entry) => entry.id === 60).code,
          'yyyy-mm-dd hh:mm'
        );
        let outputCell = null;
        pass.scanSheet(0, {
          onRow(row) {
            if (row.cells[0]) outputCell = projectOutputCell(row.cells[0]);
          }
        });
        assert.ok(outputCell);
        assert.equal(outputCell.value, date1904 ? 1463 : 1);
        assert.equal(outputCell.numFmtOverride, null);
        const originalFormat = pass.workbook.Sheets.Data.A1.z;
        pass.workbook.Sheets.Data.A1.z = 'General';
        assert.throws(
          () => assertBiff8ValueFormatsMatch(pass.workbook, pass.overlay),
          (error) => error.code === 'BIFF8_VALUE_NUMFMT_MISMATCH'
        );
        pass.workbook.Sheets.Data.A1.z = originalFormat;
      } finally {
        pass.close();
      }
    }
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('无物理 FORMAT 的 locale canonical built-in id 14/37 不被值层逐字差异误拒', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'toolbox-biff8-builtins-'));
  const filePath = path.join(tempDir, 'builtins.xls');
  try {
    const workbook = XLSX.utils.book_new();
    const worksheet = XLSX.utils.aoa_to_sheet([[45000], [1234]]);
    worksheet.A1.z = 'm/d/yy';
    worksheet.A2.z = '#,##0 ;(#,##0)';
    XLSX.utils.book_append_sheet(workbook, worksheet, 'Data');
    XLSX.writeFile(workbook, filePath, { bookType: 'biff8', cellStyles: true });

    const pass = await openToolboxBiff8Pass(filePath);
    try {
      assert.equal(pass.overlay.recordDefinedNumberFormatIds.includes(14), false);
      assert.equal(pass.overlay.recordDefinedNumberFormatIds.includes(37), false);
      assert.doesNotThrow(() => pass.scanSheet(0));
    } finally {
      pass.close();
    }
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
