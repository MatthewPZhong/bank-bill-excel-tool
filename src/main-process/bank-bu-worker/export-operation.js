'use strict';

const fs = require('node:fs');
const crypto = require('node:crypto');
const path = require('node:path');
const { isDeepStrictEqual } = require('node:util');
const { DatabaseSync } = require('node:sqlite');

const runDataStore = require('../../backend/run-data-store');
const runData = require('../bank-bu-recon-run-data');
const { runReconciliation } = require('../bank-bu-recon-session');
const {
  writeDiffWorkbook,
  writeAggregateDiffWorkbook
} = require('../bank-bu-recon-writer');

function artifact(filePath, artifactKey) {
  const bytes = fs.readFileSync(filePath);
  return Object.freeze({
    artifactKey,
    stagingPath: path.resolve(filePath),
    byteSize: bytes.length,
    sha256: crypto.createHash('sha256').update(bytes).digest('hex')
  });
}

function resolveStaging(input) {
  if (!input || typeof input.userDataDir !== 'string' ||
      typeof input.mainDatabasePath !== 'string' || typeof input.stagingRoot !== 'string' ||
      typeof input.stagingPath !== 'string') {
    throw new TypeError('BankBU export缺少runtime/staging路径');
  }
  const root = path.resolve(input.stagingRoot);
  const target = path.resolve(input.stagingPath);
  const relative = path.relative(root, target);
  if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new TypeError('BankBU export stagingPath不属于task-private stagingRoot');
  }
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const realRoot = fs.realpathSync(root);
  const realParent = fs.realpathSync(path.dirname(target));
  const realRelative = path.relative(realRoot, realParent);
  if (realRelative === '..' || realRelative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(realRelative)) {
    throw new TypeError('BankBU export staging目录越界');
  }
  if (fs.existsSync(target) && fs.lstatSync(target).isSymbolicLink()) {
    throw new TypeError('BankBU export stagingPath不得为符号链接');
  }
  return target;
}

function cleanupStaging(filePath) {
  try { fs.rmSync(filePath, { force: true }); } catch (_error) { /* staging清理失败由上层Task保留路径审计 */ }
}

function managedSidePath(userDataDir, run) {
  const expectedRelPath = runDataStore.sideDbRelPath(
    runDataStore.MODULE_BANK_BU, run.year_month
  );
  if (!run.side_db_rel_path || run.side_db_rel_path !== expectedRelPath ||
      !Number.isSafeInteger(Number(run.side_run_id))) return null;
  return runDataStore.resolveFromRel(userDataDir, expectedRelPath);
}

function readManagedState(sideDb, run) {
  const dataset = sideDb.prepare(`
    SELECT year_month, dataset_hash, operation_key, producer_task_run_id
    FROM bank_bu_dataset_evidence WHERE year_month = ?
  `).get(run.year_month) || null;
  const sideRun = sideDb.prepare(`
    SELECT id, year_month, status, run_at, pending_total, bank_total, matched_count,
           bu_diff_count, pending_unmatched, bank_unmatched, anomaly_count,
           operation_key, producer_task_run_id, input_evidence_hash
    FROM bank_bu_recon_runs WHERE id = ?
  `).get(Number(run.side_run_id)) || null;
  const state = Object.freeze({ dataset, sideRun });
  const matches = Boolean(dataset && sideRun &&
    dataset.year_month === run.year_month &&
    dataset.dataset_hash === run.input_evidence_hash &&
    dataset.operation_key && dataset.producer_task_run_id &&
    sideRun.year_month === run.year_month &&
    Number(sideRun.id) === Number(run.side_run_id) &&
    sideRun.operation_key === run.operation_key &&
    sideRun.producer_task_run_id === run.producer_task_run_id &&
    sideRun.input_evidence_hash === run.input_evidence_hash);
  return Object.freeze({ matches, state });
}

function readManagedStateFresh(userDataDir, run) {
  const filePath = managedSidePath(userDataDir, run);
  if (!filePath) return Object.freeze({ matches: false, state: null });
  let sideDb = null;
  try {
    sideDb = new DatabaseSync(filePath, { readOnly: true });
    sideDb.exec('PRAGMA query_only = ON; PRAGMA busy_timeout = 30000;');
    return readManagedState(sideDb, run);
  } catch (_error) {
    return Object.freeze({ matches: false, state: null });
  } finally {
    if (sideDb) sideDb.close();
  }
}

function managedMirrorIsCurrent(userDataDir, run) {
  if (!run.operation_key) return true; // 历史dual-source镜像保持旧语义。
  return readManagedStateFresh(userDataDir, run).matches;
}

