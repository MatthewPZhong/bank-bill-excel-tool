'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const { readBankStatement } = require('../bank-statement-io');
const {
  createPreFundReconciliationStore
} = require('../../backend/pre-fund-reconciliation-store');
const {
  createPreFundReconciliationRunStore
} = require('../../backend/pre-fund-reconciliation-run-store');
const runDataStore = require('../../backend/run-data-store');
const linkedTableRepository = require('../../backend/database/linked-table-repository');
const {
  BANK_ROW_CLASSIFICATION,
  classifyBankRow,
  toInvalidBothNonzeroError
} = require('./bank-row');
const {
  GATEWAY_SOURCE,
  GatewayPoolEmptyError,
  GatewayRowValidationError,
  buildBankMatchCriteria,
  normalizeGatewayCandidate
} = require('./matching-engine');
const {
  mapBalancedRow,
  mapUnbalancedRow,
  mapChannelBillRow,
  iterateDuplicateAuditRows
} = require('./output-mapper');
const {
  buildChannelFileName,
  currentFileMatchesIdentity,
  moveFileNoClobber,
  writeChannelWorkbooks
} = require('./excel-writer');
const { writeMptErrorReport } = require('./mpt-error-report-writer');
const { MPT_SCHEMAS } = require('./mpt-schema');
const {
  freezeGatewayTags,
  gatewayTagKey,
  preFundRunLineagePlan,
  preFundRunOutputIntent
} = require('../pre-fund-archive-lineage');

const SCENARIO_MISSING_GATEWAY = 'missing-gateway';
const PROGRESS_INTERVAL = 5000;
const TERMINAL_MPT_REPAIR_CODES = new Set([
  'MPT_REPAIR_SOURCE_CHANGED',
  'MPT_BATCH_SEQUENCE_STALE',
  'MPT_FILE_IDENTITY_CONFLICT'
]);

class PreFundReconciliationError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'PreFundReconciliationError';
    this.code = code;
    Object.assign(this, details);
  }
}

function localMonthKey(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new TypeError('前置资金对账运行日期无效');
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

function stableHash(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');
}

function errorResult(filePath, error, extra = {}) {
  return {
    status: 'failed',
    fileName: path.basename(filePath || ''),
    code: error && error.code ? error.code : 'pre-fund-import-failed',
    message: error && error.message ? error.message : String(error),
    detailLines: Array.isArray(error && error.detailLines) ? error.detailLines : [],
    ...extra
  };
}

function yieldToEventLoop() {
  return new Promise((resolve) => setImmediate(resolve));
}

function requireManagedMptSourceType(value) {
  const sourceType = value == null ? '' : String(value).trim();
  if (!sourceType || !Object.prototype.hasOwnProperty.call(MPT_SCHEMAS, sourceType)) {
    throw new TypeError('请选择临时中台入金或出金网关账单表库');
  }
  return sourceType;
}

function rollbackQuietly(db) {
  try { db.exec('ROLLBACK'); } catch (_error) { /* no active transaction */ }
}

function compensateRunReceiptAfterMirrorFailure(runStore, db, taskRunId) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const deleted = runStore.deleteArchiveRunByTaskRunId(db, taskRunId);
    db.exec('COMMIT');
    return deleted;
  } catch (error) {
    rollbackQuietly(db);
    throw error;
  }
}

function bankContext(row, index, fileName) {
  return {
    fileName,
    excelRowNumber: row && row._excelRowNumber ? row._excelRowNumber : index + 2,
    inputIndex: index
  };
}

function mptBatchIdentity(batch) {
  return JSON.stringify([
    batch.monthKey,
    batch.id,
    batch.datasetId,
    batch.producerTaskRunId,
    batch.datasetVersion,
    batch.archiveContractVersion
  ]);
}

function assertSameIdentitySet(actual, expected, keyOf, label) {
  const actualKeys = actual.map(keyOf).sort();
  const expectedKeys = expected.map(keyOf).sort();
  if (JSON.stringify(actualKeys) !== JSON.stringify(expectedKeys)) {
    throw new Error(`前置资金 ${label} dataset 在 prepare 后已变化，请重新运行`);
  }
}

function openMainDatabaseReadSnapshot(dbPath) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  db.exec('PRAGMA query_only = ON;');
  db.exec('BEGIN');
  return {
    db,
    close() {
      try { db.exec('ROLLBACK'); } catch (_error) { /* snapshot 已结束 */ }
      db.close();
    }
  };
}

class PreFundReconciliationService {
  constructor({
    userDataDir,
    database,
    templatePath,
    now = () => new Date(),
    openGatewayReadSnapshot = () => openMainDatabaseReadSnapshot(database.dbPath),
    gatewayReadRepository = linkedTableRepository
  }) {
    if (!userDataDir || typeof userDataDir !== 'string') {
      throw new TypeError('前置资金对账 service 需要 userDataDir');
    }
    if (!database) throw new TypeError('前置资金对账 service 需要 database');
    const mirrorMethods = [
      'createPreFundReconciliationRunMirror',
      'finishPreFundReconciliationRunMirror',
      'getPreFundReconciliationRunMirrorByTaskRun',
      'acknowledgePreFundReconciliationRunMirror',
      'failPreFundReconciliationRunMirror',
      'markPreFundReconciliationRunMirrorUnavailable',
      'listPreFundReconciliationRunMirrors'
    ];
    for (const method of mirrorMethods) {
      if (typeof database[method] !== 'function') {
        throw new TypeError(`前置资金对账 database 缺少 ${method}`);
      }
    }
    this.userDataDir = userDataDir;
    this.database = database;
    this.templatePath = templatePath;
    this.now = now;
    this.openGatewayReadSnapshot = openGatewayReadSnapshot;
    this.gatewayReadRepository = gatewayReadRepository;
    this.tempStore = createPreFundReconciliationStore(userDataDir);
    this.runStore = createPreFundReconciliationRunStore(userDataDir);
    this.bankSession = null;
    this.bankRevision = 0;
    this.lastRun = null;
    this.mptImportFailures = new Map();
  }

