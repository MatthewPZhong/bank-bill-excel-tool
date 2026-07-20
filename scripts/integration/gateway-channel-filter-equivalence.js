// v3.0.7 需求6（🔴🔴 资金红线 · 终极安全网）：网关账单表「按 Channel 过滤读」等价集成测试。
//
// 目的：证明 bank-statement:run 把网关数据源从「全表读 readLinkedTableRows('gateway-bill')」改为
//   「按本批银行单 Channel 集合过滤读 readGatewayBillRowsByChannels」后，喂同一 runReconciliation
//   的两路产物（modifiedRows / unmatchedRows / modifications / stats / platformCleanupRows /
//   refundBackfillRows / refundUnmatchedRows / rounds）**逐字节相等**（deepStrictEqual，含 Set/Map）。
//
// 业务不变量（已确认）：对账永远同 Channel —— Channel=X 银行行只匹配 Channel=X 网关行。
//   故全表读里「Channel∉本批银行单」的网关行是纯噪声：它们与任一银行行的匹配键（reconid 等）不相交，
//   不参与任何一轮命中。过滤读把这些噪声排除 → 两路输出必须完全一致。
//
// 覆盖代表性数据（一次 run 同时驱动多轮）：
//   - R1   reconid 1v1 命中（BOSH 行）
//   - R2   offset-bill-mark 命中（BOSH 行 B-BOSH-1：BillTag 含 OFFSET → Transaction Description='已对账'）
//          ⚠️ 原 C3 gateway-recon-join 退役（需求2）且其 fixture schema 过时 → R2 dead round；改用
//             不会退役、确定 fire 的 offset-bill-mark builtin，并加 rounds.r2 命中守卫防复发。
//   - R3.5 DBS-Charge 资金校验命中（DBS 行：调拨对账单赋 ReconciliationId/FundType + 网关 amount 判 outbound）
//   - R4   fund-nature-check 命中（HX-out：matchedGwRows TradeType=HX_OUTBOUND）
//   - R5s2 FundTransfer 网关回填命中（reconSourceMid:false 走网关引擎）
//   - R5s3 Inbound-VA 剔除命中
//   - 多 Channel：BOSH / JPM / DBS / 空 Channel 银行行并存
//   - 空 Channel 网关行（验空值集分支）+ 噪声网关行（Channel=ICBC/ABC，过滤读应排除、全表读应被忽略）
//
// 用法：node scripts/integration/gateway-channel-filter-equivalence.js

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { AppDatabase } = require('../../src/backend/database');
const linkedRepo = require('../../src/backend/database/linked-table-repository');
const { runReconciliation } = require('../../src/main-process/reconciliation-orchestrator');

let passed = 0;
let failed = 0;
const failures = [];

function assertTrue(cond, label) {
  if (cond) { passed += 1; return; }
  failed += 1; failures.push({ label });
}

// deepStrictEqual 包装（捕获差异定位），处理 Set/Map/类型，等价于「逐字节相等」。
function assertDeepStrict(actual, expected, label) {
  try {
    require('node:assert/strict').deepStrictEqual(actual, expected);
    passed += 1;
  } catch (e) {
    failed += 1;
    failures.push({ label, detail: e.message });
  }
}

// ---- 合成数据工厂 -----------------------------------------------------------

let rowSeq = 0;
function makeBankRow(o = {}) {
  rowSeq += 1;
  return {
    _rowId: o._rowId != null ? o._rowId : `b${rowSeq}`,
    ReconciliationId: o.ReconciliationId ?? '',
    FundType: o.FundType ?? '',
    MerchantId: o.MerchantId ?? 'M001',
    Currency: o.Currency ?? 'USD',
    'Credit Amount': o['Credit Amount'] ?? '',
    'Debit Amount': o['Debit Amount'] ?? '',
    BillDate: o.BillDate ?? '2026-06-01',
    'Transaction Description': o['Transaction Description'] ?? '',
    Channel: o.Channel ?? 'BOSH',
    地区: o['地区'] ?? 'CN',
    BillTag: o.BillTag ?? ''
  };
}

