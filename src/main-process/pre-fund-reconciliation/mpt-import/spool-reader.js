'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { TextDecoder } = require('node:util');

const {
  normalizeSourceSnapshot,
  sourceSnapshotFromStat,
  sourceSnapshotMatchesStat
} = require('../../archive-center/source-snapshot');
const {
  MPT_DELIMITER,
  MPT_SCHEMAS,
  buildGatewayFingerprint,
  normalizeDate,
  normalizeDecimalString
} = require('../mpt-schema');
const {
  MPT_SPOOL_FILE_NAMES,
  MPT_SPOOL_MAX_MANIFEST_BYTES,
  MPT_SPOOL_MAX_NDJSON_LINE_BYTES,
  MPT_SPOOL_SCHEMA_VERSION,
  buildHeaderIdentity,
  deriveFileIdentity,
  mptSpoolPaths,
  normalizeFileIndex,
  normalizeJobId,
  normalizeSource,
  spoolError,
  stableJson
} = require('./spool-contract');

const NORMALIZED_ROW_KEYS = Object.freeze([
  'sourceType', 'sourceBatch', 'sourceDate', 'sourceFileName', 'sourceFileSequence',
  'sourceRowNumber', 'reconciliationId', 'date', 'channel', 'merchantId', 'orderId',
  'billReconId', 'reconBillBizId', 'currency', 'amount', 'tradeType', 'name', 'cardNo',
  'realChannel', 'clearingNetwork', 'rawJson', 'fingerprint'
]);
const ISSUE_KEYS = Object.freeze([
  'code', 'message', 'detailLines', 'context', 'sourceRowNumber', 'fieldName', 'fields', 'rawLine'
]);
const ROW_TEXT_KEYS = Object.freeze(NORMALIZED_ROW_KEYS.filter((key) => key !== 'sourceRowNumber'));
const MAX_ISSUE_FIELDS = Math.floor((4 * 1024 * 1024) / MPT_DELIMITER.length) + 1;

function assertPlainObject(value, code, message) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw spoolError(code, message);
  }
  return value;
}

function assertExactKeys(value, keys, code, label) {
  assertPlainObject(value, code, `${label}必须是普通对象`);
  const actual = Object.keys(value).sort();
  const expected = keys.slice().sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw spoolError(code, `${label}字段非法`);
  }
}

function assertSafeCount(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw spoolError('PREFUND_SPOOL_MANIFEST_INVALID', `${label}必须是非负安全整数`);
  }
  return value;
}

function assertSha256(value, label) {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) {
    throw spoolError('PREFUND_SPOOL_MANIFEST_INVALID', `${label}必须是小写SHA-256`);
  }
  return value;
}

function assertRegularNoSymlink(filePath, code, maxBytes = null) {
  let stat;
  try { stat = fs.lstatSync(filePath, { bigint: true }); } catch (_error) {
    throw spoolError(code, `缺少文件：${path.basename(filePath)}`);
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw spoolError(code, `${path.basename(filePath)}必须是非符号链接普通文件`);
  }
  const size = Number(stat.size);
  if (!Number.isSafeInteger(size) || size < 0 || (maxBytes !== null && size > maxBytes)) {
    throw spoolError(code, `${path.basename(filePath)}长度非法`);
  }
  return stat;
}

function assertSafeDirectoryTree(paths) {
  const rootReal = fs.realpathSync(paths.taskStagingDir);
  for (const directory of [paths.mptDir, paths.jobDir, paths.fileDir]) {
    let stat;
    try { stat = fs.lstatSync(directory); } catch (_error) {
      throw spoolError('PREFUND_SPOOL_PATH_INVALID', 'MPT spool目录缺失');
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw spoolError('PREFUND_SPOOL_PATH_INVALID', 'MPT spool目录不能是符号链接且必须是目录');
    }
    const real = fs.realpathSync(directory);
    if (real !== rootReal && !real.startsWith(`${rootReal}${path.sep}`)) {
      throw spoolError('PREFUND_SPOOL_PATH_INVALID', 'MPT spool目录越过task staging边界');
    }
  }
}

