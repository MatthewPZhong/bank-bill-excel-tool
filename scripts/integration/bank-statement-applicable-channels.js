// v3.2.15 银行对账单处理：自带写死场景「适用银行渠道」对 R4 资金性质校验与退款回填生效 e2e 集成验证
//   覆盖：临时 AppDatabase（init 内置场景种子）→ 新建两个银行渠道 → 真实仓储保存 R4 Ach Return 与
//         中台退款订单回填的适用渠道 → 按 main.js 运行快照口径附 _applicableChannelIds →
//         编排器（双维调度依赖：真实 channels 仓储 + db）→ 退款回填 writer 写出并回读。
//   🔴 资金红线：排除渠道的银行行 FundType 不变，退款回填文件不含该渠道的 SUCCESS 行；空列表 = 全部渠道。
//
// 用法：node scripts/integration/bank-statement-applicable-channels.js

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ExcelJS = require('exceljs');

const { AppDatabase } = require('../../src/backend/database');
const channelsRepository = require('../../src/backend/database/channels-repository');
const { runReconciliation } = require('../../src/main-process/reconciliation-orchestrator');
const { writeRefundBackfillOutput, BACKFILL_SHEET_NAME } = require('../../src/main-process/refund-backfill-writer');

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

function findBuiltinScenario(appDb, subCategory) {
  const meta = appDb.listScenarios().find((item) => {
    const detail = appDb.getScenario(item.id);
    return detail && detail.category === 'builtin-fixed' && detail.config && detail.config.subCategory === subCategory;
  });
  return meta || null;
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

function bankRow(rowId, channel, location, overrides) {
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
    地区: location,
    ChannelOrderNo: '',
    CustomerRef: '',
    'Extra Information': '',
    'Payment Detail': '',
    ...overrides
  };
}

function buildRunInput() {
  const bankRows = [
    // R4：同构 AchReturn 出账，分属两个渠道
    bankRow('r4-icbc', '工商', '上海', { ReconciliationId: 'RC-1', FundType: 'outbound' }),
    bankRow('r4-citi', '花旗', '纽约', { ReconciliationId: 'RC-2', FundType: 'outbound' }),
    // 退款：已是 Ach Return 的银行行，各对应一条 SUBMITTED 退款订单
    bankRow('rf-icbc', '工商', '上海', { FundType: 'Ach Return', ChannelOrderNo: 'PAY-1' }),
    bankRow('rf-citi', '花旗', '纽约', { FundType: 'Ach Return', ChannelOrderNo: 'PAY-2' })
  ];
  const gwRows = ['RC-1', 'RC-2'].map((reconciliationid) => ({
    reconciliationid, TradeType: 'AchReturn', merchantid: 'M001', currency: 'USD', amount: 100, Billdate: '2026-06-01', orderid: ''
  }));
  const refundOrderRows = [
    { 流水号: 'REF-1', 银行大账号: 'M001', 退款金额: 100, 币种: 'USD', 状态: 'SUBMITTED', 银行打款流水号: 'PAY-1', 附言: '', valueDate: '2026-06-01' },
    { 流水号: 'REF-2', 银行大账号: 'M001', 退款金额: 100, 币种: 'USD', 状态: 'SUBMITTED', 银行打款流水号: 'PAY-2', 附言: '', valueDate: '2026-06-01' }
  ];
  return { bankRows, gwRows, refundContext: { refundOrderRows, depositRows: [] } };
}

async function readBackfillRows(filePath) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(filePath);
  const sheet = workbook.getWorksheet(BACKFILL_SHEET_NAME);
  const header = sheet.getRow(1).values;
  const index = (name) => header.indexOf(name);
  const rows = [];
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    rows.push([row.getCell(index('退款单号')).value, row.getCell(index('状态')).value]);
  });
  return rows.sort();
}

async function runCase(appDb, scenarios, outputPath) {
  const input = buildRunInput();
  const result = await runReconciliation({
    ...input,
    scenarios,
    deps: { channelsRepo: channelsRepository, db: appDb.db }
  });
  await writeRefundBackfillOutput(result.refundBackfillRows, result.refundUnmatchedRows, outputPath);
  const fundTypes = Object.fromEntries(input.bankRows.map((row) => [row._rowId, row.FundType]));
  return { fundTypes, backfill: await readBackfillRows(outputPath), result };
}

async function run() {
  console.log('==== 银行对账单处理：自带写死场景适用银行渠道（R4 / 退款回填）e2e 集成验证 ====');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bank-statement-applicable-channels-'));
  const appDb = new AppDatabase(path.join(tmpDir, 'tool-data.sqlite'));
  appDb.init();

  try {
    const icbc = appDb.createChannel({ name: '工商', ownerLocation: '上海' });
    const citi = appDb.createChannel({ name: '花旗', ownerLocation: '纽约' });
    const achReturn = findBuiltinScenario(appDb, 'ach-return');
    const refund = findBuiltinScenario(appDb, 'refund-order-backfill');
    assertTrue(Boolean(achReturn && refund), 'Step0.内置 R4 Ach Return 与退款回填场景已随 init 写入');

    // Step 1：两个场景都只适用「工商-上海」
    appDb.setScenarioApplicableChannels(achReturn.id, [icbc.id]);
    appDb.setScenarioApplicableChannels(refund.id, [icbc.id]);
    assertEq(appDb.getScenarioApplicableChannels(achReturn.id), [icbc.id], 'Step1.R4 适用渠道已持久化');
    const limited = await runCase(appDb, [runtimeScenario(appDb, achReturn), runtimeScenario(appDb, refund)], path.join(tmpDir, 'limited.xlsx'));
    assertEq(limited.fundTypes['r4-icbc'], 'Ach Return', 'Step1.适用渠道内 R4 改写 FundType');
    assertEq(limited.fundTypes['r4-citi'], 'outbound', 'Step1.排除渠道 R4 不改写 FundType');
    assertEq(limited.backfill, [['REF-1', 'SUCCESS']], 'Step1.退款回填文件只含适用渠道的 SUCCESS 行');
    assertEq(limited.result.stats.r5s4BackfilledCount, 1, 'Step1.退款回填计数');

    // Step 2：改为只适用「花旗-纽约」
    appDb.setScenarioApplicableChannels(achReturn.id, [citi.id]);
    appDb.setScenarioApplicableChannels(refund.id, [citi.id]);
    const switched = await runCase(appDb, [runtimeScenario(appDb, achReturn), runtimeScenario(appDb, refund)], path.join(tmpDir, 'switched.xlsx'));
    assertEq([switched.fundTypes['r4-icbc'], switched.fundTypes['r4-citi']], ['outbound', 'Ach Return'], 'Step2.R4 只改写花旗');
    assertEq(switched.backfill, [['REF-2', 'SUCCESS']], 'Step2.退款回填只含花旗');

    // Step 3：清空列表 = 适用全部渠道（保持原行为）
    appDb.setScenarioApplicableChannels(achReturn.id, []);
    appDb.setScenarioApplicableChannels(refund.id, []);
    const all = await runCase(appDb, [runtimeScenario(appDb, achReturn), runtimeScenario(appDb, refund)], path.join(tmpDir, 'all.xlsx'));
    assertEq([all.fundTypes['r4-icbc'], all.fundTypes['r4-citi']], ['Ach Return', 'Ach Return'], 'Step3.空列表 R4 处理全部渠道');
    assertEq(all.backfill, [['REF-1', 'SUCCESS'], ['REF-2', 'SUCCESS']], 'Step3.空列表退款回填全部渠道');
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
