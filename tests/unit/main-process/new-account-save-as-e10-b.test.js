'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { normalizeFilePlanV1 } = require('../../../src/main-process/archive-center/file-plan');
const {
  createBackgroundExecutionRuntime,
  isBackgroundExecutionProductionEnabled
} = require('../../../src/main-process/background-execution/runtime');
const {
  prepareToolboxPublication
} = require('../../../src/main-process/toolbox-output-publication');
const {
  recoverToolboxPublicationsAsync
} = require('../../../src/main-process/toolbox-output-publication-dispatch');
const {
  createNewAccountWorkerInput
} = require('../../../src/main-process/new-account/generation-validator');
const {
  executeNewAccountGeneration
} = require('../../../src/main-process/new-account/generation-core');
const {
  NEW_ACCOUNT_SAVE_AS_ACTION,
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
  return { sourcePath, generationResult };
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
  const ancestorPlan = normalizeFilePlanV1({
    version: 1,
    allocation: 'eager',
    inputs: [{ filePath: fixture.sourcePath, role: 'source', sourceOperation: NEW_ACCOUNT_SAVE_AS_ACTION }],
    outputs: [{
      filePath: path.join(targetDirLink, 'saved.xlsx'),
      role: 'output',
      sourceOperation: NEW_ACCOUNT_SAVE_AS_ACTION
    }]
  });
  assert.throws(
    () => createNewAccountSaveAsInput({ ...base, filePlan: ancestorPlan }),
    (error) => error.code === 'NEW_ACCOUNT_SAVE_AS_PATH_SYMLINK'
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
    'business'
  ]) {
    await t.test(phase, async () => {
      const root = tempRoot(`new-account-e10-b-publisher-${phase}-`);
      const fixture = await generatedFixture(root);
      if (phase === 'business') {
        fixture.generationResult = {
          ...fixture.generationResult,
          artifact: {
            ...fixture.generationResult.artifact,
            businessEvidence: {
              ...fixture.generationResult.artifact.businessEvidence,
              recordsSha256: '0'.repeat(64)
            }
          }
        };
      }
      const options = saveAsOptions(root, fixture);
      let publisherCalls = 0;
      let publicationInput = null;
      const publisher = async (input) => {
        publisherCalls += 1;
        publicationInput = input;
        return { taskId: options.taskId, committed: true };
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
        assert.equal(publicationInput.targets[0].targetPath, options.filePlan.outputs[0].filePath);
        assert.equal(publicationInput.artifacts[0].sourcePath, options.stagingPath);
        assert.equal(publicationInput.artifacts[0].sha256, fixture.generationResult.artifact.sha256);
        assert.equal(fs.existsSync(options.stagingPath), false);
        await runtime.shutdown({ timeoutMs: 10000 });
      } else {
        const runtime = createBackgroundExecutionRuntime({
          availableParallelism: 4,
          freeMemoryBytes: 4 * 1024 ** 3,
          totalMemoryBytes: 8 * 1024 ** 3,
          systemReserveBytes: 0
        });
        await assert.rejects(
          validateAndPublishNewAccountSaveAs({
            ...options,
            runtime,
            publisher,
            onCopyCompleted
          })
        );
        assert.equal(publisherCalls, 0);
        await runtime.shutdown({ timeoutMs: 10000 });
      }
    });
  }
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
  assert.deepEqual(
    fs.readdirSync(path.dirname(options.targetPath)).filter((name) => name.startsWith('.toolbox-publish-')),
    []
  );
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
  let ticks = 0;
  const timer = setInterval(() => { ticks += 1; }, 5);
  const copy = executeNewAccountArtifactCopy(input, controller.signal, {
    fsPromises: {
      async copyFile(sourcePath, destinationPath, flags) {
        await new Promise((resolve) => setTimeout(resolve, 60));
        return fs.promises.copyFile(sourcePath, destinationPath, flags);
      }
    }
  });
  setTimeout(() => controller.abort({ reason: 'app-quit' }), 10);
  try {
    await assert.rejects(
      copy,
      (error) => error.code === 'NEW_ACCOUNT_SAVE_AS_CANCELLED'
    );
  } finally {
    clearInterval(timer);
  }
  assert.ok(ticks >= 5, `heartbeat ticks=${ticks}`);
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
    () => createNewAccountSaveAsInput({
      filePlan: rawPlan,
      sourceGenerationResult: fixture.generationResult,
      stagingRoot,
      stagingResourceId: 'copy.xlsx',
      stagingPath,
      platform: 'win32'
    }),
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
    () => createNewAccountSaveAsInput({
      filePlan: unsafePlan,
      sourceGenerationResult: fixture.generationResult,
      stagingRoot,
      stagingResourceId: 'copy.xlsx',
      stagingPath,
      platform: 'win32'
    }),
    (error) => error.code === 'TARGET_IDENTITY_WINDOWS_CASE_MAPPING_UNSAFE'
  );
});
