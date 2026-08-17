'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const ExcelJS = require('exceljs');
const XLSX = require('xlsx');
const { DatabaseSync } = require('node:sqlite');
const { ensureVccFinancialOpTablesSupport } = require('../../../src/backend/vcc-financial-op-db/migrations');
const repository = require('../../../src/backend/vcc-financial-op-db/repository');
const {
  SOURCE_TYPES,
  SOURCE_LABELS,
  SUPPORTED_CURRENCIES,
  SYSTEM_OP_HEADERS,
  SYSTEM_OP_DEFINITION,
  getSourceDefinition
} = require('../../../src/backend/vcc-financial-op/definitions');
const { mapDetailRow } = require('../../../src/backend/vcc-financial-op/row-mapper');
const { hashSourceFile } = require('../../../src/backend/vcc-financial-op/source-lineage');
const {
  readSystemOpSnapshotCandidates,
  readSystemOpSnapshots
} = require('../../../src/backend/vcc-financial-op/system-op-importer');
const {
  buildVccStorageCandidate
} = require('../../../src/main-process/vcc-financial-op-storage-rebuild');
const {
  registerVccStorageWriteCapability
} = require('../../../src/backend/vcc-financial-op-db/storage-contract');
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
    const sourceCurrency = currency;
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

async function writeRechargeWorkbook(filePath, rows) {
  const definition = getSourceDefinition(SOURCE_TYPES.RECHARGE);
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Sheet1');
  sheet.addRow([...definition.headers]);
  for (const row of rows) sheet.addRow(sourceValues(SOURCE_TYPES.RECHARGE, row));
  await workbook.xlsx.writeFile(filePath);
}

function writeSystemOpWorkbook(filePath, options = {}) {
  const rows = SUPPORTED_CURRENCIES.map((currency, index) => {
    const values = {
      账单日期: '2026-06-30',
      主体: 'PPHK',
      业务部门: 'VCC',
      币种: currency,
      OP发生额: '0',
      '发生额（入）': '0',
      '发生额（出）': '0',
      本期移除Pending金额: '0',
      调账金额: '0',
      OP期末余额: '0',
      pending余额: '0',
      费用项: '0',
      财务余额: String(index + 1),
      主体变动发生额: '0',
      财务主体余额: String(index + 1),
      创建时间: '2026-07-01 09:00:00'
    };
    return SYSTEM_OP_HEADERS.map((header) => values[header] ?? '');
  });
  if (options.includeInvalidSubject === true) {
    const invalidValues = {
      账单日期: '2026-06-30',
      主体: 'PPUS',
      业务部门: 'OTHER',
      币种: 'CNY',
      财务余额: '20'
    };
    rows.push(SYSTEM_OP_HEADERS.map((header) => invalidValues[header] ?? ''));
  }
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.aoa_to_sheet([[...SYSTEM_OP_HEADERS], ...rows]),
    'System'
  );
  XLSX.writeFile(workbook, filePath);
}

