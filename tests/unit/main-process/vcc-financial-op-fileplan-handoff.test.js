'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const XLSX = require('xlsx');
const { DatabaseSync } = require('node:sqlite');
const { ensureVccFinancialOpTablesSupport } = require('../../../src/backend/vcc-financial-op-db/migrations');
const { createArchiveService } = require('../../../src/main-process/archive-center/archive-service');
const { normalizeFilePlanV1, artifactManifestFromFilePlan } = require('../../../src/main-process/archive-center/file-plan');
const { inspectWorkbookImportPlan, resolveImportPlan } = require('../../../src/backend/vcc-financial-op/workbook-import-plan');
const { SOURCE_TYPES: T, getSourceDefinition } = require('../../../src/backend/vcc-financial-op/definitions');
const { buildVccImportArchiveHandoffFiles, persistVccImportHandoffV2,
  reconcileVccImportArchiveLineage } = require('../../../src/main-process/vcc-financial-op-archive-lineage');
const { importFiles } = require('../../../src/backend/vcc-financial-op/import-service');

async function fixture(t, fileCount = 1) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vcc-fileplan-handoff-'));
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys=ON');
  db.exec("CREATE TABLE app_settings (setting_key TEXT PRIMARY KEY,setting_value TEXT,updated_at TEXT DEFAULT (datetime('now')))");
  ensureVccFinancialOpTablesSupport(db, { autoUpgradeEmptyV1: true });
  const service = createArchiveService({ database: db, rootDir: path.join(dir, 'archive') });
  t.after(async () => { await service.pauseBackgroundMaterialization(); db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  assert.equal((await service.initialize({ deferStartupRecovery: true, startBackgroundMaterialization: false })).ok, true);
  const paths = [];
  for (let index = 0; index < fileCount; index += 1) {
    const workbook = XLSX.utils.book_new();
    for (const [type, name] of [[T.RECHARGE, '充值'], [T.FEE_FX, '费用']]) {
      const headers = getSourceDefinition(type).headers;
      const row = { 订单号: `${index}-${name}`, BillDate: '2026-06-09', 业务部门: 'VCC', 对手部门: 'OPS',
        业务子类型: type === T.RECHARGE ? '充值' : '手续费', 出入方向: type === T.RECHARGE ? 'in' : 'out',
        公司主体: '甲', 我方币种: 'USD', 我方到账金额: '10.25' };
      XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([headers, headers.map((key) => row[key] ?? '')]), name);
    }
    const file = path.join(dir, `${index}.xlsx`); XLSX.writeFile(workbook, file); paths.push(file);
  }
  const inspected = await inspectWorkbookImportPlan(paths);
  const files = resolveImportPlan(inspected, { planId: inspected.planId, subjectBySourceId: {}, excludedSheetIds: [] });
  const filePlan = normalizeFilePlanV1({ version: 1, allocation: 'eager', inputs: files.map((file) => ({
    filePath: file.filePath, role: 'input', sourceOperation: 'vccFinancialOp:import:apply',
    expectedSha256: file.sha256, expectedSizeBytes: file.sizeBytes
  })), outputs: [] });
  const begun = await service.beginTaskRun({ taskRunId: 'vcc-fileplan-task', taskKey: 'vccFinancialOp:import:apply',
    moduleId: 'vcc-financial-op', operationKey: 'vcc-fileplan-import', parentRunId: 'vcc-fileplan-parent' });
  assert.equal(begun.ok, true);
  const reserved = await service.reserveFileTaskBatch({ taskRun: begun.taskRun, manifest: artifactManifestFromFilePlan(filePlan),
    moduleCode: 'VCCFINOP', moduleName: 'VCC', metadata: {} });
  assert.equal(reserved.ok, true);
  const batchContext = { batchId: reserved.batch.id, ...Object.fromEntries([
    'batchNumber', 'taskRunId', 'taskKey', 'moduleId', 'parentRunId', 'operationKey'
  ].map((key) => [key, reserved.batch[key]])) };
  const handoff = await buildVccImportArchiveHandoffFiles({ files }, batchContext);
  const repo = service.repository;
  const entries = handoff.map((file, index) => ({ artifactKey: filePlan.inputs[index].artifactKey,
    sourceOperation: 'vccFinancialOp:import:apply', originalName: file.originalName, metadata: file.metadata }));
  const persist = () => persistVccImportHandoffV2(repo, batchContext, filePlan.inputs, handoff);
  return { db, service, repo, files, filePlan, batchContext, handoff, entries, persist };
}

