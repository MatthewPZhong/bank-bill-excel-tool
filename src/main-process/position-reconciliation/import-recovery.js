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
  const ledgerPath = String(
    preflightReady
    && preflightReady.ledgerEvidence
    && preflightReady.ledgerEvidence.ledgerPath
    || ''
  ).trim();
  return ledgerPath ? path.dirname(path.resolve(ledgerPath)) : '';
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
    preflightReady.ledgerEvidence
    && preflightReady.ledgerEvidence.manifest
    && preflightReady.ledgerEvidence.manifest.bankScopes
    || []
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
    SELECT DISTINCT bank.source_file_path AS filePath,
           bank.channel, bank.month_key AS monthKey
    FROM position_bank_rows bank
    JOIN position_recovery_bank_scopes scope
      ON scope.channel = bank.channel AND scope.month_key = bank.month_key
    ORDER BY bank.source_file_path, bank.channel, bank.month_key
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

function committedRecoveryOutputs(preflightReady, acceptedPaths, committedPaths) {
  const outputs = Array.isArray(preflightReady && preflightReady.outputFiles)
    ? preflightReady.outputFiles
    : [];
  const allAcceptedCommitted = committedPaths.size === acceptedPaths.size;
  return outputs.filter((file) => {
    const dependencies = Array.isArray(file && file.requiredInputPaths)
      ? file.requiredInputPaths.map(inputPathKey)
      : null;
    if (!dependencies) {
      if (!allAcceptedCommitted) {
        throw recoveryRequired(
          '部分提交恢复遇到未声明输入依赖的异常报告，禁止归入成功批次'
        );
      }
      return true;
    }
    if (dependencies.length === 0
        || dependencies.some((filePath) => !acceptedPaths.has(filePath))) {
      throw recoveryRequired('异常报告输入依赖无法与预检文件集合对齐');
    }
    return dependencies.every((filePath) => committedPaths.has(filePath));
  });
}

