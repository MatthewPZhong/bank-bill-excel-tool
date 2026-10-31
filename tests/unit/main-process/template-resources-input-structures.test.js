'use strict';

// 设置 → 模板文件：输入原表（平盘链接原始表）的导入识别结构。导入预检、启用、恢复默认与当前结构读取，
// 使用真实随包模板、真实检查 Worker 与仓储；版本文件只写临时 userData。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const XLSX = require('xlsx');

const { createTemplateResourceService } = require('../../../src/main-process/template-resources/service');
const { INPUT_STRUCTURES } = require('../../../src/main-process/template-resources/input-structures');
const { TEMPLATE_RESOURCES } = require('../../../src/main-process/template-resources/catalog');
const {
  SOURCE_DEFINITIONS,
  SOURCE_REQUIRED_FIELDS,
  SOURCE_TYPES
} = require('../../../src/main-process/position-reconciliation/constants');
const { createTemplateResourceStore } = require('../../helpers/template-resource-store');

const ROOT = path.join(__dirname, '..', '..', '..');
const INBOUND = SOURCE_DEFINITIONS[SOURCE_TYPES.GATEWAY_INBOUND].headers;
const RENAMED = INBOUND.map((header) => (header === 'fieldId' ? 'fileId' : header));
const checksOf = (prepared, group = 'file') => prepared.checks.filter((check) => check.group === group)
  .map((check) => [check.label, check.status]);

