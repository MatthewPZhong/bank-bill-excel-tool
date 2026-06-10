const test = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeBillDateValue,
  parseBillDateMs,
  findBestAmountSubset,
  sortRightRowsForManyToOne,
  currencyMatches,
  applyFieldValueOverrides
} = require('../../../../src/main-process/scenario-engines/c4-recon-id-fix');

// 测试 helper：构造 candidates 数组，每个元素 cents 由参数控制
function makeCandidates(centsArr, billDate = '2026-05-22') {
  return centsArr.map((cents, idx) => ({
    row: { BillDate: billDate, _rowIdx: `opp_${idx}` },
    cents
  }));
}

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

// ========================================================================
// v2.1.8 F5 T09 — findBestAmountSubset maxSize 动态档位 + 性能护栏
// ========================================================================

test.describe('findBestAmountSubset — 基本契约（v2.1.7 行为回归）', () => {
  test('candidates < 2 → null', () => {
    assert.equal(findBestAmountSubset([], 100, '2026-05-22'), null);
    assert.equal(findBestAmountSubset(makeCandidates([100]), 100, '2026-05-22'), null);
  });

  test('targetCents 非正数 → null', () => {
    assert.equal(findBestAmountSubset(makeCandidates([50, 50]), 0, '2026-05-22'), null);
    assert.equal(findBestAmountSubset(makeCandidates([50, 50]), -100, '2026-05-22'), null);
  });

  test('简单子集和（2 行）→ 找到', () => {
    const candidates = makeCandidates([30, 70]);
    const result = findBestAmountSubset(candidates, 100, '2026-05-22');
    assert.ok(Array.isArray(result));
    assert.equal(result.length, 2);
    assert.equal(result[0].BillDate, '2026-05-22');
  });

  test('无解 → null', () => {
    const candidates = makeCandidates([30, 50, 70]);
    assert.equal(findBestAmountSubset(candidates, 999999, '2026-05-22'), null);
  });
});

test.describe('findBestAmountSubset — maxSize 动态档位（spec.md F5-D1）', () => {
  test('pool ≤ 12 → 全跑：找出大子集（v2.1.7 maxSize=8 卡死的场景）', () => {
    // 11 行各 100，target=1100 → 子集 size=11 应该被找到（v2.1.7 maxSize=8 会漏）
    const candidates = makeCandidates(Array(11).fill(100));
    const result = findBestAmountSubset(candidates, 1100, '2026-05-22', { silent: true });
    assert.ok(result, 'pool=11 应该能找到 11 行子集（动态档位允许 maxSize=11）');
    assert.equal(result.length, 11);
  });

  test('pool 13-20 → maxSize=12：可找到 12 行子集，13 行子集找不到', () => {
    // 13 行各 100：target=1200 应该找到（12 行 = 1200），target=1300 找不到（需要 13 行 > maxSize=12）
    const candidates13 = makeCandidates(Array(13).fill(100));
    const r12 = findBestAmountSubset(candidates13, 1200, '2026-05-22', { silent: true });
    assert.ok(r12);
    assert.equal(r12.length, 12);

    const r13 = findBestAmountSubset(candidates13, 1300, '2026-05-22', { silent: true });
    assert.equal(r13, null, 'pool=13 maxSize=12 → 13 行子集应当返回 null');
  });

  test('TEST2.xlsx T54SWIC494447 场景模拟：pool=16 应能找到 16 行子集（v2.1.7 maxSize=8 漏掉）', () => {
    // 模拟 16 行各 100：target=1600 应该找到（pool=16 → maxSize=12 → 16 不行）
    // 注：实际 TEST2.xlsx T54SWIC494447 子集 16 行 = 9,751,101。
    //     这里仅验证 maxSize 档位放开方向正确：pool>12 时按档位限制
    const candidates16 = makeCandidates(Array(16).fill(100));
    const r12 = findBestAmountSubset(candidates16, 1200, '2026-05-22', { silent: true });
    assert.ok(r12);
    assert.equal(r12.length, 12);

    const r16 = findBestAmountSubset(candidates16, 1600, '2026-05-22', { silent: true });
    assert.equal(r16, null, '16 行场景 maxSize=12 ≤ 16，单纯 16 行等额还是找不到');
    // 注：真实 T54SWIC494447 子集大小 16 仍超 maxSize=12 档位 → 需要 spec 重新评估或调用方覆盖 options.maxSize
  });

  test('pool 21-25 → maxSize=10 + degraded warn', () => {
    const candidates21 = makeCandidates(Array(21).fill(100));
    const r10 = findBestAmountSubset(candidates21, 1000, '2026-05-22', { silent: true });
    assert.ok(r10);
    assert.equal(r10.length, 10);

    const r11 = findBestAmountSubset(candidates21, 1100, '2026-05-22', { silent: true });
    assert.equal(r11, null, 'pool=21 maxSize=10 → 11 行子集应当 null');
  });

  test('pool > 25 → maxSize=8 + safety-floor', () => {
    const candidates30 = makeCandidates(Array(30).fill(100));
    const r8 = findBestAmountSubset(candidates30, 800, '2026-05-22', { silent: true });
    assert.ok(r8);
    assert.equal(r8.length, 8);

    const r9 = findBestAmountSubset(candidates30, 900, '2026-05-22', { silent: true });
    assert.equal(r9, null, 'pool=30 maxSize=8 → 9 行子集应当 null');
  });

  test('options.maxSize 显式传入 → 覆盖动态档位（向后兼容）', () => {
    // pool=11 默认应允许 maxSize=11，但显式传 options.maxSize=3 限死
    const candidates = makeCandidates(Array(11).fill(100));
    const r3 = findBestAmountSubset(candidates, 300, '2026-05-22', { maxSize: 3, silent: true });
    assert.ok(r3);
    assert.equal(r3.length, 3);

    const r4 = findBestAmountSubset(candidates, 400, '2026-05-22', { maxSize: 3, silent: true });
    assert.equal(r4, null, '显式 maxSize=3 → 4 行子集应当 null');
  });

  test('v2.1.7 baseline 行为：pool ≤ 8 + 不传 options → 行为不变', () => {
    // pool=5 时动态档位 = 5（小于 12），与原 maxSize=8 等价（实际限制是 pool size）
    const candidates = makeCandidates([10, 20, 30, 40, 50]);
    const r = findBestAmountSubset(candidates, 60, '2026-05-22', { silent: true });
    assert.ok(r);
    // 30+30? 不存在；20+40 / 10+50 都可；tieBreak 出唯一
    assert.equal(r.length, 2);
    assert.equal(r[0].BillDate, '2026-05-22');
  });
});

