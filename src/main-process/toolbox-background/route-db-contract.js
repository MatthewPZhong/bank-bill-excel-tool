'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const v8 = require('node:v8');
const { DatabaseSync } = require('node:sqlite');

const {
  createToolboxCell,
  createToolboxRow,
  createToolboxSheetMeta
} = require('../../backend/toolbox-format/model');
const { normalizeStaticStyle } = require('../../backend/toolbox-format/style-registry');

const ROUTE_DB_SCHEMA_VERSION = 1;
const ROUTE_DB_CODEC_VERSION = 1;
const ROUTE_DB_MANIFEST_VERSION = 1;
const ROUTE_DB_MAX_OUTPUTS = 8;
const ROUTE_DB_SUFFIXES = Object.freeze(['-wal', '-shm', '-journal']);

function routeError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function sha256Bytes(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function sha256FileSync(filePath) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(filePath, 'r');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let read;
    do {
      read = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (read > 0) hash.update(buffer.subarray(0, read));
    } while (read > 0);
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

function stableJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => (
    `${JSON.stringify(key)}:${stableJson(value[key])}`
  )).join(',')}}`;
}

function outputPlanHash(groups, generations) {
  return sha256Bytes(Buffer.from(stableJson({
    groups: groups.map((group) => ({
      outputIndex: group.outputIndex,
      outputId: group.outputId,
      field: group.field,
      values: Array.from(group.values)
    })),
    generations: generations.map((generation) => ({
      outputIndex: generation.outputIndex,
      outputId: generation.outputId,
      outputArtifactKey: generation.outputArtifactKey
    }))
  }), 'utf8'));
}

function compactStyleRef(ref, baseRegistryId = null) {
  if (!ref) return null;
  return ref.sourceRegistryId === baseRegistryId
    ? ref.styleRef
    : [ref.sourceRegistryId, ref.styleRef];
}

function expandStyleRef(value, baseRegistryId = null) {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value) && value.length === 2) {
    return { sourceRegistryId: value[0], styleRef: value[1] };
  }
  if (baseRegistryId && Number.isInteger(value)) {
    return { sourceRegistryId: baseRegistryId, styleRef: value };
  }
  throw routeError('TOOLBOX_ROUTE_CODEC_INVALID', 'Route DB style ref非法');
}

function rowBaseRegistryId(row) {
  const ids = new Set();
  if (row && row.effectiveStyleRef) ids.add(row.effectiveStyleRef.sourceRegistryId);
  for (const cell of Array.isArray(row && row.cells) ? row.cells : []) {
    if (cell && cell.effectiveStyleRef) ids.add(cell.effectiveStyleRef.sourceRegistryId);
  }
  return ids.size === 1 ? ids.values().next().value : null;
}

function compactCell(cell, row, baseRegistryId) {
  return [
    cell.rawLexicalValue,
    cell.cachedValue,
    cell.cellType,
    cell.decodedSemanticValue,
    cell.matchProjectionValue,
    cell.sourceStyleId,
    compactStyleRef(cell.effectiveStyleRef, baseRegistryId),
    cell.isExplicitCell,
    cell.sourceDateSystem === 1904 ? 1904 : 1900,
    cell.sourceFormat === 'General' ? null : cell.sourceFormat,
    cell.sourceFile === row.sourceFile ? null : cell.sourceFile,
    cell.sourceSheet === row.sourceSheet ? null : cell.sourceSheet,
    cell.rowIndex === row.rowIndex ? null : cell.rowIndex,
    cell.columnIndex,
    cell.hasFormula,
    cell.formulaLexical
  ];
}

function compactRow(row) {
  const baseRegistryId = rowBaseRegistryId(row);
  return [
    row.rowIndex,
    row.height,
    row.hidden,
    row.outlineLevel,
    row.sourceStyleId,
    compactStyleRef(row.effectiveStyleRef, baseRegistryId),
    row.customFormat,
    row.sourceFile,
    row.sourceSheet,
    baseRegistryId,
    row.cells.map((cell) => compactCell(cell, row, baseRegistryId))
  ];
}

function compactPayload(kind, value) {
  if (kind === 'row') return compactRow(value);
  if (kind === 'header') {
    return [value.normalizedHeaders, compactRow(value.headerRow), value.sheetMeta];
  }
  if (kind === 'style') return value;
  throw routeError('TOOLBOX_ROUTE_CODEC_INVALID', 'Route DB payload类型非法');
}

function encodePayload(kind, value) {
  return v8.serialize([ROUTE_DB_CODEC_VERSION, kind, compactPayload(kind, value)]);
}

function decodeEnvelope(bytes, expectedKind) {
  let decoded;
  try {
    decoded = v8.deserialize(Buffer.from(bytes));
  } catch (_error) {
    throw routeError('TOOLBOX_ROUTE_CODEC_INVALID', 'Route DB payload无法解码');
  }
  if (!Array.isArray(decoded) || decoded.length !== 3 ||
      decoded[0] !== ROUTE_DB_CODEC_VERSION || decoded[1] !== expectedKind) {
    throw routeError('TOOLBOX_ROUTE_CODEC_VERSION_UNSUPPORTED', 'Route DB payload版本或类型不受支持');
  }
  return decoded[2];
}

function expandCell(value, row, baseRegistryId) {
  if (!Array.isArray(value) || value.length !== 16) {
    throw routeError('TOOLBOX_ROUTE_CODEC_INVALID', 'Route DB cell payload非法');
  }
  return createToolboxCell({
    rawLexicalValue: value[0],
    cachedValue: value[1],
    cellType: value[2],
    decodedSemanticValue: value[3],
    matchProjectionValue: value[4],
    sourceStyleId: value[5],
    effectiveStyleRef: expandStyleRef(value[6], baseRegistryId),
    isExplicitCell: value[7],
    sourceDateSystem: value[8],
    sourceFormat: value[9] === null ? 'General' : value[9],
    sourceFile: value[10] === null ? row.sourceFile : value[10],
    sourceSheet: value[11] === null ? row.sourceSheet : value[11],
    rowIndex: value[12] === null ? row.rowIndex : value[12],
    columnIndex: value[13],
    hasFormula: value[14],
    formulaLexical: value[15]
  });
}

function expandRow(value) {
  if (!Array.isArray(value) || value.length !== 11 || !Array.isArray(value[10])) {
    throw routeError('TOOLBOX_ROUTE_CODEC_INVALID', 'Route DB row payload非法');
  }
  const rowContext = { rowIndex: value[0], sourceFile: value[7], sourceSheet: value[8] };
  return createToolboxRow({
    rowIndex: value[0],
    height: value[1],
    hidden: value[2],
    outlineLevel: value[3],
    sourceStyleId: value[4],
    effectiveStyleRef: expandStyleRef(value[5], value[9]),
    customFormat: value[6],
    sourceFile: value[7],
    sourceSheet: value[8],
    cells: value[10].map((cell) => expandCell(cell, rowContext, value[9]))
  });
}

function decodeRowPayload(bytes) {
  return expandRow(decodeEnvelope(bytes, 'row'));
}

function decodeHeaderPayload(bytes) {
  const value = decodeEnvelope(bytes, 'header');
  if (!Array.isArray(value) || value.length !== 3 ||
      !Array.isArray(value[0]) || value[0].length === 0) {
    throw routeError('TOOLBOX_ROUTE_CODEC_INVALID', 'Route DB表头payload非法');
  }
  const headerRow = expandRow(value[1]);
  return Object.freeze({
    normalizedHeaders: Object.freeze(value[0].map(String)),
    rawHeaderCells: headerRow.cells,
    headerRow,
    sheetMeta: createToolboxSheetMeta(value[2] || {})
  });
}

function decodeStylePayload(bytes) {
  return normalizeStaticStyle(decodeEnvelope(bytes, 'style'));
}

function routeMaskForIndexes(indexes, outputCount) {
  if (!Number.isSafeInteger(outputCount) || outputCount < 1 || outputCount > ROUTE_DB_MAX_OUTPUTS) {
    throw routeError('TOOLBOX_ROUTE_MASK_INVALID', 'Route DB输出数量非法');
  }
  let mask = 0;
  for (const index of indexes) {
    if (!Number.isSafeInteger(index) || index < 0 || index >= outputCount) {
      throw routeError('TOOLBOX_ROUTE_MASK_INVALID', 'Route DB outputIndex非法');
    }
    mask |= (1 << index);
  }
  return Buffer.from([mask]);
}

function routeMaskIncludes(bytes, outputIndex) {
  const mask = Buffer.from(bytes || []);
  if (mask.length !== 1 || !Number.isSafeInteger(outputIndex) ||
      outputIndex < 0 || outputIndex >= ROUTE_DB_MAX_OUTPUTS) {
    throw routeError('TOOLBOX_ROUTE_MASK_INVALID', 'Route DB route_mask非法');
  }
  return (mask[0] & (1 << outputIndex)) !== 0;
}

function assertNoRouteSidecars(dbPath) {
  for (const suffix of ROUTE_DB_SUFFIXES) {
    if (fs.existsSync(`${dbPath}${suffix}`)) {
      throw routeError('TOOLBOX_ROUTE_DB_NOT_SEALED', `Route DB仍存在${suffix} sidecar`);
    }
  }
}

function readRouteManifest(manifestPath) {
  let stat;
  let bytes;
  try {
    stat = fs.lstatSync(manifestPath);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('not-file');
    bytes = fs.readFileSync(manifestPath);
  } catch (_error) {
    throw routeError('TOOLBOX_ROUTE_MANIFEST_MISSING', 'Route DB sealed manifest不存在');
  }
  let value;
  try {
    value = JSON.parse(bytes.toString('utf8'));
  } catch (_error) {
    throw routeError('TOOLBOX_ROUTE_MANIFEST_INVALID', 'Route DB sealed manifest非法');
  }
  const expectedKeys = [
    'manifestVersion', 'schemaVersion', 'codecVersion', 'dbFileName', 'byteSize',
    'sha256', 'rowCount', 'styleCount', 'outputPlanHash', 'sourceSha256', 'sealedAt'
  ].sort();
  const actualKeys = value && typeof value === 'object' && !Array.isArray(value)
    ? Object.keys(value).sort()
    : [];
  if (actualKeys.length !== expectedKeys.length ||
      actualKeys.some((key, index) => key !== expectedKeys[index]) ||
      value.manifestVersion !== ROUTE_DB_MANIFEST_VERSION ||
      value.schemaVersion !== ROUTE_DB_SCHEMA_VERSION ||
      value.codecVersion !== ROUTE_DB_CODEC_VERSION ||
      path.basename(value.dbFileName || '') !== value.dbFileName ||
      !Number.isSafeInteger(value.byteSize) || value.byteSize <= 0 ||
      !/^[a-f0-9]{64}$/.test(value.sha256) ||
      !Number.isSafeInteger(value.rowCount) || value.rowCount < 0 ||
      !Number.isSafeInteger(value.styleCount) || value.styleCount < 1 ||
      !/^[a-f0-9]{64}$/.test(value.outputPlanHash) ||
      !/^[a-f0-9]{64}$/.test(value.sourceSha256) ||
      !Number.isFinite(Date.parse(value.sealedAt))) {
    throw routeError('TOOLBOX_ROUTE_MANIFEST_INVALID', 'Route DB sealed manifest字段非法');
  }
  return Object.freeze({
    value: Object.freeze({ ...value }),
    artifact: Object.freeze({ byteSize: bytes.length, sha256: sha256Bytes(bytes) })
  });
}

function inspectSealedRouteDb({ dbPath, manifestPath, expectedOutputPlanHash = null }) {
  const resolvedDbPath = path.resolve(dbPath);
  const resolvedManifestPath = path.resolve(manifestPath);
  const manifest = readRouteManifest(resolvedManifestPath);
  if (manifest.value.dbFileName !== path.basename(resolvedDbPath) ||
      (expectedOutputPlanHash && manifest.value.outputPlanHash !== expectedOutputPlanHash)) {
    throw routeError('TOOLBOX_ROUTE_MANIFEST_MISMATCH', 'Route DB manifest ownership不一致');
  }
  assertNoRouteSidecars(resolvedDbPath);
  let stat;
  try {
    stat = fs.lstatSync(resolvedDbPath);
  } catch (_error) {
    throw routeError('TOOLBOX_ROUTE_DB_MISSING', 'Route DB不存在');
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== manifest.value.byteSize ||
      sha256FileSync(resolvedDbPath) !== manifest.value.sha256) {
    throw routeError('TOOLBOX_ROUTE_DB_HASH_MISMATCH', 'Route DB文件身份、大小或SHA-256不一致');
  }
  const db = new DatabaseSync(resolvedDbPath, { readOnly: true });
  try {
    db.exec('PRAGMA query_only=ON');
    const integrity = db.prepare('PRAGMA integrity_check').get();
    if (!integrity || integrity.integrity_check !== 'ok') {
      throw routeError('TOOLBOX_ROUTE_DB_INTEGRITY_FAILED', 'Route DB integrity_check失败');
    }
    const meta = db.prepare('SELECT * FROM route_meta').get();
    const metaCount = Number(db.prepare('SELECT COUNT(*) AS count FROM route_meta').get().count);
    const rowCount = Number(db.prepare('SELECT COUNT(*) AS count FROM route_rows').get().count);
    const styleCount = Number(db.prepare('SELECT COUNT(*) AS count FROM route_styles').get().count);
    if (!meta || metaCount !== 1 || meta.schema_version !== ROUTE_DB_SCHEMA_VERSION ||
        meta.codec_version !== ROUTE_DB_CODEC_VERSION || meta.sealed_at !== manifest.value.sealedAt ||
        meta.output_plan_hash !== manifest.value.outputPlanHash ||
        meta.source_sha256 !== manifest.value.sourceSha256 ||
        rowCount !== manifest.value.rowCount || styleCount !== manifest.value.styleCount) {
      throw routeError('TOOLBOX_ROUTE_DB_META_MISMATCH', 'Route DB meta/count与sealed manifest不一致');
    }
    return Object.freeze({
      ...manifest.value,
      manifestArtifact: manifest.artifact,
      inputDataRowCount: Number(meta.input_data_row_count),
      inputSheetCount: Number(meta.input_sheet_count),
      skippedHiddenSheetCount: Number(meta.skipped_hidden_sheet_count),
      skippedEmptySheetCount: Number(meta.skipped_empty_sheet_count)
    });
  } finally {
    db.close();
  }
}

module.exports = {
  ROUTE_DB_CODEC_VERSION,
  ROUTE_DB_MANIFEST_VERSION,
  ROUTE_DB_MAX_OUTPUTS,
  ROUTE_DB_SCHEMA_VERSION,
  assertNoRouteSidecars,
  decodeHeaderPayload,
  decodeRowPayload,
  decodeStylePayload,
  encodePayload,
  inspectSealedRouteDb,
  outputPlanHash,
  readRouteManifest,
  routeMaskForIndexes,
  routeMaskIncludes,
  sha256Bytes,
  sha256FileSync
};
