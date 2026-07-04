const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const settingsRepo = require('../../../src/backend/database/settings-repository');
const {
  resolveExistingDirectory,
  getImportDialogDefaultPath,
  rememberImportDialogDirectory,
  showImportOpenDialog
} = require('../../../src/main-process/import-dialog-state');

let tmpDir;
let db;

function setupDb() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS app_settings (
      setting_key TEXT PRIMARY KEY,
      setting_value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
}

test.beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'import-dialog-state-'));
  db = new DatabaseSync(path.join(tmpDir, 'test.sqlite'));
  setupDb();
});

test.afterEach(() => {
  if (db) { try { db.close(); } catch (_) {} db = null; }
  if (tmpDir) { fs.rmSync(tmpDir, { recursive: true, force: true }); tmpDir = null; }
});

test.describe('resolveExistingDirectory', () => {
  test('存在目录返回绝对路径', () => {
    const dir = path.join(tmpDir, 'a');
    fs.mkdirSync(dir);
    assert.equal(resolveExistingDirectory(dir), dir);
  });

  test('文件、不存在路径、空值都返回 undefined', () => {
    const file = path.join(tmpDir, 'file.xlsx');
    fs.writeFileSync(file, '');
    assert.equal(resolveExistingDirectory(file), undefined);
    assert.equal(resolveExistingDirectory(path.join(tmpDir, 'missing')), undefined);
    assert.equal(resolveExistingDirectory(''), undefined);
  });
});

test.describe('import dialog directory state', () => {
  test('首次导入无 defaultPath', () => {
    assert.equal(getImportDialogDefaultPath(db, 'bank-statement-process'), undefined);
  });

  test('选择文件后再次同 scope 使用文件所在目录', () => {
    const dir = path.join(tmpDir, 'a');
    fs.mkdirSync(dir);
    rememberImportDialogDirectory(db, 'bank-statement-process', path.join(dir, 'file.xlsx'));
    assert.equal(getImportDialogDefaultPath(db, 'bank-statement-process'), dir);
  });

  test('多选时取第一个文件目录', () => {
    const dirA = path.join(tmpDir, 'a');
    const dirB = path.join(tmpDir, 'b');
    fs.mkdirSync(dirA);
    fs.mkdirSync(dirB);
    rememberImportDialogDirectory(db, 'bank-statement-process', [
      path.join(dirA, 'first.xlsx'),
      path.join(dirB, 'second.xlsx')
    ]);
    assert.equal(getImportDialogDefaultPath(db, 'bank-statement-process'), dirA);
  });

  test('旧目录不存在时不传 defaultPath', () => {
    settingsRepo.setLastImportDirectory(db, 'bank-statement-process', path.join(tmpDir, 'missing'));
    assert.equal(getImportDialogDefaultPath(db, 'bank-statement-process'), undefined);
  });

  test('取消选择不覆盖旧目录', async () => {
    const dir = path.join(tmpDir, 'a');
    fs.mkdirSync(dir);
    settingsRepo.setLastImportDirectory(db, 'bank-statement-process', dir);

    const calls = [];
    const fakeDialog = {
      async showOpenDialog(_browserWindow, options) {
        calls.push(options);
        return { canceled: true, filePaths: [path.join(tmpDir, 'other.xlsx')] };
      }
    };

    const result = await showImportOpenDialog({
      dialog: fakeDialog,
      browserWindow: {},
      db,
      scope: 'bank-statement-process',
      options: { properties: ['openFile'] }
    });

    assert.equal(result.canceled, true);
    assert.equal(calls[0].defaultPath, dir);
    assert.equal(settingsRepo.getLastImportDirectory(db, 'bank-statement-process'), dir);
  });

  test('不同 scope 保留各自目录，未知 scope fallback 到 global', async () => {
    const bankDir = path.join(tmpDir, 'bank');
    const templateDir = path.join(tmpDir, 'template');
    fs.mkdirSync(bankDir);
    fs.mkdirSync(templateDir);

    const selectedPaths = [
      path.join(bankDir, 'file.xlsx'),
      path.join(templateDir, 'file.xlsx')
    ];
    const fakeDialog = {
      async showOpenDialog() {
        return { canceled: false, filePaths: [selectedPaths.shift()] };
      }
    };

    await showImportOpenDialog({
      dialog: fakeDialog,
      browserWindow: {},
      db,
      scope: 'bank-statement-process',
      options: { properties: ['openFile'] }
    });
    await showImportOpenDialog({
      dialog: fakeDialog,
      browserWindow: {},
      db,
      scope: 'template',
      options: { properties: ['openFile'] }
    });

    assert.equal(getImportDialogDefaultPath(db, 'bank-statement-process'), bankDir);
    assert.equal(getImportDialogDefaultPath(db, 'template'), templateDir);
    assert.equal(getImportDialogDefaultPath(db, 'new-scope'), templateDir);
  });
});
