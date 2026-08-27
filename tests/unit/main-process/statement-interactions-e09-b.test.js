'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const XLSX = require('xlsx');

const { canonicalSha256 } = require('../../../src/main-process/background-execution/canonical-json-v1');
const {
  createWorkerThreadAdapter
} = require('../../../src/main-process/background-execution/adapters/worker-thread-adapter');
const {
  createExecutionPolicyRegistry,
  createStaticRegistry
} = require('../../../src/main-process/background-execution/execution-policy-registry');
const {
  createJobEnvelope,
  createServiceControlEnvelope
} = require('../../../src/main-process/background-execution/protocol');
const {
  createResourceGovernor
} = require('../../../src/main-process/background-execution/resource-governor');
const {
  createExecutionSupervisor
} = require('../../../src/main-process/background-execution/supervisor');
const { sourceSnapshotFromStat } = require('../../../src/main-process/archive-center/source-snapshot');
const {
  STATEMENT_RESULT_VALIDATORS
} = require('../../../src/main-process/statement-worker/contracts');
const { createStatementTemplateEvidence } = require('../../../src/main-process/statement-worker/import-contracts');
const {
  createStatementWorkerEntryRegistry
} = require('../../../src/main-process/statement-worker/runtime-bindings');
const { createStatementService } = require('../../../src/main-process/statement-worker/service');
const {
  buildBigAccountInteractionDraft,
  buildStatementImportCandidate,
  createStatementServiceState
} = require('../../../src/main-process/statement-worker/session-state');
const {
  createStatementTokenStore
} = require('../../../src/main-process/statement-worker/token-store');
const {
  createStatementWaitingUserCoordinator
} = require('../../../src/main-process/statement-worker/waiting-user-coordinator');

const ROOT = path.join(__dirname, '..', '..', '..');
const POLICY_FIXTURE = path.join(
  ROOT,
  'changes',
  'background-execution-v3.2.x-contract-baseline',
  'changes',
  'background-execution',
  'validation',
  'fixtures',
  'valid',
  'policy-registry.v3.2.x.json'
);
const STATIC_KEY_FIXTURE = path.join(path.dirname(POLICY_FIXTURE), 'static-key-manifest.v3.2.x.json');

function tokenDraft(overrides = {}) {
  const evidence = {
    sessionKey: 'template-1',
    templateDigest: 'a'.repeat(64),
    sources: [{ resourceId: 'a.xlsx', snapshot: { sizeBytes: 1, mtimeMs: 2, ctimeMs: 3, ino: '4' } }]
  };
  const choiceDomain = {
    mode: 'unfixed',
    rows: [0],
    options: [{ merchantId: 'M001', currency: 'USD', accountNature: 'client' }]
  };
  return {
    purpose: 'big-account',
    serviceGeneration: 3,
    sessionKey: 'template-1',
    sessionRevision: 7,
    allowedChoices: choiceDomain,
    prompt: {
      status: 'select-big-account',
      message: '请选择本次使用的大账号 / 币种',
      selectionMode: 'multi-row',
      templateId: 'template-1',
      rows: [{ index: 0, label: '1.', sourceRowNumber: 2, fileName: 'a.xlsx' }],
      rowsWithEmptyBlocks: [{ index: 0, label: '1.', sourceRowNumber: 2, fileName: 'a.xlsx' }],
      bigAccounts: [{ merchantId: 'M001', currencies: ['USD'], isMultiCurrency: false }],
      expandedBigAccountOptions: [
        { merchantId: 'M001', currency: 'USD', accountNature: 'client' }
      ],
      fixedAssignments: []
    },
    privateContext: { evidence, choiceDomain, detailRows: [['private']] },
    ...overrides
  };
}

function createManagedPolicyRegistry(options = {}) {
  const fixture = JSON.parse(fs.readFileSync(POLICY_FIXTURE, 'utf8'));
  const actionKeys = ['statement:import', 'statement:resolve-big-account'];
  const policies = actionKeys.map((actionKey) => {
    const policy = structuredClone(fixture.actions[actionKey]);
    if (typeof options.policyMutation === 'function') options.policyMutation(policy, actionKey);
    return policy;
  });
  const entryRegistry = createStaticRegistry(createStatementWorkerEntryRegistry({
    workerData: options.workerData
  })).freeze();
  const validatorRegistry = createStaticRegistry(Object.fromEntries(policies.map((policy) => [
    policy.result.validatorKey,
    STATEMENT_RESULT_VALIDATORS[policy.actionKey]
  ]))).freeze();
  return createExecutionPolicyRegistry({
    policies,
    entryRegistry,
    validatorRegistry,
    staticKeys: JSON.parse(fs.readFileSync(STATIC_KEY_FIXTURE, 'utf8')),
    generatedAt: '2026-08-28T00:00:00.000Z',
    baselineRef: 'e09-b-statement-interactions'
  }).freeze();
}

function createManagedHarness(options = {}) {
  const harnessOptions = options;
  const policyRegistry = createManagedPolicyRegistry({
    ...options,
    workerData: {
      ...(options.workerData || {}),
      ...(options.sourceRoot ? { statementSourceRoot: options.sourceRoot } : {})
    }
  });
  const baseGovernor = createResourceGovernor({
    budgets: {
      cpuSlots: 4,
      workerThreadSlots: 4,
      utilityProcessSlots: 1,
      ioHeavySlots: 4,
      memoryBytes: 1024 * 1024 * 1024
    }
  });
  const trace = [];
  const diagnostics = [];
  const workerHandles = [];
  const nativeAdapter = createWorkerThreadAdapter();
  const workerThreadAdapter = Object.freeze({
    kind: 'worker-thread',
    start(startOptions) {
      const handle = nativeAdapter.start({
        ...startOptions,
        onMessage(message) {
          trace.push(structuredClone(message));
          startOptions.onMessage(message);
        }
      });
      workerHandles.push(handle);
      const send = handle.send.bind(handle);
      return Object.freeze({
        ...handle,
        send(message, transferList) {
          trace.push(structuredClone(message));
          if (typeof harnessOptions.onHostSend === 'function' &&
              harnessOptions.onHostSend(message, () => send(message, transferList)) === true) {
            return undefined;
          }
          return send(message, transferList);
        }
      });
    }
  });
  return {
    policyRegistry,
    resourceGovernor: baseGovernor,
    trace,
    diagnostics,
    workerHandles,
    supervisor: createExecutionSupervisor({
      policyRegistry,
      resourceGovernor: baseGovernor,
      workerThreadAdapter,
      diagnostics: (event) => diagnostics.push(event),
      initTimeoutMs: 5000,
      executionTimeoutMs: 15000
    })
  };
}

async function waitFor(predicate, label, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function writeRows(filePath, rows) {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(rows), 'Sheet1');
  XLSX.writeFile(workbook, filePath);
}

function writeStatement(filePath, rows) {
  writeRows(filePath, [
    ['日期', '贷', '借', '币种', '账号'],
    ...rows
  ]);
}

function source(filePath) {
  return {
    resourceId: path.basename(filePath),
    snapshot: sourceSnapshotFromStat(fs.lstatSync(filePath, { bigint: true }))
  };
}

function directTemplateEvidence(templateId = 'template-direct') {
  return createStatementTemplateEvidence({
    templateId,
    templateName: '测试银行-Direct',
    expectedSourceHeaders: ['日期', '贷', '借', '币种', '账号'],
    orderedTargetFields: ['Bill Date', 'Credit Amount', 'Debit Amount', 'Currency', 'MerchantId'],
    mappingByField: {
      'Bill Date': '日期',
      'Credit Amount': '贷',
      'Debit Amount': '借',
      Currency: '币种',
      MerchantId: '账号'
    },
    accountMappingByBankId: {},
    currencyMappings: [],
    amountMappingRules: {
      nameSourceField: '',
      accountSourceField: '',
      signedAmountSourceField: ''
    },
    amountSplitByField: null,
    billSplitMerge: null,
    dateParseOrder: 'auto'
  });
}

