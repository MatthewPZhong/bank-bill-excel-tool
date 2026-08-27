'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { DatabaseSync } = require('node:sqlite');

const { canonicalSha256 } = require('../background-execution/canonical-json-v1');
const { normalizeRecoverySource } = require('../background-execution/recovery-source');
const mirrorRepository = require('../../backend/database/duplicate-inbound-match-run-repository');
const operationReceipts = require('./operation-receipt-repository');

const DUPLICATE_STARTUP_ACTION = 'duplicate:run';
const DUPLICATE_IMPORT_STARTUP_INSPECTOR_KEY = 'inspector.duplicate:import';
const DUPLICATE_STARTUP_INSPECTOR_KEY = 'inspector.duplicate:run';
const DUPLICATE_STARTUP_RECOVERY_KEY = 'startup-recovery.duplicate';
const DUPLICATE_STARTUP_CONFLICT_SCOPE_KEY = 'duplicate-inbound-match:startup';
const DUPLICATE_STARTUP_SOURCE_REF = 'module-recovery:duplicate-inbound-match:v1';
const DUPLICATE_STARTUP_OPERATION_KEY = 'duplicate-startup-recovery:v1';
const DUPLICATE_STARTUP_TASK_RUN_ID = 'duplicate-startup-recovery:v1';
const SIDE_DB_FAMILY_RE = /^month-(\d{4}-\d{2})\.sqlite(?:(-wal|-shm))?$/;

const SOURCE_EVIDENCE = Object.freeze({
  module: 'duplicate-inbound-match',
  policy: 'startup-residue-requires-hold-v1'
});

function makeInspection(source, outcome, boundedEvidence) {
  return Object.freeze({
    contractVersion: 1,
    sourceKind: source.sourceKind,
    sourceRef: source.sourceRef,
    actionKey: source.actionKey,
    operationKey: source.operationKey,
    taskRunId: source.taskRunId,
    outcome,
    evidenceVersion: 1,
    evidenceHash: canonicalSha256(boundedEvidence),
    boundedEvidence
  });
}

function tableNames(db) {
  return new Set(db.prepare(`
    SELECT name FROM sqlite_master WHERE type = 'table'
  `).all().map((row) => row.name));
}

function tablePresence(db, tables, tableName) {
  if (!tables.has(tableName)) return null;
  return Number(db.prepare(`SELECT EXISTS(SELECT 1 FROM ${tableName} LIMIT 1) AS present`).get().present);
}

function inspectSideDatabases(userDataDir) {
  const directory = path.join(userDataDir, 'run-data', 'duplicate-inbound-match');
  let entries;
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return Object.freeze({ count: 0, evidenceHash: canonicalSha256([]) });
    }
    throw error;
  }
  const families = new Map();
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const match = SIDE_DB_FAMILY_RE.exec(entry.name);
    if (!match) continue;
    const family = families.get(match[1]) || {
      monthKey: match[1],
      mainPresent: false,
      walPresent: false,
      shmPresent: false
    };
    if (match[2] === '-wal') family.walPresent = true;
    else if (match[2] === '-shm') family.shmPresent = true;
    else family.mainPresent = true;
    families.set(match[1], family);
  }
  const evidence = [];
  for (const family of families.values()) {
    if (!family.mainPresent) {
      evidence.push({
        ...family,
        importRowsPresent: null,
        runRowsPresent: null,
        receiptRowsPresent: null
      });
      continue;
    }
    const sidePath = path.join(directory, `month-${family.monthKey}.sqlite`);
    const immutableLocation = pathToFileURL(sidePath);
    immutableLocation.searchParams.set('immutable', '1');
    // 普通 readOnly 连接打开 WAL 库仍会创建 -wal/-shm；immutable URI 才能保证
    // Inspector 对原始恢复证据零写入。E07-A 只以文件存在判 residue，表计数仅作 bounded evidence。
    const db = new DatabaseSync(immutableLocation, { readOnly: true });
    try {
      db.exec('PRAGMA query_only = ON');
      const tables = tableNames(db);
      evidence.push({
        ...family,
        importRowsPresent: tablePresence(db, tables, 'duplicate_inbound_match_imports'),
        runRowsPresent: tablePresence(db, tables, 'duplicate_inbound_match_runs'),
        receiptRowsPresent: tablePresence(db, tables, 'duplicate_inbound_match_operation_receipts')
      });
    } finally {
      db.close();
    }
  }
  evidence.sort((left, right) => left.monthKey.localeCompare(right.monthKey));
  return Object.freeze({ count: evidence.length, evidenceHash: canonicalSha256(evidence) });
}

