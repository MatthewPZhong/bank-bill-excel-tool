'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const reviewRoot = process.env.VCC_REVIEW_ROOT || process.cwd();
const XLSX = require('xlsx');
const { createReviewFixture } = require(path.join(reviewRoot, 'tests/helpers/vcc-review-export'));
const { createVccFinancialOpService } = require(path.join(reviewRoot, 'src/main-process/vcc-financial-op-service'));
const { createReviewExportHandler } = require(path.join(reviewRoot, 'src/main-process/vcc-financial-op-review-ipc'));

(async () => {
  for (const item of [
    { name: 'control', subject: '甲', expected: 'success' },
    { name: 'subject-CNH', subject: 'CNH', expected: 'error' },
    { name: 'formatted-system-subject', subject: '000123', expected: 'error', beforeImport(filePath) {
      const book = XLSX.readFile(filePath);
      for (let row = 2; row <= 10; row++) book.Sheets['系统 OP'][`B${row}`] = { t: 'n', v: 123, z: '000000' };
      XLSX.writeFile(book, filePath);
    } }
  ]) {
    const cleanups = [];
    let service;
    try {
      const f = await createReviewFixture({ after(fn) { cleanups.push(fn); } }, {
        subjects: [item.subject], beforeImport: item.beforeImport
      });
      assert.ok(f.imported.records.every((record) => record.status === 'success'));
      const output = path.join(f.dir, 'out.xlsx');
      fs.writeFileSync(output, 'previous user file');
      service = createVccFinancialOpService({ database: { db: f.db, dbPath: f.dbPath },
        assetsDir: f.assetsDir, appVersion: '3.2.9', archiveServiceProvider: () => ({ rootDir: f.archiveRoot }) });
      const handler = createReviewExportHandler({ getService: () => service, getWindow: () => null,
        documentsPath: f.dir, tempRoot: path.join(f.dir, 'tasks'), protectedRoots: [f.archiveRoot],
        dialog: { async showSaveDialog() { return { canceled: false, filePath: output }; } } });
      const response = await handler({ sender: { isDestroyed: () => false, send() {} } }, f.request);
      assert.equal(response.status, item.expected, JSON.stringify(response));
      if (item.expected === 'error') {
        assert.equal(response.code, 'vcc-review-validation-failed');
        assert.equal(fs.readFileSync(output, 'utf8'), 'previous user file');
      }
      assert.equal(f.db.prepare('SELECT status FROM vcc_fin_op_runs WHERE id=?').get(f.run.id).status, 'calculated');
      console.log(JSON.stringify({ scenario: item.name, imports: f.imported.records.map((r) => r.status),
        subject: item.subject, export: response, oldTargetPreserved: item.expected === 'error', resultStatus: 'calculated' }));
    } finally {
      await service?.terminate();
      for (const cleanup of cleanups) cleanup();
    }
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