function bigAccountTemplateEvidence(options = {}) {
  const templateId = options.templateId || 'template-big';
  return createStatementTemplateEvidence({
    templateId,
    templateName: '测试银行-大账号',
    expectedSourceHeaders: ['日期', '贷', '借', '币种', '账号'],
    orderedTargetFields: ['Bill Date', 'Credit Amount', 'Debit Amount', 'Currency', 'MerchantId'],
    mappingByField: {
      'Bill Date': '日期',
      'Credit Amount': '贷',
      'Debit Amount': '借',
      Currency: '币种',
      MerchantId: '__FIXED__:__MULTI_BIG_ACCOUNT__'
    },
    accountMappingByBankId: {},
    currencyMappings: [],
    amountMappingRules: {
      nameSourceField: '',
      accountSourceField: '',
      signedAmountSourceField: ''
    },
    amountSplitByField: null,
    billSplitMerge: null,
    dateParseOrder: 'auto',
    bigAccounts: options.bigAccounts || [
      { merchantId: 'M001', currencies: ['USD'], accountNature: 'client' }
    ],
    fixedAssignments: options.fixedAssignments || []
  });
}

function importInput(templateEvidence, sourceFiles) {
  return {
    command: 'import',
    sessionKey: templateEvidence.snapshot.templateId,
    sources: sourceFiles.map(source),
    templateEvidence
  };
}

function managedRequest(actionKey, input, ordinal, options = {}) {
  const operationKey = `statement-operation-${ordinal}`;
  const taskRunId = options.taskRunId || `statement-task-${ordinal}`;
  return {
    actionKey,
    operationKey,
    jobId: `statement-job-${ordinal}`,
    production: false,
    input,
    context: {
      kind: 'operation',
      value: {
        taskRunId,
        taskKey: 'file:import',
        moduleId: 'statement',
        parentRunId: options.parentRunId || `statement-parent-${ordinal}`,
        operationKey
      }
    },
    units: []
  };
}

function publicToken(interaction) {
  return {
    tokenId: interaction.tokenId,
    purpose: interaction.purpose,
    serviceGeneration: interaction.serviceGeneration,
    sessionRevision: interaction.sessionRevision,
    expiresAt: interaction.expiresAt,
    allowedChoiceDigest: interaction.allowedChoiceDigest
  };
}

function jobTrace(trace, jobId) {
  return trace.filter((message) =>
    message.jobId === jobId || (message.jobRef && message.jobRef.jobId === jobId));
}

test('token registry严格执行estimate→private insert→adopt ack→single-use并保持bounded状态', () => {
  let now = 1000;
  const store = createStatementTokenStore({
    now: () => now,
    createId: () => 'token-1',
    ttlMs: 100,
    budgetBytes: 1024 * 1024
  });
  const draft = store.prepare(tokenDraft());
  assert.equal(store.snapshot().count, 0, 'estimate不写private registry');
  const record = store.insertPrivate(draft, {
    requestId: 'request-1',
    grantId: 'grant-1',
    reservationId: 'reservation-1',
    owner: { kind: 'interaction-token' },
    ownerJobRef: { actionKey: 'statement:import', operationKey: 'op-1', jobId: 'job-1', unitId: null }
  });
  assert.equal(store.listStatus().length, 0, 'adopt-ack前不公开');
  store.markAdopted('token-1', { grantId: 'grant-1', reservationId: 'reservation-1' });
  assert.deepEqual(store.listStatus(), [{ purpose: 'big-account', expiresAt: 1100 }]);

  const publicToken = {
    tokenId: 'token-1', purpose: 'big-account', serviceGeneration: 3,
    sessionRevision: 7, expiresAt: 1100,
    allowedChoiceDigest: canonicalSha256(record.privateContext.choiceDomain)
  };
  const consumed = store.beginConsume(publicToken, {
    serviceGeneration: 3,
    sessionRevision: 7,
    purpose: 'big-account',
    sessionKey: 'template-1',
    evidence: record.privateContext.evidence,
    choiceDomain: record.privateContext.choiceDomain
  });
  assert.equal(consumed.state, 'consuming');
  assert.throws(() => store.beginConsume(publicToken, {
    serviceGeneration: 3, sessionRevision: 7, purpose: 'big-account', sessionKey: 'template-1',
    evidence: record.privateContext.evidence, choiceDomain: record.privateContext.choiceDomain
  }), (error) => error.code === 'STATEMENT_TOKEN_STALE');
  store.markReleasing('token-1');
  assert.equal(store.remove('token-1').state, 'released');
  assert.deepEqual(store.snapshot(), { count: 0, totalBytes: 0 });

  now = 2000;
  const expiring = createStatementTokenStore({ now: () => now, createId: () => 'token-expired', ttlMs: 1 });
  const expiringDraft = expiring.prepare(tokenDraft());
  expiring.insertPrivate(expiringDraft, {
    requestId: 'r', grantId: 'g', reservationId: 'res', owner: {}, ownerJobRef: {}
  });
  expiring.markAdopted('token-expired', { grantId: 'g', reservationId: 'res' });
  now += 1;
  assert.throws(() => expiring.beginConsume({
    tokenId: 'token-expired', purpose: 'big-account', serviceGeneration: 3,
    sessionRevision: 7, expiresAt: 2001,
    allowedChoiceDigest: expiringDraft.allowedChoiceDigest
  }, {
    serviceGeneration: 3, sessionRevision: 7, purpose: 'big-account', sessionKey: 'template-1',
    evidence: expiringDraft.privateContext.evidence, choiceDomain: expiringDraft.privateContext.choiceDomain
  }), (error) => error.code === 'STATEMENT_TOKEN_EXPIRED');
});

test('token registry对generation/revision/purpose/choice/evidence篡改逐项fail closed且预算/数量不泄漏', () => {
  const store = createStatementTokenStore({ createId: () => 'token-2', ttlMs: 100000 });
  const draft = store.prepare(tokenDraft());
  const record = store.insertPrivate(draft, {
    requestId: 'r2', grantId: 'g2', reservationId: 'res2', owner: {}, ownerJobRef: {}
  });
  store.markAdopted('token-2', { grantId: 'g2', reservationId: 'res2' });
  assert.throws(() => store.prepare(tokenDraft()), (error) => error.code === 'STATEMENT_TOKEN_LIMIT_EXCEEDED');
  const base = {
    tokenId: 'token-2', purpose: 'big-account', serviceGeneration: 3, sessionRevision: 7,
    expiresAt: record.handle.expiresAt, allowedChoiceDigest: record.handle.allowedChoiceDigest
  };
  for (const [key, value] of [['serviceGeneration', 4], ['sessionRevision', 8], ['purpose', 'manual-balance']]) {
    assert.throws(() => store.beginConsume({ ...base, [key]: value }, {
      serviceGeneration: 3, sessionRevision: 7, purpose: 'big-account', sessionKey: 'template-1',
      evidence: record.privateContext.evidence, choiceDomain: record.privateContext.choiceDomain
    }), (error) => error.code === 'STATEMENT_TOKEN_TAMPERED');
  }
  assert.throws(() => store.beginConsume(base, {
    serviceGeneration: 3, sessionRevision: 7, purpose: 'big-account', sessionKey: 'template-1',
    evidence: { ...record.privateContext.evidence, templateDigest: 'b'.repeat(64) },
    choiceDomain: record.privateContext.choiceDomain
  }), (error) => error.code === 'STATEMENT_TOKEN_STALE');
  assert.throws(() => store.beginConsume(base, {
    serviceGeneration: 3, sessionRevision: 7, purpose: 'big-account', sessionKey: 'template-1',
    evidence: record.privateContext.evidence,
    choiceDomain: { ...record.privateContext.choiceDomain, rows: [0, 1] }
  }), (error) => error.code === 'STATEMENT_TOKEN_CHOICE_DOMAIN_STALE');
  assert.equal(record.state, 'published', '失败校验不得消耗token');
  assert.equal(store.snapshot().count, 1);
});

