'use strict';

const runDataStore = require('./run-data-store');

const MODULE = runDataStore.MODULE_PRE_FUND_RECONCILIATION_RESULTS;

const PRE_FUND_RUN_DDL = runDataStore.SIDE_DB_DDL_PRE_FUND_RUNS;

function assertRunIdentity(monthKey, runId) {
  if (typeof monthKey !== 'string' || !/^\d{4}-\d{2}$/.test(monthKey)) {
    throw new TypeError('前置资金对账 monthKey 必须为 YYYY-MM');
  }
  if (!Number.isSafeInteger(Number(runId)) || Number(runId) <= 0) {
    throw new TypeError('前置资金对账 runId 必须为正整数');
  }
}

function parseJson(value, fallback) {
  try {
    return JSON.parse(value);
  } catch (_error) {
    return fallback;
  }
}

function parseOutputJson(value, context = {}) {
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error(
      `前置资金对账结果行 JSON 损坏：runId=${context.runId}，${context.table}#${context.rowId}`,
      { cause: error }
    );
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(
      `前置资金对账结果行结构无效：runId=${context.runId}，${context.table}#${context.rowId}`
    );
  }
  return parsed;
}

function mapRun(row, monthKey) {
  if (!row) return null;
  return {
    id: row.id,
    monthKey,
    scenario: row.scenario,
    snapshot: parseJson(row.snapshot_json, {}),
    bankFiles: parseJson(row.bank_files_json, []),
    status: row.status,
    summary: parseJson(row.summary_json, {}),
    errorMessage: row.error_message || '',
    createdAt: row.created_at,
    finishedAt: row.finished_at
  };
}

function mapGatewayPoolRow(row) {
  if (!row) return null;
  return {
    source: row.source_label,
    reconciliationId: row.reconciliation_id,
    fingerprint: row.fingerprint,
    fields: parseJson(row.fields_json, {}),
    name: row.name || '',
    cardNo: row.card_no || '',
    location: parseJson(row.source_location_json, {})
  };
}

function gatewayMatchValues(criteria) {
  if (!criteria || typeof criteria !== 'object' || Array.isArray(criteria)) {
    throw new TypeError('网关候选消费必须提供四字段匹配条件');
  }
  const fields = ['reconciliationId', 'channel', 'amount', 'currency'];
  for (const field of fields) {
    if (typeof criteria[field] !== 'string') {
      throw new TypeError(`网关候选匹配条件 ${field} 必须为字符串`);
    }
  }
  return fields.map((field) => criteria[field]);
}

class PreFundReconciliationRunStore {
  constructor(userDataDir) {
    this.userDataDir = userDataDir;
    runDataStore.moduleDir(userDataDir, MODULE);
  }

  open(monthKey) {
    const db = runDataStore.openSideDb(this.userDataDir, MODULE, monthKey);
    db.exec(PRE_FUND_RUN_DDL);
    return db;
  }

  createRun(db, { scenario, snapshot, bankFiles }) {
    const result = db.prepare(`
      INSERT INTO pre_fund_reconciliation_runs
        (scenario, snapshot_json, bank_files_json, status, summary_json)
      VALUES (?, ?, ?, 'running', '{}')
    `).run(
      String(scenario || ''),
      JSON.stringify(snapshot || {}),
      JSON.stringify(Array.isArray(bankFiles) ? bankFiles : [])
    );
    return Number(result.lastInsertRowid);
  }

