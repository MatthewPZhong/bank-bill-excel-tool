'use strict';
const { readIdentityStatSync } = require('../../../src/main-process/archive-center/filesystem-identity');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { createArchiveService } = require('../../../src/main-process/archive-center/archive-service');

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'permanent-delete-'));
  const db = new DatabaseSync(path.join(dir, 'archive.sqlite'));
  db.exec('PRAGMA foreign_keys=ON');
  const state = { blocked: false, target: '', afterUnlink: null };
  const fsImpl = { ...fs, promises: fs.promises, unlinkSync(file) {
    if (state.blocked && (!state.target || state.target === file)) {
      const error = new Error('模拟文件占用'); error.code = state.code || 'EBUSY'; throw error;
    }
    fs.unlinkSync(file);
    if (state.afterUnlink) state.afterUnlink(file);
  } };
  const rootDir = path.join(dir, 'archive');
  const create = () => createArchiveService({ database: db, rootDir, fsImpl });
  const service = create();
  return { dir, db, state, rootDir, service, create, close() {
    db.close(); fs.rmSync(dir, { recursive: true, force: true });
  } };
}
async function archive(f, key, content = key, moduleId = 'bank-statement') {
  const source = path.join(f.dir, `${key}.xlsx`); fs.writeFileSync(source, content);
  const result = await f.service.archiveFile({ moduleId, moduleCode: 'TEST', moduleName: '测试模块',
    operationKey: key, filePath: source, role: 'output' });
  assert.equal(result.ok, true, JSON.stringify(result));
  return { ...result, source, artifact: f.service.repository.getArtifact(result.artifact.id) };
}

test('受管原件、输出与已打开只读副本实际清理，外部源/另存文件不变；响应丢失可查完成凭证', async () => {
  const f = fixture();
  try {
    const a = await archive(f, 'managed-all');
    const opened = await f.service.openReadonlyCopy(a.artifact.id);
    assert.equal(opened.ok, true, JSON.stringify(opened));
    const savePath = path.join(f.dir, 'saved.xlsx');
    assert.equal((await f.service.saveAs(a.artifact.id, savePath)).ok, true);
    const before = f.db.prepare('SELECT COUNT(*) n FROM archive_cleanup_jobs').get().n;
    const prepared = await f.service.prepareDeleteBatch(a.batch.id);
    assert.equal(prepared.ok, true, JSON.stringify(prepared));
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM archive_cleanup_jobs').get().n, before);
    assert.ok(fs.existsSync(opened.filePath));
    const deleted = await f.service.deleteBatch(a.batch.id, { expectedRevision: prepared.revision });
    assert.equal(deleted.fullyDeleted, true, JSON.stringify(deleted));
    for (const file of [opened.filePath, path.join(f.rootDir, a.artifact.storageRelativePath),
      path.join(f.rootDir, a.artifact.blob.relativePath)]) assert.equal(fs.existsSync(file), false);
    assert.equal(fs.readFileSync(a.source, 'utf8'), 'managed-all');
    assert.equal(fs.readFileSync(savePath, 'utf8'), 'managed-all');
    assert.equal(f.service.repository.getBatch(a.batch.id), null);
    assert.equal(f.service.repository.listCleanupJobs().length, 0);
    const again = await f.service.deleteBatch(a.batch.id);
    assert.equal(again.fullyDeleted, true);
    assert.equal(again.deletionId, deleted.deletionId);
    assert.equal((await f.service.deleteBatch(987654)).fullyDeleted, undefined);
  } finally { f.close(); }
});

test('多个模块共用永久删除；共享 Blob 最后一个引用释放后才删除', async () => {
  const f = fixture();
  try {
    const first = await archive(f, 'shared-bank', 'shared', 'bank-statement');
    const second = await archive(f, 'shared-toolbox', 'shared', 'toolbox');
    const blob = path.join(f.rootDir, first.artifact.blob.relativePath);
    assert.equal((await f.service.deleteBatch(first.batch.id)).fullyDeleted, true);
    assert.equal(fs.readFileSync(blob, 'utf8'), 'shared');
    assert.ok((await f.service.getBatch(second.batch.id)).ok);
    assert.equal((await f.service.deleteBatch(second.batch.id)).fullyDeleted, true);
    assert.equal(fs.existsSync(blob), false);
  } finally { f.close(); }
});

test('文件占用保留可见清理任务，重启重试实际完成且不重新生成批次', async () => {
  const f = fixture();
  try {
    const a = await archive(f, 'busy-retry');
    f.state.blocked = true;
    const deleted = await f.service.deleteBatch(a.batch.id);
    assert.equal(deleted.ok, false);
    assert.equal(deleted.metadataDeleted, true);
    assert.equal(deleted.fullyDeleted, false);
    assert.ok(deleted.cleanupJobId);
    const jobs = await f.service.listDeleteCleanupJobs();
    assert.equal(jobs.jobs[0].cleanupJobId, deleted.cleanupJobId);
    f.state.blocked = false;
    const restarted = f.create();
    await restarted.initialize({ deferStartupRecovery: true });
    const result = await restarted.retryDeleteCleanupJob(deleted.cleanupJobId);
    assert.equal(result.fullyDeleted, true, JSON.stringify(result));
    assert.equal(restarted.repository.getBatch(a.batch.id), null);
    assert.equal(restarted.repository.listCleanupJobs().length, 0);
  } finally { f.close(); }
});

test('重试时同路径替代文件保留，不能把新对象删除后宣告成功', async () => {
  const f = fixture();
  try {
    const a = await archive(f, 'replacement');
    const target = path.join(f.rootDir, a.artifact.storageRelativePath);
    f.state.blocked = true; f.state.target = target;
    const pending = await f.service.deleteBatch(a.batch.id);
    assert.equal(pending.fullyDeleted, false);
    fs.unlinkSync(target); fs.writeFileSync(target, 'unrelated replacement');
    f.state.blocked = false;
    const retried = await f.service.retryDeleteCleanupJob(pending.cleanupJobId);
    assert.equal(retried.fullyDeleted, false);
    assert.equal(fs.readFileSync(target, 'utf8'), 'unrelated replacement');
    assert.equal(f.service.repository.listCleanupJobs().length, 1);
  } finally { f.close(); }
});

test('预检后状态变化使确认失效；提交前 owner 复核失败时元数据和文件完整', async () => {
  const f = fixture();
  try {
    const a = await archive(f, 'stale-token');
    const prepared = await f.service.prepareDeleteBatch(a.batch.id);
    await f.service.setRetention(a.batch.id, { retentionDays: 90 });
    assert.equal((await f.service.deleteBatch(a.batch.id, { expectedRevision: prepared.revision })).code,
      'ARCHIVE_DELETE_CONFIRMATION_STALE');
    const ownerFailure = await f.service.deleteBatch(a.batch.id, { assertOwnerReady() {
      const error = new Error('owner 终态待收口'); error.code = 'ARCHIVE_DELETE_OWNER_PENDING'; throw error;
    } });
    assert.equal(ownerFailure.ok, false);
    assert.ok(f.service.repository.getBatch(a.batch.id));
    assert.ok(fs.existsSync(path.join(f.rootDir, a.artifact.blob.relativePath)));
    assert.equal(f.service.repository.listCleanupJobs().length, 0);
  } finally { f.close(); }
});

