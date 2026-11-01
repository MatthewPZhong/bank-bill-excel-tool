'use strict';

// 设置 → 模板文件：银行账单处理 4 张链接表的导入识别结构（网关对账单、中台调拨订单、中台退款订单、外汇交割表）。
//   入库按内置列名：场景按入库后的列名引用；与平盘「中台调拨订单表」各自独立版本。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const XLSX = require('xlsx');

const { createTemplateResourceService } = require('../../../src/main-process/template-resources/service');
const { INPUT_STRUCTURES } = require('../../../src/main-process/template-resources/input-structures');
const { createTemplateResourceStore } = require('../../helpers/template-resource-store');

const ROOT = path.join(__dirname, '..', '..', '..');
const builtin = (resourceId) => INPUT_STRUCTURES[resourceId].sheets[0].builtinHeaders();
// 与预置「与网关对账单根据金额币种一对一匹配对账ID」场景相同：引用了网关表头中不存在的 Amount、MerchantId 等（大小写不符）。
const PRESET_C3 = { id: 3, category: 'gateway-recon-join', config: {
  reconFields: [{ seq: 1, gwField: 'currency', bankField: 'Currency' }, { seq: 2, gwField: 'Amount', bankField: '发生额绝对值' }],
  conditions: [{ side: '网关', field: 'Reference' }],
  assign: { gwField: 'reconciliationId', bankField: 'ReconciliationId', mode: 'direct' }
} };

function setup(t, { scenarios = [] } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'template-linked-tables-'));
  const store = createTemplateResourceStore({ scenarios });
  const service = createTemplateResourceService({ appRoot: ROOT, appVersion: '9.9.9', userDataRoot: path.join(root, 'userData'), store });
  t.after(() => {
    try { store.close(); } catch (_error) { /* 已关闭 */ }
    fs.rmSync(root, { recursive: true, force: true });
  });
  return {
    service,
    write(name, aoa) {
      const workbook = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(aoa), 'Sheet1');
      const filePath = path.join(root, name);
      XLSX.writeFile(workbook, filePath);
      return filePath;
    }
  };
}

async function prepare(service, resourceId, filePath) {
  service.rememberPickedFile(filePath);
  const prepared = await service.prepareImport({ resourceId, filePath });
  assert.equal(prepared.status, 'success', prepared.message);
  return prepared;
}
const check = (prepared, label) => prepared.checks.find((item) => item.label === label);

test('网关对账单：场景引用当前版本本来没有的列时不拦下；被引用的非必用列按位置改名后入库名不变，场景照常可用', async (t) => {
  const env = setup(t, { scenarios: [PRESET_C3] });
  const renamed = builtin('gateway-recon').map((header) => (header === 'Reference' ? '参考号' : header));
  const prepared = await prepare(env.service, 'gateway-recon', env.write('网关-改名.xlsx', [renamed]));
  assert.equal(prepared.verdict, 'warn', JSON.stringify(prepared.checks));
  assert.deepEqual([check(prepared, '场景引用').status, check(prepared, '场景引用').detail], ['pass', '不影响已有场景']);
  assert.match(check(prepared, '列对应').detail, /按位置视为改名：第 10 列「参考号」→「Reference」/);
  assert.deepEqual(prepared.diff, { added: [], removed: [] }, '下拉取值为入库后的列名，改名不改变取值');

  const removed = await prepare(env.service, 'gateway-recon', env.write('网关-删列.xlsx', [builtin('gateway-recon').filter((header) => header !== 'Reference')]));
  assert.equal(removed.verdict, 'fail');
  assert.equal(check(removed, '场景引用').detail, '已被场景使用：Reference', '只拦下当前可用、新版本不可用的被引用列');
});

test('中台调拨订单与平盘「中台调拨订单表」各自独立版本，详情互相标注同一系统导出', async (t) => {
  const env = setup(t);
  const headers = [...builtin('transfer-order'), '新增列'];
  const prepared = await prepare(env.service, 'transfer-order', env.write('调拨-新结构.xlsx', [headers]));
  assert.equal(check(prepared, '列对应').detail, '入库与导出仍按内置列：不导入：新增列');
  assert.equal((await env.service.commitImport({ importToken: prepared.importToken, enable: true })).status, 'success');
  assert.deepEqual((await env.service.currentInputStructure('transfer-order')).headers, headers);
  assert.equal((await env.service.currentInputStructure('position-transfer-orders')).status, 'builtin');
  for (const [id, twin] of [['transfer-order', 'position-transfer-orders'], ['position-transfer-orders', 'transfer-order']]) {
    const { resource } = await env.service.get(id);
    assert.deepEqual([resource.twin, resource.twinNote], [twin, '版本各自独立，需分别导入']);
  }
});

test('外汇交割表：表头在第 2 行，内置结构的中间空列允许保留；其余链接表的空列表头不通过', async (t) => {
  const env = setup(t);
  const fx = builtin('fx-delivery').map((header) => (header === '操作员' ? '经办人' : header));
  const prepared = await prepare(env.service, 'fx-delivery', env.write('交割-新结构.xlsx', [['即期结售汇交易明细'], fx]));
  assert.equal(prepared.verdict, 'warn', JSON.stringify(prepared.checks));
  assert.deepEqual([check(prepared, '表头').status, check(prepared, '必用列').status], ['pass', 'pass']);
  assert.equal(check(prepared, '表头读取'), undefined, '导入读取口径与模板表头一致');
  assert.match(check(prepared, '列对应').detail, /按位置视为改名：第 29 列「经办人」→「操作员」/);
  assert.equal((await env.service.commitImport({ importToken: prepared.importToken, enable: true })).status, 'success');
  assert.deepEqual((await env.service.currentInputStructure('fx-delivery')).headers, fx);

  const gateway = builtin('gateway-recon');
  const blank = await prepare(env.service, 'gateway-recon', env.write('网关-空列.xlsx', [[...gateway.slice(0, 5), '', ...gateway.slice(5)]]));
  assert.deepEqual([check(blank, '表头').status, check(blank, '表头').detail], ['fail', '第 6 列表头为空']);
});

test('中台退款订单：退款回填按列名读取的列（含状态）缺少时不通过', async (t) => {
  const env = setup(t);
  const prepared = await prepare(env.service, 'refund-order', env.write('退款-缺列.xlsx', [builtin('refund-order').filter((header) => header !== '状态')]));
  assert.equal(prepared.verdict, 'fail');
  assert.equal(check(prepared, '必用列').detail, '缺少 状态（程序按列名读取，区分大小写）');
});

test('表头含布尔值：两种导入读法（流式 / SheetJS）读出的列名不同，预检不通过并标出两种结果', async (t) => {
  const env = setup(t);
  const prepared = await prepare(env.service, 'transfer-order', env.write('调拨-布尔表头.xlsx', [[...builtin('transfer-order'), true]]));
  assert.equal(prepared.verdict, 'fail');
  assert.match(check(prepared, '表头读取').detail, /^第 27 列「true」导入时读作「true \/ TRUE」：表头含富文本、数字、布尔/);
});
