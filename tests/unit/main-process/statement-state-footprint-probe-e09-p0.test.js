'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const test = require('node:test');

const {
  STATEMENT_RESOURCE_CONTRACT
} = require('../../../src/main-process/statement-worker/contracts');

const ROOT = path.join(__dirname, '..', '..', '..');
const PROBE_PATH = path.join(ROOT, 'scripts', 'statement-state-footprint-probe.js');
const GOLDEN = require('../../fixtures/statement/e09-p0-legacy-golden.json');

test('25k行/4批次/1重token基线规模probe执行真实映射/session并在canonical预算内', () => {
  const raw = execFileSync(process.execPath, [
    '--expose-gc',
    PROBE_PATH,
    '--rows', '25000',
    '--batches', '4',
    '--tokens', '1'
  ], {
    cwd: ROOT,
    encoding: 'utf8',
    env: process.env,
    maxBuffer: 1024 * 1024
  });
  const result = JSON.parse(raw);
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
  assert.equal(result.publicDtoBytes, GOLDEN.footprintBaseline.publicDtoBytes);
  assert.ok(result.publicDtoBytes < STATEMENT_RESOURCE_CONTRACT.publicInteractionMaxBytes);
  assert.match(result.caveat, /not a parser peak/);
});
