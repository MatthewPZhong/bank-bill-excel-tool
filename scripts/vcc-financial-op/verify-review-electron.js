'use strict';

// Isolated Electron/ASAR + renderer→preload→IPC→Worker acceptance harness.
// Native save-dialog interaction and Windows/Excel/WPS remain manual acceptance.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../..');
const templateName = 'VCC财务OP校验结果表_模板.xlsx';
const pendingTemplateName = '移除归档Pending发生额计算表.xlsx';

async function electronRun(configPath) {
  const { app, BrowserWindow, ipcMain } = require('electron');
  const { DatabaseSync } = require('node:sqlite');
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  app.setPath('userData', path.join(config.directory, 'electron-user-data'));
  app.setPath('sessionData', path.join(config.directory, 'electron-session-data'));
  app.disableHardwareAcceleration();
  await app.whenReady();
  let db, service, window;
  try {
    assert.equal(process.versions.electron, '36.9.5');
    const loader = require('../../src/backend/vcc-financial-op/result-template-contract');
    const templatePath = path.join(config.assetsDir, 'VCC财务OP校验', templateName);
    const stats = [fs.statSync(templatePath), fs.statSync(templatePath)];
    const first = await loader.loadResultTemplateContract({ templatePath });
    const second = await loader.loadResultTemplateContract({ templatePath });
    assert.deepEqual(first, second);
    const corruptPath = path.join(config.directory, 'corrupt.xlsx');
    fs.writeFileSync(corruptPath, Buffer.concat([fs.readFileSync(templatePath), Buffer.from('tampered')]));
    await assert.rejects(loader.loadResultTemplateContract({ templatePath: corruptPath }), { code: 'result-template-contract-mismatch' });
    db = new DatabaseSync(config.dbPath);
    require('../../src/backend/vcc-financial-op-db/storage-contract').assertVccStorageContract(db);
    require('../../src/backend/vcc-financial-op-db/storage-contract').registerVccStorageWriteCapability(db);
    service = require('../../src/main-process/vcc-financial-op-service').createVccFinancialOpService({
      database: { db, dbPath: config.dbPath }, assetsDir: config.assetsDir, appVersion: '3.2.9',
      archiveServiceProvider: () => ({ rootDir: config.archiveRoot })
    });
    const savedPath = path.join(config.directory, '待确认表.xlsx');
    const handler = require('../../src/main-process/vcc-financial-op-review-ipc').createReviewExportHandler({
      getService: () => service, getWindow: () => window, documentsPath: config.directory,
      tempRoot: path.join(config.directory, 'review-temp'), protectedRoots: [config.archiveRoot],
      dialog: { async showSaveDialog(_window, options) {
        assert.equal(path.basename(options.defaultPath), '2026-06_VCC财务OP校验待确认表.xlsx');
        return { canceled: false, filePath: savedPath };
      } }
    });
    ipcMain.handle('vccFinancialOp:export:review', handler);
    window = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, sandbox: false,
      nodeIntegration: false, preload: path.join(root, 'src/preload.js') } });
    await window.loadURL('data:text/html,<html><body>VCC isolated acceptance</body></html>');
    const exported = await window.webContents.executeJavaScript(`window.desktopApi.vccFinancialOp.exportReviewTable(${JSON.stringify(config.request)})`);
    assert.equal(exported.status, 'success', JSON.stringify(exported)); assert.equal(exported.sheetCount, 15);
    assert.equal(exported.subjectCount, 2); assert.equal(exported.sourceRowCount, 14);
    assert.equal(db.prepare('SELECT status FROM vcc_fin_op_runs WHERE id=?').get(config.request.runId).status, 'calculated');
    require('../../src/backend/vcc-financial-op/calculator').archiveRun({
      db, runId: config.request.runId, expectedResultRevision: config.request.expectedResultRevision, appVersion: '3.2.9'
    });
    const formalWriter = require('../../src/main-process/vcc-financial-op-writer');
    const formalSubjects = formalWriter.loadEffectiveRunSubjectIndex(db, config.request.runId).subjects;
    const formal = await formalWriter.writeRunWorkbooks({
      db, runId: config.request.runId, assetsDir: config.assetsDir,
      outputPaths: formalSubjects.map((subject) => path.join(config.directory, `${subject}-正式结果.xlsx`))
    });
    assert.deepEqual([...formal.subjects].sort(), ['乙', '甲']);
    for (const filePath of formal.filePaths) {
      const book = new (require('exceljs').Workbook)(); await book.xlsx.readFile(filePath);
      assert.equal(book.worksheets[0].name, '财务OP校验结果表');
    }
    assert.equal(db.prepare('SELECT status FROM vcc_fin_op_runs WHERE id=?').get(config.request.runId).status, 'archived');
    const report = { date: new Date().toISOString(), platform: process.platform, electron: process.versions.electron,
      node: process.versions.node, exceljs: require('exceljs/package.json').version,
      asar: { path: templatePath, hash: loader.RESULT_TEMPLATE_FILE_SHA256, inodeBefore: stats[0].ino, inodeAfter: stats[1].ino,
        contentCachePassed: true, tamperRejected: true }, ipc: exported,
      formalExport: { status: 'success', subjects: formal.subjects, fileCount: formal.filePaths.length,
        templatesInsideAsar: true, statusAfterArchive: 'archived' },
      nativeDialog: 'stubbed', windowsExcelWps: 'not-run' };
    fs.writeFileSync(path.join(config.directory, 'electron-review-evidence.json'), `${JSON.stringify(report, null, 2)}\n`);
    console.log(JSON.stringify(report));
  } finally { window?.destroy(); await service?.terminate(); db?.close(); }
}

