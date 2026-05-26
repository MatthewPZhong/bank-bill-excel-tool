// 主功能 2「新开银行账户生成余额账单」集成测试
//   覆盖：monthly-balance 装配核心 + toBalanceRows 模板填充 + writers.writeBalanceWorkbook 写 xlsx + readback
//
// 主功能 2 核心数据 pipeline：
//   balance-seeds JSON → pickLatestSeedForAccount 选择 → toBalanceRows 模板字段填充 → writeBalanceWorkbook 输出 xlsx
//
// 用法：node scripts/integration/new-account-balance-statement.js

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const XLSX = require('xlsx');
const ExcelJS = require('exceljs');

const monthlyBalance = require('../../src/main-process/monthly-balance');
const writers = require('../../src/backend/file-service/writers');

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

async function run() {
  console.log('==== 新开银行账户余额账单 集成验证 ====');

  const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'new-account-bal-'));

  try {
    // ============================================================
    // Step 1: lastDayOfMonth + buildTargetLastDay 月末日期算法
    // ============================================================
    assertEq(monthlyBalance.lastDayOfMonth(2026, 1), 31, 'Step1.1 月 = 31 天');
    assertEq(monthlyBalance.lastDayOfMonth(2026, 2), 28, 'Step1.2 月 = 28 天（2026 非闰年）');
    assertEq(monthlyBalance.lastDayOfMonth(2024, 2), 29, 'Step1.闰年 2024 年 2 月 = 29 天');
    assertEq(monthlyBalance.lastDayOfMonth(2026, 4), 30, 'Step1.4 月 = 30 天');
    assertEq(monthlyBalance.lastDayOfMonth(2026, 12), 31, 'Step1.12 月 = 31 天');
    assertEq(monthlyBalance.lastDayOfMonth(2026, 13), null, 'Step1.13 月 = null（非法）');
    assertEq(monthlyBalance.lastDayOfMonth(2026, 0), null, 'Step1.0 月 = null（非法）');
    assertEq(monthlyBalance.buildTargetLastDay(2026, 3), '2026-03-31', 'Step1.buildTargetLastDay 2026-03 → 2026-03-31');
    assertEq(monthlyBalance.buildTargetLastDay(2026, 2), '2026-02-28', 'Step1.buildTargetLastDay 2026-02 → 2026-02-28（非闰年）');

    // ============================================================
    // Step 2: pad2 单位补齐
    // ============================================================
    assertEq(monthlyBalance.pad2(1), '01', 'Step2.pad2(1) = "01"');
    assertEq(monthlyBalance.pad2(12), '12', 'Step2.pad2(12) = "12"');
    assertEq(monthlyBalance.pad2(0), '00', 'Step2.pad2(0) = "00"');

    // ============================================================
    // Step 3: isRegularTemplate 普通模板判定
    // ============================================================
    assertEq(monthlyBalance.isRegularTemplate({ id: 1, name: 'T1' }), true, 'Step3.普通模板 = true');
    assertEq(monthlyBalance.isRegularTemplate({ id: 1, name: 'T1', isParent: true }), false, 'Step3.主模板 = false');
    assertEq(monthlyBalance.isRegularTemplate({ id: 2, parentTemplateId: 1 }), false, 'Step3.子模板 = false');
    assertEq(monthlyBalance.isRegularTemplate(null), false, 'Step3.null = false');

    // ============================================================
    // Step 4: pickLatestSeedForAccount 余额种子选择算法
    //   规则：精确匹配月末 > 兜底（≤月末最新）> null
    // ============================================================
    const seeds = [
      { merchantId: 'ACC-A', currency: 'CNY', billDate: '2026-03-31', endBalance: 10000 },
      { merchantId: 'ACC-A', currency: 'CNY', billDate: '2026-03-15', endBalance: 8000 },
      { merchantId: 'ACC-A', currency: 'CNY', billDate: '2026-04-01', endBalance: 12000 }, // 超月末
      { merchantId: 'ACC-B', currency: 'CNY', billDate: '2026-03-20', endBalance: 5000 },
      { merchantId: 'ACC-C', currency: 'USD', billDate: '2026-03-31', endBalance: 1000 }
    ];

    // 精确匹配
    const r1 = monthlyBalance.pickLatestSeedForAccount(seeds, 'ACC-A', 'CNY', '2026-03-31');
    assertEq(r1.reason, 'exact', 'Step4.ACC-A 精确匹配 = exact');
    assertEq(r1.chosen.endBalance, 10000, 'Step4.ACC-A 精确余额 = 10000');

    // 兜底（无精确匹配，取 ≤月末最新）
    const r2 = monthlyBalance.pickLatestSeedForAccount(seeds, 'ACC-B', 'CNY', '2026-03-31');
    assertEq(r2.reason, 'fallback', 'Step4.ACC-B 兜底 = fallback');
    assertEq(r2.chosen.endBalance, 5000, 'Step4.ACC-B 兜底余额 = 5000');

    // 超月末过滤
    const seedsOnlyFuture = [
      { merchantId: 'ACC-X', currency: 'CNY', billDate: '2026-04-15', endBalance: 9999 }
    ];
    const r3 = monthlyBalance.pickLatestSeedForAccount(seedsOnlyFuture, 'ACC-X', 'CNY', '2026-03-31');
    assertEq(r3.chosen, null, 'Step4.超月末 → chosen=null');
    assertEq(r3.reason, 'no-candidates', 'Step4.reason=no-candidates');

    // 币种不匹配
    const r4 = monthlyBalance.pickLatestSeedForAccount(seeds, 'ACC-A', 'USD', '2026-03-31');
    assertEq(r4.chosen, null, 'Step4.币种不匹配 → null');

    // 不同账号
    const r5 = monthlyBalance.pickLatestSeedForAccount(seeds, 'ACC-C', 'USD', '2026-03-31');
    assertEq(r5.chosen.endBalance, 1000, 'Step4.ACC-C USD 精确 = 1000');

    // 空 merchantId 防御
    const r6 = monthlyBalance.pickLatestSeedForAccount(seeds, '', 'CNY', '2026-03-31');
    assertEq(r6.reason, 'invalid-merchant-id', 'Step4.空 merchantId 防御');

    // ============================================================
    // Step 5: toBalanceRows 模板字段填充
    // ============================================================
    const records = [
      { bankName: '招商银行', location: '上海', merchantId: 'ACC-A', currency: 'CNY', billDate: '2026-03-31', endBalance: 10000 },
      { bankName: '工商银行', location: '北京', merchantId: 'ACC-B', currency: 'USD', billDate: '2026-03-31', endBalance: 2000 }
    ];
    const balanceFields = ['银行名称', '所在地', '银行账号', '币种', '账单日期', '期末余额'];
    const rows = monthlyBalance.toBalanceRows(records, balanceFields);
    assertEq(rows.length, 2, 'Step5.toBalanceRows 返回 2 行');
    assertEq(rows[0], ['招商银行', '上海', 'ACC-A', 'CNY', '2026-03-31', 10000], 'Step5.第 1 行字段填充正确');
    assertEq(rows[1], ['工商银行', '北京', 'ACC-B', 'USD', '2026-03-31', 2000], 'Step5.第 2 行字段填充正确');

    // 自定义字段顺序
    const customFields = ['银行账号', '期末余额', '币种'];
    const rowsCustom = monthlyBalance.toBalanceRows(records, customFields);
    assertEq(rowsCustom[0], ['ACC-A', 10000, 'CNY'], 'Step5.自定义字段顺序');

    // 未知字段填空
    const rowsUnknown = monthlyBalance.toBalanceRows(records, ['未知字段', '银行账号']);
    assertEq(rowsUnknown[0], ['', 'ACC-A'], 'Step5.未知字段返回空');

    // endBalance = null 时填空
    const recordsNullBal = [{ bankName: 'XX', merchantId: 'ACC-Z', currency: 'CNY', billDate: '2026-03-31', endBalance: null }];
    const rowsNullBal = monthlyBalance.toBalanceRows(recordsNullBal, ['期末余额']);
    assertEq(rowsNullBal[0], [''], 'Step5.endBalance null 填空');

    // ============================================================
    // Step 6: writeBalanceWorkbook 写 xlsx + readback（用 mock 模板）
    // ============================================================
    // 准备一个简易模板 xlsx（模拟 assets/余额账单模版.xlsx）
    const templateFile = path.join(tmpdir, 'balance-template.xlsx');
    const wbTemplate = XLSX.utils.book_new();
    const wsTemplate = XLSX.utils.aoa_to_sheet([
      balanceFields,  // 表头
      [], []  // 留 2 个空行（模板可能含此结构）
    ]);
    XLSX.utils.book_append_sheet(wbTemplate, wsTemplate, 'Sheet1');
    XLSX.writeFile(wbTemplate, templateFile);

    const outputFile = path.join(tmpdir, 'output-balance.xlsx');
    const formatters = {
      inferDateCellFormat: () => 'yyyy-mm-dd',
      parseDateValue: (v) => v ? new Date(v) : null,
      parseNumericValue: (v) => {
        if (v === null || v === undefined || v === '') return null;
        const n = Number(String(v).replace(/,/g, ''));
        return Number.isFinite(n) ? n : null;
      },
      toExcelSerial: (d) => {
        if (!d) return null;
        const epoch = new Date(Date.UTC(1899, 11, 30));
        return (d - epoch) / (24 * 60 * 60 * 1000);
      }
    };
    writers.writeBalanceWorkbook({
      templateFilePath: templateFile,
      records: rows,
      templateFields: balanceFields,
      outputFilePath: outputFile
    }, formatters);

    assertTrue(fs.existsSync(outputFile), 'Step6.余额账单 xlsx 输出成功');

    // readback
    const wbOut = new ExcelJS.Workbook();
    await wbOut.xlsx.readFile(outputFile);
    const sheetOut = wbOut.worksheets[0];
    assertTrue(!!sheetOut, 'Step6.sheet 存在');
    assertEq(sheetOut.getRow(1).getCell(1).value, '银行名称', 'Step6.表头 col1 = 银行名称');
    assertEq(sheetOut.getRow(1).getCell(6).value, '期末余额', 'Step6.表头 col6 = 期末余额');

    // ============================================================
    // Step 7: Module A watermark（v2.1.6）
    // ============================================================
    assertEq(wbOut.lastModifiedBy, 'pzhong', 'Step7.watermark lastModifiedBy=pzhong');
  } finally {
    try { fs.rmSync(tmpdir, { recursive: true, force: true }); } catch (_e) { /* swallow */ }
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
