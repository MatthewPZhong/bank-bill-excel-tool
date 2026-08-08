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
const {
  SOURCE_TYPES,
  PENDING_HEADERS,
  PENDING_V1_HEADERS,
  getSourceDefinition
} = require('../../../src/backend/vcc-financial-op/definitions');
const { deleteDataset } = require('../../../src/backend/vcc-financial-op/dataset-deletion');
const { writeImportAuditWorkbook } = require('../../../src/main-process/vcc-financial-op-audit-writer');

test('幂等审计导出保留原表字段、前导零键和新旧双侧血缘', async (t) => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec('PRAGMA foreign_keys = ON');
  ensureVccFinancialOpTablesSupport(db);
  repository.createImportBatch(db, { id: 'batch-1', targetMonth: '2026-06', fileCount: 2 });
  const recordId = repository.createImportRecord(db, {
    batchId: 'batch-1', targetMonth: '2026-06', sourceType: SOURCE_TYPES.RECHARGE,
    sourceFiles: ['first.xlsx', 'again.xlsx']
  });
  repository.finishImportRecord(db, recordId, {
    status: 'all_skipped', rawCount: 1, skippedCount: 1
  });
  repository.finishImportBatch(db, 'batch-1', 'success');
  const definition = getSourceDefinition(SOURCE_TYPES.RECHARGE);
  const raw = definition.headers.map((header) => header === '订单号' ? '000123' : '');
  const effectiveId = Number(db.prepare(`
    INSERT INTO vcc_fin_op_effective_rows (
      source_type, idempotency_key_raw, idempotency_key, content_hash,
      target_month, subject, source_file, sheet_name, source_row, raw_json, import_record_id
    ) VALUES (?, '000123', '000123', 'hash', '2026-06', 'PPHK', 'first.xlsx', 'sheet1', 2, ?, ?)
  `).run(SOURCE_TYPES.RECHARGE, JSON.stringify(raw), recordId).lastInsertRowid);
  db.prepare(`
    INSERT INTO vcc_fin_op_import_rows (
      import_record_id, source_type, target_month,
      idempotency_key_raw, idempotency_key, content_hash,
      source_file, sheet_name, source_row, raw_json,
      disposition, existing_effective_id, validation_message
    ) VALUES (?, ?, '2026-06', '000123', '000123', 'hash',
      'again.xlsx', 'sheet1', 2, ?, 'idempotent_skip', ?, '同键同内容')
  `).run(recordId, SOURCE_TYPES.RECHARGE, JSON.stringify(raw), effectiveId);
  db.prepare(`
    INSERT INTO vcc_fin_op_datasets (target_month, dataset_type)
    VALUES ('2026-06', ?)
  `).run(SOURCE_TYPES.RECHARGE);
  deleteDataset({ db, targetMonth: '2026-06', sourceType: SOURCE_TYPES.RECHARGE });

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vcc-audit-output-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const outputPath = path.join(dir, 'audit.xlsx');
  const result = await writeImportAuditWorkbook({ db, recordId, tab: 'skips', outputPath });
  assert.equal(result.rowCount, 1);

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(outputPath);
  const sheet = workbook.getWorksheet('导入审计');
  const headers = sheet.getRow(1).values.slice(1);
  assert.ok(headers.includes('订单号'));
  assert.ok(headers.includes('审计_幂等键'));
  assert.ok(headers.includes('已保留_订单号'));
  const orderIndex = headers.indexOf('订单号') + 1;
  const auditKeyIndex = headers.indexOf('审计_幂等键') + 1;
  const existingOrderIndex = headers.indexOf('已保留_订单号') + 1;
  assert.equal(sheet.getCell(2, orderIndex).value, '000123');
  assert.equal(sheet.getCell(2, auditKeyIndex).value, '000123');
  assert.equal(sheet.getCell(2, existingOrderIndex).value, '000123');
});

