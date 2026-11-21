'use strict';

// v3.2.21 原始账单预处理「跨 Sheet 回填」纯函数（spec：changes/v3.2.21/feat/cross-sheet-backfill/spec.md §3.2）：
//   配对值识别（按金额 / 按原值）、同值按物理顺序一对一、只填空单元格、日期按来源日期格式解析后写 yyyy-mm-dd、
//   币种补本 sheet 唯一值、跳过原因、日期区间提示、规则校验。

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  CROSS_SHEET_BACKFILL_MISSING_MESSAGE,
  applyCrossSheetBackfill,
  collectCrossSheetBackfillMainFields,
  hasCrossSheetBackfillSettings,
  normalizeCrossSheetBackfillRule,
  parseAmountCents,
  validateCrossSheetBackfillRule
} = require('../../../../src/backend/file-service/cross-sheet-backfill');

const MAIN_HEADERS = ['ValueDate', 'Channel', 'Currency', 'Credit Amount', 'Debit Amount', 'Balance', 'Channel OrderNo', 'Transaction Description'];
const SOURCE_HEADERS = ['ValueDate', 'Channel', 'Currency', 'Credit Amount', 'Debit Amount', 'Transaction Description', 'Extra Information'];

function fxRule(overrides = {}) {
  return {
    sourceSheetName: 'USD',
    rowRules: [{ conditions: [{ field: 'ValueDate', op: '空值', value: '' }] }],
    matchMode: 'amount',
    matchField: 'Transaction Description',
    sourceMatchField: 'Credit Amount',
    sourceDateOrder: 'auto',
    backfillFields: [
      { targetField: 'ValueDate', sourceField: 'ValueDate' },
      { targetField: 'Channel', sourceField: 'Channel' },
      { targetField: 'Channel OrderNo', sourceField: 'Extra Information' }
    ],
    ...overrides
  };
}

function indexBy(headers) {
  return new Map(headers.map((header, index) => [header, index]));
}

function mainRow({ date = '', channel = 'ch', currency = 'NGN', credit = '', debit = '', balance = 0, orderNo = '', desc = '' }) {
  return [date, channel, currency, credit, debit, balance, orderNo, desc];
}

function sourceRow({ date = '', channel = 'src', currency = 'USD', credit = '', extra = '' }) {
  return [date, channel, currency, credit, '-', 'desc', extra];
}

function toIso(value) {
  const match = String(value || '').match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  return match ? `${match[3]}-${match[2]}-${match[1]}` : String(value || '');
}

function run({ rows, sourceRows, rule = fxRule(), currencyField = 'Currency', readCount = { value: 0 } }) {
  const allRows = [MAIN_HEADERS].concat(rows);
  return applyCrossSheetBackfill({
    rows: allRows,
    rowNumbers: allRows.map((_row, index) => index + 1),
    sourceIndexByField: indexBy(MAIN_HEADERS),
    rule: normalizeCrossSheetBackfillRule(rule),
    readSourceSheet(sheetName) {
      readCount.value += 1;
      assert.equal(sheetName, 'USD');
      const all = [SOURCE_HEADERS].concat(sourceRows);
      return { rows: all, rowNumbers: all.map((_row, index) => index + 1) };
    },
    dateTargetFields: new Set(['ValueDate']),
    billDateFields: new Set(['ValueDate']),
    currencyField,
    // 主表日期为 dd/mm/yyyy 文本；回填后为 yyyy-mm-dd
    resolveRowBillDate: (row) => toIso(row[0])
  });
}

