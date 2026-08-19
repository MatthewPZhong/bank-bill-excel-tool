'use strict';

const crypto = require('node:crypto');

const {
  SOURCE_TYPES,
  PENDING_HEADERS,
  PENDING_V1_HEADERS,
  PENDING_RAW_CONTRACT_V1,
  PENDING_RAW_CONTRACT_V2
} = require('../vcc-financial-op/definitions');
const {
  pendingContentHash
} = require('../vcc-financial-op/row-mapper');
const {
  STRICT_YEAR_MONTH_PATTERN,
  diagnoseFirstMonthFacts,
  readFirstMonthFacts
} = require('./state-model');
const {
  assertEmptyVccStorageForUpgrade,
  ensureVccStorageSideTables,
  getVccStorageContractVersion,
  installVccStorageWriteGuards,
  registerVccStorageWriteCapability,
  upgradeEmptyVccStorageContract
} = require('./storage-contract');

const LEGACY_VCC_CURRENCY = 'CNH';
const CURRENT_VCC_CURRENCY = 'CNY';
const VCC_CURRENCY_CONTRACT_VERSION = 2;
// v3.1.8 的 48/46 列 Pending 一次性迁移合同永久冻结为 hash v2。
// 新导入 hash version 即使继续升级，也不得借启动迁移改写既有 v2 或新版本行。
const LEGACY_PENDING_RAW_CONTRACT_HASH_VERSION = 2;
const VCC_CURRENCY_ORDER = Object.freeze([
  'AUD', 'CAD', 'CNY', 'EUR', 'GBP', 'HKD', 'JPY', 'SGD', 'USD'
]);

function tableColumns(db, tableName) {
  return new Set(db.prepare(`PRAGMA table_info(${tableName})`).all().map((row) => row.name));
}

function currencyMigrationError(message, details = {}) {
  const error = new Error(message);
  error.code = 'vcc-currency-migration-blocked';
  Object.assign(error, details);
  return error;
}

function currencyContentHash(targetMonth, subject, balances) {
  return crypto.createHash('sha256')
    .update(JSON.stringify({ targetMonth, subject, balances }), 'utf8')
    .digest('hex');
}

function normalizeBalancesJsonCurrency(value, tableName, identity) {
  let parsed;
  try { parsed = JSON.parse(value); } catch (_error) { parsed = null; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw currencyMigrationError(`${tableName} ${identity} 的 balances_json 不是对象，已阻止 CNH→CNY 升级`);
  }
  const hasLegacy = Object.hasOwn(parsed, LEGACY_VCC_CURRENCY);
  const hasCurrent = Object.hasOwn(parsed, CURRENT_VCC_CURRENCY);
  if (hasLegacy && hasCurrent) {
    throw currencyMigrationError(
      `${tableName} ${identity} 同时包含 CNH 与 CNY，已阻止升级以避免资金币种合并`
    );
  }
  if (!hasLegacy) return { changed: false, balances: parsed, balancesJson: value };
  const balances = {};
  for (const currency of VCC_CURRENCY_ORDER) {
    const sourceCurrency = currency === CURRENT_VCC_CURRENCY ? LEGACY_VCC_CURRENCY : currency;
    if (!Object.hasOwn(parsed, sourceCurrency)) {
      throw currencyMigrationError(`${tableName} ${identity} 缺少 ${sourceCurrency}，已阻止 CNH→CNY 升级`);
    }
    balances[currency] = parsed[sourceCurrency];
  }
  const unexpected = Object.keys(parsed).filter((currency) => (
    currency !== LEGACY_VCC_CURRENCY && !VCC_CURRENCY_ORDER.includes(currency)
  ));
  if (unexpected.length > 0) {
    throw currencyMigrationError(
      `${tableName} ${identity} 包含未知币种 ${unexpected.join('、')}，已阻止 CNH→CNY 升级`
    );
  }
  return { changed: true, balances, balancesJson: JSON.stringify(balances) };
}

function assertNoCurrencyCoordinateCollision(db, tableName, coordinateColumns) {
  const groupBy = coordinateColumns.join(', ');
  const collision = db.prepare(`
    SELECT ${groupBy}
    FROM ${tableName}
    WHERE currency IN (?, ?)
    GROUP BY ${groupBy}
    HAVING COUNT(DISTINCT currency) > 1
    LIMIT 1
  `).get(LEGACY_VCC_CURRENCY, CURRENT_VCC_CURRENCY);
  if (!collision) return;
  throw currencyMigrationError(
    `${tableName} 同一资金坐标同时存在 CNH 与 CNY，已阻止升级`,
    { tableName, collision: { ...collision } }
  );
}

function runRowLogicalCoordinate(row) {
  return JSON.stringify([
    row.run_id,
    String(row.subject ?? ''),
    String(row.row_kind ?? ''),
    String(row.source_type ?? ''),
    String(row.category_major ?? ''),
    String(row.category_minor ?? '')
  ]);
}

function assertNoRunRowCurrencyCollision(db) {
  const seen = new Map();
  for (const row of db.prepare(`
    SELECT id, run_id, subject, row_kind, source_type, category_major, category_minor, currency
    FROM vcc_fin_op_run_rows
    WHERE currency IN (?, ?)
    ORDER BY id
  `).iterate(LEGACY_VCC_CURRENCY, CURRENT_VCC_CURRENCY)) {
    const key = runRowLogicalCoordinate(row);
    const existing = seen.get(key);
    if (existing && existing.currency !== row.currency) {
      throw currencyMigrationError(
        `vcc_fin_op_run_rows 同一结果坐标同时存在 CNH 与 CNY，已阻止升级`,
        { rowIds: [existing.id, row.id] }
      );
    }
    seen.set(key, row);
  }
}

