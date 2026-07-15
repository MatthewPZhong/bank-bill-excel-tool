'use strict';

const path = require('node:path');

const { FileValidationError } = require('./file-service/common');
const runDataStore = require('./run-data-store');
const { parseMptFile } = require('../main-process/pre-fund-reconciliation/mpt-parser');
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
    importedAt: row.imported_at,
  };
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

  async importFile(filePath) {
    const fileMetadata = parseMptFileName(filePath);
    return withMutationLock(this.userDataDir, () => this._importFileUnlocked(filePath, fileMetadata));
  }

  async _importFileUnlocked(filePath, fileMetadata) {
    const db = runDataStore.openSideDb(this.userDataDir, MODULE, fileMetadata.monthKey);
    let transactionStarted = false;
    let verifyExistingFile = null;
    let replacedBatch = null;
    let incomingBatchId = null;
    let insertRowStatement = null;

    try {
      const parsed = await parseMptFile(filePath, {
        batchSize: this.writeBatchSize,
        onHeader: async (header) => {
          // 先拿写锁再查身份/序号，避免两个并发导入都在锁外读到“尚不存在”后竞态插入。
          db.exec('BEGIN IMMEDIATE');
          transactionStarted = true;
          verifyExistingFile = db.prepare(SELECT_BATCH_BY_FILE).get(header.sourceFileName) || null;
          if (verifyExistingFile) return;

          const existingBatch = db.prepare(SELECT_BATCH_BY_IDENTITY).get(
            header.sourceType,
            header.sourceBatch
          ) || null;
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
                  currentSequence: existingBatch.source_file_sequence,
                }
              );
            }
            replacedBatch = existingBatch;
          }

          if (replacedBatch) {
            // 保留 batch.id，避免同批次重推后跑到其它临时批次末尾，改变严格1:1候选顺序。
            db.prepare('DELETE FROM pre_fund_reconciliation_gateway_rows WHERE batch_id = ?')
              .run(replacedBatch.id);
            db.prepare(`
              UPDATE pre_fund_reconciliation_gateway_batches
              SET source_date = ?, source_file_name = ?, source_file_sequence = ?,
                  content_hash = '', declared_row_count = ?, row_count = 0,
                  imported_at = CURRENT_TIMESTAMP
              WHERE id = ?
            `).run(
              header.sourceDate,
              header.sourceFileName,
              header.sourceFileSequence,
              header.declaredRowCount,
              replacedBatch.id
            );
            incomingBatchId = replacedBatch.id;
          } else {
            db.prepare(INSERT_BATCH).run(
              header.sourceType,
              header.sourceBatch,
              header.sourceDate,
              header.sourceFileName,
              header.sourceFileSequence,
              header.declaredRowCount
            );
            incomingBatchId = lastInsertId(db);
          }
          insertRowStatement = db.prepare(INSERT_ROW);
        },
        onRows: async (rows) => {
          if (verifyExistingFile) return;
          // 每个 parser batch 用 SAVEPOINT 分批写；外层 BEGIN IMMEDIATE 仍包住完整文件，
          // 因而兼顾大文件批量写入和“任一行失败整文件回滚”的原子性。
          db.exec('SAVEPOINT mpt_gateway_row_batch');
          try {
            for (const row of rows) {
              insertRowStatement.run(
                incomingBatchId,
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
            db.exec('RELEASE SAVEPOINT mpt_gateway_row_batch');
          } catch (error) {
            db.exec('ROLLBACK TO SAVEPOINT mpt_gateway_row_batch');
            db.exec('RELEASE SAVEPOINT mpt_gateway_row_batch');
            throw error;
          }
        },
      });

      if (verifyExistingFile) {
        if (verifyExistingFile.content_hash === parsed.contentHash) {
          db.exec('COMMIT');
          transactionStarted = false;
          return {
            status: 'noop',
            monthKey: fileMetadata.monthKey,
            batch: mapBatchRow(verifyExistingFile, fileMetadata.monthKey),
          };
        }
        throw storeError(
          'MPT_FILE_IDENTITY_CONFLICT',
          '同文件名的内容 hash 与已导入文件不同，已拒绝文件身份冲突',
          {
            fileName: parsed.sourceFileName,
            sourceType: parsed.sourceType,
            sourceBatch: parsed.sourceBatch,
          }
        );
      }

      db.prepare(`
        UPDATE pre_fund_reconciliation_gateway_batches
        SET content_hash = ?, row_count = ?
        WHERE id = ?
      `).run(parsed.contentHash, parsed.parsedRowCount, incomingBatchId);
      db.exec('COMMIT');
      transactionStarted = false;

      const saved = db.prepare('SELECT * FROM pre_fund_reconciliation_gateway_batches WHERE id = ?')
        .get(incomingBatchId);
      return {
        status: replacedBatch ? 'replaced' : 'imported',
        monthKey: fileMetadata.monthKey,
        replacedFileName: replacedBatch ? replacedBatch.source_file_name : null,
        batch: mapBatchRow(saved, fileMetadata.monthKey),
      };
    } catch (error) {
      if (transactionStarted) rollbackQuietly(db);
      throw error;
    } finally {
      db.close();
    }
  }

  listBatches(options = {}) {
    const sourceType = normalizeSourceTypeFilter(options);
    const out = [];
    for (const file of this._listTargetFiles(options.monthKey)) {
      const db = runDataStore.openExistingSideDb(file.path);
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
        ) === 0;
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
        ) === 0;
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
      try {
        deletedBatches += db.prepare(
          'SELECT COUNT(*) AS count FROM pre_fund_reconciliation_gateway_batches'
        ).get().count;
        deletedRows += db.prepare(
          'SELECT COUNT(*) AS count FROM pre_fund_reconciliation_gateway_rows'
        ).get().count;
      } finally {
        db.close();
      }
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
