'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const test = require('node:test');
const ExcelJS = require('exceljs');
const XLSX = require('xlsx');
const { DatabaseSync } = require('node:sqlite');
const { sourceSnapshotFromStat } = require('../../../src/main-process/archive-center/source-snapshot');
const { normalizeFilePlanV1 } = require('../../../src/main-process/archive-center/file-plan');
const { scanToolboxSplitFields } = require('../../../src/main-process/toolbox-format-operations');
const { createToolboxOutputWriter } = require('../../../src/main-process/toolbox-output-writer');
const { createBackgroundExecutionRuntime } = require('../../../src/main-process/background-execution/runtime');
const { ROWS_BUDGETS, planRowCounts, buildRowTargets, validatePlan, writePrivateJson, readPrivateJson, sha256 } = require('../../../src/main-process/toolbox-row-split/contracts');
const { prepareRows, generateValidateAndPublishRows } = require('../../../src/main-process/toolbox-row-split/service');
const { executeRowsGeneration } = require('../../../src/main-process/toolbox-row-split/executor');
const { openCache } = require('../../../src/main-process/toolbox-row-split/cache');
const { assertFinanceSafeValue } = require('../../../src/main-process/background-execution/error-codec');
const { validateRowsResult } = require('../../../src/main-process/toolbox-row-split/contracts');
const { operationContextFromBatch } = require('../../../src/main-process/toolbox-background/generation-validator');
const { prepareToolboxPublication, publishPreparedToolboxPublication, ToolboxPublicationCrashError } = require('../../../src/main-process/toolbox-output-publication');
const { recoverToolboxPublicationsAsync } = require('../../../src/main-process/toolbox-output-publication-dispatch');

function fixture(t) {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'toolbox-rows-test-')));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

