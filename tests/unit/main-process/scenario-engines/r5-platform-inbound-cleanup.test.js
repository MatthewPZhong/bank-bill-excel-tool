// v2.1.16-beta.2 R5 场景3「中台加款单脏数据处理」引擎单测（🔴 资金红线）
// PRD §四 需求 3（R3.1~R3.4） / TECH_DESIGN §5.4
//
// 覆盖：
//   ① 命中（TradeType=Inbound-VA、reconid 相同、bank.FundType≠Inbound）→ 产 1 条剔除行
//      断言 加款单号=gw.orderid、附言=`<FundType>，中台加款单已关闭。`、C~O 13 列=对应银行行
//   ② bank.FundType==='Inbound' → 不产剔除行
//   ③ 严格 1v1（两条 gw 抢一条 bank → 第二条不再命中）
//   ④ 空 reconid 跳过
//   ⑤ TradeType 非 Inbound-VA 不参与
//   ⑥ 漂移守卫：CLEANUP_COPY_HEADERS ⊆ BANK_STATEMENT_FIELDS
//   ⑦ 多候选按 Credit Amount 方向消歧（PR-6 / spec §三）：唯一 Credit 行取它 /
//      ≥2 行 Credit→multi-credit-match 警告 / 0 行 Credit→no-credit-match 警告 /
//      单候选维持现状 / O-1 边界（0、''、'0.00'、'1,234.5'）—— 异常仅警告不阻断导出

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildCleanupRow,
  runRound5PlatformInboundCleanup
} = require('../../../../src/main-process/scenario-engines/r5-platform-inbound-cleanup');
const {
  CLEANUP_TEMPLATE_HEADERS,
  CLEANUP_COPY_HEADERS
} = require('../../../../src/constants/platform-cleanup-template-fields');
const { BANK_STATEMENT_FIELDS } = require('../../../../src/constants/bank-statement-fields');

// ---- 测试夹具 ----------------------------------------------------------

// 网关行（小写真实表头）：TradeType / reconciliationid / orderid
function gwRow({ tradeType = 'Inbound-VA', reconId = 'R1', orderId = 'ORD-1' } = {}) {
  return { TradeType: tradeType, reconciliationid: reconId, orderid: orderId };
}

// 银行行（驼峰）：带 _rowId / ReconciliationId / FundType + C~O 全部 13 列样例值
//   C~O = FundType / BillDate / ValueDate / Channel / 地区 / MerchantId / Currency /
//         Credit Amount / Debit Amount / ReconciliationId / Transaction Description /
//         Extra Information / Payment Detail
function bankRow({
  rowId = 'b1',
  reconId = 'R1',
  fundType = 'Charge',
  creditAmount = 100,
  debitAmount = 0
} = {}) {
  return {
    _rowId: rowId,
    ReconciliationId: reconId,
    FundType: fundType,
    BillDate: '2026-06-07',
    ValueDate: '2026-06-08',
    Channel: 'CH-A',
    '地区': 'HK',
    MerchantId: 'M001',
    Currency: 'USD',
    'Credit Amount': creditAmount,
    'Debit Amount': debitAmount,
    'Transaction Description': '测试交易',
    'Extra Information': 'extra-info',
    'Payment Detail': 'pay-detail'
  };
}

// ---- ⑥ 漂移守卫 --------------------------------------------------------

test.describe('R5场景3 — 漂移守卫：剔除模板字段是银行字段子集', () => {
  test('CLEANUP_TEMPLATE_HEADERS 共 15 列、CLEANUP_COPY_HEADERS（C~O）共 13 列', () => {
    assert.equal(CLEANUP_TEMPLATE_HEADERS.length, 15);
    assert.equal(CLEANUP_COPY_HEADERS.length, 13);
    // C~O = 模板第 3 列起
    assert.deepEqual(CLEANUP_COPY_HEADERS, CLEANUP_TEMPLATE_HEADERS.slice(2));
    // A/B 两列为剔除模板专属
    assert.equal(CLEANUP_TEMPLATE_HEADERS[0], '加款单号');
    assert.equal(CLEANUP_TEMPLATE_HEADERS[1], '附言');
  });

  test('CLEANUP_COPY_HEADERS 每一项都存在于 BANK_STATEMENT_FIELDS（C~O ⊆ 银行字段，防漂移）', () => {
    const bankSet = new Set(BANK_STATEMENT_FIELDS);
    const missing = CLEANUP_COPY_HEADERS.filter((h) => !bankSet.has(h));
    assert.deepEqual(
      missing,
      [],
      `剔除模板 C~O 出现银行字段表中不存在的列（模板/银行字段漂移）：${JSON.stringify(missing)}`
    );
  });
});

