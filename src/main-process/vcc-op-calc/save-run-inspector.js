'use strict';

const {
  canonicalSha256
} = require('../background-execution/canonical-json-v1');
const {
  normalizeRecoveryInspectionResult,
  normalizeRecoverySource
} = require('../background-execution/recovery-source');
const {
  VCC_OP_SAVE_RUN_ACTION_KEY,
  VCC_SAVE_RUN_INSPECTION_EVIDENCE_VERSION,
  inspectVccOpSaveRunEvidence
} = require('./save-run-contract');

const VCC_OP_SAVE_RUN_INSPECTOR_KEY = 'inspector.vcc-op:save-run';

function sourceFromInspectionInput(input) {
  const { db: _db, ...sourceInput } = input;
  return normalizeRecoverySource(sourceInput);
}

function assertVccSaveRunSource(source) {
  if (source.actionKey !== VCC_OP_SAVE_RUN_ACTION_KEY
      || source.inspectorKey !== VCC_OP_SAVE_RUN_INSPECTOR_KEY
      || source.sourceKind !== 'critical-intent'
      || source.settlementKey !== null
      || source.evidenceVersion !== 1) {
    throw Object.assign(new Error('VCC saveRun Inspector 收到非 canonical worker-durable source'), {
      code: 'VCC_OP_SAVE_RUN_INSPECTOR_SOURCE_MISMATCH'
    });
  }
  const evidence = source.boundedEvidence;
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) {
    throw Object.assign(new Error('VCC saveRun source 缺少 bounded evidence'), {
      code: 'VCC_OP_SAVE_RUN_INSPECTOR_EVIDENCE_INVALID'
    });
  }
  return evidence;
}

// 唯一只读 outcome API。输入除 db 外逐字段等价于 RecoverySourceV1；
// task/hash/month/fileCount/opening balance 均取持久 source evidence，不从最新 run 猜测。
function inspectVccOpSaveRunOutcome(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('inspectVccOpSaveRunOutcome input 必须是对象');
  }
  const db = input.db;
  if (!db || typeof db.prepare !== 'function') {
    throw new TypeError('VCC saveRun Inspector 需要 DatabaseSync');
  }
  const source = sourceFromInspectionInput(input);
  const expected = assertVccSaveRunSource(source);
  const inspected = inspectVccOpSaveRunEvidence(db, {
    actionKey: source.actionKey,
    operationKey: source.operationKey,
    taskRunId: source.taskRunId,
    computeSnapshotHash: expected.computeSnapshotHash,
    yearMonth: expected.yearMonth,
    inputFileCount: expected.inputFileCount,
    beginOp: expected.beginOp
  });
  const result = {
    contractVersion: 1,
    sourceKind: source.sourceKind,
    sourceRef: source.sourceRef,
    actionKey: source.actionKey,
    operationKey: source.operationKey,
    taskRunId: source.taskRunId,
    outcome: inspected.outcome,
    evidenceVersion: VCC_SAVE_RUN_INSPECTION_EVIDENCE_VERSION,
    evidenceHash: canonicalSha256(inspected.boundedEvidence),
    boundedEvidence: inspected.boundedEvidence
  };
  return normalizeRecoveryInspectionResult(source, result);
}

function createVccOpSaveRunInspector(options = {}) {
  if (typeof options.getDb !== 'function') {
    throw new TypeError('VCC saveRun Inspector factory 需要 getDb');
  }
  return async function inspectVccOpSaveRunSource(source) {
    const db = options.getDb();
    if (!db) throw new Error('VCC saveRun Inspector 数据库未初始化');
    return inspectVccOpSaveRunOutcome({ db, ...source });
  };
}

module.exports = {
  VCC_OP_SAVE_RUN_INSPECTOR_KEY,
  createVccOpSaveRunInspector,
  inspectVccOpSaveRunOutcome
};
