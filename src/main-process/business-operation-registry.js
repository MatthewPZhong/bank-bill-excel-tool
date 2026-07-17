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
  let nextToken = 1;
  let installTransitionActive = false;

  function begin(meta) {
    if (installTransitionActive) {
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
  }

  function listActive() {
    return Array.from(activeOperations.values(), (operation) => ({ ...operation }));
  }

  function beginInstallTransition() {
    if (installTransitionActive) {
      return {
        acquired: false,
        reason: 'install-transition-active',
        operations: listActive()
      };
    }

    installTransitionActive = true;
    const operations = listActive();
    if (operations.length > 0) {
      installTransitionActive = false;
      return { acquired: false, reason: 'business-busy', operations };
    }

    return { acquired: true, operations: [] };
  }

  function cancelInstallTransition() {
    installTransitionActive = false;
  }

  return {
    begin,
    end,
    listActive,
    beginInstallTransition,
    cancelInstallTransition,
    isInstallTransitionActive: () => installTransitionActive
  };
}

module.exports = {
  INSTALL_BUSY_MESSAGE,
  createBusinessOperationRegistry
};