test('waiting-user保持同一TaskRun并exact释放/重取phase与business lock，late owner不能settle', async () => {
  const events = [];
  const owner = (kind) => ({
    async acquire(taskRunId, jobId) {
      events.push(`${kind}:acquire:${taskRunId}:${jobId}`);
      return { id: `${kind}-${jobId}` };
    },
    async release(id, jobId) {
      events.push(`${kind}:release:${id}:${jobId}`);
    }
  });
  const phaseOwner = owner('phase');
  const lockOwner = owner('lock');
  const coordinator = createStatementWaitingUserCoordinator();
  const token = {
    tokenId: 't1', purpose: 'big-account', serviceGeneration: 2, sessionRevision: 5,
    expiresAt: 2000, allowedChoiceDigest: 'a'.repeat(64)
  };
  assert.deepEqual(await coordinator.enterWaiting({
    taskRunId: 'task-1', taskKey: 'file:import', operationKey: 'op-1', jobId: 'job-1',
    token, phaseOwner, phaseLeaseId: 'phase-job-1', lockOwner, lockId: 'lock-job-1'
  }), { taskRunId: 'task-1', status: 'running', phase: 'waiting-user' });
  assert.deepEqual(await coordinator.beginContinuation({
    taskRunId: 'task-1', taskKey: 'file:import', originOperationKey: 'op-1',
    operationKey: 'op-2', jobId: 'job-2',
    token, phaseOwner, lockOwner
  }), { taskRunId: 'task-1', status: 'running', phase: 'executing' });
  await assert.rejects(coordinator.settleContinuation({
    taskRunId: 'task-1', operationKey: 'op-2', jobId: 'late-job',
    outcome: 'failed', phaseOwner, lockOwner
  }), (error) => error.code === 'STATEMENT_CONTINUATION_OWNER_MISMATCH');
  assert.deepEqual(await coordinator.settleContinuation({
    taskRunId: 'task-1', operationKey: 'op-2', jobId: 'job-2',
    outcome: 'succeeded', phaseOwner, lockOwner
  }), { taskRunId: 'task-1', status: 'succeeded', phase: null });
  assert.deepEqual(events, [
    'phase:release:phase-job-1:job-1', 'lock:release:lock-job-1:job-1',
    'lock:acquire:task-1:job-2', 'phase:acquire:task-1:job-2',
    'phase:release:phase-job-2:job-2', 'lock:release:lock-job-2:job-2'
  ]);
});

test('waiting-user部分release失败可按同一owner幂等重试且不重复释放PhaseLease', async () => {
  const events = [];
  let lockAttempts = 0;
  const coordinator = createStatementWaitingUserCoordinator();
  const input = {
    taskRunId: 'task-retry', taskKey: 'file:import', operationKey: 'op-retry', jobId: 'job-origin',
    token: {
      tokenId: 'token-retry', purpose: 'big-account', serviceGeneration: 1, sessionRevision: 0,
      expiresAt: 2000, allowedChoiceDigest: 'b'.repeat(64)
    },
    phaseOwner: {
      async release(id) { events.push(`phase:${id}`); }
    },
    phaseLeaseId: 'phase-origin',
    lockOwner: {
      async release(id) {
        events.push(`lock:${id}`);
        lockAttempts += 1;
        if (lockAttempts === 1) throw new Error('transient lock release failure');
      }
    },
    lockId: 'lock-origin'
  };
  await assert.rejects(coordinator.enterWaiting(input), /transient lock release failure/);
  assert.deepEqual(await coordinator.enterWaiting(input), {
    taskRunId: 'task-retry', status: 'running', phase: 'waiting-user'
  });
  assert.deepEqual(events, ['phase:phase-origin', 'lock:lock-origin', 'lock:lock-origin']);
});

test('continuation phase取得失败且lock补偿首次失败时仅同owner可精确清理后重获', async () => {
  const coordinator = createStatementWaitingUserCoordinator();
  const token = {
    tokenId: 'token-cleanup', purpose: 'big-account', serviceGeneration: 1, sessionRevision: 0,
    expiresAt: 2000, allowedChoiceDigest: 'c'.repeat(64)
  };
  await coordinator.enterWaiting({
    taskRunId: 'task-cleanup', taskKey: 'file:import', operationKey: 'op-origin', jobId: 'job-origin',
    token,
    phaseOwner: { async release() {} }, phaseLeaseId: 'phase-origin',
    lockOwner: { async release() {} }, lockId: 'lock-origin'
  });
  const events = [];
  let releaseAttempts = 0;
  const phaseError = Object.assign(new Error('phase unavailable'), { code: 'PHASE_BUSY' });
  const phaseOwner = {
    async acquire() {
      events.push('phase:acquire');
      throw phaseError;
    }
  };
  const lockOwner = {
    async acquire(_taskRunId, jobId) {
      events.push(`lock:acquire:${jobId}`);
      return { id: `lock-${jobId}` };
    },
    async release(id, jobId) {
      releaseAttempts += 1;
      events.push(`lock:release:${id}:${jobId}:${releaseAttempts}`);
      if (releaseAttempts === 1) throw new Error('transient cleanup failure');
    }
  };
  const continuation = {
    taskRunId: 'task-cleanup', taskKey: 'file:import', originOperationKey: 'op-origin',
    operationKey: 'op-continuation', jobId: 'job-continuation', token, phaseOwner, lockOwner
  };
  await assert.rejects(
    coordinator.beginContinuation(continuation),
    (error) => error.code === 'STATEMENT_CONTINUATION_CLEANUP_REQUIRED'
  );
  await assert.rejects(
    coordinator.beginContinuation({
      ...continuation,
      operationKey: 'op-late',
      jobId: 'job-late'
    }),
    (error) => error.code === 'STATEMENT_CONTINUATION_OWNER_MISMATCH'
  );
  await assert.rejects(
    coordinator.beginContinuation(continuation),
    (error) => error.code === 'PHASE_BUSY' && error.message === 'phase unavailable'
  );
  assert.deepEqual(events, [
    'lock:acquire:job-continuation',
    'phase:acquire',
    'lock:release:lock-job-continuation:job-continuation:1',
    'lock:release:lock-job-continuation:job-continuation:2'
  ], 'cleanup确认前不得重新acquire lock/phase');

  let reacquired = false;
  const resumed = await coordinator.beginContinuation({
    ...continuation,
    operationKey: 'op-resumed',
    jobId: 'job-resumed',
    phaseOwner: {
      async acquire() {
        reacquired = true;
        return { id: 'phase-resumed' };
      }
    }
  });
  assert.equal(reacquired, true);
  assert.deepEqual(resumed, {
    taskRunId: 'task-cleanup', status: 'running', phase: 'executing'
  });
});

