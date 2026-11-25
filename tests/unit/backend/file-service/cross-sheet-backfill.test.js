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
  createUnwritableCellLookup,
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

// ---- v3.2.21 审查回归（第一轮）----

function runWith(rows, sourceRows, options = {}) {
  const allRows = [MAIN_HEADERS].concat(rows);
  return applyCrossSheetBackfill({
    rows: allRows,
    rowNumbers: allRows.map((_row, index) => index + 1),
    sourceIndexByField: indexBy(MAIN_HEADERS),
    rule: normalizeCrossSheetBackfillRule(options.rule || fxRule()),
    readSourceSheet: () => {
      const all = [SOURCE_HEADERS].concat(sourceRows);
      return { rows: all, rowNumbers: all.map((_row, index) => index + 1) };
    },
    dateTargetFields: new Set(['ValueDate']),
    billDateFields: new Set(['ValueDate']),
    currencyField: 'Currency',
    resolveRowBillDate: (row) => toIso(row[0]),
    ...options.extra
  });
}

test('parseAmountCents：按十进制四舍五入到分（不经二进制浮点）', () => {
  assert.equal(parseAmountCents(1.005), 101);
  assert.equal(parseAmountCents(-1.005), 101);
  assert.equal(parseAmountCents(1.004), 100);
  assert.equal(parseAmountCents('1.005'), 101);
  assert.equal(parseAmountCents('$0.125'), 13);
  assert.equal(parseAmountCents(1e-7), 0);
  assert.equal(parseAmountCents(1e21), null);
});

test('parseAmountCents：只认币种代码集合中的代码，片段须是完整金额写法', () => {
  assert.equal(parseAmountCents('REF 123: 65.45'), null, 'REF 不是币种代码，两个数字有歧义');
  assert.equal(parseAmountCents('REF 123: $65.45'), 6545);
  assert.equal(parseAmountCents('$.50'), null, '.50 不是完整金额写法，不取其中的 50');
  assert.equal(parseAmountCents('Trade $1.2.3'), null);
  assert.equal(parseAmountCents('Trade 1.234,56'), null);
  assert.equal(parseAmountCents('Trade - $65.45.'), 6545, '句末标点不属于金额');
  assert.equal(parseAmountCents('ABC 5 - 65.45 XYZ'), null, '默认代码集合没有 XYZ');
  assert.equal(parseAmountCents('ABC 5 - 65.45 XYZ', { currencyCodes: ['xyz'] }), 6545, '调用方传入的代码（不区分大小写）');
  assert.equal(parseAmountCents('USD 5 - 65.45 XYZ', { currencyCodes: ['XYZ'] }), 6545, '传入集合时只认集合中的代码');
});

test('来源日期：不存在的日期不滚入下月、统一写 yyyy-mm-dd、数值按工作簿日期系统换算', () => {
  const result = runWith([
    mainRow({ date: '18/09/2026', credit: 1, orderNo: 'A', desc: 'x' }),
    mainRow({ date: '', currency: '', debit: 1, desc: 'Trade - $1.00' }),
    mainRow({ date: '', currency: '', debit: 2, desc: 'Trade - $2.00' }),
    mainRow({ date: '30/09/2026', credit: 1, orderNo: 'B', desc: 'x' })
  ], [sourceRow({ date: '02/30/2026', credit: 1 }), sourceRow({ date: '2026/09/20', credit: 2 })], {
    rule: fxRule({ sourceDateOrder: 'MDY' })
  });
  assert.deepEqual(result.issues.map((issue) => [issue.rowNumber, issue.reason]), [[3, 'source-date-invalid']]);
  assert.equal(result.rows[2][0], '2026-09-20', 'yyyy/mm/dd 来源日期也写成 yyyy-mm-dd');
  assert.equal(result.patches[0].cells.find((cell) => cell.kind === 'date').value, '2026-09-20');

  const rows1904 = [
    mainRow({ date: '25/09/2026', credit: 1, desc: 'x' }),
    mainRow({ date: '', currency: '', debit: 1, desc: 'Trade - $1.00' }),
    mainRow({ date: '27/09/2026', credit: 1, desc: 'x' })
  ];
  const source1904 = [sourceRow({ date: 44829, credit: 1 })];
  assert.equal(runWith(rows1904, source1904, { extra: { excelDateSystem: '1904' } }).rows[2][0], '2026-09-26',
    '1904 工作簿的序号 44829 是 2026-09-26');
  assert.equal(runWith(rows1904, source1904).rows[2][0], '2022-09-25');
});

test('只有待回填行参与配对：已有值的行（含再导入时已回填的行）按普通行处理，不消耗来源行', () => {
  const sourceRows = [sourceRow({ date: '26/09/2026', channel: 'S1', credit: 65.45, extra: 'E1' })];
  // 已有日期、金额与来源行相同的普通交易不改变待回填行的配对（首次导入的配对只由待回填行决定）
  const dated = runWith([
    mainRow({ date: '26/09/2026', channel: 'S1', currency: 'NGN', debit: 1, orderNo: 'E1', desc: 'Trade - $65.45' }),
    mainRow({ date: '', channel: '', currency: '', debit: 2, desc: 'Trade - $65.45' }),
    mainRow({ date: '30/09/2026', credit: 1, desc: 'x' })
  ], sourceRows);
  assert.equal(dated.stats.targetRows, 1);
  assert.deepEqual(dated.issues, []);
  assert.deepEqual(dated.patches.map((patch) => [patch.rowNumber, patch.sourceRowNumber]), [[3, 2]]);
});

test('读成空值的错误值 / 没有结果的公式不按空单元格回填，跳过该行；issues 带源文件名', () => {
  const result = runWith([
    mainRow({ date: '25/09/2026', credit: 1, desc: 'x' }),
    mainRow({ date: '', channel: '', currency: '', debit: 1, desc: 'Trade - $1.00' }),
    mainRow({ date: '', channel: '', currency: '', debit: 2, desc: 'Trade - $2.00' })
  ], [sourceRow({ date: '26/09/2026', credit: 1 }), sourceRow({ date: '27/09/2026', credit: 2 })], {
    extra: {
      // 第 3 行的日期格是错误值，第 4 行的币种格是没有结果的公式
      isUnreadableCell: (rowNumber, columnIndex) => (rowNumber === 3 && columnIndex === 0) || (rowNumber === 4 && columnIndex === 2),
      sourceFileName: 'Statement.xlsx'
    }
  });
  assert.deepEqual(result.issues.map((issue) => [issue.rowNumber, issue.reason, issue.sourceRowNumber, issue.sourceFileName]), [
    [3, 'target-cell-unreadable', 2, 'Statement.xlsx'],
    [4, 'target-cell-unreadable', 3, 'Statement.xlsx']
  ]);
  assert.deepEqual(result.patches, []);
  assert.deepEqual(result.skippedRows.map((item) => item.rowNumber), [3, 4]);
});