test('存档盘离线不等于文件已经删除；重新上线按原身份重试', async () => {
  const f = fixture();
  try {
    const a = await archive(f, 'offline');
    f.state.blocked = true;
    const pending = await f.service.deleteBatch(a.batch.id);
    const offline = `${f.rootDir}-offline`; fs.renameSync(f.rootDir, offline);
    const retry = await f.service.retryDeleteCleanupJob(pending.cleanupJobId);
    assert.equal(retry.fullyDeleted, false);
    assert.equal(retry.code, 'ARCHIVE_STORAGE_ROOT_UNAVAILABLE');
    assert.equal(f.service.repository.listCleanupJobs().length, 1);
    fs.renameSync(offline, f.rootDir); f.state.blocked = false;
    assert.equal((await f.service.retryDeleteCleanupJob(pending.cleanupJobId)).fullyDeleted, true);
  } finally { f.close(); }
});

test('清理计划提交失败回滚所有元数据与引用，文件不受影响', async () => {
  const f = fixture();
  try {
    const a = await archive(f, 'transaction');
    f.db.exec(`CREATE TRIGGER reject_delete_plan BEFORE INSERT ON archive_cleanup_jobs
      BEGIN SELECT RAISE(ABORT, 'injected'); END;`);
    const failed = await f.service.deleteBatch(a.batch.id);
    assert.equal(failed.ok, false);
    assert.ok(f.service.repository.getBatch(a.batch.id));
    assert.ok(f.service.repository.getArtifact(a.artifact.id));
    assert.ok(fs.existsSync(path.join(f.rootDir, a.artifact.blob.relativePath)));
    assert.equal(f.service.repository.listCleanupJobs().length, 0);
  } finally { f.close(); }
});

test('旧计划损坏与未知版本不转为空清单，不产生完成凭证', async () => {
  const f = fixture();
  try {
    const a = await archive(f, 'bad-plan');
    f.state.blocked = true;
    const pending = await f.service.deleteBatch(a.batch.id);
    f.db.prepare('UPDATE archive_cleanup_jobs SET plan_json = ? WHERE id = ?').run('{broken', pending.cleanupJobId);
    f.state.blocked = false;
    const retry = await f.service.retryDeleteCleanupJob(pending.cleanupJobId);
    assert.equal(retry.fullyDeleted, false);
    assert.equal(f.service.repository.getDeletionReceipt(a.batch.id), null);
    assert.ok(fs.existsSync(path.join(f.rootDir, a.artifact.blob.relativePath)));
  } finally { f.close(); }
});

test('登记为不存在的只读临时路径出现新对象时拒绝删除', async () => {
  const f = fixture();
  try {
    const a = await archive(f, 'absent-owner');
    const opened = await f.service.openReadonlyCopy(a.artifact.id);
    assert.equal(opened.ok, true);
    fs.writeFileSync(`${opened.filePath}.tmp`, 'unknown');
    const result = await f.service.deleteBatch(a.batch.id);
    assert.equal(result.ok, false);
    assert.equal(fs.readFileSync(`${opened.filePath}.tmp`, 'utf8'), 'unknown');
    assert.ok(f.service.repository.getBatch(a.batch.id));
  } finally { f.close(); }
});

test('并发重试共享同一完成结果，不用过期 job 再次报未完成', async () => {
  const f = fixture();
  try {
    const a = await archive(f, 'parallel-retry'); f.state.blocked = true;
    const pending = await f.service.deleteBatch(a.batch.id); f.state.blocked = false;
    const results = await Promise.all([f.service.retryDeleteCleanupJob(pending.cleanupJobId),
      f.service.retryDeleteCleanupJob(pending.cleanupJobId)]);
    assert.ok(results.every((result) => result.fullyDeleted === true), JSON.stringify(results));
    assert.equal(results[0].deletionId, results[1].deletionId);
  } finally { f.close(); }
});

test('物理删除后进度写入失败，原持久计划可按缺失对象恢复', async () => {
  const f = fixture();
  try {
    const a = await archive(f, 'progress-crash');
    const original = f.service.repository.updateCleanupJobProgress.bind(f.service.repository);
    let injected = false;
    f.service.repository.updateCleanupJobProgress = (...args) => {
      if (!injected) { injected = true; throw new Error('进度提交中断'); }
      return original(...args);
    };
    const failed = await f.service.deleteBatch(a.batch.id);
    assert.equal(failed.metadataDeleted, true); assert.equal(failed.fullyDeleted, false);
    f.service.repository.updateCleanupJobProgress = original;
    const retried = await f.service.retryDeleteCleanupJob(failed.cleanupJobId);
    assert.equal(retried.fullyDeleted, true, JSON.stringify(retried));
  } finally { f.close(); }
});

test('旧计划缺少历史对象身份时保留文件和诊断，即使同路径内容相同', async () => {
  const f = fixture();
  try {
    const a = await archive(f, 'legacy-replaced');
    const old = f.service.repository.deleteBatch(a.batch.id).cleanupJob;
    const target = path.join(f.rootDir, a.artifact.storageRelativePath);
    fs.unlinkSync(target); fs.writeFileSync(target, 'legacy-replaced');
    const result = await f.service.retryDeleteCleanupJob(old.id);
    assert.equal(result.fullyDeleted, false);
    assert.equal(result.failures[0].code, 'ARCHIVE_DELETE_LEGACY_IDENTITY_MISSING');
    assert.equal(fs.readFileSync(target, 'utf8'), 'legacy-replaced');
    assert.equal(f.service.repository.getDeletionReceipt(a.batch.id), null);
  } finally { f.close(); }
});

test('旧计划原目标均已缺失时按原范围升级，并发重试返回同一完成身份', async () => {
  const f = fixture();
  try {
    const a = await archive(f, 'legacy-missing');
    const old = f.service.repository.deleteBatch(a.batch.id).cleanupJob;
    fs.unlinkSync(path.join(f.rootDir, a.artifact.storageRelativePath));
    fs.unlinkSync(path.join(f.rootDir, a.artifact.blob.relativePath));
    const results = await Promise.all([f.service.retryDeleteCleanupJob(old.id), f.service.retryDeleteCleanupJob(old.id)]);
    assert.ok(results.every((result) => result.fullyDeleted === true), JSON.stringify(results));
    assert.ok(results[0].deletionId);
    assert.equal(results[0].deletionId, results[1].deletionId);
  } finally { f.close(); }
});

async function partialArchive(f, key) {
  const source = path.join(f.dir, `${key}.xlsx`);
  fs.writeFileSync(source, '已生成输出');
  const result = await f.service.createBatch({ moduleId: 'bank-statement', moduleCode: 'TEST',
    moduleName: '测试模块', operationKey: key, sourceOperation: 'archiveFile', files: [
      { filePath: source, direction: 'output', role: 'first' },
      { filePath: path.join(f.dir, `${key}-missing.xlsx`), direction: 'output', role: 'second' }
    ] });
  const artifacts = f.service.repository.listArtifacts(result.batch.id);
  const failed = artifacts.find((artifact) => artifact.status === 'failed');
  assert.ok(failed.storageRelativePath);
  assert.equal(failed.blob, null);
  assert.equal(failed.storageFingerprint, null);
  return { batch: result.batch, artifacts, failed };
}

