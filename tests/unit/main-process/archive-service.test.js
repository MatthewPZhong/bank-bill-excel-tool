'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const {
  DEFAULT_STARTUP_MATERIALIZATION_BATCH_SIZE,
  ArchiveService,
  blobRelativePath,
  createArchiveService
} = require('../../../src/main-process/archive-center/archive-service');
const {
  sourceSnapshotFromStat,
  sourceSnapshotMatchesStat
} = require('../../../src/main-process/archive-center/source-snapshot');
const {
  createArchiveRepository
} = require('../../../src/backend/database/archive-repository');
const {
  artifactManifestFromFilePlan,
  normalizeFilePlanV1
} = require('../../../src/main-process/archive-center/file-plan');
const {
  createTaskLifecycle
} = require('../../../src/main-process/archive-center/task-lifecycle');
const {
  transitionRequestKey
} = require('../../../src/main-process/background-execution/recovery-control-contract');
const {
  createRecoveryControlRepository
} = require('../../../src/main-process/background-execution/critical/recovery-control-repository');
const {
  createRecoveryRequestOwnerRepository
} = require('../../../src/main-process/background-execution/critical/recovery-request-owner-repository');
const {
  createBusinessFlowResolver
} = require('../../../src/main-process/archive-center/business-flow-resolver');
const {
  createBankStatementRunFlowIdentity,
  createTaskPolicyRegistry
} = require('../../../src/main-process/archive-center/task-policy-registry');

function createFixture(options = {}) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-service-'));
  const rootDir = path.join(tempDir, 'archive-root');
  const sourceDir = path.join(tempDir, 'sources');
  fs.mkdirSync(sourceDir, { recursive: true });
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  const service = createArchiveService({
    database: db,
    rootDir,
    now: () => new Date(2026, 6, 20, 12, 0, 0),
    ...options
  });
  return {
    db,
    repository: service.repository,
    rootDir,
    service,
    sourceDir,
    tempDir,
    close() {
      db.close();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  };
}

function batchPayload(operationKey, overrides = {}) {
  return {
    moduleId: 'bank-statement',
    moduleCode: 'BANK',
    moduleName: '网银账单',
    operationKey,
    ...overrides
  };
}

function createLegacyEmptyBatch(fixture, operationKey) {
  fixture.repository.ensureSchema();
  return fixture.repository.createBatch({
    ...batchPayload(operationKey),
    localDate: '2026-07-20',
    retentionUntil: '2026-09-18'
  }).batch;
}

function writeSource(fixture, name, content) {
  const filePath = path.join(fixture.sourceDir, name);
  fs.writeFileSync(filePath, content);
  return filePath;
}

test('deferred 零输出不占号，跨日 promote 以实际建批日形成 running batch', async () => {
  let now = new Date(2026, 7, 17, 23, 59, 59);
  const fixture = createFixture({ now: () => now });
  try {
    await fixture.service.initialize();
    const zeroTask = (await fixture.service.beginTaskRun({
      taskRunId: 'deferred-zero-task',
      taskKey: 'monthly-balance:assemble',
      moduleId: 'bank-statement',
      parentRunId: 'deferred-parent',
      operationKey: 'deferred-zero-operation'
    })).taskRun;
    await fixture.service.markTaskRunStarted(zeroTask.taskRunId);
    await fixture.service.finishTaskRun(zeroTask.taskRunId, { taskStatus: 'failed' });
    assert.equal(fixture.db.prepare('SELECT COUNT(*) count FROM archive_daily_sequences').get().count, 0);

    const promotedTask = (await fixture.service.beginTaskRun({
      taskRunId: 'deferred-promoted-task',
      taskKey: 'new-account:generate',
      moduleId: 'new-account',
      parentRunId: 'deferred-parent',
      operationKey: 'deferred-promoted-operation'
    })).taskRun;
    await fixture.service.markTaskRunStarted(promotedTask.taskRunId);
    now = new Date(2026, 7, 18, 0, 0, 1);
    const outputPath = path.join(fixture.sourceDir, 'promoted.xlsx');
    const manifest = artifactManifestFromFilePlan(normalizeFilePlanV1({
      version: 1,
      allocation: 'eager',
      inputs: [],
      outputs: [{
        filePath: outputPath,
        role: 'output',
        sourceOperation: 'new-account:generate'
      }]
    }));
    const reserved = await fixture.service.reserveFileTaskBatch({
      taskRun: promotedTask,
      manifest,
      moduleCode: 'NEWACCOUNT',
      moduleName: '新开账户'
    });
    assert.equal(reserved.batch.localDate, '2026-08-18');
    assert.equal(reserved.batch.globalDailySequence, 1);
    assert.equal(reserved.batch.taskStatus, 'running');
    assert.ok(reserved.batch.startedAt);
  } finally {
    fixture.close();
  }
});

test('Bank Statement run TaskRun 与重启后重复 export File Batch 持久继承 parent，rerun 新建 parent', async () => {
  const fixture = createFixture();
  try {
    await fixture.service.initialize();
    let parentSequence = 0;
    let taskSequence = 0;
    const createLifecycle = () => createTaskLifecycle({
      businessOperationRegistry: {
        begin() { return { accepted: true, token: `operation-${taskSequence + 1}` }; },
        end() {}
      },
      archiveService: fixture.service,
      flowResolver: createBusinessFlowResolver({
        archiveService: fixture.service,
        createParentRunId: () => `bank-parent-${++parentSequence}`
      }),
      operationTracker: { async appendOperationFiles() { return { archiveFailed: false }; } },
      createTaskRunId: () => `bank-task-${++taskSequence}`
    });
    const registry = createTaskPolicyRegistry();
    const runPolicy = registry.require('bank-statement:run');
    const exportPolicy = registry.require('bank-statement:export');
    const firstIdentity = createBankStatementRunFlowIdentity(() => 'durable-run-1');
    await createLifecycle().runOperationOnly({
      policy: runPolicy,
      meta: { channel: runPolicy.channel },
      flowPlanResolver: () => ({ startsNewFlow: true, flowIdentity: firstIdentity }),
      execute: () => ({ status: 'ok' })
    });

    for (let index = 0; index < 2; index += 1) {
      const outputPath = path.join(fixture.sourceDir, `bank-export-${index}.xlsx`);
      const filePlan = normalizeFilePlanV1({
        version: 1,
        allocation: 'eager',
        inputs: [],
        outputs: [{ filePath: outputPath, role: 'output', sourceOperation: exportPolicy.channel }]
      });
      await createLifecycle().runFileTask({
        policy: exportPolicy,
        meta: { channel: exportPolicy.channel },
        flowPlanResolver: () => ({ startsNewFlow: false, flowIdentity: firstIdentity }),
        filePlanResolver: () => filePlan,
        execute: async (_context, controls) => {
          fs.writeFileSync(outputPath, `export-${index}`);
          await controls.settleArtifacts({
            files: filePlan.outputs.map((item) => ({ artifactKey: item.artifactKey }))
          });
          return { status: 'ok' };
        }
      });
    }

    const secondIdentity = createBankStatementRunFlowIdentity(() => 'durable-run-2');
    await createLifecycle().runOperationOnly({
      policy: runPolicy,
      meta: { channel: runPolicy.channel },
      flowPlanResolver: () => ({ startsNewFlow: true, flowIdentity: secondIdentity }),
      execute: () => ({ status: 'ok' })
    });
    const firstRun = fixture.repository.getTaskRun('bank-task-1');
    const rawBatches = fixture.repository.listBatches({ limit: 100 });
    const firstExport = rawBatches.find((batch) => batch.taskRunId === 'bank-task-2');
    const repeatedExport = rawBatches.find((batch) => batch.taskRunId === 'bank-task-3');
    const rerun = fixture.repository.getTaskRun('bank-task-4');
    assert.equal(firstRun.parentRunId, 'bank-parent-1');
    assert.equal(firstExport.parentRunId, firstRun.parentRunId);
    assert.equal(repeatedExport.parentRunId, firstRun.parentRunId);
    assert.equal(rerun.parentRunId, 'bank-parent-2');
  } finally {
    fixture.close();
  }
});

test('public list/detail 剔除 manifest、alias、snapshot 与 target parent identity', async () => {
  const fixture = createFixture();
  try {
    await fixture.service.initialize();
    const inputPath = writeSource(fixture, 'manifest-input.xlsx', 'input');
    const outputPath = path.join(fixture.sourceDir, 'manifest-output.xlsx');
    const task = (await fixture.service.beginTaskRun({
      taskRunId: 'public-manifest-task',
      taskKey: 'toolbox:merge',
      moduleId: 'toolbox',
      parentRunId: 'public-manifest-parent',
      operationKey: 'public-manifest-operation'
    })).taskRun;
    const manifest = artifactManifestFromFilePlan(normalizeFilePlanV1({
      version: 1,
      allocation: 'eager',
      inputs: [{
        filePath: inputPath,
        role: 'toolbox-merge-source',
        sourceOperation: 'toolbox:merge'
      }],
      outputs: [{
        filePath: outputPath,
        role: 'toolbox-merge-output',
        sourceOperation: 'toolbox:merge'
      }]
    }));
    const reserved = await fixture.service.reserveFileTaskBatch({
      taskRun: task,
      manifest,
      moduleCode: 'TOOLBOX',
      moduleName: '工具箱'
    });
    const listed = await fixture.service.listBatches({ moduleId: 'toolbox' });
    assert.equal('_fileManifest' in listed.batches[0].metadata, false);
    for (const key of ['taskRunId', 'taskKey', 'operationKey', 'parentRunId']) {
      assert.equal(key in listed.batches[0], false, key);
    }
    const detail = await fixture.service.getBatch(reserved.batchId);
    assert.equal('_fileManifest' in detail.batch.metadata, false);
    for (const key of ['taskRunId', 'taskKey', 'operationKey', 'parentRunId']) {
      assert.equal(key in detail.batch, false, key);
    }
    for (const artifact of detail.batch.artifacts) {
      assert.equal('sourcePath' in artifact, false);
      assert.equal('aliasKey' in artifact.metadata, false);
      assert.equal('sourceSnapshot' in artifact.metadata, false);
      assert.equal('targetSnapshot' in artifact.metadata, false);
      assert.equal('targetParentIdentity' in artifact.metadata, false);
    }
    const raw = fixture.repository.getBatchDetail(reserved.batchId);
    assert.equal(Boolean(raw.metadata._fileManifest), true);
    assert.equal(Boolean(raw.artifacts[0].metadata.aliasKey), true);
    const rawOutput = raw.artifacts.find((artifact) => artifact.direction === 'output');
    assert.deepEqual(
      rawOutput.metadata.targetParentIdentity,
      manifest.outputs[0].targetParentIdentity
    );
    assert.equal(raw.taskRunId, task.taskRunId);
    assert.equal(raw.taskKey, task.taskKey);
    assert.equal(raw.operationKey, task.operationKey);
    assert.equal(raw.parentRunId, task.parentRunId);
  } finally {
    fixture.close();
  }
});

test('public VCC File Task 隐藏与 taskRunId 同值的 metadata.batchId，保留 raw 与业务异值', async () => {
  const fixture = createFixture();
  try {
    await fixture.service.initialize();
    const inputPath = writeSource(fixture, 'vcc-public-input.xlsx', 'vcc-input');
    const task = (await fixture.service.beginTaskRun({
      taskRunId: 'vcc-public-file-task',
      taskKey: 'vccFinancialOp:import:apply',
      moduleId: 'vcc-financial-op',
      parentRunId: 'vcc-public-parent',
      operationKey: 'vcc-public-file-operation'
    })).taskRun;
    const manifest = artifactManifestFromFilePlan(normalizeFilePlanV1({
      version: 1,
      allocation: 'eager',
      inputs: [{
        filePath: inputPath,
        role: 'input',
        sourceOperation: 'vccFinancialOp:import:apply'
      }],
      outputs: []
    }));
    const reserved = await fixture.service.reserveFileTaskBatch({
      taskRun: task,
      manifest,
      moduleCode: 'VCCFINOP',
      moduleName: 'VCC财务OP校验'
    });
    const batchContext = {
      batchId: reserved.batch.id,
      batchNumber: reserved.batch.batchNumber,
      taskRunId: task.taskRunId,
      taskKey: task.taskKey,
      moduleId: task.moduleId,
      parentRunId: task.parentRunId,
      operationKey: task.operationKey
    };
    await fixture.service.startFileTask(task.taskRunId, reserved.batch.id);
    const settled = await fixture.service.settleManifestArtifacts({
      batchContext,
      files: [{ artifactKey: manifest.inputs[0].artifactKey }]
    });
    assert.equal(settled.durable, true);
    const finished = await fixture.service.finishFileTask(task.taskRunId, reserved.batch.id, {
      taskStatus: 'succeeded',
      metadata: { batchId: task.taskRunId }
    });
    assert.equal(finished.ok, true);

    const listed = await fixture.service.listBatches({ moduleId: task.moduleId });
    const publicListBatch = listed.batches.find((batch) => batch.id === reserved.batch.id);
    const publicDetail = await fixture.service.getBatch(reserved.batch.id);
    assert.equal('taskRunId' in publicListBatch, false);
    assert.equal('batchId' in publicListBatch.metadata, false);
    assert.equal('taskRunId' in publicDetail.batch, false);
    assert.equal('batchId' in publicDetail.batch.metadata, false);

    const rawBatch = fixture.repository.getBatch(reserved.batch.id);
    const rawDetail = fixture.repository.getBatchDetail(reserved.batch.id);
    assert.equal(rawBatch.metadata.batchId, task.taskRunId);
    assert.equal(rawDetail.metadata.batchId, task.taskRunId);

    const businessBatchId = 'vcc-business-import-batch';
    fixture.db.prepare('UPDATE archive_batches SET metadata_json = ? WHERE id = ?').run(
      JSON.stringify({ ...rawBatch.metadata, batchId: businessBatchId }),
      reserved.batch.id
    );
    const relisted = await fixture.service.listBatches({ moduleId: task.moduleId });
    const publicBusinessBatch = relisted.batches.find((batch) => batch.id === reserved.batch.id);
    const businessDetail = await fixture.service.getBatch(reserved.batch.id);
    assert.equal(publicBusinessBatch.metadata.batchId, businessBatchId);
    assert.equal(businessDetail.batch.metadata.batchId, businessBatchId);
  } finally {
    fixture.close();
  }
});

test('File Batch 保留期由 service 统一应用默认、永久与显式天数语义', async () => {
  const fixture = createFixture();
  try {
    await fixture.service.initialize();
    const cases = [
      { label: 'default', retentionDays: undefined, expected: '2026-09-18' },
      { label: 'permanent', retentionDays: 'permanent', expected: null },
      { label: 'seven-days', retentionDays: 7, expected: '2026-07-27' }
    ];
    for (const item of cases) {
      const inputPath = writeSource(fixture, `${item.label}.xlsx`, item.label);
      const task = (await fixture.service.beginTaskRun({
        taskRunId: `retention-${item.label}-task`,
        taskKey: 'toolbox:merge',
        moduleId: 'toolbox',
        parentRunId: `retention-${item.label}-parent`,
        operationKey: `retention-${item.label}-operation`
      })).taskRun;
      const manifest = artifactManifestFromFilePlan(normalizeFilePlanV1({
        version: 1,
        allocation: 'eager',
        inputs: [{ filePath: inputPath, role: 'input', sourceOperation: 'toolbox:merge' }],
        outputs: []
      }));
      const reserved = await fixture.service.reserveFileTaskBatch({
        taskRun: task,
        manifest,
        moduleCode: 'TOOLBOX',
        moduleName: '工具箱',
        ...(item.retentionDays === undefined ? {} : { retentionDays: item.retentionDays })
      });
      assert.equal(reserved.ok, true);
      assert.equal(reserved.batch.retentionUntil, item.expected);
    }
  } finally {
    fixture.close();
  }
});

