'use strict';

const { randomUUID } = require('node:crypto');
const path = require('node:path');

const { FileValidationError } = require('./file-service/common');
const runDataStore = require('./run-data-store');
const {
  getOperationReceipt,
  hasAnyOperationReceipts,
  insertOperationReceipt
} = require('../main-process/pre-fund-reconciliation/mpt-import/operation-receipt-repository');
const {
  readAndValidateMptFileSpool
} = require('../main-process/pre-fund-reconciliation/mpt-import/spool-reader');
const {
  batchMatchesReceiptEvidence,
  readBatchActualCounts
} = require('../main-process/pre-fund-reconciliation/mpt-import/business-evidence');
const {
  createMptRowAggregateError: rowAggregateError,
  parseMptFile
} = require('../main-process/pre-fund-reconciliation/mpt-parser');
const {
  compareFileSequences,
  MPT_SCHEMAS,
  normalizeDate,
  parseMptFileName,
  SOURCE_TYPE_INBOUND,
} = require('../main-process/pre-fund-reconciliation/mpt-schema');

const MODULE = runDataStore.MODULE_PRE_FUND_RECONCILIATION;
const DEFAULT_WRITE_BATCH_SIZE = 1000;
const MUTATION_TAILS = new Map();

const SELECT_BATCH_BY_FILE = `
  SELECT *
  FROM pre_fund_reconciliation_gateway_batches
  WHERE source_file_name = ?
`;

const SELECT_BATCH_BY_IDENTITY = `
  SELECT *
  FROM pre_fund_reconciliation_gateway_batches
  WHERE source_type = ? AND source_batch = ?
`;

const BATCH_DATE_RANGE_WHERE = 'source_date BETWEEN ? AND ?';
const SELECT_BATCH_DATE_RANGE_SUMMARY = `
  SELECT COUNT(*) AS batch_count, COALESCE(SUM(row_count), 0) AS row_count
  FROM pre_fund_reconciliation_gateway_batches
  WHERE ${BATCH_DATE_RANGE_WHERE}
`;
const SELECT_BATCH_DATE_RANGE_SUMMARY_BY_SOURCE = `
  SELECT COUNT(*) AS batch_count, COALESCE(SUM(row_count), 0) AS row_count
  FROM pre_fund_reconciliation_gateway_batches
  WHERE ${BATCH_DATE_RANGE_WHERE} AND source_type = ?
`;

const INSERT_BATCH = `
  INSERT INTO pre_fund_reconciliation_gateway_batches (
    source_type, source_batch, source_date, source_file_name, source_file_sequence,
    content_hash, declared_row_count, row_count
  ) VALUES (?, ?, ?, ?, ?, '', ?, 0)
`;

const INSERT_ROW = `
  INSERT INTO pre_fund_reconciliation_gateway_rows (
    batch_id, source_type, source_batch, source_date, source_file_name, source_file_sequence,
    source_row_number, reconciliation_id, gateway_date, channel, merchant_id, order_id,
    bill_recon_id, recon_bill_biz_id, currency, amount, trade_type, name, card_no,
    real_channel, clearing_network, raw_json, fingerprint
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`;

const INSERT_EXCLUDED_ROW = `
  INSERT INTO pre_fund_reconciliation_gateway_excluded_rows (
    batch_id, source_type, source_file_name, source_row_number, error_code,
    error_message, field_name, fields_json, raw_line
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`;

function storeError(code, message, context = {}) {
  const detailLines = [];
  if (context.fileName) detailLines.push(`文件：${context.fileName}`);
  if (context.sourceType) detailLines.push(`来源：${context.sourceType}`);
  if (context.sourceBatch) detailLines.push(`批次：${context.sourceBatch}`);
  return new FileValidationError(code, message, { context, detailLines });
}

function rollbackQuietly(db) {
  try { db.exec('ROLLBACK'); } catch (_error) { /* 当前没有活动事务时忽略 */ }
}

