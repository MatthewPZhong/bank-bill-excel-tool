'use strict';

const { ResourceGovernorError, validateResourceVector } = require('./resource-lease');
const { validateExecutionMemoryConfig } = require('./execution-memory-config');

const policies = new WeakSet();

function error(code, message) { return new ResourceGovernorError(code, message); }

function checkedBytes(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw error('RESOURCE_MEMORY_CONFIG_INVALID', name + '必须是非负安全整数');
  }
  return value;
}

// 此工厂供 Main 静态装配调用。resolver 从登记事实获得资格，不读取请求中的 profile/预算开关。
// 没有接入 inventory 与真实容量证据时，候选不会获得执行资格。
function createMemoryAdmissionPolicy({
  compatibilityMemoryBytes,
  resolveRequest = () => null,
  isEvidenceValid = () => false,
  externalPressure = () => ({ inventoryComplete: false, blockers: [] }),
  sampleMemory,
  now = Date.now,
  sampleMaxAgeMs = 1000
} = {}) {
  checkedBytes(compatibilityMemoryBytes, 'compatibilityMemoryBytes');
  checkedBytes(sampleMaxAgeMs, 'sampleMaxAgeMs');
  for (const fn of [resolveRequest, isEvidenceValid, externalPressure, sampleMemory, now]) {
    if (typeof fn !== 'function') throw error('RESOURCE_MEMORY_CONFIG_INVALID', '内存准入需要同步 Main provider');
  }

  function prepare(common, resources) {
    const resolved = resolveRequest(common);
    if (resolved && typeof resolved.then === 'function') {
      throw error('RESOURCE_MEMORY_CONFIG_INVALID', '内存候选 resolver 不允许异步执行');
    }
    if (resolved !== null && (!resolved || typeof resolved !== 'object' || Array.isArray(resolved))) {
      throw error('RESOURCE_MEMORY_CONFIG_INVALID', '内存候选 resolver 返回值无效');
    }
    const scope = Object.freeze({
      migrated: resolved ? resolved.migrated === true : false,
      heavy: resolved ? resolved.heavy !== false : true,
      maxGrowthBytes: resolved && resolved.maxGrowthBytes !== undefined && resolved.maxGrowthBytes !== null
        ? checkedBytes(resolved.maxGrowthBytes, 'maxGrowthBytes') : null
    });
    const configured = resolved ? resolved.candidates : undefined;
    if (scope.migrated && common.kind === 'phase' && configured === undefined) {
      throw error('RESOURCE_MEMORY_CONFIG_INVALID', '已迁移 phase 必须显式提供执行配置');
    }
    if (configured !== undefined && (!scope.migrated || common.kind !== 'phase' ||
        !Array.isArray(configured) || configured.length === 0 || configured.length > 8)) {
      throw error('RESOURCE_MEMORY_CONFIG_INVALID', '只有已登记的 phase 可以选择内存执行候选');
    }
    let lowSeen = false;
    const candidates = configured === undefined
      ? [Object.freeze({ resources, config: null, mode: 'normal' })]
      : configured.map((candidate) => {
        if (!candidate || !['normal', 'low'].includes(candidate.mode)) {
          throw error('RESOURCE_MEMORY_CONFIG_INVALID', '候选执行模式无效');
        }
        if (lowSeen && candidate.mode === 'normal') {
          throw error('RESOURCE_MEMORY_CONFIG_INVALID', '普通候选必须排在低内存候选之前');
        }
        lowSeen = lowSeen || candidate.mode === 'low';
        const config = validateExecutionMemoryConfig(candidate.config);
        return Object.freeze({
          resources: validateResourceVector({ ...resources, memoryBytes: config.phaseMemoryBytes }),
          config,
          mode: candidate.mode
        });
      });
    return Object.freeze({ scope, candidates: Object.freeze(candidates) });
  }

  function limit(scope, hardCeiling) {
    return scope.migrated ? hardCeiling : Math.min(hardCeiling, compatibilityMemoryBytes);
  }

  function assertEvidence(candidate) {
    if (candidate.config && (candidate.config.validatedEvidenceId === null ||
        isEvidenceValid(candidate.config) !== true)) {
      throw error('RESOURCE_MEMORY_PROFILE_UNVALIDATED', '当前内存执行档没有有效容量证据');
    }
  }

  function evaluate(scope, candidate, contributionBytes, activeRecords) {
    assertEvidence(candidate);
    const active = activeRecords.map((record) => record.memoryState || {
      scope: { heavy: true, maxGrowthBytes: null }, mode: 'normal'
    });
    if (scope.heavy && active.some((item) => item.mode === 'low')) return false;
    if (candidate.mode === 'low' && active.some((item) => item.scope.heavy)) return false;
    const external = externalPressure();
    if (scope.heavy && Array.isArray(external?.blockers) && external.blockers.some((item) => item?.mode === 'low')) return false;
    if (!candidate.config) return true;
    if (!external || typeof external.then === 'function' || external.inventoryComplete !== true ||
        !Array.isArray(external.blockers)) return false;
    if (external.blockers.some((item) => !item || typeof item !== 'object')) return false;
    if (candidate.mode === 'low' && external.blockers.some((item) => item.heavy !== false)) return false;
    let growth = 0;
    for (const item of [...active.map((entry) => entry.scope), ...external.blockers]) {
      if (item.maxGrowthBytes === null || item.maxGrowthBytes === undefined) return false;
      growth += checkedBytes(item.maxGrowthBytes, 'maxGrowthBytes');
      if (!Number.isSafeInteger(growth)) throw error('RESOURCE_MEMORY_CONFIG_INVALID', '未兑现增长合计超限');
    }
    let sample;
    try { sample = sampleMemory(); } catch (_error) {
      throw error('RESOURCE_MEMORY_SAMPLE_UNAVAILABLE', '无法取得有效的系统可用内存采样');
    }
    const current = now();
    if (!sample || !Number.isSafeInteger(sample.availableBytes) || sample.availableBytes < 0 ||
        !Number.isSafeInteger(sample.sampledAt) || sample.sampledAt < 0 ||
        !Number.isSafeInteger(current) || current < 0 ||
        sample.sampledAt > current || current - sample.sampledAt > sampleMaxAgeMs) {
      throw error('RESOURCE_MEMORY_SAMPLE_UNAVAILABLE', '系统可用内存采样无效或已过期');
    }
    // 已有驻留内存反映在 F 中；这里只加入当前新增峰值、R 与其他未兑现增长，不再扣整份 U。
    const needed = contributionBytes + candidate.config.systemReserveBytes + growth;
    return Number.isSafeInteger(needed) && sample.availableBytes >= needed;
  }

  const policy = Object.freeze({ prepare, limit, assertEvidence, evaluate });
  policies.add(policy);
  return policy;
}

function isMemoryAdmissionPolicy(value) { return policies.has(value); }

module.exports = { createMemoryAdmissionPolicy, isMemoryAdmissionPolicy };
