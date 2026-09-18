'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');
const ExcelJS = require('exceljs');
const XLSX = require('xlsx');
const repository = require('../../../src/backend/vcc-financial-op-db/repository');
const { createReviewFixture } = require('../../helpers/vcc-review-export');
const { prepareReviewManifest, extractReviewSources, getMeta } = require('../../../src/backend/vcc-financial-op/review-export-plan');
const { writeReviewWorkbook } = require('../../../src/main-process/vcc-financial-op-review-writer');
const { validateReviewWorkbook } = require('../../../src/main-process/vcc-financial-op-review-validator');
const { getEffectiveRunResult, listAdjustmentOptions, addRunAdjustment } = require('../../../src/backend/vcc-financial-op/result-adjustments');
const JSZip = require('jszip');
const { PENDING_V1_HEADERS, PENDING_HEADERS } = require('../../../src/backend/vcc-financial-op/definitions');
const { pendingContentHash } = require('../../../src/backend/vcc-financial-op/row-mapper');

test('真实导入和计算 → 同快照 E/A/P → 全主体 Sheet1 与关联原表；业务库只读且原件只扫描一次', async (t) => {
  const f = await createReviewFixture(t);
  assert.equal(f.imported.physicalFileCount, 1); assert.equal(f.imported.businessSheetCount, 6);
  assert.equal(f.imported.readRowCount, 26, '系统 OP 统计 18 行原表数据，而非 2 个快照');
  const manifestPath = path.join(f.dir, 'manifest.sqlite'), outputPath = path.join(f.dir, 'review.xlsx');
  const before = f.db.prepare('SELECT total_changes() n').get().n;
  const prepared = await prepareReviewManifest({ ...f, manifestPath, appVersion: '3.2.9' });
  assert.equal(prepared.subjectCount, 2);
  const extracted = await extractReviewSources({ manifestPath }); assert.equal(extracted.scannedFiles, 1);
  const manifest = new DatabaseSync(manifestPath, { readOnly: true });
  const groups = manifest.prepare('SELECT descriptor FROM groups ORDER BY subject_order,currency_order,type_order').all().map((g) => JSON.parse(g.descriptor));
  assert.deepEqual(groups.map((g) => [g.subject, g.currency, g.sourceType]), [
    ['甲','EUR','channel'], ['甲','EUR','pending_archive_removal'], ['甲','EUR','system_op'],
    ['甲','USD','recharge_refund'], ['甲','USD','fee_fx'], ['甲','USD','pending_archive_removal'], ['甲','USD','system_op'],
    ['乙','EUR','channel'], ['乙','EUR','pending_archive_removal'], ['乙','EUR','system_op'],
    ['乙','USD','recharge_refund'], ['乙','USD','fee_fx'], ['乙','USD','pending_archive_removal'], ['乙','USD','system_op']
  ]);
  assert.equal(manifest.prepare('SELECT COUNT(*) n FROM expected').get().n, 14);
  const provenance = getMeta(manifest, 'provenance'); manifest.close();
  const written = await writeReviewWorkbook({ filePath: outputPath, manifestPath, assetsDir: f.assetsDir });
  assert.equal(written.sheetCount, 15); assert.equal(written.sourceRowCount, 14);
  const checked = await validateReviewWorkbook({ filePath: outputPath, manifestPath });
  assert.equal(checked.sheetCount, 15); assert.equal(checked.resultRevision, provenance.resultRevision);
  assert.equal(f.db.prepare('SELECT total_changes() n').get().n, before);
  const book = new ExcelJS.Workbook(); await book.xlsx.readFile(outputPath);
  assert.equal(book.worksheets[0].name, '待确认表');
  assert.deepEqual(book.worksheets[0].getRow(2).values.slice(1), ['主体','大类','分类','AUD','CAD','CNY','EUR','GBP','HKD','JPY','SGD','USD','调整值','调整原因']);
  assert.equal(book.worksheets[0].getCell('B7').value, '期初财务OP');
  assert.equal(book.worksheets[0].getCell('B10').value, '差异');
  assert.equal(book.worksheets[0].getCell('A12').value, '乙');
  const pending = book.worksheets.find((s) => s.getRow(1).values.includes('PendingBizId'));
  const remarkColumn = pending.getRow(1).values.indexOf('备注');
  assert.equal(pending.getCell(2, remarkColumn).value, '=1+1');
  assert.equal(fs.existsSync(outputPath), true);
});

