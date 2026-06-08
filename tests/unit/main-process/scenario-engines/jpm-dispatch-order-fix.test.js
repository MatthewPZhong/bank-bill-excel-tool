// v2.1.16-beta.5 需求5：JPM 调拨订单修复引擎 8 步状态机单测（🔴 资金红线）
//
// 覆盖（对应 PRD §6.5 AC5-1~AC5-9 + TECH §九.1 测试矩阵）：
//   步骤2 出账日期提取：样例 / JSON 金额不误匹配 / 缺失跳过+warn / 非法日期
//   步骤4 金额汇总：逐笔转分累加 / 浮点 0.1+0.2 / 任一非数值不匹配 / 汇总≠不命中
//   步骤5/6 gating：同批次号全为1 才进网关；部分匹配不进
//   步骤7 Type：批次行数=1→Type=0、>1→Type=2；OrderId↔调拨号 1v1；无匹配/多匹配 warn
//   步骤8 fixedRows = Type∧Reference 有值
//   merchantId 不命中 → 空 fixedRows
//   admUpdates 行数/顺序与输入一致（遵守 PR-1 契约）+ writeAdmMatchFlags round-trip
//   分流：subCategory=jpm → 新引擎；普通 gateway/business → 原 C4（不回归）

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const {
  runJpmDispatchOrderFix,
  extractBillDate,
  sumEqualsReceive,
  toIsoDate,
  GW_TYPE_COL
} = require('../../../../src/main-process/scenario-engines/jpm-dispatch-order-fix');
const { runReconIdFix } = require('../../../../src/main-process/recon-id-fix-engine');
const { ADM_MERCHANT_ID } = require('../../../../src/constants/adm-bank-deposit-fields');
const { GATEWAY_BILL_FIELDS } = require('../../../../src/constants/gateway-bill-recon-fields');

const MID = ADM_MERCHANT_ID; // '6300156616'

// ====== 测试辅助：构造 ADM 行 / 渠道账单行 / 网关账单行 ======

function admRow({ recon = '', billDate = '2026-05-04', batchNo = '', orderNo = 'CO1', alloc = '', fundInAmt = '', channelMatched = 0, gatewayMatched = 0 } = {}) {
  return {
    ReconciliationId: recon,
    BillDate: billDate,
    ChannelOrderNo: orderNo,
    '批次号': batchNo,
    '调拨号': alloc,
    'Fundtransfer-in金额': fundInAmt,
    '资金对账ID': '',
    '是否与渠道账单匹配': channelMatched,
    '是否与网关账单匹配': gatewayMatched
  };
}

function channelRow({ merchantId = MID, reconId = 'RECON-X', receiveAmount = 0, additionInfo = '' } = {}) {
  return { merchantId, reconciliationId: reconId, receiveAmount, additionInfo };
}

function gwRow({ merchantId = MID, orderId = '', reference = '', type = '', billDate = '2026-05-04', amount = 0 } = {}) {
  const r = {
    BillDate: billDate,
    Bank: 'JPM',
    MerchantId: merchantId,
    OrderId: orderId,
    DataSource: '',
    OppBu: '',
    OriginBillSource: '',
    BillType: '',
    Reference: reference,
    Currency: 'USD',
    Amount: amount,
    OriginBillBizId: '',
    ReconBillBizId: ''
  };
  r[GW_TYPE_COL] = type;
  return r;
}

const SCENARIO = { id: 99, name: 'JPM调拨订单修复', config: { subCategory: 'jpm-dispatch-order-fix', merchantId: MID } };

function run(sheets, admRows) {
  return runJpmDispatchOrderFix({ sheets, admRows, scenario: SCENARIO });
}

