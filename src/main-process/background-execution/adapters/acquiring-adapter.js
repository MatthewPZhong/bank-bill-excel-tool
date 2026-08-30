'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const {
  createBigTableImportMatureBinding,
  dispatchEngineImportHandle
} = require('../../big-table-import-dispatch');
const runData = require('../../acquiring-bill-currency-run-data');
const runCheckWorkerPool = require('../../run-check-worker-pool');
const runDataStore = require('../../../backend/run-data-store');
const {
  shouldFallbackToSingleWorker
} = require('../../acquiring-bill-currency-session');
const {
  WORKER_BATCH_CONTEXT_FIELDS,
  freezeWorkerBatchContext
} = require('../../archive-center/worker-batch-context');
const {
  WORKER_OPERATION_CONTEXT_FIELDS,
  freezeWorkerOperationContext
} = require('../../archive-center/worker-operation-context');
const {
  ACQUIRING_ADAPTER_ACTIONS
} = require('../acquiring-adapter-policies');

const FLOW_CONTRACT_PATH = require.resolve(
  '../../../backend/acquiring-bill-currency-import/contract-flow'
);
const BILL_CONTRACT_PATH = require.resolve(
  '../../../backend/acquiring-bill-currency-import/contract-bill'
);
const MAX_IMPORT_CHILDREN = 4;
const MAX_RUN_CHILDREN = 8;
const DEFAULT_CHUNK_SIZE = 100000;

const AUTHORITY_OVERRIDE_FIELDS = Object.freeze([
  '__dbPath',
  '__forceMultiWorkerForTest',
  'contractModulePath',
  'contractOptions',
  'dbPath',
  'dispatchCallbacks',
  'dispatchFn',
  'mainDb',
  'resourceLimits',
  'resumePlan',
  'userDataDir',
  'WorkerClass'
]);

function adapterError(code, message, cause) {
  const error = new TypeError(message);
  error.code = code;
  if (cause !== undefined) error.cause = cause;
  return error;
}

function assertNoAuthorityOverrides(input) {
  const field = AUTHORITY_OVERRIDE_FIELDS.find((candidate) => Object.hasOwn(input, candidate));
  if (field) {
    throw adapterError(
      'ACQUIRING_ADAPTER_AUTHORITY_OVERRIDE_FORBIDDEN',
      `Acquiring mature adapter 不接受 caller authority override：${field}`
    );
  }
}

function requireUserDataDir(value) {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized) {
    throw adapterError(
      'ACQUIRING_ADAPTER_USER_DATA_AUTHORITY_UNAVAILABLE',
      'Acquiring mature adapter 缺少 Main userData authority'
    );
  }
  return path.resolve(normalized);
}

function validateMonthKey(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}$/.test(value)) {
    throw adapterError('ACQUIRING_ADAPTER_MONTH_INVALID', 'monthKey 格式必须为 YYYY-MM');
  }
  return value;
}

function validateImportInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw adapterError('ACQUIRING_IMPORT_INPUT_INVALID', 'Acquiring import input 必须是对象');
  }
  assertNoAuthorityOverrides(input);
  if (!['flow', 'bill'].includes(input.kind)) {
    throw adapterError('ACQUIRING_IMPORT_KIND_INVALID', 'Acquiring import kind 必须为 flow 或 bill');
  }
  validateMonthKey(input.monthKey);
  if (!Array.isArray(input.files) || input.files.length === 0 ||
      input.files.some((filePath) => typeof filePath !== 'string' || !filePath.trim())) {
    throw adapterError('ACQUIRING_IMPORT_FILES_INVALID', 'Acquiring import files 必须是非空路径数组');
  }
  if (input.overwrite !== undefined && typeof input.overwrite !== 'boolean') {
    throw adapterError('ACQUIRING_IMPORT_MODE_INVALID', 'Acquiring import overwrite 必须是 boolean');
  }
  if (input.parallel !== undefined &&
      (!Number.isSafeInteger(input.parallel) || input.parallel < 1 ||
        input.parallel > MAX_IMPORT_CHILDREN)) {
    throw adapterError(
      'ACQUIRING_IMPORT_PARALLEL_INVALID',
      `Acquiring import parallel 必须在 1～${MAX_IMPORT_CHILDREN}`
    );
  }
}

