'use strict';

const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { deserializeError } = require('./serialize-error');
const {
  SOURCE_TYPES,
  SOURCE_LABELS,
} = require('../backend/vcc-financial-op/definitions');
const {
  isValidInputFingerprint,
  initializeOpeningBalances,
  preflightCalculation,
  preflightRequiredResult
} = require('../backend/vcc-financial-op/calculator');
const {
  listAdjustmentOptions: listAdjustmentOptionsFromDb
} = require('../backend/vcc-financial-op/result-adjustments');
const { normalizeYearMonth } = require('../backend/vcc-financial-op/row-mapper');
const repository = require('../backend/vcc-financial-op-db/repository');
const {
  IMPORT_CANCELLED_CODE
} = require('../backend/vcc-financial-op/detail-importer');
const {
  freezeImportArchiveHandoffFiles,
  normalizeImportBatchId,
  storedRecordResult
} = require('../backend/vcc-financial-op/import-service');
const {
  operationError,
  STATE_CHANGED_CODE,
  STATE_CHANGED_MESSAGE,
  validateOperationConfirmation
} = require('../backend/vcc-financial-op/operation-state');
const { writeRunWorkbooks } = require('./vcc-financial-op-writer');
const { writeImportAuditWorkbook } = require('./vcc-financial-op-audit-writer');
const {
  CHECK_EXPORT_DEFINITIONS,
  inspectDatasetExport
} = require('./vcc-financial-op-dataset-writer');
const {
  freezeWorkerBatchContext
} = require('./archive-center/worker-batch-context');
const {
  VCC_MUTATION_OPERATIONS
} = require('../backend/vcc-financial-op/mutation-policy');
const {
  reconcileVccImportArchiveLineage
} = require('./vcc-financial-op-archive-lineage');

const WORKER_PATH = path.join(__dirname, '../backend/vcc-financial-op/worker-entry.js');
const READ_WORKER_PATH = path.join(__dirname, 'vcc-financial-op-read-worker.js');
const RESULT_WRITE_WORKER_PATH = path.join(__dirname, 'vcc-financial-op-write-worker.js');

const IMPORT_STATUS_TEXT = Object.freeze({
  deleted: '已删除',
  success: '导入成功',
  success_with_skips: '成功（含跳过/异常过滤）',
  all_skipped: '全部幂等跳过',
  failed_conflict: '失败（幂等冲突）',
  failed_validation: '失败（校验异常）',
  importing: '导入中'
});

const DATA_STATUS_TEXT = Object.freeze({
  unprocessed: '未处理',
  archived: '已归档'
});

const SUCCESSFUL_IMPORT_STATUSES = new Set([
  'success',
  'success_with_skips',
  'all_skipped'
]);

function recoverImportPartialResult(database, batchId, expectedTargetMonth) {
  const batch = repository.getImportBatch(database.db, batchId);
  if (!batch || (expectedTargetMonth && batch.target_month !== expectedTargetMonth)) return null;
  const records = repository.listImportRecordsByBatch(database.db, batchId)
    .map((record) => storedRecordResult(record, database.db));
  if (records.length === 0) return null;
  return Object.freeze({
    batchId,
    targetMonth: batch.target_month,
    status: 'error',
    partialCommitted: records.some((record) => SUCCESSFUL_IMPORT_STATUSES.has(record.status)),
    records: Object.freeze(records)
  });
}

function parseJson(value, fallback) {
  if (value === null || value === undefined || value === '') return fallback;
  try {
    const parsed = JSON.parse(value);
    return parsed === null || parsed === undefined ? fallback : parsed;
  } catch (_error) {
    return fallback;
  }
}

function detailRecordShape(record, db) {
  const sourceFiles = parseJson(record.source_files_json, []);
  const originalStatus = record.status;
  const deleted = Boolean(record.dataset_deleted_at);
  return {
    id: record.id,
    batchId: record.batch_id,
    targetMonth: record.target_month,
    sourceType: record.source_type,
    sourceLabel: SOURCE_LABELS[record.source_type] || record.source_type,
    sourceFiles,
    sourceFileDisplay: sourceFiles.length <= 1 ? (sourceFiles[0] || '') : `${sourceFiles.length} 个文件`,
    startedAt: record.started_at,
    finishedAt: record.finished_at,
    status: deleted ? 'deleted' : originalStatus,
    statusText: deleted ? IMPORT_STATUS_TEXT.deleted : (IMPORT_STATUS_TEXT[originalStatus] || originalStatus),
    originalStatus,
    originalStatusText: IMPORT_STATUS_TEXT[originalStatus] || originalStatus,
    datasetDeletedAt: record.dataset_deleted_at || null,
    datasetDeletionId: record.dataset_deletion_id || null,
    rawCount: Number(record.raw_count) || 0,
    insertedCount: Number(record.inserted_count) || 0,
    skippedCount: Number(record.skipped_count) || 0,
    invalidKeyCount: Number(record.invalid_key_count) || 0,
    conflictCount: Number(record.conflict_count) || 0,
    formatErrorCount: Number(record.format_error_count) || 0,
    rolledBackCount: Number(record.rolled_back_count) || 0,
    anomalyCount: db
      ? repository.countExportableImportAnomalies(db, record.id)
      : (Number(record.anomaly_count) || 0),
    archiveState: record.archive_state || 'pending',
    errorMessage: record.error_message || '',
    resolutionStatus: record.resolution_status || 'not_applicable',
    resolvedAt: record.resolved_at || null,
    resolutionNote: record.resolution_note || '',
    resolutionAction: record.resolution_action || ''
  };
}