test('按行给出的映射口径：走拆分的行不补主映射币种，日期区间提示按该行的 BillDate 源列', () => {
  const headers = ['Date', 'SplitDate', 'Ccy', 'Path', 'Desc'];
  const allRows = [headers,
    ['2026-09-01', '2026-09-01', 'USD', 'split', 'x'],
    ['', '', '', 'split', 'Trade - $1.00'],
    ['2026-09-03', '2026-09-03', 'EUR', 'split', 'x']
  ];
  const result = applyCrossSheetBackfill({
    rows: allRows,
    rowNumbers: [1, 2, 3, 4],
    sourceIndexByField: indexBy(headers),
    rule: normalizeCrossSheetBackfillRule({
      sourceSheetName: 'USD',
      rowRules: [{ conditions: [{ field: 'SplitDate', op: '空值', value: '' }] }],
      matchMode: 'amount',
      matchField: 'Desc',
      sourceMatchField: 'Credit Amount',
      backfillFields: [{ targetField: 'SplitDate', sourceField: 'ValueDate' }]
    }),
    readSourceSheet: () => {
      const all = [SOURCE_HEADERS, sourceRow({ date: '01/12/2026', credit: 1 })];
      return { rows: all, rowNumbers: all.map((_row, index) => index + 1) };
    },
    dateTargetFields: new Set(['Date', 'SplitDate']),
    resolveRowContext: (row) => (row[3] === 'split'
      ? { currencyField: '', billDateFields: new Set(['SplitDate']) }
      : { currencyField: 'Ccy', billDateFields: new Set(['Date']) }),
    resolveRowBillDate: (row) => (row[3] === 'split' ? row[1] : row[0])
  });
  assert.deepEqual(result.issues.map((issue) => [issue.type, issue.rowNumber, issue.date]), [
    ['cross-sheet-backfill-date-out-of-range', 3, '2026-12-01']
  ], '不因主映射币种列不唯一而跳过；按拆分日期列提示越界');
  assert.deepEqual(result.rows[2], ['', '2026-12-01', '', 'split', 'Trade - $1.00']);
});

test('日期区间提示：连续多笔待回填行都跳过彼此，取两侧最近的非待回填行', () => {
  const rows = [mainRow({ date: '20/09/2026', credit: 1, desc: 'x' })];
  const sourceRows = [];
  for (let index = 1; index <= 5; index += 1) {
    rows.push(mainRow({ date: '', currency: '', debit: index, desc: `Trade - $${index}.00` }));
    sourceRows.push(sourceRow({ date: index === 3 ? '05/10/2026' : '25/09/2026', credit: index }));
  }
  rows.push(mainRow({ date: '30/09/2026', credit: 1, desc: 'x' }));
  const result = runWith(rows, sourceRows);
  assert.deepEqual(result.issues.map((issue) => [issue.rowNumber, issue.prevDate, issue.nextDate]), [
    [5, '2026-09-20', '2026-09-30']
  ]);
});

test('parseAmountCents：币种映射表中的非三字母代码（USDT）按完整的词识别，不在表中的不算', () => {
  const codes = ['USD', 'USDT', 'MOP'];
  assert.equal(parseAmountCents('REF 12; USDT 65.45', { currencyCodes: codes }), 6545);
  assert.equal(parseAmountCents('REF 12; MOP 65.45', { currencyCodes: codes }), 6545);
  assert.equal(parseAmountCents('REF 12; USDT 65.45', { currencyCodes: ['USD'] }), null);
  assert.equal(parseAmountCents('USDTX 12; USD 65.45', { currencyCodes: codes }), 6545);
});

// ---- v3.2.21 审查回归（第三轮）----

test('待回填行须至少有一个回填目标为空：命中条件但目标都已有值的行按普通行处理，不消耗来源行', () => {
  const result = runWith([
    mainRow({ date: '25/09/2026', debit: 1, desc: 'Trade - $65.45' }),
    mainRow({ date: '', debit: 2, desc: 'Trade - $65.45' }),
    mainRow({ date: '30/09/2026', credit: 1, desc: 'x' })
  ], [sourceRow({ date: '26/09/2026', credit: 65.45 })], {
    rule: fxRule({
      rowRules: [{ conditions: [{ field: 'Transaction Description', op: '包含', value: 'Trade' }] }],
      backfillFields: [{ targetField: 'ValueDate', sourceField: 'ValueDate' }]
    })
  });
  assert.equal(result.stats.targetRows, 1);
  assert.deepEqual(result.issues, []);
  assert.deepEqual(result.patches.map((patch) => [patch.rowNumber, patch.sourceRowNumber]), [[3, 2]]);
});

test('同一配对值的大组按物理顺序逐笔消耗（游标），多于来源的行跳过', () => {
  const count = 2000;
  const rows = Array.from({ length: count }, () => mainRow({ date: '', debit: 1, desc: 'Trade - $1.00' }));
  rows.push(mainRow({ date: '30/09/2026', credit: 1, desc: 'x' }));
  const sources = Array.from({ length: count - 1 }, (_value, index) => sourceRow({ date: '26/09/2026', credit: 1, extra: `E${index}` }));
  const result = runWith(rows, sources);
  assert.equal(result.patches.length, count - 1);
  assert.deepEqual([result.patches[0].sourceRowNumber, result.patches[count - 2].sourceRowNumber], [2, count]);
  assert.deepEqual(result.issues.filter((issue) => issue.type === 'cross-sheet-backfill-skipped').map((issue) => [issue.rowNumber, issue.reason]),
    [[count + 1, 'no-source-row']]);
});

test('来源 Sheet 名按原文保存与查找：保留首尾空格，只有全为空白时视为未填写', () => {
  assert.equal(normalizeCrossSheetBackfillRule(fxRule({ sourceSheetName: 'USD ' })).sourceSheetName, 'USD ');
  assert.equal(normalizeCrossSheetBackfillRule(fxRule({ sourceSheetName: '   ' })).sourceSheetName, '');
  assert.throws(() => validateCrossSheetBackfillRule(fxRule({ sourceSheetName: '  ' }), MAIN_HEADERS), /请填写来源 Sheet 名/);
  const requested = [];
  applyCrossSheetBackfill({
    rows: [MAIN_HEADERS, mainRow({ date: '', debit: 1, desc: 'Trade - $1.00' })],
    rowNumbers: [1, 2],
    sourceIndexByField: indexBy(MAIN_HEADERS),
    rule: normalizeCrossSheetBackfillRule(fxRule({ sourceSheetName: 'USD ' })),
    readSourceSheet: (name) => {
      requested.push(name);
      return { rows: [SOURCE_HEADERS, sourceRow({ date: '26/09/2026', credit: 1 })], rowNumbers: [1, 2] };
    },
    dateTargetFields: new Set(['ValueDate']),
    billDateFields: new Set(['ValueDate']),
    currencyField: 'Currency',
    resolveRowBillDate: (row) => toIso(row[0])
  });
  assert.deepEqual(requested, ['USD ']);
});

test('按金额识别：紧贴字母的数字是编号不作候选（紧贴币种代码除外）；币种标记与金额之间可隔正负号或左括号', () => {
  const codes = { currencyCodes: ['USD', 'USDT'] };
  assert.equal(parseAmountCents('REF42 USD -65.45', codes), 6545, '不把参考号 42 当成 USD 后缀的金额');
  assert.equal(parseAmountCents('USD -65.45', codes), 6545);
  assert.equal(parseAmountCents('$(65.45)', codes), 6545);
  assert.equal(parseAmountCents('USD65.45', codes), 6545);
  assert.equal(parseAmountCents('65.45USD', codes), 6545);
  assert.equal(parseAmountCents('REF42', codes), null, '只有编号时取不到');
  assert.equal(parseAmountCents('Payment65.45', codes), null);
  assert.equal(parseAmountCents('42 USD 65.45', codes), null, '两个都紧跟币种代码时仍有歧义');
  // 代码后紧接正负号与数字时是后一个数字的前缀，不算前一个数字的币种标记（第二十六轮审查）
  assert.equal(parseAmountCents('42 USD -65.45', codes), 6545);
});

// ---- v3.2.21 审查回归（第七轮）----

