'use strict';

// v3.2.22：平盘链接原始表单遍导入（spec changes/v3.2.22/feat/position-single-pass-import §3.1–§3.3）。
//   每个文件只解析一遍，直接写入未提交的事务；授权后一次提交，拒绝即回滚。
//   行只保存必用列并带原始版本号 / 行号。全部经真实导入进程执行，不替换 dispatcher。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const XLSX = require('xlsx');

const { createPositionReconciliationService } = require('../../../src/main-process/position-reconciliation/service');
const {
  SOURCE_DEFINITIONS,
  SOURCE_REQUIRED_FIELDS,
  SOURCE_TYPES
} = require('../../../src/main-process/position-reconciliation/constants');
const { STAGING_RELATIVE_PATH } = require('../../../src/main-process/position-reconciliation/input-staging');

const ROOT = path.resolve(__dirname, '../../..');
const TEMPLATE_PATH = path.join(ROOT, 'assets', '平盘银行对账单.xlsx');
const BATCH_CONTEXT = Object.freeze({
  batchId: 402, batchNumber: '2026-11-23-002', taskRunId: 'position-source-single-pass', taskKey: 'position-reconciliation:source:prepare-import',
  moduleId: 'position-reconciliation', parentRunId: 'position-source-single-pass-parent', operationKey: 'position-source-single-pass-operation'
});

function writeSource(filePath, sourceType, rows) {
  const headers = SOURCE_DEFINITIONS[sourceType].headers;
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.aoa_to_sheet([headers, ...rows.map((row) => headers.map((header) => row[header] ?? ''))]),
    '账单明细'
  );
  XLSX.writeFile(workbook, filePath);
  return filePath;
}

function transferRow(overrides = {}) {
  return {
    调拨单号: 'FT-1', 调拨状态: '付款成功', 渠道流水号: 'FT-RID-1', 交易时间: '2026-07-20',
    '付款账户（卡号）': 'PAY-1', '收款账户（卡号）': 'RCV-1', 付款金额: '100', 付款币种: 'USD',
    收款金额: '95', 收款币种: 'EUR', 换汇渠道: 'DBS', 附言: '备注', ...overrides
  };
}

function outboundRow(overrides = {}) {
  return {
    账单日期: '2026-07-21', 渠道名称: 'DBS', 账户号: 'ACC-1', 交易类型: 'Outbound', 主对账id: 'OUT-RID-1',
    业务单号: 'OUT-1', 币种: 'USD', 金额: '10', 原始币种: 'EUR', 原始金额: '9', 银行扣款币种: 'USD', ...overrides
  };
}

function accountRow(overrides = {}) {
  return { 账户状态: '正常', 币种: 'USD', 账户性质: '收款', 银行账号: 'BANK-1', 系统账号: 'SYS-1', 开户名称: '主体A', ...overrides };
}

function setup(t, { authorize = null } = {}) {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'position-source-single-pass-'));
  let sequence = 0;
  let currentToken = '';
  const state = { service: null, duringAuthorize: null };
  state.service = createPositionReconciliationService({
    userDataDir, templatePath: TEMPLATE_PATH, positionImportEngine: 'streaming',
    operationTokenProvider: () => currentToken,
    authorizeStreamingSourceApply: async (ready) => {
      if (authorize) return authorize(ready, state.service);
      if (state.duringAuthorize) await state.duringAuthorize(ready);
      return {
        operationToken: currentToken,
        archiveManifestHash: ready.archiveManifestHash,
        baseCheckpoint: state.service.persistenceCheckpoint()
      };
    }
  });
  // 先关库再删目录（Windows 上顺序反了会 EBUSY）。
  t.after(() => { state.service.close(); fs.rmSync(userDataDir, { recursive: true, force: true }); });
  const importSources = async (filePaths) => {
    currentToken = `position-source-single-pass-${++sequence}`;
    const prepared = await state.service.prepareSourceImportForLifecycle(filePaths);
    if (!prepared.requiresExecution) return prepared.result;
    return state.service.executePreparedSourceImport(
      prepared.plan,
      BATCH_CONTEXT,
      { executionInputPaths: prepared.inputPaths, outputs: [] }
    );
  };
  const confirmAccount = async (token) => {
    currentToken = `position-source-single-pass-${++sequence}`;
    return state.service.applySourceImport(
      token,
      BATCH_CONTEXT,
      state.service.sourceImportArchiveIntent(token).map((file) => file.filePath)
    );
  };
  return { service: state.service, state, userDataDir, importSources, confirmAccount, lastToken: () => currentToken };
}