function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'template-input-structures-'));
  const files = path.join(root, 'files');
  fs.mkdirSync(files, { recursive: true });
  const store = createTemplateResourceStore();
  const logs = [];
  const service = createTemplateResourceService({
    appRoot: ROOT,
    appVersion: '9.9.9',
    userDataRoot: path.join(root, 'userData'),
    store,
    log: (entry) => logs.push(entry)
  });
  t.after(() => {
    try { store.close(); } catch (_error) { /* 已关闭 */ }
    fs.rmSync(root, { recursive: true, force: true });
  });
  return {
    service,
    logs,
    versionFile: (resourceId, versionId) => path.join(root, 'userData', 'template-resources', resourceId, `${versionId}.xlsx`),
    write(name, sheets) {
      const workbook = XLSX.utils.book_new();
      for (const sheet of sheets) {
        XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([sheet.headers, ...(sheet.rows || [])]), sheet.name);
      }
      const filePath = path.join(files, name);
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

test('平盘 5 张链接原始表可替换：规格、必用列与内置表头一致', () => {
  const ids = Object.keys(INPUT_STRUCTURES).sort();
  assert.deepEqual(ids, [
    'position-bank-accounts', 'position-gateway-raw-in', 'position-gateway-raw-out',
    'position-payment-full', 'position-transfer-orders'
  ]);
  for (const id of ids) {
    const resource = TEMPLATE_RESOURCES.find((item) => item.id === id);
    assert.equal(resource.replace.allowed, true, id);
    assert.equal(resource.readMode, 'runtime', id);
    const spec = INPUT_STRUCTURES[id];
    assert.deepEqual(spec.builtinHeaders(), [...SOURCE_DEFINITIONS[spec.moduleKey].headers], id);
    assert.deepEqual(spec.required(), [...SOURCE_REQUIRED_FIELDS[spec.moduleKey]], id);
  }
});

test('readers / derivation / logical-accounts 按名读取的原始列都在必用列中（改名后不会静默变空）', () => {
  const required = new Set(Object.values(SOURCE_REQUIRED_FIELDS).flat());
  const read = new Set();
  for (const name of ['readers.js', 'derivation.js', 'logical-accounts.js']) {
    const source = fs.readFileSync(path.join(ROOT, 'src', 'main-process', 'position-reconciliation', name), 'utf8');
    for (const match of source.matchAll(/\brow\[['"]([^'"]+)['"]\]/g)) read.add(match[1]);
    for (const match of source.matchAll(/\brow\.([A-Za-z_]\w*)\b(?!\s*\()/g)) read.add(match[1]);
  }
  assert.ok(read.size > 30, `应读到全部按名读取的列，实际 ${read.size}`);
  assert.deepEqual([...read].filter((header) => !required.has(header)).sort(), []);
  for (const definition of Object.values(SOURCE_DEFINITIONS)) {
    for (const field of [definition.keyField, definition.dateField].filter(Boolean)) assert.ok(required.has(field), field);
  }
});

test('只改非必用列名：预检提示结构变化，启用后当前结构为新表头，恢复默认回到内置', async (t) => {
  const env = setup(t);
  const builtin = await env.service.currentInputStructure('position-gateway-raw-in');
  assert.deepEqual(builtin, { status: 'builtin', versionId: 'v1', label: 'V1', headers: [...INBOUND] });

  const file = env.write('网关原始入账订单-新结构.xlsx', [{ name: '账单明细', headers: RENAMED }]);
  const prepared = await prepare(env.service, 'position-gateway-raw-in', file);
  assert.equal(prepared.verdict, 'warn');
  assert.deepEqual(checksOf(prepared), [
    ['文件格式', 'pass'], ['Sheet 结构', 'pass'], ['表头', 'pass'], ['必用列', 'pass'],
    ['结构变化', 'warn'], ['与当前版本', 'info']
  ]);
  assert.match(prepared.checks.find((check) => check.label === '结构变化').detail, /增加 fileId；删除 fieldId/);
  assert.equal(prepared.checks.find((check) => check.label === '与当前版本').detail, '增加 1 列 · 删除 1 列');
  assert.deepEqual(checksOf(prepared, 'usage'), [['平盘对账数据处理', 'pass']]);
  assert.deepEqual(prepared.diff, { added: ['fileId'], removed: ['fieldId'] });

  const committed = await env.service.commitImport({ importToken: prepared.importToken, enable: true });
  assert.equal(committed.status, 'success', committed.message);
  const current = await env.service.currentInputStructure('position-gateway-raw-in');
  assert.deepEqual(current, { status: 'user', versionId: 'v2', label: 'V2', headers: RENAMED });
  assert.ok(env.logs.some((entry) => /使用用户版本 V2（导入识别结构）/.test(entry.message)));

  const restored = await env.service.setCurrentVersion({ resourceId: 'position-gateway-raw-in', versionId: 'v1' });
  assert.equal(restored.status, 'success');
  assert.equal((await env.service.currentInputStructure('position-gateway-raw-in')).status, 'builtin');
});

test('缺少必用列、空列或重复列名时预检不通过', async (t) => {
  const env = setup(t);
  const cases = [
    ['缺必用列.xlsx', INBOUND.filter((header) => header !== 'currency'), ['必用列', 'fail'], /缺少 currency/],
    ['空列.xlsx', [...INBOUND.slice(0, 3), '', ...INBOUND.slice(3)], ['表头', 'fail'], /第 4 列表头为空/],
    ['重复列.xlsx', [...INBOUND, 'bizId'], ['表头', 'fail'], /列名重复：bizId/]
  ];
  for (const [name, headers, expected, detail] of cases) {
    const prepared = await prepare(env.service, 'position-gateway-raw-in', env.write(name, [{ name: 'S', headers }]));
    assert.equal(prepared.verdict, 'fail', name);
    const check = prepared.checks.find((item) => item.label === expected[0] && item.status === expected[1]);
    assert.ok(check, `${name}：${JSON.stringify(prepared.checks)}`);
    assert.match(check.detail, detail, name);
  }
});

test('多工作表与表头下的数据行给出提示；只读取第 1 个工作表', async (t) => {
  const env = setup(t);
  const file = env.write('带数据.xlsx', [
    { name: '账单明细', headers: RENAMED, rows: [RENAMED.map(() => 'x')] },
    { name: '说明', headers: ['备注'] }
  ]);
  const prepared = await prepare(env.service, 'position-gateway-raw-in', file);
  assert.equal(prepared.verdict, 'warn');
  assert.equal(prepared.checks.find((check) => check.label === 'Sheet 结构').status, 'warn');
  assert.match(prepared.checks.find((check) => check.label === '数据行').detail, /表头以下有 1 行内容/);
});

test('同组来源表结构相同时：导入预检与启用都拒绝，避免导入时无法区分', async (t) => {
  const env = setup(t);
  const shared = [
    ...SOURCE_REQUIRED_FIELDS[SOURCE_TYPES.GATEWAY_INBOUND],
    ...SOURCE_REQUIRED_FIELDS[SOURCE_TYPES.GATEWAY_OUTBOUND]
  ];
  const file = env.write('共用结构.xlsx', [{ name: 'S', headers: shared }]);

  // 入账先保存（出账仍为内置，不冲突），出账再导入并启用同一结构。
  const inbound = await prepare(env.service, 'position-gateway-raw-in', file);
  assert.notEqual(inbound.verdict, 'fail', JSON.stringify(inbound.checks));
  assert.equal((await env.service.commitImport({ importToken: inbound.importToken, enable: false })).status, 'success');
  const outbound = await prepare(env.service, 'position-gateway-raw-out', file);
  assert.notEqual(outbound.verdict, 'fail', JSON.stringify(outbound.checks));
  assert.equal((await env.service.commitImport({ importToken: outbound.importToken, enable: true })).status, 'success');

  const again = await prepare(env.service, 'position-gateway-raw-in', env.write('共用结构-2.xlsx', [{ name: 'T', headers: shared }]));
  assert.equal(again.verdict, 'fail');
  assert.match(again.checks.find((check) => check.label === '识别冲突').detail, /与「中台网关原始出账订单」当前结构相同/);

  const enabled = await env.service.setCurrentVersion({ resourceId: 'position-gateway-raw-in', versionId: 'v2' });
  assert.equal(enabled.status, 'failed');
  assert.match(enabled.message, /V2 不能启用：与「中台网关原始出账订单」当前结构相同/);
});

test('当前用户版本文件被改动时当前结构不可用，并提示到设置处理', async (t) => {
  const env = setup(t);
  const prepared = await prepare(env.service, 'position-gateway-raw-in', env.write('新结构.xlsx', [{ name: 'S', headers: RENAMED }]));
  assert.equal((await env.service.commitImport({ importToken: prepared.importToken, enable: true })).status, 'success');
  const versionFile = env.versionFile('position-gateway-raw-in', 'v2');
  const bytes = fs.readFileSync(versionFile);
  bytes[bytes.length - 1] ^= 0xff;
  fs.writeFileSync(versionFile, bytes);

  const current = await env.service.currentInputStructure('position-gateway-raw-in');
  assert.equal(current.status, 'unavailable');
  assert.equal(current.label, 'V2');
  assert.match(current.message, /模板「中台网关原始入账订单」当前版本 V2 不可用：版本文件已被修改（SHA-256 不一致）。请在 设置 → 模板文件 恢复默认或重新导入/);
});
