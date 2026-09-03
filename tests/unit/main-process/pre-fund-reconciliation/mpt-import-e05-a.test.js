'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { once } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { Worker } = require('node:worker_threads');
const zlib = require('node:zlib');

const {
  sourceSnapshotFromStat
} = require('../../../../src/main-process/archive-center/source-snapshot');
const {
  fsyncDirectory
} = require('../../../../src/main-process/background-execution/durable-file');
const {
  parseMptFile
} = require('../../../../src/main-process/pre-fund-reconciliation/mpt-parser');
const {
  INBOUND_FIELDS,
  MPT_DELIMITER,
  OUTBOUND_FIELDS,
  buildGatewayFingerprint
} = require('../../../../src/main-process/pre-fund-reconciliation/mpt-schema');
const {
  INVALID_ROW_DISPOSITIONS,
  parseMptCandidates
} = require('../../../../src/main-process/pre-fund-reconciliation/mpt-import/parser-core');
const {
  buildHeaderIdentity,
  deriveFileIdentity,
  jobDirectoryToken,
  mptSpoolPaths
} = require('../../../../src/main-process/pre-fund-reconciliation/mpt-import/spool-contract');
const {
  readAndValidateMptFileSpool
} = require('../../../../src/main-process/pre-fund-reconciliation/mpt-import/spool-reader');
const {
  cleanupMptFileSpool,
  writeMptFileSpool: writeMptFileSpoolRaw
} = require('../../../../src/main-process/pre-fund-reconciliation/mpt-import/spool-writer');
const {
  createOrderedMptCoordinator
} = require('../../../../src/main-process/pre-fund-reconciliation/mpt-import/ordered-coordinator');
const {
  createSupportedDirectoryFsyncWorkerClass,
  withSupportedDirectoryFsync
} = require('../../shared/directory-fsync-test-runtime');

const SupportedDirectoryFsyncWorker = createSupportedDirectoryFsyncWorkerClass(Worker);

function writeMptFileSpool(input, options = {}) {
  return writeMptFileSpoolRaw(input, withSupportedDirectoryFsync(options));
}

