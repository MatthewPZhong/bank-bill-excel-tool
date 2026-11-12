// v3.2.17 银行对账单处理：自带写死场景「从银行对账单的信息里提取调拨订单对账ID」限 FundType e2e 集成验证
//   覆盖：临时 AppDatabase（init 内置场景种子与迁移）→ 取真实落库的自带提取场景与 DBS-Charge 资金校验场景 →
//         按 main.js 运行快照口径组装 → 编排器（双维调度依赖：真实 channels 仓储 + db）跑 R1→R5。
//   🔴 资金红线：
//     - 非 DBS 渠道只有 FundType = FundTransfer-in / FundTransfer-out 的行提取对账ID；其他 FundType（含
//       InternelFundTransfer-*、FundTransfer-in&FX）即使备注带 FT 号也不写 ReconciliationId；
//     - DBS 渠道不受此限：同一调拨的 Charge 兄弟行照常拿到对账ID，R3.5 照常把它归为 Charge；
//     - 行数守恒：modifiedRows + unmatchedRows = bankRows。
//
// 用法：node scripts/integration/bank-statement-builtin-extract-fundtype-gate.js

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { AppDatabase } = require('../../src/backend/database');
const channelsRepository = require('../../src/backend/database/channels-repository');
const { runReconciliation } = require('../../src/main-process/reconciliation-orchestrator');

let passed = 0;
let failed = 0;
const failures = [];

function assertEq(actual, expected, label) {
  const aJson = JSON.stringify(actual);
  const eJson = JSON.stringify(expected);
  if (aJson === eJson) { passed++; return; }
  failed++; failures.push({ label, actual, expected });
}
function assertTrue(cond, label) {
  if (cond) { passed++; return; }
  failed++; failures.push({ label, actual: cond, expected: true });
}

function findScenario(appDb, predicate) {
  return appDb.listScenarios().find((item) => {
    const detail = appDb.getScenario(item.id);
    return detail && predicate(detail);
  }) || null;
}

// 与 main.js bank-statement 运行快照同口径：builtin-fixed 附「适用银行渠道」列表（空 = 全部）。
function runtimeScenario(appDb, meta) {
  const detail = appDb.getScenario(meta.id);
  return {
    ...detail,
    enabled: true,
    displayIndex: meta.displayIndex,
    channelId: meta.channelId,
    _applicableChannelIds: appDb.getScenarioApplicableChannels(meta.id)
  };
}

const FT_A = 'AFT202606010001';
const FT_B = 'BFT202606010002';
const FT_D = 'DFT202606010003';

function bankRow(rowId, channel, overrides) {
  return {
    _rowId: rowId,
    ReconciliationId: '',
    FundType: '',
    MerchantId: 'M001',
    Currency: 'USD',
    'Credit Amount': 0,
    'Debit Amount': 100,
    BillDate: '2026-06-01',
    Channel: channel,
    地区: '',
    ChannelOrderNo: '',
    CustomerRef: '',
    'Extra Information': '',
    'Payment Detail': '',
    ...overrides
  };
}

function buildBankRows() {
  return [
    bankRow('icbc-out', '工商', { FundType: 'FundTransfer-out', 'Payment Detail': `TRF ${FT_A}` }),
    bankRow('icbc-in', '工商', { FundType: ' FundTransfer-in ', 'Credit Amount': 100, 'Debit Amount': 0, CustomerRef: FT_B }),
    bankRow('icbc-inbound', '工商', { FundType: 'Inbound', 'Credit Amount': 100, 'Debit Amount': 0, 'Extra Information': `REF ${FT_A}`, ReconciliationId: 'KEEP-1' }),
    bankRow('icbc-internal', '工商', { FundType: 'InternelFundTransfer-in', 'Credit Amount': 100, 'Debit Amount': 0, CustomerRef: FT_B }),
    bankRow('icbc-fx', '工商', { FundType: 'FundTransfer-in&FX', 'Credit Amount': 100, 'Debit Amount': 0, CustomerRef: FT_B }),
    bankRow('icbc-blank', '工商', { FundType: '', 'Payment Detail': FT_A }),
    // DBS：同一笔调拨的出款行与手续费行，导入时 FundType 都还不是调拨类型
    bankRow('dbs-transfer', 'DBS', { MerchantId: 'M-DBS', FundType: 'outbound', 'Payment Detail': `OUT ${FT_D}` }),
    bankRow('dbs-charge', 'DBS', { MerchantId: 'M-DBS', FundType: 'outbound', 'Debit Amount': 5, 'Payment Detail': `FEE ${FT_D}` })
  ];
}

