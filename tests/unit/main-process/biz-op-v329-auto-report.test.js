'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { createBizOpAutoErrorReportService } = require('../../../src/main-process/biz-op-v327/auto-error-report');
const { createBizOpImportCoordinator } = require('../../../src/main-process/biz-op-v327/import-main');
const { createBizOpExportCoordinator } = require('../../../src/main-process/biz-op-v327/export-main');

function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bizop-auto-report-unit-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const identity = { taskRunId: 'import-task', reportRef: 'report-one' };
  const businessResult = { status: 'error', code: 'BIZOP_IMPORT_REJECTED', message: '原业务错误',
    summary: { rowErrorCount: 1, fileErrorCount: 0, collectedSamples: 1, scanComplete: true, errorCountExact: true } };
  const intent = { phase: 'xlsx-import-v1', reportRef: identity.reportRef };
  const row = { report_ref: identity.reportRef, task_run_id: identity.taskRunId, manifest_digest: 'manifest-digest',
    sealed_manifest_rel_path: 'diagnostics/report-one/manifest.json', sample_count: 1, sample_bytes: 50,
    scan_complete: 1, error_count_exact: 1, producer_job_id: 'job-one', producer_session_id: 'session-one', state: 'READY' };
  const manifest = { schemaVersion: 1, objectKind: 'DIAGNOSTIC', objectId: identity.reportRef, taskRunId: identity.taskRunId,
    intentDigest: 'intent-digest', rowCount: 1, parts: [{ rowCount: 1, byteSize: 50 }],
    catalog: { collectedSamples: 1, sampleBytes: 50, scanComplete: true, errorCountExact: true,
      errorSamplesTruncated: false, producerPlanDigest: 'plan-digest' } };
  const f = { root, identity, businessResult, intent, row, manifest, calls: [], ready: true, closed: true,
    carrier: { job_id: 'job-one', session_id: 'session-one' }, publicationRow: null, fact: null };
  const resources = { cpuSlots: 2, workerThreadSlots: 2, utilityProcessSlots: 0, ioHeavySlots: 2, memoryBytes: 2147483648 };
  f.runtime = { resourceGovernor: {
    snapshot: () => ({ accepting: true, budgets: resources, available: resources }),
    async acquirePhaseLease() { f.calls.push('verify-lease'); return { release() { f.calls.push('verify-release'); } }; }
  } };
  f.module = {
    admission: { snapshot: () => ({ recoveryReady: f.ready }), read(work) {
      f.calls.push('read'); if (!f.ready) throw Object.assign(new Error('恢复未就绪'), { code: 'BIZOP_RECOVERY_REQUIRED' });
      return work();
    } },
    protection: { closed: () => f.closed },
    catalog: { operation: () => ({ action: 'IMPORT', intent_rel_path: 'intent.json', intent_digest: 'intent-digest' }),
      db: { prepare(sql) { return {
        get(id) { assert.equal(id, identity.reportRef); return f.row?.state === 'READY' ? f.row : null; },
        all(taskId, planDigest) { assert.match(sql, /biz_op_v327_dispatches/); assert.equal(taskId, identity.taskRunId);
          assert.equal(planDigest, 'plan-digest'); return f.carrier ? [f.carrier] : []; }
      }; } } },
    payloadStore: { readDocument(relative, digest) {
      if (relative === 'intent.json') { assert.equal(digest, 'intent-digest'); return { value: intent }; }
      assert.equal(relative, row.sealed_manifest_rel_path);
      if (digest !== 'manifest-digest') throw new Error('封存摘要不同');
      return { value: manifest };
    } },
    publication: { record: () => f.publicationRow, fact: () => f.fact,
      binding: () => ({ batchContext: { operationKey: 'export-operation' } }) },
    recovery: { async run() { f.calls.push('recovery'); if (f.onRecovery) return f.onRecovery(); return { ready: f.ready }; } },
    async runExport(request) {
      f.calls.push('export'); f.request = request;
      if (f.exportWork) return f.exportWork(request);
      return f.publish(request);
    }
  };
  // 纯服务替身只提供已验证发布的控制证据，不用替身内容证明 XLSX 格式正确。
  f.publish = (request, { throwAfter = false, archiveSettled = 1 } = {}) => {
    request.onTaskIdentified({ taskRunId: 'export-task' });
    const filePath = request.filePlan.outputs[0].filePath;
    const bytes = Buffer.from('unit-test-publication-evidence');
    fs.writeFileSync(filePath, bytes, { flag: 'wx' });
    f.fact = { state: 'COMMITTED', outcome: { files: [{ filePath, byteSize: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex') }] } };
    f.publicationRow = { state: 'COMMITTED', archive_settled: archiveSettled };
    if (throwAfter) throw new Error('发布后收尾异常，含私有路径 /private/business');
    return { status: 'ok', taskRunId: 'export-task', filePath };
  };
  f.service = createBizOpAutoErrorReportService({ module: f.module, getStorageRoot: () => root,
    now: () => new Date(2026, 8, 11, 4, 5, 6), ...options });
  f.save = (extra = {}) => f.service.save({ identity, businessResult, taskLifecycle: {}, runtime: f.runtime, ...extra });
  return f;
}

test('Main 冻结本地时间、创建标准 ERRORS FilePlan，只返回相对路径且保持原业务失败', async (t) => {
  const f = fixture(t, { uuid: () => 'unique-one' }); const before = structuredClone(f.businessResult);
  const identities = []; const result = await f.save({ onTaskIdentified: (value) => identities.push(value) });
  assert.deepEqual(result, { errorReport: { status: 'saved', fileName: '业务OP导入错误报告-20260911-040506-unique-one.xlsx',
    relativePath: 'error-reports/2026-09-11/业务OP导入错误报告-20260911-040506-unique-one.xlsx',
    taskRunId: 'export-task', pendingArchiveHandoff: false }, cleanupPending: false });
  assert.equal(fs.existsSync(path.join(f.root, result.errorReport.relativePath)), true);
  assert.deepEqual(f.businessResult, before); assert.equal(JSON.stringify(result).includes(f.root), false);
  assert.equal(f.request.outputKind, 'ERRORS'); assert.equal(f.request.objectId, f.identity.reportRef);
  assert.equal(f.request.filePlan.allocation, 'eager'); assert.deepEqual(f.request.filePlan.inputs, []);
  assert.equal(f.request.filePlan.outputs[0].sourceOperation, 'bizOpReconV327:export:errors');
  assert.deepEqual(f.request.filePlan.outputs[0].targetSnapshot, { exists: false });
  assert.deepEqual(f.calls, ['read', 'export', 'recovery', 'verify-lease', 'verify-release']);
  assert.deepEqual(identities, [{ taskRunId: 'export-task' }]);
});

test('同秒独立保存目标唯一；意外 UUID 冲突不覆盖旧报告', async (t) => {
  const f = fixture(t); const first = await f.save(); const second = await f.save();
  assert.notEqual(first.errorReport.relativePath, second.errorReport.relativePath);
  const collided = fixture(t, { uuid: () => 'same-id' });
  const original = await collided.save(); const bytes = fs.readFileSync(path.join(collided.root, original.errorReport.relativePath));
  const rejected = await collided.save();
  assert.equal(rejected.errorReport.status, 'failed'); assert.equal(collided.calls.filter((value) => value === 'export').length, 1);
  assert.match(rejected.errorReport.message, /被占用.*检查.*重新导入/u);
  assert.deepEqual(fs.readFileSync(path.join(collided.root, original.errorReport.relativePath)), bytes);
});

test('非法根目录、父目录被文件占用和目录权限失败不会启动导出或泄露系统错误', async (t) => {
  const badRoot = fixture(t, { getStorageRoot: () => 'relative-root' });
  const badRootResult = await badRoot.save();
  assert.equal(badRootResult.errorReport.status, 'failed'); assert.equal(badRoot.calls.includes('export'), false);
  assert.match(badRootResult.errorReport.message, /不可用.*检查/u);
  const occupied = fixture(t); fs.writeFileSync(path.join(occupied.root, 'error-reports'), '用户文件');
  const occupiedResult = await occupied.save();
  assert.equal(occupiedResult.errorReport.status, 'failed'); assert.equal(occupied.calls.includes('export'), false);
  assert.match(occupiedResult.errorReport.message, /被占用.*检查/u);
  const denied = fixture(t);
  t.mock.method(fs.promises, 'mkdir', async () => { throw Object.assign(new Error('/private/business permission denied'), { code: 'EACCES' }); });
  const result = await denied.save(); assert.equal(result.errorReport.status, 'failed');
  assert.match(result.errorReport.message, /没有写入权限.*检查文档目录权限/u);
  assert.equal(JSON.stringify(result).includes('/private/business'), false); assert.equal(denied.calls.includes('export'), false);
});

for (const change of ['missing', 'not-ready', 'owner', 'intent', 'manifest-path', 'manifest-version', 'manifest-digest', 'manifest-owner', 'sample-summary', 'truncated-flag', 'producer', 'open-carrier']) {
  test(`仅本任务封存诊断可导出：${change} 被拒绝`, async (t) => {
    const f = fixture(t);
    if (change === 'missing') f.row = null;
    if (change === 'not-ready') f.row.state = 'RETIRED';
    if (change === 'owner') f.row.task_run_id = 'other-task';
    if (change === 'intent') f.intent.reportRef = 'other-report';
    if (change === 'manifest-path') f.row.sealed_manifest_rel_path = 'diagnostics/other-report/manifest.json';
    if (change === 'manifest-version') f.manifest.schemaVersion = 2;
    if (change === 'manifest-digest') f.row.manifest_digest = 'changed-digest';
    if (change === 'manifest-owner') f.manifest.taskRunId = 'other-task';
    if (change === 'sample-summary') f.manifest.catalog.collectedSamples = 10;
    if (change === 'truncated-flag') f.manifest.catalog.errorSamplesTruncated = 'false';
    if (change === 'producer') f.carrier.job_id = 'other-job';
    if (change === 'open-carrier') f.closed = false;
    const result = await f.save(); assert.equal(result.errorReport.status, 'unavailable');
    assert.equal(f.calls.includes('export'), false); assert.deepEqual(fs.readdirSync(f.root), []);
  });
}

test('成功空诊断、取消与无真实身份不造空报告；失败零样本但扫描不完整仍导出说明', async (t) => {
  const f = fixture(t);
  const success = { status: 'ok', summary: { rowErrorCount: 0, fileErrorCount: 0, collectedSamples: 0,
    scanComplete: true, errorCountExact: true } };
  assert.deepEqual(await f.save({ businessResult: success }), {});
  assert.deepEqual(await f.save({ businessResult: { status: 'cancelled' } }), {});
  assert.deepEqual(await f.save({ signal: AbortSignal.abort() }), {});
  assert.equal((await f.save({ identity: undefined })).errorReport.status, 'unavailable');
  assert.deepEqual(f.calls, []);
  Object.assign(f.row, { sample_count: 0, sample_bytes: 0, scan_complete: 0, error_count_exact: 0 });
  Object.assign(f.manifest, { rowCount: 0, parts: [{ rowCount: 0, byteSize: 0 }] });
  Object.assign(f.manifest.catalog, { collectedSamples: 0, sampleBytes: 0, scanComplete: false, errorCountExact: false });
  const result = await f.save({ businessResult: { status: 'error', summary: { fileErrorCount: 1, collectedSamples: 0 } } });
  assert.equal(result.errorReport.status, 'saved'); assert.equal(f.calls.filter((value) => value === 'export').length, 1);
});

for (const status of ['error', 'ok']) test(`完整、精确、未截断的内部空诊断不因 ${status} 业务状态而导出`, async (t) => {
  const f = fixture(t);
  Object.assign(f.row, { sample_count: 0, sample_bytes: 0 });
  Object.assign(f.manifest, { rowCount: 0, parts: [{ rowCount: 0, byteSize: 0 }] });
  Object.assign(f.manifest.catalog, { collectedSamples: 0, sampleBytes: 0 });
  const businessResult = { status, code: 'BIZOP_OPERATION_FAILED', message: 'Main 在 worker 后处理失败' };
  const before = structuredClone(businessResult);
  const result = await f.save({ businessResult });
  if (status === 'error') assert.equal(result.errorReport.status, 'unavailable');
  else assert.deepEqual(result, {});
  assert.deepEqual(businessResult, before);
  assert.deepEqual(f.calls, ['read']); assert.deepEqual(fs.readdirSync(f.root), []);
});

for (const kind of ['truncated', 'incomplete', 'file-error']) test(`零样本仍保留真实诊断说明：${kind}`, async (t) => {
  const f = fixture(t);
  Object.assign(f.row, { sample_count: 0, sample_bytes: 0 });
  Object.assign(f.manifest, { rowCount: 0, parts: [{ rowCount: 0, byteSize: 0 }] });
  Object.assign(f.manifest.catalog, { collectedSamples: 0, sampleBytes: 0 });
  const businessResult = { status: 'error' };
  if (kind === 'truncated') f.manifest.catalog.errorSamplesTruncated = true;
  if (kind === 'incomplete') {
    Object.assign(f.row, { scan_complete: 0, error_count_exact: 0 });
    Object.assign(f.manifest.catalog, { scanComplete: false, errorCountExact: false });
  }
  if (kind === 'file-error') businessResult.summary = { rowErrorCount: 0, fileErrorCount: 1 };
  const result = await f.save({ businessResult });
  assert.equal(result.errorReport.status, 'saved');
  assert.equal(f.calls.filter((value) => value === 'export').length, 1);
});

for (const [code, expected] of [
  ['EACCES', /没有写入权限.*检查文档目录权限/u],
  ['EPERM', /没有写入权限.*检查文档目录权限/u],
  ['ENOSPC', /磁盘空间不足.*释放空间/u],
  ['ENOTDIR', /被占用.*检查/u],
  ['EEXIST', /被占用.*检查/u]
]) test(`创建目录失败按白名单反馈 ${code}，不暴露系统错误或创建 Task`, async (t) => {
  const f = fixture(t); const before = structuredClone(f.businessResult);
  t.mock.method(fs.promises, 'mkdir', async () => {
    throw Object.assign(new Error('/private/business 原始系统错误'), { code });
  });
  const result = await f.save();
  assert.equal(result.errorReport.status, 'failed'); assert.match(result.errorReport.message, expected);
  assert.equal(result.errorReport.taskRunId, undefined);
  assert.equal(JSON.stringify(result).includes('/private/business'), false);
  assert.deepEqual(f.businessResult, before); assert.equal(f.calls.includes('export'), false);
});

for (const [code, expected] of [
  ['ENOSPC', /磁盘空间不足.*释放空间/u],
  ['ARCHIVE_TARGET_CHANGED', /已变化.*检查/u],
  ['TOOLBOX_PUBLICATION_DESTINATION_EXISTS', /被占用.*检查/u],
  ['BIZOP_RESOURCE_BUDGET_INSUFFICIENT', /超过本次应用预算.*释放内存.*重新启动/u],
  ['BIZOP_RESOURCE_WAIT_TIMEOUT', /超过 5 秒.*等待其他任务结束/u],
  ['UNKNOWN_PRIVATE_ERROR', /检查目录权限、可用磁盘空间或任务记录/u]
]) test(`导出明确未发布时保留 ${code} 的受限原因`, async (t) => {
  const f = fixture(t); const before = structuredClone(f.businessResult);
  f.exportWork = (request) => {
    request.onTaskIdentified({ taskRunId: 'export-task' });
    f.publicationRow = { state: 'NOT_STARTED' };
    throw Object.assign(new Error('/private/business 原始系统错误'), { code });
  };
  const result = await f.save();
  assert.equal(result.errorReport.status, 'failed'); assert.match(result.errorReport.message, expected);
  assert.equal(result.errorReport.taskRunId, 'export-task');
  assert.equal(JSON.stringify(result).includes('/private/business'), false);
  assert.equal('relativePath' in result.errorReport, false); assert.deepEqual(f.businessResult, before);
});

test('导出返回 error DTO 时同样保留受限原因；发布事实优先于错误码', async (t) => {
  const failed = fixture(t);
  failed.exportWork = () => ({ status: 'error', code: 'BIZOP_RESOURCE_BUDGET_INSUFFICIENT', message: '/private/business' });
  assert.match((await failed.save()).errorReport.message, /超过本次应用预算/u);
  const committed = fixture(t);
  committed.exportWork = (request) => {
    committed.publish(request);
    throw Object.assign(new Error('/private/business'), { code: 'ENOSPC' });
  };
  assert.equal((await committed.save()).errorReport.status, 'saved');
  const pending = fixture(t);
  pending.exportWork = (request) => {
    request.onTaskIdentified({ taskRunId: 'export-task' });
    pending.publicationRow = { state: 'CLOSED_UNKNOWN' };
    throw Object.assign(new Error('/private/business'), { code: 'ENOSPC' });
  };
  const result = await pending.save();
  assert.equal(result.errorReport.status, 'pending'); assert.doesNotMatch(result.errorReport.message, /磁盘空间不足/u);
});

for (const readySource of ['explicit', 'admission']) test(`首次恢复 ${readySource} 未就绪时不读取或导出`, async (t) => {
  const f = fixture(t); if (readySource === 'admission') f.ready = false;
  const result = await f.save(readySource === 'explicit' ? { recoveryReady: false } : {});
  assert.equal(result.errorReport.code, 'BIZOP_AUTO_REPORT_RECOVERY_REQUIRED'); assert.equal(result.cleanupPending, true);
  assert.deepEqual(f.calls, []);
});

for (const phase of ['before-task', 'before-publication', 'not-committed']) test(`发布前失败 ${phase} 保留业务失败且不假报 pending`, async (t) => {
  const f = fixture(t); const before = structuredClone(f.businessResult);
  f.exportWork = (request) => {
    if (phase !== 'before-task') request.onTaskIdentified({ taskRunId: 'export-task' });
    if (phase === 'before-publication') f.publicationRow = { state: 'NOT_STARTED' };
    if (phase === 'not-committed') { f.publicationRow = { state: 'NOT_COMMITTED' }; f.fact = { state: 'NOT_COMMITTED' }; }
    throw new Error('私有业务路径 /private/business');
  };
  const result = await f.save(); assert.equal(result.errorReport.status, 'failed'); assert.deepEqual(f.businessResult, before);
  assert.equal(JSON.stringify(result).includes('/private/business'), false); assert.equal(f.calls.filter((v) => v === 'export').length, 1);
  assert.equal(f.calls.includes('recovery'), true);
});

test('发布后异常且 Archive 未决仍报告 saved，恢复异常只保留 cleanupPending', async (t) => {
  const f = fixture(t);
  f.exportWork = (request) => f.publish(request, { throwAfter: true, archiveSettled: 0 });
  f.onRecovery = () => { throw new Error('恢复暂时失败'); };
  const result = await f.save(); assert.equal(result.errorReport.status, 'saved');
  assert.equal(result.errorReport.pendingArchiveHandoff, true); assert.equal(result.cleanupPending, true);
  assert.equal(f.calls.filter((value) => value === 'export').length, 1);
});

test('发布待核验返回 pending；收尾恢复取得 COMMITTED 后以更明确事实返回 saved', async (t) => {
  const unknown = fixture(t);
  unknown.exportWork = (request) => { request.onTaskIdentified({ taskRunId: 'export-task' });
    unknown.publicationRow = { state: 'CLOSED_UNKNOWN' }; throw new Error('发布结果未返回'); };
  unknown.onRecovery = () => ({ ready: false });
  const result = await unknown.save(); assert.equal(result.errorReport.status, 'pending');
  assert.equal(result.errorReport.taskRunId, 'export-task'); assert.equal(result.cleanupPending, true);
  assert.equal('relativePath' in result.errorReport, false);
  const recovered = fixture(t);
  recovered.exportWork = (request) => { request.onTaskIdentified({ taskRunId: 'export-task' });
    recovered.publicationRow = { state: 'CLOSED_UNKNOWN' }; throw new Error('发布结果未返回'); };
  recovered.onRecovery = () => { recovered.publish(recovered.request); return { ready: true }; };
  assert.equal((await recovered.save()).errorReport.status, 'saved');
});

for (const tamper of ['deleted', 'changed', 'symlink', 'wrong-target']) test(`提交证明不能代替目标完整性验证：${tamper}`, async (t) => {
  const f = fixture(t);
  f.onRecovery = () => {
    const target = f.fact.outcome.files[0].filePath;
    if (tamper === 'deleted') fs.unlinkSync(target);
    if (tamper === 'changed') fs.appendFileSync(target, 'tampered');
    if (tamper === 'symlink') { const moved = `${target}.moved`; fs.renameSync(target, moved); fs.symlinkSync(moved, target); }
    if (tamper === 'wrong-target') f.fact.outcome.files[0].filePath = path.join(f.root, 'other.xlsx');
    return { ready: true };
  };
  const result = await f.save(); assert.equal(result.errorReport.status, 'pending');
  assert.equal('relativePath' in result.errorReport, false);
  assert.equal(f.calls.filter((value) => value === 'export').length, 1);
});

test('导入在原件收尾失败前交付真实 Task 与 report 身份，异常不制造替代任务', async () => {
  const identities = []; const order = []; let intent;
  const coordinator = createBizOpImportCoordinator({ admission: {
    exclusive: (work) => work(), requireRecovery() { order.push('require-recovery'); }
  }, prepareOperation(value) { intent = value.intent; order.push('intent'); return { intent_digest: 'digest' }; } });
  await assert.rejects(coordinator.runImport({ filePlan: { inputs: [] }, runtime: {},
    taskLifecycle: { runFileTask: ({ execute }) => execute({ taskRunId: 'real-import-task', operationKey: 'operation' },
      { settleArtifacts() { order.push('settle'); throw new Error('original failure'); } }) },
    onTaskIdentified(value) { identities.push(value); order.push('identified'); }
  }), /original failure/);
  assert.deepEqual(identities, [{ taskRunId: 'real-import-task', reportRef: intent.reportRef }]);
  assert.equal(Object.isFrozen(identities[0]), true);
  assert.deepEqual(order, ['intent', 'identified', 'settle', 'require-recovery']);
});

test('导出 beforeStart 来源冻结失败前交付真实 Task 身份，无需 runtime.start', async () => {
  const identities = []; const order = [];
  const coordinator = createBizOpExportCoordinator({ admission: { readTask: (_id, work) => work({ bindTask(id) {
    assert.equal(id, 'real-export-task'); order.push('bind'); } }) },
  catalog: { db: { prepare() { throw new Error('source unavailable'); } } } });
  await assert.rejects(coordinator.runExport({ outputKind: 'ERRORS', objectId: 'report-one',
    filePlan: { inputs: [], outputs: [{}] }, runtime: { start() { assert.fail('来源未验证不可启动 worker'); } },
    taskLifecycle: { runFileTask: ({ beforeStart }) => beforeStart({ taskRunId: 'real-export-task' }, {}) },
    onTaskIdentified(value) { identities.push(value); order.push('identified'); }
  }), /source unavailable/);
  assert.deepEqual(identities, [{ taskRunId: 'real-export-task' }]); assert.equal(Object.isFrozen(identities[0]), true);
  assert.deepEqual(order, ['bind', 'identified']);
});
