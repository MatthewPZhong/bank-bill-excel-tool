'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  ServiceClientError,
  createServiceClient
} = require('../../../../src/main-process/background-execution/service-client');

const SERVICE_KEY = 'service.statement';

function policy(actionKey, serviceKey = SERVICE_KEY, lifetime = 'service') {
  return Object.freeze({
    actionKey,
    lifetime,
    service: lifetime === 'service' ? Object.freeze({ serviceKey }) : null
  });
}

function createHarness(overrides = {}) {
  const calls = [];
  const snapshots = new Map([
    ['owned-job', Object.freeze({ actionKey: 'statement:import', state: 'running' })],
    ['foreign-job', Object.freeze({ actionKey: 'duplicate:run', state: 'running' })]
  ]);
  const supervisor = {
    start(request) {
      calls.push(['start', request]);
      return Object.freeze({ promise: Promise.resolve({ outcome: 'completed' }) });
    },
    execute(request) {
      calls.push(['execute', request]);
      return Promise.resolve({ outcome: 'completed', actionKey: request.actionKey });
    },
    cancel(jobId, reason) {
      calls.push(['cancel', jobId, reason]);
      return Promise.resolve(Object.freeze({ jobId, accepted: snapshots.has(jobId) }));
    },
    inspect(jobId) {
      calls.push(['inspect', jobId]);
      return snapshots.get(jobId) || null;
    },
    closeService(serviceKey) {
      calls.push(['closeService', serviceKey]);
      return Promise.resolve(true);
    },
    ...overrides.supervisor
  };
  const policies = overrides.policies || [
    policy('statement:run'),
    policy('statement:import'),
    policy('duplicate:run', 'service.duplicate'),
    policy('bank-bu:run', null, 'job')
  ];
  const policyRegistry = {
    list() { return policies; },
    ...overrides.policyRegistry
  };
  return {
    calls,
    snapshots,
    supervisor,
    policyRegistry,
    client: () => createServiceClient({ supervisor, policyRegistry, serviceKey: SERVICE_KEY })
  };
}

test('ServiceClient冻结同一serviceKey的action集合并只暴露模块级生命周期', () => {
  const harness = createHarness();
  const client = harness.client();

  assert.equal(Object.isFrozen(client), true);
  assert.equal(client.serviceKey, SERVICE_KEY);
  assert.deepEqual(client.actionKeys, ['statement:import', 'statement:run']);
  assert.equal(Object.isFrozen(client.actionKeys), true);
  assert.deepEqual(Object.keys(client), [
    'serviceKey', 'actionKeys', 'start', 'execute', 'cancel', 'inspect', 'close'
  ]);
  assert.equal(Object.hasOwn(client, 'shutdown'), false);
  assert.equal(Object.hasOwn(client, 'closeService'), false);
});

test('ServiceClient原样转发owned start/execute并拒绝跨service action', async () => {
  const harness = createHarness();
  const client = harness.client();
  const startRequest = Object.freeze({
    actionKey: 'statement:import',
    operationKey: 'task/import',
    jobId: 'owned-job'
  });
  const executeRequest = Object.freeze({
    actionKey: 'statement:run',
    operationKey: 'task/run',
    jobId: 'owned-run-job'
  });

  const control = client.start(startRequest);
  assert.equal(typeof control.promise.then, 'function');
  assert.deepEqual(await client.execute(executeRequest), {
    outcome: 'completed',
    actionKey: 'statement:run'
  });
  assert.deepEqual(harness.calls.slice(0, 2), [
    ['start', startRequest],
    ['execute', executeRequest]
  ]);

  assert.throws(
    () => client.start({ actionKey: 'duplicate:run' }),
    (error) => error instanceof ServiceClientError &&
      error.code === 'SERVICE_CLIENT_ACTION_NOT_OWNED'
  );
  await assert.rejects(
    async () => client.execute({ actionKey: 'bank-bu:run' }),
    (error) => error.code === 'SERVICE_CLIENT_ACTION_NOT_OWNED'
  );
  assert.equal(harness.calls.length, 2);
});

test('ServiceClient action预检拒绝Proxy/getter且不触发副作用', () => {
  const harness = createHarness();
  const client = harness.client();
  let getterCalls = 0;
  const getterRequest = {};
  Object.defineProperty(getterRequest, 'actionKey', {
    enumerable: true,
    get() {
      getterCalls += 1;
      return 'statement:import';
    }
  });
  let proxyGets = 0;
  const proxyRequest = new Proxy({ actionKey: 'statement:import' }, {
    get(target, key, receiver) {
      proxyGets += 1;
      return Reflect.get(target, key, receiver);
    }
  });

  assert.throws(() => client.start(getterRequest), /enumerable own data property/);
  assert.throws(() => client.start(proxyRequest), /non-Proxy/);
  assert.equal(getterCalls, 0);
  assert.equal(proxyGets, 0);
  assert.deepEqual(harness.calls, []);
});

test('ServiceClient在cancel/inspect前验证job owner且close固定绑定serviceKey', async () => {
  const harness = createHarness();
  const client = harness.client();

  assert.deepEqual(client.inspect('owned-job'), {
    actionKey: 'statement:import',
    state: 'running'
  });
  assert.deepEqual(await client.cancel('owned-job', { reason: 'user-cancelled' }), {
    jobId: 'owned-job',
    accepted: true
  });
  assert.equal(client.inspect('missing-job'), null);
  assert.deepEqual(await client.cancel('missing-job'), {
    jobId: 'missing-job',
    accepted: false
  });
  assert.equal(await client.close(), true);
  assert.deepEqual(harness.calls.at(-1), ['closeService', SERVICE_KEY]);

  assert.throws(
    () => client.inspect('foreign-job'),
    (error) => error.code === 'SERVICE_CLIENT_JOB_NOT_OWNED'
  );
  await assert.rejects(
    async () => client.cancel('foreign-job'),
    (error) => error.code === 'SERVICE_CLIENT_JOB_NOT_OWNED'
  );
  assert.equal(harness.calls.some((call) => call[0] === 'cancel' && call[1] === 'foreign-job'), false);
});

test('ServiceClient对缺失、重复或非法registry依赖fail closed', () => {
  const valid = createHarness();
  assert.throws(
    () => createServiceClient({ supervisor: valid.supervisor, policyRegistry: valid.policyRegistry }),
    /serviceKey/
  );
  assert.throws(
    () => createServiceClient({
      supervisor: valid.supervisor,
      policyRegistry: { list: () => [] },
      serviceKey: SERVICE_KEY
    }),
    (error) => error.code === 'SERVICE_CLIENT_POLICY_MISSING'
  );
  assert.throws(
    () => createServiceClient({
      supervisor: valid.supervisor,
      policyRegistry: { list: () => [policy('statement:import'), policy('statement:import')] },
      serviceKey: SERVICE_KEY
    }),
    (error) => error.code === 'SERVICE_CLIENT_POLICY_DUPLICATE'
  );
  assert.throws(
    () => createServiceClient({
      supervisor: {},
      policyRegistry: valid.policyRegistry,
      serviceKey: SERVICE_KEY
    }),
    /supervisor\.start/
  );
});
