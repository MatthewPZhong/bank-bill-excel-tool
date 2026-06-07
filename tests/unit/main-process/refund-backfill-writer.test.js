// v2.1.16-beta.4 ③ R5 场景4：refund-backfill-writer 单元测试（🔴 资金红线）
//
// 覆盖范围（writeRefundBackfillOutput 契约，详 src/main-process/refund-backfill-writer.js）：
//   1. 双 sheet：回填模板 + 未匹配报错
//   2. sheet1 第 1 行 = 14 列表头，顺序严格 = REFUND_TEMPLATE_HEADERS；
//      E 列 = 匹配命中详情；F 起 9 列含 Debit Amount，绝不含 Credit Amount
//   3. sheet1 数据行值按表头投影正确（含 E 列命中详情 + F~N 银行 9 字段）
//   4. sheet2 含「结果类型」列；两类值（报错-人工介入 / 未匹配-提示）都能出现
//   5. sheet2 两类异构行（①银行未匹配行 9 列 / ②refund 提示行 退款单号）都正确落列、缺 key → ''
//   6. 表头行加粗
//   7. 返回 { filePath, fileName } 正确；atomic write 不留半文件
//   8. writer 能消费引擎 runRound5RefundOrderBackfill 真实产出
//
// 读回用 ExcelJS（与 platform-cleanup-writer.test.js 范式一致）：cell 索引从 1 起；
//   ExcelJS 读回空串 cell.value 为 null。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ExcelJS = require('exceljs');

const {
  writeRefundBackfillOutput,
  BACKFILL_SHEET_NAME,
  UNMATCHED_SHEET_NAME,
  UNMATCHED_HEADERS
} = require('../../../src/main-process/refund-backfill-writer');
const {
  REFUND_TEMPLATE_HEADERS,
  REFUND_BANK_COLUMNS
} = require('../../../src/constants/refund-backfill-fields');
const {
  RESULT_ERROR,
  RESULT_NOTICE
} = require('../../../src/main-process/scenario-engines/r5-refund-order-backfill');

// ---------- Fixtures ----------

// 造一条回填模板行（含 REFUND_TEMPLATE_HEADERS 全 14 键），仿引擎 buildBackfillRow 形状
function makeBackfillRow(idx) {
  const row = {
    '退款单号': `RO_${idx}`,
    '状态': 'SUCCESS',
    '渠道流水号': `RECON_${idx}`,
    '渠道退款时间': '2026-06-01',
    '匹配命中详情': `匹配成功:"银行对账单ChannelOrderNo里的CO${idx}"匹配上了"refund order银行打款流水号的CO${idx}"`
  };
  // F~N：银行 9 字段原数据（按 REFUND_BANK_COLUMNS 顺序）
  row['BillDate'] = '2026-06-01';
  row['Channel'] = 'JPM';
  row['地区'] = 'HK';
  row['MerchantId'] = `M00${idx}`;
  row['Currency'] = 'USD';
  row['Debit Amount'] = idx * 100;
  row['ReconciliationId'] = `RECON_${idx}`;
  row['ChannelOrderNo'] = `CO${idx}`;
  row['CustomerRef'] = `REF_${idx}`;
  return row;
}

// ①银行未匹配行（含 REFUND_BANK_COLUMNS 9 列 + 结果类型 + 报错/提示信息），仿引擎 buildUnmatchedBankRow
function makeUnmatchedBankRow(idx, resultType, info) {
  const row = { '结果类型': resultType };
  row['BillDate'] = '2026-06-02';
  row['Channel'] = 'JPM';
  row['地区'] = 'US';
  row['MerchantId'] = `MX0${idx}`;
  row['Currency'] = 'EUR';
  row['Debit Amount'] = idx * 200;
  row['ReconciliationId'] = `RX_${idx}`;
  row['ChannelOrderNo'] = `CX${idx}`;
  row['CustomerRef'] = `RFX_${idx}`;
  row['报错/提示信息'] = info;
  return row;
}

// ②refund 提示行（仅 结果类型 + 退款单号 + 报错/提示信息，无银行 9 列），仿引擎收尾提示行
function makeRefundNoticeRow(idx, info) {
  return {
    '结果类型': RESULT_NOTICE,
    '退款单号': `RO_NOTICE_${idx}`,
    '报错/提示信息': info
  };
}

let tmpDir;

test.beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'refund-backfill-writer-'));
});

test.afterEach(() => {
  if (tmpDir) {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
    tmpDir = null;
  }
});

