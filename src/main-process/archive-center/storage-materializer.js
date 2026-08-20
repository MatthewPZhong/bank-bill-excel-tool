'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { pipeline } = require('node:stream/promises');

const { resolveManagedRelative } = require('./storage-layout');
const {
  sourceSnapshotFromStat,
  sourceSnapshotMatchesStat
} = require('./source-snapshot');

class StorageMaterializationError extends Error {
  constructor(code, message, options = {}) {
    super(message);
    this.name = 'StorageMaterializationError';
    this.code = code;
    this.cause = options.cause;
  }
}

async function hashFile(filePath, fsModule = fs) {
  const digest = crypto.createHash('sha256');
  let sizeBytes = 0;
  for await (const chunk of fsModule.createReadStream(filePath)) {
    sizeBytes += chunk.length;
    digest.update(chunk);
  }
  return { sha256: digest.digest('hex'), sizeBytes };
}

async function verifyFile(filePath, expected, fsModule = fs) {
  try {
    const before = await fsModule.promises.lstat(filePath, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink()
        || Number(before.size) !== Number(expected.sizeBytes)) {
      return { valid: false, code: 'ARCHIVE_LAYOUT_SIZE_MISMATCH' };
    }
    const beforeSnapshot = sourceSnapshotFromStat(before);
    const actual = await hashFile(filePath, fsModule);
    const stat = await fsModule.promises.lstat(filePath, { bigint: true });
    if (!beforeSnapshot || !sourceSnapshotMatchesStat(beforeSnapshot, stat)) {
      return { valid: false, code: 'ARCHIVE_LAYOUT_CHANGED_DURING_READ' };
    }
    if (actual.sizeBytes !== Number(expected.sizeBytes) || actual.sha256 !== expected.sha256) {
      return { valid: false, code: 'ARCHIVE_LAYOUT_HASH_MISMATCH', actual };
    }
    return { valid: true, actual, stat };
  } catch (error) {
    return {
      valid: false,
      code: error && error.code === 'ENOENT' ? 'ARCHIVE_LAYOUT_MISSING' : 'ARCHIVE_LAYOUT_READ_FAILED',
      error
    };
  }
}

async function copyStream(sourcePath, targetPath, fsModule) {
  await pipeline(
    fsModule.createReadStream(sourcePath),
    fsModule.createWriteStream(targetPath, { flags: 'wx', mode: 0o600 })
  );
}

async function syncStagedFile(fsModule, filePath) {
  // Windows 的 FlushFileBuffers 要求可写句柄；这里只接收本任务刚创建且尚未
  // 发布的 staging 文件，r+ 仅提供句柄权限，不会修改文件内容。
  const handle = await fsModule.promises.open(filePath, 'r+');
  try { await handle.sync(); } finally { await handle.close(); }
}

