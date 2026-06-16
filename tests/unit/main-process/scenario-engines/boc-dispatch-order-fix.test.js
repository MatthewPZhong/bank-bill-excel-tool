// v3.0.4 块 E 需求3：BOC 调拨订单修复引擎 8 步状态机单测（🔴 资金红线）
//
// 失败语义比 JPM「从严」：网关多命中 / 0 命中 / 组内任一 1v1 失配 / 链接ID 跨多组 / 两组共享调拨单号 /
//   调拨单号不一致或缺失 / 链接ID 为空 —— 一律整组失败（不产出、不消耗）。
//
// 覆盖（spec §9.1 第三组 ~17 案）：
//   组全配（Type===1 number / Reference/Amount 行级 / 11 列同源 / stats）；组半配（不消耗渠道行）；
//   无调拨单号 / 不一致；OrderId 0 命中 / 多命中；链接ID 空；渠道无 BOC 行 / 链接表空早返回；
//   1v1 消耗（k 行同链接ID 需 k 条渠道行）；跨组同链接ID；两组共享调拨单号；channelName trim 与大小写；
//   分组空行忽略；入参不可变深快照；分流四路回归；stats 完整性。

const test = require('node:test');
const assert = require('node:assert/strict');

const { runBocDispatchOrderFix } = require('../../../../src/main-process/scenario-engines/boc-dispatch-order-fix');
const { runReconIdFix } = require('../../../../src/main-process/recon-id-fix-engine');
const { GATEWAY_BILL_FIELDS } = require('../../../../src/constants/gateway-bill-recon-fields');

// 网关账单 Type 超长缺括号列（GATEWAY_BILL_FIELDS[8]）；源行只有它，buildOutputRow 短名取不到 → 引擎 override。
const GW_TYPE_COL = GATEWAY_BILL_FIELDS[8];

// ====== 测试辅助：构造渠道账单行 / BOC链接表行 / 网关账单行 ======

// 渠道账单（小写 channelName / reconciliationId）
function channelRow({ channelName = 'BOC', reconId = '' } = {}) {
  return { channelName, reconciliationId: reconId };
}

// BOC链接表行（交割表真实表头子集 + 3 新字段；货币1金额 = 输出 Amount 源）
function linkRow({ group = '', alloc = '', reconLinkId = '', ccy1Amount = '' } = {}) {
  return {
    '交易编号': '',
    '货币1金额': ccy1Amount,
    '货币2金额': '',
    '到期日': '',
    '分组': group,
    '调拨单号': alloc,
    '资金对账不平表链接ID': reconLinkId
  };
}

// 网关账单行（驼峰 OrderId；含超长 Type 列原始名）
function gwRow({ orderId = '', billDate = '2026-06-01', merchantId = 'M1', currency = 'USD', amount = 0, bank = 'BOC' } = {}) {
  const r = {
    BillDate: billDate,
    Bank: bank,
    MerchantId: merchantId,
    OrderId: orderId,
    DataSource: 'DS',
    OppBu: 'OB',
    OriginBillSource: 'OBS',
    BillType: 'BT',
    Reference: '',
    Currency: currency,
    Amount: amount,
    OriginBillBizId: 'OBI',
    ReconBillBizId: 'RBI'
  };
  r[GW_TYPE_COL] = ''; // 源行 Type 走超长列名，短名 'Type' 为 undefined
  return r;
}

const SCENARIO = { id: 7, name: 'BOC调拨订单修复', config: { subCategory: 'boc-dispatch-order-fix', channelName: 'BOC' } };

function run(sheets, links, scenario = SCENARIO) {
  return runBocDispatchOrderFix({ sheets, bocLinkRows: links, scenario });
}

