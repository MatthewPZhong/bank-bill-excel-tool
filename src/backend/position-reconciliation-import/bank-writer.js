'use strict';

const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const {
  BANK_STATEMENT_FIELDS
} = require('../../constants/bank-statement-fields');
const {
  BANK_SHEET_NAME,
  BANK_STATUSES
} = require('../../main-process/position-reconciliation/constants');
const {
  PositionReconciliationError,
  monthOf,
  normalizeDate,
  stableHash,
  text
} = require('../../main-process/position-reconciliation/common');
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
  serializeJson
} = require('../../main-process/position-reconciliation/store');
const {
  StableArrayHashAccumulator
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
  readerFor,
  updateDateRange
} = require('./preflight');
const {
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
    sourceType: 'position-bank',
    filePath: descriptor.archivePath,
    originalName: descriptor.fileName,
    sourceSnapshot: descriptor.stagedSnapshot,
    expectedSha256: descriptor.stagedSha256,
    sizeBytes: descriptor.stagedSizeBytes
  };
}

function bankScopeKey(channel, monthKey) {
  return `${text(channel)}\u0000${text(monthKey)}`;
}

function assertBankStatsMatch(actual, expected, sheetName) {
  const differences = [];
  for (const [key, label] of [
    ['scannedNonBlankRows', '扫描非空行数'],
    ['persistedCandidateRows', '持久化候选行数'],
    ['invalidRows', '非法行数']
  ]) {
    if (Number(actual[key]) !== Number(expected[key])) {
      differences.push(`${label}：预检=${Number(expected[key])}，写入=${Number(actual[key])}`);
    }
  }
  if (String(sheetName || '') !== String(expected.sheetName || '')) {
    differences.push(`sheet：预检=${expected.sheetName || '(空)'}，写入=${sheetName || '(空)'}`);
  }
  for (const [key, label] of [
    ['dateMin', '最小日期'],
    ['dateMax', '最大日期'],
    ['contentHash', '内容摘要']
  ]) {
    if ((actual[key] || null) !== (expected[key] || null)) {
      differences.push(`${label}与预检不一致`);
    }
  }
  if (differences.length > 0) {
    throw applyMismatch('银行对账单 apply 结果与预检不一致', differences);
  }
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

function initializeIncomingBankTables(db, ledgerDb) {
  db.exec(`
    CREATE TEMP TABLE incoming_bank_scopes(
      channel TEXT NOT NULL,
      month_key TEXT NOT NULL,
      row_count INTEGER NOT NULL,
      PRIMARY KEY(channel, month_key)
    ) WITHOUT ROWID;
  `);
  const insertScope = db.prepare(`
    INSERT INTO incoming_bank_scopes(channel, month_key, row_count)
    VALUES (?, ?, ?)
  `);
  for (const row of ledgerDb.prepare(`
    SELECT channel, month_key AS monthKey, row_count AS rowCount
    FROM bank_scopes
    ORDER BY channel, month_key
  `).iterate()) {
    insertScope.run(text(row.channel), text(row.monthKey), Number(row.rowCount));
  }
}

async function applyPositionBankBatch(input = {}) {
  const preflightReady = input.preflightReady || {};
  const descriptors = Array.isArray(preflightReady.acceptedBankFiles)
    ? preflightReady.acceptedBankFiles.slice().sort(
      (left, right) => Number(left.fileIndex) - Number(right.fileIndex)
    )
    : [];
  if (preflightReady.kind !== 'bank' || descriptors.length === 0) {
    throw applyMismatch('银行 apply 缺少完整的预检批次');
  }
  if (!descriptors.every((item) => item.status === 'ok' && item.sourceType === 'bank')) {
    throw applyMismatch('银行 apply 预检批次包含未接受文件');
  }

  const announcedRows = descriptors.reduce(
    (sum, file) => sum + Number(file.rowCount || file.persistedCandidateRows || 0),
    0
  );
  if (typeof input.onProgress === 'function') {
    input.onProgress({
      stage: 'preparing-apply',
      currentFile: null,
      totalFiles: descriptors.length,
      fileName: '',
      scannedRows: 0,
      acceptedRows: announcedRows,
      committedRows: 0,
      elapsedMs: 0
    });
  }
  const verifiedLedger = await verifySealedLedger(preflightReady.ledgerEvidence);
  const db = new DatabaseSync(path.resolve(String(input.sideDbPath || '')));
  const startedAt = Date.now();
  try {
    configureDatabase(db);
    assertPositionLargeImportSchema(db);
    if (positionLargeImportSchemaFingerprint(db) !== input.schemaFingerprint) {
      throw applyMismatch('银行写入前 schema fingerprint 已变化');
    }
    const expectedFiles = descriptors.map((descriptor) => (
      expectedLedgerFile(verifiedLedger, descriptor)
    ));
    for (const descriptor of descriptors) {
      await assertStagedInputUnchangedAsync(descriptor);
    }
    const totalRows = expectedFiles.reduce(
      (sum, file) => sum + Number(file.persistedCandidateRows),
      0
    );
    initializeIncomingBankTables(db, verifiedLedger.db);
    assertPositionImportDiskSpace({
      kind: 'bank',
      sideDbPath: input.sideDbPath,
      rowCount: totalRows,
      stagedBytes: descriptors.reduce(
        (sum, file) => sum + Number(file.stagedSizeBytes || 0),
        0
      ),
      ledgerBytes: Number(preflightReady.ledgerEvidence.ledgerSizeBytes || 0),
      availableBytes: input.availableBytes
    });
    const evidence = descriptors.map(inputEvidenceFor);
    const fileScopes = verifiedLedger.db.prepare(`
      SELECT first_file_index AS fileIndex, channel, month_key AS monthKey
      FROM bank_seen_biz_ids
      GROUP BY first_file_index, channel, month_key
      ORDER BY first_file_index, channel, month_key
    `).all().map((row) => ({
      fileIndex: Number(row.fileIndex),
      channel: text(row.channel),
      monthKey: text(row.monthKey)
    }));

    const mutation = await runPositionSideDbMutation({
      db,
      expectedCheckpoint: input.expectedCheckpoint,
      operationToken: input.operationToken,
      inputEvidence: evidence,
      fallbackSourceType: 'position-bank',
      requireExternalOperationToken: true,
      mutate: async () => {
        assertNotCancelled(input.cancelToken);
        if (typeof input.onProgress === 'function') {
          input.onProgress({
            stage: 'applying',
            currentFile: 1,
            totalFiles: descriptors.length,
            fileName: descriptors[0].fileName,
            scannedRows: 0,
            acceptedRows: totalRows,
            committedRows: 0,
            elapsedMs: Date.now() - startedAt
          });
        }
        db.exec(`
          DELETE FROM position_bank_rows
          WHERE EXISTS (
            SELECT 1
            FROM incoming_bank_scopes scope
            WHERE scope.channel = position_bank_rows.channel
              AND scope.month_key = position_bank_rows.month_key
          );
        `);

        const insert = db.prepare(`
          INSERT INTO position_bank_rows(
            biz_id, channel, month_key, bill_date, status,
            source_file_path, source_file_name, source_sheet, source_row_number,
            import_order, original_fund_type, working_fund_type,
            hit_summary, hit_type, match_detail, original_json, working_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '', '', '', ?, ?)
        `);
        const getExistingBankScope = db.prepare(`
          SELECT channel, month_key AS monthKey
          FROM position_bank_rows
          WHERE biz_id = ?
        `);
        const ledgerOwnerByBizId = verifiedLedger.db.prepare(`
          SELECT channel, month_key AS monthKey,
                 first_file_index AS fileIndex,
                 first_row_number AS rowNumber
          FROM bank_seen_biz_ids
          WHERE biz_id = ?
        `);
        let importOrder = 0;
        let committedRows = 0;
        const actualScopeCounts = new Map();
        for (let filePosition = 0; filePosition < descriptors.length; filePosition += 1) {
          const descriptor = descriptors[filePosition];
          const expected = expectedFiles[filePosition];
          const stats = emptyStats();
          const contentHash = new StableArrayHashAccumulator();
          let sheetName = '';
          const read = readerFor(descriptor.archivePath);
          const summary = await read(descriptor.archivePath, {
            kind: 'bank',
            cancelToken: input.cancelToken,
            allowMainThread: false,
            sstTempRoot: path.join(descriptor.stagingDir, 'sst-bank-apply'),
            ...(input.sstOptions || {}),
            onRow: ({ row, excelRowNumber, sheetName: detectedSheet }) => {
              sheetName = detectedSheet;
              stats.scannedNonBlankRows += 1;
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
              const ledgerOwner = ledgerOwnerByBizId.get(bizId);
              if (errors.length > 0
                  || !ledgerOwner
                  || text(ledgerOwner.channel) !== channel
                  || text(ledgerOwner.monthKey) !== monthKey
                  || Number(ledgerOwner.fileIndex) !== Number(descriptor.fileIndex)
                  || Number(ledgerOwner.rowNumber) !== Number(excelRowNumber)) {
                throw applyMismatch(
                  `银行对账单 apply 期间记录与 sealed ledger 不一致：第 ${excelRowNumber} 行`,
                  errors
                );
              }
              const serialized = serializeJson(bankRow);
              try {
                insert.run(
                  bizId,
                  channel,
                  monthKey,
                  billDate,
                  BANK_STATUSES.UNPROCESSED,
                  descriptor.filePath,
                  descriptor.fileName,
                  BANK_SHEET_NAME,
                  excelRowNumber,
                  importOrder,
                  text(bankRow.FundType),
                  text(bankRow.FundType),
                  serialized,
                  serialized
                );
              } catch (error) {
                const existing = getExistingBankScope.get(bizId);
                if (existing) {
                  throw new PositionReconciliationError(
                    'position-bank-existing-bizid-conflict',
                    '导入文件的 BizId 与其他 Channel 或月份中的银行数据冲突',
                    [
                      `BizId=${bizId}：已存在于 ${existing.channel}/${existing.monthKey}，` +
                      `本次文件位于 ${channel}/${monthKey}`
                    ]
                  );
                }
                throw error;
              }
              importOrder += 1;
              committedRows += 1;
              stats.persistedCandidateRows += 1;
              contentHash.append(bankRow);
              updateDateRange(stats, billDate);
              const key = bankScopeKey(channel, monthKey);
              actualScopeCounts.set(key, (actualScopeCounts.get(key) || 0) + 1);
              if (committedRows % POSITION_IMPORT_PROGRESS_ROW_INTERVAL === 0) {
                assertNotCancelled(input.cancelToken);
                if (typeof input.onProgress === 'function') {
                  input.onProgress({
                    stage: 'applying',
                    currentFile: filePosition + 1,
                    totalFiles: descriptors.length,
                    fileName: descriptor.fileName,
                    scannedRows: stats.scannedNonBlankRows,
                    acceptedRows: totalRows,
                    committedRows,
                    elapsedMs: Date.now() - startedAt
                  });
                }
              }
            }
          });
          sheetName = sheetName || summary.sheetName;
          stats.contentHash = contentHash.digest();
          assertBankStatsMatch(stats, expected, sheetName);
        }
        if (committedRows !== totalRows || importOrder !== totalRows) {
          throw applyMismatch(
            '银行对账单整批写入行数不守恒',
            [`预检 ${totalRows} 行，写入 ${committedRows} 行`]
          );
        }
        const scopes = db.prepare(`
          SELECT channel, month_key AS monthKey, row_count AS rowCount
          FROM incoming_bank_scopes
          ORDER BY channel, month_key
        `).all();
        for (const scope of scopes) {
          const key = bankScopeKey(scope.channel, scope.monthKey);
          if (Number(scope.rowCount) !== Number(actualScopeCounts.get(key) || 0)) {
            throw applyMismatch(`银行 scope ${scope.channel}/${scope.monthKey} 行数不一致`);
          }
          bumpRevision(db, 'bank', key);
        }
        bumpRevision(db, 'bank-global', 'all');
        assertNotCancelled(input.cancelToken);
        if (typeof input.onProgress === 'function') {
          input.onProgress({
            stage: 'committing',
            currentFile: descriptors.length,
            totalFiles: descriptors.length,
            fileName: descriptors[descriptors.length - 1].fileName,
            scannedRows: totalRows,
            acceptedRows: totalRows,
            committedRows: totalRows,
            elapsedMs: Date.now() - startedAt
          });
        }
        return {
          rowCount: totalRows,
          scopes: scopes.map(({ channel, monthKey }) => ({ channel, monthKey })),
          inputEvidence: evidence
        };
      }
    });
    return {
      ...mutation.result,
      nextCheckpoint: mutation.nextCheckpoint,
      inputPaths: descriptors.map((file) => file.archivePath),
      inputFiles: evidence,
      originalInputPaths: descriptors.map((file) => file.filePath),
      cleanupPaths: [
        path.dirname(path.resolve(String(preflightReady.ledgerEvidence.ledgerPath || '')))
      ],
      fileScopes,
      jobId: preflightReady.jobId
    };
  } finally {
    try { db.close(); } finally { verifiedLedger.db.close(); }
  }
}

module.exports = {
  applyPositionBankBatch,
  assertBankStatsMatch,
  bankScopeKey,
  initializeIncomingBankTables,
  inputEvidenceFor
};
