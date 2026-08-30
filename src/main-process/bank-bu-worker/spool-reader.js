'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');

const { sourceSnapshotMatchesStat } = require('../archive-center/source-snapshot');
const {
  PENDING_GUANLI_DB_COLUMNS,
  BANK_DB_COLUMNS
} = require('../../backend/bank-bu-recon-db/columns');
const { sha256File } = require('./identity');
const { readBankBuParserOutcome } = require('./parser-outcome');
const {
  BANK_BU_INPUT_ROLES,
  BANK_BU_SPOOL_MAX_MANIFEST_BYTES,
  BANK_BU_SPOOL_MAX_NDJSON_LINE_BYTES,
  BANK_BU_SPOOL_SCHEMA_VERSION,
  bankBuSpoolPaths,
  normalizeDualImportDescriptor,
  normalizeManifestSource,
  normalizeSpoolDescriptor,
  spoolError
} = require('./spool-contract');
const { validatePrivateSpoolDirectory } = require('./spool-filesystem');

function exactKeys(value, keys) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).sort().join(',') === keys.slice().sort().join(','));
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

function readBankBuSpoolManifest(rawDescriptor) {
  const descriptor = normalizeSpoolDescriptor(rawDescriptor);
  const paths = bankBuSpoolPaths(descriptor);
  validatePrivateSpoolDirectory(descriptor);
  const file = readRegularFile(
    paths.manifestReady,
    BANK_BU_SPOOL_MAX_MANIFEST_BYTES,
    'BANK_BU_SPOOL_MANIFEST_INVALID',
    'BankBU spool manifest缺失、过大或不是普通文件'
  );
  let parsed;
  try { parsed = JSON.parse(file.bytes.toString('utf8')); } catch (_error) {
    throw spoolError('BANK_BU_SPOOL_MANIFEST_INVALID', 'BankBU spool manifest不是合法JSON');
  }
  const keys = [
    'schemaVersion', 'jobId', 'operationKey', 'producerTaskRunId', 'yearMonth',
    'role', 'source', 'rowCount', 'rows'
  ];
  if (!exactKeys(parsed, keys) || parsed.schemaVersion !== BANK_BU_SPOOL_SCHEMA_VERSION ||
      parsed.jobId !== descriptor.jobId || parsed.operationKey !== descriptor.operationKey ||
      parsed.producerTaskRunId !== descriptor.producerTaskRunId ||
      parsed.yearMonth !== descriptor.yearMonth || parsed.role !== descriptor.role ||
      !Number.isSafeInteger(parsed.rowCount) || parsed.rowCount < 0) {
    throw spoolError('BANK_BU_SPOOL_IDENTITY_MISMATCH', 'BankBU spool manifest identity非法');
  }
  const source = normalizeManifestSource(parsed.source);
  if (source.fileName !== path.basename(descriptor.source.filePath)) {
    throw spoolError('BANK_BU_SPOOL_IDENTITY_MISMATCH', 'BankBU spool source fileName不匹配');
  }
  if (!exactKeys(parsed.rows, ['basename', 'byteSize', 'sha256', 'count']) ||
      parsed.rows.basename !== path.basename(paths.rowsReady) ||
      !Number.isSafeInteger(parsed.rows.byteSize) || parsed.rows.byteSize < 0 ||
      !Number.isSafeInteger(parsed.rows.count) || parsed.rows.count !== parsed.rowCount ||
      typeof parsed.rows.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(parsed.rows.sha256)) {
    throw spoolError('BANK_BU_SPOOL_MANIFEST_INVALID', 'BankBU spool rows identity非法');
  }
  return Object.freeze({
    schemaVersion: parsed.schemaVersion,
    jobId: parsed.jobId,
    operationKey: parsed.operationKey,
    producerTaskRunId: parsed.producerTaskRunId,
    yearMonth: parsed.yearMonth,
    role: parsed.role,
    source,
    rowCount: parsed.rowCount,
    rows: Object.freeze({ ...parsed.rows }),
    manifestSha256: crypto.createHash('sha256').update(file.bytes).digest('hex'),
    descriptor,
    paths
  });
}

async function assertSourceAuthority(manifest) {
  let stat;
  try { stat = fs.lstatSync(manifest.descriptor.source.filePath, { bigint: true }); } catch (_error) {
    throw spoolError('BANK_BU_SPOOL_SOURCE_CHANGED', 'BankBU spool源文件不可读或已变化');
  }
  if (stat.isSymbolicLink() || !stat.isFile() ||
      !sourceSnapshotMatchesStat(manifest.source.snapshot, stat) ||
      await sha256File(manifest.descriptor.source.filePath) !== manifest.source.sha256) {
    throw spoolError('BANK_BU_SPOOL_SOURCE_CHANGED', 'BankBU spool源文件不可读或已变化');
  }
}

function validateRow(row, role, ordinal, previousRowIndex) {
  const columns = role === BANK_BU_INPUT_ROLES.PENDING ? PENDING_GUANLI_DB_COLUMNS : BANK_DB_COLUMNS;
  if (!exactKeys(row, ['_rowIndex', ...columns]) ||
      !Number.isSafeInteger(row._rowIndex) || row._rowIndex < 2 ||
      row._rowIndex <= previousRowIndex ||
      columns.some((column) => typeof row[column] !== 'string')) {
    throw spoolError(
      'BANK_BU_SPOOL_ROW_INVALID',
      `BankBU ${role} spool第${ordinal + 1}行非法`
    );
  }
  return row._rowIndex;
}

