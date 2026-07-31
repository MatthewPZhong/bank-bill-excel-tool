'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const {
  PositionReconciliationError,
  stableHash,
  stableJson,
  text
} = require('./common');
const {
  parseJson,
  serializeJson,
  runRowIntegrityHash
} = require('./store');
const {
  normalizePositionCheckpoint,
  positionCheckpointsEqual,
  readPositionDatabaseCheckpoint,
  assertCurrentPositionCheckpointHistory
} = require('./side-db-mutation');

const POSITION_LARGE_IMPORT_SCHEMA_FINGERPRINT_KEY =
  'position_large_import_schema_fingerprint_v1';
const MINIMUM_MIGRATION_HEADROOM_BYTES = 64 * 1024 * 1024;

const LEGACY_SOURCE_COLUMNS = Object.freeze([
  'id', 'source_type', 'business_key', 'event_date', 'month_key',
  'source_file_path', 'source_file_name', 'source_sheet', 'source_row_number',
  'row_hash', 'raw_json', 'imported_at', 'updated_at'
]);
const MODERN_SOURCE_COLUMNS = LEGACY_SOURCE_COLUMNS;
const LEGACY_LINK_COLUMNS = Object.freeze([
  'id', 'source_type', 'business_key', 'source_row_id', 'source_row_number',
  'ordinal', 'leg_index', 'recon_id', 'merchant_id', 'currency', 'amount',
  'fund_type', 'status', 'event_date', 'visible', 'linked_json', 'created_at'
]);
const MODERN_LINK_COLUMNS = Object.freeze([
  'id', 'source_type', 'business_key', 'source_record_key', 'source_row_id',
  'source_row_number', 'ordinal', 'leg_index', 'recon_id', 'merchant_id',
  'currency', 'amount', 'fund_type', 'status', 'event_date', 'visible',
  'linked_json', 'created_at'
]);
const LEGACY_CONSUMED_COLUMNS = Object.freeze([
  'id', 'run_id', 'source_type', 'business_key', 'leg_index', 'bank_biz_id',
  'confirmed_at'
]);
const MODERN_CONSUMED_COLUMNS = Object.freeze([
  'id', 'run_id', 'source_type', 'business_key', 'source_record_key',
  'leg_index', 'bank_biz_id', 'confirmed_at'
]);

const REQUIRED_NAMED_INDEXES = Object.freeze({
  idx_position_source_type_month: Object.freeze({
    unique: false,
    columns: Object.freeze(['source_type', 'month_key'])
  }),
  idx_position_source_type_business_key: Object.freeze({
    unique: false,
    columns: Object.freeze(['source_type', 'business_key'])
  }),
  idx_position_link_type_recon: Object.freeze({
    unique: false,
    columns: Object.freeze(['source_type', 'recon_id'])
  }),
  idx_position_link_type_account_currency: Object.freeze({
    unique: false,
    columns: Object.freeze(['source_type', 'merchant_id', 'currency'])
  }),
  uq_position_link_source_leg: Object.freeze({
    unique: true,
    columns: Object.freeze(['source_row_id', 'leg_index'])
  }),
  idx_position_link_type_source_order: Object.freeze({
    unique: false,
    columns: Object.freeze(['source_type', 'source_row_id', 'leg_index', 'id'])
  }),
  idx_position_consumed_sources_run: Object.freeze({
    unique: false,
    columns: Object.freeze(['run_id', 'bank_biz_id'])
  }),
  idx_position_consumed_sources_bank: Object.freeze({
    unique: true,
    columns: Object.freeze(['bank_biz_id'])
  })
});

function schemaError(code, message, detailLines = []) {
  return new PositionReconciliationError(code, message, detailLines);
}

function tableColumns(db, tableName) {
  return db.prepare(`PRAGMA table_info("${tableName}")`).all()
    .map((column) => String(column.name || ''));
}

function sameColumns(actual, expected) {
  return JSON.stringify(actual) === JSON.stringify(expected);
}

function indexDescriptors(db, tableName) {
  return db.prepare(`PRAGMA index_list("${tableName}")`).all().map((index) => ({
    name: String(index.name || ''),
    unique: Number(index.unique) === 1,
    origin: String(index.origin || ''),
    partial: Number(index.partial) === 1,
    columns: db.prepare(`PRAGMA index_info("${String(index.name || '').replace(/"/g, '""')}")`)
      .all()
      .map((column) => String(column.name || ''))
  }));
}