function sourceRows(service, sourceType) {
  return service.store.db.prepare(`
    SELECT business_key AS businessKey, raw_version AS rawVersion,
           source_row_number AS rowNumber, fields_json AS fieldsJson
    FROM position_source_rows
    WHERE source_type = ?
    ORDER BY id
  `).all(sourceType).map((row) => ({
    businessKey: row.businessKey,
    rawVersion: Number(row.rawVersion),
    rowNumber: Number(row.rowNumber),
    fields: JSON.parse(row.fieldsJson)
  }));
}

function rawFiles(service) {
  return service.store.db.prepare(`
    SELECT version, kind, original_name AS name, row_count AS rows, status,
           operation_token AS token, archive_batch_number AS batch
    FROM position_raw_files
    ORDER BY version
  `).all().map((row) => ({ ...row, version: Number(row.version), rows: Number(row.rows) }));
}

function stagingJobs(userDataDir) {
  const root = path.join(userDataDir, STAGING_RELATIVE_PATH);
  return fs.existsSync(root) ? fs.readdirSync(root) : [];
}

test('多份文件一次读取、一次提交；行只保存必用列并带原始版本号与行号', async (t) => {
  const { service, userDataDir, importSources, lastToken } = setup(t);
  const transfer = writeSource(path.join(userDataDir, 'transfer.xlsx'), SOURCE_TYPES.FUND_TRANSFER, [
    transferRow(),
    transferRow({ 调拨单号: 'FT-2', 渠道流水号: 'FT-RID-2', 交易时间: '2026-08-01' })
  ]);
  const outbound = writeSource(path.join(userDataDir, 'outbound.xlsx'), SOURCE_TYPES.GATEWAY_OUTBOUND, [outboundRow()]);
  const before = service.persistenceCheckpoint();

  const result = await importSources([transfer, outbound]);
  assert.equal(result.status, 'ok', JSON.stringify(result));
  assert.equal(result.successCount, 2);
  assert.equal(result.failedCount, 0);
  // 整批只推进一次 checkpoint，两份文件的凭证记在同一个操作下。
  assert.equal(service.persistenceCheckpoint().generation, before.generation + 1);
  assert.equal(service.listCommittedOperationInputs(lastToken()).length, 2);

  const rows = sourceRows(service, SOURCE_TYPES.FUND_TRANSFER);
  assert.deepEqual(rows.map((row) => [row.businessKey, row.rawVersion, row.rowNumber]), [['FT-1', 1, 2], ['FT-2', 1, 3]]);
  assert.deepEqual(Object.keys(rows[0].fields), [...SOURCE_REQUIRED_FIELDS[SOURCE_TYPES.FUND_TRANSFER]]);
  assert.equal(rows[0].fields['付款金额'], '100');
  assert.equal(Object.hasOwn(rows[0].fields, '附言'), false);
  // 每条调拨派生两条链接行（付 / 收），币种不同故可见。
  assert.equal(service.store.countLinkedRows(SOURCE_TYPES.FUND_TRANSFER), 4);
  assert.equal(service.store.countLinkedRows(SOURCE_TYPES.GATEWAY_OUTBOUND), 1);

  assert.deepEqual(rawFiles(service), [
    { version: 1, kind: SOURCE_TYPES.FUND_TRANSFER, name: 'transfer.xlsx', rows: 2, status: 'active', token: lastToken(), batch: BATCH_CONTEXT.batchNumber },
    { version: 2, kind: SOURCE_TYPES.GATEWAY_OUTBOUND, name: 'outbound.xlsx', rows: 1, status: 'active', token: lastToken(), batch: BATCH_CONTEXT.batchNumber }
  ]);
  assert.deepEqual(service.linkedManager().rawFiles.map((file) => file.version), [2, 1]);

  // 原始表导出：必用列 + 原始版本号 / 行号。
  const exportPath = path.join(userDataDir, 'raw-export.xlsx');
  await service.exportRaw(SOURCE_TYPES.FUND_TRANSFER, exportPath);
  const exported = XLSX.utils.sheet_to_json(XLSX.readFile(exportPath).Sheets[XLSX.readFile(exportPath).SheetNames[0]], { header: 1 });
  assert.deepEqual(exported[0], [...SOURCE_REQUIRED_FIELDS[SOURCE_TYPES.FUND_TRANSFER], '原始版本号', '原始行号']);
  assert.deepEqual(exported[1].slice(-2), [1, 2]);
});