function rebuildOrdinarySourceResult(preflightReady, chain, workerError) {
  const acceptedBankFiles = Array.isArray(preflightReady.acceptedBankFiles)
    ? preflightReady.acceptedBankFiles
    : [];
  if (preflightReady.kind === 'bank' || acceptedBankFiles.length > 0) {
    throw recoveryRequired(
      '平盘银行批次提交后的专用恢复尚未启用，禁止按普通来源结果恢复'
    );
  }
  const ordered = Array.isArray(preflightReady.orderedFileResults)
    ? preflightReady.orderedFileResults
    : [];
  const accepted = Array.isArray(preflightReady.acceptedOrdinaryInputFiles)
    ? preflightReady.acceptedOrdinaryInputFiles
    : [];
  const expectedByPath = new Map(accepted.map((file) => {
    const evidence = expectedInputEvidence(file);
    return [evidence.filePath, { file, evidence }];
  }));
  if (expectedByPath.size !== accepted.length) {
    throw recoveryRequired('平盘预检 manifest 存在重复的普通来源文件路径');
  }
  const unexpectedAcceptedResult = ordered.find((item) => (
    item.status === 'ok' && !expectedByPath.has(inputPathKey(item.archivePath))
  ));
  if (unexpectedAcceptedResult) {
    throw recoveryRequired(
      '平盘预检结果包含未登记到普通来源 manifest 的成功文件'
    );
  }
  const committedPaths = new Set();
  for (const proof of chain.committedInputs) {
    const key = inputPathKey(proof.filePath);
    const expected = expectedByPath.get(key);
    if (!expected || !proofMatchesExpected(proof, expected.evidence)) {
      throw recoveryRequired(
        '平盘 worker 退出后发现未知或不一致的文件级提交凭证'
      );
    }
    if (committedPaths.has(key)) {
      throw recoveryRequired('平盘 worker 退出后发现重复文件级提交凭证');
    }
    committedPaths.add(key);
  }
  if (chain.committedMutations !== committedPaths.size) {
    throw recoveryRequired(
      '平盘 worker 退出后的 checkpoint 次数与文件级提交凭证数量不一致'
    );
  }

  let results = ordered.map((item) => {
    if (item.status !== 'ok' || !expectedByPath.has(inputPathKey(item.archivePath))) {
      return item;
    }
    const committed = committedPaths.has(inputPathKey(item.archivePath));
    if (committed) {
      return {
        ...item,
        status: 'ok',
        recoveredFromWorkerExit: true
      };
    }
    const { anomalyReport: _uncommittedReport, ...withoutReport } = item;
    return {
      ...withoutReport,
      status: 'failed',
      code: 'position-import-worker-exited-before-commit',
      message: 'worker 退出前该文件尚未形成侧库提交凭证',
      detailLines: []
    };
  });
  const success = results.filter((item) => item.status === 'ok');
  const failed = results.filter((item) => item.status === 'failed');
  const confirmation = results.filter((item) => item.status === 'needs-confirmation');
  const committedFiles = success.map((item) => {
    const expected = expectedByPath.get(inputPathKey(item.archivePath)).evidence;
    return {
      filePath: expected.filePath,
      role: 'input',
      sourceType: expected.sourceType,
      originalName: expected.originalName,
      sourceSnapshot: expected.sourceSnapshot,
      expectedSha256: expected.sha256,
      sizeBytes: expected.sizeBytes
    };
  });
  const acceptedPaths = new Set(expectedByPath.keys());
  const outputFiles = committedRecoveryOutputs(
    preflightReady,
    acceptedPaths,
    committedPaths
  );
  const retainedReportKeys = new Set(outputFiles.map((file) => (
    String(file && file.metadata && file.metadata.reportKey || '').trim()
  )).filter(Boolean));
  const anomalyReports = (Array.isArray(preflightReady.anomalyReports)
    ? preflightReady.anomalyReports
    : []).filter((report) => retainedReportKeys.has(String(report.reportKey || '').trim()));
  results = results.map((item) => {
    const filteredRowCount = Number(item.filteredRowCount) || 0;
    if (item.status !== 'ok' || filteredRowCount <= 0) return item;
    if (!item.anomalyReport
        || !retainedReportKeys.has(String(item.anomalyReport.reportKey || '').trim())) {
      throw recoveryRequired('已提交文件的异常报告未进入恢复输出集合');
    }
    return item;
  });
  const aggregateReport = preflightReady.anomalyReport
    && retainedReportKeys.has(String(preflightReady.anomalyReport.reportKey || '').trim())
    ? preflightReady.anomalyReport
    : (anomalyReports.length === 1 ? anomalyReports[0] : null);
  return {
    status: success.length > 0 || confirmation.length > 0 ? 'ok' : 'failed',
    code: success.length > 0 ? 'position-import-worker-exit-recovered' : (
      workerError && workerError.code
        ? workerError.code
        : 'position-import-worker-exited'
    ),
    message:
      `链接原始表导入恢复完成：成功 ${success.length}，` +
      `待确认 ${confirmation.length}，失败 ${failed.length}`,
    results,
    orderedFileResults: results,
    successCount: success.length,
    failedCount: failed.length,
    confirmationCount: confirmation.length,
    inputPaths: committedFiles.map((file) => file.filePath),
    inputFiles: committedFiles,
    anomalyReport: aggregateReport,
    anomalyReports,
    outputPaths: outputFiles.map((file) => file.filePath),
    outputFiles,
    cleanupPaths: results
      .filter((item) => item.status !== 'needs-confirmation')
      .map((item) => item.stagingDir)
      .filter(Boolean),
    uncommittedInputPaths: accepted
      .filter((item) => !committedPaths.has(inputPathKey(item.archivePath)))
      .map((item) => inputPathKey(item.archivePath)),
    recoveredFromWorkerExit: true,
    committedMutations: chain.committedMutations,
    checkpoint: chain.currentCheckpoint
  };
}

function recoverPositionImportWorkerExit({
  sideDbPath,
  baseCheckpoint,
  operationToken,
  preflightReady,
  workerError,
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
    if (command === POSITION_IMPORT_COMMANDS.BANK_APPLY) {
      return rebuildBankResult(db, preflightReady, chain);
    }
    if (command === POSITION_IMPORT_COMMANDS.ACCOUNT_APPLY) {
      return rebuildAccountResult(db, preflightReady, chain);
    }
    return rebuildOrdinarySourceResult(preflightReady, chain, workerError);
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
