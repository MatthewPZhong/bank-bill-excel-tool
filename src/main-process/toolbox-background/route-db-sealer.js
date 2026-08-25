'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const { createSplitFilter, assertUniqueSplitHeaders } = require('../toolbox-format-operations');
const { streamToolboxTables, TOOLBOX_SHEET_STRATEGIES } = require('../toolbox-format-io');
const { fsyncDirectory, writeFileAtomicDurable } = require('../background-execution/durable-file');
const { assertSourcesFresh } = require('./generation-core');
const {
  ROUTE_DB_CODEC_VERSION,
  ROUTE_DB_MANIFEST_VERSION,
  ROUTE_DB_SCHEMA_VERSION,
  assertNoRouteSidecars,
  encodePayload,
  outputPlanHash,
  routeMaskForIndexes,
  sha256Bytes,
  sha256FileSync
} = require('./route-db-contract');

function routeError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function assertNotCancelled(signal) {
  if (signal && signal.aborted) {
    throw routeError('TOOLBOX_GENERATION_CANCELLED', '工具箱 Route DB 扫描已取消');
  }
}

function removeRouteFiles(dbPath, manifestPath) {
  for (const filePath of [manifestPath, dbPath, `${dbPath}-wal`, `${dbPath}-shm`, `${dbPath}-journal`]) {
    try { fs.rmSync(filePath, { force: true }); } catch (_error) { /* best effort */ }
  }
}

