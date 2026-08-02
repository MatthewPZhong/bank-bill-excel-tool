'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const ExcelJS = require('exceljs');
const { DatabaseSync } = require('node:sqlite');
const { ensureVccFinancialOpTablesSupport } = require('../../../src/backend/vcc-financial-op-db/migrations');
const repository = require('../../../src/backend/vcc-financial-op-db/repository');
const { SOURCE_TYPES, SUPPORTED_CURRENCIES } = require('../../../src/backend/vcc-financial-op/definitions');
const { deleteDataset } = require('../../../src/backend/vcc-financial-op/dataset-deletion');
const { createVccFinancialOpService } = require('../../../src/main-process/vcc-financial-op-service');

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
  deleteDataset({ db, targetMonth: '2026-06', sourceType: SOURCE_TYPES.SYSTEM_OP });
  const afterDeletion = service.getImportRecordDetail({
    recordId, tab: 'skips', key: 'PPHK', page: 1, pageSize: 1
  });
  assert.equal(afterDeletion.rows[0].existing.balances.USD, '1');
  assert.equal(afterDeletion.rows[0].existingSource.sourceFile, 'original.xlsx');
});

test('数据管理可查看人工期初九币种余额和核对说明', (t) => {
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
  assert.equal(overview.openingBalances.length, 1);
  assert.equal(overview.openingBalances[0].subject, 'PPHK');
  assert.equal(overview.openingBalances[0].balances.USD, '100');
  assert.equal(overview.openingBalances[0].note, '已与账务期初表核对');
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
    INSERT INTO vcc_fin_op_datasets (target_month, dataset_type)
    VALUES ('2026-06', ?)
  `).run(SOURCE_TYPES.RECHARGE);
  const service = createVccFinancialOpService({
    database: { db, dbPath: ':memory:' },
    assetsDir: ''
  });
  t.after(() => service.terminate());

  deleteDataset({ db, targetMonth: '2026-06', sourceType: SOURCE_TYPES.RECHARGE });
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
    INSERT INTO vcc_fin_op_datasets (target_month, dataset_type)
    VALUES ('2026-06', ?)
  `).run(SOURCE_TYPES.RECHARGE);
  db.prepare(`
    INSERT INTO vcc_fin_op_runs (target_month, status)
    VALUES ('2026-06', 'calculated')
  `).run();
  const service = createVccFinancialOpService({ database: { db, dbPath }, assetsDir: '' });
  t.after(() => service.terminate());

  const preview = service.previewDatasetDeletion({
    targetMonth: '2026-06',
    sourceType: SOURCE_TYPES.RECHARGE
  });
  assert.equal(preview.deletable, true);
  assert.equal(preview.dataCount, 1);
  const deleted = await service.deleteDatasetData({
    targetMonth: '2026-06',
    sourceType: SOURCE_TYPES.RECHARGE
  });
  assert.equal(deleted.deletedDataCount, 1);
  assert.equal(deleted.invalidatedRunCount, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM vcc_fin_op_effective_rows').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM vcc_fin_op_runs').get().n, 0);
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