  reconcilePersistedRunMirrors() {
    this.runStore.assertAllRunDataClearable();
    const mirrors = this.database.listPreFundReconciliationRunMirrors();
    for (const mirror of mirrors) {
      if (mirror.status === 'running') {
        this.database.markPreFundReconciliationRunMirrorUnavailable(
          mirror.id,
          'interrupted',
          '应用已重启，上一轮运行未完整结束'
        );
        continue;
      }
      if (
        mirror.status === 'success'
        && !fs.existsSync(runDataStore.resolveFromRel(this.userDataDir, mirror.sideDbRelPath))
      ) {
        this.database.markPreFundReconciliationRunMirrorUnavailable(
          mirror.id,
          'missing-side-db',
          '运行结果侧库文件不存在，结果已失效'
        );
      } else if (mirror.status === 'success') {
        this.database.markPreFundReconciliationRunMirrorUnavailable(
          mirror.id,
          'expired',
          '应用已重启，银行导入会话已结束，运行结果已回收'
        );
      }
    }
    this.runStore.deleteAllRunDataAfterArchivePreflight();
  }

  revokePreviousRunResults() {
    this.runStore.assertAllRunDataClearable();
    for (const mirror of this.database.listPreFundReconciliationRunMirrors()) {
      if (mirror.status !== 'success') continue;
      this.database.markPreFundReconciliationRunMirrorUnavailable(
        mirror.id,
        'superseded',
        '已开始新的前置资金对账运行，旧结果已回收'
      );
    }
    return this.runStore.deleteAllRunDataAfterArchivePreflight();
  }

  importBank(filePath, producerTaskRunId) {
    const parsed = readBankStatement(filePath);
    const rows = parsed.rows.map((row, index) => ({
      ...row,
      _sourceFileName: parsed.fileName,
      _excelRowNumber: index + 2,
      _sourceOrdinal: index
    }));
    const summary = {
      inputRows: rows.length,
      participatingRows: 0,
      skippedZeroRows: 0,
      excludedEmptyIdRows: 0,
      emptyChannelRows: 0
    };
    for (let index = 0; index < rows.length; index += 1) {
      const classified = classifyBankRow(rows[index], bankContext(rows[index], index, parsed.fileName));
      if (classified.classification === BANK_ROW_CLASSIFICATION.INVALID_BOTH_NONZERO) {
        throw toInvalidBothNonzeroError(classified, { bankInputRows: index + 1 });
      }
      if (classified.classification === BANK_ROW_CLASSIFICATION.ZERO_AMOUNT) {
        summary.skippedZeroRows += 1;
        continue;
      }
      if (classified.classification === BANK_ROW_CLASSIFICATION.EMPTY_RECONCILIATION_ID) {
        summary.excludedEmptyIdRows += 1;
        continue;
      }
      summary.participatingRows += 1;
      if (classified.channel === '') summary.emptyChannelRows += 1;
    }

    this.bankRevision += 1;
    this.bankSession = {
      filePath: parsed.filePath,
      fileName: parsed.fileName,
      importedAt: this.now().toISOString(),
      revision: this.bankRevision,
      datasetId: crypto.randomUUID(),
      producerTaskRunId,
      archiveContractVersion: 1,
      rows,
      summary
    };
    return {
      status: 'ok',
      fileName: parsed.fileName,
      rowCount: rows.length,
      acceptedRows: summary.participatingRows,
      skippedZeroRows: summary.skippedZeroRows,
      excludedEmptyIdRows: summary.excludedEmptyIdRows,
      emptyChannelRows: summary.emptyChannelRows,
      revision: this.bankRevision
    };
  }

  async importMptFiles(filePaths, { onProgress, producerTaskRunId, identityGate } = {}) {
    const paths = filePaths;
    this.mptImportFailures.clear();
    const results = [];
    for (let index = 0; index < paths.length; index += 1) {
      const filePath = paths[index];
      if (onProgress) onProgress({ stage: 'mpt-import', current: index + 1, total: paths.length, fileName: path.basename(filePath) });
      try {
        const imported = await this.tempStore.importFile(filePath, {
          identityGate,
          datasetSeed: {
            datasetId: crypto.randomUUID(),
            producerTaskRunId
          }
        });
        results.push({
          status: 'ok',
          importStatus: imported.status,
          fileName: path.basename(filePath),
          sourceType: imported.batch.sourceType,
          rowCount: imported.batch.rowCount,
          excludedRowCount: imported.batch.excludedRowCount
        });
      } catch (error) {
        let repair = {};
        if (
          error
          && error.canRepair === true
          && error.code === 'MPT_ROW_ERRORS'
          && /^[a-f0-9]{64}$/.test(String(error.contentHash || ''))
          && Object.prototype.hasOwnProperty.call(MPT_SCHEMAS, error.sourceType)
        ) {
          const repairToken = crypto.randomUUID();
          const failure = {
            failureId: repairToken,
            filePath: path.resolve(filePath),
            sourceType: error.sourceType,
            sourceBatch: error.sourceBatch || '',
            contentHash: error.contentHash,
            rowErrorCount: Number(error.rowErrorCount) || 0
          };
          this.mptImportFailures.set(repairToken, failure);
          repair = {
            canRepair: true,
            repairToken,
            sourceType: failure.sourceType,
            rowErrorCount: failure.rowErrorCount
          };
        }
        results.push(errorResult(filePath, error, repair));
      }
      await yieldToEventLoop();
    }
    return {
      status: 'ok',
      results,
      successCount: results.filter((result) => result.status === 'ok').length,
      failedCount: results.filter((result) => result.status !== 'ok').length
    };
  }

