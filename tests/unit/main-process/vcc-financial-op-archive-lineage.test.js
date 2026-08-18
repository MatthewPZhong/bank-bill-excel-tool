'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const {
  createArchiveRepository
} = require('../../../src/backend/database/archive-repository');
const {
  createArchiveService
} = require('../../../src/main-process/archive-center/archive-service');
const {
  createArchiveCenterController
} = require('../../../src/main-process/archive-center/controller');
const {
  createArchiveOutboxStore
} = require('../../../src/main-process/archive-center/outbox-store');
const {
  artifactManifestFromFilePlan,
  normalizeFilePlanV1
} = require('../../../src/main-process/archive-center/file-plan');
const {
  ensureVccFinancialOpTablesSupport
} = require('../../../src/backend/vcc-financial-op-db/migrations');
const vccRepository = require('../../../src/backend/vcc-financial-op-db/repository');
const {
  buildVccImportArchiveHandoffFiles,
  listRecoverableVccImportArchiveBatchIds,
  recoverVccImportArchiveTasks,
  reconcileVccImportArchiveLineageAtStartup,
  reconcileVccImportArchiveLineage
} = require('../../../src/main-process/vcc-financial-op-archive-lineage');

const SHA_A = 'a'.repeat(64);

function fixture(t) {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  ensureVccFinancialOpTablesSupport(db);
  const archiveRepository = createArchiveRepository(db, {
    now: () => new Date('2026-08-16T10:00:00.000Z')
  });
  archiveRepository.ensureSchema();
  t.after(() => db.close());
  return { db, archiveRepository };
}

function seedSource(db) {
  vccRepository.createImportBatch(db, {
    id: 'task-run-vcc-import',
    targetMonth: '2026-07',
    fileCount: 1
  });
  const recordId = vccRepository.createImportRecord(db, {
    batchId: 'task-run-vcc-import',
    targetMonth: '2026-07',
    sourceType: 'recharge_refund',
    sourceFiles: ['source.xlsx']
  });
  const sourceId = vccRepository.createImportSource(db, recordId, {
    sourceOrdinal: 1,
    fileName: 'source.xlsx',
    sha256: SHA_A,
    sizeBytes: 123
  });
  const effectiveId = Number(db.prepare(`
    INSERT INTO vcc_fin_op_effective_rows (
      source_type, idempotency_key_raw, idempotency_key, content_hash,
      target_month, subject, stat_currency, signed_amount,
      source_file, sheet_name, source_row, raw_json, import_record_id, import_source_id
    ) VALUES (
      'recharge_refund', 'K-1', 'K-1', ?, '2026-07', 'PPHK', 'USD', '10',
      'source.xlsx', 'sheet1', 2, '["K-1"]', ?, ?
    )
  `).run('b'.repeat(64), recordId, sourceId).lastInsertRowid);
  db.prepare(`
    INSERT INTO vcc_fin_op_effective_raw_fallback (
      effective_row_id, import_source_id, raw_contract_version, raw_json
    ) VALUES (?, ?, 1, '["K-1"]')
  `).run(effectiveId, sourceId);
  vccRepository.finishImportRecord(db, recordId, {
    status: 'success', rawCount: 1, insertedCount: 1
  });
  vccRepository.finishImportBatch(db, 'task-run-vcc-import', 'success');
  return { recordId, sourceId, effectiveId };
}