test('parseAmountCents：数值、单个数字、千分位、多个数字取紧跟币种标记的那个', () => {
  assert.equal(parseAmountCents(65.45), 6545);
  assert.equal(parseAmountCents(-65.45), 6545);
  assert.equal(parseAmountCents('Trade - $65.45'), 6545);
  assert.equal(parseAmountCents('Trade - $1,234,567.8'), 123456780);
  assert.equal(parseAmountCents('65.45'), 6545);
  assert.equal(parseAmountCents('Trade 2 - $65.45'), 6545);
  assert.equal(parseAmountCents('Trade 2 - USD 65.45'), 6545);
  assert.equal(parseAmountCents('Trade 2 - 65.45 USD'), 6545);
  assert.equal(parseAmountCents('Trade 2 - 65.45'), null, '多个数字且没有币种标记时有歧义');
  assert.equal(parseAmountCents('Trade'), null);
  assert.equal(parseAmountCents(''), null);
  assert.equal(parseAmountCents(null), null);
});

test('换汇样例：按金额配对后回填日期、渠道、流水号并补本 sheet 币种，日期为真 Excel 日期', () => {
  const result = run({
    rows: [
      mainRow({ date: 'OPENING BALANCE', channel: '-', currency: 'NGN' }),
      mainRow({ date: '18/09/2026', credit: 20000, balance: 20000, orderNo: 'LB001', desc: 'x' }),
      mainRow({ date: '', channel: '', currency: '', debit: 90000, balance: 0, desc: 'Trade - $65.45' }),
      mainRow({ date: '29/09/2026', credit: 100, balance: 100, orderNo: 'LB004', desc: 'x' })
    ],
    sourceRows: [sourceRow({ date: 46291, channel: 'abcdef', credit: 65.45, extra: 1234 })]
  });
  assert.equal(result.enabled, true);
  assert.deepEqual(result.stats, { targetRows: 1, backfilledRows: 1, skippedRows: 0 });
  assert.deepEqual(result.rowNumbers, [1, 2, 3, 4, 5]);
  assert.deepEqual(result.rows[3], ['2026-09-26', 'abcdef', 'NGN', '', 90000, 0, 1234, 'Trade - $65.45']);
  assert.deepEqual(result.issues, [], '26/09 落在 18/09 与 29/09 之间，不提示');
  assert.equal(result.patches.length, 1);
  assert.equal(result.patches[0].rowNumber, 4);
  assert.equal(result.patches[0].sourceRowNumber, 2);
  assert.deepEqual(result.patches[0].cells.map((cell) => [cell.field, cell.value, cell.kind]), [
    ['Currency', 'NGN', 'value'],
    ['ValueDate', '2026-09-26', 'date'],
    ['Channel', 'abcdef', 'value'],
    ['Channel OrderNo', 1234, 'value']
  ]);
});

test('同金额多笔按物理顺序一对一，配上即消耗；追加新行后已有配对不变', () => {
  const rows = [
    mainRow({ date: '01/09/2026', credit: 1, desc: 'x' }),
    mainRow({ date: '', debit: 100, desc: 'Trade - $10.00' }),
    mainRow({ date: '', debit: 200, desc: 'Trade - $10.00' }),
    mainRow({ date: '30/09/2026', credit: 1, desc: 'x' })
  ];
  const source = [
    sourceRow({ date: '09/05/2026', credit: 10, extra: 'A' }),
    sourceRow({ date: '09/06/2026', credit: 10, extra: 'B' })
  ];
  const rule = fxRule({ sourceDateOrder: 'MDY' });
  const first = run({ rows, sourceRows: source, rule });
  assert.deepEqual(first.rows.slice(2, 4).map((row) => [row[0], row[6]]), [['2026-09-05', 'A'], ['2026-09-06', 'B']]);

  const appended = run({
    rows: rows.concat([mainRow({ date: '', debit: 300, desc: 'Trade - $10.00' })]),
    sourceRows: source.concat([sourceRow({ date: '10/01/2026', credit: 10, extra: 'C' })]),
    rule
  });
  assert.deepEqual(appended.rows.slice(2, 4).map((row) => [row[0], row[6]]), [['2026-09-05', 'A'], ['2026-09-06', 'B']]);
  assert.deepEqual([appended.rows[5][0], appended.rows[5][6]], ['2026-10-01', 'C']);
  assert.deepEqual(appended.issues, [], '末尾追加行只有前一行可比：本表正序，10/01 不早于 30/09，不提示');
});

