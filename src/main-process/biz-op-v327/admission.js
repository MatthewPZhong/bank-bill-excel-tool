'use strict';

const { AsyncLocalStorage } = require('node:async_hooks');
const { fail } = require('./contracts');

function createBizOpAdmission({ canReleaseRead = () => false } = {}) {
  const ownership = new AsyncLocalStorage();
  let owner = null;
  let recoveryReady = false;
  let readers = 0;
  const activeReads = new Set();
  function assertExclusive() {
    if (!owner || ownership.getStore() !== owner) fail('BIZOP_EXCLUSIVE_ADMISSION_REQUIRED');
  }
  function assertTaskAccess(taskRunId) {
    const token = ownership.getStore();
    if (owner && token === owner || activeReads.has(token) && token.readTaskRunId === taskRunId) return;
    fail('BIZOP_TASK_ADMISSION_REQUIRED');
  }
  async function exclusive(work, { recovery = false } = {}) {
    if (owner || readers) fail('BIZOP_MODULE_BUSY');
    if (!recovery && !recoveryReady) fail('BIZOP_RECOVERY_REQUIRED');
    const token = Object.freeze({});
    owner = token;
    if (recovery) recoveryReady = false;
    try { return await ownership.run(token, work); }
    finally { owner = null; }
  }
  function read(work) {
    if (owner || !recoveryReady) fail('BIZOP_RECOVERY_REQUIRED');
    readers += 1;
    try {
      const result = work();
      if (result && typeof result.then === 'function') fail('BIZOP_ASYNC_READ_REQUIRES_PIN');
      return result;
    } finally { readers -= 1; }
  }
  async function readTask(taskRunId, work) {
    if (owner || !recoveryReady) fail('BIZOP_RECOVERY_REQUIRED');
    readers += 1;
    // FilePlan Task 的 ID 在 lifecycle 创建后才可得；整个 lifecycle 共用一次读准入，
    // 只允许把未绑定 scope 绑定一次，不能在 beforeStart/execute 之间提前释放。
    const token = { readTaskRunId: taskRunId };
    activeReads.add(token);
    try { return await ownership.run(token, () => work(Object.freeze({ bindTask(id) {
      if (!id || token.readTaskRunId !== null && token.readTaskRunId !== id) fail('BIZOP_READ_TASK_REBIND');
      token.readTaskRunId = id;
    } }))); }
    finally {
      readers -= 1;
      activeReads.delete(token);
      // 活动 JS 调用已经结束；未决载体/发布义务由持久 pin 继续保护，写入口只能经恢复重开。
      if (token.readTaskRunId !== null && !canReleaseRead(token.readTaskRunId)) recoveryReady = false;
    }
  }
  return Object.freeze({ exclusive, read, readTask, assertExclusive, assertTaskAccess,
    markRecovered() { assertExclusive(); recoveryReady = true; },
    requireRecovery() { assertExclusive(); recoveryReady = false; },
    snapshot: () => Object.freeze({ exclusive: Boolean(owner), readers, recoveryReady }) });
}

module.exports = { createBizOpAdmission };
