// v2.1.12 需求1 — VCC业务OP计算 session 资金红线单测（🔴）
// 覆盖：金额整数分精度 / 发生额入出总额 / 混币种全量合并 / 期末OP=期初+发生额 / 整批拒绝
// 用 session 导出的纯函数（parseAmountToCents/scan/computeAmounts）+ DB 落库（saveRun via session）

const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');

const {
  parseAmountToCents,
  centsToAmountString,
  extractYearMonth,
  scan,
  computeAmounts,
  createVccOpCalcSession
} = require('../../../src/main-process/vcc-op-calc-session');
const { ensureVccOpCalcTablesSupport } = require('../../../src/backend/database/migrations');

// 流水对账单 DB 列名：direction / recon_amount / bill_date_raw / currency
function row(direction, amount, billDate = '2026-03-15', currency = 'CNY') {
  return { direction, recon_amount: amount, bill_date_raw: billDate, currency };
}
function files(rows) { return [{ fileName: 'f1.xlsx', rows }]; }
function saveOwner(label = 'default') {
  return {
    taskRunId: `vcc-save-task-${label}`,
    taskKey: 'vccOpCalc:run:save',
    moduleId: 'vcc-op-calc',
    parentRunId: `vcc-parent-${label}`,
    operationKey: `vcc-save-operation-${label}`
  };
}

test.describe('VCC session — 金额精度 helper（整数分 🔴）', () => {
  test('parseAmountToCents：整数分 + 浮点尾差吸收 + 千分位 + 负数', () => {
    assert.deepEqual(parseAmountToCents('100'), { ok: true, cents: 10000, empty: false });
    assert.deepEqual(parseAmountToCents('0.1'), { ok: true, cents: 10, empty: false });
    assert.equal(parseAmountToCents('').empty, true);
    assert.equal(parseAmountToCents('').cents, 0);
    assert.equal(parseAmountToCents(null).cents, 0);
    assert.equal(parseAmountToCents('abc').ok, false);
    assert.deepEqual(parseAmountToCents('1,234.56'), { ok: true, cents: 123456, empty: false });
    assert.equal(parseAmountToCents('-5').cents, -500);
  });
  test('centsToAmountString：除回 2 位小数（含负号）', () => {
    assert.equal(centsToAmountString(10000), '100.00');
    assert.equal(centsToAmountString(10), '0.10');
    assert.equal(centsToAmountString(-500), '-5.00');
    assert.equal(centsToAmountString(0), '0.00');
  });
});

test.describe('VCC session — extractYearMonth（定月口径）', () => {
  test('各格式定月 + 非法返 null', () => {
    assert.equal(extractYearMonth('2026-03-15'), '2026-03');
    assert.equal(extractYearMonth('2026/03/15'), '2026-03');
    assert.equal(extractYearMonth('2026-03-15 12:30:00'), '2026-03');
    assert.equal(extractYearMonth('20260315'), '2026-03');
    assert.equal(extractYearMonth('2026-03'), '2026-03');
    assert.equal(extractYearMonth(''), null);
    assert.equal(extractYearMonth('bad'), null);
    assert.equal(extractYearMonth('2026-13-01'), null);
  });
});

test.describe('VCC session — computeAmounts（发生额 / 混币种全量 🔴）', () => {
  test('发生额入/出/总额（整数分，总额=入−出）', () => {
    const r = computeAmounts(files([row('入', '100'), row('入', '50'), row('出', '30')]));
    assert.equal(r.ok, true);
    assert.equal(r.totals.totalIn, '150.00');
    assert.equal(r.totals.totalOut, '30.00');
    assert.equal(r.totals.totalAmount, '120.00');
    assert.equal(r.yearMonth, '2026-03');
  });
  test('0.1+0.2 浮点坑：整数分相加 = 0.30（不漂移）', () => {
    const r = computeAmounts(files([row('入', '0.2'), row('入', '0.1')]));
    assert.equal(r.totals.totalIn, '0.30');
  });
  test('混币种全量合并（不分币种相加）+ currency 多币种列表', () => {
    const r = computeAmounts(files([row('入', '100', '2026-03-15', 'CNY'), row('入', '50', '2026-03-15', 'USD')]));
    assert.equal(r.totals.totalIn, '150.00');
    assert.equal(r.totals.currency, 'CNY,USD');
  });
  test('单币种 → currency 存该币种', () => {
    const r = computeAmounts(files([row('入', '100', '2026-03-15', 'CNY')]));
    assert.equal(r.totals.currency, 'CNY');
  });
  test('空对账金额计 0（不报错）', () => {
    const r = computeAmounts(files([row('入', ''), row('入', '100')]));
    assert.equal(r.totals.totalIn, '100.00');
  });
  test('perFile 逐文件明细（含跨文件汇总）', () => {
    const r = computeAmounts([
      { fileName: 'a.xlsx', rows: [row('入', '100')] },
      { fileName: 'b.xlsx', rows: [row('出', '40')] }
    ]);
    assert.equal(r.perFile.length, 2);
    assert.equal(r.perFile[0].amountIn, '100.00');
    assert.equal(r.perFile[1].amountOut, '40.00');
    assert.equal(r.totals.totalAmount, '60.00');
  });
});