test('配不上 / 识别不出配对值：只跳过该行并记录原因，其余行照常', () => {
  const result = run({
    rows: [
      mainRow({ date: '', debit: 100, desc: 'Trade - $99.99' }),
      mainRow({ date: '', debit: 100, desc: 'Trade' }),
      mainRow({ date: '05/09/2026', credit: 1, desc: 'x' })
    ],
    sourceRows: [sourceRow({ date: 46291, credit: 65.45 })]
  });
  assert.deepEqual(result.rowNumbers, [1, 4]);
  assert.deepEqual(result.stats, { targetRows: 2, backfilledRows: 0, skippedRows: 2 });
  assert.deepEqual(result.issues.map((issue) => [issue.type, issue.rowNumber, issue.reason, issue.matchValue]), [
    ['cross-sheet-backfill-skipped', 2, 'no-source-row', 'Trade - $99.99'],
    ['cross-sheet-backfill-skipped', 3, 'match-value-missing', 'Trade']
  ]);
  assert.equal(result.issues[0].matchKey, '99.99');
});

test('只填空单元格，不覆盖银行原值；来源值为空的非日期字段不写', () => {
  const result = run({
    rows: [mainRow({ date: '', channel: 'BANK', currency: 'NGN', debit: 100, desc: 'Trade - $65.45' })],
    sourceRows: [sourceRow({ date: 46291, channel: 'abcdef', credit: 65.45, extra: '' })]
  });
  assert.deepEqual(result.rows[1].slice(0, 3), ['2026-09-26', 'BANK', 'NGN']);
  assert.equal(result.rows[1][6], '');
  assert.deepEqual(result.patches[0].cells.map((cell) => cell.field), ['ValueDate']);
});

test('来源日期格式：mm/dd/yyyy 文本按月在前解析（含日 ≤ 12），无法识别时跳过', () => {
  const mdy = run({
    rows: [mainRow({ date: '', debit: 100, desc: 'Trade - $1.00' })],
    sourceRows: [sourceRow({ date: '09/10/2026', credit: 1 })],
    rule: fxRule({ sourceDateOrder: 'MDY' })
  });
  assert.equal(mdy.rows[1][0], '2026-09-10');

  const dmy = run({
    rows: [mainRow({ date: '', debit: 100, desc: 'Trade - $1.00' })],
    sourceRows: [sourceRow({ date: '09/10/2026', credit: 1 })],
    rule: fxRule({ sourceDateOrder: 'DMY' })
  });
  assert.equal(dmy.rows[1][0], '2026-10-09');

  const invalid = run({
    rows: [mainRow({ date: '', debit: 100, desc: 'Trade - $1.00' })],
    sourceRows: [sourceRow({ date: 'n/a', credit: 1 })]
  });
  assert.deepEqual(invalid.rowNumbers, [1]);
  assert.equal(invalid.issues[0].reason, 'source-date-invalid');
  assert.equal(invalid.issues[0].sourceRowNumber, 2);
});

test('币种：非待回填行币种不唯一或没有时跳过；不传币种列时不补', () => {
  const mixed = run({
    rows: [
      mainRow({ date: '01/09/2026', currency: 'NGN', credit: 1, desc: 'x' }),
      mainRow({ date: '02/09/2026', currency: 'USD', credit: 1, desc: 'x' }),
      mainRow({ date: '', currency: '', debit: 100, desc: 'Trade - $1.00' })
    ],
    sourceRows: [sourceRow({ date: 46291, credit: 1 })]
  });
  assert.equal(mixed.issues[0].reason, 'currency-undetermined');
  assert.deepEqual(mixed.rowNumbers, [1, 2, 3]);

  const noCurrencyField = run({
    rows: [mainRow({ date: '', currency: '', debit: 100, desc: 'Trade - $1.00' })],
    sourceRows: [sourceRow({ date: 46291, credit: 1 })],
    currencyField: ''
  });
  assert.equal(noCurrencyField.rows[1][2], '');
  assert.equal(noCurrencyField.stats.backfilledRows, 1);
});