// 网关行（gateway-bill 真实小写表头）；Channel 字段供过滤（生产落库已 normalizeCell trim）。
function gwRaw(o = {}) {
  const obj = {
    reconciliationid: o.reconciliationid ?? '',
    TradeType: o.TradeType ?? '',
    merchantid: o.merchantid ?? 'M001',
    currency: o.currency ?? 'USD',
    amount: o.amount ?? '',
    Billdate: o.Billdate ?? '2026-06-01',
    orderid: o.orderid ?? ''
  };
  // 仅当显式传入 Channel（含空串）时才写该键——省略则模拟「缺 Channel 字段」边界。
  if (Object.prototype.hasOwnProperty.call(o, 'Channel')) obj.Channel = o.Channel;
  return obj;
}

// 调拨对账单派生行（linked_fund_transfer_recon；R3.5 DBS-Charge 用）
function dispRow(o = {}) {
  return {
    付款渠道: o['付款渠道'] ?? 'DBS',
    收款渠道: o['收款渠道'] ?? 'DBS',
    big_account: o.big_account ?? 'M-DBS-001',
    币种: o['币种'] ?? 'USD',
    金额: o['金额'] ?? 100,
    ReconID: o.ReconID ?? 'DISP-RECON-1',
    fund_type: o.fund_type ?? 'FundTransfer-out'
  };
}

// ---- 场景工厂 ---------------------------------------------------------------

// R2 offset-bill-mark（C2 冲销打标，reconFields=0 无条件赋值）—— 覆盖 R2 路径的「确定会触发」场景。
//   原 C3（gateway-recon-join）在本迭代退役（需求2），且其 fixture 此前用了过时 config schema
//   （joinFields/amountField/writeBackField...），c3 引擎只认 config.reconFields/config.assign → reconFields 为空
//   时直接 return（c3-gateway-recon-join.js:103） → C3 那轮是 dead round，R2 路径从未真触发。
//   故改用不会退役、确定 fire 的 offset-bill-mark builtin（构造照搬单测 reconciliation-orchestrator.test.js
//   makeR2OffsetScenario）：命中 BillTag 含 'OFFSET' 的银行行 → 写 Transaction Description='已对账'。
//   它是纯银行行打标、不消费网关行；命中靠承载行的 BillTag（B-BOSH-1，Channel=BOSH 已在过滤集内）。
function makeR2OffsetScenario() {
  return {
    id: 200,
    name: 'R2-冲销打标',
    category: 'offset-bill-mark',
    priority: 5,
    enabled: true,
    displayIndex: 1,
    config: {
      billTypes: [{ seq: 1, conditions: [{ field: 'BillTag', op: '包含', value: 'OFFSET' }] }],
      reconFields: [], // 衍生方案 A：无条件赋值（命中即写，不走笛卡尔配对）
      markValue: { type: 1, field: 'Transaction Description', value: '已对账' }
    }
  };
}

// R4 fund-nature-check（HX-out）：matchedGwRows TradeType=HX_OUTBOUND → 银行 FundType=HX-out
function makeR4HxOutScenario() {
  return {
    id: 402, name: 'R4-HX-out', category: 'builtin-fixed', priority: 3, enabled: true,
    config: { funcCategory: 'fund-nature-check', subCategory: 'hx-out', priority: 3, gwTradeType: 'HX_OUTBOUND', setFundType: 'HX-out' }
  };
}

// R5s2 FundTransfer 网关回填（reconSourceMid:false 走网关引擎，parity 路径）
function makeR5BackfillScenario() {
  return {
    id: 501, name: 'R5-调拨订单对账ID回填', category: 'builtin-fixed', priority: 0, enabled: true,
    config: {
      funcCategory: 'platform-order', subCategory: 'fund-transfer-backfill', reconSourceMid: false,
      directions: [
        { gwTradeType: 'FundTransfer-out', bankFundType: 'FundTransfer-out' },
        { gwTradeType: 'FundTransfer-in', bankFundType: 'FundTransfer-in' }
      ],
      dateToleranceDays: 1
    }
  };
}

// R5s3 Inbound-VA 剔除
function makeR5CleanupScenario() {
  return {
    id: 502, name: 'R5-加款单脏数据处理', category: 'builtin-fixed', priority: 0, enabled: true,
    config: { funcCategory: 'platform-order', subCategory: 'platform-inbound-cleanup', gwTradeType: 'Inbound-VA', excludeFundType: 'Inbound' }
  };
}

