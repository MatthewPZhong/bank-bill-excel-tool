'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const {
  normalizeSourceSnapshot
} = require('../archive-center/source-snapshot');
const {
  inspectPositionOperationCommitChain
} = require('./side-db-mutation');
const {
  POSITION_IMPORT_COMMANDS
} = require('../../backend/position-reconciliation-import/constants');
const {
  SOURCE_DEFINITIONS,
  SOURCE_TYPES
} = require('./constants');

function recoveryRequired(message, detailLines = []) {
  const error = new Error(message);
  error.code = 'position-recovery-required';
  error.detailLines = detailLines;
  return error;
}

function inputPathKey(value) {
  return path.resolve(String(value || ''));
}

function snapshotsEqual(left, right) {
  const normalizedLeft = normalizeSourceSnapshot(left);
  const normalizedRight = normalizeSourceSnapshot(right);
  return Boolean(normalizedLeft && normalizedRight)
    && normalizedLeft.sizeBytes === normalizedRight.sizeBytes
    && normalizedLeft.mtimeMs === normalizedRight.mtimeMs
    && normalizedLeft.ctimeMs === normalizedRight.ctimeMs
    && normalizedLeft.ino === normalizedRight.ino;
}

function expectedInputEvidence(file, sourceType = '') {
  return {
    filePath: inputPathKey(file.archivePath),
    originalName: String(file.fileName || path.basename(file.archivePath || '')).trim(),
    sourceType: String(sourceType || file.sourceType || '').trim(),
    sourceSnapshot: normalizeSourceSnapshot(file.stagedSnapshot),
    sha256: String(file.stagedSha256 || '').trim().toLowerCase(),
    sizeBytes: Number(file.stagedSizeBytes)
  };
}

function resultInputEvidence(proof) {
  return {
    filePath: proof.filePath,
    role: 'input',
    sourceType: proof.sourceType,
    originalName: proof.originalName,
    sourceSnapshot: proof.sourceSnapshot,
    expectedSha256: proof.sha256,
    sizeBytes: proof.sizeBytes
  };
}

function assertCommittedFileSet(files, chain, sourceType) {
  const expected = files.map((file) => expectedInputEvidence(file, sourceType));
  const expectedByPath = new Map(expected.map((item) => [item.filePath, item]));
  if (expectedByPath.size !== expected.length
      || chain.committedInputs.length !== expected.length) {
    throw recoveryRequired('平盘确认导入的文件级提交凭证数量不一致');
  }
  for (const proof of chain.committedInputs) {
    const item = expectedByPath.get(inputPathKey(proof.filePath));
    if (!item || !proofMatchesExpected(proof, item)) {
      throw recoveryRequired('平盘确认导入存在未知或不一致的文件级提交凭证');
    }
  }
  if (chain.committedMutations !== 1) {
    throw recoveryRequired('平盘确认导入的 checkpoint 推进次数不是 1');
  }
}

function jobRootFromPreflight(preflightReady) {
  // 暂存根目录由导入进程在 ready 消息里直接给出。
  const jobRoot = String(preflightReady && preflightReady.jobRoot || '').trim();
  return jobRoot ? path.resolve(jobRoot) : '';
}

