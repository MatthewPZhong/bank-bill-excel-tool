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
      const header = await readMptHeader(filePaths[index]);
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
    // 复用业务层校验日期/sourceType，再只读枚举真正受影响的batch scope。
    service.countTempByDateRange(payload);
    const identities = service.listTempBatches()
      .filter((batch) => batch.sourceType === payload.sourceType &&
        batch.sourceDate >= payload.start && batch.sourceDate <= payload.end)
      .map((batch) => ({ sourceType: batch.sourceType, sourceBatch: batch.sourceBatch }));
    return assertIdentities(identities);
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
