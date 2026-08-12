'use strict';

const crypto = require('node:crypto');
const { AsyncLocalStorage } = require('node:async_hooks');
const { freezeWorkerBatchContext } = require('./worker-batch-context');

const TERMINAL_TASK_STATUSES = new Set(['succeeded', 'failed', 'cancelled']);

function taskResultStatus(result, resultClassifier) {
  if (typeof resultClassifier !== 'function') {
    throw new TypeError('resultClassifier 必须由 task policy 或本次调用显式提供');
  }
  const status = String(resultClassifier(result) || '').trim().toLowerCase();
  if (!TERMINAL_TASK_STATUSES.has(status)) {
    throw new TypeError(`resultClassifier 返回了不支持的任务终态：${status || '<empty>'}`);
  }
  return status;
}

function createWorkerBatchContext(value = {}) {
  return freezeWorkerBatchContext(value, { required: true });
}

function createWorkerBatchContextFromBatch(batch) {
  if (!batch || typeof batch !== 'object') {
    throw new TypeError('存档批次身份缺失');
  }
  return createWorkerBatchContext({
    batchId: batch.id,
    batchNumber: batch.batchNumber,
    taskRunId: batch.taskRunId,
    taskKey: batch.taskKey,
    moduleId: batch.moduleId,
    parentRunId: batch.parentRunId,
    operationKey: batch.operationKey
  });
}

function lifecycleFailure(result, fallbackCode, fallbackMessage) {
  return {
    status: 'failed',
    code: String(result && result.code || fallbackCode),
    message: String(result && result.message || fallbackMessage)
  };
}

class TaskLifecycle {
  constructor(options = {}) {
    if (!options.businessOperationRegistry
        || typeof options.businessOperationRegistry.begin !== 'function'
        || typeof options.businessOperationRegistry.end !== 'function') {
      throw new TypeError('TaskLifecycle 需要 businessOperationRegistry');
    }
    const service = options.archiveService;
    for (const method of [
      'reserveTaskBatch',
      'beginTaskRecovery',
      'markTaskStarted',
      'completeTaskBatch',
      'failTaskBatch',
      'cancelTaskBatch',
      'recordFailure'
    ]) {
      if (!service || typeof service[method] !== 'function') {
        throw new TypeError(`TaskLifecycle 需要 archiveService.${method}`);
      }
    }
    if (!options.flowResolver
        || typeof options.flowResolver.resolve !== 'function'
        || typeof options.flowResolver.bind !== 'function'
        || typeof options.flowResolver.persistBindIntent !== 'function') {
      throw new TypeError('TaskLifecycle 需要 BusinessFlowResolver');
    }
    if (!options.operationTracker
        || typeof options.operationTracker.appendOperationFiles !== 'function') {
      throw new TypeError('TaskLifecycle 需要 operationTracker.appendOperationFiles');
    }
    this.businessOperationRegistry = options.businessOperationRegistry;
    this.archiveService = service;
    this.flowResolver = options.flowResolver;
    this.operationTracker = options.operationTracker;
    this.contextStorage = options.contextStorage || new AsyncLocalStorage();
    this.createTaskRunId = options.createTaskRunId || (() => crypto.randomUUID());
    this.persistTerminalIntent = typeof options.persistTerminalIntent === 'function'
      ? options.persistTerminalIntent
      : null;
    this.onArchiveWarning = typeof options.onArchiveWarning === 'function'
      ? options.onArchiveWarning
      : null;
    this.activeTasks = new Map();
    this.activeBatchIds = new Set();
  }

  getContext() {
    return this.contextStorage.getStore() || null;
  }

  _warn(warning) {
    if (!this.onArchiveWarning) return;
    try { this.onArchiveWarning(warning); } catch (_error) { /* 告警不得覆盖业务结果 */ }
  }

