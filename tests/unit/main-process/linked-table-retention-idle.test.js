'use strict';

// v3.2.18 链接表过期清理空闲控制器：准入跳过条件、锁与过渡租约、逐表处理、表间中止、失败退避与收尾。
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  BUSY_MESSAGE,
  TRANSITION_OWNER,
  createIdleLinkedTableRetentionController
} = require('../../../src/main-process/linked-table-retention/idle-retention');
const {
  LINKED_RETENTION_SETTING_KEY,
  LINKED_RETENTION_LAST_SUCCESS_KEY
} = require('../../../src/main-process/linked-table-retention/policy');
const { createBusinessOperationRegistry } = require('../../../src/main-process/business-operation-registry');

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const NOW = new Date(2026, 10, 13, 10, 0, 0).getTime();

function harness({
  settings = {},
  idleMinutes = 31,
  busyReason = '',
  lockAcquired = true,
  counts = { 'gateway-bill': 3, 'fx-settlement': 2, 'bank-deposit': 1 },
  deleteImpl = null,
  yieldImpl = null
} = {}) {
  const values = new Map(Object.entries(settings));
  const events = [];
  const logs = [];
  const clock = { now: NOW, lastActivity: NOW - idleMinutes * MINUTE };
  const registry = createBusinessOperationRegistry();
  const lock = { held: false };
  const database = {
    db: {},
    getSetting: (key) => (values.has(key) ? values.get(key) : null),
    setSetting: (key, value) => { values.set(key, value); }
  };
  const controller = createIdleLinkedTableRetentionController({
    getDatabase: () => database,
    registry,
    getLastUserActivityTs: () => clock.lastActivity,
    isOtherWorkBusy: () => busyReason,
    acquireLock: () => {
      events.push('lock');
      if (!lockAcquired || lock.held) return { acquired: false, message: '正在处理中…' };
      lock.held = true;
      return { acquired: true };
    },
    releaseLock: () => { events.push('unlock'); lock.held = false; },
    countExpired: (range) => {
      events.push(`count:${range.tableKey}:${range.start}..${range.end}`);
      return counts[range.tableKey] || 0;
    },
    deleteExpired: (range) => {
      events.push(`delete:${range.tableKey}:${range.end}`);
      if (deleteImpl) return deleteImpl(range, { registry, lock });
      return { deleted: counts[range.tableKey], rowCount: 10 };
    },
    log: (entry) => logs.push(entry),
    now: () => clock.now,
    yieldToEventLoop: yieldImpl ? () => yieldImpl({ controller: controllerRef.current, clock, events }) : async () => {}
  });
  const controllerRef = { current: controller };
  return { controller, registry, lock, values, events, logs, clock };
}

test('空闲且到期：持锁与租约逐表统计、删除，写上次成功时间并释放', async () => {
  const deleteSeen = [];
  const h = harness({
    settings: { [LINKED_RETENTION_SETTING_KEY]: JSON.stringify({ 'fx-settlement': 60 }) },
    deleteImpl: (range, { registry, lock }) => {
      // 删除时租约与锁都已持有：新业务被拒绝并提示清理中。
      const attempt = registry.begin({ channel: 'x', moduleKey: '资金对账', functionKey: '运行' });
      deleteSeen.push({ table: range.tableKey, locked: lock.held, accepted: attempt.accepted, message: attempt.message });
      return { deleted: 1, rowCount: 5 };
    }
  });
  const result = await h.controller.maybeRun();
  assert.equal(result.status, 'cleaned');
  assert.deepEqual(h.events, [
    'lock',
    'count:gateway-bill:0000-01-01..2026-10-28',
    'delete:gateway-bill:2026-10-28',
    'count:fx-settlement:0000-01-01..2026-09-13',
    'delete:fx-settlement:2026-09-13',
    'count:bank-deposit:0000-01-01..2026-09-13',
    'delete:bank-deposit:2026-09-13',
    'unlock'
  ]);
  assert.deepEqual(deleteSeen.map((item) => [item.table, item.locked, item.accepted, item.message]), [
    ['gateway-bill', true, false, BUSY_MESSAGE],
    ['fx-settlement', true, false, BUSY_MESSAGE],
    ['bank-deposit', true, false, BUSY_MESSAGE]
  ]);
  assert.equal(h.values.get(LINKED_RETENTION_LAST_SUCCESS_KEY), String(NOW));
  assert.equal(h.lock.held, false);
  assert.equal(h.registry.isInstallTransitionActive(), false);
  assert.equal(h.logs.length, 1);
  assert.equal(h.logs[0].level, 'info');
  assert.match(h.logs[0].details[0], /网关对账单表库（保留 15 天，数据日期 ≤ 2026-10-28）：删除 1 行，剩余 5 行/);
});

