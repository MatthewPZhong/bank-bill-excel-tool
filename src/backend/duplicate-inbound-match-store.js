'use strict';

const fs = require('node:fs');
const path = require('node:path');

const runDataStore = require('./run-data-store');
const {
  assertDuplicateResultConservation,
  computeDuplicateResultPostImage
} = require('./duplicate-inbound-match-result-digest');

const MODULE = runDataStore.MODULE_DUPLICATE_INBOUND_MATCH;
const SIDE_DB_FAMILY_RE = /^(month-\d{4}-\d{2}\.sqlite)(?:-wal|-shm)?$/;

function rollbackQuietly(db) {
  try { db.exec('ROLLBACK'); } catch (_error) { /* 当前无活动事务时忽略 */ }
}

function pathExistsStrict(filePath) {
  try {
    fs.lstatSync(filePath);
    return true;
  } catch (error) {
    if (error && error.code === 'ENOENT') return false;
    throw error;
  }
}

function parseObjectJson(value, label) {
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch (_error) {
    throw new Error(`${label} JSON 已损坏`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${label} JSON 必须是对象`);
  }
  return parsed;
}

function mapImport(row, monthKey) {
  if (!row) return null;
  return {
    id: Number(row.id),
    monthKey,
    bank: {
      fileName: row.bank_file_name,
      contentHash: row.bank_content_hash,
      rowCount: Number(row.bank_row_count)
    },
    document: {
      fileName: row.document_file_name,
      contentHash: row.document_content_hash,
      rowCount: Number(row.document_row_count),
      matchableRowCount: Number(row.document_matchable_row_count),
      emptyBusinessOrderCount: Number(row.document_empty_order_count)
    },
    importedAt: row.imported_at
  };
}

function mapRun(row, monthKey) {
  if (!row) return null;
  return {
    id: Number(row.id),
    importId: Number(row.import_id),
    monthKey,
    snapshot: parseObjectJson(row.snapshot_json, '重复入金运行快照'),
    snapshotHash: row.snapshot_hash,
    status: row.status,
    summary: parseObjectJson(row.summary_json, '重复入金运行汇总'),
    resultDigest: row.result_digest || null,
    errorMessage: row.error_message || '',
    createdAt: row.created_at,
    finishedAt: row.finished_at
  };
}

function resultCounts(db, runId) {
  const id = Number(runId);
  return {
    mailRowCount: Number(db.prepare(`
      SELECT COUNT(*) AS count FROM duplicate_inbound_match_mail_rows WHERE run_id = ?
    `).get(id).count),
    manualRowCount: Number(db.prepare(`
      SELECT COUNT(*) AS count FROM duplicate_inbound_match_manual_rows WHERE run_id = ?
    `).get(id).count),
    auditGroupCount: Number(db.prepare(`
      SELECT COUNT(*) AS count FROM duplicate_inbound_match_group_audits WHERE run_id = ?
    `).get(id).count),
    successAuditCount: Number(db.prepare(`
      SELECT COUNT(*) AS count
      FROM duplicate_inbound_match_group_audits
      WHERE run_id = ? AND disposition = 'success'
    `).get(id).count),
    manualAuditCount: Number(db.prepare(`
      SELECT COUNT(*) AS count
      FROM duplicate_inbound_match_group_audits
      WHERE run_id = ? AND disposition = 'manual'
    `).get(id).count)
  };
}

function assertResultCounts(run, counts) {
  const expected = {
    mailRowCount: Number(run.summary.mailRowCount),
    manualRowCount: Number(run.summary.manualRowCount),
    auditGroupCount: Number(run.summary.auditGroupCount),
    successAuditCount: Number(run.summary.finalSuccessGroupCount),
    manualAuditCount: Number(run.summary.manualGroupCount)
  };
  const invalidExpected = Object.values(expected).some(
    (value) => !Number.isSafeInteger(value) || value < 0
  );
  const invalidSummary = expected.mailRowCount !== expected.successAuditCount
    || expected.auditGroupCount !== expected.successAuditCount + expected.manualAuditCount;
  const mismatches = Object.keys(expected).filter((key) => expected[key] !== counts[key]);
  if (invalidExpected || invalidSummary || mismatches.length > 0) {
    const error = new Error(
      `重复入金运行结果行数不守恒：期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(counts)}`
    );
    error.code = 'duplicate-inbound-side-result-count-mismatch';
    throw error;
  }
}

function loadValidatedRun(db, monthKey, runId) {
  const run = mapRun(
    db.prepare('SELECT * FROM duplicate_inbound_match_runs WHERE id = ?').get(Number(runId)),
    monthKey
  );
  if (!run) return null;
  const counts = resultCounts(db, runId);
  assertResultCounts(run, counts);
  let postImage = null;
  if (run.resultDigest) {
    postImage = computeDuplicateResultPostImage(db, runId);
    assertDuplicateResultConservation(postImage);
    if (!postImage || postImage.digest !== run.resultDigest) {
      const error = new Error('重复入金运行结果内容摘要与已提交摘要不一致');
      error.code = 'duplicate-inbound-side-result-digest-mismatch';
      throw error;
    }
  }
  return { run, counts, postImage };
}

class DuplicateInboundMatchStore {
  constructor(userDataDir, options = {}) {
    if (!userDataDir || typeof userDataDir !== 'string') {
      throw new TypeError('重复入金匹配 store 需要 userDataDir');
    }
    this.userDataDir = path.resolve(userDataDir);
    this.operationReceipts = options.operationReceipts || null;
    runDataStore.moduleDir(this.userDataDir, MODULE);
  }

  clearAll() {
    const dir = runDataStore.moduleDir(this.userDataDir, MODULE);
    let entries;
    try {
      entries = fs.readdirSync(dir);
    } catch (error) {
      if (error && error.code === 'ENOENT') return { deletedFiles: 0 };
      throw new Error(`重复入金侧库目录扫描失败：${error && error.message ? error.message : error}`);
    }

    const basePaths = new Set();
    for (const entry of entries) {
      const match = SIDE_DB_FAMILY_RE.exec(entry);
      if (match) basePaths.add(path.join(dir, match[1]));
    }

    let deletedFiles = 0;
    const failedPaths = [];
    for (const basePath of basePaths) {
      runDataStore.deleteSideDbByPath(basePath);
      let hasRemainingFile;
      try {
        hasRemainingFile = ['', '-wal', '-shm'].some(
          (suffix) => pathExistsStrict(basePath + suffix)
        );
      } catch (error) {
        throw new Error(
          `重复入金侧库回收校验失败：${basePath}（${error && error.message ? error.message : error}）`
        );
      }
      if (hasRemainingFile) {
        failedPaths.push(basePath);
      } else {
        deletedFiles += 1;
      }
    }
    if (failedPaths.length > 0) {
      throw new Error(`重复入金侧库回收失败：${failedPaths.join('；')}`);
    }
    return { deletedFiles };
  }

  async createImportBundle({
    monthKey,
    bank,
    document,
    writeDocumentRows,
    beforeCommit = null,
    operationReceipt = null
  }) {
    if (!bank || !Array.isArray(bank.rows)) throw new TypeError('重复入金银行 rows 必须是数组');
    if (!document || typeof writeDocumentRows !== 'function') {
      throw new TypeError('重复入金单据流式写入函数必填');
    }
    const db = runDataStore.openSideDb(this.userDataDir, MODULE, monthKey);
    try {
      db.exec('BEGIN IMMEDIATE');
      const importResult = db.prepare(`
        INSERT INTO duplicate_inbound_match_imports (
          bank_file_name, bank_content_hash, bank_row_count,
          document_file_name, document_content_hash, document_row_count,
          document_matchable_row_count, document_empty_order_count
        ) VALUES (?, ?, ?, ?, ?, 0, 0, 0)
      `).run(
        String(bank.fileName || ''),
        String(bank.contentHash || ''),
        bank.rows.length,
        String(document.fileName || ''),
        String(document.contentHash || '')
      );
      const importId = Number(importResult.lastInsertRowid);
      const insertBank = db.prepare(`
        INSERT INTO duplicate_inbound_match_bank_rows (
          import_id, source_ordinal, excel_row_number, biz_id, fund_type, raw_json
        ) VALUES (?, ?, ?, ?, ?, ?)
      `);
      for (const row of bank.rows) {
        insertBank.run(
          importId,
          Number(row.sourceOrdinal),
          Number(row.excelRowNumber),
          String(row.bizId),
          String(row.fundType || ''),
          JSON.stringify(row.raw)
        );
      }

      const insertDocument = db.prepare(`
        INSERT INTO duplicate_inbound_match_document_rows (
          import_id, source_ordinal, excel_row_number, business_order_no,
          business_order_key, user_no, account_no, business_department
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      let insertedDocumentRows = 0;
      const documentStats = await writeDocumentRows((row) => {
        insertDocument.run(
          importId,
          Number(row.sourceOrdinal),
          Number(row.excelRowNumber),
          String(row.businessOrderNo || ''),
          String(row.businessOrderKey || ''),
          String(row.userNo || ''),
          String(row.accountNo || ''),
          String(row.businessDepartment || '')
        );
        insertedDocumentRows += 1;
      });
      const documentRowCount = Number(documentStats && documentStats.rowCount);
      if (!Number.isSafeInteger(documentRowCount) || documentRowCount !== insertedDocumentRows) {
        throw new Error(
          `单据对账单流式行数不守恒：读取 ${documentRowCount}，写入 ${insertedDocumentRows}`
        );
      }
      db.prepare(`
        UPDATE duplicate_inbound_match_imports
        SET document_row_count = ?, document_matchable_row_count = ?,
            document_empty_order_count = ?
        WHERE id = ?
      `).run(
        documentRowCount,
        Number(documentStats.matchableRowCount) || 0,
        Number(documentStats.emptyBusinessOrderCount) || 0,
        importId
      );
      if (beforeCommit) {
        if (typeof beforeCommit !== 'function') throw new TypeError('Duplicate beforeCommit必须是函数');
        await beforeCommit();
      }
      let receipt = null;
      if (operationReceipt) {
        if (!this.operationReceipts || typeof this.operationReceipts.insertOperationReceipt !== 'function') {
          throw new Error('Duplicate import receipt writer未配置');
        }
        receipt = this.operationReceipts.insertOperationReceipt(db, {
          ...operationReceipt,
          monthKey,
          importBundleId: importId,
          sideRunId: null
        }).receipt;
      }
      db.exec('COMMIT');
      const imported = mapImport(
        db.prepare('SELECT * FROM duplicate_inbound_match_imports WHERE id = ?').get(importId),
        monthKey
      );
      return receipt ? { ...imported, operationReceipt: receipt } : imported;
    } catch (error) {
      rollbackQuietly(db);
      throw error;
    } finally {
      db.close();
    }
  }

  getImport(monthKey, importId) {
    if (!runDataStore.sideDbExists(this.userDataDir, MODULE, monthKey)) return null;
    const db = runDataStore.openExistingSideDb(
      runDataStore.sideDbPath(this.userDataDir, MODULE, monthKey)
    );
    try {
      return mapImport(
        db.prepare('SELECT * FROM duplicate_inbound_match_imports WHERE id = ?').get(Number(importId)),
        monthKey
      );
    } finally {
      db.close();
    }
  }

  readBankRows(monthKey, importId) {
    const db = runDataStore.openExistingSideDb(
      runDataStore.sideDbPath(this.userDataDir, MODULE, monthKey)
    );
    try {
      return db.prepare(`
        SELECT source_ordinal, excel_row_number, biz_id, fund_type, raw_json
        FROM duplicate_inbound_match_bank_rows
        WHERE import_id = ?
        ORDER BY source_ordinal ASC
      `).all(Number(importId)).map((row) => ({
        ...parseObjectJson(row.raw_json, `银行对账单第 ${row.excel_row_number} 行`),
        _sourceOrdinal: Number(row.source_ordinal),
        _excelRowNumber: Number(row.excel_row_number),
        _bizId: row.biz_id,
        _normalizedFundType: row.fund_type
      }));
    } finally {
      db.close();
    }
  }

  readDocumentRows(monthKey, importId) {
    const db = runDataStore.openExistingSideDb(
      runDataStore.sideDbPath(this.userDataDir, MODULE, monthKey)
    );
    try {
      return db.prepare(`
        SELECT id, source_ordinal, excel_row_number, business_order_no,
               business_order_key, user_no, account_no, business_department
        FROM duplicate_inbound_match_document_rows
        WHERE import_id = ?
        ORDER BY source_ordinal ASC
      `).all(Number(importId)).map((row) => ({
        rowId: Number(row.id),
        sourceOrdinal: Number(row.source_ordinal),
        excelRowNumber: Number(row.excel_row_number),
        businessOrderNo: row.business_order_no,
        businessOrderKey: row.business_order_key,
        userNo: row.user_no,
        accountNo: row.account_no,
        businessDepartment: row.business_department
      }));
    } finally {
      db.close();
    }
  }

  lookupDocumentRows(monthKey, importId, businessOrderIds) {
    const keys = [...new Set((businessOrderIds || [])
      .map((value) => String(value === null || value === undefined ? '' : value).trim())
      .filter(Boolean))];
    const found = new Map(keys.map((key) => [key, { candidateCount: 0, candidates: [] }]));
    if (keys.length === 0) return found;
    const db = runDataStore.openExistingSideDb(
      runDataStore.sideDbPath(this.userDataDir, MODULE, monthKey)
    );
    try {
      const chunkSize = 500;
      for (let offset = 0; offset < keys.length; offset += chunkSize) {
        const chunk = keys.slice(offset, offset + chunkSize);
        const placeholders = chunk.map(() => '?').join(', ');
        const rows = db.prepare(`
          WITH ranked AS (
            SELECT d.id, d.source_ordinal, d.excel_row_number, d.business_order_no,
                   d.business_order_key, d.user_no, d.account_no, d.business_department,
                   i.document_file_name,
                   COUNT(*) OVER (PARTITION BY d.business_order_key) AS candidate_count,
                   ROW_NUMBER() OVER (
                     PARTITION BY d.business_order_key
                     ORDER BY d.source_ordinal ASC, d.id ASC
                   ) AS candidate_rank
            FROM duplicate_inbound_match_document_rows d
            JOIN duplicate_inbound_match_imports i ON i.id = d.import_id
            WHERE d.import_id = ? AND d.business_order_key IN (${placeholders})
          )
          SELECT * FROM ranked
          WHERE candidate_rank <= 2
          ORDER BY business_order_key ASC, candidate_rank ASC
        `).all(Number(importId), ...chunk);
        for (const row of rows) {
          const entry = found.get(row.business_order_key);
          if (!entry) continue;
          entry.candidateCount = Number(row.candidate_count);
          entry.candidates.push({
            rowId: Number(row.id),
            sourceOrdinal: Number(row.source_ordinal),
            excelRowNumber: Number(row.excel_row_number),
            fileName: row.document_file_name,
            businessOrderNo: row.business_order_no,
            businessOrderKey: row.business_order_key,
            userNo: row.user_no,
            accountNo: row.account_no,
            businessDepartment: row.business_department
          });
        }
      }
      return found;
    } finally {
      db.close();
    }
  }

  clearRuns(monthKey) {
    if (!runDataStore.sideDbExists(this.userDataDir, MODULE, monthKey)) return 0;
    const db = runDataStore.openExistingSideDb(
      runDataStore.sideDbPath(this.userDataDir, MODULE, monthKey)
    );
    try {
      return Number(db.prepare('DELETE FROM duplicate_inbound_match_runs').run().changes);
    } finally {
      db.close();
    }
  }

  createRun({ monthKey, importId, snapshot, snapshotHash }) {
    const db = runDataStore.openSideDb(this.userDataDir, MODULE, monthKey);
    try {
      const result = db.prepare(`
        INSERT INTO duplicate_inbound_match_runs (
          import_id, snapshot_json, snapshot_hash, status
        ) VALUES (?, ?, ?, 'running')
      `).run(
        Number(importId),
        JSON.stringify(snapshot || {}),
        String(snapshotHash || '')
      );
      return Number(result.lastInsertRowid);
    } finally {
      db.close();
    }
  }

  finishRun({
    monthKey, runId, summary, mailRows, manualRows, auditRows, operationReceipt = null
  }) {
    const db = runDataStore.openSideDb(this.userDataDir, MODULE, monthKey);
    try {
      db.exec('BEGIN IMMEDIATE');
      const insertMail = db.prepare(`
        INSERT INTO duplicate_inbound_match_mail_rows (run_id, source_ordinal, output_json)
        VALUES (?, ?, ?)
      `);
      for (const row of mailRows || []) {
        insertMail.run(Number(runId), Number(row.sourceOrdinal), JSON.stringify(row.output));
      }
      const insertManual = db.prepare(`
        INSERT INTO duplicate_inbound_match_manual_rows (
          run_id, group_order, row_order, reason, raw_json
        ) VALUES (?, ?, ?, ?, ?)
      `);
      for (const row of manualRows || []) {
        insertManual.run(
          Number(runId),
          Number(row.groupOrder),
          Number(row.rowOrder),
          String(row.reason || ''),
          JSON.stringify(row.raw)
        );
      }
      const insertAudit = db.prepare(`
        INSERT INTO duplicate_inbound_match_group_audits (
          run_id, group_order, disposition, reason_codes_json,
          bank_lineage_json, mpt_lineage_json, document_lineage_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      for (const row of auditRows || []) {
        insertAudit.run(
          Number(runId),
          Number(row.groupOrder),
          String(row.disposition),
          JSON.stringify(row.reasonCodes || []),
          JSON.stringify(row.bankLineage || []),
          JSON.stringify(row.mptLineage || []),
          JSON.stringify(row.documentLineage || [])
        );
      }
      const updated = db.prepare(`
        UPDATE duplicate_inbound_match_runs
        SET status = 'success', summary_json = ?, error_message = NULL,
            finished_at = CURRENT_TIMESTAMP
        WHERE id = ? AND status = 'running'
      `).run(JSON.stringify(summary || {}), Number(runId));
      if (updated.changes !== 1) throw new Error(`重复入金侧库 run 不存在或状态非法：${runId}`);
      const postImage = computeDuplicateResultPostImage(db, runId);
      assertDuplicateResultConservation(postImage);
      const digestUpdated = db.prepare(`
        UPDATE duplicate_inbound_match_runs SET result_digest = ? WHERE id = ?
      `).run(postImage.digest, Number(runId));
      if (digestUpdated.changes !== 1) {
        throw new Error(`重复入金侧库 run 结果摘要写入失败：${runId}`);
      }
      let receipt = null;
      if (operationReceipt) {
        if (!this.operationReceipts || typeof this.operationReceipts.insertOperationReceipt !== 'function') {
          throw new Error('Duplicate run receipt writer未配置');
        }
        receipt = this.operationReceipts.insertOperationReceipt(db, {
          ...operationReceipt,
          monthKey,
          sideRunId: Number(runId)
        }).receipt;
      }
      db.exec('COMMIT');
      const run = this.getRun(monthKey, runId, db);
      return receipt ? { ...run, operationReceipt: receipt } : run;
    } catch (error) {
      rollbackQuietly(db);
      throw error;
    } finally {
      db.close();
    }
  }

  failRun(monthKey, runId, error) {
    if (!runDataStore.sideDbExists(this.userDataDir, MODULE, monthKey)) return false;
    const db = runDataStore.openExistingSideDb(
      runDataStore.sideDbPath(this.userDataDir, MODULE, monthKey)
    );
    try {
      const result = db.prepare(`
        UPDATE duplicate_inbound_match_runs
        SET status = 'failed', error_message = ?, finished_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(error && error.message ? error.message : String(error || '运行失败'), Number(runId));
      return result.changes === 1;
    } finally {
      db.close();
    }
  }

  deleteRun(monthKey, runId) {
    if (!runDataStore.sideDbExists(this.userDataDir, MODULE, monthKey)) return false;
    const db = runDataStore.openExistingSideDb(
      runDataStore.sideDbPath(this.userDataDir, MODULE, monthKey)
    );
    try {
      return db.prepare('DELETE FROM duplicate_inbound_match_runs WHERE id = ?')
        .run(Number(runId)).changes === 1;
    } finally {
      db.close();
    }
  }

  getRun(monthKey, runId, openDb = null) {
    const ownsDb = !openDb;
    if (ownsDb && !runDataStore.sideDbExists(this.userDataDir, MODULE, monthKey)) return null;
    const db = openDb || runDataStore.openExistingSideDb(
      runDataStore.sideDbPath(this.userDataDir, MODULE, monthKey)
    );
    try {
      return mapRun(
        db.prepare('SELECT * FROM duplicate_inbound_match_runs WHERE id = ?').get(Number(runId)),
        monthKey
      );
    } finally {
      if (ownsDb) db.close();
    }
  }

  validateRunResult(monthKey, runId) {
    if (!runDataStore.sideDbExists(this.userDataDir, MODULE, monthKey)) return null;
    const db = runDataStore.openExistingSideDb(
      runDataStore.sideDbPath(this.userDataDir, MODULE, monthKey)
    );
    try {
      return loadValidatedRun(db, monthKey, runId);
    } finally {
      db.close();
    }
  }

  readResult(monthKey, runId) {
    const db = runDataStore.openExistingSideDb(
      runDataStore.sideDbPath(this.userDataDir, MODULE, monthKey)
    );
    try {
      db.exec('BEGIN');
      const validated = loadValidatedRun(db, monthKey, runId);
      const run = validated && validated.run;
      if (!run || run.status !== 'success') {
        db.exec('COMMIT');
        return null;
      }
      const mailRows = db.prepare(`
        SELECT source_ordinal, output_json
        FROM duplicate_inbound_match_mail_rows
        WHERE run_id = ?
        ORDER BY source_ordinal ASC
      `).all(Number(runId)).map((row) => parseObjectJson(row.output_json, '邮件模板行'));
      const manualRows = db.prepare(`
        SELECT group_order, row_order, reason, raw_json
        FROM duplicate_inbound_match_manual_rows
        WHERE run_id = ?
        ORDER BY group_order ASC, row_order ASC, id ASC
      `).all(Number(runId)).map((row) => ({
        row: parseObjectJson(row.raw_json, '人工判定行'),
        reason: row.reason,
        groupOrder: Number(row.group_order),
        rowOrder: Number(row.row_order)
      }));
      const auditRows = db.prepare(`
        SELECT group_order, disposition, reason_codes_json, bank_lineage_json,
               mpt_lineage_json, document_lineage_json
        FROM duplicate_inbound_match_group_audits
        WHERE run_id = ?
        ORDER BY group_order ASC, id ASC
      `).all(Number(runId)).map((row) => ({
        groupOrder: Number(row.group_order),
        disposition: row.disposition,
        reasonCodes: JSON.parse(row.reason_codes_json),
        bankLineage: JSON.parse(row.bank_lineage_json),
        mptLineage: JSON.parse(row.mpt_lineage_json),
        documentLineage: JSON.parse(row.document_lineage_json)
      }));
      db.exec('COMMIT');
      return { run, mailRows, manualRows, auditRows };
    } catch (error) {
      rollbackQuietly(db);
      throw error;
    } finally {
      db.close();
    }
  }

  readCommittedResult(monthKey, runId) {
    const result = this.readResult(monthKey, runId);
    if (!result) return null;
    if (!/^[a-f0-9]{64}$/.test(String(result.run.resultDigest || ''))) {
      const error = new Error('Duplicate managed run缺少已提交结果摘要');
      error.code = 'duplicate-inbound-side-result-digest-missing';
      throw error;
    }
    return result;
  }

  getOperationReceipt(monthKey, actionKey, operationKey) {
    if (!this.operationReceipts || !runDataStore.sideDbExists(this.userDataDir, MODULE, monthKey)) {
      return null;
    }
    const db = runDataStore.openExistingSideDb(
      runDataStore.sideDbPath(this.userDataDir, MODULE, monthKey)
    );
    try {
      return this.operationReceipts.getOperationReceipt(db, actionKey, operationKey);
    } finally {
      db.close();
    }
  }

  findOperationReceipt(actionKey, operationKey) {
    if (!this.operationReceipts) return null;
    const dir = runDataStore.moduleDir(this.userDataDir, MODULE);
    const matches = [];
    let entries;
    try {
      entries = fs.readdirSync(dir);
    } catch (error) {
      if (error && error.code === 'ENOENT') return null;
      throw error;
    }
    for (const entry of entries) {
      const match = /^month-(\d{4}-\d{2})\.sqlite$/.exec(entry);
      if (!match) continue;
      const receipt = this.getOperationReceipt(match[1], actionKey, operationKey);
      if (receipt) matches.push(receipt);
    }
    if (matches.length > 1) {
      const error = new Error('同一Duplicate operationKey出现在多个side DB');
      error.code = 'DUPLICATE_RECEIPT_IDENTITY_CONFLICT';
      throw error;
    }
    return matches[0] || null;
  }
}

function createDuplicateInboundMatchStore(userDataDir, options) {
  return new DuplicateInboundMatchStore(userDataDir, options);
}

module.exports = {
  MODULE,
  DuplicateInboundMatchStore,
  createDuplicateInboundMatchStore
};
