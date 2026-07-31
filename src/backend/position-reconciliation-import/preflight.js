'use strict';

const fs = require('node:fs');
const path = require('node:path');

const {
  BANK_STATEMENT_FIELDS
} = require('../../constants/bank-statement-fields');
const {
  SOURCE_DEFINITIONS,
  SOURCE_TYPES
} = require('../../main-process/position-reconciliation/constants');
const {
  deriveLinkedRows
} = require('../../main-process/position-reconciliation/derivation');
const {
  PositionReconciliationError,
  monthOf,
  normalizeDate,
  stableHash,
  text
} = require('../../main-process/position-reconciliation/common');
const {
  STAGING_RELATIVE_PATH,
  stageInputFilesAsync
} = require('../../main-process/position-reconciliation/input-staging');
const {
  StableArrayHashAccumulator,
  stableRowGuardHash,
  validateSourceRow
} = require('./contracts');
const {
  POSITION_IMPORT_PROGRESS_ROW_INTERVAL
} = require('./constants');
const {
  PositionImportLedger,
  verifySealedLedger
} = require('./ledger');
const {
  streamPositionXlsRows
} = require('./xls-reader');
const {
  streamPositionXlsxRows
} = require('./xlsx-reader');

function emptyStats() {
  return {
    scannedNonBlankRows: 0,
    persistedCandidateRows: 0,
    collapsedDuplicateRows: 0,
    readerFilteredRows: 0,
    invalidRows: 0,
    visibleLinkRows: 0,
    hiddenLinkRows: 0,
    derivedZeroSourceRows: 0,
    dateMin: null,
    dateMax: null,
    contentHash: null
  };
}

function updateDateRange(stats, value) {
  if (!value) return;
  if (!stats.dateMin || value < stats.dateMin) stats.dateMin = value;
  if (!stats.dateMax || value > stats.dateMax) stats.dateMax = value;
}

function progressEmitter(onProgress, startedAt, base) {
  if (typeof onProgress !== 'function') return;
  onProgress({
    stage: 'preflight',
    scannedRows: base.scannedNonBlankRows,
    acceptedRows: base.persistedCandidateRows,
    committedRows: 0,
    elapsedMs: Date.now() - startedAt
  });
}

function readerFor(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === '.xlsx') return streamPositionXlsxRows;
  if (extension === '.xls') return streamPositionXlsRows;
  throw new PositionReconciliationError(
    'position-file-type-unsupported',
    `仅支持 .xlsx / .xls 文件：${path.basename(filePath)}`
  );
}