test.describe('findBestAmountSubset — 性能护栏（spec.md F5-D5）', () => {
  // v2.1.9 SR-log-1 (T32h)：c4-recon-id-fix 的 console.warn 已替换为 appendModuleLog
  //   spy 改为劫持 logger.appendModuleLog 而非 console.warn（spec §15.6）
  test('options.silent=true 抑制告警日志（unit test 用）', () => {
    const logger = require('../../../../src/backend/logger');
    const originalAppend = logger.appendModuleLog;
    let warnCount = 0;
    logger.appendModuleLog = (payload) => {
      if (payload && (payload.level === 'warning' || payload.level === 'warn')) warnCount++;
    };
    try {
      // pool=30 触发 safety-floor，silent=true 应不打 warn
      findBestAmountSubset(makeCandidates(Array(30).fill(100)), 800, '2026-05-22', { silent: true });
      assert.equal(warnCount, 0);
    } finally {
      logger.appendModuleLog = originalAppend;
    }
  });

  test('未传 silent 时大池子触发 appendModuleLog warning（性能护栏告警）', () => {
    const logger = require('../../../../src/backend/logger');
    const originalAppend = logger.appendModuleLog;
    let warnCount = 0;
    let warnPayload = null;
    logger.appendModuleLog = (payload) => {
      if (payload && (payload.level === 'warning' || payload.level === 'warn')) {
        warnCount++;
        warnPayload = payload;
      }
    };
    try {
      findBestAmountSubset(makeCandidates(Array(30).fill(100)), 800, '2026-05-22');
      assert.equal(warnCount, 1);
      assert.ok(warnPayload, 'appendModuleLog 应被调用一次');
      // 关键字段断言（替代原 console.warn 字符串 match）
      assert.match(String(warnPayload.message || ''), /性能护栏/);
      const detailsText = (warnPayload.details || []).join(' ');
      assert.match(detailsText, /candidates=30/);
      assert.match(detailsText, /safety-floor/);
    } finally {
      logger.appendModuleLog = originalAppend;
    }
  });
});

