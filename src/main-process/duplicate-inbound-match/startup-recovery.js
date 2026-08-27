'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { DatabaseSync } = require('node:sqlite');

const { canonicalSha256 } = require('../background-execution/canonical-json-v1');
const { normalizeRecoverySource } = require('../background-execution/recovery-source');

const DUPLICATE_STARTUP_ACTION = 'duplicate:run';
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

function createDuplicateStartupRecoveryProvider() {
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
  return Object.freeze({
    async listOpenSources() {
      return Object.freeze([source]);
    },
    async recover() {
      const error = new Error('Duplicate E07-A startup recovery禁止自动补偿或清理');
      error.code = 'DUPLICATE_STARTUP_RECOVERY_FORBIDDEN';
      throw error;
    }
  });
}

module.exports = {
  DUPLICATE_STARTUP_ACTION,
  DUPLICATE_STARTUP_CONFLICT_SCOPE_KEY,
  DUPLICATE_STARTUP_INSPECTOR_KEY,
  DUPLICATE_STARTUP_RECOVERY_KEY,
  createDuplicateStartupOutcomeInspector,
  createDuplicateStartupRecoveryProvider,
  inspectSideDatabases
};