// ========================================================================
// 步骤2：出账日期提取
// ========================================================================
test.describe('步骤2 — additionInfo 出账日期提取', () => {
  test('真实样例 ATS OF 26/05/04 → 2026-05-04', () => {
    assert.strictEqual(
      extractBillDate('PAYDET=/ROC/ATS OF 26/05/04  {"prtryAmt":[],"txAmt":{"amt":{"amount":2100000.00,"currency":"USD"}}}'),
      '2026-05-04'
    );
  });

  test('JSON 内金额 2100000.00（无斜杠）不误匹配 → null', () => {
    assert.strictEqual(extractBillDate('{"amount":2100000.00,"x":1}'), null);
  });

  test('行首日期（^ 定界）26/05/04 命中', () => {
    assert.strictEqual(extractBillDate('26/05/04 something'), '2026-05-04');
  });

  test('提取不到 → null', () => {
    assert.strictEqual(extractBillDate('no date here'), null);
    assert.strictEqual(extractBillDate(''), null);
    assert.strictEqual(extractBillDate(null), null);
    assert.strictEqual(extractBillDate(undefined), null);
  });

  test('非法日期 26/13/40（13 月）→ null（toDate 校验）', () => {
    assert.strictEqual(extractBillDate('ATS OF 26/13/40 x'), null);
  });

  test('斜杠日期需空白定界：紧贴文字 OF26/05/04x 不命中', () => {
    assert.strictEqual(extractBillDate('OF26/05/04x'), null);
  });

  test('toIsoDate 与 ADM BillDate 规范化口径一致（2026/05/04 与 2026-05-04 同值）', () => {
    assert.strictEqual(toIsoDate('2026/05/04'), '2026-05-04');
    assert.strictEqual(toIsoDate('2026-05-04'), '2026-05-04');
  });
});

// ========================================================================
// 步骤4：金额整组汇总（逐笔转分累加，容差0）
// ========================================================================
test.describe('步骤4 — Fundtransfer-in金额 逐笔转分累加 === receiveAmount', () => {
  test('整组汇总 15000+6000=21000 === receiveAmount 命中', () => {
    assert.strictEqual(
      sumEqualsReceive([{ 'Fundtransfer-in金额': 15000 }, { 'Fundtransfer-in金额': 6000 }], 21000),
      true
    );
  });

  test('浮点 0.1+0.2 逐笔转分 === 0.3 命中（严禁先浮点累加后 round）', () => {
    assert.strictEqual(
      sumEqualsReceive([{ 'Fundtransfer-in金额': 0.1 }, { 'Fundtransfer-in金额': 0.2 }], 0.3),
      true
    );
  });

  test('任一非数值 → 整组不匹配', () => {
    assert.strictEqual(sumEqualsReceive([{ 'Fundtransfer-in金额': 'abc' }], 0), false);
    assert.strictEqual(
      sumEqualsReceive([{ 'Fundtransfer-in金额': 100 }, { 'Fundtransfer-in金额': '' }], 100),
      false
    );
  });

  test('汇总 ≠ receiveAmount → 不命中（容差0）', () => {
    assert.strictEqual(
      sumEqualsReceive([{ 'Fundtransfer-in金额': 100 }, { 'Fundtransfer-in金额': 100 }], 200.01),
      false
    );
  });

  test('字符串数字 + 千分位逗号可解析', () => {
    assert.strictEqual(
      sumEqualsReceive([{ 'Fundtransfer-in金额': '15,000' }, { 'Fundtransfer-in金额': '6000' }], '21000'),
      true
    );
  });
});

// ========================================================================
// 步骤1：merchantId 过滤
// ========================================================================
test.describe('步骤1 — merchantId 过滤', () => {
  test('渠道账单无指定 merchantId → 空 fixedRows + warn + admUpdates 原样', () => {
    const adm = [admRow({ alloc: 'A1', fundInAmt: 100 })];
    const sheets = {
      opponentBills: [channelRow({ merchantId: '999', receiveAmount: 100, additionInfo: 'ATS OF 26/05/04' })],
      businessBills: [gwRow({ orderId: 'A1' })]
    };
    const res = run(sheets, adm);
    assert.strictEqual(res.fixedRows.length, 0);
    assert.strictEqual(res.admUpdates, adm, 'admUpdates 必须是传入的同一数组');
    assert.ok(res.warnings.some((w) => w.code === 'channel-merchant-not-found'));
    // ADM 标志未被改写
    assert.strictEqual(adm[0]['是否与渠道账单匹配'], 0);
  });
});

