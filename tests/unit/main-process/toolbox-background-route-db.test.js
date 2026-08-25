'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const v8 = require('node:v8');
const { DatabaseSync } = require('node:sqlite');
const ExcelJS = require('exceljs');
const XLSX = require('xlsx');

const { normalizeFilePlanV1 } = require('../../../src/main-process/archive-center/file-plan');
const {
  createToolboxCell,
  createToolboxRow,
  createToolboxSheetMeta
} = require('../../../src/backend/toolbox-format/model');
const { normalizeStaticStyle } = require('../../../src/backend/toolbox-format/style-registry');
const { exportToolboxMultiFilters } = require('../../../src/main-process/toolbox-format-operations');
const {
  createBackgroundExecutionRuntime
} = require('../../../src/main-process/background-execution/runtime');
const {
  TOOLBOX_GENERATION_ACTIONS,
  validateToolboxMultiGenerationResult
} = require('../../../src/main-process/toolbox-background/generation-contract');
const {
  createMultiGenerationInput,
  generateValidateAndPublishMultiOutput,
} = require('../../../src/main-process/toolbox-background/multi-output-validator');
const {
  ROUTE_DB_CODEC_VERSION,
  decodeHeaderPayload,
  decodeRowPayload,
  decodeStylePayload,
  encodePayload,
  inspectSealedRouteDb,
  sha256FileSync
} = require('../../../src/main-process/toolbox-background/route-db-contract');
const {
  assertDirectoryDurable
} = require('../../../src/main-process/toolbox-background/route-db-sealer');
const {
  writeOutputsFromSealedRouteDb
} = require('../../../src/main-process/toolbox-background/output-writer-core');
const {
  runOutputWriter
} = require('../../../src/main-process/toolbox-background/route-scanner-core');

const tempDirs = [];
test.after(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'toolbox-route-db-'));
  tempDirs.push(dir);
  return dir;
}

function multiFilePlan(sourcePath, outputPaths) {
  return normalizeFilePlanV1({
    version: 1,
    allocation: 'eager',
    inputs: [{
      filePath: sourcePath,
      originalName: path.basename(sourcePath),
      role: 'toolbox-source',
      sourceOperation: 'toolbox:split:export'
    }],
    outputs: outputPaths.map((filePath) => ({
      filePath,
      originalName: path.basename(filePath),
      role: 'toolbox-output',
      sourceOperation: 'toolbox:split:export'
    }))
  });
}

function operationContext(operationKey) {
  return Object.freeze({
    batchId: 1,
    batchNumber: 'BATCH-E04-B',
    taskRunId: 'task-run-e04-b',
    taskKey: 'task.toolbox:e04-b',
    moduleId: 'toolbox',
    parentRunId: 'parent-run-e04-b',
    operationKey
  });
}

async function writeStyledFixture(filePath) {
  const workbook = new ExcelJS.Workbook();
  const first = workbook.addWorksheet('First');
  first.columns = [{ width: 14 }, { width: 25 }, { width: 18 }, { width: 20 }];
  first.addRow(['Group', 'LongId', 'Amount', 'When']);
  first.getRow(1).height = 24;
  first.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  first.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F4E78' } };
  first.getRow(1).alignment = { horizontal: 'center', wrapText: true };
  first.addRow(['A', '001234567890123456789', 12.34, new Date('2025-01-02T00:00:00Z')]);
  first.addRow(['B', '009999999999999999999', -5.5, new Date('2025-01-03T00:00:00Z')]);
  first.getCell('B2').numFmt = '@';
  first.getCell('B3').numFmt = '@';
  first.getCell('C2').numFmt = '#,##0.00;[Red]-#,##0.00';
  first.getCell('C3').numFmt = '#,##0.00;[Red]-#,##0.00';
  first.getCell('D2').numFmt = 'yyyy-mm-dd';
  first.getCell('D3').numFmt = 'yyyy-mm-dd';
  first.getRow(3).height = 31;
  first.getRow(3).hidden = true;
  const second = workbook.addWorksheet('Continuation');
  second.addRow(['Group', 'LongId', 'Amount', 'When']);
  second.addRow(['A', '007777777777777777777', 99.01, new Date('2025-02-01T00:00:00Z')]);
  second.getCell('B2').numFmt = '@';
  second.getCell('C2').numFmt = '#,##0.00;[Red]-#,##0.00';
  second.getCell('D2').numFmt = 'yyyy-mm-dd';
  await workbook.xlsx.writeFile(filePath);
}