function useHistoricalHardlinks(f, artifacts) {
  const blobPath = path.join(f.rootDir, artifacts[0].blob.relativePath);
  for (const artifact of artifacts) {
    const target = path.join(f.rootDir, artifact.storageRelativePath);
    fs.unlinkSync(target);
    fs.linkSync(blobPath, target);
  }
  const stat = readIdentityStatSync(fs, blobPath, 'statSync');
  for (const artifact of artifacts) {
    f.db.prepare(`UPDATE archive_artifacts SET storage_mode = 'hardlink',
      storage_fingerprint_size_bytes = ?, storage_fingerprint_mtime_ms = ?,
      storage_fingerprint_ctime_ms = ?, storage_fingerprint_ino = ? WHERE id = ?`)
      .run(stat.size, stat.mtimeMs, stat.ctimeMs, String(stat.ino), artifact.id);
  }
  f.db.prepare(`UPDATE archive_blobs SET fingerprint_size_bytes = ?, fingerprint_mtime_ms = ?,
    fingerprint_ctime_ms = ?, fingerprint_ino = ? WHERE id = ?`)
    .run(stat.size, stat.mtimeMs, stat.ctimeMs, String(stat.ino), artifacts[0].blob.id);
  return blobPath;
}

test('失败输出只有预分配路径时不能认领现存未知文件，预检和提交保留批次与文件', async () => {
  const f = fixture();
  try {
    const a = await partialArchive(f, 'unowned-output');
    const target = path.join(f.rootDir, a.failed.storageRelativePath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, '无关文件');
    const before = readIdentityStatSync(fs, target, 'statSync');
    for (const result of [await f.service.prepareDeleteBatch(a.batch.id),
      await f.service.deleteBatch(a.batch.id)]) {
      assert.equal(result.ok, false, JSON.stringify(result));
      assert.equal(result.code, 'ARCHIVE_DELETE_OWNER_IDENTITY_MISSING');
    }
    assert.ok(f.service.repository.getBatch(a.batch.id));
    assert.equal(f.service.repository.listCleanupJobs().length, 0);
    assert.equal(fs.readFileSync(target, 'utf8'), '无关文件');
    assert.equal(readIdentityStatSync(fs, target, 'statSync').ctimeMs, before.ctimeMs);
    assert.ok(fs.existsSync(path.join(f.rootDir, a.artifacts.find((artifact) => artifact.blob).blob.relativePath)));
  } finally { f.close(); }
});

test('无归属指纹的预分配路径安全缺失时允许删除并支持重复请求', async () => {
  const f = fixture();
  try {
    const a = await partialArchive(f, 'missing-output');
    assert.equal(fs.existsSync(path.join(f.rootDir, a.failed.storageRelativePath)), false);
    assert.equal((await f.service.prepareDeleteBatch(a.batch.id)).ok, true);
    const deleted = await f.service.deleteBatch(a.batch.id);
    assert.equal(deleted.fullyDeleted, true, JSON.stringify(deleted));
    assert.equal((await f.service.deleteBatch(a.batch.id)).deletionId, deleted.deletionId);
  } finally { f.close(); }
});

test('历史 hardlink 的目录文件和 Blob 都能删除，预检不改变 inode 或权限', async () => {
  const f = fixture();
  try {
    const a = await archive(f, 'hardlink');
    const blobPath = useHistoricalHardlinks(f, [a.artifact]);
    const before = readIdentityStatSync(fs, blobPath, 'statSync');
    assert.equal((await f.service.prepareDeleteBatch(a.batch.id)).ok, true);
    const after = readIdentityStatSync(fs, blobPath, 'statSync');
    assert.equal(after.ino, before.ino);
    assert.equal(after.ctimeMs, before.ctimeMs);
    assert.equal(after.mode, before.mode);
    const result = await f.service.deleteBatch(a.batch.id);
    assert.equal(result.fullyDeleted, true, JSON.stringify(result));
    assert.equal(fs.existsSync(path.join(f.rootDir, a.artifact.storageRelativePath)), false);
    assert.equal(fs.existsSync(blobPath), false);
  } finally { f.close(); }
});

test('hardlink unlink 后进度尚未落库便中断，重启仍按冻结身份完成', async () => {
  const f = fixture();
  try {
    const a = await archive(f, 'hardlink-progress-crash');
    const blobPath = useHistoricalHardlinks(f, [a.artifact]);
    const update = f.service.repository.updateCleanupJobProgress.bind(f.service.repository);
    f.service.repository.updateCleanupJobProgress = () => { throw new Error('unlink 后进度写入中断'); };
    const failed = await f.service.deleteBatch(a.batch.id);
    assert.equal(failed.metadataDeleted, true);
    assert.equal(failed.fullyDeleted, false);
    assert.equal(fs.existsSync(path.join(f.rootDir, a.artifact.storageRelativePath)), false);
    assert.equal(fs.existsSync(blobPath), true);
    f.service.repository.updateCleanupJobProgress = update;
    const restarted = f.create();
    await restarted.initialize({ deferStartupRecovery: true });
    const recovered = await restarted.retryDeleteCleanupJob(failed.cleanupJobId);
    assert.equal(recovered.fullyDeleted, true, JSON.stringify(recovered));
    assert.equal(fs.existsSync(blobPath), false);
  } finally { f.close(); }
});

test('hardlink 的目录文件占用而 Blob 已删除时，重试完成剩余原对象', async () => {
  const f = fixture();
  try {
    const a = await archive(f, 'hardlink-busy');
    const blobPath = useHistoricalHardlinks(f, [a.artifact]);
    f.state.blocked = true;
    f.state.target = path.join(f.rootDir, a.artifact.storageRelativePath);
    const pending = await f.service.deleteBatch(a.batch.id);
    assert.equal(pending.fullyDeleted, false);
    assert.equal(fs.existsSync(blobPath), false);
    f.state.blocked = false;
    const result = await f.service.retryDeleteCleanupJob(pending.cleanupJobId);
    assert.equal(result.fullyDeleted, true, JSON.stringify(result));
  } finally { f.close(); }
});

test('hardlink 同路径出现相同内容的新对象时，重试仍保留替代文件', async () => {
  const f = fixture();
  try {
    const a = await archive(f, 'hardlink-replaced');
    useHistoricalHardlinks(f, [a.artifact]);
    f.state.blocked = true;
    f.state.target = path.join(f.rootDir, a.artifact.storageRelativePath);
    const pending = await f.service.deleteBatch(a.batch.id);
    const replacement = path.join(f.dir, 'replacement.xlsx');
    fs.writeFileSync(replacement, 'hardlink-replaced');
    fs.renameSync(replacement, f.state.target);
    f.state.blocked = false;
    const result = await f.service.retryDeleteCleanupJob(pending.cleanupJobId);
    assert.equal(result.fullyDeleted, false, JSON.stringify(result));
    assert.equal(result.failures[0].code, 'ARCHIVE_DELETE_FILE_CHANGED');
    assert.equal(fs.readFileSync(f.state.target, 'utf8'), 'hardlink-replaced');
  } finally { f.close(); }
});

