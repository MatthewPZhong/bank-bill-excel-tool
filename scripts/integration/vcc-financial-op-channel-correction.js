// VCC财务OP校验「通道明细预检补录」集成测试
//   覆盖：
//   1. 预检按正式导入同一读取与映射链路列出可补录的通道行（为空或不合规，业务键与账期有效）
//   2. 补录校验拒绝越权字段、非法值与账期不一致；合规补录随导入写入并逐字段留痕
//   3. 导入按补录后的值计算发生额；未补录的行仍按异常过滤
//   4. 校验原表导出从存档原件重建并套用补录记录，血缘校验通过且显示补录后的值
//   5. 导入记录【导出明细】含“人工补录”分类；同样补录重导幂等跳过、改法不同为幂等冲突
//
// 用户可见输出契约变化（导入结果、校验原表导出、导出明细），须端到端核对真实 XLSX 读写。
//
// 用法：node scripts/integration/vcc-financial-op-channel-correction.js

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const XLSX = require('xlsx');
const ExcelJS = require('exceljs');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.resolve(__dirname, '../..');
const { ensureVccFinancialOpTablesSupport } = require(path.join(ROOT, 'src/backend/vcc-financial-op-db/migrations'));
const { createArchiveRepository } = require(path.join(ROOT, 'src/backend/database/archive-repository'));
const { SOURCE_TYPES, getSourceDefinition } = require(path.join(ROOT, 'src/backend/vcc-financial-op/definitions'));
const {
  inspectWorkbookImportPlan, resolveImportPlan, collectChannelCorrections
} = require(path.join(ROOT, 'src/backend/vcc-financial-op/workbook-import-plan'));
const { buildMemberFiles, handoffMetadata } = require(path.join(ROOT, 'src/backend/vcc-financial-op/import-handoff'));
const { importFiles } = require(path.join(ROOT, 'src/backend/vcc-financial-op/import-service'));
const { writeDatasetWorkbook } = require(path.join(ROOT, 'src/main-process/vcc-financial-op-dataset-writer'));
const { writeImportAuditWorkbook } = require(path.join(ROOT, 'src/main-process/vcc-financial-op-audit-writer'));

const MONTH = '2026-06';
let passed = 0;
let failed = 0;
const failures = [];

