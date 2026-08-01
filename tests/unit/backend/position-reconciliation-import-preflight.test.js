'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { EventEmitter } = require('node:events');
const { DatabaseSync } = require('node:sqlite');
const ExcelJS = require('exceljs');
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
  POSITION_IMPORT_COMMANDS,
  POSITION_IMPORT_MESSAGE_TYPES,
  POSITION_IMPORT_STREAMING_SOURCE_ALLOWLIST,
  normalizePositionStreamingSourceTypes
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
  cleanupUncommittedImportArtifacts,
  dispatchPositionImportPreflight,
  dispatchPositionLargeImportSchemaMigration,
  uncommittedJobRoot
} = require('../../../src/main-process/position-reconciliation/import-dispatch');
const {
  recoverPositionImportWorkerExit
} = require('../../../src/main-process/position-reconciliation/import-recovery');
const {
  createPositionReconciliationStore
} = require('../../../src/main-process/position-reconciliation/store');
const {
  assertPositionLargeImportSchema,
  positionLargeImportSchemaFingerprint
} = require('../../../src/main-process/position-reconciliation/large-import-schema');
const {
  readPositionDatabaseCheckpoint
} = require('../../../src/main-process/position-reconciliation/side-db-mutation');
const {
  STAGING_RELATIVE_PATH,
  hashFileSha256Async,
  stageInputFilesAsync
} = require('../../../src/main-process/position-reconciliation/input-staging');
const {
  assertPositionImportDiskSpace,
  estimatePositionImportDiskBytes
} = require('../../../src/backend/position-reconciliation-import/disk-space-gate');
const {
  initializeIncomingBankTables
} = require('../../../src/backend/position-reconciliation-import/bank-writer');

const tempDirs = [];
test.after(() => {
  for (const dir of tempDirs) {
    fs.rmSync(dir, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100
    });
  }
});

