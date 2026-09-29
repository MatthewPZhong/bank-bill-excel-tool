// BizOP 查询边界集成回归：真实临时 SQLite、归档、payload、XLSX 和 worker。
// 覆盖导入→计算→七类导出、完整冻结 JSON/错误与 11086a3c 基线等价、删除保护与确认，
// 以及来源 iterator 提前关闭、4096 条、49152/65536 字节的精确边界。
// 冻结协调器仅是测试 oracle；按原文件位置解析未变更依赖，不启用生产双读。
// 所有 fixture 自建并清理，不访问用户库；用法：node scripts/integration/biz-op-query-boundary.js
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { createHash } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const XLSX = require('xlsx');
const { createExportHost, request } = require('../../tests/helpers/biz-op-v327-export');
const { seed, compute } = require('../../tests/helpers/biz-op-v327-compute');
const { writeXlsx, flowRow } = require('../../tests/helpers/biz-op-v327-xlsx');
const { createBizOpCatalog } = require('../../src/main-process/biz-op-v327/catalog');
const { createBizOpPayloadStore } = require('../../src/main-process/biz-op-v327/payload-store');
const { createBizOpAdmission } = require('../../src/main-process/biz-op-v327/admission');
const { createBizOpCatalogQueries } = require('../../src/main-process/biz-op-v327/catalog-queries');
const { collectInputs } = require('../../src/main-process/biz-op-v327/compute-inputs');
const { freezeExportSource } = require('../../src/main-process/biz-op-v327/export-inputs');
const { createBizOpDeletePreview, normalizeSelection } = require('../../src/main-process/biz-op-v327/delete-preview');
const { CELL_CONTRACT_VERSION, RULE_VERSION } = require('../../src/main-process/biz-op-v327/import-adapter');
const { hash } = require('../../src/main-process/biz-op-v327/contracts');
const { fsyncDirectory } = require('../../src/main-process/background-execution/durable-file');

