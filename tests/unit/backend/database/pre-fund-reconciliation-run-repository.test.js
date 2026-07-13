'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');

const {
  ensurePreFundReconciliationRunMetadataSupport
} = require('../../../../src/backend/database/migrations');
const repository = require('../../../../src/backend/database/pre-fund-reconciliation-run-repository');

test.describe('pre-fund-reconciliation 主库 run 镜像', () => {
  let db;

  test.beforeEach(() => {
    db = new DatabaseSync(':memory:');
    ensurePreFundReconciliationRunMetadataSupport(db);
  });

  test.afterEach(() => {
    db.close();
  });

  test('迁移幂等且只保存轻量元数据', () => {
    assert.doesNotThrow(() => ensurePreFundReconciliationRunMetadataSupport(db));
    const columns = db.prepare("PRAGMA table_info('pre_fund_reconciliation_run_mirrors')")
      .all()
      .map((row) => row.name);
    assert.deepEqual(columns, [
      'id', 'month_key', 'side_run_id', 'scenario', 'status', 'summary_json',
      'snapshot_hash', 'bank_files_json', 'side_db_rel_path', 'error_message',
      'started_at', 'finished_at'
    ]);
  });

  test('running -> success 保存汇总并保持主/侧 run ID 命名空间', () => {
    const mirrorId = repository.createRunMirror(db, {
      monthKey: '2026-07',
      sideRunId: 7,
      scenario: 'missing-gateway',
      snapshotHash: 'hash-1',
      bankFiles: ['bank.xlsx'],
      sideDbRelPath: 'run-data/pre-fund-reconciliation/month-2026-07.sqlite'
    });
    assert.equal(mirrorId, 1);
    assert.deepEqual(repository.getRunMirror(db, mirrorId), {
      id: 1,
      monthKey: '2026-07',
      sideRunId: 7,
      scenario: 'missing-gateway',
      status: 'running',
      summary: {},
      snapshotHash: 'hash-1',
      bankFiles: ['bank.xlsx'],
      sideDbRelPath: 'run-data/pre-fund-reconciliation/month-2026-07.sqlite',
      errorMessage: '',
      startedAt: repository.getRunMirror(db, mirrorId).startedAt,
      finishedAt: null
    });

    const finished = repository.finishRunMirror(db, mirrorId, { matchedPairs: 3 });
    assert.equal(finished.status, 'success');
    assert.deepEqual(finished.summary, { matchedPairs: 3 });
    assert.ok(finished.finishedAt);
  });

  test('失败、进程中断和侧库丢失均可观察', () => {
    const failedId = repository.createRunMirror(db, {
      monthKey: '2026-07', sideRunId: 1, scenario: 'missing-gateway',
      snapshotHash: 'a', sideDbRelPath: 'a.sqlite'
    });
    assert.equal(repository.failRunMirror(db, failedId, new Error('boom')), true);
    assert.equal(repository.getRunMirror(db, failedId).status, 'failed');
    assert.equal(repository.getRunMirror(db, failedId).errorMessage, 'boom');

    const interruptedId = repository.createRunMirror(db, {
      monthKey: '2026-07', sideRunId: 2, scenario: 'missing-gateway',
      snapshotHash: 'b', sideDbRelPath: 'b.sqlite'
    });
    repository.markRunMirrorUnavailable(db, interruptedId, 'interrupted', '应用已重启');
    assert.equal(repository.getRunMirror(db, interruptedId).status, 'interrupted');

    const missingId = repository.createRunMirror(db, {
      monthKey: '2026-07', sideRunId: 3, scenario: 'missing-gateway',
      snapshotHash: 'c', sideDbRelPath: 'c.sqlite'
    });
    repository.markRunMirrorUnavailable(db, missingId, 'missing-side-db', '侧库丢失');
    assert.equal(repository.getRunMirror(db, missingId).status, 'missing-side-db');
    assert.equal(repository.listRunMirrors(db).length, 3);
  });
});
