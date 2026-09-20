'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { createArchiveService } = require('../../../src/main-process/archive-center/archive-service');
const { createArchiveCenterController } = require('../../../src/main-process/archive-center/controller');
const { normalizeFilePlanV1, artifactManifestFromFilePlan } = require('../../../src/main-process/archive-center/file-plan');
const { createArchivePublicationOwner } = require('../../../src/main-process/publication-recovery/archive-owner');

const PRODUCERS = [
  { taskKey: 'position-reconciliation:run:export', moduleId: 'position-reconciliation-process' },
  { taskKey: 'position-reconciliation:run:export-filtered', moduleId: 'position-reconciliation-process' },
  { taskKey: 'new-account:export', moduleId: 'new-account' }
];

async function fixture(t, producer) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'publication-producer-contract-'));
  const db = new DatabaseSync(path.join(root, 'main.sqlite'));
  t.after(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const service = createArchiveService({ database: db, rootDir: path.join(root, 'archive') });
  await service.initialize();
  const center = createArchiveCenterController({ service, database: { getSetting: () => null, setSetting() {} } });
  const owner = createArchivePublicationOwner({ getArchiveCenter: () => center });
  const source = path.join(root, 'source.xlsx');
  const target = path.join(root, 'target.xlsx');
  const sourceBytes = Buffer.from('原始产物');
  const targetBytes = Buffer.from('正式输出');
  const hash = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
  fs.writeFileSync(source, sourceBytes);
  const isNewAccount = producer.moduleId === 'new-account';
  const sourceOperation = isNewAccount ? 'new-account:save-as' : producer.taskKey;
  // 复用真实 producer 的 FilePlan role/sourceOperation，不能统一改成测试方便的 input/output。
  const plan = normalizeFilePlanV1({ version: 1, allocation: 'eager',
    inputs: isNewAccount ? [{ filePath: source, role: 'new-account-source-artifact', sourceOperation }] : [],
    outputs: [{ filePath: target, role: isNewAccount ? 'new-account-save-as-output' : 'output', sourceOperation }]
  });
  const taskRun = (await service.beginTaskRun({ ...producer,
    taskRunId: 'producer-task', parentRunId: 'producer-parent', operationKey: 'producer-operation'
  })).taskRun;
  const reserved = await service.reserveFileTaskBatch({ taskRun,
    manifest: artifactManifestFromFilePlan(plan), moduleCode: 'TEST', moduleName: '测试' });
  assert.equal(reserved.ok, true);
  const context = { batchId: reserved.batchId, ...Object.fromEntries(
    ['batchNumber', 'taskRunId', 'taskKey', 'moduleId', 'parentRunId', 'operationKey']
      .map((key) => [key, reserved.batch[key]])
  ) };
  await service.startFileTask(taskRun.taskRunId, reserved.batchId);
  fs.writeFileSync(target, targetBytes);
  const settled = await service.settleManifestArtifacts({ batchContext: context,
    files: [...plan.inputs, ...plan.outputs].map((file) => ({ artifactKey: file.artifactKey })) });
  assert.equal(settled.ok, true);
  assert.equal((await service.finishFileTask(taskRun.taskRunId, reserved.batchId, { taskStatus: 'succeeded' })).ok, true);
  const record = { taskId: 'producer-publication', journalPath: path.join(root, 'journal.json'),
    discoveryState: 'committed', journalStatus: 'committed', indexEntry: { batchContext: context },
    journal: { batchContext: context,
      archiveInputFiles: isNewAccount ? [{ filePath: source, sourceOperation,
        expectedSha256: hash(sourceBytes), expectedSizeBytes: sourceBytes.length }] : [],
      entries: [{ targetPath: target, metadata: { fileName: path.basename(target) },
        generated: { size: targetBytes.length, sha256: hash(targetBytes) } }] }
  };
  return { db, service, owner, record, context };
}

for (const producer of PRODUCERS) test(`${producer.taskKey} 的真实 manifest 支持 stage/finalize，错角色/来源/hash/终态保留`, async (t) => {
  const { db, service, owner, record, context } = await fixture(t, producer);
  const identity = await owner.identify(record);
  assert.equal(identity.ownerId, 'archive-publication');
  const request = { ownerId: owner.id, taskIds: [record.taskId], acknowledgedCommittedTaskIds: [record.taskId] };
  assert.equal((await owner.authorize(record, { ownerId: owner.id }, identity)).permission, 'observe-committed');
  assert.equal((await owner.authorize(record, { ...request, deferCommittedFinalization: true }, identity)).permission, 'ack-stage');
  assert.equal((await owner.authorize(record, request, identity)).permission, 'ack-finalize');

  async function expectDeferred(candidate = record) {
    const decision = await owner.authorize(candidate, request, identity);
    assert.equal(decision.disposition, 'defer');
    assert.equal(decision.permission, null);
    assert.equal(decision.code, 'TOOLBOX_ARCHIVE_HANDOFF_INCOMPLETE');
  }
  const artifacts = service.repository.getBatchDetail(context.batchId).artifacts;
  for (const artifact of artifacts) {
    db.prepare('UPDATE archive_artifacts SET role=? WHERE id=?').run('wrong-role', artifact.id);
    await expectDeferred();
    db.prepare('UPDATE archive_artifacts SET role=? WHERE id=?').run(artifact.role, artifact.id);
    db.prepare('UPDATE archive_artifacts SET source_operation=? WHERE id=?').run('wrong:operation', artifact.id);
    await expectDeferred();
    db.prepare('UPDATE archive_artifacts SET source_operation=? WHERE id=?').run(artifact.sourceOperation, artifact.id);
  }
  const changedOutput = structuredClone(record);
  changedOutput.journal.entries[0].generated.sha256 = '0'.repeat(64);
  await expectDeferred(changedOutput);
  if (record.journal.archiveInputFiles.length) {
    const changedInput = structuredClone(record);
    changedInput.journal.archiveInputFiles[0].expectedSha256 = '0'.repeat(64);
    await expectDeferred(changedInput);
  }
  db.prepare("UPDATE archive_task_runs SET status='failed' WHERE task_run_id=?").run(context.taskRunId);
  await expectDeferred();
  db.prepare("UPDATE archive_task_runs SET status='succeeded' WHERE task_run_id=?").run(context.taskRunId);
  assert.equal((await owner.authorize(record, request, identity)).permission, 'ack-finalize');
});
