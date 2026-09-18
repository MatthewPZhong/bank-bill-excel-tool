'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { createArchiveService } = require('../../../src/main-process/archive-center/archive-service');
const { createArchiveCenterController } = require('../../../src/main-process/archive-center/controller');
const { createArchiveOutboxStore } = require('../../../src/main-process/archive-center/outbox-store');
const { createTaskLifecycle } = require('../../../src/main-process/archive-center/task-lifecycle');
const { createTaskPolicyRegistry } = require('../../../src/main-process/archive-center/task-policy-registry');
const { normalizeFilePlanV1, artifactManifestFromFilePlan } = require('../../../src/main-process/archive-center/file-plan');
const { captureStagedInputEvidenceAsync } = require('../../../src/main-process/position-reconciliation/input-staging');
const { createPositionReconciliationStore } = require('../../../src/main-process/position-reconciliation/store');
const { positionOutputFilePlanEvidence, positionFilePlanSettlementFiles } = require('../../../src/main-process/position-reconciliation/archive-file-plan-evidence');
const { createPositionOwnedDeleteSourceResolver, positionDeleteSourceReferences } = require('../../../src/main-process/archive-center/position-owned-delete-sources');
const { createPositionReportDeleteProtection } = require('../../../src/main-process/position-reconciliation/archive-report-delete-protection');

