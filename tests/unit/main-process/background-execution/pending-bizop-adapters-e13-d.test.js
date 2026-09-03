'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { DatabaseSync } = require('node:sqlite');

const {
  PENDING_BIZOP_ADAPTER_ACTIONS,
  PENDING_BIZOP_ADAPTER_POLICIES,
  validatePendingBizOpAdapterResult
} = require('../../../../src/main-process/background-execution/pending-bizop-adapter-policies');
const {
  BACKGROUND_EXECUTION_POLICIES,
  createNonProductionBackgroundExecutionRuntime
} = require('../../../../src/main-process/background-execution/runtime');
const {
  createResourceGovernor
} = require('../../../../src/main-process/background-execution/resource-governor');
const {
  createMatureActionAdapterBindings
} = require('../../../../src/main-process/background-execution/mature-action-adapters');
const {
  bindingSnapshot
} = require('../../../../src/main-process/background-execution/action-task-binding-registry');
const bigTableFixtures = require('../../backend/big-table-import/_fixtures');

const CANONICAL_POLICY_FIXTURE = path.resolve(
  __dirname,
  '../../../../changes/background-execution-v3.2.x-contract-baseline/changes/background-execution/validation/fixtures/valid/policy-registry.v3.2.x.json'
);

function expectedFalseGatedPolicy(actionKey) {
  const fixture = JSON.parse(fs.readFileSync(CANONICAL_POLICY_FIXTURE, 'utf8'));
  const expected = structuredClone(fixture.actions[actionKey]);
  expected.production = {
    enabled: false,
    effectiveMode: 'legacy',
    effectiveWorkerCount: 0,
    recoveryStatus: 'probe',
    evidenceStatus: 'baseline',
    downgradeReason: 'PENDING_HUMAN_REVIEW',
    benchmarkEvidenceId: null
  };
  return expected;
}

function createBatchContext(operationKey) {
  return Object.freeze({
    batchId: 32513,
    batchNumber: '2026-08-30-32513',
    taskRunId: 'task-e13-d-runtime',
    taskKey: 'pending:import:start',
    moduleId: 'pending-reconciliation',
    parentRunId: 'parent-e13-d-runtime',
    operationKey
  });
}

function createRuntimeImportDatabase(dir) {
  const dbPath = path.join(dir, 'runtime.sqlite');
  const db = new DatabaseSync(dbPath);
  db.exec('CREATE TABLE imported_rows (id INTEGER PRIMARY KEY AUTOINCREMENT, d TEXT, k TEXT UNIQUE, amount TEXT);');
  db.prepare('INSERT INTO imported_rows (d, k, amount) VALUES (?, ?, ?)')
    .run('2026-08-01', 'OLD', '99');
  db.close();
  return dbPath;
}

function writeRuntimeContract(dir) {
  const contractPath = path.join(dir, 'runtime-contract.js');
  fs.writeFileSync(contractPath, `'use strict';
module.exports = function createContract() {
  return {
    expectedHeaders: ['日期', '主键', '金额'],
    valueColumnWhitelist: null,
    validateHeaders(cells) {
      return cells[0] === '日期' && cells[1] === '主键' && cells[2] === '金额'
        ? { ok: true }
        : { ok: false, error: '表头不匹配', detailLines: [] };
    },
    mapRow({ values }) {
      const key = String(values[1] || '').trim();
      return key
        ? { params: [values[0], key, values[2]] }
        : { error: { reason: '主键为空' } };
    },
    insertSql: 'INSERT INTO imported_rows (d, k, amount) VALUES (?, ?, ?)',
    requiredColumns: [0, 1, 2],
    monthKeyOf({ values }) { return String(values[0]).slice(0, 7); },
    deleteSqlForOverwrite: 'DELETE FROM imported_rows WHERE d LIKE ?',
    deleteParamsFromMonthKey(monthKey) { return [monthKey + '%']; }
  };
};
`, 'utf8');
  return contractPath;
}