function seedReadyArtifact(
  archiveRepository,
  { recordId, sourceId },
  { taskRunId = 'task-run-vcc-import', suffix = 'exact' } = {}
) {
  const batch = archiveRepository.createBatch({
    moduleId: 'vcc-financial-op',
    moduleCode: 'VCCFINOP',
    moduleName: 'VCC财务OP校验',
    operationKey: `vcc-import-task-run-${suffix}`,
    taskKey: 'vccFinancialOp:import:apply',
    taskRunId,
    parentRunId: 'vcc-import-parent',
    localDate: '2026-08-16',
    retentionUntil: '2026-11-14'
  }).batch;
  archiveRepository.db.prepare(`
    UPDATE archive_batches
    SET task_key = 'vccFinancialOp:import:apply', task_run_id = ?,
        parent_run_id = 'vcc-import-parent', task_status = 'succeeded'
    WHERE id = ?
  `).run(taskRunId, batch.id);
  const artifact = archiveRepository.addArtifact(batch.id, {
    artifactKey: 'input:source.xlsx',
    direction: 'input',
    role: 'input',
    sourceOperation: 'vccFinancialOp:import:apply',
    originalName: 'source.xlsx',
    sourcePath: '/tmp/source.xlsx',
    metadata: {
      vccImportBatchId: 'task-run-vcc-import',
      vccImportRecordId: recordId,
      vccImportSourceId: sourceId,
      vccSourceType: 'recharge_refund',
      vccSourceOrdinal: 1,
      expectedSha256: SHA_A,
      expectedSizeBytes: 123
    }
  });
  archiveRepository.startArtifactAttempt(artifact.id);
  const ready = archiveRepository.completeArtifact(artifact.id, {
    sha256: SHA_A,
    sizeBytes: 123,
    relativePath: `blobs/sha256/aa/${SHA_A}`
  }).artifact;
  archiveRepository.db.prepare(`
    UPDATE archive_batches SET task_status = 'succeeded' WHERE id = ?
  `).run(batch.id);
  return ready;
}

test('ready artifact 精确绑定后清 fallback、建立不可绕过业务锁，删除有效行后自动释放', (t) => {
  const { db, archiveRepository } = fixture(t);
  const source = seedSource(db);
  const artifact = seedReadyArtifact(archiveRepository, source);

  const first = reconcileVccImportArchiveLineage({ db, archiveRepository });
  assert.equal(first.bound, 1);
  assert.equal(db.prepare(`
    SELECT archive_state, archive_artifact_id FROM vcc_fin_op_import_sources WHERE id = ?
  `).get(source.sourceId).archive_state, 'ready');
  assert.equal(db.prepare(`
    SELECT archive_artifact_id FROM vcc_fin_op_import_sources WHERE id = ?
  `).get(source.sourceId).archive_artifact_id, artifact.id);
  assert.equal(db.prepare(`
    SELECT COUNT(*) AS count FROM vcc_fin_op_effective_raw_fallback
  `).get().count, 0);
  assert.equal(archiveRepository.listArtifactHolds(artifact.id).length, 1);
  assert.equal(archiveRepository.deleteBatch(artifact.batchId, { allowLocked: true }).status, 'business-held');

  db.prepare('DELETE FROM vcc_fin_op_effective_rows WHERE id = ?').run(source.effectiveId);
  const second = reconcileVccImportArchiveLineage({ db, archiveRepository });
  assert.equal(second.released, 1);
  assert.equal(archiveRepository.listArtifactHolds(artifact.id).length, 0);

  assert.equal(
    archiveRepository.deleteBatch(artifact.batchId, { allowLocked: true }).status,
    'deleted'
  );
  reconcileVccImportArchiveLineage({ db, archiveRepository });
  assert.deepEqual({ ...db.prepare(`
    SELECT archive_artifact_id, archive_state, last_error_code
    FROM vcc_fin_op_import_sources WHERE id = ?
  `).get(source.sourceId) }, {
    archive_artifact_id: artifact.id,
    archive_state: 'unavailable',
    last_error_code: 'archive-artifact-unavailable'
  });
  assert.equal(db.prepare(`
    SELECT archive_state FROM vcc_fin_op_import_records WHERE id = ?
  `).get(source.recordId).archive_state, 'unavailable');
});

