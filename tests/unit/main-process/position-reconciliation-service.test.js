'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const XLSX = require('xlsx');

const {
  createPositionReconciliationService,
  assertEngineResultSet
} = require('../../../src/main-process/position-reconciliation/service');
const {
  requirePositionPendingArchiveFiles
} = require('../../../src/main-process/position-reconciliation/operation-lifecycle');
const {
  STAGING_RELATIVE_PATH,
  filterStagingPathsWithoutProtectedSources,
  pruneStagingRoot
} = require('../../../src/main-process/position-reconciliation/input-staging');
const {
  BANK_SHEET_NAME,
  POSITION_DB_RELATIVE_PATH,
  POSITION_BANK_HEADERS,
  SOURCE_DEFINITIONS,
  SOURCE_TYPES,
  SOURCE_DISPLAY_ORDER
} = require('../../../src/main-process/position-reconciliation/constants');
const {
  BANK_STATEMENT_FIELDS
} = require('../../../src/constants/bank-statement-fields');

const ROOT = path.resolve(__dirname, '../../..');
const TEMPLATE_PATH = path.join(ROOT, 'assets', '平盘银行对账单.xlsx');

function writeWorkbook(filePath, sheetName, headers, rows) {
  const workbook = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet([
    headers,
    ...rows.map((row) => headers.map((header) => row[header] ?? ''))
  ]);
  XLSX.utils.book_append_sheet(workbook, sheet, sheetName);
  XLSX.writeFile(workbook, filePath);
}

function bankRow(overrides = {}) {
  return {
    BizId: 'POSITION-BIZ-1',
    BillDate: '2026-07-20',
    Channel: 'DBS',
    地区: 'HK',
    MerchantId: 'M001',
    Currency: 'USD',
    'Credit Amount': '100',
    'Debit Amount': '0',
    ReconciliationId: 'RID-1',
    FundType: 'Inbound&FX',
    ...overrides
  };
}

function inboundRow(overrides = {}) {
  return {
    bizId: 'INBOUND-1',
    billDate: '2026-07-20',
    tradeType: 'Inbound-VA',
    reconId: 'RID-1',
    channel: 'DBS',
    merchantId: 'M001',
    currency: 'USD',
    amount: '100',
    originOutboundCurrency: 'USD',
    ...overrides
  };
}

function transferRow(overrides = {}) {
  return {
    调拨单号: 'TRANSFER-1',
    调拨状态: '付款成功',
    渠道流水号: 'TRANSFER-RID-1',
    交易时间: '2026-06-20',
    '付款账户（卡号）': 'PAY-001',
    '收款账户（卡号）': 'RECEIVE-001',
    付款金额: '100',
    付款币种: 'USD',
    收款金额: '95',
    收款币种: 'EUR',
    ...overrides
  };
}

test('链接管理和原始表始终按业务规定顺序返回', (t) => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'position-source-order-contract-'));
  const service = createPositionReconciliationService({
    userDataDir,
    templatePath: TEMPLATE_PATH
  });
  t.after(() => {
    service.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  });

  const manager = service.linkedManager();
  assert.deepEqual(manager.linked.map((row) => row.sourceType), [...SOURCE_DISPLAY_ORDER]);
  assert.deepEqual(manager.raw.map((row) => row.sourceType), [...SOURCE_DISPLAY_ORDER]);
});

test('平盘 service 完成导入、隐藏非FX证据、运行、导出、回导和确认', async (t) => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'position-service-'));
  const bankPath = path.join(userDataDir, 'bank.xlsx');
  const sourcePath = path.join(userDataDir, 'inbound.xlsx');
  const outputPath = path.join(userDataDir, 'result.xlsx');
  const differenceOutputPath = path.join(userDataDir, 'differences.xlsx');
  writeWorkbook(bankPath, BANK_SHEET_NAME, BANK_STATEMENT_FIELDS, [bankRow()]);
  writeWorkbook(
    sourcePath,
    '账单明细',
    SOURCE_DEFINITIONS[SOURCE_TYPES.GATEWAY_INBOUND].headers,
    [inboundRow()]
  );

  const service = createPositionReconciliationService({
    userDataDir,
    templatePath: TEMPLATE_PATH
  });
  t.after(() => {
    service.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  });

  const bankPrepared = service.prepareBankImport([bankPath]);
  const bankApplied = service.applyBankImport(bankPrepared.token);
  assert.equal(bankApplied.rowCount, 1);

  const sourceApplied = service.prepareSourceImport([sourcePath]);
  assert.equal(sourceApplied.successCount, 1);
  const inboundSummary = service.linkedManager().linked.find(
    (row) => row.sourceType === SOURCE_TYPES.GATEWAY_INBOUND
  );
  assert.equal(inboundSummary.rowCount, 0, '非FX证据不应出现在管理页可见链接表');
  assert.match(inboundSummary.updatedAt, /^\d{4}-\d{2}-\d{2}/, '派生为0行仍应记录表库更新日期');

  const run = service.run({ channels: ['DBS'], months: ['2026-07'] });
  assert.equal(run.status, 'ok');
  assert.equal(run.summary.changedRows, 1);
  assert.equal(run.summary.differenceRows, 0);

  await service.exportRun(run.runId, outputPath);
  const exported = XLSX.readFile(outputPath, { raw: true });
  const rows = XLSX.utils.sheet_to_json(exported.Sheets[BANK_SHEET_NAME], {
    header: 1,
    defval: ''
  });
  assert.deepEqual(rows[0], POSITION_BANK_HEADERS);
  assert.equal(rows[1][POSITION_BANK_HEADERS.indexOf('FundType')], 'Inbound');

  rows[1][POSITION_BANK_HEADERS.indexOf('Payee Name')] = ' ';
  const tampered = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(tampered, XLSX.utils.aoa_to_sheet(rows), BANK_SHEET_NAME);
  XLSX.writeFile(tampered, outputPath);
  assert.throws(
    () => service.importRunResult(run.runId, outputPath),
    (error) => error && error.code === 'position-result-field-tampered'
  );
  rows[1][POSITION_BANK_HEADERS.indexOf('Payee Name')] = '';
  rows[1][POSITION_BANK_HEADERS.indexOf('FundType')] = 'Inbound&FX';
  rows[1][POSITION_BANK_HEADERS.indexOf('匹配命中详情')] = '人工确认应保留FX';
  const edited = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(edited, XLSX.utils.aoa_to_sheet(rows), BANK_SHEET_NAME);
  XLSX.writeFile(edited, outputPath);
  const reimported = service.importRunResult(run.runId, outputPath);
  assert.equal(reimported.modifiedCount, 1);
  assert.equal(service.dataManager().differences[0].status, '待确认');
  const reimportedRun = service.store.getRun(run.runId);
  assert.equal(reimportedRun.summary.changedRows, 0);
  assert.equal(reimportedRun.summary.differenceRows, 1);
  assert.equal(reimportedRun.summary.manualModifiedRows, 1);
  assert.equal(service.store.listRunRows(run.runId)[0].outcome, 'difference');

  const confirmed = service.confirmRun(run.runId);
  assert.equal(confirmed.confirmedRows, 1);
  assert.equal(
    service.store.db.prepare(
      'SELECT COUNT(*) AS count FROM position_consumed_sources WHERE bank_biz_id = ?'
    ).get('POSITION-BIZ-1').count,
    1,
    '人工回导保留原匹配关系时仍必须消费对应链接记录'
  );
  const saved = service.store.getBankRows()[0];
  assert.equal(saved.status, '已校验性质');
  assert.equal(saved.workingRow.FundType, 'Inbound&FX');
  assert.equal(saved.originalRow.FundType, 'Inbound&FX');
  assert.equal(saved.hit_summary, '', '回导改回原值时不得留下“原值 → 原值”审计');
  const differences = service.dataManager().differences;
  assert.equal(differences.length, 1);
  assert.equal(differences[0].status, '人工修改后确认');
  const differenceExport = await service.exportRun(
    run.runId,
    differenceOutputPath,
    { differencesOnly: true }
  );
  assert.equal(differenceExport.rowCount, 1);
  assert.equal(fs.existsSync(differenceOutputPath), true);
});

test('结果文件发布后导出状态落库失败时保留已发布文件', async (t) => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'position-export-state-failure-'));
  const bankPath = path.join(userDataDir, 'bank.xlsx');
  const outputPath = path.join(userDataDir, 'result.xlsx');
  writeWorkbook(
    bankPath,
    BANK_SHEET_NAME,
    BANK_STATEMENT_FIELDS,
    [bankRow({ FundType: 'Charge' })]
  );
  const service = createPositionReconciliationService({
    userDataDir,
    templatePath: TEMPLATE_PATH
  });
  t.after(() => {
    service.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  });

  service.applyBankImport(service.prepareBankImport([bankPath]).token);
  const run = service.run({ channels: ['DBS'], months: ['2026-07'] });
  service.store.markRunExported = () => {
    throw new Error('injected markRunExported failure');
  };

  await assert.rejects(
    service.exportRun(run.runId, outputPath),
    /injected markRunExported failure/
  );
  assert.equal(fs.existsSync(outputPath), true);
  assert.equal(service.store.getRun(run.runId).exported_at, null);
});