test('hardlink 没有计划内链接缺失时，ctime 改变仍拒绝删除', async () => {
  const f = fixture();
  try {
    const a = await archive(f, 'hardlink-chmod');
    const blobPath = useHistoricalHardlinks(f, [a.artifact]);
    f.state.blocked = true;
    const pending = await f.service.deleteBatch(a.batch.id);
    fs.chmodSync(blobPath, 0o600);
    f.state.blocked = false;
    const result = await f.service.retryDeleteCleanupJob(pending.cleanupJobId);
    assert.equal(result.fullyDeleted, false, JSON.stringify(result));
    assert.ok(result.failures.every((failure) => failure.code === 'ARCHIVE_DELETE_FILE_CHANGED'));
    assert.equal(fs.existsSync(blobPath), true);
    assert.equal(fs.existsSync(path.join(f.rootDir, a.artifact.storageRelativePath)), true);
  } finally { f.close(); }
});

test('多个历史 hardlink 输出共用另一有效批次的 Blob，删除只释放当前批次路径', async () => {
  const f = fixture();
  try {
    const files = ['hardlink-first', 'hardlink-second'].map((key) => {
      const filePath = path.join(f.dir, `${key}.xlsx`);
      fs.writeFileSync(filePath, 'shared historic content');
      return { filePath, direction: 'output', role: key };
    });
    const a = await f.service.createBatch({ moduleId: 'bank-statement', moduleCode: 'TEST',
      moduleName: '测试模块', operationKey: 'hardlink-group', sourceOperation: 'archiveFile', files });
    const artifacts = f.service.repository.listArtifacts(a.batch.id);
    assert.equal(artifacts.length, 2);
    const b = await archive(f, 'hardlink-shared', 'shared historic content');
    const blobPath = useHistoricalHardlinks(f, [...artifacts, b.artifact]);
    const result = await f.service.deleteBatch(a.batch.id);
    assert.equal(result.fullyDeleted, true, JSON.stringify(result));
    for (const artifact of artifacts) assert.equal(fs.existsSync(path.join(f.rootDir, artifact.storageRelativePath)), false);
    assert.equal(fs.readFileSync(blobPath, 'utf8'), 'shared historic content');
    assert.equal(fs.readFileSync(path.join(f.rootDir, b.artifact.storageRelativePath), 'utf8'), 'shared historic content');
    assert.ok(f.service.repository.getBatch(b.batch.id));
    const second = await f.service.deleteBatch(b.batch.id);
    assert.equal(second.fullyDeleted, true, JSON.stringify(second));
    assert.equal(fs.existsSync(blobPath), false);
  } finally { f.close(); }
});

test('hardlink 受管链接删除后保留外部链接内容与权限', async () => {
  const f = fixture();
  try {
    const a = await archive(f, 'external-hardlink');
    const blobPath = path.join(f.rootDir, a.artifact.blob.relativePath);
    const external = path.join(f.dir, 'outside-archive.xlsx');
    fs.linkSync(blobPath, external);
    useHistoricalHardlinks(f, [a.artifact]);
    const before = readIdentityStatSync(fs, external, 'statSync');
    const result = await f.service.deleteBatch(a.batch.id);
    assert.equal(result.fullyDeleted, true, JSON.stringify(result));
    assert.equal(fs.readFileSync(external, 'utf8'), 'external-hardlink');
    assert.equal(readIdentityStatSync(fs, external, 'statSync').mode, before.mode);
    assert.equal(readIdentityStatSync(fs, external, 'statSync').ino, before.ino);
  } finally { f.close(); }
});

test('未知外部 hardlink 变化不能冒充计划内链接减少', async () => {
  const f = fixture();
  try {
    const a = await archive(f, 'unknown-link-change');
    const blobPath = path.join(f.rootDir, a.artifact.blob.relativePath);
    const external = path.join(f.dir, 'unknown-hardlink.xlsx');
    fs.linkSync(blobPath, external);
    useHistoricalHardlinks(f, [a.artifact]);
    f.state.blocked = true;
    const pending = await f.service.deleteBatch(a.batch.id);
    fs.unlinkSync(external);
    f.state.blocked = false;
    const result = await f.service.retryDeleteCleanupJob(pending.cleanupJobId);
    assert.equal(result.fullyDeleted, false, JSON.stringify(result));
    assert.ok(result.failures.every((failure) => failure.code === 'ARCHIVE_DELETE_FILE_CHANGED'));
    assert.ok(fs.existsSync(blobPath));
    assert.ok(fs.existsSync(path.join(f.rootDir, a.artifact.storageRelativePath)));
  } finally { f.close(); }
});

for (const crashPoint of ['unlink-before-progress', 'fingerprint-before-progress']) {
  test(`共享 hardlink 在 ${crashPoint} 中断后完成恢复，其他批次仍可读取和删除`, async () => {
    const f = fixture();
    try {
      const a = await archive(f, `shared-crash-a-${crashPoint}`, 'shared crash');
      const b = await archive(f, `shared-crash-b-${crashPoint}`, 'shared crash');
      const blobPath = useHistoricalHardlinks(f, [a.artifact, b.artifact]);
      const update = f.service.repository.updateCleanupJobProgress.bind(f.service.repository);
      f.service.repository.updateCleanupJobProgress = (jobId, patch) => {
        const blob = patch.items.find((item) => item.kind === 'blob');
        if (crashPoint === 'unlink-before-progress' || blob.state === 'preserved-shared') {
          throw new Error('共享 inode 清理进度尚未落库');
        }
        return update(jobId, patch);
      };
      const pending = await f.service.deleteBatch(a.batch.id);
      assert.equal(pending.fullyDeleted, false);
      assert.equal(f.service.repository.getDeletionReceipt(a.batch.id), null);
      assert.equal(fs.readFileSync(blobPath, 'utf8'), 'shared crash');
      f.service.repository.updateCleanupJobProgress = update;
      const restarted = f.create();
      await restarted.initialize({ deferStartupRecovery: true });
      const result = await restarted.retryDeleteCleanupJob(pending.cleanupJobId);
      assert.equal(result.fullyDeleted, true, JSON.stringify(result));
      assert.equal(fs.readFileSync(path.join(f.rootDir, b.artifact.storageRelativePath), 'utf8'), 'shared crash');
      const second = await restarted.deleteBatch(b.batch.id);
      assert.equal(second.fullyDeleted, true, JSON.stringify(second));
    } finally { f.close(); }
  });
}

test('共享 hardlink 的同组目录文件被占用时不能提前完成 Blob 指纹收口', async () => {
  const f = fixture();
  try {
    const a = await archive(f, 'shared-busy-a', 'shared busy');
    const b = await archive(f, 'shared-busy-b', 'shared busy');
    useHistoricalHardlinks(f, [a.artifact, b.artifact]);
    f.state.blocked = true;
    f.state.target = path.join(f.rootDir, a.artifact.storageRelativePath);
    const pending = await f.service.deleteBatch(a.batch.id);
    assert.equal(pending.fullyDeleted, false);
    const job = f.service.repository.getCleanupJob(pending.cleanupJobId);
    assert.equal(job.plan.items.find((item) => item.kind === 'blob').state, 'failed');
    f.state.blocked = false;
    assert.equal((await f.service.retryDeleteCleanupJob(pending.cleanupJobId)).fullyDeleted, true);
    assert.equal((await f.service.deleteBatch(b.batch.id)).fullyDeleted, true);
  } finally { f.close(); }
});