// ========================================================================
// 步骤5/6/7/8：完整链路 + Type 分支
// ========================================================================
test.describe('完整链路 — 单批次多调拨号（Type=2）', () => {
  test('2 调拨号同批次 → 全命中、Type=2、fixedRows=2', () => {
    const adm = [
      admRow({ recon: 'R1', batchNo: '2026-05-04-CO1', orderNo: 'CO1', alloc: 'A1', fundInAmt: 15000 }),
      admRow({ recon: 'R2', batchNo: '2026-05-04-CO1', orderNo: 'CO1', alloc: 'A2', fundInAmt: 6000 })
    ];
    const sheets = {
      opponentBills: [channelRow({ reconId: 'RECON-X', receiveAmount: 21000, additionInfo: 'ATS OF 26/05/04 {"amount":21000.00}' })],
      businessBills: [gwRow({ orderId: 'A1', amount: 15000 }), gwRow({ orderId: 'A2', amount: 6000 })]
    };
    const res = run(sheets, adm);
    // ADM 渠道段命中
    assert.strictEqual(adm[0]['是否与渠道账单匹配'], 1);
    assert.strictEqual(adm[1]['是否与渠道账单匹配'], 1);
    assert.strictEqual(adm[0]['资金对账ID'], 'RECON-X');
    assert.strictEqual(adm[1]['资金对账ID'], 'RECON-X');
    // ADM 网关段命中
    assert.strictEqual(adm[0]['是否与网关账单匹配'], 1);
    assert.strictEqual(adm[1]['是否与网关账单匹配'], 1);
    // fixedRows = 2，Type=2（批次行数>1），Reference=资金对账ID
    assert.strictEqual(res.fixedRows.length, 2);
    for (const fr of res.fixedRows) {
      assert.strictEqual(fr.Type, 2, '批次行数>1 → Type=2');
      assert.strictEqual(fr.Reference, 'RECON-X');
    }
    assert.deepStrictEqual(res.fixedRows.map((r) => r.OrderId).sort(), ['A1', 'A2']);
  });
});

test.describe('完整链路 — 单批次单调拨号（Type=0）', () => {
  test('1 调拨号 → Type=0、fixedRows=1', () => {
    const adm = [admRow({ recon: 'R1', batchNo: '2026-05-04-CO1', orderNo: 'CO1', alloc: 'A1', fundInAmt: 21000 })];
    const sheets = {
      opponentBills: [channelRow({ reconId: 'RECON-Y', receiveAmount: 21000, additionInfo: 'ATS OF 26/05/04' })],
      businessBills: [gwRow({ orderId: 'A1', amount: 21000 })]
    };
    const res = run(sheets, adm);
    assert.strictEqual(res.fixedRows.length, 1);
    assert.strictEqual(res.fixedRows[0].Type, 0, '批次行数=1 → Type=0');
    assert.strictEqual(res.fixedRows[0].Reference, 'RECON-Y');
  });
});

// F2 修复（self-review）：同批次号可跨多个出账日期，各日期赋不同渠道 reconId → Reference 必须行级取
test.describe('F2 修复 — 同批次跨多出账日期不同 reconId → Reference 行级', () => {
  test('批次 CO1 跨 05-04(RC1)/05-05(RC2)：网关 A2→Reference=RC2（行级，非批级首行 RC1）', () => {
    const adm = [
      admRow({ billDate: '2026-05-04', batchNo: '2026-05-04-CO1', orderNo: 'CO1', alloc: 'A1', fundInAmt: 100 }),
      admRow({ billDate: '2026-05-05', batchNo: '2026-05-04-CO1', orderNo: 'CO1', alloc: 'A2', fundInAmt: 200 })
    ];
    const sheets = {
      opponentBills: [
        channelRow({ reconId: 'RC1', receiveAmount: 100, additionInfo: 'ATS OF 26/05/04 ' }),
        channelRow({ reconId: 'RC2', receiveAmount: 200, additionInfo: 'ATS OF 26/05/05 ' })
      ],
      businessBills: [gwRow({ orderId: 'A1' }), gwRow({ orderId: 'A2' })]
    };
    const res = run(sheets, adm);
    // 渠道段：各出账日期组各自命中、赋不同 reconId（组内非同值，正是 F2 的前提）
    assert.strictEqual(adm[0]['资金对账ID'], 'RC1');
    assert.strictEqual(adm[1]['资金对账ID'], 'RC2');
    const byOrder = Object.fromEntries(res.fixedRows.map((r) => [r.OrderId, r]));
    assert.strictEqual(byOrder['A1'].Reference, 'RC1');
    // 🔴 F2 核心：A2 的 Reference 必须行级取 ADM[1] 的 RC2；旧实现批级 batchRows[0] 会错写 RC1
    assert.strictEqual(byOrder['A2'].Reference, 'RC2', 'F2: Reference 行级取对应 ADM 行，非批级首行');
    assert.strictEqual(byOrder['A1'].Type, 2);
    assert.strictEqual(byOrder['A2'].Type, 2);
  });
});