// ========================================================================
// 1) 双 sheet：回填模板 + 未匹配报错
// ========================================================================
test('① workbook 含「回填模板」+「未匹配报错」两个 sheet', async () => {
  const savePath = path.join(tmpDir, '中台退款订单回填-2026_06_01_1200.xlsx');
  await writeRefundBackfillOutput([makeBackfillRow(1)], [makeUnmatchedBankRow(1, RESULT_ERROR, 'x')], savePath);

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(savePath);
  assert.strictEqual(BACKFILL_SHEET_NAME, '回填模板');
  assert.strictEqual(UNMATCHED_SHEET_NAME, '未匹配报错');
  assert.ok(wb.getWorksheet('回填模板'), 'workbook 应含「回填模板」sheet');
  assert.ok(wb.getWorksheet('未匹配报错'), 'workbook 应含「未匹配报错」sheet');
});

// ========================================================================
// 2) sheet1 表头 14 列且顺序 = REFUND_TEMPLATE_HEADERS；
//    E 列 = 匹配命中详情；F 起 9 列含 Debit 不含 Credit
// ========================================================================
test('② sheet1 表头 14 列顺序正确；E=匹配命中详情；F 起 9 列含 Debit Amount 不含 Credit Amount', async () => {
  const savePath = path.join(tmpDir, 'h.xlsx');
  await writeRefundBackfillOutput([makeBackfillRow(1)], [], savePath);

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(savePath);
  const sheet = wb.getWorksheet('回填模板');
  const headerRow = sheet.getRow(1);

  assert.strictEqual(REFUND_TEMPLATE_HEADERS.length, 14, 'REFUND_TEMPLATE_HEADERS 应为 14 列');
  const actualHeaders = REFUND_TEMPLATE_HEADERS.map((_, i) => headerRow.getCell(i + 1).value);
  assert.deepStrictEqual(actualHeaders, REFUND_TEMPLATE_HEADERS.slice(), 'sheet1 表头顺序应严格等于 REFUND_TEMPLATE_HEADERS');

  // E 列（第 5 列）= 匹配命中详情
  assert.strictEqual(actualHeaders[4], '匹配命中详情', 'E 列应为「匹配命中详情」');

  // F 起 9 列 = REFUND_BANK_COLUMNS
  const bankCols = actualHeaders.slice(5);
  assert.strictEqual(bankCols.length, 9, 'F 起应为 9 列银行字段');
  assert.deepStrictEqual(bankCols, REFUND_BANK_COLUMNS.slice(), 'F 起 9 列应严格等于 REFUND_BANK_COLUMNS');

  // 🔴 含 Debit Amount，绝不含 Credit Amount
  assert.ok(bankCols.includes('Debit Amount'), 'F 起 9 列应含 Debit Amount');
  assert.ok(!bankCols.includes('Credit Amount'), 'F 起 9 列绝不应含 Credit Amount');
  assert.ok(!actualHeaders.includes('Credit Amount'), 'sheet1 全表头绝不应含 Credit Amount');
});

// ========================================================================
// 3) sheet1 数据行值按表头投影正确（含 E 列命中详情 + F~N 银行 9 字段）
// ========================================================================
test('③ sheet1 数据行值按表头投影正确（E 命中详情 + F~N 银行 9 字段）', async () => {
  const row1 = makeBackfillRow(1);
  const row2 = makeBackfillRow(2);
  const savePath = path.join(tmpDir, 'd.xlsx');
  await writeRefundBackfillOutput([row1, row2], [], savePath);

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(savePath);
  const sheet = wb.getWorksheet('回填模板');

  [row1, row2].forEach((srcRow, rowIdx) => {
    const dataRow = sheet.getRow(rowIdx + 2);
    REFUND_TEMPLATE_HEADERS.forEach((h, colIdx) => {
      assert.strictEqual(
        dataRow.getCell(colIdx + 1).value,
        srcRow[h],
        `第 ${rowIdx + 2} 行 列「${h}」值应为 ${srcRow[h]}`
      );
    });
  });

  // 显式断言 E 列命中详情 + Debit Amount 列
  assert.strictEqual(sheet.getRow(2).getCell(5).value, row1['匹配命中详情'], 'E 列应为命中详情');
  const debitColIdx = REFUND_TEMPLATE_HEADERS.indexOf('Debit Amount');
  assert.strictEqual(sheet.getRow(2).getCell(debitColIdx + 1).value, row1['Debit Amount'], 'Debit Amount 列值应正确');
});

