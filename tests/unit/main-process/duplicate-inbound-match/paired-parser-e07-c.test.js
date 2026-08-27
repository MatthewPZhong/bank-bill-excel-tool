'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const XLSX = require('xlsx');
const { DatabaseSync } = require('node:sqlite');

const { BANK_STATEMENT_FIELDS } = require('../../../../src/constants/bank-statement-fields');
const { BILL_HEADERS } = require('../../../../src/backend/acquiring-bill-currency-db/columns');
const {
  ensureDuplicateInboundMatchRunMetadataSupport
} = require('../../../../src/backend/database/migrations');
const {
  ensureBackgroundExecutionRecoveryControlSchema
} = require('../../../../src/backend/database/background-execution-schema');
const {
  createBackgroundExecutionRuntime,
  createNonProductionBackgroundExecutionRuntime
} = require('../../../../src/main-process/background-execution/runtime');
const {
  createResourceGovernor
} = require('../../../../src/main-process/background-execution/resource-governor');
const {
  executeDuplicateImportWithOptionalPairedParser,
  executeManagedDuplicatePairedImport,
  isPairedParserGateApproved,
  runDuplicateParserWorker
} = require('../../../../src/main-process/duplicate-inbound-match/paired-parser-dispatch');
const {
  DUPLICATE_SPOOL_FILE_NAMES,
  DUPLICATE_PAIRED_IMPORT_CONTRACT_VERSION,
  deriveSlotIdentity,
  duplicateSpoolPaths
} = require('../../../../src/main-process/duplicate-inbound-match/spool-contract');
const {
  cleanupDuplicateSpool,
  cleanupDuplicateSpoolParents
} = require('../../../../src/main-process/duplicate-inbound-match/spool-filesystem');
const {
  readDuplicateParserFailure,
  readDuplicateParserOutcome,
  writeDuplicateParserFailure,
  writeDuplicateParserSuccess
} = require('../../../../src/main-process/duplicate-inbound-match/parser-outcome');
const {
  consumeDuplicateInputSpool,
  readDuplicateSpoolManifest,
  validateDuplicateInputSpool,
  validateDuplicateSpoolPair
} = require('../../../../src/main-process/duplicate-inbound-match/spool-reader');
const {
  writeDuplicateInputSpool
} = require('../../../../src/main-process/duplicate-inbound-match/spool-writer');

const ROOT = path.resolve(__dirname, '../../../..');

function writeWorkbook(filePath, headers, sheetName, rows = []) {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([headers, ...rows]), sheetName);
  XLSX.writeFile(workbook, filePath);
}

function bankRow(overrides = {}) {
  return BANK_STATEMENT_FIELDS.map((field) => overrides[field] ?? '');
}

function documentRow(overrides = {}) {
  return BILL_HEADERS.map((field) => overrides[field] ?? '');
}

function pairedDescriptor(root, jobId, operationKey, taskRunId, filePaths) {
  return Object.freeze({
    contractVersion: DUPLICATE_PAIRED_IMPORT_CONTRACT_VERSION,
    spools: Object.freeze(filePaths.map((filePath, slotIndex) => Object.freeze({
      taskStagingDir: path.join(root, 'staging'),
      jobId,
      operationKey,
      producerTaskRunId: taskRunId,
      ...deriveSlotIdentity(slotIndex),
      source: Object.freeze({ filePath })
    })))
  });
}

function cleanupPair(pair) {
  for (const spool of pair.spools) {
    cleanupDuplicateSpool(spool);
    cleanupDuplicateSpoolParents(spool);
  }
}

function initializeMainDatabase(databasePath) {
  const db = new DatabaseSync(databasePath);
  ensureDuplicateInboundMatchRunMetadataSupport(db);
  ensureBackgroundExecutionRecoveryControlSchema(db);
  db.close();
}

function batchContext(operationKey, taskRunId = `task-${operationKey}`) {
  return Object.freeze({
    taskRunId,
    taskKey: 'duplicate-inbound-match:import-files',
    moduleId: 'duplicate',
    parentRunId: 'parent-duplicate-e07-c',
    operationKey
  });
}

function requiredWorkerDurableCoordinator() {
  return Object.freeze({
    prepareAndAck() { throw new Error('paired Parser不得伪造critical intent'); },
    observeReceipt() { throw new Error('paired Parser不得伪造commit receipt'); },
    settleCommitted() { throw new Error('paired Parser不得伪造settlement'); },
    resolveUncertain() { throw new Error('paired Parser不得进入unit recovery'); }
  });
}

function createRuntime(dir, databasePath, options = {}) {
  const resourceGovernor = createResourceGovernor({
    budgets: Object.freeze({
      cpuSlots: 8,
      workerThreadSlots: 8,
      utilityProcessSlots: 1,
      ioHeavySlots: 8,
      memoryBytes: 4 * (2 ** 30)
    })
  });
  const runtimeOptions = {
    resourceGovernor,
    availableParallelism: 8,
    freeMemoryBytes: 4 * (2 ** 30),
    totalMemoryBytes: 4 * (2 ** 30),
    memoryHardCeilingBytes: 2 * (2 ** 30),
    systemReserveBytes: 0,
    shutdownTimeoutMs: 10000,
    duplicateStartupGate: { contractVersion: 1, startupRecoveryReady: true },
    workerDurableCoordinator: requiredWorkerDurableCoordinator()
  };
  if (options.omitExecutionTimeout !== true) runtimeOptions.executionTimeoutMs = 10000;
  return createNonProductionBackgroundExecutionRuntime(runtimeOptions);
}

function createNativeRuntime() {
  return createBackgroundExecutionRuntime({
    availableParallelism: 8,
    freeMemoryBytes: 4 * (2 ** 30),
    totalMemoryBytes: 4 * (2 ** 30),
    memoryHardCeilingBytes: 2 * (2 ** 30),
    systemReserveBytes: 0,
    executionTimeoutMs: 10000,
    shutdownTimeoutMs: 10000,
    duplicateStartupGate: { contractVersion: 1, startupRecoveryReady: true },
    workerDurableCoordinator: requiredWorkerDurableCoordinator()
  });
}

