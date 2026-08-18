'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const acorn = require('acorn');

const {
  EXCLUDED_CHANNELS_BY_REASON,
  EXCLUDE_REASONS,
  FILE_ACTION_CHANNELS,
  NO_FILE_ACTION_CHANNELS,
  SUPPORT_ACTION_POLICIES,
  bankBuImportResultFlowIdentities,
  bankBuRunFlowPlan,
  createBankStatementRunFlowIdentity,
  createTaskPolicyRegistry,
  statementResultClassifier
} = require('../../../src/main-process/archive-center/task-policy-registry');
const {
  FILE_CHANNELS
} = require('../../../src/main-process/archive-center/operation-tracker');

const MAIN_PATH = path.join(__dirname, '..', '..', '..', 'src', 'main.js');
const PRELOAD_PATH = path.join(__dirname, '..', '..', '..', 'src', 'preload.js');
const CONTROLLED_HELPERS = new Set([
  'trackedIpcHandle',
  'businessIpcHandle',
  'dynamicTrackedIpcHandle',
  'supportIpcHandle'
]);
const ALL_HELPERS = new Set([...CONTROLLED_HELPERS, 'archiveCenterMutationIpcHandle']);

function walk(node, visitor, functionName = '') {
  if (!node || typeof node !== 'object') return;
  const nextFunctionName = node.type === 'FunctionDeclaration' && node.id
    ? node.id.name
    : functionName;
  visitor(node, nextFunctionName);
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) {
      for (const child of value) walk(child, visitor, nextFunctionName);
    } else if (value && typeof value === 'object' && value.type) {
      walk(value, visitor, nextFunctionName);
    }
  }
}

function mainIpcInventory() {
  const source = fs.readFileSync(MAIN_PATH, 'utf8');
  const ast = acorn.parse(source, {
    ecmaVersion: 'latest',
    sourceType: 'script',
    locations: true
  });
  const registrations = [];
  walk(ast, (node) => {
    if (node.type !== 'CallExpression') return;
    const first = node.arguments[0];
    if (!first || first.type !== 'Literal' || typeof first.value !== 'string') return;
    if (node.callee.type === 'Identifier' && ALL_HELPERS.has(node.callee.name)) {
      registrations.push({ channel: first.value, kind: node.callee.name, line: node.loc.start.line });
      return;
    }
    const callee = node.callee;
    if (callee.type === 'MemberExpression'
        && callee.object.type === 'Identifier'
        && callee.object.name === 'ipcMain'
        && callee.property.type === 'Identifier'
        && callee.property.name === 'handle') {
      registrations.push({ channel: first.value, kind: 'ipcMain.handle', line: node.loc.start.line });
    }
  });
  return registrations;
}

function literalInvocations(filePath, objectName, methodName) {
  const source = fs.readFileSync(filePath, 'utf8');
  const ast = acorn.parse(source, { ecmaVersion: 'latest', sourceType: 'script' });
  const channels = [];
  walk(ast, (node) => {
    if (node.type !== 'CallExpression') return;
    const callee = node.callee;
    const first = node.arguments[0];
    if (callee.type === 'MemberExpression'
        && callee.object.type === 'Identifier'
        && callee.object.name === objectName
        && callee.property.type === 'Identifier'
        && callee.property.name === methodName
        && first && first.type === 'Literal' && typeof first.value === 'string') {
      channels.push(first.value);
    }
  });
  return channels.sort();
}

test('main literal IPC 与 policy/support 精确相等', () => {
  const inventory = mainIpcInventory();
  const registry = createTaskPolicyRegistry();
  const actual = inventory.map((item) => item.channel).sort();
  const expected = [
    ...registry.channels(),
    ...SUPPORT_ACTION_POLICIES.map((policy) => policy.channel)
  ].sort();
  assert.equal(new Set(actual).size, actual.length, 'main 不应重复注册 literal IPC');
  assert.equal(new Set(expected).size, expected.length, 'policy/support 不应重复登记');
  assert.deepEqual(expected, actual);
  assert.equal(actual.length, 241);
  assert.equal(registry.channels('reserve').length, 63);
  assert.equal(registry.channels('no-file').length, 59);
  assert.equal(registry.channels('exclude').length, 117);
  assert.equal(SUPPORT_ACTION_POLICIES.length, 2);
});

