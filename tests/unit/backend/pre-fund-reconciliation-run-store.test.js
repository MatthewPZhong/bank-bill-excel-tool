'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  createPreFundReconciliationRunStore
} = require('../../../src/backend/pre-fund-reconciliation-run-store');

test.describe('PreFundReconciliationRunStore', () => {
  let userDataDir;

  test.beforeEach(() => {
    userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pre-fund-run-store-'));
  });

  test.afterEach(() => {
    fs.rmSync(userDataDir, { recursive: true, force: true });
  });

  test('deduplicates gateway fingerprint, consumes once, and streams channel outputs', () => {
    const store = createPreFundReconciliationRunStore(userDataDir);
    const db = store.open('2026-07');
    const runId = store.createRun(db, {
      scenario: 'missing-gateway',
      snapshot: { bankRevision: 1 },
      bankFiles: ['bank.xlsx']
    });
    const candidate = {
      sourcePriority: 0,
      sourceOrder: 0,
      source: '临时网关对账单',
      reconciliationId: 'R-1',
      fingerprint: '["2026-07-01"]',
      fields: { date: '2026-07-01', channel: 'CIT', amount: '10', currency: 'USD' },
      name: 'A',
      cardNo: '1',
      location: { sourceFileName: 'mpt.gz', sourceRowNumber: 2 }
    };

    const mismatched = {
      ...candidate,
      sourceOrder: -1,
      fingerprint: '["2026-07-01","11"]',
      fields: { ...candidate.fields, amount: '11' }
    };
    assert.equal(store.insertGatewayCandidate(db, runId, mismatched), true);
    assert.equal(store.insertGatewayCandidate(db, runId, candidate), true);
    assert.equal(store.insertGatewayCandidate(db, runId, { ...candidate, sourceOrder: 1 }), false);
    const criteria = { reconciliationId: 'R-1', channel: 'CIT', amount: '10', currency: 'USD' };
    const consumed = store.consumeGatewayCandidate(db, runId, criteria, 0);
    assert.equal(consumed.source, '临时网关对账单');
    assert.equal(consumed.fields.amount, '10');
    assert.equal(store.consumeGatewayCandidate(db, runId, criteria, 1), null);

    store.insertBalancedRow(db, {
      runId,
      channel: 'CIT',
      bankOrdinal: 0,
      outputRow: { '对账结果': '平账' }
    });
    store.insertUnbalancedRow(db, {
      runId,
      channel: 'CIT',
      bankOrdinal: 1,
      outputRow: { '对账结果': '不平账' },
      channelOutputRow: { channelName: 'CIT' }
    });
    const gatewayStats = store.gatewayStats(db, runId);
    assert.deepEqual(gatewayStats, {
      candidateCount: 2,
      unusedCount: 1,
      conflictingIdGroupCount: 1
    });
    store.finishRun(db, runId, { matchedPairs: 1, unmatchedBankRows: 1 });
    db.close();

    const run = store.getRun('2026-07', runId);
    assert.equal(run.status, 'success');
    assert.equal(run.summary.matchedPairs, 1);
    assert.deepEqual(store.listChannels('2026-07', runId), ['CIT']);

    const exports = [...store.iterateChannelExports('2026-07', runId)];
    assert.equal(exports.length, 1);
    assert.deepEqual([...exports[0].balancedRows], [{ '对账结果': '平账' }]);
    assert.deepEqual([...exports[0].unbalancedRows], [{ '对账结果': '不平账' }]);
    assert.deepEqual([...exports[0].channelBillRows], [{ channelName: 'CIT' }]);

    assert.deepEqual(store.clearAllRunData(), { deletedFiles: 1, deletedRuns: 1 });
    assert.equal(store.getRun('2026-07', runId), null);
  });
});