function effectiveRunShape(effective) {
  if (!effective) return null;
  const balances = effective.balances.map((row) => ({
    ...row,
    periodAmount: row.effectivePeriodAmount,
    calculatedBalance: row.effectiveCalculatedBalance,
    difference: row.effectiveDifference
  }));
  return {
    runId: effective.run.runId,
    targetMonth: effective.run.targetMonth,
    status: effective.run.status,
    resultRevision: effective.run.resultRevision,
    inputFingerprint: effective.run.inputFingerprint,
    createdAt: effective.run.createdAt,
    updatedAt: effective.run.updatedAt,
    archivedAt: effective.run.archivedAt,
    baseRows: effective.baseRows,
    adjustments: effective.adjustments,
    effectiveRows: effective.effectiveRows,
    balances,
    review: effective.review
  };
}

function createVccFinancialOpService({
  database,
  assetsDir,
  appVersion = null,
  buildSha = null,
  workerFactory = (filename, options) => new Worker(filename, options),
  readWorkerFactory = (filename, options) => new Worker(filename, options),
  writeWorkerFactory = (filename, options) => new Worker(filename, options),
  writeRunWorkbooksFn = writeRunWorkbooks,
  writeImportAuditWorkbookFn = writeImportAuditWorkbook,
  publishOutputFilesFn = null,
  archiveConsistencyLogger = null,
  operationDiagnosticLogger = null,
  archiveRepositoryProvider = null,
  archiveServiceProvider = null,
  cancelTimeoutMs = 120000
}) {
  let activeTask = null;
  let taskGeneration = 0;
  let closing = false;
  let activeMonthsCache = null;
  const activeReadWorkers = new Set();
  repository.recoverInterruptedImports(database.db);

  function syncImportArchiveLineage() {
    try {
      const archiveRepository = typeof archiveRepositoryProvider === 'function'
        ? archiveRepositoryProvider()
        : null;
      return reconcileVccImportArchiveLineage({
        db: database.db,
        archiveRepository
      });
    } catch (error) {
      if (operationDiagnosticLogger) {
        try {
          operationDiagnosticLogger({
            operation: 'sync-import-archive-lineage',
            code: error && error.code ? error.code : 'archive-lineage-sync-failed',
            message: error && error.message ? error.message : String(error)
          });
        } catch (_loggerError) { /* diagnostic logger must not change business result */ }
      }
      return Object.freeze({
        available: false,
        bound: 0,
        failed: 0,
        pending: 0,
        released: 0,
        error: error && error.message ? error.message : String(error)
      });
    }
  }

  function acquireTask(action, {
    kind = 'worker',
    destructive = false,
    expectedTaskGeneration = null
  } = {}) {
    if (closing) {
      throw operationError('service-closing', 'VCC 财务OP服务正在关闭，不能开始新任务。');
    }
    if (activeTask) {
      throw operationError('active-vcc-task', '已有 VCC 财务OP任务正在运行，请等待完成。');
    }
    if (expectedTaskGeneration !== null && expectedTaskGeneration !== undefined) {
      const expected = Number(expectedTaskGeneration);
      if (!Number.isSafeInteger(expected) || expected < 0 || expected !== taskGeneration) {
        throw operationError(STATE_CHANGED_CODE, STATE_CHANGED_MESSAGE, {
          context: { expectedTaskGeneration, actualTaskGeneration: taskGeneration }
        });
      }
    }
    let complete;
    const completion = new Promise((resolve) => { complete = resolve; });
    const task = {
      action,
      kind,
      destructive,
      baseGeneration: taskGeneration,
      claim: Object.freeze({
        action,
        generation: taskGeneration,
        identity: Object.freeze({})
      }),
      protected: false,
      phase: kind === 'worker' ? 'pretransaction' : 'direct',
      cancelRequested: false,
      worker: null,
      completion,
      complete,
      released: false
    };
    activeTask = task;
    return task;
  }

  function releaseTask(task, outcome) {
    if (!task || task.released) return;
    task.released = true;
    if (activeTask === task) {
      activeTask = null;
      taskGeneration += 1;
      activeMonthsCache = null;
    }
    task.complete(outcome);
  }

  async function runDirectTask(action, callback, options = {}) {
    const task = acquireTask(action, { ...options, kind: 'direct' });
    try {
      const result = await callback(task);
      releaseTask(task, { type: 'result', result });
      return result;
    } catch (error) {
      releaseTask(task, { type: 'error', error });
      throw error;
    }
  }

  function runWorker(action, payload, onProgress, options = {}) {
    const {
      workerPath = WORKER_PATH,
      createWorker = workerFactory,
      recoverImportBatchId = null,
      recoverImportTargetMonth = null,
      ...taskOptions
    } = options;
    const task = acquireTask(action, taskOptions);
    return new Promise((resolve, reject) => {
      let worker;
      try {
        worker = createWorker(workerPath, {
          workerData: {
            action,
            payload: {
              ...(payload || {}),
              taskGeneration: task.baseGeneration,
              appVersion,
              buildSha
            },
            dbPath: database.dbPath
          }
        });
        task.worker = worker;
      } catch (error) {
        releaseTask(task, { type: 'error', error });
        reject(error);
        return;
      }
      let settled = false;
      const finish = (error, result) => {
        if (settled) return;
        settled = true;
        if (error) {
          if (action === 'import' && recoverImportBatchId) {
            try {
              repository.failImportBatch(database.db, recoverImportBatchId, {
                errorCode: error.code || 'worker-interrupted-import',
                message: error.message || 'VCC 财务OP导入 worker 异常退出'
              });
            } catch (_recoveryError) { /* 下次启动继续恢复 */ }
            if (!error.partialResult) {
              try {
                const partialResult = recoverImportPartialResult(
                  database,
                  recoverImportBatchId,
                  recoverImportTargetMonth
                );
                if (partialResult) error.partialResult = partialResult;
              } catch (_readError) { /* 保留 worker 主错误；下次启动继续恢复 */ }
            }
          } else {
            try { repository.recoverInterruptedImports(database.db); } catch (_recoveryError) { /* 下次启动继续恢复 */ }
          }
          releaseTask(task, { type: 'error', error });
          reject(error);
        } else {
          releaseTask(task, { type: 'result', result });
          resolve(result);
        }
      };
      worker.on('message', (message) => {
        if (!message || typeof message !== 'object') return;
        if (message.type === 'progress') {
          if (typeof onProgress === 'function') onProgress(message.progress);
        } else if (message.type === 'diagnostic') {
          if (operationDiagnosticLogger) {
            try { operationDiagnosticLogger(message.diagnostic); } catch (_error) { /* 诊断不可阻断业务 */ }
          }
        } else if (message.type === 'critical-ready') {
          if (!task.destructive) {
            finish(operationError(
              'worker-protocol-error',
              `非破坏性任务 ${action} 意外请求进入破坏性事务。`
            ));
            return;
          }
          task.phase = 'critical-ready';
          if (task.cancelRequested) {
            try { worker.postMessage({ type: 'cancel' }); } catch (_error) { /* exit 事件收口 */ }
            return;
          }
          // 父进程先标记为不可终止，再确认 worker 可以进入事务。
          task.protected = true;
          task.phase = 'protected';
          try {
            worker.postMessage({ type: 'critical-ack' });
          } catch (error) {
            finish(error);
          }
        } else if (message.type === 'result') {
          finish(null, message.result);
        } else if (message.type === 'error') {
          finish(deserializeError(message.error));
        }
      });
      worker.on('error', (error) => finish(error));
      worker.on('exit', (code) => {
        if (!settled) finish(new Error(`VCC 财务OP后台任务退出但未返回结果（code ${code}）`));
      });
    });
  }

  function normalizeResultWritePayload(action, payload = {}) {
    if (action === VCC_MUTATION_OPERATIONS.UNARCHIVE_MONTH) {
      return {
        targetMonth: payload.targetMonth,
        expectedPreviewToken: payload.expectedPreviewToken
      };
    }
    if (action === VCC_MUTATION_OPERATIONS.DELETE_DATA_TARGET) {
      return {
        targetMonth: payload.targetMonth,
        targetType: payload.targetType || payload.sourceType,
        expectedPreviewToken: payload.expectedPreviewToken,
        reason: payload.reason
      };
    }
    const common = {
      runId: payload.runId,
      expectedResultRevision: payload.expectedResultRevision,
      expectedPreviewToken: payload.expectedPreviewToken
    };
    if (action === VCC_MUTATION_OPERATIONS.ARCHIVE_RESULT) return common;
    if (action === VCC_MUTATION_OPERATIONS.ADD_ADJUSTMENT) {
      return {
        ...common,
        rowKey: payload.rowKey,
        currency: payload.currency,
        adjustmentAmount: payload.adjustmentAmount,
        reason: payload.reason
      };
    }
    throw operationError('invalid-vcc-write-action', `未知 VCC 结果写入 action：${action || ''}`);
  }

  function runResultWriteWorker(action, payload = {}, onProgress, batchContext = null) {
    const normalizedPayload = normalizeResultWritePayload(action, payload);
    const confirmedGeneration = validateOperationConfirmation(
      normalizedPayload.expectedPreviewToken,
      payload.taskGeneration
    );
    const frozenBatchContext = freezeWorkerBatchContext(batchContext, { required: true });
    return runWorker(action, {
      ...normalizedPayload,
      batchContext: frozenBatchContext
    }, onProgress, {
      destructive: true,
      expectedTaskGeneration: confirmedGeneration,
      workerPath: RESULT_WRITE_WORKER_PATH,
      createWorker: writeWorkerFactory
    });
  }

  function runReadWorker(action, payload = {}) {
    if (closing) {
      return Promise.reject(operationError(
        'service-closing',
        'VCC 财务OP服务正在关闭，不能开始新读取。'
      ));
    }
    const capturedGeneration = taskGeneration;
    const capturedTask = activeTask;
    return new Promise((resolve, reject) => {
      let worker;
      try {
        worker = readWorkerFactory(READ_WORKER_PATH, {
          workerData: {
            action,
            payload: {
              ...payload,
              taskGeneration: capturedGeneration,
              taskActive: Boolean(capturedTask)
            },
            dbPath: database.dbPath
          }
        });
        activeReadWorkers.add(worker);
      } catch (error) {
        reject(error);
        return;
      }
      let settled = false;
      const finish = (error, result) => {
        if (settled) return;
        settled = true;
        activeReadWorkers.delete(worker);
        if (error) {
          reject(error);
          return;
        }
        if (taskGeneration !== capturedGeneration || activeTask !== capturedTask) {
          reject(operationError(STATE_CHANGED_CODE, STATE_CHANGED_MESSAGE, {
            context: {
              expectedTaskGeneration: capturedGeneration,
              actualTaskGeneration: taskGeneration,
              activeTaskChanged: activeTask !== capturedTask
            }
          }));
          return;
        }
        resolve(result);
      };
      worker.on('message', (message) => {
        if (!message || typeof message !== 'object') return;
        if (message.type === 'result') finish(null, message.result);
        else if (message.type === 'error') finish(deserializeError(message.error));
      });
      worker.on('error', (error) => finish(error));
      worker.on('exit', (code) => {
        if (!settled) finish(new Error(`VCC 财务OP只读任务退出但未返回结果（code ${code}）`));
      });
    });
  }

  async function inspectSelectedFiles(filePaths) {
    return runWorker('inspect', { filePaths });
  }

  async function importSelectedFiles(payload, onProgress, batchContext, archiveHandoffFiles) {
    const frozenBatchContext = freezeWorkerBatchContext(batchContext, { required: true });
    const importBatchId = normalizeImportBatchId(frozenBatchContext.taskRunId);
    if (repository.getImportBatch(database.db, importBatchId)) {
      throw operationError(
        'vcc-import-batch-id-conflict',
        `VCC 导入批次号已存在，拒绝把新任务写入既有批次：${importBatchId}`
      );
    }
    const frozenArchiveHandoffFiles = freezeImportArchiveHandoffFiles(
      archiveHandoffFiles,
      importBatchId
    );
    const targetMonth = normalizeYearMonth(payload && payload.targetMonth);
    return runWorker('import', {
      ...payload,
      batchId: importBatchId,
      batchContext: frozenBatchContext,
      archiveHandoffFiles: frozenArchiveHandoffFiles
    }, onProgress, {
      recoverImportBatchId: importBatchId,
      recoverImportTargetMonth: targetMonth
    });
  }

  async function calculate(payload = {}, batchContext) {
    const targetMonth = normalizeYearMonth(payload.targetMonth);
    if (!targetMonth) throw new Error(`计算账期格式无效：${payload.targetMonth || ''}`);
    if (!isValidInputFingerprint(payload.expectedInputFingerprint)) {
      return preflightRequiredResult(targetMonth);
    }
    return runWorker('calculate', {
      targetMonth,
      expectedInputFingerprint: payload.expectedInputFingerprint,
      batchContext: freezeWorkerBatchContext(batchContext, { required: true })
    });
  }

  function preflightRun(payload = {}) {
    const targetMonth = normalizeYearMonth(payload.targetMonth);
    if (!targetMonth) throw new Error(`计算账期格式无效：${payload.targetMonth || ''}`);
    if (activeTask) {
      return {
        ok: false,
        code: 'active-vcc-task',
        targetMonth,
        message: '已有 VCC 财务OP任务正在运行，请完成后重试。'
      };
    }
    return { targetMonth, ...preflightCalculation(database.db, targetMonth) };
  }

  async function cancelActiveTask(onCancellationAccepted = null) {
    const task = activeTask;
    if (!task) return { status: 'idle' };
    const worker = task.worker;
    const completion = task.completion;
    if (task.kind === 'direct' || task.protected || !worker) {
      const outcome = await completion;
      if (outcome.type === 'result') {
        return { status: 'completed', protected: task.protected || task.kind === 'direct' };
      }
      return {
        status: 'error',
        protected: task.protected || task.kind === 'direct',
        code: outcome.error && outcome.error.code,
        message: outcome.error && outcome.error.message ? outcome.error.message : '任务执行失败'
      };
    }

    task.cancelRequested = true;
    if (typeof onCancellationAccepted === 'function') {
      await onCancellationAccepted();
    }
    try {
      worker.postMessage({ type: 'cancel' });
    } catch (_error) {
      const outcome = await completion;
      if (task.action !== 'import') repository.recoverInterruptedImports(database.db);
      if (outcome.type === 'result') return { status: 'completed' };
      if (outcome.error && [IMPORT_CANCELLED_CODE, 'operation-cancelled'].includes(outcome.error.code)) {
        return { status: 'cancelled', forced: false };
      }
      return {
        status: 'error',
        message: outcome.error && outcome.error.message
          ? outcome.error.message
          : '取消导入失败'
      };
    }
    let timer = null;
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => resolve({ type: 'timeout' }), cancelTimeoutMs);
    });
    const outcome = await Promise.race([completion, timeout]);
    if (timer) clearTimeout(timer);
    if (outcome.type === 'timeout') {
      if (task.protected === true) {
        const protectedOutcome = await completion;
        if (protectedOutcome.type === 'result') return { status: 'completed', protected: true };
        return {
          status: 'error',
          protected: true,
          code: protectedOutcome.error && protectedOutcome.error.code,
          message: protectedOutcome.error && protectedOutcome.error.message
            ? protectedOutcome.error.message
            : '任务执行失败'
        };
      }
      if (activeTask === task) await worker.terminate();
      if (task.action !== 'import') repository.recoverInterruptedImports(database.db);
      return { status: 'cancelled', forced: true };
    }
    if (task.action !== 'import') repository.recoverInterruptedImports(database.db);
    if (outcome.type === 'result') return { status: 'completed' };
    if (outcome.error && [IMPORT_CANCELLED_CODE, 'operation-cancelled'].includes(outcome.error.code)) {
      return { status: 'cancelled', forced: false };
    }
    return {
      status: 'error',
      message: outcome.error && outcome.error.message
        ? outcome.error.message
        : '取消导入失败'
    };
  }

  function archive(payload = {}, onProgress, batchContext) {
    return runResultWriteWorker(
      VCC_MUTATION_OPERATIONS.ARCHIVE_RESULT,
      payload,
      onProgress,
      batchContext
    );
  }

  function listAdjustmentOptions(payload = {}) {
    return listAdjustmentOptionsFromDb(database.db, Number(payload.runId));
  }

  function addRunAdjustment(payload = {}, onProgress, batchContext) {
    return runResultWriteWorker(
      VCC_MUTATION_OPERATIONS.ADD_ADJUSTMENT,
      payload,
      onProgress,
      batchContext
    );
  }

  async function getRunReview(runId) {
    const snapshot = await runReadWorker('get-run-result', { runId: Number(runId) });
    return {
      ...effectiveRunShape(snapshot.effective),
      previewTokens: snapshot.previewTokens,
      taskGeneration: snapshot.taskGeneration
    };
  }

  function initializeOpening(payload, batchContext) {
    freezeWorkerBatchContext(batchContext, { required: true });
    return runDirectTask('initialize-opening', () => (
      initializeOpeningBalances({
        db: database.db,
        targetMonth: payload && payload.targetMonth,
        entries: payload && payload.entries,
        note: payload && payload.note
      })
    ));
  }

  async function listImportMonths() {
    if (activeMonthsCache && activeMonthsCache.taskGeneration === taskGeneration) {
      return [...activeMonthsCache.months];
    }
    const result = await runReadWorker('list-active-months');
    activeMonthsCache = Object.freeze({
      taskGeneration: result.taskGeneration,
      months: Object.freeze([...result.months])
    });
    return [...activeMonthsCache.months];
  }

  function listImportRecords(yearMonth) {
    syncImportArchiveLineage();
    return repository.listImportRecords(database.db, yearMonth)
      .map((record) => detailRecordShape(record, database.db));
  }

  function previewDatasetDeletion(payload = {}) {
    return previewDataTargetDeletion({
      targetMonth: payload.targetMonth,
      targetType: payload.sourceType
    });
  }

  function deleteDatasetData(payload = {}, onProgress, batchContext) {
    return deleteDataTargetData({
      targetMonth: payload.targetMonth,
      targetType: payload.sourceType,
      expectedPreviewToken: payload.expectedPreviewToken,
      taskGeneration: payload.taskGeneration,
      reason: payload.reason
    }, onProgress, batchContext);
  }

  async function listArchivedResultMonths(options = {}) {
    const result = await runReadWorker('list-archive-months', options);
    for (const diagnostic of result.diagnostics || []) {
      if (archiveConsistencyLogger) {
        try { archiveConsistencyLogger(diagnostic); } catch (_error) { /* 诊断日志不可阻断归档枚举 */ }
      }
    }
    return result.months;
  }

  async function getArchivedRunByMonth(targetMonth) {
    const result = await runReadWorker('list-archive-months', { targetMonth });
    const target = result.months[0] || null;
    if (target) return target;
    const diagnostic = result.diagnostics[0] || null;
    if (diagnostic && diagnostic.hasArchivedEvidence) {
      throw operationError(
        'archive-state-inconsistent',
        `${targetMonth} 的归档结果、主体余额或数据集状态不一致，禁止导出。`,
        {
          targetMonth,
          consistencyReasons: diagnostic.consistencyReasons,
          context: { targetMonth, consistencyReasons: diagnostic.consistencyReasons }
        }
      );
    }
    throw operationError(
      'no-archived-results',
      `${targetMonth} 暂无已归档财务OP校验结果。`,
      { targetMonth, context: { targetMonth } }
    );
  }

  function previewUnarchive(payload = {}) {
    return runReadWorker('preview-unarchive', { targetMonth: payload.targetMonth });
  }

  function unarchiveMonth(payload = {}, onProgress, batchContext) {
    const expectedPreviewToken = Object.prototype.hasOwnProperty.call(payload, 'expectedPreviewToken')
      ? payload.expectedPreviewToken
      : payload.previewToken;
    return runResultWriteWorker(VCC_MUTATION_OPERATIONS.UNARCHIVE_MONTH, {
      targetMonth: payload.targetMonth,
      expectedPreviewToken,
      taskGeneration: payload.taskGeneration
    }, onProgress, batchContext);
  }

  async function listDeleteTargets(payload = {}) {
    const result = await runReadWorker('list-delete-targets', {
      targetMonth: payload.targetMonth
    });
    return result.targets;
  }

  function previewDataTargetDeletion(payload = {}) {
    return runReadWorker('preview-delete-target', payload);
  }

  function deleteDataTargetData(payload = {}, onProgress, batchContext) {
    const expectedPreviewToken = Object.prototype.hasOwnProperty.call(payload, 'expectedPreviewToken')
      ? payload.expectedPreviewToken
      : payload.previewToken;
    return runResultWriteWorker(VCC_MUTATION_OPERATIONS.DELETE_DATA_TARGET, {
      targetMonth: payload.targetMonth,
      targetType: payload.targetType || payload.sourceType,
      expectedPreviewToken,
      taskGeneration: payload.taskGeneration,
      reason: payload.reason
    }, onProgress, batchContext);
  }

  function previewDatasetExport(payload = {}) {
    syncImportArchiveLineage();
    return {
      ...inspectDatasetExport(
        database.db,
        payload.targetMonth,
        payload.sourceType,
        payload.targetKind,
        { taskActive: Boolean(activeTask) }
      ),
      taskGeneration
    };
  }

  async function resolveDatasetArchiveSources(payload = {}) {
    const tableName = payload.sourceType === SOURCE_TYPES.SYSTEM_OP
      ? 'vcc_fin_op_system_snapshots'
      : 'vcc_fin_op_effective_rows';
    const columns = database.db.prepare(`PRAGMA table_info(${tableName})`).all();
    if (!columns.some((column) => column.name === 'import_source_id')) return [];
    const archiveService = typeof archiveServiceProvider === 'function'
      ? archiveServiceProvider()
      : null;
    const rows = payload.sourceType === SOURCE_TYPES.SYSTEM_OP
      ? database.db.prepare(`
          SELECT DISTINCT snapshot.import_source_id AS referenced_source_id,
                 s.id, s.archive_artifact_id, s.archive_state, s.bound_at,
                 s.source_file_name, s.source_sha256, s.source_size_bytes
          FROM vcc_fin_op_system_snapshots AS snapshot
          LEFT JOIN vcc_fin_op_import_sources AS s ON s.id = snapshot.import_source_id
          WHERE snapshot.target_month = ? AND snapshot.import_source_id IS NOT NULL
          ORDER BY snapshot.import_source_id
        `).all(payload.targetMonth)
      : database.db.prepare(`
          SELECT DISTINCT e.import_source_id AS referenced_source_id,
                 s.id, s.archive_artifact_id, s.archive_state, s.bound_at,
                 s.source_file_name, s.source_sha256, s.source_size_bytes
          FROM vcc_fin_op_effective_rows AS e
          LEFT JOIN vcc_fin_op_import_sources AS s ON s.id = e.import_source_id
          WHERE e.target_month = ? AND e.source_type = ?
            AND e.import_source_id IS NOT NULL
          ORDER BY e.import_source_id
        `).all(payload.targetMonth, payload.sourceType);
    if (rows.length === 0) return [];
    const resolved = [];
    for (const source of rows) {
      const sourceId = Number(source.id);
      if (!Number.isSafeInteger(sourceId) || sourceId < 1) {
        const error = new Error(`当前有效数据引用的导入来源 ${source.referenced_source_id} 不存在`);
        error.code = 'archive-lineage-invalid';
        throw error;
      }
      const artifactId = Number(source.archive_artifact_id);
      const hasArtifact = Number.isSafeInteger(artifactId) && artifactId > 0;
      const wasBound = hasArtifact || Boolean(source.bound_at) || source.archive_state === 'ready';
      if (!hasArtifact) {
        if (wasBound) {
          const error = new Error(`导入来源 ${sourceId} 的 artifact 绑定已损坏或丢失`);
          error.code = 'archive-integrity-failure';
          throw error;
        }
        continue;
      }
      if (source.archive_state !== 'ready') {
        const error = new Error(`导入来源 ${sourceId} 的 bound artifact 状态异常`);
        error.code = 'archive-integrity-failure';
        throw error;
      }
      if (!archiveService || typeof archiveService.resolveVerifiedArtifact !== 'function') {
        const error = new Error('存档中心暂不可用，无法核验并重建校验原表');
        error.code = 'archive-storage-unavailable';
        throw error;
      }
      const artifact = await archiveService.resolveVerifiedArtifact(artifactId);
      if (!artifact || artifact.ok !== true
          || String(artifact.sha256 || '').toLowerCase() !== String(source.source_sha256).toLowerCase()
          || Number(artifact.sizeBytes) !== Number(source.source_size_bytes)) {
        const error = new Error(
          artifact && artifact.message
            ? artifact.message
            : `导入来源 ${source.id} 的存档文件完整性校验失败`
        );
        error.code = artifact && artifact.code || 'archive-integrity-failure';
        throw error;
      }
      resolved.push({
        sourceId,
        filePath: artifact.filePath,
        fileName: source.source_file_name,
        sha256: source.source_sha256,
        sizeBytes: Number(source.source_size_bytes)
      });
    }
    return resolved;
  }

  async function exportDatasetData(payload = {}, onProgress, batchContext) {
    const frozenBatchContext = freezeWorkerBatchContext(batchContext, { required: true });
    const archiveSources = await resolveDatasetArchiveSources(payload);
    return runWorker('export-dataset', {
      targetMonth: payload.targetMonth,
      sourceType: payload.sourceType,
      targetKind: payload.targetKind,
      outputPath: payload.generationOutputPath || payload.outputPath,
      archiveSources,
      expectedInspection: payload.expectedInspection,
      batchContext: frozenBatchContext
    }, onProgress, {
      expectedTaskGeneration: payload.taskGeneration
    }).then(async (result) => {
      if (!payload.generationOutputPath || typeof publishOutputFilesFn !== 'function') return result;
      await publishOutputFilesFn({
        batchContext: frozenBatchContext,
        generationFilePaths: [result.filePath],
        targetFilePaths: [payload.outputPath],
        targetSnapshots: payload.targetSnapshots,
        onDurableHandoff: (publication) => (
          typeof payload.onDurableHandoff === 'function'
            ? payload.onDurableHandoff(publication, result)
            : undefined
        )
      });
      return { ...result, filePath: path.resolve(payload.outputPath) };
    });
  }

  function resolveRecord({ recordId, note, action }, batchContext) {
    freezeWorkerBatchContext(batchContext, { required: true });
    return runDirectTask('resolve-import-record', () => (
      detailRecordShape(repository.resolveImportRecord(database.db, Number(recordId), {
        note,
        action
      }), database.db)
    ));
  }

  function dataManagerOverview(yearMonth) {
    const datasets = database.db.prepare(`
      SELECT * FROM vcc_fin_op_datasets WHERE target_month = ? ORDER BY dataset_type
    `).all(yearMonth);
    const raw = datasets.map((row) => ({
      tableName: SOURCE_LABELS[row.dataset_type] || row.dataset_type,
      sourceType: row.dataset_type,
      dataStatus: row.data_status,
      dataStatusText: DATA_STATUS_TEXT[row.data_status] || row.data_status,
      generatedAt: row.generated_at
    }));
    const checks = datasets
      .filter((row) => row.dataset_type !== SOURCE_TYPES.SYSTEM_OP)
      .map((row) => ({
        tableName: CHECK_EXPORT_DEFINITIONS[row.dataset_type]?.label
          || `${SOURCE_LABELS[row.dataset_type]}_校验表`,
        sourceType: row.dataset_type,
        dataStatus: row.data_status,
        dataStatusText: DATA_STATUS_TEXT[row.data_status] || row.data_status,
        generatedAt: row.generated_at
      }));
    if (datasets.some((row) => row.dataset_type === SOURCE_TYPES.SYSTEM_OP)) {
      const system = datasets.find((row) => row.dataset_type === SOURCE_TYPES.SYSTEM_OP);
      checks.push({
        tableName: SOURCE_LABELS[SOURCE_TYPES.SYSTEM_OP],
        sourceType: SOURCE_TYPES.SYSTEM_OP,
        dataStatus: system.data_status,
        dataStatusText: DATA_STATUS_TEXT[system.data_status] || system.data_status,
        generatedAt: system.generated_at
      });
    }
    const runs = database.db.prepare(`
      SELECT id, target_month, status, result_revision, input_fingerprint,
             created_at, updated_at, archived_at
      FROM vcc_fin_op_runs WHERE target_month = ? ORDER BY id DESC
    `).all(yearMonth).map((row) => ({
      runId: row.id,
      tableName: '财务OP校验结果表',
      dataStatus: row.status === 'archived' ? 'archived' : 'unprocessed',
      dataStatusText: row.status === 'archived' ? '已归档' : '未处理',
      resultRevision: Number(row.result_revision) || 0,
      inputFingerprint: row.input_fingerprint || null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      archivedAt: row.archived_at
    }));
    return { targetMonth: yearMonth, results: runs, checks, raw };
  }

  async function latestArchivedRun() {
    const latest = (await listArchivedResultMonths())[0] || null;
    return latest ? getRunReview(latest.runId) : null;
  }

  async function exportRun(payload, batchContext) {
    const {
      targetMonth,
      outputDirectory,
      outputPath,
      publicationStagingDirectory,
      targetSnapshots
    } = payload || {};
    const frozenBatchContext = freezeWorkerBatchContext(batchContext, { required: true });
    return runDirectTask('export-result', async () => {
      // 对话框确认与真正写文件之间可能发生解归档，因此必须在拿到全局租约后重查。
      const target = await getArchivedRunByMonth(targetMonth);
      const result = await writeRunWorkbooksFn({
        db: database.db,
        runId: target.runId,
        outputDirectory,
        outputPath,
        assetsDir,
        publicationStagingDirectory
      });
      if (!result.generationFilePaths || typeof publishOutputFilesFn !== 'function') return result;
      await publishOutputFilesFn({
        batchContext: frozenBatchContext,
        generationFilePaths: result.generationFilePaths,
        targetFilePaths: result.filePaths,
        targetSnapshots: Array.isArray(targetSnapshots)
          ? targetSnapshots
          : result.filePaths.map(() => ({ exists: false })),
        onDurableHandoff: (publication) => (
          typeof payload.onDurableHandoff === 'function'
            ? payload.onDurableHandoff(publication, result)
            : undefined
        )
      });
      const { generationFilePaths: _generationFilePaths, ...publishedResult } = result;
      return publishedResult;
    });
  }

  async function exportImportAudit(payload, batchContext) {
    const frozenBatchContext = freezeWorkerBatchContext(batchContext, { required: true });
    return runDirectTask('export-import-audit', async () => {
      const generationOutputPath = payload.generationOutputPath || payload.outputPath;
      const result = await writeImportAuditWorkbookFn({
        db: database.db,
        recordId: Number(payload.recordId),
        tab: payload.tab,
        outputPath: generationOutputPath,
        key: payload.key,
        fileName: payload.fileName
      });
      if (!payload.generationOutputPath || typeof publishOutputFilesFn !== 'function') return result;
      await publishOutputFilesFn({
        batchContext: frozenBatchContext,
        generationFilePaths: [result.filePath],
        targetFilePaths: [payload.outputPath],
        targetSnapshots: payload.targetSnapshots,
        onDurableHandoff: (publication) => (
          typeof payload.onDurableHandoff === 'function'
            ? payload.onDurableHandoff(publication, result)
            : undefined
        )
      });
      return { ...result, filePath: path.resolve(payload.outputPath) };
    });
  }

  return {
    inspectSelectedFiles,
    importSelectedFiles,
    calculate,
    preflightRun,
    cancelActiveTask,
    archive,
    listAdjustmentOptions,
    addRunAdjustment,
    initializeOpening,
    listImportMonths,
    listImportRecords,
    listArchivedResultMonths,
    getArchivedRunByMonth,
    previewUnarchive,
    unarchiveMonth,
    previewDatasetDeletion,
    deleteDatasetData,
    listDeleteTargets,
    previewDataTargetDeletion,
    deleteDataTarget: deleteDataTargetData,
    previewDatasetExport,
    exportDatasetData,
    resolveDatasetArchiveSources,
    resolveRecord,
    dataManagerOverview,
    latestArchivedRun,
    exportRun,
    exportImportAudit,
    syncImportArchiveLineage,
    getRunResult: getRunReview,
    async terminate() {
      closing = true;
      await Promise.all([...activeReadWorkers].map((worker) => worker.terminate()));
      await cancelActiveTask();
    },
    _taskStateForTests: () => ({
      taskGeneration,
      closing,
      active: Boolean(activeTask),
      action: activeTask ? activeTask.action : null,
      phase: activeTask ? activeTask.phase : null,
      protected: activeTask ? activeTask.protected : false
    }),
    _claimForTests: () => activeTask ? activeTask.claim : null,
    _runResultWriteWorkerForTests: runResultWriteWorker
  };
}

module.exports = {
  IMPORT_STATUS_TEXT,
  DATA_STATUS_TEXT,
  createVccFinancialOpService
};
