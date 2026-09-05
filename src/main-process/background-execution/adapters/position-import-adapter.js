'use strict';

const path = require('node:path');

const {
  POSITION_IMPORT_COMMANDS,
  POSITION_IMPORT_ENGINES,
  POSITION_IMPORT_STREAMING_SOURCE_ALLOWLIST
} = require('../../../backend/position-reconciliation-import/constants');
const {
  dispatchPositionImportPreflight,
  dispatchPositionLargeImportSchemaMigration
} = require('../../position-reconciliation/import-dispatch');
const {
  normalizePositionCheckpoint,
  positionCheckpointsEqual
} = require('../../position-reconciliation/side-db-mutation');
const {
  WORKER_BATCH_CONTEXT_FIELDS,
  freezeWorkerBatchContext
} = require('../../archive-center/worker-batch-context');
const { freezeWorkerOperationContext } = require(
  '../../archive-center/worker-operation-context'
);
const {
  POSITION_IMPORT_ADAPTER_ACTION,
  validatePositionImportAdapterProgress
} = require('../position-import-adapter-policy');

const POSITION_IMPORT_ADAPTER_INTENTS = Object.freeze({
  BANK_PREPARE: 'bank-prepare',
  BANK_APPLY: 'bank-apply',
  SOURCE_PREPARE_AND_APPLY: 'source-prepare-and-apply',
  ACCOUNT_APPLY: 'account-apply'
});

const INTENT_COMMANDS = Object.freeze({
  [POSITION_IMPORT_ADAPTER_INTENTS.BANK_PREPARE]: POSITION_IMPORT_COMMANDS.BANK_PREPARE,
  [POSITION_IMPORT_ADAPTER_INTENTS.BANK_APPLY]: POSITION_IMPORT_COMMANDS.BANK_APPLY,
  [POSITION_IMPORT_ADAPTER_INTENTS.SOURCE_PREPARE_AND_APPLY]:
    POSITION_IMPORT_COMMANDS.SOURCE_PREPARE_AND_APPLY,
  [POSITION_IMPORT_ADAPTER_INTENTS.ACCOUNT_APPLY]: POSITION_IMPORT_COMMANDS.ACCOUNT_APPLY
});

const SHARED_OWNER_FIELDS = Object.freeze([
  'taskRunId',
  'taskKey',
  'moduleId',
  'parentRunId',
  'operationKey'
]);

const SHA256_RE = /^[a-f0-9]{64}$/;

function adapterError(code, message, cause) {
  const error = new TypeError(message);
  error.code = code;
  if (cause !== undefined) error.cause = cause;
  return error;
}

function exactKeys(value, expected) {
  return value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).sort().join(',') === [...expected].sort().join(',');
}

function safeCount(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function optionalCountEvidence(result, key) {
  if (!result || typeof result !== 'object' || !Object.hasOwn(result, key)) return null;
  const value = result[key];
  if (!Number.isSafeInteger(value) || value < 0) {
    throw adapterError(
      'POSITION_IMPORT_ADAPTER_COUNT_EVIDENCE_INVALID',
      `Position existing dispatcher 返回非法 ${key} 计数证据`
    );
  }
  return value;
}

function assertCountEvidenceMatches(explicit, derived, key) {
  if (explicit !== null && explicit !== derived) {
    throw adapterError(
      'POSITION_IMPORT_ADAPTER_COUNT_EVIDENCE_CONFLICT',
      `Position existing dispatcher 的 ${key} 与文件级结果不一致`
    );
  }
}

function requirePath(value, code, label) {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized || !path.isAbsolute(normalized)) {
    throw adapterError(code, `Position mature adapter 缺少绝对 ${label} authority`);
  }
  return path.resolve(normalized);
}

function resolveProvider(options, providerKey, directKey, code, label, normalized) {
  const provider = options[providerKey];
  const value = typeof provider === 'function' ? provider(normalized) : options[directKey];
  if (value === undefined || value === null || value === '') {
    throw adapterError(code, `Position mature adapter 缺少 ${label} authority`);
  }
  return value;
}

