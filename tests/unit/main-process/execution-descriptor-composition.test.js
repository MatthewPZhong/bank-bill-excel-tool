'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const test = require('node:test');
const acorn = require('acorn');
const {
  composeExecutionDescriptors, createExecutionTaskComposition,
  createApplicationRecoveryComposition
} = require('../../../src/main-process/execution-descriptors/composition');
const { RECOVERY_PARTICIPANT_ORDER } = require('../../../src/main-process/application-recovery/composition');
const { createPositionTaskOwner } = require('../../../src/main-process/position-reconciliation/task-owner');
const { createPendingTerminalRouteRegistration } = require('../../../src/main-process/pending-archive-lineage');
const { createPreFundTerminalRouteRegistration } = require('../../../src/main-process/pre-fund-archive-lineage');
const { createBizOpRunTerminalRouteRegistration } = require('../../../src/main-process/biz-op-recon-run-data');
const toolboxDescriptor = require('../../../src/main-process/toolbox-background/execution-descriptor');
const REPOSITORY = path.resolve(__dirname, '../../..');
const ROUTES = ['biz-op-run', 'pending-run', 'position-reconciliation', 'pre-fund-run'];
const ADAPTERS = ['passthrough', 'position-reconciliation', 'toolbox', 'vcc-financial-op'];
const EXPECTED_RECOVERY_ORDER = [
  'biz-op-v327', 'pending-runs', 'legacy-biz-op-runs', 'pre-fund-runs',
  'position', 'toolbox-vcc-publications', 'vcc-import-terminal', 'vcc-import-lineage'
];

function taskContext(effects = []) {
  const unexpected = (name) => () => { effects.push(name); throw new Error(`装配不应执行 ${name}`); };
  const positionOwner = createPositionTaskOwner(Object.fromEntries([
    'readSetting', 'writeSetting', 'settingsAvailable', 'getDatabasePath', 'getCurrentService',
    'getService', 'getArchiveCenter', 'initializeArchiveCenter', 'getTaskLifecycle',
    'getTaskPolicy', 'supportsArchiveChannel'
  ].map((name) => [name, unexpected(`position.${name}`)])));
  return {
    positionOwner,
    acknowledgeReceipts: unexpected('acknowledgeReceipts'),
    reportArchiveFailure: unexpected('reportArchiveFailure'),
    terminalRoutes: [
      positionOwner.terminalRegistration,
      createPendingTerminalRouteRegistration({ getDb: unexpected('pending.getDb') }),
      createBizOpRunTerminalRouteRegistration({
        getUserDataDir: unexpected('bizOp.getUserDataDir'), getMainDb: unexpected('bizOp.getMainDb'),
        assertLegacyAvailable: unexpected('bizOp.assertLegacyAvailable'),
        withLegacyRecovery: unexpected('bizOp.withLegacyRecovery')
      }),
      createPreFundTerminalRouteRegistration({ getService: unexpected('preFund.getService') })
    ]
  };
}

function recoveryContext(events = [], options = {}) {
  let facade;
  const owner = (name) => async () => { events.push(name); return { recovered: 0 }; };
  return {
    platform: {
      async scanAndRecover() {
        events.push('platform-scan');
        if (options.scanError) throw options.scanError;
        return { recovered: 0 };
      },
      recoverSource: owner('recover-source')
    },
    bizOpModule: {
      recovery: {
        bindPlatform(value) { events.push('bind-platform'); facade = value; },
        async run(input = {}) {
          if (input.initialPlatformOnly) {
            events.push('biz-op-preflight');
            await facade.scanAndRecover();
            return { reason: 'ARCHIVE_OWNER_PHASE_REQUIRED' };
          }
          events.push('biz-op-v327');
          return { recovered: 0 };
        },
        openObligations: () => true
      },
      activation: { needed: () => false, run: owner('unexpected-activation') },
      retryRecovery: owner('unexpected-retry')
    },
    onBizOpRecovery: () => { events.push('on-biz-op-recovery'); },
    recoverPendingRuns: owner('pending-runs'),
    recoverLegacyBizOpRuns: owner('legacy-biz-op-runs'),
    recoverPreFundRuns: owner('pre-fund-runs'),
    recoverPosition: owner('position'),
    recoverToolboxVccPublications: owner('toolbox-vcc-publications'),
    recoverVccImportTerminal: owner('vcc-import-terminal'),
    reconcileVccImportLineage: owner('vcc-import-lineage')
  };
}

