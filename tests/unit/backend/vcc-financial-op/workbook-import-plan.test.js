'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const XLSX = require('xlsx');
const {
  HEADER_RULES, classifyHeaderRow, headerRulesFor, inspectWorkbookImportPlan, publicImportPlan,
  resolveImportPlan, revalidateImportPlan
} = require('../../../../src/backend/vcc-financial-op/workbook-import-plan');
const { SOURCE_TYPES, SOURCE_DEFINITIONS, PENDING_V1_HEADERS } = require('../../../../src/backend/vcc-financial-op/definitions');
const { streamDetailRows, openWorkbookSheets } = require('../../../../src/backend/vcc-financial-op/workbook-reader');

function workbookFile(t, sheets, name = 'input.xlsx') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vcc-multisheet-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, name);
  const book = XLSX.utils.book_new();
  for (const sheet of sheets) XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(sheet.rows), sheet.name);
  book.Workbook = { Sheets: sheets.map((sheet) => ({ name: sheet.name, Hidden: sheet.hidden || 0 })) };
  XLSX.writeFile(book, file);
  return file;
}

test('相同字节替换文件仍使预检计划过期，不只比较 hash 与大小', async (t) => {
  const file = workbookFile(t, [{ name: '业务', rows: [SOURCE_DEFINITIONS[SOURCE_TYPES.RECHARGE].headers] }]);
  const plan = await inspectWorkbookImportPlan([file]);
  const replacement = `${file}.replacement`; fs.copyFileSync(file, replacement); fs.renameSync(replacement, file);
  await assert.rejects(revalidateImportPlan(plan), { code: 'vcc-import-plan-stale' });
});
const channel = [...SOURCE_DEFINITIONS[SOURCE_TYPES.CHANNEL].headers];
const recharge = [...SOURCE_DEFINITIONS[SOURCE_TYPES.RECHARGE].headers];

test('五类表头精确匹配优先，缺列、错序和额外列均无说明页排除资格', () => {
  for (const rule of HEADER_RULES) {
    assert.equal(classifyHeaderRow(rule.headers).sourceType, rule.sourceType);
    assert.equal(classifyHeaderRow(rule.headers).status, 'ready');
    for (let index = 0; index < rule.headers.length; index++) {
      const missing = rule.headers.filter((_, i) => i !== index);
      assert.equal(classifyHeaderRow(missing).status, 'invalid', `${rule.sourceType}:${index}`);
    }
    const swapped = [...rule.headers];
    [swapped[0], swapped[1]] = [swapped[1], swapped[0]];
    assert.equal(classifyHeaderRow(swapped).status, 'invalid');
    assert.equal(classifyHeaderRow([...rule.headers, '附加列']).status, 'invalid');
  }
  assert.equal(classifyHeaderRow(PENDING_V1_HEADERS).status, 'invalid');
  assert.equal(classifyHeaderRow(['通道名称', channel.find((header) => !['通道名称', '渠道订单号', '清算净金额'].includes(header))]).code,
    'vcc-sheet-header-uncertain');
  assert.equal(classifyHeaderRow(['这是一张说明页']), null);
});

test('多 Sheet 计划包括隐藏、空白和说明页，按 Sheet 补主体且 public DTO 不泄露路径和 hash', async (t) => {
  const file = workbookFile(t, [
    { name: '通道甲', rows: [channel, ['data']], hidden: 1 },
    { name: '说明', rows: [['读取说明']] },
    { name: '空表', rows: [] },
    { name: '通道乙', rows: [channel, ['data']], hidden: 2 },
    { name: '充值', rows: [recharge, ['data']] }
  ]);
  const plan = await inspectWorkbookImportPlan([file, file]);
  assert.equal(plan.physicalFiles.length, 1);
  assert.deepEqual(plan.sources.map((s) => s.status), ['ready', 'unrecognized', 'empty', 'ready', 'ready']);
  assert.deepEqual(plan.sources.map((s) => s.visibility), ['hidden', 'visible', 'visible', 'veryHidden', 'visible']);
  const dto = JSON.stringify(publicImportPlan(plan));
  assert.equal(dto.includes(path.dirname(file)), false);
  assert.equal(dto.includes(plan.physicalFiles[0].sha256), false);
  const request = { planId: plan.planId, subjectBySourceId: {}, excludedSheetIds: [] };
  assert.throws(() => resolveImportPlan(plan, request), { code: 'vcc-sheet-unrecognized' });
  request.excludedSheetIds.push(plan.sources[1].sourceId);
  assert.throws(() => resolveImportPlan(plan, request), { code: 'vcc-sheet-subject-required' });
  request.subjectBySourceId[plan.sources[0].sourceId] = '甲';
  request.subjectBySourceId[plan.sources[3].sourceId] = '乙';
  const files = resolveImportPlan(plan, request);
  assert.equal(files.length, 1);
  assert.deepEqual(files[0].sheets.map((s) => s.subject), ['甲', '乙', undefined]);
  assert.throws(() => resolveImportPlan(plan, { ...request, excludedSheetIds: [plan.sources[0].sourceId] }), { code: 'vcc-import-plan-invalid' });
  await revalidateImportPlan(plan);
  fs.appendFileSync(file, 'changed');
  await assert.rejects(revalidateImportPlan(plan), { code: 'vcc-import-plan-stale' });
});

