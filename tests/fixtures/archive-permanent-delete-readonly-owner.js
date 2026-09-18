'use strict';

// 真实文件任务与确认删除流程；替换及进程重启均限于调用方提供的隔离目录。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { Readable } = require('node:stream');
const { DatabaseSync } = require('node:sqlite');

const READONLY_OWNER_REPLACEMENTS = ['after-create', 'after-rename', 'after-capture', 'parent-after-capture'];
const SOURCE_BYTES = 'date,amount\n2026-09-15,1\n';

function openRuntime(directory, sourceRoot, fsImpl = fs) {
  const { createArchiveService } = require(path.join(sourceRoot, 'src/main-process/archive-center/archive-service'));
  const { createArchiveCenterController } = require(path.join(sourceRoot, 'src/main-process/archive-center/controller'));
  const { createArchiveOutboxStore } = require(path.join(sourceRoot, 'src/main-process/archive-center/outbox-store'));
  const db = new DatabaseSync(path.join(directory, 'archive.sqlite'));
  db.exec('PRAGMA foreign_keys = ON');
  const service = createArchiveService({ database: db, rootDir: path.join(directory, 'archive'), fsImpl });
  const controller = createArchiveCenterController({ database: { getSetting: () => null, setSetting() {} }, service,
    outboxStore: createArchiveOutboxStore(path.join(directory, 'outbox')) });
  service.runDeleteWithOwnerGuard = (batchId, operation, payload) => controller.runDeleteWithOwnerGuard(batchId, operation, payload);
  return { db, service, controller };
}

async function closeRuntime(runtime) {
  await runtime.service.pauseBackgroundMaterialization();
  runtime.db.close();
}

async function assertDeletionBlocked(runtime, observation) {
  const { service, controller } = runtime;
  const prepared = await controller.prepareDeleteBatch(observation.batchId);
  assert.notEqual(prepared.ok, true, JSON.stringify(prepared));
  assert.equal(prepared.status, 'failed', JSON.stringify(prepared));
  assert.equal(prepared.code, 'ARCHIVE_DELETE_TEMP_OWNER_PENDING', JSON.stringify(prepared));
  const deleted = await controller.deleteBatch(observation.batchId, observation.originalToken);
  assert.notEqual(deleted.ok, true, JSON.stringify(deleted));
  assert.equal(deleted.status, 'failed', JSON.stringify(deleted));
  assert.notEqual(deleted.fullyDeleted, true);
  assert.ok(service.repository.getBatch(observation.batchId));
  assert.equal(service.repository.getCleanupJobForBatch(observation.batchId), null);
  assert.equal(service.repository.getDeletionReceipt(observation.batchId), null);
  const owners = service.repository.listOwnedTemporaryFiles(observation.batchId);
  assert.equal(owners.length, 2);
  assert.ok(owners.every((owner) => owner.state === 'creating'), JSON.stringify(owners));
  assert.equal(String(fs.statSync(observation.replacementPath).ino), observation.replacementInode);
  assert.equal(fs.readFileSync(observation.replacementPath, 'utf8'), SOURCE_BYTES);
  assert.equal(fs.readFileSync(path.join(observation.directory, 'template.csv'), 'utf8'), SOURCE_BYTES);
  return owners;
}

async function verifyRestart(directory, sourceRoot) {
  const observation = JSON.parse(fs.readFileSync(path.join(directory, 'readonly-observation.json'), 'utf8'));
  const runtime = openRuntime(directory, sourceRoot);
  try {
    assert.equal((await runtime.controller.initialize()).ok, true);
    if (observation.replacement) {
      assert.deepEqual(await assertDeletionBlocked(runtime, observation), observation.owners);
      return { restarted: true, deletionBlocked: true, replacementPreserved: true };
    }
    const owners = runtime.service.repository.listOwnedTemporaryFiles(observation.batchId);
    assert.deepEqual(owners, observation.owners);
    const prepared = await runtime.controller.prepareDeleteBatch(observation.batchId);
    assert.equal(prepared.ok, true, JSON.stringify(prepared));
    const deleted = await runtime.controller.deleteBatch(observation.batchId, prepared.confirmationToken);
    assert.equal(deleted.fullyDeleted, true, JSON.stringify(deleted));
    assert.equal(fs.existsSync(observation.readonlyPath), false);
    assert.equal(runtime.service.repository.getBatch(observation.batchId), null);
    assert.equal(fs.readFileSync(path.join(directory, 'template.csv'), 'utf8'), SOURCE_BYTES);
    return { restarted: true, confirmedDeletionCompleted: true, externalPreserved: true };
  } finally { await closeRuntime(runtime); }
}

