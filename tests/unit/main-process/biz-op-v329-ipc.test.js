'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { registerBizOpV327Handlers } = require('../../../src/main-process/biz-op-v327/ipc');
const { createBusinessOperationRegistry } = require('../../../src/main-process/business-operation-registry');

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}
function wire(t, { importWork, recover, save } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bizop-ipc-unit-'));
  const inputPath = path.join(root, 'input.xlsx');
  // 此处只验证 Main 的文件身份冻结；工作簿解析由真实集成测试覆盖。
  fs.writeFileSync(inputPath, 'unit-file-identity');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const handlers = new Map();
  const sender = Object.assign(new EventEmitter(), { id: 1, mainFrame: {} });
  const event = { sender, senderFrame: sender.mainFrame };
  const registry = createBusinessOperationRegistry();
  const calls = { imports: 0, deletes: 0, recovery: 0, saves: 0 };
  const flags = { ready: true, enabled: true };
  const businessResult = { status: 'error', code: 'BIZOP_IMPORT_REJECTED', message: '本次导入未通过校验',
    reportRef: 'report-owned', summary: { rowErrorCount: 1 } };
  const module = {
    assertBusinessEnabled() {
      if (!flags.enabled) throw Object.assign(new Error('尚未启用'), { code: 'BIZOP_V327_NOT_ENABLED' });
      if (!flags.ready) throw Object.assign(new Error('需要恢复'), { code: 'BIZOP_RECOVERY_REQUIRED' });
    },
    async runImport(args) {
      calls.imports += 1;
      args.onTaskIdentified({ taskRunId: 'task-import-owned', reportRef: 'report-owned' });
      return importWork ? importWork(args) : businessResult;
    },
    async runDelete() { calls.deletes += 1; return { status: 'ok', taskRunId: 'delete-task' }; },
    recovery: { async run() { calls.recovery += 1; return recover ? recover({ flags, calls }) : { ready: flags.ready }; } },
    publication: { record() { return null; } }
  };
  registerBizOpV327Handlers({
    ipcMain: { handle(key, handler) { handlers.set(key, handler); } }, getModule: () => module,
    getTaskLifecycle: () => ({}), getRuntime: () => ({}), getStorageRoot: () => root,
    getWindow: () => ({ webContents: sender }), businessOperationRegistry: registry,
    dialog: { async showOpenDialog() { return { canceled: false, filePaths: [inputPath] }; } },
    createAutoErrorReport() { return { async save(args) {
      calls.saves += 1;
      assert.deepEqual(args.identity, { taskRunId: 'task-import-owned', reportRef: 'report-owned' });
      return save ? save(args, { flags, calls, registry }) : {
        errorReport: { status: 'failed', code: 'BIZOP_AUTO_REPORT_RECOVERY_REQUIRED', message: '请先完成恢复' }
      };
    } }; }
  });
  const call = (suffix, value = {}, from = event) => handlers.get(`bizOpReconV327:${suffix}`)(from, value);
  return { call, calls, flags, registry, sender, event, businessResult,
    async select(requestId) { const picked = await call('files:pick'); assert.equal(picked.status, 'ok'); return { requestId, selectionRef: picked.selectionRef }; } };
}

test('真实 IPC 在导入恢复门禁关闭时复用在途及完成缓存，新请求仍拒绝且不消耗选择', { timeout: 10000 }, async (t) => {
  const entered = deferred(); const release = deferred();
  const f = wire(t, { recover: async ({ flags }) => { flags.ready = false; entered.resolve(); await release.promise; return { ready: false }; } });
  const payload = await f.select('import-1'); const next = await f.select('import-2');
  const original = f.call('import', payload);
  await entered.promise;
  assert.equal(f.registry.listActive().length, 1);
  assert.equal(f.registry.beginInstallTransition().reason, 'business-busy');
  let idle = false; const idlePromise = f.registry.waitForIdle().then(() => { idle = true; });
  const repeated = f.call('import', payload);
  assert.equal((await f.call('import', next)).code, 'BIZOP_RECOVERY_REQUIRED');
  assert.equal((await f.call('import', { ...payload, selectionRef: 'changed' })).code, 'BIZOP_REQUEST_CONFLICT');
  assert.equal((await f.call('files:pick')).code, 'BIZOP_RECOVERY_REQUIRED');
  assert.equal(idle, false);
  release.resolve();
  const result = await original;
  assert.deepEqual(await repeated, result);
  assert.deepEqual(await f.call('import', payload), result);
  assert.equal(result.cleanupPending, true);
  assert.equal(result.code, 'BIZOP_IMPORT_REJECTED');
  assert.deepEqual(result.summary, f.businessResult.summary);
  assert.equal(result.errorReport.status, 'failed');
  assert.deepEqual(f.calls, { imports: 1, deletes: 0, recovery: 1, saves: 1 });
  await idlePromise; assert.equal(idle, true);
  f.flags.ready = true;
  assert.deepEqual(await f.call('import', payload), result, '后续状态不改写完成结果快照');
  assert.equal((await f.call('import', next)).code, 'BIZOP_IMPORT_REJECTED');
  assert.equal(f.calls.imports, 2, '先前被新请求门禁拒绝的选择仍可用');
  assert.equal(f.registry.listActive().length, 0);
});

