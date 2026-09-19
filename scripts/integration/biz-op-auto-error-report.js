// 业务 OP 导入错误报告自动保存集成验证（真实原件、SQLite、TaskLifecycle 和 worker）。
// 覆盖 OP/FLOW 异常导入到 ERRORS XLSX 的发布与读取、与原手动导出逐单元格等价、
// 成功/无错误空诊断不输出、同秒失败不覆盖、数量/字节截断和扫描不完整说明，
// 以及发布后恢复和共享 BusinessOperationRegistry 的真实退出等待。
// 所有数据在自建临时目录生成，运行结束关闭 runtime/数据库并清理。
// 用法：node scripts/integration/biz-op-auto-error-report.js

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { EventEmitter } = require('node:events');
const XLSX = require('xlsx');
const { createHost } = require('../../tests/helpers/biz-op-v327-host');
const { writeXlsx, flowRow, opRow } = require('../../tests/helpers/biz-op-v327-xlsx');
const { normalizeFilePlanV1 } = require('../../src/main-process/archive-center/file-plan');
const { createBizOpAutoErrorReportService } = require('../../src/main-process/biz-op-v327/auto-error-report');
const { registerBizOpV327Handlers } = require('../../src/main-process/biz-op-v327/ipc');

const fixedNow = () => new Date('2026-09-11T04:05:06+08:00');
const cases = [];
const scenario = (name, run) => cases.push({ name, run });
const digest = (filePath) => createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');

function barrier() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function withHost(work) {
  const cleanup = [];
  try {
    const f = await createHost({ after(callback) { cleanup.push(callback); } });
    // Publisher 恢复根目录与用户输出目录必须分离，与真实 userData/Documents 布局一致。
    const outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bizop-auto-report-target-'));
    cleanup.push(() => fs.rmSync(outputRoot, { recursive: true, force: true }));
    f.storageRoot = path.join(outputRoot, 'Documents', '网银账单生成小助手');
    f.auto = createBizOpAutoErrorReportService({ module: f.module, getStorageRoot: () => f.storageRoot, now: fixedNow });
    await work(f);
  } finally {
    const errors = [];
    for (const callback of cleanup) {
      try { await callback(); } catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, '集成夹具资源清理失败');
  }
}

async function imported(f, name, definition, options) {
  const filePath = path.join(f.root, `${name}.xlsx`);
  await writeXlsx(filePath, definition);
  const identities = [];
  const businessResult = await f.run([filePath], { options, onTaskIdentified(identity) { identities.push(identity); } });
  assert.equal(identities.length, 1, '每次真实导入只报告一次 Main 任务身份');
  const identity = identities[0];
  assert.ok(f.module.catalog.task(identity.taskRunId), '身份对应已持久化的真实 Task');
  if (businessResult.reportRef) assert.equal(identity.reportRef, businessResult.reportRef);
  const recovery = await f.module.recovery.run();
  assert.equal(recovery.ready, true, JSON.stringify(recovery));
  return { identity, businessResult };
}

