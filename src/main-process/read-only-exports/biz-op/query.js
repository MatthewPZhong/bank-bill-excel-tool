'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const runDataStore = require('../../../backend/run-data-store');
const datasetHeadRepository = require('../../../backend/biz-op-recon-db/dataset-head-repository');
const runRepository = require('../../../backend/biz-op-recon-db/run-repository');
const { normalizeBu } = require('../../biz-op-recon-session');
const { canonicalSha256 } = require('../../background-execution/canonical-json-v1');

function sourceError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function openBizOpReadDatabase(databasePath) {
  const db = new DatabaseSync(databasePath, { readOnly: true });
  db.exec('PRAGMA query_only = ON; PRAGMA busy_timeout = 30000;');
  return db;
}

function withMainReadSnapshot(mainDb, work) {
  mainDb.exec('BEGIN');
  try {
    const value = work();
    mainDb.exec('COMMIT');
    return value;
  } catch (error) {
    try { mainDb.exec('ROLLBACK'); } catch (_rollbackError) { /* preserve original */ }
    throw error;
  }
}

function assertStableRun(run, label) {
  if (!run || run.status !== 'success') {
    throw sourceError('BIZ_OP_EXPORT_RUN_NOT_STABLE', `${label}不是 success run`);
  }
  const contractVersion = Number(run.archive_contract_version) || 0;
  if (![0, 1].includes(contractVersion) ||
      (contractVersion === 1 && (!run.archive_task_run_id || !run.archive_terminal_ack_at))) {
    throw sourceError('BIZ_OP_EXPORT_RUN_NOT_STABLE', `${label}尚未 ACK`);
  }
}

function previousDate(date) {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() - 1);
  return value.toISOString().slice(0, 10);
}

function sourceRunRevision(srcDb, locator) {
  const run = runRepository.getRunById(srcDb, locator.sideRunId);
  assertStableRun(run, `BizOP source run #${locator.sideRunId}`);
  if (run.data_date !== locator.date || normalizeBu(run.bu_name) !== normalizeBu(locator.buName) ||
      (locator.archiveTaskRunId && run.archive_task_run_id !== locator.archiveTaskRunId)) {
    throw sourceError('BIZ_OP_EXPORT_RUN_IDENTITY_MISMATCH', 'BizOP frozen locator 与 source run 不一致');
  }
  const heads = Object.freeze([
    datasetHeadRepository.getHead(srcDb, 'op', locator.date, locator.buName),
    datasetHeadRepository.getHead(srcDb, 'op', previousDate(locator.date), locator.buName),
    datasetHeadRepository.getHead(srcDb, 'flow', locator.date)
  ].map((head) => head ? Object.freeze({ ...head }) : null));
  if (Number(run.archive_contract_version) === 1 && heads.some((head) => !head)) {
    throw sourceError(
      'BIZ_OP_EXPORT_RUN_NOT_STABLE',
      `BizOP source run #${locator.sideRunId} 缺少稳定 dataset head`
    );
  }
  return Object.freeze({ locator, run: Object.freeze({ ...run }), datasetHeads: heads });
}

function assertBizOpSidePath(userDataDir, sideDbRelPath) {
  if (typeof sideDbRelPath !== 'string' || !sideDbRelPath) {
    throw sourceError('BIZ_OP_EXPORT_SIDE_PATH_INVALID', 'BizOP side DB 相对路径非法');
  }
  const expectedRoot = path.resolve(
    runDataStore.moduleDir(userDataDir, runDataStore.MODULE_BIZ_OP)
  );
  const candidate = path.resolve(runDataStore.resolveFromRel(userDataDir, sideDbRelPath));
  const relative = path.relative(expectedRoot, candidate);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative) ||
      path.dirname(relative) !== '.' || !/^month-\d{4}-\d{2}\.sqlite$/.test(relative)) {
    throw sourceError('BIZ_OP_EXPORT_SIDE_PATH_INVALID', 'BizOP side DB 路径越界或格式非法');
  }
  const stat = fs.lstatSync(candidate);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw sourceError('BIZ_OP_EXPORT_SIDE_PATH_INVALID', 'BizOP side DB 必须是普通文件');
  }
  return candidate;
}