  resolveMptImportFailures(repairTokens) {
    if (!Array.isArray(repairTokens) || repairTokens.length === 0) {
      throw new TypeError('错误数据操作至少需要一个有效失败令牌');
    }
    if (repairTokens.length > Math.max(1, this.mptImportFailures.size)) {
      throw new TypeError('错误数据操作包含超出本轮失败会话的令牌');
    }
    const failures = [];
    const seen = new Set();
    for (const value of repairTokens) {
      const token = value == null ? '' : String(value).trim();
      if (!/^[a-f0-9-]{36}$/i.test(token) || seen.has(token)) {
        throw new TypeError('失败令牌格式非法或重复');
      }
      seen.add(token);
      const failure = this.mptImportFailures.get(token);
      if (!failure) {
        throw new PreFundReconciliationError(
          'pre-fund-mpt-failure-token-expired',
          '错误数据操作已失效，请重新导入原文件'
        );
      }
      failures.push(failure);
    }
    return failures;
  }

  adoptManagedMptImportResults(filePaths, managedResults) {
    if (!Array.isArray(filePaths) || !Array.isArray(managedResults) ||
        filePaths.length !== managedResults.length) {
      throw new TypeError('managed MPT结果必须与输入文件等长同序');
    }
    return managedResults.map((item, index) => {
      if (!item || item.status !== 'failed' || !item.managedRepairEvidence) return item;
      const evidence = item.managedRepairEvidence;
      if (typeof evidence.sourceType !== 'string' || !evidence.sourceType ||
          typeof evidence.sourceBatch !== 'string' || !evidence.sourceBatch ||
          !/^[a-f0-9]{64}$/.test(evidence.contentHash || '') ||
          !Number.isSafeInteger(evidence.rowErrorCount) || evidence.rowErrorCount < 1) {
        throw new TypeError('managed MPT repair evidence非法');
      }
      const repairToken = crypto.randomUUID();
      this.mptImportFailures.set(repairToken, {
        failureId: repairToken,
        filePath: path.resolve(filePaths[index]),
        sourceType: evidence.sourceType,
        sourceBatch: evidence.sourceBatch,
        contentHash: evidence.contentHash,
        rowErrorCount: evidence.rowErrorCount
      });
      const { managedRepairEvidence: _internalEvidence, ...publicResult } = item;
      return {
        ...publicResult,
        canRepair: true,
        repairToken,
        sourceType: evidence.sourceType,
        rowErrorCount: evidence.rowErrorCount
      };
    });
  }

  beginManagedMptImport() {
    this.mptImportFailures.clear();
  }

  adoptManagedMptRepairResults(failures, managedResults) {
    if (!Array.isArray(failures) || !Array.isArray(managedResults) ||
        failures.length !== managedResults.length) {
      throw new TypeError('managed MPT repair结果必须与failure等长同序');
    }
    return managedResults.map((item, index) => {
      const failure = failures[index];
      if (item && item.status === 'ok') {
        this.mptImportFailures.delete(failure.failureId);
        return item;
      }
      const terminalFailure = TERMINAL_MPT_REPAIR_CODES.has(item && item.code);
      if (terminalFailure) {
        this.mptImportFailures.delete(failure.failureId);
        return item;
      }
      return {
        ...item,
        canRepair: true,
        repairToken: failure.failureId,
        sourceType: failure.sourceType,
        rowErrorCount: failure.rowErrorCount
      };
    });
  }

  async exportMptErrorData(repairTokens, outputPath) {
    const failures = this.resolveMptImportFailures(repairTokens);
    const result = await writeMptErrorReport({ failureRecords: failures, outputPath });
    return { status: 'ok', ...result };
  }

  async retryMptImportFailures(
    repairTokens,
    { filePaths, onProgress, producerTaskRunId, identityGate } = {}
  ) {
    const failures = this.resolveMptImportFailures(repairTokens);
    const results = [];
    for (let index = 0; index < failures.length; index += 1) {
      const failure = failures[index];
      const filePath = filePaths[index];
      if (onProgress) {
        onProgress({
          stage: 'mpt-repair',
          current: index + 1,
          total: failures.length,
          fileName: path.basename(filePath)
        });
      }
      try {
        const imported = await this.tempStore.importFile(filePath, {
          identityGate,
          skipInvalidRows: true,
          expectedContentHash: failure.contentHash,
          datasetSeed: {
            datasetId: crypto.randomUUID(),
            producerTaskRunId
          }
        });
        this.mptImportFailures.delete(failure.failureId);
        results.push({
          status: 'ok',
          fileName: path.basename(filePath),
          sourceType: imported.batch.sourceType,
          importStatus: imported.status,
          rowCount: imported.batch.rowCount,
          excludedRowCount: imported.batch.excludedRowCount
        });
      } catch (error) {
        const terminalFailure = TERMINAL_MPT_REPAIR_CODES.has(error && error.code);
        if (terminalFailure) this.mptImportFailures.delete(failure.failureId);
        results.push(errorResult(filePath, error, terminalFailure ? {} : {
          canRepair: true,
          repairToken: failure.failureId,
          sourceType: failure.sourceType,
          rowErrorCount: failure.rowErrorCount
        }));
      }
      await yieldToEventLoop();
    }
    return {
      status: 'ok',
      results,
      successCount: results.filter((result) => result.status === 'ok').length,
      failedCount: results.filter((result) => result.status !== 'ok').length,
      importedRowCount: results.reduce((sum, result) => sum + (Number(result.rowCount) || 0), 0),
      excludedRowCount: results.reduce((sum, result) => sum + (Number(result.excludedRowCount) || 0), 0)
    };
  }

