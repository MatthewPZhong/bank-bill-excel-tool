'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const yauzl = require('yauzl');

const { readBocFxLinkRows } = require('../../backend/database/linked-table-repository');
const {
  ADM_TABLE,
  readAdmRowsForWriteback
} = require('../../backend/database/linked-table-writeback-reader');
const { canonicalSha256 } = require('../background-execution/canonical-json-v1');
const { sanitizeFinanceSafeValue } = require('../background-execution/error-codec');
const { readReconIdFixFile } = require('../recon-id-fix-io');
const { runReconIdFix } = require('../recon-id-fix-engine');
const { reconFixEvidenceSha256 } = require('./evidence-projection');
const {
  RECON_FIX_IMPORT_ACTION,
  RECON_FIX_READONLY_POLICIES,
  RECON_FIX_RUN_JPM_ACTION,
  RECON_FIX_RUN_READONLY_ACTION
} = require('./policies');
const {
  buildJpmWritebackPlan
} = require('./jpm-writeback-plan');
const {
  commitJpmAdmMutationWithReceipt
} = require('./jpm-writeback-transaction');
const {
  boundedJpmReceiptFromExact
} = require('./jpm-receipt-evidence');

const MAX_PERSISTENT_STATE_BYTES = 268435456;
const MEMORY_OVERHEAD_MULTIPLIER = 4;
const MAX_PHASE_EXTENSION_BYTES = Math.min(...RECON_FIX_READONLY_POLICIES.map(
  (policy) => policy.resources.phase.memoryBytes
));
const PHASE_EXTENSION_GRANULARITY_BYTES = 16 * 1024 * 1024;
const PHASE_FIXED_OVERHEAD_BYTES = 32 * 1024 * 1024;
const XLSX_FILE_BUFFER_MULTIPLIER = 2;
const XLSX_UNCOMPRESSED_MULTIPLIER = 8;
const GATEWAY_SECOND_READ_MULTIPLIER = 4;
const RUN_STATE_TRANSIENT_MULTIPLIER = 4;
const BOC_RAW_JSON_TRANSIENT_MULTIPLIER = 8;
const BOC_ROW_TRANSIENT_BYTES = 256;
const BOC_FX_TABLE = 'linked_boc_fx_settlement';

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

function checkedAdd(values, code = 'RECON_FIX_PHASE_ESTIMATE_OVERFLOW') {
  let total = 0;
  for (const value of values) {
    if (!Number.isSafeInteger(value) || value < 0 || !Number.isSafeInteger(total + value)) {
      fail(code, 'ReconFix 临时内存估算超出安全整数范围');
    }
    total += value;
  }
  return total;
}

function checkedMultiply(value, multiplier) {
  if (!Number.isSafeInteger(value) || value < 0 ||
      !Number.isSafeInteger(multiplier) || multiplier < 0 ||
      !Number.isSafeInteger(value * multiplier)) {
    fail('RECON_FIX_PHASE_ESTIMATE_OVERFLOW', 'ReconFix 临时内存估算超出安全整数范围');
  }
  return value * multiplier;
}

function assertPhaseExtensionFits(memoryBytes) {
  if (!Number.isSafeInteger(memoryBytes) || memoryBytes < 1) {
    fail('RECON_FIX_PHASE_ESTIMATE_INVALID', 'ReconFix 临时内存估算无效');
  }
  if (memoryBytes > MAX_PHASE_EXTENSION_BYTES) {
    fail(
      'RECON_FIX_PHASE_EXTENSION_LIMIT',
      `ReconFix 临时内存需要 ${memoryBytes} bytes，超过 phase-extension ${MAX_PHASE_EXTENSION_BYTES} bytes 上限`
    );
  }
  return memoryBytes;
}

function phaseExtensionReservationBytes(estimatedBytes) {
  if (!Number.isSafeInteger(estimatedBytes) || estimatedBytes < 1) {
    fail('RECON_FIX_PHASE_ESTIMATE_INVALID', 'ReconFix 临时内存估算无效');
  }
  const units = Math.ceil(estimatedBytes / PHASE_EXTENSION_GRANULARITY_BYTES);
  return assertPhaseExtensionFits(checkedMultiply(units, PHASE_EXTENSION_GRANULARITY_BYTES));
}

