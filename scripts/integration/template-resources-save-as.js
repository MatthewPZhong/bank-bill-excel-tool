// 设置 · 模板文件「另存为」集成验证（真实随包模板与临时目录）
//   覆盖：.xlsx / .xls 原样写出、覆盖用户已确认的目标、拒绝写回内置文件、
//         相对路径与未知资源/版本不落盘、写入失败返回结果而不抛错。
//
// 另存为由 Main 弹出保存框后调用 service.exportVersion；本脚本直接给定目标路径，验证写出的文件契约。
// 用法：node scripts/integration/template-resources-save-as.js

'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createTemplateResourceService } = require('../../src/main-process/template-resources/service');

const ROOT = path.resolve(__dirname, '..', '..');
const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const sourceBytes = (relativePath) => fs.readFileSync(path.join(ROOT, ...relativePath.split('/')));

async function run() {
  console.log('==== 模板文件另存为 集成验证 ====');
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'template-resources-save-as-'));
  const service = createTemplateResourceService({ appRoot: ROOT, appVersion: 'integration' });
  const cases = [
    ['.xlsx 当前版本按原字节写出，返回实际文件名', async () => {
      const target = path.join(temporary, '资金对账导出不平-副本.xlsx');
      const result = await service.exportVersion({ resourceId: 'prefund-unbalanced', versionId: 'v1', targetPath: target });
      assert.deepEqual(result, { status: 'success', filePath: target, fileName: '资金对账导出不平-副本.xlsx' });
      assert.equal(sha256(fs.readFileSync(target)), sha256(sourceBytes('assets/资金对账导出不平.xlsx')));
    }],
    ['.xls 与子目录模板同样原样写出；缺省版本即当前版本', async () => {
      const xls = path.join(temporary, '中台退款订单.xls');
      assert.equal((await service.exportVersion({ resourceId: 'refund-order', targetPath: xls })).status, 'success');
      assert.equal(sha256(fs.readFileSync(xls)), sha256(sourceBytes('assets/中台退款订单.xls')));
      const nested = path.join(temporary, 'VCC财务OP校验结果表_模板.xlsx');
      assert.equal((await service.exportVersion({ resourceId: 'vcc-result-template', targetPath: nested })).status, 'success');
      assert.equal(sha256(fs.readFileSync(nested)), sha256(sourceBytes('assets/VCC财务OP校验/VCC财务OP校验结果表_模板.xlsx')));
    }],
    ['保存框已确认覆盖时替换原有目标文件', async () => {
      const target = path.join(temporary, '已存在.xlsx');
      fs.writeFileSync(target, 'old content');
      assert.equal((await service.exportVersion({ resourceId: 'dup-recall-mail', targetPath: target })).status, 'success');
      assert.equal(sha256(fs.readFileSync(target)), sha256(sourceBytes('assets/重复入金召回邮件模板.xlsx')));
    }],
    ['选择内置文件本身作为目标时拒绝写入，内置文件不变', async () => {
      const source = path.join(ROOT, 'assets', 'FundType枚举值.xlsx');
      const before = sha256(fs.readFileSync(source));
      const result = await service.exportVersion({ resourceId: 'fund-type-enum', targetPath: source });
      assert.deepEqual(result, { status: 'failed', message: '不能覆盖内置模板' });
      assert.equal(sha256(fs.readFileSync(source)), before);
    }],
    ['相对路径、未知资源与未知版本不落盘', async () => {
      const before = fs.readdirSync(temporary).length;
      assert.deepEqual(await service.exportVersion({ resourceId: 'pending', targetPath: 'Pending.xlsx' }), { status: 'failed', message: '保存位置无效' });
      assert.deepEqual(await service.exportVersion({ resourceId: 'missing', targetPath: path.join(temporary, 'a.xlsx') }), { status: 'failed', message: '模板不存在' });
      assert.deepEqual(await service.exportVersion({ resourceId: 'pending', versionId: 'v9', targetPath: path.join(temporary, 'b.xlsx') }), { status: 'failed', message: '版本不存在' });
      assert.equal(fs.readdirSync(temporary).length, before);
    }],
    ['目标目录不存在时返回失败结果而不抛错', async () => {
      const result = await service.exportVersion({ resourceId: 'pending', targetPath: path.join(temporary, 'missing-dir', 'Pending.xlsx') });
      assert.equal(result.status, 'failed');
      assert.match(result.message, /^保存失败：/);
    }]
  ];

  let passed = 0;
  const failures = [];
  try {
    for (const [label, work] of cases) {
      try {
        await work();
        passed += 1;
        console.log(`PASS ${label}`);
      } catch (error) {
        failures.push({ label, error });
        console.error(`FAIL ${label}: ${error.stack || error}`);
      }
    }
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
  console.log(`\n==== ${passed}/${cases.length} PASS ====`);
  if (failures.length) {
    console.error('FAILURES:');
    failures.forEach((failure) => console.error(`  - ${failure.label}: ${failure.error.message}`));
    process.exit(1);
  }
}

run().catch((error) => { console.error(error); process.exit(1); });