  listTempBatches() {
    return this.tempStore.listBatches().map((batch) => ({
      id: batch.id,
      monthKey: batch.monthKey,
      sourceType: batch.sourceType,
      sourceBatch: batch.sourceBatch,
      sourceDate: batch.sourceDate,
      sourceFileName: batch.sourceFileName,
      sourceFileSequence: batch.sourceFileSequence,
      contentHash: batch.contentHash,
      declaredRowCount: batch.declaredRowCount,
      rowCount: batch.rowCount,
      excludedRowCount: batch.excludedRowCount,
      importMode: batch.importMode,
      importedAt: batch.importedAt
    }));
  }

  async deleteTempBatch(payload) {
    const result = await this.tempStore.deleteBatch(payload || {});
    return result;
  }

  countTempByDateRange(payload = {}) {
    const sourceType = requireManagedMptSourceType(payload.sourceType);
    return this.tempStore.countByDateRange(payload.start, payload.end, { sourceType });
  }

  async deleteTempByDateRange(payload = {}) {
    const sourceType = requireManagedMptSourceType(payload.sourceType);
    return this.tempStore.deleteByDateRange(payload.start, payload.end, { sourceType });
  }

  async clearTemp() {
    const result = await this.tempStore.clearAll();
    return result;
  }

  buildSourceSnapshot(gatewayDb = null) {
    const batches = this.tempStore.listBatches().map((batch) => ({
      monthKey: batch.monthKey,
      sourceType: batch.sourceType,
      sourceBatch: batch.sourceBatch,
      sourceFileSequence: batch.sourceFileSequence,
      contentHash: batch.contentHash,
      rowCount: batch.rowCount
    }));
    const linkedMeta = gatewayDb
      ? this.gatewayReadRepository.getLinkedTableMeta(gatewayDb, 'gateway-bill')
      : this.database.getLinkedTableMeta('gateway-bill');
    return {
      scenario: SCENARIO_MISSING_GATEWAY,
      bankRevision: this.bankSession ? this.bankSession.revision : null,
      tempRevision: stableHash(batches),
      linkedGatewayRevision: stableHash({
        rowCount: linkedMeta.rowCount,
        dataDateMin: linkedMeta.dataDateMin,
        dataDateMax: linkedMeta.dataDateMax,
        sourceFileName: linkedMeta.sourceFileName,
        updatedAt: linkedMeta.updatedAt
      })
    };
  }

  prepareRunLineage() {
    return preFundRunLineagePlan({
      bankSession: this.bankSession,
      mptBatches: this.tempStore.listBatches(),
      gatewayTags: this.database.listGatewayBillSourceTags()
    });
  }

  lastRunLineageIntent() {
    if (!this.lastRun) throw new Error('前置资金 run 不存在');
    return preFundRunOutputIntent({
      mirrorRunId: this.lastRun.runId,
      archiveTaskRunId: this.lastRun.archiveTaskRunId
    });
  }

  getRunReceiptByTaskRun(taskRunId) {
    return this.runStore.getRunByArchiveTaskRunId(taskRunId);
  }

  acknowledgeRunByTaskRun(taskRunId) {
    const receipt = this.getRunReceiptByTaskRun(taskRunId);
    if (!receipt) throw new Error('前置资金 TaskRun 对应的业务 run receipt 不存在');
    const mirror = this.database.getPreFundReconciliationRunMirrorByTaskRun(taskRunId);
    if (!mirror
        || mirror.status !== 'success'
        || mirror.monthKey !== receipt.monthKey
        || mirror.sideRunId !== receipt.id
        || mirror.sideDbRelPath !== receipt.sideDbRelPath) {
      throw new Error('前置资金 TaskRun 对应的主库 run 镜像身份不一致');
    }
    this.database.acknowledgePreFundReconciliationRunMirror(mirror.id, taskRunId);
    return this.runStore.acknowledgeArchiveTerminal(
      receipt.monthKey,
      receipt.id,
      taskRunId
    );
  }

  recoverRunMirror(receipt, { createIfMissing }) {
    let mirror = this.database.getPreFundReconciliationRunMirrorByTaskRun(
      receipt.archiveTaskRunId
    );
    if (mirror) {
      if (mirror.monthKey !== receipt.monthKey
          || mirror.sideRunId !== receipt.id
          || mirror.scenario !== receipt.scenario
          || mirror.sideDbRelPath !== receipt.sideDbRelPath) {
        throw new Error(`前置资金 run #${receipt.id} 的主库镜像身份冲突`);
      }
      if (mirror.status === 'running' && createIfMissing) {
        mirror = this.database.finishPreFundReconciliationRunMirror(mirror.id, receipt.summary);
      } else if (mirror.status !== 'success') {
        throw new Error(`前置资金 run #${receipt.id} 的主库镜像状态冲突：${mirror.status}`);
      }
      return mirror;
    }
    if (!createIfMissing) {
      throw new Error(`前置资金 run #${receipt.id} 的主库镜像不存在`);
    }
    const mirrorId = this.database.createPreFundReconciliationRunMirror({
      monthKey: receipt.monthKey,
      sideRunId: receipt.id,
      scenario: receipt.scenario,
      snapshotHash: stableHash(receipt.snapshot),
      bankFiles: receipt.bankFiles,
      sideDbRelPath: receipt.sideDbRelPath,
      archiveReceipt: {
        archiveContractVersion: 1,
        archiveTaskRunId: receipt.archiveTaskRunId
      }
    });
    return this.database.finishPreFundReconciliationRunMirror(mirrorId, receipt.summary);
  }

