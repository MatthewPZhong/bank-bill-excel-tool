'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');

const {
  ensureDuplicateInboundMatchRunMetadataSupport
} = require('../../../../src/backend/database/migrations');
const repository = require('../../../../src/backend/database/duplicate-inbound-match-run-repository');

test('重复入金 run 镜像从旧表幂等补齐单据文件列', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(`
      CREATE TABLE duplicate_inbound_match_run_mirrors (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        month_key TEXT NOT NULL,
        side_run_id INTEGER NOT NULL,
        status TEXT NOT NULL,
        summary_json TEXT NOT NULL DEFAULT '{}',
        snapshot_hash TEXT NOT NULL,
        bank_file_name TEXT NOT NULL,
        bank_file_hash TEXT NOT NULL,
        side_db_rel_path TEXT NOT NULL,
        error_message TEXT,
        started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        finished_at TEXT
      )
    `);

    ensureDuplicateInboundMatchRunMetadataSupport(db);
    ensureDuplicateInboundMatchRunMetadataSupport(db);
    const columns = new Set(
      db.prepare('PRAGMA table_info(duplicate_inbound_match_run_mirrors)')
        .all()
        .map((column) => column.name)
    );
    assert.ok(columns.has('document_file_name'));
    assert.ok(columns.has('document_file_hash'));
    assert.ok(columns.has('result_digest'));

    const id = repository.createRunMirror(db, {
      monthKey: '2026-07',
      sideRunId: 7,
      snapshotHash: 'snapshot-hash',
      bankFileName: 'bank.xlsx',
      bankFileHash: 'bank-hash',
      documentFileName: 'document.xlsx',
      documentFileHash: 'document-hash',
      sideDbRelPath: 'run-data/duplicate-inbound-match/month-2026-07.sqlite'
    });
    const mirror = repository.getRunMirror(db, id);
    assert.equal(mirror.documentFileName, 'document.xlsx');
    assert.equal(mirror.documentFileHash, 'document-hash');
    assert.equal(repository.markRunMirrorUnavailable(db, id, 'invalid-side-db', '侧库不可读'), true);
    assert.equal(repository.getRunMirror(db, id).status, 'invalid-side-db');
    assert.throws(
      () => repository.markRunMirrorUnavailable(db, id, 'unknown-status', '非法'),
      /失效状态非法/
    );
  } finally {
    db.close();
  }
});

test('managed committed mirror只重放完全相同的operation post-image', () => {
  const db = new DatabaseSync(':memory:');
  try {
    ensureDuplicateInboundMatchRunMetadataSupport(db);
    const payload = {
      monthKey: '2026-08',
      sideRunId: 8,
      snapshotHash: '1'.repeat(64),
      bankFileName: 'bank.xlsx',
      bankFileHash: '2'.repeat(64),
      documentFileName: 'document.xlsx',
      documentFileHash: '3'.repeat(64),
      sideDbRelPath: 'run-data\\duplicate-inbound-match\\month-2026-08.sqlite',
      summary: { mailRowCount: 1, reasonCounts: { matched: 1 } },
      operationKey: 'duplicate/run/exact-post-image',
      producerTaskRunId: 'task-duplicate-run-exact-post-image',
      inputEvidenceHash: '4'.repeat(64),
      resultDigest: '5'.repeat(64)
    };
    const created = repository.createCommittedRunMirror(db, payload);
    assert.equal(created.created, true);
    const replay = repository.createCommittedRunMirror(db, {
      ...payload,
      sideDbRelPath: 'run-data/duplicate-inbound-match/month-2026-08.sqlite',
      summary: { reasonCounts: { matched: 1 }, mailRowCount: 1 }
    });
    assert.equal(replay.created, false);
    assert.equal(replay.mirror.id, created.mirror.id);

    for (const conflict of [
      { bankFileName: 'different-bank.xlsx' },
      { documentFileName: 'different-document.xlsx' },
      { resultDigest: '6'.repeat(64) },
      { sideDbRelPath: 'run-data//duplicate-inbound-match/month-2026-08.sqlite' },
      { sideDbRelPath: 'run-data/duplicate-inbound-match/month-2026-09.sqlite' },
      { summary: { mailRowCount: 2, reasonCounts: { matched: 2 } } }
    ]) {
      assert.throws(
        () => repository.createCommittedRunMirror(db, { ...payload, ...conflict }),
        (error) => error.code === 'DUPLICATE_MIRROR_IDENTITY_CONFLICT'
      );
    }
    assert.equal(repository.listRunMirrors(db).length, 1);
  } finally {
    db.close();
  }
});
