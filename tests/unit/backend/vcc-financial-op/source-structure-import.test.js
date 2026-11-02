'use strict';

// v3.2.14：VCC 财务OP 原表按设置 → 模板文件当前结构识别；导入时的表头随交接成员清单记录在存档原件上，
//   入库前对应回内置列序（映射、幂等键、content_hash、raw_json 不变），数据集导出重读原件按同一结构核验血缘。
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
const {
  SOURCE_TYPES: T, SUPPORTED_CURRENCIES, SYSTEM_OP_HEADERS, getSourceDefinition
} = require('../../../../src/backend/vcc-financial-op/definitions');
const {
  inspectWorkbookImportPlan, resolveImportPlan, revalidateImportPlan
} = require('../../../../src/backend/vcc-financial-op/workbook-import-plan');
const { buildMemberFiles, canonicalMembers, handoffMetadata, readHandoffMetadata } = require('../../../../src/backend/vcc-financial-op/import-handoff');
const { importFiles } = require('../../../../src/backend/vcc-financial-op/import-service');
const { mapDetailRow } = require('../../../../src/backend/vcc-financial-op/row-mapper');
const { EXPORT_KINDS, writeDatasetWorkbook } = require('../../../../src/main-process/vcc-financial-op-dataset-writer');

const RECHARGE = getSourceDefinition(T.RECHARGE).headers;
const PENDING = getSourceDefinition(T.PENDING).headers;
// 充值清退 V2：「场景」按位置改名为「业务场景」，删除 fee（其后各列左移一位），末尾新增一列；必用列不动。
const RECHARGE_V2 = [...RECHARGE.filter((header) => header !== 'fee').map((header) => (header === '场景' ? '业务场景' : header)), '新增列'];
// Pending V2：「维护人」与「维护人BU」调换位置（按列名对应）。
const PENDING_V2 = PENDING.map((header) => (header === '维护人' ? '维护人BU' : header === '维护人BU' ? '维护人' : header));
// 系统财务OP V2：删除「创建时间」，「费用项」按位置改名为「费用科目」。
const SYSTEM_V2 = SYSTEM_OP_HEADERS.filter((header) => header !== '创建时间').map((header) => (header === '费用项' ? '费用科目' : header));
const STRUCTURES = {
  [T.RECHARGE]: { headers: RECHARGE_V2, versionLabel: 'V2' },
  [T.PENDING]: { headers: PENDING_V2, versionLabel: 'V2' },
  [T.SYSTEM_OP]: { headers: SYSTEM_V2, versionLabel: 'V2' }
};

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vcc-source-structure-'));
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec("CREATE TABLE app_settings (setting_key TEXT PRIMARY KEY, setting_value TEXT, updated_at TEXT DEFAULT (datetime('now')))");
  ensureVccFinancialOpTablesSupport(db, { autoUpgradeEmptyV1: true });
  const archive = createArchiveRepository(db); archive.ensureSchema();
  t.after(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { db, archive, dir };
}

function write(dir, name, sheets) {
  const book = XLSX.utils.book_new();
  for (const sheet of sheets) {
    XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([
      sheet.headers, ...sheet.rows.map((row) => sheet.headers.map((header) => row[header] ?? ''))
    ]), sheet.name);
  }
  const filePath = path.join(dir, name);
  XLSX.writeFile(book, filePath);
  return filePath;
}

const recharge = (id, extra = {}) => ({ 订单号: id, BillDate: '2026-06-09', 业务部门: 'VCC', 对手部门: 'OPS', 业务子类型: '充值',
  出入方向: 'in', 公司主体: '甲', 我方币种: 'USD', 我方到账金额: '10.25', ...extra });
const pending = (id, extra = {}) => ({ PendingBizId: id, 平账账期: '2026-06-15', 主体: '甲', 对账类型: 'VCC_clearing_credit',
  channel: 'CITI', 币种: 'USD', 流水_币种: 'USD', 金额: '5', 流水_对账金额: '5', ...extra });
