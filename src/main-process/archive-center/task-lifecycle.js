'use strict';

const crypto = require('node:crypto');
const { AsyncLocalStorage } = require('node:async_hooks');
const { freezeWorkerBatchContext } = require('./worker-batch-context');
const { freezeWorkerOperationContext } = require('./worker-operation-context');
const {
  artifactManifestFromFilePlan,
  assertFilePlanFresh
} = require('./file-plan');
const { normalizeLineageIntentsV1 } = require('./task-lineage');

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

function createWorkerOperationContextFromTask(taskRun) {
  if (!taskRun || typeof taskRun !== 'object') {
    throw new TypeError('Task Run 身份缺失');
  }
  return freezeWorkerOperationContext({
    taskRunId: taskRun.taskRunId,
    taskKey: taskRun.taskKey,
    moduleId: taskRun.moduleId,
    parentRunId: taskRun.parentRunId,
    operationKey: taskRun.operationKey
  }, { required: true });
}

function lifecycleFailure(result, fallbackCode, fallbackMessage) {
  return {
    status: 'failed',
    code: String(result && result.code || fallbackCode),
    message: String(result && result.message || fallbackMessage)
  };
}

function taskPayloadMetadata(value) {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('task metadata 必须是对象');
  }
  return value;
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
      'beginTaskRun',
      'markTaskRunStarted',
      'finishTaskRun',
      'reserveFileTaskBatch',
      'beginFileTaskRecovery',
      'startFileTask',
      'settleManifestArtifacts',
      'finishFileTask',
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
    this.activeFileTaskRunIds = new Set();
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

  async _finishOperationTask(context, channel, terminalOutcome) {
    let result;
    try {
      result = await this.archiveService.finishTaskRun(
        context.taskRunId,
        terminalOutcome
      );
    } catch (error) {
      result = {
        ok: false,
        code: error && error.code || 'ARCHIVE_TASK_TERMINAL_FAILED',
        message: error && error.message || 'Task Run 终态写入失败'
      };
    }
    if (result && result.ok !== false) return { ok: true, result };
    const current = result && result.taskRun;
    if (result && result.code === 'ARCHIVE_TASK_STATUS_CONFLICT'
        && current) {
      return current.status === terminalOutcome.taskStatus
        ? { ok: true, benign: true, result }
        : { ok: false, conflict: true, result };
    }
    if (!this.persistTerminalIntent) {
      const error = new Error('Task Run 终态写入失败且持久恢复接口不可用');
      error.code = 'ARCHIVE_TASK_TERMINAL_INTENT_FAILED';
      throw error;
    }
    const persisted = await this.persistTerminalIntent({
      owner: {
        version: 1,
        kind: 'operation',
        operationContext: context
      },
      sourceOperation: channel,
      terminalOutcome: {
        ...terminalOutcome,
        metadata: terminalOutcome.metadata || {}
      }
    });
    if (!persisted || persisted.persisted !== true) {
      const error = new Error('Task Run 终态意图未形成持久记录');
      error.code = 'ARCHIVE_TASK_TERMINAL_INTENT_FAILED';
      throw error;
    }
    return { ok: false, persisted: true, result };
  }

  async _finishFileTask(context, channel, terminalOutcome) {
    let result;
    try {
      result = await this.archiveService.finishFileTask(
        context.taskRunId,
        context.batchId,
        terminalOutcome
      );
    } catch (error) {
      result = {
        ok: false,
        code: error && error.code || 'ARCHIVE_TASK_TERMINAL_FAILED',
        message: error && error.message || 'File Task 终态写入失败'
      };
    }
    if (result && result.ok !== false) return { ok: true, result };
    const current = result && result.taskRun;
    if (result && result.code === 'ARCHIVE_TASK_STATUS_CONFLICT'
        && current) {
      return current.status === terminalOutcome.taskStatus
        ? { ok: true, benign: true, result }
        : { ok: false, conflict: true, result };
    }
    if (!this.persistTerminalIntent) {
      const error = new Error('File Task 终态写入失败且持久恢复接口不可用');
      error.code = 'ARCHIVE_TASK_TERMINAL_INTENT_FAILED';
      throw error;
    }
    const persisted = await this.persistTerminalIntent({
      owner: {
        version: 1,
        kind: 'file-batch',
        batchContext: context
      },
      sourceOperation: channel,
      terminalOutcome
    });
    if (!persisted || persisted.persisted !== true) {
      const error = new Error('File Task 终态意图未形成持久记录');
      error.code = 'ARCHIVE_TASK_TERMINAL_INTENT_FAILED';
      throw error;
    }
    return { ok: false, persisted: true, result };
  }

  async runFileTask(payload = {}) {
    const policy = payload.policy || {};
    if (policy.batchPolicy !== 'reserve' || policy.taskKind !== 'file') {
      throw new TypeError('runFileTask 只能执行 file reserve policy');
    }
    if (policy.allocation !== 'eager') {
      throw new TypeError('runFileTask 当前入口只接受 eager file policy');
    }
    if (typeof payload.execute !== 'function') throw new TypeError('execute 必须是函数');
    if (typeof payload.filePlanResolver !== 'function') {
      throw new TypeError('file task 必须显式提供 filePlanResolver');
    }
    const payloadMetadata = taskPayloadMetadata(payload.metadata);
    const resultClassifier = payload.resultClassifier || policy.resultClassifier;
    const operation = this.businessOperationRegistry.begin(payload.meta || { channel: policy.channel });
    if (!operation.accepted) {
      return { status: 'busy', message: operation.message || '当前暂时不能开始新的任务' };
    }
    let context = null;
    try {
      const recoveryContext = payload.recovery && payload.recovery.batchContext
        ? createWorkerBatchContext(payload.recovery.batchContext)
        : null;
      let flow = null;
      let begun;
      let lineageIntents = Object.freeze([]);
      if (recoveryContext) {
        begun = {
          ok: true,
          taskRun: {
            taskRunId: recoveryContext.taskRunId,
            moduleId: recoveryContext.moduleId,
            taskKey: recoveryContext.taskKey,
            operationKey: recoveryContext.operationKey,
            parentRunId: recoveryContext.parentRunId
          }
        };
      } else {
        const flowPlan = typeof payload.flowPlanResolver === 'function'
          ? await payload.flowPlanResolver()
          : { startsNewFlow: policy.startsNewFlow, flowIdentity: payload.flowIdentity };
        if (!flowPlan || typeof flowPlan.startsNewFlow !== 'boolean') {
          throw new TypeError('flowPlanResolver 必须返回 startsNewFlow:boolean');
        }
        flow = await this.flowResolver.resolve({
          moduleId: policy.scopeId,
          explicitParentRunId: payload.explicitParentRunId,
          identity: flowPlan.flowIdentity,
          startsNewFlow: flowPlan.startsNewFlow
        });
        const taskRunId = String(payload.taskRunId || this.createTaskRunId()).trim();
        const operationKey = String(payload.operationKey || `${policy.taskKey}:${taskRunId}`).trim();
        lineageIntents = normalizeLineageIntentsV1(
          typeof payload.lineageIntentsResolver === 'function'
            ? await payload.lineageIntentsResolver({ flow, taskRunId, operationKey })
            : payload.lineageIntents
        );
        begun = await this.archiveService.beginTaskRun({
          taskRunId,
          moduleId: policy.scopeId,
          taskKey: policy.taskKey,
          operationKey,
          parentRunId: flow.parentRunId,
          metadata: { ...payloadMetadata, channel: policy.channel, flowSource: flow.source },
          lineageIntents
        });
        if (!begun || begun.ok === false || !begun.taskRun) {
          return lifecycleFailure(begun, 'ARCHIVE_TASK_RUN_BEGIN_FAILED', '内部 Task Run 建立失败');
        }
      }
      let filePlan;
      let manifest;
      try {
        filePlan = await payload.filePlanResolver({ taskRun: begun.taskRun });
        manifest = artifactManifestFromFilePlan(filePlan);
      } catch (error) {
        if (!recoveryContext) {
          await this._finishOperationTask(
            createWorkerOperationContextFromTask(begun.taskRun),
            policy.channel,
            {
              taskStatus: 'failed',
              code: error.code || 'ARCHIVE_FILE_PLAN_INVALID',
              message: error.message || 'FilePlan 形成失败',
              metadata: {}
            }
          );
        }
        return lifecycleFailure(error, 'ARCHIVE_FILE_PLAN_INVALID', 'FilePlan 形成失败');
      }
      if (recoveryContext) {
        try {
          assertFilePlanFresh(filePlan);
        } catch (error) {
          return lifecycleFailure(error, error.code, error.message);
        }
      }
      const reserved = recoveryContext
        ? await this.archiveService.beginFileTaskRecovery(recoveryContext, {
            manifestIdentity: manifest.identity
          })
        : await this.archiveService.reserveFileTaskBatch({
            taskRun: begun.taskRun,
            manifest,
            moduleCode: policy.moduleCode,
            moduleName: policy.moduleName,
            metadata: { ...payloadMetadata, channel: policy.channel, flowSource: flow.source }
          });
      if (!reserved || reserved.ok === false || !reserved.batch) {
        if (!recoveryContext) {
          await this._finishOperationTask(
            createWorkerOperationContextFromTask(begun.taskRun),
            policy.channel,
            {
              taskStatus: 'failed',
              code: reserved && reserved.code || 'ARCHIVE_BATCH_RESERVATION_FAILED',
              message: reserved && reserved.message || 'File Batch 原子预留失败',
              metadata: {}
            }
          );
        }
        return lifecycleFailure(reserved, 'ARCHIVE_BATCH_RESERVATION_FAILED', 'File Batch 原子预留失败');
      }
      context = createWorkerBatchContextFromBatch(reserved.batch);
      this.activeTasks.set(operation.token, context);
      this.activeBatchIds.add(context.batchId);
      this.activeFileTaskRunIds.add(context.taskRunId);

      if (!recoveryContext && flow.source === 'new' && flow.identity) {
        const initialBind = await this._bindOperationFlowIdentities(
          createWorkerOperationContextFromTask(begun.taskRun),
          policy,
          [flow.identity]
        );
        if (initialBind.persisted || !initialBind.ok) {
          const error = initialBind.error || initialBind.bindError;
          await this._finishFileTask(context, policy.channel, {
            taskStatus: 'failed',
            code: error.code || 'ARCHIVE_FLOW_BIND_FAILED',
            message: error.message || '新业务流程身份绑定失败',
            metadata: {}
          });
          return lifecycleFailure(error, 'ARCHIVE_FLOW_BIND_FAILED', '新业务流程身份绑定失败');
        }
      }

      let fileEvidence = Object.freeze({
        filePlan,
        inputFiles: filePlan.inputs,
        targetSnapshots: Object.freeze(filePlan.outputs.map((item) => item.targetSnapshot))
      });
      try {
        if (!recoveryContext) assertFilePlanFresh(filePlan);
      } catch (error) {
        await this._finishFileTask(context, policy.channel, {
          taskStatus: 'failed',
          code: error.code,
          message: error.message,
          metadata: {}
        });
        return lifecycleFailure(error, error.code, error.message);
      }
      if (typeof payload.beforeStart === 'function') {
        try {
          const evidence = await payload.beforeStart(context, fileEvidence);
          if (evidence !== undefined) {
            if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) {
              throw new TypeError('beforeStart evidence 必须是对象');
            }
            fileEvidence = Object.freeze({ ...fileEvidence, ...evidence });
          }
        } catch (error) {
          await this._finishFileTask(context, policy.channel, {
            taskStatus: 'failed',
            code: error.code || 'ARCHIVE_INPUT_EVIDENCE_FAILED',
            message: error.message || '文件 evidence 采集失败',
            metadata: {}
          });
          return lifecycleFailure(error, 'ARCHIVE_INPUT_EVIDENCE_FAILED', '文件 evidence 采集失败');
        }
      }
      const started = await this.archiveService.startFileTask(context.taskRunId, context.batchId);
      if (!started || started.ok === false) {
        await this._finishFileTask(context, policy.channel, {
          taskStatus: 'failed',
          code: started && started.code || 'ARCHIVE_TASK_START_FAILED',
          message: started && started.message || 'File Task 无法开始',
          metadata: {}
        });
        return lifecycleFailure(started, 'ARCHIVE_TASK_START_FAILED', 'File Task 无法开始');
      }

      let settlementPromise = null;
      let settlementFiles = [];
      const settleArtifacts = (outcome = {}) => {
        if (!settlementPromise) {
          settlementFiles = Array.isArray(outcome.files) ? outcome.files : [];
          settlementPromise = this.archiveService.settleManifestArtifacts({
            batchContext: context,
            files: settlementFiles
          });
        }
        return settlementPromise;
      };
      let businessResult;
      let businessError = null;
      try {
        businessResult = await this.contextStorage.run(
          context,
          () => payload.execute(context, { fileEvidence, lineageIntents, settleArtifacts })
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
      // Main owner 可在任何自动 artifact/终态写入前核对外部提交事实。
      // 拒绝时保留原 running Task，由已登记的恢复 owner 继续观察；不推测失败。
      if (typeof payload.beforeTerminalSettlement === 'function') {
        await payload.beforeTerminalSettlement({ context, businessResult, businessError });
      }
      const settled = await settleArtifacts({
        files: filePlan.inputs.map((item) => ({ artifactKey: item.artifactKey }))
      });
      if (!settled || settled.ok === false) {
        this._warn({
          channel: policy.channel,
          code: settled && settled.code || 'ARCHIVE_TASK_SETTLE_FAILED',
          message: settled && settled.message || 'manifest artifact 未全部完成归档'
        });
      }

      if (!businessError && terminalStatus === 'succeeded'
          && typeof payload.resultFlowIdentities === 'function') {
        try {
          const identities = await payload.resultFlowIdentities(businessResult, context);
          if (identities && identities.length) {
            const resultBind = await this._bindFileFlowIdentities(context, policy, identities);
            if (resultBind.persisted) {
              this._warn({
                channel: policy.channel,
                code: resultBind.bindError.code || 'ARCHIVE_FLOW_BIND_FAILED',
                message: resultBind.bindError.message || '业务结果身份绑定失败'
              });
            } else if (!resultBind.ok) {
              businessError = resultBind.error;
              terminalStatus = 'failed';
            }
          }
        } catch (error) {
          this._warn({
            channel: policy.channel,
            code: error.code || 'ARCHIVE_FLOW_BIND_FAILED',
            message: error.message || '业务结果身份绑定失败'
          });
        }
      }
      let terminalMetadata = {};
      const metadataResolver = payload.resultMetadataResolver || policy.resultMetadataResolver;
      if (typeof metadataResolver === 'function') {
        try {
          const resolvedMetadata = await metadataResolver(
            businessResult,
            context,
            { error: businessError, terminalStatus }
          );
          if (!resolvedMetadata || typeof resolvedMetadata !== 'object'
              || Array.isArray(resolvedMetadata)) {
            throw new TypeError('resultMetadataResolver 必须返回对象');
          }
          terminalMetadata = resolvedMetadata;
        } catch (error) {
          this._warn({ channel: policy.channel, code: error.code, message: error.message });
        }
      }
      const terminalOutcome = terminalStatus === 'cancelled'
        ? { taskStatus: 'cancelled', code: '', message: '业务任务已取消', metadata: terminalMetadata }
        : terminalStatus === 'failed'
          ? {
              taskStatus: 'failed',
              code: businessError && businessError.code || 'BUSINESS_TASK_FAILED',
              message: businessError && businessError.message
                || businessResult && businessResult.message || '业务任务失败',
              metadata: terminalMetadata
            }
          : { taskStatus: 'succeeded', code: '', message: '', metadata: terminalMetadata };
      if (payload.afterTerminalIntent) {
        terminalOutcome.afterTerminal = payload.afterTerminalIntent;
      }
      let terminalSettled = false;
      if (terminalStatus === 'succeeded' && (!settled || settled.durable !== true)) {
        if (!this.persistTerminalIntent) {
          const error = new Error('File Task artifact 未 durable 且持久恢复接口不可用');
          error.code = 'ARCHIVE_TASK_TERMINAL_INTENT_FAILED';
          throw error;
        }
        const persisted = await this.persistTerminalIntent({
          owner: {
            version: 1,
            kind: 'file-batch',
            batchContext: context
          },
          sourceOperation: policy.channel,
          settleFiles: settlementFiles,
          terminalOutcome
        });
        if (!persisted || persisted.persisted !== true) {
          const error = new Error('File Task artifact 未 durable 且未形成恢复记录');
          error.code = 'ARCHIVE_TASK_TERMINAL_INTENT_FAILED';
          throw error;
        }
      } else {
        const finished = await this._finishFileTask(context, policy.channel, terminalOutcome);
        terminalSettled = finished.ok === true;
      }
      if (terminalSettled && typeof payload.afterTerminal === 'function') {
        try {
          await payload.afterTerminal({ context, terminalStatus, businessResult, businessError });
        } catch (error) {
          this._warn({
            channel: policy.channel,
            code: error.code || 'ARCHIVE_TASK_AFTER_TERMINAL_FAILED',
            message: error.message || '任务终态后清理失败'
          });
        }
      }
      if (businessError) throw businessError;
      return businessResult;
    } finally {
      if (context) {
        this.activeTasks.delete(operation.token);
        this.activeBatchIds.delete(context.batchId);
        this.activeFileTaskRunIds.delete(context.taskRunId);
      }
      this.businessOperationRegistry.end(operation.token);
    }
  }

  async _bindFileFlowIdentities(context, policy, identities) {
    try {
      const anchors = await this.flowResolver.bind({
        moduleId: policy.scopeId,
        parentRunId: context.parentRunId,
        sourceBatchId: context.batchId,
        identities
      });
      return { ok: true, anchors };
    } catch (bindError) {
      try {
        const intents = await this.flowResolver.persistBindIntent({
          moduleId: policy.scopeId,
          parentRunId: context.parentRunId,
          sourceBatchId: context.batchId,
          identities
        });
        return { ok: true, persisted: true, intents, bindError };
      } catch (persistenceError) {
        persistenceError.bindError = bindError;
        return { ok: false, error: persistenceError };
      }
    }
  }

  async _bindOperationFlowIdentities(context, policy, identities) {
    try {
      const anchors = await this.flowResolver.bind({
        moduleId: policy.scopeId,
        parentRunId: context.parentRunId,
        sourceTaskRunId: context.taskRunId,
        sourceBatchId: null,
        identities
      });
      return { ok: true, anchors };
    } catch (bindError) {
      try {
        const intents = await this.flowResolver.persistBindIntent({
          moduleId: policy.scopeId,
          parentRunId: context.parentRunId,
          sourceTaskRunId: context.taskRunId,
          sourceBatchId: null,
          identities
        });
        return { ok: true, persisted: true, intents, bindError };
      } catch (persistenceError) {
        persistenceError.bindError = bindError;
        return { ok: false, error: persistenceError };
      }
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
    const payloadMetadata = taskPayloadMetadata(payload.metadata);
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
            ...payloadMetadata,
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

  async runOperationOnly(payload = {}) {
    return this._runTaskWithoutInitialBatch(payload, false);
  }

  async runDeferredFileTask(payload = {}) {
    return this._runTaskWithoutInitialBatch(payload, true);
  }

  async _runTaskWithoutInitialBatch(payload = {}, deferredFile = false) {
    const policy = payload.policy || {};
    if (deferredFile) {
      if (policy.batchPolicy !== 'reserve'
          || policy.taskKind !== 'file'
          || policy.allocation !== 'deferred') {
        throw new TypeError('runDeferredFileTask 只能执行 deferred file policy');
      }
    } else if (policy.batchPolicy !== 'no-file' || policy.taskKind !== 'no-file') {
      throw new TypeError('runOperationOnly 只能执行 no-file policy');
    }
    if (deferredFile && typeof payload.filePlanResolver !== 'function') {
      throw new TypeError('deferred file task 必须显式提供 filePlanResolver');
    }
    const preparedFilePlan = payload.prepared && payload.prepared.filePlan;
    if (!deferredFile && preparedFilePlan) {
      throw new TypeError('no-file policy 不能丢弃 filePlan');
    }
    if (typeof payload.execute !== 'function') throw new TypeError('execute 必须是函数');
    const payloadMetadata = taskPayloadMetadata(payload.metadata);
    const resultClassifier = payload.resultClassifier || policy.resultClassifier;
    let startsNewFlow = Object.prototype.hasOwnProperty.call(payload, 'startsNewFlow')
      ? payload.startsNewFlow
      : policy.startsNewFlow;
    let flowIdentity = payload.flowIdentity;
    const operation = this.businessOperationRegistry.begin(payload.meta || { channel: policy.channel });
    if (!operation.accepted) {
      return { status: 'busy', message: operation.message || '当前暂时不能开始新的任务' };
    }
    let context = null;
    let batchContext = null;
    let promotedManifest = null;
    try {
      if (typeof payload.flowPlanResolver === 'function') {
        const plan = await payload.flowPlanResolver();
        if (!plan || typeof plan.startsNewFlow !== 'boolean') {
          throw new TypeError('flowPlanResolver 必须返回 startsNewFlow:boolean');
        }
        startsNewFlow = plan.startsNewFlow;
        flowIdentity = plan.flowIdentity;
      }
      const flow = await this.flowResolver.resolve({
        moduleId: policy.scopeId,
        explicitParentRunId: payload.explicitParentRunId,
        identity: flowIdentity,
        startsNewFlow
      });
      const taskRunId = String(payload.taskRunId || this.createTaskRunId()).trim();
      const operationKey = String(payload.operationKey || `${policy.taskKey}:${taskRunId}`).trim();
      const lineageIntents = normalizeLineageIntentsV1(
        typeof payload.lineageIntentsResolver === 'function'
          ? await payload.lineageIntentsResolver({ flow, taskRunId, operationKey })
          : payload.lineageIntents
      );
      const begun = await this.archiveService.beginTaskRun({
        taskRunId,
        moduleId: policy.scopeId,
        taskKey: policy.taskKey,
        operationKey,
        parentRunId: flow.parentRunId,
        metadata: {
          ...payloadMetadata,
          channel: policy.channel,
          flowSource: flow.source
        },
        lineageIntents
      });
      if (!begun || begun.ok === false || !begun.taskRun) {
        return lifecycleFailure(begun, 'ARCHIVE_TASK_RUN_BEGIN_FAILED', '内部 Task Run 建立失败');
      }
      let initialFilePlan = preparedFilePlan;
      if (deferredFile) {
        try {
          initialFilePlan = await payload.filePlanResolver({ taskRun: begun.taskRun });
          if (!initialFilePlan) throw new TypeError('deferred filePlan resolver 未返回 plan');
        } catch (error) {
          await this._finishOperationTask(
            createWorkerOperationContextFromTask(begun.taskRun),
            policy.channel,
            {
              taskStatus: 'failed',
              code: error.code || 'ARCHIVE_FILE_PLAN_INVALID',
              message: error.message || 'Deferred FilePlan 形成失败',
              metadata: {}
            }
          );
          return lifecycleFailure(error, 'ARCHIVE_FILE_PLAN_INVALID', 'Deferred FilePlan 形成失败');
        }
      }
      context = createWorkerOperationContextFromTask(begun.taskRun);
      this.activeTasks.set(operation.token, context);

      if (flow.source === 'new' && flow.identity) {
        const initialBind = await this._bindOperationFlowIdentities(
          context,
          policy,
          [flow.identity]
        );
        if (initialBind.persisted || !initialBind.ok) {
          const error = initialBind.error || initialBind.bindError;
          await this._finishOperationTask(context, policy.channel, {
            taskStatus: 'failed',
            code: error.code || 'ARCHIVE_FLOW_BIND_FAILED',
            message: error.message || '新业务流程身份绑定失败'
          });
          return lifecycleFailure(error, 'ARCHIVE_FLOW_BIND_FAILED', '新业务流程身份绑定失败');
        }
      }

      let fileEvidence = deferredFile
        ? Object.freeze({
            filePlan: initialFilePlan,
            inputFiles: initialFilePlan.inputs,
            targetSnapshots: Object.freeze([])
          })
        : Object.freeze({});
      if (typeof payload.beforeStart === 'function') {
        try {
          const evidence = await payload.beforeStart(context);
          if (evidence !== undefined) {
            if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) {
              throw new TypeError('beforeStart evidence 必须是对象');
            }
            fileEvidence = Object.freeze({ ...fileEvidence, ...evidence });
          }
        } catch (error) {
          await this._finishOperationTask(context, policy.channel, {
            taskStatus: 'failed',
            code: error.code || 'ARCHIVE_INPUT_EVIDENCE_FAILED',
            message: error.message || '任务输入证据采集失败'
          });
          return lifecycleFailure(error, 'ARCHIVE_INPUT_EVIDENCE_FAILED', '任务输入证据采集失败');
        }
      }
      const started = await this.archiveService.markTaskRunStarted(context.taskRunId);
      if (!started || started.ok === false) {
        await this._finishOperationTask(context, policy.channel, {
          taskStatus: 'failed',
          code: started && started.code || 'ARCHIVE_TASK_START_FAILED',
          message: started && started.message || 'Task Run 无法进入运行状态'
        });
        return lifecycleFailure(started, 'ARCHIVE_TASK_START_FAILED', 'Task Run 无法进入运行状态');
      }

      let settlementPromise = null;
      let settlementFiles = [];
      const ensureFileBatch = async (manifest) => {
        const reserved = await this.archiveService.reserveFileTaskBatch({
          taskRun: begun.taskRun,
          manifest,
          moduleCode: policy.moduleCode,
          moduleName: policy.moduleName,
          metadata: { ...payloadMetadata, channel: policy.channel, flowSource: flow.source }
        });
        if (!reserved || reserved.ok === false || !reserved.batch) {
          const error = new Error(
            reserved && reserved.message || 'Deferred File Batch 原子预留失败'
          );
          error.code = reserved && reserved.code || 'ARCHIVE_BATCH_RESERVATION_FAILED';
          throw error;
        }
        batchContext = createWorkerBatchContextFromBatch(reserved.batch);
        promotedManifest = manifest;
        const promotedPlan = Object.freeze({
          version: 1,
          allocation: 'eager',
          inputs: manifest.inputs,
          outputs: manifest.outputs
        });
        assertFilePlanFresh(promotedPlan);
        this.activeTasks.set(operation.token, batchContext);
        this.activeBatchIds.add(batchContext.batchId);
        this.activeFileTaskRunIds.add(batchContext.taskRunId);
        return batchContext;
      };
      const settleArtifacts = (outcome = {}) => {
        if (!batchContext) return Promise.resolve({ handled: false });
        if (!settlementPromise) {
          settlementFiles = Array.isArray(outcome.files) ? outcome.files : [];
          settlementPromise = this.archiveService.settleManifestArtifacts({
            batchContext,
            files: settlementFiles
          });
        }
        return settlementPromise;
      };
      let businessResult;
      let businessError = null;
      try {
        businessResult = await this.contextStorage.run(
          context,
          () => payload.execute(context, {
            fileEvidence,
            lineageIntents,
            ensureFileBatch: deferredFile ? ensureFileBatch : undefined,
            settleArtifacts
          })
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
      // 无文件任务与 File Task 使用同一提交观察合同；拒绝时保留原任务给恢复 owner。
      if (typeof payload.beforeTerminalSettlement === 'function') {
        await payload.beforeTerminalSettlement({ context, businessResult, businessError });
      }
      let settled = { handled: false };
      if (batchContext) {
        settled = await settleArtifacts({
          files: promotedManifest.inputs.map((item) => ({ artifactKey: item.artifactKey }))
        });
        if (!settled || settled.ok === false) {
          this._warn({
            channel: policy.channel,
            code: settled && settled.code || 'ARCHIVE_TASK_SETTLE_FAILED',
            message: settled && settled.message || 'manifest artifact 未全部完成归档'
          });
        }
      }

      let resultIdentityFailure = null;
      if (!businessError
          && (terminalStatus === 'succeeded' || policy.bindResultFlowIdentitiesOnFailure === true)
          && typeof payload.resultFlowIdentities === 'function') {
        let identities = null;
        try {
          identities = await payload.resultFlowIdentities(businessResult, context);
        } catch (error) {
          this._warn({
            channel: policy.channel,
            code: error.code || 'ARCHIVE_FLOW_IDENTITY_RESOLVE_FAILED',
            message: error.message || '业务结果身份解析失败'
          });
        }
        if (identities && identities.length) {
          const resultBind = batchContext
            ? await this._bindFileFlowIdentities(batchContext, policy, identities)
            : await this._bindOperationFlowIdentities(context, policy, identities);
          if (resultBind.persisted) {
            this._warn({
              channel: policy.channel,
              code: resultBind.bindError.code || 'ARCHIVE_FLOW_BIND_FAILED',
              message: resultBind.bindError.message || '业务结果身份绑定失败'
            });
          } else if (!resultBind.ok) {
            resultIdentityFailure = resultBind.error;
            terminalStatus = 'failed';
            this._warn({
              channel: policy.channel,
              code: resultBind.error.code || 'ARCHIVE_FLOW_BIND_INTENT_FAILED',
              message: resultBind.error.message || '业务结果身份持久化失败'
            });
          }
        }
      }

      let terminalMetadata = {};
      const resultMetadataResolver = payload.resultMetadataResolver
        || policy.resultMetadataResolver;
      if (typeof resultMetadataResolver === 'function') {
        try {
          const resolvedMetadata = await resultMetadataResolver(
            businessResult,
            context,
            { error: businessError, terminalStatus }
          );
          if (!resolvedMetadata || typeof resolvedMetadata !== 'object'
              || Array.isArray(resolvedMetadata)) {
            throw new TypeError('resultMetadataResolver 必须返回对象');
          }
          terminalMetadata = resolvedMetadata;
        } catch (error) {
          this._warn({
            channel: policy.channel,
            code: error.code || 'ARCHIVE_RESULT_METADATA_FAILED',
            message: error.message || '任务结果元数据生成失败'
          });
        }
      }

      const terminalIntent = terminalStatus === 'cancelled'
        ? {
            taskStatus: 'cancelled',
            code: '',
            message: '业务任务已取消',
            metadata: terminalMetadata
          }
        : terminalStatus === 'failed'
          ? {
              taskStatus: 'failed',
              code: resultIdentityFailure && resultIdentityFailure.code
                || businessError && businessError.code
                || 'BUSINESS_TASK_FAILED',
              message: resultIdentityFailure && resultIdentityFailure.message
                || businessError && businessError.message
                || businessResult && businessResult.message
                || '业务任务失败',
              metadata: terminalMetadata
            }
          : {
              taskStatus: 'succeeded',
              code: '',
              message: '',
              metadata: terminalMetadata
            };
      if (payload.afterTerminalIntent) {
        terminalIntent.afterTerminal = payload.afterTerminalIntent;
      }
      let finished;
      if (batchContext && terminalStatus === 'succeeded' && settled.durable !== true) {
        if (!this.persistTerminalIntent) {
          const error = new Error('Deferred File Task artifact 未 durable 且持久恢复接口不可用');
          error.code = 'ARCHIVE_TASK_TERMINAL_INTENT_FAILED';
          throw error;
        }
        const persisted = await this.persistTerminalIntent({
          owner: { version: 1, kind: 'file-batch', batchContext },
          sourceOperation: policy.channel,
          settleFiles: settlementFiles,
          terminalOutcome: terminalIntent
        });
        if (!persisted || persisted.persisted !== true) {
          const error = new Error('Deferred File Task artifact 未 durable 且未形成恢复记录');
          error.code = 'ARCHIVE_TASK_TERMINAL_INTENT_FAILED';
          throw error;
        }
        finished = { ok: false, persisted: true };
      } else {
        finished = batchContext
          ? await this._finishFileTask(batchContext, policy.channel, terminalIntent)
          : await this._finishOperationTask(context, policy.channel, terminalIntent);
      }
      if (finished.ok === true && typeof payload.afterTerminal === 'function') {
        try {
          await payload.afterTerminal({
            context: batchContext || context,
            terminalStatus,
            businessResult,
            businessError
          });
        } catch (error) {
          this._warn({
            channel: policy.channel,
            code: error.code || 'ARCHIVE_TASK_AFTER_TERMINAL_FAILED',
            message: error.message || '任务终态后清理失败'
          });
        }
      }
      if (businessError) throw businessError;
      return businessResult;
    } finally {
      if (context) this.activeTasks.delete(operation.token);
      if (batchContext) {
        this.activeBatchIds.delete(batchContext.batchId);
        this.activeFileTaskRunIds.delete(batchContext.taskRunId);
      }
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
    const operationOnly = !Object.prototype.hasOwnProperty.call(context, 'batchId');
    const fileTask = !operationOnly && this.activeFileTaskRunIds.has(context.taskRunId);
    const terminalOutcome = {
      taskStatus: 'cancelled',
      code: '',
      message: reason,
      metadata: {}
    };
    const result = operationOnly
      ? await this.archiveService.finishTaskRun(context.taskRunId, terminalOutcome)
      : fileTask
        ? await this.archiveService.finishFileTask(
            context.taskRunId,
            context.batchId,
            terminalOutcome
          )
        : await this.archiveService.cancelTaskBatch(context.batchId, { reason });
    if (result && result.ok === false) {
      const alreadyCancelled = operationOnly
        ? result.taskRun && result.taskRun.status === 'cancelled'
        : fileTask
          ? result.taskRun && result.taskRun.status === 'cancelled'
          : result.batch && result.batch.taskStatus === 'cancelled';
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
  createWorkerOperationContextFromTask,
  taskResultStatus
};