function rollbackQuietly(db) {
  try { db.exec('ROLLBACK'); } catch (_error) { /* 保留原始恢复错误 */ }
}

function stableHash(value) {
  return require('node:crypto').createHash('sha256')
    .update(JSON.stringify(value), 'utf8')
    .digest('hex');
}

function importEvidenceHash(bankFileHash, documentFileHash) {
  return stableHash({
    evidenceVersion: 1,
    bankFileHash: String(bankFileHash || ''),
    documentFileHash: String(documentFileHash || '')
  });
}

function runEvidenceHash(importId, bankFileHash, documentFileHash, snapshotHash) {
  return stableHash({
    evidenceVersion: 1,
    importBundleId: Number(importId),
    bankFileHash: String(bankFileHash || ''),
    documentFileHash: String(documentFileHash || ''),
    snapshotHash: String(snapshotHash || '')
  });
}

function withSideFamilySnapshot(sidePath, work) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'duplicate-recovery-snapshot-'));
  const target = path.join(tempDir, path.basename(sidePath));
  try {
    for (const suffix of ['', '-wal', '-shm']) {
      try {
        fs.copyFileSync(sidePath + suffix, target + suffix);
      } catch (error) {
        if (!error || error.code !== 'ENOENT') throw error;
      }
    }
    const db = new DatabaseSync(target, { readOnly: true });
    try {
      db.exec('PRAGMA query_only = ON; PRAGMA busy_timeout = 30000;');
      return work(db);
    } finally {
      db.close();
    }
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function sideOperationSnapshots(userDataDir) {
  const directory = path.join(userDataDir, 'run-data', 'duplicate-inbound-match');
  let entries;
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch (error) {
    if (error && error.code === 'ENOENT') return { operations: [], legacyResidue: false };
    throw error;
  }
  const operations = [];
  let legacyResidue = false;
  const families = new Map();
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const match = SIDE_DB_FAMILY_RE.exec(entry.name);
    if (!match) continue;
    const family = families.get(match[1]) || { mainPresent: false };
    if (!match[2]) family.mainPresent = true;
    families.set(match[1], family);
  }
  if ([...families.values()].some((family) => !family.mainPresent)) legacyResidue = true;
  for (const entry of entries) {
    const match = entry.isFile() && /^month-(\d{4}-\d{2})\.sqlite$/.exec(entry.name);
    if (!match) continue;
    const sidePath = path.join(directory, entry.name);
    withSideFamilySnapshot(sidePath, (db) => {
      const tables = tableNames(db);
      const receipts = tables.has(operationReceipts.RECEIPTS_TABLE)
        ? operationReceipts.listOperationReceipts(db)
        : [];
      const importIds = tables.has('duplicate_inbound_match_imports')
        ? db.prepare('SELECT id FROM duplicate_inbound_match_imports ORDER BY id').all()
          .map((row) => Number(row.id))
        : [];
      const runIds = tables.has('duplicate_inbound_match_runs')
        ? db.prepare('SELECT id FROM duplicate_inbound_match_runs ORDER BY id').all()
          .map((row) => Number(row.id))
        : [];
      const ownedImports = new Set(receipts.filter((item) => item.actionKey === 'duplicate:import')
        .map((item) => item.importBundleId));
      const ownedRuns = new Set(receipts.filter((item) => item.actionKey === 'duplicate:run')
        .map((item) => item.sideRunId));
      if (importIds.some((id) => !ownedImports.has(id)) || runIds.some((id) => !ownedRuns.has(id))) {
        legacyResidue = true;
      }
      for (const receipt of receipts) {
        const importedRow = tables.has('duplicate_inbound_match_imports')
          ? db.prepare('SELECT * FROM duplicate_inbound_match_imports WHERE id = ?')
            .get(receipt.importBundleId)
          : null;
        const runRow = receipt.sideRunId != null && tables.has('duplicate_inbound_match_runs')
          ? db.prepare('SELECT * FROM duplicate_inbound_match_runs WHERE id = ?').get(receipt.sideRunId)
          : null;
        let resultCounts = null;
        if (runRow) {
          resultCounts = {
            mailRowCount: Number(db.prepare(
              'SELECT COUNT(*) AS count FROM duplicate_inbound_match_mail_rows WHERE run_id = ?'
            ).get(receipt.sideRunId).count),
            manualRowCount: Number(db.prepare(
              'SELECT COUNT(*) AS count FROM duplicate_inbound_match_manual_rows WHERE run_id = ?'
            ).get(receipt.sideRunId).count),
            auditGroupCount: Number(db.prepare(
              'SELECT COUNT(*) AS count FROM duplicate_inbound_match_group_audits WHERE run_id = ?'
            ).get(receipt.sideRunId).count)
          };
        }
        operations.push({
          receipt,
          monthKey: match[1],
          imported: importedRow ? {
            id: Number(importedRow.id),
            bankFileName: importedRow.bank_file_name,
            bankFileHash: importedRow.bank_content_hash,
            bankRowCount: Number(importedRow.bank_row_count),
            bankStoredRowCount: Number(db.prepare(
              'SELECT COUNT(*) AS count FROM duplicate_inbound_match_bank_rows WHERE import_id = ?'
            ).get(receipt.importBundleId).count),
            documentFileName: importedRow.document_file_name,
            documentFileHash: importedRow.document_content_hash,
            documentRowCount: Number(importedRow.document_row_count),
            documentStoredRowCount: Number(db.prepare(
              'SELECT COUNT(*) AS count FROM duplicate_inbound_match_document_rows WHERE import_id = ?'
            ).get(receipt.importBundleId).count)
          } : null,
          run: runRow ? {
            id: Number(runRow.id),
            importId: Number(runRow.import_id),
            snapshotHash: runRow.snapshot_hash,
            status: runRow.status,
            summary: JSON.parse(runRow.summary_json),
            resultCounts
          } : null
        });
      }
    });
  }
  operations.sort((left, right) => left.receipt.actionKey.localeCompare(right.receipt.actionKey)
    || left.receipt.operationKey.localeCompare(right.receipt.operationKey));
  return { operations, legacyResidue };
}

