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
  POSITION_BANK_INTERACTION_FIELDS,
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
  runPositionSourceImport
} = require('../../../src/backend/position-reconciliation-import/source-import');
const {
  runPositionBankImport
} = require('../../../src/backend/position-reconciliation-import/bank-import');
const {
  applyPositionAccountSnapshot
} = require('../../../src/backend/position-reconciliation-import/account-import');
const {
  parseSourceFields,
  pickSourceFields,
  sameSourceFields,
  serializeSourceFields,
  sourceRecordKeyOf
} = require('../../../src/main-process/position-reconciliation/source-row-storage');
const {
  bankFieldsFromStoredRow,
  bankValueColumnsFromFields,
  BANK_VALUE_COLUMNS
} = require('../../../src/main-process/position-reconciliation/bank-row-storage');
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
  uncommittedJobRoot
} = require('../../../src/main-process/position-reconciliation/import-dispatch');
const {
  recoverPositionImportWorkerExit
} = require('../../../src/main-process/position-reconciliation/import-recovery');
const {
  createPositionReconciliationStore
} = require('../../../src/main-process/position-reconciliation/store');
const {
  readPositionDatabaseCheckpoint
} = require('../../../src/main-process/position-reconciliation/side-db-mutation');
const {
  STAGING_RELATIVE_PATH,
  stageInputFilesAsync
} = require('../../../src/main-process/position-reconciliation/input-staging');

const MUTATING_BATCH_CONTEXT = Object.freeze({
  batchId: 319,
  batchNumber: '2026-08-10-001',
  taskRunId: 'position-mutating-worker-contract',
  taskKey: 'position-reconciliation:source:apply-import',
  moduleId: 'position-reconciliation',
  parentRunId: 'position-worker-parent',
  operationKey: 'position-worker-operation'
});
const MUTATING_OPERATION_CONTEXT = Object.freeze({
  taskRunId: 'position-maintenance-worker-contract',
  taskKey: 'position-reconciliation:source:delete',
  moduleId: 'position-reconciliation',
  parentRunId: 'position-worker-parent',
  operationKey: 'position-maintenance-operation'
});
const {
  POSITION_IMPORT_DISK_SAFETY_MARGIN_BYTES,
  POSITION_IMPORT_GROWTH_PER_STAGED_BYTE,
  assertPositionImportDiskSpace,
  estimatePositionImportDiskBytes,
  existingStorageBytes
} = require('../../../src/backend/position-reconciliation-import/disk-space-gate');

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

function createSideDb(dir, name = 'side') {
  const checkpoint = { identity: `${name}-identity`, generation: 0, token: `${name}-token` };
  const store = createPositionReconciliationStore(dir, { initialCheckpoint: checkpoint });
  const sideDbPath = store.dbPath;
  store.close();
  return { checkpoint, sideDbPath };
}

// 进程内执行链接原始表单遍导入：读取并写入未提交的事务，发出 ready 后按 grant 提交。
// grant 缺省为与本次导入一致的写入授权；传函数可构造不一致或拒绝的授权。
async function importSources({
  dir, files, sideDbPath, checkpoint, jobId,
  operationToken = 'source-import-operation', grant = null, ...rest
}) {
  let ready = null;
  const result = await runPositionSourceImport({
    jobId,
    files,
    userDataDir: path.join(dir, 'worker-user-data'),
    sideDbPath,
    expectedCheckpoint: checkpoint,
    allowedSourceTypes: [...POSITION_IMPORT_STREAMING_SOURCE_ALLOWLIST],
    awaitApplyGrant: async (value) => {
      ready = value;
      if (typeof grant === 'function') return grant(value);
      return {
        jobId,
        archiveManifestHash: value.archiveManifestHash,
        operationToken,
        baseCheckpoint: checkpoint,
        batchContext: MUTATING_BATCH_CONTEXT
      };
    },
    ...rest
  });
  return { ready, result };
}

function sourceWorkerInput(dir, { sideDbPath, checkpoint }, files, extra = {}) {
  return {
    engine: 'streaming',
    command: POSITION_IMPORT_COMMANDS.SOURCE_IMPORT,
    files,
    userDataDir: path.join(dir, 'worker-user-data'),
    sideDbPath,
    expectedCheckpoint: checkpoint,
    featureFlags: {
      sourceImport: true,
      streamingSourceTypes: [...POSITION_IMPORT_STREAMING_SOURCE_ALLOWLIST]
    },
    ...extra
  };
}

function countRows(sideDbPath, table) {
  const db = new DatabaseSync(sideDbPath, { readOnly: true });
  try {
    return Number(db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count);
  } finally {
    db.close();
  }
}

// v3.2.14：表头结构不一致时的差异明细。
const renamedHeaders = () => SOURCE_DEFINITIONS[SOURCE_TYPES.GATEWAY_INBOUND].headers
  .map((header) => (header === 'fieldId' ? 'fileId' : header));
const expectedLines = [
  '工作表「网关」最接近：中台网关原始入账订单（41 列；文件 41 列）',
  '第 20 列（T）：应为「fieldId」，实际为「fileId」',
  '缺少列：fieldId',
  '多出列：fileId',
  '如系统导出结构已变更，请在「设置 → 模板文件」导入新版本'
];