function cellProjection(cell) {
  const value = cell.value instanceof Date ? cell.value.toISOString() : cell.value;
  return {
    value: value == null ? '' : value,
    numFmt: cell.numFmt,
    font: cell.font,
    fill: cell.fill,
    border: cell.border,
    alignment: cell.alignment
  };
}

async function workbookProjection(filePath) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(filePath);
  return workbook.worksheets.map((sheet) => ({
    name: sheet.name,
    columnWidths: sheet.columns.slice(0, 4).map((column) => column.width),
    rows: Array.from({ length: sheet.rowCount }, (_, rowIndex) => {
      const row = sheet.getRow(rowIndex + 1);
      return {
        height: row.height,
        hidden: row.hidden === true,
        cells: Array.from({ length: 4 }, (_unused, columnIndex) => (
          cellProjection(row.getCell(columnIndex + 1))
        ))
      };
    })
  }));
}

test('Route DB v1 codec golden 保留 row/header/style，并拒绝未知codec版本', () => {
  const style = normalizeStaticStyle({
    numFmt: '#,##0.00',
    font: { name: 'Calibri', bold: true, color: { type: 'argb', argb: 'FF112233' } },
    fill: { type: 'pattern', pattern: 'solid', fgColor: { type: 'argb', argb: 'FFFFFF00' } },
    alignment: { horizontal: 'right', wrapText: true }
  });
  const cell = createToolboxCell({
    rawLexicalValue: '-0',
    cachedValue: -0,
    cellType: 'number',
    decodedSemanticValue: -0,
    matchProjectionValue: '000123',
    effectiveStyleRef: { sourceRegistryId: 'registry-1', styleRef: 0 },
    rowIndex: 2,
    columnIndex: 1,
    sourceFormat: '#,##0.00',
    sourceFile: 'fixture.xlsx',
    sourceSheet: 'Data',
    hasFormula: true,
    formulaLexical: 'A2*-1'
  });
  const row = createToolboxRow({
    rowIndex: 2,
    cells: [cell],
    height: 22.5,
    hidden: true,
    outlineLevel: 2,
    customFormat: true,
    effectiveStyleRef: { sourceRegistryId: 'registry-1', styleRef: 0 },
    sourceFile: 'fixture.xlsx',
    sourceSheet: 'Data'
  });
  const meta = createToolboxSheetMeta({
    name: 'Data',
    sourceRegistryId: 'registry-1',
    columns: [{ minColumnIndex: 0, maxColumnIndex: 1, width: 18, hidden: true }]
  });
  const decodedRow = decodeRowPayload(encodePayload('row', row));
  assert.deepEqual(decodedRow, row);
  assert.equal(Object.is(decodedRow.cells[0].cachedValue, -0), true);
  assert.deepEqual(decodeStylePayload(encodePayload('style', style)), style);
  const header = decodeHeaderPayload(encodePayload('header', {
    normalizedHeaders: ['Group'], rawHeaderCells: [cell], headerRow: row, sheetMeta: meta
  }));
  assert.deepEqual(header.headerRow, row);
  assert.deepEqual(header.sheetMeta, meta);
  assert.equal(ROUTE_DB_CODEC_VERSION, 1);
  const unsupported = v8.serialize({ codecVersion: 2, kind: 'row', value: row });
  assert.throws(
    () => decodeRowPayload(unsupported),
    (error) => error.code === 'TOOLBOX_ROUTE_CODEC_VERSION_UNSUPPORTED'
  );
});

