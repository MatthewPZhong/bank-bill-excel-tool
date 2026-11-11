'use strict';

// v3.2.17 VCC 通道明细预检补录：预检列出可补录行 → 校验修改 → 导入应用 → 记录 → 导出血缘。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const XLSX = require('xlsx');
const ExcelJS = require('exceljs');
const { DatabaseSync } = require('node:sqlite');
const { ensureVccFinancialOpTablesSupport } = require('../../../../src/backend/vcc-financial-op-db/migrations');
const { createArchiveRepository } = require('../../../../src/backend/database/archive-repository');
const repository = require('../../../../src/backend/vcc-financial-op-db/repository');
const { SOURCE_TYPES, getSourceDefinition } = require('../../../../src/backend/vcc-financial-op/definitions');
const {
  inspectWorkbookImportPlan,
  resolveImportPlan,
  collectChannelCorrections
} = require('../../../../src/backend/vcc-financial-op/workbook-import-plan');
const { buildMemberFiles, handoffMetadata } = require('../../../../src/backend/vcc-financial-op/import-handoff');
const { importFiles } = require('../../../../src/backend/vcc-financial-op/import-service');
const { writeDatasetWorkbook } = require('../../../../src/main-process/vcc-financial-op-dataset-writer');

const MONTH = '2026-06';

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vcc-channel-correction-'));
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec("CREATE TABLE app_settings (setting_key TEXT PRIMARY KEY, setting_value TEXT, updated_at TEXT DEFAULT (datetime('now')))");
  ensureVccFinancialOpTablesSupport(db, { autoUpgradeEmptyV1: true });
  const archive = createArchiveRepository(db);
  archive.ensureSchema();
  t.after(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { db, archive, dir };
}

function channelRow(overrides = {}) {
  return {
    渠道订单号: 'CH-1', 账单日期: '2026-06-10', 通道名称: 'XPAY', 借贷方向: 'in',
    billdate: '2026-06-20', 结算币种: 'USD', 实际到账金额: '10', ...overrides
  };
}

function writeChannel(dir, rows, name = 'channel.xlsx') {
  const headers = getSourceDefinition(SOURCE_TYPES.CHANNEL).headers;
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([
    headers,
    ...rows.map((row) => headers.map((header) => row[header] ?? ''))
  ]), '通道');
  const filePath = path.join(dir, name);
  XLSX.writeFile(book, filePath);
  return filePath;
}

async function inspect(filePath) {
  return inspectWorkbookImportPlan([filePath], { targetMonth: MONTH });
}

function resolve(plan, channelCorrections) {
  const subjectBySourceId = Object.fromEntries(plan.sources
    .filter((source) => source.requiresSubject)
    .map((source) => [source.sourceId, '甲']));
  return resolveImportPlan(plan, {
    planId: plan.planId,
    targetMonth: MONTH,
    subjectBySourceId,
    excludedSheetIds: [],
    channelCorrections
  });
}

async function runImport(f, plan, channelCorrections, taskRunId) {
  const resolved = resolve(plan, channelCorrections);
  const files = buildMemberFiles(resolved);
  const batch = f.archive.createBatch({
    moduleId: 'vcc-financial-op', moduleCode: 'VCCFINOP', moduleName: 'VCC',
    operationKey: taskRunId, taskKey: 'vccFinancialOp:import:apply', taskRunId, parentRunId: taskRunId,
    localDate: '2026-09-18', retentionUntil: '2026-11-17'
  }).batch;
  f.db.prepare('UPDATE archive_batches SET task_run_id = ?, task_key = ? WHERE id = ?')
    .run(taskRunId, 'vccFinancialOp:import:apply', batch.id);
  for (const [index, file] of files.entries()) {
    const artifact = f.archive.addArtifact(batch.id, {
      artifactKey: `input:${index}`, direction: 'input', role: 'input',
      sourceOperation: 'vccFinancialOp:import:apply', originalName: file.fileName, sourcePath: file.filePath,
      metadata: handoffMetadata(file, taskRunId)
    });
    f.archive.startArtifactAttempt(artifact.id);
    f.archive.completeArtifact(artifact.id, {
      sha256: file.sha256, sizeBytes: file.sizeBytes, relativePath: `blobs/${file.sha256}`,
      fingerprint: { sizeBytes: file.sizeBytes, mtimeMs: 1, ctimeMs: 1, ino: '1' }
    });
    file.archiveArtifactId = artifact.id;
  }
  return importFiles({
    db: f.db,
    targetMonth: MONTH,
    batchId: taskRunId,
    files,
    archiveHandoffFiles: { version: 2, taskRunId, files },
    channelCorrections: collectChannelCorrections(resolved),
    provenance: { appVersion: '3.2.17', buildSha: 'correction-test' }
  });
}

