'use strict';

const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { deserializeError } = require('./serialize-error');
const {
  SOURCE_TYPES,
  SOURCE_LABELS,
  SUPPORTED_CURRENCIES,
  getRawContractHeaders,
  getSourceDefinition
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

const WORKER_PATH = path.join(__dirname, '../backend/vcc-financial-op/worker-entry.js');
const READ_WORKER_PATH = path.join(__dirname, 'vcc-financial-op-read-worker.js');
const RESULT_WRITE_WORKER_PATH = path.join(__dirname, 'vcc-financial-op-write-worker.js');

const IMPORT_STATUS_TEXT = Object.freeze({
  deleted: '已删除',
  success: '导入成功',
  success_with_skips: '成功（含幂等跳过）',
  all_skipped: '全部幂等跳过',
  failed_conflict: '失败（幂等冲突）',
  failed_validation: '失败（校验异常）',
  importing: '导入中'
});

const DATA_STATUS_TEXT = Object.freeze({
  unprocessed: '未处理',
  archived: '已归档'
});

function parseJson(value, fallback) {
  if (value === null || value === undefined || value === '') return fallback;
  try {
    const parsed = JSON.parse(value);
    return parsed === null || parsed === undefined ? fallback : parsed;
  } catch (_error) {
    return fallback;
  }
}

function detailRecordShape(record) {
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
    errorMessage: record.error_message || '',
    resolutionStatus: record.resolution_status || 'not_applicable',
    resolvedAt: record.resolved_at || null,
    resolutionNote: record.resolution_note || '',
    resolutionAction: record.resolution_action || ''
  };
}

function rawObject(sourceType, rawJson, assignedSubject = '', rawContractVersion = 1) {
  const definition = getSourceDefinition(sourceType);
  const headers = getRawContractHeaders(sourceType, rawContractVersion);
  const values = parseJson(rawJson, []);
  if (!definition || !headers || !Array.isArray(values)) return values;
  const result = Object.fromEntries(headers.map((header, index) => [header, values[index] ?? '']));
  if (sourceType === SOURCE_TYPES.CHANNEL) result['公司主体（导入指定）'] = assignedSubject || '';
  return result;
}

