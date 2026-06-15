// v2.1.16-beta.2 T2：engine-date-utils（5 轮对账日期工具）单测
//
// 覆盖（TECH_DESIGN §5.3）：
//   - toDate：Excel 序列号（46155）/ 字符串（'2026-03-10'、'2026/03/10'）/ null / 空 / 无效
//   - sameDay：同日 true、差 1 天 false、跨格式同日 true、任一 null false
//   - dayDiffWithin(.,.,1)：差 0/1 true、差 2 false、跨格式、序列号、任一 null false
//
// 断言用「本地年-月-日」分量比对（不用 toISOString —— .date 为本地午夜，转 UTC 显示会因时区回退一天，
//   仅是显示效应，本地年月日才是真相）。日期解析复用 normalizers.normalizeDateExportValue（见被测文件）。

const test = require('node:test');
const assert = require('node:assert/strict');

const { toDate, sameDay, dayDiffWithin, signedDayDiff } = require('../../../../src/main-process/scenario-engines/engine-date-utils');

// 取本地年-月-日（与 toDate 的本地午夜口径一致）
function localYmd(d) {
  if (!d) return null;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

test.describe('engine-date-utils.toDate', () => {
  test('Excel 序列号 46155 → 本地 2026-05-13（复用 normalizeDateExportValue）', () => {
    const d = toDate(46155);
    assert.ok(d instanceof Date && !Number.isNaN(d.getTime()), '应得有效 Date');
    assert.equal(localYmd(d), '2026-05-13');
  });

  test('字符串 2026-03-10（短横）→ 本地 2026-03-10', () => {
    assert.equal(localYmd(toDate('2026-03-10')), '2026-03-10');
  });

  test('字符串 2026/03/10（斜杠）→ 本地 2026-03-10（与短横同日）', () => {
    assert.equal(localYmd(toDate('2026/03/10')), '2026-03-10');
  });

  test('null / undefined / 空串 / 无效串 → null', () => {
    assert.equal(toDate(null), null);
    assert.equal(toDate(undefined), null);
    assert.equal(toDate(''), null);
    assert.equal(toDate('not-a-date'), null);
  });

  test('Date 实例直接传入 → 归一为本地午夜（保留年月日）', () => {
    const d = toDate(new Date(2026, 2, 10, 15, 30, 0)); // 2026-03-10 15:30
    assert.equal(localYmd(d), '2026-03-10');
    assert.equal(d.getHours(), 0, '时分秒归零');
  });
});

test.describe('engine-date-utils.sameDay', () => {
  test('同日（同格式）→ true', () => {
    assert.equal(sameDay('2026-03-10', '2026-03-10'), true);
  });

  test('差 1 天 → false', () => {
    assert.equal(sameDay('2026-03-10', '2026-03-11'), false);
  });

  test('跨格式同日（短横 vs 斜杠）→ true', () => {
    assert.equal(sameDay('2026-03-10', '2026/03/10'), true);
  });

  test('Excel 序列号 vs 同日字符串 → true', () => {
    assert.equal(sameDay(46155, '2026/05/13'), true);
  });

  test('任一无法解析（null / 空 / 无效）→ false', () => {
    assert.equal(sameDay('2026-03-10', null), false);
    assert.equal(sameDay(null, '2026-03-10'), false);
    assert.equal(sameDay('2026-03-10', ''), false);
    assert.equal(sameDay('not-a-date', '2026-03-10'), false);
    assert.equal(sameDay(null, null), false);
  });
});

test.describe('engine-date-utils.dayDiffWithin(., ., 1)', () => {
  test('差 0 天 → true', () => {
    assert.equal(dayDiffWithin('2026-03-10', '2026-03-10', 1), true);
  });

  test('差 1 天（任一方向）→ true', () => {
    assert.equal(dayDiffWithin('2026-03-10', '2026-03-11', 1), true);
    assert.equal(dayDiffWithin('2026-03-11', '2026-03-10', 1), true);
  });

  test('差 2 天 → false', () => {
    assert.equal(dayDiffWithin('2026-03-10', '2026-03-12', 1), false);
  });

  test('跨格式差 1 天 → true（短横 vs 斜杠）', () => {
    assert.equal(dayDiffWithin('2026-03-10', '2026/03/11', 1), true);
  });

  test('Excel 序列号差 1 天 → true', () => {
    assert.equal(dayDiffWithin(46155, 46156, 1), true);
  });

  test('任一无法解析 → false', () => {
    assert.equal(dayDiffWithin(null, '2026-03-10', 1), false);
    assert.equal(dayDiffWithin('2026-03-10', '', 1), false);
    assert.equal(dayDiffWithin('not-a-date', '2026-03-10', 1), false);
  });

  test('n=0 时仅同日为 true（边界）', () => {
    assert.equal(dayDiffWithin('2026-03-10', '2026-03-10', 0), true);
    assert.equal(dayDiffWithin('2026-03-10', '2026-03-11', 0), false);
  });
});

test.describe('engine-date-utils.signedDayDiff（R4：保留方向，不取 abs）', () => {
  test('a 晚于 b → 正数', () => {
    assert.equal(signedDayDiff('2026-03-15', '2026-03-10'), 5);
  });
  test('a 早于 b → 负数（与 dayDiffWithin 的 abs 不同）', () => {
    assert.equal(signedDayDiff('2026-03-10', '2026-03-15'), -5);
  });
  test('同日 → 0', () => {
    assert.equal(signedDayDiff('2026-03-10', '2026-03-10'), 0);
  });
  test('跨格式 / Excel 序列号方向正确', () => {
    assert.equal(signedDayDiff('2026/03/15', '2026-03-10'), 5);
    assert.equal(signedDayDiff(46156, 46155), 1);
  });
  test('任一无法解析 → null', () => {
    assert.equal(signedDayDiff(null, '2026-03-10'), null);
    assert.equal(signedDayDiff('2026-03-10', ''), null);
    assert.equal(signedDayDiff('not-a-date', '2026-03-10'), null);
  });
});
