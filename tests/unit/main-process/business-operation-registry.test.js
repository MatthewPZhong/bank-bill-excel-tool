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

  assert.deepEqual(registry.beginInstallTransition(), {
    acquired: true,
    operations: []
  });

  const blocked = registry.begin({ channel: 'file:import' });
  assert.deepEqual(blocked, {
    accepted: false,
    status: 'busy',
    message: INSTALL_BUSY_MESSAGE
  });

  registry.cancelInstallTransition();
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

  const transition = registry.beginShutdownTransition();
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
});
