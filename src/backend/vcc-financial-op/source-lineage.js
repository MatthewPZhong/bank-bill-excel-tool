'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

function sourceIdentity(source) {
  const importSourceId = Number(source && source.importSourceId);
  const sourceOrdinal = Number(source && source.sourceOrdinal);
  const filePath = String(source && source.filePath || '');
  const fileName = String(source && source.fileName || path.basename(filePath));
  return {
    importSourceId: Number.isSafeInteger(importSourceId) && importSourceId > 0
      ? importSourceId
      : null,
    sourceOrdinal: Number.isSafeInteger(sourceOrdinal) && sourceOrdinal > 0
      ? sourceOrdinal
      : null,
    fileName
  };
}

function attachSourceIdentity(error, source) {
  const target = error && typeof error === 'object' ? error : new Error(String(error));
  const identity = sourceIdentity(source);
  if (identity.importSourceId !== null) target.importSourceId = identity.importSourceId;
  if (identity.sourceOrdinal !== null) target.sourceOrdinal = identity.sourceOrdinal;
  target.fileName = identity.fileName;
  if (!target.sourceFile) target.sourceFile = identity.fileName;
  target.context = {
    ...(target.context && typeof target.context === 'object' ? target.context : {}),
    ...(identity.importSourceId === null ? {} : { importSourceId: identity.importSourceId }),
    ...(identity.sourceOrdinal === null ? {} : { sourceOrdinal: identity.sourceOrdinal }),
    fileName: identity.fileName
  };
  return target;
}

function sourceIdentityFromError(error) {
  const context = error && error.context && typeof error.context === 'object'
    ? error.context
    : {};
  return {
    importSourceId: error && error.importSourceId != null
      ? error.importSourceId
      : context.importSourceId,
    sourceOrdinal: error && error.sourceOrdinal != null
      ? error.sourceOrdinal
      : context.sourceOrdinal,
    fileName: String(
      error && (error.fileName || error.sourceFile)
        || context.fileName
        || ''
    )
  };
}

async function hashSourceFile(filePath) {
  const resolvedPath = path.resolve(String(filePath || ''));
  const before = await fs.promises.stat(resolvedPath);
  if (!before.isFile()) throw new Error(`VCC 导入来源不是普通文件：${path.basename(resolvedPath)}`);
  const digest = crypto.createHash('sha256');
  let sizeBytes = 0;
  await new Promise((resolve, reject) => {
    const stream = fs.createReadStream(resolvedPath);
    stream.on('data', (chunk) => {
      digest.update(chunk);
      sizeBytes += chunk.length;
    });
    stream.once('error', reject);
    stream.once('end', resolve);
  });
  const after = await fs.promises.stat(resolvedPath);
  if (!after.isFile()
      || Number(before.size) !== sizeBytes
      || Number(after.size) !== sizeBytes
      || Number(before.mtimeMs) !== Number(after.mtimeMs)
      || Number(before.ctimeMs) !== Number(after.ctimeMs)) {
    const error = new Error(`读取期间原表发生变化：${path.basename(resolvedPath)}`);
    error.code = 'vcc-source-changed';
    throw error;
  }
  return Object.freeze({
    filePath: resolvedPath,
    fileName: path.basename(resolvedPath),
    sha256: digest.digest('hex'),
    sizeBytes
  });
}

function hashSourceFileSync(filePath) {
  const resolvedPath = path.resolve(String(filePath || ''));
  const before = fs.statSync(resolvedPath);
  if (!before.isFile()) throw new Error(`VCC 导入来源不是普通文件：${path.basename(resolvedPath)}`);
  const digest = crypto.createHash('sha256');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  let sizeBytes = 0;
  let fd;
  try {
    fd = fs.openSync(resolvedPath, 'r');
    for (;;) {
      const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      digest.update(buffer.subarray(0, bytesRead));
      sizeBytes += bytesRead;
    }
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
  const after = fs.statSync(resolvedPath);
  if (!after.isFile()
      || Number(before.size) !== sizeBytes
      || Number(after.size) !== sizeBytes
      || Number(before.mtimeMs) !== Number(after.mtimeMs)
      || Number(before.ctimeMs) !== Number(after.ctimeMs)) {
    const error = new Error(`读取期间原表发生变化：${path.basename(resolvedPath)}`);
    error.code = 'vcc-source-changed';
    throw error;
  }
  return Object.freeze({
    filePath: resolvedPath,
    fileName: path.basename(resolvedPath),
    sha256: digest.digest('hex'),
    sizeBytes
  });
}

function assertSourceFileMatchesSync(source) {
  let actual;
  try {
    actual = hashSourceFileSync(source && source.filePath);
  } catch (error) {
    throw attachSourceIdentity(error, source);
  }
  const expectedSha256 = String(source && source.sha256 || '').trim().toLowerCase();
  const expectedSizeBytes = Number(source && source.sizeBytes);
  if (actual.sha256 !== expectedSha256 || actual.sizeBytes !== expectedSizeBytes) {
    const error = new Error(`读取期间原表发生变化：${actual.fileName}`);
    error.code = 'vcc-source-changed';
    throw attachSourceIdentity(error, source);
  }
  return actual;
}

async function hashSourceFiles(files) {
  const result = [];
  for (const file of Array.isArray(files) ? files : []) {
    if (!file || typeof file !== 'object') throw new TypeError('VCC 导入来源描述无效');
    const lineage = await hashSourceFile(file.filePath);
    result.push(Object.freeze({ ...file, ...lineage }));
  }
  return Object.freeze(result);
}

module.exports = {
  attachSourceIdentity,
  assertSourceFileMatchesSync,
  hashSourceFile,
  hashSourceFileSync,
  hashSourceFiles,
  sourceIdentity,
  sourceIdentityFromError
};
