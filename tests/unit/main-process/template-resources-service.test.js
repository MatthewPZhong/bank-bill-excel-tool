'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const ExcelJS = require('exceljs');

const ROOT = path.join(__dirname, '..', '..', '..');
const { EXCLUDED_TEMPLATE_FILES, READ_MODES, TEMPLATE_RESOURCES, TYPE_ORDER } = require('../../../src/main-process/template-resources/catalog');
const { createTemplateResourceService } = require('../../../src/main-process/template-resources/service');
const { TEMPLATE_SHEETS } = require('../../../src/main-process/pre-fund-reconciliation/excel-writer');
const { MAIL_HEADERS } = require('../../../src/main-process/duplicate-inbound-match/excel-writer');
const { BANK_STATEMENT_FIELDS } = require('../../../src/constants/bank-statement-fields');
const { BANK_SHEET_NAME, POSITION_BANK_HEADERS } = require('../../../src/main-process/position-reconciliation/constants');
const { GATEWAY_RECON_SIGNATURE } = require('../../../src/constants/table-signatures');
const { RESULT_TEMPLATE_FILE_SHA256 } = require('../../../src/backend/vcc-financial-op/result-template-contract');
const { loadFundTypeEnum } = require('../../../src/constants/fund-type-enum');
const { PRIMARY_ARCHIVE_SCOPES } = require('../../../src/main-process/archive-center/module-scope-registry');

const service = createTemplateResourceService({ appRoot: ROOT, appVersion: '9.9.9' });
let listed = null;
async function listedResources() {
  if (!listed) listed = await service.list();
  return listed;
}
async function resourceById(id) {
  const result = await service.get(id);
  assert.equal(result.status, 'success', id);
  return result.resource;
}
const sheetNamed = (resource, name) => resource.sheets.find((sheet) => sheet.name === name);

function workbookFilesUnder(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) return workbookFilesUnder(full);
    return /\.xlsx?$/i.test(entry.name) && !entry.name.startsWith('.~') ? [full] : [];
  });
}

test('清单覆盖全部随包 Excel，且只纳管或明确未纳入一次', () => {
  const packaged = [
    ...workbookFilesUnder(path.join(ROOT, 'assets')),
    path.join(ROOT, 'COMMON枚举.xlsx')
  ].map((file) => path.relative(ROOT, file).split(path.sep).join('/')).sort();
  const declared = [...TEMPLATE_RESOURCES.map((item) => item.path), ...EXCLUDED_TEMPLATE_FILES.map((item) => item.path)].sort();
  assert.deepEqual(declared, packaged);
  assert.equal(new Set(TEMPLATE_RESOURCES.map((item) => item.id)).size, TEMPLATE_RESOURCES.length);
  assert.equal(TEMPLATE_RESOURCES.length, 39);
});

test('清单的类型、读取方式与使用模块均为已知取值', () => {
  const moduleIds = new Set(PRIMARY_ARCHIVE_SCOPES.map((scope) => scope.id));
  const ids = new Set(TEMPLATE_RESOURCES.map((item) => item.id));
  for (const item of TEMPLATE_RESOURCES) {
    assert.ok(TYPE_ORDER.includes(item.type), item.id);
    assert.ok(READ_MODES.includes(item.readMode), item.id);
    assert.ok(item.bindings.length > 0, item.id);
    for (const binding of item.bindings) {
      assert.ok(moduleIds.has(binding.moduleId), `${item.id} → ${binding.moduleId}`);
      assert.ok(['runtime', 'cached', 'locked', 'none'].includes(binding.read), item.id);
    }
    if (!item.replace.allowed) assert.ok(item.replace.reason, `${item.id} 不可替换时需说明原因`);
    for (const linked of [item.twin, item.currentTemplate].filter(Boolean)) assert.ok(ids.has(linked), `${item.id} → ${linked}`);
  }
  for (const excluded of EXCLUDED_TEMPLATE_FILES) {
    for (const moduleId of excluded.modules) assert.ok(moduleIds.has(moduleId), `${excluded.path} → ${moduleId}`);
  }
});

test('运行时读取的输出模板，Sheet 与表头和各模块代码契约一致', async () => {
  const prefund = await resourceById('prefund-unbalanced');
  assert.deepEqual(
    prefund.sheets.map((sheet) => [sheet.name, sheet.headers]),
    TEMPLATE_SHEETS.map((sheet) => [sheet.name, [...sheet.headers]])
  );

  const mail = await resourceById('dup-recall-mail');
  assert.equal(mail.sheets.length, 1);
  assert.deepEqual(mail.sheets[0].headers, [...MAIL_HEADERS]);

  const position = await resourceById('position-bank');
  assert.deepEqual(sheetNamed(position, BANK_SHEET_NAME).headers, [...POSITION_BANK_HEADERS]);

  const bank = await resourceById('bank-statement');
  assert.deepEqual(sheetNamed(bank, '渠道对账单').headers, [...BANK_STATEMENT_FIELDS]);
});