function ensureVccCurrencyContractSupport(db) {
  const state = db.prepare(`
    SELECT currency_contract_version
    FROM vcc_fin_op_module_state
    WHERE singleton_id = 1
  `).get();
  if (Number(state && state.currency_contract_version) >= VCC_CURRENCY_CONTRACT_VERSION) {
    return {
      migrated: false,
      changedRows: 0,
      contractVersion: VCC_CURRENCY_CONTRACT_VERSION
    };
  }
  const jsonPlans = [];
  const jsonSources = [
    {
      tableName: 'vcc_fin_op_system_snapshots',
      requiredColumns: ['id', 'target_month', 'subject', 'balances_json', 'content_hash'],
      sql: `SELECT id, target_month, subject, balances_json
            FROM vcc_fin_op_system_snapshots
            WHERE instr(balances_json, '"CNH"') > 0
            ORDER BY id`,
      identity: (row) => `id=${row.id}`,
      update: (row, normalized) => ({
        sql: 'UPDATE vcc_fin_op_system_snapshots SET balances_json = ?, content_hash = ? WHERE id = ?',
        params: [
          normalized.balancesJson,
          currencyContentHash(row.target_month, row.subject, normalized.balances),
          row.id
        ]
      })
    },
    {
      tableName: 'vcc_fin_op_system_snapshot_attempts',
      requiredColumns: [
        'id', 'target_month', 'subject', 'balances_json', 'content_hash',
        'existing_balances_json_snapshot'
      ],
      sql: `SELECT id, target_month, subject, balances_json, existing_balances_json_snapshot
            FROM vcc_fin_op_system_snapshot_attempts
            WHERE instr(balances_json, '"CNH"') > 0
               OR instr(COALESCE(existing_balances_json_snapshot, ''), '"CNH"') > 0
            ORDER BY id`,
      identity: (row) => `id=${row.id}`,
      update: (row, normalized) => {
        let existing = null;
        if (row.existing_balances_json_snapshot !== null) {
          existing = normalizeBalancesJsonCurrency(
            row.existing_balances_json_snapshot,
            'vcc_fin_op_system_snapshot_attempts.existing_balances_json_snapshot',
            `id=${row.id}`
          );
        }
        return {
          changed: normalized.changed || (existing && existing.changed),
          sql: `UPDATE vcc_fin_op_system_snapshot_attempts
                SET balances_json = ?, content_hash = ?, existing_balances_json_snapshot = ?
                WHERE id = ?`,
          params: [
            normalized.balancesJson,
            currencyContentHash(row.target_month, row.subject, normalized.balances),
            existing ? existing.balancesJson : null,
            row.id
          ]
        };
      }
    },
    {
      tableName: 'vcc_fin_op_opening_balances',
      requiredColumns: ['target_month', 'subject', 'balances_json', 'content_hash'],
      sql: `SELECT target_month, subject, balances_json
            FROM vcc_fin_op_opening_balances
            WHERE instr(balances_json, '"CNH"') > 0
            ORDER BY target_month, subject`,
      identity: (row) => `${row.target_month}/${row.subject}`,
      update: (row, normalized) => ({
        sql: `UPDATE vcc_fin_op_opening_balances
              SET balances_json = ?, content_hash = ?
              WHERE target_month = ? AND subject = ?`,
        params: [
          normalized.balancesJson,
          crypto.createHash('sha256').update(normalized.balancesJson, 'utf8').digest('hex'),
          row.target_month,
          row.subject
        ]
      })
    },
    {
      tableName: 'vcc_fin_op_archives',
      requiredColumns: ['target_month', 'subject', 'balances_json'],
      sql: `SELECT target_month, subject, balances_json
            FROM vcc_fin_op_archives
            WHERE instr(balances_json, '"CNH"') > 0
            ORDER BY target_month, subject`,
      identity: (row) => `${row.target_month}/${row.subject}`,
      update: (row, normalized) => ({
        sql: `UPDATE vcc_fin_op_archives SET balances_json = ?
              WHERE target_month = ? AND subject = ?`,
        params: [normalized.balancesJson, row.target_month, row.subject]
      })
    }
  ];

  assertNoCurrencyCoordinateCollision(db, 'vcc_fin_op_run_balances', ['run_id', 'subject']);
  assertNoCurrencyCoordinateCollision(db, 'vcc_fin_op_pending_currency_totals', ['run_id', 'subject']);
  assertNoCurrencyCoordinateCollision(db, 'vcc_fin_op_run_adjustments', ['run_id', 'row_key']);
  assertNoRunRowCurrencyCollision(db);

  for (const source of jsonSources) {
    const columns = tableColumns(db, source.tableName);
    const missingColumns = source.requiredColumns.filter((columnName) => !columns.has(columnName));
    if (missingColumns.length > 0) {
      // 极老审计表可能只有关联 ID/处置列；没有 balances_json 时不存在可迁币种事实。
      if (!columns.has('balances_json')) continue;
      const legacy = db.prepare(`
        SELECT 1 FROM ${source.tableName}
        WHERE instr(balances_json, '"CNH"') > 0
        LIMIT 1
      `).get();
      if (legacy) {
        throw currencyMigrationError(
          `${source.tableName} 含 CNH 资金事实但缺少迁移列 ${missingColumns.join('、')}，已阻止升级`
        );
      }
      continue;
    }
    for (const row of db.prepare(source.sql).iterate()) {
      const normalized = normalizeBalancesJsonCurrency(
        row.balances_json,
        source.tableName,
        source.identity(row)
      );
      const plan = source.update(row, normalized);
      if (normalized.changed || plan.changed) jsonPlans.push(plan);
    }
  }

  const scalarUpdates = [
    ['vcc_fin_op_run_rows', ['currency']],
    ['vcc_fin_op_run_balances', ['currency']],
    ['vcc_fin_op_pending_summary_rows', ['flow_currency', 'pending_currency']],
    ['vcc_fin_op_pending_currency_totals', ['currency']],
    ['vcc_fin_op_run_adjustments', ['currency']]
  ];
  const scalarMigrationRequired = scalarUpdates.some(([tableName, columnNames]) => {
    const where = columnNames.map((columnName) => `${columnName} = ?`).join(' OR ');
    return Boolean(db.prepare(`SELECT 1 FROM ${tableName} WHERE ${where} LIMIT 1`)
      .get(...columnNames.map(() => LEGACY_VCC_CURRENCY)));
  });

  db.exec('BEGIN IMMEDIATE');
  try {
    let changedRows = 0;
    for (const plan of jsonPlans) {
      changedRows += Number(db.prepare(plan.sql).run(...plan.params).changes) || 0;
    }
    if (scalarMigrationRequired) {
      for (const [tableName, columnNames] of scalarUpdates) {
        const assignments = columnNames.map((columnName) => (
          `${columnName} = CASE WHEN ${columnName} = ? THEN ? ELSE ${columnName} END`
        )).join(', ');
        const where = columnNames.map((columnName) => `${columnName} = ?`).join(' OR ');
        const params = columnNames.flatMap(() => [LEGACY_VCC_CURRENCY, CURRENT_VCC_CURRENCY]);
        changedRows += Number(db.prepare(`
          UPDATE ${tableName} SET ${assignments} WHERE ${where}
        `).run(...params, ...columnNames.map(() => LEGACY_VCC_CURRENCY)).changes) || 0;
      }
    }
    for (const [tableName, columnNames] of scalarUpdates) {
      const where = columnNames.map((columnName) => `${columnName} = ?`).join(' OR ');
      const legacy = db.prepare(`SELECT 1 FROM ${tableName} WHERE ${where} LIMIT 1`)
        .get(...columnNames.map(() => LEGACY_VCC_CURRENCY));
      if (legacy) throw currencyMigrationError(`${tableName} 仍存在 CNH 派生事实，迁移已回滚`);
    }
    db.prepare(`
      UPDATE vcc_fin_op_module_state
      SET currency_contract_version = ?, updated_at = datetime('now', 'localtime')
      WHERE singleton_id = 1
    `).run(VCC_CURRENCY_CONTRACT_VERSION);
    db.exec('COMMIT');
    return {
      migrated: jsonPlans.length > 0 || scalarMigrationRequired,
      changedRows,
      contractVersion: VCC_CURRENCY_CONTRACT_VERSION
    };
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch (_rollbackError) { /* ignore */ }
    if (error && error.code === 'vcc-currency-migration-blocked') throw error;
    throw currencyMigrationError(`CNH→CNY 资金币种迁移失败：${error.message}`, { cause: error });
  }
}