test('补上本表币种后该行改走拆分映射：币种与日期无法按同一映射确定，按冲突跳过，不按两种映射分别处理', () => {
  const headers = ['Date', 'SplitDate', 'Ccy', 'Desc'];
  const allRows = [headers,
    ['2026-01-01', '2026-01-01', 'NGN', 'x'],
    ['', '', '', 'Trade - $1.00'],
    ['2026-01-03', '2026-01-03', 'NGN', 'x']
  ];
  // 拆分条件：Ccy=NGN 且描述含 Trade
  const routeOf = (row) => (row[2] === 'NGN' && String(row[3]).includes('Trade') ? 'bill-split' : 'main');
  const result = applyCrossSheetBackfill({
    rows: allRows,
    rowNumbers: [1, 2, 3, 4],
    sourceIndexByField: indexBy(headers),
    rule: normalizeCrossSheetBackfillRule({
      sourceSheetName: 'USD',
      rowRules: [{ conditions: [{ field: 'SplitDate', op: '空值', value: '' }] }],
      matchMode: 'amount',
      matchField: 'Desc',
      sourceMatchField: 'Credit Amount',
      backfillFields: [{ targetField: 'SplitDate', sourceField: 'ValueDate' }]
    }),
    readSourceSheet: () => {
      const all = [SOURCE_HEADERS, sourceRow({ date: '01/12/2026', credit: 1 })];
      return { rows: all, rowNumbers: all.map((_row, index) => index + 1) };
    },
    dateTargetFields: new Set(['Date', 'SplitDate']),
    resolveRowContext: (row) => (routeOf(row) === 'bill-split'
      ? { route: 'bill-split', currencyField: '', billDateFields: new Set(['SplitDate']) }
      : { route: 'main', currencyField: 'Ccy', billDateFields: new Set(['Date']) }),
    resolveRowBillDate: (row) => (routeOf(row) === 'bill-split' ? row[1] : row[0])
  });
  assert.deepEqual(result.issues.map((issue) => [issue.type, issue.rowNumber, issue.reason]), [
    ['cross-sheet-backfill-skipped', 3, 'route-changed']
  ]);
  assert.deepEqual(result.patches, []);
  assert.equal(result.rows.length, 3, '该行不进入之后的映射');
});

test('回填了账单日期所用的列、但按该行的账单日期映射取不到有效日期（特征值）时跳过，不输出空账单日期', () => {
  const result = applyCrossSheetBackfill({
    rows: [MAIN_HEADERS, mainRow({ date: '', debit: 2, desc: 'Trade - $65.45' })],
    rowNumbers: [1, 2],
    sourceIndexByField: indexBy(MAIN_HEADERS),
    rule: normalizeCrossSheetBackfillRule(fxRule({ backfillFields: [{ targetField: 'ValueDate', sourceField: 'ValueDate' }] })),
    readSourceSheet: () => {
      const all = [SOURCE_HEADERS, sourceRow({ date: '20260102', credit: 65.45 })];
      return { rows: all, rowNumbers: all.map((_row, index) => index + 1) };
    },
    dateTargetFields: new Set(['ValueDate']),
    billDateFields: new Set(['ValueDate']),
    currencyField: 'Currency',
    // 账单日期映射取「8 位纯数字」特征值：回填后的 yyyy-mm-dd 取不到
    resolveRowBillDate: (row) => {
      const match = /^(\d{4})(\d{2})(\d{2})$/.exec(String(row[0] || ''));
      return match ? `${match[1]}-${match[2]}-${match[3]}` : '';
    }
  });
  assert.deepEqual(result.issues.map((issue) => [issue.rowNumber, issue.reason]), [[2, 'backfilled-date-unmapped']]);
  assert.deepEqual(result.patches, []);
  assert.equal(result.stats.backfilledRows, 0);
});

// ---- v3.2.21 审查回归（第八轮）----

test('parseAmountCents：空格、窄不换行空格、撇号分组的金额整段无法识别，不取其中一段配对', () => {
  assert.equal(parseAmountCents('Trade €1 234,56'), null);
  assert.equal(parseAmountCents("CHF 1'234.56"), null);
  assert.equal(parseAmountCents('USD 1 234.56'), null);
  assert.equal(parseAmountCents('1 234.56 EUR'), null);
  assert.equal(parseAmountCents('Trade - $65.45 2026-09-25'), 6545, '金额后的日期不是分组');
  assert.equal(parseAmountCents('USD 1,234.56'), 123456);
});

test('parseAmountCents：货币符号按 Unicode 货币符号类别识别（全角 ￥、＄）', () => {
  assert.equal(parseAmountCents('Trade #42 - ￥65.45'), 6545);
  assert.equal(parseAmountCents('Trade #42 - ＄65.45'), 6545);
  assert.equal(parseAmountCents('Trade #42 - ₽65.45'), 6545);
});

test('补币种前后该行收支不同（币种列是发生额条件）时跳过，原因 amount-changed', () => {
  const result = applyCrossSheetBackfill({
    rows: [MAIN_HEADERS,
      mainRow({ date: '25/09/2026', currency: 'NGN', credit: 1, desc: 'x' }),
      mainRow({ date: '', currency: '', debit: 90000, desc: 'Trade - $65.45' })],
    rowNumbers: [1, 2, 3],
    sourceIndexByField: indexBy(MAIN_HEADERS),
    rule: normalizeCrossSheetBackfillRule(fxRule({ backfillFields: [{ targetField: 'ValueDate', sourceField: 'ValueDate' }] })),
    readSourceSheet: () => {
      const all = [SOURCE_HEADERS, sourceRow({ date: '26/09/2026', credit: 65.45 })];
      return { rows: all, rowNumbers: all.map((_row, index) => index + 1) };
    },
    dateTargetFields: new Set(['ValueDate']),
    billDateFields: new Set(['ValueDate']),
    currencyField: 'Currency',
    // 币种为空记支出、NGN 记收入
    resolveRowAmounts: (row) => (row[2] === 'NGN' ? `C${row[4] || row[3]}` : `D${row[4] || row[3]}`),
    resolveRowBillDate: (row) => toIso(row[0])
  });
  assert.deepEqual(result.issues.map((issue) => [issue.rowNumber, issue.reason]), [[3, 'amount-changed']]);
  assert.deepEqual(result.patches, []);
});

// ---- v3.2.21 审查回归（第九轮）----

test('parseAmountCents：科学计数法片段无法识别，不把尾数或指数当成金额；编号中的「数字E+数字」不影响其他金额', () => {
  assert.equal(parseAmountCents('1.23E+03'), null);
  assert.equal(parseAmountCents('Trade - $1.2e3'), null);
  assert.equal(parseAmountCents('REF1E+5 USD 65.45'), 6545);
  // 只排除科学计数法片段：同一单元格中另有带货币符号或代码的明确金额时照常识别（第十三轮审查）
  assert.equal(parseAmountCents('Ref: 1E03; Trade - $65.45'), 6545);
  assert.equal(parseAmountCents('1.23E+03 USD 65.45'), 6545);
  // 没有币种标记的剩余数字不采用：被排除的科学计数片段多半就是金额本身（第二十一轮审查）
  assert.equal(parseAmountCents('1.23E+03 65.45'), null);
  // 紧贴完整币种代码的科学计数片段同样是金额，不把剩下的参考号当成金额；紧贴其他字母的仍是编号（第二十二轮审查）
  assert.equal(parseAmountCents('REF: 22; Trade - USD1E03'), null);
  assert.equal(parseAmountCents('REF: 22; Trade - 1E03USD'), null);
  assert.equal(parseAmountCents('REF: 22; Trade - usd1.5e3'), null);
  assert.equal(parseAmountCents('REF1E03 65.45'), 6545);
  assert.equal(parseAmountCents('TXN4E5A2 Trade 65.45'), 6545);
});

