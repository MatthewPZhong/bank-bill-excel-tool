'use strict';

const fs = require('node:fs');
const path = require('node:path');

const {
  createExecutionPolicyRegistry,
  createStaticRegistry
} = require('../../src/main-process/background-execution/execution-policy-registry');
const { createExecutionSupervisor } = require('../../src/main-process/background-execution/supervisor');
const { createResourceGovernor } = require('../../src/main-process/background-execution/resource-governor');
const canary = require('../../src/main-process/background-execution/canary');

let passed = 0;
const failures = [];

function assertTrue(condition, label, detail) {
  if (condition) {
    passed += 1;
  } else {
    failures.push({ label, detail: detail || String(condition) });
  }
}

function assertEqual(actual, expected, label) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) {
    passed += 1;
  } else {
    failures.push({ label, detail: `actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}` });
  }
}

function buildSupervisor() {
  const entryRegistry = createStaticRegistry({
    [canary.PURE_COMPUTE_ENTRY_KEY]: canary.PURE_COMPUTE_WORKER_BINDING
  });
  const validatorRegistry = createStaticRegistry({
    [canary.PURE_COMPUTE_RESULT_VALIDATOR_KEY]: canary.validatePureComputeCanaryResult
  });
  entryRegistry.freeze();
  validatorRegistry.freeze();
  const policyRegistry = createExecutionPolicyRegistry({
    policies: [canary.pureComputePolicy],
    entryRegistry,
    validatorRegistry,
    staticKeys: { resourceProfileKeys: [canary.pureComputePolicy.resources.profile] }
  });
  policyRegistry.freeze();
  const resourceGovernor = createResourceGovernor({
    budgets: {
      cpuSlots: 16,
      workerThreadSlots: 16,
      utilityProcessSlots: 4,
      ioHeavySlots: 16,
      memoryBytes: 4 * 1024 * 1024 * 1024
    }
  });
  return createExecutionSupervisor({
    policyRegistry,
    entryRegistry,
    validatorRegistry,
    resourceGovernor,
    executionTimeoutMs: 10000,
    shutdownTimeoutMs: 1000
  });
}

async function waitUntilRunning(supervisor, jobId) {
  for (let count = 0; count < 200; count += 1) {
    const diagnostics = supervisor.inspect(jobId);
    if (diagnostics && diagnostics.state === 'running') return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Canary job did not enter running state: ${jobId}`);
}

async function main() {
  const repoRoot = path.resolve(__dirname, '../..');
  const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
  const bundledPolicySchema = require.resolve(
    '../../src/main-process/background-execution/schemas/platform-contract-v1.schema.json'
  );
  const bundledProtocolSchema = require.resolve(
    '../../src/main-process/background-execution/schemas/platform-protocol-v1.schema.json'
  );

  assertTrue(packageJson.build.files.includes('src/**/*'), 'packaged build includes src/**/*');
  assertTrue(
    [bundledPolicySchema, bundledProtocolSchema, canary.PURE_COMPUTE_WORKER_ENTRY]
      .every((entry) => entry.startsWith(path.join(repoRoot, 'src')) && fs.existsSync(entry)),
    'schema and worker entries resolve only from packaged src tree'
  );
  assertEqual(canary.pureComputePolicy.production.enabled, false, 'pure compute canary remains production disabled');

  const supervisor = buildSupervisor();
  const completed = await supervisor.execute({
    actionKey: canary.PURE_COMPUTE_ACTION_KEY,
    operationKey: 'packaged-canary-complete',
    jobId: 'packaged-canary-complete-job',
    input: { values: [1, 2, 3], rounds: 20 }
  });
  assertEqual([completed.outcome, completed.terminalSource], ['completed', 'job:done'], 'real worker canary completes');
  assertEqual(completed.result, {
    checksum: 120630,
    count: 3,
    rounds: 20,
    sum: 6
  }, 'real worker result passes canonical result validator');

  const productionError = await supervisor.execute({
    actionKey: canary.PURE_COMPUTE_ACTION_KEY,
    operationKey: 'packaged-canary-production-gate',
    production: true,
    input: { values: [1], rounds: 1 }
  }).then(() => null, (error) => error);
  assertEqual(productionError && productionError.code, 'POLICY_PRODUCTION_DISABLED', 'production gate remains closed');

  const cancelJobId = 'packaged-canary-cancel-job';
  const cancellationExecution = supervisor.execute({
    actionKey: canary.PURE_COMPUTE_ACTION_KEY,
    operationKey: 'packaged-canary-cancel',
    jobId: cancelJobId,
    input: { values: new Array(100).fill(1), rounds: 1000000 }
  });
  await waitUntilRunning(supervisor, cancelJobId);
  const cancellationRequest = await supervisor.cancel(cancelJobId, { reason: 'packaged-canary-test' });
  const shutdownReport = await supervisor.shutdown({ timeoutMs: 1000 });
  const cancelled = await cancellationExecution;
  assertEqual(cancellationRequest.accepted, false, 'public cancellation rejects shutdown-only policy');
  assertEqual([cancelled.outcome, cancelled.terminalSource, cancelled.error.code], [
    'cancelled', 'job:error', 'CANARY_CANCELLED'
  ], 'shutdown-only real worker cancellation settles once through canonical terminal');
  assertEqual(shutdownReport, {
    closedServices: [],
    cancelledJobs: [cancelJobId],
    protectedJobs: [],
    interruptedTasks: [],
    activeHolds: [],
    leakedTransports: [],
    errors: []
  }, 'idle supervisor shutdown report uses authoritative fields');

  if (failures.length) {
    console.error('FAILURES:', JSON.stringify(failures, null, 2));
    process.exitCode = 1;
  }
  console.log(`==== ${passed}/${passed + failures.length} PASS ====`);
}

main().catch((error) => {
  console.error(error && error.stack || error);
  process.exitCode = 1;
});