// R3.5 DBS-Charge 资金校验
function makeDbsChargeScenario() {
  return {
    id: 350, name: 'R3.5-DBS-Charge资金校验', category: 'builtin-fixed', priority: 0, enabled: true,
    config: {
      funcCategory: 'dbs-charge-fund-check',
      channel: 'DBS', requireBankFundType: 'Charge', setFundType: 'outbound',
      gwOutboundTradeType: 'HX_OUTBOUND'
    }
  };
}

// ---- 数据集（银行行 + 网关行 + 调拨行 + 场景） ------------------------------

function buildBankRows() {
  return [
    // BOSH：R1 reconid 1v1 + R2 offset-bill-mark 打标（BillTag 含 OFFSET → Transaction Description='已对账'）
    //   Channel=BOSH 已在银行单 Channel 集合内 → R2 命中行天然被过滤读纳入（满足「命中行带 Channel」要求）。
    makeBankRow({ _rowId: 'B-BOSH-1', Channel: 'BOSH', MerchantId: 'M-BOSH', 'Credit Amount': '100', ReconciliationId: 'RID-BOSH-1', BillTag: 'OFFSET-1' }),
    // BOSH：R5s2 FundTransfer-out 回填（reconid 空，等网关回填）
    makeBankRow({ _rowId: 'B-BOSH-2', Channel: 'BOSH', MerchantId: 'M-BOSH', FundType: 'FundTransfer-out', 'Debit Amount': '50', BillDate: '2026-06-01' }),
    // JPM：R4 HX-out（reconid 命中网关 HX_OUTBOUND → FundType=HX-out）
    makeBankRow({ _rowId: 'B-JPM-1', Channel: 'JPM', MerchantId: 'M-JPM', ReconciliationId: 'RID-JPM-1', FundType: 'X' }),
    // DBS：R3.5 Charge → outbound
    makeBankRow({ _rowId: 'B-DBS-1', Channel: 'DBS', MerchantId: 'M-DBS-001', Currency: 'USD', 'Debit Amount': '100', FundType: 'Charge' }),
    // 空 Channel 银行行：验空值进 Channel 集合（其合法网关对手 Channel 也空）；
    //   FundType 不含 'Inbound' 子串 → R5s3 命中后产剔除行（单候选直选，方向消歧自然通过）
    makeBankRow({ _rowId: 'B-BLANK-1', Channel: '', MerchantId: 'M-BLANK', ReconciliationId: 'RID-BLANK-1', FundType: 'Other' }),
    // 完全不命中行（无对应网关）：恒进 unmatched，验行数守恒
    makeBankRow({ _rowId: 'B-NONE-1', Channel: 'BOSH', MerchantId: 'M-NONE', ReconciliationId: 'RID-NONE' })
  ];
}

// 全量网关行 = 命中行（同 Channel）+ 噪声行（Channel∉银行单 → 过滤读排除、不命中任何银行行）
function buildAllGwRows() {
  return [
    // —— BOSH 命中 —— R1 reconid 1v1（对手 B-BOSH-1）；B-BOSH-1 的 R2 打标是纯银行行侧、不消费本网关行
    gwRaw({ reconciliationid: 'RID-BOSH-1', merchantid: 'M-BOSH', amount: '100', Channel: 'BOSH' }),
    // —— BOSH 命中 —— R5s2 FundTransfer-out（网关 TradeType + merchantid + 日期容差）
    gwRaw({ reconciliationid: 'RID-FT-BOSH', TradeType: 'FundTransfer-out', merchantid: 'M-BOSH', amount: '50', Billdate: '2026-06-01', Channel: 'BOSH' }),
    // —— JPM 命中 —— R4 HX_OUTBOUND（reconid 1v1 → matchedGwRows）
    gwRaw({ reconciliationid: 'RID-JPM-1', TradeType: 'HX_OUTBOUND', merchantid: 'M-JPM', Channel: 'JPM' }),
    // —— DBS 命中 —— R3.5 步骤2 amount/currency 判 outbound
    gwRaw({ reconciliationid: 'DISP-RECON-1', TradeType: 'PUBLIC_PAY', merchantid: 'M-DBS-001', currency: 'USD', amount: '100', Channel: 'DBS' }),
    // —— 空 Channel 命中 —— R5s3 Inbound-VA 剔除（reconid 关联 B-BLANK-1）
    gwRaw({ reconciliationid: 'RID-BLANK-1', TradeType: 'Inbound-VA', merchantid: 'M-BLANK', Channel: '' }),
    // —— 缺 Channel 字段 的命中网关行（边界：空值集应回它）—— 关联同一空 Channel 银行行的另一面（无害 reconid）
    gwRaw({ reconciliationid: 'RID-BLANK-NOFIELD', TradeType: 'Misc', merchantid: 'M-BLANK' }), // 不写 Channel 键

    // —— 噪声：Channel=ICBC（不在银行单）——键与任一银行行不相交（过滤读排除、全表读忽略）
    gwRaw({ reconciliationid: 'RID-ICBC-NOISE', TradeType: 'HX_OUTBOUND', merchantid: 'M-ICBC', amount: '999', Channel: 'ICBC' }),
    // —— 噪声：Channel=ABC（不在银行单）——即便 TradeType=FundTransfer-out 也不应命中（merchantid 不相交）
    gwRaw({ reconciliationid: 'RID-ABC-NOISE', TradeType: 'FundTransfer-out', merchantid: 'M-ABC', amount: '50', Billdate: '2026-06-01', Channel: 'ABC' }),
    // —— 噪声：Channel=ICBC、Inbound-VA —— 验剔除轮不误吃跨渠道网关行
    gwRaw({ reconciliationid: 'RID-ICBC-VA', TradeType: 'Inbound-VA', merchantid: 'M-ICBC2', Channel: 'ICBC' })
  ];
}

