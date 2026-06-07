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
function bankRow({ rowId = 'b1', reconId = 'R1', fundType = 'Charge' } = {}) {
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
    'Credit Amount': 100,
    'Debit Amount': 0,
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

  test('两条 gw + 两条同 reconid 的 bank → 各配一条，产 2 条剔除行', () => {
    const gws = [
      gwRow({ reconId: 'R1', orderId: 'ORD-1' }),
      gwRow({ reconId: 'R1', orderId: 'ORD-2' })
    ];
    const banks = [
      bankRow({ rowId: 'b1', reconId: 'R1', fundType: 'Charge' }),
      bankRow({ rowId: 'b2', reconId: 'R1', fundType: 'outbound' })
    ];

    const { cleanupRows, warnings } = runRound5PlatformInboundCleanup(gws, banks);
    assert.equal(cleanupRows.length, 2);
    assert.deepEqual(cleanupRows.map((r) => r['加款单号']), ['ORD-1', 'ORD-2']);
    // 第一条 gw 面对 2 个可用候选 → 发 multi-bank-match-inbound 警告
    assert.ok(
      warnings.some((w) => w.code === 'multi-bank-match-inbound'),
      '多候选应发 multi-bank-match-inbound 警告'
    );
  });
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
