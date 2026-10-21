'use strict';

// 设置 → 模板文件：各输出模块经注入的来源取得当前版本。任务全程持有租约、结束后释放；
// 模板不可用时在改动用户已有文件或写出前中止。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const ExcelJS = require('exceljs');

const { PreFundReconciliationService } = require('../../../src/main-process/pre-fund-reconciliation/service');
const { DuplicateInboundMatchService } = require('../../../src/main-process/duplicate-inbound-match/service');
const { PositionReconciliationService } = require('../../../src/main-process/position-reconciliation/service');

const ROOT = path.join(__dirname, '..', '..', '..');
const asset = (name) => path.join(ROOT, 'assets', name);

function recordingSource(filePath, events, name) {
  return {
    acquire: async (options) => {
      events.push([name, 'acquire', options.label]);
      return { filePath, release: () => events.push([name, 'release']) };
    }
  };
}

function failingSource(events) {
  return {
    acquire: async () => {
      events.push(['acquire']);
      throw Object.assign(new Error('模板「X」当前版本 V2 不可用：版本文件缺失。请在 设置 → 模板文件 恢复默认或重新导入'), {
        code: 'template-resource-unavailable'
      });
    }
  };
}

function tempDir(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'template-consumers-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function preFundService(outputDirectory, templateSource) {
  const service = Object.create(PreFundReconciliationService.prototype);
  service.now = () => new Date(2026, 9, 19, 12, 0, 0);
  service.templatePath = asset('不存在的模板.xlsx');
  service.templateSource = templateSource;
  service.lastRun = { monthKey: '2026-10', sideRunId: 1 };
  const fileName = '资金对账不平_TEST_2026年10月19日.xlsx';
  service._buildExportPlanForCurrentRun = () => [{ channel: 'TEST', fileName, filePath: path.join(outputDirectory, fileName) }];
  service.runStore = {
    *iterateChannelExports() {
      yield { channel: 'TEST', hasDuplicateRecords: false, unbalancedRows: [], balancedRows: [], channelBillRows: [] };
    }
  };
  return { service, filePath: path.join(outputDirectory, fileName) };
}

test('资金对账导出：用当前版本写出，结束后释放；模板不可用时不备份、不改动已有文件', async (t) => {
  const directory = tempDir(t);
  const events = [];
  const { service, filePath } = preFundService(directory, recordingSource(asset('资金对账导出不平.xlsx'), events, 'prefund'));
  const result = await service.export({ outputDirectory: directory, runLocator: service.lastRun });
  assert.equal(result.status, 'ok');
  assert.ok(fs.existsSync(filePath));
  assert.deepEqual(events, [['prefund', 'acquire', '资金对账导出'], ['prefund', 'release']]);

  const failing = [];
  fs.writeFileSync(filePath, 'existing');
  const blocked = preFundService(directory, failingSource(failing)).service;
  await assert.rejects(blocked.export({ outputDirectory: directory, runLocator: blocked.lastRun, overwrite: true }),
    { code: 'template-resource-unavailable' });
  assert.deepEqual(fs.readdirSync(directory), [path.basename(filePath)]);
  assert.equal(fs.readFileSync(filePath, 'utf8'), 'existing');
});

function duplicateService(templates) {
  const service = Object.create(DuplicateInboundMatchService.prototype);
  service.recoveryLatch = null;
  service.lastRun = { monthKey: '2026-10', sideRunId: 1 };
  service.inspectLastRun = () => ({ available: true });
  service.store = { readResult: () => ({ mailRows: [{ BillDate: '2026-10-01', Channel: 'C', MerchantId: 'M', Currency: 'USD', 'Debit Amount': '1' }], manualRows: [] }) };
  Object.assign(service, templates);
  return service;
}

test('重复入金导出：邮件模板与银行对账单各取租约，写出失败也全部释放', async (t) => {
  const directory = tempDir(t);
  const events = [];
  const service = duplicateService({
    mailTemplateSource: recordingSource(asset('重复入金召回邮件模板.xlsx'), events, 'mail'),
    bankTemplateSource: recordingSource(asset('银行对账单.xlsx'), events, 'bank')
  });
  await service.export({ savePath: path.join(directory, '召回.xlsx') });
  assert.deepEqual(events, [
    ['mail', 'acquire', '重复入金导出'], ['bank', 'acquire', '重复入金导出'], ['mail', 'release'], ['bank', 'release']
  ]);

  const partial = [];
  const blocked = duplicateService({
    mailTemplateSource: recordingSource(asset('重复入金召回邮件模板.xlsx'), partial, 'mail'),
    bankTemplateSource: failingSource(partial)
  });
  await assert.rejects(blocked.export({ savePath: path.join(directory, '失败.xlsx') }), { code: 'template-resource-unavailable' });
  assert.deepEqual(partial, [['mail', 'acquire', '重复入金导出'], ['acquire'], ['mail', 'release']]);
  assert.equal(fs.existsSync(path.join(directory, '失败.xlsx')), false);
});

