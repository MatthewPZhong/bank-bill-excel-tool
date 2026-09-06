'use strict';
const test = require('node:test');
const { durableDirectoryTest } = require('../../helpers/durable-directory-tests');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { randomUUID, createHash } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { writeXlsx, flowRow, opRow } = require('../../helpers/biz-op-v327-xlsx');
const { createBizOpPayloadStore, readVerifiedManifest } = require('../../../src/main-process/biz-op-v327/payload-store');
const { runImportPipeline } = require('../../../src/main-process/biz-op-v327/import-pipeline');
const { accountText, dateText } = require('../../../src/main-process/biz-op-v327/import-adapter');
const { openSingleSheetRichWorkbook } = require('../../../src/backend/xlsx-rich-reader');
const { AdaptiveSharedStringsProvider } = require('../../../src/backend/position-reconciliation-import/shared-strings-provider');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bizop-import-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = createBizOpPayloadStore({ userDataDir: root }); store.initialize();
  return { root, store, taskRunId: `task-${randomUUID()}`, candidateRef: `candidate-${randomUUID()}`, reportRef: `report-${randomUUID()}`, intentDigest: 'f'.repeat(64) };
}
async function run(f, definitions, options) {
  const files = [];
  for (let i = 0; i < definitions.length; i += 1) {
    const filePath = path.join(f.root, `source-${i}.xlsx`);
    await writeXlsx(filePath, definitions[i]);
    files.push({ filePath, artifactId: i + 1, order: i, sha256: createHash('sha256').update(fs.readFileSync(filePath)).digest('hex') });
  }
  const output = await runImportPipeline({ ...f, payloadStore: f.store, files, options });
  const result = f.store.readDocument(`operations/${f.taskRunId}/${f.candidateRef}.json`, output.sha256).value;
  return { output, result };
}

