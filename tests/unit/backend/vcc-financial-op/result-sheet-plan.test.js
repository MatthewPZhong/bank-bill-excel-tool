'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createResultWorkbookSheetPlan, quoteSheetName } = require('../../../../src/backend/vcc-financial-op/result-sheet-plan');

test('正式结果只规划一个 artifact，保留原始身份和主表在前的稳定顺序', () => {
  const subjects = ['甲主体', '乙主体'];
  const plan = createResultWorkbookSheetPlan({ subjects, runId: 7, resultRevision: 2, inputFingerprint: 'fixture' });
  assert.equal(plan.artifactCount, 1); assert.equal(plan.subjectCount, 2); assert.equal(plan.sheetCount, 4);
  assert.deepEqual(plan.subjectOrder, subjects);
  assert.deepEqual(plan.sheets.map((sheet) => [sheet.kind, sheet.subject]), [
    ['result-main', '甲主体'], ['result-main', '乙主体'], ['result-pending', '甲主体'], ['result-pending', '乙主体']
  ]);
  assert.equal(plan.sheets[0].name, '甲主体-结果表');
  assert.equal(plan.sheets[2].name, '甲主体-移除归档Pending发生额计算表');
  assert.ok(Object.isFrozen(plan.sheets));
});

test('正式结果名称全局唯一且合法，清洗、截断、代理对和大小写不能合并主体身份', () => {
  const subjects = ['A/B', 'A?B', 'abc', 'ABC', "'逗,号'主体'", `很长${'😀主体'.repeat(20)}`, 'History', '[]:*?\\/\u0001'];
  const plan = createResultWorkbookSheetPlan({ subjects });
  assert.deepEqual(plan.subjectOrder, subjects);
  assert.equal(new Set(plan.sheets.map((sheet) => sheet.name.toUpperCase())).size, subjects.length * 2);
  for (const sheet of plan.sheets) {
    assert.ok(sheet.name.length <= 31); assert.doesNotMatch(sheet.name, /[\\/:*?\[\]\u0000-\u001f]/);
    assert.ok(sheet.name.isWellFormed()); assert.ok(!sheet.name.startsWith("'") && !sheet.name.endsWith("'"));
    assert.equal(sheet.subject, subjects[sheet.subjectIndex]);
  }
  assert.deepEqual(createResultWorkbookSheetPlan({ subjects }).sheets, plan.sheets);
  assert.equal(quoteSheetName("O'Brien,主体"), "'O''Brien,主体'");
});

test('正式结果单主体沿用同一命名规则，拒绝空/重复主体及越界预算', () => {
  const single = createResultWorkbookSheetPlan({ subjects: ['甲'] });
  assert.deepEqual(single.sheets.map((sheet) => sheet.name), ['甲-结果表', '甲-移除归档Pending发生额计算表']);
  for (const subjects of [[], [''], [' '], ['甲', '甲'], [null], ['\uD800']]) assert.throws(() => createResultWorkbookSheetPlan({ subjects }));
  assert.throws(() => createResultWorkbookSheetPlan({ subjects: ['甲', '乙'], maxSheets: 2 }), { code: 'vcc-result-export-resource-limit' });
});


test('Unicode 大写展开和 sigma 归一化碰撞仍分配稳定且独立的主体 Sheet', () => {
  const subjects = ['Straße', 'STRASSE', 'σ', 'ς', 'Σ', 'ﬀ', 'FF', 'ß', 'ẞ'];
  const plan = createResultWorkbookSheetPlan({ subjects });
  assert.deepEqual(plan.subjectOrder, subjects);
  assert.equal(new Set(plan.sheets.map((sheet) => sheet.name.toUpperCase())).size, subjects.length * 2);
  assert.equal(new Set(plan.sheets.map((sheet) => sheet.name.toLowerCase())).size, subjects.length * 2);
  for (const kind of ['result-main', 'result-pending']) {
    const sheets = plan.sheets.filter((sheet) => sheet.kind === kind);
    assert.deepEqual(sheets.map((sheet) => sheet.subject), subjects);
    for (const index of [1, 3, 4, 6, 8]) assert.match(sheets[index].name, /~[a-f0-9]{8}-/);
    assert.ok(sheets.every((sheet) => sheet.name.length <= 31 && sheet.name.isWellFormed()));
  }
  assert.deepEqual(createResultWorkbookSheetPlan({ subjects }).sheets, plan.sheets);
});