function baseline(name) {
  const filename = path.resolve(__dirname, '../../src/main-process/biz-op-v327', name);
  const oracle = new Module(filename, module);
  oracle.filename = filename;
  oracle.paths = Module._nodeModulePaths(path.dirname(filename));
  oracle._compile(fs.readFileSync(path.resolve(__dirname,
    '../../tests/fixtures/biz-op-query-boundary/11086a3c', name), 'utf8'), filename);
  return oracle.exports;
}
const oldCompute = baseline('compute-inputs.js');
const oldExport = baseline('export-inputs.js');
const oldDelete = baseline('delete-preview.js');
const cases = [];
const scenario = (name, run) => cases.push({ name, run, requiresDurability: false });
const durableScenario = (name, run) => cases.push({ name, run, requiresDurability: true });
// 与 durable-directory-tests 相同，探测宿主真实能力，不模拟持久化成功。
const directoryDurabilityCapability = fsyncDirectory(os.tmpdir());
const bytes = (value) => Buffer.byteLength(JSON.stringify(value));
const errorValue = (error) => ({ name: error.name, message: error.message, ...error });
async function outcome(work) {
  try { return { value: await work() }; } catch (error) { return { error: errorValue(error) }; }
}
async function equivalent(current, previous, code) {
  const actual = await outcome(current); const expected = await outcome(previous);
  assert.deepEqual(actual, expected, '比较全部 JSON 字段、顺序与错误内容');
  assert.equal(JSON.stringify(actual), JSON.stringify(expected), '完整 JSON 序列化结果及键、数组顺序相同');
  if (code) assert.equal(actual.error?.code, code);
  else assert.equal(actual.error, undefined, JSON.stringify(actual.error));
  return actual.value;
}
async function withHost(work) {
  const cleanup = [];
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'bizop-query-host-'));
  const root = path.join(temporary, 'user-data'); const outputRoot = path.join(temporary, 'outputs');
  try {
    fs.mkdirSync(root); fs.mkdirSync(outputRoot);
    await work(await createExportHost({ after(fn) { cleanup.push(fn); } }, { root, outputRoot, keep: true }));
  }
  finally {
    const errors = [];
    for (const fn of cleanup) { try { await fn(); } catch (error) { errors.push(error); } }
    // helper 若在注册关闭回调之前失败，仍尝试回收本脚本拥有的目录；开放句柄阻塞清理会明确报错。
    try { fs.rmSync(temporary, { recursive: true, force: true }); } catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError(errors, '集成夹具资源清理失败');
  }
}
async function withCatalog(work) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bizop-query-boundary-'));
  const db = new DatabaseSync(path.join(root, 'catalog.sqlite'));
  db.exec('PRAGMA foreign_keys=ON');
  try {
    const catalog = createBizOpCatalog(db, { assertCommitReady() { assert.fail('只读边界夹具不得提交业务'); } });
    const admission = createBizOpAdmission();
    await admission.exclusive(() => admission.markRecovered(), { recovery: true });
    const payloadStore = createBizOpPayloadStore({ userDataDir: root }); payloadStore.initialize();
    const previews = createBizOpDeletePreview({ catalog, admission });
    const previous = oldDelete.createBizOpDeletePreview({ catalog, admission });
    await work({ root, db, catalog, admission, payloadStore, previews, previous });
  } finally { db.close(); fs.rmSync(root, { recursive: true, force: true }); }
}
async function rollback(db, work) {
  db.exec('SAVEPOINT query_boundary_fixture');
  try { return await work(); }
  finally { db.exec('ROLLBACK TO query_boundary_fixture'); db.exec('RELEASE query_boundary_fixture'); }
}
function insertDataset(f, { id, kind = 'OP', date = '2026-09-01', version = 1, rows = 0, manifest }) {
  f.db.prepare(`INSERT INTO biz_op_v327_datasets(dataset_id,kind,data_date,public_version,state,
    input_fingerprint,source_manifest_digest,payload_manifest_rel_path,payload_manifest_digest,row_count,producer_task_id,activated_at)
    VALUES (?,?,?,?,'ACTIVE',?,?,?,?,?,'fixture-task','2026-09-20T00:00:00.000Z')`)
    .run(id, kind, date, version, 'a'.repeat(64), 'b'.repeat(64), manifest?.relativePath || null, manifest?.digest || null, rows);
}
function computeArgs(f, extra = {}) {
  return { catalog: f.module?.catalog || f.catalog, payloadStore: f.module?.payloadStore || f.payloadStore,
    startDate: '2026-09-01', endDate: '2026-09-03', ...extra };
}
function exportArgs(f, outputKind, objectId) {
  return { catalog: f.module.catalog, payloadStore: f.module.payloadStore,
    getArchiveService: () => f.service, outputKind, objectId };
}
function compareExport(f, kind, id, code) {
  const args = exportArgs(f, kind, id);
  return equivalent(() => freezeExportSource(args), () => oldExport.freezeExportSource(args), code);
}

durableScenario('真实导入、计算与六类导出的完整快照和删除闭包等价，文件可完整读回', () => withHost(async (f) => {
  const imported = await seed(f); assert.equal(imported.status, 'ok');
  const args = computeArgs(f);
  const frozen = await f.module.admission.exclusive(() => equivalent(() => collectInputs(args), () => oldCompute.collectInputs(args)));
  assert.equal(frozen.documents.length, 4);
  assert.equal(frozen.inputs.length, 4);
  assert.equal(frozen.inputFingerprint, oldCompute.fingerprintOf(frozen));
  const result = await compute(f); assert.equal(result.status, 'ok', JSON.stringify(result));
  const datasets = f.db.prepare('SELECT * FROM biz_op_v327_datasets ORDER BY kind,data_date').all();
  const op = datasets.find((row) => row.kind === 'OP'); const flow = datasets.find((row) => row.kind === 'FLOW');
  for (const [kind, id] of [['OP_RAW', op.dataset_id], ['OP_CHECK', op.dataset_id], ['FLOW_RAW', flow.dataset_id],
    ['FLOW_CHECK', flow.dataset_id], ['RESULT_FULL', result.runId], ['RESULT_DIFF', result.runId]]) {
    const source = await compareExport(f, kind, id);
    assert.equal(source.objectId, id);
    const exported = await request(f, kind, id); assert.equal(exported.status, 'ok', JSON.stringify(exported));
    const file = path.join(f.outputRoot, `${kind.toLowerCase().replace('_', '-')}.xlsx`);
    const book = XLSX.readFile(file); assert.ok(book.SheetNames.length > 0);
    for (const name of book.SheetNames) assert.ok(XLSX.utils.sheet_to_json(book.Sheets[name], { header: 1 }).length > 0);
  }
  const previous = oldDelete.createBizOpDeletePreview({ catalog: f.module.catalog, admission: f.module.admission });
  const selection = { datasetIds: datasets.map((row) => row.dataset_id).reverse(), runIds: [result.runId] };
  const closure = await equivalent(() => f.module.previews.collect(selection), () => previous.collect(selection));
  assert.equal(closure.datasets.length, 4); assert.equal(closure.runs.length, 1);
  const preview = f.module.previews.create(selection);
  assert.deepEqual(f.module.previews.get(preview.previewId).closure, closure);
  assert.equal(f.module.previews.get(preview.previewId).row.closure_digest, hash(closure));
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM biz_op_v327_read_pins').get().n, 0);
  assert.equal(f.runtime.resourceGovernor.snapshot().activeLeaseCount, 0);
}));