test('按原值配对：超过安全整数范围的数值标识已丢失精度，跳过并说明，不按舍入后相等配对', () => {
  const headers = ['Date', 'OrderNo'];
  const result = applyCrossSheetBackfill({
    rows: [headers, ['', 9007199254740993]],
    rowNumbers: [1, 2],
    sourceIndexByField: indexBy(headers),
    rule: normalizeCrossSheetBackfillRule({
      sourceSheetName: 'USD',
      rowRules: [{ conditions: [{ field: 'Date', op: '空值', value: '' }] }],
      matchMode: 'exact',
      matchField: 'OrderNo',
      sourceMatchField: 'OrderNo',
      backfillFields: [{ targetField: 'Date', sourceField: 'Date' }]
    }),
    readSourceSheet: () => {
      const all = [['Date', 'OrderNo'], ['2026-09-26', 9007199254740992]];
      return { rows: all, rowNumbers: [1, 2] };
    },
    dateTargetFields: new Set(['Date'])
  });
  assert.deepEqual(result.issues.map((issue) => [issue.rowNumber, issue.reason]), [[2, 'match-value-imprecise']]);
  assert.deepEqual(result.patches, []);
});

test('来源表头中本规则引用的字段出现多次时报错，指出列位置，不按列顺序取第一列', () => {
  assert.throws(() => applyCrossSheetBackfill({
    rows: [MAIN_HEADERS, mainRow({ date: '', debit: 2, desc: 'Trade - $65.45' })],
    rowNumbers: [1, 2],
    sourceIndexByField: indexBy(MAIN_HEADERS),
    rule: normalizeCrossSheetBackfillRule(fxRule({ backfillFields: [{ targetField: 'ValueDate', sourceField: 'ValueDate' }] })),
    readSourceSheet: () => {
      const all = [['ValueDate', 'Credit Amount', 'Credit Amount'], ['26/09/2026', 1, 65.45]];
      return { rows: all, rowNumbers: [1, 2], columnOffset: 1 };
    },
    dateTargetFields: new Set(['ValueDate'])
  }), /来源 Sheet「USD」的表头中「Credit Amount」出现多次（第 C、D 列）/);
});

// ---- v3.2.21 审查回归（第十轮）----

function runRouteCase({ routeOf, amountsOf }) {
  const headers = ['Date', 'Kind', 'Amt', 'Desc'];
  return applyCrossSheetBackfill({
    rows: [headers, ['2026-09-25', 'N', 100, 'x'], ['', '', 100, 'Trade - $65.45']],
    rowNumbers: [1, 2, 3],
    sourceIndexByField: indexBy(headers),
    rule: normalizeCrossSheetBackfillRule({
      sourceSheetName: 'USD',
      rowRules: [{ conditions: [{ field: 'Date', op: '空值', value: '' }] }],
      matchMode: 'amount',
      matchField: 'Desc',
      sourceMatchField: 'Credit Amount',
      backfillFields: [{ targetField: 'Date', sourceField: 'ValueDate' }, { targetField: 'Kind', sourceField: 'Kind' }]
    }),
    readSourceSheet: () => {
      const all = [['ValueDate', 'Credit Amount', 'Kind'], ['2026-09-26', 65.45, 'FX']];
      return { rows: all, rowNumbers: [1, 2] };
    },
    dateTargetFields: new Set(['Date']),
    resolveRowContext: (row) => ({ route: routeOf(row), currencyField: '', billDateFields: new Set(['Date']) }),
    resolveRowAmounts: amountsOf,
    resolveRowBillDate: (row) => String(row[0] || '')
  });
}

test('回填的普通字段是拆分条件：回填后该行改走拆分映射（支出变收入）时跳过，原因 route-changed', () => {
  const result = runRouteCase({
    routeOf: (row) => (row[1] === 'FX' ? 'bill-split' : 'main'),
    amountsOf: (row) => (row[1] === 'FX' ? `C${row[2]}` : `D${row[2]}`)
  });
  assert.deepEqual(result.issues.map((issue) => [issue.rowNumber, issue.reason]), [[3, 'route-changed']]);
  assert.deepEqual(result.patches, []);
});

test('回填的普通字段是发生额条件：同一映射下收支方向改变时跳过，原因 amount-changed', () => {
  const result = runRouteCase({
    routeOf: () => 'main',
    amountsOf: (row) => (row[1] === 'FX' ? `C${row[2]}` : `D${row[2]}`)
  });
  assert.deepEqual(result.issues.map((issue) => [issue.rowNumber, issue.reason]), [[3, 'amount-changed']]);
});

test('来源回填值是 16 位及以上的数值（已丢失精度的编号）时跳过，不写入回填结果；按原值配对的 16 位数值同样不比较', () => {
  const result = run({
    rows: [mainRow({ date: '', debit: 2, desc: 'Trade - $65.45' })],
    sourceRows: [sourceRow({ date: '26/09/2026', credit: 65.45, extra: 9007199254740993 })]
  });
  assert.deepEqual(result.issues.map((issue) => [issue.rowNumber, issue.reason]), [[2, 'source-value-imprecise']]);
  assert.deepEqual(result.patches, []);
  const headers = ['Date', 'OrderNo'];
  const exact = applyCrossSheetBackfill({
    rows: [headers, ['', 1234567890123450]],
    rowNumbers: [1, 2],
    sourceIndexByField: indexBy(headers),
    rule: normalizeCrossSheetBackfillRule({
      sourceSheetName: 'USD',
      rowRules: [{ conditions: [{ field: 'Date', op: '空值', value: '' }] }],
      matchMode: 'exact',
      matchField: 'OrderNo',
      sourceMatchField: 'OrderNo',
      backfillFields: [{ targetField: 'Date', sourceField: 'Date' }]
    }),
    readSourceSheet: () => ({ rows: [['Date', 'OrderNo'], ['2026-09-26', 1234567890123450]], rowNumbers: [1, 2] }),
    dateTargetFields: new Set(['Date'])
  });
  assert.deepEqual(exact.issues.map((issue) => [issue.rowNumber, issue.reason]), [[2, 'match-value-imprecise']]);
});

// ---- v3.2.21 审查回归（第十一轮）----

test('parseAmountCents：紧贴非 ASCII 字母的数字（订单42、42账）是编号，不作为金额；紧贴完整币种代码（USD42）放行', () => {
  assert.equal(parseAmountCents('订单42'), null);
  assert.equal(parseAmountCents('42账'), null);
  assert.equal(parseAmountCents('USD42'), 4200);
  assert.equal(parseAmountCents('订单42 USD 65.45'), 6545);
});

// ---- v3.2.21 审查回归（第十三轮）----

test('来源日期的英文月份严格识别：只认完整月份名与约定缩写，Septober 这类写法识别不出；主映射的宽松识别不变', () => {
  const { parseBackfillDate } = require('../../../../src/backend/file-service/cross-sheet-backfill');
  const { normalizeDateExportValue } = require('../../../../src/backend/file-service/normalizers');
  assert.equal(parseBackfillDate('03 September 2026'), '2026-09-03');
  assert.equal(parseBackfillDate('03 Sep 2026'), '2026-09-03');
  assert.equal(parseBackfillDate('03-Sept-2026'), '2026-09-03');
  assert.equal(parseBackfillDate('May 03 2026'), '2026-05-03');
  assert.equal(parseBackfillDate('03 Septober 2026'), '');
  assert.equal(parseBackfillDate('03 Mayday 2026'), '');
  assert.equal(normalizeDateExportValue('03 Septober 2026').value, '2026-09-03', '主映射沿用按前三个字母识别');
});

