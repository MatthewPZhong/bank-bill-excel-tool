const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const settingsRepo = require('../../../src/backend/database/settings-repository');
const {
  IMPORT_DIALOG_SCOPES,
  STAT_TIMEOUT_MS,
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

test.describe('IMPORT_DIALOG_SCOPES', () => {
  test('与 ALL_MODULE_IDS 对齐：模块 scope 全部来自 ALL_MODULE_IDS（排除 new-account-generator）', () => {
    const expectedModuleScopes = settingsRepo.ALL_MODULE_IDS.filter(
      (id) => id !== 'new-account-generator'
    );
    for (const scope of expectedModuleScopes) {
      assert.ok(IMPORT_DIALOG_SCOPES.includes(scope), `缺少模块 scope：${scope}`);
    }
    assert.ok(!IMPORT_DIALOG_SCOPES.includes('new-account-generator'));
  });

  test('bundle 导入使用独立 scope，与业务 xlsx 目录互不覆盖', () => {
    assert.ok(IMPORT_DIALOG_SCOPES.includes('bank-statement-process-bundle'));
    assert.ok(IMPORT_DIALOG_SCOPES.includes('template-bundle'));
    assert.ok(IMPORT_DIALOG_SCOPES.includes('pre-fund-reconciliation-export'));
  });
});

test.describe('resolveExistingDirectory', () => {
  test('存在目录返回绝对路径', async () => {
    const dir = path.join(tmpDir, 'a');
    fs.mkdirSync(dir);
    assert.equal(await resolveExistingDirectory(dir), dir);
  });

  test('文件、不存在路径、空值都返回 undefined', async () => {
    const file = path.join(tmpDir, 'file.xlsx');
    fs.writeFileSync(file, '');
    assert.equal(await resolveExistingDirectory(file), undefined);
    assert.equal(await resolveExistingDirectory(path.join(tmpDir, 'missing')), undefined);
    assert.equal(await resolveExistingDirectory(''), undefined);
  });

  test('stat 挂起（断连网络盘）时在超时上限内降级为 undefined，不阻塞', async () => {
    const originalStat = fs.promises.stat;
    fs.promises.stat = () => new Promise(() => {});
    try {
      const started = Date.now();
      const result = await resolveExistingDirectory(path.join(tmpDir, 'a'));
      const elapsed = Date.now() - started;
      assert.equal(result, undefined);
      assert.ok(
        elapsed < STAT_TIMEOUT_MS + 1000,
        `应在超时上限附近返回，实际耗时 ${elapsed}ms`
      );
    } finally {
      fs.promises.stat = originalStat;
    }
  });
});

test.describe('import dialog directory state', () => {
  test('首次导入无 defaultPath', async () => {
    assert.equal(await getImportDialogDefaultPath(db, 'bank-statement-process'), undefined);
  });

  test('选择文件后再次同 scope 使用文件所在目录', async () => {
    const dir = path.join(tmpDir, 'a');
    fs.mkdirSync(dir);
    rememberImportDialogDirectory(db, 'bank-statement-process', path.join(dir, 'file.xlsx'));
    assert.equal(await getImportDialogDefaultPath(db, 'bank-statement-process'), dir);
  });

  test('多选时取第一个文件目录', async () => {
    const dirA = path.join(tmpDir, 'a');
    const dirB = path.join(tmpDir, 'b');
    fs.mkdirSync(dirA);
    fs.mkdirSync(dirB);
    rememberImportDialogDirectory(db, 'bank-statement-process', [
      path.join(dirA, 'first.xlsx'),
      path.join(dirB, 'second.xlsx')
    ]);
    assert.equal(await getImportDialogDefaultPath(db, 'bank-statement-process'), dirA);
  });

  test('scoped 与 global 都失效时不传 defaultPath', async () => {
    settingsRepo.setLastImportDirectory(db, 'bank-statement-process', path.join(tmpDir, 'missing'));
    assert.equal(await getImportDialogDefaultPath(db, 'bank-statement-process'), undefined);
  });

  test('scoped 目录已删除而 global 仍有效时回落到 global', async () => {
    const aliveDir = path.join(tmpDir, 'alive');
    fs.mkdirSync(aliveDir);
    // 其它入口留下有效 global，目标 scope 的目录随后被删除
    settingsRepo.setLastImportDirectory(db, 'template', aliveDir);
    settingsRepo.setLastImportDirectory(db, 'bank-statement-process', path.join(tmpDir, 'gone'));
    settingsRepo.setSetting(db, settingsRepo.LAST_IMPORT_DIRECTORY_GLOBAL_KEY, aliveDir);
    assert.equal(await getImportDialogDefaultPath(db, 'bank-statement-process'), aliveDir);
  });

  test('settings 读取抛错时静默降级为无 defaultPath', async () => {
    const brokenDb = {
      prepare() { throw new Error('database is locked'); }
    };
    assert.equal(await getImportDialogDefaultPath(brokenDb, 'bank-statement-process'), undefined);
  });

  test('settings 写入抛错时不向上抛（选择结果不丢失）', () => {
    const brokenDb = {
      prepare() { throw new Error('disk I/O error'); }
    };
    assert.doesNotThrow(() => {
      rememberImportDialogDirectory(brokenDb, 'bank-statement-process', ['/some/file.xlsx']);
    });
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

  test('调用方显式传入 defaultPath 时记忆值不覆盖它', async () => {
    const rememberedDir = path.join(tmpDir, 'remembered');
    const explicitDir = path.join(tmpDir, 'explicit');
    fs.mkdirSync(rememberedDir);
    fs.mkdirSync(explicitDir);
    settingsRepo.setLastImportDirectory(db, 'bank-statement-process', rememberedDir);

    const calls = [];
    const fakeDialog = {
      async showOpenDialog(_browserWindow, options) {
        calls.push(options);
        return { canceled: true, filePaths: [] };
      }
    };

    await showImportOpenDialog({
      dialog: fakeDialog,
      browserWindow: {},
      db,
      scope: 'bank-statement-process',
      options: { properties: ['openFile'], defaultPath: explicitDir }
    });

    assert.equal(calls[0].defaultPath, explicitDir);
  });

  test('选择导出目录时记住所选目录本身，而不是其父目录', async () => {
    const selectedDir = path.join(tmpDir, 'exports');
    fs.mkdirSync(selectedDir);
    const fakeDialog = {
      showOpenDialog: async () => ({ canceled: false, filePaths: [selectedDir] })
    };
    await showImportOpenDialog({
      dialog: fakeDialog,
      browserWindow: null,
      db,
      scope: 'pre-fund-reconciliation-export',
      options: { properties: ['openDirectory', 'createDirectory'] }
    });
    assert.equal(
      await getImportDialogDefaultPath(db, 'pre-fund-reconciliation-export'),
      selectedDir
    );
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

    assert.equal(await getImportDialogDefaultPath(db, 'bank-statement-process'), bankDir);
    assert.equal(await getImportDialogDefaultPath(db, 'template'), templateDir);
    assert.equal(await getImportDialogDefaultPath(db, 'new-scope'), templateDir);
  });
});