async function openV2DetailFixture(t, entries) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vcc-dataset-v2-'));
  const sourcePath = path.join(dir, 'source.sqlite');
  const targetPath = path.join(dir, 'target.sqlite');
  const sourceDb = new DatabaseSync(sourcePath);
  sourceDb.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE app_settings (
      setting_key TEXT PRIMARY KEY,
      setting_value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
    );
  `);
  ensureVccFinancialOpTablesSupport(sourceDb);
  const archiveSources = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    const batchId = `v2-batch-${index + 1}`;
    repository.createImportBatch(sourceDb, { id: batchId, targetMonth: '2026-06', fileCount: 1 });
    const recordId = repository.createImportRecord(sourceDb, {
      batchId,
      targetMonth: '2026-06',
      sourceType: SOURCE_TYPES.RECHARGE,
      sourceFiles: [entry.fileName || `source-${index + 1}.xlsx`]
    });
    let sourceId = null;
    if (entry.withSource !== false) {
      const filePath = path.join(dir, entry.fileName || `source-${index + 1}.xlsx`);
      await writeRechargeWorkbook(filePath, [entry.archiveRow || entry.effectiveRow]);
      const hashed = await hashSourceFile(filePath);
      sourceId = repository.createImportSource(sourceDb, recordId, {
        sourceOrdinal: 1,
        fileName: path.basename(filePath),
        sha256: hashed.sha256,
        sizeBytes: hashed.sizeBytes
      });
      sourceDb.prepare(`
        UPDATE vcc_fin_op_import_sources
        SET archive_state = 'ready', archive_artifact_id = ?
        WHERE id = ?
      `).run(1000 + index, sourceId);
      archiveSources.push({
        sourceId,
        filePath,
        fileName: path.basename(filePath),
        sha256: hashed.sha256,
        sizeBytes: hashed.sizeBytes
      });
    }
    const values = sourceValues(SOURCE_TYPES.RECHARGE, entry.effectiveRow);
    const mapped = mapDetailRow({
      sourceType: SOURCE_TYPES.RECHARGE,
      values,
      targetMonth: '2026-06',
      assignedSubject: entry.effectiveRow['公司主体'],
      sourceFile: entry.fileName || `source-${index + 1}.xlsx`,
      sheetName: 'Sheet1',
      sourceRow: 2
    });
    assert.equal(mapped.disposition, null);
    sourceDb.prepare(`
      INSERT INTO vcc_fin_op_effective_rows (
        source_type, idempotency_key_raw, idempotency_key, content_hash,
        hash_version, raw_contract_version, target_month, subject,
        stat_currency, signed_amount, business_department, counterparty_department,
        business_sub_type, source_file, sheet_name, source_row, raw_json,
        import_record_id, import_source_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      mapped.sourceType,
      mapped.idempotencyKeyRaw,
      mapped.idempotencyKey,
      mapped.contentHash,
      mapped.hashVersion,
      mapped.rawContractVersion,
      mapped.targetMonth,
      mapped.subject,
      mapped.statCurrency,
      mapped.signedAmount,
      mapped.businessDepartment,
      mapped.counterpartyDepartment,
      mapped.businessSubType,
      mapped.sourceFile,
      mapped.sheetName,
      mapped.sourceRow,
      mapped.rawJson,
      recordId,
      sourceId
    );
    repository.finishImportRecord(sourceDb, recordId, {
      status: 'success', rawCount: 1, insertedCount: 1
    });
    repository.finishImportBatch(sourceDb, batchId, 'success');
  }
  sourceDb.close();
  buildVccStorageCandidate({
    sourcePath,
    targetPath,
    availableBytes: Number.MAX_SAFE_INTEGER
  });
  const db = new DatabaseSync(targetPath);
  db.exec('PRAGMA foreign_keys = ON');
  registerVccStorageWriteCapability(db);
  t.after(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { db, dir, archiveSources };
}

