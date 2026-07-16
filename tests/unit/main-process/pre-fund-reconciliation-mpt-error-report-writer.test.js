'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const XLSX = require('xlsx');

const {
  META_HEADERS,
  RAW_LINE_CHUNK_SIZE,
  RAW_LINE_HEADER,
  writeMptErrorReport
} = require('../../../src/main-process/pre-fund-reconciliation/mpt-error-report-writer');
const { parseMptFile } = require('../../../src/main-process/pre-fund-reconciliation/mpt-parser');
const {
  INBOUND_FIELDS,
  MPT_DELIMITER,
  OUTBOUND_FIELDS,
  SOURCE_TYPE_INBOUND,
  SOURCE_TYPE_OUTBOUND
} = require('../../../src/main-process/pre-fund-reconciliation/mpt-schema');

let tmpdir;
test.beforeEach(() => {
  tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'pre-fund-mpt-error-report-'));
});
test.afterEach(() => {
  fs.rmSync(tmpdir, { recursive: true, force: true });
});

function valuesFor(fields, overrides) {
  return fields.map((field) => Object.prototype.hasOwnProperty.call(overrides, field) ? overrides[field] : '');
}

function inboundRow(overrides = {}) {
  return valuesFor(INBOUND_FIELDS, {
    batchNo: 'MPT_INBOUND_20260708', billDate: '2026-07-08', channel: 'CIT',
    merchantId: 'M-1', tradeType: 'Inbound-VA', orderId: 'O-I', reconId: 'R-I',
    currency: 'USD', originAmount: '10', fee: '0', amount: '10',
    valueDate: '2026-07-08', bookDate: '2026-07-08', created: '2026-07-08 01:02:03',
    tradeScope: 'INBOUND', ...overrides
  });
}

function outboundRow(overrides = {}) {
  return valuesFor(OUTBOUND_FIELDS, {
    batchNo: 'MPT_OUTBOUND_20260708', billDate: '2026-07-08', tradeType: 'WITHDRAW',
    orderNo: 'O-O', reconId: 'R-O', originCurrency: 'USD', targetCurrency: 'USD',
    originAmount: '10', fee: '0', originNetAmount: '10', targetAmount: '10',
    createTime: '2026-07-08 01:02:03', finishTime: '2026-07-08 01:03:04',
    channel: 'CIT', merchantId: 'M-2', tradeScope: 'OUTBOUND',
    bankDebitCurrency: 'USD', bankDebitAmount: '10', ...overrides
  });
}

function writeMpt(fileName, header, rows) {
  const filePath = path.join(tmpdir, fileName);
  fs.writeFileSync(
    filePath,
    `${[header, ...rows].map((row) => row.join(MPT_DELIMITER)).join('\n')}\n`,
    'utf8'
  );
  return filePath;
}

async function failureRecord(filePath, sourceType, failureId) {
  const parsed = await parseMptFile(filePath, { collectRowErrors: true });
  return {
    failureId,
    filePath,
    sourceType,
    contentHash: parsed.contentHash,
    rowErrorCount: parsed.rowErrorCount
  };
}

