'use strict';

// v3.2.14：设置 → 模板文件「银行对账单（导入识别结构）」（D17–D19）。启用用户版本后同时接受内置 46 列与当前版本，
//   按当前版本读出的行对应回内置 46 列；场景引用的银行字段受保护；识别器为同一表保留内置与当前版本两条签名。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const XLSX = require('xlsx');

const { readBankStatement } = require('../../../src/main-process/bank-statement-io');
const { BANK_STATEMENT_FIELDS, BANK_STATEMENT_REQUIRED_FIELDS } = require('../../../src/constants/bank-statement-fields');
const { ALL_TABLE_SIGNATURES, LINKED_IMPORT_SIGNATURES } = require('../../../src/constants/table-signatures');
const { detectTableType } = require('../../../src/main-process/table-type-detector');
const {
  projectLinkedRow, versionSignatureOf, withBankStatementStructure
} = require('../../../src/main-process/linked-structure-signatures');
const { collectScenarioReferences } = require('../../../src/main-process/template-resources/contracts');
const { createTemplateResourceService } = require('../../../src/main-process/template-resources/service');
const { bankStatementSourceHeaders, resolveBankStatementStructure } = require('../../../src/main-process/bank-statement-structure');
const { createTemplateResourceStore } = require('../../helpers/template-resource-store');

const ROOT = path.join(__dirname, '..', '..', '..');
// V2：「合并单号」按位置改名为「合并编号」，删除「分类人」（其后各列左移，按列名对应），末尾新增一列；必用列不动。
const BANK_V2 = [...BANK_STATEMENT_FIELDS.filter((header) => header !== '分类人').map((header) => (header === '合并单号' ? '合并编号' : header)), '新增列'];
const USER = { status: 'user', headers: BANK_V2, label: 'V2' };

function workspace(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bank-statement-input-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return {
    root,
    write(name, headers, rows = [], sheetName = '渠道对账单') {
      const workbook = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([headers, ...rows.map((row) => headers.map((header) => row[header] ?? ''))]), sheetName);
      const filePath = path.join(root, name);
      XLSX.writeFile(workbook, filePath);
      return filePath;
    }
  };
}
const ROW = { BizId: 'B-1', BillDate: '2026-10-20', Channel: 'ADM', Currency: 'USD', 'Credit Amount': '100', 合并编号: '合并-1', 分类人: '张三', 新增列: '不导入' };

test('读取：内置 46 列照常；当前版本读出后对应回内置列；两者都不符时列出与最接近者的差异与指引', (t) => {
  const ws = workspace(t);
  const builtin = readBankStatement(ws.write('builtin.xlsx', BANK_STATEMENT_FIELDS, [{ ...ROW, 合并单号: '合并-0' }]), { sourceHeaders: BANK_V2 });
  assert.equal(builtin.structure, 'builtin');
  assert.equal(builtin.rows[0]['合并单号'], '合并-0');

  const current = readBankStatement(ws.write('v2.xlsx', BANK_V2, [ROW]), { sourceHeaders: BANK_V2 });
  assert.equal(current.structure, 'current');
  assert.deepEqual(current.headers, [...BANK_STATEMENT_FIELDS]);
  assert.deepEqual(Object.keys(current.rows[0]).filter((key) => key !== '_rowId'), [...BANK_STATEMENT_FIELDS]);
  assert.deepEqual([current.rows[0]['合并单号'], current.rows[0]['分类人'], current.rows[0].BizId, current.rows[0]._rowId], ['合并-1', '', 'B-1', 'row_0']);

  const other = BANK_V2.map((header) => (header === 'FundType' ? 'Fund Type' : header));
  assert.throws(() => readBankStatement(ws.write('other.xlsx', other), { sourceHeaders: BANK_V2 }), (error) => {
    assert.equal(error.name, 'FileValidationError');
    assert.match(error.message, /银行对账单表头与内置 46 列及当前版本都不一致/);
    assert.equal(error.detailLines[0], '最接近：银行对账单（当前版本 用户版本，46 列；文件 46 列）');
    assert.ok(error.detailLines.includes('如系统导出结构已变更，请在「设置 → 模板文件」导入新版本'));
    return true;
  });
  assert.throws(() => readBankStatement(ws.write('v2-only.xlsx', BANK_V2)), (error) => {
    assert.equal(error.code, 'invalid-column-name', '只认内置结构时保留原错误码');
    assert.equal(error.detailLines.at(-1), '如系统导出结构已变更，请在「设置 → 模板文件」导入新版本');
    return true;
  });
});

