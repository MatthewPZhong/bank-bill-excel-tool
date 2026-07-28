'use strict';

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
  MATCH_TYPES
} = require('./constants');
const { BANK_STATEMENT_FIELDS } = require('../../constants/bank-statement-fields');
const {
  PositionReconciliationError,
  text,
  transaction,
  stableHash
} = require('./common');
const { deriveLinkedRows } = require('./derivation');

const DATE_JSON_TYPE_KEY = '__position_reconciliation_type__';

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS position_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

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
    original_json TEXT NOT NULL,
    result_json TEXT NOT NULL,
    lineage_json TEXT NOT NULL,
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
    throw new Error(`平盘侧库${label || '数据'} JSON 损坏：${error.message}`);
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
  if (row.outcome === 'difference') {
    const legIndex = Number(lineage.sourceLegIndex);
    const retainsMatchedSource = sourceType === SOURCE_TYPES.BANK_ACCOUNT || (
      sourceType
      && text(lineage.sourceBusinessKey)
      && Number.isInteger(legIndex)
      && legIndex >= 0
    );
    if (retainsMatchedSource) return lineage;
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
  if (sourceType === SOURCE_TYPES.BANK_ACCOUNT) return lineage;
  const legIndex = Number(lineage.sourceLegIndex);
  if (!text(lineage.sourceBusinessKey) || !Number.isInteger(legIndex) || legIndex < 0) {
    throw new PositionReconciliationError(
      'position-side-data-invalid',
      `平盘侧库匹配血缘缺少来源主键：run=${row.run_id}，BizId=${row.biz_id}`
    );
  }
  return lineage;
}

class PositionReconciliationStore {
  constructor(userDataDir) {
    this.userDataDir = path.resolve(userDataDir);
    this.dbPath = path.join(this.userDataDir, POSITION_DB_RELATIVE_PATH);
    fs.mkdirSync(path.dirname(this.dbPath), { recursive: true });
    this.db = new DatabaseSync(this.dbPath);
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA synchronous = NORMAL;');
    this.db.exec('PRAGMA busy_timeout = 30000;');
    this.db.exec(SCHEMA);
  }

  close() {
    if (!this.db) return;
    this.db.close();
    this.db = null;
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
    if (!snapshot || typeof snapshot !== 'object') return false;
    if (Number(snapshot.rulesetVersion) !== POSITION_RULESET_VERSION) return false;
    for (const [key, revision] of Object.entries(snapshot.bankScopes || {})) {
      if (this.getRevision('bank', key) !== Number(revision)) return false;
    }
    if (
      snapshot.bankGlobal !== null
      && snapshot.bankGlobal !== undefined
      && this.getRevision('bank-global', 'all') !== Number(snapshot.bankGlobal)
    ) {
      return false;
    }
    for (const [type, revision] of Object.entries(snapshot.sources || {})) {
      if (this.getRevision('source', type) !== Number(revision)) return false;
    }
    if (
      snapshot.mapping !== null
      && snapshot.mapping !== undefined
      && this.getRevision('mapping', 'global') !== Number(snapshot.mapping)
    ) {
      return false;
    }
    return true;
  }

  replaceBankScopes(parsed) {
    const records = Array.isArray(parsed.records) ? parsed.records : [];
    const scopes = Array.isArray(parsed.scopes) ? parsed.scopes : [];
    return transaction(this.db, () => {
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
    return transaction(this.db, () => {
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
    return transaction(this.db, () => {
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

  applySourceImport(parsed) {
    const sourceType = parsed.sourceType;
    return transaction(this.db, () => {
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
    return transaction(this.db, () => {
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
    return transaction(this.db, () => {
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
          outcome, changed, manual_modified, original_json, result_json, lineage_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)
      `);
      const insertDiff = this.db.prepare(`
        INSERT INTO position_differences(
          run_id, biz_id, channel, month_key, status, reason, lineage_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      for (const item of rows) {
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
          serializeJson(item.originalRow),
          serializeJson(item.resultRow),
          serializeJson(item.lineage || {})
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
    return {
      ...run,
      id: Number(run.id),
      scope: parseJson(run.scope_json, `运行范围 ID=${run.id}`),
      snapshot: parseJson(run.snapshot_json, `运行快照 ID=${run.id}`),
      summary: parseJson(run.summary_json, `运行汇总 ID=${run.id}`)
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
    this.db.prepare(`
      UPDATE position_runs SET exported_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(runId);
  }

  replaceRunRowsFromReimport(runId, updates) {
    const run = this.getRun(runId);
    if (!run) throw new Error('运行草稿不存在');
    return transaction(this.db, () => {
      const update = this.db.prepare(`
        UPDATE position_run_rows SET
          result_fund_type = ?,
          hit_summary = ?,
          hit_type = ?,
          match_detail = ?,
          outcome = ?,
          changed = ?,
          manual_modified = ?,
          result_json = ?
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
        update.run(
          item.resultFundType,
          item.hitSummary,
          item.hitType,
          item.matchDetail,
          item.outcome,
          item.changed ? 1 : 0,
          item.manualModified ? 1 : 0,
          serializeJson(item.resultRow),
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
               SUM(CASE WHEN hit_type = ? THEN 1 ELSE 0 END) AS notApplicableRows
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
        manualModifiedRows: Number(aggregate.manualModifiedRows) || 0
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
    return transaction(this.db, () => {
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
          sourceType
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
      .filter((row) => (
        row.runStatus === 'confirmed'
        || this.snapshotIsCurrent(parseJson(row.snapshotJson, `差异运行快照 ID=${row.runId}`))
      ))
      .map(({ snapshotJson: _snapshotJson, ...row }) => ({
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
      'position_consumed_sources'
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

function createPositionReconciliationStore(userDataDir) {
  return new PositionReconciliationStore(userDataDir);
}

module.exports = {
  PositionReconciliationStore,
  createPositionReconciliationStore,
  scopeKey,
  decodeScopeKey,
  serializeJson,
  SCHEMA
};
