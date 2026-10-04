// CSV rows 跨阶段准入：普通档 metadata → 同一 token → 内存下降 → 正式生成、验证和发布。
// 实际 Main/生产策略/Supervisor/Worker/SQLite/Publisher；平台、可用内存、对话框和归档回执为夹具。
// 用法：node scripts/integration/toolbox-rows-csv-admission.js
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { withRowsCsv, waitFor, readOutputRows } = require('../../tests/helpers/toolbox-rows-csv');
const { LOW_MEMORY_CSV_MAX_BYTES: limit } = require('../../src/backend/toolbox-format/csv-capacity');
const cases = [];
const test = (name, run) => cases.push({ name, run });
const content = 'a,b,c,d,e,f,g,h\n' + '1,2,3,4,5,6,7,8\n'.repeat(20000);
const expected = ['1', '2', '3', '4', '5', '6', '7', '8'];
async function prepared(h) {
  const metadata = await h.scan();
  assert.equal(metadata.status, 'success', JSON.stringify(metadata));
  const operation = await h.prepare(metadata);
  assert.equal(operation.prepared.proceed, true, JSON.stringify(operation.prepared));
  assert.equal(operation.prepared.readContext.token, metadata.splitReadToken);
  return { metadata, ...operation };
}
function noGenerated(h) {
  assert.equal(h.starts.length, 0); assert.equal(h.state.publisherCalls, 0); assert.equal(h.state.settled, 0);
  assert.deepEqual(h.cleanup, [['plan.json']]); assert.deepEqual(fs.readdirSync(h.output), []);
}
async function accurateOutput(h, result, count, mode) {
  assert.equal(result.status, 'success', JSON.stringify(result));
  assert.equal(result.outputDataRowCount, count); assert.equal(h.starts.length, 1);
  assert.equal(h.starts[0].memoryConfig.profileId, `rows-generation-${mode}-v1`);
  const actual = await readOutputRows(result);
  assert.equal(actual.length, count); assert.ok(actual.every((row) => JSON.stringify(row) === JSON.stringify(expected)));
  assert.equal(h.workerLimits[1].maxOldGenerationSizeMb, mode === 'low' ? 230 : 460);
  assert.equal(h.workerLimits[1].maxYoungGenerationSizeMb, 8);
  assert.equal(h.state.publisherCalls, 1); assert.equal(h.state.settled, 1);
  assert.ok(h.cleanup[0].includes('rows.sqlite')); assert.ok(h.cleanup[0].includes('outputs.json'));
  await h.publication.recovery.recover({ reason: 'business-retry' });
}
test('150 万行普通档 metadata 后降到 768 MiB：正式 rows 受控超时，零生成 Worker', () => withRowsCsv({ dense: true }, async (h) => {
  const before = h.hash(h.source), operation = await prepared(h);
  assert.equal(operation.metadata.dataRowCount, 1500000); assert.equal(operation.metadata.executionMode, 'normal');
  h.state.availableMiB = 768;
  const result = await operation.execute();
  assert.equal(result.code, 'ADMISSION_TIMEOUT'); assert.match(result.message, /按行拆分等待后台资源超时/);
  noGenerated(h); assert.equal(h.hash(h.source), before);
}));
test('20,000 行 CSV 同一 token 在内存恢复后普通档生成、SQLite 缓存、发布及独立回读', () => withRowsCsv({ content }, async (h) => {
  const before = h.hash(h.source), operation = await prepared(h);
  assert.equal(operation.metadata.executionMode, 'normal'); h.state.availableMiB = 768;
  const pending = operation.execute(); await waitFor(() => h.runtime.resourceGovernor.snapshot().queued.size === 1);
  assert.equal(h.starts.length, 0); assert.equal(h.workers.length, 1);
  h.state.availableMiB = 2048;
  await accurateOutput(h, await pending, 20000, 'normal'); assert.equal(h.hash(h.source), before);
}));
const boundary = 'a,b,c,d,e,f,g,h\n' + '1,2,3,4,5,6,7,8\n'.repeat((limit - 16) / 16);
assert.equal(Buffer.byteLength(boundary), limit);
for (const delta of [-1, 0, 1]) test(`rows CSV 低档边界 ${limit + delta} 字节的完整输出`, () => withRowsCsv({
  content: delta === -1 ? boundary.slice(0, -1) : boundary + (delta ? '\n' : '')
}, async (h) => {
  const operation = await prepared(h); h.state.availableMiB = 768;
  const pending = operation.execute();
  if (delta > 0) {
    await waitFor(() => h.runtime.resourceGovernor.snapshot().queued.size === 1);
    assert.equal(h.starts.length, 0); h.state.availableMiB = 2048;
  }
  await accurateOutput(h, await pending, (limit - 16) / 16, delta > 0 ? 'normal' : 'low');
}));
test('低档边界密集单列的 131071 行完成缓存、分块输出和独立回读', () => withRowsCsv({
  content: 'a\n' + '1\n'.repeat((limit - 2) / 2)
}, async (h) => {
  const operation = await prepared(h); assert.equal(operation.metadata.dataRowCount, 131071);
  h.state.availableMiB = 768;
  const result = await operation.execute(); assert.equal(result.status, 'success', JSON.stringify(result));
  assert.equal(h.starts[0].memoryConfig.profileId, 'rows-generation-low-v1');
  assert.equal(h.workerLimits[1].maxOldGenerationSizeMb, 230);
  const rows = await readOutputRows(result); assert.equal(rows.length, 131071);
  assert.ok(rows.every((row) => row.length === 1 && row[0] === '1'));
  assert.equal(h.state.publisherCalls, 1); assert.equal(h.state.settled, 1);
}));
test('普通档超固定硬额度时拒绝大 CSV，不使用仍可容纳的低档', () => withRowsCsv({ content, hardMiB: 512 }, async (h) => {
  // 大来源 metadata 需要普通档，因此此项直接验证 Main 生成入口，计数由夹具提供。
  const { normalizeFilePlanV1 } = require('../../src/main-process/archive-center/file-plan');
  const { generateValidateAndPublishRows } = require('../../src/main-process/toolbox-row-split/service');
  const { planRowCounts, buildRowTargets } = require('../../src/main-process/toolbox-row-split/contracts');
  const path = require('node:path');
  const counts = planRowCounts(20000, 10000), targets = buildRowTargets(h.source, h.output, counts);
  const filePlan = normalizeFilePlanV1({ version: 1, allocation: 'eager', inputs: [{ filePath: h.source, role: 'input', sourceOperation: 'toolbox:split:export' }],
    outputs: targets.map((item) => ({ filePath: item.filePath, role: 'output', sourceOperation: 'toolbox:split:export' })) });
  const privateDirectory = fs.mkdtempSync(path.join(h.root, 'direct-'));
  await assert.rejects(generateValidateAndPublishRows({ runtime: h.runtime, filePlan, counts, privateDirectory,
    batchContext: { batchId: 1, batchNumber: 'HARD', taskRunId: 'hard-rows', taskKey: 'toolbox:split:export', moduleId: 'toolbox', parentRunId: 'parent', operationKey: 'hard-rows' },
    publisher: () => { throw new Error('不可发布'); } }), { code: 'RESOURCE_BUDGET_UNAVAILABLE' });
  assert.equal(h.starts.length, 0); assert.equal(h.workers.length, 0); assert.deepEqual(fs.readdirSync(privateDirectory), ['plan.json']);
}));
test('排队期间来源增长：内存恢复后 Worker 在解析前拒绝，原目标不发布', () => withRowsCsv({ content }, async (h) => {
  const operation = await prepared(h); h.state.availableMiB = 768;
  const pending = operation.execute(); await waitFor(() => h.runtime.resourceGovernor.snapshot().queued.size === 1);
  fs.appendFileSync(h.source, 'changed\n'); h.state.availableMiB = 2048;
  const result = await pending;
  assert.equal(result.code, 'ARCHIVE_INPUT_CHANGED'); assert.equal(h.starts.length, 1);
  assert.equal(h.state.publisherCalls, 0); assert.deepEqual(h.cleanup, [['plan.json']]);
}));
test('普通档等待期间关闭：不创建 Worker，释放 base 和队列', () => withRowsCsv({ content }, async (h) => {
  const operation = await prepared(h); h.state.availableMiB = 768;
  const pending = operation.execute(); await waitFor(() => h.runtime.resourceGovernor.snapshot().queued.size === 1);
  await h.runtime.shutdown(); const result = await pending;
  assert.equal(result.status, 'failed'); assert.equal(result.code, 'ADMISSION_CANCELLED'); noGenerated(h);
}));
test('Renderer 不能通过额外 allowLowMemory 参数扩大候选', () => withRowsCsv({}, async (h) => {
  const metadata = await h.scan();
  const operation = await h.prepare(metadata, 2, { allowLowMemory: true });
  assert.equal(operation.prepared.proceed, false); assert.equal(operation.prepared.result.code, 'TOOLBOX_ROWS_CONTRACT_INVALID');
  assert.equal(h.starts.length, 0);
}));
test('防御性验证：强制真实 rows 低档 Worker 遇到大 CSV 时受控拒绝，无 OOM', () => withRowsCsv({ content, forceRowsLow: true }, async (h) => {
  const operation = await prepared(h), result = await operation.execute();
  assert.equal(result.code, 'EXECUTION_INPUT_PROFILE_UNSUITABLE');
  assert.equal(h.starts[0].memoryConfig.profileId, 'rows-generation-low-v1');
  assert.equal(h.workerLimits[1].maxOldGenerationSizeMb, 230);
  assert.equal(h.state.publisherCalls, 0); assert.deepEqual(h.cleanup, [['plan.json', 'rows.sqlite']]);
}));
test('pending 兼容路径保留大 CSV 的正式生成和输出', () => withRowsCsv({ content, pending: true }, async (h) => {
  const operation = await prepared(h), result = await operation.execute();
  assert.equal(result.status, 'success', JSON.stringify(result)); assert.equal(h.starts[0].memoryConfig, null);
  const rows = await readOutputRows(result); assert.equal(rows.length, 20000);
  assert.ok(rows.every((row) => JSON.stringify(row) === JSON.stringify(expected)));
  assert.equal(h.state.publisherCalls, 1); assert.equal(h.state.settled, 1);
}));
test('真实 XLSX 大于 CSV 低档范围且扩展名为 csv，正式 rows 仍可使用流式低档', () => withRowsCsv({
  async createSource(source) {
    const XLSX = require('xlsx'); const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([['编号', '文本'],
      ...Array.from({ length: 1000 }, (_, n) => [String(n).padStart(6, '0'), 'x'.repeat(400)])]), '数据');
    XLSX.writeFile(book, source, { bookType: 'xlsx', compression: false }); assert.ok(fs.statSync(source).size > limit);
  }
}, async (h) => {
  const operation = await prepared(h); h.state.availableMiB = 768;
  const result = await operation.execute(); assert.equal(result.status, 'success', JSON.stringify(result));
  assert.equal(h.starts[0].memoryConfig.profileId, 'rows-generation-low-v1');
  const rows = await readOutputRows(result); assert.equal(rows.length, 1000);
  rows.forEach((row, n) => assert.deepEqual(row, [String(n).padStart(6, '0'), 'x'.repeat(400)]));
}));
(async () => {
  let passed = 0;
  for (const { name, run } of cases) {
    if (process.argv[2] && !name.includes(process.argv[2])) continue;
    await run(); passed++; console.log('PASS', name);
  }
  assert.ok(passed > 0); console.log(`==== ${passed}/${passed} PASS ====`);
})().catch((error) => { console.error('FAILURES', error); process.exitCode = 1; });
