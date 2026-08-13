'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  createIpcTaskContext,
  executeIpcTaskWithoutBatch,
  executeIpcTaskInvocation,
  normalizeIpcTaskHandler,
  prepareIpcTaskInvocation
} = require('../../../src/main-process/archive-center/ipc-task-contract');
const {
  createBusinessOperationRegistry
} = require('../../../src/main-process/business-operation-registry');

test('普通函数 handler 无 prepare，参数原样进入 execute', async () => {
  const contract = normalizeIpcTaskHandler((_event, value) => value + 1);
  const prepared = await prepareIpcTaskInvocation(contract, {}, [4]);
  assert.deepEqual(prepared, {
    proceed: true,
    args: [4],
    inputPaths: [],
    outputPaths: []
  });
  const taskContext = createIpcTaskContext(
    Object.freeze({ batchId: 1 }),
    { settleArtifacts: async () => ({}) }
  );
  assert.equal(executeIpcTaskInvocation(contract, {}, prepared, prepared.args, taskContext), 5);
});

test('对象 handler execute 稳定收到冻结 taskContext 与 artifact barrier', async () => {
  const batchContext = Object.freeze({ batchId: 7, taskKey: 'toolbox:merge' });
  const settleArtifacts = async () => ({ durable: true });
  const taskContext = createIpcTaskContext(batchContext, { settleArtifacts });
  let received = null;
  const contract = normalizeIpcTaskHandler({
    prepare(_event, payload) {
      return { proceed: true, args: [payload] };
    },
    execute(_event, prepared, context, payload) {
      received = { prepared, context, payload };
      return payload.value;
    }
  });
  const prepared = await prepareIpcTaskInvocation(contract, {}, [{ value: 9 }]);
  assert.equal(executeIpcTaskInvocation(
    contract,
    {},
    prepared,
    prepared.args,
    taskContext
  ), 9);
  assert.equal(Object.isFrozen(taskContext), true);
  assert.equal(received.context.batchContext, batchContext);
  assert.equal(received.context.settleArtifacts, settleArtifacts);
  assert.deepEqual(received.payload, { value: 9 });
});

test('prepare 必须显式声明 proceed，禁止把业务 status 猜成门禁结果', async () => {
  const contract = normalizeIpcTaskHandler({
    async prepare() { return { status: 'failed', message: 'invalid input' }; },
    async execute() { throw new Error('must not execute'); }
  });
  await assert.rejects(
    prepareIpcTaskInvocation(contract, {}, []),
    /必须显式返回 proceed:true\|false/
  );
});

test('prepare stop 原样返回 result，输入输出路径角色分离', async () => {
  const stopped = normalizeIpcTaskHandler({
    async prepare() {
      return { proceed: false, result: { status: 'confirm-overwrite' } };
    },
    async execute() { throw new Error('must not execute'); }
  });
  assert.deepEqual(await prepareIpcTaskInvocation(stopped, {}, []), {
    proceed: false,
    result: { status: 'confirm-overwrite' }
  });

  const ready = normalizeIpcTaskHandler({
    async prepare() {
      return {
        proceed: true,
        inputPaths: ['/tmp/input.xlsx'],
        outputPaths: ['/tmp/output.xlsx']
      };
    },
    async execute() { return { status: 'success' }; }
  });
  const prepared = await prepareIpcTaskInvocation(ready, {}, [{ savePath: '/tmp/output.xlsx' }]);
  assert.deepEqual(prepared.inputPaths, ['/tmp/input.xlsx']);
  assert.deepEqual(prepared.outputPaths, ['/tmp/output.xlsx']);
});

test('no-archive-artifact 执行业务但不创建 taskContext，并受退出闸门保护', async () => {
  const registry = createBusinessOperationRegistry();
  let executeCount = 0;
  let marked = false;
  const result = await executeIpcTaskWithoutBatch({
    businessOperationRegistry: registry,
    meta: { channel: 'bank-statement:run' },
    markExecuteStarted() { marked = true; },
    async execute(taskContext) {
      executeCount += 1;
      assert.equal(taskContext, null);
      assert.deepEqual(registry.listActive().map((item) => item.channel), ['bank-statement:run']);
      return { status: 'ok' };
    }
  });
  assert.deepEqual(result, { status: 'ok' });
  assert.equal(marked, true);
  assert.equal(executeCount, 1);
  assert.deepEqual(registry.listActive(), []);

  registry.beginShutdownTransition();
  marked = false;
  const blocked = await executeIpcTaskWithoutBatch({
    businessOperationRegistry: registry,
    meta: { channel: 'template:save-mappings' },
    markExecuteStarted() { marked = true; },
    async execute() { throw new Error('must not execute'); }
  });
  assert.equal(blocked.status, 'busy');
  assert.equal(marked, false);
});
