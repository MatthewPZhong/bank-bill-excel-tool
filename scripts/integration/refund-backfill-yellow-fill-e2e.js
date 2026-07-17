// refund-backfill「命中字段标黄」跨接缝端到端集成测试（v3.0.10 需求3.1，🔴 资金红线 · 跨接缝盲区 R-5）。
// spec: docs/iterations/v3.0.10/TECHDOC.md §五/§七 + plan whimsical-cuddling-crane.md 需求3.1
//
//   覆盖「matcher 产候选列 → buildBackfillRow 单点过滤收口 → export 浅拷贝存活 → writer 标黄（列偏移 i+1）」整条 4 段跨 3 文件链路：
//     ① 真实引擎 runRound5RefundOrderBackfill 各策略命中 → backfillRow 带 _matchedColumns（已过滤 ∈ sheet1）——非 mock，与 main 同 require。
//     ② 模拟 main.js export 浅拷贝 backfillRows.map(r => ({...r}))（main.js:4048）→ 断言 _matchedColumns 经浅拷贝存活（与 _bridgeDepositBizId 同路）。
//     ③ 真实 writeRefundBackfillOutput 落临时 xlsx（atomic）。
//     ④ ExcelJS 读回断言：命中列单元格 fill.fgColor.argb === 'FFFFFF00'；非命中列无黄；🔴 列偏移正确（标的是 REFUND_TEMPLATE_HEADERS[i] 对应第 i+1 列，无前导列）。
//     ⑤ 需求3.2 联动：sheet2 仅 13 列（v3.0.10 银行段 10→12）、信息列带【报错】/【提示】前缀、无 refund-only（refund 形状）行。
//
//   为什么 e2e：逐文件 review 看不见接缝（feedback_multiagent_seam_gap）；列偏移 i+1（退款 sheet1 无前导列）≠ 主报告 colIdx+2，
//     错 1 列即标错列（资金审计误导）。单测分别覆盖引擎产列 / writer 标黄，本测试钉死「引擎真实产物 → 浅拷贝 → writer」端到端列对齐。
//
// 用法：node scripts/integration/refund-backfill-yellow-fill-e2e.js

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ExcelJS = require('exceljs');

const {
  runRound5RefundOrderBackfill,
  RESULT_ERROR,
  RESULT_NOTICE
} = require('../../src/main-process/scenario-engines/r5-refund-order-backfill');
const { writeRefundBackfillOutput, UNMATCHED_HEADERS } = require('../../src/main-process/refund-backfill-writer');
const { REFUND_TEMPLATE_HEADERS, REFUND_BANK_COLUMNS } = require('../../src/constants/refund-backfill-fields');

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

const YELLOW_ARGB = 'FFFFFF00';
const cellArgb = (cell) => cell.fill && cell.fill.fgColor && cell.fill.fgColor.argb;
const isYellow = (cell) => cellArgb(cell) === YELLOW_ARGB;

// ---- 引擎输入夹具（与 r5-refund-order-backfill.test.js 同款）----
let bankSeq = 0;
function bank(overrides = {}) {
  return {
    _rowId: overrides._rowId || `b${bankSeq++}`,
    FundType: 'Ach Return',
    MerchantId: 'M1',
    Currency: 'USD',
    'Credit Amount': 0,
    'Debit Amount': 100,
    Channel: 'CH',
    '地区': 'HK',
    BillDate: '2026-06-01',
    ReconciliationId: 'RECON-1',
    ChannelOrderNo: '',
    CustomerRef: '',
    'Extra Information': '',
    'Payment Detail': '',
    'Drawee Name': '',
    'Drawee CardNo': '',
    'Payee CardNo': '',
    ...overrides
  };
}
function refund(overrides = {}) {
  return {
    '流水号': 'SN-1',
    '状态': 'SUBMITTED',
    '银行大账号': 'M1',
    '币种': 'USD',
    '退款金额': 100,
    '银行打款流水号': '',
    '附言': '',
    '付款人名称': '',
    '付款卡号': '',
    '虚拟卡号': '',
    'valueDate': '2026-06-01',
    ...overrides
  };
}
function deposit(overrides = {}) {
  return { BizId: 'bz', ReconciliationId: '', ChannelOrderNo: '', CustomerRef: '', ...overrides };
}

