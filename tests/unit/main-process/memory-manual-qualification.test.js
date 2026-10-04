'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { qualifiedProfile } = require('../../../src/main-process/execution-descriptors/memory-evidence');
const { profile, PHASES } = require('../../../src/main-process/execution-descriptors/memory-profiles');
const { loadProductionMemoryProfiles } = require('../../helpers/production-memory-policy');
const runtime = { platform: 'win32', arch: 'x64', versions: { electron: '36.9.5' } };
const identity = { platform: runtime.platform, arch: runtime.arch, electronVersion: runtime.versions.electron };
function manual() {
  return { schemaVersion: 2, status: 'qualified', platform: 'win32', arch: 'x64',
    approval: { kind: 'manual-acceptance', result: 'PASS', reference: 'manual-v3.2.11-2026-10-02',
      releaseVersion: '3.2.11', confirmedAt: '2026-10-02' },
    profiles: Object.keys(PHASES).flatMap((phase) => ['normal', 'low'].map((mode) => {
      const config = profile(phase, mode); return { profileId: config.profileId, policyDigest: config.policyDigest };
    })) };
}
test('人工验收批准当前阶段配置，不要求构建、运行时精确版本和压力报告摘要', () => {
  const manifest = manual();
  for (const phase of Object.keys(PHASES)) for (const mode of ['normal', 'low']) {
    assert.equal(qualifiedProfile(manifest, profile(phase, mode), identity), manifest.approval.reference);
    assert.equal(qualifiedProfile(manifest, profile(phase, mode), { ...identity, appVersion: '3.2.11',
      nodeVersion: '22.19.0', electronVersion: '36.9.6', sourceTreeSha256: 'changed', dependencyLockSha256: 'changed' }),
    manifest.approval.reference);
  }
});
test('缺失或未通过的人工确认、待定状态、配置变化和重复配置均保留兼容路径', () => {
  for (const change of [
    (m) => { m.status = 'pending'; }, (m) => { delete m.approval; },
    (m) => { m.approval.result = 'FAIL'; }, (m) => { m.approval.kind = 'runtime-option'; },
    (m) => { m.approval.reference = ''; }, (m) => { m.approval.reference = '非法标识'; },
    (m) => { m.approval.confirmedAt = ''; }, (m) => { m.approval.releaseVersion = ''; },
    (m) => { m.profiles = []; }, (m) => { m.profiles[0].policyDigest = '0'.repeat(64); },
    (m) => { m.profiles.push(m.profiles[0]); }, (m) => { m.profiles[0] = null; }
  ]) {
    const manifest = manual(); change(manifest);
    assert.equal(qualifiedProfile(manifest, profile('split-prepare', 'normal'), identity), null);
  }
});
test('人工确认沿用 Windows x64 Electron 范围，不自动扩大到其他平台和裸 Node', () => {
  for (const wrong of [{ platform: 'darwin' }, { platform: 'linux' }, { arch: 'arm64' }, { electronVersion: null }]) {
    assert.equal(qualifiedProfile(manual(), profile('split-prepare', 'low'), { ...identity, ...wrong }), null);
  }
  const altered = manual(); altered.platform = 'darwin';
  assert.equal(qualifiedProfile(altered, profile('split-prepare', 'low'), { ...identity, platform: 'darwin' }), null);
});
test('生产工厂按人工确认注册候选，源码身份读取故障不再阻断这条启用路径', () => {
  const manifest = manual(); let reads = 0;
  const { createProductionMemoryPolicy } = loadProductionMemoryProfiles({ qualification: manifest, runtime,
    sourceIdentity() { reads++; throw new Error('不应读取构建身份'); } });
  const policy = createProductionMemoryPolicy({ compatibilityMemoryBytes: 0, getGovernor: () => null });
  const prepared = policy.prepare({ kind: 'phase', actionKey: 'toolbox:split:prepare', ownerKey: 'toolbox-split-read' },
    { cpuSlots: 1, workerThreadSlots: 1, utilityProcessSlots: 0, ioHeavySlots: 1, memoryBytes: 0 });
  assert.equal(prepared.scope.migrated, true);
  assert.deepEqual(prepared.candidates.map((c) => c.mode), ['normal', 'low']);
  for (const candidate of prepared.candidates) {
    assert.equal(candidate.config.validatedEvidenceId, manifest.approval.reference);
    assert.doesNotThrow(() => policy.assertEvidence(candidate));
  }
  assert.equal(reads, 0);
});
