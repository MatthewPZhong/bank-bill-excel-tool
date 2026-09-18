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
const { normalizeFilePlanV1 } = require('../../../src/main-process/archive-center/file-plan');
const { stageInputFiles } = require('../../../src/main-process/position-reconciliation/input-staging');
const { positionInputFilePlanEvidence, positionFilePlanSettlementFiles } = require('../../../src/main-process/position-reconciliation/archive-file-plan-evidence');
const { createPositionOwnedDeleteSourceResolver, positionDeleteSourceReferences } = require('../../../src/main-process/archive-center/position-owned-delete-sources');
const { verifyPositionFilePlanDeletion } = require('../../fixtures/archive-permanent-delete-position-fileplan');

async function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'position-fileplan-owner-'));
  const userDataDir = path.join(directory, 'user-data');
  fs.mkdirSync(userDataDir);
  const originalPath = path.join(directory, 'original.xlsx');
  fs.writeFileSync(originalPath, 'synthetic position input');
  const staged = stageInputFiles(userDataDir, [originalPath], 'position-fixture')[0];
  const state = { blocked: false, protectedPaths: [] };
  const fsImpl = { ...fs, promises: fs.promises, unlinkSync(filePath) {
    if (state.blocked && filePath === staged.archivePath) {
      throw Object.assign(new Error('模拟来源文件占用'), { code: 'EBUSY' });
    }
    fs.unlinkSync(filePath);
  } };
  let database;
  let service;
  let controller;
  async function open() {
    database = new DatabaseSync(path.join(directory, 'archive.sqlite'));
    database.exec('PRAGMA foreign_keys = ON');
    service = createArchiveService({ database, rootDir: path.join(directory, 'archive'), fsImpl });
    service.resolveOwnedDeleteSources = createPositionOwnedDeleteSourceResolver({
      userDataPath: userDataDir, protectedPathProvider: async ({ batch, artifacts }) => {
        const references = positionDeleteSourceReferences(service.repository, batch.id, artifacts);
        return { sharedPaths: references.sharedPaths,
          protectedPaths: references.protectedPaths.concat(state.protectedPaths) };
      }
    });
    controller = createArchiveCenterController({ service,
      database: { getSetting: () => null, setSetting() {} },
      outboxStore: createArchiveOutboxStore(path.join(directory, 'outbox')) });
    assert.equal((await controller.initialize()).ok, true);
  }
  await open();
  t.after(async () => {
    await service.pauseBackgroundMaterialization();
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return {
    directory, originalPath, staged, state,
    get database() { return database; }, get service() { return service; }, get controller() { return controller; },
    async restart() { await service.pauseBackgroundMaterialization(); database.close(); await open(); },
    async archive(key, options = {}) {
      const channel = 'position-reconciliation:source:apply-import';
      const policy = createTaskPolicyRegistry().require(channel);
      const plan = normalizeFilePlanV1({ version: 1, allocation: 'eager', inputs: [{
        filePath: staged.archivePath, ...positionInputFilePlanEvidence(staged),
        role: 'input', sourceOperation: channel
      }], outputs: [] });
      const lifecycle = createTaskLifecycle({ archiveService: service,
        businessOperationRegistry: { begin: () => ({ accepted: true, token: key }), end() {} },
        flowResolver: { resolve: async () => ({ parentRunId: 'position-parent', source: 'new', identity: null }),
          bind: async () => [], persistBindIntent: async () => ({ ok: true }) },
        operationTracker: { appendOperationFiles: async () => ({ ok: true }) },
        persistTerminalIntent: (payload) => controller.persistTaskTerminalIntent(payload) });
      const operation = lifecycle.runFileTask({ policy, meta: { channel }, taskRunId: `${key}-task`,
        operationKey: key, filePlanResolver: () => plan,
        ...(options.interrupted ? { beforeTerminalSettlement: async () => {
          throw Object.assign(new Error('模拟进程中断'), { code: 'SIMULATED_CRASH' });
        } } : {}),
        execute: async (_context, controls) => {
          if (!options.interrupted) await controls.settleArtifacts({ files: positionFilePlanSettlementFiles(plan) });
          return { status: 'ok' };
        }
      });
      if (options.interrupted) await assert.rejects(operation, { code: 'SIMULATED_CRASH' });
      else assert.equal((await operation).status, 'ok');
      const batch = service.repository.getBatchByOperationKey(policy.scopeId, key);
      return { batch, artifact: service.repository.listArtifacts(batch.id)[0] };
    },
    async remove(batchId) {
      const prepared = await controller.prepareDeleteBatch(batchId);
      assert.equal(prepared.ok, true, JSON.stringify(prepared));
      const deleted = await controller.deleteBatch(batchId, prepared.confirmationToken);
      assert.equal(deleted.fullyDeleted, true, JSON.stringify(deleted));
      return deleted;
    }
  };
}

test('真实 streaming 账户确认先删 apply 批次，重启后历史共享来源仍由 prepare 批次最终清理', async () => {
  const result = await verifyPositionFilePlanDeletion(os.tmpdir(), { engine: 'streaming', reverse: true, restart: true });
  assert.equal(result.sharedInPrepare, true);
});

test('真实 FilePlan 共享来源被同内容新 inode 替换时，重启删除仍保留替代对象', async () => {
  const result = await verifyPositionFilePlanDeletion(os.tmpdir(), { engine: 'streaming', replaceSource: true, restart: true });
  assert.equal(result.blockedCode, 'ARCHIVE_DELETE_SOURCE_CHANGED');
});

for (const failure of ['attempt-recording', 'interrupted-before-settle']) {
  test(`新 Position manifest ${failure} 后原证据持久保留，重启可删除受管来源`, async (t) => {
    const f = await fixture(t);
    if (failure === 'attempt-recording') f.database.exec(`
      CREATE TRIGGER reject_position_attempt BEFORE UPDATE OF attempt_count ON archive_artifacts
      BEGIN SELECT RAISE(ABORT, '模拟attempt记录失败'); END;
    `);
    const a = await f.archive('failed-source', { interrupted: failure === 'interrupted-before-settle' });
    assert.equal(a.artifact.blob, null);
    assert.equal(a.artifact.metadata.expectedSha256, f.staged.stagedSha256);
    assert.deepEqual(a.artifact.metadata.sourceSnapshot, f.staged.stagedSnapshot);
    if (failure === 'attempt-recording') f.database.exec('DROP TRIGGER reject_position_attempt');
    await f.restart();
    assert.equal(f.service.repository.getArtifact(a.artifact.id).metadata.expectedSha256, f.staged.stagedSha256);
    await f.remove(a.batch.id);
    assert.equal(fs.existsSync(f.staged.archivePath), false);
    assert.equal(fs.readFileSync(f.originalPath, 'utf8'), 'synthetic position input');
  });
}

for (const mismatch of ['sha256', 'size', 'snapshot', 'owner-instance', 'owner-identity', 'owner-missing', 'task-running']) {
  test(`其他批次 ${mismatch} 冲突不能把同源引用放宽为共享保留`, async (t) => {
    const f = await fixture(t);
    const a = await f.archive('source-a');
    const b = await f.archive('source-b');
    const before = positionDeleteSourceReferences(f.service.repository, a.batch.id, [a.artifact]);
    assert.deepEqual(before.sharedPaths, [f.staged.archivePath]);
    if (['sha256', 'size', 'snapshot'].includes(mismatch)) {
      const metadata = { ...b.artifact.metadata };
      if (mismatch === 'sha256') metadata.expectedSha256 = '0'.repeat(64);
      else if (mismatch === 'size') metadata.expectedSizeBytes += 1;
      else metadata.sourceSnapshot = { ...metadata.sourceSnapshot, ino: '999999999' };
      f.database.prepare('UPDATE archive_artifacts SET metadata_json = ? WHERE id = ?')
        .run(JSON.stringify(metadata), b.artifact.id);
    } else if (mismatch === 'owner-instance') {
      f.database.prepare('UPDATE archive_owner_terminal_completions SET archive_instance_id = ? WHERE batch_id = ?')
        .run('old-instance', b.batch.id);
    } else if (mismatch === 'owner-identity') {
      const proof = f.database.prepare('SELECT owner_json FROM archive_owner_terminal_completions WHERE batch_id = ?').get(b.batch.id);
      const owner = JSON.parse(proof.owner_json);
      owner.batchContext.operationKey = 'other-operation';
      f.database.prepare('UPDATE archive_owner_terminal_completions SET owner_json = ? WHERE batch_id = ?')
        .run(JSON.stringify(owner), b.batch.id);
    } else if (mismatch === 'owner-missing') {
      f.database.prepare('DELETE FROM archive_owner_terminal_completions WHERE batch_id = ?').run(b.batch.id);
    } else {
      f.database.prepare("UPDATE archive_task_runs SET status = 'running' WHERE task_run_id = ?").run(b.batch.taskRunId);
    }
    const actual = positionDeleteSourceReferences(f.service.repository, a.batch.id, [a.artifact]);
    assert.deepEqual(actual.sharedPaths, []);
    assert.deepEqual(actual.protectedPaths, [f.staged.archivePath]);
    const blocked = await f.controller.prepareDeleteBatch(a.batch.id);
    assert.equal(blocked.code, 'ARCHIVE_DELETE_SOURCE_HELD', JSON.stringify(blocked));
    assert.ok(f.service.repository.getBatch(a.batch.id));
    assert.equal(fs.existsSync(f.staged.archivePath), true);
  });
}

test('持久删除计划后新增同源批次仍阻止物理删除，后者释放后原计划按missing重放', async (t) => {
  const f = await fixture(t);
  const a = await f.archive('pending-source-a');
  const prepared = await f.controller.prepareDeleteBatch(a.batch.id);
  assert.equal(prepared.ok, true);
  f.state.blocked = true;
  const pending = await f.controller.deleteBatch(a.batch.id, prepared.confirmationToken);
  assert.equal(pending.fullyDeleted, false);
  assert.ok(pending.cleanupJobId);
  const persistedInput = f.service.repository.getCleanupJob(pending.cleanupJobId).plan.items.find((item) => item.sourceArtifactId);
  assert.equal(persistedInput.sourceOwnerProof.sourceKind, undefined);
  assert.equal(persistedInput.sourceOwnerProof.direction, undefined);
  await f.restart();
  f.state.blocked = false;
  const b = await f.archive('pending-source-b');
  const blocked = await f.controller.retryDeleteCleanupJob(pending.cleanupJobId);
  assert.equal(blocked.fullyDeleted, false);
  assert.ok(blocked.failures.some((item) => item.code === 'ARCHIVE_DELETE_SOURCE_HELD'));
  assert.equal(fs.existsSync(f.staged.archivePath), true);
  assert.equal((await f.service.resolveVerifiedArtifact(b.artifact.id)).ok, true);
  await f.remove(b.batch.id);
  assert.equal((await f.controller.retryDeleteCleanupJob(pending.cleanupJobId)).fullyDeleted, true);
  assert.equal(f.service.repository.listCleanupJobs().length, 0);
});

test('共享引用不豁免活动/恢复保护；provider两个路径数组必须完整合法', async (t) => {
  const f = await fixture(t);
  const a = await f.archive('protected-source-a');
  await f.archive('protected-source-b');
  f.state.protectedPaths = [f.staged.archivePath];
  assert.equal((await f.controller.prepareDeleteBatch(a.batch.id)).code, 'ARCHIVE_DELETE_SOURCE_HELD');
  for (const response of [{ protectedPaths: [] }, { sharedPaths: [] },
    { protectedPaths: [], sharedPaths: [null] }, { protectedPaths: ['relative'], sharedPaths: [] }]) {
    const resolver = createPositionOwnedDeleteSourceResolver({ userDataPath: path.join(f.directory, 'user-data'),
      protectedPathProvider: async () => response });
    await assert.rejects(resolver(a.batch, [a.artifact]), { code: 'ARCHIVE_DELETE_SOURCE_REFERENCES_UNAVAILABLE' });
  }
});

for (const sourceMissing of [false, true]) {
  test(`真实过滤行报告 ${sourceMissing ? '业务删除并由Main清理' : '原源仍存在'} 后重开库，原批次可永久删除`, async () => {
    const result = await verifyPositionFilePlanDeletion(os.tmpdir(), {
      engine: 'streaming', anomalyReport: true, sourceMissing, restart: true
    });
    assert.ok(result.reportCount > 0);
  });
}