test('差异页隐藏失效和被替换草稿，并保留当前草稿批次', (t) => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'position-difference-lifecycle-'));
  const bankPath = path.join(userDataDir, 'bank.xlsx');
  const sourcePath = path.join(userDataDir, 'inbound.xlsx');
  const sourceRefreshPath = path.join(userDataDir, 'inbound-refresh.xlsx');
  writeWorkbook(bankPath, BANK_SHEET_NAME, BANK_STATEMENT_FIELDS, [bankRow()]);
  writeWorkbook(
    sourcePath,
    '账单明细',
    SOURCE_DEFINITIONS[SOURCE_TYPES.GATEWAY_INBOUND].headers,
    [inboundRow({ reconId: 'OTHER-RID' })]
  );
  writeWorkbook(
    sourceRefreshPath,
    '账单明细',
    SOURCE_DEFINITIONS[SOURCE_TYPES.GATEWAY_INBOUND].headers,
    [inboundRow({ reconId: 'OTHER-RID', finishTime: '2026-07-20 12:00:00' })]
  );
  const service = createPositionReconciliationService({
    userDataDir,
    templatePath: TEMPLATE_PATH
  });
  t.after(() => {
    service.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  });

  service.applyBankImport(service.prepareBankImport([bankPath]).token);
  assert.equal(service.prepareSourceImport([sourcePath]).successCount, 1);
  const firstRun = service.run({ channels: ['DBS'], months: ['2026-07'] });
  assert.equal(firstRun.summary.differenceRows, 1);
  assert.equal(service.dataManager().differences[0].runId, firstRun.runId);

  const createRun = service.store.createRun.bind(service.store);
  service.store.createRun = () => {
    throw new Error('模拟新草稿写入失败');
  };
  assert.throws(
    () => service.run({
      channels: ['DBS'],
      months: ['2026-07'],
      replacePendingRunId: firstRun.runId
    }),
    /模拟新草稿写入失败/
  );
  service.store.createRun = createRun;
  assert.equal(
    service.store.latestPendingRun().id,
    firstRun.runId,
    '新草稿失败时旧草稿必须保持待确认'
  );

  assert.equal(service.prepareSourceImport([sourceRefreshPath]).successCount, 1);
  assert.equal(service.dataManager().differences.length, 0, '失效草稿不应留在可操作差异列表');

  const secondRun = service.run({
    channels: ['DBS'],
    months: ['2026-07'],
    replacePendingRunId: firstRun.runId
  });
  const activeDifferences = service.dataManager().differences;
  assert.equal(activeDifferences.length, 1);
  assert.equal(activeDifferences[0].runId, secondRun.runId);
});

test('清结算银行账户表只保存状态正常的行，零有效行不覆盖旧快照', (t) => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'position-account-'));
  const validPath = path.join(userDataDir, 'accounts-valid.xlsx');
  const invalidPath = path.join(userDataDir, 'accounts-invalid.xlsx');
  const headers = SOURCE_DEFINITIONS[SOURCE_TYPES.BANK_ACCOUNT].headers;
  writeWorkbook(validPath, 'sheet1', headers, [
    {
      账户状态: '正常',
      账户性质: '自有',
      币种: 'USD',
      银行账号: 'OWN-001'
    },
    {
      账户状态: '注销',
      账户性质: '外部',
      币种: 'EUR',
      银行账号: 'OLD-001'
    }
  ]);
  writeWorkbook(invalidPath, 'sheet1', headers, [{
    账户状态: '注销',
    账户性质: '自有',
    币种: 'USD',
    银行账号: 'OLD-002'
  }]);
  const service = createPositionReconciliationService({
    userDataDir,
    templatePath: TEMPLATE_PATH
  });
  t.after(() => {
    service.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  });

  const prepared = service.prepareSourceImport([validPath]);
  assert.equal(prepared.archiveDeferred, true);
  const confirmation = prepared.results.find((row) => row.status === 'needs-confirmation');
  assert.ok(confirmation);
  writeWorkbook(validPath, 'sheet1', headers, [{
    账户状态: '正常',
    账户性质: '自有',
    币种: 'EUR',
    银行账号: 'REPLACED-001'
  }]);
  const applied = service.applySourceImport(confirmation.token);
  assert.equal(service.store.sourceRecords(SOURCE_TYPES.BANK_ACCOUNT).length, 1);
  assert.equal(service.store.sourceRecords(SOURCE_TYPES.BANK_ACCOUNT)[0].row['银行账号'], 'OWN-001');
  assert.equal(applied.originalInputPaths[0], validPath);
  assert.notEqual(applied.inputPaths[0], validPath);

  const cancelled = service.prepareSourceImport([validPath]).results.find(
    (row) => row.status === 'needs-confirmation'
  );
  assert.ok(cancelled);
  service.cancelSourceImport(cancelled.token);
  assert.throws(
    () => service.applySourceImport(cancelled.token),
    (error) => error && error.code === 'position-source-import-token-expired'
  );

  const rejected = service.prepareSourceImport([invalidPath]);
  assert.equal(rejected.failedCount, 1);
  assert.equal(service.store.sourceRecords(SOURCE_TYPES.BANK_ACCOUNT).length, 1);
});

test('链接原始表混合批次保持选择顺序，供存档中心准确关联成功文件', (t) => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'position-source-order-'));
  const validPath = path.join(userDataDir, 'valid-transfer.xlsx');
  const invalidPath = path.join(userDataDir, 'invalid-source.xlsx');
  writeWorkbook(
    validPath,
    'Sheet1',
    SOURCE_DEFINITIONS[SOURCE_TYPES.FUND_TRANSFER].headers,
    [{
      调拨单号: 'FT-1',
      调拨状态: '付款成功',
      渠道流水号: 'RID-1',
      交易时间: '2026-07-20',
      '付款账户（卡号）': 'PAY-1',
      '收款账户（卡号）': 'REC-1',
      付款金额: '100',
      付款币种: 'USD',
      收款金额: '95',
      收款币种: 'EUR'
    }]
  );
  writeWorkbook(invalidPath, 'Sheet1', ['未知字段'], [{ 未知字段: 'x' }]);
  const service = createPositionReconciliationService({
    userDataDir,
    templatePath: TEMPLATE_PATH
  });
  t.after(() => {
    service.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  });

  const result = service.prepareSourceImport([validPath, invalidPath]);
  assert.deepEqual(
    result.results.map((item) => item.fileName),
    ['valid-transfer.xlsx', 'invalid-source.xlsx']
  );
  assert.deepEqual(result.results.map((item) => item.status), ['ok', 'failed']);
});

test('持久侧库关键 JSON 损坏时阻断运行，不降级成普通未命中', (t) => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'position-corrupt-json-'));
  const bankPath = path.join(userDataDir, 'bank.xlsx');
  const sourcePath = path.join(userDataDir, 'inbound.xlsx');
  writeWorkbook(bankPath, BANK_SHEET_NAME, BANK_STATEMENT_FIELDS, [bankRow()]);
  writeWorkbook(
    sourcePath,
    '账单明细',
    SOURCE_DEFINITIONS[SOURCE_TYPES.GATEWAY_INBOUND].headers,
    [inboundRow()]
  );
  const service = createPositionReconciliationService({
    userDataDir,
    templatePath: TEMPLATE_PATH
  });
  t.after(() => {
    service.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  });

  service.applyBankImport(service.prepareBankImport([bankPath]).token);
  assert.equal(service.prepareSourceImport([sourcePath]).successCount, 1);
  service.store.db.prepare(
    "UPDATE position_link_rows SET linked_json = '{' WHERE source_type = ?"
  ).run(SOURCE_TYPES.GATEWAY_INBOUND);
  assert.throws(
    () => service.run({ channels: ['DBS'], months: ['2026-07'] }),
    /平盘侧库链接行 ID=.*JSON 损坏/
  );
});

test('持久侧库非法日期标记必须阻断读取', (t) => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'position-corrupt-date-json-'));
  const bankPath = path.join(userDataDir, 'bank.xlsx');
  writeWorkbook(bankPath, BANK_SHEET_NAME, BANK_STATEMENT_FIELDS, [bankRow()]);
  const service = createPositionReconciliationService({
    userDataDir,
    templatePath: TEMPLATE_PATH
  });
  t.after(() => {
    service.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  });

  service.applyBankImport(service.prepareBankImport([bankPath]).token);
  service.store.db.prepare(`
    UPDATE position_bank_rows
    SET working_json = ?
    WHERE biz_id = ?
  `).run(
    JSON.stringify({
      BizId: 'POSITION-BIZ-1',
      BillDate: {
        __position_reconciliation_type__: 'Date',
        value: 'not-a-date'
      }
    }),
    'POSITION-BIZ-1'
  );
  assert.throws(
    () => service.store.getBankRows(),
    /平盘侧库银行工作行 BizId=POSITION-BIZ-1 JSON 损坏：日期标记无效/
  );
});

test('持久侧库语法合法但缺字段的 JSON 必须 fail-closed', async (t) => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'position-missing-json-fields-'));
  const bankPath = path.join(userDataDir, 'bank.xlsx');
  const sourcePath = path.join(userDataDir, 'inbound.xlsx');
  const resultPath = path.join(userDataDir, 'result.xlsx');
  writeWorkbook(bankPath, BANK_SHEET_NAME, BANK_STATEMENT_FIELDS, [bankRow()]);
  writeWorkbook(
    sourcePath,
    '账单明细',
    SOURCE_DEFINITIONS[SOURCE_TYPES.GATEWAY_INBOUND].headers,
    [inboundRow()]
  );
  const service = createPositionReconciliationService({
    userDataDir,
    templatePath: TEMPLATE_PATH
  });
  t.after(() => {
    service.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  });

  service.applyBankImport(service.prepareBankImport([bankPath]).token);
  service.store.db.prepare(
    "UPDATE position_bank_rows SET working_json = '{}' WHERE biz_id = ?"
  ).run('POSITION-BIZ-1');
  assert.throws(
    () => service.store.getBankRows(),
    (error) => error && error.code === 'position-side-data-invalid'
  );

  service.store.db.prepare(
    'DELETE FROM position_bank_rows WHERE biz_id = ?'
  ).run('POSITION-BIZ-1');
  service.applyBankImport(service.prepareBankImport([bankPath]).token);
  assert.equal(service.prepareSourceImport([sourcePath]).successCount, 1);
  const run = service.run({ channels: ['DBS'], months: ['2026-07'] });
  await service.exportRun(run.runId, resultPath);
  service.store.db.prepare(
    "UPDATE position_run_rows SET lineage_json = '{}' WHERE run_id = ?"
  ).run(run.runId);
  assert.throws(
    () => service.confirmRun(run.runId),
    (error) => error && error.code === 'position-side-data-invalid'
  );
});