  async _recordArchiveFailure(batchId, channel, failure) {
    try {
      const recorded = await this.archiveService.recordFailure(batchId, {
        code: failure && failure.code || 'ARCHIVE_TASK_APPEND_FAILED',
        message: failure && failure.message || '任务文件登记失败',
        sourceOperation: channel
      });
      if (!recorded || recorded.ok === false) {
        this._warn({
          channel,
          code: recorded && recorded.code || 'ARCHIVE_FAILURE_RECORD_FAILED',
          message: recorded && recorded.message || '存档失败记录写入失败'
        });
      }
    } catch (error) {
      this._warn({
        channel,
        code: error && error.code || 'ARCHIVE_FAILURE_RECORD_FAILED',
        message: error && error.message || '存档失败记录写入失败'
      });
    }
  }

  async _settleArchiveCall(options) {
    const {
      batchId,
      channel,
      code,
      message,
      invoke,
      isFailure = (result) => !result || result.ok === false,
      isBenignFailure = () => false
    } = options;
    let result;
    let failure = null;
    try {
      result = await invoke();
      if (isBenignFailure(result)) return { ok: true, result, benign: true };
      if (isFailure(result)) {
        failure = {
          code: result && result.code || code,
          message: result && result.message || message
        };
      }
    } catch (error) {
      failure = {
        code: error && error.code || code,
        message: error && error.message || message,
        cause: error
      };
    }
    if (!failure) return { ok: true, result };
    if (!result || result.failureRecorded !== true) {
      await this._recordArchiveFailure(batchId, channel, failure);
    }
    this._warn({ channel, ...failure });
    return { ok: false, result, failure };
  }

  async _settlePreExecutionFailure({ context, channel, failure, message }) {
    const batchId = context.batchId;
    const terminalOutcome = await this._settleArchiveCall({
      batchId,
      channel,
      code: 'ARCHIVE_TASK_TERMINAL_FAILED',
      message,
      invoke: () => this.archiveService.failTaskBatch(batchId, failure)
    });
    if (terminalOutcome.ok) return terminalOutcome;

    try {
      if (!this.persistTerminalIntent) {
        throw new Error('任务终态意图持久化接口不可用');
      }
      const persisted = await this.persistTerminalIntent({
        batchContext: context,
        sourceOperation: channel,
        terminalOutcome: {
          taskStatus: 'failed',
          code: String(failure && failure.code || 'ARCHIVE_TASK_PRE_EXECUTION_FAILED'),
          message: String(failure && failure.message || '任务在业务开始前失败'),
          metadata: {}
        }
      });
      if (!persisted || persisted.persisted !== true) {
        throw new Error('任务终态意图未形成持久记录');
      }
      return { ...terminalOutcome, terminalIntentPersisted: true };
    } catch (persistenceError) {
      const error = new Error('任务开始前终态写入及持久恢复意图登记均失败');
      error.code = 'ARCHIVE_TASK_TERMINAL_INTENT_FAILED';
      error.cause = persistenceError;
      error.preExecutionFailure = failure;
      throw error;
    }
  }