function ensureRepairSchema(db) {
  const columns = db.prepare('PRAGMA table_info(pre_fund_reconciliation_gateway_batches)').all();
  if (!columns.some((column) => column.name === 'excluded_row_count')) {
    db.exec(`
      ALTER TABLE pre_fund_reconciliation_gateway_batches
      ADD COLUMN excluded_row_count INTEGER NOT NULL DEFAULT 0
    `);
  }
  if (!columns.some((column) => column.name === 'import_mode')) {
    db.exec(`
      ALTER TABLE pre_fund_reconciliation_gateway_batches
      ADD COLUMN import_mode TEXT NOT NULL DEFAULT 'strict'
    `);
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS pre_fund_reconciliation_gateway_excluded_rows (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      batch_id INTEGER NOT NULL,
      source_type TEXT NOT NULL,
      source_file_name TEXT NOT NULL,
      source_row_number INTEGER NOT NULL,
      error_code TEXT NOT NULL,
      error_message TEXT NOT NULL,
      field_name TEXT,
      fields_json TEXT NOT NULL,
      raw_line TEXT NOT NULL,
      FOREIGN KEY (batch_id) REFERENCES pre_fund_reconciliation_gateway_batches(id) ON DELETE CASCADE,
      UNIQUE (batch_id, source_row_number)
    );
    CREATE INDEX IF NOT EXISTS idx_pre_fund_gateway_excluded_batch
      ON pre_fund_reconciliation_gateway_excluded_rows(batch_id, source_row_number);
  `);
}

function normalizeImportOptions(options = {}) {
  const skipInvalidRows = options.skipInvalidRows === true;
  const expectedContentHash = options.expectedContentHash == null
    ? ''
    : String(options.expectedContentHash).trim().toLowerCase();
  if (skipInvalidRows && !/^[a-f0-9]{64}$/.test(expectedContentHash)) {
    throw new TypeError('逻辑删除重跑必须提供原文件 SHA-256');
  }
  return { skipInvalidRows, expectedContentHash };
}

function freezeDatasetSeedV1(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)
      || Object.keys(raw).length !== 2
      || typeof raw.datasetId !== 'string' || !raw.datasetId.trim()
      || typeof raw.producerTaskRunId !== 'string' || !raw.producerTaskRunId.trim()) {
    throw new TypeError('前置资金 MPT 导入缺少 exact v1 dataset seed');
  }
  return Object.freeze({
    datasetId: raw.datasetId,
    producerTaskRunId: raw.producerTaskRunId
  });
}

function normalizeDateRange(startDate, endDate) {
  const start = startDate == null ? '' : String(startDate).trim();
  const end = endDate == null ? '' : String(endDate).trim();
  if (!start || !end || start > end) {
    throw new TypeError('日期范围非法（起止必填且起≤止）');
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) {
    throw new TypeError('日期格式非法（需 YYYY-MM-DD）');
  }
  if (normalizeDate(start) !== start || normalizeDate(end) !== end) {
    throw new TypeError('日期值非法（请使用真实日历日期）');
  }
  return { start, end };
}

function normalizeSourceTypeFilter(options = {}) {
  const sourceType = options && options.sourceType != null
    ? String(options.sourceType).trim()
    : '';
  if (sourceType && !Object.prototype.hasOwnProperty.call(MPT_SCHEMAS, sourceType)) {
    throw new TypeError(`不支持的 MPT sourceType：${sourceType}`);
  }
  return sourceType;
}

function lastInsertId(db) {
  return db.prepare('SELECT last_insert_rowid() AS id').get().id;
}

function assertManagedSpoolOptions(options) {
  const actionKey = String(options.actionKey || '');
  const operationKey = String(options.operationKey || '');
  const producerTaskRunId = String(options.producerTaskRunId || '');
  const datasetId = String(options.datasetId || '');
  if (!['pre-fund:mpt-import', 'pre-fund:mpt-repair-import'].includes(actionKey) ||
      !operationKey || !producerTaskRunId || !datasetId ||
      !Number.isSafeInteger(options.fileIndex) || options.fileIndex < 0) {
    throw new TypeError('PreFund managed spool operation identity非法');
  }
  return Object.freeze({ actionKey, operationKey, producerTaskRunId, datasetId, fileIndex: options.fileIndex });
}

function resultFromManagedReceipt(receipt, batch, monthKey) {
  return {
    status: receipt.outcomeKind === 'inserted'
      ? 'imported'
      : (receipt.outcomeKind === 'replaced' ? 'replaced' : 'noop'),
    monthKey,
    replacedFileName: receipt.outcomeKind === 'replaced' ? null : undefined,
    batch: mapBatchRow(batch, monthKey),
    excludedRowCount: Number(batch.excluded_row_count) || 0,
    receipt
  };
}

function assertReceiptReplay(db, receipt, manifest, managed, monthKey) {
  const expectedStatic = receipt.actionKey === managed.actionKey &&
    receipt.operationKey === managed.operationKey &&
    receipt.producerTaskRunId === managed.producerTaskRunId &&
    receipt.fileIndex === managed.fileIndex &&
    receipt.sourceFileName === manifest.header.sourceFileName &&
    receipt.sourceSha256 === manifest.source.sha256 &&
    receipt.contentHash === manifest.contentHash;
  const batch = db.prepare('SELECT * FROM pre_fund_reconciliation_gateway_batches WHERE id = ?')
    .get(receipt.batchId);
  const evidence = {
    sourceType: manifest.header.sourceType,
    sourceBatch: manifest.header.sourceBatch,
    sourceDate: manifest.header.sourceDate,
    sourceFileSequence: manifest.header.sourceFileSequence,
    sourceFileName: manifest.header.sourceFileName,
    contentHash: manifest.contentHash,
    datasetId: managed.datasetId,
    counts: manifest.counts
  };
  const actualCounts = batch ? readBatchActualCounts(db, batch.id) : { valid: -1, excluded: -1 };
  if (!expectedStatic || !batchMatchesReceiptEvidence(batch, receipt, evidence, actualCounts)) {
    throw Object.assign(new Error('同一PreFund fileOperationKey的receipt或业务lineage冲突'), {
      code: 'PREFUND_RECEIPT_IDENTITY_CONFLICT'
    });
  }
  return resultFromManagedReceipt(receipt, batch, monthKey);
}

// 同一 userData 下导入/删除/清空串行化。DatabaseSync 的 BEGIN IMMEDIATE 会同步等待写锁；
// 若两个异步流式导入在同一事件循环里直接争锁，后者会阻塞前者继续读流并形成自锁。
function withMutationLock(lockKey, task) {
  const previous = MUTATION_TAILS.get(lockKey) || Promise.resolve();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const tail = previous.catch(() => {}).then(() => gate);
  MUTATION_TAILS.set(lockKey, tail);

  return previous
    .catch(() => {})
    .then(task)
    .finally(() => {
      release();
      if (MUTATION_TAILS.get(lockKey) === tail) MUTATION_TAILS.delete(lockKey);
    });
}

function mapBatchRow(row, monthKey) {
  return {
    id: row.id,
    monthKey,
    sourceType: row.source_type,
    sourceBatch: row.source_batch,
    sourceDate: row.source_date,
    sourceFileName: row.source_file_name,
    sourceFileSequence: row.source_file_sequence,
    contentHash: row.content_hash,
    declaredRowCount: row.declared_row_count,
    rowCount: row.row_count,
    excludedRowCount: Number(row.excluded_row_count) || 0,
    importMode: row.import_mode || 'strict',
    datasetId: row.dataset_id || null,
    producerTaskRunId: row.producer_task_run_id || null,
    datasetVersion: Number(row.dataset_version),
    archiveContractVersion: Number(row.archive_contract_version) === 1 ? 1 : 0,
    importedAt: row.imported_at,
  };
}

class MptImportTransaction {
  constructor(db, monthKey, importOptions, datasetSeed, receiptOwner = null) {
    this.db = db;
    this.monthKey = monthKey;
    this.importOptions = importOptions;
    this.datasetSeed = datasetSeed;
    this.receiptOwner = receiptOwner;
    this.started = false;
    this.header = null;
    this.verifyExistingFile = null;
    this.replacedBatch = null;
    this.incomingBatchId = null;
    this.insertRowStatement = null;
    this.insertExcludedRowStatement = null;
  }

  begin(header, options = {}) {
    this.header = header;
    if (options.alreadyStarted !== true) this.db.exec('BEGIN IMMEDIATE');
    this.started = true;
    this.verifyExistingFile = this.db.prepare(SELECT_BATCH_BY_FILE).get(header.sourceFileName) || null;
    if (this.verifyExistingFile) return;
    const existingBatch = this.db.prepare(SELECT_BATCH_BY_IDENTITY)
      .get(header.sourceType, header.sourceBatch) || null;
    if (existingBatch) {
      const order = compareFileSequences(header.sourceFileSequence, existingBatch.source_file_sequence);
      if (order <= 0) {
        throw storeError(
          'MPT_BATCH_SEQUENCE_STALE',
          '同一批次只接受文件序号更高的新文件，已拒绝旧序号或相同序号文件',
          {
            fileName: header.sourceFileName,
            sourceType: header.sourceType,
            sourceBatch: header.sourceBatch,
            incomingSequence: header.sourceFileSequence,
            currentSequence: existingBatch.source_file_sequence
          }
        );
      }
      this.replacedBatch = existingBatch;
    }
    if (this.replacedBatch) {
      this.db.prepare('DELETE FROM pre_fund_reconciliation_gateway_rows WHERE batch_id = ?')
        .run(this.replacedBatch.id);
      this.db.prepare('DELETE FROM pre_fund_reconciliation_gateway_excluded_rows WHERE batch_id = ?')
        .run(this.replacedBatch.id);
      this.db.prepare(`
        UPDATE pre_fund_reconciliation_gateway_batches
        SET source_date = ?, source_file_name = ?, source_file_sequence = ?,
            content_hash = '', declared_row_count = ?, row_count = 0,
            excluded_row_count = 0, import_mode = 'strict',
            imported_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(
        header.sourceDate,
        header.sourceFileName,
        header.sourceFileSequence,
        header.declaredRowCount,
        this.replacedBatch.id
      );
      this.incomingBatchId = this.replacedBatch.id;
    } else {
      this.db.prepare(INSERT_BATCH).run(
        header.sourceType,
        header.sourceBatch,
        header.sourceDate,
        header.sourceFileName,
        header.sourceFileSequence,
        header.declaredRowCount
      );
      this.incomingBatchId = lastInsertId(this.db);
    }
    this.insertRowStatement = this.db.prepare(INSERT_ROW);
    this.insertExcludedRowStatement = this.db.prepare(INSERT_EXCLUDED_ROW);
  }

  writeRows(rows) {
    if (this.verifyExistingFile || rows.length === 0) return;
    this.db.exec('SAVEPOINT mpt_gateway_row_batch');
    try {
      for (const row of rows) {
        this.insertRowStatement.run(
          this.incomingBatchId,
          row.sourceType,
          row.sourceBatch,
          row.sourceDate,
          row.sourceFileName,
          row.sourceFileSequence,
          row.sourceRowNumber,
          row.reconciliationId,
          row.date,
          row.channel,
          row.merchantId,
          row.orderId,
          row.billReconId,
          row.reconBillBizId,
          row.currency,
          row.amount,
          row.tradeType,
          row.name,
          row.cardNo,
          row.realChannel,
          row.clearingNetwork,
          row.rawJson,
          row.fingerprint
        );
      }
      this.db.exec('RELEASE SAVEPOINT mpt_gateway_row_batch');
    } catch (error) {
      this.db.exec('ROLLBACK TO SAVEPOINT mpt_gateway_row_batch');
      this.db.exec('RELEASE SAVEPOINT mpt_gateway_row_batch');
      throw error;
    }
  }

  writeIssue(issue) {
    if (this.verifyExistingFile || !this.importOptions.skipInvalidRows) return;
    this.insertExcludedRowStatement.run(
      this.incomingBatchId,
      this.header.sourceType,
      this.header.sourceFileName,
      issue.sourceRowNumber,
      issue.code,
      issue.message,
      issue.fieldName || '',
      JSON.stringify(issue.fields || []),
      issue.rawLine || ''
    );
  }

  finalize(summary) {
    let outcomeKind;
    let batch;
    if (this.verifyExistingFile) {
      if (this.verifyExistingFile.content_hash !== summary.contentHash) {
        throw storeError(
          'MPT_FILE_IDENTITY_CONFLICT',
          '同文件名的内容 hash 与已导入文件不同，已拒绝文件身份冲突',
          this.header
        );
      }
      outcomeKind = 'noop-existing-batch';
      batch = this.verifyExistingFile;
    } else {
      if (this.importOptions.expectedContentHash && summary.contentHash !== this.importOptions.expectedContentHash) {
        throw storeError(
          'MPT_REPAIR_SOURCE_CHANGED',
          '原始 MPT 文件内容已变化，不能继续导出错误数据或删除错误数据并重跑',
          this.header
        );
      }
      if (summary.rowErrorCount > 0 && !this.importOptions.skipInvalidRows) {
        throw rowAggregateError(summary);
      }
      const nextVersion = this.replacedBatch
        ? Number(this.replacedBatch.dataset_version) + 1
        : (this.datasetSeed ? 1 : 0);
      this.db.prepare(`
        UPDATE pre_fund_reconciliation_gateway_batches
        SET content_hash = ?, row_count = ?, excluded_row_count = ?, import_mode = ?,
            dataset_id = ?, producer_task_run_id = ?, dataset_version = ?,
            archive_contract_version = ?
        WHERE id = ?
      `).run(
        summary.contentHash,
        summary.validRowCount,
        summary.excludedRowCount,
        this.importOptions.skipInvalidRows ? 'exclude-invalid-rows' : 'strict',
        this.datasetSeed ? this.datasetSeed.datasetId : randomUUID(),
        this.datasetSeed ? this.datasetSeed.producerTaskRunId : null,
        nextVersion,
        this.datasetSeed ? 1 : 0,
        this.incomingBatchId
      );
      batch = this.db.prepare('SELECT * FROM pre_fund_reconciliation_gateway_batches WHERE id = ?')
        .get(this.incomingBatchId);
      outcomeKind = this.replacedBatch ? 'replaced' : 'inserted';
    }
    let receipt = null;
    if (this.receiptOwner) {
      receipt = insertOperationReceipt(this.db, {
        ...this.receiptOwner,
        outcomeKind,
        batchId: Number(batch.id),
        datasetId: batch.dataset_id || null,
        datasetVersionBefore: this.replacedBatch
          ? Number(this.replacedBatch.dataset_version)
          : (outcomeKind === 'noop-existing-batch' ? Number(batch.dataset_version) : null),
        datasetVersionAfter: Number(batch.dataset_version),
        sourceFileName: summary.sourceFileName,
        contentHash: summary.contentHash
      }).receipt;
    }
    this.db.exec('COMMIT');
    this.started = false;
    const result = {
      status: outcomeKind === 'inserted' ? 'imported' : (outcomeKind === 'replaced' ? 'replaced' : 'noop'),
      monthKey: this.monthKey,
      batch: mapBatchRow(batch, this.monthKey),
      excludedRowCount: Number(summary.excludedRowCount) || 0
    };
    if (this.replacedBatch) result.replacedFileName = this.replacedBatch.source_file_name;
    if (receipt) result.receipt = receipt;
    return result;
  }

  rollback() {
    if (!this.started) return;
    rollbackQuietly(this.db);
    this.started = false;
  }
}