function readRuntimeRows(dbPath) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const rows = db.prepare('SELECT d, k, amount FROM imported_rows ORDER BY id').all()
    .map((row) => ({ d: row.d, k: row.k, amount: row.amount }));
  db.close();
  return rows;
}

test.after(() => bigTableFixtures.cleanupTmpDirs());

test('E13-D 两条 policy 除 production gate 外逐字段匹配冻结 canonical fixture', () => {
  assert.equal(PENDING_BIZOP_ADAPTER_POLICIES.length, 2);
  for (const policy of PENDING_BIZOP_ADAPTER_POLICIES) {
    assert.deepEqual(policy, expectedFalseGatedPolicy(policy.actionKey));
    assert.equal(policy.adapterKind, 'existing-dispatch');
    assert.equal(policy.entryKey, null);
    assert.equal(policy.commit.kind, 'existing-critical-protocol');
    assert.equal(policy.production.enabled, false);
    assert.equal(policy.production.effectiveMode, 'legacy');
    assert.equal(policy.production.effectiveWorkerCount, 0);
  }
});

test('E13-D 真实 runtime 注册 adapter/topology/validator 且默认 IPC binding 不漂移', async (t) => {
  const runtime = createNonProductionBackgroundExecutionRuntime({
    resourceGovernor: createResourceGovernor({
      budgets: {
        cpuSlots: 8,
        workerThreadSlots: 8,
        utilityProcessSlots: 0,
        ioHeavySlots: 8,
        memoryBytes: 4 * 1024 ** 3
      }
    }),
    workerThreadAdapter: {
      start() { throw new Error('existing-dispatch 外层不得创建 native wrapper Worker'); }
    }
  });
  t.after(async () => { await runtime.shutdown({ timeoutMs: 10000 }); });

  const runtimePolicies = new Map(BACKGROUND_EXECUTION_POLICIES.map((policy) => [policy.actionKey, policy]));
  const bindings = bindingSnapshot();
  assert.deepEqual(bindings[PENDING_BIZOP_ADAPTER_ACTIONS.PENDING_IMPORT], ['pending:import:start']);
  assert.deepEqual(bindings[PENDING_BIZOP_ADAPTER_ACTIONS.BIZ_OP_IMPORT_FLOW], ['bizOpRecon:import:run-flow']);

  for (const policy of PENDING_BIZOP_ADAPTER_POLICIES) {
    assert.deepEqual(runtimePolicies.get(policy.actionKey), policy);
    const adapter = runtime.policyRegistry.getBinding(policy.actionKey, 'adapterKey');
    const topology = runtime.policyRegistry.getBinding(
      policy.actionKey,
      'resources.compound.topologyKey'
    );
    const validator = runtime.policyRegistry.getBinding(policy.actionKey, 'result.validatorKey');
    assert.equal(typeof adapter.dispatch, 'function');
    assert.equal(typeof adapter.inspectTopology, 'function');
    assert.equal(typeof topology, 'function');
    assert.equal(validator, validatePendingBizOpAdapterResult);
    assert.equal(runtime.policyRegistry.get(policy.actionKey).production.enabled, false);
  }

  assert.throws(
    () => runtime.policyRegistry.assertRunnable(
      PENDING_BIZOP_ADAPTER_ACTIONS.PENDING_IMPORT,
      { production: true }
    ),
    { code: 'POLICY_PRODUCTION_DISABLED' }
  );
});

