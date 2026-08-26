'use strict';

const os = require('node:os');

const MEBIBYTE = 1024 ** 2;
const GIBIBYTE = 1024 ** 3;
// E00把这两个值留给release配置。production门禁冻结前，hard ceiling沿用
// E05-B既有max(768MiB,totalmem/4)，reserve沿用仓库既有2GiB freemem gate；
// action不得自行反向扩容。
const COMPATIBILITY_MINIMUM_MEMORY_HARD_CEILING_BYTES = 768 * MEBIBYTE;
const DEFAULT_SYSTEM_RESERVE_BYTES = 2 * GIBIBYTE;

function positiveSafeInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
  return value;
}

function nonNegativeSafeInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative safe integer`);
  }
  return value;
}

function platformParallelism() {
  if (typeof os.availableParallelism === 'function') return os.availableParallelism();
  const cpus = typeof os.cpus === 'function' ? os.cpus() : [];
  return Array.isArray(cpus) && cpus.length > 0 ? cpus.length : 1;
}

function createPlatformResourceBudgets(options = {}) {
  const parallelism = positiveSafeInteger(
    options.availableParallelism === undefined
      ? platformParallelism()
      : options.availableParallelism,
    'availableParallelism'
  );
  const freeMemoryBytes = nonNegativeSafeInteger(
    options.freeMemoryBytes === undefined ? os.freemem() : options.freeMemoryBytes,
    'freeMemoryBytes'
  );
  const memoryHardCeilingBytes = options.memoryHardCeilingBytes === undefined
    ? Math.max(
        COMPATIBILITY_MINIMUM_MEMORY_HARD_CEILING_BYTES,
        Math.floor(positiveSafeInteger(
          options.totalMemoryBytes === undefined ? os.totalmem() : options.totalMemoryBytes,
          'totalMemoryBytes'
        ) / 4)
      )
    : nonNegativeSafeInteger(options.memoryHardCeilingBytes, 'memoryHardCeilingBytes');
  const systemReserveBytes = nonNegativeSafeInteger(
    options.systemReserveBytes === undefined
      ? DEFAULT_SYSTEM_RESERVE_BYTES
      : options.systemReserveBytes,
    'systemReserveBytes'
  );
  const cpuSlots = Math.max(1, Math.min(4, parallelism - 2));
  return Object.freeze({
    cpuSlots,
    workerThreadSlots: Math.max(1, cpuSlots + 1),
    utilityProcessSlots: 1,
    ioHeavySlots: 2,
    memoryBytes: Math.min(
      memoryHardCeilingBytes,
      Math.max(0, freeMemoryBytes - systemReserveBytes)
    )
  });
}

module.exports = {
  COMPATIBILITY_MINIMUM_MEMORY_HARD_CEILING_BYTES,
  DEFAULT_SYSTEM_RESERVE_BYTES,
  createPlatformResourceBudgets
};
