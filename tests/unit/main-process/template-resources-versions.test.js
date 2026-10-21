'use strict';

// 设置 → 模板文件：用户版本的导入预检、提交、启用 / 恢复默认、删除、租约、兼容复核与孤儿清扫。
// 使用真实随包模板、真实迁移与仓储；版本文件只写临时 userData。
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  TemplateResourceUnavailableError,
  createTemplateResourceService
} = require('../../../src/main-process/template-resources/service');
const { collectScenarioReferences } = require('../../../src/main-process/template-resources/contracts');
const { canonicalizeXlsx, extractEntries, runInspectionTask } = require('../../../src/main-process/template-resources/inspection-task');
const { TemplateInspectionError, inspectionStats, runTemplateInspection } = require('../../../src/main-process/template-resources/inspection-runner');
const { createTemplateResourceStore, restyledTemplate } = require('../../helpers/template-resource-store');

const ROOT = path.join(__dirname, '..', '..', '..');
const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const checksOf = (prepared, group = 'file') => prepared.checks.filter((check) => check.group === group)
  .map((check) => [check.label, check.status]);

// inProcess：在进程内执行模板检查任务（需要在主线程模拟 fs 等错误的用例使用）；默认走正式的受限 Worker。
function setup(t, { scenarios = [], store = null, inProcess = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'template-resource-versions-'));
  const userData = path.join(root, 'userData');
  const files = path.join(root, 'files');
  fs.mkdirSync(files, { recursive: true });
  const db = store || createTemplateResourceStore({ scenarios });
  const changed = [];
  const logs = [];
  let clock = new Date('2026-10-19T09:30:00');
  const service = createTemplateResourceService({
    appRoot: ROOT,
    appVersion: '9.9.9',
    userDataRoot: userData,
    store: db,
    onChanged: (payload) => changed.push(payload),
    log: (entry) => logs.push(entry),
    now: () => clock,
    ...(inProcess ? { runInspection: runInspectionTask } : {})
  });
  t.after(() => {
    try { db.close(); } catch (_error) { /* 已关闭 */ }
    fs.rmSync(root, { recursive: true, force: true });
  });
  return {
    service,
    store: db,
    userData,
    files,
    changed,
    logs,
    advance(ms) { clock = new Date(clock.getTime() + ms); },
    versionFile: (resourceId, versionId) => path.join(userData, 'template-resources', resourceId, `${versionId}.xlsx`)
  };
}

async function prepare(service, resourceId, filePath) {
  service.rememberPickedFile(filePath);
  const prepared = await service.prepareImport({ resourceId, filePath });
  assert.equal(prepared.status, 'success', prepared.message);
  return prepared;
}

async function importVersion(service, resourceId, filePath, { enable = true } = {}) {
  const prepared = await prepare(service, resourceId, filePath);
  assert.equal(prepared.verdict === 'fail', false, JSON.stringify(prepared.checks));
  const committed = await service.commitImport({ importToken: prepared.importToken, enable });
  assert.equal(committed.status, 'success', committed.message);
  return committed.version;
}

const widenMailColumn = (workbook) => { workbook.worksheets[0].getColumn(1).width = 31; };

test('导入预检通过后仅保存：版本列表新增 V2，当前仍为内置', async (t) => {
  const env = setup(t);
  const file = await restyledTemplate('assets/重复入金召回邮件模板.xlsx', path.join(env.files, '邮件模板-新.xlsx'), widenMailColumn);

  const unpicked = await env.service.prepareImport({ resourceId: 'dup-recall-mail', filePath: file });
  assert.deepEqual(unpicked, { status: 'failed', message: '请通过“选择文件”重新选择要导入的文件' });

  const prepared = await prepare(env.service, 'dup-recall-mail', file);
  assert.equal(prepared.verdict, 'pass');
  assert.equal(prepared.expectedVersionId, 'v1');
  assert.equal(prepared.expectedVersionLabel, 'V1');
  assert.equal(prepared.expectedVersionSource, 'builtin');
  assert.equal(prepared.file.sha256, sha256(fs.readFileSync(file)));
  assert.deepEqual(checksOf(prepared), [
    ['文件格式', 'pass'], ['Sheet 结构', 'pass'], ['表头', 'pass'], ['与当前版本', 'info']
  ]);
  assert.deepEqual(checksOf(prepared, 'usage'), [['重复入金匹配', 'pass']]);

  const committed = await env.service.commitImport({ importToken: prepared.importToken, enable: false });
  assert.equal(committed.status, 'success');
  assert.equal(committed.enabled, false);
  assert.equal(committed.version.label, 'V2');
  assert.equal(committed.version.current, false);
  // 保存的是检查 Worker 重新打包后的字节：版本记录的 SHA-256 对应磁盘上的版本文件，与导入的原文件不同。
  assert.equal(sha256(fs.readFileSync(env.versionFile('dup-recall-mail', 'v2'))), committed.version.sha256);
  assert.equal(committed.version.sha256, sha256(await canonicalizeXlsx(fs.readFileSync(file))));
  assert.deepEqual(env.changed, [{ resourceId: 'dup-recall-mail' }]);

  const { resource } = await env.service.get('dup-recall-mail');
  assert.deepEqual(resource.versions.map((version) => [version.id, version.source, version.current]), [
    ['v2', 'user', false], ['v1', 'builtin', true]
  ]);
  assert.equal(resource.current.id, 'v1');
  assert.equal(resource.versions[0].fileName, '邮件模板-新.xlsx');
  assert.equal(resource.versions[0].createdAt, '2026-10-19 09:30');
  assert.equal(resource.versions[0].location, env.versionFile('dup-recall-mail', 'v2'));
  assert.deepEqual(resource.capabilities, {
    saveAs: true, importVersion: true, importReason: '', setCurrent: true, deleteVersion: true, restoreDefault: false
  });
  assert.deepEqual(env.service.listChanges().changes.map((change) => [change.action, change.from, change.to, change.result]), [
    ['导入', '', 'V2', 'success']
  ]);
  assert.deepEqual(await env.service.commitImport({ importToken: prepared.importToken, enable: true }),
    { status: 'failed', message: '导入已失效，请重新选择文件' }, '令牌只能使用一次');
});

test('启用、租约、冲突、恢复默认与删除按版本状态执行', async (t) => {
  const env = setup(t);
  const file = await restyledTemplate('assets/重复入金召回邮件模板.xlsx', path.join(env.files, 'v2.xlsx'), widenMailColumn);
  await importVersion(env.service, 'dup-recall-mail', file, { enable: false });

  assert.deepEqual(
    await env.service.setCurrentVersion({ resourceId: 'dup-recall-mail', versionId: 'v2', expectedVersionId: 'v9' }),
    { status: 'conflict', message: '模板已更新为 V1，请确认后重试' }
  );
  assert.deepEqual(
    await env.service.setCurrentVersion({ resourceId: 'dup-recall-mail', versionId: 'v2', expectedVersionId: 'v1' }),
    { status: 'success', version: { id: 'v2', label: 'V2' } }
  );

  const lease = await env.service.acquire('dup-recall-mail', { moduleId: 'duplicate-inbound-match', label: '重复入金导出' });
  assert.equal(lease.filePath, env.versionFile('dup-recall-mail', 'v2'));
  assert.equal(lease.source, 'user');
  assert.ok(env.logs.some((entry) => /使用用户版本 V2/.test(entry.message)));
  const { resource } = await env.service.get('dup-recall-mail');
  assert.equal(resource.current.id, 'v2');
  assert.equal(resource.capabilities.restoreDefault, true);
  assert.deepEqual(resource.tasks, [{ id: '重复入金导出', state: '运行中', moduleId: 'duplicate-inbound-match', versionId: 'v2' }]);

  assert.deepEqual(await env.service.deleteVersion({ resourceId: 'dup-recall-mail', versionId: 'v2' }),
    { status: 'failed', message: '当前版本不能删除，请先启用其他版本' });
  assert.deepEqual(await env.service.deleteVersion({ resourceId: 'dup-recall-mail', versionId: 'v1' }),
    { status: 'failed', message: '内置版本不能删除' });

  // 恢复默认后，进行中的任务仍持有 V2：删除被拒绝，任务结束后才能删除。
  assert.equal((await env.service.setCurrentVersion({ resourceId: 'dup-recall-mail', versionId: 'v1', expectedVersionId: 'v2' })).status, 'success');
  assert.deepEqual(await env.service.deleteVersion({ resourceId: 'dup-recall-mail', versionId: 'v2' }),
    { status: 'failed', message: '1 个任务正在使用该版本' });
  lease.release();
  lease.release();
  assert.deepEqual(await env.service.deleteVersion({ resourceId: 'dup-recall-mail', versionId: 'v2' }), { status: 'success' });
  assert.equal(fs.existsSync(env.versionFile('dup-recall-mail', 'v2')), false);

  const builtinLease = await env.service.acquire('dup-recall-mail', { withBytes: true });
  assert.equal(builtinLease.source, 'builtin');
  assert.equal(builtinLease.sha256, sha256(fs.readFileSync(path.join(ROOT, 'assets', '重复入金召回邮件模板.xlsx'))));
  builtinLease.release();

  assert.deepEqual(env.service.listChanges().changes.map((change) => [change.action, change.from, change.to]), [
    ['删除版本', 'V2', ''], ['恢复默认', 'V2', 'V1'], ['启用', 'V1', 'V2'], ['导入', '', 'V2']
  ]);

  // 版本号不复用：删除 V2 后再导入为 V3。
  const again = await restyledTemplate('assets/重复入金召回邮件模板.xlsx', path.join(env.files, 'v3.xlsx'), (workbook) => {
    workbook.worksheets[0].getColumn(2).width = 27;
  });
  assert.equal((await importVersion(env.service, 'dup-recall-mail', again)).label, 'V3');
});

