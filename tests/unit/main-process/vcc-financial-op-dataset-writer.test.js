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
  SOURCE_LABELS,
  SUPPORTED_CURRENCIES,
  SYSTEM_OP_HEADERS,
  getSourceDefinition
} = require('../../../src/backend/vcc-financial-op/definitions');
const {
  EXPORT_KINDS,
  CHECK_EXPORT_DEFINITIONS,
  inspectDatasetExport,
  writeDatasetWorkbook
} = require('../../../src/main-process/vcc-financial-op-dataset-writer');

function openFixture(t) {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  ensureVccFinancialOpTablesSupport(db);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vcc-dataset-export-'));
  t.after(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { db, dir };
}

function sourceValues(sourceType, overrides) {
  const definition = getSourceDefinition(sourceType);
  return definition.headers.map((header) => Object.hasOwn(overrides, header) ? overrides[header] : '');
}

function createEffectiveRecord(db, sourceType, overrides, derived, { key, batchSuffix = sourceType } = {}) {
  const batchId = `batch-${batchSuffix}`;
  let record = db.prepare(`
    SELECT id FROM vcc_fin_op_import_records WHERE batch_id = ? AND source_type = ?
  `).get(batchId, sourceType);
  if (!record) {
    if (!db.prepare('SELECT id FROM vcc_fin_op_import_batches WHERE id = ?').get(batchId)) {
      repository.createImportBatch(db, { id: batchId, targetMonth: '2026-06', fileCount: 1 });
    }
    const recordId = repository.createImportRecord(db, {
      batchId,
      targetMonth: '2026-06',
      sourceType,
      sourceFiles: [`${sourceType}.xlsx`]
    });
    repository.finishImportRecord(db, recordId, { status: 'success', rawCount: 1, insertedCount: 1 });
    repository.finishImportBatch(db, batchId, 'success');
    record = { id: recordId };
  }
  const values = sourceValues(sourceType, overrides);
  const effectiveKey = key || overrides[getSourceDefinition(sourceType).keyHeader];
  db.prepare(`
    INSERT INTO vcc_fin_op_effective_rows (
      source_type, idempotency_key_raw, idempotency_key, content_hash, raw_contract_version,
      target_month, subject, stat_currency, signed_amount,
      pending_amount, flow_amount, currency_mismatch,
      source_file, sheet_name, source_row, raw_json, import_record_id
    ) VALUES (?, ?, ?, ?, ?, '2026-06', ?, ?, ?, ?, ?, ?, ?, 'Sheet1', 2, ?, ?)
  `).run(
    sourceType,
    effectiveKey,
    effectiveKey,
    `hash-${effectiveKey}`,
    sourceType === SOURCE_TYPES.PENDING ? 2 : 1,
    derived.subject,
    derived.statCurrency || null,
    derived.signedAmount || null,
    derived.pendingAmount || null,
    derived.flowAmount || null,
    derived.currencyMismatch == null ? null : derived.currencyMismatch,
    `${sourceType}.xlsx`,
    JSON.stringify(values),
    record.id
  );
  return values;
}

function insertFormalSystemSnapshot(db) {
  const batchId = 'batch-system';
  repository.createImportBatch(db, { id: batchId, targetMonth: '2026-06', fileCount: 1 });
  const recordId = repository.createImportRecord(db, {
    batchId,
    targetMonth: '2026-06',
    sourceType: SOURCE_TYPES.SYSTEM_OP,
    sourceFiles: ['system.xlsx']
  });
  repository.finishImportRecord(db, recordId, { status: 'success', rawCount: 1, insertedCount: 1 });
  repository.finishImportBatch(db, batchId, 'success');
  const rows = SUPPORTED_CURRENCIES.map((currency, index) => {
    const sourceCurrency = currency === 'CNH' ? 'CNY' : currency;
    const displayValues = SYSTEM_OP_HEADERS.map((header) => {
      if (header === '账单日期') return '2026-06-30';
      if (header === '主体') return 'PPHK';
      if (header === '业务部门') return 'VCC';
      if (header === '币种') return sourceCurrency;
      if (header === '财务余额') return `${index + 1}.00`;
      return '';
    });
    return {
      sourceRow: index + 2,
      sourceCurrency,
      normalizedCurrency: currency,
      displayValues,
      rawValues: displayValues
    };
  });
  const balances = Object.fromEntries(SUPPORTED_CURRENCIES.map((currency, index) => [currency, String(index + 1)]));
  db.prepare(`
    INSERT INTO vcc_fin_op_system_snapshots (
      target_month, subject, balances_json, content_hash,
      source_file, sheet_name, source_row, raw_json, import_record_id
    ) VALUES ('2026-06', 'PPHK', ?, 'system-hash',
      'system.xlsx', '系统OP', 2, ?, ?)
  `).run(JSON.stringify(balances), JSON.stringify({
    displayHeaders: SYSTEM_OP_HEADERS,
    headerRow: 1,
    rows
  }), recordId);
}

function seedAllSources(db) {
  createEffectiveRecord(db, SOURCE_TYPES.RECHARGE, {
    订单号: '000001', BillDate: '2026-06-05', 业务部门: 'VCC', 对手部门: 'FX',
    业务子类型: '充值', 出入方向: 'in', 公司主体: 'PPHK', 我方币种: 'USD', 我方到账金额: '12.34'
  }, { subject: 'PPHK', statCurrency: 'USD', signedAmount: '12.34' }, { key: '000001' });
  createEffectiveRecord(db, SOURCE_TYPES.FEE_FX, {
    订单号: '000002', BillDate: '2026-06-06', 业务部门: 'VCC', 业务子类型: '费用',
    出入方向: 'out', 公司主体: 'PPHK', 我方币种: 'EUR', 我方到账金额: '3.21'
  }, { subject: 'PPHK', statCurrency: 'EUR', signedAmount: '-3.21' }, { key: '000002' });
  createEffectiveRecord(db, SOURCE_TYPES.CHANNEL, {
    渠道订单号: '000003', 账单日期: '2026-06-07', 部门: 'VCC', 通道名称: 'CITI', MID: 'MID-1',
    交易金额: '9.87', 交易币种: 'USD', 清算金额: '8.76', 清算币种: 'USD', 借贷方向: 'out',
    billdate: '2026-06-07', 结算币种: 'USD', 实际到账金额: '7.65'
  }, { subject: 'PPHK', statCurrency: 'USD', signedAmount: '-9.87' }, { key: '000003' });
  createEffectiveRecord(db, SOURCE_TYPES.PENDING, {
    PendingBizId: '000004', 主体: 'PPHK', 对账类型: 'VCC_clearing_debit', channel: 'CITI',
    金额: '5.00', 币种: 'USD', 流水_币种: 'HKD', 流水_对账金额: '6.00'
  }, {
    subject: 'PPHK', pendingAmount: '5', flowAmount: '-6', currencyMismatch: 1
  }, { key: '000004' });
  insertFormalSystemSnapshot(db);
}

async function readSheet(filePath) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(filePath);
  return { workbook, sheet: workbook.worksheets[0] };
}