test('共享 hardlink 的其他批次原指纹冲突时 CAS 保留诊断且不刷新 Blob', async () => {
  const f = fixture();
  try {
    const a = await archive(f, 'shared-cas-a', 'shared cas');
    const b = await archive(f, 'shared-cas-b', 'shared cas');
    const blobPath = useHistoricalHardlinks(f, [a.artifact, b.artifact]);
    const original = f.service.repository.getArtifact(b.artifact.id).storageFingerprint;
    f.state.afterUnlink = () => {
      f.db.prepare('UPDATE archive_artifacts SET storage_fingerprint_ctime_ms = ? WHERE id = ?')
        .run(original.ctimeMs + 123, b.artifact.id);
      f.state.afterUnlink = null;
    };
    const pending = await f.service.deleteBatch(a.batch.id);
    assert.equal(pending.fullyDeleted, false);
    assert.equal(pending.failures[0].code, 'ARCHIVE_DELETE_FILE_CHANGED');
    assert.equal(f.service.repository.getDeletionReceipt(a.batch.id), null);
    assert.equal(f.service.repository.findBlobByHash(a.artifact.blob.sha256).fingerprint.ctimeMs, original.ctimeMs);
    assert.equal(f.service.repository.listCleanupJobs().length, 1);
    assert.equal(fs.readFileSync(blobPath, 'utf8'), 'shared cas');
    f.db.prepare('UPDATE archive_artifacts SET storage_fingerprint_ctime_ms = ? WHERE id = ?')
      .run(original.ctimeMs, b.artifact.id);
    assert.equal((await f.service.retryDeleteCleanupJob(pending.cleanupJobId)).fullyDeleted, true);
    assert.equal((await f.service.deleteBatch(b.batch.id)).fullyDeleted, true);
  } finally { f.close(); }
});

test('Blob 的内容摘要不能代替目录文件缺失的原对象身份', async () => {
  const f = fixture();
  try {
    const a = await archive(f, 'missing-materialized-fingerprint');
    f.db.prepare(`UPDATE archive_artifacts SET storage_fingerprint_size_bytes = NULL,
      storage_fingerprint_mtime_ms = NULL, storage_fingerprint_ctime_ms = NULL,
      storage_fingerprint_ino = NULL WHERE id = ?`).run(a.artifact.id);
    const result = await f.service.deleteBatch(a.batch.id);
    assert.equal(result.ok, false);
    assert.equal(result.code, 'ARCHIVE_DELETE_OWNER_IDENTITY_MISSING');
    assert.ok(f.service.repository.getBatch(a.batch.id));
    assert.ok(fs.existsSync(path.join(f.rootDir, a.artifact.storageRelativePath)));
    assert.ok(fs.existsSync(path.join(f.rootDir, a.artifact.blob.relativePath)));
  } finally { f.close(); }
});

test('旧清理失败后同 SHA 的 Blob 被新批次重新发布，重试保留新引用并完成', async () => {
  const f = fixture();
  try {
    const a = await archive(f, 'republish-old', 'republished shared');
    const blobPath = path.join(f.rootDir, a.artifact.blob.relativePath);
    f.state.blocked = true;
    f.state.target = blobPath;
    const pending = await f.service.deleteBatch(a.batch.id);
    assert.equal(pending.fullyDeleted, false);
    fs.unlinkSync(blobPath);
    f.state.blocked = false;
    const b = await archive(f, 'republish-new', 'republished shared');
    const result = await f.service.retryDeleteCleanupJob(pending.cleanupJobId);
    assert.equal(result.fullyDeleted, true, JSON.stringify(result));
    assert.equal(fs.readFileSync(blobPath, 'utf8'), 'republished shared');
    assert.ok(f.service.repository.getBatch(b.batch.id));
  } finally { f.close(); }
});

test('共享 hardlink 的前批次清理挂起时阻止新删除，原任务恢复后再删除下一批次', async () => {
  const f = fixture();
  try {
    const a = await archive(f, 'overlap-a', 'shared overlap');
    const b = await archive(f, 'overlap-b', 'shared overlap');
    const blobPath = useHistoricalHardlinks(f, [a.artifact, b.artifact]);
    const before = await f.service.prepareDeleteBatch(b.batch.id);
    assert.equal(before.ok, true);
    f.state.blocked = true;
    f.state.target = path.join(f.rootDir, a.artifact.storageRelativePath);
    const pending = await f.service.deleteBatch(a.batch.id);
    assert.equal(pending.fullyDeleted, false);
    const prepared = await f.service.prepareDeleteBatch(b.batch.id);
    assert.equal(prepared.ok, false);
    assert.equal(prepared.code, 'ARCHIVE_DELETE_HARDLINKS_PENDING');
    const blocked = await f.service.deleteBatch(b.batch.id, { expectedRevision: before.revision });
    assert.equal(blocked.ok, false);
    assert.equal(blocked.code, 'ARCHIVE_DELETE_HARDLINKS_PENDING');
    assert.ok(f.service.repository.getBatch(b.batch.id));
    assert.ok(fs.existsSync(path.join(f.rootDir, b.artifact.storageRelativePath)));
    assert.ok(fs.existsSync(blobPath));
    assert.equal(f.service.repository.listCleanupJobs().length, 1);
    f.state.blocked = false;
    assert.equal((await f.service.retryDeleteCleanupJob(pending.cleanupJobId)).fullyDeleted, true);
    assert.equal((await f.service.deleteBatch(b.batch.id)).fullyDeleted, true);
  } finally { f.close(); }
});

for (const trigger of ['read-other', 'maintenance']) {
  test(`历史共享硬链接清理挂起时 ${trigger} 延后脱钩，原删除重试仍可收口`, async () => {
    const f = fixture();
    try {
      const a = await archive(f, `pending-${trigger}-a`, 'pending shared');
      const b = await archive(f, `pending-${trigger}-b`, 'pending shared');
      const blobPath = useHistoricalHardlinks(f, [a.artifact, b.artifact]);
      f.state.blocked = true;
      f.state.target = path.join(f.rootDir, a.artifact.storageRelativePath);
      const pending = await f.service.deleteBatch(a.batch.id);
      assert.equal(pending.fullyDeleted, false);
      const before = readIdentityStatSync(fs, blobPath, 'statSync');
      if (trigger === 'read-other') {
        const ready = await f.service.resolveVerifiedArtifact(b.artifact.id);
        assert.equal(ready.ok, true);
        assert.equal(ready.repairPending, true);
        assert.equal(fs.readFileSync(ready.filePath, 'utf8'), 'pending shared');
      } else {
        const maintenance = await f.service.reconcileStartup();
        assert.ok(maintenance.consistency.failures.some((failure) => failure.code === 'ARCHIVE_DELETE_HARDLINKS_PENDING'));
      }
      assert.equal(readIdentityStatSync(fs, blobPath, 'statSync').nlink, before.nlink);
      assert.equal(readIdentityStatSync(fs, blobPath, 'statSync').ctimeMs, before.ctimeMs);
      assert.equal(f.service.repository.getArtifact(b.artifact.id).storageMode, 'hardlink');
      f.state.blocked = false;
      assert.equal((await f.service.retryDeleteCleanupJob(pending.cleanupJobId)).fullyDeleted, true);
      const ready = await f.service.resolveVerifiedArtifact(b.artifact.id);
      assert.equal(ready.ok, true);
      assert.equal(ready.repairPending, false);
      assert.equal(f.service.repository.getArtifact(b.artifact.id).storageMode, 'copy');
      assert.equal(fs.readFileSync(ready.filePath, 'utf8'), 'pending shared');
      assert.equal((await f.service.deleteBatch(b.batch.id)).fullyDeleted, true);
    } finally { f.close(); }
  });
}