async function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'position-report-evidence-'));
  const userDataPath = path.join(directory, 'user-data');
  const reportPath = path.join(userDataPath, 'run-data/position-reconciliation/import-staging/report-job/anomaly-report/平盘来源异常数据_report-job.xlsx');
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, 'synthetic pre-generated report');
  const evidence = await captureStagedInputEvidenceAsync(reportPath);
  const side = createPositionReconciliationStore(userDataPath, {
    initialCheckpoint: { identity: 'report-db', generation: 0, token: 'report-bootstrap' }
  });
  const state = { blocked: false, expectedCheckpoint: side.persistenceCheckpoint() };
  const raw = { filePath: reportPath, role: 'output', sourceOperation: 'position-reconciliation:source:prepare-import',
    ...positionOutputFilePlanEvidence({ artifactKey: 'source-import-anomaly-report', sourceSnapshot: evidence.stagedSnapshot,
      expectedSha256: evidence.stagedSha256, sizeBytes: evidence.stagedSizeBytes }) };
  const plan = normalizeFilePlanV1({ version: 1, allocation: 'eager', inputs: [], outputs: [raw] });
  let db;
  let service;
  let controller;
  async function open() {
    db = new DatabaseSync(path.join(directory, 'archive.sqlite'));
    service = createArchiveService({ database: db, rootDir: path.join(directory, 'archive'),
      fsImpl: { ...fs, promises: fs.promises, unlinkSync(filePath) {
        if (state.blocked && filePath === reportPath) throw Object.assign(new Error('报告被占用'), { code: 'EBUSY' });
        fs.unlinkSync(filePath);
      } } });
    service.resolveOwnedDeleteSources = createPositionOwnedDeleteSourceResolver({ userDataPath,
      protectedPathProvider: async ({ batch, artifacts }) => positionDeleteSourceReferences(service.repository, batch.id, artifacts),
      reportReferenceProvider: createPositionReportDeleteProtection({ userDataPath, getExpectedCheckpoint: () => state.expectedCheckpoint }) });
    controller = createArchiveCenterController({ service, database: { getSetting: () => null, setSetting() {} },
      outboxStore: createArchiveOutboxStore(path.join(directory, 'outbox')) });
    assert.equal((await controller.initialize()).ok, true);
  }
  await open();
  t.after(async () => {
    await service.pauseBackgroundMaterialization(); db.close(); side.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return { directory, userDataPath, reportPath, evidence, side, state, raw, plan,
    get db() { return db; }, get service() { return service; }, get controller() { return controller; },
    async restart() { await service.pauseBackgroundMaterialization(); db.close(); await open(); },
    async archive(key = 'report-task', options = {}) {
      const channel = 'position-reconciliation:source:prepare-import';
      const lifecycle = createTaskLifecycle({ archiveService: service,
        businessOperationRegistry: { begin: () => ({ accepted: true, token: key }), end() {} },
        flowResolver: { resolve: async () => ({ parentRunId: 'report-parent', source: 'new', identity: null }),
          bind: async () => [], persistBindIntent: async () => ({ ok: true }) },
        operationTracker: { appendOperationFiles: async () => ({ ok: true }) },
        persistTerminalIntent: (payload) => controller.persistTaskTerminalIntent(payload) });
      const operation = lifecycle.runFileTask({ policy: createTaskPolicyRegistry().require(channel), meta: { channel },
        taskRunId: key, operationKey: `position:${key}:${channel}`, filePlanResolver: () => plan,
        ...(options.interrupted ? { beforeTerminalSettlement: async () => { throw new Error('模拟settle前退出'); } } : {}),
        execute: async (_context, controls) => {
          if (!options.interrupted) await controls.settleArtifacts({ files: positionFilePlanSettlementFiles(plan) });
          return { status: 'ok' };
        } });
      if (options.interrupted) await assert.rejects(operation, /模拟settle前退出/);
      else assert.equal((await operation).status, 'ok');
      return service.repository.getBatchByOperationKey('position-reconciliation-process', `position:${key}:${channel}`);
    }
  };
}

for (const failure of ['attempt-recording', 'settle-before-exit']) {
  test(`报告 ${failure} 后原SHA和target身份已在reserve耐久保存，重启可按原owner删除`, async (t) => {
    const f = await fixture(t);
    if (failure === 'attempt-recording') f.db.exec(`CREATE TEMP TRIGGER reject_attempt BEFORE UPDATE OF attempt_count ON archive_artifacts
      BEGIN SELECT RAISE(ABORT,'模拟attempt落库失败'); END`);
    const batch = await f.archive('report-failure', { interrupted: failure === 'settle-before-exit' });
    const artifact = f.service.repository.listArtifacts(batch.id)[0];
    assert.equal(artifact.blob, null);
    assert.equal(artifact.metadata.expectedSha256, f.evidence.stagedSha256);
    assert.deepEqual(artifact.metadata.targetSnapshot.snapshot, f.evidence.stagedSnapshot);
    assert.equal(artifact.metadata.preGeneratedOutput.producerArtifactKey, 'source-import-anomaly-report');
    await f.restart();
    const ready = await f.controller.prepareDeleteBatch(batch.id);
    assert.equal(ready.ok, true, JSON.stringify(ready));
    assert.equal((await f.controller.deleteBatch(batch.id, ready.confirmationToken)).fullyDeleted, true);
    assert.equal(fs.existsSync(f.reportPath), false);
  });
}

test('报告reserve写入失败原子回滚发号，旧普通output不能因重试获得报告归属', async (t) => {
  const f = await fixture(t);
  const repo = f.service.repository;
  const taskRun = repo.beginTaskRun({ taskRunId: 'reserve-report', taskKey: f.raw.sourceOperation,
    moduleId: 'position-reconciliation-process', operationKey: 'reserve-report', parentRunId: 'report-parent' }).taskRun;
  const payload = { taskRun, manifest: artifactManifestFromFilePlan(f.plan) };
  f.db.exec(`CREATE TEMP TRIGGER reject_report BEFORE INSERT ON archive_artifacts
    WHEN json_extract(NEW.metadata_json,'$.preGeneratedOutput.kind')='position-anomaly-report'
    BEGIN SELECT RAISE(ABORT,'报告证据写入失败'); END`);
  assert.throws(() => repo.reserveFileTaskBatch(payload), /报告证据写入失败/);
  for (const table of ['archive_batches', 'archive_artifacts', 'archive_operation_issuances', 'archive_daily_sequences']) {
    assert.equal(f.db.prepare(`SELECT COUNT(*) count FROM ${table}`).get().count, 0);
  }
  f.db.exec('DROP TRIGGER reject_report');
  const { preGeneratedOutput: _unused, ...ordinaryOutput } = f.raw;
  const old = normalizeFilePlanV1({ version: 1, allocation: 'eager', inputs: [], outputs: [ordinaryOutput] });
  assert.equal(artifactManifestFromFilePlan(old).identity, payload.manifest.identity);
  const reserved = repo.reserveFileTaskBatch({ taskRun, manifest: artifactManifestFromFilePlan(old) });
  assert.equal(repo.reserveFileTaskBatch(payload).created, false);
  const artifact = repo.listArtifacts(reserved.batch.id)[0];
  assert.equal(artifact.metadata.preGeneratedOutput, undefined);
  await assert.rejects(f.service.resolveOwnedDeleteSources(reserved.batch, [artifact]), { code: 'ARCHIVE_DELETE_SOURCE_OWNER_UNKNOWN' });
});

test('报告证据拒绝错producer、原snapshot、大小及普通预分配输出，Repository同样拒绝绕normalizer', async (t) => {
  const f = await fixture(t);
  const taskRun = f.service.repository.beginTaskRun({ taskRunId: 'invalid-report', taskKey: f.raw.sourceOperation,
    moduleId: 'position-reconciliation-process', operationKey: 'invalid-report', parentRunId: 'report-parent' }).taskRun;
  for (const patch of [
    { producerArtifactKey: 'other-key' }, { producerArtifactKey: 'source-import-anomaly-report:file-0' },
    { sourceSnapshot: { ...f.evidence.stagedSnapshot, ino: '99999999' } },
    { expectedSizeBytes: f.evidence.stagedSizeBytes + 1 }, { expectedSha256: undefined }
  ]) {
    const preGeneratedOutput = { ...f.raw.preGeneratedOutput, ...patch };
    assert.throws(() => normalizeFilePlanV1({ version: 1, allocation: 'eager', inputs: [],
      outputs: [{ ...f.raw, preGeneratedOutput }] }), { code: 'ARCHIVE_FILE_PLAN_INVALID' });
    assert.throws(() => f.service.repository.reserveFileTaskBatch({ taskRun,
      manifest: { ...artifactManifestFromFilePlan(f.plan), outputs: [{ ...f.plan.outputs[0], preGeneratedOutput }] } }), /完整证据/);
  }
  assert.throws(() => normalizeFilePlanV1({ version: 1, allocation: 'eager', inputs: [],
    outputs: [{ ...f.raw, sourceOperation: 'position-reconciliation:run:export' }] }), { code: 'ARCHIVE_FILE_PLAN_INVALID' });
});

for (const conflict of ['replacement', 'producer-key', 'missing-database', 'foreign-checkpoint', 'broken-schema']) {
  test(`报告 ${conflict} 不得成为无引用或可清理来源`, async (t) => {
    const f = await fixture(t);
    const batch = await f.archive();
    if (conflict === 'replacement') {
      fs.copyFileSync(f.reportPath, `${f.reportPath}.replacement`);
      fs.renameSync(`${f.reportPath}.replacement`, f.reportPath);
    } else if (conflict === 'producer-key') {
      const artifact = f.service.repository.listArtifacts(batch.id)[0];
      artifact.metadata.preGeneratedOutput.producerArtifactKey = 'source-import-anomaly-report:file-0';
      f.db.prepare('UPDATE archive_artifacts SET metadata_json=? WHERE id=?').run(JSON.stringify(artifact.metadata), artifact.id);
    } else if (conflict === 'missing-database') {
      const dbPath = f.side.dbPath; f.side.close(); fs.renameSync(dbPath, `${dbPath}.old`);
    } else if (conflict === 'foreign-checkpoint') {
      f.state.expectedCheckpoint = { ...f.state.expectedCheckpoint, identity: 'other-side-db' };
    } else f.side.db.exec('DROP TABLE position_run_filtered_sources');
    const result = await f.controller.prepareDeleteBatch(batch.id);
    assert.equal(result.code, conflict === 'replacement' ? 'ARCHIVE_DELETE_SOURCE_CHANGED'
      : conflict === 'producer-key' ? 'ARCHIVE_DELETE_SOURCE_OWNER_UNKNOWN' : 'ARCHIVE_DELETE_SOURCE_REFERENCES_UNAVAILABLE');
    assert.equal(fs.existsSync(f.reportPath), true);
    assert.equal(f.service.repository.listCleanupJobs().length, 0);
    assert.ok(f.service.repository.getBatch(batch.id));
  });
}

test('报告job保留原operation/双artifact身份，metadata删除后新增冻结引用及不可读侧库仍阻止重试', async (t) => {
  const f = await fixture(t);
  const batch = await f.archive();
  const prepared = await f.controller.prepareDeleteBatch(batch.id);
  assert.equal(prepared.ok, true, JSON.stringify(prepared));
  f.state.blocked = true;
  const pending = await f.controller.deleteBatch(batch.id, prepared.confirmationToken);
  assert.equal(pending.fullyDeleted, false);
  assert.equal(f.service.repository.getBatch(batch.id), null);
  const job = f.service.repository.getCleanupJob(pending.cleanupJobId);
  const target = job.plan.items.find((item) => item.sourceArtifactId);
  assert.equal(target.sourceOwnerProof.operationKey, batch.operationKey);
  assert.equal(target.sourceOwnerProof.artifactKey, f.plan.outputs[0].artifactKey);
  assert.equal(target.sourceOwnerProof.producerArtifactKey, 'source-import-anomaly-report');
  // 故意构造悬挂冻结引用，证明查询不会通过INNER JOIN把无法验证的原引用吞掉。
  f.side.db.exec('PRAGMA foreign_keys=OFF');
  f.side.db.prepare(`INSERT INTO position_run_filtered_sources(run_id,filtered_source_id,report_key,report_artifact_key,
    archive_operation_key,report_sha256,report_size_bytes,source_revision,integrity_hash) VALUES(1,1,?,?,?,?,?,1,'synthetic')`)
    .run('report-job:source-import-anomaly-report', 'source-import-anomaly-report', batch.operationKey,
      f.evidence.stagedSha256, f.evidence.stagedSizeBytes);
  f.state.blocked = false;
  await f.restart();
  const held = await f.controller.retryDeleteCleanupJob(pending.cleanupJobId);
  assert.equal(held.fullyDeleted, false);
  assert.ok(held.failures.some((item) => item.code === 'ARCHIVE_DELETE_SOURCE_HELD'));
  assert.equal(fs.existsSync(f.reportPath), true);
  const checkpoint = f.state.expectedCheckpoint;
  f.state.expectedCheckpoint = null;
  const unavailable = await f.controller.retryDeleteCleanupJob(pending.cleanupJobId);
  assert.ok(unavailable.failures.some((item) => item.code === 'ARCHIVE_DELETE_SOURCE_REFERENCES_UNAVAILABLE'));
  f.state.expectedCheckpoint = checkpoint;
  f.side.db.exec('DELETE FROM position_run_filtered_sources');
  assert.equal((await f.controller.retryDeleteCleanupJob(pending.cleanupJobId)).fullyDeleted, true);
  assert.equal(fs.existsSync(f.reportPath), false);
  assert.equal(f.service.repository.listCleanupJobs().length, 0);
});
