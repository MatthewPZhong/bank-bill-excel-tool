'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const { readBocFxLinkRows } = require('../../backend/database/linked-table-repository');
const { canonicalSha256 } = require('../background-execution/canonical-json-v1');
const { sanitizeFinanceSafeValue } = require('../background-execution/error-codec');
const { readReconIdFixFile } = require('../recon-id-fix-io');
const { runReconIdFix } = require('../recon-id-fix-engine');
const {
  RECON_FIX_IMPORT_ACTION,
  RECON_FIX_RUN_READONLY_ACTION
} = require('./policies');

const MAX_PERSISTENT_STATE_BYTES = 268435456;
const MEMORY_OVERHEAD_MULTIPLIER = 4;

class ReconFixServiceError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ReconFixServiceError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new ReconFixServiceError(code, message);
}

function assertExactKeys(value, expected, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).sort().join(',') !== [...expected].sort().join(',')) {
    fail('RECON_FIX_COMMAND_INVALID', `${label} 字段不符合 E11-A 冻结合同`);
  }
}

function assertExpectedRevision(value, currentRevision) {
  if (!Number.isSafeInteger(value) || value < 0) {
    fail('RECON_FIX_REVISION_INVALID', 'expectedRevision 必须是非负安全整数');
  }
  if (value !== currentRevision) {
    fail('RECON_FIX_REVISION_STALE', `状态 revision 已变化（expected=${value}, current=${currentRevision}）`);
  }
}

function safeSubMode(value) {
  if (!['business', 'gateway'].includes(value)) {
    fail('RECON_FIX_SUB_MODE_INVALID', 'subMode 必须是 business 或 gateway');
  }
  return value;
}

function compactBytes(value) {
  let json;
  try {
    json = JSON.stringify(value);
  } catch (_error) {
    fail('RECON_FIX_STATE_NOT_JSON_SAFE', 'ReconFix state 无法序列化');
  }
  if (json === undefined) fail('RECON_FIX_STATE_NOT_JSON_SAFE', 'ReconFix state 无法序列化');
  return Buffer.byteLength(json, 'utf8');
}

function estimatePersistentStateBytes(value) {
  const compact = compactBytes(value);
  const estimated = compact * MEMORY_OVERHEAD_MULTIPLIER;
  if (!Number.isSafeInteger(estimated)) {
    fail('RECON_FIX_STATE_TOO_LARGE', 'ReconFix state footprint 超出安全整数范围');
  }
  return Math.max(1, estimated);
}

function assertPersistentStateFits(value) {
  const memoryBytes = estimatePersistentStateBytes(value);
  if (memoryBytes > MAX_PERSISTENT_STATE_BYTES) {
    fail(
      'RECON_FIX_STATE_TOO_LARGE',
      `ReconFix state 估算 ${memoryBytes} bytes，超过 ${MAX_PERSISTENT_STATE_BYTES} bytes 上限`
    );
  }
  return memoryBytes;
}

function stateDigest(state) {
  return canonicalSha256({
    serviceGeneration: state.serviceGeneration,
    revision: state.revision,
    sessionEvidenceHash: state.session ? state.session.inputEvidenceHash : null,
    resultHandle: state.result ? state.result.resultHandle : null
  });
}

function buildScenarioSnapshot(scenario) {
  if (!scenario || typeof scenario !== 'object' || Array.isArray(scenario)) {
    fail('RECON_FIX_SCENARIO_INVALID', 'scenario 必须是对象');
  }
  const category = scenario.category;
  if (!['recon-id-fix', 'gateway-recon-id-fix'].includes(category)) {
    fail('RECON_FIX_SCENARIO_INVALID', 'scenario.category 不是 ReconFix 类别');
  }
  if (scenario.config && scenario.config.subCategory === 'jpm-dispatch-order-fix') {
    fail('RECON_FIX_JPM_REQUIRES_E11_P0', 'JPM managed run 尚未交付，必须继续使用 legacy 路径');
  }
  let owned;
  try {
    owned = structuredClone(scenario);
  } catch (_error) {
    fail('RECON_FIX_SCENARIO_INVALID', 'scenario 无法安全复制');
  }
  return Object.freeze({
    value: owned,
    hash: canonicalSha256(owned, { maxBytes: 262144 })
  });
}

function readBocEvidence(dbPath) {
  if (typeof dbPath !== 'string' || dbPath.length === 0 || !path.isAbsolute(dbPath)) {
    fail('RECON_FIX_BOC_DB_PATH_INVALID', 'BOC run 必须提供绝对只读数据库路径');
  }
  const resolved = path.resolve(dbPath);
  let db;
  try {
    db = new DatabaseSync(resolved, { readOnly: true });
    const rows = readBocFxLinkRows(db);
    return Object.freeze({
      rows,
      hash: canonicalSha256(rows)
    });
  } finally {
    if (db) db.close();
  }
}