test('preload 暴露集合与 main literal inventory 精确相等', () => {
  assert.deepEqual(
    [...new Set(literalInvocations(PRELOAD_PATH, 'ipcRenderer', 'invoke'))].sort(),
    [...new Set(mainIpcInventory().map((item) => item.channel))].sort()
  );
});

test('非 literal direct ipcMain.handle 只存在于已知受控 helper 定义', () => {
  const source = fs.readFileSync(MAIN_PATH, 'utf8');
  const ast = acorn.parse(source, { ecmaVersion: 'latest', sourceType: 'script', locations: true });
  const direct = [];
  walk(ast, (node, functionName) => {
    if (node.type !== 'CallExpression') return;
    const callee = node.callee;
    const first = node.arguments[0];
    if (callee.type === 'MemberExpression'
        && callee.object.type === 'Identifier'
        && callee.object.name === 'ipcMain'
        && callee.property.type === 'Identifier'
        && callee.property.name === 'handle'
        && (!first || first.type !== 'Literal')) {
      direct.push(`${functionName}@${node.loc.start.line}`);
    }
  });
  assert.deepEqual(direct.map((item) => item.split('@')[0]).sort(), [
    'archiveCenterMutationIpcHandle',
    'businessIpcHandle',
    'dynamicTrackedIpcHandle',
    'supportIpcHandle',
    'trackedIpcHandle'
  ]);
});

test('reserve policy 只能经受控 helper，裸 IPC 只能是明确 exclude', () => {
  const registry = createTaskPolicyRegistry();
  const support = new Set(SUPPORT_ACTION_POLICIES.map((policy) => policy.channel));
  const violations = [];
  for (const registration of mainIpcInventory()) {
    const policy = registry.get(registration.channel);
    if (support.has(registration.channel)) {
      if (registration.kind !== 'supportIpcHandle') {
        violations.push(`${registration.channel}@${registration.line}:support-helper-required`);
      }
      continue;
    }
    if (['reserve', 'no-file'].includes(policy.batchPolicy)
        && !CONTROLLED_HELPERS.has(registration.kind)) {
      violations.push(`${registration.channel}@${registration.line}:${registration.kind}`);
    }
    if (registration.kind === 'ipcMain.handle' && policy.batchPolicy !== 'exclude') {
      violations.push(`${registration.channel}@${registration.line}:raw-without-exclude`);
    }
  }
  assert.deepEqual(violations, []);
});

test('5 个真实 exclude 入口均为裸 IPC，不会误入 reserve wrapper', () => {
  const expected = [
    'duplicate-inbound-match:session-status',
    'file:extract-big-account-order',
    'position-reconciliation:bank:prepare-import',
    'pre-fund-reconciliation:session-status',
    'pre-fund-reconciliation:temp:list'
  ];
  const byChannel = new Map(mainIpcInventory().map((item) => [item.channel, item]));
  const registry = createTaskPolicyRegistry();
  for (const channel of expected) {
    assert.equal(registry.require(channel).batchPolicy, 'exclude', channel);
    assert.equal(byChannel.get(channel).kind, 'ipcMain.handle', channel);
  }
  assert.equal(
    registry.require('file:extract-big-account-order').excludeReason,
    'preview-only'
  );
  assert.equal(
    registry.require('position-reconciliation:bank:prepare-import').excludeReason,
    'staging-preflight-only'
  );
});