durableScenario('真实异常导入后 READY 诊断完整导出等价，成功导入的空诊断走原维护回收', () => withHost(async (f) => {
  const imported = await seed(f);
  const empty = f.db.prepare('SELECT * FROM biz_op_v327_diagnostic_reports WHERE task_run_id=?').get(imported.receipt.taskRunId);
  assert.ok(empty); assert.equal(empty.sample_count, 0); assert.equal(empty.state, 'RETIRED');
  const queued = f.db.prepare("SELECT * FROM biz_op_v327_reclaim_queue WHERE payload_kind='DIAGNOSTIC' AND object_id=?").get(empty.report_ref);
  assert.ok(queued); assert.equal(queued.state, 'PENDING');
  const maintenance = f.module.catalog.task(queued.owner_task_run_id);
  assert.equal(maintenance.taskKey, 'bizOpReconV327:maintenance:reclaim');
  assert.notEqual(maintenance.taskRunId, imported.receipt.taskRunId);
  const diagnosticDirectory = f.module.payloadStore.resolve(`diagnostics/${empty.report_ref}`);
  assert.ok(fs.existsSync(diagnosticDirectory));
  assert.equal((await f.module.recovery.run()).ready, true);
  assert.equal(f.db.prepare('SELECT state FROM biz_op_v327_reclaim_queue WHERE reclaim_id=?').get(queued.reclaim_id).state, 'DONE');
  assert.equal(f.module.catalog.task(queued.owner_task_run_id).status, 'succeeded');
  assert.equal(f.module.catalog.queries.readDiagnosticByRef(empty.report_ref).state, 'DELETED');
  assert.equal(fs.existsSync(diagnosticDirectory), false);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM biz_op_v327_diagnostic_reports WHERE state='READY' AND sample_count=0").get().n, 0);
  const file = path.join(f.root, 'invalid-flow.xlsx');
  await writeXlsx(file, { rowCount: 3, row: () => flowRow({ direction: '错误方向' }) });
  const rejected = await f.run([file]); assert.equal(rejected.code, 'BIZOP_IMPORT_REJECTED');
  assert.equal((await f.module.recovery.run()).ready, true);
  const source = await compareExport(f, 'ERRORS', rejected.reportRef);
  assert.equal(source.metadata.sampleCount, 3);
  assert.equal(source.metadata.scanComplete, true);
  assert.equal((await request(f, 'ERRORS', rejected.reportRef)).status, 'ok');
  const book = XLSX.readFile(path.join(f.outputRoot, 'errors.xlsx'));
  assert.equal(XLSX.utils.sheet_to_json(book.Sheets['导入错误报告']).length, 3);
  const diagnostic = f.module.catalog.queries.readDiagnosticByRef(rejected.reportRef);
  const manifest = f.module.payloadStore.readDocument(source.manifestRelativePath, source.manifestDigest).value;
  const dispatches = f.module.catalog.queries.readDispatchesForPlan(diagnostic.task_run_id, manifest.catalog.producerPlanDigest);
  assert.deepEqual(dispatches, f.db.prepare('SELECT * FROM biz_op_v327_dispatches WHERE task_run_id=? AND plan_digest=?')
    .all(diagnostic.task_run_id, manifest.catalog.producerPlanDigest));
  assert.equal(dispatches.length, 1);
  assert.deepEqual(diagnostic, f.db.prepare('SELECT * FROM biz_op_v327_diagnostic_reports WHERE report_ref=?').get(rejected.reportRef));
}));