test('默认外汇交割表永久不处理；无过期行的表只统计不删除（不清对账缓存）', async () => {
  const h = harness({
    counts: { 'gateway-bill': 0, 'bank-deposit': 0 }
  });
  const result = await h.controller.maybeRun();
  assert.equal(result.status, 'cleaned');
  assert.deepEqual(h.events.filter((event) => event.startsWith('delete')), []);
  assert.deepEqual(h.events.filter((event) => event.startsWith('count')).map((event) => event.split(':')[1]), ['gateway-bill', 'bank-deposit']);
  assert.match(h.logs[0].details.join('\n'), /网关对账单表库（保留 15 天，数据日期 ≤ 2026-10-28）：无过期行/);
});

for (const [label, options, reason] of [
  ['未空闲满 30 分钟', { idleMinutes: 29 }, 'not-idle'],
  ['24 小时内已成功', { settings: { [LINKED_RETENTION_LAST_SUCCESS_KEY]: String(NOW - 23 * HOUR) } }, 'recently-cleaned'],
  ['三表均为永久', { settings: { [LINKED_RETENTION_SETTING_KEY]: JSON.stringify({ 'gateway-bill': null, 'fx-settlement': null, 'bank-deposit': null }) } }, 'not-configured'],
  ['其他写入方忙', { busyReason: 'bank-statement-operation-busy' }, 'bank-statement-operation-busy'],
  ['银行对账锁被占用', { lockAcquired: false }, 'bank-statement-operation-busy']
]) {
  test(`跳过：${label}`, async () => {
    const h = harness(options);
    const result = await h.controller.maybeRun();
    assert.deepEqual([result.status, result.reason], ['skipped', reason]);
    assert.deepEqual(h.events.filter((event) => !['lock'].includes(event)), []);
    assert.equal(h.lock.held, false);
    assert.equal(h.registry.isInstallTransitionActive(), false);
    assert.equal(h.logs.length, 0);
  });
}

test('超过 24 小时或修改设置后（成功时间被清空）再次执行', async () => {
  const h = harness({ settings: { [LINKED_RETENTION_LAST_SUCCESS_KEY]: String(NOW - 25 * HOUR) } });
  assert.equal((await h.controller.maybeRun()).status, 'cleaned');
  const cleared = harness({ settings: { [LINKED_RETENTION_LAST_SUCCESS_KEY]: '' } });
  assert.equal((await cleared.controller.maybeRun()).status, 'cleaned');
});

test('有进行中的业务任务时拿不到租约：释放已取得的锁并跳过', async () => {
  const h = harness();
  const operation = h.registry.begin({ channel: 'bank-statement:run', moduleKey: '资金对账', functionKey: '运行' });
  const result = await h.controller.maybeRun();
  assert.deepEqual([result.status, result.reason], ['skipped', 'business-busy']);
  assert.deepEqual(h.events, ['lock', 'unlock']);
  h.registry.end(operation.token);
});

test('用户操作：当前表完成后停止，其余表不处理、不写成功时间，锁与租约释放', async () => {
  const h = harness({
    yieldImpl: async ({ controller, events }) => {
      // 第二张表开始前用户恢复操作。
      if (events.some((event) => event.startsWith('delete:gateway-bill'))) controller.abort('user-activity');
    }
  });
  const result = await h.controller.maybeRun();
  assert.deepEqual([result.status, result.reason], ['aborted', 'user-activity']);
  assert.deepEqual(h.events.filter((event) => event.startsWith('delete')), ['delete:gateway-bill:2026-10-28']);
  assert.equal(h.values.has(LINKED_RETENTION_LAST_SUCCESS_KEY), false);
  assert.equal(h.lock.held, false);
  assert.equal(h.registry.isInstallTransitionActive(), false);
  assert.match(h.logs[0].message, /已停止本次链接表过期清理/);
});

test('表间检测到用户活动时间更新同样停止', async () => {
  const h = harness({
    settings: { [LINKED_RETENTION_SETTING_KEY]: JSON.stringify({ 'fx-settlement': 60 }) },
    yieldImpl: async ({ clock, events }) => {
      if (events.some((event) => event.startsWith('delete:fx-settlement'))) clock.lastActivity = clock.now;
    }
  });
  const result = await h.controller.maybeRun();
  assert.equal(result.status, 'aborted');
  assert.deepEqual(h.events.filter((event) => event.startsWith('delete')).length, 2);
});