test('E13-D mature adapter 以 envelope exact-7 为唯一 engine 身份并拒绝 caller 分叉', async () => {
  const operationKey = 'operation-e13-d-context-authority';
  const authoritative = createBatchContext(operationKey);
  const calls = [];
  const adapter = createMatureActionAdapterBindings({
    bigTable: {
      pending: {
        dispatch(request) {
          calls.push(request);
          return { promise: Promise.resolve({}) };
        }
      }
    }
  })[PENDING_BIZOP_ADAPTER_ACTIONS.PENDING_IMPORT];
  const request = {
    context: { kind: 'file-batch', value: authoritative },
    input: { files: ['one.xlsx'] },
    topology: { effectiveChildCount: 1 }
  };

  const handle = adapter.dispatch(request);
  await handle.promise;
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].batchContext, authoritative);
  assert.equal(Object.isFrozen(calls[0].batchContext), true);

  assert.throws(
    () => adapter.dispatch({
      ...request,
      input: {
        ...request.input,
        batchContext: { ...authoritative, taskRunId: 'caller-owned-task' }
      }
    }),
    { code: 'BIG_TABLE_ADAPTER_BATCH_CONTEXT_MISMATCH' }
  );
  assert.equal(calls.length, 1, '身份分叉必须在启动旧 dispatcher 前 fail closed');
});

test('E13-D 真实 runtime 直接调用既有 engine，CompoundLease 冻结 topology 且单事务覆盖', async (t) => {
  const dir = bigTableFixtures.mkTmpDir('e13-d-runtime-');
  const dbPath = createRuntimeImportDatabase(dir);
  const contractModulePath = writeRuntimeContract(dir);
  const filePath = await bigTableFixtures.writeFixtureExcelJS({
    rows: [
      ['日期', '主键', '金额'],
      ['2026-08-02', 'NEW-1', '12.34'],
      ['2026-08-03', 'NEW-2', '56.78']
    ]
  });
  let wrapperStarts = 0;
  const governor = createResourceGovernor({
    budgets: {
      cpuSlots: 8,
      workerThreadSlots: 8,
      utilityProcessSlots: 0,
      ioHeavySlots: 8,
      memoryBytes: 4 * 1024 ** 3
    }
  });
  const runtime = createNonProductionBackgroundExecutionRuntime({
    resourceGovernor: governor,
    workerThreadAdapter: {
      start() {
        wrapperStarts += 1;
        throw new Error('existing-dispatch 外层不得创建 native wrapper Worker');
      }
    }
  });
  t.after(async () => { await runtime.shutdown({ timeoutMs: 10000 }); });
  const operationKey = 'operation-e13-d-runtime-import';
  const batchContext = createBatchContext(operationKey);
  const execution = await runtime.execute({
    actionKey: PENDING_BIZOP_ADAPTER_ACTIONS.PENDING_IMPORT,
    operationKey,
    jobId: 'job-e13-d-runtime-import',
    production: false,
    context: { kind: 'file-batch', value: batchContext },
    input: {
      dbPath,
      files: [filePath],
      contractModulePath,
      contractOptions: {},
      mode: 'overwrite',
      monthKey: '2026-08',
      batchContext
    }
  });

  assert.equal(execution.outcome, 'completed');
  assert.equal(execution.terminalSource, 'job:done');
  assert.deepEqual(execution.result, {
    monthKey: '2026-08',
    fileCount: 1,
    totalImported: 2,
    deletedCount: 1,
    maxParallel: 1
  });
  assert.equal(wrapperStarts, 0);
  assert.deepEqual(readRuntimeRows(dbPath), [
    { d: '2026-08-02', k: 'NEW-1', amount: '12.34' },
    { d: '2026-08-03', k: 'NEW-2', amount: '56.78' }
  ]);
  assert.deepEqual(governor.snapshot().activeUsage, {
    cpuSlots: 0,
    workerThreadSlots: 0,
    utilityProcessSlots: 0,
    ioHeavySlots: 0,
    memoryBytes: 0
  });
});

test('E13-D engine result validator 拒绝夹带、负数与不可能并行度', () => {
  const valid = {
    monthKey: null,
    fileCount: 2,
    totalImported: 10,
    deletedCount: 4,
    maxParallel: 2
  };
  assert.equal(validatePendingBizOpAdapterResult(valid), true);
  assert.equal(validatePendingBizOpAdapterResult({ ...valid, injected: true }), false);
  assert.equal(validatePendingBizOpAdapterResult({ ...valid, totalImported: -1 }), false);
  assert.equal(validatePendingBizOpAdapterResult({ ...valid, maxParallel: 3 }), false);
});
