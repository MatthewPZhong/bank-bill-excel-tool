'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const XLSX = require('xlsx');
const { createReviewFixture } = require('../../helpers/vcc-review-export');
const repository = require('../../../src/backend/vcc-financial-op-db/repository');
const { SYSTEM_OP_DEFINITION } = require('../../../src/backend/vcc-financial-op/definitions');
const { readSystemOpSnapshotCandidates } = require('../../../src/backend/vcc-financial-op/system-op-importer');
const { hashSourceFileSync } = require('../../../src/backend/vcc-financial-op/source-lineage');
const { prepareReviewManifest, extractReviewSources } = require('../../../src/backend/vcc-financial-op/review-export-plan');
const { writeReviewWorkbook } = require('../../../src/main-process/vcc-financial-op-review-writer');
const { validateReviewWorkbook } = require('../../../src/main-process/vcc-financial-op-review-validator');

async function legacyFixture(t, { changeAudit, changeOriginal, subject = '甲', subjectCell } = {}) {
  const f = await createReviewFixture(t, { subjects: [subject] });
  const oldFile = path.join(f.dir, 'legacy-system.xlsx');
  const sheet = XLSX.readFile(f.filePath).Sheets['系统 OP'];
  if (subjectCell) for (let row = 2; row <= 10; row++) sheet['B' + row] = { ...subjectCell };
  for (let row = 2; row <= 10; row++) sheet['E' + row] = row % 2
    ? { t: 'e', v: 42, f: 'NA()' } : { t: 'e', v: 7 };
  const single = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(single, sheet, '系统 OP');
  XLSX.writeFile(single, oldFile);
  // 复用仍保留的单 Sheet / SheetJS 读取合同，而不是手工捏造空审计。
  const parsed = readSystemOpSnapshotCandidates(oldFile, '2026-06');
  assert.equal(parsed.validationErrors.length, 0); assert.equal(parsed.snapshots.length, 1);
  const legacy = parsed.snapshots[0], audit = JSON.parse(legacy.rawJson);
  assert.ok(audit.rows.every((row) => row.rawValues[4] === '' && row.displayValues[4] === ''));
  if (changeOriginal) { changeOriginal(sheet); XLSX.writeFile(single, oldFile); }
  if (changeAudit) changeAudit(audit);
  const fingerprint = hashSourceFileSync(oldFile), id = 'legacy-system';
  repository.createImportBatch(f.db, { id, targetMonth: '2026-06', fileCount: 1 });
  const recordId = repository.createImportRecord(f.db, { batchId: id, targetMonth: '2026-06', sourceType: 'system_op', sourceFiles: ['legacy-system.xlsx'] });
  repository.finishImportRecord(f.db, recordId, { status: 'success', rawCount: 1, insertedCount: 1 });
  repository.finishImportBatch(f.db, id, 'success');
  const batch = f.archive.createBatch({ moduleId: 'vcc-financial-op', moduleCode: 'VCCFINOP', moduleName: 'VCC',
    operationKey: id, taskKey: 'vccFinancialOp:import:apply', taskRunId: id, parentRunId: id,
    localDate: '2026-09-18', retentionUntil: '2026-11-17' }).batch;
  f.db.prepare('UPDATE archive_batches SET task_run_id=?,task_key=? WHERE id=?').run(id, 'vccFinancialOp:import:apply', batch.id);
  const artifact = f.archive.addArtifact(batch.id, { artifactKey: 'input:0', direction: 'input', role: 'input',
    sourceOperation: 'vccFinancialOp:import:apply', originalName: 'legacy-system.xlsx', sourcePath: oldFile,
    metadata: { vccImportHandoffVersion: 1, vccSourceType: 'system_op', vccTaskRunId: id, vccSourceOrdinal: 1 } });
  const relativePath = `blobs/${fingerprint.sha256}`;
  fs.copyFileSync(oldFile, path.join(f.archiveRoot, relativePath));
  f.archive.startArtifactAttempt(artifact.id);
  f.archive.completeArtifact(artifact.id, { ...fingerprint, relativePath,
    fingerprint: { sizeBytes: fingerprint.sizeBytes, mtimeMs: 1, ctimeMs: 1, ino: '1' } });
  const sourceId = repository.createImportSource(f.db, recordId, { sourceOrdinal: 1, fileName: 'legacy-system.xlsx',
    ...fingerprint, archiveArtifactId: artifact.id });
  assert.equal(f.db.prepare('SELECT content_hash FROM vcc_fin_op_system_snapshots').get().content_hash, legacy.contentHash);
  f.db.prepare('UPDATE vcc_fin_op_system_snapshots SET import_record_id=?,import_source_id=?,source_file=?,raw_json=?')
    .run(recordId, sourceId, legacy.sourceFile, JSON.stringify(audit));
  return { ...f, appVersion: '3.2.9', manifestPath: path.join(f.dir, 'legacy.sqlite'),
    filePath: path.join(f.dir, 'review.xlsx'), originalPath: path.join(f.archiveRoot, relativePath) };
}

