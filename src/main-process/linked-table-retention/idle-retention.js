'use strict';

// v3.2.18 链接表过期清理（🔴🔴 资金红线：自动删除对账输入）。
//   触发方式同 v3.2.17 空闲整理主库（database-compaction/idle-compaction.js）：
//     用户 ≥ 30 分钟无操作、无业务任务、距上次成功清理 ≥ 24 小时时，在每 2 分钟的空闲检查中执行；
//     不在启动时运行；用户一有操作即停止；结果写活动日志。
//   执行：持银行对账锁 + 业务过渡租约（期间新任务提示 BUSY_MESSAGE），按表顺序逐表
//     「统计 → 有过期行才删除并重建派生、清对账缓存」（共享 linked-table-delete.js，与手工删除同一链路）。
//   中止粒度：单张表的删除与派生重建是主线程同步调用，不能中途打断；表与表之间让出事件循环并检查中止。
//   记录：全部表完成才写上次成功时间；有失败则 1 小时内不重试；每次执行写一条活动日志。
const {
  LINKED_RETENTION_LAST_SUCCESS_KEY,
  LINKED_RETENTION_RANGE_START,
  LINKED_RETENTION_TABLES,
  readRetentionDaysByTable,
  expiredCutoffDate
} = require('./policy');

const DEFAULT_OPTIONS = Object.freeze({
  idleMs: 30 * 60 * 1000,
  minIntervalMs: 24 * 60 * 60 * 1000,
  failureBackoffMs: 60 * 60 * 1000
});
const TRANSITION_OWNER = 'linked-table-retention';
const BUSY_MESSAGE = '正在清理过期链接表数据，请稍后再试。';
const DERIVE_KEYS = Object.freeze(['bocDerive', 'admDerive', 'bocBankDerive']);
const DERIVE_LABELS = Object.freeze({
  bocDerive: 'BOC链接表重建',
  admDerive: 'ADM 银行对账单链接表重建',
  bocBankDerive: 'BOC调拨银行对账单表重建'
});

function errorText(error) {
  return error && error.message ? String(error.message) : String(error);
}

function deriveFailures(result) {
  const failures = [];
  for (const key of DERIVE_KEYS) {
    const derive = result && result[key];
    if (derive && derive.created === false) {
      failures.push(`${DERIVE_LABELS[key]}失败：${derive.error || '未知错误'}`);
    }
  }
  return failures;
}

function defaultYield() {
  return new Promise((resolve) => setImmediate(resolve));
}