  async run(payload = {}) {
    const policy = payload.policy || {};
    if (policy.batchPolicy !== 'reserve') {
      throw new TypeError('TaskLifecycle 只能执行 reserve policy');
    }
    if (typeof payload.execute !== 'function') throw new TypeError('execute 必须是函数');
    const resultClassifier = payload.resultClassifier || policy.resultClassifier;
    if (typeof resultClassifier !== 'function') {
      throw new TypeError('reserve task policy 必须显式提供 resultClassifier');
    }
    let startsNewFlow = Object.prototype.hasOwnProperty.call(payload, 'startsNewFlow')
      ? payload.startsNewFlow
      : policy.startsNewFlow;
    let flowIdentity = payload.flowIdentity;
    if (typeof payload.flowPlanResolver !== 'function' && typeof startsNewFlow !== 'boolean') {
      throw new TypeError('reserve task policy 必须显式提供 startsNewFlow');
    }

    const recovery = payload.recovery && typeof payload.recovery === 'object'
      ? payload.recovery
      : null;
    const persistedRecoveryContext = recovery && recovery.batchContext
      ? createWorkerBatchContext(recovery.batchContext)
      : null;
    let claimedBatchId = null;
    if (persistedRecoveryContext) {
      if (this.activeBatchIds.has(persistedRecoveryContext.batchId)) {
        return { status: 'busy', message: '该任务批次正在恢复执行' };
      }
      claimedBatchId = persistedRecoveryContext.batchId;
      this.activeBatchIds.add(claimedBatchId);
    }

    const operation = this.businessOperationRegistry.begin(payload.meta || { channel: policy.channel });
    if (!operation.accepted) {
      if (claimedBatchId !== null) this.activeBatchIds.delete(claimedBatchId);
      return {
        status: 'busy',
        message: operation.message || '当前暂时不能开始新的任务'
      };
    }

    let context = null;
    let beforeStartEvidence = null;
    let businessResult;
    let businessError = null;
    try {
      let flow = null;
      let shouldMarkStarted = true;
      let deferredLegacyRecovery = false;
      if (persistedRecoveryContext) {
        if (typeof payload.beforeStart === 'function') {
          try {
            beforeStartEvidence = await payload.beforeStart(persistedRecoveryContext);
          } catch (error) {
            return lifecycleFailure(
              error,
              'ARCHIVE_INPUT_EVIDENCE_FAILED',
              '任务输入证据重校验失败，原存档状态未改动'
            );
          }
        }
        const reopened = await this.archiveService.beginTaskRecovery(
          persistedRecoveryContext,
          { evidence: recovery.evidence || {} }
        );
        if (!reopened || reopened.ok === false) {
          return lifecycleFailure(
            reopened,
            'ARCHIVE_TASK_RECOVERY_FAILED',
            '存档任务批次无法恢复，业务未开始'
          );
        }
        context = createWorkerBatchContextFromBatch(reopened.batch);
        shouldMarkStarted = false;
      } else {
        if (typeof payload.flowPlanResolver === 'function') {
          const plan = await payload.flowPlanResolver();
          if (!plan || typeof plan.startsNewFlow !== 'boolean') {
            throw new TypeError('flowPlanResolver 必须返回 startsNewFlow:boolean');
          }
          startsNewFlow = plan.startsNewFlow;
          flowIdentity = plan.flowIdentity;
        }
        flow = await this.flowResolver.resolve({
          moduleId: policy.scopeId,
          explicitParentRunId: payload.explicitParentRunId,
          identity: flowIdentity,
          startsNewFlow
        });
        const taskRunId = String(payload.taskRunId || this.createTaskRunId()).trim();
        const operationKey = String(payload.operationKey || `${policy.taskKey}:${taskRunId}`).trim();
        const reserved = await this.archiveService.reserveTaskBatch({
          moduleId: policy.scopeId,
          moduleCode: policy.moduleCode,
          moduleName: policy.moduleName,
          taskKey: policy.taskKey,
          taskRunId,
          operationKey,
          parentRunId: flow.parentRunId,
          metadata: {
            ...(payload.metadata || {}),
            channel: policy.channel,
            flowSource: flow.source
          }
        });
        const batchId = Number(reserved && reserved.batchId);
        if (!reserved || reserved.ok === false || !Number.isSafeInteger(batchId) || batchId < 1) {
          return lifecycleFailure(
            reserved,
            'ARCHIVE_BATCH_RESERVATION_FAILED',
            '存档中心无法预留任务批次，业务未开始'
          );
        }
        context = createWorkerBatchContextFromBatch(reserved.batch);

        if (recovery && recovery.legacy === true) {
          if (this.activeBatchIds.has(context.batchId)) {
            return { status: 'busy', message: '该任务批次正在恢复执行' };
          }
          claimedBatchId = context.batchId;
          this.activeBatchIds.add(claimedBatchId);
          if (reserved.created === false && reserved.batch.taskStatus !== 'reserved') {
            deferredLegacyRecovery = true;
            shouldMarkStarted = false;
          }
        }
      }
      const batchId = context.batchId;
      this.activeTasks.set(operation.token, context);

      if (flow && flow.source === 'new' && flow.identity) {
        const initialBind = await this._settleArchiveCall({
          batchId,
          channel: policy.channel,
          code: 'ARCHIVE_FLOW_BIND_FAILED',
          message: '新业务流程身份绑定失败',
          invoke: () => this.flowResolver.bind({
            moduleId: policy.scopeId,
            parentRunId: context.parentRunId,
            sourceBatchId: context.batchId,
            identities: [flow.identity]
          })
        });
        if (!initialBind.ok) {
          await this._settlePreExecutionFailure({
            context,
            channel: policy.channel,
            message: '身份绑定失败后无法终结任务批次',
            failure: initialBind.failure
          });
          return lifecycleFailure(
            initialBind.failure,
            'ARCHIVE_FLOW_BIND_FAILED',
            '新业务流程身份绑定失败，业务未开始'
          );
        }
      }

      if (!persistedRecoveryContext && typeof payload.beforeStart === 'function') {
        try {
          beforeStartEvidence = await payload.beforeStart(context);
        } catch (error) {
          if (deferredLegacyRecovery) {
            return lifecycleFailure(
              error,
              'ARCHIVE_INPUT_EVIDENCE_FAILED',
              '任务输入证据重校验失败，原存档状态未改动'
            );
          }
          const evidenceFailure = {
            code: error && error.code || 'ARCHIVE_INPUT_EVIDENCE_FAILED',
            message: error && error.message || '任务输入证据采集失败'
          };
          await this._settlePreExecutionFailure({
            context,
            channel: policy.channel,
            message: '输入证据采集失败后无法终结任务批次',
            failure: evidenceFailure
          });
          return lifecycleFailure(
            evidenceFailure,
            'ARCHIVE_INPUT_EVIDENCE_FAILED',
            '任务输入证据采集失败，业务未开始'
          );
        }
      }

      if (deferredLegacyRecovery) {
        const reopened = await this.archiveService.beginTaskRecovery(
          context,
          { evidence: recovery.evidence || {} }
        );
        if (!reopened || reopened.ok === false) {
          return lifecycleFailure(
            reopened,
            'ARCHIVE_TASK_RECOVERY_FAILED',
            '存档任务批次无法恢复，业务未开始'
          );
        }
        context = createWorkerBatchContextFromBatch(reopened.batch);
        this.activeTasks.set(operation.token, context);
      }

      let started = { ok: true };
      if (shouldMarkStarted) {
        try {
          started = await this.archiveService.markTaskStarted(batchId);
        } catch (error) {
          started = {
            ok: false,
            code: error && error.code || 'ARCHIVE_TASK_START_FAILED',
            message: error && error.message || '任务批次无法进入运行状态'
          };
        }
      }
      if (!started || started.ok === false) {
        if (started && started.batch && started.batch.taskStatus === 'cancelled') {
          return {
            status: 'cancelled',
            code: started.code || 'ARCHIVE_TASK_ALREADY_CANCELLED',
            message: started.message || '任务在开始前已取消'
          };
        }
        const startFailure = {
          code: started && started.code || 'ARCHIVE_TASK_START_FAILED',
          message: started && started.message || '任务批次无法进入运行状态'
        };
        await this._settlePreExecutionFailure({
          context,
          channel: policy.channel,
          message: '任务开始失败后无法终结任务批次',
          failure: startFailure
        });
        return lifecycleFailure(
          startFailure,
          'ARCHIVE_TASK_START_FAILED',
          '任务批次无法进入运行状态，业务未开始'
        );
      }

      let artifactSettlementPromise = null;
      const settleArtifacts = (outcome = {}) => {
        if (artifactSettlementPromise) return artifactSettlementPromise;
        artifactSettlementPromise = (async () => {
          const outcomeResult = Object.prototype.hasOwnProperty.call(outcome, 'result')
            ? outcome.result
            : businessResult;
          const outcomeError = Object.prototype.hasOwnProperty.call(outcome, 'error')
            ? outcome.error
            : businessError;
          let runtime = payload.runtime || {};
          if (typeof payload.runtimeResolver === 'function') {
            const runtimeOutcome = await this._settleArchiveCall({
              batchId,
              channel: policy.channel,
              code: 'ARCHIVE_RUNTIME_EVIDENCE_FAILED',
              message: '任务文件证据收集失败',
              invoke: async () => ({
                ok: true,
                runtime: await payload.runtimeResolver({
                  context,
                  beforeStartEvidence,
                  result: outcomeResult,
                  error: outcomeError
                })
              })
            });
            if (runtimeOutcome.ok) runtime = runtimeOutcome.result.runtime || {};
          }
          const appendOutcome = await this._settleArchiveCall({
            batchId,
            channel: policy.channel,
            code: 'ARCHIVE_TASK_APPEND_FAILED',
            message: '任务文件登记失败',
            invoke: () => this.operationTracker.appendOperationFiles({
              batchContext: context,
              channel: policy.channel,
              args: payload.args || [],
              prepared: payload.prepared,
              selectedPaths: typeof payload.selectedPathsResolver === 'function'
                ? payload.selectedPathsResolver()
                : payload.selectedPaths,
              result: outcomeResult,
              error: outcomeError,
              runtime
            }),
            isFailure: (result) => !result || result.ok === false || result.archiveFailed === true
          });
          return {
            archiveResult: appendOutcome.result || {
              handled: true,
              archiveFailed: true,
              persistentRetryAvailable: false,
              warning: appendOutcome.failure
            },
            runtime
          };
        })();
        return artifactSettlementPromise;
      };

      try {
        businessResult = await this.contextStorage.run(
          context,
          () => payload.execute(context, { settleArtifacts })
        );
      } catch (error) {
        businessError = error;
      }

      let terminalStatus = 'failed';
      if (!businessError) {
        try {
          terminalStatus = taskResultStatus(businessResult, resultClassifier);
        } catch (error) {
          businessError = error;
        }
      }

      await settleArtifacts({ result: businessResult, error: businessError });

      if (!businessError
          && (terminalStatus === 'succeeded' || policy.bindResultFlowIdentitiesOnFailure === true)
          && typeof payload.resultFlowIdentities === 'function') {
        const identityOutcome = await this._settleArchiveCall({
          batchId,
          channel: policy.channel,
          code: 'ARCHIVE_FLOW_IDENTITY_RESOLVE_FAILED',
          message: '业务结果身份解析失败',
          invoke: async () => {
            const identities = await payload.resultFlowIdentities(businessResult, context);
            return { ok: true, identities: identities || [] };
          }
        });
        if (identityOutcome.ok && identityOutcome.result.identities.length > 0) {
          const identities = identityOutcome.result.identities;
          await this._settleArchiveCall({
            batchId,
            channel: policy.channel,
            code: 'ARCHIVE_FLOW_BIND_FAILED',
            message: '业务结果身份绑定失败',
            invoke: async () => {
              try {
                const anchors = await this.flowResolver.bind({
                  moduleId: policy.scopeId,
                  parentRunId: context.parentRunId,
                  sourceBatchId: context.batchId,
                  identities
                });
                return { ok: true, anchors };
              } catch (bindError) {
                await this.flowResolver.persistBindIntent({
                  moduleId: policy.scopeId,
                  parentRunId: context.parentRunId,
                  sourceBatchId: context.batchId,
                  identities
                });
                return {
                  ok: false,
                  code: bindError && bindError.code || 'ARCHIVE_FLOW_BIND_FAILED',
                  message: bindError && bindError.message || '业务结果身份绑定失败',
                  flowBindIntentPersisted: true
                };
              }
            }
          });
        }
      }

      let terminalMetadata = {};
      const resultMetadataResolver = payload.resultMetadataResolver
        || policy.resultMetadataResolver;
      if (typeof resultMetadataResolver === 'function') {
        const metadataOutcome = await this._settleArchiveCall({
          batchId,
          channel: policy.channel,
          code: 'ARCHIVE_RESULT_METADATA_FAILED',
          message: '任务结果元数据生成失败',
          invoke: async () => {
            const metadata = await resultMetadataResolver(businessResult, context, {
              error: businessError,
              terminalStatus
            });
            if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
              throw new TypeError('resultMetadataResolver 必须返回对象');
            }
            return { ok: true, metadata };
          }
        });
        if (metadataOutcome.ok) terminalMetadata = metadataOutcome.result.metadata;
      }

      let terminalCall;
      let terminalIntent;
      if (terminalStatus === 'cancelled') {
        terminalIntent = {
          taskStatus: 'cancelled',
          code: '',
          message: '业务任务已取消',
          metadata: terminalMetadata
        };
        terminalCall = () => this.archiveService.cancelTaskBatch(batchId, {
          reason: terminalIntent.message,
          metadata: terminalMetadata
        });
      } else if (terminalStatus === 'failed') {
        terminalIntent = {
          taskStatus: 'failed',
          code: businessError && businessError.code || 'BUSINESS_TASK_FAILED',
          message: businessError && businessError.message || (
            businessResult && businessResult.message || '业务任务失败'
          ),
          metadata: terminalMetadata
        };
        terminalCall = () => this.archiveService.failTaskBatch(batchId, {
          code: terminalIntent.code,
          message: terminalIntent.message,
          metadata: terminalMetadata
        });
      } else {
        terminalIntent = {
          taskStatus: 'succeeded',
          code: '',
          message: '',
          metadata: terminalMetadata
        };
        terminalCall = () => this.archiveService.completeTaskBatch(batchId, {
          metadata: terminalMetadata
        });
      }
      if (payload.afterTerminalIntent) {
        terminalIntent.afterTerminal = payload.afterTerminalIntent;
      }
      const terminalOutcome = await this._settleArchiveCall({
        batchId,
        channel: policy.channel,
        code: 'ARCHIVE_TASK_TERMINAL_FAILED',
        message: '任务批次终态写入失败',
        invoke: terminalCall,
        isBenignFailure: (result) => Boolean(
          result
          && result.ok === false
          && result.code === 'ARCHIVE_TASK_STATUS_CONFLICT'
        )
      });

      if (!terminalOutcome.ok) {
        let persisted = null;
        let persistenceError = null;
        try {
          if (!this.persistTerminalIntent) {
            throw new Error('任务终态意图持久化接口不可用');
          }
          persisted = await this.persistTerminalIntent({
            batchContext: context,
            sourceOperation: policy.channel,
            terminalOutcome: terminalIntent
          });
          if (!persisted || persisted.persisted !== true) {
            throw new Error('任务终态意图未形成持久记录');
          }
        } catch (error) {
          persistenceError = error;
        }
        if (persistenceError) {
          const error = new Error('任务终态写入及持久恢复意图登记均失败');
          error.code = 'ARCHIVE_TASK_TERMINAL_INTENT_FAILED';
          error.cause = persistenceError;
          error.businessResult = businessResult;
          error.businessError = businessError;
          throw error;
        }
      }

      if (terminalOutcome.ok && typeof payload.afterTerminal === 'function') {
        await this._settleArchiveCall({
          batchId,
          channel: policy.channel,
          code: 'ARCHIVE_TASK_AFTER_TERMINAL_FAILED',
          message: '任务终态后的恢复标记清理失败',
          invoke: async () => {
            await payload.afterTerminal({
              context,
              terminalStatus,
              terminalResult: terminalOutcome.result,
              businessResult,
              businessError
            });
            return { ok: true };
          }
        });
      }

      if (businessError) throw businessError;
      return businessResult;
    } finally {
      if (context) this.activeTasks.delete(operation.token);
      if (claimedBatchId !== null) this.activeBatchIds.delete(claimedBatchId);
      this.businessOperationRegistry.end(operation.token);
    }
  }

  async cancelActive(predicate = null, reason = '用户取消任务') {
    const matches = [...this.activeTasks.values()].filter((context) => (
      typeof predicate !== 'function' || predicate(context)
    ));
    if (matches.length !== 1) {
      return { status: 'not-found', cancelled: false };
    }
    const context = matches[0];
    const result = await this.archiveService.cancelTaskBatch(context.batchId, { reason });
    if (result && result.ok === false) {
      const alreadyCancelled = result.batch && result.batch.taskStatus === 'cancelled';
      return {
        status: alreadyCancelled ? 'cancelled' : 'conflict',
        cancelled: alreadyCancelled,
        context
      };
    }
    return { status: 'cancelled', cancelled: true, context };
  }
}

function createTaskLifecycle(options) {
  return new TaskLifecycle(options);
}

module.exports = {
  TERMINAL_TASK_STATUSES,
  TaskLifecycle,
  createTaskLifecycle,
  createWorkerBatchContext,
  taskResultStatus
};