test('预检期间当前版本已变化时提交返回冲突，且不留下版本文件', async (t) => {
  const env = setup(t);
  const first = await restyledTemplate('assets/重复入金召回邮件模板.xlsx', path.join(env.files, 'a.xlsx'), widenMailColumn);
  const second = await restyledTemplate('assets/重复入金召回邮件模板.xlsx', path.join(env.files, 'b.xlsx'), (workbook) => {
    workbook.worksheets[0].getColumn(3).width = 22;
  });
  const preparedA = await prepare(env.service, 'dup-recall-mail', first);
  const preparedB = await prepare(env.service, 'dup-recall-mail', second);
  assert.equal((await env.service.commitImport({ importToken: preparedA.importToken, enable: true })).status, 'success');
  assert.deepEqual(await env.service.commitImport({ importToken: preparedB.importToken, enable: true }),
    { status: 'conflict', message: '模板已更新为 V2，请重新校验' });
  assert.deepEqual(fs.readdirSync(path.dirname(env.versionFile('dup-recall-mail', 'v2'))), ['v2.xlsx']);

  const duplicate = await prepare(env.service, 'dup-recall-mail', first);
  assert.equal(duplicate.verdict, 'fail');
  assert.deepEqual(duplicate.checks.find((check) => check.label === '与已有版本'),
    { group: 'file', label: '与已有版本', status: 'fail', detail: '与当前版本内容相同' });
  const builtinCopy = path.join(env.files, '原样内置.xlsx');
  fs.copyFileSync(path.join(ROOT, 'assets', '重复入金召回邮件模板.xlsx'), builtinCopy);
  const sameAsBuiltin = await prepare(env.service, 'dup-recall-mail', builtinCopy);
  assert.equal(sameAsBuiltin.checks.find((check) => check.label === '与已有版本').detail, '与 V1 内容相同，可在“版本”中直接启用');
  assert.deepEqual(await env.service.commitImport({ importToken: sameAsBuiltin.importToken, enable: false }),
    { status: 'failed', message: '预检未通过，不能导入' });
});

test('暂存令牌 30 分钟过期，最多保留 4 份', async (t) => {
  const env = setup(t);
  const file = await restyledTemplate('assets/重复入金召回邮件模板.xlsx', path.join(env.files, 'a.xlsx'), widenMailColumn);
  const tokens = [];
  for (let index = 0; index < 5; index += 1) tokens.push((await prepare(env.service, 'dup-recall-mail', file)).importToken);
  assert.equal((await env.service.commitImport({ importToken: tokens[0], enable: false })).message, '导入已失效，请重新选择文件');
  env.advance(31 * 60 * 1000);
  assert.equal((await env.service.commitImport({ importToken: tokens[4], enable: false })).message, '导入已失效，请重新选择文件');
  assert.deepEqual(env.service.discardImport(tokens[3]), { status: 'success' });
});

test('输出模板预检直接使用各模块写出校验，并拦截会改变输出或回读的结构', async (t) => {
  const env = setup(t);
  const cases = [
    ['prefund-unbalanced', 'assets/资金对账导出不平.xlsx', (workbook) => { workbook.getWorksheet('不平结果').getCell('A1').value = '数据来源'; },
      [['文件格式', 'pass'], ['表头', 'fail']], /第1列应为「对账数据来源」，实际为「数据来源」/],
    ['prefund-unbalanced', 'assets/资金对账导出不平.xlsx', (workbook) => { workbook.removeWorksheet(workbook.getWorksheet('订单修复').id); },
      [['文件格式', 'pass'], ['Sheet 结构', 'fail']], /应为「不平结果、平账结果、网关账单、渠道账单、订单修复」/],
    ['dup-recall-mail', 'assets/重复入金召回邮件模板.xlsx', (workbook) => { workbook.worksheets[0].getCell('K1').value = '附加'; },
      [['文件格式', 'pass'], ['Sheet 结构', 'pass'], ['表头', 'pass'], ['多余表头', 'warn'], ['与当前版本', 'info']], /不会写入导出：附加/],
    ['bank-statement', 'assets/银行对账单.xlsx', (workbook) => { workbook.worksheets[0].name = '对账单'; },
      [['文件格式', 'pass'], ['Sheet 结构', 'fail']], /缺少 sheet「渠道对账单」/],
    ['position-bank', 'assets/平盘银行对账单.xlsx', (workbook) => { workbook.getWorksheet('渠道对账单').getCell(1, 50).value = '备注'; },
      [['文件格式', 'pass'], ['Sheet 结构', 'pass'], ['表头', 'fail']], /存在多余表头：备注；要求固定 49 列/],
    ['position-bank', 'assets/平盘银行对账单.xlsx', (workbook) => { workbook.addWorksheet('说明'); },
      [['文件格式', 'pass'], ['Sheet 结构', 'fail'], ['表头', 'pass']], /多出 说明，会被一并写入结果/],
    ['vcc-pending-calc', 'assets/VCC财务OP校验/移除归档Pending发生额计算表.xlsx', (workbook) => { workbook.worksheets[0].getRow(1).height = 500; },
      [['文件格式', 'pass'], ['Sheet 结构', 'pass'], ['行高', 'fail']], /第 1 行超过 409.5/]
  ];
  for (const [index, [resourceId, source, mutate, expectedChecks, detailPattern]] of cases.entries()) {
    const file = await restyledTemplate(source, path.join(env.files, `case-${index}.xlsx`), mutate);
    const prepared = await prepare(env.service, resourceId, file);
    assert.deepEqual(checksOf(prepared), expectedChecks, `${resourceId} #${index}`);
    assert.ok(prepared.checks.some((check) => detailPattern.test(check.detail)), `${resourceId} #${index} detail`);
    // 只当结构参考、不读取该文件的使用方显示为 info（不受影响）。
    const usage = checksOf(prepared, 'usage').map(([, status]) => status).filter((status) => status !== 'info');
    assert.equal(prepared.verdict, expectedChecks.some(([, status]) => status === 'fail') ? 'fail' : 'warn');
    assert.ok(usage.every((status) => status === (prepared.verdict === 'fail' ? 'fail' : 'pass')), `${resourceId} usage`);
  }

  const xls = path.join(env.files, '旧格式.xls');
  fs.copyFileSync(path.join(ROOT, 'assets', '中台退款订单.xls'), xls);
  const legacy = await prepare(env.service, 'dup-recall-mail', xls);
  assert.deepEqual(checksOf(legacy), [['文件格式', 'fail']]);
  assert.equal(legacy.verdict, 'fail');
  assert.equal(legacy.importToken, undefined);

  const notWorkbook = path.join(env.files, '损坏.xlsx');
  fs.writeFileSync(notWorkbook, 'not a zip');
  const broken = await prepare(env.service, 'prefund-unbalanced', notWorkbook);
  assert.deepEqual(checksOf(broken), [['文件格式', 'pass'], ['读取文件', 'fail']]);

  const vcc = await restyledTemplate('assets/VCC财务OP校验/移除归档Pending发生额计算表.xlsx', path.join(env.files, 'vcc.xlsx'), (workbook) => {
    workbook.worksheets[0].getCell('A1').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDDEEFF' } };
  });
  const vccPrepared = await prepare(env.service, 'vcc-pending-calc', vcc);
  assert.equal(vccPrepared.verdict, 'pass', JSON.stringify(vccPrepared.checks));
  assert.deepEqual(checksOf(vccPrepared), [
    ['文件格式', 'pass'], ['Sheet 结构', 'pass'], ['样式', 'pass'], ['生效范围', 'info'], ['与当前版本', 'info']
  ]);

  const notReplaceable = await env.service.prepareImport({ resourceId: 'vcc-result-template', filePath: vcc });
  assert.deepEqual(notReplaceable, { status: 'failed', message: '文件受 SHA-256 锁定，需随应用版本更新' });
});

async function writeEnumWorkbook(filePath, rows) {
  const ExcelJS = require('exceljs');
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Sheet1');
  rows.forEach((row) => sheet.addRow(row));
  await workbook.xlsx.writeFile(filePath);
  return filePath;
}

test('枚举与网关表头：比较取值变化，阻止移除已被场景引用的值', async (t) => {
  const scenarios = [
    { id: 1, category: 'offset-bill-mark', config: {
      billTypes: [{ seq: 1, conditions: [{ field: 'FundType', op: '等于', value: 'Inbound' }] }],
      markValue: { type: 1, field: 'FundType', value: 'Reversal' }
    } },
    { id: 2, category: 'gateway-recon-join', config: {
      reconFields: [{ gwField: 'amount', bankField: 'Credit Amount' }],
      conditions: [{ side: '网关', field: 'currency' }, { side: '银行', field: 'Channel' }],
      assign: { gwField: '__CUSTOM__', bankField: 'ReconciliationId' }
    } }
  ];
  const env = setup(t, { scenarios });
  const builtinFundTypes = (await env.service.get('fund-type-enum')).resource.enumValues;
  assert.ok(builtinFundTypes.includes('Inbound') && builtinFundTypes.includes('Reversal'));

  const withoutReversal = await writeEnumWorkbook(path.join(env.files, 'fund-type-a.xlsx'),
    [['FundType'], ...builtinFundTypes.filter((value) => value !== 'Reversal').map((value) => [value]), ['NewType']]);
  const blocked = await prepare(env.service, 'fund-type-enum', withoutReversal);
  assert.equal(blocked.verdict, 'fail');
  assert.deepEqual(blocked.diff, { added: ['NewType'], removed: ['Reversal'] });
  assert.equal(blocked.checks.find((check) => check.label === '场景引用').detail, '已被场景使用：Reversal');

  const unusedRemoved = builtinFundTypes.find((value) => !['Inbound', 'Reversal'].includes(value));
  const allowed = await writeEnumWorkbook(path.join(env.files, 'fund-type-b.xlsx'),
    [['FundType'], ...builtinFundTypes.filter((value) => value !== unusedRemoved).map((value) => [value]), ['NewType']]);
  const allowedPrepared = await prepare(env.service, 'fund-type-enum', allowed);
  assert.equal(allowedPrepared.verdict, 'pass');
  assert.equal(allowedPrepared.checks.find((check) => check.label === '与当前版本').detail, '新增 1 个 · 移除 1 个');
  await env.service.commitImport({ importToken: allowedPrepared.importToken, enable: true });
  const current = await env.service.resolveCurrentFile('fund-type-enum');
  assert.equal(current.status, 'user');
  assert.equal(current.filePath, env.versionFile('fund-type-enum', 'v2'));
  assert.equal((await env.service.get('fund-type-enum')).resource.current.enumValues.includes('NewType'), true);

  const gatewayHeaders = (await env.service.get('gateway-recon')).resource.sheets[0].headers;
  const missingSignature = await writeEnumWorkbook(path.join(env.files, 'gateway-a.xlsx'),
    [gatewayHeaders.filter((header) => header !== 'merchantid')]);
  const missing = await prepare(env.service, 'gateway-recon', missingSignature);
  assert.equal(missing.checks.find((check) => check.label === '识别字段').detail, '缺少 merchantid（区分大小写）');

  const removedUsed = await writeEnumWorkbook(path.join(env.files, 'gateway-b.xlsx'),
    [[...gatewayHeaders.filter((header) => header !== 'currency'), '__CUSTOM__']]);
  const used = await prepare(env.service, 'gateway-recon', removedUsed);
  assert.equal(used.verdict, 'fail');
  assert.equal(used.checks.find((check) => check.label === '场景引用').detail, '已被场景使用：currency');
  assert.equal(used.checks.find((check) => check.label === '保留值').status, 'warn');
});