// ---- buildCleanupRow 单元 ---------------------------------------------

test.describe('R5场景3 — buildCleanupRow 构造剔除行', () => {
  test('加款单号=gw.orderid；附言=`<FundType>，中台加款单已关闭。`（中文标点）；C~O 拷贝银行行', () => {
    const gw = gwRow({ orderId: 'ORD-888' });
    const bank = bankRow({ fundType: 'outbound' });
    const row = buildCleanupRow(gw, bank);

    assert.equal(row['加款单号'], 'ORD-888');
    assert.equal(row['附言'], 'outbound，中台加款单已关闭。');
    // 逐列确认 C~O 13 列值 = 对应银行行字段
    for (const header of CLEANUP_COPY_HEADERS) {
      assert.equal(row[header], bank[header], `C~O 列「${header}」拷贝错位`);
    }
    // 剔除行只含 15 列键（A/B + C~O），不混入 _rowId 等银行内部字段
    assert.deepEqual(Object.keys(row).sort(), CLEANUP_TEMPLATE_HEADERS.slice().sort());
  });

  test('附言里的标点是中文逗号「，」与中文句号「。」（精确字符断言）', () => {
    const row = buildCleanupRow(gwRow(), bankRow({ fundType: 'Charge' }));
    assert.equal(row['附言'], 'Charge，中台加款单已关闭。');
    // 逐字符确认：U+FF0C 全角逗号、U+3002 句号；不得是 ASCII ',' / '.'
    assert.ok(row['附言'].includes('，'), '附言应含中文逗号 U+FF0C');
    assert.ok(row['附言'].endsWith('。'), '附言应以中文句号 U+3002 结尾');
    assert.ok(!row['附言'].includes(','), '附言不得含 ASCII 半角逗号');
    assert.ok(!row['附言'].includes('.'), '附言不得含 ASCII 半角句号');
  });
});

// ---- ① 命中 ------------------------------------------------------------

test.describe('R5场景3 — ① 命中产剔除行', () => {
  test('TradeType=Inbound-VA + reconid 相同 + bank.FundType≠Inbound → 产 1 条剔除行', () => {
    const gws = [gwRow({ reconId: 'R1', orderId: 'ORD-1' })];
    const banks = [bankRow({ rowId: 'b1', reconId: 'R1', fundType: 'Charge' })];

    const { cleanupRows, modifications, warnings } = runRound5PlatformInboundCleanup(gws, banks);

    assert.equal(cleanupRows.length, 1, '应产 1 条剔除行');
    const row = cleanupRows[0];
    assert.equal(row['加款单号'], 'ORD-1');
    assert.equal(row['附言'], 'Charge，中台加款单已关闭。');
    for (const header of CLEANUP_COPY_HEADERS) {
      assert.equal(row[header], banks[0][header], `C~O 列「${header}」值应等于对应银行行`);
    }
    // 本场景一般不改银行行
    assert.deepEqual(modifications, []);
    assert.deepEqual(warnings, []);
  });

  test('附言用当前（R4 后）银行 FundType —— 模拟 R4 已把 FundType 从 Charge 改成 outbound', () => {
    const gws = [gwRow({ reconId: 'R9', orderId: 'ORD-9' })];
    // 模拟 R4 改写后的当前值
    const banks = [bankRow({ rowId: 'b9', reconId: 'R9', fundType: 'outbound' })];

    const { cleanupRows } = runRound5PlatformInboundCleanup(gws, banks);
    assert.equal(cleanupRows.length, 1);
    assert.equal(cleanupRows[0]['附言'], 'outbound，中台加款单已关闭。');
  });
});