test('旧硬链接清理后的同 SHA 新 inode Blob 有新持久引用时保留新对象并收口', async () => {
  const f = fixture();
  try {
    const a = await archive(f, 'hardlink-republish-old', 'republished historic');
    const blobPath = useHistoricalHardlinks(f, [a.artifact]);
    const oldIdentity = readIdentityStatSync(fs, blobPath, 'statSync');
    f.state.blocked = true;
    f.state.target = blobPath;
    const pending = await f.service.deleteBatch(a.batch.id);
    assert.equal(pending.fullyDeleted, false);
    const retiredPath = path.join(f.dir, 'retired-original-blob');
    fs.renameSync(blobPath, retiredPath);
    f.state.blocked = false;
    const b = await archive(f, 'hardlink-republish-new', 'republished historic');
    fs.unlinkSync(retiredPath);
    assert.notEqual(readIdentityStatSync(fs, blobPath, 'statSync').ino, oldIdentity.ino);
    const before = f.service.repository.getArtifact(b.artifact.id).blob.fingerprint;
    const result = await f.service.retryDeleteCleanupJob(pending.cleanupJobId);
    assert.equal(result.fullyDeleted, true, JSON.stringify(result));
    assert.equal(fs.readFileSync(blobPath, 'utf8'), 'republished historic');
    assert.deepEqual(f.service.repository.getArtifact(b.artifact.id).blob.fingerprint, before);
    assert.ok(f.service.repository.getBatch(b.batch.id));
  } finally { f.close(); }
});

async function republishBlobAfterPartialHardlinkDelete(f, options = {}) {
  const a = await archive(f, 'partial-hardlink-old', 'same original bytes');
  const blobPath = path.join(f.rootDir, a.artifact.blob.relativePath);
  const externalPath = path.join(f.dir, 'external-original-link');
  if (options.externalLink) fs.linkSync(blobPath, externalPath);
  useHistoricalHardlinks(f, [a.artifact]);
  const materializedPath = path.join(f.rootDir, a.artifact.storageRelativePath);
  const original = readIdentityStatSync(fs, materializedPath, 'statSync');
  f.state.blocked = true;
  f.state.target = materializedPath;
  f.state.code = options.code || 'EBUSY';
  const update = f.service.repository.updateCleanupJobProgress.bind(f.service.repository);
  if (options.unpersistedProgress) {
    f.service.repository.updateCleanupJobProgress = (jobId, patch) => {
      if (patch.items.some((item) => item.kind === 'blob' && item.state === 'deleted')) {
        throw new Error('原 Blob unlink 完成，但进度尚未持久');
      }
      return update(jobId, patch);
    };
  }
  const pending = await f.service.deleteBatch(a.batch.id);
  f.service.repository.updateCleanupJobProgress = update;
  assert.equal(pending.fullyDeleted, false, JSON.stringify(pending));
  assert.equal(fs.existsSync(blobPath), false);
  assert.equal(readIdentityStatSync(fs, materializedPath, 'statSync').ino, original.ino);
  const deletedBlob = f.service.repository.getCleanupJob(pending.cleanupJobId).plan.items
    .find((item) => item.kind === 'blob');
  assert.equal(deletedBlob.state, options.unpersistedProgress ? 'pending' : 'deleted');
  f.state.blocked = false;
  if (options.replaceParent) {
    const parent = path.dirname(blobPath);
    fs.renameSync(parent, `${parent}-previous`);
    fs.mkdirSync(parent);
  }
  let b;
  if (options.unreferencedReplacement) fs.writeFileSync(blobPath, 'same original bytes');
  else b = await archive(f, 'partial-hardlink-new', 'same original bytes');
  assert.notEqual(readIdentityStatSync(fs, blobPath, 'statSync').ino, original.ino);
  return { a, b, pending, original, blobPath, materializedPath, externalPath };
}

for (const code of ['EBUSY', 'EACCES']) {
  for (const restart of [false, true]) {
    test(`原 Blob 已删且同 SHA 被新批次发布后，${code} 目录残留在${restart ? '重启' : '当前进程'}重试收口`, async () => {
      const f = fixture();
      try {
        const current = await republishBlobAfterPartialHardlinkDelete(f, { code });
        const { a, b, pending, blobPath, materializedPath } = current;
        const before = readIdentityStatSync(fs, blobPath, 'statSync');
        const fingerprint = f.service.repository.getArtifact(b.artifact.id).blob.fingerprint;
        const service = restart ? f.create() : f.service;
        if (restart) await service.initialize({ deferStartupRecovery: true, startBackgroundMaterialization: false });
        const retried = await service.retryDeleteCleanupJob(pending.cleanupJobId);
        assert.equal(retried.fullyDeleted, true, JSON.stringify(retried));
        assert.equal(fs.existsSync(materializedPath), false);
        assert.equal(readIdentityStatSync(fs, blobPath, 'statSync').ino, before.ino);
        assert.equal(readIdentityStatSync(fs, blobPath, 'statSync').ctimeMs, before.ctimeMs);
        assert.equal(fs.readFileSync(blobPath, 'utf8'), 'same original bytes');
        assert.deepEqual(service.repository.getArtifact(b.artifact.id).blob.fingerprint, fingerprint);
        assert.ok(service.repository.getBatch(b.batch.id));
        assert.equal((await service.resolveVerifiedArtifact(b.artifact.id)).ok, true);
        assert.equal(service.repository.listCleanupJobs().length, 0);
        assert.equal(service.repository.getDeletionReceipt(a.batch.id).deletionId, retried.deletionId);
      } finally { f.close(); }
    });
  }
}