function rebuildBankResult(db, preflightReady, chain) {
  const files = Array.isArray(preflightReady.acceptedBankFiles)
    ? preflightReady.acceptedBankFiles
    : [];
  if (files.length === 0 || preflightReady.kind !== 'bank') {
    throw recoveryRequired('平盘银行恢复缺少完整预检文件集合');
  }
  assertCommittedFileSet(files, chain, 'position-bank');
  const scopes = (
    Array.isArray(preflightReady.bankScopes) ? preflightReady.bankScopes : []
  ).map((scope) => ({
    channel: String(scope.channel || ''),
    monthKey: String(scope.monthKey || ''),
    rowCount: Number(scope.rowCount)
  }));
  db.exec(`
    CREATE TEMP TABLE IF NOT EXISTS position_recovery_bank_scopes(
      channel TEXT NOT NULL,
      month_key TEXT NOT NULL,
      row_count INTEGER NOT NULL,
      PRIMARY KEY(channel, month_key)
    ) WITHOUT ROWID;
    DELETE FROM position_recovery_bank_scopes;
  `);
  const insertScope = db.prepare(`
    INSERT INTO position_recovery_bank_scopes(channel, month_key, row_count)
    VALUES (?, ?, ?)
  `);
  scopes.forEach((scope) => insertScope.run(
    scope.channel,
    scope.monthKey,
    scope.rowCount
  ));
  const mismatches = db.prepare(`
    SELECT scope.channel, scope.month_key AS monthKey,
           scope.row_count AS expectedCount,
           COUNT(bank.id) AS actualCount
    FROM position_recovery_bank_scopes scope
    LEFT JOIN position_bank_rows bank
      ON bank.channel = scope.channel AND bank.month_key = scope.month_key
    GROUP BY scope.channel, scope.month_key, scope.row_count
    HAVING COUNT(bank.id) <> scope.row_count
    LIMIT 50
  `).all();
  if (mismatches.length > 0) {
    throw recoveryRequired(
      '平盘银行提交后的 scope 行数无法与 manifest 对齐',
      mismatches.map((row) => (
        `${row.channel}/${row.monthKey}：预期 ${row.expectedCount}，实际 ${row.actualCount}`
      ))
    );
  }
  const expectedRows = scopes.reduce((sum, scope) => sum + scope.rowCount, 0);
  const order = db.prepare(`
    SELECT COUNT(*) AS rowCount, MIN(bank.import_order) AS minOrder,
           MAX(bank.import_order) AS maxOrder,
           COUNT(DISTINCT bank.import_order) AS distinctOrders
    FROM position_bank_rows bank
    JOIN position_recovery_bank_scopes scope
      ON scope.channel = bank.channel AND scope.month_key = bank.month_key
  `).get();
  if (Number(order.rowCount) !== expectedRows
      || Number(order.minOrder) !== 0
      || Number(order.maxOrder) !== expectedRows - 1
      || Number(order.distinctOrders) !== expectedRows) {
    throw recoveryRequired('平盘银行提交后的 import_order 或总行数无法重建');
  }
  const acceptedFileIndexes = new Map();
  for (const file of files) {
    const fileIndex = Number(file.fileIndex);
    acceptedFileIndexes.set(inputPathKey(file.archivePath), fileIndex);
    acceptedFileIndexes.set(inputPathKey(file.filePath), fileIndex);
  }
  const fileScopes = db.prepare(`
    SELECT DISTINCT raw.original_path AS filePath,
           bank.channel, bank.month_key AS monthKey
    FROM position_bank_rows bank
    JOIN position_recovery_bank_scopes scope
      ON scope.channel = bank.channel AND scope.month_key = bank.month_key
    JOIN position_raw_files raw ON raw.version = bank.raw_version
    ORDER BY raw.original_path, bank.channel, bank.month_key
  `).all().map((row) => {
    const fileIndex = acceptedFileIndexes.get(inputPathKey(row.filePath));
    if (!Number.isSafeInteger(fileIndex)) {
      throw recoveryRequired('平盘银行提交后出现无法归属到预检文件的 scope');
    }
    return {
      fileIndex,
      channel: String(row.channel || ''),
      monthKey: String(row.monthKey || '')
    };
  });
  return {
    status: 'ok',
    rowCount: expectedRows,
    scopes: scopes.map(({ channel, monthKey }) => ({ channel, monthKey })),
    fileScopes,
    inputPaths: chain.committedInputs.map((proof) => proof.filePath),
    inputFiles: chain.committedInputs.map(resultInputEvidence),
    originalInputPaths: files.map((file) => file.filePath),
    cleanupPaths: [jobRootFromPreflight(preflightReady)].filter(Boolean),
    nextCheckpoint: chain.currentCheckpoint,
    recoveredFromWorkerExit: true
  };
}

