'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const runRepo = require('../../../backend/acquiring-bill-currency-db/run-repository');
const runDataStore = require('../../../backend/run-data-store');
const acquiringRunData = require('../../acquiring-bill-currency-run-data');
const {
  sourceSnapshotFromStat,
  sourceSnapshotMatchesStat
} = require('../../archive-center/source-snapshot');
const { canonicalSha256 } = require('../../background-execution/canonical-json-v1');

const MODULE = runDataStore.MODULE_ACQUIRING;
const RUNS_TABLE = 'acquiring_bill_currency_runs';

function sourceError(code, message, cause = null) {
  const error = new Error(message);
  error.code = code;
  if (cause) error.cause = cause;
  return error;
}

function validMonthKey(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}$/.test(value)) {
    throw sourceError('ACQUIRING_EXPORT_SOURCE_INVALID', 'monthKey 格式必须为 YYYY-MM');
  }
  return value;
}

function singleLinkFileStat(filePath) {
  let stat;
  try {
    stat = fs.lstatSync(filePath, { bigint: true });
  } catch (cause) {
    throw sourceError('ACQUIRING_EXPORT_SOURCE_UNAVAILABLE', 'Acquiring 导出 source 不可读', cause);
  }
  if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1n) {
    throw sourceError(
      'ACQUIRING_EXPORT_SOURCE_INVALID',
      'Acquiring 导出 source 必须为普通单链接文件'
    );
  }
  return stat;
}

async function sha256FileStable(filePath) {
  const before = singleLinkFileStat(filePath);
  const hash = crypto.createHash('sha256');
  await new Promise((resolve, reject) => {
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.once('error', reject);
    stream.once('end', resolve);
  }).catch((cause) => {
    throw sourceError('ACQUIRING_EXPORT_SOURCE_UNAVAILABLE', 'Acquiring source hash 读取失败', cause);
  });
  const after = singleLinkFileStat(filePath);
  const beforeSnapshot = sourceSnapshotFromStat(before);
  if (!beforeSnapshot || !sourceSnapshotMatchesStat(beforeSnapshot, after)) {
    throw sourceError('ACQUIRING_EXPORT_SOURCE_STALE', 'Acquiring source 在 hash 期间发生变化');
  }
  return Object.freeze({
    byteSize: Number(after.size),
    sha256: hash.digest('hex'),
    sourceSnapshot: Object.freeze({ ...sourceSnapshotFromStat(after) })
  });
}

async function freezeAcquiringCopySource(options = {}) {
  const monthKey = validMonthKey(options.monthKey);
  const exportPlan = options.exportPlan || acquiringRunData.prepareRunExport({
    userDataDir: options.userDataDir,
    mainDb: options.mainDb,
    monthKey
  });
  const filePath = path.resolve(exportPlan.diffFilePath);
  const canonicalPath = path.resolve(fs.realpathSync(filePath));
  const file = await sha256FileStable(filePath);
  acquiringRunData.assertRunExportFresh({
    userDataDir: options.userDataDir,
    mainDb: options.mainDb,
    prepared: exportPlan
  });
  const runEvidenceDigest = canonicalSha256(exportPlan.evidence);
  const sourceIdentity = Object.freeze({
    contractVersion: 1,
    kind: 'copy-existing-diff',
    monthKey,
    runId: exportPlan.runId,
    runEvidenceDigest,
    sourceFileSha256: file.sha256,
    sourceFileSizeBytes: file.byteSize,
    sourceSnapshot: file.sourceSnapshot
  });
  const stableRunEvidence = Object.freeze({
    ...sourceIdentity,
    sourceDigest: canonicalSha256(sourceIdentity)
  });
  return Object.freeze({
    exportPlan,
    stableRunEvidence,
    dbPathOrManagedSource: Object.freeze({
      kind: 'managed-file',
      filePath,
      canonicalPath,
      byteSize: file.byteSize,
      contentSha256: file.sha256,
      sourceSnapshot: file.sourceSnapshot
    }),
    context: Object.freeze({
      kind: 'copy-existing-diff',
      monthKey,
      runId: exportPlan.runId
    })
  });
}