async function loadManagedSnapshot(userDataDir, run, onSnapshot) {
  const filePath = managedSidePath(userDataDir, run);
  if (!filePath) return Object.freeze({ matches: false, state: null, data: null });
  let sideDb = null;
  try {
    sideDb = new DatabaseSync(filePath, { readOnly: true });
    sideDb.exec('PRAGMA query_only = ON; PRAGMA busy_timeout = 30000; BEGIN DEFERRED;');
  } catch (_error) {
    if (sideDb) {
      try { if (sideDb.isTransaction) sideDb.exec('ROLLBACK'); } catch (_rollbackError) {}
      sideDb.close();
    }
    return Object.freeze({ matches: false, state: null, data: null });
  }
  try {
    let identity;
    try {
      identity = readManagedState(sideDb, run); // 首次read固定WAL snapshot。
    } catch (_error) {
      sideDb.exec('COMMIT');
      return Object.freeze({ matches: false, state: null, data: null });
    }
    if (!identity.matches) {
      sideDb.exec('COMMIT');
      return Object.freeze({ ...identity, data: null });
    }
    if (typeof onSnapshot === 'function') {
      await onSnapshot(Object.freeze({
        yearMonth: run.year_month,
        runId: Number(run.id),
        sideRunId: Number(run.side_run_id)
      }));
    }
    const result = runReconciliation(sideDb, run.year_month);
    const repeated = readManagedState(sideDb, run);
    if (!repeated.matches || !isDeepStrictEqual(repeated.state, identity.state)) {
      throw Object.assign(new Error('BankBU side read snapshot identity不稳定'), {
        code: 'BANK_BU_EXPORT_SNAPSHOT_INVALID'
      });
    }
    sideDb.exec('COMMIT');
    return Object.freeze({
      matches: true,
      state: identity.state,
      data: Object.freeze({
        yearMonth: run.year_month,
        matchedPending: result.matchedPending,
        matchedBank: result.matchedBank,
        buDiffPendingIds: result.buDiffPendingIds,
        buDiffBankIds: result.buDiffBankIds,
        nmAnomalies: result.nmAnomalies
      })
    });
  } catch (error) {
    try { if (sideDb && sideDb.isTransaction) sideDb.exec('ROLLBACK'); } catch (_rollbackError) {}
    throw error;
  } finally {
    if (sideDb) sideDb.close();
  }
}

function runIdentity(run) {
  if (!run) return null;
  return Object.freeze({
    id: Number(run.id),
    yearMonth: run.year_month,
    status: run.status,
    runAt: run.run_at || null,
    sideDbRelPath: run.side_db_rel_path || null,
    sideRunId: run.side_run_id == null ? null : Number(run.side_run_id),
    operationKey: run.operation_key || null,
    producerTaskRunId: run.producer_task_run_id || null,
    inputEvidenceHash: run.input_evidence_hash || null,
    stableHash: run.stable_hash || null,
    pendingTotal: Number(run.pending_total),
    bankTotal: Number(run.bank_total),
    matchedCount: Number(run.matched_count),
    buDiffCount: Number(run.bu_diff_count),
    pendingUnmatched: Number(run.pending_unmatched),
    bankUnmatched: Number(run.bank_unmatched),
    anomalyCount: Number(run.anomaly_count)
  });
}

function latestRuns(db) {
  return db.prepare(`
    SELECT id, year_month, run_at, status, pending_total, bank_total, matched_count,
           bu_diff_count, pending_unmatched, bank_unmatched, anomaly_count,
           side_db_rel_path, side_run_id, operation_key, producer_task_run_id,
           input_evidence_hash, stable_hash
    FROM bank_bu_recon_runs
    WHERE id IN (SELECT MAX(id) FROM bank_bu_recon_runs GROUP BY year_month)
    ORDER BY year_month ASC
  `).all();
}

function assertFreshExportIdentity(db, userDataDir, capturedRuns, managedStates) {
  const freshRuns = capturedRuns.length === 1
    ? [runData.getMirrorRun({ mainDb: db, runId: Number(capturedRuns[0].id) })]
    : latestRuns(db);
  if (!isDeepStrictEqual(freshRuns.map(runIdentity), capturedRuns.map(runIdentity))) {
    throw Object.assign(new Error('BankBU Main run selection在artifact生成期间变化'), {
      code: 'BANK_BU_EXPORT_SNAPSHOT_STALE'
    });
  }
  for (const captured of managedStates) {
    const fresh = readManagedStateFresh(userDataDir, captured.run);
    if (fresh.matches !== captured.matches ||
        !isDeepStrictEqual(fresh.state, captured.state)) {
      throw Object.assign(new Error('BankBU side dataset在artifact生成期间变化'), {
        code: 'BANK_BU_EXPORT_SNAPSHOT_STALE'
      });
    }
  }
}

