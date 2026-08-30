'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');

const { BANK_STATEMENT_FIELDS } = require('../../constants/bank-statement-fields');
const { sourceSnapshotMatchesStat } = require('../archive-center/source-snapshot');
const { resolveDuplicateInputFiles } = require('./input-classifier');
const {
  DUPLICATE_INPUT_ROLES,
  DUPLICATE_SPOOL_MAX_MANIFEST_BYTES,
  DUPLICATE_SPOOL_MAX_NDJSON_LINE_BYTES,
  DUPLICATE_SPOOL_SCHEMA_VERSION,
  duplicateSpoolPaths,
  normalizeManifestSource,
  normalizePairedImportDescriptor,
  normalizeSpoolDescriptor,
  spoolError
} = require('./spool-contract');
const { hashFile } = require('./spool-writer');
const { readDuplicateParserOutcome } = require('./parser-outcome');
const { validatePrivateSpoolDirectory } = require('./spool-filesystem');

function isPlainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value)));
}

function exactKeys(value, keys) {
  return isPlainObject(value) &&
    Object.keys(value).sort().join(',') === keys.slice().sort().join(',');
}

function readRegularFile(filePath, maxBytes, code, message, options = {}) {
  let stat;
  try { stat = fs.lstatSync(filePath); } catch (_error) { throw spoolError(code, message); }
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size < 0 || stat.size > maxBytes) {
    throw spoolError(code, message);
  }
  return Object.freeze({
    stat,
    ...(options.readBytes === false ? {} : { bytes: fs.readFileSync(filePath) })
  });
}

function normalizeCounts(value, role) {
  const keys = role === DUPLICATE_INPUT_ROLES.BANK
    ? ['rowCount']
    : ['rowCount', 'matchableRowCount', 'emptyBusinessOrderCount'];
  if (!exactKeys(value, keys) || keys.some((key) =>
    !Number.isSafeInteger(value[key]) || value[key] < 0)) {
    throw spoolError('DUPLICATE_SPOOL_MANIFEST_INVALID', 'Duplicate spool counts非法');
  }
  if (role === DUPLICATE_INPUT_ROLES.DOCUMENT &&
      value.matchableRowCount + value.emptyBusinessOrderCount !== value.rowCount) {
    throw spoolError('DUPLICATE_SPOOL_COUNT_MISMATCH', 'Document spool行数去向不守恒');
  }
  return Object.freeze(Object.fromEntries(keys.map((key) => [key, value[key]])));
}

function normalizeRowsArtifact(value, paths) {
  if (!exactKeys(value, ['basename', 'byteSize', 'sha256', 'count']) ||
      value.basename !== path.basename(paths.rowsReady) ||
      !Number.isSafeInteger(value.byteSize) || value.byteSize < 0 ||
      !Number.isSafeInteger(value.count) || value.count < 0 ||
      typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.sha256)) {
    throw spoolError('DUPLICATE_SPOOL_MANIFEST_INVALID', 'Duplicate rows artifact非法');
  }
  return Object.freeze({ ...value });
}