// ========================================================================
// 4) sheet2 含「结果类型」列；两类值都能出现
// ========================================================================
test('④ sheet2 含「结果类型」列，且 报错-人工介入 / 未匹配-提示 两类值都能出现', async () => {
  const unmatched = [
    makeUnmatchedBankRow(1, RESULT_ERROR, '关联到 2 条退款订单，无法消歧，请人工介入'),
    makeUnmatchedBankRow(2, RESULT_NOTICE, '未能关联到任何退款订单'),
    makeRefundNoticeRow(3, '该退款订单未关联到银行对账单数据，不更新并提示')
  ];
  const savePath = path.join(tmpDir, 'u.xlsx');
  await writeRefundBackfillOutput([], unmatched, savePath);

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(savePath);
  const sheet = wb.getWorksheet('未匹配报错');

  // 表头含「结果类型」（第 1 列）
  assert.strictEqual(sheet.getRow(1).getCell(1).value, '结果类型', 'sheet2 第 1 列应为「结果类型」');
  assert.strictEqual(UNMATCHED_HEADERS[0], '结果类型');

  // 收集「结果类型」列所有数据行值
  const resultTypeColIdx = UNMATCHED_HEADERS.indexOf('结果类型') + 1;
  const seen = new Set();
  for (let r = 2; r <= unmatched.length + 1; r++) {
    seen.add(sheet.getRow(r).getCell(resultTypeColIdx).value);
  }
  assert.ok(seen.has(RESULT_ERROR), `sheet2 应出现「${RESULT_ERROR}」`);
  assert.ok(seen.has(RESULT_NOTICE), `sheet2 应出现「${RESULT_NOTICE}」`);
});

// ========================================================================
// 5) sheet2 两类异构行都正确落列（①银行 9 列 / ②refund 退款单号），缺 key → ''
// ========================================================================
test('⑤ sheet2 两类异构行都正确落列；缺 key 投影为空', async () => {
  const bankRow = makeUnmatchedBankRow(1, RESULT_ERROR, '关联到 2 条退款订单，无法消歧，请人工介入');
  const noticeRow = makeRefundNoticeRow(9, '该退款订单未关联到银行对账单数据，不更新并提示');
  const savePath = path.join(tmpDir, 'h2.xlsx');
  await writeRefundBackfillOutput([], [bankRow, noticeRow], savePath);

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(savePath);
  const sheet = wb.getWorksheet('未匹配报错');

  const colIdx = (h) => UNMATCHED_HEADERS.indexOf(h) + 1;
  const cellVal = (r, h) => sheet.getRow(r).getCell(colIdx(h)).value;
  const isEmpty = (v) => v === null || v === '';

  // —— ①银行未匹配行（第 2 行）：结果类型 + 9 列银行字段 + 报错/提示信息 全落；「退款单号」缺 → '' ——
  assert.strictEqual(cellVal(2, '结果类型'), RESULT_ERROR);
  REFUND_BANK_COLUMNS.forEach((c) => {
    assert.strictEqual(cellVal(2, c), bankRow[c], `①行 银行列「${c}」应正确落列`);
  });
  assert.strictEqual(cellVal(2, '报错/提示信息'), bankRow['报错/提示信息']);
  assert.ok(isEmpty(cellVal(2, '退款单号')), '①银行行 无「退款单号」key → 应投影为空');

  // —— ②refund 提示行（第 3 行）：结果类型 + 退款单号 + 报错/提示信息 全落；9 列银行字段缺 → '' ——
  assert.strictEqual(cellVal(3, '结果类型'), RESULT_NOTICE);
  assert.strictEqual(cellVal(3, '退款单号'), noticeRow['退款单号'], '②refund 行「退款单号」应正确落列');
  assert.strictEqual(cellVal(3, '报错/提示信息'), noticeRow['报错/提示信息']);
  REFUND_BANK_COLUMNS.forEach((c) => {
    assert.ok(isEmpty(cellVal(3, c)), `②refund 行 无银行列「${c}」key → 应投影为空`);
  });
});

// ========================================================================
// 6) 表头行加粗（两个 sheet）
// ========================================================================
test('⑥ 两个 sheet 表头行均加粗', async () => {
  const savePath = path.join(tmpDir, 'bold.xlsx');
  await writeRefundBackfillOutput([makeBackfillRow(1)], [makeUnmatchedBankRow(1, RESULT_ERROR, 'x')], savePath);

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(savePath);
  ['回填模板', '未匹配报错'].forEach((name) => {
    const sheet = wb.getWorksheet(name);
    assert.ok(sheet.getRow(1).font && sheet.getRow(1).font.bold === true, `${name} 表头应加粗`);
  });
});