function tempDir(_t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
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
  test('PR-D 流式来源门禁固定开放四类普通来源', () => {
    assert.deepEqual(POSITION_IMPORT_STREAMING_SOURCE_ALLOWLIST, [
      SOURCE_TYPES.FUND_TRANSFER,
      SOURCE_TYPES.TEST_PAYMENT,
      SOURCE_TYPES.GATEWAY_INBOUND,
      SOURCE_TYPES.GATEWAY_OUTBOUND
    ]);
    assert.deepEqual(
      [...normalizePositionStreamingSourceTypes(undefined, { engine: 'streaming' })],
      [
        SOURCE_TYPES.FUND_TRANSFER,
        SOURCE_TYPES.TEST_PAYMENT,
        SOURCE_TYPES.GATEWAY_INBOUND,
        SOURCE_TYPES.GATEWAY_OUTBOUND
      ]
    );
    assert.deepEqual(
      [...normalizePositionStreamingSourceTypes(
        [
          SOURCE_TYPES.GATEWAY_INBOUND,
          SOURCE_TYPES.GATEWAY_OUTBOUND,
          SOURCE_TYPES.FUND_TRANSFER
        ].join(','),
        { engine: 'streaming' }
      )],
      [
        SOURCE_TYPES.GATEWAY_INBOUND,
        SOURCE_TYPES.GATEWAY_OUTBOUND,
        SOURCE_TYPES.FUND_TRANSFER
      ]
    );
    assert.deepEqual(
      [...normalizePositionStreamingSourceTypes(
        SOURCE_TYPES.GATEWAY_OUTBOUND,
        { engine: 'disabled' }
      )],
      []
    );
  });

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
      rowGuardHash: 'GUARD-1',
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
      rowGuardHash: 'GUARD-1',
      fileIndex: 1,
      rowNumber: 2
    }).status, 'accepted');
    assert.equal(ledger.claimSourceRecord({
      sourceType: SOURCE_TYPES.GATEWAY_OUTBOUND,
      businessKey: 'KEY-1',
      rowHash: 'HASH-2',
      rowGuardHash: 'GUARD-2',
      fileIndex: 1,
      rowNumber: 3
    }).status, 'accepted');
    assert.equal(ledger.claimSourceRecord({
      sourceType: SOURCE_TYPES.GATEWAY_OUTBOUND,
      businessKey: 'KEY-1',
      rowHash: 'HASH-1',
      rowGuardHash: 'GUARD-COLLISION',
      fileIndex: 1,
      rowNumber: 4
    }).status, 'hash-collision');
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

  test('普通来源等待授权时取消会清理已预检 staging 和 ledger', async (t) => {
    const dir = tempDir(t, 'position-prb-awaiting-cancel-');
    const userDataDir = path.join(dir, 'user-data');
    const filePath = sourceFile(
      dir,
      SOURCE_TYPES.GATEWAY_OUTBOUND,
      [sourceRows()[SOURCE_TYPES.GATEWAY_OUTBOUND]],
      'awaiting-cancel.xlsx'
    );
    let resolvePreflight;
    const preflightReady = new Promise((resolve) => {
      resolvePreflight = resolve;
    });
    const job = dispatchPositionImportPreflight({
      engine: 'streaming',
      command: POSITION_IMPORT_COMMANDS.SOURCE_PREPARE_AND_APPLY,
      files: [filePath],
      userDataDir,
      sideDbPath: path.join(dir, 'unused.sqlite'),
      authorizeApply: () => new Promise(() => {}),
      onPreflightReady: resolvePreflight
    });
    await preflightReady;
    assert.equal(job.cancel(), true);
    await assert.rejects(
      job.promise,
      (error) => error && error.code === 'position-import-cancelled'
    );
    assert.equal(
      fs.existsSync(path.join(userDataDir, STAGING_RELATIVE_PATH, job.jobId)),
      false
    );
  });

  test('普通来源 apply 授权失败会由 worker 清理预检产物', async (t) => {
    const dir = tempDir(t, 'position-prb-auth-reject-');
    const userDataDir = path.join(dir, 'user-data');
    const filePath = sourceFile(
      dir,
      SOURCE_TYPES.GATEWAY_OUTBOUND,
      [sourceRows()[SOURCE_TYPES.GATEWAY_OUTBOUND]],
      'auth-reject.xlsx'
    );
    const job = dispatchPositionImportPreflight({
      engine: 'streaming',
      command: POSITION_IMPORT_COMMANDS.SOURCE_PREPARE_AND_APPLY,
      files: [filePath],
      userDataDir,
      sideDbPath: path.join(dir, 'unused.sqlite'),
      authorizeApply: () => {
        const error = new Error('测试授权失败');
        error.code = 'position-import-intent-not-durable';
        throw error;
      }
    });
    await assert.rejects(
      job.promise,
      (error) => error
        && error.code === 'position-import-intent-not-durable'
        && error.message === '测试授权失败'
    );
    assert.equal(
      fs.existsSync(path.join(userDataDir, STAGING_RELATIVE_PATH, job.jobId)),
      false
    );
  });

  test('worker 在零提交时被强制终止会由 dispatcher 清理暂存批次', async (t) => {
    const dir = tempDir(t, 'position-prb-worker-kill-cleanup-');
    const userDataDir = path.join(dir, 'user-data');
    const filePath = sourceFile(
      dir,
      SOURCE_TYPES.GATEWAY_OUTBOUND,
      Array.from({ length: 5000 }, (_, index) => ({
        ...sourceRows()[SOURCE_TYPES.GATEWAY_OUTBOUND],
        主对账id: `KILL-RID-${index}`,
        业务单号: `KILL-ORDER-${index}`
      })),
      'worker-kill.xlsx'
    );
    let terminated = false;
    let job;
    job = dispatchPositionImportPreflight({
      engine: 'streaming',
      command: POSITION_IMPORT_COMMANDS.SOURCE_PREPARE_AND_APPLY,
      files: [filePath],
      userDataDir,
      sideDbPath: path.join(dir, 'unused.sqlite'),
      onProgress: (event) => {
        if (!terminated
            && event.stage === 'preflight'
            && Number(event.scannedRows) >= 4000) {
          terminated = true;
          job.terminate();
        }
      }
    });
    await assert.rejects(
      job.promise,
      (error) => error && error.code === 'position-import-worker-exited'
    );
    assert.equal(
      fs.existsSync(path.join(userDataDir, STAGING_RELATIVE_PATH, job.jobId)),
      false
    );
  });

  test('dispatcher 只接受 staging 根目录直属批次作为零提交清理目标', () => {
    const userDataDir = path.resolve('/tmp', 'position-cleanup-root');
    const jobRoot = path.join(userDataDir, STAGING_RELATIVE_PATH, 'safe-job');
    assert.equal(
      uncommittedJobRoot({ userDataDir }, 'other-job', {
        ledgerEvidence: { ledgerPath: path.join(jobRoot, 'job-ledger.sqlite') }
      }),
      jobRoot
    );
    assert.equal(
      uncommittedJobRoot({ userDataDir }, 'safe-job', {
        ledgerEvidence: {
          ledgerPath: path.join(userDataDir, 'outside', 'job-ledger.sqlite')
        }
      }),
      ''
    );
  });

  test('dispatcher 零提交清理保留归档重试仍引用的共享暂存批次', async (t) => {
    const dir = tempDir(t, 'position-cleanup-protected-');
    const userDataDir = path.join(dir, 'user-data');
    const jobId = 'shared-job';
    const jobRoot = path.join(userDataDir, STAGING_RELATIVE_PATH, jobId);
    const protectedFile = path.join(jobRoot, '0', 'source.xlsx');
    fs.mkdirSync(path.dirname(protectedFile), { recursive: true });
    fs.writeFileSync(protectedFile, 'protected');

    assert.equal(await cleanupUncommittedImportArtifacts({
      userDataDir,
      protectedStagingPaths: () => [protectedFile]
    }, jobId, null), false);
    assert.equal(fs.existsSync(jobRoot), true);

    assert.equal(await cleanupUncommittedImportArtifacts({
      userDataDir,
      protectedStagingPaths: () => []
    }, jobId, null), true);
    assert.equal(fs.existsSync(jobRoot), false);
  });

  test('dispatcher 拒绝重复预检授权并清理第一份预检目录', async (t) => {
    const dir = tempDir(t, 'position-duplicate-preflight-');
    const userDataDir = path.join(dir, 'user-data');
    const worker = new EventEmitter();
    const sentTypes = [];
    worker.postMessage = (message) => {
      sentTypes.push(message.type);
      if (message.type !== POSITION_IMPORT_MESSAGE_TYPES.START_JOB) return;
      const jobRoot = path.join(userDataDir, STAGING_RELATIVE_PATH, message.jobId);
      const ledgerPath = path.join(jobRoot, 'job-ledger.sqlite');
      fs.mkdirSync(jobRoot, { recursive: true });
      fs.writeFileSync(ledgerPath, 'sealed');
      const ready = {
        type: POSITION_IMPORT_MESSAGE_TYPES.PREFLIGHT_READY,
        jobId: message.jobId,
        archiveManifestHash: 'duplicate-manifest',
        ledgerEvidence: { ledgerPath }
      };
      setImmediate(() => {
        worker.emit('message', ready);
        worker.emit('message', { ...ready });
      });
    };
    worker.kill = () => true;
    const job = dispatchPositionImportPreflight({
      engine: 'streaming',
      command: POSITION_IMPORT_COMMANDS.SOURCE_PREPARE_AND_APPLY,
      files: [],
      userDataDir,
      sideDbPath: path.join(dir, 'unused.sqlite'),
      utilityProcess: { fork: () => worker },
      authorizeApply: () => new Promise(() => {})
    });
    await assert.rejects(
      job.promise,
      (error) => error && error.code === 'position-import-intent-not-durable'
    );
    assert.equal(
      fs.existsSync(path.join(userDataDir, STAGING_RELATIVE_PATH, job.jobId)),
      false
    );
    assert.equal(
      sentTypes.includes(POSITION_IMPORT_MESSAGE_TYPES.APPLY_GRANTED),
      false
    );
  });

  test('dispatcher 启动作业消息发送失败时终止 worker 并清理空任务目录', async (t) => {
    const dir = tempDir(t, 'position-start-send-failure-');
    const userDataDir = path.join(dir, 'user-data');
    const jobId = 'send-failure-job';
    const jobRoot = path.join(userDataDir, STAGING_RELATIVE_PATH, jobId);
    fs.mkdirSync(jobRoot, { recursive: true });
    let killCount = 0;
    const worker = new EventEmitter();
    worker.postMessage = () => {
      throw new Error('message channel closed');
    };
    worker.kill = () => {
      killCount += 1;
      return true;
    };
    const job = dispatchPositionImportPreflight({
      engine: 'streaming',
      command: POSITION_IMPORT_COMMANDS.BANK_PREPARE,
      jobId,
      files: [],
      userDataDir,
      sideDbPath: path.join(dir, 'unused.sqlite'),
      utilityProcess: { fork: () => worker }
    });
    await assert.rejects(job.promise, /message channel closed/);
    assert.equal(killCount, 1);
    assert.equal(fs.existsSync(jobRoot), false);
  });

  test('dispatcher 在 worker 同步提交期间发送不虚增计数的进度心跳', async () => {
    const worker = new EventEmitter();
    worker.postMessage = (message) => {
      if (message.type !== POSITION_IMPORT_MESSAGE_TYPES.START_JOB) return;
      setImmediate(() => worker.emit('message', {
        type: POSITION_IMPORT_MESSAGE_TYPES.PROGRESS,
        jobId: message.jobId,
        stage: 'committing',
        scannedRows: 3000000,
        acceptedRows: 3000000,
        committedRows: 3000000,
        elapsedMs: 100
      }));
      setTimeout(() => worker.emit('message', {
        type: POSITION_IMPORT_MESSAGE_TYPES.COMPLETE,
        jobId: message.jobId,
        result: { status: 'ok' }
      }), 45);
    };
    worker.kill = () => true;
    const progress = [];
    const job = dispatchPositionImportPreflight({
      engine: 'streaming',
      command: POSITION_IMPORT_COMMANDS.BANK_APPLY,
      files: [],
      userDataDir: '',
      sideDbPath: '',
      utilityProcess: { fork: () => worker },
      progressHeartbeatMs: 10,
      onProgress: (event) => progress.push(event)
    });
    const result = await job.promise;
    assert.equal(result.status, 'ok');
    assert.equal(progress[0].heartbeat, false);
    const heartbeats = progress.filter((event) => event.heartbeat === true);
    assert.ok(heartbeats.length >= 2);
    assert.ok(heartbeats.every((event) => (
      event.stage === 'committing'
      && event.scannedRows === 3000000
      && event.acceptedRows === 3000000
      && event.committedRows === 3000000
    )));
  });

  test('dispatcher 不把 worker 拒绝的提交阶段取消记为已确认取消', async () => {
    const worker = new EventEmitter();
    let startedJobId = '';
    let resolveCommitting;
    const committing = new Promise((resolve) => {
      resolveCommitting = resolve;
    });
    worker.postMessage = (message) => {
      if (message.type === POSITION_IMPORT_MESSAGE_TYPES.START_JOB) {
        startedJobId = message.jobId;
        setImmediate(() => worker.emit('message', {
          type: POSITION_IMPORT_MESSAGE_TYPES.PROGRESS,
          jobId: message.jobId,
          stage: 'committing',
          scannedRows: 1,
          acceptedRows: 1,
          committedRows: 1
        }));
        return;
      }
      if (message.type === POSITION_IMPORT_MESSAGE_TYPES.CANCEL) {
        setImmediate(() => {
          worker.emit('message', {
            type: POSITION_IMPORT_MESSAGE_TYPES.CANCEL_ACK,
            jobId: message.jobId,
            stage: 'committing',
            accepted: false
          });
          worker.emit('message', {
            type: POSITION_IMPORT_MESSAGE_TYPES.COMPLETE,
            jobId: message.jobId,
            result: { status: 'ok' }
          });
        });
      }
    };
    worker.kill = () => true;
    const cancelAcks = [];
    const job = dispatchPositionImportPreflight({
      engine: 'streaming',
      command: POSITION_IMPORT_COMMANDS.BANK_APPLY,
      files: [],
      userDataDir: '',
      sideDbPath: '',
      utilityProcess: { fork: () => worker },
      onProgress: (event) => {
        if (event.stage === 'committing') resolveCommitting();
      },
      onCancelAck: (event) => cancelAcks.push(event)
    });
    await committing;
    assert.ok(startedJobId);
    assert.equal(job.cancel(), true);
    const result = await job.promise;
    assert.equal(result.status, 'ok');
    assert.equal(result.cancelAcknowledged, false);
    assert.equal(cancelAcks.length, 1);
    assert.equal(cancelAcks[0].accepted, false);
  });

  test('schema-only utility job 原子建立现代来源身份且不推进 checkpoint', async (t) => {
    const dir = tempDir(t, 'position-prc1-schema-dispatch-');
    const checkpoint = {
      identity: 'schema-dispatch-identity',
      generation: 0,
      token: 'schema-dispatch-token'
    };
    let store = createPositionReconciliationStore(dir, {
      initialCheckpoint: checkpoint
    });
    const sideDbPath = store.dbPath;
    store.close();

    const job = dispatchPositionLargeImportSchemaMigration({
      engine: 'streaming',
      userDataDir: dir,
      sideDbPath,
      expectedCheckpoint: checkpoint
    });
    const result = await job.promise;
    assert.equal(result.migrated, true);
    assert.deepEqual(result.checkpoint, checkpoint);

    store = createPositionReconciliationStore(dir, {
      expectedCheckpoint: checkpoint
    });
    t.after(() => store.close());
    assertPositionLargeImportSchema(store.db);
    assert.deepEqual(store.persistenceCheckpoint(), checkpoint);
  });

  test('worker 在 PREFLIGHT_READY 后验证 grant 的 manifest、schema 和 checkpoint', async (t) => {
    const dir = tempDir(t, 'position-prc1-apply-grant-');
    const checkpoint = {
      identity: 'apply-grant-identity',
      generation: 0,
      token: 'apply-grant-token'
    };
    const store = createPositionReconciliationStore(dir, {
      initialCheckpoint: checkpoint
    });
    const sideDbPath = store.dbPath;
    store.close();
    const schemaResult = await dispatchPositionLargeImportSchemaMigration({
      engine: 'streaming',
      userDataDir: dir,
      sideDbPath,
      expectedCheckpoint: checkpoint
    }).promise;
    const filePath = sourceFile(
      dir,
      SOURCE_TYPES.GATEWAY_OUTBOUND,
      [sourceRows()[SOURCE_TYPES.GATEWAY_OUTBOUND]],
      'apply-grant.xlsx'
    );
    let authorizedManifest = '';
    const result = await dispatchPositionImportPreflight({
      engine: 'streaming',
      command: POSITION_IMPORT_COMMANDS.SOURCE_PREPARE_AND_APPLY,
      files: [filePath],
      userDataDir: path.join(dir, 'worker-user-data'),
      sideDbPath,
      authorizeApply: (ready) => {
        authorizedManifest = ready.archiveManifestHash;
        return {
          operationToken: 'apply-grant-operation',
          archiveManifestHash: ready.archiveManifestHash,
          schemaFingerprint: schemaResult.fingerprint,
          baseCheckpoint: checkpoint
        };
      }
    }).promise;
    assert.equal(result.status, undefined);
    assert.equal(result.orderedFileResults[0].status, 'ok');
    assert.equal(result.archiveManifestHash, authorizedManifest);
  });

  test('gateway-outbound 生产 writer 保留同主键不同内容并折叠完全重复', async (t) => {
    const dir = tempDir(t, 'position-prc2-source-writer-');
    const checkpoint = {
      identity: 'source-writer-identity',
      generation: 0,
      token: 'source-writer-token'
    };
    let store = createPositionReconciliationStore(dir, {
      initialCheckpoint: checkpoint
    });
    const sideDbPath = store.dbPath;
    store.close();
    const schemaResult = await dispatchPositionLargeImportSchemaMigration({
      engine: 'streaming',
      userDataDir: dir,
      sideDbPath,
      expectedCheckpoint: checkpoint
    }).promise;

    const row = sourceRows()[SOURCE_TYPES.GATEWAY_OUTBOUND];
    const changed = {
      ...row,
      渠道名称: 'Yeepay'
    };
    const first = sourceFile(
      dir,
      SOURCE_TYPES.GATEWAY_OUTBOUND,
      [row, changed],
      'writer-first.xlsx'
    );
    const duplicate = sourceFile(
      dir,
      SOURCE_TYPES.GATEWAY_OUTBOUND,
      [row],
      'writer-duplicate.xlsx'
    );
    const committedFiles = [];
    const result = await dispatchPositionImportPreflight({
      engine: 'streaming',
      command: POSITION_IMPORT_COMMANDS.SOURCE_PREPARE_AND_APPLY,
      files: [first, duplicate],
      userDataDir: path.join(dir, 'worker-user-data'),
      sideDbPath,
      featureFlags: {
        preflightOnly: false,
        streamingSourceTypes: [SOURCE_TYPES.GATEWAY_OUTBOUND]
      },
      authorizeApply: (ready) => ({
        operationToken: 'source-writer-operation',
        archiveManifestHash: ready.archiveManifestHash,
        schemaFingerprint: schemaResult.fingerprint,
        baseCheckpoint: checkpoint
      }),
      onFileCommitted: (event) => committedFiles.push(event)
    }).promise;
    assert.equal(result.status, 'ok');
    assert.equal(result.successCount, 2);
    assert.equal(result.failedCount, 0);
    assert.deepEqual(
      result.results.map((item) => [
        item.rowCount,
        item.collapsedDuplicateCount
      ]),
      [[2, 0], [0, 1]]
    );
    assert.deepEqual(
      committedFiles.map((item) => item.committedRows),
      [2, 0]
    );

    let db = new DatabaseSync(sideDbPath, { readOnly: true });
    assertPositionLargeImportSchema(db);
    assert.equal(positionLargeImportSchemaFingerprint(db), schemaResult.fingerprint);
    assert.equal(
      db.prepare('SELECT COUNT(*) AS count FROM position_source_rows').get().count,
      2
    );
    assert.equal(
      db.prepare(`
        SELECT COUNT(DISTINCT business_key) AS count
        FROM position_source_rows
      `).get().count,
      1
    );
    assert.equal(
      db.prepare('SELECT COUNT(DISTINCT row_hash) AS count FROM position_source_rows').get().count,
      2
    );
    assert.equal(
      db.prepare(`
        SELECT COUNT(DISTINCT source_record_key) AS count
        FROM position_link_rows
      `).get().count,
      2
    );
    assert.equal(
      db.prepare(`
        SELECT COUNT(*) AS count
        FROM position_operation_inputs
        WHERE operation_token = 'source-writer-operation'
      `).get().count,
      2
    );
    const currentCheckpoint = readPositionDatabaseCheckpoint(db);
    assert.equal(currentCheckpoint.generation, 2);
    db.close();

    const repeated = sourceFile(
      dir,
      SOURCE_TYPES.GATEWAY_OUTBOUND,
      [row],
      'writer-independent-repeat.xlsx'
    );
    const repeatedResult = await dispatchPositionImportPreflight({
      engine: 'streaming',
      command: POSITION_IMPORT_COMMANDS.SOURCE_PREPARE_AND_APPLY,
      files: [repeated],
      userDataDir: path.join(dir, 'worker-user-data-repeat'),
      sideDbPath,
      featureFlags: {
        preflightOnly: false,
        streamingSourceTypes: [SOURCE_TYPES.GATEWAY_OUTBOUND]
      },
      authorizeApply: (ready) => ({
        operationToken: 'source-writer-repeat-operation',
        archiveManifestHash: ready.archiveManifestHash,
        schemaFingerprint: schemaResult.fingerprint,
        baseCheckpoint: currentCheckpoint
      })
    }).promise;
    assert.equal(repeatedResult.successCount, 1);
    assert.equal(repeatedResult.results[0].rowCount, 1);

    db = new DatabaseSync(sideDbPath, { readOnly: true });
    t.after(() => db.close());
    assert.equal(
      db.prepare('SELECT COUNT(*) AS count FROM position_source_rows').get().count,
      2
    );
    assert.equal(
      db.prepare('SELECT COUNT(*) AS count FROM position_link_rows').get().count,
      2
    );
    assert.equal(
      db.prepare(`
        SELECT COUNT(*) AS count
        FROM position_source_rows
        WHERE source_file_name = 'writer-independent-repeat.xlsx'
      `).get().count,
      1
    );
    assert.equal(readPositionDatabaseCheckpoint(db).generation, 3);
  });

  test('四类普通来源流式 writer 保持 0/hidden/visible/双腿派生语义', async (t) => {
    const dir = tempDir(t, 'position-prd-source-writers-');
    const checkpoint = {
      identity: 'source-writers-identity',
      generation: 0,
      token: 'source-writers-token'
    };
    const store = createPositionReconciliationStore(dir, {
      initialCheckpoint: checkpoint
    });
    const sideDbPath = store.dbPath;
    store.close();
    const schemaResult = await dispatchPositionLargeImportSchemaMigration({
      engine: 'streaming',
      userDataDir: dir,
      sideDbPath,
      expectedCheckpoint: checkpoint
    }).promise;
    const base = sourceRows();
    const files = [
      sourceFile(dir, SOURCE_TYPES.FUND_TRANSFER, [
        base[SOURCE_TYPES.FUND_TRANSFER],
        {
          ...base[SOURCE_TYPES.FUND_TRANSFER],
          调拨单号: 'FT-PRD-HIDDEN',
          渠道流水号: 'FT-RID-HIDDEN',
          收款金额: 100,
          收款币种: 'USD'
        }
      ], 'prd-fund-transfer.xlsx'),
      sourceFile(dir, SOURCE_TYPES.TEST_PAYMENT, [
        base[SOURCE_TYPES.TEST_PAYMENT],
        {
          ...base[SOURCE_TYPES.TEST_PAYMENT],
          付款单号: 'TEST-PRD-ZERO',
          渠道流水号: 'TEST-RID-ZERO',
          源金额: 0
        }
      ], 'prd-test-payment.xlsx'),
      sourceFile(dir, SOURCE_TYPES.GATEWAY_INBOUND, [
        base[SOURCE_TYPES.GATEWAY_INBOUND],
        {
          ...base[SOURCE_TYPES.GATEWAY_INBOUND],
          bizId: 'IN-PRD-HIDDEN',
          reconId: 'IN-RID-HIDDEN',
          originOutboundCurrency: 'USD'
        },
        {
          ...base[SOURCE_TYPES.GATEWAY_INBOUND],
          bizId: 'IN-PRD-ZERO',
          reconId: 'IN-RID-ZERO',
          tradeType: 'Unsupported'
        }
      ], 'prd-gateway-inbound.xlsx'),
      sourceFile(
        dir,
        SOURCE_TYPES.GATEWAY_OUTBOUND,
        [base[SOURCE_TYPES.GATEWAY_OUTBOUND]],
        'prd-gateway-outbound.xlsx'
      )
    ];

    const result = await dispatchPositionImportPreflight({
      engine: 'streaming',
      command: POSITION_IMPORT_COMMANDS.SOURCE_PREPARE_AND_APPLY,
      files,
      userDataDir: path.join(dir, 'worker-user-data'),
      sideDbPath,
      featureFlags: {
        preflightOnly: false,
        streamingSourceTypes: [...POSITION_IMPORT_STREAMING_SOURCE_ALLOWLIST]
      },
      authorizeApply: (ready) => ({
        operationToken: 'source-writers-operation',
        archiveManifestHash: ready.archiveManifestHash,
        schemaFingerprint: schemaResult.fingerprint,
        baseCheckpoint: checkpoint
      })
    }).promise;
    assert.equal(result.status, 'ok');
    assert.equal(result.successCount, 4);
    assert.deepEqual(result.cleanupPaths, [
      path.dirname(result.ledgerEvidence.ledgerPath)
    ]);
    assert.deepEqual(
      result.results.map((item) => [item.sourceType, item.rowCount]),
      [
        [SOURCE_TYPES.FUND_TRANSFER, 2],
        [SOURCE_TYPES.TEST_PAYMENT, 2],
        [SOURCE_TYPES.GATEWAY_INBOUND, 3],
        [SOURCE_TYPES.GATEWAY_OUTBOUND, 1]
      ]
    );

    const db = new DatabaseSync(sideDbPath, { readOnly: true });
    t.after(() => db.close());
    assert.deepEqual(
      db.prepare(`
        SELECT source_type AS sourceType, COUNT(*) AS rowCount
        FROM position_source_rows
        GROUP BY source_type
        ORDER BY source_type
      `).all().map((row) => ({ ...row })),
      [
        { sourceType: SOURCE_TYPES.FUND_TRANSFER, rowCount: 2 },
        { sourceType: SOURCE_TYPES.GATEWAY_INBOUND, rowCount: 3 },
        { sourceType: SOURCE_TYPES.GATEWAY_OUTBOUND, rowCount: 1 },
        { sourceType: SOURCE_TYPES.TEST_PAYMENT, rowCount: 2 }
      ]
    );
    assert.deepEqual(
      db.prepare(`
        SELECT source_type AS sourceType,
               SUM(CASE WHEN visible = 1 THEN 1 ELSE 0 END) AS visibleCount,
               SUM(CASE WHEN visible = 0 THEN 1 ELSE 0 END) AS hiddenCount
        FROM position_link_rows
        GROUP BY source_type
        ORDER BY source_type
      `).all().map((row) => ({ ...row })),
      [
        { sourceType: SOURCE_TYPES.FUND_TRANSFER, visibleCount: 2, hiddenCount: 2 },
        { sourceType: SOURCE_TYPES.GATEWAY_INBOUND, visibleCount: 1, hiddenCount: 1 },
        { sourceType: SOURCE_TYPES.GATEWAY_OUTBOUND, visibleCount: 1, hiddenCount: 0 },
        { sourceType: SOURCE_TYPES.TEST_PAYMENT, visibleCount: 1, hiddenCount: 0 }
      ]
    );
    assert.equal(readPositionDatabaseCheckpoint(db).generation, 4);
  });

  test('账户快照单独预检只生成确认 descriptor，不在 prepare 阶段写库', async (t) => {
    const dir = tempDir(t, 'position-prc2-source-allowlist-');
    const checkpoint = {
      identity: 'source-allowlist-identity',
      generation: 0,
      token: 'source-allowlist-token'
    };
    const store = createPositionReconciliationStore(dir, {
      initialCheckpoint: checkpoint
    });
    const sideDbPath = store.dbPath;
    store.close();
    const account = sourceFile(
      dir,
      SOURCE_TYPES.BANK_ACCOUNT,
      [sourceRows()[SOURCE_TYPES.BANK_ACCOUNT]],
      'blocked-account.xlsx'
    );

    const result = await dispatchPositionImportPreflight({
      engine: 'streaming',
      command: POSITION_IMPORT_COMMANDS.SOURCE_PREPARE_AND_APPLY,
      files: [account],
      userDataDir: path.join(dir, 'worker-user-data'),
      sideDbPath,
      featureFlags: {
        preflightOnly: false,
        streamingSourceTypes: [...POSITION_IMPORT_STREAMING_SOURCE_ALLOWLIST]
      },
      authorizeApply: (ready) => ({
        preflightOnly: true,
        archiveManifestHash: ready.archiveManifestHash
      })
    }).promise;
    assert.equal(result.accountConfirmationDescriptor.status, 'needs-confirmation');
    assert.equal(result.accountConfirmationDescriptor.rowCount, 1);

    const db = new DatabaseSync(sideDbPath, { readOnly: true });
    t.after(() => db.close());
    assert.equal(
      db.prepare('SELECT COUNT(*) AS count FROM position_source_rows').get().count,
      0
    );
    assert.equal(
      db.prepare('SELECT COUNT(*) AS count FROM position_operation_inputs').get().count,
      0
    );
    assert.deepEqual(readPositionDatabaseCheckpoint(db), checkpoint);
  });

  test('银行 prepare 不写库，确认后整批单事务替换并忽略 49 列审计字段', async (t) => {
    const dir = tempDir(t, 'position-pre-bank-writer-');
    const checkpoint = {
      identity: 'bank-writer-identity',
      generation: 0,
      token: 'bank-writer-token'
    };
    const store = createPositionReconciliationStore(dir, {
      initialCheckpoint: checkpoint
    });
    const sideDbPath = store.dbPath;
    store.close();
    const schema = await dispatchPositionLargeImportSchemaMigration({
      engine: 'streaming',
      userDataDir: dir,
      sideDbPath,
      expectedCheckpoint: checkpoint
    }).promise;
    const bankPath = path.join(dir, 'bank-49.xlsx');
    writeWorkbook(bankPath, [{
      name: BANK_SHEET_NAME,
      headers: POSITION_BANK_HEADERS,
      rows: [
        {
          ...bankRow(),
          命中明细: '不应入库',
          命中类型: '精准命中',
          匹配命中详情: '不应入库'
        },
        bankRow({
          BizId: 'BANK-PRB-2',
          // 本用例验证银行批次原子替换，不验证 SheetJS 在部分历史时区下写 Date
          // 产生的 Excel 纪元秒级余数；使用业务等价的纯日期文本避免月份边界受宿主时区影响。
          BillDate: '2026-08-01',
          Channel: 'JPM',
          Currency: 'EUR'
        })
      ]
    }]);
    const prepared = await dispatchPositionImportPreflight({
      engine: 'streaming',
      command: POSITION_IMPORT_COMMANDS.BANK_PREPARE,
      files: [bankPath],
      userDataDir: path.join(dir, 'bank-prepare'),
      sideDbPath
    }).promise;
    assert.equal(prepared.acceptedBankFiles.length, 1);
    let db = new DatabaseSync(sideDbPath, { readOnly: true });
    assert.equal(
      db.prepare('SELECT COUNT(*) AS count FROM position_bank_rows').get().count,
      0
    );
    db.close();

    const applied = await dispatchPositionImportPreflight({
      engine: 'streaming',
      command: POSITION_IMPORT_COMMANDS.BANK_APPLY,
      files: [],
      userDataDir: dir,
      sideDbPath,
      expectedCheckpoint: checkpoint,
      operationToken: 'bank-writer-operation',
      payload: {
        schemaFingerprint: schema.fingerprint,
        preflightReady: prepared
      },
      featureFlags: { importApply: true }
    }).promise;
    assert.equal(applied.rowCount, 2);
    assert.equal(applied.scopes.length, 2);
    assert.equal(applied.nextCheckpoint.generation, 1);

    db = new DatabaseSync(sideDbPath, { readOnly: true });
    t.after(() => db.close());
    const rows = db.prepare(`
      SELECT biz_id AS bizId, import_order AS importOrder,
             hit_summary AS hitSummary, hit_type AS hitType,
             match_detail AS matchDetail, original_json AS originalJson
      FROM position_bank_rows
      ORDER BY import_order
    `).all();
    assert.deepEqual(
      rows.map((row) => [row.bizId, row.importOrder]),
      [['BANK-PRB-1', 0], ['BANK-PRB-2', 1]]
    );
    assert.equal(rows[0].hitSummary, '');
    assert.equal(rows[0].hitType, '');
    assert.equal(rows[0].matchDetail, '');
    assert.equal(Object.keys(JSON.parse(rows[0].originalJson)).length, 46);
    assert.equal(
      db.prepare(`
        SELECT COUNT(*) AS count
        FROM position_operation_inputs
        WHERE operation_token = 'bank-writer-operation'
      `).get().count,
      1
    );
    assert.equal(readPositionDatabaseCheckpoint(db).generation, 1);
    const recovered = recoverPositionImportWorkerExit({
      sideDbPath,
      baseCheckpoint: checkpoint,
      operationToken: 'bank-writer-operation',
      preflightReady: prepared,
      workerError: new Error('worker exited after commit'),
      command: POSITION_IMPORT_COMMANDS.BANK_APPLY
    });
    assert.equal(recovered.recoveredFromWorkerExit, true);
    assert.equal(recovered.rowCount, 2);
    assert.deepEqual(recovered.fileScopes, [
      { fileIndex: 0, channel: 'DBS', monthKey: '2026-07' },
      { fileIndex: 0, channel: 'JPM', monthKey: '2026-08' }
    ]);

    const conflictPath = path.join(dir, 'bank-conflict.xlsx');
    writeWorkbook(conflictPath, [{
      name: BANK_SHEET_NAME,
      headers: BANK_STATEMENT_FIELDS,
      rows: [bankRow({
        BizId: 'BANK-PRB-1',
        Channel: 'CITI',
        BillDate: '2026-09-01'
      })]
    }]);
    const conflict = await dispatchPositionImportPreflight({
      engine: 'streaming',
      command: POSITION_IMPORT_COMMANDS.BANK_PREPARE,
      files: [conflictPath],
      userDataDir: path.join(dir, 'bank-conflict-prepare'),
      sideDbPath
    }).promise;
    await assert.rejects(
      dispatchPositionImportPreflight({
        engine: 'streaming',
        command: POSITION_IMPORT_COMMANDS.BANK_APPLY,
        files: [],
        userDataDir: dir,
        sideDbPath,
        expectedCheckpoint: applied.nextCheckpoint,
        operationToken: 'bank-conflict-operation',
        payload: {
          schemaFingerprint: schema.fingerprint,
          preflightReady: conflict
        },
        featureFlags: { importApply: true }
      }).promise,
      (error) => (
        error
        && error.code === 'position-bank-existing-bizid-conflict'
        && error.detailLines.some((line) => line.includes('BANK-PRB-1'))
      )
    );
    assert.equal(
      db.prepare('SELECT COUNT(*) AS count FROM position_bank_rows').get().count,
      2,
      '跨范围 BizId 冲突必须回滚整批银行替换'
    );
    assert.equal(readPositionDatabaseCheckpoint(db).generation, 1);

    const replacementPath = path.join(dir, 'bank-replacement.xlsx');
    writeWorkbook(replacementPath, [{
      name: BANK_SHEET_NAME,
      headers: BANK_STATEMENT_FIELDS,
      rows: [bankRow({ BizId: 'BANK-REPLACEMENT' })]
    }]);
    const replacement = await dispatchPositionImportPreflight({
      engine: 'streaming',
      command: POSITION_IMPORT_COMMANDS.BANK_PREPARE,
      files: [replacementPath],
      userDataDir: path.join(dir, 'bank-replacement-prepare'),
      sideDbPath
    }).promise;
    await assert.rejects(
      dispatchPositionImportPreflight({
        engine: 'streaming',
        command: POSITION_IMPORT_COMMANDS.BANK_APPLY,
        files: [],
        userDataDir: dir,
        sideDbPath,
        expectedCheckpoint: applied.nextCheckpoint,
        operationToken: 'bank-low-disk-operation',
        payload: {
          schemaFingerprint: schema.fingerprint,
          preflightReady: replacement
        },
        featureFlags: { importApply: true },
        contractOptions: { availableBytes: 0 }
      }).promise,
      (error) => error && error.code === 'position-import-disk-space-insufficient'
    );
    assert.equal(
      db.prepare('SELECT COUNT(*) AS count FROM position_bank_rows').get().count,
      2,
      '磁盘门禁必须在删除旧 scope 前生效'
    );
    assert.equal(readPositionDatabaseCheckpoint(db).generation, 1);
  });

  test('银行 apply 只复制 scope 聚合，不再复制全量 BizId 临时键表', () => {
    const db = new DatabaseSync(':memory:');
    const ledgerDb = new DatabaseSync(':memory:');
    try {
      ledgerDb.exec(`
        CREATE TABLE bank_seen_biz_ids(
          biz_id TEXT PRIMARY KEY,
          channel TEXT NOT NULL,
          month_key TEXT NOT NULL,
          first_file_index INTEGER NOT NULL,
          first_row_number INTEGER NOT NULL
        );
        CREATE TABLE bank_scopes(
          channel TEXT NOT NULL,
          month_key TEXT NOT NULL,
          row_count INTEGER NOT NULL,
          PRIMARY KEY(channel, month_key)
        );
        INSERT INTO bank_seen_biz_ids VALUES
          ('B-1', 'DBS', '2026-07', 0, 2),
          ('B-2', 'DBS', '2026-07', 0, 3),
          ('B-3', 'DBS', '2026-07', 0, 4);
        INSERT INTO bank_scopes VALUES ('DBS', '2026-07', 3);
      `);
      initializeIncomingBankTables(db, ledgerDb);
      assert.deepEqual(
        db.prepare(`
          SELECT channel, month_key AS monthKey, row_count AS rowCount
          FROM incoming_bank_scopes
        `).all().map((row) => ({ ...row })),
        [{ channel: 'DBS', monthKey: '2026-07', rowCount: 3 }]
      );
      assert.equal(
        db.prepare(`
          SELECT COUNT(*) AS count
          FROM sqlite_temp_master
          WHERE type = 'table' AND name = 'incoming_bank_keys'
        `).get().count,
        0
      );
    } finally {
      ledgerDb.close();
      db.close();
    }
  });

  test('普通来源与账户混选时普通来源先提交，账户确认后整表替换', async (t) => {
    const dir = tempDir(t, 'position-pre-account-writer-');
    const checkpoint = {
      identity: 'account-writer-identity',
      generation: 0,
      token: 'account-writer-token'
    };
    const store = createPositionReconciliationStore(dir, {
      initialCheckpoint: checkpoint
    });
    const sideDbPath = store.dbPath;
    store.close();
    const schema = await dispatchPositionLargeImportSchemaMigration({
      engine: 'streaming',
      userDataDir: dir,
      sideDbPath,
      expectedCheckpoint: checkpoint
    }).promise;
    const ordinary = sourceFile(
      dir,
      SOURCE_TYPES.GATEWAY_OUTBOUND,
      [sourceRows()[SOURCE_TYPES.GATEWAY_OUTBOUND]],
      'mixed-outbound.xlsx'
    );
    const normal = sourceRows()[SOURCE_TYPES.BANK_ACCOUNT];
    const account = sourceFile(
      dir,
      SOURCE_TYPES.BANK_ACCOUNT,
      [
        normal,
        { ...normal },
        { ...normal, 账户状态: '注销', 银行账号: 'CLOSED-ACCOUNT' }
      ],
      'mixed-account.xlsx'
    );
    const prepared = await dispatchPositionImportPreflight({
      engine: 'streaming',
      command: POSITION_IMPORT_COMMANDS.SOURCE_PREPARE_AND_APPLY,
      files: [ordinary, account],
      userDataDir: path.join(dir, 'mixed-prepare'),
      sideDbPath,
      featureFlags: {
        preflightOnly: false,
        streamingSourceTypes: [...POSITION_IMPORT_STREAMING_SOURCE_ALLOWLIST]
      },
      authorizeApply: (ready) => ({
        operationToken: 'mixed-ordinary-operation',
        archiveManifestHash: ready.archiveManifestHash,
        schemaFingerprint: schema.fingerprint,
        baseCheckpoint: checkpoint
      })
    }).promise;
    assert.equal(prepared.successCount, 1);
    assert.equal(prepared.confirmationCount, 1);
    assert.deepEqual(
      prepared.results.map((item) => item.status),
      ['ok', 'needs-confirmation']
    );
    assert.equal(prepared.accountConfirmationDescriptor.rowCount, 2);
    assert.equal(
      prepared.cleanupPaths.includes(path.dirname(prepared.ledgerEvidence.ledgerPath)),
      false
    );
    assert.equal(fs.existsSync(prepared.ledgerEvidence.ledgerPath), true);

    let db = new DatabaseSync(sideDbPath, { readOnly: true });
    assert.equal(
      db.prepare(`
        SELECT COUNT(*) AS count FROM position_source_rows
        WHERE source_type = ?
      `).get(SOURCE_TYPES.GATEWAY_OUTBOUND).count,
      1
    );
    assert.equal(
      db.prepare(`
        SELECT COUNT(*) AS count FROM position_source_rows
        WHERE source_type = ?
      `).get(SOURCE_TYPES.BANK_ACCOUNT).count,
      0
    );
    const afterOrdinary = readPositionDatabaseCheckpoint(db);
    assert.equal(afterOrdinary.generation, 1);
    db.close();

    const applied = await dispatchPositionImportPreflight({
      engine: 'streaming',
      command: POSITION_IMPORT_COMMANDS.ACCOUNT_APPLY,
      files: [],
      userDataDir: dir,
      sideDbPath,
      expectedCheckpoint: afterOrdinary,
      operationToken: 'mixed-account-operation',
      payload: {
        schemaFingerprint: schema.fingerprint,
        preflightReady: prepared
      },
      featureFlags: { importApply: true }
    }).promise;
    assert.equal(applied.rowCount, 2);
    assert.equal(applied.linkedRowCount, 2);
    assert.equal(applied.nextCheckpoint.generation, 2);

    db = new DatabaseSync(sideDbPath, { readOnly: true });
    t.after(() => db.close());
    assert.equal(
      db.prepare(`
        SELECT COUNT(*) AS count FROM position_source_rows
        WHERE source_type = ?
      `).get(SOURCE_TYPES.BANK_ACCOUNT).count,
      2
    );
    assert.equal(
      db.prepare(`
        SELECT COUNT(DISTINCT row_hash) AS count FROM position_source_rows
        WHERE source_type = ?
      `).get(SOURCE_TYPES.BANK_ACCOUNT).count,
      2
    );
    assert.equal(
      db.prepare(`
        SELECT COUNT(*) AS count FROM position_link_rows
        WHERE source_type = ?
      `).get(SOURCE_TYPES.BANK_ACCOUNT).count,
      2
    );
    assert.equal(
      db.prepare(`
        SELECT COUNT(*) AS count FROM position_operation_inputs
        WHERE operation_token = 'mixed-account-operation'
      `).get().count,
      1
    );
    assert.equal(readPositionDatabaseCheckpoint(db).generation, 2);
    const recovered = recoverPositionImportWorkerExit({
      sideDbPath,
      baseCheckpoint: afterOrdinary,
      operationToken: 'mixed-account-operation',
      preflightReady: prepared,
      workerError: new Error('worker exited after account commit'),
      command: POSITION_IMPORT_COMMANDS.ACCOUNT_APPLY
    });
    assert.equal(recovered.recoveredFromWorkerExit, true);
    assert.equal(recovered.rowCount, 2);
    assert.equal(recovered.linkedRowCount, 2);

    const replacementAccount = sourceFile(
      dir,
      SOURCE_TYPES.BANK_ACCOUNT,
      [{ ...normal, 银行账号: 'REPLACEMENT-ACCOUNT', 币种: 'EUR' }],
      'replacement-account.xlsx'
    );
    const replacement = await dispatchPositionImportPreflight({
      engine: 'streaming',
      command: POSITION_IMPORT_COMMANDS.SOURCE_PREPARE_AND_APPLY,
      files: [replacementAccount],
      userDataDir: path.join(dir, 'replacement-account-prepare'),
      sideDbPath,
      featureFlags: {
        preflightOnly: false,
        streamingSourceTypes: [...POSITION_IMPORT_STREAMING_SOURCE_ALLOWLIST]
      },
      authorizeApply: (ready) => ({
        preflightOnly: true,
        archiveManifestHash: ready.archiveManifestHash
      })
    }).promise;
    await assert.rejects(
      dispatchPositionImportPreflight({
        engine: 'streaming',
        command: POSITION_IMPORT_COMMANDS.ACCOUNT_APPLY,
        files: [],
        userDataDir: dir,
        sideDbPath,
        expectedCheckpoint: applied.nextCheckpoint,
        operationToken: 'account-low-disk-operation',
        payload: {
          schemaFingerprint: schema.fingerprint,
          preflightReady: replacement
        },
        featureFlags: { importApply: true },
        contractOptions: { availableBytes: 0 }
      }).promise,
      (error) => error && error.code === 'position-import-disk-space-insufficient'
    );
    assert.equal(
      db.prepare(`
        SELECT COUNT(*) AS count FROM position_source_rows
        WHERE source_type = ?
      `).get(SOURCE_TYPES.BANK_ACCOUNT).count,
      2,
      '磁盘门禁必须在删除旧账户快照前生效'
    );
    assert.equal(readPositionDatabaseCheckpoint(db).generation, 2);
  });

  test('gateway-outbound 后序文件失效时保留前序已提交文件并可恢复', async (t) => {
    const dir = tempDir(t, 'position-prc2-source-recovery-');
    const checkpoint = {
      identity: 'source-recovery-identity',
      generation: 0,
      token: 'source-recovery-token'
    };
    const store = createPositionReconciliationStore(dir, {
      initialCheckpoint: checkpoint
    });
    const sideDbPath = store.dbPath;
    store.close();
    const schemaResult = await dispatchPositionLargeImportSchemaMigration({
      engine: 'streaming',
      userDataDir: dir,
      sideDbPath,
      expectedCheckpoint: checkpoint
    }).promise;
    const row = sourceRows()[SOURCE_TYPES.GATEWAY_OUTBOUND];
    const first = sourceFile(
      dir,
      SOURCE_TYPES.GATEWAY_OUTBOUND,
      [{ ...row, 业务单号: 'RECOVERY-A' }],
      'recovery-a.xlsx'
    );
    const second = sourceFile(
      dir,
      SOURCE_TYPES.GATEWAY_OUTBOUND,
      [{ ...row, 业务单号: 'RECOVERY-B' }],
      'recovery-b.xlsx'
    );

    const result = await dispatchPositionImportPreflight({
      engine: 'streaming',
      command: POSITION_IMPORT_COMMANDS.SOURCE_PREPARE_AND_APPLY,
      files: [first, second],
      userDataDir: path.join(dir, 'worker-user-data'),
      sideDbPath,
      featureFlags: {
        preflightOnly: false,
        streamingSourceTypes: [SOURCE_TYPES.GATEWAY_OUTBOUND]
      },
      authorizeApply: (ready) => {
        fs.appendFileSync(ready.acceptedOrdinaryInputFiles[1].archivePath, 'changed');
        return {
          operationToken: 'source-recovery-operation',
          archiveManifestHash: ready.archiveManifestHash,
          schemaFingerprint: schemaResult.fingerprint,
          baseCheckpoint: checkpoint
        };
      }
    }).promise;
    assert.equal(result.status, 'ok');
    assert.equal(result.successCount, 1);
    assert.equal(result.failedCount, 1);
    assert.deepEqual(
      result.results.map((item) => item.status),
      ['ok', 'failed']
    );

    const db = new DatabaseSync(sideDbPath, { readOnly: true });
    t.after(() => db.close());
    assert.equal(
      db.prepare('SELECT COUNT(*) AS count FROM position_source_rows').get().count,
      1
    );
    assert.equal(
      db.prepare(`
        SELECT business_key AS businessKey
        FROM position_source_rows
      `).get().businessKey,
      'RECOVERY-A'
    );
    assert.equal(
      db.prepare(`
        SELECT COUNT(*) AS count
        FROM position_operation_inputs
        WHERE operation_token = 'source-recovery-operation'
      `).get().count,
      1
    );
    assert.equal(readPositionDatabaseCheckpoint(db).generation, 1);
  });

  test('磁盘门禁使用保守行放大和固定安全边际，无法确认空间时 fail closed', (t) => {
    const dir = tempDir(t, 'position-pr-e-disk-gate-');
    const sideDbPath = path.join(dir, 'position-data.sqlite');
    fs.writeFileSync(sideDbPath, Buffer.alloc(4096));
    const estimate = estimatePositionImportDiskBytes({
      kind: 'bank',
      sideDbPath,
      rowCount: 2,
      stagedBytes: 1024,
      ledgerBytes: 2048,
      safetyMarginBytes: 4096
    });
    assert.equal(estimate.existingBytes, 4096n);
    assert.equal(estimate.rowBytes, 16384n);
    assert.equal(estimate.requiredBytes, 27648n);
    assert.throws(
      () => assertPositionImportDiskSpace({
        kind: 'bank',
        sideDbPath,
        rowCount: 2,
        stagedBytes: 1024,
        ledgerBytes: 2048,
        safetyMarginBytes: 4096,
        availableBytes: 27647
      }),
      (error) => error && error.code === 'position-import-disk-space-insufficient'
    );
    assert.equal(
      assertPositionImportDiskSpace({
        kind: 'bank',
        sideDbPath,
        rowCount: 2,
        stagedBytes: 1024,
        ledgerBytes: 2048,
        safetyMarginBytes: 4096,
        availableBytes: 27648
      }).availableBytes,
      27648n
    );
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

  test('3.1.4 白名单异常完整扫描、生成同字节报告并与正常行同文件事务提交', async (t) => {
    const dir = tempDir(t, 'position-v314-filter-apply-');
    const checkpoint = {
      identity: 'v314-filter-identity',
      generation: 0,
      token: 'v314-filter-token'
    };
    let store = createPositionReconciliationStore(dir, {
      initialCheckpoint: checkpoint
    });
    const sideDbPath = store.dbPath;
    store.close();
    const schemaResult = await dispatchPositionLargeImportSchemaMigration({
      engine: 'streaming',
      userDataDir: dir,
      sideDbPath,
      expectedCheckpoint: checkpoint
    }).promise;

    const base = sourceRows()[SOURCE_TYPES.FUND_TRANSFER];
    const filtered = {
      ...base,
      调拨单号: 'FT-FILTERED-1',
      调拨状态: '付款失败',
      渠道流水号: 'RID-FILTERED-1',
      付款金额: ''
    };
    const filePath = sourceFile(
      dir,
      SOURCE_TYPES.FUND_TRANSFER,
      [
        { ...base, 调拨单号: 'FT-VALID-1' },
        filtered,
        filtered,
        { ...base, 调拨单号: 'FT-VALID-2', 渠道流水号: 'RID-VALID-2' }
      ],
      'v314-filter.xlsx'
    );
    const result = await dispatchPositionImportPreflight({
      engine: 'streaming',
      command: POSITION_IMPORT_COMMANDS.SOURCE_PREPARE_AND_APPLY,
      files: [filePath],
      userDataDir: path.join(dir, 'worker-user-data'),
      sideDbPath,
      featureFlags: {
        preflightOnly: false,
        streamingSourceTypes: [SOURCE_TYPES.FUND_TRANSFER]
      },
      authorizeApply: (ready) => ({
        operationToken: 'v314-filter-operation',
        archiveManifestHash: ready.archiveManifestHash,
        schemaFingerprint: schemaResult.fingerprint,
        baseCheckpoint: checkpoint
      })
    }).promise;

    assert.equal(result.status, 'ok');
    assert.equal(result.results[0].physicalRowCount, 4);
    assert.equal(result.results[0].rowCount, 2);
    assert.equal(result.results[0].filteredRowCount, 1);
    assert.equal(result.results[0].collapsedDuplicateCount, 1);
    assert.equal(result.results[0].generatedLinkRowCount, 4);
    assert.equal(result.anomalyReport.filteredRowCount, 1);
    assert.ok(fs.existsSync(result.anomalyReport.filePath));
    const reportHash = await hashFileSha256Async(result.anomalyReport.filePath);
    assert.equal(reportHash.sha256, result.anomalyReport.sha256);
    assert.equal(reportHash.sizeBytes, result.anomalyReport.sizeBytes);

    const reportWorkbook = XLSX.readFile(result.anomalyReport.filePath, { raw: true });
    assert.deepEqual(reportWorkbook.SheetNames, ['异常汇总', '调拨异常明细']);
    const detailRows = XLSX.utils.sheet_to_json(
      reportWorkbook.Sheets['调拨异常明细'],
      { defval: '', raw: true }
    );
    assert.equal(detailRows.length, 1);
    assert.equal(detailRows[0].调拨单号, 'FT-FILTERED-1');
    assert.equal(detailRows[0].Excel行号, 3);

    const styledReport = new ExcelJS.Workbook();
    await styledReport.xlsx.readFile(result.anomalyReport.filePath);
    const summarySheet = styledReport.getWorksheet('异常汇总');
    const detailSheet = styledReport.getWorksheet('调拨异常明细');
    assert.equal(summarySheet.getRow(1).height, 30);
    assert.equal(summarySheet.getRow(1).getCell(1).alignment.wrapText, true);
    assert.equal(summarySheet.getColumn(1).width, 44);
    assert.equal(summarySheet.getColumn(8).width, 48);
    assert.equal(summarySheet.getRow(2).getCell(8).alignment.wrapText, true);
    assert.equal(detailSheet.getColumn(9).width, 48);
    assert.equal(detailSheet.getRow(2).getCell(9).alignment.wrapText, true);
    assert.equal(detailSheet.getColumn(12).numFmt, '@');
    assert.deepEqual(detailSheet.getCell('L2').value, {
      richText: [{ text: 'FT-FILTERED-1' }]
    });

    const db = new DatabaseSync(sideDbPath, { readOnly: true });
    assert.equal(
      db.prepare('SELECT COUNT(*) AS count FROM position_source_rows').get().count,
      2
    );
    assert.equal(
      db.prepare('SELECT COUNT(*) AS count FROM position_link_rows').get().count,
      4
    );
    const tombstone = db.prepare(`
      SELECT business_key AS businessKey, error_code AS errorCode,
             report_sha256 AS reportSha256, resolved_at AS resolvedAt
      FROM position_filtered_source_rows
    `).get();
    assert.equal(tombstone.businessKey, 'FT-FILTERED-1');
    assert.equal(tombstone.errorCode, 'FT_NON_SUCCESS_EVIDENCE_INCOMPLETE');
    assert.equal(tombstone.reportSha256, result.anomalyReport.sha256);
    assert.equal(tombstone.resolvedAt, null);
    db.close();
  });

  test('3.1.4 全量过滤文件仍提交墓碑但不生成来源与链接候选', async (t) => {
    const dir = tempDir(t, 'position-v314-all-filtered-');
    const checkpoint = {
      identity: 'v314-all-filtered-identity',
      generation: 0,
      token: 'v314-all-filtered-token'
    };
    const store = createPositionReconciliationStore(dir, {
      initialCheckpoint: checkpoint
    });
    const sideDbPath = store.dbPath;
    store.close();
    const schemaResult = await dispatchPositionLargeImportSchemaMigration({
      engine: 'streaming',
      userDataDir: dir,
      sideDbPath,
      expectedCheckpoint: checkpoint
    }).promise;
    const base = sourceRows()[SOURCE_TYPES.TEST_PAYMENT];
    const filePath = sourceFile(
      dir,
      SOURCE_TYPES.TEST_PAYMENT,
      [
        { ...base, 付款单号: 'TEST-ALL-FILTERED-1', 源金额: '' },
        { ...base, 付款单号: 'TEST-ALL-FILTERED-2', 源币种: '' }
      ],
      'all-filtered.xlsx'
    );
    const result = await dispatchPositionImportPreflight({
      engine: 'streaming',
      command: POSITION_IMPORT_COMMANDS.SOURCE_PREPARE_AND_APPLY,
      files: [filePath],
      userDataDir: path.join(dir, 'worker-user-data'),
      sideDbPath,
      featureFlags: {
        preflightOnly: false,
        streamingSourceTypes: [SOURCE_TYPES.TEST_PAYMENT]
      },
      authorizeApply: (ready) => ({
        operationToken: 'v314-all-filtered-operation',
        archiveManifestHash: ready.archiveManifestHash,
        schemaFingerprint: schemaResult.fingerprint,
        baseCheckpoint: checkpoint
      })
    }).promise;

    assert.equal(result.status, 'ok');
    assert.equal(result.results[0].physicalRowCount, 2);
    assert.equal(result.results[0].rowCount, 0);
    assert.equal(result.results[0].filteredRowCount, 2);
    assert.equal(result.results[0].generatedLinkRowCount, 0);
    const db = new DatabaseSync(sideDbPath, { readOnly: true });
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM position_source_rows').get().count, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM position_link_rows').get().count, 0);
    assert.equal(
      db.prepare('SELECT COUNT(*) AS count FROM position_filtered_source_rows').get().count,
      2
    );
    db.close();

    const reimport = await dispatchPositionImportPreflight({
      engine: 'streaming',
      command: POSITION_IMPORT_COMMANDS.SOURCE_PREPARE_AND_APPLY,
      files: [filePath],
      userDataDir: path.join(dir, 'worker-reimport'),
      sideDbPath,
      featureFlags: {
        preflightOnly: false,
        streamingSourceTypes: [SOURCE_TYPES.TEST_PAYMENT]
      },
      authorizeApply: (ready) => ({
        operationToken: 'v314-all-filtered-reimport',
        archiveManifestHash: ready.archiveManifestHash,
        schemaFingerprint: schemaResult.fingerprint,
        baseCheckpoint: result.checkpoint
      })
    }).promise;
    const afterReimport = new DatabaseSync(sideDbPath, { readOnly: true });
    assert.equal(
      afterReimport.prepare('SELECT COUNT(*) AS count FROM position_filtered_source_rows').get().count,
      4
    );
    assert.equal(
      afterReimport.prepare(`
        SELECT COUNT(*) AS count
        FROM position_filtered_source_rows
        WHERE resolved_at IS NULL
      `).get().count,
      2,
      '完全相同异常重导后每个精确异常仍只能有一条活动墓碑'
    );
    afterReimport.close();

    const validPath = sourceFile(
      dir,
      SOURCE_TYPES.TEST_PAYMENT,
      [
        { ...base, 付款单号: 'TEST-ALL-FILTERED-1' },
        { ...base, 付款单号: 'TEST-ALL-FILTERED-2' }
      ],
      'all-filtered-corrected.xlsx'
    );
    await dispatchPositionImportPreflight({
      engine: 'streaming',
      command: POSITION_IMPORT_COMMANDS.SOURCE_PREPARE_AND_APPLY,
      files: [validPath],
      userDataDir: path.join(dir, 'worker-corrected'),
      sideDbPath,
      featureFlags: {
        preflightOnly: false,
        streamingSourceTypes: [SOURCE_TYPES.TEST_PAYMENT]
      },
      authorizeApply: (ready) => ({
        operationToken: 'v314-all-filtered-corrected',
        archiveManifestHash: ready.archiveManifestHash,
        schemaFingerprint: schemaResult.fingerprint,
        baseCheckpoint: reimport.checkpoint
      })
    }).promise;
    const afterCorrected = new DatabaseSync(sideDbPath, { readOnly: true });
    assert.equal(
      afterCorrected.prepare(`
        SELECT COUNT(*) AS count
        FROM position_filtered_source_rows
        WHERE resolved_at IS NULL
      `).get().count,
      0
    );
    assert.equal(
      afterCorrected.prepare(`
        SELECT COUNT(*) AS count
        FROM position_filtered_source_rows
        WHERE resolution_reason = 'normal-source-imported'
      `).get().count,
      2
    );
    assert.equal(afterCorrected.prepare('SELECT COUNT(*) AS count FROM position_source_rows').get().count, 2);
    afterCorrected.close();
  });

  test('3.1.4 正常行与过滤行业务键碰撞时结果不受文件选择顺序影响', async (t) => {
    const dir = tempDir(t, 'position-v314-filter-collision-');
    const base = sourceRows()[SOURCE_TYPES.FUND_TRANSFER];
    const businessKey = 'FT-COLLISION-1';
    const validPath = sourceFile(
      dir,
      SOURCE_TYPES.FUND_TRANSFER,
      [{ ...base, 调拨单号: businessKey }],
      'valid.xlsx'
    );
    const filteredPath = sourceFile(
      dir,
      SOURCE_TYPES.FUND_TRANSFER,
      [{
        ...base,
        调拨单号: businessKey,
        调拨状态: '付款失败',
        付款金额: ''
      }],
      'filtered.xlsx'
    );

    for (const [index, files] of [
      [1, [filteredPath, validPath]],
      [2, [validPath, filteredPath]]
    ]) {
      const result = await runPositionImportPreflight({
        jobId: `v314-collision-order-${index}`,
        kind: 'source',
        files,
        userDataDir: path.join(dir, `worker-${index}`)
      });
      const byName = new Map(result.orderedFileResults.map((item) => [item.fileName, item]));
      assert.equal(byName.get('valid.xlsx').status, 'ok');
      assert.equal(byName.get('valid.xlsx').rowCount, 1);
      assert.equal(byName.get('filtered.xlsx').status, 'failed');
      assert.equal(byName.get('filtered.xlsx').code, 'position-filtered-key-collision');
      assert.equal(result.anomalyReport, null);
    }
  });

  test('3.1.4 异常报告失败只拒绝含过滤行文件，普通文件继续预检提交', async (t) => {
    const dir = tempDir(t, 'position-v314-report-failure-');
    const base = sourceRows()[SOURCE_TYPES.FUND_TRANSFER];
    const filteredPath = sourceFile(
      dir,
      SOURCE_TYPES.FUND_TRANSFER,
      [{
        ...base,
        调拨单号: 'FT-REPORT-FAIL-FILTERED',
        调拨状态: '付款失败',
        付款金额: ''
      }],
      'filtered-report-failure.xlsx'
    );
    const validPath = sourceFile(
      dir,
      SOURCE_TYPES.FUND_TRANSFER,
      [{ ...base, 调拨单号: 'FT-REPORT-FAIL-VALID' }],
      'valid-after-report-failure.xlsx'
    );
    const result = await runPositionImportPreflight({
      jobId: 'v314-report-failure',
      kind: 'source',
      files: [filteredPath, validPath],
      userDataDir: path.join(dir, 'worker'),
      writeAnomalyReport: async () => {
        throw new Error('injected anomaly writer failure');
      }
    });
    const byName = new Map(result.orderedFileResults.map((item) => [item.fileName, item]));
    assert.equal(byName.get('filtered-report-failure.xlsx').status, 'failed');
    assert.equal(
      byName.get('filtered-report-failure.xlsx').code,
      'position-anomaly-report-failed'
    );
    assert.equal(byName.get('valid-after-report-failure.xlsx').status, 'ok');
    assert.equal(result.acceptedOrdinaryInputFiles.length, 1);
    assert.equal(result.acceptedOrdinaryInputFiles[0].fileName, 'valid-after-report-failure.xlsx');
    assert.equal(result.anomalyReport, null);
  });

  test('3.1.4 过滤行业务键已存在正常记录时整文件拒绝且不删除旧记录', async (t) => {
    const dir = tempDir(t, 'position-v314-existing-collision-');
    const checkpoint = {
      identity: 'v314-existing-collision-identity',
      generation: 0,
      token: 'v314-existing-collision-token'
    };
    const store = createPositionReconciliationStore(dir, {
      initialCheckpoint: checkpoint
    });
    const sideDbPath = store.dbPath;
    store.db.prepare(`
      INSERT INTO position_source_rows(
        source_type, business_key, event_date, month_key,
        source_file_path, source_file_name, source_sheet, source_row_number,
        row_hash, raw_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      SOURCE_TYPES.FUND_TRANSFER,
      'FT-EXISTING-COLLISION',
      '2026-07-20',
      '2026-07',
      '/tmp/existing.xlsx',
      'existing.xlsx',
      'Sheet1',
      2,
      'existing-row-hash',
      '{}'
    );
    store.close();
    const base = sourceRows()[SOURCE_TYPES.FUND_TRANSFER];
    const filteredPath = sourceFile(
      dir,
      SOURCE_TYPES.FUND_TRANSFER,
      [{
        ...base,
        调拨单号: 'FT-EXISTING-COLLISION',
        调拨状态: '付款失败',
        付款金额: ''
      }],
      'filtered-existing-collision.xlsx'
    );
    const result = await runPositionImportPreflight({
      jobId: 'v314-existing-collision',
      kind: 'source',
      files: [filteredPath],
      userDataDir: path.join(dir, 'worker'),
      sideDbPath
    });
    assert.equal(result.orderedFileResults[0].status, 'failed');
    assert.equal(result.orderedFileResults[0].code, 'position-filtered-key-collision');
    const db = new DatabaseSync(sideDbPath, { readOnly: true });
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM position_source_rows').get().count, 1);
    assert.equal(
      db.prepare('SELECT COUNT(*) AS count FROM position_filtered_source_rows').get().count,
      0
    );
    db.close();
  });
});