async function syncDirectory(fsModule, directory) {
  let handle;
  try {
    handle = await fsModule.promises.open(directory, 'r');
    await handle.sync();
  } catch (error) {
    if (!error || !['EINVAL', 'EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) throw error;
  } finally {
    if (handle) await handle.close();
  }
}

async function removeEmptyParents(fsModule, startDir, stopDir) {
  let current = path.resolve(startDir);
  const root = path.resolve(stopDir);
  while (current !== root && current.startsWith(`${root}${path.sep}`)) {
    try {
      await fsModule.promises.rmdir(current);
    } catch (error) {
      if (error && ['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) return;
      throw error;
    }
    current = path.dirname(current);
  }
}

async function assertNoSymlinkAncestors(fsModule, rootDir, targetDir) {
  const rootStat = await fsModule.promises.lstat(rootDir);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new StorageMaterializationError(
      'ARCHIVE_LAYOUT_PATH_INVALID',
      '存档根不能是符号链接或目录联接'
    );
  }
  const relative = path.relative(rootDir, targetDir);
  let current = rootDir;
  for (const part of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try {
      const stat = await fsModule.promises.lstat(current);
      if (stat.isSymbolicLink()) {
        throw new StorageMaterializationError(
          'ARCHIVE_LAYOUT_PATH_INVALID',
          '目录化路径不能经过符号链接'
        );
      }
    } catch (error) {
      if (error && error.code === 'ENOENT') break;
      throw error;
    }
  }
}

function createStorageMaterializer(options = {}) {
  const fsModule = options.fs || fs;
  const rootDir = path.resolve(options.rootDir || '');
  const stagingDir = path.resolve(options.stagingDir || path.join(rootDir, '.staging'));
  const materializeCopyFile = options.materializeCopyFile
    || ((source, target) => copyStream(source, target, fsModule));

  async function materialize(payload) {
    const targetPath = resolveManagedRelative(rootDir, payload.storageRelativePath);
    const canonicalPath = path.resolve(payload.canonicalPath);
    const expected = {
      sha256: String(payload.sha256 || '').toLowerCase(),
      sizeBytes: Number(payload.sizeBytes)
    };
    const canonical = await verifyFile(canonicalPath, expected, fsModule);
    if (!canonical.valid) {
      throw new StorageMaterializationError(
        'ARCHIVE_BLOB_INVALID',
        'canonical Blob 大小或哈希不一致',
        { cause: canonical.error }
      );
    }

    await assertNoSymlinkAncestors(fsModule, rootDir, stagingDir);
    await fsModule.promises.mkdir(stagingDir, { recursive: true });
    const stagedPath = path.join(stagingDir, `materialized-${Number(payload.artifactId)}-${crypto.randomUUID()}.part`);
    let targetParentCreated = false;
    try {
      // 用户可见的批次文件必须与 canonical Blob 拥有独立 inode。
      // chmod 只能降低误写概率，hardlink 不能提供内容隔离。
      await materializeCopyFile(canonicalPath, stagedPath);

      const staged = await verifyFile(stagedPath, expected, fsModule);
      if (!staged.valid) {
        throw new StorageMaterializationError(
          'ARCHIVE_MATERIALIZATION_VERIFY_FAILED',
          '目录化文件大小或哈希校验失败',
          { cause: staged.error }
        );
      }
      await syncStagedFile(fsModule, stagedPath);
      await fsModule.promises.chmod(stagedPath, 0o444);
      await assertNoSymlinkAncestors(fsModule, rootDir, path.dirname(targetPath));
      await fsModule.promises.mkdir(path.dirname(targetPath), { recursive: true });
      targetParentCreated = true;
      await fsModule.promises.rename(stagedPath, targetPath);
      await syncDirectory(fsModule, path.dirname(targetPath));
      return { mode: 'copy', targetPath, storageRelativePath: payload.storageRelativePath };
    } catch (error) {
      try { await fsModule.promises.rm(stagedPath, { force: true }); } catch (_cleanupError) {}
      if (targetParentCreated) {
        try { await removeEmptyParents(fsModule, path.dirname(targetPath), rootDir); } catch (_cleanupError) {}
      }
      if (error instanceof StorageMaterializationError) throw error;
      throw new StorageMaterializationError(
        'ARCHIVE_MATERIALIZATION_FAILED',
        `目录化失败（${error && error.code ? error.code : 'UNKNOWN'}）`,
        { cause: error }
      );
    }
  }

  async function remove(relativePath) {
    const targetPath = resolveManagedRelative(rootDir, relativePath);
    await assertNoSymlinkAncestors(fsModule, rootDir, path.dirname(targetPath));
    await fsModule.promises.rm(targetPath, { force: true });
  }

  return {
    materialize,
    remove,
    async verify(relativePath, expected) {
      const targetPath = resolveManagedRelative(rootDir, relativePath);
      await assertNoSymlinkAncestors(fsModule, rootDir, path.dirname(targetPath));
      return verifyFile(targetPath, expected, fsModule);
    },
    async verifyMetadata(relativePath, expected) {
      const targetPath = resolveManagedRelative(rootDir, relativePath);
      await assertNoSymlinkAncestors(fsModule, rootDir, path.dirname(targetPath));
      try {
        const stat = await fsModule.promises.lstat(targetPath, { bigint: true });
        if (!stat.isFile()
            || stat.isSymbolicLink()
            || Number(stat.size) !== Number(expected.sizeBytes)) {
          return { valid: false, code: 'ARCHIVE_LAYOUT_SIZE_MISMATCH' };
        }
        return { valid: true, stat };
      } catch (error) {
        return {
          valid: false,
          code: error && error.code === 'ENOENT'
            ? 'ARCHIVE_LAYOUT_MISSING'
            : 'ARCHIVE_LAYOUT_READ_FAILED',
          error
        };
      }
    }
  };
}

module.exports = {
  StorageMaterializationError,
  createStorageMaterializer,
  hashFile,
  syncStagedFile,
  verifyFile
};