function channelRecord(result) {
  return result.records.find((record) => record.sourceType === SOURCE_TYPES.CHANNEL);
}

test('预检列出业务键与账期有效、仅计算字段为空或不合规的通道行', async (t) => {
  const f = fixture(t);
  const filePath = writeChannel(f.dir, [
    channelRow(),
    channelRow({ 渠道订单号: 'CH-2', 实际到账金额: '' }),
    channelRow({ 渠道订单号: 'CH-3', 借贷方向: '' }),
    channelRow({ 渠道订单号: '', 实际到账金额: '' }),
    channelRow({ 渠道订单号: 'CH-5', 账单日期: '2026-07-01', 实际到账金额: '' })
  ]);
  const plan = await inspect(filePath);
  const { total, truncated, candidates } = plan.sources[0].channelCorrectionCandidates;
  assert.equal(total, 2);
  assert.equal(truncated, false);
  assert.deepEqual(candidates.map((candidate) => [candidate.sourceRow, candidate.idempotencyKey]), [[3, 'CH-2'], [4, 'CH-3']]);
  assert.equal(candidates[0].amountGroup, 'settlement');
  assert.deepEqual(candidates[0].requiredFields, ['借贷方向', '通道名称', 'billdate', '结算币种', '实际到账金额']);
  assert.deepEqual(candidates[0].problems.map((problem) => problem.field), ['实际到账金额']);
  assert.deepEqual(candidates[1].problems.map((problem) => problem.field), ['借贷方向']);
});

test('补录校验：只能改预检行的可改字段，改后须满足计算规则', async (t) => {
  const f = fixture(t);
  const plan = await inspect(writeChannel(f.dir, [channelRow({ 实际到账金额: '' })]));
  const sourceId = plan.sources[0].sourceId;
  assert.throws(
    () => resolve(plan, [{ sourceId, sourceRow: 2, fields: { 渠道订单号: 'X' } }]),
    { code: 'vcc-import-plan-invalid' }
  );
  assert.throws(
    () => resolve(plan, [{ sourceId, sourceRow: 9, fields: { 实际到账金额: '1' } }]),
    { code: 'vcc-import-plan-invalid' }
  );
  assert.throws(
    () => resolve(plan, [{ sourceId, sourceRow: 2, fields: { 实际到账金额: '1.234' } }]),
    (error) => error.code === 'vcc-channel-correction-invalid' && /第 2 行/.test(error.detailLines[0])
  );
  assert.throws(
    () => resolveImportPlan(plan, {
      planId: plan.planId, targetMonth: '2026-07', subjectBySourceId: {}, excludedSheetIds: []
    }),
    { code: 'vcc-import-plan-stale' },
    '提交账期与预检账期不一致时计划失效'
  );
  const resolved = resolve(plan, [{ sourceId, sourceRow: 2, fields: { 实际到账金额: ' 20.50 ' } }]);
  assert.deepEqual(collectChannelCorrections(resolved).map((correction) => ({
    sheetIndex: correction.sheetIndex,
    sourceRow: correction.sourceRow,
    original: correction.original,
    corrected: correction.corrected
  })), [{ sheetIndex: 0, sourceRow: 2, original: { 实际到账金额: '' }, corrected: { 实际到账金额: '20.50' } }]);
});