async function preflightSourceFile({
  descriptor,
  ledger,
  cancelToken,
  onProgress,
  startedAt,
  sstOptions,
  allowMainThreadXls
}) {
  const stats = emptyStats();
  const contentHash = new StableArrayHashAccumulator();
  let sourceType = '';
  let sheetName = '';
  let accountConflictChecked = false;
  const read = readerFor(descriptor.filePath);

  try {
    const summary = await read(descriptor.filePath, {
      kind: 'source',
      cancelToken,
      allowMainThread: allowMainThreadXls,
      sstTempRoot: path.join(descriptor.stagingDir, 'sst'),
      ...sstOptions,
      onRow: ({ row, excelRowNumber, sourceType: detectedType, sheetName: detectedSheet }) => {
        sourceType = detectedType;
        sheetName = detectedSheet;
        stats.scannedNonBlankRows += 1;
        if (stats.scannedNonBlankRows % POSITION_IMPORT_PROGRESS_ROW_INTERVAL === 0) {
          progressEmitter(onProgress, startedAt, stats);
        }

        if (sourceType === SOURCE_TYPES.BANK_ACCOUNT && !accountConflictChecked) {
          accountConflictChecked = true;
          if (ledger.hasAcceptedAccountSnapshot()) {
            throw new PositionReconciliationError(
              'position-source-cross-file-snapshot-conflict',
              `同一次导入只能选择一份清结算银行账户表：${descriptor.sourceFileName}`
            );
          }
        }
        if (sourceType === SOURCE_TYPES.BANK_ACCOUNT && text(row['账户状态']) !== '正常') {
          stats.readerFilteredRows += 1;
          return;
        }

        const validation = validateSourceRow(sourceType, row);
        if (validation.errors.length > 0) {
          stats.invalidRows += 1;
          throw new PositionReconciliationError(
            'position-source-row-invalid',
            `链接原始表存在非法行：${descriptor.sourceFileName} / ${sheetName} 第 ${excelRowNumber} 行`,
            validation.errors
          );
        }
        const rowHash = stableHash(row);
        const rowGuardHash = stableRowGuardHash(row);
        if (SOURCE_DEFINITIONS[sourceType].keyField) {
          const claim = ledger.claimSourceRecord({
            sourceType,
            businessKey: validation.businessKey,
            rowHash,
            rowGuardHash,
            fileIndex: descriptor.fileIndex,
            rowNumber: excelRowNumber
          });
          if (claim.status === 'collapsed') {
            stats.collapsedDuplicateRows += 1;
            return;
          }
          if (claim.status !== 'accepted') {
            throw new PositionReconciliationError(
              'position-source-record-hash-collision',
              `来源记录内容摘要冲突：${descriptor.sourceFileName}`,
              ['无法证明两条来源记录完全相同，已停止导入']
            );
          }
        }

        const record = {
          sourceType,
          businessKey: validation.businessKey || `snapshot-row-${excelRowNumber}`,
          eventDate: validation.eventDate,
          monthKey: validation.monthKey,
          sourceRowNumber: excelRowNumber,
          row
        };
        const derived = deriveLinkedRows(sourceType, [record]);
        if (derived.length === 0) stats.derivedZeroSourceRows += 1;
        for (const item of derived) {
          if (item.visible === false) stats.hiddenLinkRows += 1;
          else stats.visibleLinkRows += 1;
        }
        contentHash.append(row);
        stats.persistedCandidateRows += 1;
        updateDateRange(stats, validation.eventDate);
      }
    });

    sourceType = sourceType || summary.sourceType;
    sheetName = sheetName || summary.sheetName;
    if (sourceType === SOURCE_TYPES.BANK_ACCOUNT && stats.persistedCandidateRows === 0) {
      throw new PositionReconciliationError(
        'position-bank-account-empty',
        '清结算银行账户表没有账户状态为“正常”的有效行，旧快照未被覆盖'
      );
    }
    if (stats.scannedNonBlankRows === 0) {
      throw new PositionReconciliationError(
        'position-source-empty',
        `链接原始表没有数据行：${descriptor.sourceFileName} / ${sheetName}`
      );
    }
    stats.contentHash = contentHash.digest();
    return {
      ...stats,
      sourceType,
      sheetName,
      sourceName: SOURCE_DEFINITIONS[sourceType].sourceName,
      linkedName: SOURCE_DEFINITIONS[sourceType].linkedName,
      sharedStringsMode: summary.sharedStringsMode,
      sharedStringsCount: summary.sharedStringsCount
    };
  } catch (error) {
    error.positionImportStats = {
      scannedNonBlankRows: stats.scannedNonBlankRows,
      invalidRows: stats.invalidRows,
      sourceType,
      sheetName
    };
    throw error;
  }
}

async function preflightBankFile({
  descriptor,
  ledger,
  cancelToken,
  onProgress,
  startedAt,
  sstOptions,
  allowMainThreadXls
}) {
  const stats = emptyStats();
  const contentHash = new StableArrayHashAccumulator();
  let sheetName = '';
  const read = readerFor(descriptor.filePath);
  try {
    const summary = await read(descriptor.filePath, {
      kind: 'bank',
      cancelToken,
      allowMainThread: allowMainThreadXls,
      sstTempRoot: path.join(descriptor.stagingDir, 'sst'),
      ...sstOptions,
      onRow: ({ row, excelRowNumber, sheetName: detectedSheet }) => {
        sheetName = detectedSheet;
        stats.scannedNonBlankRows += 1;
        if (stats.scannedNonBlankRows % POSITION_IMPORT_PROGRESS_ROW_INTERVAL === 0) {
          progressEmitter(onProgress, startedAt, stats);
        }
        const bankRow = Object.fromEntries(
          BANK_STATEMENT_FIELDS.map((header) => [header, row[header] ?? ''])
        );
        const bizId = text(bankRow.BizId);
        const channel = text(bankRow.Channel);
        const billDate = normalizeDate(bankRow.BillDate);
        const monthKey = monthOf(bankRow.BillDate);
        const errors = [];
        if (!bizId) errors.push('BizId 为空');
        if (!channel) errors.push('Channel 为空');
        if (!billDate || !monthKey) {
          errors.push(`BillDate 无法解析：${text(bankRow.BillDate) || '(空)'}`);
        }
        if (errors.length > 0) {
          stats.invalidRows += 1;
          throw new PositionReconciliationError(
            'position-bank-row-invalid',
            `银行对账单存在非法行：${descriptor.sourceFileName} 第 ${excelRowNumber} 行`,
            errors
          );
        }
        const claim = ledger.claimBankBizId({
          bizId,
          channel,
          monthKey,
          fileIndex: descriptor.fileIndex,
          rowNumber: excelRowNumber
        });
        if (claim.status !== 'accepted') {
          stats.invalidRows += 1;
          throw new PositionReconciliationError(
            'position-bank-row-invalid',
            `银行对账单存在非法行：${descriptor.sourceFileName} 第 ${excelRowNumber} 行`,
            [
              `BizId 与第 ${claim.firstFileIndex + 1} 个文件第 ${claim.firstRowNumber} 行重复`
            ]
          );
        }
        contentHash.append(bankRow);
        stats.persistedCandidateRows += 1;
        updateDateRange(stats, billDate);
      }
    });
    sheetName = sheetName || summary.sheetName;
    if (stats.persistedCandidateRows === 0) {
      throw new PositionReconciliationError(
        'position-bank-empty',
        `银行对账单没有可导入的数据行：${descriptor.sourceFileName}`
      );
    }
    stats.contentHash = contentHash.digest();
    return {
      ...stats,
      sourceType: 'bank',
      sheetName,
      sharedStringsMode: summary.sharedStringsMode,
      sharedStringsCount: summary.sharedStringsCount
    };
  } catch (error) {
    error.positionImportStats = {
      scannedNonBlankRows: stats.scannedNonBlankRows,
      invalidRows: stats.invalidRows,
      sourceType: 'bank',
      sheetName
    };
    throw error;
  }
}

