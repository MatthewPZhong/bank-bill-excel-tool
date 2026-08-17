'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const ExcelJS = require('exceljs');
const { DatabaseSync } = require('node:sqlite');

const {
  ensureVccFinancialOpTablesSupport
} = require('../../../src/backend/vcc-financial-op-db/migrations');
const repository = require('../../../src/backend/vcc-financial-op-db/repository');
const { SOURCE_TYPES } = require('../../../src/backend/vcc-financial-op/definitions');
const {
  ANOMALY_HEADERS,
  writeImportAuditWorkbook
} = require('../../../src/main-process/vcc-financial-op-audit-writer');

function createRecord(db, options = {}) {
  repository.createImportBatch(db, {
    id: options.batchId || 'batch-audit',
    targetMonth: '2026-07',
    fileCount: 1
  });
  return repository.createImportRecord(db, {
    batchId: options.batchId || 'batch-audit',
    targetMonth: '2026-07',
    sourceType: options.sourceType || SOURCE_TYPES.RECHARGE,
    sourceFiles: [options.fileName || 'source.xlsx']
  });
}

function tempOutput(t, fileName = 'anomalies.xlsx') {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vcc-anomaly-export-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return path.join(directory, fileName);
}

test('异常明细只导出固定六列并保留前导零幂等键与差异字段', async (t) => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec('PRAGMA foreign_keys = ON');
  ensureVccFinancialOpTablesSupport(db);
  const recordId = createRecord(db);
  repository.addImportAnomaly(db, recordId, {
    sourceType: SOURCE_TYPES.RECHARGE,
    targetMonth: '2026-07',
    idempotencyKey: '000123',
    sourceFile: 'source.xlsx',
    sourceRow: 18,
    category: 'idempotent_conflict',
    abnormalFields: ['订单号'],
    diffFields: ['我方到账金额', '订单号'],
    description: '相同幂等键对应内容不一致',
    incomingContentHash: 'a'.repeat(64),
    existingContentHash: 'b'.repeat(64)
  });
  repository.finishImportRecord(db, recordId, {
    status: 'failed_conflict', rawCount: 1, conflictCount: 1, anomalyCount: 1
  });
  const outputPath = tempOutput(t);

  const result = await writeImportAuditWorkbook({ db, recordId, outputPath });
  assert.deepEqual(result, {
    filePath: path.resolve(outputPath), recordId, rowCount: 1, sheetCount: 1
  });
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(outputPath);
  const sheet = workbook.getWorksheet('异常明细');
  assert.deepEqual(sheet.getRow(1).values.slice(1), [...ANOMALY_HEADERS]);
  assert.equal(sheet.getCell('A2').value, '000123');
  assert.equal(sheet.getCell('B2').value, 'source.xlsx');
  assert.equal(sheet.getCell('C2').value, 18);
  assert.equal(sheet.getCell('D2').value, '幂等冲突');
  assert.equal(sheet.getCell('E2').value, '订单号、我方到账金额');
  assert.equal(sheet.getCell('F2').value, '相同幂等键对应内容不一致');
});

