'use strict';

const { durableDirectoryTest: test } = require('../../helpers/durable-directory-tests');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const JSZip = require('jszip');
const { randomUUID } = require('node:crypto');
const XLSX = require('xlsx');
const { createHost } = require('../../helpers/biz-op-v327-host');
const { seed, compute, readResult } = require('../../helpers/biz-op-v327-compute');
const { freezeExportSource } = require('../../../src/main-process/biz-op-v327/export-inputs');
const { runExportPipeline } = require('../../../src/main-process/biz-op-v327/export-pipeline');
const { createExportSpool } = require('../../../src/main-process/biz-op-v327/export-spool');
const { writeExportWorkbook } = require('../../../src/main-process/biz-op-v327/export-writer');
const { validateExportWorkbook } = require('../../../src/main-process/biz-op-v327/export-validator');
const { NULL_CELL, text, number, sheetName, outputName } = require('../../../src/main-process/biz-op-v327/export-cells');

async function sourceFor(f, outputKind, objectId) {
  return freezeExportSource({ ...f.module, getArchiveService: () => f.service, outputKind, objectId });
}
async function exported(f, source, options = {}) {
  const taskRunId = randomUUID(); const candidateRef = `candidate-${randomUUID()}`;
  const result = await runExportPipeline({ payloadStore: f.module.payloadStore, source, taskRunId, candidateRef,
    intentDigest: '1'.repeat(64), ...options });
  const evidence = f.module.payloadStore.readDocument(`operations/${taskRunId}/${candidateRef}.json`, result.sha256).value;
  const filePath = f.module.payloadStore.resolve(`staging/${taskRunId}/${candidateRef}/output.xlsx`);
  return { evidence, filePath, workbook: XLSX.readFile(filePath, { cellStyles: true }) };
}
test('六类真实固定输入的 expected→writer→独立 actual：完整列、说明及分页', async (t) => {
  const f = await createHost(t); await seed(f, { end: '120', count: 3 });
  const run = await compute(f); assert.equal(run.status, 'ok');
  for (const [kind, width] of [['OP_RAW', 23], ['FLOW_RAW', 28], ['OP_CHECK', 12], ['FLOW_CHECK', 9], ['RESULT_FULL', 19], ['RESULT_DIFF', 19]]) {
    const objectId = kind.startsWith('RESULT') ? run.runId : f.db.prepare('SELECT dataset_id FROM biz_op_v327_datasets WHERE kind=? ORDER BY data_date LIMIT 1')
      .get(kind.split('_')[0]).dataset_id;
    const source = await sourceFor(f, kind, objectId);
    const result = await exported(f, source, { options: { maxRowsPerSheet: 2 } });
    assert.equal(result.evidence.expectedDigest, result.evidence.actualDigest, kind);
    const first = result.workbook.Sheets[result.workbook.SheetNames[0]];
    assert.equal(XLSX.utils.sheet_to_json(first, { header: 1 })[0].length, width, kind);
    assert.equal(result.workbook.SheetNames.some((name) => name.startsWith('核对说明')), kind !== 'RESULT_DIFF', kind);
    assert.ok(result.evidence.metrics.peakBufferedBytes < 1024 * 1024, kind);
  }
});
test('零差异只保留一张 19 列表头页；损坏明确 schema 在写出前拒绝', async (t) => {
  const f = await createHost(t); await seed(f); const run = await compute(f);
  const source = await sourceFor(f, 'RESULT_DIFF', run.runId);
  const result = await exported(f, source);
  assert.equal(result.evidence.dataRowCount, 0);
  assert.equal(result.workbook.SheetNames[0], '20260901_v1 VS 20260903_v1');
  assert.equal(XLSX.utils.sheet_to_json(result.workbook.Sheets[result.workbook.SheetNames[0]], { header: 1 }).length, 1);
  assert.equal(result.evidence.noteRowCount, 0);
  assert.equal(result.workbook.SheetNames.length, 1);
  assert.equal(result.evidence.identity.evidenceSchemaRevision, 3);
  assert.equal(result.evidence.identity.notesSchemaVersion, null);
  await assert.rejects(sourceFor(f, 'GUESS_FROM_FILENAME', run.runId), { code: 'BIZOP_OUTPUT_SCHEMA_UNKNOWN' });
});