// F3b 修复（self-review）：同出账日期多笔渠道账单 → 显式 collision warn（每日期一次）
test.describe('F3b 修复 — 同出账日期多笔渠道账单 → channel-date-collision warn', () => {
  test('两笔渠道账单同出账日期 → 恰一条 channel-date-collision warn', () => {
    const adm = [admRow({ billDate: '2026-05-04', batchNo: '2026-05-04-CO1', orderNo: 'CO1', alloc: 'A1', fundInAmt: 100 })];
    const sheets = {
      opponentBills: [
        channelRow({ reconId: 'RC1', receiveAmount: 100, additionInfo: 'ATS OF 26/05/04 ' }),
        channelRow({ reconId: 'RC2', receiveAmount: 200, additionInfo: 'ATS OF 26/05/04 ' })
      ],
      businessBills: [gwRow({ orderId: 'A1' })]
    };
    const res = run(sheets, adm);
    const collisions = res.warnings.filter((w) => w.code === 'channel-date-collision');
    assert.strictEqual(collisions.length, 1, '同出账日期多笔渠道账单 → 每日期一条 collision warn');
    assert.strictEqual(collisions[0].billDate, '2026-05-04');
  });
});

test.describe('步骤4 不命中 — 金额不平不写标志', () => {
  test('整组汇总 ≠ receiveAmount → 不命中、不进网关、warn', () => {
    const adm = [admRow({ recon: 'R1', batchNo: '2026-05-04-CO1', alloc: 'A1', fundInAmt: 15000 })];
    const sheets = {
      opponentBills: [channelRow({ receiveAmount: 99999, additionInfo: 'ATS OF 26/05/04' })],
      businessBills: [gwRow({ orderId: 'A1' })]
    };
    const res = run(sheets, adm);
    assert.strictEqual(adm[0]['是否与渠道账单匹配'], 0, '金额不平 → 不置渠道匹配');
    assert.strictEqual(res.fixedRows.length, 0);
    assert.ok(res.warnings.some((w) => w.code === 'channel-amount-mismatch'));
  });
});

test.describe('步骤6 批次 gating — 部分匹配不进网关', () => {
  test('同批次号 2 行跨 2 出账日期，仅 1 行渠道命中 → 批次不进网关段', () => {
    // 同批次 CO1：A1(出账 05-04) 命中，A2(出账 05-05) 金额不平不命中 → 批次未全为1
    const adm = [
      admRow({ recon: 'R1', billDate: '2026-05-04', batchNo: '2026-05-04-CO1', orderNo: 'CO1', alloc: 'A1', fundInAmt: 100 }),
      admRow({ recon: 'R2', billDate: '2026-05-05', batchNo: '2026-05-04-CO1', orderNo: 'CO1', alloc: 'A2', fundInAmt: 200 })
    ];
    const sheets = {
      // 渠道1：出账 05-04 receiveAmount=100 命中 A1；渠道2：出账 05-05 receiveAmount=999 不平 A2
      opponentBills: [
        channelRow({ reconId: 'RC1', receiveAmount: 100, additionInfo: 'ATS OF 26/05/04' }),
        channelRow({ reconId: 'RC2', receiveAmount: 999, additionInfo: 'ATS OF 26/05/05' })
      ],
      businessBills: [gwRow({ orderId: 'A1' }), gwRow({ orderId: 'A2' })]
    };
    const res = run(sheets, adm);
    assert.strictEqual(adm[0]['是否与渠道账单匹配'], 1, 'A1 渠道命中');
    assert.strictEqual(adm[1]['是否与渠道账单匹配'], 0, 'A2 金额不平未命中');
    // 批次未全为1 → 不进网关段 → 无网关匹配、无 fixedRows
    assert.strictEqual(adm[0]['是否与网关账单匹配'], 0, '批次未齐 → 不进网关');
    assert.strictEqual(res.fixedRows.length, 0);
    assert.strictEqual(res.stats.readyBatches, 0);
  });

  test('同批次号 2 行跨 2 出账日期，各自命中 → 批次进网关段', () => {
    const adm = [
      admRow({ recon: 'R1', billDate: '2026-05-04', batchNo: '2026-05-04-CO1', orderNo: 'CO1', alloc: 'A1', fundInAmt: 100 }),
      admRow({ recon: 'R2', billDate: '2026-05-05', batchNo: '2026-05-04-CO1', orderNo: 'CO1', alloc: 'A2', fundInAmt: 200 })
    ];
    const sheets = {
      opponentBills: [
        channelRow({ reconId: 'RC1', receiveAmount: 100, additionInfo: 'ATS OF 26/05/04' }),
        channelRow({ reconId: 'RC2', receiveAmount: 200, additionInfo: 'ATS OF 26/05/05' })
      ],
      businessBills: [gwRow({ orderId: 'A1' }), gwRow({ orderId: 'A2' })]
    };
    const res = run(sheets, adm);
    assert.strictEqual(adm[0]['是否与渠道账单匹配'], 1);
    assert.strictEqual(adm[1]['是否与渠道账单匹配'], 1);
    assert.strictEqual(res.stats.readyBatches, 1, '批次齐 → 进网关段');
    // 注：两出账日期各自的资金对账ID不同（RC1/RC2），组内同值取首行（RC1）写 Reference
    assert.strictEqual(res.fixedRows.length, 2);
    assert.strictEqual(res.fixedRows[0].Type, 2, '批次行数 2 → Type=2');
  });
});