test('多文件第二份失败在六列导出中保持精确文件归属', async (t) => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec('PRAGMA foreign_keys = ON');
  ensureVccFinancialOpTablesSupport(db);
  repository.createImportBatch(db, {
    id: 'batch-second-source', targetMonth: '2026-07', fileCount: 2
  });
  const recordId = repository.createImportRecord(db, {
    batchId: 'batch-second-source',
    targetMonth: '2026-07',
    sourceType: SOURCE_TYPES.RECHARGE,
    sourceFiles: ['first.xlsx', 'second.xlsx']
  });
  repository.createImportSource(db, recordId, {
    sourceOrdinal: 1, fileName: 'first.xlsx', sha256: 'a'.repeat(64), sizeBytes: 1
  });
  const secondSourceId = repository.createImportSource(db, recordId, {
    sourceOrdinal: 2, fileName: 'second.xlsx', sha256: 'b'.repeat(64), sizeBytes: 2
  });
  const anomalyCount = repository.addFileFailureAnomaly(db, recordId, {
    importSourceId: secondSourceId,
    sourceOrdinal: 2,
    fileName: 'second.xlsx',
    message: '最终 SHA/size 与首次读取不一致'
  });
  repository.finishImportRecord(db, recordId, {
    status: 'failed_validation', rawCount: 1, rolledBackCount: 1, anomalyCount
  });
  const outputPath = tempOutput(t, 'second-source.xlsx');
  await writeImportAuditWorkbook({ db, recordId, outputPath });
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(outputPath);
  const sheet = workbook.getWorksheet('异常明细');
  assert.deepEqual(sheet.getRow(1).values.slice(1), [...ANOMALY_HEADERS]);
  assert.equal(sheet.getCell('A2').value == null, true);
  assert.equal(sheet.getCell('B2').value, 'second.xlsx');
  assert.equal(sheet.getCell('C2').value == null, true);
  assert.equal(sheet.getCell('D2').value, '文件级失败');
  assert.equal(sheet.getCell('E2').value == null, true);
  assert.equal(sheet.getCell('F2').value, '最终 SHA/size 与首次读取不一致');
});

test('部分成功与系统主体异常可导出，纯幂等跳过不生成逐行审计', async (t) => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec('PRAGMA foreign_keys = ON');
  ensureVccFinancialOpTablesSupport(db);
  const recordId = createRecord(db, {
    batchId: 'batch-system', sourceType: SOURCE_TYPES.SYSTEM_OP, fileName: 'system.xlsx'
  });
  repository.addImportAnomaly(db, recordId, {
    sourceType: SOURCE_TYPES.SYSTEM_OP,
    targetMonth: '2026-07',
    idempotencyKey: 'UNKNOWN',
    sourceFile: 'system.xlsx',
    sourceRow: 3,
    category: 'system_subject_error',
    abnormalFields: ['公司主体'],
    description: '系统财务OP包含未知主体'
  });
  repository.finishImportRecord(db, recordId, {
    status: 'success_with_skips', rawCount: 2, insertedCount: 1,
    formatErrorCount: 1, anomalyCount: 1
  });
  const outputPath = tempOutput(t, 'system.xlsx');
  const result = await writeImportAuditWorkbook({ db, recordId, outputPath });
  assert.equal(result.rowCount, 1);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(outputPath);
  assert.equal(workbook.getWorksheet('异常明细').getCell('D2').value, '系统主体异常');

  const skipRecordId = createRecord(db, { batchId: 'batch-skip' });
  repository.finishImportRecord(db, skipRecordId, {
    status: 'all_skipped', rawCount: 10, skippedCount: 10, anomalyCount: 0
  });
  await assert.rejects(
    writeImportAuditWorkbook({ db, recordId: skipRecordId, outputPath: tempOutput(t, 'skip.xlsx') }),
    (error) => error.code === 'no-import-anomalies'
  );
  assert.equal(db.prepare(`
    SELECT COUNT(*) AS count FROM vcc_fin_op_import_rows WHERE import_record_id = ?
  `).get(skipRecordId).count, 0);
});