function workerRuntime(dir, databasePath) {
  return Object.freeze({
    userDataDir: dir,
    databasePath,
    mailTemplatePath: path.join(ROOT, 'assets', '重复入金召回邮件模板.xlsx'),
    bankTemplatePath: path.join(ROOT, 'assets', '银行对账单.xlsx')
  });
}

function sideDatabasePath(dir) {
  const sideDir = path.join(dir, 'run-data', 'duplicate-inbound-match');
  const fileName = fs.readdirSync(sideDir).find((name) => name.endsWith('.sqlite'));
  assert.ok(fileName, '必须生成一个Duplicate side DB');
  return path.join(sideDir, fileName);
}

function sideCounts(dir) {
  const db = new DatabaseSync(sideDatabasePath(dir), { readOnly: true });
  try {
    return Object.freeze({
      imports: Number(db.prepare('SELECT COUNT(*) AS count FROM duplicate_inbound_match_imports').get().count),
      bankRows: Number(db.prepare('SELECT COUNT(*) AS count FROM duplicate_inbound_match_bank_rows').get().count),
      documentRows: Number(db.prepare('SELECT COUNT(*) AS count FROM duplicate_inbound_match_document_rows').get().count),
      receipts: Number(db.prepare('SELECT COUNT(*) AS count FROM duplicate_inbound_match_operation_receipts').get().count)
    });
  } finally {
    db.close();
  }
}

function sideImportSnapshots(dir) {
  const db = new DatabaseSync(sideDatabasePath(dir), { readOnly: true });
  try {
    return db.prepare(`
      SELECT id, bank_file_name, bank_content_hash, bank_row_count,
             document_file_name, document_content_hash, document_row_count,
             document_matchable_row_count, document_empty_order_count
      FROM duplicate_inbound_match_imports
      ORDER BY id ASC
    `).all().map((item) => {
      const receipt = db.prepare(`
        SELECT action_key, operation_key, producer_task_run_id, phase, month_key,
               import_bundle_id, side_run_id, input_evidence_hash
        FROM duplicate_inbound_match_operation_receipts
        WHERE import_bundle_id = ? AND action_key = 'duplicate:import'
      `).get(item.id);
      return Object.freeze({
        identity: Object.freeze({
          operationKey: receipt.operation_key,
          producerTaskRunId: receipt.producer_task_run_id,
          importBundleId: Number(receipt.import_bundle_id)
        }),
        postImage: Object.freeze({
          import: Object.freeze({
            bankFileName: item.bank_file_name,
            bankContentHash: item.bank_content_hash,
            bankRowCount: Number(item.bank_row_count),
            documentFileName: item.document_file_name,
            documentContentHash: item.document_content_hash,
            documentRowCount: Number(item.document_row_count),
            documentMatchableRowCount: Number(item.document_matchable_row_count),
            documentEmptyOrderCount: Number(item.document_empty_order_count)
          }),
          bankRows: Object.freeze(db.prepare(`
            SELECT source_ordinal, excel_row_number, biz_id, fund_type, raw_json
            FROM duplicate_inbound_match_bank_rows
            WHERE import_id = ? ORDER BY source_ordinal ASC
          `).all(item.id).map((row) => Object.freeze({ ...row }))),
          documentRows: Object.freeze(db.prepare(`
            SELECT source_ordinal, excel_row_number, business_order_no, business_order_key,
                   user_no, account_no, business_department
            FROM duplicate_inbound_match_document_rows
            WHERE import_id = ? ORDER BY source_ordinal ASC
          `).all(item.id).map((row) => Object.freeze({ ...row }))),
          receipt: Object.freeze({
            actionKey: receipt.action_key,
            phase: receipt.phase,
            monthKey: receipt.month_key,
            sideRunId: receipt.side_run_id,
            inputEvidenceHash: receipt.input_evidence_hash
          })
        })
      });
    });
  } finally {
    db.close();
  }
}

function parserResult(result) {
  return Object.freeze({ ...result, rssBytes: process.memoryUsage().rss });
}

async function withBlockedParserOutcomeWrites(taskStagingDir, callback) {
  const originalOpenSync = fs.openSync;
  const stagingRoot = path.resolve(taskStagingDir);
  fs.openSync = function blockedParserOutcomeOpen(filePath, ...args) {
    const absolutePath = typeof filePath === 'string' ? path.resolve(filePath) : '';
    if (absolutePath.startsWith(`${stagingRoot}${path.sep}`) &&
        path.basename(absolutePath) === DUPLICATE_SPOOL_FILE_NAMES.outcomePart) {
      throw Object.assign(new Error('injected parser outcome filesystem failure'), { code: 'EACCES' });
    }
    return originalOpenSync(filePath, ...args);
  };
  try {
    return await callback();
  } finally {
    fs.openSync = originalOpenSync;
  }
}

function assertNoDuplicateMutation(dir, databasePath) {
  const sideDir = path.join(dir, 'run-data', 'duplicate-inbound-match');
  if (fs.existsSync(sideDir)) {
    assert.deepEqual(sideCounts(dir), { imports: 0, bankRows: 0, documentRows: 0, receipts: 0 });
  }
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    assert.equal(Number(db.prepare(
      'SELECT COUNT(*) AS count FROM duplicate_inbound_match_run_mirrors'
    ).get().count), 0);
  } finally {
    db.close();
  }
}

