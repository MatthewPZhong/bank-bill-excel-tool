'use strict';
// 当前人工验收清单 → 真实生产策略 → Governor → rows/BizOP 真实 Worker 与发布恢复。
// Windows 平台事实和可用内存是注入夹具；不冒充 Windows 实机或安装包验收。
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const qualification = require('../../src/main-process/execution-descriptors/memory-qualification.json');
const { PHASES, profile } = require('../../src/main-process/execution-descriptors/memory-profiles');
const { createResourceGovernor, closeResourceGovernor } = require('../../src/main-process/background-execution/resource-governor');
const { registerMemoryGovernor, sealMemoryActivityInventory, memoryActivitySnapshot,
  observeMemoryCarrier } = require('../../src/main-process/memory-activity');
const { loadProductionMemoryProfiles } = require('../../tests/helpers/production-memory-policy');
const { runScenario } = require('../lib/low-memory-scenario');
const MiB = 1024 ** 2;
const runtime = { platform: 'win32', arch: 'x64', versions: { electron: '36.9.5' } };
const resources = { cpuSlots: 1, workerThreadSlots: 1, utilityProcessSlots: 0, ioHeavySlots: 1, memoryBytes: 1024 * MiB };
const requests = {
  'split-prepare': ['toolbox:split:prepare', 'toolbox-split-read'],
  'rows-generation': ['toolbox:split-rows', 'toolbox:rows-generate:test'],
  'rows-io': ['toolbox:split-rows', 'toolbox:rows-validate:test'],
  'publication-io': ['publication:shared-io', 'publication:test'],
  'bizop-import': ['biz-op-v327:import-candidate', 'biz-op-v327:import:test'],
  'bizop-compute': ['biz-op-v327:run-candidate', 'biz-op-v327:compute:test'],
  'bizop-export': ['biz-op-v327:export-result-full', 'biz-op-v327:export:test'],
  'bizop-io': ['biz-op-v327:run-candidate', 'biz-op-v327:raw-source:test'],
  'bizop-maintenance': ['biz-op-v327:reclaim', 'biz-op-v327:maintenance:test']
};
const cases = [];
const test = (name, run) => cases.push({ name, run });
async function withGovernor(options, run) {
  const state = { availableMiB: 4096, ageMs: 0 };
  const { createProductionMemoryPolicy } = loadProductionMemoryProfiles({ runtime,
    qualification: options.qualification ?? qualification,
    sampleMemory: () => ({ availableBytes: state.availableMiB * MiB, sampledAt: Date.now() - state.ageMs }) });
  let governor;
  const policy = createProductionMemoryPolicy({ compatibilityMemoryBytes: 0, getGovernor: () => governor });
  governor = createResourceGovernor({ budgets: { ...resources, cpuSlots: 2, workerThreadSlots: 2,
    ioHeavySlots: 2, memoryBytes: 2048 * MiB, ...options.budgets }, memoryAdmission: policy, memoryRecheckMs: 5 });
  const unregister = registerMemoryGovernor(governor);
  const acquire = (phase, extra = {}) => governor.acquirePhaseLease({ actionKey: requests[phase][0],
    ownerKey: requests[phase][1], resources, timeoutMs: 40, lowMemoryBehavior: 'queue', ...extra });
  try { await run({ state, governor, acquire }); }
  finally {
    const snapshot = governor.snapshot(); closeResourceGovernor(governor); unregister();
    assert.equal(snapshot.activeLeaseCount, 0); assert.equal(snapshot.queued.size, 0);
    assert.deepEqual(memoryActivitySnapshot().blockers, []);
  }
}