function resultFromAccepted(descriptor, preflight, kind) {
  const status = kind === 'source' && preflight.sourceType === SOURCE_TYPES.BANK_ACCOUNT
    ? 'needs-confirmation'
    : 'ok';
  return {
    status,
    fileIndex: descriptor.fileIndex,
    filePath: descriptor.sourceFilePath,
    archivePath: descriptor.archivePath,
    stagingDir: descriptor.stagingDir,
    fileName: descriptor.sourceFileName,
    sourceType: preflight.sourceType,
    sourceName: preflight.sourceName || null,
    linkedName: preflight.linkedName || null,
    sheetName: preflight.sheetName,
    rowCount: preflight.persistedCandidateRows,
    collapsedDuplicateCount: preflight.collapsedDuplicateRows,
    contentHash: preflight.contentHash,
    sharedStringsMode: preflight.sharedStringsMode,
    sharedStringsCount: preflight.sharedStringsCount,
    stagedSnapshot: descriptor.stagedSnapshot,
    stagedSha256: descriptor.stagedSha256,
    stagedSizeBytes: descriptor.stagedSizeBytes
  };
}

function resultFromFailure(descriptor, error) {
  return {
    status: 'failed',
    fileIndex: descriptor.fileIndex,
    filePath: descriptor.sourceFilePath,
    archivePath: descriptor.archivePath,
    stagingDir: descriptor.stagingDir,
    fileName: descriptor.sourceFileName,
    code: error && error.code ? error.code : 'position-source-import-failed',
    message: error && error.message ? error.message : String(error),
    detailLines: Array.isArray(error && error.detailLines)
      ? error.detailLines.slice(0, 100)
      : []
  };
}

function isSystemFatal(error) {
  return new Set([
    'position-import-parser-parity-unproven',
    'position-import-job-ledger-invalid',
    'position-import-cancelled'
  ]).has(String(error && error.code || ''));
}

