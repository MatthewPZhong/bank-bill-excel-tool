const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { AppDatabase } = require('../../../../src/backend/database');

test('AppDatabase.close 释放连接、清空句柄并允许重复关闭和重新初始化', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'app-database-lifecycle-'));
  const dbPath = path.join(tmpDir, 'test.sqlite');
  const appDb = new AppDatabase(dbPath);

  try {
    appDb.init();
    appDb.db.exec('CREATE TABLE lifecycle_probe (value TEXT NOT NULL)');
    appDb.db.prepare('INSERT INTO lifecycle_probe (value) VALUES (?)').run('persisted');

    appDb.close();
    assert.equal(appDb.db, null);
    assert.doesNotThrow(() => appDb.close());

    appDb.init();
    assert.equal(
      appDb.db.prepare('SELECT value FROM lifecycle_probe').get().value,
      'persisted'
    );
    appDb.close();
    assert.equal(appDb.db, null);

    assert.doesNotThrow(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
  } finally {
    try { appDb.close(); } catch (_error) { /* best-effort test cleanup */ }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