test('两角色独立spool固定Bank→Document，完整hash/ordinal/identity守恒且manifest不泄漏业务行', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'duplicate-paired-spool-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bankPath = path.join(dir, 'bank.xlsx');
  const documentPath = path.join(dir, 'document.xlsx');
  writeWorkbook(bankPath, BANK_STATEMENT_FIELDS, '渠道对账单', [
    bankRow({ BizId: 'SENSITIVE-BIZ-1', FundType: 'Inbound' }),
    bankRow({ BizId: 'SENSITIVE-BIZ-2', FundType: 'Reversal' })
  ]);
  writeWorkbook(documentPath, BILL_HEADERS, '单据对账单', [
    documentRow({ 业务订单号: 'SENSITIVE-ORDER', 用户编号: 'U-1', 账户号: 'A-1' })
  ]);
  const pair = pairedDescriptor(dir, 'paired-spool-contract', 'op-spool', 'task-spool', [
    documentPath, bankPath
  ]);
  await Promise.all(pair.spools.map((spool) => writeDuplicateInputSpool(spool)));
  const validated = await validateDuplicateSpoolPair(pair);
  assert.deepEqual(validated.byRole.map((item) => item.role), ['bank', 'document']);
  assert.notEqual(validated.bank.paths.slotDir, validated.document.paths.slotDir);
  const bankRows = [];
  const documentRows = [];
  await consumeDuplicateInputSpool(validated.bank, (row) => bankRows.push(row));
  await consumeDuplicateInputSpool(validated.document, (row) => documentRows.push(row));
  assert.deepEqual(bankRows.map((row) => row.sourceOrdinal), [0, 1]);
  assert.deepEqual(documentRows.map((row) => row.sourceOrdinal), [0]);
  for (const spool of pair.spools) {
    const manifestText = fs.readFileSync(duplicateSpoolPaths(spool).manifestReady, 'utf8');
    assert.equal(manifestText.includes('SENSITIVE-BIZ'), false);
    assert.equal(manifestText.includes('SENSITIVE-ORDER'), false);
  }
  const bankManifestPath = duplicateSpoolPaths(validated.bank.descriptor).manifestReady;
  const originalManifest = JSON.parse(fs.readFileSync(bankManifestPath, 'utf8'));
  for (const [field, value] of [
    ['jobId', 'different-job'],
    ['operationKey', 'different-operation'],
    ['producerTaskRunId', 'different-owner'],
    ['slotIndex', originalManifest.slotIndex === 0 ? 1 : 0],
    ['unitId', originalManifest.unitId === 'slot:0' ? 'slot:1' : 'slot:0']
  ]) {
    fs.writeFileSync(bankManifestPath, `${JSON.stringify({ ...originalManifest, [field]: value })}\n`);
    assert.throws(
      () => readDuplicateSpoolManifest(validated.bank.descriptor),
      (error) => error.code === 'DUPLICATE_SPOOL_IDENTITY_MISMATCH',
      field
    );
  }
  fs.writeFileSync(bankManifestPath, `${JSON.stringify(originalManifest)}\n`);
  cleanupPair(pair);
  assert.equal(fs.existsSync(path.join(dir, 'staging')), false);
});

test('spool或源文件内容同计数变化仍被TOCTOU/hash校验拒绝', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'duplicate-paired-toctou-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bankPath = path.join(dir, 'bank.xlsx');
  const documentPath = path.join(dir, 'document.xlsx');
  writeWorkbook(bankPath, BANK_STATEMENT_FIELDS, '渠道对账单', [bankRow({ BizId: 'HASH-A' })]);
  writeWorkbook(documentPath, BILL_HEADERS, '单据对账单');
  const pair = pairedDescriptor(dir, 'paired-toctou', 'op-toctou', 'task-toctou', [
    bankPath, documentPath
  ]);
  await Promise.all(pair.spools.map((spool) => writeDuplicateInputSpool(spool)));
  const bankSpool = pair.spools[0];
  const prevalidatedBank = await validateDuplicateInputSpool(bankSpool);
  const manifestPath = duplicateSpoolPaths(bankSpool).manifestReady;
  const originalManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  fs.writeFileSync(manifestPath, `${JSON.stringify({
    ...originalManifest,
    classification: {
      ...originalManifest.classification,
      sheetNames: [...originalManifest.classification.sheetNames, '校验后变化']
    }
  })}\n`);
  await assert.rejects(
    () => validateDuplicateInputSpool(prevalidatedBank),
    (error) => error.code === 'DUPLICATE_SPOOL_MANIFEST_CHANGED'
  );
  fs.writeFileSync(manifestPath, `${JSON.stringify(originalManifest)}\n`);
  const rowsPath = duplicateSpoolPaths(bankSpool).rowsReady;
  const original = fs.readFileSync(rowsPath, 'utf8');
  fs.writeFileSync(rowsPath, original.replaceAll('HASH-A', 'HASH-B'));
  await assert.rejects(
    () => validateDuplicateInputSpool(bankSpool),
    (error) => error.code === 'DUPLICATE_SPOOL_COUNT_MISMATCH'
  );
  fs.writeFileSync(rowsPath, original);
  writeWorkbook(bankPath, BANK_STATEMENT_FIELDS, '渠道对账单', [bankRow({ BizId: 'HASH-C' })]);
  await assert.rejects(
    () => validateDuplicateInputSpool(bankSpool),
    (error) => error.code === 'DUPLICATE_SPOOL_SOURCE_CHANGED'
  );
  cleanupPair(pair);
});

test('terminal outcome精确绑定job/op/owner/slot且failure只保存脱敏causeCode', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'duplicate-paired-outcome-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const sourcePath = path.join(dir, 'source.xlsx');
  fs.writeFileSync(sourcePath, 'not-read-by-outcome');
  const pair = pairedDescriptor(dir, 'paired-outcome', 'op-outcome', 'task-outcome', [
    sourcePath, path.join(dir, 'unused.xlsx')
  ]);
  const spool = pair.spools[0];
  writeDuplicateParserFailure(
    spool,
    Object.assign(new Error('/private/secret/PERSONAL-BIZ'), { code: 'PARSER_EXACT_FAILURE' })
  );
  const outcomePath = duplicateSpoolPaths(spool).outcomeReady;
  const original = JSON.parse(fs.readFileSync(outcomePath, 'utf8'));
  assert.equal(readDuplicateParserFailure(spool).causeCode, 'PARSER_EXACT_FAILURE');
  assert.equal(fs.readFileSync(outcomePath, 'utf8').includes('PERSONAL-BIZ'), false);
  for (const [field, value] of [
    ['jobId', 'different-job'],
    ['operationKey', 'different-operation'],
    ['producerTaskRunId', 'different-owner'],
    ['slotIndex', 1]
  ]) {
    fs.writeFileSync(outcomePath, `${JSON.stringify({ ...original, [field]: value })}\n`);
    assert.throws(
      () => readDuplicateParserFailure(spool),
      (error) => error.code === 'DUPLICATE_PARSER_OUTCOME_INVALID',
      field
    );
  }
  fs.writeFileSync(outcomePath, `${JSON.stringify(original)}\n`);
  assert.throws(
    () => writeDuplicateParserSuccess(spool, { role: 'bank', rowCount: 1 }),
    (error) => error.code === 'DUPLICATE_PARSER_OUTCOME_CONFLICT'
  );
  cleanupDuplicateSpool(spool);
  cleanupDuplicateSpoolParents(spool);

  const successSpool = pair.spools[1];
  writeDuplicateParserSuccess(successSpool, { role: 'document', rowCount: 7 });
  assert.deepEqual(readDuplicateParserOutcome(successSpool), {
    schemaVersion: 1,
    jobId: 'paired-outcome',
    operationKey: 'op-outcome',
    producerTaskRunId: 'task-outcome',
    slotIndex: 1,
    unitId: 'slot:1',
    status: 'succeeded',
    role: 'document',
    rowCount: 7
  });
  cleanupDuplicateSpool(successSpool);
  cleanupDuplicateSpoolParents(successSpool);
});