function findIndexByColumns(indexes, columns, unique) {
  return indexes.find((index) => (
    index.unique === unique
    && index.partial === false
    && JSON.stringify(index.columns) === JSON.stringify(columns)
  ));
}

function assertNamedIndexes(db) {
  const byTable = {
    position_source_rows: indexDescriptors(db, 'position_source_rows'),
    position_link_rows: indexDescriptors(db, 'position_link_rows'),
    position_consumed_sources: indexDescriptors(db, 'position_consumed_sources')
  };
  for (const [name, expected] of Object.entries(REQUIRED_NAMED_INDEXES)) {
    const tableName = name.includes('consumed')
      ? 'position_consumed_sources'
      : name.includes('source_type_month') || name.includes('business_key')
        ? 'position_source_rows'
        : 'position_link_rows';
    const actual = byTable[tableName].find((index) => index.name === name);
    if (!actual
        || actual.unique !== expected.unique
        || actual.partial
        || JSON.stringify(actual.columns) !== JSON.stringify(expected.columns)) {
      throw schemaError(
        'position-large-import-schema-invalid',
        `平盘百万级导入缺少必要索引：${name}`
      );
    }
  }
  if (!findIndexByColumns(
    byTable.position_source_rows,
    ['source_type', 'row_hash'],
    true
  )) {
    throw schemaError(
      'position-large-import-schema-invalid',
      '平盘来源记录缺少 source_type + row_hash 唯一约束'
    );
  }
  if (findIndexByColumns(
    byTable.position_source_rows,
    ['source_type', 'business_key'],
    true
  )) {
    throw schemaError(
      'position-large-import-schema-invalid',
      '平盘来源记录仍错误地把业务主键作为唯一身份'
    );
  }
  if (!findIndexByColumns(
    byTable.position_consumed_sources,
    ['source_type', 'source_record_key', 'leg_index'],
    true
  )) {
    throw schemaError(
      'position-large-import-schema-invalid',
      '平盘来源消费记录缺少 source_record_key 唯一约束'
    );
  }
}

function schemaSignature(db) {
  const tables = [
    'position_source_rows',
    'position_link_rows',
    'position_consumed_sources'
  ];
  return tables.map((tableName) => ({
    tableName,
    columns: db.prepare(`PRAGMA table_info("${tableName}")`).all().map((column) => ({
      name: String(column.name || ''),
      type: String(column.type || ''),
      notnull: Number(column.notnull),
      defaultValue: column.dflt_value === null ? null : String(column.dflt_value),
      primaryKey: Number(column.pk)
    })),
    indexes: indexDescriptors(db, tableName)
      .map((index) => ({
        name: index.name,
        unique: index.unique,
        origin: index.origin,
        partial: index.partial,
        columns: index.columns
      }))
      .sort((left, right) => left.name.localeCompare(right.name)),
    foreignKeys: db.prepare(`PRAGMA foreign_key_list("${tableName}")`).all().map((item) => ({
      table: String(item.table || ''),
      from: String(item.from || ''),
      to: String(item.to || ''),
      onUpdate: String(item.on_update || ''),
      onDelete: String(item.on_delete || '')
    }))
  }));
}

function positionLargeImportSchemaFingerprint(db) {
  assertPositionLargeImportSchema(db, { requireStoredFingerprint: false });
  return stableHash(schemaSignature(db));
}

function assertPositionLargeImportSchema(db, {
  requireStoredFingerprint = true
} = {}) {
  if (!sameColumns(tableColumns(db, 'position_source_rows'), MODERN_SOURCE_COLUMNS)
      || !sameColumns(tableColumns(db, 'position_link_rows'), MODERN_LINK_COLUMNS)
      || !sameColumns(tableColumns(db, 'position_consumed_sources'), MODERN_CONSUMED_COLUMNS)) {
    throw schemaError(
      'position-large-import-schema-invalid',
      '平盘百万级导入侧库字段结构不完整'
    );
  }
  assertNamedIndexes(db);
  const checkpoint = readPositionDatabaseCheckpoint(db);
  if (!checkpoint) {
    throw schemaError(
      'position-side-db-mismatch',
      '平盘百万级导入侧库 checkpoint 缺失'
    );
  }
  assertCurrentPositionCheckpointHistory(db, checkpoint);
  const foreignKeyFailures = db.prepare('PRAGMA foreign_key_check').all();
  if (foreignKeyFailures.length > 0) {
    throw schemaError(
      'position-large-import-schema-invalid',
      '平盘百万级导入侧库外键校验失败'
    );
  }
  if (requireStoredFingerprint) {
    const row = db.prepare(
      'SELECT value FROM position_meta WHERE key = ?'
    ).get(POSITION_LARGE_IMPORT_SCHEMA_FINGERPRINT_KEY);
    const actual = stableHash(schemaSignature(db));
    if (!row || text(row.value) !== actual) {
      throw schemaError(
        'position-large-import-schema-invalid',
        '平盘百万级导入侧库 schema fingerprint 缺失或不一致'
      );
    }
  }
  return true;
}

