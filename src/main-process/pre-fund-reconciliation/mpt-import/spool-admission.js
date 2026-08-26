'use strict';

const fs = require('node:fs');
const path = require('node:path');

const MEBIBYTE = 1024 * 1024;
const SPOOL_EXPANSION_NUMERATOR = 5;
const SPOOL_EXPANSION_DENOMINATOR = 1;
const FIXED_SAFETY_BYTES = 64 * MEBIBYTE;
const PER_FILE_SAFETY_BYTES = MEBIBYTE;

function admissionError(code, message, cause) {
  const error = Object.assign(new Error(message), { code });
  if (cause && typeof cause.code === 'string' && /^[A-Z0-9_]{1,80}$/.test(cause.code)) {
    error.causeCode = cause.code;
  }
  return error;
}

function checkedSafeNumber(value, code, message) {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw admissionError(code, message);
  }
  return Number(value);
}

function estimateMptSpoolBytes(sourceSizes) {
  if (!Array.isArray(sourceSizes) || sourceSizes.length < 1) {
    throw new TypeError('spool估算需要非空sourceSizes');
  }
  let sourceBytes = 0n;
  for (const size of sourceSizes) {
    if (!Number.isSafeInteger(size) || size < 0) {
      throw admissionError('PREFUND_SPOOL_ESTIMATE_INVALID', 'spool source size必须是非负安全整数');
    }
    sourceBytes += BigInt(size);
  }
  const expanded = sourceBytes * BigInt(SPOOL_EXPANSION_NUMERATOR) /
    BigInt(SPOOL_EXPANSION_DENOMINATOR);
  const estimate = expanded + BigInt(FIXED_SAFETY_BYTES) +
    BigInt(sourceSizes.length) * BigInt(PER_FILE_SAFETY_BYTES);
  return checkedSafeNumber(
    estimate,
    'PREFUND_SPOOL_ESTIMATE_OVERFLOW',
    'spool磁盘估算超出安全整数范围'
  );
}

function nearestExistingDirectory(targetPath, fsImpl = fs) {
  let candidate = path.resolve(targetPath);
  while (!fsImpl.existsSync(candidate)) {
    const parent = path.dirname(candidate);
    if (parent === candidate) break;
    candidate = parent;
  }
  return candidate;
}

function getAvailableDiskBytes(targetPath, fsImpl = fs) {
  try {
    const existing = nearestExistingDirectory(targetPath, fsImpl);
    const stat = fsImpl.statfsSync(existing, { bigint: true });
    const available = BigInt(stat.bavail) * BigInt(stat.bsize);
    return checkedSafeNumber(
      available > BigInt(Number.MAX_SAFE_INTEGER) ? BigInt(Number.MAX_SAFE_INTEGER) : available,
      'PREFUND_SPOOL_DISK_CHECK_FAILED',
      '无法安全读取spool可用磁盘空间'
    );
  } catch (cause) {
    if (cause && cause.code === 'PREFUND_SPOOL_DISK_CHECK_FAILED') throw cause;
    throw admissionError(
      'PREFUND_SPOOL_DISK_CHECK_FAILED',
      '无法读取spool可用磁盘空间',
      cause
    );
  }
}

function assertMptSpoolDiskCapacity(options = {}) {
  if (typeof options.taskStagingDir !== 'string' || !options.taskStagingDir) {
    throw new TypeError('spool磁盘预检需要taskStagingDir');
  }
  const requiredBytes = estimateMptSpoolBytes(options.sourceSizes);
  const availableProvider = options.getAvailableDiskBytes || getAvailableDiskBytes;
  if (typeof availableProvider !== 'function') {
    throw new TypeError('getAvailableDiskBytes必须是函数');
  }
  let availableBytes;
  try {
    availableBytes = availableProvider(options.taskStagingDir);
  } catch (cause) {
    if (cause && cause.code === 'PREFUND_SPOOL_DISK_CHECK_FAILED') throw cause;
    throw admissionError('PREFUND_SPOOL_DISK_CHECK_FAILED', '无法读取spool可用磁盘空间', cause);
  }
  if (!Number.isSafeInteger(availableBytes) || availableBytes < 0) {
    throw admissionError('PREFUND_SPOOL_DISK_CHECK_FAILED', 'spool可用磁盘空间结果非法');
  }
  if (availableBytes < requiredBytes) {
    throw admissionError(
      'PREFUND_SPOOL_DISK_INSUFFICIENT',
      `spool可用磁盘空间不足（需要${requiredBytes} bytes，可用${availableBytes} bytes）`
    );
  }
  return Object.freeze({ requiredBytes, availableBytes });
}

module.exports = {
  FIXED_SAFETY_BYTES,
  PER_FILE_SAFETY_BYTES,
  SPOOL_EXPANSION_NUMERATOR,
  assertMptSpoolDiskCapacity,
  estimateMptSpoolBytes,
  getAvailableDiskBytes
};