function buildScenarios() {
  return [
    makeR2OffsetScenario(),
    makeDbsChargeScenario(),
    makeR4HxOutScenario(),
    makeR5BackfillScenario(),
    makeR5CleanupScenario()
  ];
}

// 取两路输出做逐字节比较的子集（runReconciliation 全部确定性产物）。
//   覆盖 orchestrator return 的全部对外字段（reconciliation-orchestrator.js:487-540），含
//   refundHitDepositBizIds（退款回填命中 BizId 去重数组，:521-522）与
//   paymentOfflineMatchedPairs（Payment线下调拨匹配对，:523-524）——补齐使「逐字节相等」名副其实。
function projectResult(r) {
  return {
    modifiedRows: r.modifiedRows,
    unmatchedRows: r.unmatchedRows,
    modifications: r.modifications,
    errorReport: r.errorReport,
    stats: r.stats,
    platformCleanupRows: r.platformCleanupRows,
    refundBackfillRows: r.refundBackfillRows,
    refundUnmatchedRows: r.refundUnmatchedRows,
    refundHitDepositBizIds: r.refundHitDepositBizIds,
    paymentOfflineMatchedPairs: r.paymentOfflineMatchedPairs,
    rounds: r.rounds
  };
}

// v3.0.8 需求3：runReconciliation 改 async（轮次边界让出）→ runOnce 同步改 async + await。
async function runOnce(gwRows) {
  const bankRows = structuredClone(buildBankRows()); // 引擎原地改 → 每路独立深拷
  const scenarios = buildScenarios();
  const dispRows = [
    dispRow({ ReconID: 'DISP-RECON-1', 付款渠道: 'DBS', 收款渠道: 'DBS', big_account: 'M-DBS-001', 币种: 'USD', 金额: 100, fund_type: 'FundTransfer-out' })
  ];
  return runReconciliation({
    bankRows,
    gwRows,
    scenarios,
    // deps 不传 → R2 走单维 first-match-wins（纯内存，不查 DB；两路同样不传 → 同口径）
    refundContext: { refundOrderRows: [], depositRows: [] },
    midAllocationContext: { midAllocationRows: [] },
    fundTransferReconContext: { reconRows: [] },
    dispatchReconContext: { dispatchReconRows: dispRows }
  });
}

