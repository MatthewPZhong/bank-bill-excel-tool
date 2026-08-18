'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { DatabaseSync } = require('node:sqlite');

const { ensureBizOpReconTablesSupport } = require('../../../../src/backend/biz-op-recon-db/migrations');
const datasetHeads = require('../../../../src/backend/biz-op-recon-db/dataset-head-repository');

function openDb() {
  const db = new DatabaseSync(':memory:');
  ensureBizOpReconTablesSupport(db);
  return db;
}

test('Biz OP additive schema 建 heads、run receipt 索引与 rollback trigger', () => {
  const db = openDb();
  try {
    const runColumns = db.prepare('PRAGMA table_info(biz_op_recon_runs)').all()
      .map((column) => column.name);
    assert.ok(runColumns.includes('archive_contract_version'));
    assert.ok(runColumns.includes('archive_task_run_id'));
    assert.ok(runColumns.includes('archive_terminal_ack_at'));
    const indexes = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all()
      .map((row) => row.name));
    assert.ok(indexes.has('idx_biz_op_runs_archive_task'));
    const triggers = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='trigger'").all()
      .map((row) => row.name));
    assert.ok(triggers.has('invalidate_biz_op_head_on_insert'));
    assert.ok(triggers.has('invalidate_biz_flow_head_on_insert'));
    assert.ok(triggers.has('protect_biz_op_unacked_archive_run'));
  } finally {
    db.close();
  }
});

test('历史 OP/Flow rows 前滚只建 v0 head，不伪造 producer', () => {
  const db = openDb();
  try {
    db.prepare(`
      INSERT INTO biz_op_recon_imports (data_date, bu_name, row_index, account_no)
      VALUES ('2026-01-31', ' BU-A ', 1, 'A-1')
    `).run();
    db.prepare(`
      INSERT INTO biz_op_recon_flow_imports (
        data_date, row_index, direction, account_no, recon_amount
      ) VALUES ('2026-02-01', 1, '入', 'A-1', '1')
    `).run();
    ensureBizOpReconTablesSupport(db);
    const op = datasetHeads.getHead(db, 'op', '2026-01-31', 'bu-a');
    const flow = datasetHeads.getHead(db, 'flow', '2026-02-01');
    assert.equal(op.archiveContractVersion, 0);
    assert.equal(op.producerTaskRunId, null);
    assert.equal(flow.archiveContractVersion, 0);
    assert.equal(flow.producerTaskRunId, null);
  } finally {
    db.close();
  }
});

test('旧 binary 改 rows 会精确删除 v1 head，前滚恢复为 v0/null producer', () => {
  const db = openDb();
  try {
    const opIdentity = datasetHeads.nextDatasetIdentity(null, 'op-task', () => 'op-v1');
    db.prepare(`
      INSERT INTO biz_op_recon_imports (data_date, bu_name, row_index, account_no)
      VALUES ('2026-02-28', 'BU-A', 1, 'A-1')
    `).run();
    datasetHeads.writeHead(db, {
      kind: 'op', dataDate: '2026-02-28', buName: 'BU-A', identity: opIdentity
    });
    db.prepare(`
      INSERT INTO biz_op_recon_imports (data_date, bu_name, row_index, account_no)
      VALUES ('2026-02-28', 'BU-A', 2, 'A-2')
    `).run();
    assert.equal(datasetHeads.getHead(db, 'op', '2026-02-28', 'BU-A'), null);
    ensureBizOpReconTablesSupport(db);
    const recovered = datasetHeads.getHead(db, 'op', '2026-02-28', 'BU-A');
    assert.equal(recovered.archiveContractVersion, 0);
    assert.equal(recovered.producerTaskRunId, null);
    assert.notEqual(recovered.datasetId, 'op-v1');
  } finally {
    db.close();
  }
});