const systemRows = (subject) => SUPPORTED_CURRENCIES.map((币种) => ({ 账单日期: '2026-06-30', 主体: subject, 业务部门: 'VCC', 币种,
  财务余额: '12.34', 财务主体余额: '12.34', 费用科目: `费用-${币种}` }));

async function prepare(f, paths, { sourceStructures = STRUCTURES, taskRunId = 'structure-task' } = {}) {
  const plan = await inspectWorkbookImportPlan(paths, { sourceStructures });
  const files = buildMemberFiles(resolveImportPlan(plan, { planId: plan.planId, subjectBySourceId: {}, excludedSheetIds: [] }));
  const batch = f.archive.createBatch({ moduleId: 'vcc-financial-op', moduleCode: 'VCCFINOP', moduleName: 'VCC',
    operationKey: taskRunId, taskKey: 'vccFinancialOp:import:apply', taskRunId, parentRunId: taskRunId,
    localDate: '2026-09-18', retentionUntil: '2026-11-17' }).batch;
  f.db.prepare('UPDATE archive_batches SET task_run_id = ?, task_key = ? WHERE id = ?').run(taskRunId, 'vccFinancialOp:import:apply', batch.id);
  for (const [index, file] of files.entries()) {
    const artifact = f.archive.addArtifact(batch.id, { artifactKey: `input:${index}`, direction: 'input', role: 'input',
      sourceOperation: 'vccFinancialOp:import:apply', originalName: file.fileName, sourcePath: file.filePath,
      metadata: handoffMetadata(file, taskRunId) });
    f.archive.startArtifactAttempt(artifact.id);
    f.archive.completeArtifact(artifact.id, { sha256: file.sha256, sizeBytes: file.sizeBytes,
      relativePath: `blobs/${file.sha256}`, fingerprint: { sizeBytes: file.sizeBytes, mtimeMs: 1, ctimeMs: 1, ino: '1' } });
    file.archiveArtifactId = artifact.id;
  }
  return { plan, files, request: { db: f.db, targetMonth: '2026-06', batchId: taskRunId, files,
    archiveHandoffFiles: { version: 2, taskRunId, files } } };
}

function archiveSourcesOf(f, files) {
  return f.db.prepare('SELECT id, source_file_name, source_sha256, source_size_bytes, archive_artifact_id FROM vcc_fin_op_import_sources').all()
    .map((source) => ({ sourceId: source.id, filePath: files.find((file) => file.archiveArtifactId === source.archive_artifact_id).filePath,
      fileName: source.source_file_name, sha256: source.source_sha256, sizeBytes: source.source_size_bytes }));
}

async function exportedRows(f, files, sourceType) {
  const outputPath = path.join(f.dir, `${sourceType}-raw.xlsx`);
  await writeDatasetWorkbook({ db: f.db, targetMonth: '2026-06', sourceType, targetKind: EXPORT_KINDS.RAW, outputPath,
    archiveSources: archiveSourcesOf(f, files) });
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(outputPath);
  const sheet = workbook.worksheets[0];
  const headers = sheet.getRow(1).values.slice(1);
  const rows = [];
  sheet.eachRow((row, index) => { if (index > 1) rows.push(Object.fromEntries(headers.map((header, column) => [header, row.values[column + 1] ?? '']))); });
  return { headers, rows };
}