async function run() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-channel-equiv-'));
  let appDb;
  try {
    appDb = new AppDatabase(path.join(tmpDir, 'test.sqlite'));
    appDb.init();
    const db = appDb.db;

    // 灌全量网关行（含噪声 + 空/缺 Channel 边界）入 linked_gateway_bill（verbatim raw_json，与生产一致）
    const allGw = buildAllGwRows();
    for (const obj of allGw) {
      db.prepare(
        `INSERT INTO linked_gateway_bill (reconciliation_id, bill_date, raw_json, imported_at) VALUES (?, ?, ?, ?)`
      ).run(obj.reconciliationid || '', obj.Billdate || '', JSON.stringify(obj), '2026-06-16T00:00:00.000Z');
    }

    // —— 路 A：全表读（旧路径 readLinkedTableRows('gateway-bill')）——
    const fullGw = linkedRepo.readLinkedTableRows(db, 'gateway-bill');
    assertTrue(fullGw.length === allGw.length, `全表读回行数=灌入数（${fullGw.length}/${allGw.length}）`);

    // —— 路 B：按银行单 Channel 集合过滤读（新路径）——
    const bankRows = buildBankRows();
    const bankChannels = bankRows.map((r) => (r && r.Channel != null ? String(r.Channel).trim() : ''));
    const filteredGw = linkedRepo.readGatewayBillRowsByChannels(db, bankChannels);

    // 过滤读必须严格少于全表读（噪声行被排除）且不含任何 Channel∉银行单 的行
    const bankChannelSet = new Set(bankChannels);
    const filteredChannels = filteredGw.map((g) => (Object.prototype.hasOwnProperty.call(g, 'Channel') && g.Channel != null ? String(g.Channel).trim() : ''));
    assertTrue(filteredGw.length < fullGw.length, `过滤读严格少于全表读（噪声被排除：${filteredGw.length}<${fullGw.length}）`);
    assertTrue(filteredChannels.every((c) => bankChannelSet.has(c)), '过滤读结果 Channel 全部 ∈ 银行单 Channel 集合（无越界行）');
    assertTrue(filteredGw.some((g) => !Object.prototype.hasOwnProperty.call(g, 'Channel')), '过滤读含「缺 Channel 字段」边界行（空值集分支生效）');
    assertTrue(filteredGw.some((g) => g.reconciliationid === 'RID-BLANK-1'), '过滤读含 Channel=空串 命中行');
    assertTrue(!filteredGw.some((g) => String(g.reconciliationid || '').includes('NOISE')), '过滤读不含 ICBC/ABC 噪声行');

    // —— 两路喂同一 runReconciliation —— 逐字节相等（🔴 终极安全网）——
    const resFull = projectResult(await runOnce(fullGw));
    const resFiltered = projectResult(await runOnce(filteredGw));
    assertDeepStrict(resFiltered, resFull, '🔴 过滤读 vs 全表读 runReconciliation 产物逐字节相等');

    // 命中覆盖自检：确保数据真的驱动了多轮（否则等价是空对空，没有意义）
    const st = resFull.stats;
    assertTrue(st.hitRowCount > 0, `命中行数 > 0（实际 ${st.hitRowCount}）`);
    assertTrue(st.r1Matched > 0, `R1 命中 > 0（实际 ${st.r1Matched}）`);
    // 🔴 R2 命中守卫（防 dead round 复发）：R2 轮必须真有命中（offset-bill-mark 打标 B-BOSH-1）。
    //   此前 C3 用过时 schema → 引擎忽略 → R2 轮零命中、等价对 R2 路径形同空对空。此断言钉死 R2 真触发。
    assertTrue(resFull.rounds.r2.hitRowCount > 0, `R2 命中 > 0（实际 ${resFull.rounds.r2.hitRowCount}；防 dead round）`);
    assertTrue(st.dbsChargeChangedCount > 0, `R3.5 DBS-Charge 改写 > 0（实际 ${st.dbsChargeChangedCount}）`);
    assertTrue(st.r4ChangedCount > 0, `R4 改写 > 0（实际 ${st.r4ChangedCount}）`);
    assertTrue(st.r5s2BackfilledCount > 0, `R5s2 回填 > 0（实际 ${st.r5s2BackfilledCount}）`);
    assertTrue(st.r5s3CleanupCount > 0, `R5s3 剔除 > 0（实际 ${st.r5s3CleanupCount}）`);
    // 行数守恒
    assertTrue(
      resFull.modifiedRows.length + resFull.unmatchedRows.length === buildBankRows().length,
      '行数守恒 modifiedRows + unmatchedRows === bankRows.length'
    );
  } finally {
    if (appDb && appDb.db) { try { appDb.db.close(); } catch (_e) { /* ignore */ } }
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_e) { /* ignore */ }
  }

  const total = passed + failed;
  console.log(`\n==== ${passed}/${total} PASS ====`);
  if (failed > 0) {
    failures.forEach((f) => console.error(`  - ${f.label}${f.detail ? `\n      ${f.detail.split('\n').slice(0, 12).join('\n      ')}` : ''}`));
    process.exit(1);
  }
}

run().catch((e) => { console.error('FATAL', e); process.exit(1); });
