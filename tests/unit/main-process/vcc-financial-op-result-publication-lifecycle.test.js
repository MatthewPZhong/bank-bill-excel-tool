'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createResultExportFixture } = require('../../helpers/vcc-result-export');
const { createArchiveAwareOperationHarness } = require('../../helpers/archive-aware-operation-harness');
const { createTestPublicationHarness, createTestPublicationOwner, discoverToolboxPublicationRecovery } = require('../../helpers/publication-authority');
const { createResultExportHandlers } = require('../../../src/main-process/vcc-financial-op-result-export-ipc');
const { createVccFinancialOpService } = require('../../../src/main-process/vcc-financial-op-service');
const { publishVccFinancialOpOutputs } = require('../../../src/main-process/vcc-financial-op-output-recovery');
const { createArchiveService } = require('../../../src/main-process/archive-center/archive-service');
const { createArchiveCenterController } = require('../../../src/main-process/archive-center/controller');
const { createArchiveOutboxStore } = require('../../../src/main-process/archive-center/outbox-store');
const { createTaskLifecycle } = require('../../../src/main-process/archive-center/task-lifecycle');
const { recoverToolboxPublicationsIntoArchive } = require('../../../src/main-process/toolbox-archive-recovery');

// 真实 Main wrapper/adapter + TaskLifecycle、VCC Worker、publisher crash/恢复、SQLite/receipt；系统对话框是夹具。
test('本次 publish 已提交但恢复观察失败时保留 running；旧 receipt 的 preflight 拒绝仍终结失败；原 receipt 可重试接管', async (t) => {
  const f = await createResultExportFixture(t);
  const userDataDir = path.join(f.dir, 'user-data');
  const archive = createArchiveService({ database: f.db, rootDir: f.archiveRoot });
  await archive.initialize({ deferStartupRecovery: true, startBackgroundMaterialization: false });
  const controller = createArchiveCenterController({ database: { getSetting: () => null, setSetting() {} }, service: archive,
    outboxStore: createArchiveOutboxStore(path.join(userDataDir, 'outbox')) });
  const baseOwner = createTestPublicationOwner();
  let blockRecovery = true, attempts = 0;
  const owner = createTestPublicationOwner({ authorize(record, request, identity) {
    if (blockRecovery && request.reason === 'transport-error') throw new Error('injected recovery observation unavailable');
    return baseOwner.authorize(record, request, identity);
  } });
  const publication = createTestPublicationHarness(userDataDir, { owners: [owner], dispatcherOptions: {
    workerScriptPath: path.join(__dirname, '__fixtures__/toolbox-publication-stub-crash-recover.js')
  } });
  const vcc = createVccFinancialOpService({ database: { db: f.db, dbPath: f.dbPath }, assetsDir: f.assetsDir,
    publishOutputFilesFn: (payload) => publishVccFinancialOpOutputs({ ...payload, userDataDir, archiveCenter: controller,
      recoverPublications: publication.recovery.recover,
      publishPublication: (options) => publication.dispatcher.publish({ ...options,
        taskId: `committed-crash-recover-vcc-${++attempts}`, requireArchiveHandoff: true }) })
  });
  const lifecycle = createTaskLifecycle({ archiveService: archive,
    businessOperationRegistry: { begin: () => ({ accepted: true, token: 'vcc-lifecycle-test' }), end() {} },
    flowResolver: { resolve: async () => ({ parentRunId: 'result-recovery-parent', source: 'new', identity: null }),
      bind: async () => [], persistBindIntent: async () => ({ ok: true }) },
    operationTracker: { appendOperationFiles: async () => ({ ok: true }) },
    persistTerminalIntent: (payload) => controller.persistTaskTerminalIntent(payload)
  });
  let selectedFile = path.join(f.dir, 'committed.xlsx'), ackCalls = 0;
  const generationDirectories = [];
  const handlers = createResultExportHandlers({ getService: () => vcc, getWindow: () => null, documentsPath: f.dir,
    dialog: { showSaveDialog: async () => ({ filePath: selectedFile }) },
    createStagingDirectory: () => {
      const directory = fs.mkdtempSync(path.join(f.dir, 'generation-'));
      generationDirectories.push(directory);
      return directory;
    },
    cleanupStagingDirectory: (dir) => fs.rmSync(dir, { recursive: true, force: true }),
    settlePublication: async () => { throw new Error('unknown publish must not call settle'); }
  });
  let sequence = 0;
  const harness = createArchiveAwareOperationHarness({ channel: 'vccFinancialOp:export:result',
    runLifecycle: (input) => lifecycle.runFileTask({ ...input, taskRunId: `vcc-result-recovery-${++sequence}`,
      operationKey: `vcc-result-recovery-operation-${sequence}` }),
    bindings: { acknowledgeToolboxPublicationReceipts() { ackCalls += 1; } }
  });
  try {
    await assert.rejects(harness.run(handlers, { args: [{ targetMonth: '2026-06' }] }), {
      code: 'VCC_RESULT_PUBLICATION_RECOVERY_REQUIRED', publicationOutcomeUncertain: true,
      publicationTaskId: 'committed-crash-recover-vcc-1'
    });
    assert.equal(fs.existsSync(selectedFile), true);
    assert.equal(archive.repository.getTaskRun('vcc-result-recovery-1').status, 'running');
    assert.equal(ackCalls, 0);
    assert.equal(discoverToolboxPublicationRecovery({ userDataDir }).records.length, 1);
    assert.ok(fs.readdirSync(f.dir).some((name) => name.startsWith('generation-')));
    blockRecovery = false;
    selectedFile = path.join(f.dir, 'must-not-publish.xlsx');
    const blocked = await harness.run(handlers, { args: [{ targetMonth: '2026-06' }] });
    assert.equal(blocked.status, 'error');
    assert.equal(blocked.code, 'TOOLBOX_PUBLICATION_MANUAL_RECOVERY');
    assert.equal(archive.repository.getTaskRun('vcc-result-recovery-2').status, 'failed');
    assert.equal(fs.existsSync(selectedFile), false);
    assert.equal(generationDirectories.length, 2);
    assert.equal(fs.existsSync(generationDirectories[0]), true);
    assert.equal(fs.existsSync(generationDirectories[1]), false);
    assert.equal(discoverToolboxPublicationRecovery({ userDataDir }).records.length, 1);
    await recoverToolboxPublicationsIntoArchive({ userDataDir, archiveCenter: controller,
      recoverPublications: publication.recovery.recover, taskIds: ['committed-crash-recover-vcc-1'] });
    assert.equal(archive.repository.getTaskRun('vcc-result-recovery-1').status, 'succeeded');
    const recovered = archive.repository.getBatchByOperationKey('vcc-financial-op', 'vcc-result-recovery-operation-1');
    assert.equal(archive.repository.getBatchDetail(recovered.id).artifacts.length, 1);
    assert.equal(discoverToolboxPublicationRecovery({ userDataDir }).records.length, 0);
  } finally { await vcc.terminate(); await archive.pauseBackgroundMaterialization(); }
});
