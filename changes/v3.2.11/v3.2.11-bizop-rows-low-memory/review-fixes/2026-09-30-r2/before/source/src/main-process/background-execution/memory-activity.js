'use strict';

const { isMainThread } = require('node:worker_threads');
const { AsyncLocalStorage } = require('node:async_hooks');
const activityContext = new AsyncLocalStorage();

// Main 中唯一的活动表；子 Worker 的开销归根载体，不能在另一 isolate
// 建立一个看似空闲的全局表。表项仅存技术身份，不记录路径或业务数据。
const governors = new Set();
const activities = new Set();
let entrypointsSealed = false;

function registerMemoryGovernor(governor) {
  governors.add(governor);
  return () => {
    // 关闭失败的上一代仍是事实占用，不能随 runtime 替换消失。
    if (governor.snapshot().activeLeaseCount !== 0) return false;
    governors.delete(governor);
    return true;
  };
}

function lowLeases() {
  return [...governors].flatMap((governor) => governor.snapshot().activeLeases)
    .filter((lease) => lease.memoryMode === 'low');
}
function matchesConfig(lease, config) {
  const admitted = lease.memoryConfig;
  return Boolean(config && admitted && config.profileId === admitted.profileId &&
    config.policyDigest === admitted.policyDigest && config.validatedEvidenceId === admitted.validatedEvidenceId);
}
function busy() {
  return Object.assign(new Error('低内存任务正在处理，请等待当前阶段结束后重试。'), { code: 'RESOURCE_MEMORY_ACTIVITY_BUSY' });
}

function memoryCarrierAdmission(memoryConfig = null) {
  if (!isMainThread) return { observe: (carrier) => carrier };
  const low = lowLeases();
  if (low.some((lease) => !matchesConfig(lease, memoryConfig))) throw busy();
  return { observe: observeCarrier };
}
function observeCarrier(carrier) {
  // 创建、加入观察之间没有 await；构造失败没有活动资源需要注销。
  const entry = { heavy: true, maxGrowthBytes: null, kind: 'carrier' };
  activities.add(entry);
  const exited = () => activities.delete(entry);
  if (typeof carrier.once === 'function') carrier.once('exit', exited);
  else if (typeof carrier.on === 'function') carrier.on('exit', exited);
  // 无 exit 合同保持未知占用；error、terminate() 返回或业务 done 都不释放。
  return carrier;
}
function observeMemoryCarrier(create, memoryConfig = null) {
  return memoryCarrierAdmission(memoryConfig).observe(create());
}

async function runMemoryActivity(work, { timeoutMs = 5000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (lowLeases().length) {
    if (Date.now() >= deadline) throw busy();
    await new Promise((resolve) => setTimeout(resolve, Math.min(100, deadline - Date.now())));
  }
  const entry = { heavy: true, maxGrowthBytes: null, kind: 'main' };
  activities.add(entry);
  try { return await activityContext.run(entry, work); } finally { activities.delete(entry); }
}

function memoryActivitySnapshot() {
  return { inventoryComplete: entrypointsSealed,
    blockers: [...activities].map((entry) => ({ ...entry })) };
}

// 独立 runtime 代次的存活租约也必须参与全局观察。当前 Governor 已在自身
// activeRecords 计量的资源不在这里重复相加。
function inventoryForGovernor(current) {
  const result = memoryActivitySnapshot();
  for (const governor of governors) {
    if (governor === current()) continue;
    for (const lease of governor.snapshot().activeLeases) {
      if (lease.kind === 'base' && Object.values(lease.resources).every((value) => value === 0)) continue;
      result.blockers.push({ heavy: true, maxGrowthBytes: null, mode: lease.memoryMode, kind: 'previous-runtime' });
    }
  }
  return result;
}

module.exports = { memoryCarrierAdmission, observeMemoryCarrier, registerMemoryGovernor, runMemoryActivity,
  memoryActivitySnapshot, inventoryForGovernor,
  hasLegacyMemoryActivity: () => activities.has(activityContext.getStore()),
  sealMemoryActivityInventory: () => { entrypointsSealed = true; } };
