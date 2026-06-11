// v3.0.4 块 E（需求2）：BOC 链接表派生纯函数单测（🔴 资金对账敏感）。
//
// 覆盖 scanFxGroups / matchBocToMidAllocation / buildBocBankRows / backfillBocReconLinkIds + 4 工具：
//   1) normalizeTransactionNo：纯数字 / 带尾零小数去零 / 空 / 含非数字 / 科学计数法。
//   2) extractLongestDigitRun：最长 / 并列取首 / 无数字 / 全角不计。
//   3) scanFxGroups：单组 / 分隔行 / 空行断档 / 混合 / 尾部合计排除 / 空表 / 组号递增 / source_row。
//   4) 2.2：精确命中清分组 / 千分位 / Excel 序列号日期 / 多候选行序优先 / 消耗后不进 2.3 / 非 BOC 渠道不参与。
//   5) 2.3：组和命中回填全组 / 一组一单消耗 / 到期日不一致 / 金额非数值整组放弃 / 无中台数据。
//   6) buildBocBankRows：四条件各负例 / 关键词提取 / availability 三态。
//   7) backfill：命中 / 未命中 '' / 重复键首行 / 幂等重算。
//
// 🔴 不变量（绝不能回退）：转分精确（容差 0）；一对一消耗；多解记 log 不抛错；幂等全量重算。

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  scanFxGroups,
  matchBocToMidAllocation,
  buildBocBankRows,
  backfillBocReconLinkIds,
  normalizeTransactionNo,
  toCents,
  extractLongestDigitRun
} = require('../../../src/main-process/boc-fx-link-builder');

// —— 工具：交割表行 / 中台行 / 银行候选行工厂 ——
function fxRow(o = {}) {
  return Object.assign({ '交易编号': '', '货币1金额': '', '货币2金额': '', '到期日': '' }, o);
}
function midRow(o = {}) {
  return Object.assign({ '调拨单号': '', '付款渠道': '', '收款金额': '', '交易时间': '' }, o);
}
function bankRow(o = {}) {
  return Object.assign({
    Channel: 'BOC', '地区': 'CN', Currency: 'USD', 'Credit Amount': '0',
    ReconciliationId: '', 'Payment Detail': '', BillDate: '2026-05-04'
  }, o);
}

test.describe('boc-fx-link-builder — 工具函数', () => {
  test('normalizeTransactionNo 五形态', () => {
    assert.equal(normalizeTransactionNo('123'), '123', '纯数字原样');
    assert.equal(normalizeTransactionNo('926181062.0'), '926181062', '带尾零小数去尾零');
    assert.equal(normalizeTransactionNo(123), '123', 'number 入参归一');
    assert.equal(normalizeTransactionNo(''), '', '空 → 空');
    assert.equal(normalizeTransactionNo('12a3'), '', '含非数字 → 空');
    assert.equal(normalizeTransactionNo('1.2e3'), '', '科学计数法 → 空');
    assert.equal(normalizeTransactionNo('123.5'), '', '非零小数 → 空');
  });

  test('toCents 转分精确 + 千分位 + 非数值', () => {
    assert.equal(toCents('100'), 10000);
    assert.equal(toCents('1,234.56'), 123456, '去千分位 → ×100');
    assert.equal(toCents('0'), 0);
    assert.equal(toCents('abc'), null, '非数值 → null');
    assert.equal(toCents(''), null);
  });

  test('extractLongestDigitRun 最长 / 并列取首 / 无数字 / 全角不计', () => {
    assert.deepEqual(extractLongestDigitRun('AB12345CD678'), { value: '12345', hasMultiple: false }, '最长');
    assert.deepEqual(extractLongestDigitRun('AB123CD456'), { value: '123', hasMultiple: true }, '并列取最先 + hasMultiple');
    assert.deepEqual(extractLongestDigitRun('abc'), { value: '', hasMultiple: false }, '无数字');
    assert.deepEqual(extractLongestDigitRun('１２３'), { value: '', hasMultiple: false }, '全角不计');
  });
});