function migrationStorageBytes(dbPath) {
  const candidates = [dbPath, `${dbPath}-wal`, `${dbPath}-shm`];
  return candidates.reduce((total, candidate) => {
    try {
      return total + BigInt(fs.statSync(candidate).size);
    } catch (_error) {
      return total;
    }
  }, 0n);
}

function defaultAvailableBytesProvider(dbPath) {
  const stats = fs.statfsSync(path.dirname(dbPath), { bigint: true });
  return stats.bavail * stats.bsize;
}

function assertPositionMigrationDiskSpace(dbPath, {
  availableBytesProvider = defaultAvailableBytesProvider
} = {}) {
  const currentBytes = migrationStorageBytes(dbPath);
  const requiredBytes = (
    currentBytes * 2n + BigInt(MINIMUM_MIGRATION_HEADROOM_BYTES)
  );
  const available = BigInt(availableBytesProvider(dbPath));
  if (available < requiredBytes) {
    throw schemaError(
      'position-side-db-migration-disk-insufficient',
      '平盘侧库身份迁移可用磁盘空间不足',
      [
        `至少需要 ${requiredBytes.toString()} 字节`,
        `当前可用 ${available.toString()} 字节`
      ]
    );
  }
  return { currentBytes, requiredBytes, availableBytes: available };
}

function assertLegacyOrModernShape(db) {
  const sourceColumns = tableColumns(db, 'position_source_rows');
  const linkColumns = tableColumns(db, 'position_link_rows');
  const consumedColumns = tableColumns(db, 'position_consumed_sources');
  const modern = sameColumns(sourceColumns, MODERN_SOURCE_COLUMNS)
    && sameColumns(linkColumns, MODERN_LINK_COLUMNS)
    && sameColumns(consumedColumns, MODERN_CONSUMED_COLUMNS);
  const legacy = sameColumns(sourceColumns, LEGACY_SOURCE_COLUMNS)
    && sameColumns(linkColumns, LEGACY_LINK_COLUMNS)
    && sameColumns(consumedColumns, LEGACY_CONSUMED_COLUMNS);
  if (!modern && !legacy) {
    throw schemaError(
      'position-large-import-schema-invalid',
      '平盘侧库来源身份结构既不是受支持旧版，也不是完整新版'
    );
  }
  return modern ? 'modern' : 'legacy';
}

function assertNoDuplicateSourceLeg(db) {
  const duplicateLink = db.prepare(`
    SELECT source_row_id AS sourceRowId, leg_index AS legIndex, COUNT(*) AS count
    FROM position_link_rows
    GROUP BY source_row_id, leg_index
    HAVING COUNT(*) > 1
    LIMIT 1
  `).get();
  if (duplicateLink) {
    throw schemaError(
      'position-link-source-leg-duplicate',
      '平盘链接记录存在重复来源腿，禁止创建百万级导入索引'
    );
  }
}