test('artifact SHA 不符时绑定失败且 fallback 保留', (t) => {
  const { db, archiveRepository } = fixture(t);
  const source = seedSource(db);
  const artifact = seedReadyArtifact(archiveRepository, source);
  db.prepare('UPDATE archive_blobs SET sha256 = ? WHERE id = ?')
    .run('c'.repeat(64), artifact.blob.id);

  const result = reconcileVccImportArchiveLineage({ db, archiveRepository });
  assert.equal(result.failed, 1);
  const stored = db.prepare(`
    SELECT archive_state, last_error_code FROM vcc_fin_op_import_sources WHERE id = ?
  `).get(source.sourceId);
  assert.equal(stored.archive_state, 'failed');
  assert.equal(stored.last_error_code, 'archive-lineage-mismatch');
  assert.equal(db.prepare(`
    SELECT COUNT(*) AS count FROM vcc_fin_op_effective_raw_fallback
  `).get().count, 1);
  assert.equal(archiveRepository.listArtifactHolds(artifact.id).length, 0);
});

test('v1 source 的 exact artifactId 缺失或 owner 错误时不改绑相似 metadata artifact', (t) => {
  {
    const { db, archiveRepository } = fixture(t);
    const source = seedSource(db);
    const matching = seedReadyArtifact(archiveRepository, source, { suffix: 'missing' });
    db.exec('PRAGMA foreign_keys = OFF');
    db.prepare(`
      UPDATE vcc_fin_op_import_sources
      SET archive_artifact_id = 999999, archive_state = 'ready'
      WHERE id = ?
    `).run(source.sourceId);
    db.exec('PRAGMA foreign_keys = ON');

    const first = reconcileVccImportArchiveLineage({ db, archiveRepository });
    assert.equal(first.pending, 1);
    const storedAfterFirst = db.prepare(`
      SELECT archive_artifact_id, archive_state FROM vcc_fin_op_import_sources WHERE id = ?
    `).get(source.sourceId);
    assert.equal(storedAfterFirst.archive_artifact_id, 999999);
    assert.equal(storedAfterFirst.archive_state, 'unavailable');
    assert.equal(db.prepare(`
      SELECT COUNT(*) AS count FROM vcc_fin_op_effective_raw_fallback
      WHERE import_source_id = ?
    `).get(source.sourceId).count, 1);
    assert.equal(archiveRepository.listArtifactHolds(matching.id).length, 0);

    const second = reconcileVccImportArchiveLineage({ db, archiveRepository });
    assert.equal(second.pending, 1);
    const storedAfterSecond = db.prepare(`
      SELECT archive_artifact_id, archive_state FROM vcc_fin_op_import_sources WHERE id = ?
    `).get(source.sourceId);
    assert.equal(storedAfterSecond.archive_artifact_id, 999999);
    assert.equal(storedAfterSecond.archive_state, 'unavailable');
    assert.equal(db.prepare(`
      SELECT COUNT(*) AS count FROM vcc_fin_op_effective_raw_fallback
      WHERE import_source_id = ?
    `).get(source.sourceId).count, 1);
    assert.equal(archiveRepository.listArtifactHolds(matching.id).length, 0);
  }

  {
    const { db, archiveRepository } = fixture(t);
    const source = seedSource(db);
    const matching = seedReadyArtifact(archiveRepository, source, { suffix: 'matching' });
    const wrongOwner = seedReadyArtifact(archiveRepository, source, {
      taskRunId: 'another-vcc-task-run',
      suffix: 'wrong-owner'
    });
    db.prepare(`
      UPDATE vcc_fin_op_import_sources
      SET archive_artifact_id = ?, archive_state = 'ready'
      WHERE id = ?
    `).run(wrongOwner.id, source.sourceId);

    const result = reconcileVccImportArchiveLineage({ db, archiveRepository });
    assert.equal(result.failed, 1);
    const stored = db.prepare(`
      SELECT archive_artifact_id, archive_state, last_error_code
      FROM vcc_fin_op_import_sources WHERE id = ?
    `).get(source.sourceId);
    assert.equal(Number(stored.archive_artifact_id), wrongOwner.id);
    assert.equal(stored.archive_state, 'failed');
    assert.equal(stored.last_error_code, 'archive-lineage-mismatch');
    assert.equal(archiveRepository.listArtifactHolds(matching.id).length, 0);
  }
});