test('报告保存和收尾期间共享原请求，业务失败与报告已保存分层返回', { timeout: 10000 }, async (t) => {
  const entered = deferred(); const release = deferred();
  let observed;
  const f = wire(t, { save: async (args, { flags, registry }) => {
    assert.equal(args.recoveryReady, true);
    assert.equal(registry.listActive().length, 1);
    observed = args; flags.ready = false; entered.resolve(); await release.promise;
    return { errorReport: { status: 'saved', fileName: 'report.xlsx', relativePath: 'error-reports/2026-09-11/report.xlsx',
      taskRunId: 'task-export-owned', pendingArchiveHandoff: true }, cleanupPending: true };
  } });
  const payload = await f.select('report-wait'); const original = f.call('import', payload);
  await entered.promise;
  const repeat = f.call('import', payload);
  assert.equal((await f.call('delete', { requestId: 'new-delete', previewId: 'preview', mode: 'KEEP_RESULTS' })).code, 'BIZOP_RECOVERY_REQUIRED');
  assert.equal(f.calls.saves, 1);
  release.resolve();
  const result = await original;
  assert.deepEqual(await repeat, result);
  assert.equal(result.status, 'error'); assert.equal(result.errorReport.status, 'saved');
  assert.equal(result.errorReport.pendingArchiveHandoff, true); assert.equal(result.cleanupPending, true);
  assert.equal(observed.signal.aborted, false);
  assert.equal(f.registry.listActive().length, 0);
});

test('缓存不能绕过 sender/frame/输入验证，新请求仍需模块启用', { timeout: 10000 }, async (t) => {
  const f = wire(t);
  const payload = { requestId: 'delete-1', previewId: 'preview', mode: 'KEEP_RESULTS' };
  const result = await f.call('delete', payload);
  const stranger = Object.assign(new EventEmitter(), { id: 2, mainFrame: {} });
  assert.equal((await f.call('delete', payload, { sender: stranger, senderFrame: stranger.mainFrame })).code, 'BIZOP_IPC_SENDER_INVALID');
  assert.equal((await f.call('delete', payload, { ...f.event, senderFrame: {} })).code, 'BIZOP_IPC_SENDER_INVALID');
  assert.equal((await f.call('delete', { ...payload, filePath: '/private/forbidden' })).code, 'BIZOP_IPC_INPUT_INVALID');
  f.flags.ready = false; f.flags.enabled = false;
  assert.deepEqual(await f.call('delete', payload), result);
  assert.equal((await f.call('delete', { ...payload, requestId: 'new' })).code, 'BIZOP_V327_NOT_ENABLED');
  assert.equal(f.calls.deletes, 1);
});

test('缓存容量满时先查有效命中，只有新请求才淘汰；过期缓存不宣称永久重放', async (t) => {
  let now = 1000;
  t.mock.method(Date, 'now', () => now);
  const f = wire(t);
  const first = { requestId: 'delete-0', previewId: 'preview', mode: 'KEEP_RESULTS' };
  const result = await f.call('delete', first);
  for (let i = 1; i < 64; i += 1) await f.call('delete', { ...first, requestId: `delete-${i}` });
  f.flags.ready = false;
  assert.deepEqual(await f.call('delete', first), result);
  assert.equal(f.calls.deletes, 64);
  now += 600001;
  assert.equal((await f.call('delete', first)).code, 'BIZOP_RECOVERY_REQUIRED');
  assert.equal(f.calls.deletes, 64);
});

test('导入抛错仍关联本请求身份，保存异常不会吞掉业务错误或提前结束登记', { timeout: 10000 }, async (t) => {
  const f = wire(t, { importWork: async () => { throw Object.assign(new Error('导入校验中断'), { code: 'BIZOP_IMPORT_INTERRUPTED' }); },
    save: async (args) => { args.onTaskIdentified({ taskRunId: 'export-pending' }); throw new Error('/private/internal-error'); } });
  const payload = await f.select('import-throws'); const result = await f.call('import', payload);
  assert.equal(result.code, 'BIZOP_IMPORT_INTERRUPTED'); assert.equal(result.message, '导入校验中断');
  assert.equal(result.errorReport.status, 'pending'); assert.equal(result.errorReport.taskRunId, 'export-pending');
  assert.equal(result.cleanupPending, true); assert.equal(JSON.stringify(result).includes('/private/internal-error'), false);
  assert.deepEqual(await f.call('import', payload), result);
  assert.equal(f.calls.imports, 1); assert.equal(f.calls.saves, 1); assert.equal(f.registry.listActive().length, 0);
});

test('成功/取消导入不启动报告保存，窗口销毁传递中止信号并等待在途收尾', { timeout: 10000 }, async (t) => {
  for (const status of ['ok', 'cancelled']) {
    const f = wire(t, { importWork: async () => ({ status }) });
    assert.equal((await f.call('import', await f.select(`import-${status}`))).status, status);
    assert.equal(f.calls.saves, 0); assert.equal(f.registry.listActive().length, 0);
  }
  const entered = deferred(); const release = deferred(); let signal;
  const f = wire(t, { importWork: async (args) => { signal = args.signal; entered.resolve(); await release.promise; return { status: 'cancelled' }; } });
  const original = f.call('import', await f.select('destroyed'));
  await entered.promise; f.sender.emit('destroyed');
  assert.equal(signal.aborted, true); assert.equal(f.registry.listActive().length, 1);
  release.resolve(); assert.equal((await original).status, 'cancelled');
  assert.equal(f.calls.saves, 0); assert.equal(f.registry.listActive().length, 0);
});
