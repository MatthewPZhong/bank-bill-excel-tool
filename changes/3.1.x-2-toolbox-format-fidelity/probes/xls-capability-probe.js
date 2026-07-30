'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const ExcelJS = require('exceljs');
const XLSX = require('xlsx');
const XLSXStyle = require('xlsx-js-style');

function compactCell(cell) {
  if (!cell) return null;
  return {
    t: cell.t,
    v: cell.v,
    w: cell.w,
    z: cell.z,
    f: cell.f,
    s: cell.s
  };
}

function hasBorder(style) {
  if (!style || typeof style !== 'object') return false;
  return Boolean(style.border || style.left || style.right || style.top || style.bottom);
}

function hasAlignment(style) {
  if (!style || typeof style !== 'object') return false;
  return Boolean(
    style.alignment
    || style.horizontal
    || style.vertical
    || style.wrapText
    || style.textRotation
    || style.indent
  );
}

function normalizeNumFmt(value) {
  return String(value || '').replace(/\\([ -/:-@[-`{-~])/g, '$1');
}

function inspectWorkbook(workbook) {
  const sheet = workbook.Sheets.Probe;
  assert.ok(sheet, '未读取到 Probe sheet');

  const observations = {
    workbookDate1904: Boolean(
      workbook.Workbook
      && workbook.Workbook.WBProps
      && workbook.Workbook.WBProps.date1904
    ),
    cells: {
      A1: compactCell(sheet.A1),
      A2: compactCell(sheet.A2),
      B2: compactCell(sheet.B2),
      C2: compactCell(sheet.C2),
      D2: compactCell(sheet.D2),
      E2: compactCell(sheet.E2)
    },
    rows: (sheet['!rows'] || []).slice(0, 2),
    cols: (sheet['!cols'] || []).slice(0, 5)
  };

  const required = {
    customNumFmt: sheet.A2 && normalizeNumFmt(sheet.A2.z) === '#,##0.00',
    textNumFmt: sheet.B2 && normalizeNumFmt(sheet.B2.z) === '@',
    dateNumFmt: sheet.C2 && normalizeNumFmt(sheet.C2.z) === 'yyyy-mm-dd hh:mm:ss',
    font: Boolean(sheet.A2 && sheet.A2.s && sheet.A2.s.font),
    fill: Boolean(sheet.A2 && sheet.A2.s && (sheet.A2.s.fill || sheet.A2.s.patternType)),
    border: Boolean(sheet.A2 && hasBorder(sheet.A2.s)),
    alignment: Boolean(sheet.A2 && hasAlignment(sheet.A2.s)),
    rowHeight: Boolean(sheet['!rows'] && sheet['!rows'][1] && sheet['!rows'][1].hpt),
    rowHidden: Boolean(sheet['!rows'] && sheet['!rows'][1] && sheet['!rows'][1].hidden),
    rowOutline: Boolean(
      sheet['!rows']
      && sheet['!rows'][1]
      && Number.isInteger(sheet['!rows'][1].level)
    ),
    columnWidth: Boolean(sheet['!cols'] && sheet['!cols'][0] && sheet['!cols'][0].width),
    columnHidden: Boolean(sheet['!cols'] && sheet['!cols'][1] && sheet['!cols'][1].hidden),
    columnOutline: Boolean(
      sheet['!cols']
      && sheet['!cols'][0]
      && Number.isInteger(sheet['!cols'][0].level)
    ),
    formulaAndCachedValue: Boolean(
      sheet.D2
      && sheet.D2.f === 'A2*2'
      && Number(sheet.D2.v) === 2469
    ),
    leadingZeroText: Boolean(
      sheet.B2
      && sheet.B2.t === 's'
      && sheet.B2.v === '001234567890123456789'
    )
  };
  const missing = Object.entries(required)
    .filter(([, supported]) => !supported)
    .map(([name]) => name);
  return { required, missing, observations };
}

async function createSourceFixture(filePath) {
  const workbook = new ExcelJS.Workbook();
  workbook.properties.date1904 = false;
  const sheet = workbook.addWorksheet('Probe', {
    properties: {
      defaultColWidth: 11,
      defaultRowHeight: 16
    }
  });

  sheet.getColumn(1).width = 18;
  sheet.getColumn(1).outlineLevel = 1;
  sheet.getColumn(2).width = 14;
  sheet.getColumn(2).hidden = true;
  sheet.getColumn(3).width = 20;

  const header = sheet.getRow(1);
  header.height = 23;
  header.values = ['Amount', 'Identifier', 'Date', 'Formula', 'Boolean'];
  header.eachCell((cell) => {
    cell.font = { name: 'Arial', size: 12, bold: true, color: { argb: 'FF112233' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFCCDDEE' } };
    cell.border = {
      left: { style: 'thin', color: { argb: 'FF445566' } },
      right: { style: 'thin', color: { argb: 'FF445566' } },
      top: { style: 'thin', color: { argb: 'FF445566' } },
      bottom: { style: 'thin', color: { argb: 'FF445566' } }
    };
    cell.alignment = {
      horizontal: 'center',
      vertical: 'middle',
      wrapText: true,
      textRotation: 15,
      indent: 1
    };
  });

  const row = sheet.getRow(2);
  row.height = 27;
  row.hidden = true;
  row.outlineLevel = 1;
  row.getCell(1).value = 1234.5;
  row.getCell(1).numFmt = '#,##0.00';
  row.getCell(1).font = {
    name: 'Courier New',
    size: 11,
    italic: true,
    underline: true,
    color: { argb: 'FFAA2200' }
  };
  row.getCell(1).fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FF00AA55' }
  };
  row.getCell(1).border = {
    left: { style: 'medium', color: { argb: 'FF123456' } },
    bottom: { style: 'dashed', color: { argb: 'FF654321' } }
  };
  row.getCell(1).alignment = {
    horizontal: 'right',
    vertical: 'bottom',
    wrapText: true,
    textRotation: 30,
    indent: 2
  };
  row.getCell(2).value = '001234567890123456789';
  row.getCell(2).numFmt = '@';
  row.getCell(3).value = new Date(Date.UTC(2026, 6, 29, 12, 34, 56));
  row.getCell(3).numFmt = 'yyyy-mm-dd hh:mm:ss';
  row.getCell(4).value = { formula: 'A2*2', result: 2469 };
  row.getCell(4).numFmt = '0.00';
  row.getCell(5).value = true;
  row.commit();

  await workbook.xlsx.writeFile(filePath);
}

async function main() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'toolbox-xls-probe-'));
  const sourceXlsx = path.join(tempDir, 'toolbox-xls-probe.xlsx');
  const expectedXls = path.join(tempDir, 'toolbox-xls-probe.xls');
  const userProfileDir = path.join(tempDir, 'libreoffice-profile');
  try {
    await createSourceFixture(sourceXlsx);
    fs.mkdirSync(userProfileDir, { recursive: true });
    const soffice = process.env.SOFFICE_BIN || 'soffice';
    const conversion = spawnSync(
      soffice,
      [
        `-env:UserInstallation=${pathToFileURL(userProfileDir).href}`,
        '--headless',
        '--convert-to',
        'xls:MS Excel 97',
        '--outdir',
        tempDir,
        sourceXlsx
      ],
      { encoding: 'utf8' }
    );
    assert.equal(
      conversion.status,
      0,
      `LibreOffice 转换失败：${conversion.stderr || conversion.stdout}`
    );
    assert.ok(fs.existsSync(expectedXls), '未生成 BIFF8 .xls fixture');

    const readOptions = {
      cellStyles: true,
      cellDates: false,
      raw: true,
      cellNF: true,
      cellText: true,
      sheetStubs: true
    };
    const parserResults = {
      xlsx: inspectWorkbook(XLSX.readFile(expectedXls, readOptions)),
      'xlsx-js-style': inspectWorkbook(XLSXStyle.readFile(expectedXls, readOptions))
    };
    const passingParsers = Object.entries(parserResults)
      .filter(([, result]) => result.missing.length === 0)
      .map(([name]) => name);
    process.stdout.write(`${JSON.stringify({ passingParsers, parserResults }, null, 2)}\n`);
    process.exitCode = passingParsers.length > 0 ? 0 : 2;
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`${error && error.stack ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
