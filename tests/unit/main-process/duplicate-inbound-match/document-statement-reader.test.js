'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const JSZip = require('jszip');
const XLSX = require('xlsx');

const { BILL_HEADERS } = require('../../../../src/backend/acquiring-bill-currency-db/columns');
const {
  readXlsxSheetNames,
  streamDocumentStatement
} = require('../../../../src/main-process/duplicate-inbound-match/document-statement-reader');

function documentRow(values = {}) {
  return BILL_HEADERS.map((header) => values[header] ?? '');
}

function writeWorkbook(filePath, headers, rows) {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.aoa_to_sheet([headers, ...rows]),
    '单据对账单'
  );
  XLSX.writeFile(workbook, filePath);
}

async function swapWorkbookSheetOrder(filePath) {
  const zip = await JSZip.loadAsync(fs.readFileSync(filePath));
  const workbookXml = await zip.file('xl/workbook.xml').async('string');
  const sheetTags = workbookXml.match(/<sheet\b[^>]*\/>/g) || [];
  assert.equal(sheetTags.length, 2);
  const firstIndex = workbookXml.indexOf(sheetTags[0]);
  const secondIndex = workbookXml.indexOf(sheetTags[1], firstIndex + sheetTags[0].length);
  const swapped = workbookXml.slice(0, firstIndex)
    + sheetTags[1]
    + workbookXml.slice(firstIndex + sheetTags[0].length, secondIndex)
    + sheetTags[0]
    + workbookXml.slice(secondIndex + sheetTags[1].length);
  zip.file('xl/workbook.xml', swapped);
  fs.writeFileSync(filePath, await zip.generateAsync({ type: 'nodebuffer' }));
}

test('单据读取器严格读取 26 列并流式返回匹配字段', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'duplicate-inbound-document-reader-'));
  try {
    const filePath = path.join(dir, 'document.xlsx');
    writeWorkbook(filePath, BILL_HEADERS.slice(), [
      documentRow({
        '业务订单号': '  ORDER-1  ',
        '用户编号': ' 0000123 ',
        '账户号': ' 0000456 ',
        '业务部门': ' BU-A '
      }),
      documentRow({
        '业务订单号': '',
        '用户编号': 'USER-2',
        '账户号': 'ACCOUNT-2',
        '业务部门': 'BU-B'
      })
    ]);

    assert.deepEqual(await readXlsxSheetNames(filePath), ['单据对账单']);
    const rows = [];
    const result = await streamDocumentStatement(filePath, {
      onRow: (row) => rows.push(row)
    });

    assert.deepEqual(result, {
      fileName: 'document.xlsx',
      rowCount: 2,
      matchableRowCount: 1,
      emptyBusinessOrderCount: 1
    });
    assert.deepEqual(rows, [
      {
        sourceOrdinal: 0,
        excelRowNumber: 2,
        businessOrderNo: '  ORDER-1  ',
        businessOrderKey: 'ORDER-1',
        userNo: ' 0000123 ',
        accountNo: ' 0000456 ',
        businessDepartment: ' BU-A '
      },
      {
        sourceOrdinal: 1,
        excelRowNumber: 3,
        businessOrderNo: '',
        businessOrderKey: '',
        userNo: 'USER-2',
        accountNo: 'ACCOUNT-2',
        businessDepartment: 'BU-B'
      }
    ]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('单据读取器拒绝列顺序不一致的文件', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'duplicate-inbound-document-reader-'));
  try {
    const filePath = path.join(dir, 'wrong.xlsx');
    const headers = BILL_HEADERS.slice();
    [headers[0], headers[1]] = [headers[1], headers[0]];
    writeWorkbook(filePath, headers, [documentRow({ '业务订单号': 'ORDER-1' })]);

    await assert.rejects(
      () => streamDocumentStatement(filePath),
      (error) => error.code === 'duplicate-inbound-document-header-mismatch'
        && error.detailLines.length === 2
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('单据读取器按 workbook relationship 读取逻辑第一工作表', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'duplicate-inbound-document-reader-'));
  try {
    const filePath = path.join(dir, 'reordered.xlsx');
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.aoa_to_sheet([['错误表头'], ['WRONG-SHEET']]),
      '错误页'
    );
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.aoa_to_sheet([
        BILL_HEADERS,
        documentRow({ '业务订单号': 'RIGHT-ORDER', '用户编号': 'RIGHT-USER' })
      ]),
      '单据对账单'
    );
    XLSX.writeFile(workbook, filePath);
    await swapWorkbookSheetOrder(filePath);

    assert.deepEqual(await readXlsxSheetNames(filePath), ['单据对账单', '错误页']);
    const rows = [];
    await streamDocumentStatement(filePath, { onRow: (row) => rows.push(row) });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].businessOrderKey, 'RIGHT-ORDER');
    assert.equal(rows[0].userNo, 'RIGHT-USER');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