function fileIdentity(stat) {
  return Object.freeze({
    dev: stat.dev,
    ino: stat.ino,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    ctimeMs: stat.ctimeMs
  });
}

function sameFileIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size &&
    left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

function statInputFile(resolvedPath) {
  const stat = fs.statSync(resolvedPath);
  if (!stat.isFile()) fail('RECON_FIX_FILE_PATH_INVALID', 'import filePath 不是文件');
  if (!Number.isSafeInteger(stat.size) || stat.size < 1) {
    fail('RECON_FIX_FILE_PATH_INVALID', 'import 文件大小无效');
  }
  return stat;
}

function measureXlsxUncompressedBytes(resolvedPath) {
  return new Promise((resolve, reject) => {
    yauzl.open(resolvedPath, { lazyEntries: true, autoClose: true }, (openError, zip) => {
      if (openError) {
        reject(openError);
        return;
      }
      let total = 0;
      let entryCount = 0;
      let settled = false;
      const finishError = (error) => {
        if (settled) return;
        settled = true;
        try { zip.close(); } catch (_closeError) {}
        reject(error);
      };
      zip.on('entry', (entry) => {
        try {
          const size = Number(entry.uncompressedSize);
          if (!Number.isSafeInteger(size) || size < 0) {
            fail('RECON_FIX_XLSX_EVIDENCE_INVALID', 'xlsx 中央目录解压尺寸无效');
          }
          total = checkedAdd([total, size]);
          entryCount = checkedAdd([entryCount, 1]);
          zip.readEntry();
        } catch (error) {
          finishError(error);
        }
      });
      zip.on('end', () => {
        if (settled) return;
        settled = true;
        resolve(Object.freeze({ total, entryCount }));
      });
      zip.on('error', finishError);
      zip.readEntry();
    });
  });
}

function estimateImportPhaseBytes(fileBytes, uncompressedBytes, subMode) {
  const uncompressedMultiplier = XLSX_UNCOMPRESSED_MULTIPLIER +
    (subMode === 'gateway' ? GATEWAY_SECOND_READ_MULTIPLIER : 0);
  return phaseExtensionReservationBytes(checkedAdd([
    PHASE_FIXED_OVERHEAD_BYTES,
    checkedMultiply(fileBytes, XLSX_FILE_BUFFER_MULTIPLIER),
    checkedMultiply(uncompressedBytes, uncompressedMultiplier)
  ]));
}

function estimateRunPhaseBytes(currentStateBytes, bocEvidence = null) {
  const values = [
    PHASE_FIXED_OVERHEAD_BYTES,
    checkedMultiply(currentStateBytes, RUN_STATE_TRANSIENT_MULTIPLIER)
  ];
  if (bocEvidence) {
    values.push(checkedMultiply(bocEvidence.rawJsonBytes, BOC_RAW_JSON_TRANSIENT_MULTIPLIER));
    values.push(checkedMultiply(bocEvidence.rowCount, BOC_ROW_TRANSIENT_BYTES));
  }
  return phaseExtensionReservationBytes(checkedAdd(values));
}

async function prepareXlsxEvidence(resolvedPath, subMode) {
  const before = fileIdentity(statInputFile(resolvedPath));
  let measured;
  try {
    measured = await measureXlsxUncompressedBytes(resolvedPath);
  } catch (error) {
    if (error && error.code && error.code.startsWith('RECON_FIX_')) throw error;
    fail('RECON_FIX_XLSX_EVIDENCE_INVALID', '无法从 xlsx 中央目录取得临时内存证据');
  }
  const after = fileIdentity(statInputFile(resolvedPath));
  if (!sameFileIdentity(before, after)) {
    fail('RECON_FIX_INPUT_CHANGED', 'import 文件在资源预检期间发生变化');
  }
  return Object.freeze({
    fileIdentity: after,
    entryCount: measured.entryCount,
    uncompressedBytes: measured.total,
    phaseExtensionMemoryBytes: estimateImportPhaseBytes(after.size, measured.total, subMode)
  });
}

