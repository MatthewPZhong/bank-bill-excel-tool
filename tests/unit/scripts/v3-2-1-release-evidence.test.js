'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const {
  SNAPSHOT_PATH,
  validateReleaseEvidence
} = require('../../../scripts/validate-v3-2-1-release-evidence');

const REPOSITORY_ROOT = path.resolve(__dirname, '../../..');

function loadSnapshot() {
  return JSON.parse(fs.readFileSync(SNAPSHOT_PATH, 'utf8'));
}

function findAction(snapshot, actionKey) {
  return snapshot.actions.find((action) => action.actionKey === actionKey);
}

function errorPaths(result) {
  return result.errors.map((error) => error.path);
}

test('R3.2.1 release snapshot锁定7 action独立production与rollback证据', () => {
  const result = validateReleaseEvidence(loadSnapshot());
  assert.equal(result.valid, true, JSON.stringify(result.errors));
  assert.equal(result.actionCount, 7);
});

test('R3.2.1 release evidence CLI输出有界machine-readable摘要', () => {
  const result = spawnSync(
    process.execPath,
    ['scripts/validate-v3-2-1-release-evidence.js'],
    { cwd: REPOSITORY_ROOT, encoding: 'utf8' }
  );
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    status: 'PASS',
    release: '3.2.1',
    baseCommit: '4598b9c67787ef1736831a186a199bd6fe9ae626',
    actionCount: 7,
    nativeProductionEnabledCount: 0,
    inheritedProductionStateChanges: 0,
    releaseCheckStatus: 'FAIL',
    releaseCheckRerunAllowed: false
  });
});

test('唯一release-check失败不能被改写为PASS或把post-failure组件伪造为重跑', () => {
  const snapshot = loadSnapshot();
  snapshot.releaseCheckEvidence.status = 'PASS';
  snapshot.releaseCheckEvidence.phases.integration.status = 'PASS';
  snapshot.releaseCheckEvidence.rerunAllowed = true;
  snapshot.releaseCheckEvidence.postFixVerification.standaloneUnit.relationship =
    'RELEASE_CHECK_RERUN';
  snapshot.releaseCheckEvidence.postFixVerification.standaloneIntegration.relationship =
    'RELEASE_CHECK_RERUN';
  const result = validateReleaseEvidence(snapshot);
  assert.equal(result.valid, false);
  assert.ok(errorPaths(result).includes('/releaseCheckEvidence'));
});

test('native action不能由release snapshot误启用', () => {
  const snapshot = loadSnapshot();
  findAction(snapshot, 'pre-fund:mpt-import').currentPolicy.production.enabled = true;
  findAction(snapshot, 'pre-fund:mpt-import').decision.enabled = true;
  const result = validateReleaseEvidence(snapshot);
  assert.equal(result.valid, false);
  assert.ok(errorPaths(result).includes('/actions/5/currentPolicy'));
  assert.ok(errorPaths(result).includes('/actions/5/decision'));
});

test('inherited existing-dispatch action不能被本release snapshot误关', () => {
  const snapshot = loadSnapshot();
  findAction(snapshot, 'toolbox:publish').currentPolicy.production.enabled = false;
  findAction(snapshot, 'toolbox:publish').live.effectiveMode = 'legacy';
  findAction(snapshot, 'toolbox:publish').decision.enabled = false;
  const result = validateReleaseEvidence(snapshot);
  assert.equal(result.valid, false);
  assert.ok(errorPaths(result).includes('/actions/4/currentPolicy'));
  assert.ok(errorPaths(result).includes('/actions/4/live'));
  assert.ok(errorPaths(result).includes('/actions/4/decision'));
});

test('E04-C probe不能授权第二Writer production实现', () => {
  const snapshot = loadSnapshot();
  snapshot.rejectedProbeEvidence.e04c.productionImplementationAuthorized = true;
  snapshot.globalDecision.secondWriterProductionImplementationAuthorized = true;
  const result = validateReleaseEvidence(snapshot);
  assert.equal(result.valid, false);
  assert.ok(errorPaths(result).includes('/globalDecision'));
  assert.ok(errorPaths(result).includes('/rejectedProbeEvidence/e04c'));
});

test('E05-C small fixture收益不能代替representative gate', () => {
  const snapshot = loadSnapshot();
  snapshot.rejectedProbeEvidence.e05c.productionEligible = true;
  snapshot.rejectedProbeEvidence.e05c.smallCanSubstituteRepresentativeGate = true;
  const result = validateReleaseEvidence(snapshot);
  assert.equal(result.valid, false);
  assert.ok(errorPaths(result).includes('/rejectedProbeEvidence/e05c'));
});

test('Windows和人工资金恢复门禁不能由自动snapshot升级', () => {
  const snapshot = loadSnapshot();
  findAction(snapshot, 'pre-fund:mpt-import').gates.windowsPackaged = 'PASS';
  findAction(snapshot, 'pre-fund:mpt-import').gates.realProcessTermination = 'PASS';
  findAction(snapshot, 'pre-fund:mpt-import').gates.funds = 'PASS';
  findAction(snapshot, 'toolbox:split-multi-output').gates.excelWps = 'PASS';
  const result = validateReleaseEvidence(snapshot);
  assert.equal(result.valid, false);
  assert.ok(errorPaths(result).includes('/actions/2/gates'));
  assert.ok(errorPaths(result).includes('/actions/5/gates'));
});

test('action证据与rollback不能跨action借用', () => {
  const snapshot = loadSnapshot();
  const repair = findAction(snapshot, 'pre-fund:mpt-repair-import');
  repair.evidenceRefs = findAction(snapshot, 'pre-fund:mpt-import').evidenceRefs.slice();
  repair.rollback = structuredClone(findAction(snapshot, 'toolbox:publish').rollback);
  const result = validateReleaseEvidence(snapshot);
  assert.equal(result.valid, false);
  assert.ok(errorPaths(result).includes('/actions/6/evidenceRefs'));
  assert.ok(errorPaths(result).includes('/actions/6/rollback'));
});

test('evidence source hash drift不能静默通过', () => {
  const snapshot = loadSnapshot();
  snapshot.evidenceCatalog[9].sha256 = '0'.repeat(64);
  const result = validateReleaseEvidence(snapshot);
  assert.equal(result.valid, false);
  assert.ok(errorPaths(result).includes('/evidenceCatalog'));
  assert.ok(errorPaths(result).includes('/evidenceCatalog/9/sha256'));
});
