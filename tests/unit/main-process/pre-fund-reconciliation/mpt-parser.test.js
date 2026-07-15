'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');

const {
  MAX_LINE_LENGTH,
  parseMptFile,
} = require('../../../../src/main-process/pre-fund-reconciliation/mpt-parser');
const {
  INBOUND_FIELDS,
  MPT_DELIMITER,
  OUTBOUND_FIELDS,
  SOURCE_TYPE_INBOUND,
  SOURCE_TYPE_OUTBOUND,
  normalizeDecimalString,
  parseMptFileName,
} = require('../../../../src/main-process/pre-fund-reconciliation/mpt-schema');

let tmpdir;
test.beforeEach(() => {
  tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'mpt-parser-test-'));
});
test.afterEach(() => {
  fs.rmSync(tmpdir, { recursive: true, force: true });
});

function valuesFor(fields, overrides) {
  return fields.map((field) => Object.prototype.hasOwnProperty.call(overrides, field) ? overrides[field] : '');
}

function inboundRow(overrides = {}) {
  return valuesFor(INBOUND_FIELDS, {
    batchNo: 'MPT_INBOUND_20260708',
    billDate: '2026-07-08',
    channel: 'CITI',
    entity: 'PPEU',
    merchantId: 'M-001',
    business: 'MPT',
    oppBu: 'SMB',
    tradeType: 'Inbound-VA',
    orderId: 'ORDER-IN-1',
    reconId: 'RECON-IN-1',
    billReconId: 'BILL-IN-1',
    currency: 'USD',
    originAmount: '1.00',
    fee: '0',
    amount: '1.00',
    payerName: '付款人',
    payerAccount: 'CARD-IN-1',
    valueDate: '2026-07-08',
    bookDate: '2026-07-08',
    created: '2026-07-08 01:02:03',
    tradeScope: 'INBOUND',
    realChannel: 'CITI-REAL',
    clearingNetwork: 'SWIFT',
    ...overrides,
  });
}

function outboundRow(overrides = {}) {
  return valuesFor(OUTBOUND_FIELDS, {
    batchNo: 'MPT_OUTBOUND_20260707',
    billDate: '2026-07-07',
    entity: 'PPUS',
    bizType: 'MPT',
    oppBu: 'SMB',
    tradeType: 'WITHDRAW',
    orderNo: 'ORDER-OUT-1',
    billReconId: 'BILL-OUT-1',
    reconId: 'RECON-OUT-1',
    name: '收款人',
    cardNo: 'CARD-OUT-1',
    originCurrency: 'USD',
    targetCurrency: 'USD',
    originAmount: '10.00',
    fee: '0',
    originNetAmount: '10.00',
    targetAmount: '10.00',
    createTime: '2026-07-07 01:02:03',
    finishTime: '2026-07-07 01:03:04',
    channel: 'CITI',
    merchantId: 'M-002',
    tradeScope: 'OUTBOUND',
    bankDebitCurrency: 'EUR',
    bankDebitAmount: '9.50',
    realChannel: 'CITI-REAL',
    clearingNetwork: 'SWIFT',
    ...overrides,
  });
}

function writeFixture({
  fileName,
  header,
  rows,
  gzip = fileName.endsWith('.gz'),
  bom = false,
}) {
  const text = `${bom ? '\uFEFF' : ''}${[header, ...rows].map((row) => row.join(MPT_DELIMITER)).join('\n')}\n`;
  const filePath = path.join(tmpdir, fileName);
  fs.writeFileSync(filePath, gzip ? zlib.gzipSync(Buffer.from(text, 'utf8')) : text);
  return filePath;
}

async function writeLargeGzipFixture({ fileName, header, row, rowCount }) {
  const filePath = path.join(tmpdir, fileName);
  const gzip = zlib.createGzip();
  const output = fs.createWriteStream(filePath);
  gzip.pipe(output);
  const finished = once(output, 'finish');
  gzip.write(`${header.join(MPT_DELIMITER)}\n`);
  const line = `${row.join(MPT_DELIMITER)}\n`;
  for (let index = 0; index < rowCount; index += 1) {
    if (!gzip.write(line)) await once(gzip, 'drain');
  }
  gzip.end();
  await finished;
  return filePath;
}

async function parseCollect(filePath, options = {}) {
  const rows = [];
  const batchSizes = [];
  const result = await parseMptFile(filePath, {
    batchSize: options.batchSize || 2,
    onRows(batch) {
      batchSizes.push(batch.length);
      rows.push(...batch);
    },
  });
  return { result, rows, batchSizes };
}

