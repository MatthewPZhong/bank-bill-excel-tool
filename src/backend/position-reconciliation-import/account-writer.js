'use strict';

const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const {
  LINK_HEADERS,
  SOURCE_DEFINITIONS,
  SOURCE_TYPES
} = require('../../main-process/position-reconciliation/constants');
const {
  PositionReconciliationError,
  stableHash,
  text
} = require('../../main-process/position-reconciliation/common');
const {
  deriveLinkedRowsForRecord
} = require('../../main-process/position-reconciliation/derivation');
const {
  assertStagedInputUnchangedAsync
} = require('../../main-process/position-reconciliation/input-staging');
const {
  assertPositionLargeImportSchema,
  positionLargeImportSchemaFingerprint
} = require('../../main-process/position-reconciliation/large-import-schema');
const {
  runPositionSideDbMutation
} = require('../../main-process/position-reconciliation/side-db-mutation');
const {
  refreshPositionSourceSummary
} = require('../../main-process/position-reconciliation/source-summary-cache');
const {
  serializeJson
} = require('../../main-process/position-reconciliation/store');
const {
  StableArrayHashAccumulator,
  validateSourceRow
} = require('./contracts');
const {
  POSITION_IMPORT_PROGRESS_ROW_INTERVAL
} = require('./constants');
const {
  assertPositionImportDiskSpace
} = require('./disk-space-gate');
const {
  verifySealedLedger
} = require('./ledger');
const {
  emptyStats,
  readerFor
} = require('./preflight');
const {
  assertSourceStatsMatch,
  expectedLedgerFile
} = require('./source-writer');

function applyMismatch(message, detailLines = []) {
  return new PositionReconciliationError(
    'position-import-preflight-apply-mismatch',
    message,
    detailLines
  );
}

function assertNotCancelled(cancelToken) {
  if (cancelToken && cancelToken.cancelled) {
    throw new PositionReconciliationError(
      'position-import-cancelled',
      '平盘导入已取消'
    );
  }
}

function bumpRevision(db, kind, key) {
  db.prepare(`
    INSERT INTO position_revisions(kind, scope_key, revision, updated_at)
    VALUES (?, ?, 1, CURRENT_TIMESTAMP)
    ON CONFLICT(kind, scope_key) DO UPDATE SET
      revision = position_revisions.revision + 1,
      updated_at = CURRENT_TIMESTAMP
  `).run(kind, key);
}

function inputEvidenceFor(descriptor) {
  return {
    role: 'input',
    sourceType: SOURCE_TYPES.BANK_ACCOUNT,
    filePath: descriptor.archivePath,
    originalName: descriptor.fileName,
    sourceSnapshot: descriptor.stagedSnapshot,
    expectedSha256: descriptor.stagedSha256,
    sizeBytes: descriptor.stagedSizeBytes
  };
}

function configureDatabase(db) {
  db.exec('PRAGMA foreign_keys=ON;');
  db.exec('PRAGMA synchronous=NORMAL;');
  db.exec('PRAGMA busy_timeout=30000;');
  db.exec('PRAGMA cache_size=-2048;');
  db.exec('PRAGMA mmap_size=0;');
  db.exec('PRAGMA temp_store=FILE;');
  db.exec('PRAGMA journal_mode=WAL;');
}

function accountStatements(db) {
  return {
    insertSource: db.prepare(`
      INSERT INTO position_source_rows(
        source_type, business_key, event_date, month_key,
        source_file_path, source_file_name, source_sheet, source_row_number,
        row_hash, raw_json
      ) VALUES (?, ?, NULL, NULL, ?, ?, ?, ?, ?, ?)
      RETURNING id
    `),
    insertLink: db.prepare(`
      INSERT INTO position_link_rows(
        source_type, business_key, source_record_key, source_row_id,
        source_row_number, ordinal, leg_index, recon_id, merchant_id,
        currency, amount, fund_type, status, event_date, visible, linked_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, '', '', ?, '', '', '', '', ?, ?)
    `)
  };
}

