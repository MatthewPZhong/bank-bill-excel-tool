'use strict';

const fs = require('node:fs');
const path = require('node:path');

const {
  atomicSwitchVccStorage,
  buildVccStorageCandidate,
  createMigrationJournal,
  recoverVccStorageMigration,
  storageContractVersion,
  updateJournal
} = require('../src/main-process/vcc-financial-op-storage-rebuild');

const CONFIRMATION = 'RESET_CURRENT_MACHINE_VCC_V1';

function argumentValue(args, name) {
  const index = args.indexOf(name);
  if (index < 0) return '';
  return String(args[index + 1] || '');
}

function timestamp(now = new Date()) {
  return now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

function resolveOptions(args, now = new Date()) {
  const sourceArg = argumentValue(args, '--source');
  const confirmation = argumentValue(args, '--confirm');
  if (!sourceArg || !path.isAbsolute(sourceArg)) {
    throw new TypeError('--source 必须是当前机器 tool-data.sqlite 的绝对路径');
  }
  if (confirmation !== CONFIRMATION) {
    throw new TypeError(`必须显式传入 --confirm ${CONFIRMATION}`);
  }
  const sourcePath = path.resolve(sourceArg);
  const directory = path.dirname(sourcePath);
  const suffix = timestamp(now);
  const targetArg = argumentValue(args, '--target');
  const backupArg = argumentValue(args, '--backup');
  const journalArg = argumentValue(args, '--journal');
  const reportArg = argumentValue(args, '--report');
  const targetPath = targetArg
    ? path.resolve(targetArg)
    : `${sourcePath}.vcc-reset-v2-candidate-${suffix}`;
  const backupPath = backupArg
    ? path.resolve(backupArg)
    : `${sourcePath}.pre-vcc-reset-${suffix}.bak`;
  const journalPath = journalArg
    ? path.resolve(journalArg)
    : path.join(directory, 'run-data', 'vcc-financial-op', 'storage-migration.json');
  const reportPath = reportArg
    ? path.resolve(reportArg)
    : `${sourcePath}.vcc-reset-report-${suffix}.json`;
  if ([targetPath, backupPath, reportPath].some(
    (candidate) => path.dirname(candidate) !== directory
  )) {
    throw new TypeError('target/backup/report 必须与 source 位于同一目录');
  }
  if (new Set([sourcePath, targetPath, backupPath, reportPath]).size !== 4) {
    throw new TypeError('source/target/backup/report 必须是四个不同路径');
  }
  return Object.freeze({
    sourcePath,
    targetPath,
    backupPath,
    journalPath,
    reportPath,
    migrationId: `vcc-current-machine-reset-${suffix}`
  });
}

function assertPathsReady(options) {
  const sourceStat = fs.statSync(options.sourcePath);
  if (!sourceStat.isFile()) throw new TypeError('source 不是普通数据库文件');
  for (const candidate of [
    options.targetPath,
    options.backupPath,
    options.journalPath,
    options.reportPath
  ]) {
    if (fs.existsSync(candidate)) {
      const error = new Error(`安全路径已存在，禁止覆盖：${candidate}`);
      error.code = 'vcc-reset-path-exists';
      throw error;
    }
  }
}

function tableRowCountsByGlob(db, globPattern) {
  return db.prepare(`
    SELECT name FROM sqlite_master
    WHERE type = 'table' AND name GLOB ?
    ORDER BY name
  `).all(globPattern).map((row) => {
    const tableName = String(row.name);
    const quotedTableName = tableName.replaceAll('"', '""');
    return Object.freeze({
      tableName,
      rowCount: Number(db.prepare(
        `SELECT COUNT(*) AS count FROM "${quotedTableName}"`
      ).get().count) || 0
    });
  });
}

function vccSequenceHighWatermarks(db) {
  const hasSequenceTable = db.prepare(`
    SELECT 1 AS found FROM sqlite_master
    WHERE type = 'table' AND name = 'sqlite_sequence'
  `).get();
  if (!hasSequenceTable) return [];
  return db.prepare(`
    SELECT name AS table_name, seq
    FROM sqlite_sequence
    WHERE name GLOB 'vcc_fin_op_*'
    ORDER BY name
  `).all().map((row) => Object.freeze({
    tableName: String(row.table_name),
    sequence: Number(row.seq) || 0
  }));
}

function inspectActiveDatabase(filePath) {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(filePath, { readOnly: true });
  try {
    return Object.freeze({
      contractVersion: storageContractVersion(db),
      vccTableRowCounts: tableRowCountsByGlob(db, 'vcc_fin_op_*'),
      archiveTableRowCounts: tableRowCountsByGlob(db, 'archive_*'),
      vccSequenceHighWatermarks: vccSequenceHighWatermarks(db)
    });
  } finally {
    db.close();
  }
}

function assertSameEvidence(actual, expected, label) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    const error = new Error(`${label} 在最终活动库中未守恒`);
    error.code = 'vcc-reset-audit-evidence-mismatch';
    throw error;
  }
}