function dispatchRow() {
  return {
    付款渠道: 'DBS',
    收款渠道: '',
    big_account: 'M-DBS',
    币种: 'USD',
    金额: 100,
    BillDate: '2026-06-01',
    ReconID: FT_D,
    fund_type: 'FundTransfer-out'
  };
}

async function run() {
  console.log('==== 银行对账单处理：自带提取调拨订单对账ID 限 FundType（DBS 除外）e2e 集成验证 ====');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bank-statement-extract-fundtype-gate-'));
  const appDb = new AppDatabase(path.join(tmpDir, 'tool-data.sqlite'));
  appDb.init();

  try {
    const extract = findScenario(appDb, (detail) => detail.category === 'builtin-fixed'
      && detail.config && detail.config.extractByFeature && !detail.config.funcCategory);
    const dbsCharge = findScenario(appDb, (detail) => detail.category === 'builtin-fixed'
      && detail.config && detail.config.funcCategory === 'dbs-charge-fund-check');
    assertTrue(Boolean(extract && dbsCharge), 'Step0.内置提取场景与 DBS-Charge 场景已随 init 写入');
    assertEq(extract && extract.name, '从银行对账单的信息里提取调拨订单对账ID', 'Step0.提取场景名称');

    const bankRows = buildBankRows();
    const result = await runReconciliation({
      bankRows,
      gwRows: [],
      scenarios: [runtimeScenario(appDb, extract), runtimeScenario(appDb, dbsCharge)],
      deps: { channelsRepo: channelsRepository, db: appDb.db },
      dispatchReconContext: { dispatchReconRows: [dispatchRow()] }
    });
    const byId = Object.fromEntries(bankRows.map((row) => [row._rowId, row]));

    // Step 1：非 DBS 渠道只认 FundTransfer-in / FundTransfer-out
    assertEq(byId['icbc-out'].ReconciliationId, FT_A, 'Step1.FundTransfer-out 行提取对账ID');
    assertEq(byId['icbc-in'].ReconciliationId, FT_B, 'Step1.FundTransfer-in（含首尾空格）行提取对账ID');
    assertEq(byId['icbc-inbound'].ReconciliationId, 'KEEP-1', 'Step1.Inbound 行备注带 FT 号也不覆盖原对账ID');
    assertEq(byId['icbc-internal'].ReconciliationId, '', 'Step1.InternelFundTransfer-in 不算调拨');
    assertEq(byId['icbc-fx'].ReconciliationId, '', 'Step1.FundTransfer-in&FX 不算调拨');
    assertEq(byId['icbc-blank'].ReconciliationId, '', 'Step1.FundType 为空不提取');

    // Step 2：DBS 不受限，R3.5 照常归组
    assertEq(byId['dbs-transfer'].ReconciliationId, FT_D, 'Step2.DBS 出款行对账ID');
    assertEq(byId['dbs-charge'].ReconciliationId, FT_D, 'Step2.DBS 手续费行（FundType=outbound）仍提取对账ID');
    assertEq(byId['dbs-transfer'].FundType, 'FundTransfer-out', 'Step2.R3.5 按调拨对账单把出款行标为 FundTransfer-out');
    assertEq(byId['dbs-charge'].FundType, 'Charge', 'Step2.R3.5 按同一对账ID把手续费行归为 Charge');

    // Step 3：命中统计与行数守恒
    const r2HitIds = result.modifiedRows
      .filter((row) => row._hitScenarioId === extract.id)
      .map((row) => row._rowId)
      .sort();
    assertEq(r2HitIds, ['dbs-charge', 'dbs-transfer', 'icbc-in', 'icbc-out'], 'Step3.自带提取场景只命中调拨行与 DBS 行');
    assertEq(result.modifiedRows.length + result.unmatchedRows.length, bankRows.length, 'Step3.行数守恒');
  } finally {
    appDb.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  const total = passed + failed;
  console.log(`\n==== ${passed}/${total} PASS ====`);
  if (failed > 0) {
    console.error('FAILURES:');
    failures.forEach((f) => {
      console.error(`  - ${f.label}: actual=${JSON.stringify(f.actual)} expected=${JSON.stringify(f.expected)}`);
    });
    process.exit(1);
  }
}

run().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
