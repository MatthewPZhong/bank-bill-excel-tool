'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const JSZip = require('jszip');
const XLSX = require('xlsx');

const { normalizeFilePlanV1 } = require('../../../src/main-process/archive-center/file-plan');
const {
  createBackgroundExecutionRuntime,
  isBackgroundExecutionProductionEnabled
} = require('../../../src/main-process/background-execution/runtime');
const {
  createJobEnvelope
} = require('../../../src/main-process/background-execution/protocol');
const {
  prepareToolboxPublication
} = require('../../../src/main-process/toolbox-output-publication');
const {
  createToolboxPublicationDispatcher,
  recoverToolboxPublicationsAsync
} = require('../../../src/main-process/toolbox-output-publication-dispatch');
const {
  createNewAccountExpectedArtifactAuthority,
  createNewAccountWorkerInput
} = require('../../../src/main-process/new-account/generation-validator');
const {
  businessEvidence,
  executeNewAccountGeneration
} = require('../../../src/main-process/new-account/generation-core');
const {
  NEW_ACCOUNT_SAVE_AS_ACTION,
  acknowledgeNewAccountSaveAsPublication,
  cleanupOwnedCopyStaging,
  createNewAccountSaveAsInput,
  executeNewAccountArtifactCopy,
  validateAndPublishNewAccountSaveAs,
  validateNewAccountSaveAsResult
} = require('../../../src/main-process/new-account/artifact-copy');
const {
  NEW_ACCOUNT_SAVE_AS_POLICY,
  SAVE_AS_RESOURCES
} = require('../../../src/main-process/new-account/policies');

const TEMPLATE_PATH = path.resolve(__dirname, '../../../assets/余额账单模版.xlsx');
const POLICY_FIXTURE_PATH = path.resolve(
  __dirname,
  '../../../changes/background-execution-v3.2.x-contract-baseline/changes/background-execution/validation/fixtures/valid/policy-registry.v3.2.x.json'
);
const CRASH_RECOVER_PUBLISHER_WORKER = path.resolve(
  __dirname,
  '__fixtures__/toolbox-publication-stub-crash-recover.js'
);
const roots = [];

test.after(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

function tempRoot(prefix = 'new-account-e10-b-') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}

function generationPayload() {
  return {
    accounts: [{
      bankName: '测试银行',
      location: '上海',
      bankAccount: '622200001234',
      openingDate: '2026-02-28',
      isMultiCurrency: true,
      currency: '',
      currencies: ['USD', 'CNY']
    }]
  };
}

function operationContext(operationKey = 'new-account-e10-b-operation') {
  return Object.freeze({
    kind: 'operation',
    value: {
      taskRunId: 'new-account-e10-b-task',
      taskKey: 'new-account:export',
      moduleId: 'new-account',
      parentRunId: 'new-account-e10-b-parent',
      operationKey
    }
  });
}

function batchContext(operationKey = 'new-account-e10-b-operation') {
  return Object.freeze({
    batchId: 32310,
    batchNumber: '2026-08-29-E10-B',
    taskRunId: 'new-account-e10-b-task',
    taskKey: 'new-account:export',
    moduleId: 'new-account',
    parentRunId: 'new-account-e10-b-parent',
    operationKey
  });
}

function saveAsDoneEnvelope(runtime, result, operationKey = 'new-account-e10-b-inode-evidence') {
  return createJobEnvelope({
    direction: 'event',
    operation: 'job:done',
    actionKey: NEW_ACCOUNT_SAVE_AS_ACTION,
    operationKey,
    jobId: 'new-account-e10-b-inode-job',
    workerInstanceId: 'new-account-e10-b-inline-worker',
    serviceGeneration: null,
    unitId: null,
    seq: 1,
    context: operationContext(operationKey),
    payload: { result }
  }, { policyRegistry: runtime.policyRegistry });
}

async function generatedFixture(root) {
  const generationRoot = path.join(root, 'generation');
  fs.mkdirSync(generationRoot, { recursive: true });
  fs.mkdirSync(path.join(root, 'managed'), { recursive: true });
  const sourcePath = path.join(generationRoot, 'new-account-source.xlsx');
  const generationPlan = normalizeFilePlanV1({
    version: 1,
    allocation: 'eager',
    inputs: [{
      filePath: TEMPLATE_PATH,
      role: 'new-account-template',
      sourceOperation: 'new-account:generate'
    }],
    outputs: [{
      filePath: path.join(root, 'managed', 'unused-final.xlsx'),
      role: 'new-account-output',
      sourceOperation: 'new-account:generate'
    }]
  });
  const generationInput = createNewAccountWorkerInput({
    filePlan: generationPlan,
    templatePath: TEMPLATE_PATH,
    payload: generationPayload(),
    asOfDate: '2026-03-02',
    stagingRoot: generationRoot,
    stagingResourceId: path.basename(sourcePath),
    generationPath: sourcePath
  });
  const generationResult = await executeNewAccountGeneration(generationInput, null, {
    allowedTemplatePath: TEMPLATE_PATH
  });
  return {
    sourcePath,
    generationResult,
    expectedArtifactAuthority: createNewAccountExpectedArtifactAuthority(generationInput)
  };
}

function saveAsOptions(root, fixture, overrides = {}) {
  const stagingRoot = path.join(root, 'copy-staging');
  const targetDir = path.join(root, 'target');
  fs.mkdirSync(stagingRoot, { recursive: true });
  fs.mkdirSync(targetDir, { recursive: true });
  const targetPath = path.join(targetDir, 'saved-as.xlsx');
  const stagingResourceId = 'copied-new-account.xlsx';
  const filePlan = normalizeFilePlanV1({
    version: 1,
    allocation: 'eager',
    inputs: [{
      filePath: fixture.sourcePath,
      role: 'new-account-source-artifact',
      sourceOperation: NEW_ACCOUNT_SAVE_AS_ACTION
    }],
    outputs: [{
      filePath: targetPath,
      role: 'new-account-save-as-output',
      sourceOperation: NEW_ACCOUNT_SAVE_AS_ACTION
    }]
  });
  return {
    filePlan,
    sourceGenerationResult: fixture.generationResult,
    expectedArtifactAuthority: fixture.expectedArtifactAuthority,
    stagingRoot,
    stagingResourceId,
    stagingPath: path.join(stagingRoot, stagingResourceId),
    targetPath,
    operationKey: 'new-account-e10-b-operation',
    context: operationContext(),
    batchContext: batchContext(),
    taskId: 'new-account-e10-b-publish',
    userDataDir: path.join(root, 'user-data'),
    production: false,
    async settleArtifacts() {
      return { durable: true };
    },
    ...overrides
  };
}

function replaceSameSizeAndTimes(filePath) {
  const stat = fs.statSync(filePath);
  const bytes = fs.readFileSync(filePath);
  const replacement = `${filePath}.replacement`;
  fs.writeFileSync(replacement, bytes);
  fs.utimesSync(replacement, stat.atime, stat.mtime);
  fs.renameSync(replacement, filePath);
}

function sha256File(filePath) {
  const hash = require('node:crypto').createHash('sha256');
  hash.update(fs.readFileSync(filePath));
  return hash.digest('hex');
}

