// 复用用户审查探针，仅将三个负例的预期改为拒绝；原探针原样保留。
'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const root = process.argv[2] || '/private/tmp/execution-descriptors-review-20260921';
const composition = require(path.join(root, 'src/main-process/execution-descriptors/composition'));
const toolbox = require(path.join(root, 'src/main-process/toolbox-background/execution-descriptor'));
const catalog = require(path.join(root, 'src/main-process/execution-descriptors/policy-catalog'));
const authority = require(path.join(root, 'src/main-process/background-execution/action-task-binding-registry'));
const authorityBefore = JSON.stringify(authority.bindingSnapshot());
const factory = toolbox.createModuleExecutionDescriptor;
const results = [];
for (const scenario of ['baseline', 'drop-runtime-policy', 'enable-production', 'register-legacy-production']) {
  toolbox.createModuleExecutionDescriptor = (context) => {
    const d = factory(context);
    if (scenario === 'baseline') return d;
    const policies = structuredClone(d.policies);
    if (scenario === 'drop-runtime-policy') return {
      ...d,
      policies: policies.filter((p) => p.actionKey !== 'toolbox:merge'),
      mainBindings: d.mainBindings.filter((p) => p.actionKey !== 'toolbox:merge')
    };
    const p = policies.find((p) => p.actionKey === 'toolbox:merge');
    p.production = { ...p.production, enabled: true, effectiveMode: 'thread-single', effectiveWorkerCount: 1, downgradeReason: null };
    if (scenario === 'enable-production') return { ...d, policies };
    const newPolicy = { ...p, actionKey: 'toolbox:split-large' };
    return {
      ...d, policies: [...d.policies, newPolicy],
      mainBindings: [...d.mainBindings, { ...d.mainBindings.find((b) => b.actionKey === p.actionKey), actionKey: newPolicy.actionKey }]
    };
  };
  try {
    const compiled = composition.composeExecutionDescriptors({ availableParallelism: 4 });
    const target = scenario === 'register-legacy-production' ? 'toolbox:split-large' : 'toolbox:merge';
    const p = compiled.policyRegistry.get(target);
    const result = { scenario, status: 'ACCEPTED', runtimeCount: compiled.policies.length, productionCount: compiled.policies.filter((p) => p.production.enabled).length, target, targetProduction: p ? p.production.enabled : null, catalogProduction: catalog.isBackgroundExecutionProductionEnabled(target) };
    if (p && p.production.enabled) result.runnableProduction = compiled.policyRegistry.assertRunnable(target, { production: true }).actionKey;
    results.push(result);
  } catch (error) { results.push({ scenario, status: 'REJECTED', code: error.code, message: error.message }); }
  finally { toolbox.createModuleExecutionDescriptor = factory; }
}
assert.equal(JSON.stringify(authority.bindingSnapshot()), authorityBefore);
assert.deepEqual(results.map((r) => r.status), ['ACCEPTED', 'REJECTED', 'REJECTED', 'REJECTED']);
console.log(JSON.stringify({ authorityUnchanged: true, results }, null, 2));