test('有非法行的文件整份拒绝，不留任何行与版本；其余文件照常提交', async (t) => {
  const { service, userDataDir, importSources } = setup(t);
  const bad = writeSource(path.join(userDataDir, 'bad.xlsx'), SOURCE_TYPES.GATEWAY_OUTBOUND, [
    outboundRow({ 业务单号: 'OUT-OK' }),
    outboundRow({ 业务单号: '' })
  ]);
  const good = writeSource(path.join(userDataDir, 'good.xlsx'), SOURCE_TYPES.FUND_TRANSFER, [transferRow()]);

  const result = await importSources([bad, good]);
  assert.equal(result.successCount, 1);
  assert.equal(result.failedCount, 1);
  assert.equal(result.results[0].code, 'position-source-row-invalid');
  assert.match(result.results[0].message, /第 3 行/);
  assert.equal(service.store.countSourceRows(SOURCE_TYPES.GATEWAY_OUTBOUND), 0);
  assert.equal(service.store.countSourceRows(SOURCE_TYPES.FUND_TRANSFER), 1);
  assert.deepEqual(rawFiles(service).map((file) => [file.kind, file.name]), [[SOURCE_TYPES.FUND_TRANSFER, 'good.xlsx']]);
});

test('完全相同的行折叠；业务单号相同但内容不同的行各自保留；仅非必用列不同视为同一条', async (t) => {
  const { service, userDataDir, importSources } = setup(t);
  const first = writeSource(path.join(userDataDir, 'first.xlsx'), SOURCE_TYPES.FUND_TRANSFER, [
    transferRow(),
    transferRow(),
    transferRow({ 附言: '只改了非必用列' }),
    transferRow({ 付款金额: '200' })
  ]);
  const second = writeSource(path.join(userDataDir, 'second.xlsx'), SOURCE_TYPES.FUND_TRANSFER, [
    transferRow(),
    transferRow({ 调拨单号: 'FT-9', 渠道流水号: 'FT-RID-9' })
  ]);

  const result = await importSources([first, second]);
  assert.equal(result.successCount, 2, JSON.stringify(result));
  assert.equal(result.results[0].rowCount, 2);
  assert.equal(result.results[0].collapsedDuplicateCount, 2);
  assert.equal(result.results[1].rowCount, 1);
  assert.equal(result.results[1].collapsedDuplicateCount, 1);
  assert.deepEqual(
    sourceRows(service, SOURCE_TYPES.FUND_TRANSFER).map((row) => [row.businessKey, row.fields['付款金额'], row.rawVersion, row.rowNumber]),
    [['FT-1', '100', 1, 2], ['FT-1', '200', 1, 5], ['FT-9', '100', 2, 3]]
  );
});

test('同一份文件再次导入不产生重复行：行改挂新版本，旧版本标为已被替换', async (t) => {
  const { service, userDataDir, importSources } = setup(t);
  const file = writeSource(path.join(userDataDir, 'transfer.xlsx'), SOURCE_TYPES.FUND_TRANSFER, [
    transferRow(),
    transferRow({ 调拨单号: 'FT-2', 渠道流水号: 'FT-RID-2' })
  ]);
  await importSources([file]);
  const linkedBefore = service.store.countLinkedRows(SOURCE_TYPES.FUND_TRANSFER);
  const again = await importSources([file]);
  assert.equal(again.successCount, 1);
  assert.equal(again.results[0].rowCount, 2);

  assert.deepEqual(
    sourceRows(service, SOURCE_TYPES.FUND_TRANSFER).map((row) => [row.businessKey, row.rawVersion]),
    [['FT-1', 2], ['FT-2', 2]]
  );
  assert.equal(service.store.countLinkedRows(SOURCE_TYPES.FUND_TRANSFER), linkedBefore);
  assert.deepEqual(rawFiles(service).map((file_) => [file_.version, file_.status]), [[1, 'superseded'], [2, 'active']]);
});

