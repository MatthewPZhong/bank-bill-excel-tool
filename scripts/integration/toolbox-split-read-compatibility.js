// 公共拆分扫描的生产兼容回归：真实生产策略配 pending 清单夹具、Main 读取 IPC、Worker、按字段导出和回读。
// 覆盖：零/512/1536 MiB 兼容预算、静态不足/争用/超时、低档互斥和获批阶段替换。
// 内存数值为注入夹具，不代表 Windows 真压力或完整 Electron/归档验收。
// 用法：node scripts/integration/toolbox-split-read-compatibility.js
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const XLSX = require('xlsx');
const { createResourceGovernor, closeResourceGovernor } = require('../../src/main-process/background-execution/resource-governor');
const { createPlatformResourceEnvelope } = require('../../src/main-process/background-execution/resource-budget');
const { createExperimentalMemoryPolicy } = require('../../src/main-process/execution-descriptors/memory-profiles');
const { loadProductionMemoryProfiles } = require('../../tests/helpers/production-memory-policy');
const { createProductionMemoryPolicy } = loadProductionMemoryProfiles({ qualification: { schemaVersion: 2, status: 'pending' } });
const { createToolboxSplitReadOwner, SCAN_RESOURCES } = require('../../src/main-process/toolbox-split-read-owner');
const { dispatchLargeSplit } = require('../../src/main-process/toolbox-large-split-dispatch');
const { registerMemoryGovernor, registerWithMemoryActivity, memoryActivitySnapshot } = require('../../src/main-process/memory-activity');

const MiB = 1024 ** 2;
const mainSource = fs.readFileSync(path.join(__dirname, '../../src/main.js'), 'utf8');
const failureStart = mainSource.indexOf('function toolboxFailureResult(error) {');
const failureEnd = mainSource.indexOf('\nfunction shouldPreserveToolboxTemporaryFiles', failureStart);
const readStart = mainSource.indexOf("ipcMain.handle('toolbox:split:read'");
const readEnd = mainSource.indexOf('  // IPC 3', readStart);
assert.ok(failureStart >= 0 && failureEnd > failureStart && readStart >= 0 && readEnd > readStart);
const cases = [];
const test = (name, run) => cases.push({ name, run });
const tick = () => new Promise((resolve) => setImmediate(resolve));
const vector = (extra) => ({ cpuSlots: 0, workerThreadSlots: 0, utilityProcessSlots: 0,
  ioHeavySlots: 0, memoryBytes: 0, ...extra });

async function withHarness(options, run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'split-read-compatibility-'));
  const input = path.join(root, `input.${options.format || 'csv'}`);
  if (options.format === 'xlsx') {
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([['类别', '金额'], ['A', 1], ['B', 2]]), '数据');
    XLSX.writeFile(workbook, input, { bookSST: true });
  } else fs.writeFileSync(input, '类别,金额\nA,1\nB,2\n');
  const original = fs.readFileSync(input);
  const envelope = createPlatformResourceEnvelope({ availableParallelism: 4, totalMemoryBytes: 8192 * MiB,
    freeMemoryBytes: (options.freeMiB ?? 512) * MiB });
  let governor;
  const policy = options.mode ? createExperimentalMemoryPolicy({ modes: [options.mode],
    sampleMemory: () => ({ availableBytes: 4096 * MiB, sampledAt: Date.now() }) })
    : createProductionMemoryPolicy({ compatibilityMemoryBytes: envelope.compatibilityBudgets.memoryBytes, getGovernor: () => governor });
  governor = createResourceGovernor({ budgets: { ...envelope.hardBudgets, ioHeavySlots: 1, ...options.budgets },
    memoryAdmission: policy, memoryRecheckMs: 5 });
  const unregister = registerMemoryGovernor(governor);
  const facts = [];
  const owner = createToolboxSplitReadOwner({ governor, temporaryRoot: root, dispatch(payload) {
    const carrier = dispatchLargeSplit(payload);
    const fact = { op: payload.op, config: payload.executionMemoryConfig,
      lease: governor.snapshot().activeLeases[0],
      activity: memoryActivitySnapshot(), closed: false };
    facts.push(fact);
    const closed = carrier.closed.then((result) => {
      fact.closed = true;
      fact.leaseCountAtExit = governor.snapshot().activeLeaseCount;
      fact.directoryAtExit = fs.existsSync(payload.privateDirectory);
      return result;
    });
    return { ...carrier, closed };
  } });
  const callbacks = new Map();
  const ipcMain = { handle: (channel, callback) => callbacks.set(channel, callback) };
  // 直接执行 Main 的真实读取/补扫/取消 handler；只替换原生选文件对话框。
  registerWithMemoryActivity(ipcMain, () => vm.runInNewContext(
    mainSource.slice(failureStart, failureEnd) + '\n' + mainSource.slice(readStart, readEnd), {
      ipcMain, getToolboxSplitReadOwner: () => owner,
      showImportOpenDialog: async () => ({ canceled: false, filePaths: [input] }),
      statementFileDialogFilters: () => []
    }));
  const event = { sender: Object.assign(new EventEmitter(), { id: 1 }) };
  const invoke = (channel, request) => callbacks.get(channel)(event, request);
  const read = () => invoke('toolbox:split:read', { version: 2, scanKind: 'metadata', requestId: 'metadata' });
  try {
    await run({ root, input, original, envelope, governor, owner, facts, read, invoke });
    assert.deepEqual(fs.readFileSync(input), original, '源文件未修改');
  } finally {
    await owner.close();
    const leases = governor.snapshot().activeLeaseCount;
    const queued = governor.snapshot().queued.size;
    closeResourceGovernor(governor);
    unregister();
    fs.rmSync(root, { recursive: true, force: true });
    assert.equal(leases, 0, '结束后租约归零');
    assert.equal(queued, 0, '结束后队列归零');
    assert.deepEqual(memoryActivitySnapshot().blockers, [], '结束后真实载体观察归零');
  }
}