  lastRunLocator() {
    if (!this.lastRun) throw new Error('前置资金 run 不存在');
    return Object.freeze({
      mirrorRunId: this.lastRun.runId,
      monthKey: this.lastRun.monthKey,
      sideRunId: this.lastRun.sideRunId,
      archiveTaskRunId: this.lastRun.archiveTaskRunId
    });
  }

  assertLastRunLocator(locator) {
    if (!locator || !this.lastRun
        || locator.mirrorRunId !== this.lastRun.runId
        || locator.monthKey !== this.lastRun.monthKey
        || locator.sideRunId !== this.lastRun.sideRunId
        || locator.archiveTaskRunId !== this.lastRun.archiveTaskRunId) {
      throw new Error('前置资金导出所绑定的 run 已变化，请重新导出');
    }
    return this.lastRun;
  }

  lastRunBusinessFlowPlan(locator) {
    const run = this.assertLastRunLocator(locator);
    return Object.freeze({
      startsNewFlow: false,
      flowIdentity: Object.freeze({
        type: 'business-run-id',
        value: String(run.runId)
      })
    });
  }

  resolveKeptRawJson({ source, location = {} }, gatewayDb) {
    const sourceRecordId = location.sourceRecordId;
    if (source === GATEWAY_SOURCE.TEMPORARY) {
      return this.tempStore.getRawJsonById(location.monthKey, sourceRecordId);
    }
    if (source === GATEWAY_SOURCE.PERSISTENT) {
      return this.gatewayReadRepository.getGatewayBillRawJsonById(gatewayDb, sourceRecordId);
    }
    throw new TypeError(`未知网关来源，无法回读原始JSON：${String(source)}`);
  }

  isLastRunStale() {
    if (!this.lastRun) return false;
    const current = this.buildSourceSnapshot();
    return stableHash(current) !== stableHash(this.lastRun.snapshot);
  }

  inspectLastRunAvailability() {
    if (!this.lastRun) return { available: false, message: '请先运行前置资金对账' };
    try {
      const storedRun = this.runStore.getRun(this.lastRun.monthKey, this.lastRun.sideRunId);
      if (!storedRun) {
        return {
          available: false,
          markUnavailable: true,
          message: '运行结果侧库文件不存在或结果记录已丢失，请重新运行'
        };
      }
      if (storedRun.status !== 'success') {
        return {
          available: false,
          message: `运行结果状态为 ${storedRun.status}，请重新运行`
        };
      }
      return { available: true, message: '' };
    } catch (error) {
      return {
        available: false,
        message: `运行结果无法读取，请重新运行：${error.message || error}`
      };
    }
  }

  recordLastRunUnavailable(availability) {
    if (!this.lastRun || !availability || !availability.markUnavailable) return;
    if (this.lastRun.unavailableRecorded) return;
    try {
      this.database.markPreFundReconciliationRunMirrorUnavailable(
        this.lastRun.runId,
        'missing-side-db',
        availability.message
      );
      this.lastRun.unavailableRecorded = true;
    } catch (_error) {
      // 状态页仍会禁用导出；镜像更新失败不应把只读状态查询升级为崩溃。
    }
  }

  status() {
    const batches = this.tempStore.listBatches();
    const linkedMeta = this.database.getLinkedTableMeta('gateway-bill');
    const availability = this.lastRun
      ? this.inspectLastRunAvailability()
      : { available: false, message: '' };
    this.recordLastRunUnavailable(availability);
    const stale = this.lastRun && availability.available ? this.isLastRunStale() : false;
    return {
      status: 'ok',
      scenario: SCENARIO_MISSING_GATEWAY,
      bank: this.bankSession ? {
        fileName: this.bankSession.fileName,
        rowCount: this.bankSession.rows.length,
        importedAt: this.bankSession.importedAt,
        revision: this.bankSession.revision,
        ...this.bankSession.summary
      } : null,
      temporaryGateway: {
        batchCount: batches.length,
        rowCount: batches.reduce((sum, batch) => sum + (Number(batch.rowCount) || 0), 0)
      },
      linkedGateway: linkedMeta,
      run: this.lastRun ? {
        monthKey: this.lastRun.monthKey,
        runId: this.lastRun.runId,
        summary: this.lastRun.summary,
        stale,
        unavailable: !availability.available,
        unavailableMessage: availability.message
      } : null,
      canRun: !!this.bankSession && (batches.length > 0 || linkedMeta.rowCount > 0),
      canExport: !!this.lastRun
        && availability.available
        && !stale
        && (Number(this.lastRun.summary && this.lastRun.summary.channelCount) || 0) > 0
    };
  }

