'use strict';
// VCC 财务OP整月结果导出：Main wrapper/handler → TaskLifecycle → readonly Worker → 真 XLSX → Publisher → receipt/ArchiveCenter。
// 覆盖双主体调整、一个 FilePlan/artifact、目标漂移保护、已提交接管待重试和幂等恢复；全部数据为临时合成数据。
// 用法：node scripts/integration/vcc-financial-op-result-workbook.js
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const ExcelJS = require('exceljs');
const { createResultExportFixture } = require('../../tests/helpers/vcc-result-export');
const { createVccFinancialOpService } = require('../../src/main-process/vcc-financial-op-service');
const { createResultExportHandlers } = require('../../src/main-process/vcc-financial-op-result-export-ipc');
const { acquireResultExportLease, RESULT_EXPORT_RESOURCES } = require('../../src/main-process/vcc-financial-op-result-workbook-runner');
const { createResourceGovernor } = require('../../src/main-process/background-execution/resource-governor');
const { publishVccFinancialOpOutputs } = require('../../src/main-process/vcc-financial-op-output-recovery');
const { createArchiveService } = require('../../src/main-process/archive-center/archive-service');
const { createArchiveCenterController } = require('../../src/main-process/archive-center/controller');
const { createArchiveOutboxStore } = require('../../src/main-process/archive-center/outbox-store');
const { createTaskLifecycle } = require('../../src/main-process/archive-center/task-lifecycle');
const { createArchiveAwareOperationHarness } = require('../../tests/helpers/archive-aware-operation-harness');
const { recoverToolboxPublicationsIntoArchive } = require('../../src/main-process/toolbox-archive-recovery');
const { createTestPublicationHarness, discoverToolboxPublicationRecovery } = require('../../tests/helpers/publication-authority');

let passed = 0;
function check(label, run) { run(); passed += 1; console.log(`PASS ${label}`); }
const hash = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

