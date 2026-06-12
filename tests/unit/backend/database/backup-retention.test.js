// v3.0.5 PR-2（Part B Phase 0 / B-D8）：备份保留策略纯函数单测
//   覆盖：不足 2 份不删、恰好 2 份不删、混合两类格式合并排序、未知文件不动、wal/shm 绝不入选。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  isManagedBackupFile,
  selectBackupsToDelete,
  collectManagedBackupEntries,
} = require('../../../../src/backend/database/backup-retention');

// 构造元数据条目辅助
function entry(fileName, mtimeMs, size = 1024) {
  return { filePath: path.join('/fake', fileName), fileName, mtimeMs, size };
}

test.describe('isManagedBackupFile（白名单）', () => {
  test('新格式 backups 文件命中', () => {
    assert.strictEqual(isManagedBackupFile('tool-data-bak-pre-N5-20260608T143000.sqlite'), true);
    assert.strictEqual(isManagedBackupFile('tool-data-bak-pre-N4-cont-2-20260101T000000.sqlite'), true);
  });

  test('根目录旧格式命中', () => {
    assert.strictEqual(isManagedBackupFile('tool-data.sqlite.bak-20260608'), true);
    assert.strictEqual(isManagedBackupFile('tool-data.sqlite.bak-20260605'), true);
  });

  test('主库本体绝不命中', () => {
    assert.strictEqual(isManagedBackupFile('tool-data.sqlite'), false);
    assert.strictEqual(isManagedBackupFile('tool-data-pending.sqlite'), false);
  });

  test('WAL / SHM 旁文件绝不命中', () => {
    assert.strictEqual(isManagedBackupFile('tool-data.sqlite-wal'), false);
    assert.strictEqual(isManagedBackupFile('tool-data.sqlite-shm'), false);
    assert.strictEqual(isManagedBackupFile('tool-data-pending.sqlite-wal'), false);
    assert.strictEqual(isManagedBackupFile('tool-data-pending.sqlite-shm'), false);
  });

  test('未知文件不命中', () => {
    assert.strictEqual(isManagedBackupFile('random.txt'), false);
    assert.strictEqual(isManagedBackupFile('tool-data.sqlite.tmp'), false);
    assert.strictEqual(isManagedBackupFile('backup.sqlite'), false);
    assert.strictEqual(isManagedBackupFile(''), false);
    assert.strictEqual(isManagedBackupFile(null), false);
    assert.strictEqual(isManagedBackupFile(undefined), false);
  });
});

