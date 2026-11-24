// v3.0.12 功能2（批B）集成测试：账户映射回流派生 → R5s2-recon 端到端（🔴 资金红线）。
//
// 验证「映射回流」这条跨文件接缝：账户映射（中台调拨账户号 → 清结算银行账号）在调拨对账单派生时
//   套用到 big_account，使原本与银行 MerchantId 对不上的调拨行，经映射后能在 R5s2-recon 命中并回填 ReconciliationId。
//
// 串起的真实代码（端到端，无 mock）：
//   1. 临时 DB → AppDatabase().init()（自动建 fund_transfer_account_mappings + linked_fund_transfer_recon 表）。
//   2. saveFundTransferAccountMappings 写映射（批A facade）。
//   3. replaceLinkedTable('mid-allocation', …) 落中台调拨订单。
//   4. rebuildFundTransferReconDerivation({ database, buildFundTransferReconRows })
//        —— 🔴 这是 buildFundTransferReconRows 的【唯一】生产调用处；run 入口（main.js:3830）与
//           导入入口（main.js:11861）两条派生链都经它，内部从 database.getFundTransferAccountMappingMap() 取 map 注入。
//           直调本漏斗 = 镜像两条链的同款行为（run handler / import handler 均 IPC 绑定，无法在脚本里直接触发）。
//   5. readFundTransferReconRows() 读回派生表 → runRound5FundTransferReconBackfill(reconRows, bankRows)（真实 R5s2-recon 引擎）。
//   6. 断言：无映射 → big_account=原始账号 → 不命中（ReconciliationId 不回填）；
//           有映射 → big_account=清结算账号 → 命中（ReconciliationId 回填为调拨 ReconID）。in/out 两方向都覆盖。
//
// v3.2.22 追加（Case D-F）：网关来源（场景取消勾选「对账数据来源为中台调拨单表」，reconSourceMid:false）共用同一张映射表。
//   真实链路：saveFundTransferAccountMappings → 网关账单 upsert 落 linked_gateway_bill → readGatewayBillRowPoolsByChannels
//   → runReconciliation（fundTransferAccountMappingMap 取自 getFundTransferAccountMappingMap，与 bank-statement:run 注入一致）
//   → R5s2 网关引擎 merchantid 先映射再匹配；断言无映射不命中、有映射两方向回填、清空映射复原，且调拨来源 big_account 与 Case B 同口径。
//
// 用法：node scripts/integration/fund-transfer-recon-account-mapping.js

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { AppDatabase } = require('../../src/backend/database');
const { buildFundTransferReconRows } = require('../../src/main-process/fund-transfer-recon-builder');
const { rebuildFundTransferReconDerivation } = require('../../src/main-process/linked-derive-rebuild');
const {
  runRound5FundTransferReconBackfill
} = require('../../src/main-process/scenario-engines/r5-fund-transfer-recon-backfill');
const { runReconciliation } = require('../../src/main-process/reconciliation-orchestrator');
const {
  FT_RECON_FIELD_MAP,
  MID_ALLOCATION_SUCCESS_STATUS
} = require('../../src/constants/fund-transfer-recon-fields');

const M = FT_RECON_FIELD_MAP.mid;
const R = FT_RECON_FIELD_MAP.recon;

let passed = 0;
let failed = 0;
const failures = [];
function assertEq(actual, expected, label) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) { passed += 1; return; }
  failed += 1; failures.push({ label, actual, expected });
}
function assertTrue(cond, label) {
  if (cond) { passed += 1; return; }
  failed += 1; failures.push({ label, actual: cond, expected: true });
}

// 一行中台调拨订单：收款账户 = MID-RECV-001（in big_account 源）、付款账户 = MID-PAY-002（out big_account 源）。
//   原始账号刻意与银行 MerchantId（CLR-*）对不上 → 必须经映射回流才能命中。
function midRow() {
  return {
    [M.allocationNo]: 'ALLOC-1',
    [M.status]: MID_ALLOCATION_SUCCESS_STATUS,
    [M.txTime]: '2026-05-04', // → BillDate（与银行同日 → R5s2-recon Phase1 命中）
    [M.channelSerial]: 'RECON-1', // → ReconID（in/out 共用，回填来源）
    [M.payCard]: 'MID-PAY-002', // out big_account 源（原始付款账号）
    [M.payeeCard]: 'MID-RECV-001', // in big_account 源（原始收款账号）
    [M.receiveChannel]: 'DBS',
    [M.receiveAmount]: '2100000',
    [M.receiveCurrency]: 'USD',
    [M.payChannel]: 'CITI',
    [M.payAmount]: '900000',
    [M.payCurrency]: 'HKD'
  };
}

