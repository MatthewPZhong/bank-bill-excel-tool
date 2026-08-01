'use strict';

const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const {
  SOURCE_DEFINITIONS,
  SOURCE_TYPES
} = require('../../main-process/position-reconciliation/constants');
const {
  POSITION_IMPORT_PROGRESS_ROW_INTERVAL,
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
  refreshPositionSourceSummary
} = require('../../main-process/position-reconciliation/source-summary-cache');
const {
  parseJson,
  serializeJson
} = require('../../main-process/position-reconciliation/store');
const {
  StableArrayHashAccumulator,
  classifySourceRow,
  stableRowGuardHash
} = require('./contracts');
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
           filtered_rows AS filteredRows,
           collapsed_duplicate_rows AS collapsedDuplicateRows,
           reader_filtered_rows AS readerFilteredRows,
           invalid_rows AS invalidRows, visible_link_rows AS visibleLinkRows,
           hidden_link_rows AS hiddenLinkRows,
           derived_zero_source_rows AS derivedZeroSourceRows,
           date_min AS dateMin, date_max AS dateMax, content_hash AS contentHash,
           filter_reason_json AS filterReasonJson
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
    sourceSnapshot,
    filterReasonCounts: parseJson(
      ledgerFile.filterReasonJson,
      'sealed ledger filter reason counts'
    )
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
        filteredRows: expected.filteredRows,
        collapsedDuplicateRows: expected.collapsedDuplicateRows,
        readerFilteredRows: expected.readerFilteredRows,
        invalidRows: expected.invalidRows,
        visibleLinkRows: expected.visibleLinkRows,
        hiddenLinkRows: expected.hiddenLinkRows,
        derivedZeroSourceRows: expected.derivedZeroSourceRows,
        dateMin: expected.dateMin,
        dateMax: expected.dateMax,
        contentHash: expected.contentHash,
        filterReasonCounts: expected.filterReasonCounts,
        firstErrorCode: null,
        firstErrorMessage: null,
        firstErrorDetailLines: []
      })) {
    throw applyMismatch('待提交文件与 sealed ledger manifest 不一致');
  }
  return expected;
}