function assertLegacyDataCanMigrate(db) {
  const sourceRows = db.prepare(`
    SELECT source_type AS sourceType, business_key AS businessKey,
           row_hash AS rowHash, raw_json AS rawJson
    FROM position_source_rows
    ORDER BY source_type, row_hash, id
  `).iterate();
  let previousIdentity = '';
  let previousCanonicalRow = '';
  for (const row of sourceRows) {
    const rowHash = text(row.rowHash);
    if (!/^[a-f0-9]{64}$/.test(rowHash)) {
      throw schemaError(
        'position-source-record-hash-invalid',
        '平盘来源记录存在非法 row_hash，禁止迁移'
      );
    }
    const payload = parseJson(
      row.rawJson,
      `迁移来源记录 ${row.sourceType}/${row.businessKey}`
    );
    const canonicalRow = stableJson(payload);
    if (stableHash(payload) !== rowHash) {
      throw schemaError(
        'position-source-record-hash-invalid',
        '平盘来源记录 row_hash 与规范内容不一致，禁止迁移'
      );
    }
    const identity = `${text(row.sourceType)}\u0000${rowHash}`;
    if (identity === previousIdentity && canonicalRow !== previousCanonicalRow) {
      throw schemaError(
        'position-source-record-hash-collision',
        '平盘来源记录 row_hash 对应了不同规范内容，禁止迁移'
      );
    }
    previousIdentity = identity;
    previousCanonicalRow = canonicalRow;
  }
  assertNoDuplicateSourceLeg(db);
  const unresolvedConsumption = db.prepare(`
    SELECT c.id
    FROM position_consumed_sources c
    LEFT JOIN position_source_rows s
      ON s.source_type = c.source_type
     AND s.business_key = c.business_key
    GROUP BY c.id
    HAVING COUNT(s.id) <> 1
    LIMIT 1
  `).get();
  if (unresolvedConsumption) {
    throw schemaError(
      'position-source-record-key-unresolved',
      '平盘历史消费关系无法唯一解析来源记录，禁止迁移'
    );
  }
}

function createLegacyMigrationIndexes(db) {
  db.exec(`
    CREATE INDEX idx_position_source_identity_migration
      ON position_source_rows(source_type, row_hash, id);
    CREATE INDEX idx_position_link_source_leg_migration
      ON position_link_rows(source_row_id, leg_index, id);
  `);
}

function createIdentityMaps(db) {
  db.exec(`
    CREATE TEMP TABLE position_source_identity_map (
      old_id INTEGER PRIMARY KEY,
      owner_id INTEGER NOT NULL,
      source_record_key TEXT NOT NULL
    );
    INSERT INTO position_source_identity_map(old_id, owner_id, source_record_key)
    SELECT s.id, owner.owner_id, s.row_hash
    FROM position_source_rows s
    INNER JOIN (
      SELECT source_type, row_hash, MIN(id) AS owner_id
      FROM position_source_rows
      GROUP BY source_type, row_hash
    ) owner
      ON owner.source_type = s.source_type
     AND owner.row_hash = s.row_hash;

    CREATE INDEX temp.idx_position_source_identity_map_owner
      ON position_source_identity_map(owner_id, old_id);
  `);
  const inconsistentLegSet = db.prepare(`
    SELECT member.owner_id AS ownerId, member.old_id AS memberId,
           peer.old_id AS peerId, member_link.leg_index AS legIndex
    FROM position_source_identity_map member
    INNER JOIN position_source_identity_map peer
      ON peer.owner_id = member.owner_id
    INNER JOIN position_link_rows member_link
      ON member_link.source_row_id = member.old_id
    LEFT JOIN position_link_rows peer_link
      ON peer_link.source_row_id = peer.old_id
     AND peer_link.leg_index = member_link.leg_index
    WHERE peer_link.id IS NULL
    LIMIT 1
  `).get();
  if (inconsistentLegSet) {
    throw schemaError(
      'position-source-record-hash-collision',
      '完全重复来源行的链接腿集合不一致，禁止折叠迁移'
    );
  }

  db.exec(`
    CREATE TEMP TABLE position_link_identity_map (
      old_id INTEGER PRIMARY KEY,
      canonical_link_id INTEGER NOT NULL
    );
    INSERT INTO position_link_identity_map(old_id, canonical_link_id)
    SELECT link.id, MIN(candidate.id)
    FROM position_link_rows link
    INNER JOIN position_source_identity_map source_map
      ON source_map.old_id = link.source_row_id
    INNER JOIN position_link_rows candidate
      ON candidate.leg_index = link.leg_index
    INNER JOIN position_source_identity_map candidate_source
      ON candidate_source.old_id = candidate.source_row_id
     AND candidate_source.owner_id = source_map.owner_id
    GROUP BY link.id;
  `);
  const conflictingCollapsedLink = db.prepare(`
    SELECT source_map.owner_id AS ownerId, link.leg_index AS legIndex
    FROM position_link_rows link
    INNER JOIN position_source_identity_map source_map
      ON source_map.old_id = link.source_row_id
    GROUP BY source_map.owner_id, link.leg_index
    HAVING COUNT(DISTINCT quote(link.source_type)) > 1
       OR COUNT(DISTINCT quote(link.recon_id)) > 1
       OR COUNT(DISTINCT quote(link.merchant_id)) > 1
       OR COUNT(DISTINCT quote(link.currency)) > 1
       OR COUNT(DISTINCT quote(link.amount)) > 1
       OR COUNT(DISTINCT quote(link.fund_type)) > 1
       OR COUNT(DISTINCT quote(link.status)) > 1
       OR COUNT(DISTINCT quote(link.event_date)) > 1
       OR COUNT(DISTINCT quote(link.visible)) > 1
       OR COUNT(DISTINCT quote(link.linked_json)) > 1
    LIMIT 1
  `).get();
  if (conflictingCollapsedLink) {
    throw schemaError(
      'position-source-record-hash-collision',
      '完全重复来源行派生出了不同链接记录，禁止折叠迁移'
    );
  }
  const duplicateConsumption = db.prepare(`
    SELECT consumed.source_type AS sourceType,
           identity.source_record_key AS sourceRecordKey,
           consumed.leg_index AS legIndex,
           COUNT(*) AS count
    FROM position_consumed_sources consumed
    INNER JOIN position_source_rows source
      ON source.source_type = consumed.source_type
     AND source.business_key = consumed.business_key
    INNER JOIN position_source_identity_map identity
      ON identity.old_id = source.id
    GROUP BY consumed.source_type, identity.source_record_key, consumed.leg_index
    HAVING COUNT(*) > 1
    LIMIT 1
  `).get();
  if (duplicateConsumption) {
    throw schemaError(
      'position-source-consumption-duplicate',
      '平盘历史消费关系重复占用了同一来源记录，禁止迁移'
    );
  }
}