test.describe('步骤7 网关匹配异常 — warn', () => {
  test('网关无 OrderId 对应调拨号 → gw-orderid-not-found warn、该行无网关匹配', () => {
    const adm = [admRow({ recon: 'R1', batchNo: '2026-05-04-CO1', alloc: 'A1', fundInAmt: 100 })];
    const sheets = {
      opponentBills: [channelRow({ receiveAmount: 100, additionInfo: 'ATS OF 26/05/04' })],
      businessBills: [gwRow({ orderId: 'OTHER' })] // OrderId 对不上 A1
    };
    const res = run(sheets, adm);
    assert.strictEqual(adm[0]['是否与渠道账单匹配'], 1, '渠道段仍命中');
    assert.strictEqual(adm[0]['是否与网关账单匹配'], 0, '网关无对应 → 未匹配');
    assert.strictEqual(res.fixedRows.length, 0);
    assert.ok(res.warnings.some((w) => w.code === 'gw-orderid-not-found'));
  });

  test('网关多行匹配同调拨号 → gw-multi-match warn、取第一行', () => {
    const adm = [admRow({ recon: 'R1', batchNo: '2026-05-04-CO1', alloc: 'A1', fundInAmt: 100 })];
    const sheets = {
      opponentBills: [channelRow({ reconId: 'RECON-M', receiveAmount: 100, additionInfo: 'ATS OF 26/05/04' })],
      businessBills: [gwRow({ orderId: 'A1', amount: 100 }), gwRow({ orderId: 'A1', amount: 999 })]
    };
    const res = run(sheets, adm);
    assert.ok(res.warnings.some((w) => w.code === 'gw-multi-match'));
    assert.strictEqual(res.fixedRows.length, 1, '取第一行 → 仅 1 行 fixedRows');
    assert.strictEqual(res.fixedRows[0].Reference, 'RECON-M');
  });

  test('OrderId↔调拨号 1v1 消费：两调拨号不同 → 各匹配各自网关行', () => {
    const adm = [
      admRow({ recon: 'R1', batchNo: '2026-05-04-CO1', orderNo: 'CO1', alloc: 'A1', fundInAmt: 100 }),
      admRow({ recon: 'R2', batchNo: '2026-05-04-CO1', orderNo: 'CO1', alloc: 'A2', fundInAmt: 100 })
    ];
    const sheets = {
      opponentBills: [channelRow({ receiveAmount: 200, additionInfo: 'ATS OF 26/05/04' })],
      businessBills: [gwRow({ orderId: 'A1' }), gwRow({ orderId: 'A2' })]
    };
    const res = run(sheets, adm);
    assert.strictEqual(res.fixedRows.length, 2);
    assert.deepStrictEqual(res.fixedRows.map((r) => r.OrderId).sort(), ['A1', 'A2']);
  });
});