  async run({
    scenario = SCENARIO_MISSING_GATEWAY,
    onProgress,
    taskRunId,
    expectedDatasets
  } = {}) {
    if (scenario !== SCENARIO_MISSING_GATEWAY) {
      throw new PreFundReconciliationError(
        'pre-fund-scenario-unsupported',
        '3.0.14 仅支持“缺网关账单”场景'
      );
    }
    if (!this.bankSession) {
      throw new PreFundReconciliationError('pre-fund-bank-session-missing', '请先导入标准银行对账单');
    }
    if (this.bankSession.datasetId !== expectedDatasets.bankDatasetId) {
      throw new Error('前置资金银行 session dataset 在 prepare 后已变化，请重新运行');
    }
    assertSameIdentitySet(
      this.tempStore.listBatches(),
      expectedDatasets.mptBatches,
      mptBatchIdentity,
      'MPT'
    );

    // 新 run 开始即撤销旧结果的导出资格；失败时也不能回退导出旧快照。
    this.lastRun = null;
    this.revokePreviousRunResults();

    const monthKey = localMonthKey(this.now());
    const db = this.runStore.open(monthKey);
    let gatewaySnapshot = null;
    let linkedDb = null;
    let snapshot = null;
    let sideRunId = null;
    let mirrorRunId = null;
    let sideTransactionStarted = false;
    const stats = {
      bankInputRows: 0,
      bankValidRows: 0,
      bankSkippedZeroRows: 0,
      bankExcludedEmptyIdRows: 0,
      bankEmptyChannelRows: 0,
      bankRuleUnmappedRows: 0,
      bankRuleDirectionMismatchRows: 0,
      bankRuleNoGatewayTradeTypeRows: 0,
      tempGatewayRawRows: 0,
      linkedGatewayRawRows: 0,
      gatewayExcludedEmptyIdRows: 0,
      gatewayInvalidRows: 0,
      gatewayCollapsedDuplicateRows: 0,
      gatewayEligibleRows: 0,
      gatewayConflictingSameIdGroups: 0,
      matchedPairs: 0,
      unmatchedBankRows: 0,
      unusedGatewayRows: 0,
      duplicateGroupCount: 0,
      duplicateAuditRawBytes: 0,
      channelCount: 0
    };

    try {
      gatewaySnapshot = this.openGatewayReadSnapshot();
      linkedDb = gatewaySnapshot.db;
      snapshot = this.buildSourceSnapshot(linkedDb);
      assertSameIdentitySet(
        freezeGatewayTags(this.gatewayReadRepository.listGatewayBillSourceTags(linkedDb)),
        expectedDatasets.gatewayTags,
        gatewayTagKey,
        'linked gateway'
      );
      db.exec('BEGIN IMMEDIATE');
      sideTransactionStarted = true;
      sideRunId = this.runStore.createRun(db, {
        scenario,
        snapshot,
        bankFiles: [this.bankSession.fileName],
        archiveReceipt: {
          archiveContractVersion: 1,
          archiveTaskRunId: taskRunId
        }
      });
      const insertCandidate = this.runStore.createGatewayCandidateInserter(db, sideRunId, {
        resolveKeptRawJson: (kept) => this.resolveKeptRawJson(kept, linkedDb)
      });
      let sourceOrder = 0;

      const ingestGatewayRows = async (rows, source, sourcePriority, rawCounter) => {
        for (const entry of rows) {
          stats[rawCounter] += 1;
          let candidate;
          try {
            candidate = normalizeGatewayCandidate(entry, source, sourceOrder);
          } catch (error) {
            if (!(error instanceof GatewayRowValidationError)) throw error;
            stats.gatewayInvalidRows += 1;
            sourceOrder += 1;
            continue;
          }
          candidate.sourcePriority = sourcePriority;
          candidate.sourceOrder = sourceOrder;
          sourceOrder += 1;
          if (candidate.reconciliationId === '') {
            stats.gatewayExcludedEmptyIdRows += 1;
          } else if (!insertCandidate(candidate)) {
            stats.gatewayCollapsedDuplicateRows += 1;
          }
          if ((stats.tempGatewayRawRows + stats.linkedGatewayRawRows) % PROGRESS_INTERVAL === 0) {
            if (onProgress) onProgress({ stage: 'gateway-pool', current: stats.tempGatewayRawRows + stats.linkedGatewayRawRows });
            await yieldToEventLoop();
          }
        }
      };

      await ingestGatewayRows(
        this.tempStore.iterateRows(),
        GATEWAY_SOURCE.TEMPORARY,
        0,
        'tempGatewayRawRows'
      );
      await ingestGatewayRows(
        this.gatewayReadRepository.iterateGatewayBillRows(linkedDb),
        GATEWAY_SOURCE.PERSISTENT,
        1,
        'linkedGatewayRawRows'
      );

      const initialGatewayStats = this.runStore.gatewayStats(db, sideRunId);
      stats.gatewayEligibleRows = initialGatewayStats.candidateCount;
      stats.gatewayConflictingSameIdGroups = initialGatewayStats.conflictingIdGroupCount;
      if (stats.gatewayEligibleRows === 0) {
        throw new GatewayPoolEmptyError(
          '临时网关账单和现有网关账单均无可参与匹配的非空对账ID数据，请先导入或维护网关账单。',
          { ...stats }
        );
      }

      const consumeGateway = this.runStore.createGatewayConsumer(db, sideRunId);
      const insertBalanced = this.runStore.createBalancedRowInserter(db, sideRunId);
      const insertUnbalanced = this.runStore.createUnbalancedRowInserter(db, sideRunId);
      for (let index = 0; index < this.bankSession.rows.length; index += 1) {
        const row = this.bankSession.rows[index];
        stats.bankInputRows += 1;
        const classified = classifyBankRow(row, bankContext(row, index, this.bankSession.fileName));
        if (classified.classification === BANK_ROW_CLASSIFICATION.INVALID_BOTH_NONZERO) {
          throw toInvalidBothNonzeroError(classified, { ...stats });
        }
        if (classified.classification === BANK_ROW_CLASSIFICATION.ZERO_AMOUNT) {
          stats.bankSkippedZeroRows += 1;
          continue;
        }
        if (classified.classification === BANK_ROW_CLASSIFICATION.EMPTY_RECONCILIATION_ID) {
          stats.bankExcludedEmptyIdRows += 1;
          continue;
        }

        stats.bankValidRows += 1;
        if (classified.channel === '') stats.bankEmptyChannelRows += 1;
        const criteria = buildBankMatchCriteria(classified);
        const eligibility = criteria.ruleEligibility;
        if (!eligibility.eligible) {
          if (eligibility.code === 'bank-fund-type-unmapped') stats.bankRuleUnmappedRows += 1;
          if (eligibility.code === 'bank-rule-direction-mismatch') stats.bankRuleDirectionMismatchRows += 1;
          if (eligibility.code === 'bank-rule-no-gateway-trade-type') stats.bankRuleNoGatewayTradeTypeRows += 1;
        }
        const gatewayRow = eligibility.eligible ? consumeGateway(criteria, index) : null;
        if (gatewayRow) {
          const outputRow = mapBalancedRow({ bankRow: classified, gatewayRow });
          insertBalanced({ channel: classified.channel, bankOrdinal: index, outputRow });
          stats.matchedPairs += 1;
        } else {
          insertUnbalanced({
            channel: classified.channel,
            bankOrdinal: index,
            outputRow: mapUnbalancedRow(classified, {
              reason: eligibility.eligible
                ? '未找到同时满足对账ID、渠道、金额、币种和类型规则的网关账单'
                : eligibility.reason
            }),
            channelOutputRow: mapChannelBillRow(classified)
          });
          stats.unmatchedBankRows += 1;
        }
        if ((index + 1) % PROGRESS_INTERVAL === 0) {
          if (onProgress) onProgress({ stage: 'bank-match', current: index + 1, total: this.bankSession.rows.length });
          await yieldToEventLoop();
        }
      }

      if (stats.bankValidRows !== stats.matchedPairs + stats.unmatchedBankRows) {
        throw new Error(
          `前置资金对账银行行数不守恒：有效${stats.bankValidRows}，平账${stats.matchedPairs}，不平${stats.unmatchedBankRows}`
        );
      }
      const finalGatewayStats = this.runStore.gatewayStats(db, sideRunId);
      stats.unusedGatewayRows = finalGatewayStats.unusedCount;
      if (stats.gatewayEligibleRows !== stats.matchedPairs + stats.unusedGatewayRows) {
        throw new Error(
          `前置资金对账网关行数不守恒：候选${stats.gatewayEligibleRows}，已消费${stats.matchedPairs}，未消费${stats.unusedGatewayRows}`
        );
      }

      const snapshotSummary = this.runStore.duplicateStats(db, sideRunId);
      if (snapshotSummary.foldedRowCount !== stats.gatewayCollapsedDuplicateRows) {
        throw new Error(
          `前置资金对账重复审计不守恒：折叠统计${stats.gatewayCollapsedDuplicateRows}行，审计对象${snapshotSummary.foldedRowCount}行`
        );
      }
      stats.duplicateGroupCount = snapshotSummary.duplicateGroupCount;
      stats.duplicateAuditRawBytes = snapshotSummary.keptRawBytes + snapshotSummary.foldedRawBytes;
      const channelSummaries = this.runStore.summarizeChannels(db, sideRunId);
      stats.channelCount = channelSummaries.length;
      this.runStore.finishRun(db, sideRunId, stats);
      db.exec('COMMIT');
      sideTransactionStarted = false;
      try {
        mirrorRunId = this.database.createPreFundReconciliationRunMirror({
          monthKey,
          sideRunId,
          scenario,
          snapshotHash: stableHash(snapshot),
          bankFiles: [this.bankSession.fileName],
          sideDbRelPath: runDataStore.sideDbRelPath(
            runDataStore.MODULE_PRE_FUND_RECONCILIATION_RESULTS,
            monthKey
          ),
          archiveReceipt: {
            archiveContractVersion: 1,
            archiveTaskRunId: taskRunId
          }
        });
        this.database.finishPreFundReconciliationRunMirror(mirrorRunId, stats);
      } catch (mirrorError) {
        try {
          compensateRunReceiptAfterMirrorFailure(this.runStore, db, taskRunId);
        } catch (compensationError) {
          compensationError.code = 'PRE_FUND_MIRROR_COMPENSATION_FAILED';
          compensationError.preserveArchiveTaskRun = true;
          compensationError.cause = mirrorError;
          throw compensationError;
        }
        throw mirrorError;
      }
      this.lastRun = {
        monthKey,
        runId: mirrorRunId,
        sideRunId,
        snapshot,
        summary: stats,
        channelSummaries,
        archiveTaskRunId: taskRunId
      };
      if (onProgress) onProgress({ stage: 'done', current: stats.bankInputRows, total: stats.bankInputRows });
      return {
        status: 'ok',
        monthKey,
        runId: mirrorRunId,
        summary: { ...stats },
        channelSummaries
      };
    } catch (error) {
      if (sideTransactionStarted) rollbackQuietly(db);
      if (mirrorRunId !== null && error.preserveArchiveTaskRun !== true) {
        try {
          this.database.failPreFundReconciliationRunMirror(mirrorRunId, error);
        } catch (_mirrorError) { /* 原始错误优先 */ }
      }
      throw error;
    } finally {
      if (gatewaySnapshot) gatewaySnapshot.close();
      db.close();
    }
  }

