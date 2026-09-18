'use strict';

const crypto = require('node:crypto');

function stableSerialize(value) {
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${stableSerialize(value[key])}`
    )).join(',')}}`;
  }
  return JSON.stringify(value);
}

function ownerKey(owner) {
  if (!owner || owner.version !== 1 || owner.kind !== 'file-batch'
      || !owner.batchContext || !owner.batchContext.taskRunId) {
    throw new TypeError('终态收口凭证需要完整 File Task owner');
  }
  return crypto.createHash('sha256').update(stableSerialize(owner)).digest('hex');
}

function ensureArchiveTerminalCompletionSchema(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS archive_owner_terminal_completions (
    owner_key TEXT PRIMARY KEY,
    archive_instance_id TEXT NOT NULL,
    batch_id INTEGER NOT NULL,
    owner_json TEXT NOT NULL,
    terminal_status TEXT NOT NULL,
    after_terminal_json TEXT NOT NULL,
    completed_at TEXT NOT NULL,
    recovery_kind TEXT NOT NULL DEFAULT ''
  )`);
  if (!db.prepare('PRAGMA table_info(archive_owner_terminal_completions)').all()
    .some((column) => column.name === 'recovery_kind')) {
    db.exec("ALTER TABLE archive_owner_terminal_completions ADD COLUMN recovery_kind TEXT NOT NULL DEFAULT ''");
  }
  db.exec(`CREATE TABLE IF NOT EXISTS archive_file_task_owner_recovery (
    owner_key TEXT PRIMARY KEY,
    archive_instance_id TEXT NOT NULL,
    batch_id INTEGER NOT NULL,
    owner_json TEXT NOT NULL,
    protocol_version INTEGER NOT NULL,
    recovery_kind TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`);
}

function getOwnerTerminalCompletion(db, owner) {
  const row = db.prepare('SELECT * FROM archive_owner_terminal_completions WHERE owner_key = ?')
    .get(ownerKey(owner));
  if (!row) return null;
  return {
    archiveInstanceId: row.archive_instance_id,
    batchId: Number(row.batch_id),
    owner: JSON.parse(row.owner_json),
    terminalStatus: row.terminal_status,
    afterTerminal: JSON.parse(row.after_terminal_json),
    completedAt: row.completed_at,
    recoveryKind: row.recovery_kind
  };
}

function recordOwnerTerminalCompletion(db, payload, options = {}) {
  const { owner, archiveInstanceId, terminalStatus } = payload;
  if (!archiveInstanceId || (!['succeeded', 'failed', 'cancelled'].includes(terminalStatus)
      && !(terminalStatus === 'interrupted' && options.allowInterruptedRecovery === true))) {
    throw new TypeError('终态收口凭证缺少实例或终态');
  }
  const key = ownerKey(owner);
  const ownerJson = stableSerialize(owner);
  const afterTerminalJson = stableSerialize(payload.afterTerminal || null);
  const existing = getOwnerTerminalCompletion(db, owner);
  if (existing) {
    if (existing.archiveInstanceId !== archiveInstanceId
        || existing.terminalStatus !== terminalStatus
        || stableSerialize(existing.afterTerminal) !== afterTerminalJson) {
      const error = new Error('File Task 终态收口凭证发生冲突');
      error.code = 'ARCHIVE_OWNER_COMPLETION_CONFLICT';
      throw error;
    }
    db.prepare('DELETE FROM archive_file_task_owner_recovery WHERE owner_key = ?').run(key);
    return existing;
  }
  db.prepare(`INSERT INTO archive_owner_terminal_completions
    (owner_key, archive_instance_id, batch_id, owner_json, terminal_status,
      after_terminal_json, completed_at, recovery_kind) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(key, archiveInstanceId, owner.batchContext.batchId, ownerJson, terminalStatus,
      afterTerminalJson, payload.completedAt || new Date().toISOString(),
      options.allowInterruptedRecovery === true ? 'no-after-terminal' : '');
  db.prepare('DELETE FROM archive_file_task_owner_recovery WHERE owner_key = ?').run(key);
  return getOwnerTerminalCompletion(db, owner);
}

function recordFileTaskOwnerRecovery(db, { owner, archiveInstanceId, createdAt }) {
  db.prepare(`INSERT INTO archive_file_task_owner_recovery
    (owner_key, archive_instance_id, batch_id, owner_json, protocol_version, recovery_kind, created_at)
    VALUES (?, ?, ?, ?, 1, 'no-after-terminal', ?)`)
    .run(ownerKey(owner), archiveInstanceId, owner.batchContext.batchId, stableSerialize(owner), createdAt);
}

function reopenRecoveredFileTaskOwner(db, { owner, archiveInstanceId, createdAt }) {
  const proof = getOwnerTerminalCompletion(db, owner);
  if (!proof) return false;
  if (proof.archiveInstanceId !== archiveInstanceId || proof.terminalStatus !== 'interrupted'
      || proof.afterTerminal !== null || proof.recoveryKind !== 'no-after-terminal') {
    const error = new Error('File Task 现有收口证明不允许按普通中断责任重新打开');
    error.code = 'ARCHIVE_OWNER_COMPLETION_CONFLICT';
    throw error;
  }
  recordFileTaskOwnerRecovery(db, { owner, archiveInstanceId, createdAt });
  db.prepare('DELETE FROM archive_owner_terminal_completions WHERE owner_key = ?').run(ownerKey(owner));
  return true;
}

function listFileTaskOwnerRecoveries(db) {
  return db.prepare('SELECT * FROM archive_file_task_owner_recovery ORDER BY batch_id').all().map((row) => {
    const owner = JSON.parse(row.owner_json);
    if (row.protocol_version !== 1 || row.recovery_kind !== 'no-after-terminal'
        || ownerKey(owner) !== row.owner_key || owner.batchContext.batchId !== row.batch_id) {
      const error = new Error('File Task 原收口责任记录无效，保留待恢复证据');
      error.code = 'ARCHIVE_OWNER_RECOVERY_INVALID';
      throw error;
    }
    return { owner, archiveInstanceId: row.archive_instance_id };
  });
}

module.exports = {
  ensureArchiveTerminalCompletionSchema,
  getOwnerTerminalCompletion,
  listFileTaskOwnerRecoveries,
  recordFileTaskOwnerRecovery,
  recordOwnerTerminalCompletion,
  reopenRecoveredFileTaskOwner,
  stableSerialize
};
