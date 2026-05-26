// v2.1.8 「生成网银账单」核心 pipeline e2e 集成验证脚本
//   目标：填补主功能 1（生成网银账单）的自动化回归 — smoke 不直接覆盖此模块
//   覆盖：reader 读 xlsx → normalizers 金额/余额清洗 → writer 写 xlsx → readback 数据完整性
//
// 主功能 1 的核心数据 pipeline 都在底层 backend/file-service 模块；UI / IPC / DI 工厂层
// 由 GUI 手测覆盖。本脚本验证「数据通过 pipeline 不会变形」这一最重要的回归契约。
//
// 用法：node scripts/test-v2.1.8-statement-pipeline.js

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const XLSX = require('xlsx');
const ExcelJS = require('exceljs');

const readers = require('../../src/backend/file-service/readers');
const writers = require('../../src/backend/file-service/writers');
const normalizers = require('../../src/backend/file-service/normalizers');
const common = require('../../src/backend/file-service/common');

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
function assertClose(actual, expected, tol, label) {
  const diff = Math.abs(Number(actual) - Number(expected));
  if (diff < tol) { passed++; return; }
  failed++; failures.push({ label, actual, expected: `≈${expected} ±${tol}` });
}

function setupTmpdir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stmt-pipeline-'));
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

// 写一份模拟银行流水 xlsx（含表头 + 7 行数据：3 借 / 3 贷 / 1 双 0 应被过滤）
function writeMockBankStatement(filePath) {
  const wb = XLSX.utils.book_new();
  const data = [
    // 表头
    ['日期', '摘要', '借方金额', '贷方金额', '余额'],
    // 数据
    ['2026-04-01', '收入A', '', '1000.00', '11000.00'],
    ['2026-04-02', '支出B', '500.50', '', '10499.50'],
    ['2026-04-03', '收入C', '', '250.75', '10750.25'],
    ['2026-04-04', '支出D', '1200.30', '', '9549.95'],
    ['2026-04-05', '收入E', '', '500', '10049.95'],
    ['2026-04-06', '空行（应被过滤）', '', '', '10049.95'],
    ['2026-04-07', '高精度金额', '0.005', '', '10049.945']
  ];
  const ws = XLSX.utils.aoa_to_sheet(data);
  XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
  XLSX.writeFile(wb, filePath);
}