test('真实Parser Worker只返回bounded manifest且clean exit后才成功', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'duplicate-paired-worker-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bankPath = path.join(dir, 'bank.xlsx');
  const documentPath = path.join(dir, 'document.xlsx');
  writeWorkbook(bankPath, BANK_STATEMENT_FIELDS, '渠道对账单', [bankRow({ BizId: 'WORKER-BIZ' })]);
  writeWorkbook(documentPath, BILL_HEADERS, '单据对账单');
  const pair = pairedDescriptor(dir, 'paired-real-worker', 'op-worker', 'task-worker', [
    bankPath, documentPath
  ]);
  const results = await Promise.all(pair.spools.map((spool) => runDuplicateParserWorker(spool)));
  assert.deepEqual(results.map((result) => result.role), ['bank', 'document']);
  assert.equal(JSON.stringify(results).includes('WORKER-BIZ'), false);
  await validateDuplicateSpoolPair(pair);
  cleanupPair(pair);
});

test('乱序Parser完成不改变Bank→Document采用；single等价且exact replay不增加side mutation', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'duplicate-paired-runtime-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const databasePath = path.join(dir, 'tool-data.sqlite');
  initializeMainDatabase(databasePath);
  const bankPath = path.join(dir, 'bank.xlsx');
  const documentPath = path.join(dir, 'document.xlsx');
  writeWorkbook(bankPath, BANK_STATEMENT_FIELDS, '渠道对账单', [
    bankRow({ BizId: 'PAIR-BIZ-1', FundType: 'Inbound' }),
    bankRow({ BizId: 'PAIR-BIZ-2', FundType: 'Reversal' })
  ]);
  writeWorkbook(documentPath, BILL_HEADERS, '单据对账单', [
    documentRow({ 业务订单号: 'PAIR-ORDER', 用户编号: 'PAIR-U', 账户号: 'PAIR-A' })
  ]);
  const runtime = createRuntime(dir, databasePath);
  let shutdown = false;
  t.after(async () => { if (!shutdown) await runtime.shutdown({ timeoutMs: 10000 }); });
  const legacyContext = batchContext('single-equivalence');
  const single = await runtime.execute({
    actionKey: 'duplicate:import',
    operationKey: legacyContext.operationKey,
    production: false,
    context: { kind: 'operation', value: legacyContext },
    input: { runtime: workerRuntime(dir, databasePath), filePaths: [bankPath, documentPath] }
  });
  assert.equal(single.outcome, 'completed');

  const completionOrder = [];
  const pairedContext = batchContext('paired-equivalence');
  const parserRunner = async (spool) => {
    const result = await writeDuplicateInputSpool(spool);
    if (spool.slotIndex === 0) await new Promise((resolve) => setTimeout(resolve, 40));
    return parserResult(result);
  };
  const paired = await executeManagedDuplicatePairedImport({
    runtime,
    workerRuntime: workerRuntime(dir, databasePath),
    filePaths: [bankPath, documentPath],
    taskStagingDir: path.join(dir, 'paired-staging'),
    batchContext: pairedContext,
    parserRunner,
    onParserComplete(result) { completionOrder.push(result.role); }
  });
  assert.equal(paired.outcome, 'completed');
  assert.deepEqual(completionOrder, ['document', 'bank']);
  assert.deepEqual(paired.result.summary, single.result.summary);
  assert.equal(paired.pairedParser.effectiveWorkerCount, 2);
  assert.equal(fs.existsSync(path.join(dir, 'paired-staging')), false);
  assert.deepEqual(sideCounts(dir), { imports: 2, bankRows: 4, documentRows: 2, receipts: 2 });
  const [singleSnapshot, pairedSnapshot] = sideImportSnapshots(dir);
  assert.deepEqual(pairedSnapshot.postImage, singleSnapshot.postImage);
  assert.deepEqual(singleSnapshot.identity, {
    operationKey: legacyContext.operationKey,
    producerTaskRunId: legacyContext.taskRunId,
    importBundleId: 1
  });
  assert.deepEqual(pairedSnapshot.identity, {
    operationKey: pairedContext.operationKey,
    producerTaskRunId: pairedContext.taskRunId,
    importBundleId: 2
  });

  const replay = await executeManagedDuplicatePairedImport({
    runtime,
    workerRuntime: workerRuntime(dir, databasePath),
    filePaths: [documentPath, bankPath],
    taskStagingDir: path.join(dir, 'paired-replay-staging'),
    batchContext: pairedContext,
    parserRunner: async (spool) => parserResult(await writeDuplicateInputSpool(spool))
  });
  assert.equal(replay.outcome, 'completed');
  assert.deepEqual(replay.result.summary, paired.result.summary);
  assert.deepEqual(sideCounts(dir), { imports: 2, bankRows: 4, documentRows: 2, receipts: 2 });
  const report = await runtime.shutdown({ timeoutMs: 10000 });
  shutdown = true;
  assert.deepEqual(report.errors, []);
  assert.deepEqual(report.leakedTransports, []);
});

