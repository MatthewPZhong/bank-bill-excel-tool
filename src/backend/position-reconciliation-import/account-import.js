'use strict';

// 清结算银行账户表确认后的整表替换。账户表是快照：用户确认后删除旧行、写入新行。
// 确认前的校验与统计在链接原始表导入里完成（source-import），这里读取同一份暂存文件写库；
// 不再有导入账本、行内容摘要比对和文件再哈希，只比对暂存文件的身份快照与有效行数。

const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const {
  SOURCE_DEFINITIONS,
  SOURCE_TYPES
} = require('../../main-process/position-reconciliation/constants');
const {
  PositionReconciliationError,
  text
} = require('../../main-process/position-reconciliation/common');
const {
  deriveLinkedRowsForRecord
} = require('../../main-process/position-reconciliation/derivation');
const {
  validateSourceRow
} = require('../../main-process/position-reconciliation/readers');
const {
  sourceDefinitionsFor
} = require('../../main-process/position-reconciliation/source-structures');
const {
  accountRecordKeyOf,
  insertLinkRowStatement,
  insertSourceRawFile,
  insertSourceRowStatement,
  markSupersededSourceRawFiles,
  pickSourceFields,
  serializeSourceFields,
  writeLinkRows
} = require('../../main-process/position-reconciliation/source-row-storage');
const {
  runPositionSideDbMutation
} = require('../../main-process/position-reconciliation/side-db-mutation');
const {
  refreshPositionSourceSummary
} = require('../../main-process/position-reconciliation/source-summary-cache');
const {
  POSITION_IMPORT_PROGRESS_ROW_INTERVAL
} = require('./constants');
const {
  assertPositionImportDiskSpace
} = require('./disk-space-gate');
const {
  assertNotCancelled,
  assertPositionSchemaCurrent,
  assertStagedFileUntouched,
  bumpRevision,
  configureImportDatabase
} = require('./import-common');
const {
  readerFor
} = require('./reader-select');

const ACCOUNT = SOURCE_TYPES.BANK_ACCOUNT;

function applyMismatch(message, detailLines = []) {
  return new PositionReconciliationError(
    'position-import-preflight-apply-mismatch',
    message,
    detailLines
  );
}

function inputEvidenceFor(descriptor) {
  return {
    role: 'input',
    sourceType: ACCOUNT,
    filePath: descriptor.archivePath,
    originalName: descriptor.fileName,
    sourceSnapshot: descriptor.stagedSnapshot,
    expectedSha256: descriptor.stagedSha256,
    sizeBytes: descriptor.stagedSizeBytes
  };
}

