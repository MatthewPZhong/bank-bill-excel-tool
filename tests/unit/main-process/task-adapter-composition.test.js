'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const acorn = require('acorn');
const { createBusinessTaskAdapterRegistry } = require('../../../src/main-process/task-adapter-composition');
const { createTaskPolicyRegistry } = require('../../../src/main-process/archive-center/task-policy-registry');

const sourceRoot = path.resolve(__dirname, '../../../src');

test('启动装配显式覆盖全部 134 个受控任务并排除 exclude，不接受未绑定任务', () => {
  const policies = createTaskPolicyRegistry().list();
  const registry = createBusinessTaskAdapterRegistry({
    policies,
    positionOwner: Object.freeze({}),
    acknowledgeReceipts() { assert.fail('注册阶段不得确认 receipt'); },
    reportArchiveFailure() { assert.fail('注册阶段不得进入业务'); }
  });
  assert.ok(Object.isFrozen(registry));
  const counts = {};
  for (const policy of policies) {
    if (policy.batchPolicy === 'exclude') {
      assert.throws(() => registry.resolve(policy.taskKey), { code: 'TASK_ADAPTER_UNBOUND' });
      continue;
    }
    const adapter = registry.resolve(policy.taskKey);
    const expected = policy.scopeId === 'position-reconciliation-process' ? 'position-reconciliation'
      : policy.scopeId === 'toolbox' ? 'toolbox'
        : policy.scopeId === 'vcc-financial-op' ? 'vcc-financial-op' : 'passthrough';
    assert.equal(adapter.id, expected, policy.taskKey);
    assert.ok(Object.isFrozen(adapter));
    counts[adapter.id] = (counts[adapter.id] || 0) + 1;
  }
  assert.equal(Object.values(counts).reduce((sum, n) => sum + n, 0), 134);
  assert.equal(counts['position-reconciliation'], 15);
  assert.throws(() => registry.resolve('renderer:injected'), { code: 'TASK_ADAPTER_UNBOUND' });
});

test('公共执行器不再持有领域分派，task-adapters 中立模块无领域或存储依赖', () => {
  const main = fs.readFileSync(path.join(sourceRoot, 'main.js'), 'utf8');
  const ast = acorn.parse(main, { ecmaVersion: 'latest' });
  const entry = ast.body.find((node) => node.type === 'FunctionDeclaration'
    && node.id.name === 'runArchiveAwareOperation');
  assert.ok(entry);
  const executor = main.slice(entry.start, entry.end);
  assert.doesNotMatch(executor, /position|toolbox|vcc|Publication|Pending|Checkpoint|afterTerminalIntent\.route/i);
  assert.match(executor, /taskAdapterRegistry\.resolve\(policy\.taskKey\)/);
  for (const name of ['registry.js', 'passthrough.js', 'prepared-resources.js']) {
    const source = fs.readFileSync(path.join(sourceRoot, 'main-process/task-adapters', name), 'utf8');
    assert.doesNotMatch(source, /require\([^)]*(?:position|toolbox|vcc|database|sqlite|main\.js)/i, name);
  }
  const preflight = fs.readFileSync(path.join(sourceRoot,
    'main-process/position-reconciliation/interactive-task-preflight.js'), 'utf8');
  assert.doesNotMatch(main + preflight, /runWithPreparedResourceCleanup/);
  assert.doesNotMatch(main, /function (?:writePositionPendingOperation|finalizePositionTerminalIntent|runPositionReconciliationOperation|cleanupPositionArchiveStaging)\(/);
});
