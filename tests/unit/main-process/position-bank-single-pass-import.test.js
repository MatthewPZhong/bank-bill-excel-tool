'use strict';

// v3.2.22：平盘银行对账单单遍导入（spec changes/v3.2.22/feat/position-single-pass-import §3.3）。
//   一次解析直接写入未提交的事务；确认即提交，取消 / 文件有问题即回滚，库内数据不变。
//   全部经真实导入进程执行，不替换 dispatcher。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const XLSX = require('xlsx');

const { createPositionReconciliationService } = require('../../../src/main-process/position-reconciliation/service');
const { BANK_SHEET_NAME, POSITION_BANK_ROW_FIELDS } = require('../../../src/main-process/position-reconciliation/constants');
const { STAGING_RELATIVE_PATH } = require('../../../src/main-process/position-reconciliation/input-staging');
const { BANK_STATEMENT_FIELDS } = require('../../../src/constants/bank-statement-fields');

const ROOT = path.resolve(__dirname, '../../..');
const TEMPLATE_PATH = path.join(ROOT, 'assets', '平盘银行对账单.xlsx');
const BATCH_CONTEXT = Object.freeze({
  batchId: 401, batchNumber: '2026-11-23-001', taskRunId: 'position-bank-single-pass', taskKey: 'position-reconciliation:bank:import',
  moduleId: 'position-reconciliation', parentRunId: 'position-bank-single-pass-parent', operationKey: 'position-bank-single-pass-operation'
});

function bankRow(overrides = {}) {
  return { BizId: 'BIZ-1', BillDate: '2026-07-20', Channel: 'DBS', 地区: 'HK', MerchantId: 'M001', Currency: 'USD',
    'Credit Amount': '100', 'Debit Amount': '0', ReconciliationId: 'RID-1', FundType: 'Inbound&FX', ...overrides };
}

function writeBank(filePath, rows) {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.aoa_to_sheet([
      BANK_STATEMENT_FIELDS,
      ...rows.map((row) => BANK_STATEMENT_FIELDS.map((header) => row[header] ?? ''))
    ]),
    BANK_SHEET_NAME
  );
  XLSX.writeFile(workbook, filePath);
  return filePath;
}

function setup(t, options = {}) {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'position-bank-single-pass-'));
  let sequence = 0;
  const service = createPositionReconciliationService({
    userDataDir, templatePath: TEMPLATE_PATH, positionImportEngine: 'streaming',
    operationTokenProvider: () => `position-bank-single-pass-${++sequence}`,
    ...options
  });
  // 先关库再删目录（Windows 上顺序反了会 EBUSY）。
  t.after(() => { service.close(); fs.rmSync(userDataDir, { recursive: true, force: true }); });
  return { service, userDataDir };
}

// 与主进程一致：先取存档意图（令牌失效时在这里就拒绝），再提交。
const apply = async (service, token) => service.applyBankImport(
  token,
  BATCH_CONTEXT,
  service.bankImportArchiveIntent(token).map((file) => file.filePath)
);

async function importFile(service, filePath) {
  const prepared = await service.prepareBankImport([filePath]);
  assert.equal(prepared.status, 'needs-confirmation', JSON.stringify(prepared));
  const applied = await apply(service, prepared.token);
  assert.equal(applied.status, 'ok', JSON.stringify(applied));
  return { prepared, applied };
}

function storedBizIds(service) {
  return service.store.getBankRows().map((row) => `${row.channel}/${row.month_key}/${row.biz_id}`).sort();
}

function rawFiles(service) {
  return service.store.db.prepare(`
    SELECT version, original_name AS name, row_count AS rows, status,
           operation_token AS token, archive_batch_number AS batch
    FROM position_raw_files
    ORDER BY version
  `).all().map((row) => ({ ...row, version: Number(row.version), rows: Number(row.rows) }));
}

function stagingJobs(userDataDir) {
  const root = path.join(userDataDir, STAGING_RELATIVE_PATH);
  return fs.existsSync(root) ? fs.readdirSync(root) : [];
}

