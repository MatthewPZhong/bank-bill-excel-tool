// v3.0.4 块 F「Payment线下调拨订单回填处理」周数 / FTA 解析纯函数地基单测（🔴 资金红线）
// changes/payment-offline-allocation-backfill/spec.md §F3 / §F7
//
// 覆盖：
//   ① parseFtaDate：/^FTA(\d{8})/ 提取 + 合法日期校验；需求例 + 真实样本 + 非法/无前缀 → null
//   ② weekTag ISO 8601 基准四元组写死（✅ Q2 拍板）：2026-06-02→2623 / 2026-01-01→2601 /
//      2025-12-29→2601 / 2027-01-01→2653（ISO week-year 跨年分叉，与日历年/Excel WEEKNUM 不同）
//   ③ weekTagPlusOne 日期语义「+7天所在周」：年末进位用日期语义（2653+1 → 2701，非 YYWW 数字加法）
//   ④ Q6 同日边界由引擎层断言（本文件只锁周数 / FTA 口径）

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  parseFtaDate,
  weekTag,
  weekTagPlusOne,
  weekTagToNumber
} = require('../../../../src/main-process/scenario-engines/engine-week-utils');

// ---- ① parseFtaDate -----------------------------------------------------

test.describe('engine-week-utils — parseFtaDate', () => {
  test('需求例 FTA202606021000477 → 2026-06-02（年月日逐字一致）', () => {
    const d = parseFtaDate('FTA202606021000477');
    assert.ok(d instanceof Date, '应解析出 Date');
    assert.equal(d.getFullYear(), 2026);
    assert.equal(d.getMonth() + 1, 6);
    assert.equal(d.getDate(), 2);
  });

  test('真实样本 FTA202604280200028 → 2026-04-28', () => {
    const d = parseFtaDate('FTA202604280200028');
    assert.ok(d instanceof Date);
    assert.equal(d.getFullYear(), 2026);
    assert.equal(d.getMonth() + 1, 4);
    assert.equal(d.getDate(), 28);
  });

  test('非 FTA 前缀 → null', () => {
    assert.equal(parseFtaDate('XYZ202606020000001'), null);
    assert.equal(parseFtaDate('fta202606020000001'), null, '前缀大小写敏感');
  });

  test('FTA 后不足 8 位数字 → null', () => {
    assert.equal(parseFtaDate('FTA2026060'), null);
    assert.equal(parseFtaDate('FTA'), null);
  });

  test('FTA 后 8 位但非法日期（20260230 / 20261301）→ null', () => {
    assert.equal(parseFtaDate('FTA2026023012345'), null, '2 月 30 日非法');
    assert.equal(parseFtaDate('FTA2026130112345'), null, '13 月非法');
  });

  test('空 / null / undefined / 非字符串 → null', () => {
    assert.equal(parseFtaDate(''), null);
    assert.equal(parseFtaDate(null), null);
    assert.equal(parseFtaDate(undefined), null);
    assert.equal(parseFtaDate(12345678), null, '纯数字无 FTA 前缀');
  });
});

// ---- ② weekTag ISO 8601 基准四元组（✅ Q2 写死）-------------------------

test.describe('engine-week-utils — weekTag ISO 8601 基准四元组', () => {
  test('2026-06-02 → 2623（需求例）', () => {
    assert.equal(weekTag('2026-06-02'), '2623');
  });

  test('2026-01-01 → 2601（周四，归 2026-W01）', () => {
    assert.equal(weekTag('2026-01-01'), '2601');
  });

  test('🔴 2025-12-29 → 2601（周一，ISO week-year=2026，与日历年 2025 分叉）', () => {
    assert.equal(weekTag('2025-12-29'), '2601');
  });

  test('🔴 2027-01-01 → 2653（周五，ISO week-year=2026 第 53 周，与日历年 2027 分叉）', () => {
    assert.equal(weekTag('2027-01-01'), '2653');
  });

  test('2026-12-31 → 2653（2026 是 ISO 53 周年）', () => {
    assert.equal(weekTag('2026-12-31'), '2653');
  });

  test('FTA202606021000477 派生日期的 weekTag = 2623（需求例端到端）', () => {
    assert.equal(weekTag(parseFtaDate('FTA202606021000477')), '2623');
  });

  test('无法解析日期 → null', () => {
    assert.equal(weekTag('not-a-date'), null);
    assert.equal(weekTag(null), null);
  });
});

// ---- ③ weekTagPlusOne 日期语义（+7 天所在周；禁 YYWW 数字加法）---------

test.describe('engine-week-utils — weekTagPlusOne（日期语义 +7 天所在周）', () => {
  test('普通周内 +1：2026-06-02（2623）→ 2624', () => {
    assert.equal(weekTagPlusOne('2026-06-02'), '2624');
  });

  test('🔴 年末进位：2026-12-31（2653）+1 → 2701（日期语义；YYWW 数字加法 2653+1=2654 不存在）', () => {
    assert.equal(weekTagPlusOne('2026-12-31'), '2701');
    // 反证：若用 YYWW 数字加法会得 '2654'（错误），这里必须是 '2701'
    assert.notEqual(weekTagPlusOne('2026-12-31'), '2654');
  });

  test('跨年初进位：2025-12-29（2601）+1 → 2602', () => {
    assert.equal(weekTagPlusOne('2025-12-29'), '2602');
  });

  test('无法解析日期 → null', () => {
    assert.equal(weekTagPlusOne('xx'), null);
  });
});

// ---- weekTagToNumber 辅助 ----------------------------------------------

test.describe('engine-week-utils — weekTagToNumber', () => {
  test("'2623' → 2623（number）；非法 → null", () => {
    assert.equal(weekTagToNumber('2623'), 2623);
    assert.equal(weekTagToNumber('2701'), 2701);
    assert.equal(weekTagToNumber(null), null);
    assert.equal(weekTagToNumber('26'), null, '非 4 位 → null');
    assert.equal(weekTagToNumber('abcd'), null);
  });

  test('订单周 +1 后 number = 银行周 number（join 语义自洽）', () => {
    // 订单 2026-06-02 → 2623；银行应落 2624 桶
    const orderWeekPlusOne = weekTagToNumber(weekTagPlusOne('2026-06-02'));
    const bankWeek = weekTagToNumber(weekTag('2026-06-09')); // 落在 2624 周
    assert.equal(orderWeekPlusOne, 2624);
    assert.equal(bankWeek, 2624);
    assert.equal(orderWeekPlusOne, bankWeek);
  });
});
