'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const root = process.env.REVIEW_SOURCE_ROOT || '/private/tmp/renderer-boundaries-r3-qu7nz33r';
const repository = require(path.join(root, 'src/backend/database/template-repository.js'));
const db = new DatabaseSync(':memory:');
try {
  db.exec(`
    CREATE TABLE template_bill_split_amount_rules (
      template_id INTEGER, target_field TEXT, condition_field TEXT, condition_value TEXT,
      mapped_field TEXT, row_index INTEGER, created_at TEXT, updated_at TEXT
    );
    CREATE TABLE template_bill_split_meta (
      template_id INTEGER PRIMARY KEY, signed_amount_source_field TEXT,
      signed_amount_target_seq_nos TEXT, by_field_amount_target_seq_nos TEXT,
      created_at TEXT, updated_at TEXT
    );
  `);
  repository.saveBillSplitAmountRules(db, 7, [{targetField: 'Credit',conditionField:'类型',conditionValue:'入金',mappedField:'发生额'}]);
  repository.saveBillSplitMeta(db, 7, {signedAmountSourceField:'',byFieldAmountTargetSeqNos:[1]});
  const before = repository.getBillSplitAmountRules(db, 7);
  db.exec(`CREATE TRIGGER reject_test_meta BEFORE UPDATE ON template_bill_split_meta BEGIN SELECT RAISE(ABORT, 'injected metadata write failure'); END;`);
  repository.saveBillSplitAmountRules(db, 7, []);
  let failure;
  try { repository.saveBillSplitMeta(db, 7, {signedAmountSourceField:'',byFieldAmountTargetSeqNos:[]}); }
  catch (error) { failure=error.message; }
  const after = repository.getBillSplitAmountRules(db, 7);
  const meta = repository.getBillSplitMeta(db, 7);
  assert.equal(before.length, 1);
  assert.match(failure, /injected metadata write failure/);
  assert.deepEqual(after, []);
  assert.deepEqual(meta.byFieldAmountTargetSeqNos, [1]);
  console.log(JSON.stringify({evidence:'actual repository with in-memory SQLite; injected second-write failure',before,after,meta,failure},null,2));
} finally { db.close(); }