test('差异文件不附说明页，19 列异常摘要指向完整原表，封存说明不被修改', async (t) => {
  const f = await createHost(t); await seed(f, { end: '120', count: 3 }); const run = await compute(f);
  const before = readResult(f, run.runId);
  const diff = await exported(f, await sourceFor(f, 'RESULT_DIFF', run.runId));
  const full = await exported(f, await sourceFor(f, 'RESULT_FULL', run.runId));
  const cells = (book) => XLSX.utils.sheet_to_json(book.Sheets[book.SheetNames[0]], { header: 1, defval: null })[1];
  assert.equal(diff.workbook.SheetNames.length, 1);
  assert.equal(diff.evidence.noteRowCount, 0);
  assert.deepEqual(cells(diff.workbook).slice(0, 18), cells(full.workbook).slice(0, 18));
  assert.equal(cells(diff.workbook)[18], cells(full.workbook)[18].replace('；详见核对说明:', '；完整说明见导出原表，定位:'));
  assert.ok(full.workbook.SheetNames.includes('核对说明'));
  assert.ok(full.evidence.noteRowCount > 0);
  assert.deepEqual(readResult(f, run.runId), before);
});

function column(index) { let name = ''; for (let n = index; n > 0; n = Math.floor((n - 1) / 26)) name = String.fromCharCode(65 + (n - 1) % 26) + name; return name; }
function replaceCell(xml, reference, content) {
  const pattern = new RegExp(`<c\\b[^>]*\\br="${reference}"[^>]*(?:\\/>|>[\\s\\S]*?<\\/c>)`);
  if (pattern.test(xml)) return xml.replace(pattern, content);
  return xml.replace(/(<row\b[^>]*r="2"[^>]*>)/, `$1${content}`);
}
const corruptionRejected = (error) => /^BIZOP_OUTPUT_|^RICH_XLSX_/.test(error.code || '') || error.name === 'ToolboxXlsxFormatError';
test('六类分别注入首尾列、列外空格、缺行、缺账号、空变零、去前导零、金额反号、表头、页和说明损坏均拒绝', async (t) => {
  const f = await createHost(t); await seed(f, { end: '120', count: 3 }); const run = await compute(f);
  let rejected = 0;
  for (const [kind, width, account, money] of [['OP_RAW', 23, 'E', 'H'], ['FLOW_RAW', 28, 'L', 'N'], ['OP_CHECK', 12, 'E', 'H'],
    ['FLOW_CHECK', 9, 'D', 'H'], ['RESULT_FULL', 19, 'D', 'H'], ['RESULT_DIFF', 19, 'D', 'H']]) {
    const objectId = kind.startsWith('RESULT') ? run.runId : f.db.prepare('SELECT dataset_id FROM biz_op_v327_datasets WHERE kind=? ORDER BY data_date LIMIT 1')
      .get(kind.split('_')[0]).dataset_id;
    const source = await sourceFor(f, kind, objectId);
    const changes = [
      ['首列', (xml) => replaceCell(xml, 'A2', '<c r="A2" t="str"><v>改动</v></c>')],
      ['末列', (xml) => replaceCell(xml, `${column(width)}2`, `<c r="${column(width)}2" t="str"><v>尾列被修改</v></c>`)],
      ['N+1显式空c', (xml) => xml.replace('</row>', `<c r="${column(width + 1)}1"/></row>`)],
      ['删除最后行', (xml) => xml.replace([...xml.matchAll(/<row\b[^>]*>[\s\S]*?<\/row>/g)].at(-1)[0], '')],
      ['缺账号', (xml) => replaceCell(xml, `${account}2`, '')],
      ['空变零', (xml) => replaceCell(xml, `${column(width)}2`, `<c r="${column(width)}2"><v>0</v></c>`)],
      ['账号去零', (xml) => replaceCell(xml, `${account}2`, `<c r="${account}2" t="str"><v>123</v></c>`)],
      ['金额反号', (xml) => replaceCell(xml, `${money}2`, `<c r="${money}2"><v>-999</v></c>`)],
      ['错表头', (xml) => replaceCell(xml, 'A1', '<c r="A1" t="str"><v>错表头</v></c>')],
      ['样式变化', (xml) => xml.replace('s="1"', 's="0"')]
    ];
    for (const [label, mutate] of changes) {
      await assert.rejects(exported(f, source, { afterWrite: async (filePath) => {
        const zip = await JSZip.loadAsync(fs.readFileSync(filePath));
        const xml = await zip.file('xl/worksheets/sheet1.xml').async('string');
        const changed = mutate(xml); assert.notEqual(changed, xml, `${kind}/${label}`);
        zip.file('xl/worksheets/sheet1.xml', changed); fs.writeFileSync(filePath, await zip.generateAsync({ type: 'nodebuffer' }));
      } }), corruptionRejected, `${kind}/${label}`); rejected += 1;
    }
    for (const label of ['额外页', '说明改动']) {
      await assert.rejects(exported(f, source, { afterWrite: async (filePath, expected) => {
        const zip = await JSZip.loadAsync(fs.readFileSync(filePath));
        if (label === '额外页') zip.file('xl/workbook.xml', (await zip.file('xl/workbook.xml').async('string'))
          .replace('</sheets>', '<sheet name="偷偷增加的页" sheetId="77" r:id="rId1"/></sheets>'));
        else if (kind === 'RESULT_DIFF') {
          const xml = await zip.file('xl/workbook.xml').async('string');
          const changed = xml.replace(/(<sheet\b[^>]*\bname=")[^"]+/, '$1核对说明');
          assert.notEqual(changed, xml, '差异页名称篡改必须实际生效');
          zip.file('xl/workbook.xml', changed);
        } else {
          const entry = `xl/worksheets/sheet${expected.pages.findIndex((page) => page.section === 'NOTES') + 1}.xml`;
          zip.file(entry, replaceCell(await zip.file(entry).async('string'), 'T2', '<c r="T2" t="str"><v>来源被改</v></c>'));
        }
        fs.writeFileSync(filePath, await zip.generateAsync({ type: 'nodebuffer' }));
      } }), corruptionRejected, `${kind}/${label}`); rejected += 1;
    }
  }
  assert.equal(rejected, 72);
});