function refreshSelfReportedGenerationEvidence(fixture, mutateWorkbook) {
  const workbook = XLSX.readFile(fixture.sourcePath, { raw: true });
  mutateWorkbook(workbook);
  XLSX.writeFile(workbook, fixture.sourcePath);
  const firstSheetName = workbook.SheetNames[0];
  const rows = XLSX.utils.sheet_to_json(workbook.Sheets[firstSheetName], {
    header: 1,
    blankrows: false,
    defval: '',
    raw: true
  });
  const headers = rows[0].slice();
  const records = rows.slice(1);
  const stat = fs.statSync(fixture.sourcePath);
  fixture.generationResult = {
    ...fixture.generationResult,
    artifact: {
      ...fixture.generationResult.artifact,
      byteSize: stat.size,
      sha256: sha256File(fixture.sourcePath),
      headers,
      rowCount: records.length,
      businessEvidence: businessEvidence(headers, records)
    },
    summary: {
      ...fixture.generationResult.summary,
      rowCount: records.length
    }
  };
}

function refreshGenerationTechnicalEvidence(fixture) {
  const stat = fs.statSync(fixture.sourcePath);
  fixture.generationResult = {
    ...fixture.generationResult,
    artifact: {
      ...fixture.generationResult.artifact,
      byteSize: stat.size,
      sha256: sha256File(fixture.sourcePath)
    }
  };
}

async function mutateWorkbookPackage(fixture, mutate) {
  const zip = await JSZip.loadAsync(fs.readFileSync(fixture.sourcePath));
  await mutate(zip);
  fs.writeFileSync(fixture.sourcePath, await zip.generateAsync({ type: 'nodebuffer' }));
  refreshGenerationTechnicalEvidence(fixture);
}

test('policy 为一等 inline-async：只占 I/O lease，production 保持 false/legacy/0', () => {
  const fixture = JSON.parse(fs.readFileSync(POLICY_FIXTURE_PATH, 'utf8'))
    .actions[NEW_ACCOUNT_SAVE_AS_ACTION];
  assert.deepEqual(NEW_ACCOUNT_SAVE_AS_POLICY, fixture);
  assert.equal(NEW_ACCOUNT_SAVE_AS_POLICY.actionKey, NEW_ACCOUNT_SAVE_AS_ACTION);
  assert.equal(NEW_ACCOUNT_SAVE_AS_POLICY.mode, 'inline-async');
  assert.equal(NEW_ACCOUNT_SAVE_AS_POLICY.lifetime, 'job');
  assert.equal(NEW_ACCOUNT_SAVE_AS_POLICY.commit.kind, 'main-settlement');
  assert.equal(NEW_ACCOUNT_SAVE_AS_POLICY.commit.receiptKind, 'publisher-journal');
  assert.deepEqual(SAVE_AS_RESOURCES, {
    cpuSlots: 0,
    workerThreadSlots: 0,
    utilityProcessSlots: 0,
    ioHeavySlots: 1,
    memoryBytes: 16 * 1024 * 1024
  });
  assert.equal(NEW_ACCOUNT_SAVE_AS_POLICY.production.enabled, false);
  assert.equal(NEW_ACCOUNT_SAVE_AS_POLICY.production.effectiveMode, 'legacy');
  assert.equal(NEW_ACCOUNT_SAVE_AS_POLICY.production.effectiveWorkerCount, 0);
  assert.equal(isBackgroundExecutionProductionEnabled(NEW_ACCOUNT_SAVE_AS_ACTION), false);
});

test('copy contract 不含 final target，copyFile 只接 task-owned staging', async () => {
  const root = tempRoot();
  const fixture = await generatedFixture(root);
  const options = saveAsOptions(root, fixture);
  const input = createNewAccountSaveAsInput(options);
  assert.equal(JSON.stringify(input).includes(options.targetPath), false);
  assert.equal(Object.hasOwn(input, 'finalTarget'), false);
  let observed = null;
  const result = await executeNewAccountArtifactCopy(input, null, {
    fsPromises: {
      async copyFile(sourcePath, destinationPath, flags) {
        observed = { sourcePath, destinationPath, flags };
        return fs.promises.copyFile(sourcePath, destinationPath, flags);
      }
    }
  });
  assert.equal(validateNewAccountSaveAsResult(result), true);
  assert.equal(observed.sourcePath, fs.realpathSync(fixture.sourcePath));
  assert.equal(observed.destinationPath, options.stagingPath);
  assert.notEqual(observed.destinationPath, options.targetPath);
  assert.equal(fs.existsSync(options.targetPath), false);
  assert.deepEqual(fs.readFileSync(options.stagingPath), fs.readFileSync(fixture.sourcePath));
});

test('Windows长inode仅在精确stagingSnapshot证据路径通过finance-safe协议', async () => {
  const runtime = createBackgroundExecutionRuntime({
    availableParallelism: 4,
    freeMemoryBytes: 4 * 1024 ** 3,
    totalMemoryBytes: 8 * 1024 ** 3,
    systemReserveBytes: 0
  });
  const longInode = '1234567890123456';
  const result = {
    schemaVersion: 1,
    status: 'copied',
    artifact: {
      artifactKey: `output-${'a'.repeat(64)}`,
      byteSize: 4096,
      sha256: 'b'.repeat(64),
      sourceIdentitySha256: 'c'.repeat(64),
      stagingSnapshot: {
        sizeBytes: 4096,
        mtimeMs: 1788192000123.5,
        ctimeMs: 1788192000456.75,
        ino: longInode
      }
    }
  };
  try {
    assert.equal(validateNewAccountSaveAsResult(result), true);
    const envelope = saveAsDoneEnvelope(runtime, result);
    assert.equal(envelope.payload.result.artifact.stagingSnapshot.ino, longInode);

    const invalidResults = [];
    const nearbyPath = structuredClone(result);
    nearbyPath.artifact.stagingSnapshot.ino = '7';
    nearbyPath.artifact.nearby = { ino: longInode };
    invalidResults.push(nearbyPath);

    const extraSnapshotField = structuredClone(result);
    extraSnapshotField.artifact.stagingSnapshot.extra = true;
    invalidResults.push(extraSnapshotField);

    const wrongSnapshotShape = structuredClone(result);
    wrongSnapshotShape.artifact.stagingSnapshot.sizeBytes = '4096';
    invalidResults.push(wrongSnapshotShape);

    const nonCanonicalInode = structuredClone(result);
    nonCanonicalInode.artifact.stagingSnapshot.ino = `0${longInode}`;
    invalidResults.push(nonCanonicalInode);

    const overflowInode = structuredClone(result);
    overflowInode.artifact.stagingSnapshot.ino = '18446744073709551616';
    invalidResults.push(overflowInode);

    const unrelatedIdentity = structuredClone(result);
    unrelatedIdentity.artifact.stagingSnapshot.ino = '7';
    unrelatedIdentity.artifact.source = { inode: longInode };
    invalidResults.push(unrelatedIdentity);

    for (const invalid of invalidResults) {
      assert.throws(
        () => saveAsDoneEnvelope(runtime, invalid),
        (error) => error.code === 'PROTOCOL_PRIVACY_VIOLATION'
      );
    }
  } finally {
    await runtime.shutdown({ timeoutMs: 10000 });
  }
});