test('manifest settle 只接受已登记 key，并以 publication SHA/size 校验输出 Blob', async () => {
  const fixture = createFixture();
  try {
    await fixture.service.initialize();
    const inputPath = writeSource(fixture, 'settle-input.xlsx', 'input-evidence');
    const outputPath = path.join(fixture.sourceDir, 'settle-output.xlsx');
    const task = (await fixture.service.beginTaskRun({
      taskRunId: 'settle-task',
      taskKey: 'toolbox:merge',
      moduleId: 'toolbox',
      parentRunId: 'settle-parent',
      operationKey: 'settle-operation'
    })).taskRun;
    const manifest = artifactManifestFromFilePlan(normalizeFilePlanV1({
      version: 1,
      allocation: 'eager',
      inputs: [{ filePath: inputPath, role: 'input', sourceOperation: 'toolbox:merge' }],
      outputs: [{ filePath: outputPath, role: 'output', sourceOperation: 'toolbox:merge' }]
    }));
    const reserved = await fixture.service.reserveFileTaskBatch({
      taskRun: task,
      manifest,
      moduleCode: 'TOOLBOX',
      moduleName: '工具箱'
    });
    const batchContext = {
      batchId: reserved.batch.id,
      batchNumber: reserved.batch.batchNumber,
      taskRunId: task.taskRunId,
      taskKey: task.taskKey,
      moduleId: task.moduleId,
      parentRunId: task.parentRunId,
      operationKey: task.operationKey
    };
    await fixture.service.startFileTask(task.taskRunId, reserved.batch.id);
    fs.writeFileSync(outputPath, 'published-output');
    const outputBytes = fs.readFileSync(outputPath);
    const outputSha256 = crypto.createHash('sha256').update(outputBytes).digest('hex');

    const unknown = await fixture.service.settleManifestArtifacts({
      batchContext,
      files: [{ artifactKey: 'unknown' }]
    });
    assert.equal(unknown.ok, false);
    assert.equal(unknown.code, 'ARCHIVE_MANIFEST_ARTIFACT_UNKNOWN');

    const settled = await fixture.service.settleManifestArtifacts({
      batchContext,
      files: [
        { artifactKey: manifest.inputs[0].artifactKey },
        {
          artifactKey: manifest.outputs[0].artifactKey,
          expectedSha256: outputSha256,
          expectedSizeBytes: outputBytes.length
        }
      ]
    });
    assert.equal(settled.ok, true);
    const outputArtifact = fixture.repository.listArtifacts(reserved.batch.id)
      .find((artifact) => artifact.direction === 'output');
    assert.equal(outputArtifact.status, 'ready');
    assert.equal(outputArtifact.blob.sha256, outputSha256);
    assert.equal(outputArtifact.blob.sizeBytes, outputBytes.length);

    const mismatched = await fixture.service.settleManifestArtifacts({
      batchContext,
      files: [{
        artifactKey: manifest.outputs[0].artifactKey,
        expectedSha256: '0'.repeat(64),
        expectedSizeBytes: outputBytes.length
      }]
    });
    assert.equal(mismatched.ok, false);
  } finally {
    fixture.close();
  }
});

test('manifest settle 在 attempt 前耐久保存 evidence，失败后的无参 retry 继续校验', async () => {
  const fixture = createFixture();
  try {
    await fixture.service.initialize();
    const inputPath = writeSource(fixture, 'durable-input.xlsx', 'input');
    const outputPath = writeSource(fixture, 'durable-output.xlsx', 'actual-output');
    const task = (await fixture.service.beginTaskRun({
      taskRunId: 'durable-evidence-task',
      taskKey: 'toolbox:merge',
      moduleId: 'toolbox',
      parentRunId: 'durable-evidence-parent',
      operationKey: 'durable-evidence-operation'
    })).taskRun;
    const manifest = artifactManifestFromFilePlan(normalizeFilePlanV1({
      version: 1,
      allocation: 'eager',
      inputs: [{ filePath: inputPath, role: 'input', sourceOperation: 'toolbox:merge' }],
      outputs: [{ filePath: outputPath, role: 'output', sourceOperation: 'toolbox:merge' }]
    }));
    const reserved = await fixture.service.reserveFileTaskBatch({
      taskRun: task,
      manifest,
      moduleCode: 'TOOLBOX',
      moduleName: '工具箱'
    });
    const batchContext = {
      batchId: reserved.batch.id,
      batchNumber: reserved.batch.batchNumber,
      taskRunId: task.taskRunId,
      taskKey: task.taskKey,
      moduleId: task.moduleId,
      parentRunId: task.parentRunId,
      operationKey: task.operationKey
    };
    await fixture.service.startFileTask(task.taskRunId, reserved.batch.id);
    const expectedSha256 = '0'.repeat(64);
    const expectedSizeBytes = fs.statSync(outputPath).size;
    const first = await fixture.service.settleManifestArtifacts({
      batchContext,
      files: [{
        artifactKey: manifest.outputs[0].artifactKey,
        expectedSha256,
        expectedSizeBytes
      }]
    });
    assert.equal(first.ok, false);
    const afterFirst = fixture.repository.getArtifactByKey(
      reserved.batch.id,
      manifest.outputs[0].artifactKey
    );
    assert.equal(afterFirst.metadata.expectedSha256, expectedSha256);
    assert.equal(afterFirst.metadata.expectedSizeBytes, expectedSizeBytes);

    const retried = await fixture.service.settleManifestArtifacts({
      batchContext,
      files: [{ artifactKey: manifest.outputs[0].artifactKey }]
    });
    assert.equal(retried.ok, false);
    assert.equal(
      fixture.repository.getArtifactByKey(reserved.batch.id, manifest.outputs[0].artifactKey)
        .metadata.expectedSha256,
      expectedSha256
    );
  } finally {
    fixture.close();
  }
});

test('显式 settle 的 eager output 未形成时耐久记为 OUTPUT_NOT_PRODUCED 并允许业务成功终结', async () => {
  const fixture = createFixture();
  try {
    await fixture.service.initialize();
    const outputPath = path.join(fixture.sourceDir, 'missing-output.xlsx');
    const task = (await fixture.service.beginTaskRun({
      taskRunId: 'missing-output-task',
      taskKey: 'toolbox:merge',
      moduleId: 'toolbox',
      parentRunId: 'missing-output-parent',
      operationKey: 'missing-output-operation'
    })).taskRun;
    const manifest = artifactManifestFromFilePlan(normalizeFilePlanV1({
      version: 1,
      allocation: 'eager',
      inputs: [],
      outputs: [{ filePath: outputPath, role: 'output', sourceOperation: 'toolbox:merge' }]
    }));
    const reserved = await fixture.service.reserveFileTaskBatch({
      taskRun: task,
      manifest,
      moduleCode: 'TOOLBOX',
      moduleName: '工具箱'
    });
    const batchContext = {
      batchId: reserved.batch.id,
      batchNumber: reserved.batch.batchNumber,
      taskRunId: task.taskRunId,
      taskKey: task.taskKey,
      moduleId: task.moduleId,
      parentRunId: task.parentRunId,
      operationKey: task.operationKey
    };
    await fixture.service.startFileTask(task.taskRunId, reserved.batch.id);
    const settled = await fixture.service.settleManifestArtifacts({
      batchContext,
      files: [{ artifactKey: manifest.outputs[0].artifactKey }]
    });
    assert.equal(settled.ok, false);
    assert.equal(settled.durable, true);
    assert.equal(settled.results[0].code, 'ARCHIVE_OUTPUT_NOT_PRODUCED');
    const finished = await fixture.service.finishFileTask(task.taskRunId, reserved.batch.id, {
      taskStatus: 'succeeded',
      metadata: {}
    });
    assert.equal(finished.ok, true);
    assert.equal(finished.taskRun.status, 'succeeded');
    assert.equal(finished.batch.taskStatus, 'succeeded');
    assert.equal(finished.batch.archiveStatus, 'incomplete');
  } finally {
    fixture.close();
  }
});

test('Bank Statement 多输出 graceful 子报表失败时其 artifact failed、其余 ready，业务仍 succeeded', async () => {
  const fixture = createFixture();
  try {
    await fixture.service.initialize();
    const outputPaths = ['main.xlsx', 'hit.xlsx', 'refund.xlsx']
      .map((name) => path.join(fixture.sourceDir, name));
    const task = (await fixture.service.beginTaskRun({
      taskRunId: 'bank-multi-output-task',
      taskKey: 'bank-statement:export',
      moduleId: 'bank-statement-process',
      parentRunId: 'bank-multi-output-parent',
      operationKey: 'bank-multi-output-operation'
    })).taskRun;
    const manifest = artifactManifestFromFilePlan(normalizeFilePlanV1({
      version: 1,
      allocation: 'eager',
      inputs: [],
      outputs: outputPaths.map((filePath) => ({
        filePath,
        role: 'output',
        sourceOperation: 'bank-statement:export'
      }))
    }));
    const reserved = await fixture.service.reserveFileTaskBatch({
      taskRun: task,
      manifest,
      moduleCode: 'FUNDRECON',
      moduleName: '银行对账单处理'
    });
    const batchContext = {
      batchId: reserved.batch.id,
      batchNumber: reserved.batch.batchNumber,
      taskRunId: task.taskRunId,
      taskKey: task.taskKey,
      moduleId: task.moduleId,
      parentRunId: task.parentRunId,
      operationKey: task.operationKey
    };
    await fixture.service.startFileTask(task.taskRunId, reserved.batch.id);
    fs.writeFileSync(outputPaths[0], 'main');
    fs.writeFileSync(outputPaths[2], 'refund');
    const settled = await fixture.service.settleManifestArtifacts({
      batchContext,
      files: manifest.outputs.map((item) => ({ artifactKey: item.artifactKey }))
    });
    assert.equal(settled.ok, false);
    assert.equal(settled.durable, true);
    const finished = await fixture.service.finishFileTask(task.taskRunId, reserved.batch.id, {
      taskStatus: 'succeeded',
      metadata: {}
    });
    assert.equal(finished.taskRun.status, 'succeeded');
    assert.equal(finished.batch.archiveStatus, 'incomplete');
    assert.deepEqual(
      fixture.repository.listArtifacts(reserved.batch.id).map((artifact) => artifact.status),
      ['ready', 'failed', 'ready']
    );
  } finally {
    fixture.close();
  }
});

test('stageFile/archiveFile 流式发布并按内容去重，最后引用删除才移除本体', async () => {
  const fixture = createFixture();
  try {
    const firstPath = writeSource(fixture, 'first.xlsx', 'same-content');
    const secondPath = writeSource(fixture, 'second.xlsx', 'same-content');

    const initialized = await fixture.service.initialize();
    assert.equal(initialized.ok, true);
    assert.equal(initialized.status, 'ready');

    const first = await fixture.service.stageFile({
      ...batchPayload('single-stage'),
      filePath: firstPath,
      role: 'source',
      sourceOperation: 'import'
    });
    assert.equal(first.ok, true);
    assert.equal(first.created, true);
    assert.equal(first.batch.archiveStatus, 'complete');
    const knownBlobPath = path.join(
      fixture.rootDir,
      ...blobRelativePath(first.sha256).split('/')
    );
    let knownBlobHashCalls = 0;
    const originalHash = fixture.service._hashFile.bind(fixture.service);
    fixture.service._hashFile = async (filePath) => {
      if (path.resolve(filePath) === path.resolve(knownBlobPath)) knownBlobHashCalls += 1;
      return originalHash(filePath);
    };
    const second = await fixture.service.archiveFile({
      ...batchPayload('single-archive'),
      filePath: secondPath,
      role: 'source',
      sourceOperation: 'import'
    });
    assert.equal(second.ok, true);
    assert.equal(second.deduplicated, true);
    assert.equal(first.sha256, second.sha256);
    assert.equal(knownBlobHashCalls, 1, 'known Blob dedupe 必须完整读取 SHA');
    assert.equal(
      sourceSnapshotMatchesStat(
        fixture.repository.getArtifact(second.artifact.id).blob.fingerprint,
        await fs.promises.lstat(knownBlobPath, { bigint: true })
      ),
      true,
      'dedupe completion 必须持久化完整 SHA 后的 final stable stat'
    );

    fs.writeFileSync(firstPath, 'changed-after-archive');
    const replayed = await fixture.service.stageFile({
      ...batchPayload('single-stage'),
      filePath: firstPath,
      role: 'source',
      sourceOperation: 'import'
    });
    assert.equal(replayed.ok, true);
    assert.equal(replayed.created, false);
    assert.equal(replayed.alreadyArchived, true);
    assert.equal(replayed.artifact.id, first.artifact.id);
    assert.equal(replayed.sha256, first.sha256);

    const blobPath = path.join(fixture.rootDir, ...blobRelativePath(first.sha256).split('/'));
    assert.equal(fs.readFileSync(blobPath, 'utf8'), 'same-content');
    assert.deepEqual(fs.readdirSync(path.join(fixture.rootDir, '.staging')), []);

    const stats = await fixture.service.getStats();
    assert.deepEqual(stats.stats, {
      batchCount: 2,
      lockedBatchCount: 0,
      logicalFileCount: 2,
      failedFileCount: 0,
      uniqueFileCount: 1,
      uniqueBytes: 12,
      logicalBytes: 24
    });
    const listed = await fixture.service.listBatches({ moduleId: 'bank-statement' });
    assert.equal(listed.ok, true);
    assert.deepEqual(
      new Set(listed.batches.map((batch) => batch.id)),
      new Set([first.batch.id, second.batch.id])
    );

    const firstDelete = await fixture.service.deleteBatch(first.batch.id);
    assert.equal(firstDelete.ok, true);
    assert.equal(firstDelete.releasedBlobCount, 0);
    assert.equal(fs.existsSync(blobPath), true);

    const secondDelete = await fixture.service.deleteBatch(second.batch.id);
    assert.equal(secondDelete.ok, true);
    assert.equal(secondDelete.releasedBlobCount, 1);
    assert.equal(fs.existsSync(blobPath), false);
  } finally {
    fixture.close();
  }
});

test('无 DB owner 的同 SHA canonical 文件阻断发布且不读不删，移除后任务可恢复', async () => {
  const content = 'unknown-canonical-content';
  const sha256 = crypto.createHash('sha256').update(content).digest('hex');
  let unknownPath = '';
  let unknownReadCount = 0;
  const guardedFs = {
    ...fs,
    createReadStream(filePath, options) {
      if (unknownPath && path.resolve(filePath) === path.resolve(unknownPath)) {
        unknownReadCount += 1;
        throw new Error('unknown canonical must not be opened');
      }
      return fs.createReadStream(filePath, options);
    }
  };
  const fixture = createFixture({ fsImpl: guardedFs });
  try {
    await fixture.service.initialize();
    unknownPath = path.join(fixture.rootDir, ...blobRelativePath(sha256).split('/'));
    fs.mkdirSync(path.dirname(unknownPath), { recursive: true });
    fs.writeFileSync(unknownPath, content);
    const sourcePath = writeSource(fixture, 'unknown-canonical.xlsx', content);

    const failed = await fixture.service.archiveFile({
      ...batchPayload('unknown-canonical-publish'),
      filePath: sourcePath,
      role: 'output'
    });

    assert.equal(failed.ok, false);
    assert.equal(failed.code, 'ARCHIVE_BLOB_UNKNOWN_CONFLICT');
    assert.equal(unknownReadCount, 0);
    assert.equal(fs.readFileSync(unknownPath, 'utf8'), content);
    assert.equal(fixture.repository.findBlobByHash(sha256), null);
    assert.equal(fixture.repository.getArtifact(failed.artifact.id).status, 'failed');

    fs.rmSync(unknownPath);
    unknownPath = '';
    const retried = await fixture.service.retryBatch(failed.batch.id);
    assert.equal(retried.ok, true);
    assert.equal(retried.succeeded, 1);
    assert.equal(fixture.repository.findBlobByHash(sha256).sha256, sha256);
  } finally {
    fixture.close();
  }
});