durableScenario('缺失、状态、hold、hash、行数、manifest 与 RESULT 端点错误完整等价', () => withHost(async (f) => {
  await seed(f); const result = await compute(f); assert.equal(result.status, 'ok');
  const dataset = f.db.prepare("SELECT * FROM biz_op_v327_datasets WHERE kind='OP' ORDER BY data_date LIMIT 1").get();
  const source = f.db.prepare('SELECT * FROM biz_op_v327_dataset_sources WHERE dataset_id=?').get(dataset.dataset_id);
  const args = computeArgs(f);
  const negatives = [
    ['BIZOP_RUN_INPUT_MISSING', () => f.db.prepare('DELETE FROM biz_op_v327_input_heads').run()],
    ['BIZOP_RUN_INPUT_MISSING', () => f.db.prepare("UPDATE biz_op_v327_datasets SET state='RETIRED' WHERE dataset_id=?").run(dataset.dataset_id)],
    ['BIZOP_RUN_ORIGINAL_UNAVAILABLE', () => f.db.prepare("UPDATE archive_artifacts SET status='failed' WHERE id=?").run(source.artifact_id)],
    ['BIZOP_RUN_ORIGINAL_UNAVAILABLE', () => f.db.prepare('UPDATE biz_op_v327_dataset_sources SET source_sha256=? WHERE dataset_id=?').run('0'.repeat(64), dataset.dataset_id)],
    ['BIZOP_RUN_ORIGINAL_UNPROTECTED', () => f.db.prepare("DELETE FROM archive_artifact_holds WHERE owner_type='v327-input' AND owner_id=?").run(dataset.dataset_id)],
    ['BIZOP_RUN_SOURCE_COUNT_MISMATCH', () => f.db.prepare('UPDATE biz_op_v327_datasets SET row_count=row_count+1 WHERE dataset_id=?').run(dataset.dataset_id)],
    ['BIZOP_MANIFEST_DIGEST_MISMATCH', () => f.db.prepare('UPDATE biz_op_v327_datasets SET payload_manifest_digest=? WHERE dataset_id=?').run('0'.repeat(64), dataset.dataset_id)],
    ['BIZOP_RUN_INPUT_CONTRACT_MISMATCH', () => f.db.prepare('UPDATE biz_op_v327_datasets SET source_manifest_digest=? WHERE dataset_id=?').run('0'.repeat(64), dataset.dataset_id)]
  ];
  for (const [code, mutate] of negatives) await rollback(f.db, async () => {
    mutate(); await equivalent(() => collectInputs(args), () => oldCompute.collectInputs(args), code);
  });
  await rollback(f.db, async () => {
    f.db.prepare("DELETE FROM biz_op_v327_run_inputs WHERE run_id=? AND role='END_OP'").run(result.runId);
    await compareExport(f, 'RESULT_FULL', result.runId, 'BIZOP_EXPORT_INPUT_METADATA_MISSING');
  });
  await rollback(f.db, async () => {
    f.db.prepare("UPDATE biz_op_v327_runs SET state='DELETED' WHERE run_id=?").run(result.runId);
    await compareExport(f, 'RESULT_FULL', result.runId, 'BIZOP_EXPORT_SOURCE_UNAVAILABLE');
  });
  const mismatchedVersion = { ...exportArgs(f, 'RESULT_FULL', result.runId), columnSchemaVersion: 1 };
  await equivalent(() => freezeExportSource(mismatchedVersion), () => oldExport.freezeExportSource(mismatchedVersion),
    'BIZOP_EXPORT_CONTRACT_MISMATCH');
  await rollback(f.db, async () => {
    f.db.prepare('UPDATE biz_op_v327_runs SET payload_manifest_rel_path=?,payload_manifest_digest=? WHERE run_id=?')
      .run(dataset.payload_manifest_rel_path, dataset.payload_manifest_digest, result.runId);
    await compareExport(f, 'RESULT_FULL', result.runId, 'BIZOP_EXPORT_OWNER_MISMATCH');
  });
  await compareExport(f, 'FLOW_CHECK', dataset.dataset_id, 'BIZOP_EXPORT_SOURCE_UNAVAILABLE');
  await rollback(f.db, async () => {
    f.db.prepare("DELETE FROM archive_artifact_holds WHERE owner_type='v327-input' AND owner_id=?").run(dataset.dataset_id);
    await compareExport(f, 'OP_RAW', dataset.dataset_id, 'BIZOP_EXPORT_ORIGINAL_UNPROTECTED');
  });
}));