function sha256RegularFile(filePath, expectedSnapshot = null) {
  const before = assertRegularNoSymlink(filePath, 'PREFUND_SPOOL_SOURCE_CHANGED');
  if (expectedSnapshot && !sourceSnapshotMatchesStat(expectedSnapshot, before)) {
    throw spoolError('PREFUND_SPOOL_SOURCE_CHANGED', 'MPT源文件快照已变化');
  }
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
  const after = fs.lstatSync(filePath, { bigint: true });
  if (!sourceSnapshotMatchesStat(sourceSnapshotFromStat(before), after)) {
    throw spoolError('PREFUND_SPOOL_SOURCE_CHANGED', 'MPT源文件在校验期间发生变化');
  }
  return hash.digest('hex');
}

function readManifest(paths) {
  const stat = assertRegularNoSymlink(
    paths.manifestReady,
    'PREFUND_SPOOL_MANIFEST_INVALID',
    MPT_SPOOL_MAX_MANIFEST_BYTES
  );
  const bytes = fs.readFileSync(paths.manifestReady);
  if (Number(stat.size) !== bytes.length || bytes.length < 3 || bytes[bytes.length - 1] !== 0x0a ||
      bytes.subarray(0, -1).includes(0x0a)) {
    throw spoolError('PREFUND_SPOOL_MANIFEST_INVALID', 'manifest必须是单行UTF-8 JSON');
  }
  let manifest;
  try { manifest = JSON.parse(bytes.subarray(0, -1).toString('utf8')); } catch (_error) {
    throw spoolError('PREFUND_SPOOL_MANIFEST_INVALID', 'manifest JSON无法解析');
  }
  return manifest;
}

function normalizeReadInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('MPT spool reader input必须是对象');
  }
  const fileIndex = normalizeFileIndex(input.fileIndex);
  const jobId = normalizeJobId(input.jobId);
  return Object.freeze({
    taskStagingDir: input.taskStagingDir,
    jobId,
    fileIndex,
    parentOperationKey: String(input.parentOperationKey == null ? '' : input.parentOperationKey).trim(),
    ...deriveFileIdentity(input.parentOperationKey, fileIndex),
    source: normalizeSource(input.source)
  });
}

function validateManifest(manifest, expected) {
  assertExactKeys(
    manifest,
    ['schemaVersion', 'jobId', 'fileIndex', 'fileOperationKey', 'unitId', 'source', 'header', 'counts', 'contentHash', 'files'],
    'PREFUND_SPOOL_MANIFEST_INVALID',
    'manifest'
  );
  if (manifest.schemaVersion !== MPT_SPOOL_SCHEMA_VERSION || manifest.jobId !== expected.jobId ||
      manifest.fileIndex !== expected.fileIndex ||
      manifest.fileOperationKey !== expected.fileOperationKey || manifest.unitId !== expected.unitId) {
    throw spoolError('PREFUND_SPOOL_IDENTITY_MISMATCH', 'manifest job/file operation身份不一致');
  }
  assertExactKeys(
    manifest.source,
    ['fileName', 'snapshot', 'sha256'],
    'PREFUND_SPOOL_MANIFEST_INVALID',
    'manifest.source'
  );
  const sourceSnapshot = normalizeSourceSnapshot(manifest.source.snapshot);
  if (!sourceSnapshot || stableJson(sourceSnapshot) !== stableJson(expected.source.sourceSnapshot) ||
      manifest.source.fileName !== path.basename(expected.source.filePath)) {
    throw spoolError('PREFUND_SPOOL_SOURCE_MISMATCH', 'manifest source snapshot或basename不一致');
  }
  assertSha256(manifest.source.sha256, 'manifest.source.sha256');
  assertSha256(manifest.contentHash, 'manifest.contentHash');
  if (manifest.source.sha256 !== manifest.contentHash) {
    throw spoolError('PREFUND_SPOOL_SOURCE_MISMATCH', 'manifest source hash与contentHash不一致');
  }

  assertExactKeys(
    manifest.header,
    ['sourceType', 'sourceBatch', 'sourceDate', 'sourceFileName', 'sourceFileSequence', 'declaredRowCount', 'identity'],
    'PREFUND_SPOOL_MANIFEST_INVALID',
    'manifest.header'
  );
  if (!MPT_SCHEMAS[manifest.header.sourceType] ||
      typeof manifest.header.sourceBatch !== 'string' || !manifest.header.sourceBatch ||
      normalizeDate(manifest.header.sourceDate) !== manifest.header.sourceDate ||
      manifest.header.sourceFileName !== manifest.source.fileName ||
      !/^[0-9]+$/.test(String(manifest.header.sourceFileSequence || '')) ||
      !Number.isSafeInteger(manifest.header.declaredRowCount) || manifest.header.declaredRowCount < 0 ||
      manifest.header.identity !== buildHeaderIdentity(manifest.header)) {
    throw spoolError('PREFUND_SPOOL_HEADER_IDENTITY_INVALID', 'manifest header identity非法');
  }

  assertExactKeys(
    manifest.counts,
    ['parsed', 'valid', 'error', 'excluded'],
    'PREFUND_SPOOL_MANIFEST_INVALID',
    'manifest.counts'
  );
  for (const key of ['parsed', 'valid', 'error', 'excluded']) {
    assertSafeCount(manifest.counts[key], `manifest.counts.${key}`);
  }
  if (manifest.counts.parsed !== manifest.header.declaredRowCount ||
      manifest.counts.valid + manifest.counts.error + manifest.counts.excluded !== manifest.counts.parsed) {
    throw spoolError('PREFUND_SPOOL_COUNT_MISMATCH', 'manifest候选计数不守恒');
  }

  assertExactKeys(manifest.files, ['rows', 'issues'], 'PREFUND_SPOOL_MANIFEST_INVALID', 'manifest.files');
  for (const [key, basename] of [['rows', MPT_SPOOL_FILE_NAMES.rowsReady], ['issues', MPT_SPOOL_FILE_NAMES.issuesReady]]) {
    const descriptor = manifest.files[key];
    assertExactKeys(
      descriptor,
      ['basename', 'byteSize', 'sha256', 'count'],
      'PREFUND_SPOOL_MANIFEST_INVALID',
      `manifest.files.${key}`
    );
    if (descriptor.basename !== basename || path.basename(descriptor.basename) !== descriptor.basename) {
      throw spoolError('PREFUND_SPOOL_PATH_INVALID', `${key} basename非法`);
    }
    assertSafeCount(descriptor.byteSize, `manifest.files.${key}.byteSize`);
    assertSafeCount(descriptor.count, `manifest.files.${key}.count`);
    assertSha256(descriptor.sha256, `manifest.files.${key}.sha256`);
  }
  if (manifest.files.rows.count !== manifest.counts.valid ||
      manifest.files.issues.count !== manifest.counts.error + manifest.counts.excluded) {
    throw spoolError('PREFUND_SPOOL_COUNT_MISMATCH', 'manifest文件计数与候选计数不一致');
  }
  return manifest;
}