test('ready artifact 复用时本次 expected SHA/size 不一致必须显式冲突且保留旧 artifact', async () => {
  const fixture = createFixture();
  try {
    const sourcePath = writeSource(fixture, 'ready-expected-conflict.xlsx', 'version-A');
    const expectedASha256 = crypto.createHash('sha256').update('version-A').digest('hex');
    const archived = await fixture.service.archiveFile({
      ...batchPayload('ready-expected-conflict'),
      filePath: sourcePath,
      role: 'input',
      sourceOperation: 'vccFinancialOp:import:apply',
      expectedSha256: expectedASha256,
      expectedSizeBytes: Buffer.byteLength('version-A')
    });
    assert.equal(archived.ok, true);

    fs.writeFileSync(sourcePath, 'version-B');
    const expectedBSha256 = crypto.createHash('sha256').update('version-B').digest('hex');
    const conflict = await fixture.service.archiveFile({
      ...batchPayload('ready-expected-conflict'),
      filePath: sourcePath,
      role: 'input',
      sourceOperation: 'vccFinancialOp:import:apply',
      expectedSha256: expectedBSha256,
      expectedSizeBytes: Buffer.byteLength('version-B')
    });

    assert.equal(conflict.ok, false);
    assert.equal(conflict.code, 'ARCHIVE_READY_ARTIFACT_EXPECTATION_CONFLICT');
    assert.notEqual(conflict.alreadyArchived, true);
    const sizeConflict = await fixture.service.archiveFile({
      ...batchPayload('ready-expected-conflict'),
      filePath: sourcePath,
      role: 'input',
      sourceOperation: 'vccFinancialOp:import:apply',
      expectedSha256: expectedASha256,
      expectedSizeBytes: Buffer.byteLength('version-A') + 1
    });
    assert.equal(sizeConflict.ok, false);
    assert.equal(sizeConflict.code, 'ARCHIVE_READY_ARTIFACT_EXPECTATION_CONFLICT');
    const stored = fixture.service.repository.getArtifact(archived.artifact.id);
    assert.equal(stored.status, 'ready');
    assert.equal(stored.blob.sha256, expectedASha256);
    const blobPath = path.join(fixture.rootDir, ...blobRelativePath(expectedASha256).split('/'));
    assert.equal(fs.readFileSync(blobPath, 'utf8'), 'version-A');
  } finally {
    fixture.close();
  }
});

test('createBatch(files) 走原子 manifest，形成后拒绝 append 未登记 artifact', async () => {
  const fixture = createFixture();
  try {
    const inputPath = writeSource(fixture, 'batch-input.xlsx', 'input');
    const outputPath = writeSource(fixture, 'batch-output.xlsx', 'output');
    const extraPath = writeSource(fixture, 'batch-extra.xlsx', 'extra');
    const created = await fixture.service.createBatch({
      ...batchPayload('batch-sink'),
      sourceOperation: 'business:run',
      files: [
        { filePath: inputPath, role: 'input' },
        { filePath: outputPath, role: 'output', direction: 'output' }
      ]
    });

    assert.equal(created.ok, true);
    assert.equal(created.creationStatus, 'created');
    assert.equal(created.batchId, created.batch.id);
    assert.equal(created.attempted, 2);
    assert.equal(created.succeeded, 2);
    assert.equal(created.batch.archiveStatus, 'complete');
    assert.equal(created.batch.retentionUntil, '2026-09-18');
    assert.equal(created.batch.batchFormatVersion, 2);
    assert.equal(created.batch.taskStatus, 'succeeded');
    assert.equal(
      fixture.repository.getTaskRun(created.batch.taskRunId).status,
      'succeeded'
    );
    assert.equal(created.batch.metadata._fileManifest.artifactKeys.length, 2);

    const appended = await fixture.service.appendFiles({
      batchId: created.batchId,
      sourceOperation: 'business:export',
      files: [{ filePath: extraPath, role: 'output', direction: 'output' }]
    });
    assert.equal(appended.ok, false);
    assert.equal(appended.code, 'ARCHIVE_MANIFEST_ARTIFACT_UNKNOWN');
    assert.equal(fixture.repository.getBatch(created.batchId).artifactCount, 2);
  } finally {
    fixture.close();
  }
});

test('legacy createBatch(files) 空清单拒绝，首批 artifact 故障不出 ghost 且不消耗批次号', async () => {
  const fixture = createFixture();
  try {
    const empty = await fixture.service.createBatch({
      ...batchPayload('legacy-empty-files'),
      sourceOperation: 'business:run',
      files: []
    });
    assert.equal(empty.ok, false);
    assert.equal(empty.code, 'ARCHIVE_FILE_MANIFEST_EMPTY');
    const outputPath = writeSource(fixture, 'legacy-fault-output.xlsx', 'output');
    fixture.db.exec(`
      CREATE TRIGGER fail_legacy_manifest_output
      BEFORE INSERT ON archive_artifacts
      WHEN NEW.role = 'output'
      BEGIN
        SELECT RAISE(ABORT, 'legacy manifest artifact fault');
      END
    `);
    const failed = await fixture.service.archiveFile({
      ...batchPayload('legacy-reserve-fault'),
      sourceOperation: 'business:run',
      filePath: outputPath,
      role: 'output',
      direction: 'output'
    });
    assert.equal(failed.ok, false);
    assert.match(failed.message, /执行失败/);
    assert.equal(fixture.db.prepare('SELECT COUNT(*) count FROM archive_batches').get().count, 0);
    assert.equal(fixture.db.prepare('SELECT COUNT(*) count FROM archive_artifacts').get().count, 0);
    assert.equal(
      fixture.db.prepare('SELECT COUNT(*) count FROM archive_operation_issuances').get().count,
      0
    );
    assert.equal(fixture.db.prepare('SELECT COUNT(*) count FROM archive_daily_sequences').get().count, 0);

    fixture.db.exec('DROP TRIGGER fail_legacy_manifest_output');
    const created = await fixture.service.createBatch({
      ...batchPayload('legacy-after-reserve-fault'),
      sourceOperation: 'business:run',
      files: [{ filePath: outputPath, role: 'output', direction: 'output' }]
    });
    assert.equal(created.batch.dailySequence, 1);
    assert.match(created.batch.batchNumber, /-001$/);
  } finally {
    fixture.close();
  }
});

test('legacy createBatch(files) settle 失败耐久为 incomplete 并终结 Task Run', async () => {
  const fixture = createFixture();
  try {
    const missingOutput = path.join(fixture.sourceDir, 'legacy-missing-output.xlsx');
    const created = await fixture.service.createBatch({
      ...batchPayload('legacy-missing-output'),
      sourceOperation: 'business:run',
      files: [{ filePath: missingOutput, role: 'output', direction: 'output' }]
    });
    assert.equal(created.ok, false);
    assert.equal(created.failed, 1);
    assert.equal(created.results[0].code, 'ARCHIVE_OUTPUT_NOT_PRODUCED');
    assert.equal(created.results[0].metadataRecorded, true);
    assert.equal(created.batch.archiveStatus, 'incomplete');
    assert.equal(created.batch.taskStatus, 'succeeded');
    assert.equal(
      fixture.repository.getTaskRun(created.batch.taskRunId).status,
      'succeeded'
    );
  } finally {
    fixture.close();
  }
});

test('legacy outbox 的持久 sourceSnapshot 不会按当前文件静默重建基线', async () => {
  const fixture = createFixture();
  try {
    const sourcePath = writeSource(fixture, 'legacy-snapshot.xlsx', 'original');
    const sourceSnapshot = sourceSnapshotFromStat(fs.statSync(sourcePath));
    const expectedSha256 = crypto.createHash('sha256').update('original').digest('hex');
    fs.writeFileSync(sourcePath, 'replaced');

    const created = await fixture.service.createBatch({
      ...batchPayload('legacy-persisted-snapshot'),
      sourceOperation: 'business:run',
      files: [{
        filePath: sourcePath,
        role: 'input',
        sourceSnapshot,
        expectedSha256
      }]
    });

    assert.equal(created.ok, false);
    assert.equal(created.results[0].code, 'ARCHIVE_SOURCE_CHANGED');
    assert.equal(created.results[0].metadataRecorded, true);
    assert.equal(created.batch.archiveStatus, 'incomplete');
    assert.equal(created.batch.taskStatus, 'succeeded');
    const rawArtifact = fixture.repository.listArtifacts(created.batch.id)[0];
    assert.deepEqual(rawArtifact.metadata.sourceSnapshot, sourceSnapshot);
  } finally {
    fixture.close();
  }
});

test('默认启动只校验 Blob/layout 元数据，显式 verifyHashes 才流式读取全部内容', async () => {
  const fixture = createFixture();
  try {
    const sourcePath = writeSource(fixture, 'startup-hash.xlsx', 'startup-hash-content');
    const archived = await fixture.service.archiveFile({
      ...batchPayload('startup-hash'),
      filePath: sourcePath,
      role: 'output'
    });
    assert.equal(archived.ok, true);

    let readStreamCount = 0;
    const countingFs = {
      ...fs,
      promises: fs.promises,
      createReadStream(...args) {
        readStreamCount += 1;
        return fs.createReadStream(...args);
      }
    };
    const metadataOnly = createArchiveService({
      database: fixture.db,
      rootDir: fixture.rootDir,
      fsImpl: countingFs,
      verifyHashesOnStartup: false
    });
    const metadataResult = await metadataOnly.initialize();
    assert.equal(metadataResult.available, true);
    assert.equal(readStreamCount, 0);

    const fullVerify = createArchiveService({
      database: fixture.db,
      rootDir: fixture.rootDir,
      fsImpl: countingFs,
      verifyHashesOnStartup: true
    });
    const fullResult = await fullVerify.initialize();
    assert.equal(fullResult.available, true);
    assert.ok(readStreamCount >= 2, `canonical 与 layout 应执行哈希读取，实际 ${readStreamCount}`);
  } finally {
    fixture.close();
  }
});