// 在第 1 个 Sheet 的最后一格写一个值：文件仍只有几 KB，但 SheetJS 的声明范围变成整张表（A1:XFD1048576）。
async function addFarCell(filePath) {
  const ExcelJS = require('exceljs');
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(filePath);
  workbook.worksheets[0].getCell('XFD1048576').value = '远端单元格';
  await workbook.xlsx.writeFile(filePath);
  return filePath;
}

test('范围覆盖整张表的小文件：预检与结构描述只按实际单元格读取，不按声明范围展开', { timeout: 60000 }, async (t) => {
  const env = setup(t);
  const XLSX = require('xlsx');

  const builtinFundTypes = (await env.service.get('fund-type-enum')).resource.enumValues;
  const fundType = await addFarCell(await writeEnumWorkbook(path.join(env.files, 'fund-type-far.xlsx'),
    [['FundType'], ...builtinFundTypes.map((value) => [value]), ['NewType']]));
  assert.ok(fs.statSync(fundType).size < 64 * 1024);
  const declared = XLSX.read(fs.readFileSync(fundType), { type: 'buffer' });
  assert.equal(declared.Sheets[declared.SheetNames[0]]['!ref'], 'A1:XFD1048576', '声明范围覆盖整张表');
  const fundTypePrepared = await prepare(env.service, 'fund-type-enum', fundType);
  assert.deepEqual(fundTypePrepared.diff, { added: ['NewType'], removed: [] });

  const gatewayHeaders = (await env.service.get('gateway-recon')).resource.sheets[0].headers;
  const gateway = await addFarCell(await writeEnumWorkbook(path.join(env.files, 'gateway-far.xlsx'), [gatewayHeaders]));
  const gatewayPrepared = await prepare(env.service, 'gateway-recon', gateway);
  assert.equal(gatewayPrepared.verdict, 'pass', JSON.stringify(gatewayPrepared.checks));
  assert.deepEqual(gatewayPrepared.diff, { added: [], removed: [] });

  const position = await addFarCell(await restyledTemplate('assets/平盘银行对账单.xlsx', path.join(env.files, 'position-far.xlsx')));
  const positionPrepared = await prepare(env.service, 'position-bank', position);
  assert.equal(positionPrepared.verdict, 'warn', JSON.stringify(positionPrepared.checks));
  assert.equal(positionPrepared.checks.find((check) => check.label === '数据区').detail, '第 2 行起有 1 行内容，导出时清空，不会写入结果');
  await env.service.commitImport({ importToken: positionPrepared.importToken, enable: false });
  const saved = (await env.service.get('position-bank')).resource.versions.find((version) => version.id === 'v2');
  assert.equal(saved.sheets[0].headers.length, 49);
  assert.equal(saved.sheets[0].dataRows, 1);
});

// 从指定单元格起写入若干行：声明范围（!ref）不从 A1 开始。
async function writeOffsetWorkbook(filePath, startRow, startColumn, rows) {
  const ExcelJS = require('exceljs');
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Sheet1');
  rows.forEach((row, rowIndex) => row.forEach((value, columnIndex) => {
    sheet.getCell(startRow + rowIndex, startColumn + columnIndex).value = value;
  }));
  await workbook.xlsx.writeFile(filePath);
  return filePath;
}

test('比较基准按运行时口径重新解析当前版本文件：声明范围不从 A1 开始时，场景引用保护仍生效', async (t) => {
  const scenarios = [
    { id: 1, category: 'offset-bill-mark', config: { billTypes: [{ seq: 1, conditions: [{ field: 'FundType', op: '等于', value: 'REMOVE' }] }] } },
    { id: 2, category: 'gateway-recon-join', config: { reconFields: [{ gwField: 'amount', bankField: 'Credit Amount' }], conditions: [{ side: '网关', field: 'currency' }], assign: { gwField: '__CUSTOM__', bankField: 'ReconciliationId' } } }
  ];
  const env = setup(t, { scenarios });

  // FundType：V2 从 B3 起（表头、KEEP、REMOVE），场景引用 REMOVE；V3 去掉 REMOVE 应被拦下。
  const fundTypeV2 = await writeOffsetWorkbook(path.join(env.files, 'fund-type-v2.xlsx'), 3, 2, [['FundType'], ['KEEP'], ['REMOVE']]);
  const imported = await importVersion(env.service, 'fund-type-enum', fundTypeV2);
  assert.deepEqual(imported.enumValues, ['KEEP', 'REMOVE'], '版本取值与运行时读到的一致');
  const fundTypeV3 = await writeOffsetWorkbook(path.join(env.files, 'fund-type-v3.xlsx'), 3, 2, [['FundType'], ['KEEP']]);
  const fundTypeBlocked = await prepare(env.service, 'fund-type-enum', fundTypeV3);
  assert.equal(fundTypeBlocked.verdict, 'fail');
  assert.deepEqual(fundTypeBlocked.diff, { added: [], removed: ['REMOVE'] });
  assert.equal(fundTypeBlocked.checks.find((check) => check.label === '场景引用').detail, '已被场景使用：REMOVE');

  // 网关：V2 表头从 C2 起（版本记录里按第 1 行保存的表头为空），V3 去掉被 C3 场景引用的 currency 应被拦下。
  const gatewayHeaders = (await env.service.get('gateway-recon')).resource.sheets[0].headers;
  await importVersion(env.service, 'gateway-recon',
    await writeOffsetWorkbook(path.join(env.files, 'gateway-v2.xlsx'), 2, 3, [gatewayHeaders]));
  const gatewayBlocked = await prepare(env.service, 'gateway-recon',
    await writeOffsetWorkbook(path.join(env.files, 'gateway-v3.xlsx'), 2, 3, [gatewayHeaders.filter((header) => header !== 'currency')]));
  assert.equal(gatewayBlocked.verdict, 'fail');
  assert.deepEqual(gatewayBlocked.diff, { added: [], removed: ['currency'] });
  assert.equal(gatewayBlocked.checks.find((check) => check.label === '场景引用').detail, '已被场景使用：currency');
});

test('平盘模板含 Excel 表时拒绝导入；数据验证与条件格式提示按模板范围原样带入', async (t) => {
  const env = setup(t);
  const { POSITION_BANK_HEADERS } = require('../../../src/main-process/position-reconciliation/constants');
  const withTable = await restyledTemplate('assets/平盘银行对账单.xlsx', path.join(env.files, 'position-table.xlsx'), (workbook) => {
    workbook.getWorksheet('渠道对账单').addTable({
      name: 'ResultTable',
      ref: 'A1',
      columns: POSITION_BANK_HEADERS.map((name) => ({ name })),
      rows: [POSITION_BANK_HEADERS.map(() => '')]
    });
  });
  const tablePrepared = await prepare(env.service, 'position-bank', withTable);
  assert.equal(tablePrepared.verdict, 'fail', JSON.stringify(tablePrepared.checks));
  assert.match(tablePrepared.checks.find((check) => check.label === 'Excel 表').detail, /^含 1 个 Excel 表（ResultTable），结果行数变化后范围无法调整/);

  const withRules = await restyledTemplate('assets/平盘银行对账单.xlsx', path.join(env.files, 'position-rules.xlsx'), (workbook) => {
    const sheet = workbook.getWorksheet('渠道对账单');
    sheet.dataValidations.add('C2:C100', { type: 'list', allowBlank: true, formulae: ['"USD,EUR"'] });
    sheet.addConditionalFormatting({
      ref: 'M2:M100',
      rules: [{ type: 'expression', priority: 1, formulae: ['M2<0'], style: { font: { color: { argb: 'FFFF0000' } } } }]
    });
  });
  const rulesPrepared = await prepare(env.service, 'position-bank', withRules);
  assert.equal(rulesPrepared.verdict, 'warn', JSON.stringify(rulesPrepared.checks));
  assert.equal(rulesPrepared.checks.find((check) => check.label === '数据验证与条件格式').detail,
    '模板中的数据验证与条件格式按原范围带入结果，不随结果行数调整');
});

test('版本文件因权限、占用等读盘错误打不开：标为暂不可用并提示稍后重试，恢复后重新复核', async (t) => {
  const env = setup(t);
  const file = await restyledTemplate('assets/重复入金召回邮件模板.xlsx', path.join(env.files, 'a.xlsx'), widenMailColumn);
  await importVersion(env.service, 'dup-recall-mail', file);
  const versionPath = env.versionFile('dup-recall-mail', 'v2');
  const denied = (operation) => Object.assign(new Error(`EACCES: permission denied, ${operation} '${versionPath}'`), { code: 'EACCES', syscall: operation });
  let failing = null;
  const restarted = createTemplateResourceService({
    appRoot: ROOT,
    userDataRoot: env.userData,
    store: env.store,
    stat: async (filePath) => {
      if (filePath === versionPath && failing === 'stat') throw denied('stat');
      return fs.promises.stat(filePath);
    },
    readFileCapped: async (filePath) => {
      if (filePath === versionPath && failing === 'open') throw denied('open');
      return fs.promises.readFile(filePath);
    }
  });

  for (const operation of ['stat', 'open']) {
    failing = operation;
    const current = (await restarted.get('dup-recall-mail')).resource.current;
    assert.equal(current.validation, 'unverified', `${operation}：与不兼容区分`);
    assert.match(current.validationMessage, new RegExp(`^版本文件暂时无法读取（EACCES: permission denied, ${operation} .*），请稍后重试$`));
    await assert.rejects(restarted.acquire('dup-recall-mail'), (error) => (
      error instanceof TemplateResourceUnavailableError && /请稍后重试$/.test(error.message) && !/恢复默认/.test(error.message)
    ));
  }
  failing = null;
  assert.equal((await restarted.get('dup-recall-mail')).resource.current.validation, 'passed', '恢复后重新复核');
  fs.rmSync(versionPath);
  assert.equal((await restarted.get('dup-recall-mail')).resource.current.validation, 'failed', '文件确实不存在时仍为不兼容（缺失）');
});