async function workbook(filePath, size = 10, multiple = false) {
  const book = new ExcelJS.Workbook();
  const header = ['序号', '编号', '日期', '布尔', '结果', '错误'];
  let sheet;
  for (let i = 0; i < size; i += 1) {
    if (!sheet || (multiple && i === Math.floor(size / 2))) {
      sheet = book.addWorksheet('Sheet' + book.worksheets.length, { state: sheet ? 'hidden' : 'visible' });
      sheet.addRow(header);
      sheet.getRow(1).font = { bold: true, color: { argb: 'FF223344' } };
      sheet.getColumn(2).width = 24;
    }
    const row = sheet.addRow([i + 1, '000' + i, new Date('2024-01-02T00:00:00Z'), i % 2 === 0,
      { formula: '1+2', result: 3 }, { error: '#N/A' }]);
    row.getCell(2).numFmt = '@';
    row.getCell(3).numFmt = 'yyyy-mm-dd';
    row.getCell(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFDD00' } };
  }
  if (!size) book.addWorksheet('Empty').addRow(header);
  await book.xlsx.writeFile(filePath);
}

const context = { batchId: 1, batchNumber: 'ROWS-TEST', taskRunId: 'rows-test-run',
  taskKey: 'toolbox:split:export', moduleId: 'toolbox', parentRunId: 'rows-parent', operationKey: 'rows-test-operation' };

function makePlan(directory, source, rowCount, rowsPerFile) {
  const counts = planRowCounts(rowCount, rowsPerFile);
  const targets = buildRowTargets(source, directory, counts);
  const filePlan = normalizeFilePlanV1({ version: 1, allocation: 'eager',
    inputs: [{ filePath: source, role: 'input', sourceOperation: 'toolbox:split:export' }],
    outputs: targets.map((item) => ({ filePath: item.filePath, role: 'output', sourceOperation: 'toolbox:split:export' })) });
  const privateDirectory = fs.mkdtempSync(path.join(directory, '.private-'));
  return { counts, filePlan, privateDirectory };
}

function directInput(options) {
  const { counts, filePlan, privateDirectory } = options;
  const source = filePlan.inputs[0];
  const plan = validatePlan({ version: 1, action: 'toolbox:split-rows', attemptId: crypto.randomUUID(),
    taskRunId: context.taskRunId, source: { filePath: source.filePath, sourceSnapshot: source.sourceSnapshot },
    ...counts, privateDirectory,
    parts: buildRowTargets(source.filePath, path.dirname(filePlan.outputs[0].filePath), counts)
      .map((part, i) => ({ ...part, artifactKey: filePlan.outputs[i].artifactKey,
        generationPath: path.join(privateDirectory, String(i + 1).padStart(4, '0') + '.xlsx') })) });
  const planPath = path.join(privateDirectory, 'plan.json');
  return { plan, input: { version: 1, planPath, tokenId: plan.attemptId,
    planDescriptor: writePrivateJson(planPath, plan, ROWS_BUDGETS.maxPlanBytes) } };
}

async function readOutput(filePath) {
  const book = new ExcelJS.Workbook();
  await book.xlsx.readFile(filePath);
  return book;
}

test('严格行数和安全整数边界；1001 份在分配路径前拒绝', () => {
  for (const value of [0, -1, 1.2, '2', NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => planRowCounts(10, value));
  }
  assert.throws(() => planRowCounts(0, 1), { code: 'TOOLBOX_ROWS_EMPTY' });
  assert.throws(() => planRowCounts(1001, 1), { code: 'TOOLBOX_ROWS_TOO_MANY_FILES' });
  for (const count of [1, 8, 9, 999, 1000]) assert.equal(planRowCounts(count, 1).fileCount, count);
  assert.equal(planRowCounts(Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER).fileCount, 1);
  assert.equal(planRowCounts(Number.MAX_SAFE_INTEGER, Math.ceil(Number.MAX_SAFE_INTEGER / 1000)).fileCount, 1000);
});

test('prepare 使用主进程计数；空数据/超限/非法参数不调用目录选择器', async (t) => {
  const dir = fixture(t);
  const source = path.join(dir, 'input.csv'); fs.writeFileSync(source, 'A\n1\n');
  let called = 0;
  const readContext = { sourceFilePath: source, snapshot: sourceSnapshotFromStat(fs.statSync(source)) };
  const hooks = { chooseDirectory: async () => { called += 1; return dir; }, confirmOverwrite: async () => true };
  const payload = { sourceFilePath: source, splitReadToken: 't', mode: 'rows', rowsPerFile: 1 };
  for (const count of [0, undefined, 1001]) {
    await assert.rejects(prepareRows(payload, { ...readContext, dataRowCount: count }, hooks));
  }
  await assert.rejects(prepareRows({ ...payload, rowCount: 1 }, { ...readContext, dataRowCount: 1 }, hooks));
  assert.equal(called, 0);
  const prepared = await prepareRows(payload, { ...readContext, dataRowCount: 1 }, hooks);
  assert.equal(called, 1);
  assert.equal(prepared.targets[0].fileName, 'input_按行拆分_0001.xlsx');
  fs.linkSync(source, prepared.targets[0].filePath);
  readContext.snapshot = sourceSnapshotFromStat(fs.statSync(source));
  await assert.rejects(prepareRows(payload, { ...readContext, dataRowCount: 1 }, hooks), /不能覆盖/);
});

test('SPLIT 计数跨隐藏 Sheet；缓存回放保留行序、文本、日期、布尔、错误、样式和重复表头', async (t) => {
  const dir = fixture(t), source = path.join(dir, 'input.xlsx');
  await workbook(source, 10, true);
  const scan = await scanToolboxSplitFields(source);
  assert.equal(scan.dataRowCount, 10);
  const { plan, input } = directInput(makePlan(dir, source, 10, 4));
  const events = [];
  let active = 0, maximum = 0;
  const result = await executeRowsGeneration(input, null, {
    onWriterEvent(event, index) {
      events.push([event, index]);
      if (event === 'create') { active += 1; maximum = Math.max(maximum, active); }
      if (event === 'release') active -= 1;
    },
    writerFactory(options) {
      const writer = createToolboxOutputWriter(options);
      return { ...writer, async commitAndValidate() {
        await new Promise((resolve) => setTimeout(resolve, 15));
        return writer.commitAndValidate();
      } };
    }
  });
  assert.equal(maximum, 1); assert.equal(active, 0);
  assert.deepEqual(events.map((item) => item[0]), Array(3).fill(['create', 'commit', 'release']).flat());
  const manifest = readPrivateJson(path.join(plan.privateDirectory, 'outputs.json'), result.manifest, ROWS_BUDGETS.maxManifestBytes);
  assert.deepEqual(manifest.files.map((file) => file.dataRowCount), [4, 4, 2]);
  const ids = [];
  for (const file of manifest.files) {
    const out = await readOutput(file.generationPath);
    assert.equal(out.worksheets[0].getCell('A1').font.bold, true);
    assert.equal(out.worksheets[0].getColumn(2).width, 24);
    for (const sheet of out.worksheets) {
      for (let i = 2; i <= sheet.rowCount; i += 1) {
        const row = sheet.getRow(i); ids.push(row.getCell(1).value);
        assert.equal(row.getCell(2).value, '000' + (row.getCell(1).value - 1));
        assert.equal(row.getCell(2).numFmt, '@');
        assert.ok(row.getCell(3).value instanceof Date);
        assert.equal(typeof row.getCell(4).value, 'boolean');
        assert.equal(row.getCell(5).value, 3);
        assert.deepEqual(row.getCell(6).value, { error: '#N/A' });
        assert.equal(row.getCell(1).fill.fgColor.argb, 'FFFFDD00');
      }
    }
  }
  assert.deepEqual(ids, Array.from({ length: 10 }, (_, i) => i + 1));
});

test('N 是文件行数；单文件超出 Sheet 容量会续页且不增加文件', async (t) => {
  const dir = fixture(t), source = path.join(dir, 'input.xlsx'); await workbook(source, 5);
  const { input } = directInput(makePlan(dir, source, 5, Number.MAX_SAFE_INTEGER));
  const result = await executeRowsGeneration(input, null, { maxRowsPerSheet: 2 });
  const manifest = readPrivateJson(path.join(path.dirname(input.planPath), 'outputs.json'), result.manifest, ROWS_BUDGETS.maxManifestBytes);
  assert.equal(manifest.files.length, 1); assert.equal(manifest.files[0].sheetCount, 3);
  const out = await readOutput(manifest.files[0].generationPath);
  assert.deepEqual(out.worksheets.map((sheet) => sheet.rowCount - 1), [2, 2, 1]);
});

test('CSV 与 BIFF 共享 rows 核心，跨块文本编号保留', async (t) => {
  const dir = fixture(t);
  for (const extension of ['csv', 'xls']) {
    const source = path.join(dir, 'input.' + extension);
    if (extension === 'csv') fs.writeFileSync(source, '编号,金额\n0001,12\n0002,13\n0003,14\n');
    else {
      const book = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([['编号', '金额'], ['0001', 12], ['0002', 13], ['0003', 14]]), 'Data');
      XLSX.writeFile(book, source, { bookType: 'biff8' });
    }
    assert.equal((await scanToolboxSplitFields(source)).dataRowCount, 3);
    const { input } = directInput(makePlan(dir, source, 3, 2));
    const result = await executeRowsGeneration(input);
    const manifest = readPrivateJson(path.join(path.dirname(input.planPath), 'outputs.json'), result.manifest, ROWS_BUDGETS.maxManifestBytes);
    assert.deepEqual(manifest.files.map((file) => file.dataRowCount), [2, 1]);
    assert.equal((await readOutput(manifest.files[1].generationPath)).worksheets[0].getCell('A2').value, '0003');
  }
});

