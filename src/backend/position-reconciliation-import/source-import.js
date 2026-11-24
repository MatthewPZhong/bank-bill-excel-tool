'use strict';

// 平盘链接原始表单遍导入：暂存复制（顺带算一次 SHA-256，作存档与恢复凭证）后每个文件只解析一遍，
// 校验通过的行在同一个侧库事务里直接写入。每个文件一个回滚点：文件有非法行时只撤掉这一个文件，
// 其余文件不受影响。全部读完后事务保持未提交，等 Main 送来写入授权再一次提交；被拒绝、取消或
// 进程退出则整体回滚，库内数据不变。
// 不再有预检遍、导入账本、逐行校验摘要、写入前的文件再哈希和独立的结构迁移进程。
// 每份被接受的文件登记一个原始文件版本号；行只保存必用列，并记下版本号与原始行号。
// 清结算银行账户表需要用户确认后才整表替换：这里只校验并统计，写入在确认后由 account-import 完成。

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const {
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
  classifySourceRow
} = require('../../main-process/position-reconciliation/readers');
const {
  sourceDefinitionsFor
} = require('../../main-process/position-reconciliation/source-structures');
const {
  insertLinkRowStatement,
  insertSourceRawFile,
  insertSourceRowStatement,
  markSupersededSourceRawFiles,
  pickSourceFields,
  sameSourceFields,
  serializeSourceFields,
  sourceRecordKeyOf,
  writeLinkRows
} = require('../../main-process/position-reconciliation/source-row-storage');
const {
  STAGING_RELATIVE_PATH,
  stageInputFilesAsync
} = require('../../main-process/position-reconciliation/input-staging');
const {
  normalizePositionCheckpoint,
  positionCheckpointsEqual,
  runPositionSideDbMutation
} = require('../../main-process/position-reconciliation/side-db-mutation');
const {
  refreshPositionSourceSummary
} = require('../../main-process/position-reconciliation/source-summary-cache');
const {
  FILTERED_PAYLOAD_TABLE,
  createFilteredPayloadTable,
  writePositionAnomalyReport
} = require('./anomaly-report');
const {
  POSITION_IMPORT_PROGRESS_ROW_INTERVAL,
  POSITION_IMPORT_STREAMING_SOURCE_ALLOWLIST
} = require('./constants');
const {
  assertPositionImportDiskSpace
} = require('./disk-space-gate');
const {
  assertNotCancelled,
  assertPositionSchemaCurrent,
  assertStagedFileUntouched,
  bumpRevision,
  configureImportDatabase,
  truncateWalAfterCommit
} = require('./import-common');
const {
  readerFor
} = require('./reader-select');

const MAX_COLLISION_DETAIL_LINES = 100;
const SYSTEM_FATAL_CODES = new Set([
  'position-import-parser-parity-unproven',
  'position-import-cancelled',
  'position-side-db-mismatch',
  'position-side-db-outdated',
  'position-side-data-invalid'
]);

// 没有可提交的普通来源文件时用它带着结果退出事务：回滚，不推进 checkpoint。
class NothingToCommit extends Error {
  constructor(result) {
    super('没有可提交的普通链接原始表');
    this.result = result;
  }
}

function emptyStats() {
  return {
    scannedNonBlankRows: 0,
    persistedCandidateRows: 0,
    filteredRows: 0,
    collapsedDuplicateRows: 0,
    readerFilteredRows: 0,
    invalidRows: 0,
    visibleLinkRows: 0,
    hiddenLinkRows: 0,
    derivedZeroSourceRows: 0,
    dateMin: null,
    dateMax: null,
    filterReasonCounts: {}
  };
}

function updateDateRange(stats, value) {
  if (!value) return;
  if (!stats.dateMin || value < stats.dateMin) stats.dateMin = value;
  if (!stats.dateMax || value > stats.dateMax) stats.dateMax = value;
}