test('识别：同一表保留内置与当前版本两条签名，不判为命中多张表；按新结构的入金表经当前版本签名对应回内置列', async (t) => {
  const ws = workspace(t);
  const batch = withBankStatementStructure(ALL_TABLE_SIGNATURES, USER);
  assert.equal(batch.filter((signature) => signature.tableKey === 'bank-statement').length, 2);
  assert.equal(withBankStatementStructure(ALL_TABLE_SIGNATURES, { status: 'unavailable', message: 'x' }), ALL_TABLE_SIGNATURES);
  const v2File = ws.write('v2.xlsx', BANK_V2, [ROW]);
  const detected = await detectTableType(v2File, batch);
  assert.deepEqual([detected.status, detected.tableKey, detected.matchedVersion], ['matched', 'bank-statement', true]);
  const builtinDetected = await detectTableType(ws.write('builtin.xlsx', BANK_STATEMENT_FIELDS, [ROW]), batch);
  assert.deepEqual([builtinDetected.status, builtinDetected.tableKey, builtinDetected.matchedVersion], ['matched', 'bank-statement', undefined]);
  const same = await detectTableType(ws.write('same.xlsx', BANK_STATEMENT_FIELDS, [ROW]),
    withBankStatementStructure(ALL_TABLE_SIGNATURES, { ...USER, headers: [...BANK_STATEMENT_FIELDS] }));
  assert.equal(same.status, 'matched', '版本表头与内置相同时两条签名同时命中只计一次');

  const linked = withBankStatementStructure(LINKED_IMPORT_SIGNATURES, USER);
  const deposit = await detectTableType(v2File, linked);
  assert.deepEqual([deposit.tableKey, deposit.matchedVersion], ['bank-deposit', true]);
  const signature = versionSignatureOf(linked, 'bank-deposit');
  const row = projectLinkedRow(signature, Object.fromEntries(BANK_V2.map((header) => [header, ROW[header] ?? ''])));
  assert.deepEqual(Object.keys(row), [...BANK_STATEMENT_FIELDS]);
  assert.equal(row['合并单号'], '合并-1');
});

test('场景引用的银行字段：C1 / C2 / 内置固定场景的字段键与 C3 银行侧；C3 网关侧与 C4 不计入', () => {
  const { bankFields } = collectScenarioReferences([
    { category: 'extract-recon-id', config: { conditions: [{ field: '合并单号', op: '包含', value: 'X' }],
      featureBlock: { searchFields: ['Payment Detail', '分类人'] }, extractByOtherField: { field: 'Remark-BU' } } },
    { category: 'offset-bill-mark', config: { billTypes: [{ field: 'FundType' }], reconFields: [{ leftField: 'CustomerRef', rightField: 'Datasource' }],
      markValue: { field: 'FundType' } } },
    { category: 'builtin-fixed', config: { requireBankZeroField: 'Credit Amount' } },
    { category: 'gateway-recon-join', config: { reconFields: [{ gwField: 'Channel', bankField: '发生额绝对值' }, { gwField: 'x', bankField: 'tradeChannel' }],
      conditions: [{ side: '网关', field: 'Channel' }, { side: '银行', field: '地区' }], assign: { gwField: 'r', bankField: 'ReconciliationId' } } },
    { category: 'recon-id-fix', config: { billTypes: [{ side: 'main', conditions: [{ field: '回填方式' }] }] } }
  ]);
  assert.deepEqual([...bankFields].sort(), ['CustomerRef', 'Credit Amount', 'Datasource', 'FundType', 'Payment Detail', 'ReconciliationId',
    'Remark-BU', 'tradeChannel', '分类人', '合并单号', '地区'].sort());
});