// ---- ② FundType=Inbound 不产 -----------------------------------------

test.describe('R5场景3 — ② bank.FundType===Inbound 不产剔除行', () => {
  test('命中但银行 FundType=Inbound → 不生成剔除行', () => {
    const gws = [gwRow({ reconId: 'R1' })];
    const banks = [bankRow({ rowId: 'b1', reconId: 'R1', fundType: 'Inbound' })];

    const { cleanupRows, modifications } = runRound5PlatformInboundCleanup(gws, banks);
    assert.equal(cleanupRows.length, 0, 'FundType=Inbound 不应产剔除行');
    assert.deepEqual(modifications, []);
  });

  test('excludeFundType 可 config 化：自定义 excludeFundType=outbound 时 outbound 不产、Inbound 反而产', () => {
    const gws = [gwRow({ reconId: 'RA', orderId: 'OA' }), gwRow({ reconId: 'RB', orderId: 'OB' })];
    const banks = [
      bankRow({ rowId: 'ba', reconId: 'RA', fundType: 'outbound' }),
      bankRow({ rowId: 'bb', reconId: 'RB', fundType: 'Inbound' })
    ];
    const { cleanupRows } = runRound5PlatformInboundCleanup(gws, banks, { excludeFundType: 'outbound' });
    assert.equal(cleanupRows.length, 1);
    assert.equal(cleanupRows[0]['加款单号'], 'OB'); // Inbound 这条产出
    assert.equal(cleanupRows[0]['附言'], 'Inbound，中台加款单已关闭。');
  });
});

// ---- ③ 严格 1v1 -------------------------------------------------------

test.describe('R5场景3 — ③ 严格 1v1 单向消费', () => {
  test('两条 gw 抢同一条 bank（同 reconid） → 仅第一条命中，第二条不再命中', () => {
    const gws = [
      gwRow({ reconId: 'R1', orderId: 'ORD-1' }),
      gwRow({ reconId: 'R1', orderId: 'ORD-2' })
    ];
    const banks = [bankRow({ rowId: 'b1', reconId: 'R1', fundType: 'Charge' })];

    const { cleanupRows } = runRound5PlatformInboundCleanup(gws, banks);
    assert.equal(cleanupRows.length, 1, '一条 bank 只能被一条 gw 消费');
    assert.equal(cleanupRows[0]['加款单号'], 'ORD-1', '应是第一条 gw 命中');
  });

  // 注：原「两条 gw + 两条同 reconid 的 bank → 各配一条产 2 条」case（旧 :181-199）已删除。
  // 依据 spec §四 / O-5：业务确认不存在「多 gw + 多 bank」场景，且旧语义（多候选取 cand[0] +
  // multi-bank-match-inbound 警告）已被 PR-6 的 Credit 方向消歧（no-credit-match / multi-credit-match）
  // 取代。多候选语义由下方「⑦ Credit Amount 方向消歧」describe 块覆盖。
});

// ---- ④ 空 reconid 跳过 -------------------------------------------------

test.describe('R5场景3 — ④ 空 reconid 跳过', () => {
  test('gw.reconciliationid 为空 → 跳过，不命中任何银行行', () => {
    const gws = [gwRow({ reconId: '', orderId: 'ORD-EMPTY' })];
    const banks = [bankRow({ rowId: 'b1', reconId: 'R1', fundType: 'Charge' })];

    const { cleanupRows } = runRound5PlatformInboundCleanup(gws, banks);
    assert.equal(cleanupRows.length, 0);
  });

  test('银行行 ReconciliationId 为空 → 不入索引，gw 无候选', () => {
    const gws = [gwRow({ reconId: 'R1', orderId: 'ORD-1' })];
    const banks = [bankRow({ rowId: 'b1', reconId: '', fundType: 'Charge' })];

    const { cleanupRows } = runRound5PlatformInboundCleanup(gws, banks);
    assert.equal(cleanupRows.length, 0);
  });
});

// ---- ⑤ TradeType 非 Inbound-VA 不参与 ---------------------------------