function withChangedToolbox(t, change, work) {
  const original = toolboxDescriptor.createModuleExecutionDescriptor;
  const mocked = t.mock.method(toolboxDescriptor, 'createModuleExecutionDescriptor', (context) => change(original(context)));
  try { return work(); } finally { mocked.mock.restore(); }
}

test('实际 G2 装配覆盖全部 134 个 taskKey、四 adapter 和四历史 route，装配不调用 owner', () => {
  const effects = [];
  const compiled = createExecutionTaskComposition(taskContext(effects));
  const policies = compiled.archivePolicies.filter((policy) => policy.batchPolicy !== 'exclude');
  assert.equal(policies.length, 134);
  assert.equal(compiled.taskBindings.length, 134);
  assert.deepEqual(compiled.taskBindings.map((binding) => binding.taskKey).sort(), policies.map((policy) => policy.taskKey).sort());
  assert.deepEqual(compiled.taskAdapters.map((adapter) => adapter.id).sort(), ADAPTERS);
  assert.deepEqual(compiled.terminalRoutes.map((entry) => entry.route).sort(), ROUTES);
  const scopeAdapters = {
    'position-reconciliation-process': 'position-reconciliation', toolbox: 'toolbox',
    'vcc-financial-op': 'vcc-financial-op'
  };
  for (const policy of policies) {
    assert.equal(compiled.taskAdapterRegistry.resolve(policy.taskKey).id, scopeAdapters[policy.scopeId] || 'passthrough', policy.taskKey);
  }
  for (const route of ROUTES) {
    const identity = route === 'position-reconciliation' ? { operationToken: 'historical-operation' } : { taskRunId: 'historical-task' };
    assert.deepEqual(compiled.terminalRouteRegistry.normalize({ route, ...identity }), { route, ...identity });
  }
  for (const field of ['taskAdapters', 'taskBindings', 'terminalRoutes']) {
    assert.equal(Object.isFrozen(compiled[field]), true);
    assert.equal(compiled[field].every(Object.isFrozen), true);
  }
  assert.deepEqual(effects, []);
});

test('生产 composition 对 taskKey 重复、缺失、多余和 exclude 误绑定均失败关闭', (t) => {
  const cases = [
    { mutate: (source) => ({ ...source, taskBindings: [...source.taskBindings, source.taskBindings[0]] }), code: 'EXECUTION_DESCRIPTOR_DUPLICATE' },
    { mutate: (source) => ({ ...source, taskBindings: source.taskBindings.slice(1) }), code: 'TASK_ADAPTER_UNBOUND' },
    { mutate: (source) => ({ ...source, taskBindings: [...source.taskBindings, { taskKey: 'unregistered:task', adapterId: 'toolbox' }] }), code: 'EXECUTION_DESCRIPTOR_REFERENCE_MISSING' },
    { mutate: (source) => ({ ...source, taskBindings: [...source.taskBindings, { taskKey: 'toolbox:split:read', adapterId: 'toolbox' }] }), code: 'EXECUTION_DESCRIPTOR_REFERENCE_MISSING' }
  ];
  for (const { mutate, code } of cases) {
    const effects = [];
    withChangedToolbox(t, mutate, () => {
      assert.throws(() => createExecutionTaskComposition(taskContext(effects)), (error) => error.code === code);
    });
    assert.deepEqual(effects, []);
  }
});

test('历史 routes 必须完整且不重复；缺少 route 的失败不触发领域恢复', () => {
  for (const [mutate, expectedCode] of [
    [(routes) => routes.slice(1), 'EXECUTION_DESCRIPTOR_REFERENCE_MISSING'],
    [(routes) => [...routes, routes[0]], 'EXECUTION_DESCRIPTOR_REFERENCE_MISSING'],
    [(routes) => [routes[0], routes[0], routes[2], routes[3]], 'EXECUTION_DESCRIPTOR_DUPLICATE'],
    [(routes) => [{ ...routes[0], route: 'unknown-route' }, ...routes.slice(1)], 'EXECUTION_DESCRIPTOR_INVALID']
  ]) {
    const effects = [];
    const context = taskContext(effects);
    context.terminalRoutes = mutate(context.terminalRoutes);
    assert.throws(() => createExecutionTaskComposition(context), (error) => error.code === expectedCode);
    assert.deepEqual(effects, []);
  }
});

