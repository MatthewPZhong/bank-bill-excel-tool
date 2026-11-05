// 设置 · 模板文件「流水对账单导入识别结构」集成验证（真实模板服务 + 真实业务 OP 新版模块：导入 worker 计划、数据集封存、存档原件、导出）
//   覆盖：在模板文件导入并启用新结构后，业务 OP 按 main.js 的同一装配（resolveFlowStatementStructure）解析结构并冻结进导入计划，
//         按新结构导出的流水原表导入成功，数据集记录导入时结构；「流水校验原表」导出重读存档原件按记录的结构识别，
//         输出内置 28 列（改名列取新列值、删除列为空）；恢复默认后同一数据集仍可导出，同一文件再导入被拒。
//
// 业务 OP 宿主沿用 tests/helpers/biz-op-v327-export.js（真实临时主库、payload store、存档与任务运行时）。
// 用法：node scripts/integration/flow-statement-template-version.js

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const XLSX = require('xlsx');
const ExcelJS = require('exceljs');

const { AppDatabase } = require('../../src/backend/database');
const { FLOW_HEADERS } = require('../../src/backend/biz-op-recon-db/columns');
const { createTemplateResourceService } = require('../../src/main-process/template-resources/service');
const { resolveFlowStatementStructure } = require('../../src/main-process/flow-statement-structure');
const { createExportHost, request } = require('../../tests/helpers/biz-op-v327-export');
const { writeXlsx, flowRow } = require('../../tests/helpers/biz-op-v327-xlsx');

const ROOT = path.resolve(__dirname, '..', '..');
// V2：「拆分类型」按位置改名为「拆分方式」，删除「操作人」，末尾新增一列；必用列不动。
const FLOW_V2 = [...FLOW_HEADERS.filter((header) => header !== '操作人').map((header) => (header === '拆分类型' ? '拆分方式' : header)), '新增列'];

function v2Row() {
  const builtin = Object.fromEntries(FLOW_HEADERS.map((header, index) => [header, flowRow()[index]]));
  const values = { ...builtin, 拆分方式: '拆分值', 新增列: '不导入' };
  return FLOW_V2.map((header) => values[header] ?? '');
}

async function rawRows(filePath) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(filePath);
  const sheet = workbook.worksheets.find((item) => item.getRow(1).values.includes('BizId'));
  const headers = sheet.getRow(1).values.slice(1);
  return { headers, row: Object.fromEntries(headers.map((header, index) => [header, sheet.getRow(2).values[index + 1] ?? ''])) };
}

async function run() {
  console.log('==== 流水对账单导入识别结构 集成验证 ====');
  const cleanups = [];
  const t = { after: (fn) => cleanups.push(fn) };
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-statement-template-version-'));
  const userData = path.join(temporary, 'userData');
  fs.mkdirSync(userData, { recursive: true });
  const database = new AppDatabase(path.join(userData, 'tool-data.sqlite'));
  database.init();
  const templates = createTemplateResourceService({ appRoot: ROOT, appVersion: 'integration', userDataRoot: userData, store: database });
  const results = [];
  let host = null;
  let datasetId = null;
  const v2File = path.join(temporary, '流水对账单-新结构导出.xlsx');

  const cases = [
    ['模板文件导入并启用新结构；业务 OP 按同一装配解析并冻结进导入计划，按新结构导出的原表导入成功', async () => {
      const templateFile = path.join(temporary, '流水对账单-模板.xlsx');
      const workbook = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([FLOW_V2]), 'Sheet1');
      XLSX.writeFile(workbook, templateFile);
      templates.rememberPickedFile(templateFile);
      const prepared = await templates.prepareImport({ resourceId: 'flow-statement', filePath: templateFile });
      assert.equal(prepared.status, 'success', prepared.message);
      assert.equal(prepared.verdict, 'warn', JSON.stringify(prepared.checks));
      assert.equal((await templates.commitImport({ importToken: prepared.importToken, enable: true })).status, 'success');

      // 与 main.js createBizOpV327Module({ resolveSourceStructures }) 相同。
      host = await createExportHost(t, { moduleOptions: { resolveSourceStructures: async () => {
        const flow = await resolveFlowStatementStructure(templates);
        return flow ? { FLOW: flow } : null;
      } } });
      await writeXlsx(v2File, { headers: FLOW_V2, rowCount: 1, row: () => v2Row() });
      const imported = await host.run([v2File]);
      assert.equal(imported.status, 'ok', JSON.stringify(imported));
      datasetId = imported.receipt.outcome.datasets[0].datasetId;
    }],
    ['流水校验原表导出重读存档原件按记录的结构识别，输出内置 28 列', async () => {
      const exported = await request(host, 'FLOW_RAW', datasetId);
      assert.equal(exported.status, 'ok', JSON.stringify(exported));
      const { headers, row } = await rawRows(exported.filePath);
      assert.deepEqual(headers, [...FLOW_HEADERS]);
      assert.deepEqual([row['拆分类型'], row['操作人'], row['账户编号']], ['拆分值', '', '000123']);
    }],
    ['恢复默认后同一数据集仍可导出；同一文件再导入被拒', async () => {
      const restored = await templates.setCurrentVersion({ resourceId: 'flow-statement', versionId: 'v1' });
      assert.equal(restored.status, 'success', restored.message);
      const exported = await request(host, 'FLOW_RAW', datasetId);
      assert.equal(exported.status, 'ok', JSON.stringify(exported));
      assert.equal((await rawRows(exported.filePath)).row['拆分类型'], '拆分值');
      const again = path.join(temporary, '流水对账单-新结构导出-再次.xlsx');
      fs.copyFileSync(v2File, again);
      const rejected = await host.run([again]);
      assert.equal(rejected.status, 'error', JSON.stringify(rejected));
      assert.equal(rejected.summary.fileErrorCount, 1);
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
    for (const cleanup of cleanups.reverse()) {
      try { await cleanup(); } catch (_error) { /* 清理失败不影响结果 */ }
    }
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
  process.exit(0);
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