test('绑定原件被篡改时停止，不能使用残留 fallback 掩盖；输入 revision 改变拒绝旧快照', async (t) => {
  const f = await createReviewFixture(t, { subjects: ['甲'] });
  const manifestPath = path.join(f.dir, 'manifest.sqlite');
  await prepareReviewManifest({ ...f, manifestPath, appVersion: '3.2.9' });
  fs.appendFileSync(path.join(f.archiveRoot, `blobs/${f.files[0].sha256}`), 'changed');
  await assert.rejects(extractReviewSources({ manifestPath }), { code: 'archive-integrity-failure' });
  f.db.prepare("UPDATE vcc_fin_op_datasets SET revision=revision+1 WHERE target_month='2026-06'").run();
  await assert.rejects(prepareReviewManifest({ ...f, manifestPath: path.join(f.dir, 'stale.sqlite'), appVersion: '3.2.9' }), { code: 'state-changed' });
});

test('全部主体经已保存调整归零只生成 Sheet1；调整引用跨主体偏移正确，再次产生差异会恢复对应附页', async (t) => {
  const f = await createReviewFixture(t);
  const before = getEffectiveRunResult(f.db, f.run.id);
  let revision = f.request.expectedResultRevision;
  for (const subject of before.review.subjects) {
    for (const currency of ['EUR', 'USD']) {
      const amount = subject.summaries.effectiveDifference[currency];
      const option = listAdjustmentOptions(f.db, f.run.id).options.find((o) => o.subject === subject.subject && o.sourceType === 'recharge_refund');
      addRunAdjustment({ db: f.db, runId: f.run.id, rowKey: option.rowKey, currency,
        adjustmentAmount: amount, reason: `复核 ${subject.subject} ${currency}`, expectedResultRevision: revision++ });
    }
  }
  const parameters = { ...f, request: { ...f.request, expectedResultRevision: revision }, appVersion: '3.2.9',
    manifestPath: path.join(f.dir, 'zero.sqlite'), filePath: path.join(f.dir, 'zero.xlsx') };
  await prepareReviewManifest(parameters); assert.equal((await extractReviewSources(parameters)).scannedFiles, 0);
  assert.equal((await writeReviewWorkbook(parameters)).sheetCount, 1); await validateReviewWorkbook(parameters);
  const book = new ExcelJS.Workbook(); await book.xlsx.readFile(parameters.filePath);
  assert.equal(book.worksheets.length, 1);
  assert.equal(book.definedNames.model.length, 4);
  assert.match(book.worksheets[0].pageSetup.printArea, /^A1:N/);
  assert.ok(book.definedNames.model.filter((n) => !n.name.startsWith('_xlnm')).every((n) => n.ranges.every((r) => /待确认表.*\$M\$/.test(r))));
  const option = listAdjustmentOptions(f.db, f.run.id).options.find((o) => o.subject === '乙' && o.sourceType === 'fee_fx');
  addRunAdjustment({ db: f.db, runId: f.run.id, rowKey: option.rowKey, currency: 'USD', adjustmentAmount: '1', reason: '恢复差异', expectedResultRevision: revision });
  await prepareReviewManifest({ ...parameters, request: { ...f.request, expectedResultRevision: revision + 1 }, manifestPath: path.join(f.dir, 'again.sqlite') });
  const db = new DatabaseSync(path.join(f.dir, 'again.sqlite'), { readOnly: true });
  assert.deepEqual([...new Set(db.prepare('SELECT descriptor FROM groups').all().map((r) => { const g = JSON.parse(r.descriptor); return `${g.subject}:${g.currency}`; }))], ['乙:USD']); db.close();
});