test('E10-B只接受out-of-band Main authority且缺settlement owner时Publisher=0', async () => {
  const root = tempRoot('new-account-e10-b-authority-gate-');
  const fixture = await generatedFixture(root);
  const options = saveAsOptions(root, fixture);
  let runtimeCalls = 0;
  const runtime = { async execute() { runtimeCalls += 1; } };
  await assert.rejects(
    validateAndPublishNewAccountSaveAs({
      ...options,
      runtime,
      expectedArtifactAuthority: structuredClone(options.expectedArtifactAuthority)
    }),
    (error) => error.code === 'NEW_ACCOUNT_EXPECTED_ARTIFACT_AUTHORITY_INVALID'
  );
  const { settleArtifacts: _settleArtifacts, ...withoutSettlement } = options;
  await assert.rejects(
    validateAndPublishNewAccountSaveAs({ ...withoutSettlement, runtime }),
    (error) => error.code === 'NEW_ACCOUNT_SAVE_AS_SETTLEMENT_REQUIRED'
  );
  assert.equal(runtimeCalls, 0);
  assert.equal(fs.existsSync(options.targetPath), false);
});

test('E10-B只消费原始Main FilePlan authority，不重采样target snapshot且拒绝伪造clone', async (t) => {
  for (const phase of ['absent-created', 'existing-replaced-same-metadata', 'unbranded-clone']) {
    await t.test(phase, async () => {
      const root = tempRoot(`new-account-e10-b-plan-authority-${phase}-`);
      const fixture = await generatedFixture(root);
      if (phase === 'existing-replaced-same-metadata') {
        const targetDir = path.join(root, 'target');
        fs.mkdirSync(targetDir, { recursive: true });
        fs.writeFileSync(path.join(targetDir, 'saved-as.xlsx'), 'original-target');
      }
      const options = saveAsOptions(root, fixture);
      if (phase === 'absent-created') fs.writeFileSync(options.targetPath, 'unknown-external-file');
      if (phase === 'existing-replaced-same-metadata') replaceSameSizeAndTimes(options.targetPath);
      const suppliedFilePlan = phase === 'unbranded-clone'
        ? structuredClone(options.filePlan)
        : options.filePlan;
      let runtimeCalls = 0;
      let publisherCalls = 0;
      await assert.rejects(
        validateAndPublishNewAccountSaveAs({
          ...options,
          filePlan: suppliedFilePlan,
          runtime: { async execute() { runtimeCalls += 1; } },
          publisher: async () => { publisherCalls += 1; }
        }),
        (error) => phase === 'unbranded-clone'
          ? error.code === 'NEW_ACCOUNT_SAVE_AS_FILE_PLAN_AUTHORITY_INVALID'
          : error.code === 'NEW_ACCOUNT_SAVE_AS_FILE_PLAN_CHANGED'
      );
      assert.equal(runtimeCalls, 0);
      assert.equal(publisherCalls, 0);
      assert.equal(fs.existsSync(options.stagingPath), false);
    });
  }
});

test('source before/during/after copy drift 与同 size/mtime replacement 全部 fail closed', async (t) => {
  for (const phase of ['before', 'during', 'after', 'same-size-same-mtime']) {
    await t.test(phase, async () => {
      const root = tempRoot(`new-account-e10-b-${phase}-`);
      const fixture = await generatedFixture(root);
      const options = saveAsOptions(root, fixture);
      const input = createNewAccountSaveAsInput(options);
      if (phase === 'before') fs.appendFileSync(fixture.sourcePath, 'drift');
      const copyFile = async (sourcePath, destinationPath, flags) => {
        await fs.promises.copyFile(sourcePath, destinationPath, flags);
        if (phase === 'during') fs.appendFileSync(fixture.sourcePath, 'drift');
      };
      const checkpoint = async (name) => {
        if (phase === 'after' && name === 'copy:after-source-verify') {
          fs.appendFileSync(fixture.sourcePath, 'drift');
        }
        if (phase === 'same-size-same-mtime' && name === 'copy:before-copy') {
          replaceSameSizeAndTimes(fixture.sourcePath);
        }
      };
      await assert.rejects(
        executeNewAccountArtifactCopy(input, null, {
          fsPromises: { copyFile },
          checkpoint
        }),
        (error) => /^NEW_ACCOUNT_SAVE_AS_SOURCE_/.test(error.code)
      );
      assert.equal(fs.existsSync(options.stagingPath), false);
    });
  }
});

test('copy partial/error 与 staging collision/outside 均清理或拒绝且不接 Publisher', async () => {
  const root = tempRoot();
  const fixture = await generatedFixture(root);
  const options = saveAsOptions(root, fixture);
  const input = createNewAccountSaveAsInput(options);
  await assert.rejects(
    executeNewAccountArtifactCopy(input, null, {
      fsPromises: {
        async copyFile(_sourcePath, destinationPath) {
          await fs.promises.writeFile(destinationPath, 'partial');
          throw Object.assign(new Error('copy failed'), { code: 'EIO' });
        }
      }
    }),
    (error) => error.code === 'NEW_ACCOUNT_SAVE_AS_COPY_FAILED'
  );
  assert.equal(fs.existsSync(options.stagingPath), false);
  fs.writeFileSync(options.stagingPath, 'collision');
  await assert.rejects(
    executeNewAccountArtifactCopy(input),
    (error) => error.code === 'NEW_ACCOUNT_SAVE_AS_STAGING_INVALID'
  );
  assert.throws(
    () => createNewAccountSaveAsInput({
      ...options,
      stagingResourceId: '../outside.xlsx',
      stagingPath: path.join(root, 'outside.xlsx')
    }),
    (error) => error.code === 'NEW_ACCOUNT_SAVE_AS_STAGING_INVALID'
  );
});

test('source/target symlink、hardlink、ancestor symlink 与 staging alias 全部在 copy 前拒绝', async (t) => {
  const root = tempRoot();
  const fixture = await generatedFixture(root);
  const base = saveAsOptions(root, fixture);
  const sourceLink = path.join(root, 'source-link.xlsx');
  fs.symlinkSync(fixture.sourcePath, sourceLink);
  assert.throws(
    () => createNewAccountSaveAsInput({
      ...base,
      filePlan: normalizeFilePlanV1({
        version: 1,
        allocation: 'eager',
        inputs: [{ filePath: sourceLink, role: 'source', sourceOperation: NEW_ACCOUNT_SAVE_AS_ACTION }],
        outputs: [{ filePath: base.targetPath, role: 'output', sourceOperation: NEW_ACCOUNT_SAVE_AS_ACTION }]
      })
    }),
    /普通文件|symlink|符号链接|source/i
  );
  const hardTarget = path.join(root, 'hard-target.xlsx');
  fs.linkSync(fixture.sourcePath, hardTarget);
  assert.throws(
    () => normalizeFilePlanV1({
      version: 1,
      allocation: 'eager',
      inputs: [{ filePath: fixture.sourcePath, role: 'source', sourceOperation: NEW_ACCOUNT_SAVE_AS_ACTION }],
      outputs: [{ filePath: hardTarget, role: 'output', sourceOperation: NEW_ACCOUNT_SAVE_AS_ACTION }]
    }),
    /别名|覆盖/
  );
  fs.unlinkSync(hardTarget);
  const realTargetDir = path.join(root, 'real-target-dir');
  const targetDirLink = path.join(root, 'target-dir-link');
  fs.mkdirSync(realTargetDir);
  fs.symlinkSync(realTargetDir, targetDirLink, 'dir');
  assert.throws(
    () => normalizeFilePlanV1({
      version: 1,
      allocation: 'eager',
      inputs: [{
        filePath: fixture.sourcePath,
        role: 'source',
        sourceOperation: NEW_ACCOUNT_SAVE_AS_ACTION
      }],
      outputs: [{
        filePath: path.join(targetDirLink, 'saved.xlsx'),
        role: 'output',
        sourceOperation: NEW_ACCOUNT_SAVE_AS_ACTION
      }]
    }),
    (error) => error.code === 'ARCHIVE_TARGET_PARENT_INVALID'
  );
  const refreshed = saveAsOptions(root, fixture);
  assert.throws(
    () => createNewAccountSaveAsInput({
      ...refreshed,
      stagingRoot: path.dirname(fixture.sourcePath),
      stagingResourceId: path.basename(fixture.sourcePath),
      stagingPath: fixture.sourcePath
    }),
    (error) => ['NEW_ACCOUNT_SAVE_AS_PATH_ALIAS', 'NEW_ACCOUNT_SAVE_AS_STAGING_INVALID'].includes(error.code)
  );
});