function assertXlsxEvidenceCurrent(resolvedPath, evidence) {
  const current = fileIdentity(statInputFile(resolvedPath));
  if (!sameFileIdentity(current, evidence.fileIdentity)) {
    fail('RECON_FIX_INPUT_CHANGED', 'import 文件在资源准入后发生变化');
  }
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

function buildScenarioSnapshot(scenario, actionKey = RECON_FIX_RUN_READONLY_ACTION) {
  if (!scenario || typeof scenario !== 'object' || Array.isArray(scenario)) {
    fail('RECON_FIX_SCENARIO_INVALID', 'scenario 必须是对象');
  }
  const category = scenario.category;
  if (!['recon-id-fix', 'gateway-recon-id-fix'].includes(category)) {
    fail('RECON_FIX_SCENARIO_INVALID', 'scenario.category 不是 ReconFix 类别');
  }
  const hasJpmTag = scenario.config &&
    scenario.config.subCategory === 'jpm-dispatch-order-fix';
  const isJpm = scenario.category === 'gateway-recon-id-fix' && hasJpmTag;
  if (hasJpmTag && actionKey !== RECON_FIX_RUN_JPM_ACTION) {
    fail('RECON_FIX_JPM_REQUIRES_E11_P0', 'JPM managed run 尚未交付，必须继续使用 legacy 路径');
  }
  if (actionKey === RECON_FIX_RUN_JPM_ACTION && !isJpm) {
    fail('RECON_FIX_JPM_SCENARIO_REQUIRED', 'run-jpm 只接受 JPM 调拨订单修复场景');
  }
  let owned;
  try {
    owned = structuredClone(scenario);
  } catch (_error) {
    fail('RECON_FIX_SCENARIO_INVALID', 'scenario 无法安全复制');
  }
  return Object.freeze({
    value: owned,
    hash: reconFixEvidenceSha256(owned, { maxBytes: 262144 })
  });
}

function prepareBocReadSnapshot(dbPath) {
  if (typeof dbPath !== 'string' || dbPath.length === 0 || !path.isAbsolute(dbPath)) {
    fail('RECON_FIX_BOC_DB_PATH_INVALID', 'BOC run 必须提供绝对只读数据库路径');
  }
  const resolved = path.resolve(dbPath);
  let db;
  let transactionOpen = false;
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    if (db) {
      if (transactionOpen) {
        try { db.exec('ROLLBACK'); } catch (_rollbackError) {}
        transactionOpen = false;
      }
      db.close();
    }
  };
  try {
    db = new DatabaseSync(resolved, { readOnly: true });
    db.exec('PRAGMA query_only = ON; BEGIN DEFERRED');
    transactionOpen = true;
    const aggregate = db.prepare(`
      SELECT COUNT(*) AS row_count,
             COALESCE(SUM(LENGTH(CAST(raw_json AS BLOB))), 0) AS raw_json_bytes
      FROM ${BOC_FX_TABLE}
    `).get();
    const rowCount = Number(aggregate && aggregate.row_count);
    const rawJsonBytes = Number(aggregate && aggregate.raw_json_bytes);
    if (!Number.isSafeInteger(rowCount) || rowCount < 0 ||
        !Number.isSafeInteger(rawJsonBytes) || rawJsonBytes < 0) {
      fail('RECON_FIX_BOC_EVIDENCE_INVALID', 'BOC 只读快照的行数或字节数无效');
    }
    let consumed = false;
    return Object.freeze({
      rowCount,
      rawJsonBytes,
      read() {
        if (closed || consumed) fail('RECON_FIX_BOC_EVIDENCE_STALE', 'BOC 只读快照已关闭或已消费');
        consumed = true;
        try {
          const rows = readBocFxLinkRows(db);
          return Object.freeze({ rows, hash: reconFixEvidenceSha256(rows) });
        } finally {
          close();
        }
      },
      close
    });
  } catch (error) {
    close();
    throw error;
  }
}