// ========================================================================
// 1. 组全配 —— 整组成功
// ========================================================================
test.describe('组全配 — 整组匹配成功', () => {
  test('单组 2 行 → 复制网关命中行 2 份、Type===1(number)、Reference/Amount 行级、11 列同源、stats', () => {
    const links = [
      linkRow({ group: '1', alloc: 'ALC-1', reconLinkId: 'RID-A', ccy1Amount: 15000 }),
      linkRow({ group: '1', alloc: 'ALC-1', reconLinkId: 'RID-B', ccy1Amount: 6000 })
    ];
    const sheets = {
      opponentBills: [channelRow({ reconId: 'RID-A' }), channelRow({ reconId: 'RID-B' })],
      businessBills: [gwRow({ orderId: 'ALC-1', currency: 'USD', amount: 999 })]
    };
    const res = run(sheets, links);
    assert.strictEqual(res.fixedRows.length, 2, '组行数 2 → 复制 2 份');
    // Type === number 1（v3.0.8 需求5：BOC 修复行 Type 由 2 → 1）
    for (const fr of res.fixedRows) {
      assert.strictEqual(fr.Type, 1);
      assert.strictEqual(typeof fr.Type, 'number', 'Type 必须是 number 1');
    }
    // Reference / Amount 行级注入（按链接表行顺序）
    assert.strictEqual(res.fixedRows[0].Reference, 'RID-A');
    assert.strictEqual(res.fixedRows[0].Amount, 15000);
    assert.strictEqual(res.fixedRows[1].Reference, 'RID-B');
    assert.strictEqual(res.fixedRows[1].Amount, 6000);
    // 11 列从网关源行同名复制（两份同源）
    for (const fr of res.fixedRows) {
      assert.strictEqual(fr.OrderId, 'ALC-1');
      assert.strictEqual(fr.Bank, 'BOC');
      assert.strictEqual(fr.MerchantId, 'M1');
      assert.strictEqual(fr.Currency, 'USD');
      assert.strictEqual(fr.BillDate, '2026-06-01');
      assert.strictEqual(fr.OriginBillBizId, 'OBI');
      assert.strictEqual(fr.ReconBillBizId, 'RBI');
    }
    // stats
    assert.strictEqual(res.stats.channelBocTotal, 2);
    assert.strictEqual(res.stats.linkGroupTotal, 1);
    assert.strictEqual(res.stats.groupTouched, 1);
    assert.strictEqual(res.stats.groupMatched, 1);
    assert.strictEqual(res.stats.groupFailed, 0);
    assert.strictEqual(res.stats.fixedRowCount, 2);
    assert.strictEqual(res.warnings.length, 0);
  });
});

// ========================================================================
// 2. 组半配 —— 整组失败、不消耗渠道行
// ========================================================================
test.describe('组半配 — 整组失败不消耗', () => {
  test('组内 2 行只配到 1 条渠道行 → group-partial-match 整组失败、fixedRows=0', () => {
    const links = [
      linkRow({ group: '1', alloc: 'ALC-1', reconLinkId: 'RID-A', ccy1Amount: 100 }),
      linkRow({ group: '1', alloc: 'ALC-1', reconLinkId: 'RID-B', ccy1Amount: 200 })
    ];
    const sheets = {
      opponentBills: [channelRow({ reconId: 'RID-A' })], // 缺 RID-B 的渠道行
      businessBills: [gwRow({ orderId: 'ALC-1' })]
    };
    const res = run(sheets, links);
    assert.strictEqual(res.fixedRows.length, 0);
    assert.strictEqual(res.stats.groupFailed, 1);
    assert.strictEqual(res.stats.groupMatched, 0);
    assert.ok(res.warnings.some((w) => w.code === 'group-partial-match'));
    assert.ok(res.warnings.every((w) => typeof w.message === 'string' && w.message.length > 0), '每条 warning 带中文 message');
  });
});