test('E/A/P 独立守恒：提取缺行、Writer 替换身份和最终 XLSX 金额/样式/附加页篡改均拒绝', async (t) => {
  const f = await createReviewFixture(t, { subjects: ['甲'] });
  const options = { ...f, appVersion: '3.2.9', manifestPath: path.join(f.dir, 'manifest.sqlite'), filePath: path.join(f.dir, 'valid.xlsx') };
  await prepareReviewManifest(options); await extractReviewSources(options);
  await assert.rejects(writeReviewWorkbook({ ...options, filePath: path.join(f.dir, 'wrong-id.xlsx'),
    transformEnvelope: (row) => ({ ...row, identity: 'D:999999' }) }), { code: 'vcc-review-validation-failed' });
  await writeReviewWorkbook(options); await validateReviewWorkbook(options);
  const bytes = fs.readFileSync(options.filePath);
  for (const mutation of ['amount', 'fill', 'hidden']) {
    const zip = await JSZip.loadAsync(bytes);
    if (mutation === 'hidden') zip.file('xl/worksheets/undeclared.xml', '<worksheet/>');
    else {
      const xml = await zip.file('xl/worksheets/sheet1.xml').async('string');
      const altered = mutation === 'amount' ? xml.replace('<v>10.25</v>', '<v>10.26</v>') : xml.replace(/(<c r="D2"[^>]* s=")[0-9]+/, '$10');
      assert.notEqual(altered, xml, mutation); zip.file('xl/worksheets/sheet1.xml', altered);
    }
    const filePath = path.join(f.dir, `${mutation}.xlsx`); fs.writeFileSync(filePath, await zip.generateAsync({ type: 'nodebuffer' }));
    await assert.rejects(validateReviewWorkbook({ ...options, filePath }), { code: 'vcc-review-validation-failed' });
  }
  const manifest = new DatabaseSync(options.manifestPath); manifest.exec('DELETE FROM actual WHERE identity=(SELECT identity FROM expected LIMIT 1)'); manifest.close();
  await assert.rejects(writeReviewWorkbook({ ...options, filePath: path.join(f.dir, 'missing.xlsx') }), { code: 'vcc-review-validation-failed' });
});

test('历史 Pending 48 列与当前 46 列分别附页，旧列值原样保留，不套用当前表头', async (t) => {
  const f = await createReviewFixture(t);
  const facts = f.db.prepare("SELECT * FROM vcc_fin_op_effective_rows WHERE source_type='pending_archive_removal' ORDER BY id").all();
  // 创建真正没有 artifact 成员的历史审计，不能把已有绑定字段清空来假扮旧来源。
  repository.createImportBatch(f.db, { id: 'historical-pending', targetMonth: '2026-06', fileCount: 1 });
  const recordId = repository.createImportRecord(f.db, { batchId: 'historical-pending', targetMonth: '2026-06',
    sourceType: 'pending_archive_removal', sourceFiles: ['historical.xlsx'] });
  repository.finishImportRecord(f.db, recordId, { status: 'success', rawCount: 2, insertedCount: 2 });
  repository.finishImportBatch(f.db, 'historical-pending', 'success');
  const sourceId = repository.createImportSource(f.db, recordId, { sourceOrdinal: 1, fileName: 'historical.xlsx',
    sha256: f.files[0].sha256, sizeBytes: f.files[0].sizeBytes });
  const book = new ExcelJS.Workbook(); await book.xlsx.readFile(f.filePath);
  const sheet = book.getWorksheet('Pending');
  const fallback = f.db.prepare('INSERT OR REPLACE INTO vcc_fin_op_effective_raw_fallback (effective_row_id,import_source_id,raw_contract_version,raw_json) VALUES (?,?,?,?)');
  for (const [index, fact] of facts.entries()) {
    const values = PENDING_HEADERS.map((_h, col) => sheet.getCell(index + 2, col + 1).value ?? '');
    const byHeader = Object.fromEntries(PENDING_HEADERS.map((h, col) => [h, values[col]]));
    const original = index === 0 ? PENDING_V1_HEADERS.map((h) => h === '是否错币' ? '人工旧值' : h === '金额差' ? '999.99' : byHeader[h] ?? '') : values;
    const version = index === 0 ? 1 : 2;
    fallback.run(fact.id, sourceId, version, JSON.stringify(original));
    f.db.prepare('UPDATE vcc_fin_op_effective_rows SET import_record_id=?,import_source_id=?,raw_contract_version=?,hash_version=2,content_hash=? WHERE id=?')
      .run(recordId, sourceId, version, pendingContentHash(original, version), fact.id);
  }
  const options = { ...f, appVersion: '3.2.9', manifestPath: path.join(f.dir, 'historical.sqlite'), filePath: path.join(f.dir, 'historical.xlsx') };
  await prepareReviewManifest(options); await extractReviewSources(options); await writeReviewWorkbook(options); await validateReviewWorkbook(options);
  const actual = new ExcelJS.Workbook(); await actual.xlsx.readFile(options.filePath);
  const pages = actual.worksheets.filter((s) => s.getRow(1).values.includes('PendingBizId'));
  assert.equal(pages.filter((s) => s.columnCount === 48).length, 2);
  assert.equal(pages.filter((s) => s.columnCount === 46).length, 2);
  for (const page of pages.filter((s) => s.columnCount === 48)) {
    assert.equal(page.getCell(2, PENDING_V1_HEADERS.indexOf('是否错币') + 1).value, '人工旧值');
    assert.equal(page.getCell(2, PENDING_V1_HEADERS.indexOf('金额差') + 1).value, '999.99');
  }
});


test('Pending 的 CRLF、字面转义串及共享/内联文本按旧哈希核验并原值导出', async (t) => {
  for (const encoding of ['str', 'shared', 'inline']) {
    await t.test(encoding, async (t) => {
      const remark = '第一行\r\n第二行 _x000d_ & <原文>';
      const f = await createReviewFixture(t, { subjects: ['甲'], pendingRemark: remark,
        writeOptions: { bookSST: encoding === 'shared' },
        beforeImport: async (filePath) => {
          const zip = await JSZip.loadAsync(fs.readFileSync(filePath));
          const name = encoding === 'shared' ? 'xl/sharedStrings.xml' : 'xl/worksheets/sheet4.xml';
          const xml = await zip.file(name).async('string');
          // 手写合法 OOXML：回车与字面 `_x000d_` 是两种不同的内容。
          const token = '第一行_x000D_\n第二行 _x005F_x000d_ &amp; &lt;原文&gt;';
          const changed = encoding === 'shared'
            ? xml.replace(/(<t[^>]*>)第一行[\s\S]*?(<\/t>)/, '$1' + token + '$2')
            : xml.replace(/<c r="Y2" t="str"[^>]*><v[^>]*>[\s\S]*?<\/v><\/c>/, encoding === 'inline'
              ? '<c r="Y2" t="inlineStr"><is><t xml:space="preserve">' + token + '</t></is></c>'
              : '<c r="Y2" t="str"><v xml:space="preserve">' + token + '</v></c>');
          assert.notEqual(changed, xml);
          zip.file(name, changed); fs.writeFileSync(filePath, await zip.generateAsync({ type: 'nodebuffer' }));
        } });
      const hashes = f.db.prepare('SELECT id,content_hash,hash_version FROM vcc_fin_op_effective_rows ORDER BY id').all();
      const options = { ...f, appVersion: '3.2.9', manifestPath: path.join(f.dir, 'text.sqlite'), filePath: path.join(f.dir, 'text.xlsx') };
      await prepareReviewManifest(options); await extractReviewSources(options);
      await writeReviewWorkbook(options); await validateReviewWorkbook(options);
      const book = XLSX.readFile(options.filePath);
      const pages = book.SheetNames.map((name) => XLSX.utils.sheet_to_json(book.Sheets[name], { header: 1 }))
        .filter((rows) => rows[0].includes('PendingBizId'));
      assert.equal(pages.length, 2);
      for (const rows of pages) assert.equal(rows[1][rows[0].indexOf('备注')], remark);
      assert.deepEqual(f.db.prepare('SELECT id,content_hash,hash_version FROM vcc_fin_op_effective_rows ORDER BY id').all(), hashes);
    });
  }
});

test('Pending 富文本按原导入合同核验，空 run、注音和 CDATA 不改变导出原文或历史哈希', async (t) => {
  const cases = [
    { name: 'trailing-selfclosing', body: '<is><r><t>第一段</t></r><r><t/></r></is>', text: '第一段' },
    { name: 'trailing-explicit-empty', body: '<is><r><t>第一段</t></r><r><t></t></r></is>', text: '第一段' },
    { name: 'multiple-runs', body: '<is><r><t>第一段</t></r><r><t>第二段</t></r></is>', text: '第一段第二段' },
    { name: 'phonetic', body: '<is><t>漢字</t><rPh sb="0" eb="2"><t>かんじ</t></rPh></is>', text: '漢字' },
    { name: 'cdata', body: '<is><t><![CDATA[备注 & <文字>]]></t></is>', text: '备注 & <文字>' },
    { name: 'cdata-entities', body: '<is><t>前<![CDATA[&amp;字面]]>后&amp;末</t></is>', text: '前&amp;字面后&末' },
    { name: 'comment', body: '<is><t>前<!--审计原文-->后</t></is>', text: '前后' }
  ];
  for (const sample of cases) await t.test(sample.name, async (t) => {
    const f = await createReviewFixture(t, { subjects: ['甲'], beforeImport: async (filePath) => {
      const zip = await JSZip.loadAsync(fs.readFileSync(filePath));
      const part = 'xl/worksheets/sheet4.xml', xml = await zip.file(part).async('string');
      const changed = xml.replace(/<c r="Y2" t="str"[^>]*><v[^>]*>[\s\S]*?<\/v><\/c>/,
        '<c r="Y2" t="inlineStr">' + sample.body + '</c>');
      assert.notEqual(changed, xml);
      zip.file(part, changed); fs.writeFileSync(filePath, await zip.generateAsync({ type: 'nodebuffer' }));
    } });
    const hashes = f.db.prepare('SELECT id,content_hash,hash_version FROM vcc_fin_op_effective_rows ORDER BY id').all();
    const changesBefore = f.db.prepare('SELECT total_changes() n').get().n;
    const options = { ...f, appVersion: '3.2.9', manifestPath: path.join(f.dir, 'rich.sqlite'), filePath: path.join(f.dir, 'rich.xlsx') };
    await prepareReviewManifest(options);
    assert.equal((await extractReviewSources(options)).scannedFiles, 1);
    await writeReviewWorkbook(options); await validateReviewWorkbook(options);
    const book = XLSX.readFile(options.filePath);
    const pages = book.SheetNames.map((name) => XLSX.utils.sheet_to_json(book.Sheets[name], { header: 1 }))
      .filter((rows) => rows[0].includes('PendingBizId'));
    assert.equal(pages.length, 2);
    for (const rows of pages) assert.equal(rows[1][rows[0].indexOf('备注')], sample.text);
    assert.deepEqual(f.db.prepare('SELECT id,content_hash,hash_version FROM vcc_fin_op_effective_rows ORDER BY id').all(), hashes);
    assert.equal(f.db.prepare('SELECT total_changes() n').get().n, changesBefore);
  });
});

test('系统 OP 布尔原值与公式缓存按导入类型核验，附页仍写入布尔单元格', async (t) => {
  const f = await createReviewFixture(t, { subjects: ['甲'], beforeImport: (filePath) => {
    const book = XLSX.readFile(filePath), sheet = book.Sheets['系统 OP'];
    for (let row = 2; row <= 10; row += 1) {
      sheet['E' + row] = { t: 'b', v: row % 2 === 0 };
      sheet['F' + row] = { t: 'b', v: row % 2 !== 0, f: row % 2 === 0 ? 'FALSE()' : 'TRUE()' };
    }
    XLSX.writeFile(book, filePath);
  } });
  const snapshots = f.db.prepare('SELECT * FROM vcc_fin_op_system_snapshots').all();
  const stored = JSON.parse(snapshots[0].raw_json).rows;
  assert.ok(stored.every((row) => typeof row.rawValues[4] === 'boolean' && typeof row.rawValues[5] === 'boolean'));
  const byCurrency = new Map(stored.map((row) => [row.rawValues[3], row.rawValues]));
  const changesBefore = f.db.prepare('SELECT total_changes() n').get().n;
  const options = { ...f, appVersion: '3.2.9', manifestPath: path.join(f.dir, 'boolean.sqlite'), filePath: path.join(f.dir, 'boolean.xlsx') };
  await prepareReviewManifest(options);
  assert.equal((await extractReviewSources(options)).scannedFiles, 1);
  await writeReviewWorkbook(options); await validateReviewWorkbook(options);
  const book = XLSX.readFile(options.filePath);
  const pages = book.SheetNames.map((name) => book.Sheets[name]).filter((sheet) => sheet.E1?.v === 'OP发生额');
  assert.equal(pages.length, 2);
  const booleans = new Set();
  for (const sheet of pages) {
    const expected = byCurrency.get(sheet.D2.v);
    for (const [column, index] of [['E', 4], ['F', 5]]) {
      assert.equal(sheet[column + '2'].t, 'b');
      assert.equal(sheet[column + '2'].v, expected[index]);
      assert.equal(sheet[column + '2'].f, undefined, '只输出缓存原值，不生成公式');
      booleans.add(sheet[column + '2'].v);
    }
  }
  assert.deepEqual([...booleans].sort(), [false, true]);
  assert.deepEqual(f.db.prepare('SELECT * FROM vcc_fin_op_system_snapshots').all(), snapshots);
  assert.equal(f.db.prepare('SELECT total_changes() n').get().n, changesBefore);
});

test('来源 ID 丢失时必须查导入审计的绑定证据，不能用系统 raw_json 绕过损坏原件', async (t) => {
  const f = await createReviewFixture(t, { subjects: ['甲'] });
  const subject = getEffectiveRunResult(f.db, f.run.id).review.subjects[0];
  const option = listAdjustmentOptions(f.db, f.run.id).options.find((o) => o.sourceType === 'recharge_refund');
  let revision = f.request.expectedResultRevision;
  for (const currency of ['EUR', 'USD']) addRunAdjustment({ db: f.db, runId: f.run.id, rowKey: option.rowKey,
    currency, adjustmentAmount: subject.summaries.effectiveDifference[currency], reason: '归零', expectedResultRevision: revision++ });
  addRunAdjustment({ db: f.db, runId: f.run.id, rowKey: option.rowKey, currency: 'JPY', adjustmentAmount: '1',
    reason: '仅系统来源差异', expectedResultRevision: revision++ });
  f.db.prepare('UPDATE vcc_fin_op_system_snapshots SET import_source_id=NULL').run();
  fs.appendFileSync(path.join(f.archiveRoot, 'blobs', f.files[0].sha256), 'CORRUPTED');
  await assert.rejects(prepareReviewManifest({ ...f, request: { ...f.request, expectedResultRevision: revision },
    appVersion: '3.2.9', manifestPath: path.join(f.dir, 'broken.sqlite') }), { code: 'vcc-review-source-unavailable' });
});


test('日期类型系统 OP 的导入审计可用于待确认原表重建，保留原 ISO 值', async (t) => {
  const f = await createReviewFixture(t, { subjects: ['甲'], systemBillDate: new Date('2026-06-30T00:00:00Z'), writeOptions: { cellDates: true },
    beforeImport: async (filePath) => {
      const zip = await JSZip.loadAsync(fs.readFileSync(filePath));
      const name = 'xl/worksheets/sheet5.xml';
      const xml = await zip.file(name).async('string');
      let dates = 0;
      const changed = xml.replace(/(<c r="A\d+"[^>]* t="d"[^>]*><v>)[^<]+(<\/v>)/g, (_all, begin, end) => {
        dates += 1; return begin + '2026-06-30T00:00:00.000Z' + end;
      });
      assert.equal(dates, 9);
      zip.file(name, changed); fs.writeFileSync(filePath, await zip.generateAsync({ type: 'nodebuffer' }));
    } });
  const options = { ...f, appVersion: '3.2.9', manifestPath: path.join(f.dir, 'dates.sqlite'), filePath: path.join(f.dir, 'dates.xlsx') };
  await prepareReviewManifest(options); await extractReviewSources(options);
  await writeReviewWorkbook(options); await validateReviewWorkbook(options);
  const book = XLSX.readFile(options.filePath);
  const pages = book.SheetNames.map((name) => XLSX.utils.sheet_to_json(book.Sheets[name], { header: 1 }))
    .filter((rows) => rows[0].includes('财务主体余额'));
  assert.equal(pages.length, 2);
  for (const rows of pages) assert.equal(rows[1][rows[0].indexOf('账单日期')], '2026-06-30T00:00:00.000Z');
});

test('来源字段清空或来源记录被删除仍保留 artifact 证据时，拒绝历史降级', async (t) => {
  for (const mode of ['cleared-binding', 'deleted-source']) {
    await t.test(mode, async (t) => {
      const f = await createReviewFixture(t, { subjects: ['甲'] });
      const snapshot = f.db.prepare('SELECT * FROM vcc_fin_op_system_snapshots').get();
      if (mode === 'cleared-binding') {
        f.db.prepare("UPDATE vcc_fin_op_import_sources SET archive_artifact_id=NULL,bound_at=NULL,archive_state='pending' WHERE id=?").run(snapshot.import_source_id);
      } else {
        f.db.prepare('UPDATE vcc_fin_op_system_snapshots SET import_source_id=NULL').run();
        f.db.prepare('DELETE FROM vcc_fin_op_import_sources WHERE id=?').run(snapshot.import_source_id);
      }
      await assert.rejects(prepareReviewManifest({ ...f, appVersion: '3.2.9', manifestPath: path.join(f.dir, 'broken.sqlite') }),
        { code: 'vcc-review-source-unavailable' });
    });
  }
});

test('真正未建立来源绑定的历史系统快照继续按审计和 raw_json 导出', async (t) => {
  const f = await createReviewFixture(t, { subjects: ['甲'] });
  repository.createImportBatch(f.db, { id: 'historical-system', targetMonth: '2026-06', fileCount: 1 });
  const recordId = repository.createImportRecord(f.db, { batchId: 'historical-system', targetMonth: '2026-06',
    sourceType: 'system_op', sourceFiles: ['historical-system.xlsx'] });
  repository.finishImportRecord(f.db, recordId, { status: 'success', rawCount: 1, insertedCount: 1 });
  repository.finishImportBatch(f.db, 'historical-system', 'success');
  f.db.prepare('UPDATE vcc_fin_op_system_snapshots SET import_record_id=?,import_source_id=NULL').run(recordId);
  const options = { ...f, appVersion: '3.2.9', manifestPath: path.join(f.dir, 'legacy.sqlite'), filePath: path.join(f.dir, 'legacy.xlsx') };
  await prepareReviewManifest(options); await extractReviewSources(options);
  await writeReviewWorkbook(options); await validateReviewWorkbook(options);
  const manifest = new DatabaseSync(options.manifestPath, { readOnly: true });
  try {
    assert.ok(manifest.prepare('SELECT descriptor FROM sources').all().some((row) => JSON.parse(row.descriptor).mode === 'legacy'));
  } finally { manifest.close(); }
});