for (const variant of ['unreferenced', 'missing-fingerprint', 'mismatched-fingerprint',
  'original-inode-reappeared', 'parent-replaced', 'original-content-changed', 'extra-link-removed',
  'unpersisted-progress', 'forged-memory-progress', 'different-plan', 'already-missing', 'preserved-shared']) {
  test(`同 SHA 新 Blob 不能替代原链接的完整删除证据：${variant}`, async () => {
    const f = fixture();
    try {
      const { a, b, pending, original, blobPath, materializedPath, externalPath } =
        await republishBlobAfterPartialHardlinkDelete(f, {
          unreferencedReplacement: variant === 'unreferenced',
          replaceParent: variant === 'parent-replaced',
          externalLink: variant === 'extra-link-removed',
          unpersistedProgress: ['unpersisted-progress', 'forged-memory-progress'].includes(variant)
        });
      if (variant === 'missing-fingerprint') {
        f.db.prepare('UPDATE archive_blobs SET fingerprint_ino = NULL WHERE id = ?')
          .run(b.artifact.blob.id);
      } else if (variant === 'mismatched-fingerprint') {
        f.db.prepare('UPDATE archive_blobs SET fingerprint_ctime_ms = fingerprint_ctime_ms + 1 WHERE id = ?')
          .run(b.artifact.blob.id);
      } else if (variant === 'original-inode-reappeared') {
        fs.renameSync(blobPath, path.join(f.dir, 'new-blob-backup'));
        fs.linkSync(materializedPath, blobPath);
      } else if (variant === 'original-content-changed') {
        fs.chmodSync(materializedPath, 0o600);
        fs.writeFileSync(materializedPath, 'modified original!!');
      } else if (variant === 'extra-link-removed') fs.unlinkSync(externalPath);
      else if (['already-missing', 'preserved-shared'].includes(variant)) {
        const job = f.service.repository.getCleanupJob(pending.cleanupJobId);
        const progress = job.progress;
        const blobItemId = job.plan.items.find((item) => item.kind === 'blob').itemId;
        progress.items.find((item) => item.itemId === blobItemId).state = variant;
        f.db.prepare('UPDATE archive_cleanup_jobs SET progress_json = ? WHERE id = ?')
          .run(JSON.stringify(progress), job.id);
      }
      const newBefore = readIdentityStatSync(fs, blobPath, 'statSync');
      const newBytes = fs.readFileSync(blobPath);
      let retried;
      if (['forged-memory-progress', 'different-plan'].includes(variant)) {
        const { executeDeletePlan } = require('../../../src/main-process/archive-center/batch-delete-plan');
        const job = f.service.repository.getCleanupJob(pending.cleanupJobId);
        if (variant === 'forged-memory-progress') {
          job.plan.items.find((item) => item.kind === 'blob').state = 'deleted';
        } else job.plan.deletionId = 'another-deletion-plan';
        retried = await executeDeletePlan(f.service, job);
        assert.equal(retried.ok, false);
      } else {
        retried = await f.service.retryDeleteCleanupJob(pending.cleanupJobId);
        assert.equal(retried.fullyDeleted, false, JSON.stringify(retried));
      }
      assert.ok(retried.failures.some((failure) => failure.code === 'ARCHIVE_DELETE_FILE_CHANGED'));
      assert.equal(readIdentityStatSync(fs, materializedPath, 'statSync').ino, original.ino);
      assert.equal(readIdentityStatSync(fs, blobPath, 'statSync').ino, newBefore.ino);
      assert.equal(readIdentityStatSync(fs, blobPath, 'statSync').ctimeMs, newBefore.ctimeMs);
      assert.deepEqual(fs.readFileSync(blobPath), newBytes);
      assert.equal(f.service.repository.getDeletionReceipt(a.batch.id), null);
      assert.ok(f.service.repository.getCleanupJob(pending.cleanupJobId));
    } finally { f.close(); }
  });
}

for (const exists of [true, false]) {
  test(`历史 Blob 无持久指纹时${exists ? '拒绝同 SHA 替代对象' : '安全缺失仍可幂等删除'}`, async () => {
    const f = fixture();
    try {
      const a = await archive(f, `legacy-blob-fingerprint-${exists}`, 'legacy blob');
      const blobPath = path.join(f.rootDir, a.artifact.blob.relativePath);
      f.db.prepare(`UPDATE archive_blobs SET fingerprint_size_bytes = NULL,
        fingerprint_mtime_ms = NULL, fingerprint_ctime_ms = NULL,
        fingerprint_ino = NULL WHERE id = ?`).run(a.artifact.blob.id);
      if (exists) {
        const replacement = path.join(f.dir, 'replacement');
        fs.writeFileSync(replacement, 'legacy blob');
        fs.renameSync(replacement, blobPath);
      } else fs.unlinkSync(blobPath);
      const prepared = await f.service.prepareDeleteBatch(a.batch.id);
      const deleted = await f.service.deleteBatch(a.batch.id);
      if (exists) {
        for (const result of [prepared, deleted]) {
          assert.equal(result.ok, false, JSON.stringify(result));
          assert.equal(result.code, 'ARCHIVE_DELETE_OWNER_IDENTITY_MISSING');
        }
        assert.equal(fs.readFileSync(blobPath, 'utf8'), 'legacy blob');
        assert.ok(f.service.repository.getBatch(a.batch.id));
        assert.equal(f.service.repository.getArtifact(a.artifact.id).blob.fingerprint, null);
      } else {
        assert.equal(prepared.ok, true);
        assert.equal(deleted.fullyDeleted, true, JSON.stringify(deleted));
        assert.equal((await f.service.deleteBatch(a.batch.id)).deletionId, deleted.deletionId);
      }
    } finally { f.close(); }
  });
}

test('共享硬链接 unlink 进度落库前中断，维护不提前刷新指纹，原删除仍可重放', async () => {
  const f = fixture();
  try {
    const a = await archive(f, 'maintenance-after-unlink-a', 'shared interrupted');
    const b = await archive(f, 'maintenance-after-unlink-b', 'shared interrupted');
    const blobPath = useHistoricalHardlinks(f, [a.artifact, b.artifact]);
    const oldFingerprint = f.service.repository.getArtifact(b.artifact.id).blob.fingerprint;
    const update = f.service.repository.updateCleanupJobProgress.bind(f.service.repository);
    f.service.repository.updateCleanupJobProgress = () => { throw new Error('进度落库中断'); };
    const pending = await f.service.deleteBatch(a.batch.id);
    assert.equal(pending.fullyDeleted, false);
    assert.equal(fs.existsSync(path.join(f.rootDir, a.artifact.storageRelativePath)), false);
    const maintenance = await f.service.reconcileStartup();
    assert.equal(maintenance.ok, false);
    assert.deepEqual(f.service.repository.getArtifact(b.artifact.id).blob.fingerprint, oldFingerprint);
    assert.deepEqual(f.service.repository.getArtifact(b.artifact.id).storageFingerprint, oldFingerprint);
    assert.equal(readIdentityStatSync(fs, blobPath, 'statSync').nlink, 2);
    f.service.repository.updateCleanupJobProgress = update;
    assert.equal((await f.service.retryDeleteCleanupJob(pending.cleanupJobId)).fullyDeleted, true);
    assert.equal((await f.service.deleteBatch(b.batch.id)).fullyDeleted, true);
  } finally { f.close(); }
});

