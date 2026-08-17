'use strict';

const INSTALL_BUSY_MESSAGE = '正在准备升级，暂时不能开始新的任务。';

function normalizeOperation(meta = {}) {
  const channel = String(meta.channel || '').trim();
  const moduleKey = String(meta.moduleKey || '').trim();
  const functionKey = String(meta.functionKey || '').trim();
  const label = [moduleKey, functionKey].filter(Boolean).join(' / ') || channel || '业务处理';

  return { channel, moduleKey, functionKey, label };
}

function createBusinessOperationRegistry() {
  const activeOperations = new Map();
  const idleWaiters = new Set();
  let nextToken = 1;
  let nextTransitionToken = 1;
  let transitionLease = null;

  function begin(meta) {
    if (transitionLease) {
      return {
        accepted: false,
        status: 'busy',
        message: INSTALL_BUSY_MESSAGE
      };
    }

    const token = nextToken;
    nextToken += 1;
    activeOperations.set(token, normalizeOperation(meta));
    return { accepted: true, token };
  }

  function end(token) {
    activeOperations.delete(token);
    if (activeOperations.size === 0) {
      for (const resolve of idleWaiters) resolve();
      idleWaiters.clear();
    }
  }

  function listActive() {
    return Array.from(activeOperations.values(), (operation) => ({ ...operation }));
  }

  function acquireTransition(owner, options = {}) {
    const normalizedOwner = String(owner || '').trim();
    if (!normalizedOwner) throw new TypeError('业务 transition lease 缺少 owner');
    if (transitionLease) {
      return {
        acquired: false,
        reason: 'transition-active',
        owner: transitionLease.owner,
        operations: listActive()
      };
    }

    const operations = listActive();
    if (options.requireIdle === true && operations.length > 0) {
      return { acquired: false, reason: 'business-busy', operations };
    }

    const token = nextTransitionToken;
    nextTransitionToken += 1;
    transitionLease = { owner: normalizedOwner, token };
    return { acquired: true, owner: normalizedOwner, token, operations };
  }

  function releaseTransition(token) {
    if (!transitionLease || transitionLease.token !== token) return false;
    transitionLease = null;
    return true;
  }

  function beginInstallTransition(owner = 'app-updater') {
    return acquireTransition(owner, { requireIdle: true });
  }

  function cancelInstallTransition(token) {
    return releaseTransition(token);
  }

  function beginShutdownTransition(owner = 'app-shutdown') {
    return acquireTransition(owner, { requireIdle: false });
  }

  function waitForIdle() {
    if (activeOperations.size === 0) return Promise.resolve();
    return new Promise((resolve) => idleWaiters.add(resolve));
  }

  return {
    begin,
    end,
    listActive,
    acquireTransition,
    releaseTransition,
    beginInstallTransition,
    beginShutdownTransition,
    waitForIdle,
    cancelInstallTransition,
    isInstallTransitionActive: () => Boolean(transitionLease)
  };
}

module.exports = {
  INSTALL_BUSY_MESSAGE,
  createBusinessOperationRegistry
};
