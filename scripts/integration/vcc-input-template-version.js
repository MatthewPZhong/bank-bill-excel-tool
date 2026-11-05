// 设置 · 模板文件「VCC 财务OP 原表导入识别结构」集成验证（真实主库迁移 + 真实模板服务 + 真实预检 / 交接 / 存档 / 导入 / 数据集导出）
//   覆盖：内置结构下按新结构导出的充值清退原表预检不通过，并给出与当前结构的逐列差异；在模板文件导入并启用新结构后，
//         选文件预检按 main.js 的同一装配解析结构并冻结进计划，导入时的表头随交接成员清单记录在存档原件上；
//         入库对应回内置列序（content_hash 与内置结构同值导入一致），数据集导出重读存档原件按导入时结构核验血缘；
//         恢复默认后已导入数据仍按记录的结构导出，同一文件再预检不通过。
//
// 预检 / 导入在 worker 中执行的部分在本进程直接调用同一函数（inspectWorkbookImportPlan、importFiles）；
//   存档按 tests/helpers/vcc-review-export.js 的方式登记 ready 原件与交接元数据。
// 用法：node scripts/integration/vcc-input-template-version.js

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const XLSX = require('xlsx');
const ExcelJS = require('exceljs');

const { AppDatabase } = require('../../src/backend/database');
const { createArchiveRepository } = require('../../src/backend/database/archive-repository');
const { SOURCE_TYPES: T, getSourceDefinition } = require('../../src/backend/vcc-financial-op/definitions');
const { inspectWorkbookImportPlan, resolveImportPlan } = require('../../src/backend/vcc-financial-op/workbook-import-plan');
const { buildMemberFiles, handoffMetadata } = require('../../src/backend/vcc-financial-op/import-handoff');
const { importFiles } = require('../../src/backend/vcc-financial-op/import-service');
const { mapDetailRow } = require('../../src/backend/vcc-financial-op/row-mapper');
const { EXPORT_KINDS, writeDatasetWorkbook } = require('../../src/main-process/vcc-financial-op-dataset-writer');
const { resolveVccSourceStructures } = require('../../src/main-process/vcc-financial-op-source-structures');
const { createTemplateResourceService } = require('../../src/main-process/template-resources/service');

const ROOT = path.resolve(__dirname, '..', '..');
const RECHARGE = getSourceDefinition(T.RECHARGE).headers;
// V2：「场景」按位置改名为「业务场景」，删除 fee，末尾新增一列；必用列不动。
const RECHARGE_V2 = [...RECHARGE.filter((header) => header !== 'fee').map((header) => (header === '场景' ? '业务场景' : header)), '新增列'];
const ROW = { 订单号: 'IT-0001', BillDate: '2026-06-09', 业务部门: 'VCC', 对手部门: 'OPS', 业务子类型: '充值', 出入方向: 'in',
  公司主体: '甲', 我方币种: 'USD', 我方到账金额: '10.25', 业务场景: '改名列的值', 新增列: '不导入', 备注: '备注值' };

function writeWorkbook(filePath, headers, rows = []) {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([headers, ...rows.map((row) => headers.map((header) => row[header] ?? ''))]), '充值');
  XLSX.writeFile(workbook, filePath);
  return filePath;
}