durableScenario('RAW 真实目录副本按原规则修复，目录与 canonical Blob 均损坏时拒绝且错误等价', () => withHost(async (f) => {
  await seed(f);
  const datasetId = f.db.prepare("SELECT dataset_id FROM biz_op_v327_datasets WHERE kind='OP' ORDER BY data_date LIMIT 1").get().dataset_id;
  const before = await compareExport(f, 'OP_RAW', datasetId);
  assert.equal(before.originals.length, 1);
  const artifact = f.module.catalog.archive.getArtifact(before.originals[0].artifactId);
  const files = [...new Set([before.originals[0].filePath, path.join(f.root, 'archive', artifact.blob.relativePath)])]
    .map((filePath) => ({ filePath, data: fs.readFileSync(filePath), mode: fs.statSync(filePath).mode & 0o777 }));
  const replaceFixtureFile = (file, data) => {
    fs.mkdirSync(path.dirname(file.filePath), { recursive: true });
    if (fs.existsSync(file.filePath)) { fs.chmodSync(file.filePath, 0o600); fs.unlinkSync(file.filePath); }
    fs.writeFileSync(file.filePath, data); fs.chmodSync(file.filePath, file.mode);
  };
  const corruptAndFreeze = async (freeze, corruptCanonical) => {
    try {
      // 两个 oracle 均先恢复相同健康字节，再施加相同故障；替换目录副本不污染潜在 hardlink 的 Blob。
      for (const file of files) replaceFixtureFile(file, file.data);
      for (const file of corruptCanonical ? files : files.slice(0, 1)) {
        replaceFixtureFile(file, Buffer.concat([file.data, Buffer.from('changed')]));
        assert.notDeepEqual(fs.readFileSync(file.filePath), file.data);
      }
      return await rollback(f.db, async () => {
        const result = await freeze(exportArgs(f, 'OP_RAW', datasetId));
        if (!corruptCanonical) {
          assert.equal(result.originals[0].sha256, before.originals[0].sha256);
          assert.deepEqual(fs.readFileSync(result.originals[0].filePath), files[0].data, '真实目录副本必须恢复为完整原始字节');
          assert.deepEqual(fs.readFileSync(files[1].filePath), files[1].data, 'canonical Blob 保持原始字节');
        }
        return result;
      });
    } finally {
      for (const file of files) replaceFixtureFile(file, file.data);
    }
  };
  await equivalent(() => corruptAndFreeze(freezeExportSource, false), () => corruptAndFreeze(oldExport.freezeExportSource, false));
  await equivalent(() => corruptAndFreeze(freezeExportSource, true), () => corruptAndFreeze(oldExport.freezeExportSource, true),
    'BIZOP_EXPORT_ORIGINAL_CHANGED');
}));