// ========================================================================
// 3. 无调拨单号 / 不一致 —— 整组失败
// ========================================================================
test.describe('调拨单号异常 — 整组失败', () => {
  test('组内某行调拨单号空 → group-allocation-missing', () => {
    const links = [
      linkRow({ group: '1', alloc: 'ALC-1', reconLinkId: 'RID-A', ccy1Amount: 100 }),
      linkRow({ group: '1', alloc: '', reconLinkId: 'RID-B', ccy1Amount: 200 })
    ];
    const sheets = {
      opponentBills: [channelRow({ reconId: 'RID-A' }), channelRow({ reconId: 'RID-B' })],
      businessBills: [gwRow({ orderId: 'ALC-1' })]
    };
    const res = run(sheets, links);
    assert.strictEqual(res.fixedRows.length, 0);
    assert.ok(res.warnings.some((w) => w.code === 'group-allocation-missing'));
  });

  test('组内调拨单号不一致 → group-allocation-inconsistent', () => {
    const links = [
      linkRow({ group: '1', alloc: 'ALC-1', reconLinkId: 'RID-A', ccy1Amount: 100 }),
      linkRow({ group: '1', alloc: 'ALC-2', reconLinkId: 'RID-B', ccy1Amount: 200 })
    ];
    const sheets = {
      opponentBills: [channelRow({ reconId: 'RID-A' }), channelRow({ reconId: 'RID-B' })],
      businessBills: [gwRow({ orderId: 'ALC-1' }), gwRow({ orderId: 'ALC-2' })]
    };
    const res = run(sheets, links);
    assert.strictEqual(res.fixedRows.length, 0);
    assert.ok(res.warnings.some((w) => w.code === 'group-allocation-inconsistent'));
  });
});

// ========================================================================
// 4. OrderId 0 命中 / 多命中 —— 整组失败（D4 从严）
// ========================================================================
test.describe('网关 OrderId 命中数 — 唯一才生成', () => {
  test('OrderId 0 命中 → gw-orderid-not-found 整组失败', () => {
    const links = [linkRow({ group: '1', alloc: 'ALC-X', reconLinkId: 'RID-A', ccy1Amount: 100 })];
    const sheets = {
      opponentBills: [channelRow({ reconId: 'RID-A' })],
      businessBills: [gwRow({ orderId: 'OTHER' })]
    };
    const res = run(sheets, links);
    assert.strictEqual(res.fixedRows.length, 0);
    assert.ok(res.warnings.some((w) => w.code === 'gw-orderid-not-found'));
  });

  test('OrderId 多命中 → gw-orderid-multi-match 整组失败（区别于 JPM 取第一）', () => {
    const links = [linkRow({ group: '1', alloc: 'ALC-X', reconLinkId: 'RID-A', ccy1Amount: 100 })];
    const sheets = {
      opponentBills: [channelRow({ reconId: 'RID-A' })],
      businessBills: [gwRow({ orderId: 'ALC-X', amount: 1 }), gwRow({ orderId: 'ALC-X', amount: 2 })]
    };
    const res = run(sheets, links);
    assert.strictEqual(res.fixedRows.length, 0, '🔴 从严：多命中整组失败，不产出');
    const w = res.warnings.find((x) => x.code === 'gw-orderid-multi-match');
    assert.ok(w);
    assert.strictEqual(w.count, 2);
  });
});

// ========================================================================
// 5. 链接ID 空 —— 整组失败（D2）
// ========================================================================
test.describe('链接ID 空 — 整组失败', () => {
  test('组内某行链接ID 空 → group-link-id-empty 整组失败', () => {
    const links = [
      linkRow({ group: '1', alloc: 'ALC-1', reconLinkId: 'RID-A', ccy1Amount: 100 }),
      linkRow({ group: '1', alloc: 'ALC-1', reconLinkId: '', ccy1Amount: 200 })
    ];
    const sheets = {
      opponentBills: [channelRow({ reconId: 'RID-A' })],
      businessBills: [gwRow({ orderId: 'ALC-1' })]
    };
    const res = run(sheets, links);
    assert.strictEqual(res.fixedRows.length, 0);
    assert.ok(res.warnings.some((w) => w.code === 'group-link-id-empty'));
  });
});