// 租约带有核对过的字节时，Writer 只读入这份字节：路径指向不存在的文件也能导出，说明没有按路径再次打开。
function bytesSource(relativeAsset, events, name, mutate = null) {
  return {
    acquire: async (options) => {
      events.push([name, 'acquire', options.label]);
      let bytes = fs.readFileSync(asset(relativeAsset));
      if (mutate) bytes = await mutate(bytes);
      return { filePath: asset('已被替换的版本文件.xlsx'), bytes, release: () => events.push([name, 'release']) };
    }
  };
}

test('三个输出模块在租约带字节时只读入这份字节，不再按路径打开版本文件', async (t) => {
  const directory = tempDir(t);
  const events = [];
  const prefund = preFundService(directory, bytesSource('资金对账导出不平.xlsx', events, 'prefund'));
  assert.equal((await prefund.service.export({ outputDirectory: directory, runLocator: prefund.service.lastRun })).status, 'ok');
  assert.ok(fs.existsSync(prefund.filePath));

  const duplicate = duplicateService({
    mailTemplateSource: bytesSource('重复入金召回邮件模板.xlsx', events, 'mail'),
    bankTemplateSource: bytesSource('银行对账单.xlsx', events, 'bank')
  });
  await duplicate.export({ savePath: path.join(directory, '召回.xlsx') });
  assert.ok(fs.existsSync(path.join(directory, '召回.xlsx')));

  const widened = async (bytes) => {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(bytes);
    workbook.getWorksheet('渠道对账单').getColumn(1).width = 41;
    return Buffer.from(await workbook.xlsx.writeBuffer());
  };
  const position = Object.create(PositionReconciliationService.prototype);
  position.templatePath = asset('不存在的模板.xlsx');
  position.templateSource = bytesSource('平盘银行对账单.xlsx', events, 'position', widened);
  position.store = { getBankRows: () => [{ workingRow: { Channel: 'C', BillDate: '2026-10-01' }, hit_summary: '', hit_type: '', match_detail: '' }] };
  const outputPath = path.join(directory, '平盘.xlsx');
  await position.exportBank({ channels: ['C'], months: ['2026-10'] }, outputPath);
  const written = new ExcelJS.Workbook();
  await written.xlsx.readFile(outputPath);
  assert.equal(written.getWorksheet('渠道对账单').getColumn(1).width, 41, '输出采用租约字节中的样式');
  assert.equal(events.filter(([, action]) => action === 'release').length, 4);
});

test('平盘银行数据导出：经来源取得当前版本，写出后释放', async (t) => {
  const directory = tempDir(t);
  const events = [];
  const restyled = path.join(directory, 'position-v2.xlsx');
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(asset('平盘银行对账单.xlsx'));
  workbook.getWorksheet('渠道对账单').getColumn(1).width = 33;
  await workbook.xlsx.writeFile(restyled);

  const service = Object.create(PositionReconciliationService.prototype);
  service.templatePath = asset('不存在的模板.xlsx');
  service.templateSource = recordingSource(restyled, events, 'position');
  service.store = { getBankRows: () => [{ workingRow: { Channel: 'C', BillDate: '2026-10-01' }, hit_summary: '', hit_type: '', match_detail: '' }] };
  const outputPath = path.join(directory, '平盘.xlsx');
  const result = await service.exportBank({ channels: ['C'], months: ['2026-10'] }, outputPath);
  assert.equal(result.rowCount, 1);
  assert.deepEqual(events, [['position', 'acquire', '平盘银行数据导出'], ['position', 'release']]);
  const written = new ExcelJS.Workbook();
  await written.xlsx.readFile(outputPath);
  assert.equal(written.getWorksheet('渠道对账单').getColumn(1).width, 33, '输出采用当前版本的列宽');
});