// 取消、侧库状态异常和数据库错误会中止整次导入；其余错误只拒绝出错的那个文件。
function isSystemFatal(error) {
  const code = String(error && error.code || '');
  return SYSTEM_FATAL_CODES.has(code) || code.startsWith('ERR_SQLITE');
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

function inputEvidenceFor(file) {
  return {
    role: 'input',
    sourceType: file.sourceType,
    filePath: file.archivePath,
    originalName: file.fileName,
    sourceSnapshot: file.stagedSnapshot,
    expectedSha256: file.stagedSha256,
    sizeBytes: file.stagedSizeBytes
  };
}

function acceptedResult(descriptor, stats, status) {
  const definition = SOURCE_DEFINITIONS[stats.sourceType];
  return {
    status,
    fileIndex: descriptor.fileIndex,
    filePath: descriptor.sourceFilePath,
    archivePath: descriptor.archivePath,
    stagingDir: descriptor.stagingDir,
    fileName: descriptor.sourceFileName,
    sourceType: stats.sourceType,
    sourceName: definition.sourceName,
    linkedName: definition.linkedName,
    sheetName: stats.sheetName,
    rowCount: stats.persistedCandidateRows,
    physicalRowCount: stats.scannedNonBlankRows,
    filteredRowCount: stats.filteredRows,
    filterReasonCounts: stats.filterReasonCounts,
    collapsedDuplicateCount: stats.collapsedDuplicateRows,
    generatedLinkRowCount: Number(stats.visibleLinkRows) + Number(stats.hiddenLinkRows),
    sharedStringsMode: stats.sharedStringsMode,
    sharedStringsCount: stats.sharedStringsCount,
    rawVersion: stats.rawVersion || null,
    stagedSnapshot: descriptor.stagedSnapshot,
    stagedSha256: descriptor.stagedSha256,
    stagedSizeBytes: descriptor.stagedSizeBytes
  };
}

function failedResult(descriptor, error) {
  const stats = error && error.positionImportStats ? error.positionImportStats : {};
  return {
    status: 'failed',
    fileIndex: descriptor.fileIndex,
    filePath: descriptor.sourceFilePath,
    archivePath: descriptor.archivePath,
    stagingDir: descriptor.stagingDir,
    fileName: descriptor.sourceFileName,
    sourceType: stats.sourceType || (error && error.sourceType) || null,
    physicalRowCount: Number(stats.scannedNonBlankRows || 0),
    fileRejectedRowCount: Number(stats.scannedNonBlankRows || 0),
    code: error && error.code ? error.code : 'position-source-import-failed',
    message: error && error.message ? error.message : String(error),
    detailLines: Array.isArray(error && error.detailLines)
      ? error.detailLines.slice(0, 100)
      : []
  };
}

function sourceStatements(db) {
  return {
    findSource: db.prepare(`
      SELECT id, business_key AS businessKey, raw_version AS rawVersion,
             fields_json AS fieldsJson
      FROM position_source_rows
      WHERE source_type = ? AND row_hash = ?
    `),
    insertSource: insertSourceRowStatement(db),
    relocateSource: db.prepare(`
      UPDATE position_source_rows
      SET raw_version = ?, source_row_number = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `),
    deleteLinks: db.prepare('DELETE FROM position_link_rows WHERE source_row_id = ?'),
    insertLink: insertLinkRowStatement(db),
    findActiveFiltered: db.prepare(`
      SELECT id, raw_version AS rawVersion
      FROM position_filtered_source_rows
      WHERE source_type = ? AND row_hash = ? AND resolved_at IS NULL
    `),
    resolveFilteredById: db.prepare(`
      UPDATE position_filtered_source_rows
      SET resolved_at = CURRENT_TIMESTAMP,
          resolution_reason = 'same-anomaly-reimported'
      WHERE id = ?
    `),
    // 只关闭本次导入之前留下的过滤记录；本次导入里的过滤行若与正常记录同单号，按冲突拒绝文件。
    resolveOlderFilteredByBusinessKey: db.prepare(`
      UPDATE position_filtered_source_rows
      SET resolved_at = CURRENT_TIMESTAMP,
          resolution_reason = 'normal-source-imported'
      WHERE source_type = ? AND business_key = ? AND resolved_at IS NULL AND id <= ?
    `),
    insertFiltered: db.prepare(`
      INSERT INTO position_filtered_source_rows(
        report_row_key, source_type, business_key, recon_id,
        event_date, month_key, error_code, error_reason,
        raw_version, source_row_number, row_hash,
        import_operation_token, archive_operation_key,
        report_key, report_artifact_key, report_file_path, report_file_name,
        report_sha256, report_size_bytes, report_row_count
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '', '', '', '', '', '', '', 0, 0)
    `),
    insertFilteredPayload: db.prepare(`
      INSERT INTO ${FILTERED_PAYLOAD_TABLE}(filtered_id, file_index, fields_json)
      VALUES (?, ?, ?)
    `),
    // 某个文件的过滤行里，业务单号已存在正常记录的那些。
    filteredCollisions: db.prepare(`
      SELECT filtered.business_key AS businessKey,
             source.raw_version AS rawVersion,
             source.source_row_number AS rowNumber
      FROM position_filtered_source_rows filtered
      JOIN position_source_rows source
        ON source.source_type = filtered.source_type
       AND source.business_key = filtered.business_key
      WHERE filtered.raw_version = ? AND filtered.resolved_at IS NULL
      ORDER BY filtered.id, source.id
      LIMIT ${MAX_COLLISION_DETAIL_LINES}
    `),
    finishRawFile: db.prepare(
      'UPDATE position_raw_files SET sheet_name = ?, row_count = ? WHERE version = ?'
    )
  };
}

function collisionError(descriptor, collisions, fileIndexByVersion) {
  const detailLines = [...new Set(collisions.map((item) => {
    const fileIndex = fileIndexByVersion.get(Number(item.rawVersion));
    const location = Number.isSafeInteger(fileIndex)
      ? `同批正常记录位于第 ${fileIndex + 1} 个文件第 ${Number(item.rowNumber)} 行`
      : '当前数据库已存在正常记录';
    return `${text(item.businessKey)}：${location}`;
  }))].slice(0, MAX_COLLISION_DETAIL_LINES);
  return new PositionReconciliationError(
    'position-filtered-key-collision',
    `过滤行业务单号与正常记录冲突，整份文件已拒绝：${descriptor.sourceFileName}`,
    detailLines
  );
}

// 解析并写入一个文件。普通来源写库；账户表只校验统计。返回该文件的统计。
async function importSourceFile({
  db,
  statements,
  descriptor,
  jobId,
  sourceDefinitions,
  allowedSourceTypes,
  mappings,
  batch,
  cancelToken,
  sstOptions,
  reportProgress
}) {
  const stats = emptyStats();
  let sourceType = '';
  let sheetName = '';
  let rawVersion = null;
  const read = readerFor(descriptor.filePath);
  const begin = (detectedType, detectedSheet) => {
    sourceType = detectedType;
    sheetName = detectedSheet;
    if (sourceType === SOURCE_TYPES.BANK_ACCOUNT) {
      if (batch.accountDescriptor) {
        throw new PositionReconciliationError(
          'position-source-cross-file-snapshot-conflict',
          `同一次导入只能选择一份清结算银行账户表：${descriptor.sourceFileName}`
        );
      }
      return;
    }
    if (!allowedSourceTypes.has(sourceType)) {
      const definition = SOURCE_DEFINITIONS[sourceType];
      throw new PositionReconciliationError(
        'position-streaming-source-type-disabled',
        `当前未启用该流式来源类型：${definition ? definition.sourceName : sourceType}`
      );
    }
    // 版本号在文件开始时分配；文件被拒绝时随回滚点一起撤销。
    rawVersion = insertSourceRawFile(db, {
      sourceType,
      originalName: descriptor.sourceFileName,
      originalPath: path.resolve(descriptor.sourceFilePath),
      sheetName,
      sizeBytes: descriptor.stagedSizeBytes,
      sha256: descriptor.stagedSha256
    });
    batch.versions.add(rawVersion);
    batch.fileIndexByVersion.set(rawVersion, descriptor.fileIndex);
  };

  try {
    const summary = await read(descriptor.filePath, {
      kind: 'source',
      cancelToken,
      allowMainThread: false,
      sstTempRoot: path.join(descriptor.stagingDir, 'sst'),
      ...(sstOptions || {}),
      sourceDefinitions,
      onRow: ({ row, excelRowNumber, sourceType: detectedType, sheetName: detectedSheet }) => {
        if (!sourceType) begin(detectedType, detectedSheet);
        if (detectedType !== sourceType) {
          throw new PositionReconciliationError(
            'position-source-row-invalid',
            `链接原始表读取期间来源类型发生变化：${descriptor.sourceFileName}`
          );
        }
        stats.scannedNonBlankRows += 1;
        if (stats.scannedNonBlankRows % POSITION_IMPORT_PROGRESS_ROW_INTERVAL === 0) {
          assertNotCancelled(cancelToken);
          reportProgress(stats);
        }
        const fields = pickSourceFields(sourceType, row);
        if (sourceType === SOURCE_TYPES.BANK_ACCOUNT && text(fields['账户状态']) !== '正常') {
          stats.readerFilteredRows += 1;
          return;
        }
        const classification = classifySourceRow(sourceType, fields);
        const validation = classification.validation;
        if (classification.disposition === 'invalid') {
          stats.invalidRows += 1;
          throw new PositionReconciliationError(
            'position-source-row-invalid',
            `链接原始表存在非法行：${descriptor.sourceFileName} / ${sheetName} 第 ${excelRowNumber} 行`,
            validation.errors
          );
        }
        if (sourceType === SOURCE_TYPES.BANK_ACCOUNT) {
          stats.persistedCandidateRows += 1;
          stats.visibleLinkRows += 1;
          return;
        }

        const rowHash = sourceRecordKeyOf(fields);
        if (classification.disposition === 'filtered') {
          const active = statements.findActiveFiltered.get(sourceType, rowHash);
          if (active && batch.versions.has(Number(active.rawVersion))) {
            stats.collapsedDuplicateRows += 1;
            return;
          }
          if (active) statements.resolveFilteredById.run(Number(active.id));
          const filter = classification.filter;
          const inserted = statements.insertFiltered.run(
            `${jobId}#${descriptor.fileIndex + 1}#${excelRowNumber}`,
            sourceType,
            validation.businessKey,
            filter.reconId,
            validation.eventDate || null,
            validation.monthKey || null,
            filter.code,
            filter.reason,
            rawVersion,
            excelRowNumber,
            rowHash
          );
          statements.insertFilteredPayload.run(
            Number(inserted.lastInsertRowid),
            descriptor.fileIndex,
            serializeSourceFields(fields)
          );
          stats.filteredRows += 1;
          stats.filterReasonCounts[filter.code] =
            Number(stats.filterReasonCounts[filter.code] || 0) + 1;
          return;
        }

        const existing = statements.findSource.get(sourceType, rowHash);
        let sourceRowId;
        if (existing) {
          let stored;
          try {
            stored = JSON.parse(existing.fieldsJson);
          } catch (_error) {
            stored = null;
          }
          if (!stored
              || !sameSourceFields(stored, JSON.parse(serializeSourceFields(fields)))
              || text(existing.businessKey) !== text(validation.businessKey)) {
            throw new PositionReconciliationError(
              'position-source-record-hash-collision',
              `来源记录标识对应了不同内容，已停止导入：${descriptor.sourceFileName} 第 ${excelRowNumber} 行`
            );
          }
          if (batch.versions.has(Number(existing.rawVersion))) {
            // 本次导入里已出现过的完全相同的行：折叠，保留第一次出现的那一行。
            stats.collapsedDuplicateRows += 1;
            return;
          }
          // 以前导入过的同一条记录：只把文件血缘指到本次文件，并按当前映射重新派生链接行。
          sourceRowId = Number(existing.id);
          statements.relocateSource.run(rawVersion, excelRowNumber, sourceRowId);
          statements.deleteLinks.run(sourceRowId);
        } else {
          sourceRowId = Number(statements.insertSource.run(
            sourceType,
            validation.businessKey,
            validation.eventDate || null,
            validation.monthKey || null,
            rawVersion,
            excelRowNumber,
            rowHash,
            serializeSourceFields(fields)
          ).lastInsertRowid);
        }
        statements.resolveOlderFilteredByBusinessKey.run(
          sourceType,
          validation.businessKey,
          batch.previousMaxFilteredId
        );
        const record = {
          sourceType,
          businessKey: validation.businessKey,
          sourceRecordKey: rowHash,
          sourceRowId,
          eventDate: validation.eventDate,
          monthKey: validation.monthKey,
          sourceRowNumber: excelRowNumber,
          row: fields
        };
        const derived = deriveLinkedRowsForRecord(sourceType, record, mappings);
        if (derived.length === 0) stats.derivedZeroSourceRows += 1;
        const written = writeLinkRows(statements.insertLink, sourceType, record, derived);
        stats.visibleLinkRows += written.visible;
        stats.hiddenLinkRows += written.hidden;
        stats.persistedCandidateRows += 1;
        updateDateRange(stats, validation.eventDate);
      }
    });

    sourceType = sourceType || summary.sourceType;
    sheetName = sheetName || summary.sheetName;
    if (stats.scannedNonBlankRows === 0) {
      throw new PositionReconciliationError(
        'position-source-empty',
        `链接原始表没有数据行：${descriptor.sourceFileName} / ${sheetName}`
      );
    }
    if (sourceType === SOURCE_TYPES.BANK_ACCOUNT && stats.persistedCandidateRows === 0) {
      throw new PositionReconciliationError(
        'position-bank-account-empty',
        '清结算银行账户表没有账户状态为“正常”的有效行，旧快照未被覆盖'
      );
    }
    const accounted = stats.persistedCandidateRows + stats.filteredRows
      + stats.collapsedDuplicateRows + stats.readerFilteredRows;
    if (accounted !== stats.scannedNonBlankRows) {
      throw new PositionReconciliationError(
        'position-side-data-invalid',
        `链接原始表读取行数与处理行数不守恒：${descriptor.sourceFileName}`,
        [`读取 ${stats.scannedNonBlankRows} 行，处理 ${accounted} 行`]
      );
    }
    if (rawVersion !== null) {
      const collisions = statements.filteredCollisions.all(rawVersion);
      if (collisions.length > 0) {
        const error = collisionError(descriptor, collisions, batch.fileIndexByVersion);
        error.sourceType = sourceType;
        throw error;
      }
      statements.finishRawFile.run(
        sheetName,
        stats.persistedCandidateRows + stats.filteredRows,
        rawVersion
      );
    }
    return {
      ...stats,
      sourceType,
      sheetName,
      rawVersion,
      sharedStringsMode: summary.sharedStringsMode,
      sharedStringsCount: summary.sharedStringsCount
    };
  } catch (error) {
    if (rawVersion !== null) {
      batch.versions.delete(rawVersion);
      batch.fileIndexByVersion.delete(rawVersion);
    }
    if (error && typeof error === 'object') {
      error.positionImportStats = {
        scannedNonBlankRows: stats.scannedNonBlankRows,
        invalidRows: stats.invalidRows,
        sourceType,
        sheetName
      };
    }
    throw error;
  }
}

function normalizeApplyGrant(grant, { jobId, archiveManifestHash, baseCheckpoint, allowPreflightOnly }) {
  const payload = grant && typeof grant === 'object' && !Array.isArray(grant) ? grant : {};
  if (text(payload.jobId) !== text(jobId)
      || text(payload.archiveManifestHash).toLowerCase() !== archiveManifestHash) {
    throw new PositionReconciliationError(
      'position-import-intent-not-durable',
      '平盘导入写入授权与本次导入不一致'
    );
  }
  if (payload.preflightOnly === true) {
    if (!allowPreflightOnly) {
      throw new PositionReconciliationError(
        'position-import-intent-not-durable',
        '有可提交文件时禁止使用仅预检授权'
      );
    }
    return { preflightOnly: true };
  }
  const operationToken = text(payload.operationToken);
  const grantedCheckpoint = normalizePositionCheckpoint(
    payload.baseCheckpoint,
    '导入写入基准 checkpoint'
  );
  if (!operationToken
      || !payload.batchContext
      || !positionCheckpointsEqual(grantedCheckpoint, baseCheckpoint)) {
    throw new PositionReconciliationError(
      'position-import-intent-not-durable',
      '平盘导入写入授权缺少提交凭证或基准 checkpoint 已变化'
    );
  }
  return {
    preflightOnly: false,
    operationToken,
    batchNumber: text(payload.batchContext && payload.batchContext.batchNumber)
  };
}

function outputFileFor(report, acceptedByFileIndex) {
  return {
    filePath: report.filePath,
    role: 'output',
    originalName: report.fileName,
    artifactKey: report.artifactKey,
    sourceOperation: report.sourceOperation,
    sourceSnapshot: report.sourceSnapshot,
    expectedSha256: report.sha256,
    sizeBytes: report.sizeBytes,
    requiredInputPaths: report.sourceFileIndexes.map(
      (fileIndex) => path.resolve(acceptedByFileIndex.get(Number(fileIndex)).archivePath)
    ),
    metadata: {
      displayRole: report.displayRole,
      reportKey: report.reportKey,
      reportSha256: report.sha256,
      reportRowCount: report.filteredRowCount,
      sourceFileIndexes: report.sourceFileIndexes
    }
  };
}

async function runPositionSourceImport(input = {}) {
  const jobId = String(input.jobId || '').trim();
  const files = Array.isArray(input.files) ? input.files : [];
  const userDataDir = path.resolve(String(input.userDataDir || ''));
  const sideDbPath = String(input.sideDbPath || '').trim();
  const baseCheckpoint = normalizePositionCheckpoint(
    input.expectedCheckpoint,
    '导入基准 checkpoint'
  );
  if (!jobId || !String(input.userDataDir || '').trim() || files.length === 0) {
    throw new TypeError('链接原始表导入需要 jobId、userDataDir 和 files');
  }
  if (!sideDbPath || !baseCheckpoint) {
    throw new PositionReconciliationError(
      'position-side-db-mismatch',
      '链接原始表导入缺少侧库路径或基准 checkpoint'
    );
  }
  if (typeof input.awaitApplyGrant !== 'function') {
    throw new TypeError('链接原始表导入缺少写入授权通道');
  }
  const allowedSourceTypes = normalizeAllowedSourceTypes(input.allowedSourceTypes);
  // 本次导入冻结的链接原始表结构（设置 → 模板文件的当前版本），缺省为内置结构。
  const sourceDefinitions = sourceDefinitionsFor(input.sourceStructures);
  const writeAnomalyReport = typeof input.writeAnomalyReport === 'function'
    ? input.writeAnomalyReport
    : writePositionAnomalyReport;
  const cancelToken = input.cancelToken && typeof input.cancelToken === 'object'
    ? input.cancelToken
    : { cancelled: false };
  const onProgress = typeof input.onProgress === 'function' ? input.onProgress : null;
  const startedAt = Date.now();
  const jobRoot = path.join(userDataDir, STAGING_RELATIVE_PATH, jobId);
  let committed = false;
  let keepJobRoot = false;
  let db = null;

  try {
    const staged = await stageInputFilesAsync(userDataDir, files, jobId, {
      cancelToken,
      onProgress: onProgress ? (progress) => onProgress({
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
      }) : null
    });
    assertNotCancelled(cancelToken);
    assertPositionImportDiskSpace({
      kind: 'source',
      sideDbPath,
      rowCount: 0,
      stagedBytes: staged.reduce((sum, file) => sum + Number(file.stagedSizeBytes || 0), 0),
      availableBytes: input.availableBytes
    });

    db = new DatabaseSync(path.resolve(sideDbPath));
    configureImportDatabase(db);
    assertPositionSchemaCurrent(db);
    let committedFiles = [];
    let grant = null;

    const mutation = await runPositionSideDbMutation({
      db,
      expectedCheckpoint: baseCheckpoint,
      operationToken: () => (grant ? grant.operationToken : ''),
      inputEvidence: () => committedFiles.map(inputEvidenceFor),
      fallbackSourceType: 'position-source',
      requireExternalOperationToken: true,
      mutate: async () => {
        const mappings = db.prepare(`
          SELECT mid_account_id AS midAccountId,
                 clearing_account_id AS clearingAccountId
          FROM position_account_mappings
          ORDER BY rowid
        `).all();
        const filteredSequence = db.prepare(
          "SELECT seq FROM sqlite_sequence WHERE name = 'position_filtered_source_rows'"
        ).get();
        const previousMaxFilteredId = Number(filteredSequence && filteredSequence.seq || 0);
        // 过滤行内容的临时表先建好再准备语句；每轮尝试回到回滚点时它随之清空。
        createFilteredPayloadTable(db);
        const statements = sourceStatements(db);
        // 事后才发现要整份拒绝的文件（过滤行与后面文件的正常记录同单号、异常报告写不出来）：
        // 记下来后整体回到起点重读其余文件。正常情况下每个文件只读一遍。
        const excluded = new Map();
        let attempt = null;

        for (;;) {
          assertNotCancelled(cancelToken);
          db.exec('SAVEPOINT position_source_attempt');
          const batch = {
            versions: new Set(),
            fileIndexByVersion: new Map(),
            previousMaxFilteredId,
            accountDescriptor: null
          };
          const outcomes = [];
          for (let position = 0; position < staged.length; position += 1) {
            assertNotCancelled(cancelToken);
            const descriptor = staged[position];
            const excludedError = excluded.get(descriptor.fileIndex);
            if (excludedError) {
              outcomes.push({ descriptor, error: excludedError });
              continue;
            }
            const reportProgress = (stats) => {
              if (!onProgress) return;
              onProgress({
                stage: 'importing',
                currentFile: position + 1,
                totalFiles: staged.length,
                fileName: descriptor.sourceFileName,
                scannedRows: stats.scannedNonBlankRows,
                acceptedRows: stats.persistedCandidateRows,
                committedRows: 0,
                elapsedMs: Date.now() - startedAt
              });
            };
            reportProgress(emptyStats());
            db.exec('SAVEPOINT position_source_file');
            try {
              const stats = await importSourceFile({
                db,
                statements,
                descriptor,
                jobId,
                sourceDefinitions,
                allowedSourceTypes,
                mappings,
                batch,
                cancelToken,
                sstOptions: input.sstOptions,
                reportProgress
              });
              db.exec('RELEASE position_source_file');
              reportProgress(stats);
              if (stats.sourceType === SOURCE_TYPES.BANK_ACCOUNT) {
                batch.accountDescriptor = acceptedResult(descriptor, stats, 'needs-confirmation');
                outcomes.push({ descriptor, stats, account: true });
              } else {
                outcomes.push({ descriptor, stats });
              }
            } catch (error) {
              db.exec('ROLLBACK TO position_source_file');
              db.exec('RELEASE position_source_file');
              if (isSystemFatal(error)) {
                if (error && typeof error === 'object') error.fileIndex = descriptor.fileIndex;
                throw error;
              }
              outcomes.push({ descriptor, error });
            }
          }

          const acceptedOutcomes = outcomes.filter((item) => item.stats && !item.account);
          // 过滤行所在文件早于同单号的正常记录时，读它的时候还看不出冲突：全部读完后再核一遍。
          const retroactive = new Map();
          for (const item of acceptedOutcomes) {
            if (Number(item.stats.filteredRows) === 0) continue;
            const collisions = statements.filteredCollisions.all(item.stats.rawVersion);
            if (collisions.length === 0) continue;
            const error = collisionError(item.descriptor, collisions, batch.fileIndexByVersion);
            error.sourceType = item.stats.sourceType;
            error.positionImportStats = {
              scannedNonBlankRows: item.stats.scannedNonBlankRows,
              invalidRows: 0,
              sourceType: item.stats.sourceType,
              sheetName: item.stats.sheetName
            };
            retroactive.set(item.descriptor.fileIndex, error);
          }

          let anomalyReport = null;
          if (retroactive.size === 0) {
            const reportFiles = acceptedOutcomes
              .filter((item) => Number(item.stats.filteredRows) > 0)
              .map((item) => ({
                fileIndex: item.descriptor.fileIndex,
                fileName: item.descriptor.sourceFileName,
                ...item.stats
              }));
            if (reportFiles.length > 0) {
              try {
                anomalyReport = await writeAnomalyReport({ db, files: reportFiles, jobRoot, jobId });
                if (!anomalyReport) {
                  throw new PositionReconciliationError(
                    'position-anomaly-report-failed',
                    '批次异常报告未生成'
                  );
                }
              } catch (reportError) {
                // 报告写不出来：含过滤行的文件整份不提交，其余文件照常导入。
                await fs.promises.rm(path.join(jobRoot, 'anomaly-report'), {
                  recursive: true,
                  force: true
                }).catch(() => undefined);
                for (const item of acceptedOutcomes) {
                  if (Number(item.stats.filteredRows) === 0) continue;
                  const error = new PositionReconciliationError(
                    'position-anomaly-report-failed',
                    `异常报告生成失败，含过滤行文件未提交：${item.descriptor.sourceFileName}`,
                    [
                      reportError && reportError.message ? reportError.message : String(reportError),
                      ...(Array.isArray(reportError && reportError.detailLines)
                        ? reportError.detailLines
                        : [])
                    ].filter(Boolean).slice(0, 100)
                  );
                  error.positionImportStats = {
                    scannedNonBlankRows: item.stats.scannedNonBlankRows,
                    invalidRows: 0,
                    sourceType: item.stats.sourceType,
                    sheetName: item.stats.sheetName
                  };
                  retroactive.set(item.descriptor.fileIndex, error);
                }
              }
            }
          }

          if (retroactive.size > 0) {
            db.exec('ROLLBACK TO position_source_attempt');
            db.exec('RELEASE position_source_attempt');
            for (const [fileIndex, error] of retroactive) excluded.set(fileIndex, error);
            continue;
          }
          db.exec('RELEASE position_source_attempt');
          attempt = { batch, outcomes, acceptedOutcomes, anomalyReport };
          break;
        }

        const { batch, outcomes, acceptedOutcomes, anomalyReport } = attempt;
        if (anomalyReport) {
          const versions = acceptedOutcomes
            .filter((item) => Number(item.stats.filteredRows) > 0)
            .map((item) => Number(item.stats.rawVersion));
          db.prepare(`
            UPDATE position_filtered_source_rows
            SET report_key = ?, report_artifact_key = ?, report_file_path = ?,
                report_file_name = ?, report_sha256 = ?, report_size_bytes = ?,
                report_row_count = ?
            WHERE resolved_at IS NULL
              AND raw_version IN (${versions.map(() => '?').join(', ')})
          `).run(
            anomalyReport.reportKey,
            anomalyReport.artifactKey,
            anomalyReport.filePath,
            anomalyReport.fileName,
            anomalyReport.sha256,
            Number(anomalyReport.sizeBytes),
            Number(anomalyReport.filteredRowCount),
            ...versions
          );
        }

        const sourceTypes = [...new Set(acceptedOutcomes.map((item) => item.stats.sourceType))];
        const revisions = new Map();
        const summaries = new Map();
        for (const sourceType of sourceTypes) {
          assertNotCancelled(cancelToken);
          markSupersededSourceRawFiles(db, sourceType);
          const sourceRevision = bumpRevision(db, 'source', sourceType);
          const linkedRevision = bumpRevision(db, 'linked', sourceType);
          revisions.set(sourceType, { sourceRevision, linkedRevision });
          summaries.set(sourceType, refreshPositionSourceSummary(db, sourceType, {
            onPhase: (phase) => {
              if (!onProgress) return;
              onProgress({
                stage: 'summarizing',
                summaryPhase: phase,
                currentFile: staged.length,
                totalFiles: staged.length,
                fileName: '',
                scannedRows: 0,
                acceptedRows: 0,
                committedRows: 0,
                elapsedMs: Date.now() - startedAt
              });
            }
          }));
        }

        const orderedFileResults = outcomes.map((item) => {
          if (item.error) return failedResult(item.descriptor, item.error);
          if (item.account) return batch.accountDescriptor;
          const result = acceptedResult(item.descriptor, item.stats, 'ok');
          if (anomalyReport && Number(item.stats.filteredRows) > 0) {
            result.anomalyReport = anomalyReport;
          }
          return result;
        });
        const acceptedFiles = orderedFileResults.filter((item) => (
          item.status === 'ok' && item.sourceType !== SOURCE_TYPES.BANK_ACCOUNT
        ));
        const acceptedByFileIndex = new Map(acceptedFiles.map((file) => [
          Number(file.fileIndex),
          file
        ]));
        const outputFiles = anomalyReport ? [outputFileFor(anomalyReport, acceptedByFileIndex)] : [];
        // 写入授权要与这份清单对应：文件凭证与异常报告凭证的摘要（内容很小，不涉及数据行）。
        const archiveManifestHash = stableHash({
          jobId,
          files: orderedFileResults
            .filter((item) => item.status !== 'failed')
            .map((item) => ({
              fileIndex: item.fileIndex,
              status: item.status,
              sourceType: item.sourceType,
              fileName: item.fileName,
              sha256: item.stagedSha256,
              sizeBytes: item.stagedSizeBytes,
              rowCount: item.rowCount,
              filteredRowCount: item.filteredRowCount
            })),
          outputs: outputFiles.map((file) => ({
            artifactKey: file.artifactKey,
            sha256: file.expectedSha256,
            sizeBytes: file.sizeBytes
          }))
        });
        const ready = {
          jobId,
          kind: 'source',
          singlePass: true,
          jobRoot,
          archiveManifestHash,
          acceptedOrdinaryInputFiles: acceptedFiles,
          acceptedBankFiles: [],
          accountConfirmationDescriptor: batch.accountDescriptor,
          orderedFileResults,
          anomalyReport,
          anomalyReports: anomalyReport ? [anomalyReport] : [],
          outputPaths: outputFiles.map((file) => file.filePath),
          outputFiles
        };

        // 事务保持未提交：等待授权期间其他连接看到的仍是旧数据。
        assertNotCancelled(cancelToken);
        grant = normalizeApplyGrant(await input.awaitApplyGrant(ready), {
          jobId,
          archiveManifestHash,
          baseCheckpoint,
          allowPreflightOnly: acceptedFiles.length === 0
        });
        if (grant.preflightOnly || acceptedFiles.length === 0) {
          throw new NothingToCommit(ready);
        }
        for (const file of acceptedFiles) await assertStagedFileUntouched(file);
        // 版本记录与过滤记录补上本次操作凭证与存档批次号，便于从版本号找到存档中心里的原件。
        const bindRawFile = db.prepare(`
          UPDATE position_raw_files
          SET operation_token = ?, archive_batch_number = ?
          WHERE version = ?
        `);
        const bindFiltered = db.prepare(`
          UPDATE position_filtered_source_rows
          SET import_operation_token = ?, archive_operation_key = ?
          WHERE raw_version = ? AND resolved_at IS NULL
        `);
        for (const file of acceptedFiles) {
          bindRawFile.run(grant.operationToken, grant.batchNumber, Number(file.rawVersion));
          if (Number(file.filteredRowCount) > 0) {
            bindFiltered.run(
              grant.operationToken,
              `position:${grant.operationToken}:position-reconciliation:source:prepare-import`,
              Number(file.rawVersion)
            );
          }
        }
        const committedRows = acceptedFiles.reduce((sum, file) => sum + Number(file.rowCount), 0);
        if (onProgress) {
          onProgress({
            stage: 'committing',
            currentFile: staged.length,
            totalFiles: staged.length,
            fileName: '',
            scannedRows: committedRows,
            acceptedRows: committedRows,
            committedRows,
            elapsedMs: Date.now() - startedAt
          });
        }
        committedFiles = acceptedFiles;
        const results = orderedFileResults.map((item) => {
          if (item.status !== 'ok' || item.sourceType === SOURCE_TYPES.BANK_ACCOUNT) return item;
          const revision = revisions.get(item.sourceType);
          const summary = summaries.get(item.sourceType);
          return {
            ...item,
            inputPaths: [item.archivePath],
            inputFiles: [inputEvidenceFor(item)],
            originalInputPaths: [item.filePath],
            cleanupPaths: [item.stagingDir],
            linkedRowCount: summary.linkedRowCount,
            sourceRevision: revision.sourceRevision,
            linkedRevision: revision.linkedRevision,
            applied: true
          };
        });
        return { ready, results };
      }
    }).catch((error) => {
      if (error instanceof NothingToCommit) return { nothingToCommit: error.result };
      throw error;
    });

    if (mutation.nothingToCommit) {
      // 只有账户表待确认（或全部被拒）：库未改动；账户表的暂存文件留到用户确认或取消。
      const ready = mutation.nothingToCommit;
      keepJobRoot = Boolean(ready.accountConfirmationDescriptor);
      const confirmation = ready.orderedFileResults.filter(
        (item) => item.status === 'needs-confirmation'
      );
      const failed = ready.orderedFileResults.filter((item) => item.status === 'failed');
      return {
        ...ready,
        status: confirmation.length > 0 ? 'ok' : 'failed',
        message: confirmation.length > 0
          ? `链接原始表导入完成：成功 0，待确认 ${confirmation.length}，失败 ${failed.length}`
          : '所选链接原始表全部导入失败',
        results: ready.orderedFileResults,
        successCount: 0,
        failedCount: failed.length,
        confirmationCount: confirmation.length,
        archiveDeferred: confirmation.length > 0,
        inputPaths: [],
        inputFiles: [],
        cleanupPaths: failed.map((item) => item.stagingDir).filter(Boolean)
      };
    }

    committed = true;
    truncateWalAfterCommit(db);
    const { ready, results } = mutation.result;
    const success = results.filter((item) => item.status === 'ok' && item.applied === true);
    const failed = results.filter((item) => item.status === 'failed');
    const confirmation = results.filter((item) => item.status === 'needs-confirmation');
    return {
      ...ready,
      status: 'ok',
      message:
        `链接原始表导入完成：成功 ${success.length}，` +
        `待确认 ${confirmation.length}，失败 ${failed.length}`,
      results,
      orderedFileResults: results,
      successCount: success.length,
      failedCount: failed.length,
      confirmationCount: confirmation.length,
      archiveDeferred: false,
      inputPaths: success.flatMap((item) => item.inputPaths),
      inputFiles: success.flatMap((item) => item.inputFiles),
      cleanupPaths: ready.accountConfirmationDescriptor
        ? results
          .filter((item) => item.status !== 'needs-confirmation')
          .map((item) => item.stagingDir)
          .filter(Boolean)
        : [jobRoot],
      checkpoint: mutation.nextCheckpoint,
      nextCheckpoint: mutation.nextCheckpoint
    };
  } finally {
    if (db) {
      try { db.close(); } catch (_closeError) { /* 关闭失败不覆盖结果 */ }
    }
    if (!committed && !keepJobRoot) {
      // 未提交且没有待确认的账户表：暂存目录不再需要。
      await fs.promises.rm(jobRoot, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 100
      }).catch(() => undefined);
    }
  }
}

module.exports = {
  inputEvidenceFor,
  normalizeAllowedSourceTypes,
  runPositionSourceImport
};
