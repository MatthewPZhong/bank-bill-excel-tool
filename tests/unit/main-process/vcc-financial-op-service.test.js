'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const assert = require('node:assert/strict');
const ExcelJS = require('exceljs');
const { DatabaseSync } = require('node:sqlite');
const { ensureVccFinancialOpTablesSupport } = require('../../../src/backend/vcc-financial-op-db/migrations');
const {
  registerVccStorageWriteCapability
} = require('../../../src/backend/vcc-financial-op-db/storage-contract');
const repository = require('../../../src/backend/vcc-financial-op-db/repository');
const {
  SOURCE_TYPES,
  SUPPORTED_CURRENCIES,
  getSourceDefinition
} = require('../../../src/backend/vcc-financial-op/definitions');
const { REQUIRED_DATASET_TYPES } = require('../../../src/backend/vcc-financial-op/calculator');
const {
  IMPORT_CANCELLED_CODE
} = require('../../../src/backend/vcc-financial-op/detail-importer');
const { deleteDataset } = require('../../../src/backend/vcc-financial-op/dataset-deletion');
const { serializeError } = require('../../../src/main-process/serialize-error');
const { vccFinancialOpErrorResult } = require('../../../src/main-process/vcc-financial-op-ipc');
const {
  previewDataTargetDeletion
} = require('../../../src/backend/vcc-financial-op/data-target-deletion');
const {
  previewUnarchive: previewLegacyUnarchive
} = require('../../../src/backend/vcc-financial-op/unarchive');
const { createVccFinancialOpService } = require('../../../src/main-process/vcc-financial-op-service');
const {
  buildVccImportArchiveHandoffFiles
} = require('../../../src/main-process/vcc-financial-op-archive-lineage');
const {
  createArchiveService
} = require('../../../src/main-process/archive-center/archive-service');

function deleteWithPreview(db, targetMonth, sourceType) {
  const preview = previewDataTargetDeletion(db, { targetMonth, targetType: sourceType });
  return deleteDataset({
    db,
    targetMonth,
    sourceType,
    expectedPreviewToken: preview.previewToken,
    taskGeneration: preview.taskGeneration
  });
}

class FakeWorker extends EventEmitter {
  constructor(options) {
    super();
    this.options = options;
    this.sentMessages = [];
    this.terminateCount = 0;
  }

  postMessage(message) {
    this.sentMessages.push(message);
  }

  async terminate() {
    this.terminateCount += 1;
    this.emit('exit', 1);
    return 1;
  }
}

function createFakeWorkerFactory(workers) {
  return (_filename, options) => {
    const worker = new FakeWorker(options);
    workers.push(worker);
    return worker;
  };
}

const BATCH_CONTEXT = Object.freeze({
  batchId: 61,
  batchNumber: '2026-08-11-001',
  taskRunId: 'task-61',
  taskKey: 'vcc-test',
  moduleId: 'vcc-financial-op',
  parentRunId: 'parent-61',
  operationKey: 'operation-61'
});

async function writeRechargeWorkbook(filePath, orderId) {
  const definition = getSourceDefinition(SOURCE_TYPES.RECHARGE);
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet('sheet1');
  worksheet.addRow(definition.headers);
  const row = {
    订单号: orderId,
    BillDate: '2026-06-09',
    业务部门: 'VCC',
    对手部门: 'OPS',
    业务子类型: '充值',
    出入方向: 'in',
    公司主体: 'PPHK',
    我方币种: 'USD',
    我方到账金额: '10.25'
  };
  worksheet.addRow(definition.headers.map((header) => row[header] ?? ''));
  await workbook.xlsx.writeFile(filePath);
}

function fakeArchiveHandoffFiles(files, batchContext = BATCH_CONTEXT) {
  const ordinals = new Map();
  return files.map((file, index) => {
    const sourceOrdinal = (ordinals.get(file.sourceType) || 0) + 1;
    ordinals.set(file.sourceType, sourceOrdinal);
    return {
      filePath: path.resolve(file.filePath),
      sourceType: file.sourceType,
      sourceOrdinal,
      sha256: String(index + 1).padStart(64, '0'),
      sizeBytes: index + 1,
      taskRunId: batchContext.taskRunId
    };
  });
}

function seedCalculatedReviewRun(db) {
  const revisions = Object.fromEntries(REQUIRED_DATASET_TYPES.map((type) => [type, 1]));
  const runId = Number(db.prepare(`
    INSERT INTO vcc_fin_op_runs (
      target_month, status, input_revisions_json, result_revision,
      input_fingerprint, created_at, updated_at
    ) VALUES (
      '2026-06', 'calculated', ?, 0,
      ?, '2026-07-01 09:00:00', '2026-07-01 09:00:00'
    )
  `).run(JSON.stringify(revisions), 'a'.repeat(64)).lastInsertRowid);
  const insertDataset = db.prepare(`
    INSERT INTO vcc_fin_op_datasets (
      target_month, dataset_type, data_status, archived_run_id,
      revision, generated_at, updated_at
    ) VALUES ('2026-06', ?, 'unprocessed', NULL, 1, ?, ?)
  `);
  for (const sourceType of REQUIRED_DATASET_TYPES) {
    insertDataset.run(sourceType, '2026-07-01 08:00:00', '2026-07-01 08:00:00');
  }
  db.prepare(`
    INSERT INTO vcc_fin_op_run_rows (
      run_id, subject, row_kind, source_type,
      category_major, category_minor, currency, amount
    ) VALUES (?, 'PPHK', 'movement', ?, '充值', 'OPS', 'USD', '10')
  `).run(runId, SOURCE_TYPES.RECHARGE);
  const insertBalance = db.prepare(`
    INSERT INTO vcc_fin_op_run_balances (
      run_id, subject, currency, opening_balance, period_amount,
      calculated_balance, system_balance, difference
    ) VALUES (?, 'PPHK', ?, '100', ?, ?, ?, ?)
  `);
  for (const currency of SUPPORTED_CURRENCIES) {
    const periodAmount = currency === 'USD' ? '10' : '0';
    const calculatedBalance = currency === 'USD' ? '110' : '100';
    const systemBalance = currency === 'USD' ? '112' : '100';
    const difference = currency === 'USD' ? '2' : '0';
    insertBalance.run(
      runId,
      currency,
      periodAmount,
      calculatedBalance,
      systemBalance,
      difference
    );
  }
  return runId;
}