test.describe('步骤8 — fixedRows = Type ∧ Reference 均有值', () => {
  test('未命中网关行（Type/Reference 空）不进 fixedRows', () => {
    const adm = [admRow({ recon: 'R1', batchNo: '2026-05-04-CO1', alloc: 'A1', fundInAmt: 100 })];
    const sheets = {
      opponentBills: [channelRow({ receiveAmount: 100, additionInfo: 'ATS OF 26/05/04' })],
      businessBills: [
        gwRow({ orderId: 'A1' }), // 会被命中 → 进 fixedRows
        gwRow({ orderId: 'ZZZ' }) // 不被命中 → Reference/Type 空 → 不进 fixedRows
      ]
    };
    const res = run(sheets, adm);
    assert.strictEqual(res.fixedRows.length, 1);
    assert.strictEqual(res.fixedRows[0].OrderId, 'A1');
  });
});

test.describe('调拨号为空 — 不进网关匹配', () => {
  test('ADM 行调拨号空（中台未匹配）→ 渠道命中但不进网关', () => {
    const adm = [admRow({ recon: 'R1', batchNo: '2026-05-04-CO1', alloc: '', fundInAmt: 100 })];
    const sheets = {
      opponentBills: [channelRow({ receiveAmount: 100, additionInfo: 'ATS OF 26/05/04' })],
      businessBills: [gwRow({ orderId: 'A1' })]
    };
    const res = run(sheets, adm);
    assert.strictEqual(adm[0]['是否与渠道账单匹配'], 1);
    assert.strictEqual(adm[0]['是否与网关账单匹配'], 0, '调拨号空 → 不进网关');
    assert.strictEqual(res.fixedRows.length, 0);
  });
});

