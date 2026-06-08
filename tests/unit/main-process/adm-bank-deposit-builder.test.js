// v2.1.16-beta.5 需求3（逻辑A）：ADM 银行对账单链接表派生纯函数单测（🔴 资金对账敏感）
//
// 覆盖 buildAdmRows / assignBatchNo / matchAdmToMidAllocation：
//   1) 筛选：Channel=ADM ∧ FundType∈{Fundtransfer-out, Fundtransfer-out&FX}（精确等于、大小写敏感）；
//      非 ADM / 非目标 FundType / 大小写 / 前后空格负例。
//   2) 批次号：同 ChannelOrderNo 组统一 BillDate（Excel 序列号 / 混格式不分裂）；ChannelOrderNo 空 → 批次号空。
//   3) 唯一匹配：clean 赋值；mid-duplicate / adm-duplicate / no-mid-match / empty-customerref 各分支；midEmpty。
//   4) 部分成功：admRows 全部落库（含未匹配行留空），unmatched 正确。
//
// 🔴 不变量（绝不能回退）：
//   · 两侧任一重复（中台侧 bucket>1 或 ADM 侧同 CustomerRef 多行）= 冲突，不赋值（防步骤4金额汇总重复累加）。
//   · 批次号必须归一日期（同组不同输入格式不分裂）。
//   · Fundtransfer-in金额 取中台「收款金额」原值（String 化，不数值化、不比较）。

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildAdmRows,
  assignBatchNo,
  matchAdmToMidAllocation,
  normalizeBillDateIso
} = require('../../../src/main-process/adm-bank-deposit-builder');
const {
  CHANNEL_VALUE,
  ADM_FUND_TYPES,
  ADM_EXTRA_FIELDS
} = require('../../../src/constants/adm-bank-deposit-fields');

// 造一行银行对账单 13 字段行（仅填测试关心字段，其余可缺省）。
function bankRow(overrides = {}) {
  return Object.assign({
    BizId: '',
    BillDate: '2026-05-04',
    ValueDate: '',
    Channel: 'ADM',
    地区: '',
    MerchantId: '6300156616',
    Currency: 'USD',
    'Credit Amount': '',
    'Debit Amount': '',
    ReconciliationId: '',
    ChannelOrderNo: '',
    CustomerRef: '',
    FundType: 'Fundtransfer-out'
  }, overrides);
}

// 造一行中台调拨订单（仅填匹配关心字段）。
function midRow(channelSerial, allocationNo, receiveAmount) {
  return {
    调拨单号: allocationNo,
    渠道流水号: channelSerial,
    收款金额: receiveAmount
  };
}

test.describe('buildAdmRows - 筛选（Channel=ADM ∧ FundType 白名单）', () => {
  test('Channel=ADM ∧ FundType=Fundtransfer-out → 进 ADM', () => {
    const out = buildAdmRows([bankRow({ ChannelOrderNo: 'CO1', CustomerRef: 'CR1' })], []);
    assert.equal(out.admRows.length, 1);
  });

  test('FundType=Fundtransfer-out&FX（含 &FX 后缀）→ 进 ADM', () => {
    const out = buildAdmRows([bankRow({ FundType: 'Fundtransfer-out&FX', ChannelOrderNo: 'CO1', CustomerRef: 'CR1' })], []);
    assert.equal(out.admRows.length, 1);
  });

  test('白名单两值都覆盖（与常量一致）', () => {
    assert.deepEqual([...ADM_FUND_TYPES], ['Fundtransfer-out', 'Fundtransfer-out&FX']);
    assert.equal(CHANNEL_VALUE, 'ADM');
  });

  test('Channel≠ADM（BANK）→ 不进', () => {
    const out = buildAdmRows([bankRow({ Channel: 'BANK' })], []);
    assert.equal(out.admRows.length, 0);
  });

  test('Channel 大小写敏感：adm（小写）→ 不进', () => {
    const out = buildAdmRows([bankRow({ Channel: 'adm' })], []);
    assert.equal(out.admRows.length, 0);
  });

  test('FundType 不在白名单（Fundtransfer-in）→ 不进', () => {
    const out = buildAdmRows([bankRow({ FundType: 'Fundtransfer-in' })], []);
    assert.equal(out.admRows.length, 0);
  });

  test('FundType 大小写敏感：fundtransfer-out（小写）→ 不进', () => {
    const out = buildAdmRows([bankRow({ FundType: 'fundtransfer-out' })], []);
    assert.equal(out.admRows.length, 0);
  });

  test('Channel / FundType 前后空格：trim 后等于 → 进（normCell trim）', () => {
    const out = buildAdmRows([bankRow({ Channel: ' ADM ', FundType: ' Fundtransfer-out ', ChannelOrderNo: 'CO1', CustomerRef: 'CR1' })], []);
    assert.equal(out.admRows.length, 1);
  });

  test('FundType 内部多空格（不可 trim 掉）→ 不进（精确等于）', () => {
    const out = buildAdmRows([bankRow({ FundType: 'Fundtransfer- out' })], []);
    assert.equal(out.admRows.length, 0);
  });

  test('非对象行 / null 行 → 跳过不崩', () => {
    const out = buildAdmRows([null, 'x', 123, bankRow({ ChannelOrderNo: 'CO1', CustomerRef: 'CR1' })], []);
    assert.equal(out.admRows.length, 1);
  });
});

