'use strict';
// G1 应用恢复治理集成验证：隔离 SQLite/journal，两次重启、startup/live/transport 拒绝保留。
// 用法：node scripts/integration/application-recovery-governance.js
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { createArchiveService } = require('../../src/main-process/archive-center/archive-service');
const { createArchiveCenterController } = require('../../src/main-process/archive-center/controller');
const { createArchiveOutboxStore } = require('../../src/main-process/archive-center/outbox-store');
const { createArchivePublicationOwner } = require('../../src/main-process/publication-recovery/archive-owner');
const { createPublicationRecoveryCoordinator } = require('../../src/main-process/publication-recovery/coordinator');
const { createToolboxPublicationDispatcher } = require('../../src/main-process/toolbox-output-publication-dispatch');
const { recoverToolboxPublicationsIntoArchive } = require('../../src/main-process/toolbox-archive-recovery');
const { createApplicationRecoveryCoordinator } = require('../../src/main-process/application-recovery/coordinator');
// 仅构造旧版中断材料；被测恢复全部使用生产 owner、dispatcher 与真实 worker。
const { JOURNAL_INDEX_NAME, prepareToolboxPublication, publishPreparedToolboxPublication,
  ToolboxPublicationCrashError } = require('../../tests/helpers/publication-authority');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'application-recovery-governance-'));