test('预检按当前结构识别并记录导入时表头；内置结构的文件给出与当前版本的逐列差异；重新预检沿用冻结结构', async (t) => {
  const f = fixture(t);
  const current = write(f.dir, 'v2.xlsx', [{ name: '充值', headers: RECHARGE_V2, rows: [recharge('A-1')] }]);
  const legacy = write(f.dir, 'builtin.xlsx', [{ name: '充值', headers: RECHARGE, rows: [recharge('A-2')] }]);
  const plan = await inspectWorkbookImportPlan([current, legacy], { sourceStructures: STRUCTURES });
  const [ready, invalid] = plan.sources;
  assert.deepEqual([ready.status, ready.sourceType, ready.sourceHeaders], ['ready', T.RECHARGE, RECHARGE_V2]);
  assert.equal(invalid.status, 'invalid');
  const lines = invalid.diagnostics[0].detailLines;
  assert.equal(lines[0], '最接近：VCC充值清退明细（当前版本 V2，49 列；文件 49 列）');
  assert.ok(lines.includes('缺少列：业务场景、新增列'), lines.join('\n'));
  assert.equal(lines.at(-1), '如系统导出结构已变更，请在「设置 → 模板文件」导入新版本');
  assert.throws(() => resolveImportPlan(plan, { planId: plan.planId, subjectBySourceId: {}, excludedSheetIds: [] }), (error) => {
    assert.ok(error.detailLines.includes('缺少列：业务场景、新增列'), error.detailLines.join('\n'));
    return true;
  });

  const builtinPlan = await inspectWorkbookImportPlan([legacy]);
  assert.equal(builtinPlan.sources[0].status, 'ready');
  assert.equal(Object.hasOwn(builtinPlan.sources[0], 'sourceHeaders'), false, '内置结构不记录表头');
  const onlyCurrent = await inspectWorkbookImportPlan([current], { sourceStructures: STRUCTURES });
  await revalidateImportPlan(onlyCurrent);
});

test('交接成员清单：用户结构时记录导入时表头并受成员摘要保护；内置结构的清单与摘要不变', () => {
  const sheet = { sheetName: '充值', sheetIndex: 0, headerRow: 1, rawContractVersion: 1 };
  const builtin = canonicalMembers([{ sourceType: T.RECHARGE, sourceOrdinal: 1, sheets: [sheet] }]);
  assert.deepEqual(Object.keys(builtin[0].sheets[0]), ['sheetName', 'sheetIndex', 'headerRow', 'rawContractVersion']);
  const custom = canonicalMembers([{ sourceType: T.RECHARGE, sourceOrdinal: 1, sheets: [{ ...sheet, sourceHeaders: RECHARGE_V2 }] }]);
  assert.deepEqual([...custom[0].sheets[0].sourceHeaders], RECHARGE_V2);
  for (const bad of [[], ['a', 'a'], [' a'], ['a', '']]) {
    assert.throws(() => canonicalMembers([{ sourceType: T.RECHARGE, sourceOrdinal: 1, sheets: [{ ...sheet, sourceHeaders: bad }] }]),
      /导入时表头无效/);
  }
  const metadata = handoffMetadata({ physicalFileId: 'p-1', sha256: 'a'.repeat(64), sizeBytes: 1, members: custom }, 'task-1');
  assert.deepEqual([...readHandoffMetadata(metadata).vccSourceMembers[0].sheets[0].sourceHeaders], RECHARGE_V2);
  const tampered = JSON.parse(JSON.stringify(metadata));
  tampered.vccSourceMembers[0].sheets[0].sourceHeaders = RECHARGE;
  assert.throws(() => readHandoffMetadata(tampered), /成员摘要变化/);
});