function wrapImportHandle(handle, mapResult) {
  const mapped = {
    promise: Promise.resolve(handle.promise).then(mapResult)
  };
  for (const method of ['cancel', 'close', 'terminate', 'isCancellationTerminalError']) {
    if (handle && typeof handle[method] === 'function') {
      mapped[method] = (...args) => handle[method](...args);
    }
  }
  return mapped;
}

function createAcquiringImportMatureBinding(options = {}) {
  const userDataDir = () => requireUserDataDir(
    typeof options.userDataDirProvider === 'function'
      ? options.userDataDirProvider()
      : options.userDataDir
  );
  const dispatchEngine = options.dispatchEngine || dispatchEngineImportHandle;
  const openSideDb = options.openSideDb || runDataStore.openSideDb;
  const nowIso = options.nowIso || (() => new Date().toISOString());
  const onLog = typeof options.onLog === 'function' ? options.onLog : null;

  const binding = createBigTableImportMatureBinding({
    ...(options.inspectTopology ? { inspectTopology: options.inspectTopology } : {}),
    dispatch(engineRequest) {
      const files = [...engineRequest.files];
      const overwrite = engineRequest.overwrite === true;
      const authoritativeUserDataDir = userDataDir();
      const sideDb = openSideDb(
        authoritativeUserDataDir,
        runDataStore.MODULE_ACQUIRING,
        engineRequest.monthKey
      );
      try {
        sideDb.close();
      } catch (_error) {}
      const dbPath = runDataStore.sideDbPath(
        authoritativeUserDataDir,
        runDataStore.MODULE_ACQUIRING,
        engineRequest.monthKey
      );
      if (typeof engineRequest.onEngineProgress === 'function') {
        for (let index = 0; index < files.length; index += 1) {
          engineRequest.onEngineProgress({
            stage: 'reading',
            fileIndex: index,
            fileCount: files.length,
            filePath: files[index]
          });
        }
      }
      const handle = dispatchEngine({
        dbPath,
        files,
        contractModulePath: engineRequest.kind === 'flow'
          ? FLOW_CONTRACT_PATH
          : BILL_CONTRACT_PATH,
        contractOptions: { importedAt: nowIso() },
        mode: overwrite ? 'overwrite' : 'append',
        monthKey: engineRequest.monthKey,
        batchContext: engineRequest.batchContext,
        parallel: engineRequest.parallel,
        parallelFrozen: engineRequest.parallelFrozen === true,
        onEngineProgress(event) {
          if (typeof engineRequest.onEngineProgress !== 'function') return;
          engineRequest.onEngineProgress({
            stage: 'inserting',
            fileIndex: files.length - 1,
            fileCount: files.length,
            sourceFile: event && event.sourceFile,
            importedCount: event && event.importedCount
          });
        },
        ...(onLog ? { onLog } : {})
      });
      return wrapImportHandle(handle, (engineResult) => {
        const result = {
          monthKey: engineResult && engineResult.monthKey || engineRequest.monthKey,
          fileCount: files.length,
          totalImported: engineResult ? engineResult.totalImported : 0,
          perFileStats: files.map((filePath) => ({ sourceFile: path.basename(filePath) }))
        };
        if (overwrite) {
          result.deletedCount = engineResult && Number.isFinite(engineResult.deletedCount)
            ? engineResult.deletedCount
            : 0;
        }
        return result;
      });
    }
  });

  return Object.freeze({
    inspectTopology(request = {}) {
      validateImportInput(request.input || {});
      return binding.inspectTopology(request);
    },
    dispatch(request = {}) {
      validateImportInput(request.input || {});
      return binding.dispatch(request);
    }
  });
}

