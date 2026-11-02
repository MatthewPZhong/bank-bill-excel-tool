'use strict';

// v3.2.14：设置 → 模板文件「流水对账单」导入识别结构。模板预检（必用列、两种读法一致）、当前结构解析，
//   以及 VCC OP 发生额计算按当前结构流式读取并对应回内置 28 列。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const XLSX = require('xlsx');

const { createTemplateResourceService } = require('../../../src/main-process/template-resources/service');
const { resolveFlowStatementStructure } = require('../../../src/main-process/flow-statement-structure');
const { streamFlowFile } = require('../../../src/backend/vcc-op-calc-import/reader');
const { FLOW_HEADERS, FLOW_DB_COLUMNS } = require('../../../src/backend/vcc-op-calc-db/columns');
const { FLOW_REQUIRED_HEADERS } = require('../../../src/backend/biz-op-recon-db/columns');
const { FLOW_COLUMNS } = require('../../../src/main-process/biz-op-v327/import-adapter');
const { createTemplateResourceStore } = require('../../helpers/template-resource-store');

const ROOT = path.join(__dirname, '..', '..', '..');
const FLOW_V2 = [...FLOW_HEADERS.filter((header) => header !== '操作人').map((header) => (header === '拆分类型' ? '拆分方式' : header)), '新增列'];

function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-statement-structure-'));
  const store = createTemplateResourceStore();
  const userData = path.join(root, 'userData');
  const service = createTemplateResourceService({ appRoot: ROOT, appVersion: '9.9.9', userDataRoot: userData, store });
  t.after(() => {
    try { store.close(); } catch (_error) { /* 已关闭 */ }
    fs.rmSync(root, { recursive: true, force: true });
  });
  return {
    service,
    userData,
    write(name, rows) {
      const workbook = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(rows), 'Sheet1');
      const filePath = path.join(root, name);
      XLSX.writeFile(workbook, filePath);
      return filePath;
    }
  };
}

async function prepare(service, filePath) {
  service.rememberPickedFile(filePath);
  const prepared = await service.prepareImport({ resourceId: 'flow-statement', filePath });
  assert.equal(prepared.status, 'success', prepared.message);
  return prepared;
}
const check = (prepared, label) => prepared.checks.find((item) => item.label === label);

test('必用列覆盖业务 OP 新版的投影列与 VCC OP 发生额计算读取的列', () => {
  const projected = { bill_date: '账单日期', bu_dept: '业务部门', company_entity: '公司主体', account_no: '账户编号',
    account_type: '账户类型', currency: '币种', direction: '出入方向', recon_amount: '对账金额', flow_no: '流水单号' };
  assert.deepEqual([...FLOW_COLUMNS].map((column) => projected[column]).sort(), [...FLOW_REQUIRED_HEADERS].sort());
  for (const column of ['direction', 'recon_amount', 'bill_date_raw', 'currency']) {
    assert.ok(FLOW_REQUIRED_HEADERS.includes(FLOW_HEADERS[FLOW_DB_COLUMNS.indexOf(column)]), column);
  }
});

test('改名、删列、新增列：预检展示列对应，启用后解析为当前结构；版本文件被改动时中止并指向设置', async (t) => {
  const env = setup(t);
  assert.equal(await resolveFlowStatementStructure(env.service), null);
  const prepared = await prepare(env.service, env.write('流水-新结构.xlsx', [FLOW_V2]));
  assert.equal(prepared.verdict, 'warn', JSON.stringify(prepared.checks));
  assert.match(check(prepared, '列对应').detail, /按位置视为改名：第 13 列「拆分方式」→「拆分类型」/);
  assert.match(check(prepared, '列对应').detail, /导入后为空：操作人/);
  assert.equal(check(prepared, '表头读取'), undefined, '业务 OP 与 VCC OP 计算的读法与模板一致');
  assert.equal((await env.service.commitImport({ importToken: prepared.importToken, enable: true })).status, 'success');
  assert.deepEqual(await resolveFlowStatementStructure(env.service), { headers: FLOW_V2, versionLabel: 'V2' });

  const versionFile = path.join(env.userData, 'template-resources', 'flow-statement', 'v2.xlsx');
  const bytes = fs.readFileSync(versionFile);
  bytes[bytes.length - 1] ^= 0xff;
  fs.writeFileSync(versionFile, bytes);
  await assert.rejects(resolveFlowStatementStructure(env.service), (error) => {
    assert.equal(error.code, 'FLOW_STATEMENT_STRUCTURE_UNAVAILABLE');
    assert.match(error.message, /当前版本 V2 不可用：版本文件已被修改（SHA-256 不一致）/);
    return true;
  });
});

test('必用列缺少、表头含布尔值（两种读法不一致）时预检不通过', async (t) => {
  const env = setup(t);
  const missing = await prepare(env.service, env.write('流水-缺列.xlsx', [FLOW_HEADERS.filter((header) => header !== '账户类型')]));
  assert.equal(check(missing, '必用列').detail, '缺少 账户类型（程序按列名读取，区分大小写）');
  const boolean = await prepare(env.service, env.write('流水-布尔表头.xlsx', [[...FLOW_HEADERS, true]]));
  assert.equal(boolean.verdict, 'fail');
  assert.match(check(boolean, '表头读取').detail, /^第 29 列「true」导入时读作「true \/ TRUE」/);
});

test('VCC OP 发生额计算按当前结构读取：行对应回内置 28 列；内置结构的文件被拒并附模板指引', async (t) => {
  const env = setup(t);
  const values = Object.fromEntries(FLOW_V2.map((header) => [header, `${header}-值`]));
  const file = env.write('流水-V2导出.xlsx', [FLOW_V2, FLOW_V2.map((header) => values[header])]);
  const rows = [];
  const result = await streamFlowFile(file, { sourceHeaders: FLOW_V2, onDataRow: (row) => rows.push(row) });
  assert.equal(result.dataRows, 1);
  assert.deepEqual(Object.keys(rows[0]).filter((key) => key !== '_rowIndex'), [...FLOW_DB_COLUMNS]);
  assert.equal(rows[0].split_type, '拆分方式-值');
  assert.equal(rows[0].operator, '');
  assert.equal(rows[0].sys_created_at, '系统创建时间-值', '删除列之后左移的列按列名对应');

  const builtin = env.write('流水-内置.xlsx', [FLOW_HEADERS, FLOW_HEADERS.map(() => 'x')]);
  await assert.rejects(streamFlowFile(builtin, { sourceHeaders: FLOW_V2 }), (error) => {
    assert.match(error.message, /未找到流水数据表（所有 sheet 表头均与模板（当前版本） 28 列不匹配）/);
    assert.ok(error.detailLines.includes('如系统导出结构已变更，请在「设置 → 模板文件」导入新版本'));
    return true;
  });
  const builtinRows = [];
  await streamFlowFile(builtin, { onDataRow: (row) => builtinRows.push(row) });
  assert.equal(builtinRows[0].operator, 'x', '内置结构时读取不变');
});
