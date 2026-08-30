'use strict';

const { DatabaseSync } = require('node:sqlite');

const REQUIRED_TABLE_COLUMNS = Object.freeze({
  vcc_fin_op_runs: Object.freeze([
    'id', 'target_month', 'status', 'input_revisions_json',
    'result_revision', 'input_fingerprint', 'created_at', 'updated_at', 'archived_at'
  ]),
  vcc_fin_op_datasets: Object.freeze([
    'target_month', 'dataset_type', 'data_status', 'archived_run_id',
    'revision', 'generated_at', 'updated_at'
  ]),
  vcc_fin_op_archives: Object.freeze([
    'target_month', 'subject', 'balances_json', 'run_id', 'archived_at'
  ]),
  vcc_fin_op_run_rows: Object.freeze([
    'id', 'run_id', 'subject', 'row_kind', 'source_type',
    'category_major', 'category_minor', 'currency', 'amount'
  ]),
  vcc_fin_op_run_balances: Object.freeze([
    'run_id', 'subject', 'currency', 'opening_balance', 'period_amount',
    'calculated_balance', 'system_balance', 'difference'
  ]),
  vcc_fin_op_run_adjustments: Object.freeze([
    'id', 'run_id', 'row_key', 'subject', 'source_type', 'category_major',
    'category_minor', 'currency', 'adjustment_amount', 'reason', 'sequence',
    'created_at', 'created_app_version', 'created_build_sha'
  ]),
  vcc_fin_op_pending_summary_rows: Object.freeze(['id', 'run_id']),
  vcc_fin_op_pending_currency_totals: Object.freeze(['run_id', 'subject', 'currency', 'amount']),
  vcc_fin_op_effective_rows: Object.freeze(['target_month', 'source_type']),
  vcc_fin_op_import_batches: Object.freeze(['id', 'target_month', 'status']),
  vcc_fin_op_import_records: Object.freeze([
    'id', 'target_month', 'source_type', 'status', 'resolution_status', 'dataset_deleted_at'
  ]),
  vcc_fin_op_system_snapshots: Object.freeze(['target_month', 'subject']),
  vcc_fin_op_opening_balances: Object.freeze(['target_month', 'subject']),
  vcc_fin_op_module_state: Object.freeze(['singleton_id', 'first_month'])
});

const REQUIRED_PRIMARY_KEYS = Object.freeze({
  vcc_fin_op_runs: Object.freeze(['id']),
  vcc_fin_op_datasets: Object.freeze(['target_month', 'dataset_type']),
  vcc_fin_op_archives: Object.freeze(['target_month', 'subject']),
  vcc_fin_op_run_rows: Object.freeze(['id']),
  vcc_fin_op_run_balances: Object.freeze(['run_id', 'subject', 'currency']),
  vcc_fin_op_run_adjustments: Object.freeze(['id']),
  vcc_fin_op_pending_summary_rows: Object.freeze(['id']),
  vcc_fin_op_pending_currency_totals: Object.freeze(['run_id', 'subject', 'currency']),
  vcc_fin_op_import_batches: Object.freeze(['id']),
  vcc_fin_op_import_records: Object.freeze(['id']),
  vcc_fin_op_opening_balances: Object.freeze(['target_month', 'subject'])
});

const REQUIRED_INDEXES = Object.freeze({
  idx_vcc_fin_op_effective_month_source: Object.freeze(['target_month', 'source_type']),
  idx_vcc_fin_op_run_rows_run_subject: Object.freeze(['run_id', 'subject']),
  idx_vcc_fin_op_adjustments_run_subject: Object.freeze(['run_id', 'subject']),
  idx_vcc_fin_op_pending_summary_run_subject: Object.freeze(['run_id', 'subject'])
});

function schemaNotReady(details) {
  const error = new Error('VCC 财务OP数据库结构未就绪，请重启应用完成初始化后重试。');
  error.code = 'vcc-schema-not-ready';
  error.detailLines = details;
  error.context = { details };
  return error;
}

function tableInfo(db, tableName) {
  return db.prepare(`PRAGMA table_info(${tableName})`).all();
}

function indexColumns(db, indexName) {
  return db.prepare(`PRAGMA index_info(${indexName})`).all()
    .sort((left, right) => Number(left.seqno) - Number(right.seqno))
    .map((row) => String(row.name));
}

function assertVccSchemaReady(db) {
  const existingTables = new Set(db.prepare(`
    SELECT name FROM sqlite_schema WHERE type = 'table' AND name LIKE 'vcc_fin_op_%'
  `).all().map((row) => String(row.name)));
  const details = [];

  for (const [tableName, requiredColumns] of Object.entries(REQUIRED_TABLE_COLUMNS)) {
    if (!existingTables.has(tableName)) {
      details.push(`missing-table:${tableName}`);
      continue;
    }
    const info = tableInfo(db, tableName);
    const columns = new Set(info.map((row) => String(row.name)));
    for (const columnName of requiredColumns) {
      if (!columns.has(columnName)) details.push(`missing-column:${tableName}.${columnName}`);
    }
    const requiredPrimaryKey = REQUIRED_PRIMARY_KEYS[tableName];
    if (requiredPrimaryKey) {
      const actualPrimaryKey = info
        .filter((row) => Number(row.pk) > 0)
        .sort((left, right) => Number(left.pk) - Number(right.pk))
        .map((row) => String(row.name));
      if (JSON.stringify(actualPrimaryKey) !== JSON.stringify(requiredPrimaryKey)) {
        details.push(`primary-key-mismatch:${tableName}`);
      }
    }
  }

  const existingIndexes = new Set(db.prepare(`
    SELECT name FROM sqlite_schema WHERE type = 'index'
  `).all().map((row) => String(row.name)));
  for (const [indexName, requiredPrefix] of Object.entries(REQUIRED_INDEXES)) {
    if (!existingIndexes.has(indexName)) {
      details.push(`missing-index:${indexName}`);
      continue;
    }
    const actualColumns = indexColumns(db, indexName);
    if (requiredPrefix.some((column, index) => actualColumns[index] !== column)) {
      details.push(`index-prefix-mismatch:${indexName}`);
    }
  }

  if (details.length > 0) throw schemaNotReady(details);
  return Object.freeze({ ready: true });
}

function openVccReadDatabase(dbPath) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    db.exec('PRAGMA query_only = ON');
    db.exec('PRAGMA foreign_keys = ON');
    db.exec('PRAGMA busy_timeout = 30000');
    assertVccSchemaReady(db);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

module.exports = {
  REQUIRED_TABLE_COLUMNS,
  REQUIRED_PRIMARY_KEYS,
  REQUIRED_INDEXES,
  assertVccSchemaReady,
  openVccReadDatabase
};
