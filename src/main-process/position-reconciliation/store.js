'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const {
  POSITION_DB_RELATIVE_PATH,
  POSITION_RULESET_VERSION,
  SOURCE_TYPES,
  SOURCE_DISPLAY_ORDER,
  SOURCE_DEFINITIONS,
  LINK_HEADERS,
  BANK_STATUSES,
  DIFFERENCE_STATUSES,
  MATCH_TYPES,
  sourceTypeForFundType
} = require('./constants');
const { BANK_STATEMENT_FIELDS } = require('../../constants/bank-statement-fields');
const {
  PositionReconciliationError,
  text,
  transaction,
  stableHash
} = require('./common');
const {
  normalizeSourceSnapshot
} = require('../archive-center/source-snapshot');
const { deriveLinkedRows } = require('./derivation');

const DATE_JSON_TYPE_KEY = '__position_reconciliation_type__';
const POSITION_DB_IDENTITY_KEY = 'position_database_identity_v1';
const POSITION_DB_GENERATION_KEY = 'position_database_generation_v1';
const POSITION_DB_CHECKPOINT_TOKEN_KEY = 'position_database_checkpoint_token_v1';
const SHA256_RE = /^[a-f0-9]{64}$/;
const POSITION_DB_INITIALIZATION_MODES = Object.freeze({
  NEW: 'new',
  EMPTY_LEGACY_UPGRADE: 'empty-legacy-upgrade',
  EXISTING: 'existing'
});

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS position_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS position_checkpoint_history (
    generation INTEGER PRIMARY KEY,
    token TEXT NOT NULL UNIQUE,
    parent_token TEXT,
    operation_token TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS position_operation_inputs (
    operation_token TEXT NOT NULL,
    input_key TEXT NOT NULL,
    source_type TEXT NOT NULL,
    role TEXT NOT NULL,
    file_path TEXT NOT NULL,
    original_name TEXT NOT NULL,
    sha256 TEXT NOT NULL,
    size_bytes INTEGER NOT NULL,
    source_snapshot_json TEXT NOT NULL,
    committed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY(operation_token, input_key)
  );
  CREATE INDEX IF NOT EXISTS idx_position_operation_inputs_token
    ON position_operation_inputs(operation_token, committed_at, input_key);

  CREATE TABLE IF NOT EXISTS position_revisions (
    kind TEXT NOT NULL,
    scope_key TEXT NOT NULL,
    revision INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY(kind, scope_key)
  );

  CREATE TABLE IF NOT EXISTS position_bank_rows (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    biz_id TEXT NOT NULL UNIQUE,
    channel TEXT NOT NULL,
    month_key TEXT NOT NULL,
    bill_date TEXT NOT NULL,
    status TEXT NOT NULL,
    source_file_path TEXT NOT NULL,
    source_file_name TEXT NOT NULL,
    source_sheet TEXT NOT NULL,
    source_row_number INTEGER NOT NULL,
    import_order INTEGER NOT NULL,
    original_fund_type TEXT,
    working_fund_type TEXT,
    hit_summary TEXT,
    hit_type TEXT,
    match_detail TEXT,
    original_json TEXT NOT NULL,
    working_json TEXT NOT NULL,
    imported_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_position_bank_scope
    ON position_bank_rows(channel, month_key, status, import_order);
  CREATE INDEX IF NOT EXISTS idx_position_bank_fund_type
    ON position_bank_rows(working_fund_type, status);

  CREATE TABLE IF NOT EXISTS position_source_rows (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_type TEXT NOT NULL,
    business_key TEXT NOT NULL,
    event_date TEXT,
    month_key TEXT,
    source_file_path TEXT NOT NULL,
    source_file_name TEXT NOT NULL,
    source_sheet TEXT NOT NULL,
    source_row_number INTEGER NOT NULL,
    row_hash TEXT NOT NULL,
    raw_json TEXT NOT NULL,
    imported_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(source_type, business_key)
  );
  CREATE INDEX IF NOT EXISTS idx_position_source_type_month
    ON position_source_rows(source_type, month_key);

  CREATE TABLE IF NOT EXISTS position_link_rows (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_type TEXT NOT NULL,
    business_key TEXT NOT NULL,
    source_row_id INTEGER NOT NULL,
    source_row_number INTEGER NOT NULL,
    ordinal INTEGER NOT NULL,
    leg_index INTEGER NOT NULL DEFAULT 0,
    recon_id TEXT,
    merchant_id TEXT,
    currency TEXT,
    amount TEXT,
    fund_type TEXT,
    status TEXT,
    event_date TEXT,
    visible INTEGER NOT NULL DEFAULT 1,
    linked_json TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(source_row_id) REFERENCES position_source_rows(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_position_link_type_recon
    ON position_link_rows(source_type, recon_id);
  CREATE INDEX IF NOT EXISTS idx_position_link_type_account_currency
    ON position_link_rows(source_type, merchant_id, currency);

  CREATE TABLE IF NOT EXISTS position_account_mappings (
    mid_account_id TEXT PRIMARY KEY,
    clearing_account_id TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS position_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_uuid TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL,
    scope_json TEXT NOT NULL,
    snapshot_json TEXT NOT NULL,
    summary_json TEXT NOT NULL,
    exported_at TEXT,
    reimported_at TEXT,
    confirmed_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_position_runs_status
    ON position_runs(status, id DESC);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_position_runs_single_pending
    ON position_runs(status) WHERE status = 'pending';

  CREATE TABLE IF NOT EXISTS position_run_rows (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id INTEGER NOT NULL,
    biz_id TEXT NOT NULL,
    channel TEXT NOT NULL,
    month_key TEXT NOT NULL,
    source_order INTEGER NOT NULL,
    original_fund_type TEXT,
    result_fund_type TEXT,
    hit_summary TEXT,
    hit_type TEXT,
    match_detail TEXT,
    outcome TEXT NOT NULL,
    changed INTEGER NOT NULL DEFAULT 0,
    manual_modified INTEGER NOT NULL DEFAULT 0,
    consumes_source INTEGER NOT NULL DEFAULT 0,
    original_json TEXT NOT NULL,
    result_json TEXT NOT NULL,
    lineage_json TEXT NOT NULL,
    integrity_hash TEXT NOT NULL,
    FOREIGN KEY(run_id) REFERENCES position_runs(id) ON DELETE CASCADE,
    UNIQUE(run_id, biz_id)
  );
  CREATE INDEX IF NOT EXISTS idx_position_run_rows_scope
    ON position_run_rows(run_id, channel, month_key, source_order);

  CREATE TABLE IF NOT EXISTS position_differences (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id INTEGER NOT NULL,
    biz_id TEXT NOT NULL,
    channel TEXT NOT NULL,
    month_key TEXT NOT NULL,
    status TEXT NOT NULL,
    reason TEXT NOT NULL,
    lineage_json TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(run_id) REFERENCES position_runs(id) ON DELETE CASCADE,
    UNIQUE(run_id, biz_id)
  );
  CREATE INDEX IF NOT EXISTS idx_position_differences_summary
    ON position_differences(channel, month_key, status, run_id);

  CREATE TABLE IF NOT EXISTS position_consumed_sources (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id INTEGER NOT NULL,
    source_type TEXT NOT NULL,
    business_key TEXT NOT NULL,
    leg_index INTEGER NOT NULL DEFAULT 0,
    bank_biz_id TEXT NOT NULL,
    confirmed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(run_id) REFERENCES position_runs(id) ON DELETE CASCADE,
    UNIQUE(source_type, business_key, leg_index)
  );
  CREATE INDEX IF NOT EXISTS idx_position_consumed_sources_run
    ON position_consumed_sources(run_id, bank_biz_id);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_position_consumed_sources_bank
    ON position_consumed_sources(bank_biz_id);
`;

const SUPPORTED_EMPTY_LEGACY_TABLE_INFO = Object.freeze({
  position_account_mappings:
    '[["mid_account_id","TEXT",0,null,1],["clearing_account_id","TEXT",1,null,0],["updated_at","TEXT",1,"CURRENT_TIMESTAMP",0]]',
  position_bank_rows:
    '[["id","INTEGER",0,null,1],["biz_id","TEXT",1,null,0],["channel","TEXT",1,null,0],["month_key","TEXT",1,null,0],["bill_date","TEXT",1,null,0],["status","TEXT",1,null,0],["source_file_path","TEXT",1,null,0],["source_file_name","TEXT",1,null,0],["source_sheet","TEXT",1,null,0],["source_row_number","INTEGER",1,null,0],["import_order","INTEGER",1,null,0],["original_fund_type","TEXT",0,null,0],["working_fund_type","TEXT",0,null,0],["hit_summary","TEXT",0,null,0],["hit_type","TEXT",0,null,0],["match_detail","TEXT",0,null,0],["original_json","TEXT",1,null,0],["working_json","TEXT",1,null,0],["imported_at","TEXT",1,"CURRENT_TIMESTAMP",0],["updated_at","TEXT",1,"CURRENT_TIMESTAMP",0]]',
  position_consumed_sources:
    '[["id","INTEGER",0,null,1],["run_id","INTEGER",1,null,0],["source_type","TEXT",1,null,0],["business_key","TEXT",1,null,0],["leg_index","INTEGER",1,"0",0],["bank_biz_id","TEXT",1,null,0],["confirmed_at","TEXT",1,"CURRENT_TIMESTAMP",0]]',
  position_differences:
    '[["id","INTEGER",0,null,1],["run_id","INTEGER",1,null,0],["biz_id","TEXT",1,null,0],["channel","TEXT",1,null,0],["month_key","TEXT",1,null,0],["status","TEXT",1,null,0],["reason","TEXT",1,null,0],["lineage_json","TEXT",1,null,0],["created_at","TEXT",1,"CURRENT_TIMESTAMP",0],["updated_at","TEXT",1,"CURRENT_TIMESTAMP",0]]',
  position_link_rows:
    '[["id","INTEGER",0,null,1],["source_type","TEXT",1,null,0],["business_key","TEXT",1,null,0],["source_row_id","INTEGER",1,null,0],["source_row_number","INTEGER",1,null,0],["ordinal","INTEGER",1,null,0],["leg_index","INTEGER",1,"0",0],["recon_id","TEXT",0,null,0],["merchant_id","TEXT",0,null,0],["currency","TEXT",0,null,0],["amount","TEXT",0,null,0],["fund_type","TEXT",0,null,0],["status","TEXT",0,null,0],["event_date","TEXT",0,null,0],["visible","INTEGER",1,"1",0],["linked_json","TEXT",1,null,0],["created_at","TEXT",1,"CURRENT_TIMESTAMP",0]]',
  position_meta:
    '[["key","TEXT",0,null,1],["value","TEXT",1,null,0]]',
  position_revisions:
    '[["kind","TEXT",1,null,1],["scope_key","TEXT",1,null,2],["revision","INTEGER",1,"0",0],["updated_at","TEXT",1,"CURRENT_TIMESTAMP",0]]',
  position_run_rows:
    '[["id","INTEGER",0,null,1],["run_id","INTEGER",1,null,0],["biz_id","TEXT",1,null,0],["channel","TEXT",1,null,0],["month_key","TEXT",1,null,0],["source_order","INTEGER",1,null,0],["original_fund_type","TEXT",0,null,0],["result_fund_type","TEXT",0,null,0],["hit_summary","TEXT",0,null,0],["hit_type","TEXT",0,null,0],["match_detail","TEXT",0,null,0],["outcome","TEXT",1,null,0],["changed","INTEGER",1,"0",0],["manual_modified","INTEGER",1,"0",0],["original_json","TEXT",1,null,0],["result_json","TEXT",1,null,0],["lineage_json","TEXT",1,null,0]]',
  position_runs:
    '[["id","INTEGER",0,null,1],["run_uuid","TEXT",1,null,0],["status","TEXT",1,null,0],["scope_json","TEXT",1,null,0],["snapshot_json","TEXT",1,null,0],["summary_json","TEXT",1,null,0],["exported_at","TEXT",0,null,0],["reimported_at","TEXT",0,null,0],["confirmed_at","TEXT",0,null,0],["created_at","TEXT",1,"CURRENT_TIMESTAMP",0],["updated_at","TEXT",1,"CURRENT_TIMESTAMP",0]]',
  position_source_rows:
    '[["id","INTEGER",0,null,1],["source_type","TEXT",1,null,0],["business_key","TEXT",1,null,0],["event_date","TEXT",0,null,0],["month_key","TEXT",0,null,0],["source_file_path","TEXT",1,null,0],["source_file_name","TEXT",1,null,0],["source_sheet","TEXT",1,null,0],["source_row_number","INTEGER",1,null,0],["row_hash","TEXT",1,null,0],["raw_json","TEXT",1,null,0],["imported_at","TEXT",1,"CURRENT_TIMESTAMP",0],["updated_at","TEXT",1,"CURRENT_TIMESTAMP",0]]'
});

const SUPPORTED_EMPTY_LEGACY_TABLE_SQL = Object.freeze({
  position_account_mappings:
    'CREATE TABLE position_account_mappings ( mid_account_id TEXT PRIMARY KEY, clearing_account_id TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP )',
  position_bank_rows:
    'CREATE TABLE position_bank_rows ( id INTEGER PRIMARY KEY AUTOINCREMENT, biz_id TEXT NOT NULL UNIQUE, channel TEXT NOT NULL, month_key TEXT NOT NULL, bill_date TEXT NOT NULL, status TEXT NOT NULL, source_file_path TEXT NOT NULL, source_file_name TEXT NOT NULL, source_sheet TEXT NOT NULL, source_row_number INTEGER NOT NULL, import_order INTEGER NOT NULL, original_fund_type TEXT, working_fund_type TEXT, hit_summary TEXT, hit_type TEXT, match_detail TEXT, original_json TEXT NOT NULL, working_json TEXT NOT NULL, imported_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP )',
  position_consumed_sources:
    'CREATE TABLE position_consumed_sources ( id INTEGER PRIMARY KEY AUTOINCREMENT, run_id INTEGER NOT NULL, source_type TEXT NOT NULL, business_key TEXT NOT NULL, leg_index INTEGER NOT NULL DEFAULT 0, bank_biz_id TEXT NOT NULL, confirmed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY(run_id) REFERENCES position_runs(id) ON DELETE CASCADE, UNIQUE(source_type, business_key, leg_index) )',
  position_differences:
    'CREATE TABLE position_differences ( id INTEGER PRIMARY KEY AUTOINCREMENT, run_id INTEGER NOT NULL, biz_id TEXT NOT NULL, channel TEXT NOT NULL, month_key TEXT NOT NULL, status TEXT NOT NULL, reason TEXT NOT NULL, lineage_json TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY(run_id) REFERENCES position_runs(id) ON DELETE CASCADE, UNIQUE(run_id, biz_id) )',
  position_link_rows:
    'CREATE TABLE position_link_rows ( id INTEGER PRIMARY KEY AUTOINCREMENT, source_type TEXT NOT NULL, business_key TEXT NOT NULL, source_row_id INTEGER NOT NULL, source_row_number INTEGER NOT NULL, ordinal INTEGER NOT NULL, leg_index INTEGER NOT NULL DEFAULT 0, recon_id TEXT, merchant_id TEXT, currency TEXT, amount TEXT, fund_type TEXT, status TEXT, event_date TEXT, visible INTEGER NOT NULL DEFAULT 1, linked_json TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY(source_row_id) REFERENCES position_source_rows(id) ON DELETE CASCADE )',
  position_meta:
    'CREATE TABLE position_meta ( key TEXT PRIMARY KEY, value TEXT NOT NULL )',
  position_revisions:
    'CREATE TABLE position_revisions ( kind TEXT NOT NULL, scope_key TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY(kind, scope_key) )',
  position_run_rows:
    'CREATE TABLE position_run_rows ( id INTEGER PRIMARY KEY AUTOINCREMENT, run_id INTEGER NOT NULL, biz_id TEXT NOT NULL, channel TEXT NOT NULL, month_key TEXT NOT NULL, source_order INTEGER NOT NULL, original_fund_type TEXT, result_fund_type TEXT, hit_summary TEXT, hit_type TEXT, match_detail TEXT, outcome TEXT NOT NULL, changed INTEGER NOT NULL DEFAULT 0, manual_modified INTEGER NOT NULL DEFAULT 0, original_json TEXT NOT NULL, result_json TEXT NOT NULL, lineage_json TEXT NOT NULL, FOREIGN KEY(run_id) REFERENCES position_runs(id) ON DELETE CASCADE, UNIQUE(run_id, biz_id) )',
  position_runs:
    'CREATE TABLE position_runs ( id INTEGER PRIMARY KEY AUTOINCREMENT, run_uuid TEXT NOT NULL UNIQUE, status TEXT NOT NULL, scope_json TEXT NOT NULL, snapshot_json TEXT NOT NULL, summary_json TEXT NOT NULL, exported_at TEXT, reimported_at TEXT, confirmed_at TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP )',
  position_source_rows:
    'CREATE TABLE position_source_rows ( id INTEGER PRIMARY KEY AUTOINCREMENT, source_type TEXT NOT NULL, business_key TEXT NOT NULL, event_date TEXT, month_key TEXT, source_file_path TEXT NOT NULL, source_file_name TEXT NOT NULL, source_sheet TEXT NOT NULL, source_row_number INTEGER NOT NULL, row_hash TEXT NOT NULL, raw_json TEXT NOT NULL, imported_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(source_type, business_key) )'
});

const SUPPORTED_EMPTY_LEGACY_INDEX_INFO = Object.freeze({
  idx_position_bank_fund_type: Object.freeze({
    sql: 'CREATE INDEX idx_position_bank_fund_type ON position_bank_rows(working_fund_type, status)',
    columns: Object.freeze(['working_fund_type', 'status'])
  }),
  idx_position_bank_scope: Object.freeze({
    sql: 'CREATE INDEX idx_position_bank_scope ON position_bank_rows(channel, month_key, status, import_order)',
    columns: Object.freeze(['channel', 'month_key', 'status', 'import_order'])
  }),
  idx_position_consumed_sources_bank: Object.freeze({
    sql: 'CREATE UNIQUE INDEX idx_position_consumed_sources_bank ON position_consumed_sources(bank_biz_id)',
    columns: Object.freeze(['bank_biz_id'])
  }),
  idx_position_consumed_sources_run: Object.freeze({
    sql: 'CREATE INDEX idx_position_consumed_sources_run ON position_consumed_sources(run_id, bank_biz_id)',
    columns: Object.freeze(['run_id', 'bank_biz_id'])
  }),
  idx_position_differences_summary: Object.freeze({
    sql: 'CREATE INDEX idx_position_differences_summary ON position_differences(channel, month_key, status, run_id)',
    columns: Object.freeze(['channel', 'month_key', 'status', 'run_id'])
  }),
  idx_position_link_type_account_currency: Object.freeze({
    sql: 'CREATE INDEX idx_position_link_type_account_currency ON position_link_rows(source_type, merchant_id, currency)',
    columns: Object.freeze(['source_type', 'merchant_id', 'currency'])
  }),
  idx_position_link_type_recon: Object.freeze({
    sql: 'CREATE INDEX idx_position_link_type_recon ON position_link_rows(source_type, recon_id)',
    columns: Object.freeze(['source_type', 'recon_id'])
  }),
  idx_position_run_rows_scope: Object.freeze({
    sql: 'CREATE INDEX idx_position_run_rows_scope ON position_run_rows(run_id, channel, month_key, source_order)',
    columns: Object.freeze(['run_id', 'channel', 'month_key', 'source_order'])
  }),
  idx_position_runs_single_pending: Object.freeze({
    sql: "CREATE UNIQUE INDEX idx_position_runs_single_pending ON position_runs(status) WHERE status = 'pending'",
    columns: Object.freeze(['status'])
  }),
  idx_position_runs_status: Object.freeze({
    sql: 'CREATE INDEX idx_position_runs_status ON position_runs(status, id DESC)',
    columns: Object.freeze(['status', 'id'])
  }),
  idx_position_source_type_month: Object.freeze({
    sql: 'CREATE INDEX idx_position_source_type_month ON position_source_rows(source_type, month_key)',
    columns: Object.freeze(['source_type', 'month_key'])
  })
});

function quoteSqlIdentifier(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

function normalizeSchemaSql(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function tableInfoSignature(column) {
  return [
    String(column.name ?? ''),
    String(column.type ?? ''),
    Number(column.notnull),
    column.dflt_value === null ? null : String(column.dflt_value),
    Number(column.pk)
  ];
}

function incompleteSideDatabaseError(dbPath, reason = '') {
  const error = new PositionReconciliationError(
    'position-side-db-missing',
    '平盘对账侧库不完整，已停止初始化以避免历史消费关系丢失',
    [
      `异常文件：${dbPath}`,
      ...(reason ? [`校验结果：${reason}`] : []),
      '请退出软件后恢复同一备份批次中的完整软件数据目录，再重新打开'
    ]
  );
  error.reason = reason || '平盘侧库结构或空表证明不完整';
  return error;
}

function assertNewDatabaseHasNoUserSchema(db, dbPath) {
  try {
    const schemaObjects = db.prepare(`
      SELECT type, name
      FROM sqlite_master
      WHERE type IN ('table', 'index', 'view', 'trigger')
        AND name NOT LIKE 'sqlite_%'
    `).all();
    if (schemaObjects.length > 0) {
      throw incompleteSideDatabaseError(dbPath, '新建候选已存在用户 schema 对象');
    }
  } catch (error) {
    if (error instanceof PositionReconciliationError) throw error;
    throw incompleteSideDatabaseError(dbPath, 'SQLite 新建候选结构校验失败');
  }
}

function assertSupportedEmptyLegacyDatabase(db, dbPath) {
  try {
    const quickCheckRows = db.prepare('PRAGMA quick_check').all();
    if (quickCheckRows.length !== 1
        || text(Object.values(quickCheckRows[0] || {})[0]) !== 'ok') {
      throw incompleteSideDatabaseError(dbPath, 'SQLite quick_check 未通过');
    }

    const schemaObjects = db.prepare(`
      SELECT type, name, sql
      FROM sqlite_master
      WHERE type IN ('table', 'index', 'view', 'trigger')
        AND name NOT LIKE 'sqlite_%'
      ORDER BY type, name
    `).all();
    const expectedTables = Object.keys(SUPPORTED_EMPTY_LEGACY_TABLE_INFO).sort();
    const actualTables = schemaObjects
      .filter((item) => item.type === 'table')
      .map((item) => text(item.name))
      .sort();
    if (JSON.stringify(actualTables) !== JSON.stringify(expectedTables)) {
      throw incompleteSideDatabaseError(dbPath, '旧版用户表集合不匹配');
    }
    if (schemaObjects.some((item) => item.type === 'view' || item.type === 'trigger')) {
      throw incompleteSideDatabaseError(dbPath, '存在未知视图或触发器');
    }
    const tableObjects = new Map(
      schemaObjects
        .filter((item) => item.type === 'table')
        .map((item) => [String(item.name), item])
    );
    const actualIndexes = schemaObjects
      .filter((item) => item.type === 'index')
      .map((item) => text(item.name))
      .sort();
    const expectedIndexes = Object.keys(SUPPORTED_EMPTY_LEGACY_INDEX_INFO).sort();
    if (JSON.stringify(actualIndexes) !== JSON.stringify(expectedIndexes)) {
      throw incompleteSideDatabaseError(dbPath, '旧版索引集合不匹配');
    }
    const indexObjects = new Map(
      schemaObjects
        .filter((item) => item.type === 'index')
        .map((item) => [String(item.name), item])
    );
    for (const indexName of expectedIndexes) {
      const expectedIndex = SUPPORTED_EMPTY_LEGACY_INDEX_INFO[indexName];
      const actualIndex = indexObjects.get(indexName);
      const indexColumns = db.prepare(
        `PRAGMA index_info(${quoteSqlIdentifier(indexName)})`
      ).all().map((column) => String(column.name ?? ''));
      if (normalizeSchemaSql(actualIndex && actualIndex.sql) !== expectedIndex.sql
          || JSON.stringify(indexColumns) !== JSON.stringify(expectedIndex.columns)) {
        throw incompleteSideDatabaseError(dbPath, `旧版索引结构不匹配：${indexName}`);
      }
    }

    for (const table of expectedTables) {
      if (normalizeSchemaSql(tableObjects.get(table) && tableObjects.get(table).sql)
          !== SUPPORTED_EMPTY_LEGACY_TABLE_SQL[table]) {
        throw incompleteSideDatabaseError(dbPath, `旧版表约束不匹配：${table}`);
      }
      const tableInfo = db.prepare(
        `PRAGMA table_info(${quoteSqlIdentifier(table)})`
      ).all().map(tableInfoSignature);
      if (JSON.stringify(tableInfo) !== SUPPORTED_EMPTY_LEGACY_TABLE_INFO[table]) {
        throw incompleteSideDatabaseError(dbPath, `旧版表结构不匹配：${table}`);
      }
      const count = Number(
        db.prepare(
          `SELECT COUNT(*) AS count FROM ${quoteSqlIdentifier(table)}`
        ).get().count
      );
      if (!Number.isSafeInteger(count) || count !== 0) {
        throw incompleteSideDatabaseError(dbPath, `旧版表不是空表：${table}`);
      }
    }
  } catch (error) {
    if (error instanceof PositionReconciliationError) throw error;
    throw incompleteSideDatabaseError(dbPath, 'SQLite 结构或空表校验失败');
  }
}

function parseJson(value, label) {
  try {
    const parsed = JSON.parse(value, (_key, item) => {
      if (
        item
        && typeof item === 'object'
        && !Array.isArray(item)
        && item[DATE_JSON_TYPE_KEY] === 'Date'
      ) {
        if (typeof item.value !== 'string') throw new TypeError('日期标记缺少字符串 value');
        const date = new Date(item.value);
        if (Number.isNaN(date.getTime())) throw new TypeError(`日期标记无效：${item.value}`);
        return date;
      }
      return item;
    });
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new TypeError('期望 JSON 对象');
    }
    return parsed;
  } catch (error) {
    throw new PositionReconciliationError(
      'position-side-data-invalid',
      `平盘侧库${label || '数据'} JSON 损坏：${error.message}`
    );
  }
}

function serializeJson(value) {
  return JSON.stringify(value, function replacer(key, item) {
    const original = key === '' ? value : this[key];
    if (original instanceof Date) {
      if (Number.isNaN(original.getTime())) return 'Invalid Date';
      return {
        [DATE_JSON_TYPE_KEY]: 'Date',
        value: original.toISOString()
      };
    }
    return item;
  });
}

function operationInputKey(role, filePath) {
  return stableHash({
    role: text(role),
    filePath: path.resolve(String(filePath || ''))
  });
}

function normalizeOperationInputEvidence(value, fallbackSourceType = '') {
  const input = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const role = text(input.role || 'input');
  const filePath = path.resolve(String(input.filePath || ''));
  const sourceType = text(input.sourceType || fallbackSourceType);
  const originalName = text(input.originalName) || path.basename(filePath);
  const sourceSnapshot = normalizeSourceSnapshot(input.sourceSnapshot);
  const sha256 = text(input.expectedSha256 || input.sha256).toLowerCase();
  const sizeBytes = Number(input.expectedSizeBytes ?? input.sizeBytes);
  if (role !== 'input'
      || !String(input.filePath || '').trim()
      || !sourceType
      || !sourceSnapshot
      || !SHA256_RE.test(sha256)
      || !Number.isSafeInteger(sizeBytes)
      || sizeBytes < 0
      || sourceSnapshot.sizeBytes !== sizeBytes) {
    throwInvalidSideData('平盘输入缺少完整的文件级提交证据');
  }
  return {
    inputKey: operationInputKey(role, filePath),
    sourceType,
    role,
    filePath,
    originalName,
    sourceSnapshot,
    sha256,
    sizeBytes
  };
}

function operationInputEvidenceHash(value) {
  return stableHash({
    inputKey: value.inputKey,
    sourceType: value.sourceType,
    role: value.role,
    filePath: value.filePath,
    originalName: value.originalName,
    sourceSnapshot: value.sourceSnapshot,
    sha256: value.sha256,
    sizeBytes: value.sizeBytes
  });
}

function runRowIntegrityHash({
  runId,
  bizId,
  channel,
  monthKey,
  sourceOrder,
  originalFundType,
  resultFundType,
  hitSummary,
  hitType,
  matchDetail,
  outcome,
  changed,
  manualModified,
  consumesSource,
  originalRow,
  resultRow,
  lineage
}) {
  const persistedOriginalRow = parseJson(serializeJson(originalRow), '运行完整性原始行');
  const persistedResultRow = parseJson(serializeJson(resultRow), '运行完整性结果行');
  const persistedLineage = parseJson(serializeJson(lineage), '运行完整性血缘');
  return stableHash({
    runId: Number(runId),
    bizId: text(bizId),
    channel: text(channel),
    monthKey: text(monthKey),
    sourceOrder: Number(sourceOrder),
    originalFundType: text(originalFundType),
    resultFundType: text(resultFundType),
    hitSummary: String(hitSummary || ''),
    hitType: String(hitType || ''),
    matchDetail: String(matchDetail || ''),
    outcome: text(outcome),
    changed: Boolean(changed),
    manualModified: Boolean(manualModified),
    consumesSource: Boolean(consumesSource),
    originalRow: persistedOriginalRow,
    resultRow: persistedResultRow,
    lineage: persistedLineage
  });
}

function runRowConsumesSource(item) {
  const lineage = item && item.lineage ? item.lineage : {};
  const sourceType = text(lineage.sourceType);
  return item
    && item.outcome === 'matched'
    && sourceType
    && sourceType !== SOURCE_TYPES.BANK_ACCOUNT;
}

function checkpointValue(value, label) {
  const normalized = text(value);
  if (!normalized) {
    throw new PositionReconciliationError(
      'position-side-db-mismatch',
      `平盘对账侧库 ${label} 缺失，无法确认主库与侧库属于同一数据代次`
    );
  }
  return normalized;
}

function checkpointGeneration(value) {
  const normalized = text(value);
  if (!/^(0|[1-9]\d*)$/.test(normalized)) {
    throw new PositionReconciliationError(
      'position-side-db-mismatch',
      '平盘对账侧库 generation 非法，无法确认主库与侧库属于同一数据代次'
    );
  }
  const generation = Number(normalized);
  if (!Number.isSafeInteger(generation)) {
    throw new PositionReconciliationError(
      'position-side-db-mismatch',
      '平盘对账侧库 generation 超出安全范围'
    );
  }
  return generation;
}

function normalizeCheckpoint(value, label = 'checkpoint') {
  if (value === null || value === undefined || value === '') return null;
  let payload = value;
  if (typeof value === 'string') {
    try {
      payload = JSON.parse(value);
    } catch (_error) {
      throw new PositionReconciliationError(
        'position-side-db-mismatch',
        `主库中的平盘侧库 ${label} 损坏，请恢复完整软件数据目录`
      );
    }
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new PositionReconciliationError(
      'position-side-db-mismatch',
      `主库中的平盘侧库 ${label} 格式非法，请恢复完整软件数据目录`
    );
  }
  return {
    identity: checkpointValue(payload.identity, 'identity'),
    generation: checkpointGeneration(payload.generation),
    token: checkpointValue(payload.token, 'checkpoint token')
  };
}

function checkpointsEqual(left, right) {
  return Boolean(left && right)
    && left.identity === right.identity
    && left.generation === right.generation
    && left.token === right.token;
}

function normalizePendingOperation(value) {
  if (value === null || value === undefined || value === '') return null;
  let payload = value;
  if (typeof value === 'string') {
    try {
      payload = JSON.parse(value);
    } catch (_error) {
      throw new PositionReconciliationError(
        'position-side-db-mismatch',
        '主库中的平盘侧库待完成操作记录损坏，请恢复完整软件数据目录'
      );
    }
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new PositionReconciliationError(
      'position-side-db-mismatch',
      '主库中的平盘侧库待完成操作记录格式非法，请恢复完整软件数据目录'
    );
  }
  return {
    operationToken: checkpointValue(payload.operationToken, 'operation token'),
    baseCheckpoint: normalizeCheckpoint(payload.baseCheckpoint, '待完成操作基准 checkpoint')
  };
}

function readDatabaseCheckpoint(db) {
  const rows = db.prepare(`
    SELECT key, value
    FROM position_meta
    WHERE key IN (?, ?, ?)
  `).all(
    POSITION_DB_IDENTITY_KEY,
    POSITION_DB_GENERATION_KEY,
    POSITION_DB_CHECKPOINT_TOKEN_KEY
  );
  const values = new Map(rows.map((row) => [row.key, row.value]));
  if (values.size !== 3) return null;
  return normalizeCheckpoint({
    identity: values.get(POSITION_DB_IDENTITY_KEY),
    generation: values.get(POSITION_DB_GENERATION_KEY),
    token: values.get(POSITION_DB_CHECKPOINT_TOKEN_KEY)
  }, 'checkpoint');
}

function checkpointMismatch(actual, expected, reason) {
  throw new PositionReconciliationError(
    'position-side-db-mismatch',
    '平盘对账主库与侧库不属于同一数据代次，已停止读取以避免历史消费关系回退',
    [
      ...(expected ? [`主库 checkpoint：generation=${expected.generation}`] : []),
      `侧库 checkpoint：generation=${actual.generation}`,
      reason,
      '请退出软件后恢复同一备份批次中的完整软件数据目录，再重新打开'
    ]
  );
}

function assertCurrentCheckpointHistory(db, actual) {
  const row = db.prepare(`
    SELECT token
    FROM position_checkpoint_history
    WHERE generation = ?
  `).get(actual.generation);
  if (!row || text(row.token) !== actual.token) {
    checkpointMismatch(actual, null, '侧库当前 checkpoint 缺少对应历史记录');
  }
}

function assertCheckpointCompatible(db, actual, expected, pendingOperation = null) {
  assertCurrentCheckpointHistory(db, actual);
  if (!expected) return;
  if (actual.identity !== expected.identity) {
    checkpointMismatch(actual, expected, '主库与侧库的实例身份不同');
  }
  if (actual.generation < expected.generation) {
    checkpointMismatch(actual, expected, '侧库 generation 早于主库');
  }
  if (actual.generation === expected.generation) {
    if (actual.token !== expected.token) {
      checkpointMismatch(actual, expected, '同一 generation 的事务 token 不同');
    }
    return;
  }
  if (!pendingOperation) {
    checkpointMismatch(actual, expected, '侧库领先主库，但主库没有对应的待完成操作记录');
  }
  if (!checkpointsEqual(pendingOperation.baseCheckpoint, expected)) {
    checkpointMismatch(actual, expected, '待完成操作的基准 checkpoint 与主库当前 checkpoint 不一致');
  }

  const history = db.prepare(`
    SELECT generation, token, parent_token AS parentToken, operation_token AS operationToken
    FROM position_checkpoint_history
    WHERE generation BETWEEN ? AND ?
    ORDER BY generation ASC
  `).all(expected.generation, actual.generation);
  const expectedLength = actual.generation - expected.generation + 1;
  if (history.length !== expectedLength) {
    checkpointMismatch(actual, expected, '侧库领先主库，但 checkpoint 历史链不完整');
  }
  let previousToken = expected.token;
  for (let index = 0; index < history.length; index += 1) {
    const item = history[index];
    const generation = Number(item.generation);
    if (generation !== expected.generation + index) {
      checkpointMismatch(actual, expected, '侧库领先主库，但 checkpoint generation 不连续');
    }
    if (index === 0) {
      if (text(item.token) !== expected.token) {
        checkpointMismatch(actual, expected, '主库 checkpoint 不在当前侧库的历史链上');
      }
    } else if (text(item.parentToken) !== previousToken) {
      checkpointMismatch(actual, expected, '侧库领先主库，但 checkpoint 父链不连续');
    }
    if (index > 0 && text(item.operationToken) !== pendingOperation.operationToken) {
      checkpointMismatch(actual, expected, '侧库领先提交不属于主库登记的待完成操作');
    }
    previousToken = text(item.token);
  }
  if (previousToken !== actual.token) {
    checkpointMismatch(actual, expected, '侧库当前 token 与 checkpoint 历史链末端不一致');
  }
}

function placeholders(values) {
  return values.map(() => '?').join(', ');
}

function scopeKey(channel, monthKey) {
  return `${text(channel)}\u0000${text(monthKey)}`;
}

function decodeScopeKey(value) {
  const [channel = '', monthKey = ''] = String(value || '').split('\u0000');
  return { channel, monthKey };
}

function assertPayloadFields(payload, requiredFields, label) {
  const missing = requiredFields.filter((field) => (
    !Object.prototype.hasOwnProperty.call(payload, field)
  ));
  if (missing.length > 0) {
    throw new PositionReconciliationError(
      'position-side-data-invalid',
      `平盘侧库${label}缺少必填字段`,
      missing.slice(0, 20)
    );
  }
  return payload;
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function throwInvalidSideData(message, detailLines = []) {
  throw new PositionReconciliationError('position-side-data-invalid', message, detailLines);
}

function assertStoredTextList(value, label, { allowEmpty = false } = {}) {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) {
    throwInvalidSideData(`平盘侧库${label}必须为${allowEmpty ? '' : '非空'}数组`);
  }
  const normalized = value.map((item) => (
    typeof item === 'string' && item === text(item) ? item : ''
  ));
  if (normalized.some((item) => !item) || new Set(normalized).size !== normalized.length) {
    throwInvalidSideData(`平盘侧库${label}包含空值、重复值或未规范化文本`);
  }
  return normalized;
}

function assertStoredCounter(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throwInvalidSideData(`平盘侧库${label}必须为非负整数`);
  }
  return value;
}

function assertRevisionMap(value, label, { allowedKeys = null, allowEmpty = true } = {}) {
  if (!isPlainObject(value)) {
    throwInvalidSideData(`平盘侧库${label}必须为对象`);
  }
  const entries = Object.entries(value);
  if (!allowEmpty && entries.length === 0) {
    throwInvalidSideData(`平盘侧库${label}不得为空`);
  }
  for (const [key, revision] of entries) {
    if (!key || (allowedKeys && !allowedKeys.has(key))) {
      throwInvalidSideData(`平盘侧库${label}包含未知键：${key || '(空)'}`);
    }
    assertStoredCounter(revision, `${label}.${key}`);
  }
  return value;
}

function assertRunScope(payload, label) {
  if (!isPlainObject(payload)) {
    throwInvalidSideData(`平盘侧库${label}必须为对象`);
  }
  assertPayloadFields(payload, ['channels', 'months', 'scopes'], label);
  const channels = assertStoredTextList(payload.channels, `${label}.channels`);
  const months = assertStoredTextList(payload.months, `${label}.months`);
  const scopes = assertStoredTextList(payload.scopes, `${label}.scopes`);
  if (months.some((month) => !/^\d{4}-\d{2}$/.test(month))) {
    throwInvalidSideData(`平盘侧库${label}.months包含无效月份`);
  }
  const channelSet = new Set(channels);
  const monthSet = new Set(months);
  for (const key of scopes) {
    const decoded = decodeScopeKey(key);
    if (
      !decoded.channel
      || !decoded.monthKey
      || !channelSet.has(decoded.channel)
      || !monthSet.has(decoded.monthKey)
      || scopeKey(decoded.channel, decoded.monthKey) !== key
    ) {
      throwInvalidSideData(`平盘侧库${label}.scopes包含无效范围：${key}`);
    }
  }
  assertSameTextSet(
    scopes.map((key) => decodeScopeKey(key).channel),
    channels,
    `${label}.channels`
  );
  assertSameTextSet(
    scopes.map((key) => decodeScopeKey(key).monthKey),
    months,
    `${label}.months`
  );
  return payload;
}

function assertRunSnapshot(payload, label) {
  if (!isPlainObject(payload)) {
    throwInvalidSideData(`平盘侧库${label}必须为对象`);
  }
  assertPayloadFields(
    payload,
    ['rulesetVersion', 'bankScopes', 'bankGlobal', 'sources', 'mapping'],
    label
  );
  assertStoredCounter(payload.rulesetVersion, `${label}.rulesetVersion`);
  assertRevisionMap(payload.bankScopes, `${label}.bankScopes`, { allowEmpty: false });
  assertStoredCounter(payload.bankGlobal, `${label}.bankGlobal`);
  assertRevisionMap(payload.sources, `${label}.sources`, {
    allowedKeys: new Set(Object.values(SOURCE_TYPES))
  });
  if (payload.mapping !== null) {
    assertStoredCounter(payload.mapping, `${label}.mapping`);
  }
  return payload;
}

function assertRunSummary(payload, label) {
  if (!isPlainObject(payload)) {
    throwInvalidSideData(`平盘侧库${label}必须为对象`);
  }
  const counters = [
    'inputRows',
    'changedRows',
    'differenceRows',
    'preciseRows',
    'fuzzyRows',
    'notApplicableRows',
    'manualModifiedRows'
  ];
  assertPayloadFields(payload, [...counters, 'sourceTypes', 'engine'], label);
  counters.forEach((key) => assertStoredCounter(payload[key], `${label}.${key}`));
  assertStoredTextList(payload.sourceTypes, `${label}.sourceTypes`, { allowEmpty: true });
  if (
    payload.sourceTypes.some((sourceType) => !Object.values(SOURCE_TYPES).includes(sourceType))
  ) {
    throwInvalidSideData(`平盘侧库${label}.sourceTypes包含未知来源`);
  }
  if (!isPlainObject(payload.engine)) {
    throwInvalidSideData(`平盘侧库${label}.engine必须为对象`);
  }
  const engineCounters = [
    'total',
    'matched',
    'changed',
    'differences',
    'notApplicable',
    'confirmedConsumptionConflicts'
  ];
  assertPayloadFields(payload.engine, engineCounters, `${label}.engine`);
  engineCounters.forEach(
    (key) => assertStoredCounter(payload.engine[key], `${label}.engine.${key}`)
  );
  if (
    payload.changedRows > payload.inputRows
    || payload.differenceRows > payload.inputRows
    || payload.preciseRows > payload.inputRows
    || payload.fuzzyRows > payload.inputRows
    || payload.notApplicableRows > payload.inputRows
    || payload.manualModifiedRows > payload.inputRows
  ) {
    throwInvalidSideData(`平盘侧库${label}计数超过输入行数`);
  }
  return payload;
}

function assertSameTextSet(actualValues, expectedValues, label) {
  const actual = new Set(actualValues);
  const expected = new Set(expectedValues);
  if (
    actual.size !== expected.size
    || [...actual].some((value) => !expected.has(value))
  ) {
    throwInvalidSideData(`平盘侧库${label}与运行数据不一致`);
  }
}

function sameStoredValue(left, right) {
  return stableHash(left) === stableHash(right);
}

function assertRunRowContract(row, originalRow, resultRow, lineage) {
  const label = `运行 ID=${row.run_id}，BizId=${row.biz_id}`;
  if (text(originalRow.FundType) !== text(row.original_fund_type)) {
    throwInvalidSideData(`平盘侧库${label}原始 FundType 与运行索引不一致`);
  }
  if (text(resultRow.FundType) !== text(row.result_fund_type)) {
    throwInvalidSideData(`平盘侧库${label}结果 FundType 与运行索引不一致`);
  }
  for (const field of BANK_STATEMENT_FIELDS) {
    if (field === 'FundType') continue;
    if (!sameStoredValue(originalRow[field], resultRow[field])) {
      throwInvalidSideData(`平盘侧库${label}结果行修改了非 FundType 字段：${field}`);
    }
  }

  const changed = Number(row.changed) === 1;
  const manualModified = Number(row.manual_modified) === 1;
  const consumesSource = Number(row.consumes_source) === 1;
  if (![0, 1].includes(Number(row.changed))
      || ![0, 1].includes(Number(row.manual_modified))
      || ![0, 1].includes(Number(row.consumes_source))) {
    throwInvalidSideData(`平盘侧库${label}布尔标记非法`);
  }
  if (changed !== (text(row.original_fund_type) !== text(row.result_fund_type))) {
    throwInvalidSideData(`平盘侧库${label} changed 与 FundType 变化不一致`);
  }
  if (!['matched', 'difference', 'not-applicable'].includes(text(row.outcome))) {
    throwInvalidSideData(`平盘侧库${label}结果去向非法`);
  }
  if (manualModified && (row.outcome !== 'difference' || text(row.hit_type) !== MATCH_TYPES.USER_MODIFIED)) {
    throwInvalidSideData(`平盘侧库${label}人工修改标记与结果去向不一致`);
  }
  if (!manualModified && text(row.hit_type) === MATCH_TYPES.USER_MODIFIED) {
    throwInvalidSideData(`平盘侧库${label}人工修改命中类型缺少对应标记`);
  }
  if (row.outcome === 'not-applicable') {
    if (text(row.hit_type) !== MATCH_TYPES.NOT_APPLICABLE || changed || consumesSource) {
      throwInvalidSideData(`平盘侧库${label}不适用行契约不一致`);
    }
  }
  const sourceType = text(lineage.sourceType);
  const expectedSourceType = sourceTypeForFundType(row.original_fund_type);
  if (row.outcome !== 'not-applicable' && sourceType !== expectedSourceType) {
    throwInvalidSideData(`平盘侧库${label}来源类型与原始 FundType 不一致`);
  }
  if (row.outcome === 'matched') {
    const expectedConsumption = sourceType !== SOURCE_TYPES.BANK_ACCOUNT;
    if (consumesSource !== expectedConsumption) {
      throwInvalidSideData(`平盘侧库${label}来源消费标记与匹配类型不一致`);
    }
  } else if (consumesSource && (!manualModified || sourceType === SOURCE_TYPES.BANK_ACCOUNT)) {
    throwInvalidSideData(`平盘侧库${label}差异行不得声明新的来源消费关系`);
  }

  const expectedIntegrityHash = runRowIntegrityHash({
    runId: row.run_id,
    bizId: row.biz_id,
    channel: row.channel,
    monthKey: row.month_key,
    sourceOrder: row.source_order,
    originalFundType: row.original_fund_type,
    resultFundType: row.result_fund_type,
    hitSummary: row.hit_summary,
    hitType: row.hit_type,
    matchDetail: row.match_detail,
    outcome: row.outcome,
    changed,
    manualModified,
    consumesSource,
    originalRow,
    resultRow,
    lineage
  });
  if (text(row.integrity_hash) !== expectedIntegrityHash) {
    throwInvalidSideData(`平盘侧库${label}运行行完整性校验失败`);
  }
}

function assertRunDifferenceSet(db, run, envelopeRows) {
  const expectedRows = envelopeRows.filter((row) => row.outcome === 'difference');
  const differences = db.prepare(`
    SELECT *
    FROM position_differences
    WHERE run_id = ?
    ORDER BY id
  `).all(run.id);
  assertSameTextSet(
    differences.map((row) => text(row.biz_id)),
    expectedRows.map((row) => text(row.biz_id)),
    `运行 ID=${run.id}差异行集合`
  );
  const expectedByBizId = new Map(expectedRows.map((row) => [text(row.biz_id), row]));
  for (const difference of differences) {
    const expected = expectedByBizId.get(text(difference.biz_id));
    if (
      text(difference.channel) !== text(expected.channel)
      || text(difference.month_key) !== text(expected.month_key)
      || String(difference.reason || '') !== String(expected.match_detail || '')
      || !sameStoredValue(
        parseJson(difference.lineage_json, `差异血缘 ${run.id}/${difference.biz_id}`),
        parseJson(expected.lineage_json, `运行血缘 ${run.id}/${expected.biz_id}`)
      )
    ) {
      throwInvalidSideData(`平盘侧库运行 ID=${run.id}差异行与运行明细不一致`);
    }
    const expectedStatus = run.status === 'confirmed'
      ? (Number(expected.manual_modified) === 1
          ? DIFFERENCE_STATUSES.MODIFIED
          : DIFFERENCE_STATUSES.ACCEPTED)
      : DIFFERENCE_STATUSES.PENDING;
    if (text(difference.status) !== expectedStatus) {
      throwInvalidSideData(`平盘侧库运行 ID=${run.id}差异状态与运行状态不一致`);
    }
  }
}

function consumptionRelationKey({
  sourceType,
  businessKey,
  legIndex,
  bankBizId
}) {
  return JSON.stringify([
    text(sourceType),
    text(businessKey),
    Number(legIndex),
    text(bankBizId)
  ]);
}

function assertConsumptionOwner(db, currentRun, consumption, ownerCache) {
  const ownerRunId = Number(consumption.runId);
  if (!Number.isSafeInteger(ownerRunId) || ownerRunId > Number(currentRun.id)) {
    throwInvalidSideData(`平盘侧库运行 ID=${currentRun.id}的来源消费关系指向非法运行`);
  }
  let owner = ownerCache.get(ownerRunId);
  if (!owner) {
    const ownerRun = db.prepare(
      'SELECT id, status FROM position_runs WHERE id = ?'
    ).get(ownerRunId);
    const rows = ownerRun ? db.prepare(`
      SELECT *
      FROM position_run_rows
      WHERE run_id = ? AND consumes_source = 1
    `).all(ownerRunId) : [];
    owner = {
      run: ownerRun,
      rowsByBizId: new Map(rows.map((row) => [text(row.biz_id), row]))
    };
    ownerCache.set(ownerRunId, owner);
  }
  const ownerRun = owner.run;
  if (!ownerRun || text(ownerRun.status) !== 'confirmed') {
    throwInvalidSideData(`平盘侧库来源消费关系 owner 运行 ID=${ownerRunId}未确认或不存在`);
  }
  const ownerRow = owner.rowsByBizId.get(text(consumption.bankBizId));
  if (!ownerRow) {
    throwInvalidSideData(`平盘侧库来源消费关系 owner 运行 ID=${ownerRunId}缺少对应运行血缘`);
  }
  const originalRow = assertBankPayload(
    parseJson(
      ownerRow.original_json,
      `来源消费 owner 原始行 ${ownerRunId}/${ownerRow.biz_id}`
    ),
    ownerRow,
    `来源消费 owner 原始行 ${ownerRunId}/${ownerRow.biz_id}`
  );
  const resultRow = assertBankPayload(
    parseJson(
      ownerRow.result_json,
      `来源消费 owner 结果行 ${ownerRunId}/${ownerRow.biz_id}`
    ),
    ownerRow,
    `来源消费 owner 结果行 ${ownerRunId}/${ownerRow.biz_id}`
  );
  const lineage = assertRunLineage(
    parseJson(
      ownerRow.lineage_json,
      `来源消费 owner 血缘 ${ownerRunId}/${ownerRow.biz_id}`
    ),
    ownerRow
  );
  assertRunRowContract(ownerRow, originalRow, resultRow, lineage);
  const ownerRelation = {
    sourceType: lineage.sourceType,
    businessKey: lineage.sourceBusinessKey,
    legIndex: lineage.sourceLegIndex,
    bankBizId: ownerRow.biz_id
  };
  if (consumptionRelationKey(ownerRelation) !== consumptionRelationKey(consumption)) {
    throwInvalidSideData(`平盘侧库来源消费关系 owner 运行 ID=${ownerRunId}的血缘不匹配`);
  }
}

function assertRunConsumptionSet(db, run, expectedConsumptions) {
  const ownedConsumptions = db.prepare(`
    SELECT run_id AS runId, source_type AS sourceType, business_key AS businessKey,
           leg_index AS legIndex, bank_biz_id AS bankBizId
    FROM position_consumed_sources
    WHERE run_id = ?
    ORDER BY id
  `).all(run.id);
  if (run.status !== 'confirmed') {
    if (ownedConsumptions.length > 0) {
      throwInvalidSideData(`平盘侧库未确认运行 ID=${run.id}存在来源消费关系`);
    }
    return;
  }

  const expectedKeys = new Set(expectedConsumptions.map(consumptionRelationKey));
  for (const owned of ownedConsumptions) {
    if (!expectedKeys.has(consumptionRelationKey(owned))) {
      throwInvalidSideData(`平盘侧库运行 ID=${run.id}持有不属于该运行的来源消费关系`);
    }
  }

  const findConsumption = db.prepare(`
    SELECT run_id AS runId, source_type AS sourceType, business_key AS businessKey,
           leg_index AS legIndex, bank_biz_id AS bankBizId
    FROM position_consumed_sources
    WHERE source_type = ? AND business_key = ? AND leg_index = ?
  `);
  const ownerCache = new Map();
  for (const expected of expectedConsumptions) {
    const actual = findConsumption.get(
      text(expected.sourceType),
      text(expected.businessKey),
      Number(expected.legIndex)
    );
    if (
      !actual
      || consumptionRelationKey(actual) !== consumptionRelationKey(expected)
      || !Number.isSafeInteger(Number(actual.runId))
      || Number(actual.runId) > Number(run.id)
    ) {
      throwInvalidSideData(`平盘侧库运行 ID=${run.id}缺少对应的来源消费关系`);
    }
    assertConsumptionOwner(db, run, actual, ownerCache);
  }
}

function assertRunEnvelope(db, run, scope, snapshot, summary) {
  const runLabel = `运行 ID=${run.id}`;
  const envelopeRows = db.prepare(`
    SELECT *
    FROM position_run_rows
    WHERE run_id = ?
    ORDER BY id
  `).all(run.id);
  const derivedSourceTypes = [];
  const expectedConsumptions = [];
  let confirmedConsumptionConflicts = 0;
  for (const row of envelopeRows) {
    const originalRow = assertBankPayload(
      parseJson(row.original_json, `${runLabel}原始行 BizId=${row.biz_id}`),
      row,
      `${runLabel}原始行 BizId=${row.biz_id}`
    );
    if (text(originalRow.FundType) !== text(row.original_fund_type)) {
      throwInvalidSideData(`平盘侧库${runLabel}原始 FundType 与运行明细不一致`);
    }
    const resultRow = assertBankPayload(
      parseJson(row.result_json, `${runLabel}结果行 BizId=${row.biz_id}`),
      row,
      `${runLabel}结果行 BizId=${row.biz_id}`
    );
    const sourceType = sourceTypeForFundType(originalRow.FundType);
    if (sourceType) derivedSourceTypes.push(sourceType);
    const lineage = assertRunLineage(
      parseJson(row.lineage_json, `${runLabel}血缘 BizId=${row.biz_id}`),
      row
    );
    assertRunRowContract(row, originalRow, resultRow, lineage);
    if (Number(row.consumes_source) === 1) {
      expectedConsumptions.push({
        runId: run.id,
        sourceType: lineage.sourceType,
        businessKey: lineage.sourceBusinessKey,
        legIndex: lineage.sourceLegIndex,
        bankBizId: row.biz_id
      });
    }
    if (lineage.reasonCode === 'position-bank-counterparty-reassigned') {
      confirmedConsumptionConflicts += 1;
    }
  }
  assertRunDifferenceSet(db, run, envelopeRows);
  assertRunConsumptionSet(db, run, expectedConsumptions);
  assertSameTextSet(
    Object.keys(snapshot.bankScopes),
    scope.scopes,
    `${runLabel}快照银行范围`
  );
  assertSameTextSet(
    Object.keys(snapshot.sources),
    derivedSourceTypes,
    `${runLabel}快照来源`
  );
  assertSameTextSet(
    summary.sourceTypes,
    derivedSourceTypes,
    `${runLabel}汇总来源`
  );
  const usesTransfer = derivedSourceTypes.includes(SOURCE_TYPES.FUND_TRANSFER);
  if ((usesTransfer && snapshot.mapping === null) || (!usesTransfer && snapshot.mapping !== null)) {
    throwInvalidSideData(`平盘侧库${runLabel}映射快照与来源类型不一致`);
  }

  const aggregate = db.prepare(`
    SELECT COUNT(*) AS inputRows,
           SUM(CASE WHEN changed = 1 THEN 1 ELSE 0 END) AS changedRows,
           SUM(CASE WHEN manual_modified = 1 THEN 1 ELSE 0 END) AS manualModifiedRows,
           SUM(CASE WHEN hit_type = ? THEN 1 ELSE 0 END) AS preciseRows,
           SUM(CASE WHEN hit_type = ? THEN 1 ELSE 0 END) AS fuzzyRows,
           SUM(CASE WHEN hit_type = ? THEN 1 ELSE 0 END) AS notApplicableRows,
           SUM(CASE WHEN outcome = 'matched' THEN 1 ELSE 0 END) AS matchedRows
    FROM position_run_rows
    WHERE run_id = ?
  `).get(
    MATCH_TYPES.PRECISE,
    MATCH_TYPES.FUZZY,
    MATCH_TYPES.NOT_APPLICABLE,
    run.id
  );
  const difference = db.prepare(
    'SELECT COUNT(*) AS count FROM position_differences WHERE run_id = ?'
  ).get(run.id);
  const actual = {
    inputRows: Number(aggregate.inputRows) || 0,
    changedRows: Number(aggregate.changedRows) || 0,
    manualModifiedRows: Number(aggregate.manualModifiedRows) || 0,
    preciseRows: Number(aggregate.preciseRows) || 0,
    fuzzyRows: Number(aggregate.fuzzyRows) || 0,
    notApplicableRows: Number(aggregate.notApplicableRows) || 0,
    matchedRows: Number(aggregate.matchedRows) || 0,
    differenceRows: Number(difference.count) || 0
  };
  if (actual.inputRows === 0) {
    throwInvalidSideData(`平盘侧库${runLabel}没有运行明细`);
  }
  for (const key of [
    'inputRows',
    'changedRows',
    'differenceRows',
    'preciseRows',
    'fuzzyRows',
    'notApplicableRows'
  ]) {
    if (summary[key] !== actual[key]) {
      throwInvalidSideData(`平盘侧库${runLabel}汇总字段 ${key} 与运行明细不一致`);
    }
  }
  if (summary.manualModifiedRows !== actual.manualModifiedRows) {
    throwInvalidSideData(`平盘侧库${runLabel}汇总字段 manualModifiedRows 与运行明细不一致`);
  }
  for (const [key, expected] of [
    ['total', actual.inputRows],
    ['matched', actual.matchedRows],
    ['changed', actual.changedRows],
    ['differences', actual.differenceRows],
    ['notApplicable', actual.notApplicableRows]
  ]) {
    if (summary.engine[key] !== expected) {
      throwInvalidSideData(`平盘侧库${runLabel}引擎汇总字段 ${key} 与运行明细不一致`);
    }
  }
  if (summary.engine.confirmedConsumptionConflicts !== confirmedConsumptionConflicts) {
    throwInvalidSideData(
      `平盘侧库${runLabel}引擎汇总字段 confirmedConsumptionConflicts 与运行血缘不一致`
    );
  }

  const actualScopes = db.prepare(`
    SELECT DISTINCT channel, month_key AS monthKey
    FROM position_run_rows
    WHERE run_id = ?
  `).all(run.id).map((row) => scopeKey(row.channel, row.monthKey));
  assertSameTextSet(actualScopes, scope.scopes, `${runLabel}范围`);
}

function assertBankPayload(payload, row, label) {
  assertPayloadFields(payload, BANK_STATEMENT_FIELDS, label);
  if (text(payload.BizId) !== text(row.biz_id) || text(payload.Channel) !== text(row.channel)) {
    throw new PositionReconciliationError(
      'position-side-data-invalid',
      `平盘侧库${label}与索引字段不一致`,
      [
        `JSON BizId=${text(payload.BizId) || '(空)'}，索引 BizId=${text(row.biz_id) || '(空)'}`,
        `JSON Channel=${text(payload.Channel) || '(空)'}，索引 Channel=${text(row.channel) || '(空)'}`
      ]
    );
  }
  return payload;
}

function assertRunLineage(lineage, row) {
  if (!isPlainObject(lineage)) {
    throwInvalidSideData(`平盘侧库运行血缘必须为对象：run=${row.run_id}，BizId=${row.biz_id}`);
  }
  const sourceType = text(lineage.sourceType);
  if (row.outcome === 'not-applicable') {
    if (
      !Object.prototype.hasOwnProperty.call(lineage, 'pairKey')
      || !Object.prototype.hasOwnProperty.call(lineage, 'sourceType')
      || lineage.pairKey !== null
      || lineage.sourceType !== null
    ) {
      throw new PositionReconciliationError(
        'position-side-data-invalid',
        `平盘侧库不适用行血缘损坏：run=${row.run_id}，BizId=${row.biz_id}`
      );
    }
    return lineage;
  }
  const expectedSourceType = sourceTypeForFundType(row.original_fund_type);
  if (!expectedSourceType || sourceType !== expectedSourceType) {
    throw new PositionReconciliationError(
      'position-side-data-invalid',
      `平盘侧库运行来源与 FundType 不一致：run=${row.run_id}，BizId=${row.biz_id}`
    );
  }
  if (row.outcome === 'difference') {
    if (Number(row.consumes_source) === 1) {
      const linkRowId = Number(lineage.sourceLinkRowId);
      const legIndex = Number(lineage.sourceLegIndex);
      if (
        Number(row.manual_modified) !== 1
        || !Number.isSafeInteger(linkRowId)
        || linkRowId < 1
        || !text(lineage.sourceBusinessKey)
        || !Number.isInteger(legIndex)
        || legIndex < 0
      ) {
        throw new PositionReconciliationError(
          'position-side-data-invalid',
          `平盘侧库人工修改行缺少原匹配血缘：run=${row.run_id}，BizId=${row.biz_id}`
        );
      }
      return lineage;
    }
    if (
      (
        lineage.sourceLinkRowId !== null
        && lineage.sourceLinkRowId !== undefined
      )
      || text(lineage.sourceBusinessKey)
      || (
        lineage.sourceLegIndex !== null
        && lineage.sourceLegIndex !== undefined
        && lineage.sourceLegIndex !== ''
      )
    ) {
      throw new PositionReconciliationError(
        'position-side-data-invalid',
        `平盘侧库未解决差异行不得认领来源记录：run=${row.run_id}，BizId=${row.biz_id}`
      );
    }
    if (!text(lineage.reasonCode) || !Array.isArray(lineage.reasons)) {
      throw new PositionReconciliationError(
        'position-side-data-invalid',
        `平盘侧库运行血缘损坏：run=${row.run_id}，BizId=${row.biz_id}`
      );
    }
    return lineage;
  }
  if (row.outcome !== 'matched') {
    throw new PositionReconciliationError(
      'position-side-data-invalid',
      `平盘侧库运行结果去向无效：run=${row.run_id}，BizId=${row.biz_id}`
    );
  }
  if (!sourceType) {
    throw new PositionReconciliationError(
      'position-side-data-invalid',
      `平盘侧库匹配血缘缺少来源类型：run=${row.run_id}，BizId=${row.biz_id}`
    );
  }
  const linkRowId = Number(lineage.sourceLinkRowId);
  const legIndex = Number(lineage.sourceLegIndex);
  if (
    !Number.isSafeInteger(linkRowId)
    || linkRowId < 1
    || !text(lineage.sourceBusinessKey)
    || !Number.isInteger(legIndex)
    || legIndex < 0
  ) {
    throw new PositionReconciliationError(
      'position-side-data-invalid',
      `平盘侧库匹配血缘缺少来源主键：run=${row.run_id}，BizId=${row.biz_id}`
    );
  }
  return lineage;
}

function assertCurrentRunReferences(db, runId) {
  const rows = db.prepare(`
    SELECT *
    FROM position_run_rows
    WHERE run_id = ?
    ORDER BY id
  `).all(runId);
  const getBank = db.prepare('SELECT * FROM position_bank_rows WHERE biz_id = ?');
  const getLink = db.prepare('SELECT * FROM position_link_rows WHERE id = ?');
  for (const row of rows) {
    const originalRow = parseJson(
      row.original_json,
      `运行原始行 ${runId}/${row.biz_id}`
    );
    const bank = getBank.get(row.biz_id);
    if (!bank) {
      throwInvalidSideData(`平盘侧库运行 ${runId} 的银行 BizId 已不存在：${row.biz_id}`);
    }
    const bankOriginal = parseJson(
      bank.original_json,
      `银行原始行 ${row.biz_id}`
    );
    const bankWorking = parseJson(
      bank.working_json,
      `银行工作行 ${row.biz_id}`
    );
    if (
      text(bank.channel) !== text(row.channel)
      || text(bank.month_key) !== text(row.month_key)
      || Number(bank.import_order) !== Number(row.source_order)
      || text(bank.status) !== BANK_STATUSES.UNPROCESSED
      || text(bank.working_fund_type) !== text(row.original_fund_type)
      || !sameStoredValue(bankOriginal, originalRow)
      || !sameStoredValue(bankWorking, originalRow)
    ) {
      throwInvalidSideData(`平盘侧库运行 ${runId} 与当前银行工作行不一致：${row.biz_id}`);
    }

    const lineage = parseJson(row.lineage_json, `运行血缘 ${runId}/${row.biz_id}`);
    const needsLink = row.outcome === 'matched' || Number(row.consumes_source) === 1;
    if (!needsLink) continue;
    const linkRowId = Number(lineage.sourceLinkRowId);
    const link = getLink.get(linkRowId);
    if (
      !link
      || text(link.source_type) !== text(lineage.sourceType)
      || text(link.business_key) !== text(lineage.sourceBusinessKey)
      || Number(link.leg_index) !== Number(lineage.sourceLegIndex)
      || Number(link.source_row_number) !== Number(lineage.sourceRowNumber)
    ) {
      throwInvalidSideData(
        `平盘侧库运行 ${runId} 的来源血缘无法定位到唯一链接记录：${row.biz_id}`
      );
    }
  }
}

class PositionReconciliationStore {
  constructor(userDataDir, {
    requireExisting = false,
    expectedCheckpoint = null,
    expectedPendingOperation = null,
    initialCheckpoint = null,
    operationTokenProvider = null
  } = {}) {
    this.userDataDir = path.resolve(userDataDir);
    this.dbPath = path.join(this.userDataDir, POSITION_DB_RELATIVE_PATH);
    this.db = null;
    this.initializationMode = null;
    this.operationTokenProvider = typeof operationTokenProvider === 'function'
      ? operationTokenProvider
      : null;
    const expected = normalizeCheckpoint(expectedCheckpoint, 'checkpoint');
    const initial = normalizeCheckpoint(initialCheckpoint, '首次绑定 checkpoint');
    const pendingOperation = normalizePendingOperation(expectedPendingOperation);
    if (expected && initial) {
      throw new PositionReconciliationError(
        'position-side-db-mismatch',
        '主库中的平盘侧库 checkpoint 与首次绑定记录不能同时存在'
      );
    }
    const databaseExisted = fs.existsSync(this.dbPath);
    const mustExist = requireExisting || expected !== null;
    if (mustExist && !databaseExisted) {
      throw new PositionReconciliationError(
        'position-side-db-missing',
        '平盘对账侧库缺失，已停止创建空库以避免历史消费关系丢失',
        [
          `缺失文件：${this.dbPath}`,
          '请退出软件后恢复同一备份批次中的完整软件数据目录，再重新打开'
        ]
      );
    }
    if (databaseExisted && !expected && !initial) {
      throw new PositionReconciliationError(
        'position-side-db-mismatch',
        '主库没有平盘侧库绑定记录，但磁盘上已存在侧库，已停止接管以避免跨备份混用',
        [
          `已有文件：${this.dbPath}`,
          '请退出软件后恢复同一备份批次中的完整软件数据目录，再重新打开'
        ]
      );
    }
    fs.mkdirSync(path.dirname(this.dbPath), { recursive: true });
    let guardedInitializationTransaction = false;
    try {
      this.db = new DatabaseSync(this.dbPath);
      let existingCheckpoint = null;
      let emptyLegacyBootstrap = false;
      if (databaseExisted) {
        const hasMetaTable = this.db.prepare(`
          SELECT 1 AS present
          FROM sqlite_master
          WHERE type = 'table' AND name = 'position_meta'
        `).get();
        existingCheckpoint = hasMetaTable ? readDatabaseCheckpoint(this.db) : null;
        const hasHistoryTable = this.db.prepare(`
          SELECT 1 AS present
          FROM sqlite_master
          WHERE type = 'table' AND name = 'position_checkpoint_history'
        `).get();
        if (!existingCheckpoint || !hasHistoryTable) {
          const canBootstrapEmptyLegacy = !existingCheckpoint
            && !hasHistoryTable
            && !expected
            && !pendingOperation
            && initial
            && initial.generation === 0;
          if (!canBootstrapEmptyLegacy) {
            throw incompleteSideDatabaseError(this.dbPath);
          }
          assertSupportedEmptyLegacyDatabase(this.db, this.dbPath);
          emptyLegacyBootstrap = true;
        }
        if (existingCheckpoint) {
          const historyRow = this.db.prepare(`
            SELECT token
            FROM position_checkpoint_history
            WHERE generation = ?
          `).get(existingCheckpoint.generation);
          if (!historyRow || text(historyRow.token) !== existingCheckpoint.token) {
            checkpointMismatch(existingCheckpoint, expected || initial, '侧库当前 checkpoint 历史缺失');
          }
          if (!expected && initial && !checkpointsEqual(existingCheckpoint, initial)) {
            checkpointMismatch(existingCheckpoint, initial, '侧库与主库首次绑定 checkpoint 不一致');
          }
        }
      }
      this.db.exec('PRAGMA foreign_keys = ON;');
      this.db.exec('PRAGMA synchronous = NORMAL;');
      this.db.exec('PRAGMA busy_timeout = 30000;');
      if (!databaseExisted || emptyLegacyBootstrap) {
        this.db.exec('BEGIN IMMEDIATE');
        guardedInitializationTransaction = true;
        if (emptyLegacyBootstrap) {
          assertSupportedEmptyLegacyDatabase(this.db, this.dbPath);
        } else {
          assertNewDatabaseHasNoUserSchema(this.db, this.dbPath);
        }
      } else {
        this.db.exec('PRAGMA journal_mode = WAL;');
      }
      this.db.exec(SCHEMA);
      const checkpointHistoryColumns = this.db.prepare(
        'PRAGMA table_info(position_checkpoint_history)'
      ).all();
      if (!checkpointHistoryColumns.some((column) => column.name === 'operation_token')) {
        this.db.exec('ALTER TABLE position_checkpoint_history ADD COLUMN operation_token TEXT;');
      }
      const runRowColumns = this.db.prepare('PRAGMA table_info(position_run_rows)').all();
      const missingRunRowColumns = [
        ['consumes_source', "ALTER TABLE position_run_rows ADD COLUMN consumes_source INTEGER NOT NULL DEFAULT 0"],
        ['integrity_hash', "ALTER TABLE position_run_rows ADD COLUMN integrity_hash TEXT NOT NULL DEFAULT ''"]
      ].filter(([name]) => !runRowColumns.some((column) => column.name === name));
      if (missingRunRowColumns.length > 0) {
        const existingRunRows = Number(
          this.db.prepare('SELECT COUNT(*) AS count FROM position_run_rows').get().count
        );
        if (existingRunRows > 0) {
          throw new PositionReconciliationError(
            'position-side-data-invalid',
            '旧版平盘运行草稿缺少完整性锚点，禁止自动接管',
            ['请删除未正式发布版本的平盘侧库后重新导入，或恢复完整软件数据目录']
          );
        }
        for (const [, statement] of missingRunRowColumns) this.db.exec(statement);
      }
      const seedCheckpoint = existingCheckpoint || initial || {
        identity: crypto.randomUUID(),
        generation: 0,
        token: crypto.randomUUID()
      };
      this.db.prepare(`
        INSERT INTO position_meta(key, value) VALUES (?, ?)
        ON CONFLICT(key) DO NOTHING
      `).run(POSITION_DB_IDENTITY_KEY, seedCheckpoint.identity);
      this.db.prepare(`
        INSERT INTO position_meta(key, value) VALUES (?, ?)
        ON CONFLICT(key) DO NOTHING
      `).run(POSITION_DB_GENERATION_KEY, String(seedCheckpoint.generation));
      this.db.prepare(`
        INSERT INTO position_meta(key, value) VALUES (?, ?)
        ON CONFLICT(key) DO NOTHING
      `).run(POSITION_DB_CHECKPOINT_TOKEN_KEY, seedCheckpoint.token);
      const currentCheckpoint = readDatabaseCheckpoint(this.db);
      if (!currentCheckpoint) {
        throw new PositionReconciliationError(
          'position-side-db-missing',
          '平盘对账侧库 checkpoint 初始化失败'
        );
      }
      this.db.prepare(`
        INSERT INTO position_checkpoint_history(generation, token, parent_token, operation_token)
        VALUES (?, ?, NULL, NULL)
        ON CONFLICT(generation) DO NOTHING
      `).run(currentCheckpoint.generation, currentCheckpoint.token);
      assertCheckpointCompatible(
        this.db,
        currentCheckpoint,
        expected || initial,
        expected ? pendingOperation : null
      );
      if (guardedInitializationTransaction) {
        this.db.exec('COMMIT');
        guardedInitializationTransaction = false;
        // 被拒绝的新建候选/空旧库不得在 proof 前被持久切换日志模式。
        // 仅在锁内证明及 schema/checkpoint 事务成功后启用正式 WAL。
        this.db.exec('PRAGMA journal_mode = WAL;');
      }
      this.initializationMode = emptyLegacyBootstrap
        ? POSITION_DB_INITIALIZATION_MODES.EMPTY_LEGACY_UPGRADE
        : (
          databaseExisted
            ? POSITION_DB_INITIALIZATION_MODES.EXISTING
            : POSITION_DB_INITIALIZATION_MODES.NEW
        );
    } catch (error) {
      if (this.db) {
        if (guardedInitializationTransaction) {
          try {
            this.db.exec('ROLLBACK');
          } catch (_rollbackError) {
            // 保留原始初始化错误。
          }
          guardedInitializationTransaction = false;
        }
        try {
          this.db.close();
        } catch (_closeError) {
          // 保留原始打开或校验错误。
        }
        this.db = null;
      }
      if (error instanceof PositionReconciliationError) throw error;
      throw new PositionReconciliationError(
        'position-side-data-invalid',
        '平盘对账侧库无法打开或校验失败',
        [error && error.message ? error.message : String(error)]
      );
    }
  }

  close() {
    if (!this.db) return;
    this.db.close();
    this.db = null;
  }

  initializationResult() {
    return Object.freeze({ mode: this.initializationMode });
  }

  persistenceCheckpoint() {
    const checkpoint = readDatabaseCheckpoint(this.db);
    if (!checkpoint) {
      throw new PositionReconciliationError(
        'position-side-db-mismatch',
        '平盘对账侧库 checkpoint 缺失'
      );
    }
    return checkpoint;
  }

  _mutation(operation) {
    return transaction(this.db, () => {
      const currentCheckpoint = readDatabaseCheckpoint(this.db);
      if (!currentCheckpoint) {
        throw new PositionReconciliationError(
          'position-side-db-mismatch',
          '平盘对账侧库 checkpoint 缺失'
        );
      }
      assertCurrentCheckpointHistory(this.db, currentCheckpoint);
      const operationToken = text(
        this.operationTokenProvider ? this.operationTokenProvider() : ''
      ) || crypto.randomUUID();
      const result = operation({ operationToken });
      const nextGeneration = currentCheckpoint.generation + 1;
      if (!Number.isSafeInteger(nextGeneration)) {
        throw new PositionReconciliationError(
          'position-side-db-mismatch',
          '平盘对账侧库 generation 超出安全范围'
        );
      }
      const nextToken = crypto.randomUUID();
      const generationUpdate = this.db.prepare(`
        UPDATE position_meta
        SET value = ?
        WHERE key = ? AND value = ?
      `).run(
        String(nextGeneration),
        POSITION_DB_GENERATION_KEY,
        String(currentCheckpoint.generation)
      );
      const tokenUpdate = this.db.prepare(`
        UPDATE position_meta SET value = ? WHERE key = ? AND value = ?
      `).run(
        nextToken,
        POSITION_DB_CHECKPOINT_TOKEN_KEY,
        currentCheckpoint.token
      );
      const historyInsert = this.db.prepare(`
        INSERT INTO position_checkpoint_history(
          generation, token, parent_token, operation_token
        )
        VALUES (?, ?, ?, ?)
      `).run(nextGeneration, nextToken, currentCheckpoint.token, operationToken);
      if (Number(generationUpdate.changes) !== 1
          || Number(tokenUpdate.changes) !== 1
          || Number(historyInsert.changes) !== 1) {
        throw new PositionReconciliationError(
          'position-side-db-mismatch',
          '平盘对账侧库 checkpoint 更新失败'
        );
      }
      return result;
    });
  }

  _recordOperationInputs(operationToken, inputEvidence, fallbackSourceType = '') {
    const token = text(operationToken);
    if (!token) {
      throwInvalidSideData('平盘文件级提交凭证缺少 operation token');
    }
    const inputs = Array.isArray(inputEvidence) ? inputEvidence : [];
    if (inputs.length === 0) return [];
    const insert = this.db.prepare(`
      INSERT INTO position_operation_inputs(
        operation_token, input_key, source_type, role, file_path, original_name,
        sha256, size_bytes, source_snapshot_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(operation_token, input_key) DO NOTHING
    `);
    const find = this.db.prepare(`
      SELECT operation_token AS operationToken, input_key AS inputKey,
             source_type AS sourceType, role, file_path AS filePath,
             original_name AS originalName, sha256, size_bytes AS sizeBytes,
             source_snapshot_json AS sourceSnapshotJson
      FROM position_operation_inputs
      WHERE operation_token = ? AND input_key = ?
    `);
    const recorded = [];
    for (const value of inputs) {
      const normalized = normalizeOperationInputEvidence(value, fallbackSourceType);
      insert.run(
        token,
        normalized.inputKey,
        normalized.sourceType,
        normalized.role,
        normalized.filePath,
        normalized.originalName,
        normalized.sha256,
        normalized.sizeBytes,
        serializeJson(normalized.sourceSnapshot)
      );
      const stored = find.get(token, normalized.inputKey);
      if (!stored) throwInvalidSideData('平盘文件级提交凭证写入失败');
      const storedSnapshot = normalizeSourceSnapshot(
        parseJson(stored.sourceSnapshotJson, '文件级提交凭证快照')
      );
      const storedEvidence = {
        inputKey: text(stored.inputKey),
        sourceType: text(stored.sourceType),
        role: text(stored.role),
        filePath: path.resolve(String(stored.filePath || '')),
        originalName: text(stored.originalName),
        sourceSnapshot: storedSnapshot,
        sha256: text(stored.sha256).toLowerCase(),
        sizeBytes: Number(stored.sizeBytes)
      };
      if (!storedSnapshot
          || operationInputEvidenceHash(storedEvidence) !== operationInputEvidenceHash(normalized)) {
        throwInvalidSideData('平盘文件级提交凭证与既有记录冲突');
      }
      recorded.push(storedEvidence);
    }
    return recorded;
  }

  listCommittedOperationInputs(operationToken) {
    const token = text(operationToken);
    if (!token) return [];
    const rows = this.db.prepare(`
      SELECT operation_token AS operationToken, input_key AS inputKey,
             source_type AS sourceType, role, file_path AS filePath,
             original_name AS originalName, sha256, size_bytes AS sizeBytes,
             source_snapshot_json AS sourceSnapshotJson, committed_at AS committedAt
      FROM position_operation_inputs
      WHERE operation_token = ?
      ORDER BY committed_at, input_key
    `).all(token);
    return rows.map((row) => {
      const sourceSnapshot = normalizeSourceSnapshot(
        parseJson(row.sourceSnapshotJson, '文件级提交凭证快照')
      );
      const normalized = normalizeOperationInputEvidence({
        sourceType: row.sourceType,
        role: row.role,
        filePath: row.filePath,
        originalName: row.originalName,
        sourceSnapshot,
        sha256: row.sha256,
        sizeBytes: row.sizeBytes
      });
      if (text(row.inputKey) !== normalized.inputKey) {
        throwInvalidSideData('平盘文件级提交凭证的 input key 不一致');
      }
      return {
        operationToken: token,
        ...normalized,
        committedAt: text(row.committedAt)
      };
    });
  }

  getRevision(kind, key) {
    const row = this.db.prepare(
      'SELECT revision FROM position_revisions WHERE kind = ? AND scope_key = ?'
    ).get(kind, key);
    return row ? Number(row.revision) : 0;
  }

  bumpRevision(kind, key) {
    this.db.prepare(`
      INSERT INTO position_revisions(kind, scope_key, revision, updated_at)
      VALUES (?, ?, 1, CURRENT_TIMESTAMP)
      ON CONFLICT(kind, scope_key) DO UPDATE SET
        revision = position_revisions.revision + 1,
        updated_at = CURRENT_TIMESTAMP
    `).run(kind, key);
    return this.getRevision(kind, key);
  }

  currentSnapshot({ scopes = [], sourceTypes = [], includeMapping = false } = {}) {
    return {
      rulesetVersion: POSITION_RULESET_VERSION,
      bankScopes: Object.fromEntries(scopes.map((key) => [key, this.getRevision('bank', key)])),
      bankGlobal: this.getRevision('bank-global', 'all'),
      sources: Object.fromEntries(sourceTypes.map((type) => [type, this.getRevision('source', type)])),
      mapping: includeMapping ? this.getRevision('mapping', 'global') : null
    };
  }

  snapshotIsCurrent(snapshot) {
    assertRunSnapshot(snapshot, '运行快照');
    if (Number(snapshot.rulesetVersion) !== POSITION_RULESET_VERSION) return false;
    for (const [key, revision] of Object.entries(snapshot.bankScopes)) {
      if (this.getRevision('bank', key) !== Number(revision)) return false;
    }
    if (this.getRevision('bank-global', 'all') !== Number(snapshot.bankGlobal)) {
      return false;
    }
    for (const [type, revision] of Object.entries(snapshot.sources)) {
      if (this.getRevision('source', type) !== Number(revision)) return false;
    }
    if (snapshot.mapping !== null
        && this.getRevision('mapping', 'global') !== Number(snapshot.mapping)) {
      return false;
    }
    return true;
  }

  replaceBankScopes(parsed, { inputEvidence = [] } = {}) {
    const records = Array.isArray(parsed.records) ? parsed.records : [];
    const scopes = Array.isArray(parsed.scopes) ? parsed.scopes : [];
    return this._mutation(({ operationToken }) => {
      this._recordOperationInputs(operationToken, inputEvidence, 'position-bank');
      const existingByBizId = new Map(this.db.prepare(`
        SELECT biz_id AS bizId, channel, month_key AS monthKey
        FROM position_bank_rows
      `).all().map((row) => [row.bizId, row]));
      const conflicts = records.flatMap((record) => {
        const existing = existingByBizId.get(record.bizId);
        if (!existing) return [];
        const existingScope = scopeKey(existing.channel, existing.monthKey);
        const incomingScope = scopeKey(record.channel, record.monthKey);
        if (existingScope === incomingScope) return [];
        return [
          `BizId=${record.bizId}：已存在于 ${existing.channel}/${existing.monthKey}，` +
          `本次文件位于 ${record.channel}/${record.monthKey}`
        ];
      });
      if (conflicts.length > 0) {
        throw new PositionReconciliationError(
          'position-bank-existing-bizid-conflict',
          '导入文件的 BizId 与其他 Channel 或月份中的银行数据冲突',
          conflicts.slice(0, 50)
        );
      }
      const deleteStmt = this.db.prepare(
        'DELETE FROM position_bank_rows WHERE channel = ? AND month_key = ?'
      );
      for (const key of scopes) {
        const scope = decodeScopeKey(key);
        deleteStmt.run(scope.channel, scope.monthKey);
      }
      const insert = this.db.prepare(`
        INSERT INTO position_bank_rows(
          biz_id, channel, month_key, bill_date, status,
          source_file_path, source_file_name, source_sheet, source_row_number, import_order,
          original_fund_type, working_fund_type, hit_summary, hit_type, match_detail,
          original_json, working_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '', '', '', ?, ?)
      `);
      for (const record of records) {
        insert.run(
          record.bizId,
          record.channel,
          record.monthKey,
          record.billDate,
          BANK_STATUSES.UNPROCESSED,
          record.sourceFilePath,
          record.sourceFileName,
          record.sourceSheet,
          record.sourceRowNumber,
          record.importOrder,
          text(record.originalRow.FundType),
          text(record.workingRow.FundType),
          serializeJson(record.originalRow),
          serializeJson(record.workingRow)
        );
      }
      scopes.forEach((key) => this.bumpRevision('bank', key));
      this.bumpRevision('bank-global', 'all');
      return {
        rowCount: records.length,
        scopes: scopes.map(decodeScopeKey)
      };
    });
  }

  listBankScopes({ statuses = null } = {}) {
    const values = Array.isArray(statuses) ? statuses.filter(Boolean) : [];
    const where = values.length > 0 ? `WHERE status IN (${placeholders(values)})` : '';
    return this.db.prepare(`
      SELECT channel, month_key AS monthKey, status, COUNT(*) AS rowCount,
             MIN(bill_date) AS dateMin, MAX(bill_date) AS dateMax
      FROM position_bank_rows
      ${where}
      GROUP BY channel, month_key, status
      ORDER BY channel COLLATE NOCASE, month_key, status
    `).all(...values).map((row) => ({ ...row, rowCount: Number(row.rowCount) }));
  }

  getBankSummary() {
    const row = this.db.prepare(`
      SELECT COUNT(*) AS rowCount, MIN(bill_date) AS dateMin, MAX(bill_date) AS dateMax
      FROM position_bank_rows
    `).get();
    const statuses = this.db.prepare(`
      SELECT status, COUNT(*) AS rowCount
      FROM position_bank_rows
      GROUP BY status
      ORDER BY status
    `).all().map((item) => ({ status: item.status, rowCount: Number(item.rowCount) }));
    return {
      tableName: '平盘银行对账单',
      rowCount: Number(row.rowCount),
      dateMin: row.dateMin || '',
      dateMax: row.dateMax || '',
      statuses
    };
  }

  getBankRows({ channels = [], months = [], statuses = [] } = {}) {
    const clauses = [];
    const args = [];
    if (channels.length > 0) {
      clauses.push(`channel IN (${placeholders(channels)})`);
      args.push(...channels);
    }
    if (months.length > 0) {
      clauses.push(`month_key IN (${placeholders(months)})`);
      args.push(...months);
    }
    if (statuses.length > 0) {
      clauses.push(`status IN (${placeholders(statuses)})`);
      args.push(...statuses);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    return this.db.prepare(`
      SELECT *
      FROM position_bank_rows
      ${where}
      ORDER BY channel COLLATE NOCASE, bill_date, import_order, id
    `).all(...args).map((row) => {
      const originalRow = assertBankPayload(
        parseJson(row.original_json, `银行原始行 BizId=${row.biz_id}`),
        row,
        `银行原始行 BizId=${row.biz_id}`
      );
      const workingRow = assertBankPayload(
        parseJson(row.working_json, `银行工作行 BizId=${row.biz_id}`),
        row,
        `银行工作行 BizId=${row.biz_id}`
      );
      return { ...row, originalRow, workingRow };
    });
  }

  deleteBankScopes({ channels = [], months = [] } = {}) {
    const rows = this.getBankRows({ channels, months });
    const keys = [...new Set(rows.map((row) => scopeKey(row.channel, row.month_key)))];
    if (rows.length === 0) return { deletedCount: 0, scopes: [] };
    return this._mutation(() => {
      const ids = rows.map((row) => row.id);
      this.db.prepare(
        `DELETE FROM position_bank_rows WHERE id IN (${placeholders(ids)})`
      ).run(...ids);
      keys.forEach((key) => this.bumpRevision('bank', key));
      this.bumpRevision('bank-global', 'all');
      return { deletedCount: rows.length, scopes: keys.map(decodeScopeKey) };
    });
  }

  listMappings() {
    return this.db.prepare(`
      SELECT mid_account_id AS midAccountId, clearing_account_id AS clearingAccountId
      FROM position_account_mappings
      ORDER BY rowid
    `).all();
  }

  saveMappings(mappings) {
    const normalized = (Array.isArray(mappings) ? mappings : []).map((mapping) => ({
      midAccountId: text(mapping.midAccountId),
      clearingAccountId: text(mapping.clearingAccountId)
    }));
    const seen = new Set();
    for (const [index, mapping] of normalized.entries()) {
      if (!mapping.midAccountId || !mapping.clearingAccountId) {
        throw new Error(`第 ${index + 1} 行账户映射未填写完整`);
      }
      if (seen.has(mapping.midAccountId)) {
        throw new Error(`中台调拨单账户号重复：${mapping.midAccountId}`);
      }
      seen.add(mapping.midAccountId);
    }
    return this._mutation(() => {
      this.db.exec('DELETE FROM position_account_mappings');
      const insert = this.db.prepare(
        'INSERT INTO position_account_mappings(mid_account_id, clearing_account_id) VALUES (?, ?)'
      );
      normalized.forEach((mapping) => insert.run(mapping.midAccountId, mapping.clearingAccountId));
      this.bumpRevision('mapping', 'global');
      this.rebuildLinkedRows(SOURCE_TYPES.FUND_TRANSFER);
      return { count: normalized.length };
    });
  }

  sourceRecords(sourceType) {
    return this.db.prepare(`
      SELECT *
      FROM position_source_rows
      WHERE source_type = ?
      ORDER BY id
    `).all(sourceType).map((row) => {
      const payload = assertPayloadFields(
        parseJson(row.raw_json, `链接原始行 ${row.source_type}/${row.business_key}`),
        SOURCE_DEFINITIONS[sourceType].headers,
        `链接原始行 ${row.source_type}/${row.business_key}`
      );
      return {
        ...row,
        businessKey: row.business_key,
        sourceRowNumber: row.source_row_number,
        row: payload
      };
    });
  }

  countSourceRows(sourceType) {
    const row = this.db.prepare(
      'SELECT COUNT(*) AS count FROM position_source_rows WHERE source_type = ?'
    ).get(sourceType);
    return Number(row && row.count) || 0;
  }

  listSourceMonths() {
    const result = Object.fromEntries(
      Object.values(SOURCE_TYPES).map((sourceType) => [sourceType, []])
    );
    const rows = this.db.prepare(`
      SELECT source_type AS sourceType, month_key AS monthKey
      FROM position_source_rows
      WHERE month_key IS NOT NULL AND TRIM(month_key) <> ''
      GROUP BY source_type, month_key
      ORDER BY source_type, month_key
    `).all();
    for (const row of rows) {
      if (result[row.sourceType]) result[row.sourceType].push(row.monthKey);
    }
    return result;
  }

  applySourceImport(parsed, { inputEvidence = [] } = {}) {
    const sourceType = parsed.sourceType;
    return this._mutation(({ operationToken }) => {
      this._recordOperationInputs(operationToken, inputEvidence, sourceType);
      if (sourceType === SOURCE_TYPES.BANK_ACCOUNT) {
        this.db.prepare('DELETE FROM position_source_rows WHERE source_type = ?').run(sourceType);
      }
      const upsert = this.db.prepare(`
        INSERT INTO position_source_rows(
          source_type, business_key, event_date, month_key,
          source_file_path, source_file_name, source_sheet, source_row_number,
          row_hash, raw_json, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(source_type, business_key) DO UPDATE SET
          event_date = excluded.event_date,
          month_key = excluded.month_key,
          source_file_path = excluded.source_file_path,
          source_file_name = excluded.source_file_name,
          source_sheet = excluded.source_sheet,
          source_row_number = excluded.source_row_number,
          row_hash = excluded.row_hash,
          raw_json = excluded.raw_json,
          updated_at = CURRENT_TIMESTAMP
      `);
      for (const record of parsed.records) {
        upsert.run(
          sourceType,
          record.businessKey,
          record.eventDate || null,
          record.monthKey || null,
          record.sourceFilePath,
          record.sourceFileName,
          record.sourceSheet,
          record.sourceRowNumber,
          record.rowHash,
          serializeJson(record.row)
        );
      }
      this.rebuildLinkedRows(sourceType);
      this.bumpRevision('source', sourceType);
      return {
        sourceType,
        sourceName: SOURCE_DEFINITIONS[sourceType].sourceName,
        rowCount: parsed.records.length,
        linkedRowCount: this.countLinkedRows(sourceType),
        collapsedDuplicateCount: Number(parsed.collapsedDuplicateCount) || 0
      };
    });
  }

  rebuildLinkedRows(sourceType) {
    const sourceRecords = this.sourceRecords(sourceType);
    const mappings = this.listMappings();
    const derived = deriveLinkedRows(sourceType, sourceRecords, mappings);
    this.db.prepare('DELETE FROM position_link_rows WHERE source_type = ?').run(sourceType);
    const sourceIds = new Map(sourceRecords.map((record) => [record.business_key, record.id]));
    const insert = this.db.prepare(`
      INSERT INTO position_link_rows(
        source_type, business_key, source_row_id, source_row_number, ordinal, leg_index,
        recon_id, merchant_id, currency, amount, fund_type, status, event_date, visible, linked_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const item of derived) {
      const row = item.row;
      insert.run(
        sourceType,
        item.businessKey,
        sourceIds.get(item.businessKey),
        item.sourceRowNumber,
        item.ordinal,
        item.legIndex,
        text(row.ReconID),
        text(row.MerchantId),
        text(row.Currency),
        text(row.Amount),
        text(row.FundType),
        text(row['调拨状态'] || row['付款状态']),
        text(row['交易时间'] || row['创建时间'] || row.billDate || row['账单日期']),
        item.visible === false ? 0 : 1,
        serializeJson(row)
      );
    }
    this.bumpRevision('linked', sourceType);
    return derived.length;
  }

  countLinkedRows(sourceType) {
    const row = this.db.prepare(
      'SELECT COUNT(*) AS count FROM position_link_rows WHERE source_type = ? AND visible = 1'
    ).get(sourceType);
    return Number(row.count);
  }

  listLinkRows(sourceType, { includeHidden = false } = {}) {
    return this.db.prepare(`
      SELECT *
      FROM position_link_rows
      WHERE source_type = ? ${includeHidden ? '' : 'AND visible = 1'}
      ORDER BY ordinal, id
    `).all(sourceType).map((row) => ({
      ...row,
      row: assertPayloadFields(
        parseJson(row.linked_json, `链接行 ID=${row.id}`),
        LINK_HEADERS[sourceType],
        `链接行 ID=${row.id}`
      )
    }));
  }

  listConsumedSources() {
    const relatedRunIds = this.db.prepare(`
      SELECT DISTINCT rr.run_id AS runId
      FROM position_run_rows rr
      INNER JOIN position_runs r ON r.id = rr.run_id
      WHERE r.status = 'confirmed' AND rr.consumes_source = 1
      UNION
      SELECT DISTINCT run_id AS runId
      FROM position_consumed_sources
      ORDER BY runId
    `).all().map((row) => Number(row.runId));
    for (const runId of relatedRunIds) {
      if (!this.getRun(runId)) {
        throwInvalidSideData(`平盘侧库来源消费关系指向不存在的运行 ID=${runId}`);
      }
    }
    return this.db.prepare(`
      SELECT source_type AS sourceType, business_key AS businessKey,
             leg_index AS legIndex, run_id AS runId, bank_biz_id AS bankBizId
      FROM position_consumed_sources
      ORDER BY id
    `).all().map((row) => ({
      ...row,
      legIndex: Number(row.legIndex),
      runId: Number(row.runId)
    }));
  }

  listLinkedSummary() {
    return SOURCE_DISPLAY_ORDER.map((sourceType) => {
      const definition = SOURCE_DEFINITIONS[sourceType];
      const row = this.db.prepare(`
        SELECT COUNT(*) AS rowCount, MIN(event_date) AS dateMin, MAX(event_date) AS dateMax,
               MAX(created_at) AS linkedUpdatedAt
        FROM position_link_rows
        WHERE source_type = ? AND visible = 1
      `).get(sourceType);
      const revision = this.db.prepare(`
        SELECT updated_at AS updatedAt
        FROM position_revisions
        WHERE kind = 'linked' AND scope_key = ?
      `).get(sourceType);
      const source = this.db.prepare(`
        SELECT MAX(updated_at) AS updatedAt
        FROM position_source_rows
        WHERE source_type = ?
      `).get(sourceType);
      return {
        sourceType,
        tableName: definition.linkedName,
        rowCount: Number(row.rowCount),
        dateMin: row.dateMin || '',
        dateMax: row.dateMax || '',
        updatedAt: revision?.updatedAt || row.linkedUpdatedAt || source.updatedAt || ''
      };
    });
  }

  listRawSummary() {
    return SOURCE_DISPLAY_ORDER.map((sourceType) => {
      const definition = SOURCE_DEFINITIONS[sourceType];
      const row = this.db.prepare(`
        SELECT COUNT(*) AS rowCount, MIN(event_date) AS dateMin, MAX(event_date) AS dateMax,
               MAX(updated_at) AS updatedAt
        FROM position_source_rows
        WHERE source_type = ?
      `).get(sourceType);
      return {
        sourceType,
        tableName: definition.sourceName,
        rowCount: Number(row.rowCount),
        dateMin: row.dateMin || '',
        dateMax: row.dateMax || '',
        updatedAt: row.updatedAt || ''
      };
    });
  }

  deleteSource({ sourceType, months = [], wholeTable = false }) {
    if (!SOURCE_DEFINITIONS[sourceType]) throw new Error('未知链接原始表');
    const normalizedMonths = [...new Set(
      (Array.isArray(months) ? months : []).map(text).filter(Boolean)
    )];
    if (sourceType !== SOURCE_TYPES.BANK_ACCOUNT && wholeTable) {
      throw new Error('非账户链接原始表必须明确选择月份，不允许整表删除');
    }
    if (
      sourceType !== SOURCE_TYPES.BANK_ACCOUNT
      && normalizedMonths.length === 0
    ) {
      throw new Error('请至少选择一个月份');
    }
    return this._mutation(() => {
      let result;
      if (sourceType === SOURCE_TYPES.BANK_ACCOUNT) {
        if (!wholeTable) throw new Error('清结算银行账户表只能整表删除');
        result = this.db.prepare('DELETE FROM position_source_rows WHERE source_type = ?').run(sourceType);
      } else {
        result = this.db.prepare(`
          DELETE FROM position_source_rows
          WHERE source_type = ? AND month_key IN (${placeholders(normalizedMonths)})
        `).run(sourceType, ...normalizedMonths);
      }
      this.rebuildLinkedRows(sourceType);
      this.bumpRevision('source', sourceType);
      return { deletedCount: Number(result.changes), sourceType };
    });
  }

  createRun({ runUuid, scope, snapshot, summary, rows, supersedeRunId = null }) {
    return this._mutation(() => {
      if (supersedeRunId !== null && supersedeRunId !== undefined) {
        const superseded = this.db.prepare(`
          UPDATE position_runs
          SET status = 'superseded', updated_at = CURRENT_TIMESTAMP
          WHERE id = ? AND status = 'pending'
        `).run(Number(supersedeRunId));
        if (Number(superseded.changes) !== 1) {
          throw new Error('待替换的平盘运行草稿不存在或状态已变化');
        }
      }
      const runResult = this.db.prepare(`
        INSERT INTO position_runs(run_uuid, status, scope_json, snapshot_json, summary_json)
        VALUES (?, 'pending', ?, ?, ?)
      `).run(runUuid, serializeJson(scope), serializeJson(snapshot), serializeJson(summary));
      const runId = Number(runResult.lastInsertRowid);
      const insertRow = this.db.prepare(`
        INSERT INTO position_run_rows(
          run_id, biz_id, channel, month_key, source_order,
          original_fund_type, result_fund_type, hit_summary, hit_type, match_detail,
          outcome, changed, manual_modified, consumes_source,
          original_json, result_json, lineage_json, integrity_hash
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)
      `);
      const insertDiff = this.db.prepare(`
        INSERT INTO position_differences(
          run_id, biz_id, channel, month_key, status, reason, lineage_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      for (const item of rows) {
        const consumesSource = runRowConsumesSource(item);
        const integrityHash = runRowIntegrityHash({
          runId,
          bizId: item.bizId,
          channel: item.channel,
          monthKey: item.monthKey,
          sourceOrder: item.sourceOrder,
          originalFundType: item.originalFundType,
          resultFundType: item.resultFundType,
          hitSummary: item.hitSummary || '',
          hitType: item.hitType || '',
          matchDetail: item.matchDetail || '',
          outcome: item.outcome,
          changed: item.changed,
          manualModified: false,
          consumesSource,
          originalRow: item.originalRow,
          resultRow: item.resultRow,
          lineage: item.lineage || {}
        });
        insertRow.run(
          runId,
          item.bizId,
          item.channel,
          item.monthKey,
          item.sourceOrder,
          item.originalFundType,
          item.resultFundType,
          item.hitSummary || '',
          item.hitType || '',
          item.matchDetail || '',
          item.outcome,
          item.changed ? 1 : 0,
          consumesSource ? 1 : 0,
          serializeJson(item.originalRow),
          serializeJson(item.resultRow),
          serializeJson(item.lineage || {}),
          integrityHash
        );
        if (item.isDifference) {
          insertDiff.run(
            runId,
            item.bizId,
            item.channel,
            item.monthKey,
            DIFFERENCE_STATUSES.PENDING,
            item.matchDetail || item.outcome,
            serializeJson(item.lineage || {})
          );
        }
      }
      return this.getRun(runId);
    });
  }

  getRun(runId) {
    const run = this.db.prepare('SELECT * FROM position_runs WHERE id = ?').get(runId);
    if (!run) return null;
    const scope = assertRunScope(
      parseJson(run.scope_json, `运行范围 ID=${run.id}`),
      `运行范围 ID=${run.id}`
    );
    const snapshot = assertRunSnapshot(
      parseJson(run.snapshot_json, `运行快照 ID=${run.id}`),
      `运行快照 ID=${run.id}`
    );
    const summary = assertRunSummary(
      parseJson(run.summary_json, `运行汇总 ID=${run.id}`),
      `运行汇总 ID=${run.id}`
    );
    assertRunEnvelope(this.db, run, scope, snapshot, summary);
    if (run.status === 'pending' && this.snapshotIsCurrent(snapshot)) {
      assertCurrentRunReferences(this.db, run.id);
    }
    return {
      ...run,
      id: Number(run.id),
      scope,
      snapshot,
      summary
    };
  }

  latestPendingRun() {
    const row = this.db.prepare(`
      SELECT id FROM position_runs
      WHERE status = 'pending'
      ORDER BY id DESC
      LIMIT 1
    `).get();
    return row ? this.getRun(row.id) : null;
  }

  listRunRows(runId, {
    differencesOnly = false,
    channels = [],
    regions = [],
    months = [],
    differenceStatuses = []
  } = {}) {
    const normalizedChannels = (Array.isArray(channels) ? channels : []).map(text).filter(Boolean);
    const hasRegionFilter = Array.isArray(regions) && regions.length > 0;
    const normalizedRegions = hasRegionFilter ? regions.map(text) : [];
    const normalizedMonths = (Array.isArray(months) ? months : []).map(text).filter(Boolean);
    const normalizedStatuses = (Array.isArray(differenceStatuses) ? differenceStatuses : [])
      .map(text)
      .filter(Boolean);
    const join = differencesOnly || normalizedStatuses.length > 0
      ? 'INNER JOIN position_differences d ON d.run_id = r.run_id AND d.biz_id = r.biz_id'
      : '';
    const clauses = ['r.run_id = ?'];
    const args = [runId];
    if (normalizedChannels.length > 0) {
      clauses.push(`r.channel IN (${placeholders(normalizedChannels)})`);
      args.push(...normalizedChannels);
    }
    if (hasRegionFilter) {
      clauses.push(`
        TRIM(COALESCE(CAST(json_extract(r.original_json, '$."地区"') AS TEXT), ''))
        IN (${placeholders(normalizedRegions)})
      `);
      args.push(...normalizedRegions);
    }
    if (normalizedMonths.length > 0) {
      clauses.push(`r.month_key IN (${placeholders(normalizedMonths)})`);
      args.push(...normalizedMonths);
    }
    if (normalizedStatuses.length > 0) {
      clauses.push(`d.status IN (${placeholders(normalizedStatuses)})`);
      args.push(...normalizedStatuses);
    }
    return this.db.prepare(`
      SELECT r.*
      FROM position_run_rows r
      ${join}
      WHERE ${clauses.join(' AND ')}
      ORDER BY r.channel COLLATE NOCASE, r.month_key, r.source_order, r.id
    `).all(...args).map((row) => {
      const originalRow = assertBankPayload(
        parseJson(row.original_json, `运行原始行 ${runId}/${row.biz_id}`),
        { ...row, channel: row.channel },
        `运行原始行 ${runId}/${row.biz_id}`
      );
      const resultRow = assertBankPayload(
        parseJson(row.result_json, `运行结果行 ${runId}/${row.biz_id}`),
        { ...row, channel: row.channel },
        `运行结果行 ${runId}/${row.biz_id}`
      );
      const lineage = assertRunLineage(
        parseJson(row.lineage_json, `运行血缘 ${runId}/${row.biz_id}`),
        row
      );
      return { ...row, originalRow, resultRow, lineage };
    });
  }

  markRunExported(runId) {
    return this._mutation(() => {
      this.db.prepare(`
        UPDATE position_runs SET exported_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(runId);
    });
  }

  replaceRunRowsFromReimport(runId, updates, { inputEvidence = [] } = {}) {
    const run = this.getRun(runId);
    if (!run) throw new Error('运行草稿不存在');
    const existingRows = new Map(
      this.listRunRows(runId).map((row) => [text(row.biz_id), row])
    );
    return this._mutation(({ operationToken }) => {
      this._recordOperationInputs(operationToken, inputEvidence, 'position-result-reimport');
      const update = this.db.prepare(`
        UPDATE position_run_rows SET
          result_fund_type = ?,
          hit_summary = ?,
          hit_type = ?,
          match_detail = ?,
          outcome = ?,
          changed = ?,
          manual_modified = ?,
          result_json = ?,
          integrity_hash = ?
        WHERE run_id = ? AND biz_id = ?
      `);
      const upsertDiff = this.db.prepare(`
        INSERT INTO position_differences(
          run_id, biz_id, channel, month_key, status, reason, lineage_json
        )
        SELECT run_id, biz_id, channel, month_key, ?, ?, lineage_json
        FROM position_run_rows
        WHERE run_id = ? AND biz_id = ?
        ON CONFLICT(run_id, biz_id) DO UPDATE SET
          status = excluded.status,
          reason = excluded.reason,
          lineage_json = excluded.lineage_json,
          updated_at = CURRENT_TIMESTAMP
      `);
      for (const item of updates) {
        const existing = existingRows.get(text(item.bizId));
        if (!existing) {
          throw new PositionReconciliationError(
            'position-side-data-invalid',
            `回导更新引用了未知运行行：${item.bizId}`
          );
        }
        const integrityHash = runRowIntegrityHash({
          runId,
          bizId: existing.biz_id,
          channel: existing.channel,
          monthKey: existing.month_key,
          sourceOrder: existing.source_order,
          originalFundType: existing.original_fund_type,
          resultFundType: item.resultFundType,
          hitSummary: item.hitSummary,
          hitType: item.hitType,
          matchDetail: item.matchDetail,
          outcome: item.outcome,
          changed: item.changed,
          manualModified: item.manualModified,
          consumesSource: Number(existing.consumes_source) === 1,
          originalRow: existing.originalRow,
          resultRow: item.resultRow,
          lineage: existing.lineage
        });
        update.run(
          item.resultFundType,
          item.hitSummary,
          item.hitType,
          item.matchDetail,
          item.outcome,
          item.changed ? 1 : 0,
          item.manualModified ? 1 : 0,
          serializeJson(item.resultRow),
          integrityHash,
          runId,
          item.bizId
        );
        if (item.manualModified) {
          upsertDiff.run(
            DIFFERENCE_STATUSES.PENDING,
            item.matchDetail,
            runId,
            item.bizId
          );
        }
      }
      const aggregate = this.db.prepare(`
        SELECT COUNT(*) AS inputRows,
               SUM(CASE WHEN changed = 1 THEN 1 ELSE 0 END) AS changedRows,
               SUM(CASE WHEN manual_modified = 1 THEN 1 ELSE 0 END) AS manualModifiedRows,
               SUM(CASE WHEN hit_type = ? THEN 1 ELSE 0 END) AS preciseRows,
               SUM(CASE WHEN hit_type = ? THEN 1 ELSE 0 END) AS fuzzyRows,
               SUM(CASE WHEN hit_type = ? THEN 1 ELSE 0 END) AS notApplicableRows,
               SUM(CASE WHEN outcome = 'matched' THEN 1 ELSE 0 END) AS matchedRows
        FROM position_run_rows
        WHERE run_id = ?
      `).get(
        MATCH_TYPES.PRECISE,
        MATCH_TYPES.FUZZY,
        MATCH_TYPES.NOT_APPLICABLE,
        runId
      );
      const difference = this.db.prepare(
        'SELECT COUNT(*) AS count FROM position_differences WHERE run_id = ?'
      ).get(runId);
      const summary = {
        ...run.summary,
        inputRows: Number(aggregate.inputRows) || 0,
        changedRows: Number(aggregate.changedRows) || 0,
        differenceRows: Number(difference.count) || 0,
        preciseRows: Number(aggregate.preciseRows) || 0,
        fuzzyRows: Number(aggregate.fuzzyRows) || 0,
        notApplicableRows: Number(aggregate.notApplicableRows) || 0,
        manualModifiedRows: Number(aggregate.manualModifiedRows) || 0,
        engine: {
          ...run.summary.engine,
          total: Number(aggregate.inputRows) || 0,
          matched: Number(aggregate.matchedRows) || 0,
          changed: Number(aggregate.changedRows) || 0,
          differences: Number(difference.count) || 0,
          notApplicable: Number(aggregate.notApplicableRows) || 0
        }
      };
      this.db.prepare(`
        UPDATE position_runs SET summary_json = ?, reimported_at = CURRENT_TIMESTAMP,
          updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(serializeJson(summary), runId);
    });
  }

  confirmRun(runId) {
    const run = this.getRun(runId);
    if (!run) throw new Error('运行草稿不存在');
    const rows = this.listRunRows(runId);
    return this._mutation(() => {
      const insertConsumption = this.db.prepare(`
        INSERT INTO position_consumed_sources(
          run_id, source_type, business_key, leg_index, bank_biz_id
        ) VALUES (?, ?, ?, ?, ?)
      `);
      const findConsumption = this.db.prepare(`
        SELECT bank_biz_id AS bankBizId
        FROM position_consumed_sources
        WHERE source_type = ? AND business_key = ? AND leg_index = ?
      `);
      const findBankConsumption = this.db.prepare(`
        SELECT source_type AS sourceType, business_key AS businessKey, leg_index AS legIndex
        FROM position_consumed_sources
        WHERE bank_biz_id = ?
      `);
      for (const row of rows) {
        const lineage = row.lineage || {};
        const sourceType = text(lineage.sourceType);
        const businessKey = text(lineage.sourceBusinessKey);
        const legIndex = Number(lineage.sourceLegIndex);
        if (
          Number(row.consumes_source) === 1
          && sourceType
          && sourceType !== SOURCE_TYPES.BANK_ACCOUNT
          && businessKey
          && lineage.sourceLegIndex !== null
          && lineage.sourceLegIndex !== undefined
          && lineage.sourceLegIndex !== ''
          && Number.isInteger(legIndex)
          && legIndex >= 0
        ) {
          const existing = findConsumption.get(sourceType, businessKey, legIndex);
          if (existing) {
            if (text(existing.bankBizId) !== text(row.biz_id)) {
              throw new Error(
                `链接记录已被其他银行行消费：${sourceType}/${businessKey}/${legIndex}`
              );
            }
            continue;
          }
          const bankConsumption = findBankConsumption.get(row.biz_id);
          if (bankConsumption) {
            throw new Error(
              `银行BizId已消费其他链接记录：${row.biz_id} → ` +
              `${bankConsumption.sourceType}/${bankConsumption.businessKey}/${bankConsumption.legIndex}`
            );
          }
          insertConsumption.run(runId, sourceType, businessKey, legIndex, row.biz_id);
        }
      }
      const updateBank = this.db.prepare(`
        UPDATE position_bank_rows SET
          working_fund_type = ?,
          hit_summary = ?,
          hit_type = ?,
          match_detail = ?,
          working_json = ?,
          status = ?,
          updated_at = CURRENT_TIMESTAMP
        WHERE biz_id = ?
      `);
      for (const row of rows) {
        updateBank.run(
          row.result_fund_type,
          row.hit_summary || '',
          row.hit_type || '',
          row.match_detail || '',
          row.result_json,
          BANK_STATUSES.FUND_NATURE_CHECKED,
          row.biz_id
        );
      }
      this.db.prepare(`
        UPDATE position_differences SET
          status = CASE WHEN EXISTS (
            SELECT 1
            FROM position_run_rows r
            WHERE r.run_id = position_differences.run_id
              AND r.biz_id = position_differences.biz_id
              AND r.manual_modified = 1
          ) THEN ? ELSE ? END,
          updated_at = CURRENT_TIMESTAMP
        WHERE run_id = ?
      `).run(DIFFERENCE_STATUSES.MODIFIED, DIFFERENCE_STATUSES.ACCEPTED, runId);
      this.db.prepare(`
        UPDATE position_runs SET status = 'confirmed', confirmed_at = CURRENT_TIMESTAMP,
          updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(runId);
      this.getRun(runId);
      for (const key of Object.keys(run.snapshot.bankScopes || {})) this.bumpRevision('bank', key);
      this.bumpRevision('bank-global', 'all');
      return { confirmedRows: rows.length, runId };
    });
  }

  listDifferenceSummary() {
    const rows = this.db.prepare(`
      SELECT d.run_id AS runId, d.channel,
             TRIM(COALESCE(CAST(json_extract(rr.original_json, '$."地区"') AS TEXT), '')) AS region,
             d.month_key AS monthKey, d.status,
             r.status AS runStatus, r.snapshot_json AS snapshotJson,
             COUNT(*) AS differenceCount, MAX(d.created_at) AS createdAt
      FROM position_differences d
      INNER JOIN position_runs r ON r.id = d.run_id
      INNER JOIN position_run_rows rr ON rr.run_id = d.run_id AND rr.biz_id = d.biz_id
      WHERE r.status IN ('pending', 'confirmed')
      GROUP BY d.run_id, d.channel,
               TRIM(COALESCE(CAST(json_extract(rr.original_json, '$."地区"') AS TEXT), '')),
               d.month_key, d.status, r.status, r.snapshot_json
      ORDER BY createdAt DESC, d.channel COLLATE NOCASE, region COLLATE NOCASE, d.month_key
    `).all();
    return rows
      .map((row) => ({
        ...row,
        snapshot: assertRunSnapshot(
          parseJson(row.snapshotJson, `差异运行快照 ID=${row.runId}`),
          `差异运行快照 ID=${row.runId}`
        )
      }))
      .filter((row) => (
        row.runStatus === 'confirmed'
        || this.snapshotIsCurrent(row.snapshot)
      ))
      .map(({ snapshotJson: _snapshotJson, snapshot: _snapshot, ...row }) => ({
        ...row,
        bankChannel: `${text(row.channel)}-${text(row.region)}`,
        differenceCount: Number(row.differenceCount)
      }));
  }

  diagnosticSummary() {
    const tableCounts = {};
    for (const table of [
      'position_bank_rows',
      'position_source_rows',
      'position_link_rows',
      'position_runs',
      'position_run_rows',
      'position_differences',
      'position_consumed_sources',
      'position_operation_inputs'
    ]) {
      tableCounts[table] = Number(this.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count);
    }
    return {
      dbPath: this.dbPath,
      dbHash: stableHash(tableCounts),
      tableCounts
    };
  }
}

function createPositionReconciliationStore(userDataDir, options) {
  return new PositionReconciliationStore(userDataDir, options);
}

module.exports = {
  PositionReconciliationStore,
  createPositionReconciliationStore,
  POSITION_DB_INITIALIZATION_MODES,
  scopeKey,
  decodeScopeKey,
  serializeJson,
  SCHEMA
};