let passed = 0;
function hash(buffer) { return crypto.createHash('sha256').update(buffer).digest('hex'); }
function materials(directory) {
  const paths = [path.join(directory, 'user', JOURNAL_INDEX_NAME)];
  const outputs = path.join(directory, 'output');
  if (fs.existsSync(outputs)) paths.push(...fs.readdirSync(outputs).sort().map((name) => path.join(outputs, name)));
  return paths.map((file) => [file, fs.existsSync(file) ? hash(fs.readFileSync(file)) : null]);
}
function context(batch) {
  return { batchId: batch.id, batchNumber: batch.batchNumber, taskRunId: batch.taskRunId,
    taskKey: batch.taskKey, moduleId: batch.moduleId, parentRunId: batch.parentRunId, operationKey: batch.operationKey };
}
async function setup(name, unknown = false) {
  const directory = path.join(root, name);
  for (const subdir of ['user', 'output', 'generation']) fs.mkdirSync(path.join(directory, subdir), { recursive: true });
  const db = new DatabaseSync(path.join(directory, 'user', 'archive.sqlite'));
  const service = createArchiveService({ database: db, rootDir: path.join(directory, 'archive') });
  await service.initialize();
  const reservation = await service.reserveTaskBatch({ moduleId: unknown ? 'unknown' : 'toolbox',
    taskKey: unknown ? 'unknown:export' : 'toolbox:merge', moduleCode: 'TOOLBOX', moduleName: '工具箱',
    taskRunId: `run-${name}`, parentRunId: `parent-${name}`, operationKey: `operation-${name}` });
  assert.equal(reservation.ok, true);
  await service.markTaskStarted(reservation.batchId);
  const sourcePath = path.join(directory, 'generation', 'generated.xlsx');
  const targetPath = path.join(directory, 'output', 'result.xlsx');
  fs.writeFileSync(sourcePath, 'generated-output');
  fs.writeFileSync(targetPath, 'original-output');
  const options = { userDataDir: path.join(directory, 'user'), taskId: `publisher-${name}`,
    batchContext: context(reservation.batch), requireArchiveHandoff: true,
    allowEmptyArchiveInputs: true, requireValidatedArtifacts: true,
    artifacts: [{ sourcePath, byteSize: 16, sha256: hash('generated-output') }], targets: [targetPath] };
  db.close();
  return { directory, options, batchId: reservation.batchId };
}
async function boot(fixture, { workerScriptPath, failLaterOwner = false } = {}) {
  const { directory, options } = fixture;
  const db = new DatabaseSync(path.join(directory, 'user', 'archive.sqlite'));
  const service = createArchiveService({ database: db, rootDir: path.join(directory, 'archive') });
  let controller;
  const owner = createArchivePublicationOwner({ getArchiveCenter: () => controller });
  const dispatcher = createToolboxPublicationDispatcher({ workerScriptPath });
  const publication = createPublicationRecoveryCoordinator({ userDataDir: options.userDataDir, dispatcher, owners: [owner] });
  publication.bindDispatcherAuthority();
  const recovery = publication.forOwner(owner.id);
  const events = [];
  const application = createApplicationRecoveryCoordinator({
    platform: { async scanAndRecover() { events.push('platform'); return { sourceCount: 0 }; }, async recoverSource() {} },
    participants: [{ id: 'toolbox-vcc-publications', ownerName: 'Toolbox/VCC output publications', preflight: null,
      recoverOwner: async () => { events.push('owner'); return recoverToolboxPublicationsIntoArchive({
        archiveCenter: controller, recoverPublications: recovery.recover, userDataDir: options.userDataDir }); }, postOutbox: null },
    { id: 'probe-owner', ownerName: 'probe-owner', preflight: null, postOutbox: null,
      recoverOwner: async () => { events.push('later-owner'); if (failLaterOwner) throw new Error('fixture owner failed'); } }]
  });
  controller = createArchiveCenterController({ service,
    database: { getSetting: () => null, setSetting() {}, listTemplates: () => [] },
    outboxStore: createArchiveOutboxStore(path.join(options.userDataDir, 'outbox')),
    recoverInterruptedTaskOwners: application.archiveOwnerHooks(), postOutboxStartupHooks: application.postOutboxHooks() });
  await application.platformFacade.scanAndRecover();
  await application.preflight();
  return { db, service, controller, dispatcher, recovery, application, events };
}
async function check(name, run) { await run(); passed++; process.stdout.write(`PASS ${name}\n`); }
async function main() {
  await check('合法历史 committed receipt 两次 SQLite 重启只接管一次，平台 ready 独立记录', async () => {
    const fixture = await setup('legacy');
    const prepared = prepareToolboxPublication({ ...fixture.options, checkpoint(name) {
      if (name === 'publish:after-committed') throw new ToolboxPublicationCrashError(name);
    } });
    assert.throws(() => publishPreparedToolboxPublication(prepared), ToolboxPublicationCrashError);
    for (let restart = 0; restart < 2; restart++) {
      const host = await boot(fixture);
      try {
        const result = await host.controller.initialize();
        host.application.completeArchiveInitialization(result);
        assert.equal(host.application.snapshot().phase, 'ready');
        assert.equal(host.service.repository.getBatchDetail(fixture.batchId).taskStatus, 'succeeded');
        assert.equal(host.service.repository.getBatchDetail(fixture.batchId).artifacts.length, 1);
        assert.equal(fs.readFileSync(fixture.options.targets[0], 'utf8'), 'generated-output');
      } finally { host.db.close(); }
    }
  });
  for (const state of ['prepared', 'committed']) {
    await check(`未知 owner ${state} 从实际 startup/live 路径拒绝且五类材料摘要不变`, async () => {
      const fixture = await setup(`unknown-${state}`, true);
      if (state === 'prepared') {
        assert.throws(() => prepareToolboxPublication({ ...fixture.options, checkpoint(name) {
          if (name === 'prepare:after-journal') throw new ToolboxPublicationCrashError(name);
        } }), ToolboxPublicationCrashError);
      } else {
        const prepared = prepareToolboxPublication({ ...fixture.options, checkpoint(name) {
          if (name === 'publish:after-committed') throw new ToolboxPublicationCrashError(name);
        } });
        assert.throws(() => publishPreparedToolboxPublication(prepared), ToolboxPublicationCrashError);
      }
      const before = materials(fixture.directory);
      const host = await boot(fixture);
      try {
        await assert.rejects(host.controller.initialize(), { code: 'ARCHIVE_STARTUP_OWNER_RECOVERY_FAILED' });
        assert.ok(host.events.includes('later-owner'));
        assert.deepEqual(materials(fixture.directory), before);
        await assert.rejects(recoverToolboxPublicationsIntoArchive({ archiveCenter: host.controller,
          recoverPublications: host.recovery.recover, taskIds: [fixture.options.taskId] }),
        { code: 'PUBLICATION_RECOVERY_OWNER_UNKNOWN' });
        assert.deepEqual(materials(fixture.directory), before);
      } finally { host.db.close(); }
    });
  }
  await check('真实发布 worker committed 后退出，transport 授权拒绝未知 owner 并保留 receipt', async () => {
    const fixture = await setup('transport', true);
    fixture.options.taskId = 'committed-crash-recover-unknown';
    const host = await boot(fixture, { workerScriptPath: require.resolve('../../tests/unit/main-process/__fixtures__/toolbox-publication-stub-crash-recover') });
    try {
      await assert.rejects(host.dispatcher.publish(fixture.options), (error) => error.code === 'TOOLBOX_PUBLICATION_WORKER_RECOVERY_FAILED'
        && error.cause.code === 'PUBLICATION_RECOVERY_OWNER_UNKNOWN' && error.preserveTemporaryFiles);
      const before = materials(fixture.directory);
      assert.equal(fs.readFileSync(fixture.options.targets[0], 'utf8'), 'generated-output');
      assert.equal(JSON.parse(fs.readFileSync(path.join(fixture.options.userDataDir, JOURNAL_INDEX_NAME))).entries.length, 1);
      await assert.rejects(host.recovery.recover({ reason: 'business-retry', taskIds: [fixture.options.taskId] }),
        { code: 'PUBLICATION_RECOVERY_OWNER_UNKNOWN' });
      assert.deepEqual(materials(fixture.directory), before);
    } finally { host.db.close(); }
  });
  process.stdout.write(`==== ${passed}/${passed} PASS ====\n`);
}
main().catch((error) => { console.error('FAILURES', error); process.exitCode = 1; })
  .finally(() => fs.rmSync(root, { recursive: true, force: true }));
