// v3.0.5 OPEN-7（T5b-2 出口②预留）单测：writeBankStatementOutput 第 7 参 staleHitNotesByRowId
//   🔴 资金红线 parity：传空/不传时主对账链「命中明细」golden 字节不变（本批 main 即不传——
//      主对账链无入金表来源命中，注入仅为 refund-backfill 阶段预留）。
//   传含提醒的 Map 时：对应 rowId 行 append「\n+提醒」不覆盖原命中明细；无该 rowId 的行不变。
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ExcelJS = require('exceljs');
const {
  writeBankStatementOutput,
  SHEET2_HIT_NAME,
  HIT_DETAIL_HEADER
} = require('../../../src/main-process/exceljs-writer');

function tmpFile(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'open7-out2-'));
  return path.join(dir, name);
}

// 公共夹具：2 命中行（r1 有 modification 产命中明细 / r2 无 → 命中明细空串）。
const HEADERS = ['MerchantId', 'FundType', 'Amount'];
const MODIFIED_ROWS = [
  { MerchantId: 'm1', FundType: 'x', Amount: '0', _rowId: 'r1', _modifiedColumns: new Set(['FundType']) },
  { MerchantId: 'm2', FundType: 'y', Amount: '0', _rowId: 'r2', _modifiedColumns: new Set() }
];
const MODIFICATIONS = [
  { rowId: 'r1', column: 'FundType', oldValue: 'old', newValue: 'x', scenarioName: '场景1' }
];
const EXPECTED_R1_DETAIL = '<命中场景:"场景1";"FundType";变更前:"old";变更后:"x">';

async function readHitDetailColumn(out) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(out);
  const s2 = wb.getWorksheet(SHEET2_HIT_NAME);
  // 第 1 列「命中明细」第 2/3 行（表头第 1 行 → 数据从第 2 行）
  return {
    header: s2.getCell(1, 1).value,
    r1Detail: s2.getCell(2, 1).value,
    r2Detail: s2.getCell(3, 1).value,
    // 原数据右移 1 校验仍在第 2 列（parity：列布局不变）
    r1Merchant: s2.getCell(2, 2).value
  };
}

// ===== parity-1：不传第 7 参 → 命中明细字节与基线一致（向后兼容旧 caller）=====
test('OPEN-7 出口②：不传 staleHitNotesByRowId → 命中明细字节不变', async () => {
  const out = tmpFile('no-arg.xlsx');
  await writeBankStatementOutput(MODIFIED_ROWS, HEADERS, out, [], MODIFICATIONS);
  const got = await readHitDetailColumn(out);
  assert.strictEqual(got.header, HIT_DETAIL_HEADER, '第1列表头=命中明细');
  assert.strictEqual(got.r1Detail, EXPECTED_R1_DETAIL, 'r1 命中明细 = 基线（无提醒污染）');
  assert.strictEqual(got.r2Detail, '', 'r2 无 modification → 命中明细空串（不变）');
  assert.strictEqual(got.r1Merchant, 'm1', '原数据列布局不变（右移1）');
});

// ===== parity-2：传 null / 空 Map → 同样字节不变（main 本批传 null 的等价路径）=====
test('OPEN-7 出口②：传 null → 命中明细字节不变', async () => {
  const out = tmpFile('null-arg.xlsx');
  await writeBankStatementOutput(MODIFIED_ROWS, HEADERS, out, [], MODIFICATIONS, null, null);
  const got = await readHitDetailColumn(out);
  assert.strictEqual(got.r1Detail, EXPECTED_R1_DETAIL, 'r1 = 基线');
  assert.strictEqual(got.r2Detail, '', 'r2 空串');
});

test('OPEN-7 出口②：传空 Map → 命中明细字节不变', async () => {
  const out = tmpFile('empty-map.xlsx');
  await writeBankStatementOutput(MODIFIED_ROWS, HEADERS, out, [], MODIFICATIONS, null, new Map());
  const got = await readHitDetailColumn(out);
  assert.strictEqual(got.r1Detail, EXPECTED_R1_DETAIL, 'r1 = 基线');
  assert.strictEqual(got.r2Detail, '', 'r2 空串');
});

// ===== 注入语义：传含提醒 Map → 对应行 append \n+提醒 不覆盖；无该 rowId 行不变 =====
test('OPEN-7 出口②：含提醒 Map → r1 append 不覆盖原命中明细 + r2 不受影响', async () => {
  const reminder = '⚠️ 桥接入金表行 BizId=DEP001 此前于 [2026-06-01T00:00:00Z] 已被命中，疑似历史残留';
  const noteMap = new Map([['r1', reminder]]);
  const out = tmpFile('with-note.xlsx');
  await writeBankStatementOutput(MODIFIED_ROWS, HEADERS, out, [], MODIFICATIONS, null, noteMap);
  const got = await readHitDetailColumn(out);
  // r1：原 detail + \n + 提醒（append 不覆盖）
  assert.strictEqual(
    got.r1Detail,
    EXPECTED_R1_DETAIL + '\n' + reminder,
    'r1 命中明细 = 原 detail + 换行 + 提醒（不覆盖）'
  );
  // r2：noteMap 无 r2 → 不变（仍空串）
  assert.strictEqual(got.r2Detail, '', 'r2 不在 noteMap → 命中明细不变');
});

// ===== 边界：原命中明细为空串的行也能注入提醒（detail ? ... : note 分支）=====
test('OPEN-7 出口②：原命中明细空串的行注入提醒 → 直接为提醒串（无前导换行）', async () => {
  const reminder = '⚠️ 桥接入金表行 BizId=DEP002 此前于 [t] 已被命中，疑似历史残留';
  const noteMap = new Map([['r2', reminder]]); // r2 无 modification → 原 detail 空串
  const out = tmpFile('empty-detail-note.xlsx');
  await writeBankStatementOutput(MODIFIED_ROWS, HEADERS, out, [], MODIFICATIONS, null, noteMap);
  const got = await readHitDetailColumn(out);
  assert.strictEqual(got.r1Detail, EXPECTED_R1_DETAIL, 'r1 不在 noteMap → 不变');
  assert.strictEqual(got.r2Detail, reminder, 'r2 原空串 → 直接为提醒串（无前导 \\n）');
});