async function applyPositionAccountSnapshot(input = {}) {
  const preflightReady = input.preflightReady || {};
  const descriptor = preflightReady.accountConfirmationDescriptor;
  if (!descriptor
      || descriptor.status !== 'needs-confirmation'
      || descriptor.sourceType !== ACCOUNT) {
    throw applyMismatch('账户快照写入缺少完整的待确认文件信息');
  }
  const sideDbPath = String(input.sideDbPath || '').trim();
  const db = new DatabaseSync(path.resolve(sideDbPath));
  const startedAt = Date.now();
  const onProgress = typeof input.onProgress === 'function' ? input.onProgress : null;
  try {
    configureImportDatabase(db);
    assertPositionSchemaCurrent(db);
    await assertStagedFileUntouched(descriptor);
    assertPositionImportDiskSpace({
      kind: 'account',
      sideDbPath,
      rowCount: Number(descriptor.rowCount || 0),
      stagedBytes: Number(descriptor.stagedSizeBytes || 0),
      availableBytes: input.availableBytes
    });
    const evidence = inputEvidenceFor(descriptor);
    const batchNumber = text(input.batchContext && input.batchContext.batchNumber);

    const mutation = await runPositionSideDbMutation({
      db,
      expectedCheckpoint: input.expectedCheckpoint,
      operationToken: input.operationToken,
      inputEvidence: [evidence],
      fallbackSourceType: ACCOUNT,
      requireExternalOperationToken: true,
      mutate: async () => {
        assertNotCancelled(input.cancelToken);
        db.prepare('DELETE FROM position_source_rows WHERE source_type = ?').run(ACCOUNT);
        const insertSource = insertSourceRowStatement(db);
        const insertLink = insertLinkRowStatement(db);
        let sheetName = '';
        let scannedRows = 0;
        let readerFilteredRows = 0;
        let rowCount = 0;
        let linkedRowCount = 0;
        const rawVersion = insertSourceRawFile(db, {
          sourceType: ACCOUNT,
          originalName: descriptor.fileName,
          originalPath: path.resolve(String(descriptor.filePath || '')),
          sheetName: descriptor.sheetName,
          sizeBytes: descriptor.stagedSizeBytes,
          sha256: descriptor.stagedSha256,
          operationToken: input.operationToken,
          archiveBatchNumber: batchNumber
        });
        // 与确认前同一份冻结结构：重读暂存文件仍按当时的结构识别。
        const sourceDefinitions = sourceDefinitionsFor(input.sourceStructures);
        const read = readerFor(descriptor.archivePath);
        const summary = await read(descriptor.archivePath, {
          kind: 'source',
          cancelToken: input.cancelToken,
          allowMainThread: false,
          sstTempRoot: path.join(descriptor.stagingDir, 'sst-account-apply'),
          ...(input.sstOptions || {}),
          sourceDefinitions,
          onRow: ({ row, excelRowNumber, sourceType, sheetName: detectedSheet }) => {
            sheetName = detectedSheet;
            scannedRows += 1;
            if (sourceType !== ACCOUNT) {
              throw applyMismatch('账户快照写入期间来源类型发生变化');
            }
            const fields = pickSourceFields(ACCOUNT, row);
            if (text(fields['账户状态']) !== '正常') {
              readerFilteredRows += 1;
              return;
            }
            const validation = validateSourceRow(ACCOUNT, fields);
            if (validation.errors.length > 0) {
              throw applyMismatch(
                `账户快照写入期间出现非法行：第 ${excelRowNumber} 行`,
                validation.errors
              );
            }
            const businessKey = `snapshot-row-${excelRowNumber}`;
            const sourceRecordKey = accountRecordKeyOf(fields, excelRowNumber);
            const sourceRowId = Number(insertSource.run(
              ACCOUNT,
              businessKey,
              null,
              null,
              rawVersion,
              excelRowNumber,
              sourceRecordKey,
              serializeSourceFields(fields)
            ).lastInsertRowid);
            const record = {
              sourceType: ACCOUNT,
              businessKey,
              sourceRecordKey,
              sourceRowId,
              sourceRowNumber: excelRowNumber,
              eventDate: '',
              monthKey: '',
              row: fields
            };
            const written = writeLinkRows(
              insertLink,
              ACCOUNT,
              record,
              deriveLinkedRowsForRecord(ACCOUNT, record)
            );
            linkedRowCount += written.visible + written.hidden;
            rowCount += 1;
            if (scannedRows % POSITION_IMPORT_PROGRESS_ROW_INTERVAL === 0) {
              assertNotCancelled(input.cancelToken);
              if (onProgress) {
                onProgress({
                  stage: 'importing',
                  currentFile: 1,
                  totalFiles: 1,
                  fileName: descriptor.fileName,
                  scannedRows,
                  acceptedRows: Number(descriptor.rowCount || 0),
                  committedRows: rowCount,
                  elapsedMs: Date.now() - startedAt
                });
              }
            }
          }
        });
        sheetName = sheetName || summary.sheetName;
        // 读取期间文件被换成同 sheet、同行数的另一份也能通过下面的行数核对：
        // 读完再比一次冻结的身份快照，不一致即回滚，旧账户表不变。
        await assertStagedFileUntouched(descriptor);
        if (rowCount === 0) {
          throw new PositionReconciliationError(
            'position-bank-account-empty',
            '清结算银行账户表没有账户状态为“正常”的有效行，旧快照未被覆盖'
          );
        }
        // 与确认时展示给用户的数字逐项核对：读取行数、有效行数必须一致。
        if (rowCount !== Number(descriptor.rowCount)
            || scannedRows !== Number(descriptor.physicalRowCount)
            || text(sheetName) !== text(descriptor.sheetName)) {
          throw applyMismatch('账户快照写入结果与确认时的统计不一致', [
            `有效行：确认时 ${Number(descriptor.rowCount)}，写入 ${rowCount}`,
            `读取行：确认时 ${Number(descriptor.physicalRowCount)}，写入 ${scannedRows}`
          ]);
        }
        if (linkedRowCount !== rowCount || rowCount + readerFilteredRows !== scannedRows) {
          throw applyMismatch('账户快照来源行与链接行数量不守恒', [
            `来源 ${rowCount} 行`,
            `链接 ${linkedRowCount} 行`
          ]);
        }
        db.prepare(
          'UPDATE position_raw_files SET sheet_name = ?, row_count = ? WHERE version = ?'
        ).run(sheetName, rowCount, rawVersion);
        markSupersededSourceRawFiles(db, ACCOUNT);
        bumpRevision(db, 'source', ACCOUNT);
        bumpRevision(db, 'linked', ACCOUNT);
        assertNotCancelled(input.cancelToken);
        const sourceSummary = refreshPositionSourceSummary(db, ACCOUNT, {
          onPhase: (phase) => {
            if (!onProgress) return;
            onProgress({
              stage: 'summarizing',
              summaryPhase: phase,
              currentFile: 1,
              totalFiles: 1,
              fileName: descriptor.fileName,
              scannedRows,
              acceptedRows: rowCount,
              committedRows: 0,
              elapsedMs: Date.now() - startedAt
            });
          }
        });
        if (sourceSummary.rawRowCount !== rowCount
            || sourceSummary.linkedRowCount !== linkedRowCount) {
          throw applyMismatch('账户快照汇总缓存与写入行数不守恒', [
            `来源写入 ${rowCount} 行，汇总 ${sourceSummary.rawRowCount} 行`,
            `链接写入 ${linkedRowCount} 行，汇总 ${sourceSummary.linkedRowCount} 行`
          ]);
        }
        if (onProgress) {
          onProgress({
            stage: 'committing',
            currentFile: 1,
            totalFiles: 1,
            fileName: descriptor.fileName,
            scannedRows,
            acceptedRows: rowCount,
            committedRows: rowCount,
            elapsedMs: Date.now() - startedAt
          });
        }
        return {
          sourceType: ACCOUNT,
          sourceName: SOURCE_DEFINITIONS[ACCOUNT].sourceName,
          linkedName: SOURCE_DEFINITIONS[ACCOUNT].linkedName,
          rowCount,
          linkedRowCount: sourceSummary.linkedRowCount,
          rawVersion,
          inputEvidence: evidence
        };
      }
    });
    return {
      ...mutation.result,
      nextCheckpoint: mutation.nextCheckpoint,
      inputPaths: [descriptor.archivePath],
      inputFiles: [evidence],
      originalInputPaths: [descriptor.filePath],
      cleanupPaths: [text(preflightReady.jobRoot)].filter(Boolean),
      jobId: preflightReady.jobId
    };
  } finally {
    db.close();
  }
}

module.exports = {
  applyPositionAccountSnapshot,
  inputEvidenceFor
};
