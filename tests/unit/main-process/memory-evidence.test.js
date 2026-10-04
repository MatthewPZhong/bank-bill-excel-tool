'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { sourceIdentity, qualifiedProfile } = require('../../../src/main-process/execution-descriptors/memory-evidence');
const { profile } = require('../../../src/main-process/execution-descriptors/memory-profiles');
const { checkExecutionMemory, sqliteCacheKiB } = require('../../../src/main-process/background-execution/execution-memory-options');
const sha = (n) => n.toString(16).padStart(64, '0');
function evidence(mode = 'low') {
  const config = profile('split-prepare', mode);
  const identity = { sourceTreeSha256: sha(1), dependencyLockSha256: sha(2), appVersion: '3.2.11',
    platform: 'win32', arch: 'x64', nodeVersion: '22.14.0', electronVersion: '36.9.5' };
  const manifest = { schemaVersion: 1, status: 'qualified', inventoryComplete: true, ...identity,
    artifactSha256: sha(3), profiles: [{ profileId: config.profileId, policyDigest: config.policyDigest,
      result: 'PASS', evidenceId: 'windows-complete-v1', syntheticOnly: false,
      runs: (mode === 'low' ? [512, 768] : ['normal']).flatMap((availableMiB, band) => [0, 1, 2].map((i) => ({
        availableMiB, result: 'PASS', realPressure: true, coveredFormats: ['xlsx', 'csv', 'xls'],
        sourceTreeSha256: identity.sourceTreeSha256, artifactSha256: sha(3), reportSha256: sha(10 + band * 3 + i)
      }))) }] };
  return { config, identity, manifest };
}
test('生产资格绑定最终源码、运行时、格式、档位和三次独立报告；注入数字不能启用', () => {
  for (const mode of ['normal', 'low']) {
    const good = evidence(mode);
    assert.equal(qualifiedProfile(good.manifest, good.config, good.identity), 'windows-complete-v1');
    for (const change of [
      (m) => { m.sourceTreeSha256 = sha(99); }, (m) => { m.dependencyLockSha256 = sha(99); },
      (m) => { m.nodeVersion = '0'; }, (m) => { m.electronVersion = '0'; },
      (m) => { m.inventoryComplete = false; }, (m) => { m.profiles[0].policyDigest = sha(99); },
      (m) => { m.profiles[0].syntheticOnly = true; },
      (m) => { m.profiles[0].runs[0].realPressure = false; },
      (m) => { m.profiles[0].runs[0].coveredFormats = ['xlsx']; },
      (m) => { m.profiles[0].runs[0].reportSha256 = m.profiles[0].runs[1].reportSha256; },
      (m) => { m.profiles[0].runs[0].artifactSha256 = sha(99); }
    ]) {
      const changed = structuredClone(good.manifest); change(changed);
      assert.equal(qualifiedProfile(changed, good.config, good.identity), null);
    }
    assert.equal(qualifiedProfile(good.manifest, good.config, { ...good.identity, platform: 'darwin' }), null);
    assert.equal(qualifiedProfile(good.manifest, good.config, { ...good.identity, electronVersion: null }), null);
  }
});
test('源码摘要支持打包后的 package 精简，任何源文件或依赖锁变化都会失效', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-identity-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'src')); fs.writeFileSync(path.join(root, 'src/a.js'), 'module.exports=1;');
  const pkg = { version: '3.2.11', dependencies: { z: '1', a: '2' }, scripts: { test: 'node test' }, build: {} };
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify(pkg));
  fs.writeFileSync(path.join(root, 'package-lock.json'), '{}');
  const first = sourceIdentity(root);
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version: pkg.version, dependencies: { a: '2', z: '1' } }));
  assert.deepEqual(sourceIdentity(root), first);
  fs.appendFileSync(path.join(root, 'src/a.js'), '\n');
  assert.notEqual(sourceIdentity(root).sourceTreeSha256, first.sourceTreeSha256);
  fs.writeFileSync(path.join(root, 'package-lock.json'), '{"lockfileVersion":3}');
  assert.notEqual(sourceIdentity(root).dependencyLockSha256, first.dependencyLockSha256);
});
test('运行安全点不重复累加 arrayBuffers；内存超限、系统压力与连接超限可区分', () => {
  const config = profile('bizop-compute', 'low');
  const memory = { heapUsed: config.phaseMemoryBytes - 16, external: 8, arrayBuffers: 8 };
  assert.equal(checkExecutionMemory(config, memory, 512 * 1024 ** 2), memory);
  assert.throws(() => checkExecutionMemory(config, { ...memory, external: 17 }), { code: 'EXECUTION_MEMORY_LIMIT_EXCEEDED' });
  assert.throws(() => checkExecutionMemory(config, memory, 1), { code: 'EXECUTION_SYSTEM_MEMORY_PRESSURE' });
  assert.equal(3 * sqliteCacheKiB(config, 3) * 1024, config.sqliteAggregateCacheBytes);
  assert.throws(() => sqliteCacheKiB(config, 4), { code: 'EXECUTION_SQLITE_CONNECTION_LIMIT' });
});