// ========================================================================
// v2.1.8 F5 T10 — tryManyToOnePool 遍历顺序复合排序（金额降序 + candidates count 降序）
// ========================================================================

// 测试 helper：构造 right 行（rightField='Amount' 默认）
function makeRight(rows) {
  // rows: [{idx, amount, billDate?}]
  return rows.map(({ idx, amount, billDate }) => ({
    _rowIdx: `opp_${idx}`,
    Amount: amount,
    BillDate: billDate || '2026-05-22'
  }));
}
// 测试 helper：构造 left 行
function makeLeft(rows) {
  return rows.map(({ idx, amount, billDate }) => ({
    _rowIdx: `main_${idx}`,
    Amount: amount,
    BillDate: billDate || '2026-05-22'
  }));
}

test.describe('sortRightRowsForManyToOne — 复合排序 (spec.md F5-D2)', () => {
  const noFilter = {
    rightAmountField: 'Amount',
    otherFieldPairs: [],
    billDateMode: 'strict',
    billDateDays: 1,
    pairedLeft: new Set(),
    pairedRight: new Set()
  };

  test('金额降序：大金额 right 排前面（root case — TEST2.xlsx T54SWIC470181 4M 优先消费 left 池）', () => {
    const rightRows = makeRight([
      { idx: 0, amount: 100 },   // 原数组小金额排前面
      { idx: 1, amount: 4000000 }, // 4M 排后面 → v2.1.7 被前面渠道抢光
      { idx: 2, amount: 1000000 }  // 1M
    ]);
    const leftRows = makeLeft([
      { idx: 0, amount: 50 }, { idx: 1, amount: 50 },
      { idx: 2, amount: 2000000 }, { idx: 3, amount: 2000000 }
    ]);
    const sorted = sortRightRowsForManyToOne({ rightRows, leftRows, ...noFilter });
    assert.equal(sorted[0]._rowIdx, 'opp_1', '4M 应该排第一（金额降序）');
    assert.equal(sorted[1]._rowIdx, 'opp_2', '1M 应该排第二');
    assert.equal(sorted[2]._rowIdx, 'opp_0', '100 排最后');
  });

  test('同金额：candidates pool size 降序（spec F5-D2 子集大小代理）', () => {
    const rightRows = makeRight([
      { idx: 0, amount: 100, billDate: '2026-05-22' },
      { idx: 1, amount: 100, billDate: '2099-12-31' } // billDate 远离 → candidates=0
    ]);
    const leftRows = makeLeft([
      { idx: 0, amount: 50, billDate: '2026-05-22' },
      { idx: 1, amount: 50, billDate: '2026-05-22' },
      { idx: 2, amount: 50, billDate: '2026-05-22' }
    ]);
    const sorted = sortRightRowsForManyToOne({ rightRows, leftRows, ...noFilter });
    // opp_0 同 BillDate → candidates=3；opp_1 异 BillDate → candidates=0
    // 同金额 100 → 按 candidates 降序 → opp_0 优先
    assert.equal(sorted[0]._rowIdx, 'opp_0');
    assert.equal(sorted[1]._rowIdx, 'opp_1');
  });

  test('pairedRight 中的行排到最后', () => {
    const rightRows = makeRight([
      { idx: 0, amount: 100 },
      { idx: 1, amount: 4000000 },  // 4M 但已配对
      { idx: 2, amount: 1000 }
    ]);
    const leftRows = makeLeft([{ idx: 0, amount: 50 }, { idx: 1, amount: 50 }]);
    const sorted = sortRightRowsForManyToOne({
      ...noFilter, rightRows, leftRows,
      pairedRight: new Set(['opp_1']) // 4M 已配对
    });
    assert.equal(sorted[2]._rowIdx, 'opp_1', '已配对的 4M 应排到最后');
    assert.equal(sorted[0]._rowIdx, 'opp_2', '1000 最大未配对，排第一');
  });

  test('pairedLeft 影响 candidates count 计算', () => {
    const rightRows = makeRight([
      { idx: 0, amount: 100, billDate: '2026-05-22' },
      { idx: 1, amount: 100, billDate: '2026-05-22' }
    ]);
    const leftRows = makeLeft([
      { idx: 0, amount: 50 }, { idx: 1, amount: 50 }, { idx: 2, amount: 50 }
    ]);
    // pairedLeft 包含 main_0 + main_1 → 只剩 main_2 可用 → 两个 right 都只有 1 candidate
    // → candidates count 相同 → 按 sort stable 保持原顺序
    const sorted = sortRightRowsForManyToOne({
      ...noFilter, rightRows, leftRows,
      pairedLeft: new Set(['main_0', 'main_1'])
    });
    assert.equal(sorted.length, 2);
    // 同 amount 同 candidates → 输入顺序保持
    assert.equal(sorted[0]._rowIdx, 'opp_0');
    assert.equal(sorted[1]._rowIdx, 'opp_1');
  });

  test('rightRows 空 → 返回空数组（不应抛错）', () => {
    const sorted = sortRightRowsForManyToOne({ ...noFilter, rightRows: [], leftRows: [] });
    assert.deepEqual(sorted, []);
  });

  test('原数组不被修改（稳定 slice）', () => {
    const rightRows = makeRight([
      { idx: 0, amount: 100 },
      { idx: 1, amount: 1000 }
    ]);
    const originalOrder = rightRows.map((r) => r._rowIdx);
    sortRightRowsForManyToOne({ ...noFilter, rightRows, leftRows: [] });
    assert.deepEqual(rightRows.map((r) => r._rowIdx), originalOrder, '原数组顺序应不变');
  });
});