function parsePendingRawJson(rawJson, tableName, rowId) {
  let values;
  try { values = JSON.parse(rawJson); } catch (_error) { values = null; }
  if (!Array.isArray(values)) {
    const error = new Error(`${tableName} 记录 ${rowId} 的 Pending raw_json 不是数组，已阻止升级`);
    error.code = 'pending-contract-migration-blocked';
    throw error;
  }
  if (values.length === PENDING_V1_HEADERS.length) {
    return { values, rawContractVersion: PENDING_RAW_CONTRACT_V1 };
  }
  if (values.length === PENDING_HEADERS.length) {
    return { values, rawContractVersion: PENDING_RAW_CONTRACT_V2 };
  }
  const error = new Error(
    `${tableName} 记录 ${rowId} 的 Pending raw_json 为 ${values.length} 项，既不是历史 48 列也不是最新 46 列，已阻止升级`
  );
  error.code = 'pending-contract-migration-blocked';
  error.recordIds = [Number(rowId)];
  throw error;
}

function pendingMigrationPlan(db, tableName) {
  const columns = tableColumns(db, tableName);
  const totalRows = Number(db.prepare(`SELECT COUNT(*) AS n FROM ${tableName}`).get().n || 0);
  if (!columns.has('source_type')) {
    if (totalRows === 0) return [];
    const error = new Error(`${tableName} 缺少 source_type，无法识别历史 Pending 记录，已阻止升级`);
    error.code = 'pending-contract-migration-blocked';
    throw error;
  }
  const pendingCount = Number(db.prepare(`
    SELECT COUNT(*) AS n FROM ${tableName} WHERE source_type = ?
  `).get(SOURCE_TYPES.PENDING).n || 0);
  if (pendingCount === 0) return [];
  const requiredColumns = ['id', 'raw_json', 'content_hash', 'hash_version', 'raw_contract_version'];
  const missingColumns = requiredColumns.filter((column) => !columns.has(column));
  if (missingColumns.length > 0) {
    const error = new Error(
      `${tableName} 存在 ${pendingCount} 条 Pending 记录，但缺少 ${missingColumns.join('、')}，已阻止升级`
    );
    error.code = 'pending-contract-migration-blocked';
    throw error;
  }
  return db.prepare(`
    SELECT id, raw_json, content_hash, hash_version, raw_contract_version
    FROM ${tableName}
    WHERE source_type = ? AND hash_version < ?
    ORDER BY id
  `).all(SOURCE_TYPES.PENDING, LEGACY_PENDING_RAW_CONTRACT_HASH_VERSION).map((row) => {
    const parsed = parsePendingRawJson(row.raw_json, tableName, row.id);
    return {
      ...row,
      desiredRawContractVersion: parsed.rawContractVersion,
      desiredContentHash: pendingContentHash(parsed.values, parsed.rawContractVersion)
    };
  });
}

function pendingSnapshotVersion(rawJson, rowId) {
  if (rawJson === null || rawJson === undefined || rawJson === '') return null;
  return parsePendingRawJson(rawJson, 'vcc_fin_op_import_rows(existing snapshot)', rowId)
    .rawContractVersion;
}

