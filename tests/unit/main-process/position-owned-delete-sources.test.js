'use strict';
const { readIdentityStatSync } = require('../../../src/main-process/archive-center/filesystem-identity');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { createArchiveService } = require('../../../src/main-process/archive-center/archive-service');
const { stageInputFiles } = require('../../../src/main-process/position-reconciliation/input-staging');
const { createPositionOwnedDeleteSourceResolver } = require('../../../src/main-process/archive-center/position-owned-delete-sources');

async function fixture() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'position-delete-sources-'));
  const userDataPath = path.join(tempDir, 'user-data');
  fs.mkdirSync(userDataPath);
  const originalPath = path.join(tempDir, 'input.xlsx');
  fs.writeFileSync(originalPath, 'position managed staging input');
  const staged = stageInputFiles(userDataPath, [originalPath], 'job-20260911')[0];
  const db = new DatabaseSync(':memory:');
  const service = createArchiveService({ database: db, rootDir: path.join(tempDir, 'archive-root') });
  const archived = await service.archiveFile({
    moduleId: 'position-reconciliation-process', moduleCode: 'POSITION', moduleName: '平盘对账数据处理',
    operationKey: 'position-source-delete-fixture', direction: 'input', role: 'input',
    sourceOperation: 'position-reconciliation:source:apply-import',
    filePath: staged.archivePath, sourceSnapshot: staged.stagedSnapshot,
    expectedSha256: staged.stagedSha256, sizeBytes: staged.stagedSizeBytes
  });
  assert.equal(archived.ok, true, JSON.stringify(archived));
  const batch = service.repository.getBatch(archived.artifact.batchId);
  const artifacts = service.repository.listArtifacts(batch.id);
  return {
    tempDir, userDataPath, originalPath, staged, db, service, batch, artifacts,
    resolver(provider = async () => []) {
      return createPositionOwnedDeleteSourceResolver({ userDataPath, protectedPathProvider: provider });
    },
    close() { db.close(); fs.rmSync(tempDir, { recursive: true, force: true }); }
  };
}

function persistedTarget(entry) {
  const stat = readIdentityStatSync(fs, entry.rootDir, 'lstatSync');
  return {
    kind: 'owned-temp', sourceArtifactId: entry.artifactId,
    managedRelativePath: entry.managedRelativePath, sourceOwnerProof: entry.ownerProof,
    managedRootIdentity: { rootDir: entry.rootDir, realPath: fs.realpathSync(entry.rootDir),
      dev: String(stat.dev), ino: String(stat.ino) }
  };
}

test('生产 staging 与真实归档 metadata 提供可核验来源，仅返回该批次受管文件', async () => {
  const current = await fixture();
  try {
    const calls = [];
    const resolver = current.resolver(async ({ batch }) => { calls.push(batch.id); return []; });
    const entries = await resolver(current.batch, current.artifacts);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].artifactId, current.artifacts[0].id);
    assert.equal(entries[0].managedRelativePath, 'job-20260911/1/input.xlsx');
    assert.equal(entries[0].expectedSha256, current.staged.stagedSha256);
    assert.deepEqual(entries[0].sourceSnapshot, current.staged.stagedSnapshot);
    assert.deepEqual(Object.keys(entries[0].ownerProof).sort(), [
      'artifactId', 'batchId', 'expectedSha256', 'expectedSizeBytes',
      'moduleId', 'sourceOperation', 'sourcePath', 'sourceSnapshot'
    ]);
    await resolver.assertDeletionTargetReady(persistedTarget(entries[0]));
    assert.deepEqual(calls, [current.batch.id, current.batch.id, current.batch.id]);
    assert.equal(fs.readFileSync(current.originalPath, 'utf8'), 'position managed staging input');
    assert.equal(fs.existsSync(current.staged.archivePath), true, 'resolver 只读，不执行删除');
  } finally { current.close(); }
});

test('用户外部来源不读取、不认领；无候选时不依赖暂存根或引用 provider', async () => {
  const resolver = createPositionOwnedDeleteSourceResolver({ userDataPath: path.join(os.tmpdir(), 'unused-position-root') });
  const result = await resolver({ id: 1, moduleId: 'position-reconciliation-process' }, [{
    id: 1, batchId: 1, direction: 'input', sourceOperation: 'position-reconciliation:source:apply-import',
    sourcePath: path.join(os.tmpdir(), 'user-original-file.xlsx')
  }]);
  assert.deepEqual(result, []);
});

test('活动、恢复和其他批次保护路径不被豁免，引用读取失败明确拒绝', async () => {
  const current = await fixture();
  try {
    for (const values of [[current.staged.archivePath], [current.staged.stagingDir]]) {
      await assert.rejects(current.resolver(async () => values)(current.batch, current.artifacts), {
        code: 'ARCHIVE_DELETE_SOURCE_HELD'
      });
    }
    for (const provider of [async () => null, async () => { throw new Error('inventory unavailable'); }]) {
      await assert.rejects(current.resolver(provider)(current.batch, current.artifacts), {
        code: 'ARCHIVE_DELETE_SOURCE_REFERENCES_UNAVAILABLE'
      });
    }
    assert.equal(fs.existsSync(current.staged.archivePath), true);
  } finally { current.close(); }
});