test('真实 FilePlan 预分配 → VCC handoff → settle → 混合工作簿导入，身份元数据保留且有效来源阻止永久删除', async (t) => {
  const f = await fixture(t);
  const initial = f.repo.listArtifacts(f.batchContext.batchId).map((artifact) => artifact.metadata);
  assert.ok(initial[0].aliasKey && initial[0].sourceSnapshot && initial[0].expectedSha256);
  const stored = f.persist();
  for (const [index, artifact] of stored.entries()) {
    for (const [key, value] of Object.entries(initial[index])) assert.deepEqual(artifact.metadata[key], value);
    for (const [key, value] of Object.entries(f.handoff[index].metadata)) assert.deepEqual(artifact.metadata[key], value);
  }
  assert.deepEqual(f.persist(), stored, '同一完整成员清单重复持久化保持幂等');
  assert.equal((await f.service.startFileTask(f.batchContext.taskRunId, f.batchContext.batchId)).ok, true);
  const settled = await f.service.settleManifestArtifacts({ batchContext: f.batchContext,
    files: f.filePlan.inputs.map((input, index) => ({ artifactKey: input.artifactKey,
      expectedSha256: f.handoff[index].expectedSha256, expectedSizeBytes: f.handoff[index].expectedSizeBytes })) });
  assert.equal(settled.ok, true, JSON.stringify(settled)); assert.equal(settled.durable, true);
  const frozenFiles = [];
  for (const [index, file] of f.files.entries()) {
    const artifactId = settled.results[index].artifact.id;
    const ready = await f.service.resolveVerifiedArtifact(artifactId);
    assert.equal(ready.ok, true);
    frozenFiles.push({ ...file, filePath: ready.filePath, archiveArtifactId: artifactId,
      members: f.handoff[index].metadata.vccSourceMembers });
  }
  let observedHolds = false;
  const imported = await importFiles({ db: f.db, targetMonth: '2026-06', batchId: f.batchContext.taskRunId,
    files: frozenFiles, archiveHandoffFiles: { version: 2, taskRunId: f.batchContext.taskRunId, files: frozenFiles },
    onProgress() { observedHolds = true; assert.equal(f.repo.listArtifactHolds(stored[0].id).length, 2); } });
  assert.ok(observedHolds); assert.equal(imported.physicalFileCount, 1); assert.equal(imported.businessSheetCount, 2);
  assert.deepEqual(imported.records.map((record) => [record.status, record.insertedCount]), [['success', 1], ['success', 1]]);
  assert.equal(reconcileVccImportArchiveLineage({ db: f.db, archiveRepository: f.repo }).failed, 0);
  assert.equal((await f.service.finishFileTask(f.batchContext.taskRunId, f.batchContext.batchId, { taskStatus: 'succeeded' })).ok, true);
  const deletion = await f.service.prepareDeleteBatch(f.batchContext.batchId);
  assert.equal(deletion.code, 'ARCHIVE_BATCH_BUSINESS_HELD');
  const after = f.repo.getArtifact(stored[0].id).metadata;
  for (const [key, value] of Object.entries(initial[0])) assert.deepEqual(after[key], value);
  assert.equal(f.persist()[0].metadata.vccMembersDigest, f.handoff[0].metadata.vccMembersDigest, 'settle 后的 expected evidence 不破坏 handoff 幂等性');
});

test('已冻结 VCC 身份、版本、成员和完整字段集不可改写；FilePlan 身份键不可由成员补丁覆盖', async (t) => {
  const f = await fixture(t); f.persist();
  const before = f.repo.listArtifacts(f.batchContext.batchId);
  const variants = {
    version: (metadata) => { metadata.vccImportHandoffVersion = 3; },
    task: (metadata) => { metadata.vccTaskRunId = 'other'; },
    physical: (metadata) => { metadata.vccPhysicalFileId = 'other'; },
    hash: (metadata) => { metadata.vccSourceSha256 = 'a'.repeat(64); },
    members: (metadata) => { metadata.vccSourceMembers[0].sheets[0].sheetName = 'other'; },
    missing: (metadata) => { delete metadata.vccMembersDigest; },
    alias: (metadata) => { metadata.aliasKey = 'other'; },
    snapshot: (metadata) => { metadata.sourceSnapshot = {}; },
    expected: (metadata) => { metadata.expectedSha256 = 'a'.repeat(64); },
    size: (metadata) => { metadata.expectedSizeBytes = 0; }
  };
  for (const [name, mutate] of Object.entries(variants)) await t.test(name, () => {
    const entry = structuredClone(f.entries[0]); mutate(entry.metadata);
    assert.throws(() => f.repo.persistInputArtifactMetadata(f.batchContext.batchId, f.batchContext.taskRunId, [entry]), /不能/);
    assert.deepEqual(f.repo.listArtifacts(f.batchContext.batchId), before);
  });
});

test('已持久但不完整的 VCC 成员清单不能在重放时被补齐', async (t) => {
  const f = await fixture(t);
  const artifact = f.repo.listArtifacts(f.batchContext.batchId)[0];
  f.db.prepare('UPDATE archive_artifacts SET metadata_json=? WHERE id=?')
    .run(JSON.stringify({ ...artifact.metadata, vccImportHandoffVersion: 2 }), artifact.id);
  const before = f.repo.getArtifact(artifact.id);
  assert.throws(f.persist, { code: 'vcc-import-handoff-mismatch' });
  assert.deepEqual(f.repo.getArtifact(artifact.id), before);
});

test('多文件后一个成员冲突时回滚前一个新增清单，原 FilePlan metadata 不变', async (t) => {
  const f = await fixture(t, 2);
  const second = f.repo.listArtifacts(f.batchContext.batchId)[1];
  f.db.prepare('UPDATE archive_artifacts SET metadata_json=? WHERE id=?')
    .run(JSON.stringify({ ...second.metadata, ...f.handoff[1].metadata, vccPhysicalFileId: 'frozen-other' }), second.id);
  const before = f.repo.listArtifacts(f.batchContext.batchId);
  assert.throws(f.persist, { code: 'vcc-import-handoff-mismatch' });
  assert.deepEqual(f.repo.listArtifacts(f.batchContext.batchId), before);
});
