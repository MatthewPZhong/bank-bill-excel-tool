'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const {
  LINK_HEADERS,
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
  assertPositionLargeImportSchema
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
  POSITION_IMPORT_COMMANDS,
  POSITION_IMPORT_MAINTENANCE_BATCH_SIZE
} = require('./constants');
const {
  assertPositionImportDiskSpace
} = require('./disk-space-gate');

const MAINTENANCE_COMMANDS = new Set([
  POSITION_IMPORT_COMMANDS.DELETE_BANK,
  POSITION_IMPORT_COMMANDS.DELETE_SOURCE,
  POSITION_IMPORT_COMMANDS.REBUILD_FUND_TRANSFER_MAPPING
]);

function maintenanceError(code, message, detailLines = []) {
  return new PositionReconciliationError(code, message, detailLines);
}

function cancelError() {
  return maintenanceError('position-import-cancelled', '平盘维护操作已取消');
}

function assertNotCancelled(cancelToken) {
  if (cancelToken && cancelToken.cancelled) throw cancelError();
}

function yieldToEventLoop() {
  return new Promise((resolve) => setImmediate(resolve));
}

function placeholders(count) {
  return new Array(count).fill('?').join(', ');
}

function uniqueTextList(value) {
  return [...new Set(
    (Array.isArray(value) ? value : []).map(text).filter(Boolean)
  )];
}