async function runPositionImportPreflight(input = {}) {
  const jobId = String(input.jobId || '').trim();
  const kind = input.kind === 'bank' ? 'bank' : 'source';
  const files = Array.isArray(input.files) ? input.files : [];
  const userDataDir = path.resolve(String(input.userDataDir || ''));
  if (!jobId || !userDataDir || files.length === 0) {
    throw new TypeError('preflight 需要 jobId、userDataDir 和 files');
  }
  const cancelToken = input.cancelToken && typeof input.cancelToken === 'object'
    ? input.cancelToken
    : { cancelled: false };
  const startedAt = Date.now();
  const staged = await stageInputFilesAsync(userDataDir, files, jobId, {
    cancelToken,
    onProgress: (progress) => {
      if (typeof input.onProgress !== 'function') return;
      input.onProgress({
        stage: 'staging',
        currentFile: progress.fileIndex + 1,
        totalFiles: files.length,
        fileName: progress.fileName,
        scannedRows: 0,
        acceptedRows: 0,
        committedRows: 0,
        copiedBytes: progress.copiedBytes,
        totalBytes: progress.totalBytes,
        elapsedMs: Date.now() - startedAt
      });
    }
  });
  const jobRoot = path.join(userDataDir, STAGING_RELATIVE_PATH, jobId);
  const ledgerPath = path.join(jobRoot, 'job-ledger.sqlite');
  let ledger = null;
  const orderedFileResults = [];
  const filePreflightStats = new Map();
  let bankFailure = null;

  try {
    ledger = new PositionImportLedger({ ledgerPath, jobId, kind });
    staged.forEach((descriptor) => ledger.addFile(descriptor));
    if (kind === 'bank') ledger.beginBatch('position_bank_batch');

    for (const descriptor of staged) {
      if (cancelToken.cancelled) {
        throw new PositionReconciliationError('position-import-cancelled', '平盘导入已取消');
      }
      ledger.beginFile(descriptor.fileIndex);
      try {
        const reportProgress = typeof input.onProgress === 'function'
          ? (progress) => input.onProgress({
            ...progress,
            currentFile: descriptor.fileIndex + 1,
            totalFiles: staged.length,
            fileName: descriptor.sourceFileName
          })
          : null;
        const preflight = kind === 'bank'
          ? await preflightBankFile({
            descriptor,
            ledger,
            cancelToken,
            onProgress: reportProgress,
            startedAt,
            sstOptions: input.sstOptions,
            allowMainThreadXls: input.allowMainThreadXls
          })
          : await preflightSourceFile({
            descriptor,
            ledger,
            cancelToken,
            onProgress: reportProgress,
            startedAt,
            sstOptions: input.sstOptions,
            allowMainThreadXls: input.allowMainThreadXls
          });
        ledger.acceptFile(descriptor.fileIndex, preflight);
        filePreflightStats.set(descriptor.fileIndex, {
          scannedNonBlankRows: preflight.scannedNonBlankRows,
          invalidRows: 0,
          sourceType: preflight.sourceType,
          sheetName: preflight.sheetName
        });
        orderedFileResults.push(resultFromAccepted(descriptor, preflight, kind));
      } catch (error) {
        ledger.rejectFile(
          descriptor.fileIndex,
          error,
          error && error.positionImportStats
            ? error.positionImportStats
            : {}
        );
        if (isSystemFatal(error)) {
          error.fileIndex = descriptor.fileIndex;
          throw error;
        }
        orderedFileResults.push(resultFromFailure(descriptor, error));
        if (kind === 'bank') {
          bankFailure = { descriptor, error };
          break;
        }
      }
    }

    if (kind === 'bank') {
      if (bankFailure) {
        ledger.rollbackBatch();
        orderedFileResults.length = 0;
        for (const descriptor of staged) {
          const error = descriptor.fileIndex === bankFailure.descriptor.fileIndex
            ? bankFailure.error
            : new PositionReconciliationError(
              'position-source-not-attempted-after-fatal',
              `银行批次存在失败文件，本文件未提交：${descriptor.sourceFileName}`
            );
          const failureStats = descriptor.fileIndex === bankFailure.descriptor.fileIndex
            ? bankFailure.error.positionImportStats
            : filePreflightStats.get(descriptor.fileIndex);
          ledger.rejectFile(
            descriptor.fileIndex,
            error,
            failureStats || {}
          );
          orderedFileResults.push(resultFromFailure(descriptor, error));
        }
      } else {
        ledger.commitBatch();
      }
    }

    const ledgerEvidence = await ledger.seal();
    const verifiedLedger = await verifySealedLedger(ledgerEvidence);
    verifiedLedger.db.close();
    const acceptedOrdinaryInputFiles = orderedFileResults.filter((result) => (
      result.status === 'ok' && result.sourceType !== SOURCE_TYPES.BANK_ACCOUNT
    ));
    const account = orderedFileResults.find((result) => result.status === 'needs-confirmation');
    const acceptedBankFiles = kind === 'bank' && orderedFileResults.every((result) => result.status === 'ok')
      ? orderedFileResults.slice()
      : [];
    return {
      jobId,
      kind,
      archiveManifestHash: ledgerEvidence.manifestHash,
      acceptedOrdinaryInputFiles,
      acceptedBankFiles,
      accountConfirmationDescriptor: account || null,
      orderedFileResults,
      ledgerEvidence,
      elapsedMs: Date.now() - startedAt
    };
  } catch (error) {
    if (ledger) ledger.close();
    await fs.promises.rm(jobRoot, { recursive: true, force: true });
    throw error;
  }
}

module.exports = {
  emptyStats,
  updateDateRange,
  readerFor,
  preflightSourceFile,
  preflightBankFile,
  runPositionImportPreflight
};
