'use strict';
// R4：真实 BizOP 异常导入自动报告与 Main 合表 execute 重叠，含真实 SQLite、
// TaskLifecycle、生成 Worker、Publisher、恢复和归档 ACK。仅时序、内存读数、
// 文件选择与日志宿主使用夹具；未启动 Electron GUI。无预先孤儿 publication。
// 用法：node scripts/integration/publication-legacy-concurrency.js
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const XLSX = require('xlsx');
const { createExportHost } = require('../../tests/helpers/biz-op-v327-export');
const { writeXlsx, opRow } = require('../../tests/helpers/biz-op-v327-xlsx');
const { createBizOpAutoErrorReportService } = require('../../src/main-process/biz-op-v327/auto-error-report');
const { createResourceGovernor } = require('../../src/main-process/background-execution/resource-governor');
const { createExperimentalMemoryPolicy } = require('../../src/main-process/execution-descriptors/memory-profiles');
const { inventoryForGovernor, registerWithMemoryActivity, sealMemoryActivityInventory, memoryActivitySnapshot } = require('../../src/main-process/memory-activity');
const { createTaskPolicyRegistry } = require('../../src/main-process/execution-descriptors/composition');
const { createIpcTaskContext } = require('../../src/main-process/archive-center/ipc-task-contract');
const { normalizeFilePlanV1 } = require('../../src/main-process/archive-center/file-plan');
const { createArchiveCenterController } = require('../../src/main-process/archive-center/controller');
const { createArchiveOutboxStore } = require('../../src/main-process/archive-center/outbox-store');
const { TOOLBOX_GENERATION_ACTIONS } = require('../../src/main-process/toolbox-background/generation-contract');
const { generateValidateAndPublish } = require('../../src/main-process/toolbox-background/generation-validator');
const { acknowledgeToolboxPublicationReceipts: acknowledgeToolboxPublicationReceiptsIntoArchive,
  recoverToolboxPublicationsIntoArchive, toolboxRecoveryOutputFiles } = require('../../src/main-process/toolbox-archive-recovery');
const { JOURNAL_INDEX_NAME } = require('../../src/main-process/toolbox-output-publication');
const MiB = 1024 ** 2;
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
const digest = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const main = fs.readFileSync(path.resolve(__dirname, '../../src/main.js'), 'utf8');
function section(start, end) {
  const a = main.indexOf(start), b = main.indexOf(end, a);
  assert.ok(a >= 0 && b > a, `Main section missing: ${start}`); return main.slice(a, b);
}
const source = [section('function toolboxFailureResult(', 'const EMPTY_TOOLBOX_WARNING_SUMMARY'),
  section('async function publishToolboxArtifacts(', 'function captureToolboxTargetSnapshot('),
  section("trackedIpcHandle('toolbox:merge'", '  // IPC 2 ——')].join('\n');

