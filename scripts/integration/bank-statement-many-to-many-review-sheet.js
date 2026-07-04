// 功能1「异常说明并入命中场景」集成测试（🔴 资金红线·只读检测端到端契约）
//   覆盖：
//     ① 编排器 runReconciliation 产出 manyToManyReviewRows / stats.manyToManyReviewCount（NvM 命中、1v1/1vN/Nv1 不命中）
//     ② 🔴 回填行为不变 + 纯只读：full orchestrator 与「直调 R5s2-recon 引擎」对同一夹具的 modifications /
//        银行行最终态逐字节一致（检测器不改任何 bankRow / modifications / 行数守恒）
//     ③ 跨接缝透传：经 io 层 writeBankStatementMainOutput（= main.js export handler 同款调用，
//        manyToManyRows 落 writer 第 8 形参）→ 真实写盘 → ExcelJS 读回「命中场景」第 2 列「异常说明」
//     ④ 条件生成：无 NvM → reviewRows 空 → 主文件不含独立异常 sheet，命中行异常说明为空
//
//   为何端到端：检测器（orchestrator 内）→ processingResult → io → writer 是 4 跳接缝（历史教训：
//   逐文件 review 看不见接缝，writer 第 7 形参 staleHitNotesByRowId 易把 manyToManyRows 串位）。
//   本脚本用真实 ExcelJS 读盘锁死 sheet 名/表头/异常说明列，并用「引擎 parity」锁死回填零变化。
//
//   用法：node scripts/integration/bank-statement-many-to-many-review-sheet.js

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ExcelJS = require('exceljs');

const { runReconciliation } = require('../../src/main-process/reconciliation-orchestrator');
const { writeBankStatementMainOutput } = require('../../src/main-process/bank-statement-io');
const {
  runRound5FundTransferReconBackfill
} = require('../../src/main-process/scenario-engines/r5-fund-transfer-recon-backfill');
const { BANK_STATEMENT_FIELDS } = require('../../src/constants/bank-statement-fields');
const { FT_RECON_FIELD_MAP } = require('../../src/constants/fund-transfer-recon-fields');

const RECON = FT_RECON_FIELD_MAP.recon;
const FUND_IN = FT_RECON_FIELD_MAP.FUND_TYPE_IN;
const HIT_SHEET_NAME = '命中场景';
const OLD_REVIEW_SHEET_NAME = '异常-人工判断';

let passed = 0;
let failed = 0;
const failures = [];

function assertEq(actual, expected, label) {
  if (actual === expected) {
    passed += 1;
  } else {
    failed += 1;
    failures.push({ label, detail: `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}` });
  }
}
function assertTrue(cond, label) {
  if (cond) {
    passed += 1;
  } else {
    failed += 1;
    failures.push({ label, detail: 'expected truthy' });
  }
}

const clone = (x) => JSON.parse(JSON.stringify(x));

// ---- 夹具 --------------------------------------------------------------

const DATE = '2026-06-07';

function bankRow(rowId, merchantId, amount, fundType = FUND_IN) {
  return {
    _rowId: rowId,
    MerchantId: merchantId,
    Currency: 'USD',
    'Credit Amount': amount,
    'Debit Amount': 0,
    BillDate: DATE,
    FundType: fundType,
    ReconciliationId: ''
  };
}
function reconRow(bigAccount, amount, reconId) {
  return {
    [RECON.bigAccount]: bigAccount,
    [RECON.currency]: 'USD',
    [RECON.amount]: amount,
    [RECON.billDate]: DATE,
    [RECON.reconId]: reconId,
    [RECON.fundType]: FUND_IN
  };
}
function gwRow(merchantid, amount) {
  return { merchantid, currency: 'USD', amount, Billdate: DATE, TradeType: FUND_IN, reconciliationid: '' };
}