function operationSource(identity) {
  const sourceRef = `module-recovery:duplicate-inbound-match:operation:v1:${canonicalSha256([
    identity.actionKey, identity.operationKey, identity.producerTaskRunId
  ])}`;
  return Object.freeze({
    contractVersion: 1,
    sourceKind: 'module-recovery',
    sourceRef,
    actionKey: identity.actionKey,
    operationKey: identity.operationKey,
    taskRunId: identity.producerTaskRunId,
    conflictScopeKey: DUPLICATE_STARTUP_CONFLICT_SCOPE_KEY,
    inspectorKey: identity.actionKey === 'duplicate:import'
      ? DUPLICATE_IMPORT_STARTUP_INSPECTOR_KEY
      : DUPLICATE_STARTUP_INSPECTOR_KEY,
    settlementKey: DUPLICATE_STARTUP_RECOVERY_KEY,
    intentId: null,
    evidenceVersion: 1,
    boundedEvidence: {
      module: 'duplicate-inbound-match',
      policy: 'operation-recovery-v1'
    }
  });
}

function sidePostImageHash(item, actionKey) {
  return canonicalSha256({
    actionKey,
    receipt: {
      actionKey: item.receipt.actionKey,
      operationKey: item.receipt.operationKey,
      producerTaskRunId: item.receipt.producerTaskRunId,
      phase: item.receipt.phase,
      monthKey: item.receipt.monthKey,
      importBundleId: item.receipt.importBundleId,
      sideRunId: item.receipt.sideRunId,
      inputEvidenceHash: item.receipt.inputEvidenceHash
    },
    monthKey: item.monthKey,
    imported: item.imported,
    run: actionKey === 'duplicate:run' ? item.run : null
  });
}

function mirrorPostImageHash(mirror) {
  return canonicalSha256({
    id: mirror.id,
    monthKey: mirror.monthKey,
    sideRunId: mirror.sideRunId,
    status: mirror.status,
    summary: mirror.summary,
    snapshotHash: mirror.snapshotHash,
    bankFileName: mirror.bankFileName,
    bankFileHash: mirror.bankFileHash,
    documentFileName: mirror.documentFileName,
    documentFileHash: mirror.documentFileHash,
    sideDbRelPath: mirror.sideDbRelPath,
    operationKey: mirror.operationKey,
    producerTaskRunId: mirror.producerTaskRunId,
    inputEvidenceHash: mirror.inputEvidenceHash
  });
}

