'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  STATEMENT_RESOURCE_CONTRACT,
  createStatementBalanceSeedOverwriteReleaseCharacterization
} = require('../../../src/main-process/statement-worker/contracts');
const {
  writeBalanceSeedRecords
} = require('../../../src/backend/balance-seed-store');
const {
  prepareManualBalanceSeedSubmission
} = require('../../../src/main-process/manual-balance-seed-preflight');
const {
  estimateStatementPendingInteractionFootprint
} = require('../../../src/main-process/statement-worker/state-footprint');
const {
  buildStatementProbeProjection,
  createStatementProbeLegacyGlobals
} = require('../../../src/main-process/statement-worker/probe-state-builder');

const ROOT = path.join(__dirname, '..', '..', '..');
const PROBE_PATH = path.join(ROOT, 'scripts', 'statement-state-footprint-probe.js');
const GOLDEN = require('../../fixtures/statement/e09-p0-legacy-golden.json');

function runProbe(env = process.env) {
  const raw = execFileSync(process.execPath, [
    '--expose-gc',
    PROBE_PATH,
    '--rows', '25000',
    '--batches', '4',
    '--tokens', '1'
  ], {
    cwd: ROOT,
    encoding: 'utf8',
    env,
    maxBuffer: 1024 * 1024
  });
  return JSON.parse(raw);
}

function deterministicProbeProjection(result) {
  return {
    inputs: result.inputs,
    stateFootprint: result.stateFootprint,
    pendingFootprints: result.pendingFootprints,
    balanceSeedOverwriteFootprint: result.balanceSeedOverwriteFootprint,
    legacyInventory: result.legacyInventory,
    ownership: result.ownership,
    mainTokenHandleBytes: result.mainTokenHandleBytes,
    publicDtoBytes: result.publicDtoBytes,
    balanceSeedOverwritePublicDtoBytes: result.balanceSeedOverwritePublicDtoBytes
  };
}

test('25k行/4批次/1重token基线规模probe覆盖六globals与独立overwrite footprint并在canonical预算内', () => {
  const result = runProbe();
  assert.deepEqual(result.inputs, GOLDEN.footprintBaseline.inputs);
  assert.equal(result.probeVersion, 2);
  assert.equal(result.sampleClass, 'generated-production-shape-not-business-representative');
  assert.equal(result.productionEnabled, false);
  assert.equal(result.pendingFootprints.length, 1);
  assert.ok(result.measured.heapUsedDeltaBytes > 0);
  assert.ok(result.measured.rssAfterBytes > 0);
  assert.ok(result.stateFootprint.rawBytes > 0);
  assert.ok(result.stateFootprint.estimatedBytes >= result.stateFootprint.rawBytes);
  assert.ok(
    result.stateFootprint.estimatedBytes < STATEMENT_RESOURCE_CONTRACT.persistentStateBudgetBytes
  );
  assert.ok(
    result.pendingFootprints[0].estimatedBytes <
      STATEMENT_RESOURCE_CONTRACT.pendingInteractionBudgetBytes
  );
  assert.ok(
    result.balanceSeedOverwriteFootprint.estimatedBytes <
      STATEMENT_RESOURCE_CONTRACT.pendingInteractionBudgetBytes
  );
  assert.ok(
    result.stateFootprint.estimatedBytes + result.pendingFootprints[0].estimatedBytes >=
      result.measured.heapUsedDeltaBytes,
    '带50% headroom的state+token reservation不得低于本次retained heap delta'
  );
  const { kind: stateKind, ...stateFootprint } = result.stateFootprint;
  const { kind: pendingKind, ...pendingFootprint } = result.pendingFootprints[0];
  assert.equal(stateKind, 'persistent-state');
  assert.equal(pendingKind, 'pending-interaction');
  assert.deepEqual(stateFootprint, GOLDEN.footprintBaseline.state);
  assert.deepEqual(pendingFootprint, GOLDEN.footprintBaseline.pending);
  assert.deepEqual(
    result.balanceSeedOverwriteFootprint,
    GOLDEN.footprintBaseline.balanceSeedOverwrite
  );
  assert.deepEqual(result.legacyInventory, GOLDEN.footprintBaseline.legacyInventory);
  assert.equal(result.mainTokenHandleBytes, GOLDEN.footprintBaseline.mainTokenHandleBytes);
  assert.equal(result.publicDtoBytes, GOLDEN.footprintBaseline.publicDtoBytes);
  assert.equal(
    result.balanceSeedOverwritePublicDtoBytes,
    GOLDEN.footprintBaseline.balanceSeedOverwritePublicDtoBytes
  );
  assert.match(result.ownership.mainTokenHandle, /tokenId replaces legacy Main contextId/);
  assert.match(result.ownership.legacyCallback, /not projected/);
  assert.ok(result.publicDtoBytes < STATEMENT_RESOURCE_CONTRACT.publicInteractionMaxBytes);
  assert.match(result.caveat, /not a parser peak/);
});