module.exports = { sourceFor, exported };

test('空值、空文本、数字零、文本零、布尔、公式样式文本和控制字符各自无损；高精度与说明分片可还原', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bizop-typed-export-'));
  const source = { outputKind: 'FLOW_RAW', columnSchemaVersion: 1, objectId: 'typed-fixture', manifestDigest: '1'.repeat(64) };
  const spool = createExportSpool({ filename: path.join(root, 'spool.sqlite'), source });
  t.after(() => { spool.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const values = Array(28).fill(NULL_CELL);
  const precise = '12345678901234567890.123456789';
  const escaped = '_x0041_\u0001 =SUM(A1)';
  [NULL_CELL, text(''), number('0'), text('0'), { t: 'boolean', v: false, f: 'General' },
    { t: 'boolean', v: true, f: 'General' }, text('=1+2'), text(escaped),
    number(precise, (value, reason) => spool.precision(8, value, reason))].forEach((value, i) => { values[i] = value; });
  spool.data(values);
  const long = '说明'.repeat(4000) + '😀' + '尾'.repeat(8000);
  spool.note({ record_type: 'CONFLICT_VALUE', field_key: '长说明', value_part: long });
  const expected = await spool.finish(); const filePath = path.join(root, 'typed.xlsx');
  await writeExportWorkbook({ filePath, spool, expected, safePoint() {} });
  const actual = await validateExportWorkbook({ filePath, source, expected, tempDirectory: root });
  assert.equal(actual.actualDigest, expected.expectedDigest);
  const workbook = XLSX.readFile(filePath, { cellStyles: true }); const sheet = workbook.Sheets['流水校验原表'];
  assert.equal(sheet.A2, undefined); assert.equal(sheet.B2.v, ''); assert.equal(sheet.C2.v, 0);
  assert.equal(sheet.D2.v, '0'); assert.equal(sheet.E2.v, false); assert.equal(sheet.F2.v, true);
  assert.equal(sheet.G2.v, '=1+2'); assert.equal(sheet.G2.f, undefined);
  assert.equal(sheet.H2.v, escaped); assert.equal(sheet.I2.v, precise); assert.equal(sheet.I2.t, 's');
  const notes = [...spool.db.prepare("SELECT cells FROM export_rows WHERE section='NOTES' ORDER BY ordinal").iterate()]
    .map((row) => JSON.parse(row.cells));
  const parts = notes.filter((row) => row[1].v === 'CONFLICT_VALUE').map((row) => row[19].v);
  assert.ok(parts.join('') === long, '8000 单元分片必须完整还原原说明'); assert.ok(parts.every((value) => value.length <= 8000));
  assert.equal(notes.filter((row) => row[1].v === 'PRECISION_NOTE').length, 1);
});

test('expected 摘要在千行边界可观察取消，不继续进入 writer', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bizop-expected-cancel-')); let cancelled = false;
  const source = { outputKind: 'FLOW_CHECK', columnSchemaVersion: 1, objectId: 'cancel-fixture', manifestDigest: '2'.repeat(64) };
  const spool = createExportSpool({ filename: path.join(root, 'spool.sqlite'), source,
    safePoint() { if (cancelled) throw Object.assign(new Error('cancel'), { code: 'BIZOP_CANCELLED' }); } });
  t.after(() => { spool.close(); fs.rmSync(root, { recursive: true, force: true }); });
  for (let i = 0; i < 2048; i += 1) spool.data(Array(9).fill(text(String(i))));
  setImmediate(() => { cancelled = true; });
  await assert.rejects(spool.finish(), { code: 'BIZOP_CANCELLED' });
});