// ========================================================================
// admUpdates 契约（遵守 PR-1 writeAdmMatchFlags）+ round-trip
// ========================================================================
test.describe('admUpdates 契约 — 同一数组、行数顺序不变', () => {
  test('admUpdates === 入参 admRows，长度不变（无 filter/重排/增删）', () => {
    const adm = [
      admRow({ recon: 'R1', batchNo: '2026-05-04-CO1', alloc: 'A1', fundInAmt: 100 }),
      admRow({ recon: 'R2', batchNo: '', alloc: '', fundInAmt: 50 }), // 无批次号、不参与
      admRow({ recon: 'R3', billDate: '2099-01-01', alloc: '', fundInAmt: 0 }) // 日期对不上任何渠道
    ];
    const sheets = {
      opponentBills: [channelRow({ receiveAmount: 100, additionInfo: 'ATS OF 26/05/04' })],
      businessBills: [gwRow({ orderId: 'A1' })]
    };
    const res = run(sheets, adm);
    assert.strictEqual(res.admUpdates, adm);
    assert.strictEqual(res.admUpdates.length, 3, '行数不变');
    // 未参与的行保持初值
    assert.strictEqual(adm[1]['是否与渠道账单匹配'], 0);
    assert.strictEqual(adm[2]['是否与渠道账单匹配'], 0);
  });

  test('round-trip：readAdmBankDepositRows → run → writeAdmMatchFlags 落库', () => {
    const repo = require('../../../../src/backend/database/linked-table-repository');
    const m = require('../../../../src/backend/database/migrations');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jpm-rt-'));
    const db = new DatabaseSync(path.join(tmp, 't.sqlite'));
    db.exec('PRAGMA foreign_keys = ON;');
    try {
      m.ensureAdmBankDepositSupport(db);
      const seed = [
        admRow({ recon: 'R1', batchNo: '2026-05-04-CO1', orderNo: 'CO1', alloc: 'A1', fundInAmt: 15000 }),
        admRow({ recon: 'R2', batchNo: '2026-05-04-CO1', orderNo: 'CO1', alloc: 'A2', fundInAmt: 6000 })
      ];
      repo.replaceAdmBankDeposit(db, seed);
      const loaded = repo.readAdmBankDepositRows(db); // ORDER BY id ASC
      const sheets = {
        opponentBills: [channelRow({ reconId: 'RECON-RT', receiveAmount: 21000, additionInfo: 'ATS OF 26/05/04' })],
        businessBills: [gwRow({ orderId: 'A1', amount: 15000 }), gwRow({ orderId: 'A2', amount: 6000 })]
      };
      const res = runJpmDispatchOrderFix({ sheets, admRows: loaded, scenario: SCENARIO });
      assert.strictEqual(res.admUpdates, loaded);
      // 写回不抛错（行数一致）
      assert.doesNotThrow(() => repo.writeAdmMatchFlags(db, res.admUpdates));
      const reloaded = repo.readAdmBankDepositRows(db);
      assert.strictEqual(reloaded[0]['资金对账ID'], 'RECON-RT');
      assert.strictEqual(reloaded[0]['是否与渠道账单匹配'], 1);
      assert.strictEqual(reloaded[0]['是否与网关账单匹配'], 1);
      assert.strictEqual(reloaded[1]['资金对账ID'], 'RECON-RT');
    } finally {
      db.close();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// ========================================================================
// M9.1 修复（self-review）：引擎真幂等 —— 二次运行（ADM 标志残留）stats 不失真
// ========================================================================
test.describe('M9.1 修复 — 入口重置标志 → 二次运行幂等', () => {
  // 模拟生产：run 之间 sheets 是 fresh clone（main.js 传 clonedSheets），仅 ADM 行经 DB 持久化残留标志。
  function freshSheets() {
    return {
      opponentBills: [channelRow({ reconId: 'RECON-X', receiveAmount: 21000, additionInfo: 'ATS OF 26/05/04' })],
      businessBills: [gwRow({ orderId: 'A1', amount: 15000 }), gwRow({ orderId: 'A2', amount: 6000 })]
    };
  }

  test('同一 ADM 数组连跑两次（run1 已置标志1）→ run2 stats/fixedRows 与 run1 完全一致', () => {
    const adm = [
      admRow({ recon: 'R1', batchNo: '2026-05-04-CO1', orderNo: 'CO1', alloc: 'A1', fundInAmt: 15000 }),
      admRow({ recon: 'R2', batchNo: '2026-05-04-CO1', orderNo: 'CO1', alloc: 'A2', fundInAmt: 6000 })
    ];
    // run1：把 adm 标志原地置 1（模拟 writeAdmMatchFlags 持久化回 ADM 表）
    const res1 = run(freshSheets(), adm);
    assert.strictEqual(adm[0]['是否与渠道账单匹配'], 1, 'run1 后标志残留=1');
    assert.strictEqual(res1.stats.channelHit, 1);
    assert.strictEqual(res1.fixedRows.length, 2);
    // run2：复用 run1 改过的同一 adm（未重建）→ 入口重置后结果应与 run1 一致
    const res2 = run(freshSheets(), adm);
    assert.deepStrictEqual(res2.stats, res1.stats, 'M9.1：二次运行 stats 与首次一致（修复前 channelHit 失真为 0）');
    assert.strictEqual(res2.stats.channelHit, 1, '修复前此处为 0（候选 ADM 行被残留标志筛空）');
    assert.strictEqual(res2.stats.admChannelMatched, 2);
    assert.strictEqual(res2.stats.gwHit, 2);
    assert.strictEqual(res2.fixedRows.length, 2);
    // 重置→重算→重新置1：二次运行后 ADM 仍为命中态
    assert.strictEqual(adm[0]['是否与渠道账单匹配'], 1);
    assert.strictEqual(adm[0]['资金对账ID'], 'RECON-X');
  });

  test('no-op run（merchantId 不命中，channels=0）不清掉上一轮已持久化的标志', () => {
    const adm = [admRow({ recon: 'R1', batchNo: '2026-05-04-CO1', orderNo: 'CO1', alloc: 'A1', fundInAmt: 21000, channelMatched: 1, gatewayMatched: 1 })];
    adm[0]['资金对账ID'] = 'RECON-PERSIST';
    // 商户号对不上 → channels=0 早返回（在重置块之前）→ 不应动标志
    const sheets = { opponentBills: [channelRow({ merchantId: '999', receiveAmount: 21000, additionInfo: 'ATS OF 26/05/04' })], businessBills: [] };
    run(sheets, adm);
    assert.strictEqual(adm[0]['是否与渠道账单匹配'], 1, 'no-op run 不重置已持久化标志');
    assert.strictEqual(adm[0]['资金对账ID'], 'RECON-PERSIST');
  });
});

// ========================================================================
// 空入参鲁棒性
// ========================================================================
test.describe('鲁棒性 — 空入参不抛异常', () => {
  test('无 ADM 行 → 空 fixedRows', () => {
    const sheets = {
      opponentBills: [channelRow({ receiveAmount: 100, additionInfo: 'ATS OF 26/05/04' })],
      businessBills: [gwRow({ orderId: 'A1' })]
    };
    const res = run(sheets, []);
    assert.strictEqual(res.fixedRows.length, 0);
    assert.ok(Array.isArray(res.admUpdates));
    assert.strictEqual(res.admUpdates.length, 0);
  });

  test('提取不到出账日期 → 跳过该渠道行 + warn，不抛', () => {
    const adm = [admRow({ alloc: 'A1', fundInAmt: 100 })];
    const sheets = {
      opponentBills: [channelRow({ receiveAmount: 100, additionInfo: 'no date' })],
      businessBills: [gwRow({ orderId: 'A1' })]
    };
    const res = run(sheets, adm);
    assert.ok(res.warnings.some((w) => w.code === 'addition-date-not-found'));
    assert.strictEqual(res.fixedRows.length, 0);
  });
});

// ========================================================================
// 分流（recon-id-fix-engine.runReconIdFix）
// ========================================================================
test.describe('分流 — runReconIdFix 按 config.subCategory', () => {
  test('subCategory=jpm-dispatch-order-fix → 走 JPM 引擎（返回 admUpdates）', () => {
    const adm = [admRow({ recon: 'R1', batchNo: '2026-05-04-CO1', alloc: 'A1', fundInAmt: 100 })];
    const scenario = { id: 1, name: 'JPM调拨订单修复', category: 'gateway-recon-id-fix', config: { subCategory: 'jpm-dispatch-order-fix', merchantId: MID } };
    const sheets = {
      reconResult: [],
      businessBills: [gwRow({ orderId: 'A1' })],
      opponentBills: [channelRow({ receiveAmount: 100, additionInfo: 'ATS OF 26/05/04' })]
    };
    const res = runReconIdFix(scenario, sheets, { admRows: adm });
    // JPM 引擎特征：返回带 admUpdates（C4 不返回）
    assert.ok(Array.isArray(res.admUpdates), 'JPM 引擎返回 admUpdates');
    assert.strictEqual(res.admUpdates, adm);
    assert.strictEqual(res.fixedRows.length, 1);
  });

  test('普通 gateway 场景（无 jpm subCategory）→ 走 C4（不回归，无 admUpdates）', () => {
    const scenario = { id: 2, name: 'C4网关', category: 'gateway-recon-id-fix', config: { billTypes: [], reconGroups: [], output: {} } };
    const res = runReconIdFix(scenario, { businessBills: [], opponentBills: [], reconResult: [] });
    assert.strictEqual(res.admUpdates, undefined, 'C4 引擎不返回 admUpdates');
    assert.ok(Array.isArray(res.fixedRows));
  });

  test('business 场景 → 走 C4（不回归）', () => {
    const scenario = { id: 3, name: 'C4单据', category: 'recon-id-fix', config: { billTypes: [], reconGroups: [], output: {} } };
    const res = runReconIdFix(scenario, { businessBills: [], opponentBills: [], reconResult: [] });
    assert.strictEqual(res.admUpdates, undefined);
  });

  test('JPM 分流不传 admRows（旧 2 参兼容）→ admRows 默认 [] 不抛', () => {
    const scenario = { id: 4, name: 'JPM', category: 'gateway-recon-id-fix', config: { subCategory: 'jpm-dispatch-order-fix', merchantId: MID } };
    const res = runReconIdFix(scenario, { businessBills: [], opponentBills: [] });
    assert.strictEqual(res.admUpdates.length, 0);
    assert.strictEqual(res.fixedRows.length, 0);
  });
});

// ========================================================================
// 常量护栏 — GW_TYPE_COL 指向超长缺括号 Type 列
// ========================================================================
test('GW_TYPE_COL === GATEWAY_BILL_FIELDS[8]（超长缺括号 Type 列）', () => {
  assert.strictEqual(GW_TYPE_COL, GATEWAY_BILL_FIELDS[8]);
  assert.ok(GW_TYPE_COL.startsWith('Type'));
});