function ensurePendingRawContractSupport(db, options = {}) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const importColumns = tableColumns(db, 'vcc_fin_op_import_rows');
    if (!importColumns.has('raw_contract_version')) {
      db.exec('ALTER TABLE vcc_fin_op_import_rows ADD COLUMN raw_contract_version INTEGER NOT NULL DEFAULT 1');
    }
    if (!importColumns.has('existing_raw_contract_version_snapshot')) {
      db.exec('ALTER TABLE vcc_fin_op_import_rows ADD COLUMN existing_raw_contract_version_snapshot INTEGER');
    }
    const effectiveColumns = tableColumns(db, 'vcc_fin_op_effective_rows');
    if (!effectiveColumns.has('raw_contract_version')) {
      db.exec('ALTER TABLE vcc_fin_op_effective_rows ADD COLUMN raw_contract_version INTEGER NOT NULL DEFAULT 1');
    }
    if (!effectiveColumns.has('legacy_content_hash')) {
      db.exec('ALTER TABLE vcc_fin_op_effective_rows ADD COLUMN legacy_content_hash TEXT');
    }

    // 先构造完整计划；任一未知 raw_json 会在首条 UPDATE 前抛错并回滚加列。
    // storage contract v2 已物理移除 effective.raw_json；其内容哈希在 COW
    // 切换前已逐 id 守恒验证，不得再走旧 raw 重算路径。
    const importPlan = pendingMigrationPlan(db, 'vcc_fin_op_import_rows');
    const effectivePlan = options.skipEffectiveRawMigration === true
      ? []
      : pendingMigrationPlan(db, 'vcc_fin_op_effective_rows');
    const snapshotPlan = db.prepare(`
      SELECT id, existing_raw_json_snapshot
      FROM vcc_fin_op_import_rows
      WHERE source_type = ? AND existing_raw_json_snapshot IS NOT NULL
      ORDER BY id
    `).all(SOURCE_TYPES.PENDING).map((row) => ({
      id: row.id,
      version: pendingSnapshotVersion(row.existing_raw_json_snapshot, row.id)
    }));

    if (importPlan.length > 0) {
      const updateImport = db.prepare(`
        UPDATE vcc_fin_op_import_rows
        SET content_hash = ?, hash_version = ?, raw_contract_version = ?
        WHERE id = ?
      `);
      for (const row of importPlan) {
        updateImport.run(
          row.desiredContentHash,
          LEGACY_PENDING_RAW_CONTRACT_HASH_VERSION,
          row.desiredRawContractVersion,
          row.id
        );
      }
    }
    if (effectivePlan.length > 0) {
      const updateEffective = db.prepare(`
        UPDATE vcc_fin_op_effective_rows
        SET legacy_content_hash = CASE
              WHEN legacy_content_hash IS NULL AND hash_version < ? THEN content_hash
              ELSE legacy_content_hash
            END,
            content_hash = ?, hash_version = ?, raw_contract_version = ?
        WHERE id = ?
      `);
      for (const row of effectivePlan) {
        updateEffective.run(
          LEGACY_PENDING_RAW_CONTRACT_HASH_VERSION,
          row.desiredContentHash,
          LEGACY_PENDING_RAW_CONTRACT_HASH_VERSION,
          row.desiredRawContractVersion,
          row.id
        );
      }
    }
    const updateSnapshotVersion = db.prepare(`
      UPDATE vcc_fin_op_import_rows
      SET existing_raw_contract_version_snapshot = ?
      WHERE id = ?
    `);
    for (const row of snapshotPlan) updateSnapshotVersion.run(row.version, row.id);

    for (const [tableName, plan] of [
      ['vcc_fin_op_import_rows', importPlan],
      ['vcc_fin_op_effective_rows', effectivePlan]
    ]) {
      if (plan.length === 0) continue;
      const stored = new Map(db.prepare(`
        SELECT id, content_hash, hash_version, raw_contract_version
        FROM ${tableName}
        WHERE source_type = ?
      `).all(SOURCE_TYPES.PENDING).map((row) => [Number(row.id), row]));
      if (plan.some((expected) => {
        const actual = stored.get(Number(expected.id));
        return !actual
          || actual.content_hash !== expected.desiredContentHash
          || Number(actual.hash_version) !== LEGACY_PENDING_RAW_CONTRACT_HASH_VERSION
          || Number(actual.raw_contract_version) !== expected.desiredRawContractVersion;
      })) {
        throw new Error(`${tableName} Pending v2 哈希迁移提交前断言失败`);
      }
    }
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch (_rollbackError) { /* ignore */ }
    throw error;
  }
}

const FIRST_MONTH_DIAGNOSTIC_OPERATION = 'first_month_migration_diagnostic';

function persistFirstMonthDiagnostic(db, diagnostic) {
  if (!diagnostic.blocked) return null;
  const evidenceJson = JSON.stringify({
    code: diagnostic.code,
    reason: diagnostic.reason,
    firstMonth: diagnostic.firstMonth,
    openingMonths: diagnostic.openingMonths,
    invalidFirstMonth: diagnostic.invalidFirstMonth || false,
    invalidOpeningMonths: diagnostic.invalidOpeningMonths || []
  });
  const existing = db.prepare(`
    SELECT id
    FROM vcc_fin_op_operation_audit
    WHERE operation_type = ? AND status = 'blocked' AND evidence_json = ?
    ORDER BY id DESC
    LIMIT 1
  `).get(FIRST_MONTH_DIAGNOSTIC_OPERATION, evidenceJson);
  if (existing) return Number(existing.id);
  const targetMonth = diagnostic.firstMonth !== null
    ? diagnostic.firstMonth
    : (diagnostic.openingMonths[0] == null ? '' : diagnostic.openingMonths[0]);
  const result = db.prepare(`
    INSERT INTO vcc_fin_op_operation_audit (
      target_month, operation_type, status, evidence_json, error_message
    ) VALUES (?, ?, 'blocked', ?, ?)
  `).run(
    targetMonth,
    FIRST_MONTH_DIAGNOSTIC_OPERATION,
    evidenceJson,
    diagnostic.message
  );
  return Number(result.lastInsertRowid);
}