test('G1 按固定顺序执行原 coordinator 全阶段，descriptor 枚举顺序无阶段含义', async () => {
  const events = [];
  const context = recoveryContext(events);
  const compiled = composeExecutionDescriptors({ recoveryContext: context, availableParallelism: 4 });
  assert.deepEqual(RECOVERY_PARTICIPANT_ORDER, EXPECTED_RECOVERY_ORDER);
  assert.notDeepEqual(compiled.recoveryParticipants.map((entry) => entry.id), EXPECTED_RECOVERY_ORDER);
  assert.deepEqual([...compiled.recoveryParticipants.map((entry) => entry.id)].sort(), [...EXPECTED_RECOVERY_ORDER].sort());
  assert.deepEqual(events, []);
  const coordinator = createApplicationRecoveryComposition(context);
  assert.deepEqual(events, ['bind-platform']);
  await Promise.all([coordinator.preflight(), coordinator.preflight()]);
  assert.equal(coordinator.snapshot().phase, 'archive');
  for (const hook of coordinator.archiveOwnerHooks()) {
    await Promise.all([hook.recover(), hook.recover()]);
  }
  for (const hook of coordinator.postOutboxHooks()) {
    await Promise.all([hook.run(), hook.run()]);
  }
  coordinator.completeArchiveInitialization();
  assert.deepEqual(coordinator.snapshot(), { phase: 'ready', platformScanCompleted: true, failureCode: null });
  assert.deepEqual(events, [
    'bind-platform', 'biz-op-preflight', 'platform-scan', 'biz-op-v327', 'on-biz-op-recovery',
    ...EXPECTED_RECOVERY_ORDER.slice(1)
  ]);
  const before = [...events];
  await coordinator.preflight();
  for (const hook of coordinator.archiveOwnerHooks()) await hook.recover();
  for (const hook of coordinator.postOutboxHooks()) await hook.run();
  coordinator.completeArchiveInitialization();
  assert.deepEqual(events, before);
});

test('G1 participant 缺失/重复/额外身份在 bindPlatform 与恢复副作用前拒绝', (t) => {
  for (const [mutate, expectedCode] of [
    [(source) => ({ ...source, recoveryParticipants: [] }), 'EXECUTION_DESCRIPTOR_REFERENCE_MISSING'],
    [(source) => ({ ...source, recoveryParticipants: [...source.recoveryParticipants, source.recoveryParticipants[0]] }), 'EXECUTION_DESCRIPTOR_DUPLICATE'],
    [(source) => ({ ...source, recoveryParticipants: [...source.recoveryParticipants,
      { id: 'unexpected-owner', ownerName: 'Unexpected', preflight: null, recoverOwner: null, postOutbox: null }] }), 'EXECUTION_DESCRIPTOR_REFERENCE_MISSING']
  ]) {
    const events = [];
    withChangedToolbox(t, mutate, () => {
      assert.throws(() => createApplicationRecoveryComposition(recoveryContext(events)), (error) => error.code === expectedCode);
    });
    assert.deepEqual(events, []);
  }
});

test('G1 原失败状态和完整扫描屏障保持，编译不替代恢复', async () => {
  const events = [];
  const scanError = Object.assign(new Error('扫描失败'), { code: 'RECOVERY_SCAN_TEST_FAILED' });
  const failed = createApplicationRecoveryComposition(recoveryContext(events, { scanError }));
  await assert.rejects(failed.preflight(), (error) => error === scanError);
  assert.deepEqual(failed.snapshot(), { phase: 'failed', platformScanCompleted: false, failureCode: 'RECOVERY_SCAN_TEST_FAILED' });
  assert.deepEqual(events, ['bind-platform', 'biz-op-preflight', 'platform-scan']);
  const pending = createApplicationRecoveryComposition(recoveryContext([]));
  assert.throws(() => pending.completeArchiveInitialization(), (error) => error.code === 'BACKGROUND_RECOVERY_SCAN_PENDING');
});

test('隔离进程只读取 policy-catalog 不载入 descriptor 工厂、数据库或 worker 引擎', () => {
  const script = `
    const assert = require('node:assert/strict');
    const Module = require('node:module');
    const originalLoad = Module._load;
    const loaded = [];
    Module._load = function(request, parent, isMain) {
      if (['node:sqlite', 'node:worker_threads', 'worker_threads', 'node:child_process', 'child_process', 'electron'].includes(request)) {
        throw new Error('policy catalog 触发运行能力：' + request);
      }
      const resolved = Module._resolveFilename(request, parent, isMain);
      if (typeof resolved === 'string') loaded.push(resolved);
      if (/execution-descriptor\\.js$|execution-descriptors\\/composition\\.js$|background-execution\\/(runtime|supervisor)\\.js$|backend\\/database/.test(resolved)) {
        throw new Error('policy catalog 反向装配：' + resolved);
      }
      return originalLoad.apply(this, arguments);
    };
    const catalog = require('./src/main-process/execution-descriptors/policy-catalog');
    assert.equal(catalog.BACKGROUND_EXECUTION_POLICIES.length, 49);
    assert.equal(catalog.BACKGROUND_EXECUTION_POLICIES.filter((policy) => policy.production.enabled).length, 13);
    assert.equal(Object.isFrozen(catalog.BACKGROUND_EXECUTION_POLICIES), true);
    console.log(JSON.stringify({ policies: 49, productionEnabled: 13, loadedModules: loaded.length }));
  `;
  const result = JSON.parse(execFileSync(process.execPath, ['-e', script], { cwd: REPOSITORY, encoding: 'utf8' }));
  assert.equal(result.policies, 49);
  assert.equal(result.productionEnabled, 13);
});