  _buildExportPlanForCurrentRun(outputDirectory, exportDate, runLocator) {
    const availability = this.inspectLastRunAvailability();
    if (!availability.available) {
      this.recordLastRunUnavailable(availability);
      throw new PreFundReconciliationError(
        'pre-fund-run-unavailable',
        availability.message || '运行结果不可用，请重新运行'
      );
    }
    if (this.isLastRunStale()) {
      throw new PreFundReconciliationError('pre-fund-run-stale', '数据来源已变化，请重新运行后再导出');
    }
    const channels = this.runStore.listChannels(runLocator.monthKey, runLocator.sideRunId);
    return channels.map((channel) => ({
      channel,
      fileName: buildChannelFileName(channel, exportDate),
      filePath: path.join(outputDirectory, buildChannelFileName(channel, exportDate))
    }));
  }

  buildExportPlan(outputDirectory, exportDate = this.now(), runLocator = this.lastRunLocator()) {
    this.assertLastRunLocator(runLocator);
    return this._buildExportPlanForCurrentRun(outputDirectory, exportDate, runLocator);
  }

  async export({
    outputDirectory,
    outputPaths,
    runLocator,
    overwrite = false,
    onProgress,
    exportDate = this.now()
  } = {}) {
    this.assertLastRunLocator(runLocator);
    let plan = this._buildExportPlanForCurrentRun(outputDirectory, exportDate, runLocator);
    if (plan.length === 0) {
      throw new PreFundReconciliationError('pre-fund-export-empty', '本次运行没有可导出的银行渠道');
    }
    if (outputPaths !== undefined) {
      plan = plan.map((item, index) => ({
        ...item,
        filePath: outputPaths[index],
        fileName: path.basename(outputPaths[index])
      }));
    }
    const conflicts = plan.filter((item) => fs.existsSync(item.filePath));
    if (conflicts.length > 0 && !overwrite) {
      return { status: 'conflict', conflicts };
    }

    fs.mkdirSync(outputDirectory, { recursive: true });
    const backups = [];
    const publishedFiles = new Map();
    let files;
    try {
      for (const item of conflicts) {
        const backupNonce = `${process.pid}-${Date.now()}-${crypto.randomBytes(6).toString('hex')}`;
        const backupPath = `${item.filePath}.${backupNonce}.bak`;
        fs.renameSync(item.filePath, backupPath);
        backups.push({ filePath: item.filePath, backupPath });
      }
      if (onProgress) onProgress({ stage: 'export-start', current: 0, total: plan.length });
      files = await writeChannelWorkbooks({
        templatePath: this.templatePath,
        outputDirectory,
        exportDate,
        channelExports: (function* mapDuplicateRows(channelExports) {
          for (const channelExport of channelExports) {
            yield {
              ...channelExport,
              duplicateRows: channelExport.hasDuplicateRecords
                ? iterateDuplicateAuditRows(channelExport.duplicateRecords)
                : []
            };
          }
        }(this.runStore.iterateChannelExports(
          runLocator.monthKey,
          runLocator.sideRunId
        ))),
        onFilePublished: (publication) => {
          publishedFiles.set(publication.filePath, publication.identity);
        }
      });
    } catch (error) {
      const rollbackIssues = [];
      for (const [filePath, identity] of publishedFiles) {
        if (!currentFileMatchesIdentity(filePath, identity)) {
          rollbackIssues.push(`本次新文件已被外部替换或修改，未自动删除：${path.basename(filePath)}`);
          continue;
        }
        try {
          fs.rmSync(filePath, { force: true });
        } catch (removeError) {
          rollbackIssues.push(
            `无法清理本次新文件 ${path.basename(filePath)}：${removeError.message || removeError}`
          );
        }
      }
      for (const backup of backups.reverse()) {
        try {
          moveFileNoClobber(backup.backupPath, backup.filePath);
        } catch (restoreError) {
          rollbackIssues.push(
            `无法恢复原文件 ${path.basename(backup.filePath)}，备份保留在 ${backup.backupPath}：${restoreError.message || restoreError}`
          );
        }
      }
      if (rollbackIssues.length > 0) {
        throw new Error(`${error.message || error}；${rollbackIssues.join('；')}`, { cause: error });
      }
      throw error;
    }

    // 新文件已经全部完成，至此视为提交成功。清理备份失败只留下可人工删除的 .bak，
    // 不能再回滚并删除已成功的新文件。
    const warnings = [];
    for (const backup of backups) {
      try {
        fs.rmSync(backup.backupPath, { force: true });
      } catch (cleanupError) {
        warnings.push(
          `新文件已导出，但旧文件备份未能删除：${backup.backupPath}（${cleanupError.message || cleanupError}）`
        );
      }
    }
    if (onProgress) onProgress({ stage: 'export-done', current: files.length, total: files.length });
    return { status: 'ok', files, warnings };
  }
}

function createPreFundReconciliationService(options) {
  return new PreFundReconciliationService(options);
}

module.exports = {
  SCENARIO_MISSING_GATEWAY,
  PreFundReconciliationError,
  PreFundReconciliationService,
  createPreFundReconciliationService,
  localMonthKey,
  stableHash
};
