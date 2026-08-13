'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const acorn = require('acorn');

const {
  EXCLUDE_REASONS,
  PR3_HANDOFF_CHANNELS,
  SUPPORT_ACTION_POLICIES,
  bankBuImportResultFlowIdentities,
  bankBuRunFlowPlan,
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

test('main literal IPC 与 PR3-Toolbox 完成后的 policy 精确相等', () => {
  const inventory = mainIpcInventory();
  const registry = createTaskPolicyRegistry();
  const actual = inventory.map((item) => item.channel).sort();
  const expected = [
    ...registry.channels(),
    ...SUPPORT_ACTION_POLICIES.map((policy) => policy.channel),
    ...PR3_HANDOFF_CHANNELS
  ].sort();
  assert.equal(new Set(actual).size, actual.length, 'main 不应重复注册 literal IPC');
  assert.equal(new Set(expected).size, expected.length, 'policy/handoff 不应重复登记');
  assert.deepEqual(expected, actual);
  assert.equal(actual.length, 243);
  assert.equal(registry.channels('reserve').length, 123);
  assert.equal(registry.channels('exclude').length, 118);
  assert.equal(SUPPORT_ACTION_POLICIES.length, 2);
  assert.deepEqual(PR3_HANDOFF_CHANNELS, []);
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

test('reserve policy 只能经受控 helper，裸 IPC 只能是明确 exclude 或 PR3 handoff', () => {
  const registry = createTaskPolicyRegistry();
  const handoff = new Set(PR3_HANDOFF_CHANNELS);
  const support = new Set(SUPPORT_ACTION_POLICIES.map((policy) => policy.channel));
  const violations = [];
  for (const registration of mainIpcInventory()) {
    const policy = registry.get(registration.channel);
    if (handoff.has(registration.channel)) continue;
    if (support.has(registration.channel)) {
      if (registration.kind !== 'supportIpcHandle') {
        violations.push(`${registration.channel}@${registration.line}:support-helper-required`);
      }
      continue;
    }
    if (policy.batchPolicy === 'reserve' && !CONTROLLED_HELPERS.has(registration.kind)) {
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
      assert.equal(policy.batchPolicy, 'reserve');
      assert.equal(typeof policy.resultClassifier, 'function');
      assert.equal(typeof policy.startsNewFlow, 'boolean');
    }
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

test('13 个 primary 与 1 个 toolbox utility 均有 reserve action，VCC财务独立于VCCOP', () => {
  const reserve = createTaskPolicyRegistry().list().filter((policy) => policy.batchPolicy === 'reserve');
  const reserveScopeIds = new Set(reserve.map((policy) => policy.scopeId));
  assert.equal(reserveScopeIds.size, 14);
  assert.equal(new Set([...reserveScopeIds].filter((scopeId) => scopeId !== 'toolbox')).size, 13);
  const registry = createTaskPolicyRegistry();
  assert.equal(registry.require('vccFinancialOp:run:calculate').scopeId, 'vcc-financial-op');
  assert.equal(registry.require('vccOpCalc:run:save').scopeId, 'vcc-op-calc');
  assert.deepEqual(
    reserve.filter((policy) => policy.scopeId === 'toolbox').map((policy) => policy.channel).sort(),
    ['toolbox:merge', 'toolbox:split:export']
  );
});

test('VCC财务 11 reserve + 15 exclude literal inventory 精确闭合', () => {
  const registry = createTaskPolicyRegistry();
  const policies = registry.list().filter((policy) => policy.channel.startsWith('vccFinancialOp:'));
  assert.deepEqual(
    policies.filter((policy) => policy.batchPolicy === 'reserve').map((policy) => policy.channel).sort(),
    [
      'vccFinancialOp:data-manager:delete',
      'vccFinancialOp:data-manager:export',
      'vccFinancialOp:export:import-audit',
      'vccFinancialOp:export:result',
      'vccFinancialOp:import:apply',
      'vccFinancialOp:imports:resolve',
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
      'vccFinancialOp:imports:get-detail',
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

test('VCC财务 calculate/import 新建流程，run/record 后续动作按稳定身份续接', () => {
  const registry = createTaskPolicyRegistry();
  assert.equal(registry.require('vccFinancialOp:run:calculate').startsNewFlow, true);
  assert.equal(registry.require('vccFinancialOp:import:apply').startsNewFlow, true);
  assert.deepEqual(
    registry.require('vccFinancialOp:run:archive').flowIdentityResolver({ args: [{ runId: 7 }] }),
    { type: 'vcc-financial-op-run', value: '7' }
  );
  assert.deepEqual(
    registry.require('vccFinancialOp:imports:resolve').flowIdentityResolver({ args: [{ recordId: 9 }] }),
    { type: 'vcc-financial-op-import-record', value: '9' }
  );
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

test('Acquiring run 结果 identity 按 source + month + runId 隔离并与 legacy resume flowPlan 一致', () => {
  const registry = createTaskPolicyRegistry();
  const runPolicy = registry.require('acquiringBillCurrency:run');
  const july = runPolicy.resultFlowIdentities(
    { status: 'success', runId: 1 },
    {},
    { args: [{ monthKey: '2026-07' }], prepared: {} }
  );
  const august = runPolicy.resultFlowIdentities(
    { status: 'success', runId: 1 },
    {},
    { args: [{ monthKey: '2026-08' }], prepared: {} }
  );
  assert.deepEqual(july, [{
    type: 'business-run-id',
    value: 'acquiring-run:side:2026-07:1'
  }]);
  assert.deepEqual(august, [{
    type: 'business-run-id',
    value: 'acquiring-run:side:2026-08:1'
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
    value: 'acquiring-run:side:2026-07:1'
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
