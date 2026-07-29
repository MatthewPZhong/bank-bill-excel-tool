'use strict';

const { AsyncLocalStorage } = require('node:async_hooks');
const path = require('node:path');

const { sourceSnapshotForPath } = require('./source-snapshot');

const MODULES = Object.freeze({
  statement: Object.freeze({ id: 'statement-generator', code: 'STATEMENT', name: '网银账单生成' }),
  newAccount: Object.freeze({ id: 'new-account-generator', code: 'NEWACCOUNT', name: '新开账户余额账单生成' }),
  pending: Object.freeze({ id: 'pending-reconciliation', code: 'PENDING', name: '月度Pending数据核对' }),
  bankStatement: Object.freeze({ id: 'bank-statement-process', code: 'FUNDRECON', name: '资金对账数据处理' }),
  reconIdFix: Object.freeze({ id: 'recon-id-fix', code: 'RECONFIX', name: '对账单修复' }),
  bankBu: Object.freeze({ id: 'bank-bu-recon', code: 'BANKBU', name: '月度银行对账单BU回填校验' }),
  bizOp: Object.freeze({ id: 'biz-op-recon', code: 'BIZOP', name: '业务OP数据核对' }),
  acquiring: Object.freeze({ id: 'acquiring-bill-currency', code: 'ACQUIRING', name: '收单单据币种校验' }),
  vcc: Object.freeze({ id: 'vcc-op-calc', code: 'VCCOP', name: 'VCC业务OP计算' }),
  preFund: Object.freeze({ id: 'pre-fund-reconciliation', code: 'PREFUND', name: '前置资金对账' }),
  duplicateInbound: Object.freeze({ id: 'duplicate-inbound-match', code: 'DUPINBOUND', name: '重复入金匹配' }),
  position: Object.freeze({ id: 'position-reconciliation-process', code: 'POSITION', name: '平盘对账数据处理' }),
  positionLink: Object.freeze({ id: 'position-reconciliation-process', code: 'POSITIONLINK', name: '平盘对账数据处理' }),
  linkedTable: Object.freeze({ id: 'bank-statement-process', code: 'LINKED', name: '资金对账数据处理' }),
  preFundTemp: Object.freeze({ id: 'pre-fund-reconciliation', code: 'PREFUNDTEMP', name: '前置资金对账' })
});

const SUCCESS_STATUSES = new Set(['ok', 'success']);

const ARCHIVE_CHANNELS = new Set([
  'file:import',
  'file:complete-big-account-selection',
  'file:save-balance-seed',
  'monthly-balance:assemble',
  'new-account:generate',
  'linked-table:import',
  'bank-statement:import',
  'gateway-recon:import',
  'bank-statement:batch-import',
  'bank-statement:run',
  'bank-statement:export',
  'recon-id-fix:import',
  'recon-id-fix:run',
  'recon-id-fix:export',
  'pending:import:start',
  'pending:removed:import',
  'pending:reconcile:run',
  'pending:diff:export-single',
  'bankBuRecon:import:run',
  'bankBuRecon:run',
  'bankBuRecon:export:single',
  'bizOpRecon:import:run-biz-op',
  'bizOpRecon:import:run-flow',
  'bizOpRecon:run',
  'bizOpRecon:export:date',
  'vccOpCalc:import:scan',
  'vccOpCalc:run:save',
  'acquiringBillCurrency:importFlow',
  'acquiringBillCurrency:importBill',
  'acquiringBillCurrency:run',
  'acquiringBillCurrency:run:resume',
  'pre-fund-reconciliation:import-bank',
  'pre-fund-reconciliation:import-mpt',
  'pre-fund-reconciliation:mpt-errors:repair',
  'pre-fund-reconciliation:run',
  'pre-fund-reconciliation:export',
  'duplicate-inbound-match:import-files',
  'duplicate-inbound-match:run',
  'duplicate-inbound-match:export',
  'position-reconciliation:bank:apply-import',
  'position-reconciliation:source:prepare-import',
  'position-reconciliation:source:apply-import',
  'position-reconciliation:bank:export',
  'position-reconciliation:linked:export',
  'position-reconciliation:raw:export',
  'position-reconciliation:run:export',
  'position-reconciliation:run:import-result'
]);