test('五类校验原表和校验表按固定表头导出当前有效数据', async (t) => {
  const { db, dir } = openFixture(t);
  seedAllSources(db);
  for (const sourceType of Object.values(SOURCE_TYPES)) {
    for (const targetKind of Object.values(EXPORT_KINDS)) {
      const outputPath = path.join(dir, `${sourceType}-${targetKind}.xlsx`);
      const result = await writeDatasetWorkbook({ db, targetMonth: '2026-06', sourceType, targetKind, outputPath });
      assert.equal(result.dataCount, sourceType === SOURCE_TYPES.SYSTEM_OP ? 9 : 1);
      assert.equal(result.sheetCount, 1);
      const { sheet } = await readSheet(outputPath);
      const expectedHeaders = sourceType === SOURCE_TYPES.SYSTEM_OP
        ? [...SYSTEM_OP_HEADERS]
        : (targetKind === EXPORT_KINDS.RAW
          ? [...getSourceDefinition(sourceType).headers]
          : [
              ...CHECK_EXPORT_DEFINITIONS[sourceType].sourceHeaders,
              ...CHECK_EXPORT_DEFINITIONS[sourceType].derivedHeaders
            ]);
      assert.deepEqual(sheet.getRow(1).values.slice(1), expectedHeaders);
      assert.equal(sheet.rowCount, result.dataCount + 1);
      assert.equal(sheet.name, targetKind === EXPORT_KINDS.RAW
        ? SOURCE_LABELS[sourceType]
        : CHECK_EXPORT_DEFINITIONS[sourceType].label);
    }
  }

  const recharge = await readSheet(path.join(dir, `${SOURCE_TYPES.RECHARGE}-check.xlsx`));
  assert.equal(recharge.sheet.getCell('A2').value, '000001');
  assert.equal(recharge.sheet.getCell('J2').value, '12.34');
  const channel = await readSheet(path.join(dir, `${SOURCE_TYPES.CHANNEL}-check.xlsx`));
  assert.equal(channel.sheet.getCell('N2').value, 'PPHK');
  assert.equal(channel.sheet.getCell('O2').value, 'USD');
  assert.equal(channel.sheet.getCell('P2').value, '-9.87');
  const pending = await readSheet(path.join(dir, `${SOURCE_TYPES.PENDING}-check.xlsx`));
  assert.equal(pending.sheet.getCell('I2').value, '5');
  assert.equal(pending.sheet.getCell('J2').value, '-6');
  assert.equal(pending.sheet.getCell('K2').value, true);
  const system = await readSheet(path.join(dir, `${SOURCE_TYPES.SYSTEM_OP}-raw.xlsx`));
  assert.equal(system.sheet.getCell('D4').value, 'CNY');
});