test('结果查询 token 直达 dedicated worker，调整后 refetch 并以新 token 归档', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vcc-result-service-write-'));
  const dbPath = path.join(root, 'tool-data.sqlite');
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL');
  ensureVccFinancialOpTablesSupport(db);
  const runId = seedCalculatedReviewRun(db);
  const service = createVccFinancialOpService({
    database: { db, dbPath },
    assetsDir: '',
    appVersion: '3.1.8',
    buildSha: 'service-build'
  });
  t.after(async () => {
    await service.terminate();
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const initialOptions = service.listAdjustmentOptions({ runId });
  assert.equal(initialOptions.resultRevision, 0);
  assert.equal(service._taskStateForTests().taskGeneration, 0, '只读 options 不计任务 generation');
  const initialResult = await service.getRunResult(runId);
  assert.equal(initialResult.review.subjects.length, 1);
  assert.equal(service._taskStateForTests().taskGeneration, 0, '只读 full result 不计任务 generation');

  const adding = service.addRunAdjustment({
    runId,
    rowKey: initialOptions.options[0].rowKey,
    currency: 'USD',
    adjustmentAmount: '1',
    reason: '服务层调整',
    expectedResultRevision: 0,
    expectedPreviewToken: initialResult.previewTokens.adjustment,
    taskGeneration: initialResult.taskGeneration
  }, undefined, BATCH_CONTEXT);
  assert.equal(service._taskStateForTests().action, 'add-adjustment');
  assert.throws(
    () => service.addRunAdjustment({
      runId,
      rowKey: initialOptions.options[0].rowKey,
      currency: 'JPY',
      adjustmentAmount: '1',
      reason: '并发写入',
      expectedResultRevision: 0,
      expectedPreviewToken: initialResult.previewTokens.adjustment,
      taskGeneration: initialResult.taskGeneration
    }, undefined, BATCH_CONTEXT),
    (error) => error.code === 'active-vcc-task'
  );
  const adjusted = await adding;
  assert.equal(adjusted.resultRevision, 1);
  assert.equal(service._taskStateForTests().taskGeneration, 1);
  const storedAdjustment = db.prepare(`
    SELECT created_app_version, created_build_sha
    FROM vcc_fin_op_run_adjustments WHERE run_id = ?
  `).get(runId);
  assert.deepEqual({ ...storedAdjustment }, {
    created_app_version: '3.1.8',
    created_build_sha: 'service-build'
  });
  const effective = await service.getRunResult(runId);
  assert.equal(effective.resultRevision, 1);
  assert.equal(effective.adjustments.length, 1);
  assert.equal(
    effective.balances.find((row) => row.currency === 'USD').effectiveCalculatedBalance,
    '111'
  );
  assert.deepEqual(
    {
      periodAmount: effective.balances.find((row) => row.currency === 'USD').periodAmount,
      calculatedBalance: effective.balances.find((row) => row.currency === 'USD').calculatedBalance,
      difference: effective.balances.find((row) => row.currency === 'USD').difference
    },
    { periodAmount: '11', calculatedBalance: '111', difference: '1' }
  );
  assert.equal(service.dataManagerOverview('2026-06').results[0].resultRevision, 1);
  const refreshedOptions = service.listAdjustmentOptions({ runId });
  assert.equal(refreshedOptions.options[0].availableCurrencies.includes('USD'), false);

  const archived = await service.archive({
    runId,
    expectedResultRevision: 1,
    expectedPreviewToken: effective.previewTokens.archive,
    taskGeneration: effective.taskGeneration
  }, undefined, BATCH_CONTEXT);
  assert.equal(archived.status, 'archived');
  const archiveAudit = db.prepare(`
    SELECT app_version, build_sha FROM vcc_fin_op_operation_audit
    WHERE operation_type = 'archive_result' AND status = 'success'
  `).get();
  assert.deepEqual({ ...archiveAudit }, {
    app_version: '3.1.8',
    build_sha: 'service-build'
  });
  const unarchivePreview = await service.previewUnarchive({ targetMonth: '2026-06' });
  assert.equal(unarchivePreview.canUnarchive, true);
  const unarchived = await service.unarchiveMonth({
    targetMonth: '2026-06',
    expectedPreviewToken: unarchivePreview.previewToken,
    taskGeneration: unarchivePreview.taskGeneration
  }, undefined, BATCH_CONTEXT);
  assert.equal(unarchived.status, 'unarchived');
  assert.equal(db.prepare('SELECT status FROM vcc_fin_op_runs WHERE id = ?').get(runId).status, 'calculated');
});

test('真实 v3.1.7 legacy preview 经 Service claim 到 dedicated worker 解归档', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vcc-legacy-unarchive-service-'));
  const dbPath = path.join(root, 'tool-data.sqlite');
  fs.copyFileSync(path.resolve(
    __dirname,
    '../../fixtures/vcc-financial-op/v3.1.7-four-dataset.sqlite'
  ), dbPath);
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL');
  ensureVccFinancialOpTablesSupport(db);
  const service = createVccFinancialOpService({
    database: { db, dbPath },
    assetsDir: '',
    appVersion: '3.1.9',
    buildSha: 'legacy-service-build'
  });
  t.after(async () => {
    await service.terminate();
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const preview = await service.previewUnarchive({ targetMonth: '2026-06' });
  assert.equal(preview.archiveContract, 'legacy-v3.1.7-four-dataset');
  const result = await service.unarchiveMonth({
    targetMonth: '2026-06',
    expectedPreviewToken: preview.previewToken,
    taskGeneration: preview.taskGeneration
  }, undefined, BATCH_CONTEXT);
  assert.equal(result.archiveContract, 'legacy-v3.1.7-four-dataset');
  assert.equal(db.prepare(`
    SELECT COUNT(*) AS count FROM vcc_fin_op_datasets
    WHERE target_month = '2026-06'
  `).get().count, 4);
  assert.equal(db.prepare(`
    SELECT COUNT(*) AS count FROM vcc_fin_op_datasets
    WHERE target_month = '2026-06' AND dataset_type = 'pending_archive_removal'
  `).get().count, 0);
});

test('计算失败与 rolled_back 审计失败从 worker 到 IPC 保留主错误和审计上下文', async (t) => {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  ensureVccFinancialOpTablesSupport(db);
  const workers = [];
  const service = createVccFinancialOpService({
    database: { db, dbPath: ':memory:' },
    assetsDir: '',
    workerFactory: createFakeWorkerFactory(workers)
  });
  t.after(async () => {
    await service.terminate();
    db.close();
  });

  const calculation = service.calculate({
    targetMonth: '2026-06',
    expectedInputFingerprint: 'a'.repeat(64)
  }, BATCH_CONTEXT);
  const primaryError = new Error('replacement-primary-fault');
  primaryError.code = 'SQLITE_CONSTRAINT_TRIGGER';
  primaryError.detailLines = ['旧结果保留，替换事务已回滚'];
  primaryError.context = {
    targetMonth: '2026-06',
    operationType: 'replace_calculated_result'
  };
  primaryError.auditFailure = {
    name: 'Error',
    code: 'SQLITE_BUSY',
    message: 'replacement-audit-fault'
  };
  workers[0].emit('message', {
    type: 'error',
    error: serializeError(primaryError)
  });

  let restoredError = null;
  await assert.rejects(calculation, (error) => {
    restoredError = error;
    return error.message === 'replacement-primary-fault';
  });
  assert.deepEqual(vccFinancialOpErrorResult(restoredError), {
    status: 'error',
    code: 'SQLITE_CONSTRAINT_TRIGGER',
    message: 'replacement-primary-fault',
    detailLines: ['旧结果保留，替换事务已回滚'],
    dependentMonths: [],
    context: {
      targetMonth: '2026-06',
      operationType: 'replace_calculated_result',
      auditFailure: {
        name: 'Error',
        code: 'SQLITE_BUSY',
        message: 'replacement-audit-fault'
      }
    }
  });
});

test('多主体导出部分发布错误把实际文件路径交给 lifecycle 归档', () => {
  const error = new Error('第二主体写入失败');
  error.partialResult = {
    partialCommitted: true,
    filePaths: ['/tmp/2026-06_PPHK_VCC财务OP校验结果表.xlsx'],
    runId: 7,
    targetMonth: '2026-06'
  };
  assert.deepEqual(vccFinancialOpErrorResult(error), {
    status: 'error',
    code: null,
    message: '第二主体写入失败',
    detailLines: [],
    dependentMonths: [],
    context: null,
    partialCommitted: true,
    filePaths: ['/tmp/2026-06_PPHK_VCC财务OP校验结果表.xlsx'],
    runId: 7,
    targetMonth: '2026-06'
  });
});

test('generic worker 不再承载 destructive route，dedicated worker 握手后才执行且零 migration', () => {
  const genericWorkerSource = fs.readFileSync(path.join(
    __dirname,
    '../../../src/backend/vcc-financial-op/worker-entry.js'
  ), 'utf8');
  const writeWorkerSource = fs.readFileSync(path.join(
    __dirname,
    '../../../src/main-process/vcc-financial-op-write-worker.js'
  ), 'utf8');
  const runSource = writeWorkerSource.slice(
    writeWorkerSource.indexOf('async function run()'),
    writeWorkerSource.indexOf('function finish(')
  );
  const handshakeIndex = runSource.indexOf('await enterCriticalSection(action, payload)');
  const executeIndex = runSource.indexOf('return execute({');
  assert.ok(handshakeIndex >= 0, '破坏性 action 必须等待 critical ACK');
  assert.ok(executeIndex > handshakeIndex, '写 executor 必须发生在父进程 protected/ACK 之后');
  assert.doesNotMatch(writeWorkerSource, /ensureVccFinancialOpTablesSupport|migrations/);
  assert.doesNotMatch(genericWorkerSource, /unarchive-month|delete-data-target/);
});

test('运行服务拒绝缺少或无效的预检 fingerprint，且不启动 worker', async (t) => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec('PRAGMA foreign_keys = ON');
  ensureVccFinancialOpTablesSupport(db);
  const service = createVccFinancialOpService({
    database: { db, dbPath: ':memory:' },
    assetsDir: ''
  });
  t.after(() => service.terminate());

  for (const expectedInputFingerprint of [undefined, 'short', 'F'.repeat(64)]) {
    const result = await service.calculate({
      targetMonth: '2026-06',
      expectedInputFingerprint
    }, BATCH_CONTEXT);
    assert.equal(result.status, 'blocked');
    assert.equal(result.code, 'preflight-required');
  }
});

test('calculate 仅透传允许字段且 renderer 不能伪造 worker 审计版本', async (t) => {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  ensureVccFinancialOpTablesSupport(db);
  const workers = [];
  const service = createVccFinancialOpService({
    database: { db, dbPath: ':memory:' },
    assetsDir: '',
    appVersion: '3.1.8-trusted',
    buildSha: 'trusted-build-sha',
    workerFactory: createFakeWorkerFactory(workers)
  });
  t.after(async () => {
    await service.terminate();
    db.close();
  });

  const calculation = service.calculate({
    targetMonth: '2026-06',
    expectedInputFingerprint: 'a'.repeat(64),
    appVersion: 'forged-version',
    buildSha: 'forged-sha',
    taskGeneration: 999,
    runId: 123,
    unexpectedField: 'must-not-cross-service-boundary'
  }, BATCH_CONTEXT);
  assert.equal(workers.length, 1);
  assert.deepEqual(workers[0].options.workerData.payload, {
    targetMonth: '2026-06',
    expectedInputFingerprint: 'a'.repeat(64),
    batchContext: BATCH_CONTEXT,
    taskGeneration: 0,
    appVersion: '3.1.8-trusted',
    buildSha: 'trusted-build-sha'
  });
  workers[0].emit('message', { type: 'result', result: { status: 'calculated' } });
  assert.deepEqual(await calculation, { status: 'calculated' });
});

test('VCC import 以 exact7 taskRunId 固定 batchId，拒绝 renderer 伪造和既有批次复用', async (t) => {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  ensureVccFinancialOpTablesSupport(db);
  const workers = [];
  const service = createVccFinancialOpService({
    database: { db, dbPath: ':memory:' },
    assetsDir: '',
    workerFactory: createFakeWorkerFactory(workers)
  });
  t.after(async () => {
    await service.terminate();
    db.close();
  });

  const importFiles = [{ filePath: '/tmp/recharge.xlsx', sourceType: SOURCE_TYPES.RECHARGE }];
  await assert.rejects(
    service.importSelectedFiles({
      targetMonth: '2026-06',
      files: importFiles
    }, undefined, BATCH_CONTEXT),
    (error) => error && error.code === 'vcc-import-handoff-mismatch'
  );
  assert.equal(workers.length, 0, '缺少业务前耐久证据不得启动 worker');

  const archiveHandoffFiles = fakeArchiveHandoffFiles(importFiles);
  const importing = service.importSelectedFiles({
    targetMonth: '2026-06',
    files: importFiles,
    batchId: 'renderer-forged-batch'
  }, undefined, BATCH_CONTEXT, archiveHandoffFiles);
  assert.equal(workers.length, 1);
  assert.equal(workers[0].options.workerData.payload.batchId, BATCH_CONTEXT.taskRunId);
  assert.deepEqual(workers[0].options.workerData.payload.batchContext, BATCH_CONTEXT);
  assert.deepEqual(workers[0].options.workerData.payload.archiveHandoffFiles, archiveHandoffFiles);
  assert.deepEqual(
    Object.keys(workers[0].options.workerData.payload.archiveHandoffFiles[0]),
    ['filePath', 'sourceType', 'sourceOrdinal', 'sha256', 'sizeBytes', 'taskRunId']
  );
  workers[0].emit('message', {
    type: 'result',
    result: { status: 'success', batchId: BATCH_CONTEXT.taskRunId, records: [] }
  });
  assert.equal((await importing).batchId, BATCH_CONTEXT.taskRunId);

  repository.createImportBatch(db, {
    id: BATCH_CONTEXT.taskRunId,
    targetMonth: '2026-06',
    fileCount: 1
  });
  const otherFiles = [{ filePath: '/tmp/other.xlsx', sourceType: SOURCE_TYPES.RECHARGE }];
  await assert.rejects(
    service.importSelectedFiles({
      targetMonth: '2026-06',
      files: otherFiles
    }, undefined, BATCH_CONTEXT, fakeArchiveHandoffFiles(otherFiles)),
    (error) => error.code === 'vcc-import-batch-id-conflict'
  );
  assert.equal(workers.length, 1, '既有 batchId 冲突不得启动 worker 或混入旧 records');
});

test('真实 worker 在建 batch 前拒绝同路径已归档 A 被替换为 B，全部业务表保持零写入', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vcc-handoff-source-swap-'));
  const dbPath = path.join(root, 'tool-data.sqlite');
  const db = new DatabaseSync(dbPath);
  registerVccStorageWriteCapability(db);
  db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL');
  ensureVccFinancialOpTablesSupport(db);
  const archiveService = createArchiveService({
    database: db,
    rootDir: path.join(root, 'archive')
  });
  await archiveService.initialize();
  const reserved = await archiveService.reserveTaskBatch({
    moduleId: 'vcc-financial-op',
    moduleCode: 'VCCFINOP',
    moduleName: 'VCC财务OP校验',
    taskKey: 'vccFinancialOp:import:apply',
    taskRunId: 'vcc-handoff-source-swap',
    operationKey: 'vccFinancialOp:import:apply:vcc-handoff-source-swap',
    parentRunId: 'vcc-handoff-source-swap-flow'
  });
  await archiveService.markTaskStarted(reserved.batchId);
  const batchContext = Object.freeze({
    batchId: reserved.batch.id,
    batchNumber: reserved.batch.batchNumber,
    taskRunId: reserved.batch.taskRunId,
    taskKey: reserved.batch.taskKey,
    moduleId: reserved.batch.moduleId,
    parentRunId: reserved.batch.parentRunId,
    operationKey: reserved.batch.operationKey
  });
  const firstPath = path.join(root, 'first.xlsx');
  const secondPath = path.join(root, 'second.xlsx');
  await writeRechargeWorkbook(firstPath, 'HANDOFF-A-1');
  await writeRechargeWorkbook(secondPath, 'HANDOFF-A-2');
  const files = [firstPath, secondPath].map((filePath) => ({
    filePath,
    sourceType: SOURCE_TYPES.RECHARGE
  }));
  const archiveHandoffFiles = await buildVccImportArchiveHandoffFiles({ files }, batchContext);
  const archived = await archiveService.appendFiles({
    batchId: batchContext.batchId,
    sourceOperation: 'vccFinancialOp:import:apply',
    files: archiveHandoffFiles
  });
  assert.equal(archived.ok, true);
  assert.equal(archived.results.every((result) => result.status === 'ready'), true);
  const originalSecondSha = archiveHandoffFiles[1].expectedSha256;
  await writeRechargeWorkbook(secondPath, 'HANDOFF-B-2');

  const service = createVccFinancialOpService({
    database: { db, dbPath },
    assetsDir: ''
  });
  t.after(async () => {
    await service.terminate();
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  await assert.rejects(
    service.importSelectedFiles({ targetMonth: '2026-06', files }, undefined, batchContext, archiveHandoffFiles),
    (error) => error && error.code === 'vcc-import-handoff-mismatch'
  );
  for (const tableName of [
    'vcc_fin_op_import_batches',
    'vcc_fin_op_import_records',
    'vcc_fin_op_import_sources',
    'vcc_fin_op_effective_rows'
  ]) {
    assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM ${tableName}`).get().n, 0, tableName);
  }
  const archiveArtifacts = archiveService.repository.listArtifacts(batchContext.batchId);
  assert.equal(archiveArtifacts.length, 2);
  assert.equal(archiveArtifacts[1].status, 'ready');
  assert.equal(archiveArtifacts[1].blob.sha256, originalSecondSha);
});

test('VCC import cooperative error 已带 partialResult 时不被空 DB 恢复覆盖', async (t) => {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  ensureVccFinancialOpTablesSupport(db);
  const workers = [];
  const service = createVccFinancialOpService({
    database: { db, dbPath: ':memory:' },
    assetsDir: '',
    workerFactory: createFakeWorkerFactory(workers)
  });
  t.after(async () => {
    await service.terminate();
    db.close();
  });
  const files = [{ filePath: '/tmp/recharge.xlsx', sourceType: SOURCE_TYPES.RECHARGE }];
  const importing = service.importSelectedFiles({
    targetMonth: '2026-06',
    files
  }, undefined, BATCH_CONTEXT, fakeArchiveHandoffFiles(files));
  const error = new Error('cooperative fixture cancel');
  error.code = IMPORT_CANCELLED_CODE;
  error.partialResult = {
    batchId: BATCH_CONTEXT.taskRunId,
    targetMonth: '2026-06',
    status: 'error',
    partialCommitted: true,
    records: [{ recordId: 9, sourceType: SOURCE_TYPES.RECHARGE, status: 'success' }]
  };
  workers[0].emit('message', { type: 'error', error: serializeError(error) });
  await assert.rejects(importing, (caught) => {
    assert.deepEqual(caught.partialResult, error.partialResult);
    return caught.code === IMPORT_CANCELLED_CODE;
  });

  const beforeTransaction = service.importSelectedFiles({
    targetMonth: '2026-06',
    files
  }, undefined, BATCH_CONTEXT, fakeArchiveHandoffFiles(files));
  workers[1].emit('error', new Error('worker failed before import transaction'));
  await assert.rejects(beforeTransaction, (caught) => {
    assert.equal(Object.hasOwn(caught, 'partialResult'), false);
    return /before import transaction/.test(caught.message);
  });
});

test('VCC import worker error 只从当前 taskRunId batch 恢复同形 partialResult', async (t) => {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  ensureVccFinancialOpTablesSupport(db);
  const workers = [];
  const service = createVccFinancialOpService({
    database: { db, dbPath: ':memory:' },
    assetsDir: '',
    workerFactory: createFakeWorkerFactory(workers)
  });
  t.after(async () => {
    await service.terminate();
    db.close();
  });
  const files = [
    { filePath: '/tmp/recharge.xlsx', sourceType: SOURCE_TYPES.RECHARGE },
    { filePath: '/tmp/system.xlsx', sourceType: SOURCE_TYPES.SYSTEM_OP }
  ];
  const importing = service.importSelectedFiles({
    targetMonth: '2026-06',
    files
  }, undefined, BATCH_CONTEXT, fakeArchiveHandoffFiles(files));
  repository.createImportBatch(db, {
    id: BATCH_CONTEXT.taskRunId,
    targetMonth: '2026-06',
    fileCount: 2
  });
  const rechargeRecordId = repository.createImportRecord(db, {
    batchId: BATCH_CONTEXT.taskRunId,
    targetMonth: '2026-06',
    sourceType: SOURCE_TYPES.RECHARGE,
    sourceFiles: ['recharge.xlsx']
  });
  repository.finishImportRecord(db, rechargeRecordId, {
    status: 'success',
    rawCount: 1,
    insertedCount: 1
  });
  repository.createImportRecord(db, {
    batchId: BATCH_CONTEXT.taskRunId,
    targetMonth: '2026-06',
    sourceType: SOURCE_TYPES.SYSTEM_OP,
    sourceFiles: ['system.xlsx']
  });
  repository.createImportBatch(db, {
    id: 'unrelated-worker-error',
    targetMonth: '2026-05',
    fileCount: 1
  });
  const unrelatedRecordId = repository.createImportRecord(db, {
    batchId: 'unrelated-worker-error',
    targetMonth: '2026-05',
    sourceType: SOURCE_TYPES.RECHARGE,
    sourceFiles: ['unrelated.xlsx']
  });
  workers[0].emit('error', new Error('fixture import worker error'));

  await assert.rejects(importing, (caught) => {
    assert.equal(caught.partialResult.batchId, BATCH_CONTEXT.taskRunId);
    assert.equal(caught.partialResult.targetMonth, '2026-06');
    assert.equal(caught.partialResult.partialCommitted, true);
    assert.deepEqual(caught.partialResult.records.map((record) => [record.sourceType, record.status]), [
      [SOURCE_TYPES.RECHARGE, 'success'],
      [SOURCE_TYPES.SYSTEM_OP, 'failed_validation']
    ]);
    return /fixture import worker error/.test(caught.message);
  });
  assert.equal(repository.getImportRecord(db, unrelatedRecordId).status, 'importing');
});

test('Service 不再暴露逐行导入详情分页接口', (t) => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec('PRAGMA foreign_keys = ON');
  ensureVccFinancialOpTablesSupport(db);
  const service = createVccFinancialOpService({
    database: { db, dbPath: ':memory:' },
    assetsDir: ''
  });
  t.after(() => service.terminate());
  assert.equal(service.getImportRecordDetail, undefined);
});

test('数据管理概览不再暴露独立期初余额审计卡片', (t) => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec('PRAGMA foreign_keys = ON');
  ensureVccFinancialOpTablesSupport(db);
  const balances = Object.fromEntries(SUPPORTED_CURRENCIES.map((currency) => [currency, '100']));
  db.prepare(`
    INSERT INTO vcc_fin_op_opening_balances (
      target_month, subject, balances_json, content_hash, initialization_note
    ) VALUES ('2026-06', 'PPHK', ?, 'opening-hash', '已与账务期初表核对')
  `).run(JSON.stringify(balances));
  const service = createVccFinancialOpService({
    database: { db, dbPath: ':memory:' },
    assetsDir: ''
  });
  t.after(() => service.terminate());

  const overview = service.dataManagerOverview('2026-06');
  assert.equal(Object.hasOwn(overview, 'openingBalances'), false);
});

test('数据管理校验表返回独立生成时间', (t) => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec('PRAGMA foreign_keys = ON');
  ensureVccFinancialOpTablesSupport(db);
  const insertDataset = db.prepare(`
    INSERT INTO vcc_fin_op_datasets (
      target_month, dataset_type, generated_at, updated_at
    ) VALUES ('2026-06', ?, ?, '2026-07-03 12:00:00')
  `);
  insertDataset.run(SOURCE_TYPES.RECHARGE, '2026-07-01 10:20:30');
  insertDataset.run(SOURCE_TYPES.PENDING, '2026-07-01 10:30:30');
  insertDataset.run(SOURCE_TYPES.SYSTEM_OP, '2026-07-02 11:21:31');
  const service = createVccFinancialOpService({
    database: { db, dbPath: ':memory:' },
    assetsDir: ''
  });
  t.after(() => service.terminate());

  const overview = service.dataManagerOverview('2026-06');
  assert.deepEqual(overview.checks.map((row) => ({
    sourceType: row.sourceType,
    generatedAt: row.generatedAt
  })), [
    { sourceType: SOURCE_TYPES.PENDING, generatedAt: '2026-07-01 10:30:30' },
    { sourceType: SOURCE_TYPES.RECHARGE, generatedAt: '2026-07-01 10:20:30' },
    { sourceType: SOURCE_TYPES.SYSTEM_OP, generatedAt: '2026-07-02 11:21:31' }
  ]);
  assert.equal(
    overview.raw.find((row) => row.sourceType === SOURCE_TYPES.RECHARGE).generatedAt,
    '2026-07-01 10:20:30'
  );
  assert.equal(
    overview.checks.find((row) => row.sourceType === SOURCE_TYPES.PENDING).tableName,
    '移除归档Pending账单_校验表'
  );
});

test('删除有效明细后导入记录列表仍保留文件级状态与归档字段', (t) => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec('PRAGMA foreign_keys = ON');
  ensureVccFinancialOpTablesSupport(db);
  repository.createImportBatch(db, { id: 'detail-audit-delete', targetMonth: '2026-06', fileCount: 2 });
  const recordId = repository.createImportRecord(db, {
    batchId: 'detail-audit-delete',
    targetMonth: '2026-06',
    sourceType: SOURCE_TYPES.RECHARGE,
    sourceFiles: ['original.xlsx', 'retry.xlsx']
  });
  repository.finishImportRecord(db, recordId, {
    status: 'success_with_skips', rawCount: 2, insertedCount: 1, skippedCount: 1
  });
  repository.finishImportBatch(db, 'detail-audit-delete', 'success');
  db.prepare(`
    INSERT INTO vcc_fin_op_effective_rows (
      source_type, idempotency_key_raw, idempotency_key, content_hash,
      target_month, subject, source_file, sheet_name, source_row, raw_json,
      import_record_id
    ) VALUES (?, '0000123', '0000123', 'same-hash', '2026-06', 'PPHK',
      'original.xlsx', '明细', 8, '["","","","","","0000123"]', ?)
  `).run(SOURCE_TYPES.RECHARGE, recordId);
  db.prepare(`
    INSERT INTO vcc_fin_op_datasets (
      target_month, dataset_type, generated_at, updated_at
    ) VALUES ('2026-06', ?, '2026-08-01 08:00:00', '2026-08-01 08:00:00')
  `).run(SOURCE_TYPES.RECHARGE);
  const service = createVccFinancialOpService({
    database: { db, dbPath: ':memory:' },
    assetsDir: ''
  });
  t.after(() => service.terminate());

  deleteWithPreview(db, '2026-06', SOURCE_TYPES.RECHARGE);
  const listed = service.listImportRecords('2026-06');
  assert.equal(listed[0].status, 'deleted');
  assert.equal(listed[0].statusText, '已删除');
  assert.equal(listed[0].originalStatus, 'success_with_skips');
  assert.ok(listed[0].datasetDeletedAt);
  assert.ok(listed[0].datasetDeletionId);
  assert.equal(listed[0].anomalyCount, 0);
  assert.equal(listed[0].archiveState, 'pending');
});

test('显式重建前导入记录 DTO 仍暴露 v1 历史异常的可导出数量', (t) => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec('PRAGMA foreign_keys = ON');
  ensureVccFinancialOpTablesSupport(db);
  repository.createImportBatch(db, {
    id: 'legacy-anomaly-dto', targetMonth: '2026-06', fileCount: 1
  });
  const recordId = repository.createImportRecord(db, {
    batchId: 'legacy-anomaly-dto',
    targetMonth: '2026-06',
    sourceType: SOURCE_TYPES.RECHARGE,
    sourceFiles: ['legacy.xlsx']
  });
  db.prepare(`
    INSERT INTO vcc_fin_op_import_rows (
      import_record_id, source_type, target_month,
      idempotency_key_raw, idempotency_key, content_hash,
      source_file, sheet_name, source_row, raw_json,
      disposition, validation_field, validation_message, diff_fields_json
    ) VALUES (?, ?, '2026-06', 'bad', 'bad', ?, 'legacy.xlsx',
              '明细', 3, '{}', 'format_error', '金额', '金额格式错误', '[]')
  `).run(recordId, SOURCE_TYPES.RECHARGE, 'a'.repeat(64));
  repository.finishImportRecord(db, recordId, {
    status: 'failed_validation', rawCount: 1, formatErrorCount: 1,
    errorMessage: '历史文件导入失败'
  });
  const service = createVccFinancialOpService({
    database: { db, dbPath: ':memory:' },
    assetsDir: ''
  });
  t.after(() => service.terminate());

  const [record] = service.listImportRecords('2026-06');
  assert.equal(record.anomalyCount, 2);
});

test('生产 v2 删除 preview 经 dedicated worker 删除 source 与未归档结果', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vcc-delete-worker-'));
  const dbPath = path.join(dir, 'tool-data.sqlite');
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL');
  ensureVccFinancialOpTablesSupport(db);
  t.after(async () => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  repository.createImportBatch(db, { id: 'worker-delete', targetMonth: '2026-06', fileCount: 1 });
  const recordId = repository.createImportRecord(db, {
    batchId: 'worker-delete',
    targetMonth: '2026-06',
    sourceType: SOURCE_TYPES.RECHARGE,
    sourceFiles: ['recharge.xlsx']
  });
  repository.finishImportRecord(db, recordId, {
    status: 'success', rawCount: 1, insertedCount: 1
  });
  repository.finishImportBatch(db, 'worker-delete', 'success');
  db.prepare(`
    INSERT INTO vcc_fin_op_effective_rows (
      source_type, idempotency_key_raw, idempotency_key, content_hash,
      target_month, subject, source_file, sheet_name, source_row, raw_json,
      import_record_id
    ) VALUES (?, 'ORDER-WORKER', 'ORDER-WORKER', 'hash-worker',
      '2026-06', 'PPHK', 'recharge.xlsx', 'Sheet1', 2, '[]', ?)
  `).run(SOURCE_TYPES.RECHARGE, recordId);
  db.prepare(`
    INSERT INTO vcc_fin_op_datasets (
      target_month, dataset_type, generated_at, updated_at
    ) VALUES ('2026-06', ?, '2026-08-01 08:00:00', '2026-08-01 08:00:00')
  `).run(SOURCE_TYPES.RECHARGE);
  const runId = Number(db.prepare(`
    INSERT INTO vcc_fin_op_runs (
      target_month, status, input_revisions_json, input_fingerprint,
      created_at, updated_at
    ) VALUES (
      '2026-06', 'calculated', '{"fixture":1}', 'worker-delete-fingerprint',
      '2026-08-01 08:00:00', '2026-08-01 08:00:00'
    )
  `).run().lastInsertRowid);
  db.prepare(`
    INSERT INTO vcc_fin_op_run_rows (
      run_id, subject, row_kind, source_type,
      category_major, category_minor, currency, amount
    ) VALUES (?, 'PPHK', 'movement', ?, '充值', '正常', 'USD', '10')
  `).run(runId, SOURCE_TYPES.RECHARGE);
  const insertBalance = db.prepare(`
    INSERT INTO vcc_fin_op_run_balances (
      run_id, subject, currency, opening_balance, period_amount,
      calculated_balance, system_balance, difference
    ) VALUES (?, 'PPHK', ?, '100', ?, ?, ?, '0')
  `);
  for (const currency of SUPPORTED_CURRENCIES) {
    const periodAmount = currency === 'USD' ? '10' : '0';
    const calculatedBalance = currency === 'USD' ? '110' : '100';
    insertBalance.run(runId, currency, periodAmount, calculatedBalance, calculatedBalance);
  }
  const service = createVccFinancialOpService({
    database: { db, dbPath },
    assetsDir: '',
    appVersion: '3.1.8',
    buildSha: 'worker-service-build'
  });
  t.after(() => service.terminate());

  const preview = await service.previewDatasetDeletion({
    targetMonth: '2026-06',
    sourceType: SOURCE_TYPES.RECHARGE
  });
  assert.equal(preview.deletable, true);
  assert.equal(preview.dataCount, 1);
  assert.throws(() => service.deleteDatasetData({
    targetMonth: '2026-06',
    sourceType: SOURCE_TYPES.RECHARGE
  }, undefined, BATCH_CONTEXT), (error) => {
    assert.equal(error.code, 'state-changed');
    assert.equal(error.message, '数据状态已变化，请刷新并重新确认。');
    return true;
  });
  assert.match(preview.previewToken, /^v2:/);
  const deleted = await service.deleteDatasetData({
    targetMonth: '2026-06',
    sourceType: SOURCE_TYPES.RECHARGE,
    expectedPreviewToken: preview.previewToken,
    taskGeneration: preview.taskGeneration,
    reason: 'C2 正式删除链'
  }, undefined, BATCH_CONTEXT);
  assert.equal(deleted.deletedDataCount, 1);
  assert.equal(deleted.invalidatedRunCount, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM vcc_fin_op_effective_rows').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM vcc_fin_op_runs').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM vcc_fin_op_datasets').get().n, 0);
  assert.equal(db.prepare(`
    SELECT COUNT(*) AS n FROM vcc_fin_op_operation_audit WHERE status = 'success'
  `).get().n, 1);
  const record = db.prepare(`
    SELECT dataset_deleted_at, dataset_deletion_id
    FROM vcc_fin_op_import_records WHERE id = ?
  `).get(recordId);
  assert.ok(record.dataset_deleted_at);
  assert.ok(record.dataset_deletion_id);
});

test('数据管理有效表通过 worker 流式导出并返回工作簿元数据', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vcc-export-worker-'));
  const dbPath = path.join(dir, 'tool-data.sqlite');
  const outputPath = path.join(dir, 'recharge-check.xlsx');
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL');
  ensureVccFinancialOpTablesSupport(db);
  repository.createImportBatch(db, { id: 'worker-export', targetMonth: '2026-06', fileCount: 1 });
  const recordId = repository.createImportRecord(db, {
    batchId: 'worker-export',
    targetMonth: '2026-06',
    sourceType: SOURCE_TYPES.RECHARGE,
    sourceFiles: ['recharge.xlsx']
  });
  repository.finishImportRecord(db, recordId, { status: 'success', rawCount: 1, insertedCount: 1 });
  repository.finishImportBatch(db, 'worker-export', 'success');
  const headers = require('../../../src/backend/vcc-financial-op/definitions')
    .getSourceDefinition(SOURCE_TYPES.RECHARGE).headers;
  const raw = headers.map((header) => ({
    订单号: '000123', BillDate: '2026-06-01', 业务部门: 'VCC', 对手部门: 'FX',
    业务子类型: '充值', 出入方向: 'in', 公司主体: 'PPHK', 我方币种: 'USD', 我方到账金额: '10'
  })[header] || '');
  db.prepare(`
    INSERT INTO vcc_fin_op_effective_rows (
      source_type, idempotency_key_raw, idempotency_key, content_hash,
      target_month, subject, stat_currency, signed_amount,
      source_file, sheet_name, source_row, raw_json, import_record_id
    ) VALUES (?, '000123', '000123', 'worker-export-hash',
      '2026-06', 'PPHK', 'USD', '10', 'recharge.xlsx', 'Sheet1', 2, ?, ?)
  `).run(SOURCE_TYPES.RECHARGE, JSON.stringify(raw), recordId);
  const service = createVccFinancialOpService({ database: { db, dbPath }, assetsDir: '' });
  t.after(async () => {
    await service.terminate();
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const preview = service.previewDatasetExport({
    targetMonth: '2026-06', sourceType: SOURCE_TYPES.RECHARGE, targetKind: 'check'
  });
  assert.equal(preview.exportable, true);
  assert.equal(preview.dataCount, 1);
  assert.equal(preview.taskGeneration, 0);
  const result = await service.exportDatasetData({
    targetMonth: '2026-06', sourceType: SOURCE_TYPES.RECHARGE, targetKind: 'check', outputPath,
    expectedInspection: preview,
    taskGeneration: preview.taskGeneration
  }, undefined, BATCH_CONTEXT);
  assert.equal(result.tableName, 'VCC充值清退明细_校验表');
  assert.equal(result.dataCount, 1);
  assert.equal(result.sheetCount, 1);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(outputPath);
  assert.equal(workbook.worksheets[0].getCell('A2').value, '000123');
  assert.equal(workbook.worksheets[0].getCell('J2').value, '10');
});

test('v1 detail 与 SYSTEM_OP 的 bound source 均调用 Archive 实体核验，损坏时整次拒绝', async (t) => {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  ensureVccFinancialOpTablesSupport(db);
  const insertBoundSource = (batchId, sourceType, artifactId, fileName) => {
    repository.createImportBatch(db, { id: batchId, targetMonth: '2026-06', fileCount: 1 });
    const recordId = repository.createImportRecord(db, {
      batchId,
      targetMonth: '2026-06',
      sourceType,
      sourceFiles: [fileName]
    });
    const sourceId = repository.createImportSource(db, recordId, {
      sourceOrdinal: 1,
      fileName,
      sha256: String(artifactId).padStart(64, 'a').slice(-64),
      sizeBytes: artifactId
    });
    db.prepare(`
      UPDATE vcc_fin_op_import_sources
      SET archive_state = 'ready', archive_artifact_id = ?
      WHERE id = ?
    `).run(artifactId, sourceId);
    repository.finishImportRecord(db, recordId, {
      status: 'success', rawCount: 1, insertedCount: 1
    });
    repository.finishImportBatch(db, batchId, 'success');
    return { recordId, sourceId };
  };
  const detail = insertBoundSource(
    'verify-v1-detail', SOURCE_TYPES.RECHARGE, 901, 'detail.xlsx'
  );
  db.prepare(`
    INSERT INTO vcc_fin_op_effective_rows (
      source_type, idempotency_key_raw, idempotency_key, content_hash,
      target_month, subject, source_file, sheet_name, source_row, raw_json,
      import_record_id, import_source_id
    ) VALUES (?, 'BOUND-DETAIL', 'BOUND-DETAIL', ?, '2026-06', 'PPHK',
      'detail.xlsx', 'Sheet1', 2, '[]', ?, ?)
  `).run(SOURCE_TYPES.RECHARGE, 'a'.repeat(64), detail.recordId, detail.sourceId);
  const system = insertBoundSource(
    'verify-v1-system', SOURCE_TYPES.SYSTEM_OP, 902, 'system.xlsx'
  );
  db.prepare(`
    INSERT INTO vcc_fin_op_system_snapshots (
      target_month, subject, balances_json, content_hash, source_file,
      sheet_name, source_row, raw_json, import_record_id, import_source_id
    ) VALUES ('2026-06', 'PPHK', '{}', ?, 'system.xlsx',
      'System', 2, '{}', ?, ?)
  `).run('b'.repeat(64), system.recordId, system.sourceId);

  const verificationCalls = [];
  const service = createVccFinancialOpService({
    database: { db, dbPath: ':memory:' },
    assetsDir: '',
    archiveServiceProvider: () => ({
      resolveVerifiedArtifact: async (artifactId) => {
        verificationCalls.push(artifactId);
        return {
          ok: false,
          code: 'ARCHIVE_BLOB_CORRUPT',
          message: 'artifact blob corrupt'
        };
      }
    })
  });
  t.after(async () => {
    await service.terminate();
    db.close();
  });

  for (const [sourceType, artifactId] of [
    [SOURCE_TYPES.RECHARGE, 901],
    [SOURCE_TYPES.SYSTEM_OP, 902]
  ]) {
    await assert.rejects(
      service.resolveDatasetArchiveSources({ targetMonth: '2026-06', sourceType }),
      (error) => error && error.code === 'ARCHIVE_BLOB_CORRUPT'
    );
    assert.equal(verificationCalls.at(-1), artifactId);
  }
});

test('全局任务租约拒绝并发并仅在任务释放后推进 generation', async (t) => {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  ensureVccFinancialOpTablesSupport(db);
  const workers = [];
  const service = createVccFinancialOpService({
    database: { db, dbPath: ':memory:' },
    assetsDir: '',
    workerFactory: createFakeWorkerFactory(workers)
  });
  t.after(async () => {
    await service.terminate();
    db.close();
  });

  const oldPreview = previewDataTargetDeletion(db, {
    targetMonth: '2026-06', targetType: SOURCE_TYPES.RECHARGE
  });
  assert.equal(oldPreview.taskGeneration, 0);
  const calculation = service.calculate({
    targetMonth: '2026-06',
    expectedInputFingerprint: 'a'.repeat(64)
  }, BATCH_CONTEXT);
  assert.equal(service._taskStateForTests().taskGeneration, 0);
  await assert.rejects(service.exportDatasetData({
    targetMonth: '2026-06', sourceType: SOURCE_TYPES.RECHARGE, targetKind: 'raw'
  }, undefined, BATCH_CONTEXT), (error) => error.code === 'active-vcc-task');
  await assert.rejects(
    service.resolveRecord({
      recordId: 1,
      note: '不会进入数据库写入',
      action: 'keep_current_effective_dataset'
    }, BATCH_CONTEXT),
    (error) => error.code === 'active-vcc-task'
  );

  workers[0].emit('message', { type: 'result', result: { status: 'calculated' } });
  await calculation;
  assert.equal(service._taskStateForTests().taskGeneration, 1);
  assert.throws(() => service.deleteDataTarget({
    targetMonth: '2026-06',
    targetType: SOURCE_TYPES.RECHARGE,
    expectedPreviewToken: oldPreview.previewToken,
    taskGeneration: oldPreview.taskGeneration
  }, undefined, BATCH_CONTEXT), (error) => {
    assert.equal(error.code, 'state-changed');
    assert.equal(error.message, '数据状态已变化，请刷新并重新确认。');
    return true;
  });
  for (const action of [
    () => service.unarchiveMonth({ targetMonth: '2026-06' }, undefined, BATCH_CONTEXT),
    () => service.deleteDataTarget(
      { targetMonth: '2026-06', targetType: SOURCE_TYPES.RECHARGE },
      undefined,
      BATCH_CONTEXT
    )
  ]) {
    assert.throws(action, (error) => {
      assert.equal(error.code, 'state-changed');
      assert.equal(error.message, '数据状态已变化，请刷新并重新确认。');
      return true;
    });
  }
  assert.equal(workers.length, 1);
});

test('service 在创建破坏性 worker 前按 raw payload 拒绝空串和非法 generation', async (t) => {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  ensureVccFinancialOpTablesSupport(db);
  const workers = [];
  const service = createVccFinancialOpService({
    database: { db, dbPath: ':memory:' },
    assetsDir: '',
    workerFactory: createFakeWorkerFactory(workers)
  });
  t.after(async () => {
    await service.terminate();
    db.close();
  });
  const unarchivePreview = previewLegacyUnarchive(db, '2026-06');
  const deletePreview = previewDataTargetDeletion(db, {
    targetMonth: '2026-06', targetType: SOURCE_TYPES.RECHARGE
  });
  const operations = [
    {
      call: (confirmation) => service.unarchiveMonth({
        targetMonth: '2026-06',
        ...confirmation
      }, undefined, BATCH_CONTEXT),
      token: unarchivePreview.previewToken
    },
    {
      call: (confirmation) => service.deleteDataTarget({
        targetMonth: '2026-06',
        targetType: SOURCE_TYPES.RECHARGE,
        ...confirmation
      }, undefined, BATCH_CONTEXT),
      token: deletePreview.previewToken
    }
  ];
  for (const operation of operations) {
    assert.throws(() => operation.call({
      expectedPreviewToken: '',
      previewToken: operation.token,
      taskGeneration: 0
    }), (error) => error.code === 'state-changed');
    for (const invalidGeneration of [
      undefined,
      null,
      '',
      Number.NaN,
      -1,
      Number.MAX_SAFE_INTEGER + 1
    ]) {
      assert.throws(() => operation.call({
        expectedPreviewToken: operation.token,
        taskGeneration: invalidGeneration
      }), (error) => error.code === 'invalid-task-generation');
    }
  }
  assert.equal(workers.length, 0, '非法 raw confirmation 不得创建 worker');
  assert.deepEqual(service._taskStateForTests(), {
    taskGeneration: 0,
    closing: false,
    active: false,
    action: null,
    phase: null,
    protected: false
  });
});

test('破坏性 worker 进入 critical-ready 后取消与退出只等待、不 terminate', async (t) => {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  ensureVccFinancialOpTablesSupport(db);
  const workers = [];
  const service = createVccFinancialOpService({
    database: { db, dbPath: ':memory:' },
    assetsDir: '',
    writeWorkerFactory: createFakeWorkerFactory(workers),
    cancelTimeoutMs: 10
  });
  t.after(() => db.close());
  const preview = previewLegacyUnarchive(db, '2026-06');
  const operation = service.unarchiveMonth({
    targetMonth: '2026-06',
    expectedPreviewToken: preview.previewToken,
    taskGeneration: preview.taskGeneration
  }, undefined, BATCH_CONTEXT);
  const worker = workers[0];
  worker.emit('message', { type: 'critical-ready' });
  assert.deepEqual(worker.sentMessages, [{ type: 'critical-ack' }]);
  assert.equal(service._taskStateForTests().protected, true);
  await assert.rejects(
    service.exportRun(
      { targetMonth: '2026-06', outputPath: '/tmp/blocked-by-unarchive.xlsx' },
      BATCH_CONTEXT
    ),
    (error) => error.code === 'active-vcc-task',
    '解归档持有全局租约时必须拒绝结果导出'
  );

  let terminated = false;
  const termination = service.terminate().then(() => { terminated = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(terminated, false);
  assert.equal(worker.terminateCount, 0);
  worker.emit('message', {
    type: 'result',
    result: { status: 'unarchived', targetMonth: '2026-06' }
  });
  assert.equal((await operation).status, 'unarchived');
  await termination;
  assert.equal(worker.terminateCount, 0);
  await assert.rejects(
    service.calculate({
      targetMonth: '2026-07',
      expectedInputFingerprint: 'a'.repeat(64)
    }, BATCH_CONTEXT),
    (error) => error.code === 'service-closing'
  );
});

test('破坏性 worker 在事务前可协作取消且不强杀', async (t) => {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  ensureVccFinancialOpTablesSupport(db);
  const workers = [];
  const service = createVccFinancialOpService({
    database: { db, dbPath: ':memory:' },
    assetsDir: '',
    writeWorkerFactory: createFakeWorkerFactory(workers),
    cancelTimeoutMs: 50
  });
  t.after(async () => {
    await service.terminate();
    db.close();
  });
  const preview = previewDataTargetDeletion(db, {
    targetMonth: '2026-06', targetType: SOURCE_TYPES.RECHARGE
  });
  const operation = service.deleteDataTarget({
    targetMonth: '2026-06',
    targetType: SOURCE_TYPES.RECHARGE,
    expectedPreviewToken: preview.previewToken,
    taskGeneration: preview.taskGeneration
  }, undefined, BATCH_CONTEXT);
  const rejection = assert.rejects(operation, (error) => error.code === 'operation-cancelled');
  const worker = workers[0];
  const acceptedOrder = [];
  const cancellation = service.cancelActiveTask(() => {
    acceptedOrder.push('lifecycle-cancelled');
    assert.deepEqual(worker.sentMessages, [], '先终结原批次，再通知 worker');
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(acceptedOrder, ['lifecycle-cancelled']);
  assert.deepEqual(worker.sentMessages, [{ type: 'cancel' }]);
  worker.emit('message', {
    type: 'error',
    error: { name: 'Error', message: '操作已取消', code: 'operation-cancelled' }
  });
  await rejection;
  assert.deepEqual(await cancellation, { status: 'cancelled', forced: false });
  assert.equal(worker.terminateCount, 0);
});

test('窗口关闭先取消且 worker 停在未受保护 critical-ready 时，超时后可安全终止', async (t) => {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  ensureVccFinancialOpTablesSupport(db);
  const workers = [];
  const service = createVccFinancialOpService({
    database: { db, dbPath: ':memory:' },
    assetsDir: '',
    writeWorkerFactory: createFakeWorkerFactory(workers),
    cancelTimeoutMs: 5
  });
  t.after(() => db.close());
  const preview = previewDataTargetDeletion(db, {
    targetMonth: '2026-06', targetType: SOURCE_TYPES.RECHARGE
  });
  const operation = service.deleteDataTarget({
    targetMonth: '2026-06',
    targetType: SOURCE_TYPES.RECHARGE,
    expectedPreviewToken: preview.previewToken,
    taskGeneration: preview.taskGeneration
  }, undefined, BATCH_CONTEXT);
  const rejection = assert.rejects(operation, /后台任务退出但未返回结果/);
  const termination = service.terminate();
  const worker = workers[0];
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(worker.sentMessages, [{ type: 'cancel' }]);

  worker.emit('message', { type: 'critical-ready' });
  assert.equal(service._taskStateForTests().phase, 'critical-ready');
  assert.equal(service._taskStateForTests().protected, false);
  assert.deepEqual(worker.sentMessages, [{ type: 'cancel' }, { type: 'cancel' }]);

  await termination;
  await rejection;
  assert.equal(worker.terminateCount, 1);
  assert.equal(service._taskStateForTests().active, false);
});

test('无调整的历史归档仍可导出，且直接结果导出持有同一租约', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vcc-result-export-read-'));
  const dbPath = path.join(dir, 'tool-data.sqlite');
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL');
  ensureVccFinancialOpTablesSupport(db);
  const runId = Number(db.prepare(`
    INSERT INTO vcc_fin_op_runs (
      target_month, status, input_revisions_json, input_fingerprint,
      created_at, updated_at, archived_at
    ) VALUES (
      '2026-06', 'archived', ?, ?, '2026-08-01 08:00:00',
      '2026-08-01 09:00:00', '2026-08-01 09:00:00'
    )
  `).run(
    JSON.stringify(Object.fromEntries(REQUIRED_DATASET_TYPES.map((type) => [type, 1]))),
    'a'.repeat(64)
  ).lastInsertRowid);
  db.prepare(`
    INSERT INTO vcc_fin_op_run_rows (
      run_id, subject, row_kind, source_type,
      category_major, category_minor, currency, amount
    ) VALUES (?, 'PPHK', 'movement', ?, '充值', '正常', 'USD', '10')
  `).run(runId, SOURCE_TYPES.RECHARGE);
  const insertBalance = db.prepare(`
    INSERT INTO vcc_fin_op_run_balances (
      run_id, subject, currency, opening_balance, period_amount,
      calculated_balance, system_balance, difference
    ) VALUES (?, 'PPHK', ?, '100', ?, ?, ?, '0')
  `);
  const archivedBalances = {};
  for (const currency of SUPPORTED_CURRENCIES) {
    const periodAmount = currency === 'USD' ? '10' : '0';
    const calculatedBalance = currency === 'USD' ? '110' : '100';
    insertBalance.run(runId, currency, periodAmount, calculatedBalance, calculatedBalance);
    archivedBalances[currency] = calculatedBalance;
  }
  db.prepare(`
    INSERT INTO vcc_fin_op_archives (
      target_month, subject, balances_json, run_id, archived_at
    ) VALUES ('2026-06', 'PPHK', ?, ?, '2026-08-01 09:00:00')
  `).run(JSON.stringify(archivedBalances), runId);
  const insertDataset = db.prepare(`
    INSERT INTO vcc_fin_op_datasets (
      target_month, dataset_type, data_status, archived_run_id,
      generated_at, updated_at
    ) VALUES (
      '2026-06', ?, 'archived', ?, '2026-08-01 08:00:00', '2026-08-01 09:00:00'
    )
  `);
  for (const datasetType of REQUIRED_DATASET_TYPES) insertDataset.run(datasetType, runId);
  db.prepare(`
    INSERT INTO vcc_fin_op_runs (
      target_month, status, created_at, updated_at, archived_at
    ) VALUES (
      '2026-07', 'archived', '2026-08-02 08:00:00',
      '2026-08-02 09:00:00', '2026-08-02 09:00:00'
    )
  `).run();
  let releaseWriter;
  let writerStarted;
  let writerArgs;
  const started = new Promise((resolve) => { writerStarted = resolve; });
  const service = createVccFinancialOpService({
    database: { db, dbPath },
    assetsDir: '',
    writeRunWorkbooksFn: (args) => {
      writerArgs = args;
      writerStarted();
      return new Promise((resolve) => { releaseWriter = resolve; });
    }
  });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  assert.equal(db.prepare(`
    SELECT COUNT(*) AS row_count FROM vcc_fin_op_run_adjustments WHERE run_id = ?
  `).get(runId).row_count, 0, '历史归档没有人工调整');
  assert.equal((await service.latestArchivedRun()).runId, runId, '不一致的更新 archived run 不得成为 latest');
  assert.deepEqual(await service.getArchivedRunByMonth('2026-06'), {
    targetMonth: '2026-06',
    runId,
    archivedAt: '2026-08-01 09:00:00',
    resultRevision: 0,
    subjects: ['PPHK'],
    archiveContract: 'current-five-dataset'
  });
  await assert.rejects(
    service.exportRun({
      targetMonth: '2026-07',
      runId,
      outputPath: '/tmp/must-not-export.xlsx'
    }, BATCH_CONTEXT),
    (error) => error.code === 'archive-state-inconsistent',
    '外部 runId 不得覆盖租约内 targetMonth 解析'
  );
  assert.equal(writerArgs, undefined);

  const exporting = service.exportRun(
    { targetMonth: '2026-06', outputPath: '/tmp/fixture.xlsx' },
    BATCH_CONTEXT
  );
  await started;
  assert.equal(service._taskStateForTests().action, 'export-result');
  assert.equal(writerArgs.runId, runId, 'runId 必须在租约内由 targetMonth 严格解析');
  const unarchivePreview = await service.previewUnarchive({ targetMonth: '2026-06' });
  assert.equal(unarchivePreview.code, 'active-vcc-task');
  assert.throws(
    () => service.unarchiveMonth({
      targetMonth: '2026-06',
      expectedPreviewToken: unarchivePreview.previewToken,
      taskGeneration: unarchivePreview.taskGeneration
    }, undefined, BATCH_CONTEXT),
    (error) => error.code === 'active-vcc-task',
    '结果导出持有全局租约时必须拒绝解归档'
  );
  const concurrentPreview = service.previewDatasetExport({
    targetMonth: '2026-06', sourceType: SOURCE_TYPES.RECHARGE, targetKind: 'raw'
  });
  assert.equal(concurrentPreview.exportable, false);
  let terminationDone = false;
  const termination = service.terminate().then(() => { terminationDone = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(terminationDone, false);
  releaseWriter({ filePaths: ['/tmp/fixture.xlsx'] });
  assert.deepEqual(await exporting, { filePaths: ['/tmp/fixture.xlsx'] });
  await termination;
  db.close();
});

test('VCC 结果导出在 durable publication 确认后才触发提前附件结算', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vcc-result-durable-publication-'));
  const dbPath = path.join(dir, 'tool-data.sqlite');
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA foreign_keys = ON');
  ensureVccFinancialOpTablesSupport(db);
  const runId = seedCalculatedReviewRun(db);
  const balances = Object.fromEntries(db.prepare(`
    SELECT currency, calculated_balance FROM vcc_fin_op_run_balances WHERE run_id = ?
  `).all(runId).map((row) => [row.currency, row.calculated_balance]));
  db.prepare(`
    UPDATE vcc_fin_op_runs SET status = 'archived', archived_at = CURRENT_TIMESTAMP WHERE id = ?
  `).run(runId);
  db.prepare(`
    INSERT INTO vcc_fin_op_archives (target_month, subject, balances_json, run_id)
    VALUES ('2026-06', 'PPHK', ?, ?)
  `).run(JSON.stringify(balances), runId);
  db.prepare(`
    UPDATE vcc_fin_op_datasets
    SET data_status = 'archived', archived_run_id = ?, updated_at = CURRENT_TIMESTAMP
    WHERE target_month = '2026-06'
  `).run(runId);
  let publicationPayload;
  let settlementResult;
  const service = createVccFinancialOpService({
    database: { db, dbPath },
    assetsDir: '',
    writeRunWorkbooksFn: async () => ({
      runId,
      targetMonth: '2026-06',
      subjects: ['PPHK'],
      filePaths: ['/tmp/final-vcc-result.xlsx'],
      generationFilePaths: ['/tmp/generated-vcc-result.xlsx']
    }),
    publishOutputFilesFn: async (payload) => {
      publicationPayload = payload;
      await payload.onDurableHandoff({ taskId: 'receipt-1' });
    }
  });
  t.after(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const result = await service.exportRun({
    targetMonth: '2026-06',
    outputPath: '/tmp/final-vcc-result.xlsx',
    publicationStagingDirectory: '/tmp/vcc-generation',
    targetSnapshots: [{ exists: false }],
    onDurableHandoff(_publication, exportResult) {
      settlementResult = exportResult;
    }
  }, BATCH_CONTEXT);

  assert.deepEqual(publicationPayload.batchContext, BATCH_CONTEXT);
  assert.deepEqual(publicationPayload.targetFilePaths, ['/tmp/final-vcc-result.xlsx']);
  assert.equal(settlementResult.runId, runId);
  assert.equal(result.generationFilePaths, undefined);
  assert.deepEqual(result.filePaths, ['/tmp/final-vcc-result.xlsx']);
});