test('Parser单侧失败时reservation阻断import/run/export且零side/Main/adopt、双spool清理', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'duplicate-paired-failure-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const databasePath = path.join(dir, 'tool-data.sqlite');
  initializeMainDatabase(databasePath);
  const bankPath = path.join(dir, 'bank.xlsx');
  const documentPath = path.join(dir, 'document.xlsx');
  writeWorkbook(bankPath, BANK_STATEMENT_FIELDS, '渠道对账单', [bankRow({ BizId: 'FAIL-BIZ' })]);
  writeWorkbook(documentPath, BILL_HEADERS, '单据对账单');
  const runtime = createRuntime(dir, databasePath);
  let shutdown = false;
  t.after(async () => { if (!shutdown) await runtime.shutdown({ timeoutMs: 10000 }); });
  let started = 0;
  let resolveStarted;
  const allStarted = new Promise((resolve) => { resolveStarted = resolve; });
  let rejectBank;
  const parserRunner = (spool, { signal }) => {
    started += 1;
    if (started === 2) resolveStarted();
    if (spool.slotIndex === 0) {
      return new Promise((_resolve, reject) => { rejectBank = reject; });
    }
    return new Promise((_resolve, reject) => {
      const fail = () => reject(Object.assign(new Error('cancelled sibling'), {
        code: 'DUPLICATE_PARSER_CANCELLED'
      }));
      if (signal.aborted) fail();
      else signal.addEventListener('abort', fail, { once: true });
    });
  };
  const context = batchContext('paired-failure');
  const pairedPromise = executeManagedDuplicatePairedImport({
    runtime,
    workerRuntime: workerRuntime(dir, databasePath),
    filePaths: [bankPath, documentPath],
    taskStagingDir: path.join(dir, 'failure-staging'),
    batchContext: context,
    parserRunner
  });
  await allStarted;
  const conflictInputs = [
    ['duplicate:import', { runtime: workerRuntime(dir, databasePath), filePaths: [bankPath, documentPath] }],
    ['duplicate:run', { runtime: workerRuntime(dir, databasePath) }],
    ['duplicate:export', { runtime: workerRuntime(dir, databasePath), savePath: path.join(dir, 'x.xlsx') }]
  ];
  const conflictDurations = [];
  for (const [actionKey, input] of conflictInputs) {
    const conflictStartedAt = Date.now();
    const operationKey = `${context.operationKey}-${actionKey}`;
    const result = await runtime.execute({
      actionKey,
      operationKey,
      production: false,
      context: { kind: 'operation', value: batchContext(operationKey) },
      input
    });
    assert.ok(['failed', 'transport-lost'].includes(result.outcome));
    assert.equal(result.error.code, 'SERVICE_BUSY');
    conflictDurations.push(Date.now() - conflictStartedAt);
  }
  assert.equal(conflictDurations.every((duration) => duration < 1000), true);
  rejectBank(Object.assign(new Error('injected parser failure'), { code: 'PARSER_INJECTED' }));
  const failureStartedAt = Date.now();
  await assert.rejects(pairedPromise, (error) => error.code === 'PARSER_INJECTED');
  const failureDuration = Date.now() - failureStartedAt;
  assert.equal(fs.existsSync(path.join(dir, 'run-data', 'duplicate-inbound-match')), false);
  assert.equal(fs.existsSync(path.join(dir, 'failure-staging')), false);
  const db = new DatabaseSync(databasePath, { readOnly: true });
  assert.equal(Number(db.prepare(
    'SELECT COUNT(*) AS count FROM duplicate_inbound_match_run_mirrors'
  ).get().count), 0);
  db.close();
  const shutdownStartedAt = Date.now();
  const report = await runtime.shutdown({ timeoutMs: 10000 });
  const shutdownDuration = Date.now() - shutdownStartedAt;
  shutdown = true;
  assert.deepEqual(report.errors, []);
  assert.deepEqual(report.leakedTransports, []);
  assert.equal(failureDuration < 1000, true, `failure barrier耗时${failureDuration}ms`);
  assert.equal(shutdownDuration < 1000, true, `shutdown耗时${shutdownDuration}ms`);
});