function publicResult(state) {
  const digest = stateDigest(state);
  if (!state.result) {
    return Object.freeze({
      kind: 'imported',
      serviceGeneration: state.serviceGeneration,
      revision: state.revision,
      stateDigest: digest,
      summary: Object.freeze({
        fileName: sanitizeFinanceSafeValue(state.session.fileName),
        subMode: state.session.subMode,
        sheetCounts: state.session.sheetCounts,
        hasResult: false
      })
    });
  }
  return Object.freeze({
    kind: 'readonly-result',
    serviceGeneration: state.serviceGeneration,
    revision: state.revision,
    stateDigest: digest,
    resultHandle: state.result.resultHandle,
    scenarioSnapshotHash: state.result.scenarioSnapshotHash,
    linkedEvidenceHash: state.result.linkedEvidenceHash,
    summary: state.result.summary
  });
}

function createCandidate(service, fields) {
  const state = {
    serviceGeneration: service.serviceGeneration,
    revision: service.revision + 1,
    session: fields.session,
    result: fields.result
  };
  return Object.freeze({
    baseRevision: service.revision,
    revision: state.revision,
    state,
    memoryBytes: assertPersistentStateFits(state)
  });
}

function createReconFixService(options = {}) {
  if (!Number.isSafeInteger(options.serviceGeneration) || options.serviceGeneration < 1) {
    throw new TypeError('serviceGeneration 必须是正安全整数');
  }
  let state = {
    serviceGeneration: options.serviceGeneration,
    revision: 0,
    session: null,
    result: null
  };
  let reservationId = null;
  let closed = false;
  let active = false;

  function assertOpen() {
    if (closed) fail('RECON_FIX_SERVICE_CLOSED', 'ReconFix Service 已关闭');
  }

  function begin(actionKey, input) {
    assertOpen();
    if (active) fail('RECON_FIX_SERVICE_BUSY', 'ReconFix Service 同时只允许一个 command');
    if (![RECON_FIX_IMPORT_ACTION, RECON_FIX_RUN_READONLY_ACTION].includes(actionKey)) {
      fail('RECON_FIX_ACTION_UNSUPPORTED', `E11-A 不支持 action：${String(actionKey)}`);
    }
    active = true;
    try {
      if (actionKey === RECON_FIX_IMPORT_ACTION) {
        assertExactKeys(input, ['expectedRevision', 'filePath', 'subMode'], 'import input');
        assertExpectedRevision(input.expectedRevision, state.revision);
        const subMode = safeSubMode(input.subMode);
        if (typeof input.filePath !== 'string' || input.filePath.length === 0 || !path.isAbsolute(input.filePath)) {
          fail('RECON_FIX_FILE_PATH_INVALID', 'import filePath 必须是绝对路径');
        }
        const resolvedPath = path.resolve(input.filePath);
        const fileStat = fs.statSync(resolvedPath);
        if (!fileStat.isFile()) fail('RECON_FIX_FILE_PATH_INVALID', 'import filePath 不是文件');
        const imported = readReconIdFixFile(resolvedPath, subMode);
        const sheetCounts = Object.freeze({
          recon: imported.sheets.reconResult.length,
          business: imported.sheets.businessBills.length,
          opponent: imported.sheets.opponentBills.length
        });
        const session = {
          filePath: imported.filePath,
          fileName: imported.fileName,
          sheets: imported.sheets,
          importedAt: imported.importedAt,
          subMode,
          sheetCounts,
          inputEvidenceHash: canonicalSha256({ subMode, sheets: imported.sheets })
        };
        return Object.freeze({
          kind: 'candidate',
          actionKey,
          candidate: createCandidate(serviceApi, { session, result: null })
        });
      }

      assertExactKeys(input, ['bocDatabasePath', 'expectedRevision', 'scenario'], 'run input');
      assertExpectedRevision(input.expectedRevision, state.revision);
      if (!state.session) fail('RECON_FIX_SESSION_REQUIRED', '请先导入 ReconFix 文件');
      const snapshot = buildScenarioSnapshot(input.scenario);
      const expectedSubMode = snapshot.value.category === 'gateway-recon-id-fix' ? 'gateway' : 'business';
      if (expectedSubMode !== state.session.subMode) {
        fail('RECON_FIX_SUB_MODE_MISMATCH', '场景类别与已导入文件类别不一致');
      }
      const isBoc = snapshot.value.category === 'gateway-recon-id-fix' &&
        snapshot.value.config && snapshot.value.config.subCategory === 'boc-dispatch-order-fix';
      if (!isBoc && input.bocDatabasePath !== null) {
        fail('RECON_FIX_BOC_DB_PATH_UNEXPECTED', 'standard run 不得携带 BOC 数据库路径');
      }
      const linked = isBoc ? readBocEvidence(input.bocDatabasePath) : null;
      const linkedEvidenceHash = linked ? linked.hash : null;
      const currentResult = state.result;
      const evidenceChanged = Boolean(currentResult && (
        currentResult.scenarioSnapshotHash !== snapshot.hash ||
        currentResult.linkedEvidenceHash !== linkedEvidenceHash
      ));
      return Object.freeze({
        kind: 'run-plan',
        actionKey,
        evidenceChanged,
        invalidationCandidate: evidenceChanged
          ? createCandidate(serviceApi, { session: state.session, result: null })
          : null,
        execute() {
          assertOpen();
          const clonedSheets = {
            reconResult: structuredClone(state.session.sheets.reconResult),
            businessBills: structuredClone(state.session.sheets.businessBills),
            opponentBills: structuredClone(state.session.sheets.opponentBills),
            fixTemplate: state.session.sheets.fixTemplate
          };
          const result = runReconIdFix(
            snapshot.value,
            clonedSheets,
            isBoc ? { bocLinkRows: linked.rows } : {}
          );
          // C4/BOC 旧引擎的行对象可能使用 null prototype；Service 状态必须
          // 是可结构化克隆的 plain JSON，且不改动引擎返回值本身。
          const ownedResult = structuredClone(result);
          const privateResult = {
            runKind: isBoc ? 'boc' : 'standard',
            scenarioSnapshot: snapshot.value,
            scenarioSnapshotHash: snapshot.hash,
            linkedEvidenceHash,
            inputEvidenceHash: state.session.inputEvidenceHash,
            fixedRows: ownedResult.fixedRows,
            warnings: ownedResult.warnings,
            unmatchedRows: ownedResult.unmatchedRows || [],
            stats: ownedResult.stats
          };
          const resultDigest = canonicalSha256({
            fixedRows: privateResult.fixedRows,
            warnings: privateResult.warnings,
            unmatchedRows: privateResult.unmatchedRows,
            stats: privateResult.stats
          });
          privateResult.resultHandle = canonicalSha256({
            serviceGeneration: state.serviceGeneration,
            revision: state.revision + 1,
            resultDigest,
            scenarioSnapshotHash: snapshot.hash,
            linkedEvidenceHash
          });
          privateResult.summary = Object.freeze({
            runKind: privateResult.runKind,
            fixedRowCount: privateResult.fixedRows.length,
            warningCount: privateResult.warnings.length,
            unmatchedRowCount: privateResult.unmatchedRows.length,
            resultDigest
          });
          return createCandidate(serviceApi, { session: state.session, result: privateResult });
        }
      });
    } catch (error) {
      active = false;
      throw error;
    }
  }

  function adopt(candidate, nextReservationId) {
    assertOpen();
    if (!active || !candidate || candidate.baseRevision !== state.revision ||
        candidate.revision !== state.revision + 1) {
      fail('RECON_FIX_CANDIDATE_STALE', '候选状态与当前 revision 不一致');
    }
    if (typeof nextReservationId !== 'string' || nextReservationId.length === 0) {
      fail('RECON_FIX_RESERVATION_INVALID', 'PersistentReservation identity 无效');
    }
    state = candidate.state;
    reservationId = nextReservationId;
    return publicResult(state);
  }

  function finish() {
    active = false;
  }

  function close() {
    const priorReservationId = reservationId;
    state = {
      serviceGeneration: options.serviceGeneration,
      revision: state.revision,
      session: null,
      result: null
    };
    reservationId = null;
    active = false;
    closed = true;
    return priorReservationId;
  }

  const serviceApi = Object.freeze({
    get serviceGeneration() { return state.serviceGeneration; },
    get revision() { return state.revision; },
    get reservationId() { return reservationId; },
    get active() { return active; },
    begin,
    adopt,
    finish,
    close,
    boundedStatus() {
      return Object.freeze({
        serviceGeneration: state.serviceGeneration,
        revision: state.revision,
        busy: active,
        hasSession: Boolean(state.session),
        hasResult: Boolean(state.result),
        sessionInputEvidenceHash: state.session ? state.session.inputEvidenceHash : null,
        resultHandle: state.result ? state.result.resultHandle : null,
        stateDigest: stateDigest(state)
      });
    }
  });
  return serviceApi;
}

module.exports = {
  MAX_PERSISTENT_STATE_BYTES,
  MEMORY_OVERHEAD_MULTIPLIER,
  ReconFixServiceError,
  createReconFixService,
  estimatePersistentStateBytes,
  readBocEvidence
};