test('真实后台 action 返回小描述符，9 份全部校验后才调用一次 Publisher', async (t) => {
  const dir = fixture(t), source = path.join(dir, 'input.xlsx'); await workbook(source, 9);
  const runtime = createBackgroundExecutionRuntime({ availableParallelism: 4, freeMemoryBytes: 8 * 1024 ** 3, totalMemoryBytes: 16 * 1024 ** 3 });
  t.after(() => runtime.shutdown());
  let calls = 0;
  const generated = await generateValidateAndPublishRows({ ...makePlan(dir, source, 9, 1),
    runtime, batchContext: context, publisher: async (files) => {
      calls += 1; assert.equal(files.length, 9);
      for (const file of files) assert.equal(file.sha256, sha256(fs.readFileSync(file.sourcePath)));
      return { files };
    } });
  assert.equal(calls, 1); assert.equal(generated.artifacts.length, 9);
});

test('第 2 个 writer 失败、缓存损坏或取消均不触发 Publisher', async (t) => {
  const dir = fixture(t), source = path.join(dir, 'input.xlsx'); await workbook(source, 4);
  for (const failure of ['writer', 'cache', 'cancel']) {
    let calls = 0, writerCount = 0;
    const controller = new AbortController();
    const runtime = { async execute(request) {
      const result = await executeRowsGeneration(request.input, controller.signal, {
        afterCache(plan) {
          if (failure === 'cache') fs.appendFileSync(path.join(plan.privateDirectory, 'rows.sqlite'), 'broken');
          if (failure === 'cancel') controller.abort();
        },
        writerFactory(options) {
          writerCount += 1;
          if (failure === 'writer' && writerCount === 2) throw new Error('injected writer failure');
          return createToolboxOutputWriter(options);
        }
      });
      return { outcome: 'completed', terminalSource: 'job:done', result };
    } };
    await assert.rejects(generateValidateAndPublishRows({ ...makePlan(dir, source, 4, 2),
      runtime, batchContext: context, publisher: async () => { calls += 1; } }),
    failure === 'writer' ? /injected writer failure/ : (failure === 'cache' ? /缓存身份或摘要/ : /已取消/));
    assert.equal(calls, 0);
    assert.equal(fs.readdirSync(dir).filter((name) => name.includes('按行拆分')).length, 0);
  }
});