test.describe('boc-fx-link-builder — scanFxGroups（物理行序分组）', () => {
  test('单组：连续纯数字行成一组', () => {
    const objs = [fxRow({ '交易编号': '100' }), fxRow({ '交易编号': '101' }), fxRow({ '交易编号': '102' })];
    const { rows, groupCount } = scanFxGroups({ objects: objs, rowNumbers: [3, 4, 5] });
    assert.equal(groupCount, 1);
    assert.equal(rows.length, 3);
    assert.deepEqual(rows.map((r) => r['分组']), ['1', '1', '1']);
  });

  test('分隔行（非数字行）关组：合计行后开新组', () => {
    const objs = [
      fxRow({ '交易编号': '100' }),
      fxRow({ '交易编号': '合计' }), // 非数字 → 关组不入表
      fxRow({ '交易编号': '200' })
    ];
    const { rows, groupCount } = scanFxGroups({ objects: objs, rowNumbers: [3, 4, 5] });
    assert.equal(groupCount, 2);
    assert.equal(rows.length, 2, '合计行不入表');
    assert.deepEqual(rows.map((r) => r['分组']), ['1', '2']);
  });

  test('空行断档（rowNumbers 跳号）关组', () => {
    const objs = [fxRow({ '交易编号': '100' }), fxRow({ '交易编号': '200' })];
    // 物理行 3、6（中间 4/5 是被过滤的全空行）→ 断档关组
    const { groupCount, rows } = scanFxGroups({ objects: objs, rowNumbers: [3, 6] });
    assert.equal(groupCount, 2, '断档分两组');
    assert.deepEqual(rows.map((r) => r['分组']), ['1', '2']);
  });

  test('连续多个分隔不产空组号', () => {
    const objs = [
      fxRow({ '交易编号': '100' }),
      fxRow({ '交易编号': '小计' }),
      fxRow({ '交易编号': '合计' }),
      fxRow({ '交易编号': '200' })
    ];
    const { groupCount, rows } = scanFxGroups({ objects: objs, rowNumbers: [3, 4, 5, 6] });
    assert.equal(groupCount, 2, '两段非空数据 → 2 组（中间连续分隔不产组）');
    assert.deepEqual(rows.map((r) => r['分组']), ['1', '2']);
  });

  test('尾部合计行排除', () => {
    const objs = [fxRow({ '交易编号': '100' }), fxRow({ '交易编号': '101' }), fxRow({ '交易编号': '合计：' })];
    const { rows, groupCount } = scanFxGroups({ objects: objs, rowNumbers: [3, 4, 5] });
    assert.equal(groupCount, 1);
    assert.equal(rows.length, 2, '尾部合计不入表');
  });

  test('空表（仅标题表头）→ 0 组 0 行', () => {
    const { rows, groupCount } = scanFxGroups({ objects: [], rowNumbers: [] });
    assert.equal(groupCount, 0);
    assert.equal(rows.length, 0);
  });

  test('组号递增 + source_row 落内部辅助键', () => {
    const objs = [
      fxRow({ '交易编号': '100', '到期日': '2026-05-04' }),
      fxRow({ '交易编号': '合计' }),
      fxRow({ '交易编号': '200', '到期日': '2026-05-05' }),
      fxRow({ '交易编号': '合计' }),
      fxRow({ '交易编号': '300', '到期日': '2026-05-06' })
    ];
    const { rows, groupCount } = scanFxGroups({ objects: objs, rowNumbers: [3, 4, 5, 6, 7] });
    assert.equal(groupCount, 3);
    assert.deepEqual(rows.map((r) => r['分组']), ['1', '2', '3']);
    assert.deepEqual(rows.map((r) => r.__sourceRow), [3, 5, 7], 'source_row = 物理行号');
    assert.deepEqual(rows.map((r) => r.__maturityIso), ['2026-05-04', '2026-05-05', '2026-05-06']);
    // 3 新字段初值
    assert.equal(rows[0]['调拨单号'], '');
    assert.equal(rows[0]['资金对账不平表链接ID'], '');
  });
});