test('Main technical/business validation 后 Publisher 恰好一次；source/target/staging drift 均为0次', async (t) => {
  for (const phase of [
    'success',
    'tamper',
    'replace',
    'staging-hardlink',
    'source-drift',
    'target-drift',
    'target-ancestor-race',
    'target-parent-replacement',
    'business',
    'extra-sheet',
    'extra-column',
    'extra-styled-blank',
    'extra-row-styled-blank',
    'extra-merge',
    'extra-dimension',
    'formula-account',
    'formula-amount',
    'calc-chain',
    'external-link',
    'hyperlink'
  ]) {
    await t.test(phase, async () => {
      const root = tempRoot(`new-account-e10-b-publisher-${phase}-`);
      const fixture = await generatedFixture(root);
      if (phase === 'business') {
        refreshSelfReportedGenerationEvidence(fixture, (workbook) => {
          const sheet = workbook.Sheets[workbook.SheetNames[0]];
          const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', raw: true });
          const accountIndex = rows[0].indexOf('银行账号');
          const currencyIndex = rows[0].indexOf('币种');
          for (let index = 1; index < rows.length; index += 1) {
            rows[index][accountIndex] = '999999999999';
            rows[index][currencyIndex] = 'JPY';
          }
          workbook.Sheets[workbook.SheetNames[0]] = XLSX.utils.aoa_to_sheet(rows);
        });
      }
      if (phase === 'extra-sheet') {
        refreshSelfReportedGenerationEvidence(fixture, (workbook) => {
          XLSX.utils.book_append_sheet(
            workbook,
            XLSX.utils.aoa_to_sheet([['secret-data'], ['unauthorized']]),
            'secret-data'
          );
        });
      }
      if (phase === 'extra-column') {
        refreshSelfReportedGenerationEvidence(fixture, (workbook) => {
          const sheet = workbook.Sheets[workbook.SheetNames[0]];
          sheet.J1 = { t: 's', v: '未授权秘密列' };
          sheet.J2 = { t: 's', v: 'secret-1' };
          sheet['!ref'] = 'A1:J5';
        });
      }
      if (phase === 'extra-styled-blank') {
        await mutateWorkbookPackage(fixture, async (zip) => {
          const entry = zip.file('xl/worksheets/sheet1.xml');
          const xml = await entry.async('string');
          zip.file('xl/worksheets/sheet1.xml', xml
            .replace('<dimension ref="A1:I5"/>', '<dimension ref="A1:J5"/>')
            .replace('</row><row r="3"', '<c r="J2" s="1"/></row><row r="3"'));
        });
      }
      if (phase === 'extra-row-styled-blank') {
        await mutateWorkbookPackage(fixture, async (zip) => {
          const entry = zip.file('xl/worksheets/sheet1.xml');
          const xml = await entry.async('string');
          zip.file('xl/worksheets/sheet1.xml', xml
            .replace('<dimension ref="A1:I5"/>', '<dimension ref="A1:I6"/>')
            .replace('</sheetData>', '<row r="6"><c r="I6" s="1"/></row></sheetData>'));
        });
      }
      if (phase === 'extra-merge') {
        await mutateWorkbookPackage(fixture, async (zip) => {
          const entry = zip.file('xl/worksheets/sheet1.xml');
          const xml = await entry.async('string');
          zip.file('xl/worksheets/sheet1.xml', xml
            .replace('<dimension ref="A1:I5"/>', '<dimension ref="A1:J5"/>')
            .replace('</worksheet>', '<mergeCells count="1"><mergeCell ref="I2:J2"/></mergeCells></worksheet>'));
        });
      }
      if (phase === 'extra-dimension') {
        await mutateWorkbookPackage(fixture, async (zip) => {
          const entry = zip.file('xl/worksheets/sheet1.xml');
          const xml = await entry.async('string');
          zip.file('xl/worksheets/sheet1.xml', xml.replace(
            '<dimension ref="A1:I5"/>',
            '<dimension ref="A1:J5"/>'
          ));
        });
      }
      if (phase === 'formula-account') {
        refreshSelfReportedGenerationEvidence(fixture, (workbook) => {
          const sheet = workbook.Sheets[workbook.SheetNames[0]];
          for (let row = 2; row <= 5; row += 1) {
            sheet[`D${row}`] = {
              t: 's',
              f: '"999999999999"',
              v: '622200001234'
            };
          }
        });
      }
      if (phase === 'formula-amount') {
        refreshSelfReportedGenerationEvidence(fixture, (workbook) => {
          const sheet = workbook.Sheets[workbook.SheetNames[0]];
          sheet.H2 = { t: 'n', f: '999999', v: 0 };
        });
      }
      if (phase === 'calc-chain') {
        await mutateWorkbookPackage(fixture, async (zip) => {
          zip.file(
            'xl/calcChain.xml',
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
              '<calcChain xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
              '<c r="D2" i="1"/></calcChain>'
          );
        });
      }
      if (phase === 'external-link') {
        await mutateWorkbookPackage(fixture, async (zip) => {
          const relsEntry = zip.file('xl/_rels/workbook.xml.rels');
          const rels = await relsEntry.async('string');
          zip.file('xl/_rels/workbook.xml.rels', rels.replace(
            '</Relationships>',
            '<Relationship Id="rIdExternal1" ' +
              'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/externalLink" ' +
              'Target="externalLinks/externalLink1.xml"/></Relationships>'
          ));
          zip.file(
            'xl/externalLinks/externalLink1.xml',
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
              '<externalLink xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
              '<externalBook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
              'r:id="rId1"/></externalLink>'
          );
          zip.file(
            'xl/externalLinks/_rels/externalLink1.xml.rels',
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
              '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
              '<Relationship Id="rId1" ' +
              'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/externalLinkPath" ' +
              'Target="file:///tmp/secret.xlsx" TargetMode="External"/></Relationships>'
          );
        });
      }
      if (phase === 'hyperlink') {
        await mutateWorkbookPackage(fixture, async (zip) => {
          const sheetEntry = zip.file('xl/worksheets/sheet1.xml');
          const sheetXml = await sheetEntry.async('string');
          zip.file('xl/worksheets/sheet1.xml', sheetXml.replace(
            '</worksheet>',
            '<hyperlinks><hyperlink ref="D2" r:id="rIdHyperlink1" ' +
              'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"/>' +
              '</hyperlinks></worksheet>'
          ));
          zip.file(
            'xl/worksheets/_rels/sheet1.xml.rels',
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
              '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
              '<Relationship Id="rIdHyperlink1" ' +
              'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" ' +
              'Target="https://example.invalid/secret" TargetMode="External"/></Relationships>'
          );
        });
      }
      const options = saveAsOptions(root, fixture);
      let publisherCalls = 0;
      let publicationInput = null;
      const publisher = async (input) => {
        publisherCalls += 1;
        publicationInput = input;
        return {
          taskId: options.taskId,
          committed: true,
          pendingArchiveHandoff: true
        };
      };
      const onCopyCompleted = ({ stagingPath }) => {
        if (phase === 'tamper') fs.appendFileSync(stagingPath, 'tamper');
        if (phase === 'replace') replaceSameSizeAndTimes(stagingPath);
        if (phase === 'staging-hardlink') fs.linkSync(stagingPath, `${stagingPath}.hardlink`);
        if (phase === 'source-drift') fs.appendFileSync(fixture.sourcePath, 'source-drift');
        if (phase === 'target-drift') fs.writeFileSync(options.targetPath, 'target-drift');
        if (phase === 'target-ancestor-race') {
          const targetDir = path.dirname(options.targetPath);
          const movedTargetDir = `${targetDir}.moved`;
          const alternateTargetDir = `${targetDir}.alternate`;
          fs.renameSync(targetDir, movedTargetDir);
          fs.mkdirSync(alternateTargetDir);
          fs.symlinkSync(alternateTargetDir, targetDir, 'dir');
        }
        if (phase === 'target-parent-replacement') {
          const targetDir = path.dirname(options.targetPath);
          fs.renameSync(targetDir, `${targetDir}.moved`);
          fs.mkdirSync(targetDir);
        }
      };
      if (phase === 'success') {
        const runtime = createBackgroundExecutionRuntime({
          availableParallelism: 4,
          freeMemoryBytes: 4 * 1024 ** 3,
          totalMemoryBytes: 8 * 1024 ** 3,
          systemReserveBytes: 0
        });
        const result = await validateAndPublishNewAccountSaveAs({
          ...options,
          runtime,
          publisher,
          onCopyCompleted
        });
        assert.equal(result.publication.committed, true);
        assert.equal(publisherCalls, 1);
        assert.deepEqual(publicationInput.protectedSourcePaths, [options.filePlan.inputs[0].filePath]);
        assert.deepEqual(
          publicationInput.targets[0].expectedTargetSnapshot,
          options.filePlan.outputs[0].targetSnapshot
        );
        assert.strictEqual(
          publicationInput.targets[0].expectedTargetParentIdentity,
          options.filePlan.outputs[0].targetParentIdentity
        );
        assert.equal(publicationInput.requireTargetParentIdentity, true);
        assert.equal(publicationInput.targets[0].targetPath, options.filePlan.outputs[0].filePath);
        assert.equal(publicationInput.artifacts[0].sourcePath, options.stagingPath);
        assert.equal(publicationInput.artifacts[0].sha256, fixture.generationResult.artifact.sha256);
        assert.equal(publicationInput.artifacts[0].sheetCount, 1);
        assert.equal(fs.existsSync(options.stagingPath), false);
        await runtime.shutdown({ timeoutMs: 10000 });
      } else {
        const runtime = createBackgroundExecutionRuntime({
          availableParallelism: 4,
          freeMemoryBytes: 4 * 1024 ** 3,
          totalMemoryBytes: 8 * 1024 ** 3,
          systemReserveBytes: 0
        });
        let rejectedCode = null;
        await assert.rejects(
          validateAndPublishNewAccountSaveAs({
            ...options,
            runtime,
            publisher,
            onCopyCompleted
          }),
          (error) => {
            rejectedCode = error.code;
            return true;
          }
        );
        if (['formula-account', 'formula-amount', 'calc-chain', 'external-link', 'hyperlink']
          .includes(phase)) {
          assert.equal(rejectedCode, 'NEW_ACCOUNT_WORKBOOK_DYNAMIC_CONTENT_FORBIDDEN');
        }
        if (['extra-column', 'extra-styled-blank', 'extra-merge', 'extra-dimension'].includes(phase)) {
          assert.equal(rejectedCode, 'NEW_ACCOUNT_WORKBOOK_COLUMN_BOUNDARY_MISMATCH');
        }
        if (phase === 'extra-row-styled-blank') {
          assert.equal(rejectedCode, 'NEW_ACCOUNT_WORKBOOK_DIMENSION_INVALID');
        }
        assert.equal(publisherCalls, 0);
        await runtime.shutdown({ timeoutMs: 10000 });
      }
    });
  }
});