// 各策略一组独立唯一值（金额各异，互不串组），命中后 backfillRow 应带对应 _matchedColumns。
//   期望标黄列照搬 TECHDOC §5.2（过滤后 ∈ sheet1 列）。
const STRATEGY_CASES = [
  {
    name: 'S1',
    bank: bank({ _rowId: 's1b', MerchantId: 'A1', 'Debit Amount': 101, ChannelOrderNo: 'PAY1' }),
    refund: refund({ '流水号': 'SN-S1', '银行大账号': 'A1', '退款金额': 101, '银行打款流水号': 'PAY1' }),
    deposits: [],
    expectMarked: ['ChannelOrderNo', '银行打款流水号']
  },
  {
    name: 'JPM-HK',
    bank: bank({ _rowId: 'hkb', MerchantId: 'A2', 'Debit Amount': 102, Channel: 'JPM', '地区': 'HK', 'Payment Detail': 'T54SWIC123456' }),
    refund: refund({ '流水号': 'SN-HK', '银行大账号': 'A2', '退款金额': 102, '银行打款流水号': 'T54SWIC123456' }),
    deposits: [],
    // v3.0.10：候选 [...hkCleanFields(Extra Information,Payment Detail), 银行打款流水号] 全∈sheet1。
    expectMarked: ['Extra Information', 'Payment Detail', '银行打款流水号']
  },
  {
    name: 'JPM-US-twohop',
    bank: bank({ _rowId: 'usb', MerchantId: 'A3', 'Debit Amount': 103, Channel: 'JPM', '地区': 'US', CustomerRef: 'CR-US' }),
    refund: refund({ '流水号': 'SN-US', '银行大账号': 'A3', '退款金额': 103, '银行打款流水号': 'PN-US' }),
    deposits: [deposit({ ReconciliationId: 'PN-US', CustomerRef: 'CR-US' })],
    expectMarked: ['CustomerRef']
  },
  {
    name: 'S3',
    bank: bank({ _rowId: 's3b', MerchantId: 'A4', 'Debit Amount': 104, 'Drawee Name': '张三' }),
    refund: refund({ '流水号': 'SN-S3', '银行大账号': 'A4', '退款金额': 104, '付款人名称': '张三' }),
    deposits: [],
    // v3.0.10：候选 [Drawee Name, 付款人名称] 全∈sheet1（Drawee Name 新入银行段）。
    expectMarked: ['Drawee Name', '付款人名称']
  },
  {
    name: 'S4',
    bank: bank({ _rowId: 's4b', MerchantId: 'A5', 'Debit Amount': 105, BillDate: '2026-06-03' }),
    refund: refund({ '流水号': 'SN-S4', '银行大账号': 'A5', '退款金额': 105, 'valueDate': '2026-06-02' }),
    deposits: [],
    // v3.0.10 Change B：S4 标黄按固定文案口径展开为 8 列（bank 4 + ro 4，全∈sheet1）；
    //   Debit Amount 仅作 sheet1 银行金额展示列（实际匹配口径是 |Credit−Debit| 绝对值）。
    expectMarked: ['BillDate', 'MerchantId', 'Debit Amount', 'Currency', 'valueDate', '银行大账号', '退款金额', '币种']
  },
  {
    name: '银行打款流水号模糊匹配',
    bank: bank({ _rowId: 'fuzzyb', MerchantId: 'A6', 'Debit Amount': '116.99', ChannelOrderNo: 'PAY-FUZZY' }),
    refund: refund({ '流水号': 'SN-FUZZY', '银行大账号': 'A6', '退款金额': '107', '银行打款流水号': 'PAY-FUZZY' }),
    deposits: [],
    expectMarked: ['ChannelOrderNo', '银行打款流水号', 'Debit Amount', '退款金额', 'MerchantId', '银行大账号', 'Currency', '币种']
  }
];