test('exclude 只允许有限原因，所有 policy 都是 literal 且无 wildcard', () => {
  const registry = createTaskPolicyRegistry();
  const reasons = new Set(EXCLUDE_REASONS);
  for (const policy of registry.list()) {
    assert.doesNotMatch(policy.channel, /[*?]/);
    if (policy.batchPolicy === 'exclude') {
      assert.equal(reasons.has(policy.excludeReason), true, policy.channel);
    } else {
      assert.equal(['reserve', 'no-file'].includes(policy.batchPolicy), true);
      assert.equal(typeof policy.resultClassifier, 'function');
      assert.equal(typeof policy.startsNewFlow, 'boolean');
      if (policy.taskKind === 'file') {
        assert.equal(typeof policy.filePlanResolver, 'function', policy.channel);
        assert.ok(policy.filePlanSourceKind, policy.channel);
        assert.equal(['eager', 'deferred'].includes(policy.allocation), true, policy.channel);
      } else {
        assert.equal(policy.taskKind, 'no-file');
        assert.equal(policy.allocation, 'none');
        assert.equal(policy.filePlanResolver, null);
      }
    }
  }
});

test('63 file 与 59 no-file mutation 逐项显式分类且精确闭合', () => {
  const registry = createTaskPolicyRegistry();
  const fileChannels = new Set(FILE_ACTION_CHANNELS);
  const noFileChannels = new Set(NO_FILE_ACTION_CHANNELS);
  const excludeInventory = Object.values(EXCLUDED_CHANNELS_BY_REASON).flat();
  const excludeChannels = new Set(excludeInventory);
  assert.equal(fileChannels.size, 63);
  assert.equal(noFileChannels.size, 59);
  assert.equal(excludeInventory.length, 117);
  assert.equal(excludeChannels.size, 117);
  assert.deepEqual([...fileChannels].filter((channel) => noFileChannels.has(channel)), []);
  assert.deepEqual([...fileChannels].filter((channel) => excludeChannels.has(channel)), []);
  assert.deepEqual([...noFileChannels].filter((channel) => excludeChannels.has(channel)), []);
  assert.deepEqual(new Set(registry.channels('reserve')), fileChannels);
  assert.deepEqual(new Set(registry.channels('no-file')), noFileChannels);
  assert.equal(registry.channels('exclude').length, 117);
  assert.equal(registry.list().length, 63 + 59 + 117);
});

test('dialog selection 显式区分 file/directory，正常 file policy 不再消费 selection 路径', () => {
  const source = fs.readFileSync(MAIN_PATH, 'utf8');
  const dialogStart = source.indexOf('async function showImportOpenDialog(scope, options)');
  const dialogEnd = source.indexOf('\nfunction createPreviewSourceFreshnessGuard', dialogStart);
  const wrapper = source.slice(dialogStart, dialogEnd);
  assert.match(wrapper, /properties\.includes\('openFile'\)/);
  assert.match(wrapper, /properties\.includes\('openDirectory'\)/);
  assert.match(wrapper, /selectsFiles === selectsDirectories/);
  assert.match(wrapper, /kind,/);

  const runnerStart = source.indexOf('async function runArchiveAwareOperation(');
  const runnerEnd = source.indexOf('\nfunction trackedIpcHandle', runnerStart);
  const runner = source.slice(runnerStart, runnerEnd);
  assert.doesNotMatch(runner, /dialogSelections\.flatMap|selection\.kind === 'file'/);
  assert.match(runner, /useLegacyExistingBatchRecovery = prepared\.legacyExistingBatchRecovery === true/);
  assert.match(runner, /selectedPathsResolver: useLegacyExistingBatchRecovery \? \(\) => \[\] : null/);
});

test('Acquiring/VCC OP operation owner 由 object handler 实际消费 exact-5 context', () => {
  const source = fs.readFileSync(MAIN_PATH, 'utf8');
  for (const channel of [
    'acquiringBillCurrency:clearMonth',
    'vccOpCalc:run:compute-amounts',
    'vccOpCalc:run:save'
  ]) {
    const start = source.indexOf(`('${channel}',`);
    const next = source.indexOf('\n  });', start);
    const handler = source.slice(start, next);
    assert.match(handler, /execute:\s*\([^)]*taskContext/);
    assert.match(handler, /taskContext\.operationContext\.taskRunId/);
  }
});

