'use strict';

const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const {
  SOURCE_DEFINITIONS,
  SOURCE_TYPES
} = require('../../main-process/position-reconciliation/constants');
const {
  POSITION_IMPORT_STREAMING_SOURCE_ALLOWLIST
} = require('./constants');
const {
  PositionReconciliationError,
  stableHash,
  stableJson,
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
  parseJson,
  serializeJson
} = require('../../main-process/position-reconciliation/store');
const {
  StableArrayHashAccumulator,
  stableRowGuardHash,
  validateSourceRow
} = require('./contracts');
const {
  verifySealedLedger
} = require('./ledger');
const {
  emptyStats,
  readerFor,
  updateDateRange
} = require('./preflight');

const ORDINARY_SOURCE_TYPES = new Set([
  SOURCE_TYPES.FUND_TRANSFER,
  SOURCE_TYPES.TEST_PAYMENT,
  SOURCE_TYPES.GATEWAY_INBOUND,
  SOURCE_TYPES.GATEWAY_OUTBOUND
]);

function applyMismatch(message, detailLines = []) {
  return new PositionReconciliationError(
    'position-import-preflight-apply-mismatch',
    message,
    detailLines
  );
}

function cancelError() {
  return new PositionReconciliationError(
    'position-import-cancelled',
    '平盘导入已取消'
  );
}

function assertNotCancelled(cancelToken) {
  if (cancelToken && cancelToken.cancelled) throw cancelError();
}

function sameSnapshot(left, right) {
  return stableHash(left || null) === stableHash(right || null);
}

function expectedLedgerFile(verifiedLedger, descriptor) {
  const fileIndex = Number(descriptor && descriptor.fileIndex);
  const manifestFile = verifiedLedger.manifest.files.find(
    (file) => Number(file.fileIndex) === fileIndex
  );
  const ledgerFile = verifiedLedger.db.prepare(`
    SELECT file_index AS fileIndex, original_name AS originalName,
           staged_path AS stagedPath, source_type AS sourceType,
           sheet_name AS sheetName, sha256, size_bytes AS sizeBytes,
           source_snapshot_json AS sourceSnapshotJson,
           preflight_status AS preflightStatus,
           scanned_non_blank_rows AS scannedNonBlankRows,
           persisted_candidate_rows AS persistedCandidateRows,
           collapsed_duplicate_rows AS collapsedDuplicateRows,
           reader_filtered_rows AS readerFilteredRows,
           invalid_rows AS invalidRows, visible_link_rows AS visibleLinkRows,
           hidden_link_rows AS hiddenLinkRows,
           derived_zero_source_rows AS derivedZeroSourceRows,
           date_min AS dateMin, date_max AS dateMax, content_hash AS contentHash
    FROM job_files
    WHERE file_index = ?
  `).get(fileIndex);
  if (!manifestFile || !ledgerFile) {
    throw applyMismatch('sealed ledger 缺少待提交文件');
  }
  let sourceSnapshot;
  try {
    sourceSnapshot = JSON.parse(ledgerFile.sourceSnapshotJson);
  } catch (_error) {
    throw applyMismatch('sealed ledger 的文件快照损坏');
  }
  const expected = {
    ...ledgerFile,
    sourceSnapshot
  };
  if (expected.preflightStatus !== 'accepted'
      || path.resolve(expected.stagedPath) !== path.resolve(String(descriptor.archivePath || ''))
      || expected.originalName !== String(descriptor.fileName || '')
      || expected.sourceType !== String(descriptor.sourceType || '')
      || expected.sheetName !== String(descriptor.sheetName || '')
      || expected.sha256 !== String(descriptor.stagedSha256 || '').toLowerCase()
      || Number(expected.sizeBytes) !== Number(descriptor.stagedSizeBytes)
      || !sameSnapshot(expected.sourceSnapshot, descriptor.stagedSnapshot)
      || stableHash(manifestFile) !== stableHash({
        fileIndex: expected.fileIndex,
        originalName: expected.originalName,
        sourceType: expected.sourceType,
        sheetName: expected.sheetName,
        sha256: expected.sha256,
        sizeBytes: expected.sizeBytes,
        sourceSnapshot: expected.sourceSnapshot,
        preflightStatus: expected.preflightStatus,
        scannedNonBlankRows: expected.scannedNonBlankRows,
        persistedCandidateRows: expected.persistedCandidateRows,
        collapsedDuplicateRows: expected.collapsedDuplicateRows,
        readerFilteredRows: expected.readerFilteredRows,
        invalidRows: expected.invalidRows,
        visibleLinkRows: expected.visibleLinkRows,
        hiddenLinkRows: expected.hiddenLinkRows,
        derivedZeroSourceRows: expected.derivedZeroSourceRows,
        dateMin: expected.dateMin,
        dateMax: expected.dateMax,
        contentHash: expected.contentHash,
        firstErrorCode: null,
        firstErrorMessage: null,
        firstErrorDetailLines: []
      })) {
    throw applyMismatch('待提交文件与 sealed ledger manifest 不一致');
  }
  return expected;
}