async function run() {
  console.log('==== refund-backfill 命中字段标黄 跨接缝 e2e 验证 ====');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'refund-yellow-e2e-'));
  try {
    // —— 汇总各策略命中 → 一份 backfillRows（每策略独立唯一值，互不串组）——
    const allBank = STRATEGY_CASES.map((c) => c.bank);
    const allRefund = STRATEGY_CASES.map((c) => c.refund);
    const allDeposits = STRATEGY_CASES.flatMap((c) => c.deposits);
    // 外加 1 条 bank-only（不同唯一值、无 refund）→ sheet2 银行未匹配-提示行（验证需求3.2 前缀 + 13 列）。
    allBank.push(bank({ _rowId: 'bankonly', MerchantId: 'ZZ', 'Debit Amount': 999 }));

    const res = runRound5RefundOrderBackfill(allBank, allRefund, allDeposits, {
      bankPaymentSerialFuzzyMatchEnabled: true
    });

    // ① 引擎产物：每策略命中 1 行回填，且带正确 _matchedColumns。
    assertEq(res.backfillRows.length, STRATEGY_CASES.length, '①引擎产 6 条回填行（每策略 1 条）');
    for (const c of STRATEGY_CASES) {
      const row = res.backfillRows.find((r) => r['退款单号'] === c.refund['流水号']);
      assertTrue(!!row, `①策略 ${c.name} 应有回填行`);
      if (row) assertEq(row._matchedColumns, c.expectMarked, `①策略 ${c.name} _matchedColumns 正确`);
    }

    // ② 模拟 main.js export 浅拷贝（main.js:4048）→ _matchedColumns 必须存活。
    const exported = res.backfillRows.map((r) => ({ ...r }));
    for (const c of STRATEGY_CASES) {
      const row = exported.find((r) => r['退款单号'] === c.refund['流水号']);
      assertEq(row && row._matchedColumns, c.expectMarked, `②浅拷贝后 ${c.name} _matchedColumns 存活`);
    }

    // ③ 写盘。
    const savePath = path.join(tmpDir, '中台退款订单回填-e2e.xlsx');
    await writeRefundBackfillOutput(exported, res.unmatchedRows, savePath);
    assertTrue(fs.existsSync(savePath), '③回填文件落盘成功');
    assertTrue(!fs.existsSync(`${savePath}.tmp`), '③atomic：无 .tmp 半文件');

    // ④ 读回断言标黄 + 列偏移。
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(savePath);
    const sheet1 = wb.getWorksheet('回填模板');

    // 表头顺序 = REFUND_TEMPLATE_HEADERS（v3.0.10：33 列）。
    const headers = REFUND_TEMPLATE_HEADERS.map((_, i) => sheet1.getRow(1).getCell(i + 1).value);
    assertEq(headers, REFUND_TEMPLATE_HEADERS.slice(), '④sheet1 表头 33 列顺序正确');
    assertEq(REFUND_TEMPLATE_HEADERS.length, 33, '④sheet1 共 33 列（固定 6 + 银行 12 + 中台 15）');

    // 逐策略行：命中列黄、非命中列不黄、列偏移 i+1 对齐。
    for (const c of STRATEGY_CASES) {
      // 定位该策略的数据行（按退款单号匹配 A 列）。
      let dataRow = null;
      for (let r = 2; r <= exported.length + 1; r++) {
        if (sheet1.getRow(r).getCell(1).value === c.refund['流水号']) { dataRow = sheet1.getRow(r); break; }
      }
      assertTrue(!!dataRow, `④策略 ${c.name} 数据行可定位`);
      if (!dataRow) continue;
      REFUND_TEMPLATE_HEADERS.forEach((h, i) => {
        const cell = dataRow.getCell(i + 1);
        if (c.expectMarked.includes(h)) {
          assertTrue(isYellow(cell), `④策略 ${c.name} 命中列「${h}」(第${i + 1}列) 应黄 FFFFFF00`);
        } else {
          assertTrue(!isYellow(cell), `④策略 ${c.name} 非命中列「${h}」(第${i + 1}列) 不应黄`);
        }
      });
      // 列偏移钉死：命中列的 cell 值应等于源行该列值（标的就是该列，未错位到邻列）。
      for (const h of c.expectMarked) {
        const idx = REFUND_TEMPLATE_HEADERS.indexOf(h);
        const srcRow = exported.find((r) => r['退款单号'] === c.refund['流水号']);
        // 标黄不改值：第 idx+1 列值应等于源行投影值（防 +0/+2 错位把黄标到邻列）。
        assertEq(dataRow.getCell(idx + 1).value, srcRow[h] === undefined || srcRow[h] === null ? null : srcRow[h], `④策略 ${c.name} 列「${h}」标在第 ${idx + 1} 列（值对齐，无错位）`);
      }
    }

    // ⑤ 需求3.2 联动：sheet2 仅 13 列（v3.0.10 银行段 10→12）、信息列带前缀、无 refund-only 行。
    const sheet2 = wb.getWorksheet('未匹配报错');
    const s2Headers = UNMATCHED_HEADERS.map((_, i) => sheet2.getRow(1).getCell(i + 1).value);
    assertEq(UNMATCHED_HEADERS.length, 13, '⑤sheet2 表头 13 列');
    assertEq(s2Headers, UNMATCHED_HEADERS.slice(), '⑤sheet2 表头顺序正确（无结果类型/退款单号）');
    assertTrue(!UNMATCHED_HEADERS.includes('结果类型') && !UNMATCHED_HEADERS.includes('退款单号'), '⑤sheet2 无「结果类型」「退款单号」列');

    // sheet2 只承接银行未匹配行（①形状）：bankonly 行 MerchantId=ZZ，信息列带【提示】前缀。
    const merchantColIdx = UNMATCHED_HEADERS.indexOf('MerchantId') + 1;
    const infoColIdx = UNMATCHED_HEADERS.indexOf('报错/提示信息') + 1;
    let foundBankOnly = false;
    for (let r = 2; r <= res.unmatchedRows.length + 1; r++) {
      if (sheet2.getRow(r).getCell(merchantColIdx).value === 'ZZ'
          && String(sheet2.getRow(r).getCell(infoColIdx).value || '').startsWith('【提示】')) {
        foundBankOnly = true; break;
      }
    }
    assertTrue(foundBankOnly, '⑤sheet2 含 bank-only（ZZ）银行未匹配行，带【提示】前缀');

    // refund-only（refund 形状）行不应出现：引擎 unmatchedRows 里不应有「无 MerchantId 但有退款单号」的行。
    const refundShape = res.unmatchedRows.filter(
      (x) => !Object.prototype.hasOwnProperty.call(x, 'MerchantId') && Object.prototype.hasOwnProperty.call(x, '退款单号')
    );
    assertEq(refundShape.length, 0, '⑤需求3.2：无 refund-only（refund 形状）行');

    // 防御：被前缀化的信息列均以【报错】或【提示】开头。
    assertTrue(
      res.unmatchedRows.every((x) => /^【(报错|提示)】/.test(String(x['报错/提示信息'] || ''))),
      '⑤所有银行未匹配行信息列带【报错】/【提示】前缀'
    );
    // 引用 RESULT_ERROR/RESULT_NOTICE 常量（保留 结果类型 key 兼容性自检）。
    assertTrue(
      res.unmatchedRows.every((x) => x['结果类型'] === RESULT_ERROR || x['结果类型'] === RESULT_NOTICE),
      '⑤银行未匹配行仍保留 结果类型 key（兼容引擎内部/核兼容测试）'
    );
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  }

  const total = passed + failed;
  console.log(`\n==== ${passed}/${total} PASS ====`);
  if (failed > 0) {
    failures.forEach((f) => console.error(`  - ${f.label}: actual=${JSON.stringify(f.actual)} expected=${JSON.stringify(f.expected)}`));
    process.exit(1);
  }
}

run().catch((e) => { console.error('FATAL', e); process.exit(1); });
