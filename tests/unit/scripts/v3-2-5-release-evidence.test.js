'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  HISTORICAL_RELEASES,
  SNAPSHOT_PATH,
  WORK_ITEM_ACTIONS,
  buildExpectedReleaseEvidence,
  deepClone,
  validateReleaseEvidence
} = require('../../../scripts/validate-v3-2-5-release-evidence');

const REPOSITORY_ROOT = path.resolve(__dirname, '../../..');

function loadSnapshot() {
  return JSON.parse(fs.readFileSync(SNAPSHOT_PATH, 'utf8'));
}

function codes(result) {
  return result.errors.map((error) => error.code);
}

function validateMutant(mutator, options) {
  const candidate = deepClone(loadSnapshot());
  mutator(candidate);
  return validateReleaseEvidence(candidate, options);
}

test('R3.2.5 canonical release evidence 与 deterministic authority model 一致', () => {
  const snapshot = loadSnapshot();
  assert.deepEqual(snapshot, buildExpectedReleaseEvidence());
  const result = validateReleaseEvidence(snapshot);
  assert.equal(result.valid, true, JSON.stringify(result.errors));
  assert.equal(result.facts.actionCount, 54);
  assert.equal(result.facts.productionEnabledCount, 0);
  assert.equal(result.facts.legacyEffectiveCount, 54);
  assert.equal(result.facts.contractChecks, 29);
  assert.equal(result.facts.checksumEntries, 69);
});

test('54 actions 精确分成 36 implemented、16 legacy-only、2 platform canary', () => {
  const snapshot = loadSnapshot();
  const counts = snapshot.actions.reduce((result, action) => {
    result[action.capability.status] = (result[action.capability.status] || 0) + 1;
    return result;
  }, {});
  assert.deepEqual(counts, {
    implemented: 36,
    'platform-canary': 2,
    'legacy-only': 16
  });
});

test('E13-A～F 17 actions 与历史/legacy/canary assignment 无重叠且覆盖完整', () => {
  const snapshot = loadSnapshot();
  const counts = snapshot.actions.reduce((result, action) => {
    result[action.evidenceKind] = (result[action.evidenceKind] || 0) + 1;
    return result;
  }, {});
  assert.deepEqual(counts, {
    'v3.2.5-implementation': 17,
    'platform-canary': 2,
    'historical-release-evidence': 30,
    'legacy-unchanged': 5
  });
  assert.equal(
    Object.entries(WORK_ITEM_ACTIONS)
      .filter(([key]) => /^E13-[A-F]$/.test(key))
      .reduce((total, [, actions]) => total + actions.length, 0),
    17
  );
  assert.equal(HISTORICAL_RELEASES.length, 4);
});

test('每个 action 都有九类独立证据字段和唯一 fixture', () => {
  const snapshot = loadSnapshot();
  const fixtures = new Set();
  for (const action of snapshot.actions) {
    assert.ok(action.baselineFixtureId);
    assert.equal(fixtures.has(action.baselineFixtureId), false, action.baselineFixtureId);
    fixtures.add(action.baselineFixtureId);
    assert.ok(action.semanticComparison.status);
    assert.ok(action.dbReadEvidence.status);
    assert.ok(action.workbookComparison.status);
    assert.ok(action.faultInjection.status);
    assert.ok(action.resourceMetrics.status);
    assert.ok(action.externalGates.windowsPackaged);
    assert.ok(action.externalGates.funds);
    assert.ok(action.externalGates.recovery);
    assert.ok(action.productionDecision.kind);
    assert.ok(action.evidenceRefs.length >= 5, action.actionKey);
  }
  assert.equal(fixtures.size, 54);
});

test('全部 evidence refs 指向当前树中的真实文件', () => {
  for (const action of loadSnapshot().actions) {
    for (const relativePath of action.evidenceRefs) {
      assert.equal(
        fs.existsSync(path.join(REPOSITORY_ROOT, relativePath)),
        true,
        `${action.actionKey}: ${relativePath}`
      );
    }
  }
});

test('所有 action 的 effective strategy 与 production decision 都保持 legacy/0/false', () => {
  for (const action of loadSnapshot().actions) {
    assert.equal(action.effectiveStrategy.mode, 'legacy', action.actionKey);
    assert.equal(action.effectiveStrategy.workerCount, 0, action.actionKey);
    assert.equal(action.effectiveStrategy.featureFlag, false, action.actionKey);
    assert.equal(action.productionDecision.kind, 'KEEP_LEGACY', action.actionKey);
    assert.equal(action.productionDecision.enabled, false, action.actionKey);
  }
});

test('Windows、真实样本、观察窗口及资金/恢复人工门禁未被伪造为 PASS', () => {
  for (const action of loadSnapshot().actions) {
    assert.equal(action.externalGates.windowsPackaged, 'NOT_RUN', action.actionKey);
    assert.equal(action.externalGates.realBusinessSamples, 'PENDING_HUMAN_REVIEW', action.actionKey);
    assert.equal(action.externalGates.stabilityWindow, 'NOT_STARTED', action.actionKey);
    assert.equal(action.externalGates.funds, 'PENDING_HUMAN_REVIEW', action.actionKey);
    assert.equal(action.externalGates.recovery, 'PENDING_HUMAN_REVIEW', action.actionKey);
  }
});

