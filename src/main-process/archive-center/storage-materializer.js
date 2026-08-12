'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { pipeline } = require('node:stream/promises');

const { resolveManagedRelative } = require('./storage-layout');

const HARDLINK_FALLBACK_CODES = new Set([
  'EXDEV',
  'EACCES',
  'EPERM',
  'ENOTSUP',
  'EOPNOTSUPP',
  'ENOSYS',
  'EMLINK'
]);

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
    const stat = await fsModule.promises.lstat(filePath);
    if (!stat.isFile() || stat.isSymbolicLink() || Number(stat.size) !== Number(expected.sizeBytes)) {
      return { valid: false, code: 'ARCHIVE_LAYOUT_SIZE_MISMATCH' };
    }
    const actual = await hashFile(filePath, fsModule);
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
  const linkFile = options.linkFile || ((source, target) => fsModule.promises.link(source, target));

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
    let mode = 'hardlink';
    let targetParentCreated = false;
    try {
      try {
        await linkFile(canonicalPath, stagedPath);
      } catch (error) {
        if (!HARDLINK_FALLBACK_CODES.has(error && error.code)) throw error;
        mode = 'copy';
        await copyStream(canonicalPath, stagedPath, fsModule);
      }

      const staged = await verifyFile(stagedPath, expected, fsModule);
      if (!staged.valid) {
        throw new StorageMaterializationError(
          'ARCHIVE_MATERIALIZATION_VERIFY_FAILED',
          '目录化文件大小或哈希校验失败',
          { cause: staged.error }
        );
      }
      await fsModule.promises.chmod(stagedPath, 0o444);
      await assertNoSymlinkAncestors(fsModule, rootDir, path.dirname(targetPath));
      await fsModule.promises.mkdir(path.dirname(targetPath), { recursive: true });
      targetParentCreated = true;
      await fsModule.promises.rename(stagedPath, targetPath);
      return { mode, targetPath, storageRelativePath: payload.storageRelativePath };
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
        const stat = await fsModule.promises.lstat(targetPath);
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
  HARDLINK_FALLBACK_CODES,
  StorageMaterializationError,
  createStorageMaterializer,
  hashFile,
  verifyFile
};