// 银行对账单两行：MerchantId 用「清结算账号」（CLR-*），仅当 big_account 被映射成 CLR-* 才会命中。
//   每个 case 用一份全新副本（R5s2-recon 引擎会原地改写 ReconciliationId）。
function freshBankRows() {
  return [
    {
      _rowId: 'BIN',
      FundType: 'FundTransfer-in',
      MerchantId: 'CLR-RECV-999', // 清结算账号（in）
      Currency: 'USD',
      'Credit Amount': 2100000,
      'Debit Amount': 0, // bankAmountAbs = 2100000
      BillDate: '2026-05-04', // 同日 → Phase1
      ReconciliationId: ''
    },
    {
      _rowId: 'BOUT',
      FundType: 'FundTransfer-out',
      MerchantId: 'CLR-PAY-888', // 清结算账号（out）
      Currency: 'HKD',
      'Credit Amount': 0,
      'Debit Amount': 900000, // bankAmountAbs = 900000
      BillDate: '2026-05-04',
      ReconciliationId: ''
    }
  ];
}

// 走生产唯一漏斗 rebuildFundTransferReconDerivation：内部取 getFundTransferAccountMappingMap 注入 builder。
function deriveReconRows(appDb) {
  const { fundTransferReconDerive } = rebuildFundTransferReconDerivation({
    database: appDb,
    buildFundTransferReconRows
  });
  return { derive: fundTransferReconDerive, reconRows: appDb.readFundTransferReconRows() };
}

// v3.2.22：网关账单两行（真实小写表头）；merchantid 用网关账户号（与中台调拨单原始账号同一份映射键）。
function gatewayRows() {
  return [
    {
      Channel: 'JPM', TradeType: 'FundTransfer-in', merchantid: 'MID-RECV-001', currency: 'USD',
      amount: '2100000', Billdate: '2026-05-04', reconciliationid: 'GW-RECON-IN', ReconBillBizId: 'GB-IN', orderid: 'GW-1'
    },
    {
      Channel: 'JPM', TradeType: 'FundTransfer-out', merchantid: 'MID-PAY-002', currency: 'HKD',
      amount: '-900000', Billdate: '2026-05-04', reconciliationid: 'GW-RECON-OUT', ReconBillBizId: 'GB-OUT', orderid: 'GW-2'
    }
  ];
}

// R5s2 场景：取消勾选 → 网关来源。
function gatewaySourceScenario() {
  return {
    id: 9001,
    name: '中台调拨订单对账ID回填',
    category: 'builtin-fixed',
    priority: 0,
    enabled: true,
    config: {
      funcCategory: 'platform-order',
      subCategory: 'fund-transfer-backfill',
      roundPhase: 5,
      directions: [
        { gwTradeType: 'FundTransfer-out', bankFundType: 'FundTransfer-out' },
        { gwTradeType: 'FundTransfer-in', bankFundType: 'FundTransfer-in' }
      ],
      dateToleranceDays: 1,
      reconSourceMid: false
    }
  };
}

// 镜像 bank-statement:run：按银行 Channel 读网关池，映射从 facade 实时取。
async function runGatewaySource(appDb) {
  const bankRows = freshBankRows().map((row) => ({ ...row, Channel: 'JPM' }));
  const gwRows = appDb.readGatewayBillRowPoolsByChannels(bankRows.map((row) => row.Channel)).exactRows;
  const result = await runReconciliation({
    bankRows,
    gwRows,
    scenarios: [gatewaySourceScenario()],
    fundTransferAccountMappingMap: appDb.getFundTransferAccountMappingMap()
  });
  return { result, bankRows, gwRows };
}

function bigAccountOf(reconRows, fundType) {
  const row = reconRows.find((r) => r[R.fundType] === fundType);
  return row ? row[R.bigAccount] : undefined;
}