test('六globals projection冻结big/manual/scope所有权且callback与legacy contextId不进入目标graph', () => {
  const seed = [
    ['BillDate', 'MerchantId', 'Currency', 'Credit Amount', 'Debit Amount'],
    ['2026-08-01', 'M001', 'USD', '100', '']
  ];
  for (const purpose of ['big-account', 'manual-balance', 'scope-generation']) {
    const legacy = createStatementProbeLegacyGlobals({
      seed,
      rows: 8,
      batches: 2,
      root: '/private/absolute-source-path-must-not-survive',
      purpose
    });
    const projection = buildStatementProbeProjection(legacy, { purpose });
    assert.deepEqual(
      projection.legacyInventory.globalNames,
      GOLDEN.footprintBaseline.legacyInventory.globalNames
    );
    assert.equal(projection.privateContexts[0].purpose, purpose);
    assert.equal(projection.mainTokenHandles[0].purpose, purpose);
    assert.equal(Object.hasOwn(projection.mainTokenHandles[0], 'privateContext'), false);
    const projectedJson = JSON.stringify({
      serviceState: projection.serviceState,
      mainTokenHandles: projection.mainTokenHandles,
      privateContexts: projection.privateContexts
    });
    assert.doesNotMatch(projectedJson, /assertSessionCurrent/);
    assert.doesNotMatch(projectedJson, /private\/absolute-source-path/);
    assert.doesNotMatch(projectedJson, /probe-context-1/);
    if (purpose === 'big-account') {
      assert.equal(projection.legacyInventory.assertSessionCurrentPresent, true);
      assert.equal(projection.legacyInventory.legacyBigAccountContextIdPresent, true);
      assert.equal(Object.hasOwn(projection.privateContexts[0], 'contextId'), false);
      assert.equal(
        projection.privateContexts[0].rows[0].fileName,
        'pending-source.xlsx',
        'raw basename只保留在private pending context供后续Service关联'
      );
    }
  }
});

