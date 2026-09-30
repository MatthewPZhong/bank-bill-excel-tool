'use strict';

const { ResourceGovernorError } = require('./resource-lease');

const CONFIG_KEYS = Object.freeze([
  'version', 'profileId', 'policyDigest', 'phaseKey', 'phaseMemoryBytes', 'systemReserveBytes',
  'sstMemoryBytes', 'sstCacheBytes', 'styleCacheBytes', 'sqliteAggregateCacheBytes',
  'maxOpenConnections', 'maxInFlightBytes', 'maxSingleRecordBytes', 'workerLimits', 'validatedEvidenceId'
]);
const BYTE_KEYS = Object.freeze([
  'phaseMemoryBytes', 'systemReserveBytes', 'sstMemoryBytes', 'sstCacheBytes', 'styleCacheBytes',
  'sqliteAggregateCacheBytes', 'maxInFlightBytes', 'maxSingleRecordBytes'
]);

function invalid(message) {
  return new ResourceGovernorError('RESOURCE_MEMORY_CONFIG_INVALID', message);
}

function assertDataObject(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw invalid(label + '必须是普通对象');
  const actual = Reflect.ownKeys(value);
  if (actual.length !== keys.length || actual.some((key) => !keys.includes(key))) {
    throw invalid(label + '字段不符合固定合同');
  }
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
      throw invalid(label + '只接受可枚举数据字段');
    }
  }
}

function nonNegativeInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) throw invalid(name + '必须是非负安全整数');
  return value;
}

function identifier(value, name) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(value)) {
    throw invalid(name + '必须是受控技术标识');
  }
  return value;
}

function validateExecutionMemoryConfig(value) {
  assertDataObject(value, CONFIG_KEYS, 'ExecutionMemoryConfigV1');
  if (value.version !== 1) throw invalid('内存执行配置版本不支持');
  const result = { ...value };
  for (const name of ['profileId', 'phaseKey']) identifier(result[name], name);
  if (typeof result.policyDigest !== 'string' || !/^[a-f0-9]{64}$/.test(result.policyDigest)) {
    throw invalid('policyDigest 必须是配置的 SHA-256 摘要');
  }
  // null 表示实验配置；生产资格由 Main 的证据校验器另行授予。
  if (result.validatedEvidenceId !== null) identifier(result.validatedEvidenceId, 'validatedEvidenceId');
  for (const name of BYTE_KEYS) nonNegativeInteger(result[name], name);
  if (result.phaseMemoryBytes === 0) throw invalid('完整阶段预算必须大于零');
  nonNegativeInteger(result.maxOpenConnections, 'maxOpenConnections');
  for (const name of BYTE_KEYS.filter((key) => !['phaseMemoryBytes', 'systemReserveBytes'].includes(key))) {
    if (result[name] > result.phaseMemoryBytes) throw invalid(name + '不能超过完整阶段预算');
  }
  const cacheTotal = result.sstMemoryBytes + result.sstCacheBytes + result.styleCacheBytes +
    result.sqliteAggregateCacheBytes + result.maxInFlightBytes;
  if (!Number.isSafeInteger(cacheTotal) || cacheTotal > result.phaseMemoryBytes) {
    throw invalid('并存缓存与生产积压合计超过完整阶段预算');
  }
  if (result.workerLimits !== null) {
    const keys = ['maxOldGenerationSizeMb', 'maxYoungGenerationSizeMb'];
    assertDataObject(result.workerLimits, keys, 'workerLimits');
    for (const key of keys) {
      nonNegativeInteger(result.workerLimits[key], key);
      if (result.workerLimits[key] === 0 || result.workerLimits[key] * 1024 ** 2 > result.phaseMemoryBytes) {
        throw invalid('Worker 堆限制必须明确且不超过阶段预算');
      }
    }
    result.workerLimits = Object.freeze({ ...result.workerLimits });
  }
  return Object.freeze(result);
}

module.exports = { validateExecutionMemoryConfig };