let tempRoot;
test.beforeEach(() => {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'prefund-e05-a-'));
});
test.afterEach(() => {
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

function valuesFor(fields, overrides) {
  return fields.map((field) => Object.prototype.hasOwnProperty.call(overrides, field)
    ? overrides[field]
    : '');
}

function inboundRow(overrides = {}) {
  return valuesFor(INBOUND_FIELDS, {
    batchNo: 'MPT_INBOUND_20260708',
    billDate: '2026-07-08',
    channel: 'CITI',
    entity: 'PPEU',
    merchantId: '000123456789012345678901234567890',
    business: 'MPT',
    oppBu: 'SMB',
    tradeType: 'Inbound-VA',
    fileId: 'FILE-LONG-000000000000000000000000001',
    txId: 'TX-LONG-000000000000000000000000001',
    orderId: 'ORDER-LONG-0000000000000000000000001',
    reconId: 'RECON-LONG-0000000000000000000000001',
    billReconId: 'BILL-LONG-00000000000000000000000001',
    currency: 'USD',
    originAmount: '12345678901234567890.12345678901234567890',
    fee: '-0.0100',
    amount: '001.230000',
    payerName: '付款人',
    payerAccount: '00000000000000000000000000001',
    valueDate: '2026-07-08',
    bookDate: '2026-07-08',
    created: '2026-07-08 01:02:03.123+08:00',
    businessDate: '2026-07-08',
    tradeScope: 'INBOUND',
    realChannel: 'CITI-REAL',
    clearingNetwork: 'SWIFT',
    batchSeq: '0000000000000000000001',
    ...overrides
  });
}

function writeInboundFile(fileName, rows, declaredCount = rows.length) {
  const filePath = path.join(tempRoot, fileName);
  const header = ['20260708', 'MPT_INBOUND_20260708', String(declaredCount)];
  fs.writeFileSync(
    filePath,
    `${[header, ...rows].map((row) => row.join(MPT_DELIMITER)).join('\n')}\n`,
    'utf8'
  );
  return filePath;
}

function writeInboundGzip(fileName, rows, declaredCount = rows.length) {
  const filePath = path.join(tempRoot, fileName);
  const header = ['20260708', 'MPT_INBOUND_20260708', String(declaredCount)];
  const bytes = Buffer.from(
    `${[header, ...rows].map((row) => row.join(MPT_DELIMITER)).join('\n')}\n`,
    'utf8'
  );
  fs.writeFileSync(filePath, zlib.gzipSync(bytes));
  return filePath;
}

function outboundRow(overrides = {}) {
  return valuesFor(OUTBOUND_FIELDS, {
    batchNo: 'MPT_OUTBOUND_20260707',
    billDate: '2026-07-07',
    entity: 'PPUS',
    bizType: 'MPT',
    oppBu: 'SMB',
    tradeType: 'WITHDRAW',
    orderNo: 'ORDER-OUT-1',
    billReconId: 'BILL-OUT-1',
    reconId: 'RECON-OUT-1',
    name: '收款人',
    cardNo: 'CARD-OUT-1',
    originCurrency: 'USD',
    targetCurrency: 'GBP',
    originAmount: '10.00',
    fee: '0',
    originNetAmount: '10.00',
    targetAmount: '8.00',
    createTime: '2026-07-07 01:02:03',
    finishTime: '2026-07-07 01:03:04',
    channel: 'CITI',
    merchantId: 'M-002',
    tradeScope: 'OUTBOUND',
    bankDebitCurrency: 'EUR',
    bankDebitAmount: '9.50',
    businessDate: '2026-07-07',
    realChannel: 'CITI-REAL',
    clearingNetwork: 'SWIFT',
    batchSeq: '1',
    ...overrides
  });
}

function writeOutboundFile(fileName, rows) {
  const filePath = path.join(tempRoot, fileName);
  const header = ['20260707', 'MPT_OUTBOUND_20260707', String(rows.length)];
  fs.writeFileSync(
    filePath,
    `${[header, ...rows].map((row) => row.join(MPT_DELIMITER)).join('\n')}\n`,
    'utf8'
  );
  return filePath;
}

function sourceFor(filePath) {
  return {
    filePath,
    sourceSnapshot: sourceSnapshotFromStat(fs.lstatSync(filePath, { bigint: true }))
  };
}

function spoolInput(filePath, overrides = {}) {
  return {
    taskStagingDir: path.join(tempRoot, 'task-staging'),
    jobId: 'job-e05-a-001',
    fileIndex: 0,
    parentOperationKey: 'operation:pre-fund:mpt-import:e05-a',
    source: sourceFor(filePath),
    invalidRowDisposition: INVALID_ROW_DISPOSITIONS.ERROR,
    batchSize: 2,
    ...overrides
  };
}

async function legacyCollect(filePath) {
  const rows = [];
  const issues = [];
  const result = await parseMptFile(filePath, {
    batchSize: 2,
    collectRowErrors: true,
    rowErrorSampleLimit: 20,
    onRows(batch) { rows.push(...batch); },
    onRowError(issue) { issues.push(issue); }
  });
  return { result, rows, issues };
}

async function coreCollect(filePath, invalidRowDisposition = 'error') {
  const rows = [];
  const issues = [];
  const result = await parseMptCandidates({
    filePath,
    invalidRowDisposition,
    batchSize: 2,
    rowErrorSampleLimit: 20
  }, {
    onCandidate(candidate) {
      if (candidate.kind === 'valid') rows.push(candidate.row);
      else issues.push(candidate);
    }
  });
  return { result, rows, issues };
}

function manifestOf(input) {
  const paths = mptSpoolPaths(input);
  return JSON.parse(fs.readFileSync(paths.manifestReady, 'utf8'));
}

function rewriteManifest(input, mutate) {
  const paths = mptSpoolPaths(input);
  const manifest = manifestOf(input);
  mutate(manifest);
  fs.writeFileSync(paths.manifestReady, `${JSON.stringify(manifest)}\n`, 'utf8');
}

test('Parser Core与当前parser golden等价：行序、长ID、日期、金额文本、fingerprint与strict/skip分类', async () => {
  const filePath = writeInboundFile('MPT_INBOUND_GATEWAY_20260708_999999999999999999999.txt', [
    inboundRow({ reconId: 'VALID-LONG-00000000000000000000000001' }),
    inboundRow({ reconId: 'BAD-AMOUNT', amount: '1e3' }),
    inboundRow({ reconId: 'BAD-DATE', created: '2026-02-30 00:00:00' }),
    inboundRow({ reconId: 'VALID-LAST', amount: '-000.0000', created: '2026-07-08T23:59:59Z' })
  ]);
  const legacy = await legacyCollect(filePath);
  const strict = await coreCollect(filePath, 'error');
  const skip = await coreCollect(filePath, 'excluded');

  assert.deepEqual(strict.rows, legacy.rows);
  assert.deepEqual(strict.issues.map((entry) => entry.issue), legacy.issues);
  assert.deepEqual(skip.rows, legacy.rows);
  assert.deepEqual(skip.issues.map((entry) => entry.issue), legacy.issues);
  assert.deepEqual(strict.issues.map((entry) => entry.kind), ['error', 'error']);
  assert.deepEqual(skip.issues.map((entry) => entry.kind), ['excluded', 'excluded']);
  assert.deepEqual(strict.rows.map((row) => row.sourceRowNumber), [2, 5]);
  assert.equal(strict.rows[0].merchantId, '000123456789012345678901234567890');
  assert.equal(strict.rows[0].amount, '1.23');
  assert.equal(strict.rows[1].amount, '0');
  assert.equal(strict.result.contentHash, legacy.result.contentHash);
  assert.equal(strict.result.validRowCount, legacy.result.validRowCount);
  assert.equal(strict.result.errorRowCount, 2);
  assert.equal(skip.result.excludedRowCount, 2);
  assert.equal(strict.result.sourceFileSequence, '999999999999999999999');
  assert.match(strict.result.headerIdentity, /^[a-f0-9]{64}$/);
});

test('E05-A Parser/spool/Coordinator静态证明不引用SQLite/store、repair token、replacement或候选排序', () => {
  const sourceDir = path.join(
    __dirname,
    '../../../../src/main-process/pre-fund-reconciliation/mpt-import'
  );
  const source = [
    'parser-core.js',
    'parser-worker-entry.js',
    'spool-contract.js',
    'spool-writer.js',
    'spool-reader.js',
    'ordered-coordinator.js'
  ]
    .map((name) => fs.readFileSync(path.join(sourceDir, name), 'utf8'))
    .join('\n');
  assert.doesNotMatch(source, /node:sqlite|DatabaseSync|pre-fund-reconciliation-store|runDataStore/);
  assert.doesNotMatch(source, /repairToken|candidateSort|ORDER BY|BEGIN IMMEDIATE|\bINSERT\b|\bUPDATE\b|\bDELETE FROM\b/);
});

test('Parser Core保持OUTBOUND bankDebit→target→origin成对fallback与币种金额文本', async () => {
  const filePath = writeOutboundFile('MPT_OUTBOUND_GATEWAY_20260707101.txt', [
    outboundRow(),
    outboundRow({
      reconId: 'TARGET-FALLBACK', bankDebitCurrency: 'EUR', bankDebitAmount: '',
      targetCurrency: 'GBP', targetAmount: '8.00'
    }),
    outboundRow({
      reconId: 'ORIGIN-FALLBACK', bankDebitCurrency: '', bankDebitAmount: '',
      targetCurrency: '', targetAmount: '', originCurrency: 'JPY', originAmount: '700.00'
    })
  ]);
  const legacy = await legacyCollect(filePath);
  const core = await coreCollect(filePath);
  assert.deepEqual(core.rows, legacy.rows);
  assert.deepEqual(core.rows.map((row) => [row.currency, row.amount]), [
    ['EUR', '9.5'], ['GBP', '8'], ['JPY', '700']
  ]);
});

test('fileOperationKey和unitId稳定派生，file目录固定为task staging/job/file index', () => {
  assert.deepEqual(deriveFileIdentity('parent-operation', 7), {
    fileOperationKey: 'parent-operation/file/000007',
    unitId: 'file:000007'
  });
  const paths = mptSpoolPaths({
    taskStagingDir: path.join(tempRoot, 'task'),
    jobId: 'job-1',
    fileIndex: 7
  });
  assert.equal(
    paths.fileDir,
    path.join(tempRoot, `task/mpt/${jobDirectoryToken('job-1')}/file-000007`)
  );
  assert.equal(path.basename(paths.rowsReady), 'rows.ndjson.ready');
  assert.throws(
    () => mptSpoolPaths({ taskStagingDir: path.join(tempRoot, 'task'), jobId: '../escape', fileIndex: 0 }),
    (error) => error.code === 'PREFUND_SPOOL_CONTRACT_INVALID'
  );
});

test('writer与cleanup逐层拒绝symlink目录且不越界删除', async (t) => {
  await t.test('taskStagingDir symlink在创建spool前拒绝', async () => {
    const filePath = writeInboundFile('MPT_INBOUND_GATEWAY_20260708_701.txt', [inboundRow()]);
    const outside = path.join(tempRoot, 'outside-staging');
    const stagingLink = path.join(tempRoot, 'linked-task-staging');
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, stagingLink, 'dir');
    const input = spoolInput(filePath, { taskStagingDir: stagingLink, jobId: 'job-symlink-root' });
    await assert.rejects(
      () => writeMptFileSpool(input),
      (error) => error.code === 'PREFUND_SPOOL_PATH_INVALID'
        && error.details.invalidPath === stagingLink
    );
    assert.equal(fs.existsSync(path.join(outside, 'mpt')), false);
  });

  await t.test('fileDir symlink cleanup fail closed且不删除外部文件', () => {
    const filePath = writeInboundFile('MPT_INBOUND_GATEWAY_20260708_702.txt', [inboundRow()]);
    const input = spoolInput(filePath, { jobId: 'job-symlink-cleanup' });
    const paths = mptSpoolPaths(input);
    const outside = path.join(tempRoot, 'outside-cleanup');
    const outsideArtifact = path.join(outside, 'rows.ndjson.part');
    fs.mkdirSync(paths.jobDir, { recursive: true });
    fs.mkdirSync(outside);
    fs.writeFileSync(outsideArtifact, 'must-survive', 'utf8');
    fs.symlinkSync(outside, paths.fileDir, 'dir');
    assert.throws(
      () => cleanupMptFileSpool(input),
      (error) => error.code === 'PREFUND_SPOOL_CLEANUP_PATH_INVALID'
        && error.details.invalidPath === paths.fileDir
        && error.details.residualPaths.includes(paths.fileDir)
    );
    assert.equal(fs.readFileSync(outsideArtifact, 'utf8'), 'must-survive');
  });
});

test('jobId目录token对大小写、尾点和设备保留名隔离，cleanup不串扰', async () => {
  const filePath = writeInboundFile('MPT_INBOUND_GATEWAY_20260708_703.txt', [inboundRow()]);
  const jobIds = ['CaseJob', 'casejob', 'job', 'job.', 'CON', 'Job:Case'];
  const inputs = jobIds.map((jobId) => spoolInput(filePath, { jobId }));
  for (const input of inputs) await writeMptFileSpool(input);
  const paths = inputs.map((input) => mptSpoolPaths(input));
  assert.equal(new Set(paths.map((item) => item.jobDir)).size, jobIds.length);
  for (const item of paths) assert.match(path.basename(item.jobDir), /^job-[a-f0-9]{64}$/);
  assert.deepEqual(inputs.map((input) => manifestOf(input).jobId), jobIds);

  cleanupMptFileSpool(inputs[0]);
  cleanupMptFileSpool(inputs[2]);
  cleanupMptFileSpool(inputs[4]);
  assert.equal(fs.existsSync(paths[0].manifestReady), false);
  assert.equal(fs.existsSync(paths[2].manifestReady), false);
  assert.equal(fs.existsSync(paths[4].manifestReady), false);
  assert.equal(fs.existsSync(paths[1].manifestReady), true, '大小写不同job不得被串清理');
  assert.equal(fs.existsSync(paths[3].manifestReady), true, '尾点不同job不得被串清理');
});

test('Spool success：part先收口、ready三件套、Reader完整回放且计数/行序守恒', async () => {
  const filePath = writeInboundFile('MPT_INBOUND_GATEWAY_20260708_101.txt', [
    inboundRow({ reconId: 'VALID-1' }),
    inboundRow({ reconId: 'INVALID', amount: 'bad' }),
    inboundRow({ reconId: 'VALID-2' })
  ]);
  const input = spoolInput(filePath, { invalidRowDisposition: 'excluded' });
  const directoryBarriers = [];
  const written = await writeMptFileSpool(input, {
    fsyncDirectory(directory) {
      directoryBarriers.push(directory);
      return { capability: 'supported' };
    }
  });
  const paths = mptSpoolPaths(input);
  assert.equal(directoryBarriers.length, 2, 'rows/issues ready与manifest ready各有parent barrier');
  assert.equal(fs.existsSync(paths.rowsPart), false);
  assert.equal(fs.existsSync(paths.issuesPart), false);
  assert.equal(fs.existsSync(paths.manifestPart), false);
  assert.equal(fs.existsSync(paths.rowsReady), true);
  assert.equal(fs.existsSync(paths.issuesReady), true);
  assert.equal(fs.existsSync(paths.manifestReady), true);
  assert.equal(written.manifest.counts.valid, 2);
  assert.equal(written.manifest.counts.excluded, 1);
  assert.equal(written.manifest.counts.error, 0);

  const rows = [];
  const issues = [];
  const read = await readAndValidateMptFileSpool(input, {
    onRow(row) { rows.push(row); },
    onIssue(issue, kind) { issues.push([kind, issue]); }
  });
  assert.deepEqual(rows.map((row) => [row.sourceRowNumber, row.reconciliationId]), [
    [2, 'VALID-1'],
    [4, 'VALID-2']
  ]);
  assert.deepEqual(issues.map(([kind, issue]) => [kind, issue.sourceRowNumber, issue.code]), [
    ['excluded', 3, 'MPT_DECIMAL_INVALID']
  ]);
  assert.equal(read.contentHash, written.manifest.contentHash);
  assert.equal(read.fileOperationKey, 'operation:pre-fund:mpt-import:e05-a/file/000000');
});

test('strict spool保留error候选但不生成repair token或业务结果', async () => {
  const filePath = writeInboundFile('MPT_INBOUND_GATEWAY_20260708_102.txt', [
    inboundRow({ amount: 'bad' })
  ]);
  const input = spoolInput(filePath);
  const written = await writeMptFileSpool(input);
  assert.deepEqual(written.manifest.counts, { parsed: 1, valid: 0, error: 1, excluded: 0 });
  assert.equal(JSON.stringify(written.manifest).includes('repairToken'), false);
  const issues = [];
  await readAndValidateMptFileSpool(input, {
    onIssue(issue, kind) { issues.push([kind, issue.code]); }
  });
  assert.deepEqual(issues, [['error', 'MPT_DECIMAL_INVALID']]);
});

test('durability unsupported时manifest不发布且当前file spool清理', async () => {
  const filePath = writeInboundFile('MPT_INBOUND_GATEWAY_20260708_103.txt', [inboundRow()]);
  const input = spoolInput(filePath);
  await assert.rejects(
    () => writeMptFileSpool(input, {
      fsyncDirectory() { return { capability: 'unsupported', errorCode: 'EPERM' }; }
    }),
    (error) => error.code === 'PREFUND_SPOOL_DURABILITY_UNAVAILABLE'
  );
  const paths = mptSpoolPaths(input);
  assert.equal(fs.existsSync(paths.manifestReady), false);
  assert.equal(fs.existsSync(paths.rowsReady), false);
  assert.equal(fs.existsSync(paths.issuesReady), false);
});

test('真实平台目录屏障决定ready发布且unsupported保持fail closed', async () => {
  const filePath = writeInboundFile('MPT_INBOUND_GATEWAY_20260708_1031.txt', [inboundRow()]);
  const input = spoolInput(filePath, { jobId: 'job-real-platform-directory-barrier' });
  const barrier = fsyncDirectory(tempRoot);
  if (barrier.capability === 'supported') {
    const written = await writeMptFileSpoolRaw(input);
    assert.equal(fs.existsSync(written.manifestPath), true);
    cleanupMptFileSpool(input);
    return;
  }
  assert.equal(barrier.capability, 'unsupported');
  await assert.rejects(
    () => writeMptFileSpoolRaw(input),
    (error) => error.code === 'PREFUND_SPOOL_DURABILITY_UNAVAILABLE'
  );
  const paths = mptSpoolPaths(input);
  assert.equal(fs.existsSync(paths.manifestReady), false);
  assert.equal(fs.existsSync(paths.fileDir), false);
});

test('取消与解析业务错误均清理part/ready，不留下伪manifest', async () => {
  const filePath = writeInboundFile('MPT_INBOUND_GATEWAY_20260708_104.txt', [
    inboundRow({ reconId: 'R-1' }), inboundRow({ reconId: 'R-2' })
  ]);
  const input = spoolInput(filePath);
  const controller = new AbortController();
  await assert.rejects(
    () => writeMptFileSpool(input, {
      signal: controller.signal,
      onCandidateWritten() { controller.abort(); }
    }),
    (error) => error.code === 'PREFUND_PARSER_CANCELLED'
  );
  assert.equal(fs.existsSync(mptSpoolPaths(input).manifestReady), false);

  const badPath = writeInboundFile('MPT_INBOUND_GATEWAY_20260708_105.txt', [inboundRow()], 2);
  const badInput = spoolInput(badPath, { jobId: 'job-business-error' });
  await assert.rejects(
    () => writeMptFileSpool(badInput),
    (error) => error.code === 'MPT_DECLARED_COUNT_MISMATCH'
  );
  assert.equal(fs.existsSync(mptSpoolPaths(badInput).manifestReady), false);
});

test('解析期间source snapshot变化会fail closed并清理', async () => {
  const filePath = writeInboundFile('MPT_INBOUND_GATEWAY_20260708_106.txt', [
    inboundRow({ reconId: 'R-1' }), inboundRow({ reconId: 'R-2' })
  ]);
  const input = spoolInput(filePath);
  let touched = false;
  await assert.rejects(
    () => writeMptFileSpool(input, {
      onCandidateWritten() {
        if (touched) return;
        touched = true;
        const now = new Date(Date.now() + 5000);
        fs.utimesSync(filePath, now, now);
      }
    }),
    (error) => error.code === 'PREFUND_SPOOL_SOURCE_CHANGED'
  );
  assert.equal(fs.existsSync(mptSpoolPaths(input).manifestReady), false);
});

test('Reader tamper matrix：manifest/path/symlink/hash/count/header/source全部fail closed且不回调consumer', async (t) => {
  async function fixture(suffix) {
    const filePath = writeInboundFile(`MPT_INBOUND_GATEWAY_20260708_${suffix}.txt`, [
      inboundRow({ reconId: `R-${suffix}` })
    ]);
    const input = spoolInput(filePath, { jobId: `job-tamper-${suffix}` });
    await writeMptFileSpool(input);
    return { filePath, input, paths: mptSpoolPaths(input) };
  }

  await t.test('manifest part不能冒充ready', async () => {
    const item = await fixture('201');
    fs.renameSync(item.paths.manifestReady, item.paths.manifestPart);
    await assert.rejects(
      () => readAndValidateMptFileSpool(item.input),
      (error) => error.code === 'PREFUND_SPOOL_MANIFEST_INVALID'
    );
  });

  await t.test('basename/目录边界拒绝', async () => {
    const item = await fixture('202');
    rewriteManifest(item.input, (manifest) => { manifest.files.rows.basename = '../rows.ndjson.ready'; });
    await assert.rejects(
      () => readAndValidateMptFileSpool(item.input),
      (error) => error.code === 'PREFUND_SPOOL_PATH_INVALID'
    );
  });

  await t.test('ready symlink拒绝', async () => {
    const item = await fixture('203');
    fs.rmSync(item.paths.rowsReady);
    fs.symlinkSync(item.filePath, item.paths.rowsReady);
    await assert.rejects(
      () => readAndValidateMptFileSpool(item.input),
      (error) => error.code === 'PREFUND_SPOOL_FILE_INVALID'
    );
  });

  await t.test('size/hash tamper在回调前拒绝', async () => {
    const item = await fixture('204');
    fs.appendFileSync(item.paths.rowsReady, '{}\n');
    let callbacks = 0;
    await assert.rejects(
      () => readAndValidateMptFileSpool(item.input, { onRow() { callbacks += 1; } }),
      (error) => error.code === 'PREFUND_SPOOL_SIZE_MISMATCH'
    );
    assert.equal(callbacks, 0);
  });

  await t.test('count tamper拒绝', async () => {
    const item = await fixture('205');
    rewriteManifest(item.input, (manifest) => { manifest.files.rows.count = 0; });
    await assert.rejects(
      () => readAndValidateMptFileSpool(item.input),
      (error) => error.code === 'PREFUND_SPOOL_COUNT_MISMATCH'
    );
  });

  await t.test('header identity tamper拒绝', async () => {
    const item = await fixture('206');
    rewriteManifest(item.input, (manifest) => { manifest.header.identity = '0'.repeat(64); });
    await assert.rejects(
      () => readAndValidateMptFileSpool(item.input),
      (error) => error.code === 'PREFUND_SPOOL_HEADER_IDENTITY_INVALID'
    );
  });

  await t.test('零行与全-invalid即使联动重签header也必须锚定真实source', async (headerTest) => {
    const mutations = [
      ['sourceBatch', (header) => { header.sourceBatch = 'MPT_INBOUND_20260708_TAMPER'; }],
      ['sourceType原型键', (header) => { header.sourceType = 'constructor'; }],
      ['sourceFileSequence', (header) => { header.sourceFileSequence = '999999999999999999'; }]
    ];
    for (const [fixtureLabel, rows] of [
      ['zero', []],
      ['all-invalid', [inboundRow({ amount: 'bad' })]]
    ]) {
      for (const [mutationIndex, [fieldLabel, mutate]] of mutations.entries()) {
        await headerTest.test(`${fixtureLabel}/${fieldLabel}`, async () => {
          const suffix = `header-${fixtureLabel}-${fieldLabel}`.replace(/[^A-Za-z0-9-]/g, '-');
          const filePath = writeInboundFile(
            `MPT_INBOUND_GATEWAY_20260708_${fixtureLabel === 'zero' ? '610' : '620'}${mutationIndex}.txt`,
            rows
          );
          const input = spoolInput(filePath, { jobId: `job-${suffix}` });
          await writeMptFileSpool(input);
          rewriteManifest(input, (manifest) => {
            mutate(manifest.header);
            manifest.header.identity = buildHeaderIdentity(manifest.header);
          });
          let callbacks = 0;
          await assert.rejects(
            () => readAndValidateMptFileSpool(input, {
              onRow() { callbacks += 1; },
              onIssue() { callbacks += 1; }
            }),
            (error) => error.code === 'PREFUND_SPOOL_HEADER_IDENTITY_INVALID'
          );
          assert.equal(callbacks, 0);
        });
      }
    }
  });

  await t.test('source change拒绝', async () => {
    const item = await fixture('207');
    fs.appendFileSync(item.filePath, 'changed');
    await assert.rejects(
      () => readAndValidateMptFileSpool(item.input),
      (error) => error.code === 'PREFUND_SPOOL_SOURCE_CHANGED'
    );
  });

  await t.test('逐行schema与安全整数在hash/count自洽篡改下仍拒绝', async () => {
    const item = await fixture('208');
    const envelope = JSON.parse(fs.readFileSync(item.paths.rowsReady, 'utf8'));
    envelope.row.sourceRowNumber = Number.MAX_SAFE_INTEGER + 1;
    const bytes = Buffer.from(`${JSON.stringify(envelope)}\n`, 'utf8');
    fs.writeFileSync(item.paths.rowsReady, bytes);
    rewriteManifest(item.input, (manifest) => {
      manifest.files.rows.byteSize = bytes.length;
      manifest.files.rows.sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
    });
    await assert.rejects(
      () => readAndValidateMptFileSpool(item.input),
      (error) => error.code === 'PREFUND_SPOOL_ROW_SCHEMA_INVALID'
    );
  });

  await t.test('normalized金额与fingerprint联动篡改仍被rawJson来源证据拒绝', async () => {
    const item = await fixture('209');
    const envelope = JSON.parse(fs.readFileSync(item.paths.rowsReady, 'utf8'));
    envelope.row.amount = '999999';
    envelope.row.fingerprint = buildGatewayFingerprint(envelope.row);
    const bytes = Buffer.from(`${JSON.stringify(envelope)}\n`, 'utf8');
    fs.writeFileSync(item.paths.rowsReady, bytes);
    rewriteManifest(item.input, (manifest) => {
      manifest.files.rows.byteSize = bytes.length;
      manifest.files.rows.sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
    });
    let callbacks = 0;
    await assert.rejects(
      () => readAndValidateMptFileSpool(item.input, { onRow() { callbacks += 1; } }),
      (error) => error.code === 'PREFUND_SPOOL_ROW_SCHEMA_INVALID'
    );
    assert.equal(callbacks, 0);
  });
});

test('gzip解压后的spool超过已批准单文件预算时fail closed并清理', async () => {
  const rows = Array.from({ length: 2500 }, () => inboundRow());
  const filePath = writeInboundGzip('MPT_INBOUND_GATEWAY_20260708_210.gz', rows);
  const input = spoolInput(filePath, { jobId: 'job-gzip-spool-budget' });
  await assert.rejects(
    () => writeMptFileSpool(input),
    (error) => error.code === 'PREFUND_SPOOL_DISK_BUDGET_EXCEEDED' &&
      !/prefund-e05-a|private|tmp/i.test(error.message)
  );
  assert.equal(fs.existsSync(mptSpoolPaths(input).fileDir), false);
});

test('cleanup只移除当前file已知spool文件，不跨job或跨file', async () => {
  const firstPath = writeInboundFile('MPT_INBOUND_GATEWAY_20260708_301.txt', [inboundRow()]);
  const secondPath = writeInboundFile('MPT_INBOUND_GATEWAY_20260708_302.txt', [inboundRow()]);
  const first = spoolInput(firstPath, { jobId: 'job-cleanup', fileIndex: 0 });
  const second = spoolInput(secondPath, { jobId: 'job-cleanup', fileIndex: 1 });
  await writeMptFileSpool(first);
  await writeMptFileSpool(second);
  cleanupMptFileSpool(first);
  assert.equal(fs.existsSync(mptSpoolPaths(first).manifestReady), false);
  assert.equal(fs.existsSync(mptSpoolPaths(second).manifestReady), true);
});

test('Ordered Coordinator乱序ready/error仍严格递增、consumer单飞、结果等长同序', async () => {
  const consumed = [];
  let active = 0;
  let maxActive = 0;
  const coordinator = createOrderedMptCoordinator({
    fileCount: 4,
    readyHighWaterMark: 4,
    async consumeReady(spool, { fileIndex }) {
      active += 1;
      maxActive = Math.max(maxActive, active);
      consumed.push(fileIndex);
      await new Promise((resolve) => setImmediate(resolve));
      active -= 1;
      return { status: 'ok', fileIndex, spoolId: spool.id };
    }
  });
  const permits = await Promise.all(Array.from({ length: 4 }, () => coordinator.acquireDispatchPermit()));
  permits[3].submitReady(3, { id: 'spool-3' });
  permits[1].submitReady(1, { id: 'spool-1' });
  permits[2].submitBusinessError(2, { status: 'failed', fileIndex: 2, code: 'MPT_ROW_ERRORS' });
  permits[0].submitReady(0, { id: 'spool-0' });
  const results = await coordinator.completion();
  assert.deepEqual(consumed, [0, 1, 3]);
  assert.equal(maxActive, 1);
  assert.equal(results.length, 4);
  assert.deepEqual(results.map((item) => item.fileIndex), [0, 1, 2, 3]);
  assert.equal(results[2].status, 'failed');
});

test('Ordered Coordinator高水位背压、取消与transport crash按各自合同收口', async (t) => {
  await t.test('ready高水位阻止继续派发，前序到达后释放', async () => {
    const coordinator = createOrderedMptCoordinator({
      fileCount: 3,
      readyHighWaterMark: 2,
      consumeReady: async (spool) => ({ status: 'ok', id: spool.id })
    });
    const permit0 = await coordinator.acquireDispatchPermit();
    const permit1 = await coordinator.acquireDispatchPermit();
    permit1.submitReady(1, { id: 1 });
    let capacityReleased = false;
    const capacity = coordinator.acquireDispatchPermit().then((permit) => {
      capacityReleased = true;
      return permit;
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(capacityReleased, false);
    permit0.submitBusinessError(0, { status: 'failed', id: 0 });
    const permit2 = await capacity;
    permit2.submitReady(2, { id: 2 });
    const results = await coordinator.completion();
    assert.deepEqual(results.map((item) => item.id), [0, 1, 2]);
    assert.equal(coordinator.snapshot().maxObservedPermitCount, 2);
    assert.equal(coordinator.snapshot().activePermitCount, 0);
  });

  await t.test('取消后completion拒绝且不消费后续', async () => {
    let calls = 0;
    const coordinator = createOrderedMptCoordinator({
      fileCount: 2,
      consumeReady: async () => { calls += 1; return { status: 'ok' }; }
    });
    coordinator.submitReady(1, { id: 1 });
    coordinator.cancel();
    await assert.rejects(
      coordinator.completion(),
      (error) => error.code === 'PREFUND_COORDINATOR_CANCELLED'
    );
    assert.equal(calls, 0);
  });

  await t.test('transport crash按旧service语义形成当前file error并继续', async () => {
    const coordinator = createOrderedMptCoordinator({
      fileCount: 2,
      consumeReady: async (_spool, { fileIndex }) => ({ status: 'ok', fileIndex })
    });
    coordinator.submitTransportCrash(0, {
      status: 'failed',
      fileName: 'crashed.txt',
      code: 'PREFUND_PARSER_TRANSPORT_CRASH',
      message: 'worker exited 9',
      detailLines: []
    });
    coordinator.submitReady(1, { id: 1 });
    const results = await coordinator.completion();
    assert.deepEqual(results, [{
      status: 'failed',
      fileName: 'crashed.txt',
      code: 'PREFUND_PARSER_TRANSPORT_CRASH',
      message: 'worker exited 9',
      detailLines: []
    }, {
      status: 'ok',
      fileIndex: 1
    }]);
  });
});

test('one-shot Parser Worker真实成功、取消与transport终止不留下伪manifest', async (t) => {
  const workerEntry = path.join(
    __dirname,
    '../../../../src/main-process/pre-fund-reconciliation/mpt-import/parser-worker-entry.js'
  );

  await t.test('真实Worker发布ready spool且结果不携带路径或业务提交字段', async () => {
    const filePath = writeInboundFile('MPT_INBOUND_GATEWAY_20260708_401.txt', [inboundRow()]);
    const input = spoolInput(filePath, { jobId: 'WorkerJob.' });
    const worker = new SupportedDirectoryFsyncWorker(workerEntry, { workerData: { input } });
    const exitPromise = once(worker, 'exit');
    const [message] = await once(worker, 'message');
    const [exitCode] = await exitPromise;
    assert.equal(exitCode, 0);
    assert.equal(message.ok, true, JSON.stringify(message));
    assert.deepEqual(Object.keys(message.result), [
      'schemaVersion', 'jobId', 'fileIndex', 'fileOperationKey', 'unitId'
    ]);
    assert.equal(message.result.jobId, 'WorkerJob.');
    await readAndValidateMptFileSpool(input);
  });

  await t.test('真实Worker cleanup incomplete只回传bounded当前file cleanup信号与原cause code', async () => {
    const filePath = writeInboundFile(
      'MPT_INBOUND_GATEWAY_20260708_404.txt',
      [inboundRow()],
      2
    );
    const input = spoolInput(filePath, { jobId: 'job-worker-cleanup-incomplete' });
    const paths = mptSpoolPaths(input);
    const foreignPath = path.join(paths.fileDir, 'foreign.keep');
    fs.mkdirSync(paths.fileDir, { recursive: true });
    fs.writeFileSync(foreignPath, 'foreign', 'utf8');

    const worker = new SupportedDirectoryFsyncWorker(workerEntry, { workerData: { input } });
    const exitPromise = once(worker, 'exit');
    const [message] = await once(worker, 'message');
    const [exitCode] = await exitPromise;
    assert.equal(exitCode, 0);
    assert.equal(message.ok, false);
    assert.deepEqual(Object.keys(message.error), [
      'name', 'code', 'message', 'cleanupRequired', 'cleanupScope', 'causeCode'
    ]);
    assert.equal(message.error.code, 'PREFUND_SPOOL_CLEANUP_INCOMPLETE');
    assert.equal(message.error.cleanupRequired, true);
    assert.equal(message.error.cleanupScope, 'current-file-spool');
    assert.equal(message.error.causeCode, 'MPT_DECLARED_COUNT_MISMATCH');
    assert.ok(message.error.causeCode.length <= 128);
    const serialized = JSON.stringify(message);
    for (const forbidden of [tempRoot, paths.fileDir, filePath, path.basename(filePath), 'foreign.keep']) {
      assert.equal(serialized.includes(forbidden), false, `Worker错误回包不得包含路径/文件名：${forbidden}`);
    }
    assert.equal(fs.existsSync(foreignPath), true, '无法安全删除的残留必须留给task owner');

    fs.rmSync(foreignPath);
    assert.equal(cleanupMptFileSpool(input).status, 'cleaned');
    assert.equal(fs.existsSync(paths.fileDir), false);
  });

  await t.test('真实Worker普通解析错误保持原三字段语义且不误标cleanup', async () => {
    const filePath = writeInboundFile(
      'MPT_INBOUND_GATEWAY_20260708_405.txt',
      [inboundRow()],
      2
    );
    const input = spoolInput(filePath, { jobId: 'job-worker-business-error' });
    const worker = new SupportedDirectoryFsyncWorker(workerEntry, { workerData: { input } });
    const exitPromise = once(worker, 'exit');
    const [message] = await once(worker, 'message');
    const [exitCode] = await exitPromise;
    assert.equal(exitCode, 0);
    assert.equal(message.ok, false);
    assert.deepEqual(Object.keys(message.error), ['name', 'code', 'message', 'detailLines']);
    assert.equal(message.error.code, 'MPT_DECLARED_COUNT_MISMATCH');
    assert.deepEqual(message.error.detailLines, [
      '文件：MPT_INBOUND_GATEWAY_20260708_405.txt'
    ]);
    assert.equal(Object.prototype.hasOwnProperty.call(message.error, 'cleanupRequired'), false);
    assert.equal(fs.existsSync(mptSpoolPaths(input).fileDir), false);
  });

  await t.test('真实Worker取消清理当前file spool', async () => {
    const rows = Array.from({ length: 20_000 }, (_, index) => inboundRow({ reconId: `CANCEL-${index}` }));
    const filePath = writeInboundFile('MPT_INBOUND_GATEWAY_20260708_402.txt', rows);
    const input = spoolInput(filePath, { jobId: 'job-worker-cancel', batchSize: 10 });
    const worker = new SupportedDirectoryFsyncWorker(workerEntry, { workerData: { input } });
    const exitPromise = once(worker, 'exit');
    worker.postMessage({ operation: 'cancel' });
    const [message] = await once(worker, 'message');
    const [exitCode] = await exitPromise;
    assert.equal(exitCode, 0);
    assert.equal(message.ok, false);
    assert.equal(message.error.code, 'PREFUND_PARSER_CANCELLED');
    assert.equal(fs.existsSync(mptSpoolPaths(input).manifestReady), false);
  });

  await t.test('真实Worker transport终止只形成crash证据，不映射产品结果', async () => {
    const rows = Array.from({ length: 20_000 }, (_, index) => inboundRow({ reconId: `CRASH-${index}` }));
    const filePath = writeInboundFile('MPT_INBOUND_GATEWAY_20260708_403.txt', rows);
    const input = spoolInput(filePath, { jobId: 'job-worker-crash', batchSize: 10 });
    const worker = new SupportedDirectoryFsyncWorker(workerEntry, { workerData: { input } });
    const exitPromise = once(worker, 'exit');
    await once(worker, 'online');
    await worker.terminate();
    const [exitCode] = await exitPromise;
    assert.notEqual(exitCode, 0);
    assert.equal(fs.existsSync(mptSpoolPaths(input).manifestReady), false);
    cleanupMptFileSpool(input);
    assert.equal(fs.existsSync(mptSpoolPaths(input).fileDir), false);
  });
});