test('actual 拒绝伪造 worksheet 关系类型，不能只看关系后缀', async (t) => {
  const f = await createHost(t); await seed(f); const run = await compute(f);
  const source = await sourceFor(f, 'RESULT_FULL', run.runId);
  await assert.rejects(exported(f, source, { afterWrite: async (filePath) => {
    const zip = await JSZip.loadAsync(fs.readFileSync(filePath));
    const entry = 'xl/_rels/workbook.xml.rels';
    const xml = await zip.file(entry).async('string');
    const changed = xml.replaceAll('http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet', 'urn:wrong/worksheet');
    assert.notEqual(changed, xml); zip.file(entry, changed);
    fs.writeFileSync(filePath, await zip.generateAsync({ type: 'nodebuffer' }));
  } }), corruptionRejected);
});

test('命名使用固定版本与跨年区间；极大版本和最后分页缩写后仍不超过 31 单元', () => {
  assert.equal(outputName('OP_RAW', { dataDate: '2026-08-08', version: 1 }), '业务OP校验原表_2026-08-08_v1');
  assert.equal(outputName('RESULT_DIFF', { startDate: '2026-08-08', endDate: '2026-09-11', version: 1 }), '业务OP校验结果表_2026-08-08~09-11_v1');
  assert.equal(outputName('RESULT_FULL', { startDate: '2026-12-31', endDate: '2027-01-02', version: 2 }), '业务OP校验结果原表_2026-12-31~2027-01-02_v2');
  const source = { metadata: { startDate: '2026-12-31', endDate: '2027-01-02', startInputVersion: 123456789, endInputVersion: 123456789 } };
  assert.equal(sheetName('RESULT_FULL', 4096, source), '20261231 VS 20270102(4096)');
});
