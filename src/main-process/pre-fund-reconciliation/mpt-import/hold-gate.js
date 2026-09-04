'use strict';

const { readMptHeader } = require('../mpt-parser');
const {
  derivePreFundMptConflictScopeKey,
  isPreFundMptConflictScopeKey
} = require('./conflict-scope');

function requireDependencies(options) {
  if (!options || !options.readRepository || !options.recoveryHoldGate ||
      typeof options.readRepository.listActiveRecoveryHolds !== 'function' ||
      typeof options.recoveryHoldGate.assertNoRecoveryHold !== 'function') {
    throw new TypeError('PreFund MPT Hold gate依赖不完整');
  }
}

function identityFromHeader(header) {
  return Object.freeze({
    sourceType: header.sourceType,
    sourceBatch: header.sourceBatch
  });
}

function createPreFundMptHoldGate(options) {
  requireDependencies(options);
  const readRepository = options.readRepository;
  const recoveryHoldGate = options.recoveryHoldGate;

  function assertIdentities(identities) {
    const scopes = new Set();
    for (const identity of identities || []) {
      scopes.add(derivePreFundMptConflictScopeKey(identity));
    }
    for (const conflictScopeKey of scopes) {
      recoveryHoldGate.assertNoRecoveryHold({ conflictScopeKey });
    }
    return Object.freeze([...scopes]);
  }

  async function inspectFiles(filePaths, expectedFailures = null) {
    const identities = [];
    for (let index = 0; index < filePaths.length; index += 1) {
      let header;
      try {
        header = await readMptHeader(filePaths[index]);
      } catch (_error) {
        // 这里只为可识别 batch 推导 exact Hold scope。缺失、文件名/header 非法等
        // 仍交给 import/repair 的逐文件执行路径形成原有失败结果；任何可写 identity
        // 会在真正 mutation 前由 identityGate 再次按实际 header fail closed。
        continue;
      }
      const identity = identityFromHeader(header);
      const expected = expectedFailures && expectedFailures[index];
      if (expected && (expected.sourceType !== identity.sourceType ||
          expected.sourceBatch !== identity.sourceBatch)) {
        const error = new Error('repair文件header identity与保存的failure identity不一致');
        error.code = 'PREFUND_REPAIR_SCOPE_IDENTITY_MISMATCH';
        throw error;
      }
      identities.push(identity);
    }
    return Object.freeze({
      identities: Object.freeze(identities),
      conflictScopeKeys: assertIdentities(identities)
    });
  }

  function assertAnyMutationAllowed() {
    const active = readRepository.listActiveRecoveryHolds()
      .find((hold) => isPreFundMptConflictScopeKey(hold.conflictScopeKey));
    if (active) recoveryHoldGate.assertNoRecoveryHold({ conflictScopeKey: active.conflictScopeKey });
    return true;
  }

  function assertDeleteBatch(payload) {
    return assertIdentities([{
      sourceType: payload && payload.sourceType,
      sourceBatch: payload && payload.sourceBatch
    }]);
  }

  function assertDeleteDateRange(service, payload = {}) {
    if (!service || typeof service.inspectTempDateRange !== 'function') {
      throw new TypeError('PreFund date-range Hold gate缺少业务归一化inspector');
    }
    // scope枚举与后续删除共享业务层权威归一化后的同一range，禁止raw payload漂移。
    const inspected = service.inspectTempDateRange(payload);
    assertIdentities(inspected.identities);
    return inspected.range;
  }

  return Object.freeze({
    assertAnyMutationAllowed,
    assertDeleteBatch,
    assertDeleteDateRange,
    assertIdentities,
    inspectFiles
  });
}

module.exports = {
  createPreFundMptHoldGate
};