test('FILE_CHANNELS 不得包含 exclude preview/picker，scenario 只登记 apply mutation', () => {
  const registry = createTaskPolicyRegistry();
  const excluded = new Set(registry.channels('exclude'));
  assert.deepEqual([...FILE_CHANNELS].filter((channel) => excluded.has(channel)), []);
  assert.equal(FILE_CHANNELS.has('scenarios:import-bundle'), false);
  assert.equal(FILE_CHANNELS.has('scenarios:import-bundle-apply'), true);
});

test('工具箱三通道精确登记为两 reserve、一 preview exclude', () => {
  const registry = createTaskPolicyRegistry();
  assert.equal(registry.require('toolbox:merge').batchPolicy, 'reserve');
  assert.equal(registry.require('toolbox:split:export').batchPolicy, 'reserve');
  assert.equal(registry.require('toolbox:split:read').batchPolicy, 'exclude');
  assert.equal(registry.require('toolbox:split:read').excludeReason, 'preview-only');
  assert.equal(FILE_CHANNELS.has('toolbox:merge'), true);
  assert.equal(FILE_CHANNELS.has('toolbox:split:export'), true);
  assert.equal(FILE_CHANNELS.has('toolbox:split:read'), false);
});

test('statement execute 分类器只额外接受补录余额，prepare 交互状态必须拒绝', () => {
  assert.equal(
    statementResultClassifier({ status: 'manual-balance-required' }),
    'succeeded'
  );
  for (const status of [
    'needs-selection',
    'remember-order-mismatch',
    'select-big-account',
    'select-export-scope',
    'confirm-overwrite'
  ]) {
    assert.throws(
      () => statementResultClassifier({ status }),
      new RegExp(`未审计的业务结果 status：${status}`),
      status
    );
  }
});

test('Pending execute 分类器不接受 need-confirm，交互结果必须停在 prepare', () => {
  const classifier = createTaskPolicyRegistry().require('pending:import:start').resultClassifier;
  assert.throws(
    () => classifier({ status: 'need-confirm' }),
    /未审计的业务结果 status：need-confirm/
  );
});

test('大账号交互只让 import/complete reserve，preview/cancel 精确 exclude', () => {
  const registry = createTaskPolicyRegistry();
  assert.equal(registry.require('file:import').batchPolicy, 'reserve');
  assert.equal(
    registry.require('file:complete-big-account-selection').batchPolicy,
    'reserve'
  );
  assert.equal(
    registry.require('file:extract-big-account-order').excludeReason,
    'preview-only'
  );
  assert.equal(
    registry.require('file:cancel-big-account-selection').excludeReason,
    'cancel-active-task'
  );
});

test('13 个 primary 与 1 个 toolbox utility 均有受控 task，VCC财务独立于VCCOP', () => {
  const controlled = createTaskPolicyRegistry().list()
    .filter((policy) => ['reserve', 'no-file'].includes(policy.batchPolicy));
  const controlledScopeIds = new Set(controlled.map((policy) => policy.scopeId));
  assert.equal(controlledScopeIds.size, 14);
  assert.equal(new Set([...controlledScopeIds].filter((scopeId) => scopeId !== 'toolbox')).size, 13);
  const registry = createTaskPolicyRegistry();
  assert.equal(registry.require('vccFinancialOp:run:calculate').scopeId, 'vcc-financial-op');
  assert.equal(registry.require('vccOpCalc:run:save').scopeId, 'vcc-op-calc');
  assert.deepEqual(
    controlled.filter((policy) => policy.scopeId === 'toolbox').map((policy) => policy.channel).sort(),
    ['toolbox:merge', 'toolbox:split:export']
  );
});