async function saved(f, input, auto = f.auto) {
  const before = structuredClone(input.businessResult);
  const result = await auto.save({ ...input, taskLifecycle: f.lifecycle, runtime: f.runtime, recoveryReady: true });
  assert.deepEqual(input.businessResult, before, '保存过程不改写业务结论');
  assert.equal(result.errorReport?.status, 'saved', JSON.stringify(result));
  const report = result.errorReport;
  assert.equal(path.isAbsolute(report.relativePath), false);
  assert.match(report.relativePath.replaceAll('\\', '/'), /^error-reports\/\d{4}-\d{2}-\d{2}\//);
  const filePath = path.join(f.storageRoot, report.relativePath);
  assert.equal(path.basename(filePath), report.fileName);
  assert.ok(fs.statSync(filePath).size > 0);
  assert.notEqual(report.taskRunId, input.identity.taskRunId, '报告由独立读取 Task 发布');
  assert.equal(f.module.publication.fact(report.taskRunId).state, 'COMMITTED');
  assert.equal(digest(filePath), f.module.publication.fact(report.taskRunId).outcome.files[0].sha256);
  return { result, report, filePath, workbook: XLSX.readFile(filePath, { cellNF: true }) };
}

function workbookSemantics(workbook) {
  return workbook.SheetNames.map((name) => {
    const sheet = workbook.Sheets[name];
    return { name, range: sheet['!ref'], cells: Object.keys(sheet).filter((key) => !key.startsWith('!')).sort()
      .map((address) => ({ address, type: sheet[address].t, value: sheet[address].v,
        format: sheet[address].z, formula: sheet[address].f })) };
  });
}

function reportCatalog(workbook) {
  const notes = workbook.SheetNames.filter((name) => name.startsWith('核对说明'))
    .flatMap((name) => XLSX.utils.sheet_to_json(workbook.Sheets[name]));
  const exportNotes = notes.filter((row) => row['记录类别'] === 'RUN_META' && row['字段标识'] === 'export')
    .sort((left, right) => left['片段序号'] - right['片段序号']);
  assert.ok(exportNotes.length > 0, '真实 XLSX 包含诊断汇总说明');
  return JSON.parse(exportNotes.map((row) => row['值片段']).join('')).sourceCatalog;
}

async function assertManualEquivalent(f, input, automatic, name) {
  const filePath = path.join(f.storageRoot, `manual-${name}.xlsx`);
  const manual = await f.module.runExport({ taskLifecycle: f.lifecycle, runtime: f.runtime,
    outputKind: 'ERRORS', objectId: input.identity.reportRef,
    filePlan: normalizeFilePlanV1({ version: 1, allocation: 'eager', inputs: [], outputs: [{ filePath,
      role: 'output', sourceOperation: 'bizOpReconV327:export:errors' }] }) });
  assert.equal(manual.status, 'ok', JSON.stringify(manual));
  assert.deepEqual(workbookSemantics(automatic.workbook), workbookSemantics(XLSX.readFile(filePath, { cellNF: true })),
    '同一真实诊断的工作表、表头、全部样本和说明、单元格值/类型/格式/公式完全一致');
  assert.equal((await f.module.recovery.run()).ready, true);
  assert.equal(f.module.catalog.task(input.identity.taskRunId).status, 'failed');
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM biz_op_v327_read_pins').get().n, 0);
  assert.equal(f.runtime.resourceGovernor.snapshot().activeLeaseCount, 0);
}

for (const kind of ['OP', 'FLOW']) scenario(`${kind} 真实异常原件自动导出，并与同诊断原 ERRORS 导出逐单元格等价`, () => withHost(async (f) => {
  const input = await imported(f, `bad-${kind}`, { kind, rowCount: 2,
    row: () => kind === 'OP' ? opRow({ end: '999' }) : flowRow({ direction: '错误方向' }) });
  assert.equal(input.businessResult.status, 'error');
  assert.equal(input.businessResult.code, 'BIZOP_IMPORT_REJECTED');
  assert.equal(input.businessResult.summary.rowErrorCount, 2);
  const automatic = await saved(f, input);
  assert.deepEqual(automatic.workbook.SheetNames, ['导入错误报告', '核对说明']);
  const sheet = automatic.workbook.Sheets['导入错误报告'];
  assert.deepEqual(XLSX.utils.sheet_to_json(sheet, { header: 1 })[0],
    ['记录类别', '来源原件ID', '文件顺序', '来源工作表', '来源行号', '错误代码', '错误说明']);
  assert.equal(sheet.A2.v, 'ROW');
  assert.equal(sheet.B2.t, 'n');
  assert.equal(sheet.C2.v, 0);
  assert.equal(sheet.D2.v, '原始数据');
  assert.equal(sheet.E2.v, 2);
  assert.equal(sheet.E2.t, 'n');
  assert.equal(sheet.G2.t, 's');
  await assertManualEquivalent(f, input, automatic, kind);
}));

scenario('成功导入维持成功和空诊断退役，不产生空报告或导出 Task', () => withHost(async (f) => {
  const input = await imported(f, 'good-op', { kind: 'OP', rowCount: 1, row: () => opRow() });
  assert.equal(input.businessResult.status, 'ok');
  const before = structuredClone(input.businessResult);
  const result = await f.auto.save({ ...input, taskLifecycle: f.lifecycle, runtime: f.runtime, recoveryReady: true });
  assert.deepEqual(input.businessResult, before);
  assert.equal(result.errorReport, undefined);
  assert.equal(fs.existsSync(path.join(f.storageRoot, 'error-reports')), false);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM biz_op_v327_publications').get().n, 0);
  assert.notEqual(f.db.prepare('SELECT state FROM biz_op_v327_diagnostic_reports WHERE report_ref=?')
    .get(input.identity.reportRef)?.state, 'READY');
}));

scenario('合法 OP 已封存无错误空诊断后 Main 抛错，恢复后仍不伪造空错误报告', () => withHost(async (f) => {
  const filePath = path.join(f.root, 'good-op-main-error.xlsx');
  await writeXlsx(filePath, { kind: 'OP', rowCount: 1, row: () => opRow() });
  let identity;
  let injected = false;
  await assert.rejects(f.run([filePath], {
    onTaskIdentified(value) { identity = value; },
    afterWorker({ taskRunId, candidateRef, outcome }) {
      assert.equal(outcome.outcome, 'completed');
      const importedResult = f.module.payloadStore.readDocument(`operations/${taskRunId}/${candidateRef}.json`, outcome.result.sha256).value;
      assert.equal(importedResult.rowErrorCount, 0);
      assert.equal(importedResult.fileErrorCount, 0);
      assert.equal(importedResult.collectedSamples, 0);
      assert.equal(importedResult.errorSamplesTruncated, false);
      assert.equal(importedResult.scanComplete, true);
      assert.equal(importedResult.errorCountExact, true);
      injected = true;
      throw Object.assign(new Error('合法原件封存后 Main 中断'), { code: 'BIZOP_MAIN_AFTER_WORKER' });
    }
  }), { code: 'BIZOP_MAIN_AFTER_WORKER' });
  assert.equal(injected, true);
  const recovered = await f.module.recovery.run();
  assert.equal(recovered.ready, true, JSON.stringify(recovered));
  const report = f.db.prepare('SELECT * FROM biz_op_v327_diagnostic_reports WHERE report_ref=?').get(identity.reportRef);
  assert.equal(report.state, 'READY');
  assert.equal(report.task_run_id, identity.taskRunId);
  assert.equal(report.sample_count, 0);
  assert.equal(report.scan_complete, 1);
  assert.equal(report.error_count_exact, 1);
  const businessResult = { status: 'error', code: 'BIZOP_MAIN_AFTER_WORKER', message: '合法原件封存后 Main 中断' };
  const before = structuredClone(businessResult);
  const result = await f.auto.save({ identity, businessResult, taskLifecycle: f.lifecycle, runtime: f.runtime, recoveryReady: true });
  assert.deepEqual(businessResult, before);
  assert.equal(result.errorReport?.status, 'unavailable', JSON.stringify(result));
  assert.equal(fs.existsSync(path.join(f.storageRoot, 'error-reports')), false);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM biz_op_v327_publications').get().n, 0);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM archive_task_runs WHERE task_key GLOB 'bizOpReconV327:export:*'").get().n, 0);
  assert.equal(f.module.catalog.task(identity.taskRunId).status, 'failed');
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM biz_op_v327_read_pins').get().n, 0);
  assert.equal(f.runtime.resourceGovernor.snapshot().activeLeaseCount, 0);
}));

scenario('同一秒的两次独立失败生成不同中文文件名，前一报告内容不被覆盖', () => withHost(async (f) => {
  const firstInput = await imported(f, 'first-bad', { rowCount: 1, row: () => flowRow({ direction: '错误方向甲' }) });
  const first = await saved(f, firstInput);
  const firstHash = digest(first.filePath);
  const secondInput = await imported(f, 'second-bad', { rowCount: 1, row: () => flowRow({ direction: '错误方向乙' }) });
  const second = await saved(f, secondInput);
  assert.notEqual(first.filePath, second.filePath);
  assert.notEqual(first.report.taskRunId, second.report.taskRunId);
  assert.match(first.report.fileName, /业务OP.*错误报告/u);
  assert.equal(path.dirname(first.filePath), path.dirname(second.filePath));
  assert.equal(digest(first.filePath), firstHash);
  assert.equal(fs.readdirSync(path.dirname(first.filePath)).filter((name) => name.endsWith('.xlsx')).length, 2);
}));

scenario('真实坏行超过数量预算后保留完整计数与样本截断说明', () => withHost(async (f) => {
  const input = await imported(f, 'sample-count-limit', { rowCount: 5,
    row: () => flowRow({ direction: '错误' }) }, { maxSamples: 2 });
  assert.equal(input.businessResult.summary.rowErrorCount, 5);
  assert.equal(input.businessResult.summary.collectedSamples, 2);
  const automatic = await saved(f, input);
  const catalog = reportCatalog(automatic.workbook);
  assert.equal(catalog.collectedSamples, 2);
  assert.equal(catalog.errorSamplesTruncated, true);
  assert.equal(catalog.scanComplete, true);
  assert.equal(catalog.errorCountExact, true);
  assert.equal(XLSX.utils.sheet_to_json(automatic.workbook.Sheets['导入错误报告']).length, 2);
  await assertManualEquivalent(f, input, automatic, 'sample-count-limit');
}));

scenario('真实文件级错误超过字节预算，即使零样本也导出有效说明', () => withHost(async (f) => {
  const input = await imported(f, 'file-error-byte-limit', { rowCount: 1, row: () => flowRow(), secondSheet: true },
    { maxSampleBytes: 1 });
  assert.equal(input.businessResult.status, 'error');
  assert.equal(input.businessResult.summary.fileErrorCount, 1);
  assert.equal(input.businessResult.summary.collectedSamples, 0);
  const automatic = await saved(f, input);
  const catalog = reportCatalog(automatic.workbook);
  assert.equal(catalog.collectedSamples, 0);
  assert.equal(catalog.sampleBytes, 0);
  assert.equal(catalog.errorSamplesTruncated, true);
  assert.equal(catalog.scanComplete, false);
  assert.equal(catalog.errorCountExact, false);
  assert.equal(XLSX.utils.sheet_to_json(automatic.workbook.Sheets['导入错误报告'], { header: 1 }).length, 1);
  await assertManualEquivalent(f, input, automatic, 'file-error-byte-limit');
}));

scenario('真实损坏 XML 在坏行后中断扫描，错误说明保留非精确计数和文件错误', () => withHost(async (f) => {
  const input = await imported(f, 'incomplete-scan', { rowCount: 2, brokenTail: true,
    row: (i) => flowRow({ direction: i ? '入' : '错误' }) });
  assert.equal(input.businessResult.summary.rowErrorCount, 1);
  assert.equal(input.businessResult.summary.fileErrorCount, 1);
  assert.equal(input.businessResult.summary.scanComplete, false);
  assert.equal(input.businessResult.summary.errorCountExact, false);
  const automatic = await saved(f, input);
  const catalog = reportCatalog(automatic.workbook);
  assert.equal(catalog.scanComplete, false);
  assert.equal(catalog.errorCountExact, false);
  assert.equal(catalog.errorSamplesTruncated, false);
  const rows = XLSX.utils.sheet_to_json(automatic.workbook.Sheets['导入错误报告']);
  assert.deepEqual(rows.map((row) => row['记录类别']), ['ROW', 'FILE']);
  await assertManualEquivalent(f, input, automatic, 'incomplete-scan');
}));

scenario('真实发布后 Main 异常由原任务恢复为 saved，原业务仍失败且不重复导出', () => withHost(async (f) => {
  const input = await imported(f, 'after-publish', { kind: 'OP', rowCount: 1, row: () => opRow({ end: '999' }) });
  let exportCalls = 0;
  let interruptedTask;
  const auto = createBizOpAutoErrorReportService({ getStorageRoot: () => f.storageRoot, now: fixedNow,
    module: { ...f.module, runExport(args) {
      exportCalls += 1;
      return f.module.runExport({ ...args, afterPublish({ taskRunId }) {
        interruptedTask = taskRunId;
        assert.equal(f.module.publication.fact(taskRunId).state, 'COMMITTED');
        assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM biz_op_v327_read_pins WHERE task_run_id=?').get(taskRunId).n, 1);
        throw new Error('集成故障注入：提交后的 Main 异常');
      } });
    } } });
  const automatic = await saved(f, input, auto);
  assert.equal(automatic.report.taskRunId, interruptedTask);
  assert.equal(exportCalls, 1);
  assert.equal(input.businessResult.status, 'error');
  assert.equal(f.module.catalog.task(input.identity.taskRunId).status, 'failed');
  assert.equal(f.module.catalog.task(interruptedTask).status, 'succeeded');
  assert.equal(f.module.publication.record(interruptedTask).cleanup_completed, 1);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM biz_op_v327_read_pins').get().n, 0);
  const hashBefore = digest(automatic.filePath);
  assert.equal((await f.module.recovery.run()).ready, true);
  assert.equal(digest(automatic.filePath), hashBefore);
  assert.equal(exportCalls, 1);
  assert.equal(f.runtime.resourceGovernor.snapshot().activeLeaseCount, 0);
}));

scenario('已发布但真实 Archive 写入未决时仍为 saved，保留 pin 并在修复后恢复同 Task', () => withHost(async (f) => {
  const input = await imported(f, 'archive-pending', { rowCount: 1, row: () => flowRow({ direction: '错误' }) });
  const originalSettle = f.service.settleManifestArtifacts.bind(f.service);
  let exportTask;
  let blockedSettles = 0;
  f.service.settleManifestArtifacts = async (args) => {
    if (args.batchContext.taskRunId === exportTask) {
      blockedSettles += 1;
      return { ok: false, durable: false, code: 'TEST_ARCHIVE_IO' };
    }
    return originalSettle(args);
  };
  const auto = createBizOpAutoErrorReportService({ getStorageRoot: () => f.storageRoot, now: fixedNow,
    module: { ...f.module, runExport(args) {
      return f.module.runExport({ ...args, afterPublish({ taskRunId }) { exportTask = taskRunId; } });
    } } });
  let automatic;
  try {
    automatic = await saved(f, input, auto);
    assert.ok(blockedSettles > 0);
    assert.equal(automatic.report.pendingArchiveHandoff, true);
    assert.equal(automatic.result.cleanupPending, true);
    assert.equal(f.module.catalog.task(exportTask).status, 'running');
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM biz_op_v327_read_pins WHERE task_run_id=?').get(exportTask).n, 1);
    assert.equal(f.module.publication.record(exportTask).cleanup_completed, 0);
  } finally { f.service.settleManifestArtifacts = originalSettle; }
  const hashBefore = digest(automatic.filePath);
  const recovered = await f.module.recovery.run();
  assert.equal(recovered.ready, true, JSON.stringify(recovered));
  assert.equal(digest(automatic.filePath), hashBefore);
  assert.equal(f.module.catalog.task(exportTask).status, 'succeeded');
  assert.equal(f.module.publication.record(exportTask).cleanup_completed, 1);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM biz_op_v327_read_pins').get().n, 0);
  assert.equal(f.runtime.resourceGovernor.snapshot().activeLeaseCount, 0);
}));

for (const phase of ['between-tasks', 'after-publish']) {
  scenario(`共享 registry 退出等待 ${phase}：完整 IPC 请求收尾后才 idle，已发布报告保持 saved`, () => withHost(async (f) => {
    const filePath = path.join(f.root, `quit-${phase}.xlsx`);
    await writeXlsx(filePath, { kind: 'OP', rowCount: 1, row: () => opRow({ end: '999' }) });
    // 与生产装配一致：外层 IPC 请求和两个真实 FilePlan Task 使用同一个 registry。
    const registry = f.lifecycle.businessOperationRegistry;
    const entered = barrier();
    const hold = barrier();
    let recoveryCalls = 0;
    let exportCalls = 0;
    const module = { ...f.module,
      // Host 关闭自动升级，只隔离 mode；缓存仍面对真实 admission 的恢复门禁。
      assertBusinessEnabled() {
        if (!f.module.admission.snapshot().recoveryReady) {
          throw Object.assign(new Error('需要恢复'), { code: 'BIZOP_RECOVERY_REQUIRED' });
        }
      },
      recovery: { async run() {
        const call = ++recoveryCalls;
        const result = await f.module.recovery.run();
        if (phase === 'between-tasks' && call === 1) { entered.resolve(); await hold.promise; }
        return result;
      } },
      runExport(args) {
        exportCalls += 1;
        return f.module.runExport({ ...args, afterPublish: phase === 'after-publish'
          ? async () => { entered.resolve(); await hold.promise; } : undefined });
      }
    };
    const handlers = new Map();
    const sender = Object.assign(new EventEmitter(), { id: 100, mainFrame: {} });
    const event = { sender, senderFrame: sender.mainFrame };
    registerBizOpV327Handlers({ ipcMain: { handle(key, handler) { handlers.set(key, handler); } },
      getModule: () => module, businessOperationRegistry: registry, getTaskLifecycle: () => f.lifecycle,
      getRuntime: () => f.runtime, getStorageRoot: () => f.storageRoot, getWindow: () => ({ webContents: sender }),
      dialog: { async showOpenDialog() { return { canceled: false, filePaths: [filePath] }; } } });
    const call = (suffix, value) => handlers.get(`bizOpReconV327:${suffix}`)(event, value);
    const selected = await call('files:pick');
    assert.equal(selected.status, 'ok', JSON.stringify(selected));
    const pending = call('import', { requestId: `quit-${phase}`, selectionRef: selected.selectionRef });
    let transition;
    try {
      await Promise.race([entered.promise, pending.then(() => { throw new Error('任务提前结束，未到达退出注入点'); })]);
      assert.equal(registry.listActive().length, phase === 'between-tasks' ? 1 : 2);
      transition = registry.beginShutdownTransition('integration-quit');
      assert.equal(transition.acquired, true);
      let idle = false;
      const idlePromise = registry.waitForIdle().then(() => { idle = true; });
      await Promise.resolve();
      assert.equal(idle, false, '退出等待不能越过尚在收尾的原 IPC 请求');
      hold.resolve();
      const result = await pending;
      await idlePromise;
      assert.equal(registry.listActive().length, 0);
      assert.equal(result.status, 'error');
      assert.equal(result.code, 'BIZOP_IMPORT_REJECTED');
      assert.equal(result.errorReport?.status, phase === 'between-tasks' ? 'failed' : 'saved', JSON.stringify(result));
      assert.equal(result.cleanupPending, false);
      assert.equal(exportCalls, 1);
      const exportTasks = f.db.prepare("SELECT COUNT(*) AS n FROM archive_task_runs WHERE task_key GLOB 'bizOpReconV327:export:*'").get().n;
      assert.equal(exportTasks, phase === 'between-tasks' ? 0 : 1, '退出闸门关闭后不启动新的报告 Task');
      if (phase === 'after-publish') {
        const target = path.join(f.storageRoot, result.errorReport.relativePath);
        assert.equal(f.module.catalog.task(result.errorReport.taskRunId).status, 'succeeded');
        assert.equal(digest(target), f.module.publication.fact(result.errorReport.taskRunId).outcome.files[0].sha256);
      }
      assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM biz_op_v327_read_pins').get().n, 0);
      assert.equal(f.runtime.resourceGovernor.snapshot().activeLeaseCount, 0);
    } finally {
      hold.resolve();
      await pending;
      if (transition?.acquired) registry.releaseTransition(transition.token);
    }
  }));
}

async function run() {
  console.log('==== 业务 OP 错误报告自动保存集成验证 ====');
  const failures = [];
  for (const entry of cases) {
    try { await entry.run(); console.log(`PASS ${entry.name}`); }
    catch (error) { failures.push({ name: entry.name, error }); console.error(`FAIL ${entry.name}: ${error.stack || error}`); }
  }
  console.log(`\n==== ${cases.length - failures.length}/${cases.length} PASS ====`);
  if (failures.length) {
    console.error('FAILURES');
    for (const failure of failures) console.error(`  - ${failure.name}: ${failure.error.message}`);
    process.exitCode = 1;
  }
}

run().catch((error) => { console.error('FAILURES\n业务 OP 自动错误报告集成异常：', error); process.exitCode = 1; });
