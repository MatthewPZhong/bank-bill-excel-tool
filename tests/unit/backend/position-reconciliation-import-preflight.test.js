'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const XLSX = require('xlsx');

const {
  BANK_SHEET_NAME,
  POSITION_BANK_HEADERS,
  SOURCE_DEFINITIONS,
  SOURCE_DISPLAY_ORDER,
  SOURCE_TYPES
} = require('../../../src/main-process/position-reconciliation/constants');
const {
  stableHash,
  stableJson
} = require('../../../src/main-process/position-reconciliation/common');
const {
  readBankFiles,
  readSourceFile
} = require('../../../src/main-process/position-reconciliation/readers');
const {
  BANK_STATEMENT_FIELDS
} = require('../../../src/constants/bank-statement-fields');
const {
  POSITION_IMPORT_COMMANDS
} = require('../../../src/backend/position-reconciliation-import/constants');
const {
  PositionImportLedger,
  verifySealedLedger
} = require('../../../src/backend/position-reconciliation-import/ledger');
const {
  runPositionImportPreflight
} = require('../../../src/backend/position-reconciliation-import/preflight');
const {
  openPositionWorkbook,
  streamPositionXlsxRows
} = require('../../../src/backend/position-reconciliation-import/xlsx-reader');
const {
  streamPositionXlsRows
} = require('../../../src/backend/position-reconciliation-import/xls-reader');
const {
  dispatchPositionImportPreflight
} = require('../../../src/main-process/position-reconciliation/import-dispatch');
const {
  STAGING_RELATIVE_PATH,
  hashFileSha256Async,
  stageInputFilesAsync
} = require('../../../src/main-process/position-reconciliation/input-staging');

function tempDir(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeWorkbook(filePath, sheets, options = {}) {
  const workbook = XLSX.utils.book_new();
  for (const sheet of sheets) {
    const rows = [
      sheet.headers,
      ...(sheet.rows || []).map((row) => sheet.headers.map((header) => row[header] ?? ''))
    ];
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.aoa_to_sheet(rows),
      sheet.name
    );
  }
  if (options.date1904) {
    workbook.Workbook = { WBProps: { date1904: true } };
  }
  XLSX.writeFile(workbook, filePath, { bookSST: options.bookSST === true });
}

function sourceRows() {
  return {
    [SOURCE_TYPES.FUND_TRANSFER]: {
      调拨单号: 'FT-PRB-1',
      调拨状态: '付款成功',
      渠道流水号: 'FT-RID-1',
      交易时间: new Date(2026, 6, 20),
      '付款账户（卡号）': 'PAY-1',
      '收款账户（卡号）': 'REC-1',
      付款金额: 100,
      付款币种: 'USD',
      收款金额: 95,
      收款币种: 'EUR'
    },
    [SOURCE_TYPES.TEST_PAYMENT]: {
      付款单号: 'TEST-PRB-1',
      付款状态: '付款成功',
      渠道流水号: 'TEST-RID-1',
      源金额: 100,
      源币种: 'USD',
      目标金额: 95,
      目标币种: 'EUR',
      创建时间: new Date(2026, 6, 20)
    },
    [SOURCE_TYPES.GATEWAY_INBOUND]: {
      bizId: 'IN-PRB-1',
      billDate: new Date(2026, 6, 20),
      tradeType: 'Inbound-VA',
      reconId: 'IN-RID-1',
      channel: 'DBS',
      merchantId: 'M001',
      currency: 'USD',
      amount: 100,
      originOutboundCurrency: 'EUR'
    },
    [SOURCE_TYPES.GATEWAY_OUTBOUND]: {
      账单日期: new Date(2026, 6, 20),
      渠道名称: 'DBS',
      账户号: 'M001',
      交易类型: 'Outbound',
      主对账id: 'OUT-RID-1',
      业务单号: 'OUT-PRB-1',
      币种: 'USD',
      金额: 100,
      原始币种: 'EUR',
      原始金额: 95,
      银行扣款币种: 'USD'
    },
    [SOURCE_TYPES.BANK_ACCOUNT]: {
      账户状态: '正常',
      账户性质: '自有',
      币种: 'USD',
      银行账号: 'OWN-PRB-1'
    }
  };
}