function exactOperationInspection(options, source) {
  const side = sideOperationSnapshots(path.resolve(options.userDataDir));
  const matches = side.operations.filter((item) =>
    item.receipt.actionKey === source.actionKey &&
    item.receipt.operationKey === source.operationKey
  );
  const mirrors = source.actionKey === 'duplicate:run'
    ? options.listRunMirrors().filter((mirror) => mirror.operationKey === source.operationKey)
    : [];
  const audit = typeof options.getRecoveryAuditBySource === 'function'
    ? options.getRecoveryAuditBySource(source.sourceRef)
    : null;
  const matchingCompensationAudit = audit && audit.actionKey === source.actionKey &&
    audit.operationKey === source.operationKey && audit.producerTaskRunId === source.taskRunId &&
    audit.outcome === 'compensated';
  if (matches.length === 0) {
    if (matchingCompensationAudit && mirrors.length === 0) {
      return makeInspection(source, 'compensated', {
        disposition: 'durable-compensation-or-expiration-audit',
        recoveryAction: audit.recoveryAction,
        auditResultHash: audit.resultHash
      });
    }
    return makeInspection(source, mirrors.length === 0 ? 'not-committed' : 'unknown', {
      disposition: mirrors.length === 0 ? 'side-and-mirror-absent' : 'mirror-without-side-receipt',
      receiptCount: 0,
      mirrorCount: mirrors.length
    });
  }
  if (matchingCompensationAudit) {
    return makeInspection(source, 'unknown', {
      disposition: 'compensation-audit-with-live-side-residue',
      receiptCount: matches.length,
      mirrorCount: mirrors.length,
      auditResultHash: audit.resultHash
    });
  }
  const item = matches[0];
  const receipt = item.receipt;
  const ownerConflict = matches.length !== 1 || receipt.producerTaskRunId !== source.taskRunId ||
    receipt.monthKey !== item.monthKey;
  let sideValid = !ownerConflict && item.imported && item.imported.id === receipt.importBundleId &&
    item.imported.bankRowCount === item.imported.bankStoredRowCount &&
    item.imported.documentRowCount === item.imported.documentStoredRowCount;
  let expectedEvidenceHash = null;
  if (sideValid && source.actionKey === 'duplicate:import') {
    expectedEvidenceHash = importEvidenceHash(
      item.imported.bankFileHash, item.imported.documentFileHash
    );
  } else if (sideValid && source.actionKey === 'duplicate:run') {
    sideValid = Boolean(item.run && item.run.id === receipt.sideRunId &&
      item.run.importId === receipt.importBundleId && item.run.status === 'success');
    if (sideValid) {
      expectedEvidenceHash = runEvidenceHash(
        item.imported.id,
        item.imported.bankFileHash,
        item.imported.documentFileHash,
        item.run.snapshotHash
      );
      const summary = item.run.summary || {};
      sideValid = item.run.resultCounts.mailRowCount === Number(summary.mailRowCount) &&
        item.run.resultCounts.manualRowCount === Number(summary.manualRowCount) &&
        item.run.resultCounts.auditGroupCount === Number(summary.auditGroupCount);
    }
  }
  sideValid = sideValid && expectedEvidenceHash === receipt.inputEvidenceHash;
  if (!sideValid) {
    return makeInspection(source, 'unknown', {
      disposition: 'side-receipt-or-result-identity-conflict',
      receiptCount: matches.length,
      mirrorCount: mirrors.length,
      sideRunId: receipt.sideRunId
    });
  }
  if (source.actionKey === 'duplicate:import') {
    return makeInspection(source, mirrors.length === 0 ? 'committed' : 'unknown', {
      disposition: mirrors.length === 0 ? 'import-side-receipt-committed' : 'import-has-unexpected-mirror',
      importBundleId: receipt.importBundleId,
      inputEvidenceHash: receipt.inputEvidenceHash,
      sidePostImageHash: sidePostImageHash(item, source.actionKey),
      mirrorCount: mirrors.length
    });
  }
  if (mirrors.length === 0) {
    return makeInspection(source, 'partially-committed', {
      disposition: 'run-side-committed-mirror-absent',
      importBundleId: receipt.importBundleId,
      sideRunId: receipt.sideRunId,
      inputEvidenceHash: receipt.inputEvidenceHash,
      sidePostImageHash: sidePostImageHash(item, source.actionKey)
    });
  }
  const mirror = mirrors[0];
  const mirrorMatches = mirrors.length === 1 && mirror.status === 'success' &&
    mirror.producerTaskRunId === source.taskRunId && mirror.sideRunId === receipt.sideRunId &&
    mirror.monthKey === receipt.monthKey && mirror.inputEvidenceHash === receipt.inputEvidenceHash &&
    mirror.snapshotHash === item.run.snapshotHash &&
    mirror.bankFileName === item.imported.bankFileName &&
    mirror.bankFileHash === item.imported.bankFileHash &&
    mirror.documentFileName === item.imported.documentFileName &&
    mirror.documentFileHash === item.imported.documentFileHash &&
    mirror.sideDbRelPath === path.posix.join(
      'run-data', 'duplicate-inbound-match', `month-${receipt.monthKey}.sqlite`
    ) && canonicalSha256(mirror.summary) === canonicalSha256(item.run.summary);
  return makeInspection(source, mirrorMatches ? 'committed' : 'unknown', {
    disposition: mirrorMatches ? 'side-and-main-identity-committed' : 'side-main-identity-conflict',
    importBundleId: receipt.importBundleId,
    sideRunId: receipt.sideRunId,
    mirrorId: Number(mirror.id),
    inputEvidenceHash: receipt.inputEvidenceHash,
    sidePostImageHash: sidePostImageHash(item, source.actionKey),
    mirrorPostImageHash: mirrorPostImageHash(mirror)
  });
}