function templates(t, scenarios = []) {
  const ws = workspace(t);
  const store = createTemplateResourceStore({ scenarios });
  const service = createTemplateResourceService({ appRoot: ROOT, appVersion: '9.9.9', userDataRoot: path.join(ws.root, 'userData'), store });
  t.after(() => { try { store.close(); } catch (_error) { /* 已关闭 */ } });
  const prepare = async (filePath) => {
    service.rememberPickedFile(filePath);
    const prepared = await service.prepareImport({ resourceId: 'bank-statement-input', filePath });
    assert.equal(prepared.status, 'success', prepared.message);
    return prepared;
  };
  return { ws, service, prepare };
}
const check = (prepared, label) => prepared.checks.find((item) => item.label === label);

test('模板预检：读取「渠道对账单」，必用列与场景引用保护，启用后解析为当前结构；详情显示用途名并与样式模板互标', async (t) => {
  const scenario = { id: 1, category: 'extract-recon-id', config: { conditions: [{ field: '合并单号', op: '包含', value: 'X' }, { field: '分类人', op: '包含', value: 'Y' }] } };
  const { ws, service, prepare } = templates(t, [scenario]);
  const prepared = await prepare(ws.write('v2.xlsx', BANK_V2));
  assert.equal(prepared.verdict, 'fail', '删除被场景引用的「分类人」被拦下');
  assert.equal(check(prepared, '场景引用').detail, '已被场景使用：分类人');
  assert.match(check(prepared, '列对应').detail, /按位置视为改名：第 17 列「合并编号」→「合并单号」/);

  const keepReferenced = BANK_V2.slice(0, -1).concat('分类人');
  const accepted = await prepare(ws.write('v2b.xlsx', keepReferenced));
  assert.equal(check(accepted, '场景引用').status, 'pass');
  assert.equal(check(accepted, 'Sheet 结构').detail, '读取「渠道对账单」');
  assert.equal((await service.commitImport({ importToken: accepted.importToken, enable: true })).status, 'success');
  const current = await resolveBankStatementStructure(service);
  assert.deepEqual([current.status, current.label, bankStatementSourceHeaders(current)], ['user', 'V2', keepReferenced]);

  const missing = await prepare(ws.write('missing.xlsx', BANK_STATEMENT_FIELDS.filter((header) => header !== 'Extra Fee')));
  assert.equal(check(missing, '必用列').detail, '缺少 Extra Fee（程序按列名读取，区分大小写）');
  const wrongSheet = await prepare(ws.write('sheet.xlsx', BANK_STATEMENT_FIELDS, [], 'Sheet1'));
  assert.equal(check(wrongSheet, 'Sheet 结构').detail, '缺少工作表「渠道对账单」');

  const { resource } = await service.get('bank-statement-input');
  assert.deepEqual([resource.name, resource.fileName, resource.twin], ['银行对账单（导入识别结构）', '银行对账单.xlsx', 'bank-statement']);
  assert.equal((await service.get('bank-statement')).resource.name, '银行对账单');
  assert.equal((await service.get('bank-statement')).resource.twin, 'bank-statement-input');
});

test('必用列覆盖各模块按列名读取的列；读取接入点均传入当前结构（源码守卫）', () => {
  for (const field of BANK_STATEMENT_REQUIRED_FIELDS) assert.ok(BANK_STATEMENT_FIELDS.includes(field), field);
  for (const field of ['BizId', 'Channel', '地区', 'Currency', 'Credit Amount', 'Debit Amount', 'ReconciliationId', 'FundType', 'Extra Fee', 'Payment Detail']) {
    assert.ok(BANK_STATEMENT_REQUIRED_FIELDS.includes(field), field);
  }
  const main = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'latin1');
  assert.equal((main.match(/readBankStatement\(filePath\)/g) || []).length, 0, 'main.js 的银行对账单读取都传入当前结构');
  assert.match(main, /importBank\(\s*taskContext\.fileEvidence\.filePlan\.inputs\[0\]\.filePath,\s*taskContext\.batchContext\.taskRunId,\s*\{ sourceHeaders: bankStatementSourceHeaders/);
  assert.match(main, /signature: result\.structure === 'current' && bankDepositVersionSignature/);
});
