'use strict';

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

function createIpcTaskContext(batchContext, controls = {}) {
  if (!batchContext || typeof batchContext !== 'object' || Array.isArray(batchContext)) {
    throw new TypeError('IPC taskContext.batchContext 缺失');
  }
  if (typeof controls.settleArtifacts !== 'function') {
    throw new TypeError('IPC taskContext.settleArtifacts 缺失');
  }
  return Object.freeze({
    batchContext,
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

async function executeIpcTaskWithoutBatch({
  businessOperationRegistry,
  meta,
  markExecuteStarted,
  execute
} = {}) {
  if (!businessOperationRegistry
      || typeof businessOperationRegistry.begin !== 'function'
      || typeof businessOperationRegistry.end !== 'function') {
    throw new TypeError('no-batch task 需要 businessOperationRegistry');
  }
  if (typeof markExecuteStarted !== 'function' || typeof execute !== 'function') {
    throw new TypeError('no-batch task 需要 markExecuteStarted/execute');
  }
  const operation = businessOperationRegistry.begin(meta || {});
  if (!operation.accepted) {
    return {
      status: 'busy',
      message: operation.message || '当前暂时不能开始新的任务'
    };
  }
  try {
    markExecuteStarted();
    return await execute(null);
  } finally {
    businessOperationRegistry.end(operation.token);
  }
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
  return {
    ...prepared,
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
  executeIpcTaskWithoutBatch,
  executeIpcTaskInvocation,
  normalizeIpcTaskHandler,
  prepareIpcTaskInvocation
};