test('单表失败（含 ADM gate 抛错与派生重建失败）不阻断其他表；不写成功时间并退避 1 小时', async () => {
  const h = harness({
    settings: { [LINKED_RETENTION_SETTING_KEY]: JSON.stringify({ 'fx-settlement': 60 }) },
    deleteImpl: (range) => {
      if (range.tableKey === 'fx-settlement') return { deleted: 2, rowCount: 1, bocDerive: { created: false, error: '重匹配失败' } };
      if (range.tableKey === 'bank-deposit') throw Object.assign(new Error('JPM 修复恢复中'), { code: 'RECON_FIX_JPM_SCOPE_LEASE_HELD' });
      return { deleted: 3, rowCount: 7 };
    }
  });
  const result = await h.controller.maybeRun();
  assert.equal(result.status, 'failed');
  assert.deepEqual(result.results.map((item) => item.status), ['deleted', 'derive-failed', 'failed']);
  assert.equal(h.values.has(LINKED_RETENTION_LAST_SUCCESS_KEY), false);
  assert.equal(h.logs[0].level, 'error');
  assert.match(h.logs[0].details.join('\n'), /BOC链接表重建失败：重匹配失败/);
  assert.match(h.logs[0].details.join('\n'), /银行对账单表（保留 60 天，数据日期 ≤ 2026-09-13）：清理失败：JPM 修复恢复中/);
  assert.equal(h.lock.held, false);
  assert.equal(h.registry.isInstallTransitionActive(), false);

  h.clock.now += 59 * MINUTE;
  h.clock.lastActivity = h.clock.now - 31 * MINUTE;
  assert.deepEqual(await h.controller.maybeRun(), { status: 'skipped', reason: 'failure-backoff' });
  h.clock.now += 2 * MINUTE;
  h.clock.lastActivity = h.clock.now - 31 * MINUTE;
  assert.equal((await h.controller.maybeRun()).status, 'failed');
});

test('前一张表失败后再被用户操作中止：仍退避 1 小时并记错误日志', async () => {
  const h = harness({
    deleteImpl: (range) => {
      if (range.tableKey === 'gateway-bill') throw Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' });
      return { deleted: 1, rowCount: 5 };
    },
    yieldImpl: async ({ controller, events }) => {
      if (events.some((event) => event.startsWith('delete:gateway-bill'))) controller.abort('user-activity');
    }
  });
  const result = await h.controller.maybeRun();
  assert.deepEqual([result.status, result.reason], ['aborted', 'user-activity']);
  assert.deepEqual(result.results.map((item) => item.status), ['failed']);
  assert.equal(h.values.has(LINKED_RETENTION_LAST_SUCCESS_KEY), false);
  assert.equal(h.logs.length, 1);
  assert.equal(h.logs[0].level, 'error');
  assert.match(h.logs[0].details.join('\n'), /网关对账单表库（保留 15 天，数据日期 ≤ 2026-10-28）：清理失败：database is locked/);
  assert.equal(h.lock.held, false);
  assert.equal(h.registry.isInstallTransitionActive(), false);

  h.clock.now += 31 * MINUTE;
  h.clock.lastActivity = h.clock.now - 31 * MINUTE;
  assert.deepEqual(await h.controller.maybeRun(), { status: 'skipped', reason: 'failure-backoff' });
  h.clock.now += 30 * MINUTE;
  h.clock.lastActivity = h.clock.now - 31 * MINUTE;
  assert.notEqual((await h.controller.maybeRun()).reason, 'failure-backoff');
});

test('stop 请求中止并等待收尾；close 后不再执行；并发 maybeRun 去重', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const h = harness({ yieldImpl: async () => gate });
  const first = h.controller.maybeRun();
  assert.deepEqual(await h.controller.maybeRun(), { status: 'skipped', reason: 'running' });
  assert.equal(h.controller.isRunning(), true);
  const stopping = h.controller.stop('quit');
  release();
  await stopping;
  const result = await first;
  assert.deepEqual([result.status, result.reason], ['aborted', 'quit']);
  assert.equal(h.controller.isRunning(), false);
  assert.equal(h.lock.held, false);
  assert.equal(h.registry.isInstallTransitionActive(), false);
  h.controller.close();
  assert.deepEqual(await h.controller.maybeRun(), { status: 'skipped', reason: 'closed' });
});

test('过渡租约 owner 与提示文案固定', () => {
  assert.equal(TRANSITION_OWNER, 'linked-table-retention');
  assert.equal(BUSY_MESSAGE, '正在清理过期链接表数据，请稍后再试。');
});