function ensureVccFinancialOpStateModelSupport(db) {
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS vcc_fin_op_module_state (
        singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
        first_month TEXT,
        currency_contract_version INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
      );

      CREATE TABLE IF NOT EXISTS vcc_fin_op_run_adjustments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id INTEGER NOT NULL,
        row_key TEXT NOT NULL,
        subject TEXT NOT NULL,
        source_type TEXT NOT NULL,
        category_major TEXT NOT NULL,
        category_minor TEXT NOT NULL DEFAULT '',
        currency TEXT NOT NULL,
        adjustment_amount TEXT NOT NULL,
        reason TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
        created_app_version TEXT,
        created_build_sha TEXT,
        FOREIGN KEY (run_id) REFERENCES vcc_fin_op_runs(id) ON DELETE CASCADE,
        UNIQUE (run_id, sequence),
        UNIQUE (run_id, row_key, currency)
      );

      CREATE TABLE IF NOT EXISTS vcc_fin_op_operation_audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        target_month TEXT NOT NULL,
        operation_type TEXT NOT NULL,
        run_id INTEGER,
        status TEXT NOT NULL,
        preview_token TEXT,
        evidence_json TEXT NOT NULL,
        error_message TEXT,
        app_version TEXT,
        build_sha TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
      );

      CREATE INDEX IF NOT EXISTS idx_vcc_fin_op_adjustments_run_row
        ON vcc_fin_op_run_adjustments(run_id, row_key, currency);
      CREATE INDEX IF NOT EXISTS idx_vcc_fin_op_operation_audit_month
        ON vcc_fin_op_operation_audit(target_month, operation_type, created_at DESC, id DESC);
    `);

    const moduleStateColumns = tableColumns(db, 'vcc_fin_op_module_state');
    if (!moduleStateColumns.has('currency_contract_version')) {
      db.exec(`
        ALTER TABLE vcc_fin_op_module_state
        ADD COLUMN currency_contract_version INTEGER NOT NULL DEFAULT 1
      `);
    }

    const runColumns = tableColumns(db, 'vcc_fin_op_runs');
    if (!runColumns.has('result_revision')) {
      db.exec('ALTER TABLE vcc_fin_op_runs ADD COLUMN result_revision INTEGER NOT NULL DEFAULT 0');
    }
    if (!runColumns.has('updated_at')) {
      db.exec('ALTER TABLE vcc_fin_op_runs ADD COLUMN updated_at TEXT');
    }
    if (!runColumns.has('input_fingerprint')) {
      db.exec('ALTER TABLE vcc_fin_op_runs ADD COLUMN input_fingerprint TEXT');
    }
    db.exec(`
      UPDATE vcc_fin_op_runs
      SET updated_at = COALESCE(
        NULLIF(TRIM(updated_at), ''),
        NULLIF(TRIM(archived_at), ''),
        NULLIF(TRIM(created_at), ''),
        datetime('now', 'localtime')
      )
      WHERE updated_at IS NULL OR TRIM(updated_at) = ''
    `);

    db.prepare(`
      INSERT OR IGNORE INTO vcc_fin_op_module_state (singleton_id, first_month)
      VALUES (1, NULL)
    `).run();

    let facts = readFirstMonthFacts(db);
    if (
      facts.firstMonth === null
      && facts.openingMonths.length === 1
      && STRICT_YEAR_MONTH_PATTERN.test(facts.openingMonths[0])
    ) {
      db.prepare(`
        UPDATE vcc_fin_op_module_state
        SET first_month = ?, updated_at = datetime('now', 'localtime')
        WHERE singleton_id = 1 AND first_month IS NULL
      `).run(facts.openingMonths[0]);
      facts = readFirstMonthFacts(db);
    }
    const diagnostic = diagnoseFirstMonthFacts(facts);
    persistFirstMonthDiagnostic(db, diagnostic);
    db.exec('COMMIT');
    return diagnostic;
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch (_rollbackError) { /* ignore */ }
    throw error;
  }
}

function ensureVccFinancialOpTablesSupport(db, options = {}) {
  // contract-v2 的触发器调用连接本地能力函数。必须先注册再执行任何
  // VCC DML；3.1.9 连接没有该函数，因此只能读、不能降级写。
  registerVccStorageWriteCapability(db);
  const hasSettings = Boolean(db.prepare(`
    SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'app_settings'
  `).get());
  const storageContractVersion = hasSettings ? getVccStorageContractVersion(db) : 1;
  const shouldAutoUpgradeEmptyV1 = options.autoUpgradeEmptyV1 === true
    && hasSettings
    && storageContractVersion === 1;
  // 正式 AppDatabase 启动在任何 VCC schema/DML 前先做只读判定。
  // 非空 v1 不能进入后续兼容迁移，更不能被自动清空。
  if (shouldAutoUpgradeEmptyV1) assertEmptyVccStorageForUpgrade(db);
  db.exec(`
    CREATE TABLE IF NOT EXISTS vcc_fin_op_import_batches (
      id TEXT PRIMARY KEY,
      target_month TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'importing'
        CHECK (status IN ('importing', 'success', 'completed_with_errors', 'failed')),
      file_count INTEGER NOT NULL DEFAULT 0,
      started_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      finished_at TEXT,
      error_message TEXT
    );

    CREATE TABLE IF NOT EXISTS vcc_fin_op_import_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      batch_id TEXT NOT NULL,
      target_month TEXT NOT NULL,
      source_type TEXT NOT NULL
        CHECK (source_type IN ('recharge_refund', 'fee_fx', 'channel', 'pending_archive_removal', 'system_op')),
      source_files_json TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'importing'
        CHECK (status IN ('importing', 'success', 'success_with_skips', 'all_skipped', 'failed_conflict', 'failed_validation')),
      raw_count INTEGER NOT NULL DEFAULT 0,
      inserted_count INTEGER NOT NULL DEFAULT 0,
      skipped_count INTEGER NOT NULL DEFAULT 0,
      invalid_key_count INTEGER NOT NULL DEFAULT 0,
      conflict_count INTEGER NOT NULL DEFAULT 0,
      format_error_count INTEGER NOT NULL DEFAULT 0,
      rolled_back_count INTEGER NOT NULL DEFAULT 0,
      started_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      finished_at TEXT,
      error_message TEXT,
      resolution_status TEXT NOT NULL DEFAULT 'not_applicable'
        CHECK (resolution_status IN ('not_applicable', 'unresolved', 'resolved')),
      resolved_at TEXT,
      resolution_note TEXT,
      resolution_action TEXT,
      dataset_deleted_at TEXT,
      dataset_deletion_id INTEGER,
      FOREIGN KEY (batch_id) REFERENCES vcc_fin_op_import_batches(id),
      UNIQUE (batch_id, source_type)
    );

    CREATE TABLE IF NOT EXISTS vcc_fin_op_import_rows (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      import_record_id INTEGER NOT NULL,
      source_type TEXT NOT NULL,
      target_month TEXT NOT NULL,
      idempotency_key_raw TEXT,
      idempotency_key TEXT,
      content_hash TEXT,
      hash_version INTEGER NOT NULL DEFAULT 1,
      raw_contract_version INTEGER NOT NULL DEFAULT 1,
      subject TEXT,
      stat_currency TEXT,
      signed_amount TEXT,
      business_department TEXT,
      counterparty_department TEXT,
      business_sub_type TEXT,
      channel_name TEXT,
      mid TEXT,
      recon_type TEXT,
      pending_currency TEXT,
      pending_amount TEXT,
      flow_currency TEXT,
      flow_amount TEXT,
      currency_mismatch INTEGER,
      source_file TEXT NOT NULL,
      sheet_name TEXT NOT NULL,
      source_row INTEGER NOT NULL,
      raw_json TEXT NOT NULL,
      disposition TEXT
        CHECK (disposition IS NULL OR disposition IN (
          'accepted', 'idempotent_skip', 'idempotent_conflict',
          'invalid_key', 'format_error', 'rolled_back'
        )),
      validation_field TEXT,
      validation_message TEXT,
      existing_effective_id INTEGER,
      comparison_import_row_id INTEGER,
      diff_fields_json TEXT,
      existing_raw_json_snapshot TEXT,
      existing_subject_snapshot TEXT,
      existing_source_file_snapshot TEXT,
      existing_sheet_name_snapshot TEXT,
      existing_source_row_snapshot INTEGER,
      existing_import_record_id_snapshot INTEGER,
      existing_imported_at_snapshot TEXT,
      existing_raw_contract_version_snapshot INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      FOREIGN KEY (import_record_id) REFERENCES vcc_fin_op_import_records(id),
      FOREIGN KEY (existing_effective_id) REFERENCES vcc_fin_op_effective_rows(id),
      FOREIGN KEY (comparison_import_row_id) REFERENCES vcc_fin_op_import_rows(id)
    );

    CREATE TABLE IF NOT EXISTS vcc_fin_op_effective_rows (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_type TEXT NOT NULL
        CHECK (source_type IN ('recharge_refund', 'fee_fx', 'channel', 'pending_archive_removal')),
      idempotency_key_raw TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      hash_version INTEGER NOT NULL DEFAULT 1,
      raw_contract_version INTEGER NOT NULL DEFAULT 1,
      legacy_content_hash TEXT,
      target_month TEXT NOT NULL,
      subject TEXT NOT NULL,
      stat_currency TEXT,
      signed_amount TEXT,
      business_department TEXT,
      counterparty_department TEXT,
      business_sub_type TEXT,
      channel_name TEXT,
      mid TEXT,
      recon_type TEXT,
      pending_currency TEXT,
      pending_amount TEXT,
      flow_currency TEXT,
      flow_amount TEXT,
      currency_mismatch INTEGER,
      source_file TEXT NOT NULL,
      sheet_name TEXT NOT NULL,
      source_row INTEGER NOT NULL,
      raw_json TEXT NOT NULL,
      import_record_id INTEGER NOT NULL,
      first_imported_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      FOREIGN KEY (import_record_id) REFERENCES vcc_fin_op_import_records(id),
      UNIQUE (source_type, idempotency_key)
    );

    CREATE TABLE IF NOT EXISTS vcc_fin_op_import_errors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      import_record_id INTEGER NOT NULL,
      source_file TEXT,
      sheet_name TEXT,
      source_row INTEGER,
      field_name TEXT,
      error_code TEXT NOT NULL,
      message TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      FOREIGN KEY (import_record_id) REFERENCES vcc_fin_op_import_records(id)
    );

    CREATE TABLE IF NOT EXISTS vcc_fin_op_datasets (
      target_month TEXT NOT NULL,
      dataset_type TEXT NOT NULL,
      data_status TEXT NOT NULL DEFAULT 'unprocessed'
        CHECK (data_status IN ('unprocessed', 'archived')),
      archived_run_id INTEGER,
      revision INTEGER NOT NULL DEFAULT 1,
      generated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      PRIMARY KEY (target_month, dataset_type)
    );

    CREATE TABLE IF NOT EXISTS vcc_fin_op_system_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      target_month TEXT NOT NULL,
      subject TEXT NOT NULL,
      balances_json TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      source_file TEXT NOT NULL,
      sheet_name TEXT NOT NULL,
      source_row INTEGER NOT NULL,
      raw_json TEXT NOT NULL,
      import_record_id INTEGER NOT NULL,
      imported_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      FOREIGN KEY (import_record_id) REFERENCES vcc_fin_op_import_records(id),
      UNIQUE (target_month, subject)
    );

    CREATE TABLE IF NOT EXISTS vcc_fin_op_system_snapshot_attempts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      import_record_id INTEGER NOT NULL,
      target_month TEXT NOT NULL,
      subject TEXT NOT NULL,
      balances_json TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      source_file TEXT NOT NULL,
      sheet_name TEXT NOT NULL,
      source_row INTEGER NOT NULL,
      raw_json TEXT NOT NULL,
      disposition TEXT NOT NULL
        CHECK (disposition IN ('accepted', 'idempotent_skip', 'idempotent_conflict', 'rolled_back')),
      existing_snapshot_id INTEGER,
      comparison_attempt_id INTEGER,
      existing_balances_json_snapshot TEXT,
      existing_raw_json_snapshot TEXT,
      existing_source_file_snapshot TEXT,
      existing_sheet_name_snapshot TEXT,
      existing_source_row_snapshot INTEGER,
      existing_import_record_id_snapshot INTEGER,
      existing_imported_at_snapshot TEXT,
      message TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      FOREIGN KEY (import_record_id) REFERENCES vcc_fin_op_import_records(id),
      FOREIGN KEY (existing_snapshot_id) REFERENCES vcc_fin_op_system_snapshots(id),
      FOREIGN KEY (comparison_attempt_id) REFERENCES vcc_fin_op_system_snapshot_attempts(id)
    );

    CREATE TABLE IF NOT EXISTS vcc_fin_op_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      target_month TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'calculated'
        CHECK (status IN ('calculated', 'archived')),
      input_revisions_json TEXT NOT NULL DEFAULT '{}',
      result_revision INTEGER NOT NULL DEFAULT 0,
      input_fingerprint TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      updated_at TEXT,
      archived_at TEXT,
      UNIQUE (target_month, id)
    );

    CREATE TABLE IF NOT EXISTS vcc_fin_op_run_rows (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id INTEGER NOT NULL,
      subject TEXT NOT NULL,
      row_kind TEXT NOT NULL,
      source_type TEXT,
      category_major TEXT,
      category_minor TEXT,
      currency TEXT NOT NULL,
      amount TEXT NOT NULL,
      FOREIGN KEY (run_id) REFERENCES vcc_fin_op_runs(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS vcc_fin_op_run_balances (
      run_id INTEGER NOT NULL,
      subject TEXT NOT NULL,
      currency TEXT NOT NULL,
      opening_balance TEXT NOT NULL,
      period_amount TEXT NOT NULL,
      calculated_balance TEXT NOT NULL,
      system_balance TEXT NOT NULL,
      difference TEXT NOT NULL,
      PRIMARY KEY (run_id, subject, currency),
      FOREIGN KEY (run_id) REFERENCES vcc_fin_op_runs(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS vcc_fin_op_pending_summary_rows (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id INTEGER NOT NULL,
      subject TEXT NOT NULL,
      channel_name TEXT,
      currency_mismatch INTEGER NOT NULL,
      flow_currency TEXT,
      pending_currency TEXT,
      recon_type TEXT,
      flow_amount TEXT NOT NULL,
      pending_amount TEXT NOT NULL,
      FOREIGN KEY (run_id) REFERENCES vcc_fin_op_runs(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS vcc_fin_op_pending_currency_totals (
      run_id INTEGER NOT NULL,
      subject TEXT NOT NULL,
      currency TEXT NOT NULL,
      amount TEXT NOT NULL,
      PRIMARY KEY (run_id, subject, currency),
      FOREIGN KEY (run_id) REFERENCES vcc_fin_op_runs(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS vcc_fin_op_archives (
      target_month TEXT NOT NULL,
      subject TEXT NOT NULL,
      balances_json TEXT NOT NULL,
      run_id INTEGER NOT NULL,
      archived_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      PRIMARY KEY (target_month, subject),
      FOREIGN KEY (run_id) REFERENCES vcc_fin_op_runs(id)
    );

    CREATE TABLE IF NOT EXISTS vcc_fin_op_opening_balances (
      target_month TEXT NOT NULL,
      subject TEXT NOT NULL,
      balances_json TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      initialization_note TEXT NOT NULL,
      initialized_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      PRIMARY KEY (target_month, subject)
    );

    CREATE TABLE IF NOT EXISTS vcc_fin_op_dataset_deletions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      target_month TEXT NOT NULL,
      source_type TEXT NOT NULL
        CHECK (source_type IN ('recharge_refund', 'fee_fx', 'channel', 'pending_archive_removal', 'system_op')),
      dataset_revision INTEGER,
      deleted_data_count INTEGER NOT NULL DEFAULT 0,
      invalidated_run_count INTEGER NOT NULL DEFAULT 0,
      deleted_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
    );

    CREATE INDEX IF NOT EXISTS idx_vcc_fin_op_import_records_month
      ON vcc_fin_op_import_records(target_month, started_at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS idx_vcc_fin_op_import_rows_record_disposition
      ON vcc_fin_op_import_rows(import_record_id, disposition, id);
    CREATE INDEX IF NOT EXISTS idx_vcc_fin_op_import_rows_key
      ON vcc_fin_op_import_rows(source_type, idempotency_key, content_hash);
    CREATE INDEX IF NOT EXISTS idx_vcc_fin_op_import_rows_record_key
      ON vcc_fin_op_import_rows(import_record_id, idempotency_key, content_hash, id);
    CREATE INDEX IF NOT EXISTS idx_vcc_fin_op_import_rows_existing
      ON vcc_fin_op_import_rows(existing_effective_id);
    CREATE INDEX IF NOT EXISTS idx_vcc_fin_op_import_rows_comparison
      ON vcc_fin_op_import_rows(comparison_import_row_id);
    CREATE INDEX IF NOT EXISTS idx_vcc_fin_op_effective_month_source
      ON vcc_fin_op_effective_rows(target_month, source_type, subject, stat_currency);
    CREATE INDEX IF NOT EXISTS idx_vcc_fin_op_effective_pending
      ON vcc_fin_op_effective_rows(target_month, source_type, subject, pending_currency, flow_currency);
    CREATE INDEX IF NOT EXISTS idx_vcc_fin_op_import_errors_record
      ON vcc_fin_op_import_errors(import_record_id, id);
    CREATE INDEX IF NOT EXISTS idx_vcc_fin_op_system_attempts_record
      ON vcc_fin_op_system_snapshot_attempts(import_record_id, disposition, id);
    CREATE INDEX IF NOT EXISTS idx_vcc_fin_op_runs_month
      ON vcc_fin_op_runs(target_month, id DESC);
    CREATE INDEX IF NOT EXISTS idx_vcc_fin_op_opening_month
      ON vcc_fin_op_opening_balances(target_month, initialized_at);
    CREATE INDEX IF NOT EXISTS idx_vcc_fin_op_dataset_deletions_month
      ON vcc_fin_op_dataset_deletions(target_month, deleted_at DESC, id DESC);
  `);

  const columns = (tableName) => tableColumns(db, tableName);
  const recordColumns = columns('vcc_fin_op_import_records');
  if (!recordColumns.has('resolution_status')) {
    db.exec("ALTER TABLE vcc_fin_op_import_records ADD COLUMN resolution_status TEXT NOT NULL DEFAULT 'not_applicable'");
  }
  if (!recordColumns.has('resolved_at')) {
    db.exec('ALTER TABLE vcc_fin_op_import_records ADD COLUMN resolved_at TEXT');
  }
  if (!recordColumns.has('resolution_note')) {
    db.exec('ALTER TABLE vcc_fin_op_import_records ADD COLUMN resolution_note TEXT');
  }
  if (!recordColumns.has('resolution_action')) {
    db.exec('ALTER TABLE vcc_fin_op_import_records ADD COLUMN resolution_action TEXT');
  }
  if (!recordColumns.has('dataset_deleted_at')) {
    db.exec('ALTER TABLE vcc_fin_op_import_records ADD COLUMN dataset_deleted_at TEXT');
  }
  if (!recordColumns.has('dataset_deletion_id')) {
    db.exec('ALTER TABLE vcc_fin_op_import_records ADD COLUMN dataset_deletion_id INTEGER');
  }
  const datasetColumns = columns('vcc_fin_op_datasets');
  if (!datasetColumns.has('revision')) {
    db.exec('ALTER TABLE vcc_fin_op_datasets ADD COLUMN revision INTEGER NOT NULL DEFAULT 1');
  }
  if (!datasetColumns.has('generated_at')) {
    db.exec('ALTER TABLE vcc_fin_op_datasets ADD COLUMN generated_at TEXT');
  }
  db.exec(`
    UPDATE vcc_fin_op_datasets
    SET generated_at = COALESCE(
      (
        SELECT MAX(record.finished_at)
        FROM vcc_fin_op_import_records record
        WHERE record.target_month = vcc_fin_op_datasets.target_month
          AND record.source_type = vcc_fin_op_datasets.dataset_type
          AND record.status IN ('success', 'success_with_skips')
          AND record.inserted_count > 0
          AND record.dataset_deleted_at IS NULL
      ),
      NULLIF(TRIM(updated_at), ''),
      datetime('now', 'localtime')
    )
    WHERE generated_at IS NULL OR TRIM(generated_at) = ''
  `);
  const runColumns = columns('vcc_fin_op_runs');
  if (!runColumns.has('input_revisions_json')) {
    db.exec("ALTER TABLE vcc_fin_op_runs ADD COLUMN input_revisions_json TEXT NOT NULL DEFAULT '{}'");
  }
  const systemAttemptColumns = columns('vcc_fin_op_system_snapshot_attempts');
  if (!systemAttemptColumns.has('comparison_attempt_id')) {
    db.exec('ALTER TABLE vcc_fin_op_system_snapshot_attempts ADD COLUMN comparison_attempt_id INTEGER');
  }
  const importRowColumns = columns('vcc_fin_op_import_rows');
  const importRowSnapshotColumns = [
    ['existing_raw_json_snapshot', 'TEXT'],
    ['existing_subject_snapshot', 'TEXT'],
    ['existing_source_file_snapshot', 'TEXT'],
    ['existing_sheet_name_snapshot', 'TEXT'],
    ['existing_source_row_snapshot', 'INTEGER'],
    ['existing_import_record_id_snapshot', 'INTEGER'],
    ['existing_imported_at_snapshot', 'TEXT']
  ];
  for (const [name, type] of importRowSnapshotColumns) {
    if (!importRowColumns.has(name)) {
      db.exec(`ALTER TABLE vcc_fin_op_import_rows ADD COLUMN ${name} ${type}`);
    }
  }
  const systemSnapshotColumns = [
    ['existing_balances_json_snapshot', 'TEXT'],
    ['existing_raw_json_snapshot', 'TEXT'],
    ['existing_source_file_snapshot', 'TEXT'],
    ['existing_sheet_name_snapshot', 'TEXT'],
    ['existing_source_row_snapshot', 'INTEGER'],
    ['existing_import_record_id_snapshot', 'INTEGER'],
    ['existing_imported_at_snapshot', 'TEXT']
  ];
  for (const [name, type] of systemSnapshotColumns) {
    if (!systemAttemptColumns.has(name)) {
      db.exec(`ALTER TABLE vcc_fin_op_system_snapshot_attempts ADD COLUMN ${name} ${type}`);
    }
  }
  ensurePendingRawContractSupport(db, {
    skipEffectiveRawMigration: storageContractVersion >= 2
  });
  ensureVccStorageSideTables(db);
  const stateDiagnostic = ensureVccFinancialOpStateModelSupport(db);
  const currencyMigration = ensureVccCurrencyContractSupport(db);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_vcc_fin_op_import_records_dataset_lifecycle
      ON vcc_fin_op_import_records(target_month, source_type, dataset_deleted_at, status);
    CREATE INDEX IF NOT EXISTS idx_vcc_fin_op_system_attempts_comparison
      ON vcc_fin_op_system_snapshot_attempts(comparison_attempt_id)
  `);
  const storageContractMigration = shouldAutoUpgradeEmptyV1
    ? upgradeEmptyVccStorageContract(db)
    : Object.freeze({
        upgraded: false,
        fromVersion: storageContractVersion,
        toVersion: storageContractVersion
      });
  if (storageContractVersion >= 2) installVccStorageWriteGuards(db);
  return { firstMonthDiagnostic: stateDiagnostic, currencyMigration, storageContractMigration };
}

module.exports = {
  FIRST_MONTH_DIAGNOSTIC_OPERATION,
  ensureVccCurrencyContractSupport,
  ensureVccFinancialOpStateModelSupport,
  ensureVccFinancialOpTablesSupport
};