async function applyPositionAccountSnapshot(input = {}) {
  const preflightReady = input.preflightReady || {};
  const descriptor = preflightReady.accountConfirmationDescriptor;
  if (!descriptor
      || descriptor.status !== 'needs-confirmation'
      || descriptor.sourceType !== SOURCE_TYPES.BANK_ACCOUNT) {
    throw applyMismatch('账户快照 apply 缺少完整的预检 descriptor');
  }
  const verifiedLedger = await verifySealedLedger(preflightReady.ledgerEvidence);
  const db = new DatabaseSync(path.resolve(String(input.sideDbPath || '')));
  const startedAt = Date.now();
  try {
    configureDatabase(db);
    assertPositionLargeImportSchema(db);
    if (positionLargeImportSchemaFingerprint(db) !== input.schemaFingerprint) {
      throw applyMismatch('账户快照写入前 schema fingerprint 已变化');
    }
    const expected = expectedLedgerFile(verifiedLedger, descriptor);
    await assertStagedInputUnchangedAsync(descriptor);
    assertPositionImportDiskSpace({
      kind: 'account',
      sideDbPath: input.sideDbPath,
      rowCount: Number(expected.persistedCandidateRows),
      stagedBytes: Number(descriptor.stagedSizeBytes || 0),
      ledgerBytes: Number(preflightReady.ledgerEvidence.ledgerSizeBytes || 0),
      availableBytes: input.availableBytes
    });
    const evidence = inputEvidenceFor(descriptor);

    const mutation = await runPositionSideDbMutation({
      db,
      expectedCheckpoint: input.expectedCheckpoint,
      operationToken: input.operationToken,
      inputEvidence: [evidence],
      fallbackSourceType: SOURCE_TYPES.BANK_ACCOUNT,
      requireExternalOperationToken: true,
      mutate: async () => {
        assertNotCancelled(input.cancelToken);
        db.prepare(
          'DELETE FROM position_source_rows WHERE source_type = ?'
        ).run(SOURCE_TYPES.BANK_ACCOUNT);
        const statements = accountStatements(db);
        const stats = emptyStats();
        const contentHash = new StableArrayHashAccumulator();
        let sheetName = '';
        let linkedRowCount = 0;
        const read = readerFor(descriptor.archivePath);
        const summary = await read(descriptor.archivePath, {
          kind: 'source',
          cancelToken: input.cancelToken,
          allowMainThread: false,
          sstTempRoot: path.join(descriptor.stagingDir, 'sst-account-apply'),
          ...(input.sstOptions || {}),
          onRow: ({
            row,
            excelRowNumber,
            sourceType,
            sheetName: detectedSheet
          }) => {
            sheetName = detectedSheet;
            stats.scannedNonBlankRows += 1;
            if (sourceType !== SOURCE_TYPES.BANK_ACCOUNT) {
              throw applyMismatch('账户快照 apply 期间来源类型发生变化');
            }
            if (text(row['账户状态']) !== '正常') {
              stats.readerFilteredRows += 1;
              return;
            }
            const validation = validateSourceRow(sourceType, row);
            if (validation.errors.length > 0) {
              stats.invalidRows += 1;
              throw applyMismatch(
                `账户快照 apply 期间出现非法行：第 ${excelRowNumber} 行`,
                validation.errors
              );
            }
            const businessKey = `snapshot-row-${excelRowNumber}`;
            // 账户快照允许内容完全相同的两行独立存在；整表替换后行号是稳定的批内身份。
            const sourceRecordKey = stableHash({ row, sourceRowNumber: excelRowNumber });
            const inserted = statements.insertSource.get(
              SOURCE_TYPES.BANK_ACCOUNT,
              businessKey,
              descriptor.filePath,
              descriptor.fileName,
              sheetName,
              excelRowNumber,
              sourceRecordKey,
              serializeJson(row)
            );
            const sourceRowId = Number(inserted && inserted.id);
            if (!Number.isSafeInteger(sourceRowId) || sourceRowId < 1) {
              throw applyMismatch('账户快照插入未返回有效 source_row_id');
            }
            const record = {
              sourceType: SOURCE_TYPES.BANK_ACCOUNT,
              businessKey,
              sourceRecordKey,
              sourceRowId,
              sourceRowNumber: excelRowNumber,
              eventDate: '',
              monthKey: '',
              row
            };
            const derived = deriveLinkedRowsForRecord(
              SOURCE_TYPES.BANK_ACCOUNT,
              record
            );
            if (derived.length === 0) stats.derivedZeroSourceRows += 1;
            for (const item of derived) {
              const missing = LINK_HEADERS[SOURCE_TYPES.BANK_ACCOUNT].filter(
                (header) => !Object.prototype.hasOwnProperty.call(item.row, header)
              );
              if (missing.length > 0) {
                throw applyMismatch('账户链接行缺少必填字段', missing);
              }
              statements.insertLink.run(
                SOURCE_TYPES.BANK_ACCOUNT,
                businessKey,
                sourceRecordKey,
                sourceRowId,
                excelRowNumber,
                sourceRowId,
                item.legIndex,
                text(item.row['币种']),
                item.visible === false ? 0 : 1,
                serializeJson(item.row)
              );
              linkedRowCount += 1;
              if (item.visible === false) stats.hiddenLinkRows += 1;
              else stats.visibleLinkRows += 1;
            }
            stats.persistedCandidateRows += 1;
            contentHash.append(row);
            if (stats.scannedNonBlankRows % POSITION_IMPORT_PROGRESS_ROW_INTERVAL === 0) {
              assertNotCancelled(input.cancelToken);
              if (typeof input.onProgress === 'function') {
                input.onProgress({
                  stage: 'deriving',
                  currentFile: 1,
                  totalFiles: 1,
                  fileName: descriptor.fileName,
                  scannedRows: stats.scannedNonBlankRows,
                  acceptedRows: Number(expected.persistedCandidateRows),
                  committedRows: stats.persistedCandidateRows,
                  elapsedMs: Date.now() - startedAt
                });
              }
            }
          }
        });
        sheetName = sheetName || summary.sheetName;
        stats.contentHash = contentHash.digest();
        if (stats.persistedCandidateRows === 0) {
          throw new PositionReconciliationError(
            'position-bank-account-empty',
            '清结算银行账户表没有账户状态为“正常”的有效行，旧快照未被覆盖'
          );
        }
        assertSourceStatsMatch(
          stats,
          expected,
          SOURCE_TYPES.BANK_ACCOUNT,
          sheetName
        );
        if (linkedRowCount !== stats.persistedCandidateRows) {
          throw applyMismatch(
            '账户快照来源行与链接行数量不守恒',
            [
              `来源 ${stats.persistedCandidateRows} 行`,
              `链接 ${linkedRowCount} 行`
            ]
          );
        }
        bumpRevision(db, 'source', SOURCE_TYPES.BANK_ACCOUNT);
        bumpRevision(db, 'linked', SOURCE_TYPES.BANK_ACCOUNT);
        assertNotCancelled(input.cancelToken);
        const sourceSummary = refreshPositionSourceSummary(
          db,
          SOURCE_TYPES.BANK_ACCOUNT,
          {
            onPhase: (phase) => {
              if (typeof input.onProgress !== 'function') return;
              input.onProgress({
                stage: 'summarizing',
                summaryPhase: phase,
                currentFile: 1,
                totalFiles: 1,
                fileName: descriptor.fileName,
                scannedRows: stats.scannedNonBlankRows,
                acceptedRows: stats.persistedCandidateRows,
                committedRows: 0,
                elapsedMs: Date.now() - startedAt
              });
            }
          }
        );
        if (sourceSummary.rawRowCount !== stats.persistedCandidateRows
            || sourceSummary.linkedRowCount !== stats.visibleLinkRows) {
          throw applyMismatch(
            '账户快照汇总缓存与写入行数不守恒',
            [
              `来源写入 ${stats.persistedCandidateRows} 行，汇总 ${sourceSummary.rawRowCount} 行`,
              `可见链接写入 ${stats.visibleLinkRows} 行，汇总 ${sourceSummary.linkedRowCount} 行`
            ]
          );
        }
        if (typeof input.onProgress === 'function') {
          input.onProgress({
            stage: 'committing',
            currentFile: 1,
            totalFiles: 1,
            fileName: descriptor.fileName,
            scannedRows: stats.scannedNonBlankRows,
            acceptedRows: stats.persistedCandidateRows,
            committedRows: stats.persistedCandidateRows,
            elapsedMs: Date.now() - startedAt
          });
        }
        return {
          sourceType: SOURCE_TYPES.BANK_ACCOUNT,
          sourceName: SOURCE_DEFINITIONS[SOURCE_TYPES.BANK_ACCOUNT].sourceName,
          linkedName: SOURCE_DEFINITIONS[SOURCE_TYPES.BANK_ACCOUNT].linkedName,
          rowCount: stats.persistedCandidateRows,
          linkedRowCount: sourceSummary.linkedRowCount,
          contentHash: stats.contentHash,
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
      cleanupPaths: [
        path.dirname(path.resolve(String(preflightReady.ledgerEvidence.ledgerPath || '')))
      ],
      jobId: preflightReady.jobId
    };
  } finally {
    try { db.close(); } finally { verifiedLedger.db.close(); }
  }
}

module.exports = {
  accountStatements,
  applyPositionAccountSnapshot,
  inputEvidenceFor
};