durableScenario('锁、其他 owner 与任意状态共享 blob 改变完整删除闭包；确认过期、复用及 generation 继续生效', () => withHost(async (f) => {
  await seed(f); const computed = await compute(f); assert.equal(computed.status, 'ok');
  const datasetId = f.db.prepare("SELECT dataset_id FROM biz_op_v327_datasets WHERE kind='OP' ORDER BY data_date LIMIT 1").get().dataset_id;
  const artifactId = f.db.prepare('SELECT artifact_id FROM biz_op_v327_dataset_sources WHERE dataset_id=?').get(datasetId).artifact_id;
  const archive = f.module.catalog.archive; const artifact = archive.getArtifact(artifactId);
  const previous = oldDelete.createBizOpDeletePreview({ catalog: f.module.catalog, admission: f.module.admission });
  const selection = { datasetIds: [datasetId] };
  const original = f.module.previews.collect(selection);
  for (const status of ['pending', 'failed', 'ready']) await rollback(f.db, async () => {
    const preview = f.module.previews.create(selection);
    f.db.prepare(`INSERT INTO archive_artifacts(batch_id,artifact_key,direction,role,original_name,source_path,status,blob_id,created_at,updated_at)
      VALUES (?,'shared-fixture','input','input','shared.xlsx','fixture',?,?,?,?)`).run(artifact.batchId, status, artifact.blobId,
      f.module.catalog.now(), f.module.catalog.now());
    const closure = await equivalent(() => f.module.previews.collect(selection), () => previous.collect(selection));
    assert.equal(closure.references.sharedBlobOriginals, original.references.sharedBlobOriginals + 1);
    await equivalent(() => f.module.previews.validate(preview.previewId, 'KEEP_RESULTS'),
      () => previous.validate(preview.previewId, 'KEEP_RESULTS'), 'BIZOP_DELETE_PREVIEW_STALE');
  });
  for (const mutate of [() => archive.setLocked(artifact.batchId, true),
    () => archive.addArtifactHold(artifactId, { ownerModule: 'other-module', ownerType: 'fixture', ownerId: 'other-owner', reason: '集成保护' }),
    () => f.db.prepare('UPDATE biz_op_v327_control SET generation=generation+1 WHERE singleton=1').run()]) {
    await rollback(f.db, async () => {
      const preview = f.module.previews.create(selection); mutate();
      await equivalent(() => f.module.previews.collect(selection), () => previous.collect(selection));
      await equivalent(() => f.module.previews.validate(preview.previewId, 'KEEP_RESULTS'),
        () => previous.validate(preview.previewId, 'KEEP_RESULTS'), 'BIZOP_DELETE_PREVIEW_STALE');
    });
  }
  const expired = f.module.previews.create(selection);
  f.db.prepare('UPDATE biz_op_v327_delete_previews SET expires_at=? WHERE preview_id=?').run('2000-01-01T00:00:00.000Z', expired.previewId);
  await equivalent(() => f.module.previews.validate(expired.previewId, 'KEEP_RESULTS'),
    () => previous.validate(expired.previewId, 'KEEP_RESULTS'), 'BIZOP_DELETE_PREVIEW_EXPIRED');
  const preview = f.module.previews.create(selection); const taskId = computed.receipt.taskRunId;
  assert.throws(() => f.module.previews.bind(preview.previewId, 'KEEP_RESULTS', taskId), { code: 'BIZOP_EXCLUSIVE_ADMISSION_REQUIRED' });
  await f.module.admission.exclusive(() => {
    f.module.previews.bind(preview.previewId, 'KEEP_RESULTS', taskId);
    assert.throws(() => f.module.previews.bind(preview.previewId, 'KEEP_RESULTS', taskId), { code: 'BIZOP_DELETE_PREVIEW_USED' });
  });
  await equivalent(() => f.module.previews.validate(preview.previewId, 'KEEP_RESULTS'), () => previous.validate(preview.previewId, 'KEEP_RESULTS'));
  await equivalent(() => f.module.previews.validate(preview.previewId, 'DELETE_ASSOCIATED'),
    () => previous.validate(preview.previewId, 'DELETE_ASSOCIATED'), 'BIZOP_DELETE_MODE_CONFLICT');
  assert.ok(fs.existsSync(path.join(f.root, 'start.xlsx')));
}));

scenario('选择上限 4096（去重前）、空选择与非法引用维持同一错误', async () => {
  await equivalent(() => normalizeSelection({ datasetIds: Array(4096).fill('same') }),
    () => oldDelete.normalizeSelection({ datasetIds: Array(4096).fill('same') }));
  for (const selection of [{ datasetIds: Array(4097).fill('same') }, {}]) {
    await equivalent(() => normalizeSelection(selection), () => oldDelete.normalizeSelection(selection), 'BIZOP_DELETE_SELECTION_INVALID');
  }
  await equivalent(() => normalizeSelection({ datasetIds: ['../bad'] }),
    () => oldDelete.normalizeSelection({ datasetIds: ['../bad'] }), 'BIZOP_REFERENCE_INVALID');
});

scenario('删除 charge 字节 49152 通过、49153 拒绝，完整结果与基线一致', () => withCatalog(async (f) => {
  insertDataset(f, { id: 'byte-limit' });
  const selection = { datasetIds: ['byte-limit'] };
  const initial = f.previews.collect(selection); const baseBytes = bytes(initial.datasets[0]);
  const date = '2026-09-01' + 'x'.repeat(49152 - baseBytes);
  f.db.prepare('UPDATE biz_op_v327_datasets SET data_date=? WHERE dataset_id=?').run(date, 'byte-limit');
  const boundary = await equivalent(() => f.previews.collect(selection), () => f.previous.collect(selection));
  assert.equal(bytes(boundary.datasets[0]), 49152);
  f.db.prepare('UPDATE biz_op_v327_datasets SET data_date=? WHERE dataset_id=?').run(`${date}x`, 'byte-limit');
  await equivalent(() => f.previews.collect(selection), () => f.previous.collect(selection), 'BIZOP_DELETE_PREVIEW_LIMIT');
}));

