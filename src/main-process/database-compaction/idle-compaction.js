'use strict';

// v3.2.17 空闲时自动整理主库（tool-data.sqlite）。
//   触发：用户 ≥ 30 分钟无操作、无业务任务、可回收空间 ≥ max(1 GiB, 库大小 20%)、
//         剩余磁盘 ≥ 库大小 × 2、距上次成功整理 ≥ 24 小时。
//   执行：持有业务过渡租约（期间新任务被拒绝并提示）、暂停存档中心后台维护，
//         在可强制结束的子进程中 VACUUM + 截断 WAL；用户一有操作即结束子进程，下次空闲再试。
//   不在启动时运行（保持 v3.1.10“不在普通启动时偷偷压缩”的约定）。
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { memoryCarrierAdmission } = require('../memory-activity');

const GIB = 1024 ** 3;
const DEFAULT_OPTIONS = Object.freeze({
  idleMs: 30 * 60 * 1000,
  minReclaimBytes: GIB,
  minReclaimRatio: 0.2,
  diskHeadroomRatio: 2,
  minIntervalMs: 24 * 60 * 60 * 1000
});
const LAST_SUCCESS_SETTING_KEY = 'db_idle_compaction_last_success_at';
const TRANSITION_OWNER = 'database-idle-compaction';
const BUSY_MESSAGE = '正在整理存储空间，已自动停止整理，请再试一次。';
const PROCESS_SCRIPT = path.join(__dirname, 'compaction-process.js');

function pragmaNumber(db, name) {
  const row = db.prepare(`PRAGMA ${name}`).get();
  return Number(row ? Object.values(row)[0] : 0) || 0;
}

// 只读评估：可回收空间与磁盘余量。磁盘余量无法判断时不整理（自动任务从严）。
function evaluateCompactionNeed({ db, freeBytes, options = DEFAULT_OPTIONS }) {
  const pageSize = pragmaNumber(db, 'page_size');
  const dbBytes = pageSize * pragmaNumber(db, 'page_count');
  const reclaimableBytes = pageSize * pragmaNumber(db, 'freelist_count');
  const thresholdBytes = Math.max(options.minReclaimBytes, Math.ceil(dbBytes * options.minReclaimRatio));
  const requiredFreeBytes = Math.ceil(dbBytes * options.diskHeadroomRatio);
  const facts = { dbBytes, reclaimableBytes, thresholdBytes, requiredFreeBytes, freeBytes };
  if (reclaimableBytes < thresholdBytes) return { needed: false, reason: 'below-threshold', ...facts };
  if (!Number.isFinite(freeBytes)) return { needed: false, reason: 'disk-unknown', ...facts };
  if (freeBytes < requiredFreeBytes) return { needed: false, reason: 'insufficient-disk', ...facts };
  return { needed: true, reason: '', ...facts };
}

function parseResult(stdout) {
  const lines = String(stdout || '').trim().split(/\r?\n/).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try { return JSON.parse(lines[index]); } catch (_error) { /* 继续向前找结果行 */ }
  }
  return null;
}

function electronUtilityProcess() {
  try {
    const electron = require('electron');
    return electron && typeof electron === 'object' ? electron.utilityProcess || null : null;
  } catch (_error) {
    return null;
  }
}

// Electron 下用 utilityProcess（真正的 Node 子进程），纯 Node（测试）下用 spawn。
function launchCompactionProcess({ dbPath }) {
  const request = JSON.stringify({ dbPath });
  const utility = electronUtilityProcess();
  // 低内存任务占用资源时准入会抛出 RESOURCE_MEMORY_ACTIVITY_BUSY，由控制器按“跳过”处理。
  const child = utility
    ? memoryCarrierAdmission(null).observe(utility.fork(PROCESS_SCRIPT, [request], { stdio: 'pipe', serviceName: 'database-compaction' }))
    : memoryCarrierAdmission(null).observe(spawn(process.execPath, [PROCESS_SCRIPT, request], { stdio: ['ignore', 'pipe', 'pipe'] }));
  let stdout = '';
  let stderr = '';
  if (child.stdout) child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
  if (child.stderr) child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  const promise = new Promise((resolve) => {
    let settled = false;
    const finish = (code, signal) => {
      if (settled) return;
      settled = true;
      const parsed = parseResult(stdout);
      resolve(parsed || {
        status: 'error',
        code: 'compaction-no-result',
        message: stderr.trim().slice(0, 500) || `整理进程退出（code ${code}${signal ? `，signal ${signal}` : ''}）`
      });
    };
    child.on(utility ? 'exit' : 'close', finish);
    child.on('error', (error) => {
      stderr += error && error.message ? error.message : String(error);
      finish(null, null);
    });
  });
  return {
    promise,
    kill() {
      try { child.kill(); } catch (_error) { /* 已退出 */ }
    }
  };
}