test('日期区间提示：正序、倒序、端点相等与只有一侧', () => {
  const descending = run({
    rows: [
      mainRow({ date: '29/09/2026', credit: 1, desc: 'x' }),
      mainRow({ date: '', debit: 100, desc: 'Trade - $1.00' }),
      mainRow({ date: '18/09/2026', credit: 1, desc: 'x' })
    ],
    sourceRows: [sourceRow({ date: 46291, credit: 1 })]
  });
  assert.equal(descending.issues.length, 0);

  const equalBound = run({
    rows: [
      mainRow({ date: '26/09/2026', credit: 1, desc: 'x' }),
      mainRow({ date: '', debit: 100, desc: 'Trade - $1.00' })
    ],
    sourceRows: [sourceRow({ date: 46291, credit: 1 })]
  });
  assert.equal(equalBound.issues.length, 0);

  const outside = run({
    rows: [
      mainRow({ date: '01/09/2026', credit: 1, desc: 'x' }),
      mainRow({ date: '', debit: 100, desc: 'Trade - $1.00' }),
      mainRow({ date: '10/09/2026', credit: 1, desc: 'x' })
    ],
    sourceRows: [sourceRow({ date: 46291, credit: 1 })]
  });
  assert.deepEqual(outside.issues, [{
    type: 'cross-sheet-backfill-date-out-of-range',
    rowNumber: 3,
    date: '2026-09-26',
    prevDate: '2026-09-01',
    nextDate: '2026-09-10'
  }]);
  assert.equal(outside.rows.length, 4, '区间外的行照常输出');

  const oneSideAscending = run({
    rows: [
      mainRow({ date: '01/09/2026', credit: 1, desc: 'x' }),
      mainRow({ date: '30/09/2026', credit: 1, desc: 'x' }),
      mainRow({ date: '', debit: 100, desc: 'Trade - $1.00' })
    ],
    sourceRows: [sourceRow({ date: 46291, credit: 1 })]
  });
  assert.deepEqual(oneSideAscending.issues.map((issue) => [issue.rowNumber, issue.prevDate, issue.nextDate]), [[4, '2026-09-30', '']],
    '本表正序、只有前一行时，早于前一行的日期提示');

  const oneSideUnknownOrder = run({
    rows: [
      mainRow({ date: '30/09/2026', credit: 1, desc: 'x' }),
      mainRow({ date: '', debit: 100, desc: 'Trade - $1.00' })
    ],
    sourceRows: [sourceRow({ date: 46291, credit: 1 })]
  });
  assert.equal(oneSideUnknownOrder.issues.length, 0, '只有一个有效日期、无法判断顺序时不提示');
});

test('按原值配对：去首尾空白后完全相等', () => {
  const result = run({
    rows: [mainRow({ date: '', debit: 100, orderNo: '', desc: ' REF-001 ' })],
    sourceRows: [sourceRow({ date: 46291, credit: 1, extra: 'REF-001' })],
    rule: fxRule({
      matchMode: 'exact',
      sourceMatchField: 'Extra Information',
      backfillFields: [{ targetField: 'ValueDate', sourceField: 'ValueDate' }]
    })
  });
  assert.equal(result.rows[1][0], '2026-09-26');
});

test('没有待回填行时不读来源 sheet、不改动任何行', () => {
  const readCount = { value: 0 };
  const rows = [mainRow({ date: '01/09/2026', credit: 1, desc: 'x' })];
  const result = run({ rows, sourceRows: [], readCount });
  assert.equal(readCount.value, 0);
  assert.deepEqual(result.stats, { targetRows: 0, backfilledRows: 0, skippedRows: 0 });
  assert.equal(result.rows[1], rows[0]);
});