// ========================================================================
// 6. 渠道无 BOC 行 / 链接表空 —— 早返回
// ========================================================================
test.describe('早返回 — 渠道无 BOC 行 / 链接表空', () => {
  test('渠道无 channelName=BOC 行 → boc-channel-not-found 早返回', () => {
    const sheets = {
      opponentBills: [channelRow({ channelName: 'JPM', reconId: 'RID-A' })],
      businessBills: [gwRow({ orderId: 'ALC-1' })]
    };
    const res = run(sheets, [linkRow({ group: '1', alloc: 'ALC-1', reconLinkId: 'RID-A', ccy1Amount: 100 })]);
    assert.strictEqual(res.fixedRows.length, 0);
    assert.strictEqual(res.stats.channelBocTotal, 0);
    assert.ok(res.warnings.some((w) => w.code === 'boc-channel-not-found'));
  });

  test('BOC链接表空 → boc-link-table-empty 早返回', () => {
    const sheets = {
      opponentBills: [channelRow({ reconId: 'RID-A' })],
      businessBills: [gwRow({ orderId: 'ALC-1' })]
    };
    const res = run(sheets, []);
    assert.strictEqual(res.fixedRows.length, 0);
    assert.strictEqual(res.stats.linkRowTotal, 0);
    assert.ok(res.warnings.some((w) => w.code === 'boc-link-table-empty'));
  });
});

// ========================================================================
// 7. 1v1 消耗 —— k 行同链接ID 需 k 条渠道行
// ========================================================================
test.describe('1v1 消耗 — 同链接ID 出现 k 次须有 k 条渠道行', () => {
  test('组内同链接ID 出现 2 次、渠道恰 2 条同 reconId 行 → 成功复制 2 份', () => {
    const links = [
      linkRow({ group: '1', alloc: 'ALC-1', reconLinkId: 'RID-A', ccy1Amount: 100 }),
      linkRow({ group: '1', alloc: 'ALC-1', reconLinkId: 'RID-A', ccy1Amount: 200 })
    ];
    const sheets = {
      opponentBills: [channelRow({ reconId: 'RID-A' }), channelRow({ reconId: 'RID-A' })],
      businessBills: [gwRow({ orderId: 'ALC-1' })]
    };
    const res = run(sheets, links);
    assert.strictEqual(res.fixedRows.length, 2, 'k=2 同链接ID 配 2 条渠道行 → 2 份');
    assert.strictEqual(res.stats.groupMatched, 1);
  });

  test('组内同链接ID 出现 2 次但渠道仅 1 条同 reconId 行 → 整组失败（1v1 消耗不足）', () => {
    const links = [
      linkRow({ group: '1', alloc: 'ALC-1', reconLinkId: 'RID-A', ccy1Amount: 100 }),
      linkRow({ group: '1', alloc: 'ALC-1', reconLinkId: 'RID-A', ccy1Amount: 200 })
    ];
    const sheets = {
      opponentBills: [channelRow({ reconId: 'RID-A' })], // 只 1 条
      businessBills: [gwRow({ orderId: 'ALC-1' })]
    };
    const res = run(sheets, links);
    assert.strictEqual(res.fixedRows.length, 0);
    assert.ok(res.warnings.some((w) => w.code === 'group-partial-match'));
  });
});