  insertGatewayCandidate(db, runId, candidate) {
    const result = db.prepare(`
      INSERT OR IGNORE INTO pre_fund_reconciliation_gateway_pool (
        run_id, source_priority, source_order, source_label, reconciliation_id,
        fingerprint, fields_json, name, card_no, source_location_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      runId,
      candidate.sourcePriority,
      candidate.sourceOrder,
      candidate.source,
      candidate.reconciliationId,
      candidate.fingerprint,
      JSON.stringify(candidate.fields || {}),
      candidate.name || '',
      candidate.cardNo || '',
      JSON.stringify(candidate.location || {})
    );
    return result.changes === 1;
  }

  createGatewayCandidateInserter(db, runId) {
    const statement = db.prepare(`
      INSERT OR IGNORE INTO pre_fund_reconciliation_gateway_pool (
        run_id, source_priority, source_order, source_label, reconciliation_id,
        fingerprint, fields_json, name, card_no, source_location_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    return (candidate) => statement.run(
      runId,
      candidate.sourcePriority,
      candidate.sourceOrder,
      candidate.source,
      candidate.reconciliationId,
      candidate.fingerprint,
      JSON.stringify(candidate.fields || {}),
      candidate.name || '',
      candidate.cardNo || '',
      JSON.stringify(candidate.location || {})
    ).changes === 1;
  }

  consumeGatewayCandidate(db, runId, criteria, bankOrdinal) {
    const [reconciliationId, channel, amount, currency] = gatewayMatchValues(criteria);
    const row = db.prepare(`
      SELECT id, source_label, reconciliation_id, fingerprint, fields_json,
             name, card_no, source_location_json
      FROM pre_fund_reconciliation_gateway_pool
      WHERE run_id = ? AND reconciliation_id = ? AND consumed_bank_ordinal IS NULL
        AND json_extract(fields_json, '$.channel') = ?
        AND json_extract(fields_json, '$.amount') = ?
        AND json_extract(fields_json, '$.currency') = ?
      ORDER BY source_priority ASC, source_order ASC, id ASC
      LIMIT 1
    `).get(runId, reconciliationId, channel, amount, currency);
    if (!row) return null;
    const update = db.prepare(`
      UPDATE pre_fund_reconciliation_gateway_pool
      SET consumed_bank_ordinal = ?
      WHERE id = ? AND consumed_bank_ordinal IS NULL
    `).run(bankOrdinal, row.id);
    if (update.changes !== 1) {
      throw new Error(`前置资金对账网关候选消费冲突：poolId=${row.id}`);
    }
    return mapGatewayPoolRow(row);
  }

  createGatewayConsumer(db, runId) {
    const select = db.prepare(`
      SELECT id, source_label, reconciliation_id, fingerprint, fields_json,
             name, card_no, source_location_json
      FROM pre_fund_reconciliation_gateway_pool
      WHERE run_id = ? AND reconciliation_id = ? AND consumed_bank_ordinal IS NULL
        AND json_extract(fields_json, '$.channel') = ?
        AND json_extract(fields_json, '$.amount') = ?
        AND json_extract(fields_json, '$.currency') = ?
      ORDER BY source_priority ASC, source_order ASC, id ASC
      LIMIT 1
    `);
    const update = db.prepare(`
      UPDATE pre_fund_reconciliation_gateway_pool
      SET consumed_bank_ordinal = ?
      WHERE id = ? AND consumed_bank_ordinal IS NULL
    `);
    return (criteria, bankOrdinal) => {
      const [reconciliationId, channel, amount, currency] = gatewayMatchValues(criteria);
      const row = select.get(runId, reconciliationId, channel, amount, currency);
      if (!row) return null;
      if (update.run(bankOrdinal, row.id).changes !== 1) {
        throw new Error(`前置资金对账网关候选消费冲突：poolId=${row.id}`);
      }
      return mapGatewayPoolRow(row);
    };
  }

  insertBalancedRow(db, { runId, channel, bankOrdinal, outputRow }) {
    db.prepare(`
      INSERT INTO pre_fund_reconciliation_balanced_rows
        (run_id, channel, bank_ordinal, output_json)
      VALUES (?, ?, ?, ?)
    `).run(runId, channel, bankOrdinal, JSON.stringify(outputRow));
  }

  createBalancedRowInserter(db, runId) {
    const statement = db.prepare(`
      INSERT INTO pre_fund_reconciliation_balanced_rows
        (run_id, channel, bank_ordinal, output_json)
      VALUES (?, ?, ?, ?)
    `);
    return ({ channel, bankOrdinal, outputRow }) => {
      statement.run(runId, channel, bankOrdinal, JSON.stringify(outputRow));
    };
  }

  insertUnbalancedRow(db, { runId, channel, bankOrdinal, outputRow, channelOutputRow }) {
    db.prepare(`
      INSERT INTO pre_fund_reconciliation_unbalanced_rows
        (run_id, channel, bank_ordinal, output_json, channel_output_json)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      runId,
      channel,
      bankOrdinal,
      JSON.stringify(outputRow),
      JSON.stringify(channelOutputRow)
    );
  }

  createUnbalancedRowInserter(db, runId) {
    const statement = db.prepare(`
      INSERT INTO pre_fund_reconciliation_unbalanced_rows
        (run_id, channel, bank_ordinal, output_json, channel_output_json)
      VALUES (?, ?, ?, ?, ?)
    `);
    return ({ channel, bankOrdinal, outputRow, channelOutputRow }) => {
      statement.run(
        runId,
        channel,
        bankOrdinal,
        JSON.stringify(outputRow),
        JSON.stringify(channelOutputRow)
      );
    };
  }

  gatewayStats(db, runId) {
    const totals = db.prepare(`
      SELECT COUNT(*) AS candidate_count,
             SUM(CASE WHEN consumed_bank_ordinal IS NULL THEN 1 ELSE 0 END) AS unused_count
      FROM pre_fund_reconciliation_gateway_pool
      WHERE run_id = ?
    `).get(runId);
    const conflicts = db.prepare(`
      SELECT COUNT(*) AS group_count
      FROM (
        SELECT reconciliation_id
        FROM pre_fund_reconciliation_gateway_pool
        WHERE run_id = ?
        GROUP BY reconciliation_id
        HAVING COUNT(*) > 1
      )
    `).get(runId);
    return {
      candidateCount: Number(totals.candidate_count) || 0,
      unusedCount: Number(totals.unused_count) || 0,
      conflictingIdGroupCount: Number(conflicts.group_count) || 0
    };
  }

  finishRun(db, runId, summary) {
    db.prepare(`
      UPDATE pre_fund_reconciliation_runs
      SET status = 'success', summary_json = ?, error_message = NULL,
          finished_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(JSON.stringify(summary || {}), runId);
  }

  failRun(db, runId, error) {
    db.prepare(`
      UPDATE pre_fund_reconciliation_runs
      SET status = 'failed', error_message = ?, finished_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(error && error.message ? error.message : String(error), runId);
  }

  getRun(monthKey, runId) {
    assertRunIdentity(monthKey, runId);
    const filePath = runDataStore.sideDbPath(this.userDataDir, MODULE, monthKey);
    if (!runDataStore.sideDbExists(this.userDataDir, MODULE, monthKey)) return null;
    const db = runDataStore.openExistingSideDb(filePath);
    try {
      db.exec(PRE_FUND_RUN_DDL);
      return mapRun(
        db.prepare('SELECT * FROM pre_fund_reconciliation_runs WHERE id = ?').get(runId),
        monthKey
      );
    } finally {
      db.close();
    }
  }

  listChannels(monthKey, runId) {
    assertRunIdentity(monthKey, runId);
    const db = this.open(monthKey);
    try {
      return db.prepare(`
        SELECT channel, MIN(bank_ordinal) AS first_ordinal
        FROM (
          SELECT channel, bank_ordinal
          FROM pre_fund_reconciliation_balanced_rows WHERE run_id = ?
          UNION ALL
          SELECT channel, bank_ordinal
          FROM pre_fund_reconciliation_unbalanced_rows WHERE run_id = ?
        )
        GROUP BY channel
        ORDER BY first_ordinal ASC, channel ASC
      `).all(runId, runId).map((row) => row.channel);
    } finally {
      db.close();
    }
  }

  listChannelSummaries(monthKey, runId) {
    assertRunIdentity(monthKey, runId);
    const db = this.open(monthKey);
    try {
      return db.prepare(`
        SELECT channel,
               SUM(balanced_count) AS matched_count,
               SUM(unbalanced_count) AS unmatched_count,
               MIN(first_ordinal) AS first_ordinal
        FROM (
          SELECT channel, COUNT(*) AS balanced_count, 0 AS unbalanced_count,
                 MIN(bank_ordinal) AS first_ordinal
          FROM pre_fund_reconciliation_balanced_rows
          WHERE run_id = ?
          GROUP BY channel
          UNION ALL
          SELECT channel, 0 AS balanced_count, COUNT(*) AS unbalanced_count,
                 MIN(bank_ordinal) AS first_ordinal
          FROM pre_fund_reconciliation_unbalanced_rows
          WHERE run_id = ?
          GROUP BY channel
        )
        GROUP BY channel
        ORDER BY first_ordinal ASC, channel ASC
      `).all(runId, runId).map((row) => ({
        channel: row.channel,
        matchedCount: Number(row.matched_count) || 0,
        unmatchedCount: Number(row.unmatched_count) || 0
      }));
    } finally {
      db.close();
    }
  }

  iterateOutputRows(monthKey, runId, table, channel, jsonColumn) {
    assertRunIdentity(monthKey, runId);
    const allowed = new Set([
      'pre_fund_reconciliation_balanced_rows',
      'pre_fund_reconciliation_unbalanced_rows'
    ]);
    if (!allowed.has(table)) throw new TypeError('前置资金对账输出表非法');
    if (!['output_json', 'channel_output_json'].includes(jsonColumn)) {
      throw new TypeError('前置资金对账输出 JSON 列非法');
    }
    const self = this;
    return (function* iterate() {
      const db = self.open(monthKey);
      try {
        const cursor = db.prepare(`
          SELECT id, ${jsonColumn} AS row_json
          FROM ${table}
          WHERE run_id = ? AND channel = ?
          ORDER BY bank_ordinal ASC, id ASC
        `).iterate(runId, channel);
        for (const row of cursor) {
          yield parseOutputJson(row.row_json, {
            runId,
            table,
            rowId: row.id
          });
        }
      } finally {
        db.close();
      }
    }());
  }

  *iterateChannelExports(monthKey, runId) {
    for (const channel of this.listChannels(monthKey, runId)) {
      yield {
        channel,
        balancedRows: this.iterateOutputRows(
          monthKey,
          runId,
          'pre_fund_reconciliation_balanced_rows',
          channel,
          'output_json'
        ),
        unbalancedRows: this.iterateOutputRows(
          monthKey,
          runId,
          'pre_fund_reconciliation_unbalanced_rows',
          channel,
          'output_json'
        ),
        channelBillRows: this.iterateOutputRows(
          monthKey,
          runId,
          'pre_fund_reconciliation_unbalanced_rows',
          channel,
          'channel_output_json'
        )
      };
    }
  }

  clearAllRunData() {
    let deletedFiles = 0;
    let deletedRuns = 0;
    const files = runDataStore.listSideDbFiles(this.userDataDir, MODULE);
    for (const file of files) {
      const db = runDataStore.openExistingSideDb(file.path);
      try {
        deletedRuns += Number(
          db.prepare('SELECT COUNT(*) AS count FROM pre_fund_reconciliation_runs').get().count
        ) || 0;
      } finally {
        db.close();
      }
      const removal = runDataStore.deleteSideDb(this.userDataDir, MODULE, file.monthKey);
      if (!removal.deleted) throw new Error(`前置资金对账旧结果侧库删除失败：${file.path}`);
      deletedFiles += 1;
    }
    return { deletedFiles, deletedRuns };
  }

}

function createPreFundReconciliationRunStore(userDataDir) {
  return new PreFundReconciliationRunStore(userDataDir);
}

module.exports = {
  PRE_FUND_RUN_DDL,
  PreFundReconciliationRunStore,
  createPreFundReconciliationRunStore
};
