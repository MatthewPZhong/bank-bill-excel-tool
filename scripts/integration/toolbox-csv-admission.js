// CSV 公共扫描适用性：生产策略、真实 Main IPC、Governor 和 Worker。
// Windows/Electron 身份与可用内存为夹具；不代表 Windows 实机验收。
// 用法：node scripts/integration/toolbox-csv-admission.js
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { loadProductionMemoryProfiles } = require('../../tests/helpers/production-memory-policy');
const { createResourceGovernor, closeResourceGovernor } = require('../../src/main-process/background-execution/resource-governor');
const { createToolboxSplitReadOwner } = require('../../src/main-process/toolbox-split-read-owner');
const { dispatchLargeSplit } = require('../../src/main-process/toolbox-large-split-dispatch');
const { LOW_MEMORY_CSV_MAX_BYTES: limit } = require('../../src/backend/toolbox-format/csv-capacity');
const { registerMemoryGovernor, registerWithMemoryActivity, sealMemoryActivityInventory,
  memoryActivitySnapshot } = require('../../src/main-process/memory-activity');
const MiB = 1024 ** 2;
const main = fs.readFileSync(path.join(__dirname, '../../src/main.js'), 'utf8');
const failureStart = main.indexOf('function toolboxFailureResult(error) {');
const failureEnd = main.indexOf('\nfunction shouldPreserveToolboxTemporaryFiles', failureStart);
const readStart = main.indexOf("ipcMain.handle('toolbox:split:read'");
const readEnd = main.indexOf('  // IPC 3', readStart);
assert.ok(failureStart >= 0 && failureEnd > failureStart && readStart >= 0 && readEnd > readStart);
const cases = [];
const test = (name, run) => cases.push({ name, run });
const tick = () => new Promise((resolve) => setImmediate(resolve));
async function queued(h) {
  for (let i = 0; i < 100 && h.governor.snapshot().queued.size === 0; i++) await tick();
  assert.equal(h.governor.snapshot().queued.size, 1);
  assert.equal(h.grants.length, 0, '等待期间不创建解析 Worker');
}
async function withFixture(options, run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'csv-admission-regression-'));
  const file = path.join(root, 'input.csv');
  if (options.xlsx) {
    const XLSX = require('xlsx');
    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([['a', 'b'],
      ...Array.from({ length: 5000 }, (_, i) => [String(i), '文本字段内容'])]), '数据');
    XLSX.writeFile(book, file, { bookType: 'xlsx', compression: false });
    assert.ok(fs.statSync(file).size > limit);
  } else if (options.dense) {
    const fd = fs.openSync(file, 'wx');
    try {
      fs.writeSync(fd, 'a,b,c,d,e,f,g,h\n');
      const chunk = Buffer.from('1,2,3,4,5,6,7,8\n'.repeat(10000));
      for (let i = 0; i < 90; i++) fs.writeSync(fd, chunk);
    } finally { fs.closeSync(fd); }
    assert.equal(fs.statSync(file).size, 14400016);
  } else fs.writeFileSync(file, options.content ?? 'a,b\n1,2\n3,4\n');
  const state = { availableMiB: options.availableMiB ?? 512 };
  const { createProductionMemoryPolicy } = loadProductionMemoryProfiles({
    runtime: { platform: 'win32', arch: 'x64', versions: { electron: '36.9.5' } },
    ...(options.pending ? { qualification: { schemaVersion: 2, status: 'pending' } } : {}),
    sampleMemory: () => ({ availableBytes: state.availableMiB * MiB, sampledAt: Date.now() })
  });
  let governor;
  const policy = createProductionMemoryPolicy({ compatibilityMemoryBytes: 0, getGovernor: () => governor });
  governor = createResourceGovernor({ budgets: { cpuSlots: 1, workerThreadSlots: 1, utilityProcessSlots: 0,
    ioHeavySlots: 1, memoryBytes: (options.hardMiB ?? 2048) * MiB }, memoryAdmission: policy, memoryRecheckMs: 5 });
  const unregister = registerMemoryGovernor(governor);
  const temporaryRoot = path.join(root, 'scans');
  const grants = [];
  const owner = createToolboxSplitReadOwner({ governor, temporaryRoot, dispatch(input) {
    grants.push(input.executionMemoryConfig);
    if (options.changeBeforeWorker) fs.appendFileSync(file, 'changed\n');
    return dispatchLargeSplit(input);
  } });
  const handlers = new Map();
  const ipcMain = { handle: (name, callback) => handlers.set(name, callback) };
  registerWithMemoryActivity(ipcMain, () => vm.runInNewContext(
    main.slice(failureStart, failureEnd) + '\n' + main.slice(readStart, readEnd), {
      ipcMain, getToolboxSplitReadOwner: () => owner,
      showImportOpenDialog: async () => ({ canceled: false, filePaths: [file] }), statementFileDialogFilters: () => []
    }));
  const sender = Object.assign(new EventEmitter(), { id: 1, isDestroyed: () => false });
  const invoke = (name, request) => handlers.get(name)({ sender }, request);
  const read = () => invoke('toolbox:split:read', { version: 2, scanKind: 'metadata', requestId: 'metadata' });
  const values = (metadata) => invoke('toolbox:split:read-values', { version: 2, requestId: 'values',
    splitReadToken: metadata.splitReadToken, field: 'a' });
  try { await run({ root, file, state, governor, owner, sender, grants, read, values, invoke }); }
  finally {
    const closed = await owner.close();
    const snapshot = governor.snapshot();
    closeResourceGovernor(governor); unregister();
    try {
      assert.equal(closed.closed, true); assert.equal(closed.cleanupPendingCount, 0);
      assert.equal(snapshot.activeLeaseCount, 0); assert.equal(snapshot.queued.size, 0);
      assert.equal(owner.snapshot().activeCount, 0);
      assert.deepEqual(fs.existsSync(temporaryRoot) ? fs.readdirSync(temporaryRoot) : [], []);
      assert.deepEqual(memoryActivitySnapshot().blockers, []);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  }
}
sealMemoryActivityInventory();
test('90 万短行在 512 MiB 下等待普通档并受控超时，不启动低档 Worker', () => withFixture({ dense: true }, async (h) => {
  const result = await h.read();
  assert.equal(result.status, 'failed'); assert.equal(result.code, 'ADMISSION_TIMEOUT');
  assert.match(result.message, /等待后台资源超时/); assert.equal(h.grants.length, 0);
}));
test('同一 90 万行 CSV 普通档准确计数，字段补扫同样等待普通档', () => withFixture({ dense: true, availableMiB: 2048 }, async (h) => {
  const metadata = await h.read(); assert.equal(metadata.status, 'success'); assert.equal(metadata.dataRowCount, 900000);
  assert.equal(metadata.executionMode, 'normal');
  h.state.availableMiB = 512;
  const pending = h.values(metadata); await tick();
  assert.equal(h.governor.snapshot().queued.size, 1); assert.equal(h.grants.length, 1);
  h.state.availableMiB = 2048;
  const values = await pending; assert.equal(values.status, 'success'); assert.deepEqual(values.values, ['1']);
  assert.equal(h.grants.length, 2); assert.ok(h.grants.every((config) => config.profileId === 'split-prepare-normal-v1'));
}));
test('超过低档边界一个字节时先排队，内存恢复后同请求使用普通档', () => withFixture({ content: 'a\n' + 'x'.repeat(limit - 1) }, async (h) => {
  const pending = h.read(); await queued(h); h.state.availableMiB = 2048;
  const result = await pending; assert.equal(result.status, 'success'); assert.equal(result.executionMode, 'normal');
}));
test('普通档超过固定硬额度时立即拒绝，不能回退到不适用的低档', () => withFixture({ dense: true, hardMiB: 512 }, async (h) => {
  const result = await h.read(); assert.equal(result.code, 'RESOURCE_BUDGET_UNAVAILABLE'); assert.equal(h.grants.length, 0);
}));
test('pending 零兼容预算仍可读取大 CSV，不把低档容量限制套到兼容路径', () => withFixture({ dense: true, pending: true }, async (h) => {
  const result = await h.read(); assert.equal(result.status, 'success'); assert.equal(result.dataRowCount, 900000);
  assert.deepEqual(h.grants, [null]);
}));
test('小 CSV 的 metadata 和单字段补扫均保留真实低档执行', () => withFixture({}, async (h) => {
  const metadata = await h.read(); assert.equal(metadata.executionMode, 'low'); assert.equal(metadata.dataRowCount, 2);
  const values = await h.values(metadata); assert.deepEqual(values.values, ['1', '3']);
  assert.ok(h.grants.every((config) => config.profileId === 'split-prepare-low-v1'));
  const forged = await h.invoke('toolbox:split:read', { version: 2, scanKind: 'metadata', requestId: 'forged', allowLowMemory: true });
  assert.equal(forged.code, 'TOOLBOX_SPLIT_READ_INVALID');
}));
for (const size of [limit - 1, limit]) test(`低档实际读取边界 ${size} 字节可完成`, () => withFixture({ content: 'a\n' + 'x'.repeat(size - 2) }, async (h) => {
  const result = await h.read(); assert.equal(result.status, 'success'); assert.equal(result.executionMode, 'low'); assert.equal(result.dataRowCount, 1);
}));
for (const [name, content, rows] of [
  ['密集短行', 'a\n' + '1\n'.repeat((limit - 2) / 2), (limit - 2) / 2],
  ['密集空行', 'a\n' + '\n'.repeat(limit - 2), 0],
  ['转义引号', 'a\n"' + '""'.repeat(Math.floor((limit - 5) / 2)) + '"\n', 1],
  ['无效 UTF-8', Buffer.concat([Buffer.from('a\n'), Buffer.alloc(limit - 2, 0xff)]), 1]
]) test(`容量边界的${name}在真实低档堆下完成`, () => withFixture({ content }, async (h) => {
  const result = await h.read(); assert.equal(result.status, 'success', JSON.stringify(result));
  assert.equal(result.dataRowCount, rows); assert.equal(result.executionMode, 'low');
}));
test('扩展名为 CSV 的大 XLSX 按真实格式保留低档流式读取', () => withFixture({ xlsx: true }, async (h) => {
  const result = await h.read(); assert.equal(result.status, 'success', JSON.stringify(result));
  assert.equal(result.executionMode, 'low'); assert.equal(result.dataRowCount, 5000);
}));
test('极宽单行在分配格式化 cell 前受控拒绝，不发生 Worker OOM', () => withFixture({ content: 'a\n' + '1,'.repeat((limit - 4) / 2) + '1\n' }, async (h) => {
  const result = await h.read(); assert.equal(result.code, 'EXECUTION_INPUT_PROFILE_UNSUITABLE'); assert.equal(h.grants.length, 1);
}));
test('排队后文件增长使旧输入判断失效，不启动 Worker', () => withFixture({ availableMiB: 128 }, async (h) => {
  const pending = h.read(); await queued(h); fs.appendFileSync(h.file, 'x'.repeat(limit)); h.state.availableMiB = 2048;
  const result = await pending; assert.equal(result.code, 'TOOLBOX_SPLIT_READ_CONTEXT_STALE'); assert.equal(h.grants.length, 0);
}));
test('Worker 创建前来源变化由实际 Worker 再次拒绝', () => withFixture({ changeBeforeWorker: true }, async (h) => {
  const result = await h.read(); assert.equal(result.code, 'TOOLBOX_SPLIT_READ_CONTEXT_STALE'); assert.equal(h.grants.length, 1);
}));
test('等待普通档时关闭 owner 取消请求并收回排队记录', () => withFixture({ dense: true }, async (h) => {
  const pending = h.read(); await queued(h); await h.owner.close();
  assert.equal((await pending).code, 'ADMISSION_CANCELLED'); assert.equal(h.grants.length, 0);
}));
(async () => {
  let passed = 0;
  for (const { name, run } of cases) { await run(); passed++; console.log(`PASS ${name}`); }
  console.log(`==== ${passed}/${cases.length} PASS ====`);
})().catch((error) => { console.error('FAILURES', error); process.exitCode = 1; });
