'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  createIpcTaskContext,
  executeIpcTaskInvocation,
  normalizeIpcTaskHandler,
  prepareIpcTaskInvocation
} = require('../../../src/main-process/archive-center/ipc-task-contract');

function batchContext(batchId) {
  return Object.freeze({
    batchId,
    batchNumber: `2026-08-17-${String(batchId).padStart(3, '0')}`,
    taskRunId: `task-${batchId}`,
    taskKey: 'toolbox:merge',
    moduleId: 'toolbox',
    parentRunId: `parent-${batchId}`,
    operationKey: `operation-${batchId}`
  });
}

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
    batchContext(1),
    { settleArtifacts: async () => ({}) }
  );
  assert.equal(executeIpcTaskInvocation(contract, {}, prepared, prepared.args, taskContext), 5);
});

test('对象 handler execute 稳定收到冻结 taskContext 与 artifact barrier', async () => {
  const persistedBatchContext = batchContext(7);
  const settleArtifacts = async () => ({ durable: true });
  const taskContext = createIpcTaskContext(persistedBatchContext, { settleArtifacts });
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
  assert.deepEqual(received.context.batchContext, persistedBatchContext);
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

test('prepare 是普通 eager FilePlan 的唯一规范化冻结边界', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-ipc-plan-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const inputPath = path.join(directory, 'input.xlsx');
  const outputPath = path.join(directory, 'output.xlsx');
  fs.writeFileSync(inputPath, 'input');
  const contract = normalizeIpcTaskHandler({
    async prepare() {
      return {
        proceed: true,
        filePlan: {
          version: 1,
          allocation: 'eager',
          inputs: [{ filePath: inputPath, role: 'input', sourceOperation: 'test:run' }],
          outputs: [{ filePath: outputPath, role: 'output', sourceOperation: 'test:run' }]
        }
      };
    },
    async execute() { return { status: 'success' }; }
  });

  const prepared = await prepareIpcTaskInvocation(contract, {}, []);
  assert.equal(Object.isFrozen(prepared.filePlan), true);
  assert.equal(Object.isFrozen(prepared.filePlan.inputs), true);
  assert.equal(Object.isFrozen(prepared.filePlan.inputs[0].sourceSnapshot), true);
  assert.equal(prepared.filePlan.inputs[0].sourceSnapshot.sizeBytes, 5);
  assert.throws(() => {
    prepared.filePlan.inputs[0].sourceSnapshot.sizeBytes = 99;
  }, TypeError);
  assert.equal(prepared.filePlan.outputs[0].targetSnapshot.exists, false);

  const malformed = normalizeIpcTaskHandler({
    async prepare() {
      return {
        proceed: true,
        filePlan: { version: 1, allocation: 'eager', inputs: null, outputs: [] }
      };
    },
    async execute() { return { status: 'success' }; }
  });
  await assert.rejects(
    prepareIpcTaskInvocation(malformed, {}, []),
    /inputs\/outputs 必须是数组/
  );
});
