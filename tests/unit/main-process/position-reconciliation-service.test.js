'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const XLSX = require('xlsx');

const {
  createPositionReconciliationService,
  assertEngineResultSet
} = require('../../../src/main-process/position-reconciliation/service');
const {
  BANK_SHEET_NAME,
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
  assert.equal(service.store.listConsumedSources().length, 1);
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
