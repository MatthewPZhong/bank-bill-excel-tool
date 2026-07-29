'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  FundTransferPolicyConfigError,
  hasFundTransferReservedSignature,
  isCanonicalFundTransferOwner,
  resolveFundTransferDatePolicy,
  stableStringify
} = require('../../../src/main-process/fund-transfer-date-policy');

function makeOwner(overrides = {}) {
  return {
    id: 21,
    category: 'builtin-fixed',
    name: '中台调拨订单对账ID回填',
    enabled: false,
    isBuiltin: true,
    config: {
      funcCategory: 'platform-order',
      subCategory: 'fund-transfer-backfill',
      dateMatchEnabled: true,
      dateToleranceDays: 7
    },
    ...overrides
  };
}

test.describe('fund-transfer-date-policy canonical identity', () => {
  test('完整四条件才是 canonical owner；非内置同签名只是保留签名冲突', () => {
    const owner = makeOwner();
    const clone = { ...owner, id: 22, isBuiltin: false };
    assert.equal(hasFundTransferReservedSignature(owner), true);
    assert.equal(isCanonicalFundTransferOwner(owner), true);
    assert.equal(hasFundTransferReservedSignature(clone), true);
    assert.equal(isCanonicalFundTransferOwner(clone), false);
    assert.equal(isCanonicalFundTransferOwner({ ...owner, category: 'gateway-recon-id-fix' }), false);
    assert.equal(isCanonicalFundTransferOwner({
      ...owner,
      config: { ...owner.config, funcCategory: 'other' }
    }), false);
  });
});

test.describe('resolveFundTransferDatePolicy', () => {
  test('owner enabled/disabled 不影响 policy，返回 ownerScenarioId 和不可变 signature', () => {
    const disabled = resolveFundTransferDatePolicy([makeOwner({ enabled: false })]);
    const enabled = resolveFundTransferDatePolicy([makeOwner({ enabled: true })]);
    assert.deepEqual(disabled.policy, enabled.policy);
    assert.equal(disabled.policy.enabled, true);
    assert.equal(disabled.policy.toleranceDays, 7);
    assert.equal(disabled.policy.ownerScenarioId, 21);
    assert.equal(disabled.warnings.length, 0);
    assert.equal(Object.isFrozen(disabled.policy), true);
    assert.equal(Object.isFrozen(disabled.ownerScenario.config), true);
  });

  test('owner 缺失 → true + 1 防御默认并产生一次可见 warning', () => {
    const result = resolveFundTransferDatePolicy([]);
    assert.deepEqual(
      {
        enabled: result.policy.enabled,
        toleranceDays: result.policy.toleranceDays,
        ownerScenarioId: result.policy.ownerScenarioId
      },
      { enabled: true, toleranceDays: 1, ownerScenarioId: null }
    );
    assert.equal(result.warnings.length, 1);
    assert.deepEqual(result.warnings[0], {
      scenarioId: null,
      scenarioName: '调拨日期策略配置',
      rowId: null,
      code: 'fund-transfer-policy-owner-missing',
      message: result.warnings[0].message
    });
  });

  test('缺字段兼容默认不告警；非法字段分别回退并告警', () => {
    const missing = resolveFundTransferDatePolicy([
      makeOwner({
        config: {
          funcCategory: 'platform-order',
          subCategory: 'fund-transfer-backfill'
        }
      })
    ]);
    assert.equal(missing.policy.enabled, true);
    assert.equal(missing.policy.toleranceDays, 1);
    assert.equal(missing.warnings.length, 0);

    const invalid = resolveFundTransferDatePolicy([
      makeOwner({
        config: {
          funcCategory: 'platform-order',
          subCategory: 'fund-transfer-backfill',
          dateMatchEnabled: 'true',
          dateToleranceDays: 0
        }
      })
    ]);
    assert.equal(invalid.policy.enabled, true);
    assert.equal(invalid.policy.toleranceDays, 1);
    assert.deepEqual(
      invalid.warnings.map((warning) => warning.code),
      [
        'fund-transfer-policy-invalid-date-enabled',
        'fund-transfer-policy-invalid-tolerance-days'
      ]
    );
    assert.ok(invalid.warnings.every((warning) => warning.scenarioId === 21));
  });

  test('关闭日期保留 N，边界 1/999 合法', () => {
    const min = resolveFundTransferDatePolicy([
      makeOwner({
        config: {
          funcCategory: 'platform-order',
          subCategory: 'fund-transfer-backfill',
          dateMatchEnabled: false,
          dateToleranceDays: 1
        }
      })
    ]);
    const max = resolveFundTransferDatePolicy([
      makeOwner({
        config: {
          funcCategory: 'platform-order',
          subCategory: 'fund-transfer-backfill',
          dateMatchEnabled: false,
          dateToleranceDays: 999
        }
      })
    ]);
    assert.deepEqual(
      [min.policy.enabled, min.policy.toleranceDays, max.policy.enabled, max.policy.toleranceDays],
      [false, 1, false, 999]
    );
  });

  test('owner 重复 fail-closed，错误暴露稳定 code/conflicts', () => {
    assert.throws(
      () => resolveFundTransferDatePolicy([
        makeOwner({ id: 21, name: 'owner-a' }),
        makeOwner({ id: 22, name: 'owner-b' })
      ]),
      (error) => {
        assert.ok(error instanceof FundTransferPolicyConfigError);
        assert.equal(error.code, 'fund-transfer-policy-duplicate-owner');
        assert.equal(error.ownerCount, 2);
        assert.deepEqual(error.conflicts.map((item) => item.id), [21, 22]);
        return true;
      }
    );
  });

  test('非 owner 保留签名冲突 fail-closed，不允许 first-wins', () => {
    assert.throws(
      () => resolveFundTransferDatePolicy([
        makeOwner(),
        makeOwner({ id: 33, name: '伪内置', isBuiltin: false })
      ]),
      (error) => {
        assert.equal(error.code, 'fund-transfer-policy-reserved-signature-conflict');
        assert.equal(error.conflicts.length, 1);
        assert.equal(error.conflicts[0].id, 33);
        return true;
      }
    );
  });

  test('signature 包含 raw 非法值：非法 A→B 即使 effective 相同也失效', () => {
    const first = resolveFundTransferDatePolicy([
      makeOwner({
        config: {
          funcCategory: 'platform-order',
          subCategory: 'fund-transfer-backfill',
          dateMatchEnabled: 'A',
          dateToleranceDays: 0
        }
      })
    ]);
    const second = resolveFundTransferDatePolicy([
      makeOwner({
        config: {
          funcCategory: 'platform-order',
          subCategory: 'fund-transfer-backfill',
          dateMatchEnabled: 'B',
          dateToleranceDays: -1
        }
      })
    ]);
    assert.equal(first.policy.enabled, second.policy.enabled);
    assert.equal(first.policy.toleranceDays, second.policy.toleranceDays);
    assert.notEqual(first.policy.signature, second.policy.signature);
  });

  test('stable stringify 不受对象键顺序影响', () => {
    assert.equal(
      stableStringify({ z: 1, a: { y: 2, x: 3 } }),
      stableStringify({ a: { x: 3, y: 2 }, z: 1 })
    );
  });
});