test.describe('R5场景3 — ⑤ TradeType 非 Inbound-VA 不参与', () => {
  test('TradeType=FundTransfer-out → 不进 gwPool，不产剔除行', () => {
    const gws = [gwRow({ tradeType: 'FundTransfer-out', reconId: 'R1', orderId: 'ORD-1' })];
    const banks = [bankRow({ rowId: 'b1', reconId: 'R1', fundType: 'Charge' })];

    const { cleanupRows } = runRound5PlatformInboundCleanup(gws, banks);
    assert.equal(cleanupRows.length, 0);
  });

  test('gwTradeType 可 config 化：自定义 gwTradeType=Inbound-X 时只有该类型参与', () => {
    const gws = [
      gwRow({ tradeType: 'Inbound-VA', reconId: 'RA', orderId: 'OA' }),
      gwRow({ tradeType: 'Inbound-X', reconId: 'RB', orderId: 'OB' })
    ];
    const banks = [
      bankRow({ rowId: 'ba', reconId: 'RA', fundType: 'Charge' }),
      bankRow({ rowId: 'bb', reconId: 'RB', fundType: 'Charge' })
    ];
    const { cleanupRows } = runRound5PlatformInboundCleanup(gws, banks, { gwTradeType: 'Inbound-X' });
    assert.equal(cleanupRows.length, 1);
    assert.equal(cleanupRows[0]['加款单号'], 'OB');
  });
});

// ---- ⑦ Credit Amount 方向消歧（PR-6 / spec §三，🔴 资金红线）----------

