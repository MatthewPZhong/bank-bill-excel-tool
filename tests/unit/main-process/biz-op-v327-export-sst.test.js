'use strict';

const { durableDirectoryTest: test } = require('../../helpers/durable-directory-tests');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const JSZip = require('jszip');
const { createExportHost, request } = require('../../helpers/biz-op-v327-export');
const { writeXlsx, opRow, flowRow } = require('../../helpers/biz-op-v327-xlsx');
const { freezeExportSource } = require('../../../src/main-process/biz-op-v327/export-inputs');
const { buildExportSource } = require('../../../src/main-process/biz-op-v327/export-source');
const { createExportSpool } = require('../../../src/main-process/biz-op-v327/export-spool');
const { writeExportWorkbook } = require('../../../src/main-process/biz-op-v327/export-writer');
const { validateExportWorkbook } = require('../../../src/main-process/biz-op-v327/export-validator');

// UTF-16 缓存超过真实 32 MiB 阈值，单元格仍在 Excel 32767 字符上限内。
const strings = { count: 600, at: (i) => String(i).padStart(6, '0') + 'x'.repeat(30000) };
async function importSources(f, kind, count = 1, large = true) {
  const files = [];
  for (let n = 0; n < count; n += 1) {
    const file = path.join(f.root, `${kind}-${n}.xlsx`); files.push(file);
    await writeXlsx(file, { kind, rowCount: large ? strings.count : 1, sharedStrings: large ? strings : [], row(i) {
      const row = kind === 'OP' ? opRow({ bu: `BU${n}` }) : flowRow({ bu: `BU${n}` });
      if (large) row[kind === 'OP' ? 15 : 18] = { t: 's', v: String(i) };
      return row;
    } });
  }
  let spillBytes = 0;
  const result = await f.run(files, { afterWorker({ taskRunId, candidateRef }) {
    spillBytes = f.module.payloadStore.readDocument(`operations/${taskRunId}/${candidateRef}.json`).value.metrics.sstSpillBytes;
  } });
  assert.equal(result.status, 'ok', JSON.stringify(result));
  if (large) assert.ok(spillBytes > 0);
  return result.receipt.outcome.datasets[0].datasetId;
}
async function sourceFor(f, outputKind, objectId) {
  return freezeExportSource({ ...f.module, getArchiveService: () => f.service, outputKind, objectId });
}
function observeSstCleanup(t, parent, prefix) {
  const original = fs.promises.rm; const removed = [];
  fs.promises.rm = async function (filename, options) {
    if (path.basename(String(filename)).startsWith(prefix)) {
      assert.equal(path.dirname(String(filename)), parent);
      assert.ok(fs.statSync(path.join(filename, 'sst.bin')).size > 0);
      removed.push(String(filename));
    }
    return original.call(this, filename, options);
  };
  t.after(() => { fs.promises.rm = original; });
  return removed;
}

for (const kind of ['OP', 'FLOW']) {
  test(`${kind}_RAW 两份真实大 SST 原件连续读取并经 Publisher 发布，缓存清理不删除候选`, async (t) => {
    const f = await createExportHost(t); const id = await importSources(f, kind, 2);
    const result = await request(f, `${kind}_RAW`, id, { afterWorker({ taskRunId, candidateRef }) {
      const directory = f.module.payloadStore.resolve(`staging/${taskRunId}/${candidateRef}`);
      assert.ok(fs.statSync(path.join(directory, 'output.xlsx')).size > 0);
      assert.equal(fs.readdirSync(directory).some((name) => name.startsWith('sst-')), false);
    } });
    assert.equal(result.status, 'ok', JSON.stringify(result));
    assert.equal(result.dataRowCount, strings.count * 2);
    assert.ok(fs.statSync(result.filePath).size > 0);
    assert.equal(f.module.catalog.task(result.taskRunId).status, 'succeeded');
    assert.equal(f.module.publication.record(result.taskRunId).cleanup_completed, 1);
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM biz_op_v327_read_pins').get().n, 0);
    assert.equal((await f.module.recovery.run()).ready, true);
  });
}

