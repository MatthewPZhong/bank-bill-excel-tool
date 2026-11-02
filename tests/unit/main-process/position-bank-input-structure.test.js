'use strict';

// v3.2.14：平盘银行对账单导入接受「银行对账单（导入识别结构）」当前用户版本（D17–D19）。预检开始时冻结到确认令牌，
//   真实流式 Worker 的预检与写入按同一结构读取，行对应回内置 46 列入库；内置 46 列同时接受；都不符时差异列出当前版本。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const XLSX = require('xlsx');

const { createPositionReconciliationService } = require('../../../src/main-process/position-reconciliation/service');
const { BANK_SHEET_NAME } = require('../../../src/main-process/position-reconciliation/constants');
const { BANK_STATEMENT_FIELDS } = require('../../../src/constants/bank-statement-fields');
const { bankSourceStructure } = require('../../../src/main-process/position-reconciliation/source-structures');
const { bankHeaderMismatchLines } = require('../../../src/main-process/position-reconciliation/header-mismatch');

const ROOT = path.resolve(__dirname, '../../..');
const TEMPLATE_PATH = path.join(ROOT, 'assets', '平盘银行对账单.xlsx');
const BATCH_CONTEXT = Object.freeze({
  batchId: 331, batchNumber: '2026-11-01-001', taskRunId: 'position-bank-structure', taskKey: 'position-reconciliation:bank:import',
  moduleId: 'position-reconciliation', parentRunId: 'position-bank-structure-parent', operationKey: 'position-bank-structure-operation'
});
// V2：「合并单号」按位置改名为「合并编号」，删除「分类人」（其后各列左移），末尾新增一列；必用列不动。
const BANK_V2 = [...BANK_STATEMENT_FIELDS.filter((header) => header !== '分类人').map((header) => (header === '合并单号' ? '合并编号' : header)), '新增列'];

function bankRow(overrides = {}) {
  return { BizId: 'POSITION-BIZ-1', BillDate: '2026-07-20', Channel: 'DBS', 地区: 'HK', MerchantId: 'M001', Currency: 'USD',
    'Credit Amount': '100', 'Debit Amount': '0', ReconciliationId: 'RID-1', FundType: 'Inbound&FX', ...overrides };
}
function writeBank(filePath, headers, rows) {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([headers, ...rows.map((row) => headers.map((header) => row[header] ?? ''))]), BANK_SHEET_NAME);
  XLSX.writeFile(workbook, filePath);
  return filePath;
}

function setup(t, resolveBankSourceHeaders) {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'position-bank-structure-'));
  let sequence = 0;
  const service = createPositionReconciliationService({
    userDataDir, templatePath: TEMPLATE_PATH, positionImportEngine: 'streaming',
    operationTokenProvider: () => `position-bank-structure-${++sequence}`, resolveBankSourceHeaders
  });
  t.after(() => { service.close(); fs.rmSync(userDataDir, { recursive: true, force: true }); });
  return { service, userDataDir };
}
const apply = (service, token) => service.applyBankImport(token, BATCH_CONTEXT, service.bankImportArchiveIntent(token).map((file) => file.filePath));

test('按当前版本的银行对账单经真实 Worker 预检与写入：入库为内置 46 列，改名列取新列值，删除列为空', async (t) => {
  const state = { headers: BANK_V2 };
  const { service, userDataDir } = setup(t, async () => state.headers);
  const v2File = writeBank(path.join(userDataDir, 'bank-v2.xlsx'), BANK_V2, [bankRow({ 合并编号: '合并-1', 分类人: '不在新结构中', 新增列: '不导入' })]);
  const prepared = await service.prepareBankImport([v2File]);
  assert.equal(prepared.status, 'needs-confirmation', JSON.stringify(prepared));
  // 预检后切换结构不影响本次写入（确认令牌冻结结构）。
  state.headers = null;
  const applied = await apply(service, prepared.token);
  assert.equal(applied.status, 'ok', JSON.stringify(applied));
  const [{ originalRow: stored }] = service.store.getBankRows({ channels: ['DBS'], months: ['2026-07'] });
  assert.equal(stored.BizId, 'POSITION-BIZ-1');
  assert.equal(stored['合并单号'], '合并-1');
  assert.equal(stored['分类人'], '');
  assert.equal(Object.hasOwn(stored, '合并编号'), false);
});

test('启用新结构时内置 46 列同时接受；都不符时差异列出当前版本并附模板指引', async (t) => {
  const { service, userDataDir } = setup(t, async () => BANK_V2);
  const builtinFile = writeBank(path.join(userDataDir, 'bank-builtin.xlsx'), BANK_STATEMENT_FIELDS, [bankRow({ BizId: 'POSITION-BIZ-2', 合并单号: '合并-2' })]);
  const prepared = await service.prepareBankImport([builtinFile]);
  assert.equal(prepared.status, 'needs-confirmation');
  assert.equal((await apply(service, prepared.token)).status, 'ok');

  const other = BANK_V2.map((header) => (header === 'FundType' ? 'Fund Type' : header));
  const otherFile = writeBank(path.join(userDataDir, 'bank-other.xlsx'), other, [bankRow()]);
  const rejected = await service.prepareBankImport([otherFile]);
  assert.equal(rejected.status, 'failed');
  assert.equal(rejected.code, 'position-bank-headers-invalid');
  assert.match(rejected.message, /不符合 46\/49 列契约或当前版本/);
  assert.equal(rejected.detailLines[0], '最接近：银行对账单（导入识别结构）（当前版本 用户版本，46 列；文件 46 列）');
  assert.equal(rejected.detailLines.at(-1), '如系统导出结构已变更，请在「设置 → 模板文件」导入新版本');
});

test('银行表头结构判定：内置 46 / 结果 49 / 当前版本，未启用时只认内置', () => {
  assert.ok(bankSourceStructure([...BANK_STATEMENT_FIELDS], BANK_V2));
  assert.equal(bankSourceStructure(BANK_V2, null), null);
  const structure = bankSourceStructure(BANK_V2, BANK_V2);
  assert.deepEqual(Object.keys(structure.project(Object.fromEntries(BANK_V2.map((header) => [header, 'x'])))), [...BANK_STATEMENT_FIELDS]);
  assert.equal(bankHeaderMismatchLines(BANK_V2)[0], '最接近：平盘银行对账单 46 列（46 列；文件 46 列）');
});