test('failure outcome发布EACCES时无execution timeout也权威终态并释放reservation/lease', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'duplicate-paired-failure-outcome-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const databasePath = path.join(dir, 'tool-data.sqlite');
  initializeMainDatabase(databasePath);
  const bankPath = path.join(dir, 'bank.xlsx');
  const documentPath = path.join(dir, 'document.xlsx');
  writeWorkbook(bankPath, BANK_STATEMENT_FIELDS, '渠道对账单');
  writeWorkbook(documentPath, BILL_HEADERS, '单据对账单');
  const runtime = createRuntime(dir, databasePath, { omitExecutionTimeout: true });
  let shutdown = false;
  t.after(async () => { if (!shutdown) await runtime.shutdown({ timeoutMs: 10000 }); });
  const taskStagingDir = path.join(dir, 'failure-outcome-staging');
  const jobId = 'paired-failure-outcome-no-timeout';
  const parserError = Object.assign(new Error('injected parser business failure'), {
    code: 'PARSER_INJECTED'
  });
  let started = 0;
  let resolveStarted;
  const allStarted = new Promise((resolve) => { resolveStarted = resolve; });
  let rejectPrimary;
  let siblingAborted = false;
  let cleanupTerminalChecks = 0;
  let rejection = null;
  let failedAt = 0;
  await withBlockedParserOutcomeWrites(taskStagingDir, async () => {
    const pairedPromise = executeManagedDuplicatePairedImport({
      runtime,
      workerRuntime: workerRuntime(dir, databasePath),
      filePaths: [bankPath, documentPath],
      taskStagingDir,
      batchContext: batchContext('paired-failure-outcome'),
      jobId,
      cleanupSpool(spool) {
        cleanupTerminalChecks += 1;
        assert.equal(runtime.inspect(jobId), null, 'spool cleanup必须晚于parent terminal');
        return cleanupDuplicateSpool(spool);
      },
      parserRunner(spool, { signal }) {
        started += 1;
        if (started === 2) resolveStarted();
        if (spool.slotIndex === 0) {
          return new Promise((_resolve, reject) => { rejectPrimary = reject; });
        }
        return new Promise((_resolve, reject) => {
          const abort = () => {
            siblingAborted = true;
            reject(Object.assign(new Error('sibling aborted'), {
              code: 'DUPLICATE_PARSER_CANCELLED'
            }));
          };
          if (signal.aborted) abort();
          else signal.addEventListener('abort', abort, { once: true });
        });
      }
    });
    await allStarted;
    failedAt = Date.now();
    rejectPrimary(parserError);
    try { await pairedPromise; } catch (error) { rejection = error; }
  });
  assert.equal(rejection instanceof AggregateError, true);
  assert.equal(rejection.code, 'DUPLICATE_PARSER_OUTCOME_PUBLISH_FAILED');
  assert.equal(rejection.cause, parserError, '原始Parser错误必须保留为cause');
  assert.deepEqual(rejection.errors.map((error) => error.code), ['PARSER_INJECTED', 'EACCES']);
  assert.equal(siblingAborted, true);
  assert.equal(cleanupTerminalChecks, 2);
  assert.equal(Date.now() - failedAt < 1000, true, 'parent terminal必须在1秒内完成');
  assert.equal(runtime.inspect(jobId), null);
  assert.equal(fs.existsSync(taskStagingDir), false);
  assertNoDuplicateMutation(dir, databasePath);
  const released = runtime.resourceGovernor.snapshot();
  assert.equal(released.activeLeaseCount, 0);
  assert.equal(released.activeDependencyCount, 0);

  const nextContext = batchContext('paired-failure-outcome-next-run');
  const nextStartedAt = Date.now();
  const next = await runtime.execute({
    actionKey: 'duplicate:run',
    operationKey: nextContext.operationKey,
    production: false,
    context: { kind: 'operation', value: nextContext },
    input: { runtime: workerRuntime(dir, databasePath) }
  });
  assert.notEqual(next.error && next.error.code, 'SERVICE_BUSY');
  assert.equal(Date.now() - nextStartedAt < 1000, true);
  assertNoDuplicateMutation(dir, databasePath);
  assert.equal(runtime.resourceGovernor.snapshot().activeLeases.some(
    (lease) => lease.kind === 'persistent'
  ), false, '失败paired与后续失败命令均不得adopt persistent reservation');
  const report = await runtime.shutdown({ timeoutMs: 10000 });
  shutdown = true;
  assert.deepEqual(report.errors, []);
  assert.deepEqual(report.leakedTransports, []);
});

test('success outcome发布EACCES时无execution timeout也中止sibling并保持零adopt', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'duplicate-paired-success-outcome-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const databasePath = path.join(dir, 'tool-data.sqlite');
  initializeMainDatabase(databasePath);
  const bankPath = path.join(dir, 'bank.xlsx');
  const documentPath = path.join(dir, 'document.xlsx');
  writeWorkbook(bankPath, BANK_STATEMENT_FIELDS, '渠道对账单', [bankRow({ BizId: 'SUCCESS-OUTCOME' })]);
  writeWorkbook(documentPath, BILL_HEADERS, '单据对账单');
  const runtime = createRuntime(dir, databasePath, { omitExecutionTimeout: true });
  let shutdown = false;
  t.after(async () => { if (!shutdown) await runtime.shutdown({ timeoutMs: 10000 }); });
  const taskStagingDir = path.join(dir, 'success-outcome-staging');
  const jobId = 'paired-success-outcome-no-timeout';
  let started = 0;
  let resolveStarted;
  const allStarted = new Promise((resolve) => { resolveStarted = resolve; });
  let siblingAborted = false;
  let cleanupTerminalChecks = 0;
  let rejection = null;
  let failedAt = 0;
  await withBlockedParserOutcomeWrites(taskStagingDir, async () => {
    const pairedPromise = executeManagedDuplicatePairedImport({
      runtime,
      workerRuntime: workerRuntime(dir, databasePath),
      filePaths: [bankPath, documentPath],
      taskStagingDir,
      batchContext: batchContext('paired-success-outcome'),
      jobId,
      cleanupSpool(spool) {
        cleanupTerminalChecks += 1;
        assert.equal(runtime.inspect(jobId), null, 'spool cleanup必须晚于parent terminal');
        return cleanupDuplicateSpool(spool);
      },
      async parserRunner(spool, { signal }) {
        started += 1;
        if (started === 2) resolveStarted();
        if (spool.slotIndex === 0) {
          await allStarted;
          return parserResult(await writeDuplicateInputSpool(spool));
        }
        return await new Promise((_resolve, reject) => {
          const abort = () => {
            siblingAborted = true;
            reject(Object.assign(new Error('sibling aborted'), {
              code: 'DUPLICATE_PARSER_CANCELLED'
            }));
          };
          if (signal.aborted) abort();
          else signal.addEventListener('abort', abort, { once: true });
        });
      }
    });
    await allStarted;
    failedAt = Date.now();
    try { await pairedPromise; } catch (error) { rejection = error; }
  });
  assert.equal(rejection instanceof AggregateError, true);
  assert.equal(rejection.code, 'DUPLICATE_PARSER_OUTCOME_PUBLISH_FAILED');
  assert.equal(rejection.cause && rejection.cause.code, 'EACCES');
  assert.deepEqual(rejection.errors.map((error) => error.code), ['EACCES', 'EACCES']);
  assert.equal(siblingAborted, true);
  assert.equal(cleanupTerminalChecks, 2);
  assert.equal(Date.now() - failedAt < 1000, true, 'parent terminal必须在1秒内完成');
  assert.equal(runtime.inspect(jobId), null);
  assert.equal(fs.existsSync(taskStagingDir), false);
  assertNoDuplicateMutation(dir, databasePath);
  const released = runtime.resourceGovernor.snapshot();
  assert.equal(released.activeLeaseCount, 0);
  assert.equal(released.activeDependencyCount, 0);

  const nextContext = batchContext('paired-success-outcome-next-run');
  const next = await runtime.execute({
    actionKey: 'duplicate:run',
    operationKey: nextContext.operationKey,
    production: false,
    context: { kind: 'operation', value: nextContext },
    input: { runtime: workerRuntime(dir, databasePath) }
  });
  assert.notEqual(next.error && next.error.code, 'SERVICE_BUSY');
  assertNoDuplicateMutation(dir, databasePath);
  assert.equal(runtime.resourceGovernor.snapshot().activeLeases.some(
    (lease) => lease.kind === 'persistent'
  ), false);
  const report = await runtime.shutdown({ timeoutMs: 10000 });
  shutdown = true;
  assert.deepEqual(report.errors, []);
  assert.deepEqual(report.leakedTransports, []);
});