function validateRowEnvelope(envelope, manifest) {
  assertExactKeys(envelope, ['kind', 'row'], 'PREFUND_SPOOL_ROW_SCHEMA_INVALID', 'row envelope');
  if (envelope.kind !== 'valid') {
    throw spoolError('PREFUND_SPOOL_ROW_SCHEMA_INVALID', 'rows.ndjson只能包含valid候选');
  }
  const row = envelope.row;
  assertExactKeys(row, NORMALIZED_ROW_KEYS, 'PREFUND_SPOOL_ROW_SCHEMA_INVALID', 'normalized row');
  if (!Number.isSafeInteger(row.sourceRowNumber) || row.sourceRowNumber < 2 ||
      row.sourceRowNumber > manifest.header.declaredRowCount + 1) {
    throw spoolError('PREFUND_SPOOL_ROW_SCHEMA_INVALID', 'normalized row sourceRowNumber非法');
  }
  for (const key of ROW_TEXT_KEYS) {
    if (typeof row[key] !== 'string') {
      throw spoolError('PREFUND_SPOOL_ROW_SCHEMA_INVALID', `normalized row ${key}必须是字符串`);
    }
  }
  if (row.sourceType !== manifest.header.sourceType || row.sourceBatch !== manifest.header.sourceBatch ||
      row.sourceDate !== manifest.header.sourceDate || row.sourceFileName !== manifest.header.sourceFileName ||
      row.sourceFileSequence !== manifest.header.sourceFileSequence || row.date !== manifest.header.sourceDate ||
      normalizeDecimalString(row.amount) !== row.amount || !/^[a-f0-9]{64}$/.test(row.fingerprint) ||
      buildGatewayFingerprint(row) !== row.fingerprint) {
    throw spoolError('PREFUND_SPOOL_ROW_SCHEMA_INVALID', 'normalized row身份、金额或fingerprint非法');
  }
  let raw;
  try { raw = JSON.parse(row.rawJson); } catch (_error) {
    throw spoolError('PREFUND_SPOOL_ROW_SCHEMA_INVALID', 'normalized row rawJson无法解析');
  }
  const schema = MPT_SCHEMAS[row.sourceType];
  assertExactKeys(raw, schema.fields, 'PREFUND_SPOOL_ROW_SCHEMA_INVALID', 'normalized row rawJson');
  for (const value of Object.values(raw)) {
    if (typeof value !== 'string') {
      throw spoolError('PREFUND_SPOOL_ROW_SCHEMA_INVALID', 'normalized row rawJson字段必须是字符串');
    }
  }
  return row;
}