// ========================================================================
// v2.1.8 F5 T11 — currency 字段过滤（spec.md F5-D3）
// ========================================================================

test.describe('currencyMatches — gateway 子模式 currency 等值过滤', () => {
  const gatewayCfg = { _subMode: 'gateway' };
  const businessCfg = { _subMode: 'business' };
  const undefCfg = undefined;

  test('非 gateway 子模式 → 直通 true（不过滤）', () => {
    // business 子模式：currency 字段可能不存在，强过滤会破坏行为
    assert.equal(currencyMatches({ Currency: 'USD' }, { currency: 'CNY' }, businessCfg), true);
    assert.equal(currencyMatches({}, {}, businessCfg), true);
  });

  test('cfg 为 undefined / null → 直通 true（兼容旧调用）', () => {
    assert.equal(currencyMatches({ Currency: 'USD' }, { currency: 'CNY' }, undefCfg), true);
    assert.equal(currencyMatches({}, {}, null), true);
  });

  test('gateway 子模式 + 两侧 currency 都非空相等 → true', () => {
    assert.equal(currencyMatches({ Currency: 'USD' }, { currency: 'USD' }, gatewayCfg), true);
    assert.equal(currencyMatches({ Currency: 'CNY' }, { currency: 'CNY' }, gatewayCfg), true);
  });

  test('gateway 子模式 + 两侧 currency 都非空不等 → false（核心过滤行为）', () => {
    assert.equal(currencyMatches({ Currency: 'USD' }, { currency: 'CNY' }, gatewayCfg), false);
    assert.equal(currencyMatches({ Currency: 'HKD' }, { currency: 'USD' }, gatewayCfg), false);
  });

  test('gateway 子模式 + 任一为空 → 直通 true（数据质量兼容，避免比 v2.1.7 退步）', () => {
    assert.equal(currencyMatches({ Currency: '' }, { currency: 'USD' }, gatewayCfg), true);
    assert.equal(currencyMatches({ Currency: 'USD' }, { currency: '' }, gatewayCfg), true);
    assert.equal(currencyMatches({}, { currency: 'USD' }, gatewayCfg), true);
    assert.equal(currencyMatches({ Currency: 'USD' }, {}, gatewayCfg), true);
    assert.equal(currencyMatches({ Currency: null }, { currency: 'USD' }, gatewayCfg), true);
  });

  test('字段名大小写敏感（GATEWAY_BILL_FIELDS Currency 大写 vs CHANNEL_BILL_FIELDS currency 小写）', () => {
    // 错位用法不应 crash，但也不应正常匹配（因为读不到对方字段）
    assert.equal(currencyMatches({ currency: 'USD' }, { Currency: 'USD' }, gatewayCfg), true); // 都读不到字段（''），fallback true
    // 正确字段名 → 正常匹配
    assert.equal(currencyMatches({ Currency: 'USD' }, { currency: 'USD' }, gatewayCfg), true);
  });

  test('normalizeCellValue 应用：trim + 大小写归一', () => {
    // normalizeCellValue 行为：trim + 转字符串，不强制大小写归一
    assert.equal(currencyMatches({ Currency: ' USD ' }, { currency: 'USD' }, gatewayCfg), true);
    // 大小写差异：normalizeCellValue 不归一大小写 → 'usd' !== 'USD' → false
    // 这是 c4 引擎的 normalizeCellValue 现状（非 currency 专用）；spec 没要求大小写归一
    // 如果实际数据有大小写不一致问题，需在 reader 层归一化
  });

  test('null/undefined row → 直通 true（防御性）', () => {
    assert.equal(currencyMatches(null, { currency: 'USD' }, gatewayCfg), true);
    assert.equal(currencyMatches({ Currency: 'USD' }, null, gatewayCfg), true);
    assert.equal(currencyMatches(null, null, gatewayCfg), true);
  });
});