test('waiting-user cancel仅在exact token owner ack后终结且失败仅允许同owner重试', async () => {
  const coordinator = createStatementWaitingUserCoordinator();
  assert.deepEqual(Object.keys(coordinator).sort(), [
    'beginContinuation',
    'cancelInteraction',
    'enterWaiting',
    'forgetCancelled',
    'settleContinuation'
  ], '公开facade不得暴露无exact cleanup receipt的waiting删除入口');
  const token = {
    tokenId: 'token-cancel', purpose: 'big-account', serviceGeneration: 2, sessionRevision: 4,
    expiresAt: 3000, allowedChoiceDigest: 'd'.repeat(64)
  };
  await coordinator.enterWaiting({
    taskRunId: 'task-cancel', taskKey: 'file:import', operationKey: 'op-origin', jobId: 'job-origin',
    token,
    phaseOwner: { async release() {} }, phaseLeaseId: 'phase-origin',
    lockOwner: { async release() {} }, lockId: 'lock-origin'
  });
  let attempts = 0;
  let acknowledge;
  const owner = {
    cancel(input) {
      attempts += 1;
      assert.deepEqual(input.token, token);
      if (attempts === 1) return Promise.reject(new Error('transient owner failure'));
      if (attempts === 2) return Promise.resolve(undefined);
      return new Promise((resolve) => { acknowledge = resolve; });
    }
  };
  const request = {
    taskRunId: 'task-cancel', taskKey: 'file:import', originOperationKey: 'op-origin',
    token, cancelOwnerKey: 'worker-generation-2', cancelOwner: owner
  };
  assert.throws(() => coordinator.cancelInteraction({
    ...request,
    token: { tokenId: token.tokenId }
  }), (error) => error.code === 'STATEMENT_WAITING_TOKEN_INVALID');
  await assert.rejects(coordinator.cancelInteraction(request), /transient owner failure/);
  assert.throws(() => coordinator.cancelInteraction({
    ...request,
    cancelOwnerKey: 'worker-generation-3'
  }), (error) => error.code === 'STATEMENT_CONTINUATION_OWNER_MISMATCH');
  await assert.rejects(
    coordinator.cancelInteraction(request),
    (error) => error.code === 'STATEMENT_CANCEL_ACK_INVALID'
  );
  const first = coordinator.cancelInteraction(request);
  const duplicate = coordinator.cancelInteraction(request);
  assert.strictEqual(first, duplicate, 'in-flight duplicate必须共用同一ack promise');
  let settled = false;
  first.finally(() => { settled = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false, 'owner ack前Task不得cancelled');
  acknowledge({ status: 'interaction-cancelled', tokenId: token.tokenId });
  assert.deepEqual(await first, { taskRunId: 'task-cancel', status: 'cancelled', phase: null });
  assert.equal(attempts, 3);
  assert.equal(coordinator.forgetCancelled({ taskRunId: 'task-cancel', tokenId: token.tokenId }), true);
});

test('continuation重新映射的candidate digest变化时在session mutation前fail closed', async () => {
  const templateEvidence = createStatementTemplateEvidence({
    templateId: 'template-digest', templateName: 'digest', expectedSourceHeaders: ['日期', '贷'],
    orderedTargetFields: ['Bill Date', 'Credit Amount', 'Debit Amount', 'Currency', 'MerchantId'],
    mappingByField: {
      'Bill Date': '日期', 'Credit Amount': '贷', 'Debit Amount': '', Currency: '__FIXED__:USD',
      MerchantId: '__FIXED__:__MULTI_BIG_ACCOUNT__'
    },
    accountMappingByBankId: {}, currencyMappings: [],
    amountMappingRules: { nameSourceField: '', accountSourceField: '', signedAmountSourceField: '' },
    amountSplitByField: null, billSplitMerge: null, dateParseOrder: 'auto',
    bigAccounts: [{ merchantId: 'M001', currencies: ['USD'], accountNature: 'client' }],
    fixedAssignments: []
  });
  const request = {
    command: 'import', sessionKey: 'template-digest', templateEvidence,
    sources: [{
      resourceId: 'source-digest', path: '/private/source-digest.xlsx',
      snapshot: { sizeBytes: 1, mtimeMs: 2, ctimeMs: 3, ino: '4' }
    }]
  };
  let value = 10;
  const buildMappedRows = () => {
    const rows = [
      ['Bill Date', 'Credit Amount', 'Debit Amount', 'Currency', 'MerchantId'],
      ['2026-08-01', value, '', 'USD', '']
    ];
    rows.rowMetas = [{ sourceRowNumber: 2 }];
    rows.headerBreaks = [];
    return rows;
  };
  const state = createStatementServiceState(1);
  state.stableSummary = {
    serviceGeneration: 1, sessionRevision: 0, sessionCount: 0, batchCount: 0,
    fileCount: 0, rowCount: 0, pendingInteractionCount: 0, pendingInteractions: [], activePhase: 'idle'
  };
  const draft = await buildBigAccountInteractionDraft(state, request, { buildMappedRows });
  value = 11;
  await assert.rejects(buildStatementImportCandidate(state, request, {
    buildMappedRows,
    bigAccountAssignments: [{ rowIndex: 0, merchantId: 'M001', currency: 'USD' }],
    bigAccountChoiceMode: 'unfixed',
    expectedProvisionalDigest: draft.privateContext.candidateDigest
  }), (error) => error.code === 'STATEMENT_TOKEN_CANDIDATE_STALE');
  assert.equal(state.sessionRevision, 0);
  assert.equal(state.sessions.size, 0);
});

test('真实Statement Service完成pending reservation adoption、同Task continuation与token release ack', async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'statement-e09-b-'));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const filePath = path.join(tempDir, 'source.xlsx');
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
    ['日期', '贷', '借', '币种', '账号'],
    ['2026-08-01', 10, '', 'USD', 'BANK-1'],
    ['日期', '贷', '借', '币种', '账号'],
    ['2026-08-02', '', 2, 'USD', 'BANK-2']
  ]), 'Sheet1');
  XLSX.writeFile(workbook, filePath);
  const importEvidence = {
    command: 'import',
    sessionKey: 'template-big',
    sources: [{
      resourceId: 'source.xlsx',
      snapshot: sourceSnapshotFromStat(fs.lstatSync(filePath, { bigint: true }))
    }],
    templateEvidence: createStatementTemplateEvidence({
      templateId: 'template-big',
      templateName: '大账号模板',
      expectedSourceHeaders: ['日期', '贷', '借', '币种', '账号'],
      orderedTargetFields: ['Bill Date', 'Credit Amount', 'Debit Amount', 'Currency', 'MerchantId'],
      mappingByField: {
        'Bill Date': '日期', 'Credit Amount': '贷', 'Debit Amount': '借',
        Currency: '币种', MerchantId: '__FIXED__:__MULTI_BIG_ACCOUNT__'
      },
      accountMappingByBankId: {}, currencyMappings: [],
      amountMappingRules: { nameSourceField: '', accountSourceField: '', signedAmountSourceField: '' },
      amountSplitByField: null, billSplitMerge: null, dateParseOrder: 'auto',
      bigAccounts: [{ merchantId: 'M001', currencies: ['USD'], accountNature: 'client' }],
      fixedAssignments: []
    })
  };
  const trace = [];
  const service = createStatementService({
    postMessage(message) { trace.push(message); },
    resolveSourceResource(resourceId) { return path.join(tempDir, resourceId); }
  });
  let controlSeq = 0;
  function control(operation, controlId, jobRef, payload) {
    controlSeq += 1;
    service.handleMessage(createServiceControlEnvelope({
      direction: 'command', operation, serviceKey: 'service.statement', controlId,
      workerInstanceId: 'worker-1', serviceGeneration: 1, seq: controlSeq, jobRef, payload
    }, { validate: false }));
  }
  function start(actionKey, operationKey, jobId, input) {
    service.handleMessage(createJobEnvelope({
      direction: 'command', operation: 'job:start', actionKey, operationKey, jobId,
      workerInstanceId: 'worker-1', serviceGeneration: 1, unitId: null, seq: 1,
      context: { kind: 'operation', value: {
        taskRunId: 'same-task', taskKey: 'file:import', moduleId: 'statement',
        parentRunId: 'parent-1', operationKey
      } }, payload: { input }
    }, { validate: false }));
  }
  async function nextOperation(operation, from = 0) {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const found = trace.slice(from).find((message) => message.operation === operation);
      if (found) return found;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error(`missing operation ${operation}: ${JSON.stringify(trace.slice(from).map((message) => ({
      operation: message.operation,
      error: message.payload && message.payload.error
    })))}`);
  }

  control('executor:init', 'init-1', null, {
    contractVersion: 1, policyDigest: 'a'.repeat(64), baseLeaseId: 'base-1'
  });
  start('statement:import', 'same-task/statement:import/1', 'job-import', importEvidence);
  const tokenRequest = await nextOperation('resource:request');
  assert.equal(trace.some((message) => message.operation === 'job:done'), false);
  control('resource:grant', tokenRequest.controlId, tokenRequest.jobRef, {
    requestId: tokenRequest.payload.requestId, grantId: 'grant-token', reservationId: 'reservation-token',
    replacesReservationId: null, granted: tokenRequest.payload.requested, adoptionDeadlineMs: 30000
  });
  const tokenAdopted = await nextOperation('resource:adopted');
  assert.equal(trace.some((message) => message.operation === 'job:done'), false);
  control('resource:adopt-ack', tokenAdopted.controlId, tokenAdopted.jobRef, {
    requestId: tokenRequest.payload.requestId, grantId: 'grant-token', reservationId: 'reservation-token'
  });
  const interactionDone = await nextOperation('job:done');
  assert.equal(interactionDone.payload.result.status, 'interaction-required');
  assert.equal(JSON.stringify(interactionDone.payload.result).includes('detailRows'), false);

  const firstInteraction = interactionDone.payload.result.interaction;
  assert.equal(firstInteraction.prompt.rows.length, 2, '同一文件的两个header block必须分别选择');
  assert.deepEqual(firstInteraction.prompt.rows.map((row) => row.sourceRowNumber), [2, 4]);

  const refreshStart = trace.length;
  start('statement:import', 'same-task/statement:import/2', 'job-refresh', importEvidence);
  const invalidationRelease = await nextOperation('resource:release', refreshStart);
  assert.equal(invalidationRelease.payload.reservationId, 'reservation-token');
  assert.equal(trace.slice(refreshStart).some((message) => message.operation === 'resource:request'), false);
  control('resource:release-ack', invalidationRelease.controlId, invalidationRelease.jobRef, {
    reservationId: 'reservation-token'
  });
  const refreshedTokenRequest = await nextOperation('resource:request', refreshStart);
  control('resource:grant', refreshedTokenRequest.controlId, refreshedTokenRequest.jobRef, {
    requestId: refreshedTokenRequest.payload.requestId,
    grantId: 'grant-token-refresh',
    reservationId: 'reservation-token-refresh',
    replacesReservationId: null,
    granted: refreshedTokenRequest.payload.requested,
    adoptionDeadlineMs: 30000
  });
  const refreshedAdopted = await nextOperation('resource:adopted', refreshStart);
  control('resource:adopt-ack', refreshedAdopted.controlId, refreshedAdopted.jobRef, {
    requestId: refreshedTokenRequest.payload.requestId,
    grantId: 'grant-token-refresh',
    reservationId: 'reservation-token-refresh'
  });
  const refreshedDone = await nextOperation('job:done', refreshStart);
  const interaction = refreshedDone.payload.result.interaction;
  assert.equal(interaction.prompt.rows.length, 2, '同一文件的两个header block必须分别选择');
  assert.deepEqual(interaction.prompt.rows.map((row) => row.sourceRowNumber), [2, 4]);
  const continuationStart = trace.length;
  start('statement:resolve-big-account', 'same-task/statement:resolve-big-account/1', 'job-continuation', {
    command: 'resolve-big-account',
    token: {
      tokenId: interaction.tokenId, purpose: interaction.purpose,
      serviceGeneration: interaction.serviceGeneration, sessionRevision: interaction.sessionRevision,
      expiresAt: interaction.expiresAt, allowedChoiceDigest: interaction.allowedChoiceDigest
    },
    choice: { mode: 'unfixed', assignments: [
      { rowIndex: 0, merchantId: 'M001', currency: 'USD' },
      { rowIndex: 1, merchantId: 'M001', currency: 'USD' }
    ] },
    importEvidence
  });
  const stateRequest = await nextOperation('resource:request', continuationStart);
  control('resource:grant', stateRequest.controlId, stateRequest.jobRef, {
    requestId: stateRequest.payload.requestId, grantId: 'grant-state', reservationId: 'reservation-state',
    replacesReservationId: null, granted: stateRequest.payload.requested, adoptionDeadlineMs: 30000
  });
  const stateAdopted = await nextOperation('resource:adopted', continuationStart);
  control('resource:adopt-ack', stateAdopted.controlId, stateAdopted.jobRef, {
    requestId: stateRequest.payload.requestId, grantId: 'grant-state', reservationId: 'reservation-state'
  });
  const release = await nextOperation('resource:release', continuationStart);
  assert.equal(release.payload.reservationId, 'reservation-token-refresh');
  control('resource:release-ack', release.controlId, release.jobRef, {
    reservationId: 'reservation-token-refresh'
  });
  const continuationDone = await nextOperation('job:done', continuationStart);
  assert.equal(continuationDone.payload.result.status, 'imported');
  assert.equal(continuationDone.payload.result.summary.sessionRevision, 1);
  assert.equal(continuationDone.payload.result.summary.rowCount, 2);
  assert.equal(continuationDone.jobId, 'job-continuation');

  const staleCancelStart = trace.length;
  start('statement:resolve-big-account', 'same-task/statement:resolve-big-account/2', 'job-stale-cancel', {
    command: 'cancel-interaction',
    token: publicToken(interaction)
  });
  const staleCancel = await nextOperation('job:error', staleCancelStart);
  assert.equal(staleCancel.payload.error.code, 'STATEMENT_TOKEN_STALE',
    '已consume token的release tombstone不得冒充pending interaction cancel ack');
  assert.equal(trace.slice(staleCancelStart).some((message) => message.operation === 'resource:request'), false);
});