async function run() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ftr-acct-map-'));
  let appDb;
  try {
    appDb = new AppDatabase(path.join(tmpDir, 'test.sqlite'));
    appDb.init();
    appDb.replaceLinkedTable('mid-allocation', [midRow()]);

    // ===== Case A：无映射 → big_account=原始账号 → R5s2-recon 不命中 =====
    {
      appDb.saveFundTransferAccountMappings([]); // 确保映射表空
      const { derive, reconRows } = deriveReconRows(appDb);
      assertTrue(derive && derive.created === true, 'A: 派生成功（created:true）');
      assertEq(reconRows.length, 2, 'A: 一行 mid → in/out 两行调拨对账单');
      // 🔴 接缝定位：无映射时 big_account = 原始账号（passthrough）。
      assertEq(bigAccountOf(reconRows, FT_RECON_FIELD_MAP.FUND_TYPE_IN), 'MID-RECV-001', 'A: in big_account=原始收款账号（未映射）');
      assertEq(bigAccountOf(reconRows, FT_RECON_FIELD_MAP.FUND_TYPE_OUT), 'MID-PAY-002', 'A: out big_account=原始付款账号（未映射）');

      const bankRows = freshBankRows();
      const { modifications } = runRound5FundTransferReconBackfill(reconRows, bankRows);
      assertEq(modifications.length, 0, '🔴 A: 无映射 → big_account 对不上银行 MerchantId → 0 回填');
      assertEq(bankRows.find((b) => b._rowId === 'BIN').ReconciliationId, '', 'A: 银行 in 行 ReconciliationId 仍空');
      assertEq(bankRows.find((b) => b._rowId === 'BOUT').ReconciliationId, '', 'A: 银行 out 行 ReconciliationId 仍空');
    }

    // ===== Case B：配映射 → big_account=清结算账号 → R5s2-recon 命中回填 =====
    {
      appDb.saveFundTransferAccountMappings([
        { midAccountId: 'MID-RECV-001', clearingAccountId: 'CLR-RECV-999' },
        { midAccountId: 'MID-PAY-002', clearingAccountId: 'CLR-PAY-888' }
      ]);
      const { derive, reconRows } = deriveReconRows(appDb);
      assertTrue(derive && derive.created === true, 'B: 派生成功（created:true）');
      // 🔴 接缝定位：有映射时 big_account 被替换成清结算账号。
      assertEq(bigAccountOf(reconRows, FT_RECON_FIELD_MAP.FUND_TYPE_IN), 'CLR-RECV-999', '🔴 B: in big_account 映射回流为清结算账号');
      assertEq(bigAccountOf(reconRows, FT_RECON_FIELD_MAP.FUND_TYPE_OUT), 'CLR-PAY-888', '🔴 B: out big_account 映射回流为清结算账号');
      // 🔴 展示字段不被翻译（付款账号 / 收款账号保持原值）。
      assertEq(reconRows[0][R.payeeAccount], 'MID-RECV-001', 'B: 收款账号（展示字段）保持原值');
      assertEq(reconRows[0][R.payAccount], 'MID-PAY-002', 'B: 付款账号（展示字段）保持原值');

      const bankRows = freshBankRows();
      const { modifications } = runRound5FundTransferReconBackfill(reconRows, bankRows);
      assertEq(modifications.length, 2, '🔴 B: 有映射 → in/out 两行均命中 → 2 行 ReconciliationId 回填');
      assertEq(bankRows.find((b) => b._rowId === 'BIN').ReconciliationId, 'RECON-1', '🔴 B: 银行 in 行回填调拨 ReconID');
      assertEq(bankRows.find((b) => b._rowId === 'BOUT').ReconciliationId, 'RECON-1', '🔴 B: 银行 out 行回填调拨 ReconID');
      assertTrue(modifications.every((mod) => mod.column === 'ReconciliationId'), 'B: 改写列均为 ReconciliationId');
    }

    // ===== Case C：映射改回空 → 回到 passthrough（可逆，映射表空＝字节级零变化）=====
    {
      appDb.saveFundTransferAccountMappings([]);
      const { reconRows } = deriveReconRows(appDb);
      assertEq(bigAccountOf(reconRows, FT_RECON_FIELD_MAP.FUND_TYPE_IN), 'MID-RECV-001', 'C: 清空映射后 in big_account 回到原始账号');
      assertEq(bigAccountOf(reconRows, FT_RECON_FIELD_MAP.FUND_TYPE_OUT), 'MID-PAY-002', 'C: 清空映射后 out big_account 回到原始账号');
      const bankRows = freshBankRows();
      const { modifications } = runRound5FundTransferReconBackfill(reconRows, bankRows);
      assertEq(modifications.length, 0, '🔴 C: 清空映射 → 不再命中（映射表空＝零变化）');
    }

    // ===== v3.2.22 网关来源：同一张映射表作用于网关 merchantid =====
    appDb.upsertLinkedGatewayBill(gatewayRows(), { sourceFileName: 'gateway.xlsx', legacySource: true });

    // ===== Case D：无映射 → 网关账户号对不上银行 MerchantId → 不回填 =====
    {
      appDb.saveFundTransferAccountMappings([]);
      const { result, bankRows, gwRows } = await runGatewaySource(appDb);
      assertEq(gwRows.length, 2, 'D: 网关账单经链接表按 Channel 读回 2 行');
      assertEq(result.stats.r5s2BackfilledCount, 0, '🔴 D: 无映射 → 网关来源 0 回填');
      assertEq(bankRows.map((b) => b.ReconciliationId), ['', ''], 'D: 银行行 ReconciliationId 仍空');
      assertEq(result.modifiedRows.length + result.unmatchedRows.length, 2, 'D: 行数守恒');
    }

    // ===== Case E：配映射 → 网关 merchantid 换成清结算账号 → in/out 两方向回填网关 reconciliationid =====
    {
      appDb.saveFundTransferAccountMappings([
        { midAccountId: 'MID-RECV-001', clearingAccountId: 'CLR-RECV-999' },
        { midAccountId: 'MID-PAY-002', clearingAccountId: 'CLR-PAY-888' }
      ]);
      const { result, bankRows, gwRows } = await runGatewaySource(appDb);
      assertEq(bankRows.find((b) => b._rowId === 'BIN').ReconciliationId, 'GW-RECON-IN', '🔴 E: 银行 in 行回填网关 reconciliationid');
      assertEq(bankRows.find((b) => b._rowId === 'BOUT').ReconciliationId, 'GW-RECON-OUT', '🔴 E: 银行 out 行回填网关 reconciliationid');
      const rounds = result.modifications.filter((m) => m.column === 'ReconciliationId').map((m) => m._round);
      assertEq(rounds, ['R5s2', 'R5s2'], 'E: 两条改写均来自 R5s2 网关来源');
      assertEq(gwRows.map((g) => g.merchantid), ['MID-RECV-001', 'MID-PAY-002'], 'E: 网关行 merchantid 不被改写');
      assertEq(result.manyToManyReviewRows.length, 0, 'E: 1:1 命中，不产生多对多异常说明');
      assertEq(result.modifiedRows.length + result.unmatchedRows.length, 2, 'E: 行数守恒');

      // 同一份映射下调拨来源口径一致（共用一张表）：派生 big_account 同样是清结算账号。
      const { reconRows } = deriveReconRows(appDb);
      assertEq(bigAccountOf(reconRows, FT_RECON_FIELD_MAP.FUND_TYPE_IN), 'CLR-RECV-999', 'E: 调拨来源 in big_account 同表映射');
      assertEq(bigAccountOf(reconRows, FT_RECON_FIELD_MAP.FUND_TYPE_OUT), 'CLR-PAY-888', 'E: 调拨来源 out big_account 同表映射');
    }

    // ===== Case F：清空映射 → 网关来源回到未映射口径 =====
    {
      appDb.saveFundTransferAccountMappings([]);
      const { result, bankRows } = await runGatewaySource(appDb);
      assertEq(result.stats.r5s2BackfilledCount, 0, '🔴 F: 清空映射 → 网关来源不再回填（映射表空＝零变化）');
      assertEq(bankRows.map((b) => b.ReconciliationId), ['', ''], 'F: 银行行 ReconciliationId 仍空');
    }
  } catch (err) {
    failed += 1;
    failures.push({ label: '运行抛错', actual: String(err && err.stack ? err.stack : err), expected: '无异常' });
  } finally {
    try { if (appDb && appDb.db) appDb.db.close(); } catch (_e) { /* ignore */ }
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_e) { /* ignore */ }
  }

  console.log(`\n断言：${passed} 通过 / ${failed} 失败（共 ${passed + failed}）`);
  if (failed > 0) {
    console.error('\n失败明细：');
    for (const f of failures) {
      console.error(`  ✗ ${f.label}\n    actual=${JSON.stringify(f.actual)}\n    expected=${JSON.stringify(f.expected)}`);
    }
    // integration-runner 抓「N/N PASS」做计数；失败时输出实际通过/总数。
    console.log(`${passed}/${passed + failed} PASS`);
    process.exitCode = 1;
  } else {
    console.log(`${passed}/${passed} PASS`);
    console.log('✓ 全部断言通过');
  }
}

run().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exitCode = 1;
});