for (const freeMiB of [512, 2560, 3584]) for (const format of ['csv', 'xlsx']) {
  test(`pending ${format}：启动空闲 ${freeMiB} MiB，读取/字段补扫/导出回读`, () => withHarness({ freeMiB, format }, async (h) => {
    assert.equal(h.envelope.compatibilityBudgets.memoryBytes / MiB, Math.max(0, freeMiB - 2048));
    if (format === 'csv') assert.equal(h.original.length, 22);
    const metadata = await h.read();
    assert.equal(metadata.status, 'success', JSON.stringify(metadata));
    assert.equal(metadata.dataRowCount, 2);
    assert.equal(metadata.executionMode, 'normal');
    assert.equal(metadata.valuesState, 'not-requested');
    assert.equal(Object.hasOwn(metadata, 'valuesByField'), false);
    const values = await h.invoke('toolbox:split:read-values', { version: 2, requestId: 'field',
      splitReadToken: metadata.splitReadToken, field: '类别' });
    assert.equal(values.status, 'success', JSON.stringify(values));
    assert.deepEqual(values.values, ['A', 'B']);
    assert.equal(values.valuesState, 'complete');
    assert.equal(h.facts.length, 2);
    for (const fact of h.facts) {
      assert.equal(fact.config, null, 'pending 不启用实验配置');
      assert.equal(fact.lease.resources.memoryBytes, 0, '兼容记账不声称工作集为零');
      for (const key of ['cpuSlots', 'workerThreadSlots', 'ioHeavySlots']) assert.equal(fact.lease.resources[key], 1);
      assert.ok(fact.activity.blockers.some((item) => item.kind === 'carrier' && item.maxGrowthBytes === null));
      assert.equal(fact.closed, true);
      assert.equal(fact.leaseCountAtExit, 1);
      assert.equal(fact.directoryAtExit, true, '私有目录保留至真实退出');
    }
    assert.deepEqual(fs.readdirSync(h.root), [path.basename(h.input)]);
    const savePath = path.join(h.root, '按字段拆分.xlsx');
    const exported = await dispatchLargeSplit({ op: 'exportFilter', filePath: h.input, field: values.field,
      values: [values.values[0]], savePath, batchContext: {
        batchId: 1, batchNumber: 'SPLIT-COMPATIBILITY', taskRunId: 'split-compatibility',
        taskKey: 'toolbox:split:export', moduleId: 'toolbox', parentRunId: 'split-compatibility-parent',
        operationKey: 'split-compatibility-operation'
      } }).promise;
    assert.equal(exported.matchedCount, 1);
    const workbook = XLSX.readFile(savePath);
    const rows = XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]], { header: 1 });
    assert.deepEqual(rows.map((row) => row.map(String)), [['类别', '金额'], ['A', '1']]);
  }));
}

