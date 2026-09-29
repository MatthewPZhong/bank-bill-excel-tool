'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const composition = require('../../../src/main-process/execution-descriptors/composition');
const toolbox = require('../../../src/main-process/toolbox-background/execution-descriptor');
const catalog = require('../../../src/main-process/execution-descriptors/policy-catalog');
const { bindingSnapshot } = require('../../../src/main-process/background-execution/action-task-binding-registry');
const root = path.resolve(__dirname, '../../..');

test('固定批准基线接受当前49个runtime与13个production，catalog与私有authority保持一致', () => {
  const compiled = composition.composeExecutionDescriptors({ availableParallelism: 4 });
  assert.equal(compiled.policies.length, 49);
  assert.equal(compiled.policies.filter(policy => policy.production.enabled).length, 13);
  assert.deepEqual(compiled.policies.map(policy => policy.actionKey).sort(),
    catalog.BACKGROUND_EXECUTION_POLICIES.map(policy => policy.actionKey).sort());
});

function drift(descriptor, scenario) {
  const policies = structuredClone(descriptor.policies);
  const merge = policies.find((policy) => policy.actionKey === 'toolbox:merge');
  if (scenario === 'missing') return { ...descriptor,
    policies: policies.filter((policy) => policy.actionKey !== merge.actionKey),
    mainBindings: descriptor.mainBindings.filter((binding) => binding.actionKey !== merge.actionKey)
  };
  if (scenario === 'enable') {
    merge.production = { ...merge.production, enabled: true, effectiveMode: 'thread-single',
      effectiveWorkerCount: 1, downgradeReason: null };
    return { ...descriptor, policies };
  }
  if (scenario === 'disable') {
    const rows = policies.find((policy) => policy.actionKey === 'toolbox:split-rows');
    rows.production = { ...rows.production, enabled: false, effectiveMode: 'legacy',
      effectiveWorkerCount: 0, downgradeReason: 'unapproved-change' };
    return { ...descriptor, policies };
  }
  const extra = { ...merge, actionKey: 'toolbox:split-large' };
  if (scenario === 'legacy-production') extra.production = { ...merge.production, enabled: true,
    effectiveMode: 'thread-single', effectiveWorkerCount: 1, downgradeReason: null };
  return { ...descriptor,
    policies: [...policies.filter((policy) => scenario !== 'swap' || policy.actionKey !== merge.actionKey), extra],
    mainBindings: [
      ...descriptor.mainBindings.filter((binding) => scenario !== 'swap' || binding.actionKey !== merge.actionKey),
      { ...descriptor.mainBindings.find((binding) => binding.actionKey === merge.actionKey), actionKey: extra.actionKey }
    ]
  };
}

for (const [scenario, code] of [
  ['missing', 'CAPABILITY_INVENTORY_SNAPSHOT_MISMATCH'],
  ['enable', 'PRODUCTION_STRATEGY_SNAPSHOT_MISMATCH'],
  ['legacy-production', 'CAPABILITY_INVENTORY_SNAPSHOT_MISMATCH'],
  ['legacy-disabled', 'CAPABILITY_INVENTORY_SNAPSHOT_MISMATCH'],
  ['swap', 'CAPABILITY_INVENTORY_SNAPSHOT_MISMATCH'],
  ['disable', 'PRODUCTION_STRATEGY_SNAPSHOT_MISMATCH']
]) {
  test(`正式 runtime 装配在创建 Governor/worker 前拒绝已知 action 语义漂移：${scenario}`, () => {
    const original = toolbox.createModuleExecutionDescriptor;
    const authorityBefore = bindingSnapshot();
    let sideEffects = 0;
    toolbox.createModuleExecutionDescriptor = (context) => drift(original(context), scenario);
    try {
      assert.throws(() => composition.createBackgroundExecutionRuntime({
        availableParallelism: 4,
        diagnostics: () => { sideEffects += 1; },
        workerThreadAdapter: { start() { sideEffects += 1; throw new Error('不应创建载体'); } }
      }), (error) => error.code === code);
      assert.equal(sideEffects, 0);
      assert.deepEqual(bindingSnapshot(), authorityBefore);
      assert.equal(catalog.isBackgroundExecutionProductionEnabled('toolbox:merge'), false);
    } finally {
      toolbox.createModuleExecutionDescriptor = original;
    }
  });
}

function isolated(body) {
  const result = spawnSync(process.execPath, ['-e', body], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}
const changedCatalog = `
  const catalogPath = require.resolve('./src/main-process/execution-descriptors/policy-catalog');
  const catalog = require(catalogPath);
  const policies = structuredClone(catalog.BACKGROUND_EXECUTION_POLICIES);
  const merge = policies.find(p => p.actionKey === 'toolbox:merge');
  merge.production = { ...merge.production, enabled: true, effectiveMode: 'thread-single',
    effectiveWorkerCount: 1, downgradeReason: null };
  require.cache[catalogPath].exports = { ...catalog, BACKGROUND_EXECUTION_POLICIES: policies };
`;

test('catalog 与 descriptor 同时漂移也不能成为彼此的批准基线', () => {
  const result = isolated(`${changedCatalog}
    const toolbox = require('./src/main-process/toolbox-background/execution-descriptor');
    const original = toolbox.createModuleExecutionDescriptor;
    toolbox.createModuleExecutionDescriptor = context => {
      const d = original(context);
      return { ...d, policies: d.policies.map(p => p.actionKey === merge.actionKey ? merge : p) };
    };
    try {
      require('./src/main-process/execution-descriptors/composition').composeExecutionDescriptors();
      console.log(JSON.stringify({ accepted: true }));
    } catch (error) { console.log(JSON.stringify({ code: error.code })); }
  `);
  assert.equal(result.code, 'PRODUCTION_STRATEGY_SNAPSHOT_MISMATCH');
});

test('只改 catalog 同样在正式装配时拒绝，不能留下查询/实际 runtime 分叉', () => {
  const result = isolated(`${changedCatalog}
    try {
      require('./src/main-process/execution-descriptors/composition').composeExecutionDescriptors();
      console.log(JSON.stringify({ accepted: true }));
    } catch (error) { console.log(JSON.stringify({ code: error.code })); }
  `);
  assert.equal(result.code, 'PRODUCTION_STRATEGY_SNAPSHOT_MISMATCH');
});

test('manifest --write 在写任何产物之前拒绝错误 catalog，不重生成批准期望', () => {
  const result = isolated(`${changedCatalog}
    const fs = require('node:fs');
    const path = require('node:path');
    const crypto = require('node:crypto');
    const dir = 'changes/v3.2.10/codex/v3.2.10-execution-descriptors/evidence/manifest-current';
    const files = [...fs.readdirSync(dir).filter(name => name.endsWith('.json')).map(name => path.join(dir, name)),
      'src/main-process/background-execution/approved-execution-baseline.json'];
    const hashes = () => files.map(file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'));
    const before = hashes();
    let writes = 0;
    let mkdirs = 0;
    fs.writeFileSync = () => { writes += 1; };
    fs.mkdirSync = () => { mkdirs += 1; };
    process.argv = [process.execPath, 'manifest', '--write'];
    let code;
    try { require('./scripts/check-background-execution-manifest'); }
    catch (error) { code = error.code; }
    console.log(JSON.stringify({ code, writes, mkdirs, unchanged: JSON.stringify(before) === JSON.stringify(hashes()) }));
  `);
  assert.deepEqual(result, { code: 'PRODUCTION_STRATEGY_SNAPSHOT_MISMATCH', writes: 0, mkdirs: 0, unchanged: true });
});
