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
const { FT_RECON_FIELD_MAP } = require('../../src/constants/fund-transfer-recon-fields');

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

function bigAccountOf(reconRows, fundType) {
  const row = reconRows.find((r) => r[R.fundType] === fundType);
  return row ? row[R.bigAccount] : undefined;
}

function run() {
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

run();