test.describe('boc-fx-link-builder — matchBocToMidAllocation 2.2 单行剔除', () => {
  test('2.2 精确命中清分组（到期日 + 货币2金额=收款金额 转分相等）', () => {
    const bocRows = scanFxGroups({
      objects: [fxRow({ '交易编号': '100', '货币2金额': '500.00', '到期日': '2026-05-04' })],
      rowNumbers: [3]
    }).rows;
    const mids = [midRow({ '调拨单号': 'A1', '付款渠道': 'BOC', '收款金额': '500', '交易时间': '2026-05-04 10:00:00' })];
    matchBocToMidAllocation(bocRows, mids);
    assert.equal(bocRows[0]['分组'], '', '2.2 命中清空分组');
  });

  test('2.2 千分位金额匹配', () => {
    const bocRows = scanFxGroups({
      objects: [fxRow({ '交易编号': '100', '货币2金额': '1,234.56', '到期日': '2026-05-04' })],
      rowNumbers: [3]
    }).rows;
    const mids = [midRow({ '付款渠道': 'BOC', '收款金额': '1234.56', '交易时间': '2026-05-04' })];
    matchBocToMidAllocation(bocRows, mids);
    assert.equal(bocRows[0]['分组'], '', '千分位转分一致 → 命中');
  });

  test('2.2 Excel 序列号日期匹配', () => {
    // 46116 ≈ 2026-03-26（XLSX 序列号）；用同序列号 / 同字符串对齐
    const bocRows = scanFxGroups({
      objects: [fxRow({ '交易编号': '100', '货币2金额': '10', '到期日': 46116 })],
      rowNumbers: [3]
    }).rows;
    const iso = bocRows[0].__maturityIso;
    assert.notEqual(iso, '', '序列号应解析出 iso');
    const mids = [midRow({ '付款渠道': 'BOC', '收款金额': '10', '交易时间': iso })];
    matchBocToMidAllocation(bocRows, mids);
    assert.equal(bocRows[0]['分组'], '', 'Excel 序列号日期归一后命中');
  });

  test('2.2 多候选行序优先取首 + 记 log', () => {
    const bocRows = scanFxGroups({
      objects: [
        fxRow({ '交易编号': '100', '货币2金额': '10', '到期日': '2026-05-04' }),
        fxRow({ '交易编号': '101', '货币2金额': '10', '到期日': '2026-05-04' })
      ],
      rowNumbers: [3, 4]
    }).rows;
    const mids = [midRow({ '付款渠道': 'BOC', '收款金额': '10', '交易时间': '2026-05-04' })];
    const { logs } = matchBocToMidAllocation(bocRows, mids);
    assert.equal(bocRows[0]['分组'], '', '首行被清空');
    assert.equal(bocRows[1]['分组'], '1', '次行保留');
    assert.ok(logs.some((l) => l.level === 'warning' && /命中 2 条/.test(l.message)), '多命中记 warning');
  });

  test('2.2 消耗后该中台行不进 2.3', () => {
    // 单行 + 同金额可被 2.2 命中并消耗 → 不应再在 2.3 回填调拨单号
    const bocRows = scanFxGroups({
      objects: [fxRow({ '交易编号': '100', '货币2金额': '10', '到期日': '2026-05-04' })],
      rowNumbers: [3]
    }).rows;
    const mids = [midRow({ '调拨单号': 'A1', '付款渠道': 'BOC', '收款金额': '10', '交易时间': '2026-05-04' })];
    matchBocToMidAllocation(bocRows, mids);
    assert.equal(bocRows[0]['分组'], '');
    assert.equal(bocRows[0]['调拨单号'], '', '2.2 命中行不应被 2.3 回填调拨单号');
  });

  test('2.2 非 BOC 渠道中台行不参与', () => {
    const bocRows = scanFxGroups({
      objects: [fxRow({ '交易编号': '100', '货币2金额': '10', '到期日': '2026-05-04' })],
      rowNumbers: [3]
    }).rows;
    const mids = [midRow({ '付款渠道': 'JPM', '收款金额': '10', '交易时间': '2026-05-04' })];
    matchBocToMidAllocation(bocRows, mids);
    assert.equal(bocRows[0]['分组'], '1', '非 BOC 渠道不参与，分组保留');
  });
});