for (const mode of ['cancel', 'failure']) {
  test(`RAW 磁盘 SST 扫描期间 ${mode}，只关闭自有缓存并保留打开的 spool`, async (t) => {
    const f = await createExportHost(t); const id = await importSources(f, 'OP');
    const source = await sourceFor(f, 'OP_RAW', id);
    const directory = fs.mkdtempSync(path.join(f.root, 'raw-candidate-'));
    const filename = path.join(directory, 'export-spool.sqlite');
    const spool = createExportSpool({ filename, source }); t.after(() => spool.close());
    const removed = observeSstCleanup(t, directory, 'sst-raw-');
    const cancelToken = { cancelled: false }; let sampled = false;
    const code = mode === 'cancel' ? 'BIZOP_CANCELLED' : 'INJECTED_RAW_SCAN_FAILURE';
    await assert.rejects(buildExportSource({ payloadStore: f.module.payloadStore, source,
      spool: { ...spool, data(...args) {
        spool.data(...args); sampled = true; cancelToken.cancelled = mode === 'cancel';
        throw Object.assign(new Error(code), { code });
      } }, tempDirectory: directory, cancelToken, safePoint() {} }), { code });
    assert.equal(sampled, true); assert.equal(removed.length, 1);
    assert.equal(fs.existsSync(removed[0]), false); assert.ok(fs.existsSync(filename));
    spool.note({ record_type: 'RUN_META', value_part: '关闭后 spool 仍可写入' });
    const expected = await spool.finish(); assert.equal(expected.dataRowCount, 1);
    assert.ok(expected.noteRowCount >= 3);
    assert.equal(fs.existsSync(source.originals[0].filePath), true);
  });
}

async function addLargeSharedStrings(filePath, expected, invalid) {
  const zip = await JSZip.loadAsync(fs.readFileSync(filePath));
  const ns = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
  const relationship = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  const header = expected.pages[0].headers[0];
  zip.file('xl/sharedStrings.xml', `<sst xmlns="${ns}"><si><t>${header}</t></si>${Array.from({ length: strings.count }, (_, i) => `<si><t>${strings.at(i)}</t></si>`).join('')}</sst>`);
  const rels = await zip.file('xl/_rels/workbook.xml.rels').async('string');
  zip.file('xl/_rels/workbook.xml.rels', rels.replace('</Relationships>', `<Relationship Id="sstReview" Type="${relationship}/sharedStrings" Target="sharedStrings.xml"/></Relationships>`));
  const types = await zip.file('[Content_Types].xml').async('string');
  zip.file('[Content_Types].xml', types.replace('</Types>', '<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/></Types>'));
  const sheet = await zip.file('xl/worksheets/sheet1.xml').async('string');
  zip.file('xl/worksheets/sheet1.xml', sheet.replace(/<c\b[^>]*r="A1"[^>]*>[\s\S]*?<\/c>/,
    `<c r="A1" t="s" s="1"><v>${invalid ? 1 : 0}</v></c>`));
  fs.writeFileSync(filePath, await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
}

for (const mode of ['success', 'cancel', 'mismatch']) {
  test(`实际输出回读大 SST ${mode}，输出文件与 spool 均不属于缓存清理范围`, async (t) => {
    const f = await createExportHost(t); const id = await importSources(f, 'OP', 1, false);
    const source = await sourceFor(f, 'OP_CHECK', id);
    const directory = fs.mkdtempSync(path.join(f.root, 'actual-candidate-'));
    const filename = path.join(directory, 'export-spool.sqlite'); const filePath = path.join(directory, 'output.xlsx');
    const spool = createExportSpool({ filename, source }); t.after(() => spool.close());
    const cancelToken = { cancelled: false };
    await buildExportSource({ payloadStore: f.module.payloadStore, source, spool, tempDirectory: directory, cancelToken, safePoint() {} });
    const expected = await spool.finish();
    await writeExportWorkbook({ filePath, spool, expected, safePoint() {} });
    await addLargeSharedStrings(filePath, expected, mode === 'mismatch');
    const removed = observeSstCleanup(t, directory, 'sst-actual-');
    let observedDisk = false;
    const validate = () => validateExportWorkbook({ filePath, source, expected, tempDirectory: directory, cancelToken, safePoint() {
      const child = fs.readdirSync(directory).find((name) => name.startsWith('sst-actual-'));
      if (child) {
        observedDisk = fs.statSync(path.join(directory, child, 'sst.bin')).size > 0;
        if (mode === 'cancel') { cancelToken.cancelled = true; throw Object.assign(new Error('取消'), { code: 'BIZOP_CANCELLED' }); }
      }
    } });
    if (mode === 'success') assert.equal((await validate()).actualDigest, expected.expectedDigest);
    else await assert.rejects(validate(), { code: mode === 'cancel' ? 'BIZOP_CANCELLED' : 'BIZOP_OUTPUT_EVIDENCE_MISMATCH' });
    assert.equal(observedDisk, true); assert.equal(removed.length, 1);
    assert.equal(fs.existsSync(removed[0]), false);
    assert.ok(fs.statSync(filePath).size > 0); assert.ok(fs.statSync(filename).size > 0);
    spool.db.exec('CREATE TABLE surviving_spool(value TEXT)');
  });
}