test('两侧角色冲突在完整pair validation前fail closed且零side/Main/adopt', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'duplicate-paired-role-conflict-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const databasePath = path.join(dir, 'tool-data.sqlite');
  initializeMainDatabase(databasePath);
  const bankAPath = path.join(dir, 'bank-a.xlsx');
  const bankBPath = path.join(dir, 'bank-b.xlsx');
  writeWorkbook(bankAPath, BANK_STATEMENT_FIELDS, '渠道对账单', [bankRow({ BizId: 'ROLE-A' })]);
  writeWorkbook(bankBPath, BANK_STATEMENT_FIELDS, '渠道对账单', [bankRow({ BizId: 'ROLE-B' })]);
  const runtime = createRuntime(dir, databasePath);
  let shutdown = false;
  t.after(async () => { if (!shutdown) await runtime.shutdown({ timeoutMs: 10000 }); });
  await assert.rejects(() => executeManagedDuplicatePairedImport({
    runtime,
    workerRuntime: workerRuntime(dir, databasePath),
    filePaths: [bankAPath, bankBPath],
    taskStagingDir: path.join(dir, 'role-conflict-staging'),
    batchContext: batchContext('paired-role-conflict'),
    parserRunner: async (spool) => parserResult(await writeDuplicateInputSpool(spool))
  }), (error) => error.code === 'DUPLICATE_PAIRED_ROLE_CONFLICT');
  assert.equal(fs.existsSync(path.join(dir, 'run-data', 'duplicate-inbound-match')), false);
  assert.equal(fs.existsSync(path.join(dir, 'role-conflict-staging')), false);
  const db = new DatabaseSync(databasePath, { readOnly: true });
  assert.equal(Number(db.prepare(
    'SELECT COUNT(*) AS count FROM duplicate_inbound_match_run_mirrors'
  ).get().count), 0);
  db.close();
  const report = await runtime.shutdown({ timeoutMs: 10000 });
  shutdown = true;
  assert.deepEqual(report.errors, []);
  assert.deepEqual(report.leakedTransports, []);
});

test('Parser发布manifest后transport crash仍由failure barrier立即阻断commit并清理残留', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'duplicate-paired-crash-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const databasePath = path.join(dir, 'tool-data.sqlite');
  initializeMainDatabase(databasePath);
  const bankPath = path.join(dir, 'bank.xlsx');
  const documentPath = path.join(dir, 'document.xlsx');
  writeWorkbook(bankPath, BANK_STATEMENT_FIELDS, '渠道对账单', [bankRow({ BizId: 'CRASH-BIZ' })]);
  writeWorkbook(documentPath, BILL_HEADERS, '单据对账单');
  const runtime = createRuntime(dir, databasePath);
  let shutdown = false;
  t.after(async () => { if (!shutdown) await runtime.shutdown({ timeoutMs: 10000 }); });
  let announceManifest;
  const manifestPublished = new Promise((resolve) => { announceManifest = resolve; });
  let releaseCrash;
  const crashAfterInspection = new Promise((resolve) => { releaseCrash = resolve; });
  const pairedPromise = executeManagedDuplicatePairedImport({
    runtime,
    workerRuntime: workerRuntime(dir, databasePath),
    filePaths: [bankPath, documentPath],
    taskStagingDir: path.join(dir, 'crash-staging'),
    batchContext: batchContext('paired-crash'),
    async parserRunner(spool, { signal }) {
      if (spool.slotIndex === 0) {
        await writeDuplicateInputSpool(spool);
        announceManifest();
        await crashAfterInspection;
        throw Object.assign(new Error('result then crash'), {
          code: 'DUPLICATE_PARSER_TRANSPORT_CRASH'
        });
      }
      return new Promise((_resolve, reject) => {
        const fail = () => reject(Object.assign(new Error('sibling cancelled'), {
          code: 'DUPLICATE_PARSER_CANCELLED'
        }));
        if (signal.aborted) fail();
        else signal.addEventListener('abort', fail, { once: true });
      });
    }
  });
  await manifestPublished;
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(fs.existsSync(path.join(dir, 'run-data', 'duplicate-inbound-match')), false);
  const mainBeforeCrash = new DatabaseSync(databasePath, { readOnly: true });
  assert.equal(Number(mainBeforeCrash.prepare(
    'SELECT COUNT(*) AS count FROM duplicate_inbound_match_run_mirrors'
  ).get().count), 0);
  mainBeforeCrash.close();
  const startedAt = Date.now();
  releaseCrash();
  await assert.rejects(pairedPromise, (error) => error.code === 'DUPLICATE_PARSER_TRANSPORT_CRASH');
  assert.equal(Date.now() - startedAt < 1000, true);
  assert.equal(fs.existsSync(path.join(dir, 'run-data', 'duplicate-inbound-match')), false);
  assert.equal(fs.existsSync(path.join(dir, 'crash-staging')), false);
  const report = await runtime.shutdown({ timeoutMs: 10000 });
  shutdown = true;
  assert.deepEqual(report.errors, []);
  assert.deepEqual(report.leakedTransports, []);
});