async function assertAcquiringCopySourceFresh(expected, options = {}) {
  const current = await freezeAcquiringCopySource({
    ...options,
    monthKey: expected.context.monthKey
  });
  if (canonicalSha256(current.stableRunEvidence) !==
        canonicalSha256(expected.stableRunEvidence) ||
      canonicalSha256(current.dbPathOrManagedSource) !==
        canonicalSha256(expected.dbPathOrManagedSource) ||
      canonicalSha256(current.context) !== canonicalSha256(expected.context)) {
    throw sourceError('ACQUIRING_EXPORT_SOURCE_STALE', 'Acquiring 既有差异文件已变化');
  }
  return current;
}

function sameRunResult(left, right) {
  return Boolean(left && right &&
    String(left.month_key || '') === String(right.month_key || '') &&
    Number(left.total_bill_rows) === Number(right.total_bill_rows) &&
    Number(left.matched_rows) === Number(right.matched_rows) &&
    Number(left.mismatch_rows) === Number(right.mismatch_rows) &&
    Number(left.unmatched_rows) === Number(right.unmatched_rows) &&
    String(left.status || '') === String(right.status || '') &&
    String(left.diff_file_path || '') === String(right.diff_file_path || '') &&
    String(left.report_file_path || '') === String(right.report_file_path || ''));
}

function resolveRegenerateRunAuthority(options = {}) {
  const monthKey = validMonthKey(options.monthKey);
  const mirror = runRepo.getLatestRun(options.mainDb, monthKey);
  if (!mirror) {
    throw sourceError('ACQUIRING_REGENERATE_RUN_MISSING', `月份 ${monthKey} 暂无 run 记录`);
  }
  let sourceKind = 'main';
  let databasePath = path.resolve(options.mainDatabasePath);
  let runId = Number(mirror.id);
  if (mirror.side_db_rel_path) {
    const expectedRelative = runDataStore.sideDbRelPath(MODULE, monthKey);
    if (mirror.side_db_rel_path !== expectedRelative) {
      throw sourceError('ACQUIRING_REGENERATE_SOURCE_MISMATCH', 'Acquiring 侧库镜像路径不一致');
    }
    sourceKind = 'side';
    databasePath = runDataStore.sideDbPath(options.userDataDir, MODULE, monthKey);
    if (!fs.existsSync(databasePath)) {
      throw sourceError('ACQUIRING_REGENERATE_SOURCE_MISSING', 'Acquiring 侧库文件不存在');
    }
    const sideDb = new DatabaseSync(databasePath, { readOnly: true });
    try {
      const candidates = sideDb.prepare(`
        SELECT * FROM ${RUNS_TABLE} WHERE month_key = ? ORDER BY id ASC
      `).all(monthKey).filter((candidate) => sameRunResult(candidate, mirror));
      if (candidates.length !== 1) {
        throw sourceError(
          'ACQUIRING_REGENERATE_SOURCE_AMBIGUOUS',
          'Acquiring 主镜像无法唯一对应侧库 run'
        );
      }
      runId = Number(candidates[0].id);
    } finally {
      sideDb.close();
    }
  }
  singleLinkFileStat(databasePath);
  return Object.freeze({
    monthKey,
    mirrorId: Number(mirror.id),
    runId,
    sourceKind,
    databasePath: path.resolve(databasePath),
    userDataDir: path.resolve(options.userDataDir)
  });
}

function updateHashRecord(hash, label, record) {
  const payload = JSON.stringify([label, record]);
  hash.update(String(Buffer.byteLength(payload)), 'utf8');
  hash.update(':', 'utf8');
  hash.update(payload, 'utf8');
  hash.update('\n', 'utf8');
}

function hashQuery(hash, db, label, sql, ...params) {
  let count = 0;
  for (const row of db.prepare(sql).iterate(...params)) {
    updateHashRecord(hash, label, row);
    count += 1;
  }
  updateHashRecord(hash, `${label}:count`, count);
  return count;
}