for (const stage of ['DATASET', 'DIAGNOSTIC', 'CLEANUP']) durableDirectoryTest(`最后 ${stage} 封存/清理期间取消，最终文档独立标记拒绝并保留诊断`, async (t) => {
  const f = fixture(t); const cancelToken = { cancelled: false }; let injected = false;
  const filePath = path.join(f.root, 'late-cancel.xlsx');
  await writeXlsx(filePath, { rowCount: 1, row: () => flowRow() });
  const wrapped = { ...f.store, async sealCandidate(options) {
    const value = await f.store.sealCandidate(options);
    if (options.objectKind === stage) { injected = true; cancelToken.cancelled = true; }
    return value;
  } };
  const remove = fs.promises.rmdir;
  fs.promises.rmdir = async function (...args) {
    const result = await remove.apply(this, args);
    if (stage === 'CLEANUP') { injected = true; cancelToken.cancelled = true; }
    return result;
  };
  let output;
  try { output = await runImportPipeline({ ...f, payloadStore: wrapped, cancelToken,
    files: [{ filePath, artifactId: 1, order: 0, sha256: createHash('sha256').update(fs.readFileSync(filePath)).digest('hex') }] });
  } finally { fs.promises.rmdir = remove; }
  const result = f.store.readDocument(`operations/${f.taskRunId}/${f.candidateRef}.json`, output.sha256).value;
  assert.equal(injected, true); assert.equal(result.cancelled, true); assert.equal(result.batchRejected, true);
  assert.equal(result.acceptedRows, 1);
  const report = await f.store.verifyManifest(`diagnostics/${f.reportRef}/manifest.json`, result.reportManifestDigest);
  assert.equal(readVerifiedManifest(report).catalog.scanComplete, result.scanComplete);
  assert.equal(readVerifiedManifest(report).catalog.collectedSamples, result.collectedSamples);
});
durableDirectoryTest('真实富类型 reader → adapter → 单连接 router → 公共 writer 处理 8205 行及 OP/FLOW 混批', async (t) => {
  const f = fixture(t);
  const { output, result } = await run(f, [
    { kind: 'OP', rowCount: 2, row: () => opRow({ account: { t: 'n', v: '123', s: 1 } }) },
    { rowCount: 8205, row: (i) => flowRow({ date: i < 4100 ? '2026-09-02' : '2026-09-03', number: String(i),
      account: { t: 's', v: '0' }, amount: { t: 'n', v: '1234567890123456789.123456789' } }), sharedStrings: ['000123'] }
  ]);
  assert.equal(result.batchRejected, false, JSON.stringify(result));
  assert.equal(result.acceptedRows, 8207); assert.equal(result.references.length, 3);
  assert.equal(result.metrics.router.peakActiveConnections, 1);
  assert.ok(result.metrics.router.committedTransactions >= 5);
  assert.equal(Buffer.byteLength(JSON.stringify(output)) < 1024, true);
  for (const reference of result.references) {
    const token = await f.store.verifyManifest(`inputs/${reference.objectId}/manifest.json`, reference.digest);
    const manifest = readVerifiedManifest(token);
    const db = new DatabaseSync(f.store.resolve(`inputs/${reference.objectId}/${manifest.parts[0].name}`), { readOnly: true });
    try {
      const table = manifest.catalog.kind === 'OP' ? 'op_check_rows' : 'flow_check_rows';
      const first = db.prepare(`SELECT * FROM ${table} ORDER BY row_ordinal LIMIT 1`).get();
      assert.equal(first.account_no, '000123'); assert.equal(first.key_bu, 'alpha'); assert.equal(first.key_currency, 'USD');
      if (manifest.catalog.kind === 'FLOW') assert.equal(first.recon_amount, '1234567890123456789.123456789');
      assert.equal(first.source_sheet, '原始数据'); assert.ok(first.source_row >= 2);
    } finally { db.close(); }
  }
});
test('隐藏第二页在坏 SST 之前拒绝，reader 关闭真实 ZIP', async (t) => {
  const f = fixture(t); const file = path.join(f.root, 'hidden.xlsx');
  await writeXlsx(file, { rowCount: 1, row: flowRow, secondSheet: true, brokenSst: true });
  await assert.rejects(openSingleSheetRichWorkbook(file, { sstTempRoot: path.join(f.root, 'sst') }), /恰好声明一个/);
  assert.equal(fs.existsSync(path.join(f.root, 'sst')), false);
});
durableDirectoryTest('后文件第 28 列公式整批拒绝；5 个坏行仅采 2 个仍完整计数', async (t) => {
  const f = fixture(t);
  const { result } = await run(f, [{ kind: 'OP', rowCount: 1, row: () => opRow() },
    { rowCount: 7, row(i) { const row = flowRow(); if (i < 5) row[27] = { t: 'n', v: '1', f: '1+0' }; return row; } }], { maxSamples: 2 });
  assert.equal(result.batchRejected, true); assert.equal(result.rowErrorCount, 5);
  assert.equal(result.acceptedRows, 3); assert.equal(result.collectedSamples, 2);
  assert.equal(result.scanComplete, true); assert.equal(result.errorCountExact, true);
  assert.equal(result.errorSamplesTruncated, true); assert.deepEqual(result.references, []);
  assert.deepEqual(fs.readdirSync(f.store.resolve('inputs')), []);
});
durableDirectoryTest('发现坏行后 XML 损坏标为至少 N，不把样本未截断当完整总数', async (t) => {
  const f = fixture(t);
  const { result } = await run(f, [{ rowCount: 2, brokenTail: true,
    row: (i) => flowRow({ direction: i ? '入' : '错误' }) }]);
  assert.equal(result.rowErrorCount, 1); assert.equal(result.scanComplete, false);
  assert.equal(result.errorCountExact, false); assert.equal(result.errorSamplesTruncated, false);
  assert.equal(result.fileErrorCount, 1); assert.equal(result.batchRejected, true);
});
durableDirectoryTest('OP 23 列尾部错误与文件内多 BU/多日期拒绝；等于 0.01 的边界精确通过', async (t) => {
  const f = fixture(t);
  const { result } = await run(f, [{ kind: 'OP', rowCount: 4, row(i) {
    if (i === 0) return opRow({ amount: '10.01', end: '110.01' });
    if (i === 1) return opRow({ bu: 'Beta' });
    if (i === 2) return opRow({ date: '2026-09-02' });
    const row = opRow(); row[22] = { t: 'e', v: '#VALUE!' }; return row;
  } }]);
  assert.equal(result.acceptedRows, 1); assert.equal(result.rowErrorCount, 3); assert.equal(result.scanComplete, true);
});
test('E01 数值身份与 E02 日期系统不使用本机时区或丢失前导零', () => {
  const number = (raw, format = 'General') => ({ cellType: 'number', rawLexicalValue: raw, sourceFormat: format });
  assert.equal(accountText(number('123', '000000')), '000123');
  assert.equal(accountText({ cellType: 'text', decodedSemanticValue: ' 00012345678901234567890 ' }), '00012345678901234567890');
  for (const raw of ['-1', '1.2', '1234567890123456']) assert.throws(() => accountText(number(raw)));
  assert.throws(() => accountText(number('123', '0.00')));
  assert.equal(dateText({ ...number('1', 'yyyy-mm-dd'), sourceDateSystem: 1900 }), '1900-01-01');
  assert.equal(dateText({ ...number('0.5', 'yyyy-mm-dd'), sourceDateSystem: 1904 }), '1904-01-01');
  assert.throws(() => dateText({ ...number('60', 'yyyy-mm-dd'), sourceDateSystem: 1900 }));
  assert.throws(() => dateText({ ...number('46242'), sourceDateSystem: 1900 }));
  assert.equal(dateText({ cellType: 'text', decodedSemanticValue: '20260808' }), '2026-08-08');
  for (const token of ['09/06/2026', '2026-02-30', '2026-09-06T00:00:00Z', '2026-09-06T00:00:00+08:00']) {
    assert.throws(() => dateText({ cellType: 'text', decodedSemanticValue: token }));
  }
  assert.equal(dateText({ cellType: 'date', rawLexicalValue: '2026-09-06T23:12:00', decodedSemanticValue: {} }), '2026-09-06');
});