function createIdleLinkedTableRetentionController({
  getDatabase,
  registry,
  getLastUserActivityTs,
  isOtherWorkBusy = () => '',
  acquireLock,
  releaseLock,
  countExpired,
  deleteExpired,
  log = () => {},
  now = () => Date.now(),
  yieldToEventLoop = defaultYield,
  options: overrides = {}
} = {}) {
  const options = Object.freeze({ ...DEFAULT_OPTIONS, ...overrides });
  let running = null;
  let runningPromise = null;
  let closed = false;
  let lastFailureAt = 0;

  function isIdle() {
    return now() - Number(getLastUserActivityTs()) >= options.idleMs;
  }

  function maybeRun() {
    if (runningPromise) return Promise.resolve({ status: 'skipped', reason: 'running' });
    const promise = runOnce();
    runningPromise = promise;
    promise.finally(() => { if (runningPromise === promise) runningPromise = null; }).catch(() => {});
    return promise;
  }

  function planTargets(database) {
    const retention = readRetentionDaysByTable(database);
    const startedAt = now();
    return LINKED_RETENTION_TABLES
      .filter((table) => retention[table.tableKey] !== null && retention[table.tableKey] !== undefined)
      .map((table) => ({
        tableKey: table.tableKey,
        name: table.name,
        retentionDays: retention[table.tableKey],
        cutoff: expiredCutoffDate(startedAt, retention[table.tableKey])
      }));
  }

  function processTarget(target) {
    const range = { tableKey: target.tableKey, start: LINKED_RETENTION_RANGE_START, end: target.cutoff };
    const expired = Number(countExpired(range)) || 0;
    if (expired <= 0) return { ...target, status: 'nothing', deleted: 0, failures: [] };
    const result = deleteExpired(range) || {};
    const failures = deriveFailures(result);
    return {
      ...target,
      status: failures.length > 0 ? 'derive-failed' : 'deleted',
      deleted: Number(result.deleted) || 0,
      rowCount: result.rowCount,
      failures
    };
  }

  function describe(result) {
    const scope = `${result.name}（保留 ${result.retentionDays} 天，数据日期 ≤ ${result.cutoff}）`;
    if (result.status === 'nothing') return `${scope}：无过期行`;
    if (result.status === 'failed') return `${scope}：清理失败：${result.error}`;
    const base = `${scope}：删除 ${result.deleted} 行，剩余 ${result.rowCount ?? '-'} 行`;
    return result.failures.length > 0 ? `${base}；${result.failures.join('；')}` : base;
  }

  async function runOnce() {
    if (closed) return { status: 'skipped', reason: 'closed' };
    if (running) return { status: 'skipped', reason: 'running' };
    if (!isIdle()) return { status: 'skipped', reason: 'not-idle' };
    const database = getDatabase();
    if (!database || !database.db) return { status: 'skipped', reason: 'no-database' };
    const lastSuccess = Number(database.getSetting(LINKED_RETENTION_LAST_SUCCESS_KEY)) || 0;
    if (lastSuccess > 0 && now() - lastSuccess < options.minIntervalMs) {
      return { status: 'skipped', reason: 'recently-cleaned' };
    }
    if (lastFailureAt > 0 && now() - lastFailureAt < options.failureBackoffMs) {
      return { status: 'skipped', reason: 'failure-backoff' };
    }
    const targets = planTargets(database);
    if (targets.length === 0) return { status: 'skipped', reason: 'not-configured' };
    const busyReason = isOtherWorkBusy();
    if (busyReason) return { status: 'skipped', reason: busyReason };

    const lock = acquireLock();
    if (!lock || lock.acquired !== true) return { status: 'skipped', reason: 'bank-statement-operation-busy' };
    let lease = null;
    try {
      lease = registry.acquireTransition(TRANSITION_OWNER, { requireIdle: true, busyMessage: BUSY_MESSAGE });
    } catch (error) {
      releaseLock();
      throw error;
    }
    if (!lease || !lease.acquired) {
      releaseLock();
      return { status: 'skipped', reason: (lease && lease.reason) || 'business-busy' };
    }

    const current = { aborted: false, abortReason: '' };
    running = current;
    const results = [];
    let failed = false;
    try {
      for (const target of targets) {
        await yieldToEventLoop();
        if (current.aborted || closed || !isIdle()) {
          const reason = current.abortReason || (closed ? 'closing' : 'user-activity');
          // 中止前已有表失败时同样退避 1 小时并记错误，不因中止绕过失败保护。
          if (failed) {
            lastFailureAt = now();
            log({
              level: 'error',
              message: '链接表过期清理部分失败，用户恢复操作已停止，1 小时后空闲时重试',
              details: results.map(describe)
            });
          } else if (results.some((result) => result.status !== 'nothing')) {
            log({
              level: 'info',
              message: '用户恢复操作，已停止本次链接表过期清理，其余表下次空闲继续',
              details: results.map(describe)
            });
          }
          return { status: 'aborted', reason, results };
        }
        let result;
        try {
          result = processTarget(target);
        } catch (error) {
          result = { ...target, status: 'failed', error: errorText(error), failures: [] };
        }
        if (result.status === 'failed' || result.status === 'derive-failed') failed = true;
        results.push(result);
      }
      if (failed) {
        lastFailureAt = now();
        log({ level: 'error', message: '链接表过期清理未全部完成，1 小时后空闲时重试', details: results.map(describe) });
        return { status: 'failed', results };
      }
      lastFailureAt = 0;
      database.setSetting(LINKED_RETENTION_LAST_SUCCESS_KEY, String(now()));
      log({ level: 'info', message: '链接表过期清理完成', details: results.map(describe) });
      return { status: 'cleaned', results };
    } finally {
      running = null;
      registry.releaseTransition(lease.token);
      releaseLock();
    }
  }

  // 用户操作、退出应用时调用：当前表的删除与派生重建完成后停止，不再处理剩余表。
  function abort(reason = 'user-activity') {
    if (!running) return false;
    if (!running.aborted) {
      running.aborted = true;
      running.abortReason = reason;
    }
    return true;
  }

  function close() {
    closed = true;
    abort('closing');
  }

  // 退出应用、关闭主窗口：请求中止并等待本次收尾（锁与租约释放）。
  async function stop(reason = 'closing') {
    abort(reason);
    if (runningPromise) {
      try { await runningPromise; } catch (_error) { /* 收尾错误已记录 */ }
    }
  }

  return Object.freeze({
    maybeRun,
    abort,
    stop,
    close,
    isRunning: () => Boolean(runningPromise)
  });
}

module.exports = {
  DEFAULT_OPTIONS,
  BUSY_MESSAGE,
  TRANSITION_OWNER,
  createIdleLinkedTableRetentionController
};
