'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { DatabaseSync } = require('node:sqlite');

const runDataStore = require('../../../src/backend/run-data-store');
const {
  assertDuplicateResultConservation,
  computeDuplicateResultPostImage
} = require('../../../src/backend/duplicate-inbound-match-result-digest');

function insertResultRows(db, runId, variant = {}) {
  const sentinel = 'SENSITIVE-CARD-6222000000000000';
  db.prepare(`
    INSERT INTO duplicate_inbound_match_mail_rows (run_id, source_ordinal, output_json)
    VALUES (?, 7, ?)
  `).run(runId, JSON.stringify(variant.mail || {
    Currency: 'USD',
    'Debit Amount': '88.00',
    MerchantId: sentinel
  }));
  const insertManual = db.prepare(`
    INSERT INTO duplicate_inbound_match_manual_rows (
      run_id, group_order, row_order, reason, raw_json
    ) VALUES (?, 1, ?, ?, ?)
  `);
  for (const row of (variant.manual || [
    { rowOrder: 9, reason: 'reason-B', raw: { BizId: 'B', CardNo: sentinel } },
    { rowOrder: 3, reason: 'reason-A', raw: { BizId: 'A', Amount: '10.00' } }
  ])) {
    insertManual.run(runId, row.rowOrder, row.reason, JSON.stringify(row.raw));
  }
  const insertAudit = db.prepare(`
    INSERT INTO duplicate_inbound_match_group_audits (
      run_id, group_order, disposition, reason_codes_json,
      bank_lineage_json, mpt_lineage_json, document_lineage_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  for (const row of (variant.audits || [
    {
      groupOrder: 4, disposition: 'manual', reasonCodes: ['manual'],
      bankLineage: [{ bizId: 'B' }], mptLineage: [], documentLineage: []
    },
    {
      groupOrder: 2, disposition: 'success', reasonCodes: [],
      bankLineage: [{ bizId: 'A' }], mptLineage: [{ candidateId: 'MPT-1' }],
      documentLineage: [{ businessOrderKey: 'DOC-1' }]
    }
  ])) {
    insertAudit.run(
      runId,
      row.groupOrder,
      row.disposition,
      JSON.stringify(row.reasonCodes),
      JSON.stringify(row.bankLineage),
      JSON.stringify(row.mptLineage),
      JSON.stringify(row.documentLineage)
    );
  }
  return sentinel;
}

function assertDigestMutation(db, runId, expectedDigest, mutate, label) {
  db.exec('SAVEPOINT duplicate_result_digest_mutation');
  try {
    mutate();
    assert.notEqual(computeDuplicateResultPostImage(db, runId).digest, expectedDigest, label);
  } finally {
    db.exec(`
      ROLLBACK TO duplicate_result_digest_mutation;
      RELEASE duplicate_result_digest_mutation;
    `);
  }
}

test('Duplicate result digest覆盖完整结果血缘且按业务顺序稳定、不泄漏敏感行', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(runDataStore.SIDE_DB_DDL_DUPLICATE_INBOUND_MATCH);
    const importId = Number(db.prepare(`
      INSERT INTO duplicate_inbound_match_imports (
        bank_file_name, bank_content_hash, bank_row_count,
        document_file_name, document_content_hash, document_row_count,
        document_matchable_row_count, document_empty_order_count
      ) VALUES ('bank.xlsx', 'bank-hash', 0, 'document.xlsx', 'document-hash', 0, 0, 0)
    `).run().lastInsertRowid);
    const summary = {
      mailRowCount: 1,
      manualRowCount: 2,
      auditGroupCount: 2,
      finalSuccessGroupCount: 1,
      manualGroupCount: 1
    };
    const runId = Number(db.prepare(`
      INSERT INTO duplicate_inbound_match_runs (
        import_id, snapshot_json, snapshot_hash, status, summary_json
      ) VALUES (?, ?, 'snapshot-hash', 'success', ?)
    `).run(
      importId,
      JSON.stringify({ batches: [{ contentHash: 'snapshot-content' }] }),
      JSON.stringify(summary)
    ).lastInsertRowid);
    const sentinel = insertResultRows(db, runId);
    const baseline = computeDuplicateResultPostImage(db, runId);
    assertDuplicateResultConservation(baseline);
    assert.match(baseline.digest, /^[a-f0-9]{64}$/);
    assert.deepEqual(baseline.counts, {
      mailRowCount: 1,
      manualRowCount: 2,
      auditGroupCount: 2,
      successAuditCount: 1,
      manualAuditCount: 1
    });
    assert.equal(JSON.stringify(baseline).includes(sentinel), false);

    // 物理删除/逆序重插不影响由 source/group/row order 定义的稳定 post-image。
    db.exec(`
      DELETE FROM duplicate_inbound_match_mail_rows;
      DELETE FROM duplicate_inbound_match_manual_rows;
      DELETE FROM duplicate_inbound_match_group_audits;
    `);
    insertResultRows(db, runId, {
      manual: [
        { rowOrder: 3, reason: 'reason-A', raw: { Amount: '10.00', BizId: 'A' } },
        { rowOrder: 9, reason: 'reason-B', raw: { CardNo: sentinel, BizId: 'B' } }
      ],
      audits: [
        {
          groupOrder: 2, disposition: 'success', reasonCodes: [],
          bankLineage: [{ bizId: 'A' }], mptLineage: [{ candidateId: 'MPT-1' }],
          documentLineage: [{ businessOrderKey: 'DOC-1' }]
        },
        {
          groupOrder: 4, disposition: 'manual', reasonCodes: ['manual'],
          bankLineage: [{ bizId: 'B' }], mptLineage: [], documentLineage: []
        }
      ],
      mail: { MerchantId: sentinel, 'Debit Amount': '88.00', Currency: 'USD' }
    });
    assert.equal(computeDuplicateResultPostImage(db, runId).digest, baseline.digest);

    const mailOutput = (changes) => JSON.stringify({
      MerchantId: sentinel,
      'Debit Amount': '88.00',
      Currency: 'USD',
      ...changes
    });
    const mutations = [
      ['mail amount', () => db.prepare(`
        UPDATE duplicate_inbound_match_mail_rows SET output_json = ? WHERE run_id = ?
      `).run(mailOutput({ 'Debit Amount': '99.00' }), runId)],
      ['mail currency', () => db.prepare(`
        UPDATE duplicate_inbound_match_mail_rows SET output_json = ? WHERE run_id = ?
      `).run(mailOutput({ Currency: 'EUR' }), runId)],
      ['mail output field', () => db.prepare(`
        UPDATE duplicate_inbound_match_mail_rows SET output_json = ? WHERE run_id = ?
      `).run(mailOutput({ MerchantId: 'MERCHANT-CHANGED' }), runId)],
      ['manual raw', () => db.prepare(`
        UPDATE duplicate_inbound_match_manual_rows SET raw_json = ?
        WHERE run_id = ? AND row_order = 3
      `).run(JSON.stringify({ BizId: 'A', Amount: '11.00' }), runId)],
      ['manual reason', () => db.prepare(`
        UPDATE duplicate_inbound_match_manual_rows SET reason = 'changed-reason'
        WHERE run_id = ? AND row_order = 3
      `).run(runId)],
      ['manual group order', () => db.prepare(`
        UPDATE duplicate_inbound_match_manual_rows SET group_order = 5
        WHERE run_id = ? AND row_order = 3
      `).run(runId)],
      ['manual row order', () => db.prepare(`
        UPDATE duplicate_inbound_match_manual_rows SET row_order = 4
        WHERE run_id = ? AND row_order = 3
      `).run(runId)],
      ['audit disposition', () => db.prepare(`
        UPDATE duplicate_inbound_match_group_audits SET disposition = 'manual'
        WHERE run_id = ? AND group_order = 2
      `).run(runId)],
      ['audit reason', () => db.prepare(`
        UPDATE duplicate_inbound_match_group_audits SET reason_codes_json = ?
        WHERE run_id = ? AND group_order = 2
      `).run(JSON.stringify(['audit-reason-changed']), runId)],
      ['audit bank lineage', () => db.prepare(`
        UPDATE duplicate_inbound_match_group_audits SET bank_lineage_json = ?
        WHERE run_id = ? AND group_order = 2
      `).run(JSON.stringify([{ bizId: 'BANK-CHANGED' }]), runId)],
      ['audit MPT lineage', () => db.prepare(`
        UPDATE duplicate_inbound_match_group_audits SET mpt_lineage_json = ?
        WHERE run_id = ? AND group_order = 2
      `).run(JSON.stringify([{ candidateId: 'MPT-CHANGED' }]), runId)],
      ['audit document lineage', () => db.prepare(`
        UPDATE duplicate_inbound_match_group_audits SET document_lineage_json = ?
        WHERE run_id = ? AND group_order = 2
      `).run(JSON.stringify([{ businessOrderKey: 'DOC-CHANGED' }]), runId)],
      ['snapshot JSON', () => db.prepare(`
        UPDATE duplicate_inbound_match_runs SET snapshot_json = ? WHERE id = ?
      `).run(JSON.stringify({ batches: [{ contentHash: 'snapshot-changed' }] }), runId)]
    ];
    for (const [label, mutate] of mutations) {
      assertDigestMutation(db, runId, baseline.digest, mutate, label);
    }
    db.prepare(`
      UPDATE duplicate_inbound_match_group_audits
      SET disposition = 'manual' WHERE run_id = ? AND group_order = 2
    `).run(runId);
    const invalidDisposition = computeDuplicateResultPostImage(db, runId);
    assert.equal(invalidDisposition.conservation.isBalanced, false);
    assert.throws(
      () => assertDuplicateResultConservation(invalidDisposition),
      (error) => error.code === 'duplicate-inbound-side-result-count-mismatch'
    );
  } finally {
    db.close();
  }
});