function validateIssueEnvelope(envelope, manifest) {
  assertExactKeys(envelope, ['kind', 'issue'], 'PREFUND_SPOOL_ISSUE_SCHEMA_INVALID', 'issue envelope');
  if (!['error', 'excluded'].includes(envelope.kind)) {
    throw spoolError('PREFUND_SPOOL_ISSUE_SCHEMA_INVALID', 'issue kind必须是error或excluded');
  }
  const issue = envelope.issue;
  assertExactKeys(issue, ISSUE_KEYS, 'PREFUND_SPOOL_ISSUE_SCHEMA_INVALID', 'issue');
  if (!Number.isSafeInteger(issue.sourceRowNumber) || issue.sourceRowNumber < 2 ||
      issue.sourceRowNumber > manifest.header.declaredRowCount + 1 ||
      typeof issue.code !== 'string' || !issue.code || typeof issue.message !== 'string' ||
      typeof issue.fieldName !== 'string' || typeof issue.rawLine !== 'string' ||
      !Array.isArray(issue.detailLines) || issue.detailLines.length > 1000 ||
      issue.detailLines.some((line) => typeof line !== 'string') ||
      !Array.isArray(issue.fields) || issue.fields.length > MAX_ISSUE_FIELDS ||
      issue.fields.some((field) => typeof field !== 'string')) {
    throw spoolError('PREFUND_SPOOL_ISSUE_SCHEMA_INVALID', 'issue字段或长度非法');
  }
  assertPlainObject(issue.context, 'PREFUND_SPOOL_ISSUE_SCHEMA_INVALID', 'issue.context必须是普通对象');
  return Object.freeze({ kind: envelope.kind, issue });
}

async function scanNdjson(filePath, descriptor, validateRecord, onRecord = null) {
  const before = assertRegularNoSymlink(filePath, 'PREFUND_SPOOL_FILE_INVALID');
  if (Number(before.size) !== descriptor.byteSize) {
    throw spoolError('PREFUND_SPOOL_SIZE_MISMATCH', `${descriptor.basename}长度与manifest不一致`);
  }
  const beforeSnapshot = sourceSnapshotFromStat(before);
  const hash = crypto.createHash('sha256');
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let carry = Buffer.alloc(0);
  let count = 0;
  let lastSourceRowNumber = 1;
  let sourceRowSum = 0n;
  let sourceRowSquareSum = 0n;
  let errorCount = 0;
  let excludedCount = 0;
  try {
    for await (const chunk of fs.createReadStream(filePath)) {
      hash.update(chunk);
      carry = carry.length === 0 ? chunk : Buffer.concat([carry, chunk]);
      let newline;
      while ((newline = carry.indexOf(0x0a)) >= 0) {
        let line = carry.subarray(0, newline);
        carry = carry.subarray(newline + 1);
        if (line.length > 0 && line[line.length - 1] === 0x0d) line = line.subarray(0, -1);
        if (line.length === 0 || line.length > MPT_SPOOL_MAX_NDJSON_LINE_BYTES) {
          throw spoolError('PREFUND_SPOOL_NDJSON_INVALID', `${descriptor.basename}含空行或超长行`);
        }
        let envelope;
        try { envelope = JSON.parse(decoder.decode(line)); } catch (_error) {
          throw spoolError('PREFUND_SPOOL_NDJSON_INVALID', `${descriptor.basename}含非法UTF-8 JSON`);
        }
        const record = validateRecord(envelope);
        const sourceRowNumber = record.sourceRowNumber || record.issue.sourceRowNumber;
        if (sourceRowNumber <= lastSourceRowNumber) {
          throw spoolError('PREFUND_SPOOL_ROW_ORDER_INVALID', `${descriptor.basename}源行号必须严格递增`);
        }
        lastSourceRowNumber = sourceRowNumber;
        sourceRowSum += BigInt(sourceRowNumber);
        sourceRowSquareSum += BigInt(sourceRowNumber) * BigInt(sourceRowNumber);
        if (envelope.kind === 'error') errorCount += 1;
        if (envelope.kind === 'excluded') excludedCount += 1;
        count += 1;
        if (onRecord) await onRecord(envelope);
      }
      if (carry.length > MPT_SPOOL_MAX_NDJSON_LINE_BYTES) {
        throw spoolError('PREFUND_SPOOL_NDJSON_INVALID', `${descriptor.basename}含超长行`);
      }
    }
  } catch (error) {
    if (error && error.code && String(error.code).startsWith('PREFUND_')) throw error;
    throw spoolError('PREFUND_SPOOL_FILE_INVALID', `${descriptor.basename}读取失败`);
  }
  if (carry.length !== 0) {
    throw spoolError('PREFUND_SPOOL_NDJSON_INVALID', `${descriptor.basename}末行必须以换行结束`);
  }
  const after = fs.lstatSync(filePath, { bigint: true });
  if (!sourceSnapshotMatchesStat(beforeSnapshot, after) || count !== descriptor.count ||
      hash.digest('hex') !== descriptor.sha256) {
    throw spoolError('PREFUND_SPOOL_HASH_COUNT_MISMATCH', `${descriptor.basename} hash、count或快照不一致`);
  }
  return Object.freeze({ count, sourceRowSum, sourceRowSquareSum, errorCount, excludedCount });
}