// ---- v3.2.21 审查回归（第十五轮）----

test('按金额配对：被连续多个空白（或空白与制表符）分组的金额整段识别不出，该行跳过，不取首段与来源表中的 1.00 配对', () => {
  for (const separator of ['  ', ' \t', '  ']) {
    assert.equal(parseAmountCents(`USD 1${separator}234.56`), null, JSON.stringify(separator));
  }
  const result = run({
    rows: [
      mainRow({ date: '25/09/2026', credit: 10 }),
      mainRow({ credit: 1234.56, desc: 'Trade - USD 1  234.56' }),
      mainRow({ date: '28/09/2026', credit: 20 })
    ],
    sourceRows: [
      sourceRow({ date: '26/09/2026', credit: 1, extra: 'ORD-1.00' }),
      sourceRow({ date: '27/09/2026', credit: 1234.56, extra: 'ORD-1234.56' })
    ]
  });
  assert.deepEqual(result.patches, []);
  assert.equal(result.stats.backfilledRows, 0);
  assert.equal(result.issues.length, 1);
  assert.equal(result.issues[0].rowNumber, 3);
  assert.equal(result.issues[0].reason, 'match-value-missing');
});

test('规则引用的本表字段在主表表头中出现多次时报错并列出冲突列，不按第一列静默回填；没被规则引用的重名列不影响', () => {
  const headers = MAIN_HEADERS.concat(['Channel OrderNo']);
  const runDuplicate = (rule) => applyCrossSheetBackfill({
    rows: [headers, mainRow({ date: '25/09/2026', credit: 1 }).concat(['']), mainRow({ credit: 65.45, desc: 'Trade - $65.45' }).concat([''])],
    rowNumbers: [1, 2, 3],
    sourceIndexByField: indexBy(headers),
    rule: normalizeCrossSheetBackfillRule(rule),
    readSourceSheet: () => ({ rows: [SOURCE_HEADERS, sourceRow({ date: '26/09/2026', credit: 65.45, extra: 'ORD-1' })], rowNumbers: [1, 2] }),
    dateTargetFields: new Set(['ValueDate']),
    billDateFields: new Set(['ValueDate']),
    currencyField: 'Currency',
    resolveRowBillDate: (row) => toIso(row[0]),
    mainHeaderColumnOffset: 1
  });
  assert.throws(() => runDuplicate(fxRule()), /主表表头中「Channel OrderNo」出现多次（第 H、J 列）/);
  const withoutOrderNo = fxRule({ backfillFields: [{ targetField: 'ValueDate', sourceField: 'ValueDate' }] });
  assert.equal(runDuplicate(withoutOrderNo).stats.backfilledRows, 1);
});

// ---- v3.2.21 审查回归（第十六轮）----

test('只用于配对的字段在主表重名：没有待回填行时不报错（普通账单照常导入），有待回填行时才报错', () => {
  const headers = MAIN_HEADERS.concat(['Transaction Description']);
  const runWithRows = (dataRows) => applyCrossSheetBackfill({
    rows: [headers, ...dataRows.map((row) => row.concat(['']))],
    rowNumbers: [1, ...dataRows.map((_row, index) => index + 2)],
    sourceIndexByField: indexBy(headers),
    rule: normalizeCrossSheetBackfillRule(fxRule()),
    readSourceSheet: () => ({ rows: [SOURCE_HEADERS, sourceRow({ date: '26/09/2026', credit: 65.45, extra: 'ORD-1' })], rowNumbers: [1, 2] }),
    dateTargetFields: new Set(['ValueDate']),
    billDateFields: new Set(['ValueDate']),
    currencyField: 'Currency',
    resolveRowBillDate: (row) => toIso(row[0])
  });
  assert.equal(runWithRows([mainRow({ date: '25/09/2026', credit: 1, channel: 'c', orderNo: 'o' })]).stats.targetRows, 0);
  assert.throws(() => runWithRows([mainRow({ date: '25/09/2026', credit: 1 }), mainRow({ credit: 65.45, desc: 'Trade - $65.45' })]),
    /主表表头中「Transaction Description」出现多次（第 H、I 列）/);
});

test('parseAmountCents：印度式分组（₹1 23 456.78）整段识别不出，不取首段配对；整数金额后接日期不算分组', () => {
  assert.equal(parseAmountCents('₹1 23 456.78'), null);
  assert.equal(parseAmountCents('INR 12 34 567.89'), null);
  assert.equal(parseAmountCents('USD 100 26/09/2026'), 10000);
  const result = run({
    rows: [
      mainRow({ date: '25/09/2026', credit: 10 }),
      mainRow({ credit: 123456.78, desc: 'Trade - ₹1 23 456.78' }),
      mainRow({ date: '28/09/2026', credit: 20 })
    ],
    sourceRows: [sourceRow({ date: '26/09/2026', credit: 1, extra: 'ORD-1.00' })]
  });
  assert.deepEqual(result.patches, []);
  assert.deepEqual(result.issues.map((issue) => [issue.rowNumber, issue.reason]), [[3, 'match-value-missing']]);
});

// ---- v3.2.21 审查回归（第十七轮）----

test('parseAmountCents：紧贴数字的小写币种代码（usd65.45、65.45usd）同样是币种标记，不把参考号 42 当成金额；隔空格的币种代码仍只认大写', () => {
  assert.equal(parseAmountCents('ref 42; trade usd65.45'), 6545);
  assert.equal(parseAmountCents('ref 42; 65.45usd'), 6545);
  assert.equal(parseAmountCents('Pay all 42 items for $65.45'), 6545, 'all 不当成币种');
  assert.equal(parseAmountCents('ref42'), null);
  const result = run({
    rows: [
      mainRow({ date: '25/09/2026', credit: 10 }),
      mainRow({ credit: 65.45, desc: 'ref 42; trade usd65.45' }),
      mainRow({ date: '28/09/2026', credit: 20 })
    ],
    sourceRows: [
      sourceRow({ date: '26/09/2026', credit: 42, extra: 'ORD-42' }),
      sourceRow({ date: '27/09/2026', credit: 65.45, extra: 'ORD-65' })
    ]
  });
  assert.deepEqual(result.patches.map((patch) => [patch.rowNumber, patch.sourceRowNumber]), [[3, 3]]);
});

test('已配上来源行、但来源行中要回填的字段都为空（且不需补币种）：该行照常保留、来源行被占用，单独记录两边行号与空字段，不算已回填也不算跳过', () => {
  const rule = fxRule({ rowRules: [{ conditions: [{ field: 'Channel OrderNo', op: '空值', value: '' }] }],
    backfillFields: [{ targetField: 'Channel OrderNo', sourceField: 'Extra Information' }] });
  const result = run({
    rows: [
      mainRow({ date: '25/09/2026', credit: 10, orderNo: 'ORD-0' }),
      mainRow({ date: '26/09/2026', credit: 65.45, desc: 'Trade - $65.45', currency: 'NGN' })
    ],
    sourceRows: [sourceRow({ date: '26/09/2026', credit: 65.45, extra: '' })],
    rule
  });
  assert.deepEqual(result.patches, []);
  assert.deepEqual(result.stats, { targetRows: 1, backfilledRows: 0, skippedRows: 0 });
  assert.equal(result.rows.length, 3, '该行照常保留');
  assert.deepEqual(result.issues.map(({ type, rowNumber, sourceRowNumber, sourceSheetName, emptyFields }) => (
    [type, rowNumber, sourceRowNumber, sourceSheetName, emptyFields]
  )), [['cross-sheet-backfill-matched-empty', 3, 2, 'USD', ['Channel OrderNo']]]);
});