test('过滤行进入异常报告与过滤记录，带版本号与本次操作凭证', async (t) => {
  const { service, userDataDir, importSources, lastToken } = setup(t);
  const file = writeSource(path.join(userDataDir, 'transfer.xlsx'), SOURCE_TYPES.FUND_TRANSFER, [
    transferRow(),
    transferRow({ 调拨单号: 'FT-BAD', 调拨状态: '处理中', 渠道流水号: 'FT-RID-BAD', 付款金额: '' })
  ]);

  const result = await importSources([file]);
  assert.equal(result.successCount, 1, JSON.stringify(result));
  assert.equal(result.results[0].rowCount, 1);
  assert.equal(result.results[0].filteredRowCount, 1);
  assert.ok(result.anomalyReport && fs.existsSync(result.anomalyReport.filePath));

  const filtered = service.store.db.prepare(`
    SELECT business_key AS businessKey, raw_version AS rawVersion, source_row_number AS rowNumber,
           import_operation_token AS token, report_key AS reportKey, report_sha256 AS sha256,
           report_row_count AS reportRows
    FROM position_filtered_source_rows
  `).all();
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].businessKey, 'FT-BAD');
  assert.equal(Number(filtered[0].rawVersion), 1);
  assert.equal(Number(filtered[0].rowNumber), 3);
  assert.equal(filtered[0].token, lastToken());
  assert.equal(filtered[0].reportKey, result.anomalyReport.reportKey);
  assert.equal(filtered[0].sha256, result.anomalyReport.sha256);
  assert.equal(Number(filtered[0].reportRows), 1);

  // 报告明细：过滤信息 + 必用列（含原始版本号），不含其余列。
  const workbook = XLSX.readFile(result.anomalyReport.filePath);
  const detail = XLSX.utils.sheet_to_json(workbook.Sheets['调拨异常明细'], { header: 1 });
  assert.ok(detail[0].includes('原始版本号'));
  assert.ok(detail[0].includes('付款金额'));
  assert.equal(detail[0].includes('附言'), false);
  assert.equal(detail[1][detail[0].indexOf('业务单号')], 'FT-BAD');
  assert.equal(detail[1][detail[0].indexOf('原始版本号')], 1);
});

test('过滤行与后面文件的正常记录同单号：含过滤行的文件整份拒绝，后面的文件照常提交', async (t) => {
  const { service, userDataDir, importSources } = setup(t);
  const withFiltered = writeSource(path.join(userDataDir, 'filtered.xlsx'), SOURCE_TYPES.FUND_TRANSFER, [
    transferRow({ 调拨单号: 'FT-KEEP', 渠道流水号: 'FT-RID-KEEP' }),
    transferRow({ 调拨单号: 'FT-X', 调拨状态: '处理中', 付款金额: '' })
  ]);
  const withNormal = writeSource(path.join(userDataDir, 'normal.xlsx'), SOURCE_TYPES.FUND_TRANSFER, [
    transferRow({ 调拨单号: 'FT-X' })
  ]);

  const result = await importSources([withFiltered, withNormal]);
  assert.equal(result.successCount, 1, JSON.stringify(result));
  assert.equal(result.failedCount, 1);
  assert.equal(result.results[0].code, 'position-filtered-key-collision');
  assert.match(result.results[0].detailLines[0], /FT-X：同批正常记录位于第 2 个文件第 2 行/);
  assert.deepEqual(sourceRows(service, SOURCE_TYPES.FUND_TRANSFER).map((row) => row.businessKey), ['FT-X']);
  assert.equal(Number(service.store.db.prepare('SELECT COUNT(*) AS count FROM position_filtered_source_rows').get().count), 0);
  assert.deepEqual(rawFiles(service).map((file) => file.name), ['normal.xlsx']);
});