function expectedOrdinalStats(declaredRowCount) {
  const count = BigInt(declaredRowCount);
  const last = count + 1n;
  const sumOneToLast = (last * (last + 1n)) / 2n;
  const squareOneToLast = (last * (last + 1n) * ((2n * last) + 1n)) / 6n;
  return Object.freeze({
    sum: sumOneToLast - 1n,
    squareSum: squareOneToLast - 1n
  });
}

async function readAndValidateMptFileSpool(input, options = {}) {
  const expected = normalizeReadInput(input);
  const paths = mptSpoolPaths(expected);
  assertSafeDirectoryTree(paths);
  const manifest = validateManifest(readManifest(paths), expected);
  const sourceSha256 = sha256RegularFile(expected.source.filePath, expected.source.sourceSnapshot);
  if (sourceSha256 !== manifest.source.sha256) {
    throw spoolError('PREFUND_SPOOL_SOURCE_CHANGED', 'MPT源文件SHA-256与manifest不一致');
  }
  const rowsStats = await scanNdjson(
    paths.rowsReady,
    manifest.files.rows,
    (envelope) => validateRowEnvelope(envelope, manifest)
  );
  const issuesStats = await scanNdjson(
    paths.issuesReady,
    manifest.files.issues,
    (envelope) => validateIssueEnvelope(envelope, manifest)
  );
  const ordinal = expectedOrdinalStats(manifest.header.declaredRowCount);
  if (rowsStats.sourceRowSum + issuesStats.sourceRowSum !== ordinal.sum ||
      rowsStats.sourceRowSquareSum + issuesStats.sourceRowSquareSum !== ordinal.squareSum ||
      issuesStats.errorCount !== manifest.counts.error ||
      issuesStats.excludedCount !== manifest.counts.excluded) {
    throw spoolError('PREFUND_SPOOL_COUNT_MISMATCH', 'spool源行去向、错误或排除计数不守恒');
  }

  if (typeof options.onRow === 'function') {
    await scanNdjson(
      paths.rowsReady,
      manifest.files.rows,
      (envelope) => validateRowEnvelope(envelope, manifest),
      (envelope) => options.onRow(envelope.row)
    );
  }
  if (typeof options.onIssue === 'function') {
    await scanNdjson(
      paths.issuesReady,
      manifest.files.issues,
      (envelope) => validateIssueEnvelope(envelope, manifest),
      (envelope) => options.onIssue(envelope.issue, envelope.kind)
    );
  }
  return Object.freeze({
    schemaVersion: manifest.schemaVersion,
    jobId: manifest.jobId,
    fileIndex: manifest.fileIndex,
    fileOperationKey: manifest.fileOperationKey,
    unitId: manifest.unitId,
    source: manifest.source,
    header: manifest.header,
    counts: manifest.counts,
    contentHash: manifest.contentHash,
    fileDir: paths.fileDir,
    manifestPath: paths.manifestReady
  });
}

module.exports = {
  NORMALIZED_ROW_KEYS,
  readAndValidateMptFileSpool
};