test('预览范围之后的第二表块也在提交前被发现，坏表不能通过排除绕过', async (t) => {
  const rows = [recharge, ...Array.from({ length: 250 }, () => ['data']), recharge];
  const file = workbookFile(t, [{ name: '明细', rows }]);
  const plan = await inspectWorkbookImportPlan([file]);
  assert.equal(plan.sources[0].status, 'invalid');
  assert.equal(plan.sources[0].diagnostics[0].code, 'vcc-sheet-ambiguous');
  assert.equal(plan.sources[0].diagnostics[0].row, 252);
  assert.throws(() => resolveImportPlan(plan, { planId: plan.planId, subjectBySourceId: {}, excludedSheetIds: [] }), { code: 'vcc-sheet-ambiguous' });
  assert.throws(() => resolveImportPlan(plan, { planId: plan.planId, subjectBySourceId: {}, excludedSheetIds: [plan.sources[0].sourceId] }), { code: 'vcc-import-plan-invalid' });
});

// v3.2.15 B42：两张原表的当前结构完全相同（如 v3.2.14 恢复默认未核对同组冲突时留下的状态），
//   该表头不再按规则顺序静默识别为第一项，整份计划拒绝并列出候选。
test('多张原表当前结构与表头完全相同时拒绝识别，不静默取第一项', async (t) => {
  const structures = { [SOURCE_TYPES.FEE_FX]: { headers: recharge, versionLabel: 'V2' } };
  const evidence = classifyHeaderRow(recharge, headerRulesFor(structures));
  assert.equal(evidence.status, 'invalid');
  assert.equal(evidence.code, 'vcc-sheet-header-ambiguous');
  assert.equal(evidence.sourceType, undefined, '不给出来源类型');
  assert.deepEqual(evidence.candidates.map((candidate) => candidate.sourceType), [SOURCE_TYPES.RECHARGE, SOURCE_TYPES.FEE_FX]);
  assert.match(evidence.message, /^表头与「[^」]+」、「[^」]+」的当前结构完全相同，无法确定来源；请在 设置 → 模板文件 调整其中一张表的当前版本$/);
  assert.equal(evidence.detailLines.length, 2);
  assert.match(evidence.detailLines[0], /：内置结构$/);
  assert.match(evidence.detailLines[1], /：当前版本 V2$/);

  const file = workbookFile(t, [{ name: '明细', rows: [recharge, ['data']] }]);
  const plan = await inspectWorkbookImportPlan([file], { sourceStructures: structures });
  assert.equal(plan.sources[0].status, 'invalid');
  assert.equal(plan.sources[0].sourceType, undefined);
  assert.equal(plan.sources[0].diagnostics[0].code, 'vcc-sheet-header-ambiguous');
  assert.throws(() => resolveImportPlan(plan, { planId: plan.planId, subjectBySourceId: {}, excludedSheetIds: [] }), (error) => {
    assert.equal(error.code, 'vcc-sheet-header-ambiguous');
    assert.ok(error.detailLines.some((line) => /当前版本 V2/.test(line)), JSON.stringify(error.detailLines));
    return true;
  });
});

test('内置五类原表的表头两两不同，内置结构下不会多重命中', () => {
  for (const rule of HEADER_RULES) {
    assert.equal(classifyHeaderRow(rule.headers).status, 'ready', rule.sourceType);
  }
});

test('同名物理文件不合并，排除说明后没有业务 Sheet 时不创建任务', async (t) => {
  const first = workbookFile(t, [{ name: '说明', rows: [['说明']] }], 'same.xlsx');
  const second = workbookFile(t, [{ name: '空白', rows: [] }], 'same.xlsx');
  const plan = await inspectWorkbookImportPlan([first, second]);
  assert.equal(plan.physicalFiles.length, 2);
  assert.notEqual(plan.physicalFiles[0].physicalFileId, plan.physicalFiles[1].physicalFileId);
  assert.throws(() => resolveImportPlan(plan, { planId: plan.planId, subjectBySourceId: {},
    excludedSheetIds: [plan.sources[0].sourceId] }), { code: 'vcc-import-plan-empty' });
});

test('显式 Sheet 定位可共用读取上下文，保留真实行号且不读取另一张同类型表', async (t) => {
  const file = workbookFile(t, [
    { name: '甲', rows: [recharge, ['甲数据']] },
    { name: '乙', rows: [[], recharge, ['乙数据']] }
  ]);
  const workbook = await openWorkbookSheets(file);
  try {
    const rows = [];
    await streamDetailRows(file, SOURCE_TYPES.RECHARGE, { workbook, sheetName: '乙', sheetIndex: 1,
      headerRow: 2, onDataRow: (row) => rows.push(row) });
    assert.deepEqual(rows.map((r) => [r.sheetName, r.rowR, r.values[0]]), [['乙', 3, '乙数据']]);
    await assert.rejects(streamDetailRows(file, SOURCE_TYPES.RECHARGE, { workbook, sheetName: '乙', sheetIndex: 0,
      headerRow: 2, onDataRow: () => {} }), /定位已变化/);
  } finally { await workbook.close(); }
});
