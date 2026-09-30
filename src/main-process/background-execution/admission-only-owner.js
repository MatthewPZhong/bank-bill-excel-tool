'use strict';

const { ResourceGovernorError, validateResourceVector } = require('./resource-lease');

function failure(code, message, cause) {
  const error = new ResourceGovernorError(code, message);
  if (cause) error.cause = cause;
  return error;
}

// Main 静态装配的准备阶段 owner；不注册可发布 action，不向调用者开放资源参数。
// start 必须同步返回独立的 promise/closed/cancel，包括创建失败；closed 只能表示真实关闭。
function createAdmissionOnlyOwner({ governor, descriptor, start, cleanup = async () => {} }) {
  const keys = ['ownerKey', 'actionKey', 'resources', 'timeoutMs'];
  if (!descriptor || Object.keys(descriptor).length !== keys.length ||
      keys.some((key) => !Object.hasOwn(descriptor, key)) ||
      !['ownerKey', 'actionKey'].every((key) => typeof descriptor[key] === 'string' && descriptor[key].length > 0) ||
      !Number.isSafeInteger(descriptor.timeoutMs) || descriptor.timeoutMs < 1 ||
      typeof governor?.acquirePhaseLease !== 'function' || typeof start !== 'function' || typeof cleanup !== 'function') {
    throw failure('RESOURCE_PREPARE_OWNER_INVALID', '准备阶段必须由 Main 提供完整静态描述');
  }
  const registration = Object.freeze({ ...descriptor, resources: validateResourceVector(descriptor.resources) });
  const records = new Set();
  let accepting = true;

  async function run(input, { operationKey, signal } = {}) {
    if (!accepting) throw failure('RESOURCE_PREPARE_OWNER_CLOSED', '准备阶段 owner 已关闭');
    if (signal && (typeof signal.addEventListener !== 'function' || typeof signal.removeEventListener !== 'function')) {
      throw failure('RESOURCE_SIGNAL_INVALID', '准备阶段取消信号无效');
    }
    const controller = new AbortController();
    const record = { controller, state: 'waiting', completion: null };
    records.add(record);
    const cancel = () => controller.abort();
    if (signal) {
      signal.addEventListener('abort', cancel, { once: true });
      if (signal.aborted) cancel();
    }
    const task = (async () => {
      let lease = null;
      let safeToRelease = true;
      let carrier = null;
      let cancelCarrier = null;
      try {
        lease = await governor.acquirePhaseLease({ ...registration, operationKey,
          priority: 'interactive', signal: controller.signal });
        if (controller.signal.aborted) throw failure('ADMISSION_CANCELLED', '准备扫描已取消');
        record.state = 'running';
        // 调用 start 后，未取得关闭事实前不得推断为“没有载体”。
        safeToRelease = false;
        carrier = start(input, Object.freeze({ memoryConfig: lease.memoryConfig || null,
          memoryMode: lease.memoryMode || 'normal', signal: controller.signal }));
        if (!carrier || typeof carrier.promise?.then !== 'function' || typeof carrier.closed?.then !== 'function' ||
            typeof carrier.cancel !== 'function') {
          throw failure('RESOURCE_PREPARE_CARRIER_INVALID', '准备扫描载体没有独立关闭承诺');
        }
        const observedResult = Promise.resolve(carrier.promise).then(
          (value) => ({ value }), (error) => ({ error }));
        const observedClose = Promise.resolve(carrier.closed).then(
          () => ({ closed: true }), (error) => ({ error }));
        cancelCarrier = () => { try { carrier.cancel(); } catch (_error) { /* 仍等待关闭事实 */ } };
        controller.signal.addEventListener('abort', cancelCarrier, { once: true });
        if (controller.signal.aborted) cancelCarrier();
        const result = await observedResult;
        record.state = 'closing';
        const closure = await observedClose;
        if (!closure.closed) throw failure('RESOURCE_PREPARE_CLOSE_UNCONFIRMED', '扫描载体关闭未确认，保留资源归属', closure.error);
        safeToRelease = true;
        record.state = 'cleanup';
        try { await cleanup(input); } catch (error) {
          throw new AggregateError([...(result.error ? [result.error] : []), error], '扫描临时资源清理失败');
        }
        if (result.error) throw result.error;
        if (controller.signal.aborted) throw failure('ADMISSION_CANCELLED', '准备扫描已取消');
        return result.value;
      } finally {
        if (signal) signal.removeEventListener('abort', cancel);
        if (cancelCarrier) controller.signal.removeEventListener('abort', cancelCarrier);
        if (safeToRelease) {
          if (lease) lease.release('prepare-closed');
          records.delete(record);
        } else {
          record.state = 'closure-unconfirmed';
        }
      }
    })();
    record.completion = task;
    return task;
  }

  return Object.freeze({
    run,
    async close() {
      accepting = false;
      const current = [...records];
      for (const record of current) record.controller.abort();
      await Promise.allSettled(current.map((record) => record.completion));
      return Object.freeze({ closed: records.size === 0, unclosedCount: records.size });
    },
    snapshot() {
      return Object.freeze({ accepting, activeCount: records.size,
        states: Object.freeze([...records].map((record) => record.state)) });
    }
  });
}

module.exports = { createAdmissionOnlyOwner };