test('缓存即使重算摘要，缺失样式引用仍会被拒绝', async (t) => {
  const dir = fixture(t), source = path.join(dir, 'input.xlsx'); await workbook(source, 2);
  const { input, plan } = directInput(makePlan(dir, source, 2, 1));
  await executeRowsGeneration(input);
  const cachePath = path.join(plan.privateDirectory, 'rows.sqlite');
  const db = new DatabaseSync(cachePath); db.exec('DELETE FROM styles'); db.close();
  const seal = { attemptId: plan.attemptId, rowCount: 2,
    byteSize: fs.statSync(cachePath).size, sha256: sha256(fs.readFileSync(cachePath)) };
  assert.throws(() => openCache(plan, seal), /注册表缺失/);
});

test('数字串摘要和 UUID 不被误判为业务账号，消息仍只有有界描述符', () => {
  const result = { version: 1, actionKey: 'toolbox:split-rows',
    tokenId: '01234567-0123-4123-8123-123456789012', outputPlanHash: '123456789012'.padEnd(64, 'a'),
    manifest: { byteSize: 4096, sha256: '123456789012'.padEnd(64, 'b') } };
  assert.ok(validateRowsResult(result));
  assert.doesNotThrow(() => assertFinanceSafeValue(result));
  assert.ok(Buffer.byteLength(JSON.stringify(result)) < 4096);
  assert.equal(validateRowsResult({ ...result, files: [] }), false);
});

test('1000 份 FilePlan 的磁盘身份读取线性增长且仍拒绝输出间硬链接', (t) => {
  const dir = fixture(t), source = path.join(dir, 'input.csv'); fs.writeFileSync(source, 'A\n1\n');
  let reads = 0;
  const fsImpl = Object.create(fs);
  for (const name of ['lstatSync', 'statSync', 'realpathSync']) {
    fsImpl[name] = (...args) => { reads += 1; return fs[name](...args); };
  }
  const outputs = buildRowTargets(source, dir, planRowCounts(1000, 1))
    .map((target) => ({ filePath: target.filePath, role: 'output', sourceOperation: 'toolbox:split:export' }));
  const value = { version: 1, allocation: 'eager',
    inputs: [{ filePath: source, role: 'input', sourceOperation: 'toolbox:split:export' }], outputs };
  assert.equal(normalizeFilePlanV1(value, { fsImpl }).outputs.length, 1000);
  assert.ok(reads < 25000, '不能重新引入成对磁盘访问：' + reads);
  fs.writeFileSync(outputs[0].filePath, 'old');
  fs.linkSync(outputs[0].filePath, outputs[1].filePath);
  assert.throws(() => normalizeFilePlanV1(value), /别名/);
});

test('磁盘预算失败以及旧导入快照均在任务前拒绝', async (t) => {
  const dir = fixture(t), source = path.join(dir, 'input.csv'); fs.writeFileSync(source, 'A\n1\n');
  const payload = { sourceFilePath: source, splitReadToken: 't', mode: 'rows', rowsPerFile: 1 };
  const readContext = { sourceFilePath: source, dataRowCount: 1, snapshot: sourceSnapshotFromStat(fs.statSync(source)) };
  const hooks = { chooseDirectory: async () => dir, confirmOverwrite: async () => true };
  const mocked = t.mock.method(fs, 'statfsSync', () => ({ bavail: 0n, bsize: 4096n }));
  await assert.rejects(prepareRows(payload, readContext, hooks), { code: 'TOOLBOX_ROWS_DISK_BUDGET' });
  mocked.mock.restore();
  fs.appendFileSync(source, '2\n');
  await assert.rejects(prepareRows(payload, readContext, hooks), { code: 'TOOLBOX_SPLIT_READ_CONTEXT_STALE' });
});