function mirrorEvidence(listRunMirrors) {
  const mirrors = listRunMirrors().map((mirror) => ({
    id: Number(mirror.id),
    monthKey: String(mirror.monthKey || ''),
    sideRunId: Number(mirror.sideRunId),
    status: String(mirror.status || '')
  })).sort((left, right) => left.id - right.id);
  return Object.freeze({ count: mirrors.length, evidenceHash: canonicalSha256(mirrors) });
}

function createDuplicateStartupOutcomeInspector(options = {}) {
  if (typeof options.userDataDir !== 'string' || options.userDataDir.length === 0) {
    throw new TypeError('Duplicate startup Inspector需要userDataDir');
  }
  if (typeof options.listRunMirrors !== 'function') {
    throw new TypeError('Duplicate startup Inspector需要只读listRunMirrors');
  }
  const userDataDir = path.resolve(options.userDataDir);
  return async function inspectDuplicateStartup(rawSource) {
    const source = normalizeRecoverySource(rawSource);
    const legacyModuleSource = source.sourceKind === 'module-recovery' &&
      source.sourceRef === DUPLICATE_STARTUP_SOURCE_REF;
    if (!legacyModuleSource && ['duplicate:import', 'duplicate:run'].includes(source.actionKey)) {
      return exactOperationInspection({ ...options, userDataDir }, source);
    }
    const side = inspectSideDatabases(userDataDir);
    const mirrors = mirrorEvidence(options.listRunMirrors);
    const hasResidue = side.count > 0 || mirrors.count > 0;
    return makeInspection(source, hasResidue ? 'unknown' : 'not-committed', {
      disposition: hasResidue ? 'persistent-residue-requires-hold' : 'no-persistent-residue',
      sideDbCount: side.count,
      sideEvidenceHash: side.evidenceHash,
      mirrorCount: mirrors.count,
      mirrorEvidenceHash: mirrors.evidenceHash
    });
  };
}

function settlementResult(source, inspection, outcome, boundedResult, safeError = null) {
  return Object.freeze({
    contractVersion: 1,
    sourceKind: source.sourceKind,
    sourceRef: source.sourceRef,
    actionKey: source.actionKey,
    operationKey: source.operationKey,
    taskRunId: source.taskRunId,
    settlementKey: source.settlementKey,
    inspectionEvidenceHash: inspection.evidenceHash,
    outcome,
    resultVersion: 1,
    resultHash: canonicalSha256(boundedResult),
    boundedResult,
    safeError,
    retryAfterMs: null
  });
}

