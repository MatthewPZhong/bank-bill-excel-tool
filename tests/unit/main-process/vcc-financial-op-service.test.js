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
const repository = require('../../../src/backend/vcc-financial-op-db/repository');
const { SOURCE_TYPES, SUPPORTED_CURRENCIES } = require('../../../src/backend/vcc-financial-op/definitions');
const { REQUIRED_DATASET_TYPES } = require('../../../src/backend/vcc-financial-op/calculator');
const { deleteDataset } = require('../../../src/backend/vcc-financial-op/dataset-deletion');
const {
  previewDataTargetDeletion
} = require('../../../src/backend/vcc-financial-op/data-target-deletion');
const { createVccFinancialOpService } = require('../../../src/main-process/vcc-financial-op-service');

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

test('破坏性 worker 在 openDb/migration 前完成 critical 握手', () => {
  const workerSource = fs.readFileSync(path.join(
    __dirname,
    '../../../src/backend/vcc-financial-op/worker-entry.js'
  ), 'utf8');
  const runSource = workerSource.slice(
    workerSource.indexOf('async function run()'),
    workerSource.indexOf('function finish(')
  );
  const handshakeIndex = runSource.indexOf('await enterCriticalSection(workerData.action)');
  const openDbIndex = runSource.indexOf('const db = openDb(workerData.dbPath)');
  assert.ok(handshakeIndex >= 0, '破坏性 action 必须等待 critical ACK');
  assert.ok(openDbIndex > handshakeIndex, 'openDb（含 migration）必须发生在父进程 protected/ACK 之后');
  assert.doesNotMatch(workerSource, /['"]delete-dataset['"]/, '不得保留绕过统一确认契约的 legacy action');
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
    });
    assert.equal(result.status, 'blocked');
    assert.equal(result.code, 'preflight-required');
  }
});

