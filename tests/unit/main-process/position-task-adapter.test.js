'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createPositionTaskOwner, normalizePositionTerminalRoute } = require('../../../src/main-process/position-reconciliation/task-owner');
const { createPositionTaskAdapter } = require('../../../src/main-process/position-reconciliation/task-adapter');
const { createIpcTaskContext } = require('../../../src/main-process/archive-center/ipc-task-contract');
const {
  POSITION_SIDE_DB_PENDING_SETTING,
  POSITION_SIDE_DB_CHECKPOINT_SETTING,
  POSITION_SIDE_DB_BOOTSTRAP_SETTING
} = require('../../../src/main-process/position-reconciliation/constants');

function operationContext(token = 'operation-token') {
  return {
    taskRunId: token,
    taskKey: 'position-reconciliation:source:import',
    moduleId: 'position-reconciliation-process',
    parentRunId: 'parent-run',
    operationKey: `position:${token}:position-reconciliation:source:import`
  };
}

function batchContext(token) {
  return { ...operationContext(token), batchId: 17, batchNumber: 'batch-17' };
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function fixture(options = {}) {
  const settings = new Map();
  const events = [];
  const checkpoint = { identity: 'side-db', generation: 2, token: 'checkpoint-2' };
  const service = {
    persistenceCheckpoint: () => checkpoint,
    listCommittedOperationInputs: () => [],
    activeImportStagingPaths: () => options.activePaths || []
  };
  const center = {
    service: {
      repository: { getBatch: () => ({ metadata: { _fileManifest: {} } }) }
    },
    listUnresolvedSourcePaths: () => options.protectedPaths || [],
    persistTaskTerminalIntent: (intent) => events.push(['terminal-intent', intent])
  };
  let currentService = service;
  const owner = createPositionTaskOwner({
    readSetting: (key) => settings.get(key) || '',
    writeSetting: (key, value) => {
      settings.set(key, value);
      if (key === POSITION_SIDE_DB_CHECKPOINT_SETTING) events.push(['checkpoint']);
      if (key === POSITION_SIDE_DB_PENDING_SETTING) {
        events.push([value ? 'pending-write' : 'pending-clear', value ? JSON.parse(value) : null]);
      }
    },
    settingsAvailable: () => true,
    getDatabasePath: () => options.databasePath || '',
    getCurrentService: () => currentService,
    getService: () => {
      if (options.serviceError) throw options.serviceError;
      return currentService;
    },
    getArchiveCenter: () => center,
    initializeArchiveCenter: () => center,
    getTaskLifecycle: () => ({ cancelActive: (predicate, message) => ({ predicate, message }) }),
    getTaskPolicy: () => ({ scopeId: 'position-reconciliation-process' }),
    supportsArchiveChannel: () => options.archiveRequired !== false
  });
  const adapter = createPositionTaskAdapter({
    owner,
    createOperationToken: () => 'operation-token',
    reportArchiveFailure: (warning) => events.push(['warning', warning])
  });
  function invocation(prepared = {}, policy = {}) {
    return adapter.createInvocation({
      meta: { channel: 'position-reconciliation:source:import' },
      policy: { batchPolicy: 'file', allocation: 'eager', ...policy },
      prepared,
      args: []
    });
  }
  return {
    settings, events, owner, adapter, center, service, checkpoint, invocation,
    setService: (value) => { currentService = value; },
    setPending: (pending) => settings.set(POSITION_SIDE_DB_PENDING_SETTING, JSON.stringify(pending)),
    pending: () => owner.readPositionPendingOperation()
  };
}

function executionOptions(executeBusiness, options = {}) {
  const context = options.noFile ? operationContext() : batchContext();
  const controls = {
    fileEvidence: { filePlan: options.filePlan || { inputs: [], outputs: [] } },
    settleArtifacts: options.settleArtifacts || (async () => ({ durable: true }))
  };
  return {
    taskContext: createIpcTaskContext(context, controls), controls, executeBusiness,
    markExecuteStarted: options.markExecuteStarted || (() => {})
  };
}

function storedPending(options = {}) {
  return {
    operationToken: 'operation-token', channel: 'position-reconciliation:source:import',
    owner: { version: 1, kind: 'file-batch', batchContext: batchContext() },
    baseCheckpoint: { identity: 'side-db', generation: 1, token: 'checkpoint-1' },
    archiveRequired: true, archiveState: 'incomplete', businessState: 'success',
    archiveFiles: [], ...options
  };
}

test('Position 每个 invocation 独立生成 token，prepared 身份保持原优先级', () => {
  const f = fixture();
  let token = 0;
  const adapter = createPositionTaskAdapter({ owner: f.owner, createOperationToken: () => `token-${++token}` });
  const base = { meta: { channel: 'position-reconciliation:run' }, policy: {}, args: [] };
  const first = adapter.createInvocation({ ...base, prepared: { taskRunId: 'explicit-task', operationKey: 'explicit-key' } });
  const second = adapter.createInvocation({ ...base, prepared: {} });
  assert.deepEqual(first.identity, { taskRunId: 'explicit-task', operationKey: 'explicit-key' });
  assert.equal(first.afterTerminalIntent.operationToken, 'token-1');
  assert.equal(second.identity.taskRunId, 'token-2');
  assert.equal(second.identity.operationKey, 'position:token-2:position-reconciliation:run');
  assert.ok(Object.isFrozen(first));
});

for (const allocation of ['eager', 'deferred']) {
  test(`Position ${allocation} 文件执行保留 intent → outcome → durable → checkpoint → terminal 次序`, async () => {
    const f = fixture();
    let marked = 0;
    const preparedHook = [];
    const invocation = f.invocation({ afterTerminal: () => preparedHook.push(f.pending()) }, { allocation });
    const result = { status: 'success' };
    const actual = await invocation.execute(executionOptions(async () => {
      assert.equal(marked, 1);
      assert.equal(f.owner.currentOperationToken(), 'operation-token');
      assert.equal(f.pending().archiveState, 'awaiting-intent');
      return result;
    }, {
      markExecuteStarted: () => { marked += 1; },
      settleArtifacts: async (settlement) => {
        assert.deepEqual(settlement, { files: [] });
        assert.equal(f.pending().businessState, 'success');
        assert.equal(f.pending().terminalOutcome.taskStatus, 'succeeded');
        return { durable: true };
      }
    }));
    assert.equal(actual, result);
    assert.equal(f.owner.currentOperationToken(), undefined);
    assert.equal(f.owner.activeOperation(), null);
    assert.equal(f.pending().archiveState, 'durable');
    assert.deepEqual(JSON.parse(f.settings.get(POSITION_SIDE_DB_CHECKPOINT_SETTING)), f.checkpoint);
    await invocation.afterTerminal({ context: batchContext(), terminalResult: { taskStatus: 'succeeded' } });
    assert.equal(f.pending(), null);
    assert.deepEqual(preparedHook, [null]);
    assert.ok(f.events.findIndex(([name]) => name === 'checkpoint') < f.events.findIndex(([name]) => name === 'pending-clear'));
  });
}

test('文件 intent 消费已冻结快照和 artifactKey，不重读输入补造身份', async () => {
  const f = fixture();
  const snapshot = { sizeBytes: 4, mtimeMs: 1, ctimeMs: 2, ino: '3' };
  const filePlan = {
    inputs: [{ filePath: '/not-present/input.xlsx', direction: 'input', artifactKey: 'input-1', sourceSnapshot: snapshot, sourceOperation: 'import', originalName: 'input.xlsx', expectedSha256: 'a'.repeat(64), expectedSizeBytes: 4 }],
    outputs: []
  };
  let captured;
  const invocation = f.invocation({ positionArchiveEvidence: { inputs: [{ sourceType: 'ordinary-input', sha256: 'a'.repeat(64), sizeBytes: 4 }] } });
  await invocation.execute(executionOptions(async () => {
    captured = f.pending();
    return { status: 'success' };
  }, { filePlan }));
  assert.equal(captured.archiveState, 'intent-recorded');
  assert.equal(captured.archiveFiles[0].artifactKey, 'input-1');
  assert.deepEqual(captured.archiveFiles[0].sourceSnapshot, snapshot);
  assert.equal(captured.archiveFiles[0].sha256, 'a'.repeat(64));
});

test('无文件任务只做原 admission，保留 operation owner，无文件 settlement 不被调用', async () => {
  const f = fixture({ archiveRequired: false });
  const invocation = f.invocation({}, { batchPolicy: 'no-file' });
  const result = await invocation.execute(executionOptions(async () => ({ status: 'success' }), {
    noFile: true,
    settleArtifacts: async () => { throw new Error('无文件不应调用文件 settlement'); }
  }));
  assert.equal(result.status, 'success');
  assert.equal(f.pending().owner.kind, 'operation');
  assert.deepEqual(f.pending().owner.operationContext, operationContext());
  await invocation.afterTerminal({ context: operationContext() });
  assert.equal(f.pending(), null);
});

test('正在执行时第二次 admission 返回 busy，不接管资源也不覆盖 pending', async () => {
  const f = fixture({ archiveRequired: false });
  const held = deferred();
  const entered = deferred();
  const first = f.invocation({}, { batchPolicy: 'no-file' });
  const firstTask = first.execute(executionOptions(async () => {
    entered.resolve();
    await held.promise;
    return { status: 'success' };
  }, { noFile: true }));
  await entered.promise;
  const original = f.pending();
  let marked = false;
  const result = await f.invocation({}, { batchPolicy: 'no-file' }).execute(executionOptions(
    () => assert.fail('busy 不应执行业务'), { noFile: true, markExecuteStarted: () => { marked = true; } }
  ));
  assert.equal(result.code, 'position-operation-busy');
  assert.equal(marked, false);
  assert.deepEqual(f.pending(), original);
  held.resolve();
  await firstTask;
});

test('未完成 pending 拒绝与 service 初始化异常都不提前接管资源', async () => {
  for (const f of [fixture(), fixture({ serviceError: new Error('初始化失败') })]) {
    if (!f.pending()) f.setPending(storedPending());
    let marked = 0;
    const original = f.pending();
    const result = await f.invocation().execute(executionOptions(() => assert.fail('admission 拒绝'), {
      markExecuteStarted: () => { marked += 1; }
    }));
    assert.equal(result.status, 'failed');
    assert.equal(marked, 0);
    assert.deepEqual(f.pending(), original);
    assert.equal(f.owner.activeOperation(), null);
  }
});

test('业务提交但 manifest 不 durable 保留 pending、原业务结果与 checkpoint', async () => {
  const f = fixture();
  const result = { status: 'success', cleanupPaths: ['/external/source'] };
  const actual = await f.invocation().execute(executionOptions(async () => result, {
    settleArtifacts: async () => ({ durable: false, message: 'outbox 未耐久' })
  }));
  assert.equal(actual, result);
  assert.equal(f.pending().archiveState, 'incomplete');
  assert.equal(f.pending().archiveWarning, 'outbox 未耐久');
  assert.equal(f.settings.has(POSITION_SIDE_DB_CHECKPOINT_SETTING), false);
});

test('显式 taskRunId 与领域 token 冲突时终态拒绝，prepared hook 不越过 owner 校验', async () => {
  const f = fixture({ archiveRequired: false });
  let called = false;
  const invocation = f.invocation({ taskRunId: 'explicit-task', afterTerminal: () => { called = true; } }, { batchPolicy: 'no-file' });
  const context = operationContext('explicit-task');
  const controls = { settleArtifacts: async () => null };
  await invocation.execute({
    taskContext: createIpcTaskContext(context, controls), controls,
    executeBusiness: async () => ({ status: 'success' }), markExecuteStarted() {}
  });
  await assert.rejects(invocation.afterTerminal({ context }), /pending 所有权已变化/);
  assert.equal(called, false);
  assert.equal(f.pending().operationToken, 'operation-token');
});

test('legacy 文件任务复用原 batch 与 result/error settlement，不建立 FilePlan intent', async () => {
  const f = fixture();
  const result = { status: 'success', archiveDeferred: true };
  const invocation = f.invocation({ legacyExistingBatchRecovery: true });
  const actual = await invocation.execute(executionOptions(async () => result, {
    filePlan: null,
    settleArtifacts: async (input) => {
      assert.deepEqual(input, { result, error: null });
      assert.equal(f.pending().businessState, 'awaiting-confirmation');
      assert.equal(f.pending().owner.batchContext.batchId, 17);
      return { archiveResult: { batchId: 17 }, runtime: { cleanupPaths: [] } };
    }
  }));
  assert.equal(actual, result);
  assert.equal(f.pending().archiveReference, 17);
  assert.equal(f.pending().archiveState, 'durable');
});

function spyAdapter(options = {}) {
  const events = [];
  const owner = {
    terminalRegistration: { finalize: async () => {} },
    runPositionReconciliationOperation: (_channel, execute) => execute(),
    recordPositionFilePlanIntent: () => events.push('intent'),
    markPositionBusinessOutcome: () => events.push('business-outcome'),
    markPositionArchiveDurable: () => events.push('durable'),
    markPositionArchiveIncomplete: () => events.push('incomplete'),
    cleanupPositionArchiveStaging: async () => { events.push('cleanup'); },
    persistCurrentPositionArchiveIntentIfNeeded: () => ({ outboxId: 'intent-1' }),
    ...options.owner
  };
  return {
    events,
    invocation: createPositionTaskAdapter({ owner, createOperationToken: () => 'operation-token', reportArchiveFailure: () => events.push('warning') })
      .createInvocation({ meta: { channel: 'position-reconciliation:run' }, policy: { batchPolicy: 'file' }, prepared: options.prepared || {} })
  };
}

for (const legacy of [false, true]) {
  test(`${legacy ? 'legacy' : 'current'} settlement 抛错优先于原业务异常，不运行额外 cleanup`, async () => {
    const f = spyAdapter({ prepared: { legacyExistingBatchRecovery: legacy } });
    const businessError = new Error('业务失败');
    const settlementError = new Error('settlement 失败');
    await assert.rejects(f.invocation.execute(executionOptions(async () => { throw businessError; }, {
      settleArtifacts: async () => { f.events.push('settle'); throw settlementError; }
    })), (error) => error === settlementError);
    assert.deepEqual(f.events, [...(legacy ? [] : ['intent']), 'business-outcome', 'settle']);
  });
}

test('current 成功 settlement 后恢复原业务异常，durable 前不 cleanup', async () => {
  const f = spyAdapter();
  const error = new Error('业务失败');
  await assert.rejects(f.invocation.execute(executionOptions(async () => { throw error; }, {
    settleArtifacts: async () => { f.events.push('settle'); return { durable: true }; }
  })), (actual) => actual === error);
  assert.deepEqual(f.events, ['intent', 'business-outcome', 'settle', 'durable', 'cleanup']);
});

test('legacy 归档无 durable retry 时保留证据并返回原业务结果', async () => {
  const f = spyAdapter({ prepared: { legacyExistingBatchRecovery: true } });
  const result = { status: 'success' };
  assert.equal(await f.invocation.execute(executionOptions(async () => result, {
    settleArtifacts: async () => ({ archiveResult: { archiveFailed: true, persistentRetryAvailable: false } })
  })), result);
  assert.deepEqual(f.events, ['business-outcome', 'incomplete']);
});

test('legacy cleanup 抛错保持原结果并标记 incomplete，与基线反馈一致', async () => {
  const f = spyAdapter({
    prepared: { legacyExistingBatchRecovery: true },
    owner: { cleanupPositionArchiveStaging: async () => { throw new Error('cleanup 失败'); } }
  });
  const result = { status: 'success' };
  assert.equal(await f.invocation.execute(executionOptions(async () => result, {
    settleArtifacts: async () => ({ archiveResult: { batchId: 17 } })
  })), result);
  assert.deepEqual(f.events, ['business-outcome', 'durable', 'warning', 'incomplete']);
});

function replay(f, options = {}) {
  const pending = f.pending();
  return f.owner.terminalRegistration.finalize({
    route: { route: 'position-reconciliation', operationToken: 'operation-token' },
    record: { payload: {
      targetBatchId: 17,
      owner: pending && pending.owner,
      metadata: { positionOperationToken: 'operation-token' },
      ...options
    } },
    created: { batch: { id: 17 } }
  });
}

test('live/replay 共享 pending 收口，重复 replay 幂等且恢复补同步 checkpoint', async () => {
  const f = fixture();
  f.setPending(storedPending());
  await replay(f);
  assert.equal(f.pending(), null);
  assert.deepEqual(JSON.parse(f.settings.get(POSITION_SIDE_DB_CHECKPOINT_SETTING)), f.checkpoint);
  assert.equal(f.settings.get(POSITION_SIDE_DB_BOOTSTRAP_SETTING), '');
  const afterFirst = f.events.length;
  await replay(f);
  assert.equal(f.events.length, afterFirst);
});

test('历史无 owner payload 只允许原 file-batch，保留 operation owner 的拒绝', async () => {
  const f = fixture();
  f.setPending(storedPending());
  await replay(f, { owner: undefined });
  assert.equal(f.pending(), null);
  f.setPending(storedPending({ owner: { version: 1, kind: 'operation', operationContext: operationContext() } }));
  await assert.rejects(replay(f, { owner: undefined }), /目标批次与 pending 原任务不一致/);
  assert.ok(f.pending());
});

test('replay route token、metadata、owner 与 targetBatchId 错配时保留 pending', async () => {
  const mutations = [
    { metadata: { positionOperationToken: 'other-token' } },
    { targetBatchId: 18 },
    { owner: { version: 1, kind: 'file-batch', batchContext: batchContext('other-token') } }
  ];
  for (const mutation of mutations) {
    const f = fixture();
    f.setPending(storedPending());
    await assert.rejects(replay(f, mutation), /不一致/);
    assert.equal(f.pending().archiveState, 'incomplete');
  }
});

test('replay 缺少 side-DB 不提前清 pending，durable 事实仍被保留', async () => {
  const f = fixture();
  f.setPending(storedPending());
  f.setService(null);
  await assert.rejects(replay(f), /侧库尚未初始化/);
  assert.equal(f.pending().archiveState, 'durable');
});

test('取消 ACK 先记录 SQLite pending 再登记原 owner outbox', () => {
  const f = fixture({ archiveRequired: false });
  f.setPending(storedPending({
    archiveRequired: false,
    owner: { version: 1, kind: 'operation', operationContext: operationContext() }
  }));
  const cancellation = f.owner.persistPositionCancellationAccepted({ operationToken: 'operation-token' });
  assert.equal(f.pending().terminalOutcome.taskStatus, 'cancelled');
  const intentIndex = f.events.findIndex(([name]) => name === 'terminal-intent');
  assert.ok(intentIndex > 0);
  assert.equal(f.events[intentIndex][1].owner.kind, 'operation');
  assert.equal(cancellation.predicate({ moduleId: 'position-reconciliation-process', taskRunId: 'operation-token' }), true);
});

test('受管 staging 清理保护外部源、pending/outbox 和活动导入路径', async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'position-owner-'));
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
  const staging = path.join(tempRoot, 'run-data', 'position-reconciliation', 'import-staging');
  const files = ['removable', 'outbox', 'active', 'pending'].map((name) => path.join(staging, name, 'source-1', 'input.xlsx'));
  const external = path.join(tempRoot, 'external.xlsx');
  for (const file of [...files, external]) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'source');
  }
  const f = fixture({ databasePath: path.join(tempRoot, 'main.sqlite'), protectedPaths: [files[1]], activePaths: [files[2]] });
  f.setPending(storedPending({ archiveFiles: [{ role: 'input', filePath: files[3], artifactKey: 'pending-input', sourceOperation: 'import', sourceSnapshot: { sizeBytes: 6, mtimeMs: 1, ctimeMs: 2, ino: '3' } }] }));
  await f.owner.cleanupPositionArchiveSourcePaths([...files, external]);
  assert.equal(fs.existsSync(files[0]), false);
  for (const protectedFile of [...files.slice(1), external]) assert.equal(fs.existsSync(protectedFile), true);
});

test('受管 staging 保护状态不可读时 fail-closed', async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'position-owner-protected-'));
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
  const source = path.join(tempRoot, 'run-data', 'position-reconciliation', 'import-staging', 'job', 'source', 'input.xlsx');
  fs.mkdirSync(path.dirname(source), { recursive: true });
  fs.writeFileSync(source, 'source');
  const f = fixture({ databasePath: path.join(tempRoot, 'main.sqlite') });
  f.center.listUnresolvedSourcePaths = () => { throw new Error('outbox unavailable'); };
  await f.owner.cleanupPositionArchiveStaging({ cleanupPaths: [path.dirname(source)] });
  assert.equal(fs.existsSync(source), true);
});

test('Position normalizer 裁剪旧 route 字段且拒绝缺失 token', () => {
  assert.deepEqual(normalizePositionTerminalRoute({ operationToken: ' token ', extra: true }), {
    route: 'position-reconciliation', operationToken: 'token'
  });
  assert.throws(() => normalizePositionTerminalRoute({ operationToken: ' ' }), /operationToken 为空/);
});
