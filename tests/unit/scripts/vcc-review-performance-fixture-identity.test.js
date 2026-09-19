'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { loadPreparedFixture, currentScriptSha256, verifyVerificationScripts, currentProductionIdentity,
  verifyProductionIdentity } = require('../../../scripts/vcc-financial-op/verify-review-performance');

const sha = (value) => createHash('sha256').update(value).digest('hex');
function setup(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vcc-pf-fixture-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const config = { directory, name: 'smoke', runId: 'fixed-run', buildSha: 'a'.repeat(40),
    buildIdentity: { scriptSha256: currentScriptSha256() } };
  const fixture = { directory, dbPath: path.join(directory, 'business.sqlite'),
    filePath: path.join(directory, '多工作表性能合成样本.xlsx') };
  fs.writeFileSync(fixture.dbPath, 'database'); fs.writeFileSync(fixture.filePath, 'workbook');
  const report = { schemaVersion: 2, case: config.name, runId: config.runId, buildSha: config.buildSha,
    automated: 'PASS', pid: process.pid + 100000, childExit: { code: 0, signal: null }, fixture,
    environment: { buildIdentity: config.buildIdentity }, fixtureSha256: sha(JSON.stringify(fixture)),
    files: [fixture.dbPath, `${fixture.dbPath}-wal`, `${fixture.dbPath}-shm`, fixture.filePath].map((file) => {
      if (!fs.existsSync(file)) return { path: file, exists: false };
      const bytes = fs.readFileSync(file);
      return { path: file, exists: true, bytes: bytes.length, sha256: sha(bytes) };
    }) };
  const save = () => fs.writeFileSync(path.join(directory, 'fixture-preparation.json'), JSON.stringify(report));
  save(); return { config, fixture, report, save };
}

test('独立准备结束后按真实文件摘要读取，不把DB或样本留在内存', async (t) => {
  const f = setup(t);
  const result = await loadPreparedFixture(f.config);
  assert.deepEqual(result.fixture, f.fixture);
  assert.equal(result.filesVerified, true);
  assert.equal(result.evidenceSha256, sha(fs.readFileSync(result.evidencePath)));
});
test('实际采集源码须匹配冻结身份，不能只比较两个复制的声明', () => {
  const actual = currentScriptSha256();
  const environment = { buildIdentity: { scriptSha256: { ...actual } }, observedScriptSha256: { ...actual } };
  verifyVerificationScripts(environment);
  assert.equal(environment.verificationScriptsUnchanged, true);
  const changed = { ...actual, 'performance-worker.js': 'e'.repeat(64) };
  assert.throws(() => verifyVerificationScripts({ buildIdentity: { scriptSha256: changed }, observedScriptSha256: changed }));
  assert.throws(() => verifyVerificationScripts({ buildIdentity: { scriptSha256: actual }, observedScriptSha256: changed }));
});
test('实际Git构建须匹配冻结身份，不能只复制旧HEAD或干净状态', () => {
  const actual = currentProductionIdentity();
  const config = { buildSha: actual.buildSha, buildIdentity: { productionDirty: false } };
  const environment = { observedProductionIdentity: actual };
  if (!actual.productionDirty) {
    verifyProductionIdentity(environment, config);
    assert.equal(environment.productionIdentityUnchanged, true);
  }
  assert.throws(() => verifyProductionIdentity(environment, { ...config, buildSha: '0'.repeat(40) }));
  assert.throws(() => verifyProductionIdentity({ observedProductionIdentity: { ...actual, productionDirty: true } }, config));
  assert.throws(() => verifyProductionIdentity(environment, { ...config, buildIdentity: { productionDirty: true } }));
});
for (const [name, mutate] of [
  ['同一进程', (f) => { f.report.pid = process.pid; }],
  ['准备进程失败', (f) => { f.report.childExit.code = 1; }],
  ['准备进程被信号结束', (f) => { f.report.childExit.signal = 'SIGTERM'; }],
  ['其他运行', (f) => { f.report.runId = 'other-run'; }],
  ['其他候选', (f) => { f.report.buildSha = 'c'.repeat(40); }],
  ['其他case', (f) => { f.report.case = 'pf01-1m'; }],
  ['采集脚本漂移', (f) => { f.report.environment.buildIdentity = { scriptSha256: { runner: 'c'.repeat(64) } }; }],
  ['两份声明相同但与实际脚本不符', (f) => { f.config.buildIdentity.scriptSha256['performance-worker.js'] = 'c'.repeat(64); }],
  ['元数据篡改', (f) => { f.report.fixture.extra = 'changed'; }],
  ['数据库被删', (f) => { fs.unlinkSync(f.fixture.dbPath); }],
  ['同大小文件替换', (f) => { fs.writeFileSync(f.fixture.filePath, 'altered!'); }],
  ['准备后新增WAL', (f) => { fs.writeFileSync(`${f.fixture.dbPath}-wal`, 'pending'); }],
  ['主库缺失被声明为正常', (f) => { fs.unlinkSync(f.fixture.dbPath); f.report.files[0] = { path: f.fixture.dbPath, exists: false }; }],
  ['路径逃出测试目录', (f) => { f.report.fixture.dbPath = path.join(f.config.directory, '..', 'business.sqlite'); f.report.fixtureSha256 = sha(JSON.stringify(f.report.fixture)); }],
  ['文件清单遗漏', (f) => { f.report.files.pop(); }]
]) {
  test(`测量前拒绝${name}`, async (t) => {
    const f = setup(t); mutate(f); f.save();
    await assert.rejects(loadPreparedFixture(f.config));
  });
}
