'use strict';
// 真实 Governor、owner、恢复协调器和 Worker；仅注入内存读数。
// v3.2.20：业务OP数据核对下线，BizOP publication owner 及其兼容额度用例随之删除。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { createResourceGovernor } = require('../../src/main-process/background-execution/resource-governor');
const { createPlatformResourceEnvelope } = require('../../src/main-process/background-execution/resource-budget');
const { createExperimentalMemoryPolicy } = require('../../src/main-process/execution-descriptors/memory-profiles');
const { loadProductionMemoryProfiles } = require('../../tests/helpers/production-memory-policy');
const { createProductionMemoryPolicy } = loadProductionMemoryProfiles({ qualification: { schemaVersion: 2, status: 'pending' } });
const { createPublicationMemoryAdmission } = require('../../src/main-process/execution-descriptors/publication-memory');
const { createPublicationRecoveryCoordinator } = require('../../src/main-process/publication-recovery/coordinator');
const { createToolboxPublicationDispatcher } = require('../../src/main-process/toolbox-output-publication-dispatch');
const { createArchivePublicationOwner } = require('../../src/main-process/publication-recovery/archive-owner');
const { recoverToolboxPublicationsIntoArchive } = require('../../src/main-process/toolbox-archive-recovery');
const { registerMemoryGovernor, registerWithMemoryActivity, memoryActivitySnapshot, inventoryForGovernor } = require('../../src/main-process/memory-activity');
const publication = require('../../tests/helpers/publication-authority');
const MiB = 1024 ** 2;
const tests = [];
const test = (name, run) => tests.push({ name, run });
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };

async function withHarness(options, run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'publication-memory-'));
  const envelope = createPlatformResourceEnvelope({ availableParallelism: 4, totalMemoryBytes: 8192 * MiB,
    freeMemoryBytes: (options.freeMiB ?? 4096) * MiB });
  let governor;
  const policy = options.mode ? createExperimentalMemoryPolicy({ modes: [options.mode],
    compatibilityMemoryBytes: envelope.compatibilityBudgets.memoryBytes,
    sampleMemory: () => ({ availableBytes: 4096 * MiB, sampledAt: Date.now() }),
    inventory: () => inventoryForGovernor(() => governor) })
    : createProductionMemoryPolicy({ compatibilityMemoryBytes: envelope.compatibilityBudgets.memoryBytes, getGovernor: () => governor });
  governor = createResourceGovernor({ budgets: envelope.hardBudgets, memoryRecheckMs: 5, memoryAdmission: policy });
  const unregister = registerMemoryGovernor(governor);
  const callbacks = new Map();
  const ipc = { handle: (channel, callback) => callbacks.set(channel, callback) };
  const archiveCenter = { persistAppendIntent() { throw new Error('空恢复不得新增归档记录'); }, async flushOutbox() {} };
  const exits = [];
  const dispatcher = createToolboxPublicationDispatcher({ workerScriptPath: options.workerScriptPath,
    onWorkerExit({ op }) { exits.push({ op, leases: governor.snapshot().activeLeases, activity: memoryActivitySnapshot() }); } });
  const coordinator = createPublicationRecoveryCoordinator({ userDataDir: root, dispatcher,
    owners: [createArchivePublicationOwner({ getArchiveCenter: () => archiveCenter })],
    acquireMemory: createPublicationMemoryAdmission(() => ({ resourceGovernor: governor })) });
  coordinator.bindDispatcherAuthority();
  const recover = (request = {}) => coordinator.forOwner('archive-publication').recover(request);
  registerWithMemoryActivity(ipc, () => ipc.handle('legacy:publication-recover', (_event, request) => recover(request)));
  try {
    await run({ root, governor, coordinator, dispatcher, archiveCenter, exits, recover, ipc, callbacks, envelope });
  } finally {
    assert.equal(governor.snapshot().activeLeaseCount, 0, '结束后租约归零');
    assert.deepEqual(memoryActivitySnapshot().blockers, [], '结束后观察归零');
    assert.equal(unregister(), true);
    fs.rmSync(root, { recursive: true, force: true });
  }
}