test('导入按补录后的值计算并记录原值/新值；重导按幂等规则；校验原表导出套用补录后血缘通过', async (t) => {
  const f = fixture(t);
  const filePath = writeChannel(f.dir, [
    channelRow({ 渠道订单号: 'CH-1', 实际到账金额: '10' }),
    channelRow({ 渠道订单号: 'CH-2', 实际到账金额: '' }),
    channelRow({ 渠道订单号: 'CH-3', 借贷方向: '' })
  ]);
  const plan = await inspect(filePath);
  const sourceId = plan.sources[0].sourceId;
  const first = await runImport(f, plan, [{ sourceId, sourceRow: 3, fields: { 实际到账金额: '20.50' } }], 'correction-1');
  const record = channelRecord(first);
  assert.equal(record.insertedCount, 2);
  assert.equal(record.formatErrorCount, 1, '未补录的行仍按异常过滤');
  assert.equal(record.correctedRowCount, 1);
  assert.equal(f.db.prepare(`
    SELECT signed_amount FROM vcc_fin_op_effective_rows WHERE idempotency_key = 'CH-2'
  `).get().signed_amount, '20.5');
  const corrections = f.db.prepare(`
    SELECT field_name, original_value, corrected_value, source_row, created_app_version, created_build_sha
    FROM vcc_fin_op_channel_corrections
  `).all().map((row) => ({ ...row }));
  assert.deepEqual(corrections, [{
    field_name: '实际到账金额', original_value: '', corrected_value: '20.50', source_row: 3,
    created_app_version: '3.2.17', created_build_sha: 'correction-test'
  }]);
  const auditRows = [...repository.iterateExportableImportAnomalies(f.db, record.recordId)];
  const correctionAudit = auditRows.find((row) => row.category === 'channel_correction');
  assert.equal(correctionAudit.description, '原值 （空） → 新值 20.50');
  assert.equal(correctionAudit.idempotency_key, 'CH-2');
  assert.equal(repository.countExportableImportAnomalies(f.db, record.recordId), auditRows.length);

  // 校验原表导出：从存档原件读回后套用补录记录，血缘校验通过且显示补录后的值。
  const source = f.db.prepare('SELECT id, source_sha256, source_size_bytes FROM vcc_fin_op_import_sources').get();
  const outputPath = path.join(f.dir, 'raw-export.xlsx');
  const exported = await writeDatasetWorkbook({
    db: f.db,
    targetMonth: MONTH,
    sourceType: SOURCE_TYPES.CHANNEL,
    targetKind: 'raw',
    outputPath,
    archiveSources: [{
      sourceId: Number(source.id), filePath, sha256: source.source_sha256, sizeBytes: Number(source.source_size_bytes)
    }]
  });
  assert.equal(exported.dataCount, 2);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(outputPath);
  const sheet = workbook.worksheets[0];
  const headers = sheet.getRow(1).values.slice(1);
  const amountColumn = headers.indexOf('实际到账金额') + 1;
  const keyColumn = headers.indexOf('渠道订单号') + 1;
  const exportedAmounts = {};
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber > 1) exportedAmounts[row.getCell(keyColumn).value] = String(row.getCell(amountColumn).value);
  });
  assert.equal(exportedAmounts['CH-2'], '20.50');

  // 同样补录重导 → 幂等跳过；不补录重导 → 仍过滤；改法不同 → 幂等冲突。
  const same = channelRecord(await runImport(f, await inspect(filePath), [], 'correction-skip-noop'));
  assert.equal(same.skippedCount, 1, '未补录时 CH-1 幂等跳过');
  assert.equal(same.formatErrorCount, 2, '未补录时 CH-2、CH-3 按异常过滤');
  const replanSame = await inspect(filePath);
  const replay = channelRecord(await runImport(f, replanSame,
    [{ sourceId: replanSame.sources[0].sourceId, sourceRow: 3, fields: { 实际到账金额: '20.50' } }], 'correction-2'));
  assert.equal(replay.skippedCount, 2, '同样补录重导 CH-1、CH-2 均幂等跳过');
  assert.equal(replay.conflictCount, 0);
  const replanDiff = await inspect(filePath);
  const conflict = channelRecord(await runImport(f, replanDiff,
    [{ sourceId: replanDiff.sources[0].sourceId, sourceRow: 3, fields: { 实际到账金额: '30' } }], 'correction-3'));
  assert.equal(conflict.conflictCount, 1, '改法不同为幂等冲突');
  assert.equal(f.db.prepare(`
    SELECT signed_amount FROM vcc_fin_op_effective_rows WHERE idempotency_key = 'CH-2'
  `).get().signed_amount, '20.5', '冲突时保留既有有效行');
});