test('账户表先统计、确认后整表替换；只保存必用列，旧版本标为已被替换', async (t) => {
  const { service, userDataDir, importSources, confirmAccount } = setup(t);
  const account = writeSource(path.join(userDataDir, 'account.xlsx'), SOURCE_TYPES.BANK_ACCOUNT, [
    accountRow(),
    accountRow({ 账户状态: '注销', 银行账号: 'BANK-2' }),
    accountRow({ 银行账号: 'BANK-3', 系统账号: '' })
  ]);
  const before = service.persistenceCheckpoint();

  const prepared = await importSources([account]);
  assert.equal(prepared.confirmationCount, 1, JSON.stringify(prepared));
  const pending = prepared.results[0];
  assert.equal(pending.status, 'needs-confirmation');
  assert.equal(pending.newValidCount, 2);
  // 确认前库未改动。
  assert.equal(service.store.countSourceRows(SOURCE_TYPES.BANK_ACCOUNT), 0);
  assert.deepEqual(service.persistenceCheckpoint(), before);

  const applied = await confirmAccount(pending.token);
  assert.equal(applied.status, 'ok', JSON.stringify(applied));
  assert.equal(applied.rowCount, 2);
  const rows = sourceRows(service, SOURCE_TYPES.BANK_ACCOUNT);
  assert.deepEqual(rows.map((row) => [row.rowNumber, row.fields['银行账号']]), [[2, 'BANK-1'], [4, 'BANK-3']]);
  assert.deepEqual(Object.keys(rows[0].fields), [...SOURCE_REQUIRED_FIELDS[SOURCE_TYPES.BANK_ACCOUNT]]);
  assert.equal(service.store.countLinkedRows(SOURCE_TYPES.BANK_ACCOUNT), 2);
  assert.equal(service.persistenceCheckpoint().generation, before.generation + 1);
  // 暂存目录交回调用方：存档落盘后由任务层清理。
  assert.deepEqual(applied.cleanupPaths, [path.join(userDataDir, STAGING_RELATIVE_PATH, stagingJobs(userDataDir)[0])]);

  const second = await importSources([account]);
  await confirmAccount(second.results[0].token);
  assert.deepEqual(
    rawFiles(service).map((file) => [file.version, file.kind, file.rows, file.status]),
    [[1, SOURCE_TYPES.BANK_ACCOUNT, 2, 'superseded'], [2, SOURCE_TYPES.BANK_ACCOUNT, 2, 'active']]
  );
  assert.equal(service.store.countSourceRows(SOURCE_TYPES.BANK_ACCOUNT), 2);
});

test('写入授权被拒绝时整体回滚，库与 checkpoint 不变，暂存目录清理', async (t) => {
  const { service, userDataDir } = setup(t, {
    authorize: async () => { throw Object.assign(new Error('存档意图未能持久化'), { code: 'position-import-intent-not-durable' }); }
  });
  const file = writeSource(path.join(userDataDir, 'transfer.xlsx'), SOURCE_TYPES.FUND_TRANSFER, [transferRow()]);
  const before = service.persistenceCheckpoint();
  const prepared = await service.prepareSourceImportForLifecycle([file]);
  assert.equal(prepared.requiresExecution, true);
  await assert.rejects(
    service.executePreparedSourceImport(prepared.plan, BATCH_CONTEXT, { executionInputPaths: prepared.inputPaths, outputs: [] }),
    (error) => error.code === 'position-import-intent-not-durable'
  );
  assert.equal(service.store.countSourceRows(SOURCE_TYPES.FUND_TRANSFER), 0);
  assert.deepEqual(rawFiles(service), []);
  assert.deepEqual(service.persistenceCheckpoint(), before);
  assert.deepEqual(stagingJobs(userDataDir), []);
});

test('导入进行期间其他写操作被直接拒绝，不排队等侧库写锁', async (t) => {
  const { service, state, userDataDir, importSources } = setup(t);
  const file = writeSource(path.join(userDataDir, 'transfer.xlsx'), SOURCE_TYPES.FUND_TRANSFER, [transferRow()]);
  let blocked = null;
  state.duringAuthorize = async () => {
    try {
      service.store.saveMappings([{ midAccountId: 'A', clearingAccountId: 'B' }]);
    } catch (error) {
      blocked = error;
    }
  };
  const result = await importSources([file]);
  assert.equal(result.successCount, 1, JSON.stringify(result));
  assert.equal(blocked && blocked.code, 'position-import-in-progress');
  // 导入结束后写操作恢复可用。
  service.store.saveMappings([{ midAccountId: 'A', clearingAccountId: 'B' }]);
  assert.equal(service.listMappings().mappings.length, 1);
});