test('超过 Excel 单 sheet 行限时按同一固定表头稳定分 sheet', async (t) => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec('PRAGMA foreign_keys = ON');
  ensureVccFinancialOpTablesSupport(db);
  const recordId = createRecord(db, { batchId: 'batch-pages' });
  for (let index = 1; index <= 3; index += 1) {
    repository.addImportAnomaly(db, recordId, {
      sourceType: SOURCE_TYPES.RECHARGE,
      targetMonth: '2026-07',
      idempotencyKey: `KEY-${index}`,
      sourceFile: 'source.xlsx',
      sourceRow: index + 1,
      category: 'format_error',
      abnormalFields: ['金额'],
      description: `第 ${index} 行金额格式错误`
    });
  }
  repository.finishImportRecord(db, recordId, {
    status: 'failed_validation', rawCount: 3, formatErrorCount: 3, anomalyCount: 3
  });
  const outputPath = tempOutput(t, 'pages.xlsx');
  const result = await writeImportAuditWorkbook({
    db, recordId, outputPath, maxDataRowsPerSheet: 2
  });
  assert.equal(result.rowCount, 3);
  assert.equal(result.sheetCount, 2);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(outputPath);
  assert.deepEqual(workbook.worksheets.map((sheet) => sheet.name), ['异常明细', '异常明细-2']);
  for (const sheet of workbook.worksheets) {
    assert.deepEqual(sheet.getRow(1).values.slice(1), [...ANOMALY_HEADERS]);
  }
});

test('显式重建前 v1 历史异常仍按六列导出且不恢复逐行成功审计', async (t) => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec('PRAGMA foreign_keys = ON');
  ensureVccFinancialOpTablesSupport(db);
  const recordId = createRecord(db, {
    batchId: 'legacy-anomaly', fileName: 'legacy-source.xlsx'
  });
  db.prepare(`
    INSERT INTO vcc_fin_op_import_rows (
      import_record_id, source_type, target_month,
      idempotency_key_raw, idempotency_key, content_hash,
      source_file, sheet_name, source_row, raw_json,
      disposition, validation_field, validation_message, diff_fields_json
    ) VALUES (?, ?, '2026-07', ' bad ', 'bad', ?,
              'legacy-source.xlsx', '明细', 9, '{"订单号":""}',
              'invalid_key', '订单号', '幂等键为空', '[]')
  `).run(recordId, SOURCE_TYPES.RECHARGE, 'a'.repeat(64));
  db.prepare(`
    INSERT INTO vcc_fin_op_import_rows (
      import_record_id, source_type, target_month,
      idempotency_key_raw, idempotency_key, content_hash,
      source_file, sheet_name, source_row, raw_json,
      disposition, diff_fields_json
    ) VALUES (?, ?, '2026-07', 'ok', 'ok', ?,
              'legacy-source.xlsx', '明细', 10, '{"订单号":"ok"}',
              'idempotent_skip', '[]')
  `).run(recordId, SOURCE_TYPES.RECHARGE, 'b'.repeat(64));
  repository.finishImportRecord(db, recordId, {
    status: 'failed_validation',
    rawCount: 1,
    invalidKeyCount: 1,
    errorMessage: '历史导入校验失败'
  });
  assert.equal(db.prepare(`
    SELECT anomaly_count FROM vcc_fin_op_import_records WHERE id = ?
  `).get(recordId).anomaly_count, 0);
  assert.equal(repository.countExportableImportAnomalies(db, recordId), 2);

  const outputPath = tempOutput(t, 'legacy-anomalies.xlsx');
  const result = await writeImportAuditWorkbook({ db, recordId, outputPath });
  assert.equal(result.rowCount, 2);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(outputPath);
  const sheet = workbook.getWorksheet('异常明细');
  assert.deepEqual(sheet.getRow(1).values.slice(1), [...ANOMALY_HEADERS]);
  assert.deepEqual(sheet.getRow(2).values.slice(1), [
    'bad', 'legacy-source.xlsx', 9, '空键/非法键', '订单号', '幂等键为空'
  ]);
  assert.equal(sheet.getCell('A3').value == null, true);
  assert.equal(sheet.getCell('B3').value, 'legacy-source.xlsx');
  assert.equal(sheet.getCell('C3').value == null, true);
  assert.equal(sheet.getCell('D3').value, '文件级失败');
  assert.equal(sheet.getCell('E3').value == null, true);
  assert.equal(sheet.getCell('F3').value, '历史导入校验失败');
});
