// 前置资金对账「21 列不平结果 → Excel → C4」集成测试
//   覆盖：真实模板、第 6 列 FundType、空结果表头、C4 19 列投影及基础 sheet 契约。
//
// 用法：node scripts/integration/pre-fund-reconciliation-output-contract.js

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ExcelJS = require('exceljs');

const {
  UNBALANCED_HEADERS,
  mapUnbalancedRow,
  mapChannelBillRow
} = require('../../src/main-process/pre-fund-reconciliation/output-mapper');
const {
  SHEET_NAMES,
  writeChannelWorkbook
} = require('../../src/main-process/pre-fund-reconciliation/excel-writer');
const {
  readReconIdFixFile
} = require('../../src/main-process/recon-id-fix-io');
const {
  RECON_RESULT_FIELDS_GATEWAY
} = require('../../src/constants/gateway-bill-recon-fields');

let passed = 0;
let failed = 0;
const failures = [];

function assertTrue(condition, label, detail = '') {
  if (condition) {
    passed += 1;
    return;
  }
  failed += 1;
  failures.push({ label, detail });
}

function assertEq(actual, expected, label) {
  assertTrue(Object.is(actual, expected), label, `expected=${expected} actual=${actual}`);
}

function rowValues(worksheet, rowNumber, width) {
  const values = [];
  for (let index = 1; index <= width; index += 1) {
    values.push(worksheet.getRow(rowNumber).getCell(index).value ?? '');
  }
  return values;
}

async function run() {
  const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'pre-fund-output-contract-'));
  const templatePath = path.resolve(__dirname, '../../assets/资金对账导出不平.xlsx');
  console.log('==== 前置资金对账 21 列输出契约集成验证 ====');
  try {
    const bankRow = {
      rawRow: {
        BillDate: '2026-07-24',
        ValueDate: '2026-07-25',
        Channel: 'CITI',
        MerchantId: 'M-001',
        ReconciliationId: 'R-001',
        ChannelOrderNo: 'CO-001',
        Currency: 'USD',
        FundType: 'Ach Return',
        'Extra Fee': '-1.25',
        '清算网络': 'SWIFT'
      },
      transactionType: 'DEBIT',
      reconciliationId: 'R-001',
      amount: '98.75',
      originBillId: 'bank.xlsx#2',
      name: 'Alice',
      cardNo: 'CARD-001'
    };
    const unbalanced = mapUnbalancedRow(bankRow);
    const channelBill = mapChannelBillRow(bankRow);
    const result = await writeChannelWorkbook({
      templatePath,
      outputDirectory: tmpdir,
      channel: 'CITI',
      exportDate: new Date(2026, 6, 25),
      unbalancedRows: [unbalanced],
      balancedRows: [],
      channelBillRows: [channelBill]
    });

    assertTrue(fs.existsSync(result.filePath), '输出文件已发布');
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(result.filePath);
    assertEq(workbook.worksheets.length, 5, '无重复时固定 5 sheet');
    assertTrue(
      workbook.worksheets.every((worksheet, index) => worksheet.name === SHEET_NAMES[index]),
      '5 sheet 名称与顺序固定'
    );
    const unbalancedSheet = workbook.getWorksheet('不平结果');
    assertEq(unbalancedSheet.getRow(1).cellCount, 21, '不平结果表头为 21 列');
    assertTrue(
      rowValues(unbalancedSheet, 1, 21).every((value, index) => value === UNBALANCED_HEADERS[index]),
      '不平结果表头顺序与代码契约一致'
    );
    assertEq(unbalancedSheet.getCell('F2').value, 'Ach Return', '第 6 列写入银行原始 FundType');
    assertEq(unbalancedSheet.getCell('G2').value, '不平账', '原对账结果列右移至第 7 列');
    assertEq(workbook.getWorksheet('渠道账单').getCell('J2').value, '-1.25', '渠道账单手续费列未受影响');

    const c4 = readReconIdFixFile(result.filePath, 'gateway');
    assertEq(c4.sheets.reconResult.length, 1, 'C4 读取 1 行不平结果');
    assertTrue(
      Object.keys(c4.sheets.reconResult[0]).every(
        (field, index) => field === RECON_RESULT_FIELDS_GATEWAY[index]
      ),
      'C4 投影保持既有 19 列字段顺序'
    );
    assertEq(c4.sheets.reconResult[0]['账单日期'], '2026-07-25', 'C4 投影字段未因插列偏移');
    assertEq(Object.hasOwn(c4.sheets.reconResult[0], 'FundType'), false, 'C4 不透传 FundType');
    assertEq(Object.hasOwn(c4.sheets.reconResult[0], '对账数据来源'), false, 'C4 不透传来源列');

    const zeroResult = await writeChannelWorkbook({
      templatePath,
      outputDirectory: tmpdir,
      channel: 'ZERO',
      exportDate: new Date(2026, 6, 25),
      unbalancedRows: [],
      balancedRows: [],
      channelBillRows: []
    });
    const zeroWorkbook = new ExcelJS.Workbook();
    await zeroWorkbook.xlsx.readFile(zeroResult.filePath);
    assertEq(zeroWorkbook.getWorksheet('不平结果').rowCount, 1, '零不平仅保留表头');
    assertEq(zeroWorkbook.getWorksheet('不平结果').getRow(1).cellCount, 21, '零不平仍保持 21 列');
  } catch (error) {
    failed += 1;
    failures.push({ label: '集成流程未抛错', detail: error && error.stack ? error.stack : String(error) });
  } finally {
    fs.rmSync(tmpdir, { recursive: true, force: true });
  }

  const total = passed + failed;
  console.log(`\n==== ${passed}/${total} PASS ====`);
  if (failed > 0) {
    console.error('FAILURES:');
    for (const failure of failures) {
      console.error(`  - ${failure.label}${failure.detail ? `: ${failure.detail}` : ''}`);
    }
    process.exit(1);
  }
}

run().catch((error) => {
  console.error('FATAL', error);
  process.exit(1);
});