test.describe('boc-fx-link-builder — matchBocToMidAllocation 2.3 组汇总回填', () => {
  test('2.3 组汇总命中回填组内所有行 + 一组一单消耗', () => {
    // 一组两行（汇总 30），中台一笔 30 → 回填全组调拨单号；2.2 不应命中（单行 10/20 都 != 30）
    const bocRows = scanFxGroups({
      objects: [
        fxRow({ '交易编号': '100', '货币2金额': '10', '到期日': '2026-05-04' }),
        fxRow({ '交易编号': '101', '货币2金额': '20', '到期日': '2026-05-04' })
      ],
      rowNumbers: [3, 4]
    }).rows;
    const mids = [midRow({ '调拨单号': 'A1', '付款渠道': 'BOC', '收款金额': '30', '交易时间': '2026-05-04' })];
    matchBocToMidAllocation(bocRows, mids);
    assert.equal(bocRows[0]['调拨单号'], 'A1', '组内行1回填');
    assert.equal(bocRows[1]['调拨单号'], 'A1', '组内行2回填');
    assert.equal(bocRows[0]['分组'], '1', '2.3 不清分组');
  });

  test('2.3 一组一单消耗：第二组无可用候选则留空', () => {
    // 两组各 2 行（汇总均 30）→ 单行金额(10/20)≠30 不被 2.2 命中，纯走 2.3 组汇总
    const bocRows = scanFxGroups({
      objects: [
        fxRow({ '交易编号': '100', '货币2金额': '10', '到期日': '2026-05-04' }),
        fxRow({ '交易编号': '101', '货币2金额': '20', '到期日': '2026-05-04' }),
        fxRow({ '交易编号': '合计' }),
        fxRow({ '交易编号': '200', '货币2金额': '10', '到期日': '2026-05-04' }),
        fxRow({ '交易编号': '201', '货币2金额': '20', '到期日': '2026-05-04' })
      ],
      rowNumbers: [3, 4, 5, 6, 7]
    }).rows;
    // 仅一笔中台 30 → 只能配一组（行序优先组1）
    const mids = [midRow({ '调拨单号': 'A1', '付款渠道': 'BOC', '收款金额': '30', '交易时间': '2026-05-04' })];
    matchBocToMidAllocation(bocRows, mids);
    const g1 = bocRows.filter((r) => r['分组'] === '1');
    const g2 = bocRows.filter((r) => r['分组'] === '2');
    assert.equal(g1.length, 2, '组1两行');
    assert.equal(g2.length, 2, '组2两行');
    assert.equal(g1[0]['调拨单号'], 'A1', '组1命中回填');
    assert.equal(g2[0]['调拨单号'], '', '组2无候选留空（一组一单消耗）');
  });

  test('2.3 组内到期日不一致 → warning + 取首行', () => {
    const bocRows = scanFxGroups({
      objects: [
        fxRow({ '交易编号': '100', '货币2金额': '10', '到期日': '2026-05-04' }),
        fxRow({ '交易编号': '101', '货币2金额': '20', '到期日': '2026-05-05' })
      ],
      rowNumbers: [3, 4]
    }).rows;
    const mids = [midRow({ '调拨单号': 'A1', '付款渠道': 'BOC', '收款金额': '30', '交易时间': '2026-05-04' })];
    const { logs } = matchBocToMidAllocation(bocRows, mids);
    assert.ok(logs.some((l) => /到期日不一致/.test(l.message)), '记到期日不一致 warning');
    assert.equal(bocRows[0]['调拨单号'], 'A1', '取首行到期日 2026-05-04 → 命中回填');
  });

  test('2.3 组内金额非数值 → 整组放弃 + warning', () => {
    const bocRows = scanFxGroups({
      objects: [
        fxRow({ '交易编号': '100', '货币2金额': 'N/A', '到期日': '2026-05-04' }),
        fxRow({ '交易编号': '101', '货币2金额': '20', '到期日': '2026-05-04' })
      ],
      rowNumbers: [3, 4]
    }).rows;
    const mids = [midRow({ '调拨单号': 'A1', '付款渠道': 'BOC', '收款金额': '20', '交易时间': '2026-05-04' })];
    const { logs } = matchBocToMidAllocation(bocRows, mids);
    assert.ok(logs.some((l) => /整组放弃/.test(l.message)), '记整组放弃 warning');
    assert.equal(bocRows[0]['调拨单号'], '', '整组放弃 → 不回填');
    assert.equal(bocRows[1]['调拨单号'], '');
  });

  test('无中台数据 → 2.2/2.3 跳过、调拨单号留空（不抛错）', () => {
    const bocRows = scanFxGroups({
      objects: [fxRow({ '交易编号': '100', '货币2金额': '10', '到期日': '2026-05-04' })],
      rowNumbers: [3]
    }).rows;
    assert.doesNotThrow(() => matchBocToMidAllocation(bocRows, []));
    assert.equal(bocRows[0]['分组'], '1');
    assert.equal(bocRows[0]['调拨单号'], '');
  });

  test('中台行日期/金额解析失败 → 剔候选 + warning（不抛错）', () => {
    const bocRows = scanFxGroups({
      objects: [fxRow({ '交易编号': '100', '货币2金额': '10', '到期日': '2026-05-04' })],
      rowNumbers: [3]
    }).rows;
    const mids = [midRow({ '付款渠道': 'BOC', '收款金额': 'bad', '交易时间': 'xx' })];
    const { logs } = matchBocToMidAllocation(bocRows, mids);
    assert.ok(logs.some((l) => l.level === 'warning' && /剔出匹配候选/.test(l.message)));
    assert.equal(bocRows[0]['分组'], '1', '无有效候选 → 分组保留');
  });
});