function mapGatewayRow(row, monthKey) {
  return {
    id: row.id,
    batchId: row.batch_id,
    monthKey,
    sourceType: row.source_type,
    sourceBatch: row.source_batch,
    sourceDate: row.source_date,
    sourceFileName: row.source_file_name,
    sourceFileSequence: row.source_file_sequence,
    sourceRowNumber: row.source_row_number,
    reconciliationId: row.reconciliation_id || '',
    date: row.gateway_date,
    channel: row.channel || '',
    merchantId: row.merchant_id || '',
    orderId: row.order_id || '',
    billReconId: row.bill_recon_id || '',
    reconBillBizId: row.recon_bill_biz_id || '',
    currency: row.currency,
    amount: row.amount,
    tradeType: row.trade_type || '',
    name: row.name || '',
    cardNo: row.card_no || '',
    realChannel: row.real_channel || '',
    clearingNetwork: row.clearing_network || '',
    rawJson: row.raw_json,
    fingerprint: row.fingerprint,
  };
}

function assertDuplicateInboundRawJson(match) {
  let parsed;
  try {
    parsed = JSON.parse(match.rawJson);
  } catch (_error) {
    parsed = null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new FileValidationError(
      'duplicate-inbound-invalid-mpt-raw-json',
      '重复入金候选的 MPT 原始 JSON 已损坏',
      {
        detailLines: [
          `文件：${match.sourceFileName}`,
          `行号：${match.sourceRowNumber}`,
          `月份：${match.monthKey}`
        ],
        context: {
          sourceFileName: match.sourceFileName,
          sourceRowNumber: match.sourceRowNumber,
          monthKey: match.monthKey
        }
      }
    );
  }
}