function normalizeBatchSize(value) {
  const numeric = Number(value);
  return Number.isSafeInteger(numeric) && numeric > 0 && numeric <= 100000
    ? numeric
    : POSITION_IMPORT_MAINTENANCE_BATCH_SIZE;
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

function emitProgress(onProgress, value) {
  if (typeof onProgress !== 'function') return;
  onProgress({
    currentFile: null,
    totalFiles: 0,
    fileName: '',
    acceptedRows: 0,
    copiedBytes: 0,
    totalBytes: 0,
    elapsedMs: 0,
    ...value
  });
}

async function deleteInBatches({
  statement,
  args,
  batchSize,
  cancelToken,
  onProgress,
  stage,
  expectedRows = 0
}) {
  let deletedCount = 0;
  while (true) {
    assertNotCancelled(cancelToken);
    const result = statement.run(...args, batchSize);
    const changed = Number(result.changes) || 0;
    deletedCount += changed;
    emitProgress(onProgress, {
      stage,
      scannedRows: deletedCount,
      acceptedRows: expectedRows,
      committedRows: 0
    });
    if (changed < batchSize) break;
    await yieldToEventLoop();
  }
  assertNotCancelled(cancelToken);
  return deletedCount;
}

function sourceDeleteSelection(payload = {}) {
  const sourceType = text(payload.sourceType);
  const wholeTable = payload.wholeTable === true;
  const months = uniqueTextList(payload.months);
  if (!SOURCE_DEFINITIONS[sourceType]) {
    throw maintenanceError('position-source-type-invalid', '未知链接原始表');
  }
  if (sourceType === SOURCE_TYPES.BANK_ACCOUNT) {
    if (!wholeTable) {
      throw maintenanceError(
        'position-source-delete-selection-invalid',
        '清结算银行账户表只能整表删除'
      );
    }
    return { sourceType, wholeTable: true, months: [] };
  }
  if (wholeTable) {
    throw maintenanceError(
      'position-source-delete-selection-invalid',
      '非账户链接原始表必须明确选择月份，不允许整表删除'
    );
  }
  if (months.length === 0) {
    throw maintenanceError(
      'position-source-delete-selection-invalid',
      '请至少选择一个月份'
    );
  }
  return { sourceType, wholeTable: false, months };
}

async function deleteSourceRowsStreamed({
  db,
  expectedCheckpoint,
  operationToken,
  payload,
  cancelToken,
  onProgress,
  batchSize = POSITION_IMPORT_MAINTENANCE_BATCH_SIZE,
  sideDbPath,
  availableBytes
}) {
  const selection = sourceDeleteSelection(payload);
  const normalizedBatchSize = normalizeBatchSize(batchSize);
  const mutation = await runPositionSideDbMutation({
    db,
    expectedCheckpoint,
    operationToken,
    requireExternalOperationToken: true,
    mutate: async () => {
      const args = [selection.sourceType];
      const monthClause = selection.wholeTable
        ? ''
        : ` AND month_key IN (${placeholders(selection.months.length)})`;
      if (!selection.wholeTable) args.push(...selection.months);
      const expectedRows = Number(db.prepare(`
        SELECT COUNT(*) AS count
        FROM position_source_rows
        WHERE source_type = ?${monthClause}
      `).get(...args).count);
      assertPositionImportDiskSpace({
        kind: 'maintenance',
        sideDbPath,
        rowCount: expectedRows,
        availableBytes
      });
      const statement = db.prepare(`
        DELETE FROM position_source_rows
        WHERE id IN (
          SELECT id
          FROM position_source_rows
          WHERE source_type = ?${monthClause}
          ORDER BY id
          LIMIT ?
        )
      `);
      const deletedCount = await deleteInBatches({
        statement,
        args,
        batchSize: normalizedBatchSize,
        cancelToken,
        onProgress,
        stage: 'deleting-source',
        expectedRows
      });
      if (deletedCount !== expectedRows) {
        throw maintenanceError(
          'position-side-data-invalid',
          '链接原始表删除行数与事务内预检不一致',
          [`预期 ${expectedRows} 行，实际 ${deletedCount} 行`]
        );
      }
      bumpRevision(db, 'source', selection.sourceType);
      bumpRevision(db, 'linked', selection.sourceType);
      refreshPositionSourceSummary(db, selection.sourceType, {
        onPhase: (phase) => emitProgress(onProgress, {
          stage: 'summarizing',
          summaryPhase: phase,
          scannedRows: deletedCount,
          acceptedRows: expectedRows,
          committedRows: 0
        })
      });
      return {
        sourceType: selection.sourceType,
        deletedCount
      };
    }
  });
  return { ...mutation.result, nextCheckpoint: mutation.nextCheckpoint };
}

function bankDeleteSelection(payload = {}) {
  const channels = uniqueTextList(payload.channels);
  const months = uniqueTextList(payload.months);
  if (channels.length === 0 || months.length === 0) {
    throw maintenanceError(
      'position-scope-selection-empty',
      '删除前请至少选择一个银行渠道和一个月份'
    );
  }
  return { channels, months };
}

async function deleteBankScopesStreamed({
  db,
  expectedCheckpoint,
  operationToken,
  payload,
  cancelToken,
  onProgress,
  batchSize = POSITION_IMPORT_MAINTENANCE_BATCH_SIZE,
  sideDbPath,
  availableBytes
}) {
  const selection = bankDeleteSelection(payload);
  const normalizedBatchSize = normalizeBatchSize(batchSize);
  const channelClause = placeholders(selection.channels.length);
  const monthClause = placeholders(selection.months.length);
  const args = [...selection.channels, ...selection.months];
  const mutation = await runPositionSideDbMutation({
    db,
    expectedCheckpoint,
    operationToken,
    requireExternalOperationToken: true,
    mutate: async () => {
      const scopes = db.prepare(`
        SELECT channel, month_key AS monthKey, COUNT(*) AS rowCount
        FROM position_bank_rows
        WHERE channel IN (${channelClause})
          AND month_key IN (${monthClause})
        GROUP BY channel, month_key
        ORDER BY channel COLLATE NOCASE, month_key
      `).all(...args).map((row) => ({
        channel: text(row.channel),
        monthKey: text(row.monthKey),
        rowCount: Number(row.rowCount)
      }));
      const expectedRows = scopes.reduce((sum, scope) => sum + scope.rowCount, 0);
      if (expectedRows === 0) {
        throw maintenanceError(
          'position-bank-delete-empty',
          '所选 Channel 和月份下没有可删除的银行数据'
        );
      }
      assertPositionImportDiskSpace({
        kind: 'maintenance',
        sideDbPath,
        rowCount: expectedRows,
        availableBytes
      });
      const statement = db.prepare(`
        DELETE FROM position_bank_rows
        WHERE id IN (
          SELECT id
          FROM position_bank_rows
          WHERE channel IN (${channelClause})
            AND month_key IN (${monthClause})
          ORDER BY id
          LIMIT ?
        )
      `);
      const deletedCount = await deleteInBatches({
        statement,
        args,
        batchSize: normalizedBatchSize,
        cancelToken,
        onProgress,
        stage: 'deleting-bank',
        expectedRows
      });
      if (deletedCount !== expectedRows) {
        throw maintenanceError(
          'position-side-data-invalid',
          '银行数据删除行数与事务内预检不一致',
          [`预期 ${expectedRows} 行，实际 ${deletedCount} 行`]
        );
      }
      for (const scope of scopes) {
        bumpRevision(db, 'bank', `${scope.channel}\u0000${scope.monthKey}`);
      }
      bumpRevision(db, 'bank-global', 'all');
      return {
        deletedCount,
        scopes: scopes.map(({ channel, monthKey }) => ({ channel, monthKey }))
      };
    }
  });
  return { ...mutation.result, nextCheckpoint: mutation.nextCheckpoint };
}

function normalizeMappings(value) {
  const normalized = (Array.isArray(value) ? value : []).map((mapping) => ({
    midAccountId: text(mapping && mapping.midAccountId),
    clearingAccountId: text(mapping && mapping.clearingAccountId)
  }));
  const seen = new Set();
  normalized.forEach((mapping, index) => {
    if (!mapping.midAccountId || !mapping.clearingAccountId) {
      throw maintenanceError(
        'position-account-mapping-invalid',
        `第 ${index + 1} 行账户映射未填写完整`
      );
    }
    if (seen.has(mapping.midAccountId)) {
      throw maintenanceError(
        'position-account-mapping-invalid',
        `中台调拨单账户号重复：${mapping.midAccountId}`
      );
    }
    seen.add(mapping.midAccountId);
  });
  return normalized;
}

function assertSourcePayload(payload, sourceType, businessKey) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw maintenanceError(
      'position-side-data-invalid',
      `链接原始行 ${sourceType}/${businessKey} 不是对象`
    );
  }
  const missing = SOURCE_DEFINITIONS[sourceType].headers.filter(
    (header) => !Object.prototype.hasOwnProperty.call(payload, header)
  );
  if (missing.length > 0) {
    throw maintenanceError(
      'position-side-data-invalid',
      `链接原始行 ${sourceType}/${businessKey} 缺少必填字段`,
      missing.slice(0, 20)
    );
  }
  return payload;
}