async function executeExportSingle(input, context = {}) {
  const stagingPath = resolveStaging(input);
  const db = new DatabaseSync(input.mainDatabasePath, { readOnly: true });
  let run;
  let data;
  const managedStates = [];
  try {
    const runId = Number(input.runId);
    if (!Number.isSafeInteger(runId) || runId < 1) throw new TypeError('BankBU export runId非法');
    db.exec('PRAGMA query_only = ON; BEGIN DEFERRED;');
    try {
      run = runData.getMirrorRun({ mainDb: db, runId });
      if (!run || run.status !== 'success') throw new Error('BankBU运行记录不存在或未成功');
      if (run.operation_key) {
        const snapshot = await loadManagedSnapshot(
          input.userDataDir, run, context.onManagedSnapshot
        );
        if (!snapshot.matches) {
          const error = new Error('BankBU运行镜像与当前side dataset identity不一致');
          error.code = 'BANK_BU_EXPORT_MIRROR_STALE';
          throw error;
        }
        managedStates.push({ run, matches: true, state: snapshot.state });
        data = snapshot.data;
      } else {
        data = runData.loadExportDataByRun({
          userDataDir: input.userDataDir, mainDb: db, runId
        });
      }
      if (!data) throw new Error('BankBU导出数据不可用');
      db.exec('COMMIT');
      await writeDiffWorkbook({
        storageRoot: path.dirname(stagingPath),
        yearMonth: data.yearMonth,
        matchedPending: data.matchedPending,
        matchedBank: data.matchedBank,
        buDiffPendingIds: data.buDiffPendingIds,
        buDiffBankIds: data.buDiffBankIds,
        nmAnomalies: data.nmAnomalies,
        overrideSavePath: stagingPath
      });
      if (context.signal && context.signal.aborted) throw new Error('BankBU export已取消');
      const manifest = artifact(stagingPath, 'bank-bu-export-single');
      assertFreshExportIdentity(db, input.userDataDir, [run], managedStates);
      return Object.freeze({
        status: 'ok', operation: 'export-single', runId,
        yearMonth: data.yearMonth,
        artifacts: Object.freeze([manifest])
      });
    } catch (error) {
      try { if (db.isTransaction) db.exec('ROLLBACK'); } catch (_rollbackError) {}
      cleanupStaging(stagingPath);
      throw error;
    }
  } finally {
    db.close();
  }
}

async function executeExportAggregate(input, context = {}) {
  const stagingPath = resolveStaging(input);
  const db = new DatabaseSync(input.mainDatabasePath, { readOnly: true });
  const managedStates = [];
  try {
    db.exec('PRAGMA query_only = ON; BEGIN DEFERRED;');
    const latest = latestRuns(db);
    const months = [];
    const skippedMonths = [];
    for (const run of latest) {
      if (run.status !== 'success') {
        skippedMonths.push(run.year_month);
        continue;
      }
      let data;
      if (run.operation_key) {
        const snapshot = await loadManagedSnapshot(
          input.userDataDir,
          run,
          typeof context.onManagedSnapshot === 'function'
            ? (identity) => context.onManagedSnapshot(identity)
            : null
        );
        managedStates.push({ run, matches: snapshot.matches, state: snapshot.state });
        data = snapshot.matches ? snapshot.data : null;
      } else {
        data = runData.loadExportDataByRun({
          userDataDir: input.userDataDir, mainDb: db, runId: Number(run.id)
        });
      }
      if (!data) {
        skippedMonths.push(run.year_month);
        continue;
      }
      months.push({ ...data, yearMonth: run.year_month, runId: Number(run.id) });
    }
    if (months.length === 0) throw new Error('无可汇总的BankBU成功运行记录');
    try {
      db.exec('COMMIT');
      await writeAggregateDiffWorkbook({ matchedMonths: months, savePath: stagingPath });
      if (context.signal && context.signal.aborted) throw new Error('BankBU aggregate export已取消');
      const manifest = artifact(stagingPath, 'bank-bu-export-aggregate');
      assertFreshExportIdentity(db, input.userDataDir, latest, managedStates);
      return Object.freeze({
        status: 'ok', operation: 'export-aggregate',
        includedMonths: Object.freeze(months.map((month) => month.yearMonth)),
        skippedMonths: Object.freeze(skippedMonths.slice()),
        runIds: Object.freeze(months.map((month) => Number(month.runId))),
        artifacts: Object.freeze([manifest])
      });
    } catch (error) {
      try { if (db.isTransaction) db.exec('ROLLBACK'); } catch (_rollbackError) {}
      cleanupStaging(stagingPath);
      throw error;
    }
  } catch (error) {
    try { if (db.isTransaction) db.exec('ROLLBACK'); } catch (_rollbackError) {}
    cleanupStaging(stagingPath);
    throw error;
  } finally {
    db.close();
  }
}

module.exports = {
  executeExportAggregate,
  executeExportSingle,
  loadManagedSnapshot,
  managedMirrorIsCurrent
};
