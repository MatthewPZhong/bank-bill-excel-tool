'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const {
  createArchiveRepository
} = require('../../../src/backend/database/archive-repository');
const {
  parseArgs,
  run
} = require('../../../scripts/maintenance/archive-repair-split-directory-artifacts');

function sha(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function createFixture(t) {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-split-repair-'));
  const dbPath = path.join(rootDir, 'tool-data.sqlite');
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA foreign_keys = ON');
  const repository = createArchiveRepository(db, {
    now: () => new Date('2026-08-18T10:00:00.000Z')
  });
  repository.ensureSchema();
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));
  return { db, dbPath, repository, rootDir };
}

function addReadyArtifact(repository, batchId, payload, index) {
  const artifact = repository.addArtifact(batchId, payload);
  repository.startArtifactAttempt(artifact.id);
  const digest = sha(`${payload.artifactKey}:${batchId}`);
  const completed = repository.completeArtifact(artifact.id, {
    sha256: digest,
    sizeBytes: 100 + index,
    relativePath: `blobs/sha256/${digest.slice(0, 2)}/${digest}`
  }).artifact;
  return repository.completeMaterialization(completed.id, {
    storageMode: 'copy',
    storageRelativePath: `2026/08/13/${batchId}/${index}-${payload.originalName}`,
    safeFileName: `${index}-${payload.originalName}`,
    artifactOrder: index
  }).artifact;
}

function seedRepairBatch(repository, db, rootDir, batchNumber) {
  const created = repository.createBatch({
    moduleId: 'toolbox',
    moduleCode: 'TOOLBOX',
    moduleName: '工具箱',
    operationKey: `repair-fixture:${batchNumber}`,
    taskKey: 'toolbox:split:export',
    taskRunId: `task-run:${batchNumber}`,
    parentRunId: `parent-run:${batchNumber}`,
    localDate: '2026-08-13'
  });
  const batchId = created.batch.id;
  db.prepare(`
    UPDATE archive_batches
    SET batch_number = ?, task_key = 'toolbox:split:export', task_status = 'succeeded'
    WHERE id = ?
  `).run(batchNumber, batchId);
  db.prepare(`
    UPDATE archive_operation_issuances SET batch_number = ? WHERE batch_id = ?
  `).run(batchNumber, batchId);

  const outputDir = path.join(rootDir, `${batchNumber}-outputs`);
  const input = addReadyArtifact(repository, batchId, {
    artifactKey: 'input:source.xlsx',
    direction: 'input',
    role: 'input',
    sourceOperation: 'toolbox:split:export',
    originalName: 'source.xlsx',
    sourcePath: path.join(rootDir, `${batchNumber}-source.xlsx`)
  }, 1);
  const outputA = addReadyArtifact(repository, batchId, {
    artifactKey: 'output:a.xlsx',
    direction: 'output',
    role: 'output',
    sourceOperation: 'toolbox:split:export',
    originalName: 'a.xlsx',
    sourcePath: path.join(outputDir, 'a.xlsx')
  }, 2);
  const outputB = addReadyArtifact(repository, batchId, {
    artifactKey: 'output:b.xlsx',
    direction: 'output',
    role: 'output',
    sourceOperation: 'toolbox:split:export',
    originalName: 'b.xlsx',
    sourcePath: path.join(outputDir, 'b.xlsx')
  }, 3);
  repository.addArtifactHold(input.id, {
    ownerModule: 'fixture',
    ownerType: 'source',
    ownerId: batchNumber,
    reason: '真实输入仍被业务引用'
  });
  const pseudo = repository.addArtifact(batchId, {
    artifactKey: 'input:split-output-directory',
    direction: 'input',
    role: 'input',
    sourceOperation: 'toolbox:split:export',
    originalName: path.basename(outputDir),
    sourcePath: outputDir
  });
  repository.startArtifactAttempt(pseudo.id);
  repository.failArtifact(pseudo.id, {
    code: 'ARCHIVE_SOURCE_NOT_FILE',
    message: '保存目录不是普通文件',
    sourceOperation: 'toolbox:split:export'
  });
  return {
    batchId,
    batchNumber,
    outputDir,
    pseudoArtifactId: pseudo.id,
    realArtifacts: [input, outputA, outputB]
  };
}