test('不能单独填写的区域按列、按区间查询：左上角可写、其余位置不可写；跨越极多行的区域不按行数展开', () => {
  const span = (sr, sc, er, ec) => ({ s: { r: sr, c: sc }, e: { r: er, c: ec } });
  const ranges = [
    span(1, 1, 3, 1),
    span(9, 3, 999999999, 4), // 表头与末笔交易相隔极远、跨这些行纵向合并
    span(20, 7, 20, 9)
  ];
  const started = process.hrtime.bigint();
  const isUnwritable = createUnwritableCellLookup(ranges);
  const results = [
    [1, 1], [2, 1], [3, 1], [4, 1], [0, 1],
    [9, 3], [9, 4], [10, 3], [999999999, 4], [1000000000, 4], [500, 2],
    [20, 7], [20, 9], [21, 8]
  ].map(([row, column]) => isUnwritable(row, column));
  assert.deepEqual(results, [
    false, true, true, false, false,
    false, true, true, true, false, false,
    false, true, false
  ]);
  assert.ok(process.hrtime.bigint() - started < 1000000000n, '不按区域跨越的行数分配');
  assert.equal(createUnwritableCellLookup(null)(5, 5), false);
});

// ---- v3.2.21 审查回归（第十八轮）----

test('parseAmountCents：混用逗号与空白 / 撇号分组的完整金额整段取不到，不截取前半段 1,234 配对；带小数或后接日期等其他写法照常识别', () => {
  assert.equal(parseAmountCents('USD 1,234 567.89'), null);
  assert.equal(parseAmountCents("USD 1,234'567.89"), null);
  assert.equal(parseAmountCents('1,234 567.89 USD'), null, '后半段由币种代码选中时，左侧的 1,234 同样是分组');
  assert.equal(parseAmountCents('USD 1,234.56 789'), 123456, '带小数的金额到小数为止');
  assert.equal(parseAmountCents('USD 1,234 26/09/2026'), 123400);
  assert.equal(parseAmountCents('Paid USD 1,234 for 3 items'), 123400);
  const result = run({
    rows: [
      mainRow({ date: '25/09/2026', credit: 10 }),
      mainRow({ credit: 1234567.89, desc: 'USD 1,234 567.89' }),
      mainRow({ date: '28/09/2026', credit: 20 })
    ],
    sourceRows: [sourceRow({ date: '26/09/2026', credit: 1234, extra: 'ORD-1234' })]
  });
  assert.deepEqual(result.patches, [], '不与 1,234.00 的来源行配对、不占用它');
  assert.deepEqual(result.issues.map((issue) => [issue.rowNumber, issue.reason]), [[3, 'match-value-missing']]);
});

test('parseAmountCents：币种代码本身含数字（映射表同时有 USD 与 USD1）时，作为完整的词出现的代码中的数字不作为金额候选；紧贴写法分界有歧义时取不到', () => {
  const options = { currencyCodes: ['USD', 'USD1'] };
  assert.equal(parseAmountCents('USD1 65.45', options), 6545);
  assert.equal(parseAmountCents('65.45 USD1', options), 6545);
  assert.equal(parseAmountCents('USD65.45', options), 6545);
  assert.equal(parseAmountCents('USD165.45', options), null, 'USD 165.45 还是 USD1 65.45 无法确定');
  assert.equal(parseAmountCents('USD165.45'), 16545, '默认代码中没有 USD1 时照常识别');
});

// ---- v3.2.21 审查回归（第二十一轮）----

test('parseAmountCents：含全角数字或全角标点的金额整段取不到，不截取其中一段；排除科学计数片段后剩下的数字须有币种标记', () => {
  assert.equal(parseAmountCents('Trade - ￥1，234.56'), null);
  assert.equal(parseAmountCents('Trade - ￥１234.56'), null);
  assert.equal(parseAmountCents('Trade - ￥1234．56'), null);
  assert.equal(parseAmountCents('Trade - ￥1,234.56'), 123456, '半角写法照常识别');
  assert.equal(parseAmountCents('Trade - $65.45。'), 6545, '句末的全角句号不影响');
  assert.equal(parseAmountCents('REF: 22; Trade - $1E03'), null);
  assert.equal(parseAmountCents('REF: 22; Trade - 1E03'), null);
  assert.equal(parseAmountCents('Ref: 1E03; Trade - $65.45'), 6545);
});

test('金额写法不完整（全角）的待回填行跳过且不占用来源行：同额的来源行仍留给后面写法正常的待回填行', () => {
  const result = run({
    rows: [
      mainRow({ date: '18/09/2026', credit: 20000, balance: 20000, orderNo: 'LB001', desc: 'x' }),
      mainRow({ date: '', channel: '', currency: '', debit: 9000, balance: 0, desc: 'Trade - ￥1，234.56' }),
      mainRow({ date: '', channel: '', currency: '', debit: 100, balance: 0, desc: 'Trade - $1.00' })
    ],
    sourceRows: [sourceRow({ date: '26/09/2026', credit: 1, extra: 'ORD-1' })]
  });
  assert.deepEqual(result.skippedRows.map((item) => item.rowNumber), [3]);
  assert.deepEqual(result.issues.filter((issue) => issue.type === 'cross-sheet-backfill-skipped')
    .map((issue) => [issue.rowNumber, issue.reason]), [[3, 'match-value-missing']]);
  assert.deepEqual(result.patches.map((patch) => [patch.rowNumber, patch.sourceRowNumber]), [[4, 2]]);
});

test('需要自动补币种时，币种列在主表表头中重名即报错（与回填目标同口径）；不需要补币种时不受影响', () => {
  const headers = MAIN_HEADERS.concat(['Currency']);
  const runWithRows = (dataRows) => applyCrossSheetBackfill({
    rows: [headers, ...dataRows],
    rowNumbers: [1, ...dataRows.map((_row, index) => index + 2)],
    // 与映射同口径：重名列按第一列取值
    sourceIndexByField: new Map(headers.map((header, index) => [header, headers.indexOf(header)]).reverse()),
    rule: normalizeCrossSheetBackfillRule(fxRule()),
    readSourceSheet: () => ({ rows: [SOURCE_HEADERS, sourceRow({ date: '26/09/2026', credit: 65.45, extra: 'ORD-1' })], rowNumbers: [1, 2] }),
    dateTargetFields: new Set(['ValueDate']),
    billDateFields: new Set(['ValueDate']),
    currencyField: 'Currency',
    resolveRowBillDate: (row) => toIso(row[0])
  });
  const ordinary = mainRow({ date: '25/09/2026', credit: 1, currency: 'USD', orderNo: 'o' }).concat(['EUR']);
  assert.throws(() => runWithRows([ordinary, mainRow({ currency: '', credit: 65.45, desc: 'Trade - $65.45' }).concat(['EUR'])]),
    /主表表头中「Currency」出现多次（第 C、I 列）/);
  const withCurrency = runWithRows([ordinary, mainRow({ currency: 'USD', credit: 65.45, desc: 'Trade - $65.45' }).concat(['EUR'])]);
  assert.equal(withCurrency.stats.backfilledRows, 1);
});

// ---- v3.2.21 审查回归（第二十三轮）----