test('系统财务OP审计导出遵守主体和文件名筛选', async (t) => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec('PRAGMA foreign_keys = ON');
  ensureVccFinancialOpTablesSupport(db);
  repository.createImportBatch(db, { id: 'batch-system', targetMonth: '2026-06', fileCount: 2 });
  const recordId = repository.createImportRecord(db, {
    batchId: 'batch-system', targetMonth: '2026-06', sourceType: SOURCE_TYPES.SYSTEM_OP,
    sourceFiles: ['pphk.xlsx', 'ppus.xlsx']
  });
  repository.finishImportRecord(db, recordId, {
    status: 'all_skipped', rawCount: 2, skippedCount: 2
  });
  repository.finishImportBatch(db, 'batch-system', 'success');
  const existingId = Number(db.prepare(`
    INSERT INTO vcc_fin_op_system_snapshots (
      target_month, subject, balances_json, content_hash,
      source_file, sheet_name, source_row, raw_json, import_record_id
    ) VALUES ('2026-06', 'PPHK', '{"USD":"1"}', 'existing-hash',
      'original.xlsx', 'Validate', 3, '{}', ?)
  `).run(recordId).lastInsertRowid);
  const insert = db.prepare(`
    INSERT INTO vcc_fin_op_system_snapshot_attempts (
      import_record_id, target_month, subject, balances_json, content_hash,
      source_file, sheet_name, source_row, raw_json, disposition, existing_snapshot_id
    ) VALUES (?, '2026-06', ?, '{"USD":"2"}', ?, ?, 'Validate', 3, '{}', 'idempotent_skip', ?)
  `);
  insert.run(recordId, 'PPHK', 'hash-hk', 'pphk.xlsx', existingId);
  insert.run(recordId, 'PPUS', 'hash-us', 'ppus.xlsx', null);
  db.prepare(`
    INSERT INTO vcc_fin_op_datasets (target_month, dataset_type)
    VALUES ('2026-06', ?)
  `).run(SOURCE_TYPES.SYSTEM_OP);
  deleteDataset({ db, targetMonth: '2026-06', sourceType: SOURCE_TYPES.SYSTEM_OP });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vcc-system-audit-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const outputPath = path.join(dir, 'system-audit.xlsx');

  const result = await writeImportAuditWorkbook({
    db, recordId, tab: 'skips', outputPath, key: 'PPHK', fileName: 'pphk'
  });
  assert.equal(result.rowCount, 1);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(outputPath);
  const sheet = workbook.getWorksheet('系统OP快照审计');
  assert.equal(sheet.rowCount, 2);
  assert.equal(sheet.getCell('B2').value, 'PPHK');
  assert.equal(sheet.getCell('C2').value, 'pphk.xlsx');
  const headers = sheet.getRow(1).values.slice(1);
  const existingBalanceColumn = headers.indexOf('已保留_余额快照') + 1;
  const existingFileColumn = headers.indexOf('已保留_来源文件') + 1;
  const differenceCurrencyColumn = headers.indexOf('差异币种') + 1;
  assert.equal(sheet.getCell(2, existingBalanceColumn).value, '{"USD":"1"}');
  assert.equal(sheet.getCell(2, existingFileColumn).value, 'original.xlsx');
  assert.equal(sheet.getCell(2, differenceCurrencyColumn).value, 'USD');
});

test('历史 Pending 审计按 v1 的 48 列表头解释且不与新 46 列错位', async (t) => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec('PRAGMA foreign_keys = ON');
  ensureVccFinancialOpTablesSupport(db);
  repository.createImportBatch(db, { id: 'pending-v1-audit', targetMonth: '2026-06', fileCount: 1 });
  const recordId = repository.createImportRecord(db, {
    batchId: 'pending-v1-audit',
    targetMonth: '2026-06',
    sourceType: SOURCE_TYPES.PENDING,
    sourceFiles: ['legacy.xlsx']
  });
  repository.finishImportRecord(db, recordId, {
    status: 'failed_validation', rawCount: 1, formatErrorCount: 1
  });
  repository.finishImportBatch(db, 'pending-v1-audit', 'completed_with_errors');
  const raw = PENDING_V1_HEADERS.map((header) => {
    if (header === 'PendingBizId') return 'LEGACY-1';
    if (header === '是否错币') return '旧错币值';
    if (header === '金额差') return '旧金额差值';
    if (header === '流水_币种') return 'USD';
    return '';
  });
  db.prepare(`
    INSERT INTO vcc_fin_op_import_rows (
      import_record_id, source_type, target_month, idempotency_key_raw, idempotency_key,
      content_hash, hash_version, raw_contract_version, subject,
      source_file, sheet_name, source_row, raw_json, disposition, validation_message
    ) VALUES (?, ?, '2026-06', 'LEGACY-1', 'LEGACY-1', 'v2-hash', 2, 1, 'PPHK',
      'legacy.xlsx', 'Pending', 2, ?, 'format_error', '历史审计')
  `).run(recordId, SOURCE_TYPES.PENDING, JSON.stringify(raw));

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vcc-pending-v1-audit-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const outputPath = path.join(dir, 'pending-v1.xlsx');
  await writeImportAuditWorkbook({ db, recordId, tab: 'other', outputPath });
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(outputPath);
  const sheet = workbook.getWorksheet('导入审计');
  const headers = sheet.getRow(1).values.slice(1);
  assert.equal(headers.slice(0, PENDING_V1_HEADERS.length).length, 48);
  assert.ok(headers.includes('是否错币'));
  assert.ok(headers.includes('金额差'));
  assert.equal(headers.slice(0, PENDING_V1_HEADERS.length).includes(PENDING_HEADERS[45]), true);
  assert.equal(sheet.getCell(2, headers.indexOf('是否错币') + 1).value, '旧错币值');
  assert.equal(sheet.getCell(2, headers.indexOf('金额差') + 1).value, '旧金额差值');
  assert.equal(sheet.getCell(2, headers.indexOf('流水_币种') + 1).value, 'USD');
});