test('系统财务OP导入详情按主体筛选、分页并返回既有快照血缘', (t) => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec('PRAGMA foreign_keys = ON');
  ensureVccFinancialOpTablesSupport(db);
  repository.createImportBatch(db, { id: 'system-detail', targetMonth: '2026-06', fileCount: 3 });
  const recordId = repository.createImportRecord(db, {
    batchId: 'system-detail', targetMonth: '2026-06', sourceType: SOURCE_TYPES.SYSTEM_OP,
    sourceFiles: ['pphk-1.xlsx', 'pphk-2.xlsx', 'ppus.xlsx']
  });
  repository.finishImportRecord(db, recordId, {
    status: 'all_skipped', rawCount: 3, skippedCount: 3
  });
  const snapshotId = Number(db.prepare(`
    INSERT INTO vcc_fin_op_system_snapshots (
      target_month, subject, balances_json, content_hash,
      source_file, sheet_name, source_row, raw_json, import_record_id
    ) VALUES ('2026-06', 'PPHK', '{"USD":"1"}', 'existing-hash',
      'original.xlsx', 'Validate', 3, '{"source":"original"}', ?)
  `).run(recordId).lastInsertRowid);
  const insertAttempt = db.prepare(`
    INSERT INTO vcc_fin_op_system_snapshot_attempts (
      import_record_id, target_month, subject, balances_json, content_hash,
      source_file, sheet_name, source_row, raw_json, disposition, existing_snapshot_id
    ) VALUES (?, '2026-06', ?, ?, ?, ?, 'Validate', 3, '{}', 'idempotent_skip', ?)
  `);
  insertAttempt.run(recordId, 'PPHK', '{"USD":"1"}', 'hash-hk-1', 'pphk-1.xlsx', snapshotId);
  insertAttempt.run(recordId, 'PPHK', '{"USD":"1"}', 'hash-hk-2', 'pphk-2.xlsx', snapshotId);
  insertAttempt.run(recordId, 'PPUS', '{"USD":"2"}', 'hash-us', 'ppus.xlsx', null);

  const service = createVccFinancialOpService({
    database: { db, dbPath: ':memory:' },
    assetsDir: ''
  });
  t.after(() => service.terminate());
  const first = service.getImportRecordDetail({
    recordId, tab: 'skips', key: 'PPHK', page: 1, pageSize: 1
  });
  const second = service.getImportRecordDetail({
    recordId, tab: 'skips', key: 'PPHK', page: 2, pageSize: 1
  });

  assert.equal(first.total, 2);
  assert.equal(first.rows.length, 1);
  assert.equal(second.rows.length, 1);
  assert.notEqual(first.rows[0].sourceFile, second.rows[0].sourceFile);
  assert.equal(first.rows[0].idempotencyKey, '2026-06 × PPHK');
  assert.equal(first.rows[0].existing.balances.USD, '1');
  assert.equal(first.rows[0].existingSource.sourceFile, 'original.xlsx');
  db.prepare(`
    INSERT INTO vcc_fin_op_datasets (target_month, dataset_type)
    VALUES ('2026-06', ?)
  `).run(SOURCE_TYPES.SYSTEM_OP);
  deleteWithPreview(db, '2026-06', SOURCE_TYPES.SYSTEM_OP);
  const afterDeletion = service.getImportRecordDetail({
    recordId, tab: 'skips', key: 'PPHK', page: 1, pageSize: 1
  });
  assert.equal(afterDeletion.rows[0].existing.balances.USD, '1');
  assert.equal(afterDeletion.rows[0].existingSource.sourceFile, 'original.xlsx');
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

test('删除有效明细后查看导入明细仍返回幂等对比侧血缘', (t) => {
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
  const effectiveId = Number(db.prepare(`
    INSERT INTO vcc_fin_op_effective_rows (
      source_type, idempotency_key_raw, idempotency_key, content_hash,
      target_month, subject, source_file, sheet_name, source_row, raw_json,
      import_record_id
    ) VALUES (?, '0000123', '0000123', 'same-hash', '2026-06', 'PPHK',
      'original.xlsx', '明细', 8, '["","","","","","0000123"]', ?)
  `).run(SOURCE_TYPES.RECHARGE, recordId).lastInsertRowid);
  db.prepare(`
    INSERT INTO vcc_fin_op_import_rows (
      import_record_id, source_type, target_month,
      idempotency_key_raw, idempotency_key, content_hash,
      subject, source_file, sheet_name, source_row, raw_json,
      disposition, existing_effective_id
    ) VALUES (?, ?, '2026-06', '0000123', '0000123', 'same-hash', 'PPHK',
      'retry.xlsx', '明细', 9, '["","","","","","0000123"]', 'idempotent_skip', ?)
  `).run(recordId, SOURCE_TYPES.RECHARGE, effectiveId);
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
  const detail = service.getImportRecordDetail({
    recordId,
    tab: 'skips',
    page: 1,
    pageSize: 10
  });
  assert.equal(detail.summary.status, 'deleted');
  assert.equal(detail.summary.statusText, '已删除');
  assert.equal(detail.summary.originalStatus, 'success_with_skips');
  assert.equal(detail.summary.originalStatusText, '成功（含幂等跳过）');
  assert.ok(detail.summary.datasetDeletedAt);
  assert.ok(detail.summary.datasetDeletionId);
  const listed = service.listImportRecords('2026-06');
  assert.equal(listed[0].status, 'deleted');
  assert.equal(listed[0].statusText, '已删除');
  assert.equal(detail.total, 1);
  assert.equal(detail.rows[0].idempotencyKey, '0000123');
  assert.equal(detail.rows[0].existing['订单号'], '0000123');
  assert.equal(detail.rows[0].existingSource.sourceFile, 'original.xlsx');
  assert.equal(detail.rows[0].existingSource.sheetName, '明细');
  assert.equal(detail.rows[0].existingSource.sourceRow, 8);
  assert.equal(detail.rows[0].existingSource.importRecordId, recordId);
});

test('数据管理删除通过 worker 执行并返回删除与结果失效计数', async (t) => {
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

  const preview = service.previewDatasetDeletion({
    targetMonth: '2026-06',
    sourceType: SOURCE_TYPES.RECHARGE
  });
  assert.equal(preview.deletable, true);
  assert.equal(preview.dataCount, 1);
  assert.throws(() => service.deleteDatasetData({
    targetMonth: '2026-06',
    sourceType: SOURCE_TYPES.RECHARGE
  }), (error) => {
    assert.equal(error.code, 'state-changed');
    assert.equal(error.message, '数据状态已变化，请刷新并重新确认。');
    return true;
  });
  const deleted = await service.deleteDatasetData({
    targetMonth: '2026-06',
    sourceType: SOURCE_TYPES.RECHARGE,
    expectedPreviewToken: preview.previewToken,
    taskGeneration: preview.taskGeneration,
    reason: 'worker 链路删除原因'
  });
  assert.equal(deleted.deletedDataCount, 1);
  assert.equal(deleted.invalidatedRunCount, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM vcc_fin_op_effective_rows').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM vcc_fin_op_runs').get().n, 0);
  const operationAudit = db.prepare(`
    SELECT status, evidence_json, app_version, build_sha
    FROM vcc_fin_op_operation_audit
    WHERE operation_type = 'delete-source-dataset'
  `).get();
  assert.equal(operationAudit.status, 'success');
  assert.equal(operationAudit.app_version, '3.1.8');
  assert.equal(operationAudit.build_sha, 'worker-service-build');
  assert.equal(JSON.parse(operationAudit.evidence_json).reason, 'worker 链路删除原因');
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
  const result = await service.exportDatasetData({
    targetMonth: '2026-06', sourceType: SOURCE_TYPES.RECHARGE, targetKind: 'check', outputPath
  });
  assert.equal(result.tableName, 'VCC充值清退明细_校验表');
  assert.equal(result.dataCount, 1);
  assert.equal(result.sheetCount, 1);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(outputPath);
  assert.equal(workbook.worksheets[0].getCell('A2').value, '000123');
  assert.equal(workbook.worksheets[0].getCell('J2').value, '10');
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

  const oldPreview = service.previewDataTargetDeletion({
    targetMonth: '2026-06', targetType: SOURCE_TYPES.RECHARGE
  });
  assert.equal(oldPreview.taskGeneration, 0);
  const calculation = service.calculate({
    targetMonth: '2026-06',
    expectedInputFingerprint: 'a'.repeat(64)
  });
  assert.equal(service._taskStateForTests().taskGeneration, 0);
  assert.throws(() => service.exportDatasetData({
    targetMonth: '2026-06', sourceType: SOURCE_TYPES.RECHARGE, targetKind: 'raw'
  }), (error) => error.code === 'active-vcc-task');
  await assert.rejects(
    service.resolveRecord({
      recordId: 1,
      note: '不会进入数据库写入',
      action: 'keep_current_effective_dataset'
    }),
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
  }), (error) => {
    assert.equal(error.code, 'state-changed');
    assert.equal(error.message, '数据状态已变化，请刷新并重新确认。');
    return true;
  });
  for (const action of [
    () => service.unarchiveMonth({ targetMonth: '2026-06' }),
    () => service.deleteDataTarget({ targetMonth: '2026-06', targetType: SOURCE_TYPES.RECHARGE })
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
  const unarchivePreview = service.previewUnarchive({ targetMonth: '2026-06' });
  const deletePreview = service.previewDataTargetDeletion({
    targetMonth: '2026-06', targetType: SOURCE_TYPES.RECHARGE
  });
  const operations = [
    {
      call: (confirmation) => service.unarchiveMonth({
        targetMonth: '2026-06',
        ...confirmation
      }),
      token: unarchivePreview.previewToken
    },
    {
      call: (confirmation) => service.deleteDataTarget({
        targetMonth: '2026-06',
        targetType: SOURCE_TYPES.RECHARGE,
        ...confirmation
      }),
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
    workerFactory: createFakeWorkerFactory(workers),
    cancelTimeoutMs: 10
  });
  t.after(() => db.close());
  const preview = service.previewUnarchive({ targetMonth: '2026-06' });
  const operation = service.unarchiveMonth({
    targetMonth: '2026-06',
    expectedPreviewToken: preview.previewToken,
    taskGeneration: preview.taskGeneration
  });
  const worker = workers[0];
  worker.emit('message', { type: 'critical-ready' });
  assert.deepEqual(worker.sentMessages, [{ type: 'critical-ack' }]);
  assert.equal(service._taskStateForTests().protected, true);

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
    }),
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
    workerFactory: createFakeWorkerFactory(workers),
    cancelTimeoutMs: 50
  });
  t.after(async () => {
    await service.terminate();
    db.close();
  });
  const preview = service.previewDataTargetDeletion({
    targetMonth: '2026-06', targetType: SOURCE_TYPES.RECHARGE
  });
  const operation = service.deleteDataTarget({
    targetMonth: '2026-06',
    targetType: SOURCE_TYPES.RECHARGE,
    expectedPreviewToken: preview.previewToken,
    taskGeneration: preview.taskGeneration
  });
  const rejection = assert.rejects(operation, (error) => error.code === 'operation-cancelled');
  const cancellation = service.cancelActiveTask();
  const worker = workers[0];
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
    workerFactory: createFakeWorkerFactory(workers),
    cancelTimeoutMs: 5
  });
  t.after(() => db.close());
  const preview = service.previewDataTargetDeletion({
    targetMonth: '2026-06', targetType: SOURCE_TYPES.RECHARGE
  });
  const operation = service.deleteDataTarget({
    targetMonth: '2026-06',
    targetType: SOURCE_TYPES.RECHARGE,
    expectedPreviewToken: preview.previewToken,
    taskGeneration: preview.taskGeneration
  });
  const rejection = assert.rejects(operation, /后台任务退出但未返回结果/);
  const termination = service.terminate();
  const worker = workers[0];
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

test('直接结果导出持有同一租约，退出等待 writer 完成', async (t) => {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  ensureVccFinancialOpTablesSupport(db);
  const runId = Number(db.prepare(`
    INSERT INTO vcc_fin_op_runs (
      target_month, status, created_at, updated_at, archived_at
    ) VALUES (
      '2026-06', 'archived', '2026-08-01 08:00:00',
      '2026-08-01 09:00:00', '2026-08-01 09:00:00'
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
  const started = new Promise((resolve) => { writerStarted = resolve; });
  const service = createVccFinancialOpService({
    database: { db, dbPath: ':memory:' },
    assetsDir: '',
    writeRunWorkbooksFn: () => {
      writerStarted();
      return new Promise((resolve) => { releaseWriter = resolve; });
    }
  });
  t.after(() => db.close());

  assert.equal(service.latestArchivedRun().runId, runId, '不一致的更新 archived run 不得成为 latest');

  const exporting = service.exportRun({ runId, outputPath: '/tmp/fixture.xlsx' });
  await started;
  assert.equal(service._taskStateForTests().action, 'export-result');
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
});