test.describe('R5场景3 — ⑦ 多候选按 Credit Amount 方向消歧', () => {
  // ① 同 reconid 一行 Credit 一行 Debit → 取 Credit 行（加款单号/附言/C~O 全来自 Credit 行）
  test('2 行同 reconid（1 Credit 1 Debit）→ 取 Credit 行（断言加款单号沿用 gw、附言/C~O 来自 Credit 行）', () => {
    const gws = [gwRow({ reconId: 'R1', orderId: 'ORD-CR' })];
    const banks = [
      // Debit 行：Credit=0、Debit 有值 → 应被排除
      bankRow({ rowId: 'b-debit', reconId: 'R1', fundType: 'outbound', creditAmount: 0, debitAmount: 500 }),
      // Credit 行：Credit 有值 → 应被选中（FundType=Charge 区别于 Debit 行，便于断言附言来源）
      bankRow({ rowId: 'b-credit', reconId: 'R1', fundType: 'Charge', creditAmount: 500, debitAmount: 0 })
    ];
    const creditBank = banks[1];

    const { cleanupRows, warnings } = runRound5PlatformInboundCleanup(gws, banks);

    assert.equal(cleanupRows.length, 1, '应只产 1 条剔除行（取 Credit 行）');
    const row = cleanupRows[0];
    assert.equal(row['加款单号'], 'ORD-CR', '加款单号来自网关 orderid');
    // 附言用的是 Credit 行的 FundType（Charge），而非 Debit 行（outbound）
    assert.equal(row['附言'], 'Charge，中台加款单已关闭。', '附言 FundType 必须来自 Credit 行');
    // C~O 13 列逐列 = Credit 行（含 Credit Amount=500 / Debit Amount=0）
    for (const header of CLEANUP_COPY_HEADERS) {
      assert.equal(row[header], creditBank[header], `C~O 列「${header}」必须来自 Credit 行`);
    }
    assert.equal(row['Credit Amount'], 500, '剔除行 Credit Amount 应取自 Credit 行');
    assert.equal(row['Debit Amount'], 0, '剔除行 Debit Amount 应取自 Credit 行');
    // 唯一 Credit 行 → 不应有任何方向消歧警告
    assert.equal(warnings.length, 0, '唯一 Credit 行命中不应产警告');
  });

  // ② ≥2 行 Credit 有值 → 跳过 + multi-credit-match 警告（导出未阻断、cleanupRows 不含该 reconid）
  test('≥2 行 Credit 有值 → 跳过该 reconid + multi-credit-match 警告（不阻断导出、cleanupRows 不含该 reconid）', () => {
    const gws = [gwRow({ reconId: 'R1', orderId: 'ORD-MULTI' })];
    const banks = [
      bankRow({ rowId: 'b1', reconId: 'R1', fundType: 'Charge', creditAmount: 100, debitAmount: 0 }),
      bankRow({ rowId: 'b2', reconId: 'R1', fundType: 'outbound', creditAmount: 200, debitAmount: 0 })
    ];

    const result = runRound5PlatformInboundCleanup(gws, banks);
    const { cleanupRows, modifications, warnings } = result;

    // 导出未阻断：函数正常返回结构完整，无 abort/throw
    assert.ok(result && Array.isArray(cleanupRows), '函数应正常返回（导出链路不被阻断）');
    assert.deepEqual(modifications, [], '不改银行行');
    // cleanupRows 不含该 reconid（R1 一条剔除行都不产）
    assert.equal(cleanupRows.length, 0, '多 Credit 候选不产剔除行');
    // 警告：code=multi-credit-match、severity=warning（仅警告不阻断）
    const w = warnings.find((x) => x.code === 'multi-credit-match');
    assert.ok(w, '应发 multi-credit-match 警告');
    assert.equal(w.severity, 'warning', 'severity 必须是 warning（不阻断导出）');
    assert.ok(/R1/.test(w.message), '警告 message 应带冲突 reconid');
  });

  // ③ 0 行 Credit 有值（全 Debit / Credit 全空）→ 跳过 + no-credit-match 警告
  test('0 行 Credit 有值（全 Debit / Credit 全空）→ 跳过该 reconid + no-credit-match 警告（不阻断）', () => {
    const gws = [gwRow({ reconId: 'R1', orderId: 'ORD-NOCR' })];
    const banks = [
      // 全 Debit 行：Credit=0
      bankRow({ rowId: 'b1', reconId: 'R1', fundType: 'Charge', creditAmount: 0, debitAmount: 300 }),
      // Credit 全空：Credit=''（O-1 视为无值）
      bankRow({ rowId: 'b2', reconId: 'R1', fundType: 'outbound', creditAmount: '', debitAmount: 400 })
    ];

    const { cleanupRows, modifications, warnings } = runRound5PlatformInboundCleanup(gws, banks);

    assert.equal(cleanupRows.length, 0, '0 Credit 候选不产剔除行');
    assert.deepEqual(modifications, [], '不改银行行');
    const w = warnings.find((x) => x.code === 'no-credit-match');
    assert.ok(w, '应发 no-credit-match 警告');
    assert.equal(w.severity, 'warning', 'severity 必须是 warning（不阻断导出）');
  });

  // ④ 单候选维持现状：哪怕是 Debit 行（Credit=0）也照常取它，不被方向筛掉
  test('单候选（cand.length===1）维持现状取它 —— Debit 行（Credit=0）也产剔除行（O-4）', () => {
    const gws = [gwRow({ reconId: 'R1', orderId: 'ORD-SINGLE' })];
    // 唯一候选是 Debit 行（Credit=0）：单候选路径不做 Credit 筛选
    const banks = [
      bankRow({ rowId: 'b1', reconId: 'R1', fundType: 'Charge', creditAmount: 0, debitAmount: 700 })
    ];

    const { cleanupRows, warnings } = runRound5PlatformInboundCleanup(gws, banks);

    assert.equal(cleanupRows.length, 1, '单候选即使是 Debit 行也应产剔除行');
    assert.equal(cleanupRows[0]['加款单号'], 'ORD-SINGLE');
    assert.equal(cleanupRows[0]['附言'], 'Charge，中台加款单已关闭。');
    // 单候选路径不触发方向消歧警告
    assert.equal(warnings.length, 0, '单候选不应产方向消歧警告');
  });

  // ⑤ O-1 边界：Credit Amount = 0 / '' / '0.00' / '1,234.5' 验证 parseNumber !== null && !== 0
  test('O-1 边界：0 / "" / "0.00" 视为无值；"1,234.5"（含千分位）视为有值', () => {
    // 无值组：与一个固定 Debit 行（Credit=0）组成多候选 → 两行都无值 → no-credit-match
    for (const noValue of [0, '', '0.00']) {
      const gws = [gwRow({ reconId: 'RN', orderId: 'ORD-N' })];
      const banks = [
        bankRow({ rowId: 'bn-1', reconId: 'RN', fundType: 'Charge', creditAmount: noValue, debitAmount: 100 }),
        bankRow({ rowId: 'bn-2', reconId: 'RN', fundType: 'outbound', creditAmount: 0, debitAmount: 200 })
      ];
      const { cleanupRows, warnings } = runRound5PlatformInboundCleanup(gws, banks);
      assert.equal(cleanupRows.length, 0, `Credit Amount=${JSON.stringify(noValue)} 应判为无值 → 不产剔除行`);
      assert.ok(
        warnings.some((w) => w.code === 'no-credit-match'),
        `Credit Amount=${JSON.stringify(noValue)} 应触发 no-credit-match（判为无值）`
      );
    }

    // 有值：'1,234.5'（parseNumber 去千分位 = 1234.5 ≠ 0）→ 唯一 Credit 行被选中
    const gws = [gwRow({ reconId: 'RY', orderId: 'ORD-Y' })];
    const banks = [
      // 该行 Credit='1,234.5'（有值）；另一行 Credit=0（Debit 行）→ 仅本行入 creditCand
      bankRow({ rowId: 'by-1', reconId: 'RY', fundType: 'Charge', creditAmount: '1,234.5', debitAmount: 0 }),
      bankRow({ rowId: 'by-2', reconId: 'RY', fundType: 'outbound', creditAmount: 0, debitAmount: 50 })
    ];
    const { cleanupRows, warnings } = runRound5PlatformInboundCleanup(gws, banks);
    assert.equal(cleanupRows.length, 1, 'Credit Amount="1,234.5" 应判为有值 → 取该行产剔除行');
    assert.equal(cleanupRows[0]['附言'], 'Charge，中台加款单已关闭。', '应取 Credit="1,234.5" 的那行');
    assert.equal(cleanupRows[0]['Credit Amount'], '1,234.5', 'C~O 拷贝保留原始字符串值');
    assert.equal(warnings.length, 0, '唯一 Credit 行命中不产警告');
  });
});