function freezeOperationRequest(request) {
  if (!request || request.actionKey !== POSITION_IMPORT_ADAPTER_ACTION ||
      !request.context || request.context.kind !== 'operation') {
    throw adapterError(
      'POSITION_IMPORT_ADAPTER_CONTEXT_INVALID',
      'Position mature adapter 只接受 position:import exact-5 operation context'
    );
  }
  const operationContext = freezeWorkerOperationContext(request.context.value, {
    required: true
  });
  if (request.operationKey !== operationContext.operationKey) {
    throw adapterError(
      'POSITION_IMPORT_ADAPTER_OPERATION_KEY_MISMATCH',
      'Position mature adapter envelope operationKey 与 exact-5 context 不一致'
    );
  }
  return operationContext;
}

function freezeMatchedBatchContext(value, operationContext) {
  const batchContext = freezeWorkerBatchContext(value, { required: true });
  const mismatch = SHARED_OWNER_FIELDS.find(
    (field) => batchContext[field] !== operationContext[field]
  );
  if (mismatch) {
    throw adapterError(
      'POSITION_IMPORT_ADAPTER_OWNER_MISMATCH',
      `Position mature adapter exact-5/7 owner 不一致：${mismatch}`
    );
  }
  return batchContext;
}

function validateFiles(value) {
  if (!Array.isArray(value) || value.length === 0 || value.some((filePath) => (
    typeof filePath !== 'string' || !filePath.trim() || !path.isAbsolute(filePath)
  ))) {
    throw adapterError(
      'POSITION_IMPORT_ADAPTER_FILES_INVALID',
      'Position mature adapter files 必须是非空绝对路径数组'
    );
  }
  return Object.freeze(value.map((filePath) => path.resolve(filePath)));
}

function normalizeRequest(request) {
  const operationContext = freezeOperationRequest(request);
  const input = request.input;
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw adapterError(
      'POSITION_IMPORT_ADAPTER_INPUT_INVALID',
      'Position mature adapter input 必须是对象'
    );
  }
  const command = INTENT_COMMANDS[input.intent];
  if (!command) {
    throw adapterError(
      'POSITION_IMPORT_ADAPTER_INTENT_INVALID',
      'Position mature adapter intent 非法'
    );
  }
  let files = Object.freeze([]);
  let batchContext = null;
  let preparedImportKey = '';
  if (input.intent === POSITION_IMPORT_ADAPTER_INTENTS.BANK_PREPARE) {
    if (!exactKeys(input, ['files', 'intent'])) {
      throw adapterError(
        'POSITION_IMPORT_ADAPTER_AUTHORITY_OVERRIDE_FORBIDDEN',
        'Position bank prepare 只接受 intent/files；authority 由 Main 注入'
      );
    }
    files = validateFiles(input.files);
  } else if (input.intent === POSITION_IMPORT_ADAPTER_INTENTS.SOURCE_PREPARE_AND_APPLY) {
    if (!exactKeys(input, ['batchContext', 'files', 'intent'])) {
      throw adapterError(
        'POSITION_IMPORT_ADAPTER_AUTHORITY_OVERRIDE_FORBIDDEN',
        'Position source import 只接受 intent/files/batchContext；authority 由 Main 注入'
      );
    }
    files = validateFiles(input.files);
    batchContext = freezeMatchedBatchContext(input.batchContext, operationContext);
  } else {
    if (!exactKeys(input, ['batchContext', 'intent', 'preparedImportKey'])) {
      throw adapterError(
        'POSITION_IMPORT_ADAPTER_AUTHORITY_OVERRIDE_FORBIDDEN',
        'Position confirmed apply 只接受 intent/preparedImportKey/batchContext；authority 由 Main 注入'
      );
    }
    preparedImportKey = typeof input.preparedImportKey === 'string'
      ? input.preparedImportKey.trim()
      : '';
    if (!preparedImportKey || preparedImportKey.length > 256) {
      throw adapterError(
        'POSITION_IMPORT_ADAPTER_PREPARED_KEY_INVALID',
        'Position confirmed apply preparedImportKey 非法'
      );
    }
    batchContext = freezeMatchedBatchContext(input.batchContext, operationContext);
  }
  return Object.freeze({
    input,
    intent: input.intent,
    command,
    files,
    preparedImportKey,
    operationContext,
    batchContext,
    effectiveChildCount:
      input.intent === POSITION_IMPORT_ADAPTER_INTENTS.SOURCE_PREPARE_AND_APPLY ? 1 : 0
  });
}