test('正常硬链接脱钩遇共享指纹冲突时先保留原 inode，修正冲突后可读和删除', async () => {
  const f = fixture();
  try {
    const a = await archive(f, 'detach-cas-a', 'detach cas');
    const b = await archive(f, 'detach-cas-b', 'detach cas');
    const blobPath = useHistoricalHardlinks(f, [a.artifact, b.artifact]);
    const before = readIdentityStatSync(fs, blobPath, 'statSync');
    const original = f.service.repository.getArtifact(b.artifact.id).storageFingerprint;
    f.db.prepare('UPDATE archive_artifacts SET storage_fingerprint_ctime_ms = ? WHERE id = ?')
      .run(original.ctimeMs + 123, b.artifact.id);
    const blocked = await f.service.resolveVerifiedArtifact(a.artifact.id);
    assert.equal(blocked.ok, true);
    assert.equal(blocked.repairPending, true);
    assert.equal(readIdentityStatSync(fs, blobPath, 'statSync').nlink, before.nlink);
    assert.equal(readIdentityStatSync(fs, blobPath, 'statSync').ctimeMs, before.ctimeMs);
    f.db.prepare('UPDATE archive_artifacts SET storage_fingerprint_ctime_ms = ? WHERE id = ?')
      .run(original.ctimeMs, b.artifact.id);
    assert.equal((await f.service.resolveVerifiedArtifact(a.artifact.id)).repairPending, false);
    assert.equal((await f.service.deleteBatch(a.batch.id)).fullyDeleted, true);
    assert.equal((await f.service.deleteBatch(b.batch.id)).fullyDeleted, true);
  } finally { f.close(); }
});

test('正常硬链接已脱钩但指纹事务失败时保留旧凭证，重启维护同原 inode 后恢复', async () => {
  const f = fixture();
  try {
    const a = await archive(f, 'detach-write-failure', 'detach write failure');
    const blobPath = useHistoricalHardlinks(f, [a.artifact]);
    const original = f.service.repository.getArtifact(a.artifact.id).blob.fingerprint;
    f.db.exec(`CREATE TRIGGER reject_detach_fingerprint BEFORE UPDATE ON archive_blobs
      BEGIN SELECT RAISE(ABORT, 'injected fingerprint write failure'); END;`);
    const pending = await f.service.resolveVerifiedArtifact(a.artifact.id);
    assert.equal(pending.ok, true);
    assert.equal(pending.repairPending, true);
    assert.equal(readIdentityStatSync(fs, blobPath, 'statSync').nlink, 1);
    assert.deepEqual(f.service.repository.getArtifact(a.artifact.id).blob.fingerprint, original);
    assert.equal((await f.service.deleteBatch(a.batch.id)).code, 'ARCHIVE_DELETE_FILE_CHANGED');
    f.db.exec('DROP TRIGGER reject_detach_fingerprint');
    const restarted = f.create();
    const maintenance = await restarted.reconcileStartup();
    assert.equal(maintenance.ok, true, JSON.stringify(maintenance));
    assert.equal((await restarted.resolveVerifiedArtifact(a.artifact.id)).ok, true);
    assert.equal((await restarted.deleteBatch(a.batch.id)).fullyDeleted, true);
  } finally { f.close(); }
});

test('维护不能把同 SHA 不同 inode 的替代对象刷新成原 Blob 的持久身份', async () => {
  const f = fixture();
  try {
    const a = await archive(f, 'maintenance-replaced-blob', 'same bytes');
    const blobPath = path.join(f.rootDir, a.artifact.blob.relativePath);
    const original = f.service.repository.getArtifact(a.artifact.id).blob.fingerprint;
    const replacement = path.join(f.dir, 'replacement');
    fs.writeFileSync(replacement, 'same bytes');
    fs.renameSync(replacement, blobPath);
    assert.notEqual(String(readIdentityStatSync(fs, blobPath, 'statSync').ino), original.ino);
    await f.service.reconcileStartup();
    assert.deepEqual(f.service.repository.getArtifact(a.artifact.id).blob.fingerprint, original);
    assert.equal((await f.service.deleteBatch(a.batch.id)).code, 'ARCHIVE_DELETE_FILE_CHANGED');
    assert.equal(fs.readFileSync(blobPath, 'utf8'), 'same bytes');
  } finally { f.close(); }
});

for (const blockedBy of ['missing-new-fingerprint', 'returned-original-link']) {
  test(`旧硬链接遇新引用但 ${blockedBy} 时不能跳过原计划核验`, async () => {
    const f = fixture();
    try {
      const a = await archive(f, `republish-guard-old-${blockedBy}`, 'guard shared');
      const blobPath = useHistoricalHardlinks(f, [a.artifact]);
      f.state.blocked = true;
      f.state.target = blobPath;
      const pending = await f.service.deleteBatch(a.batch.id);
      const retiredPath = path.join(f.dir, 'retired-original');
      fs.renameSync(blobPath, retiredPath);
      f.state.blocked = false;
      const b = await archive(f, `republish-guard-new-${blockedBy}`, 'guard shared');
      if (blockedBy === 'missing-new-fingerprint') {
        f.db.prepare(`UPDATE archive_blobs SET fingerprint_size_bytes = NULL,
          fingerprint_mtime_ms = NULL, fingerprint_ctime_ms = NULL,
          fingerprint_ino = NULL WHERE id = ?`).run(b.artifact.blob.id);
      } else {
        const originalTarget = path.join(f.rootDir, a.artifact.storageRelativePath);
        fs.mkdirSync(path.dirname(originalTarget), { recursive: true });
        fs.linkSync(retiredPath, originalTarget);
      }
      const result = await f.service.retryDeleteCleanupJob(pending.cleanupJobId);
      assert.equal(result.fullyDeleted, false, JSON.stringify(result));
      assert.equal(fs.readFileSync(blobPath, 'utf8'), 'guard shared');
      assert.ok(f.service.repository.getBatch(b.batch.id));
      assert.equal(f.service.repository.getDeletionReceipt(a.batch.id), null);
    } finally { f.close(); }
  });
}

for (const detachedOrder of ['first', 'last']) {
  test(`共享硬链接 ${detachedOrder} 项脱钩后指纹落库失败，维护逐步恢复全部引用`, async () => {
    const f = fixture();
    try {
      const a = await archive(f, `shared-detach-write-a-${detachedOrder}`, 'shared detach failure');
      const b = await archive(f, `shared-detach-write-b-${detachedOrder}`, 'shared detach failure');
      const blobPath = useHistoricalHardlinks(f, [a.artifact, b.artifact]);
      const detached = detachedOrder === 'first' ? a : b;
      f.db.exec(`CREATE TRIGGER reject_shared_detach BEFORE UPDATE ON archive_blobs
        BEGIN SELECT RAISE(ABORT, 'injected shared fingerprint failure'); END;`);
      const pending = await f.service.resolveVerifiedArtifact(detached.artifact.id);
      assert.equal(pending.ok, true);
      assert.equal(pending.repairPending, true);
      assert.equal(readIdentityStatSync(fs, blobPath, 'statSync').nlink, 2);
      f.db.exec('DROP TRIGGER reject_shared_detach');
      const restarted = f.create();
      await restarted.reconcileStartup();
      const resumed = await restarted.reconcileStartup();
      assert.equal(resumed.ok, true, JSON.stringify(resumed));
      for (const item of [a, b]) {
        const ready = await restarted.resolveVerifiedArtifact(item.artifact.id);
        assert.equal(ready.ok, true);
        assert.equal(ready.repairPending, false);
        assert.equal((await restarted.deleteBatch(item.batch.id)).fullyDeleted, true);
      }
    } finally { f.close(); }
  });
}
