'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const XLSX = require('xlsx');

const {
  readOwnedArtifactEvidence
} = require('../../../src/main-process/read-only-exports/common/artifact-evidence');
const {
  readWorkbookBusinessEvidence
} = require('../../../src/main-process/read-only-exports/common/workbook-evidence');
const {
  generateValidateAndPublishPendingExport
} = require('../../../src/main-process/read-only-exports/pending/managed-export');
const {
  PENDING_READ_ONLY_ACTIONS
} = require('../../../src/main-process/read-only-exports/pending/policies');
const {
  generateValidateAndPublishBizOpExport
} = require('../../../src/main-process/read-only-exports/biz-op/managed-export');
const {
  isoDate
} = require('../../../src/main-process/read-only-exports/biz-op/actions');
const {
  BIZ_OP_READ_ONLY_ACTIONS
} = require('../../../src/main-process/read-only-exports/biz-op/policies');

const SOURCE_DIGEST = 'a'.repeat(64);

function createFixture(t, prefix) {
  const stagingRoot = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(stagingRoot, { recursive: true, force: true }));
  return Object.freeze({
    stagingRoot,
    stagingResourceId: 'result.xlsx',
    generationPath: path.join(stagingRoot, 'result.xlsx'),
    outputArtifactKey: `${prefix}output`
  });
}

function writeWorkbook(generationPath) {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.aoa_to_sheet([['编号', '金额'], ['ROW-E13-A', 123.45]]),
    '结果'
  );
  XLSX.writeFile(workbook, generationPath);
}

async function artifactClaim(plan) {
  const technical = await readOwnedArtifactEvidence(plan);
  const business = readWorkbookBusinessEvidence(plan.generationPath);
  return Object.freeze({
    outputArtifactKey: plan.outputArtifactKey,
    byteSize: technical.byteSize,
    sha256: technical.sha256,
    businessDigest: business.businessDigest,
    sheetCount: business.sheetCount,
    dataRowCount: business.dataRowCount
  });
}

function batchContext({ actionKey, operationKey, taskRunId }) {
  return Object.freeze({
    taskRunId,
    taskKey: `task-key:${actionKey}`,
    moduleId: 'read-only-export-e13-a-test',
    parentRunId: 'parent:e13-a-test',
    operationKey
  });
}

function completedExecution({ actionKey, operationKey, taskRunId, artifact, summary }) {
  return Object.freeze({
    outcome: 'completed',
    terminalSource: 'job:done',
    result: Object.freeze({
      contractVersion: 1,
      actionKey,
      operationKey,
      taskRunId,
      sourceDigest: SOURCE_DIGEST,
      artifacts: Object.freeze([artifact]),
      summary: Object.freeze(summary)
    })
  });
}

test('E13-A Pending Main settlement 在三次 source gate 后才调用 Publisher', async (t) => {
  const plan = createFixture(t, 'pending-main-settlement-e13-a-');
  writeWorkbook(plan.generationPath);
  const artifact = await artifactClaim(plan);
  const actionKey = PENDING_READ_ONLY_ACTIONS.ERRORS;
  const operationKey = 'operation:pending-main-settlement';
  const taskRunId = 'task:pending-main-settlement';
  let sourceGateCount = 0;
  let publisherCount = 0;
  const result = await generateValidateAndPublishPendingExport({
    runtime: {
      async execute() {
        return completedExecution({
          actionKey,
          operationKey,
          taskRunId,
          artifact,
          summary: { errorCount: 1 }
        });
      }
    },
    actionKey,
    operationKey,
    taskRunId,
    batchContext: batchContext({ actionKey, operationKey, taskRunId }),
    stableRunEvidence: { sourceDigest: SOURCE_DIGEST },
    generationPlan: plan,
    context: { kind: 'pending-errors', errorCount: 1 },
    production: true,
    assertSourceFresh() { sourceGateCount += 1; },
    async publisher(artifacts, summary) {
      publisherCount += 1;
      assert.equal(Object.isFrozen(artifacts), true);
      assert.equal(artifacts[0].sha256, artifact.sha256);
      assert.deepEqual(summary, { errorCount: 1 });
      return Object.freeze({ taskId: 'publication:pending-e13-a' });
    }
  });
  assert.equal(sourceGateCount, 3);
  assert.equal(publisherCount, 1);
  assert.equal(result.publication.taskId, 'publication:pending-e13-a');
});