// ========================================================================
// 8. 跨组同链接ID —— D7 相关组全失败（eager 预扫·确定性，资金红线）
// ========================================================================
test.describe('跨组同链接ID — D7 相关组全失败', () => {
  test('同一链接ID 出现在两个分组 → link-id-ambiguous、两组都失败、fixedRows=0', () => {
    const links = [
      linkRow({ group: '1', alloc: 'ALC-1', reconLinkId: 'RID-DUP', ccy1Amount: 100 }),
      linkRow({ group: '2', alloc: 'ALC-2', reconLinkId: 'RID-DUP', ccy1Amount: 200 })
    ];
    const sheets = {
      opponentBills: [channelRow({ reconId: 'RID-DUP' })],
      businessBills: [gwRow({ orderId: 'ALC-1' }), gwRow({ orderId: 'ALC-2' })]
    };
    const res = run(sheets, links);
    assert.strictEqual(res.fixedRows.length, 0);
    const w = res.warnings.find((x) => x.code === 'link-id-ambiguous');
    assert.ok(w);
    assert.deepStrictEqual(w.groups.sort(), ['1', '2']);
    assert.strictEqual(res.stats.groupFailed, 2, '两组都判失败');
    assert.strictEqual(res.stats.groupTouched, 2);
  });

  // 🔴 资金红线·确定性回归（PR #71 self-review CONFIRMED finding 复现）：
  //   组1=[链接ID L, M]（L 跨组1/组2）、组2=[链接ID L]。原惰性检测按渠道行序惰性触发：
  //   行序 [M,L] 会让组1 先经 M 提交成功（产出含歧义 Reference=L 的修复行），随后才发现 L 歧义、只记组2 失败；
  //   行序 [L,M] 则两组都不产出。eager 预扫修法后：同数据任意渠道行序产出完全一致、歧义 ID 涉及组绝不产出修复行。
  test('链接ID 跨多组 + 同组另有干净链接ID — 两种渠道行序产出完全一致、fixedRows=0、两组皆失败', () => {
    // L=RID-L 跨组1/组2（歧义）；M=RID-M 仅组1（干净）。组1 含 L+M，组2 含 L。
    const buildLinks = () => [
      linkRow({ group: '1', alloc: 'ALC-1', reconLinkId: 'RID-L', ccy1Amount: 100 }),
      linkRow({ group: '1', alloc: 'ALC-1', reconLinkId: 'RID-M', ccy1Amount: 200 }),
      linkRow({ group: '2', alloc: 'ALC-2', reconLinkId: 'RID-L', ccy1Amount: 300 })
    ];
    const gw = () => [gwRow({ orderId: 'ALC-1' }), gwRow({ orderId: 'ALC-2' })];
    // 行序 [M,L,L]：渠道行先 M（旧逻辑会让组1 先经 M 提交成功）后 L
    const resML = run(
      { opponentBills: [channelRow({ reconId: 'RID-M' }), channelRow({ reconId: 'RID-L' }), channelRow({ reconId: 'RID-L' })], businessBills: gw() },
      buildLinks()
    );
    // 行序 [L,L,M]：渠道行先 L（碰歧义）后 M
    const resLM = run(
      { opponentBills: [channelRow({ reconId: 'RID-L' }), channelRow({ reconId: 'RID-L' }), channelRow({ reconId: 'RID-M' })], businessBills: gw() },
      buildLinks()
    );
    // ① 两序均不产出任何修复行（歧义 ID 涉及组绝不产出）
    assert.strictEqual(resML.fixedRows.length, 0, '行序 [M,L] 不得产出含歧义 Reference 的修复行');
    assert.strictEqual(resLM.fixedRows.length, 0, '行序 [L,M] 不得产出修复行');
    // ② 确定性：两序输出 fixedRows 完全一致（均为空数组）
    assert.deepStrictEqual(resML.fixedRows, resLM.fixedRows, '两渠道行序 fixedRows 必须完全一致');
    // ③ 两序 stats 口径完全一致：组1（含歧义 ID）与组2 均判失败
    assert.strictEqual(resML.stats.groupMatched, 0);
    assert.strictEqual(resLM.stats.groupMatched, 0);
    assert.strictEqual(resML.stats.groupFailed, 2, '组1 组2 均失败');
    assert.strictEqual(resLM.stats.groupFailed, 2, '组1 组2 均失败');
    assert.strictEqual(resML.stats.groupTouched, 2);
    assert.strictEqual(resLM.stats.groupTouched, 2);
    assert.deepStrictEqual(
      { matched: resML.stats.groupMatched, failed: resML.stats.groupFailed, touched: resML.stats.groupTouched },
      { matched: resLM.stats.groupMatched, failed: resLM.stats.groupFailed, touched: resLM.stats.groupTouched },
      '两渠道行序 stats 口径必须完全一致'
    );
    // ④ warn 与 stats 一致：歧义 ID 一次性列出涉及全部组号（组1、组2），warn 文案口径与失败计数对齐
    const wML = resML.warnings.find((x) => x.code === 'link-id-ambiguous');
    const wLM = resLM.warnings.find((x) => x.code === 'link-id-ambiguous');
    assert.ok(wML && wLM);
    assert.deepStrictEqual([...wML.groups].sort(), ['1', '2'], 'warn 列全歧义 ID 涉及组号');
    assert.deepStrictEqual([...wLM.groups].sort(), ['1', '2']);
    assert.strictEqual(wML.reconLinkId, 'RID-L');
  });
});