function seedHistorical001(repository, db, rootDir) {
  const batchNumber = '2026-08-17-001';
  const created = repository.createBatch({
    moduleId: 'toolbox',
    moduleCode: 'TOOLBOX',
    moduleName: '工具箱',
    operationKey: `historical-fixture:${batchNumber}`,
    taskKey: 'toolbox:merge',
    taskRunId: `task-run:${batchNumber}`,
    parentRunId: `parent-run:${batchNumber}`,
    localDate: '2026-08-17'
  });
  const batchId = created.batch.id;
  db.prepare(`
    UPDATE archive_batches
    SET batch_number = ?,
        task_key = 'toolbox:merge',
        task_status = 'failed',
        archive_status = 'complete',
        failure_code = 'TOOLBOX_OPERATION_FAILED',
        failure_message = '工具箱合并失败：输入文件内容不兼容'
    WHERE id = ?
  `).run(batchNumber, batchId);
  db.prepare(`
    UPDATE archive_operation_issuances SET batch_number = ? WHERE batch_id = ?
  `).run(batchNumber, batchId);
  addReadyArtifact(repository, batchId, {
    artifactKey: 'input:merge-source-a.xlsx',
    direction: 'input',
    role: 'input',
    sourceOperation: 'toolbox:merge',
    originalName: 'merge-source-a.xlsx',
    sourcePath: path.join(rootDir, 'merge-source-a.xlsx')
  }, 1);
  addReadyArtifact(repository, batchId, {
    artifactKey: 'input:merge-source-b.xlsx',
    direction: 'input',
    role: 'input',
    sourceOperation: 'toolbox:merge',
    originalName: 'merge-source-b.xlsx',
    sourcePath: path.join(rootDir, 'merge-source-b.xlsx')
  }, 2);
  db.prepare(`
    UPDATE archive_batches
    SET task_status = 'failed',
        archive_status = 'complete',
        failure_code = 'TOOLBOX_OPERATION_FAILED',
        failure_message = '工具箱合并失败：输入文件内容不兼容'
    WHERE id = ?
  `).run(batchId);
  return { batchId, batchNumber };
}

function snapshotBatch(db, batchId) {
  return {
    batch: db.prepare('SELECT * FROM archive_batches WHERE id = ?').get(batchId),
    artifacts: db.prepare(`
      SELECT * FROM archive_artifacts WHERE batch_id = ? ORDER BY id ASC
    `).all(batchId)
  };
}

