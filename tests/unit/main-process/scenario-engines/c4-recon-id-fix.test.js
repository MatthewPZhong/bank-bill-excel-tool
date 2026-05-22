const test = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeBillDateValue,
  parseBillDateMs
} = require('../../../../src/main-process/scenario-engines/c4-recon-id-fix');

// ========================================================================
// v2.1.8 F5 T08 — BillDate 字符串化（gateway 子模式 createTime → BillDate）
// ========================================================================

test.describe('normalizeBillDateValue — Excel 序列号 → ISO 字符串', () => {
  test('空值（null / undefined / 空字符串）→ 空字符串', () => {
    assert.equal(normalizeBillDateValue(null), '');
    assert.equal(normalizeBillDateValue(undefined), '');
    assert.equal(normalizeBillDateValue(''), '');
  });

  test('Excel 序列号（number）→ YYYY-MM-DD', () => {
    // Excel epoch 1899-12-30
    // 1 → 1899-12-31
    assert.equal(normalizeBillDateValue(1), '1899-12-31');
    // 2 → 1900-01-01（受 1900 闰年 bug 影响，常见 Excel 实际显示 1900-01-01）
    assert.equal(normalizeBillDateValue(2), '1900-01-01');
  });

  test('Excel 序列号 — 2026-05-22（验算：与 XLSX.SSF.parse_date_code 一致）', () => {
    // (Date.UTC(2026,4,22) - Date.UTC(1899,11,30)) / 86400000 = 46164
    // XLSX.SSF.parse_date_code(46164) = { y:2026, m:5, d:22 } ✓ 算法一致
    assert.equal(normalizeBillDateValue(46164), '2026-05-22');
  });

  test('Excel 序列号 — F5-TEST2.xlsx createTime 首行实测', () => {
    // 实测 F5-TEST2.xlsx 渠道账单 sheet createTime[0] = 46148.21988（含小数时间）
    // 整数部分 46148 → 2026-05-06
    assert.equal(normalizeBillDateValue(46148.21988), '2026-05-06');
    assert.equal(normalizeBillDateValue(46148), '2026-05-06');
  });

  test('Excel 序列号 — 现代日期范围若干', () => {
    // 2020-01-01：(UTC(2020,0,1) - UTC(1899,11,30)) / 86400000 = 43831
    assert.equal(normalizeBillDateValue(43831), '2020-01-01');
    // 2026-01-01：(UTC(2026,0,1) - UTC(1899,11,30)) / 86400000 = 46023
    assert.equal(normalizeBillDateValue(46023), '2026-01-01');
  });

  test('小数序列号 → 取整数部分（忽略时间）', () => {
    // 46164.5 = 2026-05-22 中午（Excel 习惯）→ 仍输出 2026-05-22
    assert.equal(normalizeBillDateValue(46164.5), '2026-05-22');
    assert.equal(normalizeBillDateValue(46164.99), '2026-05-22');
  });

  test('字符串已是 YYYY-MM-DD → 原样返回', () => {
    assert.equal(normalizeBillDateValue('2026-05-22'), '2026-05-22');
    assert.equal(normalizeBillDateValue('2020-01-01'), '2020-01-01');
  });

  test('字符串 YYYY/MM/DD → 原样（让 parseBillDateMs 处理）', () => {
    assert.equal(normalizeBillDateValue('2026/05/22'), '2026/05/22');
  });

  test('非数字非字符串 → toString', () => {
    // Boolean / 对象等异常类型，做 String() fallback（让上游 parseBillDateMs 返回 null）
    assert.equal(normalizeBillDateValue(true), 'true');
  });

  test('Infinity / NaN → 空字符串（避免无效日期写入）', () => {
    assert.equal(normalizeBillDateValue(Infinity), '');
    assert.equal(normalizeBillDateValue(-Infinity), '');
    assert.equal(normalizeBillDateValue(NaN), '');
  });
});

test.describe('normalizeBillDateValue + parseBillDateMs 联调（F5 端到端）', () => {
  test('Excel 序列号 46164 → "2026-05-22" → parseBillDateMs 返回有效 ms', () => {
    const billDate = normalizeBillDateValue(46164);
    const ms = parseBillDateMs(billDate);
    assert.ok(ms !== null);
    assert.equal(ms, Date.UTC(2026, 4, 22));
  });

  test('v2.1.6 现状回归：字符串 "2026-05-22" 直接 parseBillDateMs 仍 OK', () => {
    // 不该破坏已有字符串日期的解析能力
    const ms = parseBillDateMs('2026-05-22');
    assert.equal(ms, Date.UTC(2026, 4, 22));
  });

  test('v2.1.7 根因复现：number 46164 直接 parseBillDateMs → null（必须经 normalizeBillDateValue）', () => {
    // 验证：不经过 normalizeBillDateValue 的 number 序列号 → parseBillDateMs fail
    // 这是 v2.1.7 F5 单点 fix 仅修 28 行的根因；T08 修复此 case
    const directParse = parseBillDateMs(46164);
    assert.equal(directParse, null);
    // 经 normalize 后 parseBillDateMs 成功
    const indirectParse = parseBillDateMs(normalizeBillDateValue(46164));
    assert.ok(indirectParse !== null);
    assert.equal(indirectParse, Date.UTC(2026, 4, 22));
  });

  test('空值 → normalize 后仍是空 → parseBillDateMs 返回 null（保持现状）', () => {
    assert.equal(parseBillDateMs(normalizeBillDateValue(null)), null);
    assert.equal(parseBillDateMs(normalizeBillDateValue('')), null);
  });
});