test('真实Host/Worker在600个合法维护账号的最终public DTO超限时于资源申请前稳定拒绝', async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'statement-e09-b-public-limit-'));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const filePath = path.join(tempDir, 'large-prompt.xlsx');
  writeStatement(filePath, [['2026-08-01', 10, '', 'USD', 'BANK-1']]);
  const accounts = Array.from({ length: 600 }, (_value, index) => ({
    merchantId: `ACCOUNT-${String(index).padStart(3, '0')}-${'M'.repeat(180)}`,
    currencies: ['USD'],
    accountNature: 'client'
  }));
  const evidence = bigAccountTemplateEvidence({
    templateId: 'template-public-limit',
    bigAccounts: accounts
  });
  const harness = createManagedHarness({ sourceRoot: tempDir });
  t.after(async () => {
    await harness.supervisor.shutdown({ forceServices: true, timeoutMs: 5000 });
  });
  const request = managedRequest(
    'statement:import',
    importInput(evidence, [filePath]),
    'public-limit'
  );
  assert.ok(Buffer.byteLength(JSON.stringify(request), 'utf8') < 256 * 1024,
    '测试请求本身必须是合法bounded transport input');
  const result = await harness.supervisor.execute(request);
  assert.equal(result.outcome, 'failed');
  assert.equal(result.error.code, 'STATEMENT_PUBLIC_DTO_TOO_LARGE');
  const trace = jobTrace(harness.trace, request.jobId);
  assert.equal(trace.some((message) => message.operation === 'resource:request'), false,
    '最终public projection必须在任何heavy token resource request前验证');
  assert.equal(trace.filter((message) => ['job:done', 'job:error'].includes(message.operation)).length, 1);
  const status = await harness.supervisor.execute(managedRequest(
    'statement:import',
    { command: 'status' },
    'public-limit-status'
  ));
  assert.equal(status.outcome, 'completed');
  assert.equal(status.result.summary.serviceGeneration, 1);
  assert.equal(status.result.summary.sessionRevision, 0);
  assert.equal(status.result.summary.pendingInteractionCount, 0);
  assert.deepEqual(
    harness.resourceGovernor.snapshot().activeLeases.map((lease) => lease.kind),
    ['base']
  );
});