test('repository 只修完整 017 指纹，保留三项真实证据/failureCount 并二次幂等', (t) => {
  const fixture = createFixture(t);
  const seeded = seedRepairBatch(
    fixture.repository,
    fixture.db,
    fixture.rootDir,
    '2026-08-13-017'
  );
  const beforeBatch = fixture.repository.getBatch(seeded.batchId);
  const beforeReal = seeded.realArtifacts.map((artifact) => ({
    id: artifact.id,
    blobId: artifact.blob.id,
    sha256: artifact.blob.sha256,
    sizeBytes: artifact.blob.sizeBytes,
    holds: fixture.repository.listArtifactHolds(artifact.id)
  }));

  const dryRun = fixture.repository.inspectSplitDirectoryArtifactRepair('2026-08-13-017');
  assert.equal(dryRun.status, 'matched');
  assert.equal(fixture.repository.listArtifacts(seeded.batchId).length, 4);

  const repaired = fixture.repository.repairSplitDirectoryArtifact('2026-08-13-017', {
    appVersion: '3.1.11-test'
  });
  assert.equal(repaired.status, 'repaired');
  assert.equal(repaired.pseudoArtifactId, seeded.pseudoArtifactId);
  const afterBatch = fixture.repository.getBatch(seeded.batchId);
  assert.equal(afterBatch.batchNumber, seeded.batchNumber);
  assert.equal(afterBatch.taskStatus, 'succeeded');
  assert.equal(afterBatch.parentRunId, beforeBatch.parentRunId);
  assert.equal(afterBatch.archiveStatus, 'complete');
  assert.equal(afterBatch.failureCount, beforeBatch.failureCount);
  assert.equal(afterBatch.lastErrorCode, '');
  assert.equal(afterBatch.lastErrorMessage, '');
  assert.equal(fixture.repository.getArtifact(seeded.pseudoArtifactId), null);
  assert.deepEqual(repaired.realArtifacts, beforeReal);

  const audit = fixture.db.prepare('SELECT * FROM archive_maintenance_audits').get();
  assert.equal(audit.repair_key, repaired.repairKey);
  assert.equal(audit.batch_number, seeded.batchNumber);
  assert.equal(audit.app_version, '3.1.11-test');
  assert.equal(JSON.parse(audit.before_json).artifacts.length, 4);
  assert.equal(JSON.parse(audit.after_json).artifacts.length, 3);
  assert.match(audit.before_json, new RegExp(seeded.outputDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

  const second = fixture.repository.repairSplitDirectoryArtifact('2026-08-13-017', {
    appVersion: '3.1.11-test'
  });
  assert.equal(second.status, 'already-repaired');
  assert.equal(fixture.db.prepare('SELECT COUNT(*) AS count FROM archive_maintenance_audits').get().count, 1);
  assert.equal(fixture.repository.listArtifacts(seeded.batchId).length, 3);
  fixture.db.close();
});

test('指纹不符整批 skip；audit 写失败时删除与 batch 状态同事务回滚', (t) => {
  const fixture = createFixture(t);
  const skipped = seedRepairBatch(
    fixture.repository,
    fixture.db,
    fixture.rootDir,
    '2026-08-13-017'
  );
  fixture.db.prepare(`
    UPDATE archive_artifacts SET source_path = ? WHERE id = ?
  `).run(path.join(fixture.rootDir, 'not-the-output-parent'), skipped.pseudoArtifactId);
  assert.deepEqual(
    fixture.repository.repairSplitDirectoryArtifact('2026-08-13-017', {
      appVersion: '3.1.11-test'
    }),
    {
      status: 'skipped',
      batchNumber: '2026-08-13-017',
      batchId: skipped.batchId,
      reason: 'fingerprint-mismatch'
    }
  );
  assert.equal(fixture.repository.listArtifacts(skipped.batchId).length, 4);

  const rollback = seedRepairBatch(
    fixture.repository,
    fixture.db,
    fixture.rootDir,
    '2026-08-13-018'
  );
  fixture.db.exec(`
    CREATE TRIGGER reject_split_repair_audit
    BEFORE INSERT ON archive_maintenance_audits
    BEGIN
      SELECT RAISE(ABORT, 'fixture audit failure');
    END;
  `);
  assert.throws(
    () => fixture.repository.repairSplitDirectoryArtifact('2026-08-13-018', {
      appVersion: '3.1.11-test'
    }),
    /fixture audit failure/
  );
  assert.equal(fixture.repository.listArtifacts(rollback.batchId).length, 4);
  assert.equal(fixture.repository.getArtifact(rollback.pseudoArtifactId).status, 'failed');
  assert.equal(fixture.repository.getBatch(rollback.batchId).archiveStatus, 'incomplete');
  assert.equal(fixture.db.prepare('SELECT COUNT(*) AS count FROM archive_maintenance_audits').get().count, 0);
  assert.throws(
    () => fixture.repository.inspectSplitDirectoryArtifactRepair('2026-08-13-019'),
    /只允许显式批次/
  );
  fixture.db.close();
});

test('CLI 默认 dry-run；apply 先建立一致性 backup，再精确修两批且输出不泄露路径', async (t) => {
  const fixture = createFixture(t);
  const batch017 = seedRepairBatch(
    fixture.repository,
    fixture.db,
    fixture.rootDir,
    '2026-08-13-017'
  );
  const batch018 = seedRepairBatch(
    fixture.repository,
    fixture.db,
    fixture.rootDir,
    '2026-08-13-018'
  );
  const historical001 = seedHistorical001(
    fixture.repository,
    fixture.db,
    fixture.rootDir
  );
  const before001 = snapshotBatch(fixture.db, historical001.batchId);
  fixture.db.close();
  const commonArgs = [
    '--db', fixture.dbPath,
    '--batch-number', '2026-08-13-017',
    '--batch-number', '2026-08-13-018'
  ];
  const dryRun = await run(commonArgs);
  assert.equal(dryRun.mode, 'dry-run');
  assert.deepEqual(dryRun.results.map((result) => result.status), ['matched', 'matched']);
  assert.doesNotMatch(JSON.stringify(dryRun), /sourcePath|outputs/);

  const afterDryRun = new DatabaseSync(fixture.dbPath, { readOnly: true });
  try {
    assert.deepEqual(snapshotBatch(afterDryRun, historical001.batchId), before001);
    assert.equal(afterDryRun.prepare(`
      SELECT COUNT(*) AS count FROM archive_maintenance_audits WHERE batch_id = ?
    `).get(historical001.batchId).count, 0);
  } finally {
    afterDryRun.close();
  }

  const backupPath = path.join(fixture.rootDir, 'before-repair.sqlite');
  const applied = await run([...commonArgs, '--apply', '--backup', backupPath]);
  assert.equal(applied.mode, 'apply');
  assert.deepEqual(applied.results.map((result) => result.status), ['repaired', 'repaired']);
  assert.equal(fs.existsSync(backupPath), true);
  assert.doesNotMatch(JSON.stringify(applied), /sourcePath|outputs/);

  const active = new DatabaseSync(fixture.dbPath, { readOnly: true });
  const backupDb = new DatabaseSync(backupPath, { readOnly: true });
  try {
    assert.equal(active.prepare('PRAGMA quick_check').get().quick_check, 'ok');
    assert.equal(backupDb.prepare('PRAGMA quick_check').get().quick_check, 'ok');
    assert.equal(active.prepare('SELECT COUNT(*) AS count FROM archive_maintenance_audits').get().count, 2);
    assert.equal(backupDb.prepare('SELECT COUNT(*) AS count FROM archive_maintenance_audits').get().count, 0);
    for (const seeded of [batch017, batch018]) {
      assert.equal(active.prepare('SELECT COUNT(*) AS count FROM archive_artifacts WHERE batch_id = ?').get(seeded.batchId).count, 3);
      assert.equal(backupDb.prepare('SELECT COUNT(*) AS count FROM archive_artifacts WHERE batch_id = ?').get(seeded.batchId).count, 4);
    }
    assert.deepEqual(snapshotBatch(active, historical001.batchId), before001);
    assert.deepEqual(snapshotBatch(backupDb, historical001.batchId), before001);
    assert.equal(active.prepare(`
      SELECT COUNT(*) AS count FROM archive_maintenance_audits WHERE batch_id = ?
    `).get(historical001.batchId).count, 0);
  } finally {
    active.close();
    backupDb.close();
  }

  const verify = new DatabaseSync(fixture.dbPath);
  try {
    const repository = createArchiveRepository(verify);
    assert.equal(repository.inspectSplitDirectoryArtifactRepair('2026-08-13-017').status, 'already-repaired');
    assert.equal(repository.inspectSplitDirectoryArtifactRepair('2026-08-13-018').status, 'already-repaired');
  } finally {
    verify.close();
  }
});

test('CLI apply 要求绝对 DB/backup、精确两批且活跃 writer 时拒绝执行', async (t) => {
  assert.throws(
    () => parseArgs(['--db', 'relative.sqlite', '--batch-number', '2026-08-13-017', '--batch-number', '2026-08-13-018']),
    /--db 必须是绝对路径/
  );
  assert.throws(
    () => parseArgs(['--db', '/tmp/tool.sqlite', '--batch-number', '2026-08-13-017']),
    /各显式传入一次/
  );
  assert.throws(
    () => parseArgs([
      '--db', '/tmp/tool.sqlite',
      '--batch-number', '2026-08-13-017',
      '--batch-number', '2026-08-17-001'
    ]),
    /各显式传入一次/
  );
  assert.throws(
    () => parseArgs(['--db', '/tmp/tool.sqlite', '--batch-number', '2026-08-13-017', '--batch-number', '2026-08-13-018', '--apply']),
    /绝对 --backup/
  );

  const fixture = createFixture(t);
  seedRepairBatch(fixture.repository, fixture.db, fixture.rootDir, '2026-08-13-017');
  seedRepairBatch(fixture.repository, fixture.db, fixture.rootDir, '2026-08-13-018');
  fixture.db.exec('PRAGMA journal_mode = WAL; BEGIN IMMEDIATE');
  const backupPath = path.join(fixture.rootDir, 'must-not-exist.sqlite');
  await assert.rejects(
    run([
      '--db', fixture.dbPath,
      '--batch-number', '2026-08-13-017',
      '--batch-number', '2026-08-13-018',
      '--apply',
      '--backup', backupPath
    ]),
    /退出应用|locked/
  );
  assert.equal(fs.existsSync(backupPath), false);
  fixture.db.exec('ROLLBACK');
  fixture.db.close();
});

test('CLI apply backup 失败时删除残留且不修改批次、artifact 或 audit', async (t) => {
  const fixture = createFixture(t);
  const batch017 = seedRepairBatch(
    fixture.repository,
    fixture.db,
    fixture.rootDir,
    '2026-08-13-017'
  );
  const batch018 = seedRepairBatch(
    fixture.repository,
    fixture.db,
    fixture.rootDir,
    '2026-08-13-018'
  );
  const before017 = snapshotBatch(fixture.db, batch017.batchId);
  const before018 = snapshotBatch(fixture.db, batch018.batchId);
  fixture.db.close();
  const backupPath = path.join(fixture.rootDir, 'partial-backup.sqlite');

  await assert.rejects(
    run([
      '--db', fixture.dbPath,
      '--batch-number', '2026-08-13-017',
      '--batch-number', '2026-08-13-018',
      '--apply',
      '--backup', backupPath
    ], {
      backupDatabase: async (_db, targetPath) => {
        fs.writeFileSync(targetPath, 'partial backup');
        throw new Error('fixture backup failure');
      }
    }),
    /fixture backup failure/
  );
  assert.equal(fs.existsSync(backupPath), false);

  const verify = new DatabaseSync(fixture.dbPath, { readOnly: true });
  try {
    assert.deepEqual(snapshotBatch(verify, batch017.batchId), before017);
    assert.deepEqual(snapshotBatch(verify, batch018.batchId), before018);
    assert.equal(verify.prepare('SELECT COUNT(*) AS count FROM archive_maintenance_audits').get().count, 0);
  } finally {
    verify.close();
  }
});
