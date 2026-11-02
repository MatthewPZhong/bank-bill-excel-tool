'use strict';

// 设置 → 模板文件：「单据对账导出不平」（C4 单据模式，4 张工作表）的导入识别结构。
// 覆盖多表结构预检、C4 场景引用保护、导入口径核对、启用后的当前结构，以及按当前结构读取文件。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const XLSX = require('xlsx');

const { createTemplateResourceService } = require('../../../src/main-process/template-resources/service');
const { readReconIdFixFile } = require('../../../src/main-process/recon-id-fix-io');
const {
  BUSINESS_BILL_FIELDS,
  BUSINESS_BILL_SHEET_NAME,
  OPPONENT_BILL_FIELDS,
  OPPONENT_BILL_SHEET_NAME,
  ORDER_REPAIR_FIELDS,
  ORDER_REPAIR_SHEET_NAME,
  RECON_ID_FIX_BILL_REQUIRED_FIELDS,
  RECON_RESULT_FIELDS,
  RECON_RESULT_SHEET_NAME
} = require('../../../src/constants/recon-id-fix-fields');
const { createTemplateResourceStore } = require('../../helpers/template-resource-store');

const ROOT = path.join(__dirname, '..', '..', '..');
const RESOURCE = 'doc-recon-unbalanced';
const RENAMED_BUSINESS = BUSINESS_BILL_FIELDS.map((header) => (header === 'clientId' ? 'customerId' : header));
const checksOf = (prepared) => prepared.checks.filter((check) => check.group === 'file').map((check) => [check.label, check.status]);

function setup(t, { scenarios = [] } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'template-doc-recon-'));
  const files = path.join(root, 'files');
  fs.mkdirSync(files, { recursive: true });
  const store = createTemplateResourceStore({ scenarios });
  const service = createTemplateResourceService({
    appRoot: ROOT, appVersion: '9.9.9', userDataRoot: path.join(root, 'userData'), store
  });
  t.after(() => {
    try { store.close(); } catch (_error) { /* 已关闭 */ }
    fs.rmSync(root, { recursive: true, force: true });
  });
  return {
    service,
    store,
    write(name, { business = BUSINESS_BILL_FIELDS, opponent = OPPONENT_BILL_FIELDS, omit = null, rows = {} } = {}) {
      const workbook = XLSX.utils.book_new();
      const sheets = [
        [RECON_RESULT_SHEET_NAME, RECON_RESULT_FIELDS],
        [BUSINESS_BILL_SHEET_NAME, business],
        [OPPONENT_BILL_SHEET_NAME, opponent],
        [ORDER_REPAIR_SHEET_NAME, ORDER_REPAIR_FIELDS]
      ].filter(([sheetName]) => sheetName !== omit);
      for (const [sheetName, headers] of sheets) {
        XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([headers, ...(rows[sheetName] || [])]), sheetName);
      }
      const filePath = path.join(files, name);
      XLSX.writeFile(workbook, filePath);
      return filePath;
    }
  };
}

async function prepare(service, filePath) {
  service.rememberPickedFile(filePath);
  const prepared = await service.prepareImport({ resourceId: RESOURCE, filePath });
  assert.equal(prepared.status, 'success', prepared.message);
  return prepared;
}

const c4Scenario = (mainField, oppField) => ({
  id: 9,
  category: 'recon-id-fix',
  config: {
    billTypes: [{ seq: 1, side: 'main', conditions: [{ field: mainField, op: '等于', value: '0' }] },
      { seq: 2, side: 'opp', conditions: [{ field: 'Type', op: '等于', value: '2' }] }],
    reconGroups: [{ leftTypeSeq: 1, rightTypeSeq: 2, fieldPairs: [
      { leftField: 'Amount', rightField: 'Amount', locked: true },
      { leftField: 'OrderId', rightField: oppField }
    ] }]
  }
});

test('内置结构：4 张工作表各自返回表头', async (t) => {
  const env = setup(t);
  const current = await env.service.currentInputStructure(RESOURCE);
  assert.equal(current.status, 'builtin');
  assert.deepEqual(current.sheets, {
    [RECON_RESULT_SHEET_NAME]: [...RECON_RESULT_FIELDS],
    [BUSINESS_BILL_SHEET_NAME]: [...BUSINESS_BILL_FIELDS],
    [OPPONENT_BILL_SHEET_NAME]: [...OPPONENT_BILL_FIELDS],
    [ORDER_REPAIR_SHEET_NAME]: [...ORDER_REPAIR_FIELDS]
  });
});