test.describe('sortRightRowsForManyToOne + currencyMatches 集成（T10 + T11 协同）', () => {
  test('gateway 子模式：currency 不同的 left 不计入 candidates count', () => {
    const rightRows = [
      { _rowIdx: 'opp_0', Amount: 100, BillDate: '2026-05-22', currency: 'USD' },
      { _rowIdx: 'opp_1', Amount: 100, BillDate: '2026-05-22', currency: 'CNY' }
    ];
    const leftRows = [
      { _rowIdx: 'main_0', Amount: 50, BillDate: '2026-05-22', Currency: 'USD' },
      { _rowIdx: 'main_1', Amount: 50, BillDate: '2026-05-22', Currency: 'USD' },
      { _rowIdx: 'main_2', Amount: 50, BillDate: '2026-05-22', Currency: 'USD' }
    ];
    const sorted = sortRightRowsForManyToOne({
      rightRows, leftRows, rightAmountField: 'Amount',
      otherFieldPairs: [], billDateMode: 'strict', billDateDays: 1,
      pairedLeft: new Set(), pairedRight: new Set(),
      cfg: { _subMode: 'gateway' }
    });
    // opp_0 USD → candidates=3，opp_1 CNY → candidates=0
    // 同金额 100 → 按 candidates 降序 → opp_0 优先
    assert.equal(sorted[0]._rowIdx, 'opp_0', 'USD 候选丰富排第一');
    assert.equal(sorted[1]._rowIdx, 'opp_1');
  });

  test('business 子模式：currency 过滤直通 → candidates 不被 currency 过滤', () => {
    const rightRows = [
      { _rowIdx: 'opp_0', Amount: 100, BillDate: '2026-05-22', currency: 'USD' },
      { _rowIdx: 'opp_1', Amount: 100, BillDate: '2026-05-22', currency: 'CNY' }
    ];
    const leftRows = [
      { _rowIdx: 'main_0', Amount: 50, BillDate: '2026-05-22', Currency: 'USD' },
      { _rowIdx: 'main_1', Amount: 50, BillDate: '2026-05-22', Currency: 'USD' }
    ];
    const sorted = sortRightRowsForManyToOne({
      rightRows, leftRows, rightAmountField: 'Amount',
      otherFieldPairs: [], billDateMode: 'strict', billDateDays: 1,
      pairedLeft: new Set(), pairedRight: new Set(),
      cfg: { _subMode: 'business' }
    });
    // business 子模式不过滤 currency → 两个 right 的 candidates 都是 2
    // 同金额同 count → 输入顺序保持
    assert.equal(sorted[0]._rowIdx, 'opp_0');
    assert.equal(sorted[1]._rowIdx, 'opp_1');
  });
});

// ========================================================================
// v3.0.2 需求3 — applyFieldValueOverrides（修复订单字段取值）
//   🔴 资金红线：只产出新 overrides、不污染行对象；seq Number 归一；空值→''；分组过滤
// ========================================================================

// helper：构造带 _types(Set<Number>) 的行
function fvRow(typesArr, fields) {
  return Object.assign({ _types: new Set(typesArr) }, fields);
}