// ---- 边界兜底 ----------------------------------------------------------

test.describe('R5场景3 — 边界兜底', () => {
  test('空 gwRows / 空 bankRows / 非数组入参 不崩，返回空剔除行', () => {
    assert.deepEqual(runRound5PlatformInboundCleanup([], []).cleanupRows, []);
    assert.deepEqual(runRound5PlatformInboundCleanup(null, null).cleanupRows, []);
    assert.deepEqual(runRound5PlatformInboundCleanup(undefined, undefined).cleanupRows, []);
  });

  test('多条 gw 多 reconid 混合：仅 Inbound-VA + 非 Inbound + reconid 命中 才产', () => {
    const gws = [
      gwRow({ tradeType: 'Inbound-VA', reconId: 'R1', orderId: 'O1' }), // 命中 → 产
      gwRow({ tradeType: 'Inbound-VA', reconId: 'R2', orderId: 'O2' }), // bank FundType=Inbound → 不产
      gwRow({ tradeType: 'Inbound-VA', reconId: '', orderId: 'O3' }),   // 空 reconid → 跳过
      gwRow({ tradeType: 'FundTransfer-out', reconId: 'R4', orderId: 'O4' }), // 非 Inbound-VA → 不参与
      gwRow({ tradeType: 'Inbound-VA', reconId: 'R5', orderId: 'O5' })  // 无对应 bank → 不产
    ];
    const banks = [
      bankRow({ rowId: 'b1', reconId: 'R1', fundType: 'Charge' }),
      bankRow({ rowId: 'b2', reconId: 'R2', fundType: 'Inbound' }),
      bankRow({ rowId: 'b4', reconId: 'R4', fundType: 'Charge' })
    ];
    const { cleanupRows } = runRound5PlatformInboundCleanup(gws, banks);
    assert.equal(cleanupRows.length, 1);
    assert.equal(cleanupRows[0]['加款单号'], 'O1');
  });
});