test('真实Host adoption timer撤销未adopt token后等待release-ack唯一终结且同generation可继续', async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'statement-e09-b-token-timeout-'));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const filePath = path.join(tempDir, 'timeout.xlsx');
  writeStatement(filePath, [['2026-08-01', 10, '', 'USD', 'BANK-1']]);
  const harness = createManagedHarness({
    sourceRoot: tempDir,
    workerData: { statementFaultInjection: { withholdAdoptOrdinal: 1 } },
    policyMutation(policy) {
      policy.service.resourceControl.adoptionTimeoutMs = 20;
    }
  });
  t.after(async () => {
    await harness.supervisor.shutdown({ forceServices: true, timeoutMs: 5000 });
  });
  const request = managedRequest(
    'statement:import',
    importInput(bigAccountTemplateEvidence({ templateId: 'template-timeout' }), [filePath]),
    'token-timeout'
  );
  const failed = await harness.supervisor.execute(request);
  assert.equal(failed.outcome, 'failed');
  assert.equal(failed.error.code, 'STATEMENT_ADOPTION_TIMEOUT');
  const trace = jobTrace(harness.trace, request.jobId);
  for (const operation of ['resource:grant', 'resource:revoke', 'resource:release', 'resource:release-ack']) {
    assert.equal(trace.some((message) => message.operation === operation), true, operation);
  }
  assert.equal(trace.some((message) => message.operation === 'resource:adopted'), false);
  const releaseAckIndex = trace.findIndex((message) => message.operation === 'resource:release-ack');
  const terminalIndex = trace.findIndex((message) => message.operation === 'job:error');
  assert.ok(releaseAckIndex >= 0 && terminalIndex > releaseAckIndex,
    'token release-ack必须先于唯一job:error');
  assert.equal(trace.filter((message) => ['job:done', 'job:error'].includes(message.operation)).length, 1);

  const status = await harness.supervisor.execute(managedRequest(
    'statement:import',
    { command: 'status' },
    'token-timeout-status'
  ));
  assert.equal(status.outcome, 'completed');
  assert.equal(status.result.summary.serviceGeneration, 1);
  assert.equal(status.result.summary.sessionRevision, 0);
  assert.equal(status.result.summary.pendingInteractionCount, 0);
  assert.deepEqual(
    harness.resourceGovernor.snapshot().activeLeases.map((lease) => lease.kind),
    ['base']
  );
});

test('真实Host/Worker对grant后token adoption异常走exact revoke/release且不关闭generation', async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'statement-e09-b-post-grant-failure-'));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const filePath = path.join(tempDir, 'post-grant.xlsx');
  writeStatement(filePath, [['2026-08-01', 10, '', 'USD', 'BANK-1']]);
  const harness = createManagedHarness({
    sourceRoot: tempDir,
    workerData: { statementFaultInjection: { failAfterGrantOrdinal: 1 } }
  });
  t.after(async () => {
    await harness.supervisor.shutdown({ forceServices: true, timeoutMs: 5000 });
  });
  const request = managedRequest(
    'statement:import',
    importInput(bigAccountTemplateEvidence({ templateId: 'template-post-grant' }), [filePath]),
    'post-grant-failure'
  );
  const failed = await harness.supervisor.execute(request);
  assert.equal(failed.outcome, 'failed');
  assert.equal(failed.error.code, 'STATEMENT_POST_GRANT_ADOPTION_FAILED');
  const trace = jobTrace(harness.trace, request.jobId);
  for (const operation of ['resource:grant', 'resource:revoke', 'resource:release', 'resource:release-ack']) {
    assert.equal(trace.some((message) => message.operation === operation), true, operation);
  }
  assert.equal(trace.some((message) => message.operation === 'resource:adopted'), false);
  assert.equal(trace.filter((message) => ['job:done', 'job:error'].includes(message.operation)).length, 1);
  assert.equal(harness.diagnostics.some((event) => event.type === 'service-generation-closed'), false);
  const status = await harness.supervisor.execute(managedRequest(
    'statement:import',
    { command: 'status' },
    'post-grant-status'
  ));
  assert.equal(status.outcome, 'completed');
  assert.equal(status.result.summary.serviceGeneration, 1);
  assert.equal(status.result.summary.pendingInteractionCount, 0);
  assert.deepEqual(harness.resourceGovernor.snapshot().activeLeases.map((lease) => lease.kind), ['base']);
});

test('真实Host/Worker对grant后persistent异常也保留exact cleanup tombstone并同代复用', async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'statement-e09-b-persistent-grant-failure-'));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const filePath = path.join(tempDir, 'persistent.xlsx');
  writeStatement(filePath, [['2026-08-01', 10, '', 'USD', 'M001']]);
  const harness = createManagedHarness({
    sourceRoot: tempDir,
    workerData: { statementFaultInjection: { failAfterGrantOrdinal: 1 } }
  });
  t.after(async () => {
    await harness.supervisor.shutdown({ forceServices: true, timeoutMs: 5000 });
  });
  const request = managedRequest(
    'statement:import',
    importInput(directTemplateEvidence('template-persistent-post-grant'), [filePath]),
    'persistent-post-grant-failure'
  );
  const failed = await harness.supervisor.execute(request);
  assert.equal(failed.outcome, 'failed');
  assert.equal(failed.error.code, 'STATEMENT_POST_GRANT_ADOPTION_FAILED');
  const trace = jobTrace(harness.trace, request.jobId);
  for (const operation of ['resource:grant', 'resource:revoke', 'resource:release', 'resource:release-ack']) {
    assert.equal(trace.some((message) => message.operation === operation), true, operation);
  }
  assert.equal(trace.some((message) => message.operation === 'resource:adopted'), false);
  assert.equal(trace.filter((message) => ['job:done', 'job:error'].includes(message.operation)).length, 1);
  assert.equal(harness.diagnostics.some((event) => event.type === 'service-generation-closed'), false);
  const status = await harness.supervisor.execute(managedRequest(
    'statement:import',
    { command: 'status' },
    'persistent-post-grant-status'
  ));
  assert.equal(status.result.summary.serviceGeneration, 1);
  assert.equal(status.result.summary.sessionRevision, 0);
  assert.deepEqual(harness.resourceGovernor.snapshot().activeLeases.map((lease) => lease.kind), ['base']);
});