test('parseAmountCents：带币种标记但含全角数字的金额取不到，不改用唯一剩下的参考号；紧贴文字的全角数字仍是编号', () => {
  assert.equal(parseAmountCents('REF: 22; Trade - ￥１２３'), null);
  assert.equal(parseAmountCents('REF: 22; Trade - ￥１234.56'), null);
  assert.equal(parseAmountCents('USD 65.45 (￥１２３)'), null);
  assert.equal(parseAmountCents('１２３'), null);
  assert.equal(parseAmountCents('第１期 Trade 65.45'), 6545);
  assert.equal(parseAmountCents('ＲＥＦ１２ 65.45'), 6545);
  assert.equal(parseAmountCents('Trade - $65.45 第１期'), 6545);
});

test('全角金额旁另有参考号的待回填行跳过且不占用来源行：同额（参考号金额）的来源行仍留给后面的待回填行', () => {
  const result = run({
    rows: [
      mainRow({ date: '18/09/2026', credit: 20000, balance: 20000, orderNo: 'LB001', desc: 'x' }),
      mainRow({ date: '', channel: '', currency: '', debit: 9000, balance: 0, desc: 'REF: 22; Trade - ￥１２３' }),
      mainRow({ date: '', channel: '', currency: '', debit: 100, balance: 0, desc: 'Trade - $22.00' })
    ],
    sourceRows: [sourceRow({ date: '26/09/2026', credit: 22, extra: 'ORD-1' })]
  });
  assert.deepEqual(result.skippedRows.map((item) => item.rowNumber), [3]);
  assert.deepEqual(result.issues.filter((issue) => issue.type === 'cross-sheet-backfill-skipped')
    .map((issue) => [issue.rowNumber, issue.reason]), [[3, 'match-value-missing']]);
  assert.deepEqual(result.patches.map((patch) => [patch.rowNumber, patch.sourceRowNumber]), [[4, 2]]);
});

test('来源文本日期只去掉完整、有效的时间后缀：时间之后另有内容、时间无效时识别不出；常见的时间写法照常识别', () => {
  const { parseBackfillDate } = require('../../../../src/backend/file-service/cross-sheet-backfill');
  assert.equal(parseBackfillDate('9/25/2026 12:00:00 or 09/26/2026', { dateOrder: 'MDY' }), '');
  assert.equal(parseBackfillDate('2026-09-25 99:99oops'), '');
  assert.equal(parseBackfillDate('2026-09-25 99:99'), '');
  assert.equal(parseBackfillDate('2026-09-25 13:30 PM'), '');
  assert.equal(parseBackfillDate('26/09/2026 10:15'), '2026-09-26');
  assert.equal(parseBackfillDate('26/09/2026, 10:15 AM'), '2026-09-26');
  assert.equal(parseBackfillDate('26 Sep 2026 10:15:30.123'), '2026-09-26');
  assert.equal(parseBackfillDate('2026-09-26T08:30:00+08:00'), '2026-09-26');
  assert.equal(parseBackfillDate('2026-09-26T00:00:00Z'), '2026-09-26');
});

// ---- v3.2.21 审查回归（第二十四轮）----

test('parseAmountCents：紧贴货币符号或中文货币字样的数字是金额标记，写法不支持时整格取不到，不当成编号丢掉后改用流水号', () => {
  for (const text of [
    '流水号：22；金额：￥１００元', '流水号：22；金额：￥100元', '流水号：22；金额：100元', '流水号：22；金额：100万元',
    '流水号：22；金额：100美元', '流水号：22；人民币100', 'REF22 ￥100元', '$65.45abc'
  ]) {
    assert.equal(parseAmountCents(text), null, text);
  }
  assert.equal(parseAmountCents('第１期 Trade 65.45'), 6545);
  assert.equal(parseAmountCents('REF42 Trade 65.45'), 6545);
  assert.equal(parseAmountCents('2026年1月1日 Trade 65.45'), 6545);
  assert.equal(parseAmountCents('usd65.45'), 6545);
});

test('金额带货币字样但写法不支持的待回填行跳过且不占用来源行：同额（流水号金额）的来源行仍留给后面的待回填行', () => {
  const result = run({
    rows: [
      mainRow({ date: '18/09/2026', credit: 20000, balance: 20000, orderNo: 'LB001', desc: 'x' }),
      mainRow({ date: '', channel: '', currency: '', debit: 9000, balance: 0, desc: '流水号：22；金额：￥１００元' }),
      mainRow({ date: '', channel: '', currency: '', debit: 100, balance: 0, desc: 'Trade - $22.00' })
    ],
    sourceRows: [sourceRow({ date: '26/09/2026', credit: 22, extra: 'ORD-1' })]
  });
  assert.deepEqual(result.issues.filter((issue) => issue.type === 'cross-sheet-backfill-skipped')
    .map((issue) => [issue.rowNumber, issue.reason]), [[3, 'match-value-missing']]);
  assert.deepEqual(result.patches.map((patch) => [patch.rowNumber, patch.sourceRowNumber]), [[4, 2]]);
});

test('来源文本日期带合法时间时照常识别：日期部分不以数字结尾的写法（2026年09月25日 12:34:56、2026 25-Sep 12:34:56）同样去掉时间', () => {
  const { parseBackfillDate } = require('../../../../src/backend/file-service/cross-sheet-backfill');
  assert.equal(parseBackfillDate('2026年09月25日 12:34:56'), '2026-09-25');
  assert.equal(parseBackfillDate('2026 25-Sep 12:34:56'), '2026-09-25');
  assert.equal(parseBackfillDate('2026年09月25日 99:99'), '');
  assert.equal(parseBackfillDate('2026年09月25日 12:34:56 备注'), '');
});

// ---- v3.2.21 审查回归（第二十五轮）----

test('parseAmountCents：带币种标记或借贷标记、紧贴其他字母的金额写法（100港币、USD 65.45CR、100CR）整格取不到，不改用流水号；数字后隔开的币种代码属于下一个金额', () => {
  for (const text of ['流水号：22；金额：100港币', 'REF: 22; Trade - USD 65.45CR', 'REF: 22; Trade - 65.45CR', 'REF: 22; Trade - 100CR', 'AB65.45 USD 22']) {
    assert.equal(parseAmountCents(text), null, text);
  }
  assert.equal(parseAmountCents('REF42 USD -65.45'), 6545);
  assert.equal(parseAmountCents('Trade 65.45 CR'), 6545);
  assert.equal(parseAmountCents('TXN4E5A2 Trade 65.45'), 6545);
});

test('金额带借贷标记的待回填行（USD 65.45CR）跳过且不占用来源行：同额（流水号金额）的来源行仍留给后面的待回填行', () => {
  const result = run({
    rows: [
      mainRow({ date: '18/09/2026', credit: 20000, balance: 20000, orderNo: 'LB001', desc: 'x' }),
      mainRow({ date: '', channel: '', currency: '', debit: 9000, balance: 0, desc: 'REF: 22; Trade - USD 65.45CR' }),
      mainRow({ date: '', channel: '', currency: '', debit: 100, balance: 0, desc: 'Trade - $22.00' })
    ],
    sourceRows: [sourceRow({ date: '26/09/2026', credit: 22, extra: 'ORD-1' })]
  });
  assert.deepEqual(result.issues.filter((issue) => issue.type === 'cross-sheet-backfill-skipped')
    .map((issue) => [issue.rowNumber, issue.reason]), [[3, 'match-value-missing']]);
  assert.deepEqual(result.patches.map((patch) => [patch.rowNumber, patch.sourceRowNumber]), [[4, 2]]);
});

// ---- v3.2.21 审查回归（第二十六轮）----