function normalizePathList(values) {
  const source = Array.isArray(values) ? values : (values ? [values] : []);
  const seen = new Set();
  const normalized = [];
  for (const value of source) {
    const filePath = String(value || '').trim();
    if (!filePath || seen.has(filePath)) continue;
    seen.add(filePath);
    normalized.push(filePath);
  }
  return normalized;
}

function resultStatus(result) {
  return result && typeof result === 'object' ? String(result.status || '') : '';
}

function isSuccessful(result) {
  return SUCCESS_STATUSES.has(resultStatus(result));
}

function firstPayload(args) {
  return Array.isArray(args) && args[0] && typeof args[0] === 'object' ? args[0] : {};
}

function pathsFromPayload(payload) {
  if (!payload || typeof payload !== 'object') return [];
  return normalizePathList([
    ...(Array.isArray(payload.files) ? payload.files : []),
    ...(Array.isArray(payload.filePaths) ? payload.filePaths : []),
    payload.filePath,
    payload.pendingPath,
    payload.bankPath
  ]);
}

function pathsFromResultKeys(result, keys) {
  if (!result || typeof result !== 'object') return [];
  const paths = [];
  for (const key of keys) {
    const value = result[key];
    if (typeof value === 'string') paths.push(value);
  }
  return normalizePathList(paths);
}

function outputPathsFromFiles(result) {
  if (!result || !Array.isArray(result.files)) return [];
  return normalizePathList(result.files.map((item) => item && (item.filePath || item.savedPath || item.path)));
}

function buildFileSpecs(values, role, sourceOperation) {
  const source = Array.isArray(values) ? values : (values ? [values] : []);
  const seen = new Set();
  const files = [];
  for (const value of source) {
    const descriptor = value && typeof value === 'object' && !Array.isArray(value)
      ? value
      : { filePath: value };
    const filePath = String(descriptor.filePath || '').trim();
    if (!filePath || seen.has(filePath)) continue;
    seen.add(filePath);
    files.push({
      ...descriptor,
      filePath,
      role: descriptor.role || role,
      sourceOperation: descriptor.sourceOperation || sourceOperation,
      originalName: descriptor.originalName || path.basename(filePath)
    });
  }
  return files;
}

