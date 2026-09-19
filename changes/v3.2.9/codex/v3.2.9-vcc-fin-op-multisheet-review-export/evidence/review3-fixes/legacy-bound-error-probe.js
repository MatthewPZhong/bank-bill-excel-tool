'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const { execFileSync } = require('node:child_process');
const XLSX = require('xlsx');
const { createReviewFixture } = require('/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tests/helpers/vcc-review-export');
const repository = require('/Users/pzhong/Desktop/Project/bank-bill-excel-tool/src/backend/vcc-financial-op-db/repository');
const { hashSourceFileSync } = require('/Users/pzhong/Desktop/Project/bank-bill-excel-tool/src/backend/vcc-financial-op/source-lineage');
const { prepareReviewManifest, extractReviewSources } = require('/Users/pzhong/Desktop/Project/bank-bill-excel-tool/src/backend/vcc-financial-op/review-export-plan');

const baselineFile = path.join('/Users/pzhong/Desktop/Project/bank-bill-excel-tool', 'src/backend/vcc-financial-op/review3-baseline-system-op-importer.js');
const baselineModule = new Module(baselineFile, module);
baselineModule.filename = baselineFile;
baselineModule.paths = Module._nodeModulePaths(path.dirname(baselineFile));
baselineModule._compile(execFileSync('git', ['show', '2ba9ef14fe972363b604955636cff0c9ac53700f:src/backend/vcc-financial-op/system-op-importer.js'],
  { cwd: '/Users/pzhong/Desktop/Project/bank-bill-excel-tool', encoding: 'utf8' }), baselineFile);

test('legacy single-Sheet system error, bound v1 artifact, exact baseline raw audit should remain exportable', async (t) => {
  const f = await createReviewFixture(t, { subjects: ['甲'] });
  const oldFile = path.join(f.dir, 'legacy-system.xlsx');
  const book = XLSX.readFile(f.filePath);
  const sheet = book.Sheets['系统 OP'];
  for (let r = 2; r <= 10; r++) sheet['E' + r] = { t: 'e', v: 7 };
  const single = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(single, sheet, '系统 OP');
  XLSX.writeFile(single, oldFile);
  const candidates = baselineModule.exports.readSystemOpSnapshotCandidates(oldFile, '2026-06');
  assert.equal(candidates.validationErrors.length, 0);
  assert.equal(candidates.snapshots.length, 1);
  const legacy = candidates.snapshots[0];
  const fingerprint = hashSourceFileSync(oldFile);
  const id = 'review3-legacy-system';
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
  const existing = f.db.prepare('SELECT content_hash FROM vcc_fin_op_system_snapshots').get();
  assert.equal(existing.content_hash, legacy.contentHash);
  f.db.prepare('UPDATE vcc_fin_op_system_snapshots SET import_record_id=?,import_source_id=?,source_file=?,raw_json=?')
    .run(recordId, sourceId, legacy.sourceFile, legacy.rawJson);
  console.log('BASELINE_AUDIT', JSON.stringify({ validated: true, snapshotCount: candidates.snapshots.length,
    legacyRawE2: JSON.parse(legacy.rawJson).rows[0].rawValues[4], originalError: XLSX.readFile(oldFile).Sheets['系统 OP'].E2,
    contentHashEqual: existing.content_hash === legacy.contentHash, artifactVersion: 1, sourceSha256: fingerprint.sha256 }));
  const options = { ...f, appVersion: '3.2.9', manifestPath: path.join(f.dir, 'legacy-bound.sqlite') };
  await prepareReviewManifest(options);
  await extractReviewSources(options);
});