function visitAst(node, visit) {
  if (!node || typeof node !== 'object') return;
  visit(node);
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) value.forEach((entry) => visitAst(entry, visit));
    else if (value && typeof value === 'object') visitAst(value, visit);
  }
}
function relativeRequires(source) {
  const result = [];
  const ast = acorn.parse(source, { ecmaVersion: 'latest', sourceType: 'script' });
  visitAst(ast, (node) => {
    if (node.type !== 'CallExpression') return;
    const callee = node.callee;
    const requireCall = callee.type === 'Identifier' && callee.name === 'require';
    const requireResolve = callee.type === 'MemberExpression' && callee.object.type === 'Identifier'
      && callee.object.name === 'require' && callee.property.name === 'resolve';
    const value = node.arguments[0];
    if ((requireCall || requireResolve) && value && value.type === 'Literal'
        && typeof value.value === 'string' && value.value.startsWith('.')) result.push(value.value);
  });
  return result;
}
function publicDependencyViolations(roots, read, resolve) {
  const allowed = (file) => file.startsWith('src/main-process/background-execution/')
    || file.startsWith('src/main-process/archive-center/')
    || file === 'src/main-process/execution-descriptors/contract.js';
  const seen = new Set();
  const violations = [];
  function traverse(file, chain) {
    if (seen.has(file)) return;
    seen.add(file);
    if (!file.endsWith('.js')) return;
    for (const request of relativeRequires(read(file))) {
      const target = resolve(file, request);
      const next = [...chain, target];
      if (!allowed(target)) violations.push(next);
      else traverse(target, next);
    }
  }
  roots.forEach((root) => traverse(root, [root]));
  return { violations, seen };
}

// 这是本分支的具体边界回归，不代表尚未集成的 G8 配置已经 active。
test('五个公共机制入口的传递 require 图没有领域或 composition/catalog 回边', () => {
  const roots = [
    'background-execution/runtime.js', 'background-execution/execution-policy-registry.js',
    'archive-center/task-policy-registry.js', 'archive-center/task-policy-common.js',
    'execution-descriptors/contract.js'
  ].map((file) => `src/main-process/${file}`);
  const result = publicDependencyViolations(roots,
    (file) => fs.readFileSync(path.join(REPOSITORY, file), 'utf8'),
    (from, request) => path.relative(REPOSITORY, require.resolve(path.resolve(REPOSITORY, path.dirname(from), request))).split(path.sep).join('/'));
  assert.deepEqual(result.violations, []);
  assert.ok(result.seen.has('src/main-process/background-execution/supervisor.js'));
  assert.ok(result.seen.has('src/main-process/archive-center/task-file-plan-registry.js'));
});

test('Acorn 边界探针正反例：忽略字符串/注释，捕捉 helper 间接领域或装配回边', () => {
  const root = 'src/main-process/background-execution/runtime.js';
  const helper = 'src/main-process/background-execution/helper.js';
  const files = {
    [root]: "const text = \"require('../new-account/policies')\"; /* require('../execution-descriptors/composition') */ require('./helper');",
    [helper]: "require('../archive-center/task-policy-registry');",
    'src/main-process/archive-center/task-policy-registry.js': 'module.exports = {};'
  };
  const read = (file) => files[file];
  const resolve = (from, request) => `${path.posix.normalize(path.posix.join(path.posix.dirname(from), request))}.js`;
  assert.deepEqual(publicDependencyViolations([root], read, resolve).violations, []);
  for (const target of ['../new-account/policies', '../execution-descriptors/composition', '../execution-descriptors/policy-catalog']) {
    files[helper] = `require.resolve('${target}');`;
    const result = publicDependencyViolations([root], read, resolve);
    assert.equal(result.violations.length, 1);
    assert.deepEqual(result.violations[0].slice(0, 2), [root, helper]);
    assert.equal(result.violations[0][2], resolve(helper, target));
  }
});