test('E10-B对unreliable direct parent identity稳定fail closed且Publisher=0', async () => {
  const root = tempRoot('new-account-e10-b-parent-capability-');
  const fixture = await generatedFixture(root);
  const base = saveAsOptions(root, fixture);
  const parent = path.dirname(base.targetPath);
  const unreliableParentPaths = new Set([
    path.resolve(parent),
    path.resolve(fs.realpathSync(parent))
  ]);
  const fsImpl = Object.create(fs);
  fsImpl.statSync = (filePath, options) => {
    const stat = fs.statSync(filePath, options);
    if (!unreliableParentPaths.has(path.resolve(String(filePath))) ||
        !options || options.bigint !== true) {
      return stat;
    }
    return {
      ...stat,
      dev: 0n,
      ino: 0n,
      isDirectory: () => stat.isDirectory(),
      isFile: () => stat.isFile(),
      isSymbolicLink: () => false
    };
  };
  const filePlan = normalizeFilePlanV1({
    version: 1,
    allocation: 'eager',
    inputs: [{
      filePath: fixture.sourcePath,
      role: 'new-account-source-artifact',
      sourceOperation: NEW_ACCOUNT_SAVE_AS_ACTION
    }],
    outputs: [{
      filePath: base.targetPath,
      role: 'new-account-save-as-output',
      sourceOperation: NEW_ACCOUNT_SAVE_AS_ACTION
    }]
  }, { fsImpl, platform: 'win32' });
  let publisherCalls = 0;
  await assert.rejects(
    validateAndPublishNewAccountSaveAs({
      ...base,
      filePlan,
      fsImpl,
      platform: 'win32',
      publisher: async () => { publisherCalls += 1; }
    }),
    (error) => error && error.code === 'NEW_ACCOUNT_SAVE_AS_TARGET_PARENT_IDENTITY_UNAVAILABLE'
  );
  assert.equal(publisherCalls, 0);
});

test('Publisher failure 清理；uncertain/manual-recovery 保留 staging 且不 blind replay', async (t) => {
  for (const uncertain of [false, true]) {
    await t.test(uncertain ? 'uncertain' : 'ordinary-failure', async () => {
      const root = tempRoot();
      const fixture = await generatedFixture(root);
      const options = saveAsOptions(root, fixture);
      const runtime = createBackgroundExecutionRuntime({
        availableParallelism: 4,
        freeMemoryBytes: 4 * 1024 ** 3,
        totalMemoryBytes: 8 * 1024 ** 3,
        systemReserveBytes: 0
      });
      const cleanupInput = createNewAccountSaveAsInput(options);
      let calls = 0;
      await assert.rejects(
        validateAndPublishNewAccountSaveAs({
          ...options,
          runtime,
          publisher: async () => {
            calls += 1;
            const error = Object.assign(new Error('publisher failed'), {
              code: uncertain ? 'TOOLBOX_PUBLICATION_WORKER_RECOVERY_FAILED' : 'TOOLBOX_PUBLICATION_FAILED'
            });
            if (uncertain) error.preserveTemporaryFiles = true;
            throw error;
          }
        })
      );
      assert.equal(calls, 1);
      assert.equal(fs.existsSync(options.stagingPath), uncertain);
      if (uncertain) cleanupOwnedCopyStaging(cleanupInput);
      await runtime.shutdown({ timeoutMs: 10000 });
    });
  }
});

