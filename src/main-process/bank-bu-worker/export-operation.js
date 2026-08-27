'use strict';

const fs = require('node:fs');
const crypto = require('node:crypto');
const path = require('node:path');

const runDataStore = require('../../backend/run-data-store');
const runData = require('../bank-bu-recon-run-data');
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

function managedMirrorIsCurrent(userDataDir, run) {
  if (!run.operation_key) return true; // 历史dual-source镜像保持旧语义。
  if (!run.side_db_rel_path || !Number.isSafeInteger(Number(run.side_run_id))) return false;
  let sideDb;
  try {
    sideDb = runDataStore.openExistingSideDb(
      runDataStore.resolveFromRel(userDataDir, run.side_db_rel_path)
    );
    const dataset = sideDb.prepare(
      'SELECT dataset_hash FROM bank_bu_dataset_evidence WHERE year_month = ?'
    ).get(run.year_month);
    const sideRun = sideDb.prepare('SELECT * FROM bank_bu_recon_runs WHERE id = ?')
      .get(Number(run.side_run_id));
    return Boolean(dataset && sideRun && dataset.dataset_hash === run.input_evidence_hash &&
      sideRun.operation_key === run.operation_key &&
      sideRun.producer_task_run_id === run.producer_task_run_id &&
      sideRun.input_evidence_hash === run.input_evidence_hash);
  } catch (_error) {
    return false;
  } finally {
    if (sideDb) sideDb.close();
  }
}

async function executeExportSingle(input, context = {}) {
  const stagingPath = resolveStaging(input);
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(input.mainDatabasePath, { readOnly: true });
  try {
    const runId = Number(input.runId);
    if (!Number.isSafeInteger(runId) || runId < 1) throw new TypeError('BankBU export runId非法');
    const run = runData.getMirrorRun({ mainDb: db, runId });
    if (!run || run.status !== 'success') throw new Error('BankBU运行记录不存在或未成功');
    if (!managedMirrorIsCurrent(input.userDataDir, run)) {
      const error = new Error('BankBU运行镜像与当前side dataset identity不一致');
      error.code = 'BANK_BU_EXPORT_MIRROR_STALE';
      throw error;
    }
    const data = runData.loadExportDataByRun({ userDataDir: input.userDataDir, mainDb: db, runId });
    if (!data) throw new Error('BankBU导出数据不可用');
    try {
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
    } catch (error) {
      cleanupStaging(stagingPath);
      throw error;
    }
    return Object.freeze({
      status: 'ok', operation: 'export-single', runId,
      yearMonth: data.yearMonth,
      artifacts: Object.freeze([artifact(stagingPath, 'bank-bu-export-single')])
    });
  } finally {
    db.close();
  }
}

async function executeExportAggregate(input, context = {}) {
  const stagingPath = resolveStaging(input);
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(input.mainDatabasePath, { readOnly: true });
  try {
    const latest = db.prepare(`
      SELECT id, year_month, status, side_db_rel_path, side_run_id, operation_key,
             producer_task_run_id, input_evidence_hash
      FROM bank_bu_recon_runs
      WHERE id IN (SELECT MAX(id) FROM bank_bu_recon_runs GROUP BY year_month)
      ORDER BY year_month ASC
    `).all();
    const months = [];
    const skippedMonths = [];
    for (const run of latest) {
      if (run.status !== 'success' || !managedMirrorIsCurrent(input.userDataDir, run)) {
        skippedMonths.push(run.year_month);
        continue;
      }
      const data = runData.loadExportDataByRun({
        userDataDir: input.userDataDir, mainDb: db, runId: Number(run.id)
      });
      if (!data) {
        skippedMonths.push(run.year_month);
        continue;
      }
      months.push({ ...data, yearMonth: run.year_month, runId: Number(run.id) });
    }
    if (months.length === 0) throw new Error('无可汇总的BankBU成功运行记录');
    try {
      await writeAggregateDiffWorkbook({ matchedMonths: months, savePath: stagingPath });
      if (context.signal && context.signal.aborted) throw new Error('BankBU aggregate export已取消');
    } catch (error) {
      cleanupStaging(stagingPath);
      throw error;
    }
    return Object.freeze({
      status: 'ok', operation: 'export-aggregate',
      includedMonths: Object.freeze(months.map((month) => month.yearMonth)),
      skippedMonths: Object.freeze(skippedMonths.slice()),
      runIds: Object.freeze(months.map((month) => Number(month.runId))),
      artifacts: Object.freeze([artifact(stagingPath, 'bank-bu-export-aggregate')])
    });
  } finally {
    db.close();
  }
}

module.exports = { executeExportAggregate, executeExportSingle, managedMirrorIsCurrent };