test('数据行达到上限时自动续 sheet 且每张表重复原表头', async (t) => {
  const { db, dir } = openFixture(t);
  createEffectiveRecord(db, SOURCE_TYPES.RECHARGE, {
    订单号: 'A-1', BillDate: '2026-06-01', 公司主体: 'PPHK', 出入方向: 'in',
    我方币种: 'USD', 我方到账金额: '1'
  }, { subject: 'PPHK', statCurrency: 'USD', signedAmount: '1' }, { key: 'A-1' });
  createEffectiveRecord(db, SOURCE_TYPES.RECHARGE, {
    订单号: 'A-2', BillDate: '2026-06-02', 公司主体: 'PPHK', 出入方向: 'in',
    我方币种: 'USD', 我方到账金额: '2'
  }, { subject: 'PPHK', statCurrency: 'USD', signedAmount: '2' }, {
    key: 'A-2', batchSuffix: SOURCE_TYPES.RECHARGE
  });
  const outputPath = path.join(dir, 'split.xlsx');
  const result = await writeDatasetWorkbook({
    db,
    targetMonth: '2026-06',
    sourceType: SOURCE_TYPES.RECHARGE,
    targetKind: EXPORT_KINDS.RAW,
    outputPath,
    maxDataRowsPerSheet: 1
  });
  assert.equal(result.dataCount, 2);
  assert.equal(result.sheetCount, 2);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(outputPath);
  assert.equal(workbook.worksheets.length, 2);
  assert.deepEqual(workbook.worksheets.map((sheet) => sheet.rowCount), [2, 2]);
  assert.equal(workbook.worksheets[1].name.endsWith('-2'), true);
  assert.equal(workbook.worksheets[1].getCell('A2').value, null);
  const orderColumn = getSourceDefinition(SOURCE_TYPES.RECHARGE).indexes['订单号'] + 1;
  assert.equal(workbook.worksheets[1].getCell(2, orderColumn).value, 'A-2');
});