test('真实 runtime 获取/释放 I/O lease，不占 CPU/Worker；预算拒绝时 copy/Pubisher 都为0', async () => {
  const root = tempRoot();
  const fixture = await generatedFixture(root);
  const options = saveAsOptions(root, fixture);
  const input = createNewAccountSaveAsInput(options);
  const diagnostics = [];
  const runtime = createBackgroundExecutionRuntime({
    availableParallelism: 4,
    freeMemoryBytes: 4 * 1024 ** 3,
    totalMemoryBytes: 8 * 1024 ** 3,
    systemReserveBytes: 0,
    diagnostics: (event) => diagnostics.push(event)
  });
  const execution = await runtime.execute({
    actionKey: NEW_ACCOUNT_SAVE_AS_ACTION,
    operationKey: options.operationKey,
    context: options.context,
    input
  });
  assert.equal(execution.outcome, 'completed');
  const snapshot = runtime.resourceGovernor.snapshot();
  assert.equal(snapshot.activeUsage.cpuSlots, 0);
  assert.equal(snapshot.activeUsage.workerThreadSlots, 0);
  assert.equal(snapshot.activeUsage.ioHeavySlots, 0);
  assert.ok(snapshot.diagnostics.granted >= 1);
  assert.ok(snapshot.diagnostics.released >= 1);
  assert.ok(diagnostics.some((event) => event.type === 'resource-granted'));
  await runtime.shutdown({ timeoutMs: 10000 });

  const rejectedRoot = tempRoot();
  const rejectedFixture = await generatedFixture(rejectedRoot);
  const rejectedOptions = saveAsOptions(rejectedRoot, rejectedFixture);
  const rejectedInput = createNewAccountSaveAsInput(rejectedOptions);
  const rejectedRuntime = createBackgroundExecutionRuntime({
    availableParallelism: 4,
    freeMemoryBytes: 1,
    totalMemoryBytes: 1,
    memoryHardCeilingBytes: 1,
    systemReserveBytes: 0
  });
  const rejected = await rejectedRuntime.execute({
    actionKey: NEW_ACCOUNT_SAVE_AS_ACTION,
    operationKey: rejectedOptions.operationKey,
    context: rejectedOptions.context,
    input: rejectedInput,
    initTimeoutMs: 0
  });
  assert.equal(rejected.outcome, 'transport-lost');
  assert.equal(rejected.error.code, 'ADMISSION_TIMEOUT');
  assert.equal(fs.existsSync(rejectedOptions.stagingPath), false);
  await rejectedRuntime.shutdown({ timeoutMs: 10000 });
});

test('既有 singleton FIFO Publisher 实际发布一次，正式目标与 E10-A bytes/digests 完全一致', async () => {
  const root = tempRoot('new-account-e10-b-real-publisher-');
  const fixture = await generatedFixture(root);
  const expectedBusinessEvidence = JSON.parse(JSON.stringify(
    fixture.generationResult.artifact.businessEvidence
  ));
  const options = saveAsOptions(root, fixture, {
    taskId: 'new-account-e10-b-real-publisher'
  });
  const runtime = createBackgroundExecutionRuntime({
    availableParallelism: 4,
    freeMemoryBytes: 4 * 1024 ** 3,
    totalMemoryBytes: 8 * 1024 ** 3,
    systemReserveBytes: 0
  });
  const result = await validateAndPublishNewAccountSaveAs({ ...options, runtime });
  assert.equal(result.publication.committed, true);
  assert.equal(fs.existsSync(options.targetPath), true);
  assert.equal(sha256File(options.targetPath), fixture.generationResult.artifact.sha256);
  assert.equal(result.copied.sha256, fixture.generationResult.artifact.sha256);
  assert.deepEqual(fixture.generationResult.artifact.businessEvidence, expectedBusinessEvidence);
  assert.equal(fs.existsSync(options.stagingPath), false);
  assert.equal(
    fs.readdirSync(path.dirname(options.targetPath))
      .filter((name) => name.startsWith('.toolbox-publish-')).length,
    1
  );
  await assert.rejects(
    acknowledgeNewAccountSaveAsPublication({
      taskId: options.taskId,
      userDataDir: options.userDataDir
    }),
    (error) => error.code === 'NEW_ACCOUNT_SAVE_AS_RECEIPT_ACK_PREMATURE'
  );
  await acknowledgeNewAccountSaveAsPublication({
    taskId: options.taskId,
    userDataDir: options.userDataDir,
    taskTerminalPersisted: true
  });
  assert.deepEqual(
    fs.readdirSync(path.dirname(options.targetPath)).filter((name) => name.startsWith('.toolbox-publish-')),
    []
  );
  await runtime.shutdown({ timeoutMs: 10000 });
});

test('真实 E10-B Publisher 在target parent等于fixed recovery root时零持久写入', async () => {
  const root = tempRoot('new-account-e10-b-recovery-root-conflict-');
  const fixture = await generatedFixture(root);
  const base = saveAsOptions(root, fixture, {
    taskId: 'new-account-e10-b-recovery-root-conflict'
  });
  fs.mkdirSync(base.userDataDir, { recursive: true });
  const targetPath = path.join(base.userDataDir, 'saved-as.xlsx');
  const filePlan = normalizeFilePlanV1({
    version: 1,
    allocation: 'eager',
    inputs: [{
      filePath: fixture.sourcePath,
      role: 'new-account-source-artifact',
      sourceOperation: NEW_ACCOUNT_SAVE_AS_ACTION
    }],
    outputs: [{
      filePath: targetPath,
      role: 'new-account-save-as-output',
      sourceOperation: NEW_ACCOUNT_SAVE_AS_ACTION
    }]
  });
  const runtime = createBackgroundExecutionRuntime({
    availableParallelism: 4,
    freeMemoryBytes: 4 * 1024 ** 3,
    totalMemoryBytes: 8 * 1024 ** 3,
    systemReserveBytes: 0
  });
  let settlementCalls = 0;
  await assert.rejects(
    validateAndPublishNewAccountSaveAs({
      ...base,
      filePlan,
      targetPath,
      runtime,
      async settleArtifacts() {
        settlementCalls += 1;
        return { durable: true };
      }
    }),
    (error) => error &&
      error.code === 'TOOLBOX_PUBLICATION_RECOVERY_ROOT_TARGET_PARENT_CONFLICT'
  );
  assert.equal(settlementCalls, 0);
  assert.equal(fs.existsSync(targetPath), false);
  assert.equal(fs.existsSync(base.stagingPath), false);
  assert.deepEqual(fs.readdirSync(base.userDataDir), []);
  assert.equal(sha256File(fixture.sourcePath), fixture.generationResult.artifact.sha256);
  await runtime.shutdown({ timeoutMs: 10000 });
});