async function run() {
  console.log('==== VCC 财务OP 原表导入识别结构 集成验证 ====');
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'vcc-input-template-version-'));
  const userData = path.join(temporary, 'userData');
  const files = path.join(temporary, 'files');
  fs.mkdirSync(userData, { recursive: true });
  fs.mkdirSync(files, { recursive: true });
  const database = new AppDatabase(path.join(userData, 'tool-data.sqlite'));
  database.init();
  const db = database.db;
  const archive = createArchiveRepository(db);
  archive.ensureSchema();
  const templates = createTemplateResourceService({ appRoot: ROOT, appVersion: 'integration', userDataRoot: userData, store: database });
  const exportFile = writeWorkbook(path.join(files, 'VCC充值清退明细-新结构.xlsx'), RECHARGE_V2, [ROW]);
  let imported = null;
  // 与 main.js vccFinancialOp:import:pick-files 相同：每次选文件预检时解析当前结构。
  const inspect = async () => inspectWorkbookImportPlan([exportFile], { sourceStructures: await resolveVccSourceStructures(templates) });
  const exportRaw = async (name) => {
    const outputPath = path.join(files, name);
    const sources = db.prepare('SELECT id, source_file_name, source_sha256, source_size_bytes FROM vcc_fin_op_import_sources').all();
    await writeDatasetWorkbook({ db, targetMonth: '2026-06', sourceType: T.RECHARGE, targetKind: EXPORT_KINDS.RAW, outputPath,
      archiveSources: sources.map((source) => ({ sourceId: source.id, filePath: imported.files[0].filePath, fileName: source.source_file_name,
        sha256: source.source_sha256, sizeBytes: source.source_size_bytes })) });
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(outputPath);
    const sheet = workbook.worksheets[0];
    const headers = sheet.getRow(1).values.slice(1);
    return { headers, row: Object.fromEntries(headers.map((header, index) => [header, sheet.getRow(2).values[index + 1] ?? ''])) };
  };
  const results = [];

  const cases = [
    ['内置结构下，按新结构导出的原表预检不通过，并列出与当前结构的逐列差异与指引', async () => {
      const plan = await inspect();
      assert.equal(plan.sourceStructures, null);
      const source = plan.sources[0];
      assert.equal(source.status, 'invalid');
      const lines = source.diagnostics[0].detailLines;
      assert.equal(lines[0], '最接近：VCC充值清退明细（49 列；文件 49 列）');
      assert.ok(lines.includes('第 11 列（K）：应为「场景」，实际为「业务场景」'), lines.join('\n'));
      assert.equal(lines.at(-1), '如系统导出结构已变更，请在「设置 → 模板文件」导入新版本');
    }],
    ['启用新结构后预检按当前版本识别，导入时表头记录在存档原件上，入库对应回内置列序', async () => {
      const templateFile = writeWorkbook(path.join(files, 'VCC充值清退明细-模板.xlsx'), RECHARGE_V2);
      templates.rememberPickedFile(templateFile);
      const prepared = await templates.prepareImport({ resourceId: 'vcc-recharge-refund', filePath: templateFile });
      assert.equal(prepared.status, 'success', prepared.message);
      assert.equal(prepared.verdict, 'warn', JSON.stringify(prepared.checks));
      assert.equal((await templates.commitImport({ importToken: prepared.importToken, enable: true })).status, 'success');

      const plan = await inspect();
      assert.deepEqual(plan.sourceStructures, { [T.RECHARGE]: { headers: RECHARGE_V2, versionLabel: 'V2' } });
      assert.deepEqual(plan.sources[0].sourceHeaders, RECHARGE_V2);
      const planFiles = buildMemberFiles(resolveImportPlan(plan, { planId: plan.planId, subjectBySourceId: {}, excludedSheetIds: [] }));
      const taskRunId = 'integration-vcc-structure';
      const batch = archive.createBatch({ moduleId: 'vcc-financial-op', moduleCode: 'VCCFINOP', moduleName: 'VCC',
        operationKey: taskRunId, taskKey: 'vccFinancialOp:import:apply', taskRunId, parentRunId: taskRunId,
        localDate: '2026-11-01', retentionUntil: '2026-12-31' }).batch;
      db.prepare('UPDATE archive_batches SET task_run_id = ?, task_key = ? WHERE id = ?').run(taskRunId, 'vccFinancialOp:import:apply', batch.id);
      for (const [index, file] of planFiles.entries()) {
        const artifact = archive.addArtifact(batch.id, { artifactKey: `input:${index}`, direction: 'input', role: 'input',
          sourceOperation: 'vccFinancialOp:import:apply', originalName: file.fileName, sourcePath: file.filePath,
          metadata: handoffMetadata(file, taskRunId) });
        archive.startArtifactAttempt(artifact.id);
        archive.completeArtifact(artifact.id, { sha256: file.sha256, sizeBytes: file.sizeBytes, relativePath: `blobs/${file.sha256}`,
          fingerprint: { sizeBytes: file.sizeBytes, mtimeMs: 1, ctimeMs: 1, ino: '1' } });
        file.archiveArtifactId = artifact.id;
      }
      const stored = archive.getArtifact(planFiles[0].archiveArtifactId).metadata.vccSourceMembers[0].sheets[0];
      assert.deepEqual([...stored.sourceHeaders], RECHARGE_V2, '导入时表头持久化在存档原件的成员清单上');
      const result = await importFiles({ db, targetMonth: '2026-06', batchId: taskRunId, files: planFiles,
        archiveHandoffFiles: { version: 2, taskRunId, files: planFiles } });
      assert.deepEqual(result.records.map((record) => [record.status, record.insertedCount]), [['success', 1]]);
      imported = { files: planFiles };
      const expected = mapDetailRow({ sourceType: T.RECHARGE, targetMonth: '2026-06', sourceFile: 'x', sheetName: '充值', sourceRow: 2,
        values: RECHARGE.map((header) => ({ ...ROW, 场景: ROW.业务场景 })[header] ?? '') });
      assert.equal(db.prepare('SELECT content_hash FROM vcc_fin_op_effective_rows').get().content_hash, expected.contentHash);
    }],
    ['数据集导出重读存档原件按导入时结构核验血缘，按内置列序出列', async () => {
      const { headers, row } = await exportRaw('raw-v2.xlsx');
      assert.deepEqual(headers, [...RECHARGE]);
      assert.deepEqual([row['订单号'], row['场景'], row.fee, row['备注']], ['IT-0001', '改名列的值', '', '备注值']);
    }],
    ['恢复默认后已导入数据仍按记录的结构导出；同一文件再预检不通过', async () => {
      const restored = await templates.setCurrentVersion({ resourceId: 'vcc-recharge-refund', versionId: 'v1' });
      assert.equal(restored.status, 'success', restored.message);
      const { row } = await exportRaw('raw-restored.xlsx');
      assert.equal(row['场景'], '改名列的值');
      assert.equal((await inspect()).sources[0].status, 'invalid');
    }]
  ];

  try {
    for (const [label, body] of cases) {
      try {
        await body();
        results.push({ label, ok: true });
        console.log(`PASS ${label}`);
      } catch (error) {
        results.push({ label, ok: false, error });
        console.log(`FAIL ${label}\n  ${error && error.stack ? error.stack : error}`);
      }
    }
  } finally {
    try { database.close(); } catch (_error) { /* 已关闭 */ }
    fs.rmSync(temporary, { recursive: true, force: true });
  }

  const passed = results.filter((item) => item.ok).length;
  console.log(`\n==== ${passed}/${results.length} PASS ====`);
  if (passed !== results.length) {
    console.error('FAILURES:');
    results.filter((item) => !item.ok).forEach((item) => console.error(`  - ${item.label}: ${item.error && item.error.message}`));
    process.exit(1);
  }
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
