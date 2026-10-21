// 设置 · 模板文件「用户版本」集成验证（真实主库迁移 + 真实各模块写出）
//   覆盖：导入并启用后，资金对账、重复入金、平盘、VCC 结果导出（Worker）按用户版本样式写出，表头与数据不变；
//         恢复默认后回到内置样式；版本文件被改动时导出中止并指向设置；重建服务（模拟重启）后状态保持；
//         版本文件只落 {userData}/template-resources/。
//
// 模板服务与各模块之间只经 source(resourceId).acquire 交接；本脚本按 main.js 的装配方式注入，
// 用真实 AppDatabase（完整启动迁移）保存版本元数据，各模块写出器不做替身。
// 用法：node scripts/integration/template-resources-versions.js

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ExcelJS = require('exceljs');

const { AppDatabase } = require('../../src/backend/database');
const { createTemplateResourceService } = require('../../src/main-process/template-resources/service');
const { PreFundReconciliationService } = require('../../src/main-process/pre-fund-reconciliation/service');
const { DuplicateInboundMatchService } = require('../../src/main-process/duplicate-inbound-match/service');
const { PositionReconciliationService } = require('../../src/main-process/position-reconciliation/service');
const { createVccFinancialOpService } = require('../../src/main-process/vcc-financial-op-service');
const { createResultExportFixture } = require('../../tests/helpers/vcc-result-export');
const { MAIL_HEADERS } = require('../../src/main-process/duplicate-inbound-match/excel-writer');
const { POSITION_BANK_HEADERS } = require('../../src/main-process/position-reconciliation/constants');

const ROOT = path.resolve(__dirname, '..', '..');
const MARK = 'FF00B050';

async function restyle(relativePath, targetPath, mutate) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(path.join(ROOT, ...relativePath.split('/')));
  mutate(workbook);
  await workbook.xlsx.writeFile(targetPath);
  return targetPath;
}

async function readWorkbook(filePath) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(filePath);
  return workbook;
}

const headerRow = (sheet, count) => Array.from({ length: count }, (_unused, index) => String(sheet.getRow(1).getCell(index + 1).value ?? ''));
const fillOf = (cell) => cell.fill && cell.fill.fgColor && cell.fill.fgColor.argb;
const markFill = { type: 'pattern', pattern: 'solid', fgColor: { argb: MARK } };

async function importAndEnable(service, resourceId, filePath) {
  service.rememberPickedFile(filePath);
  const prepared = await service.prepareImport({ resourceId, filePath });
  assert.equal(prepared.status, 'success', prepared.message);
  assert.notEqual(prepared.verdict, 'fail', JSON.stringify(prepared.checks));
  const committed = await service.commitImport({ importToken: prepared.importToken, enable: true });
  assert.equal(committed.status, 'success', committed.message);
  return committed.version;
}

function preFundExporter(templateSource, outputDirectory) {
  const service = Object.create(PreFundReconciliationService.prototype);
  service.now = () => new Date(2026, 9, 19, 12, 0, 0);
  service.templatePath = path.join(ROOT, 'assets', '资金对账导出不平.xlsx');
  service.templateSource = templateSource;
  service.lastRun = { monthKey: '2026-10', sideRunId: 1 };
  const fileName = '资金对账不平_IT_2026年10月19日.xlsx';
  service._buildExportPlanForCurrentRun = () => [{ channel: 'IT', fileName, filePath: path.join(outputDirectory, fileName) }];
  service.runStore = {
    *iterateChannelExports() {
      yield { channel: 'IT', hasDuplicateRecords: false, unbalancedRows: [], balancedRows: [], channelBillRows: [] };
    }
  };
  return { service, filePath: path.join(outputDirectory, fileName) };
}

function duplicateExporter(mailTemplateSource, bankTemplateSource) {
  const service = Object.create(DuplicateInboundMatchService.prototype);
  service.recoveryLatch = null;
  service.lastRun = { monthKey: '2026-10', sideRunId: 1 };
  service.inspectLastRun = () => ({ available: true });
  service.store = { readResult: () => ({
    mailRows: [{ BillDate: '2026-10-01', Channel: 'IT', MerchantId: 'M001', Currency: 'USD', 'Debit Amount': '12.34', 加款单号: 'A1' }],
    manualRows: []
  }) };
  Object.assign(service, {
    mailTemplatePath: path.join(ROOT, 'assets', '重复入金召回邮件模板.xlsx'),
    bankTemplatePath: path.join(ROOT, 'assets', '银行对账单.xlsx'),
    mailTemplateSource,
    bankTemplateSource
  });
  return service;
}