scenario('删除闭包精确 65536 字节通过、65537 拒绝，预览响应和 64 个上限保留', () => withCatalog(async (f) => {
  const ids = Array.from({ length: 140 }, (_, index) => `d${String(index).padStart(3, '0')}${'x'.repeat(156)}`);
  ids.forEach((id, index) => insertDataset(f, { id, version: index + 1 }));
  const selection = { datasetIds: ids };
  const initial = f.previews.collect(selection); assert.ok(bytes(initial) < 65536);
  const date = '2026-09-01' + 'x'.repeat(65536 - bytes(initial));
  f.db.prepare('UPDATE biz_op_v327_datasets SET data_date=? WHERE dataset_id=?').run(date, ids[0]);
  const boundary = await equivalent(() => f.previews.collect(selection), () => f.previous.collect(selection));
  assert.equal(bytes(boundary), 65536);
  assert.ok(boundary.datasets.reduce((total, row) => total + bytes(row), 0) <= 49152);
  const preview = f.previews.create(selection); assert.ok(bytes(preview) <= 131072);
  assert.deepEqual(f.previews.get(preview.previewId).closure, boundary);
  f.db.prepare('UPDATE biz_op_v327_datasets SET data_date=? WHERE dataset_id=?').run(`${date}x`, ids[0]);
  await equivalent(() => f.previews.collect(selection), () => f.previous.collect(selection), 'CANONICAL_JSON_TOO_LARGE');
  f.db.prepare('UPDATE biz_op_v327_datasets SET data_date=? WHERE dataset_id=?').run('2026-09-01', ids[0]);
  for (let index = 1; index < 64; index += 1) f.previews.create({ datasetIds: [ids[0]] });
  await equivalent(() => f.previews.create({ datasetIds: [ids[0]] }),
    () => f.previous.create({ datasetIds: [ids[0]] }), 'BIZOP_DELETE_PREVIEW_BUSY');
}));