test('不适用行的空对象血缘也必须 fail-closed', async (t) => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'position-not-applicable-lineage-'));
  const bankPath = path.join(userDataDir, 'bank.xlsx');
  const resultPath = path.join(userDataDir, 'result.xlsx');
  writeWorkbook(
    bankPath,
    BANK_SHEET_NAME,
    BANK_STATEMENT_FIELDS,
    [bankRow({ BizId: 'POSITION-NOT-APPLICABLE-1', FundType: 'Charge' })]
  );
  const service = createPositionReconciliationService({
    userDataDir,
    templatePath: TEMPLATE_PATH
  });
  t.after(() => {
    service.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  });

  service.applyBankImport(service.prepareBankImport([bankPath]).token);
  const run = service.run({ channels: ['DBS'], months: ['2026-07'] });
  await service.exportRun(run.runId, resultPath);
  service.store.db.prepare(
    "UPDATE position_run_rows SET lineage_json = '{}' WHERE run_id = ?"
  ).run(run.runId);
  assert.throws(
    () => service.confirmRun(run.runId),
    (error) => error && error.code === 'position-side-data-invalid'
  );
});

test('运行结果、血缘、差异集合及当前链接引用被改写时必须 fail-closed', (t) => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'position-run-integrity-'));
  const bankPath = path.join(userDataDir, 'bank.xlsx');
  const sourcePath = path.join(userDataDir, 'inbound.xlsx');
  writeWorkbook(bankPath, BANK_SHEET_NAME, BANK_STATEMENT_FIELDS, [bankRow()]);
  writeWorkbook(
    sourcePath,
    '账单明细',
    SOURCE_DEFINITIONS[SOURCE_TYPES.GATEWAY_INBOUND].headers,
    [inboundRow()]
  );
  const service = createPositionReconciliationService({
    userDataDir,
    templatePath: TEMPLATE_PATH
  });
  t.after(() => {
    service.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  });

  service.applyBankImport(service.prepareBankImport([bankPath]).token);
  assert.equal(service.prepareSourceImport([sourcePath]).successCount, 1);
  const run = service.run({ channels: ['DBS'], months: ['2026-07'] });
  const stored = service.store.db.prepare(`
    SELECT result_json, lineage_json
    FROM position_run_rows
    WHERE run_id = ? AND biz_id = ?
  `).get(run.runId, 'POSITION-BIZ-1');

  const changedResult = JSON.parse(stored.result_json);
  changedResult['Credit Amount'] = '999';
  service.store.db.prepare(`
    UPDATE position_run_rows SET result_json = ?
    WHERE run_id = ? AND biz_id = ?
  `).run(JSON.stringify(changedResult), run.runId, 'POSITION-BIZ-1');
  assert.throws(
    () => service.store.getRun(run.runId),
    (error) => error && error.code === 'position-side-data-invalid',
    '非 FundType 结果字段被改写时必须阻断'
  );
  service.store.db.prepare(`
    UPDATE position_run_rows SET result_json = ?
    WHERE run_id = ? AND biz_id = ?
  `).run(stored.result_json, run.runId, 'POSITION-BIZ-1');

  const changedLineage = JSON.parse(stored.lineage_json);
  changedLineage.pairKey = 'tampered-pair';
  service.store.db.prepare(`
    UPDATE position_run_rows SET lineage_json = ?
    WHERE run_id = ? AND biz_id = ?
  `).run(JSON.stringify(changedLineage), run.runId, 'POSITION-BIZ-1');
  assert.throws(
    () => service.store.getRun(run.runId),
    (error) => error && error.code === 'position-side-data-invalid',
    '语法合法的血缘改写也必须通过完整性哈希识别'
  );
  service.store.db.prepare(`
    UPDATE position_run_rows SET lineage_json = ?
    WHERE run_id = ? AND biz_id = ?
  `).run(stored.lineage_json, run.runId, 'POSITION-BIZ-1');

  service.store.db.prepare(`
    INSERT INTO position_differences(
      run_id, biz_id, channel, month_key, status, reason, lineage_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    run.runId,
    'POSITION-BIZ-1',
    'DBS',
    '2026-07',
    '待确认',
    '伪造差异',
    stored.lineage_json
  );
  assert.throws(
    () => service.store.getRun(run.runId),
    (error) => error && error.code === 'position-side-data-invalid',
    '匹配行被额外写入差异表时必须阻断'
  );
  service.store.db.prepare(
    'DELETE FROM position_differences WHERE run_id = ? AND biz_id = ?'
  ).run(run.runId, 'POSITION-BIZ-1');

  service.store.db.prepare(`
    UPDATE position_link_rows
    SET business_key = ?
    WHERE source_type = ? AND business_key = ?
  `).run('OTHER-BUSINESS-KEY', SOURCE_TYPES.GATEWAY_INBOUND, 'INBOUND-1');
  assert.throws(
    () => service.store.getRun(run.runId),
    (error) => error && error.code === 'position-side-data-invalid',
    '当前链接记录与运行血缘不一致时必须阻断'
  );
});

test('链接表删除必须明确月份，清空来源后运行会被阻断', (t) => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'position-delete-guard-'));
  const bankPath = path.join(userDataDir, 'bank.xlsx');
  const sourcePath = path.join(userDataDir, 'inbound.xlsx');
  writeWorkbook(bankPath, BANK_SHEET_NAME, BANK_STATEMENT_FIELDS, [bankRow()]);
  writeWorkbook(
    sourcePath,
    '账单明细',
    SOURCE_DEFINITIONS[SOURCE_TYPES.GATEWAY_INBOUND].headers,
    [inboundRow()]
  );
  const service = createPositionReconciliationService({
    userDataDir,
    templatePath: TEMPLATE_PATH
  });
  t.after(() => {
    service.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  });

  service.applyBankImport(service.prepareBankImport([bankPath]).token);
  assert.equal(service.prepareSourceImport([sourcePath]).successCount, 1);
  assert.throws(
    () => service.deleteSource({ sourceType: SOURCE_TYPES.GATEWAY_INBOUND, months: [] }),
    /至少选择一个月份/
  );
  assert.throws(
    () => service.deleteSource({
      sourceType: SOURCE_TYPES.GATEWAY_INBOUND,
      wholeTable: true
    }),
    /不允许整表删除/
  );
  assert.equal(service.store.countSourceRows(SOURCE_TYPES.GATEWAY_INBOUND), 1);

  service.deleteSource({
    sourceType: SOURCE_TYPES.GATEWAY_INBOUND,
    months: ['2026-07']
  });
  assert.equal(service.store.countSourceRows(SOURCE_TYPES.GATEWAY_INBOUND), 0);
  assert.throws(
    () => service.run({ channels: ['DBS'], months: ['2026-07'] }),
    (error) => error && error.code === 'position-run-source-missing'
  );
});

test('FundTransfer-in 使用的外部 out 银行数据变化会使草稿失效', async (t) => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'position-transfer-snapshot-'));
  const bankPath = path.join(userDataDir, 'bank.xlsx');
  const sourcePath = path.join(userDataDir, 'transfer.xlsx');
  const outputPath = path.join(userDataDir, 'stale.xlsx');
  writeWorkbook(bankPath, BANK_SHEET_NAME, BANK_STATEMENT_FIELDS, [
    bankRow({
      BizId: 'TRANSFER-OUT-BIZ',
      BillDate: '2026-06-21',
      Channel: 'DBS',
      MerchantId: 'PAY-001',
      Currency: 'USD',
      'Credit Amount': '0',
      'Debit Amount': '100',
      ReconciliationId: 'TRANSFER-RID-1',
      FundType: 'FundTransfer-out'
    }),
    bankRow({
      BizId: 'TRANSFER-IN-BIZ',
      BillDate: '2026-07-21',
      Channel: 'DBS',
      MerchantId: 'RECEIVE-001',
      Currency: 'EUR',
      'Credit Amount': '95',
      'Debit Amount': '0',
      ReconciliationId: 'TRANSFER-RID-1',
      FundType: 'FundTransfer-in'
    })
  ]);
  writeWorkbook(
    sourcePath,
    '调拨',
    SOURCE_DEFINITIONS[SOURCE_TYPES.FUND_TRANSFER].headers,
    [transferRow()]
  );
  const service = createPositionReconciliationService({
    userDataDir,
    templatePath: TEMPLATE_PATH
  });
  t.after(() => {
    service.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  });

  service.applyBankImport(service.prepareBankImport([bankPath]).token);
  assert.equal(service.prepareSourceImport([sourcePath]).successCount, 1);
  const run = service.run({ channels: ['DBS'], months: ['2026-07'] });
  assert.equal(run.summary.differenceRows, 0);
  service.deleteBank({ channels: ['DBS'], months: ['2026-06'] });
  await assert.rejects(
    service.exportRun(run.runId, outputPath),
    (error) => error && error.code === 'position-run-stale'
  );
});

test('差异汇总和导出严格限定当前银行渠道、月份和状态', async (t) => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'position-difference-scope-'));
  const bankPath = path.join(userDataDir, 'bank.xlsx');
  const sourcePath = path.join(userDataDir, 'inbound.xlsx');
  const outputPath = path.join(userDataDir, 'difference-dbs.xlsx');
  writeWorkbook(bankPath, BANK_SHEET_NAME, BANK_STATEMENT_FIELDS, [
    bankRow({ BizId: 'DIFF-DBS', ReconciliationId: 'RID-DBS' }),
    bankRow({
      BizId: 'DIFF-DBS-US',
      地区: 'US',
      ReconciliationId: 'RID-DBS-US'
    }),
    bankRow({
      BizId: 'DIFF-MAYBANK',
      BillDate: '2026-08-20',
      Channel: 'MAYBANK',
      MerchantId: 'M002',
      ReconciliationId: 'RID-MAYBANK'
    })
  ]);
  writeWorkbook(
    sourcePath,
    '账单明细',
    SOURCE_DEFINITIONS[SOURCE_TYPES.GATEWAY_INBOUND].headers,
    [inboundRow({ reconId: 'OTHER-RID' })]
  );
  const service = createPositionReconciliationService({
    userDataDir,
    templatePath: TEMPLATE_PATH
  });
  t.after(() => {
    service.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  });

  service.applyBankImport(service.prepareBankImport([bankPath]).token);
  assert.equal(service.prepareSourceImport([sourcePath]).successCount, 1);
  const run = service.run({
    channels: ['DBS', 'MAYBANK'],
    months: ['2026-07', '2026-08']
  });
  assert.equal(run.summary.differenceRows, 3);
  const differences = service.dataManager().differences;
  assert.equal(differences.length, 3);
  assert.deepEqual(
    differences.map((row) => row.bankChannel).sort(),
    ['DBS-HK', 'DBS-US', 'MAYBANK-HK']
  );
  const exported = await service.exportRun(run.runId, outputPath, {
    differencesOnly: true,
    channels: ['DBS'],
    regions: ['HK'],
    months: ['2026-07'],
    differenceStatuses: ['待确认']
  });
  assert.equal(exported.rowCount, 1);
  const workbook = XLSX.readFile(outputPath, { raw: true });
  const rows = XLSX.utils.sheet_to_json(workbook.Sheets[BANK_SHEET_NAME], {
    header: 1,
    defval: ''
  });
  assert.equal(rows[1][POSITION_BANK_HEADERS.indexOf('BizId')], 'DIFF-DBS');
});

test('引擎输出必须与输入 BizId 集合严格一一对应', () => {
  const bankRows = [{ biz_id: 'BIZ-A' }, { biz_id: 'BIZ-B' }];
  assert.doesNotThrow(() => assertEngineResultSet([
    { bizId: 'BIZ-A' },
    { bizId: 'BIZ-B' }
  ], bankRows));
  assert.throws(
    () => assertEngineResultSet([
      { bizId: 'BIZ-A' },
      { bizId: 'BIZ-A' }
    ], bankRows),
    (error) => error && error.code === 'position-run-row-conservation'
  );
});

test('银行 Excel 日期单元格经过侧库后仍以日期类型导出', async (t) => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'position-date-roundtrip-'));
  const bankPath = path.join(userDataDir, 'bank.xlsx');
  const sourcePath = path.join(userDataDir, 'inbound.xlsx');
  const outputPath = path.join(userDataDir, 'bank-export.xlsx');
  const resultPath = path.join(userDataDir, 'result-export.xlsx');
  writeWorkbook(bankPath, BANK_SHEET_NAME, BANK_STATEMENT_FIELDS, [bankRow({
    BillDate: new Date(2026, 6, 20),
    ValueDate: new Date(2026, 6, 21),
    最近修改时间: new Date(2026, 6, 20, 12, 34, 56)
  })]);
  writeWorkbook(
    sourcePath,
    '账单明细',
    SOURCE_DEFINITIONS[SOURCE_TYPES.GATEWAY_INBOUND].headers,
    [inboundRow()]
  );
  const service = createPositionReconciliationService({
    userDataDir,
    templatePath: TEMPLATE_PATH
  });
  t.after(() => {
    service.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  });

  service.applyBankImport(service.prepareBankImport([bankPath]).token);
  const stored = service.store.getBankRows()[0];
  assert.equal(stored.originalRow.BillDate instanceof Date, true);
  assert.equal(stored.workingRow.ValueDate instanceof Date, true);
  assert.equal(stored.workingRow.最近修改时间 instanceof Date, true);

  await service.exportBank({ channels: ['DBS'], months: ['2026-07'] }, outputPath);
  const workbook = XLSX.readFile(outputPath, { cellDates: true, raw: true });
  const rows = XLSX.utils.sheet_to_json(workbook.Sheets[BANK_SHEET_NAME], {
    header: 1,
    defval: '',
    raw: true
  });
  assert.equal(rows[1][POSITION_BANK_HEADERS.indexOf('BillDate')] instanceof Date, true);
  assert.equal(rows[1][POSITION_BANK_HEADERS.indexOf('ValueDate')] instanceof Date, true);
  assert.equal(rows[1][POSITION_BANK_HEADERS.indexOf('最近修改时间')] instanceof Date, true);

  assert.equal(service.prepareSourceImport([sourcePath]).successCount, 1);
  const run = service.run({ channels: ['DBS'], months: ['2026-07'] });
  await service.exportRun(run.runId, resultPath);
  assert.doesNotThrow(() => service.importRunResult(run.runId, resultPath));

  const edited = XLSX.readFile(resultPath, { cellDates: true, raw: true });
  const editedRows = XLSX.utils.sheet_to_json(edited.Sheets[BANK_SHEET_NAME], {
    header: 1,
    defval: '',
    raw: true
  });
  const modifiedAtColumn = POSITION_BANK_HEADERS.indexOf('最近修改时间');
  editedRows[1][modifiedAtColumn] = new Date(editedRows[1][modifiedAtColumn].getTime() + (60 * 60 * 1000));
  const tampered = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    tampered,
    XLSX.utils.aoa_to_sheet(editedRows),
    BANK_SHEET_NAME
  );
  XLSX.writeFile(tampered, resultPath);
  assert.throws(
    () => service.importRunResult(run.runId, resultPath),
    (error) => error && error.code === 'position-result-field-tampered'
  );
});

test('已确认订单链接记录跨月份及原始表重建后仍禁止重复消费', async (t) => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'position-source-consumption-'));
  const julyBankPath = path.join(userDataDir, 'bank-july.xlsx');
  const augustBankPath = path.join(userDataDir, 'bank-august.xlsx');
  const sourcePath = path.join(userDataDir, 'inbound.xlsx');
  const refreshedSourcePath = path.join(userDataDir, 'inbound-refreshed.xlsx');
  const resultPath = path.join(userDataDir, 'july-result.xlsx');
  writeWorkbook(julyBankPath, BANK_SHEET_NAME, BANK_STATEMENT_FIELDS, [bankRow()]);
  writeWorkbook(augustBankPath, BANK_SHEET_NAME, BANK_STATEMENT_FIELDS, [bankRow({
    BizId: 'POSITION-BIZ-AUGUST',
    BillDate: '2026-08-20'
  })]);
  writeWorkbook(
    sourcePath,
    '账单明细',
    SOURCE_DEFINITIONS[SOURCE_TYPES.GATEWAY_INBOUND].headers,
    [inboundRow()]
  );
  writeWorkbook(
    refreshedSourcePath,
    '账单明细',
    SOURCE_DEFINITIONS[SOURCE_TYPES.GATEWAY_INBOUND].headers,
    [inboundRow({ finishTime: '2026-07-21 10:00:00' })]
  );
  const service = createPositionReconciliationService({
    userDataDir,
    templatePath: TEMPLATE_PATH
  });
  t.after(() => {
    service.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  });

  service.applyBankImport(service.prepareBankImport([julyBankPath]).token);
  assert.equal(service.prepareSourceImport([sourcePath]).successCount, 1);
  const julyRun = service.run({ channels: ['DBS'], months: ['2026-07'] });
  assert.equal(julyRun.summary.differenceRows, 0);
  await service.exportRun(julyRun.runId, resultPath);
  service.confirmRun(julyRun.runId);
  assert.deepEqual(
    service.store.listConsumedSources().map((item) => ({
      sourceType: item.sourceType,
      businessKey: item.businessKey,
      legIndex: item.legIndex,
      bankBizId: item.bankBizId
    })),
    [{
      sourceType: SOURCE_TYPES.GATEWAY_INBOUND,
      businessKey: 'INBOUND-1',
      legIndex: 0,
      bankBizId: 'POSITION-BIZ-1'
    }]
  );

  assert.equal(service.prepareSourceImport([refreshedSourcePath]).successCount, 1);
  service.applyBankImport(service.prepareBankImport([augustBankPath]).token);
  const augustRun = service.run({ channels: ['DBS'], months: ['2026-08'] });
  assert.equal(augustRun.summary.changedRows, 0);
  assert.equal(augustRun.summary.differenceRows, 1);
  const augustResult = service.store.listRunRows(augustRun.runId)[0];
  assert.equal(augustResult.result_fund_type, 'Inbound&FX');
  assert.match(augustResult.match_detail, /链接记录已被已确认运行#\d+的银行BizId=POSITION-BIZ-1消费/);
});

test('同一银行 BizId 重导后可幂等复核同一链接记录', async (t) => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'position-source-idempotent-'));
  const bankPath = path.join(userDataDir, 'bank.xlsx');
  const sourcePath = path.join(userDataDir, 'inbound.xlsx');
  const firstResultPath = path.join(userDataDir, 'first.xlsx');
  const secondResultPath = path.join(userDataDir, 'second.xlsx');
  writeWorkbook(bankPath, BANK_SHEET_NAME, BANK_STATEMENT_FIELDS, [bankRow()]);
  writeWorkbook(
    sourcePath,
    '账单明细',
    SOURCE_DEFINITIONS[SOURCE_TYPES.GATEWAY_INBOUND].headers,
    [inboundRow()]
  );
  const service = createPositionReconciliationService({
    userDataDir,
    templatePath: TEMPLATE_PATH
  });
  t.after(() => {
    service.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  });

  service.applyBankImport(service.prepareBankImport([bankPath]).token);
  assert.equal(service.prepareSourceImport([sourcePath]).successCount, 1);
  const firstRun = service.run({ channels: ['DBS'], months: ['2026-07'] });
  await service.exportRun(firstRun.runId, firstResultPath);
  service.confirmRun(firstRun.runId);

  service.applyBankImport(service.prepareBankImport([bankPath]).token);
  const secondRun = service.run({ channels: ['DBS'], months: ['2026-07'] });
  assert.equal(secondRun.summary.changedRows, 1);
  assert.equal(secondRun.summary.differenceRows, 0);
  await service.exportRun(secondRun.runId, secondResultPath);
  assert.doesNotThrow(() => service.confirmRun(secondRun.runId));
  assert.doesNotThrow(() => service.store.getRun(secondRun.runId));
  assert.equal(service.store.listConsumedSources().length, 1);
});

test('已确认来源消费表与运行血缘必须保持双向一致', async (t) => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'position-consumption-integrity-'));
  const bankPath = path.join(userDataDir, 'bank.xlsx');
  const sourcePath = path.join(userDataDir, 'inbound.xlsx');
  const resultPath = path.join(userDataDir, 'result.xlsx');
  writeWorkbook(bankPath, BANK_SHEET_NAME, BANK_STATEMENT_FIELDS, [bankRow()]);
  writeWorkbook(
    sourcePath,
    '账单明细',
    SOURCE_DEFINITIONS[SOURCE_TYPES.GATEWAY_INBOUND].headers,
    [inboundRow()]
  );
  const service = createPositionReconciliationService({
    userDataDir,
    templatePath: TEMPLATE_PATH
  });
  t.after(() => {
    service.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  });

  service.applyBankImport(service.prepareBankImport([bankPath]).token);
  assert.equal(service.prepareSourceImport([sourcePath]).successCount, 1);
  const run = service.run({ channels: ['DBS'], months: ['2026-07'] });
  await service.exportRun(run.runId, resultPath);
  service.confirmRun(run.runId);
  assert.equal(service.store.listConsumedSources().length, 1);

  service.store.db.prepare(
    'DELETE FROM position_consumed_sources WHERE run_id = ?'
  ).run(run.runId);
  assert.throws(
    () => service.store.getRun(run.runId),
    (error) => error && error.code === 'position-side-data-invalid'
  );
  assert.throws(
    () => service.store.listConsumedSources(),
    (error) => error && error.code === 'position-side-data-invalid'
  );
});

test('来源消费 owner 必须由对应 confirmed 运行血缘证明', async (t) => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'position-consumption-owner-'));
  const unrelatedBankPath = path.join(userDataDir, 'bank-unrelated.xlsx');
  const bankPath = path.join(userDataDir, 'bank.xlsx');
  const sourcePath = path.join(userDataDir, 'inbound.xlsx');
  writeWorkbook(
    unrelatedBankPath,
    BANK_SHEET_NAME,
    BANK_STATEMENT_FIELDS,
    [bankRow({
      BizId: 'POSITION-BIZ-UNRELATED',
      ReconciliationId: 'RID-UNRELATED',
      FundType: 'Charge'
    })]
  );
  writeWorkbook(bankPath, BANK_SHEET_NAME, BANK_STATEMENT_FIELDS, [bankRow()]);
  writeWorkbook(
    sourcePath,
    '账单明细',
    SOURCE_DEFINITIONS[SOURCE_TYPES.GATEWAY_INBOUND].headers,
    [inboundRow()]
  );
  const service = createPositionReconciliationService({
    userDataDir,
    templatePath: TEMPLATE_PATH
  });
  t.after(() => {
    service.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  });

  service.applyBankImport(service.prepareBankImport([unrelatedBankPath]).token);
  const unrelatedRun = service.run({ channels: ['DBS'], months: ['2026-07'] });
  await service.exportRun(unrelatedRun.runId, path.join(userDataDir, 'unrelated.xlsx'));
  service.confirmRun(unrelatedRun.runId);

  service.applyBankImport(service.prepareBankImport([bankPath]).token);
  assert.equal(service.prepareSourceImport([sourcePath]).successCount, 1);
  const ownerRun = service.run({ channels: ['DBS'], months: ['2026-07'] });
  await service.exportRun(ownerRun.runId, path.join(userDataDir, 'owner.xlsx'));
  service.confirmRun(ownerRun.runId);

  service.applyBankImport(service.prepareBankImport([bankPath]).token);
  const idempotentRun = service.run({ channels: ['DBS'], months: ['2026-07'] });
  await service.exportRun(idempotentRun.runId, path.join(userDataDir, 'idempotent.xlsx'));
  service.confirmRun(idempotentRun.runId);
  assert.doesNotThrow(() => service.store.getRun(idempotentRun.runId));

  const updateOwner = service.store.db.prepare(`
    UPDATE position_consumed_sources
    SET run_id = ?
    WHERE source_type = ? AND business_key = ? AND leg_index = ?
  `);
  updateOwner.run(
    unrelatedRun.runId,
    SOURCE_TYPES.GATEWAY_INBOUND,
    'INBOUND-1',
    0
  );
  assert.throws(
    () => service.store.getRun(idempotentRun.runId),
    (error) => error && error.code === 'position-side-data-invalid'
  );

  updateOwner.run(
    idempotentRun.runId,
    SOURCE_TYPES.GATEWAY_INBOUND,
    'INBOUND-1',
    0
  );
  assert.throws(
    () => service.store.getRun(ownerRun.runId),
    (error) => error && error.code === 'position-side-data-invalid'
  );

  updateOwner.run(
    ownerRun.runId,
    SOURCE_TYPES.GATEWAY_INBOUND,
    'INBOUND-1',
    0
  );
  assert.doesNotThrow(() => service.store.getRun(idempotentRun.runId));
  service.store.db.prepare(`
    INSERT INTO position_consumed_sources(
      run_id, source_type, business_key, leg_index, bank_biz_id
    ) VALUES (?, ?, ?, ?, ?)
  `).run(
    idempotentRun.runId,
    SOURCE_TYPES.GATEWAY_INBOUND,
    'UNRELATED-SOURCE',
    0,
    'UNRELATED-BANK-BIZ'
  );
  assert.throws(
    () => service.store.getRun(idempotentRun.runId),
    (error) => error && error.code === 'position-side-data-invalid'
  );
});

test('同一银行 BizId 已确认后禁止改配到另一条链接记录', async (t) => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'position-bank-reassignment-'));
  const firstBankPath = path.join(userDataDir, 'bank-first.xlsx');
  const secondBankPath = path.join(userDataDir, 'bank-second.xlsx');
  const firstSourcePath = path.join(userDataDir, 'inbound-first.xlsx');
  const secondSourcePath = path.join(userDataDir, 'inbound-second.xlsx');
  const firstResultPath = path.join(userDataDir, 'first.xlsx');
  writeWorkbook(firstBankPath, BANK_SHEET_NAME, BANK_STATEMENT_FIELDS, [bankRow()]);
  writeWorkbook(secondBankPath, BANK_SHEET_NAME, BANK_STATEMENT_FIELDS, [bankRow({
    ReconciliationId: 'RID-2'
  })]);
  writeWorkbook(
    firstSourcePath,
    '账单明细',
    SOURCE_DEFINITIONS[SOURCE_TYPES.GATEWAY_INBOUND].headers,
    [inboundRow()]
  );
  writeWorkbook(
    secondSourcePath,
    '账单明细',
    SOURCE_DEFINITIONS[SOURCE_TYPES.GATEWAY_INBOUND].headers,
    [inboundRow({ bizId: 'INBOUND-2', reconId: 'RID-2' })]
  );
  const service = createPositionReconciliationService({
    userDataDir,
    templatePath: TEMPLATE_PATH
  });
  t.after(() => {
    service.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  });

  service.applyBankImport(service.prepareBankImport([firstBankPath]).token);
  assert.equal(service.prepareSourceImport([firstSourcePath]).successCount, 1);
  const firstRun = service.run({ channels: ['DBS'], months: ['2026-07'] });
  await service.exportRun(firstRun.runId, firstResultPath);
  service.confirmRun(firstRun.runId);

  assert.equal(service.prepareSourceImport([secondSourcePath]).successCount, 1);
  service.applyBankImport(service.prepareBankImport([secondBankPath]).token);
  const secondRun = service.run({ channels: ['DBS'], months: ['2026-07'] });
  assert.equal(secondRun.summary.changedRows, 0);
  assert.equal(secondRun.summary.differenceRows, 1);
  assert.equal(secondRun.summary.engine.matched, 0);
  assert.equal(secondRun.summary.engine.differences, 1);
  assert.equal(secondRun.summary.engine.confirmedConsumptionConflicts, 1);
  const row = service.store.listRunRows(secondRun.runId)[0];
  assert.equal(row.result_fund_type, 'Inbound&FX');
  assert.match(row.match_detail, /禁止改配到其他链接记录/);
  assert.equal(row.lineage.reasonCode, 'position-bank-counterparty-reassigned');
});

test('银行导出拒绝实际无数据的 Channel 月份组合', async (t) => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'position-bank-export-empty-'));
  const bankPath = path.join(userDataDir, 'bank.xlsx');
  const outputPath = path.join(userDataDir, 'empty.xlsx');
  writeWorkbook(bankPath, BANK_SHEET_NAME, BANK_STATEMENT_FIELDS, [bankRow()]);
  const service = createPositionReconciliationService({
    userDataDir,
    templatePath: TEMPLATE_PATH
  });
  t.after(() => {
    service.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  });

  service.applyBankImport(service.prepareBankImport([bankPath]).token);
  await assert.rejects(
    service.exportBank({ channels: ['DBS'], months: ['2026-08'] }, outputPath),
    (error) => error && error.code === 'position-bank-export-empty'
  );
  assert.throws(
    () => service.deleteBank({ channels: ['DBS'], months: ['2026-08'] }),
    (error) => error && error.code === 'position-bank-delete-empty'
  );
  assert.equal(fs.existsSync(outputPath), false);
});

test('银行导入 BizId 与其他范围冲突时明确拒绝并保留原数据', (t) => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'position-bank-bizid-conflict-'));
  const julyPath = path.join(userDataDir, 'july.xlsx');
  const augustPath = path.join(userDataDir, 'august.xlsx');
  writeWorkbook(julyPath, BANK_SHEET_NAME, BANK_STATEMENT_FIELDS, [bankRow()]);
  writeWorkbook(augustPath, BANK_SHEET_NAME, BANK_STATEMENT_FIELDS, [bankRow({
    BillDate: '2026-08-20',
    Channel: 'MAYBANK'
  })]);
  const service = createPositionReconciliationService({
    userDataDir,
    templatePath: TEMPLATE_PATH
  });
  t.after(() => {
    service.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  });

  service.applyBankImport(service.prepareBankImport([julyPath]).token);
  const prepared = service.prepareBankImport([augustPath]);
  assert.throws(
    () => service.applyBankImport(prepared.token),
    (error) => (
      error
      && error.code === 'position-bank-existing-bizid-conflict'
      && error.detailLines.some((line) => line.includes('DBS/2026-07'))
      && error.detailLines.some((line) => line.includes('MAYBANK/2026-08'))
    )
  );
  const rows = service.store.getBankRows();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].channel, 'DBS');
  assert.equal(rows[0].month_key, '2026-07');
});

test('银行批量同时替换新旧范围时也禁止 BizId 跨范围迁移', (t) => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'position-bank-bizid-move-'));
  const originalPath = path.join(userDataDir, 'original.xlsx');
  const mixedPath = path.join(userDataDir, 'mixed.xlsx');
  writeWorkbook(originalPath, BANK_SHEET_NAME, BANK_STATEMENT_FIELDS, [bankRow({
    BizId: 'BIZ-X',
    Channel: 'A',
    BillDate: '2026-06-20'
  })]);
  writeWorkbook(mixedPath, BANK_SHEET_NAME, BANK_STATEMENT_FIELDS, [
    bankRow({
      BizId: 'BIZ-X',
      Channel: 'B',
      BillDate: '2026-07-20'
    }),
    bankRow({
      BizId: 'BIZ-A-KEEP',
      Channel: 'A',
      BillDate: '2026-06-21'
    })
  ]);
  const service = createPositionReconciliationService({
    userDataDir,
    templatePath: TEMPLATE_PATH
  });
  t.after(() => {
    service.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  });

  service.applyBankImport(service.prepareBankImport([originalPath]).token);
  const prepared = service.prepareBankImport([mixedPath]);
  assert.throws(
    () => service.applyBankImport(prepared.token),
    (error) => (
      error
      && error.code === 'position-bank-existing-bizid-conflict'
      && error.detailLines.some((line) => line.includes('A/2026-06'))
      && error.detailLines.some((line) => line.includes('B/2026-07'))
    )
  );
  const rows = service.store.getBankRows();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].biz_id, 'BIZ-X');
  assert.equal(rows[0].channel, 'A');
  assert.equal(rows[0].month_key, '2026-06');
});

test('银行导入确认使用不可变暂存副本，原路径被覆盖不改变写库和存档来源', (t) => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'position-bank-staging-'));
  const bankPath = path.join(userDataDir, 'bank.xlsx');
  writeWorkbook(bankPath, BANK_SHEET_NAME, BANK_STATEMENT_FIELDS, [bankRow({
    BizId: 'STAGED-A',
    Channel: 'DBS'
  })]);
  const service = createPositionReconciliationService({
    userDataDir,
    templatePath: TEMPLATE_PATH
  });
  t.after(() => {
    service.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  });

  const prepared = service.prepareBankImport([bankPath]);
  writeWorkbook(bankPath, BANK_SHEET_NAME, BANK_STATEMENT_FIELDS, [bankRow({
    BizId: 'REPLACED-B',
    Channel: 'MAYBANK'
  })]);
  const applied = service.applyBankImport(prepared.token);
  const rows = service.store.getBankRows();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].biz_id, 'STAGED-A');
  assert.equal(rows[0].channel, 'DBS');
  assert.equal(applied.originalInputPaths[0], bankPath);
  assert.notEqual(applied.inputPaths[0], bankPath);
  assert.equal(fs.existsSync(applied.inputPaths[0]), true);
  const archivedCopy = XLSX.readFile(applied.inputPaths[0], { raw: true });
  const values = XLSX.utils.sheet_to_json(archivedCopy.Sheets[BANK_SHEET_NAME], {
    header: 1,
    defval: ''
  });
  assert.equal(values[1][BANK_STATEMENT_FIELDS.indexOf('BizId')], 'STAGED-A');
});

test('启动暂存清理跳过仍被存档失败批次引用的文件', (t) => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'position-staging-prune-'));
  t.after(() => fs.rmSync(userDataDir, { recursive: true, force: true }));
  const root = path.join(userDataDir, STAGING_RELATIVE_PATH);
  const protectedRoot = path.join(root, 'protected-batch');
  const staleRoot = path.join(root, 'stale-batch');
  const protectedFile = path.join(protectedRoot, '1', 'protected.xlsx');
  const staleFile = path.join(staleRoot, '1', 'stale.xlsx');
  fs.mkdirSync(path.dirname(protectedFile), { recursive: true });
  fs.mkdirSync(path.dirname(staleFile), { recursive: true });
  fs.writeFileSync(protectedFile, 'protected');
  fs.writeFileSync(staleFile, 'stale');
  const oldDate = new Date('2026-07-01T00:00:00.000Z');
  fs.utimesSync(protectedRoot, oldDate, oldDate);
  fs.utimesSync(staleRoot, oldDate, oldDate);

  const removed = pruneStagingRoot(userDataDir, {
    now: new Date('2026-07-20T00:00:00.000Z').getTime(),
    maxAgeMs: 24 * 60 * 60 * 1000,
    protectedPaths: [protectedFile]
  });

  assert.equal(removed, 1);
  assert.equal(fs.existsSync(protectedFile), true);
  assert.equal(fs.existsSync(staleRoot), false);
});

test('主库 pending 单独引用的过期暂存文件必须在恢复前保留', (t) => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'position-pending-staging-'));
  t.after(() => fs.rmSync(userDataDir, { recursive: true, force: true }));
  const bootstrap = createPositionReconciliationService({
    userDataDir,
    templatePath: TEMPLATE_PATH
  });
  const expectedCheckpoint = bootstrap.persistenceCheckpoint();
  bootstrap.close();

  const root = path.join(userDataDir, STAGING_RELATIVE_PATH);
  const protectedRoot = path.join(root, 'pending-batch');
  const staleRoot = path.join(root, 'stale-batch');
  const protectedFile = path.join(protectedRoot, '1', 'pending.xlsx');
  const staleFile = path.join(staleRoot, '1', 'stale.xlsx');
  fs.mkdirSync(path.dirname(protectedFile), { recursive: true });
  fs.mkdirSync(path.dirname(staleFile), { recursive: true });
  fs.writeFileSync(protectedFile, 'pending');
  fs.writeFileSync(staleFile, 'stale');
  const oldDate = new Date(Date.now() - (8 * 24 * 60 * 60 * 1000));
  fs.utimesSync(protectedRoot, oldDate, oldDate);
  fs.utimesSync(staleRoot, oldDate, oldDate);

  const recovered = createPositionReconciliationService({
    userDataDir,
    templatePath: TEMPLATE_PATH,
    requireExistingSideDb: true,
    expectedSideDbCheckpoint: expectedCheckpoint,
    expectedPendingOperation: JSON.stringify({
      operationToken: 'pending-operation',
      baseCheckpoint: expectedCheckpoint,
      archiveFiles: [{ filePath: protectedFile, role: 'input' }]
    }),
    protectedStagingPaths: () => []
  });
  recovered.close();

  assert.equal(fs.existsSync(protectedFile), true);
  assert.equal(fs.existsSync(staleRoot), false);
});

test('存档保护来源不可用时保守跳过全部过期暂存清理', (t) => {
  const providers = [
    ['null', () => null],
    ['undefined', () => undefined],
    ['非数组', () => ({})],
    ['抛异常', () => {
      throw new Error('archive center unavailable');
    }]
  ];

  for (const [label, protectedStagingPaths] of providers) {
    const userDataDir = fs.mkdtempSync(
      path.join(os.tmpdir(), `position-staging-protection-${label}-`)
    );
    t.after(() => fs.rmSync(userDataDir, { recursive: true, force: true }));
    const bootstrap = createPositionReconciliationService({
      userDataDir,
      templatePath: TEMPLATE_PATH
    });
    const expectedCheckpoint = bootstrap.persistenceCheckpoint();
    bootstrap.close();

    const staleRoot = path.join(
      userDataDir,
      STAGING_RELATIVE_PATH,
      'stale-batch'
    );
    const staleFile = path.join(staleRoot, '1', 'stale.xlsx');
    fs.mkdirSync(path.dirname(staleFile), { recursive: true });
    fs.writeFileSync(staleFile, 'stale');
    const oldDate = new Date(Date.now() - (8 * 24 * 60 * 60 * 1000));
    fs.utimesSync(staleRoot, oldDate, oldDate);

    const recovered = createPositionReconciliationService({
      userDataDir,
      templatePath: TEMPLATE_PATH,
      requireExistingSideDb: true,
      expectedSideDbCheckpoint: expectedCheckpoint,
      protectedStagingPaths
    });
    recovered.close();

    assert.equal(
      fs.existsSync(staleFile),
      true,
      `${label} 不得触发过期暂存清理`
    );
  }
});

test('pending archiveFiles 缺失或损坏时保守跳过全部过期暂存清理', (t) => {
  const invalidArchiveFiles = [
    ['缺失', undefined, true],
    ['非数组', {}, false],
    ['空项', [null], false],
    ['空路径', [{ filePath: '   ' }], false],
    ['非字符串路径', [{ filePath: 123 }], false]
  ];

  for (const [label, archiveFiles, omitField] of invalidArchiveFiles) {
    const userDataDir = fs.mkdtempSync(
      path.join(os.tmpdir(), `position-pending-archive-files-${label}-`)
    );
    t.after(() => fs.rmSync(userDataDir, { recursive: true, force: true }));
    const bootstrap = createPositionReconciliationService({
      userDataDir,
      templatePath: TEMPLATE_PATH
    });
    const expectedCheckpoint = bootstrap.persistenceCheckpoint();
    bootstrap.close();

    const staleRoot = path.join(
      userDataDir,
      STAGING_RELATIVE_PATH,
      'stale-batch'
    );
    const staleFile = path.join(staleRoot, '1', 'stale.xlsx');
    fs.mkdirSync(path.dirname(staleFile), { recursive: true });
    fs.writeFileSync(staleFile, 'stale');
    const oldDate = new Date(Date.now() - (8 * 24 * 60 * 60 * 1000));
    fs.utimesSync(staleRoot, oldDate, oldDate);

    const pending = {
      operationToken: `pending-${label}`,
      baseCheckpoint: expectedCheckpoint,
      archiveRequired: true,
      archiveState: 'intent-recorded',
      businessState: 'success'
    };
    if (!omitField) pending.archiveFiles = archiveFiles;
    const serializedPending = JSON.stringify(pending);
    const recovered = createPositionReconciliationService({
      userDataDir,
      templatePath: TEMPLATE_PATH,
      requireExistingSideDb: true,
      expectedSideDbCheckpoint: expectedCheckpoint,
      expectedPendingOperation: serializedPending,
      protectedStagingPaths: () => []
    });
    recovered.close();

    assert.throws(
      () => requirePositionPendingArchiveFiles(pending),
      /存档文件清单损坏/,
      `${label} 必须阻断恢复登记`
    );
    assert.equal(
      fs.existsSync(staleFile),
      true,
      `${label} 不得把 pending 当成空保护集`
    );

    const restarted = createPositionReconciliationService({
      userDataDir,
      templatePath: TEMPLATE_PATH,
      requireExistingSideDb: true,
      expectedSideDbCheckpoint: expectedCheckpoint,
      expectedPendingOperation: serializedPending,
      protectedStagingPaths: () => []
    });
    restarted.close();
    assert.equal(
      fs.existsSync(staleFile),
      true,
      `${label} 第二次启动仍须保留真实暂存文件`
    );
  }
});

test('pending 合法空 archiveFiles 允许清理无保护的过期暂存', (t) => {
  const userDataDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'position-pending-empty-archive-files-')
  );
  t.after(() => fs.rmSync(userDataDir, { recursive: true, force: true }));
  const bootstrap = createPositionReconciliationService({
    userDataDir,
    templatePath: TEMPLATE_PATH
  });
  const expectedCheckpoint = bootstrap.persistenceCheckpoint();
  bootstrap.close();

  const staleRoot = path.join(userDataDir, STAGING_RELATIVE_PATH, 'stale-batch');
  const staleFile = path.join(staleRoot, '1', 'stale.xlsx');
  fs.mkdirSync(path.dirname(staleFile), { recursive: true });
  fs.writeFileSync(staleFile, 'stale');
  const oldDate = new Date(Date.now() - (8 * 24 * 60 * 60 * 1000));
  fs.utimesSync(staleRoot, oldDate, oldDate);

  const recovered = createPositionReconciliationService({
    userDataDir,
    templatePath: TEMPLATE_PATH,
    requireExistingSideDb: true,
    expectedSideDbCheckpoint: expectedCheckpoint,
    expectedPendingOperation: JSON.stringify({
      operationToken: 'pending-empty-archive-files',
      baseCheckpoint: expectedCheckpoint,
      archiveFiles: []
    }),
    protectedStagingPaths: () => []
  });
  recovered.close();

  assert.equal(fs.existsSync(staleFile), false);
});

test('业务后置清理只返回没有未完成存档引用的暂存目录', () => {
  const root = path.resolve('/tmp/position-staging-filter');
  const sharedDir = path.join(root, 'shared', '1');
  const freeDir = path.join(root, 'free', '1');
  assert.deepEqual(
    filterStagingPathsWithoutProtectedSources(
      [sharedDir, freeDir],
      [path.join(sharedDir, 'bank.xlsx')]
    ),
    [freeDir]
  );
  assert.deepEqual(
    filterStagingPathsWithoutProtectedSources([sharedDir], [sharedDir]),
    []
  );
});

test('规则版本变化后持久草稿自动失效并禁止确认', (t) => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'position-ruleset-stale-'));
  const bankPath = path.join(userDataDir, 'bank.xlsx');
  const sourcePath = path.join(userDataDir, 'inbound.xlsx');
  writeWorkbook(bankPath, BANK_SHEET_NAME, BANK_STATEMENT_FIELDS, [bankRow()]);
  writeWorkbook(
    sourcePath,
    '账单明细',
    SOURCE_DEFINITIONS[SOURCE_TYPES.GATEWAY_INBOUND].headers,
    [inboundRow()]
  );
  const service = createPositionReconciliationService({
    userDataDir,
    templatePath: TEMPLATE_PATH
  });
  t.after(() => {
    service.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  });

  service.applyBankImport(service.prepareBankImport([bankPath]).token);
  assert.equal(service.prepareSourceImport([sourcePath]).successCount, 1);
  const run = service.run({ channels: ['DBS'], months: ['2026-07'] });
  const snapshot = service.store.getRun(run.runId).snapshot;
  snapshot.rulesetVersion = 0;
  service.store.db.prepare(
    'UPDATE position_runs SET snapshot_json = ? WHERE id = ?'
  ).run(JSON.stringify(snapshot), run.runId);

  assert.equal(service.status().pendingRun.stale, true);
  assert.throws(
    () => service.confirmRun(run.runId),
    (error) => error && error.code === 'position-run-stale'
  );
});

test('已初始化的平盘侧库缺失或被替换为空库时必须阻断，不得静默重建', (t) => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'position-side-db-guard-'));
  const dbPath = path.join(userDataDir, POSITION_DB_RELATIVE_PATH);
  t.after(() => fs.rmSync(userDataDir, { recursive: true, force: true }));

  const initialized = createPositionReconciliationService({
    userDataDir,
    templatePath: TEMPLATE_PATH
  });
  const checkpoint = initialized.persistenceCheckpoint();
  initialized.close();
  assert.equal(fs.existsSync(dbPath), true);

  fs.rmSync(dbPath);
  assert.throws(
    () => createPositionReconciliationService({
      userDataDir,
      templatePath: TEMPLATE_PATH,
      requireExistingSideDb: true,
      expectedSideDbCheckpoint: checkpoint
    }),
    (error) => error && error.code === 'position-side-db-missing'
  );

  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  fs.writeFileSync(dbPath, '');
  assert.throws(
    () => createPositionReconciliationService({
      userDataDir,
      templatePath: TEMPLATE_PATH,
      requireExistingSideDb: true,
      expectedSideDbCheckpoint: checkpoint
    }),
    (error) => error && error.code === 'position-side-db-missing'
  );
});

test('首次 bootstrap 只绑定同一份 generation 0 侧库，旧 marker 和既有现代库均不得接管', (t) => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'position-side-db-bootstrap-'));
  const unrelatedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'position-side-db-unrelated-'));
  const markerOnlyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'position-side-db-marker-only-'));
  const dbPath = path.join(userDataDir, POSITION_DB_RELATIVE_PATH);
  const markerOnlyPath = path.join(markerOnlyDir, POSITION_DB_RELATIVE_PATH);
  const bootstrap = {
    identity: 'bootstrap-identity',
    generation: 0,
    token: 'bootstrap-token'
  };
  t.after(() => {
    fs.rmSync(userDataDir, { recursive: true, force: true });
    fs.rmSync(unrelatedDir, { recursive: true, force: true });
    fs.rmSync(markerOnlyDir, { recursive: true, force: true });
  });

  const initialized = createPositionReconciliationService({
    userDataDir,
    templatePath: TEMPLATE_PATH,
    initialSideDbCheckpoint: bootstrap
  });
  assert.deepEqual(initialized.persistenceCheckpoint(), bootstrap);
  initialized.close();

  const recoveredBootstrap = createPositionReconciliationService({
    userDataDir,
    templatePath: TEMPLATE_PATH,
    initialSideDbCheckpoint: bootstrap
  });
  assert.deepEqual(recoveredBootstrap.persistenceCheckpoint(), bootstrap);
  recoveredBootstrap.close();

  assert.throws(
    () => createPositionReconciliationService({
      userDataDir,
      templatePath: TEMPLATE_PATH
    }),
    (error) => error && error.code === 'position-side-db-mismatch',
    '主库无 checkpoint/bootstrap 时不得接管已有现代侧库'
  );

  const unrelated = createPositionReconciliationService({
    userDataDir: unrelatedDir,
    templatePath: TEMPLATE_PATH
  });
  unrelated.close();
  assert.throws(
    () => createPositionReconciliationService({
      userDataDir: unrelatedDir,
      templatePath: TEMPLATE_PATH,
      initialSideDbCheckpoint: bootstrap
    }),
    (error) => error && error.code === 'position-side-db-mismatch',
    '另一份现代侧库不得被新的 bootstrap 接管'
  );

  fs.mkdirSync(path.dirname(markerOnlyPath), { recursive: true });
  const markerOnly = new DatabaseSync(markerOnlyPath);
  markerOnly.exec('CREATE TABLE position_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);');
  markerOnly.prepare('INSERT INTO position_meta(key, value) VALUES (?, ?)').run(
    'position_database_initialized_v1',
    '1'
  );
  markerOnly.close();
  assert.throws(
    () => createPositionReconciliationService({
      userDataDir: markerOnlyDir,
      templatePath: TEMPLATE_PATH,
      initialSideDbCheckpoint: bootstrap
    }),
    (error) => error && error.code === 'position-side-db-missing',
    '仅有旧 marker 的残缺库不得被补成空库'
  );
});

test('checkpoint 父链允许线性追平并阻断新旧 generation 分叉', (t) => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'position-side-db-checkpoint-'));
  const dbPath = path.join(userDataDir, POSITION_DB_RELATIVE_PATH);
  const backupPath = path.join(userDataDir, 'position-data-t1.sqlite');
  const divergedUserDataDir = path.join(userDataDir, 'diverged');
  const divergedDbPath = path.join(divergedUserDataDir, POSITION_DB_RELATIVE_PATH);
  const bankPath = path.join(userDataDir, 'bank.xlsx');
  t.after(() => fs.rmSync(userDataDir, { recursive: true, force: true }));

  const initialService = createPositionReconciliationService({
    userDataDir,
    templatePath: TEMPLATE_PATH
  });
  const initialCheckpoint = initialService.persistenceCheckpoint();
  initialService.close();
  fs.copyFileSync(dbPath, backupPath);

  writeWorkbook(bankPath, BANK_SHEET_NAME, BANK_STATEMENT_FIELDS, [bankRow({
    BizId: 'CHECKPOINT-T2'
  })]);
  const currentService = createPositionReconciliationService({
    userDataDir,
    templatePath: TEMPLATE_PATH,
    requireExistingSideDb: true,
    expectedSideDbCheckpoint: initialCheckpoint,
    operationTokenProvider: () => 'linear-operation'
  });
  const prepared = currentService.prepareBankImport([bankPath]);
  currentService.applyBankImport(prepared.token);
  const currentCheckpoint = currentService.persistenceCheckpoint();
  assert.ok(currentCheckpoint.generation > initialCheckpoint.generation);
  assert.notEqual(currentCheckpoint.token, initialCheckpoint.token);
  assert.equal(currentCheckpoint.identity, initialCheckpoint.identity);
  currentService.close();

  assert.throws(
    () => createPositionReconciliationService({
      userDataDir,
      templatePath: TEMPLATE_PATH,
      requireExistingSideDb: true,
      expectedSideDbCheckpoint: initialCheckpoint
    }),
    (error) => error && error.code === 'position-side-db-mismatch',
    '仅恢复旧主库、没有待完成操作记录时不得沿父链误追平'
  );
  const recoveredAfterMainCheckpointLag = createPositionReconciliationService({
    userDataDir,
    templatePath: TEMPLATE_PATH,
    requireExistingSideDb: true,
    expectedSideDbCheckpoint: initialCheckpoint,
    expectedPendingOperation: {
      operationToken: 'linear-operation',
      baseCheckpoint: initialCheckpoint
    }
  });
  assert.deepEqual(recoveredAfterMainCheckpointLag.persistenceCheckpoint(), currentCheckpoint);
  recoveredAfterMainCheckpointLag.close();

  fs.mkdirSync(path.dirname(divergedDbPath), { recursive: true });
  fs.copyFileSync(backupPath, divergedDbPath);
  const divergedService = createPositionReconciliationService({
    userDataDir: divergedUserDataDir,
    templatePath: TEMPLATE_PATH,
    requireExistingSideDb: true,
    expectedSideDbCheckpoint: initialCheckpoint,
    operationTokenProvider: () => 'diverged-operation'
  });
  divergedService.saveMappings([]);
  divergedService.saveMappings([{
    midAccountId: 'DIVERGED-MID',
    clearingAccountId: 'DIVERGED-CLEARING'
  }]);
  const divergedCheckpoint = divergedService.persistenceCheckpoint();
  assert.equal(divergedCheckpoint.identity, currentCheckpoint.identity);
  assert.ok(divergedCheckpoint.generation > currentCheckpoint.generation);
  divergedService.close();
  assert.throws(
    () => createPositionReconciliationService({
      userDataDir: divergedUserDataDir,
      templatePath: TEMPLATE_PATH,
      requireExistingSideDb: true,
      expectedSideDbCheckpoint: currentCheckpoint,
      expectedPendingOperation: {
        operationToken: 'diverged-operation',
        baseCheckpoint: currentCheckpoint
      }
    }),
    (error) => error && error.code === 'position-side-db-mismatch'
  );

  for (const suffix of ['', '-wal', '-shm']) {
    fs.rmSync(`${dbPath}${suffix}`, { force: true });
  }
  fs.copyFileSync(backupPath, dbPath);

  assert.throws(
    () => createPositionReconciliationService({
      userDataDir,
      templatePath: TEMPLATE_PATH,
      requireExistingSideDb: true,
      expectedSideDbCheckpoint: currentCheckpoint
    }),
    (error) => error && error.code === 'position-side-db-mismatch'
  );
  assert.throws(
    () => createPositionReconciliationService({
      userDataDir,
      templatePath: TEMPLATE_PATH,
      requireExistingSideDb: true,
      expectedSideDbCheckpoint: {
        ...initialCheckpoint,
        token: 'same-generation-different-history'
      }
    }),
    (error) => error && error.code === 'position-side-db-mismatch'
  );

  const restoredTogether = createPositionReconciliationService({
    userDataDir,
    templatePath: TEMPLATE_PATH,
    requireExistingSideDb: true,
    expectedSideDbCheckpoint: initialCheckpoint
  });
  assert.deepEqual(restoredTogether.persistenceCheckpoint(), initialCheckpoint);
  restoredTogether.close();
});

test('运行范围、快照和汇总 JSON 语法合法但结构不完整时必须 fail-closed', (t) => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'position-run-envelope-'));
  const bankPath = path.join(userDataDir, 'bank.xlsx');
  const sourcePath = path.join(userDataDir, 'inbound.xlsx');
  writeWorkbook(bankPath, BANK_SHEET_NAME, BANK_STATEMENT_FIELDS, [bankRow()]);
  writeWorkbook(
    sourcePath,
    '账单明细',
    SOURCE_DEFINITIONS[SOURCE_TYPES.GATEWAY_INBOUND].headers,
    [inboundRow()]
  );
  const service = createPositionReconciliationService({
    userDataDir,
    templatePath: TEMPLATE_PATH
  });
  t.after(() => {
    service.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  });

  service.applyBankImport(service.prepareBankImport([bankPath]).token);
  assert.equal(service.prepareSourceImport([sourcePath]).successCount, 1);
  const run = service.run({ channels: ['DBS'], months: ['2026-07'] });
  const stored = service.store.db.prepare(
    'SELECT scope_json, snapshot_json, summary_json FROM position_runs WHERE id = ?'
  ).get(run.runId);
  const scopeWithUnusedChannel = JSON.parse(stored.scope_json);
  scopeWithUnusedChannel.channels.push('UNUSED');
  const summaryWithoutManualCount = JSON.parse(stored.summary_json);
  delete summaryWithoutManualCount.manualModifiedRows;
  for (const [column, invalidValue] of [
    ['scope_json', JSON.stringify(scopeWithUnusedChannel)],
    ['snapshot_json', '{"rulesetVersion":1}'],
    ['summary_json', JSON.stringify(summaryWithoutManualCount)]
  ]) {
    service.store.db.prepare(
      `UPDATE position_runs SET ${column} = ? WHERE id = ?`
    ).run(invalidValue, run.runId);
    assert.throws(
      () => service.store.getRun(run.runId),
      (error) => error && error.code === 'position-side-data-invalid',
      `${column} 缺字段时必须阻断`
    );
    service.store.db.prepare(
      `UPDATE position_runs SET ${column} = ? WHERE id = ?`
    ).run(stored[column], run.runId);
  }

  const jointlyTamperedSnapshot = JSON.parse(stored.snapshot_json);
  const jointlyTamperedSummary = JSON.parse(stored.summary_json);
  jointlyTamperedSnapshot.sources = {};
  jointlyTamperedSummary.sourceTypes = [];
  service.store.db.prepare(`
    UPDATE position_runs SET snapshot_json = ?, summary_json = ? WHERE id = ?
  `).run(
    JSON.stringify(jointlyTamperedSnapshot),
    JSON.stringify(jointlyTamperedSummary),
    run.runId
  );
  assert.throws(
    () => service.store.getRun(run.runId),
    (error) => error && error.code === 'position-side-data-invalid',
    '快照和汇总共同篡改来源集合也必须由原始运行行识别'
  );

  const tamperedConflictSummary = JSON.parse(stored.summary_json);
  tamperedConflictSummary.engine.confirmedConsumptionConflicts += 1;
  service.store.db.prepare(`
    UPDATE position_runs SET snapshot_json = ?, summary_json = ? WHERE id = ?
  `).run(stored.snapshot_json, JSON.stringify(tamperedConflictSummary), run.runId);
  assert.throws(
    () => service.store.getRun(run.runId),
    (error) => error && error.code === 'position-side-data-invalid',
    '已确认消费冲突计数必须与逐行血缘一致'
  );
});