function createIdleCompactionController({
  getDatabase,
  registry,
  getLastUserActivityTs,
  isOtherWorkBusy = () => '',
  beginMaintenance = async () => ({ acquired: true }),
  endMaintenance = async () => {},
  launch = launchCompactionProcess,
  getFreeBytes = (dbPath) => {
    const stat = fs.statfsSync(path.dirname(dbPath));
    return Number(stat.bavail) * Number(stat.bsize);
  },
  log = () => {},
  now = () => Date.now(),
  options: overrides = {}
} = {}) {
  const options = Object.freeze({ ...DEFAULT_OPTIONS, ...overrides });
  let running = null;
  let runningPromise = null;
  let closed = false;
  let lastBlockedLogAt = 0;

  function isIdle() {
    return now() - Number(getLastUserActivityTs()) >= options.idleMs;
  }

  function logBlocked(evaluation) {
    if (now() - lastBlockedLogAt < options.minIntervalMs) return;
    lastBlockedLogAt = now();
    log({
      level: 'warning',
      message: '主库有较多可回收空间，但剩余磁盘不足，暂不自动整理',
      details: [
        `可回收 ${evaluation.reclaimableBytes} 字节`,
        `需要剩余 ${evaluation.requiredFreeBytes} 字节`,
        `实际剩余 ${evaluation.freeBytes == null ? '未知' : evaluation.freeBytes} 字节`
      ]
    });
  }

  function maybeRun() {
    if (runningPromise) return Promise.resolve({ status: 'skipped', reason: 'running' });
    const promise = runOnce();
    runningPromise = promise;
    promise.finally(() => { if (runningPromise === promise) runningPromise = null; }).catch(() => {});
    return promise;
  }

  async function runOnce() {
    if (closed) return { status: 'skipped', reason: 'closed' };
    if (running) return { status: 'skipped', reason: 'running' };
    if (!isIdle()) return { status: 'skipped', reason: 'not-idle' };
    const database = getDatabase();
    if (!database || !database.db || !database.dbPath) return { status: 'skipped', reason: 'no-database' };
    const lastSuccess = Number(database.getSetting(LAST_SUCCESS_SETTING_KEY)) || 0;
    if (lastSuccess > 0 && now() - lastSuccess < options.minIntervalMs) {
      return { status: 'skipped', reason: 'recently-compacted' };
    }
    const busyReason = isOtherWorkBusy();
    if (busyReason) return { status: 'skipped', reason: busyReason };
    let freeBytes = null;
    try { freeBytes = getFreeBytes(database.dbPath); } catch (_error) { freeBytes = null; }
    const evaluation = evaluateCompactionNeed({ db: database.db, freeBytes, options });
    if (!evaluation.needed) {
      if (['insufficient-disk', 'disk-unknown'].includes(evaluation.reason)) logBlocked(evaluation);
      return { status: 'skipped', reason: evaluation.reason, evaluation };
    }

    const lease = registry.acquireTransition(TRANSITION_OWNER, { requireIdle: true, busyMessage: BUSY_MESSAGE });
    if (!lease.acquired) return { status: 'skipped', reason: lease.reason || 'business-busy' };
    let maintenance = null;
    const current = { aborted: false, abortReason: '', kill: null };
    running = current;
    try {
      maintenance = await beginMaintenance();
      if (!maintenance || maintenance.acquired !== true) {
        return { status: 'skipped', reason: (maintenance && maintenance.reason) || 'maintenance-unavailable' };
      }
      if (current.aborted || !isIdle()) {
        return { status: 'aborted', reason: current.abortReason || 'user-activity' };
      }
      try { database.db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch (_error) { /* 由子进程再次截断 */ }
      const launched = launch({ dbPath: database.dbPath });
      current.kill = launched.kill;
      if (current.aborted) launched.kill();
      const result = await launched.promise;
      if (current.aborted) {
        log({ level: 'info', message: '用户恢复操作，已停止本次空闲存储整理，数据库保持整理前状态', details: [] });
        return { status: 'aborted', reason: current.abortReason };
      }
      if (result.status !== 'done') {
        log({
          level: 'error',
          message: '空闲存储整理失败，数据库保持整理前状态，下次空闲再试',
          details: [result.code || result.status, result.message || ''].filter(Boolean)
        });
        return { status: 'failed', result };
      }
      database.setSetting(LAST_SUCCESS_SETTING_KEY, String(now()));
      log({
        level: 'info',
        message: '空闲存储整理完成',
        details: [
          `整理前 ${result.sizeBefore} 字节`,
          `整理后 ${result.sizeAfter} 字节`,
          `释放 ${Math.max(0, result.sizeBefore - result.sizeAfter)} 字节`,
          `耗时 ${result.durationMs} 毫秒`
        ]
      });
      return { status: 'compacted', result };
    } catch (error) {
      if (error && error.code === 'RESOURCE_MEMORY_ACTIVITY_BUSY') {
        return { status: 'skipped', reason: 'memory-activity-busy' };
      }
      log({
        level: 'error',
        message: '空闲存储整理异常，下次空闲再试',
        details: [error && error.message ? error.message : String(error)]
      });
      return { status: 'failed', error };
    } finally {
      running = null;
      if (maintenance && maintenance.acquired === true) {
        try { await endMaintenance(); } catch (_error) { /* 存档维护释放失败不影响业务 */ }
      }
      registry.releaseTransition(lease.token);
    }
  }

  // 用户操作、退出应用时调用：立即结束整理子进程，释放租约。
  function abort(reason = 'user-activity') {
    if (!running || running.aborted) return false;
    running.aborted = true;
    running.abortReason = reason;
    if (typeof running.kill === 'function') running.kill();
    return true;
  }

  function close() {
    closed = true;
    abort('closing');
  }

  // 退出应用等场景：中止整理并等本次收尾（子进程退出、存档维护恢复、租约释放）完成。
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
  LAST_SUCCESS_SETTING_KEY,
  BUSY_MESSAGE,
  evaluateCompactionNeed,
  launchCompactionProcess,
  createIdleCompactionController
};