test('release-check/check-vars/scan:vars 仅记录用户要求跳过', () => {
  assert.deepEqual(loadSnapshot().validationEvidence.explicitlySkippedByUserInstruction, {
    releaseCheck: 'SKIPPED_USER_INSTRUCTION',
    checkVars: 'SKIPPED_USER_INSTRUCTION',
    scanVars: 'SKIPPED_USER_INSTRUCTION'
  });
});

test('缺失 action 的 snapshot fail closed', () => {
  const result = validateMutant((snapshot) => snapshot.actions.pop());
  assert.equal(result.valid, false);
  assert.ok(codes(result).includes('ACTION_COUNT_INVALID'));
});

test('额外 action 的 snapshot fail closed', () => {
  const result = validateMutant((snapshot) => {
    const extra = deepClone(snapshot.actions[0]);
    extra.actionKey = 'forged:extra';
    extra.baselineFixtureId = 'FORGED:extra';
    snapshot.actions.push(extra);
  });
  assert.equal(result.valid, false);
  assert.ok(codes(result).includes('ACTION_COUNT_INVALID'));
});

test('重复 action 与 fixture fail closed', () => {
  const result = validateMutant((snapshot) => {
    snapshot.actions[1].actionKey = snapshot.actions[0].actionKey;
    snapshot.actions[1].baselineFixtureId = snapshot.actions[0].baselineFixtureId;
  });
  assert.equal(result.valid, false);
  assert.ok(codes(result).includes('ACTION_DUPLICATE'));
  assert.ok(codes(result).includes('FIXTURE_DUPLICATE'));
});

test('production mode 或 worker count 被启用时 fail closed', () => {
  const result = validateMutant((snapshot) => {
    snapshot.actions[0].effectiveStrategy.mode = 'thread-pool';
    snapshot.actions[0].effectiveStrategy.workerCount = 2;
    snapshot.actions[0].effectiveStrategy.featureFlag = true;
  });
  assert.equal(result.valid, false);
  assert.ok(codes(result).includes('EFFECTIVE_STRATEGY_UNSAFE'));
});

test('production decision 被启用时 fail closed', () => {
  const result = validateMutant((snapshot) => {
    snapshot.actions[0].productionDecision.kind = 'ENABLE';
    snapshot.actions[0].productionDecision.enabled = true;
  });
  assert.equal(result.valid, false);
  assert.ok(codes(result).includes('PRODUCTION_DECISION_UNSAFE'));
});

test('Windows 未执行却写 PASS 时 fail closed', () => {
  const result = validateMutant((snapshot) => {
    snapshot.actions[0].externalGates.windowsPackaged = 'PASS';
  });
  assert.equal(result.valid, false);
  assert.ok(codes(result).includes('WINDOWS_GATE_FORGED'));
});

test('资金或恢复人工复核被伪造为 PASS 时 fail closed', () => {
  const result = validateMutant((snapshot) => {
    snapshot.actions[0].externalGates.funds = 'PASS';
    snapshot.actions[0].externalGates.recovery = 'PASS';
  });
  assert.equal(result.valid, false);
  assert.ok(codes(result).includes('HUMAN_GATE_FORGED'));
});

test('未开始的观察窗口被伪造稳定时 fail closed', () => {
  const result = validateMutant((snapshot) => {
    snapshot.actions[0].externalGates.stabilityWindow = 'STABLE';
  });
  assert.equal(result.valid, false);
  assert.ok(codes(result).includes('OBSERVATION_GATE_FORGED'));
});

test('不存在的 action evidence ref fail closed', () => {
  const result = validateMutant((snapshot) => {
    snapshot.actions[0].evidenceRefs.push('missing/evidence.txt');
  });
  assert.equal(result.valid, false);
  assert.ok(codes(result).includes('EVIDENCE_REF_MISSING'));
});

test('package 或 lock 不是 3.2.5 时 fail closed', () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(REPOSITORY_ROOT, 'package.json')));
  const packageLock = JSON.parse(fs.readFileSync(path.join(REPOSITORY_ROOT, 'package-lock.json')));
  packageJson.version = '3.2.4';
  const result = validateReleaseEvidence(loadSnapshot(), { packageJson, packageLock });
  assert.equal(result.valid, false);
  assert.ok(codes(result).includes('PACKAGE_VERSION_MISMATCH'));
});

test('发布文档伪造 production 或资金人工 PASS 时 fail closed', () => {
  const forged = [
    'v3.2.5',
    '54 个 action',
    'production 已启用',
    'Windows NOT_RUN',
    '资金人工复核：PASS'
  ].join('\n');
  const result = validateReleaseEvidence(loadSnapshot(), {
    documents: { forged }
  });
  assert.equal(result.valid, false);
  assert.ok(codes(result).includes('RELEASE_DOCUMENT_UNSAFE_CLAIM'));
});
