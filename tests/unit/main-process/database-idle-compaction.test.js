'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { DatabaseSync } = require('node:sqlite');
const { createBusinessOperationRegistry } = require('../../../src/main-process/business-operation-registry');
const {
  BUSY_MESSAGE,
  LAST_SUCCESS_SETTING_KEY,
  evaluateCompactionNeed,
  launchCompactionProcess,
  createIdleCompactionController
} = require('../../../src/main-process/database-compaction/idle-compaction');

const MINUTE = 60 * 1000;
const SMALL = { minReclaimBytes: 1, minReclaimRatio: 0.2, diskHeadroomRatio: 2, idleMs: 30 * MINUTE, minIntervalMs: 24 * 60 * MINUTE };

function fileDb(t, { rows = 2000, deleteRatio = 0.6 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idle-compaction-'));
  const dbPath = path.join(dir, 'tool-data.sqlite');
  const db = new DatabaseSync(dbPath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE app_settings (setting_key TEXT PRIMARY KEY, setting_value TEXT);
    CREATE TABLE payload (id INTEGER PRIMARY KEY, body TEXT NOT NULL);
  `);
  const insert = db.prepare('INSERT INTO payload (body) VALUES (?)');
  db.exec('BEGIN');
  for (let index = 0; index < rows; index += 1) insert.run('x'.repeat(2000) + index);
  db.exec('COMMIT');
  db.prepare('DELETE FROM payload WHERE id % 10 < ?').run(Math.round(deleteRatio * 10));
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  t.after(() => {
    try { db.close(); } catch (_error) { /* closed */ }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return {
    dir,
    dbPath,
    db,
    database: {
      db,
      dbPath,
      getSetting: (key) => {
        const row = db.prepare('SELECT setting_value FROM app_settings WHERE setting_key = ?').get(key);
        return row ? row.setting_value : null;
      },
      setSetting: (key, value) => db.prepare(`
        INSERT INTO app_settings (setting_key, setting_value) VALUES (?, ?)
        ON CONFLICT(setting_key) DO UPDATE SET setting_value = excluded.setting_value
      `).run(key, value)
    }
  };
}

function controller(fixture, overrides = {}) {
  const logs = [];
  const calls = { begin: 0, end: 0, launch: 0, kill: 0 };
  let clock = 100 * 24 * 60 * MINUTE;
  const registry = overrides.registry || createBusinessOperationRegistry();
  const instance = createIdleCompactionController({
    getDatabase: () => fixture.database,
    registry,
    getLastUserActivityTs: () => (overrides.lastActivity !== undefined ? overrides.lastActivity : clock - 31 * MINUTE),
    isOtherWorkBusy: overrides.isOtherWorkBusy || (() => ''),
    beginMaintenance: async () => { calls.begin += 1; return { acquired: true }; },
    endMaintenance: async () => { calls.end += 1; },
    launch: overrides.launch || ((request) => {
      calls.launch += 1;
      const launched = launchCompactionProcess(request);
      return { promise: launched.promise, kill: () => { calls.kill += 1; launched.kill(); } };
    }),
    getFreeBytes: overrides.getFreeBytes || (() => 1024 ** 4),
    log: (entry) => logs.push(entry),
    now: () => clock,
    options: { ...SMALL, ...(overrides.options || {}) }
  });
  return { instance, logs, calls, registry, advance: (ms) => { clock += ms; } };
}

test('评估：可回收空间低于阈值、磁盘未知或不足时不整理', (t) => {
  const fixture = fileDb(t);
  assert.equal(evaluateCompactionNeed({ db: fixture.db, freeBytes: 1024 ** 4, options: { ...SMALL, minReclaimBytes: 1024 ** 4 } }).reason, 'below-threshold');
  assert.equal(evaluateCompactionNeed({ db: fixture.db, freeBytes: null, options: SMALL }).reason, 'disk-unknown');
  assert.equal(evaluateCompactionNeed({ db: fixture.db, freeBytes: 1, options: SMALL }).reason, 'insufficient-disk');
  const ok = evaluateCompactionNeed({ db: fixture.db, freeBytes: 1024 ** 4, options: SMALL });
  assert.equal(ok.needed, true);
  assert.ok(ok.reclaimableBytes > 0);
});

test('不空闲、近 24 小时已整理、有其他任务或业务忙时跳过且不持有租约', async (t) => {
  const fixture = fileDb(t);
  assert.equal((await controller(fixture, { lastActivity: Date.now() * 2 }).instance.maybeRun()).reason, 'not-idle');
  const busy = controller(fixture, { isOtherWorkBusy: () => 'acquiring-worker-busy' });
  assert.equal((await busy.instance.maybeRun()).reason, 'acquiring-worker-busy');
  const registry = createBusinessOperationRegistry();
  const operation = registry.begin({ channel: 'test' });
  const blocked = controller(fixture, { registry });
  assert.equal((await blocked.instance.maybeRun()).reason, 'business-busy');
  registry.end(operation.token);
  assert.equal(registry.isInstallTransitionActive(), false);
  fixture.database.setSetting(LAST_SUCCESS_SETTING_KEY, String(100 * 24 * 60 * MINUTE - MINUTE));
  assert.equal((await controller(fixture).instance.maybeRun()).reason, 'recently-compacted');
});

test('磁盘不足只按日记一次告警', async (t) => {
  const fixture = fileDb(t);
  const run = controller(fixture, { getFreeBytes: () => 1 });
  assert.equal((await run.instance.maybeRun()).reason, 'insufficient-disk');
  assert.equal((await run.instance.maybeRun()).reason, 'insufficient-disk');
  assert.equal(run.logs.length, 1);
});

test('空闲整理：持有租约期间新任务被拒绝并提示，完成后释放空间、记录完成时间并恢复存档维护', async (t) => {
  const fixture = fileDb(t);
  const sizeBefore = fs.statSync(fixture.dbPath).size;
  const run = controller(fixture);
  const pending = run.instance.maybeRun();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(run.instance.isRunning(), true);
  assert.deepEqual(run.registry.begin({ channel: 'user-task' }), { accepted: false, status: 'busy', message: BUSY_MESSAGE });
  const result = await pending;
  assert.equal(result.status, 'compacted');
  assert.ok(result.result.sizeAfter < sizeBefore, '整理后文件变小');
  assert.equal(result.result.walAfter, 0);
  assert.equal(fixture.db.prepare('PRAGMA freelist_count').get().freelist_count, 0);
  assert.equal(Number(fixture.database.getSetting(LAST_SUCCESS_SETTING_KEY)), 100 * 24 * 60 * MINUTE);
  assert.deepEqual([run.calls.begin, run.calls.end], [1, 1]);
  assert.equal(run.registry.isInstallTransitionActive(), false);
  assert.equal(run.registry.begin({ channel: 'user-task' }).accepted, true);
  assert.match(run.logs.at(-1).message, /空闲存储整理完成/);
});

test('用户操作即中止：结束子进程、不记完成时间、释放租约，数据与整理前一致', async (t) => {
  const fixture = fileDb(t, { rows: 20000 });
  const countBefore = fixture.db.prepare('SELECT COUNT(*) AS n FROM payload').get().n;
  const run = controller(fixture);
  const pending = run.instance.maybeRun();
  while (run.calls.launch === 0) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(run.instance.abort('user-activity'), true);
  const result = await pending;
  assert.equal(result.status, 'aborted');
  assert.equal(run.calls.kill, 1);
  assert.equal(fixture.database.getSetting(LAST_SUCCESS_SETTING_KEY), null);
  assert.equal(run.registry.isInstallTransitionActive(), false);
  assert.equal(run.calls.end, 1);
  const verify = new DatabaseSync(fixture.dbPath, { readOnly: true });
  t.after(() => verify.close());
  assert.equal(Object.values(verify.prepare('PRAGMA quick_check').get())[0], 'ok');
  assert.equal(verify.prepare('SELECT COUNT(*) AS n FROM payload').get().n, countBefore);
});

test('退出时 stop 等待整理收尾后再继续', async (t) => {
  const fixture = fileDb(t);
  let resolveLaunch;
  const run = controller(fixture, {
    launch: () => ({
      promise: new Promise((resolve) => { resolveLaunch = resolve; }),
      kill: () => resolveLaunch({ status: 'error', code: 'killed' })
    })
  });
  run.instance.maybeRun();
  while (!resolveLaunch) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(run.instance.isRunning(), true);
  await run.instance.stop('quit');
  assert.equal(run.instance.isRunning(), false);
  assert.equal(run.registry.isInstallTransitionActive(), false);
});

test('低内存任务占用资源时跳过整理，释放租约并恢复存档维护', async (t) => {
  const fixture = fileDb(t);
  const run = controller(fixture, {
    launch: () => {
      const error = new Error('内存占用中');
      error.code = 'RESOURCE_MEMORY_ACTIVITY_BUSY';
      throw error;
    }
  });
  const result = await run.instance.maybeRun();
  assert.deepEqual(result, { status: 'skipped', reason: 'memory-activity-busy' });
  assert.equal(run.logs.length, 0);
  assert.deepEqual([run.calls.begin, run.calls.end], [1, 1]);
  assert.equal(run.registry.isInstallTransitionActive(), false);
  assert.equal(fixture.database.getSetting(LAST_SUCCESS_SETTING_KEY), null);
});

test('存档维护准备阶段用户操作：立即放弃本次整理并释放租约，准备完成后再释放存档维护', async (t) => {
  const fixture = fileDb(t);
  let finishPreparation;
  const ends = [];
  let launches = 0;
  const registry = createBusinessOperationRegistry();
  const instance = createIdleCompactionController({
    getDatabase: () => fixture.database,
    registry,
    getLastUserActivityTs: () => 0,
    beginMaintenance: () => new Promise((resolve) => { finishPreparation = resolve; }),
    endMaintenance: async () => { ends.push('end'); },
    launch: () => { launches += 1; throw new Error('不应启动整理'); },
    getFreeBytes: () => 1024 ** 4,
    now: () => 100 * 24 * 60 * MINUTE,
    options: SMALL
  });
  const pending = instance.maybeRun();
  while (!finishPreparation) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(registry.begin({ channel: 'blocked' }).accepted, false);
  assert.equal(instance.abort('user-activity'), true);
  assert.deepEqual(await pending, { status: 'aborted', reason: 'user-activity' });
  assert.equal(registry.isInstallTransitionActive(), false);
  assert.equal(instance.isRunning(), false);
  assert.deepEqual(ends, []);
  finishPreparation({ acquired: true });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(ends, ['end']);
  assert.equal(launches, 0);
});

test('重复的用户操作会再次尝试终止整理进程', async (t) => {
  const fixture = fileDb(t);
  let kills = 0;
  let resolveLaunch;
  const run = controller(fixture, {
    launch: () => ({
      promise: new Promise((resolve) => { resolveLaunch = resolve; }),
      kill: () => { kills += 1; }
    })
  });
  const pending = run.instance.maybeRun();
  while (!resolveLaunch) await new Promise((resolve) => setImmediate(resolve));
  run.instance.abort('user-activity');
  run.instance.abort('user-activity');
  assert.equal(kills, 2);
  resolveLaunch({ status: 'error', code: 'killed' });
  assert.equal((await pending).status, 'aborted');
});

function fakeChild({ pid = 4321, killResult = true } = {}) {
  const child = new EventEmitter();
  child.pid = pid;
  child.kills = 0;
  child.killResult = killResult;
  child.kill = () => { child.kills += 1; return child.killResult; };
  return child;
}

async function settledWithin(promise) {
  let settled = false;
  promise.then(() => { settled = true; });
  await new Promise((resolve) => setImmediate(resolve));
  return settled;
}

test('整理进程 error 事件后仍等真实退出再给出结果，并补发终止', async () => {
  const child = fakeChild();
  const launched = launchCompactionProcess({ dbPath: 'x', createChild: () => ({ child, exitEvent: 'exit' }) });
  child.emit('error', new Error('V8 致命错误'));
  assert.equal(await settledWithin(launched.promise), false, 'error 后尚未退出，不能放行');
  assert.equal(child.kills, 1);
  child.emit('exit', 1);
  const result = await launched.promise;
  assert.equal(result.status, 'error');
  assert.match(result.message, /V8 致命错误/);
});

test('整理进程从未启动（无 pid）时 error 直接结束', async () => {
  const child = fakeChild({ pid: null });
  const launched = launchCompactionProcess({ dbPath: 'x', createChild: () => ({ child, exitEvent: 'close' }) });
  child.emit('error', new Error('spawn ENOENT'));
  assert.equal((await launched.promise).status, 'error');
});

test('启动前请求终止或 kill() 返回 false 时，在 spawn 后重试终止直到退出', async () => {
  const child = fakeChild({ pid: null, killResult: false });
  const launched = launchCompactionProcess({ dbPath: 'x', createChild: () => ({ child, exitEvent: 'exit' }) });
  launched.kill();
  assert.equal(child.kills, 1);
  child.pid = 4321;
  child.killResult = true;
  child.emit('spawn');
  assert.equal(child.kills, 2, 'spawn 后补发终止');
  child.emit('exit', null, 'SIGTERM');
  assert.equal((await launched.promise).status, 'error');
});

test('磁盘余量同时检查主库所在卷与 SQLite 临时目录所在卷，并把临时目录传给整理进程', async (t) => {
  const fixture = fileDb(t);
  const tempDir = path.join(fixture.dir, 'sqlite-temp');
  fs.mkdirSync(tempDir);
  const registry = createBusinessOperationRegistry();
  const skipped = await createIdleCompactionController({
    getDatabase: () => fixture.database,
    registry,
    getLastUserActivityTs: () => 0,
    getFreeBytes: (directory) => (directory === tempDir ? 1 : 1024 ** 4),
    getTempDir: () => tempDir,
    launch: () => { throw new Error('临时卷不足时不应启动整理'); },
    now: () => 100 * 24 * 60 * MINUTE,
    options: SMALL
  }).maybeRun();
  assert.equal(skipped.reason, 'insufficient-disk');
  assert.equal(registry.isInstallTransitionActive(), false);

  let childEnv = null;
  const child = fakeChild();
  const launched = launchCompactionProcess({
    dbPath: fixture.dbPath,
    tempDir,
    createChild: (_request, env) => { childEnv = env; return { child, exitEvent: 'exit' }; }
  });
  assert.deepEqual([childEnv.SQLITE_TMPDIR, childEnv.TMP, childEnv.TEMP], [tempDir, tempDir, tempDir]);
  child.emit('exit', 0);
  await launched.promise;
});

test('业务登记表：过渡租约可带自定义拒绝提示，默认仍为升级提示', () => {
  const registry = createBusinessOperationRegistry();
  const lease = registry.acquireTransition('custom', { requireIdle: true, busyMessage: '自定义提示' });
  assert.equal(registry.begin({ channel: 'x' }).message, '自定义提示');
  registry.releaseTransition(lease.token);
  const install = registry.beginInstallTransition();
  assert.equal(registry.begin({ channel: 'x' }).message, '正在准备升级，暂时不能开始新的任务。');
  registry.cancelInstallTransition(install.token);
});
