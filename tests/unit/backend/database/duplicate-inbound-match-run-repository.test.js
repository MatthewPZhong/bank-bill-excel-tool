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