test('不覆盖已有数据：一次读取后无需确认内容，提交后行、文件凭证与 checkpoint 一致', async (t) => {
  const { service, userDataDir } = setup(t);
  const file = writeBank(path.join(userDataDir, 'bank.xlsx'), [
    bankRow({ BizId: 'BIZ-1' }),
    bankRow({ BizId: 'BIZ-2', BillDate: '2026-08-02' })
  ]);
  const before = service.store.persistenceCheckpoint();
  const prepared = await service.prepareBankImport([file]);
  assert.equal(prepared.status, 'needs-confirmation');
  assert.equal(prepared.rowCount, 2);
  assert.deepEqual(prepared.existing, []);
  assert.deepEqual(prepared.scopes, [
    { channel: 'DBS', monthKey: '2026-07' },
    { channel: 'DBS', monthKey: '2026-08' }
  ]);
  // 确认前事务未提交：库里还没有数据，checkpoint 没动。
  assert.deepEqual(storedBizIds(service), []);
  assert.deepEqual(service.store.persistenceCheckpoint(), before);

  const applied = await apply(service, prepared.token);
  assert.equal(applied.status, 'ok', JSON.stringify(applied));
  assert.equal(applied.rowCount, 2);
  assert.deepEqual(storedBizIds(service), ['DBS/2026-07/BIZ-1', 'DBS/2026-08/BIZ-2']);
  assert.equal(service.store.persistenceCheckpoint().generation, before.generation + 1);
  const [row] = service.store.getBankRows({ months: ['2026-07'] });
  assert.equal(row.source_row_number, 2);
  assert.equal(row.source_file_name, 'bank.xlsx');
  // 行只保存交互字段，并带原始账单版本号 / 行号。
  assert.deepEqual(Object.keys(row.originalRow), [...POSITION_BANK_ROW_FIELDS]);
  assert.equal(row.originalRow.MerchantId, 'M001');
  assert.equal(row.originalRow['Credit Amount'], '100');
  assert.equal(row.originalRow['原始版本号'], 1);
  assert.equal(row.originalRow['原始行号'], 2);
  assert.deepEqual(rawFiles(service), [
    { version: 1, name: 'bank.xlsx', rows: 2, status: 'active', token: 'position-bank-single-pass-1', batch: BATCH_CONTEXT.batchNumber }
  ]);
  const proofs = service.listCommittedOperationInputs('position-bank-single-pass-1');
  assert.equal(proofs.length, 1);
  assert.match(proofs[0].sha256, /^[a-f0-9]{64}$/);
  assert.equal(proofs[0].filePath, path.resolve(applied.inputPaths[0]));
  assert.ok(fs.existsSync(applied.inputPaths[0]), '暂存副本保留给存档，直到存档完成后清理');
});

