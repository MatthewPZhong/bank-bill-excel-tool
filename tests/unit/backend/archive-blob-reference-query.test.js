'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { createArchiveRepository } = require('../../../src/backend/database/archive-repository');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-blob-reference-query-'));
  const db = new DatabaseSync(path.join(root, 'archive.sqlite'));
  t.after(() => {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  db.exec('PRAGMA foreign_keys = ON');
  const repository = createArchiveRepository(db);
  repository.ensureSchema();
  let sequence = 0;
  function addArtifact({ moduleId = 'biz-op', status = 'ready', sha256 = 'a'.repeat(64) } = {}) {
    sequence += 1;
    const { batch } = repository.createBatch({
      moduleId, moduleCode: moduleId === 'biz-op' ? 'BIZOP' : 'OTHER', moduleName: '测试归档',
      operationKey: `operation-${sequence}`, localDate: '2026-09-20'
    });
    const artifact = repository.addArtifact(batch.id, {
      artifactKey: `artifact-${sequence}`, direction: 'input', role: 'source-file',
      originalName: 'source.xlsx', sourcePath: path.join(root, 'source.xlsx')
    });
    const completed = repository.completeArtifact(artifact.id, {
      sha256, sizeBytes: 4, relativePath: `blobs/sha256/${sha256}`,
      fingerprint: { sizeBytes: 4, mtimeMs: 1, ctimeMs: 1, ino: '1' }
    });
    // 直接设定历史状态，覆盖 blob 已关联但 artifact 尚非 ready 的引用。
    db.prepare('UPDATE archive_artifacts SET status=? WHERE id=?').run(status, artifact.id);
    return completed.artifact;
  }
  return { db, repository, addArtifact };
}

test('归档 Blob 存在性查询排除自身、无 Blob 和不存在的引用', (t) => {
  const { db, repository, addArtifact } = fixture(t);
  const selected = addArtifact();
  addArtifact({ sha256: 'b'.repeat(64) });
  assert.equal(repository.hasOtherArtifactForBlob(selected.blobId, selected.id), false);
  assert.equal(repository.hasOtherArtifactForBlob(null, selected.id), false);
  assert.equal(repository.hasOtherArtifactForBlob(999999, selected.id), false);
  // 查询不会把错误伪装成无引用。
  db.exec('DROP TABLE archive_artifacts');
  assert.throws(() => repository.hasOtherArtifactForBlob(selected.blobId, selected.id), /no such table/);
});

for (const status of ['ready', 'pending', 'failed']) {
  test(`归档 Blob 的其他 ${status} 引用跨 owner 保持原删除保护语义`, (t) => {
    const { db, repository, addArtifact } = fixture(t);
    const selected = addArtifact();
    const other = addArtifact({ moduleId: 'other-owner', status });
    const baseline = db.prepare('SELECT 1 FROM archive_artifacts WHERE blob_id=? AND id!=? LIMIT 1');
    for (const current of [selected, other]) {
      const actual = repository.hasOtherArtifactForBlob(current.blobId, current.id);
      assert.equal(typeof actual, 'boolean');
      assert.equal(actual, Boolean(baseline.get(current.blobId, current.id)));
      assert.equal(actual, true);
    }
    db.prepare('DELETE FROM archive_artifacts WHERE id=?').run(other.id);
    assert.equal(repository.hasOtherArtifactForBlob(selected.blobId, selected.id), false);
  });
}

test('大量 Blob 引用只进行 LIMIT 1 标量读取，不分配全量列表或开启事务', (t) => {
  const { db, addArtifact } = fixture(t);
  const selected = addArtifact();
  db.prepare(`
    WITH RECURSIVE refs(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM refs WHERE n<20000)
    INSERT INTO archive_artifacts (
      batch_id, artifact_key, direction, role, original_name, source_path, status, blob_id,
      created_at, updated_at
    ) SELECT ?, 'reference-' || n, 'input', 'source-file', 'source.xlsx', '/test/source.xlsx',
      'pending', ?, '2026-09-20', '2026-09-20' FROM refs
  `).run(selected.batchId, selected.blobId);
  const calls = [];
  const repository = createArchiveRepository({
    exec() { assert.fail('存在性查询不能执行写入或开启事务'); },
    prepare(sql) {
      const statement = db.prepare(sql);
      calls.push(sql.replace(/\s+/g, ' ').trim());
      return {
        get(...args) { return statement.get(...args); },
        all() { assert.fail('存在性查询不能物化完整引用列表'); },
        iterate() { assert.fail('存在性查询不能向调用方泄露引用迭代器'); },
        run() { assert.fail('存在性查询不能写入'); }
      };
    }
  });
  assert.equal(repository.hasOtherArtifactForBlob(selected.blobId, selected.id), true);
  assert.deepEqual(calls, ['SELECT 1 FROM archive_artifacts WHERE blob_id=? AND id!=? LIMIT 1']);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM archive_artifacts').get().count, 20001);
});