function fsyncFile(filePath) {
  const fd = fs.openSync(filePath, 'r+');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

function assertDirectoryDurable(result) {
  if (!result || (result.status !== 'committed' && result.capability !== 'supported')) {
    throw routeError('TOOLBOX_ROUTE_DURABILITY_UNAVAILABLE', 'Route DB目录fsync不可用');
  }
  return result;
}

function writeSealedManifest(manifestPath, value) {
  const bytes = Buffer.from(`${JSON.stringify(value)}\n`, 'utf8');
  const durability = writeFileAtomicDurable(manifestPath, bytes);
  assertDirectoryDurable(durability);
  return Object.freeze({ byteSize: bytes.length, sha256: sha256Bytes(bytes) });
}

async function scanAndSealRouteDb(input, signal) {
  const source = input.sources[0];
  const { dbPath, manifestPath } = input.route;
  const planHash = outputPlanHash(input.operation.groups, input.generations);
  removeRouteFiles(dbPath, manifestPath);
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  assertNotCancelled(signal);
  assertSourcesFresh(input.sources);
  const sourceSha256 = sha256FileSync(source.filePath);
  assertSourcesFresh(input.sources);

  let db = null;
  let transactionOpen = false;
  let headerPayload = null;
  let routeRowCount = 0;
  const sourceRegistryResolver = new Map();
  try {
    db = new DatabaseSync(dbPath);
    db.exec(`
      PRAGMA journal_mode=DELETE;
      PRAGMA synchronous=FULL;
      PRAGMA temp_store=MEMORY;
      CREATE TABLE route_meta (
        schema_version INTEGER NOT NULL,
        codec_version INTEGER NOT NULL,
        source_size INTEGER NOT NULL,
        source_mtime_ms REAL NOT NULL,
        source_sha256 TEXT NOT NULL,
        input_data_row_count INTEGER NOT NULL,
        input_sheet_count INTEGER NOT NULL,
        skipped_hidden_sheet_count INTEGER NOT NULL,
        skipped_empty_sheet_count INTEGER NOT NULL,
        output_plan_hash TEXT NOT NULL,
        header_payload BLOB NOT NULL,
        sealed_at TEXT NOT NULL
      );
      CREATE TABLE route_styles (
        source_registry_id TEXT NOT NULL,
        style_ref INTEGER NOT NULL,
        style_payload BLOB NOT NULL,
        PRIMARY KEY (source_registry_id, style_ref)
      ) WITHOUT ROWID;
      CREATE TABLE route_rows (
        source_row_index INTEGER PRIMARY KEY,
        sheet_index INTEGER NOT NULL,
        row_payload BLOB NOT NULL,
        route_mask BLOB NOT NULL
      );
    `);
    const insertRow = db.prepare(
      'INSERT INTO route_rows(source_row_index, sheet_index, row_payload, route_mask) VALUES (?, ?, ?, ?)'
    );
    db.exec('BEGIN IMMEDIATE');
    transactionOpen = true;
    let filters = null;
    let inputRowOrdinal = 0;
    const summary = await streamToolboxTables(source.filePath, {
      strategy: TOOLBOX_SHEET_STRATEGIES.SPLIT,
      sourceRegistryResolver,
      cancelToken: Object.freeze({
        get cancelled() { return Boolean(signal && signal.aborted); }
      }),
      onHeader(headerInfo) {
        assertUniqueSplitHeaders(headerInfo.normalizedHeaders);
        filters = input.operation.groups.map((group, index) => createSplitFilter(
          headerInfo.normalizedHeaders,
          group.field,
          group.values,
          [`输出${index + 1}：${group.outputId}`]
        ));
        headerPayload = encodePayload('header', {
          normalizedHeaders: headerInfo.normalizedHeaders,
          rawHeaderCells: headerInfo.rawHeaderCells,
          headerRow: headerInfo.headerRow,
          sheetMeta: headerInfo.sheetMeta
        });
      },
      onDataRow(row, rowInfo) {
        assertNotCancelled(signal);
        const indexes = [];
        filters.forEach((filter, index) => {
          if (filter.matches(rowInfo.matchValues)) indexes.push(index);
        });
        const sourceRowIndex = inputRowOrdinal;
        inputRowOrdinal += 1;
        if (indexes.length === 0) return;
        insertRow.run(
          sourceRowIndex,
          Number(rowInfo.sheet && rowInfo.sheet.sheetIndex) || 0,
          encodePayload('row', row),
          routeMaskForIndexes(indexes, input.operation.groups.length)
        );
        routeRowCount += 1;
      }
    });
    assertNotCancelled(signal);
    assertSourcesFresh(input.sources);
    if (!headerPayload) throw routeError('TOOLBOX_ROUTE_HEADER_MISSING', 'Route DB缺少逻辑表头');

    const insertStyle = db.prepare(
      'INSERT INTO route_styles(source_registry_id, style_ref, style_payload) VALUES (?, ?, ?)'
    );
    let styleCount = 0;
    for (const [sourceRegistryId, registry] of sourceRegistryResolver) {
      for (let styleRef = 0; styleRef < registry.size; styleRef += 1) {
        insertStyle.run(sourceRegistryId, styleRef, encodePayload('style', registry.get(styleRef)));
        styleCount += 1;
      }
    }
    if (styleCount < 1) throw routeError('TOOLBOX_ROUTE_STYLE_MISSING', 'Route DB缺少来源样式');
    const sealedAt = new Date().toISOString();
    db.prepare(`
      INSERT INTO route_meta(
        schema_version, codec_version, source_size, source_mtime_ms, source_sha256,
        input_data_row_count, input_sheet_count, skipped_hidden_sheet_count,
        skipped_empty_sheet_count, output_plan_hash, header_payload, sealed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      ROUTE_DB_SCHEMA_VERSION,
      ROUTE_DB_CODEC_VERSION,
      source.sourceSnapshot.sizeBytes,
      source.sourceSnapshot.mtimeMs,
      sourceSha256,
      Number(summary.dataRowCount) || 0,
      Number(summary.participatingSheetCount) || 0,
      Number(summary.hiddenSheetCount) || 0,
      Number(summary.emptySheetCount) || 0,
      planHash,
      headerPayload,
      sealedAt
    );
    db.exec('COMMIT');
    transactionOpen = false;
    const journalMode = db.prepare('PRAGMA journal_mode=DELETE').get();
    if (!journalMode || String(journalMode.journal_mode).toLowerCase() !== 'delete') {
      throw routeError('TOOLBOX_ROUTE_JOURNAL_MODE_INVALID', 'Route DB无法固定为DELETE journal mode');
    }
    db.close();
    db = null;
    assertNoRouteSidecars(dbPath);
    fsyncFile(dbPath);
    const directoryBarrier = fsyncDirectory(path.dirname(dbPath));
    assertDirectoryDurable(directoryBarrier);

    const readOnlyDb = new DatabaseSync(dbPath, { readOnly: true });
    try {
      readOnlyDb.exec('PRAGMA query_only=ON');
      const integrity = readOnlyDb.prepare('PRAGMA integrity_check').get();
      const metaCount = Number(readOnlyDb.prepare('SELECT COUNT(*) AS count FROM route_meta').get().count);
      const actualRows = Number(readOnlyDb.prepare('SELECT COUNT(*) AS count FROM route_rows').get().count);
      const actualStyles = Number(readOnlyDb.prepare('SELECT COUNT(*) AS count FROM route_styles').get().count);
      if (!integrity || integrity.integrity_check !== 'ok' || metaCount !== 1 ||
          actualRows !== routeRowCount || actualStyles !== styleCount) {
        throw routeError('TOOLBOX_ROUTE_DB_INTEGRITY_FAILED', 'Route DB seal只读复核失败');
      }
    } finally {
      readOnlyDb.close();
    }
    assertNoRouteSidecars(dbPath);
    const stat = fs.lstatSync(dbPath);
    const dbSha256 = sha256FileSync(dbPath);
    const manifestValue = Object.freeze({
      manifestVersion: ROUTE_DB_MANIFEST_VERSION,
      schemaVersion: ROUTE_DB_SCHEMA_VERSION,
      codecVersion: ROUTE_DB_CODEC_VERSION,
      dbFileName: path.basename(dbPath),
      byteSize: stat.size,
      sha256: dbSha256,
      rowCount: routeRowCount,
      styleCount,
      outputPlanHash: planHash,
      sourceSha256,
      sealedAt
    });
    const manifestArtifact = writeSealedManifest(manifestPath, manifestValue);
    return Object.freeze({ ...manifestValue, manifestArtifact });
  } catch (error) {
    if (db) {
      if (transactionOpen) {
        try { db.exec('ROLLBACK'); } catch (_rollbackError) { /* original error wins */ }
      }
      try { db.close(); } catch (_closeError) { /* original error wins */ }
    }
    removeRouteFiles(dbPath, manifestPath);
    if (signal && signal.aborted && error.code !== 'TOOLBOX_GENERATION_CANCELLED') {
      throw routeError('TOOLBOX_GENERATION_CANCELLED', '工具箱 Route DB 扫描已取消');
    }
    throw error;
  }
}

module.exports = {
  assertDirectoryDurable,
  removeRouteFiles,
  scanAndSealRouteDb
};
