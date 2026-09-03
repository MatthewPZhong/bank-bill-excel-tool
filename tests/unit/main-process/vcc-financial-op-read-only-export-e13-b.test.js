'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const {
  ensureVccFinancialOpTablesSupport
} = require('../../../src/backend/vcc-financial-op-db/migrations');
const repository = require('../../../src/backend/vcc-financial-op-db/repository');
const {
  SOURCE_TYPES,
  getSourceDefinition
} = require('../../../src/backend/vcc-financial-op/definitions');
const {
  writeImportAuditWorkbook
} = require('../../../src/main-process/vcc-financial-op-audit-writer');
const {
  writeDatasetWorkbook
} = require('../../../src/main-process/vcc-financial-op-dataset-writer');
const {
  normalizeVccFinancialOpReadOnlyExportInput
} = require('../../../src/main-process/read-only-exports/vcc-financial-op/actions');
const {
  generateValidateAndPublishVccFinancialOpExport
} = require('../../../src/main-process/read-only-exports/vcc-financial-op/managed-export');
const {
  VCC_FINANCIAL_OP_READ_ONLY_ACTION,
  validateVccFinancialOpReadOnlyExportResult
} = require('../../../src/main-process/read-only-exports/vcc-financial-op/policies');
const {
  assertVccFinancialOpSourceSnapshot,
  freezeVccDatasetSourceSnapshot,
  freezeVccImportAuditSourceSnapshot
} = require('../../../src/main-process/read-only-exports/vcc-financial-op/query');
const {
  executeVccFinancialOpReadOnlyExport,
  writeDataset
} = require('../../../src/main-process/read-only-exports/vcc-financial-op/writer');
const {
  readWorkbookBusinessEvidence
} = require('../../../src/main-process/read-only-exports/common/workbook-evidence');
const {
  createBackgroundExecutionRuntime
} = require('../../../src/main-process/background-execution/runtime');
const {
  createVccFinancialOpService
} = require('../../../src/main-process/vcc-financial-op-service');

function createDatabaseFixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vcc-read-only-e13-b-'));
  const dbPath = path.join(directory, 'tool-data.sqlite');
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL');
  ensureVccFinancialOpTablesSupport(db);
  t.after(() => {
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return { db, dbPath, directory };
}

function createAuditRecord(db, suffix = 'audit') {
  const batchId = `batch-${suffix}`;
  repository.createImportBatch(db, {
    id: batchId,
    targetMonth: '2026-08',
    fileCount: 1
  });
  const recordId = repository.createImportRecord(db, {
    batchId,
    targetMonth: '2026-08',
    sourceType: SOURCE_TYPES.RECHARGE,
    sourceFiles: [`${suffix}.xlsx`]
  });
  repository.addImportAnomaly(db, recordId, {
    sourceType: SOURCE_TYPES.RECHARGE,
    targetMonth: '2026-08',
    idempotencyKey: `VCC-${suffix}`,
    sourceFile: `${suffix}.xlsx`,
    sourceRow: 7,
    category: 'idempotent_conflict',
    abnormalFields: ['订单号'],
    diffFields: ['我方到账金额'],
    description: '相同幂等键对应内容不一致',
    incomingContentHash: 'a'.repeat(64),
    existingContentHash: 'b'.repeat(64)
  });
  repository.finishImportRecord(db, recordId, {
    status: 'failed_conflict',
    rawCount: 1,
    conflictCount: 1,
    anomalyCount: 1
  });
  repository.finishImportBatch(db, batchId, 'completed_with_errors');
  return recordId;
}

function createDatasetRecord(db, suffix = 'dataset') {
  const batchId = `batch-${suffix}`;
  repository.createImportBatch(db, {
    id: batchId,
    targetMonth: '2026-08',
    fileCount: 1
  });
  const recordId = repository.createImportRecord(db, {
    batchId,
    targetMonth: '2026-08',
    sourceType: SOURCE_TYPES.RECHARGE,
    sourceFiles: [`${suffix}.xlsx`]
  });
  const definition = getSourceDefinition(SOURCE_TYPES.RECHARGE);
  const valuesByHeader = {
    订单号: '000-E13-B',
    BillDate: '2026-08-20',
    业务部门: 'VCC',
    对手部门: 'FX',
    业务子类型: '充值',
    出入方向: 'in',
    公司主体: 'PPHK',
    我方币种: 'USD',
    我方到账金额: '12.34'
  };
  const rawValues = definition.headers.map((header) => valuesByHeader[header] || '');
  db.prepare(`
    INSERT INTO vcc_fin_op_effective_rows (
      source_type, idempotency_key_raw, idempotency_key, content_hash,
      target_month, subject, stat_currency, signed_amount,
      source_file, sheet_name, source_row, raw_json, import_record_id
    ) VALUES (?, '000-E13-B', '000-E13-B', ?, '2026-08', 'PPHK', 'USD', '12.34',
              ?, 'Sheet1', 2, ?, ?)
  `).run(
    SOURCE_TYPES.RECHARGE,
    'dataset-e13-b-hash',
    `${suffix}.xlsx`,
    JSON.stringify(rawValues),
    recordId
  );
  repository.finishImportRecord(db, recordId, {
    status: 'success',
    rawCount: 1,
    insertedCount: 1
  });
  repository.finishImportBatch(db, batchId, 'success');
  db.prepare(`
    INSERT INTO vcc_fin_op_datasets (
      target_month, dataset_type, data_status, revision, generated_at, updated_at
    ) VALUES ('2026-08', ?, 'unprocessed', 1,
              '2026-08-30 12:00:00', '2026-08-30 12:00:00')
  `).run(SOURCE_TYPES.RECHARGE);
  return recordId;
}

function generationPlan(directory, fileName) {
  return Object.freeze({
    stagingRoot: directory,
    stagingResourceId: fileName,
    generationPath: path.join(directory, fileName),
    outputArtifactKey: `artifact-${fileName}`
  });
}

function workerInput(fixture, frozen, plan, operationKey = 'vcc-e13-b-operation') {
  return {
    actionKey: VCC_FINANCIAL_OP_READ_ONLY_ACTION,
    operationKey,
    taskRunId: 'vcc-e13-b-task',
    stableRunEvidence: frozen.evidence,
    dbPathOrManagedSource: {
      kind: 'sqlite',
      mainDatabasePath: fixture.dbPath
    },
    generationPlan: plan,
    context: frozen.context
  };
}

function batchContext(operationKey = 'vcc-e13-b-operation') {
  return Object.freeze({
    taskRunId: 'vcc-e13-b-task',
    taskKey: 'vccFinancialOp:export:import-audit',
    moduleId: 'vcc-financial-op',
    parentRunId: 'vcc-e13-b-parent',
    operationKey
  });
}

test('E13-B VCC import audit worker 与 legacy workbook 语义 golden 等价，真实 Runtime 可执行', async (t) => {
  const fixture = createDatabaseFixture(t);
  const recordId = createAuditRecord(fixture.db);
  const frozen = freezeVccImportAuditSourceSnapshot({ db: fixture.db, recordId });
  const legacyPath = path.join(fixture.directory, 'legacy-audit.xlsx');
  await writeImportAuditWorkbook({ db: fixture.db, recordId, outputPath: legacyPath });

  const directRoot = fs.mkdtempSync(path.join(fixture.directory, 'direct-'));
  const directPlan = generationPlan(directRoot, 'audit.xlsx');
  const direct = await executeVccFinancialOpReadOnlyExport(
    workerInput(fixture, frozen, directPlan),
    null
  );
  assert.equal(validateVccFinancialOpReadOnlyExportResult(direct), true);
  assert.deepEqual(
    readWorkbookBusinessEvidence(directPlan.generationPath),
    readWorkbookBusinessEvidence(legacyPath)
  );
  assert.deepEqual(direct.summary, {
    variant: 'import-audit', recordId, rowCount: 1, sheetCount: 1
  });
  const inconsistentAudit = structuredClone(direct);
  inconsistentAudit.summary.rowCount += 1;
  assert.equal(validateVccFinancialOpReadOnlyExportResult(inconsistentAudit), false);

  const runtime = createBackgroundExecutionRuntime({
    availableParallelism: 4,
    totalMemoryBytes: 8 * 1024 ** 3,
    freeMemoryBytes: 4 * 1024 ** 3
  });
  t.after(async () => runtime.shutdown({ timeoutMs: 5000 }));
  const runtimeRoot = fs.mkdtempSync(path.join(fixture.directory, 'runtime-'));
  const runtimePlan = generationPlan(runtimeRoot, 'audit-runtime.xlsx');
  const operationKey = 'vcc-e13-b-runtime-operation';
  const execution = await runtime.execute({
    actionKey: VCC_FINANCIAL_OP_READ_ONLY_ACTION,
    operationKey,
    production: false,
    context: { kind: 'operation', value: batchContext(operationKey) },
    input: workerInput(fixture, frozen, runtimePlan, operationKey)
  });
  assert.equal(execution.outcome, 'completed');
  assert.equal(execution.terminalSource, 'job:done');
  assert.equal(execution.result.summary.recordId, recordId);
});

test('E13-B VCC import audit 仅接受有异常的终态 record，deleted audit 仍可追溯', (t) => {
  const fixture = createDatabaseFixture(t);
  repository.createImportBatch(fixture.db, {
    id: 'batch-active', targetMonth: '2026-08', fileCount: 1
  });
  const activeId = repository.createImportRecord(fixture.db, {
    batchId: 'batch-active',
    targetMonth: '2026-08',
    sourceType: SOURCE_TYPES.RECHARGE,
    sourceFiles: ['active.xlsx']
  });
  assert.throws(
    () => freezeVccImportAuditSourceSnapshot({ db: fixture.db, recordId: activeId }),
    (error) => error && error.code === 'VCC_IMPORT_AUDIT_RECORD_NOT_STABLE'
  );
  repository.finishImportRecord(fixture.db, activeId, {
    status: 'all_skipped', rawCount: 1, skippedCount: 1, anomalyCount: 0
  });
  assert.throws(
    () => freezeVccImportAuditSourceSnapshot({ db: fixture.db, recordId: activeId }),
    (error) => error && error.code === 'VCC_IMPORT_AUDIT_EMPTY'
  );

  const deletedId = createAuditRecord(fixture.db, 'deleted-audit');
  fixture.db.prepare(`
    UPDATE vcc_fin_op_import_records
    SET dataset_deleted_at = '2026-08-30 12:00:00', dataset_deletion_id = 7
    WHERE id = ?
  `).run(deletedId);
  const frozen = freezeVccImportAuditSourceSnapshot({ db: fixture.db, recordId: deletedId });
  assert.equal(frozen.evidence.recordId, deletedId);
  assert.equal(frozen.evidence.anomalyCount, 1);
});

test('E13-B VCC import audit 的 record 或 anomaly 集合漂移均 fail closed', (t) => {
  const fixture = createDatabaseFixture(t);
  const recordId = createAuditRecord(fixture.db, 'stale-audit');
  const frozen = freezeVccImportAuditSourceSnapshot({ db: fixture.db, recordId });
  fixture.db.prepare(`
    UPDATE vcc_fin_op_import_anomalies
    SET description = '被修改的异常说明'
    WHERE import_record_id = ?
  `).run(recordId);
  const changed = freezeVccImportAuditSourceSnapshot({ db: fixture.db, recordId });
  assert.throws(
    () => assertVccFinancialOpSourceSnapshot(changed, frozen.evidence),
    (error) => error && error.code === 'VCC_FINANCIAL_OP_EXPORT_SOURCE_STALE'
  );
});

test('E13-B VCC import audit 的持久 source lineage 损坏时不得降级为空来源', (t) => {
  const fixture = createDatabaseFixture(t);
  const recordId = createAuditRecord(fixture.db, 'invalid-lineage-audit');
  fixture.db.prepare(`
    UPDATE vcc_fin_op_import_records SET source_files_json = '{broken-json'
    WHERE id = ?
  `).run(recordId);
  assert.throws(
    () => freezeVccImportAuditSourceSnapshot({ db: fixture.db, recordId }),
    (error) => error && error.code === 'VCC_IMPORT_AUDIT_RECORD_INVALID'
  );
});

test('E13-B VCC import audit 的异常字段 JSON 损坏时不得静默导出空字段', (t) => {
  const fixture = createDatabaseFixture(t);
  const recordId = createAuditRecord(fixture.db, 'invalid-anomaly-json');
  fixture.db.prepare(`
    UPDATE vcc_fin_op_import_anomalies SET abnormal_fields_json = '{broken-json'
    WHERE import_record_id = ?
  `).run(recordId);
  assert.throws(
    () => freezeVccImportAuditSourceSnapshot({ db: fixture.db, recordId }),
    (error) => error && error.code === 'VCC_IMPORT_AUDIT_ROW_INVALID'
  );
});

test('E13-B VCC dataset worker 保留原 SQL、排序、Workbook 与 inspection golden', async (t) => {
  const fixture = createDatabaseFixture(t);
  createDatasetRecord(fixture.db);
  const frozen = freezeVccDatasetSourceSnapshot({
    db: fixture.db,
    targetMonth: '2026-08',
    sourceType: SOURCE_TYPES.RECHARGE,
    targetKind: 'check',
    archiveSources: []
  });
  const legacyPath = path.join(fixture.directory, 'legacy-dataset.xlsx');
  await writeDatasetWorkbook({
    db: fixture.db,
    targetMonth: '2026-08',
    sourceType: SOURCE_TYPES.RECHARGE,
    targetKind: 'check',
    outputPath: legacyPath,
    expectedInspection: frozen.context.expectedInspection
  });
  const workerRoot = fs.mkdtempSync(path.join(fixture.directory, 'dataset-worker-'));
  const plan = generationPlan(workerRoot, 'dataset.xlsx');
  const result = await executeVccFinancialOpReadOnlyExport(
    workerInput(fixture, frozen, plan),
    null
  );
  assert.equal(validateVccFinancialOpReadOnlyExportResult(result), true);
  assert.deepEqual(
    readWorkbookBusinessEvidence(plan.generationPath),
    readWorkbookBusinessEvidence(legacyPath)
  );
  assert.deepEqual(result.summary, {
    variant: 'dataset',
    targetMonth: '2026-08',
    sourceType: SOURCE_TYPES.RECHARGE,
    targetKind: 'check',
    dataCount: 1,
    totalRows: 1,
    missingRows: 0,
    incomplete: false,
    sheetCount: 1
  });
  const inconsistentDataset = structuredClone(result);
  inconsistentDataset.summary.missingRows = 1;
  inconsistentDataset.summary.incomplete = true;
  assert.equal(validateVccFinancialOpReadOnlyExportResult(inconsistentDataset), false);

  const invalidInput = structuredClone(workerInput(
    fixture,
    frozen,
    generationPlan(fs.mkdtempSync(path.join(fixture.directory, 'invalid-input-')), 'invalid.xlsx')
  ));
  invalidInput.context.expectedInspection.incomplete = 'false';
  assert.throws(
    () => normalizeVccFinancialOpReadOnlyExportInput(invalidInput),
    (error) => error && error.code === 'VCC_FINANCIAL_OP_EXPORT_INPUT_INVALID'
  );
});

test('E13-B VCC dataset 的来源重验与 legacy writer 共用一个 read transaction', async (t) => {
  const fixture = createDatabaseFixture(t);
  createDatasetRecord(fixture.db, 'transaction-dataset');
  const frozen = freezeVccDatasetSourceSnapshot({
    db: fixture.db,
    targetMonth: '2026-08',
    sourceType: SOURCE_TYPES.RECHARGE,
    targetKind: 'check',
    archiveSources: []
  });
  const root = fs.mkdtempSync(path.join(fixture.directory, 'transaction-worker-'));
  const input = workerInput(fixture, frozen, generationPlan(root, 'transaction.xlsx'));
  const transactionEvents = [];
  const readDb = new DatabaseSync(fixture.dbPath, { readOnly: true });
  readDb.exec('PRAGMA query_only = ON; PRAGMA busy_timeout = 30000;');
  const instrumentedDb = new Proxy(readDb, {
    get(target, property) {
      if (property === 'exec') {
        return (sql) => {
          transactionEvents.push(String(sql).trim().toUpperCase());
          return target.exec(sql);
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    }
  });

  let written;
  try {
    written = await writeDataset(input, instrumentedDb, null);
  } finally {
    // Windows 不允许 fixture cleanup 在只读句柄仍打开时 unlink SQLite 文件。
    // 显式关闭本测试拥有的句柄，不能依赖多个 t.after hook 的注册顺序。
    readDb.close();
  }

  assert.equal(written.result.dataCount, 1);
  assert.deepEqual(transactionEvents, ['BEGIN', 'COMMIT']);
});

test('E13-B VCC managed export 只在三次 freshness 与回读验证后调用一次 Publisher', async (t) => {
  const fixture = createDatabaseFixture(t);
  const recordId = createAuditRecord(fixture.db, 'managed-audit');
  const frozen = freezeVccImportAuditSourceSnapshot({ db: fixture.db, recordId });
  const root = fs.mkdtempSync(path.join(fixture.directory, 'managed-'));
  const plan = generationPlan(root, 'managed.xlsx');
  let freshnessChecks = 0;
  let publisherCalls = 0;
  const input = workerInput(fixture, frozen, plan);
  const generated = await generateValidateAndPublishVccFinancialOpExport({
    runtime: {
      execute: async ({ input: runtimeInput }) => ({
        outcome: 'completed',
        terminalSource: 'job:done',
        result: await executeVccFinancialOpReadOnlyExport(runtimeInput, null)
      })
    },
    actionKey: input.actionKey,
    operationKey: input.operationKey,
    taskRunId: input.taskRunId,
    batchContext: batchContext(),
    stableRunEvidence: input.stableRunEvidence,
    dbPathOrManagedSource: input.dbPathOrManagedSource,
    generationPlan: plan,
    context: input.context,
    production: false,
    assertSourceFresh() {
      freshnessChecks += 1;
      return assertVccFinancialOpSourceSnapshot(
        freezeVccImportAuditSourceSnapshot({ db: fixture.db, recordId }),
        frozen.evidence
      );
    },
    publisher: async (artifacts, summary) => {
      publisherCalls += 1;
      assert.equal(artifacts.length, 1);
      assert.equal(summary.recordId, recordId);
      return Object.freeze({ taskId: 'vcc-e13-b-publication' });
    }
  });
  assert.equal(freshnessChecks, 3);
  assert.equal(publisherCalls, 1);
  assert.equal(generated.publication.taskId, 'vcc-e13-b-publication');
});

test('E13-B VCC Worker 预启动取消不生成 artifact', async (t) => {
  const fixture = createDatabaseFixture(t);
  const recordId = createAuditRecord(fixture.db, 'cancelled-audit');
  const frozen = freezeVccImportAuditSourceSnapshot({ db: fixture.db, recordId });
  const root = fs.mkdtempSync(path.join(fixture.directory, 'cancelled-'));
  const plan = generationPlan(root, 'cancelled.xlsx');
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    executeVccFinancialOpReadOnlyExport(workerInput(fixture, frozen, plan), controller.signal),
    (error) => error && error.code === 'VCC_FINANCIAL_OP_EXPORT_CANCELLED'
  );
  assert.equal(fs.existsSync(plan.generationPath), false);
});

test('E13-B VCC dataset 在冻结后漂移时由 Worker fail closed 且不留 artifact', async (t) => {
  const fixture = createDatabaseFixture(t);
  createDatasetRecord(fixture.db, 'stale-dataset');
  const frozen = freezeVccDatasetSourceSnapshot({
    db: fixture.db,
    targetMonth: '2026-08',
    sourceType: SOURCE_TYPES.RECHARGE,
    targetKind: 'check',
    archiveSources: []
  });
  fixture.db.prepare(`
    UPDATE vcc_fin_op_effective_rows
    SET signed_amount = '99.99'
    WHERE target_month = '2026-08' AND source_type = ?
  `).run(SOURCE_TYPES.RECHARGE);
  fixture.db.prepare(`
    UPDATE vcc_fin_op_datasets
    SET revision = revision + 1, updated_at = '2026-08-30 12:05:00'
    WHERE target_month = '2026-08' AND dataset_type = ?
  `).run(SOURCE_TYPES.RECHARGE);
  const root = fs.mkdtempSync(path.join(fixture.directory, 'stale-dataset-worker-'));
  const plan = generationPlan(root, 'stale-dataset.xlsx');

  await assert.rejects(
    executeVccFinancialOpReadOnlyExport(workerInput(fixture, frozen, plan), null),
    (error) => error && error.code === 'VCC_FINANCIAL_OP_EXPORT_SOURCE_STALE'
  );
  assert.equal(fs.existsSync(plan.generationPath), false);
});

test('E13-B VCC artifact 被篡改时 Publisher 不得执行', async (t) => {
  const fixture = createDatabaseFixture(t);
  const recordId = createAuditRecord(fixture.db, 'tampered-audit');
  const frozen = freezeVccImportAuditSourceSnapshot({ db: fixture.db, recordId });
  const root = fs.mkdtempSync(path.join(fixture.directory, 'tampered-'));
  const plan = generationPlan(root, 'tampered.xlsx');
  const input = workerInput(fixture, frozen, plan);
  let publisherCalls = 0;

  await assert.rejects(
    generateValidateAndPublishVccFinancialOpExport({
      runtime: {
        execute: async ({ input: runtimeInput }) => {
          const result = await executeVccFinancialOpReadOnlyExport(runtimeInput, null);
          fs.appendFileSync(plan.generationPath, 'tampered-after-worker');
          return { outcome: 'completed', terminalSource: 'job:done', result };
        }
      },
      actionKey: input.actionKey,
      operationKey: input.operationKey,
      taskRunId: input.taskRunId,
      batchContext: batchContext(),
      stableRunEvidence: input.stableRunEvidence,
      dbPathOrManagedSource: input.dbPathOrManagedSource,
      generationPlan: plan,
      context: input.context,
      production: false,
      publisher: async () => {
        publisherCalls += 1;
        return Object.freeze({ taskId: 'must-not-publish' });
      }
    }),
    (error) => error && error.code === 'VCC_FINANCIAL_OP_EXPORT_ARTIFACT_TAMPERED'
  );
  assert.equal(publisherCalls, 0);
});

test('E13-B VCC Publisher 失败向上传播且不产生正式目标', async (t) => {
  const fixture = createDatabaseFixture(t);
  const recordId = createAuditRecord(fixture.db, 'publisher-failure');
  const frozen = freezeVccImportAuditSourceSnapshot({ db: fixture.db, recordId });
  const root = fs.mkdtempSync(path.join(fixture.directory, 'publisher-failure-'));
  const plan = generationPlan(root, 'publisher-failure.xlsx');
  const targetPath = path.join(fixture.directory, 'formal-output.xlsx');
  const input = workerInput(fixture, frozen, plan);
  let publisherCalls = 0;

  await assert.rejects(
    generateValidateAndPublishVccFinancialOpExport({
      runtime: {
        execute: async ({ input: runtimeInput }) => ({
          outcome: 'completed',
          terminalSource: 'job:done',
          result: await executeVccFinancialOpReadOnlyExport(runtimeInput, null)
        })
      },
      actionKey: input.actionKey,
      operationKey: input.operationKey,
      taskRunId: input.taskRunId,
      batchContext: batchContext(),
      stableRunEvidence: input.stableRunEvidence,
      dbPathOrManagedSource: input.dbPathOrManagedSource,
      generationPlan: plan,
      context: input.context,
      production: false,
      publisher: async () => {
        publisherCalls += 1;
        throw Object.assign(new Error('injected Publisher failure'), {
          code: 'VCC_TEST_PUBLISHER_FAILED'
        });
      }
    }),
    (error) => error && error.code === 'VCC_TEST_PUBLISHER_FAILED'
  );
  assert.equal(publisherCalls, 1);
  assert.equal(fs.existsSync(targetPath), false);
});

test('E13-B VCC managed read-only export 复用模块全局串行租约', async (t) => {
  const fixture = createDatabaseFixture(t);
  const service = createVccFinancialOpService({
    database: { db: fixture.db, dbPath: fixture.dbPath },
    assetsDir: ''
  });
  t.after(async () => service.terminate());
  let release;
  let markStarted;
  const started = new Promise((resolve) => { markStarted = resolve; });
  const blocker = new Promise((resolve) => { release = resolve; });
  const first = service.runManagedReadOnlyExport('export-read-only', async () => {
    markStarted();
    await blocker;
    return Object.freeze({ status: 'done' });
  });
  await started;
  assert.deepEqual(service._taskStateForTests(), {
    taskGeneration: 0,
    closing: false,
    active: true,
    action: 'export-read-only',
    phase: 'direct',
    protected: false
  });

  await assert.rejects(
    service.runManagedReadOnlyExport('export-read-only-2', async () => null),
    (error) => error && error.code === 'active-vcc-task'
  );
  release();
  assert.deepEqual(await first, { status: 'done' });
  assert.deepEqual(service._taskStateForTests(), {
    taskGeneration: 1,
    closing: false,
    active: false,
    action: null,
    phase: null,
    protected: false
  });
});
