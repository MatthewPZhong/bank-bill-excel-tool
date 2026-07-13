'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { readBankStatement } = require('../bank-statement-io');
const {
  createPreFundReconciliationStore
} = require('../../backend/pre-fund-reconciliation-store');
const {
  createPreFundReconciliationRunStore
} = require('../../backend/pre-fund-reconciliation-run-store');
const runDataStore = require('../../backend/run-data-store');
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
const { MPT_SCHEMAS } = require('./mpt-schema');

const SCENARIO_MISSING_GATEWAY = 'missing-gateway';
const PROGRESS_INTERVAL = 5000;

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

function errorResult(filePath, error) {
  return {
    status: 'failed',
    fileName: path.basename(filePath || ''),
    code: error && error.code ? error.code : 'pre-fund-import-failed',
    message: error && error.message ? error.message : String(error),
    detailLines: Array.isArray(error && error.detailLines) ? error.detailLines : []
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

function bankContext(row, index, fileName) {
  return {
    fileName,
    excelRowNumber: row && row._excelRowNumber ? row._excelRowNumber : index + 2,
    inputIndex: index
  };
}

class PreFundReconciliationService {
  constructor({ userDataDir, database, templatePath, now = () => new Date() }) {
    if (!userDataDir || typeof userDataDir !== 'string') {
      throw new TypeError('前置资金对账 service 需要 userDataDir');
    }
    if (!database) throw new TypeError('前置资金对账 service 需要 database');
    const mirrorMethods = [
      'createPreFundReconciliationRunMirror',
      'finishPreFundReconciliationRunMirror',
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
    this.tempStore = createPreFundReconciliationStore(userDataDir);
    this.runStore = createPreFundReconciliationRunStore(userDataDir);
    this.bankSession = null;
    this.bankRevision = 0;
    this.lastRun = null;
    this.reconcilePersistedRunMirrors();
  }

  reconcilePersistedRunMirrors() {
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
    this.runStore.clearAllRunData();
  }

  revokePreviousRunResults() {
    for (const mirror of this.database.listPreFundReconciliationRunMirrors()) {
      if (mirror.status !== 'success') continue;
      this.database.markPreFundReconciliationRunMirrorUnavailable(
        mirror.id,
        'superseded',
        '已开始新的前置资金对账运行，旧结果已回收'
      );
    }
    return this.runStore.clearAllRunData();
  }

  importBank(filePath) {
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

  async importMptFiles(filePaths, onProgress) {
    const paths = Array.isArray(filePaths) ? filePaths : [];
    const results = [];
    for (let index = 0; index < paths.length; index += 1) {
      const filePath = paths[index];
      if (onProgress) onProgress({ stage: 'mpt-import', current: index + 1, total: paths.length, fileName: path.basename(filePath) });
      try {
        const imported = await this.tempStore.importFile(filePath);
        results.push({
          ...imported,
          status: 'ok',
          importStatus: imported.status,
          fileName: path.basename(filePath),
          sourceType: imported.batch ? imported.batch.sourceType : '',
          rowCount: imported.batch ? imported.batch.rowCount : 0
        });
      } catch (error) {
        results.push(errorResult(filePath, error));
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

  listTempBatches() {
    return this.tempStore.listBatches();
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

  buildSourceSnapshot() {
    const batches = this.tempStore.listBatches().map((batch) => ({
      monthKey: batch.monthKey,
      sourceType: batch.sourceType,
      sourceBatch: batch.sourceBatch,
      sourceFileSequence: batch.sourceFileSequence,
      contentHash: batch.contentHash,
      rowCount: batch.rowCount
    }));
    const linkedMeta = this.database.getLinkedTableMeta('gateway-bill');
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

  resolveKeptRawJson({ source, location = {} }) {
    const sourceRecordId = location.sourceRecordId;
    if (source === GATEWAY_SOURCE.TEMPORARY) {
      return this.tempStore.getRawJsonById(location.monthKey, sourceRecordId);
    }
    if (source === GATEWAY_SOURCE.PERSISTENT) {
      if (typeof this.database.getGatewayBillRawJsonById !== 'function') {
        throw new TypeError('前置资金对账 database 缺少 getGatewayBillRawJsonById');
      }
      return this.database.getGatewayBillRawJsonById(sourceRecordId);
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

  async run({ scenario = SCENARIO_MISSING_GATEWAY, onProgress } = {}) {
    if (scenario !== SCENARIO_MISSING_GATEWAY) {
      throw new PreFundReconciliationError(
        'pre-fund-scenario-unsupported',
        '3.0.14 仅支持“缺网关账单”场景'
      );
    }
    if (!this.bankSession) {
      throw new PreFundReconciliationError('pre-fund-bank-session-missing', '请先导入标准银行对账单');
    }

    // 新 run 开始即撤销旧结果的导出资格；失败时也不能回退导出旧快照。
    this.lastRun = null;
    this.revokePreviousRunResults();

    const snapshot = this.buildSourceSnapshot();
    const monthKey = localMonthKey(this.now());
    const db = this.runStore.open(monthKey);
    let sideRunId = null;
    let mirrorRunId = null;
    const stats = {
      bankInputRows: 0,
      bankValidRows: 0,
      bankSkippedZeroRows: 0,
      bankExcludedEmptyIdRows: 0,
      bankEmptyChannelRows: 0,
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
      sideRunId = this.runStore.createRun(db, {
        scenario,
        snapshot,
        bankFiles: [this.bankSession.fileName]
      });
      mirrorRunId = this.database.createPreFundReconciliationRunMirror({
        monthKey,
        sideRunId,
        scenario,
        snapshotHash: stableHash(snapshot),
        bankFiles: [this.bankSession.fileName],
        sideDbRelPath: runDataStore.sideDbRelPath(
          runDataStore.MODULE_PRE_FUND_RECONCILIATION_RESULTS,
          monthKey
        )
      });
      db.exec('BEGIN IMMEDIATE');
      const insertCandidate = this.runStore.createGatewayCandidateInserter(db, sideRunId, {
        resolveKeptRawJson: (kept) => this.resolveKeptRawJson(kept)
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
        this.database.iterateGatewayBillRows(),
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
        const gatewayRow = consumeGateway(buildBankMatchCriteria(classified), index);
        if (gatewayRow) {
          const outputRow = mapBalancedRow({ bankRow: classified, gatewayRow });
          insertBalanced({ channel: classified.channel, bankOrdinal: index, outputRow });
          stats.matchedPairs += 1;
        } else {
          insertUnbalanced({
            channel: classified.channel,
            bankOrdinal: index,
            outputRow: mapUnbalancedRow(classified),
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
      this.database.finishPreFundReconciliationRunMirror(mirrorRunId, stats);
      this.lastRun = {
        monthKey,
        runId: mirrorRunId,
        sideRunId,
        snapshot,
        summary: stats,
        channelSummaries
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
      rollbackQuietly(db);
      if (sideRunId !== null) {
        try { this.runStore.failRun(db, sideRunId, error); } catch (_failError) { /* 原始错误优先 */ }
      }
      if (mirrorRunId !== null) {
        try {
          this.database.failPreFundReconciliationRunMirror(mirrorRunId, error);
        } catch (_mirrorError) { /* 原始错误优先 */ }
      }
      throw error;
    } finally {
      db.close();
    }
  }

  buildExportPlan(outputDirectory, exportDate = this.now()) {
    if (!this.lastRun) {
      throw new PreFundReconciliationError('pre-fund-run-missing', '请先运行前置资金对账');
    }
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
    const channels = this.runStore.listChannels(this.lastRun.monthKey, this.lastRun.sideRunId);
    return channels.map((channel) => ({
      channel,
      fileName: buildChannelFileName(channel, exportDate),
      filePath: path.join(outputDirectory, buildChannelFileName(channel, exportDate))
    }));
  }

  async export({ outputDirectory, overwrite = false, onProgress } = {}) {
    const exportDate = this.now();
    const plan = this.buildExportPlan(outputDirectory, exportDate);
    if (plan.length === 0) {
      throw new PreFundReconciliationError('pre-fund-export-empty', '本次运行没有可导出的银行渠道');
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
          this.lastRun.monthKey,
          this.lastRun.sideRunId
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