function assertAdmittedTopology(request, normalized) {
  if (!request.topology || typeof request.topology !== 'object' ||
      !Number.isSafeInteger(request.topology.effectiveChildCount) ||
      request.topology.effectiveChildCount !== normalized.effectiveChildCount) {
    throw adapterError(
      'POSITION_IMPORT_ADAPTER_TOPOLOGY_MISMATCH',
      'Position mature adapter admitted topology 与 current dispatcher 不一致'
    );
  }
}

function preflightOf(result) {
  return result && result.preflightReady && typeof result.preflightReady === 'object'
    ? result.preflightReady
    : result;
}

function checkpointOf(result) {
  const candidates = result && typeof result === 'object'
    ? ['nextCheckpoint', 'checkpoint']
        .filter((key) => Object.hasOwn(result, key) && result[key] !== null && result[key] !== undefined)
        .map((key) => result[key])
    : [];
  if (candidates.length === 0) return null;
  try {
    const normalized = candidates.map((candidate) => normalizePositionCheckpoint(
      candidate,
      'Position adapter result checkpoint'
    ));
    if (normalized.some((checkpoint) => !checkpoint) ||
        normalized.slice(1).some((checkpoint) => !positionCheckpointsEqual(
          checkpoint,
          normalized[0]
        ))) {
      throw new TypeError('Position result checkpoints disagree');
    }
    return normalized[0];
  } catch (error) {
    throw adapterError(
      'POSITION_IMPORT_ADAPTER_CHECKPOINT_EVIDENCE_INVALID',
      'Position existing dispatcher 返回非法 checkpoint 证据',
      error
    );
  }
}

function requirePreflightEvidence(result, normalized, requestJobId) {
  const preflight = preflightOf(result);
  const expectedJobId = normalized.preparedImportKey || String(requestJobId || '');
  const jobId = String(preflight && preflight.jobId || '').trim();
  const manifestHash = String(
    preflight && preflight.archiveManifestHash || ''
  ).trim().toLowerCase();
  if (!preflight || typeof preflight !== 'object' || Array.isArray(preflight) ||
      jobId !== expectedJobId || !SHA256_RE.test(manifestHash) ||
      !Array.isArray(preflight.acceptedBankFiles) ||
      !Array.isArray(preflight.acceptedOrdinaryInputFiles) ||
      !Array.isArray(preflight.orderedFileResults)) {
    throw adapterError(
      'POSITION_IMPORT_ADAPTER_PREFLIGHT_EVIDENCE_INVALID',
      'Position existing dispatcher 返回的 preflight evidence 非法'
    );
  }
  return preflight;
}

function resultRows(result, preflight) {
  const explicitRowCount = optionalCountEvidence(result, 'rowCount');
  if (explicitRowCount !== null) return explicitRowCount;
  const rows = result && Array.isArray(result.results)
    ? result.results
    : (preflight && Array.isArray(preflight.orderedFileResults)
        ? preflight.orderedFileResults
        : []);
  return rows.reduce((sum, item) => sum + (
    item && item.status === 'ok' && Number.isSafeInteger(item.rowCount) && item.rowCount >= 0
      ? item.rowCount
      : 0
  ), 0);
}