function createDuplicateStartupRecoveryProvider(options = {}) {
  const source = Object.freeze({
    contractVersion: 1,
    sourceKind: 'module-recovery',
    sourceRef: DUPLICATE_STARTUP_SOURCE_REF,
    actionKey: DUPLICATE_STARTUP_ACTION,
    operationKey: DUPLICATE_STARTUP_OPERATION_KEY,
    taskRunId: DUPLICATE_STARTUP_TASK_RUN_ID,
    conflictScopeKey: DUPLICATE_STARTUP_CONFLICT_SCOPE_KEY,
    inspectorKey: DUPLICATE_STARTUP_INSPECTOR_KEY,
    settlementKey: DUPLICATE_STARTUP_RECOVERY_KEY,
    intentId: null,
    evidenceVersion: 1,
    boundedEvidence: SOURCE_EVIDENCE
  });
  const exactMode = options.mainDatabase && typeof options.listRunMirrors === 'function' &&
    typeof options.getRecoveryAuditByOperation === 'function' &&
    typeof options.inspectOperation === 'function' && typeof options.userDataDir === 'string';
  return Object.freeze({
    async listOpenSources() {
      if (exactMode) {
        const side = sideOperationSnapshots(path.resolve(options.userDataDir));
        const mirrors = options.listRunMirrors();
        const identities = new Map();
        for (const item of side.operations) {
          const receipt = item.receipt;
          identities.set(`${receipt.actionKey}\0${receipt.operationKey}`, {
            actionKey: receipt.actionKey,
            operationKey: receipt.operationKey,
            producerTaskRunId: receipt.producerTaskRunId
          });
        }
        let legacyResidue = side.legacyResidue;
        for (const mirror of mirrors) {
          if (!mirror.operationKey || !mirror.producerTaskRunId) {
            legacyResidue = true;
            continue;
          }
          const key = `duplicate:run\0${mirror.operationKey}`;
          const current = identities.get(key);
          if (current && current.producerTaskRunId !== mirror.producerTaskRunId) {
            // 保留side owner，由Inspector输出identity conflict。
            continue;
          }
          identities.set(key, {
            actionKey: 'duplicate:run',
            operationKey: mirror.operationKey,
            producerTaskRunId: mirror.producerTaskRunId
          });
        }
        const sources = [];
        for (const identity of identities.values()) {
          if (!options.getRecoveryAuditByOperation(
            identity.actionKey, identity.operationKey, identity.producerTaskRunId
          )) {
            sources.push(operationSource(identity));
          }
        }
        if (legacyResidue || sources.length === 0 && identities.size === 0) sources.push(source);
        return Object.freeze(sources);
      }
      return Object.freeze([source]);
    },
    async recover(rawSource, inspection) {
      const normalizedSource = normalizeRecoverySource(rawSource);
      if (!exactMode || normalizedSource.boundedEvidence.policy !== 'operation-recovery-v1') {
        const error = new Error('Duplicate legacy startup recovery禁止自动补偿或清理');
        error.code = 'DUPLICATE_STARTUP_RECOVERY_FORBIDDEN';
        throw error;
      }
      const persistedAudit = mirrorRepository.getRecoveryAuditBySource(
        options.mainDatabase, normalizedSource.sourceRef
      );
      if (persistedAudit) {
        if (persistedAudit.actionKey !== normalizedSource.actionKey ||
            persistedAudit.operationKey !== normalizedSource.operationKey ||
            persistedAudit.producerTaskRunId !== normalizedSource.taskRunId ||
            persistedAudit.inspectionEvidenceHash !== inspection.evidenceHash ||
            persistedAudit.outcome !== 'committed') {
          return settlementResult(normalizedSource, inspection, 'terminal-failure', {
            disposition: 'persisted-recovery-audit-conflict'
          }, { code: 'DUPLICATE_RECOVERY_AUDIT_CONFLICT', message: '持久恢复审计身份冲突' });
        }
        return settlementResult(
          normalizedSource, inspection, 'completed', persistedAudit.boundedResult
        );
      }
      const current = await options.inspectOperation(normalizedSource);
      if (!['committed', 'partially-committed'].includes(current.outcome) ||
          current.outcome !== inspection.outcome || current.evidenceHash !== inspection.evidenceHash) {
        return settlementResult(normalizedSource, inspection, 'terminal-failure', {
          disposition: 'inspection-changed-before-recovery'
        }, { code: 'DUPLICATE_RECOVERY_EVIDENCE_CHANGED', message: '恢复前Duplicate证据已变化' });
      }
      const side = sideOperationSnapshots(path.resolve(options.userDataDir));
      const item = side.operations.find((candidate) =>
        candidate.receipt.actionKey === normalizedSource.actionKey &&
        candidate.receipt.operationKey === normalizedSource.operationKey &&
        candidate.receipt.producerTaskRunId === normalizedSource.taskRunId
      );
      if (!item || !item.imported || normalizedSource.actionKey === 'duplicate:run' && !item.run) {
        return settlementResult(normalizedSource, inspection, 'terminal-failure', {
          disposition: 'committed-side-result-unavailable'
        }, { code: 'DUPLICATE_COMMITTED_SIDE_UNAVAILABLE', message: '已提交side结果不可用' });
      }
      if (current.boundedEvidence.sidePostImageHash !==
          sidePostImageHash(item, normalizedSource.actionKey)) {
        return settlementResult(normalizedSource, inspection, 'terminal-failure', {
          disposition: 'committed-side-post-image-changed'
        }, { code: 'DUPLICATE_COMMITTED_SIDE_CHANGED', message: '已提交side结果在恢复前发生变化' });
      }
      const recoveryAction = inspection.outcome === 'partially-committed'
        ? 'complete-mirror'
        : 'observe-committed';
      let mirror = normalizedSource.actionKey === 'duplicate:run'
        ? options.listRunMirrors().find((candidate) =>
          candidate.operationKey === normalizedSource.operationKey
        ) || null
        : null;
      const db = options.mainDatabase;
      db.exec('BEGIN IMMEDIATE');
      try {
        if (recoveryAction === 'complete-mirror') {
          const completed = mirrorRepository.createCommittedRunMirror(db, {
            monthKey: item.receipt.monthKey,
            sideRunId: item.receipt.sideRunId,
            snapshotHash: item.run.snapshotHash,
            bankFileName: item.imported.bankFileName,
            bankFileHash: item.imported.bankFileHash,
            documentFileName: item.imported.documentFileName,
            documentFileHash: item.imported.documentFileHash,
            sideDbRelPath: path.posix.join(
              'run-data', 'duplicate-inbound-match', `month-${item.receipt.monthKey}.sqlite`
            ),
            summary: item.run.summary,
            operationKey: item.receipt.operationKey,
            producerTaskRunId: item.receipt.producerTaskRunId,
            inputEvidenceHash: item.receipt.inputEvidenceHash
          });
          mirror = completed.mirror;
          if (typeof options.afterMirrorCas === 'function') options.afterMirrorCas(mirror);
        }
        const boundedResult = {
          disposition: recoveryAction === 'complete-mirror'
            ? 'committed-side-mirror-completed'
            : 'committed-evidence-observed',
          recoveryAction,
          sideRunId: item.receipt.sideRunId,
          mirrorId: mirror ? mirror.id : null
        };
        const resultHash = canonicalSha256(boundedResult);
        mirrorRepository.insertRecoveryAudit(db, {
          sourceRef: normalizedSource.sourceRef,
          actionKey: normalizedSource.actionKey,
          operationKey: normalizedSource.operationKey,
          producerTaskRunId: normalizedSource.taskRunId,
          inspectionEvidenceHash: inspection.evidenceHash,
          outcome: 'committed',
          recoveryAction,
          sideRunId: item.receipt.sideRunId,
          mirrorId: mirror ? mirror.id : null,
          boundedResult,
          resultHash
        });
        if (typeof options.beforeRecoveryCommit === 'function') options.beforeRecoveryCommit();
        db.exec('COMMIT');
        return settlementResult(normalizedSource, inspection, 'completed', boundedResult);
      } catch (error) {
        rollbackQuietly(db);
        throw error;
      }
    }
  });
}

module.exports = {
  DUPLICATE_STARTUP_ACTION,
  DUPLICATE_STARTUP_CONFLICT_SCOPE_KEY,
  DUPLICATE_IMPORT_STARTUP_INSPECTOR_KEY,
  DUPLICATE_STARTUP_INSPECTOR_KEY,
  DUPLICATE_STARTUP_RECOVERY_KEY,
  createDuplicateStartupOutcomeInspector,
  createDuplicateStartupRecoveryProvider,
  exactOperationInspection,
  inspectSideDatabases,
  operationSource,
  sideOperationSnapshots
};
