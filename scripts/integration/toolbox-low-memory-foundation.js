'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Worker, isMainThread, parentPort, workerData } = require('node:worker_threads');
const MiB = 1024 ** 2;

async function workerMain() {
  const { validateExecutionMemoryConfig } = require('../../src/main-process/background-execution/execution-memory-config');
  const { scanSplitMetadata } = require('../../src/main-process/toolbox-split-scan');
  const config = validateExecutionMemoryConfig(workerData.memoryConfig);
  const cancelToken = { cancelled: false };
  parentPort.on('message', (message) => { if (message === 'cancel') cancelToken.cancelled = true; });
  parentPort.postMessage({ ready: true });
  try {
    const result = await scanSplitMetadata(workerData.filePath, { cancelToken, readerOptions: {
      sharedStringsMode: 'adaptive', sstTempRoot: path.join(workerData.privateDirectory, 'sst'),
      memoryBudgetBytes: config.sstMemoryBytes, cacheMaxBytes: config.sstCacheBytes
    } });
    parentPort.postMessage({ result, profileId: config.profileId });
  } catch (error) {
    parentPort.postMessage({ error: { message: error.message, code: error.code || null } });
  } finally {
    // 留出真实结果已发送、载体尚存活的窗口，验证 owner 不提前清理或释放。
    setTimeout(() => parentPort.close(), 40);
  }
}

async function main() {
  const { createResourceGovernor } = require('../../src/main-process/background-execution/resource-governor');
  const { createMemoryAdmissionPolicy } = require('../../src/main-process/background-execution/memory-admission');
  const { createAdmissionOnlyOwner } = require('../../src/main-process/background-execution/admission-only-owner');
  const XLSX = require('xlsx');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'low-memory-foundation-'));
  let passed = 0;
  const vector = (memoryBytes) => ({ cpuSlots: 0, workerThreadSlots: 1, utilityProcessSlots: 0, ioHeavySlots: 0, memoryBytes });
  const config = {
    version: 1, profileId: 'integration-only', policyDigest: 'c'.repeat(64), phaseKey: 'prepare-metadata',
    phaseMemoryBytes: 256 * MiB, systemReserveBytes: 128 * MiB,
    sstMemoryBytes: 1024, sstCacheBytes: 1024, styleCacheBytes: MiB,
    sqliteAggregateCacheBytes: MiB, maxOpenConnections: 1, maxInFlightBytes: MiB,
    maxSingleRecordBytes: MiB, workerLimits: { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 8 },
    validatedEvidenceId: 'synthetic-integration-only'
  };
  // 这里注入内存数字只验证调度合同；真实内存证据由独立 probe 采集。
  const governor = createResourceGovernor({ budgets: vector(2048 * MiB), memoryAdmission: createMemoryAdmissionPolicy({
    compatibilityMemoryBytes: 0,
    resolveRequest: (request) => request.actionKey === 'scan-metadata' ? {
      migrated: true, heavy: true, maxGrowthBytes: 0, candidates: [{ mode: 'low', config }]
    } : null,
    isEvidenceValid: (value) => value.validatedEvidenceId === 'synthetic-integration-only',
    externalPressure: () => ({ inventoryComplete: true, blockers: [] }),
    sampleMemory: () => ({ availableBytes: 512 * MiB, sampledAt: Date.now() })
  }) });
  const privateRoots = new Map();
  const workerFacts = [];
  let earlyResults = 0, cleanups = 0;
  const owner = createAdmissionOnlyOwner({ governor,
    descriptor: { ownerKey: 'integration-scan', actionKey: 'scan-metadata', resources: vector(1024 * MiB), timeoutMs: 5000 },
    start(input, grant) {
      const privateDirectory = fs.mkdtempSync(path.join(root, 'scan-'));
      privateRoots.set(input, privateDirectory);
      const worker = new Worker(__filename, { resourceLimits: grant.memoryConfig.workerLimits,
        workerData: { filePath: input.filePath, privateDirectory, memoryConfig: grant.memoryConfig } });
      const fact = { exited: false, limits: worker.resourceLimits };
      workerFacts.push(fact);
      let resolveResult, rejectResult;
      const promise = new Promise((resolve, reject) => { resolveResult = resolve; rejectResult = reject; });
      const closed = new Promise((resolve) => worker.once('exit', (code) => {
        fact.exited = true; resolve({ exitCode: code });
        if (code !== 0) rejectResult(new Error(`exit=${code}`));
      }));
      worker.on('error', rejectResult);
      worker.on('message', (message) => {
        if (message.ready) { if (input.cancelAtReady) input.cancelAtReady(); return; }
        assert.equal(governor.snapshot().activeLeaseCount, 1);
        assert.equal(fs.existsSync(privateDirectory), true);
        assert.equal(fact.exited, false);
        earlyResults++;
        if (message.error) rejectResult(Object.assign(new Error(message.error.message), { code: message.error.code }));
        else {
          assert.equal(message.profileId, grant.memoryConfig.profileId);
          resolveResult(message.result);
        }
      });
      return { promise, closed, cancel() { worker.postMessage('cancel'); } };
    },
    cleanup(input) {
      assert.equal(workerFacts.at(-1).exited, true);
      fs.rmSync(privateRoots.get(input), { recursive: true, force: true });
      privateRoots.delete(input);
      cleanups++;
    }
  });
  try {
    const filePath = path.join(root, 'source.xlsx');
    const workbook = XLSX.utils.book_new();
    const rows = [['编号', '值'], ...Array.from({ length: 3000 }, (_, index) => [index, `合成文本-${index}`])];
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(rows), '主表');
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([['编号', '值'], [3000, '隐藏续页']]), '隐藏');
    workbook.Workbook = { Sheets: [{ Hidden: 0 }, { Hidden: 1 }] };
    XLSX.writeFile(workbook, filePath, { bookSST: true });
    const sourceBefore = fs.readFileSync(filePath);
    await assert.rejects(governor.acquirePhaseLease({ ownerKey: 'old', actionKey: 'legacy', resources: vector(MiB) }),
      { code: 'RESOURCE_BUDGET_UNAVAILABLE' });
    assert.equal(governor.snapshot().queued.size, 0);
    passed++;
    assert.deepEqual(await owner.run({ filePath }), { headers: ['编号', '值'], dataRowCount: 3001 });
    assert.equal(workerFacts.at(-1).limits.maxOldGenerationSizeMb, 128);
    assert.equal(governor.snapshot().activeLeaseCount, 0);
    assert.equal(privateRoots.size, 0);
    passed++;
    await assert.rejects(owner.run({ filePath: path.join(root, 'missing.xlsx') }));
    assert.equal(governor.snapshot().activeLeaseCount, 0);
    assert.equal(privateRoots.size, 0);
    passed++;
    const controller = new AbortController();
    await assert.rejects(owner.run({ filePath, cancelAtReady: () => controller.abort() }, { signal: controller.signal }));
    assert.equal(governor.snapshot().activeLeaseCount, 0);
    assert.equal(privateRoots.size, 0);
    assert.equal(earlyResults, 3);
    assert.equal(cleanups, 3);
    assert.deepEqual(fs.readFileSync(filePath), sourceBefore);
    assert.deepEqual(await owner.close(), { closed: true, unclosedCount: 0 });
    passed++;
    process.stdout.write(`${passed}/4 PASS：真实 Worker、获批配置、metadata/SST、退出屏障与清理；调度数值为注入夹具。\n`);
  } finally {
    await owner.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

if (!isMainThread) workerMain().catch((error) => { throw error; });
else main().catch((error) => { process.stderr.write(error.stack + '\n'); process.exitCode = 1; });
