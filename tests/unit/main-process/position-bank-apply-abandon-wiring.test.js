'use strict';

// 银行对账单「确认写入」IPC 的装配：导入进程在上一步已经开着未提交的事务等确认，
// 这一步无论在哪里结束，只要令牌没被用掉，都要按令牌回滚并释放侧库写锁。
// 从 main.js 取出真实的 trackedIpcHandle 与该通道的注册语句原样执行，外围依赖用夹具。

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const acorn = require('acorn');

const CHANNEL = 'position-reconciliation:bank:apply-import';
const mainPath = path.resolve(__dirname, '../../../src/main.js');
const mainSource = fs.readFileSync(mainPath, 'utf8');
const mainAst = acorn.parse(mainSource, { ecmaVersion: 'latest' });

function sourceOf(node) {
  return mainSource.slice(node.start, node.end);
}

const trackedIpcHandleNodes = mainAst.body.filter(
  (node) => node.type === 'FunctionDeclaration' && node.id.name === 'trackedIpcHandle'
);
assert.equal(trackedIpcHandleNodes.length, 1, 'Main 必须只有一个 trackedIpcHandle 实现');
const registrations = [];
(function visit(node) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) { node.forEach(visit); return; }
  if (typeof node.type !== 'string') return;
  if (node.type === 'CallExpression'
      && node.callee.type === 'Identifier'
      && node.callee.name === 'trackedIpcHandle'
      && node.arguments[0]
      && node.arguments[0].type === 'Literal'
      && node.arguments[0].value === CHANNEL) {
    registrations.push(node);
  }
  for (const [key, value] of Object.entries(node)) {
    if (key !== 'type' && value && typeof value === 'object') visit(value);
  }
})(mainAst);
assert.equal(registrations.length, 1, '银行确认写入通道必须只注册一次');

function createHarness({ runArchiveAwareOperation, lockResult = null }) {
  const calls = { abandon: [], apply: [], log: [] };
  const service = {
    bankImportArchiveIntent: () => [{
      filePath: '/staging/job/1/bank.xlsx', originalName: 'bank.xlsx',
      sourceType: 'position-bank', sha256: 'a'.repeat(64), sizeBytes: 10
    }],
    async applyBankImport(token) { calls.apply.push(token); return { status: 'ok' }; },
    async abandonPreparedBankImport(token) { calls.abandon.push(token); }
  };
  const handlers = new Map();
  const build = Function('dependencies', `
    'use strict';
    const { ipcMain, runArchiveAwareOperation, isSuccessfulTrackedResult, tickUsageStats,
      appendActivityLogEntry, getPositionReconciliationService, positionInputFilePlanEvidence,
      withPositionReconciliationLock } = dependencies;
    let positionReconciliationService = dependencies.service;
    ${sourceOf(trackedIpcHandleNodes[0])}
    ${sourceOf(registrations[0])};
    return { dropService() { positionReconciliationService = null; } };
  `);
  const built = build({
    service,
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    runArchiveAwareOperation,
    isSuccessfulTrackedResult: (result) => Boolean(result) && result.status === 'ok',
    tickUsageStats() {},
    appendActivityLogEntry: (entry) => calls.log.push(entry),
    getPositionReconciliationService: () => service,
    positionInputFilePlanEvidence: () => ({}),
    withPositionReconciliationLock: (_name, task) => (lockResult ? lockResult : task())
  });
  return { calls, service, invoke: (token) => handlers.get(CHANNEL)({}, token), ...built };
}

const taskContext = {
  batchContext: { batchId: 'batch-1' },
  fileEvidence: { filePlan: { inputs: [{ filePath: '/staging/job/1/bank.xlsx' }] } }
};

test('首次 Recovery Hold 检查在 prepare 之前拒绝：仍按令牌回滚等待中的导入，原错误原样抛出', async () => {
  const hold = Object.assign(new Error('RECOVERY_HOLD_ACTIVE'), { code: 'RECOVERY_HOLD_ACTIVE' });
  const harness = createHarness({
    // 与真实入口一致：Hold 检查先于 prepare，onAbandon 尚未登记。
    runArchiveAwareOperation: async () => { throw hold; }
  });
  await assert.rejects(harness.invoke('token-hold'), (error) => error === hold);
  assert.deepEqual(harness.calls.abandon, ['token-hold']);
  assert.deepEqual(harness.calls.apply, []);
});

test('模块锁被占时 applyBankImport 未执行：按令牌回滚；正常提交后令牌已用掉，兜底调用不产生副作用', async () => {
  const run = async (_meta, event, args, handler) => {
    const prepared = await handler.prepare(event, ...args);
    assert.equal(typeof prepared.onAbandon, 'function');
    return handler.execute(event, prepared, taskContext, ...args);
  };
  const busy = createHarness({
    runArchiveAwareOperation: run,
    lockResult: { status: 'busy', message: '平盘对账数据处理正在执行其他操作' }
  });
  assert.equal((await busy.invoke('token-busy')).status, 'busy');
  assert.deepEqual(busy.calls.apply, []);
  assert.ok(busy.calls.abandon.length >= 1);
  assert.ok(busy.calls.abandon.every((token) => token === 'token-busy'));

  const ok = createHarness({ runArchiveAwareOperation: run });
  assert.equal((await ok.invoke('token-ok')).status, 'ok');
  assert.deepEqual(ok.calls.apply, ['token-ok']);
  // 兜底只按令牌调用服务；令牌是否已用掉由服务判断（已用掉即空操作，见 position-bank-single-pass-import）。
  assert.deepEqual(ok.calls.abandon, ['token-ok']);
});

test('兜底回滚失败只记日志，不改变原结果；平盘服务尚未建立时不触发初始化', async () => {
  const failing = createHarness({ runArchiveAwareOperation: async () => ({ status: 'failed', code: 'X' }) });
  failing.service.abandonPreparedBankImport = async () => { throw new Error('回滚失败'); };
  assert.deepEqual(await failing.invoke('token-x'), { status: 'failed', code: 'X' });
  assert.equal(failing.calls.log.length, 1);
  assert.match(failing.calls.log[0].details[0], /回滚失败/);

  const hold = Object.assign(new Error('hold'), { code: 'RECOVERY_HOLD_ACTIVE' });
  const noService = createHarness({ runArchiveAwareOperation: async () => { throw hold; } });
  noService.dropService();
  await assert.rejects(noService.invoke('token-y'), (error) => error === hold);
  assert.deepEqual(noService.calls.abandon, []);
  assert.deepEqual(noService.calls.log, []);
});