test('VCC财务 4 file + 6 no-file + 14 exclude literal inventory 精确闭合', () => {
  const registry = createTaskPolicyRegistry();
  const policies = registry.list().filter((policy) => policy.channel.startsWith('vccFinancialOp:'));
  assert.deepEqual(
    policies.filter((policy) => policy.batchPolicy === 'reserve').map((policy) => policy.channel).sort(),
    [
      'vccFinancialOp:data-manager:export',
      'vccFinancialOp:export:import-audit',
      'vccFinancialOp:export:result',
      'vccFinancialOp:import:apply'
    ]
  );
  assert.deepEqual(
    policies.filter((policy) => policy.batchPolicy === 'no-file').map((policy) => policy.channel).sort(),
    [
      'vccFinancialOp:data-manager:delete',
      'vccFinancialOp:opening:initialize',
      'vccFinancialOp:run:adjustment-add',
      'vccFinancialOp:run:archive',
      'vccFinancialOp:run:calculate',
      'vccFinancialOp:run:unarchive'
    ]
  );
  assert.deepEqual(
    policies.filter((policy) => policy.batchPolicy === 'exclude').map((policy) => policy.channel).sort(),
    [
      'vccFinancialOp:data-manager:delete-preview',
      'vccFinancialOp:data-manager:delete-targets',
      'vccFinancialOp:data-manager:export-preview',
      'vccFinancialOp:data-manager:overview',
      'vccFinancialOp:import:pick-files',
      'vccFinancialOp:imports:list-months',
      'vccFinancialOp:imports:list-records',
      'vccFinancialOp:run:adjustment-options',
      'vccFinancialOp:run:archived-months',
      'vccFinancialOp:run:get',
      'vccFinancialOp:run:latest-archived',
      'vccFinancialOp:run:preflight',
      'vccFinancialOp:run:unarchive-preview',
      'vccFinancialOp:task:cancel'
    ]
  );
});

test('VCC财务 calculate/import 新建流程，run 后续动作按稳定身份续接', () => {
  const registry = createTaskPolicyRegistry();
  assert.equal(registry.require('vccFinancialOp:run:calculate').startsNewFlow, true);
  assert.equal(registry.require('vccFinancialOp:import:apply').startsNewFlow, true);
  assert.equal(
    registry.require('vccFinancialOp:import:apply').bindResultFlowIdentitiesOnFailure,
    true
  );
  assert.equal(
    registry.require('vccFinancialOp:run:calculate').bindResultFlowIdentitiesOnFailure,
    false
  );
  assert.deepEqual(
    registry.require('vccFinancialOp:run:archive').flowIdentityResolver({ args: [{ runId: 7 }] }),
    { type: 'vcc-financial-op-run', value: '7' }
  );
  assert.throws(() => registry.require('vccFinancialOp:imports:resolve'), /未登记/);
  assert.deepEqual(
    registry.require('vccFinancialOp:data-manager:delete').flowPlanResolver({
      prepared: { targetType: 'result', runIds: [11] }
    }),
    { startsNewFlow: false, flowIdentity: { type: 'vcc-financial-op-run', value: '11' } }
  );
  assert.deepEqual(
    registry.require('vccFinancialOp:data-manager:delete').flowPlanResolver({
      prepared: { targetType: 'result', runIds: [11, 12] }
    }),
    { startsNewFlow: true, flowIdentity: null }
  );
});