function assertSourceStatsMatch(actual, expected, sourceType, sheetName) {
  const fields = [
    ['scannedNonBlankRows', '扫描非空行数'],
    ['persistedCandidateRows', '持久化候选行数'],
    ['collapsedDuplicateRows', '完全重复折叠行数'],
    ['readerFilteredRows', '读取过滤行数'],
    ['invalidRows', '非法行数'],
    ['visibleLinkRows', '可见链接行数'],
    ['hiddenLinkRows', '隐藏链接行数'],
    ['derivedZeroSourceRows', '零派生来源行数']
  ];
  const differences = [];
  for (const [key, label] of fields) {
    if (Number(actual[key]) !== Number(expected[key])) {
      differences.push(`${label}：预检=${Number(expected[key])}，写入=${Number(actual[key])}`);
    }
  }
  if (String(sourceType || '') !== String(expected.sourceType || '')) {
    differences.push(`来源类型：预检=${expected.sourceType || '(空)'}，写入=${sourceType || '(空)'}`);
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
    throw applyMismatch('链接原始表 apply 结果与预检不一致', differences);
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
    sourceType: descriptor.sourceType,
    filePath: descriptor.archivePath,
    originalName: descriptor.fileName,
    sourceSnapshot: descriptor.stagedSnapshot,
    expectedSha256: descriptor.stagedSha256,
    sizeBytes: descriptor.stagedSizeBytes
  };
}

function assertStoredSourceIdentity(existing, row, businessKey) {
  if (!existing) return;
  const stored = parseJson(
    existing.rawJson,
    `来源记录 ${existing.sourceType}/${existing.businessKey}`
  );
  if (stableJson(stored) !== stableJson(row)
      || text(existing.businessKey) !== text(businessKey)) {
    throw new PositionReconciliationError(
      'position-source-record-hash-collision',
      '来源记录 row_hash 对应了不同规范内容，已停止写入'
    );
  }
}

function initializeApplyIdentityTable(db) {
  db.exec(`
    PRAGMA temp_store=FILE;
    CREATE TEMP TABLE IF NOT EXISTS position_import_apply_seen_records (
      source_type TEXT NOT NULL,
      row_hash TEXT NOT NULL,
      row_guard_hash TEXT NOT NULL,
      business_key TEXT NOT NULL,
      first_file_index INTEGER NOT NULL,
      first_row_number INTEGER NOT NULL,
      PRIMARY KEY(source_type, row_hash)
    ) WITHOUT ROWID;
    DELETE FROM position_import_apply_seen_records;
  `);
}

