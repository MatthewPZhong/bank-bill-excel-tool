'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const XLSX = require('xlsx');
const { DatabaseSync } = require('node:sqlite');
const { ensureVccFinancialOpTablesSupport } = require('../../../../src/backend/vcc-financial-op-db/migrations');
const repository = require('../../../../src/backend/vcc-financial-op-db/repository');
const {
  SOURCE_TYPES,
  SUPPORTED_CURRENCIES,
  SYSTEM_OP_HEADERS,
  getSourceDefinition
} = require('../../../../src/backend/vcc-financial-op/definitions');
const {
  importDetailBatch
} = require('../../../../src/backend/vcc-financial-op/detail-importer');
const {
  importFiles,
  normalizeImportBatchId
} = require('../../../../src/backend/vcc-financial-op/import-service');
const {
  inspectSourceFile,
  openWorkbookSheets
} = require('../../../../src/backend/vcc-financial-op/workbook-reader');

function createDb() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  ensureVccFinancialOpTablesSupport(db);
  return db;
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

test('外部 VCC import batchId 只接受与 exact7 相同的稳定文本边界', () => {
  assert.match(normalizeImportBatchId(), /^[0-9a-f-]{36}$/);
  assert.equal(normalizeImportBatchId('task-run-319'), 'task-run-319');
  for (const invalid of ['', ' task-run', 'task-run ', 'task\nrun', 319, 'x'.repeat(257)]) {
    assert.throws(() => normalizeImportBatchId(invalid), /VCC 导入批次号/);
  }
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

  const result = await importFiles({
    db,
    batchId: 'multi-source-service',
    targetMonth: '2026-06',
    files: [
      fileEntry(recharge, SOURCE_TYPES.RECHARGE),
      fileEntry(fee, SOURCE_TYPES.FEE_FX)
    ]
  });

  assert.equal(result.status, 'success');
  assert.equal(result.records.length, 2);
  assert.ok(result.records.every((record) => record.status === 'success'));
  assert.equal(db.prepare(`
    SELECT COUNT(*) AS n FROM vcc_fin_op_import_records WHERE batch_id = 'multi-source-service'
  `).get().n, 2);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM vcc_fin_op_effective_rows').get().n, 2);
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
    await importFiles({
      db,
      batchId: 'partial-runtime-failure',
      targetMonth: '2026-06',
      files: [
        fileEntry(system, SOURCE_TYPES.SYSTEM_OP, 'PPHK'),
        fileEntry(recharge, SOURCE_TYPES.RECHARGE)
      ],
      shouldCancel: () => {
        cancellationChecks += 1;
        return cancellationChecks >= 2;
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
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM vcc_fin_op_effective_rows').get().n, 1);
  const skip = db.prepare(`
    SELECT i.idempotency_key, i.raw_json, e.raw_json AS existing_raw_json
    FROM vcc_fin_op_import_rows i
    JOIN vcc_fin_op_effective_rows e ON e.id = i.existing_effective_id
    WHERE i.disposition = 'idempotent_skip'
  `).get();
  assert.equal(skip.idempotency_key, '000123');
  assert.equal(skip.raw_json, skip.existing_raw_json);
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
    SELECT diff_fields_json, existing_effective_id
    FROM vcc_fin_op_import_rows WHERE disposition = 'idempotent_conflict'
  `).get();
  assert.ok(conflict.existing_effective_id);
  assert.deepEqual(JSON.parse(conflict.diff_fields_json), ['我方到账金额']);
  assert.throws(() => repository.resolveImportRecord(db, result.records[0].recordId, {
    note: '已核对'
  }), /必须明确确认保留当前有效数据集/);
  const resolved = repository.resolveImportRecord(db, result.records[0].recordId, {
    note: '已核对，保留原有效记录',
    action: 'keep_current_effective_dataset'
  });
  assert.equal(resolved.resolution_action, 'keep_current_effective_dataset');
  const replayed = repository.resolveImportRecord(db, result.records[0].recordId, {
    note: '已核对，保留原有效记录',
    action: 'keep_current_effective_dataset'
  });
  assert.equal(replayed.resolved_at, resolved.resolved_at);
  assert.throws(() => repository.resolveImportRecord(db, result.records[0].recordId, {
    note: '改写处理结论',
    action: 'keep_current_effective_dataset'
  }), /处理结论不可修改/);
  assert.throws(() => repository.resolveImportRecord(db, result.records[0].recordId, {
    note: 'a'.repeat(501),
    action: 'keep_current_effective_dataset'
  }), /不能超过 500 个字符/);
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

test('同批跨文件同键同内容只新增一次并逐条记录跳过', async (t) => {
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
    SELECT COUNT(*) AS n FROM vcc_fin_op_import_rows WHERE disposition = 'idempotent_skip'
  `).get().n, 1);
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
    SELECT diff_fields_json FROM vcc_fin_op_import_rows
    WHERE import_record_id = ? AND disposition = 'idempotent_conflict'
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

test('后续分片损坏时保留此前已读取行的逐行回滚审计', async (t) => {
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

  assert.equal(result.records[0].status, 'failed_validation');
  assert.equal(result.records[0].rawCount, 1);
  assert.equal(result.records[0].rolledBackCount, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM vcc_fin_op_effective_rows').get().n, 0);
  const auditRow = db.prepare(`
    SELECT disposition, source_file, raw_json
    FROM vcc_fin_op_import_rows
  `).get();
  assert.equal(auditRow.disposition, 'rolled_back');
  assert.equal(auditRow.source_file, 'valid.xlsx');
  assert.match(auditRow.raw_json, /000123/);
});

test('协作式取消保留已读取行的回滚审计且不提升有效事实', async (t) => {
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
  assert.equal(record.raw_count, 2);
  assert.equal(record.rolled_back_count, 2);
  assert.match(record.error_message, /导入已取消/);
  assert.equal(db.prepare(`
    SELECT COUNT(*) AS n FROM vcc_fin_op_import_rows
    WHERE disposition = 'rolled_back'
  `).get().n, 2);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM vcc_fin_op_effective_rows').get().n, 0);
  assert.equal(db.prepare('SELECT status FROM vcc_fin_op_import_batches').get().status, 'failed');
});

test('导入开始前取消也为每个已识别原表类型保留失败记录', async (t) => {
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

  const records = db.prepare(`
    SELECT source_type, status, raw_count, rolled_back_count, resolution_status
    FROM vcc_fin_op_import_records
    WHERE batch_id = 'cancel-before-first-source'
    ORDER BY source_type
  `).all();
  assert.equal(records.length, 2);
  assert.deepEqual(records.map((row) => row.source_type), [
    SOURCE_TYPES.RECHARGE,
    SOURCE_TYPES.SYSTEM_OP
  ].sort());
  assert.ok(records.every((row) => row.status === 'failed_validation'));
  assert.ok(records.every((row) => row.raw_count === 0 && row.rolled_back_count === 0));
  assert.ok(records.every((row) => row.resolution_status === 'unresolved'));
  assert.equal(db.prepare(`
    SELECT status FROM vcc_fin_op_import_batches WHERE id = 'cancel-before-first-source'
  `).get().status, 'failed');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM vcc_fin_op_import_errors').get().n, 2);
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
    SELECT source_file, error_code FROM vcc_fin_op_import_errors
    WHERE import_record_id = ?
  `).get(record.recordId);
  assert.equal(error.source_file, 'empty.xlsx');
  assert.equal(error.error_code, 'empty-source-shard');
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
    SELECT validation_message FROM vcc_fin_op_import_rows
    WHERE import_record_id = ? AND disposition = 'invalid_key'
  `).get(rejected.records[0].recordId);
  assert.match(invalid.validation_message, /必须在 Excel 中存为文本/);
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
  db.prepare(`
    INSERT INTO vcc_fin_op_import_rows (
      import_record_id, source_type, target_month, source_file, sheet_name, source_row,
      raw_json, disposition, validation_field, validation_message
    ) VALUES
      (?, ?, '2026-06', 'x.xlsx', 'sheet1', 2, '[]', NULL, NULL, NULL),
      (?, ?, '2026-06', 'x.xlsx', 'sheet1', 3, '[]', 'invalid_key', '订单号', '订单号不能为空')
  `).run(recordId, SOURCE_TYPES.RECHARGE, recordId, SOURCE_TYPES.RECHARGE);

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
  assert.equal(record.resolution_status, 'unresolved');
  assert.equal(db.prepare(`
    SELECT COUNT(*) AS n FROM vcc_fin_op_import_errors WHERE import_record_id = ?
  `).get(record.id).n, 1);
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
