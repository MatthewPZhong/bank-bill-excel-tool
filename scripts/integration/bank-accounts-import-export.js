// 设置 · 账户管理（清结算系统银行账户表）集成验证（真实 AppDatabase 完整启动迁移 + 真实模板文件服务）
//   覆盖：首次启动为空且迁移可重复执行；.xlsx 导入后按渠道查询、重启后仍在、另存为与原文件字节一致；
//         .xls 整份替换并清理旧原文件；模板文件启用新结构后只认新结构、缺「银行/通道简称」的结构被模板预检拒绝；
//         失败的导入不改变已有账户表；原文件被改动时拒绝导出。
//
// 账户管理的表头识别结构取模板文件「清结算银行账户表」当前版本（与平盘共用）；原文件存 {userData}/bank-accounts/。
// 用法：node scripts/integration/bank-accounts-import-export.js

'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const XLSX = require('xlsx');

const { AppDatabase } = require('../../src/backend/database');
const { createTemplateResourceService } = require('../../src/main-process/template-resources/service');
const { STRUCTURE_RESOURCE_ID, createBankAccountService } = require('../../src/main-process/bank-accounts/service');
const { SOURCE_DEFINITIONS, SOURCE_TYPES } = require('../../src/main-process/position-reconciliation/constants');

const ROOT = path.resolve(__dirname, '..', '..');
const HEADERS = [...SOURCE_DEFINITIONS[SOURCE_TYPES.BANK_ACCOUNT].headers];
const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

function accountRows(headers, specs) {
  return specs.map(([channel, account, status = '正常']) => headers.map((header) => {
    if (header === '银行/通道简称') return channel;
    if (header === '银行账号') return account;
    if (header === '账户状态') return status;
    if (header === '币种') return 'USD';
    return '';
  }));
}

function writeWorkbook(filePath, headers, rows, bookType = 'xlsx') {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([headers, ...rows]), '账户');
  XLSX.writeFile(workbook, filePath, { bookType });
  return filePath;
}

