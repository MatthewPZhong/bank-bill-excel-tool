'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const XLSX = require('xlsx');

const { canonicalSha256 } = require('../../../src/main-process/background-execution/canonical-json-v1');
const {
  createJobEnvelope,
  createServiceControlEnvelope
} = require('../../../src/main-process/background-execution/protocol');
const { sourceSnapshotFromStat } = require('../../../src/main-process/archive-center/source-snapshot');
const { createStatementTemplateEvidence } = require('../../../src/main-process/statement-worker/import-contracts');
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
});