const EMPTY_DUPLICATE_INBOUND_CANDIDATES = Object.freeze({
  candidateCount: 0,
  candidates: Object.freeze([])
});

class PreFundReconciliationStore {
  constructor(userDataDir, options = {}) {
    if (!userDataDir || typeof userDataDir !== 'string') {
      throw new TypeError('PreFundReconciliationStore 需要 userDataDir');
    }
    this.userDataDir = path.resolve(userDataDir);
    this.writeBatchSize = options.writeBatchSize === undefined
      ? DEFAULT_WRITE_BATCH_SIZE
      : options.writeBatchSize;
    if (!Number.isSafeInteger(this.writeBatchSize) || this.writeBatchSize < 1 || this.writeBatchSize > 100000) {
      throw new TypeError('writeBatchSize 必须为 1 到 100000 的安全整数');
    }
    // 借路径解析复用 run-data-store 的 userDataDir/module 校验，不创建文件。
    runDataStore.moduleDir(this.userDataDir, MODULE);
  }

  async importFile(filePath, options = {}) {
    const fileMetadata = parseMptFileName(filePath);
    const importOptions = normalizeImportOptions(options);
    const datasetSeed = freezeDatasetSeedV1(options.datasetSeed);
    return withMutationLock(
      this.userDataDir,
      () => this._importFileUnlocked(
        filePath,
        fileMetadata,
        importOptions,
        datasetSeed,
        options.identityGate
      )
    );
  }