async function verifyReadonlyOwnerIdentity(parentDirectory, options = {}) {
  const sourceRoot = options.sourceRoot || path.resolve(__dirname, '../..');
  const replacement = options.replacement || null;
  assert.ok(replacement === null || READONLY_OWNER_REPLACEMENTS.includes(replacement));
  const directory = fs.mkdtempSync(path.join(parentDirectory, 'readonly-owner-'));
  let runtime;
  let creationFd;
  let createdInode;
  let targetPath;
  let replacementPath;
  let replacementInode;
  let originalParentInode;
  let replacementParentInode;
  let injected = false;
  let finalHashStarted = false;
  let openerCalls = 0;
  let sentinelFd;
  let readErrorInjected = false;
  const assertFdClosed = () => {
    assert.equal(typeof creationFd, 'number');
    assert.throws(() => fs.fstatSync(creationFd), { code: 'EBADF' }, '创建句柄应在返回及打开副本前关闭');
  };
  function replaceObject(filePath, replaceParent = false) {
    assert.equal(injected, false);
    injected = true;
    const priorInode = String(fs.statSync(filePath).ino);
    if (replaceParent) {
      const parent = path.dirname(filePath);
      originalParentInode = String(fs.statSync(parent).ino);
      const displaced = path.join(directory, 'displaced-copy-directory');
      fs.renameSync(parent, displaced);
      fs.mkdirSync(parent);
      fs.renameSync(path.join(displaced, path.basename(filePath)), filePath);
      replacementParentInode = String(fs.statSync(parent).ino);
      assert.notEqual(replacementParentInode, originalParentInode);
      assert.equal(String(fs.statSync(filePath).ino), priorInode, '父目录替换保留原文件 inode');
    } else {
      const independent = path.join(directory, 'independent-copy.csv');
      fs.writeFileSync(independent, SOURCE_BYTES);
      fs.renameSync(independent, filePath);
      assert.notEqual(String(fs.statSync(filePath).ino), priorInode);
    }
    replacementPath = filePath;
    replacementInode = String(fs.statSync(filePath).ino);
  }
  const fsImpl = { ...fs,
    openSync(filePath, flags, ...args) {
      const fd = fs.openSync(filePath, flags, ...args);
      if (String(filePath).includes(`${path.sep}.readonly${path.sep}`) && flags === 'wx') {
        creationFd = fd;
        createdInode = String(fs.fstatSync(fd).ino);
        targetPath = String(filePath).slice(0, -4);
        if (replacement === 'after-create') replaceObject(filePath);
      }
      return fd;
    },
    createReadStream(filePath, ...args) {
      if (filePath === targetPath) finalHashStarted = true;
      if (options.readFailure && creationFd !== undefined && !readErrorInjected
          && !String(filePath).includes(`${path.sep}.readonly${path.sep}`)) {
        readErrorInjected = true;
        return new Readable({ read() { this.destroy(Object.assign(new Error('隔离夹具模拟源文件读取失败'), { code: 'EIO' })); } });
      }
      return fs.createReadStream(filePath, ...args);
    },
    createWriteStream(filePath, ...args) {
      const writer = fs.createWriteStream(filePath, ...args);
      if (options.readFailure && String(filePath).includes(`${path.sep}.readonly${path.sep}`)) {
        // 监听早于 service 的 close 监听：立即复用流已关闭的 fd，暴露 finally 重复 close。
        writer.once('close', () => {
          sentinelFd = fs.openSync(path.join(directory, 'sentinel.txt'), 'w+');
        });
      }
      return writer;
    },
    promises: { ...fs.promises,
      async rename(from, to) {
        await fs.promises.rename(from, to);
        if (to === targetPath && replacement === 'after-rename') replaceObject(to);
      },
      async lstat(filePath, ...args) {
        const stat = await fs.promises.lstat(filePath, ...args);
        if (!injected && finalHashStarted && filePath === targetPath
            && ['after-capture', 'parent-after-capture'].includes(replacement)) {
          // 返回原 capture 最后一次检查的结果，调用方恢复执行前替换路径。
          replaceObject(filePath, replacement === 'parent-after-capture');
        }
        return stat;
      }
    }
  };
  try {
    runtime = openRuntime(directory, sourceRoot, fsImpl);
    assert.equal((await runtime.service.initialize({ deferStartupRecovery: true, startBackgroundMaterialization: false })).ok, true);
    const { createTaskLifecycle } = require(path.join(sourceRoot, 'src/main-process/archive-center/task-lifecycle'));
    const { createTaskPolicyRegistry } = require(path.join(sourceRoot, 'src/main-process/archive-center/task-policy-registry'));
    const { normalizeFilePlanV1 } = require(path.join(sourceRoot, 'src/main-process/archive-center/file-plan'));
    const externalPath = path.join(directory, 'template.csv');
    fs.writeFileSync(externalPath, SOURCE_BYTES);
    const policy = createTaskPolicyRegistry().require('template:import');
    const lifecycle = createTaskLifecycle({ archiveService: runtime.service,
      businessOperationRegistry: { begin: () => ({ accepted: true, token: 'readonly-owner-task' }), end() {} },
      flowResolver: { resolve: async () => ({ parentRunId: 'readonly-owner-parent', source: 'new', identity: null }),
        bind: async () => [], persistBindIntent: async () => ({ ok: true }) },
      operationTracker: { appendOperationFiles: async () => ({ ok: true }) },
      persistTerminalIntent: (payload) => runtime.controller.persistTaskTerminalIntent(payload) });
    let batchContext;
    const result = await lifecycle.runFileTask({ policy, taskRunId: 'readonly-owner-task', operationKey: 'readonly-owner-operation',
      meta: { channel: policy.channel },
      filePlanResolver: () => normalizeFilePlanV1({ version: 1, allocation: 'eager',
        inputs: [{ filePath: externalPath, role: 'input', sourceOperation: policy.channel }], outputs: [] }),
      execute: async (context) => { batchContext = context; return { status: 'success' }; } });
    assert.equal(result.status, 'success');
    assert.ok(runtime.service.repository.getOwnerTerminalCompletion({ version: 1, kind: 'file-batch', batchContext }));
    const originalConfirmation = await runtime.controller.prepareDeleteBatch(batchContext.batchId);
    assert.equal(originalConfirmation.ok, true, JSON.stringify(originalConfirmation));
    const artifact = runtime.service.repository.listArtifacts(batchContext.batchId)[0];
    const opened = await runtime.service.openReadonlyCopy(artifact.id, { opener: async () => {
      openerCalls += 1;
      assertFdClosed();
      return '';
    } });
    if (options.readFailure) {
      assert.equal(readErrorInjected, true);
      assert.equal(opened.ok, false, JSON.stringify(opened));
      assert.equal(opened.code, 'ARCHIVE_EIO', JSON.stringify(opened));
      assert.equal(openerCalls, 0);
      assert.equal(sentinelFd, creationFd, '错误流 close 后必须实际复用原 fd 编号');
      assert.ok(fs.fstatSync(sentinelFd).isFile(), 'service 不得重复关闭已由其他文件复用的 fd');
      fs.writeSync(sentinelFd, 'sentinel-still-open');
      assert.equal(fs.readFileSync(path.join(directory, 'sentinel.txt'), 'utf8'), 'sentinel-still-open');
      const owners = runtime.service.repository.listOwnedTemporaryFiles(batchContext.batchId);
      assert.equal(owners.length, 2);
      assert.ok(owners.every((owner) => owner.state === 'creating'));
      assert.equal(fs.readFileSync(externalPath, 'utf8'), SOURCE_BYTES);
      return { readFailure: true, creationFdReleased: true, reusedDescriptorPreserved: true, externalPreserved: true };
    }
    assertFdClosed();
    const observation = { directory, replacement, batchId: batchContext.batchId,
      originalToken: originalConfirmation.confirmationToken, readonlyPath: opened.filePath,
      replacementPath, replacementInode, createdInode, originalParentInode, replacementParentInode };
    if (replacement) {
      assert.equal(injected, true, `${replacement} 必须到达指定替换边界`);
      assert.equal(opened.ok, false, `${replacement} 不得登记替代对象：${JSON.stringify(opened)}`);
      assert.equal(opened.code, 'ARCHIVE_READONLY_FILE_CHANGED', JSON.stringify(opened));
      assert.equal(openerCalls, 0);
      observation.owners = await assertDeletionBlocked(runtime, observation);
    } else {
      assert.equal(opened.ok, true, JSON.stringify(opened));
      assert.equal(openerCalls, 1);
      observation.owners = runtime.service.repository.listOwnedTemporaryFiles(batchContext.batchId);
      assert.equal(observation.owners.length, 2);
      assert.ok(observation.owners.every((owner) => owner.state === 'ready'));
      const owner = observation.owners.find((item) => !item.managedRelativePath.endsWith('.tmp'));
      assert.equal(owner.expectedIdentity.ino, createdInode);
      assert.equal(String(fs.statSync(opened.filePath).ino), createdInode);
      assert.equal(fs.readFileSync(opened.filePath, 'utf8'), SOURCE_BYTES);
    }
    fs.writeFileSync(path.join(directory, 'readonly-observation.json'), JSON.stringify(observation));
    await closeRuntime(runtime);
    runtime = null;
    const child = spawnSync(process.execPath, [__filename, '--verify-restart', directory, sourceRoot],
      { encoding: 'utf8', timeout: 30000 });
    assert.equal(child.status, 0, `${child.error?.stack || ''}\n${child.stdout}\n${child.stderr}`);
    return { replacement, createdInode, replacementInode, originalParentInode, replacementParentInode,
      creationFdClosed: true, ...JSON.parse(child.stdout.trim()) };
  } finally {
    if (sentinelFd !== undefined) {
      try { fs.closeSync(sentinelFd); } catch (error) { if (error.code !== 'EBADF') throw error; }
    }
    if (runtime) await closeRuntime(runtime);
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

module.exports = { READONLY_OWNER_REPLACEMENTS, verifyReadonlyOwnerIdentity };
if (require.main === module && process.argv[2] === '--verify-restart') {
  verifyRestart(process.argv[3], process.argv[4]).then((result) => process.stdout.write(`${JSON.stringify(result)}\n`))
    .catch((error) => { process.stderr.write(`${error.stack || error}\n`); process.exitCode = 1; });
}