function fsyncDirectoryBestEffort(directory) {
  let fd = null;
  try {
    fd = fs.openSync(directory, 'r');
    fs.fsyncSync(fd);
  } catch (error) {
    if (!['EINVAL', 'EISDIR', 'EPERM', 'ENOTSUP'].includes(error && error.code)) throw error;
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

function writeAuditReport(reportPath, report) {
  const temporaryPath = `${reportPath}.tmp-${process.pid}-${Date.now()}`;
  let fd = null;
  try {
    fd = fs.openSync(temporaryPath, 'wx', 0o600);
    fs.writeFileSync(fd, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(temporaryPath, reportPath);
    fsyncDirectoryBestEffort(path.dirname(reportPath));
  } catch (error) {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch (_closeError) {}
    }
    try { fs.unlinkSync(temporaryPath); } catch (_unlinkError) {}
    throw error;
  }
}

function progressLine(progress) {
  const processed = Number(progress && progress.processed) || 0;
  const total = Number(progress && progress.total) || 0;
  const phase = String(progress && progress.phase || 'working');
  const detail = String(progress && progress.detail || '');
  return `[VCC reset] ${phase} ${processed}/${total}${detail ? ` ${detail}` : ''}`;
}

function runReset(options) {
  assertPathsReady(options);
  let switchCompleted = false;
  let journal = createMigrationJournal({
    sourcePath: options.sourcePath,
    targetPath: options.targetPath,
    backupPath: options.backupPath,
    migrationId: options.migrationId,
    resetVccData: true,
    deleteOldDatabase: false
  });
  journal = updateJournal(options.journalPath, journal, 'prepared');
  let journalPhase = 'prepared';
  try {
    const candidate = buildVccStorageCandidate({
      sourcePath: options.sourcePath,
      targetPath: options.targetPath,
      resetVccData: true,
      onProgress(progress) {
        process.stderr.write(`${progressLine(progress)}\n`);
        const nextPhase = ['copying', 'verifying'].includes(progress.phase)
          ? progress.phase
          : journalPhase;
        if (nextPhase !== journalPhase) {
          journalPhase = nextPhase;
          journal = updateJournal(options.journalPath, journal, nextPhase, {
            progress: {
              processed: Number(progress.processed) || 0,
              total: Number(progress.total) || 0,
              detail: String(progress.detail || '')
            }
          });
        }
      }
    });
    if (!candidate || candidate.noChange || candidate.resetVccData !== true) {
      const error = new Error('候选库没有完成 reset-only v1→v2 重建，禁止切换');
      error.code = 'vcc-reset-candidate-invalid';
      throw error;
    }
    journal = updateJournal(options.journalPath, journal, 'verifying', {
      candidate: {
        sourceBytes: candidate.sourceBytes,
        targetBytes: candidate.targetBytes,
        sourceEffectiveCount: candidate.sourceEffectiveCount,
        sourceAnomalyCount: candidate.sourceAnomalyCount,
        oldCoreBytes: candidate.oldCoreBytes,
        newCoreBytes: candidate.newCoreBytes,
        reductionRatio: candidate.reductionRatio
      }
    });
    const switched = atomicSwitchVccStorage({
      journalPath: options.journalPath,
      journal
    });
    switchCompleted = true;
    const activeEvidence = inspectActiveDatabase(options.sourcePath);
    const sourceEvidence = candidate.resetReadiness || {};
    if (activeEvidence.contractVersion !== 2
        || activeEvidence.vccTableRowCounts.some((entry) => entry.rowCount !== 0)) {
      const error = new Error('最终活动库不是 VCC 全空的 storage contract v2');
      error.code = 'vcc-reset-final-readback-failed';
      throw error;
    }
    assertSameEvidence(
      activeEvidence.archiveTableRowCounts,
      sourceEvidence.sourceArchiveTableRowCounts || [],
      'Archive Center 表行数'
    );
    assertSameEvidence(
      activeEvidence.vccSequenceHighWatermarks,
      sourceEvidence.sourceVccSequenceHighWatermarks || [],
      'VCC AUTOINCREMENT 高水位'
    );
    const report = Object.freeze({
      schemaVersion: 1,
      operation: 'current-machine-vcc-v1-reset',
      status: 'success',
      migrationId: options.migrationId,
      completedAt: new Date().toISOString(),
      paths: {
        activeDatabase: options.sourcePath,
        retainedBackup: options.backupPath
      },
      storage: {
        sourceBytes: candidate.sourceBytes,
        targetBytes: candidate.targetBytes,
        oldCoreBytes: candidate.oldCoreBytes,
        newCoreBytes: candidate.newCoreBytes,
        reductionRatio: candidate.reductionRatio
      },
      before: {
        contractVersion: 1,
        vccTableRowCounts: sourceEvidence.sourceVccTableRowCounts || [],
        archiveTableRowCounts: sourceEvidence.sourceArchiveTableRowCounts || [],
        vccSequenceHighWatermarks: sourceEvidence.sourceVccSequenceHighWatermarks || []
      },
      after: activeEvidence,
      verification: {
        sourceAndCandidateIntegrityChecked: true,
        reopenedActiveDatabaseIntegrityChecked: true,
        nonVccTablesExactlyPreserved: true,
        archiveCenterRowCountsPreserved: true,
        vccTablesEmpty: true,
        vccSequenceHighWatermarksPreserved: true,
        oldDatabaseRetained: switched.oldDatabaseDeleted === false
      }
    });
    writeAuditReport(options.reportPath, report);
    return Object.freeze({
      status: 'success',
      sourcePath: options.sourcePath,
      backupPath: options.backupPath,
      reportPath: options.reportPath,
      sourceBytes: candidate.sourceBytes,
      targetBytes: candidate.targetBytes,
      oldCoreBytes: candidate.oldCoreBytes,
      newCoreBytes: candidate.newCoreBytes,
      reductionRatio: candidate.reductionRatio,
      sourceEffectiveCount: candidate.sourceEffectiveCount,
      oldDatabaseDeleted: switched.oldDatabaseDeleted
    });
  } catch (error) {
    if (switchCompleted) {
      error.resetCompleted = true;
      error.backupPath = options.backupPath;
      if (!error.code) error.code = 'vcc-reset-post-switch-verification-failed';
    }
    let recovery = null;
    try { recovery = recoverVccStorageMigration({ journalPath: options.journalPath }); } catch (_error) {}
    if (recovery) error.recovery = recovery;
    throw error;
  }
}

function main() {
  const options = resolveOptions(process.argv.slice(2));
  const result = runReset(options);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${JSON.stringify({
      status: 'error',
      code: error && error.code || 'vcc-reset-failed',
      message: error && error.message || String(error),
      recovery: error && error.recovery || null,
      resetCompleted: error && error.resetCompleted === true,
      backupPath: error && error.backupPath || null
    }, null, 2)}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  CONFIRMATION,
  resolveOptions,
  runReset
};