async function until(check, description) {
  const deadline = Date.now() + 4000;
  while (!check()) {
    assert.ok(Date.now() < deadline, `未到达指定时序：${description}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function scenario(mode) {
  const cleanups = [], allowPublish = deferred(), generated = deferred();
  let mergePromise, reportPromise, controller;
  sealMemoryActivityInventory();
  const grants = [];
  const governor = createResourceGovernor({ memoryRecheckMs: 5,
    budgets: { cpuSlots: 4, workerThreadSlots: 4, utilityProcessSlots: 1, ioHeavySlots: 2, memoryBytes: 2048 * MiB },
    memoryAdmission: createExperimentalMemoryPolicy({ modes: [mode], compatibilityMemoryBytes: 2048 * MiB,
      sampleMemory: () => ({ availableBytes: 4096 * MiB, sampledAt: Date.now() }),
      inventory: () => inventoryForGovernor(() => governor) }),
    diagnostics(event) { if (event.type === 'resource-granted') grants.push(event); }
  });
  try {
    const f = await createExportHost({ after: (fn) => cleanups.push(fn) }, { resourceGovernor: governor, getArchiveCenter: () => controller });
    const bad = path.join(f.root, 'invalid-op.xlsx');
    await writeXlsx(bad, { kind: 'OP', rowCount: 2, row: () => opRow({ end: '999' }) });
    let identity;
    const businessResult = await f.run([bad], { onTaskIdentified(value) { identity = value; } });
    assert.equal(businessResult.code, 'BIZOP_IMPORT_REJECTED');
    assert.equal((await f.module.recovery.run()).ready, true);
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM biz_op_v327_publications').get().n, 0);
    const originalResult = structuredClone(businessResult);
    const inputs = [0, 1].map((index) => {
      const file = path.join(f.outputRoot, `input-${index}.xlsx`);
      const book = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([['序号', '编号'], [index + 1, `0000${index + 1}`]]), '数据');
      XLSX.writeFile(book, file); return file;
    });
    const inputHashes = inputs.map(digest);
    const target = path.join(f.outputRoot, 'merged.xlsx');
    const filePlan = normalizeFilePlanV1({ version: 1, allocation: 'eager',
      inputs: inputs.map((filePath) => ({ filePath, role: 'input', sourceOperation: 'toolbox:merge' })),
      outputs: [{ filePath: target, role: 'output', sourceOperation: 'toolbox:merge' }] });
    controller = createArchiveCenterController({ service: f.service,
      outboxStore: createArchiveOutboxStore(path.join(f.root, 'archive-outbox')),
      database: { getSetting: () => null, setSetting() {} } });
    const activity = []; let contract, observedContinuation = false;
    const scope = { fs, os, path, randomUUID, TOOLBOX_GENERATION_ACTIONS,
      trackedIpcHandle: (_channel, _scope, _label, value) => { contract = value; },
      app: { getPath: () => f.root }, EMPTY_TOOLBOX_WARNING_SUMMARY: { warningCount: 0, warningSamples: [] },
      backgroundExecutionRuntimeManager: { isProductionEnabled: () => true,
        get: () => ({ execute: (request) => f.runtime.execute({ ...request, production: false }) }) },
      generateValidateAndPublishToolboxArtifact: generateValidateAndPublish,
      async publishToolboxPublicationAsync(options) {
        generated.resolve(); await allowPublish.promise;
        return f.publicationDispatcher.publish({ ...options, requireArchiveHandoff: true,
          onProgress() {
            const lease = governor.snapshot().activeLeases.find((item) => item.actionKey === 'publication:legacy-observation');
            if (lease) {
              observedContinuation = true;
              assert.equal(lease.memoryConfig, null); assert.equal(lease.resources.memoryBytes, 1024 * MiB);
              assert.ok(memoryActivitySnapshot().blockers.some((item) => item.kind === 'main' && item.maxGrowthBytes === null));
            }
          } });
      },
      recoverArchivePublications: f.publicationRecovery.forOwner('archive-publication').recover,
      acknowledgeToolboxPublicationReceiptsIntoArchive, recoverToolboxPublicationsIntoArchive,
      archiveCenterService: controller, toolboxFinalOutputFiles: toolboxRecoveryOutputFiles,
      appendActivityLogEntry: (entry) => activity.push(entry), buildToolboxAuditDetailLines: () => [] };
    const helpers = Function(...Object.keys(scope), source + '\nreturn { acknowledgeToolboxPublicationReceipts };')(...Object.values(scope));
    const callbacks = new Map(), ipc = { handle: (channel, callback) => callbacks.set(channel, callback) };
    const policy = createTaskPolicyRegistry().require('toolbox:merge');
    const prepared = { filePlan };
    registerWithMemoryActivity(ipc, () => ipc.handle('toolbox:merge', (event) => f.lifecycle.runFileTask({
      policy, meta: { channel: policy.channel }, filePlanResolver: () => filePlan,
      execute: (context, controls) => contract.execute(event, prepared, createIpcTaskContext(context, controls)),
      afterTerminal: async () => helpers.acknowledgeToolboxPublicationReceipts(prepared.toolboxPublicationTaskIds)
    })));
    mergePromise = callbacks.get('toolbox:merge')({ sender: { id: 1 } });
    await Promise.race([generated.promise, mergePromise.then((result) => { throw new Error(`合表未到达 Publisher：${JSON.stringify(result)}`); })]);
    assert.equal(governor.snapshot().activeLeaseCount, 0, '合表生成 Worker 已退出');
    let exportOutcome;
    const auto = createBizOpAutoErrorReportService({ module: { ...f.module, async runExport(options) {
      try { exportOutcome = await f.module.runExport(options); return exportOutcome; }
      catch (error) { exportOutcome = { code: error.code, message: error.message, stack: error.stack, cause: error.cause }; throw error; }
    } }, getStorageRoot: () => f.outputRoot });
    reportPromise = auto.save({ identity, businessResult, taskLifecycle: f.lifecycle, runtime: f.runtime, recoveryReady: true });
    await until(() => governor.snapshot().queued.size === 1, '自动报告先登记 publication 并排队');
    const pending = f.db.prepare('SELECT * FROM biz_op_v327_publications WHERE cleanup_completed=0').all();
    assert.equal(pending.length, 1); assert.equal(pending[0].state, 'NOT_STARTED');
    assert.equal(governor.snapshot().queued.entries[0].priority, 'normal');
    assert.equal(grants.some((item) => item.actionKey === 'biz-op-v327:export-errors'), false);
    const started = Date.now(); allowPublish.resolve();
    const merged = await mergePromise;
    assert.equal(merged.status, 'success', JSON.stringify(merged));
    const saved = await reportPromise;
    assert.equal(saved.errorReport?.status, 'saved', JSON.stringify({ saved, exportOutcome,
      publication: f.module.publication.record(saved.errorReport?.taskRunId) }));
    assert.equal(saved.cleanupPending, false);
    assert.equal(observedContinuation, true, '真实 Publisher 持有兼容观察租约');
    assert.deepEqual(businessResult, originalResult);
    assert.deepEqual(inputs.map(digest), inputHashes);
    const mergedBook = XLSX.readFile(target);
    assert.deepEqual(XLSX.utils.sheet_to_json(mergedBook.Sheets[mergedBook.SheetNames[0]], { header: 1 }),
      [['序号', '编号'], [1, '00001'], [2, '00002']]);
    const report = XLSX.readFile(path.join(f.outputRoot, saved.errorReport.relativePath));
    assert.deepEqual(report.SheetNames, ['导入错误报告', '核对说明']);
    assert.equal(XLSX.utils.sheet_to_json(report.Sheets['导入错误报告']).length, 2);
    assert.equal(f.module.publication.record(saved.errorReport.taskRunId).cleanup_completed, 1);
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM biz_op_v327_read_pins').get().n, 0);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.root, JOURNAL_INDEX_NAME), 'utf8')).entries, []);
    assert.equal(activity.some((entry) => entry.level === 'error'), false, JSON.stringify(activity));
    assert.equal(governor.snapshot().activeLeaseCount, 0); assert.equal(governor.snapshot().queued.size, 0);
    assert.deepEqual(memoryActivitySnapshot().blockers, []);
    const exports = grants.filter((item) => item.actionKey === 'biz-op-v327:export-errors');
    assert.ok(exports.length > 0 && exports.every((item) => item.memoryMode === mode));
    console.log(`PASS ${mode}：自动报告先排队，合表与报告均发布／归档／ACK 完成，${Date.now() - started}ms`);
  } finally {
    allowPublish.resolve();
    await Promise.allSettled([mergePromise, reportPromise].filter(Boolean));
    for (const cleanup of cleanups) await cleanup();
  }
}
(async () => { for (const mode of ['normal', 'low']) await scenario(mode); console.log('2/2 PASS'); })()
  .catch((error) => { console.error('FAIL', error); process.exitCode = 1; });