function defaultCountBillRows({ dbPath, monthKey, DatabaseSyncClass = DatabaseSync }) {
  if (!fs.existsSync(dbPath)) {
    throw adapterError(
      'ACQUIRING_RUN_SIDE_DB_UNAVAILABLE',
      `Acquiring run 侧库不存在：${monthKey}`
    );
  }
  const db = new DatabaseSyncClass(dbPath, { readOnly: true });
  try {
    const row = db.prepare(
      'SELECT COUNT(*) AS c FROM acquiring_bill_currency_bill_imports WHERE month_key = ?'
    ).get(monthKey);
    const count = Number(row && row.c);
    if (!Number.isSafeInteger(count) || count < 0) {
      throw new TypeError('Acquiring run bill row count 非法');
    }
    return count;
  } finally {
    try { db.close(); } catch (_error) {}
  }
}

function normalizeWorkerCount(value, options = {}) {
  const fallback = options.fallback === undefined ? 1 : options.fallback;
  const count = value === undefined ? fallback : value;
  if (!Number.isSafeInteger(count) || count < 1 || count > MAX_RUN_CHILDREN) {
    throw adapterError(
      'ACQUIRING_RUN_WORKER_COUNT_INVALID',
      `Acquiring run workerCount 必须在 1～${MAX_RUN_CHILDREN}`
    );
  }
  return count;
}

function normalizeChunkSize(value) {
  if (value === undefined) return DEFAULT_CHUNK_SIZE;
  if (!Number.isSafeInteger(value) || value < 1) {
    throw adapterError('ACQUIRING_RUN_CHUNK_SIZE_INVALID', 'Acquiring run chunkSize 必须是正安全整数');
  }
  return value;
}

function assertOutputIntent(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).sort().join(',') !== 'diffFilePath,reportFilePath' ||
      typeof value.diffFilePath !== 'string' || !value.diffFilePath.trim() ||
      typeof value.reportFilePath !== 'string' || !value.reportFilePath.trim() ||
      path.resolve(value.diffFilePath) !== path.resolve(value.reportFilePath)) {
    throw adapterError(
      'ACQUIRING_RUN_OUTPUT_INTENT_INVALID',
      'Acquiring run outputIntent 必须是 exact 且同路径的 diffFilePath/reportFilePath'
    );
  }
}

function bindRunIdentity(request) {
  if (!request.context || request.context.kind !== 'operation') {
    throw adapterError(
      'ACQUIRING_RUN_CONTEXT_INVALID',
      'Acquiring run mature adapter 需要 operation context'
    );
  }
  let operationContext;
  let batchContext;
  try {
    operationContext = freezeWorkerOperationContext(request.context.value, { required: true });
  } catch (error) {
    throw adapterError(
      'ACQUIRING_RUN_CONTEXT_INVALID',
      `Acquiring run operation context 非法：${error.message}`,
      error
    );
  }
  try {
    batchContext = freezeWorkerBatchContext(request.input && request.input.batchContext, {
      required: true
    });
  } catch (error) {
    throw adapterError(
      'ACQUIRING_RUN_BATCH_CONTEXT_INVALID',
      `Acquiring run batchContext 非法：${error.message}`,
      error
    );
  }
  const mismatch = WORKER_OPERATION_CONTEXT_FIELDS.some(
    (field) => operationContext[field] !== batchContext[field]
  );
  if (mismatch || (request.operationKey && request.operationKey !== operationContext.operationKey)) {
    throw adapterError(
      'ACQUIRING_RUN_CONTEXT_MISMATCH',
      'Acquiring run exact-5 operation context 与 exact-7 File Task owner 必须共享同一 identity'
    );
  }
  return Object.freeze({ operationContext, batchContext });
}