test.describe('文件身份与十进制字符串', () => {
  test('兼容账期/序号有下划线和无下划线，超长序号保持字符串', () => {
    const inbound = parseMptFileName('/x/MPT_INBOUND_GATEWAY_20260708_20260709063736676.gz');
    assert.equal(inbound.sourceType, SOURCE_TYPE_INBOUND);
    assert.equal(inbound.sourceFileSequence, '20260709063736676');
    assert.equal(inbound.monthKey, '2026-07');

    const outbound = parseMptFileName('/x/MPT_OUTBOUND_GATEWAY_2026070720260708062049405.gz');
    assert.equal(outbound.sourceType, SOURCE_TYPE_OUTBOUND);
    assert.equal(outbound.sourceFileSequence, '20260708062049405');
  });

  test('CHANNEL_OTHERS 明确拒绝并提示 3.0.16', () => {
    assert.throws(
      () => parseMptFileName('/x/MPT_CHANNEL_OTHERS_20260708_1.gz'),
      (error) => error.code === 'MPT_CHANNEL_OTHERS_UNSUPPORTED' && /3\.0\.16/.test(error.message)
    );
  });

  test('其它前缀明确拒绝', () => {
    assert.throws(
      () => parseMptFileName('/x/MPT_REVERSE_GATEWAY_20260708_1.gz'),
      (error) => error.code === 'MPT_FILE_NAME_INVALID'
    );
  });

  test('金额规范化不经浮点：等价小数归一、超长精度不丢失', () => {
    assert.equal(normalizeDecimalString('1'), '1');
    assert.equal(normalizeDecimalString('1.00'), '1');
    assert.equal(normalizeDecimalString('-001.230000'), '-1.23');
    assert.equal(normalizeDecimalString('12345678901234567890.12345678901234567890'), '12345678901234567890.1234567890123456789');
    assert.equal(normalizeDecimalString('1e3'), null);
  });
});

test.describe('txt/gz、BOM、首行形状识别与批量背压', () => {
  const cases = [
    ['INBOUND txt', 'MPT_INBOUND_GATEWAY_20260708_101.txt', ['20260708', 'MPT_INBOUND_20260708', '1'], inboundRow()],
    ['INBOUND gz+BOM', 'MPT_INBOUND_GATEWAY_20260708_102.gz', ['MPT_INBOUND_20260708', '1', '20260708'], inboundRow()],
    ['OUTBOUND txt', 'MPT_OUTBOUND_GATEWAY_20260707103.txt', ['1', '20260707', 'MPT_OUTBOUND_20260707'], outboundRow()],
    ['OUTBOUND gz', 'MPT_OUTBOUND_GATEWAY_20260707_104.gz', ['20260707', '1', 'MPT_OUTBOUND_20260707'], outboundRow()],
  ];

  for (const [label, fileName, header, row] of cases) {
    test(`${label} 成功`, async () => {
      const filePath = writeFixture({ fileName, header, rows: [row], bom: label.includes('BOM') });
      const { result, rows } = await parseCollect(filePath);
      assert.equal(result.parsedRowCount, 1);
      assert.equal(result.declaredRowCount, 1);
      assert.match(result.contentHash, /^[a-f0-9]{64}$/);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].sourceRowNumber, 2);
      assert.match(rows[0].fingerprint, /^[a-f0-9]{64}$/);
    });
  }

  test('按 batchSize 回调，不累计全文件对象', async () => {
    const rows = Array.from({ length: 5 }, (_, index) => inboundRow({ reconId: `R-${index}` }));
    const filePath = writeFixture({
      fileName: 'MPT_INBOUND_GATEWAY_20260708_105.txt',
      header: ['20260708', 'MPT_INBOUND_20260708', '5'],
      rows,
    });
    const parsed = await parseCollect(filePath, { batchSize: 2 });
    assert.deepEqual(parsed.batchSizes, [2, 2, 1]);
  });

  test('10 万行 gzip 按有界批次流式解析', async () => {
    const rowCount = 100_000;
    const batchSize = 1_000;
    const filePath = await writeLargeGzipFixture({
      fileName: 'MPT_INBOUND_GATEWAY_20260708_100000.gz',
      header: ['20260708', 'MPT_INBOUND_20260708', String(rowCount)],
      row: inboundRow(),
      rowCount,
    });
    let deliveredRows = 0;
    let batchCount = 0;
    let maxBatchSize = 0;

    const result = await parseMptFile(filePath, {
      batchSize,
      onRows(batch) {
        deliveredRows += batch.length;
        batchCount += 1;
        maxBatchSize = Math.max(maxBatchSize, batch.length);
      },
    });

    assert.equal(result.parsedRowCount, rowCount);
    assert.equal(deliveredRows, rowCount);
    assert.equal(batchCount, rowCount / batchSize);
    assert.equal(maxBatchSize, batchSize);
  });
});

