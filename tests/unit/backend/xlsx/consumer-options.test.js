'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const XLSX = require('xlsx');
const JSZip = require('jszip');

const MiB = 1024 * 1024;
const ROOT = path.resolve(__dirname, '../../../..');
const source = (name) => require(path.join(ROOT, 'src', name));
const helper = (name) => require(path.join(ROOT, 'tests/helpers', name));
function temporary(t, prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
function snapshot(provider) {
  return Object.fromEntries(['memoryBudgetBytes', 'lruMaxEntries', 'cacheMaxBytes', 'strictClose',
    'preserveOnClose', 'tempRoot'].map((key) => [key, provider[key]]));
}
function assertEffective(actual, expected) {
  for (const [key, value] of Object.entries(expected)) assert.equal(actual[key], value, key);
}

// 输出 Writer 使用 inlineStr；加入合法未引用 SST，观测回读的真实 adaptive 配置。
async function addUnreferencedSst(filePath) {
  const zip = await JSZip.loadAsync(fs.readFileSync(filePath));
  zip.file('xl/sharedStrings.xml', '<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><si><t>验证预算</t></si></sst>');
  const rels = await zip.file('xl/_rels/workbook.xml.rels').async('string');
  zip.file('xl/_rels/workbook.xml.rels', rels.replace('</Relationships>',
    '<Relationship Id="consumerSst" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/></Relationships>'));
  const contentTypes = await zip.file('[Content_Types].xml').async('string');
  zip.file('[Content_Types].xml', contentTypes.replace('</Types>',
    '<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/></Types>'));
  fs.writeFileSync(filePath, await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
}

// 观测生产适配器实际创建的 provider，保持真实 ZIP、SST、数据库和关闭行为。
// 同一组行为合同已在迁移前固定基线上执行；此处直接覆盖当前公共入口。
test('消费方有效预算、覆盖规则和 R3/R4 差异保持固定基线合同', async (t) => {
  const providerModule = source('backend/xlsx/shared-strings-provider');
  const load = providerModule.loadSharedStringsProvider;
  const observations = [];
  t.mock.method(providerModule, 'loadSharedStringsProvider', async function (...args) {
    const caller = new Error().stack;
    const provider = await load(...args);
    observations.push({ caller, options: args[2], provider, effective: snapshot(provider) });
    return provider;
  });
  const rich = source('backend/xlsx/rich-workbook');
  const richCalls = [];
  for (const key of ['openRichWorkbook', 'openSingleSheetRichWorkbook']) {
    const original = rich[key];
    t.mock.method(rich, key, async function (...args) {
      richCalls.push({ caller: new Error().stack, key, options: args[1] || {} });
      return original(...args);
    });
  }

  await t.test('L1 三个生产入口保留各自列宽与 maxRows，legacy 不接 adaptive', async (t) => {
    const legacy = source('backend/xlsx/legacy/streaming-xlsx-reader');
    const original = legacy.readXlsxStreamed, calls = [];
    t.mock.method(legacy, 'readXlsxStreamed', async function (...args) {
      calls.push(args[2]); return original(...args);
    });
    const root = temporary(t, 'xlsx-consumer-l1-'), filename = path.join(root, 'source.xlsx');
    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([['列A', '列B'], ['0001', '1000.00']]), '数据');
    XLSX.writeFile(book, filename, { bookSST: true });
    const before = observations.length;
    const { readMeaningfulRowsHead } = source('backend/file-service/readers');
    assert.deepEqual(await readMeaningfulRowsHead(filename, 1, { maxColCount: 2 }),
      { rows: [['列A', '列B']], truncated: true });
    assert.deepEqual(calls.at(-1), { colCount: 2, maxRows: 1 });
    const { streamLinkedRowsToInsert } = source('main-process/linked-table-stream-source');
    const rows = [];
    assert.deepEqual(await streamLinkedRowsToInsert(filename, { expectedHeaders: ['列A', '列B'] }, (row) => rows.push(row)), { matched: true });
    assert.deepEqual(rows, [{ 列A: '0001', 列B: '1000.00' }]);
    assert.deepEqual(calls.at(-1), { colCount: 2 });
    const toolbox = source('main-process/toolbox-stream-io');
    const data = [];
    assert.equal((await toolbox.streamDataRows(filename, (row) => data.push(row))).dataRowCount, 1);
    assert.deepEqual(calls.at(-1), { colCount: toolbox.TOOLBOX_MAX_COL_COUNT });
    assert.deepEqual(data[0].slice(0, 2), ['0001', '1000.00']);
    assert.deepEqual(await toolbox.readHeaderRowStreamed(filename), ['列A', '列B']);
    assert.deepEqual(calls.at(-1), { colCount: toolbox.TOOLBOX_MAX_COL_COUNT, maxRows: toolbox.TOOLBOX_HEADER_SCAN_MAX_ROWS });
    assert.equal(observations.length, before, 'legacy 消费者未创建 adaptive SST');
  });

  await t.test('L2 helper 消费者保留原解析差异，T1 仍自行装配并完整加载 SST', async (t) => {
    const before = observations.length;
    const root = temporary(t, 'xlsx-consumer-l2-'), filename = path.join(root, 'flow.xlsx');
    const { writeXlsx, flowRow } = helper('biz-op-v327-xlsx');
    await writeXlsx(filename, { rowCount: 1, row: flowRow, sharedStrings: ['原值'] });
    const vccRows = [], bizRows = [];
    const vcc = await source('backend/vcc-op-calc-import/reader').streamFlowFile(filename, { onDataRow: (row) => vccRows.push(row) });
    const biz = await source('backend/biz-op-recon-import/reader-streamed').streamFlowFile(filename, { onDataRow: (row) => bizRows.push(row) });
    assert.equal(vcc.dataRows, 1); assert.equal(vccRows.length, 1); assert.equal(bizRows.length, 1);
    assert.equal(biz.sourceSheetName, '原始数据');
    const hand = source('backend/acquiring-bill-currency-import/reader-handrolled');
    assert.equal(hand.cellValueFromBody('<v>1000.00</v>', 'n', []), '1000.00');
    assert.equal(hand.cellValueFromBody('<is><t>原值&amp;&lt;</t></is>', 'inlineStr', []), '原值&<');
    const pass = await source('backend/toolbox-format/xlsx-pass').openToolboxXlsxPass(filename, { sourceRegistryId: 'consumer-registry' });
    try {
      assert.ok(Array.isArray(pass.sharedStrings));
      assert.deepEqual(pass.sharedStrings, ['原值']);
      assert.equal(pass.sourceRegistryId, 'consumer-registry');
      const rows = []; await pass.scanSheet(0, { onRow: (row) => rows.push(row) });
      assert.equal(rows.length, 2);
    } finally { await pass.close(); }
    assert.equal(observations.length, before, 'L2/T1 未引入 adaptive 或更改原 SST 能力');
  });

  for (const [name, open, preserves] of [
    ['Position', source('backend/position-reconciliation-import/xlsx-reader').openPositionWorkbook, true],
    ['VCC S1', source('backend/vcc-financial-op/workbook-reader').openWorkbookSheets, false]
  ]) {
    await t.test(`${name} 保留 undefined 默认、Number 转换、null 拒绝及本域关闭规则`, async (t) => {
      const root = temporary(t, 'xlsx-consumer-s1-');
      const filename = path.join(root, 'source.xlsx');
      const book = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([['表头'], ['原值']]), '数据');
      XLSX.writeFile(book, filename, { bookSST: true });
      for (const options of [{}, { sstMemoryBudgetBytes: undefined, sstLruMaxEntries: undefined },
        { sstMemoryBudgetBytes: '1024', sstLruMaxEntries: '3' }]) {
        const tempRoot = path.join(root, randomUUID());
        const workbook = await open(filename, { ...options, sstTempRoot: tempRoot,
          cacheMaxBytes: 1, strictClose: true, preserveSstOnClose: true });
        try {
          assertEffective(snapshot(workbook.sharedStrings), {
            memoryBudgetBytes: options.sstMemoryBudgetBytes === '1024' ? 1024 : 64 * MiB,
            lruMaxEntries: options.sstLruMaxEntries === '3' ? 3 : 8192,
            cacheMaxBytes: undefined, strictClose: false, preserveOnClose: preserves, tempRoot
          });
          assert.equal(workbook.sharedStrings.get(0), '表头');
          assert.equal(fs.existsSync(tempRoot), false, '未落盘不创建目录');
        } finally { await workbook.close(); }
      }
      for (const options of [{ sstMemoryBudgetBytes: null }, { sstLruMaxEntries: null }]) {
        await assert.rejects(open(filename, { ...options, sstTempRoot: path.join(root, randomUUID()) }),
          (error) => /SST.*(memory budget|LRU)/.test([error.message, ...(error.detailLines || [])].join(' ')));
      }
      const tempRoot = path.join(root, 'spill');
      const workbook = await open(filename, { sstTempRoot: tempRoot, sstMemoryBudgetBytes: 1,
        sstLruMaxEntries: 2, preserveSstOnClose: true });
      assert.equal(workbook.sharedStrings.mode, 'disk');
      await workbook.close();
      assert.equal(fs.existsSync(tempRoot), preserves, '只有 Position 转发 preserveSstOnClose');
    });
  }

  await t.test('R1 BizOP import 在真实管线保留 ?? 与 undefined 的不同覆盖优先级', async (t) => {
    const { writeXlsx, flowRow } = helper('biz-op-v327-xlsx');
    const { createBizOpPayloadStore } = source('main-process/biz-op-v327/payload-store');
    const { runImportPipeline } = source('main-process/biz-op-v327/import-pipeline');
    const variants = [
      { options: {}, memory: 32 * MiB, cache: 32 * MiB, lru: 8192 },
      { options: { sstMemoryBudgetBytes: undefined, sstCacheMaxBytes: undefined, sstLruMaxEntries: undefined }, memory: 32 * MiB, cache: 32 * MiB, lru: 8192 },
      { options: { sstMemoryBudgetBytes: null, sstCacheMaxBytes: null }, memory: 32 * MiB, cache: 32 * MiB, lru: 8192 },
      { options: { sstMemoryBudgetBytes: '512', sstCacheMaxBytes: 300, sstLruMaxEntries: '2' }, memory: 512, cache: 300, lru: 2 },
      { options: { sstLruMaxEntries: null }, reject: true },
      { options: { sstCacheMaxBytes: '300' }, reject: true }
    ];
    for (const variant of variants) {
      const root = temporary(t, 'xlsx-consumer-r1-');
      const filePath = path.join(root, 'flow.xlsx');
      await writeXlsx(filePath, { rowCount: 1, row: flowRow, sharedStrings: ['原值'] });
      const payloadStore = createBizOpPayloadStore({ userDataDir: root }); payloadStore.initialize();
      const taskRunId = `task-${randomUUID()}`, candidateRef = `candidate-${randomUUID()}`;
      const before = observations.length;
      const cancelToken = { cancelled: false };
      const output = await runImportPipeline({ payloadStore, taskRunId, candidateRef,
        reportRef: `report-${randomUUID()}`, intentDigest: 'f'.repeat(64), cancelToken,
        files: [{ filePath, artifactId: 1, order: 0, sha256: createHash('sha256').update(fs.readFileSync(filePath)).digest('hex') }],
        options: variant.options });
      const result = payloadStore.readDocument(`operations/${taskRunId}/${candidateRef}.json`, output.sha256).value;
      assert.equal(result.batchRejected, !!variant.reject);
      if (variant.reject) { assert.equal(result.fileErrorCount, 1); continue; }
      assert.equal(result.acceptedRows, 1);
      assert.equal(observations.length, before + 1);
      const observed = observations.at(-1);
      assertEffective(observed.effective, { memoryBudgetBytes: variant.memory, cacheMaxBytes: variant.cache,
        lruMaxEntries: variant.lru, strictClose: true, preserveOnClose: false });
      assert.equal(observed.options.cancelToken, cancelToken);
      assert.match(observed.effective.tempRoot, new RegExp(`${candidateRef}/sst-0$`));
      assert.equal(observed.provider.closed, true);
    }
  });

  await t.test('R2 BizOP RAW 单页读取和输出多页验证各自保持 32 MiB 与私有临时根', async (t) => {
    const { createExportHost } = helper('biz-op-v327-export');
    const { writeXlsx, opRow } = helper('biz-op-v327-xlsx');
    const { freezeExportSource } = source('main-process/biz-op-v327/export-inputs');
    const { buildExportSource } = source('main-process/biz-op-v327/export-source');
    const { createExportSpool } = source('main-process/biz-op-v327/export-spool');
    const { writeExportWorkbook } = source('main-process/biz-op-v327/export-writer');
    const { validateExportWorkbook } = source('main-process/biz-op-v327/export-validator');
    const f = await createExportHost(t), file = path.join(f.root, 'raw.xlsx');
    await writeXlsx(file, { kind: 'OP', rowCount: 1, row: opRow, sharedStrings: ['保留原值'] });
    const imported = await f.run([file]);
    assert.equal(imported.status, 'ok', JSON.stringify(imported));
    const frozen = await freezeExportSource({ ...f.module, getArchiveService: () => f.service,
      outputKind: 'OP_RAW', objectId: imported.receipt.outcome.datasets[0].datasetId });
    const tempDirectory = fs.mkdtempSync(path.join(f.root, 'consumer-export-'));
    const spool = createExportSpool({ filename: path.join(tempDirectory, 'spool.sqlite'), source: frozen });
    const cancelToken = { cancelled: false };
    try {
      const before = observations.length;
      await buildExportSource({ payloadStore: f.module.payloadStore, source: frozen, spool, tempDirectory, cancelToken, safePoint() {} });
      const expected = await spool.finish();
      const filePath = path.join(tempDirectory, 'output.xlsx');
      await writeExportWorkbook({ filePath, spool, expected, safePoint() {} });
      await addUnreferencedSst(filePath);
      const checked = await validateExportWorkbook({ filePath, source: frozen, expected, tempDirectory, cancelToken });
      assert.equal(checked.dataRowCount, 1);
      const captures = observations.slice(before);
      assert.equal(captures.length, 2);
      for (const [index, entry] of captures.entries()) {
        assertEffective(entry.effective, { memoryBudgetBytes: 32 * MiB, lruMaxEntries: 8192,
          cacheMaxBytes: 32 * MiB, strictClose: true, preserveOnClose: false });
        assert.equal(path.dirname(entry.effective.tempRoot), tempDirectory);
        assert.match(path.basename(entry.effective.tempRoot), index ? /^sst-actual-/ : /^sst-raw-/);
        assert.equal(entry.options.cancelToken, cancelToken);
        assert.equal(entry.provider.closed, true);
      }
      const raw = richCalls.findLast((entry) => entry.caller.includes('/biz-op-v327/export-source.js'));
      const actual = richCalls.findLast((entry) => entry.caller.includes('/biz-op-v327/export-validator.js'));
      assert.equal(raw.key, 'openSingleSheetRichWorkbook');
      assert.equal(actual.key, 'openRichWorkbook');
      assert.equal(actual.options.maxSheets, expected.pages.length);
    } finally { spool.close(); }
  });

  await t.test('R3 和 R4 四处 VCC 真实导入、原件导出、待确认导出保留不同 cache 和取消桥接', async (t) => {
    const before = observations.length, callBefore = richCalls.length;
    const { createReviewFixture, T, CURRENCIES } = helper('vcc-review-export');
    const f = await createReviewFixture(t, { subjects: ['甲'], writeOptions: { bookSST: true } });
    const { writeDatasetWorkbook, EXPORT_KINDS } = source('main-process/vcc-financial-op-dataset-writer');
    const archiveSources = f.db.prepare('SELECT id AS sourceId, source_sha256 AS sha256, source_size_bytes AS sizeBytes FROM vcc_fin_op_import_sources').all()
      .map((entry) => ({ ...entry, filePath: path.join(f.archiveRoot, 'blobs', entry.sha256), fileName: path.basename(f.filePath) }));
    const raw = await writeDatasetWorkbook({ db: f.db, targetMonth: '2026-06', sourceType: T.SYSTEM_OP,
      targetKind: EXPORT_KINDS.RAW, outputPath: path.join(f.dir, 'system.xlsx'), archiveSources });
    assert.equal(raw.dataCount, CURRENCIES.length);
    const { prepareReviewManifest, extractReviewSources } = source('backend/vcc-financial-op/review-export-plan');
    const { writeReviewWorkbook } = source('main-process/vcc-financial-op-review-writer');
    const { validateReviewWorkbook } = source('main-process/vcc-financial-op-review-validator');
    const controller = new AbortController();
    const options = { ...f, appVersion: '3.2.9', manifestPath: path.join(f.dir, 'manifest.sqlite'),
      filePath: path.join(f.dir, 'review.xlsx'), signal: controller.signal };
    await prepareReviewManifest(options); await extractReviewSources(options);
    await writeReviewWorkbook(options);
    await addUnreferencedSst(options.filePath);
    const result = await validateReviewWorkbook(options);
    assert.ok(result.sheetCount > 1);
    for (const consumer of ['workbook-import-plan.js', 'system-op-importer.js',
      'vcc-financial-op-dataset-writer.js', 'vcc-financial-op-review-validator.js', 'review-export-plan.js']) {
      const calls = richCalls.slice(callBefore).filter((entry) => entry.caller.includes(consumer));
      assert.ok(calls.length > 0, `${consumer} 真实路径已调用`);
      const isReview = consumer === 'review-export-plan.js';
      for (const call of calls) {
        assert.equal(Object.hasOwn(call.options, 'cacheMaxBytes'), isReview, `${consumer} cache 显式性`);
        assert.equal(call.options.cacheMaxBytes, isReview ? 64 * MiB : undefined);
        assert.equal(Object.hasOwn(call.options, 'cancelToken'), consumer !== 'vcc-financial-op-dataset-writer.js');
      }
      const entries = observations.slice(before).filter((entry) => entry.caller.includes(consumer));
      assert.ok(entries.length > 0);
      for (const entry of entries) {
        assertEffective(entry.effective, { memoryBudgetBytes: 64 * MiB, lruMaxEntries: 8192,
          cacheMaxBytes: isReview ? 64 * MiB : undefined, strictClose: true, preserveOnClose: false });
        assert.match(path.basename(entry.effective.tempRoot), /^rich-xlsx-sst-/);
        assert.equal(path.dirname(entry.effective.tempRoot), os.tmpdir());
        assert.equal(entry.provider.closed, true);
      }
    }
    controller.abort();
    for (const consumer of ['review-export-plan.js', 'vcc-financial-op-review-validator.js']) {
      const call = richCalls.slice(callBefore).find((entry) => entry.caller.includes(consumer));
      assert.equal(call.options.cancelToken.cancelled, true, `${consumer} 保留实时 signal 桥接`);
    }
  });
});