// ========================================================================
// 9. 两组共享调拨单号 —— D8 第二组失败
// ========================================================================
test.describe('两组共享调拨单号 — D8 第二组失败', () => {
  test('两组各自链接ID 不同但调拨单号相同 → 先处理组成功、后处理组 group-allocation-reused 失败', () => {
    const links = [
      linkRow({ group: '1', alloc: 'ALC-SHARE', reconLinkId: 'RID-1', ccy1Amount: 100 }),
      linkRow({ group: '2', alloc: 'ALC-SHARE', reconLinkId: 'RID-2', ccy1Amount: 200 })
    ];
    // 渠道行顺序：RID-1 先 → 组1 先处理成功；RID-2 → 组2 因调拨单号被占用失败。
    const sheets = {
      opponentBills: [channelRow({ reconId: 'RID-1' }), channelRow({ reconId: 'RID-2' })],
      businessBills: [gwRow({ orderId: 'ALC-SHARE' })]
    };
    const res = run(sheets, links);
    assert.strictEqual(res.fixedRows.length, 1, '仅先处理组产出 1 份');
    assert.strictEqual(res.fixedRows[0].Reference, 'RID-1');
    assert.strictEqual(res.stats.groupMatched, 1);
    assert.strictEqual(res.stats.groupFailed, 1);
    assert.ok(res.warnings.some((w) => w.code === 'group-allocation-reused'));
  });
});

// ========================================================================
// 10. channelName trim 与大小写
// ========================================================================
test.describe('channelName 比较 — trim 后精确等值、大小写敏感（D5）', () => {
  test('channelName 带空白 \" BOC \" trim 后命中', () => {
    const links = [linkRow({ group: '1', alloc: 'ALC-1', reconLinkId: 'RID-A', ccy1Amount: 100 })];
    const sheets = {
      opponentBills: [channelRow({ channelName: '  BOC  ', reconId: 'RID-A' })],
      businessBills: [gwRow({ orderId: 'ALC-1' })]
    };
    const res = run(sheets, links);
    assert.strictEqual(res.fixedRows.length, 1, 'trim 后 BOC 命中');
  });

  test('channelName 小写 \"boc\" 不命中（大小写敏感）', () => {
    const links = [linkRow({ group: '1', alloc: 'ALC-1', reconLinkId: 'RID-A', ccy1Amount: 100 })];
    const sheets = {
      opponentBills: [channelRow({ channelName: 'boc', reconId: 'RID-A' })],
      businessBills: [gwRow({ orderId: 'ALC-1' })]
    };
    const res = run(sheets, links);
    assert.strictEqual(res.fixedRows.length, 0);
    assert.ok(res.warnings.some((w) => w.code === 'boc-channel-not-found'));
  });

  test('config.channelName 缺失 → 常量 BOC 兜底', () => {
    const links = [linkRow({ group: '1', alloc: 'ALC-1', reconLinkId: 'RID-A', ccy1Amount: 100 })];
    const sheets = {
      opponentBills: [channelRow({ reconId: 'RID-A' })],
      businessBills: [gwRow({ orderId: 'ALC-1' })]
    };
    const scenario = { id: 8, name: 'BOC', config: { subCategory: 'boc-dispatch-order-fix' } }; // 无 channelName
    const res = run(sheets, links, scenario);
    assert.strictEqual(res.fixedRows.length, 1, '兜底 BOC → 命中');
  });
});

