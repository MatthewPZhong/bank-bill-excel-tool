'use strict';

// 设置 → 模板文件：VCC 财务OP 5 张原表的导入识别结构。必用列须同名保留；与旧 48 列 Pending 模板相同的结构不能导入；
//   预检时按导入的几种读法核对表头；选文件预检按当前版本解析结构，版本不可用时中止并指向设置。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const XLSX = require('xlsx');

const { createTemplateResourceService } = require('../../../src/main-process/template-resources/service');
const { resolveVccSourceStructures } = require('../../../src/main-process/vcc-financial-op-source-structures');
const {
  PENDING_V1_HEADERS, REQUIRED_HEADERS, SOURCE_TYPES: T, SYSTEM_OP_HEADERS, getSourceDefinition
} = require('../../../src/backend/vcc-financial-op/definitions');
const { createTemplateResourceStore } = require('../../helpers/template-resource-store');

const ROOT = path.join(__dirname, '..', '..', '..');
const RECHARGE = getSourceDefinition(T.RECHARGE).headers;

function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'template-vcc-sources-'));
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
    write(name, headers) {
      const workbook = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([headers]), 'Sheet1');
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

test('必用列覆盖键 / 账期 / 主体与映射按名读取的列，且都在内置结构中', () => {
  for (const [sourceType, required] of Object.entries(REQUIRED_HEADERS)) {
    const headers = sourceType === T.SYSTEM_OP ? SYSTEM_OP_HEADERS : getSourceDefinition(sourceType).headers;
    for (const header of required) assert.ok(headers.includes(header), `${sourceType}：${header}`);
    const definition = getSourceDefinition(sourceType);
    if (definition) {
      for (const key of ['keyHeader', 'monthHeader', 'subjectHeader']) {
        if (definition[key]) assert.ok(required.includes(definition[key]), `${sourceType}：${key}`);
      }
    }
  }
});

test('充值清退改名、删列、新增列：预检展示列对应，启用后选文件预检按当前版本解析结构', async (t) => {
  const env = setup(t);
  assert.equal(await resolveVccSourceStructures(env.service), null, '都为内置时不传结构');
  const headers = [...RECHARGE.filter((header) => header !== 'fee').map((header) => (header === '场景' ? '业务场景' : header)), '新增列'];
  const prepared = await prepare(env.service, 'vcc-recharge-refund', env.write('充值-新结构.xlsx', headers));
  assert.equal(prepared.verdict, 'warn', JSON.stringify(prepared.checks));
  assert.match(check(prepared, '列对应').detail, /按位置视为改名：第 11 列「业务场景」→「场景」/);
  assert.match(check(prepared, '列对应').detail, /导入后为空：fee/);
  assert.equal(check(prepared, '表头读取'), undefined, '导入预检与明细流式读取读出的表头与模板一致');
  assert.equal((await env.service.commitImport({ importToken: prepared.importToken, enable: true })).status, 'success');
  assert.deepEqual(await resolveVccSourceStructures(env.service), { [T.RECHARGE]: { headers, versionLabel: 'V2' } });

  const versionFile = path.join(env.userData, 'template-resources', 'vcc-recharge-refund', 'v2.xlsx');
  const bytes = fs.readFileSync(versionFile);
  bytes[bytes.length - 1] ^= 0xff;
  fs.writeFileSync(versionFile, bytes);
  await assert.rejects(resolveVccSourceStructures(env.service), (error) => {
    assert.equal(error.code, 'vcc-source-structure-unavailable');
    assert.match(error.message, /当前版本 V2 不可用：版本文件已被修改（SHA-256 不一致）。请在 设置 → 模板文件 恢复默认或重新导入/);
    return true;
  });
});

test('必用列缺少、与旧 48 列 Pending 模板相同、表头含布尔值时预检不通过', async (t) => {
  const env = setup(t);
  const missing = await prepare(env.service, 'vcc-channel', env.write('通道-缺列.xlsx',
    getSourceDefinition(T.CHANNEL).headers.filter((header) => header !== '实际到账金额')));
  assert.equal(check(missing, '必用列').detail, '缺少 实际到账金额（程序按列名读取，区分大小写）');

  const legacy = await prepare(env.service, 'vcc-removed-pending', env.write('Pending-旧48列.xlsx', PENDING_V1_HEADERS));
  assert.equal(legacy.verdict, 'fail');
  assert.equal(check(legacy, '识别冲突').detail, '与「旧 48 列 VCC Pending 模板」当前结构相同，导入时无法区分');

  // 明细：导入预检（富工作簿）读作 true，明细流式读取读作 1，启用后会在读取时判为表头变化。
  const boolean = await prepare(env.service, 'vcc-recharge-refund', env.write('充值-布尔表头.xlsx', [...RECHARGE, true]));
  assert.equal(boolean.verdict, 'fail');
  assert.match(check(boolean, '表头读取').detail, /^第 50 列「true」导入时读作「true \/ 1」/);
  // 系统财务OP 的几种读法（预检、显示值、审阅原值）都读作 true，与模板一致，不拦。
  const systemBoolean = await prepare(env.service, 'vcc-system-op', env.write('系统-布尔表头.xlsx', [...SYSTEM_OP_HEADERS, true]));
  assert.equal(check(systemBoolean, '表头读取'), undefined);
});

test('VCC_移除归档Pending账单与 Pending 对账「移除归档Pending账单」互相标注同一系统导出', async (t) => {
  const env = setup(t);
  for (const [id, twin] of [['vcc-removed-pending', 'removed-pending'], ['removed-pending', 'vcc-removed-pending']]) {
    const { resource } = await env.service.get(id);
    assert.deepEqual([resource.twin, resource.twinNote], [twin, '版本各自独立，需分别导入']);
  }
});