for (const freeMiB of [512, 2560]) test(`生产策略配 pending 资格：可用 ${freeMiB} MiB 时空启动恢复成功`, () => withHarness({ freeMiB }, async (h) => {
  assert.equal(h.envelope.compatibilityBudgets.memoryBytes / MiB, freeMiB === 512 ? 0 : 512);
  const result = await recoverToolboxPublicationsIntoArchive({ userDataDir: h.root, archiveCenter: h.archiveCenter,
    recoverPublications: h.recover });
  assert.deepEqual(result.recovered, []);
  assert.deepEqual(h.exits.map((e) => e.op), ['discover-recovery', 'execute-recovery']);
  for (const { leases } of h.exits) {
    assert.equal(leases.length, 1, '零内存记账仍持有 CPU/Worker/IO 租约至真退出');
    assert.equal(leases[0].resources.memoryBytes, 0);
    assert.equal(leases[0].resources.workerThreadSlots, 1);
    assert.equal(leases[0].resources.ioHeavySlots, 1);
    assert.equal(leases[0].memoryConfig, null);
  }
}));

test('兼容预算为零时，损坏索引仍报错并保留原件', () => withHarness({ freeMiB: 512 }, async (h) => {
  const index = path.join(h.root, publication.JOURNAL_INDEX_NAME);
  fs.writeFileSync(index, '{broken');
  await assert.rejects(h.recover({ reason: 'startup' }), (error) => {
    assert.equal(error.code, 'TOOLBOX_PUBLICATION_MANUAL_RECOVERY');
    assert.equal(error.preserveTemporaryFiles, true);
    assert.ok(error.recoveryPaths.includes(index));
    return true;
  });
  assert.equal(fs.readFileSync(index, 'utf8'), '{broken');
  assert.deepEqual(h.exits.map((e) => e.op), ['discover-recovery']);
}));

test('兼容预算为零时，真实未提交 publication 的未知 owner 仍阻止恢复', () => withHarness({ freeMiB: 512 }, async (h) => {
  fs.mkdirSync(path.join(h.root, 'generation'));
  fs.mkdirSync(path.join(h.root, 'output'));
  const sourcePath = path.join(h.root, 'generation/source.xlsx'), targetPath = path.join(h.root, 'output/result.xlsx');
  fs.writeFileSync(sourcePath, 'generated'); fs.writeFileSync(targetPath, 'original');
  publication.prepareToolboxPublication({ userDataDir: h.root, taskId: 'unknown-owner',
    artifacts: [{ sourcePath }], targets: [targetPath] });
  const snapshot = publication.discoverToolboxPublicationRecovery({ userDataDir: h.root });
  const files = [path.join(h.root, publication.JOURNAL_INDEX_NAME), sourcePath, targetPath,
    ...snapshot.records.flatMap((r) => [r.journalPath, ...r.indexEntry.stagedAbsolutePaths])];
  const before = files.map((file) => fs.readFileSync(file));
  await assert.rejects(h.recover({ reason: 'startup' }), { code: 'PUBLICATION_RECOVERY_OWNER_UNKNOWN', preserveTemporaryFiles: true });
  files.forEach((file, index) => assert.deepEqual(fs.readFileSync(file), before[index]));
  assert.deepEqual(h.exits.map((e) => e.op), ['discover-recovery']);
}));