  async importLegacyFile(filePath, options = {}) {
    const fileMetadata = parseMptFileName(filePath);
    const importOptions = normalizeImportOptions(options);
    return withMutationLock(
      this.userDataDir,
      () => this._importFileUnlocked(filePath, fileMetadata, importOptions, null)
    );
  }

  async importValidatedSpool(spoolInput, options = {}) {
    const managed = assertManagedSpoolOptions(options);
    const importOptions = normalizeImportOptions(options);
    // Single Writer已在critical前严格验证过spool；直接复用该只读证据，事务内仍会
    // 完整重验一次以关闭ACK到BEGIN IMMEDIATE之间的TOCTOU窗口。独立调用者未提供
    // prevalidatedSpool时保持原有预验证行为。
    const validated = options.prevalidatedSpool || await readAndValidateMptFileSpool(spoolInput);
    if (validated.fileIndex !== managed.fileIndex || validated.fileOperationKey !== managed.operationKey) {
      throw Object.assign(new Error('PreFund spool与managed operation identity不一致'), {
        code: 'PREFUND_SPOOL_IDENTITY_MISMATCH'
      });
    }
    if (validated.counts.error > 0 && !importOptions.skipInvalidRows) {
      throw rowAggregateError({
        sourceFileName: validated.header.sourceFileName,
        sourceType: validated.header.sourceType,
        sourceBatch: validated.header.sourceBatch,
        rowErrorCount: validated.counts.error,
        rowErrorSamples: validated.rowErrorSamples,
        contentHash: validated.contentHash
      });
    }
    if (importOptions.skipInvalidRows && validated.counts.error !== 0) {
      throw Object.assign(new Error('repair spool必须把非法行标记为excluded'), {
        code: 'PREFUND_SPOOL_DISPOSITION_INVALID'
      });
    }
    return withMutationLock(
      this.userDataDir,
      () => this._importValidatedSpoolUnlocked(spoolInput, validated, importOptions, managed)
    );
  }

  async _importValidatedSpoolUnlocked(spoolInput, initial, importOptions, managed) {
    const monthKey = initial.header.sourceDate.slice(0, 7);
    const db = runDataStore.openSideDb(this.userDataDir, MODULE, monthKey);
    ensureRepairSchema(db);
    let replayResult = null;
    const rowBuffer = [];
    const transaction = new MptImportTransaction(
      db,
      monthKey,
      importOptions,
      { datasetId: managed.datasetId, producerTaskRunId: managed.producerTaskRunId },
      {
        actionKey: managed.actionKey,
        operationKey: managed.operationKey,
        producerTaskRunId: managed.producerTaskRunId,
        fileIndex: managed.fileIndex,
        sourceSha256: initial.source.sha256
      }
    );

    try {
      const parsed = await readAndValidateMptFileSpool(spoolInput, {
        streamRecordsDuringValidation: true,
        onValidated: async (manifest) => {
          if (manifest.contentHash !== initial.contentHash ||
              manifest.header.identity !== initial.header.identity) {
            throw Object.assign(new Error('PreFund spool在critical ACK后发生变化'), {
              code: 'PREFUND_SPOOL_SOURCE_CHANGED'
            });
          }
          db.exec('BEGIN IMMEDIATE');
          const receipt = getOperationReceipt(db, managed.actionKey, managed.operationKey);
          if (receipt) {
            replayResult = assertReceiptReplay(db, receipt, manifest, managed, monthKey);
            return;
          }
          transaction.begin(manifest.header, { alreadyStarted: true });
        },
        onRow: async (row) => {
          if (replayResult) return;
          rowBuffer.push(row);
          if (rowBuffer.length >= this.writeBatchSize) transaction.writeRows(rowBuffer.splice(0));
        },
        onIssue: async (issue, kind) => {
          if (!replayResult && kind === 'excluded') transaction.writeIssue(issue);
        }
      });

      if (replayResult) {
        db.exec('COMMIT');
        return replayResult;
      }
      transaction.writeRows(rowBuffer.splice(0));
      return transaction.finalize({
        sourceType: parsed.header.sourceType,
        sourceBatch: parsed.header.sourceBatch,
        sourceFileName: parsed.header.sourceFileName,
        contentHash: parsed.contentHash,
        validRowCount: parsed.counts.valid,
        rowErrorCount: parsed.counts.error,
        rowErrorSamples: parsed.rowErrorSamples,
        excludedRowCount: parsed.counts.excluded
      });
    } catch (error) {
      transaction.rollback();
      if (db.isTransaction === true) rollbackQuietly(db);
      throw error;
    } finally {
      db.close();
    }
  }

  async _importFileUnlocked(filePath, fileMetadata, importOptions, datasetSeed, identityGate = null) {
    const db = runDataStore.openSideDb(this.userDataDir, MODULE, fileMetadata.monthKey);
    ensureRepairSchema(db);
    const transaction = new MptImportTransaction(
      db,
      fileMetadata.monthKey,
      importOptions,
      datasetSeed
    );

    try {
      const parsed = await parseMptFile(filePath, {
        batchSize: this.writeBatchSize,
        collectRowErrors: true,
        onHeader: async (header) => {
          if (typeof identityGate === 'function') await identityGate(header);
          transaction.begin(header);
        },
        onRows: async (rows) => {
          transaction.writeRows(rows);
        },
        onRowError: async (issue) => {
          transaction.writeIssue(issue);
        }
      });
      return transaction.finalize({
        ...parsed,
        excludedRowCount: Number(parsed.rowErrorCount) || 0
      });
    } catch (error) {
      transaction.rollback();
      throw error;
    } finally {
      db.close();
    }
  }