test('改名非必用列：逐表检查，变化以「工作表」列名展示；启用后当前结构为新表头，读取按新列名取键', async (t) => {
  const env = setup(t, { scenarios: [c4Scenario('Type', 'OrderId')] });
  const prepared = await prepare(env.service, env.write('新结构.xlsx', { business: RENAMED_BUSINESS }));
  assert.equal(prepared.verdict, 'warn', JSON.stringify(prepared.checks));
  assert.deepEqual(checksOf(prepared), [
    ['文件格式', 'pass'], ['Sheet 结构', 'pass'],
    [`表头 · ${RECON_RESULT_SHEET_NAME}`, 'pass'], [`表头 · ${BUSINESS_BILL_SHEET_NAME}`, 'pass'],
    [`表头 · ${OPPONENT_BILL_SHEET_NAME}`, 'pass'], [`表头 · ${ORDER_REPAIR_SHEET_NAME}`, 'pass'],
    [`必用列 · ${RECON_RESULT_SHEET_NAME}`, 'pass'],
    [`必用列 · ${BUSINESS_BILL_SHEET_NAME}`, 'pass'], [`场景引用 · ${BUSINESS_BILL_SHEET_NAME}`, 'pass'],
    [`必用列 · ${OPPONENT_BILL_SHEET_NAME}`, 'pass'], [`场景引用 · ${OPPONENT_BILL_SHEET_NAME}`, 'pass'],
    ['结构变化', 'warn'], ['与当前版本', 'info']
  ]);
  assert.deepEqual(prepared.diff, {
    added: [`「${BUSINESS_BILL_SHEET_NAME}」customerId`],
    removed: [`「${BUSINESS_BILL_SHEET_NAME}」clientId`]
  });
  assert.equal((await env.service.commitImport({ importToken: prepared.importToken, enable: true })).status, 'success');

  const current = await env.service.currentInputStructure(RESOURCE);
  assert.deepEqual([current.status, current.label], ['user', 'V2']);
  assert.deepEqual(current.sheets[BUSINESS_BILL_SHEET_NAME], RENAMED_BUSINESS);

  const businessRow = RENAMED_BUSINESS.map((header) => (header === 'customerId' ? 'C-1' : `${header}-1`));
  const dataFile = env.write('数据.xlsx', { business: RENAMED_BUSINESS, rows: { [BUSINESS_BILL_SHEET_NAME]: [businessRow] } });
  const read = readReconIdFixFile(dataFile, 'business', { structure: current });
  assert.equal(read.sheets.businessBills[0].customerId, 'C-1');
  assert.equal(read.sheets.businessBills[0].clientId, undefined);
  assert.deepEqual(read.sheets.fixTemplate.headers, [...ORDER_REPAIR_FIELDS], '输出列固定');

  // 内置结构读同一份文件：按原错误码报告，并给出与当前版本的差异与指引。
  assert.throws(() => readReconIdFixFile(dataFile, 'business'), (error) => {
    assert.equal(error.code, 'invalid-column-name');
    assert.ok(error.detailLines.includes('第 17 列（Q）：应为「clientId」，实际为「customerId」'), error.detailLines.join('\n'));
    assert.ok(error.detailLines.includes('如系统导出结构已变更，请在「设置 → 模板文件」导入新版本'));
    return true;
  });
});

test('缺少工作表、缺必用列或删除被 C4 场景引用的列时预检不通过', async (t) => {
  const env = setup(t, { scenarios: [c4Scenario('clientId', 'AccountId')] });
  const missingSheet = await prepare(env.service, env.write('缺表.xlsx', { omit: ORDER_REPAIR_SHEET_NAME }));
  assert.equal(missingSheet.verdict, 'fail');
  assert.match(missingSheet.checks.find((check) => check.label === 'Sheet 结构').detail, new RegExp(`缺少工作表 「${ORDER_REPAIR_SHEET_NAME}」`));

  const missingRequired = await prepare(env.service, env.write('缺必用列.xlsx', {
    opponent: OPPONENT_BILL_FIELDS.filter((header) => header !== 'createTime')
  }));
  assert.equal(missingRequired.verdict, 'fail');
  assert.match(missingRequired.checks.find((check) => check.label === `必用列 · ${OPPONENT_BILL_SHEET_NAME}`).detail, /缺少 createTime/);

  const referenced = await prepare(env.service, env.write('删引用列.xlsx', { business: RENAMED_BUSINESS }));
  assert.equal(referenced.verdict, 'fail');
  assert.match(referenced.checks.find((check) => check.label === `场景引用 · ${BUSINESS_BILL_SHEET_NAME}`).detail, /已被场景使用：clientId/);
});

test('启用已保存的版本前复核场景引用：之后新增的 C4 场景引用了被删除的列时不能启用', async (t) => {
  const env = setup(t);
  const prepared = await prepare(env.service, env.write('新结构.xlsx', { business: RENAMED_BUSINESS }));
  assert.equal((await env.service.commitImport({ importToken: prepared.importToken, enable: false })).status, 'success');
  env.store.scenarios.push(c4Scenario('clientId', 'OrderId'));
  const enabled = await env.service.setCurrentVersion({ resourceId: RESOURCE, versionId: 'v2' });
  assert.equal(enabled.status, 'failed');
  assert.match(enabled.message, /V2 不能启用：缺少已被场景使用的取值 「业务部门账单」clientId/);
});

test('表头首尾空格导入时不 trim：与快照不一致，预检按导入读取口径拒绝', async (t) => {
  const env = setup(t);
  const padded = BUSINESS_BILL_FIELDS.map((header) => (header === 'Bank' ? 'Bank ' : header));
  const prepared = await prepare(env.service, env.write('空格.xlsx', { business: padded }));
  assert.equal(prepared.verdict, 'fail');
  assert.match(prepared.checks.find((check) => check.label === '表头读取').detail, /「业务部门账单」第 2 列「Bank」导入时读作「Bank 」/);
});

test('必用列都在内置表头中', () => {
  for (const headers of [BUSINESS_BILL_FIELDS, OPPONENT_BILL_FIELDS]) {
    assert.deepEqual(RECON_ID_FIX_BILL_REQUIRED_FIELDS.filter((header) => !headers.includes(header)), []);
  }
});

test('「订单修复」输出按名复制的列（除程序填写的 Type / Reference / SubBizType）都是账单必用列', () => {
  const copied = ORDER_REPAIR_FIELDS.filter((header) => !['Type', 'Reference', 'SubBizType'].includes(header));
  assert.equal(copied.length, 12);
  assert.deepEqual(copied.filter((header) => !RECON_ID_FIX_BILL_REQUIRED_FIELDS.includes(header)), []);
});
