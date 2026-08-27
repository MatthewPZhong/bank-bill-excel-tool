'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const test = require('node:test');

const {
  STATEMENT_RESOURCE_CONTRACT
} = require('../../../src/main-process/statement-worker/contracts');
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
    legacyInventory: result.legacyInventory,
    ownership: result.ownership,
    mainTokenHandleBytes: result.mainTokenHandleBytes,
    publicDtoBytes: result.publicDtoBytes
  };
}

test('25k行/4批次/1重token基线规模probe覆盖五globals并在canonical预算内', () => {
  const result = runProbe();
  assert.deepEqual(result.inputs, GOLDEN.footprintBaseline.inputs);
  assert.equal(result.probeVersion, 1);
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
  assert.deepEqual(result.legacyInventory, GOLDEN.footprintBaseline.legacyInventory);
  assert.equal(result.mainTokenHandleBytes, GOLDEN.footprintBaseline.mainTokenHandleBytes);
  assert.equal(result.publicDtoBytes, GOLDEN.footprintBaseline.publicDtoBytes);
  assert.match(result.ownership.mainTokenHandle, /tokenId replaces legacy Main contextId/);
  assert.match(result.ownership.legacyCallback, /not projected/);
  assert.ok(result.publicDtoBytes < STATEMENT_RESOURCE_CONTRACT.publicInteractionMaxBytes);
  assert.match(result.caveat, /not a parser peak/);
});

test('五globals projection冻结big/manual/scope所有权且callback与legacy contextId不进入目标graph', () => {
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
    }
  }
});

test('footprint exact projection不受TMPDIR绝对路径长度影响', () => {
  const normal = runProbe();
  const shortTmp = runProbe({ ...process.env, TMPDIR: '/tmp' });
  assert.deepEqual(
    deterministicProbeProjection(shortTmp),
    deterministicProbeProjection(normal)
  );
});