function projectResult(result, normalized, requestJobId) {
  if (result && result.status === 'failed') {
    throw adapterError(
      String(result.code || 'POSITION_IMPORT_ADAPTER_BUSINESS_FAILED'),
      'Position existing dispatcher 返回业务失败结果'
    );
  }
  const preflight = requirePreflightEvidence(result, normalized, requestJobId);
  const ordered = Array.isArray(preflight.orderedFileResults)
    ? preflight.orderedFileResults
    : [];
  const acceptedBank = Array.isArray(preflight.acceptedBankFiles)
    ? preflight.acceptedBankFiles.length
    : 0;
  const acceptedOrdinary = Array.isArray(preflight.acceptedOrdinaryInputFiles)
    ? preflight.acceptedOrdinaryInputFiles.length
    : 0;
  const explicitFailedFileCount = optionalCountEvidence(result, 'failedCount');
  const explicitConfirmationCount = optionalCountEvidence(result, 'confirmationCount');
  const explicitCommittedMutations = optionalCountEvidence(result, 'committedMutations');
  const explicitSuccessCount = optionalCountEvidence(result, 'successCount');
  if (result && Object.hasOwn(result, 'recoveredFromWorkerExit') &&
      typeof result.recoveredFromWorkerExit !== 'boolean') {
    throw adapterError(
      'POSITION_IMPORT_ADAPTER_RECOVERY_EVIDENCE_INVALID',
      'Position existing dispatcher 返回非法 recovery 证据'
    );
  }
  if (result && Object.hasOwn(result, 'cancelAcknowledged') &&
      typeof result.cancelAcknowledged !== 'boolean') {
    throw adapterError(
      'POSITION_IMPORT_ADAPTER_CANCEL_EVIDENCE_INVALID',
      'Position existing dispatcher 返回非法 cancel ACK 证据'
    );
  }
  if (result && result.cancelAcknowledged === true) {
    throw adapterError(
      'POSITION_IMPORT_ADAPTER_CANCEL_EVIDENCE_INVALID',
      'Position existing dispatcher 已确认取消却返回成功结果'
    );
  }
  const fileResults = result && Array.isArray(result.results) ? result.results : ordered;
  const derivedFailedFileCount = fileResults.filter(
    (item) => item && item.status === 'failed'
  ).length;
  const derivedConfirmationCount = fileResults.filter(
    (item) => item && item.status === 'needs-confirmation'
  ).length;
  assertCountEvidenceMatches(explicitFailedFileCount, derivedFailedFileCount, 'failedCount');
  assertCountEvidenceMatches(
    explicitConfirmationCount,
    derivedConfirmationCount,
    'confirmationCount'
  );
  const failedFileCount = explicitFailedFileCount === null
    ? derivedFailedFileCount
    : explicitFailedFileCount;
  const confirmationCount = explicitConfirmationCount === null
    ? derivedConfirmationCount
    : explicitConfirmationCount;
  const recoveredFromWorkerExit = result && result.recoveredFromWorkerExit === true;
  const checkpoint = checkpointOf(result);
  let committedMutations = explicitCommittedMutations === null ? 0 : explicitCommittedMutations;
  if (checkpoint && committedMutations === 0) {
    if (normalized.command === POSITION_IMPORT_COMMANDS.SOURCE_PREPARE_AND_APPLY) {
      committedMutations = Array.isArray(result && result.results)
        ? result.results.filter((item) => item && item.status === 'ok' && item.applied === true).length
        : (explicitSuccessCount === null ? 0 : explicitSuccessCount);
    } else {
      committedMutations = 1;
    }
  }
  if (checkpoint && committedMutations === 0) {
    const confirmationOnlyRecovery = recoveredFromWorkerExit && confirmationCount > 0;
    if (!confirmationOnlyRecovery) {
      throw adapterError(
        'POSITION_IMPORT_ADAPTER_COMMIT_EVIDENCE_INVALID',
        'Position mature adapter checkpoint 缺少文件级提交数量证据'
      );
    }
  }
  const outcome = recoveredFromWorkerExit
    ? (committedMutations > 0 ? 'recovered' : 'preflight-recovered')
    : (checkpoint ? 'committed' : 'preflight-complete');
  return Object.freeze({
    command: normalized.command,
    jobId: String(requestJobId || ''),
    outcome,
    acceptedFileCount: acceptedBank + acceptedOrdinary,
    failedFileCount: safeCount(failedFileCount),
    confirmationCount: safeCount(confirmationCount),
    rowCount: resultRows(result, preflight),
    committedMutations,
    checkpointGeneration: checkpoint ? checkpoint.generation : null,
    recoveredFromWorkerExit,
    cancelAcknowledged: Boolean(result && result.cancelAcknowledged)
  });
}