test('覆盖已有渠道 + 月份：确认前仍是旧数据，确认后整范围替换并列出被替换行数', async (t) => {
  const { service, userDataDir } = setup(t);
  await importFile(service, writeBank(path.join(userDataDir, 'old.xlsx'), [
    bankRow({ BizId: 'OLD-1' }),
    bankRow({ BizId: 'OLD-2' }),
    bankRow({ BizId: 'KEEP-1', Channel: 'HSBC' })
  ]));
  const prepared = await service.prepareBankImport([
    writeBank(path.join(userDataDir, 'new.xlsx'), [bankRow({ BizId: 'NEW-1' })])
  ]);
  assert.deepEqual(prepared.existing, [{ channel: 'DBS', monthKey: '2026-07', rowCount: 2 }]);
  assert.deepEqual(
    storedBizIds(service),
    ['DBS/2026-07/OLD-1', 'DBS/2026-07/OLD-2', 'HSBC/2026-07/KEEP-1'],
    '等待确认期间其他连接看到的仍是旧数据'
  );
  assert.deepEqual(rawFiles(service).map((file) => [file.version, file.status]), [[1, 'active']]);
  assert.equal((await apply(service, prepared.token)).status, 'ok');
  assert.deepEqual(storedBizIds(service), ['DBS/2026-07/NEW-1', 'HSBC/2026-07/KEEP-1']);
  // 旧版本仍有行（HSBC 未被替换）时保持「当前」；新文件得到下一个版本号。
  assert.deepEqual(
    rawFiles(service).map((file) => [file.version, file.name, file.rows, file.status]),
    [[1, 'old.xlsx', 3, 'active'], [2, 'new.xlsx', 1, 'active']]
  );
  assert.deepEqual(
    service.store.getBankRows().map((row) => [row.biz_id, row.originalRow['原始版本号']]).sort(),
    [['KEEP-1', 1], ['NEW-1', 2]]
  );
  // 再把 HSBC 也替换掉：版本 1 的行全部不在了，标为「已被替换」，版本记录保留用于追溯原件。
  await importFile(service, writeBank(path.join(userDataDir, 'hsbc.xlsx'), [bankRow({ BizId: 'KEEP-2', Channel: 'HSBC' })]));
  assert.deepEqual(
    rawFiles(service).map((file) => [file.version, file.status]),
    [[1, 'superseded'], [2, 'active'], [3, 'active']]
  );
  // 数据管理接口带出版本清单（新版本在前，含已被替换的）；默认清单只列当前版本。
  assert.deepEqual(
    service.dataManager().rawFiles.map((file) => [file.version, file.fileName, file.status]),
    [[3, 'hsbc.xlsx', 'active'], [2, 'new.xlsx', 'active'], [1, 'old.xlsx', 'superseded']]
  );
  assert.deepEqual(service.store.listRawFiles().map((file) => file.version), [3, 2]);
});

test('取消确认：导入整体回滚，库内数据、checkpoint 不变，暂存目录清理，之后可继续写', async (t) => {
  const { service, userDataDir } = setup(t);
  await importFile(service, writeBank(path.join(userDataDir, 'old.xlsx'), [bankRow({ BizId: 'OLD-1' })]));
  const jobsBefore = stagingJobs(userDataDir);
  const before = service.store.persistenceCheckpoint();
  const prepared = await service.prepareBankImport([
    writeBank(path.join(userDataDir, 'new.xlsx'), [bankRow({ BizId: 'NEW-1' })])
  ]);
  assert.equal(prepared.existing.length, 1);
  assert.deepEqual(await service.cancelBankImport(), { status: 'cancelled' });
  assert.deepEqual(storedBizIds(service), ['DBS/2026-07/OLD-1']);
  assert.deepEqual(service.store.persistenceCheckpoint(), before);
  assert.deepEqual(stagingJobs(userDataDir), jobsBefore, '被取消的导入不留暂存目录');
  assert.deepEqual(rawFiles(service).map((file) => [file.version, file.status]), [[1, 'active']], '被取消的导入不留版本记录');
  await assert.rejects(
    () => apply(service, prepared.token),
    (error) => error.code === 'position-bank-import-token-expired'
  );
  // 写锁已释放：再次导入正常提交。
  await importFile(service, writeBank(path.join(userDataDir, 'again.xlsx'), [bankRow({ BizId: 'NEW-2' })]));
  assert.deepEqual(storedBizIds(service), ['DBS/2026-07/NEW-2']);
});