function dedupeFileSpecs(files) {
  const seen = new Set();
  return (Array.isArray(files) ? files : []).filter((item) => {
    const key = `${item && item.role || ''}\u0000${item && item.filePath || ''}`;
    if (!item || !item.filePath || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function summarizeBatchResults(batches) {
  const failed = (Array.isArray(batches) ? batches : []).filter(
    (batch) => batch && batch.archiveFailed === true
  );
  return {
    archiveFailed: failed.length > 0,
    persistentRetryAvailable: failed.every(
      (batch) => batch.persistentRetryAvailable === true
    ),
    warning: failed.length > 0
      ? { message: `${failed.length} 个存档批次存在失败文件，可在存档中心重试` }
      : null
  };
}

function operationKeyPart(value, fallback = 'current') {
  const text = String(value == null ? '' : value).trim();
  return text || fallback;
}

function mapSelectionsToResults(selectedPaths, results) {
  const paths = normalizePathList(selectedPaths);
  const rows = Array.isArray(results) ? results : [];
  if (paths.length === rows.length) {
    return rows.map((row, index) => ({ row: row || {}, filePath: paths[index] }));
  }

  const unused = paths.slice();
  return rows.map((row) => {
    const fileName = String(row && row.fileName || '');
    const index = unused.findIndex((filePath) => path.basename(filePath) === fileName);
    return {
      row: row || {},
      filePath: index >= 0 ? unused.splice(index, 1)[0] : ''
    };
  });
}

function selectSuccessfulPathsByResultIndex(sourcePaths, results) {
  const paths = Array.isArray(sourcePaths) ? sourcePaths : [];
  const rows = Array.isArray(results) ? results : [];
  return paths.filter((filePath, index) => (
    typeof filePath === 'string'
    && filePath.trim()
    && rows[index]
    && rows[index].status === 'ok'
  ));
}

function createArchiveOperationTracker({ sink, onWarning = null } = {}) {
  if (!sink || typeof sink.createBatch !== 'function' || typeof sink.appendFiles !== 'function') {
    throw new Error('archive operation tracker 需要 createBatch/appendFiles sink');
  }

  const pendingInputs = new Map();
  const activeBatches = new Map();
  const attachedPaths = new Map();
  const finalizedOutputBatches = new Set();
  const sourceSnapshotContext = new AsyncLocalStorage();

  function attachSourceSnapshots(files) {
    const snapshots = sourceSnapshotContext.getStore();
    return (Array.isArray(files) ? files : []).map((file) => {
      if (!file || file.sourceSnapshot) return file;
      const sourceSnapshot = sourceSnapshotForPath(snapshots, file.filePath);
      return sourceSnapshot ? { ...file, sourceSnapshot } : file;
    });
  }

  function fileIdentity(file) {
    return `${file && file.role || ''}\u0000${file && file.filePath || ''}`;
  }

  function pendingKey(module, scopeKey) {
    return `${module.id}:${operationKeyPart(scopeKey)}`;
  }

  function activeKey(module, runKey) {
    return `${module.id}:${module.code}:${operationKeyPart(runKey, 'latest')}`;
  }

  function setPendingSlot(module, scopeKey, slot, paths, sourceOperation) {
    const key = pendingKey(module, scopeKey);
    const slots = pendingInputs.get(key) || new Map();
    slots.set(slot, attachSourceSnapshots(buildFileSpecs(paths, 'input', sourceOperation)));
    pendingInputs.set(key, slots);
  }

  function deletePendingSlot(module, scopeKey, slot) {
    const key = pendingKey(module, scopeKey);
    const slots = pendingInputs.get(key);
    if (!slots) return;
    slots.delete(slot);
    if (slots.size === 0) pendingInputs.delete(key);
  }

  function collectPending(module, scopeKeys) {
    const files = [];
    for (const scopeKey of scopeKeys) {
      const slots = pendingInputs.get(pendingKey(module, scopeKey));
      if (!slots) continue;
      for (const slotFiles of slots.values()) files.push(...slotFiles);
    }
    return files;
  }

  function rememberBatch(module, batchId, runKeys = []) {
    activeBatches.set(activeKey(module, 'latest'), batchId);
    for (const runKey of runKeys) {
      if (runKey !== undefined && runKey !== null && String(runKey).trim() !== '') {
        activeBatches.set(activeKey(module, runKey), batchId);
      }
    }
  }

  function batchIdFromResult(created) {
    if (!created || typeof created !== 'object') return null;
    return created.batchId || created.id || created.batch?.batchId || created.batch?.id || null;
  }

  async function createBatch(module, {
    operation,
    files = [],
    runKeys = [],
    metadata = {},
    keepOutputOpen = false,
    rememberActive = true
  } = {}) {
    const uniqueFiles = attachSourceSnapshots(dedupeFileSpecs(files));
    const created = await sink.createBatch({
      moduleId: module.id,
      moduleCode: module.code,
      moduleName: module.name,
      sourceOperation: operation,
      files: uniqueFiles,
      metadata
    });
    const batchId = batchIdFromResult(created);
    if (!batchId) {
      return {
        batchId: null,
        created,
        archiveFailed: true,
        persistentRetryAvailable: created && created.persistentRetryAvailable === true,
        warning: created && created.warning
          ? created.warning
          : { message: `存档服务未返回批次 ID：${operation}` }
      };
    }
    if (rememberActive) rememberBatch(module, batchId, runKeys);
    attachedPaths.set(String(batchId), new Set(uniqueFiles.map(fileIdentity)));
    if (!keepOutputOpen && uniqueFiles.some((item) => item.role === 'output')) {
      finalizedOutputBatches.add(String(batchId));
    }
    return {
      batchId,
      created,
      archiveFailed: created.archiveFailed === true,
      persistentRetryAvailable: created.archiveFailed === true
        ? created.persistentRetryAvailable === true
        : true,
      warning: created.warning || null
    };
  }

  async function appendToBatch(module, {
    operation,
    files,
    runKey,
    metadata = {},
    keepOutputOpen = false
  } = {}) {
    const normalizedFiles = attachSourceSnapshots(dedupeFileSpecs(files));
    const hasExplicitRunKey = runKey !== undefined
      && runKey !== null
      && String(runKey).trim() !== '';
    const batchId = hasExplicitRunKey
      ? activeBatches.get(activeKey(module, runKey))
      : activeBatches.get(activeKey(module, 'latest'));
    if (!batchId) {
      return { handled: false, excluded: 'no-active-batch' };
    }

    const containsOutput = normalizedFiles.some((item) => item.role === 'output');
    if (containsOutput && finalizedOutputBatches.has(String(batchId))) {
      return { batchId, skippedDuplicateOutput: true };
    }

    const seen = attachedPaths.get(String(batchId)) || new Set();
    const fresh = normalizedFiles.filter((item) => item.filePath && !seen.has(fileIdentity(item)));
    if (fresh.length === 0) return { batchId, skippedDuplicate: true };
    const appended = await sink.appendFiles({ batchId, files: fresh, sourceOperation: operation, metadata });
    for (const item of fresh) seen.add(fileIdentity(item));
    attachedPaths.set(String(batchId), seen);
    if (containsOutput && !keepOutputOpen) finalizedOutputBatches.add(String(batchId));
    return {
      batchId,
      appended,
      archiveFailed: appended && appended.archiveFailed === true,
      persistentRetryAvailable: appended && appended.archiveFailed === true
        ? appended.persistentRetryAvailable === true
        : true,
      warning: appended && appended.warning ? appended.warning : null
    };
  }

  async function archiveImmediate(
    module,
    operation,
    inputPaths,
    outputPaths,
    metadata = {},
    runKeys = [],
    options = {}
  ) {
    const files = [
      ...buildFileSpecs(inputPaths, 'input', operation),
      ...buildFileSpecs(outputPaths, 'output', operation)
    ];
    if (files.length === 0) return { handled: false };
    const created = await createBatch(module, {
      operation,
      files,
      metadata,
      runKeys,
      keepOutputOpen: options.keepOutputOpen === true,
      rememberActive: options.rememberActive !== false
    });
    return { handled: true, ...created };
  }

  async function archiveRun(module, operation, scopeKeys, result, runtime = {}, pendingModule = module) {
    const runKey = runtime.runKey || result.runId || result.mirrorId || result.id;
    const inputFiles = collectPending(pendingModule, scopeKeys);
    const outputFiles = buildFileSpecs(runtime.outputPaths || [], 'output', operation);
    if (inputFiles.length === 0 && outputFiles.length === 0) {
      return { handled: false, excluded: 'no-current-session-files' };
    }
    const created = await createBatch(module, {
      operation,
      files: [...inputFiles, ...outputFiles],
      runKeys: [runKey],
      metadata: runtime.metadata || {}
    });
    return { handled: true, ...created };
  }

  async function handleCore({ channel, args = [], result, selectedPaths = [], runtime = {} }) {
    const payload = firstPayload(args);
    const selected = normalizePathList(runtime.inputPaths || selectedPaths);

    if (channel === 'file:import'
        || channel === 'file:complete-big-account-selection'
        || channel === 'file:save-balance-seed') {
      const generated = isSuccessful(result) || Boolean(result && (result.detailReady || result.balanceReady));
      if (!generated || runtime.skipArchive === true) return { handled: false, skipped: runtime.skipArchive === true };
      if (channel === 'file:save-balance-seed') {
        const files = buildFileSpecs(runtime.outputPaths || [], 'output', channel);
        const existingBatchId = activeBatches.get(activeKey(MODULES.statement, 'latest'));
        if (existingBatchId) {
          return appendToBatch(MODULES.statement, {
            operation: channel,
            files,
            keepOutputOpen: result.balanceReady !== true
          });
        }
      }
      return archiveImmediate(
        MODULES.statement,
        channel,
        runtime.inputPaths || selected,
        runtime.outputPaths || [],
        { templateIds: runtime.templateIds || [], templateNames: runtime.templateNames || [] },
        [],
        { keepOutputOpen: result.balanceReady !== true }
      );
    }

    if (channel === 'monthly-balance:assemble') {
      if (resultStatus(result) !== 'ready' || runtime.skipArchive === true) return { handled: false };
      return archiveImmediate(
        MODULES.statement,
        channel,
        [],
        runtime.outputPaths || [],
        runtime.metadata || {},
        [],
        { rememberActive: false }
      );
    }

    if (channel === 'new-account:generate') {
      if (!isSuccessful(result)) return { handled: false };
      return archiveImmediate(MODULES.newAccount, channel, [], runtime.outputPaths || [], runtime.metadata || {});
    }

    if (channel === 'linked-table:import') {
      if (!isSuccessful(result)) return { handled: false };
      const pairs = mapSelectionsToResults(selected, result.results);
      const successful = pairs.filter(({ row, filePath }) => filePath && row.status === 'ok');
      const batches = [];
      for (const item of successful) {
        batches.push(await archiveImmediate(
          MODULES.linkedTable,
          channel,
          [item.filePath],
          [],
          { tableKey: item.row.tableKey || '', rowCount: item.row.rowCount || 0 }
        ));
      }
      return { handled: batches.length > 0, batches, ...summarizeBatchResults(batches) };
    }

    if (channel === 'bank-statement:import' || channel === 'gateway-recon:import') {
      if (!isSuccessful(result)) return { handled: false };
      setPendingSlot(MODULES.bankStatement, 'current', channel === 'gateway-recon:import' ? 'gateway' : 'bank', selected, channel);
      if (channel === 'bank-statement:import') deletePendingSlot(MODULES.bankStatement, 'current', 'refund');
      return { handled: true, staged: true };
    }

    if (channel === 'bank-statement:batch-import') {
      if (!isSuccessful(result)) return { handled: false };
      const pairs = mapSelectionsToResults(selected, result.results);
      const bankPaths = [];
      const refundPaths = [];
      const linkedItems = [];
      for (const { row, filePath } of pairs) {
        if (!filePath || row.status !== 'ok') continue;
        if (row.tableKey === 'bank-statement' && row.outcome === 'processed') bankPaths.push(filePath);
        if (row.tableKey === 'zhongtai-refund-order' && row.outcome === 'processed') refundPaths.push(filePath);
        if (row.outcome === 'linked' || (row.tableKey === 'bank-statement' && row.alsoLinked && !row.alsoLinked.error)) {
          linkedItems.push({ row, filePath });
        }
      }
      if (bankPaths.length > 0) {
        setPendingSlot(MODULES.bankStatement, 'current', 'bank', bankPaths, channel);
        if (refundPaths.length === 0) deletePendingSlot(MODULES.bankStatement, 'current', 'refund');
      }
      if (refundPaths.length > 0) setPendingSlot(MODULES.bankStatement, 'current', 'refund', refundPaths, channel);
      const linkedBatches = [];
      for (const item of linkedItems) {
        linkedBatches.push(await archiveImmediate(
          MODULES.linkedTable,
          channel,
          [item.filePath],
          [],
          { tableKey: item.row.tableKey || '', rowCount: item.row.rowCount || 0 }
        ));
      }
      return {
        handled: bankPaths.length > 0 || refundPaths.length > 0 || linkedBatches.length > 0,
        staged: true,
        linkedBatches,
        ...summarizeBatchResults(linkedBatches)
      };
    }

    if (channel === 'bank-statement:run') {
      if (!isSuccessful(result)) return { handled: false };
      return archiveRun(MODULES.bankStatement, channel, ['current'], result, runtime);
    }

    if (channel === 'bank-statement:export') {
      if (!isSuccessful(result)) return { handled: false };
      const outputPaths = runtime.outputPaths || pathsFromResultKeys(result, [
        'mainFilePath', 'hitRowsReportPath', 'platformCleanupPath', 'refundBackfillPath'
      ]);
      return appendToBatch(MODULES.bankStatement, {
        operation: channel,
        files: buildFileSpecs(outputPaths, 'output', channel),
        runKey: runtime.runKey
      });
    }

    if (channel === 'recon-id-fix:import') {
      if (!isSuccessful(result)) return { handled: false };
      setPendingSlot(MODULES.reconIdFix, 'current', 'main', selected, channel);
      return { handled: true, staged: true };
    }
    if (channel === 'recon-id-fix:run') {
      if (!isSuccessful(result)) return { handled: false };
      const module = runtime.originModuleId === MODULES.bankStatement.id
        ? MODULES.bankStatement
        : MODULES.reconIdFix;
      return archiveRun(module, channel, ['current'], result, runtime, MODULES.reconIdFix);
    }
    if (channel === 'recon-id-fix:export') {
      if (!isSuccessful(result)) return { handled: false };
      const module = runtime.originModuleId === MODULES.bankStatement.id
        ? MODULES.bankStatement
        : MODULES.reconIdFix;
      const outputPaths = runtime.outputPaths || pathsFromResultKeys(result, ['mainFilePath', 'unmatchedFilePath']);
      return appendToBatch(module, {
        operation: channel,
        files: buildFileSpecs(outputPaths, 'output', channel),
        runKey: runtime.runKey
      });
    }

    if (channel === 'pending:import:start' || channel === 'pending:removed:import') {
      if (!isSuccessful(result)) return { handled: false };
      const yearMonth = operationKeyPart(payload.yearMonth);
      const slot = channel === 'pending:removed:import' ? 'removed' : 'main';
      setPendingSlot(MODULES.pending, yearMonth, slot, pathsFromPayload(payload), channel);
      return { handled: true, staged: true };
    }
    if (channel === 'pending:reconcile:run') {
      if (!isSuccessful(result)) return { handled: false };
      return archiveRun(
        MODULES.pending,
        channel,
        [payload.upperMonth, payload.lowerMonth].filter(Boolean),
        result,
        runtime
      );
    }
    if (channel === 'pending:diff:export-aggregate') return { handled: false, excluded: true };
    if (channel === 'pending:diff:export-single') {
      if (!isSuccessful(result)) return { handled: false };
      const outputPaths = runtime.outputPaths || pathsFromResultKeys(result, ['filePath', 'savedPath']);
      const runKey = channel.endsWith('single') ? payload.runId : runtime.runKey;
      return appendToBatch(MODULES.pending, {
        operation: channel,
        files: buildFileSpecs(outputPaths, 'output', channel),
        runKey,
        metadata: runtime.metadata || {}
      });
    }

    if (channel === 'bankBuRecon:import:run') {
      if (!isSuccessful(result)) return { handled: false };
      setPendingSlot(MODULES.bankBu, payload.yearMonth, 'main', pathsFromPayload(payload), channel);
      return { handled: true, staged: true };
    }
    if (channel === 'bankBuRecon:run') {
      if (!isSuccessful(result)) return { handled: false };
      return archiveRun(MODULES.bankBu, channel, [payload.yearMonth], result, runtime);
    }
    if (channel === 'bankBuRecon:export:aggregate') return { handled: false, excluded: true };
    if (channel === 'bankBuRecon:export:single') {
      if (!isSuccessful(result)) return { handled: false };
      return appendToBatch(MODULES.bankBu, {
        operation: channel,
        files: buildFileSpecs(runtime.outputPaths || pathsFromResultKeys(result, ['filePath']), 'output', channel),
        runKey: channel.endsWith('single') ? payload.runId : runtime.runKey
      });
    }

    if (channel === 'bizOpRecon:import:run-biz-op' || channel === 'bizOpRecon:import:run-flow') {
      if (!isSuccessful(result)) return { handled: false };
      const slot = channel.endsWith('biz-op') ? 'biz-op' : 'flow';
      setPendingSlot(MODULES.bizOp, payload.date, slot, pathsFromPayload(payload), channel);
      return { handled: true, staged: true };
    }
    if (channel === 'bizOpRecon:run') {
      if (!isSuccessful(result)) return { handled: false };
      return archiveRun(MODULES.bizOp, channel, [payload.date], result, runtime);
    }
    if (channel === 'bizOpRecon:export:date-range') return { handled: false, excluded: true };
    if (channel === 'bizOpRecon:export:date') {
      if (!isSuccessful(result)) return { handled: false };
      return appendToBatch(MODULES.bizOp, {
        operation: channel,
        files: buildFileSpecs(runtime.outputPaths || pathsFromResultKeys(result, ['filePath']), 'output', channel),
        runKey: channel.endsWith(':date') ? payload.runId : runtime.runKey
      });
    }

    if (channel === 'vccOpCalc:import:scan') {
      if (!isSuccessful(result)) return { handled: false };
      setPendingSlot(MODULES.vcc, 'current', 'flow', pathsFromPayload(payload), channel);
      return { handled: true, staged: true };
    }
    if (channel === 'vccOpCalc:run:save') {
      if (!isSuccessful(result)) return { handled: false };
      return archiveRun(MODULES.vcc, channel, ['current'], result, runtime);
    }

    if (channel === 'acquiringBillCurrency:importFlow' || channel === 'acquiringBillCurrency:importBill') {
      if (!isSuccessful(result)) return { handled: false };
      const slot = channel.endsWith('importFlow') ? 'flow' : 'bill';
      setPendingSlot(MODULES.acquiring, payload.monthKey, slot, selected.length ? selected : pathsFromPayload(payload), channel);
      return { handled: true, staged: true };
    }
    if (channel === 'acquiringBillCurrency:run' || channel === 'acquiringBillCurrency:run:resume') {
      if (!isSuccessful(result)) return { handled: false };
      const outputPaths = runtime.outputPaths || pathsFromResultKeys(result, ['diffFilePath', 'reportFilePath']);
      return archiveRun(MODULES.acquiring, channel, [payload.monthKey], result, { ...runtime, outputPaths });
    }

    if (channel === 'pre-fund-reconciliation:import-bank') {
      if (!isSuccessful(result)) return { handled: false };
      setPendingSlot(MODULES.preFund, 'current', 'bank', selected, channel);
      return { handled: true, staged: true };
    }
    if (channel === 'pre-fund-reconciliation:import-mpt') {
      if (!isSuccessful(result)) return { handled: false };
      const pairs = mapSelectionsToResults(selected, result.results);
      const successfulPaths = pairs
        .filter(({ row, filePath }) => filePath && row.status === 'ok')
        .map(({ filePath }) => filePath);
      return archiveImmediate(MODULES.preFundTemp, channel, successfulPaths, [], runtime.metadata || {});
    }
    if (channel === 'pre-fund-reconciliation:mpt-errors:repair') {
      if (!isSuccessful(result)) return { handled: false };
      return archiveImmediate(
        MODULES.preFundTemp,
        channel,
        runtime.inputPaths || [],
        [],
        runtime.metadata || {}
      );
    }
    if (channel === 'pre-fund-reconciliation:run') {
      if (!isSuccessful(result)) return { handled: false };
      return archiveRun(MODULES.preFund, channel, ['current'], result, runtime);
    }
    if (channel === 'pre-fund-reconciliation:export') {
      if (!isSuccessful(result)) return { handled: false };
      const outputPaths = runtime.outputPaths || outputPathsFromFiles(result);
      return appendToBatch(MODULES.preFund, {
        operation: channel,
        files: buildFileSpecs(outputPaths, 'output', channel),
        runKey: runtime.runKey
      });
    }

    if (channel === 'duplicate-inbound-match:import-files') {
      if (!isSuccessful(result)) return { handled: false };
      setPendingSlot(MODULES.duplicateInbound, 'current', 'main', selected, channel);
      return { handled: true, staged: true };
    }
    if (channel === 'duplicate-inbound-match:run') {
      if (!isSuccessful(result)) return { handled: false };
      return archiveRun(MODULES.duplicateInbound, channel, ['current'], result, runtime);
    }
    if (channel === 'duplicate-inbound-match:export') {
      if (!isSuccessful(result)) return { handled: false };
      const outputPaths = runtime.outputPaths || pathsFromResultKeys(result, ['filePath', 'savePath']);
      return appendToBatch(MODULES.duplicateInbound, {
        operation: channel,
        files: buildFileSpecs(outputPaths, 'output', channel),
        runKey: runtime.runKey
      });
    }

    if (channel === 'position-reconciliation:bank:apply-import') {
      if (!isSuccessful(result)) return { handled: false };
      return archiveImmediate(
        MODULES.position,
        channel,
        runtime.inputFiles && runtime.inputFiles.length > 0
          ? runtime.inputFiles
          : (runtime.inputPaths || []),
        [],
        runtime.metadata || {}
      );
    }
    if (channel === 'position-reconciliation:source:prepare-import') {
      if (!isSuccessful(result)) return { handled: false };
      return archiveImmediate(
        MODULES.positionLink,
        channel,
        runtime.inputFiles && runtime.inputFiles.length > 0
          ? runtime.inputFiles
          : (runtime.inputPaths || []),
        [],
        runtime.metadata || {}
      );
    }
    if (channel === 'position-reconciliation:source:apply-import') {
      if (!isSuccessful(result)) return { handled: false };
      return archiveImmediate(
        MODULES.positionLink,
        channel,
        runtime.inputFiles && runtime.inputFiles.length > 0
          ? runtime.inputFiles
          : (runtime.inputPaths || []),
        [],
        runtime.metadata || {}
      );
    }
    if (channel === 'position-reconciliation:run:export') {
      if (!isSuccessful(result)) return { handled: false };
      return archiveImmediate(
        MODULES.position,
        channel,
        [],
        runtime.outputPaths || [],
        { ...(runtime.metadata || {}), runKey: runtime.runKey }
      );
    }
    if (channel === 'position-reconciliation:run:import-result') {
      if (!isSuccessful(result)) return { handled: false };
      return archiveImmediate(
        MODULES.position,
        channel,
        runtime.inputFiles && runtime.inputFiles.length > 0
          ? runtime.inputFiles
          : (runtime.inputPaths || []),
        [],
        { ...(runtime.metadata || {}), runKey: runtime.runKey }
      );
    }
    if (channel === 'position-reconciliation:bank:export') {
      if (!isSuccessful(result)) return { handled: false };
      return archiveImmediate(
        MODULES.position,
        channel,
        [],
        runtime.outputPaths || [],
        runtime.metadata || {}
      );
    }
    if (channel === 'position-reconciliation:linked:export'
        || channel === 'position-reconciliation:raw:export') {
      if (!isSuccessful(result)) return { handled: false };
      return archiveImmediate(
        MODULES.positionLink,
        channel,
        [],
        runtime.outputPaths || [],
        runtime.metadata || {}
      );
    }

    return { handled: false };
  }

  async function handleOperation(operation) {
    try {
      const normalizedOperation = operation || {};
      return await sourceSnapshotContext.run(
        normalizedOperation.runtime && normalizedOperation.runtime.sourceSnapshots,
        () => handleCore(normalizedOperation)
      );
    } catch (error) {
      const warning = {
        channel: operation && operation.channel ? String(operation.channel) : '',
        message: error && error.message ? error.message : String(error)
      };
      if (typeof onWarning === 'function') {
        try { onWarning(warning); } catch (_error) { /* 存档告警不得影响业务 */ }
      }
      return {
        handled: true,
        archiveFailed: true,
        persistentRetryAvailable: false,
        warning
      };
    }
  }

  return {
    handleOperation,
    supportsChannel(channel) {
      return ARCHIVE_CHANNELS.has(String(channel || ''));
    },
    getPendingSnapshot() {
      return new Map(Array.from(pendingInputs, ([key, slots]) => [key, new Map(slots)]));
    },
    getActiveBatch(moduleId, runKey = 'latest') {
      const module = Object.values(MODULES).find((item) => item.id === moduleId);
      if (!module) return null;
      return activeBatches.get(activeKey(module, runKey)) || null;
    }
  };
}

module.exports = {
  MODULES,
  createArchiveOperationTracker,
  normalizePathList,
  mapSelectionsToResults,
  selectSuccessfulPathsByResultIndex
};
