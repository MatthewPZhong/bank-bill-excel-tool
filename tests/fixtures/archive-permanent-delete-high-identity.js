'use strict';

// 真实 SQLite、文件和服务流程；仅 stat 的身份字段注入高位，元数据仍来自同一次原生 stat。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { readIdentityStatSync } = require('../../src/main-process/archive-center/filesystem-identity');
const { createArchiveService } = require('../../src/main-process/archive-center/archive-service');
const HIGH = 1n << 60n;

function largeIdentityFs(state) {
  const inodes = new Map();
  const mapped = (stat, options) => {
    const original = String(stat.ino);
    if (!inodes.has(original)) inodes.set(original, HIGH + BigInt(inodes.size + 1));
    const exact = inodes.get(original);
    return new Proxy(stat, { get(target, key) {
      if (key === 'ino') return options?.bigint ? exact : Number(exact);
      if (key === 'dev') return options?.bigint ? HIGH + 7n : Number(HIGH + 7n);
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
  };
  const implementation = { ...fs, promises: { ...fs.promises }, unlinkSync(filePath) {
    if (state.blocked && filePath === state.target) throw Object.assign(new Error('模拟占用'), { code: 'EBUSY' });
    return fs.unlinkSync(filePath);
  } };
  for (const name of ['statSync', 'lstatSync', 'fstatSync']) {
    implementation[name] = (target, options) => mapped(fs[name](target, options), options);
  }
  for (const name of ['stat', 'lstat']) {
    implementation.promises[name] = async (target, options) => mapped(await fs.promises[name](target, options), options);
  }
  implementation.promises.open = async (...args) => {
    const handle = await fs.promises.open(...args);
    const original = handle.stat.bind(handle);
    handle.stat = async (options) => mapped(await original(options), options);
    return handle;
  };
  return implementation;
}

async function verifyLargeArchiveIdentity(parentDirectory = os.tmpdir()) {
  const directory = fs.mkdtempSync(path.join(parentDirectory, 'archive-high-identity-'));
  const databasePath = path.join(directory, 'archive.sqlite');
  let db = new DatabaseSync(databasePath);
  const state = { blocked: false, target: '' };
  const fsImpl = largeIdentityFs(state);
  const rootDir = path.join(directory, 'archive');
  const create = () => createArchiveService({ database: db, rootDir, fsImpl });
  const service = create();
  try {
    const artifacts = [];
    for (const operationKey of ['first', 'second']) {
      const filePath = path.join(directory, `${operationKey}.xlsx`);
      fs.writeFileSync(filePath, 'identical content');
      const result = await service.archiveFile({ moduleId: 'bank-statement', moduleCode: 'BANK',
        moduleName: '网银账单', operationKey, filePath, role: 'output' });
      assert.equal(result.ok, true, JSON.stringify(result));
      artifacts.push(service.repository.getArtifact(result.artifact.id));
    }
    const [first, second] = artifacts;
    assert.equal(first.blob.id, second.blob.id);
    assert.ok(BigInt(first.storageFingerprint.ino) > BigInt(Number.MAX_SAFE_INTEGER));
    assert.throws(() => service.repository.refreshStorageFingerprint(first.id, {
      ...first.storageFingerprint, ino: Number(first.storageFingerprint.ino)
    }), /已丢失精度/);
    const opened = await service.openReadonlyCopy(first.id);
    assert.equal(opened.ok, true, JSON.stringify(opened));
    const prepared = await service.prepareDeleteBatch(first.batchId);
    assert.equal(prepared.ok, true, JSON.stringify(prepared));
    const deleted = await service.deleteBatch(first.batchId, { expectedRevision: prepared.revision });
    assert.equal(deleted.fullyDeleted, true, JSON.stringify(deleted));
    assert.equal(fs.existsSync(opened.filePath), false);
    assert.equal(fs.existsSync(path.join(rootDir, second.blob.relativePath)), true);
    state.target = path.join(rootDir, second.storageRelativePath); state.blocked = true;
    const pending = await service.deleteBatch(second.batchId);
    assert.equal(pending.metadataDeleted, true, JSON.stringify(pending));
    assert.equal(pending.fullyDeleted, false);
    const original = readIdentityStatSync(fsImpl, state.target);
    const replacement = path.join(directory, 'replacement.xlsx');
    fs.writeFileSync(replacement, 'identical content');
    // Windows 只读目标不能被 rename 覆盖；仅在隔离夹具中模拟外部替换者先修改权限。
    fs.chmodSync(state.target, 0o600);
    fs.renameSync(replacement, state.target);
    const replaced = readIdentityStatSync(fsImpl, state.target);
    assert.notEqual(original.ino, replaced.ino);
    assert.equal(Number(original.ino), Number(replaced.ino), '该替换不能用已舍入 Number 区分');
    state.blocked = false;
    await service.pauseBackgroundMaterialization();
    db.close();
    db = new DatabaseSync(databasePath);
    const restarted = create();
    const retried = await restarted.retryDeleteCleanupJob(pending.cleanupJobId);
    assert.equal(retried.fullyDeleted, false, JSON.stringify(retried));
    assert.equal(fs.readFileSync(state.target, 'utf8'), 'identical content');
    assert.equal(restarted.repository.listCleanupJobs().length, 1);
    assert.equal(restarted.repository.getDeletionReceipt(second.batchId), null);
    return { identitySource: 'injected-high-bits', readonlyDeleted: true, sharedBlobPreserved: true,
      databaseReopened: true, replacementPreserved: true, originalInode: original.ino, replacementInode: replaced.ino };
  } finally { db.close(); fs.rmSync(directory, { recursive: true, force: true }); }
}

module.exports = { verifyLargeArchiveIdentity };