test('确认写入的任务未接管时按令牌放弃：等待中的导入回滚并释放写锁，重复放弃无副作用', async (t) => {
  const { service, userDataDir } = setup(t);
  await importFile(service, writeBank(path.join(userDataDir, 'old.xlsx'), [bankRow({ BizId: 'OLD-1' })]));
  const jobsBefore = stagingJobs(userDataDir);
  const before = service.store.persistenceCheckpoint();
  const prepared = await service.prepareBankImport([
    writeBank(path.join(userDataDir, 'new.xlsx'), [bankRow({ BizId: 'NEW-1' })])
  ]);
  // 导入进程握着未提交的事务：此时其他写操作被拒。
  assert.throws(
    () => service.assertNoImportHoldingWriteLock(),
    (error) => error.code === 'position-bank-import-awaiting-confirmation'
  );

  await service.abandonPreparedBankImport(prepared.token);
  await service.abandonPreparedBankImport(prepared.token);
  await service.abandonPreparedBankImport('unknown-token');

  service.assertNoImportHoldingWriteLock();
  assert.deepEqual(storedBizIds(service), ['DBS/2026-07/OLD-1']);
  assert.deepEqual(service.store.persistenceCheckpoint(), before);
  assert.deepEqual(stagingJobs(userDataDir), jobsBefore, '被放弃的导入不留暂存目录');
  await assert.rejects(
    () => apply(service, prepared.token),
    (error) => error.code === 'position-bank-import-token-expired'
  );
  await importFile(service, writeBank(path.join(userDataDir, 'again.xlsx'), [bankRow({ BizId: 'NEW-2' })]));
  assert.deepEqual(storedBizIds(service), ['DBS/2026-07/NEW-2']);
});

test('存档清单已登记暂存文件后放弃导入：只回滚事务并释放写锁，暂存文件留给存档结算', async (t) => {
  // 确认写入的任务先把暂存文件登记进待完成操作，再去拿模块锁；锁被占时放弃导入不能删掉已登记的文件。
  let pendingFiles = [];
  const { service, userDataDir } = setup(t, { protectedStagingPaths: () => pendingFiles });
  const before = service.store.persistenceCheckpoint();
  const prepared = await service.prepareBankImport([
    writeBank(path.join(userDataDir, 'new.xlsx'), [bankRow({ BizId: 'NEW-1' })])
  ]);
  const staged = service.bankImportArchiveIntent(prepared.token).map((file) => file.filePath);
  assert.equal(staged.length, 1);
  pendingFiles = staged;

  await service.abandonPreparedBankImport(prepared.token);

  service.assertNoImportHoldingWriteLock();
  assert.deepEqual(storedBizIds(service), []);
  assert.deepEqual(service.store.persistenceCheckpoint(), before);
  assert.equal(fs.existsSync(staged[0]), true, '已登记进存档清单的暂存原件必须保留');

  // 待完成操作收口后不再受保护：按原有回收路径删除。
  pendingFiles = [];
  await service.cleanupUnprotectedStagingPathsAsync([path.dirname(path.dirname(staged[0]))]);
  assert.equal(fs.existsSync(staged[0]), false);
});

test('文件存在非法行：整批拒绝并提示行号，已有数据不变', async (t) => {
  const { service, userDataDir } = setup(t);
  await importFile(service, writeBank(path.join(userDataDir, 'old.xlsx'), [bankRow({ BizId: 'OLD-1' })]));
  const before = service.store.persistenceCheckpoint();
  const rejected = await service.prepareBankImport([
    writeBank(path.join(userDataDir, 'bad.xlsx'), [
      bankRow({ BizId: 'NEW-1' }),
      bankRow({ BizId: 'NEW-2', BillDate: '不是日期' })
    ])
  ]);
  assert.equal(rejected.status, 'failed');
  assert.equal(rejected.code, 'position-bank-row-invalid');
  assert.match(rejected.message, /bad\.xlsx 第 3 行/);
  assert.match(rejected.detailLines.join('\n'), /BillDate 无法解析：不是日期/);
  // 第 2 行已写入事务、同范围旧行已在事务内删除，回滚后都应恢复原状。
  assert.deepEqual(storedBizIds(service), ['DBS/2026-07/OLD-1']);
  assert.deepEqual(service.store.persistenceCheckpoint(), before);
});

test('同一批文件内 BizId 重复：整批拒绝并指出首次出现的文件与行', async (t) => {
  const { service, userDataDir } = setup(t);
  const rejected = await service.prepareBankImport([
    writeBank(path.join(userDataDir, 'first.xlsx'), [bankRow({ BizId: 'DUP-1' })]),
    writeBank(path.join(userDataDir, 'second.xlsx'), [
      bankRow({ BizId: 'OK-1', BillDate: '2026-08-01' }),
      bankRow({ BizId: 'DUP-1', BillDate: '2026-08-02' })
    ])
  ]);
  assert.equal(rejected.status, 'failed');
  assert.equal(rejected.code, 'position-bank-row-invalid');
  assert.match(rejected.message, /second\.xlsx 第 3 行/);
  assert.deepEqual(rejected.detailLines, ['BizId 与第 1 个文件第 2 行重复']);
  assert.deepEqual(storedBizIds(service), []);
});