function rebuildAccountResult(db, preflightReady, chain) {
  const descriptor = preflightReady.accountConfirmationDescriptor;
  if (!descriptor || descriptor.sourceType !== SOURCE_TYPES.BANK_ACCOUNT) {
    throw recoveryRequired('平盘账户恢复缺少完整预检 descriptor');
  }
  assertCommittedFileSet([descriptor], chain, SOURCE_TYPES.BANK_ACCOUNT);
  const sourceCount = Number(db.prepare(`
    SELECT COUNT(*) AS count
    FROM position_source_rows
    WHERE source_type = ?
  `).get(SOURCE_TYPES.BANK_ACCOUNT).count);
  const linkedCount = Number(db.prepare(`
    SELECT COUNT(*) AS count
    FROM position_link_rows
    WHERE source_type = ?
  `).get(SOURCE_TYPES.BANK_ACCOUNT).count);
  if (sourceCount !== Number(descriptor.rowCount) || linkedCount !== sourceCount) {
    throw recoveryRequired(
      '平盘账户提交后的来源/链接行数无法与 manifest 对齐',
      [
        `预期 ${Number(descriptor.rowCount)} 行`,
        `来源 ${sourceCount} 行`,
        `链接 ${linkedCount} 行`
      ]
    );
  }
  return {
    status: 'ok',
    sourceType: SOURCE_TYPES.BANK_ACCOUNT,
    sourceName: SOURCE_DEFINITIONS[SOURCE_TYPES.BANK_ACCOUNT].sourceName,
    linkedName: SOURCE_DEFINITIONS[SOURCE_TYPES.BANK_ACCOUNT].linkedName,
    rowCount: sourceCount,
    linkedRowCount: linkedCount,
    inputPaths: chain.committedInputs.map((proof) => proof.filePath),
    inputFiles: chain.committedInputs.map(resultInputEvidence),
    originalInputPaths: [descriptor.filePath],
    cleanupPaths: [jobRootFromPreflight(preflightReady)].filter(Boolean),
    nextCheckpoint: chain.currentCheckpoint,
    recoveredFromWorkerExit: true
  };
}

function proofMatchesExpected(proof, expected) {
  return inputPathKey(proof.filePath) === expected.filePath
    && String(proof.originalName || '').trim() === expected.originalName
    && String(proof.sourceType || '').trim() === expected.sourceType
    && String(proof.sha256 || '').trim().toLowerCase() === expected.sha256
    && Number(proof.sizeBytes) === expected.sizeBytes
    && snapshotsEqual(proof.sourceSnapshot, expected.sourceSnapshot);
}