function validateRunInput(request) {
  const input = request && request.input;
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw adapterError('ACQUIRING_RUN_INPUT_INVALID', 'Acquiring run input 必须是对象');
  }
  assertNoAuthorityOverrides(input);
  validateMonthKey(input.monthKey);
  if (typeof input.storageRoot !== 'string' || !input.storageRoot.trim()) {
    throw adapterError('ACQUIRING_RUN_STORAGE_ROOT_INVALID', 'Acquiring run storageRoot 必须是非空路径');
  }
  normalizeChunkSize(input.chunkSize);
  if (input.resumeRunId !== undefined &&
      (!Number.isSafeInteger(input.resumeRunId) || input.resumeRunId < 1)) {
    throw adapterError(
      'ACQUIRING_RUN_RESUME_ID_INVALID',
      'Acquiring resumeRunId 必须是正安全整数'
    );
  }
  if (input.resumeRunId !== undefined && input.workerCount !== undefined &&
      input.workerCount !== 1) {
    throw adapterError(
      'ACQUIRING_RUN_RESUME_WORKER_COUNT_INVALID',
      'Acquiring resume 永远只能使用 single root Worker'
    );
  }
  assertOutputIntent(input.outputIntent);
  return bindRunIdentity(request);
}

function createAcquiringRunMatureBindings(options = {}) {
  const userDataDir = () => requireUserDataDir(
    typeof options.userDataDirProvider === 'function'
      ? options.userDataDirProvider()
      : options.userDataDir
  );
  const mainDbProvider = typeof options.mainDbProvider === 'function'
    ? options.mainDbProvider
    : () => options.mainDb;
  const mainDatabasePath = () => {
    const raw = typeof options.mainDatabasePathProvider === 'function'
      ? options.mainDatabasePathProvider()
      : options.mainDatabasePath;
    if (typeof raw !== 'string' || !raw.trim()) {
      throw adapterError(
        'ACQUIRING_RUN_MAIN_DB_PATH_AUTHORITY_UNAVAILABLE',
        'Acquiring resume 缺少 Main database path authority'
      );
    }
    return path.resolve(raw);
  };
  const runDataModule = options.runData || runData;
  const pool = options.pool || runCheckWorkerPool;
  const countBillRows = options.countBillRows || defaultCountBillRows;
  const fallbackGate = options.shouldFallbackToSingleWorker || shouldFallbackToSingleWorker;
  const onLog = typeof options.onLog === 'function' ? options.onLog : null;

  function requireMainDb() {
    const db = mainDbProvider();
    if (!db || typeof db.prepare !== 'function' || typeof db.exec !== 'function') {
      throw adapterError(
        'ACQUIRING_RUN_MAIN_DB_AUTHORITY_UNAVAILABLE',
        'Acquiring run mature adapter 缺少 Main database handle authority'
      );
    }
    return db;
  }

  function gateEvidence(input) {
    const monthKey = validateMonthKey(input.monthKey);
    const dbPath = runDataStore.sideDbPath(
      userDataDir(),
      runDataStore.MODULE_ACQUIRING,
      monthKey
    );
    const workerCount = normalizeWorkerCount(input.workerCount);
    const chunkSize = normalizeChunkSize(input.chunkSize);
    const totalBillRows = countBillRows({ dbPath, monthKey, DatabaseSyncClass: DatabaseSync });
    return Object.freeze({
      dbPath,
      workerCount,
      chunkSize,
      totalBillRows,
      fallback: fallbackGate({
        totalBillRows,
        workerCount,
        requestedChunkSize: chunkSize
      }) === true
    });
  }

  function assertRunNewEligible(input) {
    const evidence = gateEvidence(input);
    if (evidence.workerCount < 2 || evidence.fallback) {
      throw adapterError(
        'ACQUIRING_RUN_MULTIWORKER_INELIGIBLE',
        'Acquiring run-new-eligible 未通过既有 multiworker hard gate'
      );
    }
    return evidence;
  }

  function assertSingleClassification(input) {
    if (input.resumeRunId !== undefined) {
      return Object.freeze({ workerCount: 1, resume: true });
    }
    const workerCount = normalizeWorkerCount(input.workerCount);
    if (workerCount === 1) return Object.freeze({ workerCount: 1, resume: false });
    const evidence = gateEvidence(input);
    if (!evidence.fallback) {
      throw adapterError(
        'ACQUIRING_RUN_ACTION_CLASSIFICATION_MISMATCH',
        '符合 multiworker gate 的全新 run 不能走 single-or-resume action'
      );
    }
    // 在启动旧 dispatcher 前冻结 single 分类，避免行数在 admission 后增长时动态起 child。
    return Object.freeze({ workerCount: 1, resume: false });
  }

  function prepareAuthoritativeResume(input, identity, mainDb) {
    if (typeof runDataModule.prepareRunResume !== 'function' ||
        typeof runDataModule.assertRunResumeFresh !== 'function') {
      throw adapterError(
        'ACQUIRING_RUN_RESUME_AUTHORITY_UNAVAILABLE',
        'Acquiring resume wrapper 缺少 authoritative prepare/freshness API'
      );
    }
    const authoritativeUserDataDir = userDataDir();
    const authoritativeMainDbPath = mainDatabasePath();
    const prepared = runDataModule.prepareRunResume({
      userDataDir: authoritativeUserDataDir,
      mainDb,
      mainDbPath: authoritativeMainDbPath,
      monthKey: input.monthKey,
      runId: input.resumeRunId
    });
    runDataModule.assertRunResumeFresh({
      userDataDir: authoritativeUserDataDir,
      mainDb,
      mainDbPath: authoritativeMainDbPath,
      prepared
    });
    let persistedOwner;
    try {
      persistedOwner = freezeWorkerBatchContext(
        prepared && prepared.recovery && prepared.recovery.batchContext,
        { required: true }
      );
    } catch (error) {
      throw adapterError(
        'ACQUIRING_RUN_RESUME_OWNER_INVALID',
        `Acquiring resume 缺少 authoritative File Task owner：${error.message}`,
        error
      );
    }
    if (WORKER_BATCH_CONTEXT_FIELDS.some(
      (field) => persistedOwner[field] !== identity.batchContext[field]
    )) {
      throw adapterError(
        'ACQUIRING_RUN_RESUME_OWNER_MISMATCH',
        'Acquiring resume 持久 File Task owner 与当前 exact-7 identity 不一致'
      );
    }
    try {
      assertOutputIntent(prepared.outputIntent);
    } catch (error) {
      throw adapterError(
        'ACQUIRING_RUN_RESUME_OUTPUT_INTENT_INVALID',
        `Acquiring resume 持久 output intent 非法：${error.message}`,
        error
      );
    }
    if (path.resolve(prepared.outputIntent.diffFilePath) !==
          path.resolve(input.outputIntent.diffFilePath) ||
        path.resolve(prepared.outputIntent.reportFilePath) !==
          path.resolve(input.outputIntent.reportFilePath)) {
      throw adapterError(
        'ACQUIRING_RUN_RESUME_OUTPUT_INTENT_MISMATCH',
        'Acquiring resume 当前 FilePlan 与持久 output intent 不一致'
      );
    }
    const persistedChunkSize = prepared && prepared.progress && prepared.progress.chunkSize;
    const requestedChunkSize = normalizeChunkSize(input.chunkSize);
    const chunkSize = Number.isSafeInteger(persistedChunkSize) && persistedChunkSize > 0
      ? persistedChunkSize
      : requestedChunkSize;
    if (chunkSize !== requestedChunkSize && onLog) {
      try {
        onLog({
          level: 'warning',
          source: 'main',
          domain: 'acquiring-bill-currency',
          message: '[acquiring-bill-currency:resume] chunkSize mismatch — 使用持久值',
          details: [
            `runId=${input.resumeRunId}`,
            `monthKey=${input.monthKey}`,
            `persisted=${chunkSize}`,
            `requested=${requestedChunkSize}`
          ]
        });
      } catch (_error) {}
    }
    return Object.freeze({ prepared, chunkSize });
  }

  function dispatchRun(request, actionKey) {
    const identity = validateRunInput(request);
    const input = request.input;
    const classification = actionKey === ACQUIRING_ADAPTER_ACTIONS.RUN_NEW_ELIGIBLE
      ? assertRunNewEligible(input)
      : assertSingleClassification(input);
    if (actionKey === ACQUIRING_ADAPTER_ACTIONS.RUN_NEW_ELIGIBLE) {
      const topology = request.topology;
      if (!topology || !Number.isSafeInteger(topology.effectiveChildCount) ||
          topology.effectiveChildCount < 1 || topology.effectiveChildCount > MAX_RUN_CHILDREN) {
        throw adapterError(
          'ACQUIRING_RUN_TOPOLOGY_MISSING',
          'Acquiring run-new-eligible 需要已获批 topology'
        );
      }
    }
    const mainDb = requireMainDb();
    const authoritativeResume = classification.resume
      ? prepareAuthoritativeResume(input, identity, mainDb)
      : null;
    const dispatchCallbacks = {
      onProgress: request.onProgress,
      ...(onLog ? { onLog } : {})
    };
    const admittedWorkerCount = actionKey === ACQUIRING_ADAPTER_ACTIONS.RUN_NEW_ELIGIBLE
      ? request.topology.effectiveChildCount
      : classification.workerCount;
    const promise = authoritativeResume
      ? runDataModule.resumeRunCheck({
          prepared: authoritativeResume.prepared,
          storageRoot: input.storageRoot,
          chunkSize: authoritativeResume.chunkSize,
          batchContext: identity.batchContext,
          outputIntent: input.outputIntent,
          dispatchFn: pool.dispatchRunCheck,
          dispatchCallbacks,
          mainDb
        })
      : runDataModule.runCheckViaSideDb({
          userDataDir: userDataDir(),
          monthKey: input.monthKey,
          storageRoot: input.storageRoot,
          chunkSize: normalizeChunkSize(input.chunkSize),
          workerCount: admittedWorkerCount,
          tempDir: input.tempDir,
          batchContext: identity.batchContext,
          outputIntent: input.outputIntent,
          dispatchFn: pool.dispatchRunCheck,
          dispatchCallbacks,
          mainDb
        });
    let cancelMessagePosted = false;
    return {
      promise,
      cancel() {
        cancelMessagePosted = pool.cancel(null, {
          hardTimeoutMs: options.cancelHardTimeoutMs || 5000
        }) === true;
        // pool.cancel=true 只表示 message 已投递，不能伪造 executor ACK。
        return { acknowledged: false };
      },
      isCancellationTerminalError(error) {
        return cancelMessagePosted && Boolean(error && error.name === 'CancelError');
      },
      close() {
        // singleton pool 跨 job 复用；普通 terminal 仍由原 idle/before-quit owner 管理。
        return undefined;
      },
      terminate() {
        return pool.shutdown(options.terminateTimeoutMs || 5000);
      }
    };
  }

  const runNew = Object.freeze({
    inspectTopology(request = {}) {
      validateRunInput(request);
      if (request.input.resumeRunId !== undefined) {
        throw adapterError(
          'ACQUIRING_RUN_MULTIWORKER_INELIGIBLE',
          'resume 永远不能走 run-new-eligible'
        );
      }
      const evidence = assertRunNewEligible(request.input);
      return Object.freeze({ effectiveChildCount: evidence.workerCount });
    },
    dispatch(request = {}) {
      return dispatchRun(request, ACQUIRING_ADAPTER_ACTIONS.RUN_NEW_ELIGIBLE);
    }
  });
  const runSingle = Object.freeze({
    dispatch(request = {}) {
      return dispatchRun(request, ACQUIRING_ADAPTER_ACTIONS.RUN_SINGLE_OR_RESUME);
    }
  });
  return Object.freeze({ runNew, runSingle });
}

function createAcquiringMatureBindings(options = {}) {
  const runBindings = createAcquiringRunMatureBindings(options.run || options);
  return Object.freeze({
    [ACQUIRING_ADAPTER_ACTIONS.IMPORT]: createAcquiringImportMatureBinding(
      options.import || options
    ),
    [ACQUIRING_ADAPTER_ACTIONS.RUN_NEW_ELIGIBLE]: runBindings.runNew,
    [ACQUIRING_ADAPTER_ACTIONS.RUN_SINGLE_OR_RESUME]: runBindings.runSingle
  });
}

module.exports = {
  MAX_IMPORT_CHILDREN,
  MAX_RUN_CHILDREN,
  createAcquiringImportMatureBinding,
  createAcquiringMatureBindings,
  createAcquiringRunMatureBindings,
  defaultCountBillRows
};
