'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');

const {
  createExistingDispatchAdapter,
  createExistingDispatchTransportAdapter
} = require('../../../../src/main-process/background-execution/adapters/existing-dispatch-adapter');
const { createInlineAsyncAdapter } = require('../../../../src/main-process/background-execution/adapters/inline-async-adapter');
const { createUtilityProcessAdapter } = require('../../../../src/main-process/background-execution/adapters/utility-process-adapter');
const {
  ADMITTED_TOPOLOGY_WORKER_DATA_KEY,
  createWorkerThreadAdapter
} = require('../../../../src/main-process/background-execution/adapters/worker-thread-adapter');
const { createJobEnvelope } = require('../../../../src/main-process/background-execution/protocol');

function startEnvelope(operation = 'job:start', seq = 1, payload = { input: { value: 4 } }) {
  return createJobEnvelope({
    direction: 'command',
    operation,
    actionKey: 'background-execution:pure-compute-canary',
    operationKey: 'adapter-op',
    jobId: 'adapter-job',
    workerInstanceId: 'adapter-worker',
    serviceGeneration: null,
    unitId: null,
    seq,
    context: { kind: 'none', value: {} },
    payload
  });
}

function existingTransport(options) {
  return createExistingDispatchTransportAdapter(createExistingDispatchAdapter(options));
}

test('inline-async adapter 直接产出 canonical progress/done envelope', async () => {
  const messages = [];
  const adapter = createInlineAsyncAdapter();
  const handle = adapter.start({
    entry: async ({ input, reportProgress }) => {
      reportProgress({ stage: 'compute' });
      return { doubled: input.value * 2 };
    },
    onMessage: (message) => messages.push(message)
  });
  await handle.ready;
  handle.send(startEnvelope());
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(messages.map((message) => [message.operation, message.direction, message.seq]), [
    ['job:progress', 'event', 1],
    ['job:done', 'event', 2]
  ]);
  assert.deepEqual(messages[1].payload, { result: { doubled: 8 } });
});

test('inline-async terminate/close 持有真实 execution promise，late success/error 后才完成 cleanup', async (t) => {
  for (const terminal of ['success', 'error']) {
    await t.test(terminal, async () => {
      let finishExecution;
      const executionGate = new Promise((resolve, reject) => {
        finishExecution = terminal === 'success' ? resolve : reject;
      });
      let observedAbort = false;
      const handle = createInlineAsyncAdapter().start({
        entry: async ({ signal }) => {
          signal.addEventListener('abort', () => { observedAbort = true; }, { once: true });
          return executionGate;
        },
        onMessage() {}
      });
      handle.send(startEnvelope());
      await new Promise((resolve) => setImmediate(resolve));
      let terminateSettled = false;
      const termination = handle.terminate().then(() => { terminateSettled = true; });
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(observedAbort, true);
      assert.equal(terminateSettled, false);
      if (terminal === 'success') finishExecution({ late: true });
      else finishExecution(Object.assign(new Error('late failure'), { code: 'LATE_INLINE_ERROR' }));
      await termination;
      assert.equal(terminateSettled, true);
      await handle.close();
    });
  }
});

