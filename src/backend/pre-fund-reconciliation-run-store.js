'use strict';

const crypto = require('node:crypto');

const runDataStore = require('./run-data-store');

const MODULE = runDataStore.MODULE_PRE_FUND_RECONCILIATION_RESULTS;

const PRE_FUND_RUN_DDL = runDataStore.SIDE_DB_DDL_PRE_FUND_RUNS;
const DUPLICATE_FOLD_REASON = 'reconciliationId+10字段指纹完全重复';

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

function parseResultObjectJson(value, context = {}) {
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error(
      `前置资金对账重复审计 JSON 损坏：runId=${context.runId}，${context.table}#${context.rowId}，列=${context.column}`,
      { cause: error }
    );
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(
      `前置资金对账重复审计 JSON 结构无效：runId=${context.runId}，${context.table}#${context.rowId}，列=${context.column}`
    );
  }
  return parsed;
}

function assertValidRawObjectJson(value, context = {}) {
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error(
      `前置资金对账重复审计原始JSON损坏：runId=${context.runId}，${context.table}#${context.rowId}`,
      { cause: error }
    );
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(
      `前置资金对账重复审计原始JSON结构无效：runId=${context.runId}，${context.table}#${context.rowId}`
    );
  }
}

function rawJsonForCandidate(candidate) {
  if (candidate && typeof candidate.rawJson === 'string') return candidate.rawJson;
  throw new Error('前置资金对账被折叠候选缺少原始业务JSON');
}

function rawJsonHash(rawJson) {
  return crypto.createHash('sha256').update(rawJson, 'utf8').digest();
}