// R5s2 场景（reconSourceMid 缺省 → 走调拨对账单回填引擎）
function r5s2Scenario() {
  return {
    id: 502,
    name: '中台调拨订单对账ID回填',
    category: 'builtin-fixed',
    priority: 0,
    enabled: true,
    config: { funcCategory: 'platform-order', subCategory: 'fund-transfer-backfill', roundPhase: 5, dateToleranceDays: 1 }
  };
}

// 夹具分组：
//   A 1v1（ACC_A，50）：1 银行 + 1 调拨 → 回填、不命中检测
//   B NvM-recon（ACC_B，100）：2 银行 + 2 调拨 → 回填 cand[0]、检测命中（note=调拨）
//   C NvM-gateway（ACC_C，200）：2 银行 + 2 网关、无调拨 → 不回填（recon 路）、检测命中（note=网关）
//   D 1vN（ACC_D，300）：1 银行 + 2 调拨 → 回填、不命中
//   E Nv1（ACC_E，400）：2 银行 + 1 调拨 → 回填 cand[0]、不命中
function buildFixture() {
  const bankRows = [
    bankRow('bA1', 'ACC_A', 50),
    bankRow('bB1', 'ACC_B', 100),
    bankRow('bB2', 'ACC_B', 100),
    bankRow('bC1', 'ACC_C', 200),
    bankRow('bC2', 'ACC_C', 200),
    bankRow('bD1', 'ACC_D', 300),
    bankRow('bE1', 'ACC_E', 400),
    bankRow('bE2', 'ACC_E', 400)
  ];
  const reconRows = [
    reconRow('ACC_A', 50, 'RC-A'),
    reconRow('ACC_B', 100, 'RC-B1'),
    reconRow('ACC_B', 100, 'RC-B2'),
    reconRow('ACC_D', 300, 'RC-D1'),
    reconRow('ACC_D', 300, 'RC-D2'),
    reconRow('ACC_E', 400, 'RC-E1')
  ];
  const gwRows = [gwRow('ACC_C', 200), gwRow('ACC_C', 200)];
  return { bankRows, reconRows, gwRows };
}