test('真实fixed-mode Worker对repeated-header全空/全零按legacy NO_TRANSACTION_DATA零资源收口', async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'statement-e09-b-zero-'));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const emptyPath = path.join(tempDir, 'empty.xlsx');
  const zeroPath = path.join(tempDir, 'zero.xlsx');
  writeRows(emptyPath, [
    ['日期', '贷', '借', '币种', '账号'],
    ['2026-08-01', '', '', 'USD', 'BANK-EMPTY'],
    ['日期', '贷', '借', '币种', '账号'],
    ['2026-08-02', '', '', 'USD', 'BANK-EMPTY-2']
  ]);
  writeRows(zeroPath, [
    ['日期', '贷', '借', '币种', '账号'],
    ['2026-08-03', 0, 0, 'USD', 'BANK-ZERO'],
    ['日期', '贷', '借', '币种', '账号'],
    ['2026-08-04', '0.00', '-0', 'USD', 'BANK-ZERO-2']
  ]);
  const evidence = bigAccountTemplateEvidence({
    templateId: 'template-zero',
    fixedAssignments: [
      { merchantId: 'M001', currency: 'USD', rowIndex: 0 },
      { merchantId: 'M001', currency: 'USD', rowIndex: 1 }
    ]
  });
  const harness = createManagedHarness({ sourceRoot: tempDir });
  t.after(async () => {
    await harness.supervisor.shutdown({ forceServices: true, timeoutMs: 5000 });
  });
  const request = managedRequest(
    'statement:import',
    importInput(evidence, [emptyPath, zeroPath]),
    'zero'
  );
  const failed = await harness.supervisor.execute(request);
  assert.equal(failed.outcome, 'failed');
  assert.equal(failed.error.code, 'NO_TRANSACTION_DATA');
  const trace = jobTrace(harness.trace, request.jobId);
  assert.equal(trace.some((message) => message.operation === 'resource:request'), false);
  assert.equal(trace.filter((message) => ['job:done', 'job:error'].includes(message.operation)).length, 1);
  const status = await harness.supervisor.execute(managedRequest(
    'statement:import',
    { command: 'status' },
    'zero-status'
  ));
  assert.equal(status.outcome, 'completed');
  assert.equal(status.result.summary.serviceGeneration, 1);
  assert.equal(status.result.summary.sessionRevision, 0);
  assert.equal(status.result.summary.sessionCount, 0);
  assert.equal(status.result.summary.rowCount, 0);
  assert.equal(status.result.summary.pendingInteractionCount, 0);
  assert.deepEqual(
    harness.resourceGovernor.snapshot().activeLeases.map((lease) => lease.kind),
    ['base']
  );
});

test('真实Host/Governor/Worker显式cancel-interaction等待exact release-ack且保留Base/Persistent', async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'statement-e09-b-explicit-cancel-'));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const stablePath = path.join(tempDir, 'stable.xlsx');
  const promptPath = path.join(tempDir, 'prompt.xlsx');
  writeStatement(stablePath, [['2026-07-31', 5, '', 'USD', 'STABLE']]);
  writeStatement(promptPath, [['2026-08-01', 10, '', 'USD', 'BANK-1']]);
  let heldReleaseAck = null;
  let didWithholdReleaseAck = false;
  const harness = createManagedHarness({
    sourceRoot: tempDir,
    onHostSend(message, dispatch) {
      if (message.operation === 'resource:release-ack' && !didWithholdReleaseAck) {
        didWithholdReleaseAck = true;
        heldReleaseAck = dispatch;
        return true;
      }
      return false;
    }
  });
  t.after(async () => {
    await harness.supervisor.shutdown({ forceServices: true, timeoutMs: 5000 });
  });
  const taskRunId = 'same-task-explicit-cancel';
  const stable = await harness.supervisor.execute(managedRequest(
    'statement:import',
    importInput(directTemplateEvidence('template-cancel-stable'), [stablePath]),
    'cancel-stable',
    { taskRunId }
  ));
  assert.equal(stable.outcome, 'completed');
  assert.equal(stable.result.summary.sessionRevision, 1);
  assert.deepEqual(
    harness.resourceGovernor.snapshot().activeLeases.map((lease) => lease.kind).sort(),
    ['base', 'persistent']
  );

  const issuedRequest = managedRequest(
    'statement:import',
    importInput(bigAccountTemplateEvidence({ templateId: 'template-cancel-prompt' }), [promptPath]),
    'cancel-issued',
    { taskRunId }
  );
  const issued = await harness.supervisor.execute(issuedRequest);
  assert.equal(issued.outcome, 'completed');
  assert.equal(issued.result.status, 'interaction-required');
  const token = publicToken(issued.result.interaction);
  assert.deepEqual(
    harness.resourceGovernor.snapshot().activeLeases.map((lease) => lease.kind).sort(),
    ['base', 'pending-interaction', 'persistent']
  );

  const coordinator = createStatementWaitingUserCoordinator();
  assert.equal(coordinator.invalidate, undefined, '真实Host调用面不得有无ack invalidation旁路');
  await coordinator.enterWaiting({
    taskRunId,
    taskKey: 'file:import',
    operationKey: issuedRequest.operationKey,
    jobId: issuedRequest.jobId,
    token,
    phaseOwner: { async release() {} },
    phaseLeaseId: 'phase-issued',
    lockOwner: { async release() {} },
    lockId: 'lock-issued'
  });
  let cancelOwnerAttempts = 0;
  let workerCancelExecutions = 0;
  const cancelOwner = {
    cancel() {
      cancelOwnerAttempts += 1;
      if (cancelOwnerAttempts === 1) return Promise.reject(new Error('transient cancel route failure'));
      workerCancelExecutions += 1;
      return harness.supervisor.execute(managedRequest(
        'statement:resolve-big-account',
        { command: 'cancel-interaction', token },
        `cancel-interaction-${workerCancelExecutions}`,
        { taskRunId }
      )).then((result) => {
        assert.equal(result.outcome, 'completed', JSON.stringify({
          outcome: result.outcome,
          error: result.error,
          diagnostics: harness.diagnostics
        }));
        return result.result;
      });
    }
  };
  const cancellationInput = {
    taskRunId,
    taskKey: 'file:import',
    originOperationKey: issuedRequest.operationKey,
    token,
    cancelOwnerKey: 'service.statement/generation/1',
    cancelOwner
  };
  await assert.rejects(coordinator.cancelInteraction(cancellationInput), /transient cancel route failure/);
  assert.throws(() => coordinator.cancelInteraction({
    ...cancellationInput,
    cancelOwnerKey: 'service.statement/generation/2'
  }), (error) => error.code === 'STATEMENT_CONTINUATION_OWNER_MISMATCH');
  const first = coordinator.cancelInteraction(cancellationInput);
  const duplicate = coordinator.cancelInteraction(cancellationInput);
  assert.strictEqual(first, duplicate);
  let taskCancelled = false;
  first.then(() => { taskCancelled = true; });
  await waitFor(() => heldReleaseAck !== null, 'withheld token release ack');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(taskCancelled, false, 'release-ack前Task必须保持running/waiting-user');
  assert.deepEqual(
    harness.resourceGovernor.snapshot().activeLeases.map((lease) => lease.kind).sort(),
    ['base', 'persistent', 'phase']
  );
  const dispatchReleaseAck = heldReleaseAck;
  heldReleaseAck = null;
  dispatchReleaseAck();
  assert.deepEqual(await first, { taskRunId, status: 'cancelled', phase: null });
  assert.equal(cancelOwnerAttempts, 2);
  assert.equal(workerCancelExecutions, 1);
  assert.deepEqual(await coordinator.cancelInteraction(cancellationInput), {
    taskRunId, status: 'cancelled', phase: null
  });
  assert.equal(workerCancelExecutions, 1, '已ack重复cancel不得再次命中Worker');
  const workerRetry = await harness.supervisor.execute(managedRequest(
    'statement:resolve-big-account',
    { command: 'cancel-interaction', token },
    'cancel-interaction-owner-retry',
    { taskRunId }
  ));
  assert.equal(workerRetry.outcome, 'completed');
  assert.deepEqual(workerRetry.result, {
    status: 'interaction-cancelled',
    tokenId: token.tokenId
  }, 'Worker必须对同一exact cancel token的结果丢失重试保持幂等');

  const status = await harness.supervisor.execute(managedRequest(
    'statement:import',
    { command: 'status' },
    'cancel-status',
    { taskRunId }
  ));
  assert.equal(status.result.summary.serviceGeneration, 1);
  assert.equal(status.result.summary.sessionRevision, 1);
  assert.equal(status.result.summary.fileCount, 1);
  assert.equal(status.result.summary.pendingInteractionCount, 0);
  assert.equal(
    harness.resourceGovernor.snapshot().activeLeases.filter((lease) =>
      lease.kind === 'pending-interaction'
    ).length,
    0,
    'exact release-ack后PendingInteractionReservation必须归零'
  );
  assert.deepEqual(
    harness.resourceGovernor.snapshot().activeLeases.map((lease) => lease.kind).sort(),
    ['base', 'persistent']
  );
  assert.equal(harness.diagnostics.some((event) => event.type === 'service-generation-closed'), false);
});