test('业务提交 artifactId 后崩溃，启动先终结原 FileTask 再补 exact hold', async (t) => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vcc-import-handoff-recovery-'));
  const db = new DatabaseSync(path.join(rootDir, 'tool-data.sqlite'));
  db.exec('PRAGMA foreign_keys = ON');
  ensureVccFinancialOpTablesSupport(db);
  const archiveRepository = createArchiveRepository(db, {
    now: () => new Date('2026-08-16T10:00:00.000Z')
  });
  archiveRepository.ensureSchema();
  const archiveService = createArchiveService({
    database: db,
    rootDir: path.join(rootDir, 'archive')
  });
  const outboxStore = createArchiveOutboxStore(path.join(rootDir, 'outbox'));
  const settings = new Map();
  const database = {
    getSetting: (key) => settings.get(key) || null,
    setSetting: (key, value) => settings.set(key, value),
    listTemplates: () => []
  };
  t.after(() => {
    db.close();
    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  await archiveService.initialize();
  const firstPath = path.join(rootDir, 'first.xlsx');
  const secondPath = path.join(rootDir, 'second.xlsx');
  fs.writeFileSync(firstPath, 'first-vcc-source');
  fs.writeFileSync(secondPath, 'second-vcc-source');
  const files = [firstPath, secondPath].map((filePath) => ({
    filePath,
    sourceType: 'recharge_refund'
  }));
  const taskRun = (await archiveService.beginTaskRun({
    moduleId: 'vcc-financial-op',
    taskKey: 'vccFinancialOp:import:apply',
    taskRunId: 'vcc-crash-after-business-terminal',
    operationKey: 'vccFinancialOp:import:apply:vcc-crash-after-business-terminal',
    parentRunId: 'vcc-import-flow'
  })).taskRun;
  const filePlan = normalizeFilePlanV1({
    version: 1,
    allocation: 'eager',
    inputs: files.map((file) => ({
      filePath: file.filePath,
      role: 'input',
      sourceOperation: 'vccFinancialOp:import:apply'
    })),
    outputs: []
  });
  const reserved = await archiveService.reserveFileTaskBatch({
    taskRun,
    manifest: artifactManifestFromFilePlan(filePlan),
    moduleCode: 'VCCFINOP',
    moduleName: 'VCC财务OP校验'
  });
  await archiveService.startFileTask(taskRun.taskRunId, reserved.batchId);
  const batchContext = {
    batchId: reserved.batch.id,
    batchNumber: reserved.batch.batchNumber,
    taskRunId: reserved.batch.taskRunId,
    taskKey: reserved.batch.taskKey,
    moduleId: reserved.batch.moduleId,
    parentRunId: reserved.batch.parentRunId,
    operationKey: reserved.batch.operationKey
  };
  const preparedHandoff = await buildVccImportArchiveHandoffFiles({ files }, batchContext);
  const settled = await archiveService.settleManifestArtifacts({
    batchContext,
    files: filePlan.inputs.map((item, index) => ({
      artifactKey: item.artifactKey,
      expectedSha256: preparedHandoff[index].expectedSha256,
      expectedSizeBytes: preparedHandoff[index].expectedSizeBytes
    }))
  });
  assert.equal(settled.ok, true);
  assert.equal(settled.durable, true);
  const handoffFiles = preparedHandoff.map((file, index) => ({
    ...file,
    archiveArtifactId: settled.results[index].artifact.id
  }));
  for (let index = 0; index < handoffFiles.length; index += 1) {
    const handoff = handoffFiles[index];
    const artifact = archiveRepository.getArtifact(handoff.archiveArtifactId);
    assert.equal(artifact.batchId, batchContext.batchId);
    assert.equal(artifact.sourceOperation, 'vccFinancialOp:import:apply');
    assert.equal(artifact.blob.sha256, handoff.expectedSha256);
    assert.equal(artifact.blob.sizeBytes, handoff.expectedSizeBytes);
  }

  vccRepository.createImportBatch(db, {
    id: batchContext.taskRunId,
    targetMonth: '2026-07',
    fileCount: handoffFiles.length
  });
  const recordId = vccRepository.createImportRecord(db, {
    batchId: batchContext.taskRunId,
    targetMonth: '2026-07',
    sourceType: 'recharge_refund',
    sourceFiles: handoffFiles.map((file) => file.originalName)
  });
  const sourceIds = handoffFiles.map((file, index) => vccRepository.createImportSource(db, recordId, {
    sourceOrdinal: index + 1,
    fileName: file.originalName,
    sha256: file.expectedSha256,
    sizeBytes: file.expectedSizeBytes,
    archiveArtifactId: file.archiveArtifactId
  }));
  sourceIds.forEach((sourceId, index) => {
    db.prepare(`
      INSERT INTO vcc_fin_op_effective_rows (
        source_type, idempotency_key_raw, idempotency_key, content_hash,
        target_month, subject, stat_currency, signed_amount,
        source_file, sheet_name, source_row, raw_json, import_record_id, import_source_id
      ) VALUES (
        'recharge_refund', ?, ?, ?, '2026-07', 'PPHK', 'USD', '10',
        ?, 'sheet1', 2, ?, ?, ?
      )
    `).run(
      `CRASH-${index + 1}`,
      `CRASH-${index + 1}`,
      String(index + 1).repeat(64),
      handoffFiles[index].originalName,
      JSON.stringify([`CRASH-${index + 1}`]),
      recordId,
      sourceId
    );
  });
  vccRepository.finishImportRecord(db, recordId, {
    status: 'success', rawCount: 2, insertedCount: 2
  });
  vccRepository.finishImportBatch(db, batchContext.taskRunId, 'success');
  assert.deepEqual(db.prepare(`
    SELECT archive_artifact_id FROM vcc_fin_op_import_sources ORDER BY source_ordinal
  `).all().map((row) => Number(row.archive_artifact_id)), handoffFiles.map((file) => file.archiveArtifactId));
  assert.equal(archiveRepository.listArtifactHolds(handoffFiles[0].archiveArtifactId).length, 0);

  let startupController;
  const createStartupController = () => {
    startupController = createArchiveCenterController({
      database,
      service: archiveService,
      outboxStore,
      recoverInterruptedTaskOwners: [{
        ownerName: 'VCC import terminal',
        recover: () => recoverVccImportArchiveTasks({
          db,
          archiveRepository,
          archiveCenter: startupController
        })
      }],
      postOutboxStartupHooks: [{
        hookName: 'VCC lineage/hold reconcile',
        run: () => reconcileVccImportArchiveLineageAtStartup({ db, archiveRepository })
      }],
      getProtectedInterruptedTaskBatchIds: () => ({
        batchIds: listRecoverableVccImportArchiveBatchIds({ db, archiveRepository }),
        sweepUnsafe: false
      })
    });
    return startupController;
  };

  await createStartupController().initialize();
  assert.equal(archiveRepository.getBatch(reserved.batchId).taskStatus, 'succeeded');
  assert.deepEqual(db.prepare(`
    SELECT id, archive_state, archive_artifact_id
    FROM vcc_fin_op_import_sources
    ORDER BY source_ordinal
  `).all().map((row) => ({
    id: Number(row.id),
    archiveState: row.archive_state,
    hasArtifact: Number.isSafeInteger(Number(row.archive_artifact_id))
  })), sourceIds.map((id) => ({ id, archiveState: 'ready', hasArtifact: true })));
  assert.equal(outboxStore.list().length, 0);
  for (const artifactId of handoffFiles.map((file) => file.archiveArtifactId)) {
    assert.equal(archiveRepository.listArtifactHolds(artifactId).length, 1);
  }

  const firstArtifactIds = db.prepare(`
    SELECT archive_artifact_id FROM vcc_fin_op_import_sources ORDER BY source_ordinal
  `).all().map((row) => Number(row.archive_artifact_id));
  await createStartupController().initialize();
  assert.equal(archiveRepository.getBatch(reserved.batchId).taskStatus, 'succeeded');
  assert.deepEqual(db.prepare(`
    SELECT archive_artifact_id FROM vcc_fin_op_import_sources ORDER BY source_ordinal
  `).all().map((row) => Number(row.archive_artifact_id)), firstArtifactIds);
  assert.equal(outboxStore.list().length, 0);
});