test('物化读取预算在启动 CSV reader 和目录选择器之前拒绝', async (t) => {
  const dir = fixture(t), source = path.join(dir, 'input.csv');
  const fd = fs.openSync(source, 'w');
  fs.ftruncateSync(fd, ROWS_BUDGETS.maxMaterializedSourceBytes + 1); fs.closeSync(fd);
  let calls = 0;
  await assert.rejects(prepareRows({ sourceFilePath: source, splitReadToken: 't', mode: 'rows', rowsPerFile: 1 },
    { sourceFilePath: source, dataRowCount: 1, snapshot: sourceSnapshotFromStat(fs.statSync(source)) },
    { chooseDirectory: async () => { calls += 1; return dir; }, confirmOverwrite: async () => true }),
  { code: 'TOOLBOX_ROWS_SOURCE_BUDGET' });
  assert.equal(calls, 0);
});

test('运行中的真实 rows Worker 响应 shutdown，退出后不产生正式输出', async (t) => {
  const dir = fixture(t), source = path.join(dir, 'input.csv');
  fs.writeFileSync(source, '序号,内容\n' + Array.from({ length: 20000 }, (_, index) => index + ',' + 'value'.repeat(40) + '\n').join(''));
  const options = makePlan(dir, source, 20000, 20000);
  const { input } = directInput(options);
  const runtime = createBackgroundExecutionRuntime({ availableParallelism: 4, freeMemoryBytes: 8 * 1024 ** 3, totalMemoryBytes: 16 * 1024 ** 3 });
  t.after(() => runtime.shutdown());
  const control = runtime.start({ actionKey: 'toolbox:split-rows', operationKey: context.operationKey,
    production: true, context: { kind: 'operation', value: operationContextFromBatch(context) }, input });
  await control.ready;
  const deadline = Date.now() + 10000;
  while (!fs.existsSync(path.join(options.privateDirectory, 'rows.sqlite')) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(fs.existsSync(path.join(options.privateDirectory, 'rows.sqlite')), '需要取消已实际开始缓存的任务');
  const report = await runtime.shutdown({ timeoutMs: 5000 });
  const terminal = await control.promise;
  assert.notEqual(terminal.outcome, 'completed');
  assert.deepEqual(report.leakedTransports, []);
  assert.equal(fs.existsSync(path.join(options.privateDirectory, 'outputs.json')), false);
  assert.equal(fs.readdirSync(dir).filter((name) => name.includes('按行拆分')).length, 0);
});

test('rows 第 2 份发布时崩溃，现有 journal 在新 Worker 内恢复旧目标', async (t) => {
  const dir = fixture(t), source = path.join(dir, 'input.csv');
  fs.writeFileSync(source, 'A\n1\n2\n3\n4\n5\n6\n7\n8\n9\n');
  const targets = buildRowTargets(source, dir, planRowCounts(9, 1));
  for (const target of targets) fs.writeFileSync(target.filePath, 'old-' + target.partIndex);
  const options = makePlan(dir, source, 9, 1);
  const userDataDir = path.join(dir, 'user-data'); fs.mkdirSync(userDataDir);
  let publisherCalls = 0;
  const runtime = { async execute(request) {
    return { outcome: 'completed', terminalSource: 'job:done', result: await executeRowsGeneration(request.input) };
  } };
  await assert.rejects(generateValidateAndPublishRows({ ...options, runtime, batchContext: context,
    publisher: async (artifacts) => {
      publisherCalls += 1;
      const prepared = prepareToolboxPublication({
        taskId: 'rows-crash', artifacts, userDataDir, batchContext: context,
        archiveInputFiles: options.filePlan.inputs, protectedSourcePaths: [source],
        requireValidatedArtifacts: true, requireArchiveHandoff: true,
        targets: options.filePlan.outputs.map((item) => ({ targetPath: item.filePath, expectedTargetSnapshot: item.targetSnapshot })),
        checkpoint(name, event) {
          if (name === 'publish:after-publish-rename-before-journal' && event.index === 1) {
            throw new ToolboxPublicationCrashError(name);
          }
        }
      });
      return publishPreparedToolboxPublication(prepared);
    } }), /crash/i);
  assert.equal(publisherCalls, 1);
  await recoverToolboxPublicationsAsync({ userDataDir });
  for (const target of targets) assert.equal(fs.readFileSync(target.filePath, 'utf8'), 'old-' + target.partIndex);
  assert.equal(fs.readFileSync(source, 'utf8'), 'A\n1\n2\n3\n4\n5\n6\n7\n8\n9\n');
});

test('9 份真实 rows 输出只归属一个业务批次，原件和全部输出均归档 ready 后清理 receipt', async (t) => {
  const { createArchiveService } = require('../../../src/main-process/archive-center/archive-service');
  const { createArchiveCenterController } = require('../../../src/main-process/archive-center/controller');
  const { createArchiveOutboxStore } = require('../../../src/main-process/archive-center/outbox-store');
  const { createArchiveRepository } = require('../../../src/backend/database/archive-repository');
  const { recoverToolboxPublicationsIntoArchive } = require('../../../src/main-process/toolbox-archive-recovery');
  const { publishToolboxPublicationAsync } = require('../../../src/main-process/toolbox-output-publication-dispatch');
  const { JOURNAL_INDEX_NAME } = require('../../../src/main-process/toolbox-output-publication');
  const dir = fixture(t), source = path.join(dir, 'input.csv');
  fs.writeFileSync(source, 'A\n1\n2\n3\n4\n5\n6\n7\n8\n9\n');
  const db = new DatabaseSync(path.join(dir, 'archive.sqlite')); db.exec('PRAGMA foreign_keys=ON');
  t.after(() => db.close());
  const userDataDir = path.join(dir, 'user-data'); fs.mkdirSync(userDataDir);
  const service = createArchiveService({ database: db, rootDir: path.join(dir, 'archive') });
  const settings = new Map();
  const controller = createArchiveCenterController({ service,
    outboxStore: createArchiveOutboxStore(path.join(dir, 'outbox')),
    database: { getSetting: (key) => settings.get(key) || null,
      setSetting: (key, value) => settings.set(key, value), listTemplates: () => [] } });
  await controller.initialize();
  const reserved = await service.reserveTaskBatch({ moduleId: 'toolbox', moduleCode: 'TOOLBOX', moduleName: '工具箱',
    operationKey: 'rows-archive-test', taskKey: 'toolbox:split:export', taskRunId: 'rows-archive-run', parentRunId: 'rows-archive-parent' });
  assert.equal(reserved.ok, true);
  await service.markTaskStarted(reserved.batchId);
  const batch = reserved.batch;
  const batchContext = { batchId: batch.id, batchNumber: batch.batchNumber, taskRunId: batch.taskRunId,
    taskKey: batch.taskKey, moduleId: batch.moduleId, parentRunId: batch.parentRunId, operationKey: batch.operationKey };
  const options = makePlan(dir, source, 9, 1);
  const runtime = createBackgroundExecutionRuntime({ availableParallelism: 4, freeMemoryBytes: 8 * 1024 ** 3, totalMemoryBytes: 16 * 1024 ** 3 });
  t.after(() => runtime.shutdown());
  const generated = await generateValidateAndPublishRows({ ...options, runtime, batchContext,
    publisher: (artifacts) => publishToolboxPublicationAsync({ taskId: 'rows-archive-publication',
      artifacts, targets: options.filePlan.outputs.map((item) => ({ targetPath: item.filePath, expectedTargetSnapshot: item.targetSnapshot })),
      userDataDir, batchContext, archiveInputFiles: options.filePlan.inputs, protectedSourcePaths: [source] }) });
  assert.equal(JSON.parse(fs.readFileSync(path.join(userDataDir, JOURNAL_INDEX_NAME))).entries.length, 1);
  await recoverToolboxPublicationsIntoArchive({ userDataDir, archiveCenter: controller,
    recoverPublications: recoverToolboxPublicationsAsync, taskIds: [generated.publication.taskId] });
  const detail = createArchiveRepository(db).getBatchDetail(reserved.batchId);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM archive_batches').get().count, 1);
  assert.equal(detail.taskStatus, 'succeeded');
  assert.equal(detail.artifacts.filter((item) => item.role === 'input').length, 1);
  assert.equal(detail.artifacts.filter((item) => item.role === 'output').length, 9);
  assert.ok(detail.artifacts.every((item) => item.status === 'ready'));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(userDataDir, JOURNAL_INDEX_NAME))).entries, []);
});
