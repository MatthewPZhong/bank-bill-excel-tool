'use strict';

const {
  normalizeFilePlanV1
} = require('./file-plan');

const EMPTY_FILE_EVIDENCE = Object.freeze({});
const EMPTY_LINEAGE_INTENTS = Object.freeze([]);

function normalizeIpcTaskHandler(handler) {
  if (typeof handler === 'function') {
    return {
      prepare: null,
      execute: (event, _prepared, _taskContext, ...args) => handler(event, ...args)
    };
  }
  if (!handler || typeof handler !== 'object' || typeof handler.execute !== 'function') {
    throw new TypeError('IPC task handler 必须是函数或 { prepare, execute }');
  }
  if (handler.prepare !== undefined && typeof handler.prepare !== 'function') {
    throw new TypeError('IPC task handler.prepare 必须是函数');
  }
  return { prepare: handler.prepare || null, execute: handler.execute };
}

function createIpcTaskContext(ownerContext, controls = {}) {
  if (typeof controls.settleArtifacts !== 'function') {
    throw new TypeError('IPC taskContext.settleArtifacts 缺失');
  }
  const batchContext = ownerContext && Object.prototype.hasOwnProperty.call(ownerContext, 'batchId')
    ? ownerContext
    : null;
  const operationContext = batchContext
    ? Object.freeze({
        taskRunId: batchContext.taskRunId,
        taskKey: batchContext.taskKey,
        moduleId: batchContext.moduleId,
        parentRunId: batchContext.parentRunId,
        operationKey: batchContext.operationKey
      })
    : ownerContext;
  return Object.freeze({
    operationContext,
    batchContext,
    lineageIntents: controls.lineageIntents || EMPTY_LINEAGE_INTENTS,
    fileEvidence: controls.fileEvidence !== undefined
      ? controls.fileEvidence
      : EMPTY_FILE_EVIDENCE,
    ensureFileBatch: typeof controls.ensureFileBatch === 'function'
      ? controls.ensureFileBatch
      : async () => {
          throw new TypeError('当前 task 不支持 deferred file batch promotion');
        },
    settleArtifacts: controls.settleArtifacts
  });
}

function executeIpcTaskInvocation(contract, event, prepared, args, taskContext) {
  if (!contract || typeof contract.execute !== 'function') {
    throw new TypeError('IPC task contract.execute 缺失');
  }
  if (!Array.isArray(args)) throw new TypeError('IPC task execute args 必须是数组');
  return contract.execute(event, prepared, taskContext, ...args);
}

async function prepareIpcTaskInvocation(contract, event, args) {
  if (!contract.prepare) {
    return { proceed: true, args: args.slice(), inputPaths: [], outputPaths: [] };
  }
  const prepared = await contract.prepare(event, ...args);
  if (!prepared || typeof prepared !== 'object' || Array.isArray(prepared)) {
    throw new TypeError('IPC task prepare 必须返回对象');
  }
  if (typeof prepared.proceed !== 'boolean') {
    throw new TypeError('IPC task prepare 必须显式返回 proceed:true|false');
  }
  if (!prepared.proceed) {
    return {
      proceed: false,
      result: prepared.result === undefined ? { status: 'cancelled' } : prepared.result
    };
  }
  const filePlan = prepared.filePlan === undefined
    ? undefined
    : normalizeFilePlanV1(prepared.filePlan);
  return {
    ...prepared,
    ...(filePlan ? { filePlan } : {}),
    proceed: true,
    args: Array.isArray(prepared.args) ? prepared.args : args.slice(),
    inputPaths: Array.isArray(prepared.inputPaths)
      ? prepared.inputPaths.slice()
      : (Array.isArray(prepared.selectedPaths) ? prepared.selectedPaths.slice() : []),
    outputPaths: Array.isArray(prepared.outputPaths) ? prepared.outputPaths.slice() : []
  };
}

module.exports = {
  createIpcTaskContext,
  executeIpcTaskInvocation,
  normalizeIpcTaskHandler,
  prepareIpcTaskInvocation
};