test('按 INBOUND/OUTBOUND 分 sheet 导出错误字段并无损分片超长原始行', async () => {
  const longName = 'A'.repeat(RAW_LINE_CHUNK_SIZE - 1) + '😀' + 'B'.repeat(100);
  const longInvalidAmount = `bad-${'9'.repeat(RAW_LINE_CHUNK_SIZE + 100)}`;
  const inbound = writeMpt(
    'MPT_INBOUND_GATEWAY_20260708_501.txt',
    ['20260708', 'MPT_INBOUND_20260708', '2'],
    [
      inboundRow({ reconId: 'VALID-I' }),
      inboundRow({ reconId: 'BAD-I', amount: longInvalidAmount, payerName: longName })
    ]
  );
  const outbound = writeMpt(
    'MPT_OUTBOUND_GATEWAY_20260708502.txt',
    ['20260708', 'MPT_OUTBOUND_20260708', '1'],
    [outboundRow({ bankDebitAmount: 'bad' })]
  );
  const records = [
    await failureRecord(inbound, SOURCE_TYPE_INBOUND, 'inbound-failure'),
    await failureRecord(outbound, SOURCE_TYPE_OUTBOUND, 'outbound-failure')
  ];
  const outputPath = path.join(tmpdir, 'errors.xlsx');
  const result = await writeMptErrorReport({ failureRecords: records, outputPath });

  assert.equal(result.errorRowCount, 2);
  assert.ok(result.outputRowCount > result.errorRowCount, '超长原始行应拆成多条输出行');
  assert.deepEqual(result.sheetNames, ['INBOUND错误数据', 'OUTBOUND错误数据']);
  const workbook = XLSX.readFile(outputPath, { raw: false });
  assert.deepEqual(workbook.SheetNames, result.sheetNames);
  const inboundRows = XLSX.utils.sheet_to_json(workbook.Sheets['INBOUND错误数据'], {
    header: 1,
    defval: '',
    raw: false
  });
  assert.deepEqual(inboundRows[0], [
    ...META_HEADERS,
    ...INBOUND_FIELDS,
    RAW_LINE_HEADER
  ]);
  const amountColumn = META_HEADERS.length + INBOUND_FIELDS.indexOf('amount');
  assert.ok(inboundRows[1][amountColumn].endsWith('...[字段已截断]'));
  assert.ok(inboundRows[1][amountColumn].length <= RAW_LINE_CHUNK_SIZE);
  const errorMessageColumn = META_HEADERS.indexOf('错误原因');
  assert.equal(inboundRows[1][errorMessageColumn], 'MPT 金额字段不是合法十进制字符串');
  assert.ok(inboundRows[1][errorMessageColumn].length <= RAW_LINE_CHUNK_SIZE);
  const rawColumn = inboundRows[0].indexOf(RAW_LINE_HEADER);
  const chunks = inboundRows.slice(1).map((row) => row[rawColumn]);
  assert.ok(chunks.every((chunk) => chunk.length <= RAW_LINE_CHUNK_SIZE));
  for (const chunk of chunks.slice(0, -1)) {
    const last = chunk.charCodeAt(chunk.length - 1);
    assert.ok(!(last >= 0xD800 && last <= 0xDBFF), '分片不得以高代理项结尾');
  }
  assert.equal(chunks.join(''), fs.readFileSync(inbound, 'utf8').trimEnd().split('\n')[2]);

  const outboundRows = XLSX.utils.sheet_to_json(workbook.Sheets['OUTBOUND错误数据'], {
    header: 1,
    defval: '',
    raw: false
  });
  assert.deepEqual(outboundRows[0], [...META_HEADERS, ...OUTBOUND_FIELDS, RAW_LINE_HEADER]);
  assert.equal(outboundRows[1][4], 'MPT_DECIMAL_INVALID');
});

test('源文件变化时拒绝导出且保留目标文件原内容', async () => {
  const source = writeMpt(
    'MPT_INBOUND_GATEWAY_20260708_503.txt',
    ['20260708', 'MPT_INBOUND_20260708', '1'],
    [inboundRow({ amount: 'bad' })]
  );
  const record = await failureRecord(source, SOURCE_TYPE_INBOUND, 'changed-source');
  fs.writeFileSync(source, fs.readFileSync(source, 'utf8').replace('bad', 'still-bad'), 'utf8');
  const outputPath = path.join(tmpdir, 'existing.xlsx');
  fs.writeFileSync(outputPath, 'keep-existing', 'utf8');

  await assert.rejects(
    () => writeMptErrorReport({ failureRecords: [record], outputPath }),
    (error) => error.code === 'MPT_REPAIR_SOURCE_CHANGED'
  );
  assert.equal(fs.readFileSync(outputPath, 'utf8'), 'keep-existing');
  assert.deepEqual(fs.readdirSync(tmpdir).filter((name) => name.includes('.tmp')), []);
});

test('错误数据超过单 sheet 行数上限时拒绝发布并保留目标文件', async () => {
  const source = writeMpt(
    'MPT_INBOUND_GATEWAY_20260708_504.txt',
    ['20260708', 'MPT_INBOUND_20260708', '1'],
    [inboundRow({ amount: `bad-${'9'.repeat(RAW_LINE_CHUNK_SIZE + 100)}` })]
  );
  const record = await failureRecord(source, SOURCE_TYPE_INBOUND, 'row-limit');
  const outputPath = path.join(tmpdir, 'existing.xlsx');
  fs.writeFileSync(outputPath, 'keep-existing', 'utf8');

  await assert.rejects(
    () => writeMptErrorReport({
      failureRecords: [record],
      outputPath,
      maxWorksheetRows: 2
    }),
    (error) => error.code === 'MPT_ERROR_REPORT_ROW_LIMIT'
  );
  assert.equal(fs.readFileSync(outputPath, 'utf8'), 'keep-existing');
  assert.deepEqual(fs.readdirSync(tmpdir).filter((name) => name.includes('.tmp')), []);
});