// ========================================================================
// 7) 返回 { filePath, fileName } 正确；atomic write 不留半文件
// ========================================================================
test('⑦ 返回 { filePath, fileName } 正确，且 atomic 不留 .tmp 半文件', async () => {
  const fileName = '中台退款订单回填-2026_06_01_1200.xlsx';
  const savePath = path.join(tmpDir, fileName);
  const result = await writeRefundBackfillOutput([makeBackfillRow(1)], [makeUnmatchedBankRow(1, RESULT_ERROR, 'x')], savePath);

  assert.strictEqual(result.filePath, savePath);
  assert.strictEqual(result.fileName, fileName);
  assert.ok(fs.existsSync(savePath), '最终文件应存在');
  assert.ok(!fs.existsSync(`${savePath}.tmp`), 'tmp 文件应已被 rename 清理');
});

// ========================================================================
// 8) writer 能消费引擎 runRound5RefundOrderBackfill 真实产出（端到端形状对齐）
// ========================================================================
test('⑧ writer 能消费引擎真实产出（backfillRows + unmatchedRows 异构）', async () => {
  const {
    runRound5RefundOrderBackfill
  } = require('../../../src/main-process/scenario-engines/r5-refund-order-backfill');

  // 造一组：1 条 bank 命中 1 条 refund（S1 渠道流水号）→ backfill；
  //          外加 1 条 refund 关联不到 → notice（②形状收尾提示行）
  const bankRows = [
    {
      _rowId: 'row_0',
      FundType: 'Ach Return',
      MerchantId: 'ACC1', Currency: 'USD',
      'Credit Amount': '', 'Debit Amount': 100,
      ChannelOrderNo: 'PAY123', CustomerRef: '',
      ReconciliationId: 'RECONX', BillDate: '2026-06-01',
      Channel: '', '地区': '', 'Extra Information': '', 'Payment Detail': '',
      'Drawee Name': '', 'Drawee CardNo': '', 'Payee CardNo': ''
    }
  ];
  const refundOrderRows = [
    {
      _rowId: 'ro_0', '状态': 'SUBMITTED',
      '银行大账号': 'ACC1', '币种': 'USD', '退款金额': 100,
      '银行打款流水号': 'PAY123', '流水号': 'SERIAL_MATCH'
    },
    {
      // 同唯一值但无法命中任何 bank（bank 只有 1 条且已被消费）→ 收尾提示 notice 行
      _rowId: 'ro_1', '状态': 'SUBMITTED',
      '银行大账号': 'ACC1', '币种': 'USD', '退款金额': 100,
      '银行打款流水号': 'NOHIT', '流水号': 'SERIAL_NOHIT'
    }
  ];

  const { backfillRows, unmatchedRows } = runRound5RefundOrderBackfill(bankRows, refundOrderRows, []);
  assert.ok(backfillRows.length >= 1, '应至少产出 1 条回填行');
  assert.ok(unmatchedRows.length >= 1, '应至少产出 1 条未匹配/提示行');

  const savePath = path.join(tmpDir, 'engine.xlsx');
  const result = await writeRefundBackfillOutput(backfillRows, unmatchedRows, savePath);
  assert.ok(fs.existsSync(result.filePath), '引擎产出应成功写出文件');

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(savePath);
  const s1 = wb.getWorksheet('回填模板');
  const s2 = wb.getWorksheet('未匹配报错');

  // sheet1 第 1 条回填行：退款单号 = SERIAL_MATCH、状态 = SUCCESS、E 命中详情非空
  assert.strictEqual(s1.getRow(2).getCell(1).value, 'SERIAL_MATCH', 'sheet1 退款单号应为命中 refund 流水号');
  assert.strictEqual(s1.getRow(2).getCell(2).value, 'SUCCESS', 'sheet1 状态应回填 SUCCESS');
  assert.ok(s1.getRow(2).getCell(5).value, 'sheet1 E 列命中详情应非空');

  // sheet2 收尾提示行（②形状）：结果类型 = 未匹配-提示、退款单号 = SERIAL_NOHIT
  const resultTypeColIdx = UNMATCHED_HEADERS.indexOf('结果类型') + 1;
  const refundNoColIdx = UNMATCHED_HEADERS.indexOf('退款单号') + 1;
  let foundNotice = false;
  for (let r = 2; r <= unmatchedRows.length + 1; r++) {
    if (s2.getRow(r).getCell(resultTypeColIdx).value === RESULT_NOTICE
        && s2.getRow(r).getCell(refundNoColIdx).value === 'SERIAL_NOHIT') {
      foundNotice = true;
      break;
    }
  }
  assert.ok(foundNotice, 'sheet2 应含 SERIAL_NOHIT 的未匹配-提示行（②refund 异构形状）');
});