function positionExporter(templateSource) {
  const service = Object.create(PositionReconciliationService.prototype);
  service.templatePath = path.join(ROOT, 'assets', '平盘银行对账单.xlsx');
  service.templateSource = templateSource;
  service.store = { getBankRows: () => [{ workingRow: { Channel: 'IT', BillDate: '2026-10-01', 'Credit Amount': '5' }, hit_summary: '', hit_type: '', match_detail: '' }] };
  return service;
}

async function run() {
  console.log('==== 模板文件用户版本 集成验证 ====');
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'template-resources-versions-'));
  const userData = path.join(temporary, 'userData');
  const files = path.join(temporary, 'files');
  const outputs = path.join(temporary, 'outputs');
  fs.mkdirSync(userData, { recursive: true });
  fs.mkdirSync(files, { recursive: true });
  fs.mkdirSync(outputs, { recursive: true });
  const database = new AppDatabase(path.join(userData, 'tool-data.sqlite'));
  database.init();
  const cleanups = [];
  const createService = () => createTemplateResourceService({
    appRoot: ROOT, appVersion: 'integration', userDataRoot: userData, store: database
  });
  let service = createService();
  const results = [];

  const cases = [
    ['资金对账导出：启用用户版本后按该版本样式写出，恢复默认后回到内置样式', async () => {
      const file = await restyle('assets/资金对账导出不平.xlsx', path.join(files, 'prefund.xlsx'), (workbook) => {
        workbook.getWorksheet('不平结果').getCell('A1').fill = markFill;
      });
      const version = await importAndEnable(service, 'prefund-unbalanced', file);
      assert.equal(version.label, 'V2');
      const { service: exporter, filePath } = preFundExporter(service.source('prefund-unbalanced', 'pre-fund-reconciliation'), outputs);
      assert.equal((await exporter.export({ outputDirectory: outputs, runLocator: exporter.lastRun })).status, 'ok');
      const written = await readWorkbook(filePath);
      assert.equal(fillOf(written.getWorksheet('不平结果').getCell('A1')), MARK);
      assert.equal(written.getWorksheet('不平结果').getCell('A1').value, '对账数据来源');

      assert.equal((await service.setCurrentVersion({ resourceId: 'prefund-unbalanced', versionId: 'v1', expectedVersionId: 'v2' })).status, 'success');
      assert.equal((await exporter.export({ outputDirectory: outputs, runLocator: exporter.lastRun, overwrite: true })).status, 'ok');
      assert.notEqual(fillOf((await readWorkbook(filePath)).getWorksheet('不平结果').getCell('A1')), MARK);
    }],
    ['重复入金导出：邮件模板与银行对账单分别取当前版本', async () => {
      const mail = await restyle('assets/重复入金召回邮件模板.xlsx', path.join(files, 'mail.xlsx'), (workbook) => {
        workbook.worksheets[0].getColumn(1).width = 41;
      });
      const bank = await restyle('assets/银行对账单.xlsx', path.join(files, 'bank.xlsx'), (workbook) => {
        workbook.getWorksheet('渠道对账单').getCell('A1').fill = markFill;
      });
      await importAndEnable(service, 'dup-recall-mail', mail);
      await importAndEnable(service, 'bank-statement', bank);
      const exporter = duplicateExporter(
        service.source('dup-recall-mail', 'duplicate-inbound-match'),
        service.source('bank-statement', 'duplicate-inbound-match')
      );
      const savePath = path.join(outputs, '重复入金召回.xlsx');
      await exporter.export({ savePath });
      const written = await readWorkbook(savePath);
      const mailSheet = written.worksheets[0];
      assert.equal(mailSheet.getColumn(1).width, 41);
      assert.deepEqual(headerRow(mailSheet, MAIL_HEADERS.length), [...MAIL_HEADERS]);
      assert.equal(mailSheet.getCell('E2').value, '12.34');
      assert.equal(fillOf(written.worksheets[1].getCell('A1')), MARK);
    }],
    ['平盘银行数据导出：按用户版本写出且仍为 49 列', async () => {
      const file = await restyle('assets/平盘银行对账单.xlsx', path.join(files, 'position.xlsx'), (workbook) => {
        workbook.getWorksheet('渠道对账单').getColumn(4).width = 29;
      });
      await importAndEnable(service, 'position-bank', file);
      const outputPath = path.join(outputs, '平盘.xlsx');
      await positionExporter(service.source('position-bank', 'position-reconciliation-process'))
        .exportBank({ channels: ['IT'], months: ['2026-10'] }, outputPath);
      const sheet = (await readWorkbook(outputPath)).getWorksheet('渠道对账单');
      assert.equal(sheet.getColumn(4).width, 29);
      assert.deepEqual(headerRow(sheet, POSITION_BANK_HEADERS.length), [...POSITION_BANK_HEADERS]);
      assert.equal(String(sheet.getRow(1).getCell(POSITION_BANK_HEADERS.length + 1).value ?? ''), '');
    }],
    ['VCC 结果导出：Pending 计算表版本字节经 Main 交给 Worker，按该样式写出并通过正式校验', async () => {
      const file = await restyle('assets/VCC财务OP校验/移除归档Pending发生额计算表.xlsx', path.join(files, 'pending.xlsx'), (workbook) => {
        workbook.worksheets[0].getCell('A1').fill = markFill;
      });
      await importAndEnable(service, 'vcc-pending-calc', file);
      const fixture = await createResultExportFixture({ after: (fn) => cleanups.push(fn) });
      const vcc = createVccFinancialOpService({
        database: { db: fixture.db, dbPath: fixture.dbPath },
        assetsDir: fixture.assetsDir,
        pendingTemplateSource: service.source('vcc-pending-calc', 'vcc-financial-op')
      });
      cleanups.push(() => vcc.terminate());
      const target = await vcc.getArchivedRunByMonth('2026-06');
      const outputPath = path.join(fixture.dir, 'result.xlsx');
      const result = await vcc.exportRun({ targetMonth: target.targetMonth, expectedRunId: target.runId, expectedSubjects: target.subjects,
        expectedResultRevision: target.resultRevision, expectedArchivedAt: target.archivedAt, outputPaths: [outputPath] }, {});
      assert.match(result.validation.sha256, /^[0-9a-f]{64}$/);
      const written = await readWorkbook(outputPath);
      const pending = written.worksheets[target.subjects.length];
      assert.equal(pending.getCell('A1').value, 'channel');
      assert.equal(fillOf(pending.getCell('A1')), MARK);
    }],
    ['版本文件被改动：导出中止并指向设置，不生成目标文件', async () => {
      const versionFile = path.join(userData, 'template-resources', 'position-bank', 'v2.xlsx');
      assert.ok(fs.existsSync(versionFile));
      fs.appendFileSync(versionFile, Buffer.from('tamper'));
      const outputPath = path.join(outputs, '平盘-篡改.xlsx');
      await assert.rejects(
        positionExporter(service.source('position-bank', 'position-reconciliation-process'))
          .exportBank({ channels: ['IT'], months: ['2026-10'] }, outputPath),
        /当前版本 V2 不可用：版本文件已被修改.*请在 设置 → 模板文件 恢复默认或重新导入/
      );
      assert.equal(fs.existsSync(outputPath), false);
      const { resource } = await service.get('position-bank');
      assert.equal(resource.current.validation, 'failed');
    }],
    ['重建服务后版本、当前指针与变更记录保持；版本文件只在 userData/template-resources', async () => {
      service = createService();
      const listed = await service.list();
      const current = Object.fromEntries(listed.resources.filter((item) => item.current.source === 'user').map((item) => [item.id, item.current.label]));
      assert.deepEqual(current, { 'bank-statement': 'V2', 'dup-recall-mail': 'V2', 'position-bank': 'V2', 'vcc-pending-calc': 'V2' });
      const changes = service.listChanges().changes.map((change) => `${change.resourceId}:${change.action}`);
      assert.deepEqual(changes, [
        'vcc-pending-calc:导入并启用', 'position-bank:导入并启用', 'bank-statement:导入并启用',
        'dup-recall-mail:导入并启用', 'prefund-unbalanced:恢复默认', 'prefund-unbalanced:导入并启用'
      ]);
      const stored = fs.readdirSync(path.join(userData, 'template-resources')).sort();
      assert.deepEqual(stored, ['bank-statement', 'dup-recall-mail', 'position-bank', 'prefund-unbalanced', 'vcc-pending-calc']);
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
    for (const cleanup of cleanups.reverse()) {
      try {
        // eslint-disable-next-line no-await-in-loop
        await cleanup();
      } catch (_error) { /* 清理失败不覆盖结果 */ }
    }
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
  console.error(error);
  process.exit(1);
});