test.describe('VCC session — scan 整批拒绝（资金红线 🔴 不静默跳过）', () => {
  test('非法 direction → 整批拒绝', () => {
    const r = scan(files([row('入', '100'), row('转账', '50')]));
    assert.equal(r.ok, false);
    assert.ok(r.errorRows.some((e) => /出入方向非法/.test(e.reason)));
  });
  test('非数值金额 → 整批拒绝', () => {
    const r = scan(files([row('入', 'abc')]));
    assert.equal(r.ok, false);
    assert.ok(r.errorRows.some((e) => /对账金额非数值/.test(e.reason)));
  });
  test('空账单日期 → 整批拒绝', () => {
    const r = scan(files([row('入', '100', '')]));
    assert.equal(r.ok, false);
    assert.ok(r.errorRows.some((e) => /账单日期无法解析/.test(e.reason)));
  });
  test('多月份混杂 → 整批拒绝', () => {
    const r = scan(files([row('入', '100', '2026-03-15'), row('入', '50', '2026-04-15')]));
    assert.equal(r.ok, false);
    assert.ok(r.errorRows.some((e) => /跨多个月份/.test(e.reason)));
  });
  test('空数据 → 拒绝', () => {
    const r = scan(files([]));
    assert.equal(r.ok, false);
  });
  test('全合法单月 → ok', () => {
    const r = scan(files([row('入', '100'), row('出', '50')]));
    assert.equal(r.ok, true);
    assert.equal(r.yearMonth, '2026-03');
    assert.equal(r.totalRows, 2);
  });
});

test.describe('VCC session — saveRun 落库（期末OP=期初+发生额 🔴 + 查询）', () => {
  test('saveRun → endOp=期初+发生额、落表A/B、getMonthResult 查询一致', () => {
    const db = new DatabaseSync(':memory:');
    ensureVccOpCalcTablesSupport(db);
    const session = createVccOpCalcSession({ getDb: () => db });
    const fr = [{ fileName: 'f.xlsx', rows: [row('入', '100'), row('出', '30')] }];
    assert.equal(session.scanFiles(fr).ok, true);
    assert.equal(session.computeFiles(fr).ok, true);
    const saved = session.saveRun({ beginOp: '1000', operationOwner: saveOwner('golden') }); // 1000 + (100-30) = 1070
    assert.equal(saved.endOp, '1070.00');
    const months = session.listCalculatedMonths(); // 返回对象数组 [{ yearMonth, ... }]
    assert.ok(months.some((m) => (m.yearMonth || m.year_month) === '2026-03'), 'listCalculatedMonths 应含 2026-03');
    const result = session.getMonthResult('2026-03');
    assert.equal(result.beginOp, '1000.00');
    assert.equal(result.totalAmount, '70.00');
    assert.equal(result.endOp, '1070.00');
  });
  test('saveRun：期初OP 空/非数值 → 抛错（资金红线必填）', () => {
    const db = new DatabaseSync(':memory:');
    ensureVccOpCalcTablesSupport(db);
    const session = createVccOpCalcSession({ getDb: () => db });
    const fr = [{ fileName: 'f.xlsx', rows: [row('入', '100')] }];
    session.scanFiles(fr);
    session.computeFiles(fr);
    assert.throws(() => session.saveRun({ beginOp: '', operationOwner: saveOwner('empty') }));
    assert.throws(() => session.saveRun({ beginOp: 'abc', operationOwner: saveOwner('invalid') }));
  });
  test('saveRun 既有 partial explicit seam 仍从 adopted snapshot 补齐其余字段', () => {
    const db = new DatabaseSync(':memory:');
    ensureVccOpCalcTablesSupport(db);
    const session = createVccOpCalcSession({ getDb: () => db });
    const fr = [{ fileName: 'f.xlsx', rows: [row('入', '100')] }];
    session.computeFiles(fr);
    const saved = session.saveRun({
      yearMonth: '2026-03',
      beginOp: '1.00',
      operationOwner: saveOwner('partial-explicit')
    });
    assert.equal(saved.endOp, '101.00');
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM vcc_op_operation_receipts').get().count, 1);
  });
});