function readRegenerateEvidenceFromDb(db, authority) {
  const run = runRepo.getRunById(db, authority.runId);
  if (!run || run.month_key !== authority.monthKey || run.status !== 'success') {
    throw sourceError(
      'ACQUIRING_REGENERATE_RUN_NOT_STABLE',
      'Acquiring regenerate 只接受唯一 success run'
    );
  }
  const progress = runRepo.getRunChunkProgress(db, authority.runId);
  if (!progress || progress.status !== 'complete') {
    throw sourceError(
      'ACQUIRING_REGENERATE_RUN_NOT_COMPLETE',
      'Acquiring regenerate 拒绝 partial/in-progress/data-complete/unknown run'
    );
  }
  const runDigest = canonicalSha256(run);
  const progressDigest = canonicalSha256(progress);
  const hash = crypto.createHash('sha256');
  updateHashRecord(hash, 'authority', {
    sourceKind: authority.sourceKind,
    monthKey: authority.monthKey,
    runId: authority.runId,
    mirrorId: authority.mirrorId,
    runDigest,
    progressDigest
  });
  hashQuery(hash, db, 'run', `SELECT * FROM ${RUNS_TABLE} WHERE id = ?`, authority.runId);
  hashQuery(hash, db, 'flow', `
    SELECT * FROM acquiring_bill_currency_flow_imports
    WHERE month_key = ? ORDER BY id ASC
  `, authority.monthKey);
  hashQuery(hash, db, 'bill', `
    SELECT * FROM acquiring_bill_currency_bill_imports
    WHERE month_key = ? ORDER BY id ASC
  `, authority.monthKey);
  hashQuery(hash, db, 'diff', `
    SELECT * FROM acquiring_bill_currency_diff_rows
    WHERE run_id = ? ORDER BY id ASC
  `, authority.runId);
  return Object.freeze({
    contractVersion: 1,
    kind: 'regenerate-diff-workbook',
    sourceKind: authority.sourceKind,
    monthKey: authority.monthKey,
    runId: authority.runId,
    mirrorId: authority.mirrorId,
    runDigest,
    progressDigest,
    sourceDigest: hash.digest('hex')
  });
}

function freezeAcquiringRegenerateSource(options = {}) {
  const authority = resolveRegenerateRunAuthority(options);
  const db = new DatabaseSync(authority.databasePath, { readOnly: true });
  let stableRunEvidence;
  try {
    db.exec('BEGIN');
    stableRunEvidence = readRegenerateEvidenceFromDb(db, authority);
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch (_rollbackError) { /* preserve original */ }
    throw error;
  } finally {
    db.close();
  }
  return Object.freeze({
    stableRunEvidence,
    dbPathOrManagedSource: Object.freeze({
      kind: 'acquiring-run-sqlite',
      sourceKind: authority.sourceKind,
      databasePath: authority.databasePath,
      userDataDir: authority.userDataDir
    }),
    context: Object.freeze({
      kind: 'regenerate-diff-workbook',
      monthKey: authority.monthKey,
      runId: authority.runId
    })
  });
}

function assertAcquiringRegenerateSourceFresh(expected, options = {}) {
  const current = freezeAcquiringRegenerateSource({
    ...options,
    monthKey: expected.context.monthKey
  });
  if (canonicalSha256(current.stableRunEvidence) !==
        canonicalSha256(expected.stableRunEvidence) ||
      canonicalSha256(current.dbPathOrManagedSource) !==
        canonicalSha256(expected.dbPathOrManagedSource) ||
      canonicalSha256(current.context) !== canonicalSha256(expected.context)) {
    throw sourceError('ACQUIRING_EXPORT_SOURCE_STALE', 'Acquiring regenerate run 已变化');
  }
  return current;
}

module.exports = {
  assertAcquiringCopySourceFresh,
  assertAcquiringRegenerateSourceFresh,
  freezeAcquiringCopySource,
  freezeAcquiringRegenerateSource,
  readRegenerateEvidenceFromDb,
  resolveRegenerateRunAuthority,
  sha256FileStable,
  sourceError
};