async function verifyAnomalyReportEvidence(verifiedLedger, preflightReady) {
  const manifestReport = verifiedLedger.manifest.anomalyReport || null;
  const manifestReports = Array.isArray(verifiedLedger.manifest.anomalyReports)
    ? verifiedLedger.manifest.anomalyReports
    : [];
  const report = preflightReady && preflightReady.anomalyReport
    ? preflightReady.anomalyReport
    : null;
  const reports = preflightReady && Array.isArray(preflightReady.anomalyReports)
    ? preflightReady.anomalyReports
    : [];
  const filteredFiles = verifiedLedger.manifest.files.filter((file) => (
    file.preflightStatus === 'accepted' && Number(file.filteredRows) > 0
  ));
  const filteredRows = filteredFiles.reduce(
    (total, file) => total + Number(file.filteredRows),
    0
  );
  if (filteredRows === 0) {
    if (manifestReport || report || manifestReports.length > 0 || reports.length > 0) {
      throw applyMismatch('sealed ledger 在无过滤行时错误地携带异常报告');
    }
    return {
      aggregateReport: null,
      byFileIndex: new Map(),
      filteredFileIndexes: []
    };
  }
  if (!manifestReport
      || !report
      || stableHash(manifestReport) !== stableHash(report)
      || Number(report.filteredRowCount) !== filteredRows
      || stableHash(manifestReports) !== stableHash(reports)) {
    throw applyMismatch('异常报告证据与 sealed ledger manifest 不一致');
  }
  const expectedByIndex = new Map(filteredFiles.map((file) => [
    Number(file.fileIndex),
    Number(file.filteredRows)
  ]));
  const expectedIndexes = [...expectedByIndex.keys()].sort((left, right) => left - right);
  const expectedReportCount = expectedIndexes.length === 1
    ? 1
    : expectedIndexes.length + 1;
  if (reports.length !== expectedReportCount) {
    throw applyMismatch('异常报告分片数量与 sealed ledger 不一致');
  }
  const reportIdentities = new Set();
  const verifiedReports = [];
  for (const item of reports) {
    const sourceFileIndexes = Array.isArray(item && item.sourceFileIndexes)
      ? [...new Set(item.sourceFileIndexes.map(Number))].sort((left, right) => left - right)
      : [];
    if (sourceFileIndexes.length === 0
        || sourceFileIndexes.some((fileIndex) => !expectedByIndex.has(fileIndex))) {
      throw applyMismatch('异常报告引用了 sealed ledger 之外的文件');
    }
    const expectedRows = sourceFileIndexes.reduce(
      (total, fileIndex) => total + expectedByIndex.get(fileIndex),
      0
    );
    const identity = `${text(item.reportKey)}\u0000${path.resolve(text(item.filePath))}`;
    if (reportIdentities.has(identity)
        || Number(item.filteredRowCount) !== expectedRows) {
      throw applyMismatch('异常报告分片身份或过滤行数与 sealed ledger 不一致');
    }
    reportIdentities.add(identity);
    try {
      await assertStagedInputUnchangedAsync({
        archivePath: item.filePath,
        stagedSnapshot: item.sourceSnapshot,
        stagedSha256: item.sha256,
        stagedSizeBytes: item.sizeBytes
      });
    } catch (error) {
      throw new PositionReconciliationError(
        'position-anomaly-report-integrity-invalid',
        '平盘来源异常报告缺失或内容校验失败，禁止写入数据库',
        [error && error.message ? error.message : String(error)]
      );
    }
    verifiedReports.push({ item, sourceFileIndexes });
  }
  const aggregate = verifiedReports.find((item) => (
    stableHash(item.item) === stableHash(report)
  ));
  if (!aggregate || stableHash(aggregate.sourceFileIndexes) !== stableHash(expectedIndexes)) {
    throw applyMismatch('批次异常报告没有覆盖全部过滤文件');
  }
  const byFileIndex = new Map();
  for (const fileIndex of expectedIndexes) {
    if (expectedIndexes.length === 1) {
      byFileIndex.set(fileIndex, aggregate.item);
      continue;
    }
    const shard = verifiedReports.find((item) => (
      item.sourceFileIndexes.length === 1 && item.sourceFileIndexes[0] === fileIndex
    ));
    if (!shard) throw applyMismatch(`过滤文件 ${fileIndex + 1} 缺少独立异常报告`);
    byFileIndex.set(fileIndex, shard.item);
  }
  return {
    aggregateReport: aggregate.item,
    byFileIndex,
    filteredFileIndexes: expectedIndexes
  };
}