test.describe('selectBackupsToDelete（纯函数）', () => {
  test('不足 2 份（1 份）不删', () => {
    const result = selectBackupsToDelete([entry('tool-data-bak-a-20260101T000000.sqlite', 100)]);
    assert.deepStrictEqual(result, []);
  });

  test('0 份不删', () => {
    assert.deepStrictEqual(selectBackupsToDelete([]), []);
    assert.deepStrictEqual(selectBackupsToDelete(null), []);
  });

  test('恰好 2 份不删', () => {
    const result = selectBackupsToDelete([
      entry('tool-data-bak-a-20260101T000000.sqlite', 100),
      entry('tool-data-bak-b-20260102T000000.sqlite', 200),
    ]);
    assert.deepStrictEqual(result, []);
  });

  test('3 份保留最近 2 份，删最旧 1 份', () => {
    const result = selectBackupsToDelete([
      entry('old.placeholder-A.sqlite', 0), // 故意混入未知文件验证不被计入
      entry('tool-data-bak-a-20260101T000000.sqlite', 100),
      entry('tool-data-bak-b-20260102T000000.sqlite', 200),
      entry('tool-data-bak-c-20260103T000000.sqlite', 300),
    ]);
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].fileName, 'tool-data-bak-a-20260101T000000.sqlite');
  });

  test('混合两类格式合并为一个池子按 mtime 排序', () => {
    // 新格式 mtime 100/400；旧格式 mtime 200/300。保留最新 2（mtime 400 + 300），删最旧 2（100 + 200）。
    const result = selectBackupsToDelete([
      entry('tool-data-bak-new1-20260101T000000.sqlite', 100),
      entry('tool-data.sqlite.bak-20260102', 200),
      entry('tool-data.sqlite.bak-20260103', 300),
      entry('tool-data-bak-new2-20260104T000000.sqlite', 400),
    ]);
    const deletedNames = result.map((e) => e.fileName).sort();
    assert.deepStrictEqual(deletedNames, [
      'tool-data-bak-new1-20260101T000000.sqlite',
      'tool-data.sqlite.bak-20260102',
    ]);
  });

  test('未知文件不入待删清单（即使数量多）', () => {
    const result = selectBackupsToDelete([
      entry('random.txt', 1),
      entry('app_activity_log.txt', 2),
      entry('tool-data.sqlite', 3),
      entry('tool-data.sqlite-wal', 4),
      entry('tool-data.sqlite-shm', 5),
      entry('tool-data-pending.sqlite', 6),
    ]);
    assert.deepStrictEqual(result, []);
  });

  test('WAL/SHM/本体绝不入选（即便混在大量备份中）', () => {
    const result = selectBackupsToDelete([
      entry('tool-data.sqlite', 9999),         // 本体 mtime 最大，但绝不入选
      entry('tool-data.sqlite-wal', 9998),
      entry('tool-data.sqlite-shm', 9997),
      entry('tool-data-pending.sqlite', 9996),
      entry('tool-data-bak-a-20260101T000000.sqlite', 100),
      entry('tool-data-bak-b-20260102T000000.sqlite', 200),
      entry('tool-data-bak-c-20260103T000000.sqlite', 300),
    ]);
    // 仅 3 份真备份参与，保留 2 删 1（最旧 a）；本体/旁文件全不出现
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].fileName, 'tool-data-bak-a-20260101T000000.sqlite');
    const names = result.map((e) => e.fileName);
    assert.ok(!names.includes('tool-data.sqlite'));
    assert.ok(!names.includes('tool-data.sqlite-wal'));
    assert.ok(!names.includes('tool-data.sqlite-shm'));
    assert.ok(!names.includes('tool-data-pending.sqlite'));
  });

  test('keep 参数可配（keep=1 时 3 份删 2）', () => {
    const result = selectBackupsToDelete(
      [
        entry('tool-data-bak-a-20260101T000000.sqlite', 100),
        entry('tool-data-bak-b-20260102T000000.sqlite', 200),
        entry('tool-data-bak-c-20260103T000000.sqlite', 300),
      ],
      { keep: 1 }
    );
    assert.strictEqual(result.length, 2);
    const names = result.map((e) => e.fileName).sort();
    assert.deepStrictEqual(names, [
      'tool-data-bak-a-20260101T000000.sqlite',
      'tool-data-bak-b-20260102T000000.sqlite',
    ]);
  });
});