test('哈希核对结束后新增引用以及持久计划重试时新增引用均阻止删除', async () => {
  const current = await fixture();
  try {
    let calls = 0;
    await assert.rejects(current.resolver(async () => (++calls === 1 ? [] : [current.staged.archivePath]))(
      current.batch, current.artifacts
    ), { code: 'ARCHIVE_DELETE_SOURCE_HELD' });
    let protectedPaths = [];
    const resolver = current.resolver(async () => protectedPaths);
    const [entry] = await resolver(current.batch, current.artifacts);
    const target = persistedTarget(entry);
    protectedPaths = [current.staged.archivePath];
    await assert.rejects(resolver.assertDeletionTargetReady(target), { code: 'ARCHIVE_DELETE_SOURCE_HELD' });
    assert.equal(fs.existsSync(current.staged.archivePath), true);
  } finally { current.close(); }
});

test('其他批次通过目录别名引用同一受管文件时也必须保护', async () => {
  const current = await fixture();
  try {
    const alias = path.join(current.tempDir, 'source-alias');
    fs.symlinkSync(current.staged.stagingDir, alias, process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(current.resolver(async () => [path.join(alias, 'input.xlsx')])(
      current.batch, current.artifacts
    ), { code: 'ARCHIVE_DELETE_SOURCE_HELD' });
    assert.equal(fs.existsSync(current.staged.archivePath), true);
  } finally { current.close(); }
});

test('已知文件或 job 子目录缺失可建立幂等目标，暂存根缺失不能当成功', async () => {
  const current = await fixture();
  try {
    fs.rmSync(current.staged.archivePath);
    assert.equal((await current.resolver()(current.batch, current.artifacts)).length, 1);
    fs.rmSync(path.dirname(current.staged.stagingDir), { recursive: true });
    assert.equal((await current.resolver()(current.batch, current.artifacts)).length, 1);
    fs.rmSync(path.dirname(path.dirname(current.staged.stagingDir)), { recursive: true });
    await assert.rejects(current.resolver()(current.batch, current.artifacts), {
      code: 'ARCHIVE_DELETE_SOURCE_ROOT_UNAVAILABLE'
    });
  } finally { current.close(); }
});

test('同内容替换文件和持久摘要不符均拒绝，不能用当前 capture 重新认领', async () => {
  const current = await fixture();
  try {
    const tampered = structuredClone(current.artifacts);
    tampered[0].metadata.expectedSha256 = '0'.repeat(64);
    await assert.rejects(current.resolver()(current.batch, tampered), { code: 'ARCHIVE_DELETE_SOURCE_CHANGED' });
    const replacement = `${current.staged.archivePath}.replacement`;
    fs.copyFileSync(current.staged.archivePath, replacement);
    fs.renameSync(replacement, current.staged.archivePath);
    await assert.rejects(current.resolver()(current.batch, current.artifacts), { code: 'ARCHIVE_DELETE_SOURCE_CHANGED' });
    assert.equal(fs.existsSync(current.staged.archivePath), true);
  } finally { current.close(); }
});

test('已知暂存路径缺少旧对象身份或输入归属时明确阻止', async () => {
  const current = await fixture();
  try {
    const variants = [
      { metadata: {} },
      { metadata: { ...current.artifacts[0].metadata, sourceSnapshot: { ...current.staged.stagedSnapshot, ino: undefined } } },
      { sourceOperation: 'position-reconciliation:run:export' },
      { direction: 'output' },
      { sourcePath: path.join(current.userDataPath, 'run-data/position-reconciliation/unknown/input.xlsx') },
      { batchId: current.batch.id + 1 }
    ];
    for (const patch of variants) {
      await assert.rejects(current.resolver()(current.batch, [{ ...current.artifacts[0], ...patch }]), {
        code: 'ARCHIVE_DELETE_SOURCE_OWNER_UNKNOWN'
      });
    }
  } finally { current.close(); }
});

test('暂存父目录链接和持久计划根替换均拒绝且不触及链接目标', async () => {
  const current = await fixture();
  try {
    const resolver = current.resolver();
    const [entry] = await resolver(current.batch, current.artifacts);
    const target = persistedTarget(entry);
    await assert.rejects(resolver.assertDeletionTargetReady({
      ...target, managedRootIdentity: { ...target.managedRootIdentity, ino: '999999999' }
    }), { code: 'ARCHIVE_DELETE_SOURCE_ROOT_UNAVAILABLE' });
    const heldDirectory = `${current.staged.stagingDir}-original`;
    fs.renameSync(current.staged.stagingDir, heldDirectory);
    fs.symlinkSync(heldDirectory, current.staged.stagingDir, process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(resolver(current.batch, current.artifacts), { code: 'ARCHIVE_DELETE_SOURCE_PATH_UNSAFE' });
    await assert.rejects(resolver.assertDeletionTargetReady(target), { code: 'ARCHIVE_DELETE_SOURCE_PATH_UNSAFE' });
    assert.equal(fs.readFileSync(path.join(heldDirectory, 'input.xlsx'), 'utf8'), 'position managed staging input');
  } finally { current.close(); }
});