function assertSourceStatsMatch(actual, expected, sourceType, sheetName) {
  const fields = [
    ['scannedNonBlankRows', '扫描非空行数'],
    ['persistedCandidateRows', '持久化候选行数'],
    ['filteredRows', '过滤行数'],
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
  if (stableHash(actual.filterReasonCounts || {})
      !== stableHash(expected.filterReasonCounts || {})) {
    differences.push('过滤原因统计与预检不一致');
  }
  if (differences.length > 0) {
    throw applyMismatch('链接原始表 apply 结果与预检不一致', differences);
  }
}

function bumpRevision(db, kind, key) {
  const row = db.prepare(`
    INSERT INTO position_revisions(kind, scope_key, revision, updated_at)
    VALUES (?, ?, 1, CURRENT_TIMESTAMP)
    ON CONFLICT(kind, scope_key) DO UPDATE SET
      revision = position_revisions.revision + 1,
      updated_at = CURRENT_TIMESTAMP
    RETURNING revision
  `).get(kind, key);
  return Number(row && row.revision);
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
             disposition,
             first_file_index AS firstFileIndex,
             first_row_number AS firstRowNumber
      FROM source_seen_records
      WHERE source_type = ? AND row_hash = ?
    `),
    ledgerFilteredRow: ledgerDb.prepare(`
      SELECT report_row_key AS reportRowKey, source_type AS sourceType,
             business_key AS businessKey, recon_id AS reconId,
             event_date AS eventDate, month_key AS monthKey,
             error_code AS errorCode, error_reason AS errorReason,
             row_hash AS rowHash, row_guard_hash AS rowGuardHash,
             is_owner AS isOwner
      FROM filtered_source_rows
      WHERE source_file_index = ? AND source_row_number = ?
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
    findSourceByBusinessKey: db.prepare(`
      SELECT id
      FROM position_source_rows
      WHERE source_type = ? AND business_key = ?
      LIMIT 1
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
    `),
    resolveExactFiltered: db.prepare(`
      UPDATE position_filtered_source_rows
      SET resolved_at = CURRENT_TIMESTAMP,
          resolution_reason = 'same-anomaly-reimported'
      WHERE source_type = ? AND row_hash = ? AND resolved_at IS NULL
    `),
    resolveFilteredByBusinessKey: db.prepare(`
      UPDATE position_filtered_source_rows
      SET resolved_at = CURRENT_TIMESTAMP,
          resolution_reason = 'normal-source-imported'
      WHERE source_type = ? AND business_key = ? AND resolved_at IS NULL
    `),
    insertFiltered: db.prepare(`
      INSERT INTO position_filtered_source_rows(
        report_row_key, source_type, business_key, recon_id,
        event_date, month_key, error_code, error_reason,
        source_file_path, source_file_name, source_sheet, source_row_number,
        row_hash, import_operation_token, archive_operation_key,
        report_key, report_artifact_key, report_file_path, report_file_name,
        report_sha256, report_size_bytes, report_row_count
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
  startedAt,
  ledgerSizeBytes,
  availableBytes,
  sideDbPath,
  anomalyReport
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
  assertPositionImportDiskSpace({
    kind: 'source',
    sideDbPath,
    rowCount:
      Number(expected.persistedCandidateRows) + Number(expected.filteredRows),
    stagedBytes: Number(descriptor.stagedSizeBytes || 0),
    ledgerBytes: Number(ledgerSizeBytes || 0),
    availableBytes
  });
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
          if (stats.scannedNonBlankRows % POSITION_IMPORT_PROGRESS_ROW_INTERVAL === 0) {
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
          const classification = classifySourceRow(sourceType, row);
          const validation = classification.validation;
          if (classification.disposition === 'invalid') {
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
              || String(owner.rowGuardHash || '') !== rowGuardHash
              || String(owner.disposition || '') !== classification.disposition) {
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
            if (classification.disposition === 'filtered') {
              const duplicateFiltered = statements.ledgerFilteredRow.get(
                descriptor.fileIndex,
                excelRowNumber
              );
              if (!duplicateFiltered
                  || Number(duplicateFiltered.isOwner) !== 0
                  || duplicateFiltered.rowHash !== rowHash
                  || duplicateFiltered.rowGuardHash !== rowGuardHash) {
                throw applyMismatch(
                  `过滤重复行无法与 sealed ledger 对齐：第 ${excelRowNumber} 行`
                );
              }
            }
            stats.collapsedDuplicateRows += 1;
            return;
          }

          if (classification.disposition === 'filtered') {
            const filtered = statements.ledgerFilteredRow.get(
              descriptor.fileIndex,
              excelRowNumber
            );
            const filter = classification.filter;
            if (!filtered
                || Number(filtered.isOwner) !== 1
                || filtered.sourceType !== sourceType
                || filtered.businessKey !== validation.businessKey
                || filtered.rowHash !== rowHash
                || filtered.rowGuardHash !== rowGuardHash
                || filtered.errorCode !== filter.code
                || filtered.errorReason !== filter.reason
                || !anomalyReport) {
              throw applyMismatch(
                `过滤行无法与 sealed ledger 或异常报告对齐：第 ${excelRowNumber} 行`
              );
            }
            if (statements.findSourceByBusinessKey.get(
              sourceType,
              validation.businessKey
            )) {
              throw new PositionReconciliationError(
                'position-filtered-key-collision',
                `过滤行业务单号已存在正常记录，整份文件禁止写入：${descriptor.fileName}`,
                [validation.businessKey]
              );
            }
            statements.resolveExactFiltered.run(sourceType, rowHash);
            statements.insertFiltered.run(
              filtered.reportRowKey,
              sourceType,
              validation.businessKey,
              filter.reconId,
              validation.eventDate || null,
              validation.monthKey || null,
              filter.code,
              filter.reason,
              descriptor.filePath,
              descriptor.fileName,
              sheetName,
              excelRowNumber,
              rowHash,
              operationToken,
              `position:${operationToken}:position-reconciliation:source:prepare-import`,
              anomalyReport.reportKey,
              anomalyReport.artifactKey,
              anomalyReport.filePath,
              anomalyReport.fileName,
              anomalyReport.sha256,
              Number(anomalyReport.sizeBytes),
              Number(anomalyReport.filteredRowCount)
            );
            stats.filteredRows += 1;
            stats.filterReasonCounts[filter.code] =
              Number(stats.filterReasonCounts[filter.code] || 0) + 1;
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
          statements.resolveFilteredByBusinessKey.run(
            sourceType,
            validation.businessKey
          );
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
      const sourceRevision = bumpRevision(db, 'source', sourceType);
      const linkedRevision = bumpRevision(db, 'linked', sourceType);
      const sourceSummary = refreshPositionSourceSummary(db, sourceType, {
        onPhase: (phase) => {
          if (typeof onProgress !== 'function') return;
          onProgress({
            stage: 'summarizing',
            summaryPhase: phase,
            currentFile: descriptor.fileIndex + 1,
            fileName: descriptor.fileName,
            scannedRows: stats.scannedNonBlankRows,
            acceptedRows: stats.persistedCandidateRows,
            committedRows: 0,
            elapsedMs: Date.now() - startedAt
          });
        }
      });
      if (typeof onProgress === 'function') {
        onProgress({
          stage: 'committing',
          currentFile: descriptor.fileIndex + 1,
          fileName: descriptor.fileName,
          scannedRows: stats.scannedNonBlankRows,
          acceptedRows: stats.persistedCandidateRows,
          committedRows: stats.persistedCandidateRows,
          elapsedMs: Date.now() - startedAt
        });
      }
      return {
        sourceType,
        sourceName: SOURCE_DEFINITIONS[sourceType].sourceName,
        linkedName: SOURCE_DEFINITIONS[sourceType].linkedName,
        rowCount: stats.persistedCandidateRows,
        physicalRowCount: stats.scannedNonBlankRows,
        filteredRowCount: stats.filteredRows,
        filterReasonCounts: stats.filterReasonCounts,
        generatedLinkRowCount:
          Number(stats.visibleLinkRows) + Number(stats.hiddenLinkRows),
        linkedRowCount: sourceSummary.linkedRowCount,
        collapsedDuplicateCount: stats.collapsedDuplicateRows,
        contentHash: stats.contentHash,
        sourceRevision,
        linkedRevision
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

function reportKeyOf(value) {
  return text(value && (
    value.reportKey
    || (value.metadata && value.metadata.reportKey)
  ));
}

function outputDependenciesSatisfied(file, committedInputPaths) {
  const dependencies = Array.isArray(file && file.requiredInputPaths)
    ? file.requiredInputPaths.map((item) => path.resolve(String(item || '')))
    : [];
  return dependencies.length > 0
    && dependencies.every((item) => committedInputPaths.has(item));
}

function retainedCommittedAnomalyArtifacts(preflightReady, results) {
  const successful = results.filter((item) => item.status === 'ok' && item.applied === true);
  const committedInputPaths = new Set(successful.flatMap((item) => (
    Array.isArray(item.inputPaths) ? item.inputPaths : []
  )).map((item) => path.resolve(String(item || ''))));
  const referencedReportKeys = new Set(successful
    .map((item) => reportKeyOf(item.anomalyReport))
    .filter(Boolean));
  const aggregateReportKey = reportKeyOf(preflightReady.anomalyReport);
  const outputFiles = (Array.isArray(preflightReady.outputFiles)
    ? preflightReady.outputFiles
    : []).filter((file) => {
    const reportKey = reportKeyOf(file);
    return reportKey
      && (referencedReportKeys.has(reportKey) || reportKey === aggregateReportKey)
      && outputDependenciesSatisfied(file, committedInputPaths);
  });
  const retainedReportKeys = new Set(outputFiles.map(reportKeyOf).filter(Boolean));
  const anomalyReports = (Array.isArray(preflightReady.anomalyReports)
    ? preflightReady.anomalyReports
    : []).filter((report) => retainedReportKeys.has(reportKeyOf(report)));
  const sanitizedResults = results.map((item) => {
    const reportKey = reportKeyOf(item.anomalyReport);
    if (item.status === 'ok'
        && item.applied === true
        && (!reportKey || retainedReportKeys.has(reportKey))) {
      return item;
    }
    const sanitized = { ...item };
    delete sanitized.anomalyReport;
    return sanitized;
  });
  for (const item of sanitizedResults) {
    if (item.status === 'ok'
        && item.applied === true
        && Number(item.filteredRowCount) > 0
        && !item.anomalyReport) {
      throw applyMismatch(
        `已提交过滤文件缺少可持久化异常报告：${item.fileName || item.sourceName || ''}`
      );
    }
  }
  const aggregateReport = preflightReady.anomalyReport
    && retainedReportKeys.has(reportKeyOf(preflightReady.anomalyReport))
    ? preflightReady.anomalyReport
    : (anomalyReports.length === 1 ? anomalyReports[0] : null);
  return {
    results: sanitizedResults,
    anomalyReport: aggregateReport,
    anomalyReports,
    outputPaths: outputFiles.map((file) => file.filePath),
    outputFiles
  };
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
  const enabled = accepted.filter((file) => allowed.has(file.sourceType));

  const startedAt = Date.now();
  if (enabled.length > 0 && typeof input.onProgress === 'function') {
    input.onProgress({
      stage: 'applying',
      currentFile: 1,
      totalFiles: enabled.length,
      fileName: enabled[0].fileName,
      scannedRows: 0,
      acceptedRows: Number(enabled[0].persistedCandidateRows) || 0,
      committedRows: 0,
      elapsedMs: 0
    });
  }
  const verifiedLedger = await verifySealedLedger(preflightReady.ledgerEvidence);
  let anomalyEvidence;
  try {
    anomalyEvidence = await verifyAnomalyReportEvidence(
      verifiedLedger,
      preflightReady
    );
  } catch (error) {
    verifiedLedger.db.close();
    throw error;
  }
  const enabledFileIndexes = new Set(enabled.map((file) => Number(file.fileIndex)));
  const anomalyReportByFileIndex = new Map(anomalyEvidence.byFileIndex);
  const allFilteredFilesEnabled = anomalyEvidence.filteredFileIndexes.every(
    (fileIndex) => enabledFileIndexes.has(Number(fileIndex))
  );
  if (allFilteredFilesEnabled && anomalyEvidence.filteredFileIndexes.length > 1) {
    const lastFilteredFileIndex = anomalyEvidence.filteredFileIndexes[
      anomalyEvidence.filteredFileIndexes.length - 1
    ];
    anomalyReportByFileIndex.set(
      Number(lastFilteredFileIndex),
      anomalyEvidence.aggregateReport
    );
  }
  const enabledInputPaths = new Set(enabled.map((file) => (
    path.resolve(String(file.archivePath || ''))
  )));
  const outputByReportKey = new Map((Array.isArray(preflightReady.outputFiles)
    ? preflightReady.outputFiles
    : []).map((file) => [reportKeyOf(file), file]));
  for (const descriptor of enabled) {
    const manifestFile = verifiedLedger.manifest.files.find(
      (file) => Number(file.fileIndex) === Number(descriptor.fileIndex)
    );
    if (!manifestFile || Number(manifestFile.filteredRows) <= 0) continue;
    const report = anomalyReportByFileIndex.get(Number(descriptor.fileIndex));
    const output = outputByReportKey.get(reportKeyOf(report));
    if (!report || !output || !outputDependenciesSatisfied(output, enabledInputPaths)) {
      verifiedLedger.db.close();
      throw applyMismatch(
        `已启用过滤文件缺少独立且依赖闭合的异常报告：${descriptor.fileName || ''}`
      );
    }
  }
  const db = new DatabaseSync(path.resolve(String(input.sideDbPath || '')));
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
      const anomalyReport = anomalyReportByFileIndex.get(
        Number(descriptor.fileIndex)
      ) || null;
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
        startedAt,
        ledgerSizeBytes: preflightReady.ledgerEvidence.ledgerSizeBytes,
        availableBytes: input.availableBytes,
        sideDbPath: input.sideDbPath,
        anomalyReport
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

    const preliminaryResults = (Array.isArray(preflightReady.orderedFileResults)
      ? preflightReady.orderedFileResults
      : []).map((item) => {
      const applied = appliedByIndex.get(Number(item.fileIndex));
      if (!applied) {
        if (item.status === 'ok'
            && item.sourceType
            && item.sourceType !== SOURCE_TYPES.BANK_ACCOUNT
            && !allowed.has(item.sourceType)) {
          return {
            ...item,
            status: 'failed',
            code: 'position-streaming-source-type-disabled',
            message: `当前未启用该流式来源类型：${item.sourceName || item.sourceType}`,
            detailLines: []
          };
        }
        return item;
      }
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
        physicalRowCount: applied.physicalRowCount,
        filteredRowCount: applied.filteredRowCount,
        filterReasonCounts: applied.filterReasonCounts,
        generatedLinkRowCount: applied.generatedLinkRowCount,
        linkedRowCount: applied.linkedRowCount,
        collapsedDuplicateCount: applied.collapsedDuplicateCount,
        contentHash: applied.contentHash,
        sourceRevision: applied.sourceRevision,
        linkedRevision: applied.linkedRevision,
        anomalyReport: applied.filteredRowCount > 0
          ? anomalyReportByFileIndex.get(Number(item.fileIndex)) || null
          : null,
        applied: true
      };
    });
    const retainedArtifacts = retainedCommittedAnomalyArtifacts(
      preflightReady,
      preliminaryResults
    );
    const results = retainedArtifacts.results;
    const success = results.filter((item) => item.status === 'ok' && item.applied === true);
    const failed = results.filter((item) => item.status === 'failed');
    const confirmation = results.filter((item) => item.status === 'needs-confirmation');
    const jobRoot = path.dirname(
      path.resolve(String(preflightReady.ledgerEvidence.ledgerPath || ''))
    );
    const cleanupPaths = preflightReady.accountConfirmationDescriptor
      ? results
        .filter((item) => item.status !== 'needs-confirmation')
        .map((item) => item.stagingDir)
        .filter(Boolean)
      : [jobRoot];
    return {
      ...preflightReady,
      anomalyReport: retainedArtifacts.anomalyReport,
      anomalyReports: retainedArtifacts.anomalyReports,
      outputPaths: retainedArtifacts.outputPaths,
      outputFiles: retainedArtifacts.outputFiles,
      status: success.length > 0 || confirmation.length > 0 ? 'ok' : 'failed',
      message:
        `链接原始表导入完成：成功 ${success.length}，` +
        `待确认 ${confirmation.length}，失败 ${failed.length}`,
      results,
      orderedFileResults: results,
      successCount: success.length,
      failedCount: failed.length,
      confirmationCount: confirmation.length,
      archiveDeferred: success.length === 0 && confirmation.length > 0,
      inputPaths: success.flatMap((item) => item.inputPaths || []),
      inputFiles: success.flatMap((item) => item.inputFiles || []),
      cleanupPaths,
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
