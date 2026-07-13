'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const {
  createPreFundReconciliationRunStore
} = require('../../../src/backend/pre-fund-reconciliation-run-store');
const runDataStore = require('../../../src/backend/run-data-store');

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
      location: { sourceFileName: 'mpt.gz', sourceRowNumber: 2 },
      rawJson: '{"raw":"kept"}'
    };

    const mismatched = {
      ...candidate,
      sourceOrder: -1,
      fingerprint: '["2026-07-01","11"]',
      fields: { ...candidate.fields, amount: '11' }
    };
    assert.equal(store.insertGatewayCandidate(db, runId, mismatched), true);
    assert.equal(store.insertGatewayCandidate(db, runId, candidate), true);
    assert.equal(store.insertGatewayCandidate(db, runId, {
      ...candidate,
      sourceOrder: 1,
      location: { sourceFileName: 'mpt-duplicate.gz', sourceRowNumber: 9 },
      rawJson: '{"raw":"folded"}'
    }, {
      resolveKeptRawJson: () => '{"raw":"kept"}'
    }), false);
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
    assert.deepEqual(store.duplicateStats(db, runId), {
      snapshotCount: 1,
      duplicateGroupCount: 1,
      foldedRowCount: 1,
      keptRawBytes: Buffer.byteLength('{"raw":"kept"}'),
      foldedRawBytes: Buffer.byteLength('{"raw":"folded"}')
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
    assert.equal(exports[0].hasDuplicateRecords, true);
    const duplicateRecords = [...exports[0].duplicateRecords];
    assert.deepEqual(duplicateRecords.map((record) => record.objectType), [
      '保留记录',
      '被折叠记录'
    ]);
    assert.equal(duplicateRecords[0].foldRecordId, duplicateRecords[1].foldRecordId);
    assert.equal(duplicateRecords[0].candidate.rawJson, '{"raw":"kept"}');
    assert.equal(duplicateRecords[1].candidate.rawJson, '{"raw":"folded"}');

    assert.deepEqual(store.clearAllRunData(), { deletedFiles: 1, deletedRuns: 1 });
    assert.equal(store.getRun('2026-07', runId), null);
  });

  test('fails visibly instead of exporting a blank row when result JSON is corrupted', () => {
    const store = createPreFundReconciliationRunStore(userDataDir);
    const db = store.open('2026-07');
    const runId = store.createRun(db, {
      scenario: 'missing-gateway',
      snapshot: {},
      bankFiles: ['bank.xlsx']
    });
    db.prepare(`
      INSERT INTO pre_fund_reconciliation_balanced_rows
        (run_id, channel, bank_ordinal, output_json)
      VALUES (?, 'CIT', 0, '{broken')
    `).run(runId);
    store.finishRun(db, runId, {});
    db.close();

    const channelExport = [...store.iterateChannelExports('2026-07', runId)][0];
    assert.throws(
      () => [...channelExport.balancedRows],
      /结果行 JSON 损坏.*pre_fund_reconciliation_balanced_rows/
    );
  });

  test('old five-sheet result DB opens compatibly and lazily gains duplicate audit tables', () => {
    const filePath = runDataStore.sideDbPath(
      userDataDir,
      runDataStore.MODULE_PRE_FUND_RECONCILIATION_RESULTS,
      '2026-06'
    );
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const oldDb = new DatabaseSync(filePath);
    oldDb.exec(`
      CREATE TABLE pre_fund_reconciliation_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        scenario TEXT NOT NULL,
        snapshot_json TEXT NOT NULL,
        bank_files_json TEXT NOT NULL,
        status TEXT NOT NULL,
        summary_json TEXT NOT NULL DEFAULT '{}',
        error_message TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        finished_at TEXT
      );
      INSERT INTO pre_fund_reconciliation_runs
        (scenario, snapshot_json, bank_files_json, status, summary_json)
      VALUES ('missing-gateway', '{}', '[]', 'success', '{}');
    `);
    oldDb.close();

    const store = createPreFundReconciliationRunStore(userDataDir);
    const db = store.open('2026-06');
    try {
      const names = db.prepare(`
        SELECT name FROM sqlite_master
        WHERE type = 'table' AND name LIKE 'pre_fund_reconciliation_%'
      `).all().map((row) => row.name);
      assert.ok(names.includes('pre_fund_reconciliation_duplicate_groups'));
      assert.ok(names.includes('pre_fund_reconciliation_folded_gateway_rows'));
      assert.ok(names.includes('pre_fund_reconciliation_gateway_candidate_snapshots'));
    } finally {
      db.close();
    }
    assert.equal(store.getRun('2026-06', 1).status, 'success');
  });

  test('corrupted duplicate result JSON fails visibly', () => {
    const store = createPreFundReconciliationRunStore(userDataDir);
    const db = store.open('2026-07');
    const runId = store.createRun(db, { scenario: 'missing-gateway', snapshot: {}, bankFiles: [] });
    const candidate = {
      sourcePriority: 0,
      sourceOrder: 0,
      source: '临时网关对账单',
      reconciliationId: 'R-1',
      fingerprint: 'FP',
      fields: { channel: 'CIT', amount: '1', currency: 'USD' },
      location: { sourceFileName: 'a.gz', sourceRowNumber: 2 },
      rawJson: '{"a":1}'
    };
    store.insertGatewayCandidate(db, runId, candidate);
    store.insertGatewayCandidate(
      db,
      runId,
      { ...candidate, sourceOrder: 1, rawJson: '{"a":2}' },
      { resolveKeptRawJson: () => '{"a":1}' }
    );
    db.prepare(`
      UPDATE pre_fund_reconciliation_folded_gateway_rows SET fields_json = '{broken'
    `).run();
    db.close();

    assert.throws(
      () => [...store.iterateDuplicateRecords('2026-07', runId, 'CIT')],
      /重复审计 JSON 损坏.*fields_json/
    );
  });

  test('missing kept raw snapshot fails visibly', () => {
    const store = createPreFundReconciliationRunStore(userDataDir);
    const db = store.open('2026-07');
    const runId = store.createRun(db, { scenario: 'missing-gateway', snapshot: {}, bankFiles: [] });
    const candidate = {
      sourcePriority: 1,
      sourceOrder: 0,
      source: '网关对账单',
      reconciliationId: 'R-1',
      fingerprint: 'FP',
      fields: { channel: 'CIT', amount: '1', currency: 'USD' },
      location: { sourceRecordId: 7 },
      rawJson: '{"id":7}'
    };
    store.insertGatewayCandidate(db, runId, candidate);
    store.insertGatewayCandidate(
      db,
      runId,
      { ...candidate, sourceOrder: 1, rawJson: '{"id":8}' },
      { resolveKeptRawJson: () => '{"id":7}' }
    );
    db.prepare(`
      DELETE FROM pre_fund_reconciliation_gateway_candidate_snapshots WHERE run_id = ?
    `).run(runId);
    db.close();

    assert.throws(
      () => [...store.iterateDuplicateRecords('2026-07', runId, 'CIT')],
      /重复审计原始JSON缺失/
    );
  });

  test('corrupted kept or folded raw JSON fails visibly before export', () => {
    const store = createPreFundReconciliationRunStore(userDataDir);
    const db = store.open('2026-07');
    const runId = store.createRun(db, { scenario: 'missing-gateway', snapshot: {}, bankFiles: [] });
    const candidate = {
      sourcePriority: 1,
      sourceOrder: 0,
      source: '网关对账单',
      reconciliationId: 'R-1',
      fingerprint: 'FP',
      fields: { channel: 'CIT', amount: '1', currency: 'USD' },
      location: { sourceRecordId: 1 },
      rawJson: '{"id":1}'
    };
    store.insertGatewayCandidate(db, runId, candidate);
    store.insertGatewayCandidate(
      db,
      runId,
      { ...candidate, sourceOrder: 1, location: { sourceRecordId: 2 }, rawJson: '{"id":2}' },
      { resolveKeptRawJson: () => '{"id":1}' }
    );
    db.prepare('UPDATE pre_fund_reconciliation_gateway_candidate_snapshots SET raw_json = ?').run('{broken');
    assert.throws(
      () => [...store.iterateDuplicateRecords('2026-07', runId, 'CIT')],
      /重复审计原始JSON损坏/
    );

    db.prepare('UPDATE pre_fund_reconciliation_gateway_candidate_snapshots SET raw_json = ?').run('{"id":1}');
    db.prepare('UPDATE pre_fund_reconciliation_folded_gateway_rows SET raw_json = ?').run('[]');
    db.close();
    assert.throws(
      () => [...store.iterateDuplicateRecords('2026-07', runId, 'CIT')],
      /重复审计原始JSON结构无效/
    );
  });

  test('rejects a kept raw resolver result that does not match the staged candidate hash', () => {
    const store = createPreFundReconciliationRunStore(userDataDir);
    const db = store.open('2026-07');
    const runId = store.createRun(db, { scenario: 'missing-gateway', snapshot: {}, bankFiles: [] });
    const candidate = {
      sourcePriority: 1,
      sourceOrder: 0,
      source: '网关对账单',
      reconciliationId: 'R-1',
      fingerprint: 'FP',
      fields: { channel: 'CIT', amount: '1', currency: 'USD' },
      location: { sourceRecordId: 1 },
      rawJson: '{"id":1}'
    };
    store.insertGatewayCandidate(db, runId, candidate);

    assert.throws(
      () => store.insertGatewayCandidate(
        db,
        runId,
        { ...candidate, sourceOrder: 1, location: { sourceRecordId: 2 }, rawJson: '{"id":2}' },
        { resolveKeptRawJson: () => '{"id":999}' }
      ),
      /保留候选原始JSON身份校验失败/
    );
    assert.equal(store.duplicateStats(db, runId).duplicateGroupCount, 0);
    db.close();
  });

  test('large unique candidate pool never persists raw snapshots; first duplicate resolves kept raw once', () => {
    const store = createPreFundReconciliationRunStore(userDataDir);
    const db = store.open('2026-07');
    const runId = store.createRun(db, { scenario: 'missing-gateway', snapshot: {}, bankFiles: [] });
    let resolverCalls = 0;
    const insert = store.createGatewayCandidateInserter(db, runId, {
      resolveKeptRawJson() {
        resolverCalls += 1;
        return JSON.stringify({ id: 0, payload: 'x'.repeat(4096) });
      }
    });
    const uniqueCount = 10000;
    const rawBytes = uniqueCount * 4096;
    db.exec('BEGIN IMMEDIATE');
    for (let index = 0; index < uniqueCount; index += 1) {
      insert({
        sourcePriority: 1,
        sourceOrder: index,
        source: '网关对账单',
        reconciliationId: `R-${index}`,
        fingerprint: `FP-${index}`,
        fields: { channel: 'CIT', amount: '1', currency: 'USD' },
        location: { sourceRowNumber: index + 1 },
        rawJson: JSON.stringify({ id: index, payload: 'x'.repeat(4096) })
      });
    }
    db.exec('COMMIT');
    assert.deepEqual(store.duplicateStats(db, runId), {
      snapshotCount: 0,
      duplicateGroupCount: 0,
      foldedRowCount: 0,
      keptRawBytes: 0,
      foldedRawBytes: 0
    });
    assert.equal(resolverCalls, 0);
    db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
    const pageSize = Number(db.prepare('PRAGMA page_size').get().page_size);
    const uniquePoolBytes = pageSize * Number(db.prepare('PRAGMA page_count').get().page_count);
    assert.ok(uniquePoolBytes < rawBytes / 4, `${uniquePoolBytes} !< ${rawBytes}/4`);

    db.exec('BEGIN IMMEDIATE');
    insert({
      sourcePriority: 1,
      sourceOrder: uniqueCount,
      source: '网关对账单',
      reconciliationId: 'R-0',
      fingerprint: 'FP-0',
      fields: { channel: 'CIT', amount: '1', currency: 'USD' },
      location: { sourceRecordId: uniqueCount + 1, sourceRowNumber: uniqueCount + 1 },
      rawJson: JSON.stringify({ id: 'duplicate', payload: 'y'.repeat(4096) })
    });
    db.exec('COMMIT');
    const finalized = store.duplicateStats(db, runId);
    db.close();

    assert.equal(finalized.snapshotCount, 1);
    assert.equal(finalized.foldedRowCount, 1);
    assert.equal(resolverCalls, 1);
  });
});