function prepareAdmReadSnapshot(dbPath) {
  const resolved = requireDatabasePath(dbPath, 'JPM databasePath');
  let db;
  let transactionOpen = false;
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    if (db) {
      if (transactionOpen) {
        try { db.exec('ROLLBACK'); } catch (_rollbackError) {}
        transactionOpen = false;
      }
      db.close();
    }
  };
  try {
    db = new DatabaseSync(resolved, { readOnly: true });
    db.exec('PRAGMA query_only = ON; BEGIN DEFERRED');
    transactionOpen = true;
    const aggregate = db.prepare(`
      SELECT COUNT(*) AS row_count,
             COALESCE(SUM(LENGTH(CAST(raw_json AS BLOB))), 0) AS raw_json_bytes
      FROM ${ADM_TABLE}
    `).get();
    const rowCount = Number(aggregate && aggregate.row_count);
    const rawJsonBytes = Number(aggregate && aggregate.raw_json_bytes);
    if (!Number.isSafeInteger(rowCount) || rowCount < 0 ||
        !Number.isSafeInteger(rawJsonBytes) || rawJsonBytes < 0) {
      fail('RECON_FIX_JPM_EVIDENCE_INVALID', 'JPM ADM 只读快照的行数或字节数无效');
    }
    let consumed = false;
    return Object.freeze({
      databasePath: resolved,
      rowCount,
      rawJsonBytes,
      read() {
        if (closed || consumed) fail('RECON_FIX_JPM_EVIDENCE_STALE', 'JPM ADM 只读快照已关闭或已消费');
        consumed = true;
        try {
          return readAdmRowsForWriteback(db);
        } finally {
          close();
        }
      },
      close
    });
  } catch (error) {
    close();
    throw error;
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

function createCandidateAtRevision(service, baseRevision, fields) {
  const state = {
    serviceGeneration: service.serviceGeneration,
    revision: baseRevision + 1,
    session: fields.session,
    result: fields.result
  };
  return Object.freeze({
    baseRevision,
    revision: state.revision,
    state,
    memoryBytes: assertPersistentStateFits(state)
  });
}

function createCandidate(service, fields) {
  return createCandidateAtRevision(service, service.revision, fields);
}

function requireDatabasePath(value, label) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || path.resolve(value) !== value) {
    fail('RECON_FIX_JPM_DB_PATH_INVALID', `${label} 必须是规范绝对路径`);
  }
  return value;
}