test('E13-A Pending authority、artifact tamper 与最终 source drift 均阻断 Publisher', async (t) => {
  const actionKey = PENDING_READ_ONLY_ACTIONS.ERRORS;
  const operationKey = 'operation:pending-main-failure';
  const taskRunId = 'task:pending-main-failure';
  let runtimeCount = 0;
  let publisherCount = 0;
  await assert.rejects(generateValidateAndPublishPendingExport({
    runtime: { async execute() { runtimeCount += 1; } },
    publisher: async () => { publisherCount += 1; },
    actionKey,
    operationKey,
    taskRunId,
    batchContext: batchContext({
      actionKey,
      operationKey: 'operation:wrong',
      taskRunId
    })
  }), { code: 'PENDING_EXPORT_TASK_AUTHORITY_MISMATCH' });
  assert.equal(runtimeCount, 0);
  assert.equal(publisherCount, 0);

  const tamperPlan = createFixture(t, 'pending-main-tamper-e13-a-');
  writeWorkbook(tamperPlan.generationPath);
  const tamperClaim = await artifactClaim(tamperPlan);
  fs.appendFileSync(tamperPlan.generationPath, 'tampered');
  await assert.rejects(generateValidateAndPublishPendingExport({
    runtime: {
      async execute() {
        runtimeCount += 1;
        return completedExecution({
          actionKey,
          operationKey,
          taskRunId,
          artifact: tamperClaim,
          summary: { errorCount: 1 }
        });
      }
    },
    publisher: async () => { publisherCount += 1; },
    actionKey,
    operationKey,
    taskRunId,
    batchContext: batchContext({ actionKey, operationKey, taskRunId }),
    stableRunEvidence: { sourceDigest: SOURCE_DIGEST },
    generationPlan: tamperPlan,
    context: { kind: 'pending-errors', errorCount: 1 }
  }), { code: 'PENDING_EXPORT_ARTIFACT_TAMPERED' });
  assert.equal(publisherCount, 0);

  const stalePlan = createFixture(t, 'pending-main-stale-e13-a-');
  writeWorkbook(stalePlan.generationPath);
  const staleClaim = await artifactClaim(stalePlan);
  let sourceGateCount = 0;
  await assert.rejects(generateValidateAndPublishPendingExport({
    runtime: {
      async execute() {
        return completedExecution({
          actionKey,
          operationKey,
          taskRunId,
          artifact: staleClaim,
          summary: { errorCount: 1 }
        });
      }
    },
    publisher: async () => { publisherCount += 1; },
    actionKey,
    operationKey,
    taskRunId,
    batchContext: batchContext({ actionKey, operationKey, taskRunId }),
    stableRunEvidence: { sourceDigest: SOURCE_DIGEST },
    generationPlan: stalePlan,
    context: { kind: 'pending-errors', errorCount: 1 },
    assertSourceFresh() {
      sourceGateCount += 1;
      if (sourceGateCount === 3) {
        const error = new Error('source changed before publish');
        error.code = 'PENDING_EXPORT_SOURCE_STALE';
        throw error;
      }
    }
  }), { code: 'PENDING_EXPORT_SOURCE_STALE' });
  assert.equal(sourceGateCount, 3);
  assert.equal(publisherCount, 0);
});

test('E13-A BizOP Publisher crash 透传且无效 ISO 日期返回受控错误', async (t) => {
  assert.throws(() => isoDate('100000-01-01', 'startDate'), {
    code: 'BIZ_OP_EXPORT_INPUT_INVALID'
  });
  assert.throws(() => isoDate('2026-02-30', 'startDate'), {
    code: 'BIZ_OP_EXPORT_INPUT_INVALID'
  });

  const plan = createFixture(t, 'biz-op-main-settlement-e13-a-');
  writeWorkbook(plan.generationPath);
  const artifact = await artifactClaim(plan);
  const actionKey = BIZ_OP_READ_ONLY_ACTIONS.DAY;
  const operationKey = 'operation:biz-op-main-settlement';
  const taskRunId = 'task:biz-op-main-settlement';
  let sourceGateCount = 0;
  let publisherCount = 0;
  await assert.rejects(generateValidateAndPublishBizOpExport({
    runtime: {
      async execute() {
        return completedExecution({
          actionKey,
          operationKey,
          taskRunId,
          artifact,
          summary: { rowCount: 1 }
        });
      }
    },
    actionKey,
    operationKey,
    taskRunId,
    batchContext: batchContext({ actionKey, operationKey, taskRunId }),
    stableRunEvidence: { sourceDigest: SOURCE_DIGEST },
    generationPlan: plan,
    context: { kind: 'biz-op-day', mirrorRunId: 1 },
    assertSourceFresh() { sourceGateCount += 1; },
    async publisher() {
      publisherCount += 1;
      const error = new Error('publisher crash');
      error.code = 'BIZ_OP_EXPORT_PUBLISHER_FAILED';
      throw error;
    }
  }), { code: 'BIZ_OP_EXPORT_PUBLISHER_FAILED' });
  assert.equal(sourceGateCount, 3);
  assert.equal(publisherCount, 1);
});

test('E13-A Main 五入口均按 action gate；BizOP 仅单日在发布后更新 export_path', () => {
  const mainSource = fs.readFileSync(path.resolve(__dirname, '../../../src/main.js'), 'utf8');
  assert.match(
    mainSource,
    /function attachReadOnlyExportReceiptAcknowledgement[\s\S]{0,500}?terminalStatus === 'succeeded'[\s\S]{0,500}?acknowledgeToolboxPublicationReceipts/
  );
  for (const action of [
    'PENDING_READ_ONLY_ACTIONS.ERRORS',
    'PENDING_READ_ONLY_ACTIONS.DIFF',
    'PENDING_READ_ONLY_ACTIONS.SUMMARY',
    'BIZ_OP_READ_ONLY_ACTIONS.DAY',
    'BIZ_OP_READ_ONLY_ACTIONS.RANGE'
  ]) {
    assert.match(mainSource, new RegExp(`isProductionEnabled\\(\\s*${action}\\s*\\)`));
  }

  const dayStart = mainSource.indexOf("trackedIpcHandle('bizOpRecon:export:date'");
  const rangeStart = mainSource.indexOf("trackedIpcHandle('bizOpRecon:export:date-range'");
  assert.ok(dayStart > 0 && rangeStart > dayStart);
  const managedDay = mainSource.slice(dayStart, rangeStart);
  const generationIndex = managedDay.indexOf('await generateValidateAndPublishBizOpExport({');
  const metadataIndex = managedDay.indexOf('bizOpReconRunData.recordExportPath({');
  assert.ok(generationIndex >= 0 && metadataIndex > generationIndex);

  const rangeEnd = mainSource.indexOf("trackedIpcHandle('bizOpRecon:import:pick-files'", rangeStart);
  const rangeSection = mainSource.slice(rangeStart, rangeEnd > rangeStart ? rangeEnd : undefined);
  assert.doesNotMatch(rangeSection, /bizOpReconRunData\.recordExportPath\(/);
});