function readLocator({ userDataDir, mainDb, mirrorRunId, openSourceDb }) {
  const mirror = runRepository.getRunById(mainDb, mirrorRunId);
  if (!mirror) throw sourceError('BIZ_OP_EXPORT_RUN_NOT_FOUND', `BizOP mirror run #${mirrorRunId} 不存在`);
  assertStableRun(mirror, `BizOP mirror run #${mirrorRunId}`);
  if (!mirror.side_db_rel_path) {
    return Object.freeze({
      locator: Object.freeze({
        mirrorRunId: Number(mirror.id),
        sideDbRelPath: null,
        sideRunId: Number(mirror.id),
        date: mirror.data_date,
        buName: mirror.bu_name,
        archiveTaskRunId: null
      }),
      mirror: Object.freeze({ ...mirror })
    });
  }
  const sidePath = assertBizOpSidePath(userDataDir, mirror.side_db_rel_path);
  const sideDb = openSourceDb(sidePath);
  try {
    sideDb.exec('BEGIN');
    try {
      const sideRun = Number(mirror.archive_contract_version) === 1
        ? runRepository.getRunByArchiveTaskRunId(sideDb, mirror.archive_task_run_id)
        : runRepository.listRunsByDateBu(sideDb, mirror.data_date, mirror.bu_name)[0];
      assertStableRun(sideRun, `BizOP side run for mirror #${mirrorRunId}`);
      if (sideRun.data_date !== mirror.data_date ||
          normalizeBu(sideRun.bu_name) !== normalizeBu(mirror.bu_name) ||
          (Number(mirror.archive_contract_version) === 1 &&
            sideRun.archive_task_run_id !== mirror.archive_task_run_id)) {
        throw sourceError('BIZ_OP_EXPORT_RUN_IDENTITY_MISMATCH', 'BizOP mirror/side run 身份不一致');
      }
      sideDb.exec('COMMIT');
      return Object.freeze({
        locator: Object.freeze({
          mirrorRunId: Number(mirror.id),
          sideDbRelPath: mirror.side_db_rel_path,
          sideRunId: Number(sideRun.id),
          date: sideRun.data_date,
          buName: sideRun.bu_name,
          archiveTaskRunId: Number(sideRun.archive_contract_version) === 1
            ? sideRun.archive_task_run_id
            : null
        }),
        mirror: Object.freeze({ ...mirror })
      });
    } catch (error) {
      try { sideDb.exec('ROLLBACK'); } catch (_rollbackError) { /* preserve */ }
      throw error;
    }
  } finally {
    sideDb.close();
  }
}

function selectRunLocators({ userDataDir, mainDb, selector, openSourceDb }) {
  let mirrorRunIds;
  if (selector.kind === 'biz-op-day') {
    mirrorRunIds = [selector.mirrorRunId];
  } else if (selector.kind === 'biz-op-range') {
    mirrorRunIds = runRepository.listSuccessDatesInRange(
      mainDb,
      selector.buName,
      selector.startDate,
      selector.endDate
    ).map((row) => Number(row.runId));
  } else {
    throw sourceError('BIZ_OP_EXPORT_SELECTOR_INVALID', 'BizOP export selector 非法');
  }
  const entries = mirrorRunIds.map((mirrorRunId) => readLocator({
    userDataDir,
    mainDb,
    mirrorRunId,
    openSourceDb
  }));
  if (selector.kind === 'biz-op-day' && entries.length !== 1) {
    throw sourceError('BIZ_OP_EXPORT_SELECTOR_INVALID', 'BizOP day selector 未唯一命中');
  }
  return Object.freeze({
    locators: Object.freeze(entries.map((entry) => entry.locator)),
    mirrors: Object.freeze(entries.map((entry) => entry.mirror))
  });
}