test('v1 绑定原件的系统 OP 错误/错误公式缓存按旧空审计核验，附页输出原始错误码文本', async (t) => {
  const f = await legacyFixture(t);
  const snapshots = f.db.prepare('SELECT * FROM vcc_fin_op_system_snapshots').all();
  const before = f.db.prepare('SELECT total_changes() n').get().n;
  await prepareReviewManifest(f); await extractReviewSources(f);
  await writeReviewWorkbook(f); await validateReviewWorkbook(f);
  const book = XLSX.readFile(f.filePath);
  const pages = book.SheetNames.map((name) => book.Sheets[name]).filter((sheet) => sheet.E1?.v === 'OP发生额');
  assert.equal(pages.length, 2);
  assert.deepEqual(pages.map((sheet) => sheet.E2.v).sort(), ['#DIV/0!', '#N/A']);
  for (const sheet of pages) { assert.equal(sheet.E2.t, 's'); assert.equal(sheet.E2.f, undefined); }
  assert.deepEqual(f.db.prepare('SELECT * FROM vcc_fin_op_system_snapshots').all(), snapshots);
  assert.equal(f.db.prepare('SELECT total_changes() n').get().n, before);
});

test('v1 系统 OP 按旧显示主体匹配，保留数值格式和布尔原类型', async (t) => {
  for (const item of [
    { subject: '000123', subjectCell: { t: 'n', v: 123, z: '000000' } },
    { subject: 'TRUE', subjectCell: { t: 'b', v: true } }
  ]) await t.test(item.subject, async (t) => {
    const f = await legacyFixture(t, item);
    await prepareReviewManifest(f); await extractReviewSources(f); await writeReviewWorkbook(f); await validateReviewWorkbook(f);
    const book = XLSX.readFile(f.filePath, { cellNF: true });
    const pages = book.SheetNames.map((name) => book.Sheets[name]).filter((sheet) => sheet.E1?.v === 'OP发生额');
    assert.equal(pages.length, 2);
    for (const page of pages) {
      assert.equal(page.B2.t, item.subjectCell.t); assert.equal(page.B2.v, item.subjectCell.v);
      assert.equal(page.B2.w, item.subject);
    }
  });
});

test('旧错误兼容不放过非空审计或普通文本不符', async (t) => {
  for (const mode of ['raw', 'display', 'ordinary-text']) await t.test(mode, async (t) => {
    const f = await legacyFixture(t, mode === 'ordinary-text'
      ? { changeOriginal(sheet) { sheet.E2 = { t: 's', v: '#DIV/0!' }; } }
      : { changeAudit(audit) { audit.rows[0][mode === 'raw' ? 'rawValues' : 'displayValues'][4] = 'different'; } });
    await prepareReviewManifest(f);
    await assert.rejects(extractReviewSources(f), { code: 'vcc-review-validation-failed' });
  });
});

test('历史兼容仍拒绝主体、币种、部门、账期和余额错误，原件哈希损坏也失败', async (t) => {
  for (const header of ['主体', '币种', '业务部门', '账单日期', SYSTEM_OP_DEFINITION.balanceHeader]) await t.test(header, async (t) => {
    const f = await legacyFixture(t, { changeOriginal(sheet) {
      sheet[XLSX.utils.encode_col(SYSTEM_OP_DEFINITION.indexes[header]) + '2'] = { t: 'e', v: 7 };
    } });
    await prepareReviewManifest(f);
    await assert.rejects(extractReviewSources(f), { code: 'vcc-review-validation-failed' });
  });
  await t.test('hash', async (t) => {
    const f = await legacyFixture(t); await prepareReviewManifest(f);
    fs.appendFileSync(f.originalPath, 'corrupted');
    await assert.rejects(extractReviewSources(f), { code: 'archive-integrity-failure' });
  });
});

test('v2 系统 OP 原生错误按新审计严格核验，不能套用 v1 空审计兼容', async (t) => {
  const f = await createReviewFixture(t, { subjects: ['甲'], beforeImport(filePath) {
    const book = XLSX.readFile(filePath);
    for (let row = 2; row <= 10; row++) book.Sheets['系统 OP']['E' + row] = { t: 'e', v: 7 };
    XLSX.writeFile(book, filePath);
  } });
  const options = { ...f, appVersion: '3.2.9', manifestPath: path.join(f.dir, 'current.sqlite'), filePath: path.join(f.dir, 'current.xlsx') };
  await prepareReviewManifest(options); await extractReviewSources(options);
  await writeReviewWorkbook(options); await validateReviewWorkbook(options);
  const snapshot = f.db.prepare('SELECT * FROM vcc_fin_op_system_snapshots').get();
  const audit = JSON.parse(snapshot.raw_json);
  assert.equal(audit.rows[0].rawValues[4], '#DIV/0!');
  for (const row of audit.rows) { row.rawValues[4] = ''; row.displayValues[4] = ''; }
  f.db.prepare('UPDATE vcc_fin_op_system_snapshots SET raw_json=? WHERE id=?').run(JSON.stringify(audit), snapshot.id);
  const changed = { ...options, manifestPath: path.join(f.dir, 'changed.sqlite') };
  await prepareReviewManifest(changed);
  await assert.rejects(extractReviewSources(changed), { code: 'vcc-review-validation-failed' });
});