test('新 run 显式创建新 flow，带持久 runId 的后续动作显式续接', () => {
  const registry = createTaskPolicyRegistry();
  for (const channel of [
    'pending:reconcile:run',
    'bankBuRecon:run',
    'bizOpRecon:run',
    'position-reconciliation:run'
  ]) {
    assert.equal(registry.require(channel).startsNewFlow, true, channel);
  }
  assert.throws(
    () => registry.require('position-reconciliation:run').resultClassifier({
      status: 'needs-replace-confirmation'
    }),
    /未审计的业务结果 status/
  );
  for (const channel of [
    'pending:diff:export-single',
    'bankBuRecon:export:single',
    'bizOpRecon:export:date',
    'position-reconciliation:run:export',
    'position-reconciliation:run:import-result'
  ]) {
    const policy = registry.require(channel);
    assert.equal(policy.startsNewFlow, false, channel);
    assert.deepEqual(policy.flowIdentityResolver({ args: [{ runId: 42 }] }), {
      type: 'business-run-id',
      value: '42'
    });
  }
});

test('Acquiring 新 run 以 taskRunId 隔离，legacy resume 仍兼容旧 identity，export 续接精确身份', () => {
  const registry = createTaskPolicyRegistry();
  const runPolicy = registry.require('acquiringBillCurrency:run');
  const july = runPolicy.resultFlowIdentities(
    { status: 'success', runId: 1 },
    { taskRunId: 'task-july' },
    { args: [{ monthKey: '2026-07' }], prepared: {} }
  );
  const august = runPolicy.resultFlowIdentities(
    { status: 'success', runId: 1 },
    { taskRunId: 'task-august' },
    { args: [{ monthKey: '2026-08' }], prepared: {} }
  );
  assert.deepEqual(july, [{
    type: 'business-run-id',
    value: 'acquiring-task:task-july'
  }]);
  assert.deepEqual(august, [{
    type: 'business-run-id',
    value: 'acquiring-task:task-august'
  }]);
  assert.notDeepEqual(july, august);

  const resumePolicy = registry.require('acquiringBillCurrency:run:resume');
  for (const source of ['side', 'main']) {
    const monthKey = source === 'side' ? '2026-07' : '2025-12';
    const flowIdentity = {
      type: 'business-run-id',
      value: `acquiring-run:${source}:${monthKey}:1`
    };
    const invocation = {
      args: [{ monthKey, runId: 1 }],
      prepared: {
        resumePlan: {
          source,
          monthKey,
          runId: 1,
          flowPlan: { startsNewFlow: false, flowIdentity }
        }
      }
    };
    assert.deepEqual(
      resumePolicy.resultFlowIdentities({ status: 'success', runId: 1 }, {}, invocation),
      [flowIdentity]
    );
  }
  assert.deepEqual(
    resumePolicy.resultFlowIdentities(
      { status: 'success', runId: 1 },
      {},
      { args: [{ monthKey: '2026-07' }], prepared: {} }
    ),
    []
  );

  const exportPolicy = registry.require('acquiringBillCurrency:export');
  const exportIdentity = {
    type: 'business-run-id',
    value: 'acquiring-task:task-july'
  };
  const exportInvocation = {
    args: [{ monthKey: '2026-07' }],
    prepared: {
      exportPlan: {
        source: 'side',
        monthKey: '2026-07',
        runId: 1,
        flowIdentity: exportIdentity
      }
    }
  };
  assert.equal(exportPolicy.startsNewFlow, false);
  assert.deepEqual(exportPolicy.flowPlanResolver(exportInvocation), {
    startsNewFlow: false,
    flowIdentity: exportIdentity
  });
  assert.deepEqual(exportPolicy.resultFlowIdentities(
    { status: 'success', source: 'side', monthKey: '2026-07', runId: 1 },
    {},
    exportInvocation
  ), [exportIdentity]);
  assert.deepEqual(exportPolicy.resultFlowIdentities(
    { status: 'success', source: 'side', monthKey: '2026-08', runId: 1 },
    {},
    exportInvocation
  ), []);
});