test('真实legacy overwrite confirmation投影为独立可序列化footprint并冻结四类release义务', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'statement-overwrite-probe-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const seed = [
    ['BillDate', 'MerchantId', 'Currency', 'Credit Amount', 'Debit Amount'],
    ['2026-08-01', 'M000001', 'USD', '100', '']
  ];
  const legacy = createStatementProbeLegacyGlobals({
    seed,
    rows: 2,
    batches: 1,
    root,
    purpose: 'manual-balance'
  });
  writeBalanceSeedRecords(root, 'E09ProbeBank', [{
    merchantId: 'M000001',
    currency: 'USD',
    billDate: '2026-07-31',
    endBalance: 1000,
    templateName: 'E09ProbeBank-上海',
    generationMethod: '人工录入',
    updatedAt: '2026-08-26T00:00:00.000Z'
  }]);
  let contextOrdinal = 0;
  const initialArgs = () => ({
    payload: { billDate: '2026-07-31', endBalance: '1200' },
    confirmation: null,
    pendingPrompt: legacy.lastManualBalancePrompt,
    importContext: legacy.lastFileImportContext,
    generatedExports: legacy.lastGeneratedExports,
    storageRoot: root,
    session: legacy.statementImportSessions.values().next().value,
    createContextId: () => `legacy-balance-context-${++contextOrdinal}`,
    createFreshnessGuard: () => ({
      inputFilePaths: [path.join(root, 'source-1.xlsx')],
      assertFresh() {}
    })
  });
  const first = prepareManualBalanceSeedSubmission(initialArgs());
  assert.equal(first.prepared.result.status, 'confirm-overwrite');
  assert.equal(typeof first.nextConfirmation.assertFresh, 'function');
  assert.equal(first.nextConfirmation.plan.records.length, 1);

  legacy.lastPendingBalanceSeedConfirmation = first.nextConfirmation;
  const projection = buildStatementProbeProjection(legacy, {
    purpose: 'manual-balance',
    tokenId: 'overwrite-token-1',
    reservationId: 'overwrite-reservation-1'
  });
  const privateContext = projection.privateContexts[0];
  assert.equal(projection.legacyInventory.balanceSeedConfirmationPresent, true);
  assert.equal(projection.legacyInventory.balanceSeedConfirmationCallbackPresent, true);
  assert.equal(projection.legacyInventory.balanceSeedConfirmationRecordCount, 1);
  assert.equal(privateContext.kind, 'balance-seed-overwrite');
  const overwriteHandle = projection.mainTokenHandles[0];
  assert.deepEqual(projection.balanceSeedOverwriteResult, {
    interaction: {
      allowedChoiceDigest: overwriteHandle.allowedChoiceDigest,
      expiresAt: overwriteHandle.expiresAt,
      prompt: {
        message: '该日期的余额已存在，确认覆盖吗？',
        status: 'confirm-overwrite'
      },
      purpose: 'manual-balance',
      serviceGeneration: overwriteHandle.serviceGeneration,
      sessionRevision: overwriteHandle.sessionRevision,
      tokenId: overwriteHandle.tokenId
    },
    status: 'interaction-required'
  });
  const projectedJson = JSON.stringify({
    privateContext,
    publicResult: projection.balanceSeedOverwriteResult
  });
  assert.doesNotMatch(projectedJson, /legacy-balance-context|assertFresh|storageRoot|inputFilePaths/);
  assert.doesNotMatch(projectedJson, new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  const footprint = estimateStatementPendingInteractionFootprint(privateContext);
  assert.equal(footprint.kind, 'pending-interaction');
  assert.ok(footprint.estimatedBytes < STATEMENT_RESOURCE_CONTRACT.pendingInteractionBudgetBytes);

  const confirmed = prepareManualBalanceSeedSubmission({
    payload: {
      contextId: first.prepared.result.contextId,
      confirmOverwrite: true
    },
    confirmation: first.nextConfirmation
  });
  assert.equal(confirmed.prepared.proceed, true);
  assert.equal(confirmed.prepared.confirmedOverwrite, true);

  const stale = prepareManualBalanceSeedSubmission({
    payload: {
      contextId: first.prepared.result.contextId,
      confirmOverwrite: true
    },
    confirmation: {
      ...first.nextConfirmation,
      assertFresh() { throw new Error('seed changed'); }
    }
  });
  assert.equal(stale.prepared.result.errorCode, 'BALANCE_SEED_CONFIRMATION_CHANGED');
  assert.ok(stale.nextConfirmation, 'legacy现状在stale错误后仍保留旧confirmation');

  const replacement = prepareManualBalanceSeedSubmission(initialArgs());
  assert.equal(replacement.prepared.result.status, 'confirm-overwrite');
  assert.notEqual(
    replacement.prepared.result.contextId,
    first.prepared.result.contextId,
    '下一次初始提交会替换legacy Main global中的旧confirmation'
  );

  const release = (event, replacementTokenId = null) => (
    createStatementBalanceSeedOverwriteReleaseCharacterization({
      event,
      currentTokenId: 'overwrite-token-1',
      replacementTokenId
    })
  );
  assert.deepEqual(
    ['confirm', 'cancel', 'stale'].map((event) => release(event)),
    [
      { event: 'confirm', nextTokenId: null, releaseReason: 'consumed', releasedTokenId: 'overwrite-token-1' },
      { event: 'cancel', nextTokenId: null, releaseReason: 'cancelled', releasedTokenId: 'overwrite-token-1' },
      { event: 'stale', nextTokenId: null, releaseReason: 'stale', releasedTokenId: 'overwrite-token-1' }
    ]
  );
  assert.deepEqual(release('replacement', 'overwrite-token-2'), {
    event: 'replacement',
    nextTokenId: 'overwrite-token-2',
    releaseReason: 'replaced',
    releasedTokenId: 'overwrite-token-1'
  });
});

test('footprint exact projection不受TMPDIR绝对路径长度影响', () => {
  const normal = runProbe();
  const shortTmp = runProbe({ ...process.env, TMPDIR: '/tmp' });
  assert.deepEqual(
    deterministicProbeProjection(shortTmp),
    deterministicProbeProjection(normal)
  );
});