test.describe('collectManagedBackupEntries（真实临时目录扫描）', () => {
  let tmpDir;
  let userDataDir;
  let backupsDir;

  test.beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-retention-test-'));
    userDataDir = path.join(tmpDir, 'userData');
    backupsDir = path.join(userDataDir, 'backups');
    fs.mkdirSync(backupsDir, { recursive: true });
  });

  test.afterEach(() => {
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = null;
    }
  });

  test('合并 backups/ 与根目录旧格式，过滤本体与旁文件与未知文件', () => {
    // backups/ 下：2 个新格式备份
    fs.writeFileSync(path.join(backupsDir, 'tool-data-bak-pre-N5-20260101T000000.sqlite'), 'b1');
    fs.writeFileSync(path.join(backupsDir, 'tool-data-bak-pre-N4-20260102T000000.sqlite'), 'b2');
    // 根目录：1 个旧格式备份 + 主库本体 + 旁文件 + 未知文件
    fs.writeFileSync(path.join(userDataDir, 'tool-data.sqlite.bak-20260103'), 'b3');
    fs.writeFileSync(path.join(userDataDir, 'tool-data.sqlite'), 'main-db');
    fs.writeFileSync(path.join(userDataDir, 'tool-data.sqlite-wal'), 'wal');
    fs.writeFileSync(path.join(userDataDir, 'tool-data.sqlite-shm'), 'shm');
    fs.writeFileSync(path.join(userDataDir, 'tool-data-pending.sqlite'), 'pending');
    fs.writeFileSync(path.join(userDataDir, 'README.txt'), 'unknown');

    const entries = collectManagedBackupEntries({ backupsDir, rootDir: userDataDir });
    const names = entries.map((e) => e.fileName).sort();
    assert.deepStrictEqual(names, [
      'tool-data-bak-pre-N4-20260102T000000.sqlite',
      'tool-data-bak-pre-N5-20260101T000000.sqlite',
      'tool-data.sqlite.bak-20260103',
    ]);
    // 每条带 mtimeMs / size 元数据
    for (const e of entries) {
      assert.strictEqual(typeof e.mtimeMs, 'number');
      assert.ok(e.size >= 0);
      assert.ok(fs.existsSync(e.filePath));
    }
  });

  test('目录不存在时不抛错（返回空数组）', () => {
    const entries = collectManagedBackupEntries({
      backupsDir: path.join(tmpDir, 'no-such-backups'),
      rootDir: path.join(tmpDir, 'no-such-root'),
    });
    assert.deepStrictEqual(entries, []);
  });

  test('端到端：扫描 + 选取 + 真实删除只删最旧、保留最近 2 份、不动本体与旁文件', () => {
    // 造 3 个新格式备份（用真实 mtime 区分），+ 本体/旁文件
    const f1 = path.join(backupsDir, 'tool-data-bak-a-20260101T000000.sqlite');
    const f2 = path.join(backupsDir, 'tool-data-bak-b-20260102T000000.sqlite');
    const f3 = path.join(userDataDir, 'tool-data.sqlite.bak-20260103');
    fs.writeFileSync(f1, 'a');
    fs.writeFileSync(f2, 'b');
    fs.writeFileSync(f3, 'c');
    // 显式设置递增 mtime（f1 最旧 → f3 最新）
    fs.utimesSync(f1, new Date('2026-01-01T00:00:00Z'), new Date('2026-01-01T00:00:00Z'));
    fs.utimesSync(f2, new Date('2026-01-02T00:00:00Z'), new Date('2026-01-02T00:00:00Z'));
    fs.utimesSync(f3, new Date('2026-01-03T00:00:00Z'), new Date('2026-01-03T00:00:00Z'));
    const mainDb = path.join(userDataDir, 'tool-data.sqlite');
    const wal = path.join(userDataDir, 'tool-data.sqlite-wal');
    fs.writeFileSync(mainDb, 'main');
    fs.writeFileSync(wal, 'wal');

    const entries = collectManagedBackupEntries({ backupsDir, rootDir: userDataDir });
    const toDelete = selectBackupsToDelete(entries, { keep: 2 });
    assert.strictEqual(toDelete.length, 1);
    assert.strictEqual(toDelete[0].fileName, 'tool-data-bak-a-20260101T000000.sqlite');

    for (const e of toDelete) fs.unlinkSync(e.filePath);

    assert.ok(!fs.existsSync(f1), 'f1（最旧）应被删');
    assert.ok(fs.existsSync(f2), 'f2 应保留');
    assert.ok(fs.existsSync(f3), 'f3 应保留');
    assert.ok(fs.existsSync(mainDb), '主库本体绝不删');
    assert.ok(fs.existsSync(wal), 'WAL 旁文件绝不删');
  });
});