test('固定 Worker 配额不足：立即失败、不创建 Worker，IPC 返回中文诊断', () => withHarness({ budgets: { workerThreadSlots: 0 } }, async (h) => {
  const result = await h.read();
  assert.equal(result.status, 'failed');
  assert.equal(result.code, 'RESOURCE_BUDGET_UNAVAILABLE');
  assert.match(result.message, /读取.*资源.*不足/);
  assert.ok(result.detailLines.some((line) => /固定配额.*未进入等待队列/.test(line)));
  assert.equal(h.governor.snapshot().queued.size, 0);
  assert.equal(h.facts.length, 0);
}));

test('零兼容预算仍遵守 IO 槽位：先排队，释放后成功', () => withHarness({}, async (h) => {
  const held = await h.governor.acquirePhaseLease({ ownerKey: 'other-io', actionKey: 'legacy-io', resources: vector({ ioHeavySlots: 1 }) });
  let pending;
  try {
    pending = h.read(); await tick();
    assert.equal(h.governor.snapshot().queued.size, 1);
    assert.equal(h.facts.length, 0);
  } finally { held.release(); }
  assert.equal((await pending).status, 'success');
}));

test('IO 争用超过 5 秒：返回等待超时中文，保留另一任务租约', () => withHarness({}, async (h) => {
  const held = await h.governor.acquirePhaseLease({ ownerKey: 'other-io', actionKey: 'legacy-io', resources: vector({ ioHeavySlots: 1 }) });
  try {
    const result = await h.read();
    assert.equal(result.status, 'failed');
    assert.equal(result.code, 'ADMISSION_TIMEOUT');
    assert.match(result.message, /读取.*等待.*超时/);
    assert.ok(result.detailLines.some((line) => /等待其他任务完成后重试/.test(line)));
    assert.equal(h.governor.snapshot().activeLeaseCount, 1);
    assert.equal(h.facts.length, 0);
  } finally { held.release(); }
}));

test('其他 Governor 的低档仍阻止兼容扫描，释放后恢复', () => withHarness({}, async (h) => {
  const low = createResourceGovernor({ budgets: { ...SCAN_RESOURCES, memoryBytes: 2048 * MiB },
    memoryAdmission: createExperimentalMemoryPolicy({ modes: ['low'],
      sampleMemory: () => ({ availableBytes: 2048 * MiB, sampledAt: Date.now() }) }) });
  const unregister = registerMemoryGovernor(low);
  let lease;
  try {
    lease = await low.acquirePhaseLease({ ownerKey: 'toolbox-split-read', actionKey: 'toolbox:split:prepare', resources: SCAN_RESOURCES });
    assert.equal(lease.memoryMode, 'low');
    const pending = h.read(); await tick();
    assert.equal(h.governor.snapshot().queued.size, 1);
    assert.equal(h.facts.length, 0);
    lease.release(); lease = null;
    assert.equal((await pending).status, 'success');
  } finally { lease?.release(); closeResourceGovernor(low); unregister(); }
}));

for (const mode of ['normal', 'low']) test(`实验 ${mode} 获批候选仍替换兼容记账并传入真实 Worker`, () => withHarness({ mode }, async (h) => {
  const result = await h.read();
  assert.equal(result.status, 'success', JSON.stringify(result));
  assert.equal(result.executionMode, mode);
  const fact = h.facts[0];
  assert.equal(fact.config.phaseKey, 'split-prepare');
  assert.equal(fact.lease.resources.memoryBytes, (mode === 'normal' ? 768 : 256) * MiB);
  assert.equal(fact.closed, true);
}));

(async () => {
  let passed = 0;
  const failures = [];
  for (const { name, run } of cases) {
    try { await run(); passed++; console.log(`PASS ${name}`); }
    catch (error) { failures.push(name); console.error(`FAIL ${name}\n${error.stack}`); }
  }
  console.log(`==== ${passed}/${cases.length} PASS ====`);
  if (failures.length) { console.error('FAILURES', failures); process.exitCode = 1; }
})().catch((error) => { console.error('FAILURES', error); process.exitCode = 1; });
