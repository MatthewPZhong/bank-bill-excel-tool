'use strict';
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { DatabaseSync } = require('node:sqlite');
const { ZipFile } = require('yazl');
const JSZip = require('jszip');
const count = 1100, units = 32700, budget = 64 * 1024 * 1024;
const valueAt = (i) => `${String(i).padStart(6, '0')}${'甲'.repeat(units - 6)}`;
let rewriteEvidence;

async function rewrite(filePath) {
  // JSZip 仅读取原小夹具；超过 100 MiB 的 SST 由 yazl 流式写入。
  const original = await JSZip.loadAsync(fs.readFileSync(filePath));
  const sst = await original.file('xl/sharedStrings.xml').async('string');
  const sheet = await original.file('xl/worksheets/sheet4.xml').async('string');
  const existingCount = (sst.match(/<si(?:\s|>)/g) || []).length;
  const dataStart = sheet.indexOf('<sheetData>'), dataEnd = sheet.indexOf('</sheetData>');
  assert.ok(dataStart >= 0 && dataEnd > dataStart);
  const header = sheet.slice(dataStart, dataEnd).match(/<row\b[^>]*r="1"[^>]*>[\s\S]*?<\/row>/)[0];
  const row = sheet.slice(dataStart, dataEnd).match(/<row\b[^>]*r="2"[^>]*>[\s\S]*?<\/row>/)[0];
  assert.match(row, /<c r="X2"/); assert.match(row, /<c r="Y2"/);
  const oldIdIndex = Number(row.match(/<c r="X2"[^>]*><v>(\d+)<\/v><\/c>/)[1]);
  const sharedPerRow = (row.match(/ t="s"/g) || []).length - 1;
  let otherRefs = 0;
  for (const name of Object.keys(original.files).filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n))) {
    if (name !== 'xl/worksheets/sheet4.xml') otherRefs += ((await original.file(name).async('string')).match(/ t="s"/g) || []).length;
  }
  const totalRefs = otherRefs + (header.match(/ t="s"/g) || []).length + count * sharedPerRow;
  const prefix = sst.slice(0, sst.lastIndexOf('</sst>'))
    .replace(/(<sst\b[^>]*\bcount=")[^"]*/, `$1${totalRefs}`)
    .replace(/(<sst\b[^>]*\buniqueCount=")[^"]*/, `$1${existingCount + count}`);
  const outputPath = `${filePath}.pressure`, zip = new ZipFile();
  for (const [name, item] of Object.entries(original.files)) {
    if (item.dir) continue;
    if (name === 'xl/sharedStrings.xml') {
      zip.addReadStream(Readable.from((function* () {
        yield prefix;
        for (let i = 0; i < count; i++) yield `<si><t>${valueAt(i)}</t></si>`;
        yield '</sst>';
      })()), name);
    } else if (name === 'xl/worksheets/sheet4.xml') {
      zip.addReadStream(Readable.from((function* () {
        yield sheet.slice(0, dataStart).replace(/(<dimension ref="[A-Z]+\d+:[A-Z]+)\d+("\/?>)/, `$1${count + 1}$2`);
        yield '<sheetData>'; yield header;
        for (let i = 0; i < count; i++) {
          let changed = row.replace(/<c r="X2"[^>]*>[\s\S]*?<\/c>/,
            `<c r="X2" t="inlineStr"><is><t>pressure-${String(i).padStart(6, '0')}</t></is></c>`)
            .replace(/<c r="Y2"[^>]*>[\s\S]*?<\/c>/,
              `<c r="Y2" t="s"><v>${existingCount + i}</v></c>`)
            .replace(/\br="([A-Z]*)2"/g, (_all, column) => `r="${column}${i + 2}"`);
          yield changed;
        }
        yield sheet.slice(dataEnd);
      })()), name);
    } else zip.addBuffer(await item.async('nodebuffer'), name);
  }
  const writing = pipeline(zip.outputStream, fs.createWriteStream(outputPath, { flags: 'wx' }));
  zip.end(); await writing; fs.renameSync(outputPath, filePath);
  rewriteEvidence = { pendingRows: count, pendingIdColumn: 'X', remarkColumn: 'Y', originalSstCount: existingCount,
    dictionaryCount: existingCount + count, oldIdIndex, finalZipBytes: fs.statSync(filePath).size };
}