// ========================================================================
// 11. 分组空行忽略
// ========================================================================
test.describe('分组空行忽略 — 分组为空的链接表行不参与', () => {
  test('分组为空的链接表行（2.2 已剔除）不进任何组、不影响成功组', () => {
    const links = [
      linkRow({ group: '', alloc: 'ALC-IGNORED', reconLinkId: 'RID-X', ccy1Amount: 999 }), // 分组空 → 忽略
      linkRow({ group: '1', alloc: 'ALC-1', reconLinkId: 'RID-A', ccy1Amount: 100 })
    ];
    const sheets = {
      opponentBills: [channelRow({ reconId: 'RID-X' }), channelRow({ reconId: 'RID-A' })],
      businessBills: [gwRow({ orderId: 'ALC-1' }), gwRow({ orderId: 'ALC-IGNORED' })]
    };
    const res = run(sheets, links);
    assert.strictEqual(res.stats.linkGroupTotal, 1, '只有 1 个非空分组');
    assert.strictEqual(res.fixedRows.length, 1);
    assert.strictEqual(res.fixedRows[0].Reference, 'RID-A');
    // RID-X 渠道行未命中链接表（分组空行不进 reconId 索引）→ channelUnlinked 计数
    assert.strictEqual(res.stats.channelUnlinked, 1);
  });
});

// ========================================================================
// 12. 入参不可变 —— 深快照断言
// ========================================================================
test.describe('入参不可变 — sheets 三数组与 bocLinkRows 不被修改', () => {
  test('run 后入参与运行前深快照 byte-for-byte 一致', () => {
    const links = [
      linkRow({ group: '1', alloc: 'ALC-1', reconLinkId: 'RID-A', ccy1Amount: 100 }),
      linkRow({ group: '1', alloc: 'ALC-1', reconLinkId: 'RID-B', ccy1Amount: 200 })
    ];
    const sheets = {
      reconResult: [{ x: 1 }],
      opponentBills: [channelRow({ reconId: 'RID-A' }), channelRow({ reconId: 'RID-B' })],
      businessBills: [gwRow({ orderId: 'ALC-1' })]
    };
    const linksSnap = JSON.stringify(links);
    const sheetsSnap = JSON.stringify(sheets);
    const res = run(sheets, links);
    assert.strictEqual(res.fixedRows.length, 2, '前置：本案确实命中（否则不可变断言无意义）');
    assert.strictEqual(JSON.stringify(links), linksSnap, 'bocLinkRows 不被修改');
    assert.strictEqual(JSON.stringify(sheets), sheetsSnap, 'sheets 三数组不被修改');
  });
});