function hashesEqual(left, right) {
  if (!(left instanceof Uint8Array) || !(right instanceof Uint8Array)) return false;
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length
    && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function prepareGatewayCandidateStager(db, runId, options = {}) {
  const resolveKeptRawJson = options.resolveKeptRawJson;
  const insertPool = db.prepare(`
    INSERT OR IGNORE INTO pre_fund_reconciliation_gateway_pool (
      run_id, source_priority, source_order, source_label, reconciliation_id,
      fingerprint, raw_json_hash, fields_json, name, card_no, source_location_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertSnapshot = db.prepare(`
    INSERT OR IGNORE INTO pre_fund_reconciliation_gateway_candidate_snapshots
      (pool_id, run_id, raw_json)
    VALUES (?, ?, ?)
  `);
  const selectKept = db.prepare(`
    SELECT p.id, p.source_priority, p.source_order, p.source_label,
           p.reconciliation_id, p.fingerprint, p.raw_json_hash, p.source_location_json
    FROM pre_fund_reconciliation_gateway_pool p
    WHERE p.run_id = ? AND p.reconciliation_id = ? AND p.fingerprint = ?
    LIMIT 1
  `);
  const selectSnapshot = db.prepare(`
    SELECT raw_json
    FROM pre_fund_reconciliation_gateway_candidate_snapshots
    WHERE pool_id = ? AND run_id = ?
  `);
  const insertGroup = db.prepare(`
    INSERT OR IGNORE INTO pre_fund_reconciliation_duplicate_groups (
      run_id, kept_pool_id, channel, fingerprint, first_event_order, fold_reason
    ) VALUES (?, ?, ?, ?, ?, ?)
  `);
  const selectGroup = db.prepare(`
    SELECT id FROM pre_fund_reconciliation_duplicate_groups
    WHERE run_id = ? AND kept_pool_id = ?
  `);
  const insertFolded = db.prepare(`
    INSERT INTO pre_fund_reconciliation_folded_gateway_rows (
      group_id, source_priority, source_order, source_label, reconciliation_id,
      fingerprint, fields_json, name, card_no, source_location_json, raw_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  return (candidate) => {
    const candidateRawJson = rawJsonForCandidate(candidate);
    const fieldsJson = JSON.stringify((candidate && candidate.fields) || {});
    const locationJson = JSON.stringify((candidate && candidate.location) || {});
    const result = insertPool.run(
      runId,
      candidate.sourcePriority,
      candidate.sourceOrder,
      candidate.source,
      candidate.reconciliationId,
      candidate.fingerprint,
      rawJsonHash(candidateRawJson),
      fieldsJson,
      candidate.name || '',
      candidate.cardNo || '',
      locationJson
    );
    if (result.changes === 1) return true;

    const kept = selectKept.get(runId, candidate.reconciliationId, candidate.fingerprint);
    if (!kept) {
      throw new Error(
        `前置资金对账重复候选缺少保留行原始快照：runId=${runId}，reconciliationId=${candidate.reconciliationId}`
      );
    }
    let keptSnapshot = selectSnapshot.get(kept.id, runId);
    if (!keptSnapshot) {
      if (typeof resolveKeptRawJson !== 'function') {
        throw new Error(
          `前置资金对账首次重复必须提供 resolveKeptRawJson：runId=${runId}，poolId=${kept.id}`
        );
      }
      let keptLocation;
      try {
        keptLocation = JSON.parse(kept.source_location_json);
      } catch (error) {
        throw new Error(
          `前置资金对账保留候选定位 JSON 损坏：runId=${runId}，poolId=${kept.id}`,
          { cause: error }
        );
      }
      const keptRawJson = resolveKeptRawJson({
        poolId: kept.id,
        source: kept.source_label,
        sourcePriority: kept.source_priority,
        sourceOrder: kept.source_order,
        reconciliationId: kept.reconciliation_id,
        fingerprint: kept.fingerprint,
        location: keptLocation
      });
      if (typeof keptRawJson !== 'string') {
        throw new Error(
          `前置资金对账无法按来源定位保留候选原始JSON：runId=${runId}，poolId=${kept.id}`
        );
      }
      if (!hashesEqual(kept.raw_json_hash, rawJsonHash(keptRawJson))) {
        throw new Error(
          `前置资金对账保留候选原始JSON身份校验失败：runId=${runId}，poolId=${kept.id}`
        );
      }
      insertSnapshot.run(kept.id, runId, keptRawJson);
      keptSnapshot = { raw_json: keptRawJson };
    }
    insertGroup.run(
      runId,
      kept.id,
      String((candidate.fields && candidate.fields.channel) || ''),
      candidate.fingerprint,
      candidate.sourceOrder,
      DUPLICATE_FOLD_REASON
    );
    const group = selectGroup.get(runId, kept.id);
    if (!group) {
      throw new Error(`前置资金对账重复折叠组创建失败：runId=${runId}，poolId=${kept.id}`);
    }
    insertFolded.run(
      group.id,
      candidate.sourcePriority,
      candidate.sourceOrder,
      candidate.source,
      candidate.reconciliationId,
      candidate.fingerprint,
      fieldsJson,
      candidate.name || '',
      candidate.cardNo || '',
      locationJson,
      candidateRawJson
    );
    return false;
  };
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
    throw new TypeError('网关候选消费必须提供四个基础字段和类型规则匹配条件');
  }
  const fields = ['reconciliationId', 'channel', 'amount', 'currency'];
  for (const field of fields) {
    if (typeof criteria[field] !== 'string') {
      throw new TypeError(`网关候选匹配条件 ${field} 必须为字符串`);
    }
  }
  if (!Array.isArray(criteria.allowedGatewayTradeTypes)
    || criteria.allowedGatewayTradeTypes.some((value) => typeof value !== 'string')) {
    throw new TypeError('网关候选匹配条件 allowedGatewayTradeTypes 必须为字符串数组');
  }
  return [...fields.map((field) => criteria[field]), criteria.allowedGatewayTradeTypes];
}

class PreFundReconciliationRunStore {
  constructor(userDataDir) {
    this.userDataDir = userDataDir;
    runDataStore.moduleDir(userDataDir, MODULE);
  }

  open(monthKey) {
    const db = runDataStore.openSideDb(this.userDataDir, MODULE, monthKey);
    db.exec(PRE_FUND_RUN_DDL);
    const poolColumns = db.prepare('PRAGMA table_info(pre_fund_reconciliation_gateway_pool)').all();
    if (!poolColumns.some((column) => column.name === 'raw_json_hash')) {
      db.exec('ALTER TABLE pre_fund_reconciliation_gateway_pool ADD COLUMN raw_json_hash BLOB;');
    }
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

  insertGatewayCandidate(db, runId, candidate, options = {}) {
    return prepareGatewayCandidateStager(db, runId, options)(candidate);
  }

  createGatewayCandidateInserter(db, runId, options = {}) {
    return prepareGatewayCandidateStager(db, runId, options);
  }

  duplicateStats(db, runId) {
    const counts = db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM pre_fund_reconciliation_gateway_candidate_snapshots WHERE run_id = ?) AS snapshot_count,
        (SELECT COUNT(*) FROM pre_fund_reconciliation_duplicate_groups WHERE run_id = ?) AS group_count,
        (SELECT COUNT(*) FROM pre_fund_reconciliation_folded_gateway_rows f
          JOIN pre_fund_reconciliation_duplicate_groups g ON g.id = f.group_id
          WHERE g.run_id = ?) AS folded_count,
        (SELECT COALESCE(SUM(LENGTH(CAST(raw_json AS BLOB))), 0)
          FROM pre_fund_reconciliation_gateway_candidate_snapshots WHERE run_id = ?) AS kept_raw_bytes,
        (SELECT COALESCE(SUM(LENGTH(CAST(f.raw_json AS BLOB))), 0)
          FROM pre_fund_reconciliation_folded_gateway_rows f
          JOIN pre_fund_reconciliation_duplicate_groups g ON g.id = f.group_id
          WHERE g.run_id = ?) AS folded_raw_bytes
    `).get(runId, runId, runId, runId, runId);
    const summary = {
      snapshotCount: Number(counts.snapshot_count) || 0,
      duplicateGroupCount: Number(counts.group_count) || 0,
      foldedRowCount: Number(counts.folded_count) || 0,
      keptRawBytes: Number(counts.kept_raw_bytes) || 0,
      foldedRawBytes: Number(counts.folded_raw_bytes) || 0
    };
    if (summary.snapshotCount !== summary.duplicateGroupCount) {
      throw new Error(
        `前置资金对账重复快照守恒失败：保留快照${summary.snapshotCount}条，折叠组${summary.duplicateGroupCount}组`
      );
    }
    return summary;
  }

  consumeGatewayCandidate(db, runId, criteria, bankOrdinal) {
    const [reconciliationId, channel, amount, currency, allowedGatewayTradeTypes] = gatewayMatchValues(criteria);
    if (allowedGatewayTradeTypes.length === 0) return null;
    const row = db.prepare(`
      SELECT id, source_label, reconciliation_id, fingerprint, fields_json,
             name, card_no, source_location_json
      FROM pre_fund_reconciliation_gateway_pool
      WHERE run_id = ? AND reconciliation_id = ? AND consumed_bank_ordinal IS NULL
        AND json_extract(fields_json, '$.channel') = ?
        AND json_extract(fields_json, '$.amount') = ?
        AND json_extract(fields_json, '$.currency') = ?
        AND EXISTS (
          SELECT 1 FROM json_each(?) allowed
          WHERE allowed.value = json_extract(fields_json, '$.tradeType')
        )
      ORDER BY source_priority ASC, source_order ASC, id ASC
      LIMIT 1
    `).get(runId, reconciliationId, channel, amount, currency, JSON.stringify(allowedGatewayTradeTypes));
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
        AND EXISTS (
          SELECT 1 FROM json_each(?) allowed
          WHERE allowed.value = json_extract(fields_json, '$.tradeType')
        )
      ORDER BY source_priority ASC, source_order ASC, id ASC
      LIMIT 1
    `);
    const update = db.prepare(`
      UPDATE pre_fund_reconciliation_gateway_pool
      SET consumed_bank_ordinal = ?
      WHERE id = ? AND consumed_bank_ordinal IS NULL
    `);
    return (criteria, bankOrdinal) => {
      const [reconciliationId, channel, amount, currency, allowedGatewayTradeTypes] = gatewayMatchValues(criteria);
      if (allowedGatewayTradeTypes.length === 0) return null;
      const row = select.get(
        runId,
        reconciliationId,
        channel,
        amount,
        currency,
        JSON.stringify(allowedGatewayTradeTypes)
      );
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
      const bankChannels = db.prepare(`
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
      const duplicateChannels = db.prepare(`
        SELECT channel, MIN(first_event_order) AS first_event_order
        FROM pre_fund_reconciliation_duplicate_groups
        WHERE run_id = ?
        GROUP BY channel
        ORDER BY first_event_order ASC, channel ASC
      `).all(runId).map((row) => row.channel);
      const seen = new Set(bankChannels);
      return bankChannels.concat(duplicateChannels.filter((channel) => {
        if (seen.has(channel)) return false;
        seen.add(channel);
        return true;
      }));
    } finally {
      db.close();
    }
  }

  listChannelSummaries(monthKey, runId) {
    assertRunIdentity(monthKey, runId);
    const db = this.open(monthKey);
    try {
      return this.summarizeChannels(db, runId);
    } finally {
      db.close();
    }
  }

  summarizeChannels(db, runId) {
    if (!db || typeof db.prepare !== 'function') {
      throw new TypeError('前置资金对账渠道汇总需要有效数据库连接');
    }
    if (!Number.isSafeInteger(Number(runId)) || Number(runId) <= 0) {
      throw new TypeError('前置资金对账渠道汇总 runId 必须为正整数');
    }
    const bankSummaries = db.prepare(`
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
    const byChannel = new Map(bankSummaries.map((summary) => [summary.channel, summary]));
    const duplicateChannels = db.prepare(`
        SELECT channel, MIN(first_event_order) AS first_event_order
        FROM pre_fund_reconciliation_duplicate_groups
        WHERE run_id = ?
        GROUP BY channel
        ORDER BY first_event_order ASC, channel ASC
    `).all(runId);
    for (const row of duplicateChannels) {
      if (!byChannel.has(row.channel)) {
        const summary = { channel: row.channel, matchedCount: 0, unmatchedCount: 0 };
        bankSummaries.push(summary);
        byChannel.set(row.channel, summary);
      }
    }
    return bankSummaries;
  }

  channelHasDuplicates(monthKey, runId, channel) {
    assertRunIdentity(monthKey, runId);
    const db = this.open(monthKey);
    try {
      return !!db.prepare(`
        SELECT 1
        FROM pre_fund_reconciliation_duplicate_groups
        WHERE run_id = ? AND channel = ?
        LIMIT 1
      `).get(runId, channel);
    } finally {
      db.close();
    }
  }

  iterateDuplicateRecords(monthKey, runId, channel) {
    assertRunIdentity(monthKey, runId);
    const self = this;
    return (function* iterate() {
      const db = self.open(monthKey);
      try {
        const cursor = db.prepare(`
          SELECT *
          FROM (
            SELECT
              g.id AS group_id,
              g.first_event_order,
              g.fold_reason,
              0 AS object_rank,
              p.id AS object_id,
              p.source_priority,
              p.source_order,
              p.source_label,
              p.reconciliation_id,
              p.fingerprint,
              p.fields_json,
              p.name,
              p.card_no,
              p.source_location_json,
              s.raw_json
            FROM pre_fund_reconciliation_duplicate_groups g
            JOIN pre_fund_reconciliation_gateway_pool p ON p.id = g.kept_pool_id
            LEFT JOIN pre_fund_reconciliation_gateway_candidate_snapshots s ON s.pool_id = p.id
            WHERE g.run_id = ? AND g.channel = ?

            UNION ALL

            SELECT
              g.id AS group_id,
              g.first_event_order,
              g.fold_reason,
              1 AS object_rank,
              f.id AS object_id,
              f.source_priority,
              f.source_order,
              f.source_label,
              f.reconciliation_id,
              f.fingerprint,
              f.fields_json,
              f.name,
              f.card_no,
              f.source_location_json,
              f.raw_json
            FROM pre_fund_reconciliation_duplicate_groups g
            JOIN pre_fund_reconciliation_folded_gateway_rows f ON f.group_id = g.id
            WHERE g.run_id = ? AND g.channel = ?
          ) audit
          ORDER BY first_event_order ASC, group_id ASC, object_rank ASC,
                   source_priority ASC, source_order ASC, object_id ASC
        `).iterate(runId, channel, runId, channel);
        for (const row of cursor) {
          const context = {
            runId,
            table: row.object_rank === 0
              ? 'pre_fund_reconciliation_gateway_pool'
              : 'pre_fund_reconciliation_folded_gateway_rows',
            rowId: row.object_id
          };
          if (typeof row.raw_json !== 'string') {
            throw new Error(
              `前置资金对账重复审计原始JSON缺失：runId=${runId}，${context.table}#${row.object_id}`
            );
          }
          assertValidRawObjectJson(row.raw_json, context);
          yield {
            foldRecordId: `PF-${runId}-${row.group_id}`,
            objectType: row.object_rank === 0 ? '保留记录' : '被折叠记录',
            foldReason: row.fold_reason,
            candidate: {
              source: row.source_label,
              sourcePriority: row.source_priority,
              sourceOrder: row.source_order,
              reconciliationId: row.reconciliation_id,
              fingerprint: row.fingerprint,
              fields: parseResultObjectJson(row.fields_json, { ...context, column: 'fields_json' }),
              name: row.name || '',
              cardNo: row.card_no || '',
              location: parseResultObjectJson(
                row.source_location_json,
                { ...context, column: 'source_location_json' }
              ),
              rawJson: row.raw_json
            }
          };
        }
      } finally {
        db.close();
      }
    }());
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
      const hasDuplicateRecords = this.channelHasDuplicates(monthKey, runId, channel);
      yield {
        channel,
        hasDuplicateRecords,
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
        ),
        duplicateRecords: hasDuplicateRecords
          ? this.iterateDuplicateRecords(monthKey, runId, channel)
          : []
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
  DUPLICATE_FOLD_REASON,
  PreFundReconciliationRunStore,
  createPreFundReconciliationRunStore
};