test('OUTBOUND 币种/金额按 bankDebit -> target -> origin 完整对下沉，绝不交叉拼接', async () => {
  const rows = [
    outboundRow({ bankDebitCurrency: 'EUR', bankDebitAmount: '9.50', targetCurrency: 'USD', targetAmount: '10' }),
    outboundRow({ reconId: 'R-2', bankDebitCurrency: 'EUR', bankDebitAmount: '', targetCurrency: 'GBP', targetAmount: '8.00' }),
    outboundRow({ reconId: 'R-3', bankDebitCurrency: '', bankDebitAmount: '', targetCurrency: '', targetAmount: '', originCurrency: 'JPY', originAmount: '700.00' }),
  ];
  const filePath = writeFixture({
    fileName: 'MPT_OUTBOUND_GATEWAY_20260707106.gz',
    header: ['20260707', 'MPT_OUTBOUND_20260707', '3'],
    rows,
  });
  const parsed = await parseCollect(filePath);
  assert.deepEqual(parsed.rows.map((row) => [row.currency, row.amount]), [
    ['EUR', '9.5'],
    ['GBP', '8'],
    ['JPY', '700'],
  ]);
});

test.describe('强校验错误', () => {
  async function expectCode(filePath, code) {
    await assert.rejects(() => parseMptFile(filePath), (error) => error.code === code);
  }

  test('字段数错误', async () => {
    const filePath = writeFixture({
      fileName: 'MPT_INBOUND_GATEWAY_20260708_201.txt',
      header: ['20260708', 'MPT_INBOUND_20260708', '1'],
      rows: [inboundRow().slice(0, 32)],
    });
    await expectCode(filePath, 'MPT_ROW_FIELD_COUNT');
  });

  test('声明行数错误', async () => {
    const filePath = writeFixture({
      fileName: 'MPT_INBOUND_GATEWAY_20260708_202.txt',
      header: ['20260708', 'MPT_INBOUND_20260708', '2'],
      rows: [inboundRow()],
    });
    await expectCode(filePath, 'MPT_DECLARED_COUNT_MISMATCH');
  });

  test('十进制字段错误', async () => {
    const filePath = writeFixture({
      fileName: 'MPT_INBOUND_GATEWAY_20260708_203.txt',
      header: ['20260708', 'MPT_INBOUND_20260708', '1'],
      rows: [inboundRow({ amount: '1e3' })],
    });
    await expectCode(filePath, 'MPT_DECIMAL_INVALID');
  });

  test('日期错误', async () => {
    const filePath = writeFixture({
      fileName: 'MPT_INBOUND_GATEWAY_20260708_204.txt',
      header: ['20260708', 'MPT_INBOUND_20260708', '1'],
      rows: [inboundRow({ billDate: '2026-02-30' })],
    });
    await expectCode(filePath, 'MPT_ROW_DATE_MISMATCH');
  });

  test('首行日期与文件名不一致', async () => {
    const filePath = writeFixture({
      fileName: 'MPT_INBOUND_GATEWAY_20260708_2041.txt',
      header: ['20260709', 'MPT_INBOUND_20260709', '1'],
      rows: [inboundRow({ batchNo: 'MPT_INBOUND_20260709', billDate: '2026-07-09' })],
    });
    await expectCode(filePath, 'MPT_HEADER_IDENTITY_INVALID');
  });

  test('OUTBOUND 三层均无完整币种金额对', async () => {
    const filePath = writeFixture({
      fileName: 'MPT_OUTBOUND_GATEWAY_202607072042.txt',
      header: ['20260707', 'MPT_OUTBOUND_20260707', '1'],
      rows: [outboundRow({
        bankDebitCurrency: 'EUR', bankDebitAmount: '',
        targetCurrency: '', targetAmount: '8',
        originCurrency: 'USD', originAmount: '',
      })],
    });
    await expectCode(filePath, 'MPT_OUTBOUND_AMOUNT_PAIR_MISSING');
  });

  test('截断 gzip 原子报错', async () => {
    const filePath = writeFixture({
      fileName: 'MPT_OUTBOUND_GATEWAY_20260707205.gz',
      header: ['20260707', 'MPT_OUTBOUND_20260707', '1'],
      rows: [outboundRow()],
    });
    const original = fs.readFileSync(filePath);
    fs.writeFileSync(filePath, original.subarray(0, Math.floor(original.length / 2)));
    await expectCode(filePath, 'MPT_GZIP_INVALID');
  });

  test('非法 UTF-8 拒绝', async () => {
    const filePath = path.join(tmpdir, 'MPT_INBOUND_GATEWAY_20260708_206.txt');
    const header = Buffer.from(`20260708${MPT_DELIMITER}MPT_INBOUND_20260708${MPT_DELIMITER}1\n`, 'utf8');
    fs.writeFileSync(filePath, Buffer.concat([header, Buffer.from([0xff, 0xfe, 0xfd])]));
    await expectCode(filePath, 'MPT_UTF8_INVALID');
  });

  test('含换行符的超长明细行仍受单行安全上限拦截', async () => {
    const filePath = path.join(tmpdir, 'MPT_INBOUND_GATEWAY_20260708_207.txt');
    const header = `20260708${MPT_DELIMITER}MPT_INBOUND_20260708${MPT_DELIMITER}1\n`;
    fs.writeFileSync(filePath, `${header}${'x'.repeat(MAX_LINE_LENGTH + 1)}\n`, 'utf8');
    await expectCode(filePath, 'MPT_LINE_TOO_LONG');
  });
});