test('来源 sheet 缺字段、主表缺字段时拒绝', () => {
  assert.throws(() => run({
    rows: [mainRow({ date: '', debit: 100, desc: 'Trade - $1.00' })],
    sourceRows: [],
    rule: fxRule({ backfillFields: [{ targetField: 'ValueDate', sourceField: 'Posting Date' }] })
  }), /来源 Sheet「USD」中没有同时包含「Credit Amount」「Posting Date」的表头行/);
  assert.throws(() => run({
    rows: [mainRow({ date: '', debit: 100, desc: 'Trade - $1.00' })],
    sourceRows: [],
    rule: fxRule({ matchField: 'Narrative' })
  }), /映射字段不存在：Narrative/);
});

test('规则校验：必填、表头、重复目标、禁止目标列', () => {
  assert.throws(() => validateCrossSheetBackfillRule(null, MAIN_HEADERS), { message: CROSS_SHEET_BACKFILL_MISSING_MESSAGE });
  assert.throws(() => validateCrossSheetBackfillRule({}, MAIN_HEADERS), { message: CROSS_SHEET_BACKFILL_MISSING_MESSAGE });
  assert.throws(() => validateCrossSheetBackfillRule(fxRule({ sourceSheetName: '' }), MAIN_HEADERS), /请填写来源 Sheet 名/);
  assert.throws(() => validateCrossSheetBackfillRule(fxRule({ rowRules: [] }), MAIN_HEADERS), /请至少设置一条待回填行条件/);
  assert.throws(
    () => validateCrossSheetBackfillRule(fxRule({ rowRules: [{ conditions: [{ field: '', op: '等于', value: 'x' }] }] }), MAIN_HEADERS),
    /跨 Sheet 回填：待回填行条件 #1 第 1 个条件：请选择字段/
  );
  assert.throws(() => validateCrossSheetBackfillRule(fxRule({ sourceMatchField: '' }), MAIN_HEADERS), /请填写来源配对字段/);
  assert.throws(() => validateCrossSheetBackfillRule(fxRule({ backfillFields: [] }), MAIN_HEADERS), /请至少设置一个回填字段/);
  assert.throws(() => validateCrossSheetBackfillRule(fxRule({
    backfillFields: [{ targetField: 'ValueDate', sourceField: 'ValueDate' }, { targetField: 'ValueDate', sourceField: 'Channel' }]
  }), MAIN_HEADERS), /本表字段「ValueDate」重复设置/);
  assert.throws(() => validateCrossSheetBackfillRule(fxRule({
    backfillFields: [{ targetField: 'Debit Amount', sourceField: 'Credit Amount' }]
  }), MAIN_HEADERS, { excludedTargetFields: ['Credit Amount', 'Debit Amount', 'Balance', 'Currency'] }), /「Debit Amount」用于发生额、余额、币种或账户映射，不能作为回填字段/);
  assert.throws(() => validateCrossSheetBackfillRule(fxRule({
    backfillFields: [{ targetField: 'Remark', sourceField: 'Channel' }]
  }), MAIN_HEADERS), /映射字段不存在：Remark/);
  const valid = validateCrossSheetBackfillRule(JSON.stringify(fxRule()), MAIN_HEADERS);
  assert.equal(valid.rowRules[0].seq, 1);
});

test('规范化与辅助函数：未知取值回落默认、空设置识别、本表引用字段', () => {
  const normalized = normalizeCrossSheetBackfillRule({ ...fxRule(), matchMode: 'x', sourceDateOrder: 'YMD' });
  assert.equal(normalized.matchMode, 'amount');
  assert.equal(normalized.sourceDateOrder, 'auto');
  assert.equal(normalizeCrossSheetBackfillRule('not json'), null);
  assert.equal(normalizeCrossSheetBackfillRule(''), null);
  assert.equal(hasCrossSheetBackfillSettings({ matchMode: 'amount' }), false);
  assert.equal(hasCrossSheetBackfillSettings(fxRule()), true);
  assert.deepEqual(collectCrossSheetBackfillMainFields(fxRule()), ['ValueDate', 'Transaction Description', 'Channel', 'Channel OrderNo']);
});