test('VCC 真实 SST 落盘后 1100 条长中文原文准确提取，内存及字节缓存均受 64 MiB 约束', async (t) => {
  const reader = require('../../../src/backend/xlsx-rich-reader');
  const originalOpen = reader.openRichWorkbook;
  const observations = [];
  let extracting = false;
  // 观测真实 provider，不替换数据、缩小预算或强制落盘。
  t.mock.method(reader, 'openRichWorkbook', async (...args) => {
    const book = await originalOpen(...args);
    if (!extracting) return book;
    const provider = book.sharedStrings, originalClose = provider.close.bind(provider);
    t.mock.method(provider, 'close', async () => {
      const spill = provider.tempRoot;
      let record;
      try {
        let utf16Bytes = 0, cacheCharge = 0;
        for (const value of provider.cache?.values() || []) {
          utf16Bytes += value.length * 2;
          cacheCharge += Math.max(value.length * 2, Buffer.byteLength(value, 'utf8')) + 64;
        }
        record = { mode: provider.mode, count: provider.count,
          memoryBudgetBytes: provider.memoryBudgetBytes, cacheMaxBytes: provider.cacheMaxBytes,
          peakMemoryBytes: provider.peakMemoryBytes, peakCacheBytes: provider.peakCacheBytes,
          cacheBytes: provider.cacheBytes, cacheEntries: provider.cache?.size || 0,
          utf16Bytes, cacheCharge };
      } finally { await originalClose(); }
      record.closed = provider.closed;
      record.cacheCleared = !provider.cache || provider.cache.size === 0;
      record.spillRemoved = !!spill && !fs.existsSync(spill);
      observations.push(record);
    });
    return book;
  });
  // 安装观测后再加载，使生产模块仍调用被观测的真实 reader。
  const { createReviewFixture } = require('../../helpers/vcc-review-export');
  const { prepareReviewManifest, extractReviewSources } = require('../../../src/backend/vcc-financial-op/review-export-plan');
  const { PENDING_HEADERS } = require('../../../src/backend/vcc-financial-op/definitions');
  assert.equal(PENDING_HEADERS[23], 'PendingBizId');
  assert.equal(PENDING_HEADERS[24], '备注');
  const fixture = await createReviewFixture(t, {
    subjects: ['甲'], writeOptions: { bookSST: true }, beforeImport: rewrite
  });
  assert.equal(fixture.imported.physicalFileCount, 1);
  // 持久触发器同时约束 fixture.db 和新连接的业务写入。
  const guardedTables = fixture.db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
  const identifier = (name) => `"${name.replace(/"/g, '""')}"`;
  for (const { name } of guardedTables) {
    for (const verb of ['INSERT', 'UPDATE', 'DELETE']) {
      fixture.db.exec(`CREATE TRIGGER ${identifier(`sst_no_${verb}_${name}`)} BEFORE ${verb} ON ${identifier(name)} BEGIN SELECT RAISE(ABORT, 'SST review must be read-only'); END`);
    }
  }
  assert.ok(guardedTables.some(({ name }) => name === 'vcc_fin_op_runs'));
  assert.ok(guardedTables.some(({ name }) => name === 'archive_artifacts'));
  // 独立连接证明保护生效，失败语句不改变业务行。
  const independent = new DatabaseSync(fixture.dbPath);
  try {
    require('../../../src/backend/vcc-financial-op-db/storage-contract').registerVccStorageWriteCapability(independent);
    assert.throws(() => independent.prepare('UPDATE vcc_fin_op_runs SET target_month=target_month WHERE id=?').run(fixture.run.id), /SST review must be read-only/);
    assert.throws(() => independent.exec('UPDATE archive_artifacts SET id=id'), /SST review must be read-only/);
  } finally { independent.close(); }
  const businessBefore = fixture.db.prepare('SELECT total_changes() n').get().n;
  const manifestPath = path.join(fixture.dir, 'sst-budget.sqlite');
  await prepareReviewManifest({ ...fixture, manifestPath, appVersion: '3.2.9' });
  extracting = true;
  const extracted = await extractReviewSources({ manifestPath });
  assert.equal(extracted.scannedFiles, 1);
  const manifest = new DatabaseSync(manifestPath, { readOnly: true });
  let actualPending = 0;
  try {
    for (const row of manifest.prepare("SELECT f.source_row,a.cells FROM facts f JOIN actual a USING(identity) WHERE f.sheet_name='Pending' ORDER BY f.source_row").iterate()) {
      assert.equal(row.source_row, actualPending + 2);
      const cells = JSON.parse(row.cells);
      assert.equal(cells[23].v, `pressure-${String(actualPending).padStart(6, '0')}`);
      assert.equal(cells[24].v, valueAt(actualPending));
      actualPending++;
    }
    assert.equal(manifest.prepare('SELECT COUNT(*) n FROM facts').get().n, extracted.extracted);
    assert.equal(manifest.prepare('SELECT COUNT(*) n FROM actual').get().n, extracted.extracted);
  } finally { manifest.close(); }
  assert.equal(actualPending, count);
  assert.equal(fixture.db.prepare('SELECT total_changes() n').get().n, businessBefore);
  assert.equal(observations.length, 1);
  const observed = observations[0];
  assert.equal(observed.mode, 'disk', 'real default 64 MiB dictionary must spill');
  assert.equal(observed.count, rewriteEvidence.dictionaryCount);
  assert.equal(observed.memoryBudgetBytes, budget);
  assert.equal(observed.cacheMaxBytes, budget);
  assert.ok(observed.cacheEntries > 0 && observed.cacheEntries < count, 'long entries evict before the 8192-entry legacy cap');
  assert.ok(observed.peakMemoryBytes > 0 && observed.peakMemoryBytes <= budget);
  assert.ok(observed.peakCacheBytes > 0 && observed.peakCacheBytes <= budget);
  assert.ok(observed.utf16Bytes > 0 && observed.utf16Bytes <= budget, 'actual cached decoded text is byte-bounded');
  assert.ok(observed.cacheCharge > 0 && observed.cacheCharge <= budget);
  assert.equal(observed.cacheBytes, observed.cacheCharge, 'reported bytes match independently summed real cached values');
  assert.equal(observed.closed, true);
  assert.equal(observed.cacheCleared, true);
  assert.equal(observed.spillRemoved, true);
  t.diagnostic(JSON.stringify({ pendingRows: actualPending, physicalFiles: extracted.scannedFiles, guardedBusinessTables: guardedTables.length, independentConnectionGuardsVerified: true, ...observed }));
});
