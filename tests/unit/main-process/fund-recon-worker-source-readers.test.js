'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const XLSX = require('xlsx');

const {
  ZHONGTAI_REFUND_ORDER_SIGNATURE
} = require('../../../src/constants/table-signatures');
const {
  FundReconSourceError,
  readRefundSource
} = require('../../../src/main-process/fund-recon-worker/source-readers');

function writeWorkbook(filePath, rows, sheetName = '退款订单') {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(rows), sheetName);
  XLSX.writeFile(workbook, filePath);
}

test('退款源读取能定位非首行/非首列的完整冻结表头并保持字段映射', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fund-recon-refund-reader-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, 'refund.xlsx');
  const headers = ZHONGTAI_REFUND_ORDER_SIGNATURE.expectedHeaders;
  const values = headers.map((header, index) => `${header}-${index + 1}`);
  writeWorkbook(filePath, [
    ['中台退款订单导出'],
    ['metadata-a', 'metadata-b', ...headers],
    ['ignored-a', 'ignored-b', ...values]
  ]);

  const result = readRefundSource({ filePath, sheetName: '退款订单' });
  assert.equal(result.filePath, filePath);
  assert.equal(result.fileName, 'refund.xlsx');
  assert.equal(result.rowCount, 1);
  assert.deepEqual(Object.keys(result.rows[0]), headers);
  assert.equal(result.rows[0]['流水号'], '流水号-1');
  assert.equal(result.rows[0]['退款标识'], `退款标识-${headers.length}`);
});

test('退款源缺失冻结表头时以稳定业务错误fail closed', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fund-recon-refund-reader-invalid-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, 'invalid.xlsx');
  writeWorkbook(filePath, [['流水号', '错误表头']], 'Sheet1');

  assert.throws(
    () => readRefundSource({ filePath, sheetName: 'Sheet1' }),
    (error) => error instanceof FundReconSourceError &&
      error.code === 'FUND_RECON_SOURCE_HEADER_MISMATCH'
  );
});