async function run() {
  console.log('==== 账户管理 导入与导出 集成验证 ====');
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'bank-accounts-import-export-'));
  const userData = path.join(temporary, 'userData');
  const files = path.join(temporary, 'files');
  const outputs = path.join(temporary, 'outputs');
  for (const directory of [userData, files, outputs]) fs.mkdirSync(directory, { recursive: true });
  const dbPath = path.join(userData, 'tool-data.sqlite');
  const storedDirectory = path.join(userData, 'bank-accounts');
  let database = new AppDatabase(dbPath);
  database.init();
  const services = () => {
    const templates = createTemplateResourceService({ appRoot: ROOT, appVersion: 'integration', userDataRoot: userData, store: database });
    const accounts = createBankAccountService({
      userDataRoot: userData,
      store: database,
      appVersion: 'integration',
      resolveStructure: () => templates.currentInputStructure(STRUCTURE_RESOURCE_ID)
    });
    return { templates, accounts };
  };
  let { templates, accounts } = services();
  const importFile = async (filePath) => {
    accounts.rememberPickedFile(filePath);
    const prepared = await accounts.prepareImport({ filePath });
    if (prepared.status !== 'success') return { prepared };
    return { prepared, committed: await accounts.commitImport({ importToken: prepared.importToken }) };
  };
  const firstFile = writeWorkbook(path.join(files, '银行账户信息.xlsx'), HEADERS, accountRows(HEADERS, [
    ['招商银行', '6222000001'], ['花旗', '6222000002', '注销'], ['招商银行', '6222000003'], ['', '6222000004']
  ]));
  const results = [];

  const cases = [
    ['首次启动账户表为空；迁移重复执行不报错、不改变数据', async () => {
      assert.deepEqual(await accounts.getOverview(), { status: 'success', channelHeader: '银行/通道简称', snapshot: null, channels: [] });
      database.ensureBankAccountSnapshotSupport();
      database.close();
      database = new AppDatabase(dbPath);
      database.init();
      ({ templates, accounts } = services());
      assert.equal(database.readBankAccountSnapshot(), null);
      assert.equal((await accounts.exportOriginal({ targetPath: path.join(outputs, 'none.xlsx') })).message, '尚未导入银行账户信息');
    }],
    ['导入 .xlsx：全部数据行入库（含注销），按渠道查询；重启后仍在，另存为与原文件字节一致', async () => {
      const { prepared, committed } = await importFile(firstFile);
      assert.deepEqual([prepared.rowCount, prepared.channelCount, prepared.previousRowCount, prepared.structureLabel], [4, 2, 0, 'V1']);
      assert.deepEqual([committed.status, committed.rowCount, committed.channelCount], ['success', 4, 2]);
      database.close();
      database = new AppDatabase(dbPath);
      database.init();
      ({ templates, accounts } = services());
      const overview = await accounts.getOverview();
      assert.deepEqual(overview.channels, [{ channel: '花旗', rowCount: 1 }, { channel: '招商银行', rowCount: 2 }]);
      assert.deepEqual([overview.snapshot.fileName, overview.snapshot.rowCount, overview.snapshot.headers.length], ['银行账户信息.xlsx', 4, 40]);
      const merchants = accounts.list({ channel: '招商银行' });
      assert.deepEqual(merchants.rows.map((row) => [row.excelRowNumber, row.values[HEADERS.indexOf('银行账号')]]), [[2, '6222000001'], [4, '6222000003']]);
      assert.equal(accounts.list({}).total, 4);
      assert.equal(accounts.listAccounts({ channel: '花旗' })[0].record['账户状态'], '注销');
      const target = path.join(outputs, '导出.xlsx');
      assert.deepEqual(await accounts.exportOriginal({ targetPath: target }), { status: 'success', filePath: target, fileName: '导出.xlsx' });
      assert.equal(sha256(fs.readFileSync(target)), sha256(fs.readFileSync(firstFile)));
    }],
    ['导入 .xls 整份替换：扩展名保留，旧原文件被清理，导出为新文件', async () => {
      const xls = writeWorkbook(path.join(files, '账户-biff.xls'), HEADERS, accountRows(HEADERS, [['汇丰', '8800001']]), 'biff8');
      const { prepared, committed } = await importFile(xls);
      assert.equal(prepared.previousRowCount, 4);
      assert.equal(committed.status, 'success');
      const overview = await accounts.getOverview();
      assert.deepEqual([overview.snapshot.fileExtension, overview.snapshot.rowCount, overview.channels.map((item) => item.channel)], ['xls', 1, ['汇丰']]);
      assert.deepEqual(fs.readdirSync(storedDirectory), [`${sha256(fs.readFileSync(xls))}.xls`]);
      const target = path.join(outputs, '导出.xls');
      assert.equal((await accounts.exportOriginal({ targetPath: target })).status, 'success');
      assert.equal(sha256(fs.readFileSync(target)), sha256(fs.readFileSync(xls)));
    }],
    ['模板文件启用改名后的新结构：旧结构文件被拒并列出差异，新结构文件导入成功；恢复默认后回到内置结构', async () => {
      const renamed = HEADERS.map((header) => (header === '备注' ? '说明' : header));
      const versionFile = writeWorkbook(path.join(files, '清结算银行账户表-新结构.xlsx'), renamed, []);
      templates.rememberPickedFile(versionFile);
      const preparedVersion = await templates.prepareImport({ resourceId: STRUCTURE_RESOURCE_ID, filePath: versionFile });
      assert.equal(preparedVersion.status, 'success', preparedVersion.message);
      assert.notEqual(preparedVersion.verdict, 'fail', JSON.stringify(preparedVersion.checks));
      assert.equal((await templates.commitImport({ importToken: preparedVersion.importToken, enable: true })).status, 'success');

      const before = database.readBankAccountSnapshot();
      const { prepared } = await importFile(firstFile);
      assert.equal(prepared.status, 'failed');
      assert.equal(prepared.message, '无法识别为清结算银行账户表：银行账户信息.xlsx');
      assert.ok(prepared.detailLines.some((line) => line.includes('当前版本 V2')), prepared.detailLines.join('\n'));
      assert.ok(prepared.detailLines.some((line) => line.includes('应为「说明」，实际为「备注」')), prepared.detailLines.join('\n'));
      assert.deepEqual(database.readBankAccountSnapshot(), before, '失败的导入不改变已有账户表');

      const renamedFile = writeWorkbook(path.join(files, '新结构账户.xlsx'), renamed, accountRows(renamed, [['招商银行', '1'], ['招商银行', '2']]));
      const imported = await importFile(renamedFile);
      assert.equal(imported.committed.status, 'success');
      const overview = await accounts.getOverview();
      assert.deepEqual([overview.snapshot.structureLabel, overview.snapshot.headers.includes('说明'), overview.snapshot.rowCount], ['V2', true, 2]);

      assert.equal((await templates.setCurrentVersion({ resourceId: STRUCTURE_RESOURCE_ID, versionId: 'v1', expectedVersionId: 'v2' })).status, 'success');
      assert.equal((await importFile(firstFile)).committed.status, 'success');
      assert.equal((await accounts.getOverview()).snapshot.structureLabel, 'V1');
    }],
    ['模板文件导入缺「银行/通道简称」的新结构时预检不通过', async () => {
      const missing = HEADERS.map((header) => (header === '银行/通道简称' ? '银行简称' : header));
      const versionFile = writeWorkbook(path.join(files, '清结算银行账户表-缺渠道列.xlsx'), missing, []);
      templates.rememberPickedFile(versionFile);
      const prepared = await templates.prepareImport({ resourceId: STRUCTURE_RESOURCE_ID, filePath: versionFile });
      assert.equal(prepared.status, 'success', prepared.message);
      assert.equal(prepared.verdict, 'fail');
      assert.ok(prepared.checks.some((check) => check.status === 'fail' && check.detail.includes('银行/通道简称')), JSON.stringify(prepared.checks));
      await templates.discardImport(prepared.importToken);
    }],
    ['原文件被改动或缺失时拒绝导出，已有导出目标不被改写', async () => {
      const target = path.join(outputs, '用户已有.xlsx');
      fs.writeFileSync(target, 'user document');
      const [stored] = fs.readdirSync(storedDirectory);
      const storedPath = path.join(storedDirectory, stored);
      const original = fs.readFileSync(storedPath);
      fs.appendFileSync(storedPath, 'x');
      assert.deepEqual(await accounts.exportOriginal({ targetPath: target }),
        { status: 'failed', message: '原表文件已被修改，请重新导入银行账户信息', detailLines: [] });
      fs.rmSync(storedPath);
      assert.equal((await accounts.exportOriginal({ targetPath: target })).message, '原表文件缺失，请重新导入银行账户信息');
      assert.equal(fs.readFileSync(target, 'utf8'), 'user document');
      fs.writeFileSync(storedPath, original);
      assert.equal((await accounts.exportOriginal({ targetPath: target })).status, 'success');
    }]
  ];

  try {
    for (const [label, body] of cases) {
      try {
        // eslint-disable-next-line no-await-in-loop
        await body();
        results.push({ label, ok: true });
        console.log(`PASS ${label}`);
      } catch (error) {
        results.push({ label, ok: false, error });
        console.log(`FAIL ${label}\n  ${error && error.stack ? error.stack : error}`);
      }
    }
  } finally {
    try { database.close(); } catch (_error) { /* 已关闭 */ }
    fs.rmSync(temporary, { recursive: true, force: true });
  }

  const passed = results.filter((item) => item.ok).length;
  console.log(`\n==== ${passed}/${results.length} PASS ====`);
  if (passed !== results.length) {
    console.error('FAILURES:');
    results.filter((item) => !item.ok).forEach((item) => console.error(`  - ${item.label}: ${item.error && item.error.message}`));
    process.exit(1);
  }
}

run().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