function migrateRunLineage(db) {
  const readRunLineageBatch = db.prepare(`
    SELECT *
    FROM position_run_rows
    WHERE id > ?
    ORDER BY id
    LIMIT 1000
  `);
  const resolveLink = db.prepare(`
    SELECT link_map.canonical_link_id AS canonicalLinkId,
           canonical_source.source_row_number AS sourceRowNumber,
           canonical_source.business_key AS businessKey,
           canonical_source.row_hash AS sourceRecordKey,
           canonical_source.source_type AS sourceType,
           canonical_link.leg_index AS legIndex,
           old_link.business_key AS oldBusinessKey,
           old_link.source_type AS oldSourceType
    FROM position_link_identity_map link_map
    INNER JOIN position_link_rows old_link ON old_link.id = link_map.old_id
    INNER JOIN position_link_rows canonical_link
      ON canonical_link.id = link_map.canonical_link_id
    INNER JOIN position_source_identity_map source_map
      ON source_map.old_id = canonical_link.source_row_id
    INNER JOIN position_source_rows canonical_source
      ON canonical_source.id = source_map.owner_id
    WHERE link_map.old_id = ?
  `);
  const update = db.prepare(`
    UPDATE position_run_rows
    SET lineage_json = ?, integrity_hash = ?
    WHERE id = ?
  `);
  const findDifference = db.prepare(`
    SELECT lineage_json AS lineageJson
    FROM position_differences
    WHERE run_id = ? AND biz_id = ?
  `);
  const updateDifference = db.prepare(`
    UPDATE position_differences
    SET lineage_json = ?, updated_at = CURRENT_TIMESTAMP
    WHERE run_id = ? AND biz_id = ?
  `);
  let lastId = 0;
  while (true) {
    const rows = readRunLineageBatch.all(lastId);
    if (rows.length === 0) break;
    for (const row of rows) {
      lastId = Number(row.id);
      const lineage = parseJson(
        row.lineage_json,
        `迁移运行血缘 ${row.run_id}/${row.biz_id}`
      );
      if (lineage.sourceLinkRowId === null
          || lineage.sourceLinkRowId === undefined
          || lineage.sourceLinkRowId === '') {
        if (Number(row.consumes_source) === 1) {
          throw schemaError(
            'position-source-record-key-unresolved',
            `平盘运行消费血缘缺少来源链接记录：run=${row.run_id}`
          );
        }
        continue;
      }
      const linkRowId = Number(lineage.sourceLinkRowId);
      if (!Number.isSafeInteger(linkRowId) || linkRowId < 1) {
        throw schemaError(
          'position-source-record-key-unresolved',
          `平盘运行血缘无法定位来源链接记录：run=${row.run_id}`
        );
      }
      const resolved = resolveLink.get(linkRowId);
      if (!resolved
          || text(resolved.oldSourceType) !== text(lineage.sourceType)
          || text(resolved.oldBusinessKey) !== text(lineage.sourceBusinessKey)
          || Number(resolved.legIndex) !== Number(lineage.sourceLegIndex)) {
        throw schemaError(
          'position-source-record-key-unresolved',
          `平盘运行血缘与来源链接记录不一致：run=${row.run_id}`
        );
      }
      if (lineage.sourceRecordKey
          && text(lineage.sourceRecordKey) !== text(resolved.sourceRecordKey)) {
        throw schemaError(
          'position-source-record-key-unresolved',
          `平盘运行血缘 sourceRecordKey 冲突：run=${row.run_id}`
        );
      }
      const migratedLineage = {
        ...lineage,
        sourceType: text(resolved.sourceType),
        sourceLinkRowId: Number(resolved.canonicalLinkId),
        sourceBusinessKey: text(resolved.businessKey),
        sourceRecordKey: text(resolved.sourceRecordKey),
        sourceRowNumber: Number(resolved.sourceRowNumber),
        sourceLegIndex: Number(resolved.legIndex)
      };
      const originalRow = parseJson(
        row.original_json,
        `迁移运行原始行 ${row.run_id}/${row.biz_id}`
      );
      const resultRow = parseJson(
        row.result_json,
        `迁移运行结果行 ${row.run_id}/${row.biz_id}`
      );
      const integrityHash = runRowIntegrityHash({
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
        changed: Number(row.changed) === 1,
        manualModified: Number(row.manual_modified) === 1,
        consumesSource: Number(row.consumes_source) === 1,
        originalRow,
        resultRow,
        lineage: migratedLineage
      });
      const migratedJson = serializeJson(migratedLineage);
      const difference = findDifference.get(row.run_id, row.biz_id);
      if (difference) {
        const differenceLineage = parseJson(
          difference.lineageJson,
          `迁移差异血缘 ${row.run_id}/${row.biz_id}`
        );
        if (stableJson(differenceLineage) !== stableJson(lineage)) {
          throw schemaError(
            'position-source-record-key-unresolved',
            `平盘运行血缘与差异血缘不一致：run=${row.run_id}`
          );
        }
        updateDifference.run(migratedJson, row.run_id, row.biz_id);
      }
      update.run(migratedJson, integrityHash, row.id);
    }
  }
}