test('无数据、活动导入和损坏血缘均失败关闭，既有目标文件不被覆盖', async (t) => {
  const { db, dir } = openFixture(t);
  const empty = inspectDatasetExport(db, '2026-06', SOURCE_TYPES.RECHARGE, EXPORT_KINDS.RAW);
  assert.equal(empty.exportable, false);
  assert.equal(empty.code, 'no-data');
  createEffectiveRecord(db, SOURCE_TYPES.RECHARGE, {
    订单号: 'SAFE-1', BillDate: '2026-06-01', 公司主体: 'PPHK', 出入方向: 'in',
    我方币种: 'USD', 我方到账金额: '1'
  }, { subject: 'PPHK', statCurrency: 'USD', signedAmount: '1' }, { key: 'SAFE-1' });
  repository.createImportBatch(db, { id: 'active-export-block', targetMonth: '2026-07', fileCount: 1 });
  const active = inspectDatasetExport(db, '2026-06', SOURCE_TYPES.RECHARGE, EXPORT_KINDS.RAW);
  assert.equal(active.exportable, false);
  assert.equal(active.code, 'active-task');
  repository.finishImportBatch(db, 'active-export-block', 'failed');

  db.prepare(`UPDATE vcc_fin_op_effective_rows SET raw_json = '{}' WHERE idempotency_key = 'SAFE-1'`).run();
  const outputPath = path.join(dir, 'existing.xlsx');
  fs.writeFileSync(outputPath, 'previous-file');
  await assert.rejects(
    writeDatasetWorkbook({
      db,
      targetMonth: '2026-06',
      sourceType: SOURCE_TYPES.RECHARGE,
      targetKind: EXPORT_KINDS.RAW,
      outputPath
    }),
    (error) => error.code === 'invalid-export-lineage'
  );
  assert.equal(fs.readFileSync(outputPath, 'utf8'), 'previous-file');
  assert.deepEqual(fs.readdirSync(dir).sort(), ['existing.xlsx']);
});

test('系统九币种血缘重复或 Pending 错币标记非 0/1 时拒绝导出', async (t) => {
  const { db, dir } = openFixture(t);
  insertFormalSystemSnapshot(db);
  const snapshot = db.prepare(`
    SELECT id, raw_json FROM vcc_fin_op_system_snapshots WHERE target_month = '2026-06'
  `).get();
  const payload = JSON.parse(snapshot.raw_json);
  payload.rows[1].normalizedCurrency = payload.rows[0].normalizedCurrency;
  db.prepare('UPDATE vcc_fin_op_system_snapshots SET raw_json = ? WHERE id = ?')
    .run(JSON.stringify(payload), snapshot.id);
  assert.throws(
    () => inspectDatasetExport(db, '2026-06', SOURCE_TYPES.SYSTEM_OP, EXPORT_KINDS.RAW),
    (error) => error.code === 'invalid-export-lineage'
  );

  createEffectiveRecord(db, SOURCE_TYPES.PENDING, {
    PendingBizId: 'BAD-MISMATCH', 主体: 'PPHK', 对账类型: 'VCC_clearing_debit', channel: 'CITI',
    金额: '5.00', 币种: 'USD', 流水_币种: 'USD', 流水_对账金额: '5.00'
  }, {
    subject: 'PPHK', pendingAmount: '5', flowAmount: '-5', currencyMismatch: 1
  }, { key: 'BAD-MISMATCH' });
  db.prepare(`
    UPDATE vcc_fin_op_effective_rows SET currency_mismatch = 2
    WHERE source_type = ? AND idempotency_key = 'BAD-MISMATCH'
  `).run(SOURCE_TYPES.PENDING);
  const outputPath = path.join(dir, 'bad-pending.xlsx');
  await assert.rejects(
    writeDatasetWorkbook({
      db,
      targetMonth: '2026-06',
      sourceType: SOURCE_TYPES.PENDING,
      targetKind: EXPORT_KINDS.CHECK,
      outputPath
    }),
    (error) => error.code === 'invalid-export-lineage'
  );
  assert.equal(fs.existsSync(outputPath), false);
});
