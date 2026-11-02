'use strict';

// v3.2.14：业务 OP 新版的流水对账单按设置 → 模板文件当前结构识别（导入任务开始时解析并冻结进计划），
//   读出后对应回内置 28 列；数据集记录导入时结构，「流水校验原表」导出重读原件按记录的结构识别，输出仍为内置列。
const { durableDirectoryTest: test } = require('../../helpers/durable-directory-tests');
const assert = require('node:assert/strict');
const path = require('node:path');
const ExcelJS = require('exceljs');
const { createExportHost, request } = require('../../helpers/biz-op-v327-export');
const { writeXlsx, flowRow } = require('../../helpers/biz-op-v327-xlsx');
const { FLOW_HEADERS } = require('../../../src/backend/biz-op-recon-db/columns');
const { createImportAdapter, detectHeader } = require('../../../src/main-process/biz-op-v327/import-adapter');
const { readVerifiedManifest } = require('../../../src/main-process/biz-op-v327/payload-store');

// V2：「拆分类型」按位置改名为「拆分方式」，删除「操作人」（其后两列左移，按列名对应），末尾新增一列；必用列不动。
const FLOW_V2 = [...FLOW_HEADERS.filter((header) => header !== '操作人').map((header) => (header === '拆分类型' ? '拆分方式' : header)), '新增列'];

// flowRow 按内置列下标给值；转换为按 V2 列序的一行。
function v2Row(extra = {}) {
  const builtin = Object.fromEntries(FLOW_HEADERS.map((header, index) => [header, flowRow()[index]]));
  const values = { ...builtin, 拆分方式: '拆分值', 操作人: '不在新结构中', 新增列: '不导入', 系统创建时间: '2026-09-02', ...extra };
  return FLOW_V2.map((header) => values[header] ?? '');
}

async function host(t) {
  const state = { structures: { FLOW: { headers: FLOW_V2, versionLabel: 'V2' } } };
  const f = await createExportHost(t, { moduleOptions: { resolveSourceStructures: async () => state.structures } });
  return { f, state };
}

async function rawRows(filePath) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(filePath);
  const sheet = workbook.worksheets.find((item) => item.getRow(1).values.includes('BizId'));
  const headers = sheet.getRow(1).values.slice(1);
  const rows = [];
  sheet.eachRow((row, index) => {
    if (index > 1) rows.push(Object.fromEntries(headers.map((header, column) => [header, row.values[column + 1] ?? ''])));
  });
  return { headers, rows };
}

test('按当前结构导入：数据集记录导入时结构，流水校验原表导出按内置 28 列输出改名列的值', async (t) => {
  const { f } = await host(t);
  const file = path.join(f.root, 'flow-v2.xlsx');
  await writeXlsx(file, { headers: FLOW_V2, rowCount: 1, row: () => v2Row() });
  const imported = await f.run([file]);
  assert.equal(imported.status, 'ok', JSON.stringify(imported));
  const datasetId = imported.receipt.outcome.datasets[0].datasetId;
  const dataset = f.module.catalog.queries.readExportObject('FLOW_RAW', datasetId);
  const manifest = readVerifiedManifest(await f.module.payloadStore.verifyManifest(dataset.manifestRelativePath, dataset.manifestDigest));
  assert.deepEqual(manifest.catalog.sourceHeaders, FLOW_V2);
  assert.equal(Object.hasOwn(manifest.catalog.sources[0], 'sourceHeaders'), false, '来源条目字段不变');

  const exported = await request(f, 'FLOW_RAW', datasetId);
  assert.equal(exported.status, 'ok', JSON.stringify(exported));
  const { headers, rows } = await rawRows(exported.filePath);
  assert.deepEqual(headers, [...FLOW_HEADERS]);
  assert.equal(rows[0]['拆分类型'], '拆分值');
  assert.equal(rows[0]['操作人'], '');
  assert.equal(rows[0]['账户编号'], '000123');
  assert.equal((await request(f, 'FLOW_CHECK', datasetId)).status, 'ok');
});

test('恢复默认后已导入的数据集仍按记录的结构导出；内置结构的文件在当前结构下被拒并附逐列差异', async (t) => {
  const { f, state } = await host(t);
  const v2File = path.join(f.root, 'flow-v2.xlsx');
  await writeXlsx(v2File, { headers: FLOW_V2, rowCount: 1, row: () => v2Row() });
  const datasetId = (await f.run([v2File])).receipt.outcome.datasets[0].datasetId;

  const builtinFile = path.join(f.root, 'flow-builtin.xlsx');
  await writeXlsx(builtinFile, { rowCount: 1, row: () => flowRow({ date: '2026-09-03' }) });
  const rejected = await f.run([builtinFile]);
  assert.equal(rejected.status, 'error', JSON.stringify(rejected));
  assert.equal(rejected.summary.fileErrorCount, 1);
  assert.equal((await f.module.recovery.run()).ready, true);
  const report = await request(f, 'ERRORS', rejected.reportRef);
  assert.equal(report.status, 'ok', JSON.stringify(report));
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(report.filePath);
  const texts = workbook.worksheets.flatMap((sheet) => sheet.getSheetValues().flat().filter((value) => typeof value === 'string'));
  assert.ok(texts.some((text) => text.includes('第 13 列（M）：应为「拆分方式」，实际为「拆分类型」')), '错误报告列出与当前结构的逐列差异');

  state.structures = null;
  const exported = await request(f, 'FLOW_RAW', datasetId);
  assert.equal(exported.status, 'ok', JSON.stringify(exported));
  assert.equal((await rawRows(exported.filePath)).rows[0]['拆分类型'], '拆分值');
});

test('表头识别：不符时附与当前结构的逐列差异与模板指引；适配器按内置下标取对应列', () => {
  const header = (values) => ({ rowIndex: 1, cells: values.map((value, columnIndex) => ({ columnIndex, cellType: 'text', decodedSemanticValue: value })) });
  assert.equal(detectHeader(header(FLOW_V2), { flowHeaders: FLOW_V2 }), 'FLOW');
  assert.throws(() => detectHeader(header(FLOW_HEADERS), { flowHeaders: FLOW_V2 }), (error) => {
    assert.match(error.message, /^表头必须完整匹配 OP 23 列或流水 28 列原表，不能回导生成表：最接近：流水对账单（当前版本 用户版本，28 列；文件 28 列）/);
    assert.match(error.message, /第 13 列（M）：应为「拆分方式」，实际为「拆分类型」/);
    assert.match(error.message, /请在「设置 → 模板文件」导入新版本/);
    return true;
  });
  const adapter = createImportAdapter('FLOW', { sourceHeaders: FLOW_V2 });
  const values = v2Row();
  const row = { rowIndex: 2, cells: values.map((value, columnIndex) => ({ columnIndex, cellType: 'text', decodedSemanticValue: value })) };
  const adapted = adapter.adapt(row);
  assert.deepEqual(adapted.errors, []);
  assert.equal(adapted.originalValues[FLOW_HEADERS.indexOf('拆分类型')], '拆分值');
  assert.equal(adapted.originalValues[FLOW_HEADERS.indexOf('操作人')], '');
  const beyond = adapter.adapt({ rowIndex: 3, cells: [...row.cells, { columnIndex: FLOW_V2.length, cellType: 'text', decodedSemanticValue: 'x' }] });
  assert.ok(beyond.errors.some((message) => /超出原表模板/.test(message)), '导入时结构宽度之外的数据仍拒绝');
});