test.describe('平盘导入：读取器、调度器与单遍导入', () => {
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

  test('五类来源的新 XLSX reader 取出的必用列与旧 SheetJS 读取的值、类型、摘要等价', async (t) => {
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
        onRow: ({ row }) => streamed.push(pickSourceFields(sourceType, row))
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
      onRow: ({ row }) => streamed.push(pickSourceFields(sourceType, row))
    });
    assert.equal(stableJson(streamed), stableJson(legacy.records.map((record) => record.row)));
    assert.equal(stableHash(streamed), stableHash(legacy.records.map((record) => record.row)));
  });

  test('银行结果导出格式逐行读取后取出的交互字段与旧 reader 等价', async (t) => {
    const dir = tempDir(t, 'position-prb-bank-');
    const filePath = path.join(dir, 'bank-result-format.xlsx');
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
          POSITION_BANK_INTERACTION_FIELDS.map((header) => [header, raw[header] ?? ''])
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
    // 入库只取必用列：与旧读取路径比对的是这些列的值与类型。
    assert.equal(
      stableJson(pickSourceFields(SOURCE_TYPES.GATEWAY_OUTBOUND, streamed)),
      stableJson(legacy)
    );
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

  test('dispatcher 只接受 staging 根目录直属批次作为零提交清理目标', () => {
    const userDataDir = path.resolve('/tmp', 'position-cleanup-root');
    const jobRoot = path.join(userDataDir, STAGING_RELATIVE_PATH, 'safe-job');
    assert.equal(
      uncommittedJobRoot({ userDataDir }, 'other-job', { jobRoot }),
      jobRoot
    );
    assert.equal(
      uncommittedJobRoot({ userDataDir }, 'safe-job', {
        jobRoot: path.join(userDataDir, 'outside')
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

  test('四个启动即写库的命令缺持久 owner 时在启动 worker 前拒绝', () => {
    let forkCount = 0;
    for (const command of [
      POSITION_IMPORT_COMMANDS.ACCOUNT_APPLY,
      POSITION_IMPORT_COMMANDS.DELETE_BANK,
      POSITION_IMPORT_COMMANDS.DELETE_SOURCE,
      POSITION_IMPORT_COMMANDS.REBUILD_FUND_TRANSFER_MAPPING
    ]) {
      assert.throws(
        () => dispatchPositionImportPreflight({
          engine: 'streaming',
          command,
          utilityProcess: { fork: () => { forkCount += 1; } }
        }),
        /缺少持久 owner context/
      );
    }
    assert.equal(forkCount, 0);
  });

  test('maintenance 写命令以 exact-5 operationContext 启动 worker', async () => {
    const worker = new EventEmitter();
    let startMessage = null;
    worker.postMessage = (message) => {
      if (message.type !== POSITION_IMPORT_MESSAGE_TYPES.START_JOB) return;
      startMessage = message;
      setImmediate(() => worker.emit('message', {
        type: POSITION_IMPORT_MESSAGE_TYPES.COMPLETE,
        jobId: message.jobId,
        result: { status: 'ok' }
      }));
    };
    worker.kill = () => true;

    const job = dispatchPositionImportPreflight({
      engine: 'streaming',
      command: POSITION_IMPORT_COMMANDS.DELETE_SOURCE,
      files: [],
      operationContext: MUTATING_OPERATION_CONTEXT,
      utilityProcess: { fork: () => worker }
    });
    assert.equal((await job.promise).status, 'ok');
    assert.deepEqual(startMessage.operationContext, MUTATING_OPERATION_CONTEXT);
    assert.equal(Object.hasOwn(startMessage, 'batchContext'), false);
  });

  test('普通来源 START/PREFLIGHT 不带批次，APPLY_GRANTED 注入父 action batchContext', async () => {
    const batchContext = Object.freeze({
      batchId: 319,
      batchNumber: '2026-08-10-001',
      taskRunId: 'position-source-worker-contract',
      taskKey: 'position-reconciliation:source:prepare-import',
      moduleId: 'position-reconciliation',
      parentRunId: 'position-source-parent',
      operationKey: 'position-source-operation'
    });
    const worker = new EventEmitter();
    let startMessage = null;
    let applyMessage = null;
    worker.postMessage = (message) => {
      if (message.type === POSITION_IMPORT_MESSAGE_TYPES.START_JOB) {
        startMessage = message;
        setImmediate(() => worker.emit('message', {
          type: POSITION_IMPORT_MESSAGE_TYPES.PREFLIGHT_READY,
          jobId: message.jobId,
          archiveManifestHash: 'source-manifest'
        }));
        return;
      }
      if (message.type === POSITION_IMPORT_MESSAGE_TYPES.APPLY_GRANTED) {
        applyMessage = message;
        setImmediate(() => worker.emit('message', {
          type: POSITION_IMPORT_MESSAGE_TYPES.COMPLETE,
          jobId: message.jobId,
          result: { status: 'ok' }
        }));
      }
    };
    worker.kill = () => true;

    const job = dispatchPositionImportPreflight({
      engine: 'streaming',
      command: POSITION_IMPORT_COMMANDS.SOURCE_IMPORT,
      files: [],
      userDataDir: '',
      sideDbPath: '',
      batchContext,
      utilityProcess: { fork: () => worker },
      authorizeApply: () => ({
        preflightOnly: false,
        batchContext
      })
    });
    const result = await job.promise;

    assert.equal(result.status, 'ok');
    assert.equal(Object.hasOwn(startMessage, 'batchContext'), false);
    assert.deepEqual(applyMessage.batchContext, batchContext);
  });

  test('普通来源 mutating APPLY_GRANTED 缺 batchContext 时拒绝且不发送提交授权', async () => {
    const worker = new EventEmitter();
    const sentTypes = [];
    worker.postMessage = (message) => {
      sentTypes.push(message.type);
      if (message.type === POSITION_IMPORT_MESSAGE_TYPES.START_JOB) {
        setImmediate(() => worker.emit('message', {
          type: POSITION_IMPORT_MESSAGE_TYPES.PREFLIGHT_READY,
          jobId: message.jobId,
          archiveManifestHash: 'source-manifest'
        }));
      } else if (message.type === POSITION_IMPORT_MESSAGE_TYPES.APPLY_REJECTED) {
        setImmediate(() => worker.emit('message', {
          type: POSITION_IMPORT_MESSAGE_TYPES.FATAL,
          jobId: message.jobId,
          code: message.code,
          message: message.message
        }));
      }
    };
    worker.kill = () => true;
    const job = dispatchPositionImportPreflight({
      engine: 'streaming',
      command: POSITION_IMPORT_COMMANDS.SOURCE_IMPORT,
      files: [],
      userDataDir: '',
      sideDbPath: '',
      utilityProcess: { fork: () => worker },
      authorizeApply: () => ({ preflightOnly: false })
    });
    await assert.rejects(job.promise, /缺少持久 batch owner/);
    assert.equal(sentTypes.includes(POSITION_IMPORT_MESSAGE_TYPES.APPLY_GRANTED), false);
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
      fs.mkdirSync(jobRoot, { recursive: true });
      fs.writeFileSync(path.join(jobRoot, 'staged.xlsx'), 'staged');
      const ready = {
        type: POSITION_IMPORT_MESSAGE_TYPES.PREFLIGHT_READY,
        jobId: message.jobId,
        archiveManifestHash: 'duplicate-manifest',
        jobRoot
      };
      setImmediate(() => {
        worker.emit('message', ready);
        worker.emit('message', { ...ready });
      });
    };
    worker.kill = () => true;
    const job = dispatchPositionImportPreflight({
      engine: 'streaming',
      command: POSITION_IMPORT_COMMANDS.SOURCE_IMPORT,
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
      command: POSITION_IMPORT_COMMANDS.BANK_IMPORT,
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
    let completionTimer = null;
    let completionSent = false;
    const emitComplete = (jobId) => {
      if (completionSent) return;
      completionSent = true;
      worker.emit('message', {
        type: POSITION_IMPORT_MESSAGE_TYPES.COMPLETE,
        jobId,
        result: { status: 'ok' }
      });
    };
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
      completionTimer = setTimeout(() => emitComplete(message.jobId), 2000);
    };
    worker.kill = () => true;
    const progress = [];
    const job = dispatchPositionImportPreflight({
      engine: 'streaming',
      command: POSITION_IMPORT_COMMANDS.ACCOUNT_APPLY,
      batchContext: MUTATING_BATCH_CONTEXT,
      files: [],
      userDataDir: '',
      sideDbPath: '',
      utilityProcess: { fork: () => worker },
      progressHeartbeatMs: 10,
      onProgress: (event) => {
        progress.push(event);
        if (progress.filter((item) => item.heartbeat === true).length === 2) {
          clearTimeout(completionTimer);
          emitComplete(event.jobId);
        }
      }
    });
    const result = await job.promise;
    clearTimeout(completionTimer);
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
      command: POSITION_IMPORT_COMMANDS.ACCOUNT_APPLY,
      batchContext: MUTATING_BATCH_CONTEXT,
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

  test('银行单遍导入：结果导出格式可作输入且审计列不入库，登记原始版本号，提交凭证可供恢复，磁盘门禁在写库前生效', async (t) => {
    const dir = tempDir(t, 'position-bank-single-pass-');
    const checkpoint = {
      identity: 'bank-import-identity',
      generation: 0,
      token: 'bank-import-token'
    };
    const store = createPositionReconciliationStore(dir, {
      initialCheckpoint: checkpoint
    });
    const sideDbPath = store.dbPath;
    store.close();
    const bankPath = path.join(dir, 'bank-result-format.xlsx');
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
          // 使用纯日期文本，避免月份边界受宿主时区下 Excel 纪元秒级余数影响。
          BillDate: '2026-08-01',
          Channel: 'JPM',
          Currency: 'EUR'
        })
      ]
    }]);
    const importBank = (files, { operationToken, baseCheckpoint, contractOptions } = {}) => {
      const state = { ready: null };
      const job = dispatchPositionImportPreflight({
        engine: 'streaming',
        command: POSITION_IMPORT_COMMANDS.BANK_IMPORT,
        files,
        userDataDir: dir,
        sideDbPath,
        expectedCheckpoint: baseCheckpoint,
        featureFlags: { bankImport: true },
        ...(contractOptions ? { contractOptions } : {}),
        onPreflightReady: (ready) => { state.ready = ready; },
        authorizeApply: () => ({
          preflightOnly: false,
          operationToken,
          baseCheckpoint,
          batchContext: MUTATING_BATCH_CONTEXT
        })
      });
      return { state, promise: job.promise };
    };

    const first = importBank([bankPath], {
      operationToken: 'bank-import-operation',
      baseCheckpoint: checkpoint
    });
    const applied = await first.promise;
    assert.equal(applied.rowCount, 2);
    assert.equal(applied.scopes.length, 2);
    assert.equal(applied.nextCheckpoint.generation, 1);
    assert.deepEqual(applied.rawVersions, [{ fileIndex: 0, fileName: 'bank-result-format.xlsx', version: 1 }]);

    const db = new DatabaseSync(sideDbPath, { readOnly: true });
    t.after(() => db.close());
    const rows = db.prepare(`
      SELECT biz_id AS bizId, import_order AS importOrder,
             hit_summary AS hitSummary, hit_type AS hitType, match_detail AS matchDetail,
             raw_version AS rawVersion, raw_row_number AS rawRowNumber,
             merchant_id AS merchantId, currency
      FROM position_bank_rows
      ORDER BY import_order
    `).all();
    assert.deepEqual(
      rows.map((row) => [row.bizId, row.importOrder, row.rawVersion, row.rawRowNumber]),
      [['BANK-PRB-1', 0, 1, 2], ['BANK-PRB-2', 1, 1, 3]]
    );
    assert.deepEqual(
      [rows[0].hitSummary, rows[0].hitType, rows[0].matchDetail],
      ['', '', ''],
      '结果文件里的审计列不入库'
    );
    assert.equal(rows[0].merchantId, 'M001');
    assert.equal(rows[1].currency, 'EUR');
    const columns = db.prepare('PRAGMA table_info(position_bank_rows)').all().map((column) => column.name);
    assert.equal(columns.some((name) => /json/.test(name)), false, '银行行不再保存整行 JSON');
    const rawFile = db.prepare('SELECT * FROM position_raw_files').all();
    assert.equal(rawFile.length, 1);
    assert.equal(rawFile[0].kind, 'bank');
    assert.equal(rawFile[0].original_name, 'bank-result-format.xlsx');
    assert.equal(rawFile[0].sheet_name, BANK_SHEET_NAME);
    assert.equal(Number(rawFile[0].row_count), 2);
    assert.equal(rawFile[0].status, 'active');
    assert.equal(Number(rawFile[0].size_bytes), fs.statSync(bankPath).size);
    assert.match(rawFile[0].sha256, /^[a-f0-9]{64}$/);
    assert.equal(rawFile[0].operation_token, 'bank-import-operation');
    assert.equal(rawFile[0].archive_batch_number, MUTATING_BATCH_CONTEXT.batchNumber);
    assert.equal(
      db.prepare(`
        SELECT COUNT(*) AS count
        FROM position_operation_inputs
        WHERE operation_token = 'bank-import-operation'
      `).get().count,
      1
    );
    assert.equal(readPositionDatabaseCheckpoint(db).generation, 1);

    // 导入进程在提交后、回报前退出：凭提交链与 ready 消息重建同一结果。
    const recovered = recoverPositionImportWorkerExit({
      sideDbPath,
      baseCheckpoint: checkpoint,
      operationToken: 'bank-import-operation',
      preflightReady: first.state.ready,
      workerError: new Error('worker exited after commit'),
      command: POSITION_IMPORT_COMMANDS.BANK_IMPORT
    });
    assert.equal(recovered.recoveredFromWorkerExit, true);
    assert.equal(recovered.rowCount, 2);
    assert.deepEqual(recovered.fileScopes, [
      { fileIndex: 0, channel: 'DBS', monthKey: '2026-07' },
      { fileIndex: 0, channel: 'JPM', monthKey: '2026-08' }
    ]);
    assert.deepEqual(recovered.cleanupPaths, [first.state.ready.jobRoot]);

    const replacementPath = path.join(dir, 'bank-replacement.xlsx');
    writeWorkbook(replacementPath, [{
      name: BANK_SHEET_NAME,
      headers: BANK_STATEMENT_FIELDS,
      rows: [bankRow({ BizId: 'BANK-REPLACEMENT' })]
    }]);
    await assert.rejects(
      importBank([replacementPath], {
        operationToken: 'bank-low-disk-operation',
        baseCheckpoint: applied.nextCheckpoint,
        contractOptions: { availableBytes: 0 }
      }).promise,
      (error) => error && error.code === 'position-import-disk-space-insufficient'
    );
    assert.equal(
      db.prepare('SELECT COUNT(*) AS count FROM position_bank_rows').get().count,
      2,
      '磁盘门禁必须在删除旧 scope 前生效'
    );
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM position_raw_files').get().count, 1);
    assert.equal(readPositionDatabaseCheckpoint(db).generation, 1);

    // 旧的两段式银行命令已停用。
    await assert.rejects(
      dispatchPositionImportPreflight({
        engine: 'streaming',
        command: POSITION_IMPORT_COMMANDS.BANK_PREPARE,
        files: [replacementPath],
        userDataDir: path.join(dir, 'bank-prepare'),
        sideDbPath
      }).promise,
      (error) => error && error.code === 'position-import-disabled'
    );
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
      safetyMarginBytes: 4096
    });
    assert.equal(estimate.existingBytes, 4096n);
    assert.equal(estimate.rowBytes, 16384n);
    assert.equal(estimate.requiredBytes, 25600n);
    assert.throws(
      () => assertPositionImportDiskSpace({
        kind: 'bank',
        sideDbPath,
        rowCount: 2,
        stagedBytes: 1024,
        safetyMarginBytes: 4096,
        availableBytes: 25599
      }),
      (error) => error && error.code === 'position-import-disk-space-insufficient'
    );
    assert.equal(
      assertPositionImportDiskSpace({
        kind: 'bank',
        sideDbPath,
        rowCount: 2,
        stagedBytes: 1024,
        safetyMarginBytes: 4096,
        availableBytes: 25600
      }).availableBytes,
      25600n
    );
  });

  test('默认 disabled 不启动 worker，.xls 主进程调用被拒绝', async () => {
    assert.throws(
      () => dispatchPositionImportPreflight({
        command: POSITION_IMPORT_COMMANDS.SOURCE_IMPORT,
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

  test('xlsx / xls / legacy 读取未识别的链接原始表时给出同一组差异明细', async (t) => {
    const dir = tempDir(t, 'position-header-diff-');
    const sheets = [
      { name: '说明', headers: ['说明'], rows: [{ 说明: '忽略' }] },
      { name: '网关', headers: renamedHeaders(), rows: [sourceRows()[SOURCE_TYPES.GATEWAY_INBOUND]] }
    ];
    const xlsxPath = path.join(dir, 'gateway.xlsx');
    const xlsPath = path.join(dir, 'gateway.xls');
    writeWorkbook(xlsxPath, sheets);
    writeWorkbook(xlsPath, sheets);

    await assert.rejects(streamPositionXlsxRows(xlsxPath, { kind: 'source' }), (error) => {
      assert.equal(error.code, 'position-source-unrecognized');
      assert.deepEqual(error.detailLines, expectedLines);
      return true;
    });
    await assert.rejects(
      streamPositionXlsRows(xlsPath, { kind: 'source', allowMainThread: true }),
      (error) => {
        assert.equal(error.code, 'position-source-unrecognized');
        assert.deepEqual(error.detailLines, expectedLines);
        return true;
      }
    );
    assert.throws(() => readSourceFile(xlsxPath), (error) => {
      assert.equal(error.code, 'position-source-unrecognized');
      assert.deepEqual(error.detailLines, expectedLines);
      return true;
    });
  });

  test('银行对账单表头不符时列出与 46 列契约的差异，并提示在模板文件导入新版本', async (t) => {
    const dir = tempDir(t, 'position-bank-header-diff-');
    const headers = BANK_STATEMENT_FIELDS.map((header) => (header === 'Channel' ? 'channel' : header));
    const filePath = path.join(dir, 'bank.xlsx');
    writeWorkbook(filePath, [{ name: BANK_SHEET_NAME, headers, rows: [bankRow({ channel: 'DBS' })] }]);
    const channelIndex = BANK_STATEMENT_FIELDS.indexOf('Channel');
    const expected = [
      '最接近：平盘银行对账单 46 列（46 列；文件 46 列）',
      `第 ${channelIndex + 1} 列（${String.fromCharCode(65 + channelIndex)}）：应为「Channel」，实际为「channel」`,
      '缺少列：Channel',
      '多出列：channel',
      '如系统导出结构已变更，请在「设置 → 模板文件」导入新版本'
    ];
    await assert.rejects(streamPositionXlsxRows(filePath, { kind: 'bank' }), (error) => {
      assert.equal(error.code, 'position-bank-headers-invalid');
      assert.deepEqual(error.detailLines, expected);
      return true;
    });
    assert.throws(() => readBankFiles([filePath]), (error) => {
      assert.equal(error.code, 'position-bank-headers-invalid');
      assert.deepEqual(error.detailLines, expected);
      return true;
    });
  });
  // ── 链接原始表单遍导入（v3.2.22）：经真实导入进程 ──────────────────────────────

  test('链接原始表等待写入授权时取消：事务回滚，暂存清理，ready 只带清单不带数据行', async (t) => {
    const dir = tempDir(t, 'position-source-awaiting-cancel-');
    const side = createSideDb(dir);
    const filePath = sourceFile(
      dir,
      SOURCE_TYPES.GATEWAY_OUTBOUND,
      [sourceRows()[SOURCE_TYPES.GATEWAY_OUTBOUND]],
      'awaiting-cancel.xlsx'
    );
    let resolveReady;
    const readyPromise = new Promise((resolve) => { resolveReady = resolve; });
    const progress = [];
    const job = dispatchPositionImportPreflight(sourceWorkerInput(dir, side, [filePath], {
      authorizeApply: () => new Promise(() => {}),
      onPreflightReady: resolveReady,
      onProgress: (event) => progress.push(event)
    }));
    const ready = await readyPromise;
    assert.equal(ready.orderedFileResults[0].status, 'ok');
    assert.equal(ready.orderedFileResults[0].rowCount, 1);
    assert.equal(Object.hasOwn(ready, 'records'), false);
    assert.ok(progress.some((event) => event.stage === 'staging'));
    assert.ok(progress.some((event) => event.stage === 'importing'));
    // 等待授权期间事务未提交：其他连接看不到新行。
    assert.equal(countRows(side.sideDbPath, 'position_source_rows'), 0);

    assert.equal(job.cancel(), true);
    await assert.rejects(
      job.promise,
      (error) => error && error.code === 'position-import-cancelled'
    );
    assert.equal(countRows(side.sideDbPath, 'position_source_rows'), 0);
    assert.equal(countRows(side.sideDbPath, 'position_raw_files'), 0);
    assert.equal(
      fs.existsSync(path.join(dir, 'worker-user-data', STAGING_RELATIVE_PATH, job.jobId)),
      false
    );
  });

  test('链接原始表写入授权失败：导入进程回滚并清理暂存', async (t) => {
    const dir = tempDir(t, 'position-source-auth-reject-');
    const side = createSideDb(dir);
    const filePath = sourceFile(
      dir,
      SOURCE_TYPES.GATEWAY_OUTBOUND,
      [sourceRows()[SOURCE_TYPES.GATEWAY_OUTBOUND]],
      'auth-reject.xlsx'
    );
    const job = dispatchPositionImportPreflight(sourceWorkerInput(dir, side, [filePath], {
      authorizeApply: () => {
        const error = new Error('测试授权失败');
        error.code = 'position-import-intent-not-durable';
        throw error;
      }
    }));
    await assert.rejects(
      job.promise,
      (error) => error
        && error.code === 'position-import-intent-not-durable'
        && error.message === '测试授权失败'
    );
    assert.equal(countRows(side.sideDbPath, 'position_source_rows'), 0);
    assert.equal(
      fs.existsSync(path.join(dir, 'worker-user-data', STAGING_RELATIVE_PATH, job.jobId)),
      false
    );
  });

  test('导入进程在读取写入途中被强制终止：库内数据不变，暂存由调度器清理', async (t) => {
    const dir = tempDir(t, 'position-source-worker-kill-');
    const side = createSideDb(dir);
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
    job = dispatchPositionImportPreflight(sourceWorkerInput(dir, side, [filePath], {
      onProgress: (event) => {
        if (!terminated
            && event.stage === 'importing'
            && Number(event.scannedRows) >= 4000) {
          terminated = true;
          job.terminate();
        }
      }
    }));
    await assert.rejects(
      job.promise,
      (error) => error && error.code === 'position-import-worker-exited'
    );
    assert.equal(terminated, true);
    assert.equal(countRows(side.sideDbPath, 'position_source_rows'), 0);
    assert.equal(countRows(side.sideDbPath, 'position_raw_files'), 0);
    const db = new DatabaseSync(side.sideDbPath, { readOnly: true });
    try {
      assert.deepEqual(readPositionDatabaseCheckpoint(db), side.checkpoint);
    } finally {
      db.close();
    }
    assert.equal(
      fs.existsSync(path.join(dir, 'worker-user-data', STAGING_RELATIVE_PATH, job.jobId)),
      false
    );
  });

  test('四类普通来源单遍导入保持 0/hidden/visible/双腿派生语义，整批只推进一次 checkpoint', async (t) => {
    const dir = tempDir(t, 'position-source-derivation-');
    const side = createSideDb(dir);
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

    const result = await dispatchPositionImportPreflight(sourceWorkerInput(dir, side, files, {
      authorizeApply: (ready) => ({
        batchContext: MUTATING_BATCH_CONTEXT,
        operationToken: 'source-derivation-operation',
        archiveManifestHash: ready.archiveManifestHash,
        baseCheckpoint: side.checkpoint
      })
    })).promise;
    assert.equal(result.status, 'ok');
    assert.equal(result.successCount, 4);
    assert.deepEqual(result.cleanupPaths, [result.jobRoot]);
    assert.deepEqual(
      result.results.map((item) => [item.sourceType, item.rowCount]),
      [
        [SOURCE_TYPES.FUND_TRANSFER, 2],
        [SOURCE_TYPES.TEST_PAYMENT, 2],
        [SOURCE_TYPES.GATEWAY_INBOUND, 3],
        [SOURCE_TYPES.GATEWAY_OUTBOUND, 1]
      ]
    );

    const db = new DatabaseSync(side.sideDbPath, { readOnly: true });
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
    // 四份文件在一个事务里提交：checkpoint 只推进一次，四份文件凭证记在同一个操作下。
    assert.equal(readPositionDatabaseCheckpoint(db).generation, 1);
    assert.equal(
      Number(db.prepare(
        'SELECT COUNT(*) AS count FROM position_operation_inputs WHERE operation_token = ?'
      ).get('source-derivation-operation').count),
      4
    );
  });

  // ── 链接原始表单遍导入：进程内执行，覆盖授权、过滤与恢复 ────────────────────────

  test('写入授权与本次导入不一致（清单摘要或基准 checkpoint）时拒绝提交并回滚', async (t) => {
    const dir = tempDir(t, 'position-source-grant-mismatch-');
    const side = createSideDb(dir);
    const filePath = sourceFile(
      dir,
      SOURCE_TYPES.GATEWAY_OUTBOUND,
      [sourceRows()[SOURCE_TYPES.GATEWAY_OUTBOUND]],
      'grant.xlsx'
    );
    const attempt = (jobId, mutate) => importSources({
      dir, files: [filePath], ...side, jobId,
      grant: (ready) => mutate({
        jobId,
        archiveManifestHash: ready.archiveManifestHash,
        operationToken: 'grant-operation',
        baseCheckpoint: side.checkpoint,
        batchContext: MUTATING_BATCH_CONTEXT
      })
    });
    const notDurable = (error) => error && error.code === 'position-import-intent-not-durable';
    await assert.rejects(attempt('grant-manifest', (grant) => ({ ...grant, archiveManifestHash: 'f'.repeat(64) })), notDurable);
    await assert.rejects(attempt('grant-checkpoint', (grant) => ({
      ...grant, baseCheckpoint: { ...side.checkpoint, token: 'other-token' }
    })), notDurable);
    await assert.rejects(attempt('grant-token', (grant) => ({ ...grant, operationToken: '' })), notDurable);
    await assert.rejects(attempt('grant-batch', (grant) => ({ ...grant, batchContext: null })), notDurable);
    // 有可提交文件时不接受「仅预检」授权。
    await assert.rejects(attempt('grant-preflight-only', (grant) => ({ ...grant, preflightOnly: true })), notDurable);
    assert.equal(countRows(side.sideDbPath, 'position_source_rows'), 0);
    assert.equal(countRows(side.sideDbPath, 'position_raw_files'), 0);
    assert.deepEqual(fs.readdirSync(path.join(dir, 'worker-user-data', STAGING_RELATIVE_PATH)), []);

    const { result } = await attempt('grant-ok', (grant) => grant);
    assert.equal(result.successCount, 1);
    assert.equal(result.nextCheckpoint.generation, 1);
  });

  test('预置取消标记时在复制暂存前终止，不留暂存目录', async (t) => {
    const dir = tempDir(t, 'position-source-cancel-');
    const side = createSideDb(dir);
    const filePath = sourceFile(
      dir,
      SOURCE_TYPES.GATEWAY_OUTBOUND,
      [sourceRows()[SOURCE_TYPES.GATEWAY_OUTBOUND]],
      'cancel.xlsx'
    );
    await assert.rejects(
      importSources({ dir, files: [filePath], ...side, jobId: 'cancel-job', cancelToken: { cancelled: true } }),
      (error) => error.code === 'position-import-cancelled'
    );
    assert.equal(
      fs.existsSync(path.join(dir, 'worker-user-data', STAGING_RELATIVE_PATH, 'cancel-job')),
      false
    );
  });

  test('整份文件都是过滤行：文件仍被接受并登记过滤记录与版本，不产生来源行与链接行', async (t) => {
    const dir = tempDir(t, 'position-source-all-filtered-');
    const side = createSideDb(dir);
    const filePath = sourceFile(dir, SOURCE_TYPES.FUND_TRANSFER, [{
      ...sourceRows()[SOURCE_TYPES.FUND_TRANSFER],
      调拨单号: 'FT-ALL-FILTERED',
      调拨状态: '处理中',
      付款金额: ''
    }], 'all-filtered.xlsx');

    const { result } = await importSources({ dir, files: [filePath], ...side, jobId: 'all-filtered-job' });
    assert.equal(result.successCount, 1);
    assert.equal(result.results[0].rowCount, 0);
    assert.equal(result.results[0].filteredRowCount, 1);
    assert.ok(fs.existsSync(result.anomalyReport.filePath));
    assert.equal(result.outputFiles.length, 1);
    assert.deepEqual(result.outputFiles[0].requiredInputPaths, [path.resolve(result.results[0].archivePath)]);
    assert.equal(countRows(side.sideDbPath, 'position_source_rows'), 0);
    assert.equal(countRows(side.sideDbPath, 'position_link_rows'), 0);
    const db = new DatabaseSync(side.sideDbPath, { readOnly: true });
    t.after(() => db.close());
    assert.deepEqual(
      db.prepare(`
        SELECT filtered.business_key AS businessKey, filtered.archive_operation_key AS archiveKey,
               raw.original_name AS fileName, raw.status, raw.row_count AS rowCount
        FROM position_filtered_source_rows filtered
        JOIN position_raw_files raw ON raw.version = filtered.raw_version
      `).all().map((row) => ({ ...row })),
      [{
        businessKey: 'FT-ALL-FILTERED',
        archiveKey: 'position:source-import-operation:position-reconciliation:source:prepare-import',
        fileName: 'all-filtered.xlsx',
        // 仍有未处理的过滤记录引用该版本：保持当前。
        status: 'active',
        rowCount: 1
      }]
    );
  });

  test('过滤行与正常记录同单号：不论先后与是否同批，含过滤行的文件整份拒绝且不动已有记录', async (t) => {
    const dir = tempDir(t, 'position-source-filter-collision-');
    const side = createSideDb(dir);
    const base = sourceRows()[SOURCE_TYPES.FUND_TRANSFER];
    const normal = sourceFile(dir, SOURCE_TYPES.FUND_TRANSFER, [{ ...base, 调拨单号: 'FT-SAME' }], 'normal.xlsx');
    const filtered = sourceFile(dir, SOURCE_TYPES.FUND_TRANSFER, [{
      ...base, 调拨单号: 'FT-SAME', 调拨状态: '处理中', 付款金额: ''
    }], 'filtered.xlsx');

    // 同批：正常记录在前。
    const first = await importSources({ dir, files: [normal, filtered], ...side, jobId: 'collision-batch' });
    assert.deepEqual(first.result.results.map((item) => item.status), ['ok', 'failed']);
    assert.equal(first.result.results[1].code, 'position-filtered-key-collision');
    assert.deepEqual(first.result.results[1].detailLines, ['FT-SAME：同批正常记录位于第 1 个文件第 2 行']);
    assert.equal(countRows(side.sideDbPath, 'position_source_rows'), 1);
    assert.equal(countRows(side.sideDbPath, 'position_filtered_source_rows'), 0);

    // 另一次导入：库里已有正常记录。全部文件被拒时不推进 checkpoint。
    const second = await importSources({
      dir, files: [filtered], sideDbPath: side.sideDbPath, checkpoint: first.result.nextCheckpoint,
      jobId: 'collision-existing',
      grant: (ready) => ({ jobId: 'collision-existing', archiveManifestHash: ready.archiveManifestHash, preflightOnly: true })
    });
    assert.equal(second.result.status, 'failed');
    assert.equal(second.result.results[0].code, 'position-filtered-key-collision');
    assert.deepEqual(second.result.results[0].detailLines, ['FT-SAME：当前数据库已存在正常记录']);
    assert.equal(countRows(side.sideDbPath, 'position_source_rows'), 1);
    assert.equal(countRows(side.sideDbPath, 'position_filtered_source_rows'), 0);
    const db = new DatabaseSync(side.sideDbPath, { readOnly: true });
    t.after(() => db.close());
    assert.deepEqual(readPositionDatabaseCheckpoint(db), first.result.nextCheckpoint);
    assert.equal(
      fs.existsSync(path.join(dir, 'worker-user-data', STAGING_RELATIVE_PATH, 'collision-existing')),
      false
    );
  });

  test('异常报告写不出来时只拒绝含过滤行的文件，其余文件照常提交', async (t) => {
    const dir = tempDir(t, 'position-source-report-failure-');
    const side = createSideDb(dir);
    const base = sourceRows();
    const withFiltered = sourceFile(dir, SOURCE_TYPES.FUND_TRANSFER, [
      base[SOURCE_TYPES.FUND_TRANSFER],
      { ...base[SOURCE_TYPES.FUND_TRANSFER], 调拨单号: 'FT-FILTERED', 调拨状态: '处理中', 付款金额: '' }
    ], 'with-filtered.xlsx');
    const plain = sourceFile(dir, SOURCE_TYPES.GATEWAY_OUTBOUND, [base[SOURCE_TYPES.GATEWAY_OUTBOUND]], 'plain.xlsx');

    const { result } = await importSources({
      dir, files: [withFiltered, plain], ...side, jobId: 'report-failure-job',
      writeAnomalyReport: async () => { throw new Error('磁盘写入失败'); }
    });
    assert.deepEqual(result.results.map((item) => item.status), ['failed', 'ok']);
    assert.equal(result.results[0].code, 'position-anomaly-report-failed');
    assert.deepEqual(result.results[0].detailLines, ['磁盘写入失败']);
    assert.equal(result.anomalyReport, null);
    assert.deepEqual(result.outputFiles, []);
    const db = new DatabaseSync(side.sideDbPath, { readOnly: true });
    t.after(() => db.close());
    assert.deepEqual(
      db.prepare('SELECT source_type AS sourceType FROM position_source_rows').all().map((row) => row.sourceType),
      [SOURCE_TYPES.GATEWAY_OUTBOUND]
    );
    assert.equal(Number(db.prepare('SELECT COUNT(*) AS count FROM position_filtered_source_rows').get().count), 0);
    assert.deepEqual(
      db.prepare('SELECT original_name AS name FROM position_raw_files').all().map((row) => row.name),
      ['plain.xlsx']
    );
  });

  test('两份文件互为「过滤行撞对方正常记录」：全部读完后统一裁决，两份都拒绝，结果与文件顺序无关', async (t) => {
    const base = sourceRows()[SOURCE_TYPES.FUND_TRANSFER];
    const filteredOf = (key) => ({ ...base, 调拨单号: key, 调拨状态: '处理中', 付款金额: '' });
    for (const order of ['a-first', 'b-first']) {
      const dir = tempDir(t, `position-source-mutual-collision-${order}-`);
      const side = createSideDb(dir);
      const a = sourceFile(dir, SOURCE_TYPES.FUND_TRANSFER, [{ ...base, 调拨单号: 'FT-X' }, filteredOf('FT-Y')], 'a.xlsx');
      const b = sourceFile(dir, SOURCE_TYPES.FUND_TRANSFER, [{ ...base, 调拨单号: 'FT-Y' }, filteredOf('FT-X')], 'b.xlsx');
      const jobId = `mutual-collision-${order}`;
      const { result } = await importSources({
        dir, files: order === 'a-first' ? [a, b] : [b, a], ...side, jobId,
        grant: (ready) => ({ jobId, archiveManifestHash: ready.archiveManifestHash, preflightOnly: true })
      });
      assert.equal(result.status, 'failed', order);
      assert.deepEqual(
        result.results.map((item) => item.code),
        ['position-filtered-key-collision', 'position-filtered-key-collision'],
        order
      );
      assert.equal(countRows(side.sideDbPath, 'position_source_rows'), 0, order);
      assert.equal(countRows(side.sideDbPath, 'position_filtered_source_rows'), 0, order);
      assert.equal(countRows(side.sideDbPath, 'position_raw_files'), 0, order);
      const db = new DatabaseSync(side.sideDbPath, { readOnly: true });
      try {
        assert.deepEqual(readPositionDatabaseCheckpoint(db), side.checkpoint, order);
      } finally {
        db.close();
      }
    }
  });

  test('写库时的数据库错误不当成单个坏文件：整批回滚，其余文件也不提交', async (t) => {
    const dir = tempDir(t, 'position-source-sqlite-failure-');
    const side = createSideDb(dir);
    const setupDb = new DatabaseSync(side.sideDbPath);
    setupDb.exec(`
      CREATE TRIGGER position_test_fail_insert BEFORE INSERT ON position_source_rows
      WHEN NEW.business_key = 'FT-BOOM'
      BEGIN SELECT RAISE(ABORT, 'simulated sqlite failure'); END;
    `);
    setupDb.close();
    const base = sourceRows();
    const failing = sourceFile(dir, SOURCE_TYPES.FUND_TRANSFER, [
      { ...base[SOURCE_TYPES.FUND_TRANSFER], 调拨单号: 'FT-BOOM' }
    ], 'failing.xlsx');
    const plain = sourceFile(dir, SOURCE_TYPES.GATEWAY_OUTBOUND, [base[SOURCE_TYPES.GATEWAY_OUTBOUND]], 'plain.xlsx');

    await assert.rejects(
      importSources({ dir, files: [failing, plain], ...side, jobId: 'sqlite-failure-job' }),
      (error) => String(error && error.code || '').startsWith('ERR_SQLITE')
        && /simulated sqlite failure/.test(String(error.message))
    );
    assert.equal(countRows(side.sideDbPath, 'position_source_rows'), 0);
    assert.equal(countRows(side.sideDbPath, 'position_raw_files'), 0);
    const db = new DatabaseSync(side.sideDbPath, { readOnly: true });
    t.after(() => db.close());
    assert.deepEqual(readPositionDatabaseCheckpoint(db), side.checkpoint);
  });

  test('拿到写入授权后才到的取消不再提交；授权后的失败不删除已交接给 Main 的暂存文件', async (t) => {
    const dir = tempDir(t, 'position-source-cancel-after-grant-');
    const side = createSideDb(dir);
    const file = sourceFile(dir, SOURCE_TYPES.GATEWAY_OUTBOUND, [sourceRows()[SOURCE_TYPES.GATEWAY_OUTBOUND]]);
    const cancelToken = { cancelled: false };
    const jobId = 'cancel-after-grant-job';
    await assert.rejects(
      importSources({
        dir, files: [file], ...side, jobId, cancelToken,
        grant: (ready) => {
          cancelToken.cancelled = true;
          return {
            jobId, archiveManifestHash: ready.archiveManifestHash, operationToken: 'cancel-after-grant',
            baseCheckpoint: side.checkpoint, batchContext: MUTATING_BATCH_CONTEXT
          };
        }
      }),
      (error) => error && error.code === 'position-import-cancelled'
    );
    assert.equal(countRows(side.sideDbPath, 'position_source_rows'), 0);
    const db = new DatabaseSync(side.sideDbPath, { readOnly: true });
    t.after(() => db.close());
    assert.deepEqual(readPositionDatabaseCheckpoint(db), side.checkpoint);
    // 授权意味着 Main 已把暂存文件登记进待完成操作与存档清单：回收归 Main，导入进程不得删除。
    const stagedDir = path.join(dir, 'worker-user-data', STAGING_RELATIVE_PATH, jobId, '1');
    assert.equal(fs.existsSync(path.join(stagedDir, path.basename(file))), true);

    // 银行导入同样：授权后取消不提交，暂存保留。
    const bankDir = tempDir(t, 'position-bank-cancel-after-grant-');
    const bankSide = createSideDb(bankDir, 'bank-cancel');
    const bankPath = path.join(bankDir, 'bank.xlsx');
    writeWorkbook(bankPath, [{ name: BANK_SHEET_NAME, headers: POSITION_BANK_HEADERS, rows: [bankRow()] }]);
    const bankCancel = { cancelled: false };
    await assert.rejects(
      runPositionBankImport({
        jobId: 'bank-cancel-after-grant', files: [bankPath],
        userDataDir: path.join(bankDir, 'worker-user-data'),
        sideDbPath: bankSide.sideDbPath, expectedCheckpoint: bankSide.checkpoint,
        cancelToken: bankCancel,
        awaitApplyGrant: async () => {
          bankCancel.cancelled = true;
          return {
            jobId: 'bank-cancel-after-grant', operationToken: 'bank-cancel-after-grant',
            baseCheckpoint: bankSide.checkpoint, batchContext: MUTATING_BATCH_CONTEXT
          };
        }
      }),
      (error) => error && error.code === 'position-import-cancelled'
    );
    assert.equal(countRows(bankSide.sideDbPath, 'position_bank_rows'), 0);
    assert.equal(
      fs.existsSync(path.join(bankDir, 'worker-user-data', STAGING_RELATIVE_PATH, 'bank-cancel-after-grant', '1', 'bank.xlsx')),
      true
    );
  });

  test('来源记录标识、相等判断与落库对日期单元格用同一套表示；异常报告写出日期而不是内部标记', async (t) => {
    const date = new Date(Date.UTC(2026, 6, 20, 3, 4, 5));
    const asDate = { 调拨单号: 'FT-1', 交易时间: date };
    const asText = { 调拨单号: 'FT-1', 交易时间: date.toISOString() };
    assert.notEqual(sourceRecordKeyOf(asDate), sourceRecordKeyOf(asText));
    assert.equal(sameSourceFields(asDate, asText), false);
    // 落库再读回的日期与读取器给出的日期是同一个值、同一个标识。
    const revived = parseSourceFields(serializeSourceFields(asDate));
    assert.ok(revived['交易时间'] instanceof Date);
    assert.equal(sourceRecordKeyOf(revived), sourceRecordKeyOf(asDate));
    assert.equal(sameSourceFields(JSON.parse(serializeSourceFields(asDate)), asDate), true);
    // 不含日期的行标识不变（仍是字段对象的稳定摘要）。
    assert.equal(sourceRecordKeyOf({ a: '1', b: 2 }), stableHash({ a: '1', b: 2 }));

    const dir = tempDir(t, 'position-source-report-date-');
    const side = createSideDb(dir);
    const base = sourceRows()[SOURCE_TYPES.FUND_TRANSFER];
    const file = sourceFile(dir, SOURCE_TYPES.FUND_TRANSFER, [
      { ...base, 调拨单号: 'FT-DATE', 调拨状态: '处理中', 付款金额: '', 交易时间: new Date(2026, 6, 20) }
    ]);
    const { result } = await importSources({ dir, files: [file], ...side, jobId: 'report-date-job' });
    assert.equal(result.results[0].filteredRowCount, 1, JSON.stringify(result.results[0]));
    const workbook = XLSX.readFile(result.anomalyReport.filePath, { cellDates: true });
    const detail = XLSX.utils.sheet_to_json(workbook.Sheets['调拨异常明细'], { header: 1, raw: true });
    const column = detail[0].indexOf('交易时间');
    assert.ok(column >= 0);
    const cell = detail[1][column];
    assert.ok(cell instanceof Date, `交易时间应写成日期，实际：${JSON.stringify(cell)}`);
    assert.equal(JSON.stringify(detail).includes('__position_reconciliation_type__'), false);
  });

  test('单遍导入的磁盘门禁按暂存文件大小估算行数据与 WAL 增长，空间不足时在写库前拒绝', async (t) => {
    assert.equal(estimatePositionImportDiskBytes({
      kind: 'source', sideDbPath: path.join(os.tmpdir(), 'missing-position-side.sqlite'),
      stagedBytes: 1000, estimateGrowthFromStagedBytes: true, safetyMarginBytes: 0
    }).requiredBytes, BigInt(1000 + 1000 * POSITION_IMPORT_GROWTH_PER_STAGED_BYTE.source));
    assert.equal(estimatePositionImportDiskBytes({
      kind: 'bank', sideDbPath: path.join(os.tmpdir(), 'missing-position-side.sqlite'),
      stagedBytes: 1000, estimateGrowthFromStagedBytes: true, safetyMarginBytes: 0
    }).requiredBytes, BigInt(1000 + 1000 * POSITION_IMPORT_GROWTH_PER_STAGED_BYTE.bank));

    const dir = tempDir(t, 'position-source-disk-growth-');
    const side = createSideDb(dir);
    const file = sourceFile(dir, SOURCE_TYPES.GATEWAY_OUTBOUND, [sourceRows()[SOURCE_TYPES.GATEWAY_OUTBOUND]]);
    const staged = BigInt(fs.statSync(file).size);
    // 侧库现有占用含 -wal / -shm，只读连接也会留下 -shm：每次导入前按当时的文件重新计算。
    const requiredNow = () => existingStorageBytes(side.sideDbPath) + staged
      + staged * BigInt(POSITION_IMPORT_GROWTH_PER_STAGED_BYTE.source)
      + BigInt(POSITION_IMPORT_DISK_SAFETY_MARGIN_BYTES);
    await assert.rejects(
      importSources({ dir, files: [file], ...side, jobId: 'disk-growth-short', availableBytes: requiredNow() - 1n }),
      (error) => error && error.code === 'position-import-disk-space-insufficient'
    );
    assert.equal(countRows(side.sideDbPath, 'position_source_rows'), 0);
    const { result } = await importSources({
      dir, files: [file], ...side, jobId: 'disk-growth-enough', availableBytes: requiredNow()
    });
    assert.equal(result.results[0].status, 'ok');
  });

  test('账户表确认写入：重读期间暂存文件被改动即拒绝，旧账户表不变', async (t) => {
    const dir = tempDir(t, 'position-account-changed-during-read-');
    const side = createSideDb(dir);
    const base = sourceRows()[SOURCE_TYPES.BANK_ACCOUNT];
    // 行数超过一次进度间隔，才能在读取途中改动文件。
    const rows = Array.from({ length: 4100 }, (_item, index) => ({
      ...base, 账户状态: '正常', 银行账号: `BANK-${index}`, 系统账号: `SYS-${index}`
    }));
    const file = sourceFile(dir, SOURCE_TYPES.BANK_ACCOUNT, rows, 'account.xlsx');
    const jobId = 'account-changed-job';
    const { ready } = await importSources({
      dir, files: [file], ...side, jobId,
      grant: (value) => ({ jobId, archiveManifestHash: value.archiveManifestHash, preflightOnly: true })
    });
    const descriptor = ready.accountConfirmationDescriptor;
    assert.equal(descriptor.status, 'needs-confirmation');
    let touched = false;
    await assert.rejects(
      applyPositionAccountSnapshot({
        preflightReady: { jobId, jobRoot: ready.jobRoot, accountConfirmationDescriptor: descriptor },
        sideDbPath: side.sideDbPath,
        expectedCheckpoint: side.checkpoint,
        operationToken: 'account-changed-operation',
        batchContext: MUTATING_BATCH_CONTEXT,
        onProgress: () => {
          if (touched) return;
          touched = true;
          const later = new Date(Date.now() + 60_000);
          fs.utimesSync(descriptor.archivePath, later, later);
        }
      }),
      (error) => error && error.code === 'position-staged-input-changed'
    );
    assert.equal(touched, true);
    assert.equal(countRows(side.sideDbPath, 'position_source_rows'), 0);
    assert.equal(countRows(side.sideDbPath, 'position_raw_files'), 0);
  });

  test('银行行取值往返：与内部类型标记同前缀的原文、日期、布尔读回都是原值', () => {
    const fields = {
      BizId: 'B-1', Channel: 'DBS', FundType: 'Inbound', BillDate: new Date(Date.UTC(2026, 6, 20)),
      地区: 'HK', MerchantId: '00123', Currency: 'USD', 'Credit Amount': 100.5, 'Debit Amount': 0,
      ReconciliationId: '\u0001true', ChannelOrderNo: true, CustomerRef: '\u0001note',
      'Payee CardNo': '\u0001{"__position_reconciliation_type__":"Date","value":"2026-07-20T00:00:00.000Z"}',
      'Drawee CardNo': '', 'Extra Fee': ''
    };
    const stored = Object.fromEntries(
      bankValueColumnsFromFields(fields).map((value, index) => [BANK_VALUE_COLUMNS[index], value])
    );
    const restored = bankFieldsFromStoredRow({
      ...stored, biz_id: 'B-1', channel: 'DBS', original_fund_type: 'Inbound',
      raw_version: 1, raw_row_number: 2
    });
    for (const key of Object.keys(fields)) {
      assert.deepEqual(restored[key], fields[key], key);
    }
  });

  test('未识别文件的差异明细放进逐文件失败结果', async (t) => {
    const dir = tempDir(t, 'position-header-diff-import-');
    const side = createSideDb(dir);
    const filePath = path.join(dir, 'gateway.xlsx');
    writeWorkbook(filePath, [
      { name: '网关', headers: renamedHeaders(), rows: [sourceRows()[SOURCE_TYPES.GATEWAY_INBOUND]] }
    ]);
    const { ready, result } = await importSources({
      dir, files: [filePath], ...side, jobId: 'v3214-header-diff',
      grant: (value) => ({ jobId: 'v3214-header-diff', archiveManifestHash: value.archiveManifestHash, preflightOnly: true })
    });
    assert.equal(ready.acceptedOrdinaryInputFiles.length, 0);
    assert.equal(result.status, 'failed');
    assert.equal(result.orderedFileResults[0].code, 'position-source-unrecognized');
    assert.deepEqual(result.orderedFileResults[0].detailLines, [
      '最接近：中台网关原始入账订单（41 列；文件 41 列）',
      ...expectedLines.slice(1)
    ]);
  });

  test('提交后导入进程退出：按提交链、文件凭证与版本记录重建结果；未提交时不恢复', async (t) => {
    const dir = tempDir(t, 'position-source-recovery-');
    const side = createSideDb(dir);
    const base = sourceRows();
    const files = [
      sourceFile(dir, SOURCE_TYPES.GATEWAY_OUTBOUND, [base[SOURCE_TYPES.GATEWAY_OUTBOUND]], 'outbound.xlsx'),
      sourceFile(dir, SOURCE_TYPES.GATEWAY_INBOUND, [base[SOURCE_TYPES.GATEWAY_INBOUND]], 'inbound.xlsx'),
      sourceFile(dir, SOURCE_TYPES.GATEWAY_OUTBOUND, [{ ...base[SOURCE_TYPES.GATEWAY_OUTBOUND], 业务单号: '' }], 'invalid.xlsx')
    ];
    const recover = (preflightReady, operationToken = 'recovery-operation') => recoverPositionImportWorkerExit({
      sideDbPath: side.sideDbPath,
      baseCheckpoint: side.checkpoint,
      operationToken,
      preflightReady,
      command: POSITION_IMPORT_COMMANDS.SOURCE_IMPORT
    });

    // 未提交（授权被拒）：没有提交凭证，不恢复。
    let rejectedReady = null;
    await assert.rejects(importSources({
      dir, files, ...side, jobId: 'recovery-rejected', operationToken: 'recovery-operation',
      grant: (ready) => { rejectedReady = ready; throw Object.assign(new Error('拒绝'), { code: 'position-import-intent-not-durable' }); }
    }));
    assert.equal(recover(rejectedReady), null);

    const { ready, result } = await importSources({
      dir, files, ...side, jobId: 'recovery-committed', operationToken: 'recovery-operation'
    });
    assert.deepEqual(result.results.map((item) => item.status), ['ok', 'ok', 'failed']);
    const recovered = recover(ready);
    assert.equal(recovered.status, 'ok');
    assert.equal(recovered.recoveredFromWorkerExit, true);
    assert.equal(recovered.committedMutations, 1);
    assert.deepEqual(recovered.results.map((item) => item.status), ['ok', 'ok', 'failed']);
    assert.deepEqual(recovered.inputPaths, result.inputPaths.map((item) => path.resolve(item)));
    assert.deepEqual(recovered.nextCheckpoint, result.nextCheckpoint);
    assert.deepEqual(recovered.cleanupPaths, [ready.jobRoot]);

    // ready 与库内版本记录对不上（行数被改）时停止恢复，交给重启恢复处理。
    const tampered = structuredClone(ready);
    tampered.acceptedOrdinaryInputFiles[0].rowCount = 99;
    assert.throws(() => recover(tampered), (error) => error && error.code === 'position-recovery-required');
  });

});
