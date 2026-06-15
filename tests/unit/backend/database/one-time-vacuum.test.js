// v3.0.5 PR-2（Part B Phase 0 / B-D6）：一次性 VACUUM 标志位幂等单测
//   覆盖：首跑执行 + 写标志、二跑跳过、磁盘不足跳过不写标志（diskCheck mock 注入）、失败不写标志。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { AppDatabase, ONE_TIME_VACUUM_FLAG_KEY } = require('../../../../src/backend/database');
const { getSetting } = require('../../../../src/backend/database/settings-repository');

let tmpDir;
let dbPath;
let appDb;

test.beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vacuum-test-'));
  dbPath = path.join(tmpDir, 'tool-data.sqlite');
  appDb = new AppDatabase(dbPath);
  appDb.init();
  // 制造空洞：写大量行后删除，使 freelist 非零（VACUUM 后文件应可观察到收缩或至少不崩）
  appDb.db.exec('CREATE TABLE IF NOT EXISTS bloat (id INTEGER PRIMARY KEY, payload TEXT)');
  const stmt = appDb.db.prepare('INSERT INTO bloat (payload) VALUES (?)');
  for (let i = 0; i < 5000; i++) stmt.run('x'.repeat(200));
  appDb.db.exec('DELETE FROM bloat');
});

test.afterEach(() => {
  if (appDb && appDb.db) {
    try { appDb.db.close(); } catch (_) {}
    appDb = null;
  }
  if (tmpDir) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = null;
  }
});

test.describe('runOneTimeVacuumIfNeeded', () => {
  test('首跑：执行 VACUUM + 写标志位', () => {
    // init() 链尾已自动跑过一次 VACUUM 并写标志 → 先清掉标志模拟「升级首启」
    appDb.db
      .prepare('DELETE FROM app_settings WHERE setting_key = ?')
      .run(ONE_TIME_VACUUM_FLAG_KEY);
    assert.strictEqual(getSetting(appDb.db, ONE_TIME_VACUUM_FLAG_KEY), null);

    const result = appDb.runOneTimeVacuumIfNeeded({ diskCheck: () => 10 * 1024 * 1024 * 1024 });
    assert.strictEqual(result.status, 'vacuumed');
    assert.ok(result.sizeBefore >= 0);
    assert.ok(result.sizeAfter >= 0);
    assert.ok(typeof result.durationMs === 'number');
    // 标志位已写
    assert.strictEqual(getSetting(appDb.db, ONE_TIME_VACUUM_FLAG_KEY), '1');
  });

  test('二跑：标志位已存在 → 跳过（already-done）', () => {
    // init() 已写过标志位；不清，直接二跑
    assert.strictEqual(getSetting(appDb.db, ONE_TIME_VACUUM_FLAG_KEY), '1');
    const result = appDb.runOneTimeVacuumIfNeeded({ diskCheck: () => 10 * 1024 * 1024 * 1024 });
    assert.strictEqual(result.status, 'already-done');
  });

  test('磁盘不足：跳过 + 不写标志位（下次重试）', () => {
    appDb.db
      .prepare('DELETE FROM app_settings WHERE setting_key = ?')
      .run(ONE_TIME_VACUUM_FLAG_KEY);
    assert.strictEqual(getSetting(appDb.db, ONE_TIME_VACUUM_FLAG_KEY), null);

    // mock 磁盘剩余 0 字节 → 必然 < DB 大小 × 1.2
    const result = appDb.runOneTimeVacuumIfNeeded({ diskCheck: () => 0 });
    assert.strictEqual(result.status, 'insufficient-disk');
    assert.ok(result.requiredFree >= 0);
    assert.strictEqual(result.freeBytes, 0);
    // 标志位仍未写 → 下次启动会重试
    assert.strictEqual(getSetting(appDb.db, ONE_TIME_VACUUM_FLAG_KEY), null);
  });

  test('磁盘刚好达标（= DB×1.2）：执行 + 写标志', () => {
    appDb.db
      .prepare('DELETE FROM app_settings WHERE setting_key = ?')
      .run(ONE_TIME_VACUUM_FLAG_KEY);
    const sizeBefore = fs.statSync(dbPath).size;
    const required = Math.ceil(sizeBefore * 1.2);
    const result = appDb.runOneTimeVacuumIfNeeded({ diskCheck: () => required });
    assert.strictEqual(result.status, 'vacuumed');
    assert.strictEqual(getSetting(appDb.db, ONE_TIME_VACUUM_FLAG_KEY), '1');
  });

  test('磁盘检查抛错：fail-open 放行 + 执行 + 写标志', () => {
    appDb.db
      .prepare('DELETE FROM app_settings WHERE setting_key = ?')
      .run(ONE_TIME_VACUUM_FLAG_KEY);
    const result = appDb.runOneTimeVacuumIfNeeded({
      diskCheck: () => { throw new Error('statfs failed (mock)'); }
    });
    assert.strictEqual(result.status, 'vacuumed');
    assert.strictEqual(getSetting(appDb.db, ONE_TIME_VACUUM_FLAG_KEY), '1');
  });

  test('磁盘略低于阈值：跳过 + 不写标志', () => {
    appDb.db
      .prepare('DELETE FROM app_settings WHERE setting_key = ?')
      .run(ONE_TIME_VACUUM_FLAG_KEY);
    const sizeBefore = fs.statSync(dbPath).size;
    const required = Math.ceil(sizeBefore * 1.2);
    const result = appDb.runOneTimeVacuumIfNeeded({ diskCheck: () => required - 1 });
    assert.strictEqual(result.status, 'insufficient-disk');
    assert.strictEqual(getSetting(appDb.db, ONE_TIME_VACUUM_FLAG_KEY), null);
  });

  test('幂等：第二次实跑（同进程）直接 already-done 不重复 VACUUM', () => {
    appDb.db
      .prepare('DELETE FROM app_settings WHERE setting_key = ?')
      .run(ONE_TIME_VACUUM_FLAG_KEY);
    const r1 = appDb.runOneTimeVacuumIfNeeded({ diskCheck: () => 10 * 1024 * 1024 * 1024 });
    assert.strictEqual(r1.status, 'vacuumed');
    const r2 = appDb.runOneTimeVacuumIfNeeded({ diskCheck: () => 10 * 1024 * 1024 * 1024 });
    assert.strictEqual(r2.status, 'already-done');
  });
});
