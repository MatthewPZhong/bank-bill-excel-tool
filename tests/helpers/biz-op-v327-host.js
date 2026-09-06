'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { createBizOpV327Module } = require('../../src/main-process/biz-op-v327/module');
const { createArchiveService } = require('../../src/main-process/archive-center/archive-service');
const { createTaskLifecycle } = require('../../src/main-process/archive-center/task-lifecycle');
const { createBusinessFlowResolver } = require('../../src/main-process/archive-center/business-flow-resolver');
const { createBusinessOperationRegistry } = require('../../src/main-process/business-operation-registry');
const { normalizeFilePlanV1 } = require('../../src/main-process/archive-center/file-plan');
const { createNonProductionBackgroundExecutionRuntime } = require('../../src/main-process/background-execution/runtime');
const { createResourceGovernor } = require('../../src/main-process/background-execution/resource-governor');
const { createInspectorRegistry } = require('../../src/main-process/background-execution/inspector-registry');
const { createSettlementRecoveryProviderRegistry } = require('../../src/main-process/background-execution/settlement-recovery-provider-registry');
const { createStartupRecoveryCoordinator } = require('../../src/main-process/background-execution/startup-recovery-coordinator');
const { createRecoveryControlReadRepository } = require('../../src/main-process/background-execution/critical/recovery-control-read-repository');
const { createRecoveryRequestOwnerRepository, createRecoveryObservationAttemptRepository } = require('../../src/main-process/background-execution/critical/recovery-request-owner-repository');
const { createRecoveryControlRepository } = require('../../src/main-process/background-execution/critical/recovery-control-repository');

async function createHost(t, options = {}) {
  const root = options.root || fs.mkdtempSync(path.join(os.tmpdir(), 'bizop-import-host-'));
  const db = new DatabaseSync(path.join(root, options.dbFileName || 'main.sqlite'));
  db.exec('PRAGMA foreign_keys=ON');
  let service; let runtime;
  const readRepository = createRecoveryControlReadRepository(db);
  const module = createBizOpV327Module({ ...options.moduleOptions, db, userDataDir: root, readRepository, getArchiveService: () => service, getRuntime: () => runtime });
  const inspectors = createInspectorRegistry(); const providers = createSettlementRecoveryProviderRegistry();
  module.sources.register(inspectors, providers); inspectors.freeze(); providers.freeze();
  const platform = createStartupRecoveryCoordinator({ readRepository, inspectorRegistry: inspectors, providerRegistry: providers,
    requestOwnerRepository: createRecoveryRequestOwnerRepository(db), observationAttemptRepository: createRecoveryObservationAttemptRepository(db),
    recoveryControlRepository: createRecoveryControlRepository(db), resolveTaskState: module.plan.taskState, planTransitions: module.plan.plan,
    transientAttempts: 1, sleep: async () => {} });
  module.recovery.bindPlatform(platform);
  service = createArchiveService({ database: db, rootDir: path.join(root, 'archive'),
    onArtifactReady: (artifact, repository) => module.readyHold(artifact, repository) });
  await service.initialize({ deferStartupRecovery: true });
  runtime = createNonProductionBackgroundExecutionRuntime({ bizOpV327: module.runtimeBindings,
    resourceGovernor: createResourceGovernor({ budgets: { cpuSlots: 2, workerThreadSlots: 2, utilityProcessSlots: 0,
      ioHeavySlots: 2, memoryBytes: 2 * 1024 * 1024 * 1024 } }) });
  const lifecycle = createTaskLifecycle({ archiveService: service, businessOperationRegistry: createBusinessOperationRegistry(),
    flowResolver: createBusinessFlowResolver({ archiveService: service }), operationTracker: { async appendOperationFiles() { return { archiveFailed: false }; } } });
  t.after(async () => { await runtime.shutdown({ timeoutMs: 5000 }); db.close(); if (!options.keep) fs.rmSync(root, { recursive: true, force: true }); });
  const bootstrap = await module.recovery.run(); assert.equal(bootstrap.ready, options.expectReady !== false, JSON.stringify(bootstrap));
  return { root, db, module, service, runtime, lifecycle, bootstrap,
    run(files, extra = {}) { return module.runImport({ taskLifecycle: lifecycle, runtime,
      filePlan: normalizeFilePlanV1({ version: 1, allocation: 'eager', inputs: files.map((filePath) => ({ filePath,
        role: 'input', sourceOperation: 'bizOpReconV327:import' })), outputs: [] }), ...extra }); } };
}
module.exports = { createHost };