async function consumeRows(manifest) {
  validatePrivateSpoolDirectory(manifest.descriptor);
  const file = readRegularFile(
    manifest.paths.rowsReady,
    Number.MAX_SAFE_INTEGER,
    'BANK_BU_SPOOL_ROWS_INVALID',
    'BankBU rows spool缺失或不是普通文件',
    { readBytes: false }
  );
  if (file.stat.size !== manifest.rows.byteSize) {
    throw spoolError('BANK_BU_SPOOL_ROWS_INVALID', 'BankBU rows spool byteSize不匹配');
  }
  const input = fs.createReadStream(manifest.paths.rowsReady);
  const hash = crypto.createHash('sha256');
  input.on('data', (chunk) => hash.update(chunk));
  const reader = readline.createInterface({ input, crlfDelay: Infinity });
  const rows = [];
  let previousRowIndex = 1;
  try {
    for await (const line of reader) {
      if (line.length === 0 || Buffer.byteLength(line, 'utf8') > BANK_BU_SPOOL_MAX_NDJSON_LINE_BYTES) {
        throw spoolError('BANK_BU_SPOOL_ROW_INVALID', 'BankBU spool存在空行或超长行');
      }
      let row;
      try { row = JSON.parse(line); } catch (_error) {
        throw spoolError('BANK_BU_SPOOL_ROW_INVALID', 'BankBU spool row不是合法JSON');
      }
      previousRowIndex = validateRow(row, manifest.role, rows.length, previousRowIndex);
      rows.push(Object.freeze(row));
    }
  } finally {
    reader.close();
  }
  if (rows.length !== manifest.rowCount || rows.length !== manifest.rows.count ||
      hash.digest('hex') !== manifest.rows.sha256) {
    throw spoolError('BANK_BU_SPOOL_COUNT_MISMATCH', 'BankBU spool hash或行数不守恒');
  }
  return Object.freeze(rows);
}

async function readBankBuInputSpool(rawDescriptor) {
  const manifest = readBankBuSpoolManifest(rawDescriptor);
  await assertSourceAuthority(manifest);
  const rows = await consumeRows(manifest);
  await assertSourceAuthority(manifest);
  const refreshed = readBankBuSpoolManifest(manifest.descriptor);
  if (refreshed.manifestSha256 !== manifest.manifestSha256) {
    throw spoolError('BANK_BU_SPOOL_MANIFEST_CHANGED', 'BankBU spool manifest消费期间发生变化');
  }
  return Object.freeze({ manifest, rows });
}

async function readBankBuSpoolPair(rawDescriptor) {
  const descriptor = normalizeDualImportDescriptor(rawDescriptor);
  // Writer intake固定为Pending→Bank；Parser完成顺序不参与业务顺序。
  const pending = await readBankBuInputSpool(descriptor.spools[0]);
  const bank = await readBankBuInputSpool(descriptor.spools[1]);
  await Promise.all([
    assertSourceAuthority(pending.manifest),
    assertSourceAuthority(bank.manifest)
  ]);
  return Object.freeze({ pending, bank });
}

function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    let timer = null;
    const cleanup = () => { if (signal) signal.removeEventListener('abort', onAbort); };
    const onAbort = () => {
      if (timer) clearTimeout(timer);
      cleanup();
      reject(spoolError('BANK_BU_PARSER_CANCELLED', 'BankBU dual Parser已取消'));
    };
    if (signal && signal.aborted) return onAbort();
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    timer = setTimeout(() => { cleanup(); resolve(); }, ms);
  });
}

async function waitForBankBuSpoolsReady(rawDescriptor, options = {}) {
  const descriptor = normalizeDualImportDescriptor(rawDescriptor);
  const signal = options.signal || null;
  while (true) {
    if (signal && signal.aborted) {
      throw spoolError('BANK_BU_PARSER_CANCELLED', 'BankBU dual Parser已取消');
    }
    const outcomes = descriptor.spools.map(readBankBuParserOutcome);
    const failed = outcomes.find((outcome) => outcome && outcome.status === 'failed');
    if (failed) {
      const error = spoolError(
        'BANK_BU_PARSER_FAILED',
        `BankBU ${failed.role} Parser未形成可用spool（${failed.causeCode}）`
      );
      error.causeCode = failed.causeCode;
      throw error;
    }
    if (outcomes.every((outcome) => outcome && outcome.status === 'succeeded')) {
      const manifests = descriptor.spools.map(readBankBuSpoolManifest);
      for (let index = 0; index < manifests.length; index += 1) {
        if (outcomes[index].role !== manifests[index].role ||
            outcomes[index].rowCount !== manifests[index].rowCount) {
          throw spoolError(
            'BANK_BU_PARSER_OUTCOME_INVALID',
            'BankBU Parser success outcome与spool manifest不匹配'
          );
        }
      }
      return descriptor;
    }
    await delay(options.pollIntervalMs || 10, signal);
  }
}

module.exports = {
  assertSourceAuthority,
  readBankBuInputSpool,
  readBankBuSpoolManifest,
  readBankBuSpoolPair,
  waitForBankBuSpoolsReady
};
