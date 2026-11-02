'use strict';

// 设置 → 模板文件：「移除归档Pending账单」的导入识别结构。识别只认当前版本；入库前对应回内置 46 列，
// 存量数据、对账规则（只能引用 Pending 主表的列）与导出不受版本影响。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const XLSX = require('xlsx');

const { createTemplateResourceService } = require('../../../src/main-process/template-resources/service');
const {
  REMOVED_PENDING_COLUMNS,
  REMOVED_PENDING_REQUIRED_COLUMNS,
  readRemovedPendingFile
} = require('../../../src/backend/pending-import/removed-reader');
const PENDING_COLUMNS = Array.from(require('../../../src/backend/pending-db/columns'));
const { createTemplateResourceStore } = require('../../helpers/template-resource-store');

const ROOT = path.join(__dirname, '..', '..', '..');
const RESOURCE = 'removed-pending';
// 改名一列流水扩展字段，删除一列，末尾新增一列；前 28 列（必用列）不动。
const NEW_HEADERS = [
  ...REMOVED_PENDING_COLUMNS
    .filter((header) => header !== '维护人')
    .map((header) => (header === '流水_币种' ? '流水_币别' : header)),
  '新增备注'
];

function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'template-removed-pending-'));
  const store = createTemplateResourceStore();
  const service = createTemplateResourceService({
    appRoot: ROOT, appVersion: '9.9.9', userDataRoot: path.join(root, 'userData'), store
  });
  t.after(() => {
    try { store.close(); } catch (_error) { /* 已关闭 */ }
    fs.rmSync(root, { recursive: true, force: true });
  });
  return {
    service,
    write(name, headers, rows = []) {
      const workbook = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([headers, ...rows]), '1405800876820465666');
      const filePath = path.join(root, name);
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

test('必用列为与 Pending 主表共有的前 28 列，覆盖对账规则可引用、且移除文件中存在的全部列', () => {
  assert.equal(REMOVED_PENDING_REQUIRED_COLUMNS.length, 28);
  const referencable = PENDING_COLUMNS.filter((column) => REMOVED_PENDING_COLUMNS.includes(column));
  assert.deepEqual([...REMOVED_PENDING_REQUIRED_COLUMNS], referencable);
  for (const index of ['order_no', 'recon_id', '金额', 'channel', 'merchant_id', 'bank_ref']) {
    assert.ok(REMOVED_PENDING_REQUIRED_COLUMNS.includes(index), index);
  }
});

test('改名、删除、新增扩展列：预检展示对应关系；启用后读取按当前结构识别并对应回内置 46 列', async (t) => {
  const env = setup(t);
  const prepared = await prepare(env.service, env.write('新结构.xlsx', NEW_HEADERS));
  assert.equal(prepared.verdict, 'warn', JSON.stringify(prepared.checks));
  const mapping = prepared.checks.find((check) => check.label === '列对应');
  assert.equal(mapping.status, 'warn');
  assert.match(mapping.detail, /按位置视为改名：第 38 列「流水_币别」→「流水_币种」/);
  assert.match(mapping.detail, /导入后为空：维护人/);
  assert.match(mapping.detail, /不导入：新增备注/);
  assert.equal((await env.service.commitImport({ importToken: prepared.importToken, enable: true })).status, 'success');
  const structure = await env.service.currentInputStructure(RESOURCE);
  assert.deepEqual([structure.status, structure.label, structure.headers], ['user', 'V2', NEW_HEADERS]);

  const row = NEW_HEADERS.map((header) => `${header}-值`);
  const dataFile = env.write('数据.xlsx', NEW_HEADERS, [row]);
  const parsed = readRemovedPendingFile(dataFile, { structure });
  assert.equal(parsed.rows.length, 1);
  const raw = parsed.rows[0].raw;
  assert.deepEqual(Object.keys(raw), [...REMOVED_PENDING_COLUMNS], '入库键始终是内置 46 列');
  assert.equal(raw['流水_币种'], '流水_币别-值');
  assert.equal(raw['维护人'], '');
  assert.equal(raw['维护人BU'], '维护人BU-值');
  assert.equal(parsed.rows[0].order_no, 'order_no-值');
  assert.equal(parsed.rows[0].bank_ref, 'bank_ref-值');
  assert.deepEqual(parsed.headerRow, [...REMOVED_PENDING_COLUMNS]);

  // 内置结构读同一份文件：原错误码，附与当前结构的差异与指引。
  assert.throws(() => readRemovedPendingFile(dataFile), (error) => {
    assert.equal(error.code, 'PENDING_REMOVED_HEADER_MISMATCH');
    assert.ok(error.detailLines.includes('如系统导出结构已变更，请在「设置 → 模板文件」导入新版本'), error.detailLines.join('\n'));
    assert.ok(error.detailLines.includes('第 38 列（AL）：应为「流水_币种」，实际为「流水_币别」'));
    assert.ok(error.detailLines.includes('缺少列：流水_币种、维护人'));
    return true;
  });
});

test('必用列改名时预检不通过', async (t) => {
  const env = setup(t);
  const prepared = await prepare(env.service, env.write('改必用列.xlsx',
    REMOVED_PENDING_COLUMNS.map((header) => (header === 'channel' ? 'Channel' : header))));
  assert.equal(prepared.verdict, 'fail');
  assert.match(prepared.checks.find((check) => check.label === '必用列').detail, /缺少 channel/);
});