async function run() {
  console.log('==== v2.1.8 生成网银账单 pipeline e2e 集成验证 ====');

  const { dir, cleanup } = setupTmpdir();

  try {
    // ============================================================
    // Step 1: 准备 mock 输入 xlsx
    // ============================================================
    const inputFile = path.join(dir, 'mock-bank-statement.xlsx');
    writeMockBankStatement(inputFile);
    assertTrue(fs.existsSync(inputFile), 'Step1.mock xlsx 创建成功');

    // ============================================================
    // Step 2: reader.readRows 读取
    // ============================================================
    const rows = readers.readRows(inputFile);
    assertEq(rows.length, 8, 'Step2.readRows 返回 8 行（1 表头 + 7 数据）');
    assertEq(rows[0][0], '日期', 'Step2.第 1 行第 1 列 = 日期');
    assertEq(rows[0].length, 5, 'Step2.列数 = 5');
    assertEq(rows[1][0], '2026-04-01', 'Step2.第 1 数据行日期');

    // ============================================================
    // Step 3: extractHeaders
    // ============================================================
    const headers = readers.extractHeaders(inputFile);
    assertEq(headers, ['日期', '摘要', '借方金额', '贷方金额', '余额'], 'Step3.extractHeaders 返回 5 列');

    // ============================================================
    // Step 4: normalizers.sanitizeAmountValue 清洗（返回字符串）
    // ============================================================
    assertEq(normalizers.sanitizeAmountValue('1000.00'), '1000.00', 'Step4.sanitizeAmountValue 字符串数字 → 字符串保留');
    assertEq(normalizers.sanitizeAmountValue('1,000.00'), '1000.00', 'Step4.sanitizeAmountValue 千分位 → 去逗号');
    assertEq(normalizers.sanitizeAmountValue(''), '', 'Step4.sanitizeAmountValue 空 → 空字符串');
    assertEq(normalizers.sanitizeAmountValue(null), '', 'Step4.sanitizeAmountValue null → 空字符串');
    assertEq(normalizers.sanitizeAmountValue(1000), '1000', 'Step4.sanitizeAmountValue 数字 1000 → "1000"');
    assertEq(normalizers.sanitizeAmountValue(0.005), '0.005', 'Step4.sanitizeAmountValue 高精度 0.005 → "0.005"');

    // ============================================================
    // Step 5: normalizers.hasEffectiveAmount 行过滤判断
    // ============================================================
    assertEq(normalizers.hasEffectiveAmount(''), false, 'Step5.hasEffectiveAmount 空 = false');
    assertEq(normalizers.hasEffectiveAmount(0), false, 'Step5.hasEffectiveAmount 0 = false');
    assertEq(normalizers.hasEffectiveAmount('0'), false, 'Step5.hasEffectiveAmount "0" = false');
    assertEq(normalizers.hasEffectiveAmount('1000'), true, 'Step5.hasEffectiveAmount "1000" = true');
    assertEq(normalizers.hasEffectiveAmount(-500), true, 'Step5.hasEffectiveAmount -500 = true');

    // 双 0/空行应被过滤（"空行（应被过滤）"行）
    const blankRow = rows[6]; // index 6 = 第 6 数据行（"空行"）
    assertEq(blankRow[2], '', 'Step5.空行借方 = 空');
    assertEq(blankRow[3], '', 'Step5.空行贷方 = 空');
    assertEq(normalizers.hasEffectiveAmount(blankRow[2]) || normalizers.hasEffectiveAmount(blankRow[3]), false,
      'Step5.空行（借 + 贷 都空）→ 应过滤');

    // ============================================================
    // Step 6: normalizers.roundAmount 舍入（toFixed(2) 浮点舍入）
    // ============================================================
    assertEq(normalizers.roundAmount(1000.123), 1000.12, 'Step6.roundAmount 1000.123 → 1000.12');
    assertEq(normalizers.roundAmount(1000.126), 1000.13, 'Step6.roundAmount 1000.126 → 1000.13');
    assertEq(normalizers.roundAmount(-500.5), -500.5, 'Step6.roundAmount -500.5 保持');
    assertEq(normalizers.roundAmount(0), 0, 'Step6.roundAmount 0 → 0');

    // ============================================================
    // Step 7: normalizers.calculateEndingBalanceFromAmounts 余额计算
    //   API: entries 含 creditAmount / debitAmount 字段（非 credit / debit）
    //   公式：previousEndBalance + Σcredit - Σdebit
    // ============================================================
    const entries = [
      { creditAmount: 1000, debitAmount: 0 },
      { creditAmount: 0, debitAmount: 500.5 },
      { creditAmount: 250.75, debitAmount: 0 },
      { creditAmount: 0, debitAmount: 1200.3 },
      { creditAmount: 500, debitAmount: 0 },
      { creditAmount: 0, debitAmount: 0.005 }
    ];
    const endBalance = normalizers.calculateEndingBalanceFromAmounts({
      previousEndBalance: 10000,
      entries
    });
    // 10000 + 1000 - 500.5 + 250.75 - 1200.3 + 500 - 0.005 = 10049.945
    assertClose(endBalance, 10049.945, 0.01, 'Step7.calculateEndingBalanceFromAmounts 6 entries');

    // ============================================================
    // Step 8: writers.writeWorkbookRows 写入 + readback 验证
    // ============================================================
    const outputFile = path.join(dir, 'output.xlsx');
    const mappedRows = [
      ['Date', 'Description', 'Debit Amount', 'Credit Amount', 'Balance'],
      ['2026-04-01', '收入A', '', 1000, 11000],
      ['2026-04-02', '支出B', 500.5, '', 10499.5],
      ['2026-04-03', '收入C', '', 250.75, 10750.25]
    ];
    // formatters：注入 normalizer + 日期 helper（与 main.js IPC handler 注入一致）
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
    writers.writeWorkbookRows({
      rows: mappedRows,
      outputFilePath: outputFile,
      sheetName: 'COMMON'
    }, formatters);

    assertTrue(fs.existsSync(outputFile), 'Step8.writer 输出文件存在');

    // readback
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(outputFile);
    const sheet = wb.getWorksheet('COMMON');
    assertTrue(!!sheet, 'Step8.sheet COMMON 存在');
    assertEq(sheet.rowCount, 4, 'Step8.行数 = 4（1 表头 + 3 数据）');
    assertEq(sheet.columnCount, 5, 'Step8.列数 = 5');
    assertEq(sheet.getRow(1).getCell(1).value, 'Date', 'Step8.表头 1 = Date');
    assertEq(sheet.getRow(2).getCell(4).value, 1000, 'Step8.数据 row2 col4 Credit Amount = 1000');
    assertEq(sheet.getRow(3).getCell(3).value, 500.5, 'Step8.数据 row3 col3 Debit Amount = 500.5');
    assertEq(sheet.getRow(4).getCell(5).value, 10750.25, 'Step8.数据 row4 col5 Balance = 10750.25');

    // ============================================================
    // Step 9: Module A watermark（v2.1.6 加的 author/copyright/publisherName）
    // ============================================================
    assertEq(wb.lastModifiedBy, 'pzhong', 'Step9.watermark lastModifiedBy=pzhong');

    // ============================================================
    // Step 10: FileValidationError 错误类（v2.1.3 核心错误类型）
    //   API: new FileValidationError(code, message, { detailLines, context })
    // ============================================================
    const err = new common.FileValidationError('TEST_CODE', '测试错误', {
      detailLines: ['detail 1', 'detail 2'],
      context: { foo: 'bar' }
    });
    assertTrue(err instanceof common.FileValidationError, 'Step10.FileValidationError instanceof');
    assertEq(err.code, 'TEST_CODE', 'Step10.error.code');
    assertEq(err.message, '测试错误', 'Step10.error.message');
    assertEq(err.detailLines, ['detail 1', 'detail 2'], 'Step10.error.detailLines');
    assertEq(err.context, { foo: 'bar' }, 'Step10.error.context');

    // ============================================================
    // Step 11: 货币别名解析（normalizers.resolveCurrencyValue）
    //   API: 返回 { value, issue } 对象；纯英文输入不查 mapping 直接 echo
    //   mapping 项含 { aliases: [], englishCode: '...' }
    // ============================================================
    const currencyMappings = [
      { aliases: ['人民币', '人民幣', '元', 'RMB'], englishCode: 'CNY' },
      { aliases: ['美元', 'US Dollar', '美金'], englishCode: 'USD' },
      { aliases: ['欧元', '欧罗'], englishCode: 'EUR' }
    ];
    // 中文输入 → 查 mapping → 返回 englishCode
    const r1 = normalizers.resolveCurrencyValue('人民币', currencyMappings);
    assertEq(r1.value, 'CNY', 'Step11.人民币 → value=CNY');
    assertEq(r1.issue, null, 'Step11.人民币 issue=null');
    const r2 = normalizers.resolveCurrencyValue('美元', currencyMappings);
    assertEq(r2.value, 'USD', 'Step11.美元 → value=USD');
    // 纯英文输入（含空格 / 连字符）直接 echo
    const r3 = normalizers.resolveCurrencyValue('US Dollar', currencyMappings);
    assertEq(r3.value, 'US Dollar', 'Step11.纯英文「US Dollar」原样返回');
    const r4 = normalizers.resolveCurrencyValue('EUR', currencyMappings);
    assertEq(r4.value, 'EUR', 'Step11.纯英文「EUR」原样返回');
    // 空值
    const r5 = normalizers.resolveCurrencyValue('', currencyMappings);
    assertEq(r5.value, '', 'Step11.空字符串 → 空');
  } finally {
    cleanup();
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
