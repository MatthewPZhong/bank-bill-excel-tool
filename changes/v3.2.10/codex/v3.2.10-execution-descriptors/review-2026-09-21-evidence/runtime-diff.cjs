'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const Module = require('node:module');
const root = '/private/tmp/execution-descriptors-review-20260921';
const repo = '/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/v3210-execution-descriptors';
const filename = path.join(root, 'src/main-process/background-execution/runtime.js');
const baselineSource = execFileSync('git', ['show', '8b12a6d5fd71b70ade58b9b6e7a347e29dbe8d05:src/main-process/background-execution/runtime.js'], { cwd: repo, encoding: 'utf8' });
const legacy = new Module(filename, module);
legacy.filename = filename;
legacy.paths = Module._nodeModulePaths(path.dirname(filename));
legacy._compile(baselineSource, filename);
const current = require(path.join(root, 'src/main-process/execution-descriptors/composition'));
const allOptions = {
  availableParallelism: 6, totalMemoryBytes: 16 * 1024 ** 3, freeMemoryBytes: 12 * 1024 ** 3,
  pendingDatabasePath: '/tmp/pending.sqlite', mainDatabasePath: '/tmp/main.sqlite',
  userDataDir: '/tmp/user-data', reconFixJpmDatabasePath: '/tmp/recon.sqlite',
  vccFinancialOpDatabasePath: '/tmp/vcc.sqlite', vccFinancialOpAssetsDir: '/tmp/assets'
};
function simple(value) {
  if (typeof value === 'function') return Function.prototype.toString.call(value);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([k,v]) => [k, typeof v === 'function' ? Function.prototype.toString.call(v) : v]));
}
const oldRuntime = legacy.exports.createBackgroundExecutionRuntime(allOptions);
const newRuntime = current.createBackgroundExecutionRuntime(allOptions);
const refs = require(path.join(root, 'src/main-process/background-execution/execution-policy-registry')).STATIC_REFERENCE_PATHS;
const diffs = [];
for (const policy of oldRuntime.policyRegistry.list()) {
  assert.deepEqual(newRuntime.policyRegistry.get(policy.actionKey), policy);
  for (const [field] of refs) {
    const oldValue = oldRuntime.policyRegistry.getBinding(policy.actionKey, field);
    const newValue = newRuntime.policyRegistry.getBinding(policy.actionKey, field);
    try { assert.deepEqual(simple(newValue), simple(oldValue)); }
    catch { diffs.push({ action: policy.actionKey, field, old: simple(oldValue), new: simple(newValue) }); }
  }
}
console.log(JSON.stringify({policyCount: oldRuntime.policyRegistry.list().length, bindingDifferences:diffs}, null, 2));
async function probe(label, factory, production) {
  let spawned = 0;
  const runtime = factory({...allOptions, carrierClosureActionKeys:['toolbox:merge'], workerThreadAdapter: {
    start() { spawned++; throw Object.assign(new Error('reached adapter'),{code:'PROBE_REACHED_ADAPTER'}); }
  }});
  try {
    const result = await runtime.execute({
      actionKey:'toolbox:merge', operationKey:'probe-operation', production, input:{},
      context:{ kind:'operation', value: { taskRunId:'probe-task', taskKey:'toolbox:merge',
        moduleId:'toolbox', parentRunId:'probe-parent', operationKey:'probe-operation' } }
    });
    console.log(JSON.stringify({label, production, spawned, outcome:result.outcome, error:result.error}));
  } catch(error) {
    console.log(JSON.stringify({label, production, spawned, thrown:{code:error.code,message:error.message}}));
  } finally { await runtime.shutdown(); }
}
(async() => {
  await oldRuntime.shutdown(); await newRuntime.shutdown();
  await probe('old', legacy.exports.createBackgroundExecutionRuntime, false);
  await probe('new', current.createBackgroundExecutionRuntime, false);
  await probe('old', legacy.exports.createBackgroundExecutionRuntime, true);
  await probe('new', current.createBackgroundExecutionRuntime, true);
})().catch(error => { console.error(error); process.exitCode = 1; });
