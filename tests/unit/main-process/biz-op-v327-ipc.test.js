'use strict';
const { durableDirectoryTest: test } = require('../../helpers/durable-directory-tests');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { EventEmitter } = require('node:events');
const { createExportHost } = require('../../helpers/biz-op-v327-export');
const { seed, compute } = require('../../helpers/biz-op-v327-compute');
const { writeXlsx, flowRow, opRow } = require('../../helpers/biz-op-v327-xlsx');
const { registerBizOpV327Handlers } = require('../../../src/main-process/biz-op-v327/ipc');
const { createBusinessOperationRegistry } = require('../../../src/main-process/business-operation-registry');
const { createTaskPolicyRegistry } = require('../../../src/main-process/archive-center/task-policy-registry');

function wire(f, options = {}) {
  const handlers = new Map(); const sender = Object.assign(new EventEmitter(), { id: 1, mainFrame: {} });
  const window = { webContents: sender }; const event = { sender, senderFrame: sender.mainFrame };
  let paths = []; let target = path.join(f.outputRoot, 'chosen.xlsx');
  registerBizOpV327Handlers({ ipcMain: { handle(key, handler) { assert.equal(handlers.has(key), false); handlers.set(key, handler); } },
    // 仅隔离测试装配放行；生产模块仍由真实 mode 门禁控制。
    getModule: () => ({ ...f.module, assertBusinessEnabled() {}, ...options }), getTaskLifecycle: () => f.lifecycle,
    getRuntime: () => f.runtime, getWindow: () => window, businessOperationRegistry: createBusinessOperationRegistry(),
    dialog: { async showOpenDialog() { return { canceled: !paths.length, filePaths: paths }; },
      async showSaveDialog(_window, opts) { assert.ok(opts.defaultPath.endsWith('.xlsx')); return { canceled: !target, filePath: target }; } } });
  return { handlers, event, paths(value) { paths = value; }, target(value) { target = value; },
    call(key, value, from = event) { return handlers.get(`bizOpReconV327:${key}`)(from, value); } };
}
test('真实 IPC 导入、预检、运行、全量发布和 KEEP_RESULTS 删除，均走 TaskLifecycle 且不回传路径或数据行', async (t) => {
  const f = await createExportHost(t); const w = wire(f);
  const s = path.join(f.root, 'start.xlsx'); const e = path.join(f.root, 'end.xlsx'); const flow = path.join(f.root, 'flows.xlsx');
  await writeXlsx(s, { kind: 'OP', rowCount: 1, row: () => opRow({ amount: '0', incoming: '0', end: '100' }) });
  await writeXlsx(e, { kind: 'OP', rowCount: 1, row: () => opRow({ date: '2026-09-03', begin: '120', amount: '0', incoming: '0', end: '120' }) });
  await writeXlsx(flow, { rowCount: 2, row: (i) => flowRow({ date: i ? '2026-09-03' : '2026-09-02', amount: i ? '0' : '10' }) });
  w.paths([s, e, flow]); const picked = await w.call('files:pick'); assert.equal(picked.status, 'ok');
  const imported = await w.call('import', { requestId: 'import-1', selectionRef: picked.selectionRef });
  assert.equal(imported.status, 'ok', JSON.stringify(imported)); assert.equal(imported.cleanupPending, false);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM archive_task_runs WHERE task_key='bizOpReconV327:import'").get().n, 1);
  const ready = await w.call('run:preflight', { startDate: '2026-09-01', endDate: '2026-09-03' });
  assert.equal(ready.inputs.length, 4); const payload = { requestId: 'run-1', selectionRef: ready.selectionRef };
  const [run, duplicate] = await Promise.all([w.call('run', payload), w.call('run', payload)]);
  assert.equal(run.status, 'ok', JSON.stringify(run)); assert.deepEqual(run, duplicate);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM archive_task_runs WHERE task_key='bizOpReconV327:run'").get().n, 1);
  const chosen = await w.call('export:pick', { outputKind: 'RESULT_FULL', objectId: run.runId });
  assert.equal(chosen.status, 'ok', JSON.stringify(chosen));
  const exported = await w.call('export:result-full', { requestId: 'export-1', selectionRef: chosen.selectionRef });
  assert.equal(exported.status, 'ok', JSON.stringify(exported)); assert.equal(fs.existsSync(path.join(f.outputRoot, 'chosen.xlsx')), true);
  const dataset = await w.call('metadata:input', { kind: 'OP', dataDate: '2026-09-01' });
  const preview = await w.call('delete:preview', { datasetIds: [dataset.objectId] });
  const deleted = await w.call('delete', { requestId: 'delete-1', previewId: preview.previewId, mode: 'KEEP_RESULTS' });
  assert.equal(deleted.status, 'ok', JSON.stringify(deleted)); assert.equal(deleted.cleanupPending, false);
  assert.equal(f.db.prepare("SELECT state FROM biz_op_v327_runs WHERE run_id=?").get(run.runId).state, 'PUBLISHED');
  for (const result of [picked, imported, ready, run, exported, preview, deleted]) {
    assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 262144);
    assert.ok(!JSON.stringify(result).includes(f.root)); assert.ok(!JSON.stringify(result).includes(f.outputRoot));
  }
  assert.equal(f.runtime.resourceGovernor.snapshot().activeLeaseCount, 0);
});
test('IPC 拒绝任意路径、非主窗口/子 frame、错 action 选择与 requestId 换参；缺失清单完整且不创建 Task', async (t) => {
  const f = await createExportHost(t); const w = wire(f);
  assert.equal((await w.call('import', { requestId: 'bad', filePath: '/tmp/fake.xlsx' })).code, 'BIZOP_IPC_INPUT_INVALID');
  assert.equal((await w.call('files:pick', {}, { sender: { id: 2 } })).code, 'BIZOP_IPC_SENDER_INVALID');
  assert.equal((await w.call('files:pick', {}, { ...w.event, senderFrame: {} })).code, 'BIZOP_IPC_SENDER_INVALID');
  const missing = await w.call('run:preflight', { startDate: '2026-09-01', endDate: '2026-09-03' });
  assert.equal(missing.code, 'BIZOP_RUN_INPUT_MISSING'); assert.equal(missing.missing.length, 4);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM archive_task_runs').get().n, 0);
  await seed(f); const r = await compute(f);
  const picked = await w.call('export:pick', { outputKind: 'RESULT_DIFF', objectId: r.runId });
  assert.equal(picked.status, 'ok', JSON.stringify(picked));
  const wrong = await w.call('export:result-full', { requestId: 'wrong', selectionRef: picked.selectionRef });
  assert.equal(wrong.code, 'BIZOP_SELECTION_EXPIRED');
  const conflict = await w.call('export:result-diff', { requestId: 'wrong', selectionRef: picked.selectionRef });
  assert.equal(conflict.code, 'BIZOP_REQUEST_CONFLICT');
  assert.equal((await w.call('export:result-diff', { requestId: 'correct', selectionRef: picked.selectionRef })).status, 'ok');
  const consumed = await w.call('export:result-diff', { requestId: 'reuse', selectionRef: picked.selectionRef });
  assert.equal(consumed.code, 'BIZOP_SELECTION_EXPIRED');
});
test('月份和 keyset 分页只查询目录，旧游标和变更后的运行预检不接受，注册频道都有明确 Task 分类', async (t) => {
  const f = await createExportHost(t); await seed(f); await compute(f); const w = wire(f);
  const ready = await w.call('run:preflight', { startDate: '2026-09-01', endDate: '2026-09-03' });
  const months = await w.call('metadata:months'); assert.equal(months.months.length, 1);
  const query = { view: 'RAW', kind: 'OP', operationMonth: months.months[0], limit: 1 };
  const first = await w.call('metadata:list', query); assert.equal(first.rows.length, 1); assert.ok(first.nextCursor);
  const second = await w.call('metadata:list', { ...query, cursor: first.nextCursor, generation: first.generation });
  assert.equal(second.rows.length, 1); assert.notEqual(first.rows[0].rowKey, second.rows[0].rowKey); assert.equal(second.nextCursor, null);
  assert.equal((await w.call('metadata:list', { ...query, kind: 'FLOW', cursor: first.nextCursor })).code, 'BIZOP_LIST_CURSOR_INVALID');
  const preview = await w.call('delete:preview', { datasetIds: [first.rows[0].objectId] });
  assert.equal((await w.call('delete', { requestId: 'd', previewId: preview.previewId, mode: 'KEEP_RESULTS' })).status, 'ok');
  const previousTasks = f.db.prepare('SELECT COUNT(*) AS n FROM archive_task_runs').get().n;
  assert.equal((await w.call('run', { requestId: 'r', selectionRef: ready.selectionRef })).code, 'BIZOP_GENERATION_CHANGED');
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM archive_task_runs').get().n, previousTasks);
  assert.equal((await w.call('metadata:list', { ...query, generation: first.generation })).code, 'BIZOP_GENERATION_CHANGED');
  const registry = createTaskPolicyRegistry();
  for (const channel of w.handlers.keys()) assert.ok(registry.get(channel) || registry.classify(channel), channel);
});