// 链接原始表单遍导入：全部被接受的文件在一个事务里提交。导入进程在提交后、回报结果前退出时，
// 按提交链、文件凭证与版本记录重建结果；要么全部已提交，要么全部未提交。
function rebuildOrdinarySourceResult(db, preflightReady, chain, operationToken) {
  if (preflightReady.kind === 'bank'
      || (Array.isArray(preflightReady.acceptedBankFiles)
        && preflightReady.acceptedBankFiles.length > 0)) {
    throw recoveryRequired('平盘银行批次不得按链接原始表结果恢复');
  }
  const ordered = Array.isArray(preflightReady.orderedFileResults)
    ? preflightReady.orderedFileResults
    : [];
  const accepted = Array.isArray(preflightReady.acceptedOrdinaryInputFiles)
    ? preflightReady.acceptedOrdinaryInputFiles
    : [];
  if (accepted.length === 0) {
    throw recoveryRequired('平盘链接原始表恢复缺少已接受文件集合');
  }
  assertCommittedFileSet(accepted, chain, '');
  const findVersion = db.prepare(`
    SELECT kind, row_count AS rowCount, operation_token AS operationToken
    FROM position_raw_files
    WHERE version = ?
  `);
  for (const file of accepted) {
    const version = findVersion.get(Number(file.rawVersion));
    const expectedRows = Number(file.rowCount || 0) + Number(file.filteredRowCount || 0);
    if (!version
        || String(version.kind) !== String(file.sourceType)
        || String(version.operationToken) !== String(operationToken)
        || Number(version.rowCount) !== expectedRows) {
      throw recoveryRequired(
        '平盘链接原始表提交后的版本记录无法与已接受文件对齐',
        [`${String(file.fileName || '')}：版本 ${Number(file.rawVersion)}`]
      );
    }
  }
  const proofByPath = new Map(chain.committedInputs.map((proof) => [
    inputPathKey(proof.filePath),
    proof
  ]));
  const acceptedPaths = new Set(accepted.map((file) => inputPathKey(file.archivePath)));
  const results = ordered.map((item) => {
    if (item.status !== 'ok' || !acceptedPaths.has(inputPathKey(item.archivePath))) return item;
    const proof = proofByPath.get(inputPathKey(item.archivePath));
    return {
      ...item,
      inputPaths: [proof.filePath],
      inputFiles: [resultInputEvidence(proof)],
      originalInputPaths: [item.filePath],
      cleanupPaths: [item.stagingDir].filter(Boolean),
      applied: true,
      recoveredFromWorkerExit: true
    };
  });
  const success = results.filter((item) => item.status === 'ok');
  const failed = results.filter((item) => item.status === 'failed');
  const confirmation = results.filter((item) => item.status === 'needs-confirmation');
  const outputFiles = Array.isArray(preflightReady.outputFiles) ? preflightReady.outputFiles : [];
  const anomalyReports = Array.isArray(preflightReady.anomalyReports)
    ? preflightReady.anomalyReports
    : [];
  for (const item of success) {
    if (Number(item.filteredRowCount) > 0 && !item.anomalyReport) {
      throw recoveryRequired('已提交文件的异常报告未进入恢复输出集合');
    }
  }
  const jobRoot = jobRootFromPreflight(preflightReady);
  return {
    status: 'ok',
    code: 'position-import-worker-exit-recovered',
    message:
      `链接原始表导入恢复完成：成功 ${success.length}，` +
      `待确认 ${confirmation.length}，失败 ${failed.length}`,
    jobRoot,
    accountConfirmationDescriptor: preflightReady.accountConfirmationDescriptor || null,
    results,
    orderedFileResults: results,
    successCount: success.length,
    failedCount: failed.length,
    confirmationCount: confirmation.length,
    inputPaths: success.flatMap((item) => item.inputPaths),
    inputFiles: success.flatMap((item) => item.inputFiles),
    anomalyReport: preflightReady.anomalyReport || null,
    anomalyReports,
    outputPaths: outputFiles.map((file) => file.filePath),
    outputFiles,
    cleanupPaths: confirmation.length > 0
      ? results
        .filter((item) => item.status !== 'needs-confirmation')
        .map((item) => item.stagingDir)
        .filter(Boolean)
      : [jobRoot].filter(Boolean),
    recoveredFromWorkerExit: true,
    committedMutations: chain.committedMutations,
    checkpoint: chain.currentCheckpoint,
    nextCheckpoint: chain.currentCheckpoint
  };
}

function recoverPositionImportWorkerExit({
  sideDbPath,
  baseCheckpoint,
  operationToken,
  preflightReady,
  command
}) {
  const resolvedPath = path.resolve(String(sideDbPath || ''));
  if (!String(sideDbPath || '').trim()
      || !fs.existsSync(resolvedPath)
      || !preflightReady
      || !operationToken
      || !baseCheckpoint) {
    return null;
  }
  const db = new DatabaseSync(resolvedPath, { readOnly: true });
  try {
    db.exec('PRAGMA foreign_keys = ON;');
    db.exec('PRAGMA busy_timeout = 30000;');
    const chain = inspectPositionOperationCommitChain(db, {
      baseCheckpoint,
      operationToken
    });
    if (chain.committedMutations === 0 && chain.committedInputs.length === 0) {
      return null;
    }
    if (command === POSITION_IMPORT_COMMANDS.BANK_IMPORT) {
      return rebuildBankResult(db, preflightReady, chain);
    }
    if (command === POSITION_IMPORT_COMMANDS.ACCOUNT_APPLY) {
      return rebuildAccountResult(db, preflightReady, chain);
    }
    if (command === POSITION_IMPORT_COMMANDS.SOURCE_IMPORT) {
      return rebuildOrdinarySourceResult(db, preflightReady, chain, operationToken);
    }
    throw recoveryRequired(`平盘导入命令没有对应的恢复路径：${String(command || '')}`);
  } catch (error) {
    if (error && error.code === 'position-recovery-required') throw error;
    throw recoveryRequired(
      '平盘 worker 退出后的提交证据无法闭合，需要重启恢复',
      [error && error.message ? error.message : String(error)]
    );
  } finally {
    db.close();
  }
}

module.exports = {
  recoverPositionImportWorkerExit,
  rebuildAccountResult,
  rebuildBankResult,
  rebuildOrdinarySourceResult
};