function jpmPendingKey(serviceGeneration, operationKey, resultHandle) {
  return canonicalSha256({ serviceGeneration, operationKey, resultHandle });
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
  let stateMemoryBytes = 1;
  let closed = false;
  let active = false;
  let activePreparation = null;
  // Full JPM candidate/plan/databasePath never leave this Service closure. The
  // Worker protocol only sees the opaque pendingKey plus bounded evidence.
  const pendingJpmResults = new Map();

  function assertOpen() {
    if (closed) fail('RECON_FIX_SERVICE_CLOSED', 'ReconFix Service 已关闭');
  }

  function createPreparation(memoryBytes, beginPrepared, cleanup = () => {}) {
    let consumed = false;
    let preparationClosed = false;
    const preparation = Object.freeze({
      resourcePlan: Object.freeze({
        requestKind: 'phase-extension',
        memoryBytes
      }),
      begin() {
        assertOpen();
        if (!active || activePreparation !== preparation || consumed || preparationClosed) {
          fail('RECON_FIX_PREPARATION_STALE', 'ReconFix 资源预检已消费或不再属于当前 command');
        }
        consumed = true;
        return beginPrepared();
      },
      close() {
        if (preparationClosed) return false;
        preparationClosed = true;
        cleanup();
        return true;
      }
    });
    activePreparation = preparation;
    return preparation;
  }

  async function prepare(actionKey, input, identity = {}) {
    assertOpen();
    if (active) fail('RECON_FIX_SERVICE_BUSY', 'ReconFix Service 同时只允许一个 command');
    if (![RECON_FIX_IMPORT_ACTION, RECON_FIX_RUN_READONLY_ACTION, RECON_FIX_RUN_JPM_ACTION]
      .includes(actionKey)) {
      fail('RECON_FIX_ACTION_UNSUPPORTED', `ReconFix Service 不支持 action：${String(actionKey)}`);
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
        const inputEvidence = await prepareXlsxEvidence(resolvedPath, subMode);
        return createPreparation(inputEvidence.phaseExtensionMemoryBytes, () => {
          assertXlsxEvidenceCurrent(resolvedPath, inputEvidence);
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
            inputEvidenceHash: reconFixEvidenceSha256({ subMode, sheets: imported.sheets })
          };
          return Object.freeze({
            kind: 'candidate',
            actionKey,
            candidate: createCandidate(serviceApi, { session, result: null })
          });
        });
      }

      if (actionKey === RECON_FIX_RUN_JPM_ACTION) {
        assertExactKeys(input, ['databasePath', 'expectedRevision', 'scenario'], 'JPM run input');
        assertExpectedRevision(input.expectedRevision, state.revision);
        if (!state.session) fail('RECON_FIX_SESSION_REQUIRED', '请先导入 ReconFix 文件');
        if (state.session.subMode !== 'gateway') {
          fail('RECON_FIX_SUB_MODE_MISMATCH', 'JPM run 只接受已导入的网关对账单');
        }
        const jpmSnapshot = prepareAdmReadSnapshot(input.databasePath);
        const databasePath = jpmSnapshot.databasePath;
        if (typeof identity.operationKey !== 'string' || !identity.operationKey) {
          fail('RECON_FIX_JPM_OPERATION_KEY_REQUIRED', 'JPM run 缺少 operationKey identity');
        }
        const snapshot = buildScenarioSnapshot(input.scenario, actionKey);
        if (snapshot.value.id === null || snapshot.value.id === undefined) {
          fail('RECON_FIX_JPM_SCENARIO_ID_REQUIRED', 'JPM scenario.id 不能为空');
        }
        const phaseExtensionMemoryBytes = estimateRunPhaseBytes(stateMemoryBytes, {
          rowCount: jpmSnapshot.rowCount,
          rawJsonBytes: jpmSnapshot.rawJsonBytes
        });
        return createPreparation(phaseExtensionMemoryBytes, () => {
          const source = jpmSnapshot.read();
          const clonedSheets = {
          reconResult: structuredClone(state.session.sheets.reconResult),
          businessBills: structuredClone(state.session.sheets.businessBills),
          opponentBills: structuredClone(state.session.sheets.opponentBills),
          fixTemplate: state.session.sheets.fixTemplate
        };
        const engineResult = runReconIdFix(snapshot.value, clonedSheets, {
          admRows: source.rows.map((row) => row.parsed)
        });
        const ownedResult = structuredClone(engineResult);
        const privateResult = {
          runKind: 'jpm',
          scenarioSnapshot: snapshot.value,
          scenarioSnapshotHash: snapshot.hash,
          linkedEvidenceHash: source.imageHash,
          inputEvidenceHash: state.session.inputEvidenceHash,
          fixedRows: ownedResult.fixedRows,
          warnings: ownedResult.warnings,
          unmatchedRows: ownedResult.unmatchedRows || [],
          stats: ownedResult.stats
        };
        const resultDigest = reconFixEvidenceSha256({
          fixedRows: privateResult.fixedRows,
          warnings: privateResult.warnings,
          unmatchedRows: privateResult.unmatchedRows,
          stats: privateResult.stats
        });
        const evidenceChanged = Boolean(state.result && (
          state.result.runKind !== 'jpm' ||
          state.result.scenarioSnapshotHash !== snapshot.hash ||
          state.result.linkedEvidenceHash !== source.imageHash
        ));
        privateResult.resultHandle = canonicalSha256({
          serviceGeneration: state.serviceGeneration,
          revision: state.revision + (evidenceChanged ? 2 : 1),
          operationKey: identity.operationKey,
          resultDigest,
          scenarioSnapshotHash: snapshot.hash,
          linkedEvidenceHash: source.imageHash
        });
        privateResult.summary = Object.freeze({
          runKind: 'jpm',
          fixedRowCount: privateResult.fixedRows.length,
          warningCount: privateResult.warnings.length,
          unmatchedRowCount: privateResult.unmatchedRows.length,
          resultDigest
        });
        const writebackPlan = buildJpmWritebackPlan({
          operationKey: identity.operationKey,
          sourceEvidence: source,
          admUpdates: engineResult.admUpdates,
          resultHandle: privateResult.resultHandle,
          boundedSummary: privateResult.summary
        });
        const invalidationCandidate = evidenceChanged
          ? createCandidate(serviceApi, { session: state.session, result: null })
          : null;
        const finalBaseRevision = state.revision + (invalidationCandidate ? 1 : 0);
        const candidate = createCandidateAtRevision(serviceApi, finalBaseRevision, {
          session: state.session,
          result: privateResult
        });
        const pendingKey = jpmPendingKey(
          state.serviceGeneration,
          identity.operationKey,
          privateResult.resultHandle
        );
        pendingJpmResults.set(pendingKey, {
          pendingKey,
          operationKey: identity.operationKey,
          databasePath,
          scenarioId: String(snapshot.value.id),
          resultHandle: privateResult.resultHandle,
          boundedSummary: privateResult.summary,
          writebackPlan,
          candidate,
          invalidationCandidate,
          invalidationAdopted: !invalidationCandidate,
          committedReceipt: null
        });
          return Object.freeze({
          kind: 'jpm-run-plan',
          pendingKey,
          operationKey: identity.operationKey,
          outcome: writebackPlan.outcome,
          resultHandle: privateResult.resultHandle,
          boundedSummary: privateResult.summary,
          candidateRevision: candidate.revision,
          candidateMemoryBytes: candidate.memoryBytes,
          invalidation: invalidationCandidate
            ? Object.freeze({
                candidateRevision: invalidationCandidate.revision,
                candidateMemoryBytes: invalidationCandidate.memoryBytes
              })
            : null,
          critical: Object.freeze({
            contractVersion: 1,
            scenarioId: String(snapshot.value.id),
            preImageHash: writebackPlan.preImageHash,
            postImageHash: writebackPlan.expectedPostImageHash,
            idSequenceDigest: writebackPlan.idSequenceDigest,
            rowCount: writebackPlan.rowCount,
            changedRowCount: writebackPlan.changedRowCount,
            resultHandle: writebackPlan.resultHandle,
            boundedSummary: writebackPlan.boundedSummary
          })
          });
        }, jpmSnapshot.close);
      }

      assertExactKeys(input, ['bocDatabasePath', 'expectedRevision', 'scenario'], 'run input');
      assertExpectedRevision(input.expectedRevision, state.revision);
      if (!state.session) fail('RECON_FIX_SESSION_REQUIRED', '请先导入 ReconFix 文件');
      const snapshot = buildScenarioSnapshot(input.scenario, actionKey);
      const expectedSubMode = snapshot.value.category === 'gateway-recon-id-fix' ? 'gateway' : 'business';
      if (expectedSubMode !== state.session.subMode) {
        fail('RECON_FIX_SUB_MODE_MISMATCH', '场景类别与已导入文件类别不一致');
      }
      const isBoc = snapshot.value.category === 'gateway-recon-id-fix' &&
        snapshot.value.config && snapshot.value.config.subCategory === 'boc-dispatch-order-fix';
      if (!isBoc && input.bocDatabasePath !== null) {
        fail('RECON_FIX_BOC_DB_PATH_UNEXPECTED', 'standard run 不得携带 BOC 数据库路径');
      }
      const bocSnapshot = isBoc ? prepareBocReadSnapshot(input.bocDatabasePath) : null;
      let phaseExtensionMemoryBytes;
      try {
        phaseExtensionMemoryBytes = estimateRunPhaseBytes(
          stateMemoryBytes,
          bocSnapshot && { rowCount: bocSnapshot.rowCount, rawJsonBytes: bocSnapshot.rawJsonBytes }
        );
      } catch (error) {
        if (bocSnapshot) bocSnapshot.close();
        throw error;
      }
      return createPreparation(phaseExtensionMemoryBytes, () => {
        const linked = bocSnapshot ? bocSnapshot.read() : null;
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
            const resultDigest = reconFixEvidenceSha256({
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
      }, () => {
        if (bocSnapshot) bocSnapshot.close();
      });
    } catch (error) {
      if (activePreparation) {
        try { activePreparation.close(); } catch (_cleanupError) {}
        activePreparation = null;
      }
      active = false;
      throw error;
    }
  }

  function requirePending(descriptor) {
    if (!descriptor || typeof descriptor.pendingKey !== 'string') {
      fail('RECON_FIX_JPM_PENDING_INVALID', 'JPM pending descriptor 非法');
    }
    const pending = pendingJpmResults.get(descriptor.pendingKey);
    if (!pending || pending.operationKey !== descriptor.operationKey ||
        pending.resultHandle !== descriptor.resultHandle) {
      fail('RECON_FIX_JPM_PENDING_STALE', 'JPM private pending candidate 不存在或已失效');
    }
    return pending;
  }

  function adoptJpmInvalidation(descriptor, nextReservationId) {
    const pending = requirePending(descriptor);
    if (!pending.invalidationCandidate || pending.invalidationAdopted) {
      fail('RECON_FIX_JPM_INVALIDATION_STATE_INVALID', 'JPM invalidation candidate 状态非法');
    }
    const result = adopt(pending.invalidationCandidate, nextReservationId);
    pending.invalidationAdopted = true;
    return result;
  }

  function commitJpmPending(descriptor, options = {}) {
    const pending = requirePending(descriptor);
    if (!pending.invalidationAdopted) {
      fail('RECON_FIX_JPM_INVALIDATION_REQUIRED', '旧结果尚未失效，不得进入 JPM critical mutation');
    }
    if (pending.writebackPlan.outcome !== 'mutation-required') {
      fail('RECON_FIX_JPM_NOOP_TRANSACTION_FORBIDDEN', 'JPM noop 不得进入 transaction');
    }
    if (pending.committedReceipt) {
      fail('RECON_FIX_JPM_MUTATION_REPLAY_FORBIDDEN', 'JPM pending mutation 不得重复提交');
    }
    let writeDb;
    try {
      writeDb = new DatabaseSync(pending.databasePath);
      const receipt = commitJpmAdmMutationWithReceipt({
        db: writeDb,
        plan: pending.writebackPlan,
        producerTaskRunId: options.producerTaskRunId,
        scenarioId: pending.scenarioId,
        ...(typeof options.injectFault === 'function' ? { injectFault: options.injectFault } : {})
      });
      pending.committedReceipt = boundedJpmReceiptFromExact(receipt);
      return pending.committedReceipt;
    } finally {
      if (writeDb) writeDb.close();
    }
  }

  function adoptJpmPending(descriptor, nextReservationId, boundedReceipt = null) {
    const pending = requirePending(descriptor);
    if (!pending.invalidationAdopted) {
      fail('RECON_FIX_JPM_INVALIDATION_REQUIRED', '旧结果尚未失效，不得采用 JPM result');
    }
    if (pending.writebackPlan.outcome === 'mutation-required') {
      if (!pending.committedReceipt || !boundedReceipt ||
          canonicalSha256(pending.committedReceipt) !== canonicalSha256(boundedReceipt)) {
        fail('RECON_FIX_JPM_RECEIPT_NOT_MATCHED', 'JPM result 只能在 exact receipt 返回后采用');
      }
    } else if (boundedReceipt !== null || pending.committedReceipt !== null) {
      fail('RECON_FIX_JPM_NOOP_RECEIPT_FORBIDDEN', 'JPM noop 不得携带 receipt');
    }
    adopt(pending.candidate, nextReservationId);
    pendingJpmResults.delete(pending.pendingKey);
    return Object.freeze({
      resultKind: pending.writebackPlan.outcome === 'noop' ? 'noop' : 'committed',
      resultHandle: pending.resultHandle,
      boundedSummary: pending.boundedSummary
    });
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
    stateMemoryBytes = candidate.memoryBytes;
    reservationId = nextReservationId;
    return publicResult(state);
  }

  function finish() {
    if (activePreparation) activePreparation.close();
    activePreparation = null;
    active = false;
    pendingJpmResults.clear();
  }

  function close() {
    const priorReservationId = reservationId;
    state = {
      serviceGeneration: options.serviceGeneration,
      revision: state.revision,
      session: null,
      result: null
    };
    stateMemoryBytes = 1;
    reservationId = null;
    if (activePreparation) activePreparation.close();
    activePreparation = null;
    active = false;
    closed = true;
    pendingJpmResults.clear();
    return priorReservationId;
  }

  const serviceApi = Object.freeze({
    get serviceGeneration() { return state.serviceGeneration; },
    get revision() { return state.revision; },
    get reservationId() { return reservationId; },
    get active() { return active; },
    prepare,
    adopt,
    adoptJpmInvalidation,
    adoptJpmPending,
    commitJpmPending,
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
  MAX_PHASE_EXTENSION_BYTES,
  MAX_PERSISTENT_STATE_BYTES,
  MEMORY_OVERHEAD_MULTIPLIER,
  ReconFixServiceError,
  createReconFixService,
  estimateImportPhaseBytes,
  estimatePersistentStateBytes
};
