// BIFF8 输入适用性：真实 Main、生产策略、Governor、Worker、SQLite、Publisher 和输出回读。
// 覆盖 metadata、字段补扫、同一 token 的 rows、等待恢复、取消及 reader 分配前拒绝。
// Windows/Electron 身份、内存采样、对话框和归档回执由夹具注入，不代表 Windows 实机验收。
// 用法：node scripts/integration/toolbox-biff8-admission.js
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const XLSX = require('xlsx');
const { withRowsCsv, waitFor, readOutputRows } = require('../../tests/helpers/toolbox-rows-csv');
const cases = [];
const test = (name, run) => cases.push({ name, run });
const headers = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
const expected = [1, 2, 3, 4, 5, 6, 7, 8];
function createSource(file, count = 20000) {
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([headers,
    ...Array.from({ length: count }, () => expected.slice())]), '数据');
  XLSX.writeFile(book, file, { bookType: 'biff8' });
  if (count === 20000) assert.equal(fs.statSync(file).size, 2906624);
}
function normalScan(h, result, count = 20000) {
  assert.equal(result.status, 'success', JSON.stringify(result));
  assert.equal(result.executionMode, 'normal'); assert.equal(result.dataRowCount, count);
  assert.deepEqual(result.headers, headers);
  assert.equal(h.scanStarts.at(-1).memoryConfig.profileId, 'split-prepare-normal-v1');
  assert.equal(h.workerLimits.at(-1).maxOldGenerationSizeMb, 460);
  assert.equal(h.workerLimits.at(-1).maxYoungGenerationSizeMb, 8);
}
async function prepared(h) {
  const metadata = await h.scan(); normalScan(h, metadata);
  const operation = await h.prepare(metadata, 10000);
  assert.equal(operation.prepared.proceed, true, JSON.stringify(operation.prepared));
  assert.equal(operation.prepared.readContext.token, metadata.splitReadToken);
  return operation;
}
function noGenerated(h) {
  assert.equal(h.starts.length, 0); assert.equal(h.state.publisherCalls, 0); assert.equal(h.state.settled, 0);
  assert.deepEqual(h.cleanup, [['plan.json']]); assert.deepEqual(fs.readdirSync(h.output), []);
}
test('20,000 行 BIFF8 在 512 MiB 下等待普通档后超时，零 Worker、无 OOM', () => withRowsCsv({
  createSource, availableMiB: 512
}, async (h) => {
  const before = h.hash(h.source), result = await h.scan();
  assert.equal(result.status, 'failed'); assert.equal(result.code, 'ADMISSION_TIMEOUT');
  assert.match(result.message, /等待后台资源超时/);
  assert.equal(h.scanStarts.length, 0); assert.equal(h.workers.length, 0); assert.equal(h.grants.length, 0);
  assert.equal(h.hash(h.source), before);
}));
for (const sourceName of ['input.csv', 'input.xls']) test(`${sourceName} 的 BIFF8 按真实 magic 等待，内存恢复后普通档完成扫描`, () => withRowsCsv({
  createSource, sourceName, availableMiB: 512
}, async (h) => {
  const before = h.hash(h.source), pending = h.scan();
  await waitFor(() => h.runtime.resourceGovernor.snapshot().queued.size === 1);
  assert.equal(h.workers.length, 0); h.state.availableMiB = 2048;
  normalScan(h, await pending); assert.equal(h.hash(h.source), before);
}));
test('BIFF8 普通档 metadata 后降到 512 MiB，字段补扫重新等待并恢复为普通档', () => withRowsCsv({ createSource }, async (h) => {
  const metadata = await h.scan(); normalScan(h, metadata);
  h.state.availableMiB = 512;
  const pending = h.values(metadata);
  await waitFor(() => h.runtime.resourceGovernor.snapshot().queued.size === 1);
  assert.equal(h.scanStarts.length, 1); assert.equal(h.workers.length, 1);
  h.state.availableMiB = 2048;
  const result = await pending; assert.equal(result.status, 'success', JSON.stringify(result));
  assert.equal(result.splitReadToken, metadata.splitReadToken); assert.deepEqual(result.values, ['1']);
  assert.equal(h.scanStarts[1].op, 'scanValues');
  assert.ok(h.scanStarts.every((item) => item.memoryConfig.profileId === 'split-prepare-normal-v1'));
  assert.equal(h.workerLimits[1].maxOldGenerationSizeMb, 460);
}));
test('BIFF8 同一 token 正式 rows 在 768 MiB 下受控超时，不创建低档生成 Worker', () => withRowsCsv({ createSource }, async (h) => {
  const before = h.hash(h.source), operation = await prepared(h); h.state.availableMiB = 768;
  const result = await operation.execute();
  assert.equal(result.code, 'ADMISSION_TIMEOUT'); assert.match(result.message, /按行拆分等待后台资源超时/);
  noGenerated(h); assert.equal(h.hash(h.source), before);
}));
test('BIFF8 同一 token 排队后内存恢复，普通档完成 20,000 行缓存、分块输出、验证和发布', () => withRowsCsv({ createSource }, async (h) => {
  const before = h.hash(h.source), operation = await prepared(h); h.state.availableMiB = 768;
  const pending = operation.execute();
  await waitFor(() => h.runtime.resourceGovernor.snapshot().queued.size === 1);
  assert.equal(h.starts.length, 0); assert.equal(h.workers.length, 1); h.state.availableMiB = 2048;
  const result = await pending; assert.equal(result.status, 'success', JSON.stringify(result));
  assert.equal(result.outputDataRowCount, 20000); assert.equal(result.files.length, 2);
  assert.equal(h.starts.length, 1); assert.equal(h.starts[0].memoryConfig.profileId, 'rows-generation-normal-v1');
  assert.equal(h.workerLimits[1].maxOldGenerationSizeMb, 460);
  assert.equal(h.workerLimits[1].maxYoungGenerationSizeMb, 8);
  const rows = await readOutputRows(result); assert.equal(rows.length, 20000);
  assert.ok(rows.every((row) => JSON.stringify(row) === JSON.stringify(expected)));
  assert.equal(h.state.publisherCalls, 1); assert.equal(h.state.settled, 1);
  assert.ok(h.cleanup[0].includes('rows.sqlite')); assert.ok(h.cleanup[0].includes('outputs.json'));
  assert.equal(h.hash(h.source), before); await h.publication.recovery.recover({ reason: 'business-retry' });
}));
test('BIFF8 普通档超过固定 512 MiB 硬上限时直接拒绝，不回退低档', () => withRowsCsv({ createSource, hardMiB: 512 }, async (h) => {
  const result = await h.scan(); assert.equal(result.code, 'RESOURCE_BUDGET_UNAVAILABLE');
  assert.equal(h.scanStarts.length, 0); assert.equal(h.workers.length, 0);
  assert.equal(h.runtime.resourceGovernor.snapshot().queued.size, 0);
}));
test('防御性验证：强制真实 153/8 MiB 扫描 Worker 读 BIFF8，在前置分配前受控拒绝', () => withRowsCsv({
  createSource, forceScanLow: true
}, async (h) => {
  const result = await h.scan(); assert.equal(result.code, 'EXECUTION_INPUT_PROFILE_UNSUITABLE');
  assert.match(result.message, /BIFF8 XLS/); assert.equal(h.workerLimits[0].maxOldGenerationSizeMb, 153);
  assert.equal(h.workerLimits[0].maxYoungGenerationSizeMb, 8);
  assert.equal(h.workers[0].threadId, -1); assert.equal(h.state.publisherCalls, 0);
}));
test('防御性验证：BIFF8 字段补扫强制低档也在实际 reader 前拒绝', async () => {
  const options = { createSource };
  await withRowsCsv(options, async (h) => {
    const metadata = await h.scan(); normalScan(h, metadata); options.forceScanLow = true;
    const result = await h.values(metadata); assert.equal(result.code, 'EXECUTION_INPUT_PROFILE_UNSUITABLE');
    assert.equal(h.workerLimits[1].maxOldGenerationSizeMb, 153); assert.equal(h.workers[1].threadId, -1);
  });
});
test('防御性验证：强制真实 230/8 MiB rows Worker 读 BIFF8，拒绝且清理未密封缓存', () => withRowsCsv({
  createSource, forceRowsLow: true
}, async (h) => {
  const operation = await prepared(h), result = await operation.execute();
  assert.equal(result.code, 'EXECUTION_INPUT_PROFILE_UNSUITABLE'); assert.match(result.message, /BIFF8 XLS/);
  assert.equal(h.starts[0].memoryConfig.profileId, 'rows-generation-low-v1');
  assert.equal(h.workerLimits[1].maxOldGenerationSizeMb, 230); assert.equal(h.workerLimits[1].maxYoungGenerationSizeMb, 8);
  assert.equal(h.workers[1].threadId, -1); assert.equal(h.state.publisherCalls, 0);
  assert.deepEqual(h.cleanup, [['plan.json', 'rows.sqlite']]);
}));
test('BIFF8 等待扫描普通档时关闭 owner，取消请求且不创建 Worker', () => withRowsCsv({ createSource, availableMiB: 512 }, async (h) => {
  const pending = h.scan(); await waitFor(() => h.runtime.resourceGovernor.snapshot().queued.size === 1);
  await h.owner.close(); assert.equal((await pending).code, 'ADMISSION_CANCELLED'); assert.equal(h.workers.length, 0);
}));
test('BIFF8 正式 rows 等待普通档时关闭 runtime，收回 base 和队列', () => withRowsCsv({ createSource }, async (h) => {
  const operation = await prepared(h); h.state.availableMiB = 768;
  const pending = operation.execute(); await waitFor(() => h.runtime.resourceGovernor.snapshot().queued.size === 1);
  await h.runtime.shutdown(); assert.equal((await pending).code, 'ADMISSION_CANCELLED'); noGenerated(h);
}));
test('BIFF8 排队期间来源变化，内存恢复后仍拒绝旧快照', () => withRowsCsv({ createSource, availableMiB: 512 }, async (h) => {
  const pending = h.scan(); await waitFor(() => h.runtime.resourceGovernor.snapshot().queued.size === 1);
  fs.appendFileSync(h.source, 'changed'); h.state.availableMiB = 2048;
  assert.equal((await pending).code, 'TOOLBOX_SPLIT_READ_CONTEXT_STALE'); assert.equal(h.workers.length, 0);
}));
test('小 BIFF8 不凭磁盘大小启用低档，资源恢复后普通档仍可读取', () => withRowsCsv({
  createSource: (file) => createSource(file, 2), availableMiB: 512
}, async (h) => {
  assert.ok(fs.statSync(h.source).size < 256 * 1024);
  const pending = h.scan(); await waitFor(() => h.runtime.resourceGovernor.snapshot().queued.size === 1);
  assert.equal(h.workers.length, 0); h.state.availableMiB = 2048; normalScan(h, await pending, 2);
}));
test('pending 兼容路径仍支持 BIFF8 metadata、字段补扫和 rows 输出', () => withRowsCsv({
  createSource: (file) => createSource(file, 100), pending: true
}, async (h) => {
  const metadata = await h.scan(); assert.equal(metadata.status, 'success'); assert.equal(metadata.dataRowCount, 100);
  assert.deepEqual((await h.values(metadata)).values, ['1']); assert.ok(h.scanStarts.every((item) => item.memoryConfig === null));
  const operation = await h.prepare(metadata, 50), result = await operation.execute();
  assert.equal(result.status, 'success', JSON.stringify(result)); assert.equal(h.starts[0].memoryConfig, null);
  const rows = await readOutputRows(result); assert.equal(rows.length, 100);
  assert.ok(rows.every((row) => JSON.stringify(row) === JSON.stringify(expected)));
  assert.equal(h.state.publisherCalls, 1); assert.equal(h.state.settled, 1);
}));
(async () => {
  let passed = 0;
  for (const { name, run } of cases) {
    if (process.argv[2] && !name.includes(process.argv[2])) continue;
    await run(); passed++; console.log('PASS', name);
  }
  assert.ok(passed > 0); console.log(`==== ${passed}/${passed} PASS ====`);
})().catch((error) => { console.error('FAILURES', error); process.exitCode = 1; });