async function nodeRun() {
  const { createReviewFixture } = require('../../tests/helpers/vcc-review-export');
  const { createPackage } = require('@electron/asar');
  const { spawn } = require('node:child_process');
  const destination = path.resolve(process.argv[2] || path.join(root, 'changes/3.2.9/codex/v3.2.9-vcc-fin-op-multisheet-review-export/evidence'));
  fs.mkdirSync(destination, { recursive: true });
  let cleanup;
  const fixture = await createReviewFixture({ after(callback) { cleanup = callback; } });
  try {
    const packed = path.join(fixture.dir, 'package'); fs.mkdirSync(path.join(packed, 'assets', 'VCC财务OP校验'), { recursive: true });
    for (const name of [templateName, pendingTemplateName]) {
      fs.copyFileSync(path.join(fixture.assetsDir, 'VCC财务OP校验', name), path.join(packed, 'assets', 'VCC财务OP校验', name));
    }
    const asar = path.join(fixture.dir, 'app.asar'); await createPackage(packed, asar);
    const configPath = path.join(fixture.dir, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({ directory: fixture.dir, dbPath: fixture.dbPath, archiveRoot: fixture.archiveRoot,
      assetsDir: path.join(asar, 'assets'), request: fixture.request }));
    await new Promise((resolve, reject) => {
      const child = spawn(require('electron'), [__filename, '--electron-child', configPath], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
      let output = ''; const timer = setTimeout(() => { child.kill(); reject(new Error('Electron 验收超时')); }, 120000);
      child.stdout.on('data', (chunk) => { output += chunk; process.stdout.write(chunk); });
      child.stderr.on('data', (chunk) => { output += chunk; process.stderr.write(chunk); });
      child.once('error', (error) => { clearTimeout(timer); reject(error); });
      child.once('exit', (code) => {
        clearTimeout(timer); fs.writeFileSync(path.join(destination, 'electron-review.log'), output);
        code === 0 ? resolve() : reject(new Error(`Electron 验收失败：${code}`));
      });
    });
    for (const name of ['electron-review-evidence.json', '待确认表.xlsx', '甲-正式结果.xlsx', '乙-正式结果.xlsx']) {
      fs.copyFileSync(path.join(fixture.dir, name), path.join(destination, name));
    }
  } finally { cleanup(); }
}

if (process.versions.electron) electronRun(process.argv[process.argv.indexOf('--electron-child') + 1]).then(() => require('electron').app.exit(0), (error) => {
  console.error(error); require('electron').app.exit(1);
});
else nodeRun().catch((error) => { console.error(error); process.exitCode = 1; });