async function run() {
  console.log('==== 功能1「异常说明并入命中场景」集成验证 ====');

  // ===== Step 1：编排器产出 + 回填 parity（read-only 证据）=====
  const fx = buildFixture();
  const bankRows = clone(fx.bankRows);
  const reconRows = clone(fx.reconRows);
  const gwRows = clone(fx.gwRows);

  // baseline：直调 R5s2-recon 引擎（夹具无 R2/R3.5/R4 场景 → orchestrator 的唯一回填来源就是它）
  const baselineBank = clone(fx.bankRows);
  const baseline = runRound5FundTransferReconBackfill(clone(fx.reconRows), baselineBank, { dateToleranceDays: 1 });

  const result = await runReconciliation({
    bankRows,
    gwRows,
    scenarios: [r5s2Scenario()],
    fundTransferReconContext: { reconRows }
  });

  // ① 行数守恒（检测器只读，不破）
  assertEq(result.modifiedRows.length + result.unmatchedRows.length, bankRows.length, '行数守恒 modified+unmatched===bankRows');

  // ② manyToManyReviewRows / stats
  const reviewIds = result.manyToManyReviewRows.map((r) => r.row._rowId).sort();
  assertEq(JSON.stringify(reviewIds), JSON.stringify(['bB1', 'bB2', 'bC1', 'bC2']), 'reviewRows 命中 = NvM 银行行（B+C 各2）');
  assertEq(result.stats.manyToManyReviewCount, 4, 'stats.manyToManyReviewCount=4');
  // 1v1 / 1vN / Nv1 不进
  assertTrue(!reviewIds.includes('bA1'), '1v1(bA1) 不进 reviewRows');
  assertTrue(!reviewIds.includes('bD1'), '1vN(bD1) 不进 reviewRows');
  assertTrue(!reviewIds.includes('bE1') && !reviewIds.includes('bE2'), 'Nv1(bE) 不进 reviewRows');
  // note 对手方正确（B=调拨、C=网关）
  const noteById = new Map(result.manyToManyReviewRows.map((r) => [r.row._rowId, r.note]));
  assertTrue(/调拨/.test(noteById.get('bB1')) && /多对多/.test(noteById.get('bB1')), 'bB1 note 标注调拨多对多');
  assertTrue(/网关/.test(noteById.get('bC1')) && /多对多/.test(noteById.get('bC1')), 'bC1 note 标注网关多对多');

  // ③ 🔴 回填行为不变：orchestrator 的 ReconciliationId modifications == baseline 引擎；银行行最终态逐字节一致
  const backfillMap = (mods) => {
    const m = {};
    for (const x of mods) if (x.column === 'ReconciliationId') m[x.rowId] = x.newValue;
    return m;
  };
  assertEq(
    JSON.stringify(backfillMap(result.modifications)),
    JSON.stringify(backfillMap(baseline.modifications)),
    '回填 modifications 与 baseline 引擎逐条一致（检测器零影响）'
  );
  // 银行行最终态（含回填后 ReconciliationId）逐行逐字节 = baseline → 检测器纯只读不改字段
  const projectBank = (rows) => rows.map((r) => {
    const o = {};
    for (const k of Object.keys(r)) if (k !== '_modifiedColumns') o[k] = r[k];
    return o;
  });
  assertEq(
    JSON.stringify(projectBank(bankRows)),
    JSON.stringify(projectBank(baselineBank)),
    '🔴 银行行最终态与 baseline 逐字节一致（检测器不写任何字段）'
  );
  // 命中行确实是回填后的「数据脏」行：bB1/bB2 已被回填（cand[0] 单向消费），bC1/bC2 recon 路未回填
  const reconIdOf = (id) => bankRows.find((r) => r._rowId === id).ReconciliationId;
  assertTrue(reconIdOf('bB1') !== '' && reconIdOf('bB2') !== '', 'NvM-recon 行仍按现状回填（取其一/单向消费）');
  assertEq(reconIdOf('bC1'), '', 'NvM-gateway 行在 recon 路不回填（检测池比回填池更宽）');

  // ===== Step 2：跨接缝透传 → 真实写盘 → 读回 sheet =====
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'm2m-sheet-'));
  const mainFilePath = path.join(tmpDir, '银行对账单-异常人工判断.xlsx');
  try {
    await writeBankStatementMainOutput({
      modifiedRows: result.modifiedRows,
      headers: BANK_STATEMENT_FIELDS,
      mainFilePath,
      unmatchedRows: result.unmatchedRows,
      modifications: result.modifications,
      paymentOfflinePairs: result.paymentOfflineMatchedPairs,
      // 🔴 接缝：main.js export handler 同款 —— manyToManyReviewRows → io manyToManyRows → writer 第 8 形参
      manyToManyRows: result.manyToManyReviewRows
    });

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(mainFilePath);
    assertTrue(!wb.getWorksheet(OLD_REVIEW_SHEET_NAME), '主文件不再含「异常-人工判断」独立 sheet');
    assertTrue(!wb.getWorksheet('异常-人工处理'), '主文件不含历史别名「异常-人工处理」独立 sheet');
    const sheet = wb.getWorksheet(HIT_SHEET_NAME);
    assertTrue(!!sheet, `主文件含「${HIT_SHEET_NAME}」sheet`);

    if (sheet) {
      // 表头 = [命中明细, 异常说明, ...BANK_STATEMENT_FIELDS]
      const headerCells = sheet.getRow(1).values.slice(1); // ExcelJS values[0] 占位
      assertEq(headerCells[0], '命中明细', '命中 sheet 第 1 列=命中明细');
      assertEq(headerCells[1], '异常说明', '命中 sheet 第 2 列=异常说明');
      assertEq(headerCells.length, BANK_STATEMENT_FIELDS.length + 2, `表头列数 = 2 + 银行 ${BANK_STATEMENT_FIELDS.length} 列`);
      assertEq(headerCells[2], BANK_STATEMENT_FIELDS[0], '第 3 列起为银行契约列（账户主体）');

      // MerchantId / ReconciliationId 列在命中 sheet 内的列号（命中明细+异常说明 → 银行列整体 +2）
      const midColIdx = 2 + (BANK_STATEMENT_FIELDS.indexOf('MerchantId') + 1);
      const reconColIdx = 2 + (BANK_STATEMENT_FIELDS.indexOf('ReconciliationId') + 1);
      const noteRows = [];
      for (let r = 2; r <= sheet.rowCount; r += 1) {
        const note = String(sheet.getRow(r).getCell(2).value || '');
        if (note) {
          noteRows.push({
            merchantId: sheet.getRow(r).getCell(midColIdx).value,
            reconId: String(sheet.getRow(r).getCell(reconColIdx).value || ''),
            note
          });
        }
      }
      const midsInSheet = noteRows.map((r) => r.merchantId).sort();
      assertEq(JSON.stringify(midsInSheet), JSON.stringify(['ACC_B', 'ACC_B', 'ACC_C', 'ACC_C']), '异常说明行 MerchantId = B/B/C/C');
      assertTrue(noteRows.every((r) => r.note.includes('多对多')), '每条异常说明非空且含「多对多」');
      // 银行行内部字段（_rowId/_modifiedColumns 等）不在表头（headers 投影，不暴露诊断列）
      const headerHasInternal = headerCells.some((h) => typeof h === 'string' && h.startsWith('_'));
      assertTrue(!headerHasInternal, '命中 sheet 表头不含 _ 内部诊断列');
      // 回填后的 ReconciliationId 忠实写出（bB 行非空 / bC 行空）
      assertTrue(noteRows.filter((r) => r.reconId !== '').length === 2, '异常说明行内 2 行(B)带回填 ReconciliationId、2 行(C)为空');
    }

    // ===== Step 3：条件生成 —— 无 NvM → 不加 sheet =====
    const cleanBank = [bankRow('z1', 'ZZ', 9), bankRow('z2', 'ZZ2', 9)]; // 不同账号 → 无多对多
    const cleanResult = await runReconciliation({
      bankRows: cleanBank,
      gwRows: [],
      scenarios: [r5s2Scenario()],
      fundTransferReconContext: { reconRows: [reconRow('ZZ', 9, 'RC-Z')] } // 1v1，不命中检测
    });
    assertEq(cleanResult.manyToManyReviewRows.length, 0, '无 NvM → manyToManyReviewRows 空');
    assertEq(cleanResult.stats.manyToManyReviewCount, 0, '无 NvM → stats.manyToManyReviewCount=0');

    const cleanPath = path.join(tmpDir, '银行对账单-无异常.xlsx');
    await writeBankStatementMainOutput({
      modifiedRows: cleanResult.modifiedRows,
      headers: BANK_STATEMENT_FIELDS,
      mainFilePath: cleanPath,
      unmatchedRows: cleanResult.unmatchedRows,
      modifications: cleanResult.modifications,
      paymentOfflinePairs: cleanResult.paymentOfflineMatchedPairs,
      manyToManyRows: cleanResult.manyToManyReviewRows
    });
    const wb2 = new ExcelJS.Workbook();
    await wb2.xlsx.readFile(cleanPath);
    assertTrue(!wb2.getWorksheet(OLD_REVIEW_SHEET_NAME), '条件生成：reviewRows 空 → 主文件不含「异常-人工判断」独立 sheet');
    const cleanHitSheet = wb2.getWorksheet(HIT_SHEET_NAME);
    assertTrue(!!cleanHitSheet, '条件生成：命中场景 sheet 仍存在');
    if (cleanHitSheet) {
      assertEq(cleanHitSheet.getRow(1).getCell(2).value, '异常说明', '条件生成：命中 sheet 仍保留异常说明空列');
      let hasNote = false;
      for (let r = 2; r <= cleanHitSheet.rowCount; r += 1) {
        if (String(cleanHitSheet.getRow(r).getCell(2).value || '').trim()) hasNote = true;
      }
      assertTrue(!hasNote, '条件生成：无 reviewRows 时异常说明列为空');
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  // ===== Step 4：检测器日期容差 = R5s2 场景配置（codex-P2-1 回归，无需写盘）=====
  //   编排器以 r5s2Bucket[0].config.dateToleranceDays 传检测器（须 = 回填引擎实际用值）。修复前编排器漏传
  //   options → 检测器固定回退默认 1 → 容差≠1 时复核表与回填口径不一致。走调拨侧（checked 路，与 Step1 同引擎）：
  //     容差0：隔 1 天的 2×2 组本不该进表（旧实现按默认 1 误进 = 过报）；
  //     容差3：隔 2 天的 2×2 组本该进表（旧实现按默认 1 漏边 = 漏报）。
  const r5s2ScenarioTol = (dateToleranceDays) => {
    const s = r5s2Scenario();
    s.config = { ...s.config, dateToleranceDays };
    return s;
  };
  const reconRowOn = (bigAccount, amount, reconId, billDate) => {
    const rc = reconRow(bigAccount, amount, reconId);
    rc[RECON.billDate] = billDate; // 覆盖夹具默认 DATE，制造隔日组
    return rc;
  };

  // 容差0：2 银行（同日 DATE=2026-06-07）× 2 调拨（DATE+1=06-08）→ 隔 1 天，容差 0 不成边 → 不命中
  const tol0 = await runReconciliation({
    bankRows: [bankRow('t0a', 'TOL0', 200), bankRow('t0b', 'TOL0', 200)],
    gwRows: [],
    scenarios: [r5s2ScenarioTol(0)],
    fundTransferReconContext: {
      reconRows: [reconRowOn('TOL0', 200, 'RC-T0a', '2026-06-08'), reconRowOn('TOL0', 200, 'RC-T0b', '2026-06-08')]
    }
  });
  assertEq(tol0.manyToManyReviewRows.length, 0, '容差0：隔 1 天的 2×2 组不进 reviewRows（修复前按默认1误进=过报）');
  assertEq(tol0.stats.manyToManyReviewCount, 0, '容差0：stats.manyToManyReviewCount=0');

  // 容差3：2 银行（同日 DATE）× 2 调拨（DATE+2=06-09）→ 隔 2 天，容差 3 成边 → 命中
  const tol3 = await runReconciliation({
    bankRows: [bankRow('t3a', 'TOL3', 300), bankRow('t3b', 'TOL3', 300)],
    gwRows: [],
    scenarios: [r5s2ScenarioTol(3)],
    fundTransferReconContext: {
      reconRows: [reconRowOn('TOL3', 300, 'RC-T3a', '2026-06-09'), reconRowOn('TOL3', 300, 'RC-T3b', '2026-06-09')]
    }
  });
  const tol3Ids = tol3.manyToManyReviewRows.map((r) => r.row._rowId).sort();
  assertEq(JSON.stringify(tol3Ids), JSON.stringify(['t3a', 't3b']), '容差3：隔 2 天的 2×2 组进 reviewRows（修复前按默认1漏边=漏报）');
  assertEq(tol3.stats.manyToManyReviewCount, 2, '容差3：stats.manyToManyReviewCount=2');

  const total = passed + failed;
  console.log(`\n==== ${passed}/${total} PASS ====`);
  if (failed > 0) {
    failures.forEach((f) => console.error(`  - ${f.label}: ${f.detail}`));
    process.exit(1);
  }
}

run().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