  listBatches(options = {}) {
    const sourceType = normalizeSourceTypeFilter(options);
    const out = [];
    for (const file of this._listTargetFiles(options.monthKey)) {
      const db = runDataStore.openSideDb(this.userDataDir, MODULE, file.monthKey);
      try {
        const clauses = [];
        const params = [];
        if (sourceType) {
          clauses.push('source_type = ?');
          params.push(sourceType);
        }
        if (options.sourceBatch) {
          clauses.push('source_batch = ?');
          params.push(options.sourceBatch);
        }
        const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
        const rows = db.prepare(`
          SELECT * FROM pre_fund_reconciliation_gateway_batches
          ${where}
          ORDER BY id ASC
        `).all(...params);
        out.push(...rows.map((row) => mapBatchRow(row, file.monthKey)));
      } finally {
        db.close();
      }
    }
    return out;
  }

  *iterateRows(options = {}) {
    const sourceType = normalizeSourceTypeFilter(options);
    for (const file of this._listTargetFiles(options.monthKey)) {
      const db = runDataStore.openExistingSideDb(file.path);
      try {
        const clauses = [];
        const params = [];
        if (sourceType) {
          clauses.push('r.source_type = ?');
          params.push(sourceType);
        }
        if (options.sourceBatch) {
          clauses.push('r.source_batch = ?');
          params.push(options.sourceBatch);
        }
        if (options.reconciliationId !== undefined) {
          clauses.push('r.reconciliation_id = ?');
          params.push(String(options.reconciliationId).trim());
        }
        const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
        const statement = db.prepare(`
          SELECT r.*
          FROM pre_fund_reconciliation_gateway_rows r
          JOIN pre_fund_reconciliation_gateway_batches b ON b.id = r.batch_id
          ${where}
          ORDER BY b.id ASC, r.source_row_number ASC, r.id ASC
        `);
        for (const row of statement.iterate(...params)) {
          yield mapGatewayRow(row, file.monthKey);
        }
      } finally {
        db.close();
      }
    }
  }

  // v3.0.15 重复入金匹配：按所需 reconId 批量查全部保留月份的临时入金网关账单。
  // 每个月库用 TEMP ID 集合做一次 JOIN；不按银行行重复查询、不扫描 OUTBOUND，也不读主链接表。
  lookupInboundRows(criteriaList) {
    if (!Array.isArray(criteriaList)) {
      throw new TypeError('临时入金网关查询条件必须是数组');
    }
    const normalize = (value) => value == null ? '' : String(value).trim();
    const lookupIdsByTuple = new Map();
    const candidatesByTuple = new Map();
    const reconciliationIds = new Set();
    const result = new Map();
    const seenLookupIds = new Set();
    for (const item of criteriaList) {
      const lookupId = String(item && item.lookupId != null ? item.lookupId : '');
      if (!lookupId || seenLookupIds.has(lookupId)) {
        throw new TypeError('临时入金网关查询 lookupId 必须非空且唯一');
      }
      seenLookupIds.add(lookupId);
      const normalized = {
        lookupId,
        reconciliationId: normalize(item.reconciliationId),
        channel: normalize(item.channel),
        merchantId: normalize(item.merchantId)
      };
      result.set(lookupId, EMPTY_DUPLICATE_INBOUND_CANDIDATES);
      if (normalized.reconciliationId === '') continue;
      const tupleKey = JSON.stringify([
        normalized.reconciliationId,
        normalized.channel,
        normalized.merchantId
      ]);
      const lookupIds = lookupIdsByTuple.get(tupleKey) || [];
      lookupIds.push(lookupId);
      lookupIdsByTuple.set(tupleKey, lookupIds);
      if (!candidatesByTuple.has(tupleKey)) {
        candidatesByTuple.set(tupleKey, { candidateCount: 0, candidates: [] });
      }
      reconciliationIds.add(normalized.reconciliationId);
    }
    if (reconciliationIds.size === 0) return result;

    for (const file of this._listTargetFiles()) {
      const db = runDataStore.openExistingSideDb(file.path);
      let transactionStarted = false;
      try {
        db.exec(`
          CREATE TEMP TABLE duplicate_inbound_match_lookup_ids (
            reconciliation_id TEXT PRIMARY KEY
          ) WITHOUT ROWID
        `);
        db.exec('BEGIN');
        transactionStarted = true;
        const insertLookupId = db.prepare(`
          INSERT INTO duplicate_inbound_match_lookup_ids (reconciliation_id) VALUES (?)
        `);
        for (const reconciliationId of reconciliationIds) insertLookupId.run(reconciliationId);

        const statement = db.prepare(`
          SELECT r.*
          FROM pre_fund_reconciliation_gateway_rows r
          JOIN pre_fund_reconciliation_gateway_batches b ON b.id = r.batch_id
          JOIN duplicate_inbound_match_lookup_ids wanted
            ON wanted.reconciliation_id = r.reconciliation_id
          WHERE r.source_type = ? AND r.trade_type = ?
          ORDER BY b.id ASC, r.source_row_number ASC, r.id ASC
        `);
        for (const row of statement.iterate(SOURCE_TYPE_INBOUND, 'Inbound-VA')) {
          const match = mapGatewayRow(row, file.monthKey);
          const tupleKey = JSON.stringify([
            match.reconciliationId,
            match.channel,
            match.merchantId
          ]);
          const lookupIds = lookupIdsByTuple.get(tupleKey);
          if (!lookupIds) continue;
          assertDuplicateInboundRawJson(match);
          const collection = candidatesByTuple.get(tupleKey);
          collection.candidateCount += 1;
          if (collection.candidates.length < 2) {
            collection.candidates.push({
              ...match,
              candidateId: `${file.monthKey}:${match.id}`
            });
          }
        }
        db.exec('COMMIT');
        transactionStarted = false;
      } catch (error) {
        if (transactionStarted) rollbackQuietly(db);
        throw error;
      } finally {
        db.close();
      }
    }
    for (const [tupleKey, lookupIds] of lookupIdsByTuple) {
      const mutable = candidatesByTuple.get(tupleKey);
      const collection = Object.freeze({
        candidateCount: mutable.candidateCount,
        candidates: Object.freeze(mutable.candidates.slice())
      });
      for (const lookupId of lookupIds) result.set(lookupId, collection);
    }
    return result;
  }

