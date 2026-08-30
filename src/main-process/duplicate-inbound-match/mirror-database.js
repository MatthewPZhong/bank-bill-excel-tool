'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const mirrorRepository = require('../../backend/database/duplicate-inbound-match-run-repository');

function createDuplicateMirrorDatabase(databasePath) {
  if (typeof databasePath !== 'string' || databasePath.trim().length === 0) {
    throw new TypeError('Duplicate Worker需要databasePath');
  }
  const dbPath = path.resolve(databasePath);
  if (!fs.existsSync(dbPath)) {
    const error = new Error(`Duplicate Worker主库不存在：${dbPath}`);
    error.code = 'DUPLICATE_MAIN_DATABASE_MISSING';
    throw error;
  }
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 30000;');
  let closed = false;
  function open() {
    if (closed) throw new Error('Duplicate mirror database已关闭');
    return db;
  }
  return Object.freeze({
    dbPath,
    createDuplicateInboundMatchRunMirror(payload) {
      return mirrorRepository.createRunMirror(open(), payload);
    },
    createCommittedDuplicateInboundMatchRunMirror(payload) {
      return mirrorRepository.createCommittedRunMirror(open(), payload);
    },
    finishDuplicateInboundMatchRunMirror(id, summary) {
      return mirrorRepository.finishRunMirror(open(), id, summary);
    },
    failDuplicateInboundMatchRunMirror(id, error) {
      return mirrorRepository.failRunMirror(open(), id, error);
    },
    markDuplicateInboundMatchRunMirrorUnavailable(id, status, message) {
      return mirrorRepository.markRunMirrorUnavailable(open(), id, status, message);
    },
    listDuplicateInboundMatchRunMirrors() {
      return mirrorRepository.listRunMirrors(open());
    },
    close() {
      if (closed) return;
      closed = true;
      db.close();
    }
  });
}

module.exports = { createDuplicateMirrorDatabase };