test('明细与 Pending：按导入时结构读取后对应回内置列入库，hash 与内置结构同值导入一致；数据集导出重读原件核验通过', async (t) => {
  const f = fixture(t);
  const file = write(f.dir, 'mixed.xlsx', [
    { name: '充值', headers: RECHARGE_V2, rows: [recharge('A-1', { 业务场景: '改名列的值', 新增列: '不导入', 优惠券: '1', 备注: '备注值' })] },
    { name: 'Pending', headers: PENDING_V2, rows: [pending('P-1', { 维护人: '张三', 维护人BU: 'VCC-BU' })] }
  ]);
  const { files, request } = await prepare(f, [file]);
  assert.deepEqual(files[0].members.map((member) => [member.sourceType, member.sheets[0].sourceHeaders.length]),
    [[T.RECHARGE, RECHARGE_V2.length], [T.PENDING, PENDING_V2.length]]);
  const result = await importFiles(request);
  assert.deepEqual(result.records.map((record) => [record.sourceType, record.insertedCount]), [[T.RECHARGE, 1], [T.PENDING, 1]]);

  // v3 存储的有效行不存原始值（已存档来源靠重读原件核验）：content_hash 应与按内置列序映射同一行的结果一致。
  const stored = f.db.prepare('SELECT source_type, raw_contract_version, content_hash FROM vcc_fin_op_effective_rows ORDER BY id').all();
  const canonical = (headers, values) => headers.map((header) => values[header] ?? '');
  const expectedRecharge = mapDetailRow({ sourceType: T.RECHARGE, targetMonth: '2026-06', sourceFile: 'mixed.xlsx', sheetName: '充值', sourceRow: 2,
    values: canonical(RECHARGE, { ...recharge('A-1', { 优惠券: '1', 备注: '备注值' }), 场景: '改名列的值' }) });
  const expectedPending = mapDetailRow({ sourceType: T.PENDING, targetMonth: '2026-06', sourceFile: 'mixed.xlsx', sheetName: 'Pending', sourceRow: 2,
    values: canonical(PENDING, pending('P-1', { 维护人: '张三', 维护人BU: 'VCC-BU' })) });
  assert.deepEqual(stored.map((row) => [row.source_type, row.raw_contract_version, row.content_hash]), [
    [T.RECHARGE, 1, expectedRecharge.contentHash],
    [T.PENDING, 2, expectedPending.contentHash]
  ], '与内置结构下同值导入一致：改名列取新列值、删除列为空、新增列不导入、调序按列名');

  const exported = await exportedRows(f, files, T.RECHARGE);
  assert.deepEqual(exported.headers, [...RECHARGE]);
  assert.deepEqual([exported.rows[0]['订单号'], exported.rows[0]['场景'], exported.rows[0].fee, exported.rows[0]['备注']], ['A-1', '改名列的值', '', '备注值']);
  const exportedPending = await exportedRows(f, files, T.PENDING);
  assert.deepEqual([exportedPending.rows[0]['维护人'], exportedPending.rows[0]['维护人BU']], ['张三', 'VCC-BU']);
});

test('系统财务OP：按导入时结构定位表头与财务余额列，余额与快照按内置 16 列；数据集导出重读原件核验通过', async (t) => {
  const f = fixture(t);
  const file = write(f.dir, 'system.xlsx', [{ name: '系统OP', headers: SYSTEM_V2, rows: systemRows('甲') }]);
  const { files, request } = await prepare(f, [file]);
  const result = await importFiles(request);
  assert.equal(result.records[0].sourceType, T.SYSTEM_OP);
  assert.equal(result.records[0].status, 'success', JSON.stringify(result.records[0]));
  const snapshot = f.db.prepare('SELECT raw_json, balances_json FROM vcc_fin_op_system_snapshots').get();
  const raw = JSON.parse(snapshot.raw_json);
  assert.deepEqual(raw.displayHeaders, [...SYSTEM_OP_HEADERS]);
  assert.equal(JSON.parse(snapshot.balances_json).USD, '12.34');
  const exported = await exportedRows(f, files, T.SYSTEM_OP);
  assert.deepEqual(exported.headers, [...SYSTEM_OP_HEADERS]);
  assert.equal(exported.rows.find((row) => row['币种'] === 'USD')['费用项'], '费用-USD');
  assert.equal(exported.rows[0]['创建时间'], '');
});

test('导入时结构以外多出的数据列仍按模板外列拒绝（系统财务OP）', async (t) => {
  const f = fixture(t);
  const rows = systemRows('甲').map((row) => [...SYSTEM_V2.map((header) => row[header] ?? ''), '多出的值']);
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([SYSTEM_V2, ...rows]), '系统OP');
  const filePath = path.join(f.dir, 'system-extra.xlsx');
  XLSX.writeFile(book, filePath);
  const { request } = await prepare(f, [filePath]);
  const result = await importFiles(request);
  assert.notEqual(result.records[0].status, 'success');
});