function sourceFile(dir, sourceType, rows, name = `${sourceType}.xlsx`, options = {}) {
  const definition = SOURCE_DEFINITIONS[sourceType];
  const filePath = path.join(dir, name);
  writeWorkbook(filePath, [
    { name: '说明', headers: ['说明'], rows: [{ 说明: '忽略' }] },
    { name: `${definition.sourceName}-数据`, headers: definition.headers, rows }
  ], options);
  return filePath;
}

function bankRow(overrides = {}) {
  return {
    BizId: 'BANK-PRB-1',
    BillDate: new Date(2026, 6, 20),
    Channel: 'DBS',
    地区: 'HK',
    MerchantId: 'M001',
    Currency: 'USD',
    'Credit Amount': 100,
    'Debit Amount': 0,
    FundType: 'Inbound',
    ...overrides
  };
}

test.describe('v3.1.3 position streaming preflight', () => {
  test('五类来源的新 XLSX reader 与旧 SheetJS row/type/hash 等价', async (t) => {
    const dir = tempDir(t, 'position-prb-parity-');
    const rows = sourceRows();
    for (const sourceType of SOURCE_DISPLAY_ORDER) {
      const filePath = sourceFile(
        dir,
        sourceType,
        [rows[sourceType]],
        `${sourceType}.xlsx`,
        { bookSST: true }
      );
      const legacy = readSourceFile(filePath);
      const streamed = [];
      const summary = await streamPositionXlsxRows(filePath, {
        kind: 'source',
        sstTempRoot: path.join(dir, `sst-${sourceType}`),
        onRow: ({ row }) => streamed.push(row)
      });
      assert.equal(summary.sourceType, sourceType);
      assert.equal(summary.sheetName, `${SOURCE_DEFINITIONS[sourceType].sourceName}-数据`);
      assert.equal(stableJson(streamed), stableJson(legacy.records.map((record) => record.row)));
      assert.equal(stableHash(streamed), stableHash(legacy.records.map((record) => record.row)));
    }
  });

  test('1904 日期系统仍保持旧 SheetJS 的 Date 值与 hash', async (t) => {
    const dir = tempDir(t, 'position-prb-date1904-');
    const sourceType = SOURCE_TYPES.FUND_TRANSFER;
    const filePath = sourceFile(
      dir,
      sourceType,
      [sourceRows()[sourceType]],
      'date1904.xlsx',
      { bookSST: true, date1904: true }
    );
    const legacy = readSourceFile(filePath);
    const streamed = [];
    await streamPositionXlsxRows(filePath, {
      kind: 'source',
      sstTempRoot: path.join(dir, 'sst-date1904'),
      onRow: ({ row }) => streamed.push(row)
    });
    assert.equal(stableJson(streamed), stableJson(legacy.records.map((record) => record.row)));
    assert.equal(stableHash(streamed), stableHash(legacy.records.map((record) => record.row)));
  });

  test('银行 49 列逐行读取后投影出的 46 列与旧 reader 等价', async (t) => {
    const dir = tempDir(t, 'position-prb-bank-');
    const filePath = path.join(dir, 'bank-49.xlsx');
    const row = {
      命中明细: '旧审计',
      命中类型: '旧命中',
      匹配命中详情: '旧详情',
      ...bankRow()
    };
    writeWorkbook(filePath, [
      { name: '说明', headers: ['说明'], rows: [{ 说明: '忽略' }] },
      { name: BANK_SHEET_NAME, headers: POSITION_BANK_HEADERS, rows: [row] }
    ], { bookSST: true });
    const legacy = readBankFiles([filePath]);
    const streamed = [];
    await streamPositionXlsxRows(filePath, {
      kind: 'bank',
      sstTempRoot: path.join(dir, 'sst-bank'),
      onRow: ({ row: raw }) => {
        streamed.push(Object.fromEntries(
          BANK_STATEMENT_FIELDS.map((header) => [header, raw[header] ?? ''])
        ));
      }
    });
    assert.equal(stableJson(streamed), stableJson(legacy.records.map((record) => record.originalRow)));
  });

  test('公式缓存、布尔、错误、科学计数法、长文本 ID 与负零保持 SheetJS 值类型', async (t) => {
    const dir = tempDir(t, 'position-prb-cell-types-');
    const definition = SOURCE_DEFINITIONS[SOURCE_TYPES.GATEWAY_OUTBOUND];
    const filePath = path.join(dir, 'cell-types.xlsx');
    const workbook = XLSX.utils.book_new();
    const sheet = XLSX.utils.aoa_to_sheet([
      definition.headers,
      definition.headers.map(() => '')
    ]);
    const set = (header, cell) => {
      const columnIndex = definition.headers.indexOf(header);
      sheet[XLSX.utils.encode_cell({ r: 1, c: columnIndex })] = cell;
    };
    set('账单日期', { t: 'd', v: new Date(2026, 6, 20) });
    set('渠道名称', { t: 's', v: 'DBS' });
    set('账户号', { t: 's', v: 'M001' });
    set('交易类型', { t: 's', v: 'Outbound' });
    set('主对账id', { t: 'str', v: 'FORMULA-RID', f: '"FORMULA-RID"' });
    set('业务单号', { t: 's', v: '001234567890123456789' });
    set('币种', { t: 's', v: 'USD' });
    set('金额', { t: 'n', v: 1.25e8 });
    set('原始金额', { t: 'n', v: -0 });
    set('清算网络', { t: 'b', v: true });
    set('客户编号', { t: 'e', v: 0x07 });
    sheet['!ref'] = `A1:${XLSX.utils.encode_col(definition.headers.length - 1)}2`;
    XLSX.utils.book_append_sheet(workbook, sheet, '业务数据');
    XLSX.writeFile(workbook, filePath, { bookSST: true });

    const legacy = readSourceFile(filePath).records[0].row;
    let streamed = null;
    await streamPositionXlsxRows(filePath, {
      kind: 'source',
      sstTempRoot: path.join(dir, 'sst'),
      onRow: ({ row }) => { streamed = row; }
    });
    assert.equal(stableJson(streamed), stableJson(legacy));
    assert.equal(typeof streamed['金额'], 'number');
    assert.equal(streamed['清算网络'], true);
    assert.equal(streamed['客户编号'], '');
    assert.equal(streamed['业务单号'], '001234567890123456789');
    assert.equal(Object.is(streamed['原始金额'], -0), false);
  });

  test('SST 超过预算切到磁盘 provider，随机读取后 close 清理 spill', async (t) => {
    const dir = tempDir(t, 'position-prb-sst-');
    const filePath = sourceFile(
      dir,
      SOURCE_TYPES.GATEWAY_OUTBOUND,
      [sourceRows()[SOURCE_TYPES.GATEWAY_OUTBOUND]],
      'sst.xlsx',
      { bookSST: true }
    );
    const sstRoot = path.join(dir, 'forced-disk-sst');
    const workbook = await openPositionWorkbook(filePath, {
      sstTempRoot: sstRoot,
      sstMemoryBudgetBytes: 1,
      sstLruMaxEntries: 2
    });
    assert.equal(workbook.sharedStrings.mode, 'disk');
    assert.ok(workbook.sharedStrings.count > 10);
    assert.equal(typeof workbook.sharedStrings.get(0), 'string');
    assert.equal(typeof workbook.sharedStrings.get(workbook.sharedStrings.count - 1), 'string');
    assert.ok(fs.existsSync(path.join(sstRoot, 'sst.bin')));
    assert.ok(fs.existsSync(path.join(sstRoot, 'sst.idx')));
    await workbook.close();
    assert.equal(fs.existsSync(sstRoot), false);
  });

  test('ledger 文件 savepoint 回滚后不污染后序记录身份，并可封存和检出篡改', async (t) => {
    const dir = tempDir(t, 'position-prb-ledger-');
    const inputA = path.join(dir, 'a.xlsx');
    const inputB = path.join(dir, 'b.xlsx');
    fs.writeFileSync(inputA, 'a');
    fs.writeFileSync(inputB, 'b');
    const staged = await stageInputFilesAsync(dir, [inputA, inputB], 'ledger-job');
    const ledgerPath = path.join(dir, 'ledger.sqlite');
    const ledger = new PositionImportLedger({
      ledgerPath,
      jobId: 'ledger-job',
      kind: 'source'
    });
    staged.forEach((descriptor) => ledger.addFile(descriptor));

    ledger.beginFile(0);
    assert.equal(ledger.claimSourceRecord({
      sourceType: SOURCE_TYPES.GATEWAY_OUTBOUND,
      businessKey: 'KEY-1',
      rowHash: 'HASH-1',
      fileIndex: 0,
      rowNumber: 2
    }).status, 'accepted');
    ledger.rejectFile(0, Object.assign(new Error('invalid row'), {
      code: 'position-source-row-invalid'
    }));

    ledger.beginFile(1);
    assert.equal(ledger.claimSourceRecord({
      sourceType: SOURCE_TYPES.GATEWAY_OUTBOUND,
      businessKey: 'KEY-1',
      rowHash: 'HASH-1',
      fileIndex: 1,
      rowNumber: 2
    }).status, 'accepted');
    assert.equal(ledger.claimSourceRecord({
      sourceType: SOURCE_TYPES.GATEWAY_OUTBOUND,
      businessKey: 'KEY-1',
      rowHash: 'HASH-2',
      fileIndex: 1,
      rowNumber: 3
    }).status, 'accepted');
    ledger.acceptFile(1, {
      sourceType: SOURCE_TYPES.GATEWAY_OUTBOUND,
      sheetName: 'Sheet1',
      scannedNonBlankRows: 2,
      persistedCandidateRows: 2,
      visibleLinkRows: 2,
      contentHash: stableHash([{ key: 1 }, { key: 2 }])
    });

    const evidence = await ledger.seal();
    const verified = await verifySealedLedger(evidence);
    assert.equal(verified.manifest.files[0].preflightStatus, 'failed');
    assert.equal(verified.manifest.files[1].preflightStatus, 'accepted');
    verified.db.close();

    fs.appendFileSync(ledgerPath, 'x');
    await assert.rejects(
      () => verifySealedLedger(evidence),
      (error) => error.code === 'position-import-job-ledger-invalid'
    );
  });

  test('ledger 声明行数与身份表不一致时拒绝封存', async (t) => {
    const dir = tempDir(t, 'position-prb-count-mismatch-');
    const input = path.join(dir, 'source.xlsx');
    fs.writeFileSync(input, 'source');
    const [descriptor] = await stageInputFilesAsync(dir, [input], 'count-mismatch-job');
    const ledger = new PositionImportLedger({
      ledgerPath: path.join(dir, 'count-mismatch.sqlite'),
      jobId: 'count-mismatch-job',
      kind: 'source'
    });
    ledger.addFile(descriptor);
    ledger.beginFile(0);
    ledger.acceptFile(0, {
      sourceType: SOURCE_TYPES.GATEWAY_OUTBOUND,
      sheetName: 'Sheet1',
      scannedNonBlankRows: 1,
      persistedCandidateRows: 1
    });
    await assert.rejects(
      () => ledger.seal(),
      (error) => (
        error &&
        error.code === 'position-import-job-ledger-invalid' &&
        /来源记录计数不一致/.test(error.message)
      )
    );
    ledger.close();
  });

  test('source preflight 折叠完全重复行并保留同业务主键的不同内容', async (t) => {
    const dir = tempDir(t, 'position-prb-partial-');
    const row = sourceRows()[SOURCE_TYPES.GATEWAY_OUTBOUND];
    const first = sourceFile(dir, SOURCE_TYPES.GATEWAY_OUTBOUND, [row], 'first.xlsx');
    const second = sourceFile(dir, SOURCE_TYPES.GATEWAY_OUTBOUND, [row], 'second.xlsx');
    const third = sourceFile(dir, SOURCE_TYPES.GATEWAY_OUTBOUND, [{
      ...row,
      渠道名称: `${row.渠道名称}-OTHER`
    }], 'third.xlsx');
    const userDataDir = path.join(dir, 'user-data');
    const result = await runPositionImportPreflight({
      jobId: 'partial-job',
      kind: 'source',
      files: [first, second, third],
      userDataDir
    });
    assert.deepEqual(
      result.orderedFileResults.map((item) => [item.status, item.code || null]),
      [
        ['ok', null],
        ['ok', null],
        ['ok', null]
      ]
    );
    assert.equal(result.acceptedOrdinaryInputFiles.length, 3);
    assert.equal(result.ledgerEvidence.manifest.files[0].persistedCandidateRows, 1);
    assert.equal(result.ledgerEvidence.manifest.files[1].persistedCandidateRows, 0);
    assert.equal(result.ledgerEvidence.manifest.files[1].collapsedDuplicateRows, 1);
    assert.equal(result.ledgerEvidence.manifest.files[2].persistedCandidateRows, 1);
  });

  test('bank preflight 任一文件失败时整批回滚，scope 和已接受文件均不残留', async (t) => {
    const dir = tempDir(t, 'position-prb-bank-atomic-');
    const first = path.join(dir, 'bank-first.xlsx');
    const second = path.join(dir, 'bank-second.xlsx');
    writeWorkbook(first, [{
      name: BANK_SHEET_NAME,
      headers: BANK_STATEMENT_FIELDS,
      rows: [bankRow({ BizId: 'BANK-ATOMIC-1' })]
    }]);
    writeWorkbook(second, [{
      name: BANK_SHEET_NAME,
      headers: BANK_STATEMENT_FIELDS,
      rows: [bankRow({ BizId: 'BANK-ATOMIC-1' })]
    }]);
    const result = await runPositionImportPreflight({
      jobId: 'bank-atomic-job',
      kind: 'bank',
      files: [first, second],
      userDataDir: path.join(dir, 'user-data')
    });
    assert.equal(result.acceptedBankFiles.length, 0);
    assert.deepEqual(
      result.orderedFileResults.map((item) => item.status),
      ['failed', 'failed']
    );
    assert.deepEqual(
      result.ledgerEvidence.manifest.files.map((item) => item.preflightStatus),
      ['failed', 'failed']
    );
    assert.deepEqual(
      result.ledgerEvidence.manifest.files.map((item) => [
        item.scannedNonBlankRows,
        item.invalidRows
      ]),
      [[1, 0], [1, 1]]
    );
    assert.deepEqual(result.ledgerEvidence.manifest.bankScopes, []);
  });

  test('child utility dispatcher 只返回 manifest，不传完整行', async (t) => {
    const dir = tempDir(t, 'position-prb-dispatch-');
    const filePath = sourceFile(
      dir,
      SOURCE_TYPES.GATEWAY_OUTBOUND,
      [sourceRows()[SOURCE_TYPES.GATEWAY_OUTBOUND]],
      'dispatch.xlsx'
    );
    const progress = [];
    const job = dispatchPositionImportPreflight({
      engine: 'streaming',
      command: POSITION_IMPORT_COMMANDS.SOURCE_PREPARE_AND_APPLY,
      files: [filePath],
      userDataDir: path.join(dir, 'user-data'),
      onProgress: (event) => progress.push(event)
    });
    const result = await job.promise;
    assert.equal(result.orderedFileResults[0].status, 'ok');
    assert.equal(result.orderedFileResults[0].rowCount, 1);
    assert.ok(result.preflightReady);
    assert.equal(Object.prototype.hasOwnProperty.call(result.preflightReady, 'records'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(result, 'records'), false);
    assert.ok(progress.some((event) => event.stage === 'staging'));
  });

  test('默认 disabled 不启动 worker，.xls 主进程调用被拒绝', async () => {
    assert.throws(
      () => dispatchPositionImportPreflight({
        command: POSITION_IMPORT_COMMANDS.SOURCE_PREPARE_AND_APPLY,
        files: ['/tmp/noop.xls'],
        userDataDir: os.tmpdir()
      }),
      (error) => error.code === 'position-import-disabled'
    );
    await assert.rejects(
      () => streamPositionXlsRows('/tmp/noop.xls', { kind: 'source' }),
      (error) => error.code === 'position-import-parser-parity-unproven'
    );
  });

  test('预置取消标记时 staging 前终止，不生成 sealed ledger', async (t) => {
    const dir = tempDir(t, 'position-prb-cancel-');
    const filePath = sourceFile(
      dir,
      SOURCE_TYPES.GATEWAY_OUTBOUND,
      [sourceRows()[SOURCE_TYPES.GATEWAY_OUTBOUND]],
      'cancel.xlsx'
    );
    await assert.rejects(
      () => runPositionImportPreflight({
        jobId: 'cancel-job',
        kind: 'source',
        files: [filePath],
        userDataDir: path.join(dir, 'user-data'),
        cancelToken: { cancelled: true }
      }),
      (error) => error.code === 'position-import-cancelled'
    );
    assert.equal(
      fs.existsSync(path.join(
        dir,
        'user-data',
        'run-data',
        'position-reconciliation',
        'import-staging',
        'cancel-job',
        'job-ledger.sqlite'
      )),
      false
    );
  });

  test('非法 staging batchId 在创建或清理目录前被拒绝', async (t) => {
    const dir = tempDir(t, 'position-prb-invalid-batch-');
    const filePath = path.join(dir, 'source.xlsx');
    fs.writeFileSync(filePath, 'source');
    await assert.rejects(
      () => stageInputFilesAsync(dir, [filePath], '../outside'),
      (error) => error && error.code === 'position-import-job-ledger-invalid'
    );
    assert.equal(fs.existsSync(path.join(dir, 'outside')), false);
  });

  test('大文件复制过程中取消会删除未完成 staging', async (t) => {
    const dir = tempDir(t, 'position-prb-copy-cancel-');
    const filePath = path.join(dir, 'large.bin');
    fs.writeFileSync(filePath, Buffer.alloc(20 * 1024 * 1024, 0x5a));
    const userDataDir = path.join(dir, 'user-data');
    const cancelToken = { cancelled: false };
    await assert.rejects(
      () => stageInputFilesAsync(userDataDir, [filePath], 'copy-cancel-job', {
        cancelToken,
        onProgress() {
          cancelToken.cancelled = true;
        }
      }),
      (error) => error.code === 'position-import-cancelled'
    );
    assert.equal(
      fs.existsSync(path.join(
        userDataDir,
        STAGING_RELATIVE_PATH,
        'copy-cancel-job'
      )),
      false
    );
  });

  test('工作表扫描过程中取消保持 position-import-cancelled', async (t) => {
    const dir = tempDir(t, 'position-prb-scan-cancel-');
    const row = sourceRows()[SOURCE_TYPES.GATEWAY_OUTBOUND];
    const filePath = sourceFile(
      dir,
      SOURCE_TYPES.GATEWAY_OUTBOUND,
      [row, { ...row, 业务单号: 'OUT-PRB-2' }],
      'scan-cancel.xlsx'
    );
    const cancelToken = { cancelled: false };
    await assert.rejects(
      () => streamPositionXlsxRows(filePath, {
        kind: 'source',
        cancelToken,
        sstTempRoot: path.join(dir, 'sst-scan-cancel'),
        onRow() {
          cancelToken.cancelled = true;
        }
      }),
      (error) => error.code === 'position-import-cancelled'
    );
  });

  test('封存前后 ledger SHA 与 size 可重复验证', async (t) => {
    const dir = tempDir(t, 'position-prb-hash-');
    const filePath = sourceFile(
      dir,
      SOURCE_TYPES.GATEWAY_OUTBOUND,
      [sourceRows()[SOURCE_TYPES.GATEWAY_OUTBOUND]],
      'hash.xlsx'
    );
    const result = await runPositionImportPreflight({
      jobId: 'hash-job',
      kind: 'source',
      files: [filePath],
      userDataDir: path.join(dir, 'user-data')
    });
    const actual = await hashFileSha256Async(result.ledgerEvidence.ledgerPath);
    assert.equal(actual.sha256, result.ledgerEvidence.ledgerSha256);
    assert.equal(actual.sizeBytes, result.ledgerEvidence.ledgerSizeBytes);
  });
});