durableDirectoryTest('真实 XLSX 日期序号须具备日期格式，1900/1904 与八位日期文本均按批准 E02 解析', async (t) => {
  const accepted = fixture(t);
  const good = await run(accepted, [
    { rowCount: 1, row: () => flowRow({ date: { t: 'n', v: '46242', s: 2 } }) },
    { date1904: true, rowCount: 1, row: () => flowRow({ date: { t: 'n', v: '44780.5', s: 2 } }) },
    { rowCount: 1, row: () => flowRow({ date: '20260808' }) }
  ]);
  assert.equal(good.result.batchRejected, false, JSON.stringify(good.result));
  assert.equal(good.result.acceptedRows, 3); assert.equal(good.result.references.length, 1);
  const manifest = readVerifiedManifest(await accepted.store.verifyManifest(`inputs/${good.result.references[0].objectId}/manifest.json`, good.result.references[0].digest));
  assert.equal(manifest.catalog.dataDate, '2026-08-08');
  const rejected = fixture(t);
  const bad = await run(rejected, [{ rowCount: 3, row: (i) => flowRow({ date: i === 0 ? { t: 'n', v: '46242' }
    : i === 1 ? '20260230' : { t: 'n', v: '60', s: 2 } }) }]);
  assert.equal(bad.result.batchRejected, true); assert.equal(bad.result.rowErrorCount, 3);
  assert.equal(bad.result.references.length, 0);
});
test('SST 中文/emoji 字节与条目双限、超大单条不缓存、命中不重复收费，旧默认保持', async (t) => {
  const f = fixture(t);
  const provider = new AdaptiveSharedStringsProvider({ tempRoot: path.join(f.root, 'sst'), memoryBudgetBytes: 100,
    cacheMaxBytes: 200, lruMaxEntries: 2, strictClose: true });
  for (const value of ['中😀'.repeat(100), 'a'.repeat(30), 'b'.repeat(30), 'c'.repeat(30)]) provider.append(value);
  assert.equal(provider.mode, 'disk'); assert.equal(provider.estimatedMemoryBytes, 0);
  assert.equal(provider.get(0), '中😀'.repeat(100)); assert.equal(provider.cacheBytes, 0);
  provider.get(1); const bytes = provider.cacheBytes; provider.get(1); assert.equal(provider.cacheBytes, bytes);
  provider.get(2); provider.get(3); assert.ok(provider.cacheBytes <= 200); assert.ok(provider.cache.size <= 2);
  assert.ok(provider.peakCacheBytes <= 200); await provider.close(); assert.equal(provider.cacheBytes, 0);
  assert.equal(fs.existsSync(path.join(f.root, 'sst')), false);
  const legacy = new AdaptiveSharedStringsProvider({ tempRoot: path.join(f.root, 'old'), memoryBudgetBytes: 1, lruMaxEntries: 2 });
  legacy.append('中'.repeat(1000)); legacy.get(0); assert.equal(legacy.cache.size, 1); assert.equal(legacy.cacheMaxBytes, undefined);
  await legacy.close();
});