function sourceStatements(db, ledgerDb) {
  return {
    ledgerOwner: ledgerDb.prepare(`
      SELECT business_key AS businessKey, row_guard_hash AS rowGuardHash,
             first_file_index AS firstFileIndex,
             first_row_number AS firstRowNumber
      FROM source_seen_records
      WHERE source_type = ? AND row_hash = ?
    `),
    claimApplyOwner: db.prepare(`
      INSERT INTO position_import_apply_seen_records(
        source_type, row_hash, row_guard_hash, business_key,
        first_file_index, first_row_number
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(source_type, row_hash) DO NOTHING
    `),
    findApplyOwner: db.prepare(`
      SELECT business_key AS businessKey, row_guard_hash AS rowGuardHash,
             first_file_index AS firstFileIndex,
             first_row_number AS firstRowNumber
      FROM position_import_apply_seen_records
      WHERE source_type = ? AND row_hash = ?
    `),
    findSource: db.prepare(`
      SELECT source_type AS sourceType, business_key AS businessKey,
             raw_json AS rawJson
      FROM position_source_rows
      WHERE source_type = ? AND row_hash = ?
    `),
    upsertSource: db.prepare(`
      INSERT INTO position_source_rows(
        source_type, business_key, event_date, month_key,
        source_file_path, source_file_name, source_sheet, source_row_number,
        row_hash, raw_json, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(source_type, row_hash) DO UPDATE SET
        business_key = excluded.business_key,
        event_date = excluded.event_date,
        month_key = excluded.month_key,
        source_file_path = excluded.source_file_path,
        source_file_name = excluded.source_file_name,
        source_sheet = excluded.source_sheet,
        source_row_number = excluded.source_row_number,
        raw_json = excluded.raw_json,
        updated_at = CURRENT_TIMESTAMP
      RETURNING id
    `),
    deleteLinks: db.prepare(
      'DELETE FROM position_link_rows WHERE source_row_id = ?'
    ),
    insertLink: db.prepare(`
      INSERT INTO position_link_rows(
        source_type, business_key, source_record_key, source_row_id,
        source_row_number, ordinal, leg_index, recon_id, merchant_id,
        currency, amount, fund_type, status, event_date, visible, linked_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
  };
}

async function applySourceFile({
  db,
  verifiedLedger,
  descriptor,
  expectedCheckpoint,
  operationToken,
  schemaFingerprint,
  cancelToken,
  mappings,
  sstOptions,
  onProgress,
  startedAt
}) {
  const expected = expectedLedgerFile(verifiedLedger, descriptor);
  const sourceType = String(descriptor.sourceType || '');
  if (!ORDINARY_SOURCE_TYPES.has(sourceType)) {
    throw new PositionReconciliationError(
      'position-streaming-source-type-disabled',
      `当前流式 writer 不支持来源类型：${sourceType || '(空)'}`
    );
  }
  await assertStagedInputUnchangedAsync(descriptor);
  assertNotCancelled(cancelToken);
  const evidence = inputEvidenceFor(descriptor);

  const mutation = await runPositionSideDbMutation({
    db,
    expectedCheckpoint,
    operationToken,
    inputEvidence: [evidence],
    fallbackSourceType: sourceType,
    requireExternalOperationToken: true,
    mutate: async () => {
      assertPositionLargeImportSchema(db);
      if (positionLargeImportSchemaFingerprint(db) !== schemaFingerprint) {
        throw applyMismatch('链接原始表写入时 schema fingerprint 已变化');
      }
      const statements = sourceStatements(db, verifiedLedger.db);
      const stats = emptyStats();
      const contentHash = new StableArrayHashAccumulator();
      let detectedSourceType = '';
      let sheetName = '';
      const read = readerFor(descriptor.archivePath);
      const summary = await read(descriptor.archivePath, {
        kind: 'source',
        cancelToken,
        allowMainThread: false,
        sstTempRoot: path.join(descriptor.stagingDir, 'sst-apply'),
        ...(sstOptions || {}),
        onRow: ({
          row,
          excelRowNumber,
          sourceType: detectedType,
          sheetName: detectedSheet
        }) => {
          detectedSourceType = detectedType;
          sheetName = detectedSheet;
          stats.scannedNonBlankRows += 1;
          if (stats.scannedNonBlankRows % 10000 === 0) {
            assertNotCancelled(cancelToken);
            if (typeof onProgress === 'function') {
              onProgress({
                stage: 'applying',
                currentFile: descriptor.fileIndex + 1,
                fileName: descriptor.fileName,
                scannedRows: stats.scannedNonBlankRows,
                acceptedRows: expected.persistedCandidateRows,
                committedRows: 0,
                elapsedMs: Date.now() - startedAt
              });
            }
          }
          if (detectedSourceType !== sourceType) {
            throw applyMismatch('链接原始表 apply 期间来源类型发生变化');
          }
          const validation = validateSourceRow(sourceType, row);
          if (validation.errors.length > 0) {
            stats.invalidRows += 1;
            throw applyMismatch(
              `链接原始表 apply 期间出现非法行：第 ${excelRowNumber} 行`,
              validation.errors
            );
          }
          const rowHash = stableHash(row);
          const rowGuardHash = stableRowGuardHash(row);
          const owner = statements.ledgerOwner.get(sourceType, rowHash);
          if (!owner
              || text(owner.businessKey) !== text(validation.businessKey)
              || String(owner.rowGuardHash || '') !== rowGuardHash) {
            throw new PositionReconciliationError(
              'position-source-record-hash-collision',
              `来源记录摘要无法与 sealed ledger 对齐：第 ${excelRowNumber} 行`
            );
          }
          statements.claimApplyOwner.run(
            sourceType,
            rowHash,
            rowGuardHash,
            validation.businessKey,
            descriptor.fileIndex,
            excelRowNumber
          );
          const applyOwner = statements.findApplyOwner.get(sourceType, rowHash);
          if (!applyOwner
              || text(applyOwner.businessKey) !== text(validation.businessKey)
              || String(applyOwner.rowGuardHash || '') !== rowGuardHash
              || Number(applyOwner.firstFileIndex) !== Number(owner.firstFileIndex)
              || Number(applyOwner.firstRowNumber) !== Number(owner.firstRowNumber)) {
            throw new PositionReconciliationError(
              'position-source-record-hash-collision',
              `来源记录摘要在 apply 去重表中发生冲突：第 ${excelRowNumber} 行`
            );
          }
          if (Number(owner.firstFileIndex) !== Number(descriptor.fileIndex)
              || Number(owner.firstRowNumber) !== Number(excelRowNumber)) {
            stats.collapsedDuplicateRows += 1;
            return;
          }

          const existing = statements.findSource.get(sourceType, rowHash);
          assertStoredSourceIdentity(existing, row, validation.businessKey);
          const rawJson = serializeJson(row);
          const inserted = statements.upsertSource.get(
            sourceType,
            validation.businessKey,
            validation.eventDate || null,
            validation.monthKey || null,
            descriptor.filePath,
            descriptor.fileName,
            sheetName,
            excelRowNumber,
            rowHash,
            rawJson
          );
          const sourceRowId = Number(inserted && inserted.id);
          if (!Number.isSafeInteger(sourceRowId) || sourceRowId < 1) {
            throw applyMismatch('来源记录 upsert 未返回有效 source_row_id');
          }
          statements.deleteLinks.run(sourceRowId);
          const record = {
            sourceType,
            businessKey: validation.businessKey,
            sourceRecordKey: rowHash,
            sourceRowId,
            eventDate: validation.eventDate,
            monthKey: validation.monthKey,
            sourceRowNumber: excelRowNumber,
            row
          };
          const derived = deriveLinkedRowsForRecord(sourceType, record, mappings);
          if (derived.length === 0) stats.derivedZeroSourceRows += 1;
          for (const item of derived) {
            const linked = item.row;
            statements.insertLink.run(
              sourceType,
              validation.businessKey,
              rowHash,
              sourceRowId,
              excelRowNumber,
              sourceRowId,
              item.legIndex,
              text(linked.ReconID),
              text(linked.MerchantId),
              text(linked.Currency),
              text(linked.Amount),
              text(linked.FundType),
              text(linked['调拨状态'] || linked['付款状态']),
              text(
                linked['交易时间']
                || linked['创建时间']
                || linked.billDate
                || linked['账单日期']
              ),
              item.visible === false ? 0 : 1,
              serializeJson(linked)
            );
            if (item.visible === false) stats.hiddenLinkRows += 1;
            else stats.visibleLinkRows += 1;
          }
          contentHash.append(row);
          stats.persistedCandidateRows += 1;
          updateDateRange(stats, validation.eventDate);
        }
      });
      detectedSourceType = detectedSourceType || summary.sourceType;
      sheetName = sheetName || summary.sheetName;
      stats.contentHash = contentHash.digest();
      assertSourceStatsMatch(stats, expected, detectedSourceType, sheetName);
      assertNotCancelled(cancelToken);
      bumpRevision(db, 'source', sourceType);
      bumpRevision(db, 'linked', sourceType);
      const linkedRowCount = Number(db.prepare(`
        SELECT COUNT(*) AS count
        FROM position_link_rows
        WHERE source_type = ? AND visible = 1
      `).get(sourceType).count);
      return {
        sourceType,
        sourceName: SOURCE_DEFINITIONS[sourceType].sourceName,
        linkedName: SOURCE_DEFINITIONS[sourceType].linkedName,
        rowCount: stats.persistedCandidateRows,
        linkedRowCount,
        collapsedDuplicateCount: stats.collapsedDuplicateRows,
        contentHash: stats.contentHash
      };
    }
  });

  if (typeof onProgress === 'function') {
    onProgress({
      stage: 'committed',
      currentFile: descriptor.fileIndex + 1,
      fileName: descriptor.fileName,
      scannedRows: expected.scannedNonBlankRows,
      acceptedRows: expected.persistedCandidateRows,
      committedRows: expected.persistedCandidateRows,
      elapsedMs: Date.now() - startedAt
    });
  }
  return {
    ...mutation.result,
    nextCheckpoint: mutation.nextCheckpoint,
    inputEvidence: evidence
  };
}

function normalizeAllowedSourceTypes(value) {
  const stageAllowlist = new Set(POSITION_IMPORT_STREAMING_SOURCE_ALLOWLIST);
  const requested = (value instanceof Set ? [...value] : Array.isArray(value) ? value : [])
    .map((item) => String(item || '').trim())
    .filter(Boolean);
  const unsupported = requested.filter((item) => !stageAllowlist.has(item));
  if (unsupported.length > 0) {
    throw new PositionReconciliationError(
      'position-streaming-source-type-disabled',
      '当前阶段尚未开放所请求的流式来源类型',
      unsupported
    );
  }
  return new Set(requested);
}

async function applyPositionOrdinarySourceFiles(input = {}) {
  const preflightReady = input.preflightReady || {};
  const accepted = Array.isArray(preflightReady.acceptedOrdinaryInputFiles)
    ? preflightReady.acceptedOrdinaryInputFiles.slice().sort(
      (left, right) => Number(left.fileIndex) - Number(right.fileIndex)
    )
    : [];
  const allowed = normalizeAllowedSourceTypes(input.allowedSourceTypes);
  if (accepted.length === 0) {
    throw new PositionReconciliationError(
      'position-streaming-source-empty',
      '没有可提交的普通链接原始表'
    );
  }
  if (preflightReady.accountConfirmationDescriptor) {
    throw new PositionReconciliationError(
      'position-streaming-source-type-disabled',
      '当前阶段的流式导入不支持与清结算银行账户表混合选择'
    );
  }
  const enabled = accepted.filter((file) => allowed.has(file.sourceType));

  const verifiedLedger = await verifySealedLedger(preflightReady.ledgerEvidence);
  const db = new DatabaseSync(path.resolve(String(input.sideDbPath || '')));
  const startedAt = Date.now();
  let checkpoint = input.grant.baseCheckpoint;
  const appliedByIndex = new Map();
  try {
    db.exec('PRAGMA foreign_keys=ON;');
    db.exec('PRAGMA synchronous=NORMAL;');
    db.exec('PRAGMA busy_timeout=30000;');
    db.exec('PRAGMA cache_size=-2048;');
    db.exec('PRAGMA mmap_size=0;');
    db.exec('PRAGMA temp_store=FILE;');
    db.exec('PRAGMA journal_mode=WAL;');
    assertPositionLargeImportSchema(db);
    if (positionLargeImportSchemaFingerprint(db) !== input.grant.schemaFingerprint) {
      throw applyMismatch('普通来源写入前 schema fingerprint 与 grant 不一致');
    }
    const mappings = db.prepare(`
      SELECT mid_account_id AS midAccountId,
             clearing_account_id AS clearingAccountId
      FROM position_account_mappings
      ORDER BY rowid
    `).all();
    initializeApplyIdentityTable(db);
    for (const descriptor of enabled) {
      assertNotCancelled(input.cancelToken);
      const applied = await applySourceFile({
        db,
        verifiedLedger,
        descriptor,
        expectedCheckpoint: checkpoint,
        operationToken: input.grant.operationToken,
        schemaFingerprint: input.grant.schemaFingerprint,
        cancelToken: input.cancelToken,
        mappings,
        sstOptions: input.sstOptions,
        onProgress: input.onProgress,
        startedAt
      });
      checkpoint = applied.nextCheckpoint;
      appliedByIndex.set(Number(descriptor.fileIndex), applied);
      db.exec('PRAGMA shrink_memory;');
      if (typeof input.onFileCommitted === 'function') {
        input.onFileCommitted({
          fileIndex: Number(descriptor.fileIndex),
          fileName: descriptor.fileName,
          sourceType: descriptor.sourceType,
          committedRows: applied.rowCount,
          checkpoint
        });
      }
    }

    const results = (Array.isArray(preflightReady.orderedFileResults)
      ? preflightReady.orderedFileResults
      : []).map((item) => {
      const applied = appliedByIndex.get(Number(item.fileIndex));
      if (!applied) return item;
      return {
        ...item,
        status: 'ok',
        inputPaths: [item.archivePath],
        inputFiles: [applied.inputEvidence],
        originalInputPaths: [item.filePath],
        cleanupPaths: [item.stagingDir],
        sourceName: applied.sourceName,
        linkedName: applied.linkedName,
        rowCount: applied.rowCount,
        linkedRowCount: applied.linkedRowCount,
        collapsedDuplicateCount: applied.collapsedDuplicateCount,
        contentHash: applied.contentHash,
        applied: true
      };
    });
    const success = results.filter((item) => item.status === 'ok' && item.applied === true);
    const failed = results.filter((item) => item.status === 'failed');
    return {
      ...preflightReady,
      status: success.length > 0 ? 'ok' : 'failed',
      message:
        `链接原始表导入完成：成功 ${success.length}，待确认 0，失败 ${failed.length}`,
      results,
      orderedFileResults: results,
      successCount: success.length,
      failedCount: failed.length,
      confirmationCount: 0,
      archiveDeferred: false,
      inputPaths: success.flatMap((item) => item.inputPaths || []),
      inputFiles: success.flatMap((item) => item.inputFiles || []),
      cleanupPaths: success.flatMap((item) => item.cleanupPaths || []),
      checkpoint
    };
  } finally {
    try { db.close(); } finally { verifiedLedger.db.close(); }
  }
}

module.exports = {
  ORDINARY_SOURCE_TYPES,
  applySourceFile,
  applyPositionOrdinarySourceFiles,
  assertSourceStatsMatch,
  expectedLedgerFile,
  initializeApplyIdentityTable
};