function assertEq(actual, expected, label) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) passed += 1;
  else {
    failed += 1;
    failures.push({ label, actual, expected });
  }
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`);
}

async function assertRejects(promiseFactory, code, label) {
  try {
    await promiseFactory();
    assertEq('resolved', code, label);
  } catch (error) {
    assertEq(error && error.code, code, label);
  }
}

function writeChannelWorkbook(dir) {
  const headers = getSourceDefinition(SOURCE_TYPES.CHANNEL).headers;
  const row = (overrides) => {
    const values = {
      账单日期: '2026-06-10', 通道名称: 'XPAY', 借贷方向: 'in',
      billdate: '2026-06-20', 结算币种: 'USD', 实际到账金额: '10', ...overrides
    };
    return headers.map((header) => values[header] ?? '');
  };
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([
    headers,
    row({ 渠道订单号: 'CH-OK' }),
    row({ 渠道订单号: 'CH-AMOUNT', 实际到账金额: '' }),
    row({ 渠道订单号: 'CH-DIRECTION', 借贷方向: '' }),
    row({ 渠道订单号: 'CH-CITI', 通道名称: 'CITI', 交易币种: 'EUR', 交易金额: 'abc' })
  ]), '通道');
  const filePath = path.join(dir, '通道明细.xlsx');
  XLSX.writeFile(book, filePath);
  return filePath;
}

async function importWithCorrections(context, plan, corrections, taskRunId) {
  const { db, archive } = context;
  const subjectBySourceId = Object.fromEntries(plan.sources
    .filter((source) => source.requiresSubject).map((source) => [source.sourceId, '甲']));
  const resolved = resolveImportPlan(plan, {
    planId: plan.planId, targetMonth: MONTH, subjectBySourceId, excludedSheetIds: [], channelCorrections: corrections
  });
  const files = buildMemberFiles(resolved);
  const batch = archive.createBatch({
    moduleId: 'vcc-financial-op', moduleCode: 'VCCFINOP', moduleName: 'VCC',
    operationKey: taskRunId, taskKey: 'vccFinancialOp:import:apply', taskRunId, parentRunId: taskRunId,
    localDate: '2026-11-11', retentionUntil: '2027-01-10'
  }).batch;
  db.prepare('UPDATE archive_batches SET task_run_id = ?, task_key = ? WHERE id = ?')
    .run(taskRunId, 'vccFinancialOp:import:apply', batch.id);
  for (const [index, file] of files.entries()) {
    const artifact = archive.addArtifact(batch.id, {
      artifactKey: `input:${index}`, direction: 'input', role: 'input',
      sourceOperation: 'vccFinancialOp:import:apply', originalName: file.fileName, sourcePath: file.filePath,
      metadata: handoffMetadata(file, taskRunId)
    });
    archive.startArtifactAttempt(artifact.id);
    archive.completeArtifact(artifact.id, {
      sha256: file.sha256, sizeBytes: file.sizeBytes, relativePath: `blobs/${file.sha256}`,
      fingerprint: { sizeBytes: file.sizeBytes, mtimeMs: 1, ctimeMs: 1, ino: '1' }
    });
    file.archiveArtifactId = artifact.id;
  }
  const result = await importFiles({
    db,
    targetMonth: MONTH,
    batchId: taskRunId,
    files,
    archiveHandoffFiles: { version: 2, taskRunId, files },
    channelCorrections: collectChannelCorrections(resolved),
    provenance: { appVersion: '3.2.17', buildSha: 'integration' }
  });
  return result.records.find((record) => record.sourceType === SOURCE_TYPES.CHANNEL);
}

async function readSheetRows(filePath) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(filePath);
  const sheet = workbook.worksheets[0];
  const headers = sheet.getRow(1).values.slice(1);
  const rows = [];
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    rows.push(Object.fromEntries(headers.map((header, index) => [header, row.getCell(index + 1).value])));
  });
  return rows;
}

async function run() {
  console.log('==== VCC 财务OP通道明细预检补录集成验证 ====');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vcc-channel-correction-'));
  const db = new DatabaseSync(path.join(dir, 'tool-data.sqlite'));
  try {
    db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL');
    db.exec("CREATE TABLE app_settings (setting_key TEXT PRIMARY KEY, setting_value TEXT, updated_at TEXT DEFAULT (datetime('now')))");
    ensureVccFinancialOpTablesSupport(db, { autoUpgradeEmptyV1: true });
    const archive = createArchiveRepository(db);
    archive.ensureSchema();
    const context = { db, archive };
    const filePath = writeChannelWorkbook(dir);

    // Step 1：预检列出可补录行
    const plan = await inspectWorkbookImportPlan([filePath], { targetMonth: MONTH });
    const candidates = plan.sources[0].channelCorrectionCandidates.candidates;
    assertEq(candidates.map((candidate) => candidate.idempotencyKey), ['CH-AMOUNT', 'CH-DIRECTION', 'CH-CITI'],
      '预检列出三行可补录通道明细');
    assertEq(candidates.find((candidate) => candidate.idempotencyKey === 'CH-CITI').requiredFields,
      ['借贷方向', '通道名称', '交易币种', '交易金额'], 'CITI 行按交易币种/金额补录');

    // Step 2：补录校验
    const sourceId = plan.sources[0].sourceId;
    const rowOf = (key) => candidates.find((candidate) => candidate.idempotencyKey === key).sourceRow;
    await assertRejects(async () => importWithCorrections(context, plan,
      [{ sourceId, sourceRow: rowOf('CH-AMOUNT'), fields: { 账单日期: '2026-06-11' } }], 'reject-field'),
    'vcc-import-plan-invalid', '账单日期不可补录');
    await assertRejects(async () => importWithCorrections(context, plan,
      [{ sourceId, sourceRow: rowOf('CH-CITI'), fields: { 交易金额: '12.345' } }], 'reject-value'),
    'vcc-channel-correction-invalid', '补录金额格式不合规时拒绝导入');

    // Step 3：导入应用补录
    const record = await importWithCorrections(context, plan, [
      { sourceId, sourceRow: rowOf('CH-AMOUNT'), fields: { 实际到账金额: '20.50' } },
      { sourceId, sourceRow: rowOf('CH-CITI'), fields: { 交易金额: '7' } }
    ], 'correction-import');
    assertEq([record.insertedCount, record.formatErrorCount, record.correctedRowCount], [3, 1, 2],
      '补录两行入有效数据，未补录行仍按异常过滤');
    assertEq(db.prepare(`
      SELECT idempotency_key, stat_currency, signed_amount FROM vcc_fin_op_effective_rows ORDER BY idempotency_key
    `).all().map((row) => [row.idempotency_key, row.stat_currency, row.signed_amount]), [
      ['CH-AMOUNT', 'USD', '20.5'], ['CH-CITI', 'EUR', '7'], ['CH-OK', 'USD', '10']
    ], '发生额按补录后的值计算');
    assertEq(db.prepare(`
      SELECT field_name, original_value, corrected_value FROM vcc_fin_op_channel_corrections ORDER BY id
    `).all().map((row) => [row.field_name, row.original_value, row.corrected_value]), [
      ['实际到账金额', '', '20.50'], ['交易金额', 'abc', '7']
    ], '逐字段记录原值与新值');

    // Step 4：校验原表导出套用补录记录
    const source = db.prepare('SELECT id, source_sha256, source_size_bytes FROM vcc_fin_op_import_sources').get();
    const rawPath = path.join(dir, '校验原表.xlsx');
    await writeDatasetWorkbook({
      db, targetMonth: MONTH, sourceType: SOURCE_TYPES.CHANNEL, targetKind: 'raw', outputPath: rawPath,
      archiveSources: [{
        sourceId: Number(source.id), filePath, sha256: source.source_sha256, sizeBytes: Number(source.source_size_bytes)
      }]
    });
    const rawRows = await readSheetRows(rawPath);
    assertEq(rawRows.map((row) => [row['渠道订单号'], String(row['实际到账金额'] ?? ''), String(row['交易金额'] ?? '')]), [
      ['CH-OK', '10', ''], ['CH-AMOUNT', '20.50', ''], ['CH-CITI', '10', '7']
    ], '校验原表导出显示补录后的值，血缘校验通过');

    // Step 5：导出明细与重导
    const auditPath = path.join(dir, '导出明细.xlsx');
    await writeImportAuditWorkbook({ db, recordId: record.recordId, outputPath: auditPath });
    const auditRows = await readSheetRows(auditPath);
    assertEq(auditRows.filter((row) => row['分类'] === '人工补录').map((row) => [row['幂等键'], row['说明']]), [
      ['CH-AMOUNT', '原值 （空） → 新值 20.50'], ['CH-CITI', '原值 abc → 新值 7']
    ], '导出明细含人工补录分类');
    const replan = await inspectWorkbookImportPlan([filePath], { targetMonth: MONTH });
    const replanRow = (key) => replan.sources[0].channelCorrectionCandidates.candidates
      .find((candidate) => candidate.idempotencyKey === key).sourceRow;
    const replay = await importWithCorrections(context, replan, [
      { sourceId: replan.sources[0].sourceId, sourceRow: replanRow('CH-AMOUNT'), fields: { 实际到账金额: '20.50' } },
      { sourceId: replan.sources[0].sourceId, sourceRow: replanRow('CH-CITI'), fields: { 交易金额: '8' } }
    ], 'correction-replay');
    assertEq([replay.skippedCount, replay.conflictCount, replay.insertedCount], [2, 1, 0],
      '同样补录幂等跳过，改法不同为幂等冲突');
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }

  const total = passed + failed;
  console.log(`\n==== ${passed}/${total} PASS ====`);
  if (failed > 0) {
    console.error('FAILURES:');
    failures.forEach((failure) => console.error(
      `  - ${failure.label}: expected=${JSON.stringify(failure.expected)} actual=${JSON.stringify(failure.actual)}`
    ));
    process.exit(1);
  }
}

run().catch((error) => {
  console.error('FATAL', error);
  process.exit(1);
});