test('BizId 与未被本次覆盖的其他渠道 / 月份冲突：整批拒绝，两边数据都不变', async (t) => {
  const { service, userDataDir } = setup(t);
  await importFile(service, writeBank(path.join(userDataDir, 'june.xlsx'), [
    bankRow({ BizId: 'X-1', BillDate: '2026-06-10' })
  ]));
  const rejected = await service.prepareBankImport([
    writeBank(path.join(userDataDir, 'july.xlsx'), [
      bankRow({ BizId: 'X-1', BillDate: '2026-07-10' }),
      bankRow({ BizId: 'Y-1', BillDate: '2026-07-11' })
    ])
  ]);
  assert.equal(rejected.status, 'failed');
  assert.equal(rejected.code, 'position-bank-existing-bizid-conflict');
  assert.deepEqual(rejected.detailLines, ['BizId=X-1：已存在于 DBS/2026-06，本次文件位于 DBS/2026-07']);
  assert.deepEqual(storedBizIds(service), ['DBS/2026-06/X-1']);
});

test('BizId 改到另一月份、原月份在同一文件后面才出现：原月份整体替换后不算冲突', async (t) => {
  const { service, userDataDir } = setup(t);
  await importFile(service, writeBank(path.join(userDataDir, 'june.xlsx'), [
    bankRow({ BizId: 'X-1', BillDate: '2026-06-10' }),
    bankRow({ BizId: 'X-2', BillDate: '2026-06-11' })
  ]));
  const { prepared } = await importFile(service, writeBank(path.join(userDataDir, 'both.xlsx'), [
    bankRow({ BizId: 'X-1', BillDate: '2026-07-10' }),
    bankRow({ BizId: 'Z-1', BillDate: '2026-06-12' })
  ]));
  assert.deepEqual(prepared.existing, [{ channel: 'DBS', monthKey: '2026-06', rowCount: 2 }]);
  assert.deepEqual(storedBizIds(service), ['DBS/2026-06/Z-1', 'DBS/2026-07/X-1']);
  // 导入顺序号按文件行序连续，不受挂起补写影响。
  assert.deepEqual(
    service.store.getBankRows().map((row) => [row.biz_id, row.import_order]).sort((a, b) => a[1] - b[1]),
    [['X-1', 0], ['Z-1', 1]]
  );
});

test('等待确认期间其他写操作被拒绝；重新选择文件会作废上一次等待确认的导入', async (t) => {
  const { service, userDataDir } = setup(t);
  await importFile(service, writeBank(path.join(userDataDir, 'old.xlsx'), [bankRow({ BizId: 'OLD-1' })]));
  const first = await service.prepareBankImport([
    writeBank(path.join(userDataDir, 'first.xlsx'), [bankRow({ BizId: 'FIRST-1' })])
  ]);
  await assert.rejects(
    async () => service.deleteBank({ channels: ['DBS'], months: ['2026-07'] }, {}),
    (error) => error.code === 'position-bank-import-awaiting-confirmation'
  );
  assert.throws(
    () => service.store.deleteBankScopes({ channels: ['DBS'], months: ['2026-07'] }),
    (error) => error.code === 'position-bank-import-awaiting-confirmation'
  );
  const second = await service.prepareBankImport([
    writeBank(path.join(userDataDir, 'second.xlsx'), [bankRow({ BizId: 'SECOND-1' })])
  ]);
  await assert.rejects(
    () => apply(service, first.token),
    (error) => error.code === 'position-bank-import-token-expired'
  );
  assert.equal((await apply(service, second.token)).status, 'ok');
  assert.deepEqual(storedBizIds(service), ['DBS/2026-07/SECOND-1']);
});
