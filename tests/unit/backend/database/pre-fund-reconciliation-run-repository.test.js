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
      'started_at', 'finished_at', 'archive_contract_version', 'archive_task_run_id',
      'archive_terminal_ack_at'
    ]);
    assert.throws(
      () => db.prepare(`
        INSERT INTO pre_fund_reconciliation_run_mirrors (
          month_key, side_run_id, scenario, status, summary_json,
          snapshot_hash, bank_files_json, side_db_rel_path, archive_contract_version
        ) VALUES ('2026-07', 1, 'x', 'running', '{}', 'x', '[]', 'x.sqlite', 2)
      `).run(),
      /CHECK|constraint/i
    );
  });

  test('旧 mirror 表 additive 升级为 v0/null 并先加列再建 TaskRun 索引', () => {
    const legacyDb = new DatabaseSync(':memory:');
    try {
      legacyDb.exec(`
        CREATE TABLE pre_fund_reconciliation_run_mirrors (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          month_key TEXT NOT NULL,
          side_run_id INTEGER NOT NULL,
          scenario TEXT NOT NULL,
          status TEXT NOT NULL,
          summary_json TEXT NOT NULL DEFAULT '{}',
          snapshot_hash TEXT NOT NULL,
          bank_files_json TEXT NOT NULL DEFAULT '[]',
          side_db_rel_path TEXT NOT NULL,
          error_message TEXT,
          started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          finished_at TEXT
        );
        INSERT INTO pre_fund_reconciliation_run_mirrors (
          month_key, side_run_id, scenario, status, snapshot_hash, side_db_rel_path
        ) VALUES ('2026-06', 1, 'missing-gateway', 'success', 'old', 'old.sqlite');
      `);
      assert.doesNotThrow(() => ensurePreFundReconciliationRunMetadataSupport(legacyDb));
      assert.deepEqual(
        {
          ...legacyDb.prepare(`
            SELECT archive_contract_version, archive_task_run_id, archive_terminal_ack_at
            FROM pre_fund_reconciliation_run_mirrors WHERE id = 1
          `).get()
        },
        {
          archive_contract_version: 0,
          archive_task_run_id: null,
          archive_terminal_ack_at: null
        }
      );
      assert.ok(
        legacyDb.prepare("PRAGMA index_list('pre_fund_reconciliation_run_mirrors')")
          .all().some((index) => index.name === 'idx_pre_fund_run_mirrors_archive_task')
      );
    } finally {
      legacyDb.close();
    }
  });

  test('running -> success 保存汇总并保持主/侧 run ID 命名空间', () => {
    const mirrorId = repository.createRunMirror(db, {
      monthKey: '2026-07',
      sideRunId: 7,
      scenario: 'missing-gateway',
      snapshotHash: 'hash-1',
      bankFiles: ['bank.xlsx'],
      sideDbRelPath: 'run-data/pre-fund-reconciliation/month-2026-07.sqlite',
      archiveReceipt: { archiveTaskRunId: 'task-run-7' }
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
      finishedAt: null,
      archiveContractVersion: 1,
      archiveTaskRunId: 'task-run-7',
      archiveTerminalAckAt: null
    });

    const finished = repository.finishRunMirror(db, mirrorId, { matchedPairs: 3 });
    assert.equal(finished.status, 'success');
    assert.deepEqual(finished.summary, { matchedPairs: 3 });
    assert.ok(finished.finishedAt);
  });

  test('失败、进程中断和侧库丢失均可观察', () => {
    const failedId = repository.createLegacyRunMirror(db, {
      monthKey: '2026-07', sideRunId: 1, scenario: 'missing-gateway',
      snapshotHash: 'a', sideDbRelPath: 'a.sqlite'
    });
    assert.equal(repository.failRunMirror(db, failedId, new Error('boom')), true);
    assert.equal(repository.getRunMirror(db, failedId).status, 'failed');
    assert.equal(repository.getRunMirror(db, failedId).errorMessage, 'boom');

    const interruptedId = repository.createLegacyRunMirror(db, {
      monthKey: '2026-07', sideRunId: 2, scenario: 'missing-gateway',
      snapshotHash: 'b', sideDbRelPath: 'b.sqlite'
    });
    repository.markRunMirrorUnavailable(db, interruptedId, 'interrupted', '应用已重启');
    assert.equal(repository.getRunMirror(db, interruptedId).status, 'interrupted');

    const missingId = repository.createLegacyRunMirror(db, {
      monthKey: '2026-07', sideRunId: 3, scenario: 'missing-gateway',
      snapshotHash: 'c', sideDbRelPath: 'c.sqlite'
    });
    repository.markRunMirrorUnavailable(db, missingId, 'missing-side-db', '侧库丢失');
    assert.equal(repository.getRunMirror(db, missingId).status, 'missing-side-db');
    assert.equal(repository.listRunMirrors(db).length, 3);
  });

  test('v1 TaskRun 唯一定位镜像且 main terminal ACK 幂等', () => {
    const mirrorId = repository.createRunMirror(db, {
      monthKey: '2026-07', sideRunId: 1, scenario: 'missing-gateway',
      snapshotHash: 'a', sideDbRelPath: 'result.sqlite',
      archiveReceipt: { archiveTaskRunId: 'task-run-1' }
    });
    repository.finishRunMirror(db, mirrorId, { matchedPairs: 1 });
    assert.equal(repository.getRunMirrorByArchiveTaskRunId(db, 'task-run-1').id, mirrorId);
    const acknowledged = repository.acknowledgeArchiveTerminal(db, mirrorId, 'task-run-1');
    assert.ok(acknowledged.archiveTerminalAckAt);
    assert.equal(
      repository.acknowledgeArchiveTerminal(db, mirrorId, 'task-run-1').archiveTerminalAckAt,
      acknowledged.archiveTerminalAckAt
    );
    assert.throws(() => repository.createRunMirror(db, {
      monthKey: '2026-07', sideRunId: 2, scenario: 'missing-gateway',
      snapshotHash: 'b', sideDbRelPath: 'result.sqlite',
      archiveReceipt: { archiveTaskRunId: 'task-run-1' }
    }), /UNIQUE/);
  });
});