test('parseAmountCents：科学计数金额带币种前缀或借贷、中文货币后缀时整格取不到，不改用参考号；币种代码后接正负号与数字时归后一个数字', () => {
  for (const text of ['REF: 22 USD -1E03', 'REF: 22 USD 1E03', 'REF: 22; Trade - 1E3CR', 'REF: 22; Trade - 1E3DR', 'REF: 22; Trade - 1E3元']) {
    assert.equal(parseAmountCents(text), null, text);
  }
  assert.equal(parseAmountCents('REF: 22 USD -65.45'), 6545);
  assert.equal(parseAmountCents('1.23E+03 USD 65.45'), 6545);
  assert.equal(parseAmountCents('42 USD 65.45'), null);
});

// ---- v3.2.21 审查回归（第二十七轮）----

test('parseAmountCents：币种代码后的 Unicode 负号、全角负号与各类短横与 ASCII 负号同样判定，代码归后一个数字，不改用前面的参考号', () => {
  for (const sign of ['-', '\u2212', '\uFF0D', '\uFE63', '\u2010', '\u2013', '\u2014']) {
    assert.equal(parseAmountCents(`REF: 22 USD ${sign}65.45`), 6545, JSON.stringify(sign));
    assert.equal(parseAmountCents(`REF: 22 USD ${sign}1E03`), null, JSON.stringify(sign));
  }
  assert.equal(parseAmountCents('REF: 22 USD （65.45'), 6545);
});

test('金额前是 Unicode 负号的待回填行按 65.45 配对，不占用金额为参考号 22.00 的来源行', () => {
  const result = run({
    rows: [
      mainRow({ date: '18/09/2026', credit: 20000, balance: 20000, orderNo: 'LB001', desc: 'x' }),
      mainRow({ date: '', channel: '', currency: '', debit: 9000, balance: 0, desc: 'REF: 22 USD \u221265.45' })
    ],
    sourceRows: [sourceRow({ date: '25/09/2026', credit: 22, extra: 'ORD-22' }), sourceRow({ date: '26/09/2026', credit: 65.45, extra: 'ORD-1' })]
  });
  assert.deepEqual(result.patches.map((patch) => [patch.rowNumber, patch.sourceRowNumber]), [[3, 3]]);
});

// ---- v3.2.21 审查回归（第二十八轮）----

test('parseAmountCents：科学计数的指数正负号是 Unicode 负号、全角或短横时同样整段不作为金额，不把指数当成金额', () => {
  for (const sign of ['-', '+', '\u2212', '\uFF0D', '\uFF0B', '\uFE63', '\u2010', '\u2013', '\u2014']) {
    assert.equal(parseAmountCents(`1.2E${sign}3`), null, JSON.stringify(sign));
    assert.equal(parseAmountCents(`Ref: 1E${sign}5; Trade - $3.00`), 300, JSON.stringify(sign));
  }
});

test('描述为 1.2E−3（Unicode 负号指数）的待回填行取不到金额、不占用 3.00 的来源行，后面确实需要 3.00 的行仍能配上', () => {
  const result = run({
    rows: [
      mainRow({ date: '18/09/2026', credit: 20000, balance: 20000, orderNo: 'LB001', desc: 'x' }),
      mainRow({ date: '', channel: '', currency: '', debit: 9000, balance: 0, desc: 'FX 1.2E\u22123' }),
      mainRow({ date: '', channel: '', currency: '', debit: 9000, balance: 0, desc: 'Trade - $3.00' })
    ],
    sourceRows: [sourceRow({ date: '26/09/2026', credit: 3, extra: 'ORD-3' })]
  });
  assert.deepEqual(result.patches.map((patch) => [patch.rowNumber, patch.sourceRowNumber]), [[4, 2]]);
});

// ---- v3.2.21 审查回归（第三十轮）----

test('parseAmountCents：前半段不是合法分组的撇号 / 空白分组写法（CHF 1234\'567.89、1234\'567.89 CHF）整段取不到；编号后隔空格的金额照常', () => {
  for (const text of ["CHF 1234'567.89", "1234'567.89 CHF", 'CHF 1234 567.89', "CHF 1234\u2019567.89", 'USD 12,34 567.89']) {
    assert.equal(parseAmountCents(text), null, text);
  }
  assert.equal(parseAmountCents('INV 20260925 100.00 USD'), 10000);
  assert.equal(parseAmountCents('USD 100 26/09/2026'), 10000);
});

test("描述为 CHF 1234'567.89 的待回填行取不到金额、不占用 1,234.00 的来源行，后面确实需要 1,234.00 的行仍能配上", () => {
  const result = run({
    rows: [
      mainRow({ date: '18/09/2026', credit: 20000, balance: 20000, orderNo: 'LB001', desc: 'x' }),
      mainRow({ date: '', channel: '', currency: '', debit: 9000, balance: 0, desc: "CHF 1234'567.89" }),
      mainRow({ date: '', channel: '', currency: '', debit: 9000, balance: 0, desc: 'Trade - $1,234.00' })
    ],
    sourceRows: [sourceRow({ date: '26/09/2026', credit: 1234, extra: 'ORD-1234' })]
  });
  assert.deepEqual(result.patches.map((patch) => [patch.rowNumber, patch.sourceRowNumber]), [[4, 2]]);
});

// ---- v3.2.21 审查回归（第三十一轮）----

test("parseAmountCents：撇号夹在数字之间时整段取不到，不论两侧各有几位（CHF 1'23.45、1234'56.78 CHF）", () => {
  for (const text of ["CHF 1'23.45", "1234'56.78 CHF", "CHF 1'234.56", "USD 12\u2019345.6", "CHF 1 '23.45", "1' 23.45 CHF"]) {
    assert.equal(parseAmountCents(text), null, text);
  }
  assert.equal(parseAmountCents("O'Brien USD 65.45"), 6545);
  assert.equal(parseAmountCents('INV 20260925 100.00 USD'), 10000);
});

test("描述为 CHF 1'23.45 的待回填行取不到金额、不占用 1.00 的来源行，后面确实需要 1.00 的行仍能配上", () => {
  const result = run({
    rows: [
      mainRow({ date: '18/09/2026', credit: 20000, balance: 20000, orderNo: 'LB001', desc: 'x' }),
      mainRow({ date: '', channel: '', currency: '', debit: 9000, balance: 0, desc: "CHF 1'23.45" }),
      mainRow({ date: '', channel: '', currency: '', debit: 9000, balance: 0, desc: 'Trade - $1.00' })
    ],
    sourceRows: [sourceRow({ date: '26/09/2026', credit: 1, extra: 'ORD-1' })]
  });
  assert.deepEqual(result.patches.map((patch) => [patch.rowNumber, patch.sourceRowNumber]), [[4, 2]]);
});

// ---- v3.2.21 审查回归（第三十五轮）----

test('parseAmountCents：币种标记与金额之间有两个正负号或左括号（USD (-65.45)、-(65.45)、[65.45]）时前后缀同一规则，不把币种代码归给前面的参考号', () => {
  ['REF: 22 USD (-65.45)', 'REF: 22 USD -(65.45)', 'REF: 22 USD (+65.45)', 'REF: 22 USD (−65.45)', 'REF: 22 USD [65.45]', 'REF: 22 $(-65.45)', 'REF: 22 USD （-65.45）']
    .forEach((text) => assert.equal(parseAmountCents(text), 6545, text));
  assert.equal(parseAmountCents('REF: 22 USD 65.45'), null, '代码后直接是数字：两边都可能，有歧义');
  assert.equal(parseAmountCents('Paid 22 USD; ref 65'), 2200, '代码后不接数字时仍归前一个数字');
});
