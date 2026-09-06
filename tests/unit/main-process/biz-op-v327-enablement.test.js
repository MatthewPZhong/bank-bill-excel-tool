'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ACTIONS } = require('../../../src/main-process/biz-op-v327/contracts');
const { RELEASE_GATES, REQUIRED_GATES, evaluateReleaseGates } = require('../../../src/main-process/biz-op-v327/release-gates');
const { BIZ_OP_V327_POLICIES, buildBizOpPolicies } = require('../../../src/main-process/biz-op-v327/policies');
const { passedGates } = require('../../helpers/biz-op-v327-upgrade');
const { isBackgroundExecutionProductionEnabled } = require('../../../src/main-process/background-execution/runtime');

test('十二项动作逐项授权启用，未执行验收不显示为 release-pass 或 benchmark 证明', () => {
  const decision = evaluateReleaseGates();
  assert.equal(decision.ready, true);
  assert.equal(decision.authorizationUsed, true);
  assert.deepEqual(decision.missing, []);
  assert.equal(Object.keys(RELEASE_GATES.actions).length, 12);
  assert.deepEqual(Object.keys(RELEASE_GATES.actions).sort(), Object.keys(ACTIONS).sort());
  for (const evidence of [...REQUIRED_GATES.map((key) => RELEASE_GATES[key]), ...Object.values(RELEASE_GATES.actions)]) {
    assert.equal(evidence.status, 'USER_AUTHORIZED');
    assert.equal(evidence.validationStatus, 'NOT_RUN');
    assert.equal(evidence.approvedBy, 'pzhong');
  }
  for (const policy of BIZ_OP_V327_POLICIES) {
    assert.equal(isBackgroundExecutionProductionEnabled(policy.actionKey), true);
    assert.equal(policy.production.enabled, true);
    assert.equal(policy.production.effectiveMode, 'thread-single');
    assert.equal(policy.production.effectiveWorkerCount, 1);
    assert.equal(policy.production.evidenceStatus, 'baseline');
    assert.equal(policy.production.recoveryStatus, 'probe');
    assert.equal(policy.production.benchmarkEvidenceId, null);
  }
});

test('任何一项发布条件或 action 授权缺失都会关闭全部生产策略', async (t) => {
  for (const key of [...REQUIRED_GATES, ...Object.keys(ACTIONS)]) await t.test(key, () => {
    const config = structuredClone(RELEASE_GATES);
    if (REQUIRED_GATES.includes(key)) delete config[key];
    else delete config.actions[key];
    const decision = evaluateReleaseGates(config);
    assert.equal(decision.ready, false);
    assert.deepEqual(decision.missing, [key]);
    assert.ok(buildBizOpPolicies(config).every((policy) => !policy.production.enabled));
  });
});

test('空授权人、日期、理由、短引用以及假验收标签均不能作为授权', async (t) => {
  const cases = [
    ['approvedBy', ' '], ['approvedAt', ''], ['approvedAt', '2026-99-99'],
    ['reason', ' '], ['reference', 'short'], ['validationStatus', 'PASS'],
    ['status', 'NOT RUN'], ['status', 'APPROVED']
  ];
  for (const [key, value] of cases) await t.test(`${key}=${value}`, () => {
    const config = structuredClone(RELEASE_GATES);
    config.fundsAcceptance[key] = value;
    assert.equal(evaluateReleaseGates(config).ready, false);
  });
});

test('版本、总开关和原严格 PASS 路径分别保持独立，授权不可覆盖总开关', () => {
  for (const patch of [{ enabled: false }, { version: '3.2.8' }, { schemaVersion: 2 }]) {
    assert.equal(evaluateReleaseGates({ ...RELEASE_GATES, ...patch }).ready, false);
  }
  const config = passedGates();
  assert.equal(evaluateReleaseGates(config).ready, true);
  assert.equal(evaluateReleaseGates(config).authorizationUsed, false);
  assert.ok(buildBizOpPolicies(config).every((policy) => policy.production.evidenceStatus === 'release-pass'));
  config.fundsAcceptance = { status: 'NOT RUN', reference: 'pending-manual-check' };
  assert.equal(evaluateReleaseGates(config).ready, false);
});

test('本模块开启后仍保留原 1 GiB 租约、关闭取消协议和导出 Publisher 约束', () => {
  for (const policy of BIZ_OP_V327_POLICIES) {
    assert.equal(policy.resources.phase.memoryBytes, 1024 ** 3);
    assert.equal(policy.cancellation.terminateTimeoutMs, 5000);
    assert.equal(policy.mode, 'thread-single');
    assert.equal(policy.adapterKind, 'native');
    if (ACTIONS[policy.actionKey].kind === 'EXPORT') {
      assert.equal(policy.artifacts.filePlanRequired, true);
      assert.ok(policy.artifacts.publisherKey);
    }
  }
});