test.describe('buildAdmRows - ADM 行结构（13 + 6 字段初值）', () => {
  test('6 新字段：匹配标志初始 0、其余空串；保留 13 银行字段', () => {
    const out = buildAdmRows([bankRow({ ChannelOrderNo: 'CO1', CustomerRef: 'CR1', ReconciliationId: 'R1' })], []);
    const r = out.admRows[0];
    // 13 银行字段保留
    assert.equal(r.Channel, 'ADM');
    assert.equal(r.FundType, 'Fundtransfer-out');
    assert.equal(r.ReconciliationId, 'R1');
    assert.equal(r.MerchantId, '6300156616');
    // 6 新字段全部存在
    for (const f of ADM_EXTRA_FIELDS) {
      assert.ok(Object.prototype.hasOwnProperty.call(r, f), `缺新字段 ${f}`);
    }
    // 匹配标志初始 0（数值）
    assert.strictEqual(r['是否与渠道账单匹配'], 0);
    assert.strictEqual(r['是否与网关账单匹配'], 0);
    // 资金对账ID / 调拨号 / Fundtransfer-in金额 初始空串（无中台匹配）
    assert.strictEqual(r['资金对账ID'], '');
    assert.strictEqual(r['调拨号'], '');
    assert.strictEqual(r['Fundtransfer-in金额'], '');
  });

  test('派生不修改源行（浅拷贝隔离）', () => {
    const src = bankRow({ ChannelOrderNo: 'CO1', CustomerRef: 'CR1' });
    buildAdmRows([src], []);
    assert.equal(Object.prototype.hasOwnProperty.call(src, '批次号'), false);
  });
});

test.describe('assignBatchNo / normalizeBillDateIso - 批次号', () => {
  test('normalizeBillDateIso 多格式归一同一 YYYY-MM-DD', () => {
    assert.equal(normalizeBillDateIso('2026-05-04'), '2026-05-04');
    assert.equal(normalizeBillDateIso('2026/05/04'), '2026-05-04');
    assert.equal(normalizeBillDateIso('20260504'), '2026-05-04');
    assert.equal(normalizeBillDateIso('2026.05.04'), '2026-05-04');
    assert.equal(normalizeBillDateIso(''), '');
    assert.equal(normalizeBillDateIso(null), '');
    assert.equal(normalizeBillDateIso('garbage'), '');
  });

  test('同 ChannelOrderNo 组：混合日期格式不分裂（统一首个可解析 BillDate 归一）', () => {
    const rows = [
      { ChannelOrderNo: 'CO1', BillDate: '2026-05-04', 批次号: '' },
      { ChannelOrderNo: 'CO1', BillDate: '2026/05/04', 批次号: '' },
      { ChannelOrderNo: 'CO1', BillDate: '20260504', 批次号: '' }
    ];
    assignBatchNo(rows);
    assert.equal(rows[0]['批次号'], '2026-05-04-CO1');
    assert.equal(rows[1]['批次号'], '2026-05-04-CO1');
    assert.equal(rows[2]['批次号'], '2026-05-04-CO1');
  });

  test('Excel 序列号 BillDate 可解析，不分裂', () => {
    // 46155 = 2026-05-13（XLSX 序列号），同组共用
    const rows = [
      { ChannelOrderNo: 'CO1', BillDate: 46155, 批次号: '' },
      { ChannelOrderNo: 'CO1', BillDate: '2026-05-13', 批次号: '' }
    ];
    assignBatchNo(rows);
    assert.equal(rows[0]['批次号'], '2026-05-13-CO1');
    assert.equal(rows[1]['批次号'], '2026-05-13-CO1');
  });

  test('组内取首个可解析 BillDate：首行不可解析则用首个可解析者', () => {
    const rows = [
      { ChannelOrderNo: 'CO1', BillDate: 'garbage', 批次号: '' },
      { ChannelOrderNo: 'CO1', BillDate: '2026-05-04', 批次号: '' }
    ];
    assignBatchNo(rows);
    // F3a 修复（self-review）：首行 garbage 解析失败被跳过，取首个可解析的 2026-05-04 作批次日期段（与用例名一致）。
    assert.equal(rows[0]['批次号'], '2026-05-04-CO1');
    assert.equal(rows[1]['批次号'], '2026-05-04-CO1');
  });

  test('ChannelOrderNo 空 → 批次号空（不阻断）', () => {
    const rows = [{ ChannelOrderNo: '', BillDate: '2026-05-04', 批次号: '' }];
    assignBatchNo(rows);
    assert.equal(rows[0]['批次号'], '');
  });

  test('ChannelOrderNo 为 number → String 化归批', () => {
    const rows = [
      { ChannelOrderNo: 123, BillDate: '2026-05-04', 批次号: '' },
      { ChannelOrderNo: '123', BillDate: '2026-05-04', 批次号: '' }
    ];
    assignBatchNo(rows);
    assert.equal(rows[0]['批次号'], '2026-05-04-123');
    assert.equal(rows[1]['批次号'], '2026-05-04-123');
  });
});