function rechargeRow(key, amount = '10.00') {
  return {
    订单号: key,
    BillDate: '2026-06-10',
    业务部门: 'VCC',
    对手部门: 'FX',
    业务子类型: '充值',
    出入方向: 'in',
    公司主体: 'PPHK',
    我方币种: 'USD',
    我方到账金额: amount
  };
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

test('系统财务OP原表和校验表仅以 balances_json 覆盖财务余额显示值', async (t) => {
  const { db, dir } = openFixture(t);
  insertFormalSystemSnapshot(db);
  const snapshot = db.prepare(`
    SELECT id, balances_json, raw_json
    FROM vcc_fin_op_system_snapshots
    WHERE target_month = '2026-06'
  `).get();
  const balances = JSON.parse(snapshot.balances_json);
  const payload = JSON.parse(snapshot.raw_json);
  const jpy = payload.rows.find((row) => row.normalizedCurrency === 'JPY');
  const balanceIndex = SYSTEM_OP_DEFINITION.indexes[SYSTEM_OP_DEFINITION.balanceHeader];
  const endingBalanceIndex = SYSTEM_OP_DEFINITION.indexes['OP期末余额'];
  balances.JPY = '135886024.59';
  jpy.displayValues[balanceIndex] = '135886024.6';
  jpy.displayValues[endingBalanceIndex] = '保留显示值';
  jpy.balanceEvidence = {
    field: '财务余额',
    cell: 'M8',
    source: 'raw-numeric',
    rawValue: 135886024.59,
    displayValue: '135886024.6',
    canonicalValue: '135886024.59',
    auditCode: 'amount-display-raw-mismatch'
  };
  db.prepare(`
    UPDATE vcc_fin_op_system_snapshots
    SET balances_json = ?, raw_json = ?
    WHERE id = ?
  `).run(JSON.stringify(balances), JSON.stringify(payload), snapshot.id);

  for (const targetKind of Object.values(EXPORT_KINDS)) {
    const outputPath = path.join(dir, `system-canonical-${targetKind}.xlsx`);
    await writeDatasetWorkbook({
      db,
      targetMonth: '2026-06',
      sourceType: SOURCE_TYPES.SYSTEM_OP,
      targetKind,
      outputPath
    });
    const { sheet } = await readSheet(outputPath);
    const currencyColumn = SYSTEM_OP_DEFINITION.indexes[SYSTEM_OP_DEFINITION.currencyHeader] + 1;
    const balanceColumn = balanceIndex + 1;
    const endingBalanceColumn = endingBalanceIndex + 1;
    const jpyRow = sheet.getColumn(currencyColumn).values.findIndex((value) => value === 'JPY');
    assert.equal(jpyRow > 1, true);
    assert.equal(sheet.getCell(jpyRow, balanceColumn).value, '135886024.59');
    assert.equal(sheet.getCell(jpyRow, endingBalanceColumn).value, '保留显示值');
    for (const currency of SUPPORTED_CURRENCIES) {
      const rowNumber = sheet.getColumn(currencyColumn).values
        .findIndex((value) => value === currency);
      assert.equal(rowNumber > 1, true);
      assert.equal(sheet.getCell(rowNumber, balanceColumn).value, balances[currency]);
    }
  }
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

test('系统财务OP canonical 余额缺失、重复、非法或与读取证据不一致时失败关闭', (t) => {
  const { db } = openFixture(t);
  insertFormalSystemSnapshot(db);
  const snapshot = db.prepare(`
    SELECT id, balances_json, raw_json
    FROM vcc_fin_op_system_snapshots
    WHERE target_month = '2026-06'
  `).get();
  const originalBalances = JSON.parse(snapshot.balances_json);
  const originalPayload = JSON.parse(snapshot.raw_json);
  const assertInvalid = (balancesJson, rawJson = JSON.stringify(originalPayload)) => {
    db.prepare(`
      UPDATE vcc_fin_op_system_snapshots
      SET balances_json = ?, raw_json = ?
      WHERE id = ?
    `).run(balancesJson, rawJson, snapshot.id);
    assert.throws(
      () => inspectDatasetExport(db, '2026-06', SOURCE_TYPES.SYSTEM_OP, EXPORT_KINDS.RAW),
      (error) => error.code === 'invalid-export-lineage'
    );
  };

  assertInvalid('');
  assertInvalid('[]');

  const missingCurrency = { ...originalBalances };
  delete missingCurrency.USD;
  assertInvalid(JSON.stringify(missingCurrency));

  const duplicateCurrency = `{${SUPPORTED_CURRENCIES.map((currency) => (
    `${JSON.stringify(currency)}:${JSON.stringify(originalBalances[currency])}`
  )).join(',')},"AUD":"999"}`;
  assertInvalid(duplicateCurrency);

  assertInvalid(JSON.stringify({ ...originalBalances, JPY: '1.234' }));

  const mismatchedEvidence = structuredClone(originalPayload);
  mismatchedEvidence.rows.find((row) => row.normalizedCurrency === 'JPY').balanceEvidence = {
    canonicalValue: '999.99'
  };
  assertInvalid(JSON.stringify(originalBalances), JSON.stringify(mismatchedEvidence));
});

test('v2 校验原表从已核验 artifact 重建当前有效行', async (t) => {
  const fixture = await openV2DetailFixture(t, [{ effectiveRow: rechargeRow('000123') }]);
  const preview = inspectDatasetExport(
    fixture.db,
    '2026-06',
    SOURCE_TYPES.RECHARGE,
    EXPORT_KINDS.RAW
  );
  assert.deepEqual({
    totalRows: preview.totalRows,
    exportableRows: preview.exportableRows,
    missingRows: preview.missingRows,
    incomplete: preview.incomplete
  }, { totalRows: 1, exportableRows: 1, missingRows: 0, incomplete: false });
  const outputPath = path.join(fixture.dir, 'reconstructed.xlsx');
  const result = await writeDatasetWorkbook({
    db: fixture.db,
    targetMonth: '2026-06',
    sourceType: SOURCE_TYPES.RECHARGE,
    targetKind: EXPORT_KINDS.RAW,
    outputPath,
    archiveSources: fixture.archiveSources
  });
  assert.equal(result.dataCount, 1);
  assert.equal(result.incomplete, false);
  const { workbook, sheet } = await readSheet(outputPath);
  assert.equal(workbook.worksheets.length, 1);
  assert.equal(sheet.getCell(2, getSourceDefinition(SOURCE_TYPES.RECHARGE).indexes['订单号'] + 1).value, '000123');
});

test('v2 历史血缘缺口生成不完整说明；零覆盖只生成说明 sheet', async (t) => {
  const partial = await openV2DetailFixture(t, [
    { effectiveRow: rechargeRow('COVERED-1') },
    { effectiveRow: rechargeRow('MISSING-1'), withSource: false }
  ]);
  const partialPreview = inspectDatasetExport(
    partial.db,
    '2026-06',
    SOURCE_TYPES.RECHARGE,
    EXPORT_KINDS.RAW
  );
  assert.equal(partialPreview.exportable, true);
  assert.deepEqual([
    partialPreview.totalRows,
    partialPreview.exportableRows,
    partialPreview.missingRows,
    partialPreview.incomplete
  ], [2, 1, 1, true]);
  assert.deepEqual(partialPreview.missingByImportRecord.map((row) => row.missingRows), [1]);
  const partialPath = path.join(partial.dir, 'partial.xlsx');
  const partialResult = await writeDatasetWorkbook({
    db: partial.db,
    targetMonth: '2026-06',
    sourceType: SOURCE_TYPES.RECHARGE,
    targetKind: EXPORT_KINDS.RAW,
    outputPath: partialPath,
    archiveSources: partial.archiveSources
  });
  assert.equal(partialResult.sheetCount, 2);
  const partialBook = new ExcelJS.Workbook();
  await partialBook.xlsx.readFile(partialPath);
  assert.deepEqual(partialBook.worksheets.map((sheet) => sheet.name), ['导出说明', SOURCE_LABELS[SOURCE_TYPES.RECHARGE]]);
  assert.equal(partialBook.worksheets[0].getCell('B3').value, 2);
  assert.equal(partialBook.worksheets[0].getCell('B4').value, 1);
  assert.equal(partialBook.worksheets[0].getCell('B5').value, 1);

  const zero = await openV2DetailFixture(t, [
    { effectiveRow: rechargeRow('MISSING-ALL'), withSource: false }
  ]);
  const zeroPreview = inspectDatasetExport(
    zero.db,
    '2026-06',
    SOURCE_TYPES.RECHARGE,
    EXPORT_KINDS.RAW
  );
  assert.equal(zeroPreview.exportable, true);
  assert.deepEqual([
    zeroPreview.totalRows,
    zeroPreview.exportableRows,
    zeroPreview.missingRows,
    zeroPreview.incomplete
  ], [1, 0, 1, true]);
  const zeroPath = path.join(zero.dir, 'zero.xlsx');
  const zeroResult = await writeDatasetWorkbook({
    db: zero.db,
    targetMonth: '2026-06',
    sourceType: SOURCE_TYPES.RECHARGE,
    targetKind: EXPORT_KINDS.RAW,
    outputPath: zeroPath,
    archiveSources: []
  });
  assert.deepEqual({ dataCount: zeroResult.dataCount, sheetCount: zeroResult.sheetCount }, {
    dataCount: 0,
    sheetCount: 1
  });
  const zeroBook = new ExcelJS.Workbook();
  await zeroBook.xlsx.readFile(zeroPath);
  assert.deepEqual(zeroBook.worksheets.map((sheet) => sheet.name), ['导出说明']);
});

test('v2 artifact SHA 或定位行内容不一致时整次失败且不覆盖目标', async (t) => {
  const corrupted = await openV2DetailFixture(t, [{ effectiveRow: rechargeRow('SHA-1') }]);
  fs.appendFileSync(corrupted.archiveSources[0].filePath, 'corrupt');
  const shaOutput = path.join(corrupted.dir, 'sha-output.xlsx');
  fs.writeFileSync(shaOutput, 'keep-sha');
  await assert.rejects(writeDatasetWorkbook({
    db: corrupted.db,
    targetMonth: '2026-06',
    sourceType: SOURCE_TYPES.RECHARGE,
    targetKind: EXPORT_KINDS.RAW,
    outputPath: shaOutput,
    archiveSources: corrupted.archiveSources
  }), (error) => error.code === 'archive-integrity-failure');
  assert.equal(fs.readFileSync(shaOutput, 'utf8'), 'keep-sha');

  const mismatched = await openV2DetailFixture(t, [{
    effectiveRow: rechargeRow('EXPECTED-1', '10.00'),
    archiveRow: rechargeRow('DIFFERENT-1', '11.00')
  }]);
  const rowOutput = path.join(mismatched.dir, 'row-output.xlsx');
  fs.writeFileSync(rowOutput, 'keep-row');
  await assert.rejects(writeDatasetWorkbook({
    db: mismatched.db,
    targetMonth: '2026-06',
    sourceType: SOURCE_TYPES.RECHARGE,
    targetKind: EXPORT_KINDS.RAW,
    outputPath: rowOutput,
    archiveSources: mismatched.archiveSources
  }), (error) => error.code === 'archive-row-integrity-failure');
  assert.equal(fs.readFileSync(rowOutput, 'utf8'), 'keep-row');
});

test('已绑定 artifact 后续失败不得降级为历史部分导出', async (t) => {
  const fixture = await openV2DetailFixture(t, [{ effectiveRow: rechargeRow('BOUND-FAILED') }]);
  fixture.db.prepare(`
    UPDATE vcc_fin_op_import_sources
    SET archive_state = 'failed', last_error_code = 'archive-blob-invalid'
  `).run();
  const preview = inspectDatasetExport(
    fixture.db,
    '2026-06',
    SOURCE_TYPES.RECHARGE,
    EXPORT_KINDS.RAW
  );
  assert.equal(preview.exportable, false);
  assert.equal(preview.code, 'archive-integrity-failure');
  assert.equal(preview.incomplete, false);
  const outputPath = path.join(fixture.dir, 'must-not-be-partial.xlsx');
  await assert.rejects(
    writeDatasetWorkbook({
      db: fixture.db,
      targetMonth: '2026-06',
      sourceType: SOURCE_TYPES.RECHARGE,
      targetKind: EXPORT_KINDS.RAW,
      outputPath
    }),
    (error) => error.code === 'archive-integrity-failure'
  );
  assert.equal(fs.existsSync(outputPath), false);
});

test('v1 detail 与 SYSTEM_OP 一旦有 source/artifact 绑定，failed artifact 均不得借 raw_json 降级', (t) => {
  const { db } = openFixture(t);
  createEffectiveRecord(db, SOURCE_TYPES.RECHARGE, rechargeRow('V1-BOUND-FAILED'), {
    subject: 'PPHK', statCurrency: 'USD', signedAmount: '10'
  }, { key: 'V1-BOUND-FAILED', batchSuffix: 'v1-bound-failed' });
  const detailRecord = db.prepare(`
    SELECT id FROM vcc_fin_op_import_records
    WHERE batch_id = 'batch-v1-bound-failed'
  `).get();
  const detailSourceId = repository.createImportSource(db, detailRecord.id, {
    sourceOrdinal: 1,
    fileName: 'v1-bound.xlsx',
    sha256: 'd'.repeat(64),
    sizeBytes: 123
  });
  db.prepare(`
    UPDATE vcc_fin_op_import_sources
    SET archive_state = 'failed', archive_artifact_id = 701
    WHERE id = ?
  `).run(detailSourceId);
  db.prepare(`
    UPDATE vcc_fin_op_effective_rows SET import_source_id = ?
    WHERE import_record_id = ?
  `).run(detailSourceId, detailRecord.id);

  insertFormalSystemSnapshot(db);
  const systemRecord = db.prepare(`
    SELECT id FROM vcc_fin_op_import_records WHERE batch_id = 'batch-system'
  `).get();
  const systemSourceId = repository.createImportSource(db, systemRecord.id, {
    sourceOrdinal: 1,
    fileName: 'system.xlsx',
    sha256: 'e'.repeat(64),
    sizeBytes: 456
  });
  db.prepare(`
    UPDATE vcc_fin_op_import_sources
    SET archive_state = 'failed', archive_artifact_id = 702
    WHERE id = ?
  `).run(systemSourceId);
  db.prepare(`
    UPDATE vcc_fin_op_system_snapshots SET import_source_id = ?
    WHERE import_record_id = ?
  `).run(systemSourceId, systemRecord.id);

  for (const sourceType of [SOURCE_TYPES.RECHARGE, SOURCE_TYPES.SYSTEM_OP]) {
    const preview = inspectDatasetExport(db, '2026-06', sourceType, EXPORT_KINDS.RAW);
    assert.equal(preview.exportable, false, sourceType);
    assert.equal(preview.code, 'archive-integrity-failure', sourceType);
    assert.equal(preview.incomplete, false, sourceType);
  }
});

test('SYSTEM_OP 新导入待存档或存档失败时从临时 raw fallback 完整导出', async (t) => {
  const { db, dir } = openFixture(t);
  insertFormalSystemSnapshot(db);
  const record = db.prepare(`
    SELECT id FROM vcc_fin_op_import_records WHERE batch_id = 'batch-system'
  `).get();
  const sourceId = repository.createImportSource(db, record.id, {
    sourceOrdinal: 1,
    fileName: 'system-pending.xlsx',
    sha256: 'a'.repeat(64),
    sizeBytes: 1024
  });
  db.prepare(`
    UPDATE vcc_fin_op_system_snapshots SET import_source_id = ?
    WHERE import_record_id = ?
  `).run(sourceId, record.id);

  for (const archiveState of ['pending', 'failed']) {
    db.prepare(`
      UPDATE vcc_fin_op_import_sources
      SET archive_state = ?, archive_artifact_id = NULL, bound_at = NULL
      WHERE id = ?
    `).run(archiveState, sourceId);
    const preview = inspectDatasetExport(
      db,
      '2026-06',
      SOURCE_TYPES.SYSTEM_OP,
      EXPORT_KINDS.RAW
    );
    assert.deepEqual({
      totalRows: preview.totalRows,
      exportableRows: preview.exportableRows,
      missingRows: preview.missingRows,
      incomplete: preview.incomplete
    }, {
      totalRows: SUPPORTED_CURRENCIES.length,
      exportableRows: SUPPORTED_CURRENCIES.length,
      missingRows: 0,
      incomplete: false
    });

    const outputPath = path.join(dir, `system-${archiveState}-fallback.xlsx`);
    const result = await writeDatasetWorkbook({
      db,
      targetMonth: '2026-06',
      sourceType: SOURCE_TYPES.SYSTEM_OP,
      targetKind: EXPORT_KINDS.RAW,
      outputPath,
      archiveSources: []
    });
    assert.equal(result.dataCount, SUPPORTED_CURRENCIES.length);
    const { sheet } = await readSheet(outputPath);
    assert.equal(sheet.rowCount, SUPPORTED_CURRENCIES.length + 1);
    assert.equal(sheet.getCell(2, SYSTEM_OP_DEFINITION.indexes['主体'] + 1).value, 'PPHK');
  }
});

test('SYSTEM_OP 绑定 ready artifact 后从核验文件重建，损坏文件整次失败', async (t) => {
  const { db, dir } = openFixture(t);
  const sourcePath = path.join(dir, 'bound-system.xlsx');
  writeSystemOpWorkbook(sourcePath);
  const [snapshot] = readSystemOpSnapshots(sourcePath, '2026-06');
  const hashed = await hashSourceFile(sourcePath);
  // ArchiveService.resolveVerifiedArtifact 返回的是哈希命名 canonical blob，
  // 而不是导入时原文件名；文件身份由 source 绑定 + SHA/size 证明。
  const archiveBlobPath = path.join(dir, hashed.sha256);
  fs.copyFileSync(sourcePath, archiveBlobPath);
  repository.createImportBatch(db, {
    id: 'bound-system-artifact', targetMonth: '2026-06', fileCount: 1
  });
  const recordId = repository.createImportRecord(db, {
    batchId: 'bound-system-artifact',
    targetMonth: '2026-06',
    sourceType: SOURCE_TYPES.SYSTEM_OP,
    sourceFiles: [path.basename(sourcePath)]
  });
  const sourceId = repository.createImportSource(db, recordId, {
    sourceOrdinal: 1,
    fileName: path.basename(sourcePath),
    sha256: hashed.sha256,
    sizeBytes: hashed.sizeBytes
  });
  db.prepare(`
    UPDATE vcc_fin_op_import_sources
    SET archive_state = 'ready', archive_artifact_id = 801
    WHERE id = ?
  `).run(sourceId);
  db.prepare(`
    INSERT INTO vcc_fin_op_system_snapshots (
      target_month, subject, balances_json, content_hash, import_source_id,
      source_file, sheet_name, source_row, raw_json, import_record_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, '{}', ?)
  `).run(
    snapshot.targetMonth,
    snapshot.subject,
    snapshot.balancesJson,
    snapshot.contentHash,
    sourceId,
    snapshot.sourceFile,
    snapshot.sheetName,
    snapshot.sourceRow,
    recordId
  );
  repository.finishImportRecord(db, recordId, {
    status: 'success', rawCount: 1, insertedCount: 1
  });
  repository.finishImportBatch(db, 'bound-system-artifact', 'success');
  const archiveSources = [{
    sourceId,
    filePath: archiveBlobPath,
    fileName: path.basename(sourcePath),
    sha256: hashed.sha256,
    sizeBytes: hashed.sizeBytes
  }];

  const outputPath = path.join(dir, 'bound-system-output.xlsx');
  const result = await writeDatasetWorkbook({
    db,
    targetMonth: '2026-06',
    sourceType: SOURCE_TYPES.SYSTEM_OP,
    targetKind: EXPORT_KINDS.RAW,
    outputPath,
    archiveSources
  });
  assert.equal(result.dataCount, SUPPORTED_CURRENCIES.length);
  const { sheet } = await readSheet(outputPath);
  assert.equal(sheet.getCell(2, SYSTEM_OP_DEFINITION.indexes['主体'] + 1).value, 'PPHK');

  fs.appendFileSync(archiveBlobPath, 'corrupt');
  const protectedPath = path.join(dir, 'bound-system-corrupt.xlsx');
  fs.writeFileSync(protectedPath, 'keep');
  await assert.rejects(writeDatasetWorkbook({
    db,
    targetMonth: '2026-06',
    sourceType: SOURCE_TYPES.SYSTEM_OP,
    targetKind: EXPORT_KINDS.RAW,
    outputPath: protectedPath,
    archiveSources
  }), (error) => error.code === 'archive-integrity-failure');
  assert.equal(fs.readFileSync(protectedPath, 'utf8'), 'keep');
});

test('SYSTEM_OP success_with_skips 绑定 artifact 后仍导出已提交的有效主体', async (t) => {
  const { db, dir } = openFixture(t);
  const sourcePath = path.join(dir, 'system-with-invalid-subject.xlsx');
  writeSystemOpWorkbook(sourcePath, { includeInvalidSubject: true });
  const candidates = readSystemOpSnapshotCandidates(sourcePath, '2026-06');
  assert.equal(candidates.snapshots.length, 1);
  assert.equal(candidates.snapshots[0].subject, 'PPHK');
  assert.equal(candidates.validationErrors.length, 1);
  const snapshot = candidates.snapshots[0];
  const hashed = await hashSourceFile(sourcePath);
  const archiveBlobPath = path.join(dir, hashed.sha256);
  fs.copyFileSync(sourcePath, archiveBlobPath);

  repository.createImportBatch(db, {
    id: 'bound-system-with-skips', targetMonth: '2026-06', fileCount: 1
  });
  const recordId = repository.createImportRecord(db, {
    batchId: 'bound-system-with-skips',
    targetMonth: '2026-06',
    sourceType: SOURCE_TYPES.SYSTEM_OP,
    sourceFiles: [path.basename(sourcePath)]
  });
  const sourceId = repository.createImportSource(db, recordId, {
    sourceOrdinal: 1,
    fileName: path.basename(sourcePath),
    sha256: hashed.sha256,
    sizeBytes: hashed.sizeBytes
  });
  db.prepare(`
    UPDATE vcc_fin_op_import_sources
    SET archive_state = 'ready', archive_artifact_id = 802
    WHERE id = ?
  `).run(sourceId);
  db.prepare(`
    INSERT INTO vcc_fin_op_system_snapshots (
      target_month, subject, balances_json, content_hash, import_source_id,
      source_file, sheet_name, source_row, raw_json, import_record_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, '{}', ?)
  `).run(
    snapshot.targetMonth,
    snapshot.subject,
    snapshot.balancesJson,
    snapshot.contentHash,
    sourceId,
    snapshot.sourceFile,
    snapshot.sheetName,
    snapshot.sourceRow,
    recordId
  );
  repository.finishImportRecord(db, recordId, {
    status: 'success_with_skips', rawCount: 2, insertedCount: 1, formatErrorCount: 1
  });
  repository.finishImportBatch(db, 'bound-system-with-skips', 'completed_with_errors');

  const outputPath = path.join(dir, 'bound-system-with-skips-output.xlsx');
  const result = await writeDatasetWorkbook({
    db,
    targetMonth: '2026-06',
    sourceType: SOURCE_TYPES.SYSTEM_OP,
    targetKind: EXPORT_KINDS.RAW,
    outputPath,
    archiveSources: [{
      sourceId,
      filePath: archiveBlobPath,
      fileName: path.basename(sourcePath),
      sha256: hashed.sha256,
      sizeBytes: hashed.sizeBytes
    }]
  });
  assert.equal(result.dataCount, SUPPORTED_CURRENCIES.length);
  const { sheet } = await readSheet(outputPath);
  assert.equal(sheet.rowCount, SUPPORTED_CURRENCIES.length + 1);
  assert.equal(sheet.getCell(2, SYSTEM_OP_DEFINITION.indexes['主体'] + 1).value, 'PPHK');
});

test('二次确认后的覆盖范围变化必须在写文件前失败', async (t) => {
  const fixture = await openV2DetailFixture(t, [{ effectiveRow: rechargeRow('CONFIRMED-1') }]);
  const expectedInspection = inspectDatasetExport(
    fixture.db,
    '2026-06',
    SOURCE_TYPES.RECHARGE,
    EXPORT_KINDS.RAW
  );
  assert.equal(expectedInspection.incomplete, false);
  fixture.db.prepare(`
    UPDATE vcc_fin_op_import_sources
    SET archive_state = 'pending', archive_artifact_id = NULL
  `).run();
  const outputPath = path.join(fixture.dir, 'stale-confirmation.xlsx');
  await assert.rejects(
    writeDatasetWorkbook({
      db: fixture.db,
      targetMonth: '2026-06',
      sourceType: SOURCE_TYPES.RECHARGE,
      targetKind: EXPORT_KINDS.RAW,
      outputPath,
      expectedInspection
    }),
    (error) => error.code === 'export-preview-state-changed'
  );
  assert.equal(fs.existsSync(outputPath), false);
});