function rebuildIdentityTables(db) {
  db.exec(`
    CREATE TABLE position_source_rows__large_import (
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
      UNIQUE(source_type, row_hash)
    );

    INSERT INTO position_source_rows__large_import(
      id, source_type, business_key, event_date, month_key,
      source_file_path, source_file_name, source_sheet, source_row_number,
      row_hash, raw_json, imported_at, updated_at
    )
    SELECT source.id, source.source_type, source.business_key,
           source.event_date, source.month_key, source.source_file_path,
           source.source_file_name, source.source_sheet, source.source_row_number,
           source.row_hash, source.raw_json, source.imported_at, source.updated_at
    FROM position_source_rows source
    INNER JOIN position_source_identity_map identity
      ON identity.old_id = source.id
     AND identity.owner_id = source.id
    ORDER BY source.id;

    CREATE TABLE position_link_rows__large_import (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_type TEXT NOT NULL,
      business_key TEXT NOT NULL,
      source_record_key TEXT NOT NULL,
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
      FOREIGN KEY(source_row_id)
        REFERENCES position_source_rows__large_import(id) ON DELETE CASCADE
    );

    INSERT INTO position_link_rows__large_import(
      id, source_type, business_key, source_record_key, source_row_id,
      source_row_number, ordinal, leg_index, recon_id, merchant_id, currency,
      amount, fund_type, status, event_date, visible, linked_json, created_at
    )
    SELECT link.id, owner.source_type, owner.business_key, owner.row_hash,
           identity.owner_id, owner.source_row_number, link.ordinal, link.leg_index,
           link.recon_id, link.merchant_id, link.currency, link.amount,
           link.fund_type, link.status, link.event_date, link.visible,
           link.linked_json, link.created_at
    FROM position_link_rows link
    INNER JOIN position_link_identity_map link_identity
      ON link_identity.old_id = link.id
     AND link_identity.canonical_link_id = link.id
    INNER JOIN position_source_identity_map identity
      ON identity.old_id = link.source_row_id
    INNER JOIN position_source_rows owner
      ON owner.id = identity.owner_id
    ORDER BY link.id;

    CREATE TABLE position_consumed_sources__large_import (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id INTEGER NOT NULL,
      source_type TEXT NOT NULL,
      business_key TEXT NOT NULL,
      source_record_key TEXT NOT NULL,
      leg_index INTEGER NOT NULL DEFAULT 0,
      bank_biz_id TEXT NOT NULL,
      confirmed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(run_id) REFERENCES position_runs(id) ON DELETE CASCADE,
      UNIQUE(source_type, source_record_key, leg_index)
    );

    INSERT INTO position_consumed_sources__large_import(
      id, run_id, source_type, business_key, source_record_key,
      leg_index, bank_biz_id, confirmed_at
    )
    SELECT consumed.id, consumed.run_id, consumed.source_type,
           consumed.business_key, identity.source_record_key,
           consumed.leg_index, consumed.bank_biz_id, consumed.confirmed_at
    FROM position_consumed_sources consumed
    INNER JOIN position_source_rows source
      ON source.source_type = consumed.source_type
     AND source.business_key = consumed.business_key
    INNER JOIN position_source_identity_map identity
      ON identity.old_id = source.id
    ORDER BY consumed.id;
  `);

  migrateRunLineage(db);

  db.exec(`
    DROP TABLE position_link_rows;
    DROP TABLE position_source_rows;
    ALTER TABLE position_source_rows__large_import RENAME TO position_source_rows;
    ALTER TABLE position_link_rows__large_import RENAME TO position_link_rows;

    DROP TABLE position_consumed_sources;
    ALTER TABLE position_consumed_sources__large_import
      RENAME TO position_consumed_sources;
  `);
}