// 直接改写 xlsx 内的 XML（ExcelJS 自身写不出、或写出时同样会逐格展开的结构）。
async function patchXlsx(sourceRelativePath, targetPath, patches) {
  const JSZip = require('jszip');
  const zip = await JSZip.loadAsync(fs.readFileSync(path.join(ROOT, ...sourceRelativePath.split('/'))));
  for (const [entry, patch] of Object.entries(patches)) zip.file(entry, patch(await zip.file(entry).async('string')));
  fs.writeFileSync(targetPath, await zip.generateAsync({ type: 'nodebuffer' }));
  return targetPath;
}

test('数据验证或合并单元格范围覆盖整张表的小文件：读入前拒绝，不逐格展开', { timeout: 60000 }, async (t) => {
  const env = setup(t);
  const validation = await patchXlsx('assets/平盘银行对账单.xlsx', path.join(env.files, 'position-dv.xlsx'), {
    'xl/worksheets/sheet1.xml': (xml) => xml.replace('<pageMargins',
      '<dataValidations count="1"><dataValidation type="list" allowBlank="1" sqref="A2:XFD1048576"><formula1>"USD,EUR"</formula1></dataValidation></dataValidations><pageMargins')
  });
  const merged = await patchXlsx('assets/重复入金召回邮件模板.xlsx', path.join(env.files, 'mail-merge.xlsx'), {
    'xl/worksheets/sheet1.xml': (xml) => xml.replace('</sheetData>', '</sheetData><mergeCells count="1"><mergeCell ref="A2:XFD1048576"/></mergeCells>')
  });
  for (const [resourceId, file] of [['position-bank', validation], ['dup-recall-mail', merged]]) {
    assert.ok(fs.statSync(file).size < 64 * 1024);
    const prepared = await prepare(env.service, resourceId, file);
    assert.equal(prepared.verdict, 'fail', resourceId);
    assert.match(prepared.checks.find((check) => check.label === '表格范围').detail,
      /^数据验证或合并单元格覆盖约 17179852800 个单元格，超过 1048576 个的上限/);
  }
});

test('用户文件只在受限 Worker 中解析：任何逐格展开超出内存上限都只终止 Worker，预检不通过，主进程照常工作', { timeout: 120000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'template-resource-worker-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = createTemplateResourceStore();
  t.after(() => store.close());
  const service = createTemplateResourceService({
    appRoot: ROOT,
    userDataRoot: path.join(root, 'userData'),
    store,
    inspectionLimits: { maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 16, timeoutMs: 60000 }
  });
  // 定义名称（ExcelJS 读入时逐格建立）与超链接区域（SheetJS 读入时逐格建立）各一例，均为几 KB 的小文件。
  const named = await patchXlsx('assets/平盘银行对账单.xlsx', path.join(root, 'position-named.xlsx'), {
    'xl/workbook.xml': (xml) => xml.replace('</sheets>', '</sheets><definedNames><definedName name="AllCells">\'渠道对账单\'!$A$2:$XFD$1048576</definedName></definedNames>')
  });
  const linked = await patchXlsx('assets/重复入金召回邮件模板.xlsx', path.join(root, 'mail-hyperlink.xlsx'), {
    'xl/worksheets/sheet1.xml': (xml) => xml.replace(/<pageMargins|<\/worksheet>/, (tag) => `<hyperlinks><hyperlink ref="A2:XFD1048576" location="A1" display="x"/></hyperlinks>${tag}`)
  });
  for (const [resourceId, file] of [['position-bank', named], ['dup-recall-mail', linked]]) {
    assert.ok(fs.statSync(file).size < 64 * 1024);
    const prepared = await prepare(service, resourceId, file);
    assert.equal(prepared.verdict, 'fail', resourceId);
    assert.equal(prepared.importToken === undefined, false);
    assert.match(prepared.checks.find((check) => check.label === '读取文件').detail, /^模板过于复杂：读取时超出 64 MB 内存上限/, resourceId);
  }
  const normal = await restyledTemplate('assets/重复入金召回邮件模板.xlsx', path.join(root, 'mail-normal.xlsx'), widenMailColumn);
  assert.equal((await prepare(service, 'dup-recall-mail', normal)).verdict, 'pass', 'Worker 超限后服务照常工作');
});

test('检查 Worker 超时：属于运行环境问题，标为暂不可用、不缓存', { timeout: 120000 }, async (t) => {
  const env = setup(t);
  const file = await restyledTemplate('assets/重复入金召回邮件模板.xlsx', path.join(env.files, 'a.xlsx'), widenMailColumn);
  await importVersion(env.service, 'dup-recall-mail', file);
  const slow = createTemplateResourceService({
    appRoot: ROOT,
    userDataRoot: env.userData,
    store: env.store,
    inspectionLimits: { maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 32, timeoutMs: 1 }
  });
  const current = (await slow.get('dup-recall-mail')).resource.current;
  assert.equal(current.validation, 'unverified');
  assert.match(current.validationMessage, /^兼容复核未完成：读取文件：读取模板超时（超过 0 秒），请稍后重试$/);
  const normal = createTemplateResourceService({ appRoot: ROOT, userDataRoot: env.userData, store: env.store });
  assert.equal((await normal.get('dup-recall-mail')).resource.current.validation, 'passed');
});

test('打印区域须为写明首尾单元格的区域；含图表工作表等非普通工作表的模板不接受', async (t) => {
  const env = setup(t);
  const printArea = (formula, name) => patchXlsx('assets/平盘银行对账单.xlsx', path.join(env.files, name), {
    'xl/workbook.xml': (xml) => xml.replace('</sheets>', `</sheets><definedNames><definedName name="_xlnm.Print_Area" localSheetId="0">${formula}</definedName></definedNames>`)
  });
  for (const [formula, name] of [["'渠道对账单'!$A:$AW", 'columns.xlsx'], ["'渠道对账单'!$1:$3", 'rows.xlsx'], ["'渠道对账单'!$A$1", 'cell.xlsx']]) {
    const prepared = await prepare(env.service, 'position-bank', await printArea(formula, name));
    assert.equal(prepared.verdict, 'fail', formula);
    assert.match(prepared.checks.find((check) => check.label === '打印区域').detail, /不是明确的单元格区域，导出时无法按结果行数调整/, formula);
  }
  assert.equal((await prepare(env.service, 'position-bank', await printArea("'渠道对账单'!$A$1:$AW$3", 'explicit.xlsx'))).verdict, 'pass');

  const chartsheet = await patchXlsx('assets/平盘银行对账单.xlsx', path.join(env.files, 'chartsheet.xlsx'), {
    'xl/workbook.xml': (xml) => xml.replace('<sheets>', '<sheets><sheet name="图表1" sheetId="9" r:id="rId99"/>'),
    'xl/_rels/workbook.xml.rels': (xml) => xml.replace('</Relationships>', '<Relationship Id="rId99" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/chartsheet" Target="chartsheets/sheet9.xml"/></Relationships>'),
    '[Content_Types].xml': (xml) => xml.replace('</Types>', '<Override PartName="/xl/chartsheets/sheet9.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.chartsheet+xml"/></Types>')
  });
  const JSZip = require('jszip');
  const zip = await JSZip.loadAsync(fs.readFileSync(chartsheet));
  zip.file('xl/chartsheets/sheet9.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><chartsheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"/></sheetViews></chartsheet>');
  fs.writeFileSync(chartsheet, await zip.generateAsync({ type: 'nodebuffer' }));
  const chartPrepared = await prepare(env.service, 'position-bank', chartsheet);
  assert.equal(chartPrepared.verdict, 'fail');
  assert.equal(chartPrepared.checks.find((check) => check.label === 'Sheet 结构').detail, '含图表工作表等非普通工作表（图表1），请删除后再导入');
});

test('启用已保存的版本同样执行场景引用保护；恢复默认不受此限', async (t) => {
  const env = setup(t);
  await importVersion(env.service, 'fund-type-enum',
    await writeOffsetWorkbook(path.join(env.files, 'v2.xlsx'), 1, 1, [['FundType'], ['KEEP'], ['REMOVE']]));
  // 仅保存 V3（此时还没有场景引用 REMOVE），之后场景开始使用 REMOVE。
  await importVersion(env.service, 'fund-type-enum',
    await writeOffsetWorkbook(path.join(env.files, 'v3.xlsx'), 1, 1, [['FundType'], ['KEEP']]), { enable: false });
  env.store.scenarios.push({ id: 1, category: 'offset-bill-mark', config: { billTypes: [{ seq: 1, conditions: [{ field: 'FundType', op: '等于', value: 'REMOVE' }] }] } });
  assert.deepEqual(await env.service.setCurrentVersion({ resourceId: 'fund-type-enum', versionId: 'v3', expectedVersionId: 'v2' }),
    { status: 'failed', message: 'V3 不能启用：缺少已被场景使用的取值 REMOVE' });
  assert.equal((await env.service.get('fund-type-enum')).resource.current.id, 'v2');
  assert.equal((await env.service.setCurrentVersion({ resourceId: 'fund-type-enum', versionId: 'v1', expectedVersionId: 'v2' })).status, 'success', '恢复默认始终可用');
});