test('真实Supervisor/Host/Worker双source initial与continuation safe-point cancel无终态后request且同代复用', async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'statement-e09-b-multisource-cancel-'));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const firstPath = path.join(tempDir, 'first-large.xlsx');
  const secondPath = path.join(tempDir, 'second.xlsx');
  const largeRows = Array.from({ length: 20000 }, (_value, index) => [
    `2026-08-${String((index % 28) + 1).padStart(2, '0')}`,
    index + 1,
    '',
    'USD',
    `BANK-${index}`
  ]);
  writeStatement(firstPath, largeRows);
  writeStatement(secondPath, [['2026-08-29', '', 2, 'USD', 'BANK-LAST']]);
  const evidence = bigAccountTemplateEvidence({ templateId: 'template-multisource-cancel' });
  const input = importInput(evidence, [firstPath, secondPath]);
  const harness = createManagedHarness({
    sourceRoot: tempDir,
    policyMutation(policy) {
      policy.cancellation.capability = 'user-cooperative';
    }
  });
  let shutDown = false;
  t.after(async () => {
    if (!shutDown) {
      await harness.supervisor.shutdown({ forceServices: true, timeoutMs: 5000 });
    }
  });

  async function cancelAfterWorkerStarts(request) {
    const control = harness.supervisor.start(request);
    await waitFor(() => harness.trace.some((message) =>
      message.operation === 'job:start' && message.jobId === request.jobId), `${request.jobId} start`);
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(control.cancel({ reason: 'test-safe-point' }), true);
    const result = await control.promise;
    assert.equal(result.outcome, 'cancelled', JSON.stringify({ result, diagnostics: harness.diagnostics }));
    const trace = jobTrace(harness.trace, request.jobId);
    const terminals = trace.filter((message) => ['job:done', 'job:error'].includes(message.operation));
    assert.equal(terminals.length, 1, '每个job只能有一个Worker终态');
    assert.equal(trace.some((message) => message.operation === 'resource:request'), false,
      'safe-point cancel后不得发任何resource request');
    const terminalIndex = harness.trace.indexOf(terminals[0]);
    assert.equal(harness.trace.slice(terminalIndex + 1).some((message) =>
      message.operation === 'resource:request' &&
      message.jobRef && message.jobRef.jobId === request.jobId), false,
    'terminal后不得出现late resource request');
    return result;
  }

  const initialRequest = managedRequest(
    'statement:import',
    input,
    'multisource-initial-cancel'
  );
  await cancelAfterWorkerStarts(initialRequest);
  let status = await harness.supervisor.execute(managedRequest(
    'statement:import',
    { command: 'status' },
    'multisource-after-initial-cancel'
  ));
  assert.equal(status.result.summary.serviceGeneration, 1);
  assert.equal(status.result.summary.sessionRevision, 0);
  assert.equal(status.result.summary.pendingInteractionCount, 0);
  assert.deepEqual(harness.resourceGovernor.snapshot().activeLeases.map((lease) => lease.kind), ['base']);

  const taskRunId = 'same-task-multisource-continuation';
  const issued = await harness.supervisor.execute(managedRequest(
    'statement:import',
    input,
    'multisource-issued',
    { taskRunId }
  ));
  assert.equal(issued.outcome, 'completed');
  assert.equal(issued.result.status, 'interaction-required');
  assert.equal(issued.result.interaction.prompt.rows.length, 2);
  const token = publicToken(issued.result.interaction);
  const continuationRequest = managedRequest(
    'statement:resolve-big-account',
    {
      command: 'resolve-big-account',
      token,
      choice: {
        mode: 'unfixed',
        assignments: [
          { rowIndex: 0, merchantId: 'M001', currency: 'USD' },
          { rowIndex: 1, merchantId: 'M001', currency: 'USD' }
        ]
      },
      importEvidence: input
    },
    'multisource-continuation-cancel',
    { taskRunId }
  );
  await cancelAfterWorkerStarts(continuationRequest);
  const continuationTrace = jobTrace(harness.trace, continuationRequest.jobId);
  for (const operation of ['resource:release', 'resource:release-ack']) {
    assert.equal(continuationTrace.some((message) => message.operation === operation), false,
      `${operation}使用token原owner jobRef，不得错误冒充continuation owner`);
  }
  const tokenRelease = harness.trace.find((message) =>
    message.operation === 'resource:release' &&
    message.payload.reason === 'job-failed' &&
    message.jobRef && message.jobRef.jobId === `statement-job-multisource-issued`);
  assert.ok(tokenRelease, 'consuming token必须按原reservation owner精确释放');
  const tokenReleaseAck = harness.trace.find((message) =>
    message.operation === 'resource:release-ack' &&
    message.controlId === tokenRelease.controlId &&
    message.payload.reservationId === tokenRelease.payload.reservationId);
  assert.ok(tokenReleaseAck, 'consuming token取消必须等待exact release-ack');
  const continuationTerminal = continuationTrace.find((message) => message.operation === 'job:error');
  assert.ok(
    harness.trace.indexOf(tokenReleaseAck) < harness.trace.indexOf(continuationTerminal),
    'continuation取消终态必须在token release-ack之后'
  );
  status = await harness.supervisor.execute(managedRequest(
    'statement:import',
    { command: 'status' },
    'multisource-after-continuation-cancel',
    { taskRunId }
  ));
  assert.equal(status.result.summary.serviceGeneration, 1);
  assert.equal(status.result.summary.sessionRevision, 0);
  assert.equal(status.result.summary.pendingInteractionCount, 0);
  assert.deepEqual(harness.resourceGovernor.snapshot().activeLeases.map((lease) => lease.kind), ['base']);
  assert.equal(harness.diagnostics.some((event) => event.type === 'service-generation-closed'), false);

  await harness.supervisor.shutdown({ forceServices: true, timeoutMs: 5000 });
  shutDown = true;
  assert.equal(harness.resourceGovernor.snapshot().activeLeaseCount, 0);
  assert.equal(harness.resourceGovernor.snapshot().activeDependencyCount, 0);
});