  getRawJsonById(monthKey, rowId) {
    if (typeof monthKey !== 'string' || !/^\d{4}-\d{2}$/.test(monthKey)) {
      throw new TypeError('临时网关原始行 monthKey 必须为 YYYY-MM');
    }
    const id = Number(rowId);
    if (!Number.isSafeInteger(id) || id <= 0) {
      throw new TypeError('临时网关原始行 id 必须为正整数');
    }
    const filePath = runDataStore.sideDbPath(this.userDataDir, MODULE, monthKey);
    if (!runDataStore.sideDbExists(this.userDataDir, MODULE, monthKey)) return null;
    const db = runDataStore.openExistingSideDb(filePath);
    try {
      const row = db.prepare(`
        SELECT raw_json FROM pre_fund_reconciliation_gateway_rows WHERE id = ?
      `).get(id);
      return row ? row.raw_json : null;
    } finally {
      db.close();
    }
  }

  *iterateExcludedRows(options = {}) {
    const sourceType = normalizeSourceTypeFilter(options);
    for (const file of this._listTargetFiles(options.monthKey)) {
      const db = runDataStore.openExistingSideDb(file.path);
      try {
        const hasAuditTable = db.prepare(`
          SELECT 1 AS found
          FROM sqlite_master
          WHERE type = 'table' AND name = 'pre_fund_reconciliation_gateway_excluded_rows'
        `).get();
        if (!hasAuditTable) continue;
        const clauses = [];
        const params = [];
        if (sourceType) {
          clauses.push('e.source_type = ?');
          params.push(sourceType);
        }
        if (options.sourceBatch) {
          clauses.push('b.source_batch = ?');
          params.push(String(options.sourceBatch));
        }
        const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
        const rows = db.prepare(`
          SELECT e.*, b.source_batch
          FROM pre_fund_reconciliation_gateway_excluded_rows e
          JOIN pre_fund_reconciliation_gateway_batches b ON b.id = e.batch_id
          ${where}
          ORDER BY b.id ASC, e.source_row_number ASC, e.id ASC
        `).iterate(...params);
        for (const row of rows) {
          yield {
            id: row.id,
            batchId: row.batch_id,
            monthKey: file.monthKey,
            sourceType: row.source_type,
            sourceBatch: row.source_batch,
            sourceFileName: row.source_file_name,
            sourceRowNumber: row.source_row_number,
            errorCode: row.error_code,
            errorMessage: row.error_message,
            fieldName: row.field_name || '',
            fields: JSON.parse(row.fields_json),
            rawLine: row.raw_line
          };
        }
      } finally {
        db.close();
      }
    }
  }

  async deleteBatch(options = {}) {
    return withMutationLock(this.userDataDir, () => this._deleteBatchUnlocked(options));
  }

  _deleteBatchUnlocked({ sourceType, sourceBatch, monthKey } = {}) {
    if (!sourceType || !sourceBatch) {
      throw new TypeError('deleteBatch 必须提供 sourceType 和 sourceBatch');
    }
    const normalizedSourceType = normalizeSourceTypeFilter({ sourceType });
    let deletedBatches = 0;
    let deletedRows = 0;

    for (const file of this._listTargetFiles(monthKey)) {
      let deleteFileAfterClose = false;
      const db = runDataStore.openExistingSideDb(file.path);
      try {
        db.exec('BEGIN IMMEDIATE');
        const batch = db.prepare(SELECT_BATCH_BY_IDENTITY).get(normalizedSourceType, sourceBatch);
        if (!batch) {
          db.exec('COMMIT');
          continue;
        }
        const rowCount = db.prepare(
          'SELECT COUNT(*) AS count FROM pre_fund_reconciliation_gateway_rows WHERE batch_id = ?'
        ).get(batch.id).count;
        try {
          db.prepare('DELETE FROM pre_fund_reconciliation_gateway_batches WHERE id = ?').run(batch.id);
          db.exec('COMMIT');
        } catch (error) {
          rollbackQuietly(db);
          throw error;
        }
        deletedBatches += 1;
        deletedRows += rowCount;
        deleteFileAfterClose = Number(
          db.prepare('SELECT COUNT(*) AS count FROM pre_fund_reconciliation_gateway_batches').get().count
        ) === 0 && !hasAnyOperationReceipts(db);
      } finally {
        db.close();
      }
      if (deleteFileAfterClose && !runDataStore.deleteSideDbByPath(file.path).deleted) {
        throw new Error(`临时网关账单月侧库删除失败：${file.path}`);
      }
    }

    return { deletedBatches, deletedRows };
  }