test('真实 Publisher committed-but-reply-lost 由同一 journal 恢复，settle 前 Hold、终态后 ack 且不重 copy/publish', async () => {
  const root = tempRoot('new-account-e10-b-committed-reply-lost-');
  const fixture = await generatedFixture(root);
  const options = saveAsOptions(root, fixture, {
    taskId: 'committed-crash-recover-new-account-e10-b'
  });
  const dispatcher = createToolboxPublicationDispatcher({
    workerScriptPath: CRASH_RECOVER_PUBLISHER_WORKER
  });
  let publishCalls = 0;
  let settleCalls = 0;
  const runtime = createBackgroundExecutionRuntime({
    availableParallelism: 4,
    freeMemoryBytes: 4 * 1024 ** 3,
    totalMemoryBytes: 8 * 1024 ** 3,
    systemReserveBytes: 0
  });
  const result = await validateAndPublishNewAccountSaveAs({
    ...options,
    runtime,
    publisher: async (input) => {
      publishCalls += 1;
      return dispatcher.publish({
        ...input,
        requireArchiveHandoff: true,
        requireValidatedArtifacts: true
      });
    },
    async settleArtifacts(payload) {
      settleCalls += 1;
      assert.deepEqual(payload.files.map((file) => file.artifactKey), [
        options.filePlan.inputs[0].artifactKey,
        options.filePlan.outputs[0].artifactKey
      ]);
      return { durable: true };
    }
  });
  assert.equal(result.publication.recoveredAfterWorkerExit, true);
  assert.equal(result.publication.pendingArchiveHandoff, true);
  assert.equal(result.settlement.durable, true);
  assert.equal(publishCalls, 1);
  assert.equal(settleCalls, 1);
  assert.equal(sha256File(options.targetPath), fixture.generationResult.artifact.sha256);

  const firstRecovery = await dispatcher.recover({
    userDataDir: options.userDataDir,
    deferCommittedRecovery: true
  });
  const secondRecovery = await dispatcher.recover({
    userDataDir: options.userDataDir,
    deferCommittedRecovery: true
  });
  for (const recovery of [firstRecovery, secondRecovery]) {
    assert.ok(recovery.recovered.some((item) => (
      item.taskId === options.taskId && item.action === 'commit-handoff-pending'
    )));
  }
  assert.equal(publishCalls, 1);
  assert.equal(settleCalls, 1);
  assert.equal(fs.existsSync(options.stagingPath), false);

  await acknowledgeNewAccountSaveAsPublication({
    taskId: options.taskId,
    userDataDir: options.userDataDir,
    taskTerminalPersisted: true,
    recoverPublications: (request) => dispatcher.recover(request)
  });
  const afterAck = await dispatcher.recover({
    userDataDir: options.userDataDir,
    deferCommittedRecovery: true
  });
  assert.equal(afterAck.recovered.some((item) => item.taskId === options.taskId), false);
  assert.equal(publishCalls, 1);
  assert.equal(settleCalls, 1);
  await runtime.shutdown({ timeoutMs: 10000 });
});

test('Publisher committed 后 settlement failure 不回报可重试失败并保留 RecoverySource receipt', async () => {
  const root = tempRoot('new-account-e10-b-settlement-pending-');
  const fixture = await generatedFixture(root);
  const options = saveAsOptions(root, fixture, {
    taskId: 'new-account-e10-b-settlement-pending'
  });
  const runtime = createBackgroundExecutionRuntime({
    availableParallelism: 4,
    freeMemoryBytes: 4 * 1024 ** 3,
    totalMemoryBytes: 8 * 1024 ** 3,
    systemReserveBytes: 0
  });
  const result = await validateAndPublishNewAccountSaveAs({
    ...options,
    runtime,
    async settleArtifacts() {
      throw Object.assign(new Error('archive temporarily unavailable'), {
        code: 'ARCHIVE_TEMPORARILY_UNAVAILABLE'
      });
    }
  });
  assert.equal(result.publication.committed, true);
  assert.equal(result.publication.pendingArchiveHandoff, true);
  assert.deepEqual(result.settlement, {
    durable: false,
    pendingRecovery: true,
    code: 'ARCHIVE_TEMPORARILY_UNAVAILABLE'
  });
  const pending = await recoverToolboxPublicationsAsync({
    userDataDir: options.userDataDir,
    deferCommittedRecovery: true
  });
  assert.ok(pending.recovered.some((item) => (
    item.taskId === options.taskId && item.action === 'commit-handoff-pending'
  )));
  assert.equal(sha256File(options.targetPath), fixture.generationResult.artifact.sha256);
  await runtime.shutdown({ timeoutMs: 10000 });
});

test('restart recovery 只取消 prepared journal，不 blind replay generation/copy/publish', async () => {
  const root = tempRoot('new-account-e10-b-restart-');
  const fixture = await generatedFixture(root);
  const options = saveAsOptions(root, fixture, {
    taskId: 'new-account-e10-b-restart-prepared'
  });
  prepareToolboxPublication({
    taskId: options.taskId,
    userDataDir: options.userDataDir,
    artifacts: [{
      sourcePath: fixture.sourcePath,
      byteSize: fixture.generationResult.artifact.byteSize,
      sha256: fixture.generationResult.artifact.sha256,
      fileName: path.basename(options.targetPath)
    }],
    targets: [{ targetPath: options.targetPath }],
    protectedSourcePaths: [fixture.sourcePath],
    batchContext: options.batchContext,
    requireValidatedArtifacts: true,
    requireArchiveHandoff: false,
    allowEmptyArchiveInputs: true
  });
  assert.equal(fs.existsSync(options.targetPath), false);
  const recovered = await recoverToolboxPublicationsAsync({ userDataDir: options.userDataDir });
  assert.ok(recovered.recovered.some((entry) => (
    entry.taskId === options.taskId && entry.action === 'cancelled-prepared'
  )));
  assert.equal(fs.existsSync(options.targetPath), false);
  assert.equal(sha256File(fixture.sourcePath), fixture.generationResult.artifact.sha256);
  const index = JSON.parse(fs.readFileSync(
    path.join(options.userDataDir, 'toolbox-publish-journal-index.json'),
    'utf8'
  ));
  assert.deepEqual(index.entries, []);
});

test('event-loop heartbeat 持续；copyFile 中 shutdown cancel 在 post-copy safepoint 胜出并清 staging', async () => {
  const root = tempRoot('new-account-e10-b-heartbeat-cancel-');
  const fixture = await generatedFixture(root);
  const options = saveAsOptions(root, fixture);
  const input = createNewAccountSaveAsInput(options);
  const controller = new AbortController();
  let markCopyStarted;
  let releaseCopy;
  const copyStarted = new Promise((resolve) => { markCopyStarted = resolve; });
  const copyGate = new Promise((resolve) => { releaseCopy = resolve; });
  let heartbeatObserved = false;
  const copy = executeNewAccountArtifactCopy(input, controller.signal, {
    fsPromises: {
      async copyFile(sourcePath, destinationPath, flags) {
        markCopyStarted();
        await copyGate;
        return fs.promises.copyFile(sourcePath, destinationPath, flags);
      }
    }
  });
  await copyStarted;
  await new Promise((resolve) => setTimeout(() => {
    heartbeatObserved = true;
    resolve();
  }, 0));
  controller.abort({ reason: 'app-quit' });
  releaseCopy();
  await assert.rejects(
    copy,
    (error) => error.code === 'NEW_ACCOUNT_SAVE_AS_CANCELLED'
  );
  assert.equal(heartbeatObserved, true);
  assert.equal(fs.existsSync(options.stagingPath), false);
  assert.equal(fs.existsSync(options.targetPath), false);
});