test.describe('matchAdmToMidAllocation - 唯一匹配（两侧任一重复=冲突）', () => {
  test('clean（两侧都唯一）→ 回填调拨号 / Fundtransfer-in金额（原值）', () => {
    const adm = [{ CustomerRef: 'CR1', 调拨号: '', 'Fundtransfer-in金额': '' }];
    const mid = [midRow('CR1', 'ALLOC1', '100.00')];
    const { unmatched } = matchAdmToMidAllocation(adm, mid);
    assert.equal(unmatched.length, 0);
    assert.equal(adm[0]['调拨号'], 'ALLOC1');
    assert.equal(adm[0]['Fundtransfer-in金额'], '100.00');
  });

  test('mid-duplicate：同渠道流水号对多条中台行 → 冲突、不赋值', () => {
    const adm = [{ CustomerRef: 'CR1', 调拨号: '', 'Fundtransfer-in金额': '' }];
    const mid = [midRow('CR1', 'A1', '1'), midRow('CR1', 'A2', '2')];
    const { unmatched } = matchAdmToMidAllocation(adm, mid);
    assert.equal(unmatched.length, 1);
    assert.equal(unmatched[0].code, 'mid-duplicate');
    assert.deepEqual(unmatched[0].conflict, ['A1', 'A2']);
    assert.equal(adm[0]['调拨号'], '');
    assert.equal(adm[0]['Fundtransfer-in金额'], '');
  });

  test('adm-duplicate：ADM 侧同 CustomerRef 多行 → 两行都冲突、不赋值', () => {
    const adm = [
      { CustomerRef: 'DUP', 调拨号: '', 'Fundtransfer-in金额': '' },
      { CustomerRef: 'DUP', 调拨号: '', 'Fundtransfer-in金额': '' }
    ];
    const mid = [midRow('DUP', 'A1', '1')];
    const { unmatched } = matchAdmToMidAllocation(adm, mid);
    assert.equal(unmatched.length, 2);
    assert.ok(unmatched.every((u) => u.code === 'adm-duplicate'));
    assert.equal(adm[0]['调拨号'], '');
    assert.equal(adm[1]['调拨号'], '');
  });

  test('no-mid-match：中台无对应渠道流水号 → 冲突、不赋值', () => {
    const adm = [{ CustomerRef: 'NONE', 调拨号: '', 'Fundtransfer-in金额': '' }];
    const mid = [midRow('OTHER', 'A1', '1')];
    const { unmatched } = matchAdmToMidAllocation(adm, mid);
    assert.equal(unmatched.length, 1);
    assert.equal(unmatched[0].code, 'no-mid-match');
  });

  test('empty-customerref：ADM 行 CustomerRef 空 → 冲突、不赋值', () => {
    const adm = [{ CustomerRef: '', 调拨号: '', 'Fundtransfer-in金额': '' }];
    const mid = [midRow('CR1', 'A1', '1')];
    const { unmatched } = matchAdmToMidAllocation(adm, mid);
    assert.equal(unmatched.length, 1);
    assert.equal(unmatched[0].code, 'empty-customerref');
  });

  test('normKey 大小写敏感：CustomerRef=cr1 ≠ 渠道流水号=CR1 → no-mid-match', () => {
    const adm = [{ CustomerRef: 'cr1', 调拨号: '', 'Fundtransfer-in金额': '' }];
    const mid = [midRow('CR1', 'A1', '1')];
    const { unmatched } = matchAdmToMidAllocation(adm, mid);
    assert.equal(unmatched.length, 1);
    assert.equal(unmatched[0].code, 'no-mid-match');
  });

  test('中台侧渠道流水号空键不入索引（不误判 ADM 空 ref 命中）', () => {
    const adm = [{ CustomerRef: 'CR1', 调拨号: '', 'Fundtransfer-in金额': '' }];
    const mid = [midRow('', 'A0', '0'), midRow('CR1', 'A1', '1')];
    const { unmatched } = matchAdmToMidAllocation(adm, mid);
    assert.equal(unmatched.length, 0);
    assert.equal(adm[0]['调拨号'], 'A1');
  });

  test('Fundtransfer-in金额 取中台收款金额原值（不数值化）', () => {
    const adm = [{ CustomerRef: 'CR1', 调拨号: '', 'Fundtransfer-in金额': '' }];
    const mid = [midRow('CR1', 'A1', '1,234.50')]; // 含千分位，原值落库（金额比较在 PR-3）
    matchAdmToMidAllocation(adm, mid);
    assert.equal(adm[0]['Fundtransfer-in金额'], '1,234.50');
  });
});