  countByDateRange(startDate, endDate, options = {}) {
    const { start, end } = normalizeDateRange(startDate, endDate);
    const sourceType = normalizeSourceTypeFilter(options);
    let batchCount = 0;
    let rowCount = 0;
    for (const file of this._listTargetFiles()) {
      const db = runDataStore.openExistingSideDb(file.path);
      try {
        const summary = sourceType
          ? db.prepare(SELECT_BATCH_DATE_RANGE_SUMMARY_BY_SOURCE).get(start, end, sourceType)
          : db.prepare(SELECT_BATCH_DATE_RANGE_SUMMARY).get(start, end);
        batchCount += Number(summary.batch_count) || 0;
        rowCount += Number(summary.row_count) || 0;
      } finally {
        db.close();
      }
    }
    return { batchCount, rowCount };
  }

  async deleteByDateRange(startDate, endDate, options = {}) {
    const range = normalizeDateRange(startDate, endDate);
    const sourceType = normalizeSourceTypeFilter(options);
    return withMutationLock(
      this.userDataDir,
      () => this._deleteByDateRangeUnlocked({ ...range, sourceType })
    );
  }

  _deleteByDateRangeUnlocked({ start, end, sourceType }) {
    let deletedBatches = 0;
    let deletedRows = 0;
    let deletedFiles = 0;
    for (const file of this._listTargetFiles()) {
      let deleteFileAfterClose = false;
      const db = runDataStore.openExistingSideDb(file.path);
      try {
        db.exec('BEGIN IMMEDIATE');
        const summary = sourceType
          ? db.prepare(SELECT_BATCH_DATE_RANGE_SUMMARY_BY_SOURCE).get(start, end, sourceType)
          : db.prepare(SELECT_BATCH_DATE_RANGE_SUMMARY).get(start, end);
        const fileBatchCount = Number(summary.batch_count) || 0;
        const fileRowCount = Number(summary.row_count) || 0;
        if (fileBatchCount > 0) {
          if (sourceType) {
            db.prepare(`
              DELETE FROM pre_fund_reconciliation_gateway_batches
              WHERE ${BATCH_DATE_RANGE_WHERE} AND source_type = ?
            `).run(start, end, sourceType);
          } else {
            db.prepare(`
              DELETE FROM pre_fund_reconciliation_gateway_batches
              WHERE ${BATCH_DATE_RANGE_WHERE}
            `).run(start, end);
          }
        }
        db.exec('COMMIT');
        deletedBatches += fileBatchCount;
        deletedRows += fileRowCount;
        deleteFileAfterClose = fileBatchCount > 0 && Number(
          db.prepare('SELECT COUNT(*) AS count FROM pre_fund_reconciliation_gateway_batches').get().count
        ) === 0 && !hasAnyOperationReceipts(db);
      } catch (error) {
        rollbackQuietly(db);
        throw new Error(
          `临时网关账单按日期删除失败（已删除 ${deletedBatches} 个批次、${deletedRows} 行）：${error.message || error}`
        );
      } finally {
        db.close();
      }
      if (deleteFileAfterClose) {
        const removal = runDataStore.deleteSideDbByPath(file.path);
        if (!removal.deleted) {
          throw new Error(
            `临时网关账单月侧库删除失败（已删除 ${deletedBatches} 个批次、${deletedRows} 行）：${file.path}`
          );
        }
        deletedFiles += 1;
      }
    }
    return { deletedFiles, deletedBatches, deletedRows };
  }

  async clearAll() {
    return withMutationLock(this.userDataDir, () => this._clearAllUnlocked());
  }

  _clearAllUnlocked() {
    let deletedBatches = 0;
    let deletedRows = 0;
    let deletedFiles = 0;
    const files = this._listTargetFiles();
    for (const file of files) {
      const db = runDataStore.openExistingSideDb(file.path);
      let preserveReceiptDb = false;
      try {
        deletedBatches += db.prepare(
          'SELECT COUNT(*) AS count FROM pre_fund_reconciliation_gateway_batches'
        ).get().count;
        deletedRows += db.prepare(
          'SELECT COUNT(*) AS count FROM pre_fund_reconciliation_gateway_rows'
        ).get().count;
        preserveReceiptDb = hasAnyOperationReceipts(db);
        if (preserveReceiptDb) {
          db.exec('BEGIN IMMEDIATE');
          try {
            db.prepare('DELETE FROM pre_fund_reconciliation_gateway_batches').run();
            db.exec('COMMIT');
          } catch (error) {
            rollbackQuietly(db);
            throw error;
          }
        }
      } finally {
        db.close();
      }
      if (preserveReceiptDb) continue;
      const removal = runDataStore.deleteSideDbByPath(file.path);
      if (!removal.deleted) throw new Error(`临时网关账单月侧库删除失败：${file.path}`);
      deletedFiles += 1;
    }
    return { deletedFiles, deletedBatches, deletedRows };
  }

  // API 语义别名：调用方可用 clear()，与 listBatches/deleteBatch/iterateRows 对称。
  async clear() {
    return this.clearAll();
  }

  _listTargetFiles(monthKey) {
    if (monthKey !== undefined) {
      const filePath = runDataStore.sideDbPath(this.userDataDir, MODULE, monthKey);
      if (!runDataStore.sideDbExists(this.userDataDir, MODULE, monthKey)) return [];
      return [{ fileName: runDataStore.sideDbFileName(monthKey), monthKey, path: filePath }];
    }
    return runDataStore.listSideDbFiles(this.userDataDir, MODULE)
      .slice()
      .sort((left, right) => left.monthKey.localeCompare(right.monthKey));
  }
}

function createPreFundReconciliationStore(userDataDir, options) {
  return new PreFundReconciliationStore(userDataDir, options);
}

module.exports = {
  DEFAULT_WRITE_BATCH_SIZE,
  PreFundReconciliationStore,
  createPreFundReconciliationStore,
};