test('随包清单为人工确认 PASS，并列出九阶段的普通与低内存配置', async () => {
  assert.equal(qualification.schemaVersion, 2); assert.equal(qualification.status, 'qualified');
  assert.equal(qualification.approval.kind, 'manual-acceptance'); assert.equal(qualification.approval.result, 'PASS');
  assert.equal(qualification.profiles.length, 18);
  assert.deepEqual(Object.keys(requests).sort(), Object.keys(PHASES).sort());
});
test('人工确认不会绕过实际活动覆盖未闭合的保护', () => withGovernor({}, async ({ acquire }) => {
  await assert.rejects(acquire('split-prepare'), { code: 'ADMISSION_TIMEOUT' });
  sealMemoryActivityInventory();
}));
test('零兼容预算下生产策略按实时内存选择全部十八个获批配置', () => withGovernor({}, async ({ state, acquire }) => {
  for (const phase of Object.keys(requests)) for (const mode of ['normal', 'low']) {
    const config = profile(phase, mode);
    state.availableMiB = mode === 'normal' ? 4096 : (config.phaseMemoryBytes + config.systemReserveBytes) / MiB;
    const lease = await acquire(phase);
    try {
      assert.equal(lease.memoryMode, mode); assert.equal(lease.memoryConfig.profileId, config.profileId);
      assert.equal(lease.memoryConfig.validatedEvidenceId, qualification.approval.reference);
      assert.equal(lease.resources.memoryBytes, config.phaseMemoryBytes);
      assert.equal(lease.resources.cpuSlots, 1); assert.equal(lease.resources.workerThreadSlots, 1);
      assert.equal(lease.resources.ioHeavySlots, 1);
    } finally { lease.release(); }
  }
}));
test('待定清单仍走兼容路径，零预算公共读取保留原能力', () => withGovernor({
  qualification: { ...qualification, status: 'pending' }
}, async ({ acquire }) => {
  const lease = await acquire('split-prepare', { resources: { ...resources, memoryBytes: 0 } });
  try { assert.equal(lease.memoryConfig, null); assert.equal(lease.resources.memoryBytes, 0); }
  finally { lease.release(); }
}));
test('系统内存不足会超时，释放外部内存后重试可使用低档', () => withGovernor({}, async ({ state, acquire }) => {
  state.availableMiB = 383;
  await assert.rejects(acquire('split-prepare'), { code: 'ADMISSION_TIMEOUT' });
  state.availableMiB = 384;
  const lease = await acquire('split-prepare');
  try { assert.equal(lease.memoryMode, 'low'); } finally { lease.release(); }
}));
test('过期内存样本仍拒绝，不把人工确认当作无限可用内存', () => withGovernor({}, async ({ state, acquire }) => {
  state.ageMs = 2000;
  await assert.rejects(acquire('split-prepare'), { code: 'RESOURCE_MEMORY_SAMPLE_UNAVAILABLE' });
}));
test('Worker 固定配额不足仍立即拒绝', () => withGovernor({ budgets: { workerThreadSlots: 0 } }, async ({ acquire }) => {
  await assert.rejects(acquire('split-prepare'), { code: 'RESOURCE_BUDGET_UNAVAILABLE' });
}));
test('未知增长载体真退出和低档互斥仍决定何时放行', () => withGovernor({}, async ({ state, acquire }) => {
  state.availableMiB = 512;
  const carrier = observeMemoryCarrier(() => new EventEmitter());
  try { await assert.rejects(acquire('split-prepare'), { code: 'ADMISSION_TIMEOUT' }); }
  finally { carrier.emit('exit', 0); }
  const low = await acquire('split-prepare');
  try {
    assert.equal(low.memoryMode, 'low'); state.availableMiB = 4096;
    await assert.rejects(acquire('rows-generation'), { code: 'ADMISSION_TIMEOUT' });
  } finally { low.release(); }
  const normal = await acquire('rows-generation');
  try { assert.equal(normal.memoryMode, 'normal'); } finally { normal.release(); }
}));
test('真实生产选档贯穿完整 rows 与 BizOP 工作流，普通与低内存输出一致', async () => {
  function memoryPolicyFactory({ getGovernor, sampleMemory }) {
    const { createProductionMemoryPolicy } = loadProductionMemoryProfiles({ runtime, sampleMemory });
    return createProductionMemoryPolicy({ compatibilityMemoryBytes: 0, getGovernor });
  }
  const normal = await runScenario({ rows: 1000, availableMiB: 2048, memoryPolicyFactory });
  const low = await runScenario({ rows: 1000, availableMiB: 512, memoryPolicyFactory });
  assert.equal(low.rowsDigest, normal.rowsDigest); assert.equal(low.opDigest, normal.opDigest);
  assert.deepEqual(low.exports, normal.exports); assert.ok(normal.grants.length > 0);
  assert.ok(normal.grants.every((grant) => grant.mode === 'normal'));
  for (const phase of ['split-prepare', 'rows-generation', 'bizop-import', 'bizop-compute', 'bizop-export']) {
    assert.ok(low.grants.some((grant) => grant.profileId === `${phase}-low-v1`), phase);
  }
  // 512 MiB 仍足以容纳部分 IO 普通档；真实选档保持普通优先。
  assert.ok(low.grants.some((grant) => grant.profileId === 'publication-io-normal-v1'));
});
(async () => {
  let passed = 0;
  for (const { name, run } of cases) {
    await run(); passed++; console.log(`PASS ${name}`);
  }
  console.log(`==== ${passed}/${cases.length} PASS ====`);
})().catch((error) => { console.error('FAILURES', error); process.exitCode = 1; });