test.describe('buildAdmRows - 部分成功 + midEmpty 端到端', () => {
  test('部分成功：admRows 全部落库（含未匹配行留空），unmatched 正确', () => {
    const bank = [
      bankRow({ ChannelOrderNo: 'CO1', CustomerRef: 'CR1', ReconciliationId: 'R1' }), // clean
      bankRow({ ChannelOrderNo: 'CO2', CustomerRef: 'NONE', ReconciliationId: 'R2' }), // no-mid-match
      bankRow({ ChannelOrderNo: 'CO3', CustomerRef: 'MID2', ReconciliationId: 'R3' }) // mid-duplicate
    ];
    const mid = [
      midRow('CR1', 'ALLOC1', '100'),
      midRow('MID2', 'A1', '1'),
      midRow('MID2', 'A2', '2')
    ];
    const out = buildAdmRows(bank, mid);
    // 全部 3 行落库
    assert.equal(out.admRows.length, 3);
    // 未匹配 2 行
    assert.equal(out.unmatched.length, 2);
    const codes = out.unmatched.map((u) => u.code).sort();
    assert.deepEqual(codes, ['mid-duplicate', 'no-mid-match']);
    // clean 行赋值
    const clean = out.admRows.find((r) => r.CustomerRef === 'CR1');
    assert.equal(clean['调拨号'], 'ALLOC1');
    assert.equal(clean['Fundtransfer-in金额'], '100');
    // 未匹配行留空
    const none = out.admRows.find((r) => r.CustomerRef === 'NONE');
    assert.equal(none['调拨号'], '');
    assert.equal(none['Fundtransfer-in金额'], '');
    // unmatched 项带 row 引用（main.js 据此取 批次号/CustomerRef/BillDate/ChannelOrderNo）
    const midDup = out.unmatched.find((u) => u.code === 'mid-duplicate');
    assert.ok(midDup.row);
    assert.equal(midDup.row.CustomerRef, 'MID2');
    assert.deepEqual(midDup.conflict, ['A1', 'A2']);
  });

  test('midEmpty=true：中台表为空 → 全部 no-mid-match，midEmpty 置位', () => {
    const bank = [
      bankRow({ ChannelOrderNo: 'CO1', CustomerRef: 'CR1' }),
      bankRow({ ChannelOrderNo: 'CO2', CustomerRef: 'CR2' })
    ];
    const out = buildAdmRows(bank, []);
    assert.equal(out.midEmpty, true);
    assert.equal(out.admRows.length, 2);
    assert.equal(out.unmatched.length, 2);
    assert.ok(out.unmatched.every((u) => u.code === 'no-mid-match'));
  });

  test('midEmpty=false：中台表非空时不置位', () => {
    const out = buildAdmRows([bankRow({ ChannelOrderNo: 'CO1', CustomerRef: 'CR1' })], [midRow('CR1', 'A1', '1')]);
    assert.equal(out.midEmpty, false);
    assert.equal(out.unmatched.length, 0);
  });

  test('全匹配成功：unmatched 空', () => {
    const bank = [
      bankRow({ ChannelOrderNo: 'CO1', CustomerRef: 'CR1' }),
      bankRow({ ChannelOrderNo: 'CO1', CustomerRef: 'CR2' })
    ];
    const mid = [midRow('CR1', 'A1', '100'), midRow('CR2', 'A2', '200')];
    const out = buildAdmRows(bank, mid);
    assert.equal(out.unmatched.length, 0);
    // 同 ChannelOrderNo 两行批次号一致
    assert.equal(out.admRows[0]['批次号'], out.admRows[1]['批次号']);
  });

  test('空入参（无银行行）→ 空结果不报错', () => {
    const out = buildAdmRows([], []);
    assert.equal(out.admRows.length, 0);
    assert.equal(out.unmatched.length, 0);
    assert.equal(out.midEmpty, true);
  });

  test('入参非数组 → 防御为空', () => {
    const out = buildAdmRows(null, undefined);
    assert.equal(out.admRows.length, 0);
    assert.equal(out.midEmpty, true);
  });
});
