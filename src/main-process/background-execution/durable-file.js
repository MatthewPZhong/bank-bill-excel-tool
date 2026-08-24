'use strict';

const fs = require('node:fs');
const path = require('node:path');

const DIRECTORY_FSYNC_UNSUPPORTED_CODES = new Set(['EINVAL', 'ENOSYS', 'ENOTSUP', 'EOPNOTSUPP']);

class DurabilityBarrierError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = 'DurabilityBarrierError';
    this.code = code;
    this.details = details;
  }
}

function fsyncDirectory(directoryPath, options = {}) {
  const fileSystem = options.fs || fs;
  let fd;
  try {
    fd = fileSystem.openSync(directoryPath, 'r');
    fileSystem.fsyncSync(fd);
    return Object.freeze({ capability: 'supported' });
  } catch (error) {
    if (error && DIRECTORY_FSYNC_UNSUPPORTED_CODES.has(error.code)) {
      return Object.freeze({ capability: 'unsupported', errorCode: error.code });
    }
    throw new DurabilityBarrierError(
      'DURABILITY_DIRECTORY_FSYNC_FAILED',
      'directory fsync 失败，不能宣称 target post-image durable',
      { errorCode: error && error.code ? error.code : 'UNKNOWN' }
    );
  } finally {
    if (fd !== undefined) {
      try { fileSystem.closeSync(fd); } catch (_closeError) { /* 原始 fsync 结果优先。 */ }
    }
  }
}

function writeFileAtomicDurable(targetPath, content, options = {}) {
  const fileSystem = options.fs || fs;
  const bytes = Buffer.isBuffer(content) ? content : Buffer.from(String(content), 'utf8');
  const directory = path.dirname(targetPath);
  const tempPath = `${targetPath}.tmp-${process.pid}-${Date.now()}`;
  let fd;
  try {
    fileSystem.mkdirSync(directory, { recursive: true });
    fd = fileSystem.openSync(tempPath, 'wx', 0o600);
    fileSystem.writeFileSync(fd, bytes);
    fileSystem.fsyncSync(fd);
    fileSystem.closeSync(fd);
    fd = undefined;
    fileSystem.renameSync(tempPath, targetPath);
    const directoryBarrier = fsyncDirectory(directory, { fs: fileSystem });
    if (directoryBarrier.capability !== 'supported') {
      return Object.freeze({
        status: 'durability-unavailable',
        targetPath,
        directoryFsync: directoryBarrier
      });
    }
    return Object.freeze({ status: 'committed', targetPath, directoryFsync: directoryBarrier });
  } catch (error) {
    if (error instanceof DurabilityBarrierError) throw error;
    throw new DurabilityBarrierError(
      'DURABILITY_ATOMIC_REPLACE_FAILED',
      'temp write/fsync/atomic rename 失败',
      { errorCode: error && error.code ? error.code : 'UNKNOWN' }
    );
  } finally {
    if (fd !== undefined) {
      try { fileSystem.closeSync(fd); } catch (_closeError) { /* 原始错误优先。 */ }
    }
    try {
      if (fileSystem.existsSync(tempPath)) fileSystem.unlinkSync(tempPath);
    } catch (_cleanupError) {
      // temp 清理失败不能覆盖 durability 结论；调用者仍会因原错误/unsupported fail closed。
    }
  }
}

module.exports = {
  DIRECTORY_FSYNC_UNSUPPORTED_CODES,
  DurabilityBarrierError,
  fsyncDirectory,
  writeFileAtomicDurable
};