test('app shutdown按shutdown-only取消等待中的paired命令并收口Parser/spool', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'duplicate-paired-shutdown-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const databasePath = path.join(dir, 'tool-data.sqlite');
  initializeMainDatabase(databasePath);
  const bankPath = path.join(dir, 'bank.xlsx');
  const documentPath = path.join(dir, 'document.xlsx');
  writeWorkbook(bankPath, BANK_STATEMENT_FIELDS, '渠道对账单');
  writeWorkbook(documentPath, BILL_HEADERS, '单据对账单');
  const runtime = createRuntime(dir, databasePath);
  let started = 0;
  let resolveStarted;
  const allStarted = new Promise((resolve) => { resolveStarted = resolve; });
  const pairedPromise = executeManagedDuplicatePairedImport({
    runtime,
    workerRuntime: workerRuntime(dir, databasePath),
    filePaths: [bankPath, documentPath],
    taskStagingDir: path.join(dir, 'shutdown-staging'),
    batchContext: batchContext('paired-shutdown'),
    parserRunner(_spool, { signal }) {
      started += 1;
      if (started === 2) resolveStarted();
      return new Promise((_resolve, reject) => {
        const fail = () => reject(Object.assign(new Error('shutdown parser'), {
          code: 'DUPLICATE_PARSER_CANCELLED'
        }));
        if (signal.aborted) fail();
        else signal.addEventListener('abort', fail, { once: true });
      });
    }
  });
  await allStarted;
  const shutdownPromise = runtime.shutdown({ timeoutMs: 10000 });
  await assert.rejects(pairedPromise, (error) => error.code === 'DUPLICATE_PARSER_CANCELLED');
  const report = await shutdownPromise;
  assert.deepEqual(report.errors, []);
  assert.deepEqual(report.leakedTransports, []);
  assert.equal(fs.existsSync(path.join(dir, 'shutdown-staging')), false);
  assert.equal(fs.existsSync(path.join(dir, 'run-data', 'duplicate-inbound-match')), false);
});

test('native ResourceGovernor诚实降为single Parser且仍完成同一两侧校验/采用', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'duplicate-paired-low-memory-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const databasePath = path.join(dir, 'tool-data.sqlite');
  initializeMainDatabase(databasePath);
  const bankPath = path.join(dir, 'bank.xlsx');
  const documentPath = path.join(dir, 'document.xlsx');
  writeWorkbook(bankPath, BANK_STATEMENT_FIELDS, '渠道对账单', [bankRow({ BizId: 'SINGLE-BIZ' })]);
  writeWorkbook(documentPath, BILL_HEADERS, '单据对账单');
  const runtime = createNativeRuntime();
  let shutdown = false;
  t.after(async () => { if (!shutdown) await runtime.shutdown({ timeoutMs: 10000 }); });
  const completionOrder = [];
  const result = await executeManagedDuplicatePairedImport({
    runtime,
    workerRuntime: workerRuntime(dir, databasePath),
    filePaths: [bankPath, documentPath],
    taskStagingDir: path.join(dir, 'single-staging'),
    batchContext: batchContext('paired-native-single'),
    parserRunner: async (spool) => parserResult(await writeDuplicateInputSpool(spool)),
    onParserComplete(value) { completionOrder.push(value.role); }
  });
  assert.equal(result.outcome, 'completed');
  assert.equal(result.pairedParser.effectiveWorkerCount, 1);
  assert.deepEqual(completionOrder, ['bank', 'document']);
  const report = await runtime.shutdown({ timeoutMs: 10000 });
  shutdown = true;
  assert.deepEqual(report.errors, []);
});

test('paired gate严格要求>=15%且RSS不超预算，生产paired入口固定拒绝', async () => {
  assert.equal(isPairedParserGateApproved({
    enabled: true,
    measuredImprovementRatio: 0.15,
    peakRssBytes: 100,
    rssBudgetBytes: 100
  }), true);
  assert.equal(isPairedParserGateApproved({
    enabled: true,
    measuredImprovementRatio: 0.149,
    peakRssBytes: 100,
    rssBudgetBytes: 100
  }), false);
  assert.equal(isPairedParserGateApproved({
    enabled: true,
    measuredImprovementRatio: 0.2,
    peakRssBytes: 101,
    rssBudgetBytes: 100
  }), false);
  const calls = [];
  const fakeRuntime = {
    start() { calls.push('start'); throw new Error('paired不应启动'); },
    execute(request) { calls.push(request); return Promise.resolve({ outcome: 'single-fallback' }); }
  };
  const fallback = await executeDuplicateImportWithOptionalPairedParser({
    runtime: fakeRuntime,
    workerRuntime: {},
    filePaths: ['/tmp/one.xlsx'],
    taskStagingDir: '/tmp/duplicate-gate',
    batchContext: batchContext('single-file-fallback'),
    pairedParserGate: {
      enabled: true,
      measuredImprovementRatio: 0.3,
      peakRssBytes: 100,
      rssBudgetBytes: 100
    }
  });
  assert.equal(fallback.outcome, 'single-fallback');
  assert.equal(calls[0].actionKey, 'duplicate:import');
  assert.deepEqual(calls[0].input.filePaths, ['/tmp/one.xlsx']);
  await assert.rejects(() => executeManagedDuplicatePairedImport({
    runtime: fakeRuntime,
    workerRuntime: {},
    filePaths: ['/tmp/a.xlsx', '/tmp/b.xlsx'],
    taskStagingDir: '/tmp/duplicate-production-gate',
    batchContext: batchContext('production-paired-disabled'),
    production: true
  }), (error) => error.code === 'DUPLICATE_PAIRED_PRODUCTION_DISABLED');
});

test('Parser依赖图不访问side/Main DB、matching、candidate或MPT', () => {
  const parserFiles = [
    'parser-worker-entry.js',
    'spool-writer.js',
    'input-classifier.js',
    'import-model.js'
  ].map((name) => path.join(
    ROOT, 'src', 'main-process', 'duplicate-inbound-match', name
  ));
  const forbidden = /(duplicate-inbound-match-store|run-data-store|mirror-database|matching-engine|mpt-schema|pre-fund-reconciliation-store)/;
  for (const filePath of parserFiles) {
    assert.doesNotMatch(fs.readFileSync(filePath, 'utf8'), forbidden, path.basename(filePath));
  }
  const dispatchSource = fs.readFileSync(path.join(
    ROOT,
    'src/main-process/duplicate-inbound-match/paired-parser-dispatch.js'
  ), 'utf8');
  assert.doesNotMatch(dispatchSource, /(bank-statement-io|document-statement-reader|import-model|input-classifier)/);
});