test('IPC 六类固定 action 与诊断导出均可发布，失败导入有真实可导出的错误报告', async (t) => {
  const f = await createExportHost(t); await seed(f, { end: '120' }); const run = await compute(f); const w = wire(f);
  for (const kind of ['OP_RAW', 'FLOW_RAW', 'OP_CHECK', 'FLOW_CHECK', 'RESULT_FULL', 'RESULT_DIFF']) {
    const objectId = kind.startsWith('RESULT') ? run.runId : f.db.prepare('SELECT dataset_id FROM biz_op_v327_input_heads WHERE kind=? ORDER BY data_date LIMIT 1').get(kind.split('_')[0]).dataset_id;
    w.target(path.join(f.outputRoot, `${kind}.xlsx`)); const picked = await w.call('export:pick', { outputKind: kind, objectId });
    assert.equal(picked.status, 'ok', JSON.stringify(picked));
    const result = await w.call(`export:${kind.toLowerCase().replace('_', '-')}`, { requestId: kind, selectionRef: picked.selectionRef });
    assert.equal(result.status, 'ok', JSON.stringify(result));
  }
  const bad = path.join(f.root, 'bad.xlsx'); await writeXlsx(bad, { kind: 'OP', rowCount: 1, row: () => opRow({ end: '999' }) });
  w.paths([bad]); const picked = await w.call('files:pick');
  const failed = await w.call('import', { requestId: 'bad-import', selectionRef: picked.selectionRef });
  assert.equal(failed.status, 'error'); assert.ok(failed.reportRef);
  const report = await w.call('export:pick', { outputKind: 'ERRORS', objectId: failed.reportRef }); assert.equal(report.status, 'ok', JSON.stringify(report));
  assert.equal((await w.call('export:errors', { requestId: 'errors', selectionRef: report.selectionRef })).status, 'ok');
});
test('实际 worker 已退出后通过 IPC 取消导入，原业务版本不提交；重复确认和关闭未决状态可观察', async (t) => {
  const f = await createExportHost(t); await seed(f); let started; let release;
  const atWorker = new Promise((resolve) => { started = resolve; }); const barrier = new Promise((resolve) => { release = resolve; });
  const w = wire(f, { runImport: (args) => f.module.runImport({ ...args, afterWorker: async (value) => { started(value); await barrier; } }) });
  const file = path.join(f.root, 'cancel-late.xlsx'); await writeXlsx(file, { rowCount: 1, row: () => flowRow({ amount: '25' }) });
  w.paths([file]); const chosen = await w.call('files:pick'); const generation = f.module.catalog.control().generation;
  const result = w.call('import', { requestId: 'late-cancel', selectionRef: chosen.selectionRef });
  const observed = await atWorker; assert.equal(f.module.protection.closed(observed.taskRunId), true);
  const cancelled = await w.call('task:cancel', { requestId: 'late-cancel' }); assert.equal(cancelled.status, 'cancelling');
  assert.equal(f.module.catalog.task(observed.taskRunId).status, 'running'); release();
  assert.equal((await result).status, 'cancelled'); assert.equal(f.module.catalog.control().generation, generation);
  assert.equal(f.module.catalog.receipt(observed.taskRunId), null);
  assert.equal(f.module.catalog.task(observed.taskRunId).status, 'cancelled');
  assert.equal((await w.call('task:cancel', { requestId: 'late-cancel' })).status, 'idle');
});
test('401 条合成目录按 200/200/1 完整分页；没有 payload 的元数据 fixture 不触发文件读取', async (t) => {
  const f = await createExportHost(t); await seed(f); const sample = f.db.prepare("SELECT * FROM biz_op_v327_datasets WHERE kind='OP' LIMIT 1").get();
  // 此测试仅验证目录查询，独立合成目录行不伪装成成功导入或有效业务 payload。
  const columns = Object.keys(sample); const insert = f.db.prepare(`INSERT INTO biz_op_v327_datasets(${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`);
  for (let i = 0; i < 401; i += 1) {
    const row = { ...sample, dataset_id: `metadata-${String(i).padStart(3, '0')}`, data_date: new Date(Date.UTC(2020, 0, 1 + i)).toISOString().slice(0, 10), activated_at: '2020-01-01T00:00:00.000Z', payload_manifest_rel_path: `inputs/no-payload-${i}/manifest.json` };
    insert.run(...columns.map((key) => row[key]));
  }
  const w = wire(f); let cursor = null; let generation; const ids = []; const sizes = [];
  do {
    const page = await w.call('metadata:list', { view: 'CHECK', kind: 'OP', operationMonth: '2020-01', ...(cursor ? { cursor, generation } : {}) });
    assert.ok(Buffer.byteLength(JSON.stringify(page)) <= 262144); assert.ok(page.rows);
    sizes.push(page.rows.length); ids.push(...page.rows.map((row) => row.objectId)); cursor = page.nextCursor; generation = page.generation;
  } while (cursor);
  assert.deepEqual(sizes, [200, 200, 1]); assert.equal(new Set(ids).size, 401);
  assert.equal((await w.call('metadata:list', { view: 'CHECK', kind: 'OP', operationMonth: '2020-01', limit: 201 })).code, 'BIZOP_PAGE_SIZE_INVALID');
});