function linkedInsertStatement(db) {
  return db.prepare(`
    INSERT INTO position_link_rows(
      source_type, business_key, source_record_key, source_row_id,
      source_row_number, ordinal, leg_index, recon_id, merchant_id,
      currency, amount, fund_type, status, event_date, visible, linked_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
}

async function rebuildFundTransferLinksStreamed({
  db,
  expectedCheckpoint,
  operationToken,
  payload,
  cancelToken,
  onProgress,
  batchSize = POSITION_IMPORT_MAINTENANCE_BATCH_SIZE,
  sideDbPath,
  availableBytes
}) {
  const mappings = normalizeMappings(payload && payload.mappings);
  const normalizedBatchSize = normalizeBatchSize(batchSize);
  const mutation = await runPositionSideDbMutation({
    db,
    expectedCheckpoint,
    operationToken,
    requireExternalOperationToken: true,
    mutate: async () => {
      assertNotCancelled(cancelToken);
      const totalRows = Number(db.prepare(`
        SELECT COUNT(*) AS count
        FROM position_source_rows
        WHERE source_type = ?
      `).get(SOURCE_TYPES.FUND_TRANSFER).count);
      assertPositionImportDiskSpace({
        kind: 'maintenance',
        sideDbPath,
        rowCount: totalRows,
        availableBytes
      });
      db.exec('DELETE FROM position_account_mappings;');
      const insertMapping = db.prepare(`
        INSERT INTO position_account_mappings(mid_account_id, clearing_account_id)
        VALUES (?, ?)
      `);
      for (const mapping of mappings) {
        insertMapping.run(mapping.midAccountId, mapping.clearingAccountId);
      }

      db.prepare(
        'DELETE FROM position_link_rows WHERE source_type = ?'
      ).run(SOURCE_TYPES.FUND_TRANSFER);
      const sourceRows = db.prepare(`
        SELECT id, business_key AS businessKey, event_date AS eventDate,
               month_key AS monthKey, source_row_number AS sourceRowNumber,
               row_hash AS sourceRecordKey, raw_json AS rawJson
        FROM position_source_rows
        WHERE source_type = ?
        ORDER BY id
      `).iterate(SOURCE_TYPES.FUND_TRANSFER);
      const insertLink = linkedInsertStatement(db);
      let scannedRows = 0;
      let linkedRowCount = 0;
      let visibleLinkedRowCount = 0;
      for (const source of sourceRows) {
        assertNotCancelled(cancelToken);
        const sourceRecordKey = text(source.sourceRecordKey);
        if (!sourceRecordKey) {
          throw maintenanceError(
            'position-side-data-invalid',
            `中台调拨订单 ${text(source.businessKey) || '(空)'} 缺少来源记录标识`
          );
        }
        const sourceRowNumber = Number(source.sourceRowNumber);
        const row = assertSourcePayload(
          parseJson(
            source.rawJson,
            `链接原始行 ${SOURCE_TYPES.FUND_TRANSFER}/${source.businessKey}`
          ),
          SOURCE_TYPES.FUND_TRANSFER,
          source.businessKey
        );
        const derived = deriveLinkedRowsForRecord(
          SOURCE_TYPES.FUND_TRANSFER,
          {
            sourceType: SOURCE_TYPES.FUND_TRANSFER,
            businessKey: text(source.businessKey),
            sourceRecordKey,
            sourceRowId: Number(source.id),
            sourceRowNumber,
            eventDate: text(source.eventDate),
            monthKey: text(source.monthKey),
            row
          },
          mappings
        );
        for (const item of derived) {
          const linked = item.row;
          const missing = LINK_HEADERS[SOURCE_TYPES.FUND_TRANSFER].filter(
            (header) => !Object.prototype.hasOwnProperty.call(linked, header)
          );
          if (missing.length > 0) {
            throw maintenanceError(
              'position-side-data-invalid',
              `中台调拨派生行 ${text(source.businessKey)} 缺少必填字段`,
              missing
            );
          }
          insertLink.run(
            SOURCE_TYPES.FUND_TRANSFER,
            text(source.businessKey),
            sourceRecordKey,
            Number(source.id),
            sourceRowNumber,
            Number(source.id),
            item.legIndex,
            text(linked.ReconID),
            text(linked.MerchantId),
            text(linked.Currency),
            text(linked.Amount),
            text(linked.FundType),
            text(linked['调拨状态']),
            text(linked['交易时间']),
            item.visible === false ? 0 : 1,
            serializeJson(linked)
          );
          linkedRowCount += 1;
          if (item.visible !== false) visibleLinkedRowCount += 1;
        }
        scannedRows += 1;
        if (scannedRows % normalizedBatchSize === 0) {
          emitProgress(onProgress, {
            stage: 'deriving',
            scannedRows,
            acceptedRows: totalRows,
            committedRows: 0
          });
          await yieldToEventLoop();
        }
      }
      assertNotCancelled(cancelToken);
      if (scannedRows !== totalRows) {
        throw maintenanceError(
          'position-side-data-invalid',
          '中台调拨映射重建扫描行数不守恒',
          [`预期 ${totalRows} 行，实际 ${scannedRows} 行`]
        );
      }
      bumpRevision(db, 'mapping', 'global');
      bumpRevision(db, 'linked', SOURCE_TYPES.FUND_TRANSFER);
      refreshPositionSourceSummary(db, SOURCE_TYPES.FUND_TRANSFER, {
        refreshRaw: false,
        refreshLinked: true,
        onPhase: (phase) => emitProgress(onProgress, {
          stage: 'summarizing',
          summaryPhase: phase,
          scannedRows,
          acceptedRows: totalRows,
          committedRows: 0
        })
      });
      return {
        count: mappings.length,
        sourceRowCount: scannedRows,
        linkedRowCount,
        visibleLinkedRowCount
      };
    }
  });
  return { ...mutation.result, nextCheckpoint: mutation.nextCheckpoint };
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

async function runPositionMaintenanceJob(input = {}) {
  const command = String(input.command || '');
  if (!MAINTENANCE_COMMANDS.has(command)) {
    throw maintenanceError(
      'position-import-intent-not-durable',
      `未知平盘维护命令：${command || '(空)'}`
    );
  }
  const sideDbPath = path.resolve(String(input.sideDbPath || ''));
  if (!String(input.sideDbPath || '').trim() || !fs.existsSync(sideDbPath)) {
    throw maintenanceError('position-side-db-missing', '平盘对账侧库不存在');
  }
  const db = new DatabaseSync(sideDbPath);
  try {
    configureDatabase(db);
    assertPositionLargeImportSchema(db);
    const common = {
      db,
      expectedCheckpoint: input.expectedCheckpoint,
      operationToken: input.operationToken,
      payload: input.payload || {},
      cancelToken: input.cancelToken,
      onProgress: input.onProgress,
      batchSize: input.batchSize,
      sideDbPath,
      availableBytes: input.availableBytes
    };
    if (command === POSITION_IMPORT_COMMANDS.DELETE_BANK) {
      return await deleteBankScopesStreamed(common);
    }
    if (command === POSITION_IMPORT_COMMANDS.DELETE_SOURCE) {
      return await deleteSourceRowsStreamed(common);
    }
    return await rebuildFundTransferLinksStreamed(common);
  } finally {
    db.close();
  }
}

module.exports = {
  MAINTENANCE_COMMANDS,
  bankDeleteSelection,
  deleteBankScopesStreamed,
  deleteSourceRowsStreamed,
  normalizeMappings,
  normalizeBatchSize,
  rebuildFundTransferLinksStreamed,
  runPositionMaintenanceJob,
  sourceDeleteSelection
};