test('无文件运行/配置使用 Task Run 但不占批次号，银行对账 export 续接当前内存 run 身份', () => {
  const registry = createTaskPolicyRegistry();
  const runPolicy = registry.require('bank-statement:run');
  const mappingPolicy = registry.require('template:save-mappings');
  const exportPolicy = registry.require('bank-statement:export');
  assert.deepEqual(
    [runPolicy.batchPolicy, runPolicy.taskKind, runPolicy.allocation],
    ['no-file', 'no-file', 'none']
  );
  assert.deepEqual(
    [mappingPolicy.batchPolicy, mappingPolicy.taskKind, mappingPolicy.allocation],
    ['no-file', 'no-file', 'none']
  );
  assert.deepEqual(
    registry.list()
      .filter((policy) => policy.batchPolicy === 'no-file')
      .map((policy) => policy.channel)
      .length,
    59
  );
  const first = createBankStatementRunFlowIdentity(() => 'ephemeral-run-1');
  const rerun = createBankStatementRunFlowIdentity(() => 'ephemeral-run-2');
  assert.notDeepEqual(first, rerun);
  const invocation = {
    prepared: {
      inspected: {
        processingResult: { archiveFlowIdentity: first }
      }
    }
  };
  assert.equal(exportPolicy.startsNewFlow, false);
  assert.deepEqual(exportPolicy.flowPlanResolver(invocation), {
    startsNewFlow: false,
    flowIdentity: first
  });
  assert.deepEqual(
    exportPolicy.resultFlowIdentities({ status: 'ok' }, {}, invocation),
    [first]
  );
  assert.throws(
    () => exportPolicy.flowPlanResolver({ prepared: { inspected: { processingResult: {} } } }),
    (error) => error.code === 'ARCHIVE_FLOW_IDENTITY_REQUIRED'
  );
});

test('no-file policy 经受控 helper 进入 operation-only lifecycle', () => {
  const source = fs.readFileSync(MAIN_PATH, 'utf8');
  const inventory = new Map(mainIpcInventory().map((item) => [item.channel, item]));
  for (const channel of ['bank-statement:run', 'template:save-mappings']) {
    assert.equal(inventory.get(channel).kind, 'trackedIpcHandle', channel);
  }
  const start = source.indexOf('async function runArchiveAwareOperation');
  const end = source.indexOf('function runRegisteredBusinessOperation', start);
  const operationFlow = source.slice(start, end);
  assert.match(operationFlow, /policy\.batchPolicy === 'no-file'/);
  assert.match(operationFlow, /archiveTaskLifecycle\.runOperationOnly/);
  assert.doesNotMatch(operationFlow, /policy\.excludeReason !== 'no-archive-artifact'/);
  assert.match(source, /const flowIdentity = createBankStatementRunFlowIdentity\(\)/);
  assert.match(source, /flowPlan:\s*Object\.freeze\(\{ startsNewFlow: true, flowIdentity \}\)/);
  assert.match(source, /archiveFlowIdentity:\s*prepared\.flowPlan\.flowIdentity/);
});

