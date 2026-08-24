'use strict';

function ensureCanaryReceiptSchema(db) {
  if (!db || typeof db.exec !== 'function') {
    throw new TypeError('canary schema 需要 private/test DatabaseSync');
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS background_execution_canary_receipts (
      operation_key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      committed_at TEXT NOT NULL
    )
  `);
}

module.exports = { ensureCanaryReceiptSchema };