test.describe('boc-fx-link-builder — buildBocBankRows（availability 三态 + 四条件筛选）', () => {
  test('availability=no-boc-rows（候选 0 行）', () => {
    const { availability, rows } = buildBocBankRows([]);
    assert.equal(availability, 'no-boc-rows');
    assert.equal(rows.length, 0);
  });

  test('availability=missing-payment-detail（候选有行但全无 Payment Detail 键）', () => {
    const legacy = { Channel: 'BOC', '地区': 'CN', Currency: 'USD', 'Credit Amount': '0', ReconciliationId: 'R1' };
    const { availability, rows } = buildBocBankRows([legacy]);
    assert.equal(availability, 'missing-payment-detail');
    assert.equal(rows.length, 0);
  });

  test('availability=ok：四条件命中 + 关键词提取银行单交易编号', () => {
    const cand = bankRow({ ReconciliationId: 'R1', 'Payment Detail': '无折存款借记交易 88990011' });
    const { availability, rows } = buildBocBankRows([cand]);
    assert.equal(availability, 'ok');
    assert.equal(rows.length, 1);
    assert.equal(rows[0]['银行单交易编号'], '88990011', '关键词后提取最长数字串');
  });

  test('四条件负例：地区!=CN / Currency!=USD / Credit Amount!=0 各被过滤', () => {
    const okCand = bankRow({ ReconciliationId: 'OK', 'Payment Detail': '无折存款借记交易 100' });
    const badRegion = bankRow({ '地区': 'HK', ReconciliationId: 'X1', 'Payment Detail': '无折存款借记交易 1' });
    const badCcy = bankRow({ Currency: 'HKD', ReconciliationId: 'X2', 'Payment Detail': '无折存款借记交易 2' });
    const badCredit = bankRow({ 'Credit Amount': '5', ReconciliationId: 'X3', 'Payment Detail': '无折存款借记交易 3' });
    const { rows } = buildBocBankRows([okCand, badRegion, badCcy, badCredit]);
    assert.equal(rows.length, 1, '仅 OK 行通过四条件');
    assert.equal(rows[0].ReconciliationId, 'OK');
  });

  test('含关键词但无数字 → 银行单交易编号留空 + warning', () => {
    const cand = bankRow({ ReconciliationId: 'R1', 'Payment Detail': '无折存款借记交易（无单号）' });
    const { rows, logs } = buildBocBankRows([cand]);
    assert.equal(rows[0]['银行单交易编号'], '');
    assert.ok(logs.some((l) => l.level === 'warning' && /无数字串/.test(l.message)));
  });

  test('不含关键词 → 银行单交易编号留空（仍落库）', () => {
    const cand = bankRow({ ReconciliationId: 'R1', 'Payment Detail': '普通入金 123' });
    const { rows } = buildBocBankRows([cand]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]['银行单交易编号'], '', '无关键词不提取');
  });
});