test('缓存读取的枚举与网关表头和运行时加载口径一致', async () => {
  const fundType = await resourceById('fund-type-enum');
  assert.deepEqual(fundType.enumValues, loadFundTypeEnum(path.join(ROOT, 'assets', 'FundType枚举值.xlsx')));
  assert.ok(fundType.enumValues.length > 0);

  const gateway = await resourceById('gateway-recon');
  for (const header of GATEWAY_RECON_SIGNATURE.signatureHeaders) {
    assert.ok(gateway.sheets[0].headers.includes(header), header);
  }
});

test('VCC 结果模板与锁定哈希一致，且不受 dimension 声明截断表头', async () => {
  const locked = await resourceById('vcc-result-template');
  assert.equal(locked.current.sha256, RESULT_TEMPLATE_FILE_SHA256);

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(path.join(ROOT, locked.path));
  const expected = [];
  workbook.worksheets[0].getRow(1).eachCell({ includeEmpty: true }, (cell, column) => {
    expected[column - 1] = String(cell.text || '').trim();
  });
  while (expected.length && !expected[expected.length - 1]) expected.pop();
  assert.ok(expected[0], 'ExcelJS 应读到 A1');
  assert.deepEqual(locked.sheets[0].headers, expected);
});

test('合并单元格覆盖的行计入内容行数', async () => {
  const reference = await resourceById('vcc-result-reference');
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(path.join(ROOT, reference.path));
  let rowsWithContent = 0;
  workbook.worksheets[0].eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber > 1 && row.values.some((value) => value !== null && value !== undefined && String(value.text ?? value).trim())) rowsWithContent += 1;
  });
  assert.equal(reference.sheets[0].dataRows, rowsWithContent);
  assert.ok(rowsWithContent > 10);
});

test('当前只开放另存为：导入与版本操作全部关闭并给出原因', async () => {
  const { status, resources, excluded } = await listedResources();
  assert.equal(status, 'success');
  assert.equal(resources.length, TEMPLATE_RESOURCES.length);
  assert.deepEqual(excluded.map((item) => item.fileName), ['COMMON枚举.xlsx', '余额账单模版.xlsx', '币种映射表.xlsx']);
  for (const resource of resources) {
    const definition = TEMPLATE_RESOURCES.find((item) => item.id === resource.id);
    assert.equal(resource.readError, '', resource.id);
    assert.deepEqual(resource.capabilities, {
      saveAs: true,
      importVersion: false,
      importReason: definition.replace.allowed ? '版本导入尚未开放' : definition.replace.reason,
      setCurrent: false,
      deleteVersion: false,
      restoreDefault: false
    });
    assert.deepEqual(
      { id: resource.current.id, source: resource.current.source, current: resource.current.current, appVersion: resource.current.appVersion },
      { id: 'v1', source: 'builtin', current: true, appVersion: '9.9.9' }
    );
  }
});

test('详情返回内置版本摘要；未知资源与未知版本被拒绝', async () => {
  const detail = await resourceById('dup-recall-mail');
  const bytes = fs.readFileSync(path.join(ROOT, 'assets', '重复入金召回邮件模板.xlsx'));
  assert.equal(detail.current.sha256, crypto.createHash('sha256').update(bytes).digest('hex'));
  assert.equal(detail.current.size, bytes.length);
  assert.deepEqual(detail.versions.map((version) => version.id), ['v1']);
  assert.deepEqual(detail.tasks, []);

  assert.deepEqual(await service.get('missing'), { status: 'failed', message: '模板不存在' });
  assert.deepEqual(service.resolveVersion({ resourceId: 'dup-recall-mail', versionId: 'v2' }), { status: 'failed', message: '版本不存在' });
});

test('文件缺失时保留清单项，标记读取失败并关闭另存为', async () => {
  const emptyRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'template-resources-empty-'));
  try {
    const missing = createTemplateResourceService({ appRoot: emptyRoot });
    const result = await missing.get('fund-type-enum');
    assert.equal(result.status, 'success');
    assert.equal(result.resource.readError, '文件不存在或无法访问');
    assert.equal(result.resource.capabilities.saveAs, false);
    assert.deepEqual(result.resource.sheets, []);
  } finally {
    fs.rmSync(emptyRoot, { recursive: true, force: true });
  }
});

test('解析结果按文件签名复用，文件变化后重新读取', async () => {
  let reads = 0;
  let mtimeMs = 1;
  const counted = createTemplateResourceService({
    appRoot: ROOT,
    stat: async (filePath) => ({ ...(await fs.promises.stat(filePath)), mtimeMs }),
    readFile: async (filePath) => {
      reads += 1;
      return fs.promises.readFile(filePath);
    }
  });
  await counted.get('fund-type-enum');
  await counted.get('fund-type-enum');
  assert.equal(reads, 1);
  mtimeMs = 2;
  await counted.get('fund-type-enum');
  assert.equal(reads, 2);
});