durableDirectoryTest('交错日期切换真实关闭连接，跨 16 个小分片保持原始行定位和金额词元', async (t) => {
  const f = fixture(t);
  const { result } = await run(f, [{ rowCount: 100, row: (i) => flowRow({
    date: i % 2 ? '2026-09-03' : '2026-09-02', number: { t: 'n', v: '12345678901234567890' } }) }],
  { partTargetRows: 7 });
  assert.equal(result.batchRejected, false, JSON.stringify(result));
  assert.equal(result.metrics.router.parts, 16); assert.equal(result.metrics.router.openedConnections, 100);
  assert.equal(result.metrics.router.peakActiveConnections, 1); assert.equal(result.metrics.router.committedTransactions, 100);
  const sourceRows = [];
  for (const reference of result.references) {
    const manifest = readVerifiedManifest(await f.store.verifyManifest(`inputs/${reference.objectId}/manifest.json`, reference.digest));
    assert.equal(manifest.rowCount, 50);
    for (const part of manifest.parts) {
      const db = new DatabaseSync(f.store.resolve(`inputs/${reference.objectId}/${part.name}`), { readOnly: true });
      try {
        for (const row of db.prepare('SELECT source_row,flow_no FROM flow_check_rows ORDER BY row_ordinal').iterate()) {
          sourceRows.push(row.source_row); assert.equal(row.flow_no, '12345678901234567890');
        }
      } finally { db.close(); }
    }
  }
  assert.deepEqual(sourceRows.sort((a, b) => a - b), Array.from({ length: 100 }, (_, i) => i + 2));
  assert.equal(fs.existsSync(f.store.resolve(`staging/${f.taskRunId}`, { mustExist: false })), false);
});

test('SST 双限模式随机读取和索引截断拒绝，关闭错误保留文件且重复 close 不伪报成功', async (t) => {
  const f = fixture(t);
  const provider = new AdaptiveSharedStringsProvider({ tempRoot: path.join(f.root, 'random-sst'), memoryBudgetBytes: 1,
    cacheMaxBytes: 500, lruMaxEntries: 3, strictClose: true });
  for (let i = 0; i < 50; i += 1) provider.append(`值-${i}-` + '中😀'.repeat(10));
  for (let i = 0; i < 150; i += 1) {
    const index = (i * 37) % 50;
    assert.equal(provider.get(index), `值-${index}-` + '中😀'.repeat(10)); assert.ok(provider.cacheBytes <= 500);
  }
  fs.ftruncateSync(provider.idxFd, 12);
  assert.throws(() => provider.get(40), /截断/);
  const closeSync = fs.closeSync; const binFd = provider.binFd;
  t.mock.method(fs, 'closeSync', (fd) => {
    closeSync(fd);
    if (fd === binFd) throw Object.assign(new Error('关闭反馈丢失'), { code: 'EIO' });
  });
  await assert.rejects(provider.close(), /关闭未确认/);
  await assert.rejects(provider.close(), /关闭未确认/);
  assert.equal(fs.existsSync(provider.tempRoot), true);
});

durableDirectoryTest('候选 COMMIT 反馈丢失保留原始不确定错误，关闭不再用状态错误覆盖它', async (t) => {
  const f = fixture(t);
  const exec = DatabaseSync.prototype.exec;
  let interrupted = false;
  t.mock.method(DatabaseSync.prototype, 'exec', function (sql) {
    const result = exec.call(this, sql);
    if (sql === 'COMMIT' && !interrupted) { interrupted = true; throw new Error('提交反馈丢失'); }
    return result;
  });
  const { result } = await run(f, [{ rowCount: 10, row: () => flowRow() }], { writerOptions: { maxRowsPerTransaction: 2 } });
  assert.equal(interrupted, true); assert.equal(result.batchRejected, true); assert.equal(result.scanComplete, false);
  const samples = fs.readFileSync(f.store.resolve(`diagnostics/${f.reportRef}/part-000001.jsonl`), 'utf8')
    .trim().split('\n').map((line) => JSON.parse(line));
  assert.ok(samples.some((sample) => sample.code === 'CANDIDATE_WRITER_COMMIT_UNCERTAIN'));
  assert.deepEqual(fs.readdirSync(f.store.resolve('inputs')), []);
});