test('5001 个缺失 v2 layout 也只占用首块共享预算并由同一后台队列耗尽', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-materialization-budget-'));
  const artifactIds = Array.from({ length: 5001 }, (_value, index) => index + 1);
  const remaining = new Set();
  const processed = [];
  const verified = [];
  const repository = {
    ensureSchema() {},
    replayFlowBindIntents() { return { replayed: 0, remaining: 0 }; },
    listCleanupJobs() { return []; },
    markInterruptedArtifacts() { return { artifactCount: 0 }; },
    repairDanglingArtifactReferences() { return { artifactCount: 0, releasedBlobs: [] }; },
    listBlobs() { return []; },
    listMaterializedArtifacts() { return []; },
    listMaterializedArtifactsPage(limit, afterArtifactId) {
      return artifactIds
        .filter((artifactId) => artifactId > afterArtifactId)
        .slice(0, limit)
        .map((id) => ({
          id,
          blob: { sha256: 'a'.repeat(64), sizeBytes: 1 },
          storageRelativePath: `2026/missing-${id}.xlsx`,
          storageMode: 'copy',
          storageLayoutVersion: 2,
          safeFileName: `missing-${id}.xlsx`,
          artifactOrder: id,
          materializationErrorCode: ''
        }));
    },
    countMaterializedArtifactsAfter(afterArtifactId) {
      return artifactIds.filter((artifactId) => artifactId > afterArtifactId).length;
    },
    recordMaterializationFailure(artifactId) { remaining.add(artifactId); },
    listMaterializationCandidates(limit, afterArtifactId) {
      return [...remaining]
        .filter((artifactId) => artifactId > afterArtifactId)
        .slice(0, limit)
        .map((id) => ({ id }));
    },
    countMaterializationCandidates() { return remaining.size; }
  };
  const service = new ArchiveService({
    repository,
    rootDir: path.join(tempDir, 'archive-root')
  });
  service.materializer.verifyMetadata = async (relativePath) => {
    verified.push(relativePath);
    return {
      valid: false,
      code: 'ARCHIVE_LAYOUT_MISSING'
    };
  };
  service._materializeArtifactUnlocked = async (artifactId) => {
    processed.push(artifactId);
    remaining.delete(artifactId);
    return { ok: true };
  };
  try {
    const initialized = await service.initialize({ startBackgroundMaterialization: false });
    assert.equal(initialized.available, true);
    assert.equal(verified.length, DEFAULT_STARTUP_MATERIALIZATION_BATCH_SIZE);
    assert.equal(processed.length, DEFAULT_STARTUP_MATERIALIZATION_BATCH_SIZE);
    assert.equal(
      initialized.consistency.materializationRemaining,
      5001 - DEFAULT_STARTUP_MATERIALIZATION_BATCH_SIZE
    );
    assert.equal(service.getMaterializationProgress().status, 'pending');

    await service.resumeBackgroundMaterialization();
    assert.equal(verified.length, 5001);
    assert.equal(processed.length, 5001);
    assert.deepEqual(processed, Array.from({ length: 5001 }, (_value, index) => index + 1));
    assert.deepEqual(service.getMaterializationProgress(), {
      status: 'complete',
      processed: 5001,
      succeeded: 5001,
      failed: 0,
      remaining: 0,
      cursor: 5001,
      lastErrorCode: ''
    });
  } finally {
    await service.pauseBackgroundMaterialization();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('5001 个 canonical Blob 的启动元数据校验只读取首块并由后台耗尽', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-blob-budget-'));
  const blobs = Array.from({ length: 5001 }, (_value, index) => {
    const id = index + 1;
    const sha256 = id.toString(16).padStart(64, '0');
    return {
      id,
      sha256,
      sizeBytes: 1,
      referenceCount: 1,
      relativePath: `blobs/sha256/${sha256.slice(0, 2)}/${sha256}`
    };
  });
  let blobLstatCount = 0;
  const countingPromises = new Proxy(fs.promises, {
    get(target, property, receiver) {
      if (property === 'lstat') {
        return async (filePath) => {
          if (String(filePath).includes(`${path.sep}blobs${path.sep}sha256${path.sep}`)
              && path.basename(String(filePath)).length === 64) {
            blobLstatCount += 1;
            return {
              isFile: () => true,
              isSymbolicLink: () => false,
              size: 1
            };
          }
          return fs.promises.lstat(filePath);
        };
      }
      return Reflect.get(target, property, receiver);
    }
  });
  const repository = {
    ensureSchema() {},
    replayFlowBindIntents() { return { replayed: 0, remaining: 0 }; },
    listCleanupJobs() { return []; },
    markInterruptedArtifacts() { return { artifactCount: 0 }; },
    repairDanglingArtifactReferences() { return { artifactCount: 0, releasedBlobs: [] }; },
    listBlobs() { return blobs; },
    listBlobsPage(limit, afterBlobId) {
      return blobs.filter((blob) => blob.id > afterBlobId).slice(0, limit);
    },
    countBlobsAfter(afterBlobId) {
      return blobs.filter((blob) => blob.id > afterBlobId).length;
    },
    listMaterializedArtifacts() { return []; },
    listMaterializedArtifactsPage() { return []; },
    countMaterializedArtifactsAfter() { return 0; },
    listMaterializationCandidates() { return []; },
    countMaterializationCandidates() { return 0; }
  };
  const service = new ArchiveService({
    repository,
    rootDir: path.join(tempDir, 'archive-root'),
    fsImpl: { ...fs, promises: countingPromises }
  });
  try {
    const initialized = await service.initialize({ startBackgroundMaterialization: false });
    assert.equal(initialized.available, true);
    assert.equal(blobLstatCount, DEFAULT_STARTUP_MATERIALIZATION_BATCH_SIZE);
    assert.equal(
      initialized.consistency.blobVerificationRemaining,
      5001 - DEFAULT_STARTUP_MATERIALIZATION_BATCH_SIZE
    );

    await service.resumeBackgroundMaterialization();
    assert.equal(blobLstatCount, 5001);
    assert.equal(service.blobVerificationRemaining, 0);
    assert.equal(service.getMaterializationProgress().status, 'complete');
  } finally {
    await service.pauseBackgroundMaterialization();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('后台尚未物化的尾部 artifact 仍以 canonical SHA/size 强校验并按需修复打开', async () => {
  const fixture = createFixture();
  try {
    const archived = [];
    for (let index = 0; index < 2; index += 1) {
      archived.push(await fixture.service.archiveFile({
        ...batchPayload(`startup-tail-${index}`),
        filePath: writeSource(fixture, `startup-tail-${index}.xlsx`, `tail-content-${index}`),
        role: 'output'
      }));
    }
    fixture.db.prepare(`
      UPDATE archive_artifacts
      SET storage_layout_version = 1,
          storage_relative_path = NULL,
          storage_mode = NULL,
          safe_file_name = NULL,
          artifact_order = NULL
    `).run();

    let readStreamCount = 0;
    const countingFs = {
      ...fs,
      promises: fs.promises,
      createReadStream(...args) {
        readStreamCount += 1;
        return fs.createReadStream(...args);
      }
    };
    const restarted = createArchiveService({
      database: fixture.db,
      rootDir: fixture.rootDir,
      fsImpl: countingFs,
      startupMaterializationBatchSize: 1
    });
    const initialized = await restarted.initialize({ startBackgroundMaterialization: false });
    assert.equal(initialized.consistency.materializationRemaining, 1);
    const readsBeforeOpen = readStreamCount;

    const opened = await restarted.openReadonlyCopy(archived[1].artifact.id);
    assert.equal(opened.ok, true, JSON.stringify(opened));
    assert.ok(readStreamCount > readsBeforeOpen, '按需打开必须重新读取并校验 canonical 内容');
    assert.equal(restarted.repository.getArtifact(archived[1].artifact.id).storageLayoutVersion, 2);
    assert.equal(restarted.repository.countMaterializationCandidates(), 0);
  } finally {
    fixture.close();
  }
});

test('后台块中断后重启从 DB 状态与 artifact_id cursor 重新耗尽且不跳项', async () => {
  const fixture = createFixture();
  let interrupted;
  try {
    const artifactIds = [];
    for (let index = 0; index < 5; index += 1) {
      const archived = await fixture.service.archiveFile({
        ...batchPayload(`startup-resume-${index}`),
        filePath: writeSource(fixture, `startup-resume-${index}.xlsx`, `resume-${index}`),
        role: 'output'
      });
      artifactIds.push(archived.artifact.id);
    }
    fixture.db.prepare(`
      UPDATE archive_artifacts
      SET storage_layout_version = 1,
          storage_relative_path = NULL,
          storage_mode = NULL,
          safe_file_name = NULL,
          artifact_order = NULL
    `).run();

    interrupted = createArchiveService({
      database: fixture.db,
      rootDir: fixture.rootDir,
      startupMaterializationBatchSize: 1
    });
    const first = await interrupted.initialize({ startBackgroundMaterialization: false });
    assert.equal(first.consistency.materializationProcessedCount, 1);

    let releaseChunk;
    let markChunkEntered;
    const chunkGate = new Promise((resolve) => { releaseChunk = resolve; });
    const chunkEntered = new Promise((resolve) => { markChunkEntered = resolve; });
    const originalMaterialize = interrupted._materializeArtifactUnlocked.bind(interrupted);
    interrupted._materializeArtifactUnlocked = async (artifactId) => {
      if (artifactId === artifactIds[1]) {
        markChunkEntered();
        await chunkGate;
      }
      return originalMaterialize(artifactId);
    };
    const background = interrupted.resumeBackgroundMaterialization();
    await chunkEntered;
    const stopped = interrupted.pauseBackgroundMaterialization();
    releaseChunk();
    await stopped;
    await background;
    assert.deepEqual(
      {
        status: interrupted.getMaterializationProgress().status,
        remaining: interrupted.getMaterializationProgress().remaining,
        cursor: interrupted.getMaterializationProgress().cursor
      },
      { status: 'paused', remaining: 3, cursor: artifactIds[1] }
    );
    assert.equal(fixture.service.repository.countMaterializationCandidates(), 3);

    const restarted = createArchiveService({
      database: fixture.db,
      rootDir: fixture.rootDir,
      startupMaterializationBatchSize: 2
    });
    const resumed = await restarted.initialize({ startBackgroundMaterialization: false });
    assert.equal(resumed.consistency.materializationProcessedCount, 0);
    assert.equal(resumed.consistency.materializationRemaining, 3);
    await restarted.resumeBackgroundMaterialization();
    assert.equal(restarted.repository.countMaterializationCandidates(), 0);
    assert.deepEqual(
      artifactIds.map((artifactId) => restarted.repository.getArtifact(artifactId).storageLayoutVersion),
      [2, 2, 2, 2, 2]
    );
  } finally {
    if (interrupted) await interrupted.pauseBackgroundMaterialization();
    fixture.close();
  }
});

test('v2 layout 缺失与 legacy 候选共享前台预算，显式强校验仍全量修复', async () => {
  const fixture = createFixture();
  try {
    const artifactIds = [];
    for (let index = 0; index < 3; index += 1) {
      const archived = await fixture.service.archiveFile({
        ...batchPayload(`v2-missing-${index}`),
        filePath: writeSource(fixture, `v2-missing-${index}.xlsx`, `v2-missing-${index}`),
        role: 'output'
      });
      artifactIds.push(archived.artifact.id);
    }
    fs.rmSync(path.join(fixture.rootDir, '2026'), { recursive: true, force: true });

    const restarted = createArchiveService({
      database: fixture.db,
      rootDir: fixture.rootDir,
      startupMaterializationBatchSize: 1
    });
    const initialized = await restarted.initialize({ startBackgroundMaterialization: false });
    assert.equal(initialized.available, true);
    assert.equal(initialized.consistency.materializationProcessedCount, 1);
    assert.equal(initialized.consistency.materializationRemaining, 2);
    assert.equal(
      restarted.repository.countMaterializationCandidates(),
      0,
      '前台未扫描的 v2 layout 不应先被写成 failure candidate'
    );

    const tail = await restarted.openReadonlyCopy(artifactIds[2]);
    assert.equal(tail.ok, true, JSON.stringify(tail));
    assert.equal(restarted.repository.getArtifact(artifactIds[2]).storageLayoutVersion, 2);
    assert.equal(restarted.getMaterializationProgress().remaining, 2);
    await restarted.resumeBackgroundMaterialization();
    assert.equal(restarted.repository.countMaterializationCandidates(), 0);

    fs.rmSync(path.join(fixture.rootDir, '2026'), { recursive: true, force: true });
    const fullVerify = createArchiveService({
      database: fixture.db,
      rootDir: fixture.rootDir,
      startupMaterializationBatchSize: 1,
      verifyHashesOnStartup: true
    });
    const verified = await fullVerify.initialize({ startBackgroundMaterialization: false });
    assert.equal(verified.available, true);
    assert.equal(verified.consistency.materializationProcessedCount, 3);
    assert.equal(verified.consistency.materializationRemaining, 0);
    assert.equal(fullVerify.repository.countMaterializationCandidates(), 0);
  } finally {
    fixture.close();
  }
});

test('task 批次服务保留预留幂等、状态更新、latest 与 parent 关联 DTO', async () => {
  const fixture = createFixture();
  try {
    const payload = {
      ...batchPayload('task-operation-1'),
      taskKey: 'statement:generate',
      taskRunId: 'task-run-1',
      parentRunId: 'parent-run-1'
    };
    const reserved = await fixture.service.reserveTaskBatch(payload);
    const replay = await fixture.service.reserveTaskBatch(payload);
    assert.equal(reserved.ok, true);
    assert.equal(reserved.status, 'reserved');
    assert.equal(reserved.batchNumber, '2026-07-20-001');
    assert.equal(reserved.taskStatus, 'reserved');
    assert.equal(reserved.batch.retentionUntil, '2026-09-18');
    assert.equal(replay.status, 'existing');
    assert.equal(replay.batchId, reserved.batchId);

    const running = await fixture.service.markTaskStarted(reserved.batchId);
    assert.equal(running.batch.taskStatus, 'running');
    const failed = await fixture.service.failTaskBatch(reserved.batchId, {
      code: 'BUSINESS_FAILED',
      message: '业务处理失败'
    });
    assert.equal(failed.batch.taskStatus, 'failed');
    assert.equal(failed.batch.failureCode, 'BUSINESS_FAILED');
    assert.equal(failed.batch.archiveStatus, 'complete');

    const firstSource = path.join(fixture.rootDir, 'first-visible.xlsx');
    fs.writeFileSync(firstSource, 'first');
    await fixture.service.appendFiles({
      batchId: reserved.batchId,
      files: [{ filePath: firstSource, role: 'input' }]
    });

    const latest = await fixture.service.getLatestBatch();
    assert.equal(latest.ok, true);
    assert.equal(latest.latestBatch.batchNumber, reserved.batchNumber);
    assert.equal(latest.latestBatch.taskStatus, 'failed');

    const relatedReserved = await fixture.service.reserveTaskBatch({
      ...batchPayload('task-operation-2'),
      taskKey: 'statement:export',
      taskRunId: 'task-run-2',
      parentRunId: 'parent-run-1'
    });
    const secondSource = path.join(fixture.rootDir, 'second-visible.xlsx');
    fs.writeFileSync(secondSource, 'second');
    await fixture.service.appendFiles({
      batchId: relatedReserved.batchId,
      files: [{ filePath: secondSource, role: 'input' }]
    });
    const related = await fixture.service.listRelatedBatches(reserved.batchId);
    assert.deepEqual(related.batches.map((batch) => batch.batchId), [
      reserved.batchId,
      relatedReserved.batchId
    ]);
    const detail = await fixture.service.getBatch(reserved.batchId);
    assert.deepEqual(detail.batch.relatedBatches, [
      {
        batchId: reserved.batchId,
        batchNumber: reserved.batchNumber,
        localDate: '2026-07-20',
        globalDailySequence: 1
      },
      {
        batchId: relatedReserved.batchId,
        batchNumber: relatedReserved.batchNumber,
        localDate: '2026-07-20',
        globalDailySequence: 2
      }
    ]);

    const anchorInput = {
      moduleId: 'bank-statement',
      identityType: 'business-run-id',
      identityValue: 'bank-statement-business-run-20260720-001',
      parentRunId: 'parent-run-1',
      sourceBatchId: reserved.batchId
    };
    const bound = await fixture.service.bindFlowAnchor(anchorInput);
    const anchorReplay = await fixture.service.bindFlowAnchor(anchorInput);
    const found = await fixture.service.findFlowAnchor(anchorInput);
    assert.equal(bound.status, 'bound');
    assert.equal(anchorReplay.status, 'existing');
    assert.deepEqual(found.anchor, bound.anchor);
    const crossModuleAnchor = await fixture.service.bindFlowAnchor({
      ...anchorInput,
      moduleId: 'toolbox'
    });
    assert.equal(crossModuleAnchor.ok, false);
    assert.equal(crossModuleAnchor.code, 'ARCHIVE_FLOW_ANCHOR_CONFLICT');
    const anchorConflict = await fixture.service.bindFlowAnchor({
      ...anchorInput,
      parentRunId: 'different-parent'
    });
    assert.equal(anchorConflict.ok, false);
    assert.equal(anchorConflict.code, 'ARCHIVE_FLOW_ANCHOR_CONFLICT');

    const forged = await fixture.service.reserveTaskBatch({
      ...payload,
      operationKey: 'task-operation-forged',
      batchNumber: '2026-07-20-999'
    });
    assert.equal(forged.ok, false);
    assert.equal(forged.code, 'ARCHIVE_OPERATION_FAILED');
    assert.equal(fixture.service.repository.getStats().batchCount, 2);

    const forgedDate = await fixture.service.reserveTaskBatch({
      ...payload,
      operationKey: 'task-operation-forged-date',
      localDate: '2099-01-01'
    });
    assert.equal(forgedDate.ok, false);
    assert.equal(forgedDate.code, 'ARCHIVE_OPERATION_FAILED');
    assert.equal(fixture.service.repository.getStats().batchCount, 2);
  } finally {
    fixture.close();
  }
});

test('task retentionUntil=undefined 按未提供处理，显式保留期与永久语义保持不变', async () => {
  const fixture = createFixture();
  try {
    const cases = [
      {
        name: 'undefined 使用默认值',
        input: { retentionUntil: undefined },
        expected: '2026-09-18'
      },
      {
        name: 'undefined 不覆盖 retentionDays',
        input: { retentionUntil: undefined, retentionDays: 30 },
        expected: '2026-08-19'
      },
      {
        name: '显式 null 永久保留',
        input: { retentionUntil: null },
        expected: null
      },
      {
        name: 'retentionDays permanent 永久保留',
        input: { retentionDays: 'permanent' },
        expected: null
      }
    ];
    for (const [index, scenario] of cases.entries()) {
      const reserved = await fixture.service.reserveTaskBatch({
        ...batchPayload(`task-retention-${index}`),
        taskKey: 'statement:generate',
        taskRunId: `task-retention-run-${index}`,
        ...scenario.input
      });
      assert.equal(reserved.ok, true, scenario.name);
      assert.equal(reserved.batch.retentionUntil, scenario.expected, scenario.name);
    }
  } finally {
    fixture.close();
  }
});

test('手工删除与 cleanupExpired 共用 active 授权，任务终结后原批次可清理', async () => {
  let currentTime = new Date(2026, 6, 1, 12, 0, 0);
  const fixture = createFixture({ now: () => currentTime });
  try {
    const reserved = await fixture.service.reserveTaskBatch({
      ...batchPayload('active-retention-task'),
      taskKey: 'statement:generate',
      taskRunId: 'active-retention-task-run',
      retentionUntil: '2026-07-10'
    });
    assert.equal(reserved.ok, true);

    const manualDelete = await fixture.service.deleteBatch(reserved.batchId, { force: true });
    assert.equal(manualDelete.ok, false);
    assert.equal(manualDelete.status, 'active');
    assert.equal(manualDelete.code, 'ARCHIVE_BATCH_ACTIVE');

    currentTime = new Date(2026, 6, 20, 12, 0, 0);
    const activeCleanup = await fixture.service.cleanupExpired({ asOfLocalDate: '2026-07-20' });
    assert.equal(activeCleanup.ok, false);
    assert.equal(activeCleanup.status, 'partial');
    assert.equal(activeCleanup.candidateCount, 1);
    assert.equal(activeCleanup.deletedBatchCount, 0);
    assert.equal(activeCleanup.results[0].code, 'ARCHIVE_BATCH_ACTIVE');
    assert.equal(fixture.repository.getBatch(reserved.batchId).id, reserved.batchId);

    const completed = await fixture.service.completeTaskBatch(reserved.batchId);
    assert.equal(completed.batch.id, reserved.batchId);
    assert.equal(completed.batch.taskStatus, 'succeeded');
    const terminalCleanup = await fixture.service.cleanupExpired({ asOfLocalDate: '2026-07-20' });
    assert.equal(terminalCleanup.ok, true);
    assert.equal(terminalCleanup.deletedBatchCount, 1);
    assert.equal((await fixture.service.getBatch(reserved.batchId)).status, 'not-found');
    const replay = await fixture.service.reserveTaskBatch({
      ...batchPayload('active-retention-task'),
      taskKey: 'statement:generate',
      taskRunId: 'active-retention-task-run'
    });
    assert.equal(replay.ok, false);
    assert.equal(replay.status, 'deleted');
    assert.equal(replay.code, 'ARCHIVE_OPERATION_DELETED');
    assert.equal(replay.batchId, reserved.batchId);
  } finally {
    fixture.close();
  }
});

test('Recovery overlay active 阻断手工/retention 删除，resolved 显式删 overlay 且保留事件与 owner', async () => {
  let currentTime = new Date(2026, 6, 1, 12, 0, 0);
  const fixture = createFixture({ now: () => currentTime });
  try {
    const operationKey = 'recovery-overlay-retention-operation';
    const taskRunId = 'recovery-overlay-retention-task';
    const begun = await fixture.service.beginTaskRun({
      taskRunId,
      taskKey: 'monthly-balance:export',
      moduleId: 'bank-statement',
      parentRunId: 'recovery-overlay-retention-parent',
      operationKey
    });
    assert.equal(begun.ok, true);
    const reserved = await fixture.service.reserveTaskBatch({
      ...batchPayload(operationKey),
      taskKey: 'monthly-balance:export',
      taskRunId,
      retentionUntil: '2026-07-10'
    });
    assert.equal(reserved.ok, true);

    const ownerRepository = createRecoveryRequestOwnerRepository(fixture.db);
    const controlRepository = createRecoveryControlRepository(fixture.db);
    const baseTransition = {
      entityKind: 'batch-overlay',
      actionKey: 'statement:generate-all',
      expectedTaskKey: 'monthly-balance:export',
      operationKey,
      batchId: reserved.batchId,
      taskRunId,
      sourceKind: 'module-recovery',
      sourceRef: 'archive-delete-retention'
    };
    const applyTransition = (transition, safePayload) => {
      const request = ownerRepository.reserveTransitionRequest({
        requestKey: transitionRequestKey(transition),
        transition,
        safePayload
      });
      return controlRepository.runInControlTransaction(
        (transaction) => transaction.transitionWithRecoveryEvent(request)
      );
    };
    applyTransition({
      ...baseTransition,
      command: 'mark-interrupted',
      expectedState: null,
      failureCode: 'TRANSPORT_LOST',
      failureMessage: 'batch transport lost'
    }, { phase: 'interrupted' });

    const manualDelete = await fixture.service.deleteBatch(reserved.batchId, { force: true });
    assert.equal(manualDelete.ok, false);
    assert.equal(manualDelete.status, 'recovery-active');
    assert.equal(manualDelete.code, 'ARCHIVE_BATCH_RECOVERY_ACTIVE');
    assert.deepEqual(manualDelete.recoveryState, {
      state: 'interrupted',
      finalOutcome: null,
      recoveryAttemptId: null,
      sourceKind: 'module-recovery',
      sourceRef: 'archive-delete-retention',
      updatedAt: manualDelete.recoveryState.updatedAt,
      resolvedAt: null
    });

    currentTime = new Date(2026, 6, 20, 12, 0, 0);
    const activeCleanup = await fixture.service.cleanupExpired({ asOfLocalDate: '2026-07-20' });
    assert.equal(activeCleanup.ok, false);
    assert.equal(activeCleanup.status, 'partial');
    assert.equal(activeCleanup.candidateCount, 1);
    assert.equal(activeCleanup.deletedBatchCount, 0);
    assert.equal(activeCleanup.results[0].code, 'ARCHIVE_BATCH_RECOVERY_ACTIVE');
    assert.equal(fixture.repository.getBatch(reserved.batchId).id, reserved.batchId);

    const recoveryAttemptId = 'archive-delete-attempt-1';
    applyTransition({
      ...baseTransition,
      command: 'begin-recovery',
      expectedState: 'interrupted',
      recoveryAttemptId
    }, { phase: 'begin-recovery' });
    applyTransition({
      ...baseTransition,
      command: 'resolve-success',
      expectedState: 'recovering',
      recoveryAttemptId,
      finalOutcome: 'succeeded'
    }, { phase: 'resolved' });

    const terminalCleanup = await fixture.service.cleanupExpired({ asOfLocalDate: '2026-07-20' });
    assert.equal(terminalCleanup.ok, true);
    assert.equal(terminalCleanup.deletedBatchCount, 1);
    assert.equal(fixture.repository.getBatch(reserved.batchId), null);
    assert.equal(fixture.db.prepare(`
      SELECT COUNT(*) AS count
      FROM background_execution_batch_recovery_states
      WHERE batch_id = ?
    `).get(reserved.batchId).count, 0);
    assert.equal(fixture.db.prepare(`
      SELECT COUNT(*) AS count
      FROM background_execution_recovery_events
      WHERE batch_id = ?
    `).get(reserved.batchId).count, 3);
    assert.equal(fixture.db.prepare(`
      SELECT COUNT(*) AS count
      FROM background_execution_recovery_request_owners
      WHERE status = 'committed'
    `).get().count, 3);
    assert.deepEqual(fixture.db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    fixture.close();
  }
});

test('批量复制开始前先登记整批文件，进程中断后不会丢失后续重试线索', async () => {
  const fixture = createFixture();
  try {
    const sourcePaths = [
      writeSource(fixture, 'first.xlsx', 'first'),
      writeSource(fixture, 'second.xlsx', 'second'),
      writeSource(fixture, 'third.xlsx', 'third')
    ];
    let registeredBeforeFirstRead = 0;
    let firstRead = true;
    fixture.service.fs = {
      ...fs,
      createReadStream(filePath, options) {
        if (firstRead) {
          firstRead = false;
          const [batch] = fixture.service.repository.listBatches({ limit: 10 });
          registeredBeforeFirstRead = fixture.service.repository.listArtifacts(batch.id).length;
        }
        return fs.createReadStream(filePath, options);
      }
    };

    const created = await fixture.service.createBatch({
      ...batchPayload('register-before-copy'),
      sourceOperation: 'business:run',
      files: sourcePaths.map((filePath) => ({ filePath, role: 'input' }))
    });

    assert.equal(created.ok, true);
    assert.equal(registeredBeforeFirstRead, 3);
    assert.equal(created.batch.artifactCount, 3);
  } finally {
    fixture.close();
  }
});

test('存档失败以明确结果返回且不泄露绝对路径，修复源文件后可按批次重试', async () => {
  const fixture = createFixture();
  try {
    const missingPath = path.join(fixture.sourceDir, 'private-customer-source.xlsx');
    const created = { batch: createLegacyEmptyBatch(fixture, 'retry-batch') };

    let failure;
    await assert.doesNotReject(async () => {
      failure = await fixture.service.attachFile(created.batch.id, {
        filePath: missingPath,
        role: 'source',
        sourceOperation: 'import'
      });
    });
    assert.equal(failure.ok, false);
    assert.equal(failure.status, 'failed');
    assert.equal(failure.metadataRecorded, true);
    assert.equal(failure.code, 'ARCHIVE_ENOENT');
    assert.equal(JSON.stringify(failure).includes(fixture.tempDir), false);

    const failedBatch = await fixture.service.getBatch(created.batch.id);
    assert.equal(failedBatch.batch.archiveStatus, 'incomplete');
    assert.equal(failedBatch.batch.failureCount, 1);
    assert.equal(failedBatch.batch.artifacts[0].status, 'failed');
    assert.equal('sourcePath' in failedBatch.batch.artifacts[0], false);

    fs.writeFileSync(missingPath, 'available-on-retry');
    const retried = await fixture.service.retryBatch(created.batch.id);
    assert.equal(retried.ok, true);
    assert.equal(retried.attempted, 1);
    assert.equal(retried.succeeded, 1);
    assert.equal(retried.batch.archiveStatus, 'complete');
    assert.equal(retried.batch.retryCount, 1);

    const detail = await fixture.service.getBatch(created.batch.id);
    assert.equal(detail.batch.artifacts[0].attemptCount, 2);
    assert.equal(detail.batch.artifacts[0].status, 'ready');
    assert.equal('relativePath' in detail.batch.artifacts[0].blob, false);

    const marked = await fixture.service.markBatchStatus(created.batch.id, 'business-complete');
    assert.equal(marked.ok, true);
    assert.equal(marked.batch.businessStatus, 'business-complete');
    const recorded = await fixture.service.recordFailure(created.batch.id, {
      code: 'SOURCE_NOTICE',
      message: '上游补充告警',
      sourceOperation: 'business-operation'
    });
    assert.equal(recorded.ok, true);
    assert.equal(recorded.batch.failureCount, 2);
  } finally {
    fixture.close();
  }
});

test('源文件仅在存档成功或批次删除后释放，失败重试期间保持可用', async () => {
  const releasedPaths = [];
  const fixture = createFixture({
    onSourceReleased: (paths) => releasedPaths.push(...paths)
  });
  try {
    const retryPath = path.join(fixture.sourceDir, 'position-retry.xlsx');
    const retryBatch = { batch: createLegacyEmptyBatch(fixture, 'position-retry-source') };
    const failed = await fixture.service.attachFile(retryBatch.batch.id, {
      filePath: retryPath,
      role: 'input',
      sourceOperation: 'position-import'
    });
    assert.equal(failed.ok, false);
    assert.deepEqual(releasedPaths, []);

    fs.writeFileSync(retryPath, 'retry-source');
    const retried = await fixture.service.retryBatch(retryBatch.batch.id);
    assert.equal(retried.ok, true);
    assert.deepEqual(releasedPaths, [retryPath]);

    const deletePath = path.join(fixture.sourceDir, 'position-delete.xlsx');
    const deleteBatch = { batch: createLegacyEmptyBatch(fixture, 'position-delete-source') };
    const deleteFailure = await fixture.service.attachFile(deleteBatch.batch.id, {
      filePath: deletePath,
      role: 'input',
      sourceOperation: 'position-import'
    });
    assert.equal(deleteFailure.ok, false);
    assert.deepEqual(releasedPaths, [retryPath]);

    const deleted = await fixture.service.deleteBatch(deleteBatch.batch.id);
    assert.equal(deleted.metadataDeleted, true);
    assert.deepEqual(releasedPaths, [retryPath, deletePath]);
  } finally {
    fixture.close();
  }
});

test('同一源文件仍被其它未完成 artifact 引用时不得提前释放', async () => {
  const releasedPaths = [];
  const fixture = createFixture({
    onSourceReleased: (paths) => releasedPaths.push(...paths)
  });
  try {
    const sharedRetryPath = path.join(fixture.sourceDir, 'position-shared-retry.xlsx');
    const failedBatch = { batch: createLegacyEmptyBatch(fixture, 'position-shared-failed') };
    const failed = await fixture.service.attachFile(failedBatch.batch.id, {
      filePath: sharedRetryPath,
      role: 'input',
      sourceOperation: 'position-import'
    });
    assert.equal(failed.ok, false);

    fs.writeFileSync(sharedRetryPath, 'shared-retry-source');
    const completedBatch = { batch: createLegacyEmptyBatch(fixture, 'position-shared-complete') };
    const completed = await fixture.service.attachFile(completedBatch.batch.id, {
      filePath: sharedRetryPath,
      role: 'input',
      sourceOperation: 'position-import'
    });
    assert.equal(completed.ok, true);
    assert.deepEqual(releasedPaths, []);

    const replacementPath = writeSource(fixture, 'position-shared-replacement.xlsx', 'replacement-source');
    const retried = await fixture.service.retryBatch(failedBatch.batch.id, {
      sourcePaths: {
        [failed.artifact.id]: replacementPath
      }
    });
    assert.equal(retried.ok, true);
    assert.deepEqual(releasedPaths, [sharedRetryPath, replacementPath]);

    const sharedDeletePath = path.join(fixture.sourceDir, 'position-shared-delete.xlsx');
    const firstDeleteBatch = {
      batch: createLegacyEmptyBatch(fixture, 'position-shared-delete-first')
    };
    const secondDeleteBatch = {
      batch: createLegacyEmptyBatch(fixture, 'position-shared-delete-second')
    };
    const firstDeleteFailure = await fixture.service.attachFile(firstDeleteBatch.batch.id, {
      filePath: sharedDeletePath,
      role: 'input',
      sourceOperation: 'position-import'
    });
    const secondDeleteFailure = await fixture.service.attachFile(secondDeleteBatch.batch.id, {
      filePath: sharedDeletePath,
      role: 'input',
      sourceOperation: 'position-import'
    });
    assert.equal(firstDeleteFailure.ok, false);
    assert.equal(secondDeleteFailure.ok, false);

    await fixture.service.deleteBatch(firstDeleteBatch.batch.id);
    assert.deepEqual(releasedPaths, [sharedRetryPath, replacementPath]);

    await fixture.service.deleteBatch(secondDeleteBatch.batch.id);
    assert.deepEqual(releasedPaths, [sharedRetryPath, replacementPath, sharedDeletePath]);
  } finally {
    fixture.close();
  }
});

test('源释放回调失败不把已完成存档回滚为失败', async () => {
  const fixture = createFixture({
    onSourceReleased: () => {
      throw new Error('injected release failure');
    }
  });
  try {
    const sourcePath = writeSource(fixture, 'release-failure.xlsx', 'archived');
    const archived = await fixture.service.archiveFile({
      ...batchPayload('release-callback-failure'),
      filePath: sourcePath,
      role: 'input'
    });
    assert.equal(archived.ok, true);
    assert.equal(archived.status, 'ready');
  } finally {
    fixture.close();
  }
});

test('业务完成后源文件发生变化时拒绝错存，并保留明确失败审计', async () => {
  const fixture = createFixture();
  try {
    const sourcePath = writeSource(fixture, 'changed-after-success.xlsx', 'business-result-v1');
    const sourceSnapshot = sourceSnapshotFromStat(fs.statSync(sourcePath));
    fs.writeFileSync(sourcePath, 'business-result-v2-changed');

    const result = await fixture.service.archiveFile({
      ...batchPayload('source-changed'),
      filePath: sourcePath,
      role: 'output',
      sourceSnapshot
    });

    assert.equal(result.ok, false);
    assert.equal(result.status, 'failed');
    assert.equal(result.code, 'ARCHIVE_SOURCE_CHANGED');
    assert.equal(result.retryable, true);
    assert.match(result.message, /业务完成后发生变化/);
    assert.equal(JSON.stringify(result).includes(fixture.tempDir), false);

    const detail = await fixture.service.getBatch(result.batch.id);
    assert.equal(detail.batch.archiveStatus, 'incomplete');
    assert.equal(detail.batch.artifacts[0].lastErrorCode, 'ARCHIVE_SOURCE_CHANGED');
    assert.equal('sourceSnapshot' in detail.batch.artifacts[0].metadata, false);
  } finally {
    fixture.close();
  }
});

test('源 stat 与当前文件一致但 SHA 不等于业务解析摘要时仍拒绝存档', async () => {
  const fixture = createFixture();
  try {
    const sourcePath = writeSource(fixture, 'same-stat-different-bytes.xlsx', 'version-A-contents');
    const expectedSha256 = crypto
      .createHash('sha256')
      .update('version-A-contents')
      .digest('hex');
    fs.writeFileSync(sourcePath, 'version-B-contents');
    const currentSnapshot = sourceSnapshotFromStat(fs.statSync(sourcePath));

    const rejected = await fixture.service.archiveFile({
      ...batchPayload('source-sha-mismatch'),
      filePath: sourcePath,
      role: 'input',
      sourceSnapshot: currentSnapshot,
      expectedSha256
    });

    assert.equal(rejected.ok, false);
    assert.equal(rejected.code, 'ARCHIVE_SOURCE_CHANGED');
    assert.equal(rejected.retryable, true);
    assert.match(rejected.message, /业务解析时版本不一致/);
    const detail = await fixture.service.getBatch(rejected.batch.id);
    assert.equal('expectedSha256' in detail.batch.artifacts[0].metadata, false);

    const validPath = writeSource(fixture, 'matching-sha.xlsx', 'matching-contents');
    const valid = await fixture.service.archiveFile({
      ...batchPayload('source-sha-match'),
      filePath: validPath,
      role: 'input',
      sourceSnapshot: sourceSnapshotFromStat(fs.statSync(validPath)),
      expectedSha256: crypto.createHash('sha256').update('matching-contents').digest('hex')
    });
    assert.equal(valid.ok, true);
  } finally {
    fixture.close();
  }
});

test('有业务 SHA 时，同字节文件即使 inode/ctime/mtime 变化仍可按原路径重试', async () => {
  const fixture = createFixture();
  try {
    const sourcePath = writeSource(fixture, 'same-bytes-new-stat.xlsx', 'same-business-bytes');
    const originalSnapshot = sourceSnapshotFromStat(fs.statSync(sourcePath));
    const expectedSha256 = crypto.createHash('sha256').update('same-business-bytes').digest('hex');
    const expectedSizeBytes = Buffer.byteLength('same-business-bytes');
    fs.rmSync(sourcePath);

    const failed = await fixture.service.archiveFile({
      ...batchPayload('same-bytes-new-stat'),
      filePath: sourcePath,
      role: 'input',
      sourceSnapshot: originalSnapshot,
      expectedSha256,
      expectedSizeBytes
    });
    assert.equal(failed.ok, false);
    fs.writeFileSync(sourcePath, 'same-business-bytes');
    assert.equal(sourceSnapshotMatchesStat(originalSnapshot, fs.statSync(sourcePath)), false);

    const retried = await fixture.service.retryBatch(failed.batch.id);
    assert.equal(retried.ok, true);
    assert.equal(retried.succeeded, 1);
    const internal = fixture.service.repository.getArtifact(failed.artifact.id);
    assert.equal(internal.metadata.expectedSizeBytes, expectedSizeBytes);
    const detail = await fixture.service.getBatch(failed.batch.id);
    assert.equal('expectedSizeBytes' in detail.batch.artifacts[0].metadata, false);
  } finally {
    fixture.close();
  }
});

test('有业务 SHA 时允许同字节替代路径，仍拒绝同长度不同字节', async () => {
  const fixture = createFixture();
  try {
    const originalPath = writeSource(fixture, 'original-for-override.xlsx', 'expected-version');
    const originalSnapshot = sourceSnapshotFromStat(fs.statSync(originalPath));
    const expectedSha256 = crypto.createHash('sha256').update('expected-version').digest('hex');
    const expectedSizeBytes = Buffer.byteLength('expected-version');
    fs.rmSync(originalPath);

    const failed = await fixture.service.archiveFile({
      ...batchPayload('replacement-path-same-sha'),
      filePath: originalPath,
      role: 'input',
      sourceSnapshot: originalSnapshot,
      expectedSha256,
      expectedSizeBytes
    });
    const wrongPath = writeSource(fixture, 'wrong-same-size.xlsx', 'different-bytes!');
    assert.equal(Buffer.byteLength('different-bytes!'), expectedSizeBytes);
    const rejected = await fixture.service.retryBatch(failed.batch.id, {
      sourcePaths: { [failed.artifact.id]: wrongPath }
    });
    assert.equal(rejected.ok, false);
    assert.equal(rejected.results[0].code, 'ARCHIVE_SOURCE_CHANGED');

    const replacementPath = writeSource(fixture, 'replacement.xlsx', 'expected-version');
    const recovered = await fixture.service.retryBatch(failed.batch.id, {
      sourcePaths: { [failed.artifact.id]: replacementPath }
    });
    assert.equal(recovered.ok, true);
    assert.equal(recovered.succeeded, 1);
  } finally {
    fixture.close();
  }
});

test('有业务 SHA 时仍拒绝存档读取期间发生变化且不留下 part 或 blob', async () => {
  let sourcePath = '';
  let mutated = false;
  const changingFs = {
    ...fs,
    createReadStream(filePath, options) {
      const stream = fs.createReadStream(filePath, options);
      if (path.resolve(filePath) === sourcePath) {
        stream.once('data', () => {
          if (mutated) return;
          mutated = true;
          fs.writeFileSync(filePath, 'changed-during-read');
        });
      }
      return stream;
    }
  };
  const fixture = createFixture({ fsImpl: changingFs });
  try {
    sourcePath = writeSource(fixture, 'changes-during-read.xlsx', 'original-read-bytes');
    const expectedSha256 = crypto.createHash('sha256').update('original-read-bytes').digest('hex');
    const result = await fixture.service.archiveFile({
      ...batchPayload('source-changes-during-read'),
      filePath: sourcePath,
      role: 'input',
      sourceSnapshot: sourceSnapshotFromStat(fs.statSync(sourcePath)),
      expectedSha256,
      expectedSizeBytes: Buffer.byteLength('original-read-bytes')
    });

    assert.equal(result.ok, false);
    assert.equal(result.code, 'ARCHIVE_SOURCE_CHANGED');
    assert.deepEqual(fs.readdirSync(path.join(fixture.rootDir, '.staging')), []);
    const blobFiles = fs.readdirSync(path.join(fixture.rootDir, 'blobs', 'sha256'), {
      recursive: true
    }).filter((entry) => /^[a-f0-9]{64}$/.test(entry));
    assert.deepEqual(blobFiles, []);
  } finally {
    fixture.close();
  }
});

test('known Blob dedupe 完整 SHA 读取期间变化时不提交新的 artifact 引用', async () => {
  const fixture = createFixture();
  try {
    const content = 'known-dedupe-stable-content';
    const first = await fixture.service.archiveFile({
      ...batchPayload('known-dedupe-first'),
      filePath: writeSource(fixture, 'known-first.xlsx', content),
      role: 'output'
    });
    assert.equal(first.ok, true);
    const blobPath = path.join(fixture.rootDir, ...blobRelativePath(first.sha256).split('/'));
    const originalHash = fixture.service._hashFile.bind(fixture.service);
    fixture.service._hashFile = async (filePath) => {
      const result = await originalHash(filePath);
      if (path.resolve(filePath) === path.resolve(blobPath)) {
        const changed = new Date(Date.now() + 120_000);
        fs.utimesSync(filePath, changed, changed);
      }
      return result;
    };

    const second = await fixture.service.archiveFile({
      ...batchPayload('known-dedupe-second'),
      filePath: writeSource(fixture, 'known-second.xlsx', content),
      role: 'output'
    });

    assert.equal(second.ok, false);
    assert.equal(second.code, 'ARCHIVE_BLOB_CHANGED_DURING_READ');
    assert.equal(fixture.repository.findBlobByHash(first.sha256).referenceCount, 1);
    assert.equal(fixture.repository.getArtifact(second.artifact.id).status, 'failed');
  } finally {
    fixture.close();
  }
});

test('cleanupExpired 按本地日清理，保留日当天不删且锁定批次跳过', async () => {
  let currentTime = new Date(2026, 6, 1, 12, 0, 0);
  const fixture = createFixture({ now: () => currentTime });
  try {
    const sourcePath = writeSource(fixture, 'retention.xlsx', 'retention-content');
    const expired = await fixture.service.archiveFile({
      ...batchPayload('expired', {
        retentionDays: 18
      }),
      filePath: sourcePath,
      role: 'output'
    });
    const boundary = await fixture.service.archiveFile({
      ...batchPayload('boundary', {
        retentionDays: 19
      }),
      filePath: sourcePath,
      role: 'output'
    });
    const locked = await fixture.service.archiveFile({
      ...batchPayload('locked', {
        retentionDays: 9,
        locked: true
      }),
      filePath: sourcePath,
      role: 'output'
    });

    currentTime = new Date(2026, 6, 20, 12, 0, 0);
    const cleanup = await fixture.service.cleanupExpired({ asOfLocalDate: '2026-07-20' });
    assert.equal(cleanup.ok, true);
    assert.equal(cleanup.candidateCount, 1);
    assert.equal(cleanup.deletedBatchCount, 1);
    assert.equal((await fixture.service.getBatch(expired.batch.id)).status, 'not-found');
    assert.equal((await fixture.service.getBatch(boundary.batch.id)).ok, true);
    assert.equal((await fixture.service.getBatch(locked.batch.id)).ok, true);

    const lockedDelete = await fixture.service.deleteBatch(locked.batch.id);
    assert.equal(lockedDelete.ok, false);
    assert.equal(lockedDelete.code, 'ARCHIVE_BATCH_LOCKED');
    const unlocked = await fixture.service.setLocked(locked.batch.id, false);
    assert.equal(unlocked.status, 'unlocked');
    const secondCleanup = await fixture.service.cleanupExpired({ asOfLocalDate: '2026-07-20' });
    assert.equal(secondCleanup.deletedBatchCount, 1);
  } finally {
    fixture.close();
  }
});

test('业务引用锁在 Service 与公开 DTO 中不可被解锁、强制删除或 retention 绕过', async () => {
  const fixture = createFixture();
  try {
    const sourcePath = writeSource(fixture, 'vcc-held.xlsx', 'held-vcc-input');
    const archived = await fixture.service.archiveFile({
      ...batchPayload('vcc-business-hold-service', {
        moduleId: 'vcc-financial-op',
        moduleCode: 'VCCFINOP',
        moduleName: 'VCC财务OP校验',
        localDate: '2026-07-01',
        retentionUntil: '2026-07-10'
      }),
      filePath: sourcePath,
      role: 'input',
      sourceOperation: 'vccFinancialOp:import:apply'
    });
    fixture.service.repository.addArtifactHold(archived.artifact.id, {
      ownerModule: 'vcc-financial-op',
      ownerType: 'vcc-import-source',
      ownerId: '17',
      reason: '当前有效数据仍引用该输入原表'
    });

    const listed = await fixture.service.listBatches({ moduleId: 'vcc-financial-op' });
    assert.equal(listed.batches[0].businessLocked, true);
    const detail = await fixture.service.getBatch(archived.batch.id);
    assert.equal(detail.batch.businessLocked, true);
    assert.equal(detail.batch.artifacts[0].businessLocked, true);

    const unlocked = await fixture.service.setLocked(archived.batch.id, false);
    assert.equal(unlocked.status, 'unlocked');
    const deleted = await fixture.service.deleteBatch(archived.batch.id, { force: true });
    assert.equal(deleted.ok, false);
    assert.equal(deleted.code, 'ARCHIVE_BATCH_BUSINESS_HELD');
    assert.deepEqual(deleted.artifactIds, [archived.artifact.id]);
    const cleanup = await fixture.service.cleanupExpired({ asOfLocalDate: '2026-07-20' });
    assert.equal(cleanup.candidateCount, 0);
    assert.equal((await fixture.service.getBatch(archived.batch.id)).ok, true);
  } finally {
    fixture.close();
  }
});

test('后台筛查保留无 durable owner 的 staging/只读副本和 SHA 形状孤儿，仅收口 DB 已知缺失 Blob', async () => {
  const fixture = createFixture();
  try {
    const sourcePath = writeSource(fixture, 'startup.xlsx', 'startup-content');
    const archived = await fixture.service.archiveFile({
      ...batchPayload('startup-consistency'),
      filePath: sourcePath,
      role: 'source'
    });
    assert.equal(archived.ok, true);

    const managedBlob = path.join(
      fixture.rootDir,
      ...blobRelativePath(archived.sha256).split('/')
    );
    fs.rmSync(managedBlob);
    fs.writeFileSync(path.join(fixture.rootDir, '.staging', 'stale.part'), 'partial');
    const readonlyStaleDir = path.join(fixture.rootDir, '.readonly', 'stale');
    fs.mkdirSync(readonlyStaleDir, { recursive: true });
    fs.writeFileSync(path.join(readonlyStaleDir, 'copy.xlsx'), 'copy');

    const orphanContent = 'orphan-content';
    const orphanHash = crypto.createHash('sha256').update(orphanContent).digest('hex');
    const orphanPath = path.join(fixture.rootDir, ...blobRelativePath(orphanHash).split('/'));
    fs.mkdirSync(path.dirname(orphanPath), { recursive: true });
    fs.writeFileSync(orphanPath, orphanContent);

    const restarted = createArchiveService({
      database: fixture.db,
      rootDir: fixture.rootDir,
      now: () => new Date(2026, 6, 20, 12, 5, 0)
    });
    const initialized = await restarted.initialize({ deferStartupRecovery: true });
    const reconciled = await restarted.reconcileStartup();

    assert.equal(initialized.available, true);
    assert.equal(reconciled.consistency.removedStagingEntries, 0);
    assert.equal(reconciled.consistency.removedReadonlyEntries, 0);
    assert.equal(reconciled.consistency.invalidBlobCount, 1);
    assert.equal(reconciled.consistency.removedOrphanBlobFiles, 0);
    assert.equal(fs.existsSync(path.join(fixture.rootDir, '.staging', 'stale.part')), true);
    assert.equal(fs.existsSync(path.join(readonlyStaleDir, 'copy.xlsx')), true);
    assert.equal(fs.existsSync(orphanPath), true);

    const repaired = await restarted.getBatch(archived.batch.id);
    assert.equal(repaired.batch.archiveStatus, 'incomplete');
    assert.equal(repaired.batch.artifacts[0].status, 'failed');
    assert.equal(repaired.batch.artifacts[0].lastErrorCode, 'ARCHIVE_BLOB_MISSING');
  } finally {
    fixture.close();
  }
});

test('后台指纹快路仅对新指纹候选按变化做 SHA，旧 NULL same-size 不读不回填', async () => {
  const fixture = createFixture();
  try {
    const archived = await fixture.service.archiveFile({
      ...batchPayload('fingerprint-fast-path'),
      filePath: writeSource(fixture, 'fingerprint.xlsx', 'fingerprint-content'),
      role: 'output'
    });
    let artifact = fixture.repository.getArtifact(archived.artifact.id);
    const blobPath = path.join(fixture.rootDir, ...artifact.blob.relativePath.split('/'));
    const layoutPath = path.join(fixture.rootDir, ...artifact.storageRelativePath.split('/'));
    let blobHashCalls = 0;
    const originalHashFile = fixture.service._hashFile.bind(fixture.service);
    fixture.service._hashFile = async (...args) => {
      blobHashCalls += 1;
      return originalHashFile(...args);
    };
    let layoutHashCalls = 0;
    const originalLayoutVerify = fixture.service.materializer.verify.bind(fixture.service.materializer);
    fixture.service.materializer.verify = async (...args) => {
      layoutHashCalls += 1;
      return originalLayoutVerify(...args);
    };

    await fixture.service.runBlobMetadataMaintenance();
    await fixture.service.runArtifactMetadataMaintenance();
    assert.equal(blobHashCalls, 0, '相同 Blob 指纹不得 SHA');
    assert.equal(layoutHashCalls, 0, '相同 storage 指纹不得 SHA');

    const future = new Date(Date.now() + 60_000);
    fs.utimesSync(blobPath, future, future);
    fs.utimesSync(layoutPath, future, future);
    await fixture.service.runBlobMetadataMaintenance();
    await fixture.service.runArtifactMetadataMaintenance();
    assert.equal(blobHashCalls, 1, '变化 Blob 候选只做一次 SHA');
    assert.equal(layoutHashCalls, 1, '变化 storage 候选只做一次 SHA');
    artifact = fixture.repository.getArtifact(archived.artifact.id);
    assert.equal(artifact.blob.fingerprint.mtimeMs, fs.statSync(blobPath).mtimeMs);
    assert.equal(artifact.storageFingerprint.mtimeMs, fs.statSync(layoutPath).mtimeMs);

    fixture.db.exec(`
      UPDATE archive_blobs SET
        fingerprint_size_bytes = NULL,
        fingerprint_mtime_ms = NULL,
        fingerprint_ctime_ms = NULL,
        fingerprint_ino = NULL;
      UPDATE archive_artifacts SET
        storage_fingerprint_size_bytes = NULL,
        storage_fingerprint_mtime_ms = NULL,
        storage_fingerprint_ctime_ms = NULL,
        storage_fingerprint_ino = NULL;
    `);
    await fixture.service.runBlobMetadataMaintenance();
    await fixture.service.runArtifactMetadataMaintenance();
    assert.equal(blobHashCalls, 1, '旧 NULL Blob same-size 不得 SHA');
    assert.equal(layoutHashCalls, 1, '旧 NULL layout same-size 不得 SHA');
    artifact = fixture.repository.getArtifact(archived.artifact.id);
    assert.equal(artifact.blob.fingerprint, null);
    assert.equal(artifact.storageFingerprint, null);
  } finally {
    fixture.close();
  }
});

test('分页维护在页间释放 root tail，list 不等待整个 blob 阶段', async () => {
  const fixture = createFixture({ startupMaterializationBatchSize: 1 });
  try {
    await fixture.service.archiveFile({
      ...batchPayload('paged-maintenance-a'),
      filePath: writeSource(fixture, 'page-a.xlsx', 'page-a'),
      role: 'output'
    });
    await fixture.service.archiveFile({
      ...batchPayload('paged-maintenance-b'),
      filePath: writeSource(fixture, 'page-b.xlsx', 'page-b'),
      role: 'output'
    });
    let firstPageResolved;
    const firstPage = new Promise((resolve) => { firstPageResolved = resolve; });
    let releaseSecondPage;
    const secondPage = new Promise((resolve) => { releaseSecondPage = resolve; });
    let pageCalls = 0;
    const originalChunk = fixture.service._verifyBlobChunkUnlocked.bind(fixture.service);
    fixture.service._verifyBlobChunkUnlocked = async (...args) => {
      pageCalls += 1;
      if (pageCalls === 2) await secondPage;
      const result = await originalChunk(...args);
      if (pageCalls === 1) firstPageResolved();
      return result;
    };

    const maintenance = fixture.service.runBlobMetadataMaintenance();
    await firstPage;
    const listed = await fixture.service.listBatches({});
    assert.equal(listed.ok, true);
    assert.equal(pageCalls, 1, 'list 应在第二页取得 root tail 前完成');
    releaseSecondPage();
    assert.equal((await maintenance).ok, true);
  } finally {
    fixture.close();
  }
});

test('三页维护的失败页不推进 cursor、不访问后页，新 visit 从失败页重试', async () => {
  const fixture = createFixture({ startupMaterializationBatchSize: 1 });
  try {
    await fixture.service.initialize();
    const afterCursors = [];
    let firstAttempt = true;
    fixture.service._verifyBlobChunkUnlocked = async ({ afterBlobId }) => {
      afterCursors.push(afterBlobId);
      if (firstAttempt && afterBlobId === 1) {
        return {
          cursor: 2,
          fetched: 1,
          failures: [{ code: 'ARCHIVE_PAGE_TWO_FAILED' }],
          remaining: 1
        };
      }
      const nextCursor = afterBlobId + 1;
      return {
        cursor: nextCursor,
        fetched: 1,
        failures: [],
        remaining: nextCursor < 3 ? 1 : 0
      };
    };
    fixture.service._countBlobsAfter = (cursor) => Math.max(0, 3 - cursor);

    const failed = await fixture.service.runBlobMetadataMaintenance();
    assert.equal(failed.ok, false);
    assert.equal(failed.code, 'ARCHIVE_PAGE_TWO_FAILED');
    assert.equal(failed.cursor, 1);
    assert.deepEqual(afterCursors, [0, 1], '同一 attempt 不得访问第三页或自旋失败页');

    firstAttempt = false;
    const retried = await fixture.service.runBlobMetadataMaintenance();
    assert.equal(retried.ok, true);
    assert.equal(retried.cursor, 3);
    assert.deepEqual(afterCursors, [0, 1, 1, 2], '新 visit 必须从未推进的失败页开始');
  } finally {
    fixture.close();
  }
});

test('retention 按页释放 root tail，返回精确 deletedBatchIds', async () => {
  const fixture = createFixture({ startupMaterializationBatchSize: 1 });
  try {
    const archivedIds = [];
    for (const suffix of ['a', 'b']) {
      const archived = await fixture.service.archiveFile({
        ...batchPayload(`paged-retention-${suffix}`, {
          localDate: '2026-07-01',
          retentionUntil: '2026-07-02'
        }),
        filePath: writeSource(fixture, `retention-${suffix}.xlsx`, `retention-${suffix}`),
        role: 'output'
      });
      archivedIds.push(archived.batch.id);
      fixture.repository.setRetentionUntil(archived.batch.id, '2026-07-21');
    }
    let firstPageResolved;
    const firstPage = new Promise((resolve) => { firstPageResolved = resolve; });
    let deleteCalls = 0;
    const originalDelete = fixture.service._deleteBatchUnlocked.bind(fixture.service);
    fixture.service._deleteBatchUnlocked = async (...args) => {
      const result = await originalDelete(...args);
      deleteCalls += 1;
      if (deleteCalls === 1) firstPageResolved();
      return result;
    };

    const maintenance = fixture.service.runRetentionMaintenance({ asOfLocalDate: '2026-08-20' });
    await firstPage;
    const listed = await fixture.service.listBatches({});
    assert.equal(listed.ok, true);
    assert.equal(deleteCalls, 1, 'list 应在第二个 retention page 前完成');
    const result = await maintenance;
    assert.deepEqual(result.deletedBatchIds.sort((a, b) => a - b), archivedIds.sort((a, b) => a - b));
  } finally {
    fixture.close();
  }
});

test('候选 SHA 期间文件变化时不持久化 pre-hash 指纹', async () => {
  const fixture = createFixture();
  try {
    const archived = await fixture.service.archiveFile({
      ...batchPayload('fingerprint-stable-read'),
      filePath: writeSource(fixture, 'stable-read.xlsx', 'stable-read-content'),
      role: 'output'
    });
    const artifact = fixture.repository.getArtifact(archived.artifact.id);
    const blobPath = path.join(fixture.rootDir, ...artifact.blob.relativePath.split('/'));
    const originalFingerprint = artifact.blob.fingerprint;
    fs.utimesSync(blobPath, new Date(Date.now() + 60_000), new Date(Date.now() + 60_000));
    const originalHash = fixture.service._hashFile.bind(fixture.service);
    fixture.service._hashFile = async (filePath) => {
      const result = await originalHash(filePath);
      fs.utimesSync(filePath, new Date(Date.now() + 120_000), new Date(Date.now() + 120_000));
      return result;
    };

    const maintained = await fixture.service.runBlobMetadataMaintenance();

    assert.equal(maintained.ok, false);
    const after = fixture.repository.getArtifact(archived.artifact.id).blob.fingerprint;
    assert.deepEqual(after, originalFingerprint);
    assert.match(String(after.ino), /^\d+$/);
  } finally {
    fixture.close();
  }
});

test('recoverStartupSafety 只收口中断状态，不删除未知 staging/readonly、cleanup job 或 Blob', async () => {
  const fixture = createFixture();
  try {
    const initialized = await fixture.service.initialize({ deferStartupRecovery: true });
    assert.equal(initialized.ok, true);
    const stagingPath = path.join(fixture.rootDir, '.staging', 'unknown-user-file.part');
    const readonlyPath = path.join(fixture.rootDir, '.readonly', 'unknown-user-copy.xlsx');
    const layoutPath = path.join(fixture.rootDir, 'BANK', '2026', '07', '20', 'preserve.xlsx');
    const blobPath = path.join(fixture.rootDir, 'blobs', 'sha256', 'aa', 'preserve-blob');
    for (const filePath of [stagingPath, readonlyPath, layoutPath, blobPath]) {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, `preserve:${path.basename(filePath)}`);
    }
    fixture.db.prepare(`
      INSERT INTO archive_cleanup_jobs (
        batch_id, batch_number, local_date, layout_relative_dir,
        materialized_paths_json, released_blobs_json,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      999,
      'BANK-20260720-999',
      '2026-07-20',
      'BANK/2026/07/20/BANK-20260720-999',
      JSON.stringify(['BANK/2026/07/20/preserve.xlsx']),
      JSON.stringify([{ relativePath: 'blobs/sha256/aa/preserve-blob' }]),
      '2026-07-20 12:00:00',
      '2026-07-20 12:00:00'
    );
    const result = await fixture.service.recoverStartupSafety();
    assert.equal(result.ok, true);
    assert.equal(result.interruptedArtifactCount, 0);
    assert.equal(fixture.repository.listCleanupJobs().length, 1);
    for (const filePath of [stagingPath, readonlyPath, layoutPath, blobPath]) {
      assert.equal(fs.existsSync(filePath), true, `${filePath} 启动不得删除`);
    }
  } finally {
    fixture.close();
  }
});

test('openReadonlyCopy 和 saveAs 只复制存档内容，不暴露或改写 blob', async () => {
  const fixture = createFixture();
  try {
    const sourcePath = writeSource(fixture, 'result.xlsx', 'archived-result');
    const archived = await fixture.service.archiveFile({
      ...batchPayload('copy-actions'),
      filePath: sourcePath,
      role: 'output',
      direction: 'output'
    });

    const readonly = await fixture.service.openReadonlyCopy(archived.artifact.id);
    assert.equal(readonly.ok, true);
    assert.equal(readonly.status, 'copy-ready');
    assert.equal(fs.readFileSync(readonly.filePath, 'utf8'), 'archived-result');
    assert.equal(fs.statSync(readonly.filePath).mode & 0o222, 0);

    const internalTarget = path.join(fixture.rootDir, 'manual-copy.xlsx');
    const rejectedInternal = await fixture.service.saveAs(archived.artifact.id, internalTarget);
    assert.equal(rejectedInternal.ok, false);
    assert.equal(rejectedInternal.code, 'ARCHIVE_SAVE_TARGET_INVALID');
    assert.equal(fs.existsSync(internalTarget), false);

    const targetPath = path.join(fixture.tempDir, 'saved', 'result-copy.xlsx');
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(targetPath, 'old-target');
    const saved = await fixture.service.saveAs(archived.artifact.id, targetPath);
    assert.equal(saved.ok, true);
    assert.equal(saved.status, 'saved');
    assert.equal(fs.readFileSync(targetPath, 'utf8'), 'archived-result');
    assert.deepEqual(
      fs.readdirSync(path.dirname(targetPath)).filter((name) => name.startsWith('.archive-save-')),
      []
    );

    const detail = await fixture.service.getBatch(archived.batch.id);
    assert.equal('sourcePath' in detail.batch.artifacts[0], false);
    assert.equal('relativePath' in detail.batch.artifacts[0].blob, false);
    assert.equal(fs.readFileSync(sourcePath, 'utf8'), 'archived-result');
  } finally {
    fixture.close();
  }
});

test('打开与另存即使 storage 指纹相同仍执行完整 SHA 校验', async () => {
  const fixture = createFixture();
  try {
    const archived = await fixture.service.archiveFile({
      ...batchPayload('copy-actions-full-sha'),
      filePath: writeSource(fixture, 'full-sha.xlsx', 'full-sha-content'),
      role: 'output'
    });
    let verifyCalls = 0;
    const originalVerify = fixture.service.materializer.verify.bind(fixture.service.materializer);
    fixture.service.materializer.verify = async (...args) => {
      verifyCalls += 1;
      return originalVerify(...args);
    };

    assert.equal((await fixture.service.openReadonlyCopy(archived.artifact.id)).ok, true);
    assert.equal((await fixture.service.saveAs(
      archived.artifact.id,
      path.join(fixture.tempDir, 'full-sha-saved.xlsx')
    )).ok, true);
    assert.equal(verifyCalls, 2);
  } finally {
    fixture.close();
  }
});

test('另存目标经目录链接指向存档根时仍拒绝写入', async (t) => {
  const fixture = createFixture();
  try {
    const sourcePath = writeSource(fixture, 'linked-target.xlsx', 'linked-target-content');
    const archived = await fixture.service.archiveFile({
      ...batchPayload('linked-save-target'),
      filePath: sourcePath,
      role: 'output'
    });
    const linkedDir = path.join(fixture.tempDir, 'archive-alias');
    try {
      fs.symlinkSync(
        fixture.rootDir,
        linkedDir,
        process.platform === 'win32' ? 'junction' : 'dir'
      );
    } catch (error) {
      if (error && ['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) {
        t.skip(`当前环境不能创建目录链接：${error.code}`);
        return;
      }
      throw error;
    }

    const result = await fixture.service.saveAs(
      archived.artifact.id,
      path.join(linkedDir, 'must-not-write.xlsx')
    );
    assert.equal(result.ok, false);
    assert.equal(result.code, 'ARCHIVE_SAVE_TARGET_INVALID');
    assert.equal(fs.existsSync(path.join(fixture.rootDir, 'must-not-write.xlsx')), false);
  } finally {
    fixture.close();
  }
});

test('canonical ancestor 被目录链接替换后 open/save/delete/publish 均 fail-closed', async (t) => {
  const linkDirectory = (target, linkPath) => {
    try {
      fs.symlinkSync(target, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
      return true;
    } catch (error) {
      if (error && ['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) return false;
      throw error;
    }
  };

  await t.test('open/save', async (subtest) => {
    const fixture = createFixture();
    try {
      const content = 'linked-canonical-read';
      const archived = await fixture.service.archiveFile({
        ...batchPayload('linked-canonical-read'),
        filePath: writeSource(fixture, 'linked-read.xlsx', content),
        role: 'output'
      });
      const artifact = fixture.repository.getArtifact(archived.artifact.id);
      const canonicalPath = path.join(fixture.rootDir, ...artifact.blob.relativePath.split('/'));
      const prefixDir = path.dirname(canonicalPath);
      const externalDir = path.join(fixture.tempDir, 'external-read-prefix');
      fs.mkdirSync(externalDir);
      fs.copyFileSync(canonicalPath, path.join(externalDir, path.basename(canonicalPath)));
      fs.rmSync(prefixDir, { recursive: true });
      if (!linkDirectory(externalDir, prefixDir)) {
        subtest.skip('当前环境不能创建目录链接');
        return;
      }
      fs.rmSync(path.join(fixture.rootDir, ...artifact.storageRelativePath.split('/')));

      const opened = await fixture.service.openReadonlyCopy(artifact.id);
      const savedPath = path.join(fixture.tempDir, 'must-not-save.xlsx');
      const saved = await fixture.service.saveAs(artifact.id, savedPath);

      assert.equal(opened.ok, false);
      assert.equal(opened.code, 'ARCHIVE_PATH_SYMLINK_REJECTED');
      assert.equal(saved.ok, false);
      assert.equal(saved.code, 'ARCHIVE_PATH_SYMLINK_REJECTED');
      assert.equal(fs.existsSync(savedPath), false);
      assert.equal(fs.readFileSync(path.join(externalDir, path.basename(canonicalPath)), 'utf8'), content);
    } finally {
      fixture.close();
    }
  });

  await t.test('delete', async (subtest) => {
    const fixture = createFixture();
    try {
      const content = 'linked-canonical-delete';
      const archived = await fixture.service.archiveFile({
        ...batchPayload('linked-canonical-delete'),
        filePath: writeSource(fixture, 'linked-delete.xlsx', content),
        role: 'output'
      });
      const artifact = fixture.repository.getArtifact(archived.artifact.id);
      const canonicalPath = path.join(fixture.rootDir, ...artifact.blob.relativePath.split('/'));
      const prefixDir = path.dirname(canonicalPath);
      const externalDir = path.join(fixture.tempDir, 'external-delete-prefix');
      fs.mkdirSync(externalDir);
      const externalPath = path.join(externalDir, path.basename(canonicalPath));
      fs.copyFileSync(canonicalPath, externalPath);
      fs.rmSync(prefixDir, { recursive: true });
      if (!linkDirectory(externalDir, prefixDir)) {
        subtest.skip('当前环境不能创建目录链接');
        return;
      }

      const deleted = await fixture.service.deleteBatch(archived.batch.id);

      assert.equal(deleted.metadataDeleted, true);
      assert.equal(deleted.status, 'deleted-cleanup-pending');
      assert.equal(fs.readFileSync(externalPath, 'utf8'), content);
      assert.equal(fixture.repository.listCleanupJobs().length, 1);
    } finally {
      fixture.close();
    }
  });

  await t.test('publish', async (subtest) => {
    const fixture = createFixture();
    try {
      await fixture.service.initialize();
      const content = 'linked-canonical-publish';
      const sha256 = crypto.createHash('sha256').update(content).digest('hex');
      const prefixDir = path.join(fixture.rootDir, 'blobs', 'sha256', sha256.slice(0, 2));
      const externalDir = path.join(fixture.tempDir, 'external-publish-prefix');
      fs.mkdirSync(externalDir);
      if (!linkDirectory(externalDir, prefixDir)) {
        subtest.skip('当前环境不能创建目录链接');
        return;
      }

      const archived = await fixture.service.archiveFile({
        ...batchPayload('linked-canonical-publish'),
        filePath: writeSource(fixture, 'linked-publish.xlsx', content),
        role: 'output'
      });

      assert.equal(archived.ok, false);
      assert.equal(archived.code, 'ARCHIVE_PATH_SYMLINK_REJECTED');
      assert.deepEqual(fs.readdirSync(externalDir), []);
    } finally {
      fixture.close();
    }
  });
});

test('root/.staging/.readonly 被目录链接替换时 stage/open 不进入外部目录', async (t) => {
  const linkDirectory = (target, linkPath) => {
    try {
      fs.symlinkSync(target, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
      return true;
    } catch (error) {
      if (error && ['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) return false;
      throw error;
    }
  };

  await t.test('root', async (subtest) => {
    const fixture = createFixture();
    try {
      const external = path.join(fixture.tempDir, 'external-root');
      fs.mkdirSync(external);
      if (!linkDirectory(external, fixture.rootDir)) {
        subtest.skip('当前环境不能创建目录链接');
        return;
      }
      const result = await fixture.service.archiveFile({
        ...batchPayload('linked-root-stage'),
        filePath: writeSource(fixture, 'linked-root.xlsx', 'linked-root'),
        role: 'output'
      });
      assert.equal(result.ok, false);
      assert.equal(result.code, 'ARCHIVE_PATH_SYMLINK_REJECTED');
      assert.deepEqual(fs.readdirSync(external), []);
    } finally {
      fixture.close();
    }
  });

  await t.test('.staging', async (subtest) => {
    const fixture = createFixture();
    try {
      await fixture.service.initialize();
      const external = path.join(fixture.tempDir, 'external-staging');
      fs.mkdirSync(external);
      fs.rmdirSync(path.join(fixture.rootDir, '.staging'));
      if (!linkDirectory(external, path.join(fixture.rootDir, '.staging'))) {
        subtest.skip('当前环境不能创建目录链接');
        return;
      }
      const result = await fixture.service.archiveFile({
        ...batchPayload('linked-staging-stage'),
        filePath: writeSource(fixture, 'linked-staging.xlsx', 'linked-staging'),
        role: 'output'
      });
      assert.equal(result.ok, false);
      assert.equal(result.code, 'ARCHIVE_PATH_SYMLINK_REJECTED');
      assert.deepEqual(fs.readdirSync(external), []);
    } finally {
      fixture.close();
    }
  });

  await t.test('.readonly', async (subtest) => {
    const fixture = createFixture();
    try {
      const archived = await fixture.service.archiveFile({
        ...batchPayload('linked-readonly-open'),
        filePath: writeSource(fixture, 'linked-readonly.xlsx', 'linked-readonly'),
        role: 'output'
      });
      const external = path.join(fixture.tempDir, 'external-readonly');
      fs.mkdirSync(external);
      fs.rmdirSync(path.join(fixture.rootDir, '.readonly'));
      if (!linkDirectory(external, path.join(fixture.rootDir, '.readonly'))) {
        subtest.skip('当前环境不能创建目录链接');
        return;
      }
      const result = await fixture.service.openReadonlyCopy(archived.artifact.id);
      assert.equal(result.ok, false);
      assert.equal(result.code, 'ARCHIVE_PATH_SYMLINK_REJECTED');
      assert.deepEqual(fs.readdirSync(external), []);
    } finally {
      fixture.close();
    }
  });
});

test('发布 rename 失败时不 reject、不留下 staging 或半成品 blob', async () => {
  const basePromises = fs.promises;
  const failingFs = {
    ...fs,
    promises: {
      ...basePromises,
      async rename(sourcePath, targetPath) {
        if (sourcePath.endsWith('.part') && targetPath.includes(`${path.sep}blobs${path.sep}`)) {
          const error = new Error('injected publish failure');
          error.code = 'EACCES';
          throw error;
        }
        return basePromises.rename(sourcePath, targetPath);
      }
    }
  };
  const fixture = createFixture({ fsImpl: failingFs });
  try {
    const sourcePath = writeSource(fixture, 'publish-failure.xlsx', 'never-published');
    let result;
    await assert.doesNotReject(async () => {
      result = await fixture.service.archiveFile({
        ...batchPayload('publish-failure'),
        filePath: sourcePath,
        role: 'output'
      });
    });

    assert.equal(result.ok, false);
    assert.equal(result.status, 'failed');
    assert.equal(result.code, 'ARCHIVE_EACCES');
    assert.deepEqual(fs.readdirSync(path.join(fixture.rootDir, '.staging')), []);
    const blobFiles = fs.readdirSync(path.join(fixture.rootDir, 'blobs', 'sha256'), {
      recursive: true
    }).filter((entry) => /^[a-f0-9]{64}$/.test(entry));
    assert.deepEqual(blobFiles, []);
  } finally {
    fixture.close();
  }
});

test('Windows 语义下 publish 与 materialized copy 以可写句柄 fsync 后再设为只读', async () => {
  const basePromises = fs.promises;
  const syncedStageModes = [];
  const windowsFsyncFs = {
    ...fs,
    promises: {
      ...basePromises,
      async open(targetPath, flags, ...args) {
        const handle = await basePromises.open(targetPath, flags, ...args);
        const normalized = String(targetPath);
        if (!normalized.includes(`${path.sep}.staging${path.sep}`)
            || !normalized.endsWith('.part')) {
          return handle;
        }
        return new Proxy(handle, {
          get(object, property) {
            if (property === 'sync') {
              return async () => {
                syncedStageModes.push(flags);
                if (flags === 'r') {
                  const error = new Error('EPERM: Windows requires a writable fsync handle');
                  error.code = 'EPERM';
                  throw error;
                }
                const stat = await basePromises.lstat(targetPath);
                if ((stat.mode & 0o222) === 0) {
                  const error = new Error('EACCES: Windows cannot open a read-only file for write');
                  error.code = 'EACCES';
                  throw error;
                }
                return object.sync();
              };
            }
            const value = Reflect.get(object, property, object);
            return typeof value === 'function' ? value.bind(object) : value;
          }
        });
      }
    }
  };
  const fixture = createFixture({ fsImpl: windowsFsyncFs });
  try {
    const archived = await fixture.service.archiveFile({
      ...batchPayload('windows-writable-fsync'),
      filePath: writeSource(fixture, 'windows-writable-fsync.xlsx', 'windows-fsync'),
      role: 'output'
    });

    assert.equal(archived.ok, true, JSON.stringify(archived));
    assert.deepEqual(syncedStageModes, ['r+', 'r+']);
    const artifact = fixture.repository.getArtifact(archived.artifact.id);
    const materializedPath = path.join(
      fixture.rootDir,
      ...artifact.storageRelativePath.split('/')
    );
    assert.equal(fs.statSync(materializedPath).mode & 0o222, 0);
  } finally {
    fixture.close();
  }
});

test('blob 已发布但元数据提交失败时不自动收编无 owner 文件，人工移除后可恢复', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-metadata-failure-'));
  const rootDir = path.join(tempDir, 'archive-root');
  const sourcePath = path.join(tempDir, 'source.xlsx');
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  fs.writeFileSync(sourcePath, 'published-before-metadata');
  const now = () => new Date(2026, 6, 20, 12, 0, 0);
  const repository = createArchiveRepository(db, { now });
  const completeArtifact = repository.completeArtifact.bind(repository);
  let shouldFail = true;
  repository.completeArtifact = (...args) => {
    if (shouldFail) {
      shouldFail = false;
      const error = new Error('injected metadata failure');
      error.code = 'SQLITE_BUSY';
      throw error;
    }
    return completeArtifact(...args);
  };
  const service = createArchiveService({ repository, rootDir, now });

  try {
    const failed = await service.archiveFile({
      ...batchPayload('metadata-failure'),
      filePath: sourcePath,
      role: 'output'
    });
    assert.equal(failed.ok, false);
    assert.equal(failed.code, 'ARCHIVE_SQLITE_BUSY');
    assert.equal(failed.metadataRecorded, true);

    const hash = crypto.createHash('sha256').update('published-before-metadata').digest('hex');
    const publishedPath = path.join(rootDir, ...blobRelativePath(hash).split('/'));
    assert.equal(fs.readFileSync(publishedPath, 'utf8'), 'published-before-metadata');
    assert.equal((await service.getStats()).stats.uniqueFileCount, 0);

    const blockedRetry = await service.retryBatch(failed.batch.id);
    assert.equal(blockedRetry.ok, false);
    assert.equal(blockedRetry.results[0].code, 'ARCHIVE_BLOB_UNKNOWN_CONFLICT');
    assert.equal(fs.readFileSync(publishedPath, 'utf8'), 'published-before-metadata');
    assert.equal(repository.findBlobByHash(hash), null);

    fs.rmSync(publishedPath);
    const retried = await service.retryBatch(failed.batch.id);
    assert.equal(retried.ok, true);
    assert.equal(retried.succeeded, 1);
    assert.equal(retried.results[0].deduplicated, false);
    assert.equal((await service.getStats()).stats.uniqueFileCount, 1);
    assert.deepEqual(fs.readdirSync(path.join(rootDir, '.staging')), []);
  } finally {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('存档目录暂不可写时仍登记失败批次，目录恢复后可重试', async () => {
  const basePromises = fs.promises;
  let storageWritable = false;
  let archiveRoot = '';
  const unavailableFs = {
    ...fs,
    promises: {
      ...basePromises,
      async mkdir(targetPath, options) {
        if (!storageWritable && String(targetPath).startsWith(archiveRoot)) {
          const error = new Error('archive storage denied');
          error.code = 'EACCES';
          throw error;
        }
        return basePromises.mkdir(targetPath, options);
      }
    }
  };
  const fixture = createFixture({ fsImpl: unavailableFs });
  archiveRoot = fixture.rootDir;
  try {
    const sourcePath = writeSource(fixture, 'storage-retry.xlsx', 'retry-after-permission');
    const created = await fixture.service.createBatch({
      ...batchPayload('storage-retry'),
      sourceOperation: 'business:run',
      files: [{ filePath: sourcePath, role: 'input' }]
    });

    assert.equal(created.ok, false);
    assert.ok(created.batchId);
    assert.equal(created.batch.archiveStatus, 'incomplete');
    assert.equal(created.failed, 1);
    const failed = await fixture.service.getBatch(created.batchId);
    assert.equal(failed.ok, true);
    assert.equal(failed.batch.artifacts[0].status, 'failed');
    assert.equal(failed.batch.artifacts[0].lastErrorCode, 'ARCHIVE_EACCES');

    storageWritable = true;
    const retried = await fixture.service.retryBatch(created.batchId);
    assert.equal(retried.ok, true);
    assert.equal(retried.succeeded, 1);
    assert.equal(retried.batch.archiveStatus, 'complete');
  } finally {
    fixture.close();
  }
});

test('初始化后的存档根离线时 open/attach fail-closed，不改 DB 或重建 split root', async () => {
  const fixture = createFixture();
  try {
    const archived = await fixture.service.archiveFile({
      ...batchPayload('offline-root-existing'),
      filePath: writeSource(fixture, 'offline-existing.xlsx', 'offline-existing'),
      role: 'output'
    });
    const before = {
      artifact: fixture.repository.getArtifact(archived.artifact.id),
      batches: fixture.repository.listBatches().length
    };
    const offlineRoot = `${fixture.rootDir}-offline`;
    fs.renameSync(fixture.rootDir, offlineRoot);

    const opened = await fixture.service.openReadonlyCopy(archived.artifact.id);
    const attached = await fixture.service.attachFile(archived.batch.id, {
      filePath: writeSource(fixture, 'offline-new.xlsx', 'offline-new'),
      role: 'output'
    });

    assert.equal(opened.ok, false);
    assert.equal(opened.code, 'ARCHIVE_STORAGE_ROOT_UNAVAILABLE');
    assert.equal(attached.ok, false);
    assert.equal(attached.code, 'ARCHIVE_STORAGE_ROOT_UNAVAILABLE');
    assert.equal(fs.existsSync(fixture.rootDir), false);
    assert.equal(fs.existsSync(offlineRoot), true);
    assert.deepEqual(fixture.repository.getArtifact(archived.artifact.id), before.artifact);
    assert.equal(fixture.repository.listBatches().length, before.batches);
  } finally {
    fixture.close();
  }
});

test('根已建立但初始化子目录 EIO 后，archive/attach 不得把离线根当作首次 bootstrap 重建', async () => {
  for (const entry of ['archive', 'attach']) {
    const basePromises = fs.promises;
    let archiveRoot = '';
    let failSubdirectoryMkdir = true;
    const transientFs = {
      ...fs,
      promises: {
        ...basePromises,
        async mkdir(targetPath, options) {
          if (failSubdirectoryMkdir
              && archiveRoot
              && path.resolve(String(targetPath)) !== archiveRoot
              && path.resolve(String(targetPath)).startsWith(`${archiveRoot}${path.sep}`)) {
            const error = new Error('archive child directory I/O failure');
            error.code = 'EIO';
            throw error;
          }
          return basePromises.mkdir(targetPath, options);
        }
      }
    };
    const fixture = createFixture({ fsImpl: transientFs });
    archiveRoot = fixture.rootDir;
    try {
      const initialized = await fixture.service.initialize({
        startBackgroundMaterialization: false
      });
      assert.equal(initialized.status, 'ready-with-storage-warning');
      assert.equal(initialized.code, 'ARCHIVE_EIO');
      assert.equal(fs.lstatSync(fixture.rootDir).isDirectory(), true);

      const existingBatch = createLegacyEmptyBatch(fixture, `partial-init-${entry}`);
      const before = {
        batch: fixture.repository.getBatch(existingBatch.id),
        batchCount: fixture.repository.listBatches().length,
        artifactCount: fixture.repository.listArtifacts(existingBatch.id).length
      };
      failSubdirectoryMkdir = false;
      const offlineRoot = `${fixture.rootDir}-offline`;
      fs.renameSync(fixture.rootDir, offlineRoot);
      const sourcePath = writeSource(
        fixture,
        `partial-init-${entry}.xlsx`,
        `partial-init-${entry}`
      );

      const result = entry === 'archive'
        ? await fixture.service.archiveFile({
          ...batchPayload('partial-init-new-archive'),
          filePath: sourcePath,
          role: 'output'
        })
        : await fixture.service.attachFile(existingBatch.id, {
          filePath: sourcePath,
          role: 'output'
        });

      assert.equal(result.ok, false, entry);
      assert.equal(result.code, 'ARCHIVE_STORAGE_ROOT_UNAVAILABLE', entry);
      assert.equal(fs.existsSync(fixture.rootDir), false, entry);
      assert.equal(fs.existsSync(offlineRoot), true, entry);
      assert.deepEqual(fixture.repository.getBatch(existingBatch.id), before.batch, entry);
      assert.equal(fixture.repository.listBatches().length, before.batchCount, entry);
      assert.equal(
        fixture.repository.listArtifacts(existingBatch.id).length,
        before.artifactCount,
        entry
      );
    } finally {
      fixture.close();
    }
  }
});

test('数据库初始化不可用也只返回 unavailable，不向业务 Promise 抛错', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-init-failure-'));
  const service = createArchiveService({
    rootDir: path.join(tempDir, 'archive-root'),
    repository: {
      ensureSchema() {
        const error = new Error('database path must stay private');
        error.code = 'SQLITE_CANTOPEN';
        throw error;
      }
    }
  });
  try {
    let result;
    await assert.doesNotReject(async () => {
      result = await service.createBatch(batchPayload('unavailable'));
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'ARCHIVE_SQLITE_CANTOPEN');
    assert.equal(result.message.includes('database path must stay private'), false);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
