'use strict';

const fs = require('node:fs');
const childProcess = require('node:child_process');
const Module = require('node:module');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const XLSX = require('xlsx');
const { DatabaseSync } = require('node:sqlite');
const { ensureVccFinancialOpTablesSupport } = require('../../../../src/backend/vcc-financial-op-db/migrations');
const {
  VCC_STORAGE_CONTRACT_VERSION,
  createSlimEffectiveRowsTable,
  setVccStorageContractVersion
} = require('../../../../src/backend/vcc-financial-op-db/storage-contract');
const repository = require('../../../../src/backend/vcc-financial-op-db/repository');
const {
  SOURCE_TYPES,
  SUPPORTED_CURRENCIES,
  SYSTEM_OP_HEADERS,
  getSourceDefinition
} = require('../../../../src/backend/vcc-financial-op/definitions');
const {
  importDetailGroup,
  importDetailBatch
} = require('../../../../src/backend/vcc-financial-op/detail-importer');
const {
  importFiles,
  normalizeImportBatchId
} = require('../../../../src/backend/vcc-financial-op/import-service');
const { hashSourceFiles } = require('../../../../src/backend/vcc-financial-op/source-lineage');
const {
  inspectSourceFile,
  openWorkbookSheets
} = require('../../../../src/backend/vcc-financial-op/workbook-reader');

const REPO_ROOT = path.resolve(__dirname, '../../../..');

function loadV319Module(relativePath) {
  const source = childProcess.execFileSync(
    'git',
    ['show', `v3.1.9:${relativePath}`],
    { cwd: REPO_ROOT, encoding: 'utf8' }
  );
  const filename = path.join(REPO_ROOT, relativePath);
  const loaded = new Module(filename, module);
  loaded.filename = filename;
  loaded.paths = Module._nodeModulePaths(path.dirname(filename));
  loaded._compile(source, filename);
  return loaded.exports;
}

function createDb() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  ensureVccFinancialOpTablesSupport(db);
  return db;
}