function readSourceGroup(srcDb, selections) {
  const revisions = selections.map(({ locator }) => sourceRunRevision(srcDb, locator));
  return Object.freeze({
    sourceDigest: canonicalSha256(Object.freeze({ revisions: Object.freeze(revisions) })),
    revisions: Object.freeze(revisions)
  });
}

function readBizOpSourceSnapshot({ userDataDir, mainDb, selector, openSourceDb }) {
  const selected = selectRunLocators({ userDataDir, mainDb, selector, openSourceDb });
  const groups = new Map();
  selected.locators.forEach((locator, sourceIndex) => {
    const sourceKey = locator.sideDbRelPath || '<main>';
    if (!groups.has(sourceKey)) groups.set(sourceKey, []);
    groups.get(sourceKey).push({ locator, sourceIndex });
  });
  const sourceGroups = [];
  for (const [sourceKey, selections] of groups) {
    if (sourceKey === '<main>') {
      const group = readSourceGroup(mainDb, selections);
      sourceGroups.push(Object.freeze({ sourceKey, sourceDigest: group.sourceDigest }));
      continue;
    }
    const sourcePath = assertBizOpSidePath(userDataDir, sourceKey);
    const db = openSourceDb(sourcePath);
    try {
      db.exec('BEGIN');
      try {
        const group = readSourceGroup(db, selections);
        db.exec('COMMIT');
        sourceGroups.push(Object.freeze({ sourceKey, sourceDigest: group.sourceDigest }));
      } catch (error) {
        try { db.exec('ROLLBACK'); } catch (_rollbackError) { /* preserve */ }
        throw error;
      }
    } finally {
      db.close();
    }
  }
  const compact = Object.freeze({
    contractVersion: 1,
    runCount: selected.locators.length,
    selectionDigest: canonicalSha256(selected.locators),
    sourceDigest: canonicalSha256(Object.freeze({
      mirrors: selected.mirrors,
      locators: selected.locators,
      sourceGroups: Object.freeze(sourceGroups)
    }))
  });
  return Object.freeze({
    evidence: compact,
    runLocators: selected.locators,
    sourceGroups: Object.freeze(sourceGroups)
  });
}

function freezeBizOpSourceSnapshot({
  userDataDir,
  mainDb,
  selector,
  openSourceDb = openBizOpReadDatabase
}) {
  return withMainReadSnapshot(mainDb, () => readBizOpSourceSnapshot({
    userDataDir,
    mainDb,
    selector,
    openSourceDb
  }));
}

function assertBizOpSourceSnapshot(current, expected) {
  if (!expected || expected.contractVersion !== 1 ||
      current.evidence.runCount !== expected.runCount ||
      current.evidence.selectionDigest !== expected.selectionDigest ||
      current.evidence.sourceDigest !== expected.sourceDigest) {
    throw sourceError('BIZ_OP_EXPORT_SOURCE_STALE', 'BizOP export 来源已变化，请重新导出');
  }
  return current;
}

function assertSourceGroupEvidence(srcDb, selections, expectedGroups, sourceKey) {
  const expected = expectedGroups.find((group) => group.sourceKey === sourceKey);
  const current = readSourceGroup(srcDb, selections);
  if (!expected || current.sourceDigest !== expected.sourceDigest) {
    throw sourceError('BIZ_OP_EXPORT_SOURCE_STALE', `BizOP export source group 已变化：${sourceKey}`);
  }
  return current;
}

module.exports = {
  assertBizOpSidePath,
  assertBizOpSourceSnapshot,
  assertSourceGroupEvidence,
  assertStableRun,
  freezeBizOpSourceSnapshot,
  openBizOpReadDatabase,
  previousDate,
  readBizOpSourceSnapshot,
  readSourceGroup,
  selectRunLocators,
  sourceRunRevision,
  withMainReadSnapshot
};
