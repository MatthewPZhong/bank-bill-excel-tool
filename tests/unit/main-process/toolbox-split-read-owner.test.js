'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { createToolboxSplitReadOwner } = require('../../../src/main-process/toolbox-split-read-owner');
const { createResourceGovernor } = require('../../../src/main-process/background-execution/resource-governor');

function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'split-owner-test-'));
  const filePath = path.join(root, 'input.csv');
  fs.writeFileSync(filePath, '字段,空列\n甲,\n乙,\n甲,\n');
  const governor = createResourceGovernor({ budgets: { cpuSlots: 4, workerThreadSlots: 4,
    utilityProcessSlots: 1, ioHeavySlots: 2, memoryBytes: 4 * 1024 ** 3 } });
  const owner = createToolboxSplitReadOwner({ governor, temporaryRoot: root, ...options });
  const sender = Object.assign(new EventEmitter(), { id: 1, isDestroyed: () => false });
  t.after(async () => { await owner.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const read = (requestId = 'read-1') => owner.read(sender, { version: 2, scanKind: 'metadata', requestId }, async () => filePath);
  return { root, filePath, governor, owner, sender, read };
}

test('真实准备 Worker 只返回计数，显式补扫当前字段，空列状态与错误不同', async (t) => {
  const f = fixture(t);
  const metadata = await f.read();
  assert.equal(metadata.dataRowCount, 3);
  assert.equal(metadata.valuesState, 'not-requested');
  assert.equal(Object.hasOwn(metadata, 'valuesByField'), false);
  for (const [field, values] of [['字段', ['甲', '乙']], ['空列', []]]) {
    const result = await f.owner.readValues(f.sender, { version: 2, requestId: `field-${field === '字段' ? '1' : '2'}`,
      splitReadToken: metadata.splitReadToken, field });
    assert.equal(result.valuesState, 'complete');
    assert.deepEqual(result.values, values);
  }
  assert.deepEqual(fs.readdirSync(f.root), ['input.csv']);
  assert.equal(f.owner.snapshot().activeCount, 0);
});

test('token 绑定窗口与源身份，未知字段及 Renderer 配置不能进入 worker', async (t) => {
  const f = fixture(t);
  const metadata = await f.read();
  const request = { version: 2, requestId: 'values', splitReadToken: metadata.splitReadToken, field: '字段' };
  await assert.rejects(f.owner.readValues(Object.assign(new EventEmitter(), { id: 2 }), request), { code: 'TOOLBOX_SPLIT_READ_CONTEXT_STALE' });
  await assert.rejects(f.owner.readValues(f.sender, { ...request, field: '未知' }), { code: 'TOOLBOX_SPLIT_READ_INVALID' });
  await assert.rejects(f.owner.readValues(f.sender, { ...request, phaseMemoryBytes: 1 }), { code: 'TOOLBOX_SPLIT_READ_INVALID' });
  fs.appendFileSync(f.filePath, '丙,\n');
  await assert.rejects(f.owner.readValues(f.sender, request), { code: 'TOOLBOX_SPLIT_READ_CONTEXT_STALE' });
});

test('同字段并发请求合并，一个订阅者取消不影响其他订阅者或基础 token', async (t) => {
  let calls = 0;
  const { dispatchLargeSplit } = require('../../../src/main-process/toolbox-large-split-dispatch');
  const f = fixture(t, { dispatch(input) { calls += 1; return dispatchLargeSplit(input); } });
  const metadata = await f.read();
  const request = { version: 2, requestId: 'values-a', splitReadToken: metadata.splitReadToken, field: '字段' };
  const a = f.owner.readValues(f.sender, request);
  const b = f.owner.readValues(f.sender, { ...request, requestId: 'values-b' });
  f.owner.cancel(f.sender, { version: 2, requestId: 'values-a' });
  assert.equal((await a).status, 'cancelled');
  assert.deepEqual((await b).values, ['甲', '乙']);
  assert.equal(calls, 2);
  assert.equal(f.owner.requireContext(f.sender, request).token, metadata.splitReadToken);
});

test('窗口销毁与取消等待实际关闭，私有目录和额度在关闭之后才清理', async (t) => {
  let finish;
  let exit;
  let directory;
  const f = fixture(t, { dispatch(input) {
    directory = input.privateDirectory;
    return { promise: new Promise((resolve) => { finish = resolve; }),
      closed: new Promise((resolve) => { exit = resolve; }),
      cancel() { finish({ headers: ['字段'], dataRowCount: 3 }); } };
  } });
  const reading = f.read();
  const rejected = assert.rejects(reading, { code: 'ADMISSION_CANCELLED' });
  while (!finish) await new Promise((resolve) => setImmediate(resolve));
  f.sender.emit('destroyed');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.owner.snapshot().activeCount, 1);
  assert.equal(fs.existsSync(directory), true);
  exit();
  await rejected;
  assert.equal(fs.existsSync(directory), false);
  assert.equal(f.owner.snapshot().activeCount, 0);
});