function importRowShape(row) {
  const existingRawJson = row.existing_raw_json || row.comparison_raw_json || null;
  return {
    id: row.id,
    sourceType: row.source_type,
    sourceLabel: SOURCE_LABELS[row.source_type] || row.source_type,
    targetMonth: row.target_month,
    idempotencyKey: row.idempotency_key || '',
    disposition: row.disposition,
    sourceFile: row.source_file,
    sheetName: row.sheet_name,
    sourceRow: row.source_row,
    validationField: row.validation_field || '',
    message: row.validation_message || '',
    diffFields: parseJson(row.diff_fields_json, []),
    incoming: rawObject(
      row.source_type,
      row.raw_json,
      row.subject,
      row.raw_contract_version
    ),
    existing: existingRawJson
      ? rawObject(
        row.source_type,
        existingRawJson,
        row.existing_subject || row.comparison_subject,
        row.existing_raw_contract_version || row.comparison_raw_contract_version
      )
      : null,
    existingSource: existingRawJson ? {
      sourceFile: row.existing_source_file || row.comparison_source_file || '',
      sheetName: row.existing_sheet_name || row.comparison_sheet_name || '',
      sourceRow: row.existing_source_row || row.comparison_source_row || null,
      importRecordId: row.existing_import_record_id || row.comparison_import_record_id || null,
      importedAt: row.existing_imported_at || row.comparison_created_at || null
    } : null
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
  archiveConsistencyLogger = null,
  operationDiagnosticLogger = null,
  cancelTimeoutMs = 120000
}) {
  let activeTask = null;
  let taskGeneration = 0;
  let closing = false;
  let activeMonthsCache = null;
  const activeReadWorkers = new Set();
  repository.recoverInterruptedImports(database.db);

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
          try { repository.recoverInterruptedImports(database.db); } catch (_recoveryError) { /* 下次启动继续恢复 */ }
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

  async function importSelectedFiles(payload, onProgress, batchContext) {
    return runWorker('import', {
      ...payload,
      batchContext: freezeWorkerBatchContext(batchContext, { required: true })
    }, onProgress);
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
      repository.recoverInterruptedImports(database.db);
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
      repository.recoverInterruptedImports(database.db);
      return { status: 'cancelled', forced: true };
    }
    repository.recoverInterruptedImports(database.db);
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
    return repository.listImportRecords(database.db, yearMonth).map(detailRecordShape);
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
    return inspectDatasetExport(
      database.db,
      payload.targetMonth,
      payload.sourceType,
      payload.targetKind,
      { taskActive: Boolean(activeTask) }
    );
  }

  function exportDatasetData(payload = {}, onProgress, batchContext) {
    return runWorker('export-dataset', {
      targetMonth: payload.targetMonth,
      sourceType: payload.sourceType,
      targetKind: payload.targetKind,
      outputPath: payload.outputPath,
      batchContext: freezeWorkerBatchContext(batchContext, { required: true })
    }, onProgress);
  }

  function getImportRecordDetail({ recordId, tab = 'summary', page = 1, pageSize = 100, key = '', fileName = '' }) {
    const id = Number(recordId);
    const record = repository.getImportRecord(database.db, id);
    if (!record) throw new Error(`导入记录不存在：${recordId}`);
    const summary = detailRecordShape(record);
    const errors = database.db.prepare(`
      SELECT * FROM vcc_fin_op_import_errors
      WHERE import_record_id = ? ORDER BY id
    `).all(id);
    if (tab === 'summary') return { summary, errors, rows: [], total: 0, page: 1, pageSize };

    const safePageSize = Math.max(1, Math.min(500, Number(pageSize) || 100));
    const safePage = Math.max(1, Number(page) || 1);
    const offset = (safePage - 1) * safePageSize;
    if (record.source_type === SOURCE_TYPES.SYSTEM_OP) {
      const systemDisposition = tab === 'skips'
        ? 'idempotent_skip'
        : (tab === 'conflicts' ? 'idempotent_conflict' : 'rolled_back');
      const conditions = ['a.import_record_id = ?', 'a.disposition = ?'];
      const params = [id, systemDisposition];
      if (String(key).trim()) {
        conditions.push('a.subject LIKE ?');
        params.push(`%${String(key).trim()}%`);
      }
      if (String(fileName).trim()) {
        conditions.push('a.source_file LIKE ?');
        params.push(`%${String(fileName).trim()}%`);
      }
      const where = conditions.join(' AND ');
      const total = Number(database.db.prepare(`
        SELECT COUNT(*) AS row_count
        FROM vcc_fin_op_system_snapshot_attempts a
        WHERE ${where}
      `).get(...params).row_count) || 0;
      const rows = database.db.prepare(`
        SELECT a.*,
               COALESCE(e.balances_json, a.existing_balances_json_snapshot) AS existing_balances_json,
               COALESCE(e.raw_json, a.existing_raw_json_snapshot) AS existing_raw_json,
               COALESCE(e.source_file, a.existing_source_file_snapshot) AS existing_source_file,
               COALESCE(e.sheet_name, a.existing_sheet_name_snapshot) AS existing_sheet_name,
               COALESCE(e.source_row, a.existing_source_row_snapshot) AS existing_source_row,
               COALESCE(e.import_record_id, a.existing_import_record_id_snapshot) AS existing_import_record_id,
               COALESCE(e.imported_at, a.existing_imported_at_snapshot) AS existing_imported_at,
               c.balances_json AS comparison_balances_json,
               c.raw_json AS comparison_raw_json,
               c.source_file AS comparison_source_file,
               c.sheet_name AS comparison_sheet_name,
               c.source_row AS comparison_source_row,
               c.import_record_id AS comparison_import_record_id,
               c.created_at AS comparison_imported_at
        FROM vcc_fin_op_system_snapshot_attempts a
        LEFT JOIN vcc_fin_op_system_snapshots e ON e.id = a.existing_snapshot_id
        LEFT JOIN vcc_fin_op_system_snapshot_attempts c ON c.id = a.comparison_attempt_id
        WHERE ${where}
        ORDER BY a.id
        LIMIT ? OFFSET ?
      `).all(...params, safePageSize, offset).map((row) => {
        const incomingBalances = parseJson(row.balances_json, {});
        const existingBalancesJson = row.existing_balances_json || row.comparison_balances_json;
        const existingBalances = parseJson(existingBalancesJson, {});
        return {
          id: `system-${row.id}`,
          sourceType: SOURCE_TYPES.SYSTEM_OP,
          sourceLabel: SOURCE_LABELS[SOURCE_TYPES.SYSTEM_OP],
          targetMonth: row.target_month,
          idempotencyKey: `${row.target_month} × ${row.subject}`,
          disposition: row.disposition,
          sourceFile: row.source_file,
          sheetName: row.sheet_name,
          sourceRow: row.source_row,
          message: row.message || '',
          incoming: {
            balances: incomingBalances,
            source: parseJson(row.raw_json, {})
          },
          existing: existingBalancesJson ? {
            balances: existingBalances,
            source: parseJson(row.existing_raw_json || row.comparison_raw_json, {})
          } : null,
          existingSource: existingBalancesJson ? {
            sourceFile: row.existing_source_file || row.comparison_source_file || '',
            sheetName: row.existing_sheet_name || row.comparison_sheet_name || '',
            sourceRow: row.existing_source_row || row.comparison_source_row || null,
            importRecordId: row.existing_import_record_id || row.comparison_import_record_id || null,
            importedAt: row.existing_imported_at || row.comparison_imported_at || null
          } : null,
          diffFields: existingBalancesJson
            ? SUPPORTED_CURRENCIES.filter((currency) => incomingBalances[currency] !== existingBalances[currency])
            : []
        };
      });
      return { summary, errors, rows, total, page: safePage, pageSize: safePageSize };
    }

    const dispositions = tab === 'skips'
      ? ['idempotent_skip']
      : (tab === 'conflicts'
        ? ['idempotent_conflict']
        : ['invalid_key', 'format_error', 'rolled_back']);
    const conditions = [
      'i.import_record_id = ?',
      `i.disposition IN (${dispositions.map(() => '?').join(', ')})`
    ];
    const params = [id, ...dispositions];
    if (String(key).trim()) {
      conditions.push('i.idempotency_key LIKE ?');
      params.push(`%${String(key).trim()}%`);
    }
    if (String(fileName).trim()) {
      conditions.push('i.source_file LIKE ?');
      params.push(`%${String(fileName).trim()}%`);
    }
    const where = conditions.join(' AND ');
    const total = Number(database.db.prepare(`
      SELECT COUNT(*) AS row_count FROM vcc_fin_op_import_rows i WHERE ${where}
    `).get(...params).row_count) || 0;
    const rows = database.db.prepare(`
      SELECT i.*,
             COALESCE(e.raw_json, i.existing_raw_json_snapshot) AS existing_raw_json,
             COALESCE(e.raw_contract_version, i.existing_raw_contract_version_snapshot) AS existing_raw_contract_version,
             COALESCE(e.subject, i.existing_subject_snapshot) AS existing_subject,
             COALESCE(e.source_file, i.existing_source_file_snapshot) AS existing_source_file,
             COALESCE(e.sheet_name, i.existing_sheet_name_snapshot) AS existing_sheet_name,
             COALESCE(e.source_row, i.existing_source_row_snapshot) AS existing_source_row,
             COALESCE(e.import_record_id, i.existing_import_record_id_snapshot) AS existing_import_record_id,
             COALESCE(e.first_imported_at, i.existing_imported_at_snapshot) AS existing_imported_at,
             c.raw_json AS comparison_raw_json,
             c.raw_contract_version AS comparison_raw_contract_version,
             c.subject AS comparison_subject,
             c.source_file AS comparison_source_file,
             c.sheet_name AS comparison_sheet_name,
             c.source_row AS comparison_source_row,
             c.import_record_id AS comparison_import_record_id,
             c.created_at AS comparison_created_at
      FROM vcc_fin_op_import_rows i
      LEFT JOIN vcc_fin_op_effective_rows e ON e.id = i.existing_effective_id
      LEFT JOIN vcc_fin_op_import_rows c ON c.id = i.comparison_import_row_id
      WHERE ${where}
      ORDER BY i.id
      LIMIT ? OFFSET ?
    `).all(...params, safePageSize, offset).map(importRowShape);

    return {
      summary,
      errors,
      rows,
      total,
      page: safePage,
      pageSize: safePageSize
    };
  }

  function resolveRecord({ recordId, note, action }, batchContext) {
    freezeWorkerBatchContext(batchContext, { required: true });
    return runDirectTask('resolve-import-record', () => (
      detailRecordShape(repository.resolveImportRecord(database.db, Number(recordId), {
        note,
        action
      }))
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

  async function exportRun({ targetMonth, outputDirectory, outputPath }, batchContext) {
    freezeWorkerBatchContext(batchContext, { required: true });
    return runDirectTask('export-result', async () => {
      // 对话框确认与真正写文件之间可能发生解归档，因此必须在拿到全局租约后重查。
      const target = await getArchivedRunByMonth(targetMonth);
      return writeRunWorkbooksFn({
        db: database.db,
        runId: target.runId,
        outputDirectory,
        outputPath,
        assetsDir
      });
    });
  }

  async function exportImportAudit(payload, batchContext) {
    freezeWorkerBatchContext(batchContext, { required: true });
    return runDirectTask('export-import-audit', () => (
      writeImportAuditWorkbookFn({
        db: database.db,
        recordId: Number(payload.recordId),
        tab: payload.tab,
        outputPath: payload.outputPath,
        key: payload.key,
        fileName: payload.fileName
      })
    ));
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
    getImportRecordDetail,
    resolveRecord,
    dataManagerOverview,
    latestArchivedRun,
    exportRun,
    exportImportAudit,
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