async function run() {
  const cleanup = [];
  let vcc, archive;
  try {
    const f = await createResultExportFixture({ after: (fn) => cleanup.push(fn) });
    const userDataDir = path.join(f.dir, 'isolated-user-data');
    archive = createArchiveService({ database: f.db, rootDir: f.archiveRoot });
    assert.equal((await archive.initialize({ deferStartupRecovery: true, startBackgroundMaterialization: false })).ok, true);
    const outboxStore = createArchiveOutboxStore(path.join(userDataDir, 'run-data', 'archive-center', 'outbox'));
    const controller = createArchiveCenterController({
      database: { getSetting: () => null, setSetting() {}, listTemplates: () => [] }, service: archive,
      outboxStore
    });
    const publication = createTestPublicationHarness(userDataDir);
    const governor = createResourceGovernor({ budgets: RESULT_EXPORT_RESOURCES });
    vcc = createVccFinancialOpService({ database: { db: f.db, dbPath: f.dbPath }, assetsDir: f.assetsDir,
      acquireResultExportLeaseFn: (operationKey) => acquireResultExportLease(governor, operationKey),
      publishOutputFilesFn: (payload) => publishVccFinancialOpOutputs({ ...payload, userDataDir, archiveCenter: controller,
        publishPublication: (options) => publication.dispatcher.publish({ ...options, requireArchiveHandoff: true }),
        recoverPublications: publication.recovery.recover })
    });
    // 直接执行 src/main.js 的原登记和结算函数，只有系统对话框、窗口及临时目录使用夹具。
    const main = fs.readFileSync(path.resolve(__dirname, '../../src/main.js'), 'utf8');
    const start = main.indexOf("  trackedIpcHandle('vccFinancialOp:export:result'");
    const end = main.indexOf("  trackedIpcHandle('vccFinancialOp:export:import-audit'", start);
    const settleStart = main.indexOf('async function settleVccOutputPublication(');
    const settleEnd = main.indexOf('\nfunction reportArchiveFailure(', settleStart);
    assert.ok(start >= 0 && end > start && settleStart >= 0);
    const targetPath = path.join(f.dir, '2026-06_结果.xlsx');
    let handlers, dialogOptions;
    const scope = { trackedIpcHandle: (channel, _module, _name, value) => {
      assert.equal(channel, 'vccFinancialOp:export:result'); handlers = value;
    }, createResultExportHandlers, getVccFinancialOpService: () => vcc,
    dialog: { showSaveDialog: async (_window, options) => { dialogOptions = options; return { filePath: targetPath }; } },
    mainWindow: null, app: { getPath: () => f.dir },
    createVccOutputStagingDirectory: () => fs.mkdtempSync(path.join(f.dir, 'generation-')),
    cleanupVccOutputStagingDirectory: (dir) => fs.rmSync(dir, { recursive: true, force: true }) };
    Function(...Object.keys(scope), main.slice(settleStart, settleEnd) + main.slice(start, end))(...Object.values(scope));
    let prepared, plan, batchContext, handoffCalls = 0, ackCalls = 0;
    const taskRunId = 'result-workbook-integration';
    const lifecycle = createTaskLifecycle({ archiveService: archive,
      businessOperationRegistry: { begin: () => ({ accepted: true, token: taskRunId }), end() {} },
      flowResolver: { resolve: async () => ({ parentRunId: 'result-export-parent', source: 'new', identity: null }),
        bind: async () => [], persistBindIntent: async () => ({ ok: true }) },
      operationTracker: { appendOperationFiles: async () => ({ ok: true }) },
      persistTerminalIntent: (payload) => controller.persistTaskTerminalIntent(payload)
    });
    const execute = handlers.execute;
    handlers.execute = async (event, preparedInput, context) => {
      prepared = preparedInput; plan = context.fileEvidence.filePlan; batchContext = context.batchContext;
      return execute(event, preparedInput, context);
    };
    const harness = createArchiveAwareOperationHarness({ channel: 'vccFinancialOp:export:result',
      runLifecycle: (input) => lifecycle.runFileTask({ ...input, taskRunId, operationKey: taskRunId }),
      bindings: { acknowledgeToolboxPublicationReceipts() { ackCalls += 1; } }
    });
    const originalSettle = archive.settleManifestArtifacts.bind(archive);
    // REC-02：注入真实生命周期首次缓存的 rejection，外围不得再次抛成导出失败。
    archive.settleManifestArtifacts = async () => {
      handoffCalls += 1;
      throw Object.assign(new Error('injected archive handoff unavailable'), { code: 'INJECTED_REC02' });
    };
    const sourceHash = hash(f.filePath);
    const result = await harness.run(handlers, { args: [{ targetMonth: '2026-06', outputPath: '/ignored', subjects: ['ignored'] }] });
    archive.settleManifestArtifacts = originalSettle;
    check('多主体页面实际入口准备一个月度命名文件', () => {
      assert.equal(plan.outputs.length, 1); assert.equal(plan.inputs.length, 0);
      assert.equal(path.basename(dialogOptions.defaultPath), '2026-06_VCC财务OP校验结果表.xlsx');
      assert.deepEqual(prepared.subjects.slice().sort(), ['乙', '甲'].sort());
    });
    check('已提交待接管经真实 Main wrapper/TaskLifecycle 保留成功、单文件及准确告警', () => {
      assert.equal(result.status, 'success', JSON.stringify(result));
      assert.equal(result.pendingArchiveHandoff, true); assert.ok(result.warnings.some((s) => s.includes('接管')));
      assert.deepEqual(result.filePaths, [targetPath]); assert.equal(result.artifactCount, 1);
      assert.equal(result.subjectCount, 2); assert.equal(result.sheetCount, 4);
      assert.equal(result.layout, 'subject-sheets-v1'); assert.equal(result.ownedGenerationDirectory, undefined);
      assert.equal(prepared.vccOutputPublicationTaskIds.length, 1);
      assert.equal(handoffCalls, 1); assert.equal(ackCalls, 0);
      assert.equal(governor.snapshot().available.memoryBytes, RESULT_EXPORT_RESOURCES.memoryBytes);
    });
    const book = new ExcelJS.Workbook(); await book.xlsx.readFile(targetPath);
    check('真实工作簿包含全部主体主表、Pending 及独立调整引用', () => {
      assert.equal(book.worksheets.length, 4);
      for (const [index, subject] of prepared.subjects.entries()) {
        assert.equal(book.worksheets[index].name, `${subject}-结果表`);
        assert.equal(book.worksheets[index + 2].name, `${subject}-移除归档Pending发生额计算表`);
        const sheet = book.worksheets[index];
        const adjustment = f.effective.adjustments.find((row) => row.subject === subject);
        const row = sheet.getColumn(14).values.findIndex((value) => value === adjustment.reason);
        assert.ok(row > 0); assert.equal(sheet.getCell(row, 13).value, Number(adjustment.adjustmentAmount));
        assert.equal(sheet.getCell(row, 13).names.length, 1);
      }
    });
    const targetHash = hash(targetPath);
    check('未接管时真实 receipt 与正式文件均保留，原始输入未动', () => {
      const records = discoverToolboxPublicationRecovery({ userDataDir }).records;
      assert.ok(records.some((item) => item.taskId === prepared.vccOutputPublicationTaskIds[0]));
      assert.equal(archive.repository.getBatchDetail(batchContext.batchId).taskStatus, 'running');
      assert.equal(hash(f.filePath), sourceHash);
    });
    check('外围持久化原 owner 的 succeeded 意图且不提前 ACK', () => {
      const records = outboxStore.list();
      assert.equal(records.length, 1);
      const intent = records[0].payload;
      assert.deepEqual(intent.owner.batchContext, batchContext);
      assert.equal(intent.terminalOutcome.taskStatus, 'succeeded');
      assert.equal(intent.terminalOutcome.metadata._archiveAfterTerminalPending, true);
      assert.equal(intent.settleFiles.length, 1);
      assert.equal(intent.settleFiles[0].artifactKey, plan.outputs[0].artifactKey);
      assert.equal(intent.settleFiles[0].expectedSha256, targetHash);
      assert.equal(intent.settleFiles[0].expectedSizeBytes, fs.statSync(targetPath).size);
      assert.equal(ackCalls, 0);
    });
    await recoverToolboxPublicationsIntoArchive({ userDataDir, archiveCenter: controller,
      recoverPublications: publication.recovery.recover, taskIds: prepared.vccOutputPublicationTaskIds });
    check('恢复原批次为一个耐久 artifact，ACK 后清理 receipt', () => {
      const detail = archive.repository.getBatchDetail(batchContext.batchId);
      assert.equal(detail.taskStatus, 'succeeded'); assert.equal(detail.artifacts.length, 1);
      assert.equal(detail.artifacts[0].artifactKey, plan.outputs[0].artifactKey);
      assert.equal(detail.artifacts[0].status, 'ready'); assert.equal(hash(targetPath), targetHash);
      assert.equal(discoverToolboxPublicationRecovery({ userDataDir }).records.length, 0);
    });
    const flushed = await controller.flushOutbox();
    check('原 owner 完成后清除遗留终态意图', () => {
      assert.equal(flushed.remaining, 0); assert.equal(outboxStore.list().length, 0);
      assert.equal(archive.repository.getTaskRun(taskRunId).status, 'succeeded');
    });
    await recoverToolboxPublicationsIntoArchive({ userDataDir, archiveCenter: controller, recoverPublications: publication.recovery.recover });
    await controller.flushOutbox();
    check('重复恢复不重写文件、不新增 artifact，所有 Worker 临时目录收口', () => {
      assert.equal(hash(targetPath), targetHash);
      assert.equal(outboxStore.list().length, 0);
      assert.equal(archive.repository.getBatchDetail(batchContext.batchId).artifacts.length, 1);
      assert.equal(fs.readdirSync(f.dir).filter((name) => name.startsWith('generation-')).length, 0);
    });
    // 保存位置已确认后出现同名文件：publisher 必须保护新文件，不能覆盖或生成部分正式结果。
    const staleTarget = path.join(f.dir, 'stale-target.xlsx');
    fs.writeFileSync(staleTarget, 'new occupant');
    const staleStaging = fs.mkdtempSync(path.join(f.dir, 'stale-generation-'));
    await assert.rejects(vcc.exportRun({ targetMonth: prepared.targetMonth, expectedRunId: prepared.runId,
      expectedSubjects: prepared.subjects, outputPaths: [staleTarget], publicationStagingDirectory: staleStaging,
      targetSnapshots: [{ exists: false }] }, { ...batchContext, taskRunId: 'stale-task', operationKey: 'stale-operation' }));
    check('目标快照漂移拒绝发布，外来目标原字节保留', () => assert.equal(fs.readFileSync(staleTarget, 'utf8'), 'new occupant'));
    console.log(`METRICS ${JSON.stringify(result.workerMetrics)}`);
    console.log(`==== ${passed}/${passed} PASS ====`);
  } finally {
    await vcc?.terminate(); await archive?.pauseBackgroundMaterialization();
    for (const fn of cleanup.reverse()) await fn();
  }
}
run().catch((error) => { console.error('FAILURES', error); process.exitCode = 1; });