function readDuplicateSpoolManifest(rawDescriptor) {
  const descriptor = normalizeSpoolDescriptor(rawDescriptor);
  const paths = duplicateSpoolPaths(descriptor);
  validatePrivateSpoolDirectory(descriptor);
  const manifestFile = readRegularFile(
    paths.manifestReady,
    DUPLICATE_SPOOL_MAX_MANIFEST_BYTES,
    'DUPLICATE_SPOOL_MANIFEST_INVALID',
    'Duplicate spool manifest缺失、过大或不是普通文件'
  );
  let parsed;
  try { parsed = JSON.parse(manifestFile.bytes.toString('utf8')); } catch (_error) {
    throw spoolError('DUPLICATE_SPOOL_MANIFEST_INVALID', 'Duplicate spool manifest不是合法JSON');
  }
  const manifestKeys = [
    'schemaVersion', 'jobId', 'operationKey', 'producerTaskRunId', 'slotIndex', 'unitId',
    'role', 'source', 'classification', 'counts', 'files'
  ];
  if (!exactKeys(parsed, manifestKeys) || parsed.schemaVersion !== DUPLICATE_SPOOL_SCHEMA_VERSION ||
      parsed.jobId !== descriptor.jobId || parsed.operationKey !== descriptor.operationKey ||
      parsed.producerTaskRunId !== descriptor.producerTaskRunId ||
      parsed.slotIndex !== descriptor.slotIndex || parsed.unitId !== descriptor.unitId ||
      !Object.values(DUPLICATE_INPUT_ROLES).includes(parsed.role)) {
    throw spoolError('DUPLICATE_SPOOL_IDENTITY_MISMATCH', 'Duplicate spool manifest identity不匹配');
  }
  const source = normalizeManifestSource(parsed.source);
  if (source.fileName !== path.basename(descriptor.source.filePath)) {
    throw spoolError('DUPLICATE_SPOOL_IDENTITY_MISMATCH', 'Duplicate spool source fileName不匹配');
  }
  if (!exactKeys(parsed.classification, ['isBank', 'sheetNames']) ||
      typeof parsed.classification.isBank !== 'boolean' ||
      !Array.isArray(parsed.classification.sheetNames) ||
      parsed.classification.sheetNames.some((value) => typeof value !== 'string') ||
      parsed.classification.isBank !== (parsed.role === DUPLICATE_INPUT_ROLES.BANK)) {
    throw spoolError('DUPLICATE_SPOOL_MANIFEST_INVALID', 'Duplicate spool classification非法');
  }
  if (!exactKeys(parsed.files, ['rows'])) {
    throw spoolError('DUPLICATE_SPOOL_MANIFEST_INVALID', 'Duplicate spool files非法');
  }
  const counts = normalizeCounts(parsed.counts, parsed.role);
  const rows = normalizeRowsArtifact(parsed.files.rows, paths);
  if (rows.count !== counts.rowCount) {
    throw spoolError('DUPLICATE_SPOOL_COUNT_MISMATCH', 'Duplicate manifest rows count不守恒');
  }
  return Object.freeze({
    schemaVersion: parsed.schemaVersion,
    jobId: parsed.jobId,
    operationKey: parsed.operationKey,
    producerTaskRunId: parsed.producerTaskRunId,
    slotIndex: parsed.slotIndex,
    unitId: parsed.unitId,
    role: parsed.role,
    source,
    classification: Object.freeze({
      isBank: parsed.classification.isBank,
      sheetNames: Object.freeze(parsed.classification.sheetNames.slice())
    }),
    counts,
    files: Object.freeze({ rows }),
    manifestSha256: crypto.createHash('sha256').update(manifestFile.bytes).digest('hex'),
    descriptor,
    paths
  });
}

async function assertSourceIdentity(manifest) {
  let stat;
  try { stat = fs.lstatSync(manifest.descriptor.source.filePath, { bigint: true }); } catch (_error) {
    throw spoolError('DUPLICATE_SPOOL_SOURCE_CHANGED', 'Duplicate spool源文件不可读或已变化');
  }
  if (stat.isSymbolicLink() || !stat.isFile() ||
      !sourceSnapshotMatchesStat(manifest.source.snapshot, stat) ||
      await hashFile(manifest.descriptor.source.filePath) !== manifest.source.sha256) {
    throw spoolError('DUPLICATE_SPOOL_SOURCE_CHANGED', 'Duplicate spool源文件不可读或已变化');
  }
}

function rowText(value) {
  return value === null || value === undefined ? '' : String(value).trim();
}

function validateBankRow(row, ordinal, state) {
  if (!exactKeys(row, ['sourceOrdinal', 'excelRowNumber', 'bizId', 'fundType', 'raw']) ||
      row.sourceOrdinal !== ordinal || row.excelRowNumber !== ordinal + 2 ||
      typeof row.bizId !== 'string' || !row.bizId || row.bizId.trim() !== row.bizId ||
      typeof row.fundType !== 'string' ||
      !exactKeys(row.raw, BANK_STATEMENT_FIELDS) ||
      row.bizId !== rowText(row.raw.BizId) || row.fundType !== rowText(row.raw.FundType) ||
      state.bankBizIds.has(row.bizId)) {
    throw spoolError('DUPLICATE_SPOOL_ROW_INVALID', `Bank spool第${ordinal + 1}行非法`);
  }
  state.bankBizIds.add(row.bizId);
}