for (const mode of ['normal', 'low']) {
  test(`${mode} 独立恢复使用 Publisher 获批额度`, () => withHarness({ mode }, async (h) => {
    await h.recover({ reason: 'startup' });
    assert.equal(h.exits.length, 2);
    for (const { leases } of h.exits) {
      assert.equal(leases.length, 1);
      const lease = leases[0];
      assert.equal(lease.memoryConfig.phaseKey, 'publication-io');
      assert.equal(lease.memoryMode, mode);
      assert.equal(lease.resources.memoryBytes, (mode === 'normal' ? 256 : 128) * MiB);
    }
  }));

  test(`${mode} legacy IPC 内恢复不等待自身，真退出和外层完成前保护仍在`, () => withHarness({ mode,
    workerScriptPath: path.join(__dirname, '../../tests/unit/main-process/__fixtures__/toolbox-publication-stub-controlled-exit.js') }, async (h) => {
    const originalTerminate = Worker.prototype.terminate;
    const terminated = [], waiters = [], liveWorkers = new Set();
    Worker.prototype.terminate = function requestTermination() {
      liveWorkers.add(this);
      this.once('exit', () => liveWorkers.delete(this));
      if (waiters.length) waiters.shift()(this); else terminated.push(this);
      return Promise.resolve(0);
    };
    const nextWorker = () => terminated.length ? Promise.resolve(terminated.shift()) : new Promise((resolve) => waiters.push(resolve));
    const recovered = deferred(), outer = deferred();
    let running;
    try {
      registerWithMemoryActivity(h.ipc, () => h.ipc.handle('legacy:publication-recover', async () => {
        const result = await h.recover(); recovered.resolve(result); await outer.promise; return result;
      }));
      running = h.callbacks.get('legacy:publication-recover')({});
      // 捕获异步错误，防止失败时等待测试控制信号挂起。
      const checkedNext = () => Promise.race([nextWorker(), running.then(() => { throw new Error('Worker 退出前提前完成'); })]);
      for (let index = 0; index < 2; index++) {
        const worker = await checkedNext();
        assert.equal(h.exits.length, index, 'terminate Promise 结算不能替代 exit');
        assert.equal(h.governor.snapshot().activeLeases.length, 0, '嵌套在 legacy 观察内不再申请自身租约');
        assert.ok(memoryActivitySnapshot().blockers.some((b) => b.kind === 'main' && b.maxGrowthBytes === null));
        assert.ok(memoryActivitySnapshot().blockers.some((b) => b.kind === 'carrier' && b.maxGrowthBytes === null));
        worker.postMessage({ type: 'allow-exit' });
      }
      await Promise.race([recovered.promise, running]);
      assert.equal(h.governor.snapshot().activeLeaseCount, 0);
      assert.equal(memoryActivitySnapshot().blockers.length, 1, '恢复结束后外层未知增长活动仍被观察');
      await assert.rejects(h.governor.acquirePhaseLease({ ownerKey: 'toolbox-split-read', actionKey: 'toolbox:split:prepare',
        resources: { cpuSlots: 1, workerThreadSlots: 1, utilityProcessSlots: 0, ioHeavySlots: 1, memoryBytes: 1024 * MiB },
        timeoutMs: 30, lowMemoryBehavior: 'queue' }), { code: 'ADMISSION_TIMEOUT' });
      outer.resolve(); await running;
      Worker.prototype.terminate = originalTerminate;
      await h.recover();
      assert.equal(h.exits.at(-1).leases[0].memoryMode, mode, '退出 legacy wrapper 后继续使用获批档位');
    } finally {
      // 后续独立恢复用真实 terminate，前两个线程由控制信号退出。
      Worker.prototype.terminate = originalTerminate;
      outer.resolve();
      for (const worker of liveWorkers) await originalTerminate.call(worker);
      if (running) await running.catch(() => {});
    }
  }));
}

(async () => {
  let passed = 0;
  for (const { name, run } of tests) { await run(); passed++; process.stdout.write(`PASS ${name}\n`); }
  process.stdout.write(`${passed}/${tests.length} PASS；内存读数为合成输入，不代表 Windows 真压力验收。\n`);
})().catch((error) => { console.error(error); process.exitCode = 1; });