scenario('真实 SQLite 来源迭代恰好 4096 元数据通过；第 4097 条停止且关闭 iterator', () => withCatalog(async (f) => {
  const batch = f.catalog.archive.createBatch({ moduleId: 'biz-op-recon', moduleCode: 'BOP', localDate: '2026-09-20' }).batch;
  const sha256 = 'd'.repeat(64); const timestamp = f.catalog.now();
  const blobId = Number(f.db.prepare('INSERT INTO archive_blobs(sha256,size_bytes,relative_path,created_at,last_verified_at) VALUES (?,0,?,?,?)')
    .run(sha256, 'fixtures/original', timestamp, timestamp).lastInsertRowid);
  const definitions = [{ id: 'budget-start', kind: 'OP', date: '2026-09-01', count: 4091 },
    { id: 'budget-end', kind: 'OP', date: '2026-09-02', count: 1 }, { id: 'budget-flow', kind: 'FLOW', date: '2026-09-02', count: 1 }];
  for (const definition of definitions) {
    // 此场景只测查询读取：直接生成静态 fixture，不调用生产提交，也不伪造目录持久化成功。
    const content = Buffer.from(JSON.stringify({ objectId: definition.id,
      objectKind: 'DATASET', rowCount: definition.count, catalog: { sourceManifestDigest: 'b'.repeat(64),
        cellContractVersion: CELL_CONTRACT_VERSION, ruleVersion: RULE_VERSION } }));
    const relativePath = `inputs/${definition.id}/manifest.json`;
    const target = f.payloadStore.resolve(relativePath, { mustExist: false });
    fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, content);
    const manifest = { relativePath, digest: createHash('sha256').update(content).digest('hex') };
    insertDataset(f, { ...definition, rows: definition.count, manifest });
    f.db.prepare('INSERT INTO biz_op_v327_input_heads(kind,data_date,dataset_id,published_generation) VALUES (?,?,?,1)')
      .run(definition.kind, definition.date, definition.id);
  }
  const insertArtifact = f.db.prepare(`INSERT INTO archive_artifacts(batch_id,artifact_key,direction,role,original_name,source_path,status,blob_id,created_at,updated_at)
    VALUES (?,?,'input','input','fixture.xlsx','fixture','ready',?,?,?)`);
  const insertSource = f.db.prepare(`INSERT INTO biz_op_v327_dataset_sources(dataset_id,artifact_id,source_sha256,source_file_name,
    source_file_order,source_sheet_name,slice_date,normalized_bu,row_count) VALUES (?,?,?,'fixture.xlsx',?,'Sheet1',?,'Alpha',1)`);
  const insertHold = f.db.prepare(`INSERT INTO archive_artifact_holds(artifact_id,owner_module,owner_type,owner_id,reason,created_at)
    VALUES (?,'biz-op-recon','v327-input',?,'集成边界',?)`);
  let nextArtifact = 0;
  const add = (definition, order) => {
    const id = Number(insertArtifact.run(batch.id, `fixture-${++nextArtifact}`, blobId, timestamp, timestamp).lastInsertRowid);
    insertSource.run(definition.id, id, sha256, order, definition.date); insertHold.run(id, definition.id, timestamp);
  };
  f.catalog.transaction(() => definitions.forEach((definition) => {
    for (let index = 0; index < definition.count; index += 1) add(definition, index);
  }));
  const args = computeArgs(f, { endDate: '2026-09-02' });
  const frozen = await equivalent(() => collectInputs(args), () => oldCompute.collectInputs(args));
  assert.equal(frozen.documents.reduce((total, document) => total + document.sources.length, frozen.inputs.length), 4096);
  // 让第一份来源远超预算；消费第四千零九十四条时已失败，后续来源不能被预取成数组。
  f.catalog.transaction(() => { for (let index = 4091; index < 4110; index += 1) add(definitions[0], index); });
  let consumed = 0; let closed = 0;
  const queryDb = { prepare(sql) {
    const statement = f.db.prepare(sql);
    return new Proxy(statement, { get(target, key) {
      if (key === 'all' && sql.includes('biz_op_v327_dataset_sources')) return () => assert.fail('来源不允许先 all 再预算检查');
      if (key === 'iterate' && sql.includes('biz_op_v327_dataset_sources')) return (...params) => {
        const iterator = target.iterate(...params);
        return { [Symbol.iterator]() { return this; }, next() { const value = iterator.next(); if (!value.done) consumed += 1; return value; },
          return() { closed += 1; return iterator.return(); } };
      };
      const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
    } });
  } };
  const guarded = { ...f.catalog, queries: createBizOpCatalogQueries({ db: queryDb }) };
  await equivalent(() => collectInputs({ ...args, catalog: guarded }), () => oldCompute.collectInputs(args), 'BIZOP_RUN_INPUT_BUDGET');
  assert.equal(consumed, 4094); assert.equal(closed, 1);
  f.db.prepare('UPDATE biz_op_v327_datasets SET row_count=row_count WHERE dataset_id=?').run(definitions[0].id);
}));

async function run() {
  let passed = 0; let skipped = 0; const failures = [];
  console.log(`宿主真实目录 fsync 能力：${directoryDurabilityCapability.capability}${directoryDurabilityCapability.errorCode ? ` (${directoryDurabilityCapability.errorCode})` : ''}`);
  for (const item of cases) {
    if (item.requiresDurability && directoryDurabilityCapability.capability !== 'supported') {
      skipped += 1;
      console.log(`SKIP ${item.name}: 宿主目录 fsync 不支持 (${directoryDurabilityCapability.errorCode || 'unknown'})；生产仍拒绝提交，成功路径需具备真实目录屏障的宿主验证`);
      continue;
    }
    try { await item.run(); passed += 1; console.log(`PASS ${item.name}`); }
    catch (error) { failures.push({ name: item.name, error }); console.error(`FAIL ${item.name}: ${error.stack}`); }
  }
  console.log(`\n==== ${passed}/${cases.length - skipped} PASS ====`);
  console.log(`SKIP ${skipped}/${cases.length}；跳过项不计入 PASS，未执行的平台成功路径不属于本轮验证结果。`);
  if (failures.length) {
    console.error('FAILURES'); failures.forEach(({ name, error }) => console.error(`  - ${name}: ${error.message}`));
    process.exitCode = 1;
  }
}
run().catch((error) => { console.error('FATAL', error); process.exitCode = 1; });