test('首批 simple eager file action 逐项接入 literal FilePlan 与显式 settle', () => {
  const source = fs.readFileSync(MAIN_PATH, 'utf8');
  const pendingPreflightSource = fs.readFileSync(
    path.join(__dirname, '..', '..', '..', 'src', 'main-process', 'pending-import-preflight.js'),
    'utf8'
  );
  const channels = [
    'monthly-balance:export',
    'new-account:export',
    'bank-statement:import',
    'bank-statement:batch-import',
    'bank-statement:export',
    'bankBuRecon:import:run',
    'bankBuRecon:export:single',
    'bankBuRecon:export:aggregate',
    'bizOpRecon:import:run-biz-op',
    'bizOpRecon:import:run-flow',
    'bizOpRecon:export:date',
    'bizOpRecon:export:date-range',
    'big-account:import-bank-info',
    'duplicate-inbound-match:export',
    'duplicate-inbound-match:import-files',
    'gateway-recon:import',
    'linked-table:import',
    'pending:diff:export-single',
    'pending:diff:export-aggregate',
    'pending:error:export-report',
    'pending:import:start',
    'pending:removed:import',
    'pre-fund-reconciliation:mpt-errors:export',
    'pre-fund-reconciliation:mpt-errors:repair',
    'pre-fund-reconciliation:export',
    'pre-fund-reconciliation:import-bank',
    'pre-fund-reconciliation:import-mpt',
    'scenarios:export-bundle',
    'scenarios:import-bundle-apply',
    'recon-id-fix:import',
    'recon-id-fix:export',
    'template:import',
    'template:import-bundle',
    'template:export-bundle',
    'vccOpCalc:import:scan'
  ];
  const inputChannels = new Set([
    'bank-statement:import',
    'bank-statement:batch-import',
    'bankBuRecon:import:run',
    'big-account:import-bank-info',
    'bizOpRecon:import:run-biz-op',
    'bizOpRecon:import:run-flow',
    'duplicate-inbound-match:import-files',
    'gateway-recon:import',
    'linked-table:import',
    'pending:import:start',
    'pending:removed:import',
    'pre-fund-reconciliation:import-bank',
    'pre-fund-reconciliation:import-mpt',
    'pre-fund-reconciliation:mpt-errors:repair',
    'recon-id-fix:import',
    'scenarios:import-bundle-apply',
    'template:import',
    'template:import-bundle',
    'vccOpCalc:import:scan'
  ]);
  for (const channel of channels) {
    const start = source.indexOf(`('${channel}',`);
    const end = source.indexOf('\n  });', start);
    const handler = source.slice(start, end);
    assert.ok(start >= 0 && end > start, channel);
    if (channel === 'pending:import:start') {
      assert.match(handler, /preparePendingImportSubmission\(/, channel);
      assert.match(pendingPreflightSource, /filePlan:\s*pendingImportFilePlan\(/, channel);
      assert.match(pendingPreflightSource, /role:\s*'input'/, channel);
    } else {
      assert.match(handler, /filePlan:\s*\{/i, channel);
    }
    assert.match(handler, /taskContext\.fileEvidence/, channel);
    const expectedRole = inputChannels.has(channel) ? 'input' : 'output';
    if (channel !== 'pending:import:start') {
      assert.match(handler, new RegExp(`role:\\s*'${expectedRole}'`), channel);
    }
    if (expectedRole === 'output') {
      assert.match(handler, /taskContext\.settleArtifacts\(/, channel);
    }
    const executeStart = handler.indexOf('execute');
    const executeSource = handler.slice(executeStart);
    assert.doesNotMatch(
      executeSource,
      /prepared\.(?:inputPaths|outputPaths|savePath|filePaths|selectedPath|outputDirectory)/,
      channel
    );
  }
  assert.doesNotMatch(source, /atomicFileLifecycleChannels/);
  assert.match(source, /const runFileLifecycle = !useLegacyExistingBatchRecovery[\s\S]*?runDeferredFileTask[\s\S]*?runFileTask[\s\S]*?archiveTaskLifecycle\.run/);
});

test('Bank BU 首次运行续接持久导入身份，显式重跑创建新 parent', async () => {
  const identity = { type: 'bank-bu-import-bundle', value: 'scope=2026-08|pending=1-2-2|bank=1-3-3' };
  const firstRun = await bankBuRunFlowPlan({
    resolveFlowEvidence: async () => ({ identity, hasRun: false })
  });
  assert.deepEqual(firstRun, { startsNewFlow: false, flowIdentity: identity });

  const rerun = await bankBuRunFlowPlan({
    resolveFlowEvidence: async () => ({ identity, hasRun: true })
  });
  assert.deepEqual(rerun, { startsNewFlow: true, flowIdentity: null });
  assert.deepEqual(await bankBuRunFlowPlan({}), {
    startsNewFlow: true,
    flowIdentity: null
  });
  assert.deepEqual(await bankBuImportResultFlowIdentities({}, {}, {
    resolveFlowEvidence: async () => ({ identity, hasRun: false })
  }), [identity]);
});
