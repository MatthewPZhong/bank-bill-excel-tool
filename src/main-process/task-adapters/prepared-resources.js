'use strict';

const activityLogger = require('../../backend/logger');

function reportToModuleLog(diagnostic) {
  activityLogger.appendModuleLog({
    level: 'error', source: 'main', domain: 'archive',
    message: '任务准备资源收口失败',
    details: ['originalError', 'cleanupError', 'reportingError'].map((key) => {
      const error = diagnostic[key];
      return `${key}: ${error && error.code || ''} ${error && error.message || ''}`;
    })
  });
}

function createPreparedResourceScope(prepared, { reportCleanupFailure = reportToModuleLog } = {}) {
  const onAbandon = prepared && typeof prepared.onAbandon === 'function'
    ? prepared.onAbandon.bind(prepared)
    : null;
  let owner = 'scope';
  let abandonAttempted = false;
  let enteredLifecycle = false;
  let closing = false;
  let runPromise;

  function assertActive() {
    if (closing) throw new Error('任务准备资源 scope 已终结，不能再次移交所有权');
  }

  async function cleanup(originalError, workFailed) {
    if (owner !== 'scope' || abandonAttempted) return;
    // 调用前登记，清理失败也不重试；released 只表示本 scope 的义务已结算。
    abandonAttempted = true;
    try {
      if (onAbandon) await onAbandon();
      owner = 'released';
    } catch (cleanupError) {
      const diagnostic = Object.freeze({
        originalError, cleanupError, enteredLifecycle, owner, abandonAttempted
      });
      try {
        await reportCleanupFailure(diagnostic);
      } catch (reportingError) {
        // 日志自身失败不得替换业务/清理错误，仍保留两者供内部诊断。
        reportToModuleLog({ ...diagnostic, reportingError });
      }
      if (!enteredLifecycle && workFailed) throw originalError;
      throw cleanupError;
    }
  }

  return Object.freeze({
    run(work) {
      if (!runPromise) {
        runPromise = Promise.resolve().then(async () => {
          let workFailed = false;
          let originalError;
          try {
            return await work();
          } catch (error) {
            workFailed = true;
            originalError = error;
            throw error;
          } finally {
            closing = true;
            await cleanup(originalError, workFailed);
          }
        });
      }
      return runPromise;
    },
    enterLifecycle() {
      assertActive();
      enteredLifecycle = true;
    },
    markExecuteStarted() {
      assertActive();
      owner = 'execution';
    },
    snapshot() {
      return Object.freeze({ owner, abandonAttempted });
    }
  });
}

module.exports = { createPreparedResourceScope };