test('inline-async close 在正常完成前不虚报 transport 已收口', async () => {
  let finishExecution;
  const handle = createInlineAsyncAdapter().start({
    entry: () => new Promise((resolve) => { finishExecution = resolve; }),
    onMessage() {}
  });
  handle.send(startEnvelope());
  await new Promise((resolve) => setImmediate(resolve));
  let closeSettled = false;
  const closing = handle.close().then(() => { closeSettled = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(closeSettled, false);
  finishExecution({ ok: true });
  await closing;
  assert.equal(closeSettled, true);
});

test('existing-dispatch adapter 兼容 Promise 与 {promise,cancel,terminate}，不生成内部 terminal truth', async () => {
  const messages = [];
  let cancelled = 0;
  let resolveDispatch;
  const dispatchPromise = new Promise((resolve) => { resolveDispatch = resolve; });
  const adapter = existingTransport({
    dispatch({ onProgress }) {
      onProgress({ rows: 1 });
      return {
        promise: dispatchPromise,
        cancel() {
          cancelled += 1;
          return { acknowledged: true, source: 'legacy-dispatch' };
        }
      };
    }
  });
  const handle = adapter.start({ entry: null, onMessage: (message) => messages.push(message) });
  handle.send(startEnvelope());
  handle.send(startEnvelope('job:cancel', 2, { cancel: { reason: 'test' } }));
  await new Promise((resolve) => setImmediate(resolve));
  resolveDispatch({ ok: true });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(cancelled, 1);
  assert.deepEqual(messages.map((message) => message.operation), ['job:progress', 'cancel:ack', 'job:done']);
  assert.deepEqual(messages[1].payload.cancellation, { scope: 'job' });
  assert.ok(messages.every((message) => message.channel === 'job' && message.direction === 'event'));
});

test('public ExistingDispatchAdapter start(request, emit) 与 internal transport bridge 明确分层', async () => {
  const emitted = [];
  const publicAdapter = createExistingDispatchAdapter({
    dispatch({ input, onProgress }) {
      onProgress({ completed: 1 });
      return Promise.resolve({ doubled: input.value * 2 });
    }
  });
  assert.deepEqual(Object.keys(publicAdapter), ['kind', 'inspectTopology', 'start', 'cancel', 'close']);
  const handle = publicAdapter.start({
    entry: null,
    actionKey: 'example',
    operationKey: 'operation',
    jobId: 'job',
    context: { kind: 'none', value: {} },
    input: { value: 4 }
  }, (operation, payload) => emitted.push([operation, payload]));
  await handle.promise;
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(emitted, [
    ['job:progress', { progress: { completed: 1 } }],
    ['job:done', { result: { doubled: 8 } }]
  ]);

  const transport = createExistingDispatchTransportAdapter(publicAdapter);
  assert.equal(transport.kind, 'existing-dispatch-transport');
  assert.equal(typeof transport.start, 'function');
});

test('existing-dispatch 正常 close 只 detach，真实 cancel/force terminate 才调用底层', async () => {
  let cancelCount = 0;
  let terminateCount = 0;
  let resolveDispatch;
  const dispatchPromise = new Promise((resolve) => { resolveDispatch = resolve; });
  const adapter = existingTransport({
    dispatch() {
      return {
        promise: dispatchPromise,
        cancel() {
          cancelCount += 1;
          return { acknowledged: false, status: 'rejected' };
        },
        terminate() {
          terminateCount += 1;
          return Promise.resolve('terminated');
        }
      };
    }
  });
  const messages = [];
  const handle = adapter.start({ entry: null, onMessage: (message) => messages.push(message) });
  handle.send(startEnvelope());
  handle.close();
  assert.equal(cancelCount, 0);
  assert.equal(terminateCount, 0);
  resolveDispatch({ ignoredAfterDetach: true });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(messages, []);
  await handle.terminate();
  assert.equal(cancelCount, 0);
  assert.equal(terminateCount, 1);
});

test('existing-dispatch cancel await 真实结果；拒绝时不伪造 acknowledged', async () => {
  const failure = new Error('legacy dispatcher rejected cancellation');
  failure.code = 'LEGACY_CANCEL_REJECTED';
  const errors = [];
  let resolveDispatch;
  const adapter = existingTransport({
    dispatch() {
      return {
        promise: new Promise((resolve) => { resolveDispatch = resolve; }),
        cancel() { return Promise.reject(failure); }
      };
    }
  });
  const messages = [];
  const handle = adapter.start({
    entry: null,
    onMessage: (message) => messages.push(message),
    onError: (error) => errors.push(error)
  });
  handle.send(startEnvelope());
  handle.send(startEnvelope('job:cancel', 2, { cancel: { reason: 'test-rejection' } }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(errors.map((error) => error.code), ['LEGACY_CANCEL_REJECTED']);
  assert.equal(messages.some((message) => message.operation === 'cancel:ack'), false);
  handle.close();
  resolveDispatch({ ignoredAfterDetach: true });
});

test('existing-dispatch 绑定 {dispatch()} runtime，void legacy cancel 不伪造 ACK', async () => {
  const runtime = {
    boundCalls: 0,
    cancelCalls: 0,
    dispatch() {
      this.boundCalls += 1;
      return {
        promise: new Promise(() => {}),
        cancel: () => {
          this.cancelCalls += 1;
        }
      };
    }
  };
  const messages = [];
  const handle = existingTransport({ dispatch: runtime }).start({
    entry: null,
    onMessage: (message) => messages.push(message)
  });
  handle.send(startEnvelope());
  handle.send(startEnvelope('job:cancel', 2, { cancel: { reason: 'void-legacy' } }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(runtime.boundCalls, 1);
  assert.equal(runtime.cancelCalls, 1);
  assert.equal(messages.some((message) => message.operation === 'cancel:ack'), false);
  handle.close();
});

test('existing-dispatch void legacy cancel 的 terminal-before-ACK 通过私有因果桥接且底层 exactly-once', async () => {
  let cancelCalls = 0;
  let rejectDispatch;
  let cancellationEvidence = 0;
  const messages = [];
  const handle = existingTransport({
    dispatch() {
      return {
        promise: new Promise((_resolve, reject) => { rejectDispatch = reject; }),
        cancel() {
          cancelCalls += 1;
          const error = new Error('legacy void cancellation terminal');
          error.code = 'LEGACY_VOID_CANCELLED';
          rejectDispatch(error);
        }
      };
    }
  }).start({
    entry: null,
    onMessage: (message) => messages.push(message),
    onCancellationTerminal: () => { cancellationEvidence += 1; }
  });
  handle.send(startEnvelope());
  handle.send(startEnvelope('job:cancel', 2, { cancel: { reason: 'void-terminal-first' } }));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(cancelCalls, 1);
  assert.equal(cancellationEvidence, 1);
  assert.deepEqual(messages.map((message) => message.operation), ['job:error']);
  assert.equal(messages.some((message) => message.operation === 'cancel:ack'), false);
  await handle.terminate();
  assert.equal(cancelCalls, 1);
  await handle.close();
});

test('existing-dispatch cancel Promise 永不 settle 时 dispatcher reject 仍立即交付且不伪造取消证据', async () => {
  let cancelCalls = 0;
  let rejectDispatch;
  let cancellationEvidence = 0;
  const messages = [];
  const handle = existingTransport({
    dispatch() {
      return {
        promise: new Promise((_resolve, reject) => { rejectDispatch = reject; }),
        cancel() {
          cancelCalls += 1;
          return new Promise(() => {});
        }
      };
    }
  }).start({
    entry: null,
    onMessage: (message) => messages.push(message),
    onCancellationTerminal: () => { cancellationEvidence += 1; }
  });
  handle.send(startEnvelope());
  handle.send(startEnvelope('job:cancel', 2, { cancel: { reason: 'hanging-cancel' } }));
  const failure = new Error('dispatcher failed independently');
  failure.code = 'EXECUTOR_FAILED';
  rejectDispatch(failure);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(cancelCalls, 1);
  assert.equal(cancellationEvidence, 0);
  assert.deepEqual(messages.map((message) => message.operation), ['job:error']);
  assert.equal(messages[0].payload.error.code, 'EXECUTOR_FAILED');
  await handle.terminate();
  assert.equal(cancelCalls, 1);
  await handle.close();
});

test('existing-dispatch 已排队 terminal 在同 tick cancel 前先观察并抑制 legacy cancel', async () => {
  let cancelCalls = 0;
  let rejectDispatch;
  let cancellationEvidence = 0;
  const messages = [];
  const handle = existingTransport({
    dispatch() {
      return {
        promise: new Promise((_resolve, reject) => { rejectDispatch = reject; }),
        cancel() {
          cancelCalls += 1;
        }
      };
    }
  }).start({
    entry: null,
    onMessage: (message) => messages.push(message),
    onCancellationTerminal: () => { cancellationEvidence += 1; }
  });
  handle.send(startEnvelope());
  const failure = new Error('dispatcher failed before same-tick cancellation');
  failure.code = 'EXECUTOR_FAILED';
  rejectDispatch(failure);
  handle.send(startEnvelope('job:cancel', 2, { cancel: { reason: 'same-tick-race' } }));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(cancelCalls, 0);
  assert.equal(cancellationEvidence, 0);
  assert.deepEqual(messages.map((message) => message.operation), ['job:error']);
  assert.equal(messages[0].payload.error.code, 'EXECUTOR_FAILED');
  await handle.terminate();
  assert.equal(cancelCalls, 0);
  await handle.close();
});

test('existing cooperative cancel 已调用且无独立 terminate 时，force cleanup 不二次 cancel', async () => {
  let cancelCalls = 0;
  const adapter = existingTransport({
    dispatch() {
      return {
        promise: new Promise(() => {}),
        cancel() {
          cancelCalls += 1;
        }
      };
    }
  });
  const handle = adapter.start({ entry: null, onMessage() {} });
  handle.send(startEnvelope());
  handle.send(startEnvelope('job:cancel', 2, { cancel: { reason: 'cooperative' } }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(cancelCalls, 1);
  await handle.terminate();
  assert.equal(cancelCalls, 1);
  await handle.close();
});

test('inline/existing canonical bridge 将 emit/onMessage 异常送达 onError 且不悬空', async () => {
  const inlineErrors = [];
  const inline = createInlineAsyncAdapter().start({
    entry: async () => ({ unsupported: 1n }),
    onMessage() {},
    onError: (error) => inlineErrors.push(error)
  });
  inline.send(startEnvelope());
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(inlineErrors.map((error) => error.code), ['PROTOCOL_NOT_JSON_SAFE']);

  const existingErrors = [];
  const existing = existingTransport({
    dispatch({ onProgress }) {
      onProgress({ stage: 'before-observer-error' });
      return Promise.resolve({ ok: true });
    }
  }).start({
    entry: null,
    onMessage() {
      const error = new Error('observer failed');
      error.code = 'OBSERVER_FAILED';
      throw error;
    },
    onError: (error) => existingErrors.push(error)
  });
  existing.send(startEnvelope());
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(existingErrors.map((error) => error.code), ['OBSERVER_FAILED']);
});

test('existing fire-and-forget observers throw without creating unhandled rejection', async () => {
  const publicAdapter = createExistingDispatchAdapter({
    dispatch({ onProgress }) {
      onProgress({ stage: 'observer-throws' });
      return Promise.resolve({ ok: true });
    }
  });
  publicAdapter.start({
    entry: null,
    actionKey: 'example',
    operationKey: 'operation',
    jobId: 'job',
    context: { kind: 'none', value: {} },
    input: {},
    onError() { throw new Error('error observer failed'); }
  }, () => {
    throw new Error('event observer failed');
  });
  await new Promise((resolve) => setImmediate(resolve));
});

test('worker-thread adapter 使用 packaged entry path 并原样传 canonical envelope', async () => {
  class FakeWorker extends EventEmitter {
    constructor(filename, options) {
      super();
      this.filename = filename;
      this.options = options;
      this.sent = [];
      this.unrefCalls = 0;
      queueMicrotask(() => this.emit('online'));
    }
    postMessage(message) { this.sent.push(message); }
    unref() { this.unrefCalls += 1; }
    terminate() {
      this.emit('error', new Error('ignored teardown error'));
      return Promise.resolve(0);
    }
  }
  const adapter = createWorkerThreadAdapter({ WorkerClass: FakeWorker });
  const handle = adapter.start({
    entry: { path: '/packaged/src/canary-worker.js', workerData: { probe: true } },
    onMessage() {}
  });
  await handle.ready;
  const message = startEnvelope();
  handle.send(message);
  assert.equal(handle.worker.filename, '/packaged/src/canary-worker.js');
  assert.deepEqual(handle.worker.options.workerData, { probe: true });
  assert.equal(handle.worker.sent[0], message);
  handle.close();
  handle.close();
  assert.equal(handle.worker.unrefCalls, 1,
    'detach 必须幂等释放 event-loop 引用，避免 terminate timeout 后残留 Worker 钉住进程');
  assert.equal(handle.worker.listenerCount('messageerror'), 0);
  assert.equal(handle.worker.listenerCount('error'), 1);
  await handle.terminate();
  assert.equal(handle.worker.listenerCount('error'), 0);
  assert.equal(handle.worker.listenerCount('messageerror'), 0);
});

test('worker-thread adapter 只把 Supervisor admitted topology 合并到 entry-owned workerData', async () => {
  class FakeWorker extends EventEmitter {
    constructor(filename, options) {
      super();
      this.filename = filename;
      this.options = options;
      queueMicrotask(() => this.emit('online'));
    }
    postMessage() {}
    terminate() { return Promise.resolve(0); }
  }
  const handle = createWorkerThreadAdapter({ WorkerClass: FakeWorker }).start({
    entry: {
      path: '/packaged/parent-worker.js',
      workerData: { entryOwned: true },
      admittedTopologyWorkerData: true
    },
    topology: {
      topologyKey: 'topology.example',
      childrenMax: 4,
      childResource: {},
      effectiveChildCount: 2,
      downgraded: true,
      downgradeReason: 'memory'
    },
    onMessage() {}
  });
  await handle.ready;
  assert.deepEqual(handle.worker.options.workerData, {
    entryOwned: true,
    [ADMITTED_TOPOLOGY_WORKER_DATA_KEY]: {
      topologyKey: 'topology.example',
      effectiveChildCount: 2
    }
  });
  assert.throws(() => createWorkerThreadAdapter({ WorkerClass: FakeWorker }).start({
    entry: {
      path: '/packaged/conflict.js',
      admittedTopologyWorkerData: true,
      workerData: { [ADMITTED_TOPOLOGY_WORKER_DATA_KEY]: { caller: true } }
    },
    topology: { topologyKey: 'topology.example', effectiveChildCount: 2 },
    onMessage() {}
  }), /reserved admitted topology key/);
  assert.throws(() => createWorkerThreadAdapter({ WorkerClass: FakeWorker }).start({
    entry: {
      path: '/packaged/non-opted-conflict.js',
      workerData: { [ADMITTED_TOPOLOGY_WORKER_DATA_KEY]: { caller: true } }
    },
    onMessage() {}
  }), /reserved admitted topology key/);
  const unopted = createWorkerThreadAdapter({ WorkerClass: FakeWorker }).start({
    entry: { path: '/packaged/unopted.js', workerData: { entryOwned: true } },
    topology: { topologyKey: 'topology.example', effectiveChildCount: 2 },
    onMessage() {}
  });
  await unopted.ready;
  assert.deepEqual(unopted.worker.options.workerData, { entryOwned: true });
  await unopted.terminate();
  await handle.terminate();
});

test('worker-thread terminate 未settle时后续 close仍释放event-loop引用', async () => {
  let resolveTermination;
  class PendingWorker extends EventEmitter {
    constructor() {
      super();
      this.unrefCalls = 0;
      queueMicrotask(() => this.emit('online'));
    }
    postMessage() {}
    unref() { this.unrefCalls += 1; }
    terminate() {
      return new Promise((resolve) => { resolveTermination = resolve; });
    }
  }
  const handle = createWorkerThreadAdapter({ WorkerClass: PendingWorker }).start({
    entry: '/packaged/src/canary-worker.js',
    onMessage() {}
  });
  await handle.ready;
  const termination = handle.terminate();
  handle.close();
  handle.close();
  assert.equal(handle.worker.unrefCalls, 1,
    'Supervisor terminate timeout后的close仍必须解除进程liveness引用');
  resolveTermination(0);
  await termination;
});

test('worker-thread 只依 entry-owned error code 上报私有取消终态证据', async () => {
  class FakeWorker extends EventEmitter {
    constructor() {
      super();
      queueMicrotask(() => this.emit('online'));
    }
    postMessage() {}
    terminate() { return Promise.resolve(0); }
  }
  let evidence = 0;
  const messages = [];
  const handle = createWorkerThreadAdapter({ WorkerClass: FakeWorker }).start({
    entry: {
      path: '/packaged/src/canary-worker.js',
      cancellationTerminalErrorCodes: ['ENTRY_CANCELLED']
    },
    onMessage: (message) => messages.push(message),
    onCancellationTerminal: () => { evidence += 1; }
  });
  await handle.ready;
  handle.send(startEnvelope());
  handle.worker.emit('message', {
    operation: 'job:error',
    payload: { error: { code: 'ENTRY_CANCELLED' } }
  });
  assert.equal(evidence, 0);
  handle.send(startEnvelope('job:cancel', 2, { cancel: { reason: 'test' } }));
  handle.worker.emit('message', {
    operation: 'job:error',
    payload: { error: { code: 'EXECUTOR_FAILED' } }
  });
  assert.equal(evidence, 0);
  handle.worker.emit('message', {
    operation: 'job:error',
    payload: { error: { code: 'ENTRY_CANCELLED' } }
  });
  assert.equal(evidence, 1);
  assert.equal(messages.length, 3);
  await handle.terminate();
});

test('worker-thread messageerror 在 ready 前拒绝、ready 后单一路径上报并 detach', async () => {
  class ControlledWorker extends EventEmitter {
    postMessage() {}
    terminate() { return Promise.resolve(0); }
  }
  const adapter = createWorkerThreadAdapter({ WorkerClass: ControlledWorker });

  const before = adapter.start({ entry: '/packaged/before.js', onMessage() {} });
  const beforeError = new Error('cannot deserialize startup message');
  before.worker.emit('messageerror', beforeError);
  await assert.rejects(before.ready, (error) => error === beforeError);
  before.worker.emit('exit', 1);
  await before.terminate();

  const reported = [];
  const exits = [];
  const after = adapter.start({
    entry: '/packaged/after.js',
    onMessage() {},
    onError: (error) => reported.push(error),
    onExit: (code) => exits.push(code)
  });
  after.worker.emit('online');
  await after.ready;
  after.worker.emit('messageerror', new Error('cannot deserialize event'));
  after.worker.emit('error', new Error('same transport failure'));
  after.worker.emit('exit', 9);
  assert.equal(reported.length, 1);
  assert.deepEqual(exits, []);
  await after.terminate();
  assert.equal(after.worker.listenerCount('messageerror'), 0);
  assert.equal(after.worker.listenerCount('error'), 0);
});

test('utility-process adapter 仅使用注入 fork，兼容 Electron data wrapper 与 Node raw message', async () => {
  class FakeChild extends EventEmitter {
    constructor() {
      super();
      this.sent = [];
      this.killed = 0;
    }
    postMessage(message) { this.sent.push(message); }
    kill() {
      this.killed += 1;
      this.emit('error', 'crashed', '/utility-entry.js', 'ignored teardown error');
      queueMicrotask(() => this.emit('exit', 0));
      return true;
    }
  }
  const child = new FakeChild();
  const seen = [];
  const adapter = createUtilityProcessAdapter({
    fork(filename, args, options) {
      assert.equal(filename, '/packaged/src/utility-entry.js');
      assert.deepEqual(args, ['--probe']);
      assert.deepEqual(options, { stdio: 'pipe' });
      return child;
    }
  });
  const handle = adapter.start({
    entry: { path: '/packaged/src/utility-entry.js', args: ['--probe'], options: { stdio: 'pipe' } },
    onMessage: (message) => seen.push(message)
  });
  child.emit('spawn');
  await handle.ready;
  const message = startEnvelope();
  handle.send(message);
  child.emit('message', { data: message });
  child.emit('message', message);
  assert.equal(child.sent[0], message);
  assert.deepEqual(seen, [message, message]);
  handle.close();
  await handle.terminate();
  assert.equal(child.killed, 1);
  assert.equal(child.listenerCount('error'), 0);
});

test('utility-process ready 等 spawn；spawn 前 Electron error/exit 均拒绝', async () => {
  function startWith(child, callbacks = {}) {
    return createUtilityProcessAdapter({ fork: () => child }).start({
      entry: '/packaged/src/utility-entry.js',
      onMessage() {},
      ...callbacks
    });
  }

  const waitingChild = new EventEmitter();
  waitingChild.postMessage = () => {};
  waitingChild.kill = () => true;
  const waiting = startWith(waitingChild);
  let ready = false;
  waiting.ready.then(() => { ready = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(ready, false);
  waitingChild.emit('spawn');
  await waiting.ready;
  assert.equal(ready, true);
  waiting.close();

  const errorChild = new EventEmitter();
  errorChild.postMessage = () => {};
  errorChild.kill = () => true;
  const reported = [];
  const errored = startWith(errorChild, { onError: (error) => reported.push(error) });
  errorChild.emit('error', 'launch-failed', '/entry.js', 'sandbox denied');
  await assert.rejects(
    errored.ready,
    (error) => error.code === 'UTILITY_PROCESS_ERROR' && error.type === 'launch-failed' &&
      error.location === '/entry.js' && error.report === 'sandbox denied'
  );
  assert.deepEqual(reported, []);

  const exitChild = new EventEmitter();
  exitChild.postMessage = () => {};
  exitChild.kill = () => true;
  const exited = startWith(exitChild);
  exitChild.emit('exit', 9);
  await assert.rejects(exited.ready, (error) => error.code === 'UTILITY_PROCESS_EXIT_BEFORE_SPAWN');
});

test('utility-process kill 后有界等待 exit，再 detach；超时稳定拒绝', async () => {
  class ControlledChild extends EventEmitter {
    postMessage() {}
    kill() {
      this.killed = true;
      return true;
    }
  }

  const child = new ControlledChild();
  const handle = createUtilityProcessAdapter({ fork: () => child, terminateTimeoutMs: 50 }).start({
    entry: '/packaged/src/utility-entry.js',
    onMessage() {}
  });
  child.emit('spawn');
  await handle.ready;
  let terminated = false;
  const termination = handle.terminate().then((result) => {
    terminated = true;
    return result;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(terminated, false);
  assert.equal(child.listenerCount('exit'), 1);
  child.emit('exit', 0);
  assert.deepEqual(await termination, { code: 0, signal: null });
  assert.equal(child.listenerCount('error'), 0);
  assert.equal(child.listenerCount('exit'), 0);

  const stuckChild = new ControlledChild();
  const stuck = createUtilityProcessAdapter({ fork: () => stuckChild, terminateTimeoutMs: 5 }).start({
    entry: '/packaged/src/stuck-utility.js',
    onMessage() {}
  });
  stuckChild.emit('spawn');
  await stuck.ready;
  await assert.rejects(stuck.terminate(), (error) => error.code === 'UTILITY_PROCESS_TERMINATE_TIMEOUT');
  assert.equal(stuckChild.listenerCount('error'), 1);
  assert.equal(stuckChild.listenerCount('exit'), 1);
  stuckChild.emit('exit', 9);
  assert.equal(stuckChild.listenerCount('error'), 0);
  assert.equal(stuckChild.listenerCount('exit'), 0);

  const killRejectedChild = new ControlledChild();
  killRejectedChild.kill = () => false;
  const killRejected = createUtilityProcessAdapter({ fork: () => killRejectedChild }).start({
    entry: '/packaged/src/kill-rejected-utility.js',
    onMessage() {}
  });
  killRejectedChild.emit('spawn');
  await killRejected.ready;
  await assert.rejects(
    killRejected.terminate(),
    (error) => error.code === 'UTILITY_PROCESS_KILL_FAILED'
  );
  assert.equal(killRejectedChild.listenerCount('error'), 1);
  assert.equal(killRejectedChild.listenerCount('exit'), 1);
  killRejectedChild.emit('exit', 0);
  assert.equal(killRejectedChild.listenerCount('error'), 0);
  assert.equal(killRejectedChild.listenerCount('exit'), 0);
});
