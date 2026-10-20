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
const { createTemplateResourceStore, restyledTemplate } = require('../../helpers/template-resource-store');

const ROOT = path.join(__dirname, '..', '..', '..');
const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const checksOf = (prepared, group = 'file') => prepared.checks.filter((check) => check.group === group)
  .map((check) => [check.label, check.status]);

function setup(t, { scenarios = [], store = null } = {}) {
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
    now: () => clock
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
  assert.equal(sha256(fs.readFileSync(env.versionFile('dup-recall-mail', 'v2'))), prepared.file.sha256);
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
  assert.equal(tampered.validationMessage, '版本文件已被修改（SHA-256 不一致）');
  await assert.rejects(env.service.acquire('dup-recall-mail'), (error) => (
    error instanceof TemplateResourceUnavailableError
    && error.message === '模板「重复入金召回邮件模板」当前版本 V2 不可用：版本文件已被修改（SHA-256 不一致）。请在 设置 → 模板文件 恢复默认或重新导入'
  ));
  assert.deepEqual(await env.service.resolveCurrentFile('dup-recall-mail'),
    { status: 'unavailable', message: '版本文件已被修改（SHA-256 不一致）', versionId: 'v2' });

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
  const bytes = fs.readFileSync(legacy);
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