// 等待此前用例启动的检查 Worker 全部退出，再观察排队状态。
async function waitInspectionsIdle() {
  for (let attempt = 0; attempt < 400 && (inspectionStats().running || inspectionStats().queued); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  const stats = inspectionStats();
  assert.deepEqual([stats.running, stats.queued, stats.queuedBytes], [0, 0, 0]);
}

function commitRecord(store, resourceId, { versionId, versionNo, bytes, structure, enable, expectedVersionId }) {
  const createdAt = '2026-10-21T08:00:00.000Z';
  return store.commitTemplateResourceVersion({
    resourceId,
    version: { versionId, versionNo, fileName: `${versionId}.xlsx`, sizeBytes: bytes.length, sha256: sha256(bytes), validation: 'passed', structure, appVersion: '9.9.9', createdAt },
    enable,
    expectedVersionId,
    now: createdAt,
    change: { createdAt, resourceId, action: enable ? '导入并启用' : '导入', fromLabel: '', toLabel: `V${versionNo}`, result: 'success' }
  });
}

test('场景配置下拉使用导入时在检查 Worker 中解析的取值，主进程不解析用户文件', async (t) => {
  const env = setup(t);
  // 版本记录中的取值快照与文件内容故意不同：返回快照即说明没有在主进程重新解析文件。
  const bytes = await canonicalizeXlsx(fs.readFileSync(await writeOffsetWorkbook(path.join(env.files, 'fund.xlsx'), 1, 1, [['FundType'], ['FILE-VALUE']])));
  fs.mkdirSync(path.dirname(env.versionFile('fund-type-enum', 'v2')), { recursive: true });
  fs.writeFileSync(env.versionFile('fund-type-enum', 'v2'), bytes);
  assert.equal(commitRecord(env.store, 'fund-type-enum', {
    versionId: 'v2', versionNo: 2, bytes, structure: { enumValues: ['SNAPSHOT'], comparableValues: ['SNAPSHOT'] }, enable: true, expectedVersionId: 'v1'
  }).status, 'success');
  assert.deepEqual(await env.service.currentRuntimeValues('fund-type-enum'), { status: 'user', values: ['SNAPSHOT'], versionId: 'v2' });

  // 早期记录没有快照：在检查 Worker 中按运行时口径解析（核对 SHA-256 后）。
  const gatewayHeaders = (await env.service.get('gateway-recon')).resource.sheets[0].headers;
  const gatewayBytes = await canonicalizeXlsx(fs.readFileSync(await writeOffsetWorkbook(path.join(env.files, 'gateway.xlsx'), 1, 1, [gatewayHeaders])));
  fs.mkdirSync(path.dirname(env.versionFile('gateway-recon', 'v2')), { recursive: true });
  fs.writeFileSync(env.versionFile('gateway-recon', 'v2'), gatewayBytes);
  assert.equal(commitRecord(env.store, 'gateway-recon', {
    versionId: 'v2', versionNo: 2, bytes: gatewayBytes, structure: {}, enable: true, expectedVersionId: 'v1'
  }).status, 'success');
  const gateway = await env.service.currentRuntimeValues('gateway-recon');
  assert.equal(gateway.status, 'user');
  assert.deepEqual(gateway.values, [...new Set(gatewayHeaders.filter((header) => header && header !== '__CUSTOM__'))]);

  // 当前版本文件被改动：不可用，不返回取值；内置版本由调用方按原逻辑读取随包文件。
  fs.appendFileSync(env.versionFile('fund-type-enum', 'v2'), 'tamper');
  assert.equal((await env.service.currentRuntimeValues('fund-type-enum')).status, 'unavailable');
  assert.equal((await env.service.setCurrentVersion({ resourceId: 'fund-type-enum', versionId: 'v1', expectedVersionId: 'v2' })).status, 'success');
  assert.deepEqual(await env.service.currentRuntimeValues('fund-type-enum'), { status: 'builtin' });
});

test('解压后内容超过上限的小文件：读入前拒绝，不交给 ExcelJS / SheetJS', { timeout: 120000 }, async (t) => {
  const env = setup(t);
  const JSZip = require('jszip');
  const zip = await JSZip.loadAsync(fs.readFileSync(path.join(ROOT, 'assets', '重复入金召回邮件模板.xlsx')));
  zip.file('xl/media/image1.png', Buffer.alloc(101 * 1024 * 1024));
  const file = path.join(env.files, 'mail-media.xlsx');
  fs.writeFileSync(file, await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
  assert.ok(fs.statSync(file).size < 1024 * 1024, '压缩后不到 1 MB');
  const prepared = await prepare(env.service, 'dup-recall-mail', file);
  assert.equal(prepared.verdict, 'fail');
  assert.equal(prepared.checks.find((check) => check.label === '文件大小').detail,
    '解压后内容超过 100 MB 上限（xl/media/image1.png），请精简后再导入');

  // 条目声明的大小已超过上限时不解压直接停止；声明与实际不符时由流式计数与 yauzl 的大小核对兜底。
  await assert.rejects(extractEntries(fs.readFileSync(file), 1024 * 1024), /解压后内容超过 1 MB 上限（xl\/media\/image1.png）/);
  assert.ok((await extractEntries(fs.readFileSync(path.join(ROOT, 'assets', '重复入金召回邮件模板.xlsx')))).length > 0);
});

// ZIP 记录定位（测试中构造元信息互相矛盾的文件）：返回签名所在偏移。
function zipRecordOffsets(buffer, signature) {
  const offsets = [];
  for (let index = 0; index <= buffer.length - 4; index += 1) {
    if (buffer.readUInt32LE(index) === signature) offsets.push(index);
  }
  return offsets;
}
const LOCAL_HEADER = 0x04034b50;
const CENTRAL_HEADER = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY = 0x06054b50;

async function mailTemplateWithMedia(size) {
  const JSZip = require('jszip');
  const zip = await JSZip.loadAsync(fs.readFileSync(path.join(ROOT, 'assets', '重复入金召回邮件模板.xlsx')));
  zip.file('xl/media/image1.png', Buffer.alloc(size));
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

test('中央目录与本地文件头互相矛盾的 ZIP：按中央目录解出后重新打包，矛盾的元信息不会进入保存的文件', { timeout: 120000 }, async (t) => {
  const env = setup(t);
  const write = (name, buffer) => {
    const file = path.join(env.files, name);
    fs.writeFileSync(file, buffer);
    return file;
  };

  // 1. 只把中央目录中的图片名改成目录名（长度不变），本地文件头仍是文件名：目录条目带内容，拒绝。
  const renamed = await mailTemplateWithMedia(2 * 1024 * 1024);
  const central = zipRecordOffsets(renamed, CENTRAL_HEADER)
    .find((offset) => renamed.toString('latin1', offset + 46, offset + 46 + renamed.readUInt16LE(offset + 28)) === 'xl/media/image1.png');
  renamed.write('/', central + 46 + 'xl/media/image1.png'.length - 1, 'latin1');
  const renamedPrepared = await prepare(env.service, 'dup-recall-mail', write('renamed.xlsx', renamed));
  assert.equal(renamedPrepared.verdict, 'fail');
  assert.equal(renamedPrepared.checks.find((check) => check.label === '读取文件').detail,
    '文件的目录条目带有内容（xl/media/image1.pn/），无法安全读取');

  // 2. 结尾记录声明的总条目数为 0：按中央目录读不到任何条目，重新打包后的文件不是有效工作簿，拒绝。
  const emptied = await mailTemplateWithMedia(1024);
  const end = zipRecordOffsets(emptied, END_OF_CENTRAL_DIRECTORY).pop();
  emptied.writeUInt16LE(0, end + 10);
  assert.equal((await prepare(env.service, 'dup-recall-mail', write('emptied.xlsx', emptied))).verdict, 'fail');

  // 3. 本地文件头把工作表的解压大小写成 1 GiB（中央目录正确）：按中央目录解出，保存的是重新打包的文件，不含该矛盾。
  const lying = await restyledTemplate('assets/重复入金召回邮件模板.xlsx', path.join(env.files, 'lying-source.xlsx'), widenMailColumn)
    .then((file) => fs.readFileSync(file));
  const sheetHeader = zipRecordOffsets(lying, LOCAL_HEADER)
    .find((offset) => lying.toString('latin1', offset + 30, offset + 30 + lying.readUInt16LE(offset + 26)) === 'xl/worksheets/sheet1.xml');
  lying.writeUInt32LE(1024 * 1024 * 1024, sheetHeader + 22);
  const version = await importVersion(env.service, 'dup-recall-mail', write('lying.xlsx', lying), { enable: false });
  const saved = fs.readFileSync(env.versionFile('dup-recall-mail', version.id));
  assert.equal(saved.equals(lying), false, '保存的不是原文件');
  const savedSheet = zipRecordOffsets(saved, LOCAL_HEADER)
    .find((offset) => saved.toString('latin1', offset + 30, offset + 30 + saved.readUInt16LE(offset + 26)) === 'xl/worksheets/sheet1.xml');
  assert.ok(saved.readUInt32LE(savedSheet + 22) < 1024 * 1024, '本地文件头的大小与实际一致');
  assert.ok(saved.equals(await canonicalizeXlsx(saved)), '重新打包是幂等的');
});

test('已存版本大小与记录不一致时不在主进程整份读入', async (t) => {
  const env = setup(t);
  const file = await restyledTemplate('assets/重复入金召回邮件模板.xlsx', path.join(env.files, 'a.xlsx'), widenMailColumn);
  await importVersion(env.service, 'dup-recall-mail', file);
  fs.writeFileSync(env.versionFile('dup-recall-mail', 'v2'), Buffer.alloc(3 * 1024 * 1024));
  let reads = 0;
  const restarted = createTemplateResourceService({
    appRoot: ROOT,
    userDataRoot: env.userData,
    store: env.store,
    readFileCapped: async () => {
      reads += 1;
      throw new Error('不应读取');
    }
  });
  const current = (await restarted.get('dup-recall-mail')).resource.current;
  assert.deepEqual([current.validation, current.validationMessage], ['failed', '版本文件已被修改（大小与记录不一致）']);
  await assert.rejects(restarted.acquire('dup-recall-mail'), /大小与记录不一致/);
  assert.equal(reads, 0);
});

test('检查排队有数量与字节上限，超出时按繁忙处理', { timeout: 120000 }, async (t) => {
  await waitInspectionsIdle();
  const payload = {
    task: 'inspect',
    resource: { id: 'dup-recall-mail', type: 'output', headerRow: 1 },
    bytes: fs.readFileSync(path.join(ROOT, 'assets', '重复入金召回邮件模板.xlsx')),
    context: {}
  };
  const accepted = [0, 1, 2, 3, 4].map(() => runTemplateInspection(payload));
  assert.deepEqual([inspectionStats().running, inspectionStats().queued], [1, 4]);
  await assert.rejects(runTemplateInspection(payload), (error) => error.transient === true && error.message === '模板检查繁忙（排队已满），请稍后重试');
  await Promise.all(accepted);
  await waitInspectionsIdle();

  const running = runTemplateInspection(payload);
  const large = { ...payload, bytes: Buffer.alloc(33 * 1024 * 1024) };
  const firstLarge = runTemplateInspection(large);
  await assert.rejects(runTemplateInspection(large), /排队已满/);
  await running;
  assert.equal((await firstLarge).contract.ok, false, '无效内容照常检查并判为不通过');
  await waitInspectionsIdle();
});

test('取值快照为空时交由调用方按原逻辑降级', async (t) => {
  const env = setup(t);
  const bytes = await canonicalizeXlsx(fs.readFileSync(await writeOffsetWorkbook(path.join(env.files, 'fund.xlsx'), 1, 1, [['FundType'], ['KEEP']])));
  fs.mkdirSync(path.dirname(env.versionFile('fund-type-enum', 'v2')), { recursive: true });
  fs.writeFileSync(env.versionFile('fund-type-enum', 'v2'), bytes);
  assert.equal(commitRecord(env.store, 'fund-type-enum', {
    versionId: 'v2', versionNo: 2, bytes, structure: { enumValues: [], comparableValues: [] }, enable: true, expectedVersionId: 'v1'
  }).status, 'success');
  assert.deepEqual(await env.service.currentRuntimeValues('fund-type-enum'), { status: 'unavailable', message: '版本取值为空', versionId: 'v2' });
});

test('取用用户版本时返回核对过的字节；之后版本文件被替换，本次导出仍使用检查过的内容', async (t) => {
  const env = setup(t);
  const file = await restyledTemplate('assets/重复入金召回邮件模板.xlsx', path.join(env.files, 'a.xlsx'), widenMailColumn);
  await importVersion(env.service, 'dup-recall-mail', file);
  const checked = sha256(fs.readFileSync(env.versionFile('dup-recall-mail', 'v2')));
  const lease = await env.service.acquire('dup-recall-mail', { label: '重复入金导出' });
  assert.equal(sha256(lease.bytes), checked);
  assert.equal(lease.sha256, checked);
  fs.writeFileSync(env.versionFile('dup-recall-mail', 'v2'), 'replaced after check');
  assert.equal(sha256(lease.bytes), checked, '租约中的字节不受文件替换影响');
  lease.release();
});

test('检查 Worker 同一时间只运行一个、退出后才释放名额；同一内容的复核合并为一次；启动失败按暂不可用处理', { timeout: 120000 }, async (t) => {
  await waitInspectionsIdle();
  const payload = {
    task: 'inspect',
    resource: { id: 'dup-recall-mail', type: 'output', headerRow: 1 },
    bytes: fs.readFileSync(path.join(ROOT, 'assets', '重复入金召回邮件模板.xlsx')),
    context: {}
  };
  const runs = [runTemplateInspection(payload), runTemplateInspection(payload), runTemplateInspection(payload)];
  assert.deepEqual([inspectionStats().running, inspectionStats().queued], [1, 2]);
  assert.ok((await Promise.all(runs)).every((result) => result.contract.ok));
  await waitInspectionsIdle();

  // Worker 无法启动（此处用无法传给 Worker 的数据触发）属于运行环境问题；只有超出堆上限才算文件本身的问题。
  await assert.rejects(runTemplateInspection({ ...payload, context: { unclonable: () => {} } }),
    (error) => error.transient === true && /^模板检查暂时无法启动：/.test(error.message));
  await waitInspectionsIdle();

  const env = setup(t);
  const file = await restyledTemplate('assets/重复入金召回邮件模板.xlsx', path.join(env.files, 'a.xlsx'), widenMailColumn);
  await importVersion(env.service, 'dup-recall-mail', file);
  let calls = 0;
  let broken = true;
  const counting = createTemplateResourceService({
    appRoot: ROOT,
    userDataRoot: env.userData,
    store: env.store,
    runInspection: (request) => {
      calls += 1;
      return broken
        ? Promise.reject(new TemplateInspectionError('模板检查暂时无法完成：Cannot find module，请稍后重试'))
        : runTemplateInspection(request);
    }
  });
  const failed = (await counting.get('dup-recall-mail')).resource.current;
  assert.equal(failed.validation, 'unverified', '启动失败不判为不兼容');
  broken = false;
  calls = 0;
  const [first, second] = await Promise.all([counting.get('dup-recall-mail'), counting.get('dup-recall-mail')]);
  assert.equal(first.resource.current.validation, 'passed', '恢复后重新复核');
  assert.equal(second.resource.current.validation, 'passed');
  assert.equal(calls, 1, '同一内容的并发复核只启动一次检查');
});

test('打印区域只支持一个：Excel 同一定义中的多个区域、ExcelJS 写出的多个定义都在预检拒绝', async (t) => {
  const env = setup(t);
  // Excel 把多个打印区域写在同一个定义里（逗号分隔），ExcelJS 读入后只剩第一个。
  const excelUnion = await patchXlsx('assets/平盘银行对账单.xlsx', path.join(env.files, 'position-union.xlsx'), {
    'xl/workbook.xml': (xml) => xml.replace('</sheets>',
      '</sheets><definedNames><definedName name="_xlnm.Print_Area" localSheetId="0">\'渠道对账单\'!$A$1:$C$3,\'渠道对账单\'!$E$1:$AW$3</definedName></definedNames>')
  });
  const excelPrepared = await prepare(env.service, 'position-bank', excelUnion);
  assert.equal(excelPrepared.verdict, 'fail', JSON.stringify(excelPrepared.checks));
  assert.equal(excelPrepared.checks.find((check) => check.label === '打印区域').detail,
    '「渠道对账单」设置了多个打印区域，导出时无法按结果行数调整，请在 Excel 中只保留一个区域后再导入');

  const stacked = await restyledTemplate('assets/资金对账导出不平.xlsx', path.join(env.files, 'prefund-stacked.xlsx'), (workbook) => {
    workbook.getWorksheet('平账结果').pageSetup.printArea = 'A1:AE3&&A4:AE6';
  });
  const stackedPrepared = await prepare(env.service, 'prefund-unbalanced', stacked);
  assert.equal(stackedPrepared.verdict, 'fail', JSON.stringify(stackedPrepared.checks));
  assert.match(stackedPrepared.checks.find((check) => check.label === '打印区域').detail, /^「平账结果」设置了多个打印区域/);

  const single = await restyledTemplate('assets/资金对账导出不平.xlsx', path.join(env.files, 'prefund-single.xlsx'), (workbook) => {
    workbook.getWorksheet('平账结果').pageSetup.printArea = 'A1:AE3';
    workbook.getWorksheet('不平结果').autoFilter = 'A1:U1';
  });
  const singlePrepared = await prepare(env.service, 'prefund-unbalanced', single);
  assert.equal(singlePrepared.verdict, 'pass', JSON.stringify(singlePrepared.checks));
});

test('比较基准不信任被改动或读不出的当前文件：优先用导入时的取值快照，取不到时按场景引用逐项核对', async (t) => {
  const scenarios = [
    { id: 1, category: 'offset-bill-mark', config: { billTypes: [{ seq: 1, conditions: [{ field: 'FundType', op: '等于', value: 'REMOVE' }] }] } }
  ];
  const env = setup(t, { scenarios });
  const keepOnly = await writeOffsetWorkbook(path.join(env.files, 'keep-only.xlsx'), 3, 2, [['FundType'], ['KEEP']]);
  const blockedRemove = (prepared) => {
    assert.equal(prepared.verdict, 'fail', JSON.stringify(prepared.checks));
    assert.equal(prepared.checks.find((check) => check.label === '场景引用').detail, '已被场景使用：REMOVE');
  };

  // 1. 当前 V2 的磁盘文件被改成只剩 KEEP：仍按导入时保存的快照（KEEP、REMOVE）比较。
  await importVersion(env.service, 'fund-type-enum',
    await writeOffsetWorkbook(path.join(env.files, 'v2.xlsx'), 3, 2, [['FundType'], ['KEEP'], ['REMOVE']]));
  fs.copyFileSync(keepOnly, env.versionFile('fund-type-enum', 'v2'));
  const tampered = await prepare(env.service, 'fund-type-enum', keepOnly);
  blockedRemove(tampered);
  assert.equal(tampered.checks.some((check) => check.label === '比较基准'), false, '快照可用时不需要提示');

  // 2. 早期记录没有快照：文件完好时核对 SHA-256 后按运行时口径重新解析。
  const legacyBytes = await canonicalizeXlsx(fs.readFileSync(await writeOffsetWorkbook(path.join(env.files, 'v3.xlsx'), 3, 2, [['FundType'], ['KEEP'], ['REMOVE'], ['EXTRA']])));
  const legacyTarget = env.versionFile('fund-type-enum', 'v3');
  fs.writeFileSync(legacyTarget, legacyBytes);
  const createdAt = '2026-10-20T08:00:00.000Z';
  assert.equal(env.store.commitTemplateResourceVersion({
    resourceId: 'fund-type-enum',
    version: { versionId: 'v3', versionNo: 3, fileName: 'v3.xlsx', sizeBytes: legacyBytes.length, sha256: sha256(legacyBytes), validation: 'passed', structure: {}, appVersion: '3.2.12', createdAt },
    enable: true,
    expectedVersionId: 'v2',
    now: createdAt,
    change: { createdAt, resourceId: 'fund-type-enum', action: '导入并启用', fromLabel: 'V2', toLabel: 'V3', result: 'success' }
  }).status, 'success');
  const reparsed = await prepare(env.service, 'fund-type-enum', keepOnly);
  blockedRemove(reparsed);
  assert.deepEqual(reparsed.diff.removed, ['REMOVE', 'EXTRA']);
  assert.equal(reparsed.checks.some((check) => check.label === '比较基准'), false);

  // 3. 早期记录的文件被改动（SHA-256 不一致）：同一服务沿用此前从核对过的内容解析出的取值；
  //    重建后的服务不采用被改动的文件，提示后按场景引用逐项核对，仍拦下 REMOVE。
  fs.copyFileSync(keepOnly, legacyTarget);
  const cached = await prepare(env.service, 'fund-type-enum', keepOnly);
  blockedRemove(cached);
  assert.equal(cached.checks.some((check) => check.label === '比较基准'), false, '沿用已核对内容解析出的取值');
  const restarted = () => createTemplateResourceService({ appRoot: ROOT, userDataRoot: env.userData, store: env.store });
  const untrusted = await prepare(restarted(), 'fund-type-enum', keepOnly);
  blockedRemove(untrusted);
  // 被改动的文件比记录大时读取在上限处停止，比记录小时读完后 SHA-256 不一致：两种情况都不采用该文件。
  assert.match(untrusted.checks.find((check) => check.label === '比较基准').detail,
    /^无法确认当前版本 V3 的取值（版本文件(已被修改（SHA-256 不一致）|无法读取：文件超过 \d+ 字节的读取上限)），按场景引用逐项核对$/);

  // 4. 早期记录的文件缺失：同样按场景引用逐项核对。
  fs.rmSync(legacyTarget);
  const missing = await prepare(restarted(), 'fund-type-enum', keepOnly);
  blockedRemove(missing);
  assert.match(missing.checks.find((check) => check.label === '比较基准').detail, /^无法确认当前版本 V3 的取值（版本文件无法读取：ENOENT/);
});

test('版本路径被同名目录替代：判为版本文件缺失（不兼容），不是暂不可用', async (t) => {
  const env = setup(t);
  const file = await restyledTemplate('assets/重复入金召回邮件模板.xlsx', path.join(env.files, 'a.xlsx'), widenMailColumn);
  await importVersion(env.service, 'dup-recall-mail', file);
  const versionPath = env.versionFile('dup-recall-mail', 'v2');
  fs.rmSync(versionPath);
  fs.mkdirSync(versionPath);
  const restarted = createTemplateResourceService({ appRoot: ROOT, userDataRoot: env.userData, store: env.store });
  const current = (await restarted.get('dup-recall-mail')).resource.current;
  assert.deepEqual([current.validation, current.validationMessage], ['failed', '版本文件缺失']);
  await assert.rejects(restarted.acquire('dup-recall-mail'), /版本文件缺失。请在 设置 → 模板文件 恢复默认或重新导入$/);

  // stat 之后才被替换（读取时报 EISDIR）同样判为缺失。
  fs.rmSync(versionPath, { recursive: true });
  fs.copyFileSync(file, versionPath);
  const racing = createTemplateResourceService({
    appRoot: ROOT,
    userDataRoot: env.userData,
    store: env.store,
    readFileCapped: async (filePath) => {
      if (filePath === versionPath) throw Object.assign(new Error(`EISDIR: illegal operation on a directory, read`), { code: 'EISDIR', syscall: 'read' });
      return fs.promises.readFile(filePath);
    }
  });
  assert.equal((await racing.get('dup-recall-mail')).resource.current.validation, 'failed');
});

test('场景引用只收集 FundType 取值与 C3 网关字段，忽略自取值', () => {
  const references = collectScenarioReferences([
    { category: 'offset-bill-mark', config: { billTypes: [{ conditions: [{ field: 'FundType', value: ' Inbound ' }, { field: 'Channel', value: 'X' }] }] } },
    { category: 'gateway-recon-join', config: { reconFields: [{ gwField: 'amount' }], conditions: [{ side: '网关', field: 'currency' }], assign: { gwField: '__CUSTOM__' } } },
    { category: 'extract-recon-id', config: { reconFields: [{ gwField: 'ignored' }] } },
    { category: 'gateway-recon-join', config: null }
  ]);
  assert.deepEqual([...references.fundTypeValues], ['Inbound']);
  assert.deepEqual([...references.gatewayFields].sort(), ['amount', 'currency']);
});

test('当前用户版本文件被改动或缺失：标记不可用，导出取用时报错并指向设置', async (t) => {
  const env = setup(t);
  const file = await restyledTemplate('assets/重复入金召回邮件模板.xlsx', path.join(env.files, 'a.xlsx'), widenMailColumn);
  await importVersion(env.service, 'dup-recall-mail', file);
  const versionPath = env.versionFile('dup-recall-mail', 'v2');

  fs.appendFileSync(versionPath, Buffer.from('tamper'));
  const tampered = (await env.service.get('dup-recall-mail')).resource.current;
  assert.equal(tampered.validation, 'failed');
  assert.equal(tampered.validationMessage, '版本文件已被修改（大小与记录不一致）');
  await assert.rejects(env.service.acquire('dup-recall-mail'), (error) => (
    error instanceof TemplateResourceUnavailableError
    && error.message === '模板「重复入金召回邮件模板」当前版本 V2 不可用：版本文件已被修改（大小与记录不一致）。请在 设置 → 模板文件 恢复默认或重新导入'
  ));
  assert.deepEqual((await env.service.get('dup-recall-mail')).resource.tasks, [], '取用失败时释放已登记的租约');
  assert.deepEqual(await env.service.resolveCurrentFile('dup-recall-mail'),
    { status: 'unavailable', message: '版本文件已被修改（大小与记录不一致）', versionId: 'v2' });

  fs.rmSync(versionPath);
  const missing = (await env.service.get('dup-recall-mail')).resource;
  assert.equal(missing.current.validationMessage, '版本文件缺失');
  assert.equal(missing.capabilities.saveAs, false);
  assert.equal(missing.capabilities.restoreDefault, true);

  assert.equal((await env.service.setCurrentVersion({ resourceId: 'dup-recall-mail', versionId: 'v1', expectedVersionId: 'v2' })).status, 'success');
  assert.deepEqual(await env.service.setCurrentVersion({ resourceId: 'dup-recall-mail', versionId: 'v2', expectedVersionId: 'v1' }),
    { status: 'failed', message: 'V2 不能启用：版本文件缺失' });
});

test('升级后契约变化：已启用的用户版本保留为当前版本，但标为不兼容并拒绝导出', async (t) => {
  const env = setup(t);
  // 模拟旧版本程序接受过、现行契约不再接受的文件：绕过预检直接写入版本记录。
  const legacy = await restyledTemplate('assets/资金对账导出不平.xlsx', path.join(env.files, 'legacy.xlsx'), (workbook) => {
    workbook.getWorksheet('不平结果').spliceColumns(21, 1);
  });
  const bytes = await canonicalizeXlsx(fs.readFileSync(legacy));
  const target = env.versionFile('prefund-unbalanced', 'v2');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, bytes);
  const createdAt = '2026-10-01T08:00:00.000Z';
  assert.equal(env.store.commitTemplateResourceVersion({
    resourceId: 'prefund-unbalanced',
    version: { versionId: 'v2', versionNo: 2, fileName: 'legacy.xlsx', sizeBytes: bytes.length, sha256: sha256(bytes), validation: 'passed', structure: {}, appVersion: '3.2.12', createdAt },
    enable: true,
    expectedVersionId: 'v1',
    now: createdAt,
    change: { createdAt, resourceId: 'prefund-unbalanced', action: '导入并启用', fromLabel: 'V1', toLabel: 'V2', result: 'success' }
  }).status, 'success');

  const { resource } = await env.service.get('prefund-unbalanced');
  assert.equal(resource.current.id, 'v2');
  assert.equal(resource.current.validation, 'failed');
  assert.match(resource.current.validationMessage, /^与本版程序不兼容：表头：资金对账导出模板「不平结果」表头不兼容/);
  await assert.rejects(env.service.acquire('prefund-unbalanced'), /当前版本 V2 不可用：与本版程序不兼容.*请在 设置 → 模板文件 恢复默认或重新导入/);
});

test('取用当前版本时先登记租约：复核期间切换并删除该版本会被拦下', async (t) => {
  const env = setup(t);
  const file = await restyledTemplate('assets/重复入金召回邮件模板.xlsx', path.join(env.files, 'a.xlsx'), widenMailColumn);
  await importVersion(env.service, 'dup-recall-mail', file);
  const versionPath = env.versionFile('dup-recall-mail', 'v2');
  // 重建服务（复核缓存为空），版本文件的 stat 停在闸门处，模拟复核仍在进行。
  let openGate;
  const gate = new Promise((resolve) => { openGate = resolve; });
  const restarted = createTemplateResourceService({
    appRoot: ROOT,
    userDataRoot: env.userData,
    store: env.store,
    stat: async (filePath) => {
      if (filePath === versionPath) await gate;
      return fs.promises.stat(filePath);
    }
  });
  const pending = restarted.acquire('dup-recall-mail', { label: '重复入金导出' });
  assert.equal((await restarted.setCurrentVersion({ resourceId: 'dup-recall-mail', versionId: 'v1', expectedVersionId: 'v2' })).status, 'success');
  assert.deepEqual(await restarted.deleteVersion({ resourceId: 'dup-recall-mail', versionId: 'v2' }),
    { status: 'failed', message: '1 个任务正在使用该版本' });
  openGate();
  const lease = await pending;
  assert.equal(lease.versionId, 'v2');
  assert.ok(fs.existsSync(lease.filePath), '复核结束后版本文件仍在');
  lease.release();
  assert.deepEqual(await restarted.deleteVersion({ resourceId: 'dup-recall-mail', versionId: 'v2' }), { status: 'success' });
});

const tintPendingHeader = (workbook) => {
  workbook.worksheets[0].getCell('A1').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDDEEFF' } };
};

test('兼容复核遇到运行环境异常：提示稍后重试且不缓存，环境恢复后重新复核通过', async (t) => {
  const env = setup(t, { inProcess: true });
  const file = await restyledTemplate('assets/VCC财务OP校验/移除归档Pending发生额计算表.xlsx', path.join(env.files, 'vcc.xlsx'), tintPendingHeader);
  await importVersion(env.service, 'vcc-pending-calc', file);
  const mkdtempSync = fs.mkdtempSync;
  let failing = true;
  t.mock.method(fs, 'mkdtempSync', (prefix, ...rest) => {
    if (failing && String(prefix).includes('vcc-pending-template-probe-')) {
      throw Object.assign(new Error(`ENOSPC: no space left on device, mkdtemp '${prefix}XXXXXX'`), { code: 'ENOSPC', syscall: 'mkdtemp' });
    }
    return mkdtempSync.call(fs, prefix, ...rest);
  });

  // 重建服务（复核缓存为空）：试写因环境异常失败，版本暂不可用，但不判为不兼容、不引导恢复默认。
  const restarted = createTemplateResourceService({ appRoot: ROOT, userDataRoot: env.userData, store: env.store, runInspection: runInspectionTask });
  const blocked = (await restarted.get('vcc-pending-calc')).resource.current;
  assert.equal(blocked.validation, 'unverified', '复核未完成，与不兼容区分');
  assert.match(blocked.validationMessage, /^兼容复核未完成：样式：运行环境异常（ENOSPC/);
  await assert.rejects(restarted.acquire('vcc-pending-calc', { withBytes: true }), (error) => (
    error instanceof TemplateResourceUnavailableError && /请稍后重试$/.test(error.message) && !/恢复默认/.test(error.message)
  ));
  const other = await restyledTemplate('assets/VCC财务OP校验/移除归档Pending发生额计算表.xlsx', path.join(env.files, 'vcc-b.xlsx'), (workbook) => {
    workbook.worksheets[0].getCell('B1').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEEDDCC' } };
  });
  const preflight = await prepare(restarted, 'vcc-pending-calc', other);
  assert.match(preflight.checks.find((check) => check.label === '样式').detail, /^运行环境异常（ENOSPC.*请稍后重试$/);

  failing = false;
  assert.equal((await restarted.get('vcc-pending-calc')).resource.current.validation, 'passed', '环境恢复后重新复核');
  const lease = await restarted.acquire('vcc-pending-calc', { withBytes: true });
  assert.equal(lease.versionId, 'v2');
  lease.release();
});

test('试写回读时的系统错误被读取层包装后仍判为运行环境异常，不缓存', async (t) => {
  const env = setup(t, { inProcess: true });
  const file = await restyledTemplate('assets/VCC财务OP校验/移除归档Pending发生额计算表.xlsx', path.join(env.files, 'vcc.xlsx'), tintPendingHeader);
  await importVersion(env.service, 'vcc-pending-calc', file);
  // 回读校验经 openZipWithEntries 打开临时文件，yauzl 的系统错误在那里被包装成 BigTableImportError。
  const yauzl = require('yauzl');
  const open = yauzl.open;
  let failing = true;
  let probeOpens = 0;
  t.mock.method(yauzl, 'open', (filePath, options, callback) => {
    if (String(filePath).includes('vcc-pending-template-probe-')) {
      probeOpens += 1;
      if (failing) {
        callback(Object.assign(new Error(`EMFILE: too many open files, open '${filePath}'`), { code: 'EMFILE', syscall: 'open' }));
        return;
      }
    }
    open.call(yauzl, filePath, options, callback);
  });

  const restarted = createTemplateResourceService({ appRoot: ROOT, userDataRoot: env.userData, store: env.store, runInspection: runInspectionTask });
  const blocked = (await restarted.get('vcc-pending-calc')).resource.current;
  assert.equal(probeOpens, 1);
  assert.equal(blocked.validation, 'unverified', '复核未完成，与不兼容区分');
  assert.match(blocked.validationMessage, /^兼容复核未完成：样式：运行环境异常（.*EMFILE/);

  failing = false;
  assert.equal((await restarted.get('vcc-pending-calc')).resource.current.validation, 'passed', '环境恢复后重新复核');
  const afterRecheck = probeOpens;
  assert.ok(afterRecheck > 1, '失败结果没有被缓存，恢复后重新试写');
  await restarted.get('vcc-pending-calc');
  assert.equal(probeOpens, afterRecheck, '通过的结果照常缓存');
});

test('VCC 试写后清理临时目录失败不覆盖预检结论', async (t) => {
  const env = setup(t, { inProcess: true });
  const rmSync = fs.rmSync;
  const leftovers = [];
  t.mock.method(fs, 'rmSync', (target, ...rest) => {
    if (String(target).includes('vcc-pending-template-probe-')) {
      leftovers.push(target);
      throw Object.assign(new Error(`EBUSY: resource busy or locked, rmdir '${target}'`), { code: 'EBUSY', syscall: 'rmdir' });
    }
    return rmSync.call(fs, target, ...rest);
  });
  t.after(() => leftovers.forEach((target) => rmSync.call(fs, target, { recursive: true, force: true })));
  const file = await restyledTemplate('assets/VCC财务OP校验/移除归档Pending发生额计算表.xlsx', path.join(env.files, 'vcc.xlsx'), tintPendingHeader);
  const prepared = await prepare(env.service, 'vcc-pending-calc', file);
  assert.equal(prepared.verdict, 'pass', JSON.stringify(prepared.checks));
  assert.equal(prepared.checks.find((check) => check.label === '样式').status, 'pass');
  assert.equal(leftovers.length, 1);
});

test('首次使用时清扫库中无记录的版本文件与写入残留，不动已登记版本与其他文件', async (t) => {
  const env = setup(t);
  const file = await restyledTemplate('assets/重复入金召回邮件模板.xlsx', path.join(env.files, 'a.xlsx'), widenMailColumn);
  await importVersion(env.service, 'dup-recall-mail', file);

  const directory = path.dirname(env.versionFile('dup-recall-mail', 'v2'));
  fs.writeFileSync(path.join(directory, 'v7.xlsx'), 'orphan');
  fs.writeFileSync(path.join(directory, 'v8.xlsx.tmp-1-2'), 'partial');
  fs.writeFileSync(path.join(directory, '说明.txt'), 'keep');
  const restarted = createTemplateResourceService({ appRoot: ROOT, userDataRoot: env.userData, store: env.store });
  await restarted.list();
  assert.deepEqual(fs.readdirSync(directory).sort(), ['v2.xlsx', '说明.txt']);
  assert.equal((await restarted.get('dup-recall-mail')).resource.current.id, 'v2', '重建服务后状态保持');
});

test('写入版本记录失败：删除已写出的版本文件并记录失败变更', async (t) => {
  const store = createTemplateResourceStore();
  const commit = store.commitTemplateResourceVersion;
  store.commitTemplateResourceVersion = () => { throw new Error('SQLITE_FULL: database or disk is full'); };
  const env = setup(t, { store });
  const file = await restyledTemplate('assets/重复入金召回邮件模板.xlsx', path.join(env.files, 'a.xlsx'), widenMailColumn);
  const prepared = await prepare(env.service, 'dup-recall-mail', file);
  assert.deepEqual(await env.service.commitImport({ importToken: prepared.importToken, enable: true }),
    { status: 'failed', message: '保存失败：SQLITE_FULL: database or disk is full' });
  assert.equal(fs.existsSync(env.versionFile('dup-recall-mail', 'v2')), false);
  assert.deepEqual(env.service.listChanges().changes.map((change) => [change.action, change.result, change.detail]), [
    ['导入并启用', 'failed', '写入版本记录失败：SQLITE_FULL: database or disk is full']
  ]);
  assert.deepEqual(env.changed, []);
  store.commitTemplateResourceVersion = commit;
  assert.equal((await env.service.commitImport({ importToken: prepared.importToken, enable: true })).status, 'success', '失败后令牌仍可重试');
});

test('输出模板隐藏列或遮盖内容的数字格式、FundType 仅大小写不同的新值：提示确认但不阻止导入', async (t) => {
  const env = setup(t);
  const prefund = await restyledTemplate('assets/资金对账导出不平.xlsx', path.join(env.files, 'hidden.xlsx'), (workbook) => {
    const sheet = workbook.getWorksheet('不平结果');
    sheet.getColumn(10).hidden = true;
    sheet.getColumn(14).numFmt = '0;-0;0;"***"';
  });
  const prepared = await prepare(env.service, 'prefund-unbalanced', prefund);
  assert.equal(prepared.verdict, 'warn');
  assert.deepEqual(prepared.checks.filter((check) => check.status === 'warn').map((check) => [check.label, check.detail]), [
    ['隐藏列', '「不平结果」业务订单金额 在导出中隐藏'],
    ['数字格式', '「不平结果」渠道订单金额 的数字格式会遮盖或替换显示内容']
  ]);

  const vcc = await restyledTemplate('assets/VCC财务OP校验/移除归档Pending发生额计算表.xlsx', path.join(env.files, 'vcc-hidden.xlsx'), (workbook) => {
    workbook.worksheets[0].getColumn(11).hidden = true;
    workbook.worksheets[0].getCell('J2').numFmt = ';;;';
  });
  const vccPrepared = await prepare(env.service, 'vcc-pending-calc', vcc);
  assert.deepEqual(vccPrepared.checks.filter((check) => check.status === 'warn').map((check) => check.label), ['隐藏列', '数字格式']);

  const builtinFundTypes = (await env.service.get('fund-type-enum')).resource.enumValues;
  const lookalike = await writeEnumWorkbook(path.join(env.files, 'fund-type-case.xlsx'),
    [['FundType'], ...builtinFundTypes.map((value) => [value]), [builtinFundTypes[0].toUpperCase()]]);
  const lookalikePrepared = await prepare(env.service, 'fund-type-enum', lookalike);
  assert.equal(lookalikePrepared.verdict, 'warn');
  assert.equal(lookalikePrepared.checks.find((check) => check.label === '相近取值').detail,
    `与已有取值仅大小写或空格不同：${builtinFundTypes[0].toUpperCase()}（已有 ${builtinFundTypes[0]}）`);
});