test.describe('boc-fx-link-builder — backfillBocReconLinkIds（按 id 幂等回填）', () => {
  function linkItem(id, txnNo) {
    return { id, row: { '交易编号': txnNo, '资金对账不平表链接ID': '' } };
  }

  test('命中：链接ID = 银行行 ReconciliationId', () => {
    const list = [linkItem(1, '100'), linkItem(2, '200')];
    const banks = [{ '银行单交易编号': '100', ReconciliationId: 'RX1' }];
    const { rows, backfilled, unlinkedCount } = backfillBocReconLinkIds(list, banks);
    assert.equal(rows[0].row['资金对账不平表链接ID'], 'RX1', '命中回填');
    assert.equal(rows[1].row['资金对账不平表链接ID'], '', '未命中留空');
    assert.equal(backfilled, 1);
    assert.equal(unlinkedCount, 1);
  });

  test('未命中 → 空字符串 + unlinked log', () => {
    const list = [linkItem(1, '999')];
    const { rows, unlinkedCount, logs } = backfillBocReconLinkIds(list, []);
    assert.equal(rows[0].row['资金对账不平表链接ID'], '');
    assert.equal(unlinkedCount, 1);
    assert.ok(logs.some((l) => l.level === 'warning' && /未命中/.test(l.message)), 'unlinked 记 warning log');
  });

  test('重复银行单交易编号键 → 留最先一条 + warning', () => {
    const list = [linkItem(1, '100')];
    const banks = [
      { '银行单交易编号': '100', ReconciliationId: 'FIRST' },
      { '银行单交易编号': '100', ReconciliationId: 'SECOND' }
    ];
    const { rows, logs } = backfillBocReconLinkIds(list, banks);
    assert.equal(rows[0].row['资金对账不平表链接ID'], 'FIRST', '重复键取最先');
    assert.ok(logs.some((l) => l.level === 'warning' && /重复/.test(l.message)));
  });

  test('幂等全量重算：旧值被覆盖', () => {
    const list = [{ id: 1, row: { '交易编号': '100', '资金对账不平表链接ID': 'STALE' } }];
    const banks = [{ '银行单交易编号': '100', ReconciliationId: 'NEW' }];
    const { rows } = backfillBocReconLinkIds(list, banks);
    assert.equal(rows[0].row['资金对账不平表链接ID'], 'NEW', '旧值被全量重算覆盖');
    // 再跑一次无银行数据 → 全量重算清空
    const second = backfillBocReconLinkIds(rows, []);
    assert.equal(second.rows[0].row['资金对账不平表链接ID'], '', '幂等：无数据时清空旧链接ID');
  });
});