function validateDocumentRow(row, ordinal, state) {
  const keys = [
    'sourceOrdinal', 'excelRowNumber', 'businessOrderNo', 'businessOrderKey',
    'userNo', 'accountNo', 'businessDepartment'
  ];
  if (!exactKeys(row, keys) || row.sourceOrdinal !== ordinal ||
      !Number.isSafeInteger(row.excelRowNumber) || row.excelRowNumber < 2 ||
      (ordinal > 0 && row.excelRowNumber <= state.previousExcelRowNumber) ||
      keys.slice(2).some((key) => typeof row[key] !== 'string') ||
      row.businessOrderKey !== row.businessOrderNo.trim()) {
    throw spoolError('DUPLICATE_SPOOL_ROW_INVALID', `Document spool第${ordinal + 1}行非法`);
  }
  state.previousExcelRowNumber = row.excelRowNumber;
  if (row.businessOrderKey) state.matchableRowCount += 1;
  else state.emptyBusinessOrderCount += 1;
}

async function consumeRows(manifest, onRow) {
  validatePrivateSpoolDirectory(manifest.descriptor);
  const rowsFile = readRegularFile(
    manifest.paths.rowsReady,
    Number.MAX_SAFE_INTEGER,
    'DUPLICATE_SPOOL_ROWS_INVALID',
    'Duplicate rows spool缺失或不是普通文件',
    { readBytes: false }
  );
  if (rowsFile.stat.size !== manifest.files.rows.byteSize) {
    throw spoolError('DUPLICATE_SPOOL_ROWS_INVALID', 'Duplicate rows spool byteSize不匹配');
  }
  const input = fs.createReadStream(manifest.paths.rowsReady);
  const hash = crypto.createHash('sha256');
  input.on('data', (chunk) => hash.update(chunk));
  const reader = readline.createInterface({ input, crlfDelay: Infinity });
  let ordinal = 0;
  const state = {
    bankBizIds: new Set(),
    previousExcelRowNumber: 0,
    matchableRowCount: 0,
    emptyBusinessOrderCount: 0
  };
  try {
    for await (const line of reader) {
      if (Buffer.byteLength(line, 'utf8') > DUPLICATE_SPOOL_MAX_NDJSON_LINE_BYTES || line.length === 0) {
        throw spoolError('DUPLICATE_SPOOL_ROW_INVALID', 'Duplicate spool存在空行或超长行');
      }
      let row;
      try { row = JSON.parse(line); } catch (_error) {
        throw spoolError('DUPLICATE_SPOOL_ROW_INVALID', `Duplicate spool第${ordinal + 1}行JSON非法`);
      }
      if (manifest.role === DUPLICATE_INPUT_ROLES.BANK) validateBankRow(row, ordinal, state);
      else validateDocumentRow(row, ordinal, state);
      if (onRow) await onRow(row);
      ordinal += 1;
    }
  } finally {
    reader.close();
  }
  if (ordinal !== manifest.counts.rowCount || ordinal !== manifest.files.rows.count ||
      hash.digest('hex') !== manifest.files.rows.sha256) {
    throw spoolError('DUPLICATE_SPOOL_COUNT_MISMATCH', 'Duplicate spool hash或行数不守恒');
  }
  if (manifest.role === DUPLICATE_INPUT_ROLES.DOCUMENT &&
      (state.matchableRowCount !== manifest.counts.matchableRowCount ||
       state.emptyBusinessOrderCount !== manifest.counts.emptyBusinessOrderCount)) {
    throw spoolError('DUPLICATE_SPOOL_COUNT_MISMATCH', 'Document spool disposition不守恒');
  }
  return manifest.counts;
}