// ========================================================================
// 13. 分流回归 —— runReconIdFix 四路
// ========================================================================
test.describe('分流 — runReconIdFix 按 config.subCategory（四路）', () => {
  test('subCategory=boc-dispatch-order-fix → 走 BOC 引擎（无 admUpdates、有 stats.channelBocTotal）', () => {
    const links = [linkRow({ group: '1', alloc: 'ALC-1', reconLinkId: 'RID-A', ccy1Amount: 100 })];
    const scenario = { id: 1, name: 'BOC', category: 'gateway-recon-id-fix', config: { subCategory: 'boc-dispatch-order-fix', channelName: 'BOC' } };
    const sheets = {
      reconResult: [],
      businessBills: [gwRow({ orderId: 'ALC-1' })],
      opponentBills: [channelRow({ reconId: 'RID-A' })]
    };
    const res = runReconIdFix(scenario, sheets, { bocLinkRows: links });
    assert.strictEqual(res.admUpdates, undefined, 'BOC 引擎不返回 admUpdates');
    assert.ok(res.stats && typeof res.stats.channelBocTotal === 'number', 'BOC 引擎特征 stats');
    assert.strictEqual(res.fixedRows.length, 1);
  });

  test('JPM 分流不回归（subCategory=jpm-dispatch-order-fix → 仍走 JPM，返回 admUpdates）', () => {
    const scenario = { id: 2, name: 'JPM', category: 'gateway-recon-id-fix', config: { subCategory: 'jpm-dispatch-order-fix', merchantId: '6300156616' } };
    const res = runReconIdFix(scenario, { businessBills: [], opponentBills: [] }, { admRows: [] });
    assert.ok(Array.isArray(res.admUpdates), 'JPM 引擎仍返回 admUpdates');
  });

  test('普通 gateway 场景（无 subCategory）→ 走 C4（无 admUpdates、无 channelBocTotal）', () => {
    const scenario = { id: 3, name: 'C4网关', category: 'gateway-recon-id-fix', config: { billTypes: [], reconGroups: [], output: {} } };
    const res = runReconIdFix(scenario, { businessBills: [], opponentBills: [], reconResult: [] });
    assert.strictEqual(res.admUpdates, undefined);
    assert.strictEqual(res.stats && res.stats.channelBocTotal, undefined, '非 BOC 引擎无 channelBocTotal');
  });

  test('business 场景 → 走 C4（不回归）', () => {
    const scenario = { id: 4, name: 'C4单据', category: 'recon-id-fix', config: { billTypes: [], reconGroups: [], output: {} } };
    const res = runReconIdFix(scenario, { businessBills: [], opponentBills: [], reconResult: [] });
    assert.strictEqual(res.admUpdates, undefined);
  });

  test('BOC 分流不传 bocLinkRows（旧 2 参兼容）→ bocLinkRows 默认 [] → boc-link-table-empty 早返回不抛', () => {
    const scenario = { id: 5, name: 'BOC', category: 'gateway-recon-id-fix', config: { subCategory: 'boc-dispatch-order-fix', channelName: 'BOC' } };
    const res = runReconIdFix(scenario, { businessBills: [], opponentBills: [channelRow({ reconId: 'RID-A' })] });
    assert.strictEqual(res.fixedRows.length, 0);
    assert.ok(res.warnings.some((w) => w.code === 'boc-link-table-empty'));
  });
});

// ========================================================================
// 14. stats 完整性 —— 全部键存在且类型正确
// ========================================================================
test.describe('stats 完整性', () => {
  test('返回 stats 含 spec 列出的全部键（含 fixedRowCount）', () => {
    const links = [linkRow({ group: '1', alloc: 'ALC-1', reconLinkId: 'RID-A', ccy1Amount: 100 })];
    const sheets = {
      opponentBills: [channelRow({ reconId: 'RID-A' }), channelRow({ reconId: '' }), channelRow({ reconId: 'NO-LINK' })],
      businessBills: [gwRow({ orderId: 'ALC-1' })]
    };
    const res = run(sheets, links);
    const keys = [
      'channelTotal', 'channelBocTotal', 'channelEmptyReconId', 'channelUnlinked',
      'linkRowTotal', 'linkGroupTotal', 'groupTouched', 'groupMatched', 'groupFailed', 'fixedRowCount'
    ];
    for (const k of keys) {
      assert.ok(Object.prototype.hasOwnProperty.call(res.stats, k), `stats 缺键 ${k}`);
      assert.strictEqual(typeof res.stats[k], 'number', `stats.${k} 应为 number`);
    }
    // 具体计数核对
    assert.strictEqual(res.stats.channelTotal, 3);
    assert.strictEqual(res.stats.channelBocTotal, 3);
    assert.strictEqual(res.stats.channelEmptyReconId, 1, '1 条空 reconId');
    assert.strictEqual(res.stats.channelUnlinked, 1, '1 条 NO-LINK 未命中链接表');
    assert.strictEqual(res.stats.fixedRowCount, 1);
  });
});
