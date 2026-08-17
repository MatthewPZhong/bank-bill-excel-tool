'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  INSTALL_BUSY_MESSAGE,
  createBusinessOperationRegistry
} = require('../../../src/main-process/business-operation-registry');

test('tracks active operations and releases them by token', () => {
  const registry = createBusinessOperationRegistry();
  const started = registry.begin({
    channel: 'bank-statement:run',
    moduleKey: '资金对账数据处理',
    functionKey: '开始运行'
  });

  assert.equal(started.accepted, true);
  assert.deepEqual(registry.listActive(), [{
    channel: 'bank-statement:run',
    moduleKey: '资金对账数据处理',
    functionKey: '开始运行',
    label: '资金对账数据处理 / 开始运行'
  }]);

  registry.end(started.token);
  assert.deepEqual(registry.listActive(), []);
});

test('install transition is atomic and rejects new operations', () => {
  const registry = createBusinessOperationRegistry();

  const transition = registry.beginInstallTransition('app-updater');
  assert.equal(transition.acquired, true);
  assert.equal(transition.owner, 'app-updater');
  assert.equal(typeof transition.token, 'number');
  assert.deepEqual(transition.operations, []);

  const blocked = registry.begin({ channel: 'file:import' });
  assert.deepEqual(blocked, {
    accepted: false,
    status: 'busy',
    message: INSTALL_BUSY_MESSAGE
  });

  assert.equal(registry.cancelInstallTransition(transition.token), true);
  assert.equal(registry.begin({ channel: 'file:import' }).accepted, true);
});

test('install transition reports current business operations without locking the app', () => {
  const registry = createBusinessOperationRegistry();
  const started = registry.begin({ channel: 'toolbox:merge' });

  const transition = registry.beginInstallTransition();
  assert.equal(transition.acquired, false);
  assert.equal(transition.reason, 'business-busy');
  assert.equal(transition.operations[0].label, 'toolbox:merge');
  assert.equal(registry.isInstallTransitionActive(), false);

  registry.end(started.token);
  assert.equal(registry.beginInstallTransition().acquired, true);
});

test('shutdown transition blocks new work and resolves only after active operations drain', async () => {
  const registry = createBusinessOperationRegistry();
  const first = registry.begin({ channel: 'position-reconciliation:run:export' });
  const second = registry.begin({ channel: 'position-reconciliation:source:prepare-import' });

  const transition = registry.beginShutdownTransition('app-exit');
  assert.equal(transition.acquired, true);
  assert.equal(transition.owner, 'app-exit');
  assert.equal(transition.operations.length, 2);
  assert.equal(registry.begin({ channel: 'file:import' }).accepted, false);

  let drained = false;
  const waiting = registry.waitForIdle().then(() => {
    drained = true;
  });
  registry.end(first.token);
  await Promise.resolve();
  assert.equal(drained, false);
  registry.end(second.token);
  await waiting;
  assert.equal(drained, true);
  assert.equal(registry.releaseTransition(transition.token), true);
});

test('updater 与 migration lease 双向互斥，且只能由匹配 token 释放', () => {
  const registry = createBusinessOperationRegistry();
  const updater = registry.beginInstallTransition('app-updater');
  assert.equal(updater.acquired, true);

  const migrationBlocked = registry.beginShutdownTransition('vcc-storage-migration');
  assert.equal(migrationBlocked.acquired, false);
  assert.equal(migrationBlocked.reason, 'transition-active');
  assert.equal(migrationBlocked.owner, 'app-updater');
  assert.equal(registry.releaseTransition('stale-token'), false);
  assert.equal(registry.isInstallTransitionActive(), true);
  assert.equal(registry.releaseTransition(updater.token), true);

  const migration = registry.beginShutdownTransition('vcc-storage-migration');
  assert.equal(migration.acquired, true);
  const updaterBlocked = registry.beginInstallTransition('app-updater');
  assert.equal(updaterBlocked.acquired, false);
  assert.equal(updaterBlocked.reason, 'transition-active');
  assert.equal(updaterBlocked.owner, 'vcc-storage-migration');
  assert.equal(registry.cancelInstallTransition(updater.token), false);
  assert.equal(registry.isInstallTransitionActive(), true);
  assert.equal(registry.releaseTransition(migration.token), true);
});