function projectProgress(progress) {
  const value = progress && typeof progress === 'object' ? progress : {};
  const projected = Object.freeze({
    stage: typeof value.stage === 'string' && /^[a-z][a-z0-9-]{0,63}$/.test(value.stage)
      ? value.stage
      : 'preflight',
    totalFiles: safeCount(value.totalFiles),
    scannedRows: safeCount(value.scannedRows),
    acceptedRows: safeCount(value.acceptedRows),
    committedRows: safeCount(value.committedRows),
    copiedBytes: safeCount(value.copiedBytes),
    totalBytes: safeCount(value.totalBytes),
    elapsedMs: safeCount(value.elapsedMs),
    heartbeat: value.heartbeat === true
  });
  if (!validatePositionImportAdapterProgress(projected)) {
    throw adapterError(
      'POSITION_IMPORT_ADAPTER_PROGRESS_INVALID',
      'Position mature adapter progress 投影非法'
    );
  }
  return projected;
}

function cancellationError() {
  return adapterError(
    'POSITION_IMPORT_ADAPTER_CANCELLED',
    'Position mature adapter 在启动 mutation 前已取消'
  );
}

function createDeferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve, settled: false };
}

function createPositionImportMatureBinding(options = {}) {
  const dispatch = options.dispatch || dispatchPositionImportPreflight;
  const dispatchSchemaMigration = options.dispatchSchemaMigration ||
    dispatchPositionLargeImportSchemaMigration;

  function inspectTopology(request) {
    const normalized = normalizeRequest(request);
    return Object.freeze({ effectiveChildCount: normalized.effectiveChildCount });
  }

  function dispatchRequest(request) {
    const normalized = normalizeRequest(request);
    assertAdmittedTopology(request, normalized);
    const authoritativeUserDataDir = requirePath(
      resolveProvider(
        options,
        'userDataDirProvider',
        'userDataDir',
        'POSITION_IMPORT_ADAPTER_USER_DATA_AUTHORITY_UNAVAILABLE',
        'Main userData',
        normalized
      ),
      'POSITION_IMPORT_ADAPTER_USER_DATA_AUTHORITY_UNAVAILABLE',
      'Main userData'
    );
    const authoritativeSideDbPath = requirePath(
      resolveProvider(
        options,
        'sideDbPathProvider',
        'sideDbPath',
        'POSITION_IMPORT_ADAPTER_SIDE_DB_AUTHORITY_UNAVAILABLE',
        'side DB',
        normalized
      ),
      'POSITION_IMPORT_ADAPTER_SIDE_DB_AUTHORITY_UNAVAILABLE',
      'side DB'
    );
    const protectedStagingPaths = typeof options.protectedStagingPathsProvider === 'function'
      ? () => options.protectedStagingPathsProvider()
      : undefined;
    const contractOptions = typeof options.contractOptionsProvider === 'function'
      ? options.contractOptionsProvider(normalized)
      : {};
    const streamingSourceTypes = typeof options.streamingSourceTypesProvider === 'function'
      ? options.streamingSourceTypesProvider()
      : (options.streamingSourceTypes || POSITION_IMPORT_STREAMING_SOURCE_ALLOWLIST);
    let current = null;
    let currentCancel = null;
    let cancelRequested = false;
    let cancellationAccepted = false;
    let terminal = false;

    function setCurrent(rawHandle) {
      if (!rawHandle || !rawHandle.promise || typeof rawHandle.promise.then !== 'function') {
        throw adapterError(
          'POSITION_IMPORT_ADAPTER_DISPATCH_HANDLE_INVALID',
          'Position existing dispatcher 未返回完整 handle'
        );
      }
      current = rawHandle;
      currentCancel = createDeferred();
      Promise.resolve(rawHandle.promise).then((result) => {
        if (!currentCancel.settled) {
          currentCancel.settled = true;
          currentCancel.resolve({ acknowledged: Boolean(result && result.cancelAcknowledged) });
        }
      }, () => {
        if (!currentCancel.settled) {
          currentCancel.settled = true;
          currentCancel.resolve({ acknowledged: false });
        }
      }).catch(() => undefined);
      if (cancelRequested && !cancellationAccepted && typeof rawHandle.cancel === 'function') {
        const posted = rawHandle.cancel();
        if (posted === false && !currentCancel.settled) {
          currentCancel.settled = true;
          currentCancel.resolve({ acknowledged: false });
        }
      }
      return rawHandle;
    }

    function rawInput(extra) {
      return {
        engine: POSITION_IMPORT_ENGINES.STREAMING,
        userDataDir: authoritativeUserDataDir,
        sideDbPath: authoritativeSideDbPath,
        contractOptions: contractOptions && typeof contractOptions === 'object'
          ? contractOptions
          : {},
        ...(protectedStagingPaths ? { protectedStagingPaths } : {}),
        onProgress(progress) {
          if (typeof request.onProgress === 'function') {
            request.onProgress(projectProgress(progress));
          }
        },
        onCancelAck(message) {
          const acknowledged = Boolean(
            message && String(message.jobId || '') === String(request.jobId || '') &&
            message.accepted === true
          );
          if (acknowledged) cancellationAccepted = true;
          if (currentCancel && !currentCancel.settled) {
            currentCancel.settled = true;
            currentCancel.resolve({ acknowledged });
          }
          if (typeof options.onCancelAck === 'function') {
            options.onCancelAck(message, normalized);
          }
        },
        onPreflightReady(preflightReady) {
          if (typeof options.onPreflightReady === 'function') {
            options.onPreflightReady(preflightReady, normalized);
          }
        },
        onFileCommitted(file) {
          if (typeof options.onFileCommitted === 'function') {
            options.onFileCommitted(file, normalized);
          }
        },
        ...extra
      };
    }

    async function resolvePreparedImport() {
      if (typeof options.resolvePreparedImport !== 'function') {
        throw adapterError(
          'POSITION_IMPORT_ADAPTER_PREPARED_AUTHORITY_UNAVAILABLE',
          'Position confirmed apply 缺少 Main prepared-import authority'
        );
      }
      const resolved = await options.resolvePreparedImport(
        normalized.preparedImportKey,
        normalized
      );
      const rawPreflightReady = resolved && resolved.preflightReady
        ? resolved.preflightReady
        : resolved;
      const preflightReady = requirePreflightEvidence(
        { preflightReady: rawPreflightReady },
        normalized,
        request.jobId
      );
      const preflightJobId = String(preflightReady && preflightReady.jobId || '').trim();
      const manifestHash = String(
        preflightReady && preflightReady.archiveManifestHash || ''
      ).trim().toLowerCase();
      if (preflightJobId !== normalized.preparedImportKey || !SHA256_RE.test(manifestHash)) {
        throw adapterError(
          'POSITION_IMPORT_ADAPTER_PREPARED_AUTHORITY_INVALID',
          'Position confirmed apply 的 prepared-import authority 与 selector 不一致'
        );
      }
      if (normalized.intent === POSITION_IMPORT_ADAPTER_INTENTS.BANK_APPLY &&
          (!Array.isArray(preflightReady.acceptedBankFiles) ||
            preflightReady.acceptedBankFiles.length === 0)) {
        throw adapterError(
          'POSITION_IMPORT_ADAPTER_PREPARED_KIND_MISMATCH',
          'Position bank apply selector 未指向银行预检结果'
        );
      }
      if (normalized.intent === POSITION_IMPORT_ADAPTER_INTENTS.ACCOUNT_APPLY &&
          (!preflightReady.accountConfirmationDescriptor ||
            typeof preflightReady.accountConfirmationDescriptor !== 'object')) {
        throw adapterError(
          'POSITION_IMPORT_ADAPTER_PREPARED_KIND_MISMATCH',
          'Position account apply selector 未指向账户确认预检结果'
        );
      }
      return preflightReady;
    }

    async function startConfirmedApply() {
      const preflightReady = await resolvePreparedImport();
      if (cancelRequested || cancellationAccepted) throw cancellationError();
      const expectedCheckpoint = normalizePositionCheckpoint(
        resolveProvider(
          options,
          'currentCheckpointProvider',
          'currentCheckpoint',
          'POSITION_IMPORT_ADAPTER_CHECKPOINT_AUTHORITY_UNAVAILABLE',
          'current checkpoint',
          normalized
        ),
        'Position mature adapter current checkpoint'
      );
      if (!expectedCheckpoint) {
        throw adapterError(
          'POSITION_IMPORT_ADAPTER_CHECKPOINT_AUTHORITY_INVALID',
          'Position mature adapter current checkpoint 非法'
        );
      }
      const operationToken = String(resolveProvider(
        options,
        'operationTokenProvider',
        'operationToken',
        'POSITION_IMPORT_ADAPTER_OPERATION_TOKEN_UNAVAILABLE',
        'operation token',
        normalized
      )).trim();
      if (!operationToken || operationToken !== normalized.batchContext.taskRunId) {
        throw adapterError(
          'POSITION_IMPORT_ADAPTER_OPERATION_TOKEN_OWNER_MISMATCH',
          'Position mature adapter operation token 与 File Task owner 不一致'
        );
      }
      const schemaHandle = setCurrent(dispatchSchemaMigration(rawInput({
        jobId: `${request.jobId}-schema`,
        files: [],
        expectedCheckpoint,
        batchContext: normalized.batchContext
      })));
      const schema = await schemaHandle.promise;
      // schema migration 可能在 committing 阶段拒绝即时取消；它完成后重新进入安全点，
      // 此时必须尊重已记录的 job-level cancel，不得再启动真正的 apply mutation。
      if (cancelRequested || cancellationAccepted) throw cancellationError();
      const fingerprint = String(schema && schema.fingerprint || '').trim().toLowerCase();
      if (!SHA256_RE.test(fingerprint)) {
        throw adapterError(
          'POSITION_IMPORT_ADAPTER_SCHEMA_EVIDENCE_INVALID',
          'Position mature adapter schema migration 缺少 fingerprint'
        );
      }
      const applyHandle = setCurrent(dispatch(rawInput({
        command: normalized.command,
        jobId: request.jobId,
        files: [],
        expectedCheckpoint,
        operationToken,
        batchContext: normalized.batchContext,
        payload: {
          schemaFingerprint: fingerprint,
          preflightReady
        },
        featureFlags: { importApply: true }
      })));
      return applyHandle.promise;
    }

    function startBankPrepare() {
      return setCurrent(dispatch(rawInput({
        command: normalized.command,
        jobId: request.jobId,
        files: normalized.files,
        operationContext: normalized.operationContext,
        featureFlags: { preflightOnly: true }
      }))).promise;
    }

    function startSourcePrepareAndApply() {
      return setCurrent(dispatch(rawInput({
        command: normalized.command,
        jobId: request.jobId,
        files: normalized.files,
        operationContext: normalized.operationContext,
        featureFlags: {
          preflightOnly: false,
          streamingSourceTypes: Array.isArray(streamingSourceTypes)
            ? [...streamingSourceTypes]
            : streamingSourceTypes instanceof Set
              ? [...streamingSourceTypes]
              : []
        },
        authorizeApply: async (preflightReady) => {
          const authoritativePreflight = requirePreflightEvidence(
            { preflightReady },
            normalized,
            request.jobId
          );
          if (cancelRequested || cancellationAccepted) throw cancellationError();
          const accepted = Array.isArray(authoritativePreflight.acceptedOrdinaryInputFiles)
            ? authoritativePreflight.acceptedOrdinaryInputFiles
            : [];
          if (accepted.length === 0 && authoritativePreflight.accountConfirmationDescriptor) {
            return {
              preflightOnly: true,
              archiveManifestHash: authoritativePreflight.archiveManifestHash
            };
          }
          if (typeof options.authorizeSourceApply !== 'function') {
            throw adapterError(
              'POSITION_IMPORT_ADAPTER_SOURCE_AUTHORIZER_UNAVAILABLE',
              'Position source import 缺少 Main durable apply authorizer'
            );
          }
          const grant = await options.authorizeSourceApply(authoritativePreflight, normalized);
          if (cancelRequested || cancellationAccepted) throw cancellationError();
          if (!grant || typeof grant !== 'object' || Array.isArray(grant) ||
              grant.preflightOnly === true) {
            throw adapterError(
              'POSITION_IMPORT_ADAPTER_SOURCE_GRANT_INVALID',
              'Position source import durable apply grant 非法'
            );
          }
          if (grant.batchContext) {
            freezeMatchedBatchContext(grant.batchContext, normalized.operationContext);
            const mismatch = WORKER_BATCH_CONTEXT_FIELDS.find(
              (field) => grant.batchContext[field] !== normalized.batchContext[field]
            );
            if (mismatch) {
              throw adapterError(
                'POSITION_IMPORT_ADAPTER_SOURCE_GRANT_OWNER_MISMATCH',
                `Position source apply grant 与 File Task owner 不一致：${mismatch}`
              );
            }
          }
          const operationToken = String(grant.operationToken || '').trim();
          const archiveManifestHash = String(
            grant.archiveManifestHash || ''
          ).trim().toLowerCase();
          const schemaFingerprint = String(
            grant.schemaFingerprint || ''
          ).trim().toLowerCase();
          let baseCheckpoint;
          try {
            baseCheckpoint = normalizePositionCheckpoint(
              grant.baseCheckpoint,
              'Position source apply grant checkpoint'
            );
          } catch (error) {
            throw adapterError(
              'POSITION_IMPORT_ADAPTER_SOURCE_GRANT_INVALID',
              'Position source import durable apply grant checkpoint 非法',
              error
            );
          }
          if (operationToken !== normalized.batchContext.taskRunId ||
              archiveManifestHash !== String(
                authoritativePreflight.archiveManifestHash || ''
              ).trim().toLowerCase() ||
              !SHA256_RE.test(archiveManifestHash) ||
              !SHA256_RE.test(schemaFingerprint) || !baseCheckpoint) {
            throw adapterError(
              'POSITION_IMPORT_ADAPTER_SOURCE_GRANT_INVALID',
              'Position source import durable apply grant 与预检/任务 owner 不一致'
            );
          }
          return Object.freeze({
            preflightOnly: false,
            operationToken,
            archiveManifestHash,
            schemaFingerprint,
            baseCheckpoint,
            batchContext: normalized.batchContext
          });
        }
      }))).promise;
    }

    const promise = Promise.resolve().then(() => {
      if (cancellationAccepted) throw cancellationError();
      if (normalized.intent === POSITION_IMPORT_ADAPTER_INTENTS.BANK_PREPARE) {
        return startBankPrepare();
      }
      if (normalized.intent === POSITION_IMPORT_ADAPTER_INTENTS.SOURCE_PREPARE_AND_APPLY) {
        return startSourcePrepareAndApply();
      }
      return startConfirmedApply();
    }).then((result) => projectResult(result, normalized, request.jobId))
      .finally(() => { terminal = true; });

    return {
      promise,
      cancel() {
        if (terminal) return Promise.resolve({ acknowledged: false });
        cancelRequested = true;
        if (!current) {
          cancellationAccepted = true;
          return Promise.resolve({ acknowledged: true });
        }
        if (typeof current.cancel !== 'function') {
          return Promise.resolve({ acknowledged: false });
        }
        const posted = current.cancel();
        if (posted === false) {
          return Promise.resolve({ acknowledged: false });
        }
        return currentCancel.promise;
      },
      async close() {
        if (current && typeof current.close === 'function') await current.close();
      },
      terminate() {
        if (current && typeof current.terminate === 'function') return current.terminate();
        return false;
      },
      isCancellationTerminalError(error) {
        return Boolean(error && [
          'POSITION_IMPORT_ADAPTER_CANCELLED',
          'position-import-cancelled'
        ].includes(error.code));
      }
    };
  }

  return Object.freeze({
    dispatch: dispatchRequest,
    inspectTopology
  });
}

module.exports = {
  POSITION_IMPORT_ADAPTER_INTENTS,
  createPositionImportMatureBinding,
  projectPositionImportAdapterProgress: projectProgress,
  projectPositionImportAdapterResult: projectResult
};