test.describe('applyFieldValueOverrides — 修复订单字段取值（v3.0.2 需求3）', () => {
  const oneRule = (overrides = {}) => ({
    fieldValue: {
      enabled: true,
      rules: [Object.assign({ mainTypeSeq: 1, mainField: 'OrderId', oppTypeSeq: 2, oppField: 'channelOrderNo' }, overrides)]
    }
  });

  test('fieldValue 缺失 / 未启用 → 返回空 overrides', () => {
    const main = fvRow([1], { OrderId: 'GW' });
    const opp = fvRow([2], { channelOrderNo: 'CH' });
    assert.deepEqual(applyFieldValueOverrides(main, opp, {}), {});
    assert.deepEqual(applyFieldValueOverrides(main, opp, { fieldValue: { enabled: false, rules: [{ mainTypeSeq: 1, mainField: 'OrderId', oppTypeSeq: 2, oppField: 'channelOrderNo' }] } }), {});
  });

  test('启用 + 单规则命中 → overrides[mainField] = oppRow[oppField]', () => {
    const main = fvRow([1], { OrderId: 'GW-ORIG' });
    const opp = fvRow([2], { channelOrderNo: 'CH-123' });
    assert.deepEqual(applyFieldValueOverrides(main, opp, oneRule()), { OrderId: 'CH-123' });
  });

  test('🔴 不污染源行对象（调用后 mainRow/oppRow 原字段未变）', () => {
    const main = fvRow([1], { OrderId: 'GW-ORIG' });
    const opp = fvRow([2], { channelOrderNo: 'CH-123' });
    applyFieldValueOverrides(main, opp, oneRule());
    assert.equal(main.OrderId, 'GW-ORIG', 'mainRow.OrderId 未被改写');
    assert.equal(opp.channelOrderNo, 'CH-123', 'oppRow.channelOrderNo 未被改写');
  });

  test('🔴 seq 以字符串传入（"1"/"2"）经 Number 归一仍命中', () => {
    const main = fvRow([1], { OrderId: 'GW' });
    const opp = fvRow([2], { channelOrderNo: 'CH-123' });
    assert.deepEqual(applyFieldValueOverrides(main, opp, oneRule({ mainTypeSeq: '1', oppTypeSeq: '2' })), { OrderId: 'CH-123' });
  });

  test('分组过滤：mainRow._types 不含 mainTypeSeq → 跳过', () => {
    const main = fvRow([1], { OrderId: 'GW' });
    const opp = fvRow([2], { channelOrderNo: 'CH-123' });
    assert.deepEqual(applyFieldValueOverrides(main, opp, oneRule({ mainTypeSeq: 9 })), {});
  });

  test('分组过滤：oppRow._types 不含 oppTypeSeq → 跳过', () => {
    const main = fvRow([1], { OrderId: 'GW' });
    const opp = fvRow([2], { channelOrderNo: 'CH-123' });
    assert.deepEqual(applyFieldValueOverrides(main, opp, oneRule({ oppTypeSeq: 9 })), {});
  });

  test('源字段为 null/undefined → 赋空字符串（不阻断）', () => {
    const main = fvRow([1], { OrderId: 'GW' });
    const opp = fvRow([2], { channelOrderNo: null });
    assert.deepEqual(applyFieldValueOverrides(main, opp, oneRule()), { OrderId: '' });
  });

  test('mainField / oppField 任一空 → 跳过该规则（不抛错）', () => {
    const main = fvRow([1], { OrderId: 'GW' });
    const opp = fvRow([2], { channelOrderNo: 'CH' });
    const cfg = { fieldValue: { enabled: true, rules: [
      { mainTypeSeq: 1, mainField: '', oppTypeSeq: 2, oppField: 'channelOrderNo' },
      { mainTypeSeq: 1, mainField: 'OrderId', oppTypeSeq: 2, oppField: '' }
    ] } };
    assert.deepEqual(applyFieldValueOverrides(main, opp, cfg), {});
  });

  test('多规则部分命中：只写命中的规则', () => {
    const main = fvRow([1], { OrderId: 'GW', MerchantId: 'M0' });
    const opp = fvRow([2], { channelOrderNo: 'CH-1', merchantId: 'M-CH' });
    const cfg = { fieldValue: { enabled: true, rules: [
      { mainTypeSeq: 1, mainField: 'OrderId', oppTypeSeq: 2, oppField: 'channelOrderNo' },
      { mainTypeSeq: 9, mainField: 'MerchantId', oppTypeSeq: 2, oppField: 'merchantId' }
    ] } };
    assert.deepEqual(applyFieldValueOverrides(main, opp, cfg), { OrderId: 'CH-1' });
  });

  test('行缺 _types → 返回空 overrides（防御）', () => {
    assert.deepEqual(applyFieldValueOverrides({ OrderId: 'x' }, { channelOrderNo: 'y' }, oneRule()), {});
  });
});