test('Windows目录fsync unsupported 会阻断Route DB seal，不伪造durability', () => {
  assert.throws(
    () => assertDirectoryDurable({ capability: 'unsupported', errorCode: 'EPERM' }),
    (error) => error.code === 'TOOLBOX_ROUTE_DURABILITY_UNAVAILABLE'
  );
  assert.doesNotThrow(() => assertDirectoryDurable({ capability: 'supported' }));
  assert.doesNotThrow(() => assertDirectoryDurable({ status: 'committed' }));
});

test('Scanner等待Writer exit barrier；message后非0/transport error不能冒充成功', async () => {
  function harness(controller = new AbortController()) {
    const worker = new EventEmitter();
    worker.messages = [];
    worker.postMessage = (message) => worker.messages.push(message);
    worker.terminate = async () => 1;
    const promise = runOutputWriter({}, controller.signal, {
      workerFactory() { return worker; }
    });
    return { worker, promise };
  }

  const success = harness();
  let completed = false;
  success.promise.finally(() => { completed = true; });
  success.worker.emit('message', { ok: true, result: { artifact: 'ready' } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(completed, false, 'result message不能越过child exit barrier');
  success.worker.emit('exit', 0);
  assert.deepEqual(await success.promise, { artifact: 'ready' });

  const nonZero = harness();
  nonZero.worker.emit('message', { ok: true, result: { artifact: 'not-durable' } });
  nonZero.worker.emit('exit', 9);
  await assert.rejects(
    nonZero.promise,
    (error) => error.code === 'TOOLBOX_ROUTE_WRITER_EXIT' && error.message.includes('9')
  );

  const transport = harness();
  const originalError = new Error('writer transport exploded');
  transport.worker.emit('error', originalError);
  transport.worker.emit('exit', 1);
  await assert.rejects(transport.promise, (error) => error === originalError);

  const cancelController = new AbortController();
  const cancelled = harness(cancelController);
  let cancellationSettled = false;
  cancelled.promise.catch(() => { cancellationSettled = true; });
  cancelController.abort();
  assert.deepEqual(cancelled.worker.messages, [{ operation: 'cancel' }]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(cancellationSettled, false, '取消仍需等待child exit/terminate barrier');
  cancelled.worker.emit('exit', 1);
  await assert.rejects(cancelled.promise, (error) => error.code === 'TOOLBOX_ROUTE_WRITER_EXIT');
});

test('E04-B真实Scanner→sealed Route DB→单Writer与legacy输出等价，Main join后Publisher恰好一次', async () => {
  const dir = tempDir();
  const sourcePath = path.join(dir, 'source.xlsx');
  await writeStyledFixture(sourcePath);
  const groups = [
    { outputId: 'split-1', fileName: 'A.xlsx', field: 'Group', values: ['A'] },
    { outputId: 'split-2', fileName: 'B.xlsx', field: 'Group', values: ['B'] }
  ];
  const finalPaths = [path.join(dir, 'final-A.xlsx'), path.join(dir, 'final-B.xlsx')];
  const filePlan = multiFilePlan(sourcePath, finalPaths);
  const generationPaths = [path.join(dir, 'route-A.xlsx'), path.join(dir, 'route-B.xlsx')];
  const legacyPaths = [path.join(dir, 'legacy-A.xlsx'), path.join(dir, 'legacy-B.xlsx')];
  const routeDbPath = path.join(dir, 'route.sqlite');
  const routeManifestPath = path.join(dir, 'route.sealed.json');
  const generationInput = createMultiGenerationInput({
    filePlan,
    groups,
    generationPaths,
    routeDbPath,
    routeManifestPath
  });
  const runtime = createBackgroundExecutionRuntime({ shutdownTimeoutMs: 10000 });
  const context = operationContext('toolbox-route-real');
  const workerContext = {
    taskRunId: context.taskRunId,
    taskKey: context.taskKey,
    moduleId: context.moduleId,
    parentRunId: context.parentRunId,
    operationKey: context.operationKey
  };
  const execution = await runtime.execute({
    actionKey: TOOLBOX_GENERATION_ACTIONS.SPLIT_MULTI_OUTPUT,
    operationKey: context.operationKey,
    production: false,
    context: { kind: 'operation', value: workerContext },
    input: generationInput
  });
  assert.equal(execution.outcome, 'completed');
  assert.equal(execution.terminalSource, 'job:done');
  assert.equal(validateToolboxMultiGenerationResult(execution.result), true);
  assert.deepEqual(execution.result.artifacts.map((item) => item.outputIndex), [0, 1]);
  assert.equal(JSON.stringify(execution.result).includes(dir), false);
  assert.equal(execution.result.summary.inputDataRowCount, 3);
  assert.equal(execution.result.summary.outputDataRowCount, 3);
  assert.deepEqual(execution.result.artifacts.map((item) => item.matchedCount), [2, 1]);

  for (const suffix of ['-wal', '-shm', '-journal']) {
    assert.equal(fs.existsSync(`${routeDbPath}${suffix}`), false);
  }
  const route = inspectSealedRouteDb({
    dbPath: routeDbPath,
    manifestPath: routeManifestPath,
    expectedOutputPlanHash: execution.result.routeDb.outputPlanHash
  });
  assert.equal(route.rowCount, 3);
  const routeDb = new DatabaseSync(routeDbPath, { readOnly: true });
  try {
    assert.equal(routeDb.prepare('SELECT COUNT(*) AS count FROM route_meta').get().count, 1);
  } finally {
    routeDb.close();
  }

  await exportToolboxMultiFilters({
    filePath: sourcePath,
    groups: groups.map((group, index) => ({ ...group, savePath: legacyPaths[index] }))
  });
  for (let index = 0; index < generationPaths.length; index += 1) {
    assert.deepEqual(
      await workbookProjection(generationPaths[index]),
      await workbookProjection(legacyPaths[index])
    );
  }

  let publisherCalls = 0;
  const generated = await generateValidateAndPublishMultiOutput({
    runtime: {
      async execute(request) {
        assert.equal(request.production, false);
        return execution;
      }
    },
    filePlan,
    batchContext: operationContext('toolbox-route-main-join'),
    groups,
    generationPaths,
    routeDbPath,
    routeManifestPath,
    production: false,
    publisher: async (artifacts) => {
      publisherCalls += 1;
      assert.deepEqual(artifacts.map((item) => item.outputIndex), [0, 1]);
      assert.deepEqual(artifacts.map((item) => item.outputArtifactKey), filePlan.outputs.map((item) => item.artifactKey));
      return { taskId: 'one-publisher-call' };
    }
  });
  assert.equal(generated.publication.taskId, 'one-publisher-call');
  assert.equal(publisherCalls, 1);
  assert.deepEqual(finalPaths.map((item) => fs.existsSync(item)), [false, false]);

  const reorderedExecution = structuredClone(execution);
  reorderedExecution.result.artifacts.reverse();
  let reorderedPublisherCalls = 0;
  await assert.rejects(
    generateValidateAndPublishMultiOutput({
      runtime: { async execute() { return reorderedExecution; } },
      filePlan,
      batchContext: operationContext('toolbox-route-reordered'),
      groups,
      generationPaths,
      routeDbPath,
      routeManifestPath,
      production: false,
      publisher: async () => { reorderedPublisherCalls += 1; }
    }),
    (error) => error.code === 'TOOLBOX_GENERATION_MANIFEST_INVALID'
  );
  assert.equal(reorderedPublisherCalls, 0);

  const bytes = fs.readFileSync(routeDbPath);
  bytes[Math.floor(bytes.length / 2)] ^= 1;
  fs.writeFileSync(routeDbPath, bytes);
  let failedPublisherCalls = 0;
  await assert.rejects(
    generateValidateAndPublishMultiOutput({
      runtime: { async execute() { return execution; } },
      filePlan,
      batchContext: operationContext('toolbox-route-tamper'),
      groups,
      generationPaths,
      routeDbPath,
      routeManifestPath,
      production: false,
      publisher: async () => { failedPublisherCalls += 1; }
    }),
    (error) => error.code === 'TOOLBOX_ROUTE_DB_HASH_MISMATCH'
  );
  assert.equal(failedPublisherCalls, 0);

  const shutdown = await runtime.shutdown({ timeoutMs: 10000 });
  assert.deepEqual(shutdown.leakedTransports, []);
  assert.deepEqual(shutdown.errors, []);
  fs.rmSync(dir, { recursive: true, force: true });
  assert.equal(fs.existsSync(dir), false, 'Worker/SQLite/Excel句柄应已释放，可清理task-private目录');
});

test('Main拒绝Route DB/generation与FilePlan路径别名，失败发生在runtime和Publisher之前', async () => {
  const dir = tempDir();
  const sourcePath = path.join(dir, 'source.xlsx');
  await writeStyledFixture(sourcePath);
  const finalPaths = [path.join(dir, 'final-A.xlsx'), path.join(dir, 'final-B.xlsx')];
  const filePlan = multiFilePlan(sourcePath, finalPaths);
  const groups = [
    { outputId: 'split-1', field: 'Group', values: ['A'] },
    { outputId: 'split-2', field: 'Group', values: ['B'] }
  ];
  assert.throws(() => createMultiGenerationInput({
    filePlan,
    groups,
    generationPaths: [sourcePath, path.join(dir, 'generation-B.xlsx')],
    routeDbPath: path.join(dir, 'route.sqlite'),
    routeManifestPath: path.join(dir, 'route.json')
  }), (error) => error.code === 'TOOLBOX_GENERATION_PATH_INVALID');
  assert.throws(() => createMultiGenerationInput({
    filePlan,
    groups,
    generationPaths: [path.join(dir, 'same.xlsx'), path.join(dir, 'same.xlsx')],
    routeDbPath: path.join(dir, 'route.sqlite'),
    routeManifestPath: path.join(dir, 'route.json')
  }), (error) => error.code === 'TOOLBOX_GENERATION_PATH_INVALID');
});

test('Writer独立复核sealed Route DB，非法route mask失败并清理全部generation产物', async () => {
  const dir = tempDir();
  const sourcePath = path.join(dir, 'source.xlsx');
  await writeStyledFixture(sourcePath);
  const groups = [
    { outputId: 'split-1', field: 'Group', values: ['A'] },
    { outputId: 'split-2', field: 'Group', values: ['B'] }
  ];
  const filePlan = multiFilePlan(sourcePath, [
    path.join(dir, 'final-A.xlsx'),
    path.join(dir, 'final-B.xlsx')
  ]);
  const originalPaths = [path.join(dir, 'original-A.xlsx'), path.join(dir, 'original-B.xlsx')];
  const dbPath = path.join(dir, 'route.sqlite');
  const manifestPath = path.join(dir, 'route.sealed.json');
  const originalInput = createMultiGenerationInput({
    filePlan,
    groups,
    generationPaths: originalPaths,
    routeDbPath: dbPath,
    routeManifestPath: manifestPath
  });
  const runtime = createBackgroundExecutionRuntime({ shutdownTimeoutMs: 10000 });
  const batch = operationContext('toolbox-route-writer-failure');
  const result = await runtime.execute({
    actionKey: TOOLBOX_GENERATION_ACTIONS.SPLIT_MULTI_OUTPUT,
    operationKey: batch.operationKey,
    production: false,
    context: {
      kind: 'operation',
      value: {
        taskRunId: batch.taskRunId,
        taskKey: batch.taskKey,
        moduleId: batch.moduleId,
        parentRunId: batch.parentRunId,
        operationKey: batch.operationKey
      }
    },
    input: originalInput
  });
  assert.equal(result.outcome, 'completed');

  const db = new DatabaseSync(dbPath);
  try {
    db.prepare('UPDATE route_rows SET route_mask = ? WHERE source_row_index = 0')
      .run(Buffer.from([1, 0]));
  } finally {
    db.close();
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.byteSize = fs.statSync(dbPath).size;
  manifest.sha256 = sha256FileSync(dbPath);
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`);

  const failurePaths = [path.join(dir, 'failure-A.xlsx'), path.join(dir, 'failure-B.xlsx')];
  const failureInput = createMultiGenerationInput({
    filePlan,
    groups,
    generationPaths: failurePaths,
    routeDbPath: dbPath,
    routeManifestPath: manifestPath
  });
  await assert.rejects(
    writeOutputsFromSealedRouteDb(failureInput, new AbortController().signal),
    (error) => error.code === 'TOOLBOX_ROUTE_MASK_INVALID'
  );
  assert.deepEqual(failurePaths.map((item) => fs.existsSync(item)), [false, false]);
  assert.deepEqual(
    failurePaths.map((item) => fs.existsSync(`${item}.e04a-evidence.json`)),
    [false, false]
  );
  const shutdown = await runtime.shutdown({ timeoutMs: 10000 });
  assert.deepEqual(shutdown.leakedTransports, []);
  assert.deepEqual(shutdown.errors, []);
});

test('Route DB codec在BIFF8/CSV真实Scanner与Writer路径保持行序和长编号', async () => {
  const dir = tempDir();
  const rows = [
    ['Group', 'LongId'],
    ['A', '001234567890123456789'],
    ['B', '999999999999999999999']
  ];
  const xlsPath = path.join(dir, 'source.xls');
  const xlsBook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(xlsBook, XLSX.utils.aoa_to_sheet(rows), 'Data');
  XLSX.writeFile(xlsBook, xlsPath, { bookType: 'biff8' });
  const csvPath = path.join(dir, 'source.csv');
  fs.writeFileSync(
    csvPath,
    'Group,LongId\nA,001234567890123456789\nB,999999999999999999999\n',
    'utf8'
  );
  const runtime = createBackgroundExecutionRuntime({ shutdownTimeoutMs: 10000 });
  for (const [kind, sourcePath] of [['xls', xlsPath], ['csv', csvPath]]) {
    const filePlan = multiFilePlan(sourcePath, [
      path.join(dir, `${kind}-final-A.xlsx`),
      path.join(dir, `${kind}-final-B.xlsx`)
    ]);
    const generationPaths = [
      path.join(dir, `${kind}-A.xlsx`),
      path.join(dir, `${kind}-B.xlsx`)
    ];
    const input = createMultiGenerationInput({
      filePlan,
      groups: [
        { outputId: `${kind}-a`, field: 'Group', values: ['A'] },
        { outputId: `${kind}-b`, field: 'Group', values: ['B'] }
      ],
      generationPaths,
      routeDbPath: path.join(dir, `${kind}-route.sqlite`),
      routeManifestPath: path.join(dir, `${kind}-route.sealed.json`)
    });
    const batch = operationContext(`toolbox-route-${kind}`);
    const execution = await runtime.execute({
      actionKey: TOOLBOX_GENERATION_ACTIONS.SPLIT_MULTI_OUTPUT,
      operationKey: batch.operationKey,
      production: false,
      context: {
        kind: 'operation',
        value: {
          taskRunId: `${batch.taskRunId}-${kind}`,
          taskKey: batch.taskKey,
          moduleId: batch.moduleId,
          parentRunId: batch.parentRunId,
          operationKey: batch.operationKey
        }
      },
      input
    });
    assert.equal(execution.outcome, 'completed', `${kind}: ${JSON.stringify(execution)}`);
    assert.deepEqual(execution.result.artifacts.map((item) => item.matchedCount), [1, 1]);
    const firstBook = new ExcelJS.Workbook();
    await firstBook.xlsx.readFile(generationPaths[0]);
    const secondBook = new ExcelJS.Workbook();
    await secondBook.xlsx.readFile(generationPaths[1]);
    assert.equal(firstBook.worksheets[0].getCell('B2').value, '001234567890123456789');
    assert.equal(secondBook.worksheets[0].getCell('B2').value, '999999999999999999999');
  }
  const shutdown = await runtime.shutdown({ timeoutMs: 10000 });
  assert.deepEqual(shutdown.leakedTransports, []);
  assert.deepEqual(shutdown.errors, []);
});