test('runtime app quit 对 running inline copy 返回 cancelled、释放 lease 且 Publisher=0', async () => {
  const root = tempRoot('new-account-e10-b-app-quit-');
  const fixture = await generatedFixture(root);
  // 放大 source，确保 shutdown 在 async hash/copy 阶段可达；仅测试 copy lifecycle，
  // 不进入 business validation/Publisher。
  const large = Buffer.alloc(32 * 1024 * 1024, 0x5a);
  fs.writeFileSync(fixture.sourcePath, large);
  fixture.generationResult = {
    ...fixture.generationResult,
    artifact: {
      ...fixture.generationResult.artifact,
      byteSize: large.length,
      sha256: sha256File(fixture.sourcePath)
    }
  };
  const options = saveAsOptions(root, fixture, {
    operationKey: 'new-account-e10-b-app-quit',
    context: operationContext('new-account-e10-b-app-quit'),
    batchContext: batchContext('new-account-e10-b-app-quit')
  });
  const input = createNewAccountSaveAsInput(options);
  const runtime = createBackgroundExecutionRuntime({
    availableParallelism: 4,
    freeMemoryBytes: 4 * 1024 ** 3,
    totalMemoryBytes: 8 * 1024 ** 3,
    systemReserveBytes: 0,
    shutdownTimeoutMs: 10000
  });
  const handle = runtime.start({
    actionKey: NEW_ACCOUNT_SAVE_AS_ACTION,
    operationKey: options.operationKey,
    context: options.context,
    input
  });
  await handle.ready;
  const shutdown = runtime.shutdown({ timeoutMs: 10000 });
  const [execution, report] = await Promise.all([handle.promise, shutdown]);
  assert.equal(execution.outcome, 'cancelled');
  assert.equal(execution.error.code, 'INLINE_EXECUTION_ERROR');
  assert.equal(fs.existsSync(options.stagingPath), false);
  assert.equal(fs.existsSync(options.targetPath), false);
  assert.equal(runtime.resourceGovernor.snapshot().activeUsage.ioHeavySlots, 0);
  assert.deepEqual(report.leakedTransports, []);
  assert.deepEqual(report.errors, []);
});

test('真实慢 copy shutdown 等 execution 收口后才释放 I/O lease/报告 leak=0', async () => {
  const root = tempRoot('new-account-e10-b-slow-copy-shutdown-');
  const fixture = await generatedFixture(root);
  const options = saveAsOptions(root, fixture, {
    operationKey: 'new-account-e10-b-slow-copy-shutdown',
    context: operationContext('new-account-e10-b-slow-copy-shutdown')
  });
  const input = createNewAccountSaveAsInput(options);
  const originalCopyFile = fs.promises.copyFile;
  let enteredCopy;
  let releaseCopy;
  const copyEntered = new Promise((resolve) => { enteredCopy = resolve; });
  const copyGate = new Promise((resolve) => { releaseCopy = resolve; });
  fs.promises.copyFile = async (...args) => {
    enteredCopy();
    await copyGate;
    return originalCopyFile.call(fs.promises, ...args);
  };
  const runtime = createBackgroundExecutionRuntime({
    availableParallelism: 4,
    freeMemoryBytes: 4 * 1024 ** 3,
    totalMemoryBytes: 8 * 1024 ** 3,
    systemReserveBytes: 0,
    shutdownTimeoutMs: 10000
  });
  try {
    const handle = runtime.start({
      actionKey: NEW_ACCOUNT_SAVE_AS_ACTION,
      operationKey: options.operationKey,
      context: options.context,
      input
    });
    await handle.ready;
    await copyEntered;
    const shutdown = runtime.shutdown({ timeoutMs: 10000 });
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(runtime.resourceGovernor.snapshot().activeUsage.ioHeavySlots, 1);
    releaseCopy();
    const [execution, report] = await Promise.all([handle.promise, shutdown]);
    assert.equal(execution.outcome, 'cancelled');
    assert.deepEqual(report.leakedTransports, []);
    assert.deepEqual(report.errors, []);
    assert.equal(runtime.resourceGovernor.snapshot().activeUsage.ioHeavySlots, 0);
    assert.equal(fs.existsSync(options.stagingPath), false);
  } finally {
    fs.promises.copyFile = originalCopyFile;
    releaseCopy();
  }
});

test('真实慢 copy 超过 shutdown deadline 报 transport leak 并保留 execution/staging cleanup owner', async () => {
  const root = tempRoot('new-account-e10-b-slow-copy-timeout-');
  const fixture = await generatedFixture(root);
  const options = saveAsOptions(root, fixture, {
    operationKey: 'new-account-e10-b-slow-copy-timeout',
    context: operationContext('new-account-e10-b-slow-copy-timeout')
  });
  const input = createNewAccountSaveAsInput(options);
  const originalCopyFile = fs.promises.copyFile;
  let enteredCopy;
  let releaseCopy;
  const copyEntered = new Promise((resolve) => { enteredCopy = resolve; });
  const copyGate = new Promise((resolve) => { releaseCopy = resolve; });
  fs.promises.copyFile = async (...args) => {
    enteredCopy();
    await copyGate;
    return originalCopyFile.call(fs.promises, ...args);
  };
  const runtime = createBackgroundExecutionRuntime({
    availableParallelism: 4,
    freeMemoryBytes: 4 * 1024 ** 3,
    totalMemoryBytes: 8 * 1024 ** 3,
    systemReserveBytes: 0,
    shutdownTimeoutMs: 20
  });
  try {
    const handle = runtime.start({
      actionKey: NEW_ACCOUNT_SAVE_AS_ACTION,
      operationKey: options.operationKey,
      context: options.context,
      input
    });
    await handle.ready;
    await copyEntered;
    const report = await runtime.shutdown({ timeoutMs: 20 });
    assert.deepEqual(report.leakedTransports, [handle.jobId]);
    assert.ok(report.errors.some((error) => error.code === 'SHUTDOWN_TIMEOUT'));
    assert.equal(runtime.resourceGovernor.snapshot().activeUsage.ioHeavySlots, 1);
    releaseCopy();
    const execution = await handle.promise;
    assert.notEqual(execution.outcome, 'completed');
    assert.equal(fs.existsSync(options.stagingPath), false);
  } finally {
    fs.promises.copyFile = originalCopyFile;
    releaseCopy();
  }
});

test('Windows missing-target case/Unicode identity fail closed，source/target exact evidence不猜路径', async () => {
  const root = tempRoot('new-account-e10-b-win-path-');
  const fixture = await generatedFixture(root);
  const stagingRoot = path.join(root, 'staging');
  fs.mkdirSync(stagingRoot);
  const stagingPath = path.join(stagingRoot, 'copy.xlsx');
  const rawPlan = {
    version: 1,
    allocation: 'eager',
    inputs: [{
      filePath: fixture.sourcePath,
      role: 'source',
      sourceOperation: NEW_ACCOUNT_SAVE_AS_ACTION
    }],
    outputs: [{
      filePath: path.join(path.dirname(fixture.sourcePath), path.basename(fixture.sourcePath).toUpperCase()),
      role: 'output',
      sourceOperation: NEW_ACCOUNT_SAVE_AS_ACTION
    }]
  };
  assert.throws(
    () => normalizeFilePlanV1(rawPlan, { platform: 'win32' }),
    /别名|覆盖/
  );
  const unsafePlan = {
    ...rawPlan,
    outputs: [{
      ...rawPlan.outputs[0],
      filePath: path.join(root, 'straße.xlsx')
    }]
  };
  assert.throws(
    () => normalizeFilePlanV1(unsafePlan, { platform: 'win32' }),
    (error) => error.code === 'TARGET_IDENTITY_WINDOWS_CASE_MAPPING_UNSAFE'
  );
});