function createModernIndexes(db) {
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_position_source_type_month
      ON position_source_rows(source_type, month_key);
    CREATE INDEX IF NOT EXISTS idx_position_source_type_business_key
      ON position_source_rows(source_type, business_key);
    CREATE INDEX IF NOT EXISTS idx_position_link_type_recon
      ON position_link_rows(source_type, recon_id);
    CREATE INDEX IF NOT EXISTS idx_position_link_type_account_currency
      ON position_link_rows(source_type, merchant_id, currency);
    CREATE UNIQUE INDEX IF NOT EXISTS uq_position_link_source_leg
      ON position_link_rows(source_row_id, leg_index);
    CREATE INDEX IF NOT EXISTS idx_position_link_type_source_order
      ON position_link_rows(source_type, source_row_id, leg_index, id);
    CREATE INDEX IF NOT EXISTS idx_position_consumed_sources_run
      ON position_consumed_sources(run_id, bank_biz_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_position_consumed_sources_bank
      ON position_consumed_sources(bank_biz_id);
  `);
}

function storeSchemaFingerprint(db, fingerprint) {
  db.prepare(`
    INSERT INTO position_meta(key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(POSITION_LARGE_IMPORT_SCHEMA_FINGERPRINT_KEY, fingerprint);
}

function ensurePositionLargeImportSchema({
  db,
  dbPath,
  expectedCheckpoint,
  availableBytesProvider
}) {
  if (!db || typeof db.exec !== 'function' || typeof db.prepare !== 'function') {
    throw new TypeError('平盘百万级 schema 迁移缺少 SQLite 连接');
  }
  const expected = normalizePositionCheckpoint(
    expectedCheckpoint,
    'schema 迁移基准 checkpoint'
  );
  if (!expected) {
    throw schemaError(
      'position-side-db-mismatch',
      '平盘百万级 schema 迁移缺少预期 checkpoint'
    );
  }

  db.exec('BEGIN IMMEDIATE');
  try {
    const lockedCheckpoint = readPositionDatabaseCheckpoint(db);
    if (!positionCheckpointsEqual(lockedCheckpoint, expected)) {
      throw schemaError(
        'position-side-db-mismatch',
        '平盘百万级 schema 迁移取得写锁后 checkpoint 已变化'
      );
    }
    assertCurrentPositionCheckpointHistory(db, lockedCheckpoint);
    const lockedShape = assertLegacyOrModernShape(db);
    let requiresSchemaWork = lockedShape === 'legacy';
    if (!requiresSchemaWork) {
      try {
        assertPositionLargeImportSchema(db, { requireStoredFingerprint: false });
      } catch (_error) {
        requiresSchemaWork = true;
      }
    }
    if (requiresSchemaWork) {
      assertPositionMigrationDiskSpace(dbPath, { availableBytesProvider });
    }
    if (lockedShape === 'legacy') {
      assertLegacyDataCanMigrate(db);
      createLegacyMigrationIndexes(db);
      createIdentityMaps(db);
      rebuildIdentityTables(db);
    }
    assertNoDuplicateSourceLeg(db);
    createModernIndexes(db);
    const foreignKeyFailures = db.prepare('PRAGMA foreign_key_check').all();
    if (foreignKeyFailures.length > 0) {
      throw schemaError(
        'position-large-import-schema-invalid',
        '平盘来源身份迁移后的外键校验失败'
      );
    }
    const fingerprint = positionLargeImportSchemaFingerprint(db);
    storeSchemaFingerprint(db, fingerprint);
    const quickCheck = db.prepare('PRAGMA quick_check').all();
    if (quickCheck.length !== 1 || text(Object.values(quickCheck[0] || {})[0]) !== 'ok') {
      throw schemaError(
        'position-large-import-schema-invalid',
        '平盘来源身份迁移后的 SQLite quick_check 未通过'
      );
    }
    const checkpointAfter = readPositionDatabaseCheckpoint(db);
    if (!positionCheckpointsEqual(checkpointAfter, lockedCheckpoint)) {
      throw schemaError(
        'position-side-db-mismatch',
        '平盘 schema-only 迁移错误地推进了业务 checkpoint'
      );
    }
    db.exec('COMMIT');
    return {
      migrated: lockedShape === 'legacy',
      fingerprint,
      checkpoint: lockedCheckpoint
    };
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch (_rollbackError) {
      // 保留原始错误。
    }
    throw error;
  } finally {
    try {
      db.exec(`
        DROP TABLE IF EXISTS temp.position_link_identity_map;
        DROP TABLE IF EXISTS temp.position_source_identity_map;
      `);
    } catch (_cleanupError) {
      // 临时映射随连接关闭自动清理，不覆盖迁移结果。
    }
  }
}

function ensurePositionLargeImportSchemaAtPath({
  sideDbPath,
  expectedCheckpoint,
  availableBytesProvider
}) {
  const resolvedPath = path.resolve(String(sideDbPath || ''));
  if (!String(sideDbPath || '').trim() || !fs.existsSync(resolvedPath)) {
    throw schemaError(
      'position-side-db-missing',
      '平盘百万级导入侧库不存在'
    );
  }
  const expected = normalizePositionCheckpoint(expectedCheckpoint);
  if (!expected) {
    throw schemaError(
      'position-side-db-mismatch',
      '平盘百万级 schema 迁移缺少预期 checkpoint'
    );
  }
  const db = new DatabaseSync(resolvedPath);
  try {
    db.exec('PRAGMA foreign_keys = ON;');
    db.exec('PRAGMA synchronous = NORMAL;');
    db.exec('PRAGMA busy_timeout = 30000;');
    db.exec('PRAGMA journal_mode = WAL;');
    db.exec('PRAGMA temp_store = FILE;');
    const current = readPositionDatabaseCheckpoint(db);
    if (!positionCheckpointsEqual(current, expected)) {
      throw schemaError(
        'position-side-db-mismatch',
        '平盘百万级 schema 迁移前 checkpoint 已变化'
      );
    }
    assertCurrentPositionCheckpointHistory(db, current);
    const result = ensurePositionLargeImportSchema({
      db,
      dbPath: resolvedPath,
      expectedCheckpoint: expected,
      availableBytesProvider
    });
    assertPositionLargeImportSchema(db);
    return result;
  } finally {
    db.close();
  }
}

module.exports = {
  POSITION_LARGE_IMPORT_SCHEMA_FINGERPRINT_KEY,
  REQUIRED_NAMED_INDEXES,
  assertPositionMigrationDiskSpace,
  assertPositionLargeImportSchema,
  positionLargeImportSchemaFingerprint,
  ensurePositionLargeImportSchema,
  ensurePositionLargeImportSchemaAtPath
};