function replaceEmptyEffectiveRowsWithSlimSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS app_settings (
      setting_key TEXT PRIMARY KEY,
      setting_value TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
    );
  `);
  db.exec('PRAGMA foreign_keys = OFF; DROP TABLE vcc_fin_op_effective_rows;');
  createSlimEffectiveRowsTable(db);
  setVccStorageContractVersion(db, VCC_STORAGE_CONTRACT_VERSION);
  ensureVccFinancialOpTablesSupport(db);
  db.exec('PRAGMA foreign_keys = ON');
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
}

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vcc-fin-op-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeSourceFile(dir, sourceType, fileName, rows) {
  const definition = getSourceDefinition(sourceType);
  const matrix = [definition.headers];
  for (const fields of rows) {
    matrix.push(definition.headers.map((header) => Object.hasOwn(fields, header) ? fields[header] : ''));
  }
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(matrix), 'sheet1');
  const filePath = path.join(dir, fileName);
  XLSX.writeFile(workbook, filePath);
  return filePath;
}

function rechargeRow(overrides = {}) {
  return {
    订单号: '000123',
    BillDate: '2026-06-09',
    业务部门: 'VCC',
    对手部门: 'OPS',
    业务子类型: '充值',
    出入方向: 'in',
    公司主体: 'PPHK',
    我方币种: 'USD',
    我方到账金额: '10.25',
    ...overrides
  };
}

function fileEntry(filePath, sourceType, subject = '') {
  return { filePath, sourceType, subject };
}

async function archiveHandoffForFiles(files, taskRunId) {
  const hashed = await hashSourceFiles(files);
  const ordinals = new Map();
  return hashed.map((file, index) => {
    const sourceOrdinal = (ordinals.get(file.sourceType) || 0) + 1;
    ordinals.set(file.sourceType, sourceOrdinal);
    return {
      filePath: file.filePath,
      sourceType: file.sourceType,
      sourceOrdinal,
      sha256: file.sha256,
      sizeBytes: file.sizeBytes,
      taskRunId,
      archiveArtifactId: index + 1
    };
  });
}

test('外部 VCC import batchId 只接受与 exact7 相同的稳定文本边界', () => {
  assert.match(normalizeImportBatchId(), /^[0-9a-f-]{36}$/);
  assert.equal(normalizeImportBatchId('task-run-319'), 'task-run-319');
  for (const invalid of ['', ' task-run', 'task-run ', 'task\nrun', 319, 'x'.repeat(257)]) {
    assert.throws(() => normalizeImportBatchId(invalid), /VCC 导入批次号/);
  }
});

test('storage contract v2 slim effective 仍可导入、幂等重放并只暂存 fallback', async (t) => {
  const db = createDb();
  t.after(() => db.close());
  replaceEmptyEffectiveRowsWithSlimSchema(db);
  const dir = tempDir(t);
  const filePath = writeSourceFile(dir, SOURCE_TYPES.RECHARGE, 'slim.xlsx', [rechargeRow()]);

  const first = await importDetailBatch({
    db,
    targetMonth: '2026-06',
    files: [fileEntry(filePath, SOURCE_TYPES.RECHARGE)]
  });
  assert.equal(first.records[0].status, 'success');
  assert.equal(first.records[0].insertedCount, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM vcc_fin_op_effective_rows').get().n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM vcc_fin_op_effective_raw_fallback').get().n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM vcc_fin_op_import_staging_rows').get().n, 0);

  const second = await importDetailBatch({
    db,
    targetMonth: '2026-06',
    files: [fileEntry(filePath, SOURCE_TYPES.RECHARGE)]
  });
  assert.equal(second.records[0].status, 'all_skipped');
  assert.equal(second.records[0].skippedCount, 1);
  assert.equal(second.records[0].anomalyCount, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM vcc_fin_op_effective_rows').get().n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM vcc_fin_op_import_anomalies').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM vcc_fin_op_import_staging_rows').get().n, 0);
});

test('五个内置校验原表模板均与当前导入契约一致', async () => {
  const templateDir = path.join(__dirname, '../../../../assets/VCC财务OP校验');
  const templates = [
    ['VCC充值清退明细.xlsx', SOURCE_TYPES.RECHARGE],
    ['VCC费用及换汇明细.xlsx', SOURCE_TYPES.FEE_FX],
    ['VCC通道明细.xlsx', SOURCE_TYPES.CHANNEL],
    ['VCC_移除归档Pending账单.xlsx', SOURCE_TYPES.PENDING],
    ['系统财务OP.xlsx', SOURCE_TYPES.SYSTEM_OP]
  ];

  for (const [fileName, sourceType] of templates) {
    const inspected = await inspectSourceFile(path.join(templateDir, fileName));
    assert.equal(inspected.sourceType, sourceType, fileName);
    assert.equal(inspected.headerRow, 1, fileName);
  }
});

test('同一工作簿存在多张校验原表 sheet 时拒绝只读取其中一张', async (t) => {
  const dir = tempDir(t);
  const definition = getSourceDefinition(SOURCE_TYPES.RECHARGE);
  const matrix = [
    definition.headers,
    definition.headers.map((header) => rechargeRow()[header] || '')
  ];
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(matrix), 'sheet1');
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(matrix), 'sheet2');
  const filePath = path.join(dir, 'duplicate-sheets.xlsx');
  XLSX.writeFile(workbook, filePath);

  await assert.rejects(
    inspectSourceFile(filePath),
    /检测到多张校验原表 sheet/
  );
});

test('同一工作簿混有明细原表和系统财务OP时拒绝静默选择', async (t) => {
  const dir = tempDir(t);
  const definition = getSourceDefinition(SOURCE_TYPES.RECHARGE);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
    definition.headers,
    definition.headers.map((header) => rechargeRow()[header] || '')
  ]), '明细');
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
    SYSTEM_OP_HEADERS
  ]), '系统');
  const filePath = path.join(dir, 'mixed-business-sheets.xlsx');
  XLSX.writeFile(workbook, filePath);

  await assert.rejects(inspectSourceFile(filePath), /检测到多个可识别业务表/);

  const db = createDb();
  t.after(() => db.close());
  const imported = await importDetailBatch({
    db,
    targetMonth: '2026-06',
    files: [fileEntry(filePath, SOURCE_TYPES.RECHARGE)]
  });
  assert.equal(imported.records[0].status, 'failed_validation');
  assert.match(imported.records[0].errorMessage, /正式导入时检测到多个可识别业务表/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM vcc_fin_op_effective_rows').get().n, 0);
});

test('sharedStrings 超过预算时自适应落盘并在关闭后清理', async (t) => {
  const dir = tempDir(t);
  const filePath = writeSourceFile(dir, SOURCE_TYPES.RECHARGE, 'shared-strings.xlsx', [
    rechargeRow({ 订单号: 'shared-string-key' })
  ]);
  const rewritten = XLSX.readFile(filePath);
  XLSX.writeFile(rewritten, filePath, { bookSST: true });
  const sstTempRoot = path.join(dir, 'sst-spill');

  const workbook = await openWorkbookSheets(filePath, {
    sstTempRoot,
    sstMemoryBudgetBytes: 1
  });
  assert.equal(workbook.sharedStrings.mode, 'disk');
  assert.equal(fs.existsSync(sstTempRoot), true);
  await workbook.close();
  assert.equal(fs.existsSync(sstTempRoot), false);
});

test('1904 日期系统在导入前被明确拒绝', async (t) => {
  const dir = tempDir(t);
  const definition = getSourceDefinition(SOURCE_TYPES.RECHARGE);
  const workbook = XLSX.utils.book_new();
  workbook.Workbook = { WBProps: { date1904: true } };
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
    definition.headers,
    definition.headers.map((header) => rechargeRow()[header] || '')
  ]), 'sheet1');
  const filePath = path.join(dir, 'date-1904.xlsx');
  XLSX.writeFile(workbook, filePath);

  await assert.rejects(inspectSourceFile(filePath), /不支持 1904 日期系统/);
});

test('识别和正式导入使用一致的表头搜索范围', async (t) => {
  const db = createDb();
  t.after(() => db.close());
  const dir = tempDir(t);
  const definition = getSourceDefinition(SOURCE_TYPES.RECHARGE);
  const matrix = [
    ['说明 1'], ['说明 2'], ['说明 3'], ['说明 4'], ['说明 5'], ['说明 6'],
    definition.headers,
    definition.headers.map((header) => rechargeRow()[header] || '')
  ];
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(matrix), '原表');
  const filePath = path.join(dir, 'late-header.xlsx');
  XLSX.writeFile(workbook, filePath);

  const inspected = await inspectSourceFile(filePath);
  assert.equal(inspected.headerRow, 7);
  const imported = await importDetailBatch({
    db,
    targetMonth: '2026-06',
    files: [fileEntry(filePath, SOURCE_TYPES.RECHARGE)]
  });
  assert.equal(imported.records[0].status, 'success');
  assert.equal(imported.records[0].insertedCount, 1);
});

test('统一导入服务预登记多种原表后仍逐类完成有效提升', async (t) => {
  const db = createDb();
  t.after(() => db.close());
  const dir = tempDir(t);
  const recharge = writeSourceFile(dir, SOURCE_TYPES.RECHARGE, 'recharge.xlsx', [
    rechargeRow({ 订单号: 'service-recharge' })
  ]);
  const fee = writeSourceFile(dir, SOURCE_TYPES.FEE_FX, 'fee.xlsx', [
    rechargeRow({ 订单号: 'service-fee', 业务子类型: '手续费' })
  ]);

  const files = [
    fileEntry(recharge, SOURCE_TYPES.RECHARGE),
    fileEntry(fee, SOURCE_TYPES.FEE_FX)
  ];
  const result = await importFiles({
    db,
    batchId: 'multi-source-service',
    targetMonth: '2026-06',
    files,
    archiveHandoffFiles: await archiveHandoffForFiles(files, 'multi-source-service')
  });

  assert.equal(result.status, 'success');
  assert.equal(result.records.length, 2);
  assert.ok(result.records.every((record) => record.status === 'success'));
  assert.equal(db.prepare(`
    SELECT COUNT(*) AS n FROM vcc_fin_op_import_records WHERE batch_id = 'multi-source-service'
  `).get().n, 2);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM vcc_fin_op_effective_rows').get().n, 2);
  const sources = db.prepare(`
    SELECT source_file_name, source_sha256, source_size_bytes,
           archive_artifact_id, archive_state
    FROM vcc_fin_op_import_sources
    ORDER BY id
  `).all();
  assert.equal(sources.length, 2);
  assert.deepEqual(sources.map((row) => row.source_file_name), ['recharge.xlsx', 'fee.xlsx']);
  assert.ok(sources.every((row) => /^[a-f0-9]{64}$/.test(row.source_sha256)));
  assert.ok(sources.every((row) => Number(row.source_size_bytes) > 0));
  assert.deepEqual(sources.map((row) => Number(row.archive_artifact_id)), [1, 2]);
  assert.ok(sources.every((row) => row.archive_state === 'ready'));
  assert.ok(result.records.every((record) => (
    record.archiveState === 'ready'
      && record.anomalyCount === 0
      && record.sourceFiles.length === 1
  )));
});

test('多原表后组运行异常仍返回已提交组及全部 record 的部分结果血缘', async (t) => {
  const db = createDb();
  t.after(() => db.close());
  const dir = tempDir(t);
  const systemRows = SUPPORTED_CURRENCIES.map((currency, index) => ({
    账单日期: '2026-06-30',
    主体: 'PPHK',
    业务部门: 'VCC',
    币种: currency,
    OP发生额: 0,
    '发生额（入）': 0,
    '发生额（出）': 0,
    本期移除Pending金额: 0,
    调账金额: 0,
    OP期末余额: 0,
    pending余额: 0,
    费用项: 0,
    财务余额: 100 + index,
    主体变动发生额: 0,
    财务主体余额: 100 + index,
    创建时间: '2026-08-11 09:00:00'
  }));
  const systemWorkbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(systemWorkbook, XLSX.utils.aoa_to_sheet([
    SYSTEM_OP_HEADERS,
    ...systemRows.map((row) => SYSTEM_OP_HEADERS.map((header) => row[header] ?? ''))
  ]), 'System');
  const system = path.join(dir, 'committed-system.xlsx');
  XLSX.writeFile(systemWorkbook, system);
  const recharge = writeSourceFile(dir, SOURCE_TYPES.RECHARGE, 'cancelled-recharge.xlsx', [
    rechargeRow({ 订单号: 'cancelled-after-system-commit' })
  ]);
  let cancellationChecks = 0;
  let caught;
  try {
    const files = [
      fileEntry(system, SOURCE_TYPES.SYSTEM_OP, 'PPHK'),
      fileEntry(recharge, SOURCE_TYPES.RECHARGE)
    ];
    await importFiles({
      db,
      batchId: 'partial-runtime-failure',
      targetMonth: '2026-06',
      files,
      archiveHandoffFiles: await archiveHandoffForFiles(files, 'partial-runtime-failure'),
      shouldCancel: () => {
        cancellationChecks += 1;
        return cancellationChecks >= 3;
      }
    });
  } catch (error) {
    caught = error;
  }
  assert.ok(caught);
  assert.equal(caught.partialResult.batchId, 'partial-runtime-failure');
  assert.equal(caught.partialResult.partialCommitted, true);
  assert.deepEqual(caught.partialResult.records.map((record) => [record.sourceType, record.status]), [
    [SOURCE_TYPES.SYSTEM_OP, 'success'],
    [SOURCE_TYPES.RECHARGE, 'failed_validation']
  ]);
  assert.equal(db.prepare(`
    SELECT COUNT(*) AS n FROM vcc_fin_op_system_snapshots
  `).get().n, 1);
  const systemLineage = db.prepare(`
    SELECT source.source_file_name, source.source_sha256
    FROM vcc_fin_op_system_snapshots snapshot
    JOIN vcc_fin_op_import_sources source ON source.id = snapshot.import_source_id
  `).get();
  assert.equal(systemLineage.source_file_name, 'committed-system.xlsx');
  assert.match(systemLineage.source_sha256, /^[a-f0-9]{64}$/);
  assert.equal(db.prepare(`
    SELECT status FROM vcc_fin_op_import_batches WHERE id = 'partial-runtime-failure'
  `).get().status, 'failed');
});

test('同一原表重复导入时第二次全量幂等跳过且有效事实不增加', async (t) => {
  const db = createDb();
  t.after(() => db.close());
  const dir = tempDir(t);
  const filePath = writeSourceFile(dir, SOURCE_TYPES.RECHARGE, 'recharge.xlsx', [rechargeRow()]);

  const first = await importDetailBatch({
    db,
    targetMonth: '2026-06',
    files: [fileEntry(filePath, SOURCE_TYPES.RECHARGE)]
  });
  const second = await importDetailBatch({
    db,
    targetMonth: '2026-06',
    files: [fileEntry(filePath, SOURCE_TYPES.RECHARGE)]
  });

  assert.equal(first.records[0].status, 'success');
  assert.equal(first.records[0].insertedCount, 1);
  assert.equal(second.records[0].status, 'all_skipped');
  assert.equal(second.records[0].skippedCount, 1);
  assert.equal(second.records[0].anomalyCount, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM vcc_fin_op_effective_rows').get().n, 1);
  assert.equal(db.prepare(`
    SELECT COUNT(*) AS n FROM vcc_fin_op_import_anomalies
    WHERE import_record_id = ?
  `).get(second.records[0].recordId).n, 0);
  assert.equal(db.prepare(`
    SELECT COUNT(*) AS n FROM vcc_fin_op_import_staging_rows
  `).get().n, 0);
  assert.equal(db.prepare(`
    SELECT COUNT(*) AS n FROM vcc_fin_op_effective_raw_fallback
  `).get().n, 1);
});

test('校验表生成时间仅在实际新增有效明细时刷新', async (t) => {
  const db = createDb();
  t.after(() => db.close());
  const dir = tempDir(t);
  const firstFile = writeSourceFile(dir, SOURCE_TYPES.RECHARGE, 'generated-first.xlsx', [
    rechargeRow({ 订单号: 'generated-1' })
  ]);
  const secondFile = writeSourceFile(dir, SOURCE_TYPES.RECHARGE, 'generated-second.xlsx', [
    rechargeRow({ 订单号: 'generated-2' })
  ]);

  await importDetailBatch({
    db,
    targetMonth: '2026-06',
    files: [fileEntry(firstFile, SOURCE_TYPES.RECHARGE)]
  });
  db.prepare(`
    UPDATE vcc_fin_op_datasets SET generated_at = '2000-01-01 00:00:00'
    WHERE target_month = '2026-06' AND dataset_type = ?
  `).run(SOURCE_TYPES.RECHARGE);

  const skipped = await importDetailBatch({
    db,
    targetMonth: '2026-06',
    files: [fileEntry(firstFile, SOURCE_TYPES.RECHARGE)]
  });
  assert.equal(skipped.records[0].status, 'all_skipped');
  assert.equal(db.prepare(`
    SELECT generated_at FROM vcc_fin_op_datasets
    WHERE target_month = '2026-06' AND dataset_type = ?
  `).get(SOURCE_TYPES.RECHARGE).generated_at, '2000-01-01 00:00:00');

  const inserted = await importDetailBatch({
    db,
    targetMonth: '2026-06',
    files: [fileEntry(secondFile, SOURCE_TYPES.RECHARGE)]
  });
  const importRecord = repository.getImportRecord(db, inserted.records[0].recordId);
  assert.equal(inserted.records[0].status, 'success');
  assert.equal(db.prepare(`
    SELECT generated_at FROM vcc_fin_op_datasets
    WHERE target_month = '2026-06' AND dataset_type = ?
  `).get(SOURCE_TYPES.RECHARGE).generated_at, importRecord.finished_at);
});

test('同键异内容阻断整批且不覆盖既有有效行', async (t) => {
  const db = createDb();
  t.after(() => db.close());
  const dir = tempDir(t);
  const original = writeSourceFile(dir, SOURCE_TYPES.RECHARGE, 'original.xlsx', [rechargeRow()]);
  const changed = writeSourceFile(dir, SOURCE_TYPES.RECHARGE, 'changed.xlsx', [
    rechargeRow({ 我方到账金额: '99.99' })
  ]);

  await importDetailBatch({
    db, targetMonth: '2026-06', files: [fileEntry(original, SOURCE_TYPES.RECHARGE)]
  });
  const result = await importDetailBatch({
    db, targetMonth: '2026-06', files: [fileEntry(changed, SOURCE_TYPES.RECHARGE)]
  });

  assert.equal(result.records[0].status, 'failed_conflict');
  assert.equal(result.records[0].conflictCount, 1);
  const effective = db.prepare(`
    SELECT signed_amount, source_file FROM vcc_fin_op_effective_rows
  `).get();
  assert.equal(effective.signed_amount, '10.25');
  assert.equal(effective.source_file, 'original.xlsx');
  const conflict = db.prepare(`
    SELECT diff_fields_json, effective_row_id
    FROM vcc_fin_op_import_anomalies WHERE category = 'idempotent_conflict'
  `).get();
  assert.ok(conflict.effective_row_id);
  assert.deepEqual(JSON.parse(conflict.diff_fields_json), ['我方到账金额']);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM vcc_fin_op_import_staging_rows').get().n, 0);
  assert.equal(repository.resolveImportRecord, undefined);
  assert.equal(
    repository.getImportRecord(db, result.records[0].recordId).resolution_status,
    'not_applicable'
  );
});

test('混合精确重放、冲突和新行时只过滤异常并提升正常行', async (t) => {
  const db = createDb();
  t.after(() => db.close());
  const dir = tempDir(t);
  const baseline = writeSourceFile(dir, SOURCE_TYPES.RECHARGE, 'baseline.xlsx', [
    rechargeRow({ 订单号: 'same-key' }),
    rechargeRow({ 订单号: 'conflict-key', 我方到账金额: '5' })
  ]);
  await importDetailBatch({
    db, targetMonth: '2026-06', files: [fileEntry(baseline, SOURCE_TYPES.RECHARGE)]
  });
  const mixed = writeSourceFile(dir, SOURCE_TYPES.RECHARGE, 'mixed.xlsx', [
    rechargeRow({ 订单号: 'same-key' }),
    rechargeRow({ 订单号: 'conflict-key', 我方到账金额: '9' }),
    rechargeRow({ 订单号: 'new-key' })
  ]);

  const result = await importDetailBatch({
    db, targetMonth: '2026-06', files: [fileEntry(mixed, SOURCE_TYPES.RECHARGE)]
  });
  const record = result.records[0];
  assert.equal(record.status, 'success_with_skips');
  assert.equal(record.rawCount, 3);
  assert.equal(record.insertedCount, 1);
  assert.equal(record.skippedCount, 1);
  assert.equal(record.conflictCount, 1);
  assert.equal(record.rolledBackCount, 0);
  assert.equal(db.prepare(`
    SELECT COUNT(*) AS n FROM vcc_fin_op_effective_rows
  `).get().n, 3);
  assert.equal(db.prepare(`
    SELECT COUNT(*) AS n FROM vcc_fin_op_effective_rows
    WHERE idempotency_key = 'new-key'
  `).get().n, 1);
});

test('同批跨文件同键同内容只新增一次且幂等跳过仅累计计数', async (t) => {
  const db = createDb();
  t.after(() => db.close());
  const dir = tempDir(t);
  const one = writeSourceFile(dir, SOURCE_TYPES.RECHARGE, 'part-1.xlsx', [rechargeRow()]);
  const two = writeSourceFile(dir, SOURCE_TYPES.RECHARGE, 'part-2.xlsx', [rechargeRow()]);
  const result = await importDetailBatch({
    db,
    targetMonth: '2026-06',
    files: [fileEntry(one, SOURCE_TYPES.RECHARGE), fileEntry(two, SOURCE_TYPES.RECHARGE)]
  });

  assert.equal(result.records[0].status, 'success_with_skips');
  assert.equal(result.records[0].rawCount, 2);
  assert.equal(result.records[0].insertedCount, 1);
  assert.equal(result.records[0].skippedCount, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM vcc_fin_op_effective_rows').get().n, 1);
  assert.equal(db.prepare(`
    SELECT COUNT(*) AS n FROM vcc_fin_op_import_anomalies
    WHERE import_record_id = ?
  `).get(result.records[0].recordId).n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM vcc_fin_op_import_staging_rows').get().n, 0);
});

test('同批跨文件同键异内容为每条异常保留对端哈希和精确差异字段', async (t) => {
  const db = createDb();
  t.after(() => db.close());
  replaceEmptyEffectiveRowsWithSlimSchema(db);
  const dir = tempDir(t);
  const one = writeSourceFile(dir, SOURCE_TYPES.RECHARGE, 'conflict-1.xlsx', [
    rechargeRow({ 订单号: 'same-batch-conflict', 我方到账金额: '10.25' })
  ]);
  const two = writeSourceFile(dir, SOURCE_TYPES.RECHARGE, 'conflict-2.xlsx', [
    rechargeRow({ 订单号: 'same-batch-conflict', 我方到账金额: '99.99' })
  ]);

  const result = await importDetailBatch({
    db,
    targetMonth: '2026-06',
    files: [fileEntry(one, SOURCE_TYPES.RECHARGE), fileEntry(two, SOURCE_TYPES.RECHARGE)]
  });

  assert.equal(result.records[0].status, 'failed_conflict');
  assert.equal(result.records[0].conflictCount, 2);
  const anomalies = db.prepare(`
    SELECT incoming_content_hash, existing_content_hash, diff_fields_json
    FROM vcc_fin_op_import_anomalies
    WHERE import_record_id = ? AND category = 'idempotent_conflict'
    ORDER BY source_row, id
  `).all(result.records[0].recordId);
  assert.equal(anomalies.length, 2);
  assert.deepEqual(
    new Set(anomalies.map((row) => row.incoming_content_hash)),
    new Set(anomalies.map((row) => row.existing_content_hash))
  );
  for (const anomaly of anomalies) {
    assert.ok(anomaly.existing_content_hash);
    assert.notEqual(anomaly.existing_content_hash, anomaly.incoming_content_hash);
    assert.deepEqual(JSON.parse(anomaly.diff_fields_json), ['我方到账金额']);
  }
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM vcc_fin_op_effective_rows').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM vcc_fin_op_import_staging_rows').get().n, 0);
});

test('通道明细同键改填公司主体时冲突明细明确标识主体差异', async (t) => {
  const db = createDb();
  t.after(() => db.close());
  const dir = tempDir(t);
  const channel = writeSourceFile(dir, SOURCE_TYPES.CHANNEL, 'channel.xlsx', [{
    渠道订单号: 'channel-001',
    账单日期: '2026-06-10',
    通道名称: 'CITI',
    交易金额: '100',
    交易币种: 'USD',
    借贷方向: 'in'
  }]);

  await importDetailBatch({
    db,
    targetMonth: '2026-06',
    files: [fileEntry(channel, SOURCE_TYPES.CHANNEL, 'PPHK')]
  });
  const conflict = await importDetailBatch({
    db,
    targetMonth: '2026-06',
    files: [fileEntry(channel, SOURCE_TYPES.CHANNEL, 'PPUS')]
  });

  assert.equal(conflict.records[0].status, 'failed_conflict');
  const row = db.prepare(`
    SELECT diff_fields_json FROM vcc_fin_op_import_anomalies
    WHERE import_record_id = ? AND category = 'idempotent_conflict'
  `).get(conflict.records[0].recordId);
  assert.deepEqual(JSON.parse(row.diff_fields_json), ['公司主体（导入指定）']);
});

test('空键只过滤异常行，正常行落库并满足行数守恒', async (t) => {
  const db = createDb();
  t.after(() => db.close());
  const dir = tempDir(t);
  const filePath = writeSourceFile(dir, SOURCE_TYPES.RECHARGE, 'invalid.xlsx', [
    rechargeRow({ 订单号: ' ' }),
    rechargeRow({ 订单号: 'valid-2' })
  ]);
  const result = await importDetailBatch({
    db,
    targetMonth: '2026-06',
    files: [fileEntry(filePath, SOURCE_TYPES.RECHARGE)]
  });
  const record = result.records[0];

  assert.equal(record.status, 'success_with_skips');
  assert.equal(record.rawCount, 2);
  assert.equal(record.insertedCount, 1);
  assert.equal(record.invalidKeyCount, 1);
  assert.equal(record.rolledBackCount, 0);
  assert.equal(
    record.rawCount,
    record.insertedCount + record.skippedCount + record.invalidKeyCount
      + record.conflictCount + record.formatErrorCount + record.rolledBackCount
  );
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM vcc_fin_op_effective_rows').get().n, 1);
  assert.equal(db.prepare(`
    SELECT idempotency_key FROM vcc_fin_op_effective_rows
  `).get().idempotency_key, 'valid-2');
});

test('后续分片损坏时只保留回滚计数和一条文件级失败事件', async (t) => {
  const db = createDb();
  t.after(() => db.close());
  const dir = tempDir(t);
  const valid = writeSourceFile(dir, SOURCE_TYPES.RECHARGE, 'valid.xlsx', [rechargeRow()]);
  const broken = path.join(dir, 'broken.xlsx');
  fs.writeFileSync(broken, 'not-an-xlsx-file');

  const result = await importDetailBatch({
    db,
    targetMonth: '2026-06',
    files: [
      fileEntry(valid, SOURCE_TYPES.RECHARGE),
      fileEntry(broken, SOURCE_TYPES.RECHARGE)
    ]
  });
  const record = result.records[0];

  assert.equal(record.status, 'failed_validation');
  assert.equal(record.rawCount, 1);
  assert.equal(record.rolledBackCount, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM vcc_fin_op_effective_rows').get().n, 0);
  const anomaly = db.prepare(`
    SELECT category, source_file_name, description
    FROM vcc_fin_op_import_anomalies
    WHERE import_record_id = ?
  `).get(record.recordId);
  assert.equal(anomaly.category, 'file_failure');
  assert.equal(anomaly.source_file_name, 'broken.xlsx');
  assert.match(anomaly.description, /无法读取|不是有效的 Excel|zip/i);
  repository.addFileFailureAnomaly(db, record.recordId, {
    sourceFile: 'broken.xlsx',
    message: '重复恢复调用不得制造第二条文件级失败'
  });
  assert.equal(db.prepare(`
    SELECT COUNT(*) AS n FROM vcc_fin_op_import_anomalies
    WHERE import_record_id = ? AND category = 'file_failure'
  `).get(record.recordId).n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM vcc_fin_op_import_staging_rows').get().n, 0);
});

test('协作式取消只保留已读取行汇总和一条文件级失败事件', async (t) => {
  const db = createDb();
  t.after(() => db.close());
  const dir = tempDir(t);
  const source = writeSourceFile(dir, SOURCE_TYPES.RECHARGE, 'cancel.xlsx', [
    rechargeRow({ 订单号: 'cancel-1' }),
    rechargeRow({ 订单号: 'cancel-2' }),
    rechargeRow({ 订单号: 'cancel-3' })
  ]);
  let checks = 0;

  await assert.rejects(
    importDetailBatch({
      db,
      targetMonth: '2026-06',
      files: [fileEntry(source, SOURCE_TYPES.RECHARGE)],
      shouldCancel: () => {
        checks += 1;
        return checks >= 5;
      }
    }),
    (error) => error && error.code === 'vcc-import-cancelled'
  );

  const record = db.prepare('SELECT * FROM vcc_fin_op_import_records').get();
  assert.equal(record.status, 'failed_validation');
  assert.ok(record.raw_count > 0);
  assert.equal(record.rolled_back_count, record.raw_count);
  assert.match(record.error_message, /导入已取消/);
  assert.equal(db.prepare(`
    SELECT COUNT(*) AS n FROM vcc_fin_op_import_anomalies
    WHERE import_record_id = ? AND category = 'file_failure'
  `).get(record.id).n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM vcc_fin_op_import_staging_rows').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM vcc_fin_op_effective_rows').get().n, 0);
  assert.equal(db.prepare('SELECT status FROM vcc_fin_op_import_batches').get().status, 'failed');
});

test('导入开始前取消不创建空批次或导入记录', async (t) => {
  const db = createDb();
  t.after(() => db.close());

  await assert.rejects(
    importFiles({
      db,
      batchId: 'cancel-before-first-source',
      targetMonth: '2026-06',
      files: [
        fileEntry('/not-read/recharge.xlsx', SOURCE_TYPES.RECHARGE),
        fileEntry('/not-read/system.xlsx', SOURCE_TYPES.SYSTEM_OP, 'PPHK')
      ],
      shouldCancel: () => true
    }),
    /导入已取消/
  );

  assert.equal(db.prepare(`
    SELECT COUNT(*) AS n FROM vcc_fin_op_import_batches WHERE id = 'cancel-before-first-source'
  `).get().n, 0);
  assert.equal(db.prepare(`
    SELECT COUNT(*) AS n FROM vcc_fin_op_import_records WHERE batch_id = 'cancel-before-first-source'
  `).get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM vcc_fin_op_import_errors').get().n, 0);
});

test('业务前 handoff 多文件顺序或路径与 worker 首次 hash 不一致时零业务写入', async (t) => {
  const dir = tempDir(t);
  const firstPath = writeSourceFile(dir, SOURCE_TYPES.RECHARGE, 'handoff-first.xlsx', [
    rechargeRow({ 订单号: 'HANDOFF-FIRST' })
  ]);
  const secondPath = writeSourceFile(dir, SOURCE_TYPES.RECHARGE, 'handoff-second.xlsx', [
    rechargeRow({ 订单号: 'HANDOFF-SECOND' })
  ]);
  const files = [
    fileEntry(firstPath, SOURCE_TYPES.RECHARGE),
    fileEntry(secondPath, SOURCE_TYPES.RECHARGE)
  ];
  const hashed = await hashSourceFiles(files);
  const archiveHandoffFiles = hashed.map((file, index) => ({
    filePath: file.filePath,
    sourceType: file.sourceType,
    sourceOrdinal: index + 1,
    sha256: file.sha256,
    sizeBytes: file.sizeBytes,
    taskRunId: 'handoff-order-mismatch',
    archiveArtifactId: index + 1
  })).reverse();
  const db = createDb();
  t.after(() => db.close());

  await assert.rejects(
    importFiles({
      db,
      batchId: 'handoff-order-mismatch',
      targetMonth: '2026-06',
      files,
      archiveHandoffFiles
    }),
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
});

test('解析完成后的来源 SHA 不一致时正常行不落库且只留文件级失败', async (t) => {
  const dir = tempDir(t);
  const filePath = writeSourceFile(dir, SOURCE_TYPES.RECHARGE, 'changed-after-hash.xlsx', [
    rechargeRow({ 订单号: 'SOURCE-CHANGED' })
  ]);
  const db = createDb();
  t.after(() => db.close());
  repository.createImportBatch(db, {
    id: 'source-changed-batch',
    targetMonth: '2026-06',
    fileCount: 1
  });
  const recordId = repository.createImportRecord(db, {
    batchId: 'source-changed-batch',
    targetMonth: '2026-06',
    sourceType: SOURCE_TYPES.RECHARGE,
    sourceFiles: [path.basename(filePath)]
  });
  const importSourceId = repository.createImportSource(db, recordId, {
    sourceOrdinal: 1,
    fileName: path.basename(filePath),
    sha256: '0'.repeat(64),
    sizeBytes: fs.statSync(filePath).size
  });
  const record = await importDetailGroup({
    db,
    batchId: 'source-changed-batch',
    targetMonth: '2026-06',
    sourceType: SOURCE_TYPES.RECHARGE,
    files: [{
      filePath,
      sourceType: SOURCE_TYPES.RECHARGE,
      subject: '',
      fileName: path.basename(filePath),
      sha256: '0'.repeat(64),
      sizeBytes: fs.statSync(filePath).size,
      importSourceId
    }],
    recordId
  });
  assert.equal(record.status, 'failed_validation');
  assert.match(record.errorMessage, /读取期间原表发生变化/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM vcc_fin_op_effective_rows').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM vcc_fin_op_import_staging_rows').get().n, 0);
  assert.equal(db.prepare(`
    SELECT COUNT(*) AS n FROM vcc_fin_op_import_anomalies
    WHERE import_record_id = ? AND category = 'file_failure'
  `).get(recordId).n, 1);
});

test('多文件第二份最终 SHA 不一致时异常精确归属 source id/ordinal/文件名', async (t) => {
  const dir = tempDir(t);
  const firstPath = writeSourceFile(dir, SOURCE_TYPES.RECHARGE, 'first-stable.xlsx', [
    rechargeRow({ 订单号: 'FIRST-STABLE' })
  ]);
  const secondPath = writeSourceFile(dir, SOURCE_TYPES.RECHARGE, 'second-changed.xlsx', [
    rechargeRow({ 订单号: 'SECOND-CHANGED' })
  ]);
  const db = createDb();
  t.after(() => db.close());
  repository.createImportBatch(db, {
    id: 'multi-source-changed', targetMonth: '2026-06', fileCount: 2
  });
  const recordId = repository.createImportRecord(db, {
    batchId: 'multi-source-changed',
    targetMonth: '2026-06',
    sourceType: SOURCE_TYPES.RECHARGE,
    sourceFiles: ['first-stable.xlsx', 'second-changed.xlsx']
  });
  const firstSourceId = repository.createImportSource(db, recordId, {
    sourceOrdinal: 1,
    fileName: 'first-stable.xlsx',
    sha256: require('node:crypto').createHash('sha256').update(fs.readFileSync(firstPath)).digest('hex'),
    sizeBytes: fs.statSync(firstPath).size
  });
  const secondSourceId = repository.createImportSource(db, recordId, {
    sourceOrdinal: 2,
    fileName: 'second-changed.xlsx',
    sha256: '0'.repeat(64),
    sizeBytes: fs.statSync(secondPath).size
  });
  const record = await importDetailGroup({
    db,
    batchId: 'multi-source-changed',
    targetMonth: '2026-06',
    sourceType: SOURCE_TYPES.RECHARGE,
    recordId,
    files: [
      {
        ...fileEntry(firstPath, SOURCE_TYPES.RECHARGE),
        fileName: 'first-stable.xlsx',
        sha256: require('node:crypto').createHash('sha256').update(fs.readFileSync(firstPath)).digest('hex'),
        sizeBytes: fs.statSync(firstPath).size,
        sourceOrdinal: 1,
        importSourceId: firstSourceId
      },
      {
        ...fileEntry(secondPath, SOURCE_TYPES.RECHARGE),
        fileName: 'second-changed.xlsx',
        sha256: '0'.repeat(64),
        sizeBytes: fs.statSync(secondPath).size,
        sourceOrdinal: 2,
        importSourceId: secondSourceId
      }
    ]
  });
  assert.equal(record.status, 'failed_validation');
  assert.equal(record.rawCount, 2);
  assert.equal(record.rolledBackCount, 2);
  const anomaly = db.prepare(`
    SELECT import_source_id, source_file_name, category
    FROM vcc_fin_op_import_anomalies WHERE import_record_id = ?
  `).get(recordId);
  assert.deepEqual({ ...anomaly }, {
    import_source_id: secondSourceId,
    source_file_name: 'second-changed.xlsx',
    category: 'file_failure'
  });
  const exported = [...repository.iterateExportableImportAnomalies(db, recordId)];
  assert.equal(exported.length, 1);
  assert.equal(exported[0].source_file_name, 'second-changed.xlsx');
});

test('文件级失败拒绝关联其他 record 或 batch 的 import source', (t) => {
  const db = createDb();
  t.after(() => db.close());
  for (const batchId of ['source-owner-a', 'source-owner-b']) {
    repository.createImportBatch(db, { id: batchId, targetMonth: '2026-06', fileCount: 1 });
  }
  const recordA = repository.createImportRecord(db, {
    batchId: 'source-owner-a', targetMonth: '2026-06',
    sourceType: SOURCE_TYPES.RECHARGE, sourceFiles: ['a.xlsx']
  });
  const recordB = repository.createImportRecord(db, {
    batchId: 'source-owner-b', targetMonth: '2026-06',
    sourceType: SOURCE_TYPES.RECHARGE, sourceFiles: ['b.xlsx']
  });
  const sourceB = repository.createImportSource(db, recordB, {
    sourceOrdinal: 1,
    fileName: 'b.xlsx',
    sha256: 'b'.repeat(64),
    sizeBytes: 2
  });
  assert.throws(() => repository.addFileFailureAnomaly(db, recordA, {
    importSourceId: sourceB,
    sourceOrdinal: 1,
    fileName: 'b.xlsx',
    message: '不应跨 record 关联'
  }), /不属于目标导入记录/);
  assert.throws(() => repository.failImportBatch(db, 'source-owner-a', {
    importSourceId: sourceB,
    sourceOrdinal: 1,
    fileName: 'b.xlsx',
    message: '不应跨 batch 关联'
  }), /不属于目标导入批次/);
  assert.equal(db.prepare(`
    SELECT COUNT(*) AS n FROM vcc_fin_op_import_anomalies
  `).get().n, 0);
  assert.equal(repository.getImportRecord(db, recordA).status, 'importing');
});

test('任一选中分片只有表头时整批回滚并标明空分片文件', async (t) => {
  const db = createDb();
  t.after(() => db.close());
  const dir = tempDir(t);
  const valid = writeSourceFile(dir, SOURCE_TYPES.RECHARGE, 'valid.xlsx', [rechargeRow()]);
  const empty = writeSourceFile(dir, SOURCE_TYPES.RECHARGE, 'empty.xlsx', []);

  const result = await importDetailBatch({
    db,
    targetMonth: '2026-06',
    files: [
      fileEntry(valid, SOURCE_TYPES.RECHARGE),
      fileEntry(empty, SOURCE_TYPES.RECHARGE)
    ]
  });

  const record = result.records[0];
  assert.equal(record.status, 'failed_validation');
  assert.equal(record.rawCount, 1);
  assert.equal(record.rolledBackCount, 1);
  assert.match(record.errorMessage, /empty\.xlsx.*没有数据行/);
  const error = db.prepare(`
    SELECT source_file_name, category, description FROM vcc_fin_op_import_anomalies
    WHERE import_record_id = ? AND category = 'file_failure'
  `).get(record.recordId);
  assert.equal(error.source_file_name, 'empty.xlsx');
  assert.equal(error.category, 'file_failure');
  assert.match(error.description, /没有数据行/);
  assert.equal(db.prepare(`
    SELECT COUNT(*) AS n FROM vcc_fin_op_import_errors WHERE import_record_id = ?
  `).get(record.recordId).n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM vcc_fin_op_effective_rows').get().n, 0);
});

test('Excel 数值日期单元格按 1900 日期系统识别账期', async (t) => {
  const db = createDb();
  t.after(() => db.close());
  const dir = tempDir(t);
  const excelSerial = (
    Date.UTC(2026, 5, 9) - Date.UTC(1899, 11, 30)
  ) / (24 * 60 * 60 * 1000);
  const filePath = writeSourceFile(dir, SOURCE_TYPES.RECHARGE, 'numeric-date.xlsx', [
    rechargeRow({ BillDate: excelSerial })
  ]);

  const result = await importDetailBatch({
    db,
    targetMonth: '2026-06',
    files: [fileEntry(filePath, SOURCE_TYPES.RECHARGE)]
  });
  assert.equal(result.records[0].status, 'success');
  assert.equal(result.records[0].insertedCount, 1);
});

test('工作簿中的长文本键可导入，数值型键整批拒绝', async (t) => {
  const db = createDb();
  t.after(() => db.close());
  const dir = tempDir(t);
  const textKey = '123456789012345678901234567890';
  const textFile = writeSourceFile(dir, SOURCE_TYPES.RECHARGE, 'text-key.xlsx', [
    rechargeRow({ 订单号: textKey })
  ]);
  const numericFile = writeSourceFile(dir, SOURCE_TYPES.RECHARGE, 'numeric-key.xlsx', [
    rechargeRow({ 订单号: 1234567890123456 })
  ]);

  const accepted = await importDetailBatch({
    db,
    targetMonth: '2026-06',
    files: [fileEntry(textFile, SOURCE_TYPES.RECHARGE)]
  });
  const rejected = await importDetailBatch({
    db,
    targetMonth: '2026-06',
    files: [fileEntry(numericFile, SOURCE_TYPES.RECHARGE)]
  });

  assert.equal(accepted.records[0].status, 'success');
  assert.equal(db.prepare(`
    SELECT idempotency_key FROM vcc_fin_op_effective_rows WHERE source_file = 'text-key.xlsx'
  `).get().idempotency_key, textKey);
  assert.equal(rejected.records[0].status, 'failed_validation');
  assert.equal(rejected.records[0].invalidKeyCount, 1);
  const invalid = db.prepare(`
    SELECT description FROM vcc_fin_op_import_anomalies
    WHERE import_record_id = ? AND category = 'invalid_key'
  `).get(rejected.records[0].recordId);
  assert.match(invalid.description, /必须在 Excel 中存为文本/);
});

test('不同原表类型使用独立幂等命名空间', async (t) => {
  const db = createDb();
  t.after(() => db.close());
  const dir = tempDir(t);
  const recharge = writeSourceFile(dir, SOURCE_TYPES.RECHARGE, 'recharge.xlsx', [rechargeRow()]);
  const fee = writeSourceFile(dir, SOURCE_TYPES.FEE_FX, 'fee.xlsx', [{
    订单号: '000123', BillDate: '2026-06-09', 业务部门: 'VCC', 业务子类型: 'fee',
    出入方向: 'in', 公司主体: 'PPHK', 我方币种: 'USD', 我方到账金额: '1'
  }]);
  const result = await importDetailBatch({
    db,
    targetMonth: '2026-06',
    files: [
      fileEntry(recharge, SOURCE_TYPES.RECHARGE),
      fileEntry(fee, SOURCE_TYPES.FEE_FX)
    ]
  });

  assert.deepEqual(result.records.map((record) => record.status), ['success', 'success']);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM vcc_fin_op_effective_rows').get().n, 2);
});

test('已归档数据集允许全量幂等回放，但拒绝新增有效事实', async (t) => {
  const db = createDb();
  t.after(() => db.close());
  const dir = tempDir(t);
  const firstFile = writeSourceFile(dir, SOURCE_TYPES.RECHARGE, 'first.xlsx', [rechargeRow()]);
  await importDetailBatch({
    db, targetMonth: '2026-06', files: [fileEntry(firstFile, SOURCE_TYPES.RECHARGE)]
  });
  db.prepare(`
    UPDATE vcc_fin_op_datasets SET data_status = 'archived'
    WHERE target_month = '2026-06' AND dataset_type = ?
  `).run(SOURCE_TYPES.RECHARGE);

  const replay = await importDetailBatch({
    db, targetMonth: '2026-06', files: [fileEntry(firstFile, SOURCE_TYPES.RECHARGE)]
  });
  const newFile = writeSourceFile(dir, SOURCE_TYPES.RECHARGE, 'new.xlsx', [
    rechargeRow({ 订单号: 'new-key' })
  ]);
  const rejected = await importDetailBatch({
    db, targetMonth: '2026-06', files: [fileEntry(newFile, SOURCE_TYPES.RECHARGE)]
  });

  assert.equal(replay.records[0].status, 'all_skipped');
  assert.equal(rejected.records[0].status, 'failed_validation');
  assert.equal(rejected.records[0].rolledBackCount, 1);
  assert.match(rejected.records[0].errorMessage, /已归档/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM vcc_fin_op_effective_rows').get().n, 1);
});

test('整月归档后拒绝首次补入此前不存在的 Pending 数据集', async (t) => {
  const db = createDb();
  t.after(() => db.close());
  const dir = tempDir(t);
  const pending = writeSourceFile(dir, SOURCE_TYPES.PENDING, 'pending.xlsx', [{
    PendingBizId: 'pending-after-archive',
    平账账期: '2026-06-01',
    主体: 'PPHK',
    对账类型: 'VCC_clearing_credit',
    金额: '10',
    币种: 'USD',
    流水_币种: 'USD',
    流水_对账金额: '10'
  }]);
  const runId = Number(db.prepare(`
    INSERT INTO vcc_fin_op_runs (target_month, status, input_revisions_json)
    VALUES ('2026-06', 'archived', '{}')
  `).run().lastInsertRowid);
  db.prepare(`
    INSERT INTO vcc_fin_op_archives (target_month, subject, balances_json, run_id)
    VALUES ('2026-06', 'PPHK', '{}', ?)
  `).run(runId);

  const result = await importDetailBatch({
    db,
    targetMonth: '2026-06',
    files: [fileEntry(pending, SOURCE_TYPES.PENDING)]
  });
  assert.equal(result.records[0].status, 'failed_validation');
  assert.match(result.records[0].errorMessage, /已归档/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM vcc_fin_op_effective_rows').get().n, 0);
  assert.equal(db.prepare(`
    SELECT COUNT(*) AS n FROM vcc_fin_op_datasets WHERE dataset_type = ?
  `).get(SOURCE_TYPES.PENDING).n, 0);
});

test('异常退出恢复不会把暂存行提升为有效事实', (t) => {
  const db = createDb();
  t.after(() => db.close());
  repository.createImportBatch(db, { id: 'interrupted', targetMonth: '2026-06', fileCount: 1 });
  const recordId = repository.createImportRecord(db, {
    batchId: 'interrupted', targetMonth: '2026-06', sourceType: SOURCE_TYPES.RECHARGE,
    sourceFiles: ['x.xlsx']
  });
  const sourceId = repository.createImportSource(db, recordId, {
    sourceOrdinal: 1,
    fileName: 'x.xlsx',
    sha256: 'a'.repeat(64),
    sizeBytes: 1
  });
  db.prepare(`
    INSERT INTO vcc_fin_op_import_staging_rows (
      import_record_id, import_source_id, source_type, target_month, source_file, sheet_name, source_row,
      raw_json, disposition, validation_field, validation_message
    ) VALUES
      (?, ?, ?, '2026-06', 'x.xlsx', 'sheet1', 2, '[]', NULL, NULL, NULL),
      (?, ?, ?, '2026-06', 'x.xlsx', 'sheet1', 3, '[]', 'invalid_key', '订单号', '订单号不能为空')
  `).run(
    recordId, sourceId, SOURCE_TYPES.RECHARGE,
    recordId, sourceId, SOURCE_TYPES.RECHARGE
  );

  assert.equal(repository.recoverInterruptedImports(db), 1);
  const record = repository.getImportRecord(db, recordId);
  assert.equal(record.status, 'failed_validation');
  assert.equal(record.raw_count, 2);
  assert.equal(record.rolled_back_count, 1);
  assert.equal(record.invalid_key_count, 1);
  assert.equal(
    record.raw_count,
    record.inserted_count + record.skipped_count + record.invalid_key_count
      + record.conflict_count + record.format_error_count + record.rolled_back_count
  );
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM vcc_fin_op_effective_rows').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM vcc_fin_op_import_staging_rows').get().n, 0);
  assert.deepEqual(db.prepare(`
    SELECT category FROM vcc_fin_op_import_anomalies
    WHERE import_record_id = ? ORDER BY id
  `).all(recordId).map((row) => row.category).sort(), ['file_failure', 'invalid_key']);
});

test('直接升级会接管 v3.1.9 importing 宽行并转换 compact anomaly 后清理', (t) => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec('PRAGMA foreign_keys = ON');
  const legacyMigrations = loadV319Module('src/backend/vcc-financial-op-db/migrations.js');
  const legacyRepository = loadV319Module('src/backend/vcc-financial-op-db/repository.js');
  legacyMigrations.ensureVccFinancialOpTablesSupport(db);
  legacyRepository.createImportBatch(db, {
    id: 'v319-interrupted', targetMonth: '2026-06', fileCount: 2
  });
  const recordId = legacyRepository.createImportRecord(db, {
    batchId: 'v319-interrupted',
    targetMonth: '2026-06',
    sourceType: SOURCE_TYPES.RECHARGE,
    sourceFiles: ['first.xlsx', 'second.xlsx']
  });
  const insertLegacy = db.prepare(legacyRepository.IMPORT_ROW_INSERT_SQL);
  const addLegacyRow = (index, disposition, options = {}) => insertLegacy.run(
    recordId,
    SOURCE_TYPES.RECHARGE,
    '2026-06',
    options.rawKey || `legacy-${index}`,
    options.key || `legacy-${index}`,
    String(index).repeat(64).slice(0, 64),
    1,
    1,
    'PPHK',
    'USD',
    '10.00',
    'VCC',
    'OPS',
    '充值',
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    options.sourceFile || 'first.xlsx',
    'sheet1',
    index + 1,
    JSON.stringify([`legacy-${index}`]),
    disposition,
    options.field || null,
    options.message || null
  );
  addLegacyRow(1, null);
  addLegacyRow(2, 'idempotent_skip');
  addLegacyRow(3, 'invalid_key', {
    rawKey: '', key: null, field: '订单号', message: '订单号不能为空'
  });
  addLegacyRow(4, 'format_error', {
    field: '我方到账金额', message: '金额格式错误'
  });
  addLegacyRow(5, 'idempotent_conflict', {
    field: 'idempotency_key', message: '同键异内容'
  });
  addLegacyRow(6, 'rolled_back', { message: '旧版已回滚' });
  legacyRepository.addImportError(db, recordId, {
    errorCode: 'legacy-file-failure',
    message: 'second.xlsx 读取失败',
    sourceFile: 'second.xlsx'
  });

  ensureVccFinancialOpTablesSupport(db);
  assert.equal(repository.recoverInterruptedImports(db), 1);
  const record = repository.getImportRecord(db, recordId);
  assert.equal(record.status, 'failed_conflict');
  assert.deepEqual({
    raw: record.raw_count,
    inserted: record.inserted_count,
    skipped: record.skipped_count,
    invalidKey: record.invalid_key_count,
    conflict: record.conflict_count,
    formatError: record.format_error_count,
    rolledBack: record.rolled_back_count,
    anomaly: record.anomaly_count,
    archiveState: record.archive_state
  }, {
    raw: 6,
    inserted: 0,
    skipped: 1,
    invalidKey: 1,
    conflict: 1,
    formatError: 1,
    rolledBack: 2,
    anomaly: 4,
    archiveState: 'unavailable'
  });
  assert.equal(db.prepare(`
    SELECT COUNT(*) AS n FROM vcc_fin_op_import_rows WHERE import_record_id = ?
  `).get(recordId).n, 0);
  assert.equal(db.prepare(`
    SELECT COUNT(*) AS n FROM vcc_fin_op_import_staging_rows WHERE import_record_id = ?
  `).get(recordId).n, 0);
  assert.deepEqual(db.prepare(`
    SELECT category, source_file_name, source_row, abnormal_fields_json, description
    FROM vcc_fin_op_import_anomalies
    WHERE import_record_id = ? ORDER BY id
  `).all(recordId).map((row) => ({
    ...row,
    abnormal_fields_json: JSON.parse(row.abnormal_fields_json)
  })), [
    {
      category: 'invalid_key', source_file_name: 'first.xlsx', source_row: 4,
      abnormal_fields_json: ['订单号'], description: '订单号不能为空'
    },
    {
      category: 'format_error', source_file_name: 'first.xlsx', source_row: 5,
      abnormal_fields_json: ['我方到账金额'], description: '金额格式错误'
    },
    {
      category: 'idempotent_conflict', source_file_name: 'first.xlsx', source_row: 6,
      abnormal_fields_json: ['idempotency_key'], description: '同键异内容'
    },
    {
      category: 'file_failure', source_file_name: 'second.xlsx', source_row: null,
      abnormal_fields_json: [], description: 'second.xlsx 读取失败'
    }
  ]);
});

test('运行期非预期异常立即收口当前批次且不影响其他导入记录', async (t) => {
  const db = createDb();
  t.after(() => db.close());
  const dir = tempDir(t);
  const filePath = writeSourceFile(dir, SOURCE_TYPES.RECHARGE, 'runtime-error.xlsx', [
    rechargeRow({ 订单号: 'runtime-error-key' })
  ]);
  repository.createImportBatch(db, {
    id: 'unrelated-import', targetMonth: '2026-06', fileCount: 1
  });
  const unrelatedRecordId = repository.createImportRecord(db, {
    batchId: 'unrelated-import', targetMonth: '2026-06', sourceType: SOURCE_TYPES.RECHARGE,
    sourceFiles: ['unrelated.xlsx']
  });
  db.exec(`
    CREATE TRIGGER vcc_fin_op_test_reject_effective_row
    BEFORE INSERT ON vcc_fin_op_effective_rows
    BEGIN
      SELECT RAISE(ABORT, 'forced effective-row failure');
    END
  `);

  await assert.rejects(
    importDetailBatch({
      db,
      batchId: 'runtime-error',
      targetMonth: '2026-06',
      files: [fileEntry(filePath, SOURCE_TYPES.RECHARGE)]
    }),
    /forced effective-row failure/
  );

  const batch = db.prepare(`
    SELECT status, error_message FROM vcc_fin_op_import_batches WHERE id = 'runtime-error'
  `).get();
  const record = db.prepare(`
    SELECT * FROM vcc_fin_op_import_records WHERE batch_id = 'runtime-error'
  `).get();
  assert.equal(batch.status, 'failed');
  assert.match(batch.error_message, /forced effective-row failure/);
  assert.equal(record.status, 'failed_validation');
  assert.equal(record.raw_count, 1);
  assert.equal(record.rolled_back_count, 1);
  assert.equal(record.resolution_status, 'not_applicable');
  assert.equal(db.prepare(`
    SELECT COUNT(*) AS n FROM vcc_fin_op_import_errors WHERE import_record_id = ?
  `).get(record.id).n, 0);
  const anomaly = db.prepare(`
    SELECT category, description FROM vcc_fin_op_import_anomalies
    WHERE import_record_id = ?
  `).get(record.id);
  assert.equal(anomaly.category, 'file_failure');
  assert.match(anomaly.description, /forced effective-row failure/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM vcc_fin_op_effective_rows').get().n, 0);
  assert.equal(repository.getImportRecord(db, unrelatedRecordId).status, 'importing');
  assert.equal(db.prepare(`
    SELECT status FROM vcc_fin_op_import_batches WHERE id = 'unrelated-import'
  `).get().status, 'importing');
});

test('异常退出恢复会收口没有导入记录的孤立批次', (t) => {
  const db = createDb();
  t.after(() => db.close());
  repository.createImportBatch(db, { id: 'orphan-batch', targetMonth: '2026-06', fileCount: 1 });

  assert.equal(repository.recoverInterruptedImports(db), 0);
  const batch = db.prepare('SELECT status, error_message FROM vcc_fin_op_import_batches WHERE id = ?').get('orphan-batch');
  assert.equal(batch.status, 'failed');
  assert.match(batch.error_message, /异常退出/);
});
