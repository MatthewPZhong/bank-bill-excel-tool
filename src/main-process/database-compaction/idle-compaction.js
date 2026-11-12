'use strict';

// v3.2.17 空闲时自动整理主库（tool-data.sqlite）。
//   触发：用户 ≥ 30 分钟无操作、无业务任务、可回收空间 ≥ max(1 GiB, 库大小 20%)、
//         剩余磁盘 ≥ 库大小 × 2、距上次成功整理 ≥ 24 小时。
//   执行：持有业务过渡租约（期间新任务被拒绝并提示）、暂停存档中心后台维护，
//         在可强制结束的子进程中 VACUUM + 截断 WAL；用户一有操作即结束子进程，下次空闲再试。
//   不在启动时运行（保持 v3.1.10“不在普通启动时偷偷压缩”的约定）。
const fs = require('node:fs');
const os = require('node:os');
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
const MAINTENANCE_ABORTED = Symbol('maintenance-aborted');

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
function createCompactionChild(request, env) {
  const utility = electronUtilityProcess();
  // 低内存任务占用资源时准入会抛出 RESOURCE_MEMORY_ACTIVITY_BUSY，由控制器按“跳过”处理。
  const child = utility
    ? memoryCarrierAdmission(null).observe(utility.fork(PROCESS_SCRIPT, [request], { stdio: 'pipe', serviceName: 'database-compaction', env }))
    : memoryCarrierAdmission(null).observe(spawn(process.execPath, [PROCESS_SCRIPT, request], { stdio: ['ignore', 'pipe', 'pipe'], env }));
  return { child, exitEvent: utility ? 'exit' : 'close' };
}

const KILL_RETRY_MS = 500;

// 结果只在子进程真实退出（exit/close）后给出，作为释放租约与恢复存档维护的退出屏障。
//   error 事件不代表已退出：仅进程从未启动（无 pid）时直接结束，否则补发终止并继续等退出。
//   kill：记录取消请求；启动前（utilityProcess 尚无 pid）或 kill() 返回 false 时，在 spawn 后及每 500 ms 重试，直到退出。
// VACUUM 的重建临时库写在 SQLite 临时目录：显式指定为已做余量检查的目录
//   （Unix 读 SQLITE_TMPDIR，Windows 读 TMP/TEMP），避免落到未检查的磁盘卷。
function compactionChildEnv(tempDir) {
  if (!tempDir) return { ...process.env };
  return { ...process.env, SQLITE_TMPDIR: tempDir, TMP: tempDir, TEMP: tempDir };
}

function launchCompactionProcess({ dbPath, tempDir = '', createChild = createCompactionChild }) {
  const { child, exitEvent } = createChild(JSON.stringify({ dbPath }), compactionChildEnv(tempDir));
  let stdout = '';
  let stderr = '';
  let settled = false;
  let killRequested = false;
  let retryTimer = null;
  if (child.stdout) child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
  if (child.stderr) child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

  function attemptKill() {
    if (settled) return;
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
    let killed = false;
    try { killed = child.kill() !== false; } catch (_error) { killed = false; }
    if (killed || settled) return;
    retryTimer = setTimeout(() => { retryTimer = null; attemptKill(); }, KILL_RETRY_MS);
    if (retryTimer.unref) retryTimer.unref();
  }

  const promise = new Promise((resolve) => {
    const finish = (code, signal) => {
      if (settled) return;
      settled = true;
      if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
      const parsed = parseResult(stdout);
      resolve(parsed || {
        status: 'error',
        code: 'compaction-no-result',
        message: stderr.trim().slice(0, 500) || `整理进程退出（code ${code}${signal ? `，signal ${signal}` : ''}）`
      });
    };
    child.on(exitEvent, finish);
    child.on('spawn', () => { if (killRequested) attemptKill(); });
    child.on('error', (error) => {
      stderr += error && error.message ? error.message : String(error);
      if (child.pid == null) finish(null, null);
      else attemptKill();
    });
  });
  return {
    promise,
    kill() {
      killRequested = true;
      attemptKill();
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
  getFreeBytes = (directory) => {
    const stat = fs.statfsSync(directory);
    return Number(stat.bavail) * Number(stat.bsize);
  },
  getTempDir = () => os.tmpdir(),
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

  // 存档维护准备（等待存档操作、暂停后台物化与归属扫描）可能较久，期间也要响应取消：
  //   取消后立即放弃本次整理并释放业务租约；准备完成后再补做存档维护释放。
  function waitForMaintenance(current) {
    const pending = Promise.resolve().then(() => beginMaintenance());
    const aborted = new Promise((resolve) => { current.onAbort = () => resolve(MAINTENANCE_ABORTED); });
    if (current.aborted) current.onAbort();
    return Promise.race([pending, aborted]).then((value) => {
      current.onAbort = null;
      if (value === MAINTENANCE_ABORTED) {
        pending.then((late) => (late && late.acquired === true ? endMaintenance() : undefined)).catch(() => {});
      }
      return value;
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
    // 整理同时用到主库所在卷（WAL 回写）与 SQLite 临时目录所在卷（重建临时库），两处都须满足余量，取较小者判断。
    let freeBytes = null;
    let tempDir = '';
    try {
      tempDir = getTempDir();
      freeBytes = Math.min(Number(getFreeBytes(path.dirname(database.dbPath))), Number(getFreeBytes(tempDir)));
    } catch (_error) { freeBytes = null; }
    const evaluation = evaluateCompactionNeed({ db: database.db, freeBytes, options });
    if (!evaluation.needed) {
      if (['insufficient-disk', 'disk-unknown'].includes(evaluation.reason)) logBlocked(evaluation);
      return { status: 'skipped', reason: evaluation.reason, evaluation };
    }

    const lease = registry.acquireTransition(TRANSITION_OWNER, { requireIdle: true, busyMessage: BUSY_MESSAGE });
    if (!lease.acquired) return { status: 'skipped', reason: lease.reason || 'business-busy' };
    let maintenance = null;
    const current = { aborted: false, abortReason: '', kill: null, onAbort: null };
    running = current;
    try {
      maintenance = await waitForMaintenance(current);
      if (maintenance === MAINTENANCE_ABORTED) {
        maintenance = null;
        return { status: 'aborted', reason: current.abortReason || 'user-activity' };
      }
      if (!maintenance || maintenance.acquired !== true) {
        return { status: 'skipped', reason: (maintenance && maintenance.reason) || 'maintenance-unavailable' };
      }
      if (current.aborted || !isIdle()) {
        return { status: 'aborted', reason: current.abortReason || 'user-activity' };
      }
      try { database.db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch (_error) { /* 由子进程再次截断 */ }
      const launched = launch({ dbPath: database.dbPath, tempDir });
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

  // 用户操作、退出应用时调用：结束整理子进程（或放弃尚未完成的存档维护准备），释放租约。
  //   重复调用会再次尝试终止，不因首次终止未生效而失效。
  function abort(reason = 'user-activity') {
    if (!running) return false;
    if (!running.aborted) {
      running.aborted = true;
      running.abortReason = reason;
    }
    if (typeof running.onAbort === 'function') running.onAbort();
    if (typeof running.kill === 'function') running.kill();
    return true;
  }

  function close() {
    closed = true;
    abort('closing');
  }

  // 退出应用等场景：中止整理并等本次收尾（子进程真实退出、租约释放）完成；
  //   存档维护若仍在准备中被放弃，准备完成后自行释放，不阻塞退出。
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