async function validateDuplicateInputSpool(rawDescriptor) {
  const prevalidated = rawDescriptor && rawDescriptor.descriptor ? rawDescriptor : null;
  const manifest = readDuplicateSpoolManifest(prevalidated ? prevalidated.descriptor : rawDescriptor);
  if (prevalidated && manifest.manifestSha256 !== prevalidated.manifestSha256) {
    throw spoolError('DUPLICATE_SPOOL_MANIFEST_CHANGED', 'Duplicate spool manifest校验后发生变化');
  }
  await assertSourceIdentity(manifest);
  await consumeRows(manifest, null);
  await assertSourceIdentity(manifest);
  return manifest;
}

async function consumeDuplicateInputSpool(prevalidatedManifest, onRow) {
  const manifest = prevalidatedManifest && prevalidatedManifest.descriptor
    ? prevalidatedManifest
    : readDuplicateSpoolManifest(prevalidatedManifest);
  await assertSourceIdentity(manifest);
  const counts = await consumeRows(manifest, onRow);
  await assertSourceIdentity(manifest);
  return counts;
}

function resolveDuplicateSpoolPair(rawPairedDescriptor) {
  const paired = normalizePairedImportDescriptor(rawPairedDescriptor);
  const manifests = paired.spools.map(readDuplicateSpoolManifest);
  const resolved = resolveDuplicateInputFiles(manifests.map((manifest) => ({
    filePath: manifest.descriptor.source.filePath,
    fileName: manifest.source.fileName,
    sheetNames: manifest.classification.sheetNames,
    isBank: manifest.classification.isBank,
    manifest
  })));
  return Object.freeze({
    bank: resolved.bank.manifest,
    document: resolved.document.manifest,
    byRole: Object.freeze([resolved.bank.manifest, resolved.document.manifest])
  });
}

async function validateDuplicateSpoolPair(rawPairedDescriptor) {
  const pair = resolveDuplicateSpoolPair(rawPairedDescriptor);
  await Promise.all([
    validateDuplicateInputSpool(pair.bank),
    validateDuplicateInputSpool(pair.document)
  ]);
  return pair;
}

function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    let timer = null;
    const cleanup = () => {
      if (signal) signal.removeEventListener('abort', onAbort);
    };
    const onAbort = () => {
      if (timer) clearTimeout(timer);
      cleanup();
      const error = new Error('Duplicate Service正在关闭');
      error.code = 'DUPLICATE_SHUTDOWN';
      reject(error);
    };
    if (signal && signal.aborted) return onAbort();
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
  });
}

async function waitForDuplicateSpoolPairReady(rawPairedDescriptor, options = {}) {
  const paired = normalizePairedImportDescriptor(rawPairedDescriptor);
  const signal = options.signal || null;
  const pollIntervalMs = options.pollIntervalMs || 10;
  while (true) {
    if (signal && signal.aborted) {
      const error = new Error('Duplicate Service正在关闭');
      error.code = 'DUPLICATE_SHUTDOWN';
      throw error;
    }
    const outcomes = paired.spools.map(readDuplicateParserOutcome);
    for (const outcome of outcomes) {
      if (outcome && outcome.status === 'failed') {
        const error = new Error(`Duplicate Parser未形成可用spool（${outcome.causeCode}）`);
        error.code = 'DUPLICATE_PARSER_FAILED';
        error.causeCode = outcome.causeCode;
        throw error;
      }
    }
    if (outcomes.every((outcome) => outcome && outcome.status === 'succeeded')) {
      const pair = resolveDuplicateSpoolPair(paired);
      for (const manifest of pair.byRole) {
        const outcome = outcomes[manifest.slotIndex];
        if (outcome.role !== manifest.role || outcome.rowCount !== manifest.counts.rowCount) {
          throw spoolError(
            'DUPLICATE_PARSER_OUTCOME_INVALID',
            'Parser success outcome与spool manifest不匹配'
          );
        }
      }
      return pair;
    }
    await delay(pollIntervalMs, signal);
  }
}

module.exports = {
  assertSourceIdentity,
  consumeDuplicateInputSpool,
  readDuplicateSpoolManifest,
  resolveDuplicateSpoolPair,
  validateDuplicateInputSpool,
  validateDuplicateSpoolPair,
  waitForDuplicateSpoolPairReady
};
