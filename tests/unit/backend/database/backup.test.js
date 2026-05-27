const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const { createBackup, formatTimestamp } = require('../../../../src/backend/database/backup');

let tmpDir;
let srcDb;
let srcPath;

test.beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-test-'));
  srcPath = path.join(tmpDir, 'src.sqlite');
  srcDb = new DatabaseSync(srcPath);
  srcDb.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)');
  srcDb.exec("INSERT INTO t (name) VALUES ('hello'), ('world')");
});

test.afterEach(() => {
  if (srcDb) {
    try { srcDb.close(); } catch (_) {}
    srcDb = null;
  }
  if (tmpDir) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = null;
  }
});

test.describe('createBackup', () => {
  test('正常路径：生成完整备份 + 文件名含 label + timestamp', () => {
    const backupDir = path.join(tmpDir, 'backups');
    const destPath = createBackup(srcDb, 'pre-N5', backupDir);

    assert.ok(fs.existsSync(destPath));
    assert.match(path.basename(destPath), /^tool-data-bak-pre-N5-\d{8}T\d{6}\.sqlite$/);

    const backupDb = new DatabaseSync(destPath);
    const rows = backupDb.prepare('SELECT * FROM t').all();
    backupDb.close();
    assert.strictEqual(rows.length, 2);
    assert.strictEqual(rows[0].name, 'hello');
    assert.strictEqual(rows[1].name, 'world');
  });

  test('自动建 backupDir（recursive mkdir）', () => {
    const backupDir = path.join(tmpDir, 'deep', 'nested', 'backups');
    const destPath = createBackup(srcDb, 'test', backupDir);
    assert.ok(fs.existsSync(destPath));
    assert.ok(fs.existsSync(backupDir));
  });

  test('备份过程库可读 + 备份是 snapshot 不含后续写入', () => {
    const backupDir = path.join(tmpDir, 'backups');
    const destPath = createBackup(srcDb, 'snapshot', backupDir);
    // 备份完成后源库仍可写
    srcDb.exec("INSERT INTO t (name) VALUES ('after-backup')");
    const srcRows = srcDb.prepare('SELECT * FROM t').all();
    assert.strictEqual(srcRows.length, 3);
    // 备份文件不含 after-backup 行（备份时间点 snapshot）
    const backupDb = new DatabaseSync(destPath);
    const backupRows = backupDb.prepare('SELECT * FROM t').all();
    backupDb.close();
    assert.strictEqual(backupRows.length, 2);
  });

  test('label 校验：拒绝 SQL 注入字符', () => {
    const backupDir = path.join(tmpDir, 'backups');
    assert.throws(
      () => createBackup(srcDb, "pre-N5'; DROP TABLE t; --", backupDir),
      /label 必须仅含/
    );
  });

  test('label 校验：拒绝路径分隔符', () => {
    const backupDir = path.join(tmpDir, 'backups');
    assert.throws(
      () => createBackup(srcDb, 'pre/N5', backupDir),
      /label 必须仅含/
    );
  });

  test('label 校验：拒绝空字符串', () => {
    const backupDir = path.join(tmpDir, 'backups');
    assert.throws(
      () => createBackup(srcDb, '', backupDir),
      /label 必须仅含/
    );
  });

  test('label 校验：接受合法字符 [A-Za-z0-9_-]', () => {
    const backupDir = path.join(tmpDir, 'backups');
    const p1 = createBackup(srcDb, 'pre-N5_v2', backupDir);
    assert.ok(fs.existsSync(p1));
  });

  test('db 校验：拒绝 null', () => {
    assert.throws(
      () => createBackup(null, 'test', tmpDir),
      /db 必须是 DatabaseSync/
    );
  });

  test('db 校验：拒绝无 exec 方法对象', () => {
    assert.throws(
      () => createBackup({}, 'test', tmpDir),
      /db 必须是 DatabaseSync/
    );
  });

  test('backupDir 校验：缺失抛错', () => {
    assert.throws(() => createBackup(srcDb, 'test', ''), /缺少 backupDir/);
    assert.throws(() => createBackup(srcDb, 'test', null), /缺少 backupDir/);
    assert.throws(() => createBackup(srcDb, 'test', undefined), /缺少 backupDir/);
  });

  test('tmp 文件无残留：成功路径', () => {
    const backupDir = path.join(tmpDir, 'backups');
    createBackup(srcDb, 'test', backupDir);
    const tmpFiles = fs.readdirSync(backupDir).filter((f) => f.endsWith('.tmp'));
    assert.strictEqual(tmpFiles.length, 0);
  });

  test('tmp 文件清理：失败路径（mock db.exec 抛错）', () => {
    const fakeDb = {
      exec: () => { throw new Error('VACUUM failed (mock)'); }
    };
    const backupDir = path.join(tmpDir, 'backups');
    assert.throws(
      () => createBackup(fakeDb, 'test', backupDir),
      /createBackup 失败/
    );
    if (fs.existsSync(backupDir)) {
      const tmpFiles = fs.readdirSync(backupDir).filter((f) => f.endsWith('.tmp'));
      assert.strictEqual(tmpFiles.length, 0, 'tmp 文件不应残留');
    }
  });

  test('备份文件大小与库内容匹配', () => {
    // 写入较多数据让文件变大
    const stmt = srcDb.prepare('INSERT INTO t (name) VALUES (?)');
    for (let i = 0; i < 1000; i++) stmt.run(`row-${i}`);

    const backupDir = path.join(tmpDir, 'backups');
    const destPath = createBackup(srcDb, 'big', backupDir);
    const stat = fs.statSync(destPath);
    assert.ok(stat.size > 8192, '1002 行数据备份大小应 > 8KB');
  });
});

test.describe('formatTimestamp', () => {
  test('格式 YYYYMMDDTHHmmss', () => {
    const ts = formatTimestamp(new Date('2026-05-27T14:32:18'));
    assert.match(ts, /^\d{8}T\d{6}$/);
  });

  test('单数月/日/时/分/秒补零', () => {
    const ts = formatTimestamp(new Date(2026, 0, 5, 9, 8, 7));
    assert.ok(ts.endsWith('090807'), `expected to end with 090807, got ${ts}`);
    assert.ok(ts.startsWith('20260105'), `expected to start with 20260105, got ${ts}`);
  });

  test('默认参数 = 当前时间', () => {
    const ts = formatTimestamp();
    assert.match(ts, /^\d{8}T\d{6}$/);
  });
});
