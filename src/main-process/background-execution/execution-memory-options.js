'use strict';

const path = require('node:path');
const os = require('node:os');
const { validateExecutionMemoryConfig } = require('./execution-memory-config');

function toolboxReaderOptions(config, privateDirectory) {
  const checked = config ? validateExecutionMemoryConfig(config) : null;
  if (!path.isAbsolute(privateDirectory || '')) throw new TypeError('低内存读取需要任务私有目录');
  return {
    sharedStringsMode: 'adaptive', sstTempRoot: path.join(privateDirectory, 'sst'),
    memoryBudgetBytes: checked ? checked.sstMemoryBytes : 8 * 1024 ** 2,
    cacheMaxBytes: checked ? checked.sstCacheBytes : 8 * 1024 ** 2,
    maxRowBytes: checked ? checked.maxSingleRecordBytes : 4 * 1024 ** 2,
    ...(checked ? { metadataLimits: { styles: checked.styleCacheBytes, theme: Math.min(checked.styleCacheBytes, 2 * 1024 ** 2) } } : {})
  };
}

function richReaderBudgets(config) {
  if (!config) return {};
  return { memoryBudgetBytes: config.sstMemoryBytes, cacheMaxBytes: config.sstCacheBytes,
    maxRowBytes: config.maxSingleRecordBytes,
    metadataLimits: { styles: config.styleCacheBytes, theme: Math.min(config.styleCacheBytes, 2 * 1024 ** 2) } };
}

function candidateWriterBudgets(config) {
  return config ? { maxChargedBytesPerTransaction: Math.min(config.maxInFlightBytes, config.maxSingleRecordBytes) } : {};
}

const lastChecks = new WeakMap();
function checkExecutionMemory(config, memory, availableBytes) {
  if (!config) return memory || null;
  let sampledAt;
  if (!memory) {
    const timestamp = Date.now();
    const previous = lastChecks.get(config);
    if (previous && timestamp >= previous.at && timestamp - previous.at < 50) return previous.memory;
    memory = process.memoryUsage();
    availableBytes = os.freemem();
    sampledAt = timestamp;
  }
  // external 已含 arrayBuffers；RSS 是进程合计，不能当作一个 Worker 的内存。
  const usedBytes = memory.heapUsed + memory.external;
  if (usedBytes > config.phaseMemoryBytes) {
    throw Object.assign(new Error('当前阶段内存超出获批额度，请释放其他程序占用后重试'), {
      code: 'EXECUTION_MEMORY_LIMIT_EXCEEDED'
    });
  }
  // 该安全点只停止新输入；发布关键区仍由原 journal/恢复协议收口。
  if (availableBytes !== undefined && availableBytes < Math.min(64 * 1024 ** 2, config.systemReserveBytes / 4)) {
    throw Object.assign(new Error('系统可用内存已降至安全余量以下，本阶段已停止，请释放其他程序占用后重试'), {
      code: 'EXECUTION_SYSTEM_MEMORY_PRESSURE'
    });
  }
  if (sampledAt !== undefined) lastChecks.set(config, { at: sampledAt, memory });
  return memory;
}

function sqliteCacheKiB(config, connections = 1) {
  if (!config) return 8192;
  if (!Number.isSafeInteger(connections) || connections < 1 || connections > config.maxOpenConnections) {
    throw Object.assign(new Error('SQLite 并存连接数超过获批配置'), { code: 'EXECUTION_SQLITE_CONNECTION_LIMIT' });
  }
  return Math.max(1, Math.floor(config.sqliteAggregateCacheBytes / connections / 1024));
}

module.exports = { toolboxReaderOptions, richReaderBudgets, candidateWriterBudgets, checkExecutionMemory, sqliteCacheKiB };
