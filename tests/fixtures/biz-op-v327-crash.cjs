'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const source = (name) => require(path.resolve(__dirname, '../../src/main-process', name));
const { createBizOpV327Module } = source('biz-op-v327/module');
const { createArchiveService } = source('archive-center/archive-service');
const { createTaskLifecycle } = source('archive-center/task-lifecycle');
const { createBusinessFlowResolver } = source('archive-center/business-flow-resolver');
const { createBusinessOperationRegistry } = source('business-operation-registry');
const { normalizeFilePlanV1 } = source('archive-center/file-plan');
const { createNonProductionBackgroundExecutionRuntime } = source('background-execution/runtime');
const { createResourceGovernor } = source('background-execution/resource-governor');
const { createRecoveryControlReadRepository } = source('background-execution/critical/recovery-control-read-repository');
const { createRecoveryRequestOwnerRepository, createRecoveryObservationAttemptRepository } = source('background-execution/critical/recovery-request-owner-repository');
const { createRecoveryControlRepository } = source('background-execution/critical/recovery-control-repository');
const { createStartupRecoveryCoordinator } = source('background-execution/startup-recovery-coordinator');
const { createInspectorRegistry } = source('background-execution/inspector-registry');
const { createSettlementRecoveryProviderRegistry } = source('background-execution/settlement-recovery-provider-registry');
const { createRecoveryBudget } = source('biz-op-v327/recovery-budget');

(async () => {
  const root = process.argv[2];
  const db = new DatabaseSync(path.join(root, 'main.sqlite'));
  db.exec('PRAGMA foreign_keys=ON');
  let service;
  const module = createBizOpV327Module({ db, userDataDir: root,
    readRepository: createRecoveryControlReadRepository(db), getArchiveService: () => service });
  service = createArchiveService({ database: db, rootDir: path.join(root, 'archive'), onArtifactReady: module.readyHold });
  await service.initialize({ deferStartupRecovery: true });
  // 隔离进程只生成本用例；开放内部候选验证准入，不开启生产 feature。
  await module.admission.exclusive(() => module.admission.markRecovered(), { recovery: true });
  const runtime = createNonProductionBackgroundExecutionRuntime({ bizOpV327: module.runtimeBindings,
    resourceGovernor: createResourceGovernor({ budgets: { cpuSlots: 2, workerThreadSlots: 2, utilityProcessSlots: 0,
      ioHeavySlots: 2, memoryBytes: 2 * 1024 * 1024 * 1024 } }) });
  const lifecycle = createTaskLifecycle({ archiveService: service, businessOperationRegistry: createBusinessOperationRegistry(),
    flowResolver: createBusinessFlowResolver({ archiveService: service }),
    operationTracker: { async appendOperationFiles() { return { archiveFailed: false }; } } });
  const original = path.join(root, 'original.sqlite');
  const input = new DatabaseSync(original);
  input.exec("CREATE TABLE candidate_rows(value TEXT); INSERT INTO candidate_rows VALUES ('first'),('second');");
  input.close();
  const filePlan = normalizeFilePlanV1({ version: 1, allocation: 'eager', inputs: [{ filePath: original,
    role: 'input', sourceOperation: 'bizOpReconV327:import' }], outputs: [] });
  await module.runCandidateValidation({ taskLifecycle: lifecycle, runtime, filePlan,
    dataset: { kind: 'OP', dataDate: '2026-09-01', bu: 'crash-test' }, async afterCommit(receipt) {
      fs.writeFileSync(path.join(root, 'receipt-evidence.json'), JSON.stringify(receipt));
      if (['anchor', 'hold'].includes(process.argv[3])) {
        const inspectors = createInspectorRegistry(); const providers = createSettlementRecoveryProviderRegistry();
        module.sources.register({ register(key) { inspectors.register(key, async () => { throw Object.assign(new Error('检查器暂不可用'), { code: 'TEST_INSPECTOR_UNAVAILABLE' }); }); } }, providers);
        inspectors.freeze(); providers.freeze();
        const owner = createRecoveryRequestOwnerRepository(db);
        const coordinator = createStartupRecoveryCoordinator({
          readRepository: createRecoveryControlReadRepository(db), inspectorRegistry: inspectors, providerRegistry: providers,
          requestOwnerRepository: { ...owner, reserveObservationAnchor(...args) {
            const result = owner.reserveObservationAnchor(...args);
            if (process.argv[3] === 'anchor') process.exit(75);
            return result;
          } }, observationAttemptRepository: createRecoveryObservationAttemptRepository(db),
          recoveryControlRepository: createRecoveryControlRepository(db), resolveTaskState: module.plan.taskState,
          planTransitions: module.plan.plan, transientAttempts: 1, sleep: async () => {} });
        module.sources.installBudget(createRecoveryBudget()); module.sources.collect();
        await coordinator.scanAndRecover();
        process.exit(76);
      }
      // Main COMMIT 后进程消失，TaskLifecycle 没有机会执行成功/失败终态。
      process.exit(73);
    } });
  throw new Error('故障注入未执行');
})().catch((error) => { process.stderr.write(`${error.code || error.name}: ${error.message}\n`); process.exit(1); });
